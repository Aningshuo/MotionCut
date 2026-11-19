// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S4 验收 A1–A10（WP13 画布工具 + 画幅适配）
 *
 * 运行：node --test --test-concurrency=1 packages/layers/stage.test.mjs
 * A2/A3/A9 在真实浏览器（Playwright Chromium）里跑；其余是纯函数 + 实测耗时。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { SceneHost, REPO_ROOT } from '../scene-runtime/host.mjs';
import { resolveLayerTestEnv } from './test-env.mjs';
import { judgeAgainstBaseline, summarize } from './perf-budget.mjs';
import { registerCleanupProbe } from './test-inject.mjs';

const FIT = await import(new URL('../studio/ui/src/lib/stage-fit.ts', import.meta.url).href);
const GESTURE = await import(new URL('../studio/ui/src/lib/stage-gesture.ts', import.meta.url).href);
// 吸附的**产品实现**在 layers/snap.mjs（M35 之后 stage-gesture.ts 里那份 snapMove 已删）：
// 这里改测产品入口，别再测死代码。
const SNAP = await import(new URL('./snap.mjs', import.meta.url).href);
const MEASURE = await import(new URL('../studio/ui/src/lib/stage-measure.ts', import.meta.url).href);
const INSPECTOR = await import(new URL('./inspector.ts', import.meta.url).href);
const RENDER = await import(new URL('../studio/ui/src/components/inspector/render.ts', import.meta.url).href);

const SCENE = 'tests/fixtures/scenes/stage-fit.html';
const TEST_ENV = await resolveLayerTestEnv({ suite: 'stage' });
/* 端口不写死（S48/S49）：test-env 用 listen(0) 分配的端口；`FILM_STAGE_PORT` 仍可覆盖 */
const PORT = Number(process.env.FILM_STAGE_PORT || TEST_ENV.env.sceneOrigin || 0);
const EVIDENCE_DIR = TEST_ENV.evidenceDir;
const evidence = { batch: 'B-SUB1-R2-002', suite: 'stage.test.mjs', cases: {} };

let host;

async function save() {
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(path.join(EVIDENCE_DIR, 'stage.json'), JSON.stringify(evidence, null, 2) + '\n');
}

before(async () => {
  host = await new SceneHost({ port: PORT, viewport: { width: 540, height: 960 } }).start();
  evidence.host = { port: host.http.port, browserVersion: host.browserVersion };
});
after(async () => {
  evidence.finishedAt = new Date().toISOString();
  await save();
  if (host) await host.stop();
});

const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('S4-A1 stage-fit：contain/cover 画面框与手工计算一致（数值表）', async () => {
  const cases = [
    { name: '16:9 → 9:16 contain', stage: { w: 1920, h: 1080 }, container: { w: 540, h: 960 }, fit: 'contain', want: { x: 0, y: 328.125, w: 540, h: 303.75, scale: 0.28125 } },
    { name: '16:9 → 9:16 cover', stage: { w: 1920, h: 1080 }, container: { w: 540, h: 960 }, fit: 'cover', want: { x: -583.333333, y: 0, w: 1706.666667, h: 960, scale: 0.8888889 } },
    { name: '9:16 → 9:16 contain', stage: { w: 1080, h: 1920 }, container: { w: 540, h: 960 }, fit: 'contain', want: { x: 0, y: 0, w: 540, h: 960, scale: 0.5 } },
    { name: '9:16 → 9:16 cover', stage: { w: 1080, h: 1920 }, container: { w: 540, h: 960 }, fit: 'cover', want: { x: 0, y: 0, w: 540, h: 960, scale: 0.5 } },
    { name: '1:1 → 3:2 contain', stage: { w: 1000, h: 1000 }, container: { w: 300, h: 200 }, fit: 'contain', want: { x: 50, y: 0, w: 200, h: 200, scale: 0.2 } },
    { name: '1:1 → 3:2 cover', stage: { w: 1000, h: 1000 }, container: { w: 300, h: 200 }, fit: 'cover', want: { x: 0, y: -50, w: 300, h: 300, scale: 0.3 } },
    { name: '16:9 → 16:9 contain', stage: { w: 1920, h: 1080 }, container: { w: 960, h: 540 }, fit: 'contain', want: { x: 0, y: 0, w: 960, h: 540, scale: 0.5 } }
  ];
  const table = [];
  for (const c of cases) {
    const f = FIT.pictureFrame(c.stage, c.container, c.fit);
    assert.ok(close(f.x, c.want.x, 0.001) && close(f.y, c.want.y, 0.001), `${c.name} x/y=${f.x},${f.y}`);
    assert.ok(close(f.w, c.want.w, 0.001) && close(f.h, c.want.h, 0.001), `${c.name} w/h=${f.w},${f.h}`);
    assert.ok(close(f.scale, c.want.scale, 1e-6), `${c.name} scale=${f.scale}`);
    const lb = FIT.letterbox(f);
    table.push({
      name: c.name,
      fit: c.fit,
      frame: { x: round(f.x), y: round(f.y), w: round(f.w), h: round(f.h), scale: round(f.scale, 6) },
      letterbox: { top: round(lb.top), right: round(lb.right), bottom: round(lb.bottom), left: round(lb.left) }
    });
  }
  evidence.cases['S4-A1'] = { status: 'PASS', table };
  await save();
});

