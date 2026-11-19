/**
 * 字幕解析与序列化（M24 · B-MAIN-R12-012）——纯函数，不读盘、不碰 DOM。
 *
 * 支持两种格式，统一成同一种形状：
 *
 * ```js
 * { start: 1.5, end: 3.25, text: '第一行\n第二行' }   // 秒（number）、纯文本、保留换行
 * ```
 *
 * 解析规则（ED 字幕段）：
 * - **WebVTT**：`WEBVTT` 头（可带 BOM）、`HH:MM:SS.mmm --> HH:MM:SS.mmm`（也接受 `MM:SS.mmm`）、
 *   cue 标识行可有可无；`NOTE` / `STYLE` / `REGION` 整块跳过。
 * - **SRT**：`00:00:01,000 --> 00:00:02,000`（逗号毫秒），序号行可有可无。
 * - 行内标签（`<i>` / `<c.red>` / `<v 名字>` / `{\an8}`）去掉，只留纯文本。
 * - **非法 cue 跳过并计数**，绝不抛：`{ start: NaN }`、`end < start`、时间行格式坏都算一条 skipped。
 *
 * 序列化永远升序、`HH:MM:SS.mmm`（SRT 用逗号），保留换行；**格式跟随原文件**（不偷偷转格式）。
 */

/** @typedef {{ start: number, end: number, text: string }} Cue */
/** @typedef {'vtt'|'srt'} SubtitleFormat */

/**
 * 解析结果。`skipped` 是「看着像 cue 但坏了」的条数，不包含被主动跳过的 NOTE/STYLE 块。
 * @typedef {{ cues: Cue[], skipped: number, format: SubtitleFormat }} ParseResult
 */

/** 时间戳：`HH:MM:SS.mmm` / `MM:SS.mmm` / 逗号毫秒都收。 */
const TIME = String.raw`(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?[.,](\d{1,3})`;

/** 时间行：`start --> end`（允许前后有空格、行尾有设置如 `align:start`）。 */
const TIMING_LINE = new RegExp(`^\\s*${TIME}\\s*-->\\s*${TIME}(?:\\s+.*)?$`);

/**
 * 时间戳文本 → 秒；坏格式返回 null。
 * @param {string} text
 * @returns {number|null}
 */
export function parseCueTime(text) {
  const match = new RegExp(`^\\s*${TIME}\\s*$`).exec(String(text ?? ''));
  if (match === null) return null;
  const [, a, b, c, ms] = match;
  // 三段（HH:MM:SS）时 a=时、b=分、c=秒；两段（MM:SS）时 a=分、b=秒，c 为空。
  const hours = c === undefined ? 0 : Number(a);
  const minutes = c === undefined ? Number(a) : Number(b);
  const seconds = c === undefined ? Number(b) : Number(c);
  if (minutes > 59 || seconds > 59) return null;
  const millis = Number(String(ms).padEnd(3, '0').slice(0, 3));
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000 + millis) / 1000;
}

/**
 * 秒 → `HH:MM:SS.mmm`（SRT 用逗号）。负值按 0 处理；毫秒四舍五入到整毫秒。
 * @param {number} seconds
 * @param {{ comma?: boolean }} [options]
 */
