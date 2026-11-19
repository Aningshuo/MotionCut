/**
 * `subtitleLineStep()` 的单测（ADR-R37-03）。
 *
 * 只钉死三件事：默认 1.25 → 1em（所以默认路径不需要 `\pos`、ASS 逐字节不变）、
 * 换算连续（1.8 → 1.44、1.0 → 0.8）、非法值回落默认。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { subtitleLineStep } from './subtitle-layout.mjs';

test('默认线高 1.25 → 1em，且标记 isDefault', () => {
  const step = subtitleLineStep({ lineHeight: 1.25 });
  assert.equal(step.em, 1);
  assert.equal(step.isDefault, true);
});

test('缺省 / 非法值都回落 1.25', () => {
  for (const style of [{}, { lineHeight: undefined }, { lineHeight: 0 }, { lineHeight: -2 }, { lineHeight: Number.NaN }]) {
    const step = subtitleLineStep(style);
    assert.equal(step.lineHeight, 1.25, JSON.stringify(style));
    assert.equal(step.em, 1);
    assert.equal(step.isDefault, true);
  }
});

test('放大与收紧都按 1.25 为基准线性换算', () => {
  assert.ok(Math.abs(subtitleLineStep({ lineHeight: 1.8 }).em - 1.44) < 1e-9);
  assert.ok(Math.abs(subtitleLineStep({ lineHeight: 1.0 }).em - 0.8) < 1e-9);
  assert.equal(subtitleLineStep({ lineHeight: 1.8 }).isDefault, false);
});

test('1.26 不会被当成默认（避免浮点比较把边界吞掉）', () => {
  const step = subtitleLineStep({ lineHeight: 1.26 });
  assert.equal(step.isDefault, false);
  assert.ok(step.em > 1);
});
