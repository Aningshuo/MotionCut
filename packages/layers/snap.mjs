/**
 * 吸附与间距测量（S38 · ED-079）——**唯一实现**。
 *
 * 谁在用（一处实现、两处调用）：
 * 1. `canvas-gesture.mjs` 的**移动**手势（片段框体 / 图层框体，同一条代码路径：
 *    `snapRect` 吸边、`measureGaps` 量净空、`measureGapRuns` 找等距分布）；
 * 2. `canvas-gesture.mjs` 的**缩放**手势（`snapEdgesRotated` → `snapEdges`：只吸正在动的那条边；
 *    `r≠0` 时走 `aabbOfBox` / `anchoredResize` 把补偿量投影回局部轴）。
 *
 * 为什么单独一个文件：R2 的 `studio/ui/src/lib/stage-gesture.ts` 里有一份 `snapMove`，
 * 那份**没有产品调用**（只有 S4 的测试在用）。本轮把产品路径收成这一份，
 * 两处调用点都指向这里；studio 里那份待主线在 M36 顺手删（本线不能动 `packages/studio/**`）。
 *
 * ## 口径（写死）
 *
 * - **阈值 6 逻辑像素（屏幕 / CSS px）**：调用方把屏幕阈值换算成舞台局部单位再传进来
 *   （`threshold = 6 / stage.scale`），所以缩放 50% 时手感不变。
 * - **候选**：矩形左/中/右（上/中/下）三条线；**目标**：舞台 0/中点/末端、每个目标的左/中/右。
 * - 每轴只取**最近且 ≤ 阈值**的一条；平局按候选顺序（左→中→右）再按目标顺序，保证可复现。
 * - `grid` 给了就加一条「最近的网格线」目标（网格步长按舞台局部 px）。
 * - `enabled === false`（Alt 按住）→ 一条都不吸、不给参考线，连网格也不吸。
 * - 间距（gap）测量与吸附是**两个对象之间的净空**：只在另一轴上有重叠时才算，
 *   重叠（gap = 0）也算，负数按 0 处理。
 */

/** 吸附阈值（屏幕 px）。与 `GESTURE_SNAP_PX` 同值：保持既有手感。 */
export const SNAP_THRESHOLD_PX = 6;

/** 网格吸附的最小步长（舞台局部 px）：再小就变成「永远吸住」。 */
export const SNAP_GRID_MIN = 2;

/** 间距标签能显示的最小/最大整数值（px）；超出就不画，避免 12345px 这种噪声。 */
export const GAP_LABEL_MIN_PX = 0;
export const GAP_LABEL_MAX_PX = 9999;

const EPS = 1e-9;
/** @param {number} n @returns {number} */
const round3 = (n) => Math.round(n * 1000) / 1000;

/** @typedef {{x: number, y: number, w: number, h: number}} Rect4 */
/** @typedef {'x'|'y'} Axis */
/** @typedef {'edge'|'center'|'grid'} GuideKind */
/** @typedef {'stage'|'layer'|'grid'} GuideSource */
/** @typedef {{at: number, kind: GuideKind, source: GuideSource}} Line */
/** @typedef {{axis: Axis, at: number, kind: GuideKind, source: GuideSource, delta: number}} Guide */
/** @typedef {{axis: Axis, side: 'left'|'right'|'top'|'bottom', gap: number, from: number, to: number, at: number}} Gap */

/**
 * 取一个有限数，否则用兜底值。`value` 放宽成 `unknown`：可选字段传进来就是 `undefined`，
 * 让调用方到处写 `?? 0` 没有意义。
 * @param {unknown} value
 * @param {number} [fallback]
 * @returns {number}
 */
