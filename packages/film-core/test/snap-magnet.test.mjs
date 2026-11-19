// @ts-nocheck —— 以 node --test 的运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * 磁吸能力层单测（M63 · B-MAIN-R30-031）。
 *
 * 只测「算得对不对」：像素→秒、帧对齐、只改被拖端、严格主轨。落盘与 HTTP 由
 * `scripts/m63-magnetic-ripple.mjs` 在真 Studio 上验。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SnapError,
  fpsValue,
  frameOf,
  frameSeconds,
  planMagnetEdit,
  planRippleDeleteStrict,
  planRippleInsertStrict,
  planTimelineSnap,
  resolveMainTrackStrict,
  snapAt,
  toleranceSeconds,
} from '../snap-magnet.mjs';

/** 造一条轨；`role` 默认 picture。 */
function track(index, clips, extra = {}) {
  return {
    index,
    role: 'picture',
    clips: clips.map((clip) => ({ src: 'assets/a.mp4', time: [0, 2], at: 0, ...clip })),
    ...extra,
  };
}

/** 0–2 / 2–4 / 4–6 三段主轨。 */
function threeClips() {
  return track(0, [
    { id: 'a', at: 0, time: [0, 2] },
    { id: 'b', at: 2, time: [0, 2] },
    { id: 'c', at: 4, time: [0, 2] },
  ]);
}

/* ── 像素 → 秒 ─────────────────────────────────────────────────────── */

test('toleranceSeconds：pxPerSecond 直给（100px/s × 6px = 0.06s）', () => {
  const out = toleranceSeconds({ tolerancePx: 6, pxPerSecond: 100 });
  assert.equal(out.toleranceSec, 0.06);
  assert.equal(out.pxPerSecond, 100);
  assert.equal(out.source, 'pxPerSecond');
});

test('toleranceSeconds：viewportWidth + durationSec 折算（1000px / 10s = 100px/s）', () => {
  const out = toleranceSeconds({ tolerancePx: 6, viewportWidth: 1000, durationSec: 10 });
  assert.equal(out.pxPerSecond, 100);
  assert.equal(out.toleranceSec, 0.06);
  assert.equal(out.source, 'viewport');
});

test('toleranceSeconds：tolerancePx=0 抛 SNAP_INVALID_TOLERANCE（不静默取 0）', () => {
  assert.throws(() => toleranceSeconds({ tolerancePx: 0, pxPerSecond: 100 }), (error) => {
    assert.ok(error instanceof SnapError);
    assert.equal(error.code, 'SNAP_INVALID_TOLERANCE');
    return true;
  });
});

test('toleranceSeconds：tolerancePx 为负/非有限 → 抛错', () => {
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => toleranceSeconds({ tolerancePx: bad, pxPerSecond: 100 }), (error) => error.code === 'SNAP_INVALID_TOLERANCE');
  }
});

test('toleranceSeconds：pxPerSecond=0/负 抛 SNAP_INVALID_SCALE', () => {
  for (const bad of [0, -2, Number.NaN]) {
    assert.throws(() => toleranceSeconds({ tolerancePx: 6, pxPerSecond: bad }), (error) => error.code === 'SNAP_INVALID_SCALE');
  }
});

test('toleranceSeconds：viewport 路径的 durationSec/viewportWidth 非法 → 抛错', () => {
  assert.throws(() => toleranceSeconds({ tolerancePx: 6, viewportWidth: 1000, durationSec: 0 }), (error) => error.code === 'SNAP_INVALID_DURATION');
  assert.throws(() => toleranceSeconds({ tolerancePx: 6, viewportWidth: 0, durationSec: 10 }), (error) => error.code === 'SNAP_INVALID_SCALE');
  assert.throws(() => toleranceSeconds({ tolerancePx: 6, viewportWidth: 1000 }), (error) => error.code === 'SNAP_INVALID_DURATION');
});

/* ── 吸附口径 ──────────────────────────────────────────────────────── */

