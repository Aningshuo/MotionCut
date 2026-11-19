import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeRenderBudget, detectRenderBudget, BYTES_PER_GIB } from '../budget.mjs';

/** 手算期望，与实现独立。 */
const CASES = [
  // min(cpu-1=7, mem 8GiB/2=4, ceil(300/120)=3, 4) = 3
  { cpu: 8, memGiB: 8, frames: 300, expect: 3, basis: { cpu: 8, freeMemBytes: 8 * BYTES_PER_GIB, frames: 300 } },
  // min(1, 4, 9, 4) = 1
  { cpu: 2, memGiB: 8, frames: 1000, expect: 1 },
  // min(15, 16, 1, 4) = 1
  { cpu: 16, memGiB: 32, frames: 100, expect: 1 },
  // min(5, 3, 17, 4) = 3
  { cpu: 6, memGiB: 6, frames: 2000, expect: 3 },
];

test('P4-A1 自动预算四组输入与手算一致，basis 落盘', () => {
  for (const item of CASES) {
    const budget = computeRenderBudget({
      cpu: item.cpu,
      freeMemBytes: item.memGiB * BYTES_PER_GIB,
      frames: item.frames,
    });
    assert.equal(budget.source, 'auto');
    assert.equal(budget.workers, item.expect, `cpu=${item.cpu} mem=${item.memGiB} frames=${item.frames}`);
    assert.deepEqual(budget.basis, item.basis ?? {
      cpu: item.cpu,
      freeMemBytes: item.memGiB * BYTES_PER_GIB,
      frames: item.frames,
    });
  }
});

test('P4-A1 上限 4 是自动默认；下限恒为 1', () => {
  assert.equal(computeRenderBudget({ cpu: 64, freeMemBytes: 128 * BYTES_PER_GIB, frames: 100000 }).workers, 4);
  assert.equal(computeRenderBudget({ cpu: 1, freeMemBytes: 0, frames: 0 }).workers, 1);
  assert.equal(computeRenderBudget({ cpu: 2, freeMemBytes: 0, frames: 10 }).workers, 1);
  // 内存按 2GiB 向下取整：3GiB 只够 1 个。
  assert.equal(computeRenderBudget({ cpu: 8, freeMemBytes: 3 * BYTES_PER_GIB, frames: 1000 }).workers, 1);
});

test('P4-A2 用户 workers=8 → source=user，不被 4 卡死', () => {
  const budget = computeRenderBudget({
    cpu: 8,
    freeMemBytes: 8 * BYTES_PER_GIB,
    frames: 150,
    userWorkers: 8,
  });
  assert.deepEqual(budget, { source: 'user', workers: 8 });
});

test('P4-A1 输入校验：非法值直接报错，不静默兜底', () => {
  assert.throws(() => computeRenderBudget({ cpu: 0, freeMemBytes: 1, frames: 1 }), /cpu/);
  assert.throws(() => computeRenderBudget({ cpu: 4, freeMemBytes: -1, frames: 1 }), /freeMemBytes/);
  assert.throws(() => computeRenderBudget({ cpu: 4, freeMemBytes: 1, frames: -1 }), /frames/);
  assert.throws(() => computeRenderBudget({ cpu: 4, freeMemBytes: 1, frames: 1, userWorkers: 0 }), /userWorkers/);
  assert.throws(() => computeRenderBudget({ cpu: 4, freeMemBytes: 1, frames: 1, userWorkers: 1.5 }), /userWorkers/);
});

test('P4-A1 detectRenderBudget 使用注入的 os 读数', () => {
  const budget = detectRenderBudget({
    frames: 300,
    osModule: { availableParallelism: () => 8, freemem: () => 8 * BYTES_PER_GIB },
  });
  assert.equal(budget.workers, 3);
  assert.deepEqual(budget.basis, { cpu: 8, freeMemBytes: 8 * BYTES_PER_GIB, frames: 300 });

  const user = detectRenderBudget({
    frames: 300,
    userWorkers: 8,
    osModule: { availableParallelism: () => 8, freemem: () => 8 * BYTES_PER_GIB },
  });
  assert.deepEqual(user, { source: 'user', workers: 8 });
});
