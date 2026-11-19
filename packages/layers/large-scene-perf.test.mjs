// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S28-LARGE-SCENE-PERF 验收 A1..A8（R31 / S52 起判据改成「同页基线 + p95」）
 *
 * 真 Chromium（SceneHost）+ 真 200 层舞台（`large-200.html`：85 容器 + 39 文字 + 38 图片 + 38 图形，
 * 最深 5 层）。宿主按真实 Studio 的方式接：`getLayerRects` 每次**现算** 200 个 `getBoundingClientRect`
 * （不缓存、不预烤——这就是真实宿主的写法），所以「面板/手势多读一次」会真的变成毫秒。
 *
 * ## 判据（R31 改，原因见 `perf-budget.mjs` 的文件头）
 *
 * 四个指标原来各有一条**绝对阈值**（500/50/20/100ms）。绝对阈值在带负载的机器上必红：
 * 同一份代码单跑 8ms、十个 Chromium 并行时 40ms，红灯只说明「机器忙」，不说明「产品退化」。
 *
 * 现在每个指标都配一个**同 fixture、同操作、100 层**的基线（数据量一半），判据是
 *
 *     measuredP95 ≤ max(floor, baselineP95 × factor + slack)
 *
 * `floor` 是产品预算（**不许改大**，A4 用 grep 看住）；`factor/slack` 是「这台机器此刻
 * 就是这个速度」的让步。采样 40 次，`p95` 进判据、`max` 只记账。
 *
 * `OPENCUT_PERF_INJECT=1`：在同一条量测路径里塞忙等（`floor × 1.2`），判据**必须红**
 * 并打印「实测 / 基线 / 公式」——证明这条判据不是橡皮图章。
 *
 * 优化前/优化后的数字都落在 `s28-perf-${label}.json`（`OPENCUT_PERF_LABEL` 控制 label），
 * 交接里的 perf 三列就是用这两个文件对出来的。
 *
 * 运行：node --test --test-concurrency=1 packages/layers/large-scene-perf.test.mjs
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

