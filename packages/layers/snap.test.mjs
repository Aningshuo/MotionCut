// @ts-nocheck —— 验收脚本以 node --test 的断言为准；产品模块仍由 tsc 严格检查。
/**
 * S38-SNAP-GUIDES 纯函数验收（B-SUB1-R19-019 · ED-079）
 *
 * 覆盖：吸附阈值、舞台边/中心、目标左中右、网格、Alt 关闭、缩放只吸动边、
 * 间距测量（24px 那条验收）、间距吸附、500 目标下的计算耗时（p95 ≤ 1ms）。
 *
 * 运行：node --test packages/layers/snap.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { judgeAgainstBaseline } from './perf-budget.mjs';

const S = await import(new URL('./snap.mjs', import.meta.url).href);

const STAGE = { w: 1280, h: 720 };
const round = (n, d = 3) => Math.round(Number(n) * 10 ** d) / 10 ** d;

/** 与 runtime 同口径：阈值 6 屏幕 px 换算成舞台局部（调用方做，这里模拟 scale=1 与 0.5）。 */
const TH = S.SNAP_THRESHOLD_PX;

test('S38-U1 阈值：6px 内吸、6px 外不吸（含边界 6.0 与 6.01）', () => {
  const target = { x: 640, y: 0, w: 100, h: 100 };
  const rows = [];
  for (const distance of [0, 2, 5.99, 6, 6.01, 7, 20]) {
    const rect = { x: 640 - distance - 100, y: 300, w: 100, h: 100 }; /* 右缘 = 640 - distance */
    const got = S.snapRect({ rect, targets: [target], stage: null, threshold: TH });
    const wantSnap = distance <= 6 + 1e-9;
    assert.equal(got.snappedX, wantSnap, `间距 ${distance}px 时应 ${wantSnap ? '吸' : '不吸'}：${JSON.stringify(got)}`);
    if (wantSnap) assert.ok(Math.abs(got.dx - distance) < 1e-6, `间距 ${distance} 的补偿应是 ${distance}，实际 ${got.dx}`);
    rows.push({ distance, snapped: got.snappedX, dx: round(got.dx), guide: got.guides[0] ?? null });
  }
  /* 阈值按调用方传入（再验一次 0.5 倍缩放：6 屏幕 px = 12 舞台局部） */
  const stagedRect = { x: 640 - 10 - 100, y: 300, w: 100, h: 100 }; /* 右缘距目标左缘 10 */
  const scaled = S.snapRect({ rect: stagedRect, targets: [target], stage: null, threshold: TH / 0.5 });
  assert.equal(scaled.snappedX, true, 'scale=0.5 时 10 舞台局部 = 5 屏幕 px，仍在阈值内');
  assert.equal(round(scaled.dx), 10);
  assert.equal(
    S.snapRect({ rect: stagedRect, targets: [target], stage: null, threshold: TH }).snappedX,
    false,
    'scale=1 时 10 舞台局部 = 10 屏幕 px，超出 6px 阈值',
  );
});

test('S38-U2 舞台边与中心：左/中/右、上/中/下都吸，参考线落在目标线上', () => {
  const near = (rect, threshold = TH) => S.snapRect({ rect, targets: [], stage: STAGE, threshold });
  const left = near({ x: 3, y: 300, w: 100, h: 100 });
  assert.equal(left.dx, -3);
  /* `guides` 只有 axis/at（老形状）；来源与补偿量在 `guideDetails` */
  assert.deepEqual(left.guides, [{ axis: 'x', at: 0 }]);
  assert.deepEqual(left.guideDetails, [{ axis: 'x', at: 0, kind: 'edge', source: 'stage', delta: -3 }]);
  const center = near({ x: 595, y: 300, w: 100, h: 100 }); /* 中心 645 → 640 */
  assert.equal(center.dx, -5);
  assert.equal(center.guideDetails[0].kind, 'center');
  const right = near({ x: 1179, y: 300, w: 100, h: 100 }); /* 右缘 1279 → 1280 */
  assert.equal(right.dx, 1);
  const top = near({ x: 300, y: 2, w: 100, h: 100 });
  assert.equal(top.dy, -2);
  const vcenter = near({ x: 300, y: 313, w: 100, h: 100 }); /* 中心 363 → 360 */
  assert.equal(vcenter.dy, -3);
  const bottom = near({ x: 300, y: 617, w: 100, h: 100 }); /* 底 717 → 720 */
  assert.equal(bottom.dy, 3);
});

