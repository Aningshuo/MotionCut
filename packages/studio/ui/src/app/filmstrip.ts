// @ts-nocheck —— 胶片条只拼字符串/元素，样式全在 CSS；逐点标 any 会淹没「哪一格取哪一毫秒」。
import { createElement, useEffect, useRef } from 'react';
/* R31（E12-P2）：取帧毫秒只有一处口径 —— 与素材抽屉共用一个函数，不再各写一遍 round。 */
import { frameMsAt, normalizeFrameMs } from '../../../../layers/frame-ms.mjs';
/**
 * E04 · 时间线胶片条（R29 / BATCH-SUB1-R31-087）
 *
 * 参照（OpenFilm 0.3.2）的做法，原文键名见 `R30-E04-REF.json`：
 * - 一格 = **80 CSS px**（`const B2=80`），相邻两格贴齐、间距 0；
 * - 容器 `absolute inset-x-0 bottom-0 overflow-hidden`，`top = 信息带 15px`；
 * - 缩略图 `left` 从片段左缘起算、`width:80`、`height:条高`、`opacity:.9`、`object-fit:cover`；
 * - 条高 = `max(6, 片段高 − 15 − (有音频带 ? 15 : 0))`（`oc=Math.max(6,ke-_u-(Hf?Zw:0))`）。
 *
 * 我们这边只做**视频 / 图片**片段：页片段要无头浏览器画一帧，`derived?what=frame`
 * 对它明确 415（见 `packages/studio/server/derived.mjs` 的头注释），所以不铺。
 *
 * 为什么把「算格子」抽成纯函数：`filmstrip.test.mjs` 直接测帧数/取帧毫秒，
 * 不用起浏览器；页面那边只负责把 `{left, ms}` 画成 `<img>`。
 */

/** 一格胶片宽（CSS px）。参照的量测值，别改 —— 改它等于改 D60/E04 的判据。 */
export const THUMB_W = 80;

const h = createElement;

/**
 * 一格要取哪一毫秒：源文件里的时刻（ms）。
 *
 * `left` 是格子相对片段左缘的像素位置；时间线是匀速的，所以
 * 「片段内第 left 像素」对应的源时刻 = `sourceIn + left / pps * speed`。
 * 末格常常超过源出点（片段被拉长/慢放）—— 夹到 `sourceOut − 40ms`，
 * 与 `derived` 的末尾容差同一个口径（`END_TOLERANCE_MS`）。
 *
 * @param {{ width: number, pps: number, speed?: number, sourceIn?: number, sourceOut?: number }} opts
 * @returns {Array<{ left: number, ms: number }>}
 */
export function filmstripCells(opts) {
  const width = Number(opts?.width) > 0 ? Number(opts.width) : 0;
  const pps = Number(opts?.pps) > 0 ? Number(opts.pps) : 0;
  if (width <= 0 || pps <= 0) return [];
  const speed = Number(opts?.speed) > 0 ? Number(opts.speed) : 1;
  const sourceIn = Number(opts?.sourceIn) > 0 ? Number(opts.sourceIn) : 0;
  const hasOut = Number.isFinite(Number(opts?.sourceOut)) && Number(opts?.sourceOut) > 0;
  const sourceOut = hasOut ? Number(opts.sourceOut) : null;
  const count = Math.ceil(width / THUMB_W);
  const cells = [];
  for (let i = 0; i < count; i += 1) {
    const left = i * THUMB_W;
    /* 取整 + 末尾容差都由 `frameMsAt()` 决定（素材抽屉用的是同一个函数，见 layers/frame-ms.mjs） */
    const ms = frameMsAt(sourceIn + (left / pps) * speed, sourceOut);
    cells.push({ left, ms });
  }
  return cells;
}

/**
 * 一格的 URL。`w=160` = 80 CSS px 的 2 倍（给 DPR2），与素材卡同一口径。
 * @param {string} base `/api/projects/<id>/derived`
 * @param {string} src 工程相对路径
 * @param {number} ms
 */
export function filmstripUrl(base, src, ms) {
  /* `ms` 已经是 `frameMsAt()` 的产物（整数）；这里再过一次同一个原语，防止调用方手写小数 */
  return `${base}?what=frame&rel=${encodeURIComponent(src)}&ms=${String(normalizeFrameMs(ms))}&w=160`;
}

