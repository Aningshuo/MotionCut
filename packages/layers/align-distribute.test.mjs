// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S24-ALIGN-DISTRIBUTE 验收 A1..A9
 *
 * 真 Studio + 真 film 工程（4 个 iframe 片段）：工具条产一批 op → 一次 `/ops` → 读回磁盘 → 一次 `/undo`。
 * A8 顺带把 canvas-gesture 也挂上（真拖一次），验「拖完手势输入框要跟上」。
 *
 * 运行：node --test --test-concurrency=1 packages/layers/align-distribute.test.mjs（env 由 test-env.mjs 自动准备；`OPENCUT_ENV_JSON` 可显式覆盖）
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

const TEST_ENV = await resolveLayerTestEnv({ suite: 'align-distribute' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');
const PROJECTS = path.join(RUN_ROOT, 'projects');
const BUNDLE_ABS = path.join(RUN_ROOT, 'tmp/s24/align.mjs');
const BUNDLE_URL = '/' + path.relative(REPO_ROOT, BUNDLE_ABS).split(path.sep).join('/');
const GESTURE_BUNDLE_ABS = path.join(RUN_ROOT, 'tmp/s24/gesture.mjs');
const GESTURE_BUNDLE_URL = '/' + path.relative(REPO_ROOT, GESTURE_BUNDLE_ABS).split(path.sep).join('/');

const STAGE_W = 1280;
const STAGE_H = 720;
const BATCH = 'B-SUB1-R12-012';

const BOXES = {
  a: { x: 100, y: 80, w: 300, h: 150 },
  b: { x: 400, y: 300, w: 200, h: 100 },
  c: { x: 800, y: 200, w: 150, h: 120 },
  d: { x: 100, y: 500, w: 8, h: 8 },
  e: { x: 300, y: 560, w: 8, h: 8 }
};

const SCENE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;background:#fdf6e3}
.t{font:20px/1.4 "PingFang SC",Arial;color:#123;padding:10px}
</style></head><body><div class="t">对齐验收 · 真实文字</div></body></html>`;

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
  suite: 'align-distribute.test.mjs',
  cases: {},
  screenshots: [],
  startedAt: new Date().toISOString()
};

/** @type {SceneHost} */
let host;
/** @type {any} */
let studio;

async function buildBundles() {
  await fs.mkdir(path.dirname(BUNDLE_ABS), { recursive: true });
  await esbuild({
    stdin: { contents: "export * from './packages/layers/align-distribute.mjs';", resolveDir: REPO_ROOT, loader: 'js' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile: BUNDLE_ABS,
    logLevel: 'silent'
  });
  await esbuild({
    stdin: { contents: "export * from './packages/layers/canvas-gesture.mjs';", resolveDir: REPO_ROOT, loader: 'js' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile: GESTURE_BUNDLE_ABS,
    logLevel: 'silent'
  });
}

async function save() {
  const files = [];
  for (const name of ['s24-a1-align.png', 's24-a3-ratio-lock.png', 's24-a7-invalid.png']) {
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
  await fs.writeFile(path.join(EVIDENCE_DIR, 's24-align-distribute.json'), JSON.stringify(evidence, null, 2) + '\n');
}

before(async () => {
  const env = JSON.parse(await fs.readFile(path.join(RUN_ROOT, 'env.json'), 'utf8'));
  evidence.batch = env.batchId ?? evidence.batch;
  await buildBundles();
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

/** 页内挂载：工具条 +（可选）手势层，共用同一份选择 */
async function mountAll(deps) {
  const barMod = await import(deps.barBundle);
  const stageEl = document.querySelector('section');
  const all = deps.layers.map((layer) => ({ ...layer, rect: { ...layer.box } }));
  const byAt = new Map(all.map((layer) => [layer.at, layer]));
  window.__all = all;
  window.__byAt = byAt;
  window.__selected = deps.selected.map((at) => byAt.get(at)).filter(Boolean);
  window.__batches = [];
  window.__gestureOps = [];
  window.__errors = [];

  const bar = barMod.mountAlignBar(document.body, {
    getSelection: () => window.__selected,
    onCommitMany: (ops) => {
      window.__batches.push(ops);
    },
    onError: (info) => window.__errors.push(info)
  });
  window.__bar = bar;

  /** 宿主提交成功后的回写（真实宿主会这么做；截图才拍得到对齐结果） */
  window.__applyOps = (ops) => {
    for (const op of ops) {
      const layer = op.clip ? all.find((item) => item.clip === op.clip) : null;
      if (!layer) continue;
      layer.box = { ...op.value };
      layer.rect = { x: op.value.x, y: op.value.y, w: op.value.w, h: op.value.h };
      const el = document.querySelector(layer.at);
      if (!el) continue;
      el.style.left = `${op.value.x}px`;
      el.style.top = `${op.value.y}px`;
      el.style.width = `${op.value.w}px`;
      el.style.height = `${op.value.h}px`;
      if (typeof op.value.r === 'number' && op.value.r !== 0) el.style.rotate = `${op.value.r}deg`;
      else el.style.removeProperty('rotate');
    }
    window.__bar.refresh();
  };

  if (deps.withGesture === true) {
    const gestureMod = await import(deps.gestureBundle);
    const gesture = gestureMod.mountCanvasGesture(document.body, {
      getStageRect: () => {
        const r = stageEl.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, scale: r.width / deps.stageSize.w || 1 };
      },
      getSelectionSet: () => window.__selected,
      getLayerRects: () => all,
      onPreview: () => {},
      onCommit: (op) => {
        window.__gestureOps.push(op);
        const layer = op.clip ? all.find((item) => item.clip === op.clip) : window.__selected[0];
        if (layer) {
          layer.box = { ...op.value };
          layer.rect = { x: op.value.x, y: op.value.y, w: op.value.w, h: op.value.h };
        }
        /* 故意不调 bar.refresh()：A8 要验的是「拖完自己跟上」 */
      },
      onCommitMany: () => {},
      onCancel: () => {},
      onError: (info) => window.__errors.push(info),
      stageSize: deps.stageSize
    });
    window.__gesture = gesture;
  }

  return { count: window.__selected.length, bar: bar.getState() };
}

async function openProject(project, deps = {}) {
  const filmRel = path.relative(REPO_ROOT, project.filmPath).split(path.sep).join('/');
  const handle = await host.open(filmRel);
  const page = handle.page;
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.evaluate(mountAll, {
    barBundle: BUNDLE_URL,
    gestureBundle: GESTURE_BUNDLE_URL,
    layers: Object.entries(deps.boxes ?? BOXES).map(([id, box]) => ({ at: `#${id}`, box, clip: id })),
    selected: deps.selected ?? ['#a', '#b'],
    withGesture: deps.withGesture === true,
    stageSize: { w: STAGE_W, h: STAGE_H }
  });
  return { handle, page, pageErrors };
}

