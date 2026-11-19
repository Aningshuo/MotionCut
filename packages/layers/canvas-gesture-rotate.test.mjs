// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S21-ROTATE-FIX 验收 A1..A5
 *
 * 复现的是**真实工作台**的路径：舞台本身就是一张铺满整块的 `<iframe>`（真 Studio 的结构），
 * 旋转手柄浮在这张 iframe 上方 24px。指针一离开手柄就进了子文档，父文档收不到
 * pointermove/pointerup —— R10 的 harness 用的是「舞台在父文档、片段是 iframe」的结构，
 * 旋转弧只要不过片段就永远踩不到这条路径，所以 8/8 全绿但真实产品里松手不提交。
 *
 * - A1 复现（修前红/修后绿）：舞台=iframe，60° 弧，松手在 iframe 上
 * - A2 正常路径：舞台=父文档，30° → onCommit 一次、value.r=30、mode 归 null
 * - A3 旋转 + 真 /ops + /undo：磁盘 rotate 出现再消失
 * - A4 指针滑出框体/滑出舞台再回 iframe 松手 → 仍提交一次
 * - A5 没有 onError 的宿主：错误写进 state.error，不抛、不静默
 *
 * 运行：node --test --test-concurrency=1 packages/layers/canvas-gesture-rotate.test.mjs（env 由 test-env.mjs 自动准备；`OPENCUT_ENV_JSON` 可显式覆盖）
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

