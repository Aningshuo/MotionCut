/**
 * 预算守卫（P24-A5）：导出跑到一半发现内存/耗时超预算，要**明确报码并停下来**，
 * 不是硬跑到底再告诉用户"其实超了"。
 *
 * 为什么采样只读 `ps` 而不读 `footprint`：R10 试过 `footprint`，它每采一次会让
 * 整棵进程树停顿几百毫秒，墙钟时间被采样本身污染（8 秒片 31.92s → 68.72s）。
 * `ps -axo pid=,ppid=,rss=` 是一次几十毫秒的只读查询，代价可以忽略。
 *
 * 统计口径：根进程（Node）**及其所有后代**的 RSS 之和。Chromium 的渲染进程、
 * GPU 进程、ffmpeg 都是后代，所以这个数才是"这次导出真正吃了多少内存"。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** @typedef {(file: string, args?: readonly string[]) => Promise<{ stdout: string, stderr: string }>} Runner */
const DEFAULT_RUNNER = /** @type {Runner} */ (/** @type {unknown} */ (execFileAsync));

export const BUDGET_GUARD_VERSION = '1.0.0';

export class BudgetExceededError extends Error {
  /**
   * @param {string} detail
   * @param {{ limitMb?: number, peakMb?: number, limitSec?: number, elapsedSec?: number }} [extra]
   */
  constructor(detail, extra = {}) {
    super(`BUDGET_EXCEEDED: ${detail}`);
    this.name = 'BudgetExceededError';
    this.code = 'BUDGET_EXCEEDED';
    this.detail = detail;
    Object.assign(this, extra);
  }
}

/**
 * 读整棵进程树的 RSS（MB）。
 * @param {number} rootPid
 * @param {Runner} [run]
 * @returns {Promise<{ rssMb: number, processes: number }>}
 */