/** 一次批量提交（工具条产出的 ops 一起发） */
async function commitBatch(project, ops) {
  const body = {
    envelope: {
      projectId: project.projectId,
      batchId: BATCH,
      owner: 'SUB1',
      expectedHash: project.hash,
      opId: `${BATCH}:align:${Date.now()}:${Math.random().toString(16).slice(2, 6)}`
    },
    ops
  };
  const res = await post(`${studio.url}/api/projects/${encodeURIComponent(project.projectId)}/ops`, body);
  return { res, body };
}

async function readDoc(project) {
  const doc = await get(`${studio.url}/api/projects/${encodeURIComponent(project.projectId)}/doc`);
  const parsed = doc.json.doc ?? doc.json;
  const clips = (parsed.tracks ?? []).flatMap((t) => t.clips ?? []);
  /** @type {Record<string, any>} */
  const byId = {};
  for (const clip of clips) byId[clip.id] = clip.box;
  return { hash: doc.json.hash, byId, raw: parsed };
}

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

const clickAlign = (page, action) => page.click(`[data-align="${action}"]`);
const clickDistribute = (page, axis) => page.click(`[data-distribute="${axis}"]`);
const readBatches = (page) => page.evaluate(() => window.__batches.map((ops) => ops.map((op) => ({ ...op }))));
const readBar = (page) => page.evaluate(() => window.__bar.getState());

