// @ts-nocheck —— 纯函数，不 spawn、不碰磁盘
/**
 * P50：同一个 outputDir 的所有权判定 + 回收白名单。
 *
 * 这一组钉的是**判据**，不是渲染：
 * 1. 锁里（或 job.json 里）活着的**别人** → busy；
 * 2. 同一个 jobId 重跑 / pid 已死 / 上一作业终态 → proceed（目录可以复用）；
 * 3. 回收只删中间件白名单，产物与账本一个都不碰。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isIntermediate, resolveOwnership } from '../port.mjs';

/** 只把这些 pid 当成活的，别的都算死了 —— 免得测试依赖真实进程表 */
const aliveSet = (...pids) => (pid) => pids.includes(pid);

test('P50 所有权：别人活着 → busy，detail 用得上 jobId+pid', () => {
  const lock = { jobId: 'A', pid: 4242, at: 1 };
  assert.deepEqual(resolveOwnership(lock, {}, 'B', aliveSet(4242)), { action: 'busy', jobId: 'A', pid: 4242 });
});

test('P50 所有权：同一个 jobId 重跑是允许的（覆盖自己的锁）', () => {
  assert.deepEqual(resolveOwnership({ jobId: 'A', pid: 4242 }, {}, 'A', aliveSet(4242)), { action: 'proceed' });
});

test('P50 所有权：pid 已死 = stale，可以开工', () => {
  assert.deepEqual(resolveOwnership({ jobId: 'A', pid: 4242 }, {}, 'B', aliveSet()), { action: 'proceed' });
});

test('P50 所有权：没有锁时看 job.json（running + 活 pid 一样挡）', () => {
  const job = { jobId: 'A', state: 'running', pid: 4242 };
  assert.deepEqual(resolveOwnership(null, job, 'B', aliveSet(4242)), { action: 'busy', jobId: 'A', pid: 4242 });
  assert.deepEqual(resolveOwnership(null, { ...job, state: 'done' }, 'B', aliveSet(4242)), { action: 'proceed' });
});

test('P50 所有权：锁 stale 但 job.json 里的进程还活着 → 仍然 busy', () => {
  const lock = { jobId: 'A', pid: 111, at: 1 };
  const job = { jobId: 'A', state: 'waiting', pid: 4242 };
  assert.deepEqual(resolveOwnership(lock, job, 'B', aliveSet(4242)), { action: 'busy', jobId: 'A', pid: 4242 });
});

test('P50 所有权：空目录 / 旧格式锁（没有 pid）都能开工', () => {
  assert.deepEqual(resolveOwnership(null, {}, 'B', aliveSet(4242)), { action: 'proceed' });
  assert.deepEqual(resolveOwnership({ jobId: 'A', at: 1 }, {}, 'B', aliveSet(4242)), { action: 'proceed' });
});

test('P50 回收白名单：中间件删、产物与账本留', () => {
  for (const name of ['a.video.partial.mp4', 'job.lock', 'worker.pid', 'cancel.requested', 'frames', 'x.opencut-lock']) {
    assert.equal(isIntermediate(name), true, name);
  }
  for (const name of [
    'job.mp4',
    'job.mov',
    'job.webm',
    'job.vtt',
    'subtitles.ass',
    'spec.json',
    'job.json',
    'events.jsonl',
    'frame-000001.png',
  ]) {
    assert.equal(isIntermediate(name), false, name);
  }
});
