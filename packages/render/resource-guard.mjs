/**
 * 资源压力闸（P52 · B-SUB2-R26-026）
 *
 * ## 为什么要有它
 *
 * 浏览器名额管的是「同时几个 Chromium」，管不了「这台机器还剩多少内存」。一条 4K 导出
 * 的进程树实测能到 GB 级（取帧阶段 Chromium 是主要开销），如果此时再放一个新作业进来，
 * 结果不是排队，而是整机换页——两条作业一起变慢，最后都超时。
 *
 * 这里给 `render.start` 一道**准入**：开工前测一次占用，超过阈值就**等**（有上限），
 * 等不到就明确拒绝（`RESOURCE_PRESSURE`），而不是硬塞进去再无声变慢。
 *
 * ## 阈值从哪来
 *
 * 默认 `os.totalmem() * 0.6`：留 40% 给系统、Studio、测试进程与文件缓存。60% 不是拍的——
 * 本机 4K 导出实测进程树峰值 1.38–2.34GB（R30 记账）、三线并行时整机峰值约 1.9GB；
 * 本机 16GB → 闸门在 9.6GB，是「异常时才拦」的兜底，不参与日常调度。
 *
 * 需要更严的口径时用环境变量覆盖（验收/低配机）：
 * - `OPENCUT_RENDER_MEM_LIMIT_BYTES`：直接给字节数（最高优先）
 * - `OPENCUT_RENDER_DEFER_MS`：等多久（默认 30000）
 * - `OPENCUT_RENDER_PRESSURE_POLL_MS`：轮询间隔（默认 1000）
 *
 * ## 不许静默
 *
 * 每一次判定都落一条记录 `<registryDir>/pressure/<jobId>.json`：
 * `{jobId, at, action: 'admitted' | 'deferred' | 'rejected', measuredBytes, limitBytes,
 *   limitSource, waitedMs, samples}`。采样读不到时写 `measuredBytes: null` +
 * `available: false`，**不用 0 冒充**，并且照常放行（读不到进程表不等于机器满了）。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 默认阈值：机器内存的 60%。 */
export const PRESSURE_RATIO = 0.6;
/** 默认最多等多久（毫秒）。 */
export const DEFAULT_DEFER_MS = 30_000;
/** 默认轮询间隔（毫秒）。 */
export const DEFAULT_POLL_MS = 1000;

/**
 * 阈值（字节）+ 它的来源。`source` 会原样进记录，便于复核"这个数字哪来的"。
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ bytes: number, source: string, totalBytes: number }}
 */
export function memoryLimit(env = process.env) {
  const explicit = Number(env.OPENCUT_RENDER_MEM_LIMIT_BYTES);
  const totalBytes = os.totalmem();
  if (Number.isFinite(explicit) && explicit > 0) {
    return { bytes: Math.round(explicit), source: 'env:OPENCUT_RENDER_MEM_LIMIT_BYTES', totalBytes };
  }
  return {
    bytes: Math.round(totalBytes * PRESSURE_RATIO),
    source: `os.totalmem()*${PRESSURE_RATIO}`,
    totalBytes,
  };
}

/**
 * 纯函数：这次算不算压力。`measured === null` → 读不到，不算压力（有记录，可追溯）。
 * @param {number | null} measuredBytes
 * @param {number} limitBytes
 * @returns {{ level: 'ok' | 'pressure' | 'unknown', ratio: number }}
 */
export function pressureOf(measuredBytes, limitBytes) {
  if (!Number.isFinite(measuredBytes) || measuredBytes === null || Number(measuredBytes) < 0) {
    return { level: 'unknown', ratio: 0 };
  }
  const measured = Number(measuredBytes);
  const limit = Number(limitBytes) > 0 ? Number(limitBytes) : 1;
  return { level: measured > limit ? 'pressure' : 'ok', ratio: Math.round((measured / limit) * 1000) / 1000 };
}

/**
 * 默认的占用估计：**本进程 RSS + 注册表里活着的作业自报的峰值 RSS**。
 *
 * 为什么用"自报峰值"而不是实时读对方的 RSS：本机 `ps` 被系统策略拒绝，产品侧不能拉
 * libproc/python 去读别人的常驻内存；而每个 worker 都会把 `process.resourceUsage().maxRSS`
 * 写进 job.json（`peakRssKB`），这是**作业自己**报的数，跨进程可读、不需要任何权限。
 * 它是上界（峰值 ≥ 当前值），用来做准入判断偏保守——正是我们想要的。
 *
 * 调用方（验收脚本站 / Studio）可以注入更准的采样器（`ctx.sampleFootprint`），
 * 例如 `scripts/lib/proc-sampler.mjs` 的整棵进程树 + 全部 Chromium。
 *
 * @param {string} registryDir
 * @returns {Promise<number>}
 */
