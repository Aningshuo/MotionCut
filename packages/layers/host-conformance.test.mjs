// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S22-HOST-CONFORMANCE 验收 A1..A5
 *
 * 目的：让「接了但没接全」在 5 秒内暴露，而不是等到合进真工作台被用户发现（R8/R9/R10 三次同型）。
 *
 * - A1 `HOST_CONTRACT` 条目数 == `canvas-gesture.mjs` 里真实出现的 `opts.*` 数量（脚本对比）
 * - A2 `createMinimalHost()`（只有 R9 那 6 个键）→ 恰好 5 项能力丢失 + 6 条基础用例全过
 * - A3 `createFullHost()`（17 个键全给）→ ok:true，基础 6 条 + 4 条能力用例全过
 * - A4 full 里删掉 onCommitMany → 多选报 NO_BATCH_COMMITTER（和 fallback 声明一致，不静默）
 * - A5 文件头那 3 行示例可复制运行（真跑一遍贴输出）
 *
 * 同一套用例（base6 + cap4）跑两个 fixture，断言降级行为与 `fallback` 声明**完全一致**。
 *
 * 运行：node --test --test-concurrency=1 packages/layers/host-conformance.test.mjs（env 由 test-env.mjs 自动准备；`OPENCUT_ENV_JSON` 可显式覆盖）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { build as esbuild } from 'esbuild';
import { SceneHost, REPO_ROOT } from '../scene-runtime/host.mjs';
import { startStudio } from '../studio/server/studio-server.mjs';
import { HOST_CONTRACT, checkHost, createMinimalHost, createFullHost } from './host-contract.mjs';
import { resolveLayerTestEnv } from './test-env.mjs';