const TEST_ENV = await resolveLayerTestEnv({ suite: 'large-scene-perf' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');
const BUNDLE_ABS = path.join(RUN_ROOT, 'tmp/s28/perf.mjs');
const BUNDLE_URL = '/' + path.relative(REPO_ROOT, BUNDLE_ABS).split(path.sep).join('/');
const FIXTURE = 'tests/fixtures/scenes/large-200.html';
const LABEL = process.env.OPENCUT_PERF_LABEL ?? 'after';

const BATCH = 'B-SUB1-R14-014';
/** 采样数：p95 至少要 40 个样本（`ceil(0.95×40)=38`，允许 2 个掉队）。 */
const SAMPLES = 40;
const DRAG_MOVES = 120;
/** 基线只用前 100 层：同 fixture、同操作、一半数据量。 */
const BASELINE_LAYERS = 100;
/** 忙等注入（`OPENCUT_PERF_INJECT=1`）：样本降到 6 个，否则光注入就要跑几十秒。 */
const INJECT = process.env.OPENCUT_PERF_INJECT === '1';
const INJECT_SAMPLES = 6;
const INJECT_MOVES = 40;

/** 产品预算（floor）。**这是上限，不许改大**（A4 的 grep 只该剩下这一行）：
 *  mountMs ≤ 500、selectMs ≤ 50、dragP95Ms ≤ 20、treeRenderMs ≤ 100。——A4 的 grep 看住这几个数。 */
const FLOORS = { mountMs: 500, selectMs: 50, dragP95Ms: 20, treeRenderMs: 100 };
/** 相对基线的放宽倍数：数据量 2×（200 vs 100 层），4 倍留给超线性成本与调度抖动。 */
const FACTORS = { mount: 4, select: 4, drag: 4, tree: 4 };
/** 固定余量（ms）：抵消「基线太小导致乘出来的预算不现实」的那一段。 */
const SLACK_MS = 2;

const evidence = {
  batch: BATCH,
  suite: 'large-scene-perf.test.mjs',
  label: LABEL,
  samples: INJECT ? INJECT_SAMPLES : SAMPLES,
  inject: INJECT,
  floors: FLOORS,
  factors: FACTORS,
  slackMs: SLACK_MS,
  baselineLayers: BASELINE_LAYERS,
  fixture: null,
  metrics: {},
  judges: {},
  raw: {},
  cases: {},
  screenshots: [],
  startedAt: new Date().toISOString()
};

/** @type {SceneHost} */
let host;
/** 端口在 before() 里从 env 读，A6 停/起 Host 时复用。 */
let PORT = 0;

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

/** @param {number} n */
const round2 = (n) => Math.round(n * 100) / 100;

async function save() {
  const files = [];
  for (const name of ['s28-a1-large.png', 's28-a7-selected.png']) {
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
  await fs.writeFile(path.join(EVIDENCE_DIR, `s28-perf-${LABEL}.json`), JSON.stringify(evidence, null, 2) + '\n');
}

before(async () => {
  const env = JSON.parse(await fs.readFile(path.join(RUN_ROOT, 'env.json'), 'utf8'));
  evidence.batch = env.batchId ?? evidence.batch;
  await buildBundle();
  PORT = Number(env.sceneOrigin || env.studioPort);
  await startHost();
});

after(async () => {
  await save();
  if (host) await host.stop();
});

/** 起 Host（A6 前后各一次：全局浏览器槽一次只放一个浏览器，子进程要独占那个名额）。 */
async function startHost() {
  host = await new SceneHost({ port: PORT, viewport: { width: 1720, height: 1040 } }).start();
  evidence.browser = host.browserVersion;
}

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

/**
 * 页内装好「宿主」：层列表、现算 rects、测量函数。
 * 一切从这里之后都由 `window.__bench.*` 提供，Node 侧只负责计时口径与取值。
 * @param {import('playwright').Page} page
 */
async function installBench(page) {
  const info = await page.evaluate(async (bundle) => {
    const mod = await import(bundle);
    window.__mod = mod;

    /* SceneHost 的受控时钟把 `performance.now` 定义成实例自有属性（虚拟时间，恒为 0）。
       原型上那个还是真的，取它——否则所有耗时都会是 0.00ms。 */
    const realNow = Performance.prototype.now;
    window.__now = () => realNow.call(performance);

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

    /* 计数：宿主现算 200 个 rect —— 模块多读一次这里就多 200 次布局 */
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
    /** 真实宿主写法：每次现算（不缓存） */
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

    window.__benchStage = stage;
    window.__benchLayers = layerList;
    window.__benchTreeLayers = treeLayers;
    window.__benchRects = rectsOf;
    window.__benchCountingRects = countingRects;
    window.__benchMod = mod;

    const raf = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

    function benchHost() {
      const box = document.getElementById('bench');
      box.textContent = '';
      const gestureBox = document.createElement('div');
      gestureBox.id = 'bench-gesture';
      const treeBox = document.createElement('div');
      treeBox.id = 'bench-tree';
      treeBox.style.cssText = 'height:600px;overflow:auto;background:#0f1729;color:#e5e7eb';
      box.appendChild(gestureBox);
      box.appendChild(treeBox);
      return { gestureBox, treeBox };
    }

    /** 忙等（注入对照用）。`window.__now` 是原型上的真实时钟——受控时钟只改了实例上的。 */
    const busy = (ms) => {
      if (!(ms > 0)) return;
      const end = window.__now() + ms;
      while (window.__now() < end) {
        /* spin */
      }
    };

    /** 只算前 `limit` 层的 rect：基线（100 层）与正式量测（200 层）走同一段代码。 */
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

    function mountTree(box, limit) {
      return mod.mountLayerTree(box, { layers: treeLayers.slice(0, limit) });
    }

    /** 1. 挂载初始化：两个组件都挂起来 → 首帧 */
    /** 2. 单击选中：pointerdown → 框 style 已写 + 强制一次 layout */
    /** 3. 拖动：pointerdown + N 次 pointermove（每帧一次） */
    /** 4. 图层树：mount / setLayers / select / 滚动 */
    window.__bench = {
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
        const target = layerList[Math.min(index ?? 120, limit - 1)];
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
          /* 强制一次 layout：读到的是「描边已经画好」的真实代价 */
          if (frame) frame.getBoundingClientRect();
          const t1 = window.__now();
          out.push({ ms: t1 - t0, rectReads: window.__rectReads - readsBefore, at: gesture.getState().at, display: frame ? frame.style.display : 'none' });
          document.dispatchEvent(
            new PointerEvent('pointerup', { bubbles: true, clientX: cx, clientY: cy, button: 0, pointerId: 1 })
          );
        }
        gesture.destroy();
        /* 点在容器中心可能命中它内部的叶子（pickAt 取最上层）——所以「命中」以实际 at 为准 */
        return { samples: out, targetAt: target.at, hitAt: out[0]?.at ?? null };
      },

      /** 拖动帧间隔：先点选，再按住选框拖 60px（每帧一次 pointermove） */
      async measureDrag(limit, index, moves, injectMs) {
        const { gestureBox } = benchHost();
        const gesture = mountGesture(gestureBox, limit);
        await raf();
        const target = layerList[Math.min(index ?? 120, limit - 1)];
        const b = target.el.getBoundingClientRect();
        const cx = b.x + b.width / 2;
        const cy = b.y + b.height / 2;
        /* ① 先选中这一层 */
        target.el.dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, pointerId: 1 })
        );
        document.dispatchEvent(
          new PointerEvent('pointerup', { bubbles: true, clientX: cx, clientY: cy, button: 0, pointerId: 1 })
        );
        await raf();
        /* ② 按住选框本体（手势的 move 只从框上起） */
        const frame = document.querySelector('[data-gesture-frame]');
        const fr = frame.getBoundingClientRect();
        const fx = fr.x + fr.width / 2;
        const fy = fr.y + fr.height / 2;
        const dragOnce = async (steps) => {
          frame.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: fx, clientY: fy, button: 0, pointerId: 1 })
          );
          for (let i = 1; i <= steps; i += 1) {
            await raf();
            document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: fx + i * 2, clientY: fy, pointerId: 1 }));
          }
          document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: fx + steps * 2, clientY: fy, button: 0, pointerId: 1 }));
        };
        /* 暖机：首帧含 200 层首次绘制/图片解码，不代表拖动本身的开销；暖机这段不进样本 */
        await dragOnce(6);
        await raf();

        const fr2 = frame.getBoundingClientRect();
        const sx = fr2.x + fr2.width / 2;
        const sy = fr2.y + fr2.height / 2;
        frame.dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: sx, clientY: sy, button: 0, pointerId: 1 })
        );
        const intervals = [];
        const handlerMs = [];
        let last = window.__now();
        for (let i = 1; i <= moves; i += 1) {
          await raf();
          const now = window.__now();
          intervals.push(now - last);
          last = now;
          const t0 = window.__now();
          busy(injectMs);
          document.dispatchEvent(
            new PointerEvent('pointermove', { bubbles: true, clientX: sx + i * 2, clientY: sy, pointerId: 1 })
          );
          handlerMs.push(window.__now() - t0);
        }
        document.dispatchEvent(
          new PointerEvent('pointerup', { bubbles: true, clientX: sx + moves * 2, clientY: sy, button: 0, pointerId: 1 })
        );
        const mode = gesture.getState().mode;
        const commits = window.__calls.commit;
        gesture.destroy();
        return { intervals, handlerMs, mode, commits, targetAt: target.at, frame: gesture.getState().frame };
      },

      /** 截图用：挂好手势 + 树，选中一层，等一帧 */
      async paintForShot(index) {
        const { gestureBox, treeBox } = benchHost();
        const gesture = mountGesture(gestureBox, layerList.length);
        const tree = mountTree(treeBox, layerList.length);
        await raf();
        const target = layerList[index ?? 120];
        const b = target.el.getBoundingClientRect();
        target.el.dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: b.x + b.width / 2, clientY: b.y + b.height / 2, button: 0, pointerId: 1 })
        );
        document.dispatchEvent(
          new PointerEvent('pointerup', { bubbles: true, clientX: b.x + b.width / 2, clientY: b.y + b.height / 2, button: 0, pointerId: 1 })
        );
        /* 让树与框选同一层：以手势实际命中的 at 为准 */
        const hitAt = gesture.getState().at;
        if (hitAt) tree.select(hitAt);
        await raf();
        return { at: hitAt, frame: gesture.getState().frame, treeSelected: tree.getState().selectedAt, rows: treeBox.querySelectorAll('[data-layer-row]').length };
      },

      /** 4. 图层树：全量重建 / 选中一行 / 滚动；`mountSamples` 是 40 次独立挂载（判据用它） */
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

        const t1 = window.__now();
        tree.setLayers(treeLayers.slice(0, limit));
        const setLayersMs = window.__now() - t1;

        const rows = treeBox.querySelectorAll('[data-layer-row]').length;

        const selectSamples = [];
        for (let i = 0; i < 5; i += 1) {
          const t2 = window.__now();
          tree.select(treeLayers[Math.min(120 + i, limit - 1)].at);
          treeBox.getBoundingClientRect();
          selectSamples.push(window.__now() - t2);
        }

        const scrollSamples = [];
        for (let i = 0; i < 12; i += 1) {
          const t3 = window.__now();
          treeBox.scrollTop = i * 24;
          treeBox.getBoundingClientRect();
          scrollSamples.push(window.__now() - t3);
        }
        const selected = tree.getState().selectedAt;
        tree.destroy();
        return { mountSamples, setLayersMs, selectSamples, scrollSamples, rows, selected };
      }
    };

    const stageInfo = {
      layers: elements.length,
      maxDepth: Number(stage.getAttribute('data-max-depth')),
      kinds: JSON.parse(stage.getAttribute('data-kinds') ?? '{}'),
      treeDepth: (() => {
        const built = mod.buildLayerTree(treeLayers);
        let max = 0;
        for (const node of built.nodes) max = Math.max(max, node.depth);
        return max;
      })(),
      roots: mod.buildLayerTree(treeLayers).roots.length
    };
    return stageInfo;
  }, BUNDLE_URL);

  return info;
}

