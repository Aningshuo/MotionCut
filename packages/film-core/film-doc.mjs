/**
 * film.html 严格解析 + 字节保真写回。
 * 合同：contracts/film-doc.ts v1.2.0（`LEGACY_DIALECT`、`ClipOwnOverride`、`KIND_OF_TAG`）。
 *
 * 唯一合法方言（v1.2.0 是纠错版，不是功能新增）：
 * 1. 轨道 = 普通 `<section>`，第一个在最上层；只认 `hidden/muted/locked` 与 `id|class|title|lang|dir|data-*|aria-*`。
 * 2. 片段 = 标签定类型：`iframe` 网页、`video` 视频、`img` 图片、`audio` 声音、`div` 文本（E12-P3）；
 *    `<audio src="x.mp4">` 是该视频的声音。**文本片段**是唯一「内容在自己身上」的片段：
 *    `<div id="t1" time="0,6">你好</div>` —— 文字进 `clip.text`，可见区间写 `time` 属性
 *    （与 `src#t=` 同义），`src` 可省（指 `scenes/*.html` 时表示它挂在哪张页面上）。
 * 3. 片段属性**不带 `data-` 前缀**：`id/src/at/speed/volume/muted/size/class/style/overrides`；
 *    Studio 自有属性只有 `data-link` / `data-props`。
 * 4. 源入出点写在 `src` 的 `#t=in,out`（`#t=in` 表示到结尾）；**没有 `time` 属性**。
 * 5. `overrides` 是 JSON 数组，最多一条**没有 `at`** 的条目 = 片段自有条目；`fade` 只存在那里。
 * 6. `stage` 来自 `<meta name="viewport" content="width=W, height=H">`，缺省 1920×1080；**文件里没有帧率**，
 *    `fps` 由调用方注入（缺省 30/1）。
 * 7. 旧方言（`data-` 前缀的片段/轨道/舞台属性）一律报 `LEGACY_DIALECT` 并给出正确写法，**不做双读**。
 *
 * 三条不变量：
 * - 未知元素/属性/字段一律诊断，不静默丢弃；有 error 时 `doc = null`，写回拒绝。
 * - 写回只替换被编辑属性的字节区间，其余字节原样保留；无改动 `writeValue()` 返回 `changed:false`。
 * - `write()` 是**纯函数**：不读盘、不写盘、不读时钟。
 *
 * 写回实现也在这里：它要用 `analyze()` 给出的元素区间（`ops-write.mjs` 保留为同一实现的出口）。
 */

import { CLIP_DISABLED_ATTR, CLIP_MARKERS_ATTR } from './clip-state.mjs';
import { createHash } from 'node:crypto';

import { EditError, applyOpsDetailed, clipKindOf } from './ops.mjs';
import { staticPropsOf, validateKeyframeList } from './keyframes.mjs';
import { validateTextStyle } from './text-style.mjs';
import { PAST_END_EPS, clipDuration, formatRational, parseRational, parseSeconds, parseTimeRange, validateRange } from './time.mjs';

export const CONTRACT_VERSION = '1.2.0';

/** 合同规定的诊断码（含 v1.2.0 的 `LEGACY_DIALECT`），不新增同义码。 */
export const DIAGNOSTIC_CODES = Object.freeze([
  'FILM_NOT_FOUND',
  'FILM_UNREADABLE',
  'UNKNOWN_ELEMENT',
  'UNKNOWN_ATTRIBUTE',
  'UNKNOWN_FIELD',
  'BAD_TIME',
  'TIME_PAST_END',
  'TIME_INVERTED',
  'BAD_SPEED',
  'BAD_STAGE',
  'DUPLICATE_CLIP_ID',
  'TRACK_ROLE_CONFLICT',
  'PAGE_WITHOUT_DURATION',
  'MISSING_MEDIA',
  'LEGACY_DIALECT',
  /* E05-P1 关键帧（`keyframes.mjs`）：五条拒绝 + 静态冲突，各一个稳定码。 */
  'KF_TOO_SHORT',
  'KF_ORDER',
  'KF_PROPS_MISMATCH',
  'KF_NOT_INTERPOLABLE',
  'KF_OUT_OF_RANGE',
  'KF_STATIC_CONFLICT',
  /* E05-P3 前置（R15）：文本样式的四个新键，各一个稳定拒绝码。 */
  'STROKE_INVALID',
  'BG_INVALID',
  'ALIGN_INVALID',
  'TRACKING_INVALID',
]);

/** @typedef {typeof DIAGNOSTIC_CODES[number]} DiagnosticCode */
/** @typedef {{ code: DiagnosticCode, message: string, severity: 'error'|'warning', path?: string, clipId?: string }} Diagnostic */
/** @typedef {{ x: number, y: number, w: number, h: number, r?: number }} Box */
/** @typedef {{ t: number, style: Record<string, string>, ease?: string }} Keyframe 关键帧：`t` 是**秒**、相对片段起点（与 OverrideEntry.t 的「文本」无关） */
/** @typedef {{ color: string, width?: number }} StrokeStyle 描边：颜色 + 宽度（px，0–64，缺省 1） */
/** @typedef {{ color: string, padX?: number, padY?: number, radius?: number }} BoxBgStyle 底框：底色 + 内边距/圆角（px，0–200） */
/** @typedef {{ at?: string, n?: number, t?: string, s?: number[], r?: number, style?: Record<string, string>, lock?: true, text?: string, fade?: number[], kf?: Keyframe[], stroke?: StrokeStyle, bg?: BoxBgStyle, align?: 'left'|'center'|'right'|'justify', tracking?: number }} OverrideEntry 文本样式四键（stroke/bg/align/tracking）的取值规则在 `text-style.mjs` */
/** @typedef {{ id: string, src: string, kind?: string, text?: string, sound?: true, at?: number, time?: number[], speed?: number, volume?: number, muted?: true, size?: { w: number, h: number }, box?: Box, style?: string, class?: string, overrides?: OverrideEntry[], link?: string, fade?: number[], attrs?: Record<string, string> }} Clip */
/** @typedef {{ index: number, role: string, name?: string, locked?: boolean, hidden?: boolean, muted?: boolean, attrs?: Record<string, string>, clips: Clip[] }} Track */
/** @typedef {{ stage: { w: number, h: number }, fps: { num: number, den: number }, tracks: Track[], sourceHash: string }} FilmDoc */
/** @typedef {{ name: string, value: string, nameStart: number, nameEnd: number, valueStart: number, valueEnd: number, quoted: boolean, quote: string }} FilmAttr */
/** @typedef {{ start: number, tagEnd: number, end: number, attrs: Map<string, FilmAttr> }} TagRef */
/** @typedef {{ clipId: string, name: string, trackIndex: number, innerStart: number, innerEnd: number, innerText: string } & TagRef} ElementRef */
/** @typedef {{ index: number } & TagRef} SectionRef */
/** @typedef {{ doc: FilmDoc|null, diagnostics: Diagnostic[], sourceHash: string }} ParseResult */
/** @typedef {{ doc: FilmDoc|null, diagnostics: Diagnostic[], sourceHash: string, elements: Map<string, ElementRef>, sections: SectionRef[], viewport: TagRef|null, headInsertAt: number }} Analysis */

/** 标签 → 片段类型（唯一映射，与合同 `KIND_OF_TAG` 一致）。
 *
 * E12-P3：文本片段。合法写法是 `<div>`；`<text>` 只是解析别名（手写/SVG 习惯），
 * 写回统一成 `<div>`（见 `TAG_OF_KIND.text`）。两条都留是因为判据 B1 逐个比标签表的**键**。
 *
 * **两份白名单同改**（合同 `contracts/film-doc.ts` 的 `KIND_OF_TAG` / `TAG_OF_KIND`）：
 * 只改这里，`write()` 找不到反向标签会退回 `?? 'video'`，文本片段被写成 `<video>`。
 *
 * ⚠️ 这两个对象字面量里**不要写注释**：量具 `s190` 用 `/\{([^}]*)\}/` 抠键，
 * 行内注释会被当成一个键（踩过一次）。
 */
export const KIND_OF_TAG = Object.freeze({
  iframe: 'page',
  video: 'video',
  img: 'still',
  audio: 'sound',
  div: 'text',
  text: 'text',
});
/** 片段类型 → 标签。 */
export const TAG_OF_KIND = Object.freeze({ page: 'iframe', video: 'video', still: 'img', sound: 'audio', text: 'div' });

/** 片段核心属性（**不带 `data-` 前缀**）。 */
const CLIP_ATTRIBUTES = new Set(['id', 'src', 'at', 'speed', 'volume', 'muted', 'size', 'class', 'style', 'overrides']);
/** Studio 自有、原样保留的属性。 */
const KEPT_ATTRIBUTE = /^(data-[a-z0-9-]+|aria-[a-z]+)$/;
/** 轨道（section）上对影片无意义、原样保留的属性。 */
const KEPT_TRACK_ATTRIBUTE = /^(id|class|title|lang|dir|data-[a-z0-9-]+|aria-[a-z]+)$/;
const TRACK_FLAGS = ['hidden', 'muted', 'locked'];

/**
 * v1.1.0 的旧方言属性名。**分段拼出来**：仓库里不允许出现这些字面量（`git grep` 验收），
 * 但它们仍必须被识别、被明确拒绝，并告诉调用方正确写法。
 */
export const LEGACY_ATTRIBUTES = Object.freeze(
  ['clip', 'track', 'src', 'at', 'time', 'fade', 'box', 'overrides'].map((name) => `data-${name}`),
);
const LEGACY_SET = new Set(LEGACY_ATTRIBUTES);

/** `style` 里决定画面位置的声明。 */
const BOX_OF_PROP = { left: 'x', top: 'y', width: 'w', height: 'h', rotate: 'r' };
/**
 * 层覆盖条目允许的字段（`layers.ts`）。`kf` 是关键帧序列（E05-P1）；
 * `stroke` / `bg` / `align` / `tracking` 是文本样式（E05-P3 前置，取值规则见
 * `text-style.mjs`）。**`ops.mjs` 里还有一份同源的白名单**，加字段必须同时加——
 * 测试 `override-keys-parity.test.mjs` 会直接比对两个集合。
 */
export const OVERRIDE_KEYS = new Set([
  'at', 'n', 't', 's', 'r', 'style', 'lock', 'text', 'kf',
  'stroke', 'bg', 'align', 'tracking',
]);

const RAW_TEXT = new Set(['script', 'style', 'title', 'textarea', 'xmp', 'noscript']);
const VOID_TAGS = new Set(['img', 'meta', 'link', 'br', 'hr', 'base', 'input', 'source', 'track', 'area', 'embed', 'param', 'wbr']);

const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi']);
const SOUND_EXT = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus']);
const PAGE_EXT = new Set(['html', 'htm']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'svg']);

