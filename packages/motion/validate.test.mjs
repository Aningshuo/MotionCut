// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S34-DISCOVER-VALIDATE 验收 B1..B5
 *
 * B1 R16-C1 的四条非法用例：全部 ok=false，issue 指到具体参数名（贴 4 组 JSON）。
 * B2 合法用例零 issue（回归，防「只加严不加准」）。
 * B3 mergeParams 冲突策略：类型冲突 / 范围冲突 / 手写多出参数，各给结果。
 * B4 面板 1.1.0 向后兼容：v1 形状（没有新字段）仍能挂载、渲染、应用（截图）。
 * B5 deterministic=false：notice 文案含「不受帧驱动」，可关，应用仍允许（截图）。
 *
 * 运行：node --test --test-concurrency=1 packages/motion/validate.test.mjs
 * （环境路径见 RUN_ROOT：OPENCUT_ENV_JSON 优先，否则自动建 .local-runs/layers/motion-validate/env.json）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { build as esbuild } from 'esbuild';
import { SceneHost, REPO_ROOT } from '../scene-runtime/host.mjs';
import { resolveLayerTestEnv } from '../layers/test-env.mjs';
import {
  DISCOVERY_ERROR_CODES,
  checkSpecDomain,
  discoverControls,
  mergeParams
} from './discover.mjs';
import {
  MOTION_NONDETERMINISTIC_TEXT,
  MOTION_PANEL_MAJOR,
  MOTION_PANEL_VERSION,
  mountMotionPanel
} from './panel.mjs';

