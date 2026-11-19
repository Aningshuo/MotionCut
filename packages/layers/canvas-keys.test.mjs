// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S25-CANVAS-KEYS 验收 A1..A9
 *
 * 真 Studio + 真 film 工程：方向键微移 → 一批 op → 一次 `/ops` → 读回磁盘 → 一次 `/undo`。
 * A4 在运行时给 `#a` 套一层 `transform:scale(2)` 的定位父级（film.html 不变：body 里只认
 * `<section>` 轨道与片段，合同不允许 div 包装），验「屏幕 +10 → 声明 +5、屏幕实际 +10」。
 * A7 挂的是**真的** `mountInspector`（不是假的输入框），焦点进它的文本框后按方向键必须不劫持。
 *
 * 运行：node --test --test-concurrency=1 packages/layers/canvas-keys.test.mjs（env 由 test-env.mjs 自动准备；`OPENCUT_ENV_JSON` 可显式覆盖）
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

const TEST_ENV = await resolveLayerTestEnv({ suite: 'canvas-keys' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');
const PROJECTS = path.join(RUN_ROOT, 'projects');
const BUNDLE_ABS = path.join(RUN_ROOT, 'tmp/s25/keys.mjs');
const BUNDLE_URL = '/' + path.relative(REPO_ROOT, BUNDLE_ABS).split(path.sep).join('/');

const STAGE_W = 1280;
const STAGE_H = 720;
const BATCH = 'B-SUB1-R13-013';

/** 5 个层：a/b/c 可选，lock 锁定，hidden 隐藏。 */
const BOXES = {
  a: { x: 100, y: 80, w: 300, h: 150 },
  b: { x: 400, y: 80, w: 200, h: 100 },
  c: { x: 100, y: 300, w: 150, h: 120 },
  lock: { x: 700, y: 300, w: 120, h: 100 },
  hidden: { x: 700, y: 500, w: 120, h: 100 }
};
/** 图层树的视觉顺序（Tab 必须照它走）。 */
const TREE_ORDER = ['#a', '#b', '#c', '#lock', '#hidden'];

const SCENE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;background:#fdf6e3}
.t{font:20px/1.4 "PingFang SC",Arial;color:#123;padding:10px}
</style></head><body><div class="t">键盘微移验收 · 真实文字</div></body></html>`;

function filmHtml(boxes) {
  const frames = Object.entries(boxes)
    .map(
      ([id, box]) =>
        `<iframe id="${id}" src="scene.html#t=0,4" at="0" style="left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px"></iframe>`
    )
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
  suite: 'canvas-keys.test.mjs',
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
        "export * from './packages/layers/canvas-gesture.mjs';",
        "export { createOpsClient } from './packages/layers/ops-client.mjs';",
        "export { mountInspector } from './packages/layers/inspector-panel.mjs';"
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
  for (const name of ['s25-a2-nudge.png', 's25-a7-focus.png']) {
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
  await fs.writeFile(path.join(EVIDENCE_DIR, 's25-canvas-keys.json'), JSON.stringify(evidence, null, 2) + '\n');
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

async function makeProject(name, boxes = BOXES) {
  const dir = path.join(PROJECTS, `${name}-${process.pid}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'scene.html'), SCENE_HTML);
  const film = filmHtml(boxes);
  await fs.writeFile(path.join(dir, 'film.html'), film);
  const opened = await post(`${studio.url}/api/projects/open`, { dir });
  assert.equal(opened.status, 200, `open 失败：${opened.text}`);
  const projectId = opened.json.project.projectId;
  const doc = await get(`${studio.url}/api/projects/${encodeURIComponent(projectId)}/doc`);
  assert.equal(doc.status, 200, `doc 失败：${doc.text}`);
  return { dir, projectId, hash: doc.json.hash, filmPath: path.join(dir, 'film.html'), filmHtml: film };
}

/**
 * 页内挂载：手势层 +（可选）真检查器面板。
 * `deps.layers` 每项 `{at, box, clip, rect?, geometry?, locked?}`；没给 rect 就按 box 当实测。
 */
