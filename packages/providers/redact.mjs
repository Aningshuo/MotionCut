/**
 * 输出前的权威脱敏（WP19 A5）。
 *
 * 两条互补的线：
 * 1. **模式**：`sk-…` / `sk-ant-…` / `AIza…` / `Bearer …` / `x-api-key: …`；
 * 2. **登记**：拿到 Key 的那一刻调 `registerSecret()`，之后任何字符串里出现它的
 *    原文都会被替换。只靠模式会漏掉不像 Key 的自定义令牌（用户自建网关常见）。
 *
 * 用法纪律：**错误消息、日志、序列化**都必须过这里。禁止把 `apiKey` 直接拼进
 * Error.message —— 那是最常见的泄漏路径。
 */

const PATTERNS = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:x-api-key|api[-_]?key|authorization)["'\s]*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/gi,
];

/** @type {Set<string>} */
const SECRETS = new Set();

/**
 * 登记一个明文密文；长度 < 8 的忽略（太短会把正常文本打碎）。
 * @param {string} value
 */
export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 8) SECRETS.add(value);
}

/** 测试/长驻进程用：清空登记表。 */
export function clearSecrets() {
  SECRETS.clear();
}

/**
 * @param {string} text
 * @returns {string}
 */
export function redactText(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const secret of SECRETS) {
    if (secret.length >= 8) out = out.split(secret).join('[REDACTED]');
  }
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, (match) => match.replace(/[A-Za-z0-9._~+/=-]{8,}$/, '[REDACTED]'));
  }
  return out;
}

/**
 * 深拷贝式脱敏（错误对象、请求体回显、结构化日志共用）。
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function redactValue(value, depth = 0) {
  if (depth > 8) return '[DEPTH]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((inner) => redactValue(inner, depth + 1));
  if (value && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      if (/^(authorization|x-api-key|api[-_]?key|apikey|token|secret|password)$/i.test(key)) {
        out[key] = '[REDACTED]';
        continue;
      }
      out[key] = redactValue(inner, depth + 1);
    }
    return out;
  }
  return value;
}
