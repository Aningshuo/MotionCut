/**
 * 画布手势 → `film.html` box 的**落盘一致层**（M64 · B-MAIN-R30-031）。
 *
 * 分工写死：
 * - `packages/layers/canvas-gesture.mjs`（副线1）负责「指针 → 声明空间增量」，是手势的**输入**；
 * - 这里负责「增量 → `left/top/width/height/rotate` → `/ops` 的 box」，是手势的**出口**；
 * - 写盘仍只走 `/ops`（`film-io` 的临时文件 → fsync → rename），本模块**不碰磁盘**。
 *
 * 三个关键约定：
 *
 * 1. **归一化输入**：位移与尺寸都用 0..1（相对舞台宽高），角度用度。这样同一份手势在
 *    1280×720 与 4K 上得到同一个相对结果，服务端不需要知道 UI 的像素缩放。
 * 2. **角度归一到 `(-180, 180]`**：179° 再转 2° 必须是 −179°，不是 181°。写回时 `r=0`
 *    与「没有 rotate 声明」在 film-core 里是同一个状态（`styleText` 不写 0）。
 * 3. **越界不拒绝**：允许拖出舞台，但必须回 `overflow: true` 与四边溢出像素，
 *    让 UI 能提示「有内容在画面外」；拒绝越界会让人没法做「飞出」动画。
 *
 * 最小尺寸默认 `8`（`CANVAS_MIN_SIZE`），必须与 `layers/canvas-gesture.mjs` 的
 * `GESTURE_MIN_SIZE` 一致——`canvas-persist.test.mjs` 有一条对拍断言钉住它。
 */

/** 最小尺寸（声明空间 px），与 `layers/canvas-gesture.mjs` 的 `GESTURE_MIN_SIZE` 对拍。 */
export const CANVAS_MIN_SIZE = 8;

/** 数值写回保留 6 位：压住 1e-3 判据，又不引入二进制噪声。 */
const DECIMALS = 6;

/**
 * @param {number} value
 * @returns {number}
 */
function round6(value) {
  const factor = 10 ** DECIMALS;
  return Math.round(value * factor) / factor;
}

/**
 * 角度归一到 `(-180, 180]`。
 *
 * @param {number} degrees
 * @returns {number}
 */
export function normalizeAngle(degrees) {
  const value = Number(degrees);
  if (!Number.isFinite(value)) return Number.NaN;
  const wrapped = ((value + 180) % 360 + 360) % 360 - 180; // [-180, 180)
  return round6(wrapped === -180 ? 180 : wrapped);
}

/**
 * 旋转后的轴对齐包围盒（用于越界判定：只按未旋转矩形算会漏掉「转 45° 顶出去」）。
 *
 * @param {{ left: number, top: number, width: number, height: number, rotate: number }} box
 * @returns {{ left: number, right: number, top: number, bottom: number }}
 */