const TEST_ENV = await resolveLayerTestEnv({ suite: 'host-conformance' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');
const PROJECTS = path.join(RUN_ROOT, 'projects');
const BUNDLE_ABS = path.join(RUN_ROOT, 'tmp/s22/gesture.mjs');
const BUNDLE_URL = '/' + path.relative(REPO_ROOT, BUNDLE_ABS).split(path.sep).join('/');

const STAGE_W = 1280;
const STAGE_H = 720;

const BOXES = {
  a: { x: 100, y: 80, w: 300, h: 120 },
  b: { x: 520, y: 80, w: 240, h: 120 },
  c: { x: 100, y: 420, w: 400, h: 100 },
  d: { x: 800, y: 520, w: 120, h: 90 }
};

/** 派单点名的 5 项能力 + S97 的 click-through（minimal 宿主应当恰好丢这 6 项）。 */
const EXPECTED_LOST = ['multiselect', 'snap-to-layers', 'hide-layers', 'hover-outline', 'batch-commit', 'click-through'];

const SCENE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;background:#fdf6e3}
.t{font:20px/1.4 "PingFang SC",Arial;color:#123;padding:10px}
</style></head><body><div class="t">契约套件 · 真实文字</div></body></html>`;

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
  batch: 'B-SUB1-R11-011',
  suite: 'host-conformance.test.mjs',
  cases: {},
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
      contents: "export * from './packages/layers/canvas-gesture.mjs';",
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
  await fs.writeFile(path.join(EVIDENCE_DIR, 's22-host-conformance.json'), JSON.stringify(evidence, null, 2) + '\n');
}

before(async () => {
  const env = JSON.parse(await fs.readFile(path.join(RUN_ROOT, 'env.json'), 'utf8'));
  evidence.batch = env.batchId ?? evidence.batch;
  await buildBundle();
  host = await new SceneHost({ port: Number(env.studioPort), viewport: { width: 1440, height: 900 } }).start();
  studio = await startStudio({ port: 0, vitePort: host.http.port, logger: () => {} });
  evidence.studio = { port: studio.port, url: studio.url, browser: host.browserVersion };
});

after(async () => {
  await save();
  if (studio) await studio.close();
  if (host) await host.stop();
});

async function makeProject(name) {
  const dir = path.join(PROJECTS, `${name}-${process.pid}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'scene.html'), SCENE_HTML);
  await fs.writeFile(path.join(dir, 'film.html'), FILM_HTML);
  const res = await fetch(`${studio.url}/api/projects/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dir })
  });
  const text = await res.text();
  assert.equal(res.status, 200, `open 失败：${text}`);
  const json = JSON.parse(text);
  return { dir, projectId: json.project.projectId, filmPath: path.join(dir, 'film.html') };
}

/**
 * 页内宿主：**键集合由 fixture 决定**（deps.keys），实现换成真的 DOM 版本。
 * 这样 minimal/full 的差别是「有没有这个键」，而不是「函数是不是空壳」。
 */
async function mountLive(deps) {
  const mod = await import(deps.bundle);
  const stageEl = document.querySelector(deps.stageSelector);
  const all = deps.layers.map((layer) => ({ ...layer, rect: { ...layer.box } }));
  const byAt = new Map(all.map((layer) => [layer.at, layer]));
  const log = { previews: [], commits: [], batches: [], cancels: 0, errors: [], selections: [] };
  window.__log = log;
  window.__hidden = new Set();
  window.__selected = deps.selected.map((at) => byAt.get(at)).filter(Boolean);
  window.__select = (ats) => {
    window.__selected = ats.map((at) => byAt.get(at)).filter(Boolean);
    controller.refresh();
    return window.__gesture.getState().count;
  };

  const applyBox = (layer, box) => {
    layer.rect = { x: box.x, y: box.y, w: box.w, h: box.h };
    const el = document.querySelector(layer.at);
    if (!el) return;
    el.style.left = `${box.x}px`;
    el.style.top = `${box.y}px`;
    el.style.width = `${box.w}px`;
    el.style.height = `${box.h}px`;
  };

  const readStage = () => {
    const r = stageEl.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, scale: r.width / deps.stageSize.w || 1 };
  };

  const layerOfOp = (op) => (op && op.clip ? all.find((layer) => layer.clip === op.clip) ?? null : window.__selected[0] ?? null);

  /** @type {any} */
  let controller = null;
  const impl = {
    getStageRect: readStage,
    getSelection: () => window.__selected[0] ?? null,
    getSelectionSet: () => window.__selected,
    getLayerRects: () => all,
    getSnapTargets: () => all.map((layer) => ({ at: layer.at, ...layer.box })),
    isHidden: (at) => window.__hidden.has(at),
    getHighlightRect: (at) => {
      const layer = byAt.get(at);
      return layer ? { ...layer.rect } : null;
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
    onError: (info) => log.errors.push(info),
    onCancel: () => {
      log.cancels += 1;
      for (const layer of all) applyBox(layer, layer.box);
      controller.refresh();
    },
    stageSize: { w: deps.stageSize.w, h: deps.stageSize.h },
    minSize: 8,
    accent: '#3b82f6',
    guideColor: '#f43f5e'
  };

  /** 只把 fixture 里有的键交给模块（缺的键就是没接） */
  const opts = {};
  for (const key of deps.keys) {
    if (key in impl) opts[key] = impl[key];
  }

  controller = mod.mountCanvasGesture(document.body, opts);

  const forward = (frameEl) => {
    try {
      const frameDoc = frameEl.contentDocument;
      if (!frameDoc || frameDoc.__r11c) return;
      frameDoc.__r11c = true;
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
      /* 跨源忽略 */
    }
  };
  for (const frameEl of document.querySelectorAll('iframe')) {
    forward(frameEl);
    frameEl.addEventListener('load', () => forward(frameEl));
  }

  window.__gesture = controller;
  window.__all = all;
  window.__byAt = byAt;
  window.__checkInPage = mod.checkHost(opts);
  return { stage: readStage(), state: controller.getState(), keys: deps.keys };
}

async function openWith(keys, name, selected = ['#a']) {
  const project = await makeProject(name);
  const filmRel = path.relative(REPO_ROOT, project.filmPath).split(path.sep).join('/');
  const handle = await host.open(filmRel);
  const page = handle.page;
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  const mounted = await page.evaluate(mountLive, {
    bundle: BUNDLE_URL,
    stageSelector: 'section:first-of-type',
    stageSize: { w: STAGE_W, h: STAGE_H },
    layers: Object.entries(BOXES).map(([id, box]) => ({ at: `#${id}`, box, clip: id })),
    selected,
    keys
  });
  return { handle, page, mounted, project, pageErrors };
}

async function drag(page, from, to, opts = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: opts.steps ?? 8 });
  if (typeof opts.beforeUp === 'function') await opts.beforeUp();
  await page.mouse.up();
}

