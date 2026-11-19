// @ts-nocheck
// 这几条用例故意注入受控 runner（`any` 满天飞）：验的是接线与状态回写，不是类型形状。
// 与 export-queue.test.mjs 同一口径；产品模块仍由 tsc 严格检查。
/**
 * M70：导出作业接渲染调度器（B-MAIN-R30-034）。
 *
 * 这些用例**不跑 ffmpeg**：`exportJob.start()` 走真实状态机与真实锁，渲染链由注入的
 * 受控 runner 代替；队列是真的 `packages/render/scheduler.mjs`。这样能精确盯住：
 *
 *   1. 入队与回写（同一时刻只有一份状态：队列里就是这批导出）
 *   2. 并发上限 / 排队 / 队列位置
 *   3. 取消排队（立即、不产生输出）与取消运行（abort、槽位释放）
 *   4. 崩溃恢复：重启后 `failed(interrupted)`，不重跑，半成品目录被清
 *   5. 失败重试不重复入队
 *   6. HTTP 面 `GET /api/render/queue` 与 `/api/export` 同源
 */

import assert from 'node:assert/strict';
import fssync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createExportJobs } from '../export-job.mjs';
import { createRenderQueue } from '../render-queue.mjs';
import { startStudio } from '../studio-server.mjs';

const sleep = (/** @type {number} */ ms) => new Promise((done) => setTimeout(done, ms));

/** 异步条件轮询（要发 HTTP 用这个）。 */
async function waitForAsync(/** @type {() => Promise<boolean>} */ predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if ((await predicate()) === true) return true;
    await sleep(10);
  }
  return false;
}

/** @param {() => boolean} predicate */
async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate() === true) return true;
    await sleep(10);
  }
  return false;
}

/** 每个用例一个临时「工程」（作业入队就要占真实的输出锁）。 */
async function tempProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-m70-'));
  await fs.mkdir(path.join(dir, '.film'), { recursive: true });
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'film.html'),
    '<!doctype html><html><head><meta charset="utf-8"><title>m70</title></head><body></body></html>',
    'utf8',
  );
  return dir;
}

/**
 * 受控 runner：默认睡 ms 毫秒；可选闸门；取消时按 handle.signal 立刻收尾。
 * @param {{ms?: number, gate?: {wait: (job: any) => Promise<void>}, onRun?: (job: any) => void}} [options]
 */
function makeRunner(options = {}) {
  /** @type {{calls: string[], aborted: string[], live: number, peak: number}} */
  const state = { calls: [], aborted: [], live: 0, peak: 0 };
  /** @type {(job: any, doc: any, input: any) => Promise<any>} */
  const runner = async (job, doc, input) => {
    state.calls.push(job.id);
    state.live += 1;
    state.peak = Math.max(state.peak, state.live);
    if (typeof options.onRun === 'function') options.onRun(job);
    const signal = job.handle.signal;
    const aborted = new Promise((resolve) => {
      if (signal.aborted) resolve('aborted');
      else signal.addEventListener('abort', () => resolve('aborted'), { once: true });
    });
    try {
      if (options.gate !== undefined) {
        await Promise.race([options.gate.wait(job), aborted]);
      } else {
        await Promise.race([sleep(options.ms ?? 20), aborted]);
      }
      if (signal.aborted) {
        state.aborted.push(job.id);
        const error = /** @type {any} */ (new Error('导出已取消'));
        error.code = 'CANCELLED';
        throw error;
      }
      job.percent = 1;
      job.stage = 'done';
      job.state = 'done';
      job.output = { path: `/tmp/${job.id}.mp4`, bytes: 1, sha256: 'x' };
      return { id: job.id, input };
    } finally {
      state.live -= 1;
    }
  };
  return { runner, state };
}

const doc = { tracks: [], stage: { w: 1280, h: 720 } };

/**
 * 建一套「队列 + 导出作业」接线（与 Studio 里同序）。
 * @param {{root: string, concurrency?: number, runner?: Function, partialDir?: string}} input
 */