/** @param {string} text @returns {string} */
export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** @param {string} src @returns {string} */
function extOf(src) {
  const bare = src.split(/[?#]/)[0] ?? '';
  return bare.slice(bare.lastIndexOf('.') + 1).toLowerCase();
}

/**
 * 文件类型（不看标签）。`clipKindOf` 在 ops.mjs 里，另有一份同样的判定给 Op 用。
 * @param {string} src @returns {'page'|'still'|'video'|'sound'|null}
 */
export function kindOfSrc(src) {
  if (typeof src !== 'string' || src === '') return null;
  const ext = extOf(src);
  if (PAGE_EXT.has(ext)) return 'page';
  if (IMAGE_EXT.has(ext)) return 'still';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (SOUND_EXT.has(ext)) return 'sound';
  return null;
}

/* ── 词法 ── */

/**
 * 把文件切成 token：开/闭标签、注释、文本、声明。位置全部是原文字节下标。
 * @param {string} text
 */
function tokenize(text) {
  /** @type {any[]} */
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      tokens.push({ type: 'text', start: i, end: text.length, text: text.slice(i) });
      break;
    }
    if (lt > i) tokens.push({ type: 'text', start: i, end: lt, text: text.slice(i, lt) });

    if (text.startsWith('<!--', lt)) {
      const close = text.indexOf('-->', lt + 4);
      const end = close < 0 ? text.length : close + 3;
      tokens.push({ type: 'comment', start: lt, end });
      i = end;
      continue;
    }
    if (text.startsWith('<!', lt)) {
      const close = text.indexOf('>', lt + 2);
      const end = close < 0 ? text.length : close + 1;
      tokens.push({ type: 'doctype', start: lt, end });
      i = end;
      continue;
    }
    if (text.startsWith('</', lt)) {
      let j = lt + 2;
      while (j < text.length && !isTagNameEnd(text.charAt(j))) j += 1;
      const name = text.slice(lt + 2, j).toLowerCase();
      const gt = text.indexOf('>', j);
      const end = gt < 0 ? text.length : gt + 1;
      tokens.push({ type: 'close', name, start: lt, end });
      i = end;
      continue;
    }
    if (!/[a-zA-Z]/.test(text.charAt(lt + 1))) {
      tokens.push({ type: 'text', start: lt, end: lt + 1, text: '<' });
      i = lt + 1;
      continue;
    }

    let j = lt + 1;
    while (j < text.length && !isTagNameEnd(text.charAt(j))) j += 1;
    const name = text.slice(lt + 1, j).toLowerCase();
    const nameEnd = j;
    /** @type {FilmAttr[]} */
    const attrs = [];
    let selfClose = false;
    while (j < text.length) {
      while (j < text.length && isSpace(text.charAt(j))) j += 1;
      if (j >= text.length) break;
      const ch = text.charAt(j);
      if (ch === '>') {
        j += 1;
        break;
      }
      if (ch === '/') {
        selfClose = text.charAt(j + 1) === '>';
        j += selfClose ? 2 : 1;
        break;
      }
      const nameStart = j;
      while (j < text.length) {
        const c = text.charAt(j);
        if (isSpace(c) || c === '>' || c === '/' || c === '=') break;
        j += 1;
      }
      const attrName = text.slice(nameStart, j);
      if (attrName === '') {
        j += 1;
        continue;
      }
      const nameStop = j;
      let valueStart = nameStop;
      let valueEnd = nameStop;
      let quoted = false;
      let quote = '"';
      let k = j;
      while (k < text.length && isSpace(text.charAt(k))) k += 1;
      if (text.charAt(k) === '=') {
        k += 1;
        while (k < text.length && isSpace(text.charAt(k))) k += 1;
        const q = text.charAt(k);
        if (q === '"' || q === "'") {
          quoted = true;
          quote = q;
          valueStart = k + 1;
          const close = text.indexOf(q, valueStart);
          if (close < 0) {
            valueEnd = text.length;
            k = text.length;
          } else {
            valueEnd = close;
            k = close + 1;
          }
        } else {
          valueStart = k;
          while (k < text.length) {
            const c = text.charAt(k);
            if (isSpace(c) || c === '>') break;
            k += 1;
          }
          valueEnd = k;
        }
      }
      attrs.push({
        name: attrName,
        value: decodeEntities(text.slice(valueStart, valueEnd)),
        nameStart,
        nameEnd: nameStop,
        valueStart,
        valueEnd,
        quoted,
        quote,
      });
      j = k;
    }
    tokens.push({ type: 'open', name, nameEnd, attrs, selfClose, start: lt, end: j });
    i = j;

    // script/style/title 的内部是文本，不按标签切（CSS 里的 `<` 不该被当成元素）。
    if (RAW_TEXT.has(name) && !selfClose) {
      const close = findCloseTag(text, name, j);
      if (close < 0) continue;
      if (close > j) tokens.push({ type: 'text', start: j, end: close, text: text.slice(j, close) });
      const gt = text.indexOf('>', close);
      const end = gt < 0 ? text.length : gt + 1;
      tokens.push({ type: 'close', name, start: close, end });
      i = end;
    }
  }
  return tokens;
}

/**
 * 解析入口（合同签名）。
 * @param {string} text
 * @param {{ path?: string, native?: Readonly<Record<string, number|null>>, fps?: { num: number, den: number }|number|string }} [opts]
 * @returns {ParseResult}
 */
export function parse(text, opts = {}) {
  const result = analyze(text, opts);
  return { doc: result.doc, diagnostics: result.diagnostics, sourceHash: result.sourceHash };
}

/**
 * 解析并保留标签区间，供写回做 layout patch。
 * @param {string} text
 * @param {{ path?: string, native?: Readonly<Record<string, number|null>>, fps?: { num: number, den: number }|number|string }} [opts]
 * @returns {Analysis}
 */
export function analyze(text, opts = {}) {
  const sourceHash = sha256(text);
  const path = typeof opts.path === 'string' ? opts.path : '<inline>';
  /** @type {Diagnostic[]} */
  const diagnostics = [];
  const native = opts.native ?? {};

  /**
   * @param {DiagnosticCode} code
   * @param {string} message
   * @param {{ offset?: number, clipId?: string, severity?: 'error'|'warning' }} [extra]
   */
  const report = (code, message, extra = {}) => {
    /** @type {Diagnostic} */
    const diag = {
      code,
      message: extra.offset === undefined ? `${path}: ${message}` : `${path}:${lineAt(text, extra.offset)}: ${message}`,
      severity: extra.severity ?? 'error',
      path,
    };
    if (extra.clipId !== undefined) diag.clipId = extra.clipId;
    diagnostics.push(diag);
  };

  const tokens = tokenize(text);

  // 1. 旧方言：任何标签上的 `data-` 片段/轨道属性都先被认出来并拒绝（含旧舞台 div）。
  /** @type {Set<number>} */
  const legacyTokens = new Set();
  tokens.forEach((token, index) => {
    if (token.type !== 'open') return;
    for (const attr of token.attrs) {
      const key = attr.name.toLowerCase();
      if (!LEGACY_SET.has(key)) continue;
      legacyTokens.add(index);
      report(
        'LEGACY_DIALECT',
        `旧方言 ${attr.name}：v1.2.0 的 <${token.name}> 直接写 ${legacyHint(token.name, key)}，不带 data- 前缀`,
        { offset: attr.nameStart },
      );
    }
  });

  // 2. head：viewport → stage；记住 head 里的插入点（没有 viewport 时写 stage 要用）。
  let headOpen = -1;
  let headClose = -1;
  let bodyOpen = -1;
  let bodyClose = -1;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === 'open' && token.name === 'head' && headOpen < 0) headOpen = index;
    else if (token.type === 'close' && token.name === 'head' && headClose < 0) headClose = index;
    else if (token.type === 'open' && token.name === 'body' && bodyOpen < 0) bodyOpen = index;
    else if (token.type === 'close' && token.name === 'body' && bodyClose < 0) bodyClose = index;
  }

  /** @type {{ w: number, h: number }} */
  let stage = { w: 1920, h: 1080 };
  /** @type {TagRef|null} */
  let viewport = null;
  let headInsertAt = 0;
  if (headOpen >= 0) {
    headInsertAt = tokens[headOpen].end;
    const stop = headClose < 0 ? tokens.length : headClose;
    for (let index = headOpen + 1; index < stop; index += 1) {
      const token = tokens[index];
      if (token.type !== 'open' || token.name !== 'meta') continue;
      const map = attrMapOf(token);
      if (getAttr(map, 'name').toLowerCase() !== 'viewport') {
        if (map.has('charset') && headInsertAt === tokens[headOpen].end) headInsertAt = token.end;
        continue;
      }
      const content = getAttr(map, 'content');
      const width = Number(/(?:^|[,;\s])width\s*=\s*(\d+)/i.exec(content)?.[1]);
      const height = Number(/(?:^|[,;\s])height\s*=\s*(\d+)/i.exec(content)?.[1]);
      if (!(width > 0 && height > 0)) {
        report('BAD_STAGE', `viewport 的 content 必须是 width=W, height=H：${content || '(空)'}`, { offset: token.start });
      } else if (!isStageSize(width) || !isStageSize(height)) {
        report('BAD_STAGE', `舞台尺寸非法：${width}x${height}（偶数，16..8192）`, { offset: token.start });
      } else {
        stage = { w: width, h: height };
        viewport = { start: token.start, tagEnd: token.end, end: token.end, attrs: map };
      }
    }
  } else if (bodyOpen >= 0) {
    headInsertAt = tokens[bodyOpen].start;
  }

  const fps = normalizeFps(opts.fps);

  // 3. body：只有 section，section 里只有片段。
  /** @type {Track[]} */
  const tracks = [];
  /** @type {SectionRef[]} */
  const sections = [];
  /** @type {Map<string, ElementRef>} */
  const elements = new Map();
  /** @type {Set<string>} */
  const seenIds = new Set();

  // 没有 <body> 的片段式输入：从 head 之后（或文件头）开始，结构标签在循环里忽略。
  const bodyStartIndex = bodyOpen >= 0 ? bodyOpen + 1 : headClose >= 0 ? headClose + 1 : headOpen >= 0 ? headOpen : 0;
  const bodyEndIndex = bodyClose >= 0 ? bodyClose : tokens.length;
  let section = null;
  /** @type {SectionRef|null} */
  let sectionRef = null;

  for (let index = bodyStartIndex; index < bodyEndIndex; index += 1) {
    const token = tokens[index];
    if (token.type === 'open' && (token.name === 'html' || token.name === 'head' || token.name === 'body')) continue;
    if (token.type === 'close' && (token.name === 'html' || token.name === 'head' || token.name === 'body')) continue;
    if (token.type === 'text') {
      if (String(token.text).trim() !== '') {
        report('UNKNOWN_ELEMENT', `body 里的文字「${String(token.text).trim().slice(0, 40)}」不属于任何片段；屏幕上的字是网页片段（<iframe>）`, {
          offset: token.start,
        });
      }
      continue;
    }
    if (token.type === 'comment' || token.type === 'doctype') continue;

    if (token.type === 'close') {
      if (token.name === 'section') {
        if (section === null) {
          report('UNKNOWN_ELEMENT', '多余的 </section>', { offset: token.start });
        } else {
          section = null;
          if (sectionRef !== null) sectionRef.end = token.end;
          sectionRef = null;
        }
        continue;
      }
      if (token.name === 'body' || token.name === 'html') continue;
      report('UNKNOWN_ELEMENT', `body 里的 </${token.name}> 没有对应开标签`, { offset: token.start });
      continue;
    }

    if (token.type !== 'open') continue;

    // 旧方言元素：已经在第 1 步报过，这里连它的内容一起跳过（不重复刷屏、也不制造假的错配）。
    if (legacyTokens.has(index)) {
      index = skipElement(tokens, index);
      continue;
    }

    if (token.name === 'section') {
      if (section !== null) {
        report('UNKNOWN_ELEMENT', '<section> 不能嵌套：轨道就是 body 的直接子元素', { offset: token.start });
        continue;
      }
      const map = attrMapOf(token);
      /** @type {Track} */
      const track = { index: tracks.length, role: 'picture', clips: [] };
      for (const attr of map.values()) {
        const key = attr.name.toLowerCase();
        if (TRACK_FLAGS.includes(key)) {
          if (attr.value === '' || attr.value === 'true') track[/** @type {'hidden'|'muted'|'locked'} */ (key)] = true;
          continue;
        }
        if (KEPT_TRACK_ATTRIBUTE.test(key)) {
          // 对影片无意义的属性（id/class/title/data-* …）原样保留，整段重写时也照抄。
          track.attrs = { ...(track.attrs ?? {}), [key]: attr.value };
          continue;
        }
        report('UNKNOWN_ATTRIBUTE', `<section> 不认识属性 ${attr.name}：轨道只认 hidden/muted/locked（id/class/title/lang/dir/data-*/aria-* 原样保留）`, {
          offset: attr.nameStart,
        });
      }
      const name = getAttr(map, 'id') || getAttr(map, 'title') || getAttr(map, 'class');
      if (name !== '') track.name = name;
      tracks.push(track);
      section = track;
      /** @type {SectionRef} */
      const ref = { index: track.index, start: token.start, tagEnd: token.end, end: text.length, attrs: map };
      sections.push(ref);
      sectionRef = ref;
      continue;
    }

    const kind = /** @type {any} */ (KIND_OF_TAG)[token.name];
    if (kind !== undefined) {
      if (section === null) {
        report('TRACK_ROLE_CONFLICT', `<${token.name}> 不在任何 <section> 里：每个片段都在一条轨道（section）中`, {
          offset: token.start,
        });
        index = skipElement(tokens, index);
        continue;
      }
      const end = elementEndIndex(tokens, index, token.name) ?? tokens.length - 1;
      const closeToken = tokens[end];
      const stop = end;

      const parsed = buildClip(token, kind, {
        report,
        native,
        tag: token.name,
        /* 文本片段（E12-P3）的内容就在元素里：取 innerText，子元素另行报错。 */
        ...(kind === 'text' ? harvestTextContent(tokens, index, stop) : { insideProblem: findHeldContent(tokens, index, stop) }),
      });
      if (parsed !== null) {
        if (seenIds.has(parsed.id)) {
          report('DUPLICATE_CLIP_ID', `片段 id 重复：${parsed.id}`, { offset: token.start, clipId: parsed.id });
        } else {
          seenIds.add(parsed.id);
          section.clips.push(parsed);
          /* 文本片段改内容要替换元素内部的那一段（属性区不动）：把内文区间一起记下来。 */
          const innerStart = token.end;
          const innerEnd = closeToken !== undefined && closeToken.type === 'close' ? closeToken.start : token.end;
          elements.set(parsed.id, {
            clipId: parsed.id,
            name: token.name,
            trackIndex: section.index,
            start: token.start,
            tagEnd: token.end,
            end: closeToken !== undefined && closeToken.type === 'close' ? closeToken.end : token.end,
            innerStart,
            innerEnd,
            innerText: text.slice(innerStart, innerEnd),
            attrs: attrMapOf(token),
          });
        }
      }
      index = stop;
      continue;
    }

    if (token.name === 'script' || token.name === 'style') {
      report('UNKNOWN_ELEMENT', `film.html 的 body 里不放 <${token.name}>：会动的是网页片段（<iframe src="…">），样式放 <head>`, {
        offset: token.start,
      });
      index = skipElement(tokens, index);
      continue;
    }

    report('UNKNOWN_ELEMENT', `body 里只放轨道：<${token.name}> 不是轨道（<section>）也不是片段（<iframe>/<video>/<img>/<audio>）`, {
      offset: token.start,
    });
    index = skipElement(tokens, index);
  }

  if (section !== null) {
    report('UNKNOWN_ELEMENT', '<section> 没有 </section>', { offset: sectionRef === null ? 0 : (/** @type {SectionRef} */ (sectionRef)).start });
    if (sectionRef !== null) /** @type {SectionRef} */ (sectionRef).end = text.length;
  }

  for (const track of tracks) track.role = roleOf(track.clips);

  const hasError = diagnostics.some((diag) => diag.severity === 'error');
  /** @type {FilmDoc|null} */
  const doc = hasError ? null : { stage, fps, tracks, sourceHash };

  return { doc, diagnostics, sourceHash, elements, sections, viewport, headInsertAt };
}