function snap(page) {
  return page.evaluate(() => ({
    state: window.__gesture.getState(),
    active: document.querySelector('[data-canvas-gesture]').getAttribute('data-gesture-active'),
    log: {
      previews: window.__log.previews.length,
      commits: window.__log.commits,
      batches: window.__log.batches,
      cancels: window.__log.cancels,
      errors: window.__log.errors
    },
    frameDisplay: getComputedStyle(document.querySelector('[data-gesture-frame]')).display,
    highlightDisplay: getComputedStyle(document.querySelector('[data-gesture-highlight]')).display,
    guides: [...document.querySelectorAll('[data-gesture-guide]')]
      .filter((el) => getComputedStyle(el).display !== 'none')
      .map((el) => ({ axis: el.getAttribute('data-gesture-guide'), left: el.style.left, top: el.style.top }))
  }));
}

function boxOf(page, at) {
  return page.evaluate((key) => {
    const layer = window.__byAt.get(key);
    return layer ? { ...layer.box } : null;
  }, at);
}

/** 6 条基础用例：只依赖 R9 那 6 个键（minimal 也必须全过）。 */
async function runBaseCases(page) {
  const start = await snap(page);
  const select = (at) => page.evaluate((key) => window.__select([key]), at);

  /* 1) 移动 + 只提交一次 */
  await select('#a');
  await drag(page, { x: 200, y: 140 }, { x: 240, y: 165 });
  const moved = await snap(page);
  assert.equal(moved.log.commits.length, 1, `移动应提交一次：${JSON.stringify(moved.log.commits)}`);
  assert.deepEqual(moved.log.commits[0], { op: 'set', field: 'box', value: { x: 140, y: 105, w: 300, h: 120 }, clip: 'a' });

  /* 2) 拖动中只预览、松手才提交（previews ≥2，commits 不涨） */
  await select('#b');
  await page.mouse.move(600, 140);
  await page.mouse.down();
  await page.mouse.move(630, 140, { steps: 6 });
  const mid = await snap(page);
  await page.mouse.up();
  const afterPreview = await snap(page);
  assert.ok(mid.log.previews >= 2, `拖动中应有多次预览：${mid.log.previews}`);
  assert.equal(mid.log.commits.length, 1, '松手前不应有新提交');
  assert.equal(afterPreview.log.commits.length, 2, '松手应恰好再提交一次');
  assert.deepEqual(afterPreview.log.commits[1].value, { x: 550, y: 80, w: 240, h: 120 });

  /* 3) 缩放：se 手柄 +20/+10 */
  await drag(page, { x: 790, y: 200 }, { x: 810, y: 210 });
  const resized = await snap(page);
  assert.equal(resized.log.commits.length, 3);
  assert.deepEqual(resized.log.commits[2].value, { x: 550, y: 80, w: 260, h: 130 });

  /* 4) 旋转：30° → r=30、mode 归 null */
  await select('#c');
  await drag(page, { x: 300, y: 396 }, { x: 337, y: 406 }, { steps: 10 });
  const rotated = await snap(page);
  assert.equal(rotated.log.commits.length, 4, `旋转应提交一次：${JSON.stringify(rotated.log.commits[3] ?? null)}`);
  assert.equal(rotated.log.commits[3].value.r, 30);
  assert.equal(rotated.state.mode, null);
  assert.equal(rotated.active, 'false');

  /* 5) Esc 取消：0 提交、1 取消、框回原位 */
  const commitsBeforeEsc = rotated.log.commits.length;
  await select('#a');
  await drag(page, { x: 240, y: 165 }, { x: 300, y: 215 }, {
    beforeUp: async () => {
      await page.keyboard.press('Escape');
    }
  });
  const cancelled = await snap(page);
  assert.equal(cancelled.log.commits.length, commitsBeforeEsc, 'Esc 不应提交');
  assert.equal(cancelled.log.cancels, start.log.cancels + 1, 'Esc 应恰好取消一次');
  assert.deepEqual(await boxOf(page, '#a'), { x: 140, y: 105, w: 300, h: 120 });

  /* 6) 单击不拖 = 不提交 */
  await page.mouse.move(240, 165);
  await page.mouse.down();
  await page.mouse.up();
  const clicked = await snap(page);
  assert.equal(clicked.log.commits.length, commitsBeforeEsc, '单击不应提交');
  assert.equal(clicked.log.errors.length, 0, `不应报错：${JSON.stringify(clicked.log.errors)}`);

  return {
    commits: clicked.log.commits.length,
    previews: clicked.log.previews,
    cancels: clicked.log.cancels,
    rotatedR: rotated.log.commits[3].value.r,
    boxes: { a: await boxOf(page, '#a'), b: await boxOf(page, '#b'), c: await boxOf(page, '#c') }
  };
}

