// @ts-nocheck —— 验收脚本以 node --test 的断言为准；产品模块仍由 tsc 严格检查。
/**
 * S37-SCENE-EDIT 纯函数验收（B-SUB1-R19-019）
 *
 * 这里只测**不碰 DOM** 的部分：片段判定、最小尺寸分档、可见量钳制、多选刚性钳制。
 * 框/手柄/HUD/落盘的整链在 `scripts/s37-scene-edit.mjs`（真 Studio + 真 /ops）里跑。
 *
 * 运行：node --test packages/layers/scene-edit.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const G = await import(new URL('./canvas-gesture.mjs', import.meta.url).href);

const STAGE = { w: 1280, h: 720 };
const round = (n, d = 3) => Math.round(Number(n) * 10 ** d) / 10 ** d;

test('S37-U1 片段判定：clip === at 且非空才算片段', () => {
  const rows = [
    { name: '片段（App.tsx 的形状）', layer: { at: 'scene-a', clip: 'scene-a' }, want: true },
    { name: '场景内图层（at 是 CSS 路径）', layer: { at: '#panel > div:nth-of-type(2)', clip: 'scene-a' }, want: false },
    { name: '没有 clip 字段', layer: { at: '#card-a' }, want: false },
    { name: '空 clip', layer: { at: '', clip: '' }, want: false },
    { name: '两个都空', layer: {}, want: false },
  ];
  for (const row of rows) {
    assert.equal(G.isClipLayer(row.layer), row.want, `${row.name} 判定错`);
  }
});

test('S37-U2 最小尺寸分档：片段 16、图层 8、宿主给了就听宿主的', () => {
  const clip = { at: 'scene-a', clip: 'scene-a' };
  const layer = { at: '#panel', clip: 'scene-a' };
  assert.equal(G.GESTURE_MIN_CLIP_SIZE, 16);
  assert.equal(G.GESTURE_MIN_SIZE, 8);
  assert.equal(G.GESTURE_MIN_VISIBLE, 32);
  assert.equal(G.minSizeOf(clip), 16);
  assert.equal(G.minSizeOf(layer), 8);
  assert.equal(G.minSizeOf(clip, 24), 24);
  assert.equal(G.minSizeOf(layer, 24), 24);
  /* 非法宿主值按「没给」处理，不静默变成 0 */
  assert.equal(G.minSizeOf(clip, 0), 16);
  assert.equal(G.minSizeOf(clip, Number.NaN), 16);
});

test('S37-U3 dragBox 用 16 的片段下限：怎么缩都到不了 16 以下', () => {
  const box = { x: 100, y: 100, w: 200, h: 200 };
  /* 往左上猛拉 se 手柄：不给下限会得到负宽高 */
  const tiny = G.dragBox({
    mode: 'resize',
    handle: 'se',
    box,
    dx: -400,
    dy: -400,
    minSize: G.minSizeOf({ at: 'scene-a', clip: 'scene-a' }),
    stageSize: STAGE,
  });
  assert.deepEqual([tiny.w, tiny.h], [16, 16], `最小尺寸应夹到 16×16：${JSON.stringify(tiny)}`);
  /* 同样的手势给图层下限 8 → 8×8 */
  const tinyLayer = G.dragBox({
    mode: 'resize',
    handle: 'se',
    box,
    dx: -400,
    dy: -400,
    minSize: G.minSizeOf({ at: '#panel', clip: 'scene-a' }),
    stageSize: STAGE,
  });
  assert.deepEqual([tinyLayer.w, tinyLayer.h], [8, 8]);
});

test('S37-U4 clampVisible：四条边都留 32px 可见，且不改宽高', () => {
  const box = { x: 100, y: 100, w: 560, h: 315 };
  const cases = [
    { name: '左出界', input: { ...box, x: -2000 }, want: { x: 32 - 560, y: 100 }, axis: 'x' },
    { name: '右出界', input: { ...box, x: 5000 }, want: { x: 1280 - 32, y: 100 }, axis: 'x' },
    { name: '上出界', input: { ...box, y: -3000 }, want: { x: 100, y: 32 - 315 }, axis: 'y' },
    { name: '下出界', input: { ...box, y: 3000 }, want: { x: 100, y: 720 - 32 }, axis: 'y' },
    { name: '两极同时出界（右下）', input: { x: 9999, y: 9999, w: 560, h: 315 }, want: { x: 1280 - 32, y: 720 - 32 }, axis: 'xy' },
  ];
  const table = [];
  for (const c of cases) {
    const got = G.clampVisible(c.input, STAGE);
    assert.equal(got.box.x, c.want.x, `${c.name} x=${got.box.x} 应为 ${c.want.x}`);
    assert.equal(got.box.y, c.want.y, `${c.name} y=${got.box.y} 应为 ${c.want.y}`);
    assert.equal(got.box.w, c.input.w, `${c.name} 不许改宽`);
    assert.equal(got.box.h, c.input.h, `${c.name} 不许改高`);
    const axis = `${got.clampedX ? 'x' : ''}${got.clampedY ? 'y' : ''}`;
    assert.equal(axis, c.axis, `${c.name} clampAxis=${axis} 应为 ${c.axis}`);
    table.push({ case: c.name, box: got.box, clamped: axis });
  }
  /* 没出界：一个像素都不动，也不算夹 */
  const inside = G.clampVisible(box, STAGE);
  assert.deepEqual(inside.box, box);
  assert.equal(inside.clampedX || inside.clampedY, false);
  /* 没有舞台：原样返回（不猜尺寸） */
  const noStage = G.clampVisible({ ...box, x: -9999 }, null);
  assert.equal(noStage.box.x, -9999);
  assert.equal(noStage.clampedX, false);
  assert.equal(round(table.length), 5);
});

test('S37-U5 clampVisible：比 32 还小的片段按自身尺寸算可见量（不放大）', () => {
  const small = { x: -500, y: -500, w: 20, h: 20 };
  const got = G.clampVisible(small, STAGE);
  /* 可见量 = min(32, w) = 20 → x ∈ [20-20, 1280-20] = [0, 1260] */
  assert.equal(got.box.x, 0);
  assert.equal(got.box.y, 0);
  assert.equal(got.box.w, 20, '不许把 20px 的片段放大到 32');
  assert.equal(got.box.h, 20);
});

test('S37-U6 clampGroupDelta：多选整组夹边界，位移仍然只有一个 Δ', () => {
  const union = { x: 100, y: 100, w: 400, h: 200 };
  /* 往左狂拖：并集右缘最多留 32 → dx = (32 - 400) - 100 = -468 */
  const left = G.clampGroupDelta(union, { x: -5000, y: 0 }, STAGE);
  assert.equal(round(left.dx), -468);
  assert.equal(left.dy, 0);
  assert.equal(left.clampedX, true);
  assert.equal(left.clampedY, false);
  /* 往右下狂拖：x ≤ 1280-32-100 = 1148；y ≤ 720-32-100 = 588 */
  const right = G.clampGroupDelta(union, { x: 5000, y: 5000 }, STAGE);
  assert.equal(right.dx, 1148);
  assert.equal(right.dy, 588);
  assert.equal(right.clampedX && right.clampedY, true);
  /* 没出界：原样（同一 Δ，不分解到各层） */
  const free = G.clampGroupDelta(union, { x: 12.5, y: -8.25 }, STAGE);
  assert.deepEqual(free, { dx: 12.5, dy: -8.25, clampedX: false, clampedY: false });
});