async function wire(input) {
  const queue = createRenderQueue({
    root: input.root,
    concurrency: input.concurrency ?? 2,
    env: {},
    logger: () => {},
  });
  const jobs = createExportJobs({
    logger: () => {},
    partialDir: input.partialDir ?? queue.partialDir,
    ...(input.runner === undefined ? {} : { runner: input.runner }),
  });
  jobs.attachScheduler(queue);
  queue.setRunner((/** @type {any} */ job, /** @type {any} */ ctx) => jobs.runScheduled(job, ctx));
  // 调度器的 `ready` 里包含崩溃恢复（读 state.json）；没等它就入队会停在 queued（pump 还没开）。
  await queue.ready;
  return { queue, jobs };
}

/* ── A. 入队 / 回写 / 同源 ───────────────────────────────────────────── */

test('A1 入队：start() 把作业放进队列，两边的 id 与状态一致', async () => {
  const dir = await tempProject();
  const root = path.join(dir, 'queue');
  const { queue, jobs } = await wire({ root, concurrency: 1, runner: makeRunner({ gate: { wait: () => new Promise(() => {}) } }).runner });
  try {
    const started = jobs.start({ projectId: 'p1', projectDir: dir, doc });
    assert.equal(started.ok, true);
    const id = started.job.id;
    assert.equal(started.job.state, 'queued', '调度器派发前是 queued');
    await waitFor(() => jobs.status(id)?.state === 'running');
    assert.equal(jobs.status(id).state, 'running');
    const view = queue.status();
    assert.equal(view.concurrency, 1);
    assert.deepEqual(
      view.running.map((/** @type {any} */ item) => item.id),
      [id],
      '队列里 running 的就是这个导出',
    );
    assert.equal(view.completed, 0);
    assert.equal(view.failed, 0);
    await jobs.cancel(id);
    await queue.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('A2 成功回写：作业 done、队列 completed=1、running/queued 空', async () => {
  const dir = await tempProject();
  const root = path.join(dir, 'queue');
  const { runner } = makeRunner({ ms: 20 });
  const { queue, jobs } = await wire({ root, concurrency: 2, runner });
  try {
    const started = jobs.start({ projectId: 'p1', projectDir: dir, doc });
    assert.equal(await waitFor(() => jobs.status(started.job.id)?.state === 'done'), true);
    const view = queue.status();
    assert.equal(view.completed, 1);
    assert.equal(view.failed, 0);
    assert.deepEqual(view.running, []);
    assert.deepEqual(view.queued, []);
    await queue.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('A3 失败回写：作业 failed(MEDIA_MISSING)，队列 failed=1、不卡住后面的', async () => {
  const dir = await tempProject();
  const root = path.join(dir, 'queue');
  let failOnce = true;
  const runner = async (/** @type {any} */ job) => {
    if (failOnce) {
      failOnce = false;
      const error = /** @type {any} */ (new Error('假装素材缺失'));
      error.code = 'MEDIA_MISSING';
      throw error;
    }
    job.state = 'done';
    job.stage = 'done';
    job.percent = 1;
  };
  const { queue, jobs } = await wire({ root, concurrency: 1, runner });
  try {
    const bad = jobs.start({ projectId: 'p1', projectDir: dir, doc });
    const good = jobs.start({ projectId: 'p1', projectDir: dir, doc });
    assert.equal(await waitFor(() => jobs.status(bad.job.id)?.state === 'failed'), true);
    assert.equal(jobs.status(bad.job.id).error.code, 'MEDIA_MISSING');
    assert.equal(await waitFor(() => jobs.status(good.job.id)?.state === 'done'), true);
    const view = queue.status();
    assert.equal(view.failed, 1);
    assert.equal(view.completed, 1);
    assert.deepEqual(view.queued, []);
    await queue.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

/* ── B. 并发 / 排队 / 位置 ──────────────────────────────────────────── */

test('B1 并发上限 2：5 个作业峰值 ≤2，第三个起排队', async () => {
  const dir = await tempProject();
  const root = path.join(dir, 'queue');
  const { runner, state } = makeRunner({ ms: 60 });
  const { queue, jobs } = await wire({ root, concurrency: 2, runner });
  try {
    /** @type {string[]} */
    const ids = [];
    for (let index = 0; index < 5; index += 1) {
      const started = jobs.start({ projectId: `p${index}`, projectDir: dir, doc });
      assert.equal(started.ok, true);
      ids.push(started.job.id);
    }
    assert.equal(await waitFor(() => queue.status().running.length === 2), true, '前两个立刻占槽');
    const early = queue.status();
    assert.equal(early.queued.length, 3, '其余三个排队');
    assert.equal(await waitFor(() => jobs.list().every((/** @type {any} */ job) => job.state === 'done'), 5000), true);
    assert.equal(state.peak <= 2, true, `峰值 ${state.peak} 超过并发上限`);
    assert.equal(state.peak, 2);
    assert.equal(queue.status().completed, 5);
    await queue.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('B2 队列位置：第 3 个的 position 是 1（不是 3）', async () => {
  const dir = await tempProject();
  const root = path.join(dir, 'queue');
  const gate = { waits: new Map(), wait(job) { return new Promise((resolve) => this.waits.set(job.id, resolve)); } };
  const { runner } = makeRunner({ gate });
  const { queue, jobs } = await wire({ root, concurrency: 2, runner });
  try {
    const a = jobs.start({ projectId: 'p1', projectDir: dir, doc });
    const b = jobs.start({ projectId: 'p1', projectDir: dir, doc });
    const c = jobs.start({ projectId: 'p1', projectDir: dir, doc });
    assert.equal(await waitFor(() => jobs.status(a.job.id)?.state === 'running' && jobs.status(b.job.id)?.state === 'running'), true);
    assert.equal(jobs.status(c.job.id).state, 'queued');
    assert.equal(jobs.status(c.job.id).position, 1, '只剩一个排队，位置是 1');
    gate.waits.get(a.job.id)?.();
    gate.waits.get(b.job.id)?.();
    assert.equal(await waitFor(() => jobs.status(c.job.id)?.state === 'running'), true, 'c 接上槽');
    gate.waits.get(c.job.id)?.();
    assert.equal(await waitFor(() => jobs.status(c.job.id)?.state === 'done'), true);
    await queue.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

/* ── C. 取消 ────────────────────────────────────────────────────────── */

test('C1 取消排队中的作业：立即 cancelled、不产生输出、输出锁释放', async () => {
  const dir = await tempProject();
  const root = path.join(dir, 'queue');
  const gate = { waits: new Map(), wait(job) { return new Promise((resolve) => this.waits.set(job.id, resolve)); } };
  const { runner, state } = makeRunner({ gate });
  const { queue, jobs } = await wire({ root, concurrency: 1, runner });
  try {
    const outPath = path.join(dir, 'exports', 'queued.mp4');
    const a = jobs.start({ projectId: 'p1', projectDir: dir, doc });
    const b = jobs.start({ projectId: 'p1', projectDir: dir, doc, outPath });
    assert.equal(await waitFor(() => jobs.status(a.job.id)?.state === 'running'), true);
    assert.equal(jobs.status(b.job.id).state, 'queued');
    const cancelled = jobs.cancel(b.job.id);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.startedAt, null, '没开工');
    assert.equal(queue.status().queued.length, 0, '队列里立刻摘掉');
    assert.deepEqual(state.calls.includes(b.job.id), false, '被取消的作业一次都没跑');
    await fs.mkdir(path.join(dir, 'exports'), { recursive: true });
    const exportsNow = await fs.readdir(path.join(dir, 'exports'));
    assert.deepEqual(exportsNow.filter((name) => name.includes('queued')), [], '被取消的作业没有任何输出/锁');
    assert.deepEqual(exportsNow.filter((name) => name.endsWith('.mp4')), [], '输出目录里没有 mp4');
    // 锁已释放：同一个显式 outPath 能再次入队（否则会 EXPORT_OUTPUT_BUSY）
    const retry = jobs.start({ projectId: 'p1', projectDir: dir, doc, outPath });
    assert.equal(retry.ok, true, JSON.stringify(retry));
    gate.waits.get(a.job.id)?.();
    await queue.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('C2 取消运行中的作业：1s 内停、槽位释放、后面的接着跑', async () => {
  const dir = await tempProject();
  const root = path.join(dir, 'queue');
  const gate = { waits: new Map(), wait(job) { return new Promise((resolve) => this.waits.set(job.id, resolve)); } };
  const { runner } = makeRunner({ gate });
  const { queue, jobs } = await wire({ root, concurrency: 1, runner });
  try {
    const a = jobs.start({ projectId: 'p1', projectDir: dir, doc });
    const b = jobs.start({ projectId: 'p1', projectDir: dir, doc });
    assert.equal(await waitFor(() => jobs.status(a.job.id)?.state === 'running'), true);
    const began = Date.now();
    jobs.cancel(a.job.id);
    assert.equal(await waitFor(() => jobs.status(a.job.id)?.state === 'cancelled'), true);
    const latency = Date.now() - began;
    assert.ok(latency < 1000, `取消用了 ${latency}ms`);
    assert.equal(
      await waitFor(() => queue.status().running.every((/** @type {any} */ item) => item.id !== a.job.id), 1500),
      true,
      '槽位释放（a 不再占 running）',
    );
    assert.equal(await waitFor(() => jobs.status(b.job.id)?.state === 'running'), true);
    gate.waits.get(b.job.id)?.();
    assert.equal(await waitFor(() => jobs.status(b.job.id)?.state === 'done'), true);
    assert.equal(queue.status().failed, 0, '取消不算失败');
    await queue.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('C3 重复取消是幂等的：终态作业原样返回', async () => {
  const dir = await tempProject();
  const root = path.join(dir, 'queue');
  const { runner } = makeRunner({ ms: 10 });
  const { queue, jobs } = await wire({ root, concurrency: 1, runner });
  try {
    const started = jobs.start({ projectId: 'p1', projectDir: dir, doc });
    assert.equal(await waitFor(() => jobs.status(started.job.id)?.state === 'done'), true);
    const again = jobs.cancel(started.job.id);
    assert.equal(again.state, 'done');
    await queue.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

/* ── D. 崩溃恢复 ────────────────────────────────────────────────────── */

test('D1 崩溃恢复：running/queued 一律 failed(EXPORT_INTERRUPTED)，不重跑，半成品被清', async () => {
  const dir = await tempProject();
  const root = path.join(dir, 'queue');
  const partialDir = path.join(root, 'partial');
  // 第一代：一个在跑、一个排队；不 close（等价于进程被 kill）。
  const first = await wire({ root, concurrency: 1, runner: makeRunner({ gate: { wait: () => new Promise(() => {}) } }).runner });
  const a = first.jobs.start({ projectId: 'p1', projectDir: dir, doc });
  const b = first.jobs.start({ projectId: 'p1', projectDir: dir, doc });
  assert.equal(await waitFor(() => first.queue.status().running.length === 1 && first.queue.status().queued.length === 1), true);
  await first.queue.flush();
  // 模拟渲染写到一半被 kill：半成品目录里留下文件。
  await fs.mkdir(path.join(partialDir, 'opencut-export-dead'), { recursive: true });
  await fs.writeFile(path.join(partialDir, 'opencut-export-dead', 'film.mp4.partial'), Buffer.alloc(48));
  await fs.writeFile(path.join(partialDir, 'opencut-export-dead', 'frames.part'), Buffer.alloc(12));

  // 第二代：同一 root 重启。
  const { runner, state } = makeRunner({ ms: 10 });
  const second = await wire({ root, concurrency: 1, runner });
  await second.queue.ready;
  await new Promise((resolve) => setImmediate(resolve));

  const recovery = second.queue.recovery();
  const statusA = second.jobs.status(a.job.id);
  const statusB = second.jobs.status(b.job.id);
  assert.deepEqual(recovery.interrupted.slice().sort(), [a.job.id, b.job.id].sort());
  assert.equal(recovery.cleaned.files, 2);
  assert.equal(recovery.cleaned.bytes, 60);
  assert.equal(statusA?.state, 'failed');
  assert.equal(statusA?.error?.code, 'EXPORT_INTERRUPTED');
  assert.equal(statusB?.state, 'failed');
  assert.equal(second.queue.status().failed, 2);
  assert.deepEqual(state.calls, [], '不自动重跑');
  const leftovers = await fs.readdir(partialDir).catch(() => []);
  assert.deepEqual(leftovers, [], '半成品目录被清空');
  // 收尾：第一代的两个作业还挂着（等价于被 kill 的进程）；取消它们，别把锁/句柄留给后面的用例。
  first.jobs.cancel(a.job.id);
  first.jobs.cancel(b.job.id);
  await second.queue.close();
  await first.queue.close();
});

/* ── E. 重试 / 同源 HTTP ────────────────────────────────────────────── */

test('E1 失败后重试：新作业新 id，旧任务不会被重复入队', async () => {
  const dir = await tempProject();
  const root = path.join(dir, 'queue');
  let attempt = 0;
  const runner = async (/** @type {any} */ job) => {
    attempt += 1;
    if (attempt === 1) {
      const error = /** @type {any} */ (new Error('第一遍失败'));
      error.code = 'EXPORT_FAILED';
      throw error;
    }
    job.state = 'done';
    job.stage = 'done';
  };
  const { queue, jobs } = await wire({ root, concurrency: 1, runner });
  try {
    const first = jobs.start({ projectId: 'p1', projectDir: dir, doc });
    assert.equal(await waitFor(() => jobs.status(first.job.id)?.state === 'failed'), true);
    const retried = jobs.start({ projectId: 'p1', projectDir: dir, doc });
    assert.equal(retried.ok, true);
    assert.notEqual(retried.job.id, first.job.id, '重试是新作业');
    assert.equal(await waitFor(() => jobs.status(retried.job.id)?.state === 'done'), true);
    assert.equal(queue.status().failed, 1);
    assert.equal(queue.status().completed, 1);
    const ids = queue.status().queued.concat(queue.status().running).map((/** @type {any} */ item) => item.id);
    assert.deepEqual(ids, [], '没有残留/重复的队列项');
    await queue.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('E2 HTTP 同源：GET /api/render/queue 的 running/queued 就是 /api/export 的那批作业', async () => {
  const dir = await tempProject();
  const home = path.join(dir, 'home');
  const gate = { waits: new Map(), wait(job) { return new Promise((resolve) => this.waits.set(job.id, resolve)); } };
  const { runner } = makeRunner({ gate });
  const studio = await startStudio({ port: 0, vitePort: 59999, home, exportRunner: runner });
  try {
    const opened = await fetch(`${studio.url}/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir }),
    });
    assert.equal(opened.status, 200);
    const projectId = (await opened.json())?.project?.projectId;

    /** @type {string[]} */
    const ids = [];
    for (let index = 0; index < 2; index += 1) {
      const posted = await fetch(`${studio.url}/api/export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId }),
      });
      assert.equal(posted.status, 202);
      ids.push((await posted.json())?.job?.id);
    }
    assert.equal(await waitFor(() => ids.every((id) => gate.waits.has(id)), 3000), true);

    const queuedView = await (await fetch(`${studio.url}/api/render/queue`)).json();
    const exportView = await (await fetch(`${studio.url}/api/export`)).json();
    assert.deepEqual(Object.keys(queuedView).sort(), ['completed', 'concurrency', 'failed', 'queued', 'running']);
    assert.deepEqual(
      queuedView.running.map((/** @type {any} */ item) => item.id).sort(),
      ids.slice().sort(),
      '队列 running 就是这两个导出',
    );
    assert.equal(exportView.summary.running !== null, true);
    assert.equal(exportView.jobs.filter((/** @type {any} */ job) => job.state === 'running').length, 2);

    // 取消其中一个：队列与导出视图同时变化（同源，不另存一份）
    const deleting = await fetch(`${studio.url}/api/export/${ids[0]}`, { method: 'DELETE' });
    assert.equal(deleting.status, 200);
    /** @type {any} */
    let afterCancel = null;
    const gone = await waitForAsync(async () => {
      afterCancel = await (await fetch(`${studio.url}/api/render/queue`)).json();
      return !afterCancel.running.some((/** @type {any} */ item) => item.id === ids[0]);
    });
    assert.equal(gone, true, '队列里的 running 应立刻少一个');
    assert.equal(afterCancel.failed, 0, '取消不算失败');
    gate.waits.get(ids[1])?.();
  } finally {
    await studio.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('E3 env 并发越界：导出被队列拒绝（不静默忽略上限）', async () => {
  const dir = await tempProject();
  const home = path.join(dir, 'home');
  const previous = process.env.OPENCUT_RENDER_CONCURRENCY;
  process.env.OPENCUT_RENDER_CONCURRENCY = '9';
  const studio = await startStudio({ port: 0, vitePort: 59999, home, exportRunner: makeRunner({ ms: 10 }).runner });
  try {
    const opened = await fetch(`${studio.url}/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir }),
    });
    const projectId = (await opened.json())?.project?.projectId;
    const posted = await fetch(`${studio.url}/api/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId }),
    });
    const body = await posted.json();
    assert.equal(posted.status, 409);
    assert.equal(body.ok, false);
    assert.equal(body.code, 'RENDER_CONCURRENCY_INVALID');
    const exportsView = await (await fetch(`${studio.url}/api/export`)).json();
    assert.deepEqual(exportsView.jobs, [], '被拒绝的作业不留在队列里');
    const exportsDir = await fs.readdir(path.join(dir, 'exports')).catch(() => []);
    assert.deepEqual(exportsDir.filter((name) => name.endsWith('.mp4')), [], '没有产物');
  } finally {
    await studio.close();
    if (previous === undefined) delete process.env.OPENCUT_RENDER_CONCURRENCY;
    else process.env.OPENCUT_RENDER_CONCURRENCY = previous;
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('E4 队列关闭：运行中的导出被 abort，不会留下 running', async () => {
  const dir = await tempProject();
  const root = path.join(dir, 'queue');
  const gate = { waits: new Map(), wait(job) { return new Promise((resolve) => this.waits.set(job.id, resolve)); } };
  const { runner } = makeRunner({ gate });
  const { queue, jobs } = await wire({ root, concurrency: 2, runner });
  try {
    const a = jobs.start({ projectId: 'p1', projectDir: dir, doc });
    assert.equal(await waitFor(() => jobs.status(a.job.id)?.state === 'running'), true);
    await queue.close();
    assert.equal(await waitFor(() => jobs.status(a.job.id)?.state === 'cancelled'), true);
    assert.equal(jobs.status(a.job.id).error.code, 'CANCELLED');
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('E5 明确的 outPath 被同一个进程占着时 EXPORT_OUTPUT_BUSY，且不新增队列项', async () => {
  const dir = await tempProject();
  const root = path.join(dir, 'queue');
  const gate = { waits: new Map(), wait(job) { return new Promise((resolve) => this.waits.set(job.id, resolve)); } };
  const { runner } = makeRunner({ gate });
  const { queue, jobs } = await wire({ root, concurrency: 1, runner });
  try {
    const outPath = path.join(dir, 'exports', 'same.mp4');
    const a = jobs.start({ projectId: 'p1', projectDir: dir, doc, outPath });
    const b = jobs.start({ projectId: 'p1', projectDir: dir, doc, outPath });
    assert.equal(a.ok, true);
    assert.equal(b.ok, false);
    assert.equal(b.code, 'EXPORT_OUTPUT_BUSY');
    assert.equal(queue.status().running.length + queue.status().queued.length, 1, '只入队了一次');
    jobs.cancel(a.job.id);
    await queue.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('E6 partialDir 落在队列目录下：正常结束后不留文件', async () => {
  const dir = await tempProject();
  const root = path.join(dir, 'queue');
  const partialDir = path.join(root, 'partial');
  /** @type {string[]} */
  const seen = [];
  const runner = async (/** @type {any} */ job) => {
    const entries = await fs.readdir(partialDir).catch(() => []);
    seen.push(...entries);
    // 真 run() 会写 film.mp4 / frames/ 之类；这里造一个同形状的文件再自己收尾。
    await fs.mkdir(partialDir, { recursive: true });
    const tmp = await fs.mkdtemp(path.join(partialDir, 'opencut-export-'));
    await fs.writeFile(path.join(tmp, 'film.mp4.partial'), Buffer.alloc(10));
    await fs.rm(tmp, { recursive: true, force: true });
    job.state = 'done';
    job.stage = 'done';
  };
  const { queue, jobs } = await wire({ root, concurrency: 1, runner });
  try {
    const started = jobs.start({ projectId: 'p1', projectDir: dir, doc });
    assert.equal(await waitFor(() => jobs.status(started.job.id)?.state === 'done'), true);
    assert.deepEqual(await fs.readdir(partialDir).catch(() => []), []);
    assert.equal(seen.length, 0, '开跑时 partial 目录是空的');
    assert.equal(fssync.existsSync(partialDir), true);
    await queue.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
