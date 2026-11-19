// @ts-nocheck —— 断言以 node --test 运行时为准；产品模块仍由 tsc 严格检查。
/**
 * S53-SUBTITLE-BOX-METRICS · B-SUB1-R27-027
 *
 * 两段：
 * 1. **几何**（纯 Node，给定 metrics）：行盒位置、对齐、bearing、padding/圆角、
 *    block 并集、估算降级、`boxToPlayRes` 的 PlayRes 换算；
 * 2. **DOM 同步**（真 Chromium）：`background: transparent` 时 0 个框、有底色时
 *    每行一个 `div[data-subtitle-box]` 且**在文字下方**、`updateStyle` 与 maxLines
 *    变化时节点增删同步、`destroy()` 清干净。
 *
 * 27 格的像素几何在 `scripts/s53-box-metrics.mjs`（那是验收脚本，不在单测里跑）。
 *
 * 运行：node --test --test-concurrency=1 packages/layers/subtitle-box.test.mjs
 *      （env 由 test-env.mjs 自动准备；`OPENCUT_ENV_JSON` 可显式覆盖）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build as esbuild } from 'esbuild';
import { SceneHost, REPO_ROOT } from '../scene-runtime/host.mjs';
import { resolveLayerTestEnv } from './test-env.mjs';
import {
  SUBTITLE_BOX_PADDING_X_EM,
  SUBTITLE_BOX_PADDING_Y_EM,
  SUBTITLE_BOX_RADIUS_EM,
  boxToPlayRes,
  measureSubtitleLines
} from './subtitle-box.mjs';
import { toCssStyle } from './subtitle-style.mjs';

const TEST_ENV = await resolveLayerTestEnv({ suite: 'subtitle-box' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');
const BUNDLE_ABS = path.join(RUN_ROOT, 'tmp/s53/subtitle-box.mjs');
const BUNDLE_URL = '/' + path.relative(REPO_ROOT, BUNDLE_ABS).split(path.sep).join('/');
const FIXTURE = 'tests/fixtures/scenes/subtitle-box.html';
const STAGE = { w: 1280, h: 720 };

const evidence = { batch: 'B-SUB1-R27-027', suite: 'subtitle-box.test.mjs', cases: {}, startedAt: new Date().toISOString() };
const round = (n, d = 2) => Math.round(Number(n) * 10 ** d) / 10 ** d;

/** @type {SceneHost} */
let host;

async function save() {
  evidence.finishedAt = new Date().toISOString();
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(path.join(EVIDENCE_DIR, 's53-subtitle-box.json'), JSON.stringify(evidence, null, 2) + '\n');
}

