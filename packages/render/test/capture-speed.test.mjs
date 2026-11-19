/**
 * P19 的单元测试：并行取帧的**纯逻辑**部分。
 *
 * 这里不启动浏览器（那要几十秒），只测两件容易错、错了又很难发现的事：
 * 1. 分片计划覆盖完整且互不重叠——漏一帧或重一帧，导出就会缺帧/覆盖；
 * 2. 并发数收敛——别为 3 帧开 6 个 page，也别把用户的显式要求吞掉。
 *
 * 真正的「并行与串行输出逐字节相同」在整片导出里验（见 R10 交接的 pixel-diff），
 * 不是单测能覆盖的。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clampConcurrency, shardPlan } from '../stage-capture.mjs';

test('P19 分片：连续分片覆盖 0..N-1 且互不重叠', () => {
  /** @type {Array<[number, number]>} */
  const cases = [
    [900, 3],
    [240, 6],
    [901, 4],
    [7, 3],
    [1, 4],
  ];
  for (const [frames, workers] of cases) {
    const plan = shardPlan(frames, workers, 'contiguous');
    const flat = plan.flat().sort((a, b) => a - b);
    assert.equal(flat.length, frames, `${frames}/${workers} 帧数不对`);
    assert.deepEqual(flat, Array.from({ length: frames }, (_v, i) => i), `${frames}/${workers} 覆盖不全`);
  }
});

test('P19 分片：轮转分片同样覆盖完整，且相邻帧落在不同通道', () => {
  const plan = shardPlan(10, 3, 'round-robin');
  assert.deepEqual(plan.flat().sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(plan[0], [0, 3, 6, 9]);
  assert.deepEqual(plan[1], [1, 4, 7]);
  assert.deepEqual(plan[2], [2, 5, 8]);
});

test('P19 分片：两种模式的**帧号集合相同**（只是分配方式不同）', () => {
  const a = shardPlan(900, 5, 'contiguous').flat().sort((x, y) => x - y);
  const b = shardPlan(900, 5, 'round-robin').flat().sort((x, y) => x - y);
  assert.deepEqual(a, b);
});

test('P19 分片：通道数多于帧数时不产生空转分片（空数组也不算错）', () => {
  const plan = shardPlan(2, 5, 'contiguous');
  assert.equal(plan.length, 5);
  assert.equal(plan.flat().length, 2);
  assert.deepEqual(plan.flat().sort((a, b) => a - b), [0, 1]);
});

test('P19 并发：帧少时自动收敛，不为了 3 帧开 6 页', () => {
  assert.equal(clampConcurrency(undefined, 6, 3), 1);
  assert.equal(clampConcurrency(undefined, 6, 240), 6);
  assert.equal(clampConcurrency(6, 3, 900), 6); // 显式优先于默认
  assert.equal(clampConcurrency(1, 6, 900), 1); // 显式退串行
  assert.equal(clampConcurrency(99, 3, 900), 16); // 上限 16
  assert.equal(clampConcurrency(0.4, 3, 900), 1); // 0 → 至少 1
});
