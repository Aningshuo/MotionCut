// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S30-SCENE-500-TRACE 验收 B1..B4（R31 / S52 起判据改成「同页基线 + p95」）
 *
 * 500 层（`large-500.html`：65 容器 + 145 文字 + 145 图片 + 145 图形，最深 5 层）。
 * 宿主的 `getLayerRects` 每次现算 500 个 `getBoundingClientRect`（不缓存）。
 *
 * 四条数字走同一套口径，好跟 200 层那批直接比：
 * 1. 挂载：mountCanvasGesture + mountLayerTree → 首帧
 * 2. 选中：pointerdown → 读一次框的 rect（强制 layout）
 * 3. 拖动：按住框拖 **2 秒**（每帧一次 pointermove），rAF 间隔中位/p95；
 *    同时用 CDP `Performance.getMetrics` 取 Task/Layout/RecalcStyle/Script 的**增量**
 * 4. 树：mount / setLayers(500) / select() / 滚动；setLayers 再拆「建树 vs 建 DOM」两段
 *
 * ## 判据（R31 改）
 *
 * 与 `large-scene-perf.test.mjs` 同一套：`measuredP95 ≤ max(floor, baselineP95 × 4 + 2)`，
 * 基线是**同 fixture、同操作、250 层**（一半数据量）。`floor` 是产品预算，**不许改大**。
 * 采样 40 次（拖动是 2 秒窗口，≈120 帧），`p95` 进判据、`max` 只记账。
 * `OPENCUT_PERF_INJECT=1` 注入忙等，判据必须红并打印三行数字。
 *
 * 环境说明：headless Chromium + `--use-angle=swiftshader`（软件光栅），
 * 所以 Layout/RecalcStyle 是真实主线程成本，**但合成/绘制不是真 GPU 的帧时间**。
 *
 * 运行：node --test --test-concurrency=1 packages/layers/large-scene-500.test.mjs
 *      （`OPENCUT_PERF_LABEL` 决定证据文件名；env 由 test-env.mjs 自动准备，`OPENCUT_ENV_JSON` 可显式覆盖）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { build as esbuild } from 'esbuild';
import { SceneHost, REPO_ROOT } from '../scene-runtime/host.mjs';
import { resolveLayerTestEnv } from './test-env.mjs';
import { judgeAgainstBaseline, summarize } from './perf-budget.mjs';
import { registerCleanupProbe } from './test-inject.mjs';