async function setInput(page, field, value) {
  await page.evaluate(
    ([f, v]) => {
      const input = document.querySelector(`[data-geo="${f}"]`);
      input.value = v;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    [field, value]
  );
}

/* ── A1 两层左对齐 ──────────────────────────────────────────────────────── */

test('S24-A1 2 层左对齐 → 1 次 /ops、2 条 op、两层 x 相同', async () => {
  const project = await makeProject('s24-a1');
  const { handle, page, pageErrors } = await openProject(project, { selected: ['#a', '#b'] });

  const before = await readBar(page);
  assert.equal(before.count, 2);
  await clickAlign(page, 'left');

  const batches = await readBatches(page);
  assert.equal(batches.length, 1, `应恰好一批：${JSON.stringify(batches)}`);
  assert.equal(batches[0].length, 2, `一批应含 2 条 op：${JSON.stringify(batches[0])}`);
  assert.ok(batches[0].every((op) => op.op === 'set' && op.field === 'box'), '只许 set field:box');

  const commit = await commitBatch(project, batches[0]);
  assert.equal(commit.res.status, 200, `提交失败：${commit.res.text}`);
  const doc = await readDoc(project);
  assert.equal(doc.byId.a.x, 100);
  assert.equal(doc.byId.b.x, 100, `两层 x 应相同：${JSON.stringify(doc.byId)}`);

  const film = await fs.readFile(project.filmPath, 'utf8');
  assert.ok(/id="b"[^>]*style="[^"]*left:\s*100px/.test(film), `磁盘 b 应为 left:100px：${inlineOf(film, 'b')}`);

  await page.evaluate((ops) => window.__applyOps(ops), batches[0]);
  const alignShot = await shot(page, 's24-a1-align.png');
  assert.ok(alignShot.bytes > 10240, `截图应 >10KB：${alignShot.bytes}`);
  assert.deepEqual(pageErrors, []);

  evidence.cases['S24-A1'] = {
    ok: true,
    requests: 1,
    ops: batches[0],
    http: { status: commit.res.status, request: commit.body, response: commit.res.text.slice(0, 400) },
    docAfter: { a: doc.byId.a, b: doc.byId.b },
    screenshot: alignShot,
    pageErrors
  };
  await handle.dispose();
});

/* ── A2 三层水平等距 ────────────────────────────────────────────────────── */

test('S24-A2 3 层水平等距 → 相邻间隙相等（±0.5px），首尾不动', async () => {
  const project = await makeProject('s24-a2');
  const { handle, page, pageErrors } = await openProject(project, { selected: ['#a', '#b', '#c'] });

  await clickDistribute(page, 'h');
  const batches = await readBatches(page);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 1, `首尾不动，只有中间一层移动：${JSON.stringify(batches[0])}`);

  const commit = await commitBatch(project, batches[0]);
  assert.equal(commit.res.status, 200, commit.res.text);

  const doc = await readDoc(project);
  const order = [doc.byId.a, doc.byId.b, doc.byId.c].sort((x, y) => x.x - y.x);
  const gap1 = order[1].x - (order[0].x + order[0].w);
  const gap2 = order[2].x - (order[1].x + order[1].w);

  assert.equal(order[0].x, 100, '首层不动');
  assert.equal(order[2].x, 800, '末层不动');
  assert.ok(Math.abs(gap1 - gap2) <= 0.5, `相邻间隙应相等：${gap1} vs ${gap2}`);
  assert.ok(Math.abs(gap1 - 100) <= 0.5, `间隙应 = (950-100-650)/2 = 100：${gap1}`);

  assert.deepEqual(pageErrors, []);
  evidence.cases['S24-A2'] = { ok: true, ops: batches[0], docAfter: doc.byId, gaps: { gap1, gap2 }, pageErrors };
  await handle.dispose();
});

/* ── A3 锁比 ────────────────────────────────────────────────────────────── */