function num(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * @param {Rect4} rect
 * @param {readonly any[]} [targets]
 * @returns {Rect4[]}
 */
function targetRects(rect, targets) {
  /** @type {Rect4[]} */
  const out = [];
  for (const t of targets ?? []) {
    if (!t || typeof t !== 'object') continue;
    const x = num(t.x);
    const y = num(t.y);
    const w = num(t.w ?? t.width);
    const h = num(t.h ?? t.height);
    if (!(w > 0) || !(h > 0)) continue;
    out.push({ x, y, w, h });
  }
  return out;
}

/**
 * 一轴上的目标线（舞台局部）：舞台 0/中点/末端 + 每个目标的左/中/右 + 最近的网格线。
 * @param {Axis} axis
 * @param {{w: number, h: number} | null | undefined} stage
 * @param {Rect4[]} rects
 * @param {number | null} grid
 * @param {Rect4} rect 被拖的矩形（用来找最近的网格线）
 * @returns {Line[]}
 */
function linesOf(axis, stage, rects, grid, rect) {
  /** @type {Line[]} */
  const out = [];
  if (stage) {
    const span = axis === 'x' ? stage.w : stage.h;
    if (span > 0) {
      out.push({ at: 0, kind: 'edge', source: 'stage' });
      out.push({ at: span / 2, kind: 'center', source: 'stage' });
      out.push({ at: span, kind: 'edge', source: 'stage' });
    }
  }
  for (const r of rects) {
    const start = axis === 'x' ? r.x : r.y;
    const size = axis === 'x' ? r.w : r.h;
    out.push({ at: start, kind: 'edge', source: 'layer' });
    out.push({ at: start + size / 2, kind: 'center', source: 'layer' });
    out.push({ at: start + size, kind: 'edge', source: 'layer' });
  }
  if (typeof grid === 'number' && Number.isFinite(grid) && grid >= SNAP_GRID_MIN) {
    /* 三条候选线（起/中/末）各自最近的网格线：只按中心取的话，宽对象的两端会漏吸。
       去重后再入列（起/中/末常常落在同一条网格线附近）。 */
    const start = axis === 'x' ? rect.x : rect.y;
    const size = axis === 'x' ? rect.w : rect.h;
    const seen = new Set();
    for (const point of [start, start + size / 2, start + size]) {
      const k = point / grid;
      for (const line of [Math.floor(k), Math.ceil(k)]) {
        const at = line * grid;
        const key = String(round3(at));
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ at, kind: 'grid', source: 'grid' });
      }
    }
  }
  return out;
}

/**
 * 一轴的吸附：候选三条线 × 目标线，取最近。
 *
 * @param {Axis} axis
 * @param {{x: number, y: number, w: number, h: number}} rect
 * @param {Line[]} lines
 * @param {number} threshold
 * @param {readonly ('start'|'center'|'end')[]} [candidates]
 * @returns {Guide | null}
 */
function snapAxis(axis, rect, lines, threshold, candidates = ['start', 'center', 'end']) {
  const start = axis === 'x' ? rect.x : rect.y;
  const size = axis === 'x' ? rect.w : rect.h;
  const points = [];
  for (const which of candidates) {
    if (which === 'start') points.push(start);
    else if (which === 'center') points.push(start + size / 2);
    else points.push(start + size);
  }
  /** @type {Guide | null} */
  let best = null;
  let bestAbs = Number.POSITIVE_INFINITY;
  for (const p of points) {
    for (const line of lines) {
      const delta = line.at - p;
      const abs = Math.abs(delta);
      if (abs > threshold + EPS) continue;
      if (abs < bestAbs - EPS) {
        bestAbs = abs;
        best = { axis, at: round3(line.at), kind: line.kind, source: line.source, delta };
      }
    }
  }
  return best;
}

/**
 * 移动吸附。
 *
 * @param {object} input
 * @param {Rect4} input.rect                 被拖的矩形（舞台局部，已含指针位移）
 * @param {readonly any[]} [input.targets]   其它对象（舞台局部；调用方排除自己）
 * @param {{w: number, h: number} | null} [input.stage]
 * @param {number} [input.threshold]         舞台局部单位（调用方按 6 / scale 换算）
 * @param {number | null} [input.grid]       网格步长（舞台局部 px）；null/undefined = 不吸网格
 * @param {boolean} [input.enabled]          false = 本次完全不吸（Alt）
 * @returns {{dx: number, dy: number, guides: {axis: Axis, at: number}[], guideDetails: Guide[], snappedX: boolean, snappedY: boolean}}
 */
export function snapRect(input) {
  const rect = {
    x: num(input?.rect?.x),
    y: num(input?.rect?.y),
    w: Math.max(0, num(input?.rect?.w)),
    h: Math.max(0, num(input?.rect?.h))
  };
  const empty = { dx: 0, dy: 0, guides: [], guideDetails: [], snappedX: false, snappedY: false };
  if (input?.enabled === false) return empty;
  const threshold = typeof input?.threshold === 'number' && input.threshold > 0 ? input.threshold : SNAP_THRESHOLD_PX;
  const stage = input?.stage && num(input.stage.w) > 0 && num(input.stage.h) > 0 ? input.stage : null;
  /** @type {Rect4[]} */
  const rects = targetRects(rect, input?.targets);
  const grid = typeof input?.grid === 'number' && Number.isFinite(input.grid) ? input.grid : null;

  const xs = snapAxis('x', rect, linesOf('x', stage, rects, grid, rect), threshold);
  const ys = snapAxis('y', rect, linesOf('y', stage, rects, grid, rect), threshold);
  const details = [];
  if (xs) details.push(xs);
  if (ys) details.push(ys);
  return {
    dx: xs ? round3(xs.delta) : 0,
    dy: ys ? round3(ys.delta) : 0,
    /* `guides` 保持 S19 以来的形状（只有 axis/at）：老宿主/老断言按它 deepEqual。
       命中来源（舞台边/兄弟/网格）与补偿量放在 `guideDetails`。 */
    guides: details.map((g) => ({ axis: g.axis, at: g.at })),
    guideDetails: details,
    snappedX: xs !== null,
    snappedY: ys !== null
  };
}

