/**
 * 字幕底色框几何（S53 · B-SUB1-R27-027 · ADR-R28-01）
 *
 * 一行一个字幕矩形。**只算几何，不画、不读 DOM**：输入是计划层已经定死的
 * `lines`（`planSubtitleLines()` 的输出）、当前样式与舞台尺寸，输出是每行矩形的
 * 舞台坐标。预览拿它画 `div[data-subtitle-box]`，成片侧（副线2 的 P49）拿它
 * 生成 ASS 的 `{\p1}` 矢量矩形 —— **同一组数字，两个渲染器**。
 *
 * ## 为什么不用 BorderStyle=3
 *
 * ASS 的 `BorderStyle 3` 确实能画实心底色，但它把**描边通道换成了底色通道**：
 * 开了底色就没有描边（S51 实测，R28 派工里也复述过）。「描边 + 底色」单条 Style
 * 表达不了，所以底色必须走独立矢量矩形（ADR-R28-01）。反过来，预览这边也**不能**
 * 用 `box-shadow` / `text-shadow` 模拟底色：那会跟着描边的环一起外扩，框会吃到字。
 *
 * ## 坐标口径
 *
 * - 全部是**舞台坐标**：`(0,0)` 是舞台左上，单位 px，不乘任何 `scale`。
 *   成片那边用 `PlayRes` 时再乘「交付画布 ÷ 舞台」，两边各自只做一次换算。
 * - `x/w` 是**字形墨迹**（ink）的左右边界，不是排版 advance 盒：
 *   `x = advanceX + inkLeft`、`w = inkRight − inkLeft`。
 *   两者差的是字体的 side bearing —— Heiti SC 的 CJK 每侧约 0.06em（32px→1.9px、
 *   45px→2.7px），直接拿 advance 当框宽会宽出 0.12em。advance 盒同时给在
 *   `advanceX/advanceW`，要「含行尾空格的行宽」时用它。
 * - `y` 是**行盒顶**，`h = lineHeightPx`（S50 标定的 `SUBTITLE_LINE_STEP_K = 1`，
 *   即 `h = Fontsize`）。字形墨迹比行盒略矮（约 1~2px），这是字体度量，不是误差。
 *
 * ## 度量从哪来（Range 还是 canvas）
 *
 * 两个都用，各管一段，原因写死在实现里：
 *
 * | 量 | 来源 | 为什么 |
 * |---|---|---|
 * | 每行 advance 宽 + 行盒位置 | `Range.getBoundingClientRect()` | 浏览器**真的排过版**：断点、空格、字距、`text-align` 全在里面。canvas 只认一个字体串，排不了「这一行」 |
 * | 字形左右 bearing | canvas `measureText().actualBoundingBox*` | Range 只给 advance 盒，给不出墨迹；bearing 是**字体度量**，与断行无关 |
 *
 * 所以本模块的入参把两者拆开：`advanceRects`（Range 的结果，可选）+ `metrics`
 * （bearing，可选）。都不给时按 canvas → 估算（`estimateAdvanceEm`，与计划层同一套
 * 宽度模型）降级，`source` 字段如实标注 —— 估算**不含 bearing**，只用于没有浏览器
 * 的环境（Node 单测）。
 *
 * ## padding / 圆角
 *
 * 默认水平 `0.15em`、垂直 `0.08em`、圆角 `0.2em`（em = 取整后的 `Fontsize`）。
 * 这三个数都是**相对视觉外沿**算的：框还要再让开一个描边环半径（`outlinePx`），
 * 否则粗描边会戳出框外（bold-outline 的 0.22em 描边实测戳出 3px，A2 会红）。
 * 也就是说 `boxes` = 行盒 + padding + `outlinePx`，而 `lines` 仍是纯文字行盒。
 * 可以用入参 `padding` / `radius` 覆盖（px），**没有**往 `SUBTITLE_STYLE_DEFAULTS`
 * 里加字段：样式表是预览与成片共用的，多一个只有预览认识的字段，就多一处
 * 「预览一套、成片一套」的分叉。圆角在 ASS 里做不到（直角），见 README §15 的契约。
 *
 * @typedef {{text: string, x: number, y: number, w: number, h: number,
 *   advanceX: number, advanceW: number}} SubtitleLineBox
 * @typedef {{x: number, y: number, w: number, h: number}} Rect
 */

import { estimateAdvanceEm, measureTextEm } from '../film-core/subtitle-layout.mjs';
import { normalizeSubtitleStyle, toCssStyle } from './subtitle-style.mjs';

