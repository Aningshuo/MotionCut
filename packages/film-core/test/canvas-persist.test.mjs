// @ts-nocheck —— 以 node --test 的运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * 画布手势 → box 的映射单测（M64 · B-MAIN-R30-031）。
 *
 * 落盘原子性/幂等由 `packages/studio/server/test/canvas-persist.test.mjs` 用真 film-io 验。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CANVAS_MIN_SIZE,
  applyCanvasGesture,
  boxToOps,
  normalizeAngle,
  readbackBox,
  rotatedAabbOf,
  verifyReadback,
} from '../canvas-persist.mjs';
import { GESTURE_MIN_SIZE } from '../../layers/canvas-gesture.mjs';

/** 1280×720 舞台上 320×180 的框。 */
const STAGE = { w: 1280, h: 720 };
const BOX = { left: 100, top: 50, width: 320, height: 180, rotate: 0 };

test('最小尺寸与 layers 的 GESTURE_MIN_SIZE 对拍（防止两边各写一个 8）', () => {
  assert.equal(CANVAS_MIN_SIZE, GESTURE_MIN_SIZE);
});

test('normalizeAngle：归一到 (-180, 180]', () => {
  assert.equal(normalizeAngle(181), -179);
  assert.equal(normalizeAngle(-180), 180);
  assert.equal(normalizeAngle(180), 180);
  assert.equal(normalizeAngle(540), 180);
  assert.equal(normalizeAngle(359), -1);
  assert.equal(normalizeAngle(0), 0);
});

test('move：归一化位移按舞台尺寸换算', () => {
  const out = applyCanvasGesture({ stage: STAGE, box: BOX, gesture: { kind: 'move', dx: 0.1, dy: 0.05 } });
  assert.equal(out.ok, true);
  assert.deepEqual(out.box, { left: 228, top: 86, width: 320, height: 180, rotate: 0 });
  assert.equal(out.overflow, false);
});

test('scale(se)：左上角固定，宽高等比放大', () => {
  const out = applyCanvasGesture({ stage: STAGE, box: BOX, gesture: { kind: 'scale', factor: 1.5, anchor: 'se' } });
  assert.deepEqual(out.box, { left: 100, top: 50, width: 480, height: 270, rotate: 0 });
});

test('scale(nw)：右下角固定', () => {
  const out = applyCanvasGesture({ stage: STAGE, box: BOX, gesture: { kind: 'scale', factor: 2, anchor: 'nw' } });
  assert.deepEqual(out.box, { left: -220, top: -130, width: 640, height: 360, rotate: 0 });
  assert.equal(out.overflow, true);
  assert.equal(out.overflowPx.left, 220);
  assert.equal(out.overflowPx.top, 130);
});

test('scale(ne)：左边固定、下边固定', () => {
  const out = applyCanvasGesture({ stage: STAGE, box: BOX, gesture: { kind: 'scale', factor: 1.25, anchor: 'ne' } });
  assert.deepEqual(out.box, { left: 100, top: 5, width: 400, height: 225, rotate: 0 });
});

test('scale(sw)：右边固定、上边固定', () => {
  const out = applyCanvasGesture({ stage: STAGE, box: BOX, gesture: { kind: 'scale', factor: 0.5, anchor: 'sw' } });
  assert.deepEqual(out.box, { left: 260, top: 50, width: 160, height: 90, rotate: 0 });
});

test('scale：小于最小尺寸时夹到 CANVAS_MIN_SIZE 并报 minApplied', () => {
  const out = applyCanvasGesture({ stage: STAGE, box: BOX, gesture: { kind: 'scale', factor: 0.001, anchor: 'se' } });
  assert.equal(out.box.width, CANVAS_MIN_SIZE);
  assert.equal(out.box.height, CANVAS_MIN_SIZE);
  assert.equal(out.minApplied, true);
});

test('rotate：累加后归一（179 + 2 = -179）', () => {
  const out = applyCanvasGesture({ stage: STAGE, box: { ...BOX, rotate: 179 }, gesture: { kind: 'rotate', degrees: 2 } });
  assert.equal(out.box.rotate, -179);
});