/* ── A1 fixture 真有 200 层、5 层嵌套 ─────────────────────────────── */

test('A1 fixture 真有 200 层（脚本数出来），5 层嵌套深度', async () => {
  const { page, pageErrors } = await openPage();
  const info = await installBench(page);

  /* 页面自己的 data 属性 */
  const dom = await page.evaluate(() => {
    const stage = document.getElementById('stage');
    const els = [...stage.querySelectorAll('[data-at]')];
    const ats = new Set(els.map((el) => '#' + el.id));
    return {
      count: els.length,
      unique: ats.size,
      declaredCount: stage.getAttribute('data-layer-count'),
      declaredDepth: stage.getAttribute('data-max-depth'),
      kinds: JSON.parse(stage.getAttribute('data-kinds') ?? '{}')
    };
  });

  /* Node 侧独立数一遍：读 fixture 文件里的 data-at 与容器嵌层级 */
  const html = await fs.readFile(path.join(REPO_ROOT, FIXTURE), 'utf8');
  const tagCount = (html.match(/data-at(?=[\s>=])/g) ?? []).length;
  const idsInFile = [...html.matchAll(/id="([^"]+)"[^>]*data-at/g)].map((m) => m[1]);

  assert.equal(dom.count, 200, `DOM 里应有 200 层，实际 ${dom.count}`);
  assert.equal(dom.unique, 200, '200 个 at 必须唯一');
  assert.equal(tagCount, 200, `fixture 文件里 data-at 属性应有 200 个，实际 ${tagCount}`);
  assert.equal(idsInFile.length, 200);
  assert.equal(dom.declaredCount, '200');
  assert.equal(dom.declaredDepth, '5', `页面实测最深应为 5 层，实际 ${dom.declaredDepth}`);
  assert.equal(info.maxDepth, 5);
  assert.equal(info.treeDepth, 5, `buildLayerTree 还原的深度应为 5，实际 ${info.treeDepth}`);
  assert.ok(info.kinds.text > 0 && info.kinds.image > 0 && info.kinds.container > 0, `类型混合不全：${JSON.stringify(info.kinds)}`);
  assert.equal(info.layers, 200);

  await page.screenshot({ path: path.join(EVIDENCE_DIR, 's28-a1-large.png') });
  assert.deepEqual(pageErrors, []);
  evidence.fixture = { dom, info, tagCount };
  evidence.cases.A1 = { dom, info };
});

