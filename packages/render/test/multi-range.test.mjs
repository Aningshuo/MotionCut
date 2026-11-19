/**
 * P36（B-SUB2-R18-018）：多段 `--range` 的拼接与帧对齐。
 *
 * 两条口径必须同时成立，所以两边都钉：
 * - **单段不变**：`a:b` 仍是 R21 语义（窗口长度任意小数、帧数 round(长度*fps)）；
 * - **多段帧对齐**：每段起止 `round(t*fps)`，段内帧数 = 起止帧之差，拼接后帧连续。
 *
 * 真实渲染的对照（p99、音频接缝）在 `scripts/r18-acceptance.mjs`，这里只测算术与计划。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parse } from '../../film-core/film-doc.mjs';
import { planFromFilm } from '../film-plan.mjs';
import { buildTimeline, frameTimeAt, normalizeRanges } from '../timeline-range.mjs';

const ROOT = new URL('../../../', import.meta.url).pathname;
const BARS = path.join(ROOT, 'tests/fixtures/media/bars-3s-720p30.mp4');
const TONE = path.join(ROOT, 'tests/fixtures/media/tone-1khz-3s.wav');

/** @type {string} */
let workDir;

async function ensureProject() {
  if (workDir) return workDir;
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-multi-range-'));
  await fs.mkdir(path.join(workDir, 'assets'), { recursive: true });
  await fs.copyFile(BARS, path.join(workDir, 'assets/bars.mp4'));
  await fs.copyFile(TONE, path.join(workDir, 'assets/tone.wav'));
  return workDir;
}

