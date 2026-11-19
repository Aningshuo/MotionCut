/**
 * P24-A5 预算守卫：采样、超限、降级后端。
 *
 * 用假采样器与假时钟，不依赖本机内存；真实那一次"超限即停"的证据在
 * `.local-runs/sub2/runs/R12/evidence/p24-portrait.json` 的 A5 段。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startResourceMonitor, readSystemFreeMemMb, BudgetExceededError } from '../budget-guard.mjs';

/**
 * @param {number} ms
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('P24：内存超限会置位并按整棵树的数报出来', async () => {
  /** @type {number[]} */
  const series = [100, 300, 900, 1200];
  let i = 0;
  /** @type {BudgetExceededError | null} */
  let tripped = null;
  // 采样间隔有 100ms 下限（防止把 CPU 打满）：测试按这个口径等
  const monitor = startResourceMonitor({
    intervalMs: 100,
    maxRssMb: 800,
    sample: async () => ({ rssMb: series[Math.min(i++, series.length - 1)] ?? 0, processes: 3 }),
    onExceed: (reason) => {
      tripped = reason;
    },
  });
  await sleep(460);
  const stats = await monitor.stop();
  assert.equal(stats.source, 'tree');
  assert.equal(stats.exceeded?.code, 'BUDGET_EXCEEDED');
  assert.ok(stats.peakMb >= 900);
  assert.equal(/** @type {any} */ (tripped)?.limitMb, 800);
  assert.ok(stats.samples >= 2);
});

test('P24：时间超限也能拦（不依赖内存）', async () => {
  let clock = 0;
  const monitor = startResourceMonitor({
    intervalMs: 100,
    maxSec: 1,
    now: () => clock,
    sample: async () => ({ rssMb: 10, processes: 1 }),
  });
  clock = 1500;
  await sleep(260);
  const stats = await monitor.stop();
  assert.equal(stats.exceeded?.code, 'BUDGET_EXCEEDED');
  assert.match(String(stats.exceeded?.detail), /elapsed|budget/);
});

test('P24：读不到进程树（ps 被禁）时自动降级到整机口径并标记 source=system', async () => {
  /** @type {number[]} */
  const freeSeries = [8000, 7800, 7400, 7200];
  let i = 0;
  const monitor = startResourceMonitor({
    intervalMs: 100,
    maxRssMb: 500,
    sample: async () => {
      throw new Error('spawn ps EPERM');
    },
    sampleSystem: async () => freeSeries[Math.min(i++, freeSeries.length - 1)] ?? 7400,
  });
  await sleep(460);
  const stats = await monitor.stop();
  assert.equal(stats.source, 'system');
  assert.ok(stats.peakMb >= 500, `peak=${stats.peakMb}`);
  assert.equal(stats.exceeded?.code, 'BUDGET_EXCEEDED');
});

test('P24：vm_stat 解析（page size × Pages free）', async () => {
  const fakeRun = async () => ({
    stdout: 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:  1000.\nPages active: 5.\n',
    stderr: '',
  });
  const freeMb = await readSystemFreeMemMb(fakeRun);
  assert.equal(freeMb, 15.6); // 1000 * 16384 / 1024 / 1024
});

test('P24：不超限时 stop() 也要给出峰值（成功路径要有数字）', async () => {
  const monitor = startResourceMonitor({
    intervalMs: 100,
    maxRssMb: 99999,
    sample: async () => ({ rssMb: 42, processes: 1 }),
  });
  await sleep(260);
  const stats = await monitor.stop();
  assert.equal(stats.exceeded, null);
  assert.equal(stats.peakMb, 42);
  assert.ok(stats.samples >= 1);
});
