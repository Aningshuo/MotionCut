/**
 * 字幕导入 / 导出（E12-P5 第 3 步 · B-MAIN-R30-086）
 *
 * 这个文件只做两件事，**都不碰盘**（路由层负责读请求体、写文件）：
 *
 *   1. `importSubtitleBytes(bytes, {name, format})` —— 真实文件的**字节** → 段列表
 *      （`{start, end, text}`，秒 + 纯文本），并把「为什么读不出来」分成稳定错误码；
 *   2. `exportSubtitleBytes(cues, {format})` —— 段列表 → 字幕文本，**并当场自证能再读回来**
 *      （`roundTrip` 里带「重解析的线索是否与输入逐条相同」「再序列化是否逐字节相同」）。
 *
 * ## 为什么单独一个模块，而不是塞进 `subtitle.mjs`
 *
 * `film-core/subtitle.mjs` 是**解析器**（宽容：坏 cue 跳过并计数，绝不抛），它被预览、导出、
 * 时间线三处共用；导入是**入口**，它必须能回答「这份文件到底哪儿不对」——空文件、编码不是
 * UTF-8、时间码不合法，三种要分得开，否则面板只能弹一句「导入失败」。
 * 两者职责不同：解析器不判生死，导入器判。所以这里只 `import` 解析器，不改它一行。
 *
 * ## 编码：为什么不是 `readFile(..., 'utf8')`
 *
 * Node 的 `'utf8'` 解码**不报错**：GBK 的「字幕」两字节会被换成 U+FFFD，文件看起来「读成功了」，
 * 用户拿到一屏问号。所以这里用 `TextDecoder('utf-8', {fatal: true})`，失败时再用一个小扫描器
 * 找出**第一个非法字节的偏移**——报错要能指到位置，否则用户没法修。
 */

import { createHash } from 'node:crypto';

import {
  formatOf,
  normalizeCues,
  parseCueTime,
  parseSubtitles,
  serializeSubtitles,
} from '../../film-core/subtitle.mjs';

/** 单份字幕上限。2 MiB 够 2 小时的密集字幕（约 3000 条 × 600B）；超了就是拿错文件了。 */
export const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;

/**
 * 「往返不逐字节相同」时到底差在哪 —— 这是**说好的差异清单**，不是事后解释。
 *
 * 判据（`BATCH-MAIN-R30-086` §4）要求「逐字节相同**或**给明确允许差异清单」。
 * 我们的口径是**两条一起给**：
 *   - **规范形态**（本模块导出的文本）往返**逐字节相同**，由单测钉死；
 *   - 任意真实文件可能命中下面这些差异（每一条都是解析器的既定行为，不是缺陷）。
 */
export const ROUND_TRIP_ALLOWED_DIFFS = Object.freeze([
  'cue 标识行（`1` / `intro` 这类）被丢掉：段列表只存 start/end/text',
  '`NOTE` / `STYLE` / `REGION` 整块被丢掉：它们是排版提示，不进段列表',
  '行内标签被剥掉（`<i>` / `<c class>` / `<v 名字>` / `{\\an8}`）→ 只留纯文本',
  'HTML 实体被还原（`&amp;` → `&`、`&nbsp;` → 空格）',
  '时间码统一成 `HH:MM:SS.mmm`（毫秒补零到 3 位；`MM:SS.mmm` 补成三段）',
  '段按 start 升序重排（原文件乱序会被排好），start 相同再按 end',
  '行尾空白被裁掉；连续空行被压成一个；`\\r\\n` 归一成 `\\n`；UTF-8 BOM 被去掉',
  'VTT 头部的元数据（`WEBVTT - 标题`、`Kind: captions` 等）不保留',
]);

/**
 * @typedef {{ start: number, end: number, text: string }} Cue
 * @typedef {'vtt'|'srt'} SubtitleFormat
 * @typedef {{ line: number, text: string }} BadTimingLine
 */

/**
 * 导入成功。`ok` 是字面量 `true`，调用方 `if (result.ok !== true)` 就能收窄（tsc 也靠它）。
 * @typedef {object} ImportOk
 * @property {true} ok
 * @property {SubtitleFormat} format
 * @property {'name'|'content'} formatSource
 * @property {'utf-8'} encoding
 * @property {boolean} bom
 * @property {number} bytes
 * @property {string|null} name
 * @property {number} cueCount
 * @property {Cue[]} cues
 * @property {number} skipped
 * @property {BadTimingLine[]} badLines
 * @property {string} [skippedNote]
 * @property {string} sha256
 * @property {string} text
 */

