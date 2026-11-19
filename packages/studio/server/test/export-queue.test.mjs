// @ts-nocheck
// 队列的单测故意注入假 runner（`any` 满天飞）：这里验的是状态机与串行性，不是类型形状。
// 与仓库里其它 test（write-path / routes / media-relink）一致。
/**
 * M29 导出队列：状态机与串行性（不跑 ffmpeg）。
 *
 * 真渲染链在 `scripts/m29-export-queue.mjs` 里用真 Studio + 真 ffmpeg 验；
 * 这里注入一个受控 runner，专门盯**队列本身**的性质：
 *
 *   1. 串行：同一时刻最多 1 个 running；连续入队按 FIFO 开工
 *   2. 状态机：queued → running → done|failed|cancelled，不许跳态
 *   3. 排队时取消：那个作业**一次都没跑**，后面的照常开工
 *   4. 运行中取消：signal.aborted → cancelled → 队列继续
 *   5. 失败不阻塞：failed 之后下一个照常跑
 */

import assert from 'node:assert/strict';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { EXPORT_TRANSITIONS, createExportJobs } from '../export-job.mjs';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * 每个测试进程一个临时「工程」目录：M37 起作业在**入队**时就占住
 * `<projectDir>/exports/film-*.mp4` 的锁（真文件），不能拿 `/tmp` 当工程用。
 */
const PROJECT_DIR = fssync.mkdtempSync(path.join(os.tmpdir(), 'opencut-queue-test-'));

/** 轮询到条件成立（时序测试别拿固定 sleep 赌机器负载）。 */
async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate() === true) return true;
    await sleep(10);
  }
  return false;
}

/** 手动闸门：runner 停在 `await gate` 上，测试自己决定什么时候放行。 */
function makeGate() {
  /** @type {Map<string, () => void>} */
  const pending = new Map();
  return {
    /** @param {any} job */
    wait(job) {
      return new Promise((resolve) => pending.set(job.id, resolve));
    },
    /** @param {string} id */
    open(id) {
      const resolve = pending.get(id);
      if (resolve !== undefined) {
        pending.delete(id);
        resolve();
      }
    },
  };
}

/**
 * 受控 runner：每个作业跑 `ms` 毫秒；可选在 abort 时提前结束。
 * 记录「同时有几个在跑」的峰值与开工/收工顺序。
 */
/** @param {{ ms?: number|Function, failWhen?: Function, gate?: { wait: Function } }} [options] */
function makeRunner(options = {}) {
  const state = {
    started: [],
    finished: [],
    peak: 0,
    live: 0,
    calls: 0,
    aborted: [],
  };
  /** @type {Function} */
  /** @type {(job: any, doc: any, input: any) => Promise<void>} */
  const runner = async (job, doc, input) => {
    state.calls += 1;
    state.started.push(job.id);
    state.live += 1;
    state.peak = Math.max(state.peak, state.live);
    const signal = job.handle.signal;
    const onAbort = () => state.aborted.push(job.id);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (options.gate !== undefined) {
        await options.gate.wait(job);
      } else {
        const duration = typeof options.ms === 'function' ? options.ms(job, input) : (options.ms ?? 20);
        await Promise.race([
          sleep(duration),
          new Promise((resolve) => {
            if (signal.aborted) resolve(undefined);
            else signal.addEventListener('abort', () => resolve(undefined), { once: true });
          }),
        ]);
      }
      if (signal.aborted) {
        const error = /** @type {any} */ (new Error('导出已取消'));
        error.code = 'CANCELLED';
        throw error;
      }
      if (typeof options.failWhen === 'function' && options.failWhen(job)) {
        const error = /** @type {any} */ (new Error('假装失败：MEDIA_MISSING'));
        error.code = 'MEDIA_MISSING';
        throw error;
      }
      job.percent = 1;
      job.stage = 'done';
      job.state = 'done';
      job.output = { path: `/tmp/${job.id}.mp4`, bytes: 1, sha256: 'x' };
      state.finished.push(job.id);
    } finally {
      signal.removeEventListener('abort', onAbort);
      state.live -= 1;
    }
  };
  return { runner, state, options };
}

const doc = { tracks: [] };

test('状态迁移表只允许五条边（不许跳态）', () => {
  assert.deepEqual(EXPORT_TRANSITIONS.queued, ['running', 'cancelled']);
  assert.deepEqual(EXPORT_TRANSITIONS.running, ['done', 'failed', 'cancelled']);
  assert.deepEqual(EXPORT_TRANSITIONS.done, []);
  assert.deepEqual(EXPORT_TRANSITIONS.failed, []);
  assert.deepEqual(EXPORT_TRANSITIONS.cancelled, []);
});

test('A1 连续入队 3 个：串行（峰值 1）、FIFO 开工、第 2/3 在 queued 等', async () => {
  // 用闸门代替固定 sleep：M37 起入队要拿真锁（fs），机器忙时 60ms 的窗口不够稳。
  const gate = makeGate();
  const { runner, state } = makeRunner({ gate });
  const jobs = createExportJobs({ runner: /** @type {any} */ (runner) });

  const first = jobs.start({ projectId: 'p', projectDir: PROJECT_DIR, doc });
  const second = jobs.start({ projectId: 'p', projectDir: PROJECT_DIR, doc });
  const third = jobs.start({ projectId: 'p', projectDir: PROJECT_DIR, doc });

  assert.equal(first.job.state, 'running');
  assert.equal(second.job.state, 'queued');
  assert.equal(third.job.state, 'queued');
  assert.equal(second.job.position, 1);
  assert.equal(third.job.position, 2);

  // 队首跑完之前，第 2 个必须还在排队
  gate.open(first.job.id);
  assert.equal(await waitFor(() => jobs.status(first.job.id).state === 'done'), true);
  assert.equal(await waitFor(() => jobs.status(second.job.id).state === 'running'), true);
  assert.equal(jobs.status(third.job.id).state, 'queued');

  gate.open(second.job.id);
  assert.equal(await waitFor(() => jobs.status(second.job.id).state === 'done'), true);
  assert.equal(await waitFor(() => jobs.status(third.job.id).state === 'running'), true);
  gate.open(third.job.id);
  assert.equal(await waitFor(() => jobs.status(third.job.id).state === 'done'), true);

  const end = jobs.list();
  assert.deepEqual(
    end.map((job) => job.state),
    ['done', 'done', 'done'],
  );
  assert.equal(state.peak, 1, '同一时刻只能有一个在跑');
  assert.deepEqual(state.started, [first.job.id, second.job.id, third.job.id], '严格 FIFO');
  assert.deepEqual(jobs.summary(), { running: null, queued: 0, next: null, total: 3 });
});