test('snapAt：距离正好等于容差 → 吸附（含等号）', () => {
  const lanes = [track(0, [{ id: 'a', at: 0, time: [0, 2] }])];
  const hit = snapAt({ tracks: lanes, seconds: 2.05, fps: 30, toleranceSec: 0.05 });
  assert.equal(hit.snapped, true);
  assert.equal(hit.target, 2);
  assert.equal(hit.value, 2);
});

test('snapAt：超出容差 1px（0.01s）→ 不吸附，target=null', () => {
  const lanes = [track(0, [{ id: 'a', at: 0, time: [0, 2] }])];
  const hit = snapAt({ tracks: lanes, seconds: 2.06, fps: 30, toleranceSec: 0.05, excludeIds: ['a'] });
  assert.equal(hit.snapped, false);
  assert.equal(hit.target, null);
  // 未吸附也量化到帧：2.06×30 = 61.8 → 62 帧 → 2.066667
  assert.equal(hit.frame, 62);
});

test('snapAt：同距离取靠前（0.5 与 1.5 等距 → 0.5）', () => {
  const lanes = [track(0, [{ id: 'a', at: 0.5, time: [0, 0] }])];
  const hit = snapAt({ tracks: lanes, seconds: 1, fps: 30, toleranceSec: 1, playhead: 1.5 });
  // 候选 = 0 / 0.5 / 1.5；value=1 到 0.5 与 1.5 都是 0.5 → 升序里先遇到 0.5
  assert.equal(hit.target, 0.5);
});

test('snapAt：fps=29.97 时 value === frame/fps（误差 ≤1e-6）', () => {
  const fps = { num: 30000, den: 1001 };
  const lanes = [track(0, [{ id: 'a', at: 1.5015, time: [0, 2] }])];
  const hit = snapAt({ tracks: lanes, seconds: 1.5001, fps, toleranceSec: 0.05, excludeIds: [] });
  assert.equal(hit.snapped, true);
  const rate = fpsValue(fps);
  assert.ok(rate > 29.96 && rate < 29.98, String(rate));
  assert.ok(Math.abs(hit.value - hit.frame / rate) <= 1e-6);
  assert.equal(hit.frame, frameOf(hit.value, fps));
});

test('snapAt：空轨也能吸附到零点', () => {
  const hit = snapAt({ tracks: [track(0, [])], seconds: 0.02, fps: 30, toleranceSec: 0.05 });
  assert.equal(hit.snapped, true);
  assert.equal(hit.target, 0);
  assert.equal(hit.frame, 0);
});

test('snapAt：单片段排除自身后只剩零点', () => {
  const lanes = [track(0, [{ id: 'only', at: 3, time: [0, 2] }])];
  const hit = snapAt({ tracks: lanes, seconds: 0.01, fps: 30, toleranceSec: 0.05, excludeIds: ['only'] });
  assert.deepEqual(hit.candidates, [0]);
  assert.equal(hit.target, 0);
});

test('snapAt：播放头缺失时不产生播放头候选', () => {
  const lanes = [track(0, [{ id: 'a', at: 3, time: [0, 2] }])];
  const hit = snapAt({ tracks: lanes, seconds: 2.5, fps: 30, toleranceSec: 0.01, excludeIds: ['a'] });
  assert.deepEqual(hit.candidates, [0]);
  assert.equal(hit.snapped, false);
});

test('snapAt：负值输入吸附到 0 而不是产出负时间', () => {
  const hit = snapAt({ tracks: [track(0, [])], seconds: -0.01, fps: 30, toleranceSec: 0.05 });
  assert.equal(hit.value, 0);
  assert.ok(hit.value >= 0);
});

test('snapAt：frameSeconds 与 frameOf 互逆（30fps / 29.97）', () => {
  for (const fps of [30, { num: 30000, den: 1001 }]) {
    for (const seconds of [0, 1.5015, 2.999, 7.4]) {
      const aligned = frameSeconds(seconds, fps);
      assert.ok(Math.abs(aligned - frameOf(aligned, fps) / fpsValue(fps)) <= 1e-6);
    }
  }
});

/* ── 严格主轨 ──────────────────────────────────────────────────────── */

