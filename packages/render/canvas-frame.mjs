/**
 * 画布坐标系（NEW-03）：把「工程画布」映射到「成片帧」，并给出**真实画面框**。
 *
 * 为什么需要这一层：交付时 `fit=contain` 会把 1280×720 的舞台按
 * `min(outW/stageW, outH/stageH)` 等比缩放、居中、四周留黑。舞台里的 CSS 像素
 * （裁切偏移、蒙版 inset、羽化宽度）都是**画布像素**；落到成片上要乘 `scale`，
 * 而黑边不是画面——任何「按成片帧」或「按容器」算的几何都会跟着黑边跑。
 *
 * 这里只做纯算术，不碰 DOM、不碰 IO：
 *
 *   content = 画面框 = 舞台等比缩放后真正占的那块矩形（不含黑边）
 *   scale   = 画布像素 → 成片像素的比例
 *
 * 于是三件事可以判死：
 * 1. 元素在成片里的矩形 = `mapRect(元素画布矩形)`，与像素量出来的比 ≤1px；
 * 2. 羽化宽度在成片上 = `authoredPx × scale`，换算回画布是恒定的 `authoredPx`
 *    （切换比例不会让羽化变粗/变细，除非分辨率变了——那时是同一比例）；
 * 3. 黑边必须是空像素：`emptyBands()` 给出上下左右各多少行/列**不该有内容**。
 *
 * 反方向 `unmapRect` 用于命中测试/回写：把成片上的点换算回画布坐标，
 * 黑边上的点不会命中任何元素（落在 `content` 之外）。
 */

export const CANVAS_FRAME_VERSION = '1.0.0';

/** @typedef {{ w: number, h: number }} Size */
/** @typedef {{ x: number, y: number, w: number, h: number }} Rect */

/**
 * @param {unknown} value
 * @param {number} fallback
 */
function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 画布 → 成片的映射。
 *
 * `fit`：
 * - `letterbox`（默认）：整幅画面塞进成片，多出来的边留黑，**不裁内容**；
 * - `cover`：画面铺满成片，超出部分裁掉（`cropped` 给出裁掉的偏移）。
 * - `none`：成片就是画布本身（scale=1，无黑边）。
 *
 * @param {{ stage: Size, output?: Size | null, fit?: 'letterbox' | 'cover' | 'none' | null }} input
 * @returns {{
 *   version: string, fit: 'letterbox' | 'cover' | 'none',
 *   stage: Size, output: Size, content: Rect, scale: number,
 *   cropped: { x: number, y: number } | null,
 *   bars: { top: number, bottom: number, left: number, right: number },
 * }}
 */
export function planCanvasFrame(input) {
  const stage = { w: num(input.stage?.w, 1280), h: num(input.stage?.h, 720) };
  const fit = input.fit === 'cover' || input.fit === 'none' ? input.fit : 'letterbox';
  const output = input.output
    ? { w: num(input.output.w, stage.w), h: num(input.output.h, stage.h) }
    : { ...stage };

  if (fit === 'none') {
    return {
      version: CANVAS_FRAME_VERSION,
      fit,
      stage,
      output: { ...stage },
      content: { x: 0, y: 0, w: stage.w, h: stage.h },
      scale: 1,
      cropped: null,
      bars: { top: 0, bottom: 0, left: 0, right: 0 },
    };
  }

  const scale = fit === 'cover'
    ? Math.max(output.w / stage.w, output.h / stage.h)
    : Math.min(output.w / stage.w, output.h / stage.h);
  const width = stage.w * scale;
  const height = stage.h * scale;
  const x = (output.w - width) / 2;
  const y = (output.h - height) / 2;

  if (fit === 'cover') {
    /* 画面比成片大：`content` 仍是「整幅画面」在成片坐标系里的矩形（会溢出成片），
       裁掉的偏移给出去，调用方才知道从哪儿切。 */
    return {
      version: CANVAS_FRAME_VERSION,
      fit,
      stage,
      output,
      content: { x, y, w: width, h: height },
      scale,
      cropped: { x: Math.max(0, -x), y: Math.max(0, -y) },
      bars: { top: 0, bottom: 0, left: 0, right: 0 },
    };
  }

  return {
    version: CANVAS_FRAME_VERSION,
    fit,
    stage,
    output,
    content: { x, y, w: width, h: height },
    scale,
    cropped: null,
    bars: {
      top: Math.max(0, y),
      bottom: Math.max(0, output.h - (y + height)),
      left: Math.max(0, x),
      right: Math.max(0, output.w - (x + width)),
    },
  };
}

/**
 * 画布矩形 → 成片矩形（浮点；取整交给调用方，避免提前损失亚像素）。
 * @param {Rect} rect @param {ReturnType<typeof planCanvasFrame>} frame
 * @returns {Rect}
 */
