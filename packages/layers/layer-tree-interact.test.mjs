// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S20-TREE-INTERACT 验收 A1..A6
 *
 * 场景：真实样例场景 `scene-a.html`（有 `.chart#chart-group` 与文字层），
 * 同目录放一份真实 `film.html` 用来做「hash 不变」断言（树一条都不写盘）。
 *
 * 运行：node --test --test-concurrency=1 packages/layers/layer-tree-interact.test.mjs（env 由 test-env.mjs 自动准备；`OPENCUT_ENV_JSON` 可显式覆盖）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { build as esbuild } from 'esbuild';
import { SceneHost, REPO_ROOT } from '../scene-runtime/host.mjs';
import { snapshotLayers } from './dom-probe.mjs';
import { resolveLayerTestEnv } from './test-env.mjs';

const TEST_ENV = await resolveLayerTestEnv({ suite: 'layer-tree-interact' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');
const PROJECTS = path.join(RUN_ROOT, 'projects');
const BUNDLE_ABS = path.join(RUN_ROOT, 'tmp/s20/tree.mjs');
const BUNDLE_URL = '/' + path.relative(REPO_ROOT, BUNDLE_ABS).split(path.sep).join('/');

const SAMPLE =
  '/tmp/motioncut-optional-scene-fixture';

const TREE_CSS = `
.layer-tree-panel { outline: none; }
.layer-tree { outline: none; }
.layer-tree-row { display: flex; align-items: center; gap: 6px; padding: 3px 6px; border-radius: 6px; cursor: pointer; white-space: nowrap; overflow: hidden; }
.layer-tree-row:hover { background: #1c2a45; }
.layer-tree-row[data-hover="true"] { background: #22314f; }
.layer-tree-row[aria-selected="true"] { background: #2a3b5e; }
.layer-tree-row[data-locked="true"] { opacity: .6; cursor: not-allowed; }
.layer-tree-row[data-active="true"] { box-shadow: inset 0 0 0 1px #5b7bb5; }
[data-layer-tree][data-tree-focused="true"] .layer-tree-row[data-active="true"] { outline: 2px solid #7aa2ff; outline-offset: -2px; }
.layer-tree-twisty { width: 12px; text-align: center; color: #9fb3d1; font-size: 11px; }
.layer-tree-icon { width: 16px; text-align: center; color: #8fb8ff; font-size: 12px; }
.layer-tree-name { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.layer-tree-empty { padding: 8px; color: #8b9bb4; }
`;

const HOST_STYLE =
  'position:fixed;right:0;top:0;width:360px;height:100vh;background:#111a2e;color:#eef2ff;' +
  'font:13px/1.7 ui-sans-serif,system-ui,"PingFang SC";z-index:2147483647;overflow:auto;padding:10px;box-sizing:border-box';

const evidence = { batch: 'B-SUB1-R10-010', suite: 'layer-tree-interact.test.mjs', cases: {}, screenshots: [], startedAt: new Date().toISOString() };

/** @type {SceneHost} */
let host;

async function buildBundle() {
  await fs.mkdir(path.dirname(BUNDLE_ABS), { recursive: true });
  await esbuild({
    stdin: {
      contents: [
        "export { mountLayerTree, buildLayerTree, TREE_INDENT_PX } from './packages/layers/layer-tree.mjs';",
        "export { mountInspector } from './packages/layers/inspector-panel.mjs';",
        "export { mountCanvasGesture } from './packages/layers/canvas-gesture.mjs';",
        "export { readLayer } from './packages/layers/describe.ts';"
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
  for (const name of ['s20-a3-focus-ring.png', 's20-a5-hover-before.png', 's20-a5-hover-after.png']) {
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
  await fs.writeFile(path.join(EVIDENCE_DIR, 's20-tree-interact.json'), JSON.stringify(evidence, null, 2) + '\n');
}

before(async () => {
  const env = JSON.parse(await fs.readFile(path.join(RUN_ROOT, 'env.json'), 'utf8'));
  evidence.batch = env.batchId ?? evidence.batch;
  await buildBundle();
  host = await new SceneHost({ port: Number(env.studioPort), viewport: { width: 1440, height: 900 } }).start();
  evidence.scene = { origin: host.origin, browser: host.browserVersion };
});

after(async () => {
  await save();
  if (host) await host.stop();
});

/** 复制样例（film.html + scene-a.html）到本批 projects，返回可打开的 scene 相对路径。 */
async function makeScene(name) {
  const dir = path.join(PROJECTS, `${name}-${process.pid}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.copyFile(path.join(SAMPLE, 'film.html'), path.join(dir, 'film.html'));
  await fs.copyFile(path.join(SAMPLE, 'scene-a.html'), path.join(dir, 'scene-a.html'));
  return {
    dir,
    filmPath: path.join(dir, 'film.html'),
    sceneRel: path.relative(REPO_ROOT, path.join(dir, 'scene-a.html')).split(path.sep).join('/')
  };
}

async function openScene(sceneRel) {
  const handle = await host.open(sceneRel);
  const page = handle.page;
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.addStyleTag({ content: 'html,body{width:1280px !important;height:720px !important;overflow:hidden !important}' });
  return { handle, page, errors };
}

/** 页内：挂树（+ 可选手势，用于显隐/悬停联动）。 */
async function mountLive(deps) {
  const mod = await import(deps.bundle);
  if (!document.querySelector('#r10-tree-style')) {
    const style = document.createElement('style');
    style.id = 'r10-tree-style';
    style.textContent = deps.css;
    document.head.appendChild(style);
  }
  if (!document.querySelector('#r10-tree-host')) {
    const hostEl = document.createElement('div');
    hostEl.id = 'r10-tree-host';
    hostEl.setAttribute('style', deps.hostStyle);
    document.body.appendChild(hostEl);
  }
  const hostEl = document.querySelector('#r10-tree-host');

  const snap = deps.snapshot;
  const events = { select: [], hover: [], lock: [], hidden: [] };
  window.__events = events;

  /** @type {any} */
  let gesture = null;
  if (deps.withGesture) {
    const stageEl = document.querySelector('.stage');
    const r = stageEl.getBoundingClientRect();
    let box = deps.selectBox;
    if (!box && deps.selectAt) {
      const el = document.querySelector(deps.selectAt);
      if (el) {
        const b = el.getBoundingClientRect();
        box = { x: b.x - r.x, y: b.y - r.y, w: b.width, h: b.height };
      }
    }
    window.__selected = [{ at: deps.selectAt, box: box ?? { x: 0, y: 0, w: 8, h: 8 } }];
    gesture = mod.mountCanvasGesture(document.body, {
      getStageRect: () => ({ x: r.x, y: r.y, w: r.width, h: r.height, scale: 1 }),
      getSelectionSet: () => window.__selected,
      isHidden: (at) => (window.__tree ? window.__tree.hiddenAt(at) : false),
      getHighlightRect: (at) => {
        const el = document.querySelector(at);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const s = document.querySelector('.stage').getBoundingClientRect();
        return { x: r.x - s.x, y: r.y - s.y, w: r.width, h: r.height };
      },
      onCommit: () => {},
      onCancel: () => {}
    });
    window.__gesture = gesture;
  }

  const tree = mod.mountLayerTree(hostEl, {
    layers: snap.layers,
    lockedAt: (at) => (deps.lockedAts ?? []).includes(at),
    onSelect: (at) => events.select.push(at),
    onHover: (at) => {
      events.hover.push(at);
      if (gesture) gesture.setHighlight(at);
    },
    onLockChange: (ats) => events.lock.push(ats),
    onHiddenChange: (ats) => {
      events.hidden.push(ats);
      if (gesture) gesture.refresh();
    }
  });
  window.__tree = tree;
  window.__mod = mod;
  return {
    state: tree.getState(),
    stage: (() => {
      const b = document.querySelector('.stage').getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    })()
  };
}

/** 页内：挂面板（deps.tree 用真实层 + 回调）。 */
async function mountPanelLive(deps) {
  const mod = await import(deps.bundle);
  if (!document.querySelector('#r10-tree-style')) {
    const style = document.createElement('style');
    style.id = 'r10-tree-style';
    style.textContent = deps.css;
    document.head.appendChild(style);
  }
  const hostEl = document.createElement('div');
  hostEl.id = 'r10-panel-host';
  hostEl.setAttribute('style', deps.hostStyle);
  document.body.appendChild(hostEl);

  const events = { lock: [], hidden: [], hover: [] };
  window.__panelEvents = events;
  const panel = mod.mountInspector(hostEl, {
    describe: async (ref) => {
      const res = mod.readLayer(ref.at);
      return res && res.ok ? res.value : res;
    },
    preview: async () => ({ ok: true }),
    commit: async () => ({ ok: true, hash: 'test', changed: true }),
    tree: {
      layers: deps.snapshot.layers,
      clipId: 'scene',
      selectedAt: deps.selectAt,
      onLockChange: (ats) => events.lock.push(ats),
      onHiddenChange: (ats) => events.hidden.push(ats),
      onHover: (at) => events.hover.push(at)
    }
  });
  await panel.select({ clipId: 'scene', at: deps.selectAt, kind: 'text', name: 'x', depth: 1 });
  window.__panel = panel;
  return { state: panel.getState(), tree: panel.getTree().getState() };
}

async function layersOf(page) {
  return page.evaluate(/** @type {any} */ (snapshotLayers), { includeInvisible: false });
}

/* ── A1 ─────────────────────────────────────────────────────────────────── */

test('S20-A1 锁定两层 → 点不动、不可选中，lockedAt 集合正确且宿主可读', async () => {
  const scene = await makeScene('s20-a1');
  const { handle, page } = await openScene(scene.sceneRel);
  const snap = await layersOf(page);
  await page.evaluate(mountLive, {
    bundle: BUNDLE_URL,
    css: TREE_CSS,
    hostStyle: HOST_STYLE,
    snapshot: snap
  });

  /* 点 #title 的「锁」按钮、点 #badge 的「锁」按钮 */
  await page.click('[data-layer-row][data-at="#title"] [data-lock-toggle]');
  await page.click('[data-layer-row][data-at="#badge"] [data-lock-toggle]');
  const locked = await page.evaluate(() => ({
    state: window.__tree.getState(),
    lockedAtTitle: window.__tree.lockedAt('#title'),
    lockedAtBadge: window.__tree.lockedAt('#badge'),
    lockedAtOther: window.__tree.lockedAt('#subtitle'),
    events: window.__events.lock
  }));
  assert.deepEqual(locked.state.locked.sort(), ['#badge', '#title'].sort());
  assert.equal(locked.lockedAtTitle, true);
  assert.equal(locked.lockedAtBadge, true);
  assert.equal(locked.lockedAtOther, false);
  assert.deepEqual(locked.events[locked.events.length - 1].sort(), ['#badge', '#title'].sort());

  /* 点锁定行的名字 → 选中被拒（aria-disabled 会让 Playwright 等，用 force 发真实鼠标事件） */
  await page.click('[data-layer-row][data-at="#title"] [data-layer-name]', { force: true });
  const afterClick = await page.evaluate(() => ({ events: window.__events.select, state: window.__tree.getState() }));
  assert.deepEqual(afterClick.events, [], `锁定行不应触发 onSelect：${JSON.stringify(afterClick.events)}`);
  assert.equal(afterClick.state.status, 'LOCKED');

  /* 面板 deps.tree 也能读到（主线 M19 用它禁手柄） */
  const panelMounted = await page.evaluate(mountPanelLive, {
    bundle: BUNDLE_URL,
    css: TREE_CSS,
    hostStyle: HOST_STYLE,
    snapshot: snap,
    selectAt: '#title'
  });
  const fromPanel = await page.evaluate(() => ({
    lockedAt: window.__panel.getTree().lockedAt('#title'),
    hasTree: !!window.__panel.getTree()
  }));
  assert.equal(fromPanel.hasTree, true);
  assert.equal(fromPanel.lockedAt, false, '新建的树没有会话锁定（锁定不落盘、不跨实例）');
  /* 在新树里锁一次 → 面板侧读得到 */
  await page.click('[data-inspector-tree] [data-layer-row][data-at="#title"] [data-lock-toggle]');
  const lockedViaPanel = await page.evaluate(() => window.__panel.getTree().lockedAt('#title'));
  assert.equal(lockedViaPanel, true);

  evidence.cases['S20-A1'] = {
    ok: true,
    locked: locked.state.locked,
    lockedAt: { title: locked.lockedAtTitle, badge: locked.lockedAtBadge, subtitle: locked.lockedAtOther },
    selectEvents: afterClick.events,
    status: afterClick.state.status,
    viaPanel: { before: fromPanel.lockedAt, after: lockedViaPanel },
    panelFields: panelMounted.state.fields.map((f) => f.id)
  };
  await handle.dispose();
});

/* ── A2 ─────────────────────────────────────────────────────────────────── */

test('S20-A2 隐藏一层 → 树行灰、舞台框不显示；film.html hash 不变', async () => {
  const scene = await makeScene('s20-a2');
  const before = crypto.createHash('sha256').update(await fs.readFile(scene.filmPath)).digest('hex');
  const { handle, page } = await openScene(scene.sceneRel);
  const snap = await layersOf(page);
  await page.evaluate(mountLive, {
    bundle: BUNDLE_URL,
    css: TREE_CSS,
    hostStyle: HOST_STYLE,
    snapshot: snap,
    withGesture: true,
    selectAt: '#badge'
  });

  const beforeHide = await page.evaluate(() => ({
    frame: getComputedStyle(document.querySelector('[data-gesture-frame]')).display,
    hiddenAt: window.__tree.hiddenAt('#badge'),
    rowOpacity: getComputedStyle(document.querySelector('[data-layer-row][data-at="#badge"]')).opacity
  }));
  assert.equal(beforeHide.frame, 'block');
  assert.equal(beforeHide.hiddenAt, false);

  await page.click('[data-layer-row][data-at="#badge"] [data-eye-toggle]');
  const afterHide = await page.evaluate(() => ({
    state: window.__tree.getState(),
    frame: getComputedStyle(document.querySelector('[data-gesture-frame]')).display,
    hiddenAt: window.__tree.hiddenAt('#badge'),
    row: (() => {
      const el = document.querySelector('[data-layer-row][data-at="#badge"]');
      return { dataHidden: el.getAttribute('data-hidden'), opacity: getComputedStyle(el).opacity, text: el.querySelector('[data-layer-name]').textContent };
    })(),
    events: window.__events.hidden
  }));
  assert.deepEqual(afterHide.state.hidden, ['#badge']);
  assert.equal(afterHide.hiddenAt, true);
  assert.equal(afterHide.row.dataHidden, 'true');
  assert.ok(Number(afterHide.row.opacity) < 1, `行应变灰：${afterHide.row.opacity}`);
  assert.equal(afterHide.frame, 'none', '隐藏后舞台框不应显示');
  assert.deepEqual(afterHide.events[afterHide.events.length - 1], ['#badge']);

  /* 再点一次恢复 */
  await page.click('[data-layer-row][data-at="#badge"] [data-eye-toggle]');
  const restored = await page.evaluate(() => ({
    frame: getComputedStyle(document.querySelector('[data-gesture-frame]')).display,
    hiddenAt: window.__tree.hiddenAt('#badge')
  }));
  assert.equal(restored.frame, 'block');
  assert.equal(restored.hiddenAt, false);

  const after = crypto.createHash('sha256').update(await fs.readFile(scene.filmPath)).digest('hex');
  assert.equal(after, before, `film.html 不应被改：${before} → ${after}`);
  const filmText = await fs.readFile(scene.filmPath, 'utf8');
  assert.ok(!/hidden|locked/.test(filmText), 'film.html 里不应出现 hidden/locked');

  evidence.cases['S20-A2'] = {
    ok: true,
    beforeHide,
    afterHide: { hidden: afterHide.state.hidden, hiddenAt: afterHide.hiddenAt, row: afterHide.row, frame: afterHide.frame },
    restored,
    filmHash: { before, after, unchanged: after === before }
  };
  await handle.dispose();
});

/* ── A3 ─────────────────────────────────────────────────────────────────── */

test('S20-A3 键盘全套：↑↓←→ Enter/空格 Home/End 各一次 + 焦点环截图', async () => {
  const scene = await makeScene('s20-a3');
  const { handle, page } = await openScene(scene.sceneRel);
  const snap = await layersOf(page);
  await page.evaluate(mountLive, { bundle: BUNDLE_URL, css: TREE_CSS, hostStyle: HOST_STYLE, snapshot: snap });

  /* 根层没有 id（`.stage` 只有 class），at 是路径——从树里读，不写死 */
  const rootAt = await page.evaluate(() => window.__tree.getState().roots[0]);

  await page.evaluate(() => document.querySelector('[data-layer-tree]').focus());
  const focused = await page.evaluate(() => document.querySelector('[data-layer-tree]').getAttribute('data-tree-focused'));
  assert.equal(focused, 'true');

  await page.keyboard.press('ArrowDown');
  const down1 = await page.evaluate(() => window.__tree.getState().activeAt);
  assert.equal(down1, rootAt);
  await page.keyboard.press('ArrowDown');
  const down2 = await page.evaluate(() => window.__tree.getState().activeAt);
  assert.equal(down2, '#card-group');
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.evaluate(() => window.__tree.getState().activeAt), rootAt);

  /* End → 最后一个可见行；Home → 第一个 */
  await page.keyboard.press('End');
  const end = await page.evaluate(() => window.__tree.getState().activeAt);
  const visible = await page.evaluate(() => window.__tree.getState().visible);
  assert.equal(end, visible[visible.length - 1]);
  await page.keyboard.press('Home');
  assert.equal(await page.evaluate(() => window.__tree.getState().activeAt), rootAt);

  /* ↓ 到 #card-group 后 ← 折叠、→ 展开 */
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowLeft');
  const left = await page.evaluate(() => ({
    collapsed: window.__tree.getState().collapsed,
    visible: window.__tree.getState().visible,
    active: window.__tree.getState().activeAt
  }));
  assert.equal(left.collapsed.includes('#card-group'), true);
  assert.equal(left.visible.includes('#title'), false, '折叠后子项应隐藏');
  assert.equal(left.active, '#card-group');
  await page.keyboard.press('ArrowRight');
  const right = await page.evaluate(() => ({ collapsed: window.__tree.getState().collapsed, visible: window.__tree.getState().visible }));
  assert.equal(right.collapsed.includes('#card-group'), false);
  assert.ok(right.visible.includes('#title'));

  /* 空格选中当前活动行 */
  await page.keyboard.press('Enter');
  const enter = await page.evaluate(() => ({ events: window.__events.select, state: window.__tree.getState() }));
  assert.deepEqual(enter.events, ['#card-group']);
  await page.keyboard.press('ArrowDown');
  const beforeSpace = await page.evaluate(() => window.__tree.getState().activeAt);
  await page.keyboard.press(' ');
  const space = await page.evaluate(() => ({ events: window.__events.select, state: window.__tree.getState() }));
  assert.deepEqual(space.events, ['#card-group', beforeSpace]);
  assert.equal(space.state.selectedAt, beforeSpace);

  /* 焦点环截图：把活动行留在 #title（选中态 + 焦点态都可见） */
  await page.keyboard.press('ArrowDown');
  const shot = path.join(EVIDENCE_DIR, 's20-a3-focus-ring.png');
  await page.screenshot({ path: shot, clip: { x: 1060, y: 0, width: 380, height: 420 } });
  const focusShotState = await page.evaluate(() => ({
    active: window.__tree.getState().activeAt,
    focused: document.querySelector('[data-layer-tree]').getAttribute('data-tree-focused'),
    rowActive: document.querySelector('[data-layer-row][data-active="true"]')?.getAttribute('data-at') ?? null
  }));
  assert.equal(focusShotState.focused, 'true');
  assert.equal(focusShotState.rowActive, focusShotState.active);

  evidence.cases['S20-A3'] = {
    ok: true,
    keys: { rootAt, down1, down2, end, left, right, enter: enter.events, space: space.events },
    focus: focusShotState,
    screenshot: 's20-a3-focus-ring.png'
  };
  await handle.dispose();
});

/* ── A4 ─────────────────────────────────────────────────────────────────── */

test('S20-A4 过滤「chart」→ 只剩 chart-group 及其祖先/子项', async () => {
  const scene = await makeScene('s20-a4');
  const { handle, page } = await openScene(scene.sceneRel);
  const snap = await layersOf(page);
  await page.evaluate(mountLive, { bundle: BUNDLE_URL, css: TREE_CSS, hostStyle: HOST_STYLE, snapshot: snap });

  await page.fill('[data-tree-filter]', 'chart');
  const filtered = await page.evaluate(() => ({
    state: window.__tree.getState(),
    rows: [...document.querySelectorAll('[data-layer-row]')].map((row) => row.getAttribute('data-at')),
    filtering: document.querySelector('[data-layer-tree]').getAttribute('data-tree-filtering'),
    inputValue: document.querySelector('[data-tree-filter]').value
  }));

  assert.equal(filtered.filtering, 'true');
  assert.equal(filtered.inputValue, 'chart');
  const rootAt = filtered.state.roots[0];
  assert.ok(filtered.rows.includes('#chart-group'), `应含 chart-group：${filtered.rows}`);
  assert.ok(filtered.rows.includes('#card-group'), '应保留祖先 #card-group');
  assert.ok(filtered.rows.includes(rootAt), `应保留根 ${rootAt}`);
  assert.ok(filtered.rows.includes('#bar-one') && filtered.rows.includes('#bar-three'), '应保留子项');

  const byAt = new Map(filtered.state.nodes.map((node) => [node.at, node]));
  const expectChain = new Set([rootAt, '#card-group', '#chart-group', '#bar-one', '#bar-two', '#bar-three']);
  for (const at of expectChain) assert.ok(filtered.rows.includes(at), `过滤结果缺 ${at}`);
  for (const at of ['#title', '#subtitle', '#badge', '#note']) {
    if (byAt.has(at)) assert.equal(filtered.rows.includes(at), false, `不应出现 ${at}：${filtered.rows}`);
  }
  assert.equal(filtered.rows.length, 6, `应正好 6 行：${filtered.rows}`);

  /* 清空过滤 → 全部回来 */
  await page.fill('[data-tree-filter]', '');
  const cleared = await page.evaluate(() => window.__tree.getState());
  assert.equal(cleared.filter, '');
  assert.ok(cleared.visible.length >= 9, `清空后应恢复：${cleared.visible.length}`);

  evidence.cases['S20-A4'] = {
    ok: true,
    rows: filtered.rows,
    filtering: filtered.filtering,
    clearedVisible: cleared.visible.length
  };
  await handle.dispose();
});

/* ── A5 ─────────────────────────────────────────────────────────────────── */

test('S20-A5 hover 树行 → 舞台淡描边（前后截图对照）', async () => {
  const scene = await makeScene('s20-a5');
  const { handle, page } = await openScene(scene.sceneRel);
  const snap = await layersOf(page);
  await page.evaluate(mountLive, {
    bundle: BUNDLE_URL,
    css: TREE_CSS,
    hostStyle: HOST_STYLE,
    snapshot: snap,
    withGesture: true,
    selectAt: '#badge'
  });

  const before = await page.evaluate(() => ({
    display: getComputedStyle(document.querySelector('[data-gesture-highlight]')).display,
    hoverAt: window.__tree.getState().hoverAt
  }));
  assert.equal(before.display, 'none');
  const beforeShot = path.join(EVIDENCE_DIR, 's20-a5-hover-before.png');
  await page.screenshot({ path: beforeShot, clip: { x: 0, y: 0, width: 1280, height: 720 } });

  /* 悬停 #title 行 */
  await page.hover('[data-layer-row][data-at="#title"]');
  const after = await page.evaluate(() => {
    const el = document.querySelector('[data-gesture-highlight]');
    const r = el.getBoundingClientRect();
    return {
      display: getComputedStyle(el).display,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      hoverAt: window.__tree.getState().hoverAt,
      events: window.__events.hover,
      pointerEvents: getComputedStyle(el).pointerEvents
    };
  });
  assert.equal(after.display, 'block', '悬停后应有描边');
  assert.equal(after.hoverAt, '#title');
  assert.equal(after.pointerEvents, 'none', '描边不能挡事件');
  assert.ok(after.rect.w > 10 && after.rect.h > 10, `描边应有尺寸：${JSON.stringify(after.rect)}`);
  const afterShot = path.join(EVIDENCE_DIR, 's20-a5-hover-after.png');
  await page.screenshot({ path: afterShot, clip: { x: 0, y: 0, width: 1280, height: 720 } });

  /* 移开 → 消失 */
  await page.hover('[data-layer-row][data-at="#subtitle"]');
  const away = await page.evaluate(() => ({
    display: getComputedStyle(document.querySelector('[data-gesture-highlight]')).display,
    hoverAt: window.__tree.getState().hoverAt
  }));
  assert.notEqual(away.hoverAt, '#title');

  const [statBefore, statAfter] = [await fs.stat(beforeShot), await fs.stat(afterShot)];
  assert.ok(statBefore.size > 10240 && statAfter.size > 10240, `截图应 >10KB：${statBefore.size}/${statAfter.size}`);

  evidence.cases['S20-A5'] = {
    ok: true,
    before,
    after,
    hoverEvents: after.events.slice(-2),
    files: [
      { name: 's20-a5-hover-before.png', bytes: statBefore.size },
      { name: 's20-a5-hover-after.png', bytes: statAfter.size }
    ]
  };
  await handle.dispose();
});

/* ── A6 ─────────────────────────────────────────────────────────────────── */

test('S20-A6 触发一次 render（换数据 + 面板重选）→ 展开/锁定/显隐/过滤都还在', async () => {
  const scene = await makeScene('s20-a6');
  const { handle, page } = await openScene(scene.sceneRel);
  const snap = await layersOf(page);
  await page.evaluate(mountPanelLive, {
    bundle: BUNDLE_URL,
    css: TREE_CSS,
    hostStyle: HOST_STYLE,
    snapshot: snap,
    selectAt: '#title'
  });

  /* 造状态：折叠 #chart-group、锁 #title、隐 #badge、过滤词 chart（先折叠再过滤，过滤会强制展开；
     为了让「折叠」也参与，把过滤放在最后再清空，只留折叠） */
  await page.click('[data-inspector-tree] [data-layer-row][data-at="#chart-group"] [data-twisty]');
  await page.click('[data-inspector-tree] [data-layer-row][data-at="#title"] [data-lock-toggle]');
  await page.click('[data-inspector-tree] [data-layer-row][data-at="#badge"] [data-eye-toggle]');
  const before = await page.evaluate(() => window.__panel.getTree().getState());
  assert.equal(before.collapsed.includes('#chart-group'), true);
  assert.deepEqual(before.locked, ['#title']);
  assert.deepEqual(before.hidden, ['#badge']);

  /* 触发一次树的重建 + 面板重选（等价于「改个无关字段后重绘」） */
  const after = await page.evaluate(async (layers) => {
    window.__panel.setTreeLayers(layers);
    await window.__panel.select({ clipId: 'scene', at: '#subtitle', kind: 'text', name: 'x', depth: 1 });
    return window.__panel.getTree().getState();
  }, snap.layers);

  assert.equal(after.collapsed.includes('#chart-group'), true, `折叠应保持：${after.collapsed}`);
  assert.deepEqual(after.locked, ['#title'], `锁定应保持：${after.locked}`);
  assert.deepEqual(after.hidden, ['#badge'], `显隐应保持：${after.hidden}`);
  assert.equal(after.selectedAt, '#subtitle', '重选后选中应更新');

  /* 过滤词也保持：设一次 → 换数据 → 还在 */
  await page.fill('[data-inspector-tree] [data-tree-filter]', 'bar');
  const withFilter = await page.evaluate(async (layers) => {
    window.__panel.setTreeLayers(layers);
    return {
      filter: window.__panel.getTree().getFilter(),
      rows: [...document.querySelectorAll('[data-inspector-tree] [data-layer-row]')].map((row) => row.getAttribute('data-at')),
      input: document.querySelector('[data-inspector-tree] [data-tree-filter]').value
    };
  }, snap.layers);
  assert.equal(withFilter.filter, 'bar');
  assert.equal(withFilter.input, 'bar');
  assert.ok(withFilter.rows.includes('#bar-one'), `过滤结果应在重绘后保持：${withFilter.rows}`);

  evidence.cases['S20-A6'] = {
    ok: true,
    before: { collapsed: before.collapsed, locked: before.locked, hidden: before.hidden },
    after: { collapsed: after.collapsed, locked: after.locked, hidden: after.hidden, selectedAt: after.selectedAt },
    filterAfterRebuild: withFilter
  };
  await handle.dispose();
});
