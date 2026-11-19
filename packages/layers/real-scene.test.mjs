// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S8-REAL-SCENE-REGRESS 验收 A1..A9
 *
 * 用计划包自带的真实样例（平铺根：film.html + scene-a.html + scene-b.html + assets/）
 * 与参考 bench 场景（title/third/sparks）跑 discover → locate → revalidate → apply-overrides
 * 的真实链路；样例只读，按原相对布局复制到本批 projects/ 再用。
 *
 * 运行：node --test --test-concurrency=1 packages/layers/real-scene.test.mjs（env 由 test-env.mjs 自动准备；`OPENCUT_ENV_JSON` 可显式覆盖）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SceneHost, REPO_ROOT } from '../scene-runtime/host.mjs';
import { resolveLayerTestEnv } from './test-env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 运行根跟随本批 env，避免把复跑证据写回已冻结的旧批次目录。 */
const TEST_ENV = await resolveLayerTestEnv({ suite: 'real-scene' });
const ENV_PATH = TEST_ENV.envPath;
const RUN_ROOT = path.dirname(ENV_PATH);
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');
const PROJECTS = path.join(RUN_ROOT, 'projects');

/* 等待预算（R50 · S60）：S8-A1 的四次 discover 每次都从 `frame(t)` 起，其中 `frame(0)`
 * 是刚 open 的页面第一帧（含预热，跑两遍六步）。8 个测试文件并行时这一帧实测越过 5s，
 * 红成 `FRAME_TIMEOUT: film.frame(0) 超过 5000ms 未完成`。诊断见
 * `evidence/rounds/R50-SUB1/s60-diagnosis.json`（纯压力，不是死锁、不是产品缺陷）。
 *
 * 两处一起抬：舞台运行时的内侧预算（`OPENCUT_FRAME_TIMEOUT_MS`，默认仍 4000）与
 * SceneHost 的 frame/ready 预算（默认 5000）。产品默认与判据都没动。
 */
const WAIT_BUDGET_MS = 12000;
process.env.OPENCUT_FRAME_TIMEOUT_MS = String(WAIT_BUDGET_MS);

const SAMPLE = '/tmp/motioncut-optional-scene-fixture';
const BENCH = '/Users/example/Documents/ChatGPT/ai剪辑工作台/research/references/openfilm-latest-20261106-3e6b217a/apps/desktop/bench/fixture/scenes';

const { revalidateOverrides, STATUS } = await import(new URL('./revalidate.mjs', import.meta.url).href);
const { discover } = await import(new URL('./discover.ts', import.meta.url).href);
const { locate } = await import(new URL('./locate.ts', import.meta.url).href);
const { applyOverrides, readTransform, OVERRIDE_APPLY_STAGE, TRANSFORM_OWNER } = await import(
  new URL('./apply-overrides.mjs', import.meta.url).href
);

const evidence = { batch: 'B-SUB1-R4-004R1', suite: 'real-scene.test.mjs', cases: {}, startedAt: new Date().toISOString() };

const ROOT = path.join(PROJECTS, `r4-sample-${process.pid}`);
const A_REL_SRC = path.join(ROOT, 'scene-a.html');
const B_REL_SRC = path.join(ROOT, 'scene-b.html');

/** @type {SceneHost} */
let host;
let port;
let relA;
let relB;

async function save() {
  evidence.finishedAt = new Date().toISOString();
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(path.join(EVIDENCE_DIR, 's8-real-scene.json'), JSON.stringify(evidence, null, 2) + '\n');
}

function rel(file) {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

async function startHost() {
  host = await new SceneHost({
    port,
    /* 压力预算，见文件头 WAIT_BUDGET_MS 的注释 */
    frameTimeoutMs: WAIT_BUDGET_MS,
    readyTimeoutMs: WAIT_BUDGET_MS
  }).start();
}

before(async () => {
  const env = JSON.parse(await fs.readFile(ENV_PATH, 'utf8'));
  port = Number(env.studioPort);
  evidence.batch = env.batchId ?? evidence.batch;

  // 平铺复制：保持 film.html / scene-a.html / scene-b.html / assets/ 的真实相对布局
  await fs.mkdir(ROOT, { recursive: true });
  await fs.cp(SAMPLE, ROOT, { recursive: true });
  // 参考 bench 场景也平铺
  for (const f of ['title.html', 'third.html', 'sparks.html']) {
    await fs.copyFile(path.join(BENCH, f), path.join(ROOT, f));
  }
  relA = rel(A_REL_SRC);
  relB = rel(B_REL_SRC);
  await startHost();
});

after(async () => {
  await save();
  if (host) await host.stop();
});

/** 同一个页面在多个 t 上取 discover，返回每次的 at 序列。 */
async function discoverAt(handle, clipId, times) {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const t of times) {
    await host.frame(handle, { t });
    const res = await discover(handle.page, clipId, t);
    assert.ok(!('error' in res), `${clipId}@${t}: ${JSON.stringify(res)}`);
    out[String(t)] = res.layers.map((l) => l.at);
  }
  return out;
}