test('resolveMainTrackStrict：单画面轨 ok；0 条 NO_MAIN_TRACK；2 条 MULTI_MAIN_TRACK', () => {
  assert.equal(resolveMainTrackStrict([track(0, [])]).ok, true);
  const none = resolveMainTrackStrict([{ index: 0, role: 'audio', clips: [] }]);
  assert.equal(none.ok, false);
  assert.equal(none.code, 'NO_MAIN_TRACK');
  const multi = resolveMainTrackStrict([track(3, []), track(4, [])]);
  assert.equal(multi.ok, false);
  assert.equal(multi.code, 'MULTI_MAIN_TRACK');
  assert.deepEqual(multi.indices, [3, 4]);
});

/* ── move / trim ───────────────────────────────────────────────────── */

test('move 起点：吸附到前片段末尾，帧对齐且另一端点不漂', () => {
  const lanes = [track(0, [
    { id: 'a', at: 0, time: [0, 2] },
    { id: 'b', at: 3, time: [0, 2] },
    { id: 'c', at: 6, time: [0, 2] },
  ])];
  const plan = planMagnetEdit({ mode: 'move', tracks: lanes, clipId: 'b', edge: 'start', seconds: 2.02, fps: 30, toleranceSec: 0.05 });
  assert.equal(plan.ok, true);
  assert.equal(plan.snap.target, 2);
  assert.equal(plan.snap.snapped, true);
  assert.equal(plan.before.start, 3);
  assert.equal(plan.after.start, 2);
  assert.equal(plan.after.end, 4);
  assert.equal(plan.after.duration, 2);
  assert.equal(plan.after.frameStart, 60);
  assert.deepEqual(plan.ops, [{ op: 'props', edits: [{ clip: 'b', prop: 'at', value: 2 }] }]);
});

test('move 终点：吸附到后片段起点，起点跟着走（时长不变）', () => {
  const lanes = [track(0, [
    { id: 'a', at: 0, time: [0, 2] },
    { id: 'b', at: 3, time: [0, 2] },
    { id: 'c', at: 6, time: [0, 2] },
  ])];
  const plan = planMagnetEdit({ mode: 'move', tracks: lanes, clipId: 'b', edge: 'end', seconds: 6.02, fps: 30, toleranceSec: 0.05 });
  assert.equal(plan.ok, true);
  assert.equal(plan.snap.target, 6);
  assert.equal(plan.after.end, 6);
  assert.equal(plan.after.start, 4);
  assert.equal(plan.after.duration, 2);
  assert.deepEqual(plan.ops, [{ op: 'props', edits: [{ clip: 'b', prop: 'at', value: 4 }] }]);
});

test('trim 末端：时长变化 = 吸附差，起点不动', () => {
  const lanes = [track(0, [
    { id: 'a', at: 0, time: [0, 2] },
    { id: 'b', at: 2, time: [0, 2] },
  ])];
  const plan = planMagnetEdit({ mode: 'trim', tracks: lanes, clipId: 'a', edge: 'end', seconds: 4.03, fps: 30, toleranceSec: 0.05 });
  assert.equal(plan.ok, true);
  assert.equal(plan.snap.target, 4, 'b 的末端（8）更远，吸附到 b 的起点 4');
  assert.equal(plan.before.start, 0);
  assert.equal(plan.after.start, 0);
  assert.equal(plan.after.end, 4);
  assert.equal(plan.after.duration, 4);
  assert.deepEqual(plan.ops, [{ op: 'props', edits: [{ clip: 'a', prop: 'time', value: [0, 4] }] }]);
});

