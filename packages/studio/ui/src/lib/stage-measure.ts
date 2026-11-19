/**
 * 舞台测距（副线1 · WP13）
 *
 * 算法对照参考 stage-measure.ts（measureGaps，1–53 行）：
 * - 两框在某轴分离 → 画一条跨间隙的实线（带长度）；
 * - 两轴都重叠（包含/交叉）→ 画近边与远边的偏移；
 * - 只在一轴重叠 → 该轴不画线（另一轴才是真正的距离）。
 *
 * 输入是 stage px 的轴对齐框；旋转层先用 stage-gesture.outerAABB 取外接框再测。
 */

export interface MeasureRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface MeasureLine {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  /** 有长度的是实测线；没有的是虚线辅助线。 */
  readonly length?: number;
  readonly helper?: true;
}

/** 小于此值视为两条边相接，不画线。 */
export const MEETS = 0.5;

export function measureGaps(a: MeasureRect, b: MeasureRect): MeasureLine[] {
  const out: MeasureLine[] = [];
  const axis = (along: 'x' | 'y'): void => {
    const across = along === 'x' ? 'y' : 'x';
    const size = along === 'x' ? 'w' : 'h';
    const crossSize = along === 'x' ? 'h' : 'w';
    const a0 = a[along];
    const a1 = a[along] + a[size];
    const b0 = b[along];
    const b1 = b[along] + b[size];
    const lo = Math.max(a[across], b[across]);
    const hi = Math.min(a[across] + a[crossSize], b[across] + b[crossSize]);
    const overlapAcross = hi >= lo;
    const at = overlapAcross ? (lo + hi) / 2 : a[across] + a[crossSize] / 2;
    const near = b[across] > at ? b[across] : b[across] + b[crossSize];
    const line = (from: number, to: number, helperAt: number | null): void => {
      if (to - from < MEETS) return;
      if (along === 'x') out.push({ x1: from, y1: at, x2: to, y2: at, length: to - from });
      else out.push({ x1: at, y1: from, x2: at, y2: to, length: to - from });
      if (helperAt == null || overlapAcross) return;
      if (along === 'x') out.push({ x1: helperAt, y1: near, x2: helperAt, y2: at, helper: true });
      else out.push({ x1: near, y1: helperAt, x2: at, y2: helperAt, helper: true });
    };
    if (b0 >= a1) line(a1, b0, b0);
    else if (b1 <= a0) line(b1, a0, b1);
    else if (overlapAcross) {
      line(Math.min(a0, b0), Math.max(a0, b0), null);
      line(Math.min(a1, b1), Math.max(a1, b1), null);
    }
  };
  axis('x');
  axis('y');
  return out;
}

/** 分离轴上的净空；重叠为 0。测距断言用这个数。 */
export function measuredGap(a: MeasureRect, b: MeasureRect): { dx: number; dy: number; distance: number } {
  const dx = a.x >= b.x + b.w ? a.x - (b.x + b.w) : b.x >= a.x + a.w ? b.x - (a.x + a.w) : 0;
  const dy = a.y >= b.y + b.h ? a.y - (b.y + b.h) : b.y >= a.y + a.h ? b.y - (a.y + a.h) : 0;
  return { dx, dy, distance: Math.hypot(dx, dy) };
}

/** 实测线（排除虚线辅助线），按长度从长到短。 */
export function measuredLines(lines: readonly MeasureLine[]): MeasureLine[] {
  return lines.filter((l) => typeof l.length === 'number').sort((x, y) => (y.length ?? 0) - (x.length ?? 0));
}
