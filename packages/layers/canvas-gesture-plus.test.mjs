// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S19-GESTURE-PLUS 验收 A1..A7
 *
 * 场景：本批自建的真 film 工程（4 个 iframe 片段，声明 box 写在 film.html 的 style 里），
 * 真 Studio 落盘。舞台 = 第一个 `<section>`（1280×720，scale 1）。
 *
 * - A1/A4 打真 `/ops`（A4 还是**一批多 op**）+ `/undo`；
 * - A2/A3/A5/A6/A7 只断言手势产出（宿主回调 + 覆盖层 DOM）；
 * - 截图：A3（吸附参考线，拖拽中）、A6（8×8 外扩环）。
 *
 * 运行：node --test --test-concurrency=1 packages/layers/canvas-gesture-plus.test.mjs（env 由 test-env.mjs 自动准备；`OPENCUT_ENV_JSON` 可显式覆盖）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { build as esbuild } from 'esbuild';
import { SceneHost, REPO_ROOT } from '../scene-runtime/host.mjs';
import { startStudio } from '../studio/server/studio-server.mjs';
import { createOpsClient } from './ops-client.mjs';
import { resolveLayerTestEnv } from './test-env.mjs';

const TEST_ENV = await resolveLayerTestEnv({ suite: 'canvas-gesture-plus' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');
const PROJECTS = path.join(RUN_ROOT, 'projects');
const BUNDLE_ABS = path.join(RUN_ROOT, 'tmp/s19/gesture.mjs');
const BUNDLE_URL = '/' + path.relative(REPO_ROOT, BUNDLE_ABS).split(path.sep).join('/');

const STAGE_W = 1280;
const STAGE_H = 720;
const BATCH = 'B-SUB1-R10-010';

/** 四个片段的声明 box（film.html 里写死，测试与断言共用一份）。 */
const BOXES = {
  a: { x: 100, y: 80, w: 300, h: 120 },
  b: { x: 520, y: 80, w: 240, h: 120 },
  c: { x: 100, y: 420, w: 400, h: 100 },
  d: { x: 800, y: 520, w: 8, h: 8 }
};

const SCENE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;background:#fff}
.card{font:26px/1.4 "PingFang SC",Arial;color:#123;padding:14px}
</style></head><body><div class="card">片段内容 · 真实文字</div></body></html>`;

const FILM_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#0f1729}
section{position:relative;display:block;width:1280px;height:720px}
iframe{position:absolute;border:0;display:block;background:#fff}
</style></head><body>
<section>
<iframe id="a" src="scene.html#t=0,4" at="0" style="left:${BOXES.a.x}px;top:${BOXES.a.y}px;width:${BOXES.a.w}px;height:${BOXES.a.h}px"></iframe>
<iframe id="b" src="scene.html#t=0,4" at="0" style="left:${BOXES.b.x}px;top:${BOXES.b.y}px;width:${BOXES.b.w}px;height:${BOXES.b.h}px"></iframe>
<iframe id="c" src="scene.html#t=0,4" at="0" style="left:${BOXES.c.x}px;top:${BOXES.c.y}px;width:${BOXES.c.w}px;height:${BOXES.c.h}px"></iframe>
<iframe id="d" src="scene.html#t=0,4" at="0" style="left:${BOXES.d.x}px;top:${BOXES.d.y}px;width:${BOXES.d.w}px;height:${BOXES.d.h}px"></iframe>
</section>
</body></html>`;

const evidence = {
  batch: BATCH,
  suite: 'canvas-gesture-plus.test.mjs',
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
        "export { mountCanvasGesture, dragBox, snapRect, anchorPointOf, rotationDeltaOf, snapDegrees, GESTURE_RING_MIN } from './packages/layers/canvas-gesture.mjs';"
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
  for (const name of ['s19-a3-snap-guides.png', 's19-a6-ring-8x8.png']) {
    try {
      const abs = path.join(EVIDENCE_DIR, name);
      const buf = await fs.readFile(abs);
      files.push({ name, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
    } catch {
      files.push({ name, bytes: 0, sha256: null, missing: true });
    }
  }
  evidence.screenshots = files;
  evidence.finishedAt = new Date().toISOString();
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(path.join(EVIDENCE_DIR, 's19-gesture-plus.json'), JSON.stringify(evidence, null, 2) + '\n');
}

before(async () => {
  const env = JSON.parse(await fs.readFile(path.join(RUN_ROOT, 'env.json'), 'utf8'));
  evidence.batch = env.batchId ?? evidence.batch;
  await buildBundle();
  host = await new SceneHost({ port: Number(env.studioPort), viewport: { width: 1440, height: 900 } }).start();
  studio = await startStudio({ port: 0, vitePort: host.http.port, logger: () => {} });
  evidence.studio = { port: studio.port, url: studio.url, sceneOrigin: host.origin, browser: host.browserVersion };
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

async function makeProject(name) {
  const dir = path.join(PROJECTS, `${name}-${process.pid}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'scene.html'), SCENE_HTML);
  await fs.writeFile(path.join(dir, 'film.html'), FILM_HTML);
  const opened = await post(`${studio.url}/api/projects/open`, { dir });
  assert.equal(opened.status, 200, `open 失败：${opened.text}`);
  const projectId = opened.json.project.projectId;
  const doc = await get(`${studio.url}/api/projects/${encodeURIComponent(projectId)}/doc`);
  assert.equal(doc.status, 200, `doc 失败：${doc.text}`);
  const parsed = doc.json.doc ?? doc.json;
  const clips = (parsed.tracks ?? []).flatMap((t) => t.clips ?? []).filter((c) => ['a', 'b', 'c', 'd'].includes(c.id));
  return { dir, projectId, hash: doc.json.hash, filmPath: path.join(dir, 'film.html'), clips };
}

/** 宿主：把选中的层打到页面上（预览），并在提交后更新自己的选择。 */
async function mountLive(deps) {
  const mod = await import(deps.bundle);
  const stageEl = document.querySelector(deps.stageSelector);
  if (!stageEl) throw new Error(`没有舞台：${deps.stageSelector}`);

  const all = deps.layers.map((layer) => ({ ...layer, rect: { ...layer.box } }));
  const byAt = new Map(all.map((layer) => [layer.at, layer]));
  const log = { previews: [], commits: [], batches: [], cancels: 0, errors: [], selections: [] };
  window.__gestureLog = log;

  const applyBox = (layer, box) => {
    layer.rect = { x: box.x, y: box.y, w: box.w, h: box.h };
    const el = document.querySelector(layer.at);
    if (!el) return;
    el.style.left = `${box.x}px`;
    el.style.top = `${box.y}px`;
    el.style.width = `${box.w}px`;
    el.style.height = `${box.h}px`;
    if (typeof box.r === 'number' && box.r !== 0) el.style.rotate = `${box.r}deg`;
    else el.style.removeProperty('rotate');
  };

  window.__selected = deps.selected.map((at) => byAt.get(at)).filter(Boolean);
  window.__applyBox = (at, box) => applyBox(byAt.get(at), box);

  const readStage = () => {
    const r = stageEl.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, scale: r.width / deps.stageSize.w || 1 };
  };

  /** 覆盖层的 onPreview 只带 op；预览到 DOM 需要知道是哪一层 —— 单选按 at，多选按 op.clip 对应。 */
  const layerOfOp = (op) => (op && op.clip ? all.find((layer) => layer.clip === op.clip) ?? null : window.__selected[0] ?? null);

  /** @type {any} */
  let controller = null;
  controller = mod.mountCanvasGesture(document.body, {
    getStageRect: readStage,
    getSelectionSet: () => window.__selected,
    getLayerRects: () => all,
    getSnapTargets: () => all.map((layer) => ({ at: layer.at, ...layer.box })),
    getHighlightRect: (at) => {
      const layer = byAt.get(at);
      return layer ? { ...layer.box } : null;
    },
    onPreview: (op) => {
      log.previews.push(op);
      const layer = layerOfOp(op);
      if (layer) applyBox(layer, op.value);
    },
    onCommit: (op) => {
      log.commits.push(op);
      const layer = layerOfOp(op);
      if (layer && window.__selected.some((item) => item.at === layer.at)) {
        layer.box = { ...op.value };
        window.__selected = window.__selected.map((item) => (item.at === layer.at ? { ...item, box: { ...op.value } } : item));
      }
      controller.refresh();
    },
    onCommitMany: (ops) => {
      log.batches.push(ops);
      for (const op of ops) {
        const layer = layerOfOp(op);
        if (!layer) continue;
        layer.box = { ...op.value };
        window.__selected = window.__selected.map((item) => (item.at === layer.at ? { ...item, box: { ...op.value } } : item));
      }
      controller.refresh();
    },
    onSelectionChange: (ats) => {
      log.selections.push(ats);
      window.__selected = ats.map((at) => byAt.get(at)).filter(Boolean);
      controller.refresh();
    },
    onCancel: () => {
      log.cancels += 1;
      for (const layer of all) applyBox(layer, layer.box);
      controller.refresh();
    },
    onError: (info) => log.errors.push(info),
    stageSize: deps.stageSize
  });

  /* 舞台内容在同源 iframe 里：把里面的 pointerdown 转发成父文档坐标（真实宿主也要这么做） */
  const forward = (frameEl) => {
    try {
      const frameDoc = frameEl.contentDocument;
      if (!frameDoc || frameDoc.__r10Forward) return;
      frameDoc.__r10Forward = true;
      frameDoc.addEventListener(
        'pointerdown',
        (event) => {
          const r = frameEl.getBoundingClientRect();
          controller.stagePointerDown({
            clientX: r.x + event.clientX,
            clientY: r.y + event.clientY,
            shiftKey: event.shiftKey === true,
            button: event.button
          });
        },
        true
      );
    } catch {
      /* 跨源 frame 读不到就不转发（对应真实里的 UNSUPPORTED） */
    }
  };
  for (const frameEl of document.querySelectorAll('iframe')) {
    forward(frameEl);
    frameEl.addEventListener('load', () => forward(frameEl));
  }

  window.__gesture = controller;
  window.__stageEl = stageEl;
  window.__all = all;
  window.__mod = mod;
  return { stage: readStage(), state: controller.getState() };
}

async function openFilm(project, selected) {
  const filmRel = path.relative(REPO_ROOT, project.filmPath).split(path.sep).join('/');
  const handle = await host.open(filmRel);
  const page = handle.page;
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  const mounted = await page.evaluate(mountLive, {
    bundle: BUNDLE_URL,
    stageSelector: 'section:first-of-type',
    stageSize: { w: STAGE_W, h: STAGE_H },
    layers: Object.entries(BOXES).map(([id, box]) => ({ at: `#${id}`, box, clip: id })),
    selected
  });
  return { handle, page, mounted, errors };
}

async function drag(page, from, to, opts = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  if (opts.shift === true) await page.keyboard.down('Shift');
  await page.mouse.move(to.x, to.y, { steps: opts.steps ?? 8 });
  if (typeof opts.beforeUp === 'function') await opts.beforeUp();
  await page.mouse.up();
  if (opts.shift === true) await page.keyboard.up('Shift');
}

function snapshot(page) {
  return page.evaluate(() => ({
    state: window.__gesture.getState(),
    frame: window.__gesture.getFrameClientRect(),
    log: {
      previews: window.__gestureLog.previews.length,
      commits: window.__gestureLog.commits,
      batches: window.__gestureLog.batches,
      cancels: window.__gestureLog.cancels,
      errors: window.__gestureLog.errors,
      selections: window.__gestureLog.selections
    },
    dom: {
      handles: [...document.querySelectorAll('[data-handle]')].map((el) => el.getAttribute('data-handle')),
      guides: [...document.querySelectorAll('[data-gesture-guide]')].map((el) => ({
        axis: el.getAttribute('data-gesture-guide'),
        display: getComputedStyle(el).display,
        left: el.style.left,
        top: el.style.top
      })),
      ring: (() => {
        const el = document.querySelector('[data-gesture-ring]');
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height, display: getComputedStyle(el).display };
      })()
    }
  }));
}

async function commitOps(project, ops) {
  const body = {
    envelope: {
      projectId: project.projectId,
      batchId: BATCH,
      owner: 'SUB1',
      expectedHash: project.hash,
      opId: `${BATCH}:set:${Date.now()}:${Math.random().toString(16).slice(2, 6)}`
    },
    ops
  };
  const res = await post(`${studio.url}/api/projects/${encodeURIComponent(project.projectId)}/ops`, body);
  return { res, request: body };
}

async function undo(projectId, hash) {
  const res = await post(`${studio.url}/api/projects/${encodeURIComponent(projectId)}/undo`, { expectedHash: hash });
  return res;
}

/* ── A1 ─────────────────────────────────────────────────────────────────── */

test('S19-A1 旋转手柄拖到 30° → box.r=30 落盘 rotate:30deg，撤销复原', async () => {
  const project = await makeProject('s19-a1');
  const { handle, page } = await openFilm(project, ['#a']);

  const start = await snapshot(page);
  assert.deepEqual(start.state.frame, { x: 100, y: 80, w: 300, h: 120, rotationDeg: 0 });
  assert.ok(start.dom.handles.includes('rotate'), `旋转手柄应在：${start.dom.handles}`);

  /* 框中心 (250,140)；旋转手柄在 (250, 80-24=56)。拖到相对中心 (42, -72.75) ≈ 30° */
  const center = { x: 250, y: 140 };
  const radius = 140 - 56;
  const rad = (30 * Math.PI) / 180;
  const target = { x: center.x + radius * Math.sin(rad), y: center.y - radius * Math.cos(rad) };
  await drag(page, { x: 250, y: 56 }, target);
  const after = await snapshot(page);

  assert.equal(after.log.commits.length, 1, `应提交一次：${JSON.stringify(after.log.commits)}`);
  const op = after.log.commits[0];
  /* 多选/批量需要知道改哪一段：候选层带 clip 时，op 也带 clip（单选仍是一条 op） */
  assert.deepEqual(op, { op: 'set', field: 'box', value: { x: 100, y: 80, w: 300, h: 120, r: 30 }, clip: 'a' });

  const client = createOpsClient({ projectId: project.projectId, batchId: BATCH, owner: 'SUB1', expectedHash: project.hash, baseUrl: studio.url });
  const commit = await client.commitSet({ clip: 'a', field: 'box', value: op.value });
  assert.equal(commit.ok, true, `提交失败：${JSON.stringify(commit)}`);

  const filmDisk = await fs.readFile(project.filmPath, 'utf8');
  const inline = /id="a"[^>]*style="([^"]*)"/.exec(filmDisk)?.[1] ?? '';
  assert.ok(/rotate:\s*30deg/.test(inline), `磁盘应有 rotate: 30deg：${inline}`);

  const undoRes = await undo(project.projectId, commit.hash);
  assert.equal(undoRes.status, 200, `撤销失败：${undoRes.text}`);
  const filmUndone = await fs.readFile(project.filmPath, 'utf8');
  const inlineUndone = /id="a"[^>]*style="([^"]*)"/.exec(filmUndone)?.[1] ?? '';
  assert.ok(!/rotate:/.test(inlineUndone), `撤销后不应有 rotate：${inlineUndone}`);
  assert.ok(/left:\s*100px/.test(inlineUndone), `撤销后 left 应回 100：${inlineUndone}`);

  evidence.cases['S19-A1'] = {
    ok: true,
    op,
    http: { status: commit.status, request: commit.request, response: commit.response },
    diskBefore: '（无 rotate）',
    diskAfter: inline,
    undo: { status: undoRes.status, body: undoRes.text, inline: inlineUndone }
  };
  await handle.dispose();
});

/* ── A2 ─────────────────────────────────────────────────────────────────── */

test('S19-A2 Shift 拖旋转 → 角度是 15 的整数倍（3 个采样）', async () => {
  const project = await makeProject('s19-a2');
  const { handle, page } = await openFilm(project, ['#a']);

  const center = { x: 250, y: 140 };
  const samples = [];
  for (const raw of [22, 47, 8]) {
    const box = await page.evaluate(() => window.__selected[0].box);
    const r0 = box.r ?? 0;
    /* 旋转手柄半径 = 框半高 + 24 = 84（框 120 高），角度按当前 r 转 */
    const radius = 84;
    const at = (deg) => ({ x: center.x + radius * Math.sin((deg * Math.PI) / 180), y: center.y - radius * Math.cos((deg * Math.PI) / 180) });
    await drag(page, at(r0), at(r0 + raw), { shift: true });
    const after = await snapshot(page);
    const op = after.log.commits[after.log.commits.length - 1];
    samples.push({ raw: r0 + raw, r: op?.value?.r ?? 0, op });
  }

  assert.equal(samples.length, 3);
  for (const s of samples) {
    assert.equal(s.r % 15, 0, `角度应是 15 的倍数：raw=${s.raw} → r=${s.r}`);
  }
  const distinct = new Set(samples.map((s) => s.r));
  assert.ok(distinct.size >= 2, `至少两个不同角度：${[...distinct].join(',')}`);

  evidence.cases['S19-A2'] = { ok: true, samples };
  await handle.dispose();
});

/* ── A3 ─────────────────────────────────────────────────────────────────── */

test('S19-A3 距舞台中心 4px → 吸附到中心 + 参考线（截图）', async () => {
  const project = await makeProject('s19-a3');
  const { handle, page } = await openFilm(project, ['#a']);

  /* 把 #a 的中心拖到 (636,356)：距舞台中心 (640,360) 各 4px → 应吸附 */
  const from = { x: 250, y: 140 };
  const to = { x: 250 + 386, y: 140 + 216 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  const mid = await snapshot(page);
  const shot = path.join(EVIDENCE_DIR, 's19-a3-snap-guides.png');
  await page.screenshot({ path: shot, clip: { x: 0, y: 0, width: STAGE_W, height: STAGE_H } });
  await page.mouse.up();
  const done = await snapshot(page);

  assert.equal(mid.state.mode, 'move');
  assert.deepEqual(mid.state.guides, [{ axis: 'x', at: 640 }, { axis: 'y', at: 360 }], `参考线：${JSON.stringify(mid.state.guides)}`);
  assert.equal(mid.dom.guides.filter((g) => g.display !== 'none').length, 2, `参考线应可见：${JSON.stringify(mid.dom.guides)}`);

  const op = done.log.commits[0];
  assert.deepEqual(op.value, { x: 490, y: 300, w: 300, h: 120 }, `应吸附到中心：${JSON.stringify(op.value)}`);

  /* 未吸附（远处）不应有参考线：再拖 100px 到别处 */
  await drag(page, { x: 640, y: 360 }, { x: 640, y: 360 + 100 });
  const far = await snapshot(page);
  assert.deepEqual(far.state.guides, [], `不应有参考线：${JSON.stringify(far.state.guides)}`);

  const stat = await fs.stat(shot);
  assert.ok(stat.size > 10240, `截图应 >10KB：${stat.size}`);

  evidence.cases['S19-A3'] = {
    ok: true,
    guides: mid.state.guides,
    guidesDom: mid.dom.guides,
    op,
    shot: { file: 's19-a3-snap-guides.png', bytes: stat.size },
    farGuides: far.state.guides
  };
  await handle.dispose();
});

/* ── A4 ─────────────────────────────────────────────────────────────────── */

test('S19-A4 Shift 点选两个 + 齐拖 +20 → 一批两条 op，一次撤销全回', async () => {
  const project = await makeProject('s19-a4');
  const { handle, page } = await openFilm(project, ['#a']);

  /* Shift 点 #b（中心 640,140）→ 加选 */
  await page.keyboard.down('Shift');
  await page.mouse.click(640, 140);
  await page.keyboard.up('Shift');
  const selected = await snapshot(page);
  assert.deepEqual(selected.state.ats.sort(), ['#a', '#b'], `选中集合：${JSON.stringify(selected.state.ats)}`);

  /* 并集框 (100,80)-(760,200)，中心 (430,140)；拖 +20 */
  await drag(page, { x: 430, y: 140 }, { x: 450, y: 140 });
  const after = await snapshot(page);

  assert.equal(after.log.commits.length, 0, '多选不应走单选 onCommit');
  assert.equal(after.log.batches.length, 1, `应一批：${after.log.batches.length}`);
  const ops = after.log.batches[0];
  assert.equal(ops.length, 2, `一批两条：${ops.length}`);
  const byClip = new Map(ops.map((op) => [op.clip, op.value]));
  assert.deepEqual(byClip.get('a'), { x: 120, y: 80, w: 300, h: 120 });
  assert.deepEqual(byClip.get('b'), { x: 540, y: 80, w: 240, h: 120 });

  const { res, request } = await commitOps(project, ops);
  assert.equal(res.status, 200, `批次提交失败：${res.text}`);
  const body = JSON.parse(res.text);
  assert.equal(body.ok, true);
  const filmDisk = await fs.readFile(project.filmPath, 'utf8');
  assert.ok(/id="a"[^>]*left:\s*120px/.test(filmDisk), `a 应落 120：${filmDisk.match(/id="a"[^>]*/)?.[0]}`);
  assert.ok(/id="b"[^>]*left:\s*540px/.test(filmDisk), `b 应落 540：${filmDisk.match(/id="b"[^>]*/)?.[0]}`);

  const undoRes = await undo(project.projectId, body.hash);
  assert.equal(undoRes.status, 200, `撤销失败：${undoRes.text}`);
  const filmUndone = await fs.readFile(project.filmPath, 'utf8');
  assert.ok(/id="a"[^>]*left:\s*100px/.test(filmUndone), `撤销后 a 回 100：${filmUndone.match(/id="a"[^>]*/)?.[0]}`);
  assert.ok(/id="b"[^>]*left:\s*520px/.test(filmUndone), `撤销后 b 回 520：${filmUndone.match(/id="b"[^>]*/)?.[0]}`);
  const undoBody = JSON.parse(undoRes.text);
  assert.equal(undoBody.undoDepth, 0, `撤销后应无更多步骤：${undoRes.text}`);

  evidence.cases['S19-A4'] = {
    ok: true,
    selectedBefore: selected.state.ats,
    ops,
    http: { status: res.status, request, response: res.text },
    diskAfter: filmDisk.match(/id="a"[^>]*|id="b"[^>]*/g),
    undo: { status: undoRes.status, body: undoRes.text, undoDepth: undoBody.undoDepth ?? null }
  };
  await handle.dispose();
});

/* ── A5 ─────────────────────────────────────────────────────────────────── */

test('S19-A5 橡皮筋框选 3 个；越界坐标被裁到舞台', async () => {
  const project = await makeProject('s19-a5');
  const { handle, page } = await openFilm(project, []);

  /* 空白处 (80,60) 起手 → 拖到 (790,540)：覆盖 a/b/c，不含 d(800..808) */
  await page.mouse.move(80, 60);
  await page.mouse.down();
  await page.mouse.move(790, 540, { steps: 10 });
  const mid = await snapshot(page);
  assert.equal(mid.state.mode, 'band');
  const bandRect = mid.state.band;
  await page.mouse.up();
  const after = await snapshot(page);

  assert.deepEqual(after.state.ats.sort(), ['#a', '#b', '#c'], `框选结果：${JSON.stringify(after.state.ats)}`);

  /* 越界：从 (80,60) 拖到 (2000,1000) → 带子裁到舞台右下角 */
  await page.mouse.move(80, 60);
  await page.mouse.down();
  await page.mouse.move(2000, 1000, { steps: 8 });
  const clamped = await snapshot(page);
  await page.mouse.up();
  const band = clamped.state.band;
  assert.ok(band.x + band.w <= STAGE_W + 0.001, `带子右边界应 ≤ 舞台：${JSON.stringify(band)}`);
  assert.ok(band.y + band.h <= STAGE_H + 0.001, `带子下边界应 ≤ 舞台：${JSON.stringify(band)}`);
  assert.equal(Math.round(band.w), STAGE_W - 80);
  assert.equal(Math.round(band.h), STAGE_H - 60);

  evidence.cases['S19-A5'] = {
    ok: true,
    firstBand: mid.state.band,
    selected: after.state.ats,
    clampedBand: band,
    stage: { w: STAGE_W, h: STAGE_H }
  };
  await handle.dispose();
});

/* ── A6 ─────────────────────────────────────────────────────────────────── */

test('S19-A6 8×8 框：8 个手柄逐个可命中（外扩环 28px），截图', async () => {
  const project = await makeProject('s19-a6');
  const { handle, page } = await openFilm(project, ['#d']);

  const state = await snapshot(page);
  assert.deepEqual(state.state.box, { x: 800, y: 520, w: 8, h: 8 });
  assert.ok(Math.abs(state.frame.w - 8) <= 0.5 && Math.abs(state.frame.h - 8) <= 0.5, `框线应真实 8×8：${JSON.stringify(state.frame)}`);
  assert.ok(Math.abs(state.dom.ring.w - 28) <= 0.5 && Math.abs(state.dom.ring.h - 28) <= 0.5, `环应 28×28：${JSON.stringify(state.dom.ring)}`);

  /* 8 个手柄的中心（环 790..818 × 510..538） */
  const spots = {
    nw: [790, 510], n: [804, 510], ne: [818, 510], e: [818, 524],
    se: [818, 538], s: [804, 538], sw: [790, 538], w: [790, 524]
  };
  const hits = await page.evaluate((map) => {
    const out = {};
    for (const [name, [x, y]] of Object.entries(map)) {
      const el = document.elementFromPoint(x, y);
      out[name] = el ? el.getAttribute('data-handle') : null;
    }
    return out;
  }, spots);

  for (const [name, expected] of Object.entries(spots)) {
    assert.equal(hits[name], name, `${name} 手柄应可命中（环位置 ${expected}）：${hits[name]}`);
  }

  /* 截图：同屏带 #c（真实文字）说明不是纯色块；按住 #d 框体让 HUD 显示「800,520 · 8×8」，
     8 个手柄在 28px 环上各自分开（框线仍是 8×8）。松手不移动 → 不提交。 */
  const shot = path.join(EVIDENCE_DIR, 's19-a6-ring-8x8.png');
  await page.mouse.move(804, 524);
  await page.mouse.down();
  await page.mouse.move(804.0, 524.0);
  const withHud = await page.evaluate(() => ({
    hud: document.querySelector('[data-gesture-hud]')?.textContent ?? null,
    hudDisplay: getComputedStyle(document.querySelector('[data-gesture-hud]')).display,
    mode: window.__gesture.getState().mode
  }));
  await page.screenshot({ path: shot, clip: { x: 0, y: 60, width: 1280, height: 660 } });
  await page.mouse.up();
  assert.equal(withHud.mode, 'move');
  assert.equal(withHud.hud, '800,520 · 8×8', `HUD 应显示真实尺寸：${withHud.hud}`);

  /* 真点一个手柄也要能起手势（不是只有 hitTest 好看） */
  await drag(page, { x: 818, y: 538 }, { x: 828, y: 548 });
  const resized = await snapshot(page);
  assert.equal(resized.log.commits.length, 1);
  assert.equal(resized.log.commits[0].value.w, 18);
  assert.equal(resized.log.commits[0].value.h, 18);

  evidence.cases['S19-A6'] = {
    ok: true,
    frame: state.frame,
    ring: state.dom.ring,
    hits,
    spots,
    hud: withHud,
    resizeOp: resized.log.commits[0],
    screenshot: 's19-a6-ring-8x8.png'
  };
  await handle.dispose();
});

/* ── A7 ─────────────────────────────────────────────────────────────────── */

test('S19-A7 旋转层缩放手柄：锚点漂移 ≤1px（含测量方法）', async () => {
  const project = await makeProject('s19-a7');
  const { handle, page } = await openFilm(project, ['#a']);

  /* 让 #a 在会话里带 r=30（只改宿主选择，不动磁盘） */
  await page.evaluate(() => {
    window.__selected = window.__selected.map((item) => (item.at === '#a' ? { ...item, box: { ...item.box, r: 30 } } : item));
    window.__applyBox('#a', { ...window.__selected[0].box });
    window.__gesture.refresh();
  });

  /* 拖 e 手柄 +20 屏幕 px（x 方向）。框转了 30°，手柄在绕中心旋转后的位置 */
  const frame = await page.evaluate(() => window.__gesture.getState().frame);
  const center = { x: 100 + 150, y: 80 + 60 };
  const rad = (frame.rotationDeg * Math.PI) / 180;
  const eHandle = { x: center.x + 150 * Math.cos(rad), y: center.y + 150 * Math.sin(rad) };
  await drag(page, eHandle, { x: eHandle.x + 20, y: eHandle.y });
  const after = await snapshot(page);
  assert.equal(after.log.commits.length, 1, `应提交：${JSON.stringify(after.log.commits)}`);
  const op = after.log.commits[0];
  assert.equal(op.value.r, 30, `r 应保持 30：${JSON.stringify(op.value)}`);

  /* 测量方法：锚点 = 中心 + R(r)·(∓w/2, ∓h/2)（r 为自身角度；CSS rotate 绕中心，所以这是视觉锚点）。
     分别用起点 box 与提交 box 算一次，距离差即漂移。 */
  const before = { x: 100, y: 80, w: 300, h: 120 };
  const measured = await page.evaluate(
    ([b, a]) => {
      const p0 = window.__mod.anchorPointOf(b, 'e', 30);
      const p1 = window.__mod.anchorPointOf(a, 'e', 30);
      return { p0, p1, drift: Math.hypot(p1.x - p0.x, p1.y - p0.y) };
    },
    [before, op.value]
  );

  assert.ok(measured.drift <= 1, `锚点漂移 ${measured.drift}px 应 ≤1px（${JSON.stringify(measured)}）`);
  assert.equal(after.state.lastResizeDrift !== null, true, '手势应记录漂移量');
  assert.ok(after.state.lastResizeDrift <= 1, `state.lastResizeDrift=${after.state.lastResizeDrift}`);

  evidence.cases['S19-A7'] = {
    ok: true,
    startBox: before,
    op: op,
    method: '锚点 = 中心 + R(r)·(∓w/2, ∓h/2)；r=自身角度（CSS rotate 绕中心）。用起点 box 与提交 box 各算一次，欧氏距离差即漂移。',
    anchors: measured,
    stateDrift: after.state.lastResizeDrift,
    frameBefore: frame,
    eHandle
  };
  await handle.dispose();
});

/* ── A4S（支撑用例，不在派单 A 列表）──────────────────────────────────── */

test('S19-A4S 多选等比缩放：拖 se → 两条 op 同因子（一批）', async () => {
  const project = await makeProject('s19-a4s');
  const { handle, page } = await openFilm(project, ['#a', '#b']);

  const start = await snapshot(page);
  assert.equal(start.state.count, 2);
  /* 并集 (100,80)-(760,200) = 660×120；se 在 (760,200)，拖 +66/+12 → 因子 1.1 */
  await drag(page, { x: 760, y: 200 }, { x: 826, y: 212 });
  const after = await snapshot(page);

  assert.equal(after.log.commits.length, 0, '多选不应走单选 onCommit');
  assert.equal(after.log.batches.length, 1);
  const ops = after.log.batches[0];
  assert.equal(ops.length, 2);
  const byClip = new Map(ops.map((op) => [op.clip, op.value]));
  assert.deepEqual(byClip.get('a'), { x: 100, y: 80, w: 330, h: 132 });
  assert.deepEqual(byClip.get('b'), { x: 562, y: 80, w: 264, h: 132 });
  /* 同一因子：两层的 w 都 ×1.1、h 都 ×1.1（等比约束） */
  assert.equal(byClip.get('a').w / 300, byClip.get('b').w / 240);
  assert.equal(byClip.get('a').h / 120, byClip.get('b').h / 120);

  evidence.cases['S19-A4S'] = {
    ok: true,
    constraint: '多选缩放只做等比，且要求各层无祖先变换（否则 MULTI_RESIZE_UNSUPPORTED，只允许移动）',
    ops
  };
  await handle.dispose();
});