const TEST_ENV = await resolveLayerTestEnv({ suite: 'large-scene-500' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');
const BUNDLE_ABS = path.join(RUN_ROOT, 'tmp/s30/bundle.mjs');
const BUNDLE_URL = '/' + path.relative(REPO_ROOT, BUNDLE_ABS).split(path.sep).join('/');
const FIXTURE = 'tests/fixtures/scenes/large-500.html';
const LABEL = process.env.OPENCUT_PERF_LABEL ?? 'after';
const BATCH = 'B-SUB1-R15-015';
/** 采样数：p95 至少 40 个样本。 */
const SAMPLES = 40;
const DRAG_WINDOW_MS = 2000;
/** 基线用前 250 层（500 的一半）：同 fixture、同操作、一半数据量。 */
const BASELINE_LAYERS = 250;
const INJECT = process.env.OPENCUT_PERF_INJECT === '1';
const INJECT_SAMPLES = 6;

/** 产品预算（floor）。**这是上限，不许改大**（A4 的 grep 只该剩下这一行）：
 *  mountMs ≤ 500、selectMs ≤ 50、dragP95Ms ≤ 20、treeRenderMs ≤ 100。 */
const FLOORS = { mountMs: 500, selectMs: 50, dragP95Ms: 20, treeRenderMs: 100 };
const FACTORS = { mount: 4, select: 4, drag: 4, tree: 4 };
const SLACK_MS = 2;
/** 注入量：要压过 baseline×4，不能只压过 floor（细则见 large-scene-perf 的注释）。 */
const INJECT_MS = { mountMs: 2000, selectMs: 400, dragP95Ms: 400, treeRenderMs: 800 };

const RUN_SAMPLES = INJECT ? INJECT_SAMPLES : SAMPLES;
/* 拖动窗口固定 2 秒：注入时每帧多 400ms，帧数会掉到个位数——这是**预期**的，
   注入只用来证「判据会红」，不是量 p95 的样本量。 */
const RUN_WINDOW_MS = DRAG_WINDOW_MS;

const evidence = {
  batch: BATCH,
  suite: 'large-scene-500.test.mjs',
  label: LABEL,
  samples: RUN_SAMPLES,
  inject: INJECT,
  floors: FLOORS,
  factors: FACTORS,
  slackMs: SLACK_MS,
  baselineLayers: BASELINE_LAYERS,
  fixture: null,
  metrics: {},
  judges: {},
  cdp: null,
  tree: null,
  cases: {},
  screenshots: [],
  startedAt: new Date().toISOString()
};

/** @type {SceneHost} */
let host;

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const round2 = (n) => Math.round(n * 100) / 100;

/** 把一条量测的 p95 与基线一起过判据，并把结论打到 stdout（注入时那三行就是证据）。 */
function judge(id, measured, baseline, floor, factor) {
  const result = judgeAgainstBaseline({
    measuredP95: measured.p95,
    baselineP95: baseline.p95,
    floor,
    factor,
    slack: SLACK_MS
  });
  process.stdout.write(`JUDGE ${id} measured=${result.measuredP95} baseline=${result.baselineP95} budget=${result.budget} pass=${result.pass} | ${result.formula}\n`);
  evidence.judges[id] = { ...result, samples: measured.n, max: measured.max };
  return result;
}

/** @param {number[]} values */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** @param {number[]} values @param {number} p */
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

async function buildBundle() {
  await fs.mkdir(path.dirname(BUNDLE_ABS), { recursive: true });
  await esbuild({
    stdin: {
      contents: [
        "export { mountCanvasGesture } from './packages/layers/canvas-gesture.mjs';",
        "export { mountLayerTree, buildLayerTree } from './packages/layers/layer-tree.mjs';"
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
  for (const name of ['s30-a1-large.png', 's30-a4-selected.png']) {
    try {
      const buf = await fs.readFile(path.join(EVIDENCE_DIR, name));
      files.push({ name, bytes: buf.length, sha256: sha(buf) });
    } catch {
      files.push({ name, bytes: 0, sha256: null, missing: true });
    }
  }
  evidence.screenshots = files;
  evidence.finishedAt = new Date().toISOString();
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(path.join(EVIDENCE_DIR, `s30-perf-${LABEL}.json`), JSON.stringify(evidence, null, 2) + '\n');
}

before(async () => {
  const env = JSON.parse(await fs.readFile(path.join(RUN_ROOT, 'env.json'), 'utf8'));
  evidence.batch = env.batchId ?? evidence.batch;
  await buildBundle();
  host = await new SceneHost({ port: Number(env.sceneOrigin || env.studioPort), viewport: { width: 1720, height: 1040 } }).start();
  evidence.browser = host.browserVersion;
});

after(async () => {
  await save();
  if (host) await host.stop();
});

async function openPage() {
  const handle = await host.open(FIXTURE);
  const page = handle.page;
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(`console.error: ${msg.text()}`);
  });
  return { handle, page, pageErrors };
}

async function installBench(page) {
  return page.evaluate(async (bundle) => {
    const mod = await import(bundle);
    window.__mod = mod;

    /* 受控时钟把 performance.now 变成虚拟时间（恒 0），量测取原型上的真实时钟 */
    const realNow = Performance.prototype.now;
    window.__now = () => realNow.call(performance);
    const raf = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    const stage = document.getElementById('stage');
    const elements = [...stage.querySelectorAll('[data-at]')];
    const atOf = (el) => '#' + el.id;
    const depthOf = (el) => {
      let depth = 1;
      let parent = el.parentElement;
      while (parent) {
        if (parent.hasAttribute && parent.hasAttribute('data-at')) depth += 1;
        parent = parent.parentElement;
      }
      return depth;
    };
    const parentOf = (el) => {
      const parent = el.parentElement;
      const hit = parent && typeof parent.closest === 'function' ? parent.closest('[data-at]') : null;
      return hit ? atOf(hit) : null;
    };

    const layerList = elements.map((el) => ({
      at: atOf(el),
      kind: el.getAttribute('data-kind') ?? 'unknown',
      name: el.getAttribute('data-name') ?? atOf(el),
      depth: depthOf(el),
      parentAt: parentOf(el),
      el
    }));
    const treeLayers = layerList.map(({ at, kind, name, depth, parentAt }) => ({ at, kind, name, depth, parentAt }));

    window.__rectReads = 0;
    const rawRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      window.__rectReads += 1;
      return rawRect.call(this);
    };

    const stageRect = () => {
      const r = stage.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, scale: 1 };
    };
    const rectsOf = () => {
      const s = stageRect();
      const out = [];
      for (const item of layerList) {
        const b = item.el.getBoundingClientRect();
        const box = { x: b.x - s.x, y: b.y - s.y, w: b.width, h: b.height };
        out.push({ at: item.at, box, rect: box, clip: item.at.slice(1), locked: false });
      }
      return out;
    };
    window.__calls = { rects: 0, commit: 0 };
    const countingRects = () => {
      window.__calls.rects += 1;
      return rectsOf();
    };

    function benchHost() {
      const box = document.getElementById('bench');
      box.textContent = '';
      const gestureBox = document.createElement('div');
      gestureBox.id = 'bench-gesture';
      const treeBox = document.createElement('div');
      treeBox.id = 'bench-tree';
      treeBox.style.cssText = 'height:900px;overflow:auto;background:#0f1729;color:#e5e7eb';
      box.appendChild(gestureBox);
      box.appendChild(treeBox);
      return { gestureBox, treeBox };
    }

    /** 忙等（注入对照用）。`window.__now` 是原型上的真实时钟。 */
    const busy = (ms) => {
      if (!(ms > 0)) return;
      const end = window.__now() + ms;
      while (window.__now() < end) {
        /* spin */
      }
    };

    /** 只算前 `limit` 层的 rect：基线（250 层）与正式量测（500 层）走同一段代码。 */
    function rectsLimited(limit) {
      const s = stageRect();
      const out = [];
      for (const item of layerList.slice(0, limit)) {
        const b = item.el.getBoundingClientRect();
        const box = { x: b.x - s.x, y: b.y - s.y, w: b.width, h: b.height };
        out.push({ at: item.at, box, rect: box, clip: item.at.slice(1), locked: false });
      }
      return out;
    }

    function mountGesture(box, limit) {
      window.__sel = null;
      return mod.mountCanvasGesture(box, {
        getStageRect: stageRect,
        getSelection: () => window.__sel,
        getLayerRects: () => {
          window.__calls.rects += 1;
          return rectsLimited(limit);
        },
        getSnapTargets: () => [],
        onSelectionChange: (ats) => {
          window.__sel = ats.length ? layerList.find((item) => item.at === ats[0]) ?? null : null;
        },
        onCommit: () => {
          window.__calls.commit += 1;
        }
      });
    }
    const mountTree = (box, limit) => mod.mountLayerTree(box, { layers: treeLayers.slice(0, limit) });

    window.__bench = {
      info: {
        layers: elements.length,
        maxDepth: Math.max(...layerList.map((item) => item.depth)),
        kinds: JSON.parse(stage.getAttribute('data-kinds') ?? '{}'),
        treeDepth: (() => {
          const built = mod.buildLayerTree(treeLayers);
          return Math.max(...built.nodes.map((node) => node.depth));
        })()
      },
      raf,

      async measureMount(limit, samples, injectMs) {
        const out = [];
        for (let i = 0; i < samples; i += 1) {
          const { gestureBox, treeBox } = benchHost();
          const t0 = window.__now();
          busy(injectMs);
          const gesture = mountGesture(gestureBox, limit);
          const tree = mountTree(treeBox, limit);
          await raf();
          out.push(window.__now() - t0);
          gesture.destroy();
          tree.destroy();
        }
        return out;
      },

      async measureClick(limit, index, samples, injectMs) {
        const { gestureBox } = benchHost();
        const gesture = mountGesture(gestureBox, limit);
        await raf();
        const target = layerList[Math.min(index ?? 300, limit - 1)];
        const out = [];
        for (let i = 0; i < samples; i += 1) {
          const b = target.el.getBoundingClientRect();
          const cx = b.x + b.width / 2;
          const cy = b.y + b.height / 2;
          const readsBefore = window.__rectReads;
          const t0 = window.__now();
          busy(injectMs);
          target.el.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, pointerId: 1 })
          );
          const frame = document.querySelector('[data-gesture-frame]');
          if (frame) frame.getBoundingClientRect();
          const t1 = window.__now();
          out.push({ ms: t1 - t0, rectReads: window.__rectReads - readsBefore, at: gesture.getState().at, display: frame ? frame.style.display : 'none' });
          document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: cx, clientY: cy, button: 0, pointerId: 1 }));
        }
        gesture.destroy();
        return { samples: out, hitAt: out[0]?.at ?? null, targetAt: target.at };
      },

      /** 拖动窗口：每帧一次 pointermove，返回 rAF 间隔与帧数 */
      async dragWindow(limit, index, windowMs, injectMs) {
        const { gestureBox } = benchHost();
        const gesture = mountGesture(gestureBox, limit);
        await raf();
        const target = layerList[Math.min(index ?? 300, limit - 1)];
        const b = target.el.getBoundingClientRect();
        const cx = b.x + b.width / 2;
        const cy = b.y + b.height / 2;
        target.el.dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, pointerId: 1 })
        );
        document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: cx, clientY: cy, button: 0, pointerId: 1 }));
        await raf();

        const frame = document.querySelector('[data-gesture-frame]');
        const fr = frame.getBoundingClientRect();
        const sx = fr.x + fr.width / 2;
        const sy = fr.y + fr.height / 2;
        frame.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: sx, clientY: sy, button: 0, pointerId: 1 }));

        /* 暖机 6 帧（首帧含 500 层首绘），不计入 */
        for (let i = 0; i < 6; i += 1) {
          await raf();
          document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: sx + i, clientY: sy, pointerId: 1 }));
        }
        const intervals = [];
        const handlerMs = [];
        let frames = 0;
        let last = window.__now();
        const start = last;
        while (window.__now() - start < windowMs) {
          await raf();
          const t = window.__now();
          intervals.push(t - last);
          last = t;
          const dx = ((frames % 20) - 10) * 1.5;
          const t0 = window.__now();
          busy(injectMs);
          document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: sx + dx, clientY: sy, pointerId: 1 }));
          handlerMs.push(window.__now() - t0);
          frames += 1;
        }
        document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: sx, clientY: sy, button: 0, pointerId: 1 }));
        const commits = window.__calls.commit;
        gesture.destroy();
        return { frames, intervals, handlerMs, commits, targetAt: target.at };
      },

      async measureTree(limit, samples, injectMs) {
        const mountSamples = [];
        for (let i = 0; i < samples; i += 1) {
          const { treeBox: tb } = benchHost();
          const t0 = window.__now();
          busy(injectMs);
          const tree = mountTree(tb, limit);
          await raf();
          mountSamples.push(window.__now() - t0);
          tree.destroy();
        }

        const { treeBox } = benchHost();
        const tree = mountTree(treeBox, limit);

        /* 拆开量：render（建 4000 节点 + append）与随后的强制 layout 分开记账 */
        const setLayersSamples = [];
        const layoutSamples = [];
        for (let i = 0; i < 5; i += 1) {
          const a = window.__now();
          tree.setLayers(treeLayers.slice(0, limit));
          const b = window.__now();
          treeBox.getBoundingClientRect();
          const c = window.__now();
          setLayersSamples.push(b - a);
          layoutSamples.push(c - b);
        }
        const rows = treeBox.querySelectorAll('[data-layer-row]').length;

        /* 同一把尺子量 200 行：用来解释「2.5→5.5ms」到底是哪一段 */
        const setLayers200 = [];
        const layout200 = [];
        for (let i = 0; i < 5; i += 1) {
          const a = window.__now();
          tree.setLayers(treeLayers.slice(0, 200));
          const b = window.__now();
          treeBox.getBoundingClientRect();
          const c = window.__now();
          setLayers200.push(b - a);
          layout200.push(c - b);
        }

        /* 归因：只建树（纯函数，同一份输入） */
        const buildSamples = [];
        for (let i = 0; i < 5; i += 1) {
          const a = window.__now();
          const built = mod.buildLayerTree(treeLayers.slice(0, limit));
          buildSamples.push({ ms: window.__now() - a, nodes: built.nodes.length });
        }

        const selectSamples = [];
        for (let i = 0; i < 5; i += 1) {
          const a = window.__now();
          tree.select(treeLayers[Math.min(300 + i, limit - 1)].at);
          treeBox.getBoundingClientRect();
          selectSamples.push(window.__now() - a);
        }

        const scrollSamples = [];
        for (let i = 0; i < 12; i += 1) {
          const a = window.__now();
          treeBox.scrollTop = i * 60;
          treeBox.getBoundingClientRect();
          scrollSamples.push(window.__now() - a);
        }
        const selected = tree.getState().selectedAt;
        tree.destroy();
        return { mountSamples, setLayersSamples, layoutSamples, setLayers200, layout200, buildSamples, selectSamples, scrollSamples, rows, selected };
      },

      /** 截图用：挂好手势 + 树，选中一层，返回框与元素的 client rect 供逐像素核对 */
      async paintForShot(index) {
        const { gestureBox, treeBox } = benchHost();
        const gesture = mountGesture(gestureBox, layerList.length);
        const tree = mountTree(treeBox, layerList.length);
        await raf();
        const target = layerList[index ?? 300];
        const b = target.el.getBoundingClientRect();
        target.el.dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: b.x + b.width / 2, clientY: b.y + b.height / 2, button: 0, pointerId: 1 })
        );
        document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: b.x + b.width / 2, clientY: b.y + b.height / 2, button: 0, pointerId: 1 }));
        const hitAt = gesture.getState().at;
        if (hitAt) tree.select(hitAt);
        await raf();
        const frame = document.querySelector('[data-gesture-frame]').getBoundingClientRect();
        const el = document.querySelector(hitAt).getBoundingClientRect();
        return {
          at: hitAt,
          treeSelected: tree.getState().selectedAt,
          rows: treeBox.querySelectorAll('[data-layer-row]').length,
          frame: { x: frame.x, y: frame.y, w: frame.width, h: frame.height },
          el: { x: el.x, y: el.y, w: el.width, h: el.height }
        };
      }
    };

    return window.__bench.info;
  }, BUNDLE_URL);
}