test('S4-A4 吸附：阈值内吸附到边/中心，阈值外不吸附，结果可复现', async () => {
  const stage = { w: 600, h: 400 };
  const box = { x: 100, y: 100, w: 100, h: 50 };

  // 产品入口：layers/snap.mjs 的 snapRect（默认阈值 6 屏幕 px）。
  const nearEdge = SNAP.snapRect({ rect: box, targets: [{ x: 204, y: 0, w: 50, h: 20 }], stage });
  assert.equal(nearEdge.dx, 4, `右边缘 200→204 应吸 4px，实际 ${nearEdge.dx}`);
  assert.equal(nearEdge.guideDetails.find((g) => g.axis === 'x').kind, 'edge');

  // 9px > 阈值 6：不吸
  const farEdge = SNAP.snapRect({ rect: box, targets: [{ x: 209, y: 0, w: 50, h: 20 }], stage });
  assert.equal(farEdge.dx, 0, '阈值外仍吸附');
  assert.equal(farEdge.guides.filter((g) => g.axis === 'x').length, 0);

  const nearCenter = SNAP.snapRect({ rect: { x: 251, y: 100, w: 100, h: 50 }, stage });
  assert.equal(nearCenter.dx, -1, '中心 301→300 应吸 -1px');
  assert.equal(nearCenter.guideDetails.find((g) => g.axis === 'x').kind, 'center');

  const stageEdge = SNAP.snapRect({ rect: { x: 5, y: 100, w: 100, h: 50 }, stage });
  assert.equal(stageEdge.dx, -5, '舞台左边缘应吸附');
  assert.equal(stageEdge.guideDetails.find((g) => g.axis === 'x').source, 'stage');

  const runOnce = () =>
    JSON.stringify(SNAP.snapRect({ rect: { x: 101, y: 103, w: 100, h: 50 }, targets: [{ x: 205, y: 155, w: 40, h: 40 }], stage }));
  const first = runOnce();
  for (let i = 0; i < 50; i += 1) {
    assert.equal(runOnce(), first, '吸附结果不可复现');
  }

  // enabled:false（Alt 按住）：一条都不吸，连网格也不吸
  const off = SNAP.snapRect({ rect: box, targets: [{ x: 204, y: 0, w: 50, h: 20 }], stage, enabled: false });
  assert.equal(off.dx, 0);
  assert.equal(off.guideDetails.length, 0);

  const align = GESTURE.alignShift('left', { x: 120, y: 10, w: 50, h: 20 }, { x: 100, y: 0, w: 200, h: 100 });
  assert.equal(align.dx, -20, '左对齐位移');

  evidence.cases['S4-A4'] = {
    status: 'PASS',
    entry: 'packages/layers/snap.mjs · snapRect（M35 起产品唯一实现）',
    threshold: SNAP.SNAP_THRESHOLD_PX,
    previousThreshold: 8,
    nearEdge: { dx: nearEdge.dx, guides: nearEdge.guideDetails },
    farEdge: { dx: farEdge.dx, guides: farEdge.guides },
    nearCenter: { dx: nearCenter.dx, guides: nearCenter.guideDetails },
    stageEdge: { dx: stageEdge.dx, guides: stageEdge.guideDetails },
    altDisabled: { dx: off.dx, guides: off.guideDetails },
    deterministic: 50,
    alignShift: align
  };
  await save();
});

