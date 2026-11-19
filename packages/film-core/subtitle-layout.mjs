/**
 * 字幕行排（共享纯函数）—— R24 · 大脑冻结的单一来源
 *
 * 为什么要有这个文件：S43 实测出两件事，靠 CSS 或 libass 各自换行都治不了：
 *
 * 1. **libass 只在空格处断行**。纯中文长句（没有空格）在成片里是**一行、左右被画布裁掉**；
 *    预览的 `overflow-wrap:anywhere` 却能断成两行。同一条字幕，预览两行、成片一行半。
 * 2. **`maxLines` 的省略号没有 ASS 等价物**。预览截成 `…`，成片仍然整句铺出去。
 *
 * 所以行排必须在**烧录之前**定死：预览和成片拿同一组 `lines`，预览用 `\n`、ASS 用 `\N`。
 * 本模块只做「文本 + 样式 + 舞台 → 行数组」的纯计算，不碰 DOM、不读盘、不认识 ASS。
 *
 * 宽度是**估算**，不是浏览器量出来的：CJK/全角 1em、ASCII 小写 0.52em、大写/数字 0.6em、
 * 空格 0.28em…… 估算值乘 1.02 的安全系数，保证「估出来的宽度 ≥ Heiti SC 实际宽度」，
 * 宁可早断一个字，也不让成片越界被裁。S43 的实测宽度用来校准这套系数（见
 * `scripts/s43-parity.mjs` 的 A1.3 表）。
 *
 * 明确不做：
 * - 不做断词/ hyphenation；拉丁词放不下就硬断。
 * - 不改 VTT/SRT 源文本；截断只发生在显示层（ASSS/预览），旁挂字幕保持全文。
 * - 不处理双向文字（RTL）；遇到阿拉伯/希伯来文按普通字符计宽，后续单独立项。
 */

export const SUBTITLE_LAYOUT_VERSION = '1.0.0';

/** 左右安全区：每边 4% 舞台宽（与 overlay 的 sideSafePx 一致）。 */
export const SUBTITLE_SIDE_SAFE_RATIO = 0.04;

/** 估算宽度的安全系数：估 1.02 倍，宁可早断，不许越界。 */
export const SUBTITLE_WIDTH_SAFETY = 1.02;

/** 可用宽度占舞台宽的比例（扣除左右安全区后再留 2% 余量）。 */
const USABLE_WIDTH_RATIO = (1 - 2 * SUBTITLE_SIDE_SAFE_RATIO) * 0.98;

const CLOSING_PUNCT = new Set([...'。，、；：！？）】」』》〉…,.!?;:)]}%']);
const OPENING_PUNCT = new Set([...'（【「『《〈([{']);

/**
 * 单个字符的估算宽度（em）。
 * @param {string} ch
 * @returns {number}
 */
export function estimateAdvanceEm(ch) {
  if (ch === '') return 0;
  if (ch === ' ' || ch === '\t') return 0.28;
  const cp = /** @type {number} */ (ch.codePointAt(0));
  // CJK / 日文假名 / 韩文 / 全角标点 / 全角字母数字
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 1;
  }
  if (ch >= 'A' && ch <= 'Z') return 0.62;
  if (ch >= 'a' && ch <= 'z') return 0.52;
  if (ch >= '0' && ch <= '9') return 0.56;
  if (".,;:!?'\"|".includes(ch)) return 0.28;
  if ('()[]{}<>/\\'.includes(ch)) return 0.34;
  if (ch === '—' || ch === '…') return 1;
  return 0.55;
}

/**
 * 估算一段文本的宽度（em，已乘安全系数）。
 * @param {string} text
 * @returns {number}
 */
export function measureTextEm(text) {
  let width = 0;
  for (const ch of String(text)) width += estimateAdvanceEm(ch);
  return width * SUBTITLE_WIDTH_SAFETY;
}

