// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S6-WP16 验收 A6 / A8（真实浏览器）
 *
 * A6：覆盖必须**在每帧动画之后**应用——先取帧再应用，覆盖在；再取帧不重应用，动画把它擦掉。
 *     两个时刻都从 `getComputedStyle` 读，不靠调用日志臆断顺序。
 * A8：源里插入一行之后，重定位给出新 at；重开页面仍能定位到那个层，覆盖也仍然生效。
 *
 * 运行：node --test --test-concurrency=1 packages/layers/revalidate-browser.test.mjs（env 由 test-env.mjs 自动准备；`OPENCUT_ENV_JSON` 可显式覆盖）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SceneHost, REPO_ROOT } from '../scene-runtime/host.mjs';
import { resolveLayerTestEnv } from './test-env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEST_ENV = await resolveLayerTestEnv({ suite: 'revalidate-browser' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');
const TMP_ROOT = path.join(RUN_ROOT, 'tmp');

const { revalidateOverrides, STATUS, PERSISTENCE } = await import(new URL('./revalidate.mjs', import.meta.url).href);
const { applyOverrides } = await import(new URL('./apply-overrides.mjs', import.meta.url).href);
const { discover } = await import(new URL('./discover.ts', import.meta.url).href);
const { locate } = await import(new URL('./locate.ts', import.meta.url).href);

const evidence = { batch: 'B-SUB1-R3-003R1', suite: 'revalidate-browser.test.mjs', cases: {}, startedAt: new Date().toISOString() };
const PROJECT = path.join(TMP_ROOT, `reopen-${process.pid}`);
const SCENE_REL = 'tests/fixtures/scenes/override-frame.html';

/** @type {SceneHost} */
let host;

async function save() {
  evidence.finishedAt = new Date().toISOString();
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(path.join(EVIDENCE_DIR, 's6-revalidate-browser.json'), JSON.stringify(evidence, null, 2) + '\n');
}