export async function defaultFootprint(registryDir) {
  let bytes = Number(process.memoryUsage.rss()) || 0;
  /** @type {string[]} */
  let names = [];
  try {
    names = await fs.readdir(registryDir);
  } catch {
    return bytes;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    /** @type {any} */
    let entry = null;
    try {
      entry = JSON.parse(await fs.readFile(path.join(registryDir, name), 'utf8'));
    } catch {
      continue;
    }
    const dir = typeof entry?.dir === 'string' ? entry.dir : null;
    if (!dir) continue;
    /** @type {any} */
    let job = null;
    try {
      job = JSON.parse(await fs.readFile(path.join(dir, 'job.json'), 'utf8'));
    } catch {
      continue;
    }
    if (job?.state !== 'running' && job?.state !== 'waiting') continue;
    const peakKb = Number(job?.peakRssKB);
    if (Number.isFinite(peakKb) && peakKb > 0) bytes += peakKb * 1024;
  }
  return bytes;
}

/**
 * 写一条判定记录（每次 start 一行）。失败不影响主流程——记录是证据，不是功能。
 * @param {string} registryDir
 * @param {string} jobId
 * @param {any} record
 */
async function writeRecord(registryDir, jobId, record) {
  const dir = path.join(registryDir, 'pressure');
  const file = path.join(dir, `${jobId.replace(/[^\w.-]/g, '_')}.json`);
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8').catch(() => {});
  return file;
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 准入判定：压力大就等，等不到就拒绝。
 *
 * @param {{
 *   jobId: string,
 *   registryDir: string,
 *   sample: () => Promise<number | null>,
 *   env?: Record<string, string | undefined>,
 *   now?: () => number,
 * }} opts
 * @returns {Promise<{ action: 'admitted' | 'rejected', measuredBytes: number | null, limitBytes: number,
 *   limitSource: string, waitedMs: number, samples: number, recordPath: string | null, attempts: any[] }>}
 */
export async function admitUnderPressure(opts) {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const { bytes: limitBytes, source: limitSource } = memoryLimit(env);
  const deferMs = Math.max(0, Number(env.OPENCUT_RENDER_DEFER_MS ?? DEFAULT_DEFER_MS) || 0);
  const pollMs = Math.max(50, Number(env.OPENCUT_RENDER_PRESSURE_POLL_MS ?? DEFAULT_POLL_MS) || DEFAULT_POLL_MS);

  const startedAt = now();
  let samples = 0;
  let measured = null;
  let lastRatio = 0;
  let recordPath = null;
  /** 每次判定都留在记录里：等了几轮、每轮实测多少，事后能复盘"为什么推迟"。 */
  /** @type {any[]} */
  const attempts = [];

  for (;;) {
    samples += 1;
    measured = await opts.sample().catch(() => null);
    const verdict = pressureOf(measured, limitBytes);
    lastRatio = verdict.ratio;
    const action = verdict.level === 'pressure' ? (now() - startedAt >= deferMs ? 'rejected' : 'deferred') : 'admitted';
    attempts.push({
      at: new Date(now()).toISOString(),
      action,
      measuredBytes: measured,
      measuredMb: Number.isFinite(measured) ? Math.round(Number(measured) / 1024 / 1024) : null,
      ratio: lastRatio,
      waitedMs: now() - startedAt,
      available: verdict.level !== 'unknown',
    });
    recordPath = await writeRecord(opts.registryDir, opts.jobId, {
      jobId: opts.jobId,
      at: new Date(now()).toISOString(),
      action,
      measuredBytes: measured,
      measuredMb: Number.isFinite(measured) ? Math.round(Number(measured) / 1024 / 1024) : null,
      limitBytes,
      limitSource,
      ratio: lastRatio,
      waitedMs: now() - startedAt,
      samples,
      available: verdict.level !== 'unknown',
      attempts,
    });
    if (action === 'admitted' || action === 'rejected') {
      return {
        action,
        measuredBytes: measured,
        limitBytes,
        limitSource,
        waitedMs: now() - startedAt,
        samples,
        recordPath,
        attempts,
      };
    }
    const remaining = Math.max(0, deferMs - (now() - startedAt));
    await sleep(Math.min(pollMs, remaining > 0 ? remaining : pollMs));
  }
}