/** @returns {Promise<any>} */
async function docOf() {
  const { doc, diagnostics } = parse(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=1280, height=720"></head><body>
<section id="picture"><video id="pic" src="assets/bars.mp4#t=0,3" at="0" muted size="1280x720"></video></section>
<section id="voice"><audio id="tone" src="assets/tone.wav#t=0,3" at="0" volume="1"></audio></section>
</body></html>`,
    { path: 'film.html' },
  );
  assert.equal(doc === null, false, `parse failed: ${diagnostics.map((d) => d.message).join('; ')}`);
  return doc;
}

// ---- 算术层 -------------------------------------------------------------

test('P36：normalizeRanges 缺省整片；越界/倒序/空段一律 INVALID_RANGE', () => {
  assert.deepEqual(normalizeRanges(undefined, 8), [[0, 8]]);
  assert.deepEqual(normalizeRanges([[2, 4], [6, 8]], 8), [[2, 4], [6, 8]]);

  /** @type {Array<Array<[number, number]>>} */
  const badCases = [[[2, 9]], [[3, 2]], [[-1, 2]], [[2, 2]]];
  for (const bad of badCases) {
    assert.throws(
      () => normalizeRanges(bad, 8),
      (/** @type {any} */ err) => err.code === 'INVALID_RANGE',
      `expected INVALID_RANGE for ${JSON.stringify(bad)}`,
    );
  }
  assert.throws(() => normalizeRanges([], 8), (/** @type {any} */ err) => err.code === 'INVALID_RANGE');
});

test('P36：单段保持 R21 口径（帧数 round(长度*fps)、起点就是 a、不做帧对齐）', () => {
  const timeline = buildTimeline([[2, 4]], 30);
  assert.equal(timeline.frames, 60);
  assert.equal(timeline.outputDuration, 2);
  assert.equal(timeline.frameAligned, false);
  assert.equal(timeline.segments.length, 1);
  assert.equal(timeline.segments[0]?.frameStartSec, 2);
  assert.equal(frameTimeAt(timeline.segments, 30, 0), 2);
  assert.equal(frameTimeAt(timeline.segments, 30, 15), 2.5);
  assert.equal(frameTimeAt(timeline.segments, 30, 59), Number((2 + 59 / 30).toFixed(6)));

  // 非整帧边界：单段仍是 60 帧、首帧 2.010s（多段才会落帧格）
  const frac = buildTimeline([[2.01, 4.02]], 30);
  assert.equal(frac.frames, 60);
  assert.equal(frac.segments[0]?.frameStartSec, 2.01);
});

test('P36：多段按 round(t*fps) 对齐，段内帧数=起止帧之差，输出时长=总帧数/fps', () => {
  const timeline = buildTimeline([[2, 4], [6, 8]], 30);
  assert.equal(timeline.frameAligned, true);
  assert.equal(timeline.frames, 120);
  assert.equal(timeline.outputDuration, 4);
  assert.deepEqual(
    timeline.segments.map((s) => ({ startFrame: s.startFrame, endFrame: s.endFrame, frames: s.frames, outStartFrame: s.outStartFrame })),
    [
      { startFrame: 60, endFrame: 120, frames: 60, outStartFrame: 0 },
      { startFrame: 180, endFrame: 240, frames: 60, outStartFrame: 60 },
    ],
  );
  assert.equal(frameTimeAt(timeline.segments, 30, 0), 2);
  assert.equal(frameTimeAt(timeline.segments, 30, 59), Number((2 + 59 / 30).toFixed(6)));
  assert.equal(frameTimeAt(timeline.segments, 30, 60), 6);
  assert.equal(frameTimeAt(timeline.segments, 30, 119), Number((6 + 59 / 30).toFixed(6)));
});

test('P36：小数边界在多段里落到帧格（2.01:4.02 → 60..121，61 帧）', () => {
  const timeline = buildTimeline([[2.01, 4.02], [6, 8]], 30);
  const first = timeline.segments[0];
  assert.ok(first);
  assert.equal(first.startFrame, 60);
  assert.equal(first.endFrame, 121);
  assert.equal(first.frames, 61);
  assert.equal(first.frameStartSec, 2);
  assert.equal(first.end, Number((121 / 30).toFixed(6)));
});

test('P36：一段短于一帧 → INVALID_RANGE（不静默产出 0 帧）', () => {
  assert.throws(
    () => buildTimeline([[2.001, 2.002], [6, 8]], 30),
    (/** @type {any} */ err) => err.code === 'INVALID_RANGE' && /shorter than one frame/.test(err.message),
  );
});

test('P36：顺序就是拼接顺序（6:8,2:4 与 2:4,6:8 的段表相反）', () => {
  const a = buildTimeline([[2, 4], [6, 8]], 30).segments.map((s) => s.startFrame);
  const b = buildTimeline([[6, 8], [2, 4]], 30).segments.map((s) => s.startFrame);
  assert.deepEqual(a, [60, 180]);
  assert.deepEqual(b, [180, 60]);
});

// ---- 计划层 -------------------------------------------------------------

test('P36：多段计划把片段切成两段，at 依次累加，音频接缝补 2ms 斜坡', async () => {
  const root = await ensureProject();
  const plan = await planFromFilm(await docOf(), { projectRoot: root, fps: 30, ranges: [[0, 1], [2, 3]] });

  assert.equal(plan.frames, 60);
  assert.equal(plan.outputDuration, 2);
  assert.deepEqual(plan.ranges, [[0, 1], [2, 3]]);
  assert.equal(plan.frameAligned, true);

  assert.deepEqual(
    plan.visualClips.map((/** @type {any} */ clip) => ({ at: clip.at, time: clip.time })),
    [
      { at: 0, time: [0, 1] },
      { at: 1, time: [2, 3] },
    ],
  );
  // 画面接缝是硬切：不加 alpha 斜坡（2ms 落在 33ms 的一帧上会闪黑）
  assert.deepEqual(plan.visualClips.map((/** @type {any} */ clip) => clip.fade), [[0, 0], [0, 0]]);

  assert.ok(plan.audioMix);
  assert.equal(plan.audioMix.duration, 2);
  assert.deepEqual(
    plan.audioMix.clips.map((/** @type {any} */ clip) => ({ at: clip.at, time: clip.time, fade: clip.fade })),
    [
      { at: 0, time: [0, 1], fade: [0, 0.002] },
      { at: 1, time: [2, 3], fade: [0.002, 0] },
    ],
  );
});

test('P36：单段计划与 R21 语义一致（fade 不加接缝斜坡、at 从 0 起）', async () => {
  const root = await ensureProject();
  const plan = await planFromFilm(await docOf(), { projectRoot: root, fps: 30, range: [0, 1] });
  assert.equal(plan.frames, 30);
  assert.equal(plan.outputDuration, 1);
  assert.deepEqual(plan.visualClips.map((/** @type {any} */ clip) => clip.fade), [[0, 0]]);
  assert.deepEqual(plan.audioMix?.clips.map((/** @type {any} */ clip) => clip.fade), [[0, 0]]);
  assert.equal(plan.frameAligned, false);
});

test('P36：多段越界 → INVALID_RANGE；ranges 优先于 range', async () => {
  const root = await ensureProject();
  const doc = await docOf();
  await assert.rejects(
    planFromFilm(doc, { projectRoot: root, fps: 30, ranges: [[0, 1], [2, 5]] }),
    (/** @type {any} */ err) => err.code === 'INVALID_RANGE',
  );
  const plan = await planFromFilm(doc, { projectRoot: root, fps: 30, range: [0, 3], ranges: [[0, 1], [2, 3]] });
  assert.deepEqual(plan.ranges, [[0, 1], [2, 3]], 'ranges 优先');
});

test('P36：帧号 → 原片时间在整段上单调且首尾对得上', async () => {
  const root = await ensureProject();
  const plan = await planFromFilm(await docOf(), { projectRoot: root, fps: 30, ranges: [[0, 1], [2, 3]] });
  const times = plan.segments.length === 0
    ? []
    : Array.from({ length: plan.frames }, (_, index) => frameTimeAt(plan.segments, 30, index));
  assert.equal(times[0], 0);
  assert.equal(times[29], Number((29 / 30).toFixed(6)));
  assert.equal(times[30], 2);
  assert.equal(times[59], Number((2 + 29 / 30).toFixed(6)));
  for (let i = 1; i < times.length; i += 1) {
    assert.ok((times[i] ?? 0) > (times[i - 1] ?? 0) || i === 30, `frame ${i} must advance`);
  }
});