/* S57：环境可移植（R37-C5）。OPENCUT_ENV_JSON 优先；否则现建 `.local-runs/layers/motion-validate/env.json`。 */
const TEST_ENV = await resolveLayerTestEnv({ suite: 'motion-validate' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');
const BUNDLE_ABS = path.join(RUN_ROOT, 'tmp/s34/bundle.js');
const BUNDLE_URL = '/' + path.relative(REPO_ROOT, BUNDLE_ABS).split(path.sep).join('/');
const PANEL_FIXTURE = 'tests/fixtures/scenes/motion-panel-stage.html';
const BATCH = 'B-SUB1-R17-017';

const evidence = {
  batch: BATCH,
  suite: 'validate.test.mjs',
  cases: {},
  discoverySchema: {},
  screenshots: [],
  startedAt: new Date().toISOString()
};

/** @type {SceneHost} */
let host;

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function buildBundle() {
  await fs.mkdir(path.dirname(BUNDLE_ABS), { recursive: true });
  await esbuild({
    stdin: { contents: "export { mountMotionPanel } from './packages/motion/panel.mjs';", resolveDir: REPO_ROOT, loader: 'js' },
    bundle: true,
    format: 'iife',
    globalName: 'R34',
    platform: 'browser',
    target: 'es2022',
    outfile: BUNDLE_ABS,
    logLevel: 'silent'
  });
}

async function save() {
  const files = [];
  for (const name of ['s34-b4-compat.png', 's34-b5-warning.png']) {
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
  await fs.writeFile(path.join(EVIDENCE_DIR, 's34-discover-validate.json'), JSON.stringify(evidence, null, 2) + '\n');
}

before(async () => {
  const env = JSON.parse(await fs.readFile(path.join(RUN_ROOT, 'env.json'), 'utf8'));
  evidence.batch = env.batchId ?? evidence.batch;
  await buildBundle();
  host = await new SceneHost({ port: Number(env.sceneOrigin || 59375), viewport: { width: 1280, height: 720 } }).start();
  evidence.browser = host.browserVersion;
});

after(async () => {
  await save();
  if (host) await host.stop();
});

/** 一条标注 → 一行 HTML（`<i>` 声明项） */
function annotation(attrs) {
  const parts = Object.entries(attrs).map(([key, value]) => `${key}="${String(value)}"`);
  return `<i ${parts.join(' ')}></i>`;
}

const P = (name) => `data-motion-param="${name}"`;

/* ── B1 四条非法用例 ─────────────────────────────────────────────── */

test('B1 值域越界/自相矛盾一律 ok=false，issue 指到参数名（不静默夹紧）', async () => {
  /** @type {Record<string, {html: string, code: string, key: string}>} */
  const cases = {
    'number 默认值超上限（-5..5 里放 99）': {
      html: annotation({ [P('duration')]: '', 'data-motion-type': 'number', 'data-motion-min': '-5', 'data-motion-max': '5', 'data-motion-default': '99' }),
      code: DISCOVERY_ERROR_CODES.BAD_DEFAULT,
      key: 'duration'
    },
    'number 下限大于上限（min 9 / max 1）': {
      html: annotation({ [P('size')]: '', 'data-motion-type': 'number', 'data-motion-min': '9', 'data-motion-max': '1' }),
      code: DISCOVERY_ERROR_CODES.BAD_RANGE,
      key: 'size'
    },
    'string 默认值超 maxlength（6 字 / 限 3）': {
      html: annotation({ [P('label')]: '', 'data-motion-type': 'string', 'data-motion-maxlength': '3', 'data-motion-default': 'abcdef' }),
      code: DISCOVERY_ERROR_CODES.BAD_DEFAULT,
      key: 'label'
    },
    'color 默认值不是合法色值': {
      html: annotation({ [P('tint')]: '', 'data-motion-type': 'color', 'data-motion-default': 'not-a-color' }),
      code: DISCOVERY_ERROR_CODES.BAD_DEFAULT,
      key: 'tint'
    }
  };

  /** @type {Record<string, any>} */
  const results = {};
  for (const [name, item] of Object.entries(cases)) {
    const found = discoverControls(item.html, { file: `${name}.html` });
    assert.equal(found.ok, false, `${name} 竟然通过了——值域没校验`);
    const hit = found.issues.find((issue) => issue.key === item.key);
    assert.ok(hit, `${name} 的 issue 没指到 ${item.key}：${JSON.stringify(found.issues)}`);
    assert.equal(hit.code, item.code, `${name} 的错误码不对：${JSON.stringify(found.issues)}`);
    assert.ok(hit.line >= 1);
    results[name] = { ok: found.ok, issues: found.issues, params: Object.keys(found.params) };
  }

  /* 夹紧是禁止项：越界的默认值不能被「修好」后悄悄放行 */
  const clamped = discoverControls(
    annotation({ [P('n')]: '', 'data-motion-type': 'number', 'data-motion-min': '0', 'data-motion-max': '10', 'data-motion-default': '99' }),
    { file: 'clamp.html' }
  );
  assert.equal(clamped.ok, false);
  assert.equal(Object.prototype.hasOwnProperty.call(clamped.params, 'n'), false, '越界参数不该出现在 params 里（更不该被夹到 10）');

  /* checkSpecDomain 单独也能用（宿主/CI 可以直接调） */
  assert.deepEqual(checkSpecDomain('x', { type: 'number', min: 5, max: 1 }), [{ code: 'BAD_RANGE', detail: 'MIN_ABOVE_MAX' }]);

  evidence.cases.B1 = results;
  evidence.discoverySchema.domainCodes = [
    { code: 'BAD_DEFAULT', when: '默认值越界 / 超 maxlength / 不是合法色值 / 不在枚举里 / 不是数字' },
    { code: 'BAD_RANGE', when: 'min > max / step <= 0 / maxlength 不是正整数' }
  ];
});

/* ── B2 合法用例零 issue（回归） ─────────────────────────────────── */

test('B2 合法用例零 issue：边界值、枚举、颜色、布尔都不该被误伤', async () => {
  const html = [
    annotation({ [P('a')]: '', 'data-motion-type': 'number', 'data-motion-min': '0', 'data-motion-max': '10', 'data-motion-step': '5', 'data-motion-default': '10' }),
    annotation({ [P('b')]: '', 'data-motion-type': 'string', 'data-motion-maxlength': '3', 'data-motion-default': 'abc' }),
    annotation({ [P('c')]: '', 'data-motion-type': 'color', 'data-motion-default': '#3b82f6' }),
    annotation({ [P('d')]: '', 'data-motion-type': 'color', 'data-motion-default': 'rgb(59, 130, 246)' }),
    annotation({ [P('e')]: '', 'data-motion-type': 'enum', 'data-motion-options': 'a,b', 'data-motion-default': 'b' }),
    annotation({ [P('f')]: '', 'data-motion-type': 'boolean', 'data-motion-default': 'false' }),
    annotation({ [P('g')]: '', 'data-motion-type': 'number', 'data-motion-min': '-5', 'data-motion-max': '5', 'data-motion-default': '-5' })
  ].join('\n');

  const found = discoverControls(html, { file: 'valid.html' });
  assert.deepEqual(found.issues, [], `合法用例被误伤：${JSON.stringify(found.issues)}`);
  assert.equal(found.ok, true);
  assert.deepEqual(Object.keys(found.params), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.equal(found.params.a.default, 10);
  assert.equal(found.params.b.default, 'abc');
  assert.equal(found.params.f.default, false);
  assert.equal(found.params.g.default, -5);

  evidence.cases.B2 = { params: found.params, issues: found.issues };
});

/* ── B3 mergeParams 冲突策略 ────────────────────────────────────── */

test('B3 冲突策略写死：手写赢 + 留痕，三类各一例', async () => {
  /* ① 类型冲突：手写 number / 标注 string */
  const typeConflict = mergeParams(
    { size: { type: 'number', min: 10, max: 20, default: 14, label: '手写字号' } },
    { size: { type: 'string', maxLength: 8, default: '14', label: '字号' } }
  );
  assert.deepEqual(typeConflict.conflicts, ['size']);
  assert.equal(typeConflict.kinds.size, 'TYPE');
  assert.equal(typeConflict.params.size.type, 'number', '类型冲突时应该手写赢');
  assert.equal(typeConflict.issues[0].conflict, 'TYPE');
  assert.match(typeConflict.issues[0].detail, /类型冲突：手写 number \/ 标注 string/);

  /* ② 范围冲突：同类型但 min/max 不同 */
  const rangeConflict = mergeParams(
    { duration: { type: 'number', min: 200, max: 4000, step: 100, default: 1200 } },
    { duration: { type: 'number', min: 100, max: 2000, step: 50, default: 1000 } }
  );
  assert.deepEqual(rangeConflict.conflicts, ['duration']);
  assert.equal(rangeConflict.kinds.duration, 'RANGE');
  assert.equal(rangeConflict.params.duration.max, 4000, '范围冲突时应该手写赢');
  assert.equal(rangeConflict.issues[0].conflict, 'RANGE');

  /* ③ 手写多出参数：标注里没有这个键，不该报冲突，也不该丢 */
  const extra = mergeParams(
    { label: { type: 'string', maxLength: 24, default: '脉冲', apply: { kind: 'text', selector: '.pulse-label' } } },
    { color: { type: 'color', default: '#3b82f6', label: '主色' } }
  );
  assert.deepEqual(extra.handwrittenOnly, ['label']);
  assert.deepEqual(extra.added, ['color']);
  assert.deepEqual(extra.conflicts, []);
  assert.equal(extra.issues.length, 0, '手写多出参数不是冲突');
  assert.deepEqual(Object.keys(extra.params), ['label', 'color'], '手写参数必须保留，标注参数要补进来');

  evidence.cases.B3 = {
    typeConflict: { kinds: typeConflict.kinds, params: typeConflict.params, issues: typeConflict.issues },
    rangeConflict: { kinds: rangeConflict.kinds, params: rangeConflict.params, issues: rangeConflict.issues },
    handwrittenExtra: { handwrittenOnly: extra.handwrittenOnly, added: extra.added, params: Object.keys(extra.params) }
  };
});

/* ── 面板挂载脚手架（B4/B5 共用） ────────────────────────────────── */

async function mountPanel(views) {
  const handle = await host.open(PANEL_FIXTURE);
  const page = handle.page;
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.addScriptTag({ url: BUNDLE_URL });
  await page.evaluate(async (arg) => {
    const rail = document.getElementById('rail');
    rail.textContent = '';
    window.__applied = [];
    window.__panel = window.R34.mountMotionPanel(rail, {
      loadLibrary: async () => ({ ok: true, entries: arg.views }),
      applyEntry: async (id, params) => {
        window.__applied.push({ id, params });
        return { ok: true };
      }
    });
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  }, { views });
  await page.waitForFunction(() => {
    const state = window.__panel?.getState();
    return !!state && state.phase !== 'loading';
  });
  return { handle, page, pageErrors };
}

/** v1 形状（只有 1.0.0 就有的字段） */
const V1_VIEWS = [
  {
    id: 'motion_a',
    name: 'pulse',
    kind: 'animation',
    sourceOk: true,
    assetIssues: [],
    params: [
      { name: 'duration', label: '周期（ms）', type: 'number', default: 1200, min: 200, max: 4000, step: 100 },
      { name: 'easing', label: '缓动', type: 'enum', default: 'ease-out', options: ['ease-out', 'ease-in', 'linear'] }
    ]
  }
];

/* ── B4 1.1.0 向后兼容 ─────────────────────────────────────────── */

test('B4 v1 形状的条目仍能挂载、渲染、应用（1.1.0 只做加法）', async () => {
  const { handle, page, pageErrors } = await mountPanel(V1_VIEWS);

  const state = await page.evaluate(() => window.__panel.getState());
  assert.equal(state.interfaceVersion, MOTION_PANEL_VERSION);
  assert.equal(MOTION_PANEL_MAJOR, 1);
  assert.equal(state.counts.entries, 1);
  assert.equal(state.entries[0].deterministic, undefined, 'v1 条目没有 deterministic，应是 undefined（未知）');
  assert.equal(state.entries[0].expectedDurationMs, null);
  assert.equal(state.selected, null);

  /* 没有警示块（未知 ≠ 不可复现） */
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-motion-nondeterministic]').length), 0);

  /* 旧路径照常工作：选条目 → 改值 → 应用 */
  await page.click('[data-motion-entry]');
  await page.waitForSelector('[data-motion-input][data-param="duration"]');
  await page.fill('[data-motion-input][data-param="duration"]', '2400');
  await page.click('[data-motion-apply]');
  await page.waitForFunction(() => window.__applied.length > 0);
  const applied = await page.evaluate(() => window.__applied);
  assert.equal(applied[0].params.duration, 2400);
  assert.equal(applied[0].params.easing, 'ease-out');

  await page.screenshot({ path: path.join(EVIDENCE_DIR, 's34-b4-compat.png') });
  assert.deepEqual(pageErrors, []);
  await handle.dispose();

  evidence.cases.B4 = {
    interfaceVersion: state.interfaceVersion,
    deterministicOfV1Entry: state.entries[0].deterministic ?? null,
    hasWarningBlock: false,
    applied: applied[0],
    screenshot: 's34-b4-compat.png'
  };
});

/* ── B5 deterministic=false 的提示 ─────────────────────────────── */

test('B5 deterministic=false：notice 含「不受帧驱动」，可关，应用仍允许（截图）', async () => {
  const view = {
    ...V1_VIEWS[0],
    deterministic: false,
    expectedDurationMs: 1200
  };
  const { handle, page, pageErrors } = await mountPanel([view]);

  await page.click('[data-motion-entry]');
  await page.waitForSelector('[data-motion-nondeterministic]');
  const notice = await page.evaluate(() => document.querySelector('[data-motion-nondeterministic-text]')?.textContent ?? '');
  assert.equal(notice, MOTION_NONDETERMINISTIC_TEXT);
  assert.match(notice, /不受帧驱动/);

  /* 时长是新增的可选字段，显示成秒 */
  const durationText = await page.evaluate(() => document.querySelector('[data-motion-duration]')?.textContent ?? '');
  assert.match(durationText, /1\.20s/);
  /* 列表行也能一眼看出 */
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-motion-row-nondeterministic]').length), 1);

  await page.screenshot({ path: path.join(EVIDENCE_DIR, 's34-b5-warning.png') });

  /* 应用仍然允许，而且 notice 里带同一句 */
  await page.fill('[data-motion-input][data-param="duration"]', '2400');
  await page.click('[data-motion-apply]');
  await page.waitForFunction(() => window.__applied.length > 0);
  const resultText = await page.evaluate(() => document.querySelector('[data-motion-result]')?.textContent ?? '');
  assert.match(resultText, /不受帧驱动/, `应用结果里没带提示：${resultText}`);
  const applied = await page.evaluate(() => window.__applied);
  assert.equal(applied.length, 1, '有提示不代表不许应用');

  /* 可关：点「知道了」后同一屏不再出现，且换回该条目也不再弹 */
  await page.click('[data-motion-dismiss-warning]');
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-motion-nondeterministic]').length), 0);
  const afterDismiss = await page.evaluate(() => window.__panel.getState());
  assert.equal(afterDismiss.selected.warningVisible, false);
  assert.deepEqual(afterDismiss.warnings, [MOTION_NONDETERMINISTIC_TEXT], 'warnings 仍应说明这条不受帧驱动');

  assert.deepEqual(pageErrors, []);
  await handle.dispose();

  evidence.cases.B5 = {
    notice,
    durationText,
    rowBadge: 1,
    resultText,
    applied: applied[0],
    afterDismiss: { warningVisible: afterDismiss.selected.warningVisible, warnings: afterDismiss.warnings },
    screenshot: 's34-b5-warning.png'
  };
});

/* ── B6（额外）扫不到就 unknown，不写死 true ─────────────────────── */

test('B6 saveAsTemplate：样式表读不到时 deterministic 留空（unknown），不默认 true', async () => {
  const { saveAsTemplate, readLibrary } = await import('./library.mjs');
  const root = path.join(RUN_ROOT, 'projects', `unknown-${process.pid}`);
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(path.join(root, 'scenes'), { recursive: true });
  /* 引用了不存在的样式表：扫不到，就判不了 */
  await fs.writeFile(
    path.join(root, 'scenes/src.html'),
    '<!doctype html><html><head><link rel="stylesheet" href="./missing.css"></head><body><div class="x"></div></body></html>',
    'utf8'
  );
  const saved = await saveAsTemplate(root, { name: 'unknown-demo', kind: 'component', from: 'scenes/src.html', params: {} });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.entry.deterministic, undefined, '扫不到时不该默认成 true');
  assert.equal(Object.prototype.hasOwnProperty.call(saved.entry, 'deterministic'), false, '未知就整个键都不该写');

  const { library } = await readLibrary(root);
  const entry = library.entries.find((item) => item.name === 'unknown-demo');
  assert.equal(entry.deterministic, undefined);
  const raw = await fs.readFile(path.join(root, 'motion/library.json'), 'utf8');
  assert.equal(raw.includes('deterministic'), false, '未知不该落盘成布尔');

  evidence.cases.B6 = { savedDeterministic: null, keyPresent: false, persisted: false };
});