async function mountAll(deps) {
  const mod = await import(deps.bundle);
  const stageEl = document.querySelector('section');
  const all = deps.layers.map((item) => {
    /** @type {any} */
    const layer = { at: item.at, box: { ...item.box } };
    if (item.clip) layer.clip = item.clip;
    layer.rect = item.rect ? { ...item.rect } : { x: item.box.x, y: item.box.y, w: item.box.w, h: item.box.h };
    if (item.geometry) layer.geometry = { ...item.geometry };
    if (item.locked === true) layer.locked = true;
    return layer;
  });
  const byAt = new Map(all.map((layer) => [layer.at, layer]));

  window.__all = all;
  window.__byAt = byAt;
  window.__hidden = new Set(deps.hidden ?? []);
  window.__locked = new Set(deps.locked ?? []);
  window.__selected = (deps.selected ?? []).map((at) => byAt.get(at)).filter(Boolean);
  window.__ops = [];
  window.__previews = [];
  window.__results = [];
  window.__errors = [];
  window.__selectionLog = [];
  window.__cancels = 0;
  window.__fetches = [];

  const realFetch = window.fetch.bind(window);
  window.fetch = (...args) => {
    const init = args[1] || {};
    window.__fetches.push({ url: String(args[0]), method: init.method || 'GET', body: init.body ? String(init.body) : null });
    return realFetch(...args);
  };

  const client = mod.createOpsClient({
    projectId: deps.projectId,
    batchId: deps.batchId,
    owner: 'SUB1',
    expectedHash: deps.expectedHash,
    baseUrl: deps.baseUrl
  });
  window.__client = client;

  /** 宿主提交成功后的回写（真实宿主会这么做；截图才拍得到结果） */
  window.__applyOps = (ops) => {
    for (const op of ops) {
      const layer = op.clip ? all.find((item) => item.clip === op.clip) : window.__selected[0] ?? null;
      if (!layer) continue;
      layer.box = { ...op.value };
      const lin = layer.geometry && layer.geometry.linear ? layer.geometry.linear : null;
      const sx = lin ? Number(lin.a) : 1;
      const sy = lin ? Number(lin.d) : 1;
      layer.rect = { x: op.value.x * sx, y: op.value.y * sy, w: op.value.w * sx, h: op.value.h * sy };
      const el = document.querySelector(layer.at);
      if (!el) continue;
      el.style.left = `${op.value.x}px`;
      el.style.top = `${op.value.y}px`;
      el.style.width = `${op.value.w}px`;
      el.style.height = `${op.value.h}px`;
      if (typeof op.value.r === 'number' && op.value.r !== 0) el.style.rotate = `${op.value.r}deg`;
      else el.style.removeProperty('rotate');
    }
    if (window.__gesture) window.__gesture.refresh();
    if (window.__panel) window.__panel.refresh?.();
  };

  const commit = async (ops) => {
    const payload = ops.map((op) => ({
      op: 'set',
      clip: op.clip ?? window.__selected[0]?.clip,
      field: 'box',
      value: op.value
    }));
    window.__ops.push(payload);
    const res = await client.commitOps(payload);
    window.__results.push({
      ok: res.ok === true,
      status: res.status,
      code: res.code ?? null,
      request: res.request,
      response: res.response
    });
    if (res.ok) window.__applyOps(ops);
    else if (window.__gesture) window.__gesture.refresh();
    return res;
  };

  window.__gesture = mod.mountCanvasGesture(document.body, {
    getStageRect: () => {
      const r = stageEl.getBoundingClientRect();
      const scale = deps.stageSize.w > 0 ? r.width / deps.stageSize.w : 1;
      return { x: r.x, y: r.y, w: r.width, h: r.height, scale: scale > 0 ? scale : 1 };
    },
    getSelectionSet: () => window.__selected,
    getLayerRects: () => all,
    isHidden: (at) => window.__hidden.has(at),
    isLocked: (at) => window.__locked.has(at),
    getLayerOrder: () => (deps.order && deps.order.length ? deps.order : all.map((layer) => layer.at)),
    onPreview: (op) => window.__previews.push(op),
    onCommit: (op) => {
      void commit([op]);
    },
    onCommitMany: (ops) => {
      void commit(ops);
    },
    onSelectionChange: (ats) => {
      window.__selectionLog.push(ats);
      /* 真实宿主在这里更新自己的选择（React 里是 setState）；测试同步镜像一份 */
      window.__selected = ats.map((at) => window.__byAt.get(at)).filter(Boolean);
    },
    onCancel: () => {
      window.__cancels += 1;
      if (window.__gesture) window.__gesture.refresh();
    },
    onError: (info) => window.__errors.push(info),
    stageSize: deps.stageSize
  });

  if (deps.withPanel === true) {
    const host = document.createElement('div');
    host.id = 'r13-panel';
    host.setAttribute(
      'style',
      'position:fixed;right:0;top:0;width:360px;height:100vh;background:#111a2e;color:#f2f6ff;z-index:9999;overflow:auto;padding:10px;box-sizing:border-box'
    );
    const style = document.createElement('style');
    style.textContent = [
      '#r13-panel .inspector-group-label{font:13px/1.6 system-ui;color:#9fb3d1;margin:12px 0 6px}',
      '#r13-panel .inspector-field{display:flex;align-items:center;gap:6px;margin:4px 0;font:13px/1.5 system-ui}',
      '#r13-panel .inspector-field-label{flex:0 0 64px;color:#eaf2ff;font-size:13px}',
      '#r13-panel .inspector-input{flex:1;min-width:0;padding:3px 5px;border:1px solid rgba(120,140,180,.55);border-radius:4px;background:#0b1220;color:#eaf2ff;font:13px/1.4 ui-monospace,Menlo,monospace}',
      '#r13-panel .inspector-field-source,#r13-panel .inspector-field-space{opacity:.6;font:11px/1.4 system-ui}',
      '#r13-panel .inspector-status{margin-top:8px;font:11px/1.6 system-ui;opacity:.7}',
      /* film.html 有全局 section{width:1280px;height:720px}（舞台轨道），面板分组也是 <section>：
         测试容器里复位一下，否则面板会被撑到 1280 宽。真实 Studio 面板在 UI 文档里，不会撞。 */
      '#r13-panel section{width:auto;height:auto;position:static;display:block}'
    ].join('\n');
    document.head.appendChild(style);
    document.body.appendChild(host);
    const panel = mod.mountInspector(host, {
      describe: async () => ({
        box: { x: 100, y: 80, w: 300, h: 150, rotation: 0 },
        style: { 'font-size': '20px', 'line-height': '28px', 'font-weight': '400' },
        text: '示例文本 abc',
        locked: false
      }),
      preview: async () => ({ ok: true }),
      commit: async () => ({ ok: true, hash: 'panel-hash' }),
      commitBox: async () => ({ ok: true, hash: 'panel-hash' })
    });
    await panel.select({ clipId: 'a', at: '#a', kind: 'iframe', name: 'a', depth: 1 });
    window.__panel = panel;
  }

  return { ats: window.__gesture.getState().ats, count: window.__selected.length };
}