/**
 * @param {any} token
 * @param {string} kind
 * @param {{
 *   report: (code: DiagnosticCode, message: string, extra?: { offset?: number, clipId?: string, severity?: 'error'|'warning' }) => void,
 *   native: Readonly<Record<string, number|null>>,
 *   tag: string,
 *   insideProblem?: string|null,
 *   text?: string,
 * }} input
 * @returns {Clip|null}
 */
function buildClip(token, kind, input) {
  const { report, native, tag } = input;
  const insideProblem = input.insideProblem ?? null;
  const isText = kind === 'text';
  const map = attrMapOf(token);
  const offset = token.start;

  if (insideProblem !== null) {
    report('UNKNOWN_ELEMENT', `<${tag}> 里什么都不放：${insideProblem}`, { offset });
    return null;
  }

  const id = getAttr(map, 'id');
  if (id === '') {
    report('MISSING_MEDIA', `<${tag}> 缺少 id：每个片段都要有一个全片唯一的名字`, { offset });
    return null;
  }
  if (/\s/.test(id)) {
    report('UNKNOWN_FIELD', `片段 id 不能含空白：${id}`, { offset, clipId: id });
    return null;
  }

  /** @type {Clip} */
  const clip = { id, src: '', kind };
  /** 文本片段的 `time` 属性（可见区间）：等所有属性读完再和 `src#t=` 对账。 */
  let attrTime = null;

  for (const attr of map.values()) {
    const key = attr.name.toLowerCase();
    if (key === 'id') continue;
    /* 文本片段没有媒体文件，`time` 是它唯一的区间写法（等价于 `src` 的 `#t=`）。
       其它片段仍然只认 `src#t=`：合同 §4「没有 time 属性」。 */
    if (key === 'time' && isText) {
      const range = parseTimeAttribute(attr.value);
      if (range === null) {
        report('BAD_TIME', `文本片段 ${id} 的 time 是「起点,终点」秒数：${attr.value || '(空)'}`, { offset: attr.nameStart, clipId: id });
      } else {
        attrTime = range;
      }
      continue;
    }
    if (!CLIP_ATTRIBUTES.has(key)) {
      // `data-link` 是 `Clip.link` 的来源（Studio 自有）；其余 data-*/aria-* 原样保留。
      if (key === 'data-link') {
        if (attr.value !== '') clip.link = attr.value;
        continue;
      }
      if (KEPT_ATTRIBUTE.test(key)) {
        clip.attrs = { ...(clip.attrs ?? {}), [key]: attr.value };
        continue;
      }
      report('UNKNOWN_ATTRIBUTE', `片段 ${id} 不认识属性 ${attr.name}${attributeHint(key)}`, { offset: attr.nameStart, clipId: id });
      continue;
    }

    if (key === 'src') {
      const hash = attr.value.indexOf('#');
      const path = hash < 0 ? attr.value : attr.value.slice(0, hash);
      clip.src = path;
      if (hash >= 0) {
        const fragment = parseFragment(attr.value.slice(hash + 1));
        if (fragment === null) {
          report('BAD_TIME', `片段 ${id} 的 src 片段写法是 #t=in,out 或 #t=in：${attr.value.slice(hash)}`, { offset: attr.nameStart, clipId: id });
        } else {
          clip.time = fragment;
        }
      }
      continue;
    }
    if (key === 'muted') {
      clip.muted = true;
      continue;
    }
    if (key === 'class') {
      if (attr.value.trim() !== '') clip.class = attr.value.trim().split(/\s+/).join(' ');
      continue;
    }
    if (key === 'size') {
      const match = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i.exec(attr.value);
      if (match === null) {
        report('UNKNOWN_ATTRIBUTE', `片段 ${id} 的 size 是网页片段的像素尺寸，形如 size="1920x1080"：${attr.value}`, {
          offset: attr.nameStart,
          clipId: id,
        });
        continue;
      }
      clip.size = { w: Number(match[1]), h: Number(match[2]) };
      continue;
    }
    if (key === 'style') {
      const parsed = parseStyle(attr.value, id, attr.nameStart, report);
      if (parsed.box !== undefined) clip.box = parsed.box;
      if (parsed.rest !== '') clip.style = parsed.rest;
      continue;
    }
    if (key === 'overrides') {
      const parsed = parseOverrides(attr.value, id, attr.nameStart, report);
      if (parsed !== null) {
        clip.overrides = parsed;
        const own = parsed.find((entry) => entry.at === undefined);
        if (own !== undefined && own.fade !== undefined) {
          const fade = own.fade;
          if (!Array.isArray(fade) || fade.length !== 2 || !fade.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) {
            report('UNKNOWN_FIELD', `片段 ${id} 的自有覆盖里 fade 必须是 [in, out] 两个非负秒数`, { offset: attr.nameStart, clipId: id });
          } else {
            clip.fade = [Number(fade[0]), Number(fade[1])];
          }
        }
      }
      continue;
    }
    if (key === 'at' || key === 'speed' || key === 'volume') {
      const value = parseSeconds(attr.value);
      if (value === null || !Number.isFinite(value)) {
        report(key === 'speed' ? 'BAD_SPEED' : 'BAD_TIME', `片段 ${id} 的 ${key} 是数字：${attr.value || '(空)'}`, {
          offset: attr.nameStart,
          clipId: id,
        });
        continue;
      }
      if (key === 'at') {
        if (value < 0) report('BAD_TIME', `片段 ${id} 的 at 不能为负：${value}`, { offset: attr.nameStart, clipId: id });
        else clip.at = value;
      } else if (key === 'speed') {
        if (value <= 0) report('BAD_SPEED', `片段 ${id} 的 speed 必须大于 0：${value}`, { offset: attr.nameStart, clipId: id });
        else clip.speed = value;
      } else {
        if (value < 0) report('UNKNOWN_FIELD', `片段 ${id} 的 volume 不能为负：${value}`, { offset: attr.nameStart, clipId: id });
        else clip.volume = value;
      }
    }
  }

  if (isText) {
    /* 空内容不落 `text` 键：`<div id="x" time="0,2"></div>` 与「没有内容的文本片段」是同一件事，
       否则「写一次」会多出一个空键，写回校验自己跟自己不一致。 */
    const body = typeof input.text === 'string' ? input.text : '';
    if (body !== '') clip.text = body;
    if (attrTime !== null) {
      if (Array.isArray(clip.time) && (Number(clip.time[0]) !== Number(attrTime[0]) || Number(clip.time[1] ?? -1) !== Number(attrTime[1] ?? -1))) {
        report('BAD_TIME', `文本片段 ${id} 的 time 与 src 的 #t= 写了两套不同的区间：只保留一处`, { offset, clipId: id });
      } else {
        clip.time = attrTime;
      }
    }
  } else if (clip.src === '') {
    report('MISSING_MEDIA', `片段 ${id} 缺少 src（相对工程目录的文件路径）`, { offset, clipId: id });
    return null;
  }

  /* 文本片段的 src 指向它挂靠的页面（`scenes/intro.html`），按扩展名会算成 page —— 跳过类型核对。 */
  const actual = isText ? null : kindOfSrc(clip.src);
  if (kind === 'sound' && actual === 'video') clip.sound = true;
  else if (actual !== null && actual !== kind) {
    report(
      'UNKNOWN_ELEMENT',
      `<${tag}> 装不下 ${clip.src}（那是 ${actual === 'page' ? '网页' : actual === 'still' ? '图片' : actual === 'video' ? '视频' : '声音'}，用 <${TAG_OF_KIND[actual]}>）`,
      { offset, clipId: id },
    );
    return null;
  }

  if (Array.isArray(clip.time)) {
    const nativeDuration = lookupNative(native, clip.src) ?? declaredNative(clip.attrs, id, offset, report);
    const from = Number(clip.time[0]);
    const range = clip.time.length === 2 ? { from, to: Number(clip.time[1]) } : { from, to: from };
    if (clip.time.length === 2) {
      const problem = validateRange(range, nativeDuration);
      if (problem !== null) {
        report(problem.code, `片段 ${id}：${problem.message}`, { offset, clipId: id });
      }
    } else if (from < 0) {
      report('BAD_TIME', `片段 ${id} 的 src 片段不能为负：${from}`, { offset, clipId: id });
    }
  } else if (kind === 'page') {
    report('PAGE_WITHOUT_DURATION', `网页片段 ${id} 没有 #t=：它会在整段时间线上一直显示`, {
      offset,
      clipId: id,
      severity: 'warning',
    });
  }

  /* E05-P1：kf 的越界与跨条目静态冲突要看 `time`/`speed`，只能放到属性都解析完之后。 */
  checkKeyframeRanges(clip, id, offset, report);

  return clip;
}