function rel(file) {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

const ROWS = (items) =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>重开夹具</title>
<style>html,body{margin:0;width:800px;height:450px;background:#0f1420;color:#eef2ff;font-family:system-ui}
main.page{padding:24px}.row{font-size:20px;padding:6px 0}</style></head>
<body><main class="page"><ul class="rows">
${items.map((i) => `<li class="row" data-name="${i.name}">${i.text}</li>`).join('\n')}
</ul></main></body></html>
`;

const ROWS_V1 = ROWS([
  { name: 'one', text: '一' },
  { name: 'two', text: '二' },
  { name: 'three', text: '三' }
]);
const ROWS_V2 = ROWS([
  { name: 'zero', text: '零' },
  { name: 'one', text: '一' },
  { name: 'two', text: '二' },
  { name: 'three', text: '三' }
]);

async function readPulse(page) {
  return page.evaluate(() => {
    const el = document.getElementById('pulse');
    if (!el) return null;
    return {
      opacity: getComputedStyle(el).opacity,
      frame: document.body.dataset.filmFrame ?? null,
      caption: document.getElementById('caption')?.textContent ?? null
    };
  });
}

async function readRow(page, at) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    return { text: el.textContent, name: el.getAttribute('data-name') };
  }, at);
}

before(async () => {
  const env = JSON.parse(await fs.readFile(process.env.OPENCUT_ENV_JSON ?? path.join(RUN_ROOT, 'env.json'), 'utf8'));
  host = await new SceneHost({ port: Number(env.studioPort) }).start();
  await fs.mkdir(PROJECT, { recursive: true });
  await fs.writeFile(path.join(PROJECT, 'scene.html'), ROWS_V1);
});

after(async () => {
  await save();
  if (host) await host.stop();
});

test('S6-A6 覆盖应用顺序：先 frame(t) 后覆盖；再取帧不重应用就会被动画擦掉', async () => {
  const handle = await host.open(SCENE_REL);
  const page = handle.page;

  await host.frame(handle, { t: 1 });
  const t1 = await readPulse(page);
  assert.equal(t1.opacity, '0.5', 't=1 的动画值应为 0.2+0.3×1');
  assert.equal(t1.frame, '1');

  const applied = await applyOverrides(page, [{ at: '#pulse', style: { opacity: '0.05' } }]);
  assert.equal(applied.applied, 1);
  const afterApply = await readPulse(page);
  assert.equal(afterApply.opacity, '0.05', '取帧之后应用的覆盖必须在画面上');
  assert.equal(afterApply.frame, '1', '应用覆盖不应改变帧号');

  // 再取一帧、不重新应用：动画把覆盖写回它的值 → 证明覆盖必须每帧后应用
  await host.frame(handle, { t: 1.6 });
  const t2 = await readPulse(page);
  assert.equal(t2.frame, '1.6');
  assert.equal(t2.opacity, '0.68', '动画先写 0.2+0.3×1.6；上一帧的覆盖已被覆盖');

  // 同一帧再应用一次覆盖：值回到 0.05，帧号仍是 1.6
  await applyOverrides(page, [{ at: '#pulse', style: { opacity: '0.05' } }]);
  const t2Applied = await readPulse(page);
  assert.equal(t2Applied.opacity, '0.05');
  assert.equal(t2Applied.frame, '1.6');
  assert.equal(t2Applied.caption, 't=1.600');

  evidence.cases['S6-A6'] = { ok: true, t1, afterApply, t2, t2Applied };
  await handle.dispose();
});

test('S6-A8 重开一致：插行 → MOVED → 重开仍能定位并读到覆盖', async () => {
  const scene = path.join(PROJECT, 'scene.html');
  const h1 = await host.open(rel(scene));
  const page = h1.page;

  const found1 = await discover(page, 'clip-1', 0);
  assert.ok(!('error' in found1), JSON.stringify(found1));
  const oldAt = found1.layers.find((l) => l.at.endsWith('li.row:nth-of-type(2)'))?.at;
  assert.ok(oldAt, `找不到第二行：${found1.layers.map((l) => l.at).join(' | ')}`);
  assert.equal((await readRow(page, oldAt)).name, 'two');

  // 先写一条覆盖并应用，重开一次确认还能定位（同一个 at 仍有效）
  const override = { at: oldAt, t: '第二行（已改）' };
  await applyOverrides(page, [override]);
  assert.equal((await readRow(page, oldAt)).text, '第二行（已改）');
  await h1.dispose();

  const h2 = await host.open(rel(scene));
  const again = await locate(h2.page, 'clip-1', oldAt);
  assert.ok(!('error' in again), `重开后定位失败：${again.error?.code}`);
  assert.equal(again.ref.at, oldAt);
  await applyOverrides(h2.page, [override]);
  assert.equal((await readRow(h2.page, oldAt)).text, '第二行（已改）');
  await h2.dispose();

  // 源里在顶部插一行 → 旧 at 指向的已经变成「一」，覆盖必须跟着「二」走
  await fs.writeFile(scene, ROWS_V2);
  const r = revalidateOverrides({ oldHtml: ROWS_V1, newHtml: ROWS_V2, overrides: [override], now: 0 });
  assert.equal(r.entries[0].status, STATUS.MOVED);
  assert.equal(r.persistence, PERSISTENCE);
  const movedTo = r.suggestedOverrides[0].at;
  assert.notEqual(movedTo, oldAt);

  const h3 = await host.open(rel(scene));
  const page3 = h3.page;
  const found3 = await discover(page3, 'clip-1', 0);
  assert.ok(!('error' in found3), JSON.stringify(found3));
  assert.equal((await readRow(page3, oldAt)).name, 'one', '旧 at 现在指向别人');
  assert.equal((await readRow(page3, movedTo)).name, 'two', '新 at 必须指向原来那层');

  const located = await locate(page3, 'clip-1', movedTo);
  assert.ok(!('error' in located), `重定位后定位失败：${located.error?.code}`);

  await applyOverrides(page3, r.suggestedOverrides);
  assert.equal((await readRow(page3, movedTo)).text, '第二行（已改）');
  assert.equal((await readRow(page3, oldAt)).text, '一', '不得误伤相邻层');
  assert.equal((await readRow(page3, 'body > main.page:nth-of-type(1) > ul.rows:nth-of-type(1) > li.row:nth-of-type(4)')).text, '三');

  evidence.cases['S6-A8'] = {
    ok: true,
    oldAt,
    movedTo,
    status: r.entries[0].status,
    reopenLocate: 'ok',
    dom: {
      oldAtRow: await readRow(page3, oldAt),
      movedRow: await readRow(page3, movedTo)
    }
  };
  await h3.dispose();
});