/* ── A2 四个指标的采样（40 次）+ 同页基线（100 层） ───────────────── */

/** 正式跑一次的量；注入模式下样本降到 6 个，否则光注入就要几十秒。 */
const RUN_SAMPLES = INJECT ? INJECT_SAMPLES : SAMPLES;
const RUN_MOVES = INJECT ? INJECT_MOVES : DRAG_MOVES;
/**
 * 注入量（ms/次）。**必须压过 baseline×factor**，只压过 floor 不够——基线在忙机器上会涨，
 * 预算跟着涨，所以注入量按「floor 的 4~20 倍」给（floor 越小相对倍数越大）。
 */
const INJECT_MS = { mountMs: 2000, selectMs: 400, dragP95Ms: 400, treeRenderMs: 800 };

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

test('A2 四个指标：40 次采样 + 100 层同页基线（判据 = max(floor, 基线×4+2)）', async () => {
  const { page, pageErrors } = await openPage();
  await installBench(page);

  const mount = await page.evaluate(
    (args) => window.__bench.measureMount(...args),
    [200, RUN_SAMPLES, INJECT ? INJECT_MS.mountMs : 0]
  );
  const mountBase = await page.evaluate((args) => window.__bench.measureMount(...args), [BASELINE_LAYERS, RUN_SAMPLES, 0]);
  const clickResult = await page.evaluate(
    (args) => window.__bench.measureClick(...args),
    [200, 120, RUN_SAMPLES, INJECT ? INJECT_MS.selectMs : 0]
  );
  const clickBase = await page.evaluate((args) => window.__bench.measureClick(...args), [BASELINE_LAYERS, 60, RUN_SAMPLES, 0]);
  const drag = await page.evaluate(
    (args) => window.__bench.measureDrag(...args),
    [200, 120, RUN_MOVES, INJECT ? INJECT_MS.dragP95Ms : 0]
  );
  const dragBase = await page.evaluate((args) => window.__bench.measureDrag(...args), [BASELINE_LAYERS, 60, RUN_MOVES, 0]);
  const tree = await page.evaluate(
    (args) => window.__bench.measureTree(...args),
    [200, RUN_SAMPLES, INJECT ? INJECT_MS.treeRenderMs : 0]
  );
  const treeBase = await page.evaluate((args) => window.__bench.measureTree(...args), [BASELINE_LAYERS, RUN_SAMPLES, 0]);
  const click = clickResult.samples;

  const stats = {
    mount: summarize(mount),
    mountBase: summarize(mountBase),
    click: summarize(click.map((item) => item.ms)),
    clickBase: summarize(clickBase.samples.map((item) => item.ms)),
    drag: summarize(drag.intervals),
    dragBase: summarize(dragBase.intervals),
    tree: summarize(tree.mountSamples),
    treeBase: summarize(treeBase.mountSamples)
  };

  evidence.raw = {
    mount,
    mountBase,
    click: clickResult,
    clickBase: clickBase.samples,
    drag: { intervals: drag.intervals, handlerMs: drag.handlerMs, commits: drag.commits },
    dragBase: { intervals: dragBase.intervals, handlerMs: dragBase.handlerMs },
    tree: { mountSamples: tree.mountSamples, setLayersMs: tree.setLayersMs, selectSamples: tree.selectSamples, scrollSamples: tree.scrollSamples, rows: tree.rows },
    treeBase: { mountSamples: treeBase.mountSamples, rows: treeBase.rows },
    stats
  };
  evidence.metrics = {
    mountMs: stats.mount.p95,
    selectMs: stats.click.p95,
    selectP50Ms: stats.click.p50,
    selectRectReads: click.map((item) => item.rectReads),
    dragP95Ms: stats.drag.p95,
    dragMedianMs: stats.drag.p50,
    dragMaxMs: stats.drag.max,
    dragHandlerP95Ms: summarize(drag.handlerMs).p95,
    treeMountMs: stats.tree.p95,
    treeSetLayersMs: round2(tree.setLayersMs),
    treeSelectMs: round2(median(tree.selectSamples)),
    treeScrollP95Ms: round2(percentile(tree.scrollSamples, 95)),
    treeRows: tree.rows,
    baseline: {
      mountMs: stats.mountBase.p95,
      selectMs: stats.clickBase.p95,
      dragP95Ms: stats.dragBase.p95,
      treeMountMs: stats.treeBase.p95
    },
    sampleCounts: {
      mount: stats.mount.n,
      select: stats.click.n,
      drag: stats.drag.n,
      tree: stats.tree.n
    }
  };

  /* 判据：p95 对同页基线，floor 是产品预算 */
  const judges = {
    mountMs: judge('mountMs', stats.mount, stats.mountBase, FLOORS.mountMs, FACTORS.mount),
    selectMs: judge('selectMs', stats.click, stats.clickBase, FLOORS.selectMs, FACTORS.select),
    dragP95Ms: judge('dragP95Ms', stats.drag, stats.dragBase, FLOORS.dragP95Ms, FACTORS.drag),
    treeRenderMs: judge('treeRenderMs', stats.tree, stats.treeBase, FLOORS.treeRenderMs, FACTORS.tree)
  };
  evidence.judgeTable = judges;

  /* 口径断言：无论快慢都必须成立 */
  assert.equal(click.length, RUN_SAMPLES, `点选采样应 ${RUN_SAMPLES} 次`);
  assert.equal(mount.length, RUN_SAMPLES, `挂载采样应 ${RUN_SAMPLES} 次`);
  assert.ok(stats.drag.n >= 40, `拖动帧数应 ≥40，实际 ${stats.drag.n}`);
  assert.equal(tree.rows, 200, `树应有 200 行，实际 ${tree.rows}`);
  assert.equal(treeBase.rows, BASELINE_LAYERS, `基线树应有 ${BASELINE_LAYERS} 行，实际 ${treeBase.rows}`);
  assert.ok(clickResult.hitAt, '点选没命中任何层');
  assert.ok(click.every((item) => item.at === clickResult.hitAt), `${RUN_SAMPLES} 次点选命中不一致：${JSON.stringify(click.map((c) => c.at))}`);
  assert.ok(click.every((item) => item.display === 'block'), '选中后框必须 visible');
  assert.equal(drag.targetAt, clickResult.targetAt);
  assert.ok(drag.commits >= 1, `拖动松手应提交一次，实际 ${drag.commits}`);
  assert.ok(tree.selected && String(tree.selected).startsWith('#'));

  /* 判据断言（注入模式下这几条就是**要**红的） */
  for (const [id, result] of Object.entries(judges)) {
    assert.ok(result.pass, `${id} 超判据：${result.formula}`);
  }

  /* 抽帧：画面必须是 200 层的真实场景 + 选中框 + 200 行树 */
  const shot = await page.evaluate(() => window.__bench.paintForShot(120));
  await page.screenshot({ path: path.join(EVIDENCE_DIR, 's28-a7-selected.png') });
  assert.equal(shot.at, clickResult.hitAt, '截图前选中框不在命中的层上');
  assert.equal(shot.treeSelected, shot.at, '树与框不同层');
  assert.equal(shot.rows, 200);
  evidence.cases.A2shot = shot;
  assert.deepEqual(pageErrors, []);
  evidence.cases.A2 = { metrics: evidence.metrics, judges };
});