/**
 * 导入失败。错误码是稳定的（面板按码给文案，不看 message）。
 * @typedef {object} ImportFail
 * @property {false} ok
 * @property {'SUBTITLE_EMPTY'|'SUBTITLE_NOT_UTF8'|'SUBTITLE_BAD_TIMECODE'|'SUBTITLE_NO_CUES'|'SUBTITLE_FORMAT_UNKNOWN'|'SUBTITLE_TOO_LARGE'} code
 * @property {string} message
 * @property {number} [bytes]
 * @property {string|null} [name]
 * @property {number|null} [byteOffset]
 * @property {string|null} [detected]
 * @property {number} [line]
 * @property {BadTimingLine[]} [badLines]
 * @property {SubtitleFormat} [format]
 * @property {number} [skipped]
 */

/** @param {string} text */
function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 找第一个非法 UTF-8 字节的偏移；全是合法 UTF-8 返回 −1。
 *
 * 做法是「按首字节算出这条序列该有几个字节，再让严格的解码器只解这一小段」——
 * 这样 overlong（`C0 80`）、代理区（`ED A0 80`）、超范围（`F5 …`）全都由解码器自己判，
 * 不在这里重写一遍 Unicode 规则（自己写必错）。
 *
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function firstInvalidUtf8(bytes) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let index = 0;
  while (index < bytes.length) {
    const lead = bytes[index] ?? 0;
    const size = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 0;
    /* `size === 0`：0x80–0xBF 当首字节（孤立续字节）或 0xF8 以上（UTF-8 不用）。 */
    if (size === 0) return index;
    try {
      decoder.decode(bytes.subarray(index, index + size));
    } catch {
      return index;
    }
    index += size;
  }
  return -1;
}

/**
 * 字节 → 文本（严格 UTF-8）。UTF-16 的 BOM 单独认出来，给一句能照着做的提示。
 *
 * @param {Uint8Array} bytes
 * @returns {{ ok: true, text: string, encoding: 'utf-8', bom: boolean }
 *   | { ok: false, code: 'SUBTITLE_NOT_UTF8', message: string, byteOffset: number, detected: string|null }}
 */
export function decodeSubtitleBytes(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(0);
  if (view.length >= 2) {
    const [b0, b1] = [view[0] ?? 0, view[1] ?? 0];
    if ((b0 === 0xff && b1 === 0xfe) || (b0 === 0xfe && b1 === 0xff)) {
      const detected = b0 === 0xff ? 'utf-16le' : 'utf-16be';
      return {
        ok: false,
        code: 'SUBTITLE_NOT_UTF8',
        message: `文件是 ${detected} 编码（有 BOM），本端点只收 UTF-8：请另存为 UTF-8 再导入`,
        byteOffset: 0,
        detected,
      };
    }
  }

  const bom = view.length >= 3 && view[0] === 0xef && view[1] === 0xbb && view[2] === 0xbf;
  const body = bom ? view.subarray(3) : view;
  const bad = firstInvalidUtf8(body);
  if (bad >= 0) {
    return {
      ok: false,
      code: 'SUBTITLE_NOT_UTF8',
      message: `文件不是合法 UTF-8：第 ${String((bom ? bad + 3 : bad) + 1)} 个字节起读不出字符（本端点不收 GBK/UTF-16）`,
      byteOffset: bom ? bad + 3 : bad,
      detected: null,
    };
  }
  return {
    ok: true,
    text: new TextDecoder('utf-8').decode(body),
    encoding: 'utf-8',
    bom,
  };
}

/**
 * 文件名的扩展名优先，其次看内容像不像字幕。
 *
 * `detectFormat()`（film-core）在没有 VTT 头、也没有逗号毫秒时会**默认 vtt** ——
 * 那是解析器的宽容，不能拿来判「这是不是字幕文件」。所以这里自己嗅探：
 * 一行 `-->` 都没有，就既不是 vtt 也不是 srt。
 *
 * @param {string} text
 * @param {string} name
 * @returns {{ format: SubtitleFormat, source: 'name'|'content' } | null}
 */
function resolveFormat(text, name) {
  const byName = formatOf(name);
  if (byName !== null) return { format: byName, source: 'name' };
  const head = String(text ?? '').replace(/^\uFEFF/, '').trimStart();
  if (/^WEBVTT\b/i.test(head)) return { format: 'vtt', source: 'content' };
  if (/\d{1,3}:\d{2}(?::\d{2})?[,.]\d{1,3}\s*-->/.test(head)) return { format: 'srt', source: 'content' };
  return null;
}