/* ── A1 契约条目数 == 实际用到的 opts.* 数量 ────────────────────────────── */

test('S22-A1 HOST_CONTRACT 覆盖全部 opts.*（脚本对比，不许漏）', async () => {
  const source = await fs.readFile(path.join(REPO_ROOT, 'packages/layers/canvas-gesture.mjs'), 'utf8');
  const used = [...new Set([...source.matchAll(/\bopts\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))].sort();
  const contracted = HOST_CONTRACT.map((entry) => entry.name).sort();

  const onlyUsed = used.filter((name) => !contracted.includes(name));
  const onlyContract = contracted.filter((name) => !used.includes(name));

  assert.deepEqual(onlyUsed, [], `模块用了但契约没写：${onlyUsed.join(', ')}`);
  assert.deepEqual(onlyContract, [], `契约写了但模块没用：${onlyContract.join(', ')}`);
  assert.equal(HOST_CONTRACT.length, used.length, `条目数应等于实际 opts.* 数量：${HOST_CONTRACT.length} vs ${used.length}`);

  /* 每条都要有可读的 capability/fallback */
  for (const entry of HOST_CONTRACT) {
    assert.ok(typeof entry.fallback === 'string' && entry.fallback.length > 8, `${entry.name} 缺 fallback`);
    assert.ok(typeof entry.name === 'string' && entry.name.length > 0);
    assert.ok(typeof entry.type === 'string' && entry.type.length > 0);
    assert.equal(typeof entry.required, 'boolean');
  }

  /* 硬缺也要能报出来：什么都没给 → 三个码各一条 */
  const emptyReport = checkHost();
  assert.equal(emptyReport.ok, false);
  assert.deepEqual(emptyReport.missing.map((item) => item.code).sort(), ['NO_COMMITTER', 'NO_SELECTION_SOURCE', 'NO_STAGE_RECT']);

  evidence.cases['S22-A1'] = {
    ok: true,
    contractEntries: HOST_CONTRACT.length,
    optsUsed: used.length,
    used,
    contractedOnly: onlyContract,
    emptyHostMissing: emptyReport.missing.map((item) => ({ name: item.name, code: item.code }))
  };
});

/* ── A2 minimal 宿主：恰好 6 项能力丢失 + 6 条基础用例全过 ───────────────── */

test('S22-A2 createMinimalHost：6 项能力丢失，基础手势不崩', async () => {
  const minimal = createMinimalHost();
  const report = checkHost(minimal);
  assert.equal(report.ok, true, `minimal 不应有硬缺：${JSON.stringify(report.missing)}`);
  assert.equal(report.degraded.length, 6, `minimal 应恰好丢 6 项能力：${JSON.stringify(report.lostCapabilities)}`);
  assert.deepEqual([...report.lostCapabilities].sort(), [...EXPECTED_LOST].sort());
  /* S25 加了 isLocked / getLayerOrder / keyboard；S37 minVisible；S38 grid；S40 hostSizeLabel（都落在 advisories）。
     S97 的 onClickThrough **不在这里**：它是能力（少了就点不到片段里的层），落在 degraded。 */
  assert.equal(report.advisories.length, 12, `其余可选键应在 advisories：${JSON.stringify(report.advisories.map((a) => a.name))}`);

  const { handle, page, mounted, pageErrors } = await openWith(Object.keys(minimal), 's22-a2');
  const base = await runBaseCases(page);

  /* 降级行为必须与 fallback 声明一致 */
  const degrade = {};

  /* multiselect 缺失 → 选择只能是单选（SINGLE_SELECTION_ONLY） */
  degrade.selection = await page.evaluate(() => {
    /* 宿主把两层都设成选中：没 getSelectionSet 时模块只能读到单选 */
    const kept = window.__select(['#a', '#b']);
    return { kept, count: window.__gesture.getState().count };
  });
  assert.equal(degrade.selection.count, 1, `没 getSelectionSet 时选择只能是单选：${JSON.stringify(degrade.selection)}`);

  /* snap-to-layers 缺失 → 拖到离 #c 中线 5px 也不吸附、不画参考线 */
  await page.evaluate(() => window.__select(['#d']));
  await drag(page, { x: 860, y: 565 }, { x: 305, y: 565 }, { steps: 12 });
  const snappedMin = await snap(page);
  const dragBoxMin = await boxOf(page, '#d');
  assert.equal(dragBoxMin.x, 245, `无层吸附时应落在 245（不被拉走）：${JSON.stringify(dragBoxMin)}`);
  assert.deepEqual(snappedMin.guides, [], `无层吸附时不应有参考线：${JSON.stringify(snappedMin.guides)}`);
  degrade.snap = { x: dragBoxMin.x, guides: snappedMin.guides };

  /* hover-outline 缺失 → setHighlight 是空操作 */
  await page.evaluate(() => window.__gesture.setHighlight('#a'));
  const hoverMin = await snap(page);
  assert.equal(hoverMin.highlightDisplay, 'none', '没有 getHighlightRect 就不该画悬停描边');
  degrade.hover = hoverMin.highlightDisplay;

  /* hide-layers 缺失 → 宿主说隐藏也照画 */
  await page.evaluate(() => {
    window.__hidden.add('#a');
    window.__select(['#a']);
  });
  const hiddenMin = await snap(page);
  assert.equal(hiddenMin.frameDisplay, 'block', '没有 isHidden 时隐藏不生效（照画）');
  degrade.hidden = hiddenMin.frameDisplay;

  assert.deepEqual(pageErrors, [], `不应有 pageerror：${pageErrors}`);

  evidence.cases['S22-A2'] = {
    ok: true,
    inPageCheck: await page.evaluate(() => window.__checkInPage.degraded.map((d) => `${d.capability} → ${d.code}`)),
    hostKeys: Object.keys(minimal),
    missing: report.missing,
    degraded: report.degraded.map((item) => ({ name: item.name, capability: item.capability, code: item.code })),
    advisories: report.advisories.map((item) => item.name),
    base,
    degrade
  };
  await handle.dispose();
});

/* ── A3 full 宿主：ok + 基础 6 条 + 4 条能力用例 ────────────────────────── */

test('S22-A3 createFullHost：ok:true，能力用例全过', async () => {
  const full = createFullHost();
  const report = checkHost(full);
  assert.equal(report.ok, true);
  assert.equal(report.degraded.length, 0, `full 不该有降级：${JSON.stringify(report.degraded)}`);
  assert.equal(report.advisories.length, 0);
  /* 7 项 = 多选/层吸附/隐藏/悬停/批量提交/舞台边吸附 + S97 的 click-through */
  assert.equal(report.capabilities.length, 7, `能力应齐全：${JSON.stringify(report.capabilities)}`);

  const { handle, page, mounted, pageErrors } = await openWith(Object.keys(full), 's22-a3');
  const base = await runBaseCases(page);
  const caps = {};

  /* 多选：两层一起拖 +10/+10 → 一批两条 op（一步撤销） */
  caps.multiselect = await page.evaluate(() => window.__select(['#a', '#b']));
  assert.equal(caps.multiselect, 2);
  await drag(page, { x: 200, y: 120 }, { x: 210, y: 130 });
  const multi = await snap(page);
  assert.equal(multi.log.batches.length, 1, `多选应走 onCommitMany 一次：${JSON.stringify(multi.log)}`);
  assert.equal(multi.log.batches[0].length, 2, `一批应有两条 op：${JSON.stringify(multi.log.batches[0])}`);

  /* 吸附到层：拖到离 #c 中线 5px → 吸到 300，x=240，画参考线 */
  await page.evaluate(() => window.__select(['#d']));
  await drag(page, { x: 860, y: 565 }, { x: 305, y: 565 }, {
    steps: 12,
    beforeUp: async () => {
      caps.snapMid = await snap(page);
    }
  });
  const snappedFull = await snap(page);
  const dragBoxFull = await boxOf(page, '#d');
  assert.equal(dragBoxFull.x, 240, `应吸到 #c 中线（x=240）：${JSON.stringify(dragBoxFull)}`);
  assert.ok(
    caps.snapMid.guides.some((g) => g.axis === 'x'),
    `吸附时应画竖参考线：${JSON.stringify(caps.snapMid.guides)}`
  );
  caps.snap = { x: dragBoxFull.x, guides: caps.snapMid.guides };

  /* 悬停描边 */
  await page.evaluate(() => window.__gesture.setHighlight('#a'));
  const hoverFull = await snap(page);
  assert.equal(hoverFull.highlightDisplay, 'block', '有 getHighlightRect 时应画描边');
  caps.hover = hoverFull.highlightDisplay;
  await page.evaluate(() => window.__gesture.setHighlight(null));

  /* 会话内隐藏：不再画框 */
  await page.evaluate(() => {
    window.__hidden.add('#a');
    window.__select(['#a']);
  });
  const hiddenFull = await snap(page);
  assert.equal(hiddenFull.frameDisplay, 'none', '有 isHidden 时隐藏的层不该画框');
  caps.hidden = hiddenFull.frameDisplay;

  assert.deepEqual(pageErrors, [], `不应有 pageerror：${pageErrors}`);

  evidence.cases['S22-A3'] = {
    ok: true,
    inPageCheck: await page.evaluate(() => ({ ok: window.__checkInPage.ok, degraded: window.__checkInPage.degraded.length })),
    hostKeys: Object.keys(full),
    base,
    caps: { ...caps, firstBatch: multi.log.batches[0] }
  };
  await handle.dispose();
});

/* ── A4 full 里删掉 onCommitMany → 多选必须报码 ─────────────────────────── */

test('S22-A4 删掉 onCommitMany → 多选报 NO_BATCH_COMMITTER（与声明一致）', async () => {
  const full = createFullHost();
  const degradedHost = { ...full };
  delete degradedHost.onCommitMany;

  const report = checkHost(degradedHost);
  const lost = report.degraded.find((item) => item.name === 'onCommitMany');
  assert.ok(lost, '删掉 onCommitMany 应出现在 degraded');
  assert.equal(lost.code, 'NO_BATCH_COMMITTER', `声明的码应是 NO_BATCH_COMMITTER：${lost.code}`);

  const { handle, page } = await openWith(Object.keys(degradedHost), 's22-a4');
  assert.equal(await page.evaluate(() => window.__select(['#a', '#b'])), 2);

  await drag(page, { x: 200, y: 120 }, { x: 220, y: 140 });
  const after = await snap(page);

  assert.equal(after.log.batches.length, 0, '没有 onCommitMany 就不该提交');
  assert.equal(after.log.commits.length, 0, '也不许拆成单条提交');
  assert.equal(after.state.error?.code, 'NO_BATCH_COMMITTER', `应报 NO_BATCH_COMMITTER：${JSON.stringify(after.state.error)}`);
  assert.equal(after.log.errors[0]?.code, 'NO_BATCH_COMMITTER', '有 onError 时应回调同一个码');
  assert.equal(after.state.mode, null, '手势仍应结束');

  evidence.cases['S22-A4'] = { ok: true, declared: lost, stateError: after.state.error, errors: after.log.errors, batches: after.log.batches.length };
  await handle.dispose();
});

/* ── A5 文件头示例可复制运行 ────────────────────────────────────────────── */

test('S22-A5 文件头示例可复制运行（真跑一遍）', async () => {
  const scriptPath = path.join(RUN_ROOT, 'tmp/s22/check-host-example.mjs');
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  const url = pathToFileURL(path.join(REPO_ROOT, 'packages/layers/host-contract.mjs')).href;
  const script = `/* 复制自 canvas-gesture.mjs 文件头「接宿主前先自检」 */
import { checkHost, createMinimalHost } from '${url}';
const opts = createMinimalHost();                 // 换成宿主真实的 opts
const report = checkHost(opts);
console.log(JSON.stringify({
  ok: report.ok,
  missing: report.missing,
  degraded: report.degraded.map((item) => item.capability + ' → ' + item.code),
  advisories: report.advisories.map((item) => item.name)
}, null, 2));
if (!report.ok) throw new Error(JSON.stringify(report.missing));
`;
  await fs.writeFile(scriptPath, script);

  const stdout = execFileSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.degraded.length, 6);
  assert.deepEqual([...parsed.degraded].sort(), [
    'batch-commit → NO_BATCH_COMMITTER',
    'click-through → NO_CLICK_THROUGH',
    'hide-layers → NO_HIDDEN_LAYERS',
    'hover-outline → NO_HOVER_OUTLINE',
    'multiselect → SINGLE_SELECTION_ONLY',
    'snap-to-layers → SNAP_STAGE_ONLY'
  ]);

  evidence.cases['S22-A5'] = { ok: true, script: path.relative(REPO_ROOT, scriptPath), stdout, parsed };
});