test('S8-A1 scene-a：t=0/1/2/3.9 四次 discover，同一节点 at 相同', async () => {
  const handle = await host.open(relA);
  const runs = await discoverAt(handle, 'clip-a', [0, 1, 2, 3.9]);
  const base = runs['0'];
  assert.ok(base.includes('#title'), base.join(' | '));
  for (const t of ['1', '2', '3.9']) {
    assert.deepEqual(runs[t], base, `t=${t} 的 at 与 t=0 不同`);
  }
  await handle.dispose();

  evidence.cases['S8-A1'] = { ok: true, layers: base.length, atSample: base.slice(0, 6) };
});

test('S8-A2 scene-b：同上；两场景结构同构但内容不同，不串树', async () => {
  const handle = await host.open(relB);
  const runs = await discoverAt(handle, 'clip-b', [0, 1, 2, 3.9]);
  const base = runs['0'];
  for (const t of ['1', '2', '3.9']) assert.deepEqual(runs[t], base);

  // 读两边的文本值：结构相同（at 集合一致），但值必须各自来自自己的源
  const readText = async (relPath, id) => {
    const h = await host.open(relPath);
    const r = await h.page.evaluate((sel) => document.querySelector(sel)?.textContent ?? null, id);
    await h.dispose();
    return r;
  };
  const aTitle = await readText(relA, '#title');
  const bTitle = await readText(relB, '#title');
  assert.equal(aTitle, '图层编辑测试');
  assert.equal(bTitle, '第二段标题');
  assert.notEqual(aTitle, bTitle);

  const aSet = new Set(base);
  const bSet = new Set(runs['0']);
  assert.deepEqual([...aSet].sort(), [...bSet].sort(), '同构样例的 at 集合应一致');
  await handle.dispose();

  evidence.cases['S8-A2'] = {
    ok: true,
    layers: base.length,
    sameStructure: true,
    aTitle,
    bTitle,
    note: 'scene-a/scene-b 结构同构（同 id 同层级），所以 at 集合相同；差异在文本/样式值，已核对不串树'
  };
});

test('S8-A3 加节点 KEPT；调换同级 MOVED 且值不变', async () => {
  const src = await fs.readFile(A_REL_SRC, 'utf8');

  /* (a) 在末尾追加一个节点：已有节点的路径不变 → KEPT */
  const added = src.replace('</div></div><script', '<div class="chip" data-name="new-chip">新增</div></div></div><script');
  const keptOverride = { at: '#title', t: '标题（改）' };
  const kept = revalidateOverrides({ oldHtml: src, newHtml: added, overrides: [keptOverride], now: 0 });
  assert.equal(kept.entries[0].status, STATUS.KEPT);
  assert.deepEqual(kept.suggestedOverrides[0], keptOverride);

  /* (b) 去掉三个 bar 的 id、改成 data-name（无 id 场景），再对调 two/three 的顺序 */
  const noid = src
    .replace('id="bar-one"', 'data-name="bar-one"')
    .replace('id="bar-two"', 'data-name="bar-two"')
    .replace('id="bar-three"', 'data-name="bar-three"');
  const swapped = noid
    .replace('<div class="bar two" data-name="bar-two"></div><div class="bar three" data-name="bar-three"></div>',
      '<div class="bar three" data-name="bar-three"></div><div class="bar two" data-name="bar-two"></div>');
  assert.notEqual(swapped, noid);

  const at = 'body > div.stage:nth-of-type(1) > div.panel:nth-of-type(1) > div.chart:nth-of-type(1) > div.bar:nth-of-type(2)';
  const movedOverride = { at, t: '第二根柱子' };
  const moved = revalidateOverrides({ oldHtml: noid, newHtml: swapped, overrides: [movedOverride], now: 0 });
  assert.equal(moved.entries[0].status, STATUS.MOVED, JSON.stringify(moved.entries[0]));
  assert.equal(moved.entries[0].newAt, at.replace('nth-of-type(2)', 'nth-of-type(3)'));
  assert.equal(moved.suggestedOverrides[0].t, '第二根柱子');

  evidence.cases['S8-A3'] = {
    ok: true,
    kept: { status: kept.entries[0].status, addedBytes: added.length - src.length },
    moved: { from: at, to: moved.entries[0].newAt, value: moved.suggestedOverrides[0] }
  };
});