/**
 * 缩放吸附：只吸**正在动的那条边**（`handle` 里带 e/w/n/s 的那一侧）。
 *
 * 为什么不做「整框三条线一起吸」：缩放时另外两条边是被锚定的，让它们参与吸附会把
 * 锚点拽走（A2 的「对侧不动」就没了）。
 *
 * @param {object} input
 * @param {Rect4} input.rect
 * @param {string} input.handle              `nw|n|ne|e|se|s|sw|w`
 * @param {readonly any[]} [input.targets]
 * @param {{w: number, h: number} | null} [input.stage]
 * @param {number} [input.threshold]
 * @param {number | null} [input.grid]
 * @param {boolean} [input.enabled]
 * @returns {{dx: number, dy: number, guides: {axis: Axis, at: number}[], guideDetails: Guide[]}}
 */
export function snapEdges(input) {
  const rect = {
    x: num(input?.rect?.x),
    y: num(input?.rect?.y),
    w: Math.max(0, num(input?.rect?.w)),
    h: Math.max(0, num(input?.rect?.h))
  };
  const none = { dx: 0, dy: 0, guides: [], guideDetails: [] };
  if (input?.enabled === false) return none;
  const handle = typeof input?.handle === 'string' ? input.handle : '';
  const threshold = typeof input?.threshold === 'number' && input.threshold > 0 ? input.threshold : SNAP_THRESHOLD_PX;
  const stage = input?.stage && num(input.stage.w) > 0 && num(input.stage.h) > 0 ? input.stage : null;
  /** @type {Rect4[]} */
  const rects = targetRects(rect, input?.targets);
  const grid = typeof input?.grid === 'number' && Number.isFinite(input.grid) ? input.grid : null;

  const movingX = handle.includes('e') ? ['end'] : handle.includes('w') ? ['start'] : [];
  const movingY = handle.includes('s') ? ['end'] : handle.includes('n') ? ['start'] : [];
  /** @type {Guide[]} */
  const details = [];
  let dx = 0;
  let dy = 0;
  if (movingX.length > 0) {
    const gx = snapAxis('x', rect, linesOf('x', stage, rects, grid, rect), threshold, /** @type {any} */ (movingX));
    if (gx) {
      dx = round3(gx.delta);
      details.push(gx);
    }
  }
  if (movingY.length > 0) {
    const gy = snapAxis('y', rect, linesOf('y', stage, rects, grid, rect), threshold, /** @type {any} */ (movingY));
    if (gy) {
      dy = round3(gy.delta);
      details.push(gy);
    }
  }
  return { dx, dy, guides: details.map((g) => ({ axis: g.axis, at: g.at })), guideDetails: details };
}

/**
 * 间距测量：被拖矩形与每个目标之间的净空（只在另一轴有重叠时算）。
 *
 * 返回每条边**最近的那个**（左/右/上/下各最多一条），供间距标签用：
 * - `gap` 是净空（重叠时为 0，永不 < 0）；
 * - `from`/`to` 是这条间隙在轴上的两个端点（舞台局部），画标签时取中点；
 * - `at` 是被测的那条边（被拖矩形的边）。
 *
 * @param {object} input
 * @param {Rect4} input.rect
 * @param {readonly any[]} [input.targets]
 * @param {{w: number, h: number} | null} [input.stage]  传了就**也**把画布四条边当邻居（默认不）
 * @param {boolean} [input.includeStage] 显式要求把画布边算进来（默认 false）
 * @param {'x'|'y'|'both'} [input.axes]
 * @returns {Gap[]}
 */