test('S24-A3 锁比：W 300→400（原 300×150）→ H 变 200，左上角不动', async () => {
  const project = await makeProject('s24-a3');
  const { handle, page, pageErrors } = await openProject(project, { selected: ['#a'] });

  await page.check('[data-ratio-lock]');
  const locked = await readBar(page);
  assert.equal(locked.ratioLock, true);

  await setInput(page, 'w', '400');
  const batches = await readBatches(page);
  assert.equal(batches.length, 1, `应产出一次提交：${JSON.stringify(batches)}`);
  const op = batches[0][0];
  assert.deepEqual(op.value, { x: 100, y: 80, w: 400, h: 200 }, `锁比后 H 应按比例变 200：${JSON.stringify(op.value)}`);

  const commit = await commitBatch(project, batches[0]);
  assert.equal(commit.res.status, 200, commit.res.text);
  const doc = await readDoc(project);
  assert.deepEqual(doc.byId.a, { x: 100, y: 80, w: 400, h: 200 });

  const film = await fs.readFile(project.filmPath, 'utf8');
  assert.ok(/width:\s*400px/.test(inlineOf(film, 'a')), `磁盘应有 width:400px：${inlineOf(film, 'a')}`);
  assert.ok(/height:\s*200px/.test(inlineOf(film, 'a')), `磁盘应有 height:200px：${inlineOf(film, 'a')}`);

  await page.evaluate((ops) => window.__applyOps(ops), batches[0]);
  const ratioShot = await shot(page, 's24-a3-ratio-lock.png');
  assert.deepEqual(pageErrors, []);
  evidence.cases['S24-A3'] = { ok: true, op, docAfter: doc.byId.a, inline: inlineOf(film, 'a'), screenshot: ratioShot, pageErrors };
  await handle.dispose();
});

/* ── A4 旋转层按 AABB ───────────────────────────────────────────────────── */

test('S24-A4 旋转 45° 的层参与左对齐时按 AABB（不是未旋转的 box）', async () => {
  const boxes = { a: { x: 100, y: 80, w: 200, h: 100 }, b: { x: 400, y: 300, w: 200, h: 100 } };
  const project = await makeProject('s24-a4', boxes);
  const { handle, page, pageErrors } = await openProject(project, { boxes, selected: ['#a', '#b'] });

  /* 让 a 转 45°（宿主自己的状态：box.r + 实测 rect = AABB） */
  const aabb = await page.evaluate(() => {
    const byAt = window.__byAt;
    const a = byAt.get('#a');
    a.box = { ...a.box, r: 45 };
    const cx = a.box.x + a.box.w / 2;
    const cy = a.box.y + a.box.h / 2;
    const rad = (45 * Math.PI) / 180;
    const halfW = (a.box.w * Math.cos(rad) + a.box.h * Math.sin(rad)) / 2;
    const halfH = (a.box.w * Math.sin(rad) + a.box.h * Math.cos(rad)) / 2;
    a.rect = { x: cx - halfW, y: cy - halfH, w: halfW * 2, h: halfH * 2 };
    window.__bar.refresh();
    return a.rect;
  });

  await clickAlign(page, 'left');
  const batches = await readBatches(page);
  const byClip = Object.fromEntries(batches[0].map((op) => [op.clip, op.value]));

  assert.ok(Math.abs(aabb.x - 93.934) < 0.05, `a 的 AABB 左边界应是 93.93：${aabb.x}`);
  assert.equal(byClip.a.x, 100, `旋转层自己不该被挪（它的 AABB 已经在最左）：${JSON.stringify(byClip.a)}`);
  assert.ok(Math.abs(byClip.b.x - 93.934) < 0.05, `未旋转的 b 应贴到 AABB 左边界 93.93：${byClip.b.x}`);
  assert.notEqual(byClip.b.x, 100, '若按未旋转 box 算，b 会被对齐到 100 而不是 93.93');

  assert.deepEqual(pageErrors, []);
  evidence.cases['S24-A4'] = { ok: true, aabbA: aabb, ops: batches[0], byClip, pageErrors };
  await handle.dispose();
});

/* ── A5 一次 undo 全部回原值 ────────────────────────────────────────────── */