test('S38-U3 兄弟目标：左/中/右三条线都参与，且只吸最近的一条', () => {
  const sibling = { x: 400, y: 0, w: 200, h: 100 };
  const snapLeft = S.snapRect({ rect: { x: 404, y: 200, w: 100, h: 100 }, targets: [sibling], stage: null, threshold: TH });
  assert.equal(snapLeft.dx, -4);
  assert.equal(snapLeft.guides[0].at, 400);
  const snapCenter = S.snapRect({ rect: { x: 446, y: 200, w: 100, h: 100 }, targets: [sibling], stage: null, threshold: TH });
  assert.equal(snapCenter.dx, 4); /* 中心 496 → 500 */
  assert.equal(snapCenter.guideDetails[0].kind, 'center');
  /* 左缘 596 → 目标右缘 600（+4，阈值内） */
  const snapRight = S.snapRect({ rect: { x: 596, y: 200, w: 100, h: 100 }, targets: [sibling], stage: null, threshold: TH });
  assert.equal(snapRight.dx, 4);
  assert.equal(snapRight.guides[0].at, 600);
  /* 离所有线都远（左缘 760 距最近的目标右缘 600 有 160）→ 不吸 */
  const farAway = S.snapRect({ rect: { x: 760, y: 200, w: 100, h: 100 }, targets: [sibling], stage: null, threshold: TH });
  assert.equal(farAway.snappedX, false, `不该吸：${JSON.stringify(farAway)}`);
});

test('S38-U4 网格：给了 grid 就吸最近的网格线；没给/太小就不吸', () => {
  const grid20 = S.snapRect({ rect: { x: 18, y: 41, w: 100, h: 100 }, targets: [], stage: null, threshold: TH, grid: 20 });
  assert.equal(grid20.dx, 2, '左缘 18 → 20');
  assert.equal(grid20.dy, -1, '上缘 41 → 40');
  assert.equal(grid20.guideDetails.every((g) => g.source === 'grid'), true);
  const noGrid = S.snapRect({ rect: { x: 18, y: 41, w: 100, h: 100 }, targets: [], stage: null, threshold: TH });
  assert.equal(noGrid.snappedX, false);
  const tinyGrid = S.snapRect({ rect: { x: 18, y: 41, w: 100, h: 100 }, targets: [], stage: null, threshold: TH, grid: 1 });
  assert.equal(tinyGrid.snappedX, false, '网格步长小于 SNAP_GRID_MIN 时忽略');
});

test('S38-U5 Alt 关闭：enabled:false 一条都不吸（含网格与舞台边）', () => {
  const off = S.snapRect({
    rect: { x: 3, y: 3, w: 100, h: 100 },
    targets: [{ x: 105, y: 0, w: 10, h: 200 }],
    stage: STAGE,
    threshold: TH,
    grid: 10,
    enabled: false
  });
  assert.deepEqual(off, { dx: 0, dy: 0, guides: [], guideDetails: [], snappedX: false, snappedY: false });
  const on = S.snapRect({
    rect: { x: 3, y: 3, w: 100, h: 100 },
    targets: [{ x: 105, y: 0, w: 10, h: 200 }],
    stage: STAGE,
    threshold: TH,
    grid: 10
  });
  assert.equal(on.snappedX, true, '同一位置开着吸附就必须吸（对照）');
});

