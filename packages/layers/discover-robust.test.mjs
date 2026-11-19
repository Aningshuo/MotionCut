// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S7-TREE-ROBUST 验收 A7 / A8
 *
 * A7 连续改 DOM 的场scene：同一 t 两次 discover 的 at 序列相同（t 无关性）；
 *    换一个 t 也相同（结构没变，只有文本/样式变）。
 * A8 1000 节点：discover < 300ms，at 无重复。
 *
 * 运行：node --test --test-concurrency=1 packages/layers/discover-robust.test.mjs（env 由 test-env.mjs 自动准备；`OPENCUT_ENV_JSON` 可显式覆盖）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SceneHost, REPO_ROOT } from '../scene-runtime/host.mjs';
import { resolveLayerTestEnv } from './test-env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* 跟随本批 env：复跑时不覆写已冻结的 R4.1 证据（S7 的证据留在 runs/R4.1）。 */
const TEST_ENV = await resolveLayerTestEnv({ suite: 'discover-robust' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');

const { discover } = await import(new URL('./discover.ts', import.meta.url).href);

const evidence = { batch: 'B-SUB1-R4-004R1', suite: 'discover-robust.test.mjs', cases: {}, startedAt: new Date().toISOString() };

/** @type {SceneHost} */
let host;

async function save() {
  evidence.finishedAt = new Date().toISOString();
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(path.join(EVIDENCE_DIR, 's7-discover-robust.json'), JSON.stringify(evidence, null, 2) + '\n');
}

before(async () => {
  const env = JSON.parse(await fs.readFile(process.env.OPENCUT_ENV_JSON ?? path.join(RUN_ROOT, 'env.json'), 'utf8'));
  evidence.batch = env.batchId ?? evidence.batch;
  evidence.rerunOf = 'B-SUB1-R4-004R1';
  host = await new SceneHost({ port: Number(env.studioPort) }).start();
});

after(async () => {
  await save();
  if (host) await host.stop();
});

test('S7-A7 连续改 DOM 的场景：同一 t 两次 discover 的 at 相同（t 无关）', async () => {
  const handle = await host.open('tests/fixtures/scenes/dynamic-dom.html');

  const atOf = async (t) => {
    await host.frame(handle, { t });
    const res = await discover(handle.page, 'clip-churn', t);
    assert.ok(!('error' in res), JSON.stringify(res));
    return res.layers.map((l) => l.at);
  };

  const a1 = await atOf(1);
  const a2 = await atOf(1);
  assert.deepEqual(a1, a2, '同一 t 两次 discover 必须完全一致');
  assert.equal(new Set(a1).size, a1.length, 'at 不得重复');

  const b1 = await atOf(1.999);
  assert.deepEqual(a1, b1, '结构没变时，不同 t 的 at 也必须一致');

  const c1 = await atOf(0);
  assert.deepEqual(a1, c1);

  // 顺序敏感：动态节点每一帧都重建，at 仍要落回同一位置
  const rows = await handle.page.evaluate(() =>
    Array.from(document.querySelectorAll('.dyn')).map((el) => el.getAttribute('data-i'))
  );
  assert.equal(rows.length, 20);

  evidence.cases['S7-A7'] = { ok: true, layers: a1.length, atSample: a1.slice(0, 5), runs: ['t=1', 't=1', 't=1.999', 't=0'] };
  await handle.dispose();
});

test('S7-A8 1000 节点：discover < 300ms，at 无重复', async () => {
  const handle = await host.open('tests/fixtures/scenes/layers-1000.html');
  const t0 = Date.now();
  const res = await discover(handle.page, 'clip-1000', 0, { includeInvisible: true });
  const wall = Date.now() - t0;

  assert.ok(!('error' in res), JSON.stringify(res));
  const ats = res.layers.map((l) => l.at);
  assert.ok(ats.length >= 1000, `层数 ${ats.length}`);
  assert.equal(new Set(ats).size, ats.length, 'at 不得重复');
  assert.ok(res.stats.elapsedMs < 300, `页面内耗时 ${res.stats.elapsedMs}ms 超 300ms`);
  assert.ok(wall < 3000, `宿主侧耗时 ${wall}ms（含 IPC）异常`);

  evidence.cases['S7-A8'] = {
    ok: true,
    layers: ats.length,
    elapsedMs: res.stats.elapsedMs,
    hostWallMs: wall,
    nodes: res.stats.nodes,
    sample: ats.slice(0, 3)
  };
  await handle.dispose();
});
