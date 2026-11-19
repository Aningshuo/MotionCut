// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S18-LAYER-TREE 验收 A1..A7
 *
 * 真实浏览器（SceneHost）+ 真实 `snapshotLayers`：树的数据就是页面上跑出来的层列表，
 * 不是手搓的假数组。A1 同时用 `buildLayerTree` 交叉验证「有 parentAt」与「只有 depth」
 * 两种输入得到同一棵树（App 的映射会丢 parentAt）。
 *
 * 运行：node --test --test-concurrency=1 packages/layers/layer-tree.test.mjs（env 由 test-env.mjs 自动准备；`OPENCUT_ENV_JSON` 可显式覆盖）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { build as esbuild } from 'esbuild';
import { SceneHost, REPO_ROOT } from '../scene-runtime/host.mjs';
import { snapshotLayers } from './dom-probe.mjs';
import { buildLayerTree, TREE_INDENT_PX } from './layer-tree.mjs';
import { resolveLayerTestEnv } from './test-env.mjs';

const TEST_ENV = await resolveLayerTestEnv({ suite: 'layer-tree' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');
const PROJECTS = path.join(RUN_ROOT, 'projects');
const BUNDLE_ABS = path.join(RUN_ROOT, 'tmp/s18/tree.mjs');
const BUNDLE_URL = '/' + path.relative(REPO_ROOT, BUNDLE_ABS).split(path.sep).join('/');

const FIXTURE_REL = 'tests/fixtures/scenes/layer-tree.html';
const SAMPLE =
  '/tmp/motioncut-optional-scene-fixture';

/** 树的参考样式（产品模块只出结构，样式由宿主给；这份也是给主线抄的默认值）。 */
const TREE_CSS = `
.layer-tree { outline: none; }
.layer-tree-row { display: flex; align-items: center; gap: 6px; padding: 3px 6px; border-radius: 6px; cursor: pointer; white-space: nowrap; overflow: hidden; }
.layer-tree-row:hover { background: #1c2a45; }
.layer-tree-row[aria-selected="true"] { background: #2a3b5e; }
.layer-tree-row[data-locked="true"] { opacity: .6; cursor: not-allowed; }
.layer-tree-twisty { width: 12px; text-align: center; color: #9fb3d1; font-size: 11px; }
.layer-tree-icon { width: 16px; text-align: center; color: #8fb8ff; font-size: 12px; }
.layer-tree-name { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.layer-tree-lock { font-size: 10px; padding: 0 5px; border: 1px solid #ff9ab5; border-radius: 4px; color: #ffb4c8; }
.layer-tree-empty { padding: 8px; color: #8b9bb4; }
`;

const evidence = {
  batch: 'B-SUB1-R9-009',
  suite: 'layer-tree.test.mjs',
  cases: {},
  screenshots: [],
  startedAt: new Date().toISOString()
};

/** @type {SceneHost} */
let host;

async function buildBundle() {
  await fs.mkdir(path.dirname(BUNDLE_ABS), { recursive: true });
  await esbuild({
    stdin: {
      contents: [
        "export { mountLayerTree, buildLayerTree, TREE_INDENT_PX, TREE_ICONS } from './packages/layers/layer-tree.mjs';",
        "export { mountInspector } from './packages/layers/inspector-panel.mjs';",
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
  for (const name of ['s18-a7-tree.png']) {
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
  await fs.writeFile(path.join(EVIDENCE_DIR, 's18-layer-tree.json'), JSON.stringify(evidence, null, 2) + '\n');
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

async function openFixture(rel = FIXTURE_REL) {
  const handle = await host.open(rel);
  const page = handle.page;
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.waitForSelector('body');
  return { handle, page, errors };
}

/** 页内：用真实 snapshotLayers 的层列表挂树。 */
async function mountTreeLive(deps) {
  const mod = await import(deps.bundle);
  if (!document.querySelector('#r9-tree-style')) {
    const style = document.createElement('style');
    style.id = 'r9-tree-style';
    style.textContent = deps.css;
    document.head.appendChild(style);
  }
  let hostEl = document.querySelector('#r9-tree-host');
  if (!hostEl) {
    hostEl = document.createElement('div');
    hostEl.id = 'r9-tree-host';
    hostEl.setAttribute('style', deps.hostStyle);
    document.body.appendChild(hostEl);
  }
  const events = [];
  const tree = mod.mountLayerTree(hostEl, {
    layers: deps.layers,
    selectedAt: deps.selectedAt ?? '',
    lockedAt: (at) => (deps.lockedAts ?? []).includes(at),
    onSelect: (at) => events.push(at)
  });
  window.__tree = tree;
  window.__events = events;
  window.__mod = mod;
  return tree.getState();
}

/** 页内：挂面板（可选 deps.tree）。 */
async function mountPanelLive(deps) {
  const mod = await import(deps.bundle);
  if (!document.querySelector('#r9-tree-style')) {
    const style = document.createElement('style');
    style.id = 'r9-tree-style';
    style.textContent = deps.css;
    document.head.appendChild(style);
  }
  const hostEl = document.createElement('div');
  hostEl.id = 'r9-panel-host';
  hostEl.setAttribute('style', deps.hostStyle);
  document.body.appendChild(hostEl);

  const depsPanel = {
    describe: async (ref) => {
      const res = mod.readLayer(ref.at);
      return res && res.ok ? res.value : res;
    },
    preview: async () => ({ ok: true }),
    commit: async () => ({ ok: true, hash: 'test-hash', changed: true })
  };
  if (deps.withTree) {
    depsPanel.tree = { layers: deps.layers, clipId: deps.clip, selectedAt: deps.at };
  }
  const panel = mod.mountInspector(hostEl, depsPanel);
  const selected = await panel.select({ clipId: deps.clip, at: deps.at, kind: 'text', name: 'x', depth: 1 });
  window.__panel = panel;
  window.__panelHost = hostEl;
  return {
    selectedOk: selected.ok !== false,
    state: panel.getState(),
    children: [...hostEl.children].map((node) => node.className),
    treeCount: hostEl.querySelectorAll('[data-inspector-tree]').length,
    treeRows: [...hostEl.querySelectorAll('[data-layer-row]')].map((row) => ({
      at: row.getAttribute('data-at'),
      depth: row.getAttribute('data-depth'),
      selected: row.getAttribute('aria-selected')
    })),
    fields: [...hostEl.querySelectorAll('.film-inspector [data-field]')].map((row) => row.getAttribute('data-field')),
    hasSelect: hostEl.querySelectorAll('select').length
  };
}

/** 取真实层列表。 */
async function layersOf(page) {
  return page.evaluate(/** @type {any} */ (snapshotLayers), { includeInvisible: false });
}

const HOST_STYLE =
  'position:fixed;right:0;top:0;width:340px;height:100vh;background:#111a2e;color:#eef2ff;' +
  'font:13px/1.7 ui-sans-serif,system-ui,"PingFang SC";z-index:2147483647;overflow:auto;padding:10px;box-sizing:border-box';

async function mountTree(page, extra = {}) {
  const snap = await layersOf(page);
  const state = await page.evaluate(mountTreeLive, {
    bundle: BUNDLE_URL,
    css: TREE_CSS,
    hostStyle: HOST_STYLE,
    layers: snap.layers,
    lockedAts: extra.lockedAts ?? [],
    selectedAt: extra.selectedAt ?? ''
  });
  return { snap, state };
}

/* ── A1 ─────────────────────────────────────────────────────────────────── */

test('S18-A1 三层嵌套 fixture（section > div > span）→ 3 级缩进、父子正确', async () => {
  const { handle, page } = await openFixture();
  const { snap, state } = await mountTree(page);

  const byAt = new Map(state.nodes.map((node) => [node.at, node]));
  const stage = byAt.get('#stage');
  const sec = byAt.get('#sec');
  const box = byAt.get('#box');
  const label = byAt.get('#label');

  assert.ok(stage && sec && box && label, `缺层：${[...byAt.keys()].join(',')}`);
  assert.equal(stage.depth, 1);
  assert.equal(sec.depth, 2, `section 深度：${sec.depth}`);
  assert.equal(box.depth, 3, `div 深度：${box.depth}`);
  assert.equal(label.depth, 4, `span 深度：${label.depth}`);
  assert.equal(sec.parentAt, '#stage');
  assert.equal(box.parentAt, '#sec');
  assert.equal(label.parentAt, '#box');

  /* DOM 缩进：paddingLeft = 4 + (depth-1)*12 */
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('#r9-tree-host [data-layer-row]')].map((row) => ({
      at: row.getAttribute('data-at'),
      depth: Number(row.getAttribute('data-depth')),
      level: Number(row.getAttribute('aria-level')),
      pad: parseFloat(getComputedStyle(row).paddingLeft)
    }))
  );
  const rowOf = (at) => rows.find((row) => row.at === at);
  assert.equal(rows.length, state.nodes.length);
  for (const at of ['#stage', '#sec', '#box', '#label']) {
    const row = rowOf(at);
    assert.ok(row, `没有行：${at}`);
    assert.equal(row.pad, 4 + (row.depth - 1) * TREE_INDENT_PX, `${at} 缩进：${row.pad}`);
    assert.equal(row.level, row.depth);
  }
  assert.ok(rowOf('#label').pad > rowOf('#box').pad && rowOf('#box').pad > rowOf('#sec').pad);

  /* 交叉验证：去掉 parentAt（App 只传 depth）→ 同一棵树 */
  const depthOnly = buildLayerTree(snap.layers.map(({ parentAt, ...rest }) => rest));
  for (const at of ['#stage', '#sec', '#box', '#label']) {
    assert.equal(depthOnly.byAt.get(at)?.depth, byAt.get(at)?.depth, `${at} 仅 depth 还原深度`);
    assert.equal(depthOnly.byAt.get(at)?.parentAt, byAt.get(at)?.parentAt, `${at} 仅 depth 还原父级`);
  }

  evidence.cases['S18-A1'] = {
    ok: true,
    layers: snap.layers.filter((layer) => ['#stage', '#sec', '#box', '#label'].includes(layer.at)),
    nodes: ['#stage', '#sec', '#box', '#label'].map((at) => byAt.get(at)),
    rows,
    depthOnlySame: true
  };
  await handle.dispose();
});

/* ── A2 ─────────────────────────────────────────────────────────────────── */

test('S18-A2 点父级 → onSelect 收到父级 at（不是子级）', async () => {
  const { handle, page } = await openFixture();
  await mountTree(page);

  await page.click('#r9-tree-host [data-layer-row][data-at="#box"]');
  const after = await page.evaluate(() => ({ events: window.__events, state: window.__tree.getState() }));

  assert.deepEqual(after.events, ['#box']);
  assert.equal(after.state.selectedAt, '#box');
  const selectedRow = await page.getAttribute('#r9-tree-host [data-layer-row][data-at="#box"]', 'aria-selected');
  assert.equal(selectedRow, 'true');

  evidence.cases['S18-A2'] = { ok: true, events: after.events, selectedAt: after.state.selectedAt, ariaSelected: selectedRow };
  await handle.dispose();
});

/* ── A3 ─────────────────────────────────────────────────────────────────── */

test('S18-A3 折叠父级 → 子项隐藏；再展开恢复；重新 select 不塌', async () => {
  const { handle, page } = await openFixture();
  await mountTree(page);

  const visibleBefore = await page.evaluate(() => window.__tree.getState().visible);
  assert.ok(visibleBefore.includes('#box') && visibleBefore.includes('#label'));

  /* 折叠 section（#sec）：div/span 应一起消失 */
  await page.click('#r9-tree-host [data-layer-row][data-at="#sec"] [data-twisty]');
  const collapsed = await page.evaluate(() => ({
    state: window.__tree.getState(),
    rows: [...document.querySelectorAll('#r9-tree-host [data-layer-row]')].map((row) => row.getAttribute('data-at')),
    expanded: document.querySelector('#r9-tree-host [data-layer-row][data-at="#sec"]').getAttribute('aria-expanded')
  }));
  assert.equal(collapsed.state.collapsed.includes('#sec'), true);
  assert.equal(collapsed.rows.includes('#box'), false, `折叠后不应有 #box：${collapsed.rows.join(',')}`);
  assert.equal(collapsed.rows.includes('#label'), false);
  assert.equal(collapsed.expanded, 'false');

  /* 再展开：恢复 */
  await page.click('#r9-tree-host [data-layer-row][data-at="#sec"] [data-twisty]');
  const expanded = await page.evaluate(() => ({
    state: window.__tree.getState(),
    rows: [...document.querySelectorAll('#r9-tree-host [data-layer-row]')].map((row) => row.getAttribute('data-at'))
  }));
  assert.ok(expanded.rows.includes('#box') && expanded.rows.includes('#label'));
  assert.deepEqual(expanded.state.visible, visibleBefore);

  /* 折叠 #box 后重新 select 别的层：展开状态保持（不塌） */
  await page.click('#r9-tree-host [data-layer-row][data-at="#box"] [data-twisty]');
  const reSelected = await page.evaluate(() => {
    window.__tree.setSelected('#note');
    return {
      state: window.__tree.getState(),
      expanded: document.querySelector('#r9-tree-host [data-layer-row][data-at="#box"]').getAttribute('aria-expanded'),
      hasLabel: !!document.querySelector('#r9-tree-host [data-layer-row][data-at="#label"]')
    };
  });
  assert.equal(reSelected.state.collapsed.includes('#box'), true);
  assert.equal(reSelected.expanded, 'false');
  assert.equal(reSelected.hasLabel, false, '折叠着的 #box 不应因为 setSelected 而展开');

  evidence.cases['S18-A3'] = {
    ok: true,
    visibleBefore,
    collapsed: { visible: collapsed.state.visible, expanded: collapsed.expanded },
    reSelected: { collapsed: reSelected.state.collapsed, expanded: reSelected.expanded, hasLabel: reSelected.hasLabel }
  };
  await handle.dispose();
});

/* ── A4 ─────────────────────────────────────────────────────────────────── */

test('S18-A4 锁定层显示锁标记且不可选中', async () => {
  const { handle, page } = await openFixture();
  await mountTree(page, { lockedAts: ['#locked-card'] });

  const row = await page.evaluate(() => {
    const el = document.querySelector('#r9-tree-host [data-layer-row][data-at="#locked-card"]');
    return {
      exists: !!el,
      locked: el?.getAttribute('data-locked'),
      disabled: el?.getAttribute('aria-disabled'),
      lockText: el?.querySelector('[data-lock]')?.textContent ?? null,
      hasLockChip: !!el?.querySelector('[data-lock]')
    };
  });
  assert.equal(row.exists, true);
  assert.equal(row.locked, 'true');
  assert.equal(row.disabled, 'true');
  assert.equal(row.hasLockChip, true);
  assert.equal(row.lockText, '锁定');

  /* aria-disabled 会让 Playwright 的可操作性检查一直等 —— force 仍然发真实鼠标事件 */
  await page.click('#r9-tree-host [data-layer-row][data-at="#locked-card"]', { force: true });
  const after = await page.evaluate(() => ({ events: window.__events, status: window.__tree.getState().status }));
  assert.deepEqual(after.events, [], '锁定层不应触发 onSelect');
  assert.equal(after.status, 'LOCKED');

  /* 直接调 select 也不通（不是只挡了鼠标） */
  const direct = await page.evaluate(() => window.__tree.select('#locked-card'));
  assert.equal(direct.ok, false);
  assert.equal(direct.code, 'LOCKED');

  evidence.cases['S18-A4'] = {
    ok: true,
    row,
    events: after.events,
    status: after.status,
    direct,
    policy: '不可选中（点击/Enter/select() 都拒绝，记 data-tree-status=LOCKED）'
  };
  await handle.dispose();
});

/* ── A5 ─────────────────────────────────────────────────────────────────── */

test('S18-A5 不传 deps.tree → 仍是 R8 面板（无树、无下拉）；传了 → 树 + 同 id 字段', async () => {
  const { handle, page } = await openFixture();
  const snap = await layersOf(page);
  const layers = snap.layers;

  const without = await page.evaluate(mountPanelLive, {
    bundle: BUNDLE_URL,
    css: TREE_CSS,
    hostStyle: HOST_STYLE,
    layers,
    clip: 'card-a',
    at: '#label',
    withTree: false
  });
  assert.deepEqual(without.children, ['film-inspector'], `容器子节点应与 R8 一致：${JSON.stringify(without.children)}`);
  assert.equal(without.treeCount, 0);
  /* S51 改口：R8 时那句「面板里没有 <select>（下拉在 App 侧）」已经不成立 ——
     `filter` / `mixBlendMode` / `backdropFilter` 是枚举/预设字段，控件就是 `<select>`，
     由**字段模型**（`control:'select'`）驱动。换成等价的硬约束：下拉只出现在这些字段上，
     多一个（比如给 `fontSize` 塞下拉）或少一个都会红。S54 的裁切单位下拉同理。 */
  const selectRows = await page.evaluate(() =>
    [...document.querySelectorAll('.film-inspector .inspector-field')]
      .filter((row) => row.querySelector('select'))
      .map((row) => row.getAttribute('data-field'))
  );
  /* S54 追加：裁切行有「px/%」单位下拉（`control:'inset'`），背景图的尺寸/位置也是枚举下拉。
     下拉清单因此多三个 —— 仍然是「只出现在枚举/预设/单位选择上」的等价约束。 */
  assert.deepEqual(
    selectRows,
    ['filter', 'mixBlendMode', 'backdropFilter', 'clipPath', 'backgroundSize', 'backgroundPosition'],
    `下拉应只出现在枚举/预设/单位字段：${selectRows.join(',')}`
  );
  for (const id of ['text', 'fontSize', 'x', 'y', 'w', 'h', 'rotation']) {
    assert.ok(without.fields.includes(id), `R8 字段缺 ${id}：${without.fields.join(',')}`);
  }

  await page.evaluate(() => document.querySelector('#r9-panel-host')?.remove());
  const mounted = await page.evaluate(mountPanelLive, {
    bundle: BUNDLE_URL,
    css: TREE_CSS,
    hostStyle: HOST_STYLE,
    layers,
    clip: 'card-a',
    at: '#label',
    withTree: true
  });
  assert.deepEqual(mounted.children, ['film-inspector-tree', 'film-inspector'], `带树时：${JSON.stringify(mounted.children)}`);
  assert.equal(mounted.treeCount, 1);
  for (const id of ['text', 'fontSize', 'x', 'y', 'w', 'h', 'rotation']) {
    assert.ok(mounted.fields.includes(id), `带树后字段 id 不应变：缺 ${id}`);
  }
  assert.ok(mounted.treeRows.length >= 4, `树应有 4+ 行：${mounted.treeRows.length}`);
  assert.equal(mounted.treeRows.find((row) => row.at === '#label')?.selected, 'true', '当前选中应在树里高亮');

  /* 点树里的父级 → 面板真的换了层（select 在第一个 await 之前就同步写 state.ref） */
  await page.click('#r9-panel-host [data-inspector-tree] [data-layer-row][data-at="#box"]');
  const after = await page.evaluate(() => window.__panel.getState());
  assert.equal(after.at, '#box', `面板应切到 #box：${after.at}`);

  evidence.cases['S18-A5'] = {
    ok: true,
    withoutTree: { children: without.children, treeCount: without.treeCount, hasSelect: without.hasSelect, fields: without.fields },
    withTree: { children: mounted.children, treeCount: mounted.treeCount, fields: mounted.fields, rows: mounted.treeRows.length },
    panelAfterTreeClick: { at: after.at, fields: after.fields.map((field) => field.id) }
  };
  await handle.dispose();
});

/* ── A6 ─────────────────────────────────────────────────────────────────── */

test('S18-A6 键盘：↑↓ 移动活动行、←→ 折叠展开、Enter 选中', async () => {
  const { handle, page } = await openFixture();
  await mountTree(page);

  await page.evaluate(() => document.querySelector('[data-layer-tree]').focus());
  await page.keyboard.press('ArrowDown');
  const afterDown = await page.evaluate(() => {
    const state = window.__tree.getState();
    return { activeAt: state.activeAt, activedescendant: document.querySelector('[data-layer-tree]').getAttribute('aria-activedescendant') };
  });
  assert.equal(afterDown.activeAt, '#stage', `↓ 应落在第一行：${afterDown.activeAt}`);
  assert.ok(afterDown.activedescendant, 'aria-activedescendant 应指向活动行');

  await page.keyboard.press('ArrowDown');
  const afterDown2 = await page.evaluate(() => window.__tree.getState().activeAt);
  assert.equal(afterDown2, '#sec');
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.evaluate(() => window.__tree.getState().activeAt), '#stage');

  /* → 折展：先 ↓ 到 section，再 ← 折叠、→ 展开 */
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowLeft');
  const afterLeft = await page.evaluate(() => ({
    expanded: document.querySelector('#r9-tree-host [data-layer-row][data-at="#sec"]').getAttribute('aria-expanded'),
    visible: window.__tree.getState().visible,
    activeAt: window.__tree.getState().activeAt
  }));
  assert.equal(afterLeft.expanded, 'false');
  assert.equal(afterLeft.visible.includes('#box'), false);
  assert.equal(afterLeft.activeAt, '#sec', '折叠后活动行应留在父级');

  await page.keyboard.press('ArrowRight');
  const afterRight = await page.evaluate(() => ({
    expanded: document.querySelector('#r9-tree-host [data-layer-row][data-at="#sec"]').getAttribute('aria-expanded'),
    visible: window.__tree.getState().visible
  }));
  assert.equal(afterRight.expanded, 'true');
  assert.ok(afterRight.visible.includes('#box'));

  /* ↓↓↓ 到 #label，Enter 选中 */
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const atLabel = await page.evaluate(() => window.__tree.getState().activeAt);
  assert.equal(atLabel, '#label');
  await page.keyboard.press('Enter');
  const afterEnter = await page.evaluate(() => ({ events: window.__events, state: window.__tree.getState() }));
  assert.deepEqual(afterEnter.events, ['#label']);
  assert.equal(afterEnter.state.selectedAt, '#label');

  evidence.cases['S18-A6'] = {
    ok: true,
    down: afterDown,
    down2: afterDown2,
    left: afterLeft,
    right: afterRight,
    enter: { activeAt: atLabel, events: afterEnter.events, selectedAt: afterEnter.state.selectedAt }
  };
  await handle.dispose();
});

/* ── A7 ─────────────────────────────────────────────────────────────────── */

test('S18-A7 截图 1 张（3 级树 + 真实场景）', async () => {
  /* 真实样例场景 scene-a.html：复制到本批 projects 下（SceneHost 只服务仓库根） */
  const dir = path.join(PROJECTS, `s18-a7-${process.pid}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.copyFile(path.join(SAMPLE, 'scene-a.html'), path.join(dir, 'scene-a.html'));
  const rel = path.relative(REPO_ROOT, path.join(dir, 'scene-a.html')).split(path.sep).join('/');

  const { handle, page } = await openFixture(rel);
  const sceneText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 120));
  assert.ok(sceneText.includes('图层编辑测试'), `场景文字：${sceneText}`);

  const { state } = await mountTree(page, { lockedAts: ['#badge'], selectedAt: '#title' });
  const depths = [...new Set(state.nodes.map((node) => node.depth))].sort((a, b) => a - b);
  assert.ok(depths.length >= 3, `应至少 3 级：${depths.join(',')}`);

  const shot = path.join(EVIDENCE_DIR, 's18-a7-tree.png');
  await page.screenshot({ path: shot });
  const stat = await fs.stat(shot);
  assert.ok(stat.size > 10240, `截图应 >10KB：${stat.size}`);

  evidence.cases['S18-A7'] = {
    ok: true,
    scene: rel,
    sceneText,
    depths,
    nodes: state.nodes.length,
    lockedRow: state.nodes.find((node) => node.at === '#badge') ?? null,
    bytes: stat.size
  };
  await handle.dispose();
});