export function measureGaps(input) {
  const rect = {
    x: num(input?.rect?.x),
    y: num(input?.rect?.y),
    w: Math.max(0, num(input?.rect?.w)),
    h: Math.max(0, num(input?.rect?.h))
  };
  const axes = input?.axes === 'x' || input?.axes === 'y' ? input.axes : 'both';
  const stage = input?.stage && num(input.stage.w) > 0 && num(input.stage.h) > 0 ? input.stage : null;
  /** @type {Rect4[]} */
  const rects = targetRects(rect, input?.targets);
  /* 画布边默认**不算邻居**：把「离画布左边 284px」也当成一个要保住的间距，会让任何小位移
     都被吸回原位（B2 实测踩到）。只有显式要「到边界的距离」时才加（`includeStage`）。 */
  if (stage && input?.includeStage === true) {
    /* 画布边：把舞台当一个环（左右两条竖边、上下两条横边）——用零宽/零高矩形表达 */
    rects.push({ x: 0, y: 0, w: 0, h: stage.h });
    rects.push({ x: stage.w, y: 0, w: 0, h: stage.h });
    rects.push({ x: 0, y: 0, w: stage.w, h: 0 });
    rects.push({ x: 0, y: stage.h, w: stage.w, h: 0 });
  }
  /** @type {Gap[]} */
  const out = [];
  /** @param {Rect4} a @param {Rect4} b */
  const overlapsY = (a, b) => Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > EPS;
  /** @param {Rect4} a @param {Rect4} b */
  const overlapsX = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > EPS;
  /** @param {number} n @returns {number} */
  const round = (n) => Math.round(n);

  if (axes !== 'y') {
    /* 左右：只看在 y 上有重叠的目标（否则「间距」没有意义） */
    /** @type {Gap | null} */
    let bestRight = null;
    /** @type {Gap | null} */
    let bestLeft = null;
    for (const t of rects) {
      if (!overlapsY(rect, t)) continue;
      /* 目标在右 */
      if (t.x >= rect.x + rect.w - EPS) {
        const gap = Math.max(0, t.x - (rect.x + rect.w));
        if (gap >= GAP_LABEL_MIN_PX && (bestRight === null || gap < bestRight.gap)) {
          bestRight = { axis: 'x', side: 'right', gap, from: rect.x + rect.w, to: t.x, at: rect.x + rect.w };
        }
      }
      /* 目标在左 */
      if (t.x + t.w <= rect.x + EPS) {
        const gap = Math.max(0, rect.x - (t.x + t.w));
        if (gap >= GAP_LABEL_MIN_PX && (bestLeft === null || gap < bestLeft.gap)) {
          bestLeft = { axis: 'x', side: 'left', gap, from: t.x + t.w, to: rect.x, at: rect.x };
        }
      }
    }
    if (bestLeft) out.push({ ...bestLeft, gap: round(bestLeft.gap) });
    if (bestRight) out.push({ ...bestRight, gap: round(bestRight.gap) });
  }
  if (axes !== 'x') {
    /** @type {Gap | null} */
    let bestTop = null;
    /** @type {Gap | null} */
    let bestBottom = null;
    for (const t of rects) {
      if (!overlapsX(rect, t)) continue;
      if (t.y >= rect.y + rect.h - EPS) {
        const gap = Math.max(0, t.y - (rect.y + rect.h));
        if (gap >= GAP_LABEL_MIN_PX && (bestBottom === null || gap < bestBottom.gap)) {
          bestBottom = { axis: 'y', side: 'bottom', gap, from: rect.y + rect.h, to: t.y, at: rect.y + rect.h };
        }
      }
      if (t.y + t.h <= rect.y + EPS) {
        const gap = Math.max(0, rect.y - (t.y + t.h));
        if (gap >= GAP_LABEL_MIN_PX && (bestTop === null || gap < bestTop.gap)) {
          bestTop = { axis: 'y', side: 'top', gap, from: t.y + t.h, to: rect.y, at: rect.y };
        }
      }
    }
    if (bestTop) out.push({ ...bestTop, gap: round(bestTop.gap) });
    if (bestBottom) out.push({ ...bestBottom, gap: round(bestBottom.gap) });
  }
  return out.filter((g) => g.gap <= GAP_LABEL_MAX_PX);
}

/**
 * 间距吸附：把一条正在被拖的边吸到「保持某个既有间距」的位置。
 *
 * 用途（ED-079）：两个对象之间原来是 24px，拖动时靠近 24±阈值 就吸回 24 —— 标签上读数不再是
 * 18px/29px 这种噪声值。`pairs` 是 `{axis, side, gap}`（一般在手势开始时量一次）。
 *
 * @param {object} input
 * @param {Rect4} input.rect
 * @param {{axis: 'x'|'y', side: 'left'|'right'|'top'|'bottom', gap: number}[]} input.pairs
 * @param {readonly any[]} [input.targets]
 * @param {{w: number, h: number} | null} [input.stage]
 * @param {number} [input.threshold]
 * @param {boolean} [input.enabled]
 * @returns {{dx: number, dy: number, snapped: {axis: Axis, side: string, gap: number} | null}}
 */
export function snapGap(input) {
  const none = { dx: 0, dy: 0, snapped: null };
  if (input?.enabled === false) return none;
  const rect = {
    x: num(input?.rect?.x),
    y: num(input?.rect?.y),
    w: Math.max(0, num(input?.rect?.w)),
    h: Math.max(0, num(input?.rect?.h))
  };
  const threshold = typeof input?.threshold === 'number' && input.threshold > 0 ? input.threshold : SNAP_THRESHOLD_PX;
  const pairs = Array.isArray(input?.pairs) ? input.pairs : [];
  if (pairs.length === 0) return none;
  const gaps = measureGaps({ rect, targets: input?.targets, stage: null });
  /** @type {{axis: Axis, side: string, gap: number, dx: number, dy: number} | null} */
  let best = null;
  let bestAbs = Number.POSITIVE_INFINITY;
  for (const pair of pairs) {
    if (!pair || (pair.axis !== 'x' && pair.axis !== 'y')) continue;
    const current = gaps.find((g) => g.axis === pair.axis && g.side === pair.side);
    if (!current) continue;
    const delta = pair.gap - current.gap;
    const abs = Math.abs(delta);
    if (abs > threshold + EPS || abs < EPS) continue;
    if (abs < bestAbs) {
      bestAbs = abs;
      /* 符号：往右拖会**缩小**右侧间距、**增大**左侧间距（下/上同理）。
         所以要把 gap 从 18 补到 24，右侧必须往左退 6（sign=-1）。 */
      const sign = pair.side === 'left' || pair.side === 'top' ? 1 : -1;
      best = {
        axis: pair.axis,
        side: pair.side,
        gap: pair.gap,
        dx: pair.axis === 'x' ? sign * delta : 0,
        dy: pair.axis === 'y' ? sign * delta : 0
      };
    }
  }
  if (best === null) return none;
  return { dx: round3(best.dx), dy: round3(best.dy), snapped: { axis: best.axis, side: best.side, gap: best.gap } };
}