test('S4-A5 框选：完全包含 vs 相交两种策略都有明确结果', async () => {
  const layers = [
    { id: 'inside', x: 10, y: 10, w: 20, h: 20 },
    { id: 'cross', x: 50, y: 50, w: 100, h: 100 },
    { id: 'outside', x: 200, y: 200, w: 10, h: 10 }
  ];
  const rect = { x: 0, y: 0, w: 100, h: 100 };
  const contain = GESTURE.marqueeSelect(layers, rect, 'contain');
  const intersect = GESTURE.marqueeSelect(layers, rect, 'intersect');
  assert.deepEqual(contain, [0], `contain=${contain}`);
  assert.deepEqual(intersect, [0, 1], `intersect=${intersect}`);

  evidence.cases['S4-A5'] = { status: 'PASS', contain, intersect };
  await save();
});

test('S4-A6 测距：两层间距与实际框差一致（±0.5px）', async () => {
  const a = { x: 10, y: 10, w: 100.2, h: 50 };
  const b = { x: 150.7, y: 10, w: 80, h: 50 };
  const gap = MEASURE.measuredGap(a, b);
  assert.ok(Math.abs(gap.dx - 40.5) <= 0.5, `水平净空=${gap.dx}`);
  const lines = MEASURE.measuredLines(MEASURE.measureGaps(a, b));
  assert.equal(lines.length, 1, `实测线=${JSON.stringify(lines)}`);
  assert.ok(Math.abs(lines[0].length - 40.5) <= 0.5, `线长=${lines[0].length}`);

  const c = { x: 10, y: 10, w: 60, h: 20 };
  const d = { x: 10, y: 55.4, w: 60, h: 20 };
  const v = MEASURE.measuredGap(c, d);
  assert.ok(Math.abs(v.dy - 25.4) <= 0.5, `垂直净空=${v.dy}`);
  assert.ok(Math.abs(GESTURE.boxGap(c, d).distance - 25.4) <= 0.5, 'gesture.boxGap 与 measure 不一致');

  evidence.cases['S4-A6'] = {
    status: 'PASS',
    horizontal: { dx: round(gap.dx), line: round(lines[0].length) },
    vertical: { dy: round(v.dy), distance: round(GESTURE.boxGap(c, d).distance) }
  };
  await save();
});

test('S4-A7 Alt 穿透命中下层；Shift 加选不丢已选', async () => {
  const layers = [
    { id: 'bottom', x: 0, y: 0, w: 100, h: 100 },
    { id: 'top', x: 50, y: 50, w: 100, h: 100 },
    { id: 'other', x: 300, y: 300, w: 50, h: 50 }
  ];
  const p = { x: 75, y: 75 };
  assert.deepEqual(GESTURE.hitAll(layers, p), [0, 1]);
  assert.equal(GESTURE.hitTest(layers, p), 1, '常规应命中上层');
  assert.equal(GESTURE.hitTest(layers, p, { deep: true }), 0, 'Alt 应命中下层');

  const sel = GESTURE.resolveSelection([2], 1, { shift: true });
  assert.deepEqual(sel, [2, 1], `Shift 加选丢了已选：${sel}`);
  assert.deepEqual(GESTURE.resolveSelection([2, 1], 1, { shift: true }), [2], 'Shift 再点已选应取消');
  assert.deepEqual(GESTURE.resolveSelection([2], 1), [1], '无 Shift 应单选');

  evidence.cases['S4-A7'] = { status: 'PASS', hitAll: [0, 1], normal: 1, deep: 0, shiftAdd: sel };
  await save();
});