export const SUBTITLE_BOX_VERSION = 1;

/** 水平 padding（× em）。 */
export const SUBTITLE_BOX_PADDING_X_EM = 0.15;
/** 垂直 padding（× em）。 */
export const SUBTITLE_BOX_PADDING_Y_EM = 0.08;
/** 圆角半径（× em）。预览用 CSS `border-radius`；ASS 里没有圆角。 */
export const SUBTITLE_BOX_RADIUS_EM = 0.2;

/** @param {number} n @param {number} [digits] */
function round(n, digits = 3) {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

/** @param {unknown} v @returns {number} */
function finite(v) {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

/** @param {unknown} v @returns {boolean} */
function isPositive(v) {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) && n > 0;
}

/**
 * 用 canvas 量一行字的 advance 与**字形墨迹**的左右偏移。
 *
 * 返回的 `inkLeft` 是「墨迹左边界相对 advance 起点」的**有符号**偏移（正 = 在起点右侧），
 * `inkRight` 是「墨迹右边界相对 advance 起点」的偏移。Chrome 的
 * `actualBoundingBoxLeft` 用「向左为正」的约定（正常字形是负数），所以这里取反；
 * 这一条在 S53 的 A1 里用像素量过（32px 的 0.06em bearing → 2.0px）。
 *
 * @param {{fontFamily: string, fontWeight: number|string, fontSizePx: number,
 *   createCanvas?: () => any}} font
 * @returns {(text: string) => {advance: number, inkLeft: number, inkRight: number} | null}
 */
export function createCanvasMeasurer(font) {
  const canvas = typeof font.createCanvas === 'function'
    ? font.createCanvas()
    : typeof globalThis.document?.createElement === 'function'
      ? globalThis.document.createElement('canvas')
      : null;
  if (!canvas || typeof canvas.getContext !== 'function') return () => null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => null;
  ctx.font = `${font.fontWeight} ${font.fontSizePx}px ${font.fontFamily}`;
  return (text) => {
    if (typeof text !== 'string') return null;
    const m = ctx.measureText(text);
    if (!m || !Number.isFinite(m.width)) return null;
    const left = Number.isFinite(m.actualBoundingBoxLeft) ? -m.actualBoundingBoxLeft : 0;
    const right = Number.isFinite(m.actualBoundingBoxRight) ? m.actualBoundingBoxRight : m.width;
    return { advance: m.width, inkLeft: left, inkRight: right };
  };
}

/**
 * 按 `text-align` 把一行放进内容区，返回 advance 盒的左边界。
 * @param {number} contentLeft @param {number} contentW @param {number} advanceW @param {string} align
 */
function advanceXFor(contentLeft, contentW, advanceW, align) {
  if (align === 'left') return contentLeft;
  if (align === 'right') return contentLeft + contentW - advanceW;
  return contentLeft + (contentW - advanceW) / 2;
}

/**
 * 算每行矩形的舞台坐标。
 *
 * @param {{
 *   style?: any,
 *   stage: {w: number, h: number},
 *   lines?: string[],
 *   metrics?: Array<{advance: number, inkLeft?: number, inkRight?: number} | null>,
 *   advanceRects?: Array<{x?: number, y?: number, w?: number} | null>,
 *   measurer?: (text: string) => ({advance: number, inkLeft?: number, inkRight?: number} | null),
 *   padding?: {x?: number, y?: number},
 *   radius?: number,
 *   cache?: Map<string, {advance: number, inkLeft: number, inkRight: number} | null>
 * }} input
 * @returns {{version: number, source: string, stage: {w: number, h: number},
 *   fontSizePx: number, lineHeightPx: number, outlinePx: number, bottomPx: number, sideSafePx: number,
 *   textOffsetPx: number, textAlign: string,
 *   lines: SubtitleLineBox[], boxes: Array<Rect & {radius: number}>,
 *   block: Rect, padding: {x: number, y: number, em: {x: number, y: number}}, radius: number}}
 */
export function measureSubtitleLines(input) {
  const stage = input?.stage;
  if (!stage || !isPositive(stage.w) || !isPositive(stage.h)) {
    throw new TypeError('measureSubtitleLines 需要 stage {w>0, h>0}');
  }
  const { style } = normalizeSubtitleStyle(input?.style ?? undefined);
  const css = toCssStyle(style, stage);
  const list = Array.isArray(input?.lines) ? input.lines.map((line) => String(line ?? '')) : [];
  const em = css.fontSizePx;
  /* 覆盖值是 px，**0 是合法值**（贴边），只有「没给 / 不是有限数」才回默认 */
  /** @param {unknown} v */
  const nonNegative = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0;
  };
  const padIn = input?.padding ?? {};
  const padding = {
    x: nonNegative(padIn.x) ? Number(padIn.x) : round(em * SUBTITLE_BOX_PADDING_X_EM, 3),
    y: nonNegative(padIn.y) ? Number(padIn.y) : round(em * SUBTITLE_BOX_PADDING_Y_EM, 3)
  };
  const radius = nonNegative(input?.radius) ? Number(input.radius) : round(em * SUBTITLE_BOX_RADIUS_EM, 3);
  const contentLeft = css.sideSafePx;
  const contentW = stage.w - contentLeft * 2;
  const lineHeightPx = css.lineHeightPx;
  const blockH = list.length * lineHeightPx;
  /* 块底 = 舞台底 − 安全区 − 半行距补偿（S50：文字相对块底上移 textOffsetPx） */
  const blockTop = stage.h - css.bottomPx - css.textOffsetPx - blockH;

  const metricsIn = Array.isArray(input?.metrics) ? input.metrics : [];
  const rectsIn = Array.isArray(input?.advanceRects) ? input.advanceRects : [];
  const cache = input?.cache instanceof Map ? input.cache : null;
  const measurer = typeof input?.measurer === 'function' ? input.measurer : null;
  const fontKey = `${em}|${css.fontWeight}|${style.fontFamily}`;
  const canvasMeasure = measurer ? null : createCanvasMeasurer({ fontFamily: style.fontFamily, fontWeight: css.fontWeight, fontSizePx: em });

  /** @type {Set<string>} */
  const sources = new Set();
  /** @type {SubtitleLineBox[]} */
  const lines = [];
  for (let i = 0; i < list.length; i += 1) {
    const text = String(list[i] ?? '');
    const given = metricsIn[i];
    let metric = null;
    let source = 'metrics';
    if (given && Number.isFinite(Number(given.advance))) {
      metric = {
        advance: Number(given.advance),
        inkLeft: Number.isFinite(Number(given.inkLeft)) ? Number(given.inkLeft) : 0,
        inkRight: Number.isFinite(Number(given.inkRight)) ? Number(given.inkRight) : Number(given.advance)
      };
    } else {
      const key = `${fontKey}|${text}`;
      const cached = cache?.get(key);
      if (cached) {
        metric = cached;
        source = 'measurer';
      } else if (measurer || canvasMeasure) {
        const got = (measurer ?? canvasMeasure)?.(text) ?? null;
        if (got && Number.isFinite(Number(got.advance))) {
          metric = {
            advance: Number(got.advance),
            inkLeft: Number.isFinite(Number(got.inkLeft)) ? Number(got.inkLeft) : 0,
            inkRight: Number.isFinite(Number(got.inkRight)) ? Number(got.inkRight) : Number(got.advance)
          };
          source = measurer ? 'measurer' : 'canvas';
          cache?.set(key, metric);
        }
      }
      if (!metric) {
        /* 没有浏览器：按计划层同一套宽度模型估。**不含 bearing**（inkLeft=0）——
           估算只配用来验算法，不能拿去对像素。 */
        const advance = round(measureTextEm(text) * em, 3);
        metric = { advance, inkLeft: 0, inkRight: advance };
        source = 'estimate';
      }
    }
    sources.add(source);

    const candidate = rectsIn[i] ?? null;
    const rect = candidate && Number.isFinite(Number(candidate.w)) ? candidate : null;
    const advanceW = rect ? Number(rect.w) : metric.advance;
    const advanceX = rect && Number.isFinite(Number(rect.x))
      ? Number(rect.x)
      : advanceXFor(contentLeft, contentW, advanceW, String(style.align));
    const y = rect && Number.isFinite(Number(rect.y)) ? Number(rect.y) : blockTop + i * lineHeightPx;
    /* 空行没有墨迹：宽度记 0，别拿一个空格宽冒充（与 measureLineWidths 同口径） */
    const inkLeft = text === '' ? 0 : metric.inkLeft;
    const inkRight = text === '' ? 0 : metric.inkRight;
    lines.push({
      text,
      x: round(advanceX + inkLeft, 3),
      y: round(y, 3),
      w: round(Math.max(0, inkRight - inkLeft), 3),
      h: round(lineHeightPx, 3),
      advanceX: round(advanceX, 3),
      advanceW: round(advanceW, 3)
    });
  }

  /* 描边环（text-shadow 环）是对称外扩，半径就是 `outlinePx`；底色框必须让开它，
     否则 0.22em 的粗描边会戳出框外（S53-A2 的 bold-outline 实测 −3.03px）。 */
  const outlinePx = css.outlinePx;
  const padX = padding.x + outlinePx;
  const padY = padding.y + outlinePx;
  const boxes = lines.map((line) => ({
    x: round(line.x - padX, 3),
    y: round(line.y - padY, 3),
    w: round(line.w + padX * 2, 3),
    h: round(line.h + padY * 2, 3),
    radius: round(radius, 3)
  }));

  let block = { x: 0, y: 0, w: 0, h: 0 };
  if (boxes.length > 0) {
    const left = Math.min(...boxes.map((box) => box.x));
    const top = Math.min(...boxes.map((box) => box.y));
    const right = Math.max(...boxes.map((box) => box.x + box.w));
    const bottom = Math.max(...boxes.map((box) => box.y + box.h));
    block = { x: round(left, 3), y: round(top, 3), w: round(right - left, 3), h: round(bottom - top, 3) };
  }

  return {
    version: SUBTITLE_BOX_VERSION,
    source: sources.size === 1 ? /** @type {string} */ ([...sources][0] ?? 'empty') : sources.size === 0 ? 'empty' : 'mixed',
    stage: { w: stage.w, h: stage.h },
    fontSizePx: em,
    lineHeightPx: round(lineHeightPx, 3),
    /** 描边环半径（= ASS 的 `Outline` 口径）；框的展开量里已经含它 */
    outlinePx: round(outlinePx, 3),
    bottomPx: round(css.bottomPx, 3),
    sideSafePx: round(contentLeft, 3),
    textOffsetPx: round(css.textOffsetPx, 3),
    textAlign: String(style.align),
    lines,
    boxes,
    block,
    padding: {
      x: round(padding.x, 3),
      y: round(padding.y, 3),
      em: { x: SUBTITLE_BOX_PADDING_X_EM, y: SUBTITLE_BOX_PADDING_Y_EM }
    },
    radius: round(radius, 3)
  };
}