/**
 * 把「有 `-->` 但读不出来」的行挑出来，最多 5 条（报错要指到行，不是指到文件）。
 *
 * 判定与解析器**同源**：时间码能不能读交给 `parseCueTime`（film-core 导出的那个），
 * 这里只负责「按 `-->` 切开、两边各自试一次」。
 *
 * @param {string} text
 * @returns {{ line: number, text: string }[]}
 */
function badTimingLines(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  /** @type {{ line: number, text: string }[]} */
  const bad = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!line.includes('-->')) continue;
    const [leftRaw, rightRaw = ''] = line.split('-->');
    const left = leftRaw ?? '';
    /* 右侧可能带 `align:start position:10%` 这类设置：取第一段试。 */
    const endPart = rightRaw.trim().split(/\s+/)[0] ?? '';
    if (parseCueTime(left) === null || parseCueTime(endPart) === null) {
      bad.push({ line: index + 1, text: line.trim().slice(0, 120) });
      if (bad.length >= 5) break;
    }
  }
  return bad;
}

/**
 * 字节 → 段列表。**这是导入端点的全部逻辑**（路由层只是搬字节）。
 *
 * 错误码（稳定，面板按码给文案）：
 *   - `SUBTITLE_EMPTY`：0 字节 / 去掉 BOM 后只有空白；
 *   - `SUBTITLE_NOT_UTF8`：不是合法 UTF-8（含 UTF-16 BOM）；
 *   - `SUBTITLE_BAD_TIMECODE`：有 `-->` 行，但一条合法段都没解析出来（带首个坏行与原因）；
 *   - `SUBTITLE_NO_CUES`：连一行 `-->` 都没有 —— 这不像字幕文件；
 *   - `SUBTITLE_FORMAT_UNKNOWN`：扩展名不是 `.vtt/.srt`，内容也嗅探不出来；
 *   - `SUBTITLE_TOO_LARGE`：超过 `MAX_SUBTITLE_BYTES`。
 *
 * 部分坏行**不让整份失败**：只要还有至少一条能读，就 `ok:true` + `skipped` 计数 +
 * `badLines`（最多 5 条）——那是解析器一贯的宽容口径，导入不该比它更严。
 *
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {{ name?: string, format?: SubtitleFormat, src?: string }} [options]
 * @returns {ImportOk|ImportFail}
 */
export function importSubtitleBytes(bytes, options = {}) {
  const view = bytes instanceof Uint8Array
    ? bytes
    : bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new Uint8Array(0);

  if (view.byteLength === 0) {
    return {
      ok: false,
      code: 'SUBTITLE_EMPTY',
      message: '文件是空的（0 字节）',
      bytes: 0,
      name: options.name ?? null,
    };
  }
  if (view.byteLength > MAX_SUBTITLE_BYTES) {
    return {
      ok: false,
      code: 'SUBTITLE_TOO_LARGE',
      message: `文件 ${String(view.byteLength)} 字节，超过上限 ${String(MAX_SUBTITLE_BYTES)} 字节`,
      bytes: view.byteLength,
      name: options.name ?? null,
    };
  }

  const decoded = decodeSubtitleBytes(view);
  if (decoded.ok !== true) {
    return { ...decoded, bytes: view.byteLength, name: options.name ?? null };
  }
  const text = decoded.text;
  if (text.trim() === '') {
    return {
      ok: false,
      code: 'SUBTITLE_EMPTY',
      message: decoded.bom ? '文件只有 UTF-8 BOM，没有内容' : '文件里只有空白字符，没有内容',
      bytes: view.byteLength,
      name: options.name ?? null,
    };
  }

  const resolved = options.format === undefined || options.format === null
    ? resolveFormat(text, options.name ?? '')
    : { format: options.format, source: /** @type {'name'} */ ('name') };
  if (resolved === null) {
    return {
      ok: false,
      code: 'SUBTITLE_FORMAT_UNKNOWN',
      message: `${options.name ?? '文件'} 既不是 .vtt 也不是 .srt，内容里也没有任何 \`-->\` 时间码行`,
      bytes: view.byteLength,
      name: options.name ?? null,
    };
  }

  const parsed = parseSubtitles(text, { format: resolved.format });
  if (parsed.cues.length === 0) {
    const bad = badTimingLines(text);
    const first = bad[0];
    if (first !== undefined) {
      return {
        ok: false,
        code: 'SUBTITLE_BAD_TIMECODE',
        message: `时间码不合法：第 ${String(first.line)} 行「${first.text}」读不出起止时间（共 ${String(bad.length)} 行坏）`,
        byteOffset: null,
        line: first.line,
        badLines: bad,
        format: resolved.format,
        bytes: view.byteLength,
        name: options.name ?? null,
      };
    }
    return {
      ok: false,
      code: 'SUBTITLE_NO_CUES',
      message: parsed.skipped > 0
        ? `文件里有 ${String(parsed.skipped)} 个块读不出段（没有一条同时具备时间码和非空文本）`
        : '文件里没有任何可用的字幕段（没有 `-->` 时间码行，也没有正文）',
      skipped: parsed.skipped,
      format: resolved.format,
      bytes: view.byteLength,
      name: options.name ?? null,
    };
  }

  const badLines = parsed.skipped === 0 ? [] : badTimingLines(text);
  return {
    ok: true,
    format: parsed.format,
    formatSource: resolved.source,
    encoding: decoded.encoding,
    bom: decoded.bom,
    bytes: view.byteLength,
    name: options.name ?? null,
    cueCount: parsed.cues.length,
    cues: parsed.cues,
    skipped: parsed.skipped,
    badLines,
    /* 跳过了、但时间码**读得出**（多半是 end ≤ start，或者整块没有正文）：
       解析器只给计数不给原因，所以这里如实说「不是时间码写坏了」，别让面板指错行。 */
    ...(parsed.skipped > 0 && badLines.length === 0
      ? { skippedNote: `有 ${String(parsed.skipped)} 个块被跳过：时间码读得出，但结束时间不大于开始时间、或者整块没有正文` }
      : {}),
    /* 导入的原文哈希：面板可以拿它判「这份文件我导过没」（不落盘，只在响应里）。 */
    sha256: sha256(text),
    text,
  };
}