test('S4-A8 旋转层命中用多边形：45° 时 AABB 内但真实框外的点不命中', async () => {
  const box = { id: 'rot', x: 80, y: 80, w: 40, h: 40, rotation: 45 };
  const aabb = GESTURE.outerAABB(box);
  const outsideButInAABB = { x: 72, y: 72 };
  assert.ok(GESTURE.rectContainsPoint(aabb, outsideButInAABB), '该点应在外接框内（否则用例无意义）');
  assert.equal(GESTURE.pointInBox(box, outsideButInAABB), false, 'AABB 内角点被误判命中');
  assert.equal(GESTURE.hitTest([box], outsideButInAABB), -1);

  const rotatedCorner = { x: 100, y: 100 - 20 * Math.SQRT2 };
  assert.ok(GESTURE.pointInBox(box, rotatedCorner), '旋转后的角点应命中');
  assert.equal(GESTURE.hitTest([box], rotatedCorner), 0);
  assert.equal(GESTURE.hitTest([box], { x: 100, y: 100 }), 0);

  evidence.cases['S4-A8'] = {
    status: 'PASS',
    aabb: { x: round(aabb.x, 2), y: round(aabb.y, 2), w: round(aabb.w, 2), h: round(aabb.h, 2) },
    aabbPointHit: false,
    rotatedCorner: { x: round(rotatedCorner.x, 2), y: round(rotatedCorner.y, 2) },
    polygonHit: true
  };
  await save();
});