/**
 * `style` 拆成 box + 其余声明（其余原样保留、不诊断）。
 * @param {string} value
 * @param {string} id
 * @param {number} offset
 * @param {(code: DiagnosticCode, message: string, extra?: { offset?: number, clipId?: string, severity?: 'error'|'warning' }) => void} report
 */
function parseStyle(value, id, offset, report) {
  /** @type {Record<string, string>} */
  const rest = {};
  /** @type {Box|undefined} */
  let box;
  for (const [prop, raw] of declarations(value)) {
    const mapped = BOX_OF_PROP[/** @type {keyof typeof BOX_OF_PROP} */ (prop)];
    if (mapped === undefined) {
      rest[prop] = raw;
      continue;
    }
    const number = amount(raw, prop === 'rotate' ? 'deg' : 'px');
    if (number === null) {
      report('UNKNOWN_FIELD', `片段 ${id} 的 style 里 ${prop} 是${prop === 'rotate' ? '角度，形如 8deg' : '像素，形如 120px'}：${raw}`, {
        offset,
        clipId: id,
      });
      continue;
    }
    box = box ?? { x: 0, y: 0, w: 0, h: 0 };
    /** @type {any} */ (box)[mapped] = number;
  }
  let text = '';
  for (const [prop, raw] of Object.entries(rest)) text += `${text === '' ? '' : '; '}${prop}: ${raw}`;
  return { box, rest: text };
}

/**
 * 一条层覆盖上的 `kf`：结构四拒 + 「同一属性两处都有」的静态冲突。
 *
 * 越界（`KF_OUT_OF_RANGE`）要等片段的 `#t=`/`speed` 都落定才知道时长 ——
 * 片段属性在 `buildClip` 里是按文件顺序遍历的，`overrides` 可能排在 `src` 前面，
 * 所以那一条放到 `checkKeyframeRanges()`（`buildClip` 末尾）去做。
 *
 * 校验不过的条目**不并进** `clip.overrides`：与「未知字段的条目」同一条原则 ——
 * 文件既然有错，就不要把半截模型交给下游，等渲染时才发现。
 * @param {any} entry
 * @param {string} id
 * @param {number} offset
 * @param {(code: any, message: string, extra?: { offset?: number, clipId?: string }) => void} report
 * @returns {boolean} 这条能不能并入
 */
function checkEntryKeyframes(entry, id, offset, report) {
  if (entry.kf === undefined) return true;
  const at = typeof entry.at === 'string' ? entry.at : '';
  const verdict = validateKeyframeList(entry.kf, { at });
  if (!verdict.ok) {
    report(verdict.code, `片段 ${id} 的层覆盖 ${at}：${verdict.message}`, { offset, clipId: id });
    return false;
  }
  const clash = Object.keys(entry.kf[0].style).filter((prop) => staticPropsOf(entry).has(prop));
  if (clash.length > 0) {
    report(
      'KF_STATIC_CONFLICT',
      `片段 ${id} 的层覆盖 ${at}：${clash.join(',')} 同时有静态覆盖与关键帧（写盘前必须二选一，不能留到渲染时才发现）`,
      { offset, clipId: id },
    );
    return false;
  }
  return true;
}

/**
 * `kf` 的越界 + 跨条目静态冲突（同一 `at` 拆成两条：一条 `style`、一条 `kf`）。
 *
 * 时长口径：只有 `#t=in,out` 才**算得出**片段时长 `(out-in)/speed`；
 * `#t=in`（表示到结尾）与整段素材没写 `#t=` 都是「未知」，此时**不判越界** ——
 * 拿 0 冒充时长会把合法文件判红（`time.mjs` 的 `clipDuration` 就是这么约定的）。
 * @param {Clip} clip
 * @param {string} id
 * @param {number} offset
 * @param {(code: any, message: string, extra?: { offset?: number, clipId?: string }) => void} report
 */
function checkKeyframeRanges(clip, id, offset, report) {
  const entries = Array.isArray(clip.overrides) ? clip.overrides : [];
  /** @type {Map<string, {style: Set<string>, kf: Set<string>}>} */
  const byAt = new Map();
  for (const entry of entries) {
    if (typeof entry.at !== 'string' || entry.at === '') continue;
    const slot = byAt.get(entry.at) ?? { style: new Set(), kf: new Set() };
    for (const prop of staticPropsOf(entry)) slot.style.add(prop);
    if (Array.isArray(entry.kf) && entry.kf.length > 0) {
      const first = /** @type {Keyframe} */ (entry.kf[0]);
      for (const prop of Object.keys(first.style ?? {})) slot.kf.add(prop);
    }
    byAt.set(entry.at, slot);
  }
  for (const [at, slot] of byAt) {
    const both = [...slot.style].filter((prop) => slot.kf.has(prop));
    if (both.length > 0) {
      report(
        'KF_STATIC_CONFLICT',
        `片段 ${id} 的层覆盖 ${at}：${both.join(',')} 在静态覆盖与关键帧里各出现一次（同一 at 的多条条目也算同一元素）`,
        { offset, clipId: id },
      );
    }
  }

  const withKf = entries.filter((entry) => typeof entry.at === 'string' && Array.isArray(entry.kf) && entry.kf.length > 0);
  if (withKf.length === 0) return;
  const range = Array.isArray(clip.time) && clip.time.length === 2 ? { from: Number(clip.time[0]), to: Number(clip.time[1]) } : null;
  const duration = clipDuration(range, typeof clip.speed === 'number' && clip.speed > 0 ? clip.speed : 1);
  if (duration === null || !Number.isFinite(duration)) return;
  for (const entry of withKf) {
    const verdict = validateKeyframeList(entry.kf, { at: entry.at, duration });
    if (!verdict.ok) report(verdict.code, `片段 ${id} 的层覆盖 ${entry.at}：${verdict.message}`, { offset, clipId: id });
  }
}

/**
 * `overrides` 是 JSON 数组；最多一条没有 `at` 的条目（片段自有），带 `at` 的是层覆盖。
 * @param {string} raw
 * @param {string} id
 * @param {number} offset
 * @param {(code: DiagnosticCode, message: string, extra?: { offset?: number, clipId?: string, severity?: 'error'|'warning' }) => void} report
 * @returns {OverrideEntry[]|null}
 */
function parseOverrides(raw, id, offset, report) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    report('UNKNOWN_FIELD', `片段 ${id} 的 overrides 是 JSON 数组：读不出 JSON`, { offset, clipId: id });
    return null;
  }
  if (!Array.isArray(parsed)) {
    report('UNKNOWN_FIELD', `片段 ${id} 的 overrides 必须是数组`, { offset, clipId: id });
    return null;
  }
  /** @type {OverrideEntry[]} */
  const entries = [];
  let own = 0;
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      report('UNKNOWN_FIELD', `片段 ${id} 的 overrides 条目必须是对象`, { offset, clipId: id });
      continue;
    }
    const keys = Object.keys(entry);
    if (entry.at === undefined) {
      own += 1;
      if (own > 1) {
        report('UNKNOWN_FIELD', `片段 ${id} 的 overrides 里最多一条没有 at 的条目（片段自有）`, { offset, clipId: id });
        continue;
      }
      const bad = keys.filter((key) => key !== 'fade');
      if (bad.length > 0) {
        report('UNKNOWN_FIELD', `片段 ${id} 的自有覆盖含未知字段：${bad.join(',')}（目前只放 fade）`, { offset, clipId: id });
        continue;
      }
      if (entry.fade !== undefined && (!Array.isArray(entry.fade) || entry.fade.length !== 2)) {
        report('UNKNOWN_FIELD', `片段 ${id} 的 fade 必须是 [in, out]`, { offset, clipId: id });
        continue;
      }
      entries.push(/** @type {OverrideEntry} */ (entry));
      continue;
    }
    if (typeof entry.at !== 'string' || entry.at === '') {
      report('UNKNOWN_FIELD', `片段 ${id} 的层覆盖要有 at（选择器）`, { offset, clipId: id });
      continue;
    }
    const bad = keys.filter((key) => !OVERRIDE_KEYS.has(key));
    if (bad.length > 0) {
      report('UNKNOWN_FIELD', `片段 ${id} 的层覆盖含未知字段：${bad.join(',')}`, { offset, clipId: id });
      continue;
    }
    if (!checkEntryKeyframes(entry, id, offset, report)) continue;
    const textStyle = validateTextStyle(entry);
    if (!textStyle.ok) {
      report(textStyle.code, `片段 ${id} 的层覆盖 ${entry.at}：${textStyle.message}`, { offset, clipId: id });
      continue;
    }
    entries.push(/** @type {OverrideEntry} */ (entry));
  }
  return entries;
}

/* ── 写回：值 → 文本（layout patch） ── */

/**
 * 片段属性的规范顺序（新建元素时按它写）。
 * @param {Clip} clip
 * @returns {[string, string|null][]}
 */
