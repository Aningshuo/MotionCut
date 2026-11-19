/**
 * M67-WP23-SCHEDULER 的服务端单测（B-MAIN-R30-033）。
 *
 * 这里守的是调度语义本身：并发上限、env 覆盖越界、确定性公平插入、排队/运行取消、
 * 槽位释放、崩溃恢复（interrupted + 半成品清理）、状态计数、重复 cancel 幂等。
 * 真子进程与真 HTTP 由 `scripts/m67-scheduler.mjs` 覆盖。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  RENDER_CONCURRENCY_LIMITS,
  RenderConcurrencyError,
  planCaptureConcurrency,
  resolveRenderConcurrency,
} from '../../../render/concurrency.mjs';
import { createScheduler } from '../../../render/scheduler.mjs';
import { startStudio } from '../studio-server.mjs';

/** @param {number} ms */
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * 轮询等条件成立（避免依赖固定 sleep）。
 * @param {() => boolean} predicate
 * @param {number} [timeoutMs]
 */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error('waitFor 超时');
}

/** @param {string} dir */
async function tempDir(dir) {
  return fs.mkdtemp(path.join(os.tmpdir(), `opencut-sched-${dir}-`));
}

/**
 * @param {any} scheduler
 * @param {any[]} jobs
 */
function enqueueAll(scheduler, jobs) {
  for (const job of jobs) {
    const result = scheduler.enqueue(job);
    assert.equal(result.ok, true, JSON.stringify(result));
  }
}

/** @param {number} count @param {string} projectId @param {string} prefix */
function jobsFor(count, projectId, prefix = 'j') {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    projectId,
    kind: /** @type {'export'|'capture'} */ (index % 3 === 2 ? 'capture' : 'export'),
    priority: 0,
    createdAt: index + 1,
  }));
}

/* ── 并发预算 ─────────────────────────────────────────────────────────── */

test('默认并发：取 planCaptureConcurrency 的预算（10 条视频 → 3）', () => {
  const plan = { visualClips: Array.from({ length: 10 }, (_, index) => ({ index })) };
  assert.equal(planCaptureConcurrency(plan), 3);
  assert.equal(resolveRenderConcurrency({ plan, env: {} }), 3);
  assert.equal(resolveRenderConcurrency({ plan: {}, env: {} }), planCaptureConcurrency({}));
});

test('OPENCUT_RENDER_CONCURRENCY 覆盖：1..8 的整数生效', () => {
  assert.equal(resolveRenderConcurrency({ env: { OPENCUT_RENDER_CONCURRENCY: '2' } }), 2);
  assert.equal(resolveRenderConcurrency({ env: { OPENCUT_RENDER_CONCURRENCY: ' 8 ' } }), 8);
  assert.equal(resolveRenderConcurrency({ env: { OPENCUT_RENDER_CONCURRENCY: '1' } }), 1);
});

test('OPENCUT_RENDER_CONCURRENCY 越界/非整数：抛 RENDER_CONCURRENCY_INVALID + allowed', () => {
  for (const value of ['0', '9', '1.5', 'abc', '-2']) {
    assert.throws(
      () => resolveRenderConcurrency({ env: { OPENCUT_RENDER_CONCURRENCY: value } }),
      (error) => {
        assert.ok(error instanceof RenderConcurrencyError);
        assert.equal(error.code, 'RENDER_CONCURRENCY_INVALID');
        assert.deepEqual(error.allowed, [RENDER_CONCURRENCY_LIMITS.min, RENDER_CONCURRENCY_LIMITS.max]);
        return true;
      },
      value,
    );
  }
});

/* ── 入队校验 ─────────────────────────────────────────────────────────── */

test('入队校验：kind 只能是 export/capture', async () => {
  const scheduler = createScheduler({ concurrency: 1, runner: async () => undefined });
  await scheduler.ready;
  const bad = scheduler.enqueue({ id: 'x', projectId: 'p', kind: 'render', priority: 0, createdAt: 1 });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'INVALID_KIND');
  const missing = scheduler.enqueue({ id: '', projectId: 'p', kind: 'export', priority: 0, createdAt: 1 });
  assert.equal(missing.code, 'INVALID_JOB');
  await scheduler.close();
});

test('入队校验：重复 id → DUPLICATE_JOB', async () => {
  const scheduler = createScheduler({ concurrency: 1, runner: async () => undefined });
  await scheduler.ready;
  assert.equal(scheduler.enqueue({ id: 'dup', projectId: 'p', kind: 'export', priority: 0, createdAt: 1 }).ok, true);
  const again = scheduler.enqueue({ id: 'dup', projectId: 'p', kind: 'export', priority: 0, createdAt: 2 });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'DUPLICATE_JOB');
  await scheduler.close();
});

