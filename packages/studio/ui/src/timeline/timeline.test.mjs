/**
 * M5-WP07 验收 A6：时间线像素 → 秒 → Op 的换算表（30fps 与 29.97 两组）。
 * 另附手势 → Op 的形状检查，保证 UI 只发合同里的 Op。
 * 跑法：node --test packages/studio/ui/src/timeline/timeline.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from '../../../../film-core/film-doc.mjs';
import { createEditorState } from './editor-state.mjs';
import { clipSpan, pixelsPerFrame, pixelsToSeconds, snapSecondsToFrame, sourceTimeAt } from './geometry.mjs';
import { planDelete, planLink, planMove, planPaste, planSplit, planTrim, planUnlink } from './plan.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..', '..');
const fixtureText = readFileSync(join(repo, 'tests', 'fixtures', 'main', 'film-basic.html'), 'utf8');
const doc = /** @type {any} */ (parse(fixtureText).doc);

const FPS_30 = { num: 30, den: 1 };
const FPS_2997 = { num: 30000, den: 1001 };
const ZOOM = 50; // 50 px = 1 秒

/** @param {string} id */
function clipOf(id) {
  for (const track of doc.tracks) {
    const clip = track.clips.find((/** @type {any} */ item) => item.id === id);
    if (clip !== undefined) return clip;
  }
  throw new Error(`fixture 里没有 ${id}`);
}

test('A6 像素 → 秒 → Op：30fps 与 29.97 两组换算表', () => {
  // 表一：手势 → 秒（与帧率无关，缩放 50px/s）
  const secondsTable = [
    { gesture: '拖动 +100px', px: 100, expected: 2 },
    { gesture: '拖动 -30px', px: -30, expected: -0.6 },
    { gesture: '右手柄 +25px', px: 25, expected: 0.5 },
    { gesture: '左手柄 +50px', px: 50, expected: 1 },
    { gesture: '切刀落点 90px', px: 90, expected: 1.8 },
  ];
  for (const row of secondsTable) {
    assert.equal(pixelsToSeconds(row.px, ZOOM), row.expected, row.gesture);
  }

  // 表二：同一批秒数在两种帧率下的帧号（floor = 当前落在第几帧）与吸附结果（nearest = 拖到最近帧）
  const frameTable = [
    { seconds: 2, fps30: 60, fps2997: 59, snapped2997: 60 },
    { seconds: 0.5, fps30: 15, fps2997: 14, snapped2997: 15 },
    { seconds: 1, fps30: 30, fps2997: 29, snapped2997: 30 },
    { seconds: 1.8, fps30: 54, fps2997: 53, snapped2997: 54 },
  ];
  for (const row of frameTable) {
    const frame30 = Math.round((row.seconds * FPS_30.num) / FPS_30.den);
    const frame2997 = Math.floor((row.seconds * FPS_2997.num) / FPS_2997.den);
    assert.equal(frame30, row.fps30, `${row.seconds}s @30`);
    assert.equal(frame2997, row.fps2997, `${row.seconds}s @29.97`);
    const snapped = snapSecondsToFrame(row.seconds, FPS_2997);
    assert.equal(Math.round((snapped * FPS_2997.num) / FPS_2997.den), row.snapped2997, `${row.seconds}s 吸附 @29.97`);
  }

  // 一帧在两种帧率下的像素宽度
  assert.ok(Math.abs(pixelsPerFrame(FPS_30, ZOOM) - 1.6667) < 0.001);
  assert.ok(Math.abs(pixelsPerFrame(FPS_2997, ZOOM) - 1.6687) < 0.001);
});