test('S4-A10 性能：1000 层夹具，命中/框选 p95 对 100 层基线', async () => {
  /* S49（B-SUB1-R25-025）：判据从「绝对 16ms + 单次 max」换成
     「p95 对同进程 100 层基线 ×4，且不低于 16ms」。三条理由：
     1. 单次 max 吃不下一条 GC/调度毛刺（R28 实测 17.727ms 的那次，p95 只有 1.18ms）；
     2. 1000 层是 100 层的 10 倍数量，**线性**实现应 ≤10 倍，但实测是次线性；
        ×4 是「退化成平方」的警戒线 —— 平方会是 ×100，×4 已经在替复杂度报警；
     3. 机器忙的时候基线与实测一起涨，绝对阈值不动就必红。 */
  let seed = 1234567;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const layers = [];
  for (let i = 0; i < 1000; i += 1) {
    layers.push({ id: `L${i}`, x: rnd() * 1800, y: rnd() * 1000, w: 10 + rnd() * 90, h: 10 + rnd() * 90, rotation: i % 7 === 0 ? rnd() * 90 : 0 });
  }
  const points = Array.from({ length: 200 }, () => ({ x: rnd() * 1900, y: rnd() * 1080 }));
  const rects = Array.from({ length: 80 }, () => ({ x: rnd() * 1500, y: rnd() * 800, w: 100 + rnd() * 400, h: 100 + rnd() * 300 }));
  const small = layers.slice(0, 100);

  /** 同一组点/框，在两个层集上各跑一遍；返回原始采样（p95 由 perf-budget 统一算）。 */
  const sample = (layerSet) => {
    for (let i = 0; i < 50; i += 1) {
      GESTURE.hitTest(layerSet, points[i % points.length]);
      GESTURE.marqueeSelect(layerSet, rects[i % rects.length], i % 2 ? 'contain' : 'intersect');
    }
    const hitTimes = [];
    for (let i = 0; i < points.length; i += 1) {
      const t0 = performance.now();
      GESTURE.hitTest(layerSet, points[i]);
      hitTimes.push(performance.now() - t0);
    }
    const marqueeTimes = [];
    for (let i = 0; i < rects.length; i += 1) {
      const t0 = performance.now();
      GESTURE.marqueeSelect(layerSet, rects[i], i % 2 ? 'contain' : 'intersect');
      marqueeTimes.push(performance.now() - t0);
    }
    return { hitTimes, marqueeTimes };
  };

  const base = sample(small);
  const big = sample(layers);
  const baseHit = summarize(base.hitTimes);
  const baseMarquee = summarize(base.marqueeTimes);
  const hit = summarize(big.hitTimes);
  const marquee = summarize(big.marqueeTimes);

  /* 判据：p95_1000 ≤ max(16, p95_100 × 4)。max 只记账，不进判据。 */
  const hitJudge = judgeAgainstBaseline({ measuredP95: hit.p95, baselineP95: baseHit.p95, floor: 16, factor: 4, slack: 0 });
  const marqueeJudge = judgeAgainstBaseline({ measuredP95: marquee.p95, baselineP95: baseMarquee.p95, floor: 16, factor: 4, slack: 0 });

  assert.ok(big.hitTimes.length >= 200, '命中至少 200 次采样');
  assert.ok(big.marqueeTimes.length >= 40, '框选至少 40 次采样（p95 的最小样本量）');
  assert.ok(hitJudge.pass, `命中 p95 应 ≤${hitJudge.budget}ms（100 层基线 ${hitJudge.baselineP95}ms）：实测 ${hitJudge.measuredP95}ms，${hitJudge.formula}`);
  assert.ok(marqueeJudge.pass, `框选 p95 应 ≤${marqueeJudge.budget}ms（100 层基线 ${marqueeJudge.baselineP95}ms）：实测 ${marqueeJudge.measuredP95}ms，${marqueeJudge.formula}`);

  /* 注入对照：把单次调用拖到**判据的 3 倍**，同一条量测路径必须报红（证明判据没被削弱）。
     3 × 实测（0.04ms）在 16ms 预算内本来就该绿 —— 忙等 3 × 判据才有意义。 */
  const injectMs = Math.round(3 * Math.max(hitJudge.budget, marqueeJudge.budget) * 1000) / 1000;
  const busy = (ms) => {
    const end = performance.now() + ms;
    let sink = 0;
    while (performance.now() < end) sink += Math.sqrt(sink + 1);
    return sink;
  };
  const injected = [];
  for (let i = 0; i < 40; i += 1) {
    const t0 = performance.now();
    busy(injectMs);
    GESTURE.hitTest(layers, points[i]);
    injected.push(performance.now() - t0);
  }
  const injectedStats = summarize(injected);
  const injectedJudge = judgeAgainstBaseline({ measuredP95: injectedStats.p95, baselineP95: baseHit.p95, floor: 16, factor: 4, slack: 0 });
  assert.equal(injectedJudge.pass, false, `注入 ${injectMs}ms/次后判据必须红：${injectedJudge.formula}`);
  process.stdout.write(
    `INJECT ${JSON.stringify({ measured: injectedJudge.measuredP95, baseline: injectedJudge.baselineP95, budget: injectedJudge.budget, factor: injectedJudge.factor, perCallMs: injectMs })}\n`
  );

  evidence.cases['S4-A10'] = {
    status: 'PASS',
    load: process.env.OPENCUT_PERF_LOAD ?? 'idle',
    layers: 1000,
    baselineLayers: 100,
    samples: { hit: big.hitTimes.length, marquee: big.marqueeTimes.length, baselineHit: base.hitTimes.length, baselineMarquee: base.marqueeTimes.length },
    hit: { ...hit, baseline: baseHit, judge: hitJudge },
    marquee: { ...marquee, baseline: baseMarquee, judge: marqueeJudge },
    injection: { perCallMs: injectMs, stats: injectedStats, judge: injectedJudge, expected: 'fail' }
  };
  await save();
});

