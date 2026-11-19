// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S15-NESTED-GEOMETRY 验收 A1..A6
 *
 * 场景：片段在**带 transform 的容器**里（缩放/旋转）。面板输入按**屏幕像素**解释，
 * 提交前换算成声明空间的值，仍走 `set field:'box'`。全部用真 Studio 的 `/ops` 落盘。
 *
 * 容器不是新元素，而是给样例 `film.html` 的 `<section>` 加一条 CSS——
 * 这样不动物件结构（film 方言不接受 body 里塞 div/style），祖先链就是
 * `iframe#card-a → section → body → html`。
 *
 * 运行：node --test --test-concurrency=1 packages/layers/nested-geometry.test.mjs（env 由 test-env.mjs 自动准备；`OPENCUT_ENV_JSON` 可显式覆盖）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { build as esbuild } from 'esbuild';
import { SceneHost, REPO_ROOT } from '../scene-runtime/host.mjs';
import { startStudio } from '../studio/server/studio-server.mjs';
import { parse } from '../film-core/film-doc.mjs';
import { resolveLayerTestEnv } from './test-env.mjs';

const TEST_ENV = await resolveLayerTestEnv({ suite: 'nested-geometry' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');
const PROJECTS = path.join(RUN_ROOT, 'projects');
const BUNDLE_ABS = path.join(RUN_ROOT, 'tmp/s15/panel.mjs');
const BUNDLE_URL = '/' + path.relative(REPO_ROOT, BUNDLE_ABS).split(path.sep).join('/');

const SAMPLE =
  '/tmp/motioncut-optional-scene-fixture';

const BASE_CSS =
  '<style id="r8-stage">html,body{margin:0;padding:0}' +
  'section{position:relative;display:block;width:1280px;height:720px}' +
  'iframe,video,audio{position:absolute;left:0;top:0;border:0;display:block}</style>';

const DECLARED_BOX = 'left: 100px; top: 50px; width: 300px; height: 150px';

const evidence = { batch: 'B-SUB1-R8-008', suite: 'nested-geometry.test.mjs', cases: {}, studio: {}, startedAt: new Date().toISOString() };

/** @type {SceneHost} */
let host;
/** @type {any} */
let studio;

const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

async function buildBundle() {
  await fs.mkdir(path.dirname(BUNDLE_ABS), { recursive: true });
  await esbuild({
    stdin: {
      contents: [
        "export { mountInspector } from './packages/layers/inspector-panel.mjs';",
        "export { readLayer } from './packages/layers/describe.ts';",
        "export { applyOverrideEntries, applyBoxValue, clearBoxValue } from './packages/layers/apply-overrides.mjs';",
        "export { readGeometrySpace } from './packages/layers/geometry-probe.mjs';",
        "export { createOpsClient } from './packages/layers/ops-client.mjs';",
        "export { mergeOverridesAt } from './packages/layers/override-merge.mjs';",
        "export { boxToScreen, screenEditToBox } from './packages/layers/geometry-space.mjs';"
      ].join('\n'),
      resolveDir: REPO_ROOT,
      loader: 'js'
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile: BUNDLE_ABS,
    logLevel: 'silent'
  });
}

async function save() {
  evidence.finishedAt = new Date().toISOString();
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(path.join(EVIDENCE_DIR, 's15-nested-geometry.json'), JSON.stringify(evidence, null, 2) + '\n');
}

before(async () => {
  const env = JSON.parse(await fs.readFile(path.join(RUN_ROOT, 'env.json'), 'utf8'));
  evidence.batch = env.batchId ?? evidence.batch;
  await buildBundle();
  host = await new SceneHost({ port: Number(env.studioPort) }).start();
  const harnessPort = host.http.port;
  studio = await startStudio({ port: 0, vitePort: harnessPort, logger: () => {} });
  evidence.studio = { port: studio.port, url: studio.url, harnessOrigin: `http://127.0.0.1:${harnessPort}` };
});

after(async () => {
  await save();
  if (studio) await studio.close();
  if (host) await host.stop();
});

async function get(url) {
  const res = await fetch(url);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

/**
 * 复制样例 → 在 head 里插舞台 CSS（可带容器 transform）→ 可选改片段声明 → 真实 open。
 * @param {string} name
 * @param {{css?: string, declare?: boolean, origin?: string}} [opts]
 */
async function makeProject(name, opts = {}) {
  const dir = path.join(PROJECTS, `${name}-${process.pid}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.cp(SAMPLE, dir, { recursive: true });
  const filmPath = path.join(dir, 'film.html');
  let film = await fs.readFile(filmPath, 'utf8');
  assert.ok(film.includes('</head>'), '样例 film.html 应有 head');
  const extra = [BASE_CSS.replace('</style>', `${opts.css ?? ''}</style>`)];
  if (opts.origin) extra.push(`<style>#card-a{transform-origin:${opts.origin}}</style>`);
  film = film.replace('</head>', `${extra.join('')}</head>`);
  if (opts.declare) {
    film = film.replace(
      '<iframe id="card-a" src="scene-a.html#t=0,4" at="0">',
      `<iframe id="card-a" src="scene-a.html#t=0,4" at="0" style="${DECLARED_BOX}">`
    );
  }
  await fs.writeFile(filmPath, film);
  const opened = await post(`${studio.url}/api/projects/open`, { dir });
  assert.equal(opened.status, 200, `open 失败：${opened.text}`);
  const projectId = opened.json.project.projectId;
  const doc = await get(`${studio.url}/api/projects/${encodeURIComponent(projectId)}/doc`);
  assert.equal(doc.status, 200, `doc 失败：${doc.text}`);
  const parsedDoc = doc.json.doc ?? doc.json;
  const clip = (parsedDoc.tracks ?? []).flatMap((t) => t.clips ?? []).find((c) => c.id === 'card-a');
  return { dir, projectId, hash: doc.json.hash, filmPath, clip: { id: clip?.id, box: clip?.box ?? null, style: clip?.style ?? null } };
}

/** 页内：挂面板（几何字段带坐标系换算）。 */
async function mountLive(deps) {
  const mod = await import(deps.bundle);
  const { createOpsClient, mountInspector, readLayer, readGeometrySpace, applyBoxValue, applyOverrideEntries, mergeOverridesAt } = mod;

  window.__fetches = [];
  const realFetch = window.fetch.bind(window);
  window.fetch = (...args) => {
    window.__fetches.push(String(args[0]));
    return realFetch(...args);
  };

  const log = [];
  const el0 = document.querySelector(deps.at);
  const hosts = { entries: [], prevStyle: null, declaredBox: deps.declaredBox ?? null, log, baselineStyle: el0?.getAttribute('style') ?? null };

  const client = createOpsClient({
    projectId: deps.projectId,
    batchId: deps.batchId,
    owner: 'SUB1',
    expectedHash: deps.expectedHash,
    baseUrl: deps.baseUrl
  });

  const container = document.createElement('div');
  container.id = 'sub1-nested-panel';
  container.setAttribute(
    'style',
    'position:fixed;right:0;top:0;width:320px;height:100vh;background:#111a2e;color:#eef2ff;z-index:2147483647;' +
      'overflow:auto;font:12px/1.5 system-ui;padding:8px;box-sizing:border-box'
  );
  document.body.appendChild(container);

  const readRect = () => {
    const r = document.querySelector(deps.at).getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  };

  const panelDeps = {
    describe: async (ref) => {
      const res = readLayer(ref.at);
      return res && res.ok ? res.value : res;
    },
    overrideOf: (at) => hosts.entries.find((e) => e && e.at === at) ?? null,
    boxOf: () => hosts.declaredBox,
    geometry: async (at) => readGeometrySpace(at),
    preview: async (patch) => {
      hosts.entries = mergeOverridesAt(hosts.entries, deps.at, patch);
      await applyOverrideEntries(hosts.entries);
    },
    previewBox: async (op) => {
      if (hosts.prevStyle === null) hosts.prevStyle = document.querySelector(deps.at)?.getAttribute('style') ?? '';
      const res = applyBoxValue({ at: deps.at, box: op.value });
      log.push({ step: 'previewBox', value: op.value, rect: res.rect, positioned: res.positioned });
    },
    revertPreview: async () => {
      const el = document.querySelector(deps.at);
      if (el && hosts.prevStyle !== null) {
        el.removeAttribute('data-ov-box');
        el.removeAttribute('data-ov-box-prev');
        el.removeAttribute('data-ov-box-at');
        if (hosts.prevStyle) el.setAttribute('style', hosts.prevStyle);
        else el.removeAttribute('style');
      }
      hosts.prevStyle = null;
      await applyOverrideEntries(hosts.entries);
    },
    commit: async (patch) => {
      const next = mergeOverridesAt(hosts.entries, deps.at, patch);
      const res = await client.commitOverrides({ clip: deps.clip, entries: next });
      log.push({ step: 'commit', ok: res.ok, request: res.request, response: res.response });
      if (res.ok) hosts.entries = next;
      return res;
    },
    commitBox: async (op) => {
      const res = await client.commitSet({ clip: deps.clip, field: op.field, value: op.value });
      log.push({ step: 'commitBox', ok: res.ok, code: res.code ?? null, status: res.status, op, request: res.request, response: res.response });
      if (res.ok) {
        hosts.prevStyle = null;
        hosts.declaredBox = { ...op.value };
      }
      return res;
    },
    onConflict: (info) => {
      hosts.conflict = info;
    },
    expectedHash: deps.expectedHash
  };

  const panel = mountInspector(container, panelDeps);
  await panel.select({ clipId: deps.clip, at: deps.at, kind: 'iframe', name: 'card-a', depth: 0 });
  window.__panel = panel;
  window.__host = hosts;
  window.__client = client;
  window.__mod = mod;
  window.__readRect = readRect;
  return panel.getState();
}

async function openFilm(project, opts = {}) {
  const filmRel = path.relative(REPO_ROOT, project.filmPath).split(path.sep).join('/');
  const handle = await host.open(filmRel);
  const page = handle.page;
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  await page.evaluate(mountLive, {
    bundle: BUNDLE_URL,
    baseUrl: studio.url,
    projectId: project.projectId,
    batchId: 'B-SUB1-R8-008',
    expectedHash: opts.expectedHash ?? project.hash,
    clip: 'card-a',
    at: '#card-a',
    declaredBox: project.clip.box
  });
  return { handle, page, consoleErrors };
}

async function editField(page, fieldId, value) {
  await page.evaluate(
    ([id, v]) => {
      const input = document.querySelector(`.film-inspector [data-field="${id}"] input`);
      if (!input) throw new Error(`没有字段输入框：${id}`);
      input.value = v;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    [fieldId, value]
  );
  await page.evaluate(() => window.__panel.idle());
  return page.evaluate(() => ({
    state: window.__panel.getState(),
    log: window.__host.log,
    rect: window.__readRect(),
    inline: document.querySelector('#card-a').getAttribute('style') || '',
    display: Object.fromEntries(
      [...document.querySelectorAll('.film-inspector label[data-kind="box"]')].map((row) => [
        row.getAttribute('data-field'),
        {
          value: row.querySelector('input').value,
          space: row.getAttribute('data-space'),
          source: row.getAttribute('data-source-label'),
          declared: row.getAttribute('data-declared')
        }
      ])
    ),
    hint: document.querySelector('.film-inspector .inspector-hint')?.getAttribute('data-hint') ?? null,
    hintText: document.querySelector('.film-inspector .inspector-hint')?.textContent ?? null
  }));
}

/* ── A1 ─────────────────────────────────────────────────────────────────── */

test('S15-A1 父级 scale(2)：输入屏幕 +30 → 提交 +15 → rect +30', async () => {
  const project = await makeProject('s15-a1', { css: 'section:nth-of-type(1){transform:scale(2)}' });
  const { handle, page, consoleErrors } = await openFilm(project);

  const mount = await page.evaluate(() => ({
    state: window.__panel.getState(),
    geometry: window.__mod.readGeometrySpace('#card-a'),
    display: Object.fromEntries(
      [...document.querySelectorAll('.film-inspector label[data-kind="box"]')].map((row) => [
        row.getAttribute('data-field'),
        row.querySelector('input').value
      ])
    ),
    rect: window.__readRect()
  }));
  assert.equal(mount.geometry.ok, true, JSON.stringify(mount.geometry));
  assert.equal(mount.geometry.scale.sx, 2);
  /* section 绕自身中心 scale(2)，片段局部 (0,0) 投到屏幕 x = 640 + (0−640)·2 = −640；
     显示的是屏幕值，所以就是 −640，而宽显示 600（声明 300 × 2）。 */
  assert.equal(mount.display.x, '-640', `屏幕 x 应为 -640：${mount.display.x}`);
  assert.equal(mount.display.w, '600', `屏幕宽应为 600（声明 300×2）：${mount.display.w}`);
  assert.equal(mount.state.box.w, 300, `基准框应是声明 300，不是实测 600：${mount.state.box.w}`);

  const before = mount.rect;
  const res = await editField(page, 'x', '30');
  const commit = res.log.filter((l) => l.step === 'commitBox').at(-1);
  assert.equal(commit.ok, true, JSON.stringify(commit.response));
  assert.equal(commit.op.value.x, 15, `提交的声明值应为 15，实际 ${commit.op.value.x}`);
  assert.equal(commit.op.value.w, 300, `宽应保持声明 300，实际 ${commit.op.value.w}`);

  const after = res.rect;
  assert.ok(Math.abs(after.x - before.x - 30) <= 1, `rect.x 变化 ${after.x - before.x}，期望 ≈30`);
  assert.ok(Math.abs(after.w - 600) <= 1, `rect.w 应仍是 600：${after.w}`);

  const film = await fs.readFile(project.filmPath, 'utf8');
  assert.ok(film.includes('left: 15px'), `磁盘应写 15px：${film.slice(0, 200)}`);
  const reparsed = parse(film, { path: project.filmPath });
  const clip = reparsed.doc.tracks.flatMap((t) => t.clips).find((c) => c.id === 'card-a');
  assert.equal(clip.box.x, 15);
  assert.equal(clip.box.w, 300);
  assert.deepEqual(consoleErrors, [], consoleErrors.join(' | '));

  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, 's15-a1-scale2.png') });

  await handle.dispose();
  evidence.cases['S15-A1'] = {
    ok: true,
    geometry: { scale: mount.geometry.scale, linear: mount.geometry.linear, chain: mount.geometry.chain.map((c) => c.node) },
    mountDisplay: mount.display,
    baseBox: mount.state.box,
    before,
    after,
    delta: after.x - before.x,
    committed: commit.op.value,
    request: commit.request,
    response: commit.response,
    diskBox: clip.box
  };
});

/* ── A2 ─────────────────────────────────────────────────────────────────── */

test('S15-A2 父级 rotate(90deg)：输入沿屏幕 X，提交经逆旋转，rect 对得上', async () => {
  const project = await makeProject('s15-a2', { css: 'section:nth-of-type(1){transform:rotate(90deg)}', declare: true });
  const { handle, page } = await openFilm(project);

  const mount = await page.evaluate(() => ({
    state: window.__panel.getState(),
    geometry: window.__mod.readGeometrySpace('#card-a'),
    display: Object.fromEntries(
      [...document.querySelectorAll('.film-inspector label[data-kind="box"]')].map((row) => [
        row.getAttribute('data-field'),
        row.querySelector('input').value
      ])
    ),
    rect: window.__readRect()
  }));
  assert.equal(mount.geometry.ok, true, JSON.stringify(mount.geometry));
  assert.ok(Math.abs(mount.geometry.rotationDeg - 90) < 1e-6, `祖先旋转 ${mount.geometry.rotationDeg}`);
  /* 声明 (100,50) 经 R(90) 投影：x = -50, y = 100 */
  assert.equal(mount.display.x, '-50', `屏幕 x 应为 -50：${mount.display.x}`);
  assert.equal(mount.display.y, '100', `屏幕 y 应为 100：${mount.display.y}`);

  const before = mount.rect;
  const target = String(Number(mount.display.x) + 30); // 屏幕上 +30
  const res = await editField(page, 'x', target);
  const commit = res.log.filter((l) => l.step === 'commitBox').at(-1);
  assert.equal(commit.ok, true, JSON.stringify(commit.response));
  /* 逆旋转后：声明 x 不变 100，声明 y 从 50 变 20（屏幕 +30 沿 X） */
  assert.ok(Math.abs(commit.op.value.x - 100) <= 0.01, `声明 x 应保持 100：${commit.op.value.x}`);
  assert.ok(Math.abs(commit.op.value.y - 20) <= 0.01, `声明 y 应为 20：${commit.op.value.y}`);

  const after = res.rect;
  assert.ok(Math.abs(after.x - before.x - 30) <= 1, `屏幕 x 变化 ${after.x - before.x}，期望 ≈30`);
  assert.ok(Math.abs(after.y - before.y) <= 1, `屏幕 y 不该动：${after.y - before.y}`);

  const film = await fs.readFile(project.filmPath, 'utf8');
  assert.ok(film.includes('top: 20px'), `磁盘 top 应为 20px：${film.slice(0, 220)}`);

  await handle.dispose();
  evidence.cases['S15-A2'] = {
    ok: true,
    rotationDeg: mount.geometry.rotationDeg,
    mountDisplay: mount.display,
    before,
    after,
    delta: { x: after.x - before.x, y: after.y - before.y },
    committed: commit.op.value,
    request: commit.request,
    response: commit.response
  };
});

/* ── A3 ─────────────────────────────────────────────────────────────────── */

test('S15-A3 非中心 transform-origin + 仿射祖先：能提交且祖先 transform 不变', async () => {
  const project = await makeProject('s15-a3', {
    css: 'section:nth-of-type(1){transform:scale(1.5) rotate(10deg)}',
    declare: true,
    origin: '0 0'
  });
  const { handle, page } = await openFilm(project);

  const before = await page.evaluate(() => ({
    ancestor: getComputedStyle(document.querySelector('section')).transform,
    origin: getComputedStyle(document.querySelector('#card-a')).transformOrigin,
    rect: window.__readRect()
  }));
  assert.notEqual(before.origin, '150px 75px', `本用例 origin 应是非中心的：${before.origin}`);

  const currentDisplay = await page.evaluate(() => Number(document.querySelector('.film-inspector [data-field="x"] input').value));
  const res = await editField(page, 'x', String(Math.round((currentDisplay + 30) * 1000) / 1000));
  const commit = res.log.filter((l) => l.step === 'commitBox').at(-1);
  assert.equal(commit.ok, true, JSON.stringify(commit.response));

  const after = await page.evaluate(() => ({
    ancestor: getComputedStyle(document.querySelector('section')).transform,
    origin: getComputedStyle(document.querySelector('#card-a')).transformOrigin,
    rect: window.__readRect()
  }));
  assert.equal(after.ancestor, before.ancestor, `祖先 transform 被改了：${before.ancestor} → ${after.ancestor}`);
  assert.equal(after.origin, before.origin);
  assert.ok(Math.abs(after.rect.x - before.rect.x - 30) <= 1.5, `rect.x 变化 ${after.rect.x - before.rect.x}，期望 ≈30`);

  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, 's15-a3-origin.png') });

  await handle.dispose();
  evidence.cases['S15-A3'] = {
    ok: true,
    origin: before.origin,
    ancestorBefore: before.ancestor,
    ancestorAfter: after.ancestor,
    ancestorSha: { before: sha(before.ancestor), after: sha(after.ancestor) },
    before: before.rect,
    after: after.rect,
    committed: commit.op.value,
    request: commit.request,
    response: commit.response
  };
});