/* ── A3 四个指标的数字 + 三列对照（写进 s28-perf-table.json） ─────── */

test('A3 四个指标的数字 + 判据三列（floor / 基线 / 实测）', async () => {
  assert.ok(evidence.metrics.mountMs > 0, 'A2 没留下指标');
  const metrics = evidence.metrics;

  /** @type {Record<string, any>} */
  const table = {};
  const pairs = {
    mountMs: ['mountMs', FLOORS.mountMs],
    selectMs: ['selectMs', FLOORS.selectMs],
    dragP95Ms: ['dragP95Ms', FLOORS.dragP95Ms],
    treeRenderMs: ['treeMountMs', FLOORS.treeRenderMs]
  };
  for (const [id, [metricKey, floor]] of Object.entries(pairs)) {
    const result = evidence.judges[id];
    table[id] = {
      floor,
      baselineP95: result.baselineP95,
      measuredP95: result.measuredP95,
      max: result.max,
      samples: result.samples,
      budget: result.budget,
      formula: result.formula,
      met: result.pass,
      unit: 'ms'
    };
  }

  /* 优化前：读同目录下 label=before 的那次采样（没有就留 null，不编数字） */
  let before = null;
  try {
    before = JSON.parse(await fs.readFile(path.join(EVIDENCE_DIR, 's28-perf-before.json'), 'utf8'));
  } catch {
    before = null;
  }
  evidence.table = {
    rows: table,
    before: before ? before.metrics ?? null : null,
    extra: {
      selectRectReads: { after: metrics.selectRectReads[0], note: '一次点选读多少次 getBoundingClientRect（确定性计数，不是计时）' },
      treeSelectMs: { after: metrics.treeSelectMs, note: '选中一行（旧实现整树重建）' },
      treeSetLayersMs: { after: metrics.treeSetLayersMs, note: '换一批 200 层（真需要重建）' },
      treeScrollP95Ms: { after: metrics.treeScrollP95Ms },
      dragMedianMs: { after: metrics.dragMedianMs, note: '≈16.7ms 即 60Hz 帧节奏，没有掉帧' },
      dragHandlerP95Ms: { after: metrics.dragHandlerP95Ms },
      baseline: metrics.baseline,
      sampleCounts: metrics.sampleCounts
    }
  };
  await fs.writeFile(path.join(EVIDENCE_DIR, 's28-perf-table.json'), JSON.stringify(evidence.table, null, 2) + '\n');

  /* 结构性不变量（确定性，与机器快慢无关） */
  if (LABEL !== 'before' && !INJECT) {
    assert.ok(metrics.selectRectReads[0] <= 204, `一次点选仍读了 ${metrics.selectRectReads[0]} 次 rect（应只有一遍全量扫描）`);
    assert.ok(metrics.treeSelectMs < metrics.treeSetLayersMs, '选中一行不该比整树重建还贵');
  }
  evidence.cases.A3 = { rows: table, extra: evidence.table.extra };
});