test('S4-A2 16:9 进 9:16 contain：点黑边不选中，点画面内命中正确层（真实 DOM 对照）', async () => {
  const h = await host.open(SCENE);
  try {
    const dom = await h.page.evaluate(() => {
      const pic = document.querySelector('#picture').getBoundingClientRect();
      return { x: pic.x, y: pic.y, w: pic.width, h: pic.height };
    });
    const frame = FIT.pictureFrame({ w: 1920, h: 1080 }, { w: 540, h: 960 }, 'contain');
    assert.ok(Math.abs(dom.x - frame.x) <= 1 && Math.abs(dom.y - frame.y) <= 1, `DOM 画面框与计算不一致：${JSON.stringify(dom)} vs ${frame.x},${frame.y}`);
    assert.ok(Math.abs(dom.w - frame.w) <= 1 && Math.abs(dom.h - frame.h) <= 1, `DOM 尺寸不一致：${dom.w}x${dom.h}`);

    const layers = [
      { id: 'full', x: 0, y: 0, w: 1920, h: 1080 },
      { id: 'badge', x: 480, y: 270, w: 120, h: 60 }
    ];
    const pick = (p) => (FIT.insidePicture(frame, p) ? GESTURE.hitTest(layers, FIT.clientToStage(frame, p)) : -1);

    const letterboxPoint = { x: 270, y: 100 };
    assert.equal(FIT.insidePicture(frame, letterboxPoint), false, '黑边被当成画面');
    assert.equal(pick(letterboxPoint), -1, '点黑边选中了层');

    const badgeScene = { x: 540, y: 300 };
    const badgeClient = FIT.stageToClient(frame, badgeScene);
    assert.equal(pick(badgeClient), 1, `画面内角标未命中：${JSON.stringify(badgeClient)}`);
    const bgClient = FIT.stageToClient(frame, { x: 960, y: 540 });
    assert.equal(pick(bgClient), 0, '画面内背景未命中整幅层');

    evidence.cases['S4-A2'] = {
      status: 'PASS',
      domFrame: dom,
      computedFrame: { x: frame.x, y: frame.y, w: frame.w, h: frame.h, scale: frame.scale },
      letterbox: { point: letterboxPoint, inside: false, pick: -1 },
      badge: { scene: badgeScene, client: badgeClient, pick: 1 },
      background: { client: bgClient, pick: 0 }
    };
  } finally {
    await h.dispose();
  }
  await save();
});