/**
 * 段列表 → 字幕文本，并当场自证能再读回来。
 *
 * `roundTrip.byteIdentical` 是这条链的判据：**导出的文本再导入、再导出，逐字节相同**。
 * 对「规范形态」（本函数的输出）它恒为 true；对用户手写的文件不保证（差异见
 * `ROUND_TRIP_ALLOWED_DIFFS`），所以调用方看的是 `roundTrip.cueEqual`（线索是否等价）。
 *
 * @param {unknown} cues
 * @param {{ format?: SubtitleFormat }} [options]
 * @returns {{ ok: true, format: SubtitleFormat, text: string, bytes: number, sha256: string,
 *   cueCount: number, cues: Cue[], roundTrip: { cueEqual: boolean, byteIdentical: boolean,
 *   reparsedCueCount: number, reparsedSha256: string } }
 *   | { ok: false, code: 'SUBTITLE_INVALID', message: string }}
 */
export function exportSubtitleBytes(cues, options = {}) {
  /** @type {Cue[]} */
  let normalized;
  try {
    normalized = normalizeCues(cues);
  } catch (error) {
    return {
      ok: false,
      code: 'SUBTITLE_INVALID',
      message: String(/** @type {Error} */ (error)?.message ?? error),
    };
  }
  const format = options.format === 'srt' ? 'srt' : 'vtt';
  const text = serializeSubtitles(normalized, { format });

  const reparsed = parseSubtitles(text, { format });
  const cueEqual = reparsed.cues.length === normalized.length
    && reparsed.cues.every((cue, index) => {
      const before = normalized[index];
      if (before === undefined) return false;
      return cue.start === before.start && cue.end === before.end && cue.text === before.text;
    });
  const again = serializeSubtitles(reparsed.cues, { format });

  return {
    ok: true,
    format,
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    sha256: sha256(text),
    cueCount: normalized.length,
    cues: normalized,
    roundTrip: {
      cueEqual,
      /* 规范形态的判据：再序列化逐字节相同。 */
      byteIdentical: again === text,
      reparsedCueCount: reparsed.cues.length,
      reparsedSha256: sha256(again),
    },
  };
}

/**
 * 一条「这份文件会变成什么」的摘要（导入端点响应用，不含正文，日志友好）。
 * @param {ImportOk|ImportFail} result
 * @returns {Record<string, unknown>}
 */
export function importSummary(result) {
  if (result.ok !== true) {
    return { ok: false, code: result.code, message: result.message };
  }
  return {
    ok: true,
    format: result.format,
    cueCount: result.cueCount,
    bytes: result.bytes,
    encoding: result.encoding,
    bom: result.bom,
    skipped: result.skipped,
    sha256: result.sha256,
  };
}