test('S8-A4 删除被覆盖节点：GONE + 旁挂区，条目不被删除', async () => {
  const src = await fs.readFile(A_REL_SRC, 'utf8');
  const removed = src.replace('<div class="badge" id="badge">独立测试</div>', '');
  assert.notEqual(removed, src);
  const override = { at: '#badge', t: '徽标（改）' };

  const r = revalidateOverrides({ oldHtml: src, newHtml: removed, overrides: [override], now: 0 });
  assert.equal(r.entries[0].status, STATUS.GONE);
  assert.deepEqual(r.orphanedOverrides, [override]);
  assert.equal(r.suggestedOverrides.length, 0);
  assert.equal(r.conflict.content.entries[0].reason, 'LAYER_GONE');
  assert.equal(r.conflict.content.entries[0].at, '#badge');

  evidence.cases['S8-A4'] = { ok: true, status: r.entries[0].status, orphaned: r.orphanedOverrides, conflict: r.conflict.path };
});

test('S8-A5 同名多节点：AMBIGUOUS，不自动改；冲突含旧 at/候选/原因', async () => {
  const src = await fs.readFile(B_REL_SRC, 'utf8');
  const dup = src.replace('</div></div><script', '<div class="badge" id="badge">重复徽标</div></div></div><script');
  assert.notEqual(dup, src);
  const override = { at: '#badge', style: { 'background-color': 'rgb(228, 232, 222)' } };

  const r = revalidateOverrides({ oldHtml: src, newHtml: dup, overrides: [override], now: '2026-11-07T05:00:00.000Z' });
  assert.equal(r.entries[0].status, STATUS.AMBIGUOUS);
  assert.ok(r.entries[0].candidates.length >= 2);
  assert.deepEqual(r.suggestedOverrides[0], override, 'AMBIGUOUS 不得自动改 at');

  const entry = JSON.parse(r.conflict.text).entries[0];
  assert.equal(entry.at, '#badge');
  assert.equal(entry.status, 'AMBIGUOUS');
  assert.ok(entry.candidates.length >= 2);
  assert.ok(entry.candidates.every((c) => c.at.startsWith('body >')));

  evidence.cases['S8-A5'] = { ok: true, candidates: r.entries[0].candidates, conflict: r.conflict.path };
});

test('S8-A6 apply-overrides：text/style/lock/s/r 各自生效，读数为证', async () => {
  const handle = await host.open(relA);
  const page = handle.page;

  const entries = [
    { at: '#title', t: '改过的标题', style: { color: 'rgb(255, 45, 85)' }, lock: true },
    { at: '#bar-one', s: 1.5, r: 30 }
  ];
  const applied = await applyOverrides(page, entries);
  assert.equal(applied.applied, 2, JSON.stringify(applied));
  assert.deepEqual(applied.missed, []);

  const read = await page.evaluate(() => {
    const title = document.getElementById('title');
    const bar = document.getElementById('bar-one');
    const csBar = getComputedStyle(bar);
    return {
      text: title.textContent,
      color: getComputedStyle(title).color,
      locked: title.getAttribute('data-locked'),
      pointerEvents: getComputedStyle(title).pointerEvents,
      transform: csBar.transform,
      transformAttr: bar.getAttribute('data-ov-transform')
    };
  });

  assert.equal(read.text, '改过的标题');
  assert.equal(read.color, 'rgb(255, 45, 85)');
  assert.equal(read.locked, '1');
  assert.equal(read.pointerEvents, 'none');
  /* S9 起 s/r 落在 CSS 个体属性 scale/rotate 上，transform 留给场景；语义仍是 s=1.5 r=30 生效 */
  assert.equal(read.transformAttr, 'scale rotate');
  assert.equal(read.transform, 'none', '场景没有 transform 时不该被覆盖写');

  const m = await readTransform(page, '#bar-one');
  const close = (x, y) => Math.abs(x - y) < 0.01;
  const [a, b, c, d] = [m.matrix.a, m.matrix.b, m.matrix.c, m.matrix.d];
  assert.equal(m.scale, '1.5');
  assert.equal(m.rotate, '30deg');
  assert.ok(close(a, 1.5 * Math.cos(Math.PI / 6)), `a=${a}`);
  assert.ok(close(b, 1.5 * Math.sin(Math.PI / 6)), `b=${b}`);
  assert.ok(close(c, -1.5 * Math.sin(Math.PI / 6)), `c=${c}`);
  assert.ok(close(d, 1.5 * Math.cos(Math.PI / 6)), `d=${d}`);

  await handle.dispose();

  evidence.cases['S8-A6'] = {
    ok: true,
    applyStage: OVERRIDE_APPLY_STAGE,
    transformOwner: TRANSFORM_OWNER,
    coverage: ['text', 'style', 'lock', 's', 'r'],
    read,
    matrix: { a, b, c, d },
    note: 'S9 起 s/r 写成 CSS 个体属性 scale/rotate，transform 归场景；本用例场景无 transform，均匀缩放下矩阵与旧写法数值等价'
  };
});