/* ── A4 拖动 p95：对同页基线（判据在 perf-budget.mjs） ───────────── */

test('A4 拖动 p95 对同页基线：记录 hot spot（handler vs 帧间隔）', async () => {
  const metrics = evidence.metrics;
  const result = evidence.judges.dragP95Ms;
  assert.equal(Number.isFinite(metrics.dragP95Ms), true);
  evidence.cases.A4 = {
    dragP95Ms: metrics.dragP95Ms,
    dragMedianMs: metrics.dragMedianMs,
    dragMaxMs: metrics.dragMaxMs,
    dragHandlerP95Ms: metrics.dragHandlerP95Ms,
    baselineP95: result.baselineP95,
    budget: result.budget,
    formula: result.formula,
    met: result.pass,
    note: `帧间隔 p95 ${metrics.dragP95Ms}ms vs 基线 ${result.baselineP95}ms（handler 自身 p95 ${metrics.dragHandlerP95Ms}ms）`
  };
  /* 绝对上限只用来抓「离谱」：判据本身在上面那条 */
  assert.ok(metrics.dragP95Ms < 400, `p95 ${metrics.dragP95Ms}ms 已经离谱，不是「略慢」`);
});

/* ── A5 选中：对同页基线 ─────────────────────────────────────────── */

test('A5 选中对同页基线：记录 rect 读数（确定性计数）', async () => {
  const metrics = evidence.metrics;
  const result = evidence.judges.selectMs;
  evidence.cases.A5 = {
    selectP95Ms: metrics.selectMs,
    selectP50Ms: metrics.selectP50Ms,
    baselineP95: result.baselineP95,
    budget: result.budget,
    formula: result.formula,
    met: result.pass,
    rectReads: metrics.selectRectReads[0],
    note: `选中 p95 ${metrics.selectMs}ms（基线 ${result.baselineP95}ms），一次全量 rect 扫描 ${metrics.selectRectReads[0]} 次布局读`
  };
});

