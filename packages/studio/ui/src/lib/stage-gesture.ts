/**
 * 画布手势：命中、选择、对齐位移、并集（副线1 · WP13）
 *
 * 全部纯函数：输入层框集合 + 指针，输出选择/对齐结果。
 * 坐标系：**画面框的 stage px**（见 stage-fit.ts），不是容器 px。
 *
 * 吸附（`snapMove`）**已从这里移除**（M35 · R21）：产品路径早就收成
 * `packages/layers/snap.mjs` 的 `snapRect` / `snapEdges` 一份（`canvas-gesture.mjs`
 * 的移动与缩放都调它），这个文件里那份零产品引用，只剩 S4 的旧测试在 import 它。
 * 留着就是「测试测死代码」，所以删掉，测试改到新入口。
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** 绕自身中心顺时针角度；缺省 0。 */
  readonly rotation?: number;
  readonly id?: string;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const EPS = 1e-6;

export type AlignEdge = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

/** 旋转后的四个角（顺序：左上、右上、右下、左下）。 */
export function corners(box: Box): [Point, Point, Point, Point] {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const rad = ((box.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const hw = box.w / 2;
  const hh = box.h / 2;
  const turn = (dx: number, dy: number): Point => ({ x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos });
  return [turn(-hw, -hh), turn(hw, -hh), turn(hw, hh), turn(-hw, hh)];
}

/** 外接轴对齐框（旋转层不能拿原 w/h 当命中框）。 */
export function outerAABB(box: Box): Rect {
  if (!box.rotation) return { x: box.x, y: box.y, w: box.w, h: box.h };
  const pts = corners(box);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { x: left, y: top, w: Math.max(...xs) - left, h: Math.max(...ys) - top };
}

/** 旋转感知的点命中：把点转回层的局部坐标再比半宽半高。 */
export function pointInBox(box: Box, p: Point): boolean {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const rad = (-(box.rotation ?? 0) * Math.PI) / 180;
  const dx = p.x - cx;
  const dy = p.y - cy;
  const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
  const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
  return Math.abs(lx) <= box.w / 2 + EPS && Math.abs(ly) <= box.h / 2 + EPS;
}

export function rectContainsPoint(r: Rect, p: Point): boolean {
  return p.x >= r.x - EPS && p.x <= r.x + r.w + EPS && p.y >= r.y - EPS && p.y <= r.y + r.h + EPS;
}

/** 所有命中的层下标，按绘制顺序（数组末尾在最上）。 */
export function hitAll(boxes: readonly Box[], p: Point): number[] {
  const out: number[] = [];
  boxes.forEach((b, i) => {
    if (pointInBox(b, p)) out.push(i);
  });
  return out;
}

/** 常规命中：最上层；`deep`（Alt 穿透）：最下层。 -1 = 没命中。 */
export function hitTest(boxes: readonly Box[], p: Point, opts: { readonly deep?: boolean } = {}): number {
  const hits = hitAll(boxes, p);
  if (!hits.length) return -1;
  return opts.deep ? hits[0]! : hits[hits.length - 1]!;
}

/** Shift 加选不丢已选；Shift 再点已选 → 取消；无 Shift → 单选。 */
export function resolveSelection(
  selected: readonly number[],
  hit: number,
  mods: { readonly shift?: boolean } = {}
): number[] {
  if (hit < 0) return mods.shift ? [...selected] : [];
  if (!mods.shift) return [hit];
  return selected.includes(hit) ? selected.filter((i) => i !== hit) : [...selected, hit];
}

function rectHasPolygon(r: Rect, box: Box): boolean {
  return corners(box).every((p) => rectContainsPoint(r, p));
}

function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const cross = (o: Point, p: Point, q: Point) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function polygonIntersectsRect(box: Box, r: Rect): boolean {
  const pts = corners(box);
  if (pts.some((p) => rectContainsPoint(r, p))) return true;
  const rc: [Point, Point, Point, Point] = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h }
  ];
  if (rc.some((p) => pointInBox(box, p))) return true;
  for (let i = 0; i < 4; i += 1) {
    for (let j = 0; j < 4; j += 1) {
      if (segmentsCross(pts[i]!, pts[(i + 1) % 4]!, rc[j]!, rc[(j + 1) % 4]!)) return true;
    }
  }
  return false;
}

/**
 * 框选。`contain`：整个层都在框内；`intersect`：与框有任何重叠。
 * 旋转层用真实多边形，不拿轴对齐框糊。
 */
export function marqueeSelect(boxes: readonly Box[], rect: Rect, mode: 'contain' | 'intersect' = 'contain'): number[] {
  const out: number[] = [];
  boxes.forEach((b, i) => {
    const inside = mode === 'contain' ? rectHasPolygon(rect, b) : polygonIntersectsRect(b, rect);
    if (inside) out.push(i);
  });
  return out;
}

/** 两层间距：分离轴上的净空；重叠轴为 0。 */
export interface BoxGap {
  readonly dx: number;
  readonly dy: number;
  readonly distance: number;
}

export function boxGap(a: Box, b: Box): BoxGap {
  const dx = a.x >= b.x + b.w ? a.x - (b.x + b.w) : b.x >= a.x + a.w ? b.x - (a.x + a.w) : 0;
  const dy = a.y >= b.y + b.h ? a.y - (b.y + b.h) : b.y >= a.y + a.h ? b.y - (a.y + a.h) : 0;
  return { dx, dy, distance: Math.hypot(dx, dy) };
}

/** 对齐到并集框（边/中心）。返回位移，不改输入。 */
export function alignShift(edge: AlignEdge, box: Box, union: Rect): { dx: number; dy: number } {
  return {
    dx:
      edge === 'left'
        ? union.x - box.x
        : edge === 'right'
          ? union.x + union.w - (box.x + box.w)
          : edge === 'hcenter'
            ? union.x + union.w / 2 - (box.x + box.w / 2)
            : 0,
    dy:
      edge === 'top'
        ? union.y - box.y
        : edge === 'bottom'
          ? union.y + union.h - (box.y + box.h)
          : edge === 'vcenter'
            ? union.y + union.h / 2 - (box.y + box.h / 2)
            : 0
  };
}

export function unionBox(boxes: readonly Box[]): Rect | null {
  if (!boxes.length) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const b of boxes) {
    left = Math.min(left, b.x);
    top = Math.min(top, b.y);
    right = Math.max(right, b.x + b.w);
    bottom = Math.max(bottom, b.y + b.h);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}
