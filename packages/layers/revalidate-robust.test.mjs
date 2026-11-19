// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S7-TREE-ROBUST 验收 A5 / A6（以及 S8 会用到的动态节点真实案例）
 *
 * A5 动态节点：脚本生成的节点在静态源里不存在 → revalidate 必须返回 DYNAMIC_LAYER，
 *    覆盖原样不动，冲突里写清原因与建议。
 * A6 无 at 条目（片段自有 fade）：原样保留、不参与匹配、不计入四态。
 *
 * 运行：node --test --test-concurrency=1 packages/layers/revalidate-robust.test.mjs（env 由 test-env.mjs 自动准备；`OPENCUT_ENV_JSON` 可显式覆盖）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SceneHost, REPO_ROOT } from '../scene-runtime/host.mjs';
import { resolveLayerTestEnv } from './test-env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEST_ENV = await resolveLayerTestEnv({ suite: 'revalidate-robust' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');
const TMP_ROOT = path.join(RUN_ROOT, 'tmp');

const { revalidateOverrides, STATUS } = await import(new URL('./revalidate.mjs', import.meta.url).href);
const { discover } = await import(new URL('./discover.ts', import.meta.url).href);
const { parseScene } = await import(new URL('./scene-tree.mjs', import.meta.url).href);

const evidence = { batch: 'B-SUB1-R4-004R1', suite: 'revalidate-robust.test.mjs', cases: {}, startedAt: new Date().toISOString() };
const SCENE = 'tests/fixtures/scenes/dynamic-dom.html';
const BENCH = '/Users/example/Documents/ChatGPT/ai剪辑工作台/research/references/openfilm-latest-20261106-3e6b217a/apps/desktop/bench/fixture/scenes/title.html';

/** @type {SceneHost} */
let host;

async function save() {
  evidence.finishedAt = new Date().toISOString();
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(path.join(EVIDENCE_DIR, 's7-revalidate-robust.json'), JSON.stringify(evidence, null, 2) + '\n');
}

before(async () => {
  const env = JSON.parse(await fs.readFile(process.env.OPENCUT_ENV_JSON ?? path.join(RUN_ROOT, 'env.json'), 'utf8'));
  host = await new SceneHost({ port: Number(env.studioPort) }).start();
  await fs.mkdir(TMP_ROOT, { recursive: true });
});

after(async () => {
  await save();
  if (host) await host.stop();
});

test('S7-A5 动态节点：revalidate 返回 DYNAMIC_LAYER，不静默改覆盖', async () => {
  const source = await fs.readFile(path.join(REPO_ROOT, SCENE), 'utf8');
  const tree = parseScene(source);
  assert.equal(tree.complete, true);

  const handle = await host.open(SCENE);
  await host.frame(handle, { t: 1 });
  const found = await discover(handle.page, 'clip-dyn', 1);
  assert.ok(!('error' in found), JSON.stringify(found));
  const dyn = found.layers.filter((l) => l.at.includes('.dyn'));
  assert.equal(dyn.length, 20, `动态节点数 ${dyn.length}`);

  /* 静态源里没有这些节点：离线树也解析不到它们 */
  const target = dyn[1].at;
  const override = { at: target, t: '第二行（改）' };
  const r = revalidateOverrides({ oldHtml: source, newHtml: source, overrides: [override], now: 0 });

  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].status, STATUS.DYNAMIC_LAYER);
  assert.equal(r.entries[0].reason, 'NOT_IN_OLD_SOURCE');
  assert.deepEqual(r.suggestedOverrides, [override], '动态节点的覆盖必须原样保留，不得改写');
  assert.equal(r.orphanedOverrides.length, 0, '不能当成 GONE 丢到旁挂区');
  assert.equal(r.stats.dynamic, 1);
  assert.equal(r.stats.kept + r.stats.moved + r.stats.gone + r.stats.ambiguous, 0);
  assert.equal(r.conflict.content.entries[0].reason, 'NOT_IN_OLD_SOURCE');

  await handle.dispose();

  evidence.cases['S7-A5'] = {
    ok: true,
    dynamicCount: dyn.length,
    at: target,
    status: r.entries[0].status,
    conflict: r.conflict.content.entries[0]
  };
});

test('S7-A5b 真实 bench 场景：脚本生成的 letter span 同样拒绝静态重定位', async () => {
  /* bench 场景也是平铺的：title.html 直接在根上，不造 scenes/ */
  const dir = path.join(TMP_ROOT, `bench-${process.pid}`);
  await fs.mkdir(dir, { recursive: true });
  const source = await fs.readFile(BENCH, 'utf8');
  await fs.writeFile(path.join(dir, 'title.html'), source);

  const rel = path.relative(REPO_ROOT, path.join(dir, 'title.html')).split(path.sep).join('/');
  const handle = await host.open(rel);
  const found = await discover(handle.page, 'clip-bench', 0, { includeInvisible: true });
  assert.ok(!('error' in found), JSON.stringify(found));
  const spans = found.layers.filter((l) => l.at.includes(' > span:nth-of-type('));
  assert.ok(spans.length > 0, `bench title 应列出脚本生成的 span：${found.layers.map((l) => l.at).join(' | ')}`);

  const override = { at: spans[0].at, style: { color: 'rgb(255, 45, 85)' } };
  const r = revalidateOverrides({ oldHtml: source, newHtml: source, overrides: [override], now: 0 });
  assert.equal(r.entries[0].status, STATUS.DYNAMIC_LAYER);
  assert.deepEqual(r.suggestedOverrides, [override]);
  await handle.dispose();

  evidence.cases['S7-A5b'] = { ok: true, spans: spans.length, at: spans[0].at, status: r.entries[0].status };
});

test('S7-A6 无 at 条目：原样保留、不参与匹配、不计入四态', async () => {
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<ul class="rows"><li class="row" data-name="one">一</li><li class="row" data-name="two">二</li></ul>
</body></html>`;
  const moved = html.replace(
    '<li class="row" data-name="one">一</li><li class="row" data-name="two">二</li>',
    '<li class="row" data-name="two">二</li><li class="row" data-name="one">一</li>'
  );
  const own = { fade: [0.2, 0.4] };
  const first = { at: 'body > ul.rows:nth-of-type(1) > li.row:nth-of-type(1)', t: '第一行' };
  const second = { at: 'body > ul.rows:nth-of-type(1) > li.row:nth-of-type(2)', t: '第二行' };

  const r = revalidateOverrides({ oldHtml: html, newHtml: moved, overrides: [own, first, second], now: 0 });

  assert.equal(r.entries.length, 2, '自有条目不得进入判决列表');
  assert.equal(r.stats.total, 2);
  assert.equal(r.stats.own, 1);
  assert.equal(r.stats.kept + r.stats.moved + r.stats.gone + r.stats.ambiguous, 2);
  assert.deepEqual(r.ownOverrides, [own]);
  assert.deepEqual(r.suggestedOverrides[0], own, '顺序与内容都要原样');
  assert.equal(r.suggestedOverrides.length, 3);

  const again = revalidateOverrides({ oldHtml: html, newHtml: moved, overrides: [own, first, second], now: 0 });
  assert.equal(r.fingerprint, again.fingerprint, '含自有条目时也要幂等');

  evidence.cases['S7-A6'] = {
    ok: true,
    own: r.ownOverrides,
    stats: r.stats,
    suggested: r.suggestedOverrides,
    fingerprint: r.fingerprint
  };
});
