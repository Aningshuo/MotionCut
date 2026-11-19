// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S27-MOTION-PANEL 验收 A1..A9
 *
 * 真 Chromium（SceneHost）+ 真舞台 fixture（`motion-panel-stage.html`）：左边舞台、右边 rail 挂面板。
 * 面板的宿主依赖（`loadLibrary` / `applyEntry`）是页内 stub，**可被测试随时改状态**，
 * 所以「加载失败 → 重试」「应用失败 → 显示码」「20 次挂卸」都能真跑，不靠 mock 库。
 *
 * A4 的三种非法值：
 * - number 越界：直接往输入框里打 9999（max=5000）；
 * - enum 不在 options：往 `<select>` 里塞一个 schema 没有的 option 再选中
 *   （真实浏览器里宿主渲染了过期 option 就是这样）；
 * - 未知键：往表单里塞一行 `data-motion-input` 但 param 不在 schema 里（宿主塞了过期参数行）。
 *   三条都必须「就地拒绝 + 逐条错误 + 一次 applyEntry 都不调」。
 *
 * A5S 是补测：面板里的按下不能被舞台手势抢（`data-no-stage-gesture` 豁免）。
 *
 * 运行：node --test --test-concurrency=1 packages/motion/panel.test.mjs
 * （环境路径见 RUN_ROOT：OPENCUT_ENV_JSON 优先，否则自动建 .local-runs/layers/motion-panel/env.json）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { build as esbuild } from 'esbuild';
import { SceneHost, REPO_ROOT } from '../scene-runtime/host.mjs';
import { resolveLayerTestEnv } from '../layers/test-env.mjs';

