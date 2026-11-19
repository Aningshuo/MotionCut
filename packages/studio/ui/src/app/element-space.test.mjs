/**
 * R120 · M6：几何换算单测（`element-space.ts` 是纯函数，四情形在这里算）。
 *
 * 跑：`node --test packages/studio/ui/src/app/element-space.test.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'element-space.ts'), 'utf8');
const js = stripTypeScriptTypes(source);
const mod = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const {
  pageFit,
  composeSpace,
  declaredDelta,
  layoutToStage,
  elementSpaceOf,
  rotationToWrite,
  geometryStylePatch,
  resettableKeys,
} = mod;

const IDENT = { a: 1, b: 0, c: 0, d: 1 };
const chainOk = (linear = IDENT, rotationDeg = 0) => ({ ok: true, ...linear, rotationDeg, nodes: [] });

test('pageFit：16:9 页面铺满 16:9 舞台 = k1 无偏移', () => {
  const fit = pageFit({ size: { w: 1280, h: 720 }, box: { x: 0, y: 0, w: 1280, h: 720 } }, { w: 1280, h: 720 });
  assert.deepEqual(fit, { k: 1, x: 0, y: 0 });
});

test('pageFit：9:16 页面 contain 进 16:9 舞台 → 左右留黑、k = 0.5625', () => {
  /* 页面 1080×1920，舞台 1280×720：k = min(1280/1080, 720/1920) = 0.375；
     画面宽 405、居中 x = (1280−405)/2 = 437.5 */
  const fit = pageFit({ size: { w: 1080, h: 1920 }, box: { x: 0, y: 0, w: 1280, h: 720 } }, { w: 1280, h: 720 });
  assert.equal(fit.k, 0.375);
  assert.equal(fit.x, 437.5);
  assert.equal(fit.y, 0);
});

test('pageFit：clip.box 有偏移/尺寸时按 box 算，不按舞台算', () => {
  const fit = pageFit({ size: { w: 640, h: 360 }, box: { x: 100, y: 40, w: 320, h: 180 } }, { w: 1280, h: 720 });
  assert.deepEqual(fit, { k: 0.5, x: 100, y: 40 });
});

test('composeSpace：页面 fit × 祖先 scale，旋转取祖先累计角', () => {
  const r = composeSpace({ k: 0.5 }, chainOk({ a: 2, b: 0, c: 0, d: 2 }, 30));
  assert.equal(r.ok, true);
  assert.deepEqual(r.linear, { a: 1, b: 0, c: 0, d: 1 });
  assert.equal(r.rotationDeg, 30);
});