/**
 * 计算一行能放多少 em。
 *
 * `view.visibleWidth`（P67）是**可见宽**，单位与 `stage.w` 相同（舞台像素）：
 * `cover` 下舞台被放大后左右裁掉，实际能看见的只有 `画布宽 / scale`，
 * 9:16 时约 405 stage-px（1280 的 32%）。不传时用整个舞台宽 —— 与 P67 之前逐字节相同。
 *
 * @param {{ w: number, h: number }} stage
 * @param {{ fontSizeRatio: number, fontScale?: number }} style
 * @param {{ visibleWidth?: number }} [view]
 * @returns {number}
 */
export function lineCapacityEm(stage, style, view) {
  const w = Number(stage?.w) > 0 ? Number(stage?.w) : 1280;
  const h = Number(stage?.h) > 0 ? Number(stage?.h) : 720;
  /* 只是缺省兜底：调用方（overlay / toAssStyle）一向显式传 `fontSizeRatio`。
     R32 与产品默认同步 0.045 → 0.04，避免「谁没传就悄悄大 12.5%」。函数签名与返回形状未变。 */
  const ratio = Number(style?.fontSizeRatio) > 0 ? Number(style.fontSizeRatio) : 0.04;
  const scale = Number(style?.fontScale) > 0 ? Number(style.fontScale) : 1;
  const visibleRaw = Number(view?.visibleWidth);
  /* 可见宽只许**变小**：letterbox 下画布宽 / scale 可能等于舞台宽，也可能更宽（竖直黑边），
     后者不该让字幕比舞台排版更宽 —— 那时一个字都不会多放。 */
  const width = Number.isFinite(visibleRaw) && visibleRaw > 0 ? Math.min(w, visibleRaw) : w;
  return (width * USABLE_WIDTH_RATIO) / (h * ratio * scale);
}

/**
 * 把一段（可能含显式 `\n` 的）文本排成行。
 *
 * @param {{
 *   text: string,
 *   style: { fontSizeRatio: number, fontScale?: number, lineHeight?: number, maxLines?: number },
 *   stage: { w: number, h: number },
 *   view?: { visibleWidth?: number, fontSizePx?: number },
 * }} input
 * @returns {{
 *   lines: string[],
 *   truncated: boolean,
 *   widthsEm: number[],
 *   capacityEm: number,
 *   visibleWidth: number,
 *   maxLines: number,
 *   lineHeightPx: number|null,
 *   lineStepPx: number|null,
 *   lineStepEm: number,
 *   issues: Array<{ code: string, field: string, value: unknown, message: string }>,
 * }}
 */
