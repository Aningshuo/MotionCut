// @ts-nocheck —— 以 node --test 的运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * 导出区间纯函数的单测（M39 · B-MAIN-R20-020）。
 *
 * 只测「算得对、判得准」：两种时间写法、段数边界、顺序原样、逐段估算。
 * 真导出（120 帧 / 4.000s / 两对 p99）由 `scripts/m39-export-range.mjs` 在真 Studio 上验。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_ESTIMATE_FPS,
  MAX_EXPORT_RANGES,
  estimateRangePlan,
  formatRangeTime,
  parseRangeTime,
  planRangeInputs,
} from '../export-range.mjs';

test('A0 parseRangeTime：纯小数秒与 00:12.500 两种写法同值', () => {
  assert.equal(parseRangeTime('12.5'), 12.5);
  assert.equal(parseRangeTime('00:12.500'), 12.5);
  assert.equal(parseRangeTime('0:12.5'), 12.5);
  assert.equal(parseRangeTime('00:00:12,500'), 12.5);
  assert.equal(parseRangeTime('.5'), 0.5);
  assert.equal(parseRangeTime('12'), 12);
  assert.equal(parseRangeTime(12.5), 12.5);
  assert.equal(parseRangeTime(0), 0);
});

test('A0 parseRangeTime：坏输入一律 null，不猜 0', () => {
  assert.equal(parseRangeTime(''), null);
  assert.equal(parseRangeTime('   '), null);
  assert.equal(parseRangeTime('坏'), null);
  assert.equal(parseRangeTime('-1'), null);
  assert.equal(parseRangeTime(-1), null);
  assert.equal(parseRangeTime('1e3'), null);
  assert.equal(parseRangeTime('00:99:00.000'), null);
  assert.equal(parseRangeTime(null), null);
  assert.equal(parseRangeTime(undefined), null);
  assert.equal(parseRangeTime({}), null);
});

test('A0 formatRangeTime：写回再解析是同一个数', () => {
  for (const value of [0, 2, 2.5, 12.125, 0.001, 123.456]) {
    assert.equal(parseRangeTime(formatRangeTime(value)), value, `round-trip ${value}`);
  }
  assert.equal(formatRangeTime(12), '12');
  assert.equal(formatRangeTime(12.5), '12.5');
});

test('A1 两段 [2,4] + [6,8]：顺序原样、总长 4s、帧数 120', () => {
  const planned = planRangeInputs([
    { start: '2', end: '4' },
    { start: '00:06.000', end: '8' },
  ]);
  assert.equal(planned.ok, true);
  assert.deepEqual(planned.ranges, [
    [2, 4],
    [6, 8],
  ]);
  assert.equal(planned.totalSec, 4);
  assert.equal(planned.frames, 120);
  assert.equal(planned.fps, DEFAULT_ESTIMATE_FPS);
});

test('A3 顺序不重排：6:8 在前就是在前', () => {
  const planned = planRangeInputs([
    { start: '6', end: '8' },
    { start: '2', end: '4' },
  ]);
  assert.equal(planned.ok, true);
  assert.deepEqual(planned.ranges, [
    [6, 8],
    [2, 4],
  ]);
});

test('A5 校验：0 段 / 101 段 / start≥end / 解析失败，逐条带第几段', () => {
  const empty = planRangeInputs([]);
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'INVALID_RANGE');
  assert.equal(empty.issue.index, -1);

  const tooMany = planRangeInputs(Array.from({ length: MAX_EXPORT_RANGES + 1 }, () => ({ start: '0', end: '1' })));
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.message, /最多 100 段/);

  const inverted = planRangeInputs([
    { start: '0', end: '1' },
    { start: '4', end: '2' },
  ]);
  assert.equal(inverted.ok, false);
  assert.equal(inverted.issue.index, 2);
  assert.equal(inverted.issue.field, 'end');

  const equal = planRangeInputs([{ start: '3', end: '3' }]);
  assert.equal(equal.ok, false);
  assert.equal(equal.issue.index, 1);

  const bad = planRangeInputs([
    { start: '0', end: '1' },
    { start: '6', end: '八' },
  ]);
  assert.equal(bad.ok, false);
  assert.equal(bad.issue.index, 2);
  assert.equal(bad.issue.field, 'end');
});

test('A5 越界：给了 duration 就带第几段与实际时长', () => {
  const out = planRangeInputs(
    [
      { start: '0', end: '1' },
      { start: '2', end: '10' },
    ],
    { duration: 6 },
  );
  assert.equal(out.ok, false);
  assert.equal(out.issue.index, 2);
  assert.match(out.message, /第 2 段/);
  assert.match(out.message, /6s/);

  const exact = planRangeInputs([{ start: '0', end: '6' }], { duration: 6 });
  assert.equal(exact.ok, true);
});

test('A1 逐段四舍五入：4 段各 0.49 帧不是先求总和', () => {
  const estimate = estimateRangePlan(
    [
      [0, 0.0163],
      [1, 1.0163],
      [2, 2.0163],
      [3, 3.0163],
    ],
    30,
  );
  /* 每段 round(0.489) = 0 */
  assert.equal(estimate.frames, 0);
  assert.equal(estimate.segments, 4);
});

test('A1 数组形态也收（脚本/接口直接用数字元组）', () => {
  const planned = planRangeInputs([
    [2, 4],
    [6, 8],
  ]);
  assert.equal(planned.ok, true);
  assert.deepEqual(planned.ranges, [
    [2, 4],
    [6, 8],
  ]);
  assert.equal(planned.frames, 120);
});

test('A0 数字字符串与数字混用：结果一致', () => {
  const a = planRangeInputs([{ start: 2, end: 4 }]);
  const b = planRangeInputs([{ start: '2', end: '4' }]);
  const c = planRangeInputs([{ start: '00:02.000', end: '00:04.000' }]);
  assert.deepEqual(a.ranges, b.ranges);
  assert.deepEqual(a.ranges, c.ranges);
});