export function clipAttributes(clip) {
  const isText = clipKindOf(clip) === 'text';
  /** @type {[string, string|null][]} */
  const list = [
    ['id', clip.id],
    /* 文本片段可以没有媒体文件：空 src 不写成一个裸属性（`src`），直接省略。 */
    ['src', !clip.src ? null : isText ? clip.src : srcText(clip)],
    ['at', clip.at === undefined ? null : numText(clip.at)],
    /* 文本片段的区间写在 `time` 属性里（没有 `src#t=` 可挂）；其它片段仍然不写 time。 */
    ['time', isText && Array.isArray(clip.time) && clip.time.length > 0 ? clip.time.map((one) => numText(Number(one))).join(',') : null],
    ['speed', clip.speed === undefined ? null : numText(clip.speed)],
    ['volume', clip.volume === undefined ? null : numText(clip.volume)],
    ['muted', clip.muted === true ? '' : null],
    ['size', clip.size === undefined ? null : `${clip.size.w}x${clip.size.h}`],
    ['class', clip.class ?? null],
    ['style', styleText(clip) === '' ? null : styleText(clip)],
    ['overrides', overridesText(clip)],
    ['data-link', clip.link ?? null],
  ];
  for (const [name, value] of Object.entries(clip.attrs ?? {})) {
    if (name === 'data-link') continue;
    if (name === 'data-native' || KEPT_ATTRIBUTE.test(name)) list.push([name, value]);
  }
  return list;
}

const MANAGED_CLIP_ATTRS = new Set([
  CLIP_DISABLED_ATTR,
  CLIP_MARKERS_ATTR,
  'data-opencut-transition',
  'id',
  'src',
  'at',
  'time',
  'speed',
  'volume',
  'muted',
  'size',
  'class',
  'style',
  'overrides',
  'data-link',
  'data-props',
]);

/** @param {Clip} clip */
function srcText(clip) {
  const time = clip.time;
  if (!Array.isArray(time) || time.length === 0) return clip.src;
  if (time.length === 1) return `${clip.src}#t=${numText(Number(time[0]))}`;
  return `${clip.src}#t=${numText(Number(time[0]))},${numText(Number(time[1]))}`;
}

/** @param {Clip} clip */
function styleText(clip) {
  /** @type {string[]} */
  const parts = [];
  const box = clip.box;
  if (box !== undefined) {
    parts.push(`left: ${numText(box.x)}px`, `top: ${numText(box.y)}px`);
    if (box.w) parts.push(`width: ${numText(box.w)}px`);
    if (box.h) parts.push(`height: ${numText(box.h)}px`);
    if (box.r) parts.push(`rotate: ${numText(box.r)}deg`);
  }
  if (typeof clip.style === 'string' && clip.style !== '') parts.push(clip.style);
  return parts.length === 0 ? '' : parts.join('; ');
}

/**
 * `overrides` 的落位：片段自有条目（fade）在前，层覆盖照旧。
 * @param {Clip} clip
 * @returns {OverrideEntry[]}
 */
export function derivedOverrides(clip) {
  /** @type {OverrideEntry[]} */
  const list = [];
  if (Array.isArray(clip.fade) && (Number(clip.fade[0]) > 0 || Number(clip.fade[1]) > 0)) {
    list.push({ fade: [Number(clip.fade[0]), Number(clip.fade[1])] });
  }
  for (const entry of clip.overrides ?? []) {
    if (entry !== null && typeof entry === 'object' && entry.at !== undefined) list.push(entry);
  }
  return list;
}

/** @param {Clip} clip */
function overridesText(clip) {
  const list = derivedOverrides(clip);
  return list.length === 0 ? null : JSON.stringify(list);
}

/** @param {number} value */
function numText(value) {
  const rounded = Math.round(Number(value) * 1000) / 1000;
  return String(rounded);
}

/* ── 值模型的键闸门（M77） ─────────────────────────────────────────────
 *
 * `writeValue` 只认「文件能表示的键」。以前多出来的键（比如直接塞在片段上的 `x`）
 * 会被静默丢掉，写回还回 ok:true —— 那不是宽容，是无声的数据丢失。现在：
 * 未知键 → INVALID 并指出字段路径；`x/y/w/h/r` 是 `box` 的简写，写回前归一化。
 */

const CLIP_VALUE_KEYS = new Set([
  'id',
  'src',
  'kind',
  /* E12-P3：文本片段的内容（元素内文），是「文件能表示的键」——不加进来会被键闸门判 INVALID。 */
  'text',
  'sound',
  'at',
  'time',
  'speed',
  'volume',
  'muted',
  'size',
  'box',
  'style',
  'overrides',
  'fade',
  'link',
  'attrs',
  'x',
  'y',
  'w',
  'h',
  'r',
]);
const TRACK_VALUE_KEYS = new Set(['index', 'role', 'name', 'locked', 'hidden', 'muted', 'clips', 'attrs', 'native']);
const DOC_VALUE_KEYS = new Set(['stage', 'fps', 'tracks', 'sourceHash']);
const BOX_VALUE_KEYS = new Set(['x', 'y', 'w', 'h', 'r']);
const BOX_ALIASES = ['x', 'y', 'w', 'h', 'r'];
/** 舞台的合法范围：与 ops 的 16..8192 不同，写回层只要求「1..8192 的整数」（方言里没有偶数约束）。 */
const STAGE_MIN = 1;
const STAGE_MAX = 8192;

/** 写回层的诊断：code 固定 INVALID，能指到字段就带 `field`。 @param {string} message @param {string} [field] */
function problem(message, field) {
  return field === undefined
    ? { code: 'INVALID', message, severity: 'error' }
    : { code: 'INVALID', message, field, severity: 'error' };
}

/** @param {any} clip @param {string} path @param {any[]} problems */
function normalizeBox(clip, path, problems) {
  const hasAlias = BOX_ALIASES.some((key) => Object.prototype.hasOwnProperty.call(clip, key));
  const raw = clip.box;
  if (raw === undefined && !hasAlias) return null;
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
    problems.push(problem(`${path}.box 必须是 {x,y,w,h[,r]}`, `${path}.box`));
    return null;
  }
  /** @type {any} */
  const source = { ...(raw ?? {}) };
  for (const key of BOX_ALIASES) {
    if (Object.prototype.hasOwnProperty.call(clip, key)) source[key] = clip[key];
  }
  for (const key of Object.keys(source)) {
    if (!BOX_VALUE_KEYS.has(key)) problems.push(problem(`box 上不允许出现字段 ${key}`, `${path}.box.${key}`));
  }
  /** @type {any} */
  const box = { x: 0, y: 0, w: 0, h: 0 };
  for (const key of ['x', 'y', 'w', 'h']) {
    if (source[key] === undefined || source[key] === null) continue;
    const num = Number(source[key]);
    if (!Number.isFinite(num)) {
      problems.push(problem(`${path}.box.${key} 必须是数值（收到 ${String(source[key])}）`, `${path}.box.${key}`));
      continue;
    }
    box[key] = num;
  }
  if (source.r !== undefined && source.r !== null) {
    const rotate = Number(source.r);
    if (!Number.isFinite(rotate)) {
      problems.push(problem(`${path}.box.r 必须是数值（收到 ${String(source.r)}）`, `${path}.box.r`));
    } else if (rotate !== 0) {
      // 0° 在 style 里不写（`if (box.r)`）——归一化时也丢掉，否则回读永远对不上。
      box.r = rotate;
    }
  }
  return box;
}

/**
 * 把调用方给的 FilmDoc 归一化成「文件能表示的形状」：
 * 校验 stage、拒绝未知键、把 `x/y/w/h/r` 并进 `box`。
 * 纯函数：不修改入参（调用方可能还在用它）。
 * @param {any} value
 * @returns {{ problems: any[], value?: any }}
 */
function normalizeValue(value) {
  /** @type {any[]} */
  const problems = [];
  if (value === null || typeof value !== 'object' || !Array.isArray(value.tracks)) {
    return { problems: [problem('value 必须是解析后的 FilmDoc', 'value')] };
  }
  for (const key of Object.keys(value)) {
    if (!DOC_VALUE_KEYS.has(key)) problems.push(problem(`文档上不允许出现字段 ${key}`, key));
  }

  const stage = value.stage;
  if (stage === null || typeof stage !== 'object' || Array.isArray(stage)) {
    problems.push(problem('stage 必须是 {w,h}', 'stage'));
  } else {
    for (const dim of /** @type {const} */ (['w', 'h'])) {
      const size = stage[dim];
      if (!Number.isInteger(size) || size < STAGE_MIN || size > STAGE_MAX) {
        problems.push(
          problem(`舞台 ${dim} 必须是 ${STAGE_MIN}..${STAGE_MAX} 的整数（收到 ${String(size)}）`, `stage.${dim}`),
        );
      }
    }
    for (const key of Object.keys(stage)) {
      if (key !== 'w' && key !== 'h') problems.push(problem(`stage 上不允许出现字段 ${key}`, `stage.${key}`));
    }
  }

  /** @type {any[]} */
  const tracks = [];
  value.tracks.forEach((/** @type {any} */ track, /** @type {number} */ ti) => {
    const trackPath = `tracks[${ti}]`;
    if (track === null || typeof track !== 'object' || Array.isArray(track)) {
      problems.push(problem(`${trackPath} 必须是对象`, trackPath));
      return;
    }
    for (const key of Object.keys(track)) {
      if (!TRACK_VALUE_KEYS.has(key)) problems.push(problem(`轨道上不允许出现字段 ${key}`, `${trackPath}.${key}`));
    }
    if (!Array.isArray(track.clips)) {
      problems.push(problem(`${trackPath}.clips 必须是数组`, `${trackPath}.clips`));
      return;
    }
    /** @type {any[]} */
    const clips = [];
    track.clips.forEach((/** @type {any} */ clip, /** @type {number} */ ci) => {
      const path = `${trackPath}.clips[${ci}]`;
      if (clip === null || typeof clip !== 'object' || Array.isArray(clip)) {
        problems.push(problem(`${path} 必须是对象`, path));
        return;
      }
      for (const key of Object.keys(clip)) {
        if (!CLIP_VALUE_KEYS.has(key)) {
          problems.push(
            problem(`片段上不允许出现字段 ${key}（位置用 box.x/y/w/h，或 x/y/w/h 简写）`, `${path}.${key}`),
          );
        }
      }
      const box = normalizeBox(clip, path, problems);
      /** @type {any} */
      const next = { ...clip };
      for (const key of BOX_ALIASES) delete next[key];
      if (box === null) delete next.box;
      else next.box = box;
      clips.push(next);
    });
    tracks.push({ ...track, clips });
  });

  if (problems.length > 0) return { problems };
  return { problems, value: { ...value, stage: { w: value.stage.w, h: value.stage.h }, tracks } };
}

/**
 * 值 → film.html 的局部补丁；纯函数，不落盘。
 *
 * M77：舞台补丁与轨道补丁**合成一次写回**。以前 `stage` 变了就走 `patchStage` 直接 return，
 * 同一批里的轨道改动被整段跳过（还回 ok:true）——那是静默丢数据。现在：
 * 1. 先算舞台补丁 → 在**新文本**上重算 sections 偏移 → 再打轨道补丁；
 * 2. `finish` 回读时逐字段核对（stage + 每条轨道 + 每个片段），不一致就 INVALID 指字段。
 *
 * @param {string} text
 * @param {any} value
 * @param {string} expectedHash
 * @param {{ rewrite?: (text: string) => string }} [hooks] 只给测试用：把组合结果篡改一份，验回读校验会拒。
 * @returns {any}
 */