test('S38-U6 缩放吸附：只吸正在动的那条边，锚定边不参与', () => {
  const target = { x: 500, y: 0, w: 100, h: 100 };
  /* 拉右边：右缘 498 → 500 */
  const e = S.snapEdges({ rect: { x: 398, y: 200, w: 100, h: 100 }, handle: 'e', targets: [target], stage: null, threshold: TH });
  assert.equal(e.dx, 2);
  assert.equal(e.dy, 0);
  assert.equal(e.guides.length, 1);
  assert.equal(e.guides[0].at, 500);
  assert.equal(e.guideDetails[0].source, 'layer');
  /* 拉左边：左缘 402 → 400（目标左缘 + 目标右缘都有，最近的 400） */
  const w = S.snapEdges({ rect: { x: 402, y: 200, w: 100, h: 100 }, handle: 'w', targets: [{ x: 400, y: 0, w: 100, h: 100 }], stage: null, threshold: TH });
  assert.equal(w.dx, -2);
  /* 拉上边：只动 y，x 完全不吸（即使左缘离目标很近） */
  const n = S.snapEdges({ rect: { x: 402, y: 203, w: 100, h: 100 }, handle: 'n', targets: [{ x: 400, y: 200, w: 100, h: 100 }], stage: null, threshold: TH });
  assert.equal(n.dx, 0);
  assert.equal(n.dy, -3);
  /* Alt：不吸 */
  assert.deepEqual(S.snapEdges({ rect: { x: 398, y: 200, w: 100, h: 100 }, handle: 'e', targets: [target], stage: null, threshold: TH, enabled: false }), {
    dx: 0,
    dy: 0,
    guides: [],
    guideDetails: []
  });
});

test('S38-U7 间距测量：24px 那条（B2）——右/下各一条，重叠轴不量', () => {
  const right = { x: 400, y: 100, w: 100, h: 100 };
  const gaps = S.measureGaps({ rect: { x: 276, y: 100, w: 100, h: 100 }, targets: [right] });
  const gapRight = gaps.find((g) => g.axis === 'x' && g.side === 'right');
  assert.ok(gapRight, `应量到右侧间距：${JSON.stringify(gaps)}`);
  assert.equal(gapRight.gap, 24);
  assert.equal(gapRight.from, 376);
  assert.equal(gapRight.to, 400);
  /* 没有 y 重叠：不量（间距无意义） */
  const noOverlap = S.measureGaps({ rect: { x: 276, y: 300, w: 100, h: 100 }, targets: [right] });
  assert.equal(noOverlap.filter((g) => g.axis === 'x').length, 0);
  /* 画布边默认不算邻居（否则小位移会被「保持左边距」吸住）；显式 includeStage 才量 */
  const edgeOff = S.measureGaps({ rect: { x: 10, y: 300, w: 100, h: 100 }, targets: [], stage: STAGE });
  assert.equal(edgeOff.length, 0, `默认不该把画布边当邻居：${JSON.stringify(edgeOff)}`);
  const edge = S.measureGaps({ rect: { x: 10, y: 300, w: 100, h: 100 }, targets: [], stage: STAGE, includeStage: true });
  const left = edge.find((g) => g.axis === 'x' && g.side === 'left');
  assert.equal(left?.gap, 10);
  /* 重叠时 gap = 0，不出现负值 */
  const overlap = S.measureGaps({ rect: { x: 350, y: 100, w: 200, h: 100 }, targets: [right], axes: 'x' });
  assert.equal(overlap.every((g) => g.gap >= 0), true);
});

test('S38-U8 间距吸附：24±6 吸回 24，24±7 不动', () => {
  const right = { x: 400, y: 100, w: 100, h: 100 };
  const pairs = [{ axis: 'x', side: 'right', gap: 24 }];
  const near = S.snapGap({ rect: { x: 282, y: 100, w: 100, h: 100 }, targets: [right], pairs, threshold: TH });
  /* 目标在右边：间距 18 → 24 要往**左**退 6（右移只会更近） */
  assert.equal(near.dx, -6, `当前间距 18 → 吸到 24（-6）：${JSON.stringify(near)}`);
  assert.equal(near.dy, 0);
  assert.equal(near.snapped.gap, 24);
  const exact = S.snapGap({ rect: { x: 276, y: 100, w: 100, h: 100 }, targets: [right], pairs, threshold: TH });
  assert.equal(exact.dx, 0, '正好 24 时不必补偿');
  const far = S.snapGap({ rect: { x: 269, y: 100, w: 100, h: 100 }, targets: [right], pairs, threshold: TH });
  assert.equal(far.dx, 0, '间距 31 = 24+7，超出阈值');
  const off = S.snapGap({ rect: { x: 282, y: 100, w: 100, h: 100 }, targets: [right], pairs, threshold: TH, enabled: false });
  assert.equal(off.dx, 0);
});

