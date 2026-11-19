/**
 * MCP 审计日志（P8-A6）。
 *
 * 每行一个 JSON 对象，字段固定：`ts / session / tool / argsHash / ok / code / durationMs`。
 * **不写参数原文**——只写规范化后的 sha256；这样既能做"同一次调用"关联，
 * 又不会把用户的时间线内容或凭据抄进日志。
 *
 * 轮转：当前文件超过 `maxBytes`（默认 1 MiB）就把旧文件改名成
 * `audit-<毫秒时间戳>.jsonl`，新起一份；写操作串行化，避免同一进程内两行交错。
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const AUDIT_FILE = 'audit.jsonl';
export const DEFAULT_MAX_BYTES = 1024 * 1024;

/**
 * 稳定序列化（键排序），保证同一组参数在任何调用点得到同一个哈希。
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(/** @type {any} */ (value)[key])}`);
  return `{${entries.join(',')}}`;
}

/**
 * @param {unknown} args
 * @returns {string}
 */
export function hashArgs(args) {
  return crypto.createHash('sha256').update(canonicalJson(args ?? {})).digest('hex');
}

/**
 * @param {{ dir: string, session: string, maxBytes?: number, now?: () => number }} opts
 */
export function createAuditLog(opts) {
  const dir = path.resolve(opts.dir);
  const session = opts.session;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const now = opts.now ?? Date.now;
  const file = path.join(dir, AUDIT_FILE);
  /** @type {Promise<void>} */
  let tail = Promise.resolve();

  /**
   * @param {string} line
   * @returns {Promise<void>}
   */
  async function append(line) {
    await fs.mkdir(dir, { recursive: true });
    let size = 0;
    try {
      size = (await fs.stat(file)).size;
    } catch {
      size = 0;
    }
    if (size > 0 && size + Buffer.byteLength(line) > maxBytes) {
      await fs.rename(file, path.join(dir, `audit-${now()}.jsonl`)).catch(() => {});
    }
    await fs.appendFile(file, line);
  }

  return {
    dir,
    file,
    /**
     * @param {{ tool: string, argsHash: string, ok: boolean, code?: string | null, durationMs: number, hasAudioMix?: boolean | null }} entry
     * @returns {Promise<void>}
     */
    record(entry) {
      const line = `${JSON.stringify({
        ts: new Date(now()).toISOString(),
        session,
        tool: entry.tool,
        argsHash: entry.argsHash,
        ok: entry.ok,
        code: entry.code ?? null,
        durationMs: entry.durationMs,
        // P10：导出是否带音频时间线（只有 export_start 行才有这个字段）
        ...(entry.hasAudioMix !== undefined ? { hasAudioMix: entry.hasAudioMix } : {}),
      })}\n`;
      tail = tail.then(() => append(line)).catch(() => {});
      return tail;
    },
    /** 等已排队的写入落盘（测试/关闭用）。 */
    flush() {
      return tail;
    },
  };
}