before(async () => {
  const env = JSON.parse(await fs.readFile(path.join(RUN_ROOT, 'env.json'), 'utf8'));
  evidence.batch = env.batchId ?? evidence.batch;
  await fs.mkdir(path.dirname(BUNDLE_ABS), { recursive: true });
  await esbuild({
    stdin: { contents: "export * from './packages/layers/subtitle-overlay.mjs';", resolveDir: REPO_ROOT, loader: 'js' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile: BUNDLE_ABS,
    logLevel: 'silent'
  });
  host = await new SceneHost({ port: Number(env.studioPort), viewport: { width: 1440, height: 900 } }).start();
  evidence.browser = host.browserVersion;
});

after(async () => {
  await save();
  if (host) await host.stop();
});

/* ────────────────────────── 1. 几何（纯 Node） ────────────────────────── */

test('S53-U1 行盒：y 按 lineHeight 逐行下移，块底 = 舞台底 − 安全区 − 半行距补偿', () => {
  const lines = ['第一行', '第二行'];
  const geometry = measureSubtitleLines({
    stage: STAGE,
    lines,
    metrics: [
      { advance: 160, inkLeft: 2, inkRight: 158 },
      { advance: 96, inkLeft: 1.5, inkRight: 94.5 }
    ]
  });
  /* R32：字号 0.045 → 0.04 之后 720p 是 29（原 32），行距 = 字号、半行距补偿 = (1.25−1)/2 × 29。 */
  const css = toCssStyle(undefined, STAGE);
  assert.equal(geometry.fontSizePx, 29);
  assert.equal(geometry.lineHeightPx, 29);
  assert.equal(geometry.textOffsetPx, 3.63);
  assert.equal(geometry.bottomPx, 57.6);
  const blockTop = STAGE.h - css.bottomPx - css.textOffsetPx - 2 * css.lineHeightPx;
  assert.ok(Math.abs(geometry.lines[0].y - blockTop) < 0.01, `首行 y：${geometry.lines[0].y} vs ${blockTop}`);
  assert.ok(Math.abs(geometry.lines[1].y - (blockTop + 29)) < 0.01, '第二行应比首行低一个 lineHeight');
  assert.equal(geometry.lines[0].h, 29);
  assert.equal(geometry.padding.x, round(29 * SUBTITLE_BOX_PADDING_X_EM, 3));
  assert.equal(geometry.padding.y, round(29 * SUBTITLE_BOX_PADDING_Y_EM, 3));
  assert.equal(geometry.radius, round(29 * SUBTITLE_BOX_RADIUS_EM, 3));
  evidence.cases.U1 = { blockTop: round(blockTop, 3), lines: geometry.lines, block: geometry.block };
});

test('S53-U2 对齐：center / left / right 的 advance 起点', () => {
  const metrics = [{ advance: 100, inkLeft: 0, inkRight: 100 }];
  const base = measureSubtitleLines({ stage: STAGE, lines: ['abc'], metrics });
  const left = measureSubtitleLines({ stage: STAGE, lines: ['abc'], metrics, style: { align: 'left' } });
  const right = measureSubtitleLines({ stage: STAGE, lines: ['abc'], metrics, style: { align: 'right' } });
  const contentLeft = base.sideSafePx;
  const contentW = STAGE.w - contentLeft * 2;
  assert.equal(left.lines[0].advanceX, round(contentLeft, 3));
  assert.equal(right.lines[0].advanceX, round(contentLeft + contentW - 100, 3));
  assert.equal(base.lines[0].advanceX, round(contentLeft + (contentW - 100) / 2, 3));
  evidence.cases.U2 = { center: base.lines[0].advanceX, left: left.lines[0].advanceX, right: right.lines[0].advanceX };
});

test('S53-U3 字形墨迹：x = advanceX + inkLeft，w = inkRight − inkLeft', () => {
  const geometry = measureSubtitleLines({
    stage: STAGE,
    lines: ['字形'],
    metrics: [{ advance: 100, inkLeft: 6, inkRight: 94 }]
  });
  const line = geometry.lines[0];
  assert.equal(line.advanceW, 100);
  assert.equal(line.x, round(line.advanceX + 6, 3));
  assert.equal(line.w, 88);
  /* 框 = 墨迹 + padding + 描边环；描边环半径来自 toCssStyle（32px 默认 2px） */
  const css = toCssStyle(undefined, STAGE);
  const box = geometry.boxes[0];
  assert.equal(box.x, round(line.x - geometry.padding.x - css.outlinePx, 3));
  assert.equal(box.w, round(88 + 2 * (geometry.padding.x + css.outlinePx), 3));
  evidence.cases.U3 = { line, box, outlinePx: geometry.outlinePx };
});

test('S53-U4 空行：宽度 0，但仍然有一个框（不能把行吞掉）', () => {
  const geometry = measureSubtitleLines({
    stage: STAGE,
    lines: ['有字', ''],
    metrics: [{ advance: 64, inkLeft: 1, inkRight: 63 }, null]
  });
  assert.equal(geometry.lines[1].w, 0);
  assert.equal(geometry.boxes.length, 2);
  assert.ok(geometry.boxes[1].w > 0, '空行的框也要有 padding 宽度');
  assert.equal(geometry.block.h, round(geometry.boxes[1].y + geometry.boxes[1].h - geometry.boxes[0].y, 3));
  evidence.cases.U4 = { boxes: geometry.boxes, block: geometry.block };
});

test('S53-U5 没有 metrics / measurer：降级成估算，source=estimate 且不含 bearing', () => {
  const geometry = measureSubtitleLines({ stage: STAGE, lines: ['字幕', 'abc'] });
  assert.equal(geometry.source, 'estimate');
  assert.ok(geometry.lines[0].w > 0 && geometry.lines[1].w > 0);
  /* 估算的 inkLeft = 0：x 就是 advance 起点（注释里写明估算不能拿去对像素） */
  assert.equal(geometry.lines[0].x, geometry.lines[0].advanceX);
  evidence.cases.U5 = { source: geometry.source, widths: geometry.lines.map((line) => line.w) };
});

test('S53-U6 advanceRects（Range 的结果）优先：x/y 用实测，w 仍按 bearing 收紧', () => {
  const geometry = measureSubtitleLines({
    stage: STAGE,
    lines: ['实测'],
    metrics: [{ advance: 80, inkLeft: 3, inkRight: 77 }],
    advanceRects: [{ x: 400, y: 500, w: 82 }]
  });
  const line = geometry.lines[0];
  assert.equal(line.advanceX, 400);
  assert.equal(line.advanceW, 82);
  assert.equal(line.x, 403);
  assert.equal(line.w, 74);
  assert.equal(line.y, 500);
  evidence.cases.U6 = { line };
});

test('S53-U7 非法舞台：抛 TypeError（不是静默出 NaN 坐标）', () => {
  assert.throws(() => measureSubtitleLines({ stage: { w: 0, h: 720 }, lines: ['x'] }), /stage/);
  assert.throws(() => measureSubtitleLines({ stage: null, lines: ['x'] }), /stage/);
});

test('S53-U8 padding / radius 可覆盖（px），block 跟着变', () => {
  const tight = measureSubtitleLines({ stage: STAGE, lines: ['同一个字'], metrics: [{ advance: 100, inkLeft: 0, inkRight: 100 }], padding: { x: 0, y: 0 }, radius: 0 });
  const wide = measureSubtitleLines({ stage: STAGE, lines: ['同一个字'], metrics: [{ advance: 100, inkLeft: 0, inkRight: 100 }], padding: { x: 10, y: 6 }, radius: 12 });
  assert.equal(wide.boxes[0].w - tight.boxes[0].w, 20);
  /* R35：描边环变成设计值（0.792 而不是取整后的 1）后，两个 3 位小数的框高相减会带出
     1e-15 的浮点尾数（12.000000000000004）。判据本身不变，只是把比较落到 1e-6。 */
  assert.equal(round(wide.boxes[0].h - tight.boxes[0].h, 6), 12);
  assert.equal(wide.radius, 12);
  assert.equal(wide.block.w - tight.block.w, 20);
});

test('S53-U9 boxToPlayRes：720p 原样、竖屏按 letterbox 缩放并偏移', () => {
  const rect = { x: 100, y: 200, w: 300, h: 40 };
  const flat = boxToPlayRes(rect, { stage: STAGE, canvas: { w: 1280, h: 720 } });
  assert.deepEqual(flat, { x: 100, y: 200, w: 300, h: 40, scale: 1 });
  const portrait = boxToPlayRes(rect, { stage: STAGE, canvas: { w: 1080, h: 1920 } });
  assert.equal(portrait.scale, 0.84375);
  assert.equal(portrait.x, round(100 * 0.84375, 2));
  assert.equal(portrait.y, round(656.25 + 200 * 0.84375, 2));
  assert.equal(portrait.w, round(300 * 0.84375, 2));
  evidence.cases.U9 = { flat, portrait };
});

/* ────────────────────────── 2. DOM 同步（真 Chromium） ────────────────── */

async function mountSub(deps) {
  const mod = await import(deps.bundle);
  const stage = document.getElementById('stage');
  window.__cues = deps.cues;
  window.__sub?.destroy();
  window.__sub = mod.mountSubtitleOverlay(stage, {
    getCues: () => window.__cues,
    getTime: () => 1,
    getStage: () => {
      const rect = stage.getBoundingClientRect();
      return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
    },
    style: deps.style
  });
  window.__sub.render();
  return window.__sub.getState();
}

function snapshotBoxes() {
  const overlay = document.querySelector('[data-subtitle-overlay]');
  const layer = document.querySelector('[data-subtitle-layer]');
  const nodes = [...document.querySelectorAll('[data-subtitle-box]')];
  const over = overlay.getBoundingClientRect();
  return {
    count: nodes.length,
    overlayChildren: [...overlay.children].map((node) => node.getAttribute('data-subtitle-box-layer') !== null ? 'box-layer' : node.getAttribute('data-subtitle-layer') !== null ? 'text-layer' : node.getAttribute('data-subtitle-measure') !== null ? 'measure' : 'other'),
    /* 框在文字之前（同一个 stacking context 里，先画的在下） */
    boxLayerIndex: [...overlay.children].findIndex((node) => node.hasAttribute('data-subtitle-box-layer')),
    textLayerIndex: [...overlay.children].findIndex((node) => node.hasAttribute('data-subtitle-layer')),
    nodes: nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        line: node.getAttribute('data-line'),
        x: Math.round((rect.x - over.left) * 100) / 100,
        y: Math.round((rect.y - over.top) * 100) / 100,
        w: Math.round(rect.width * 100) / 100,
        h: Math.round(rect.height * 100) / 100,
        radius: style.borderTopLeftRadius,
        background: style.backgroundColor,
        pointerEvents: style.pointerEvents
      };
    }),
    text: (document.querySelector('[data-subtitle-text]')?.textContent ?? '').split('\n'),
    layerBottom: getComputedStyle(layer).bottom
  };
}

