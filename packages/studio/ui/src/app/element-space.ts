/**
 * R120 · M6（LI-A11 / A12 / A13）· 元素几何的**唯一入口**。
 *
 * ## 为什么需要这一层
 *
 * 页面元素活在四层坐标里，任何一层搞错都会把错误倍率写进用户的 film：
 *
 * | 层 | 谁在缩放 | 读数从哪来 |
 * |---|---|---|
 * | 声明（页设计坐标） | 作者自己 | `describe().layout`（offset* 链，见 describe.ts） |
 * | 场景视口 | 无（iframe 内部不缩放） | 同上 |
 * | 舞台局部 | 网页片段 contain 进 `clip.box`（letterbox） | `pageFit()`，镜像 content-origin 的 `pictureRect` |
 * | 屏幕 | 舞台预览缩放 + 页面滚动 | `stageRect.scale`（父文档） |
 *
 * 结论（本批写死）：
 * - **数值字段**（X/Y/W/H）读写的是**声明坐标**：不受舞台缩放、iframe fit、滚动、祖先
 *   transform 影响 —— 因为 `offset*` 本来就不含这些。面板那条
 *   `left = 目标 − 实测 + 当前 left` 只要喂 `layout` 就对（R120 已把 `deps.describe` 改成喂它）。
 * - **手柄**把屏幕位移折回声明坐标：`Δ声明 = L⁻¹ · (Δ屏幕 ÷ stageScale)`，
 *   `L` = 祖先链线性 × 页面 fit；缩放还要按元素自身角度 R(−r) 投影回局部轴
 *   （与 `canvas-gesture.mjs` 的 S19 推导同一套，这里只做纯函数复用）。
 *
 * 本模块**不碰 DOM、不读时钟**，四情形都能在单测里算。
 */

