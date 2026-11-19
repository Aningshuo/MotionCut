/**
 * P17 的单元测试：画质档映射。
 *
 * 只测参数层（秒级）：三档齐全、默认值、非法档名报错、描述顺序稳定。
 * 真实编码质量（MAE/p99）由 `scripts/film-parity.mjs` 在整片上量，不在单测里做。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_QUALITY, QUALITY_NAMES, QUALITY_LEVELS, describeQualities, resolveQuality } from '../quality.mjs';

test('P17 档位：三档齐全，默认 standard，且每档都带 pixFmt', () => {
  assert.deepEqual([...QUALITY_NAMES], ['draft', 'standard', 'high']);
  assert.equal(DEFAULT_QUALITY, 'standard');
  for (const name of QUALITY_NAMES) {
    const level = resolveQuality(name);
    assert.equal(level.name, name);
    assert.ok(Number.isInteger(level.crf), `${name}.crf 必须是整数`);
    assert.equal(typeof level.preset, 'string');
    assert.ok(['yuv420p', 'yuv444p'].includes(level.pixFmt), `${name}.pixFmt 必须是已知色度格式`);
  }
});

test('P17 档位：standard 必须用 4:4:4（4:2:0 有 p99 地板，见 quality.mjs 头注释）', () => {
  /** @type {(name: string) => any} */
  const levelOf = (name) => /** @type {any} */ (QUALITY_LEVELS)[name];
  assert.equal(levelOf('standard').pixFmt, 'yuv444p');
  // draft 允许 4:2:0：它的定位是体积/兼容性，不是交付画质
  assert.equal(levelOf('draft').pixFmt, 'yuv420p');
});

test('P17 档位：不传档名走默认，传错档名报 INVALID_QUALITY（不是静默回落）', () => {
  assert.equal(resolveQuality(undefined).name, 'standard');
  assert.equal(resolveQuality('').name, 'standard');
  assert.throws(
    () => resolveQuality('ultra'),
    (/** @type {any} */ err) => err.code === 'INVALID_QUALITY' && /expected one of draft\|standard\|high/.test(err.message),
  );
});

test('P17 档位：describeQualities 给出稳定顺序，便于 CLI/证据直接打印', () => {
  const rows = describeQualities();
  assert.deepEqual(rows.map((r) => r.name), ['draft', 'standard', 'high']);
  assert.equal(/** @type {any} */ (rows[1]).pixFmt, 'yuv444p');
});