test('S53-A1 默认透明：0 个框节点，但几何（lineBoxes/block）仍然给出来', async () => {
  const handle = await host.open(FIXTURE);
  const page = handle.page;
  try {
    const state = await page.evaluate(mountSub, {
      bundle: BUNDLE_URL,
      cues: [{ start: 0, end: 10, text: '第一行字幕\n第二行字幕' }],
      style: { background: 'transparent', maxLines: 2 }
    });
    const snap = await page.evaluate(snapshotBoxes);
    assert.equal(snap.count, 0, `透明时不该有框节点：${snap.count}`);
    assert.equal(state.boxes.length, 0);
    assert.equal(state.lineBoxes.length > 0, true, '透明时仍要给出每行几何（A1 量的是几何）');
    assert.ok(state.block && state.block.h > 0);
    evidence.cases.A1 = { count: snap.count, lines: state.lineBoxes.length, block: state.block };
    assert.equal(snap.overlayChildren.join(','), 'box-layer,text-layer,measure');
  } finally {
    await handle.dispose();
  }
});

test('S53-A2 有底色：每行一个框、在文字下方、颜色/圆角/穿透都对', async () => {
  const handle = await host.open(FIXTURE);
  const page = handle.page;
  try {
    const state = await page.evaluate(mountSub, {
      bundle: BUNDLE_URL,
      cues: [{ start: 0, end: 10, text: '第一行字幕\n第二行字幕' }],
      style: { background: '#ff0000', maxLines: 2 }
    });
    const snap = await page.evaluate(snapshotBoxes);
    assert.equal(snap.count, 2);
    assert.equal(snap.boxLayerIndex < snap.textLayerIndex, true, '框层必须在文字层之前（下面）');
    for (const node of snap.nodes) {
      assert.equal(node.background, 'rgb(255, 0, 0)');
      assert.equal(node.radius, `${round(state.boxRadius, 2)}px`);
      assert.equal(node.pointerEvents, 'none');
    }
    /* 框与 getState().boxes 同值（同一组几何，不是另算一套） */
    for (let i = 0; i < 2; i += 1) {
      const box = state.boxes[i];
      assert.ok(Math.abs(snap.nodes[i].x - box.x) <= 1, `第 ${i} 行 x：${snap.nodes[i].x} vs ${box.x}`);
      assert.ok(Math.abs(snap.nodes[i].y - box.y) <= 1, `第 ${i} 行 y：${snap.nodes[i].y} vs ${box.y}`);
      assert.ok(Math.abs(snap.nodes[i].w - box.w) <= 1);
      assert.ok(Math.abs(snap.nodes[i].h - box.h) <= 1);
    }
    evidence.cases.A2 = { count: snap.count, nodes: snap.nodes, boxes: state.boxes, children: snap.overlayChildren };
  } finally {
    await handle.dispose();
  }
});