test('A1b 中间那个失败（MEDIA_MISSING）不阻塞后面的', async () => {
  const { runner } = makeRunner({ ms: 20, failWhen: (job) => job.projectId === 'bad' });
  const jobs = createExportJobs({ runner: /** @type {any} */ (runner) });

  const ok1 = jobs.start({ projectId: 'good', projectDir: PROJECT_DIR, doc });
  const bad = jobs.start({ projectId: 'bad', projectDir: PROJECT_DIR, doc });
  const ok2 = jobs.start({ projectId: 'good', projectDir: PROJECT_DIR, doc });

  await sleep(200);
  const states = jobs.list().map((job) => job.state);
  assert.deepEqual(states, ['done', 'failed', 'done']);
  const failed = jobs.status(bad.job.id);
  assert.equal(failed.error.code, 'MEDIA_MISSING');
  // 失败之后队列继续：第 3 个真的跑了（不是被卡在 queued）
  assert.equal(jobs.status(ok2.job.id).startedAt !== null, true);
});

test('A2a 排队时取消：那个作业一次都没跑，后面的照常开工', async () => {
  const { runner, state } = makeRunner({ ms: 80 });
  const jobs = createExportJobs({ runner: /** @type {any} */ (runner) });

  const first = jobs.start({ projectId: 'p', projectDir: PROJECT_DIR, doc });
  const second = jobs.start({ projectId: 'p', projectDir: PROJECT_DIR, doc });

  const cancelled = jobs.cancel(second.job.id);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.startedAt, null, '没开工：startedAt 必须还是 null');
  assert.match(cancelled.error.message, /排队时已取消/);

  await sleep(200);
  assert.equal(jobs.status(first.job.id).state, 'done');
  assert.equal(state.started.includes(second.job.id), false, '被取消的作业不能开跑');
  assert.equal(state.calls, 1);
});

test('A2b 运行中取消：signal 真的 abort、状态进 cancelled、队列继续', async () => {
  const { runner, state } = makeRunner({ ms: 400 });
  const jobs = createExportJobs({ runner: /** @type {any} */ (runner) });

  const first = jobs.start({ projectId: 'p', projectDir: PROJECT_DIR, doc });
  const second = jobs.start({ projectId: 'p', projectDir: PROJECT_DIR, doc });
  await sleep(30);

  const requested = jobs.cancel(first.job.id);
  assert.equal(requested.cancelRequested, true);
  assert.equal(requested.state, 'running', 'cancel 只是请求；状态由 runner 收尾时落');

  await sleep(150);
  assert.equal(jobs.status(first.job.id).state, 'cancelled');
  assert.deepEqual(state.aborted, [first.job.id]);
  // 队列继续：第二个已经开工
  assert.equal(jobs.status(second.job.id).state, 'running');
  await sleep(500);
  assert.equal(jobs.status(second.job.id).state, 'done');
});

test('取消终态作业是幂等的，不会把状态改回去', async () => {
  const { runner } = makeRunner({ ms: 10 });
  const jobs = createExportJobs({ runner: /** @type {any} */ (runner) });
  const job = jobs.start({ projectId: 'p', projectDir: PROJECT_DIR, doc });
  await sleep(80);
  assert.equal(jobs.status(job.job.id).state, 'done');
  const again = jobs.cancel(job.job.id);
  assert.equal(again.state, 'done');
  assert.equal(again.finishedAt !== null, true);
});

test('排队位置随开工前移；list 是入队顺序而不是完成顺序', async () => {
  const gate = makeGate();
  const { runner } = makeRunner({ gate });
  const jobs = createExportJobs({ runner: /** @type {any} */ (runner) });
  const a = jobs.start({ projectId: 'p', projectDir: PROJECT_DIR, doc });
  const b = jobs.start({ projectId: 'p', projectDir: PROJECT_DIR, doc });
  const c = jobs.start({ projectId: 'p', projectDir: PROJECT_DIR, doc });
  assert.equal(jobs.status(b.job.id).position, 1);
  assert.equal(jobs.status(c.job.id).position, 2);
  gate.open(a.job.id);
  assert.equal(await waitFor(() => jobs.status(a.job.id).state === 'done'), true);
  assert.equal(await waitFor(() => jobs.status(b.job.id).state === 'running'), true);
  assert.equal(jobs.status(c.job.id).position, 1);
  gate.open(b.job.id);
  assert.equal(await waitFor(() => jobs.status(b.job.id).state === 'done'), true);
  gate.open(c.job.id);
  assert.equal(await waitFor(() => jobs.status(c.job.id).state === 'done'), true);
  assert.deepEqual(
    jobs.list().map((job) => job.id),
    [a.job.id, b.job.id, c.job.id],
  );
});
