/**
 * MCP 限流（P8-A8）。
 *
 * **默认每秒 20 次**（滑动窗口，按 tool 调用计）。超限不是静默丢弃，而是
 * `E_RATE_LIMITED` + `retryAfterMs`——客户端知道等多久，也知道自己撞了限。
 *
 * 为什么是 20：一次 30 秒闭环里，Agent 正常节奏是"读一次、改一次、导出一次"，
 * 20/s 足够覆盖重试风暴之外的任何正常用法；再高就挡不住失控循环。
 */

export const DEFAULT_LIMIT = 20;
export const DEFAULT_WINDOW_MS = 1000;

/**
 * @param {{ limit?: number, windowMs?: number, now?: () => number }} [opts]
 */
export function createRateLimiter(opts = {}) {
  const limit = Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT));
  const windowMs = Math.max(1, Math.floor(opts.windowMs ?? DEFAULT_WINDOW_MS));
  const now = opts.now ?? Date.now;
  /** @type {number[]} */
  let hits = [];

  return {
    limit,
    windowMs,
    /**
     * @returns {{ ok: true } | { ok: false, retryAfterMs: number }}
     */
    take() {
      const at = now();
      hits = hits.filter((stamp) => at - stamp < windowMs);
      if (hits.length < limit) {
        hits.push(at);
        return { ok: true };
      }
      const oldest = hits[0] ?? at;
      return { ok: false, retryAfterMs: Math.max(1, windowMs - (at - oldest)) };
    },
    /** 观测用。 */
    get used() {
      const at = now();
      hits = hits.filter((stamp) => at - stamp < windowMs);
      return hits.length;
    },
  };
}
