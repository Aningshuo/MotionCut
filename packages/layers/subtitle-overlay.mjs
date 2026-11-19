/**
 * 舞台字幕覆盖层（S23 · B-SUB1-R12-012）
 *
 * **接口由大脑冻结**（任务书 4.1）：导出符号、`opts` 键名、`SUBTITLE_STYLE_DEFAULTS` 字段名
 * 一个都不许改。主线按同一份写并挂上来，改名就是接缝事故。
 *
 * 分工：本模块**只画**。不读 `.vtt`、不解析、不写 `film.html`、不认识时间线。
 * 宿主把「已经排好序的 cue 数组」和「当前播放秒」喂进来，本模块负责：
 * 命中哪一条（二分 + 重叠取 start 最大）、怎么换行/截断、底部安全区、CPS 提示、事件穿透。
 *
 * ## 用法（宿主）
 *
 * ```js
 * const sub = mountSubtitleOverlay(stageEl, {
 *   getCues: () => cues,          // [{start, end, text}, …]
 *   getTime: () => player.currentTime,
 *   getStage: () => ({ x: 0, y: 0, w: 1280, h: 720 }),
 *   onError: (info) => console.warn(info.code, info.message)
 * });
 * player.on('timeupdate', () => sub.render());   // 组件不自起时钟
 * ```
 *
 * ## 硬约束（验收会逐条查）
 *
 * | 要求 | 实现 |
 * |---|---|
 * | 取 cue | 按 start 排序后二分（`start <= t < end`），重叠取 **start 最大**，不拼接 |
 * | 换行 | **共享计划层**（`planSubtitleLines`）：`lines.join('\n')` + `white-space:pre`，CSS 不折行；超 `maxLines` 由计划层截断加 `…` |
 * | 可见宽（S74）| 宿主用 `getVisibleWidth()` 给舞台像素宽（`computeVisibleWidth()` 从 fit + 画布算）；letterbox 下 = `stage.w`，没给 = 全宽 |
 * | 安全区 | `bottom = bottomSafeRatio × 舞台高`；舞台尺寸变了清缓存重排 |
 * | CPS | `去空白字符数 ÷ 时长 > cpsWarn` → `data-cps-warn="true"` + 描边转黄 + 角标；只提示不拦 |
 * | 穿透 | 覆盖层与**所有子节点** `pointer-events:none`（S17 手势能在字幕上起手） |
 * | 不静默 | 非法 cue 跳过 + `SUBTITLE_BAD_CUE`（同码只报一次）；没给 `onError` 就 `console.warn` |
 * | 不自起时钟 | 没有 rAF / interval；只有 `render(t?)` 被调用才画 |
 * | 清理 | `destroy()` 移除节点与监听，`body` 子节点数回到初始 |
 *
 * ## 行排（S45 · B-SUB1-R23-023 · ADR-R24-01/02）
 *
 * 折行与截断**不再由 CSS 决定**：每条 cue 先过 `planSubtitleLines()`（`packages/film-core/
 * subtitle-layout.mjs`，大脑冻结的共享纯函数），把 `lines.join('\n')` 写进 `textContent`，
 * 文本节点与测量节点都是 `white-space: pre` —— 浏览器不再自己折行。
 *
 * 为什么必须这样：libass **只在空格处断行**，CSS 的 `overflow-wrap:anywhere` 能在任意字间断。
 * 同一条纯中文长句，预览两行、成片一行且左右都被画布裁掉（S43 实测，R24-C1）。
 * 只要两边吃**同一组 lines**（预览用 `\n`、成片用 `toAssText()` 的 `\N`），这个差异就不存在。
 *
 * 连带改掉的三件事：
 * - 高度 = `lines.length × lineHeightPx`，**不再**用隐藏节点量完再二分找前缀加「…」；
 *   `truncated` 由计划层给（它按同一套宽度估算截断）。
 * - 行宽改成「逐行量自然宽」并放进 `getState().lineWidthsPx`，用来证明最宽的一行没超过可用宽。
 * - S39 那个「祖先 transform 放大导致误判溢出」的问题**从根上消失**：几何全是算出来的，
 *   不读 `getBoundingClientRect().height`。逐行量宽仍会除以实际缩放（见 `measureLineWidths`）。
 *
 * ## 样式（S41 · B-SUB1-R21-021）
 *
 * `opts.style` / `updateStyle(patch)` 都先过 `normalizeSubtitleStyle`（`subtitle-style.mjs`）：
 * 缺省合并、范围钳制，非法值**给 issue 并回退默认**（`onError` 收到一次
 * `SUBTITLE_STYLE_INVALID`，消息里列出所有被拒字段）。老字段名
 * `strokeColor` / `strokeWidthRatio` 仍收（映射到 `outlineColor` / `outlineRatio`）。
 *
 * 预览与成片的默认值来自**同一处**（`subtitle-style.mjs`），所以不会再出现
 * 「预览一套、成片另一套」。本模块只用 CSS 口径；成片的 ASS 口径见 `toAssStyle()`。
 */

import {
  SUBTITLE_STYLE_DEFAULTS as CANONICAL_STYLE,
  applyStylePreset,
  normalizeSubtitleStyle,
  toCssDecor,
  toCssStyle
} from './subtitle-style.mjs';
import { planSubtitleLines } from '../film-core/subtitle-layout.mjs';
import { SUBTITLE_BOX_PADDING_X_EM, SUBTITLE_BOX_PADDING_Y_EM, measureSubtitleLines } from './subtitle-box.mjs';

export const SUBTITLE_OVERLAY_VERSION = 1;

/**
 * 舞台的**可见宽**（S74 · 与成片同一套规则）。
 *
 * 成片侧（`render/subtitles.mjs` 的 `subtitleViewFor`）算的是
 * `min(舞台宽, 画布宽 / scale)`：`letterbox` 下画布宽 / scale ≥ 舞台宽 → 取舞台宽
 * （一个字都不多放）；`cover` 下画布被放大后左右裁掉，可见宽只有 `画布宽 / scale`。
 * 预览以前**没传**这个值，于是 16:9 工程按 1280 排行、9:16 成片却按 405 排行——
 * 同一句字幕两边行数都不一样（用户看到的是「预览坏了」）。
 *
 * 这里把同一条规则做成纯函数，给宿主（Studio）与测试共用：
 * - `fit` 缺省/不认识 → 按 `letterbox` 处理（旧工程预览不变形）；
 * - 没有画布信息 → 也按 `letterbox`（返回舞台宽）；
 * - 单位与 `stage` 相同（缩放过的预览传缩放后的矩形，结果自然也在同一坐标里）。
 *
 * @param {{ fit?: string|null, stage: { w: number, h: number }, canvas?: { w?: number, h?: number }|null }} input
 * @returns {number} 可见宽（与 `stage.w` 同一单位，永远 ≤ stage.w）
 */
