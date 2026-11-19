// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S32-MOTION-CONTROL-DISCOVERY 验收 B1..B4
 *
 * B1 三条种子模板：`discoverControls` 产出的 params 与手写 schema **逐字段相等**（diff 为空）。
 * B2 把库里的手写 schema 清空 → 面板仍能靠标注渲染出控件（截图 + getState）。
 * B3 四类错误各给一个用例与稳定码：PARSE_FAILED / DUPLICATE_PARAM / UNKNOWN_TYPE / ENUM_NO_OPTIONS。
 * B4 手写与标注冲突：手写赢，issues 里有记录（不静默丢）。
 *
 * 运行：node --test --test-concurrency=1 packages/motion/discover.test.mjs
 * （环境路径见 RUN_ROOT：OPENCUT_ENV_JSON 优先，否则自动建 .local-runs/layers/motion-discover/env.json）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { build as esbuild } from 'esbuild';
import { SceneHost, REPO_ROOT } from '../scene-runtime/host.mjs';
import { resolveLayerTestEnv } from '../layers/test-env.mjs';
import { installSeedLibrary, SEED_TEMPLATES, verifySeedTemplates } from './seed.mjs';
import { readLibrary, listEntries, saveAsTemplate } from './library.mjs';
import { DISCOVERY_ERROR_CODES, discoverControls, discoverEntryParams, mergeParams } from './discover.mjs';

/* S57：环境可移植（R37-C5）。OPENCUT_ENV_JSON 有值就**沿用**（派工/证据路径不变）；
   否则用 packages/layers/test-env.mjs 现建 `<repo>/.local-runs/layers/motion-discover/env.json`，
   端口 listen(0) 现取 —— 不再写死 `.local-runs/sub1/runs/R16`（集成树里那是 ENOENT 的来源）。 */
const TEST_ENV = await resolveLayerTestEnv({ suite: 'motion-discover' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');
const PROJECTS = path.join(RUN_ROOT, 'projects');
const BUNDLE_ABS = path.join(RUN_ROOT, 'tmp/s32/bundle.js');
const BUNDLE_URL = '/' + path.relative(REPO_ROOT, BUNDLE_ABS).split(path.sep).join('/');
const PANEL_FIXTURE = 'tests/fixtures/scenes/motion-panel-stage.html';
const TEMPLATES_DIR = 'packages/motion/templates';
const BATCH = 'B-SUB1-R16-016';

const evidence = {
  batch: BATCH,
  suite: 'discover.test.mjs',
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
    globalName: 'R32',
    platform: 'browser',
    target: 'es2022',
    outfile: BUNDLE_ABS,
    logLevel: 'silent'
  });
}

