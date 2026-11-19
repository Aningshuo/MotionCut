// @ts-nocheck —— 以 node --test 的运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * 主轨磁吸 / 波纹的纯函数单测（M23 · B-MAIN-R12-012）。
 *
 * 这里只测「算得对不对」：Op 长什么样、谁被移动、锁轨怎么拒。
 * 落盘、一次撤销、一次 HTTP 由 `scripts/m23-ripple.mjs` 在真 Studio 上验。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { collectSnapTargets, mainTrackIndex, mainTrackOf, planRippleDelete, planRippleInsert, snapSeconds, spanOf } from '../ripple.mjs';
import { clipSpan } from '../../studio/ui/src/timeline/geometry.mjs';

/** 造一条轨；`role` 默认 picture。 @param {any} index @param {any} clips @param {any} [extra] */
function track(index, clips, extra = {}) {
  return { index, role: 'picture', clips: clips.map((clip, at) => ({ id: `c${at}`, src: 'assets/a.mp4', time: [0, 2], at: 0, ...clip })), ...extra };
}

/** 0-2 / 2-4 / 4-6 三条主轨片段。 */
function threeClips() {
  return track(0, [
    { id: 'a', at: 0, time: [0, 2] },
    { id: 'b', at: 2, time: [0, 2] },
    { id: 'c', at: 4, time: [0, 2] },
  ]);
}

test('主轨：无画面轨 → null', () => {
  assert.equal(mainTrackIndex([]), null);
  assert.equal(mainTrackIndex([{ index: 0, role: 'audio', clips: [] }]), null);
  assert.equal(mainTrackIndex([{ index: 0, role: 'page', clips: [] }]), null);
});

test('主轨：多画面轨取最低那条（数组顺序 = 层叠顺序，第一个在最上层）', () => {
  const tracks = [
    { index: 7, role: 'picture', clips: [] },
    { index: 8, role: 'audio', clips: [] },
    { index: 9, role: 'picture', clips: [] },
    { index: 10, role: 'picture', clips: [] },
  ];
  assert.equal(mainTrackIndex(tracks), 10);
  assert.equal(mainTrackOf(tracks)?.index, 10);
});

test('主轨：被锁也照样认出来（锁是操作层的事）', () => {
  const tracks = [track(0, [{ id: 'a' }]), track(1, [{ id: 'b' }], { locked: true })];
  assert.equal(mainTrackIndex(tracks), 1);
  assert.equal(mainTrackOf(tracks)?.locked, true);
});

test('波纹删除：删中间 → 第三段 at=2，两段 Op（remove + props）', () => {
  const plan = planRippleDelete({ tracks: [threeClips()], ids: ['b'] });
  assert.equal(plan.ok, true);
  assert.equal(plan.mainTrack, 0);
  assert.equal(plan.ripple, true);
  assert.deepEqual(plan.removed, ['b']);
  assert.deepEqual(plan.moved, [{ id: 'c', from: 4, to: 2 }]);
  assert.deepEqual(plan.ops, [
    { op: 'remove', clip: 'b' },
    { op: 'props', edits: [{ clip: 'c', prop: 'at', value: 2 }] },
  ]);
});

test('波纹删除：删最后一段 → 前面的不动，没有 props', () => {
  const plan = planRippleDelete({ tracks: [threeClips()], ids: ['c'] });
  assert.equal(plan.moved.length, 0);
  assert.deepEqual(plan.ops, [{ op: 'remove', clip: 'c' }]);
});

test('普通删除（ripple:false）：留间隙，第三段 at 仍 4', () => {
  const plan = planRippleDelete({ tracks: [threeClips()], ids: ['b'], ripple: false });
  assert.equal(plan.ripple, false);
  assert.equal(plan.moved.length, 0);
  assert.deepEqual(plan.ops, [{ op: 'remove', clip: 'b' }]);
});

test('非主轨删除不触发波纹（副轨只有 remove）', () => {
  const tracks = [track(0, [{ id: 'a', at: 0 }, { id: 'b', at: 2 }]), track(1, [{ id: 'v1', at: 0, time: [0, 2] }, { id: 'v2', at: 2, time: [0, 2] }])];
  // track(0) 是上层（音频口味），track(1) 是最低画面轨 → 主轨是 1；
  // 删上层 0 号轨的片段不该动任何人。
  const plan = planRippleDelete({ tracks, ids: ['a'] });
  assert.equal(plan.mainTrack, 1);
  assert.equal(plan.moved.length, 0);
  assert.deepEqual(plan.ops, [{ op: 'remove', clip: 'a' }]);
});