/* ────────────────────── 等距分布（S42 / ED-079 续） ────────────────────── */

/**
 * 等距分布的最小邻居数（验收 B/A1 的判据：≥3 个间距相等才算「分布」，两个只是「这一侧」）。
 * 两个对象之间也可以等距，但那是噪声，不是规律。
 */
export const GAP_RUN_MIN = 3;

/** 等距判定的默认容差（声明 px）。任务书给的 1px。 */
export const GAP_RUN_TOLERANCE_PX = 1;

/** 一条 run 最多记几个间距（防止 500 个等距层的数组爆掉）。 */
const GAP_RUN_MAX = 8;

/**
 * @typedef {{from: number, to: number, cross: number}} GapSegment `from`/`to` 是轴上的两个端点；
 *   `cross` 是另一轴上的绘制位置（chain 取两个对象的重叠中点，fan 取目标中心）
 * @typedef {{axis: Axis, side: 'left'|'right'|'top'|'bottom', gap: number, kind: 'chain',
 *   count: number, segments: GapSegment[], partners: string[]}} GapRun
 */

/**
 * 等距分布读数（S42）：从被拖矩形向两侧沿「最近的邻居」串成链，
 * 相邻几段的间距都相等、且 **≥ `GAP_RUN_MIN`（3）段** 才算一组（容差 `tolerance`，默认 1px）。
 *
 * 形态就是「一排对象等距排开」：`A | 24 | B | 24 | C | 24 | D`。
 *
 * ## 为什么**没有**「同侧多个邻居等距」（S42 试过，撤了）
 *
 * 第一版还做了 fan：同一侧的目标按间距分桶，某桶 ≥3 个就报一组。它在真实画面上是**噪声**——
 * 画面里到处是「一排一排」的片段，拖任何一个，另一排的四个对象往往离它一样远，于是每拖一下
 * 都会冒出 `= 48px =`、`= 80px =` 这种跟当前操作无关的读数（A1 实测：拖 `d-a` 上下动 12px，
 * y 轴上立刻多出一条 `= 48px =` 的 4 邻居读数）。链式不会：它要求「连续的段」都相等，
 * 而那种行列惯性最多只能凑出 1 段。
 *
 * 返回的 `segments` 里 `cross` 是画标签用的另一轴坐标：取两个对象在另一轴上的**重叠中点**
 * （标签正好落在两者之间）。
 *
 * @param {object} input
 * @param {Rect4} input.rect
 * @param {readonly any[]} [input.targets]
 * @param {'x'|'y'|'both'} [input.axes]
 * @param {number} [input.tolerance] 默认 1 声明 px
 * @returns {GapRun[]}
 */