export function formatCueTime(seconds, options = {}) {
  const safe = Number.isFinite(Number(seconds)) ? Math.max(0, Number(seconds)) : 0;
  const total = Math.round(safe * 1000);
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const secs = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  /** @param {number} value @param {number} width */
  const pad = (value, width) => String(value).padStart(width, '0');
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secs, 2)}${options.comma === true ? ',' : '.'}${pad(millis, 3)}`;
}

/**
 * 去掉行内标签，只留纯文本（保留换行）。
 * WebVTT 的 `<i>`/`<c.x>`/`<v 名字>` 与 SRT 常见的 `{\an8}` 都清掉；`&amp;` 这类实体还原常用的几个。
 * @param {string[]} lines
 */
function plainText(lines) {
  const text = lines
    .join('\n')
    .replace(/<[^>]*>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ');
  return text
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

/**
 * 判断这段文本是 VTT 还是 SRT（VTT 头优先，其次看逗号毫秒）。
 * @param {string} text
 * @returns {SubtitleFormat}
 */
export function detectFormat(text) {
  const head = String(text ?? '').replace(/^\uFEFF/, '').trimStart();
  if (/^WEBVTT\b/i.test(head)) return 'vtt';
  // SRT 的典型特征：序号行 + 逗号毫秒；两者任一命中就当 srt。
  if (/\d{1,3}:\d{2}:\d{2},\d{1,3}\s*-->/.test(head)) return 'srt';
  return 'vtt';
}

/**
 * 解析字幕文本。
 *
 * @param {string} text
 * @param {{ format?: SubtitleFormat }} [options] 不给就自己判（`.srt` 的调用方可以显式给）
 * @returns {ParseResult}
 */
export function parseSubtitles(text, options = {}) {
  const source = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const format = options.format ?? detectFormat(source);
  /** @type {Cue[]} */
  const cues = [];
  let skipped = 0;

  const lines = source.split('\n');
  let index = 0;
  // VTT 的头可能带元数据（`WEBVTT - 标题`、`Kind: captions` 等），一直跳到第一个空行。
  if (format === 'vtt' && /^WEBVTT\b/i.test(lines[0] ?? '')) {
    index = 1;
    while (index < lines.length && (lines[index] ?? '').trim() !== '') index += 1;
  }

  while (index < lines.length) {
    // 跳过空行
    while (index < lines.length && (lines[index] ?? '').trim() === '') index += 1;
    if (index >= lines.length) break;

    const first = lines[index] ?? '';
    const keyword = first.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
    if (format === 'vtt' && (keyword === 'NOTE' || keyword === 'STYLE' || keyword === 'REGION')) {
      // 整块跳过，直到空行（含 `NOTE 这里是注释` 这种一行式）。
      index += 1;
      while (index < lines.length && (lines[index] ?? '').trim() !== '') index += 1;
      continue;
    }

    // 找这段的 timing 行：第一行就是，或者第一行是 cue 标识/序号。
    let timing = TIMING_LINE.exec(first);
    let payloadStart = index + 1;
    if (timing === null) {
      const second = lines[index + 1];
      if (second !== undefined) {
        timing = TIMING_LINE.exec(second);
        payloadStart = index + 2;
      }
    }
    if (timing === null) {
      // 不是 cue（既没有 timing 行也不是块头）→ 当坏块跳过，不抛。
      skipped += 1;
      index += 1;
      while (index < lines.length && (lines[index] ?? '').trim() !== '') index += 1;
      continue;
    }

    // 收集 payload 到空行为止。
    const payload = [];
    while (payloadStart < lines.length && (lines[payloadStart] ?? '').trim() !== '') {
      payload.push(lines[payloadStart] ?? '');
      payloadStart += 1;
    }
    index = payloadStart;

    const start = toSeconds(timing[1] ?? '', timing[2] ?? '', timing[3], timing[4] ?? '');
    const end = toSeconds(timing[5] ?? '', timing[6] ?? '', timing[7], timing[8] ?? '');
    if (start === null || end === null || !(end > start)) {
      skipped += 1;
      continue;
    }
    const text = plainText(payload);
    if (text.trim() === '') {
      // 只有时间没有文字：当成这条 cue 坏了（写回去也没人看得见）。
      skipped += 1;
      continue;
    }
    cues.push({ start, end, text });
  }

  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  return { cues, skipped, format };
}

/** TIMING_LINE 的四组捕获 → 秒。 @param {string} a @param {string} b @param {string|undefined} c @param {string} ms */
function toSeconds(a, b, c, ms) {
  const hours = c === undefined ? 0 : Number(a);
  const minutes = c === undefined ? Number(a) : Number(b);
  const seconds = c === undefined ? Number(b) : Number(c);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
  if (minutes > 59 || seconds > 59) return null;
  const millis = Number(String(ms).padEnd(3, '0').slice(0, 3));
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000 + millis) / 1000;
}

/**
 * 序列化（升序、毫秒精度、保留换行）。`format` 默认 vtt。
 * @param {readonly Cue[]} cues
 * @param {{ format?: SubtitleFormat }} [options]
 * @returns {string}
 */
export function serializeSubtitles(cues, options = {}) {
  const format = options.format ?? 'vtt';
  const sorted = [...(cues ?? [])]
    .filter((cue) => Number.isFinite(Number(cue?.start)) && Number.isFinite(Number(cue?.end)) && Number(cue.end) > Number(cue.start))
    .sort((a, b) => Number(a.start) - Number(b.start) || Number(a.end) - Number(b.end));

  if (format === 'srt') {
    const blocks = sorted.map((cue, index) => {
      const text = String(cue.text ?? '').replace(/\r\n?/g, '\n');
      return `${index + 1}\n${formatCueTime(cue.start, { comma: true })} --> ${formatCueTime(cue.end, { comma: true })}\n${text}`;
    });
    return `${blocks.join('\n\n')}\n`;
  }

  const blocks = sorted.map((cue) => {
    const text = String(cue.text ?? '').replace(/\r\n?/g, '\n');
    return `${formatCueTime(cue.start)} --> ${formatCueTime(cue.end)}\n${text}`;
  });
  return `WEBVTT\n\n${blocks.join('\n\n')}\n`;
}

/**
 * 伴生字幕候选路径（**文件名**，调用方拼目录）：`a.mp4` → `['a.vtt', 'a.srt']`。
 * `.vtt` 优先；`src` 可能带 `#t=`，先剥掉。
 * @param {string} src
 * @returns {string[]}
 */
export function companionCandidates(src) {
  const clean = String(src ?? '').split('#')[0] ?? '';
  const slash = clean.lastIndexOf('/');
  const dir = slash < 0 ? '' : clean.slice(0, slash + 1);
  const name = slash < 0 ? clean : clean.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const stem = dot <= 0 ? name : name.slice(0, dot);
  if (stem === '') return [];
  if (stem === '') return [];
  return [`${dir}${stem}.vtt`, `${dir}${stem}.srt`];
}

/** 按扩展名给格式；不是字幕扩展名返回 null。 @param {string} name */
export function formatOf(name) {
  const lower = String(name ?? '').toLowerCase();
  if (lower.endsWith('.vtt')) return 'vtt';
  if (lower.endsWith('.srt')) return 'srt';
  return null;
}

/**
 * 校验并规整一组 cue（保存前用）：非法就抛一条**人话**（调用方转 400）。
 * 时间必须是 number、`end > start`、文本非空。
 * @param {unknown} value
 * @returns {Cue[]}
 */
export function normalizeCues(value) {
  if (!Array.isArray(value)) throw new Error('cues 必须是数组');
  /** @type {Cue[]} */
  const out = [];
  for (let index = 0; index < value.length; index += 1) {
    const cue = /** @type {any} */ (value[index]);
    const start = Number(cue?.start);
    const end = Number(cue?.end);
    const text = typeof cue?.text === 'string' ? cue.text : '';
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0) {
      throw new Error(`第 ${index + 1} 条字幕的时间不是有效秒数`);
    }
    if (!(end > start)) throw new Error(`第 ${index + 1} 条字幕的结束时间必须大于开始时间`);
    if (text.trim() === '') throw new Error(`第 ${index + 1} 条字幕没有文本`);
    out.push({ start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000, text });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}