async function save() {
  const files = [];
  for (const name of ['s32-b2-panel.png']) {
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
  await fs.writeFile(path.join(EVIDENCE_DIR, 's32-discover.json'), JSON.stringify(evidence, null, 2) + '\n');
}

before(async () => {
  const env = JSON.parse(await fs.readFile(path.join(RUN_ROOT, 'env.json'), 'utf8'));
  evidence.batch = env.batchId ?? evidence.batch;
  await buildBundle();
  host = await new SceneHost({ port: Number(env.sceneOrigin || env.studioPort), viewport: { width: 1280, height: 720 } }).start();
  evidence.browser = host.browserVersion;
});

after(async () => {
  await save();
  if (host) await host.stop();
});

async function freshProject(name) {
  const dir = path.join(PROJECTS, `${name}-${process.pid}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** 逐键 diff（B1 要「贴 diff=空」） */
function diffSpecs(hand, auto) {
  const keys = [...new Set([...Object.keys(hand ?? {}), ...Object.keys(auto ?? {})])].sort();
  const rows = [];
  for (const key of keys) {
    const a = hand?.[key];
    const b = auto?.[key];
    if (isDeepStrictEqual(a, b)) continue;
    rows.push({ key, handwritten: a ?? null, discovered: b ?? null });
  }
  return rows;
}

/* ── B1 三条模板：发现结果与手写逐字段相等 ───────────────────────── */

test('B1 三条模板：discoverControls 的 params 与手写 schema 逐字段相等（diff 为空）', async () => {
  /** @type {Record<string, any>} */
  const perTemplate = {};
  for (const tpl of SEED_TEMPLATES) {
    const html = await fs.readFile(path.join(REPO_ROOT, TEMPLATES_DIR, tpl.slug, tpl.source), 'utf8');
    const found = discoverControls(html, { file: `${tpl.slug}/${tpl.source}` });
    assert.equal(found.ok, true, `${tpl.slug} 发现器报错：${JSON.stringify(found.issues)}`);
    const diff = diffSpecs(tpl.params, found.params);
    assert.deepEqual(diff, [], `${tpl.slug} 手写与标注不一致：${JSON.stringify(diff, null, 1)}`);
    assert.equal(found.stats.annotations, Object.keys(tpl.params).length, `${tpl.slug} 标注条数与参数个数对不上`);
    perTemplate[tpl.slug] = {
      file: `${tpl.slug}/${tpl.source}`,
      annotations: found.stats.annotations,
      tags: found.stats.tags,
      keys: Object.keys(found.params),
      diff
    };
    evidence.discoverySchema[tpl.slug] = found.params;
  }

  /* 包内自检也走同一套（安装时的闸门）：三条都 deterministic 且不漂移 */
  const selfCheck = await verifySeedTemplates();
  assert.equal(selfCheck.ok, true, `包内自检没过：${JSON.stringify(selfCheck.issues)}`);
  assert.deepEqual(selfCheck.templates.map((item) => item.slug).sort(), ['badge', 'lower-third', 'pulse']);
  assert.equal(selfCheck.templates.every((item) => item.deterministic), true);

  evidence.cases.B1 = { perTemplate, selfCheck };
});

/* ── B2 清空手写 schema 后面板仍能渲染控件 ──────────────────────── */

test('B2 库里没有手写 schema 时：面板靠标注仍渲染出 3–5 个控件（截图 + getState）', async () => {
  const root = await freshProject('discover-b2');
  const seeded = await installSeedLibrary(root);
  assert.equal(seeded.ok, true, JSON.stringify(seeded));

  const { library } = await readLibrary(root);
  /* 模拟「模板作者没写 schema」：条目 params 清空，只剩模板文件里的标注 */
  const stripped = structuredClone(library);
  for (const entry of stripped.entries) entry.params = {};

  const statuses = await listEntries(root, stripped);
  /** @type {any[]} */
  const views = [];
  /** @type {Record<string, any>} */
  const discovered = {};
  for (const { entry, status, missingAssets } of statuses) {
    const fallback = await discoverEntryParams(root, entry);
    assert.equal(fallback.source, 'discovered', `${entry.name} 没走到发现器：${fallback.source}`);
    assert.deepEqual(fallback.issues, [], `${entry.name} 发现器报了问题：${JSON.stringify(fallback.issues)}`);
    discovered[entry.name] = { source: fallback.source, params: fallback.params };
    views.push({
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      sourceOk: status !== 'source-missing',
      assetIssues: missingAssets.map((asset) => ({ path: asset.path, reason: '资源不存在' })),
      params: Object.entries(fallback.params).map(([name, spec]) => {
        const view = { name, label: spec.label ?? name, type: spec.type };
        if (spec.default !== undefined) view.default = spec.default;
        if (typeof spec.min === 'number') view.min = spec.min;
        if (typeof spec.max === 'number') view.max = spec.max;
        if (typeof spec.step === 'number') view.step = spec.step;
        if (Array.isArray(spec.options)) view.options = [...spec.options];
        return view;
      })
    });
  }
  assert.equal(views.length, 3);

  const handle = await host.open(PANEL_FIXTURE);
  const page = handle.page;
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.addScriptTag({ url: BUNDLE_URL });
  await page.evaluate(async (arg) => {
    const rail = document.getElementById('rail');
    rail.textContent = '';
    window.__panel = window.R32.mountMotionPanel(rail, {
      loadLibrary: async () => ({ ok: true, entries: arg.views }),
      applyEntry: async () => ({ ok: true })
    });
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  }, { views });
  await page.waitForFunction(() => {
    const state = window.__panel?.getState();
    return !!state && state.phase !== 'loading';
  });

  /* 每条都点开，数控件数：必须与「发现出来的参数个数」一致，且在 3–5 之间 */
  /** @type {Record<string, {paramCount: number, controls: number, types: string[]}>} */
  const rendered = {};
  for (const view of views) {
    await page.click(`[data-motion-entry][data-id="${view.id}"]`);
    await page.waitForFunction(() => document.querySelectorAll('[data-motion-input]').length > 0);
    const state = await page.evaluate(() => window.__panel.getState());
    const controls = await page.evaluate(() =>
      [...document.querySelectorAll('[data-motion-input]')].map((el) => ({
        param: el.getAttribute('data-param'),
        type: el.getAttribute('data-motion-input') || el.tagName.toLowerCase()
      }))
    );
    assert.equal(controls.length, view.params.length, `${view.name} 控件数 ${controls.length} ≠ 参数数 ${view.params.length}`);
    assert.ok(controls.length >= 3 && controls.length <= 5, `${view.name} 控件数 ${controls.length} 不在 3–5`);
    assert.equal(state.fields.length, view.params.length);
    assert.deepEqual(controls.map((item) => item.param), view.params.map((item) => item.name), `${view.name} 控件顺序与参数顺序不一致`);
    rendered[view.name] = { paramCount: view.params.length, controls: controls.length, types: view.params.map((item) => item.type) };
  }

  /* 截图：留 pulse 的表单（5 个控件） */
  const pulse = views.find((view) => view.name === 'pulse');
  await page.click(`[data-motion-entry][data-id="${pulse.id}"]`);
  await page.waitForFunction(() => document.querySelectorAll('[data-motion-input]').length === 5);
  await page.screenshot({ path: path.join(EVIDENCE_DIR, 's32-b2-panel.png') });
  assert.deepEqual(pageErrors, []);
  await handle.dispose();

  evidence.cases.B2 = { strippedParams: true, rendered, discovered, screenshot: 's32-b2-panel.png' };
});

/* ── B3 四类错误码 ──────────────────────────────────────────────── */

test('B3 四类错误各给一个用例与稳定码（外加 BAD_DEFAULT 第五个）', async () => {
  /** @type {Record<string, {html: string, expect: string}>} */
  const cases = {
    PARSE_FAILED: {
      html: '<div class="a"><i data-motion-param="size" data-motion-type="number"',
      expect: DISCOVERY_ERROR_CODES.PARSE_FAILED
    },
    DUPLICATE_PARAM: {
      html: `
        <i data-motion-param="size" data-motion-type="number" data-motion-default="12"></i>
        <i data-motion-param="size" data-motion-type="number" data-motion-default="20"></i>`,
      expect: DISCOVERY_ERROR_CODES.DUPLICATE_PARAM
    },
    UNKNOWN_TYPE: {
      html: '<i data-motion-param="size" data-motion-type="slider" data-motion-default="12"></i>',
      expect: DISCOVERY_ERROR_CODES.UNKNOWN_TYPE
    },
    ENUM_NO_OPTIONS: {
      html: '<select data-motion-param="align" data-motion-default="center"><option>center</option></select>',
      expect: DISCOVERY_ERROR_CODES.ENUM_NO_OPTIONS
    },
    BAD_DEFAULT: {
      html: '<i data-motion-param="align" data-motion-type="enum" data-motion-options="a,b" data-motion-default="c"></i>',
      expect: DISCOVERY_ERROR_CODES.BAD_DEFAULT
    }
  };

  /** @type {Record<string, any>} */
  const results = {};
  for (const [name, item] of Object.entries(cases)) {
    const found = discoverControls(item.html, { file: `${name}.html` });
    assert.equal(found.ok, false, `${name} 竟然通过了`);
    assert.deepEqual(found.issues.map((issue) => issue.code), [item.expect], `${name} 的错误码不对：${JSON.stringify(found.issues)}`);
    assert.ok(found.issues[0].line >= 1);
    results[name] = { code: found.issues[0].code, line: found.issues[0].line, detail: found.issues[0].detail, params: Object.keys(found.params) };
  }

  /* 反过来：干净模板必须 ok，否则上面全是假阳性 */
  const clean = discoverControls('<i data-motion-param="size" data-motion-type="number" data-motion-min="1" data-motion-max="9" data-motion-default="5"></i>', { file: 'clean.html' });
  assert.equal(clean.ok, true, JSON.stringify(clean.issues));
  assert.deepEqual(clean.params.size, { type: 'number', label: 'size', min: 1, max: 9, default: 5 });

  /* 类型推断：不写 data-motion-type 也认得出来 */
  const inferred = discoverControls(
    [
      '<input type="range" data-motion-param="a" data-motion-default="3">',
      '<input type="color" data-motion-param="b" data-motion-default="#fff">',
      '<input type="checkbox" data-motion-param="c">',
      '<select data-motion-param="d" data-motion-options="x,y"></select>',
      '<span data-motion-param="e">文字</span>'
    ].join(''),
    { file: 'inferred.html' }
  );
  assert.equal(inferred.ok, true, JSON.stringify(inferred.issues));
  assert.deepEqual(
    Object.fromEntries(Object.entries(inferred.params).map(([key, spec]) => [key, spec.type])),
    { a: 'number', b: 'color', c: 'boolean', d: 'enum', e: 'string' }
  );
  assert.equal(inferred.params.e.default, '文字', '文本参数应默认取元素文本');

  evidence.cases.B3 = { cases: results, inferred: inferred.params, clean: clean.params };
});

/* ── B4 手写优先，冲突留痕 ──────────────────────────────────────── */

test('B4 手写与标注冲突：手写赢，issues 里有记录；标注独有的键补进来', async () => {
  const html = `
    <div data-role="root">
      <span class="cap" data-motion-param="title" data-motion-type="string" data-motion-apply="text" data-motion-maxlength="12" data-motion-label="手写标题">标题</span>
    </div>
    <div data-motion-decls hidden>
      <i data-motion-param="size" data-motion-type="number" data-motion-min="12" data-motion-max="28" data-motion-step="1" data-motion-default="18" data-motion-label="标注字号"></i>
      <i data-motion-param="tint" data-motion-type="color" data-motion-default="#22d3ee" data-motion-label="标注色"></i>
    </div>`;
  const found = discoverControls(html, { file: 'merge.html' });
  assert.equal(found.ok, true, JSON.stringify(found.issues));

  const handwritten = {
    title: { type: 'string', maxLength: 12, default: '标题', label: '手写标题', apply: { kind: 'text', selector: '.cap' } },
    /* 与标注冲突：label / min / default 都不同 */
    size: { type: 'number', min: 10, max: 30, default: 22, label: '手写字号' }
  };

  const merged = mergeParams(handwritten, found.params);
  /* title 两边一字不差 → 不算冲突，记进 agreed；只有 size 冲突 */
  assert.deepEqual(merged.conflicts, ['size'], `冲突键不对：${JSON.stringify(merged.conflicts)}`);
  assert.deepEqual(merged.agreed, ['title']);
  assert.deepEqual(merged.added, ['tint'], '标注独有的键没补进来');
  assert.equal(merged.params.size.label, '手写字号', '冲突时应该手写赢');
  assert.equal(merged.params.size.default, 22);
  assert.equal(merged.params.title.label, '手写标题');
  assert.deepEqual(merged.params.tint, found.params.tint);
  assert.equal(merged.issues.length, 1);
  assert.equal(merged.issues[0].code, DISCOVERY_ERROR_CODES.MERGE_CONFLICT);
  assert.equal(merged.issues[0].key, 'size');
  assert.match(merged.issues[0].detail, /手写与标注不一致/);

  /* 完全相同的情况：不算冲突，但要能看见「两边一致」 */
  const tpl = SEED_TEMPLATES.find((item) => item.slug === 'badge');
  const html2 = await fs.readFile(path.join(REPO_ROOT, TEMPLATES_DIR, 'badge', tpl.source), 'utf8');
  const auto2 = discoverControls(html2, { file: 'badge.html' });
  const merged2 = mergeParams(tpl.params, auto2.params);
  assert.deepEqual(merged2.conflicts, []);
  assert.deepEqual(merged2.added, []);
  assert.deepEqual(merged2.agreed.sort(), Object.keys(tpl.params).sort());

  evidence.cases.B4 = {
    conflicts: merged.conflicts,
    added: merged.added,
    issues: merged.issues,
    agreedOnBadge: merged2.agreed,
    handwrittenWins: { label: merged.params.size.label, default: merged.params.size.default }
  };
});

/* ── B5（额外）存模板时 deterministic 自动判定，连 link 的 CSS 一起看 ───────── */

test('B5 saveAsTemplate：墙钟写在 link 的 CSS 里也会被标 deterministic=false', async () => {
  const root = await freshProject('discover-b5');
  await fs.mkdir(path.join(root, 'scenes'), { recursive: true });

  /* ① 反面：墙钟在外部 CSS 里（S29 pulse.css 的写法），只看 HTML 会误判 */
  await fs.writeFile(
    path.join(root, 'scenes/src-wall.html'),
    '<!doctype html><html><head><link rel="stylesheet" href="./src-wall.css"></head><body><div class="core"></div></body></html>',
    'utf8'
  );
  await fs.writeFile(
    path.join(root, 'scenes/src-wall.css'),
    '.core{width:10px;height:10px;animation: ring 1200ms linear infinite}@keyframes ring{from{opacity:.2}to{opacity:1}}',
    'utf8'
  );
  /* 源文件名与模板名不同：存模板会复制到 scenes/<name>.html，同路径会撞 NAME_TAKEN */
  const bad = await saveAsTemplate(root, { name: 'wall-clock-demo', kind: 'animation', from: 'scenes/src-wall.html', params: {} });
  assert.equal(bad.ok, true, JSON.stringify(bad));
  assert.equal(bad.entry.deterministic, false, '墙钟写在 CSS 里却没被标出来');

  /* ② 正面：暂停 + 负延迟，应判 true */
  await fs.writeFile(
    path.join(root, 'scenes/src-seek.html'),
    '<!doctype html><html><head><link rel="stylesheet" href="./src-seek.css"></head><body><div class="core" data-role="root"></div></body></html>',
    'utf8'
  );
  await fs.writeFile(
    path.join(root, 'scenes/src-seek.css'),
    '.core{width:10px;height:10px;animation: ring 1200ms linear infinite;animation-play-state: paused;animation-delay: calc(-1 * var(--motion-t, 0) * 1ms)}@keyframes ring{from{opacity:.2}to{opacity:1}}',
    'utf8'
  );
  const good = await saveAsTemplate(root, { name: 'seek-demo', kind: 'animation', from: 'scenes/src-seek.html', params: {} });
  assert.equal(good.ok, true, JSON.stringify(good));
  assert.equal(good.entry.deterministic, true, '可 seek 的模板被误标成不确定');

  /* ③ 库里读回来还是这个值（不是只在内存里） */
  const { library } = await readLibrary(root);
  const byName = Object.fromEntries(library.entries.map((entry) => [entry.name, entry.deterministic]));
  assert.equal(byName['wall-clock-demo'], false);
  assert.equal(byName['seek-demo'], true);

  evidence.cases.B5 = { wallClockInLinkedCss: bad.entry.deterministic, seekable: good.entry.deterministic, persisted: byName };
});