/* ── A4 ─────────────────────────────────────────────────────────────────── */

test('S15-A4 祖先 matrix3d：拒绝 UNSUPPORTED_ANCESTOR_MATRIX，磁盘不变', async () => {
  const project = await makeProject('s15-a4', {
    css: 'section:nth-of-type(1){transform:perspective(600px) rotateY(20deg)}',
    declare: true
  });
  const { handle, page } = await openFilm(project);

  const diskBefore = await fs.readFile(project.filmPath, 'utf8');
  const geometry = await page.evaluate(() => window.__mod.readGeometrySpace('#card-a'));
  assert.equal(geometry.ok, false);
  assert.equal(geometry.code, 'UNSUPPORTED_ANCESTOR_MATRIX');
  assert.match(geometry.reason, /3D|透视/, geometry.reason);

  const before = await page.evaluate(() => window.__readRect());
  const res = await editField(page, 'x', '30');
  assert.equal(res.log.filter((l) => l.step === 'commitBox').length, 0, '拒绝时不该发请求');
  assert.equal(res.state.error.code, 'UNSUPPORTED_ANCESTOR_MATRIX');
  const after = await page.evaluate(() => window.__readRect());
  assert.deepEqual(after, before, '拒绝时 DOM 被改了');

  const diskAfter = await fs.readFile(project.filmPath, 'utf8');
  assert.equal(diskAfter, diskBefore, '拒绝时磁盘被写了');
  assert.equal(sha(diskAfter), sha(diskBefore));

  const banner = await page.evaluate(() => {
    const box = document.querySelector('.film-inspector .inspector-status');
    return { code: box.getAttribute('data-code'), text: box.textContent };
  });
  assert.equal(banner.code, 'UNSUPPORTED_ANCESTOR_MATRIX');

  await handle.dispose();
  evidence.cases['S15-A4'] = {
    ok: true,
    geometry: { code: geometry.code, reason: geometry.reason, chain: (geometry.chain ?? []).map((c) => c.node) },
    banner,
    diskSha: sha(diskAfter),
    rect: before
  };
});