export function planSubtitleLines(input) {
  const text = String(input?.text ?? '');
  const style = input?.style ?? { fontSizeRatio: 0.04 };
  const stage = input?.stage ?? { w: 1280, h: 720 };
  /** @type {Array<{ code: string, field: string, value: unknown, message: string }>} */
  const issues = [];
  const stageW = Number(stage?.w) > 0 ? Number(stage?.w) : 1280;
  const visibleRaw = Number(input?.view?.visibleWidth);
  const visibleWidth = Number.isFinite(visibleRaw) && visibleRaw > 0 ? Math.min(stageW, visibleRaw) : stageW;
  const capacity = lineCapacityEm(stage, style, input?.view);
  /* P74：行距的取整点。`view.fontSizePx` 是**目标画布的字号**（成片侧 = ASS 的 Fontsize，
     预览侧 = 折算到预览坐标的同一个字号）。没给 → 只带 em，不给像素，调用方自己按需算。 */
  const lineStep = subtitleLineStepPx({ style, fontSizePx: input?.view?.fontSizePx });
  const maxLinesRaw = Number(style.maxLines);
  const requested = Number.isFinite(maxLinesRaw) && maxLinesRaw >= 1 ? Math.floor(maxLinesRaw) : 2;
  /* 上限 20：再多也不是字幕，是正文。压到 20 的同时把原值记进 issues（不静默）。 */
  const maxLines = Math.min(requested, 20);
  if (requested > 20) {
    issues.push({
      code: 'LAYOUT_MAX_LINES',
      field: 'maxLines',
      value: requested,
      message: `maxLines=${requested} 过大（超过 20 行），按 20 行处理`,
    });
  }
  if (text.trim() === '') {
    return {
      lines: [], truncated: false, widthsEm: [], capacityEm: capacity, visibleWidth, maxLines,
      lineHeightPx: lineStep.roundedPx, lineStepPx: lineStep.px, lineStepEm: lineStep.em,
      issues,
    };
  }

  /** @type {string[]} */
  const lines = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }
    let rest = paragraph;
    while (rest !== '') {
      const fit = takeLine(rest, capacity);
      lines.push(fit.line);
      rest = fit.rest;
    }
  }

  let truncated = false;
  if (lines.length > maxLines) {
    const dropped = lines.length - maxLines;
    lines.length = maxLines;
    const last = lines[maxLines - 1] ?? '';
    lines[maxLines - 1] = truncateWithEllipsis(last, capacity);
    truncated = true;
    /* P67：截断不再只体现为一个 bool。排不下就该多一行；行数被 maxLines 卡住时，
       这属于「内容放不下」，要能从 issues / warnings 里查到，而不是只有 `…`。 */
    issues.push({
      code: 'LAYOUT_TRUNCATED',
      field: 'maxLines',
      value: maxLines,
      message: `文本超出 maxLines=${maxLines}（多出 ${dropped} 行），末行已加省略号`,
    });
  }

  /* 全空行没有意义：显式空行保留，但纯空白段落压掉 */
  const cleaned = lines.length === 1 && (lines[0] ?? '').trim() === '' ? [] : lines;
  const widthsEm = cleaned.map((line) => measureTextEm(line));
  return {
    lines: cleaned, truncated, widthsEm, capacityEm: capacity, visibleWidth, maxLines,
    lineHeightPx: lineStep.roundedPx, lineStepPx: lineStep.px, lineStepEm: lineStep.em,
    issues,
  };
}

/**
 * 取一行：优先在空格处断（拉丁），CJK 可在任意字间断；避免行首标点。
 * @param {string} text
 * @param {number} capacityEm
 * @returns {{ line: string, rest: string }}
 */
function takeLine(text, capacityEm) {
  let width = 0;
  let lastSpace = -1;
  const chars = [...text];
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] ?? '';
    const w = measureTextEm(ch);
    const next = chars[i + 1] ?? '';
    if (width + w > capacityEm && i > 0) {
      /* 行首禁则：下一个是收尾标点，宁可这行超一点也别让它掉到下一行开头 */
      if (CLOSING_PUNCT.has(next) && width + w + measureTextEm(next) <= capacityEm * 1.08) {
        // 继续吃这个字，下一轮会把标点带上
      } else {
        let breakAt = lastSpace > 0 ? lastSpace : i;
        /* 行尾禁则：行尾是开引号/开括号，把它挪到下一行 */
        while (breakAt > 0 && OPENING_PUNCT.has(chars[breakAt - 1] ?? '')) breakAt -= 1;
        if (breakAt <= 0) breakAt = i;
        const line = chars.slice(0, breakAt).join('').replace(/\s+$/u, '');
        const rest = chars.slice(breakAt).join('').replace(/^\s+/u, '');
        return { line, rest };
      }
    }
    width += w;
    if (ch === ' ') lastSpace = i;
  }
  return { line: text.replace(/\s+$/u, ''), rest: '' };
}

/**
 * 截到能放下 `…` 的最长前缀。
 * @param {string} text
 * @param {number} capacityEm
 * @returns {string}
 */
function truncateWithEllipsis(text, capacityEm) {
  const ellipsis = '…';
  const ellipsisWidth = measureTextEm(ellipsis);
  const chars = [...text];
  let width = 0;
  let keep = 0;
  for (const ch of chars) {
    const w = measureTextEm(ch);
    if (width + w + ellipsisWidth > capacityEm) break;
    width += w;
    keep += 1;
  }
  const prefix = chars.slice(0, keep).join('').replace(/\s+$/u, '');
  return `${prefix}${ellipsis}`;
}