export function writeValue(text, value, expectedHash, hooks) {
  if (typeof text !== 'string') {
    return { ok: false, code: 'INVALID', sourceHash: '', diagnostics: [problem('text 必须是字符串', 'text')] };
  }
  const sourceHash = sha256(text);
  if (expectedHash !== sourceHash) {
    return { ok: false, code: 'CONFLICT', sourceHash, diagnostics: [invalid('expectedHash 与当前文本不符')] };
  }

  const before = analyze(text, {});
  if (before.doc === null) {
    return { ok: false, code: 'INVALID', sourceHash, diagnostics: before.diagnostics };
  }
  const normalized = normalizeValue(value);
  if (normalized.problems.length > 0) {
    return { ok: false, code: 'INVALID', sourceHash, diagnostics: normalized.problems };
  }
  const target = normalized.value;
  if (sameCanonical(before.doc, target)) {
    return { ok: true, text, bytes: Buffer.byteLength(text, 'utf8'), sourceHash, prevSourceHash: sourceHash, changed: false };
  }

  const stageChanged = before.doc.stage.w !== target.stage.w || before.doc.stage.h !== target.stage.h;
  const composed = composeWrite(text, before, target, stageChanged);
  if (composed.text === undefined) {
    return { ok: false, code: 'INVALID', sourceHash, diagnostics: composed.diagnostics ?? [problem('写回失败')] };
  }
  return finish(text, composed.text, target, sourceHash, hooks);
}

/**
 * 舞台 + 轨道组合成一次写回。
 * 舞台补丁会移动字节，所以轨道补丁必须在**打补丁后的文本**上重新 analyze 再算区间；
 * 反过来（先轨道后舞台）也能得到同一份文本——两条路径都由「最终解析结果」定义，跟顺序无关。
 * @param {string} text @param {Analysis} before @param {any} value @param {boolean} stageChanged
 * @returns {{ text?: string, diagnostics?: any[] }}
 */
function composeWrite(text, before, value, stageChanged) {
  let base = text;
  let analysis = before;
  if (stageChanged) {
    const applied = patchStage(text, before, value.stage);
    if (applied.error !== undefined) return { diagnostics: [problem(applied.error, 'stage')] };
    if (applied.text === undefined) return { diagnostics: [problem('舞台无法写回', 'stage')] };
    base = applied.text;
    analysis = analyze(base, {});
    if (analysis.doc === null) {
      return { diagnostics: [problem('舞台写回后文档无法解析', 'stage'), ...analysis.diagnostics] };
    }
  }
  const rewritten = rewriteTracks(base, analysis, value);
  if (rewritten.error !== undefined) return { diagnostics: [problem(rewritten.error)] };
  return { text: String(rewritten.text) };
}

const MANAGED_TRACK_ATTRS = new Set(['hidden', 'muted', 'locked']);

/**
 * 轨道部分：顺序变了整块重写，否则逐片段局部补丁。
 * @param {string} text @param {Analysis} before @param {any} value
 * @returns {{ text?: string, error?: string }}
 */
function rewriteTracks(text, before, value) {
  const beforeDoc = /** @type {any} */ (before.doc);
  const beforeTracks = beforeDoc.tracks;
  const sections = [...before.sections].sort((a, b) => a.start - b.start);
  const afterTracks = value.tracks;

  const orderChanged =
    sections.length !== afterTracks.length ||
    beforeTracks.length !== afterTracks.length ||
    afterTracks.some((/** @type {any} */ track, /** @type {number} */ index) => !sharesClip(beforeTracks[index], track));

  if (orderChanged) {
    const rewritten = rewriteSections(text, before, value);
    if (rewritten.error !== undefined) return { error: rewritten.error };
    return { text: String(rewritten.text) };
  }

  /** @type {{ start: number, end: number, text: string }[]} */
  const splices = [];
  afterTracks.forEach((/** @type {any} */ track, /** @type {number} */ index) => {
    const section = sections[index];
    const beforeTrack = beforeTracks[index];
    if (section === undefined || beforeTrack === undefined) return;
    const flags = /** @type {[string, string|null][]} */ ([
      ['hidden', track.hidden === true ? '' : null],
      ['muted', track.muted === true ? '' : null],
      ['locked', track.locked === true ? '' : null],
    ]);
    const changed =
      (beforeTrack.hidden === true) !== (track.hidden === true) ||
      (beforeTrack.muted === true) !== (track.muted === true) ||
      (beforeTrack.locked === true) !== (track.locked === true);
    if (changed) splices.push(...patchTag(text, section, flags, MANAGED_TRACK_ATTRS));
    splices.push(...patchTrackClips(text, before, section, beforeTrack.clips, track.clips));
  });
  return { text: applySplices(text, splices) };
}

/**
 * 回读自证（M77）：把写回后的文本重新解析，逐字段核对「舞台 + 每条轨道 + 每个片段」。
 * 任何一处不等 → `ok:false` 并指出字段，绝不回「ok 但丢一半」。
 * @param {string} text @param {any} value
 * @returns {{ ok: boolean, diagnostics?: any[], doc?: any }}
 */
export function verifyValue(text, value) {
  const recheck = analyze(text, {});
  if (recheck.doc === null) {
    return { ok: false, diagnostics: [...recheck.diagnostics, problem('写回后的文本无法解析')] };
  }
  const problems = diffValue(recheck.doc, value);
  if (problems.length > 0) return { ok: false, diagnostics: problems };
  return { ok: true, doc: recheck.doc };
}

/** @param {any} actual @param {any} expected @returns {string[]} */
function clipFieldDiff(actual, expected) {
  const left = /** @type {Record<string, any>} */ (canonicalClip(actual));
  const right = /** @type {Record<string, any>} */ (canonicalClip(expected));
  /** @type {string[]} */
  const keys = [];
  for (const key of Object.keys(right)) {
    if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) keys.push(key);
  }
  return keys;
}

/**
 * 逐字段比较：舞台 → 帧率 → 轨道属性 → 片段（规范化后的每个字段）。
 * @param {any} actual @param {any} expected
 * @returns {any[]}
 */
function diffValue(actual, expected) {
  /** @type {any[]} */
  const problems = [];
  if (actual.stage.w !== expected.stage.w) {
    problems.push(problem(`舞台宽度写回后是 ${actual.stage.w}，目标是 ${expected.stage.w}`, 'stage.w'));
  }
  if (actual.stage.h !== expected.stage.h) {
    problems.push(problem(`舞台高度写回后是 ${actual.stage.h}，目标是 ${expected.stage.h}`, 'stage.h'));
  }
  if (actual.fps.num !== expected.fps?.num || actual.fps.den !== expected.fps?.den) {
    problems.push(problem('帧率写回后与目标不一致（文件里没有帧率，说明目标值本身不可表示）', 'fps'));
  }
  if (actual.tracks.length !== expected.tracks.length) {
    problems.push(problem(`轨道数写回后是 ${actual.tracks.length}，目标是 ${expected.tracks.length}`, 'tracks'));
    return problems;
  }
  actual.tracks.forEach((/** @type {any} */ track, /** @type {number} */ ti) => {
    const want = expected.tracks[ti];
    /** @type {[string, any, any][]} */
    const flags = [
      ['index', track.index, want.index],
      ['role', track.role, want.role],
      ['name', track.name ?? null, want.name ?? null],
      ['locked', track.locked === true, want.locked === true],
      ['hidden', track.hidden === true, want.hidden === true],
      ['muted', track.muted === true, want.muted === true],
    ];
    for (const [key, left, right] of flags) {
      if (JSON.stringify(left) !== JSON.stringify(right)) {
        problems.push(problem(`轨道 ${ti} 的 ${key} 写回后是 ${JSON.stringify(left)}，目标是 ${JSON.stringify(right)}`, `tracks[${ti}].${key}`));
      }
    }
    if (!Array.isArray(want.clips) || track.clips.length !== want.clips.length) {
      problems.push(problem(`轨道 ${ti} 的片段数写回后是 ${track.clips.length}，目标是 ${want.clips?.length ?? 0}`, `tracks[${ti}].clips`));
      return;
    }
    track.clips.forEach((/** @type {any} */ clip, /** @type {number} */ ci) => {
      const wantClip = want.clips[ci];
      const fields = clipFieldDiff(clip, wantClip);
      if (fields.length === 0) return;
      const first = String(fields[0]);
      problems.push(
        problem(`片段 ${String(clip?.id)} 的 ${fields.join('/')} 写回后与目标不一致`, `tracks[${ti}].clips[${ci}].${first}`),
      );
    });
  });
  return problems;
}

/**
 * @param {string} text @param {string} next @param {any} value @param {string} sourceHash
 * @param {{ rewrite?: (text: string) => string }} [hooks]
 */
function finish(text, next, value, sourceHash, hooks) {
  const finalText = typeof hooks?.rewrite === 'function' ? String(hooks.rewrite(next)) : next;
  const verified = verifyValue(finalText, value);
  if (verified.ok !== true) {
    return { ok: false, code: 'INVALID', sourceHash, diagnostics: verified.diagnostics ?? [problem('写回校验失败')] };
  }
  return {
    ok: true,
    text: finalText,
    bytes: Buffer.byteLength(finalText, 'utf8'),
    sourceHash: sha256(finalText),
    prevSourceHash: sourceHash,
    changed: finalText !== text,
  };
}

/**
 * @param {string} text @param {Analysis} before @param {{ w: number, h: number }} stage
 * @returns {{ text?: string, error?: string }}
 */
function patchStage(text, before, stage) {
  const content = `width=${stage.w}, height=${stage.h}`;
  if (before.viewport !== null) {
    return { text: applySplices(text, patchTag(text, /** @type {TagRef} */ (before.viewport), [['content', content]], new Set(['content']))) };
  }
  const at = before.headInsertAt;
  return { text: `${text.slice(0, at)}\n<meta name="viewport" content="${content}">${text.slice(at)}` };
}

/**
 * 一条轨道里的片段：逐个补丁；顺序变了才整块重写这条轨道。
 * @param {string} text @param {Analysis} before @param {SectionRef} section
 * @param {any[]} beforeClips @param {any[]} afterClips
 */
function patchTrackClips(text, before, section, beforeClips, afterClips) {
  const localIds = new Set(beforeClips.map((/** @type {any} */ clip) => clip.id));
  const beforeIds = beforeClips.map((/** @type {any} */ clip) => clip.id);
  const afterIds = afterClips.map((/** @type {any} */ clip) => clip.id);
  const commonAfter = afterIds.filter((/** @type {string} */ id) => beforeIds.includes(id));
  const commonBefore = beforeIds.filter((/** @type {string} */ id) => afterIds.includes(id));

  if (commonAfter.join('\u0000') !== commonBefore.join('\u0000')) return rewriteTrack(text, section, afterClips);

  /** @type {{ start: number, end: number, text: string }[]} */
  const splices = [];
  /** @type {Map<number, string>} */
  const insertsAt = new Map();
  let anchor = section.tagEnd;
  let indent = `${lineIndent(text, section.start)}  `;

  for (const clip of afterClips) {
    const ref = localIds.has(clip.id) ? before.elements.get(clip.id) : undefined;
    if (ref === undefined) {
      insertsAt.set(anchor, `${insertsAt.get(anchor) ?? ''}\n${indent}${serializeClip(clip)}`);
      continue;
    }
    splices.push(...patchTag(text, ref, clipAttributes(clip), MANAGED_CLIP_ATTRS));
    /* 文本片段：内容变了就替换元素内文那一小段。属性区由 patchTag 管，两段区间不重叠。 */
    if (clipKindOf(clip) === 'text' && ref.innerStart <= ref.innerEnd) {
      const want = String(clip.text ?? '');
      if (decodeEntities(ref.innerText.trim()) !== want) {
        splices.push({ start: ref.innerStart, end: ref.innerEnd, text: escapeText(want) });
      }
    }
    anchor = ref.end;
    indent = lineIndent(text, ref.start) || indent;
  }

  for (const clip of beforeClips) {
    if (afterIds.includes(clip.id)) continue;
    const ref = before.elements.get(clip.id);
    if (ref === undefined) continue;
    splices.push({ ...wholeLineRange(text, ref.start, ref.end), text: '' });
  }

  for (const [at, block] of insertsAt) splices.push({ start: Number(at), end: Number(at), text: block });
  return splices;
}