const TEST_ENV = await resolveLayerTestEnv({ suite: 'canvas-gesture-rotate' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');
const PROJECTS = path.join(RUN_ROOT, 'projects');
const BUNDLE_ABS = path.join(RUN_ROOT, 'tmp/s21/gesture.mjs');
const BUNDLE_URL = '/' + path.relative(REPO_ROOT, BUNDLE_ABS).split(path.sep).join('/');

const STAGE_W = 1280;
const STAGE_H = 720;
const BATCH = 'B-SUB1-R11-011';

/** 父文档舞台（片段是 iframe）：box 写死在 film.html 的 style 里。 */
const BOXES = {
  a: { x: 100, y: 80, w: 300, h: 120 },
  b: { x: 520, y: 80, w: 240, h: 120 },
  c: { x: 100, y: 420, w: 400, h: 100 },
  d: { x: 800, y: 520, w: 120, h: 90 }
};

const SCENE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;background:#fdf6e3}
.hint{font:22px/1.4 "PingFang SC",Arial;color:#123;padding:10px 14px}
/* 舞台 iframe 里真的有一张卡：选中框就套在它上面，截图能直接看出「框住内容并旋转」 */
.card{position:absolute;left:300px;top:250px;width:260px;height:140px;box-sizing:border-box;
      background:#fff;border:1px solid #d8cbb0;border-radius:6px;
      font:20px/1.5 "PingFang SC",Arial;color:#123;padding:14px}
</style></head><body><div class="hint">片段内容 · 真实文字</div><div class="card" id="card-b">旋转这张卡<br>拖手柄 → 松手提交</div></body></html>`;

const FILM_PLAIN_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
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

/** 真 Studio 的样子：舞台整体就是一张 iframe，铺满 1280×720。 */
const FILM_STAGE_IFRAME_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#0f1729}
section{position:relative;display:block;width:1280px;height:720px}
#scene{position:absolute;left:0;top:0;width:1280px;height:720px;border:0;display:block}
</style></head><body>
<section><iframe id="scene" src="scene.html#t=0,4" at="0"></iframe></section>
</body></html>`;

/** 舞台 iframe 里的选中层（声明 box；舞台局部坐标） */
const STAGE_IFRAME_BOX = { x: 300, y: 250, w: 260, h: 140 };

const evidence = {
  batch: BATCH,
  suite: 'canvas-gesture-rotate.test.mjs',
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
        "export { mountCanvasGesture, rotationDeltaOf } from './packages/layers/canvas-gesture.mjs';"
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
  for (const name of ['s21-a4-iframe-drag.png']) {
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
  await fs.writeFile(path.join(EVIDENCE_DIR, 's21-rotate-fix.json'), JSON.stringify(evidence, null, 2) + '\n');
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

async function makeProject(name, kind = 'plain') {
  const dir = path.join(PROJECTS, `${name}-${process.pid}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'scene.html'), SCENE_HTML);
  await fs.writeFile(path.join(dir, 'film.html'), kind === 'stage-iframe' ? FILM_STAGE_IFRAME_HTML : FILM_PLAIN_HTML);
  const opened = await post(`${studio.url}/api/projects/open`, { dir });
  assert.equal(opened.status, 200, `open 失败：${opened.text}`);
  const projectId = opened.json.project.projectId;
  const doc = await get(`${studio.url}/api/projects/${encodeURIComponent(projectId)}/doc`);
  assert.equal(doc.status, 200, `doc 失败：${doc.text}`);
  return { dir, projectId, hash: doc.json.hash, filmPath: path.join(dir, 'film.html'), kind };
}

/**
 * 页内宿主。
 * - layers 由 deps 给（舞台局部 box）
 * - 舞台 iframe 就真的铺在下面，指针一动就进子文档
 * - deps.omitOnError / omitOnCommitMany 用来验「宿主没接全」时的降级与报码
 */
async function mountLive(deps) {
  const mod = await import(deps.bundle);
  const stageEl = document.querySelector(deps.stageSelector);
  if (!stageEl) throw new Error(`没有舞台：${deps.stageSelector}`);

  const all = deps.layers.map((layer) => ({ ...layer, rect: { ...layer.box } }));
  const byAt = new Map(all.map((layer) => [layer.at, layer]));
  const log = { previews: [], commits: [], batches: [], cancels: 0, errors: [], selections: [] };
  window.__gestureLog = log;

  const elOf = (sel) => {
    const inParent = document.querySelector(sel);
    if (inParent) return inParent;
    const scene = document.querySelector('#scene');
    try {
      return scene?.contentDocument?.querySelector(sel) ?? null;
    } catch {
      return null;
    }
  };

  const applyBox = (layer, box) => {
    layer.rect = { x: box.x, y: box.y, w: box.w, h: box.h };
    const el = elOf(layer.at);
    if (!el) return;
    el.style.left = `${box.x}px`;
    el.style.top = `${box.y}px`;
    el.style.width = `${box.w}px`;
    el.style.height = `${box.h}px`;
    if (typeof box.r === 'number' && box.r !== 0) el.style.rotate = `${box.r}deg`;
    else el.style.removeProperty('rotate');
  };

  window.__selected = deps.selected.map((at) => byAt.get(at)).filter(Boolean);

  const readStage = () => {
    const r = stageEl.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, scale: r.width / deps.stageSize.w || 1 };
  };

  const layerOfOp = (op) => (op && op.clip ? all.find((layer) => layer.clip === op.clip) ?? null : window.__selected[0] ?? null);

  /** @type {any} */
  let controller = null;
  const opts = {
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
      if (layer) {
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
    stageSize: deps.stageSize
  };
  /* 故意不接的键：验「没接全」时的降级（S22 的 minimal 宿主也走这条） */
  if (deps.omitOnError !== true) opts.onError = (info) => log.errors.push(info);
  if (deps.omitOnCommitMany === true) delete opts.onCommitMany;

  controller = mod.mountCanvasGesture(document.body, opts);

  /* 片段 iframe 里的 pointerdown 转发（舞台 iframe #scene 不转发：它是舞台本身） */
  const forward = (frameEl) => {
    if (frameEl.id === 'scene') return;
    try {
      const frameDoc = frameEl.contentDocument;
      if (!frameDoc || frameDoc.__r11Forward) return;
      frameDoc.__r11Forward = true;
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
      /* 跨源 frame 读不到就不转发 */
    }
  };
  for (const frameEl of document.querySelectorAll('iframe')) {
    forward(frameEl);
    frameEl.addEventListener('load', () => forward(frameEl));
  }

  window.__gesture = controller;
  window.__all = all;
  window.__mod = mod;
  return { stage: readStage(), state: controller.getState() };
}

async function openFilm(project, deps = {}) {
  const filmRel = path.relative(REPO_ROOT, project.filmPath).split(path.sep).join('/');
  const handle = await host.open(filmRel);
  const page = handle.page;
  const pageErrors = [];
  const consoleErrors = [];
  const consoleWarnings = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
    if (msg.type() === 'warning') consoleWarnings.push(msg.text());
  });
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  const isStageIframe = project.kind === 'stage-iframe';
  const mounted = await page.evaluate(mountLive, {
    bundle: BUNDLE_URL,
    stageSelector: 'section:first-of-type',
    stageSize: { w: STAGE_W, h: STAGE_H },
    layers: deps.layers ?? (isStageIframe ? [{ at: '#card-b', box: STAGE_IFRAME_BOX, clip: 'card-b' }] : Object.entries(BOXES).map(([id, box]) => ({ at: `#${id}`, box, clip: id }))),
    selected: deps.selected ?? (isStageIframe ? ['#card-b'] : ['#a']),
    omitOnError: deps.omitOnError,
    omitOnCommitMany: deps.omitOnCommitMany
  });
  return { handle, page, mounted, pageErrors, consoleErrors, consoleWarnings };
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
    active: document.querySelector('[data-canvas-gesture]').getAttribute('data-gesture-active'),
    mode: document.querySelector('[data-canvas-gesture]').getAttribute('data-gesture-mode'),
    hud: (() => {
      const el = document.querySelector('[data-gesture-hud]');
      return el ? { text: el.textContent, display: getComputedStyle(el).display } : null;
    })(),
    log: {
      previews: window.__gestureLog.previews.length,
      commits: window.__gestureLog.commits,
      batches: window.__gestureLog.batches,
      cancels: window.__gestureLog.cancels,
      errors: window.__gestureLog.errors,
      selections: window.__gestureLog.selections
    }
  }));
}

/** 框中心 / 旋转手柄半径（手柄在框顶外 24px）。 */
function rotateGeometry(box) {
  const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const radius = box.h / 2 + 24;
  const at = (deg) => ({
    x: center.x + radius * Math.sin((deg * Math.PI) / 180),
    y: center.y - radius * Math.cos((deg * Math.PI) / 180)
  });
  return { center, radius, at };
}

/* ── A1 复现：舞台 = iframe，松手落在 iframe 上 ─────────────────────────── */

test('S21-A1 指针进 iframe 后松手 → 必须提交一次（修前红/修后绿）', async () => {
  const project = await makeProject('s21-a1', 'stage-iframe');
  const { handle, page, pageErrors } = await openFilm(project);

  const start = await snapshot(page);
  assert.equal(start.state.count, 1);
  const geo = rotateGeometry(STAGE_IFRAME_BOX);
  assert.ok(Math.abs(start.state.frame.x - STAGE_IFRAME_BOX.x) <= 1, `框应与声明对齐：${JSON.stringify(start.state.frame)}`);

  /* 60° 弧：整条弧都在舞台 iframe 上方 */
  await drag(page, geo.at(0), geo.at(60), {
    steps: 12,
    beforeUp: async () => {
      const mid = await snapshot(page);
      evidence.cases['S21-A1'] = evidence.cases['S21-A1'] ?? {};
      evidence.cases['S21-A1'].midDrag = { mode: mid.state.mode, active: mid.active, hud: mid.hud?.text ?? null, previews: mid.log.previews };
    }
  });
  const after = await snapshot(page);

  const result = {
    ok: after.log.commits.length === 1 && after.state.mode === null && after.active === 'false',
    commits: after.log.commits.length,
    batches: after.log.batches.length,
    mode: after.state.mode,
    active: after.active,
    rotation: after.state.box?.r ?? 0,
    errors: after.log.errors,
    pageErrors,
    midDrag: evidence.cases['S21-A1']?.midDrag ?? null
  };
  evidence.cases['S21-A1'] = { ...(evidence.cases['S21-A1'] ?? {}), ...result };

  assert.deepEqual(pageErrors, [], `不应有 pageerror：${pageErrors}`);
  assert.equal(after.log.commits.length, 1, `松手必须提交一次（实际 ${after.log.commits.length}）；${JSON.stringify(result)}`);
  assert.equal(after.state.mode, null, `手势应结束：${after.state.mode}`);
  assert.equal(after.active, 'false', `data-gesture-active 应变 false：${after.active}`);
  assert.equal(Math.round(after.state.box?.r ?? 0), 60, `角度应到 60°：${after.state.box?.r}`);
  await handle.dispose();
});

/* ── A2 正常路径（舞台=父文档）──────────────────────────────────────────── */

test('S21-A2 旋转 30° → onCommit 一次、value.r=30、mode 归 null', async () => {
  const project = await makeProject('s21-a2', 'plain');
  project.kind = 'plain';
  const { handle, page } = await openFilm(project, { selected: ['#a'] });

  const geo = rotateGeometry(BOXES.a);
  await drag(page, geo.at(0), geo.at(30), { steps: 10 });
  const after = await snapshot(page);

  assert.equal(after.log.commits.length, 1, `应提交一次：${JSON.stringify(after.log.commits)}`);
  const op = after.log.commits[0];
  assert.deepEqual(op, { op: 'set', field: 'box', value: { x: 100, y: 80, w: 300, h: 120, r: 30 }, clip: 'a' });
  assert.equal(after.state.mode, null);
  assert.equal(after.active, 'false');
  assert.equal(after.log.errors.length, 0, `不应报错：${JSON.stringify(after.log.errors)}`);

  evidence.cases['S21-A2'] = { ok: true, op, mode: after.state.mode, active: after.active, frame: after.state.frame };
  await handle.dispose();
});

/* ── A3 旋转 + 真 /ops + /undo ──────────────────────────────────────────── */

test('S21-A3 旋转落盘 rotate:30deg，撤销后 box.r 消失', async () => {
  const project = await makeProject('s21-a3', 'plain');
  project.kind = 'plain';
  const { handle, page } = await openFilm(project, { selected: ['#a'] });

  const geo = rotateGeometry(BOXES.a);
  await drag(page, geo.at(0), geo.at(30), { steps: 10 });
  const after = await snapshot(page);

  assert.equal(after.log.commits.length, 1, `应提交一次：${JSON.stringify(after.log.commits)}`);
  const op = after.log.commits[0];
  assert.equal(op.value.r, 30);

  const client = createOpsClient({ projectId: project.projectId, batchId: BATCH, owner: 'SUB1', expectedHash: project.hash, baseUrl: studio.url });
  const commit = await client.commitSet({ clip: 'a', field: 'box', value: op.value });
  assert.equal(commit.ok, true, `提交失败：${JSON.stringify(commit)}`);

  const filmCommitted = await fs.readFile(project.filmPath, 'utf8');
  const inlineCommitted = /id="a"[^>]*style="([^"]*)"/.exec(filmCommitted)?.[1] ?? '';
  assert.ok(/rotate:\s*30deg/.test(inlineCommitted), `磁盘应有 rotate: 30deg：${inlineCommitted}`);

  const docAfter = await get(`${studio.url}/api/projects/${encodeURIComponent(project.projectId)}/doc`);
  const parsed = docAfter.json.doc ?? docAfter.json;
  const clipCommitted = (parsed.tracks ?? []).flatMap((t) => t.clips ?? []).find((c) => c.id === 'a');
  assert.equal(clipCommitted.box.r, 30, `doc 里应有 box.r=30：${JSON.stringify(clipCommitted.box)}`);

  const undoRes = await post(`${studio.url}/api/projects/${encodeURIComponent(project.projectId)}/undo`, { expectedHash: commit.hash });
  assert.equal(undoRes.status, 200, `撤销失败：${undoRes.text}`);

  const filmUndone = await fs.readFile(project.filmPath, 'utf8');
  const inlineUndone = /id="a"[^>]*style="([^"]*)"/.exec(filmUndone)?.[1] ?? '';
  assert.ok(!/rotate:/.test(inlineUndone), `撤销后不应有 rotate：${inlineUndone}`);
  assert.ok(/left:\s*100px/.test(inlineUndone), `撤销后 left 应回 100：${inlineUndone}`);

  const docUndone = await get(`${studio.url}/api/projects/${encodeURIComponent(project.projectId)}/doc`);
  const parsedUndone = docUndone.json.doc ?? docUndone.json;
  const clipUndone = (parsedUndone.tracks ?? []).flatMap((t) => t.clips ?? []).find((c) => c.id === 'a');
  assert.equal(clipUndone.box.r, undefined, `撤销后 box.r 应消失：${JSON.stringify(clipUndone.box)}`);

  evidence.cases['S21-A3'] = {
    ok: true,
    op,
    http: { status: commit.status, request: commit.request, response: commit.response },
    diskCommitted: inlineCommitted,
    docCommitted: clipCommitted.box,
    undo: { status: undoRes.status, body: undoRes.text, inline: inlineUndone, box: clipUndone.box }
  };
  await handle.dispose();
});