test('composeSpace：祖先链不可表达 → 原样拒绝（不许猜）', () => {
  const r = composeSpace({ k: 1 }, { ok: false, code: 'UNSUPPORTED_ANCESTOR_MATRIX', reason: 'matrix3d 含透视', nodes: [] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'UNSUPPORTED_ANCESTOR_MATRIX');
});

test('declaredDelta：舞台缩放 2、页面 fit 0.5、祖先 scale 2 → 屏幕 10px = 声明 10px', () => {
  /* L = 0.5 × 2 = 1；屏幕 10 / stageScale 2 = 舞台 5；→ 声明 5？不：L=1 → 5。
     等等：屏幕 10px ÷ 舞台缩放 2 = 舞台 5px；舞台 ÷ L(1) = 声明 5px。
     所以「屏幕 10 = 声明 5」，也就是 L 有效为 2（舞台→声明）。 */
  const space = composeSpace({ k: 0.5 }, chainOk({ a: 2, b: 0, c: 0, d: 2 }, 0));
  const d = declaredDelta(space, 0, 2, 10, 0);
  assert.deepEqual(d, { x: 5, y: 0 });
});

test('declaredDelta：祖先 rotate 90° → 屏幕向右 = 声明 −y（局部轴朝下是 +x）', () => {
  /* rotate(90deg) 把局部 +x 送到屏幕 +y（向下）。所以屏幕向右 (10,0) 对应局部 (0,−10)。 */
  const space = composeSpace({ k: 1 }, chainOk({ a: 0, b: 1, c: -1, d: 0 }, 90));
  const d = declaredDelta(space, 0, 1, 10, 0);
  assert.equal(d.x, 0);
  assert.equal(d.y, -10);
});

test('declaredDelta：元素自身 rotate 90° 时手柄位移投影回局部轴', () => {
  /* 元素自己转了 90°：屏幕向下 = 元素局部 +x。 */
  const space = composeSpace({ k: 1 }, chainOk(IDENT, 0));
  const down = declaredDelta(space, 90, 1, 0, 10);
  assert.equal(down.x, 10);
  assert.equal(Math.round(down.y), 0);
});

test('layoutToStage：声明页框 → 舞台局部（含 letterbox 偏移）', () => {
  const stage = layoutToStage({ k: 0.5, x: 100, y: 40 }, { x: 200, y: 100, w: 400, h: 200 });
  assert.deepEqual(stage, { x: 200, y: 90, w: 200, h: 100 });
});

test('elementSpaceOf：一次拿到 fit/linear/rotation（手柄与量具共用）', () => {
  const r = elementSpaceOf({ size: { w: 1000, h: 1000 }, box: { x: 0, y: 0, w: 500, h: 500 } }, { w: 500, h: 500 }, chainOk());
  assert.equal(r.ok, true);
  assert.equal(r.fit.k, 0.5);
  assert.deepEqual(r.linear, { a: 0.5, b: 0, c: 0, d: 0.5 });
});

test('rotationToWrite：总角度去掉作者 transform 的角度，并归一到 (−180,180]', () => {
  assert.equal(rotationToWrite(30, 10), 20);
  assert.equal(rotationToWrite(200, 0), -160);
  assert.equal(rotationToWrite(0, 0), 0);
});

test('geometryStylePatch/x：写偏移（目标 − 实测 + 当前 left），静态补 relative', () => {
  const r = geometryStylePatch({
    field: 'x',
    target: 200,
    layout: { x: 92, y: 0, w: 100, h: 40 },
    computed: { left: '0px', top: '0px' },
    block: { position: 'static', isFlexItem: false, isGridItem: false, widthFrom: 'auto', heightFrom: 'auto' },
  });
  assert.deepEqual(r.style, { left: '108px', position: 'relative' });
  assert.equal(r.notes.length, 1);
  assert.deepEqual(r.fixed, ['position: relative']);
});

test('geometryStylePatch/y：relative 元素沿用当前 computed left 偏移', () => {
  const r = geometryStylePatch({
    field: 'y',
    target: 300,
    layout: { x: 0, y: 120, w: 10, h: 10 },
    computed: { top: '20px' },
    block: { position: 'relative', isFlexItem: false, isGridItem: false, widthFrom: 'px', heightFrom: 'px' },
  });
  assert.deepEqual(r.style, { top: '200px' });
});

test('geometryStylePatch/w：按差值折算并固定 flex 子项', () => {
  const r = geometryStylePatch({
    field: 'w',
    target: 300,
    layout: { x: 0, y: 0, w: 200, h: 50 },
    computed: { width: '180px' },
    block: { position: 'static', isFlexItem: true, isGridItem: false, widthFrom: 'percent', heightFrom: 'px' },
  });
  assert.deepEqual(r.style, { width: '280px', flex: '0 0 auto' });
  /* 两条说明：百分比→px 固定化 + flex 子项补 flex。 */
  assert.equal(r.notes.length, 2);
  assert.deepEqual(r.fixed, ['width', 'flex']);
});

test('geometryStylePatch：NaN / Infinity / 极大值一律拒写', () => {
  /** @param {number} target */
  const bad = (target) =>
    geometryStylePatch({
      field: 'x',
      target,
      layout: { x: 0, y: 0, w: 10, h: 10 },
      computed: {},
      block: null,
    });
  assert.equal(bad(Number.NaN).error.code, 'INVALID_VALUE');
  assert.equal(bad(Number.POSITIVE_INFINITY).error.code, 'INVALID_VALUE');
  assert.equal(bad(1e9).error.code, 'INVALID_VALUE');
});

test('geometryStylePatch：宽高小于 1 拒写', () => {
  const r = geometryStylePatch({
    field: 'h',
    target: 0.2,
    layout: { x: 0, y: 0, w: 10, h: 100 },
    computed: { height: '100px' },
    block: null,
  });
  assert.equal(r.error.code, 'INVALID_VALUE');
});

test('geometryStylePatch/rotate：只写 rotate 属性，不动 transform', () => {
  const r = geometryStylePatch({
    field: 'rotate',
    target: 45,
    layout: { x: 0, y: 0, w: 10, h: 10 },
    computed: {},
    block: null,
    authorRotation: 10,
  });
  assert.deepEqual(r.style, { rotate: '35deg' });
});

test('resettableKeys：只删覆盖里真有的几何键；作者写过的 position/flex 不删', () => {
  assert.deepEqual(
    resettableKeys({ overrideStyle: { left: '1px', color: 'red', width: '2px' }, inline: { position: 'relative' } }),
    ['left', 'width'],
  );
  assert.deepEqual(
    resettableKeys({ overrideStyle: { position: 'relative', flex: '0 0 auto', top: '1px' }, inline: {} }),
    ['top', 'position', 'flex'],
  );
});
