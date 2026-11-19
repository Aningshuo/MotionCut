/**
 * 输出前的兜底脱敏（WP18 A10）。
 *
 * CLI 本身不碰凭据：它从环境读 `OPENCUT_ENV_JSON`，不读任何 Key。但错误文本里
 * 可能带用户粘贴的 URL / header / 环境值，所以出 stdout/stderr 之前统一过一遍。
 *
 * 权威的 Key 脱敏在 `packages/providers/redact.mjs`（WP19，覆盖面更大，含
 * 结构化对象与已知密文登记）。这里是 CLI 侧的**最后一道闸**，只管文本。
 */

const PATTERNS = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\b(?:Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:x-api-key|api[-_]?key|authorization)["'\s]*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/gi,
];

/**
 * @param {string} text
 * @returns {string}
 */
export function redactText(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const pattern of PATTERNS) out = out.replace(pattern, (match) => match.replace(/[A-Za-z0-9._~+/=-]{8,}$/, '[REDACTED]'));
  return out;
}

/**
 * 深拷贝式脱敏，避免把密文写进 JSON。
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactValue(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[key] = redactValue(inner);
    return out;
  }
  return value;
}