export function rotatedAabbOf(box) {
  const radians = (box.rotate * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  const halfW = box.width / 2;
  const halfH = box.height / 2;
  /** @type {{ x: number, y: number }[]} */
  const corners = [
    { x: -halfW, y: -halfH },
    { x: halfW, y: -halfH },
    { x: halfW, y: halfH },
    { x: -halfW, y: halfH },
  ].map((point) => ({ x: cx + point.x * cos - point.y * sin, y: cy + point.x * sin + point.y * cos }));
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}

/**
 * 归一化手势 → 最终 box。
 *
 * `gesture`：
 * - `{ kind: 'move', dx, dy }`：`dx/dy` 是相对舞台宽高的位移（0.1 = 舞台宽度的 10%）；
 * - `{ kind: 'scale', factor, anchor }`：`anchor` ∈ `nw|ne|se|sw|center`，锚点对角固定；
 * - `{ kind: 'rotate', degrees }`：增量角度（度）。
 *
 * @param {{
 *   stage: { w: number, h: number },
 *   box: { left: number, top: number, width: number, height: number, rotate?: number },
 *   gesture: { kind: 'move'|'scale'|'rotate', dx?: number, dy?: number, factor?: number, anchor?: 'nw'|'ne'|'se'|'sw'|'center', degrees?: number },
 *   minSize?: number,
 * }} input
 * @returns {{
 *   ok: boolean,
 *   code?: 'INVALID_STAGE'|'INVALID_BOX'|'INVALID_GESTURE',
 *   message?: string,
 *   box: { left: number, top: number, width: number, height: number, rotate: number },
 *   overflow: boolean,
 *   overflowPx: { left: number, right: number, top: number, bottom: number },
 *   minApplied: boolean,
 * }}
 */
export function applyCanvasGesture(input) {
  const stageW = Number(input?.stage?.w);
  const stageH = Number(input?.stage?.h);
  const base = input?.box;
  const gesture = input?.gesture;
  const empty = { left: 0, top: 0, width: 0, height: 0, rotate: 0 };

  if (!Number.isFinite(stageW) || stageW <= 0 || !Number.isFinite(stageH) || stageH <= 0) {
    return { ok: false, code: 'INVALID_STAGE', message: `舞台尺寸非法：${JSON.stringify(input?.stage)}`, box: empty, overflow: false, overflowPx: { left: 0, right: 0, top: 0, bottom: 0 }, minApplied: false };
  }
  const numbers = [base?.left, base?.top, base?.width, base?.height];
  if (numbers.some((value) => !Number.isFinite(Number(value))) || Number(base?.width) <= 0 || Number(base?.height) <= 0) {
    return { ok: false, code: 'INVALID_BOX', message: `box 非法：${JSON.stringify(base)}`, box: empty, overflow: false, overflowPx: { left: 0, right: 0, top: 0, bottom: 0 }, minApplied: false };
  }
  if (gesture === null || typeof gesture !== 'object') {
    return { ok: false, code: 'INVALID_GESTURE', message: '缺少 gesture', box: empty, overflow: false, overflowPx: { left: 0, right: 0, top: 0, bottom: 0 }, minApplied: false };
  }

  const minSize = Number.isFinite(Number(input?.minSize)) && Number(input?.minSize) > 0 ? Number(input?.minSize) : CANVAS_MIN_SIZE;
  let left = round6(Number(base.left));
  let top = round6(Number(base.top));
  let width = round6(Number(base.width));
  let height = round6(Number(base.height));
  let rotate = normalizeAngle(Number(base.rotate ?? 0));
  let minApplied = false;

  if (gesture.kind === 'move') {
    const dx = Number(gesture.dx ?? 0);
    const dy = Number(gesture.dy ?? 0);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
      return { ok: false, code: 'INVALID_GESTURE', message: `move 的 dx/dy 非法：${JSON.stringify(gesture)}`, box: empty, overflow: false, overflowPx: { left: 0, right: 0, top: 0, bottom: 0 }, minApplied: false };
    }
    left = round6(left + dx * stageW);
    top = round6(top + dy * stageH);
  } else if (gesture.kind === 'scale') {
    const factor = Number(gesture.factor);
    if (!Number.isFinite(factor) || factor <= 0) {
      return { ok: false, code: 'INVALID_GESTURE', message: `scale 的 factor 必须是 > 0 的有限数：${gesture.factor}`, box: empty, overflow: false, overflowPx: { left: 0, right: 0, top: 0, bottom: 0 }, minApplied: false };
    }
    const anchor = gesture.anchor ?? 'se';
    const right = round6(left + width);
    const bottom = round6(top + height);
    let nextWidth = round6(width * factor);
    let nextHeight = round6(height * factor);
    if (nextWidth < minSize) {
      nextWidth = minSize;
      minApplied = true;
    }
    if (nextHeight < minSize) {
      nextHeight = minSize;
      minApplied = true;
    }
    width = nextWidth;
    height = nextHeight;
    if (anchor === 'nw' || anchor === 'sw') left = round6(right - width);
    if (anchor === 'nw' || anchor === 'ne') top = round6(bottom - height);
    if (anchor !== 'nw' && anchor !== 'ne' && anchor !== 'se' && anchor !== 'sw' && anchor !== 'center') {
      return { ok: false, code: 'INVALID_GESTURE', message: `scale 的 anchor 非法：${String(anchor)}`, box: empty, overflow: false, overflowPx: { left: 0, right: 0, top: 0, bottom: 0 }, minApplied: false };
    }
  } else if (gesture.kind === 'rotate') {
    const degrees = Number(gesture.degrees);
    if (!Number.isFinite(degrees)) {
      return { ok: false, code: 'INVALID_GESTURE', message: `rotate 的 degrees 非法：${gesture.degrees}`, box: empty, overflow: false, overflowPx: { left: 0, right: 0, top: 0, bottom: 0 }, minApplied: false };
    }
    rotate = normalizeAngle(rotate + degrees);
  } else {
    return { ok: false, code: 'INVALID_GESTURE', message: `未知手势：${String(gesture.kind)}`, box: empty, overflow: false, overflowPx: { left: 0, right: 0, top: 0, bottom: 0 }, minApplied: false };
  }

  const box = { left, top, width, height, rotate };
  const aabb = rotatedAabbOf(box);
  const overflowPx = {
    left: round6(Math.max(0, -aabb.left)),
    right: round6(Math.max(0, aabb.right - stageW)),
    top: round6(Math.max(0, -aabb.top)),
    bottom: round6(Math.max(0, aabb.bottom - stageH)),
  };
  const overflow = overflowPx.left > 0 || overflowPx.right > 0 || overflowPx.top > 0 || overflowPx.bottom > 0;
  return { ok: true, box, overflow, overflowPx, minApplied };
}