/** 1×1 透明 GIF：占位格用，**不产生网络请求**（浏览器当它已经加载完）。 */
export const THUMB_PLACEHOLDER =
  'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAIBRAA7';

/** 预取余量：可见窗口外**再多一格**（书 §3 的「预取一格余量」，也是并发上限的来源）。 */
export const PREFETCH_CELLS = 1;

/**
 * 可见窗口 → 该发请求的格子区间（纯函数，`filmstrip.test.mjs` 直接测）。
 *
 * 坐标系：`stripLeft / stripWidth` 是片段自身的屏幕矩形（`getBoundingClientRect`），
 * `viewLeft / viewRight` 是**被滚动容器裁过之后**的可见带（屏幕 px）；
 * `cssWidth` 是片段的 CSS 宽（时间线 px，未缩放）。两者相除就是祖先链的累计缩放
 * ——与 `subtitle-overlay.mjs` 量行宽同一个技巧，缩略图按 CSS px 排，位置必须除回去。
 *
 * 返回的 `from..to` 已经含**右侧一格**预取；`visibleFrom..visibleTo` 是不含预取的可见格。
 * 这样「在飞的请求数」最多 = 可见格数 + 1（判据①）。
 *
 * @param {{ stripLeft: number, stripWidth: number, viewLeft: number, viewRight: number,
 *   cssWidth: number, count: number, thumbW?: number }} input
 * @returns {{ from: number, to: number, visibleFrom: number, visibleTo: number, scale: number }}
 */
export function cellRangeInView(input) {
  const count = Number(input?.count) > 0 ? Math.floor(Number(input.count)) : 0;
  const thumbW = Number(input?.thumbW) > 0 ? Number(input.thumbW) : THUMB_W;
  const empty = { from: 0, to: -1, visibleFrom: 0, visibleTo: -1, scale: 1 };
  if (count === 0) return empty;
  const stripWidth = Number(input?.stripWidth);
  const cssWidth = Number(input?.cssWidth);
  if (!(stripWidth > 0) || !(cssWidth > 0)) return { ...empty, to: count - 1, visibleTo: count - 1 };
  /* 累计缩放：舞台/时间线被 transform 缩过时 stripWidth ≠ cssWidth */
  const scale = stripWidth / cssWidth;
  const pxPerCell = thumbW * scale;
  const left = Number(input?.viewLeft) - Number(input?.stripLeft);
  const right = Number(input?.viewRight) - Number(input?.stripLeft);
  const rawFrom = Math.floor(left / pxPerCell);
  const rawTo = Math.ceil(right / pxPerCell) - 1;
  const visibleFrom = Math.max(0, Math.min(count - 1, rawFrom));
  const visibleTo = Math.max(-1, Math.min(count - 1, rawTo));
  if (visibleTo < visibleFrom) {
    /* 完全在视口外：不预取（否则滚动到远处也会一次要一格） */
    return { from: 0, to: -1, visibleFrom, visibleTo: visibleFrom - 1, scale };
  }
  const from = Math.max(0, visibleFrom);
  const to = Math.min(count - 1, visibleTo + PREFETCH_CELLS);
  return { from, to, visibleFrom, visibleTo, scale };
}

/**
 * 找一个「会横向滚」的祖先（时间线容器）。没有就返回 `null`（用视口当窗口）。
 * @param {Element|null} node
 * @returns {Element|null}
 */
function scrollParentOf(node) {
  for (let parent = node?.parentElement ?? null; parent !== null; parent = parent.parentElement) {
    const style = parent.ownerDocument?.defaultView?.getComputedStyle(parent);
    if (style === undefined || style === null) continue;
    if (/(auto|scroll)/.test(style.overflowX) && parent.scrollWidth > parent.clientWidth + 1) return parent;
  }
  return null;
}

/**
 * 当前可见带（屏幕 px）：视口矩形被**所有**滚动/裁切祖先夹一遍。
 *
 * 为什么不用 IntersectionObserver：本批的判据要的是「在飞的请求数 ≤ 可见格数 + 1」，
 * 而 IO 的回调是异步批量的，无法保证「一次只放一格进来」；这里同步算区间，
 * 一次 `ensureSrc` 就只碰该碰的那几格，数量是**可证**的。
 *
 * @param {Element} node
 * @returns {{ left: number, right: number }}
 */