/* ── B1 500 层四项数字 ───────────────────────────────────────────── */

test('B1 500 层：挂载 / 选中 / 拖动 p95 / 树 500 行（判据 = max(floor, 250 层基线×4+2)）', async () => {
  const { page, pageErrors } = await openPage();
  const info = await installBench(page);

  const dom = await page.evaluate(() => {
    const stage = document.getElementById('stage');
    const els = [...stage.querySelectorAll('[data-at]')];
    return {
      count: els.length,
      unique: new Set(els.map((el) => '#' + el.id)).size,
      declaredCount: stage.getAttribute('data-layer-count'),
      declaredDepth: stage.getAttribute('data-max-depth'),
      kinds: JSON.parse(stage.getAttribute('data-kinds') ?? '{}')
    };
  });
  assert.equal(dom.count, 500, `DOM 里应有 500 层，实际 ${dom.count}`);
  assert.equal(dom.unique, 500);
  assert.equal(dom.declaredDepth, '5');
  assert.equal(info.treeDepth, 5);
  assert.equal(info.layers, 500);

  const mount = await page.evaluate((args) => window.__bench.measureMount(...args), [500, RUN_SAMPLES, INJECT ? INJECT_MS.mountMs : 0]);
  const mountBase = await page.evaluate((args) => window.__bench.measureMount(...args), [BASELINE_LAYERS, RUN_SAMPLES, 0]);
  const click = await page.evaluate((args) => window.__bench.measureClick(...args), [500, 300, RUN_SAMPLES, INJECT ? INJECT_MS.selectMs : 0]);
  const clickBase = await page.evaluate((args) => window.__bench.measureClick(...args), [BASELINE_LAYERS, 150, RUN_SAMPLES, 0]);
  const drag = await page.evaluate((args) => window.__bench.dragWindow(...args), [500, 300, RUN_WINDOW_MS, INJECT ? INJECT_MS.dragP95Ms : 0]);
  const dragBase = await page.evaluate((args) => window.__bench.dragWindow(...args), [BASELINE_LAYERS, 150, RUN_WINDOW_MS, 0]);
  const tree = await page.evaluate((args) => window.__bench.measureTree(...args), [500, RUN_SAMPLES, INJECT ? INJECT_MS.treeRenderMs : 0]);
  const treeBase = await page.evaluate((args) => window.__bench.measureTree(...args), [BASELINE_LAYERS, RUN_SAMPLES, 0]);

  const stats = {
    mount: summarize(mount),
    mountBase: summarize(mountBase),
    click: summarize(click.samples.map((item) => item.ms)),
    clickBase: summarize(clickBase.samples.map((item) => item.ms)),
    drag: summarize(drag.intervals),
    dragBase: summarize(dragBase.intervals),
    tree: summarize(tree.mountSamples),
    treeBase: summarize(treeBase.mountSamples)
  };

  const metrics = {
    mountMs: stats.mount.p95,
    selectMs: stats.click.p95,
    dragMedianMs: stats.drag.p50,
    dragP95Ms: stats.drag.p95,
    dragMaxMs: stats.drag.max,
    dragHandlerP95Ms: summarize(drag.handlerMs).p95,
    dragFrames: drag.frames,
    treeMountMs: stats.tree.p95,
    treeSetLayersMs: round2(median(tree.setLayersSamples)),
    treeSelectMs: round2(median(tree.selectSamples)),
    treeScrollP95Ms: round2(percentile(tree.scrollSamples, 95)),
    treeRows: tree.rows,
    selectRectReads: click.samples[0]?.rectReads ?? null,
    baseline: {
      mountMs: stats.mountBase.p95,
      selectMs: stats.clickBase.p95,
      dragP95Ms: stats.dragBase.p95,
      treeMountMs: stats.treeBase.p95
    },
    sampleCounts: { mount: stats.mount.n, select: stats.click.n, drag: stats.drag.n, tree: stats.tree.n }
  };

  const judges = {
    mountMs: judge('mountMs', stats.mount, stats.mountBase, FLOORS.mountMs, FACTORS.mount),
    selectMs: judge('selectMs', stats.click, stats.clickBase, FLOORS.selectMs, FACTORS.select),
    dragP95Ms: judge('dragP95Ms', stats.drag, stats.dragBase, FLOORS.dragP95Ms, FACTORS.drag),
    treeRenderMs: judge('treeRenderMs', stats.tree, stats.treeBase, FLOORS.treeRenderMs, FACTORS.tree)
  };
  const rows = Object.fromEntries(
    Object.entries(judges).map(([id, result]) => [
      id,
      { value: result.measuredP95, baseline: result.baselineP95, budget: result.budget, floor: result.floor, met: result.pass, formula: result.formula }
    ])
  );

  assert.equal(tree.rows, 500, `树应有 500 行，实际 ${tree.rows}`);
  assert.equal(treeBase.rows, BASELINE_LAYERS, `基线树应有 ${BASELINE_LAYERS} 行，实际 ${treeBase.rows}`);
  assert.ok(click.hitAt, '点选没命中');
  assert.ok(click.samples.every((item) => item.at === click.hitAt));
  assert.ok(drag.frames > (INJECT ? 2 : 30), `拖动窗口只跑了 ${drag.frames} 帧`);
  for (const [id, result] of Object.entries(judges)) {
    assert.ok(result.pass, `${id} 超判据：${result.formula}`);
  }

  await page.screenshot({ path: path.join(EVIDENCE_DIR, 's30-a1-large.png') });
  assert.deepEqual(pageErrors, []);

  evidence.fixture = { dom, info };
  evidence.metrics = metrics;
  evidence.judges = judges;
  evidence.rows = rows;
  evidence.raw = {
    mount,
    mountBase,
    click,
    clickBase: clickBase.samples,
    drag: { frames: drag.frames, intervals: drag.intervals, handlerMs: drag.handlerMs },
    dragBase: { frames: dragBase.frames, intervals: dragBase.intervals },
    tree: { mountSamples: tree.mountSamples, setLayersSamples: tree.setLayersSamples, layoutSamples: tree.layoutSamples, selectSamples: tree.selectSamples, scrollSamples: tree.scrollSamples },
    treeBase: { mountSamples: treeBase.mountSamples }
  };
  evidence.cases.B1 = { metrics, judges, rows, fixture: { dom, info } };
});