test('trim 起点：at 与 time[0] 一起改，尾端钉住', () => {
  const lanes = [track(0, [{ id: 'a', at: 3, time: [1, 3] }])];
  const plan = planMagnetEdit({
    mode: 'trim',
    tracks: lanes,
    clipId: 'a',
    edge: 'start',
    seconds: 2.48,
    fps: 30,
    toleranceSec: 0.05,
    playhead: 2.5,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.snap.target, 2.5);
  assert.equal(plan.before.end, 5);
  assert.equal(plan.after.start, 2.5);
  assert.equal(plan.after.end, 5);
  assert.equal(plan.after.duration, 2.5);
  const edits = plan.ops[0].edits;
  assert.deepEqual(edits[0], { clip: 'a', prop: 'at', value: 2.5 });
  assert.deepEqual(edits[1], { clip: 'a', prop: 'time', value: [0.5, 3] });
});

test('trim 起点：speed=2 时 time[0] 位移 = 时间线位移 × 2', () => {
  const lanes = [track(0, [{ id: 'a', at: 1, time: [0, 6], speed: 2 }])];
  const plan = planMagnetEdit({ mode: 'trim', tracks: lanes, clipId: 'a', edge: 'start', seconds: 2.0, fps: 30, toleranceSec: 0.01, playhead: 2 });
  assert.equal(plan.ok, true);
  assert.equal(plan.before.start, 1);
  assert.equal(plan.before.end, 4);
  assert.equal(plan.after.start, 2);
  assert.equal(plan.after.end, 4);
  assert.equal(plan.after.duration, 2);
  assert.deepEqual(plan.ops[0].edits[1], { clip: 'a', prop: 'time', value: [2, 6] });
});

test('move 到负起点 → NEGATIVE_START，不发 op', () => {
  const lanes = [threeClips()];
  const plan = planMagnetEdit({ mode: 'move', tracks: lanes, clipId: 'a', edge: 'start', seconds: -5, fps: 30, toleranceSec: 0.05 });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'NEGATIVE_START');
  assert.equal(plan.ops, undefined);
});

test('trim 起点拖到终点 → ZERO_DURATION', () => {
  const lanes = [threeClips()];
  const plan = planMagnetEdit({ mode: 'trim', tracks: lanes, clipId: 'a', edge: 'start', seconds: 2, fps: 30, toleranceSec: 0.01 });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'ZERO_DURATION');
});

test('trim 末端拖到起点之前 → NEGATIVE_DURATION', () => {
  const lanes = [threeClips()];
  const plan = planMagnetEdit({ mode: 'trim', tracks: lanes, clipId: 'a', edge: 'end', seconds: -1, fps: 30, toleranceSec: 0.01 });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'NEGATIVE_DURATION');
});

test('片段不存在 → CLIP_NOT_FOUND；锁轨 → NOT_FOUND', () => {
  const missing = planMagnetEdit({ mode: 'move', tracks: [threeClips()], clipId: 'zz', edge: 'start', seconds: 1, fps: 30, toleranceSec: 0.05 });
  assert.equal(missing.code, 'CLIP_NOT_FOUND');
  const locked = planMagnetEdit({
    mode: 'move',
    tracks: [track(0, [{ id: 'a', at: 0, time: [0, 2] }], { locked: true })],
    clipId: 'a',
    edge: 'start',
    seconds: 0,
    fps: 30,
    toleranceSec: 0.05,
  });
  assert.equal(locked.code, 'NOT_FOUND');
});

test('幂等：同参数两次结果完全一致', () => {
  const lanes = [threeClips()];
  const input = { mode: 'trim', tracks: lanes, clipId: 'b', edge: 'end', seconds: 4.01, fps: 30, toleranceSec: 0.05 };
  assert.deepEqual(planMagnetEdit(input), planMagnetEdit(input));
});

test('move 的 mode/edge 非法值显式报错', () => {
  const lanes = [threeClips()];
  assert.equal(planMagnetEdit({ mode: 'scale', tracks: lanes, clipId: 'a', edge: 'start', seconds: 0, fps: 30, toleranceSec: 0.05 }).code, 'INVALID_MODE');
  assert.equal(planMagnetEdit({ mode: 'move', tracks: lanes, clipId: 'a', edge: 'middle', seconds: 0, fps: 30, toleranceSec: 0.05 }).code, 'INVALID_EDGE');
});

/* ── 波纹（严格主轨）──────────────────────────────────────────────── */