test('越界：移到舞台外按四边给溢出像素', () => {
  const out = applyCanvasGesture({ stage: STAGE, box: BOX, gesture: { kind: 'move', dx: -0.2, dy: 0.9 } });
  assert.equal(out.box.left, -156);
  assert.equal(out.box.top, 698);
  assert.equal(out.overflow, true);
  assert.equal(out.overflowPx.left, 156);
  assert.equal(out.overflowPx.bottom, 158); // 698 + 180 − 720
});

test('越界：旋转 45° 用轴对齐包围盒判定（居中不越界、贴边越界）', () => {
  const plain = rotatedAabbOf({ left: 400, top: 200, width: 400, height: 200, rotate: 0 });
  assert.deepEqual(plain, { left: 400, right: 800, top: 200, bottom: 400 });
  // 居中：转 45° 后 AABB 变大但仍在大舞台里
  const centered = applyCanvasGesture({ stage: STAGE, box: { left: 400, top: 200, width: 400, height: 200, rotate: 0 }, gesture: { kind: 'rotate', degrees: 45 } });
  assert.equal(centered.overflow, false);
  const aabb = rotatedAabbOf(centered.box);
  assert.ok(aabb.right - aabb.left > 400, '旋转后包围盒必须比原宽大');
  // 贴左上角：同样的旋转把角顶出舞台
  const corner = applyCanvasGesture({ stage: STAGE, box: { left: 0, top: 0, width: 400, height: 200, rotate: 0 }, gesture: { kind: 'rotate', degrees: 45 } });
  assert.equal(corner.overflow, true);
  assert.ok(corner.overflowPx.left > 0 && corner.overflowPx.top > 0);
});

test('boxToOps：rotate=0 不写 r；非 0 写 r', () => {
  const flat = boxToOps({ clipId: 'a', box: BOX });
  assert.deepEqual(flat, [{ op: 'props', edits: [{ clip: 'a', prop: 'box', value: { x: 100, y: 50, w: 320, h: 180 } }] }]);
  const turned = boxToOps({ clipId: 'a', box: { ...BOX, rotate: -179 } });
  assert.deepEqual(turned[0].edits[0].value, { x: 100, y: 50, w: 320, h: 180, r: -179 });
});

test('verifyReadback：≤1e-3 通过、1e-2 失败、缺 box 失败', () => {
  const ok = verifyReadback(BOX, { ...BOX, left: 100.0009 });
  assert.equal(ok.ok, true);
  assert.equal(ok.worst, 0.0009);
  const bad = verifyReadback(BOX, { ...BOX, left: 100.02 });
  assert.equal(bad.ok, false);
  assert.equal(verifyReadback(BOX, null).ok, false);
});

test('readbackBox：r 缺省按 0，非法 box 返回 null', () => {
  assert.deepEqual(readbackBox({ box: { x: 1, y: 2, w: 3, h: 4 } }), { left: 1, top: 2, width: 3, height: 4, rotate: 0 });
  assert.equal(readbackBox({ box: null }), null);
  assert.equal(readbackBox({ box: { x: 1, y: 2, w: 0, h: 4 } })?.width, 0);
});

test('非法输入：舞台/box/factor/anchor/kind 都显式报错', () => {
  assert.equal(applyCanvasGesture({ stage: { w: 0, h: 720 }, box: BOX, gesture: { kind: 'move' } }).code, 'INVALID_STAGE');
  assert.equal(applyCanvasGesture({ stage: STAGE, box: { ...BOX, width: 0 }, gesture: { kind: 'move' } }).code, 'INVALID_BOX');
  assert.equal(applyCanvasGesture({ stage: STAGE, box: BOX, gesture: { kind: 'scale', factor: 0 } }).code, 'INVALID_GESTURE');
  assert.equal(applyCanvasGesture({ stage: STAGE, box: BOX, gesture: { kind: 'scale', factor: 1, anchor: 'middle' } }).code, 'INVALID_GESTURE');
  assert.equal(applyCanvasGesture({ stage: STAGE, box: BOX, gesture: { kind: 'spin' } }).code, 'INVALID_GESTURE');
  assert.equal(applyCanvasGesture({ stage: STAGE, box: BOX, gesture: { kind: 'move', dx: Number.NaN, dy: 0 } }).code, 'INVALID_GESTURE');
});