/* ── B2 CDP 合成耗时（2 秒拖动窗口）+ rAF 对照 ───────────────────── */

test('B2 拖动窗口 CDP 指标增量 + rAF p95 对照', async () => {
  const { page, pageErrors } = await openPage();
  await installBench(page);

  const client = await page.context().newCDPSession(page);
  await client.send('Performance.enable');

  const readMetrics = async () => {
    const { metrics } = await client.send('Performance.getMetrics');
    /** @type {Record<string, number>} */
    const map = {};
    for (const item of metrics) map[item.name] = item.value;
    return map;
  };

  /* 暖机一次，别把首绘算进 2 秒窗口 */
  await page.evaluate((args) => window.__bench.dragWindow(...args), [500, 300, 400, 0]);

  const beforeMetrics = await readMetrics();
  const t0 = await page.evaluate(() => window.__now());
  const drag = await page.evaluate((args) => window.__bench.dragWindow(...args), [500, 300, RUN_WINDOW_MS, 0]);
  const t1 = await page.evaluate(() => window.__now());
  const afterMetrics = await readMetrics();
  await client.detach();

  /* CDP 的 *Duration 单位是**秒**，这里统一换成毫秒；*Count 是次数，原样 */
  const delta = (name, scale = 1) => round2(((afterMetrics[name] ?? 0) - (beforeMetrics[name] ?? 0)) * scale);
  const deltaMs = (name) => delta(name, 1000);
  const wallMs = round2(t1 - t0);
  const cdp = {
    windowMs: wallMs,
    frames: drag.frames,
    taskDurationMs: deltaMs('TaskDuration'),
    scriptDurationMs: deltaMs('ScriptDuration'),
    layoutDurationMs: deltaMs('LayoutDuration'),
    recalcStyleDurationMs: deltaMs('RecalcStyleDuration'),
    layoutCount: delta('LayoutCount'),
    recalcStyleCount: delta('RecalcStyleCount'),
    jsHeapUsedBefore: beforeMetrics.JSHeapUsedSize,
    jsHeapUsedAfter: afterMetrics.JSHeapUsedSize
  };
  cdp.perFrameTaskMs = round2(cdp.taskDurationMs / Math.max(1, drag.frames));
  cdp.perFrameLayoutMs = round2(cdp.layoutDurationMs / Math.max(1, drag.frames));
  cdp.taskShareOfWindow = round2((cdp.taskDurationMs / Math.max(1, wallMs)) * 100);
  cdp.rafP95Ms = round2(percentile(drag.intervals, 95));
  cdp.rafMedianMs = round2(median(drag.intervals));
  cdp.rafMaxMs = round2(Math.max(...drag.intervals));

  assert.ok(cdp.windowMs >= RUN_WINDOW_MS * 0.9, `拖动窗口 ${cdp.windowMs}ms 太短`);
  assert.ok(cdp.taskDurationMs > 0, 'CDP 没拿到 TaskDuration 增量');
  assert.ok(Number.isFinite(cdp.layoutDurationMs));
  assert.ok(cdp.layoutCount > 0, '拖动期间一次 layout 都没有？窗口可能没覆盖到');

  evidence.cdp = cdp;
  evidence.cases.B2 = cdp;
  assert.deepEqual(pageErrors, []);
});

