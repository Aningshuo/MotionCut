/**
 * 资源压力闸（P52）单测。
 *
 * 这里只测**判定逻辑**与**记录**：阈值怎么来、超过怎么算、等不到怎么拒绝、
 * 读不到进程表怎么记账。真实采样（libproc/pgrep）在 `scripts/lib/proc-sampler.mjs`，
 * 由验收脚本 `scripts/r26-p52.mjs` 拿真进程跑。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_DEFER_MS,
  DEFAULT_POLL_MS,
  PRESSURE_RATIO,
  admitUnderPressure,
  memoryLimit,
  pressureOf,
} from '../resource-guard.mjs';

/** @param {string} prefix */
async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('P52-A1 阈值：默认 = 总内存 × 0.6，来源可追溯；环境变量可覆盖', () => {
  const def = memoryLimit({});
  assert.equal(def.bytes, Math.round(os.totalmem() * PRESSURE_RATIO));
  assert.equal(def.source, `os.totalmem()*${PRESSURE_RATIO}`);
  assert.equal(def.totalBytes, os.totalmem());

  const env = memoryLimit({ OPENCUT_RENDER_MEM_LIMIT_BYTES: '1234567' });
  assert.equal(env.bytes, 1234567);
  assert.equal(env.source, 'env:OPENCUT_RENDER_MEM_LIMIT_BYTES');

  // 非法值不生效（别把 `abc` 当成 0 阈值，那会让所有作业都进不来）
  assert.equal(memoryLimit({ OPENCUT_RENDER_MEM_LIMIT_BYTES: 'abc' }).bytes, def.bytes);
});

test('P52-A1 判定：恰好等于阈值仍算 ok；读不到写 unknown（不当 0）', () => {
  assert.equal(pressureOf(100, 100).level, 'ok');
  assert.equal(pressureOf(101, 100).level, 'pressure');
  assert.equal(pressureOf(101, 100).ratio, 1.01);
  assert.equal(pressureOf(null, 100).level, 'unknown');
  assert.equal(pressureOf(/** @type {any} */ (undefined), 100).level, 'unknown');
});

test('P52-A3 压力下拒绝：不等（defer=0）→ rejected，记录里带实测值/阈值/来源', async () => {
  const registryDir = await tempDir('p52-reject-');
  const result = await admitUnderPressure({
    jobId: 'job-a',
    registryDir,
    env: { OPENCUT_RENDER_MEM_LIMIT_BYTES: '100', OPENCUT_RENDER_DEFER_MS: '0' },
    sample: async () => 4096,
  });
  assert.equal(result.action, 'rejected');
  assert.equal(result.samples, 1);
  assert.equal(result.limitBytes, 100);
  assert.equal(result.measuredBytes, 4096);

  const record = JSON.parse(await fs.readFile(/** @type {string} */ (result.recordPath), 'utf8'));
  assert.equal(record.action, 'rejected');
  assert.equal(record.measuredBytes, 4096);
  assert.equal(record.limitBytes, 100);
  assert.equal(record.limitSource, 'env:OPENCUT_RENDER_MEM_LIMIT_BYTES');
  assert.equal(record.available, true);
});

test('P52-A3 压力会等：先超后落 → deferred 若干次后 admitted，采样数 >= 2', async () => {
  const registryDir = await tempDir('p52-wait-');
  /** @type {number[]} */
  const readings = [900, 900, 50];
  let i = 0;
  const result = await admitUnderPressure({
    jobId: 'job-b',
    registryDir,
    env: { OPENCUT_RENDER_MEM_LIMIT_BYTES: '100', OPENCUT_RENDER_DEFER_MS: '5000', OPENCUT_RENDER_PRESSURE_POLL_MS: '50' },
    sample: async () => /** @type {number} */ (readings[Math.min(i++, readings.length - 1)]),
  });
  assert.equal(result.action, 'admitted');
  assert.ok(result.samples >= 2, `expected at least one deferred sample, got ${result.samples}`);
  const record = JSON.parse(await fs.readFile(/** @type {string} */ (result.recordPath), 'utf8'));
  assert.equal(record.action, 'admitted');
  assert.equal(record.measuredMb, 0); // 50 字节 → 0MB（记录里保留字节数，MB 只是给人看的）
  assert.equal(record.measuredBytes, 50);
});

test('P52 采样读不到：照常放行，但记录 available=false（不拿 0 冒充）', async () => {
  const registryDir = await tempDir('p52-unknown-');
  const result = await admitUnderPressure({
    jobId: 'job-c',
    registryDir,
    env: { OPENCUT_RENDER_MEM_LIMIT_BYTES: '100', OPENCUT_RENDER_DEFER_MS: '0' },
    sample: async () => null,
  });
  assert.equal(result.action, 'admitted');
  const record = JSON.parse(await fs.readFile(/** @type {string} */ (result.recordPath), 'utf8'));
  assert.equal(record.available, false);
  assert.equal(record.measuredBytes, null);
});

test('P52 默认值是明面上的常量（不是魔数）', () => {
  assert.equal(DEFAULT_DEFER_MS, 30_000);
  assert.equal(DEFAULT_POLL_MS, 1000);
  assert.ok(PRESSURE_RATIO > 0 && PRESSURE_RATIO < 1);
});