export function mapRect(rect, frame) {
  return {
    x: frame.content.x + rect.x * frame.scale,
    y: frame.content.y + rect.y * frame.scale,
    w: rect.w * frame.scale,
    h: rect.h * frame.scale,
  };
}

/**
 * 成片点/矩形 → 画布坐标（`mapRect` 的逆）。黑边上的点会算到画布外。
 * @param {{ x: number, y: number }} point @param {ReturnType<typeof planCanvasFrame>} frame
 */
export function unmapPoint(point, frame) {
  return {
    x: (point.x - frame.content.x) / frame.scale,
    y: (point.y - frame.content.y) / frame.scale,
  };
}

/**
 * 画布矩形是否整个落在画面框里（用于「黑边上的点不命中任何元素」）。
 * @param {{ x: number, y: number }} point @param {ReturnType<typeof planCanvasFrame>} frame
 */
export function insideContent(point, frame) {
  const p = { x: point.x, y: point.y };
  return p.x >= frame.content.x && p.x < frame.content.x + frame.content.w
    && p.y >= frame.content.y && p.y < frame.content.y + frame.content.h;
}

/**
 * 羽化带宽：画布像素 → 成片像素。两者都返回，判定用「换算回画布恒定」。
 * @param {number} authoredPx @param {ReturnType<typeof planCanvasFrame>} frame
 */
export function featherBand(authoredPx, frame) {
  const authored = num(authoredPx, 0);
  return {
    canvasPx: authored,
    outputPx: authored * frame.scale,
    /* 取整后的「应当量到多少」：像素是整数，比较时允许 ±1。 */
    expectedOutputPx: Math.round(authored * frame.scale),
  };
}

/**
 * 裁剪参数夹取：偏移夹到 `[0, 源 - 可见]`，缩放夹到 `≤ 1`（**不放大源**）。
 *
 * `zoom` 的语义与 CSS `object-fit: cover` 一致：`zoom = 可见框 / 源`。
 * `zoom < 1` 表示画面被缩小放进框里（多余部分裁掉），`> 1` 就是把源放大——那会糊，
 * 所以这里直接夹住并把 `upscaled` 标出来（不静默改语义）。
 *
 * @param {{ source: Size, box: Size, offset?: { x: number, y: number }, zoom?: number }} input
 */
export function clampCrop(input) {
  const source = { w: num(input.source?.w, 1), h: num(input.source?.h, 1) };
  const box = { w: num(input.box?.w, 1), h: num(input.box?.h, 1) };
  const coverZoom = Math.max(box.w / source.w, box.h / source.h);
  const requested = input.zoom === undefined ? coverZoom : num(input.zoom, coverZoom);
  const upscaled = requested > 1;
  const zoom = Math.min(1, requested);
  /* 可见的源像素数：zoom 越小，看到的源越多（受源本身限制）。 */
  const visible = {
    w: Math.min(source.w, box.w / zoom),
    h: Math.min(source.h, box.h / zoom),
  };
  const maxOffset = {
    x: Math.max(0, source.w - visible.w),
    y: Math.max(0, source.h - visible.h),
  };
  const offset = {
    x: Math.min(maxOffset.x, Math.max(0, Number(input.offset?.x) || 0)),
    y: Math.min(maxOffset.y, Math.max(0, Number(input.offset?.y) || 0)),
  };
  return {
    source,
    box,
    zoom,
    coverZoom,
    upscaled,
    requestedZoom: requested,
    visible,
    offset,
    clamped: {
      zoom: upscaled,
      x: offset.x !== (Number(input.offset?.x) || 0),
      y: offset.y !== (Number(input.offset?.y) || 0),
    },
    /* 夹取之后，可见区域必须整个落在源里 —— 这条恒为真，越界就是实现错了。 */
    insideSource: offset.x + visible.w <= source.w + 1e-9 && offset.y + visible.h <= source.h + 1e-9,
  };
}

/**
 * 黑边应当是多少行/列**空像素**（整数，向外取整：宁可要求少判一行，也不让抗锯齿假红）。
 * @param {ReturnType<typeof planCanvasFrame>} frame
 */
export function emptyBands(frame) {
  return {
    top: Math.floor(frame.bars.top + 1e-9),
    bottom: Math.floor(frame.bars.bottom + 1e-9),
    left: Math.floor(frame.bars.left + 1e-9),
    right: Math.floor(frame.bars.right + 1e-9),
  };
}

/**
 * 画面框的整数像素范围（含首含尾），像素扫描用。
 * @param {ReturnType<typeof planCanvasFrame>} frame
 */
export function contentPixelBox(frame) {
  const left = Math.round(frame.content.x);
  const top = Math.round(frame.content.y);
  const right = Math.min(frame.output.w - 1, Math.round(frame.content.x + frame.content.w) - 1);
  const bottom = Math.min(frame.output.h - 1, Math.round(frame.content.y + frame.content.h) - 1);
  return { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 };
}