test('S24-A5 一次 undo 回到全部原值（不是逐层回退）', async () => {
  const project = await makeProject('s24-a5');
  const { handle, page, pageErrors } = await openProject(project, { selected: ['#a', '#b'] });

  await clickAlign(page, 'top');
  const batches = await readBatches(page);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 2);

  const commit = await commitBatch(project, batches[0]);
  assert.equal(commit.res.status, 200, commit.res.text);
  const after = await readDoc(project);
  assert.equal(after.byId.a.y, 80);
  assert.equal(after.byId.b.y, 80, `上对齐后 b.y 应 = 80：${JSON.stringify(after.byId)}`);

  const undo = await post(`${studio.url}/api/projects/${encodeURIComponent(project.projectId)}/undo`, { expectedHash: commit.res.json.hash });
  assert.equal(undo.status, 200, `撤销失败：${undo.text}`);

  const restored = await readDoc(project);
  assert.deepEqual(restored.byId.a, { x: 100, y: 80, w: 300, h: 150 }, 'a 应回原值');
  assert.deepEqual(restored.byId.b, { x: 400, y: 300, w: 200, h: 100 }, 'b 应回原值（一次 undo 全回）');

  await page.evaluate(
    (restored) => window.__applyOps(restored.map((box, i) => ({ op: 'set', field: 'box', value: box, clip: ['a', 'b'][i] }))),
    [restored.byId.a, restored.byId.b]
  );
  const film = await fs.readFile(project.filmPath, 'utf8');
  assert.ok(/left:\s*400px/.test(inlineOf(film, 'b')), `磁盘 b 应回 left:400px：${inlineOf(film, 'b')}`);
  assert.ok(/top:\s*300px/.test(inlineOf(film, 'b')), `磁盘 b 应回 top:300px：${inlineOf(film, 'b')}`);

  assert.deepEqual(pageErrors, []);
  evidence.cases['S24-A5'] = {
    ok: true,
    afterCommit: after.byId,
    undo: { status: undo.status, body: undo.text },
    afterUndo: restored.byId,
    inlineAfterUndo: { a: inlineOf(film, 'a'), b: inlineOf(film, 'b') },
    pageErrors
  };
  await handle.dispose();
});

/* ── A6 8×8 小框稳定 ────────────────────────────────────────────────────── */

test('S24-A6 8×8 小框对齐重复 5 次结果一致（不抖动）', async () => {
  const boxes = { d: { x: 100, y: 500, w: 8, h: 8 }, e: { x: 300, y: 560, w: 8, h: 8 } };
  const project = await makeProject('s24-a6', boxes);
  const { handle, page, pageErrors } = await openProject(project, { boxes, selected: ['#d', '#e'] });

  const results = [];
  for (let i = 0; i < 5; i += 1) {
    await page.evaluate(() => {
      window.__batches.length = 0;
    });
    await clickAlign(page, 'left');
    const batches = await readBatches(page);
    const byClip = Object.fromEntries(batches[0].map((op) => [op.clip, op.value]));
    results.push(byClip);
    /* 把结果写回宿主状态（模拟提交成功后的刷新） */
    await page.evaluate(
      (ops) => {
        for (const op of ops) {
          const layer = window.__byAt.get(`#${op.clip}`);
          if (layer) {
            layer.box = { ...op.value };
            layer.rect = { x: op.value.x, y: op.value.y, w: op.value.w, h: op.value.h };
          }
        }
        window.__bar.refresh();
      },
      batches[0]
    );
  }

  const first = JSON.stringify(results[0]);
  for (let i = 1; i < results.length; i += 1) {
    assert.equal(JSON.stringify(results[i]), first, `第 ${i + 1} 次与第 1 次应完全一致：${JSON.stringify(results)}`);
  }
  assert.equal(results[0].d.x, 100);
  assert.equal(results[0].e.x, 100);
  assert.equal(results[0].d.w, 8, '宽高不该被改成别的值');

  assert.deepEqual(pageErrors, []);
  evidence.cases['S24-A6'] = { ok: true, runs: results, stable: true, pageErrors };
  await handle.dispose();
});

/* ── A7 非法输入 ────────────────────────────────────────────────────────── */