/** 2×2 线性部分（列主序，与 DOMMatrix 的 a/b/c/d 一致）。 */
export interface Linear {
  a: number;
  b: number;
  c: number;
  d: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 祖先链读数（`describe().chain`）。 */
export type Chain =
  | { ok: true; a: number; b: number; c: number; d: number; rotationDeg: number; nodes: readonly string[] }
  | { ok: false; code: string; reason: string; nodes: readonly string[] };

/** 网页片段的尺寸来源（与 film 的 clip 同形，只取这两项）。 */
export interface PageClipLike {
  size?: { w?: unknown; h?: unknown } | null;
  box?: { x?: unknown; y?: unknown; w?: unknown; h?: unknown } | null;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * 网页片段在舞台里的**画面矩形**（contain + 居中）。
 *
 * 逐字镜像 `packages/studio/server/content-origin.mjs` 的 `pictureRect(kind='page', …)`：
 * `k = min(bw/ow, bh/oh)`、居中。为什么不 import 那边：那段代码在一个模板字符串里
 * （页内运行），没有导出。镜像的正确性由 `s209` 用 `layerRects` 的真读数反查
 * （同一元素：本函数的舞台框 vs content-origin 给的舞台框，差 ≤0.5px）。
 *
 * @param clip 片段（`size` 缺省 = 舞台尺寸）
 * @param stage 舞台声明尺寸
 */
export function pageFit(clip: PageClipLike | null, stage: { w: number; h: number }): { k: number; x: number; y: number } | null {
  const ownW = Number(clip?.size?.w) > 0 ? Number(clip?.size?.w) : Number(stage.w);
  const ownH = Number(clip?.size?.h) > 0 ? Number(clip?.size?.h) : Number(stage.h);
  if (!Number.isFinite(ownW) || !Number.isFinite(ownH) || ownW <= 0 || ownH <= 0) return null;
  const boxW = Number(clip?.box?.w) > 0 ? Number(clip?.box?.w) : ownW;
  const boxH = Number(clip?.box?.h) > 0 ? Number(clip?.box?.h) : ownH;
  const x = Number(clip?.box?.x) || 0;
  const y = Number(clip?.box?.y) || 0;
  const k = Math.min(boxW / ownW, boxH / ownH);
  if (!Number.isFinite(k) || k <= 0) return null;
  return { k, x: x + (boxW - ownW * k) / 2, y: y + (boxH - ownH * k) / 2 };
}

/**
 * 声明坐标 → 舞台局部的线性部分：`L = pageFit.k · 祖先链`。
 *
 * 只有等比缩放与旋转时才这么写（页面 fit 是等比的，见 pictureRect）。
 * 祖先链不可表达（3D/透视/退化）→ 原样返回错误码，**不许猜**。
 */
export function composeSpace(
  fit: { k: number } | null,
  chain: Chain | null,
): { ok: true; linear: Linear; rotationDeg: number } | { ok: false; code: string; reason: string } {
  if (fit === null) return { ok: false, code: 'NO_PAGE_FIT', reason: '页面尺寸或舞台尺寸读不到，换算不了' };
  if (chain === null) return { ok: false, code: 'UNSUPPORTED_ANCESTOR_MATRIX', reason: '没有祖先链读数' };
  if (chain.ok !== true) return { ok: false, code: chain.code, reason: chain.reason };
  const k = fit.k;
  if (!Number.isFinite(k) || k <= 0) return { ok: false, code: 'NO_PAGE_FIT', reason: `页面 fit 非法：${k}` };
  return {
    ok: true,
    linear: { a: chain.a * k, b: chain.b * k, c: chain.c * k, d: chain.d * k },
    rotationDeg: chain.rotationDeg,
  };
}

/**
 * 屏幕位移（CSS px）→ 声明坐标增量。
 *
 * 顺序与 `canvas-gesture.mjs` 的 `screenDeltaToDeclared` **逐字一致**：
 * `Δ/scale → L⁻¹ → R(−r)`。自己写一遍而不是 import，是为了让本模块保持纯函数、
 * 不把 100KB 的手势层拖进单测；两处一致性由 s209 的「拖柄 vs 字段」判据盯。
 */
export function declaredDelta(
  space: { linear: Linear },
  ownRotationDeg: number,
  stageScale: number,
  dxScreen: number,
  dyScreen: number,
): { x: number; y: number } {
  const scale = Number.isFinite(stageScale) && stageScale > 0 ? stageScale : 1;
  let vx = (Number.isFinite(dxScreen) ? dxScreen : 0) / scale;
  let vy = (Number.isFinite(dyScreen) ? dyScreen : 0) / scale;
  const det = space.linear.a * space.linear.d - space.linear.b * space.linear.c;
  if (Number.isFinite(det) && Math.abs(det) > 1e-9) {
    const inv = {
      a: space.linear.d / det,
      b: -space.linear.b / det,
      c: -space.linear.c / det,
      d: space.linear.a / det,
    };
    const nx = inv.a * vx + inv.c * vy;
    const ny = inv.b * vx + inv.d * vy;
    vx = nx;
    vy = ny;
  }
  const theta = Number.isFinite(ownRotationDeg) ? ownRotationDeg : 0;
  if (Math.abs(theta) > 1e-9) {
    const rad = (theta * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    const nx = vx * c + vy * s;
    const ny = -vx * s + vy * c;
    vx = nx;
    vy = ny;
  }
  return { x: round3(vx), y: round3(vy) };
}

/** 声明坐标的页框 → 舞台局部（画框/手柄用）。 */
export function layoutToStage(fit: { k: number; x: number; y: number }, layout: Rect): Rect {
  return {
    x: round3(fit.x + layout.x * fit.k),
    y: round3(fit.y + layout.y * fit.k),
    w: round3(layout.w * fit.k),
    h: round3(layout.h * fit.k),
  };
}

/** 读一次几何空间的完整结果（手柄与量具共用这一份）。 */
export function elementSpaceOf(
  clip: PageClipLike | null,
  stage: { w: number; h: number },
  chain: Chain | null,
): { ok: true; fit: { k: number; x: number; y: number }; linear: Linear; rotationDeg: number } | { ok: false; code: string; reason: string } {
  const fit = pageFit(clip, stage);
  const composed = composeSpace(fit, chain);
  if (composed.ok !== true) return composed;
  return { ok: true, fit: fit as { k: number; x: number; y: number }, linear: composed.linear, rotationDeg: composed.rotationDeg };
}

/** 写 `rotate` 属性时的值：总角度减去作者 transform 里的角度（作者那份不吃掉）。 */
export function rotationToWrite(targetTotal: number, authorRotation: number): number {
  const a = Number.isFinite(authorRotation) ? authorRotation : 0;
  let r = targetTotal - a;
  r = ((r % 360) + 360) % 360;
  if (r > 180) r -= 360;
  return Math.round(r * 10) / 10;
}

export interface GeometryBlockFacts {
  position: string;
  isFlexItem: boolean;
  isGridItem: boolean;
  widthFrom: string;
  heightFrom: string;
}

export interface GeometryStyleInput {
  field: 'x' | 'y' | 'w' | 'h' | 'rotate';
  target: number;
  /** 当前**声明**盒（`describe().layout`）—— 页坐标，不含 transform/scroll。 */
  layout: Rect;
  /** 当前 computed 值（`describe().style`）：left/top/width/height。 */
  computed: Readonly<Record<string, string>>;
  block: GeometryBlockFacts | null;
  /** 作者 transform 里的旋转角（`describe().rotate.author`）。 */
  authorRotation?: number;
}

export interface GeometryStyleResult {
  style: Record<string, string>;
  /** 明确固定化的说明（空 = 无损）。 */
  notes: string[];
  /** 这次写把哪些「会随内容/父级变化」的东西钉死了（reset 要解释的就是它）。 */
  fixed: string[];
}

/**
 * 声明坐标的目标值 → 一条最小 `style` patch。
 *
 * 与 `inspector-panel.mjs` 的 `elementGeometryPatch` **同一公式**（本批禁写那个文件）：
 * - 位置写**偏移**：`left = 目标 − 实测 + 当前 computed left`（relative 的 left 是相对原位）；
 * - 宽高写**差值**：`width = 当前 computed + (目标 − 实测)`（content-box 与 border-box 的差）；
 * - `static` 元素第一次写位置时补 `position: relative`（不脱离文档流，布局不塌）；
 * - `flex` 子项写宽高时补 `flex: 0 0 auto`（否则被 flex 压回去 = 静默没生效）。
 *
 * 非有限值一律拒绝（LI-A12「NaN/无限/极大不许写进 film」）。
 */
export function geometryStylePatch(input: GeometryStyleInput): GeometryStyleResult | { error: { code: string; message: string } } {
  const target = Number(input.target);
  if (!Number.isFinite(target)) {
    return { error: { code: 'INVALID_VALUE', message: `需要有限数值：${String(input.target)}` } };
  }
  if (Math.abs(target) > 1e6) {
    return { error: { code: 'INVALID_VALUE', message: `数值过大（${target}）：超过 1e6 的几何值一律不写` } };
  }
  const px = (key: string): number => {
    const n = Number.parseFloat(String(input.computed[key] ?? ''));
    return Number.isFinite(n) ? n : 0;
  };
  const style: Record<string, string> = {};
  const notes: string[] = [];
  const fixed: string[] = [];

  if (input.field === 'rotate') {
    const author = Number.isFinite(input.authorRotation) ? Number(input.authorRotation) : 0;
    style.rotate = `${rotationToWrite(target, author)}deg`;
    return { style, notes, fixed };
  }

  if (input.field === 'x' || input.field === 'y') {
    const key = input.field === 'x' ? 'left' : 'top';
    const measured = Number(input.field === 'x' ? input.layout.x : input.layout.y);
    const currentOffset = px(key);
    const next = Number.isFinite(measured) ? target - measured + currentOffset : target;
    style[key] = `${round2(next)}px`;
    const block = input.block;
    if (block !== null && block.position === 'static') {
      style.position = 'relative';
      notes.push('已启用相对定位');
      fixed.push('position: relative');
    }
    return { style, notes, fixed };
  }

  /* w / h */
  const key = input.field === 'w' ? 'width' : 'height';
  const measured = Number(input.field === 'w' ? input.layout.w : input.layout.h);
  const currentSize = px(key);
  const next = Number.isFinite(measured) && currentSize > 0 ? currentSize + (target - measured) : target;
  if (next < 1) {
    return { error: { code: 'INVALID_VALUE', message: `宽高不能小于 1px（算出来 ${round2(next)}）` } };
  }
  style[key] = `${round2(next)}px`;
  const block = input.block;
  const from = input.field === 'w' ? block?.widthFrom : block?.heightFrom;
  if (from === 'percent' || from === 'auto' || from === 'keyword') {
    notes.push(`${key} 原来是 ${from === 'percent' ? '百分比' : from === 'auto' ? 'auto' : '关键字'}：已固定成 ${round2(next)}px（不再随内容/父级变化，reset 可回作者布局）`);
    fixed.push(key);
  }
  if (block !== null && block.isFlexItem) {
    style.flex = '0 0 auto';
    notes.push('父级是 flex 容器：已同时写 flex: 0 0 auto，否则写进去的宽高会被压缩');
    fixed.push('flex');
  } else if (block !== null && block.isGridItem) {
    notes.push('父级是 grid 容器：宽高写在该网格区域内生效；要改列宽请改轨道定义（这里不碰布局容器）');
  }
  return { style, notes, fixed };
}

/**
 * reset 要删的键（只删**几何**，不碰同一条覆盖里的颜色/文字）。
 * 位置相关的 `position: relative` 与 `flex` 只在它们是我们补的时才该删 ——
 * 调用方拿 `describe().block` 判：作者自己写过 `position`/`flex` 的不在名单里。
 */
export const ELEMENT_GEOMETRY_KEYS: readonly string[] = ['left', 'top', 'width', 'height', 'rotate'];

/** 作者原值要不要保：`inline[position]` 非空 → 作者写过，不许删我们没写的。 */
export function resettableKeys(input: {
  overrideStyle: Readonly<Record<string, string>> | null;
  inline: Readonly<Record<string, string>> | null;
}): string[] {
  const style = input.overrideStyle ?? {};
  const inline = input.inline ?? {};
  const out: string[] = [];
  for (const key of ELEMENT_GEOMETRY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(style, key)) out.push(key);
  }
  if (Object.prototype.hasOwnProperty.call(style, 'position') && (inline.position ?? '') === '') out.push('position');
  if (Object.prototype.hasOwnProperty.call(style, 'flex') && (inline.flex ?? '') === '') out.push('flex');
  return out;
}
