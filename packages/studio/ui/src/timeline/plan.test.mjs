// @ts-nocheck —— 以 node --test 的运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * 时间线规划的磁吸单测（M23 · B-MAIN-R12-012）。
 *
 * 重点两件事：
 * 1. 磁吸只在该吸的时候吸（像素阈值由调用方换算成秒，这里传秒）。
 * 2. **落盘值永远是整帧**——29.97 也一样（`round(t*30000/1001)` 必须是整数）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { planMove, planSelectionMove, planSpeedEdge, planTrim } from './plan.mjs';

const FPS30 = { num: 30, den: 1 };
const FPS2997 = { num: 30000, den: 1001 };

/** 秒 → 帧号（29.97 的有理数换算，和工程里同一套）。 */
function frameOf(seconds, fps) {
  return Math.round((seconds * fps.num) / fps.den);
}

test('planMove：无 magnetic 时行为不变（不吸、不落帧）', () => {
  const plan = planMove({ clip: { id: 'a', at: 0, time: [0, 2] }, track: 0, deltaPx: 30, pxPerSecond: 100 });
  assert.equal(plan.placed.a.start, 0.3);
  assert.equal(plan.guide, null);
});

test('planMove：起点贴目标（阈值内）→ 落到目标并给出参考线', () => {
  const plan = planMove({
    clip: { id: 'b', at: 2, time: [0, 2] },
    track: 0,
    deltaPx: 5,
    pxPerSecond: 100, // 5px = 0.05s
    fps: FPS30,
    magnetic: { targets: [2], toleranceSec: 0.08 },
  });
  assert.equal(plan.placed.b.start, 2);
  assert.deepEqual(plan.guide, { time: 2, edge: 'start' });
});

test('planMove：终点贴目标 → 起点 = 目标 - 长度', () => {
  const plan = planMove({
    clip: { id: 'b', at: 4, time: [0, 2] },
    track: 0,
    deltaPx: 5,
    pxPerSecond: 100, // 起点 4.05，终点 6.05，目标 6 → 终点吸
    fps: FPS30,
    magnetic: { targets: [6], toleranceSec: 0.08 },
  });
  assert.equal(plan.placed.b.start, 4);
  assert.deepEqual(plan.guide, { time: 6, edge: 'end' });
});

test('planMove：超出阈值不吸（14px / pps=100 → 0.14s > 0.08s）', () => {
  const plan = planMove({
    clip: { id: 'b', at: 2, time: [0, 2] },
    track: 0,
    deltaPx: 14,
    pxPerSecond: 100,
    fps: FPS30,
    magnetic: { targets: [2], toleranceSec: 0.08 },
  });
  assert.equal(plan.placed.b.start, 2.14);
  assert.equal(plan.guide, null);
});

test('planMove：29.97 下吸附结果落整帧', () => {
  // 目标 2.002 = 第 60 帧（2.002 * 30000/1001 = 60.0）
  const plan = planMove({
    clip: { id: 'b', at: 2.002, time: [0, 2] },
    track: 0,
    deltaPx: 3,
    pxPerSecond: 100, // 0.03s 偏差
    fps: FPS2997,
    magnetic: { targets: [2.002], toleranceSec: 0.08 },
  });
  const start = plan.placed.b.start;
  assert.equal(start, 2.002);
  assert.equal(frameOf(start, FPS2997), 60);
  assert.equal(Number(start.toFixed(3)), start);
});

test('planTrim：右手柄吸到邻片边界', () => {
  const plan = planTrim({
    clip: { id: 'a', at: 0, time: [0, 2] },
    track: 0,
    edge: 'end',
    deltaPx: 4,
    pxPerSecond: 100, // 终点 2.04
    fps: FPS30,
    magnetic: { targets: [2], toleranceSec: 0.08 },
  });
  assert.deepEqual(plan.placed.a, { start: 0, end: 2, track: 0 });
  assert.deepEqual(plan.guide, { time: 2, edge: 'end' });
  assert.equal(plan.ops[0].edits[0].prop, 'end');
});

test('planTrim：左手柄吸到零点（at 跟着走、源入点回 0）', () => {
  const plan = planTrim({
    clip: { id: 'a', at: 0.5, time: [0.5, 2.5] },
    track: 0,
    edge: 'start',
    deltaPx: -46,
    pxPerSecond: 100, // 起点 0.5 → 0.04，落在 0 的 0.08 阈值内
    fps: FPS30,
    magnetic: { targets: [0], toleranceSec: 0.08 },
  });
  assert.equal(plan.placed.a.start, 0);
  assert.equal(plan.ops[0].edits[0].value, 0);
  assert.equal(plan.ops[0].edits[1].value, 0);
});


test('cross-track drag moves a selection together and prevents a blocked member from being partially moved', () => {
  const mg = { id: 'mg', at: 0, src: 'mg.html', kind: 'page', time: [0, 7] };
  const title = { id: 'title', at: 8, src: 'title.html', kind: 'page', time: [0, 1] };
  const tracks = [
    { index: 0, role: 'video', clips: [{ id: 'base', at: 0, kind: 'video', time: [0, 167.5] }] },
    { index: 1, role: 'overlay', clips: [mg, title] },
    { index: 2, role: 'overlay', clips: [] },
    { index: 3, role: 'audio', clips: [] },
  ];
  const input = { tracks, ids: ['mg', 'title'], anchorId: 'mg', targetTrack: 2, deltaPx: 200, pxPerSecond: 100, fps: FPS30 };
  const plan = planSelectionMove(input);
  assert.equal(plan.ops.length, 1);
  assert.deepEqual(plan.placed, { mg: { start: 2, end: 9, track: 2 }, title: { start: 10, end: 11, track: 2 } });
  assert.equal(planSelectionMove({ ...input, targetTrack: 3 }).ops.length, 0);
  assert.equal(planSelectionMove({ ...input, protectedIds: ['title'] }).ops.length, 0);
  assert.equal(planSelectionMove({ ...input, tracks: tracks.map((row, index) => index === 2 ? { ...row, locked: true } : row) }).ops.length, 0);
  const collision = { id: 'other', at: 10, kind: 'page', time: [0, 1] };
  assert.equal(planSelectionMove({ ...input, tracks: tracks.map((row, index) => index === 2 ? { ...row, clips: [collision] } : row) }).ops.length, 0);
});

test('edge retiming preserves source in and out, and the opposite timeline boundary', () => {
  const clip = { id: 'mg', kind: 'page', at: 2, time: [4, 10], speed: 1.5 };
  const input = { clip, track: 0, pxPerSecond: 100, fps: FPS30 };
  const end = planSpeedEdge({ ...input, edge: 'end', deltaPx: -100 });
  assert.deepEqual(end.placed.mg, { start: 2, end: 5, track: 0 });
  assert.deepEqual(end.ops[0].edits, [{ clip: 'mg', prop: 'speed', value: 2 }]);
  const start = planSpeedEdge({ ...input, edge: 'start', deltaPx: 100 });
  assert.deepEqual(start.placed.mg, { start: 3, end: 6, track: 0 });
  assert.deepEqual(start.ops[0].edits, [{ clip: 'mg', prop: 'speed', value: 2 }, { clip: 'mg', prop: 'at', value: 3 }]);
});
