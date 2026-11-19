// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S17-CANVAS-GESTURE 验收 A1..A7
 *
 * 场景：样例 film.html（真实场景 scene-a 有标题/副标题/柱状图文字），第一个 `<section>` 是舞台。
 * 选中 `iframe#card-a`（声明 box `left:100px;top:60px;width:720px;height:405px`），
 * 手势层挂在 film 文档的 body 上（position:fixed，与舞台 rect 对齐）。
 *
 * 拖动用 `page.mouse` 发真实指针事件；A1 把产出的 op 原样发给真实 Studio 的 `/ops` 落盘，
 * 其余用例只断言宿主回调（不写盘，避免把「手势」和「持久化」混为一谈）。
 *
 * 运行：node --test --test-concurrency=1 packages/layers/canvas-gesture.test.mjs（env 由 test-env.mjs 自动准备；`OPENCUT_ENV_JSON` 可显式覆盖）
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

const TEST_ENV = await resolveLayerTestEnv({ suite: 'canvas-gesture' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');
const PROJECTS = path.join(RUN_ROOT, 'projects');
const BUNDLE_ABS = path.join(RUN_ROOT, 'tmp/s17/gesture.mjs');
const BUNDLE_URL = '/' + path.relative(REPO_ROOT, BUNDLE_ABS).split(path.sep).join('/');

const SAMPLE =
  '/tmp/motioncut-optional-scene-fixture';

const STAGE_W = 1280;
const STAGE_H = 720;
const BASE_CSS =
  '<style id="r9-stage">html,body{margin:0;padding:0}' +
  `section{position:relative;display:block;width:${STAGE_W}px;height:${STAGE_H}px}` +
  'iframe,video,audio{position:absolute;left:0;top:0;border:0;display:block}</style>';

/** 片段声明 box：放在舞台中部，四周都留得下 +30/+20 的拖动。 */
const DECLARED_BOX = 'left: 100px; top: 60px; width: 720px; height: 405px';

const evidence = {
  batch: 'B-SUB1-R9-009',
  suite: 'canvas-gesture.test.mjs',
  cases: {},
  studio: {},
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
        "export { mountCanvasGesture, dragBox, screenDeltaToDeclared, GESTURE_MIN_SIZE } from './packages/layers/canvas-gesture.mjs';"
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
  for (const name of ['s17-a7-selection.png', 's17-a7-dragging.png']) {
    try {
      const abs = path.join(EVIDENCE_DIR, name);
      const stat = await fs.stat(abs);
      const buf = await fs.readFile(abs);
      files.push({ name, bytes: stat.size, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
    } catch {
      files.push({ name, bytes: 0, sha256: null, missing: true });
    }
  }
  evidence.screenshots = files;
  evidence.finishedAt = new Date().toISOString();
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(path.join(EVIDENCE_DIR, 's17-canvas-gesture.json'), JSON.stringify(evidence, null, 2) + '\n');
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
 * 复制样例 → 注入舞台 CSS（可带 section 变换）→ 给 card-a 声明 box → 真实 open。
 * @param {string} name
 * @param {{css?: string}} [opts]
 */
async function makeProject(name, opts = {}) {
  const dir = path.join(PROJECTS, `${name}-${process.pid}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.cp(SAMPLE, dir, { recursive: true });
  const filmPath = path.join(dir, 'film.html');
  let film = await fs.readFile(filmPath, 'utf8');
  assert.ok(film.includes('</head>'), '样例 film.html 应有 head');
  const css = [BASE_CSS.replace('</style>', `${opts.css ?? ''}</style>`)];
  film = film.replace('</head>', `${css.join('')}</head>`);
  film = film.replace(
    '<iframe id="card-a" src="scene-a.html#t=0,4" at="0">',
    `<iframe id="card-a" src="scene-a.html#t=0,4" at="0" style="${DECLARED_BOX}">`
  );
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

/**
 * 页内：挂手势层（stage = 第一个 section）。
 * `onCommit` 记录 op，并把宿主侧的「当前选择」改成新 box —— 与真实宿主一致（提交成功后刷新选择）。
 */
async function mountLive(deps) {
  const mod = await import(deps.bundle);
  const stageEl = document.querySelector(deps.stageSelector);
  if (!stageEl) throw new Error(`没有舞台：${deps.stageSelector}`);

  const log = { previews: [], commits: [], cancels: 0, stageClicks: 0 };
  window.__gestureLog = log;
  window.__selection = deps.selection ? { at: deps.selection.at, box: { ...(deps.selection.box ?? {}) } } : null;
  if (deps.selection && deps.selectionFromComputed === true && window.__selection) {
    const el = document.querySelector(deps.selection.at);
    if (!el) throw new Error(`没有层：${deps.selection.at}`);
    const cs = getComputedStyle(el);
    window.__selection.box = {
      x: parseFloat(cs.left),
      y: parseFloat(cs.top),
      w: parseFloat(cs.width),
      h: parseFloat(cs.height)
    };
  }
  stageEl.addEventListener('click', () => {
    log.stageClicks += 1;
  });

  const readStage = () => {
    const r = stageEl.getBoundingClientRect();
    const scale = deps.stageSize.w > 0 ? r.width / deps.stageSize.w : 1;
    return { x: r.x, y: r.y, w: r.width, h: r.height, scale: scale > 0 ? scale : 1 };
  };

  /** 宿主的「预览」= 真的把 box 写到元素内联样式（与工作台同一条路径，只是不落盘）。 */
  const applyBoxTo = (at, box) => {
    const el = at ? document.querySelector(at) : null;
    if (!el) return null;
    el.style.left = `${box.x}px`;
    el.style.top = `${box.y}px`;
    el.style.width = `${box.w}px`;
    el.style.height = `${box.h}px`;
    if (typeof box.r === 'number' && box.r !== 0) el.style.rotate = `${box.r}deg`;
    else el.style.removeProperty('rotate');
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  };
  window.__applyBox = applyBoxTo;

  /** @type {any} */
  let controller = null;
  controller = mod.mountCanvasGesture(document.body, {
    getStageRect: readStage,
    getSelection: () => window.__selection,
    onPreview: (op) => {
      log.previews.push(op);
      applyBoxTo(window.__selection?.at ?? '', op.value);
    },
    onCommit: (op) => {
      log.commits.push(op);
      /* 宿主提交成功后用自己的新 box 刷新选择（被测组件不替宿主记这个状态） */
      if (window.__selection) window.__selection = { at: window.__selection.at, box: { ...op.value } };
      applyBoxTo(window.__selection?.at ?? '', op.value);
      controller.refresh();
    },
    onCancel: () => {
      log.cancels += 1;
      /* 取消 = 预览回滚到手势前的 box（框与内容都回原位） */
      if (window.__selection) applyBoxTo(window.__selection.at, window.__selection.box);
      controller.refresh();
    },
    stageSize: deps.stageSize
  });

  window.__gesture = controller;
  window.__stageEl = stageEl;
  window.__mod = mod;
  return {
    stage: readStage(),
    frame: controller.getFrameClientRect(),
    state: controller.getState(),
    stageRect: (() => {
      const r = stageEl.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    })()
  };
}

async function openFilm(project) {
  const filmRel = path.relative(REPO_ROOT, project.filmPath).split(path.sep).join('/');
  const handle = await host.open(filmRel);
  const page = handle.page;
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  const mounted = await page.evaluate(mountLive, {
    bundle: BUNDLE_URL,
    stageSelector: 'section:first-of-type',
    stageSize: { w: STAGE_W, h: STAGE_H },
    selection: { at: '#card-a', box: project.clip.box }
  });
  return { handle, page, mounted, consoleErrors };
}

/** 直接打开真实场景（scene-a.html）：原生 DOM、无 iframe，用于截图。 */
async function openScene(project) {
  const rel = path.relative(REPO_ROOT, path.join(project.dir, 'scene-a.html')).split(path.sep).join('/');
  const handle = await host.open(rel);
  const page = handle.page;
  await page.addStyleTag({ content: 'html,body{width:1280px !important;height:720px !important;overflow:hidden !important}' });
  const mounted = await page.evaluate(mountLive, {
    bundle: BUNDLE_URL,
    stageSelector: '.stage',
    stageSize: { w: STAGE_W, h: STAGE_H },
    selection: { at: '#card-group' },
    selectionFromComputed: true
  });
  return { handle, page, mounted };
}

/**
 * 真实指针拖动。
 * @param {import('playwright').Page} page
 * @param {{x: number, y: number}} from
 * @param {{x: number, y: number}} to
 * @param {{shift?: boolean, beforeUp?: () => Promise<void>, steps?: number}} [opts]
 */
async function drag(page, from, to, opts = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  if (opts.shift === true) await page.keyboard.down('Shift');
  await page.mouse.move(to.x, to.y, { steps: opts.steps ?? 6 });
  if (typeof opts.beforeUp === 'function') await opts.beforeUp();
  await page.mouse.up();
  if (opts.shift === true) await page.keyboard.up('Shift');
}

/** 页内只读快照（框、日志、框的客户区 rect）。 */
function snapshot(page) {
  return page.evaluate(() => ({
    state: window.__gesture.getState(),
    frame: window.__gesture.getFrameClientRect(),
    stage: (() => {
      const r = window.__stageEl.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    })(),
    log: {
      previews: window.__gestureLog.previews.length,
      commits: window.__gestureLog.commits,
      cancels: window.__gestureLog.cancels,
      stageClicks: window.__gestureLog.stageClicks
    },
    overlayPointer: getComputedStyle(document.querySelector('[data-canvas-gesture]')).pointerEvents,
    framePointer: getComputedStyle(document.querySelector('[data-gesture-frame]')).pointerEvents,
    frameShadow: getComputedStyle(document.querySelector('[data-gesture-frame]')).boxShadow,
    handles: document.querySelectorAll('[data-handle]').length,
    frameSpace: document.querySelector('[data-gesture-frame]').getAttribute('data-frame-space'),
    at: document.querySelector('[data-canvas-gesture]').getAttribute('data-gesture-at'),
    cardRect: (() => {
      const el = document.querySelector('#card-a');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    })()
  }));
}

/* ── A1 ─────────────────────────────────────────────────────────────────── */

test('S17-A1 scale=1 拖动 +30 → x+30，整段手势只提交 1 次（并真实落盘）', async () => {
  const project = await makeProject('s17-a1');
  assert.deepEqual(project.clip.box, { x: 100, y: 60, w: 720, h: 405 }, `声明 box 解析：${JSON.stringify(project.clip.box)}`);
  const { handle, page, mounted, consoleErrors } = await openFilm(project);

  assert.equal(mounted.state.at, '#card-a');
  assert.equal(mounted.state.handles.length, 8);
  assert.ok(Math.abs(mounted.frame.x - 100) <= 1, `框 x 应贴 100：${mounted.frame.x}`);
  assert.ok(Math.abs(mounted.frame.y - 60) <= 1, `框 y 应贴 60：${mounted.frame.y}`);
  assert.ok(Math.abs(mounted.frame.w - 720) <= 1, `框宽应 720：${mounted.frame.w}`);
  assert.ok(Math.abs(mounted.frame.h - 405) <= 1, `框高应 405：${mounted.frame.h}`);

  /* 从框体中部拖 +30（屏幕 px） */
  await drag(page, { x: 460, y: 260 }, { x: 490, y: 260 });
  const after1 = await snapshot(page);

  assert.equal(after1.log.commits.length, 1, `应只提交 1 次：${after1.log.commits.length}`);
  assert.ok(after1.log.previews > 0, `手势过程中应有预览：${after1.log.previews}`);
  assert.equal(after1.state.commits, 1);
  assert.deepEqual(after1.log.commits[0], {
    op: 'set',
    field: 'box',
    value: { x: 130, y: 60, w: 720, h: 405 }
  });
  /* 宿主按 onPreview 真的挪了元素（框和内容一起动），不是只画了个框 */
  assert.ok(Math.abs(after1.cardRect.x - 130) <= 1, `元素应已到 130：${after1.cardRect.x}`);
  assert.ok(Math.abs(after1.frame.x - 130) <= 1, `框应贴 130：${after1.frame.x}`);

  /* 产出的 op 原样发给真实 Studio：200 + 磁盘上的 style 真变了 */
  const client = createOpsClient({
    projectId: project.projectId,
    batchId: 'B-SUB1-R9-009',
    owner: 'SUB1',
    expectedHash: project.hash,
    baseUrl: studio.url
  });
  const op = after1.log.commits[0];
  const commit = await client.commitSet({ clip: 'card-a', field: 'box', value: op.value });
  assert.equal(commit.ok, true, `提交失败：${JSON.stringify(commit)}`);

  const doc2 = await get(`${studio.url}/api/projects/${encodeURIComponent(project.projectId)}/doc`);
  const parsed = doc2.json.doc ?? doc2.json;
  const clip2 = (parsed.tracks ?? []).flatMap((t) => t.clips ?? []).find((c) => c.id === 'card-a');
  const filmDisk = await fs.readFile(project.filmPath, 'utf8');
  const inlineStyle = /id="card-a"[^>]*style="([^"]*)"/.exec(filmDisk)?.[1] ?? null;
  assert.equal(clip2.box.x, 130);
  assert.equal(clip2.box.y, 60);
  assert.ok(/left:\s*130px/.test(filmDisk), `磁盘应有 left:130px：${inlineStyle}`);

  assert.deepEqual(consoleErrors, []);
  await page.screenshot({ path: path.join(EVIDENCE_DIR, 's17-a1-after-drag.png'), clip: { x: 0, y: 0, width: STAGE_W, height: STAGE_H } });

  evidence.cases['S17-A1'] = {
    ok: true,
    mounted: { frame: mounted.frame, stage: mounted.stage },
    op,
    commits: after1.log.commits.length,
    previews: after1.log.previews,
    http: { status: commit.status, request: commit.request, response: commit.response },
    disk: { box: clip2.box, inlineStyle, projectionHasNoStyle: clip2.style === undefined || clip2.style === null },
    consoleErrors
  };
  await handle.dispose();
});

/* ── A2 ─────────────────────────────────────────────────────────────────── */

test('S17-A2 舞台 scale=0.5：拖屏幕 +30 → 声明 x+60', async () => {
  const project = await makeProject('s17-a2', { css: 'section:nth-of-type(1){transform:scale(0.5);transform-origin:0 0}' });
  const { handle, page, mounted } = await openFilm(project);

  assert.equal(mounted.stage.scale, 0.5, `舞台缩放：${mounted.stage.scale}`);
  assert.equal(mounted.stage.w, 640);
  /* 声明 100,60,720,405 × 0.5 → 屏幕 50,30,360,202.5 */
  assert.ok(Math.abs(mounted.frame.x - 50) <= 1, `框 x：${mounted.frame.x}`);
  assert.ok(Math.abs(mounted.frame.y - 30) <= 1, `框 y：${mounted.frame.y}`);
  assert.ok(Math.abs(mounted.frame.w - 360) <= 1, `框宽：${mounted.frame.w}`);
  assert.ok(Math.abs(mounted.frame.h - 202.5) <= 1, `框高：${mounted.frame.h}`);
  /* 框的 1px 线不随缩放变粗（box-shadow 固定 1px） */
  const before = await snapshot(page);
  assert.ok(/0px 0px 0px 1px/.test(before.frameShadow), `1px 边框：${before.frameShadow}`);

  await drag(page, { x: 230, y: 130 }, { x: 260, y: 130 });
  const afterDrag = await snapshot(page);

  assert.equal(afterDrag.log.commits.length, 1);
  assert.deepEqual(afterDrag.log.commits[0].value, { x: 160, y: 60, w: 720, h: 405 });

  evidence.cases['S17-A2'] = {
    ok: true,
    stageScale: mounted.stage.scale,
    frame: mounted.frame,
    boxShadow: before.frameShadow,
    op: afterDrag.log.commits[0],
    previews: afterDrag.log.previews
  };
  await page.screenshot({ path: path.join(EVIDENCE_DIR, 's17-a2-scale-half.png'), clip: { x: 0, y: 0, width: 900, height: 600 } });
  await handle.dispose();
});

/* ── A3 ─────────────────────────────────────────────────────────────────── */

test('S17-A3 手柄缩放：se +20/+10 → w/h 增；nw +20/+10 → x/y 增、w/h 减；最小 8×8', async () => {
  const project = await makeProject('s17-a3');
  const { handle, page } = await openFilm(project);

  /* 右下角 se 在 (820,465) */
  await drag(page, { x: 820, y: 465 }, { x: 840, y: 475 });
  const se = await snapshot(page);
  assert.equal(se.log.commits.length, 1);
  assert.equal(se.state.mode, null);
  assert.deepEqual(se.log.commits[0].value, { x: 100, y: 60, w: 740, h: 415 });

  /* 左上角 nw 在 (100,60)：x/y 增 20/10，w/h 减 20/10 */
  await drag(page, { x: 100, y: 60 }, { x: 120, y: 70 });
  const nw = await snapshot(page);
  assert.equal(nw.log.commits.length, 2);
  assert.deepEqual(nw.log.commits[1].value, { x: 120, y: 70, w: 720, h: 405 });

  /* 最小尺寸：se（此时在 840,475）拖到 w/h 只剩 8 → 夹到 8×8（x/y 不动） */
  await drag(page, { x: 840, y: 475 }, { x: 128, y: 78 });
  const min = await snapshot(page);
  assert.deepEqual(min.log.commits[2].value, { x: 120, y: 70, w: 8, h: 8 });

  evidence.cases['S17-A3'] = {
    ok: true,
    se: se.log.commits[0],
    nw: nw.log.commits[1],
    min: min.log.commits[2],
    handles: min.state.handles
  };
  await handle.dispose();
});

/* ── A4 ─────────────────────────────────────────────────────────────────── */

test('S17-A4 Shift + 角手柄：宽高比误差 ≤1px', async () => {
  const project = await makeProject('s17-a4');
  const { handle, page } = await openFilm(project);

  await drag(page, { x: 820, y: 465 }, { x: 840, y: 475 }, { shift: true });
  const afterDrag = await snapshot(page);
  const v = afterDrag.log.commits[0].value;
  const startRatio = 720 / 405;
  const endRatio = v.w / v.h;
  const ratioErrorPx = Math.abs(endRatio - startRatio) * v.h;

  assert.equal(afterDrag.log.commits.length, 1);
  assert.ok(v.w > 720 && v.h > 405, `应放大：${JSON.stringify(v)}`);
  assert.ok(ratioErrorPx <= 1, `比例误差 ${ratioErrorPx}px（${v.w}×${v.h}）`);

  evidence.cases['S17-A4'] = { ok: true, op: afterDrag.log.commits[0], startRatio, endRatio, ratioErrorPx };
  await handle.dispose();
});

/* ── A5 ─────────────────────────────────────────────────────────────────── */

test('S17-A5 Esc 中途取消 → 0 commit、1 cancel、框回原位', async () => {
  const project = await makeProject('s17-a5');
  const { handle, page } = await openFilm(project);

  await drag(page, { x: 460, y: 260 }, { x: 490, y: 260 }, {
    beforeUp: async () => {
      await page.keyboard.press('Escape');
    }
  });
  const afterEsc = await snapshot(page);

  assert.equal(afterEsc.log.commits.length, 0, `不应提交：${JSON.stringify(afterEsc.log.commits)}`);
  assert.equal(afterEsc.log.cancels, 1);
  assert.equal(afterEsc.state.cancels, 1);
  assert.equal(afterEsc.state.mode, null);
  assert.ok(Math.abs(afterEsc.frame.x - 100) <= 1, `框应回 x=100：${afterEsc.frame.x}`);
  assert.ok(Math.abs(afterEsc.frame.y - 60) <= 1, `框应回 y=60：${afterEsc.frame.y}`);
  assert.ok(Math.abs(afterEsc.cardRect.x - 100) <= 1, `预览应回滚（元素 x=100）：${afterEsc.cardRect.x}`);

  evidence.cases['S17-A5'] = { ok: true, commits: afterEsc.log.commits.length, cancels: afterEsc.log.cancels, frame: afterEsc.frame, cardRect: afterEsc.cardRect };
  await handle.dispose();
});

/* ── A6 ─────────────────────────────────────────────────────────────────── */

test('S17-A6 未选中时点击穿透；选中框与舞台对齐 ≤1px', async () => {
  const project = await makeProject('s17-a6');
  const { handle, page } = await openFilm(project);

  /* 未选中：overlay 仍在，但只有框和手柄吃事件；此处框被隐藏 → 点击落到舞台上 */
  const cleared = await page.evaluate(() => {
    window.__selection = null;
    window.__gesture.refresh();
    const overlay = document.querySelector('[data-canvas-gesture]');
    const frame = document.querySelector('[data-gesture-frame]');
    return {
      overlayPointer: getComputedStyle(overlay).pointerEvents,
      frameDisplay: getComputedStyle(frame).display,
      hit: (() => {
        const el = document.elementFromPoint(1200, 650);
        return el ? `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}` : null;
      })(),
      active: overlay.getAttribute('data-gesture-active')
    };
  });
  assert.equal(cleared.overlayPointer, 'none');
  assert.equal(cleared.frameDisplay, 'none');
  assert.equal(cleared.hit, 'section');
  assert.equal(cleared.active, 'false');

  await page.mouse.click(1200, 650);
  const clicked = await snapshot(page);
  assert.equal(clicked.log.stageClicks, 1, '点击应穿透到舞台');
  assert.equal(clicked.log.commits.length, 0, '穿透点击不产生提交');

  /* 选中整块舞台 → 框与舞台 rect 对齐（≤1px） */
  const aligned = await page.evaluate(() => {
    window.__selection = { at: '#card-a', box: { x: 0, y: 0, w: 1280, h: 720 } };
    window.__gesture.refresh();
    return { frame: window.__gesture.getFrameClientRect(), stage: window.__stageEl.getBoundingClientRect().toJSON() };
  });
  const dx = Math.abs(aligned.frame.x - aligned.stage.x);
  const dy = Math.abs(aligned.frame.y - aligned.stage.y);
  const dw = Math.abs(aligned.frame.w - aligned.stage.width);
  const dh = Math.abs(aligned.frame.h - aligned.stage.height);
  assert.ok(Math.max(dx, dy, dw, dh) <= 1, `对齐误差 ${JSON.stringify({ dx, dy, dw, dh })}`);

  evidence.cases['S17-A6'] = {
    ok: true,
    cleared,
    stageClicks: clicked.log.stageClicks,
    aligned: { dx, dy, dw, dh, frame: aligned.frame, stage: aligned.stage,
      pointer: { overlay: clicked.overlayPointer, frame: clicked.framePointer } }
  };
  await handle.dispose();
});

/* ── A7 ─────────────────────────────────────────────────────────────────── */

test('S17-A7 截图 2 张（真实场景：选中框 / 拖拽中）', async () => {
  const project = await makeProject('s17-a7');
  const { handle, page, mounted } = await openScene(project);

  /* 真实场景（scene-a.html）里的文字必须真的画出来了（不是纯色块） */
  const sceneText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 120));
  assert.ok(sceneText.includes('图层编辑测试'), `场景文字：${sceneText}`);
  assert.deepEqual(mounted.state.box, { x: 80, y: 85, w: 1000, h: 540 });

  const selectionPath = path.join(EVIDENCE_DIR, 's17-a7-selection.png');
  await page.screenshot({ path: selectionPath, clip: { x: 0, y: 0, width: STAGE_W, height: STAGE_H } });

  /* 拖拽中：按住不放，移动后截图，再松手 */
  const box = mounted.state.box;
  const from = { x: box.x + 200, y: box.y + 120 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 60, from.y + 40, { steps: 8 });
  const mid = await snapshot(page);
  assert.equal(mid.state.mode, 'move');
  assert.ok(mid.log.previews > 0);
  assert.equal(mid.log.commits.length, 0, '还没松手不应提交');
  assert.ok(Math.abs(mid.frame.x - (box.x + 60)) <= 1, `拖拽中框应已 +60：${mid.frame.x}`);
  const draggingPath = path.join(EVIDENCE_DIR, 's17-a7-dragging.png');
  await page.screenshot({ path: draggingPath, clip: { x: 0, y: 0, width: STAGE_W, height: STAGE_H } });
  await page.mouse.up();
  const done = await snapshot(page);
  assert.equal(done.log.commits.length, 1);
  assert.deepEqual(done.log.commits[0].value, { x: box.x + 60, y: box.y + 40, w: box.w, h: box.h });

  const [statSel, statDrag] = [await fs.stat(selectionPath), await fs.stat(draggingPath)];
  assert.ok(statSel.size > 10240, `选中框截图应 >10KB：${statSel.size}`);
  assert.ok(statDrag.size > 10240, `拖拽截图应 >10KB：${statDrag.size}`);

  evidence.cases['S17-A7'] = {
    ok: true,
    scene: 'scene-a.html（原生 DOM，无 iframe）',
    sceneText,
    selectionBox: box,
    previewsMidDrag: mid.log.previews,
    midFrame: mid.frame,
    op: done.log.commits[0],
    files: [
      { name: 's17-a7-selection.png', bytes: statSel.size },
      { name: 's17-a7-dragging.png', bytes: statDrag.size }
    ]
  };
  await handle.dispose();
});