/** @param {any} before @param {any} after */
function sharesClip(before, after) {
  if (before === undefined || after === undefined) return false;
  if (before.clips.length === 0 && after.clips.length === 0) return true;
  const ids = new Set(after.clips.map((/** @type {any} */ clip) => clip.id));
  return before.clips.some((/** @type {any} */ clip) => ids.has(clip.id));
}

/** @param {string} text @param {SectionRef} section @param {any[]} clips */
function rewriteTrack(text, section, clips) {
  const sectionEnd = section.end;
  const closeStart = text.lastIndexOf('</section>', sectionEnd);
  const innerStart = section.tagEnd;
  const innerEnd = closeStart >= innerStart ? closeStart : sectionEnd;
  const inner = text.slice(innerStart, innerEnd);
  const firstLine = inner.split('\n').find((line) => line.trim() !== '');
  const indent = firstLine === undefined ? `${lineIndent(text, section.start)}  ` : firstLine.slice(0, firstLine.length - firstLine.trimStart().length);
  const body = clips.map((clip) => `${indent}${serializeClip(clip)}`).join('\n');
  const replacement = body === '' ? '' : `\n${body}\n${lineIndent(text, section.start)}`;
  return [{ start: innerStart, end: innerEnd, text: replacement }];
}

/**
 * @param {string} text @param {Analysis} before @param {any} value
 * @returns {{ text?: string, error?: string }}
 */
function rewriteSections(text, before, value) {
  const sections = [...before.sections].sort((a, b) => a.start - b.start);
  const first = sections[0];
  const last = sections[sections.length - 1];
  if (first === undefined || last === undefined) return { error: '文档里没有 <section> 轨道' };
  const sectionIndent = lineIndent(text, first.start);
  const clipIndent = `${sectionIndent}  `;
  const blocks = value.tracks.map((/** @type {any} */ track) => {
    const clips = track.clips.map((/** @type {any} */ clip) => `${clipIndent}${serializeClip(clip)}`).join('\n');
    const flags = TRACK_FLAGS.filter((flag) => track[flag] === true).map((flag) => ` ${flag}`).join('');
    const extras = Object.entries(track.attrs ?? {})
      .filter(([name]) => KEPT_TRACK_ATTRIBUTE.test(name) && !TRACK_FLAGS.includes(name))
      .map(([name, v]) => attrMarkup(name, String(v)))
      .join('');
    return `${sectionIndent}<section${extras}${flags}>${clips === '' ? '' : `\n${clips}\n${sectionIndent}`}</section>`;
  });
  return { text: applySplices(text, [{ start: first.start, end: last.end, text: blocks.join('\n') }]) };
}

/**
 * 把标签的属性改成 `desired`，只替换真正变了的区间。
 * @param {string} text
 * @param {TagRef} ref
 * @param {[string, string|null][]} desired
 * @param {Set<string>} managed
 * @returns {{ start: number, end: number, text: string }[]}
 */
function patchTag(text, ref, desired, managed) {
  /** @type {{ start: number, end: number, text: string }[]} */
  const splices = [];
  const wanted = new Map(desired.map(([name, value]) => [name.toLowerCase(), value]));
  /** @type {string[]} */
  const inserts = [];

  for (const [name, value] of desired) {
    if (value === null) continue;
    const existing = ref.attrs.get(name.toLowerCase());
    if (existing === undefined) {
      inserts.push(attrMarkup(name, value));
      continue;
    }
    if (existing.value === value) continue;
    if (value === '') {
      splices.push({ start: existing.nameStart, end: attrEnd(existing), text: name });
      continue;
    }
    if (existing.quoted && existing.quote === '"' && !value.includes('"')) {
      splices.push({ start: existing.valueStart, end: existing.valueEnd, text: escapeAttr(value) });
      continue;
    }
    if (existing.quoted && existing.quote === "'" && !value.includes("'")) {
      splices.push({ start: existing.valueStart, end: existing.valueEnd, text: value.replace(/&/g, '&amp;') });
      continue;
    }
    splices.push({ start: existing.nameStart, end: attrEnd(existing), text: `${name}=${quoteValue(value)}` });
  }

  for (const [key, attr] of ref.attrs) {
    // 目标里没有这个属性，或者目标明确是 null（默认值 = 不写）：删掉它。
    if (wanted.has(key) && wanted.get(key) !== null) continue;
    if (!managed.has(key)) continue;
    let from = attr.nameStart;
    while (from > ref.start && /[ \t]/.test(text.charAt(from - 1))) from -= 1;
    splices.push({ start: from, end: Math.max(attrEnd(attr), attr.nameEnd), text: '' });
  }

  if (inserts.length > 0) splices.push({ start: ref.tagEnd - 1, end: ref.tagEnd - 1, text: inserts.join('') });
  return splices;
}

/** @param {any} clip */
function serializeClip(clip) {
  const kind = clipKindOf(clip);
  const tag = TAG_OF_KIND[/** @type {keyof typeof TAG_OF_KIND} */ (kind)] ?? 'video';
  const attrs = clipAttributes(clip)
    .filter(([, value]) => value !== null)
    .map(([name, value]) => attrMarkup(name, String(value)))
    .join('');
  if (tag === 'img') return `<img${attrs}>`;
  /* 文本片段：内容是元素内文，写在开闭标签之间（属性区照旧由 clipAttributes 管）。 */
  if (kind === 'text') return `<div${attrs}>${escapeText(clip.text ?? '')}</div>`;
  return `<${tag}${attrs}></${tag}>`;
}

