/**
 * P28 作业句柄：输出占用、进度事件、取消。
 *
 * 这些用例全部是**纯进程内**的（不需要 ffmpeg / 浏览器），所以能在任何机器上跑；
 * 真跑一遍导出（进度、真停 ffmpeg、取消后重跑）在
 * `.local-runs/sub2/runs/R14/evidence/p28-job-control.json` 里，那是证据不是单测。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ExportJobError,
  activeOutputClaims,
  createExportJob,
  lockPathFor,
  runExportJob,
} from '../export-job.mjs';

/** @returns {Promise<string>} */
async function tempOut() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-job-test-'));
  return path.join(dir, 'out.mp4');
}

test('P28：同一输出路径第二个作业被拒（EXPORT_OUTPUT_BUSY），释放后可再拿', async () => {
  const out = await tempOut();
  const first = createExportJob({ outputPath: out });
  try {
    assert.throws(
      () => createExportJob({ outputPath: out }),
      (/** @type {any} */ err) => err instanceof ExportJobError && err.code === 'EXPORT_OUTPUT_BUSY',
    );
    // 锁文件真的落在输出旁边：跨进程也能互相看见
    const lock = await fs.readFile(lockPathFor(out), 'utf8');
    assert.equal(JSON.parse(lock).jobId, first.id);
    assert.ok(activeOutputClaims().some((claim) => claim.path === out));
  } finally {
    first.release();
  }
  assert.equal(await fs.stat(lockPathFor(out)).then(() => true, () => false), false);
  // 放掉之后同一条路径可以再拿
  const second = createExportJob({ outputPath: out });
  second.release();
});

test('P28：陈旧锁（持有进程已不在）会被清掉重试，不会把路径永久占住', async () => {
  const out = await tempOut();
  await fs.mkdir(path.dirname(out), { recursive: true });
  // 999999 不在进程表里：kill(pid,0) 抛 ESRCH
  await fs.writeFile(lockPathFor(out), `${JSON.stringify({ pid: 999999, jobId: 'ghost', at: new Date().toISOString() })}\n`);
  const job = createExportJob({ outputPath: out });
  job.release();
  assert.equal(await fs.stat(lockPathFor(out)).then(() => true, () => false), false);
});

test('P28：真占用的锁（活着的 pid）不会被当成陈旧锁放行', async () => {
  const out = await tempOut();
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(
    lockPathFor(out),
    `${JSON.stringify({ pid: process.pid, jobId: 'alive', at: new Date().toISOString() })}\n`,
  );
  assert.throws(
    () => createExportJob({ outputPath: out }),
    (/** @type {any} */ err) => err.code === 'EXPORT_OUTPUT_BUSY' && err.holder?.jobId === 'alive',
  );
  await fs.unlink(lockPathFor(out));
});

test('P28：进度事件 planning → rendering → done，帧号与总帧数都在，收尾后不再发', async () => {
  const out = await tempOut();
  const job = createExportJob({ outputPath: out });
  /** @type {any[]} */
  const seen = [];
  const off = job.on((event) => seen.push(event));
  try {
    job.progress({ phase: 'planning', frame: 0, totalFrames: 240 });
    job.progress({ phase: 'rendering', stage: 'capture', frame: 1, totalFrames: 240 });
    job.progress({ phase: 'rendering', stage: 'encode', frame: 120, totalFrames: 240 });
    job.progress({ phase: 'muxing', totalFrames: 240 });
    job.finish({ frames: 240, path: out });
  } finally {
    off();
    job.release();
  }
  assert.deepEqual(
    seen.map((event) => `${event.type}:${event.phase ?? '-'}`),
    ['progress:planning', 'progress:rendering', 'progress:rendering', 'progress:muxing', 'progress:done', 'done:-'],
  );
  const rendering = seen.filter((event) => event.phase === 'rendering');
  assert.deepEqual(rendering.map((event) => event.frame), [1, 120]);
  assert.equal(seen.at(-2).totalFrames, 240);
  assert.ok(seen.every((event) => Number.isFinite(event.elapsedMs)), 'elapsedMs 必须是数字');
  assert.equal(job.state, 'succeeded');
  // 收尾之后进度一律丢弃：宿主不该在 done 之后还看到 rendering
  assert.equal(job.progress({ phase: 'rendering', frame: 241, totalFrames: 240 }), false);
  assert.equal(await job.done.then((result) => result.frames), 240);
});