test('S38-U9 性能：500 个目标、单次吸附 p95 对 100 目标基线（floor 1ms）', () => {
  /* S52：原来是**绝对** `p95 <= 1`，一条 GC 或别的 Chromium 抢核就红（R31 全量跑出过 1.94ms）。
     现在同进程先量 100 目标的基线（1/5 数据量），判据
     `p95_500 ≤ max(1, p95_100 × 4 + 0.2)`；floor 仍是 1ms，没放大。 */
  const targets = Array.from({ length: 500 }, (_, i) => ({
    x: (i % 25) * 48 + 7,
    y: Math.floor(i / 25) * 32 + 5,
    w: 40,
    h: 24
  }));
  const small = targets.slice(0, 100);
  const rect = { x: 137.5, y: 91.25, w: 120, h: 80 };
  const run = (list, rounds) => {
    /* 暖机：JIT + 首次分配 */
    for (let i = 0; i < 50; i += 1) S.snapRect({ rect, targets: list, stage: STAGE, threshold: TH, grid: 8 });
    const out = [];
    for (let i = 0; i < rounds; i += 1) {
      const t0 = performance.now();
      S.snapRect({ rect, targets: list, stage: STAGE, threshold: TH, grid: 8 });
      out.push(performance.now() - t0);
    }
    out.sort((a, b) => a - b);
    return { p95: out[Math.floor(out.length * 0.95)], median: out[Math.floor(out.length / 2)] };
  };

  const measured = run(targets, 500);
  const baseline = run(small, 200);
  const judge = judgeAgainstBaseline({
    measuredP95: measured.p95,
    baselineP95: baseline.p95,
    floor: 1,
    factor: 4,
    slack: 0.2
  });
  process.stdout.write(`JUDGE snap ${judge.formula}\n`);
  assert.ok(judge.pass, `吸附计算 p95 超判据：${judge.formula}（中位 ${round(measured.median, 4)}ms）`);

  /* 间距测量同口径（拖动期每帧都跑）：500 次 vs 100 目标 200 次基线 */
  const gapRun = (list, rounds) => {
    const out = [];
    for (let i = 0; i < rounds; i += 1) {
      const t0 = performance.now();
      S.measureGaps({ rect, targets: list, stage: STAGE });
      out.push(performance.now() - t0);
    }
    out.sort((a, b) => a - b);
    return out[Math.floor(out.length * 0.95)];
  };
  const gapJudge = judgeAgainstBaseline({
    measuredP95: gapRun(targets, 200),
    baselineP95: gapRun(small, 100),
    floor: 1,
    factor: 4,
    slack: 0.2
  });
  process.stdout.write(`JUDGE gaps ${gapJudge.formula}\n`);
  assert.ok(gapJudge.pass, `间距测量 p95 超判据：${gapJudge.formula}`);
});

/* ────────────────── S42：AABB / 等距分布 / 旋转缩放吸附 ────────────────── */

test('U10 aabbOfBox：r=0 恒等、r=90 换宽高、r=45 外接框 = 对角线', () => {
  const box = { x: 100, y: 200, w: 200, h: 100 };

  const flat = S.aabbOfBox(box, 0);
  assert.deepEqual(
    { x: round(flat.x), y: round(flat.y), w: round(flat.w), h: round(flat.h) },
    { x: 100, y: 200, w: 200, h: 100 }
  );

  /* 90°：200×100 → 100×200，中心不变 (200, 250) */
  const upright = S.aabbOfBox(box, 90);
  assert.equal(round(upright.w), 100);
  assert.equal(round(upright.h), 200);
  assert.equal(round(upright.x + upright.w / 2), 200);
  assert.equal(round(upright.y + upright.h / 2), 250);

  /* 45°：正方形 100×100 → AABB 边长 100√2，中心不变 */
  const diag = S.aabbOfBox({ x: 0, y: 0, w: 100, h: 100 }, 45);
  assert.equal(round(diag.w, 3), round(100 * Math.SQRT2, 3));
  assert.equal(round(diag.h, 3), round(100 * Math.SQRT2, 3));
  assert.equal(round(diag.x + diag.w / 2), 50);
  assert.equal(round(diag.y + diag.h / 2), 50);
});