test('锁轨：删锁轨片段 → 拒绝、零 Op、说明原因', () => {
  const tracks = [track(0, [{ id: 'a' }, { id: 'b', at: 2 }], { locked: true })];
  const plan = planRippleDelete({ tracks, ids: ['a'] });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'LOCKED');
  assert.deepEqual(plan.ops, []);
  assert.deepEqual(plan.skippedLocked, [{ id: 'a', track: 0 }]);
  assert.match(String(plan.message), /锁定/);
});

test('锁轨 + 未锁片段混选：只删能删的，锁的进 skippedLocked', () => {
  const tracks = [track(0, [{ id: 'a' }], { locked: true }), track(1, [{ id: 'b', at: 2, time: [0, 2] }])];
  const plan = planRippleDelete({ tracks, ids: ['a', 'b'] });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.removed, ['b']);
  assert.deepEqual(plan.skippedLocked, [{ id: 'a', track: 0 }]);
  assert.match(String(plan.message), /因锁定跳过 1 个/);
});

test('波纹删除：多条被删时位移按累计长度算', () => {
  const tracks = [
    track(0, [
      { id: 'a', at: 0, time: [0, 2] },
      { id: 'b', at: 2, time: [0, 2] },
      { id: 'c', at: 4, time: [0, 2] },
      { id: 'd', at: 6, time: [0, 2] },
    ]),
  ];
  const plan = planRippleDelete({ tracks, ids: ['b', 'c'] });
  assert.deepEqual(plan.moved, [{ id: 'd', from: 6, to: 2 }]);
});

test('波纹删除：speed 影响位移长度（2x 的 2 秒源 = 占用 1 秒）', () => {
  const tracks = [
    track(0, [
      { id: 'a', at: 0, time: [0, 2], speed: 2 },
      { id: 'b', at: 1, time: [0, 4] },
    ]),
  ];
  const plan = planRippleDelete({ tracks, ids: ['a'] });
  assert.deepEqual(plan.moved, [{ id: 'b', from: 1, to: 0 }]);
});

test('波纹插入：插入点之后的右移，之前的原地不动', () => {
  const tracks = [
    track(0, [
      { id: 'a', at: 0, time: [0, 2] },
      { id: 'b', at: 2, time: [0, 2] },
      { id: 'c', at: 4, time: [0, 2] },
    ]),
  ];
  const plan = planRippleInsert({ tracks, track: 0, at: 2, length: 1 });
  assert.deepEqual(plan.moved, [
    { id: 'b', from: 2, to: 3 },
    { id: 'c', from: 4, to: 5 },
  ]);
  assert.deepEqual(plan.ops, [
    { op: 'props', edits: [{ clip: 'b', prop: 'at', value: 3 }] },
    { op: 'props', edits: [{ clip: 'c', prop: 'at', value: 5 }] },
  ]);
});

test('波纹插入：锁轨不移动（也不报错）', () => {
  const plan = planRippleInsert({ tracks: [track(0, [{ id: 'a', at: 0 }], { locked: true })], track: 0, at: 0, length: 1 });
  assert.deepEqual(plan, { ops: [], moved: [] });
});

test('吸附目标：零点 + 播放头 + 其它片段边界，排除自己', () => {
  const tracks = [
    track(0, [
      { id: 'a', at: 0, time: [0, 2] },
      { id: 'b', at: 2, time: [0, 2] },
    ]),
  ];
  assert.deepEqual(collectSnapTargets({ tracks, playhead: 3.5, excludeIds: ['b'] }), [0, 2, 3.5]);
});

test('吸附：阈值内落到目标，阈值外原样返回', () => {
  const targets = [0, 2, 4];
  assert.deepEqual(snapSeconds({ value: 2.05, targets, tolerance: 0.1 }), { value: 2, target: 2, distance: 0.05 });
  assert.deepEqual(snapSeconds({ value: 2.2, targets, tolerance: 0.1 }), {
    value: 2.2,
    target: null,
    distance: 0.2,
  });
  assert.equal(snapSeconds({ value: 1, targets, tolerance: 0 }).target, null);
});

test('spanOf 与 UI 的 clipSpan 逐条一致（两处口径不许分叉）', () => {
  const cases = [
    { at: 0, time: [0, 2] },
    { at: 3.5, time: [1, 5], speed: 2 },
    { at: 0.333, time: [0, 1.001] },
    { at: 2, time: [0, 4], speed: 0.5 },
  ];
  for (const clip of cases) {
    assert.deepEqual(spanOf(clip), clipSpan(clip), JSON.stringify(clip));
  }
});