test('P28/P30：cancel() 只置位不杀进程，signal 置位 / 状态 cancelled / 锁仍然握着（等终态再放）', async () => {
  const out = await tempOut();
  const job = createExportJob({ outputPath: out });
  /** @type {any[]} */
  const seen = [];
  job.on((event) => seen.push(event));
  assert.equal(job.cancel('test'), true);
  assert.equal(job.cancel('again'), false, 'cancel 必须幂等');
  assert.equal(job.signal.aborted, true);
  assert.equal(job.state, 'cancelled');
  assert.equal(job.cancelReason, 'test');
  assert.ok(seen.some((event) => event.type === 'cancel' && event.reason === 'test'));
  // 取消后进度不再发
  assert.equal(job.progress({ phase: 'rendering', frame: 3, totalFrames: 10 }), false);
  // P30：`done` **不在 cancel 时结算**——此时 ffmpeg 可能还在 SIGTERM 宽限期里，
  // 提前结算会让调用方以为「已经可以重跑同一路径了」。锁同理，仍要握着。
  assert.equal(await fs.stat(lockPathFor(out)).then(() => true, () => false), true);
  const settled = await Promise.race([
    job.done.then(() => 'resolved', () => 'rejected'),
    new Promise((resolve) => setTimeout(() => resolve('pending'), 50)),
  ]);
  assert.equal(settled, 'pending');
  // 终态由 fail/finish 给出：取消后的底层错误一定走 fail
  job.fail(new ExportJobError('EXPORT_CANCELLED', 'export cancelled (test)'));
  await assert.rejects(job.done, (/** @type {any} */ err) => err.code === 'EXPORT_CANCELLED');
  assert.equal(await fs.stat(lockPathFor(out)).then(() => true, () => false), false);
});

test('P30：取消落在「工作已完成」之后 → finish 照常成功、记 cancelTooLate、锁必须释放', async () => {
  const out = await tempOut();
  const job = createExportJob({ outputPath: out });
  /** @type {any[]} */
  const seen = [];
  job.on((event) => seen.push(event));
  // 复现 R14 报的窗口：muxing 已完成、文件已 rename，SIGINT 才到
  job.progress({ phase: 'muxing', totalFrames: 240 });
  job.cancel('sigint');
  /** @type {any} */
  const result = { frames: 240, path: out, bytes: 1, sha256: 'deadbeef' };
  job.finish(result);
  assert.equal(job.state, 'succeeded');
  assert.equal(job.cancelTooLate, true);
  assert.equal(result.cancelTooLate, true, '结果对象也要带一刀（CLI --json 读的是它）');
  // done 进度不能被状态检查吃掉：宿主会看到 cancel 之后还有 done
  assert.deepEqual(
    seen.map((event) => `${event.type}:${event.phase ?? '-'}`),
    ['progress:muxing', 'cancel:-', 'progress:done', 'done:-'],
  );
  assert.equal(seen.at(-1).cancelTooLate, true);
  assert.equal((await job.done).frames, 240);
  // 关键断言：锁没了。以前这里会留下 `<out>.opencut-lock`
  assert.equal(await fs.stat(lockPathFor(out)).then(() => true, () => false), false);
});

test('P30：取消后 finish/fail 都幂等，第二次调用不改状态、不重复放锁', async () => {
  const out = await tempOut();
  const job = createExportJob({ outputPath: out });
  job.cancel('once');
  job.finish({ frames: 1 });
  job.finish({ frames: 2 });
  job.fail(new Error('late'));
  assert.equal(job.state, 'succeeded');
  assert.equal((await job.done).frames, 1);
});

test('P28：runExportJob 把「执行体因 abort 抛错」翻成 EXPORT_CANCELLED，并释放锁', async () => {
  const out = await tempOut();
  const job = createExportJob({ outputPath: out });
  const running = runExportJob(job, async () => {
    job.cancel('host');
    throw new Error('ffmpeg killed');
  });
  await assert.rejects(running, (/** @type {any} */ err) => err.code === 'EXPORT_CANCELLED');
  assert.equal(await fs.stat(lockPathFor(out)).then(() => true, () => false), false);
});

test('P28：未知阶段要报错，不能悄悄当成 progress 发出去', async () => {
  const out = await tempOut();
  const job = createExportJob({ outputPath: out });
  try {
    assert.throws(
      () => job.progress({ phase: /** @type {any} */ ('encoding') }),
      (/** @type {any} */ err) => err.code === 'EXPORT_JOB_STATE',
    );
  } finally {
    job.release();
  }
});