test('S24-A7 非法输入（空 / -5 / abc）被拒绝、不写盘、界面有提示', async () => {
  const project = await makeProject('s24-a7');
  const { handle, page, pageErrors } = await openProject(project, { selected: ['#a'] });

  const filmBefore = await fs.readFile(project.filmPath, 'utf8');
  const cases = ['', '-5', 'abc'];
  const seen = [];
  for (const bad of cases) {
    await setInput(page, 'w', bad);
    const bar = await readBar(page);
    const batches = await readBatches(page);
    const dom = await page.evaluate(() => ({
      hint: document.querySelector('[data-align-hint]').textContent,
      error: document.querySelector('[data-align-bar]').getAttribute('data-align-error'),
      invalid: document.querySelector('[data-geo="w"]').getAttribute('data-invalid')
    }));
    seen.push({ bad, hint: dom.hint, errorCode: dom.error, invalidAttr: dom.invalid, batches: batches.length, commits: bar.commits });
    assert.equal(batches.length, 0, `非法值 "${bad}" 不该提交：${JSON.stringify(batches)}`);
    assert.equal(bar.commits, 0, `非法值 "${bad}" 不该计数提交`);
    assert.ok(dom.hint.length > 0, `非法值 "${bad}" 应有提示`);
    assert.equal(dom.error, 'INVALID_VALUE', `应报 INVALID_VALUE：${dom.error}`);
    assert.equal(dom.invalid, 'true');
  }

  const filmAfter = await fs.readFile(project.filmPath, 'utf8');
  assert.equal(filmAfter, filmBefore, 'film.html 不该被改动');

  const badShot = await shot(page, 's24-a7-invalid.png');
  assert.deepEqual(pageErrors, []);
  evidence.cases['S24-A7'] = { ok: true, inputs: seen, filmUnchanged: true, filmShaBefore: sha(filmBefore), filmShaAfter: sha(filmAfter), screenshot: badShot, pageErrors };
  await handle.dispose();
});