/* S57：环境可移植（R37-C5）。OPENCUT_ENV_JSON 优先；否则现建 `.local-runs/layers/motion-panel/env.json`。 */
const TEST_ENV = await resolveLayerTestEnv({ suite: 'motion-panel' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');
const BUNDLE_ABS = path.join(RUN_ROOT, 'tmp/s27/motion.mjs');
const BUNDLE_URL = '/' + path.relative(REPO_ROOT, BUNDLE_ABS).split(path.sep).join('/');
const FIXTURE = 'tests/fixtures/scenes/motion-panel-stage.html';

const BATCH = 'B-SUB1-R14-014';

/** 三条目：一条源缺失、两/两条来源可用；参数类型覆盖 number/enum/boolean/color/string。 */
const ENTRIES = [
  {
    id: 'motion_card',
    name: 'card-flip',
    kind: 'animation',
    sourceOk: true,
    assetIssues: [],
    params: [
      { name: 'duration', label: '时长', type: 'number', default: 800, min: 100, max: 5000, step: 10 },
      { name: 'easing', label: '缓动', type: 'enum', default: 'ease-out', options: ['ease-out', 'ease-in', 'linear'] },
      { name: 'loop', label: '循环', type: 'boolean', default: false },
      { name: 'tint', label: '主色', type: 'color', default: '#3b82f6' },
      { name: 'label', label: '标题', type: 'string', default: '卡片翻转' },
      { name: 'repeat', label: '重复次数', type: 'number', default: 1, min: 1, max: 10, step: 1 },
      { name: 'delay', label: '延迟（可留空）', type: 'number', min: 0, max: 3000, step: 10 }
    ]
  },
  {
    id: 'motion_badge',
    name: 'badge-pop',
    kind: 'component',
    sourceOk: true,
    assetIssues: [],
    params: [
      { name: 'scale', label: '弹跳', type: 'number', default: 1.2, min: 0.1, max: 4, step: 0.1 },
      { name: 'tone', label: '语气', type: 'enum', default: 'info', options: ['info', 'warn'] }
    ]
  },
  {
    id: 'motion_stale',
    name: 'card-stale',
    kind: 'saved',
    sourceOk: false,
    assetIssues: [
      { path: 'scenes/card-stale.html', reason: '源文件不存在' },
      { path: 'assets/bg.png', reason: '资源不存在' }
    ],
    params: [{ name: 'count', label: '张数', type: 'number', default: 3, min: 1, max: 9, step: 1 }]
  }
];

const evidence = {
  batch: BATCH,
  suite: 'panel.test.mjs',
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
        "export * from './packages/motion/panel.mjs';",
        "export { mountCanvasGesture } from './packages/layers/canvas-gesture.mjs';"
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
  for (const name of ['s27-a1-list.png', 's27-a3-params.png', 's27-a7-empty.png']) {
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
  await fs.writeFile(path.join(EVIDENCE_DIR, 's27-motion-panel.json'), JSON.stringify(evidence, null, 2) + '\n');
}

before(async () => {
  const env = JSON.parse(await fs.readFile(path.join(RUN_ROOT, 'env.json'), 'utf8'));
  evidence.batch = env.batchId ?? evidence.batch;
  await buildBundle();
  host = await new SceneHost({ port: Number(env.sceneOrigin || env.studioPort), viewport: { width: 1440, height: 1000 } }).start();
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

/**
 * 页内挂载面板：宿主 stub 带可变状态（`window.__libState` / `window.__applyState`）。
 * @param {import('playwright').Page} page
 * @param {{entries?: unknown[], libState?: string}} [opts]
 */
async function mountPanel(page, opts = {}) {
  const state = await page.evaluate(
    async (arg) => {
      const mod = await import(arg.bundle);
      const rail = document.getElementById('rail');
      rail.textContent = '';
      window.__entries = arg.entries;
      window.__libState = arg.libState;
      window.__applyState = 'ok';
      window.__calls = [];
      window.__applied = [];
      window.__errors = [];
      window.__loads = 0;
      window.__panel = mod.mountMotionPanel(rail, {
        loadLibrary: async () => {
          window.__loads += 1;
          if (window.__libState === 'fail') {
            return { ok: false, error: { code: 'E_IO', message: 'motion/library.json 读不了' } };
          }
          if (window.__libState === 'empty') return { ok: true, entries: [] };
          return { ok: true, entries: window.__entries };
        },
        applyEntry: async (id, params) => {
          window.__calls.push({ id, params });
          if (window.__applyState === 'fail') {
            return { ok: false, error: { code: 'E_CONFLICT', message: 'expectedHash 不匹配' } };
          }
          return { ok: true };
        },
        onApplied: (result) => {
          window.__applied.push(result);
        },
        onError: (info) => {
          window.__errors.push(info);
        },
        style: arg.style
      });
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      return window.__panel.getState();
    },
    { bundle: BUNDLE_URL, entries: opts.entries ?? ENTRIES, libState: opts.libState ?? 'ok', style: opts.style }
  );
  await page.waitForFunction(() => {
    const s = window.__panel?.getState();
    return !!s && s.phase !== 'loading' && s.phase !== 'idle';
  });
  return state;
}

/** @param {import('playwright').Page} page */
function panelState(page) {
  return page.evaluate(() => window.__panel.getState());
}

/** @param {import('playwright').Page} page */
function harness(page) {
  return page.evaluate(() => ({
    loads: window.__loads,
    calls: window.__calls,
    applied: window.__applied,
    errors: window.__errors
  }));
}

async function shot(page, name) {
  await page.locator('[data-motion-panel]').screenshot({ path: path.join(EVIDENCE_DIR, name) });
}

/**
 * 点「应用」并等一次结果落定。
 * @param {import('playwright').Page} page
 */
async function clickApply(page) {
  await page.evaluate(() => {
    window.__panelBefore = window.__panel.getState().lastResult;
  });
  await page.click('[data-motion-apply]');
  await page.waitForFunction(() => {
    const now = window.__panel.getState().lastResult;
    return !!now;
  });
  return panelState(page);
}

/* ── A1 列表：3 条、源缺失标红 + 原因 ─────────────────────────────── */

test('A1 3 个条目（1 个源缺失）→ 列表 3 行，缺失那条有可见标红与原因', async () => {
  const { page, pageErrors } = await openPage();
  await mountPanel(page);

  const dom = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-motion-entry]')];
    return rows.map((row) => {
      const warn = row.querySelector('[data-motion-source-warn]');
      const count = row.querySelector('[data-motion-asset-count]');
      return {
        id: row.getAttribute('data-id'),
        kind: row.getAttribute('data-kind'),
        sourceOk: row.getAttribute('data-source-ok'),
        assetIssues: row.getAttribute('data-asset-issues'),
        name: row.querySelector('[data-motion-name]')?.textContent ?? '',
        warnText: warn?.textContent ?? '',
        warnColor: warn ? getComputedStyle(warn).color : null,
        warnVisible: warn ? getComputedStyle(warn).display !== 'none' && warn.getBoundingClientRect().width > 0 : false,
        borderColor: getComputedStyle(row).borderColor,
        countText: count?.textContent ?? ''
      };
    });
  });

  assert.equal(dom.length, 3, `应有 3 行，实际 ${dom.length}`);
  assert.deepEqual(dom.map((row) => row.id), ['motion_card', 'motion_badge', 'motion_stale']);

  const stale = dom.find((row) => row.id === 'motion_stale');
  assert.ok(stale, '缺源条目不见了（不可用 != 看不见）');
  assert.equal(stale.sourceOk, 'false');
  assert.equal(stale.assetIssues, '2');
  assert.ok(stale.warnVisible, '源缺失的标红文案不可见');
  assert.match(stale.warnText, /源缺失/);
  assert.equal(stale.warnColor, 'rgb(239, 68, 68)', `标红颜色不对：${stale.warnColor}`);
  assert.equal(stale.countText, '资产问题 2');

  const ok = dom.find((row) => row.id === 'motion_card');
  assert.equal(ok.sourceOk, 'true');
  assert.equal(ok.countText, '资产问题 0');
  assert.equal(ok.warnText, '');

  const state = await panelState(page);
  assert.equal(state.phase, 'ready');
  assert.equal(state.counts.entries, 3);
  assert.equal(state.loads, 1);

  await shot(page, 's27-a1-list.png');
  assert.deepEqual(pageErrors, []);
  evidence.cases.A1 = { rows: dom, state: { phase: state.phase, counts: state.counts } };
});

/* ── A2 搜索 + kind 筛选 ─────────────────────────────────────────── */

test('A2 搜索 "card" 只剩匹配项；kind=animation 只剩动画类', async () => {
  const { page, pageErrors } = await openPage();
  await mountPanel(page);

  await page.fill('[data-motion-search]', 'card');
  const searched = await page.evaluate(() => ({
    ids: [...document.querySelectorAll('[data-motion-entry]')].map((row) => row.getAttribute('data-id')),
    count: document.querySelector('[data-motion-list]')?.getAttribute('data-motion-count'),
    state: window.__panel.getState().counts
  }));
  assert.deepEqual(searched.ids, ['motion_card', 'motion_stale'], `搜索 card 结果不对：${searched.ids.join(',')}`);
  assert.equal(searched.count, '2');

  await page.fill('[data-motion-search]', '');
  await page.selectOption('[data-motion-kind]', 'animation');
  const filtered = await page.evaluate(() => ({
    ids: [...document.querySelectorAll('[data-motion-entry]')].map((row) => row.getAttribute('data-id')),
    kinds: [...document.querySelectorAll('[data-motion-entry]')].map((row) => row.getAttribute('data-kind')),
    state: window.__panel.getState()
  }));
  assert.deepEqual(filtered.ids, ['motion_card']);
  assert.deepEqual(filtered.kinds, ['animation']);
  assert.equal(filtered.state.kind, 'animation');

  /* 搜索 + 筛选叠加：card + component → 空，且给「没有匹配」文案 */
  await page.selectOption('[data-motion-kind]', 'component');
  await page.fill('[data-motion-search]', 'card');
  const none = await page.evaluate(() => ({
    rows: document.querySelectorAll('[data-motion-entry]').length,
    empty: document.querySelector('[data-motion-filter-empty]')?.textContent ?? ''
  }));
  assert.equal(none.rows, 0);
  assert.match(none.empty, /没有匹配/);

  assert.deepEqual(pageErrors, []);
  evidence.cases.A2 = { searched, filtered: { ids: filtered.ids, kinds: filtered.kinds }, none };
});

/* ── A3 参数表单：控件数 == params 数 ────────────────────────────── */

test('A3 参数表单按 schema 生成控件数 == params 数（贴出对照）', async () => {
  const { page, pageErrors } = await openPage();
  await mountPanel(page);
  await page.click('[data-motion-entry][data-id="motion_card"]');
  await page.waitForSelector('[data-motion-form]');

  const table = await page.evaluate(() => {
    const fields = [...document.querySelectorAll('[data-motion-field]')].map((field) => {
      const input = field.querySelector('[data-motion-input]');
      return {
        param: field.getAttribute('data-param'),
        type: field.getAttribute('data-type'),
        control: input ? input.tagName.toLowerCase() : null,
        inputType: input ? input.getAttribute('type') : null,
        value: input ? (input.getAttribute('type') === 'checkbox' ? String(input.checked) : input.value) : null,
        range: field.querySelector('[data-motion-range]')?.textContent ?? ''
      };
    });
    const state = window.__panel.getState();
    return { fields, paramCount: state.entryParams.length, entryParams: state.entryParams, fieldsState: state.fields };
  });

  assert.equal(table.paramCount, 7);
  assert.equal(table.fields.length, table.paramCount, `控件数 ${table.fields.length} != params 数 ${table.paramCount}`);
  assert.deepEqual(
    table.fields.map((f) => f.param),
    table.entryParams
  );
  const byParam = Object.fromEntries(table.fields.map((f) => [f.param, f]));
  assert.equal(byParam.duration.control, 'input');
  assert.equal(byParam.duration.inputType, 'number');
  assert.match(byParam.duration.range, /最小 100/);
  assert.match(byParam.duration.range, /最大 5000/);
  assert.match(byParam.duration.range, /步长 10/);
  assert.equal(byParam.easing.control, 'select');
  assert.equal(byParam.loop.control, 'input');
  assert.equal(byParam.loop.inputType, 'checkbox');
  assert.equal(byParam.tint.control, 'input');
  assert.equal(byParam.tint.inputType, 'text');
  assert.equal(byParam.label.inputType, 'text');
  assert.equal(byParam.delay.value, '', '无默认值的可选参数应留空');

  /* 取色器是「帮选」，文本才是真值：两种都在，且只有一个 data-motion-input */
  const color = await page.evaluate(() => {
    const field = document.querySelector('[data-motion-field][data-param="tint"]');
    return {
      picker: !!field.querySelector('[data-motion-color-picker]'),
      inputs: field.querySelectorAll('[data-motion-input]').length
    };
  });
  assert.equal(color.picker, true);
  assert.equal(color.inputs, 1);

  await shot(page, 's27-a3-params.png');
  assert.deepEqual(pageErrors, []);
  evidence.cases.A3 = { paramCount: table.paramCount, fields: table.fields, color };
});

/* ── A4 非法值：就地拒绝、逐条错误、不调 applyEntry ──────────────── */

test('A4 number 越界 / enum 不在 options / 未知键 → 就地拒绝 + 逐条错误，不调 applyEntry', async () => {
  const { page, pageErrors } = await openPage();
  await mountPanel(page);
  await page.click('[data-motion-entry][data-id="motion_card"]');
  await page.waitForSelector('[data-motion-form]');

  /* ① number 越界 */
  await page.fill('input[data-param="duration"]', '9999');
  let after = await clickApply(page);
  let field = await page.evaluate(() => {
    const el = document.querySelector('[data-motion-field][data-param="duration"]');
    return {
      error: el.querySelector('[data-motion-error]')?.textContent ?? '',
      display: el.querySelector('[data-motion-error]')?.style.display ?? '',
      invalid: el.getAttribute('data-invalid'),
      summary: document.querySelector('[data-motion-form-error]')?.textContent ?? ''
    };
  });
  assert.equal(after.lastResult.ok, false);
  assert.equal(after.lastResult.code, 'INVALID_PARAM');
  assert.match(field.error, /ABOVE_MAX/);
  assert.equal(field.display, 'block');
  assert.equal(field.invalid, 'true');
  assert.match(field.summary, /duration/);
  let h = await harness(page);
  assert.equal(h.calls.length, 0, '校验不过不许调 applyEntry');

  /* ② enum 不在 options（塞一个 schema 没有的 option，模拟宿主渲染了过期项） */
  await page.fill('input[data-param="duration"]', '800');
  await page.evaluate(() => {
    const select = document.querySelector('select[data-param="easing"]');
    const option = document.createElement('option');
    option.value = 'bogus';
    option.textContent = 'bogus';
    select.appendChild(option);
    select.value = 'bogus';
  });
  after = await clickApply(page);
  field = await page.evaluate(() => {
    const el = document.querySelector('[data-motion-field][data-param="easing"]');
    return {
      error: el.querySelector('[data-motion-error]')?.textContent ?? '',
      summary: document.querySelector('[data-motion-form-error]')?.textContent ?? ''
    };
  });
  assert.equal(after.lastResult.code, 'INVALID_PARAM');
  assert.match(field.error, /NOT_IN_OPTIONS/);
  assert.match(field.summary, /easing/);
  h = await harness(page);
  assert.equal(h.calls.length, 0);

  /* ③ 未知键：往表单里塞一行 schema 里没有的参数 */
  await page.evaluate(() => {
    const select = document.querySelector('select[data-param="easing"]');
    select.value = 'ease-out';
    const form = document.querySelector('[data-motion-form]');
    const input = document.createElement('input');
    input.setAttribute('data-motion-input', '');
    input.setAttribute('data-param', 'ghost');
    input.setAttribute('data-param-type', 'string');
    input.value = 'stale';
    form.appendChild(input);
  });
  after = await clickApply(page);
  const ghost = await page.evaluate(() => ({
    summary: document.querySelector('[data-motion-form-error]')?.textContent ?? '',
    count: document.querySelector('[data-motion-form-error]')?.getAttribute('data-count'),
    invalidCount: document.querySelectorAll('[data-motion-field][data-invalid="true"]').length
  }));
  assert.equal(after.lastResult.ok, false);
  assert.equal(after.lastResult.code, 'INVALID_PARAM');
  assert.match(ghost.summary, /ghost: UNKNOWN_PARAM/);
  /* 未知键没有对应字段 → 只在汇总里；前两条已复位，所以没有字段是红的 */
  assert.equal(ghost.invalidCount, 0);
  h = await harness(page);
  assert.equal(h.calls.length, 0, '未知键也不许调 applyEntry');

  assert.deepEqual(pageErrors, []);
  evidence.cases.A4 = { after, field, ghost, calls: h.calls.length };
});

/* ── A5 合法值：applyEntry 收到校验后的完整参数 ──────────────────── */

test('A5 合法值 → applyEntry 收到校验后的完整参数（空的可选键不带、留空的默认值补齐）', async () => {
  const { page, pageErrors } = await openPage();
  await mountPanel(page);
  await page.click('[data-motion-entry][data-id="motion_card"]');
  await page.waitForSelector('[data-motion-form]');

  await page.fill('input[data-param="duration"]', '1200');
  await page.selectOption('select[data-param="easing"]', 'ease-in');
  await page.check('input[data-param="loop"]');
  await page.fill('input[data-param="tint"]', '#ff0000');
  await page.fill('input[data-param="label"]', '卡片翻转');
  /* repeat 有默认值 1，故意清空 → 应该被默认值补齐并记进 defaultsApplied */
  await page.fill('input[data-param="repeat"]', '');
  /* delay 无默认值，留空 → 不该出现在参数对象里 */

  const state = await clickApply(page);
  const h = await harness(page);

  assert.equal(state.lastResult.ok, true);
  assert.equal(h.calls.length, 1, `应只调一次 applyEntry，实际 ${h.calls.length}`);
  const call = h.calls[0];
  assert.equal(call.id, 'motion_card');
  assert.deepEqual(Object.keys(call.params).sort(), ['duration', 'easing', 'label', 'loop', 'repeat', 'tint']);
  assert.deepEqual(call.params, {
    duration: 1200,
    easing: 'ease-in',
    loop: true,
    tint: '#ff0000',
    label: '卡片翻转',
    repeat: 1
  });
  assert.ok(state.defaultsApplied.includes('repeat'), `defaultsApplied=${JSON.stringify(state.defaultsApplied)}`);
  assert.deepEqual(h.applied, [{ id: 'motion_card', params: call.params }]);
  assert.equal(state.applies, 1);
  assert.deepEqual(pageErrors, []);
  evidence.cases.A5 = { params: call.params, defaultsApplied: state.defaultsApplied, applied: h.applied };
});

/* ── A5S 补测：面板里的按下不被舞台手势抢 ────────────────────────── */

test('A5S 面板内的按下不被舞台手势抢（data-no-stage-gesture 豁免）', async () => {
  const { page, pageErrors } = await openPage();
  await mountPanel(page);

  const mounted = await page.evaluate(async (bundle) => {
    const mod = await import(bundle);
    const stage = document.getElementById('stage');
    const r = stage.getBoundingClientRect();
    const cards = [...document.querySelectorAll('.card')].map((el) => {
      const b = el.getBoundingClientRect();
      const box = { x: b.x - r.x, y: b.y - r.y, w: b.width, h: b.height };
      return { at: '#' + el.getAttribute('data-card'), box, rect: box, clip: el.getAttribute('data-card') };
    });
    window.__ops = [];
    window.__sel = null;
    window.__gesture = mod.mountCanvasGesture(stage, {
      getStageRect: () => ({ x: r.x, y: r.y, w: r.width, h: r.height, scale: 1 }),
      getSelection: () => window.__sel,
      getLayerRects: () => cards,
      getSnapTargets: () => [],
      onSelectionChange: (ats) => {
        window.__sel = ats.length ? cards.find((card) => card.at === ats[0]) ?? null : null;
      },
      onCommit: (op) => {
        window.__ops.push(op);
      }
    });
    return { cards, stage: { x: r.x, y: r.y, w: r.width, h: r.height } };
  }, BUNDLE_URL);

  /* 先在舞台上点一张卡：手势确实在工作 */
  const card = mounted.cards[0];
  await page.mouse.click(mounted.stage.x + card.box.x + card.box.w / 2, mounted.stage.y + card.box.y + card.box.h / 2);
  let gesture = await page.evaluate(() => ({
    at: window.__gesture.getState().at,
    pointerEvents: document.querySelector('[data-canvas-gesture]').style.pointerEvents
  }));
  assert.equal(gesture.at, '#a', `舞台点选没生效：${gesture.at}`);
  assert.equal(gesture.pointerEvents, 'none');

  /* 再按住面板里的搜索框：手势必须整条忽略（不建橡皮筋、不抢指针捕获） */
  const box = await page.locator('[data-motion-search]').boundingBox();
  await page.mouse.move(box.x + 12, box.y + 8);
  await page.mouse.down();
  const during = await page.evaluate(() => ({
    pointerEvents: document.querySelector('[data-canvas-gesture]').style.pointerEvents,
    at: window.__gesture.getState().at,
    mode: window.__gesture.getState().mode,
    band: document.querySelector('[data-gesture-band]').style.display
  }));
  await page.mouse.up();
  const after = await page.evaluate(() => ({
    pointerEvents: document.querySelector('[data-canvas-gesture]').style.pointerEvents,
    at: window.__gesture.getState().at,
    active: document.activeElement?.getAttribute('data-motion-search') !== null
  }));

  assert.equal(during.pointerEvents, 'none', '面板里的按下被手势层抢了指针（拖拽盾开了）');
  assert.equal(during.mode, null);
  assert.equal(during.band, 'none');
  assert.equal(after.at, '#a', '面板里的按下改了舞台选中');
  assert.equal(after.active, true, '搜索框没拿到焦点（说明按下被 preventDefault）');

  await page.evaluate(() => window.__gesture.destroy());
  assert.deepEqual(pageErrors, []);
  evidence.cases.A5S = { gesture, during, after };
});

/* ── A6 应用失败：显示码、不崩、不假装成功 ───────────────────────── */

test('A6 applyEntry 返回失败码 → 界面显示该码，不崩、不假装成功', async () => {
  const { page, pageErrors } = await openPage();
  await mountPanel(page);
  await page.click('[data-motion-entry][data-id="motion_card"]');
  await page.waitForSelector('[data-motion-form]');

  await page.evaluate(() => {
    window.__applyState = 'fail';
  });
  const state = await clickApply(page);
  const view = await page.evaluate(() => ({
    result: document.querySelector('[data-motion-result]')?.textContent ?? '',
    ok: document.querySelector('[data-motion-result]')?.getAttribute('data-ok'),
    code: document.querySelector('[data-motion-result]')?.getAttribute('data-code'),
    busy: document.querySelector('[data-motion-apply]')?.getAttribute('data-busy'),
    disabled: document.querySelector('[data-motion-apply]')?.disabled,
    rows: document.querySelectorAll('[data-motion-entry]').length,
    errors: window.__errors
  }));

  assert.equal(state.lastResult.ok, false);
  assert.equal(state.lastResult.code, 'E_CONFLICT');
  assert.equal(view.ok, 'false');
  assert.equal(view.code, 'E_CONFLICT');
  assert.match(view.result, /E_CONFLICT/);
  assert.equal(view.busy, 'false');
  assert.equal(view.disabled, false, '失败后按钮应恢复可点');
  assert.equal(view.rows, 3, '失败后列表不能崩');
  assert.deepEqual(view.errors, [{ code: 'E_CONFLICT', message: 'expectedHash 不匹配' }], 'onError 应收到同一份码');

  /* 再点一次（这回宿主成功）：证明不是「假失败卡死」 */
  await page.evaluate(() => {
    window.__applyState = 'ok';
  });
  const again = await clickApply(page);
  assert.equal(again.lastResult.ok, true);
  const h = await harness(page);
  assert.equal(h.calls.length, 2);

  assert.deepEqual(pageErrors, []);
  evidence.cases.A6 = { state, view, again: again.lastResult, calls: h.calls.length };
});

/* ── A7 空库 / 加载失败：文案 + 重试真的再调 loadLibrary ─────────── */

test('A7 空库 / 加载失败 → 有文案 + 重试按钮，点重试会再调 loadLibrary', async () => {
  const { page, pageErrors } = await openPage();
  await mountPanel(page, { libState: 'empty' });

  let view = await page.evaluate(() => ({
    text: document.querySelector('[data-motion-status]')?.textContent ?? '',
    state: document.querySelector('[data-motion-status]')?.getAttribute('data-state'),
    retryVisible: (() => {
      const el = document.querySelector('[data-motion-retry]');
      return !!el && getComputedStyle(el).display !== 'none';
    })(),
    rows: document.querySelectorAll('[data-motion-entry]').length,
    loads: window.__loads
  }));
  assert.equal(view.state, 'empty');
  assert.match(view.text, /还没有动效模板/);
  assert.equal(view.retryVisible, true);
  assert.equal(view.rows, 0);

  await shot(page, 's27-a7-empty.png');

  /* 点重试：库已经有东西了 → 列表出现，且 loadLibrary 被再调一次 */
  await page.evaluate((entries) => {
    window.__libState = 'ok';
    window.__entries = entries;
  }, ENTRIES);
  await page.click('[data-motion-retry]');
  await page.waitForFunction(() => window.__panel.getState().phase === 'ready');
  view = await page.evaluate(() => ({
    rows: document.querySelectorAll('[data-motion-entry]').length,
    loads: window.__loads,
    text: document.querySelector('[data-motion-status]')?.textContent ?? ''
  }));
  assert.equal(view.loads, 2, `重试应再调一次 loadLibrary（loads=${view.loads}）`);
  assert.equal(view.rows, 3);
  assert.match(view.text, /共 3 个模板/);

  /* 加载失败态：同一页上把库改成 fail 再刷新 */
  await page.evaluate(() => {
    window.__libState = 'fail';
  });
  await page.evaluate(() => window.__panel.refresh());
  await page.waitForFunction(() => window.__panel.getState().phase === 'error');
  const failed = await page.evaluate(() => ({
    text: document.querySelector('[data-motion-status]')?.textContent ?? '',
    state: document.querySelector('[data-motion-status]')?.getAttribute('data-state'),
    retryVisible: (() => {
      const el = document.querySelector('[data-motion-retry]');
      return !!el && getComputedStyle(el).display !== 'none';
    })(),
    errors: window.__errors
  }));
  assert.equal(failed.state, 'error');
  assert.match(failed.text, /E_IO/);
  assert.equal(failed.retryVisible, true);
  assert.deepEqual(failed.errors, [{ code: 'E_IO', message: 'motion/library.json 读不了' }]);

  assert.deepEqual(pageErrors, []);
  evidence.cases.A7 = { empty: view, failed, loadsAfterRetry: view.loads };
});

/* ── A8 20 次挂卸：DOM 零残留、监听不泄漏 ────────────────────────── */

test('A8 20 次 mount/destroy 后节点数回到基线、无监听泄漏', async () => {
  const { page, pageErrors } = await openPage();

  const result = await page.evaluate(async (bundle) => {
    const mod = await import(bundle);
    const rail = document.getElementById('rail');
    /* 只统计 document / window 上的监听：挂在自己节点上的监听随节点消失，不算泄漏面 */
    window.__net = 0;
    const origAdd = EventTarget.prototype.addEventListener;
    const origRemove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (type, fn, opts) {
      if (this === document || this === window) window.__net += 1;
      return origAdd.call(this, type, fn, opts);
    };
    EventTarget.prototype.removeEventListener = function (type, fn, opts) {
      if (this === document || this === window) window.__net -= 1;
      return origRemove.call(this, type, fn, opts);
    };

    const baselineNodes = document.querySelectorAll('*').length;
    const baselineNet = window.__net;
    const samples = [];
    for (let i = 0; i < 20; i += 1) {
      const panel = mod.mountMotionPanel(rail, {
        loadLibrary: async () => ({ ok: true, entries: [] }),
        applyEntry: async () => ({ ok: true })
      });
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      samples.push({
        nodes: document.querySelectorAll('*').length,
        panels: document.querySelectorAll('[data-motion-panel]').length,
        phase: panel.getState().phase
      });
      panel.destroy();
    }
    const afterNodes = document.querySelectorAll('*').length;
    const afterNet = window.__net;
    EventTarget.prototype.addEventListener = origAdd;
    EventTarget.prototype.removeEventListener = origRemove;
    return {
      baselineNodes,
      afterNodes,
      baselineNet,
      afterNet,
      leftoverPanels: document.querySelectorAll('[data-motion-panel]').length,
      railChildren: rail.childNodes.length,
      peakPanels: Math.max(...samples.map((s) => s.panels)),
      peakNodes: Math.max(...samples.map((s) => s.nodes)),
      phases: [...new Set(samples.map((s) => s.phase))]
    };
  }, BUNDLE_URL);

  assert.equal(result.peakPanels, 1, `同一时刻只应有一个面板实例，实际 ${result.peakPanels}`);
  assert.equal(result.leftoverPanels, 0, 'destroy 后还有面板节点');
  assert.equal(result.railChildren, 0, `destroy 后 rail 还有 ${result.railChildren} 个子节点`);
  assert.equal(result.afterNodes, result.baselineNodes, `节点数没回到基线：${result.baselineNodes} → ${result.afterNodes}`);
  assert.equal(result.afterNet, result.baselineNet, `document/window 监听净增 ${result.afterNet - result.baselineNet}`);
  assert.deepEqual(pageErrors, []);
  evidence.cases.A8 = result;
});

/* ── A9 tsc 0 + pageErrors 空 ───────────────────────────────────── */

test('A9 页面零异常（tsc 由单独命令跑）', async () => {
  const { page, pageErrors } = await openPage();
  await mountPanel(page);
  await page.click('[data-motion-entry][data-id="motion_badge"]');
  await page.waitForSelector('[data-motion-form]');
  await clickApply(page);
  assert.deepEqual(pageErrors, [], `页面异常：${pageErrors.join(' | ')}`);
  evidence.cases.A9 = { pageErrors };
});