/* ── 并发与顺序 ───────────────────────────────────────────────────────── */

test('并发上限：concurrency=2 时 6 个任务最大同时 2 个', async () => {
  let active = 0;
  let maxActive = 0;
  const scheduler = createScheduler({
    concurrency: 2,
    runner: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(20);
      active -= 1;
    },
  });
  await scheduler.ready;
  enqueueAll(scheduler, jobsFor(6, 'p1'));
  await waitFor(() => scheduler.status().completed === 6);
  assert.equal(maxActive, 2);
  assert.equal(scheduler.status().failed, 0);
  await scheduler.close();
});

test('优先级：priority 高先跑，同优先级按 createdAt / id 稳定排序', async () => {
  /** @type {string[]} */
  const order = [];
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  const scheduler = createScheduler({
    concurrency: 1,
    runner: async (job) => {
      order.push(job.id);
      if (job.id === 'blocker') await gate;
    },
  });
  await scheduler.ready;
  // 先占住唯一的槽，后三个才在队列里按优先级排序。
  enqueueAll(scheduler, [{ id: 'blocker', projectId: 'p', kind: 'export', priority: -1, createdAt: 0 }]);
  enqueueAll(scheduler, [
    { id: 'low-1', projectId: 'p', kind: 'export', priority: 0, createdAt: 1 },
    { id: 'high', projectId: 'p', kind: 'export', priority: 5, createdAt: 9 },
    { id: 'low-2', projectId: 'p', kind: 'export', priority: 0, createdAt: 2 },
  ]);
  release();
  await waitFor(() => scheduler.status().completed === 4);
  assert.deepEqual(order, ['blocker', 'high', 'low-1', 'low-2']);
  await scheduler.close();
});

test('公平性：A 入队 6 个（hog）时，B 每 2 个 A 插一次（确定性）', async () => {
  /** @type {string[]} */
  const order = [];
  const scheduler = createScheduler({
    concurrency: 1,
    runner: async (job) => {
      order.push(job.projectId);
    },
  });
  await scheduler.ready;
  enqueueAll(scheduler, [
    ...jobsFor(6, 'A', 'a').map((job, index) => ({ ...job, createdAt: index + 1 })),
    ...jobsFor(2, 'B', 'b').map((job, index) => ({ ...job, createdAt: 100 + index })),
  ]);
  await waitFor(() => scheduler.status().completed === 8);
  assert.deepEqual(order, ['A', 'A', 'B', 'A', 'A', 'B', 'A', 'A']);
  assert.deepEqual(
    scheduler.insertions().map((/** @type {any} */ item) => item.at),
    [2, 5],
  );
  await scheduler.close();
});

test('公平性：只有单工程排队时不虚构插入', async () => {
  /** @type {string[]} */
  const order = [];
  const scheduler = createScheduler({
    concurrency: 1,
    runner: async (job) => {
      order.push(job.projectId);
    },
  });
  await scheduler.ready;
  enqueueAll(scheduler, jobsFor(5, 'solo', 's'));
  await waitFor(() => scheduler.status().completed === 5);
  assert.deepEqual(order, ['solo', 'solo', 'solo', 'solo', 'solo']);
  assert.deepEqual(scheduler.insertions(), []);
  await scheduler.close();
});

/* ── 取消 ─────────────────────────────────────────────────────────────── */

test('取消排队中：立即移出且状态 cancelled，绝不开始', async () => {
  /** @type {string[]} */
  const started = [];
  const scheduler = createScheduler({
    concurrency: 1,
    runner: async (job) => {
      started.push(job.id);
      await sleep(50);
    },
  });
  await scheduler.ready;
  enqueueAll(scheduler, jobsFor(2, 'p', 'q'));
  assert.equal(scheduler.status().running.length, 1);
  const result = await scheduler.cancel('q-1');
  assert.equal(result.ok, true);
  assert.equal(result.was, 'queued');
  assert.equal(scheduler.get('q-1')?.status, 'cancelled');
  assert.equal(scheduler.status().queued.length, 0);
  await waitFor(() => scheduler.status().completed === 1);
  assert.deepEqual(started, ['q-0']);
  await scheduler.close();
});