function sha(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/* ── A8 手势拖完输入框跟上 ──────────────────────────────────────────────── */

test('S24-A8 手势拖完松手 → 输入框数字与磁盘一致（读回校验）', async () => {
  const project = await makeProject('s24-a8');
  const { handle, page, pageErrors } = await openProject(project, { selected: ['#a'], withGesture: true });

  const before = await readBar(page);
  assert.equal(before.values.x, '100', `拖前 X 应是 100：${JSON.stringify(before.values)}`);

  /* 真拖：从框体 (250,155) 拉 +40/+25 */
  await page.mouse.move(250, 155);
  await page.mouse.down();
  await page.mouse.move(290, 180, { steps: 8 });
  await page.mouse.up();
  /* pointerup 冒泡到 window 时工具条已同步（不需要额外等） */
  await page.evaluate(() => Promise.resolve());

  const ops = await page.evaluate(() => window.__gestureOps.map((op) => ({ ...op })));
  assert.equal(ops.length, 1, `手势应提交一次：${JSON.stringify(ops)}`);
  assert.deepEqual(ops[0].value, { x: 140, y: 105, w: 300, h: 150 });

  const bar = await readBar(page);
  assert.equal(bar.values.x, '140', `输入框 X 应跟上手势：${JSON.stringify(bar.values)}`);
  assert.equal(bar.values.y, '105', `输入框 Y 应跟上手势：${JSON.stringify(bar.values)}`);

  /* 再和磁盘对一次 */
  const body = {
    envelope: { projectId: project.projectId, batchId: BATCH, owner: 'SUB1', expectedHash: project.hash, opId: `${BATCH}:gesture:${Date.now()}` },
    ops
  };
  const res = await post(`${studio.url}/api/projects/${encodeURIComponent(project.projectId)}/ops`, body);
  assert.equal(res.status, 200, res.text);
  const doc = await readDoc(project);
  assert.equal(doc.byId.a.x, 140);
  assert.equal(doc.byId.a.y, 105);
  assert.equal(String(doc.byId.a.x), bar.values.x, '输入框读数应与磁盘一致');
  assert.equal(String(doc.byId.a.y), bar.values.y);

  assert.deepEqual(pageErrors, []);
  evidence.cases['S24-A8'] = {
    ok: true,
    gestureOps: ops,
    barValues: bar.values,
    docAfter: doc.byId.a,
    inline: inlineOf(await fs.readFile(project.filmPath, 'utf8'), 'a'),
    pageErrors
  };
  await handle.dispose();
});

/* ── A9 无 pageerror（含工具条生命周期） ───────────────────────────────── */

test('S24-A9 工具条挂载/对齐/分布/输入/销毁全过程无 pageerror', async () => {
  const project = await makeProject('s24-a9');
  const { handle, page, pageErrors } = await openProject(project, { selected: ['#a', '#b', '#c'] });

  await clickAlign(page, 'hcenter');
  await page.evaluate(() => {
    window.__batches.length = 0;
  });
  await clickAlign(page, 'vcenter');
  await page.evaluate(() => {
    window.__batches.length = 0;
  });
  await clickDistribute(page, 'v');
  const vOps = await readBatches(page);
  assert.equal(vOps.length, 1, `垂直分布应产出一批：${JSON.stringify(vOps)}`);
  assert.equal(vOps[0].length, 1, `3 层垂直分布只该动中间那层：${JSON.stringify(vOps[0])}`);
  await page.evaluate(() => {
    window.__batches.length = 0;
  });
  /* 少于下限时按钮禁用（点了也不产 op） */
  await page.evaluate(() => {
    window.__selected = [window.__byAt.get('#a')];
    window.__bar.refresh();
  });
  const single = await page.evaluate(() => ({
    alignDisabled: document.querySelector('[data-align="left"]').disabled,
    distributeDisabled: document.querySelector('[data-distribute="h"]').disabled
  }));
  assert.equal(single.alignDisabled, true, '单选时对齐按钮应禁用');
  assert.equal(single.distributeDisabled, true, '单选时分布按钮应禁用');

  await page.evaluate(() => {
    window.__bar.destroy();
  });
  const after = await page.evaluate(() => ({
    bars: document.querySelectorAll('[data-align-bar]').length,
    listeners: window.__bar.getState().listeners
  }));
  assert.equal(after.bars, 0, 'destroy 后不该残留工具条');
  assert.equal(after.listeners, 0, 'destroy 后不该留监听');

  assert.deepEqual(pageErrors, [], `不该有 pageerror：${pageErrors}`);
  evidence.cases['S24-A9'] = { ok: true, pageErrors, singleSelection: single, afterDestroy: after };
  await handle.dispose();
});


/* ── A1S（支撑用例，不在派单 A 列表）：6 个对齐动作矩阵 ──────────────────── */

test('S24-A1S 六个对齐动作都按并集 AABB 落到正确的边/中线', async () => {
  const { planAlign, unionAabb } = await import('./align-distribute.mjs');
  const items = [
    { at: '#a', box: { x: 100, y: 80, w: 300, h: 150 } },
    { at: '#b', box: { x: 400, y: 300, w: 200, h: 100 } },
    { at: '#c', box: { x: 900, y: 200, w: 150, h: 120 } }
  ];
  const union = unionAabb(items);
  const results = {};
  for (const action of ['left', 'hcenter', 'right', 'top', 'vcenter', 'bottom']) {
    const { ops } = planAlign(items, action);
    assert.equal(ops.length, 3, `${action} 应给每层一条 op：${ops.length}`);
    const boxes = ops.map((op) => op.value);
    const lefts = boxes.map((b) => b.x);
    const rights = boxes.map((b) => b.x + b.w);
    const cx = boxes.map((b) => b.x + b.w / 2);
    const tops = boxes.map((b) => b.y);
    const bottoms = boxes.map((b) => b.y + b.h);
    const cy = boxes.map((b) => b.y + b.h / 2);
    const eq = (arr) => arr.every((v) => Math.abs(v - arr[0]) <= 0.001);
    if (action === 'left') assert.ok(eq(lefts) && Math.abs(lefts[0] - union.x) <= 0.001, 'left');
    if (action === 'hcenter') assert.ok(eq(cx) && Math.abs(cx[0] - (union.x + union.w / 2)) <= 0.001, 'hcenter');
    if (action === 'right') assert.ok(eq(rights) && Math.abs(rights[0] - (union.x + union.w)) <= 0.001, 'right');
    if (action === 'top') assert.ok(eq(tops) && Math.abs(tops[0] - union.y) <= 0.001, 'top');
    if (action === 'vcenter') assert.ok(eq(cy) && Math.abs(cy[0] - (union.y + union.h / 2)) <= 0.001, 'vcenter');
    if (action === 'bottom') assert.ok(eq(bottoms) && Math.abs(bottoms[0] - (union.y + union.h)) <= 0.001, 'bottom');
    results[action] = boxes;
  }
  evidence.cases['S24-A1S'] = { ok: true, union, results };
});