/* ── B3 treeSetLayers 归因（建树 vs 建 DOM） ─────────────────────── */

test('B3 treeSetLayers 500 层：数字 + 归因（建树 / 建 DOM / 节点数）', async () => {
  const { page, pageErrors } = await openPage();
  await installBench(page);
  const tree = await page.evaluate((args) => window.__bench.measureTree(...args), [500, Math.min(RUN_SAMPLES, 8), 0]);

  const build = median(tree.buildSamples.map((item) => item.ms));
  const render500 = median(tree.setLayersSamples);
  const layout500 = median(tree.layoutSamples);
  const render200 = median(tree.setLayers200);
  const layout200 = median(tree.layout200);
  const nodesPerRow = 8; /* 行 + twisty + icon + name + 2 按钮（含各自文本节点前的元素节点） */
  const attribution = {
    rows500: {
      renderMs: round2(render500),
      layoutMs: round2(layout500),
      totalMs: round2(render500 + layout500),
      approxNodes: tree.rows * nodesPerRow
    },
    rows200: {
      renderMs: round2(render200),
      layoutMs: round2(layout200),
      totalMs: round2(render200 + layout200)
    },
    buildTreeMs: round2(build),
    buildShareOf500Render: round2((build / render500) * 100),
    forcedLayoutsPerSetLayers: 1,
    note: 'render = setLayers 全程（建 500 行 ≈4000 节点 + append，不含 layout）；layout = 紧随其后一次 getBoundingClientRect 的强制排版；200 行同尺子另跑一组'
  };

  assert.equal(tree.rows, 500);
  assert.ok(attribution.rows500.renderMs > 0);
  assert.ok(attribution.buildTreeMs > 0);
  /* 归因结论必须是数据说的，不是猜的 */
  assert.ok(attribution.rows500.renderMs > attribution.buildTreeMs * 10, '建 DOM 应远大于建树，否则归因口径有问题');
  evidence.tree = attribution;
  evidence.cases.B3 = attribution;
  assert.deepEqual(pageErrors, []);
});

