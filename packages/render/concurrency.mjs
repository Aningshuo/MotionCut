/**
 * 取帧通道数规则（R10 引入，R11 抽出来共用）。
 *
 * 单独成文件的理由：预估层（`export-estimate.mjs`）必须和真实取帧用**同一个**数字，
 * 否则「预估按 3 通道、实际开 6 通道」这种偏差会被算到模型头上。
 * 但预估层不该为了一个纯函数去 import `stage-capture.mjs`（那会把 Studio/Playwright 拖进来）。
 *
 * 规则（R10 实测）：
 * - 8 核 / 16GB / 1280×720：1 页 126.8s、4 页 40.9s、6 页 33.6s、8 页 29.8s。
 *   4→8 只有 1.37×：每帧 600ms 里约 90% 是页面内等视频 seek，多开页面只是在等不同的 seek。
 * - 通道数取 `cores × 0.75`，封顶 6，留余量给同机其它进程。
 * - 内存按**视频片段数**封顶：每条视频在每个 page 里都有一份解码缓冲。
 *   实测 film30（4 条视频）：1 通道 735MB、3 通道 1.47GB、6 通道 2.96GB，即每通道约 +400MB。
 *   1.5GB 预算下，4 条视频最多 3 个通道。
 */

import os from 'node:os';

/**
 * @param {any} plan
 * @returns {number}
 */
export function planCaptureConcurrency(plan) {
  const cores = (() => {
    try {
      return os.availableParallelism();
    } catch {
      return 4;
    }
  })();
  const byCores = Math.max(2, Math.min(6, Math.floor(cores * 0.75)));
  const videos = Array.isArray(plan?.visualClips) ? plan.visualClips.length : 0;
  const byMemory = videos <= 2 ? 6 : 3;
  return Math.max(1, Math.min(byCores, byMemory));
}

/** 渲染并发允许的硬边界（M67·WP23）。env 覆盖只能落在这个闭区间里。 */
export const RENDER_CONCURRENCY_LIMITS = Object.freeze({ min: 1, max: 8 });

/** `OPENCUT_RENDER_CONCURRENCY` 非法（非整数/越界）时抛它。 */
export class RenderConcurrencyError extends Error {
  /**
   * @param {string} message
   * @param {{value?: unknown}} [extra]
   */
  constructor(message, extra = {}) {
    super(message);
    this.name = 'RenderConcurrencyError';
    this.code = 'RENDER_CONCURRENCY_INVALID';
    this.allowed = [RENDER_CONCURRENCY_LIMITS.min, RENDER_CONCURRENCY_LIMITS.max];
    if ('value' in extra) this.value = extra.value;
  }
}

/**
 * 真实渲染并发数（M67）：
 *
 * - 默认取 `planCaptureConcurrency(plan)`（同一套 CPU/内存预算，预估与执行不漂移）；
 * - `OPENCUT_RENDER_CONCURRENCY` 可覆盖，但必须是 1..8 的**整数**；`0` / `9` / `1.5` /
 *   `abc` 一律抛 `RENDER_CONCURRENCY_INVALID`（带 allowed），不静默夹到边界。
 *
 * @param {{plan?: any, env?: Record<string, string|undefined>}} [options]
 * @returns {number}
 */
export function resolveRenderConcurrency(options = {}) {
  const env = options.env ?? process.env;
  const raw = env?.OPENCUT_RENDER_CONCURRENCY;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return planCaptureConcurrency(options.plan ?? null);
  }
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) {
    throw new RenderConcurrencyError(`OPENCUT_RENDER_CONCURRENCY 必须是 1..8 的整数（收到 ${JSON.stringify(String(raw))}）`, { value: raw });
  }
  const value = Number(text);
  if (value < RENDER_CONCURRENCY_LIMITS.min || value > RENDER_CONCURRENCY_LIMITS.max) {
    throw new RenderConcurrencyError(
      `OPENCUT_RENDER_CONCURRENCY 必须在 ${RENDER_CONCURRENCY_LIMITS.min}..${RENDER_CONCURRENCY_LIMITS.max}（收到 ${value}）`,
      { value },
    );
  }
  return value;
}