/**
 * 行数组 → ASS 文本（显式硬换行 `\N`）。
 * 注意：ASS 的 `\N` 是**字面反斜杠 + N**，不是 JS 换行符。
 * @param {string[]} lines
 * @returns {string}
 */
export function toAssText(lines) {
  return (lines ?? []).filter((line) => line !== '').join('\\N');
}

/**
 * 样式里的 `lineHeight` → **成片行步进**（ADR-R37-03）。
 *
 * ## 为什么需要这条换算
 *
 * ASS 没有行距字段（Style 行的 `Spacing` 是字距），libass 按字体 ascent+descent 逐行堆；
 * Heiti SC 这两个数加起来恰好 1em，所以**成片的自然行距就是 Fontsize**（S50 的 27 格标定，
 * 见 `SUBTITLE_LINE_STEP_K`）。而预览按 CSS `line-height: 1.25` 排 —— 默认值就差了 0.25em。
 *
 * 这里把用户可调的 `lineHeight` 定义成**相对默认行距的倍数**：
 *
 *   em = lineHeight / 1.25      （1.25 是样式默认值，对应成片自然行距 1em）
 *
 * 于是：默认 1.25 → 1em（与现状逐字节一致，不需要任何 `\pos`）；1.8 → 1.44em；1.0 → 0.8em。
 * 连续、可外推，也不会让「默认值」触发一次全量重排。
 *
 * **预览与成片必须都调这个函数**，不许各自再算一套（S58 消费、P53 落 ASS）。
 *
 * @param {{lineHeight?: number}} [style]
 * @returns {{lineHeight: number, defaultLineHeight: number, em: number, isDefault: boolean}}
 */
export function subtitleLineStep(style = {}) {
  const raw = Number(style?.lineHeight);
  const defaultLineHeight = 1.25;
  const lineHeight = Number.isFinite(raw) && raw > 0 ? raw : defaultLineHeight;
  const em = lineHeight / defaultLineHeight;
  return {
    lineHeight,
    defaultLineHeight,
    em,
    isDefault: Math.abs(lineHeight - defaultLineHeight) < 1e-9,
  };
}

/**
 * 行距落成**像素**的唯一取整点（P74 · B-SUB2-R29-038）。
 *
 * ## 为什么必须只有一个取整点
 *
 * 行步进 = `Fontsize × em`（`em = lineHeight / 1.25`，ADR-R37-03）。字号在两个渲染器里
 * 是**两个坐标系**：预览用屏幕 CSS 像素（1280×720 的舞台缩到 602px 时字号 15.17），
 * 成片用交付画布像素（1080×1920 时 `Fontsize = 86`）。两边各自 `Math.round` 一次，
 * 就会得到 15 和 86；而 15 × (1080/405) ≠ 86 —— 差的那点会在多行上**累积**。
 *
 * 所以：`px` 保留连续值（成片 `\pos` 用它，P53/P66 的几何冻结在这条连续值上），
 * `roundedPx` 是**整数像素**（预览侧读它；默认行距下它恰好等于 ASS 的 `Fontsize`，
 * 也就等于 libass 自己堆出来的行距 —— S50 的 27 格 + P74 的 86px×6 行实测都是整数）。
 *
 * @param {{style?: {lineHeight?: number}, fontSizePx?: number}} [input]
 * @returns {{lineHeight: number, defaultLineHeight: number, em: number, isDefault: boolean,
 *   fontSizePx: number|null, px: number|null, roundedPx: number|null}}
 */
export function subtitleLineStepPx(input = {}) {
  const step = subtitleLineStep(input?.style);
  const fontSizePx = Number(input?.fontSizePx);
  const usable = Number.isFinite(fontSizePx) && fontSizePx > 0;
  const px = usable ? fontSizePx * step.em : null;
  return {
    ...step,
    fontSizePx: usable ? fontSizePx : null,
    px,
    roundedPx: px === null ? null : Math.max(1, Math.round(px)),
  };
}