export function measureGapRuns(input) {
  const rect = {
    x: num(input?.rect?.x),
    y: num(input?.rect?.y),
    w: Math.max(0, num(input?.rect?.w)),
    h: Math.max(0, num(input?.rect?.h))
  };
  const axes = input?.axes === 'x' || input?.axes === 'y' ? input.axes : 'both';
  const tolerance =
    typeof input?.tolerance === 'number' && Number.isFinite(input.tolerance) && input.tolerance > 0
      ? input.tolerance
      : GAP_RUN_TOLERANCE_PX;
  const rawTargets = Array.isArray(input?.targets) ? input.targets : [];

  /** @type {{rect: Rect4, id: string}[]} */
  const items = [{ rect, id: '' }];
  for (const t of rawTargets) {
    if (!t || typeof t !== 'object') continue;
    const w = num(t.w ?? t.width);
    const h = num(t.h ?? t.height);
    if (!(w > 0) || !(h > 0)) continue;
    items.push({ rect: { x: num(t.x), y: num(t.y), w, h }, id: String(t.at ?? '') });
  }

  /** 另一轴上的重叠长度（>0 才算「同一排」）。 @param {Rect4} a @param {Rect4} b @param {Axis} axis */
  const overlaps = (a, b, axis) => {
    if (axis === 'x') return Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > EPS;
    return Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > EPS;
  };
  /** 另一轴上的重叠中点（画标签用）。 @param {Rect4} a @param {Rect4} b @param {Axis} axis */
  const crossMid = (a, b, axis) => {
    if (axis === 'x') {
      const lo = Math.max(a.y, b.y);
      const hi = Math.min(a.y + a.h, b.y + b.h);
      return hi > lo ? (lo + hi) / 2 : (Math.max(a.y, b.y) + Math.min(a.y + a.h, b.y + b.h)) / 2;
    }
    const lo = Math.max(a.x, b.x);
    const hi = Math.min(a.x + a.w, b.x + b.w);
    return hi > lo ? (lo + hi) / 2 : (Math.max(a.x, b.x) + Math.min(a.x + a.w, b.x + b.w)) / 2;
  };
  /** @param {Rect4} r @param {Axis} axis */
  const startOf = (r, axis) => (axis === 'x' ? r.x : r.y);
  /** @param {Rect4} r @param {Axis} axis */
  const endOf = (r, axis) => (axis === 'x' ? r.x + r.w : r.y + r.h);

  /** @type {GapRun[]} */
  const runs = [];

  for (const axis of /** @type {Axis[]} */ (axes === 'both' ? ['x', 'y'] : [axes])) {
    const nearSide = axis === 'x' ? /** @type {const} */ ('right') : /** @type {const} */ ('bottom');
    const farSide = axis === 'x' ? /** @type {const} */ ('left') : /** @type {const} */ ('top');

    /* ── chain：一排等距（A|24|B|24|C|24|D） ── */
    for (const direction of /** @type {const} */ ([1, -1])) {
      /** @type {GapSegment[]} */
      const segments = [];
      /** @type {string[]} */
      const partners = [];
      let current = 0; /* items[0] 是被拖矩形 */
      let firstGap = null;
      for (;;) {
        let bestIndex = -1;
        let bestGap = Number.POSITIVE_INFINITY;
        const currentRect = /** @type {any} */ (items[current]).rect;
        for (let i = 0; i < items.length; i += 1) {
          if (i === current) continue;
          const other = /** @type {any} */ (items[i]).rect;
          if (!overlaps(currentRect, other, axis)) continue;
          const gap =
            direction > 0
              ? startOf(other, axis) - endOf(currentRect, axis)
              : startOf(currentRect, axis) - endOf(other, axis);
          if (gap < -EPS) continue;
          if (gap < bestGap - EPS) {
            bestGap = gap;
            bestIndex = i;
          }
        }
        if (bestIndex < 0) break;
        const gap = Math.max(0, bestGap);
        if (firstGap === null) {
          if (gap < EPS) break; /* 贴着的不叫「分布」 */
          firstGap = gap;
        } else if (Math.abs(gap - firstGap) > tolerance + EPS) break;
        const nextRect = /** @type {any} */ (items[bestIndex]).rect;
        const cross = crossMid(currentRect, nextRect, axis);
        segments.push(
          direction > 0
            ? { from: endOf(currentRect, axis), to: startOf(nextRect, axis), cross }
            : { from: endOf(nextRect, axis), to: startOf(currentRect, axis), cross }
        );
        partners.push(/** @type {any} */ (items[bestIndex]).id);
        current = bestIndex;
        if (segments.length >= GAP_RUN_MAX) break;
      }
      if (segments.length >= GAP_RUN_MIN && firstGap !== null) {
        runs.push({
          axis,
          side: direction > 0 ? nearSide : farSide,
          gap: Math.round(firstGap),
          kind: 'chain',
          count: segments.length,
          segments,
          partners
        });
      }
    }
  }

  /* 每轴每侧只留一条（左右/上下各一条，和间距读数同口径）：留段数最多的那条。 */
  /** @type {GapRun[]} */
  const out = [];
  for (const run of runs) {
    const same = out.find((item) => item.axis === run.axis && item.side === run.side);
    if (!same) {
      out.push(run);
      continue;
    }
    if (run.count > same.count) out[out.indexOf(same)] = run;
  }
  return out;
}

/* ────────────────────── 旋转片段的 AABB 吸附（S42） ────────────────────── */

/**
 * 旋转矩形的轴对齐外接框（AABB，舞台局部）。
 *
 * 角点绕**中心**旋转，再取四个角的最小/最大 —— 与宿主画旋转框用的是同一个定义。
 *
 * @param {{x: number, y: number, w: number, h: number}} box
 * @param {number} [rotationDeg]
 * @returns {Rect4}
 */
