// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S16-TEXT-UNITS 验收 A1..A6
 *
 * 问题：`font-size:48px` / `line-height:1.4` / `letter-spacing:-0.5px` 在面板里显示为空
 * （输入框是 number，值是带单位的字符串）。本批把「数值 + 单位」拆开：
 * 输入框只放数字，单位单独显示，提交时按当前单位回写。
 *
 * 走的是**overrides** 写入口（不是 box）：面板挂在真实 `scene-a.html` 上改 `#subtitle`，
 * 由真 Studio 的 `/ops` 落盘，断言落在 `card-a` 的 `overrides` 条目上、片段的 `style` 不动。
 *
 * 运行：node --test --test-concurrency=1 packages/layers/text-units.test.mjs（env 由 test-env.mjs 自动准备；`OPENCUT_ENV_JSON` 可显式覆盖）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { build as esbuild } from 'esbuild';
import { SceneHost, REPO_ROOT } from '../scene-runtime/host.mjs';
import { startStudio } from '../studio/server/studio-server.mjs';
import { parse } from '../film-core/film-doc.mjs';
import { resolveLayerTestEnv } from './test-env.mjs';

const TEST_ENV = await resolveLayerTestEnv({ suite: 'text-units' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');
const PROJECTS = path.join(RUN_ROOT, 'projects');
const BUNDLE_ABS = path.join(RUN_ROOT, 'tmp/s16/panel.mjs');
const BUNDLE_URL = '/' + path.relative(REPO_ROOT, BUNDLE_ABS).split(path.sep).join('/');

const SAMPLE =
  '/tmp/motioncut-optional-scene-fixture';

/** 给样例的 #subtitle 加内联声明（作者手写的那种），这样面板才分得清「倍数」与「像素」。 */
const SUBTITLE_DECL = 'font-size:48px;line-height:1.4;letter-spacing:-0.5px';

const evidence = { batch: 'B-SUB1-R8-008', suite: 'text-units.test.mjs', cases: {}, studio: {}, startedAt: new Date().toISOString() };

/** @type {SceneHost} */
let host;
/** @type {any} */
let studio;

const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const rel = (abs) => path.relative(REPO_ROOT, abs).split(path.sep).join('/');

async function buildBundle() {
  await fs.mkdir(path.dirname(BUNDLE_ABS), { recursive: true });
  await esbuild({
    stdin: {
      contents: [
        "export { mountInspector } from './packages/layers/inspector-panel.mjs';",
        "export { readLayer } from './packages/layers/describe.ts';",
        "export { applyOverrideEntries } from './packages/layers/apply-overrides.mjs';",
        "export { createOpsClient } from './packages/layers/ops-client.mjs';",
        "export { mergeOverridesAt } from './packages/layers/override-merge.mjs';",
        "export { parseNumericValue, NUMERIC_STYLE_FIELDS } from './packages/layers/inspector-fields.mjs';"
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
  evidence.finishedAt = new Date().toISOString();
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(path.join(EVIDENCE_DIR, 's16-text-units.json'), JSON.stringify(evidence, null, 2) + '\n');
}

before(async () => {
  const env = JSON.parse(await fs.readFile(path.join(RUN_ROOT, 'env.json'), 'utf8'));
  evidence.batch = env.batchId ?? evidence.batch;
  await buildBundle();
  host = await new SceneHost({ port: Number(env.studioPort) }).start();
  studio = await startStudio({ port: 0, vitePort: host.http.port, logger: () => {} });
  evidence.studio = { port: studio.port, url: studio.url, harnessOrigin: `http://127.0.0.1:${host.http.port}` };
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
 * 复制样例 → 打开 → 返回工程信息。
 * @param {string} name
 * @param {{declare?: boolean}} [opts]
 */
async function makeProject(name, opts = {}) {
  const dir = path.join(PROJECTS, `${name}-${process.pid}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.cp(SAMPLE, dir, { recursive: true });
  if (opts.declare !== false) {
    const scenePath = path.join(dir, 'scene-a.html');
    const scene = await fs.readFile(scenePath, 'utf8');
    const next = scene.replace(
      '<p class="subtitle" id="subtitle">',
      `<p class="subtitle" id="subtitle" style="${SUBTITLE_DECL}">`
    );
    assert.notEqual(next, scene, '样例 scene-a.html 结构变了，找不到 #subtitle');
    await fs.writeFile(scenePath, next);
  }
  const opened = await post(`${studio.url}/api/projects/open`, { dir });
  assert.equal(opened.status, 200, `open 失败：${opened.text}`);
  const projectId = opened.json.project.projectId;
  const doc = await get(`${studio.url}/api/projects/${encodeURIComponent(projectId)}/doc`);
  assert.equal(doc.status, 200, `doc 失败：${doc.text}`);
  return { dir, projectId, hash: doc.json.hash, filmPath: path.join(dir, 'film.html'), scenePath: path.join(dir, 'scene-a.html') };
}

/** 页内：把面板挂到真实场景页上（与 S11 同一套）。 */
async function mountLive(deps) {
  const mod = await import(deps.bundle);
  const { createOpsClient, mountInspector, readLayer, applyOverrideEntries, mergeOverridesAt } = mod;

  window.__fetches = [];
  const realFetch = window.fetch.bind(window);
  window.fetch = (...args) => {
    window.__fetches.push(String(args[0]));
    return realFetch(...args);
  };

  const log = [];
  const el0 = document.querySelector(deps.at);
  const hosts = { entries: [...deps.entries], prevEntries: null, log, baselineText: el0 ? el0.textContent : null };

  const client = createOpsClient({
    projectId: deps.projectId,
    batchId: deps.batchId,
    owner: 'SUB1',
    expectedHash: deps.expectedHash,
    baseUrl: deps.baseUrl
  });

  const container = document.createElement('div');
  container.id = 'sub1-units-panel';
  container.setAttribute(
    'style',
    'position:fixed;right:0;top:0;width:320px;height:100vh;background:#111a2e;color:#eef2ff;z-index:2147483647;' +
      'overflow:auto;font:12px/1.5 system-ui;padding:8px;box-sizing:border-box'
  );
  document.body.appendChild(container);

  const panelDeps = {
    describe: async (ref) => {
      const res = readLayer(ref.at);
      return res && res.ok ? res.value : res;
    },
    overrideOf: (at) => hosts.entries.find((e) => e && e.at === at) ?? null,
    preview: async (patch) => {
      hosts.prevEntries = hosts.entries;
      hosts.entries = mergeOverridesAt(hosts.entries, deps.at, patch);
      await applyOverrideEntries(hosts.entries);
      log.push({ step: 'preview', patch });
    },
    revertPreview: async () => {
      hosts.entries = hosts.prevEntries ?? hosts.entries;
      const el = document.querySelector(deps.at);
      if (el) {
        el.textContent = hosts.baselineText;
        el.removeAttribute('style');
        const base = deps.baselineStyle ?? '';
        if (base) el.setAttribute('style', base);
      }
      await applyOverrideEntries(hosts.entries);
      log.push({ step: 'revert' });
    },
    commit: async (patch) => {
      const next = mergeOverridesAt(hosts.entries, deps.at, patch);
      const res = await client.commitOverrides({ clip: deps.clip, entries: next });
      log.push({ step: 'commit', ok: res.ok, code: res.code ?? null, status: res.status, request: res.request, response: res.response });
      if (res.ok) hosts.entries = next;
      return res;
    },
    expectedHash: deps.expectedHash
  };

  const panel = mountInspector(container, panelDeps);
  await panel.select({ clipId: deps.clip, at: deps.at, kind: 'text', name: 'subtitle', depth: 2 });
  window.__panel = panel;
  window.__host = hosts;
  window.__client = client;
  window.__mod = mod;
  return panel.getState();
}

async function openScene(project, at = '#subtitle') {
  const handle = await host.open(rel(project.scenePath));
  const page = handle.page;
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  const baselineStyle = await page.evaluate((sel) => document.querySelector(sel)?.getAttribute('style') ?? '', at);
  await page.evaluate(mountLive, {
    bundle: BUNDLE_URL,
    baseUrl: studio.url,
    projectId: project.projectId,
    batchId: 'B-SUB1-R8-008',
    expectedHash: project.hash,
    clip: 'card-a',
    at,
    entries: [],
    baselineStyle
  });
  return { handle, page, consoleErrors };
}

async function editField(page, fieldId, value) {
  await page.evaluate(
    ([id, v]) => {
      const input = document.querySelector(`.film-inspector [data-field="${id}"] input`);
      if (!input) throw new Error(`没有字段输入框：${id}`);
      input.value = v;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    [fieldId, value]
  );
  await page.evaluate(() => window.__panel.idle());
  return page.evaluate(() => ({
    state: window.__panel.getState(),
    log: window.__host.log,
    field: (() => {
      const row = document.querySelector('.film-inspector [data-field="fontSize"]');
      return { value: row.querySelector('input').value, unit: row.querySelector('[data-unit-chip]')?.textContent ?? null };
    })(),
    disk: null
  }));
}

/** 读某字段在面板里的显示。 */
async function fieldView(page, fieldId) {
  return page.evaluate((id) => {
    const row = document.querySelector(`.film-inspector [data-field="${id}"]`);
    const input = row.querySelector('input');
    return {
      value: input.value,
      type: input.type,
      unit: row.querySelector('[data-unit-chip]')?.textContent ?? null,
      empty: input.getAttribute('data-empty-state'),
      source: row.getAttribute('data-source'),
      visible: input.value !== ''
    };
  }, fieldId);
}

function overrideOf(filmText, clipId, at) {
  const doc = parse(filmText, {}).doc;
  const clip = doc.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
  return { entry: (clip.overrides ?? []).find((o) => o.at === at) ?? null, clip };
}

/* ── A1 ─────────────────────────────────────────────────────────────────── */

test('S16-A1 font-size 48px → 显示 48 → 改 60 → 磁盘 60px（overrides 变、style 不变）', async () => {
  const project = await makeProject('s16-a1');
  const { handle, page, consoleErrors } = await openScene(project);
  const before = await fs.readFile(project.filmPath, 'utf8');

  const shown = await fieldView(page, 'fontSize');
  assert.equal(shown.value, '48', `字号应显示 48：${shown.value}`);
  assert.equal(shown.unit, 'px');
  assert.equal(shown.type, 'number');

  const res = await editField(page, 'fontSize', '60');
  const commit = res.log.filter((l) => l.step === 'commit').at(-1);
  assert.equal(commit.ok, true, JSON.stringify(commit.response));
  assert.equal(commit.request.ops[0].op, 'overrides');
  const entry = commit.request.ops[0].entries.find((e) => e.at === '#subtitle');
  assert.equal(entry.style['font-size'], '60px', JSON.stringify(entry));

  const after = await fs.readFile(project.filmPath, 'utf8');
  const parsedNew = overrideOf(after, 'card-a', '#subtitle');
  assert.equal(parsedNew.entry.style['font-size'], '60px');
  assert.equal(parsedNew.clip.style ?? null, null, `片段的 style 声明被改了：${parsedNew.clip.style}`);
  const parsedOld = overrideOf(before, 'card-a', '#subtitle');
  assert.equal(parsedOld.entry, null, '起点不该已有该层覆盖');
  assert.deepEqual(consoleErrors, [], consoleErrors.join(' | '));

  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, 's16-a1-fontsize.png') });

  await handle.dispose();
  evidence.cases['S16-A1'] = { ok: true, shown, request: commit.request, response: commit.response, entry: parsedNew.entry, clipStyle: parsedNew.clip.style ?? null };
});

/* ── A2 ─────────────────────────────────────────────────────────────────── */

test('S16-A2 line-height 1.4 → 显示 1.4 → 改 1.5 → 磁盘 1.5（无 px）', async () => {
  const project = await makeProject('s16-a2');
  const { handle, page } = await openScene(project);

  const shown = await fieldView(page, 'lineHeight');
  assert.equal(shown.value, '1.4', `行高应显示 1.4（不是 67.2px）：${shown.value}`);
  assert.equal(shown.unit, '倍', `行高单位应显示「倍」：${shown.unit}`);

  const res = await editField(page, 'lineHeight', '1.5');
  const commit = res.log.filter((l) => l.step === 'commit').at(-1);
  assert.equal(commit.ok, true, JSON.stringify(commit.response));
  const entry = commit.request.ops[0].entries.find((e) => e.at === '#subtitle');
  assert.equal(entry.style['line-height'], '1.5', `行高应写 1.5 而不是 1.5px：${entry.style['line-height']}`);

  const after = await fs.readFile(project.filmPath, 'utf8');
  const parsedNew = overrideOf(after, 'card-a', '#subtitle');
  assert.equal(parsedNew.entry.style['line-height'], '1.5');
  assert.equal(after.includes('1.5px'), false, '磁盘上出现了 1.5px');

  await handle.dispose();
  evidence.cases['S16-A2'] = { ok: true, shown, request: commit.request, response: commit.response, entry: parsedNew.entry };
});

/* ── A3 ─────────────────────────────────────────────────────────────────── */

test('S16-A3 letter-spacing -0.5px 允许负值，提交 -0.5px', async () => {
  const project = await makeProject('s16-a3');
  const { handle, page } = await openScene(project);

  const shown = await fieldView(page, 'letterSpacing');
  assert.equal(shown.value, '-0.5', `字距应显示 -0.5：${shown.value}`);
  assert.equal(shown.unit, 'px');

  const res = await editField(page, 'letterSpacing', '-0.5');
  const commit = res.log.filter((l) => l.step === 'commit').at(-1);
  assert.equal(commit.ok, true, JSON.stringify(commit.response));
  const entry = commit.request.ops[0].entries.find((e) => e.at === '#subtitle');
  assert.equal(entry.style['letter-spacing'], '-0.5px');

  const res2 = await editField(page, 'letterSpacing', '-2');
  const commit2 = res2.log.filter((l) => l.step === 'commit').at(-1);
  assert.equal(commit2.ok, true, JSON.stringify(commit2.response));
  const after = await fs.readFile(project.filmPath, 'utf8');
  const parsedNew = overrideOf(after, 'card-a', '#subtitle');
  assert.equal(parsedNew.entry.style['letter-spacing'], '-2px', `负值应允许：${JSON.stringify(parsedNew.entry.style)}`);

  await handle.dispose();
  evidence.cases['S16-A3'] = { ok: true, shown, requests: [commit.request, commit2.request], entry: parsedNew.entry };
});

/* ── A4 ─────────────────────────────────────────────────────────────────── */

test('S16-A4 非法值（-12px 字号 / 0 行高）→ INVALID_VALUE、磁盘不变、输入复原', async () => {
  const project = await makeProject('s16-a4');
  const { handle, page } = await openScene(project);
  const before = await fs.readFile(project.filmPath, 'utf8');

  const negative = await editField(page, 'fontSize', '-12');
  assert.equal(negative.log.filter((l) => l.step === 'commit').length, 0, '非法值不该发请求');
  assert.equal(negative.state.error.code, 'INVALID_VALUE');
  const afterNegative = await fieldView(page, 'fontSize');
  assert.equal(afterNegative.value, '48', `输入应复原为 48：${afterNegative.value}`);

  const zeroLine = await editField(page, 'lineHeight', '0');
  assert.equal(zeroLine.log.filter((l) => l.step === 'commit').length, 0, '0 行高不该发请求');
  assert.equal(zeroLine.state.error.code, 'INVALID_VALUE');
  const afterZero = await fieldView(page, 'lineHeight');
  assert.equal(afterZero.value, '1.4');

  const nan = await editField(page, 'fontSize', 'abc');
  assert.equal(nan.state.error.code, 'INVALID_VALUE');

  const after = await fs.readFile(project.filmPath, 'utf8');
  assert.equal(after, before, '非法值竟然写了盘');
  assert.equal(sha(after), sha(before));

  await handle.dispose();
  evidence.cases['S16-A4'] = {
    ok: true,
    negative: { state: negative.state.error, field: afterNegative },
    zeroLineHeight: { state: zeroLine.state.error, field: afterZero },
    nan: { state: nan.state.error },
    diskSha: sha(after)
  };
});

/* ── A5 ─────────────────────────────────────────────────────────────────── */

test('S16-A5 normal 的显示/提交行为固定（显示空 + 提示；提交空值拒绝）', async () => {
  const project = await makeProject('s16-a5', { declare: false }); // 用样例原样：#subtitle 没有 line-height 声明
  const { handle, page } = await openScene(project);
  const before = await fs.readFile(project.filmPath, 'utf8');

  const shown = await fieldView(page, 'lineHeight');
  assert.equal(shown.value, '', `normal 应显示空：${shown.value}`);
  assert.equal(shown.unit, 'normal', `应显示 normal 提示：${shown.unit}`);
  assert.equal(shown.empty, 'normal');

  const empty = await editField(page, 'lineHeight', '');
  assert.equal(empty.state.error.code, 'INVALID_VALUE');
  assert.equal(empty.log.filter((l) => l.step === 'commit').length, 0);
  assert.equal(sha(await fs.readFile(project.filmPath, 'utf8')), sha(before));

  /* 直接调面板入口写回 normal（输入框是 number，装不下这个字面量；这是文档写的程序化路径） */
  const back = await page.evaluate(() => window.__panel.commitField('lineHeight', 'normal'));
  assert.equal(back.ok, true, JSON.stringify(back));
  const after = await fs.readFile(project.filmPath, 'utf8');
  const parsedNew = overrideOf(after, 'card-a', '#subtitle');
  assert.equal(parsedNew.entry.style['line-height'], 'normal');

  const typed = await editField(page, 'lineHeight', '1.6');
  const commit = typed.log.filter((l) => l.step === 'commit').at(-1);
  assert.equal(commit.ok, true, JSON.stringify(commit.response));
  const entry = commit.request.ops[0].entries.find((e) => e.at === '#subtitle');
  assert.equal(entry.style['line-height'], '1.6', `从 normal 输入数字应写成无单位 1.6：${entry.style['line-height']}`);

  await handle.dispose();
  evidence.cases['S16-A5'] = {
    ok: true,
    shown,
    emptyCommit: empty.state.error,
    normalWrite: { request: back.request, response: back.response, entry: parsedNew.entry },
    numericAfterNormal: entry.style['line-height']
  };
});

/* ── A6 ─────────────────────────────────────────────────────────────────── */

test('S16-A6 解析器单测：48px / 1.4 / -0.5px / normal 的形状', async () => {
  const mod = await import(new URL('./inspector-fields.mjs', import.meta.url).href);
  const { parseNumericValue, NUMERIC_STYLE_FIELDS } = mod;

  assert.deepEqual(parseNumericValue('48px'), { kind: 'number', value: 48, suffix: 'px', raw: '48px' });
  assert.deepEqual(parseNumericValue('1.4'), { kind: 'number', value: 1.4, suffix: '', raw: '1.4' });
  assert.deepEqual(parseNumericValue('-0.5px'), { kind: 'number', value: -0.5, suffix: 'px', raw: '-0.5px' });
  assert.deepEqual(parseNumericValue('normal'), { kind: 'normal', raw: 'normal' });
  assert.deepEqual(parseNumericValue(''), { kind: 'empty', raw: '' });
  assert.equal(parseNumericValue('abc').kind, 'error');
  assert.equal(NUMERIC_STYLE_FIELDS.fontSize.exclusiveMin, true);
  assert.equal(NUMERIC_STYLE_FIELDS.lineHeight.allowNormal, true);

  evidence.cases['S16-A6'] = {
    ok: true,
    samples: ['48px', '1.4', '-0.5px', 'normal', ''].map((v) => ({ input: v, parsed: parseNumericValue(v) })),
    specs: Object.keys(NUMERIC_STYLE_FIELDS)
  };
});