test('波纹插入：主轨插入 1s，后续 3 段位移量逐一等于插入时长', () => {
  const lanes = [track(0, [
    { id: 'a', at: 0, time: [0, 2] },
    { id: 'b', at: 2, time: [0, 2] },
    { id: 'c', at: 4, time: [0, 2] },
    { id: 'd', at: 6, time: [0, 2] },
  ])];
  const plan = planRippleInsertStrict({ tracks: lanes, track: 0, at: 4, length: 2 });
  assert.equal(plan.ok, true);
  assert.equal(plan.mainTrack, 0);
  assert.deepEqual(plan.moved, [
    { id: 'c', from: 4, to: 6 },
    { id: 'd', from: 6, to: 8 },
  ]);
});

test('波纹插入：插入点之前的片段不动；非主轨不位移', () => {
  const lanes = [threeClips(), { index: 1, role: 'overlay', clips: [{ id: 'x', at: 1, time: [0, 1] }] }];
  const mainPlan = planRippleInsertStrict({ tracks: lanes, track: 0, at: 2, length: 1 });
  assert.deepEqual(mainPlan.moved.map((item) => item.id), ['b', 'c']);
  const subPlan = planRippleInsertStrict({ tracks: lanes, track: 1, at: 0, length: 1 });
  assert.equal(subPlan.ok, true);
  assert.deepEqual(subPlan.moved, []);
});

test('波纹插入：多主轨报 MULTI_MAIN_TRACK，不挑一条', () => {
  const lanes = [track(0, [{ id: 'a', at: 0, time: [0, 2] }]), track(1, [{ id: 'b', at: 0, time: [0, 2] }])];
  const plan = planRippleInsertStrict({ tracks: lanes, track: 0, at: 0, length: 2 });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'MULTI_MAIN_TRACK');
  assert.deepEqual(plan.ops, []);
});

test('波纹删除：删中间段后闭合空档（后续段落左移 2s）', () => {
  const lanes = [threeClips()];
  const plan = planRippleDeleteStrict({ tracks: lanes, ids: ['b'] });
  assert.equal(plan.ok, true);
  assert.equal(plan.mainTrack, 0);
  assert.deepEqual(plan.removed, ['b']);
  assert.deepEqual(plan.moved, [{ id: 'c', from: 4, to: 2 }]);
  assert.deepEqual(plan.ops, [
    { op: 'remove', clip: 'b' },
    { op: 'props', edits: [{ clip: 'c', prop: 'at', value: 2 }] },
  ]);
});

test('波纹删除：多主轨报 MULTI_MAIN_TRACK', () => {
  const lanes = [track(0, [{ id: 'a', at: 0, time: [0, 2] }]), track(1, [{ id: 'b', at: 0, time: [0, 2] }])];
  const plan = planRippleDeleteStrict({ tracks: lanes, ids: ['a'] });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'MULTI_MAIN_TRACK');
});

/* ── 只读规划入口 ─────────────────────────────────────────────────── */

test('planTimelineSnap：像素容差在服务端闭合，返回 plan 且不写盘', () => {
  const lanes = [threeClips()];
  const out = planTimelineSnap({
    lanes,
    mode: 'move',
    clipId: 'b',
    edge: 'start',
    seconds: 2.04,
    fps: { num: 30, den: 1 },
    tolerancePx: 6,
    pxPerSecond: 200,
  });
  assert.equal(out.tolerance.toleranceSec, 0.03);
  assert.equal(out.plan.ok, true);
  assert.equal(out.plan.snap.snapped, false, '4px 差 > 6px? 不，0.04s×200=8px > 6px → 不吸附');
  assert.equal(out.snap.value, 2.033333);
});

test('planTimelineSnap：无 clipId 时只做单点吸附', () => {
  const lanes = [threeClips()];
  const out = planTimelineSnap({ lanes, seconds: 4.01, fps: 30, tolerancePx: 10, pxPerSecond: 100, playhead: 0 });
  assert.equal(out.plan, null);
  assert.equal(out.snap.target, 4);
  assert.equal(out.snap.snapped, true);
});