test('A6b 拖动/裁剪/切分产出的 Op 形状正确（只发合同 Op）', () => {
  const c2 = clipOf('c2');
  assert.equal(clipSpan(c2).start, 4);

  const moved = planMove({ clip: c2, track: 0, deltaPx: 50, pxPerSecond: ZOOM });
  assert.deepEqual(moved.ops, [{ op: 'props', edits: [{ clip: 'c2', prop: 'at', value: 5 }] }]);
  assert.deepEqual(moved.placed.c2, { start: 5, end: 8, track: 0 });

  const trimmed = planTrim({ clip: c2, track: 0, edge: 'end', deltaPx: 25, pxPerSecond: ZOOM, fps: FPS_30 });
  assert.deepEqual(trimmed.ops, [{ op: 'props', edits: [{ clip: 'c2', prop: 'end', value: 3.5 }] }]);

  const head = planTrim({ clip: c2, track: 0, edge: 'start', deltaPx: 50, pxPerSecond: ZOOM, fps: FPS_30 });
  // 左手柄右移 1s：源内起点 +1，时间线 at 同步 +1，画面内容不动
  assert.deepEqual(head.ops[0].edits, [
    { clip: 'c2', prop: 'start', value: 1 },
    { clip: 'c2', prop: 'at', value: 5 },
  ]);

  // c1: at 0, time 0..4，在 1.8s 处切
  const split = planSplit({ clip: clipOf('c1'), track: 0, at: 1.8, fps: FPS_30 });
  assert.equal(split.ops[0].op, 'split');
  assert.equal(split.ops[0].at, 1.8);
  assert.deepEqual(split.ops[0].left, { end: 1.8 });
  assert.deepEqual(split.ops[0].right, { start: 1.8, at: 1.8 });

  // 源内换算：2x 速度下，时间线 1s 对应源内 2s
  assert.equal(sourceTimeAt({ at: 0, time: [0, 4], speed: 2 }, 1), 2);
});

test('A6c 删除/链接/粘贴：链接组一起删，粘贴不带原 id', () => {
  const linkedDoc = /** @type {any} */ (parse(
    '<html><head><meta name="viewport" content="width=1280, height=720"></head><body>' +
      '<section><video id="v1" src="a.mp4#t=0,2" at="0" data-link="g1"></video></section>' +
      '<section><audio id="a1" src="a.mp4#t=0,2" at="0" data-link="g1"></audio></section>' +
      '</body></html>',
  ).doc);

  const clips = linkedDoc.tracks.flatMap((/** @type {any} */ track) => track.clips);
  const removed = planDelete({ clips });
  assert.deepEqual(removed.ops.map((/** @type {any} */ op) => op.clip), ['v1', 'a1']);
  assert.deepEqual(removed.placed, { v1: null, a1: null });

  const linked = planLink({ ids: ['v1', 'a1'], group: 'g2' });
  assert.equal(linked.ops[0].edits.length, 2);
  assert.equal(planUnlink({ ids: ['a1'] }).ops[0].edits[0].value, null);

  const pasted = planPaste({ clips: [clips[0]], at: 3 });
  assert.equal(pasted.ops[0].op, 'insert');
  assert.equal(pasted.ops[0].at, 3);
  assert.equal(pasted.ops[0].clip.id, `${clips[0].id}-copy`, '粘贴要换一个 id，不能复用原片段');
});

test('A8 前半：UI 乐观应用后失败要能回滚（editor-state）', () => {
  const state = createEditorState({ value: doc, sourceHash: 'a'.repeat(64) });
  const before = JSON.stringify(state.value());

  const preview = state.preview([{ op: 'props', edits: [{ clip: 'c1', prop: 'volume', value: 0.2 }] }]);
  assert.equal(preview.ok, true);
  assert.equal(state.pending(), true);
  assert.notEqual(JSON.stringify(state.value()), before);

  // 落盘失败 → 回滚到已承认的版本
  state.rollback();
  assert.equal(state.pending(), false);
  assert.equal(JSON.stringify(state.value()), before);
  assert.equal(state.sourceHash(), 'a'.repeat(64));

  // 非法 Op 不改变状态
  const bad = state.preview([{ op: 'set', clip: 'c1', field: 'nope', value: 1 }]);
  assert.equal(bad.ok, false);
  assert.equal(/** @type {any} */ (bad.error).code, 'INVALID');
  assert.equal(state.pending(), false);
});