export function computeVisibleWidth(input) {
  const stageW = Number(input?.stage?.w);
  const stageH = Number(input?.stage?.h);
  if (!Number.isFinite(stageW) || stageW <= 0) return 0;
  const fit = String(input?.fit ?? '').toLowerCase();
  // 只认 cover；letterbox / null / 拼错 一律按「全宽可见」——宁可多放字，也不凭空缩窄。
  if (fit !== 'cover') return stageW;
  const canvasW = Number(input?.canvas?.w);
  const canvasH = Number(input?.canvas?.h);
  if (!(canvasW > 0) || !(canvasH > 0) || !(stageH > 0)) return stageW;
  const scale = Math.max(canvasW / stageW, canvasH / stageH);
  if (!Number.isFinite(scale) || scale <= 0) return stageW;
  const visible = canvasW / scale;
  if (!Number.isFinite(visible) || visible <= 0) return stageW;
  return Math.min(stageW, visible);
}

/**
 * @typedef {object} SubtitleCue
 * @property {number} start  秒（含）
 * @property {number} end    秒（不含）
 * @property {string} text   UTF-8，可含 \n
 */

/**
 * 默认样式（S23 冻结的 11 个字段名，值为**派生**而非复写）。
 *
 * 为什么是派生：S41 起样式真相在 `subtitle-style.mjs`（`SUBTITLE_STYLE_DEFAULTS`），
 * 这里再抄一份默认值 = 两份真相 = 迟早「预览一套、成片另一套」。所以这里只做**改名**：
 * `outlineColor → strokeColor`、`outlineRatio → strokeWidthRatio`（同义，见那张别名表）。
 *
 * 唯一一处值的变化：`strokeColor` 从 `rgba(0,0,0,0.85)` 变成不透明黑。成片一直烧的是
 * `&H00000000`（全不透明），预览却是 85% 黑——这 15% 的差是历史遗留，S41 的 A1
 * 要求「默认零漂移」，不改 render 就只能把预览对齐上去。
 */
export const SUBTITLE_STYLE_DEFAULTS = Object.freeze({
  fontFamily: CANONICAL_STYLE.fontFamily,
  fontSizeRatio: CANONICAL_STYLE.fontSizeRatio, // 相对舞台高
  color: CANONICAL_STYLE.color,
  strokeColor: CANONICAL_STYLE.outlineColor,
  strokeWidthRatio: CANONICAL_STYLE.outlineRatio, // 相对字号
  background: CANONICAL_STYLE.background,
  align: CANONICAL_STYLE.align, // left | center | right
  lineHeight: CANONICAL_STYLE.lineHeight,
  maxLines: CANONICAL_STYLE.maxLines,
  bottomSafeRatio: CANONICAL_STYLE.bottomSafeRatio, // 相对舞台高
  cpsWarn: CANONICAL_STYLE.cpsWarn // 字符/秒，超了标黄提示，不阻止
});

/** CPS 超限时的视觉提示色（描边 + 角标）。不进入冻结的 style 字段。 */
const CPS_WARN_COLOR = '#ffd166';
/** 左右安全边（内部常量：不属于冻结接口，只是别让字贴到画面边）。 */
const SIDE_SAFE_RATIO = 0.04;
/** 覆盖层 z-index：在舞台内容之上、手势层（40）之下。 */
const OVERLAY_Z = 30;

/** @param {number} n @param {number} [digits] */
function round(n, digits = 2) {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

/** 去空白后的字符数（按码点算，中文一个算一个）。 @param {string} text */
export function subtitleChars(text) {
  return [...String(text ?? '').replace(/\s+/gu, '')].length;
}

/**
 * CPS = 去空白字符数 ÷ 时长。时长非正 → Infinity（宿主该先过滤非法 cue）。
 * @param {string} text @param {number} start @param {number} end
 */
export function subtitleCps(text, start, end) {
  const span = Number(end) - Number(start);
  if (!Number.isFinite(span) || span <= 0) return Number.POSITIVE_INFINITY;
  return subtitleChars(text) / span;
}

/**
 * 校验并归一一条 cue；非法返回 `{ok:false, code, message}`。
 * 规则（冻结）：`start/end` 必须有限数、`end > start`、`text` 必须是字符串。
 * @param {any} cue
 * @returns {{ok: boolean, code: string, message: string, cue: SubtitleCue | null}}
 */
export function validateSubtitleCue(cue) {
  if (!cue || typeof cue !== 'object') {
    return { ok: false, code: 'SUBTITLE_BAD_CUE', message: 'cue 不是对象', cue: null };
  }
  const start = Number(/** @type {any} */ (cue).start);
  const end = Number(/** @type {any} */ (cue).end);
  const text = /** @type {any} */ (cue).text;
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return { ok: false, code: 'SUBTITLE_BAD_CUE', message: `cue 的 start/end 不是有限数：${String(cue.start)} / ${String(cue.end)}`, cue: null };
  }
  if (!(end > start)) {
    return { ok: false, code: 'SUBTITLE_BAD_CUE', message: `cue 的 end(${end}) 必须大于 start(${start})`, cue: null };
  }
  if (typeof text !== 'string') {
    return { ok: false, code: 'SUBTITLE_BAD_CUE', message: `cue 的 text 必须是字符串（收到 ${Object.prototype.toString.call(text)}）`, cue: null };
  }
  return { ok: true, code: '', message: '', cue: { start, end, text } };
}

/**
 * 在**已按 start 升序**的数组里找命中 `t` 的 cue：`start <= t < end`，重叠时取 start 最大。
 * 返回下标（找不到 −1）。
 * @param {readonly SubtitleCue[]} sorted
 * @param {number} t
 */