/* ── A4 指针滑出框体/滑出舞台，再回 iframe 松手 ─────────────────────────── */

test('S21-A4 指针离开框体与舞台后再松手 → 仍提交一次', async () => {
  const project = await makeProject('s21-a4', 'stage-iframe');
  const { handle, page, pageErrors } = await openFilm(project);

  const geo = rotateGeometry(STAGE_IFRAME_BOX);
  await page.mouse.move(geo.at(0).x, geo.at(0).y);
  await page.mouse.down();
  await page.mouse.move(geo.at(25).x, geo.at(25).y, { steps: 6 });
  /* 滑出框体（框在 300..560 / 250..390），一路滑到舞台外（x>1280）再回来 */
  await page.mouse.move(1350, 60, { steps: 6 });
  const outside = await snapshot(page);
  await page.mouse.move(geo.at(45).x, geo.at(45).y, { steps: 6 });

  const shot = path.join(EVIDENCE_DIR, 's21-a4-iframe-drag.png');
  await page.screenshot({ path: shot, clip: { x: 0, y: 0, width: STAGE_W, height: STAGE_H } });

  await page.mouse.up();
  const after = await snapshot(page);

  assert.deepEqual(pageErrors, []);
  assert.equal(outside.state.mode, 'rotate', `滑出时应仍处于 rotate：${outside.state.mode}`);
  assert.equal(after.log.commits.length, 1, `松手必须提交一次：${JSON.stringify({ mode: after.state.mode, active: after.active, commits: after.log.commits.length })}`);
  assert.equal(after.state.mode, null);
  assert.equal(after.active, 'false');
  const op = after.log.commits[0];
  assert.equal(op.value.r, 45, `角度应按最后一次指针位置算 45°：${op.value.r}`);

  evidence.cases['S21-A4'] = { ok: true, op, outsideMode: outside.state.mode, outsideActive: outside.active, mode: after.state.mode, active: after.active };
  await handle.dispose();
});

