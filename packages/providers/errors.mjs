/**
 * Provider 错误（WP19）。
 *
 * 一个稳定的 `code` 比一句人话重要：上层要靠它决定"重试 / 换 Key / 降级 / 取消"。
 * 所有消息在构造时过 `redactText`——错误对象是最容易漏 Key 的地方。
 */

import { redactText } from './redact.mjs';

/** @typedef {'PROVIDER_PROTOCOL_ERROR' | 'CANCELLED' | 'TIMEOUT' | 'AUTH_REQUIRED' | 'RATE_LIMITED' | 'BUDGET_EXCEEDED' | 'CONCURRENCY_LIMIT' | 'HTTP_ERROR' | 'KEY_MISSING' | 'INVALID_REQUEST' | 'UNSUPPORTED_TOOLS' | 'TOOL_LOOP_LIMIT'} ProviderErrorCode */

export class ProviderError extends Error {
  /**
   * @param {ProviderErrorCode} code
   * @param {string} message
   * @param {{ status?: number, retryable?: boolean, retryAfterMs?: number | null, detail?: unknown, cause?: unknown }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(redactText(message));
    this.name = 'ProviderError';
    this.code = code;
    this.status = extra.status ?? null;
    this.retryable = extra.retryable ?? false;
    /** 服务端明确要求的等待毫秒（Retry-After）；null = 没给。 */
    this.retryAfterMs = typeof extra.retryAfterMs === 'number' && Number.isFinite(extra.retryAfterMs) ? extra.retryAfterMs : null;
    this.detail = extra.detail;
    if (extra.cause !== undefined) this.cause = extra.cause;
  }

  toJSON() {
    return {
      code: this.code,
      message: redactText(this.message),
      ...(this.status !== null ? { status: this.status } : {}),
      retryable: this.retryable,
      ...(this.retryAfterMs !== null ? { retryAfterMs: this.retryAfterMs } : {}),
    };
  }
}

/**
 * HTTP 状态 → 稳定错误码。
 * @param {number} status
 * @returns {ProviderErrorCode}
 */
export function codeForStatus(status) {
  if (status === 401 || status === 403) return 'AUTH_REQUIRED';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 408 || status === 504) return 'TIMEOUT';
  return 'HTTP_ERROR';
}

/**
 * 模型明确说"我不支持工具"的几种说法（OpenAI / Anthropic / 自建网关都见过）。
 * 只认这几种，别把普通 400 也当成"降级"。
 * @param {unknown} body
 * @returns {boolean}
 */
export function isUnsupportedToolsError(body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  if (!/tool/i.test(text)) return false;
  return /(not supported|unsupported|does not support|不支持)/i.test(text);
}


/**
 * 解析 `Retry-After`（RFC 9110）：秒数或 HTTP 日期。
 *
 * 为什么单独做：不同厂商在 429 上给的形式不一样，有的只给 body 里的
 * `retry_after`；上层要的是**毫秒预算**，不是字符串。
 *
 * @param {string | null | undefined} value
 * @param {number} [now]
 * @returns {number | null}
 */
export function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : null;
  }
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}
