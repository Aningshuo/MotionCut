// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S26-INSPECTOR-MULTI 验收 A1..A8
 *
 * 真 Studio + 真 film 工程：多选 2/3 层 → 右栏显示 mixed → 改一个字段 → **一批 op、一次 `/ops`** → 一次 `/undo` 全回。
 * A6 用真 `page.reload()` 验「会话内记住折叠、刷新回到默认」。
 * A7 是单选回归（S16 的 px 解析与非法值拒绝必须一个字节不变）。
 *
 * 运行：node --test --test-concurrency=1 packages/layers/inspector-multi.test.mjs（env 由 test-env.mjs 自动准备；`OPENCUT_ENV_JSON` 可显式覆盖）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { build as esbuild } from 'esbuild';
import { SceneHost, REPO_ROOT } from '../scene-runtime/host.mjs';
import { startStudio } from '../studio/server/studio-server.mjs';
import { resolveLayerTestEnv } from './test-env.mjs';

const TEST_ENV = await resolveLayerTestEnv({ suite: 'inspector-multi' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');
const PROJECTS = path.join(RUN_ROOT, 'projects');
const BUNDLE_ABS = path.join(RUN_ROOT, 'tmp/s26/panel.mjs');
const BUNDLE_URL = '/' + path.relative(REPO_ROOT, BUNDLE_ABS).split(path.sep).join('/');

const STAGE_W = 1280;
const STAGE_H = 720;
const BATCH = 'B-SUB1-R13-013';

const BOXES = {
  a: { x: 100, y: 80, w: 300, h: 150 },
  /* b 与 a 的 y 故意不同：A2 批量把 b 的 x 改成 100 后两块不会叠在一起，截图能看清「左边对齐」 */
  b: { x: 500, y: 300, w: 200, h: 100 },
  c: { x: 700, y: 80, w: 150, h: 120 },
  lock: { x: 700, y: 300, w: 120, h: 100 }
};

const SCENE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;background:#fdf6e3}
.t{font:20px/1.4 "PingFang SC",Arial;color:#123;padding:10px}
</style></head><body><div class="t">多选检查器验收 · 真实文字</div></body></html>`;

/** @param {Record<string, any>} boxes @param {Record<string, number>} [rotations] */
function filmHtml(boxes, rotations = {}) {
  const frames = Object.entries(boxes)
    .map(([id, box]) => {
      const rotate = rotations[id] ? `rotate:${rotations[id]}deg;` : '';
      return `<iframe id="${id}" src="scene.html#t=0,4" at="0" style="left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px;${rotate}"></iframe>`;
    })
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#0f1729}
section{position:relative;display:block;width:1280px;height:720px}
iframe{position:absolute;border:0;display:block;background:#fff}
</style></head><body>
<section>
${frames}
</section>
</body></html>`;
}

const evidence = {
  batch: BATCH,
  suite: 'inspector-multi.test.mjs',
  cases: {},
  screenshots: [],
  startedAt: new Date().toISOString()
};

/** @type {SceneHost} */
let host;
/** @type {any} */
let studio;

async function buildBundle() {
  await fs.mkdir(path.dirname(BUNDLE_ABS), { recursive: true });
  await esbuild({
    stdin: {
      contents: [
        "export * from './packages/layers/inspector-fields.mjs';",
        "export { createOpsClient } from './packages/layers/ops-client.mjs';",
        "export { mountInspector, PANEL_REASONS } from './packages/layers/inspector-panel.mjs';",
        "export { readLayer } from './packages/layers/describe.ts';",
        "export { applyOverrideEntries, applyBoxValue } from './packages/layers/apply-overrides.mjs';",
        "export { mergeOverridesAt } from './packages/layers/override-merge.mjs';"
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
  const files = [];
  for (const name of ['s26-a1-mixed.png', 's26-a2-batch.png', 's26-a5-locked.png']) {
    try {
      const buf = await fs.readFile(path.join(EVIDENCE_DIR, name));
      files.push({ name, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
    } catch {
      files.push({ name, bytes: 0, sha256: null, missing: true });
    }
  }
  evidence.screenshots = files;
  evidence.finishedAt = new Date().toISOString();
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(path.join(EVIDENCE_DIR, 's26-inspector-multi.json'), JSON.stringify(evidence, null, 2) + '\n');
}

before(async () => {
  const env = JSON.parse(await fs.readFile(path.join(RUN_ROOT, 'env.json'), 'utf8'));
  evidence.batch = env.batchId ?? evidence.batch;
  await buildBundle();
  host = await new SceneHost({ port: Number(env.studioPort), viewport: { width: 1440, height: 1000 } }).start();
  studio = await startStudio({ port: 0, vitePort: host.http.port, logger: () => {} });
  evidence.studio = { port: studio.port, url: studio.url, browser: host.browserVersion };
});

after(async () => {
  await save();
  if (studio) await studio.close();
  if (host) await host.stop();
});

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

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

async function makeProject(name, boxes = BOXES, rotations = {}) {
  const dir = path.join(PROJECTS, `${name}-${process.pid}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'scene.html'), SCENE_HTML);
  await fs.writeFile(path.join(dir, 'film.html'), filmHtml(boxes, rotations));
  const opened = await post(`${studio.url}/api/projects/open`, { dir });
  assert.equal(opened.status, 200, `open 失败：${opened.text}`);
  const projectId = opened.json.project.projectId;
  const doc = await get(`${studio.url}/api/projects/${encodeURIComponent(projectId)}/doc`);
  assert.equal(doc.status, 200, `doc 失败：${doc.text}`);
  return { dir, projectId, hash: doc.json.hash, filmPath: path.join(dir, 'film.html') };
}

/**
 * 页内挂载：真 `mountInspector`，宿主按真实 Studio 的通路接：
 * describe → `readLayer`；boxOf → doc 里的声明 box；commit/commitBox → 单条 op；
 * commitMany → 每个 job 一条 op，**一次 `commitOps`**（就是 S24 那条批量通路）。
 */
async function mountMulti(deps) {
  const mod = await import(deps.bundle);

  window.__fetches = [];
  const realFetch = window.fetch.bind(window);
  window.fetch = (...args) => {
    const init = args[1] || {};
    window.__fetches.push({ url: String(args[0]), method: init.method || 'GET', body: init.body ? String(init.body) : null });
    return realFetch(...args);
  };

  /** clipId ↔ at 的映射（`#a` → `a`） */
  window.__clipOf = (at) => String(at).replace(/^#/, '');
  window.__declared = JSON.parse(JSON.stringify(deps.declared));
  /** 每个 clip 一份 overrides 条目数组（真实协议就是按 clip 分组） */
  window.__entriesByClip = JSON.parse(JSON.stringify(deps.entriesByClip ?? {}));
  window.__ops = [];
  window.__results = [];
  window.__previews = [];

  const client = mod.createOpsClient({
    projectId: deps.projectId,
    batchId: deps.batchId,
    owner: 'SUB1',
    expectedHash: deps.expectedHash,
    baseUrl: deps.baseUrl
  });
  window.__client = client;

  const entriesOf = (at) => window.__entriesByClip[window.__clipOf(at)] ?? [];

  const hostEl = document.createElement('div');
  hostEl.id = 'r13-multi';
  hostEl.setAttribute(
    'style',
    'position:fixed;right:0;top:0;width:390px;height:100vh;background:#111a2e;color:#f2f6ff;z-index:9999;overflow:auto;padding:10px;box-sizing:border-box'
  );
  const style = document.createElement('style');
  style.textContent = [
    /* film.html 有全局 section{width:1280px;height:720px}，面板分组也是 <section>：容器里复位 */
    '#r13-multi section{width:auto;height:auto;position:static;display:block}',
    '#r13-multi .inspector-group-label{font:13px/1.6 system-ui;color:#9fb3d1;margin:12px 0 6px}',
    '#r13-multi .inspector-group-toggle{display:block;width:100%;text-align:left;background:none;border:0;color:#9fb3d1;font:13px/1.6 system-ui;padding:4px 0;cursor:pointer}',
    '#r13-multi .inspector-field{display:flex;align-items:center;gap:6px;margin:4px 0;font:13px/1.5 system-ui}',
    '#r13-multi .inspector-field-label{flex:0 0 64px;color:#eaf2ff;font-size:13px}',
    '#r13-multi .inspector-input{flex:1;min-width:0;padding:3px 5px;border:1px solid rgba(120,140,180,.55);border-radius:4px;background:#0b1220;color:#eaf2ff;font:13px/1.4 ui-monospace,Menlo,monospace}',
    '#r13-multi .inspector-input:disabled{opacity:.5}',
    '#r13-multi .inspector-field-source,#r13-multi .inspector-field-space{opacity:.62;font:11px/1.4 system-ui}',
    '#r13-multi .inspector-field-reason{color:#ffb86b;font:11px/1.4 ui-monospace,Menlo,monospace}',
    '#r13-multi .inspector-multi-summary{font:12px/1.6 system-ui;color:#9fe7c0;margin-bottom:6px}',
    '#r13-multi .inspector-status{margin-top:8px;font:11px/1.6 system-ui;opacity:.75}'
  ].join('\n');
  document.head.appendChild(style);
  document.body.appendChild(hostEl);

  /** 宿主把一批 job 翻成 op，发**同一次** `/ops`（S24 的通路） */
  const commitMany = async (jobs) => {
    const ops = jobs.map((job) => {
      const clip = window.__clipOf(job.ref.at);
      if (job.kind === 'box') return { op: 'set', clip, field: 'box', value: job.op.value };
      return { op: 'overrides', clip, entries: mod.mergeOverridesAt(entriesOf(job.ref.at), job.ref.at, job.patch) };
    });
    window.__ops.push(JSON.parse(JSON.stringify(ops)));
    const res = await client.commitOps(ops);
    window.__results.push({
      ok: res.ok === true,
      status: res.status,
      code: res.code ?? null,
      request: res.request,
      response: res.response
    });
    if (res.ok) {
      for (const job of jobs) {
        const clip = window.__clipOf(job.ref.at);
        if (job.kind === 'box') {
          window.__declared[clip] = { ...job.op.value };
          mod.applyBoxValue({ at: job.ref.at, box: job.op.value });
        } else {
          window.__entriesByClip[clip] = mod.mergeOverridesAt(entriesOf(job.ref.at), job.ref.at, job.patch);
        }
      }
      mod.applyOverrideEntries(Object.values(window.__entriesByClip).flat());
    }
    return res;
  };

  const panel = mod.mountInspector(hostEl, {
    describe: async (ref) => {
      const res = mod.readLayer(ref.at);
      return res && res.ok ? res.value : res;
    },
    overrideOf: (at) => entriesOf(at).find((entry) => entry && entry.at === at) ?? null,
    boxOf: (at) => window.__declared[window.__clipOf(at)] ?? null,
    preview: async (patch) => {
      window.__previews.push({ kind: 'overrides', patch });
      return { ok: true };
    },
    previewBox: async (op) => {
      window.__previews.push({ kind: 'box', op });
      return { ok: true };
    },
    revertPreview: async () => {
      window.__previews.push({ kind: 'revert' });
      return { ok: true };
    },
    commit: async (patch) => {
      const at = window.__activeAt;
      if (!at) return { ok: false, code: 'NO_TARGET', message: '没有活动层' };
      const clip = window.__clipOf(at);
      const next = mod.mergeOverridesAt(entriesOf(at), at, patch);
      window.__ops.push([{ op: 'overrides', clip, entries: JSON.parse(JSON.stringify(next)) }]);
      const res = await client.commitOverrides({ clip, entries: next });
      window.__results.push({ ok: res.ok === true, status: res.status, code: res.code ?? null, request: res.request, response: res.response });
      if (res.ok) {
        window.__entriesByClip[clip] = next;
        mod.applyOverrideEntries(Object.values(window.__entriesByClip).flat());
      }
      return res;
    },
    commitBox: async (op) => {
      const at = window.__activeAt;
      if (!at) return { ok: false, code: 'NO_TARGET', message: '没有活动层' };
      const clip = window.__clipOf(at);
      window.__ops.push([{ op: 'set', clip, field: op.field, value: op.value }]);
      const res = await client.commitSet({ clip, field: op.field, value: op.value });
      window.__results.push({ ok: res.ok === true, status: res.status, code: res.code ?? null, request: res.request, response: res.response });
      if (res.ok) {
        window.__declared[clip] = { ...op.value };
        mod.applyBoxValue({ at, box: op.value });
      }
      return res;
    },
    commitMany,
    expectedHash: deps.expectedHash
  });

  window.__panel = panel;
  window.__mod = mod;
  window.__activeAt = '';

  const refs = deps.selected.map((at) => {
    const clip = window.__clipOf(at);
    return { clipId: clip, at, kind: 'iframe', name: clip, depth: 1 };
  });
  window.__refs = refs;
  if (refs.length > 1) await panel.selectMany(refs);
  else if (refs.length === 1) {
    window.__activeAt = refs[0].at;
    await panel.select(refs[0]);
  }
  /* 锁定的层：真实 Studio 用 data-locked 标注，describe 会读到 */
  for (const at of deps.locked ?? []) {
    const el = document.querySelector(at);
    if (el) el.setAttribute('data-locked', 'true');
  }
  await panel.refresh();
  return panel.getState();
}

function depsFor(project, extra = {}) {
  const boxes = extra.boxes ?? BOXES;
  return {
    bundle: BUNDLE_URL,
    projectId: project.projectId,
    batchId: BATCH,
    expectedHash: project.hash,
    baseUrl: studio.url,
    declared: Object.fromEntries(
      Object.entries(boxes).map(([id, box]) => [id, { ...box, ...(extra.rotations && extra.rotations[id] ? { r: extra.rotations[id] } : {}) }])
    ),
    entriesByClip: Object.fromEntries(Object.keys(boxes).map((id) => [id, []])),
    selected: extra.selected ?? ['#a', '#b'],
    locked: extra.locked ?? []
  };
}

async function openProject(project, extra = {}) {
  const filmRel = path.relative(REPO_ROOT, project.filmPath).split(path.sep).join('/');
  const handle = await host.open(filmRel);
  const page = handle.page;
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  const mounted = await page.evaluate(mountMulti, depsFor(project, extra));
  await page.evaluate(() => {
    const refs = window.__refs;
    if (refs.length === 1) window.__activeAt = refs[0].at;
  });
  return { handle, page, pageErrors, mounted };
}

/* ── 小工具 ─────────────────────────────────────────────────────────────── */

async function waitFor(check, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

const readState = (page) => page.evaluate(() => window.__panel.getState());
const readOps = (page) => page.evaluate(() => window.__ops.map((ops) => ops.map((op) => JSON.parse(JSON.stringify(op)))));
const readResults = (page) => page.evaluate(() => window.__results.map((r) => ({ ...r })));
const readFetches = (page) => page.evaluate(() => window.__fetches.map((f) => ({ ...f })));
const postOpsCount = (fetches) => fetches.filter((f) => f.method === 'POST' && /\/ops$/.test(f.url)).length;

const fieldOf = (page, id) =>
  page.evaluate((fieldId) => {
    const row = document.querySelector(`.film-inspector [data-field="${fieldId}"]`);
    if (!row) return null;
    const input = row.querySelector('input');
    return {
      id: fieldId,
      mixed: row.getAttribute('data-mixed'),
      editable: row.getAttribute('data-editable'),
      reason: row.getAttribute('data-locked-reason'),
      values: row.getAttribute('data-values'),
      title: row.getAttribute('title'),
      chips: [...row.querySelectorAll('[data-reason-chip]')].map((node) => node.textContent),
      value: input ? input.value : null,
      placeholder: input ? input.placeholder : null,
      disabled: input ? input.disabled : null
    };
  }, id);

/** 走真实 UI：改输入框值 + change 事件 */
async function setField(page, id, value) {
  await page.evaluate(
    ([fieldId, next]) => {
      const input = document.querySelector(`.film-inspector input[data-field="${fieldId}"]`);
      if (!input) throw new Error(`找不到输入框：${fieldId}`);
      input.value = next;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    [id, value]
  );
  await page.evaluate(() => window.__panel.idle());
}

function inlineOf(film, id) {
  const re = new RegExp(`id="${id}"[^>]*style="([^"]*)"`);
  return re.exec(film)?.[1] ?? '';
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function shot(page, name) {
  const file = path.join(EVIDENCE_DIR, name);
  await page.screenshot({ path: file });
  const stat = await fs.stat(file);
  return { name, bytes: stat.size };
}

/* ── A1 mixed ──────────────────────────────────────────────────────────── */

test('S26-A1 选 2 个 x 不同的层：X 字段显示 mixed，不显示任何一个值', async () => {
  const project = await makeProject('s26-a1');
  const { handle, page, pageErrors } = await openProject(project, { selected: ['#a', '#b'] });

  const state = await readState(page);
  assert.equal(state.mode, 'multi');
  assert.equal(state.count, 2);
  assert.deepEqual(state.ats.sort(), ['#a', '#b']);

  const x = await fieldOf(page, 'x');
  assert.equal(x.mixed, 'true', `X 应标 mixed：${JSON.stringify(x)}`);
  assert.equal(x.value, '', `mixed 时输入框必须留空：${x.value}`);
  assert.equal(x.placeholder, '—');
  assert.notEqual(x.value, '100');
  assert.notEqual(x.value, '500');
  assert.equal(x.values, '100|500', `应记录各层真实值：${x.values}`);
  assert.equal(x.disabled, false, 'X 在 mixep 时仍可编辑（A2 要批量改）');

  const rotation = await fieldOf(page, 'rotation');
  assert.equal(rotation.mixed, 'false', '旋转相同（0/0）不该标 mixed');
  assert.equal(rotation.value, '0');

  const shotA1 = await shot(page, 's26-a1-mixed.png');
  assert.ok(shotA1.bytes > 10240, `截图应 >10KB：${shotA1.bytes}`);
  assert.equal(pageErrors.length, 0);

  evidence.cases['S26-A1'] = {
    ok: true,
    mode: state.mode,
    count: state.count,
    mixed: state.mixed,
    x,
    rotation,
    screenshot: shotA1,
    pageErrors
  };
  await handle.dispose();
});

/* ── A2 批量改 X ───────────────────────────────────────────────────────── */

test('S26-A2 改 X=100 → 2 条 op、1 次 /ops，两层 x 都是 100', async () => {
  const project = await makeProject('s26-a2');
  const { handle, page, pageErrors } = await openProject(project, { selected: ['#a', '#b'] });

  await setField(page, 'x', '100');
  const results = await readResults(page);
  const ops = await readOps(page);
  const fetches = await readFetches(page);

  assert.equal(results.length, 1, `只该提交 1 次：${JSON.stringify(results)}`);
  assert.equal(results[0].ok, true, `提交失败：${JSON.stringify(results[0])}`);
  assert.equal(postOpsCount(fetches), 1, `/ops 应恰好 1 次：${JSON.stringify(fetches)}`);
  assert.equal(ops.length, 1, '只该有 1 批');
  assert.equal(ops[0].length, 2, `一批应有 2 条 op：${JSON.stringify(ops[0])}`);
  const byClip = new Map(ops[0].map((op) => [op.clip, op.value]));
  assert.equal(byClip.get('a').x, 100);
  assert.equal(byClip.get('b').x, 100);
  assert.equal(byClip.get('a').y, 80, '只改 x，y 不该动');
  assert.equal(byClip.get('b').y, 300, 'b 的 y 也不该动');
  assert.equal(byClip.get('b').w, 200, 'b 的宽高不该被 a 覆盖');

  const film = await fs.readFile(project.filmPath, 'utf8');
  assert.ok(/left:\s*100px/.test(inlineOf(film, 'a')), `a 应 left:100px：${inlineOf(film, 'a')}`);
  assert.ok(/left:\s*100px/.test(inlineOf(film, 'b')), `b 应 left:100px：${inlineOf(film, 'b')}`);

  const afterX = await fieldOf(page, 'x');
  assert.equal(afterX.mixed, 'false', '批量改完 X 应变成共同值');
  assert.equal(afterX.value, '100');

  const domLeft = await page.evaluate(() => ({
    a: document.querySelector('#a').style.left,
    b: document.querySelector('#b').style.left
  }));
  assert.equal(domLeft.a, '100px');
  assert.equal(domLeft.b, '100px');

  const shotA2 = await shot(page, 's26-a2-batch.png');
  assert.ok(shotA2.bytes > 10240, `截图应 >10KB：${shotA2.bytes}`);
  assert.equal(pageErrors.length, 0);

  evidence.cases['S26-A2'] = {
    ok: true,
    op: ops[0],
    byClip: Object.fromEntries(byClip),
    commits: results.length,
    postOps: postOpsCount(fetches),
    http: { status: results[0].status, request: results[0].request, response: results[0].response },
    film: { a: inlineOf(film, 'a'), b: inlineOf(film, 'b') },
    afterX,
    screenshot: shotA2,
    pageErrors
  };
  await handle.dispose();
});

/* ── A3 一次 undo 两层都回原值 ─────────────────────────────────────────── */

test('S26-A3 一次 /undo：两层都回原值、film.html 逐字节相同', async () => {
  const project = await makeProject('s26-a3');
  const { handle, page, pageErrors } = await openProject(project, { selected: ['#a', '#b'] });

  const buf0 = await fs.readFile(project.filmPath);
  const hash0 = sha(buf0);

  await setField(page, 'x', '100');
  await waitFor(async () => (await readResults(page)).length >= 1);
  const hash1 = sha(await fs.readFile(project.filmPath));
  assert.notEqual(hash1, hash0, '提交后磁盘应变化');

  const undid = await page.evaluate(async () => {
    const res = await window.__client.undo();
    return { ok: res.ok, status: res.status, code: res.code ?? null, request: res.request, response: res.response };
  });
  assert.equal(undid.ok, true, `undo 失败：${JSON.stringify(undid)}`);

  const hash2 = sha(await fs.readFile(project.filmPath));
  assert.equal(hash2, hash0, '一次 undo 之后应与批量前逐字节相同');

  const doc = await get(`${studio.url}/api/projects/${encodeURIComponent(project.projectId)}/doc`);
  const parsed = doc.json.doc ?? doc.json;
  const clips = (parsed.tracks ?? []).flatMap((t) => t.clips ?? []);
  const byId = Object.fromEntries(clips.map((clip) => [clip.id, clip.box]));
  assert.equal(byId.a.x, 100);
  assert.equal(byId.b.x, 500, `b 应回 500：${byId.b.x}`);
  assert.equal(pageErrors.length, 0);

  evidence.cases['S26-A3'] = {
    ok: true,
    undo: undid,
    filmSha: { before: hash0, afterBatch: hash1, afterUndo: hash2 },
    boxes: { a: byId.a, b: byId.b },
    pageErrors
  };
  await handle.dispose();
});

/* ── A4 角度 mixed + MULTI_MIXED ───────────────────────────────────────── */

test('S26-A4 3 层里 2 层有 rotate：角度显示 mixed、置灰原因 MULTI_MIXED', async () => {
  const project = await makeProject('s26-a4', { a: BOXES.a, b: BOXES.b, c: BOXES.c }, { b: 30, c: 30 });
  const { handle, page, pageErrors } = await openProject(project, { selected: ['#a', '#b', '#c'], rotations: { b: 30, c: 30 } });

  const state = await readState(page);
  assert.equal(state.count, 3);
  assert.ok(state.mixed.includes('rotation'), `rotation 应 mixed：${JSON.stringify(state.mixed)}`);

  const rotation = await fieldOf(page, 'rotation');
  assert.equal(rotation.mixed, 'true');
  assert.equal(rotation.values, '0|30|30', `应记录 0|30|30：${rotation.values}`);
  assert.equal(rotation.editable, 'false');
  assert.equal(rotation.reason, 'MULTI_MIXED', `原因应是 MULTI_MIXED：${rotation.reason}`);
  assert.equal(rotation.disabled, true);
  assert.ok(rotation.chips.includes('MULTI_MIXED'), `原因角标应可见：${JSON.stringify(rotation.chips)}`);
  assert.ok((rotation.title ?? '').includes('MULTI_MIXED'), `title 也应带码：${rotation.title}`);

  /* 置灰字段提交必须被拒，且不写盘 */
  const before = sha(await fs.readFile(project.filmPath));
  const rejected = await page.evaluate(() => window.__panel.commitMultiField('rotation', '0'));
  const after = sha(await fs.readFile(project.filmPath));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'MULTI_MIXED');
  assert.equal(after, before, '置灰字段一个字节都不许写');
  assert.equal(postOpsCount(await readFetches(page)), 0);
  assert.equal(pageErrors.length, 0);

  evidence.cases['S26-A4'] = {
    ok: true,
    mixed: state.mixed,
    rotation,
    rejected: { ok: rejected.ok, code: rejected.code },
    filmSha: { before, after },
    pageErrors
  };
  await handle.dispose();
});

/* ── A5 锁定层参与多选 ─────────────────────────────────────────────────── */

test('S26-A5 锁定层参与多选：几何字段置灰原因 LOCKED，不写盘', async () => {
  const project = await makeProject('s26-a5');
  const { handle, page, pageErrors } = await openProject(project, { selected: ['#a', '#lock'], locked: ['#lock'] });

  const state = await readState(page);
  assert.equal(state.count, 2);
  assert.equal(state.locked, true, '多选里有一层锁定，整体应标 locked');

  const x = await fieldOf(page, 'x');
  assert.equal(x.editable, 'false');
  assert.equal(x.reason, 'LOCKED');
  assert.equal(x.disabled, true);
  assert.ok(x.chips.includes('LOCKED'), `原因角标应可见：${JSON.stringify(x.chips)}`);

  const before = sha(await fs.readFile(project.filmPath));
  const rejected = await page.evaluate(() => window.__panel.commitMultiField('x', '50'));
  const after = sha(await fs.readFile(project.filmPath));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'LOCKED');
  assert.equal(after, before, 'film.html 必须逐字节不变');
  assert.equal(postOpsCount(await readFetches(page)), 0, '0 次 /ops');

  const shotA5 = await shot(page, 's26-a5-locked.png');
  assert.ok(shotA5.bytes > 10240, `截图应 >10KB：${shotA5.bytes}`);
  assert.equal(pageErrors.length, 0);

  evidence.cases['S26-A5'] = {
    ok: true,
    locked: state.locked,
    x,
    rejected: { ok: rejected.ok, code: rejected.code },
    filmSha: { before, after },
    postOps: postOpsCount(await readFetches(page)),
    screenshot: shotA5,
    pageErrors
  };
  await handle.dispose();
});

/* ── A6 折叠状态 ───────────────────────────────────────────────────────── */

test('S26-A6 分组折叠：重选/重挂保持（会话内），刷新页面回默认', async () => {
  const project = await makeProject('s26-a6');
  const { handle, page, pageErrors } = await openProject(project, { selected: ['#a', '#b'] });

  const beforeToggle = await page.evaluate(() => {
    const body = document.querySelector('.film-inspector [data-group-body="geometry"]');
    return { display: body ? body.style.display : null };
  });
  assert.equal(beforeToggle.display, 'block', '默认应是展开');

  await page.click('.film-inspector [data-group-toggle="geometry"]');
  const collapsed = await page.evaluate(() => {
    const section = document.querySelector('.film-inspector [data-group="geometry"]');
    const body = document.querySelector('.film-inspector [data-group-body="geometry"]');
    const head = document.querySelector('.film-inspector [data-group-toggle="geometry"]');
    return {
      collapsed: section?.getAttribute('data-collapsed'),
      display: body ? body.style.display : null,
      expanded: head?.getAttribute('aria-expanded')
    };
  });
  assert.equal(collapsed.collapsed, 'true');
  assert.equal(collapsed.display, 'none');
  assert.equal(collapsed.expanded, 'false');

  /* 重新选一遍（面板重绘）→ 仍然折叠 */
  await page.evaluate(async () => {
    await window.__panel.selectMany(window.__refs);
  });
  const afterReselect = await page.evaluate(() => {
    const section = document.querySelector('.film-inspector [data-group="geometry"]');
    return { collapsed: section?.getAttribute('data-collapsed') };
  });
  assert.equal(afterReselect.collapsed, 'true', '重选后面板不该把折叠忘掉');

  /* 刷新页面 = 重新加载模块 → 回到默认展开 */
  await page.reload();
  await page.evaluate(mountMulti, depsFor(project, { selected: ['#a', '#b'] }));
  const afterReload = await page.evaluate(() => {
    const section = document.querySelector('.film-inspector [data-group="geometry"]');
    return { collapsed: section?.getAttribute('data-collapsed'), collapsedList: window.__panel.getState().collapsed };
  });
  assert.equal(afterReload.collapsed, 'false', '刷新页面应回到默认展开');
  assert.deepEqual(afterReload.collapsedList, []);
  assert.equal(pageErrors.length, 0);

  evidence.cases['S26-A6'] = {
    ok: true,
    defaultDisplay: beforeToggle.display,
    collapsed,
    afterReselect,
    afterReload,
    pageErrors
  };
  await handle.dispose();
});

/* ── A7 单选回归 ───────────────────────────────────────────────────────── */

test('S26-A7 单选行为与 S16 完全一致（px 解析 / 非法值拒绝 / 几何仍走 box）', async () => {
  const project = await makeProject('s26-a7');
  const { handle, page, pageErrors } = await openProject(project, { selected: ['#a'] });

  const state = await readState(page);
  assert.equal(state.mode, 'single');
  assert.equal(state.count, 1);

  const domMode = await page.evaluate(() => ({
    mode: document.querySelector('.film-inspector').getAttribute('data-mode'),
    mixedRows: document.querySelectorAll('.film-inspector [data-mixed]').length,
    fields: [...document.querySelectorAll('.film-inspector [data-field]')].map((row) => row.getAttribute('data-field'))
  }));
  assert.equal(domMode.mode, 'single');
  assert.equal(domMode.mixedRows, 0, '单选不该出现 data-mixed');
  /* R121 · M7-B（D02）：右栏改成对象页签后，**默认只渲染当前页签**的字段。
     默认页是 `props`（`state.activeTab: 'props'`，R121 定的），所以先核默认页，再切到文本页核 fontSize。
     （原来这里写的是「默认（文本）页签里应有 fontSize」——M7-B 之后默认已不是文本页，断言本身过期了；
     改成「默认属性页 + 切过去能看到」比原来更强：页签漏字段会红。） */
  const defaultTab = await page.evaluate(() => document.querySelector('.film-inspector')?.getAttribute('data-object-tab'));
  assert.equal(defaultTab, 'props', '默认停在属性页（R121 · M7-B）');
  assert.ok(domMode.fields.includes('x'), '默认（属性）页签里应有 x');
  /* 页签只是**视图分流**：字段在模型里（`getState().fields`），切页签只决定画哪一页。
     直接查模型比点页签稳（`data-object-tab` 同时挂在根和按钮上，`querySelector` 会先命中根，
     点根是空操作 —— 原来的 `props` 点击其实一直是空操作）。 */
  const modelFields = await page.evaluate(() => window.__panel.getState().fields.map((field) => field.id));
  assert.ok(modelFields.includes('fontSize'), '模型里应有 fontSize（文本页字段）');
  assert.ok(modelFields.includes('x'), '模型里应有 x（属性页字段）');

  /* px 解析：60 → 60px */
  const fontSize = await page.evaluate(() => window.__panel.commitField('fontSize', '60'));
  assert.equal(fontSize.ok, true, `fontSize 提交失败：${JSON.stringify(fontSize)}`);
  const ops1 = await readOps(page);
  const entries = ops1[0][0].entries;
  const fsEntry = entries.find((entry) => entry.at === '#a');
  assert.equal(fsEntry.style['font-size'], '60px', `应写 60px：${JSON.stringify(fsEntry)}`);

  /* 行高保持倍数（不带单位） */
  await page.evaluate(() => window.__panel.commitField('lineHeight', '1.5'));
  const ops2 = await readOps(page);
  const lhEntry = ops2[1][0].entries.find((entry) => entry.at === '#a');
  assert.equal(lhEntry.style['line-height'], '1.5', `行高应保持倍数：${JSON.stringify(lhEntry)}`);

  /* 非法值拒绝，且不多发一次请求 */
  const postsBefore = postOpsCount(await readFetches(page));
  const bad1 = await page.evaluate(() => window.__panel.commitField('fontSize', 'abc'));
  const bad2 = await page.evaluate(() => window.__panel.commitField('fontSize', '0'));
  const postsAfter = postOpsCount(await readFetches(page));
  assert.equal(bad1.ok, false);
  assert.equal(bad1.code, 'INVALID_VALUE');
  assert.equal(bad2.ok, false);
  assert.equal(bad2.code, 'INVALID_VALUE', `字号 0 应被拒：${JSON.stringify(bad2)}`);
  assert.equal(postsAfter, postsBefore, '非法值不该发请求');

  /* 几何仍走 set（单选那条路径） */
  const boxed = await page.evaluate(() => window.__panel.commitBoxField('w', '400'));
  assert.equal(boxed.ok, true, `几何提交失败：${JSON.stringify(boxed)}`);
  const ops3 = await readOps(page);
  const last = ops3[ops3.length - 1][0];
  assert.deepEqual(last, { op: 'set', clip: 'a', field: 'box', value: { x: 100, y: 80, w: 400, h: 150 } });

  const negW = await page.evaluate(() => window.__panel.commitBoxField('w', '-5'));
  assert.equal(negW.ok, false);
  assert.ok(['INVALID', 'INVALID_VALUE'].includes(negW.code), `负宽应被拒：${JSON.stringify(negW)}`);
  assert.equal(pageErrors.length, 0);

  evidence.cases['S26-A7'] = {
    ok: true,
    mode: state.mode,
    domMode,
    fontSize: { ok: fontSize.ok, entry: fsEntry },
    lineHeight: { entry: lhEntry },
    invalid: { abc: bad1.code, zero: bad2.code, postsBefore, postsAfter },
    box: { ok: boxed.ok, op: last },
    negativeWidth: { ok: negW.ok, code: negW.code },
    pageErrors
  };
  await handle.dispose();
});

/* ── A2S 支撑用例：多选改文字/样式也是一批 ─────────────────────────────── */

test('S26-A2S 多选改字号：2 条 overrides op 一批（样式字段同样适用）', async () => {
  const project = await makeProject('s26-a2s');
  const { handle, page, pageErrors } = await openProject(project, { selected: ['#a', '#b'] });

  const state = await readState(page);
  const fontSize = await fieldOf(page, 'fontSize');
  assert.equal(fontSize.values, '16|16', `两层字号应相同：${fontSize.values}`);
  assert.equal(fontSize.mixed, 'false');

  await setField(page, 'fontSize', '60');
  const results = await readResults(page);
  const ops = await readOps(page);
  assert.equal(results.length, 1);
  assert.equal(ops.length, 1, '一批');
  assert.equal(ops[0].length, 2, `2 条 op：${JSON.stringify(ops[0])}`);
  assert.ok(ops[0].every((op) => op.op === 'overrides'), `应全是 overrides：${JSON.stringify(ops[0])}`);
  for (const op of ops[0]) {
    const entry = op.entries.find((item) => item.at === `#${op.clip}`);
    assert.equal(entry.style['font-size'], '60px', `每层都要写 60px：${JSON.stringify(entry)}`);
  }
  assert.equal(postOpsCount(await readFetches(page)), 1);
  assert.equal(pageErrors.length, 0);

  evidence.cases['S26-A2S'] = {
    ok: true,
    count: state.count,
    fontSizeBefore: fontSize.values,
    ops: ops[0],
    commits: results.length,
    postOps: postOpsCount(await readFetches(page)),
    pageErrors
  };
  await handle.dispose();
});

/* ── A8 pageErrors 空 ──────────────────────────────────────────────────── */

test('S26-A8 一整串多选操作 pageErrors 空', async () => {
  const project = await makeProject('s26-a8');
  const { handle, page, pageErrors } = await openProject(project, { selected: ['#a', '#b'] });

  await setField(page, 'x', '100');
  await setField(page, 'y', '120');
  await page.click('.film-inspector [data-group-toggle="appearance"]');
  await page.click('.film-inspector [data-group-toggle="appearance"]');
  await page.evaluate(async () => {
    await window.__panel.selectMany(window.__refs);
    await window.__panel.select(window.__refs[0]);
    await window.__panel.selectMany(window.__refs);
  });

  const state = await readState(page);
  assert.deepEqual(pageErrors, [], `不该有 pageerror：${pageErrors}`);
  assert.equal(state.mode, 'multi');
  evidence.cases['S26-A8'] = { ok: true, pageErrors, mode: state.mode, status: state.status };
  await handle.dispose();
});