test('取消运行中：1s 内停、2s 内释放槽位，后续任务接着跑', async () => {
  /** @type {string[]} */
  const started = [];
  const scheduler = createScheduler({
    concurrency: 1,
    runner: (job, { signal }) => {
      started.push(job.id);
      if (job.id === 'r-1') return sleep(20);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          },
          { once: true },
        );
      });
    },
  });
  await scheduler.ready;
  enqueueAll(scheduler, jobsFor(2, 'p', 'r'));
  await waitFor(() => scheduler.status().running.length === 1);
  const began = Date.now();
  const result = await scheduler.cancel('r-0');
  const elapsed = Date.now() - began;
  assert.equal(result.ok, true);
  assert.equal(result.was, 'running');
  assert.equal(result.settled, true);
  assert.ok(elapsed < 2000, `释放耗时 ${elapsed}ms`);
  assert.ok(/** @type {number} */ (result.releasedMs) < 2000);
  assert.equal(scheduler.get('r-0')?.status, 'cancelled');
  await waitFor(() => started.includes('r-1'));
  await waitFor(() => scheduler.status().completed === 1);
  assert.equal(scheduler.status().failed, 0);
  await scheduler.close();
});

test('取消幂等：重复 cancel 返回 already，不重复计数', async () => {
  const scheduler = createScheduler({ concurrency: 1, runner: async () => sleep(100) });
  await scheduler.ready;
  enqueueAll(scheduler, jobsFor(1, 'p', 'i'));
  await waitFor(() => scheduler.status().running.length === 1);
  const first = await scheduler.cancel('i-0');
  const second = await scheduler.cancel('i-0');
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.already, true);
  assert.equal(scheduler.get('i-0')?.status, 'cancelled');
  await scheduler.close();
});

test('取消不存在 / 已完成：固定错误码', async () => {
  const scheduler = createScheduler({ concurrency: 1, runner: async () => undefined });
  await scheduler.ready;
  const missing = await scheduler.cancel('nope');
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'JOB_NOT_FOUND');

  enqueueAll(scheduler, jobsFor(1, 'p', 'done'));
  await waitFor(() => scheduler.status().completed === 1);
  const finished = await scheduler.cancel('done-0');
  assert.equal(finished.ok, false);
  assert.equal(finished.code, 'JOB_NOT_CANCELLABLE');
  await scheduler.close();
});

/* ── 崩溃恢复 ─────────────────────────────────────────────────────────── */

test('崩溃恢复：状态文件里 running/queued 标 failed(interrupted)，不重跑', async () => {
  const dir = await tempDir('recover');
  const statePath = path.join(dir, 'state.json');
  const partialDir = path.join(dir, 'partial');
  try {
    const before = createScheduler({
      concurrency: 1,
      runner: () => new Promise(() => {}),
      statePath,
      partialDir,
    });
    await before.ready;
    enqueueAll(before, jobsFor(2, 'p', 'crash'));
    await waitFor(() => before.status().running.length === 1);
    await before.flush();

    /** @type {string[]} */
    const restarted = [];
    const after = createScheduler({
      concurrency: 1,
      runner: async (job) => {
        restarted.push(job.id);
      },
      statePath,
      partialDir,
    });
    await after.ready;
    const recovery = after.recovery();
    assert.deepEqual(recovery.interrupted.sort(), ['crash-0', 'crash-1']);
    assert.equal(after.get('crash-0')?.status, 'failed');
    assert.equal(after.get('crash-0')?.error, 'interrupted');
    assert.equal(after.get('crash-1')?.status, 'failed');
    const status = after.status();
    assert.equal(status.running.length, 0);
    assert.equal(status.queued.length, 0);
    assert.equal(status.failed, 2);
    assert.deepEqual(restarted, []);
    await after.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('崩溃恢复：partial 半成品被清理并记录 {files,bytes}', async () => {
  const dir = await tempDir('partial');
  const statePath = path.join(dir, 'state.json');
  const partialDir = path.join(dir, 'partial');
  try {
    await fs.mkdir(path.join(partialDir, 'nested'), { recursive: true });
    await fs.writeFile(path.join(partialDir, 'a.part'), Buffer.alloc(10));
    await fs.writeFile(path.join(partialDir, 'b.part'), Buffer.alloc(20));
    await fs.writeFile(path.join(partialDir, 'nested', 'c.part'), Buffer.alloc(30));
    await fs.writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        concurrency: 1,
        running: [],
        queued: [{ id: 'stale', projectId: 'p', kind: 'export', priority: 0, createdAt: 1 }],
        completed: 4,
        failed: 1,
      }),
      'utf8',
    );
    const scheduler = createScheduler({ concurrency: 1, statePath, partialDir });
    await scheduler.ready;
    const recovery = scheduler.recovery();
    assert.deepEqual(recovery.cleaned, { files: 3, bytes: 60 });
    assert.deepEqual(recovery.interrupted, ['stale']);
    assert.equal(scheduler.status().completed, 4);
    assert.equal(scheduler.status().failed, 1);
    const left = await fs.readdir(partialDir).catch(() => []);
    assert.deepEqual(left, []);
    await scheduler.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('取消运行中任务后状态文件不再含 running', async () => {
  const dir = await tempDir('state');
  const statePath = path.join(dir, 'state.json');
  try {
    const scheduler = createScheduler({
      concurrency: 1,
      statePath,
      runner: (job, { signal }) =>
        new Promise((resolve) => {
          const timer = setTimeout(resolve, 5000);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve(undefined);
          });
        }),
    });
    await scheduler.ready;
    enqueueAll(scheduler, jobsFor(1, 'p', 'state'));
    await waitFor(() => scheduler.status().running.length === 1);
    await scheduler.cancel('state-0');
    await scheduler.flush();
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    assert.deepEqual(state.running, []);
    assert.deepEqual(state.queued, []);
    await scheduler.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/* ── 观测与关闭 ───────────────────────────────────────────────────────── */

test('status()：固定五字段 + 计数', async () => {
  let failNext = true;
  const scheduler = createScheduler({
    concurrency: 2,
    runner: async (job) => {
      if (job.id === 'ok-fail' && failNext) {
        failNext = false;
        throw new Error('boom');
      }
      await sleep(10);
    },
  });
  await scheduler.ready;
  enqueueAll(scheduler, jobsFor(3, 'p', 'ok'));
  enqueueAll(scheduler, [{ id: 'ok-fail', projectId: 'p', kind: 'export', priority: 0, createdAt: 9 }]);
  await waitFor(() => scheduler.status().completed === 3 && scheduler.status().failed === 1);
  const status = scheduler.status();
  assert.deepEqual(Object.keys(status).sort(), ['completed', 'concurrency', 'failed', 'queued', 'running']);
  assert.equal(status.concurrency, 2);
  assert.equal(status.completed, 3);
  assert.equal(status.failed, 1);
  assert.deepEqual(status.running, []);
  assert.deepEqual(status.queued, []);
  await scheduler.close();
});

test('close()：abort 运行中任务并清空 running/queued', async () => {
  /** @type {string[]} */
  const aborted = [];
  const scheduler = createScheduler({
    concurrency: 1,
    runner: (job, { signal }) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          aborted.push(job.id);
          resolve(undefined);
        });
      }),
  });
  await scheduler.ready;
  enqueueAll(scheduler, jobsFor(2, 'p', 'close'));
  await waitFor(() => scheduler.status().running.length === 1);
  await scheduler.close();
  assert.deepEqual(aborted, ['close-0']);
  assert.deepEqual(scheduler.status().running, []);
  assert.deepEqual(scheduler.status().queued, []);
});