/* ── A6 优化后 R9–R13 手势/对齐/键盘/树 用例全绿 ────────────────── */

test('A6 优化后 R9–R13 手势/对齐/键盘/树 用例全绿（回归）', async () => {
  const { execFile } = await import('node:child_process');
  const files = [
    'packages/layers/canvas-gesture.test.mjs',
    'packages/layers/canvas-gesture-plus.test.mjs',
    'packages/layers/canvas-gesture-rotate.test.mjs',
    'packages/layers/canvas-keys.test.mjs',
    'packages/layers/align-distribute.test.mjs',
    'packages/layers/layer-tree.test.mjs',
    'packages/layers/layer-tree-interact.test.mjs',
    'packages/layers/inspector-panel.test.mjs',
    'packages/layers/inspector-multi.test.mjs'
  ];
  const logPath = path.join(RUN_ROOT, 'logs/s28-a6-regress.txt');
  /* 子进程不能再是「测试里的测试」：清掉 NODE_TEST_CONTEXT，否则 node 直接跳过所有文件（exit 0 但是空跑） */
  const childEnv = { ...process.env, OPENCUT_ENV_JSON: process.env.OPENCUT_ENV_JSON ?? path.join(RUN_ROOT, 'env.json') };
  delete childEnv.NODE_TEST_CONTEXT;

  /* 全局浏览器槽（ADR-R36-01）一次只放一个浏览器：下面这 9 个文件各自在自己的进程里申请
     同一个槽。父进程的 Host 不先停掉，子进程会一直排队到取槽超时（15 分钟），
     runner 的 per-file 超时也会到点 —— 这正是串行化后暴露的死锁。先停再跑，跑完起回来给 A8。 */
  await host.stop();
  host = null;

  let result;
  try {
    result = await new Promise((resolve) => {
      execFile(
        process.execPath,
        ['--test', '--test-concurrency=1', ...files],
        { cwd: REPO_ROOT, env: childEnv, maxBuffer: 32 * 1024 * 1024 },
        (error, stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) })
      );
    });
  } finally {
    await startHost();
  }
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(logPath, result.stdout + result.stderr);
  const pass = (result.stdout.match(/^# pass (\d+)$/m) ?? [])[1] ?? '0';
  const fail = (result.stdout.match(/^# fail (\d+)$/m) ?? [])[1] ?? '?';
  evidence.cases.A6 = { code: result.code, pass: Number(pass), fail: Number(fail), files, log: 's28-a6-regress.txt' };
  assert.equal(result.code, 0, `R9–R13 回归失败（见 ${logPath}）\n${result.stdout.slice(-3000)}`);
  assert.equal(Number(fail), 0);
  assert.ok(Number(pass) >= 60, `回归用例数异常：${pass}`);
});

/* ── A7 200 层真实截图（抽帧证明不是空场景） ─────────────────────── */

test('A7 一个 200 层的真实截图（抽帧证明不是空场景）', async () => {
  const shot = evidence.cases.A2shot;
  assert.ok(shot, 'A2 没产出抽帧数据');
  assert.equal(shot.rows, 200);
  const buf = await fs.readFile(path.join(EVIDENCE_DIR, 's28-a7-selected.png'));
  assert.ok(buf.length > 20000, `截图太小（${buf.length}B），可能是空场景`);
  const a1 = await fs.readFile(path.join(EVIDENCE_DIR, 's28-a1-large.png'));
  assert.ok(a1.length > 20000, `A1 截图太小（${a1.length}B）`);
  evidence.cases.A7 = { shot, selectedPngBytes: buf.length, largePngBytes: a1.length };
});

/* ── A8 pageErrors 空 ───────────────────────────────────────────── */

test('A8 页面零异常（tsc 由 commands 里的 tsc 跑）', async () => {
  const { page, pageErrors } = await openPage();
  await installBench(page);
  const mount = await page.evaluate((args) => window.__bench.measureMount(...args), [200, Math.min(RUN_SAMPLES, 8), 0]);
  assert.equal(mount.length, Math.min(RUN_SAMPLES, 8));
  assert.deepEqual(pageErrors, [], `页面异常：${pageErrors.join(' | ')}`);
  evidence.cases.A8 = { pageErrors };
});