test('S4-A3 改画幅后覆盖仍贴真实画面框（前后坐标）', async () => {
  const h = await host.open(SCENE);
  try {
    const container = { w: 540, h: 960 };
    const oldStage = { w: 1920, h: 1080 };
    const newStage = { w: 1080, h: 1920 };
    const oldFrame = FIT.pictureFrame(oldStage, container, 'contain');

    // 覆盖记录的是画面内归一化位置 (0.25, 0.25)
    const before = FIT.clientAtFraction(oldFrame, 0.25, 0.25);
    const oldRect = await h.page.evaluate(() => {
      const r = document.querySelector('#badge').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    assert.ok(Math.abs(oldRect.x - before.x) <= 1 && Math.abs(oldRect.y - before.y) <= 1, `改画幅前 DOM 与覆盖不一致：${JSON.stringify(oldRect)} vs ${before.x},${before.y}`);

    // 改画幅：16:9 → 9:16（容器不变）
    await h.page.evaluate(() => {
      document.querySelector('#picture').style.aspectRatio = '9 / 16';
    });
    await h.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    const newRect = await h.page.evaluate(() => {
      const r = document.querySelector('#picture').getBoundingClientRect();
      const b = document.querySelector('#badge').getBoundingClientRect();
      return { picture: { x: r.x, y: r.y, w: r.width, h: r.height }, badge: { x: b.x, y: b.y, w: b.width, h: b.height } };
    });
    const newFrame = FIT.refitStage(oldFrame, newStage);
    assert.ok(Math.abs(newRect.picture.w - newFrame.w) <= 1 && Math.abs(newRect.picture.h - newFrame.h) <= 1, `改画幅后 DOM 与计算不一致：${JSON.stringify(newRect.picture)}`);

    const after = FIT.clientAtFraction(newFrame, 0.25, 0.25);
    const fracOld = FIT.stageFraction(oldFrame, before);
    const fracNew = FIT.stageFraction(newFrame, after);
    assert.ok(close(fracOld.fx, fracNew.fx, 1e-9) && close(fracOld.fy, fracNew.fy, 1e-9), '归一化位置漂移');
    assert.ok(FIT.insidePicture(newFrame, after), '改画幅后覆盖点跑到画面外');
    assert.ok(Math.abs(newRect.badge.x - after.x) <= 1 && Math.abs(newRect.badge.y - after.y) <= 1, `改画幅后 DOM 覆盖未贴画面框：${newRect.badge.y} vs ${after.y}`);

    // 反例：拿容器坐标当场景坐标会偏移多少
    const naiveBefore = { x: container.w * 0.25, y: container.h * 0.25 };
    const naiveOldDrift = { x: naiveBefore.x - before.x, y: naiveBefore.y - before.y };

    evidence.cases['S4-A3'] = {
      status: 'PASS',
      stage: { before: oldStage, after: newStage },
      frame: {
        before: { x: oldFrame.x, y: oldFrame.y, w: oldFrame.w, h: oldFrame.h },
        after: { x: newFrame.x, y: newFrame.y, w: newFrame.w, h: newFrame.h }
      },
      overrideFraction: { fx: 0.25, fy: 0.25 },
      client: { before, after },
      dom: { picture: newRect.picture, badge: newRect.badge },
      naiveContainerMapping: { point: naiveBefore, driftBefore: naiveOldDrift }
    };
  } finally {
    await h.dispose();
  }
  await save();
});

test('S4-A9 框选后检查器显示多选状态（真实 DOM 渲染）', async () => {
  const h = await host.open(SCENE);
  try {
    const layers = [
      { id: 'a', x: 10, y: 10, w: 20, h: 20 },
      { id: 'b', x: 40, y: 40, w: 20, h: 20 },
      { id: 'c', x: 300, y: 300, w: 20, h: 20 }
    ];
    const selected = GESTURE.marqueeSelect(layers, { x: 0, y: 0, w: 100, h: 100 }, 'contain');
    assert.deepEqual(selected, [0, 1]);
    const refs = selected.map((i) => ({ clipId: 'clip-stage', at: `#${layers[i].id}`, kind: 'shape', name: layers[i].id, depth: 1 }));
    const model = INSPECTOR.buildMultiInspector(refs);
    const html = RENDER.renderInspector(model);
    await h.page.setContent(`<!doctype html><html><body><div id="host">${html}</div></body></html>`);

    const dom = await h.page.evaluate(() => {
      const root = document.querySelector('.inspector');
      return {
        mode: root.getAttribute('data-mode'),
        count: root.getAttribute('data-count'),
        editable: root.getAttribute('data-editable'),
        text: root.textContent.replace(/\s+/g, ' ').trim(),
        note: root.querySelector('.inspector-multi').getAttribute('data-note')
      };
    });
    assert.equal(dom.mode, 'multi');
    assert.equal(dom.count, '2');
    assert.equal(dom.editable, 'false');
    assert.match(dom.text, /已选 2 项/);
    assert.match(dom.text, /不支持多选编辑/);

    evidence.cases['S4-A9'] = { status: 'PASS', selected, dom };
  } finally {
    await h.dispose();
  }
  await save();
});

/* S55：只有设了 OPENCUT_TEST_INJECT_FAIL / OPENCUT_TEST_INJECT_HANG 才会多出一个用例，
   用来实测失败与超时路径的清理；默认零影响。 */
registerCleanupProbe('stage');