export function aabbOfBox(box, rotationDeg = 0) {
  const x = num(box?.x);
  const y = num(box?.y);
  const w = Math.max(0, num(box?.w));
  const h = Math.max(0, num(box?.h));
  const rad = ((num(rotationDeg) % 360) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = x + w / 2;
  const cy = y + h / 2;
  const hw = w / 2;
  const hh = h / 2;
  const corners = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh]
  ].map(([dx, dy]) => {
    const px = /** @type {number} */ (dx);
    const py = /** @type {number} */ (dy);
    return { x: cx + px * cos - py * sin, y: cy + px * sin + py * cos };
  });
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * 改宽高而**对侧锚点不动**（与 `canvas-gesture.mjs` 的 `dragBox()` 同一套反解）。
 *
 * 为什么需要它：AABB 的边对局部尺寸的导数，必须用「真实拖手柄的那次缩放」来量。
 * 绕中心放大（`aabbOfBox({...box, w+1})`）得到的导数是 `1/2 + cosθ/2`——与真正的
 * `cosθ` 差一半，补偿量会系统性偏小（S42 第一版算出 0.854 而不是 0.7071）。
 *
 * @param {Rect4} box
 * @param {string} handle
 * @param {number} rotationDeg
 * @param {number} dw
 * @param {number} dh
 * @returns {Rect4}
 */