export function findCueIndex(sorted, t) {
  if (!Array.isArray(sorted) || sorted.length === 0 || !Number.isFinite(t)) return -1;
  /* 二分：最后一个 start <= t */
  let lo = 0;
  let hi = sorted.length - 1;
  let last = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cue = sorted[mid];
    if (cue && cue.start <= t) {
      last = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  /* 从 last 往回找第一条 end > t 的：它就是 start 最大的命中（同 start 时取后插入的那条） */
  for (let i = last; i >= 0; i -= 1) {
    const cue = sorted[i];
    if (cue && cue.end > t) return i;
  }
  return -1;
}

/**
 * @param {HTMLElement} container  舞台容器（覆盖层挂在这里，绝对定位铺满舞台）
 * @param {{
 *   getCues: () => SubtitleCue[],
 *   getTime: () => number,
 *   getStage?: () => ({x:number,y:number,w:number,h:number}|null),
 *   getVisibleWidth?: () => number|null,
 *   getFontSizePx?: () => number|null,
 *   style?: object,
 *   onError?: (info: {code: string, message: string}) => void
 * }} opts
 * @returns {{
 *   destroy: () => void,
 *   render: (time?: number) => void,
 *   setVisible: (visible: boolean) => void,
 *   getState: () => object,
 *   updateStyle: (patch: object) => void
 * }}
 */
export function mountSubtitleOverlay(container, opts) {
  if (!container || typeof container.appendChild !== 'function') {
    throw new Error('mountSubtitleOverlay 需要一个容器元素');
  }
  if (!opts || typeof opts.getCues !== 'function') {
    throw new Error('mountSubtitleOverlay 需要 opts.getCues（返回已排序的 cue 数组）');
  }
  if (typeof opts.getTime !== 'function') {
    throw new Error('mountSubtitleOverlay 需要 opts.getTime（当前播放秒）');
  }

  const doc = container.ownerDocument ?? /** @type {Document} */ (globalThis.document);
  const win = doc.defaultView ?? globalThis;

  /**
   * 样式走 `normalizeSubtitleStyle`（S41）：缺省合并 + 范围钳制，非法值给 issue 并回退默认。
   * 老字段名（`strokeColor` / `strokeWidthRatio`）在 normalize 里被映射成
   * `outlineColor` / `outlineRatio`，所以 S23 的调用方不用改代码。
   */
  const normalized = normalizeSubtitleStyle(opts.style);
  /* 两份样式：`baseStyle` 是**存盘的那份**（只有 preset 这个 id，没有派生值），
     `style` 是展开 preset 之后给渲染读的那份。分开存是因为「切回默认」必须真的切回去 ——
     只留展开值的话，从底框切到默认时 rgba(0,0,0,.62) 会赖在样式里不走。 */
  /** @type {any} */
  let baseStyle = normalized.style;
  /** @type {any} */
  let style = applyStylePreset(baseStyle);
  /** @type {Array<{code: string, field: string, value: unknown, fallback: unknown, message: string}>} */
  let styleIssues = normalized.issues;

  const state = {
    version: SUBTITLE_OVERLAY_VERSION,
    visible: true,
    destroyed: false,
    time: 0,
    text: '',
    cue: /** @type {SubtitleCue | null} */ (null),
    stage: /** @type {{x:number,y:number,w:number,h:number} | null} */ (null),
    fontSize: 0,
    /** 未取整的字号（对照用；真正画的是 fontSize） */
    exactFontSize: 0,
    /** 预览描边的外扩半径（= ASS Outline）与投影位移（= ASS Shadow） */
    outlinePx: 0,
    shadowPx: 0,
    fontWeight: 400,
    lineHeightPx: 0,
    /** S50：文字相对块底的上移量（半行距补偿） */
    textOffsetPx: 0,
    bottom: 0,
    lines: 0,
    overflow: false,
    /** 计划层的产出（lines / truncated / capacityEm / maxLines / widthsEm），S45 起是行的唯一来源 */
    plan: /** @type {any} */ (null),
    /** S74：这一帧排版的可见宽（舞台像素；没给宿主就是 stage.w） */
    visibleWidth: 0,
    /** S74：这一帧的 CSS 几何（可能已按成片字号折算）与描边环用的「虚拟舞台」 */
    css: /** @type {any} */ (null),
    decorStage: /** @type {{w:number,h:number}|null} */ (null),
    /** 逐行自然宽（布局 px，已除祖先缩放）与其中最大值；availableWidthPx 是可用宽 */
    lineWidthsPx: /** @type {number[]} */ ([]),
    maxLineWidthPx: 0,
    availableWidthPx: 0,
    /** S53：每行底色框（舞台坐标）与块并集；`background: transparent` 时全空 */
    boxes: /** @type {Array<{x: number, y: number, w: number, h: number, radius: number}>} */ ([]),
    /** S53：每行**文字**矩形（不含 padding），坐标与 `boxes` 同一套 */
    lineBoxes: /** @type {Array<{text: string, x: number, y: number, w: number, h: number, advanceX: number, advanceW: number}>} */ ([]),
    block: /** @type {{x: number, y: number, w: number, h: number} | null} */ (null),
    boxSource: '',
    boxPadding: { x: 0, y: 0 },
    boxRadius: 0,
    cps: 0,
    warn: false,
    skipped: 0,
    rendered: 0,
    reported: /** @type {string[]} */ ([])
  };

  /* ── DOM ─────────────────────────────────────────────────────────────── */

  const overlay = doc.createElement('div');
  overlay.setAttribute('data-subtitle-overlay', '');
  overlay.setAttribute('data-subtitle-version', String(SUBTITLE_OVERLAY_VERSION));
  overlay.style.cssText = [
    'position:absolute',
    'left:0',
    'top:0',
    'width:100%',
    'height:100%',
    'overflow:hidden',
    'pointer-events:none',
    `z-index:${OVERLAY_Z}`,
    'contain:layout style'
  ].join(';');

  /* 底色框层（S53）：在文字**下方**，每行一个 `div[data-subtitle-box]`。
     单独一层而不是塞进 textEl：位置全是舞台坐标，不依赖 box 的行盒高度，
     `textOffsetPx` 那半行距也不会把框带着走。 */
  const boxLayer = doc.createElement('div');
  boxLayer.setAttribute('data-subtitle-box-layer', '');
  boxLayer.style.cssText = [
    'position:absolute',
    'left:0',
    'top:0',
    'width:100%',
    'height:100%',
    'pointer-events:none'
  ].join(';');

  const box = doc.createElement('div');
  /* 注意：`data-subtitle-box` 是**每行**那个框的属性（S53 起的语义），
     外层容器用 `data-subtitle-layer`，两者别混（验收数的是 `[data-subtitle-box]`）。 */
  box.setAttribute('data-subtitle-layer', '');
  box.style.cssText = ['position:absolute', 'left:0', 'right:0', 'bottom:0', 'pointer-events:none', 'box-sizing:border-box'].join(';');

  const textEl = doc.createElement('span');
  textEl.setAttribute('data-subtitle-text', '');
  textEl.setAttribute('data-cps-warn', 'false');
  textEl.style.cssText = [
    'display:block',
    'pointer-events:none',
    /* S45：行由计划层定死，只认 \n；**不折行**（pre 保留空格与换行，不自动断） */
    'white-space:pre',
    'box-sizing:border-box',
    'text-align:center'
  ].join(';');

  const badge = doc.createElement('span');
  badge.setAttribute('data-subtitle-cps-badge', '');
  badge.style.cssText = [
    'position:absolute',
    'right:0',
    'top:-1.35em',
    'display:none',
    'pointer-events:none',
    `color:${CPS_WARN_COLOR}`,
    'font:600 11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace',
    'background:rgba(0,0,0,0.55)',
    'border-radius:3px',
    'padding:1px 4px',
    'white-space:nowrap'
  ].join(';');

  /* 测量节点：量**自然行宽**用（`width:max-content` + `pre`，一行一行量）。
     `visibility:hidden` 仍然参与排版（`display:none` 不参与）。 */
  const measureEl = doc.createElement('div');
  measureEl.setAttribute('data-subtitle-measure', '');
  measureEl.style.cssText = [
    'position:absolute',
    'left:-99999px',
    'top:0',
    'visibility:hidden',
    'pointer-events:none',
    'white-space:pre',
    'box-sizing:border-box'
  ].join(';');

  box.appendChild(textEl);
  box.appendChild(badge);
  overlay.appendChild(boxLayer);
  overlay.appendChild(box);
  overlay.appendChild(measureEl);
  container.appendChild(overlay);

  /* ── 读宿主 ──────────────────────────────────────────────────────────── */

  function readStage() {
    let raw = null;
    if (typeof opts.getStage === 'function') {
      try {
        raw = opts.getStage();
      } catch {
        raw = null;
      }
    }
    const hostRect = container.getBoundingClientRect();
    const fallback = { x: hostRect.x, y: hostRect.y, w: hostRect.width, h: hostRect.height };
    if (!raw || typeof raw !== 'object') return fallback;
    const x = Number(/** @type {any} */ (raw).x);
    const y = Number(/** @type {any} */ (raw).y);
    const w = Number(/** @type {any} */ (raw).w);
    const h = Number(/** @type {any} */ (raw).h);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return fallback;
    return { x, y, w, h };
  }

  /** @param {{code: string, message: string}} info */
  function reportError(info) {
    if (state.reported.includes(info.code)) return;
    state.reported.push(info.code);
    if (typeof opts.onError === 'function') {
      opts.onError(info);
      return;
    }
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn(`[subtitle-overlay] ${info.code}: ${info.message}`);
    }
  }

  /**
   * 把 normalize 的 issue 报出去（一次一条，消息里列出**所有**被拒的字段）。
   * 不能一条一条报：`reportError` 按 code 去重，第二个字段就看不见了。
   */
  function reportStyleIssues() {
    if (styleIssues.length === 0) return;
    const detail = styleIssues.map((issue) => `${issue.field || '(样式)'}: ${issue.message}`).join('；');
    reportError({
      code: 'SUBTITLE_STYLE_INVALID',
      message: `${styleIssues.length} 个字幕样式字段被拒并回退默认 —— ${detail}`
    });
  }

  /**
   * cue 数组：引用相等就复用上一次的排序结果（冻结要求）；
   * 换了引用才重排 + 重新校验（非法 cue 跳过并报一次）。
   */
  const cueCache = {
    ref: /** @type {any} */ (null),
    sorted: /** @type {SubtitleCue[]} */ ([])
  };

  function sortedCues() {
    /** @type {any} */
    let raw = [];
    try {
      raw = opts.getCues();
    } catch {
      raw = [];
    }
    if (raw === cueCache.ref) return cueCache.sorted;
    cueCache.ref = raw;
    const list = Array.isArray(raw) ? raw : [];
    /** @type {SubtitleCue[]} */
    const out = [];
    let skipped = 0;
    for (const item of list) {
      const checked = validateSubtitleCue(item);
      if (checked.ok && checked.cue) out.push(checked.cue);
      else {
        skipped += 1;
        reportError({ code: checked.code, message: checked.message });
      }
    }
    state.skipped = skipped;
    out.sort((a, b) => a.start - b.start);
    cueCache.sorted = out;
    return out;
  }

  /* ── 排版 ────────────────────────────────────────────────────────────── */

  /**
   * 把样式写到元素上。**描边不用 `-webkit-text-stroke`**：
   * Chrome 的 text-stroke 是 miter 接头，CJK 尖角会外伸（4K big-caption 竖向多 8px），
   * 而 `stroke-linejoin` 对 text-stroke 无效（S47 实测五种变体 bbox 逐字节相同）。
   * 改用零模糊 `text-shadow` 环做外扩，外扩**恰好等于半径**，令半径 = ASS `Outline` 即对齐。
   * 详见 `subtitle-style.mjs` 的 `cssOutlineRing()`。
   *
   * S74：几何改用 `state.css`（render 里算好、可能按成片字号折算过），不再每次重算
   * ——重算会把 `getFontSizePx()` 的折算值丢掉，预览又回到「比成片小 2.4%」。
   *
   * @param {HTMLElement} el
   * @param {string} [outlineColor] 覆盖描边色（CPS 超速时用提示色）
   */
  function applyTextStyle(el, outlineColor) {
    const css = state.css ?? toCssStyle(style, state.stage ?? { w: 1280, h: 720 });
    el.style.fontFamily = String(style.fontFamily);
    el.style.fontSize = `${css.fontSizePx}px`;
    /* S50：行距用**标定过的 px**，不再用无单位倍数。libass 没有行距字段，
       它的行距就是 Fontsize（`SUBTITLE_LINE_STEP_K` 有实测表），无单位 1.25 会高 0.25em。 */
    el.style.lineHeight = `${css.lineHeightPx}px`;
    el.style.color = String(style.color);
    el.style.textAlign = String(style.align);
    el.style.fontWeight = String(css.fontWeight);
    /* 文字元素自身永远透明：底色走 `boxLayer` 的逐行框（S53），成片那边是 BorderStyle=3，
       两边都是「框在字后面」而不是「文字有底色」。R30 起 box/highlight 两个预设有真底色，
       由 `syncBoxes(geom, style.background)` 画，不在这里。 */
    el.style.background = 'transparent';
    el.style.textShadow =
      outlineColor === undefined
        ? css.textShadow
        : toCssDecor({ ...style, outlineColor }, state.decorStage ?? state.stage ?? { w: 1280, h: 720 }).textShadow;
    /* 上一版用的属性要清掉，否则 `updateStyle` 之后老描边还在 */
    el.style.removeProperty('-webkit-text-stroke-width');
    el.style.removeProperty('-webkit-text-stroke-color');
    el.style.removeProperty('paint-order');
  }

  /**
   * 行排：交给共享计划层（`film-core/subtitle-layout.mjs`，ADR-R24-01）。
   *
   * 计划层只做「文本 + 样式 + 舞台 → 行数组」的纯计算，**不读 DOM**。所以：
   * - 祖先 `transform: scale(N)` 再也不会把行数算错（S39 的坑从根上没了：不量高度）；
   * - 预览与成片吃同一组 `lines` —— 成片那侧由 `toAssText(lines)` 写成 `\N`（副线2 P39 接）。
   *
   * 缓存键含舞台尺寸与全部影响宽度的样式字段；同一句字幕在 timeupdate 里反复渲染不会重算。
   */
  const planCache = { key: '', plan: /** @type {any} */ (null) };

  /**
   * 可见宽（S74）：宿主给的是**舞台像素**（与 `getStage()` 同一坐标），`null` = 没给。
   * 没给就退回「全宽」——旧宿主不会因为这次改动换行。
   * @param {{w: number, h: number}} stage
   * @returns {number|null}
   */
  function readVisibleWidth(stage) {
    if (typeof opts.getVisibleWidth !== 'function') return null;
    try {
      const raw = Number(opts.getVisibleWidth());
      if (!Number.isFinite(raw) || raw <= 0) return null;
      return Math.min(raw, stage.w);
    } catch {
      return null;
    }
  }

  /**
   * 成片字号折算（S74）：宿主给的是**预览屏幕像素**（已经折过交付缩放）。
   * `null` / 非法 = 不给，保持原来的「按预览高度取整」行为（旧宿主零变化）。
   * @returns {number|null}
   */
  function readFontSizeOverride() {
    if (typeof opts.getFontSizePx !== 'function') return null;
    try {
      const raw = Number(opts.getFontSizePx());
      if (!Number.isFinite(raw) || raw <= 0) return null;
      return raw;
    } catch {
      return null;
    }
  }

  /** @param {string} text @param {{w: number, h: number}} stage @param {number|null} visibleWidth */
  function planFor(text, stage, visibleWidth) {
    const key = [
      text,
      round(stage.w, 2),
      round(stage.h, 2),
      style.fontSizeRatio,
      style.fontScale,
      style.lineHeight,
      style.maxLines,
      // 可见宽进缓存键：切交付画幅后同一句字幕必须重排（否则会一直用旧行数）
      visibleWidth === null ? 'none' : round(visibleWidth, 2)
    ].join('\u0000');
    if (planCache.key === key && planCache.plan) return planCache.plan;
    const plan = planSubtitleLines({
      text,
      style,
      stage,
      ...(visibleWidth === null ? {} : { view: { visibleWidth } })
    });
    planCache.key = key;
    planCache.plan = plan;
    return plan;
  }

  /**
   * 逐行量**自然行宽**（布局 px，未经 transform 放大）。
   *
   * 量法：先把测量节点设成 `width: 固定可用宽` 读一次 rect —— `rect.width ÷ 可用宽` 就是祖先链
   * 累积的横向缩放（与 S39 同一个技巧）；再设成 `max-content` 逐行量自然宽，最后除以缩放。
   *
   * 为什么不直接用 `getBoundingClientRect()` 的宽度：舞台可能整体被缩放（预览缩略图），
   * 不除缩放会把 2 倍缩放下的 600px 行宽报成 1200px，判定「超宽」全是假的。
   *
   * @param {string[]} lines @param {number} available 可用宽（布局 px）
   * @returns {number[]}
   */
  function measureLineWidths(lines, available) {
    if (lines.length === 0 || !(available > 0)) return [];
    measureEl.style.width = `${available}px`;
    measureEl.textContent = lines.join('\n');
    const probe = measureEl.getBoundingClientRect();
    const scaleX = probe.width > 0 ? probe.width / available : 1;
    measureEl.style.width = 'max-content';
    /** @type {number[]} */
    const widths = [];
    for (const line of lines) {
      /* 空行没有 ink：宽度记 0，别拿一个空格宽冒充 */
      if (line === '') {
        widths.push(0);
        continue;
      }
      measureEl.textContent = line;
      const rect = measureEl.getBoundingClientRect();
      widths.push(round(scaleX > 0 ? rect.width / scaleX : rect.width, 2));
    }
    measureEl.style.width = `${available}px`;
    measureEl.textContent = '';
    return widths;
  }

  /* ── 底色框（S53）────────────────────────────────────────────────────── */

  /**
   * 底色是不是「看得见的」。`transparent` / `none` / 空 / 全透明的 rgba、hsla
   * 都算没有 —— 全透明的框只增加合成开销，一个节点都不该建（A3 数节点）。
   * @param {unknown} value
   */
  function isVisibleBackground(value) {
    const text = String(value ?? '').trim().toLowerCase();
    if (text === '' || text === 'none' || text === 'transparent' || text === 'initial') return false;
    const fn = /^(?:rgba?|hsla?)\(([^)]*)\)$/.exec(text);
    if (fn) {
      const parts = (fn[1] ?? '').split(/[,/]/).map((part) => part.trim()).filter(Boolean);
      if (parts.length >= 4 && Number(parts[parts.length - 1]) === 0) return false;
    }
    return true;
  }

  /**
   * 用 `Range` 量每行的 advance 盒（舞台坐标）。
   *
   * 为什么是 Range 而不是 canvas：canvas 只认一个字体串，它不知道「计划层把这句话
   * 断在哪个空格上」，也不知道 `text-align` 把这一行摆在哪。Range 量的是浏览器
   * **真的排过版**的那一行 —— 断点、空格、字距全在里面。
   *
   * 文本节点是 `white-space: pre` 的同一棵 DOM（不重建）：按 `\n` 切偏移，
   * `start..start+line.length` 正好是这一行（`\n` 本身不进 Range）。
   *
   * @param {string[]} lines
   * @param {{w: number, h: number}} stage
   * @returns {Array<{x: number, y: number, w: number} | null>}
   */
  function measureLineRects(lines, stage) {
    const key = [
      state.text,
      round(stage.w, 2),
      round(stage.h, 2),
      state.fontSize,
      state.lineHeightPx,
      String(style.align),
      String(style.fontFamily),
      String(state.css?.secondaryScale ?? 1)
    ].join('\u0000');
    if (rangeCache.key === key) return rangeCache.rects;
    const node = textEl.firstChild;
    /** @type {Array<{x: number, y: number, w: number} | null>} */
    const rects = [];
    /* 双语（R30）：第 2 行起是独立 span（字号不同），按文本偏移量就不再是「同一棵文本里切偏移」，
       直接读每个 span 的矩形。默认样式仍然走下面的 Range 路径（DOM 一个字节都不变）。 */
    if (textEl.getAttribute('data-secondary') === '1' && textEl.children.length === lines.length) {
      const over = overlay.getBoundingClientRect();
      for (const [index, line] of lines.entries()) {
        const span = textEl.children[index];
        if (line === '' || span === undefined) {
          rects.push(null);
          continue;
        }
        const rect = span.getBoundingClientRect();
        rects.push({ x: rect.left - over.left, y: rect.top - over.top, w: rect.width });
      }
      rangeCache.key = key;
      rangeCache.rects = rects;
      return rects;
    }
    if (node && typeof doc.createRange === 'function') {
      const over = overlay.getBoundingClientRect();
      let offset = 0;
      for (const line of lines) {
        /* 空行不建 Range：Chrome 对 start==end 的 Range 给 0×0 且位置不可靠 */
        if (line === '') {
          rects.push(null);
          offset += 1;
          continue;
        }
        const range = doc.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + line.length);
        const rect = range.getBoundingClientRect();
        rects.push({ x: rect.left - over.left, y: rect.top - over.top, w: rect.width });
        offset += line.length + 1;
      }
    }
    rangeCache.key = key;
    rangeCache.rects = rects;
    return rects;
  }

  const rangeCache = {
    key: '',
    rects: /** @type {Array<{x: number, y: number, w: number} | null>} */ ([])
  };

  /** 清空底色框节点（transparent / 没有 cue / 隐藏）。 */
  function clearBoxes() {
    if (boxLayer.childNodes.length > 0) boxLayer.textContent = '';
    state.boxes = [];
    state.lineBoxes = [];
    state.block = null;
    state.boxSource = '';
  }

  /**
   * 把几何同步成 DOM：节点数跟着行数走，多退少补（**不重建整层**，
   * 否则每帧 timeupdate 都在扔节点）。`background` 直接写在每个框上。
   * @param {any} geom `measureSubtitleLines()` 的结果
   * @param {unknown} background
   */
  function syncBoxes(geom, background) {
    if (!geom) {
      clearBoxes();
      return;
    }
    /* 几何与「画不画」分开：`lineBoxes` / `block` 是**度量**，透明时也要在
       （A1 的 27 格量的是几何，不是框；框只是它的可视化）。 */
    state.lineBoxes = Array.isArray(geom.lines)
      ? geom.lines.map((/** @type {any} */ item) => ({ ...item }))
      : [];
    state.block = { ...geom.block };
    state.boxSource = String(geom.source ?? '');
    state.boxPadding = { x: geom.padding.x, y: geom.padding.y };
    state.boxRadius = geom.radius;
    if (!Array.isArray(geom.boxes) || geom.boxes.length === 0 || !isVisibleBackground(background)) {
      if (boxLayer.childNodes.length > 0) boxLayer.textContent = '';
      state.boxes = [];
      return;
    }
    /** @type {Array<{x: number, y: number, w: number, h: number, radius: number}>} */
    const want = geom.boxes;
    while (boxLayer.childNodes.length > want.length) {
      const last = boxLayer.lastChild;
      if (!last) break;
      boxLayer.removeChild(last);
    }
    while (boxLayer.childNodes.length < want.length) {
      const node = doc.createElement('div');
      node.setAttribute('data-subtitle-box', '');
      /* 框是纯装饰：不进无障碍树、不参与命中 */
      node.setAttribute('aria-hidden', 'true');
      node.style.cssText = 'position:absolute;pointer-events:none;box-sizing:border-box';
      boxLayer.appendChild(node);
    }
    for (let i = 0; i < want.length; i += 1) {
      const node = /** @type {HTMLElement} */ (boxLayer.childNodes[i]);
      const item = want[i];
      if (!node || !item) continue;
      node.setAttribute('data-line', String(i));
      node.style.left = `${item.x}px`;
      node.style.top = `${item.y}px`;
      node.style.width = `${item.w}px`;
      node.style.height = `${item.h}px`;
      node.style.borderRadius = `${item.radius}px`;
      node.style.background = String(background);
    }
    state.boxes = want.map((item) => ({ ...item }));
  }

  /* ── 渲染 ────────────────────────────────────────────────────────────── */

  /** @param {number} [time] */
  function render(time) {
    if (state.destroyed) return;
    const t = Number.isFinite(time) ? Number(time) : Number(opts.getTime());
    state.time = Number.isFinite(t) ? t : 0;

    const stage = readStage();
    const prev = state.stage;
    const sizeChanged = !prev || prev.w !== stage.w || prev.h !== stage.h;
    state.stage = stage;

    /* 覆盖层按舞台矩形摆（容器比舞台大时也对齐） */
    const hostRect = container.getBoundingClientRect();
    overlay.style.left = `${round(stage.x - hostRect.x, 2)}px`;
    overlay.style.top = `${round(stage.y - hostRect.y, 2)}px`;
    overlay.style.width = `${round(stage.w, 2)}px`;
    overlay.style.height = `${round(stage.h, 2)}px`;

    /* 预览的几何按**舞台**算（缩放由舞台容器的 transform 负责，与 ASS 的 scale 是两回事）。
       字号取整到整数：ASS 的 `Fontsize` 就是整数，用 28.8 会让整行宽 0.7%（S47 的 A1）。
       S74：如果宿主给了「成片实际用的字号」，就按它折算——成片的 Fontsize 是
       `round(舞台高 × ratio × 交付缩放)`（R32 的字号下，16:9 的 1920×1080 是 43），预览按自己的
       屏幕高度取整只有 15，两者差 2.4%，墨迹边界永远对不上。比例 `fontSizeRatio` 不动，
       这里只是把**成片已经取整后的那个字号**折回预览坐标。 */
    const cssBase = toCssStyle(style, stage);
    const fontSizeOverride = readFontSizeOverride();
    const fontK = fontSizeOverride === null ? 1 : fontSizeOverride / Math.max(0.001, cssBase.fontSizePx);
    const css =
      fontK === 1
        ? cssBase
        : {
            ...cssBase,
            fontSizePx: round(cssBase.fontSizePx * fontK, 2),
            /* P74：行盒 = 折回预览字号 × em（em 来自 `subtitleLineStepPx()` 的唯一口径）。
               旧写法 `round(cssBase.lineHeightPx × fontK)` 会把**两次**取整误差叠加进来
               （先按预览字号取整、再按 fontK 折算），多行时逐行累积。 */
            lineHeightPx: round(cssBase.fontSizePx * fontK * (cssBase.lineStepEm ?? 1), 3),
            textOffsetPx: round(cssBase.textOffsetPx * fontK, 2),
            outlinePx: round(cssBase.outlinePx * fontK, 2),
            shadowPx: round(cssBase.shadowPx * fontK, 2),
            strokeWidthPx: round(cssBase.strokeWidthPx * fontK, 2)
          };
    /* CPS 提示色的描边环也要按同一个字号重算：把「虚拟舞台高」按 k 放大即可
       （`toCssDecor` 的字号本来就从舞台高推）。 */
    state.decorStage = fontK === 1 ? stage : { w: stage.w, h: round(stage.h * fontK, 2) };
    state.css = css;
    state.fontSize = css.fontSizePx;
    state.exactFontSize = css.exactFontSizePx;
    state.outlinePx = css.outlinePx;
    state.shadowPx = css.shadowPx;
    state.fontWeight = css.fontWeight;
    state.lineHeightPx = css.lineHeightPx;
    state.textOffsetPx = css.textOffsetPx;
    state.bottom = css.bottomPx;

    box.style.bottom = `${state.bottom}px`;
    box.style.left = `${round(stage.w * SIDE_SAFE_RATIO, 2)}px`;
    box.style.right = `${round(stage.w * SIDE_SAFE_RATIO, 2)}px`;
    /* S50：行盒矮了半行距，文字相对上移同一段，最后一行才留在原处（不动布局、不改块高）。
       `bottom` 仍是纯安全区（8% 舞台高），所以「底边距」的含义没变。 */
    textEl.style.position = 'relative';
    textEl.style.top = `${-state.textOffsetPx}px`;

    applyTextStyle(textEl);
    applyTextStyle(measureEl);

    if (sizeChanged) planCache.key = ''; // 舞台尺寸变了：重排

    if (!state.visible) {
      overlay.style.display = 'none';
      state.rendered += 1;
      return;
    }
    overlay.style.display = '';

    const sorted = sortedCues();
    const index = findCueIndex(sorted, state.time);
    const cue = index >= 0 ? sorted[index] : null;

    if (!cue) {
      state.cue = null;
      state.text = '';
      state.overflow = false;
      state.lines = 0;
      state.cps = 0;
      state.warn = false;
      state.plan = null;
      state.visibleWidth = 0;
      state.lineWidthsPx = [];
      state.maxLineWidthPx = 0;
      textEl.textContent = '';
      /* 测量节点也要清：它是 visibility:hidden 不是 display:none，留着会让 overlay.textContent
         带上上一句字幕的残字（读屏、复制、宿主断言都会被污染）。 */
      measureEl.textContent = '';
      textEl.setAttribute('data-cps-warn', 'false');
      textEl.removeAttribute('data-subtitle-cue');
      badge.style.display = 'none';
      overlay.setAttribute('data-subtitle-active', 'false');
      clearBoxes();
      state.rendered += 1;
      return;
    }

    const width = Math.max(1, stage.w * (1 - SIDE_SAFE_RATIO * 2));
    /* 行排由计划层定（预览与成片同一组 lines）；高度 = 行数 × 行高，不量 DOM。
       S74：可见宽由宿主按「当前交付画幅 + fit」算好（letterbox = stage.w），这里只透传。 */
    const visibleWidth = readVisibleWidth(stage);
    const plan = planFor(cue.text, stage, visibleWidth);
    const lines = plan.lines;
    const shown = lines.join('\n');
    const lineWidths = measureLineWidths(lines, width);
    const cps = subtitleCps(cue.text, cue.start, cue.end);
    const warn = Number.isFinite(cps) && cps > Number(style.cpsWarn);

    state.cue = cue;
    state.text = shown;
    state.overflow = plan.truncated === true;
    state.lines = lines.length;
    state.visibleWidth = visibleWidth === null ? stage.w : visibleWidth;
    state.cps = round(cps, 2);
    state.warn = warn;
    state.plan = {
      lines: [...lines],
      truncated: plan.truncated === true,
      capacityEm: round(plan.capacityEm, 3),
      maxLines: plan.maxLines,
      widthsEm: [...plan.widthsEm]
    };
    state.lineWidthsPx = lineWidths;
    state.maxLineWidthPx = lineWidths.length > 0 ? Math.max(...lineWidths) : 0;
    state.availableWidthPx = round(width, 2);

    /* 双语（R30）：第 2 行起字号 × secondaryScale。默认样式（=1）走原来的**单文本节点**，
       DOM 与改造前逐字节相同（判据②「切回默认逐像素相同」靠的就是这条）。 */
    const secondaryPx =
      Number(state.css?.secondaryScale) > 0 && Number(state.css?.secondaryScale) < 1
        ? Math.max(1, Math.round(Number(state.css.fontSizePx) * Number(state.css.secondaryScale)))
        : 0;
    if (secondaryPx > 0 && lines.length > 1) {
      textEl.textContent = '';
      for (const [index, line] of lines.entries()) {
        const span = doc.createElement('span');
        span.setAttribute('data-subtitle-line', String(index));
        span.style.display = 'block';
        if (index > 0) span.style.fontSize = `${String(secondaryPx)}px`;
        span.textContent = line;
        textEl.appendChild(span);
      }
      textEl.setAttribute('data-secondary', '1');
      textEl.setAttribute('data-secondary-px', String(secondaryPx));
    } else {
      textEl.textContent = shown;
      textEl.removeAttribute('data-secondary');
      textEl.removeAttribute('data-secondary-px');
    }
    textEl.setAttribute('data-cps-warn', warn ? 'true' : 'false');
    textEl.setAttribute('data-subtitle-lines', String(lines.length));
    textEl.setAttribute('data-subtitle-truncated', plan.truncated === true ? 'true' : 'false');
    textEl.setAttribute('data-subtitle-cue', `${cue.start}-${cue.end}`);

    /* S53：底色框。几何全部来自 `measureSubtitleLines`（Range 的 advance 盒 + canvas
       的字形 bearing），`background: transparent` 时 `syncBoxes` 会清成 0 个节点。 */
    try {
      const geom = measureSubtitleLines({
        style,
        stage,
        lines,
        advanceRects: measureLineRects(lines, stage)
      });
      syncBoxes(geom, style.background);
    } catch (err) {
      clearBoxes();
      reportError({ code: 'SUBTITLE_BOX_FAILED', message: `底色框几何算不出来：${String(/** @type {any} */ (err)?.message ?? err)}` });
    }
    /* 超速时描边转提示色：描边现在是 text-shadow 环，重算一次环（不是改一个 color 属性）。
       warn 结束要**显式**改回默认色，否则会粘在上一句上。 */
    applyTextStyle(textEl, warn ? CPS_WARN_COLOR : undefined);
    overlay.setAttribute('data-subtitle-active', 'true');

    if (warn) {
      badge.style.display = 'block';
      badge.textContent = `${Math.round(cps)} CPS`;
    } else {
      badge.style.display = 'none';
    }

    state.rendered += 1;
  }

  /* ── 宿主事件 ────────────────────────────────────────────────────────── */

  const onResize = () => render();

  let resizeBound = false;
  function bindResize() {
    if (resizeBound) return;
    win.addEventListener('resize', onResize);
    resizeBound = true;
  }
  function unbindResize() {
    if (!resizeBound) return;
    win.removeEventListener('resize', onResize);
    resizeBound = false;
  }
  bindResize();

  reportStyleIssues();
  render();

  return {
    render,
    setVisible(visible) {
      state.visible = visible !== false;
      overlay.style.display = state.visible ? '' : 'none';
      if (state.visible) render();
      return state.visible;
    },
    /**
     * 改样式（补丁语义：只给要改的字段）。**同样走 normalize**——否则 `updateStyle` 就成了
     * 一条绕过校验的后门，非法值会直接进渲染。返回归一后的完整样式。
     * @param {object} patch
     */
    updateStyle(patch) {
      if (!patch || typeof patch !== 'object') return { ...baseStyle };
      const next = normalizeSubtitleStyle({ ...baseStyle, ...patch });
      baseStyle = next.style;
      style = applyStylePreset(baseStyle);
      styleIssues = next.issues;
      /* 同一个 code 只报一次（S23 的既有语义），所以这里不重置 state.reported：
         首次挂载已经报过非法值的话，改样式时不该再弹一次同样的话。 */
      reportStyleIssues();
      planCache.key = '';
      render();
      return { ...style };
    },
    getState() {
      return {
        version: state.version,
        visible: state.visible,
        destroyed: state.destroyed,
        time: state.time,
        text: state.text,
        cue: state.cue ? { ...state.cue } : null,
        stage: state.stage ? { ...state.stage } : null,
        fontSize: state.fontSize,
        exactFontSize: state.exactFontSize,
        outlinePx: state.outlinePx,
        shadowPx: state.shadowPx,
        fontWeight: state.fontWeight,
        lineHeightPx: state.lineHeightPx,
        textOffsetPx: state.textOffsetPx,
        bottom: state.bottom,
        lines: state.lines,
        overflow: state.overflow,
        /* S45：行排来源、逐行宽、可用宽 —— 验收直接读这三样，不用再量 DOM */
        plan: state.plan ? { ...state.plan, lines: [...state.plan.lines], widthsEm: [...state.plan.widthsEm] } : null,
        visibleWidth: state.visibleWidth,
        /** S74：成片字号的折算比例（1 = 没折算；验收用它证明「不是靠缩字号躲开裁切」） */
        fontScaleToExport: state.css === null || state.exactFontSize <= 0 ? 1 : round(state.fontSize / state.exactFontSize, 4),
        lineWidthsPx: [...state.lineWidthsPx],
        maxLineWidthPx: state.maxLineWidthPx,
        availableWidthPx: state.availableWidthPx,
        cps: state.cps,
        warn: state.warn,
        skipped: state.skipped,
        rendered: state.rendered,
        /* S53：底色框（每行一个矩形）+ 块并集 + padding/圆角。transparent 时全空。 */
        boxes: state.boxes.map((item) => ({ ...item })),
        lineBoxes: state.lineBoxes.map((item) => ({ ...item })),
        block: state.block ? { ...state.block } : null,
        boxSource: state.boxSource,
        boxPadding: { ...state.boxPadding },
        boxRadius: state.boxRadius,
        reported: [...state.reported],
        /* S41：归一后的完整样式（含默认值）与「哪些字段被拒了」——宿主/验收用。
           `style` 是**存盘口径**（preset 还是 id，没有派生值），`resolvedStyle` 才是展开后
           真正画出来的那份；两个都给，验收才能证明「预设确实只存了一个 id」。 */
        style: { ...baseStyle },
        resolvedStyle: { ...style },
        styleIssues: styleIssues.map((issue) => ({ ...issue })),
        listeners: resizeBound ? 1 : 0,
        persistence: 'read-only'
      };
    },
    destroy() {
      if (state.destroyed) return;
      state.destroyed = true;
      unbindResize();
      cueCache.ref = null;
      cueCache.sorted = [];
      planCache.key = '';
      overlay.remove();
    }
  };
}