test('U11 measureGapRuns（chain）：一排四段间距 24 才算等距', () => {
  /* A B C D 一排，间距 24（被拖的是 A） */
  const targets = [
    { at: 'b', x: 220, y: 0, w: 100, h: 100 },
    { at: 'c', x: 344, y: 0, w: 100, h: 100 },
    { at: 'd', x: 468, y: 0, w: 100, h: 100 }
  ];
  const rect = { x: 100, y: 0, w: 96, h: 100 }; /* A: 100..196，到 b 是 24 */
  const runs = S.measureGapRuns({ rect, targets, axes: 'x' });
  assert.equal(runs.length, 1, `应恰好一条 run：${JSON.stringify(runs)}`);
  assert.equal(runs[0].kind, 'chain');
  assert.equal(runs[0].side, 'right');
  assert.equal(runs[0].gap, 24);
  assert.equal(runs[0].count, 3, '3 段间距');
  assert.deepEqual(runs[0].partners, ['b', 'c', 'd']);

  /* 只有两个邻居（一段间距）→ 不是分布 */
  const short = S.measureGapRuns({ rect, targets: targets.slice(0, 2), axes: 'x' });
  assert.equal(short.length, 0, `一段间距不算等距分布：${JSON.stringify(short)}`);

  /* 不等距 → 不显示 */
  const uneven = S.measureGapRuns({
    rect,
    targets: [
      { at: 'b', x: 220, y: 0, w: 100, h: 100 },
      { at: 'c', x: 380, y: 0, w: 100, h: 100 }, /* 间距 60 */
      { at: 'd', x: 540, y: 0, w: 100, h: 100 }
    ],
    axes: 'x'
  });
  assert.equal(uneven.length, 0);
});

test('U12 measureGapRuns：同侧多个邻居等距**不报**（fan 是噪声，S42 撤掉）', () => {
  /* 左边三个对象上下叠着、x 都是 100（右缘 196），离被拖对象都是 24。
     这在几何上确实「离你一样远」，但画面里到处是一排一排的片段，拖任何一个都会命中——
     实测拖 d-a 上下动 12px，y 轴立刻冒出 `= 48px =`（另一排四个片段同距离）。
     所以只保留「连续段都相等」的链式（U11）。 */
  const rect = { x: 220, y: 0, w: 100, h: 60 };
  const column = [
    { at: 'a', x: 100, y: 0, w: 96, h: 60 },
    { at: 'b', x: 100, y: 80, w: 96, h: 60 },
    { at: 'c', x: 100, y: 160, w: 96, h: 60 }
  ];
  assert.deepEqual(S.measureGapRuns({ rect, targets: column, axes: 'x' }), []);

  /* 而「一排等距」仍然要报（否则这个功能就白做了） */
  const row = [
    { at: 'b', x: 220, y: 0, w: 96, h: 60 },
    { at: 'c', x: 340, y: 0, w: 96, h: 60 },
    { at: 'd', x: 460, y: 0, w: 96, h: 60 }
  ];
  const runs = S.measureGapRuns({ rect: { x: 100, y: 0, w: 96, h: 60 }, targets: row, axes: 'x' });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].gap, 24);
  assert.equal(runs[0].count, 3);

  /* 容差 1px：24 / 24.5 / 25 仍在同一组（差 1.0） */
  const loose = S.measureGapRuns({
    rect: { x: 100, y: 0, w: 96, h: 60 },
    targets: [
      { at: 'b', x: 220, y: 0, w: 96, h: 60 },
      { at: 'c', x: 340.5, y: 0, w: 96, h: 60 },
      { at: 'd', x: 461, y: 0, w: 96, h: 60 }
    ],
    axes: 'x'
  });
  assert.equal(loose.length, 1, `容差 1px 内应归为一组：${JSON.stringify(loose)}`);
});