test('S8-A7 先 frame(t) 后应用覆盖：t=1 与 t=1.6 两次都盖住动画值', async () => {
  const handle = await host.open(relA);
  const page = handle.page;
  const readBar = () => page.evaluate(() => document.getElementById('bar-one').style.height);
  const override = [{ at: '#bar-one', style: { height: '33px' } }];

  await host.frame(handle, { t: 1 });
  const anim1 = await readBar();
  const r1 = await applyOverrides(page, override);
  const after1 = await readBar();
  assert.equal(r1.applied, 1);
  assert.equal(after1, '33px', `t=1：动画 ${anim1}，应用后应为 33px`);

  await host.frame(handle, { t: 1.6 });
  const anim2 = await readBar();
  await applyOverrides(page, override);
  const after2 = await readBar();
  assert.equal(after2, '33px');
  assert.notEqual(anim1, anim2, '场景自身的动画值应在两个时刻不同，才说明覆盖真的盖住了它');

  await handle.dispose();

  evidence.cases['S8-A7'] = { ok: true, t1: { anim: anim1, applied: after1 }, t16: { anim: anim2, applied: after2 } };
});

test('S8-A8 重开浏览器上下文后 locate 仍命中（at 稳定）', async () => {
  const at = '#subtitle';
  const h1 = await host.open(relA);
  const first = await locate(h1.page, 'clip-a', at);
  assert.ok(!('error' in first), JSON.stringify(first));
  await h1.dispose();

  /* 真重开：停掉 host（浏览器/上下文全关），在同一个端口起一套新的 */
  await host.stop();
  await startHost();

  const h2 = await host.open(relA);
  const second = await locate(h2.page, 'clip-a', at);
  assert.ok(!('error' in second), `重开后定位失败：${second.error?.code}`);
  assert.equal(second.ref.at, at);
  assert.equal(second.ref.name.length > 0, true);
  await h2.dispose();

  evidence.cases['S8-A8'] = { ok: true, at, reopened: true, name: second.ref.name };
});

test('S8-A9 1000 节点 + 20 条覆盖：一次 revalidate < 500ms', async () => {
  const cells = (n) =>
    Array.from({ length: n }, (_, i) => `<div class="cell" data-name="c${i}">${i}</div>`).join('');
  const oldHtml = `<html><body><section class="grid">${cells(1000)}</section></body></html>`;
  const reordered = Array.from({ length: 1000 }, (_, i) => i).filter((i) => i !== 7);
  const head = reordered.slice(0, 20).reverse();
  const tail = reordered.slice(20);
  const newHtml = `<html><body><section class="grid">${[...head, ...tail]
    .map((i) => `<div class="cell" data-name="c${i}">${i}</div>`)
    .join('')}</section></body></html>`;

  const overrides = Array.from({ length: 20 }, (_, k) => ({
    at: `body > section.grid:nth-of-type(1) > div.cell:nth-of-type(${k + 1})`,
    style: { color: `rgb(${k}, 100, 150)` }
  }));

  const t0 = performance.now();
  const r = revalidateOverrides({ oldHtml, newHtml, overrides, now: 0 });
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 500, `revalidate 耗时 ${elapsed.toFixed(1)}ms 超 500ms`);
  assert.equal(r.stats.total, 20);

  evidence.cases['S8-A9'] = { ok: true, ms: Math.round(elapsed * 1000) / 1000, stats: r.stats };
});