/* ── A5 没有 onError 的宿主：state.error 有码、不抛、不静默 ─────────────── */

test('S21-A5 宿主没给 onError → 错误进 state.error，不抛异常', async () => {
  const project = await makeProject('s21-a5', 'plain');
  project.kind = 'plain';
  /* 故意同时不给 onCommitMany：多选松手时没有批量提交口，必须报 NO_BATCH_COMMITTER */
  const { handle, page, pageErrors, consoleWarnings } = await openFilm(project, { selected: ['#a'], omitOnError: true, omitOnCommitMany: true });

  /* Shift 点选 #b 加选 → 两层（page.mouse.click 没有 modifiers 选项，得真的按住 Shift） */
  await page.keyboard.down('Shift');
  await page.mouse.click(BOXES.b.x + 20, BOXES.b.y + 20);
  await page.keyboard.up('Shift');
  const two = await snapshot(page);
  assert.equal(two.state.count, 2, `应选中两层：${two.state.count}（${JSON.stringify(two.state.ats)}）`);

  /* 拖框体移动（多选移动），松手时没有 onCommitMany */
  await drag(page, { x: BOXES.a.x + 40, y: BOXES.a.y + 40 }, { x: BOXES.a.x + 80, y: BOXES.a.y + 70 }, { steps: 8 });
  const after = await snapshot(page);

  const stateError = after.state.error;
  assert.deepEqual(pageErrors, [], `不应抛异常：${pageErrors}`);
  assert.ok(stateError && stateError.code === 'NO_BATCH_COMMITTER', `state.error 应有 NO_BATCH_COMMITTER：${JSON.stringify(stateError)}`);
  assert.equal(after.log.errors.length, 0, '宿主没给 onError，不应该有回调记录');
  assert.equal(after.log.batches.length, 0, '没有批量提交口就不该提交');
  assert.equal(after.state.mode, null, '手势仍应结束');
  assert.ok(
    consoleWarnings.some((text) => text.includes('NO_BATCH_COMMITTER')),
    `宿主没给 onError 时也要 console.warn 一次带码：${JSON.stringify(consoleWarnings)}`
  );

  evidence.cases['S21-A5'] = {
    ok: true,
    stateError,
    pageErrors,
    consoleWarnings,
    logErrors: after.log.errors.length,
    mode: after.state.mode,
    active: after.active
  };
  await handle.dispose();
});