/* ── HTTP 观测面 ──────────────────────────────────────────────────────── */

test('GET /api/render/queue：固定五字段，并发来自 OPENCUT_RENDER_CONCURRENCY', async () => {
  const previous = process.env.OPENCUT_RENDER_CONCURRENCY;
  process.env.OPENCUT_RENDER_CONCURRENCY = '2';
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-render-queue-'));
  try {
    const studio = await startStudio({ port: 0, vitePort: 59999, home });
    try {
      const response = await fetch(`${studio.url}/api/render/queue`);
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.deepEqual(Object.keys(body).sort(), ['completed', 'concurrency', 'failed', 'queued', 'running']);
      assert.equal(body.concurrency, 2);
      assert.deepEqual(body.running, []);
      assert.deepEqual(body.queued, []);
      assert.equal(body.completed, 0);
      assert.equal(body.failed, 0);
    } finally {
      await studio.close();
    }
  } finally {
    if (previous === undefined) delete process.env.OPENCUT_RENDER_CONCURRENCY;
    else process.env.OPENCUT_RENDER_CONCURRENCY = previous;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('GET /api/render/queue：env 越界 → 400 RENDER_CONCURRENCY_INVALID', async () => {
  const previous = process.env.OPENCUT_RENDER_CONCURRENCY;
  process.env.OPENCUT_RENDER_CONCURRENCY = '9';
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-render-queue-'));
  try {
    const studio = await startStudio({ port: 0, vitePort: 59999, home });
    try {
      const response = await fetch(`${studio.url}/api/render/queue`);
      const body = await response.json();
      assert.equal(response.status, 400);
      assert.equal(body.ok, false);
      assert.equal(body.code, 'RENDER_CONCURRENCY_INVALID');
      assert.deepEqual(body.allowed, [1, 8]);
    } finally {
      await studio.close();
    }
  } finally {
    if (previous === undefined) delete process.env.OPENCUT_RENDER_CONCURRENCY;
    else process.env.OPENCUT_RENDER_CONCURRENCY = previous;
    await fs.rm(home, { recursive: true, force: true });
  }
});