/* ── B4 500 层选中截图（框必须落在正确元素上） ───────────────────── */

test('B4 500 层选中截图，框与元素逐像素对齐', async () => {
  const { page, pageErrors } = await openPage();
  await installBench(page);
  const shot = await page.evaluate(() => window.__bench.paintForShot(300));
  await page.screenshot({ path: path.join(EVIDENCE_DIR, 's30-a4-selected.png') });

  assert.ok(shot.at, '没选中任何层');
  assert.equal(shot.treeSelected, shot.at, '树与框不同层');
  assert.equal(shot.rows, 500);
  const dx = Math.abs(shot.frame.x - shot.el.x);
  const dy = Math.abs(shot.frame.y - shot.el.y);
  const dw = Math.abs(shot.frame.w - shot.el.w);
  const dh = Math.abs(shot.frame.h - shot.el.h);
  assert.ok(dx < 0.51 && dy < 0.51 && dw < 0.51 && dh < 0.51, `框与元素不对齐：dx=${dx} dy=${dy} dw=${dw} dh=${dh}`);

  const buf = await fs.readFile(path.join(EVIDENCE_DIR, 's30-a4-selected.png'));
  assert.ok(buf.length > 20000, `截图太小（${buf.length}B）`);
  evidence.cases.B4 = { shot, deltas: { dx, dy, dw, dh }, pngBytes: buf.length };
  assert.deepEqual(pageErrors, []);
});

/* S55：只有设了 OPENCUT_TEST_INJECT_FAIL / OPENCUT_TEST_INJECT_HANG 才会多出一个用例，
   用来实测失败与超时路径的清理；默认零影响。 */
registerCleanupProbe('large-scene-500');