test('U13 snapEdgesRotated：45° 的补偿 = AABB 偏差 ÷ cos45°', () => {
  /* 200×100 @45°，AABB 宽 = (200+100)/√2 ≈ 212.132，右缘 ≈ x+… */
  const box = { x: 100, y: 100, w: 200, h: 100 };
  const aabb = S.aabbOfBox(box, 45);
  /* 造一个目标：让它左缘距 AABB 右缘 5px（在 6 阈值内） */
  const target = { at: 't', x: aabb.x + aabb.w + 5, y: aabb.y, w: 50, h: 50 };
  const out = S.snapEdgesRotated({
    box,
    handle: 'e',
    rotationDeg: 45,
    targets: [target],
    stage: null,
    threshold: 6
  });
  const cos45 = Math.cos(Math.PI / 4);
  assert.ok(Math.abs(out.projection.x - cos45) < 1e-9, `投影应为 cos45：${out.projection.x}`);
  /* 返回的 dw 是 round3 的（与模块其它尺寸量同口径）→ 1e-3 容差 */
  assert.ok(Math.abs(out.dw - 5 / cos45) < 1e-3, `Δw 应为 5/cos45：${out.dw}`);
  assert.equal(out.guides.length, 1);
  /* 吸完之后 AABB 的右缘正好落在目标左缘上（用返回值里的 snappedAabb，它按「锚点不动」算） */
  const right = out.snappedAabb.x + out.snappedAabb.w;
  assert.ok(Math.abs(right - target.x) < 1e-3, `吸后右缘 ${right}，目标 ${target.x}`);

  /* 对侧锚点（西边中点）在 stage 坐标里一点没动 */
  const anchorOf = (b) => {
    const r = (45 * Math.PI) / 180;
    return {
      x: b.x + b.w / 2 + (-b.w / 2) * Math.cos(r) - (-b.h / 2) * Math.sin(r),
      y: b.y + b.h / 2 + (-b.w / 2) * Math.sin(r) + (-b.h / 2) * Math.cos(r)
    };
  };
  const before = anchorOf(box);
  const after = anchorOf({ ...box, ...S.anchoredResize(box, 'e', 45, out.dw, 0) });
  assert.ok(Math.abs(after.x - before.x) < 1e-6 && Math.abs(after.y - before.y) < 1e-6, `锚点漂了：${JSON.stringify({ before, after })}`);
});

test('U14 snapEdgesRotated：接近 90° 时不假装吸（skipped + 无参考线）', () => {
  const box = { x: 100, y: 100, w: 200, h: 100 };
  const aabb = S.aabbOfBox(box, 78);
  const target = { at: 't', x: aabb.x + aabb.w + 4, y: aabb.y, w: 40, h: 40 };
  const out = S.snapEdgesRotated({ box, handle: 'e', rotationDeg: 78, targets: [target], stage: null, threshold: 6 });
  assert.deepEqual(out.skipped, ['x'], `78° 时 |cos|=0.208 < 0.5，应跳过 x：${JSON.stringify(out.skipped)}`);
  assert.equal(out.dw, 0);
  assert.equal(out.guides.length, 0, '跳过的轴不能给参考线（画了却没吸 = 骗人）');
});

test('U15 snapEdgesRotated：r=0 与 snapEdges 完全一致（老路径回放）', () => {
  const box = { x: 100, y: 100, w: 200, h: 100 };
  const target = { at: 't', x: 303, y: 100, w: 100, h: 100 }; /* 右缘 300 → 303，差 3 */
  const plain = S.snapEdges({ rect: box, handle: 'e', targets: [target], stage: null, threshold: 6 });
  const rotated = S.snapEdgesRotated({ box, handle: 'e', rotationDeg: 0, targets: [target], stage: null, threshold: 6 });
  assert.equal(plain.dx, 3);
  assert.equal(rotated.dw, plain.dx);
  assert.equal(rotated.dh, plain.dy);
  assert.deepEqual(rotated.guides, plain.guides);
});