function layersPayload(deps = {}) {
  return Object.entries(deps.boxes ?? BOXES).map(([id, box]) => ({
    at: `#${id}`,
    clip: id,
    box,
    rect: deps.rects && deps.rects[id] ? deps.rects[id] : undefined,
    geometry: deps.geometries && deps.geometries[id] ? deps.geometries[id] : undefined,
    locked: (deps.locked ?? ['#lock']).includes(`#${id}`)
  }));
}

async function openProject(project, deps = {}) {
  const filmRel = path.relative(REPO_ROOT, project.filmPath).split(path.sep).join('/');
  const handle = await host.open(filmRel);
  const page = handle.page;
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.evaluate(mountAll, {
    bundle: BUNDLE_URL,
    projectId: project.projectId,
    batchId: BATCH,
    expectedHash: project.hash,
    baseUrl: studio.url,
    layers: layersPayload(deps),
    selected: deps.selected ?? [],
    hidden: deps.hidden ?? ['#hidden'],
    locked: deps.locked ?? ['#lock'],
    order: deps.order ?? TREE_ORDER,
    stageSize: { w: STAGE_W, h: STAGE_H },
    withPanel: deps.withPanel === true
  });
  return { handle, page, pageErrors };
}

/* ── 小工具 ─────────────────────────────────────────────────────────────── */

const readState = (page) => page.evaluate(() => window.__gesture.getState());
const readOps = (page) => page.evaluate(() => window.__ops.map((ops) => ops.map((op) => ({ ...op }))));
const readResults = (page) => page.evaluate(() => window.__results.map((r) => ({ ...r })));
const readErrors = (page) => page.evaluate(() => window.__errors.map((info) => ({ ...info })));
const readPreviews = (page) => page.evaluate(() => window.__previews.length);
const readFetches = (page) => page.evaluate(() => window.__fetches.map((f) => ({ ...f })));
const pageErrorCount = (page, errors) => errors.length;

const selectAt = (page, ats) =>
  page.evaluate((list) => {
    window.__selected = list.map((at) => window.__byAt.get(at)).filter(Boolean);
    window.__gesture.refresh();
    return window.__gesture.getState().ats;
  }, ats);

