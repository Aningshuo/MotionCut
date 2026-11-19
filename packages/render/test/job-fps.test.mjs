// @ts-nocheck —— 测试以运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * P44：`export start` 的作业管线改走有理帧率。
 *
 * 这里钉四件事：
 * 1. `frameTimes` 在整数帧率下与老表达式逐位相同（30fps 的帧内容不能漂）；
 * 2. 分数帧率下帧时间落在 `i×den/num` 上，不累加浮点；
 * 3. `specFpsProblem` / `validateSpec` 对非法帧率给 `INVALID_FPS`；
 * 4. 非法帧率**不建作业**（`enqueue` 直接拒绝，队列里没有 jobId）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RenderQueue, specFpsProblem, validateSpec } from '../job.mjs';
import { frameTimes } from '../frames.mjs';

const NTSC = { num: 30000, den: 1001 };

test('P44：30fps 的 frameTimes 与老表达式（i/fps）逐位相同', () => {
  const legacy = Array.from({ length: 90 }, (_, i) => 1.5 + i / 30);
  assert.deepEqual(frameTimes({ startSec: 1.5, endSec: 4.5, fps: 30 }), legacy);
  assert.deepEqual(frameTimes({ startSec: 1.5, endSec: 4.5, fps: { num: 30, den: 1 } }), legacy);
});

test('P44：29.97 的 frameTimes 是 300 帧、每帧 i×1001/30000', () => {
  const times = frameTimes({ startSec: 0, endSec: 10, fps: NTSC });
  assert.equal(times.length, 300);
  assert.equal(times[0], 0);
  assert.equal(times[299], (299 * 1001) / 30000);
  assert.equal(times[1], 1001 / 30000);
});

test('P44：specFpsProblem 把非法帧率挡在外面', () => {
  assert.equal(specFpsProblem(undefined), null);
  assert.equal(specFpsProblem(30), null);
  assert.equal(specFpsProblem(29.97), null);
  assert.equal(specFpsProblem(23.976), null);
  for (const bad of [0, -1, 1000, 240, '29.97', '29.97.5', Number.NaN]) {
    assert.ok(typeof specFpsProblem(bad) === 'string', `expected a problem for ${String(bad)}`);
  }
});

test('P44：validateSpec 对非法帧率返回 INVALID_FPS（不再是 INVALID_RANGE）', () => {
  const base = {
    jobId: 'job-fps',
    projectId: 'proj',
    owner: 'SUB2',
    kind: 'video',
    range: [0, 1],
    outputDir: '/tmp/out',
    expectedHash: 'a'.repeat(64),
  };
  assert.equal(validateSpec({ ...base, fps: 29.97 }), null);
  const bad = validateSpec({ ...base, fps: 0 });
  assert.equal(bad?.error, 'INVALID_FPS');
  const str = validateSpec({ ...base, fps: '29.97.5' });
  assert.equal(str?.error, 'INVALID_FPS');
});

test('P44：非法帧率不建作业（队列里没有这个 jobId）', () => {
  const queue = new RenderQueue({
    resolveProject: () => '/tmp/proj',
    resolveFrameSource: () => ({ dir: '/tmp/frames', pattern: 'frame-%05d.png', width: 320, height: 180, fps: 30, durationSec: 1 }),
  });
  const result = queue.enqueue({
    jobId: 'job-bad-fps',
    projectId: 'proj',
    owner: 'SUB2',
    kind: 'video',
    range: [0, 1],
    fps: 0,
    audio: false,
    outputDir: '/tmp/out',
    expectedHash: 'a'.repeat(64),
  });
  assert.equal(result.error, 'INVALID_FPS');
  assert.equal(queue.has('job-bad-fps'), false);
});