/* ── A5 ─────────────────────────────────────────────────────────────────── */

test('S15-A5 来源标注：未声明=实测 + 首次编辑有提示；已声明=声明', async () => {
  /* R20（B2）：空间来源小签并进 22px 的标签格后，**可见字只能 1 个**（实测→实、声明→声）。
     全词没丢：「`.inspector-field-space` 的 `data-space-label` 与 `title` 都是全词」。
     所以这里断言两件事：可见字 = 全词首字、`data-space-label` = 全词。 */
  /* (a) 未声明尺寸（只有实测） */
  const p1 = await makeProject('s15-a5-measured', { css: 'section:nth-of-type(1){transform:scale(2)}' });
  const a = await openFilm(p1);
  const measured = await a.page.evaluate(() => ({
    rows: Object.fromEntries(
      [...document.querySelectorAll('.film-inspector label[data-kind="box"]')].map((row) => [
        row.getAttribute('data-field'),
        { source: row.getAttribute('data-source-label'), declared: row.getAttribute('data-declared'), space: row.getAttribute('data-space'), chip: row.querySelector('[data-space-chip]')?.textContent ?? null, chipLabel: row.querySelector('[data-space-chip]')?.getAttribute('data-space-label') ?? null, chipTitle: row.querySelector('[data-space-chip]')?.getAttribute('title') ?? null }
      ])
    ),
    hintBefore: document.querySelector('.film-inspector .inspector-hint')?.getAttribute('data-hint') ?? null
  }));
  for (const id of ['x', 'y', 'w', 'h', 'rotation']) {
    assert.equal(measured.rows[id].source, 'measured', `${id} 应标实测：${JSON.stringify(measured.rows[id])}`);
    assert.equal(measured.rows[id].chip, '实', `可见字应是全词首字：${JSON.stringify(measured.rows[id])}`);
    assert.equal(measured.rows[id].chipLabel, '实测', `data-space-label 要留全词：${JSON.stringify(measured.rows[id])}`);
    assert.match(String(measured.rows[id].chipTitle), /实测/, 'title 要留全词');
    assert.equal(measured.rows[id].space, 'screen', `${id} 的输入应是屏幕空间`);
  }
  assert.equal(measured.hintBefore, null, '没编辑前不该有提示');

  const edited = await editField(a.page, 'x', '30');
  assert.equal(edited.hint, 'MEASURED_PINNED', `编辑后应有实测固定提示：${edited.hint}`);
  assert.match(edited.hintText, /实测 \d+(\.\d+)?×\d+(\.\d+)?px/, edited.hintText);
  await a.handle.dispose();

  /* (b) 已声明尺寸 */
  const p2 = await makeProject('s15-a5-declared', { css: 'section:nth-of-type(1){transform:scale(2)}', declare: true });
  const b = await openFilm(p2);
  const declared = await b.page.evaluate(() => ({
    rows: Object.fromEntries(
      [...document.querySelectorAll('.film-inspector label[data-kind="box"]')].map((row) => [
        row.getAttribute('data-field'),
        { source: row.getAttribute('data-source-label'), chip: row.querySelector('[data-space-chip]')?.textContent ?? null, chipLabel: row.querySelector('[data-space-chip]')?.getAttribute('data-space-label') ?? null }
      ])
    )
  }));
  for (const id of ['x', 'y', 'w', 'h']) {
    assert.equal(declared.rows[id].source, 'declared', `${id} 应标声明：${JSON.stringify(declared.rows[id])}`);
    assert.equal(declared.rows[id].chip, '声', `可见字应是全词首字：${JSON.stringify(declared.rows[id])}`);
    assert.equal(declared.rows[id].chipLabel, '声明', `data-space-label 要留全词：${JSON.stringify(declared.rows[id])}`);
  }
  const editedDeclared = await editField(b.page, 'x', '230');
  assert.equal(editedDeclared.hint, null, `已声明尺寸不该提示固定：${editedDeclared.hint}`);
  await b.handle.dispose();

  evidence.cases['S15-A5'] = { ok: true, measured, edited: { hint: edited.hint, hintText: edited.hintText }, declared };
});

