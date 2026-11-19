/**
 * 预算与并发（WP19 A7）。
 *
 * 三件事，各自独立：
 * 1. **并发上限**：超过上限的请求排队，不直接失败（用户点两下不该报错）；
 * 2. **超时**：每个请求自带 deadline，到点 abort，错误码 `TIMEOUT`，且**只影响它自己**；
 * 3. **输出预算**：`maxOutputTokens` 有硬上限，调用方只能往下调，不能往上顶。
 *
 * 取消与超时分开：外部 signal → `CANCELLED`；内部计时器 → `TIMEOUT`。
 * 混成一个码，上层就没法区分"用户不要了"和"网络太慢"。
 */

import { ProviderError } from './errors.mjs';

/**
 * @param {number} max
 */
export function createLimiter(max) {
  const limit = Math.max(1, Math.floor(max));
  let active = 0;
  /** @type {Array<() => void>} */
  const queue = [];

  return {
    get active() {
      return active;
    },
    get pending() {
      return queue.length;
    },
    get limit() {
      return limit;
    },
    /**
     * @template T
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     */
    async run(fn) {
      if (active >= limit) {
        await new Promise((resolve) => queue.push(/** @type {() => void} */ (resolve)));
      }
      active += 1;
      try {
        return await fn();
      } finally {
        active -= 1;
        const next = queue.shift();
        if (next) next();
      }
    },
  };
}

/**
 * 把调用方要的 maxOutputTokens 夹到服务端允许的上限。
 * @param {number | undefined} requested
 * @param {number} ceiling
 * @returns {number}
 */
export function resolveMaxOutputTokens(requested, ceiling) {
  const cap = Math.max(1, Math.floor(ceiling));
  if (requested === undefined) return cap;
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new ProviderError('BUDGET_EXCEEDED', `maxOutputTokens must be a positive number, got ${String(requested)}`);
  }
  return Math.min(Math.floor(requested), cap);
}

/**
 * 组合外部 signal 与 deadline，并记录"是谁先动的手"。
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} opts
 * @returns {{ signal: AbortSignal, reason: () => 'external' | 'timeout' | null, cleanup: () => void }}
 */
export function createDeadline(opts = {}) {
  const controller = new AbortController();
  /** @type {'external' | 'timeout' | null} */
  let reason = null;

  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  if (Number.isFinite(opts.timeoutMs) && /** @type {number} */ (opts.timeoutMs) > 0) {
    timer = setTimeout(() => {
      reason = reason ?? 'timeout';
      controller.abort(new Error('timeout'));
    }, /** @type {number} */ (opts.timeoutMs));
    timer.unref?.();
  }

  /** @type {(() => void) | undefined} */
  let onAbort;
  if (opts.signal) {
    if (opts.signal.aborted) {
      reason = 'external';
      controller.abort();
    } else {
      onAbort = () => {
        reason = reason ?? 'external';
        controller.abort();
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    reason: () => reason,
    cleanup() {
      if (timer) clearTimeout(timer);
      if (onAbort && opts.signal) opts.signal.removeEventListener('abort', onAbort);
    },
  };
}
