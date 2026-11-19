/**
 * SSE 解析（WP19 A1/A3）。
 *
 * 按 `text/event-stream` 规范：`field: value`、空行派发、多行 `data` 用 `\n` 连接、
 * 以 `:` 开头的是注释、`\r\n` 与 `\n` 都要认。
 *
 * **不在这里判断 JSON 合法性**：解析器只管帧，帧里的 `data` 是否 JSON 由 wire 决定，
 * 这样 `[DONE]` 这种非 JSON 哨兵才能被正常处理；坏 JSON 的报错也就带得上 wire 上下文。
 */

/**
 * @typedef {{ event: string | null, data: string, id: string | null }} SseFrame
 */

export class SseDecoder {
  /** @type {string} */
  #buffer = '';
  /** @type {string[]} */
  #data = [];
  /** @type {string | null} */
  #event = null;
  /** @type {string | null} */
  #id = null;
  /** @type {boolean} */
  #sawAny = false;

  /**
   * @param {string | Uint8Array} chunk
   * @returns {SseFrame[]}
   */
  push(chunk) {
    this.#buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    /** @type {SseFrame[]} */
    const frames = [];
    let index = this.#buffer.indexOf('\n');
    while (index >= 0) {
      const rawLine = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      this.#line(rawLine.replace(/\r$/, ''), frames);
      index = this.#buffer.indexOf('\n');
    }
    return frames;
  }

  /**
   * 流结束时派发最后一个没有空行收尾的帧。
   * @returns {SseFrame[]}
   */
  end() {
    /** @type {SseFrame[]} */
    const frames = [];
    if (this.#buffer.length > 0) {
      this.#line(this.#buffer.replace(/\r$/, ''), frames);
      this.#buffer = '';
    }
    this.#flush(frames);
    return frames;
  }

  /** 有没有收到过任何内容（用于区分"空流"与"半截流"）。 */
  get sawAny() {
    return this.#sawAny;
  }

  /**
   * @param {string} line
   * @param {SseFrame[]} frames
   */
  #line(line, frames) {
    if (line.length === 0) {
      this.#flush(frames);
      return;
    }
    this.#sawAny = true;
    if (line.startsWith(':')) return; // 注释/心跳

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') this.#data.push(value);
    else if (field === 'event') this.#event = value;
    else if (field === 'id') this.#id = value;
    // retry 等字段忽略：重连由调用方决定，本库不偷偷重连
  }

  /**
   * @param {SseFrame[]} frames
   */
  #flush(frames) {
    if (this.#data.length === 0 && this.#event === null) return;
    frames.push({ event: this.#event, data: this.#data.join('\n'), id: this.#id });
    this.#data = [];
    this.#event = null;
  }
}

/**
 * @param {SseFrame} frame
 * @returns {boolean}
 */
export function isDoneFrame(frame) {
  return frame.data.trim() === '[DONE]';
}
