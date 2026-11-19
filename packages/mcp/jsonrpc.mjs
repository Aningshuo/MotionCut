/**
 * JSON-RPC 2.0 的线格式与错误码（WP18 MCP 侧）。
 *
 * MCP 的 stdio 传输是**换行分隔的 JSON**（不是 LSP 的 Content-Length 头）。
 * 这里只做三件事：拆行、拼信封、给标准错误码。不认识的方法一律 `-32601`，
 * 参数不合 schema 一律 `-32602`，绝不"静默当作成功"。
 */

export const RPC = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
});

/** 我们能对接的 MCP 版本（新→旧）；对端给别的版本就回最新的。 */
export const PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);
export const LATEST_PROTOCOL = PROTOCOL_VERSIONS[0];

/**
 * @param {string | number | null} id
 * @param {unknown} result
 */
export function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

/**
 * @param {string | number | null} id
 * @param {number} code
 * @param {string} message
 * @param {unknown} [data]
 */
export function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/**
 * 增量拆行。stdout 侧只写单行 JSON，stdin 侧容忍空行与 `\r\n`。
 */
export class LineDecoder {
  /** @type {string} */
  #buffer = '';

  /**
   * @param {{ onMessage: (value: unknown) => void, onGarbage?: (line: string) => void }} handlers
   */
  constructor(handlers) {
    this.#handlers = handlers;
  }

  /** @type {{ onMessage: (value: unknown) => void, onGarbage?: (line: string) => void }} */
  #handlers;

  /**
   * @param {Buffer | string} chunk
   * @returns {void}
   */
  push(chunk) {
    this.#buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let index = this.#buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.#buffer.slice(0, index).replace(/\r$/, '');
      this.#buffer = this.#buffer.slice(index + 1);
      this.#dispatch(line);
      index = this.#buffer.indexOf('\n');
    }
  }

  /** 结束时把最后一行（没有换行）也吐出来。 */
  end() {
    const rest = this.#buffer;
    this.#buffer = '';
    if (rest.trim().length > 0) this.#dispatch(rest);
  }

  /**
   * @param {string} line
   * @returns {void}
   */
  #dispatch(line) {
    if (line.trim().length === 0) return;
    try {
      this.#handlers.onMessage(JSON.parse(line));
    } catch {
      this.#handlers.onGarbage?.(line);
    }
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function encodeMessage(value) {
  return `${JSON.stringify(value)}\n`;
}