function visibleBand(node) {
  const rect = node.getBoundingClientRect();
  let left = Math.max(rect.left, 0);
  let right = Math.min(rect.right, window.innerWidth);
  for (let parent = node.parentElement; parent !== null; parent = parent.parentElement) {
    const style = window.getComputedStyle(parent);
    if (!/(auto|scroll|hidden|clip)/.test(style.overflowX)) continue;
    const box = parent.getBoundingClientRect();
    left = Math.max(left, box.left);
    right = Math.min(right, box.right);
  }
  return { left, right };
}

/**
 * 胶片条容器：绝对定位、`pointer-events:none`（不抢片段拖拽），
 * 高度由 CSS 按「片段高 − 15 − 音频带」算（见 `.tl-clip-strip`）。
 *
 * ## 只给可见窗口发请求（R30 / A）
 *
 * 一格里 `<img>` 一开始是 1×1 透明 GIF（占位，不花请求），真正进到可见窗口
 * （或右侧一格预取）时才把 `src` 换成 `/derived`。之后**不再回退**成占位 ——
 * 已经拿到的画面留着比丢掉更省，也让快速来回滚不会有闪烁。
 *
 * 判据口径：`data-live` = 已经带真 `src` 的格数，`data-window` = `from-to`。
 */
export function Filmstrip(props) {
  const cells = filmstripCells({
    width: props.width,
    pps: props.pps,
    speed: props.speed,
    sourceIn: props.sourceIn,
    sourceOut: props.sourceOut,
  });
  const rootRef = useRef(null);

  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const count = cells.length;
    if (count === 0) return;
    const urls = cells.map((cell) => filmstripUrl(props.base, props.src, cell.ms));
    let frame = 0;

    const paint = () => {
      frame = 0;
      const imgs = root.children;
      if (imgs.length === 0) return;
      const band = visibleBand(root);
      const range = cellRangeInView({
        stripLeft: root.getBoundingClientRect().left,
        stripWidth: root.getBoundingClientRect().width,
        viewLeft: band.left,
        viewRight: band.right,
        cssWidth: Number(props.width) || 0,
        count,
      });
      let live = 0;
      for (let index = range.from; index <= range.to; index += 1) {
        const node = imgs[index];
        if (node === undefined) continue;
        if (node.dataset.live !== '1') {
          node.dataset.live = '1';
          /* 解码完成才摘掉占位底色：只按 `data-live` 摘的话，请求已发但图还没到时
             格子会透出片段底色（看起来像缺一格）。 */
          node.addEventListener('load', () => {
            node.dataset.loaded = '1';
          }, { once: true });
          node.src = urls[index];
        }
      }
      for (let index = 0; index < imgs.length; index += 1) {
        if (imgs[index]?.dataset.live === '1') live += 1;
      }
      root.dataset.live = String(live);
      root.dataset.window = `${String(Math.max(0, range.from))}-${String(Math.max(-1, range.to))}`;
      root.dataset.visible = String(Math.max(0, range.visibleTo - range.visibleFrom + 1));
    };

    const schedule = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(paint);
    };

    paint();
    /* `capture: true`：滚动事件不冒泡，但捕获阶段能收到**任何**滚动容器（时间线横向、
       页面纵向、以后新加的 scroller）。比绑定具体容器稳。 */
    document.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    observer?.observe(root);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      document.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
      observer?.disconnect();
    };
    /* 依赖里不放 `cells`：它在每次 render 都是新数组，按长度 + 几何入参去重就够了 —— */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.base, props.src, props.width, props.pps, props.speed, props.sourceIn, props.sourceOut, cells.length]);

  if (cells.length === 0) return null;
  return h(
    'div',
    {
      ref: rootRef,
      className: 'tl-clip-strip',
      'data-testid': 'clip-filmstrip',
      'data-clip': props.clipId,
      'data-cells': String(cells.length),
      'data-thumb-w': String(THUMB_W),
      'data-prefetch': String(PREFETCH_CELLS),
      'aria-hidden': 'true',
    },
    cells.map((cell, index) =>
      h('img', {
        key: `${String(index)}-${String(cell.ms)}`,
        className: 'tl-clip-thumb',
        src: THUMB_PLACEHOLDER,
        style: { left: `${cell.left}px` },
        alt: '',
        draggable: false,
        decoding: 'async',
        'data-thumb-ms': String(cell.ms),
        'data-thumb-index': String(index),
      }),
    ),
  );
}