export async function readProcessTreeRss(rootPid, run = DEFAULT_RUNNER) {
  const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,rss=']);
  /** @type {Map<number, number>} */
  const rssKb = new Map();
  /** @type {Map<number, number[]>} */
  const children = new Map();
  for (const line of String(stdout).split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const rss = Number(parts[2]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    rssKb.set(pid, Number.isFinite(rss) ? rss : 0);
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  /** @type {number[]} */
  const stack = [rootPid];
  /** @type {Set<number>} */
  const seen = new Set();
  let totalKb = 0;
  while (stack.length > 0) {
    const pid = /** @type {number} */ (stack.pop());
    if (seen.has(pid)) continue;
    seen.add(pid);
    totalKb += rssKb.get(pid) ?? 0;
    for (const child of children.get(pid) ?? []) stack.push(child);
  }
  return { rssMb: Number((totalKb / 1024).toFixed(1)), processes: seen.size };
}

/**
 * 降级后端：系统可用内存（MB）。`vm_stat` 只要读内核计数，不需要进程权限，
 * 在"`ps` 被宿主沙箱禁掉"的机器上仍然可用。
 *
 * **口径不同，必须标出来**：这是**整机**可用内存，不是这棵进程树的 RSS。
 * 同机其它进程也在动，所以它只能当"量级参考"，不能当精确值。
 * @param {Runner} [run]
 * @returns {Promise<number>}
 */
export async function readSystemFreeMemMb(run = DEFAULT_RUNNER) {
  const { stdout } = await run('vm_stat', []);
  const text = String(stdout);
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 16384);
  const freePages = Number(/Pages free:\s+(\d+)/.exec(text)?.[1] ?? NaN);
  if (!Number.isFinite(freePages)) throw new Error('vm_stat: cannot read "Pages free"');
  return Number(((freePages * pageSize) / (1024 * 1024)).toFixed(1));
}

/**
 * 起一个采样器。超预算时调 `onExceed`（通常绑到 AbortController），
 * 并把 `exceeded` 置位，调用方据此把错误翻成 `BUDGET_EXCEEDED`。
 *
 * 后端会自动降级：先用 `ps` 读整棵树；被权限挡住（宿主沙箱常见）就转 `vm_stat`，
 * 并把 `source` 标成 `system`——**两种口径不能混着报**。
 *
 * @param {{
 *   rootPid?: number,
 *   intervalMs?: number,
 *   maxRssMb?: number,
 *   maxSec?: number,
 *   onExceed?: (reason: BudgetExceededError) => void,
 *   sample?: (pid: number) => Promise<{ rssMb: number, processes: number }>,
 *   sampleSystem?: () => Promise<number>,
 *   now?: () => number,
 * }} [opts]
 * @returns {{ stop: () => Promise<{ peakMb: number, samples: number, source: 'tree' | 'system',
 *   exceeded: BudgetExceededError | null, elapsedSec: number }> }}
 */
export function startResourceMonitor(opts = {}) {
  const rootPid = opts.rootPid ?? process.pid;
  const intervalMs = Math.max(100, Number(opts.intervalMs) || 500);
  const maxRssMb = Number(opts.maxRssMb) > 0 ? Number(opts.maxRssMb) : null;
  const maxSec = Number(opts.maxSec) > 0 ? Number(opts.maxSec) : null;
  const sampleTree = opts.sample ?? ((pid) => readProcessTreeRss(pid));
  const sampleSystem = opts.sampleSystem ?? (() => readSystemFreeMemMb());
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();

  /** @type {'tree' | 'system'} */
  let source = 'tree';
  /** @type {number | null} */
  let baselineFreeMb = null;
  let peakMb = 0;
  let samples = 0;
  let stopped = false;
  /** @type {BudgetExceededError | null} */
  let exceeded = null;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  let inFlight = false;

  /** @returns {Promise<number>} */
  const measure = async () => {
    if (source === 'tree') {
      try {
        const { rssMb } = await sampleTree(rootPid);
        return rssMb;
      } catch {
        // 读不到别的进程（宿主沙箱）→ 换整机口径，别让采样把导出搞挂
        source = 'system';
        baselineFreeMb = null;
      }
    }
    const freeMb = await sampleSystem();
    if (baselineFreeMb === null || freeMb > baselineFreeMb) baselineFreeMb = freeMb;
    return Number((baselineFreeMb - freeMb).toFixed(1));
  };

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const rssMb = await measure();
      samples += 1;
      if (Number.isFinite(rssMb) && rssMb > peakMb) peakMb = rssMb;
      const elapsedSec = (now() - startedAt) / 1000;
      if (exceeded === null && maxRssMb !== null && rssMb > maxRssMb) {
        exceeded = new BudgetExceededError(
          `peak memory ${rssMb}MB (${source === 'tree' ? 'process tree RSS' : 'system free-mem drop'}) exceeds the ${maxRssMb}MB budget after ${elapsedSec.toFixed(1)}s`,
          { limitMb: maxRssMb, peakMb: rssMb },
        );
        opts.onExceed?.(exceeded);
      } else if (exceeded === null && maxSec !== null && elapsedSec > maxSec) {
        exceeded = new BudgetExceededError(`elapsed ${elapsedSec.toFixed(1)}s exceeds the ${maxSec}s budget`, {
          limitSec: maxSec,
          elapsedSec,
        });
        opts.onExceed?.(exceeded);
      }
    } catch {
      // 采样失败不该让导出失败：下一拍再算
    } finally {
      inFlight = false;
    }
  };

  timer = setInterval(() => {
    void tick();
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      // 收尾再采一次：短任务可能在第一拍之前就结束了。**先采再置 stopped**，
      // 否则这次收尾采样会被 tick 开头的短路直接吃掉（R12 踩过：samples=0）。
      await tick();
      stopped = true;
      return {
        peakMb,
        samples,
        source,
        exceeded,
        elapsedSec: Number(((now() - startedAt) / 1000).toFixed(2)),
      };
    },
  };
}