/**
 * 给副线2 的 ASS 契约：把舞台坐标换成 `PlayRes` 坐标（交付画布）。
 *
 * `scale = min(canvas.w / stage.w, canvas.h / stage.h)`（letterbox 口径，与
 * `packages/render/subtitles.mjs` 的 layout 一致），**只做一次**：
 * 舞台坐标 × scale + offset。矩形本身是 `{\an7\pos(x,y)\p1}m 0 0 l w 0 l w h l 0 h{\p0}`，
 * 其中 `\pos` 是**左上角**（`\an7`）。
 *
 * @param {Rect} rect 舞台坐标
 * @param {{stage: {w: number, h: number}, canvas: {w: number, h: number},
 *   scale?: number, offset?: {x: number, y: number}}} layout
 * @returns {{x: number, y: number, w: number, h: number, scale: number}}
 */
export function boxToPlayRes(rect, layout) {
  const stage = layout?.stage;
  const canvas = layout?.canvas;
  if (!stage || !canvas || !isPositive(stage.w) || !isPositive(stage.h)) {
    throw new TypeError('boxToPlayRes 需要 stage 与 canvas');
  }
  const scale = Number.isFinite(Number(layout.scale))
    ? Number(layout.scale)
    : Math.min(canvas.w / stage.w, canvas.h / stage.h);
  const offset = layout.offset && Number.isFinite(Number(layout.offset.x))
    ? { x: Number(layout.offset.x), y: Number(layout.offset.y) }
    : {
        x: (canvas.w - stage.w * scale) / 2,
        y: (canvas.h - stage.h * scale) / 2
      };
  return {
    x: round(offset.x + rect.x * scale, 2),
    y: round(offset.y + rect.y * scale, 2),
    w: round(rect.w * scale, 2),
    h: round(rect.h * scale, 2),
    scale: round(scale, 6)
  };
}

/**
 * 估算一行在给定样式下的宽度（em），供没有浏览器的地方做**量级**校验。
 * 直接转计划层的模型，避免两套宽度表。
 * @param {string} text
 */
export function estimateLineEm(text) {
  const raw = String(text ?? '');
  if (raw === '') return 0;
  let sum = 0;
  for (const ch of raw) sum += estimateAdvanceEm(ch);
  return sum;
}