export function anchoredResize(box, handle, rotationDeg, dw, dh) {
  const w = box.w + dw;
  const h = box.h + dh;
  const rad = ((num(rotationDeg) % 360) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const ax = handle.includes('w') ? 1 : handle.includes('e') ? -1 : 0;
  const ay = handle.includes('n') ? 1 : handle.includes('s') ? -1 : 0;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  /* 锚点 = 对侧边中点（stage 坐标） */
  const anchor = {
    x: cx + (ax * box.w / 2) * cos - (ay * box.h / 2) * sin,
    y: cy + (ax * box.w / 2) * sin + (ay * box.h / 2) * cos
  };
  const offX = ax * (w / 2);
  const offY = ay * (h / 2);
  const next = {
    x: anchor.x - (offX * cos - offY * sin),
    y: anchor.y - (offX * sin + offY * cos)
  };
  return { x: next.x - w / 2, y: next.y - h / 2, w, h };
}

/**
 * 旋转缩放的投影下限：`|d(AABB 边)/d(局部尺寸)|` 小于这个值就不吸。
 *
 * 为什么要有下限：AABB 边对局部宽度的导数是 `cosθ`（推导见 `snapEdgesRotated`）。
 * θ 越接近 90°，拖「东」手柄越主要是让角点上下跑，AABB 右缘几乎不动 —— 要在那种角度
 * 把右缘吸到目标上，宽度得变 1/cosθ 倍（θ=78° 时是 5 倍），画面会跳一下。
 * 0.5 对应 |θ| ≤ 60°，再往外只报「这一轴不吸」（`skipped`），不假装吸。
 */
export const SNAP_ROTATED_MIN_PROJECTION = 0.5;

/**
 * 旋转片段（`r≠0`）的缩放吸附：吸的是 **AABB 的边**，再把补偿量投影回**局部轴**。
 *
 * ## 推导
 *
 * 设旋转角 θ、局部宽 w、锚在「西边中点」A（手柄 `e` 时对侧锚点不动）。
 * 东边中点 E = A + R(θ)·(w, 0)，两个东角点 = A + R(θ)·(w, ±h/2)。展开 x 分量：
 *
 *     x(E_north) = A.x + w·cosθ + (h/2)·sinθ
 *     x(E_south) = A.x + w·cosθ − (h/2)·sinθ
 *     x(W_north) = A.x + (h/2)·sinθ        （w 不出现）
 *
 * h 不变时 `max` 取在东侧角点（0<θ<90°），于是
 *
 *     d(AABB.right)/dw = cosθ      →      Δw = Δaabb / cosθ
 *
 * 手柄 `w` 同理（对侧锚点是东边中点，AABB 左缘 d/dw = −cosθ），手柄 `n/s` 换到 y 轴、
 * 系数仍是 cosθ。θ 越过 90° 后 `cosθ<0`，取 max 的角点换到另一侧，符号会翻 —— 所以**不手写
 * ±cosθ**，用「把 w 加 1 再量一次 AABB」的**数值导数**：符号、角点切换、θ>90° 全都自动正确，
 * 而解析式留在注释里作为可读的推导与测试的对照值（U 系列会验 cos45°≈0.7071）。
 *
 * ## 不拽走对侧锚点
 *
 * 本函数只回**尺寸增量**（`dw`/`dh`），调用方拿它重新跑一次 `dragBox()` ——
 * 而 `dragBox` 是按「锚点不动」反解 x/y 的，所以锚点在构造上就不动（A2 会量 `anchorPointOf` 前后距离）。
 *
 * @param {object} input
 * @param {Rect4} input.box                 旋转前的局部 box（未吸附）
 * @param {string} input.handle             `nw|n|ne|e|se|s|sw|w`
 * @param {number} [input.rotationDeg]
 * @param {readonly any[]} [input.targets]
 * @param {{w: number, h: number} | null} [input.stage]
 * @param {number} [input.threshold]        舞台局部单位
 * @param {number | null} [input.grid]
 * @param {boolean} [input.enabled]
 * @returns {{dw: number, dh: number, aabb: Rect4, snappedAabb: Rect4, guides: {axis: Axis, at: number}[],
 *   guideDetails: Guide[], projection: {x: number, y: number}, skipped: Axis[]}}
 */
export function snapEdgesRotated(input) {
  const box = {
    x: num(input?.box?.x),
    y: num(input?.box?.y),
    w: Math.max(0, num(input?.box?.w)),
    h: Math.max(0, num(input?.box?.h))
  };
  const handle = typeof input?.handle === 'string' ? input.handle : '';
  /** @type {number} */
  const rotationDeg = num(input?.rotationDeg) || 0;
  const aabb = aabbOfBox(box, rotationDeg);
  const empty = {
    dw: 0,
    dh: 0,
    aabb,
    snappedAabb: aabb,
    guides: [],
    guideDetails: [],
    projection: { x: 0, y: 0 },
    skipped: []
  };
  if (input?.enabled === false) return empty;
  if (rotationDeg === 0) {
    /* r=0 走老路径（`snapEdges` 直接吸边），返回值形状保持一致 */
    const edges = snapEdges({
      rect: box,
      handle,
      targets: input?.targets,
      stage: input?.stage ?? null,
      threshold: input?.threshold,
      grid: input?.grid ?? null,
      enabled: input?.enabled
    });
    return {
      dw: edges.dx,
      dh: edges.dy,
      aabb: box,
      snappedAabb: anchoredResize(box, handle, 0, edges.dx, edges.dy),
      guides: edges.guides,
      guideDetails: edges.guideDetails,
      projection: { x: 1, y: 1 },
      skipped: []
    };
  }

  const edges = snapEdges({
    rect: aabb,
    handle,
    targets: input?.targets,
    stage: input?.stage ?? null,
    threshold: input?.threshold,
    grid: input?.grid ?? null,
    enabled: input?.enabled
  });

  /** @type {Axis[]} */
  const skipped = [];
  /** @type {Guide[]} */
  const details = [];
  let dw = 0;
  let dh = 0;
  const projection = { x: 0, y: 0 };

  /** @param {Axis} axis @param {number} deltaAabb */
  const project = (axis, deltaAabb) => {
    if (deltaAabb === 0) return 0;
    /* 探针必须是**对侧锚点不动**的那次缩放：绕中心放大时 d(AABB.right)/dw = 1/2 + cosθ/2，
       和真实拖手柄的 cosθ 差一半（第一版就是这么算出 0.854 的）。 */
    const probe = anchoredResize(box, handle, rotationDeg, axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0);
    const probeAabb = aabbOfBox(probe, rotationDeg);
    /** @param {Rect4} rect @returns {number} */
    const edgeOf = (rect) => {
      if (axis === 'x') return handle.includes('e') ? rect.x + rect.w : handle.includes('w') ? rect.x : rect.x;
      return handle.includes('s') ? rect.y + rect.h : handle.includes('n') ? rect.y : rect.y;
    };
    const d = edgeOf(probeAabb) - edgeOf(aabb);
    projection[axis] = d;
    if (Math.abs(d) < SNAP_ROTATED_MIN_PROJECTION) return Number.NaN;
    return deltaAabb / d;
  };

  if (edges.dx !== 0) {
    const local = project('x', edges.dx);
    if (Number.isNaN(local)) skipped.push('x');
    else dw = local;
    const guide = edges.guideDetails.find((g) => g.axis === 'x');
    if (!Number.isNaN(local) && guide) details.push(guide);
  } else {
    const guide = edges.guideDetails.find((g) => g.axis === 'x');
    if (guide) details.push(guide);
  }
  if (edges.dy !== 0) {
    const local = project('y', edges.dy);
    if (Number.isNaN(local)) skipped.push('y');
    else dh = local;
    const guide = edges.guideDetails.find((g) => g.axis === 'y');
    if (!Number.isNaN(local) && guide) details.push(guide);
  } else {
    const guide = edges.guideDetails.find((g) => g.axis === 'y');
    if (guide) details.push(guide);
  }

  /* 吸完的 AABB 也按「锚点不动」算：与调用方随后跑的 dragBox 同一次几何 */
  const snappedBox = anchoredResize(box, handle, rotationDeg, dw, dh);
  const snappedAabb = aabbOfBox(snappedBox, rotationDeg);
  return {
    dw: round3(dw),
    dh: round3(dh),
    aabb,
    snappedAabb,
    /* 只有真的吸住的轴才给参考线：被 `skipped` 掉的那一轴不给，否则是「画了线却没吸」 */
    guides: details.filter((g) => !skipped.includes(g.axis)).map((g) => ({ axis: g.axis, at: g.at })),
    guideDetails: details.filter((g) => !skipped.includes(g.axis)),
    projection,
    skipped
  };
}