/** Node 侧真定时器轮询（页内是受控时钟，不能用 page.waitForTimeout 的思路） */
async function waitFor(check, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

async function waitCommits(page, n) {
  const ok = await waitFor(async () => (await readResults(page)).length >= n);
  assert.ok(ok, `等提交超时（期望 ${n} 次）`);
  return readResults(page);
}

const postOpsCount = (fetches) => fetches.filter((f) => f.method === 'POST' && /\/ops$/.test(f.url)).length;

function inlineOf(film, id) {
  const re = new RegExp(`id="${id}"[^>]*style="([^"]*)"`);
  return re.exec(film)?.[1] ?? '';
}

async function shot(page, name) {
  const file = path.join(EVIDENCE_DIR, name);
  await page.screenshot({ path: file });
  const stat = await fs.stat(file);
  return { name, bytes: stat.size };
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/* ── A1 单次 → 右移 1px ─────────────────────────────────────────────────── */

test('S25-A1 按一次 →：box.x +1、1 次 /ops、1 条 op', async () => {
  const project = await makeProject('s25-a1');
  const { handle, page, pageErrors } = await openProject(project, { selected: ['#a'] });
  await selectAt(page, ['#a']);

  const before = await readState(page);
  assert.equal(before.box.x, 100);
  const film0 = await fs.readFile(project.filmPath, 'utf8');

  await page.keyboard.press('ArrowRight');
  const results = await waitCommits(page, 1);
  const after = await readState(page);
  const ops = await readOps(page);
  const fetches = await readFetches(page);

  assert.equal(after.box.x, 101, `box.x 应 +1：${after.box.x}`);
  assert.equal(results.length, 1, '只该有一次提交');
  assert.equal(ops.length, 1, '只该有一批');
  assert.equal(ops[0].length, 1, '单选一批只该有 1 条 op');
  assert.deepEqual(ops[0][0].value, { x: 101, y: 80, w: 300, h: 150 });
  assert.equal(postOpsCount(fetches), 1, `/ops 应恰好 1 次：${JSON.stringify(fetches)}`);

  const film1 = await fs.readFile(project.filmPath, 'utf8');
  assert.ok(/left:\s*101px/.test(inlineOf(film1, 'a')), `磁盘应是 left:101px：${inlineOf(film1, 'a')}`);
  assert.equal(pageErrors.length, 0);

  evidence.cases['S25-A1'] = {
    ok: true,
    before: before.box,
    after: after.box,
    op: ops[0][0],
    commits: results.length,
    opsPerBatch: ops.map((batch) => batch.length),
    postOps: postOpsCount(fetches),
    http: { status: results[0].status, request: results[0].request, response: results[0].response },
    diskBefore: inlineOf(film0, 'a'),
    diskAfter: inlineOf(film1, 'a'),
    pageErrors
  };
  await handle.dispose();
});

/* ── A2 按住 10 次 → 只 1 次 /ops ───────────────────────────────────────── */

test('S25-A2 按住 → 连发 10 次：只 1 次 /ops、box.x +10（拖动中框与 HUD 跟着走）', async () => {
  const project = await makeProject('s25-a2');
  const { handle, page, pageErrors } = await openProject(project, { selected: ['#a'] });
  await selectAt(page, ['#a']);

  for (let i = 0; i < 10; i += 1) await page.keyboard.down('ArrowRight');

  const mid = await readState(page);
  assert.equal(mid.mode, 'nudge', `按住期间应是 nudge 模式：${mid.mode}`);
  assert.equal(mid.nudge.acc.x, 10, `累积应是 10：${JSON.stringify(mid.nudge)}`);
  assert.equal(mid.holdPreview, false, '还没提交');
  const midResults = await readResults(page);
  assert.equal(midResults.length, 0, '还没松手不该提交');
  assert.equal((await readOps(page)).length, 0);

  /* 截图：框与 HUD 已经走到 110,80（不等落盘） */
  const hud = await page.evaluate(() => {
    const node = document.querySelector('[data-gesture-hud]');
    return { text: node?.textContent ?? null, display: node ? getComputedStyle(node).display : null };
  });
  assert.equal(hud.display, 'block', `手势中 HUD 应可见：${JSON.stringify(hud)}`);
  assert.equal(hud.text, '110,80 · 300×150', `HUD 应显示预览值：${hud.text}`);
  const frameMid = await page.evaluate(() => window.__gesture.getState().frame);
  const shotA2 = await shot(page, 's25-a2-nudge.png');
  assert.ok(shotA2.bytes > 10240, `截图应 >10KB：${shotA2.bytes}`);

  await page.keyboard.up('ArrowRight');
  const results = await waitCommits(page, 1);
  const after = await readState(page);
  const ops = await readOps(page);
  const fetches = await readFetches(page);

  assert.equal(after.box.x, 110, `box.x 应 +10：${after.box.x}`);
  assert.equal(results.length, 1, `只该提交 1 次：${results.length}`);
  assert.equal(ops.length, 1, `只该有 1 批：${ops.length}`);
  assert.equal(ops[0].length, 1);
  assert.equal(postOpsCount(fetches), 1, `/ops 应恰好 1 次：${JSON.stringify(fetches)}`);
  assert.equal(after.nudgeReason, 'keyup');
  assert.equal(pageErrors.length, 0);

  const film = await fs.readFile(project.filmPath, 'utf8');
  assert.ok(/left:\s*110px/.test(inlineOf(film, 'a')), `磁盘应是 left:110px：${inlineOf(film, 'a')}`);

  evidence.cases['S25-A2'] = {
    ok: true,
    midDrag: { mode: mid.mode, acc: mid.nudge, hud, frame: frameMid, commits: midResults.length },
    after: after.box,
    commits: results.length,
    opsPerBatch: ops.map((batch) => batch.length),
    postOps: postOpsCount(fetches),
    nudgeReason: after.nudgeReason,
    screenshot: shotA2,
    diskAfter: inlineOf(film, 'a'),
    pageErrors
  };
  await handle.dispose();
});

/* ── A3 Shift / Alt 步长 ────────────────────────────────────────────────── */

test('S25-A3 Shift+→ = +10、Alt+→ = +0.1（浮点误差 ≤0.01）', async () => {
  const project = await makeProject('s25-a3');
  const { handle, page, pageErrors } = await openProject(project, { selected: ['#a'] });
  await selectAt(page, ['#a']);

  await page.keyboard.press('Shift+ArrowRight');
  await waitCommits(page, 1);
  const shifted = await readState(page);
  assert.equal(shifted.box.x, 110, `Shift+→ 应 +10：${shifted.box.x}`);

  await page.keyboard.press('Alt+ArrowRight');
  await waitCommits(page, 2);
  const alted = await readState(page);
  const delta = alted.box.x - 110;
  assert.ok(Math.abs(delta - 0.1) <= 0.01, `Alt+→ 应 +0.1（误差 ≤0.01）：${alted.box.x}`);

  /* 下/左也验一下方向 */ 
  await page.keyboard.press('Shift+ArrowDown');
  await waitCommits(page, 3);
  const downed = await readState(page);
  assert.equal(downed.box.y, 90, `Shift+↓ 应 +10：${downed.box.y}`);

  await page.keyboard.press('ArrowLeft');
  await waitCommits(page, 4);
  const lefted = await readState(page);
  assert.ok(Math.abs(lefted.box.x - 109.1) <= 0.01, `← 应 -1（109.1）：${lefted.box.x}`);

  assert.equal(pageErrors.length, 0);
  evidence.cases['S25-A3'] = {
    ok: true,
    shift: { x: shifted.box.x, expected: 110 },
    alt: { x: alted.box.x, delta: Math.round(delta * 1000) / 1000, expected: 0.1 },
    shiftDown: { y: downed.box.y, expected: 90 },
    left: { x: lefted.box.x, expected: 109.1 },
    pageErrors
  };
  await handle.dispose();
});

/* ── A4 祖先 scale(2)：屏幕 +10 → 声明 +5 ──────────────────────────────── */

test('S25-A4 祖先 scale(2)：屏幕 +10px → 声明只 +5，屏幕实际 +10', async () => {
  const project = await makeProject('s25-a4', { a: { x: 50, y: 40, w: 200, h: 100 } });
  const { handle, page, pageErrors } = await openProject(project, {
    boxes: { a: { x: 50, y: 40, w: 200, h: 100 } },
    selected: ['#a'],
    locked: [],
    hidden: []
  });

  /* 运行时给 #a 套一层 scale(2) 的定位父级：film.html 不动（body 里只认 section/片段） */
  const wrap = await page.evaluate(() => {
    const el = document.querySelector('#a');
    const holder = document.createElement('div');
    holder.setAttribute(
      'style',
      'position:absolute;left:0;top:0;width:640px;height:360px;transform-origin:0 0;transform:scale(2)'
    );
    el.parentNode.insertBefore(holder, el);
    holder.appendChild(el);
    const r = el.getBoundingClientRect();
    const s = document.querySelector('section').getBoundingClientRect();
    return { screen: { x: r.x - s.x, y: r.y - s.y, w: r.width, h: r.height }, stage: { x: s.x, y: s.y, w: s.width, h: s.height } };
  });
  /* 宿主把实测矩形与祖先线性部分补给手势层（真实宿主读 readGeometrySpace） */
  await page.evaluate((measured) => {
    const layer = window.__byAt.get('#a');
    layer.geometry = { linear: { a: 2, b: 0, c: 0, d: 2 }, rotationDeg: 0 };
    layer.rect = { ...measured };
    window.__selected = [layer];
    window.__gesture.refresh();
  }, wrap.screen);

  const stageScale = await page.evaluate(() => window.__gesture.getState().stage.scale);
  assert.equal(stageScale, 1, `舞台本身不缩放（scale 应是 1）：${stageScale}`);

  const before = await readState(page);
  assert.equal(before.box.x, 50);

  await page.keyboard.press('Shift+ArrowRight');
  await waitCommits(page, 1);
  const after = await readState(page);

  const screenX = await page.evaluate(() => document.querySelector('#a').getBoundingClientRect().x - document.querySelector('section').getBoundingClientRect().x);

  assert.equal(after.box.x, 55, `声明应只 +5：${after.box.x}`);
  assert.ok(Math.abs(screenX - 110) <= 0.5, `屏幕应从 100 到 110（+10）：${screenX}`);
  assert.equal(pageErrors.length, 0);

  const film = await fs.readFile(project.filmPath, 'utf8');
  assert.ok(/left:\s*55px/.test(inlineOf(film, 'a')), `磁盘应是 left:55px：${inlineOf(film, 'a')}`);

  evidence.cases['S25-A4'] = {
    ok: true,
    screenBefore: wrap.screen.x,
    declaredBefore: before.box.x,
    declaredAfter: after.box.x,
    declaredDelta: after.box.x - before.box.x,
    screenAfter: screenX,
    screenDelta: screenX - wrap.screen.x,
    stageScale,
    note: 'scale(2) 的定位父级由测试在运行时插入（film.html 的 body 只认 <section>/片段，合同不允许 div 包装）',
    diskAfter: inlineOf(film, 'a'),
    pageErrors
  };
  await handle.dispose();
});

/* ── A5 一次 undo 回微移前 ─────────────────────────────────────────────── */

test('S25-A5 一次 /undo 回到微移前（整批回退、film.html 逐字节相同）', async () => {
  const project = await makeProject('s25-a5');
  const { handle, page, pageErrors } = await openProject(project, { selected: ['#a'] });
  await selectAt(page, ['#a']);

  const buf0 = await fs.readFile(project.filmPath);
  const hash0 = sha(buf0);

  await page.keyboard.down('Shift');
  for (let i = 0; i < 3; i += 1) await page.keyboard.down('ArrowRight');
  for (let i = 0; i < 3; i += 1) await page.keyboard.up('ArrowRight');
  await page.keyboard.up('Shift');
  await waitCommits(page, 1);
  const nudged = await readState(page);
  assert.equal(nudged.box.x, 130, `三步 Shift 应 +30：${nudged.box.x}`);
  const hash1 = sha(await fs.readFile(project.filmPath));
  assert.notEqual(hash1, hash0, '提交后磁盘应变化');

  const undid = await page.evaluate(async () => {
    const res = await window.__client.undo();
    return { ok: res.ok, status: res.status, hash: res.hash ?? null, code: res.code ?? null, request: res.request, response: res.response };
  });
  assert.equal(undid.ok, true, `undo 失败：${JSON.stringify(undid)}`);

  const hash2 = sha(await fs.readFile(project.filmPath));
  assert.equal(hash2, hash0, '一次 undo 之后 film.html 应与微移前逐字节相同');

  const doc = await get(`${studio.url}/api/projects/${encodeURIComponent(project.projectId)}/doc`);
  const parsed = doc.json.doc ?? doc.json;
  const clip = (parsed.tracks ?? []).flatMap((t) => t.clips ?? []).find((c) => c.id === 'a');
  assert.equal(clip.box.x, 100, `doc 应回 100：${clip.box.x}`);
  assert.equal(pageErrors.length, 0);

  evidence.cases['S25-A5'] = {
    ok: true,
    nudgeBatch: { declaredX: nudged.box.x, commits: 1 },
    undo: undid,
    filmSha: { before: hash0, afterNudge: hash1, afterUndo: hash2 },
    docXAfterUndo: clip.box.x,
    pageErrors
  };
  await handle.dispose();
});

/* ── A6 Tab 循环 ───────────────────────────────────────────────────────── */

test('S25-A6 Tab 循环跳过锁定/隐藏，顺序与图层树一致（贴访问序列）', async () => {
  const project = await makeProject('s25-a6');
  const { handle, page, pageErrors } = await openProject(project, { selected: ['#a'] });
  await selectAt(page, ['#a']);

  /** @type {{from: string|null, to: string|null}[]} */
  const forward = [];
  for (let i = 0; i < 5; i += 1) {
    const from = (await readState(page)).at;
    await page.keyboard.press('Tab');
    const to = (await readState(page)).at;
    forward.push({ from, to });
  }
  const forwardSeq = forward.map((step) => step.to);
  assert.deepEqual(forwardSeq, ['#b', '#c', '#a', '#b', '#c'], `Tab 序列不对：${JSON.stringify(forwardSeq)}`);
  assert.ok(!forwardSeq.includes('#lock'), '锁定层不该被 Tab 选中');
  assert.ok(!forwardSeq.includes('#hidden'), '隐藏层不该被 Tab 选中');

  /** @type {string[]} */
  const backward = [];
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press('Shift+Tab');
    backward.push((await readState(page)).at);
  }
  assert.deepEqual(backward, ['#b', '#a', '#c'], `Shift+Tab 序列不对：${JSON.stringify(backward)}`);

  const selectionLog = await page.evaluate(() => window.__selectionLog.map((ats) => ats.slice()));
  const selectable = (await readState(page)).selectable;
  assert.deepEqual(selectable, ['#a', '#b', '#c'], `可选层应只有 a/b/c：${JSON.stringify(selectable)}`);
  assert.equal(pageErrors.length, 0);

  evidence.cases['S25-A6'] = {
    ok: true,
    treeOrder: TREE_ORDER,
    selectable,
    forward,
    forwardSeq,
    backward,
    selectionLog,
    pageErrors
  };
  await handle.dispose();
});

/* ── A7 输入态不劫持 ───────────────────────────────────────────────────── */

test('S25-A7 焦点在检查器输入框：→ 只移光标，box 不变、0 次 /ops', async () => {
  const project = await makeProject('s25-a7');
  const { handle, page, pageErrors } = await openProject(project, { selected: ['#a'], withPanel: true });
  await selectAt(page, ['#a']);

  const focus = await page.evaluate(() => {
    const input = document.querySelector('#r13-panel input[data-field="text"]');
    if (!input) return { ok: false };
    input.focus();
    input.value = 'abcdef';
    input.setSelectionRange(3, 3);
    return { ok: true, active: document.activeElement === input, start: input.selectionStart, type: input.type };
  });
  assert.equal(focus.ok, true, '面板里应有「内容」文本框');
  assert.equal(focus.active, true);
  assert.equal(focus.type, 'text');

  const before = await readState(page);
  await page.keyboard.press('ArrowRight');
  const afterCaret = await page.evaluate(() => document.querySelector('#r13-panel input[data-field="text"]').selectionStart);
  /* 再按几次方向键，仍然不许被画布抢走 */
  for (let i = 0; i < 4; i += 1) await page.keyboard.press('ArrowRight');

  const after = await readState(page);
  const results = await readResults(page);
  const fetches = await readFetches(page);
  const activeAfter = await page.evaluate(() => document.activeElement?.getAttribute('data-field') ?? document.activeElement?.tagName ?? null);

  assert.equal(afterCaret, 4, `光标应移到 4：${afterCaret}`);
  assert.deepEqual(after.box, before.box, '输入态里 box 不许变');
  assert.equal(after.at, '#a', '焦点在输入框时不许换层');
  assert.equal(results.length, 0, `0 次提交：${JSON.stringify(results)}`);
  assert.equal(postOpsCount(fetches), 0, `/ops 应为 0：${JSON.stringify(fetches)}`);
  assert.equal(after.nudge, null);
  assert.equal(activeAfter, 'text', `焦点应仍在文本框：${activeAfter}`);

  const panelDom = await page.evaluate(() => {
    const row = document.querySelector('#r13-panel .inspector-field');
    const label = row?.querySelector('.inspector-field-label');
    const input = row?.querySelector('.inspector-input');
    const cs = label ? getComputedStyle(label) : null;
    return {
      html: row ? row.outerHTML.slice(0, 240) : null,
      labelRect: label ? { ...label.getBoundingClientRect().toJSON() } : null,
      inputRect: input ? { ...input.getBoundingClientRect().toJSON() } : null,
      labelColor: cs?.color ?? null,
      labelFont: cs?.fontSize ?? null,
      rowDisplay: row ? getComputedStyle(row).display : null,
      chain: (() => {
        const out = [];
        let node = row;
        for (let i = 0; i < 5 && node; i += 1) {
          const r = node.getBoundingClientRect();
          out.push({ tag: node.tagName, cls: node.className || node.id, x: r.x, w: r.width, scrollW: node.scrollWidth });
          node = node.parentElement;
        }
        return out;
      })()
    };
  });
  const shotA7 = await shot(page, 's25-a7-focus.png');
  assert.ok(shotA7.bytes > 10240, `截图应 >10KB：${shotA7.bytes}`);
  assert.equal(pageErrors.length, 0);

  evidence.cases['S25-A7'] = {
    ok: true,
    focus,
    caretStart: focus.start,
    caretAfter: afterCaret,
    boxBefore: before.box,
    boxAfter: after.box,
    at: after.at,
    nudge: after.nudge,
    commits: results.length,
    postOps: postOpsCount(fetches),
    activeElementAfter: activeAfter,
    screenshot: shotA7,
    panelDom,
    pageErrors
  };
  await handle.dispose();
});

/* ── A8 锁定层 ─────────────────────────────────────────────────────────── */

test('S25-A8 锁定层被微移 → NUDGE_LOCKED，磁盘不变', async () => {
  const project = await makeProject('s25-a8');
  const { handle, page, pageErrors } = await openProject(project, { selected: ['#lock'] });
  await selectAt(page, ['#lock']);

  const buf0 = await fs.readFile(project.filmPath);
  const hash0 = sha(buf0);
  const before = await readState(page);

  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');

  const errors = await readErrors(page);
  const results = await readResults(page);
  const fetches = await readFetches(page);
  const after = await readState(page);
  const hash1 = sha(await fs.readFile(project.filmPath));

  assert.ok(errors.length >= 1, '应有报错');
  assert.equal(errors[0].code, 'NUDGE_LOCKED', `错误码应是 NUDGE_LOCKED：${JSON.stringify(errors)}`);
  assert.equal(results.length, 0, '0 次提交');
  assert.equal(postOpsCount(fetches), 0, '0 次 /ops');
  assert.deepEqual(after.box, before.box, 'box 不许动');
  assert.equal(hash1, hash0, 'film.html 必须逐字节不变');
  assert.equal(pageErrors.length, 0);

  evidence.cases['S25-A8'] = {
    ok: true,
    locked: '#lock',
    error: errors[0],
    errors,
    commits: results.length,
    postOps: postOpsCount(fetches),
    boxBefore: before.box,
    boxAfter: after.box,
    filmSha: { before: hash0, after: hash1 },
    pageErrors
  };
  await handle.dispose();
});

/* ── A9 无 pageerror + 混合序列 ─────────────────────────────────────────── */

test('S25-A9 混合序列（微移/Tab/Shift/Alt/Esc）pageErrors 空', async () => {
  const project = await makeProject('s25-a9');
  const { handle, page, pageErrors } = await openProject(project, { selected: ['#a'] });
  await selectAt(page, ['#a']);

  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Alt+ArrowDown');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.down('ArrowLeft');
  await page.keyboard.press('Escape'); /* 微移未提交时 Esc 丢弃 */
  await page.keyboard.up('ArrowLeft');

  const state = await readState(page);
  const errors = await readErrors(page);
  const results = await waitCommits(page, 3);

  assert.deepEqual(pageErrors, [], `不该有 pageerror：${pageErrors}`);
  assert.equal(state.mode, null);
  assert.equal(errors.filter((info) => info.code === 'GESTURE_NO_OPS').length, 0, `不该出现空批：${JSON.stringify(errors)}`);
  assert.ok(results.length >= 3, `至少 3 次提交：${results.length}`);

  const cancels = await page.evaluate(() => window.__cancels);
  evidence.cases['S25-A9'] = { ok: true, pageErrors, results: results.length, cancels, errors, state: { mode: state.mode, at: state.at } };
  await handle.dispose();
});