test('S53-A3 updateStyle：换底色不重建文字 DOM，改 maxLines 时框增删同步', async () => {
  const handle = await host.open(FIXTURE);
  const page = handle.page;
  try {
    await page.evaluate(mountSub, {
      bundle: BUNDLE_URL,
      cues: [{ start: 0, end: 10, text: '第一行字幕\n第二行字幕\n第三行字幕' }],
      style: { background: '#000000', maxLines: 2 }
    });
    const before = await page.evaluate(snapshotBoxes);
    assert.equal(before.count, 2);

    const changed = await page.evaluate(() => {
      const textNode = document.querySelector('[data-subtitle-text]').firstChild;
      window.__sub.updateStyle({ background: '#00ff88' });
      return {
        sameNode: document.querySelector('[data-subtitle-text]').firstChild === textNode,
        background: getComputedStyle(document.querySelector('[data-subtitle-box]')).backgroundColor
      };
    });
    assert.equal(changed.sameNode, true, '换底色不该重建文本节点');
    assert.equal(changed.background, 'rgb(0, 255, 136)');

    const three = await page.evaluate(() => {
      window.__sub.updateStyle({ maxLines: 3 });
      const nodes = [...document.querySelectorAll('[data-subtitle-box]')];
      return { count: nodes.length, children: document.querySelector('[data-subtitle-box-layer]').childNodes.length, lines: window.__sub.getState().lines };
    });
    assert.equal(three.count, 3);
    assert.equal(three.children, 3);
    assert.equal(three.lines, 3);

    const cleared = await page.evaluate(() => {
      window.__sub.updateStyle({ background: 'transparent' });
      return { count: document.querySelectorAll('[data-subtitle-box]').length, children: document.querySelector('[data-subtitle-box-layer]').childNodes.length };
    });
    assert.equal(cleared.count, 0);
    assert.equal(cleared.children, 0);

    evidence.cases.A3 = { before: before.count, painted: changed.background, afterMax3: three, cleared };
  } finally {
    await handle.dispose();
  }
});

test('S53-A4 destroy：覆盖层整棵移除，body 不留框节点', async () => {
  const handle = await host.open(FIXTURE);
  const page = handle.page;
  try {
    await page.evaluate(mountSub, {
      bundle: BUNDLE_URL,
      cues: [{ start: 0, end: 10, text: '第一行字幕' }],
      style: { background: '#000000' }
    });
    const cleared = await page.evaluate(() => {
      const before = document.querySelectorAll('[data-subtitle-box]').length;
      window.__sub.destroy();
      return {
        before,
        overlay: document.querySelectorAll('[data-subtitle-overlay]').length,
        boxes: document.querySelectorAll('[data-subtitle-box]').length
      };
    });
    assert.equal(cleared.before, 1);
    assert.equal(cleared.overlay, 0);
    assert.equal(cleared.boxes, 0);
    evidence.cases.A4 = cleared;
  } finally {
    await handle.dispose();
  }
});