/** 文本内容里的 `&`/`<`/`>` 转义（`decodeEntities()` 是它的逆，保证写一次读一次字节稳定）。 @param {string} value */
function escapeText(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** @param {FilmAttr} attr */
function attrEnd(attr) {
  return attr.quoted ? attr.valueEnd + 1 : attr.valueEnd;
}

/** @param {string} name @param {string} value */
function attrMarkup(name, value) {
  if (value === '') return ` ${name}`;
  if (value.includes('"')) return ` ${name}=${quoteValue(value)}`;
  return ` ${name}="${escapeAttr(value)}"`;
}

/** @param {string} value */
function quoteValue(value) {
  return `'${value.replace(/&/g, '&amp;').replace(/'/g, '&#39;')}'`;
}

/* ── 合同 `write()`：字段级编辑（纯函数） ── */

/**
 * 合同 v1.2.0 的 `write()`：`edits` 是 `{clipId, field, value}`，字段级最小改动。
 * 实现复用 Op 引擎（同一个 `setField`）与 `writeValue`（同一个补丁器），所以两条路径行为一致。
 * @param {string} text
 * @param {readonly { clipId: string, field: string, value: unknown }[]} edits
 * @param {string} baseHash
 * @returns {any}
 */
export function write(text, edits, baseHash) {
  const sourceHash = sha256(text);
  if (baseHash !== sourceHash) {
    return { ok: false, code: 'CONFLICT', sourceHash, diagnostics: [invalid('baseHash 与当前文本不符')] };
  }
  if (!Array.isArray(edits)) {
    return { ok: false, code: 'INVALID', sourceHash, diagnostics: [invalid('edits 必须是数组')] };
  }
  if (edits.length === 0) {
    return { ok: true, text, bytes: Buffer.byteLength(text, 'utf8'), sourceHash, prevSourceHash: sourceHash, changed: false };
  }

  const parsed = analyze(text, {});
  if (parsed.doc === null) {
    return { ok: false, code: 'INVALID', sourceHash, diagnostics: parsed.diagnostics };
  }

  /** @type {any[]} */
  const props = [];
  for (const edit of edits) {
    if (edit === null || typeof edit !== 'object' || typeof edit.clipId !== 'string') {
      return { ok: false, code: 'INVALID', sourceHash, diagnostics: [invalid('edit 必须是 {clipId, field, value}')] };
    }
    props.push({ op: 'props', edits: [{ clip: edit.clipId, prop: String(edit.field), value: edit.value }] });
  }

  /** @type {any} */
  let applied;
  try {
    applied = applyOpsDetailed(parsed.doc, props);
  } catch (error) {
    if (error instanceof EditError) {
      return {
        ok: false,
        code: 'INVALID',
        sourceHash,
        diagnostics: [{ code: error.code === 'NOT_FOUND' ? 'UNKNOWN_FIELD' : 'BAD_TIME', message: error.message, severity: 'error' }],
      };
    }
    throw error;
  }

  return writeValue(text, applied.value, sourceHash);
}

/* ── 规范化（比较用） ── */

/**
 * 把 doc 投影成可逐字段比较的形状（去 sourceHash，补默认值，键顺序固定）。
 * @param {any} doc
 */
export function canonicalDoc(doc) {
  return {
    stage: { w: doc.stage.w, h: doc.stage.h },
    fps: { num: doc.fps.num, den: doc.fps.den },
    tracks: doc.tracks.map((/** @type {any} */ track) => ({
      index: track.index,
      role: track.role,
      name: track.name ?? null,
      locked: track.locked === true,
      hidden: track.hidden === true,
      muted: track.muted === true,
      clips: track.clips.map(canonicalClip),
    })),
  };
}

/** @param {any} clip */
function canonicalClip(clip) {
  /** @type {Record<string, string>|null} */
  let attrs = null;
  if (clip.attrs !== undefined) {
    attrs = {};
    for (const key of Object.keys(clip.attrs).sort()) attrs[key] = String(clip.attrs[key]);
  }
  return {
    id: clip.id,
    src: clip.src,
    kind: clip.kind ?? clipKindOf(clip),
    /* E12-P3：文本片段的内容也是「值」的一部分 —— 不写进比较，改内容会被 verifyValue 漏掉。
       空串与「没有这个键」等价（见 buildClip），比较时都记 null。 */
    text: clip.text === '' || clip.text === undefined ? null : clip.text,
    sound: clip.sound === true,
    at: clip.at ?? null,
    time: Array.isArray(clip.time) ? [...clip.time] : null,
    speed: clip.speed ?? null,
    volume: clip.volume ?? null,
    muted: clip.muted === true,
    size: clip.size ?? null,
    box: clip.box ?? null,
    style: clip.style ?? null,
    overrides: derivedOverrides(clip),
    fade: Array.isArray(clip.fade) ? [...clip.fade] : null,
    link: clip.link ?? null,
    attrs,
  };
}

/** @param {any} left @param {any} right */
export function sameCanonical(left, right) {
  return JSON.stringify(canonicalDoc(left)) === JSON.stringify(canonicalDoc(right));
}

/* ── 小工具 ── */

/** @param {any} token @returns {Map<string, FilmAttr>} */
function attrMapOf(token) {
  /** @type {Map<string, FilmAttr>} */
  const map = new Map();
  for (const attr of token.attrs) map.set(attr.name.toLowerCase(), attr);
  return map;
}

/** @param {Map<string, FilmAttr>} map @param {string} name */
function getAttr(map, name) {
  const attr = map.get(name);
  return attr === undefined ? '' : attr.value;
}

/**
 * 文本片段（`<div>`）的内容：把元素内部的文本 token 拼起来，去掉首尾空白。
 *
 * 文本片段是**唯一**「内容在自己身上」的片段，所以它不用 `findHeldContent()` 那条
 * 「片段里什么都不放」的规则；代价是要自己挡子元素 —— 里面出现任何开标签都报错，
 * 否则 `<div><span>你好</span></div>` 会被静默读成「你好」，写回时又把 `<span>` 弄丢。
 *
 * @param {any[]} tokens
 * @param {number} index
 * @param {number} stop 闭标签的下标
 * @returns {{ text: string, insideProblem: string|null }}
 */
function harvestTextContent(tokens, index, stop) {
  let out = '';
  for (let i = index + 1; i < stop; i += 1) {
    const token = tokens[i];
    if (token.type === 'comment') continue;
    if (token.type === 'text') {
      out += String(token.text ?? '');
      continue;
    }
    if (token.type === 'open') return { text: '', insideProblem: `文本片段里只放文字，不放 <${String(token.name)}>` };
  }
  return { text: decodeEntities(out.trim()), insideProblem: null };
}

/**
 * 文本片段的 `time` 属性：`"0,6"`（起点,终点，秒）或 `"2"`（起点，到结尾）。
 * @param {string} raw
 * @returns {number[]|null}
 */
function parseTimeAttribute(raw) {
  const parts = String(raw ?? '').split(',');
  if (parts.length < 1 || parts.length > 2) return null;
  const from = parseSeconds(parts[0]);
  if (from === null || !Number.isFinite(from) || from < 0) return null;
  if (parts.length === 1) return [from];
  const to = parseSeconds(parts[1]);
  if (to === null || !Number.isFinite(to) || to < from) return null;
  return [from, to];
}

/**
 * 片段标签里不该有的内容（`<source>`/`<track>`/文字）。
 * @param {any[]} tokens
 * @param {number} index
 * @param {number} stop
 * @returns {string|null}
 */
function findHeldContent(tokens, index, stop) {
  for (let i = index + 1; i < stop; i += 1) {
    const token = tokens[i];
    if (token.type === 'comment') continue;
    if (token.type === 'text' && String(token.text).trim() === '') continue;
    if (token.type === 'open' && token.name === 'source') return '它的文件就是它自己的 src';
    if (token.type === 'open' && token.name === 'track') return '字幕是文件旁的 WebVTT（a.mp4 → a.vtt）';
    return '一个片段就是它的文件';
  }
  return null;
}

/**
 * 元素结束的 token 下标（自闭合/空元素就是它自己）。
 * @param {any[]} tokens @param {number} index @param {string} name
 * @returns {number|null}
 */
function elementEndIndex(tokens, index, name) {
  const token = tokens[index];
  if (VOID_TAGS.has(name) || token.selfClose === true) return index;
  let depth = 0;
  for (let i = index; i < tokens.length; i += 1) {
    const current = tokens[i];
    if (current.type === 'open' && current.name === name) depth += 1;
    else if (current.type === 'close' && current.name === name) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return null;
}

/** 跳过不在轨道里的元素（连同它的内容）。 @param {any[]} tokens @param {number} index */
function skipElement(tokens, index) {
  const token = tokens[index];
  if (VOID_TAGS.has(token.name) || token.selfClose === true) return index;
  let depth = 0;
  for (let i = index; i < tokens.length; i += 1) {
    const current = tokens[i];
    if (current.type === 'open' && current.name === token.name) depth += 1;
    else if (current.type === 'close' && current.name === token.name) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return tokens.length - 1;
}

/** @param {any[]} clips @returns {'picture'|'audio'|'page'} */
function roleOf(clips) {
  if (clips.length === 0) return 'picture';
  const kinds = clips.map((clip) => clip.kind ?? clipKindOf(clip));
  if (kinds.every((kind) => kind === 'sound')) return 'audio';
  if (kinds.every((kind) => kind === 'page' || kind === 'sound') && kinds.some((kind) => kind === 'page')) return 'page';
  return 'picture';
}

/**
 * `src` 的片段：`t=in,out` / `t=in`。
 * @param {string} raw
 * @returns {number[]|null}
 */
function parseFragment(raw) {
  const match = /^t=([^,]*)(?:,(.*))?$/.exec(raw);
  if (match === null) return null;
  const from = parseSeconds(match[1]);
  if (from === null) return null;
  if (match[2] === undefined) return [from];
  const to = parseSeconds(match[2]);
  if (to === null) return null;
  return [from, to];
}

/** @param {string} value @returns {[string, string][]} */
function declarations(value) {
  /** @type {[string, string][]} */
  const out = [];
  for (const piece of value.split(';')) {
    const item = piece.trim();
    if (item === '') continue;
    const index = item.indexOf(':');
    if (index < 0) {
      out.push([item.toLowerCase(), '']);
      continue;
    }
    out.push([item.slice(0, index).trim().toLowerCase(), item.slice(index + 1).trim()]);
  }
  return out;
}

/** @param {string} raw @param {string} unit @returns {number|null} */
function amount(raw, unit) {
  const match = new RegExp(`^\\s*(-?\\d+(?:\\.\\d+)?)\\s*${unit}\\s*$`, 'i').exec(raw);
  if (match === null) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** @param {unknown} value @returns {{ num: number, den: number }} */
function normalizeFps(value) {
  if (value === undefined || value === null) return { num: 30, den: 1 };
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return { num: Math.round(value), den: 1 };
  if (typeof value === 'string') {
    const rational = parseRational(value);
    if (rational !== null) return rational;
  }
  if (typeof value === 'object') {
    const record = /** @type {any} */ (value);
    if (Number.isFinite(record.num) && Number.isFinite(record.den) && record.den > 0 && record.num > 0) {
      return { num: record.num, den: record.den };
    }
  }
  return { num: 30, den: 1 };
}

/** @param {Readonly<Record<string, number|null>>} native @param {string} src */
function lookupNative(native, src) {
  if (Object.prototype.hasOwnProperty.call(native, src)) {
    const direct = native[src];
    return typeof direct === 'number' && Number.isFinite(direct) ? direct : null;
  }
  return null;
}

/**
 * `data-native` 是样例里声明素材真实时长的写法（原样保留的 data-*），`null` 表示未知。
 * @param {Record<string, string>|undefined} attrs
 * @param {string} clipId
 * @param {number} offset
 * @param {(code: DiagnosticCode, message: string, extra?: { offset?: number, clipId?: string, severity?: 'error'|'warning' }) => void} report
 */
function declaredNative(attrs, clipId, offset, report) {
  const raw = attrs?.['data-native'];
  if (raw === undefined) return null;
  if (raw === 'null') return null;
  const value = parseSeconds(raw);
  if (value === null || value < 0) {
    report('UNKNOWN_FIELD', `片段 ${clipId} 的 data-native 非法：${raw}`, { offset, clipId });
    return null;
  }
  return value;
}

/** @param {string} key */
function attributeHint(key) {
  if (key === 'time' || key === 'start' || key === 'end' || key === 'duration') {
    return '（源入出点写在 src 的 #t=in,out 里）';
  }
  if (key === 'data-start' || key === 'offset') return '（时间线起点是 at="…"）';
  if (key === 'width' || key === 'height') return '（画面位置写在 style 里）';
  if (key === 'rate' || key === 'playbackrate') return '（速度是 speed="…"）';
  if (key === 'gain') return '（音量是 volume="…"）';
  return '（片段只认 id/src/at/speed/volume/muted/size/class/style/overrides，Studio 自有用 data-*）';
}

/** @param {string} tag @param {string} key */
function legacyHint(tag, key) {
  const name = key.slice('data-'.length);
  if (name === 'clip') return `id="…"（片段用标签定类型：<${tag}>）`;
  if (name === 'track') return '普通 <section>（第一个在最上层），轨道没有序号属性';
  if (name === 'src') return 'src="…"';
  if (name === 'at') return 'at="…"（时间线起点秒）';
  if (name === 'time') return 'src="…" 的 #t=in,out';
  if (name === 'fade') return 'overrides 里没有 at 的那一条：overrides=\'[{"fade":[in,out]}]\'';
  if (name === 'box') return 'style="left: …px; top: …px; width: …px; height: …px"';
  if (name === 'overrides') return 'overrides=\'[…]\'（JSON 数组）';
  return '不带 data- 前缀的写法';
}

/** @param {string} value */
function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** @param {string} text @param {number} offset */
function lineIndent(text, offset) {
  const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  const prefix = text.slice(lineStart, offset);
  return /^[ \t]*$/.test(prefix) ? prefix : '';
}

/**
 * 删除一个元素：独占一行时连行首缩进与换行一起删。
 * @param {string} text @param {number} start @param {number} end
 */
function wholeLineRange(text, start, end) {
  const lineStart = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const before = text.slice(lineStart, start);
  const lineEnd = text.indexOf('\n', end);
  const after = lineEnd < 0 ? '' : text.slice(end, lineEnd);
  if (/^[ \t]*$/.test(before) && /^[ \t]*$/.test(after)) {
    return { start: lineStart, end: lineEnd < 0 ? text.length : lineEnd + 1 };
  }
  return { start, end };
}

/** @param {string} text @param {{ start: number, end: number, text: string }[]} splices */
function applySplices(text, splices) {
  const sorted = [...splices].sort((a, b) => b.start - a.start || b.end - a.end);
  let next = text;
  for (const splice of sorted) next = next.slice(0, splice.start) + splice.text + next.slice(splice.end);
  return next;
}

/** @param {string} message @returns {Diagnostic} */
function invalid(message) {
  return { code: 'UNKNOWN_FIELD', message, severity: 'error' };
}

/** @param {number} size */
function isStageSize(size) {
  return Number.isInteger(size) && size >= 16 && size <= 8192 && size % 2 === 0;
}

/** @param {string} ch */
function isSpace(ch) {
  return ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\f';
}

/** @param {string} ch */
function isTagNameEnd(ch) {
  return ch === '' || isSpace(ch) || ch === '>' || ch === '/';
}

/** @param {string} text @param {string} name @param {number} from */
function findCloseTag(text, name, from) {
  const needle = `</${name}`;
  const lower = name.toLowerCase();
  let cursor = from;
  while (cursor < text.length) {
    const candidate = text.toLowerCase().indexOf(needle, cursor);
    if (candidate < 0) return -1;
    const after = text.charAt(candidate + needle.length);
    if (after === '' || after === '>' || isSpace(after)) return candidate;
    cursor = candidate + 2;
  }
  void lower;
  return -1;
}

/** @param {string} text @param {number} offset */
function lineAt(text, offset) {
  let line = 1;
  const end = Math.min(Math.max(offset, 0), text.length);
  for (let index = 0; index < end; index += 1) if (text.charCodeAt(index) === 10) line += 1;
  return line;
}

/** @param {string} raw */
function decodeEntities(raw) {
  if (raw.indexOf('&') < 0) return raw;
  return raw
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export { PAST_END_EPS, formatRational, parseRational, parseSeconds, parseTimeRange };