/* ── A6 ─────────────────────────────────────────────────────────────────── */

test('S15-A6 不传 geometry 时行为与 R7 一致（向后兼容）', async () => {
  const project = await makeProject('s15-a6-compat', { css: 'section:nth-of-type(1){transform:scale(2)}' });
  const filmRel = path.relative(REPO_ROOT, project.filmPath).split(path.sep).join('/');
  const handle = await host.open(filmRel);
  const page = handle.page;

  const view = await page.evaluate(async (bundleUrl) => {
    const mod = await import(bundleUrl);
    const box = document.createElement('div');
    box.id = 'compat-panel';
    box.setAttribute('style', 'position:fixed;right:0;top:0;width:300px;background:#111a2e;color:#eee;z-index:9');
    document.body.appendChild(box);
    const panel = mod.mountInspector(box, {
      describe: async (ref) => {
        const res = mod.readLayer(ref.at);
        return res && res.ok ? res.value : res;
      },
      preview: async () => {},
      commit: async () => ({ ok: true, hash: 'x' })
    });
    await panel.select({ clipId: 'card-a', at: '#card-a', kind: 'iframe', name: 'card-a', depth: 0 });
    const row = box.querySelector('[data-field="x"]');
    const wRow = box.querySelector('[data-field="w"]');
    return {
      x: { space: row.getAttribute('data-space'), value: row.querySelector('input').value, source: row.getAttribute('data-source-label') },
      w: { space: wRow.getAttribute('data-space'), value: wRow.querySelector('input').value },
      state: panel.getState()
    };
  }, BUNDLE_URL);

  /* 没有 geometry dep：显示声明值（未声明→实测），space=declared，与 R7 完全一致 */
  assert.equal(view.x.space, 'declared');
  assert.equal(view.w.space, 'declared');
  assert.equal(view.x.value, '-640', `没有坐标系时应原样显示实测 x（R7 行为）：${view.x.value}`);
  assert.equal(view.w.value, '600', `没有坐标系时应原样显示实测宽 600（R7 行为）：${view.w.value}`);

  await handle.dispose();
  evidence.cases['S15-A6'] = { ok: true, compat: view };
});