/**
 * box → 一批 `/ops`（`props` 的 `box` 值，键是 film-core 的 `x/y/w/h/r`）。
 * `rotate === 0` 时不写 `r`：`film.html` 的 `styleText` 对 0 不产生声明，写 `r:0` 只会
 * 让回读多一个「有 r 但等于 0」的中间态。
 *
 * @param {{ clipId: string, box: { left: number, top: number, width: number, height: number, rotate?: number } }} input
 * @returns {any[]}
 */
export function boxToOps(input) {
  const box = input.box;
  const numbers = [box?.left, box?.top, box?.width, box?.height];
  if (numbers.some((value) => !Number.isFinite(Number(value))) || Number(box?.width) <= 0 || Number(box?.height) <= 0) {
    throw new Error(`boxToOps: box 非法：${JSON.stringify(box)}`);
  }
  const rotate = normalizeAngle(Number(box?.rotate ?? 0));
  /** @type {Record<string, number>} */
  const value = { x: round6(Number(box.left)), y: round6(Number(box.top)), w: round6(Number(box.width)), h: round6(Number(box.height)) };
  if (rotate !== 0) value.r = rotate;
  return [{ op: 'props', edits: [{ clip: input.clipId, prop: 'box', value }] }];
}

/**
 * 从 parse 出来的片段读回 box（`r` 缺省按 0 处理）。
 *
 * @param {any} clip
 * @returns {{ left: number, top: number, width: number, height: number, rotate: number } | null}
 */
export function readbackBox(clip) {
  const box = clip?.box;
  if (box === null || box === undefined || typeof box !== 'object') return null;
  const numbers = [box.x, box.y, box.w, box.h];
  if (numbers.some((value) => !Number.isFinite(Number(value)))) return null;
  return {
    left: Number(box.x),
    top: Number(box.y),
    width: Number(box.w),
    height: Number(box.h),
    rotate: Number.isFinite(Number(box.r)) ? Number(box.r) : 0,
  };
}

/**
 * 回读一致性：写后 parse 的值与请求值逐项误差 ≤ `eps`（默认 1e-3）。
 *
 * @param {{ left: number, top: number, width: number, height: number, rotate: number }} requested
 * @param {{ left: number, top: number, width: number, height: number, rotate: number } | null} readback
 * @param {number} [eps]
 * @returns {{ ok: boolean, eps: number, deltas: Record<string, number>, worst: number, missing?: true }}
 */
export function verifyReadback(requested, readback, eps = 1e-3) {
  if (readback === null) {
    return { ok: false, eps, deltas: {}, worst: Number.POSITIVE_INFINITY, missing: true };
  }
  /** @type {Record<string, number>} */
  const deltas = {};
  let worst = 0;
  for (const key of /** @type {const} */ (['left', 'top', 'width', 'height', 'rotate'])) {
    const delta = Math.abs(Number(readback[key]) - Number(requested[key]));
    deltas[key] = Number(delta.toFixed(6));
    if (delta > worst) worst = delta;
  }
  return { ok: worst <= eps, eps, deltas, worst: Number(worst.toFixed(6)) };
}
