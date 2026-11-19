// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S13-BOX-EDITOR 验收 A1..A7
 *
 * 面板的「位置/尺寸/旋转」走 **另一条写入口**：`set` op + `field:'box'`，
 * 落到片段自己的 `style`（`left/top/width/height/rotate`），由真实 Studio 的 `/ops` 落盘。
 *
 * 这里没有 stub：起 `startStudio({port:0})`，工程是计划样例的副本，面板挂在**真实 film.html** 上，
 * 被改的是 `<iframe id="card-a">`（片段本身），不是场景里的小元素。
 *
 * 运行：node --test --test-concurrency=1 packages/layers/box-editor.test.mjs（env 由 test-env.mjs 自动准备；`OPENCUT_ENV_JSON` 可显式覆盖）
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

const TEST_ENV = await resolveLayerTestEnv({ suite: 'box-editor' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');
const PROJECTS = path.join(RUN_ROOT, 'projects');
const BUNDLE_ABS = path.join(RUN_ROOT, 'tmp/box-build/panel.mjs');
const BUNDLE_URL = '/' + path.relative(REPO_ROOT, BUNDLE_ABS).split(path.sep).join('/');

const SAMPLE =
  '/tmp/motioncut-optional-scene-fixture';

/** 舞台运行时会把自己的片段设成 absolute（`packages/studio/server/content-origin.mjs`：
 *  `clip.el.style.position = 'absolute'`）。静态页面没有这一层，所以副本里按同样规则补一条 CSS，
 *  让 `left/top` 真的能挪动片段——这不是给产品打补丁，而是复刻舞台已有的定位行为。 */
const STAGE_CSS =
  '<style id="r7-stage">html,body{margin:0;padding:0}section{position:relative;display:block;width:1280px;height:720px}' +
  'iframe,video,audio{position:absolute;left:0;top:0;border:0;display:block}</style>';

const evidence = { batch: 'B-SUB1-R7-007', suite: 'box-editor.test.mjs', cases: {}, studio: {}, startedAt: new Date().toISOString() };

/** @type {SceneHost} */
let host;
/** @type {any} */
let studio;
let harnessOrigin = '';

const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

async function buildBundle() {
  await fs.mkdir(path.dirname(BUNDLE_ABS), { recursive: true });
  await esbuild({
    stdin: {
      contents: [
        "export { mountInspector } from './packages/layers/inspector-panel.mjs';",
        "export { readLayer } from './packages/layers/describe.ts';",
        "export { applyOverrideEntries, applyBoxValue, clearBoxValue, readBoxState, readTransformState } from './packages/layers/apply-overrides.mjs';",
        "export { createOpsClient } from './packages/layers/ops-client.mjs';",
        "export { mergeOverridesAt } from './packages/layers/override-merge.mjs';",
        "export { patchForBox, normalizeBox, BOX_FIELD_MAP } from './packages/layers/inspector-fields.mjs';"
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
  await fs.writeFile(path.join(EVIDENCE_DIR, 's13-box-editor.json'), JSON.stringify(evidence, null, 2) + '\n');
}

before(async () => {
  const env = JSON.parse(await fs.readFile(path.join(RUN_ROOT, 'env.json'), 'utf8'));
  evidence.batch = env.batchId ?? evidence.batch;
  await buildBundle();
  host = await new SceneHost({ port: Number(env.studioPort) }).start();
  const harnessPort = host.http.port;
  harnessOrigin = `http://127.0.0.1:${harnessPort}`;
  studio = await startStudio({ port: 0, vitePort: harnessPort, logger: () => {} });
  evidence.studio = { port: studio.port, url: studio.url, harnessOrigin };
});

after(async () => {
  await save();
  if (studio) await studio.close();
  if (host) await host.stop();
});

/* ── HTTP 小工具 ───────────────────────────────────────────────────────── */

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
 * 复制样例 → 补舞台 CSS → 真实 open。可选先改一刀（锁轨、外部改动）。
 */
async function makeProject(name, mutate) {
  const dir = path.join(PROJECTS, `${name}-${process.pid}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.cp(SAMPLE, dir, { recursive: true });
  const filmPath = path.join(dir, 'film.html');
  const film = await fs.readFile(filmPath, 'utf8');
  assert.ok(film.includes('</head>'), '样例 film.html 应有 head');
  await fs.writeFile(filmPath, film.replace('</head>', `${STAGE_CSS}</head>`));
  if (mutate) await mutate(dir);
  const opened = await post(`${studio.url}/api/projects/open`, { dir });
  assert.equal(opened.status, 200, `open 失败：${opened.text}`);
  const projectId = opened.json.project.projectId;
  const doc = await get(`${studio.url}/api/projects/${encodeURIComponent(projectId)}/doc`);
  assert.equal(doc.status, 200, `doc 失败：${doc.text}`);
  return { dir, projectId, hash: doc.json.hash, filmPath, doc: doc.json.doc ?? doc.json };
}

/** 从工程 doc 里取片段的声明 box（面板的 `boxOf` 用它，而不是拿实测矩形当声明）。 */
async function declaredBoxOf(projectId, clipId) {
  const doc = await get(`${studio.url}/api/projects/${encodeURIComponent(projectId)}/doc`);
  const doc2 = doc.json?.doc ?? doc.json;
  const clip = (doc2?.tracks ?? []).flatMap((t) => t.clips ?? []).find((c) => c.id === clipId);
  return { box: clip?.box ?? null, clip: clip ? { id: clip.id, style: clip.style ?? null, box: clip.box ?? null } : null };
}

/**
 * 页内：把面板挂到真实 film.html 上，改 `<iframe id="card-a">`。
 * 预览 = 把 box 写到元素内联声明；回滚 = 恢复提交前的内联 style + 重放旧 overrides。
 */
async function mountLive(deps) {
  const mod = await import(deps.bundle);
  const { createOpsClient, mountInspector, readLayer, applyOverrideEntries, applyBoxValue, mergeOverridesAt } = mod;

  window.__fetches = [];
  const realFetch = window.fetch.bind(window);
  window.fetch = (...args) => {
    window.__fetches.push(String(args[0]));
    return realFetch(...args);
  };

  const log = [];
  const el0 = document.querySelector(deps.at);
  const hosts = {
    entries: [...deps.entries],
    prevEntries: null,
    declaredBox: deps.declaredBox ?? null,
    prevStyle: null,
    commits: 0,
    log,
    baselineStyle: el0 ? el0.getAttribute('style') : null
  };

  const client = createOpsClient({
    projectId: deps.projectId,
    batchId: deps.batchId,
    owner: 'SUB1',
    expectedHash: deps.expectedHash,
    baseUrl: deps.baseUrl
  });

  const container = document.createElement('div');
  container.id = 'sub1-box-panel';
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
    boxOf: () => hosts.declaredBox,
    preview: async (patch) => {
      hosts.prevEntries = hosts.entries;
      hosts.entries = mergeOverridesAt(hosts.entries, deps.at, patch);
      await applyOverrideEntries(hosts.entries);
      log.push({ step: 'preview', patch });
    },
    previewBox: async (op) => {
      if (hosts.prevStyle === null) hosts.prevStyle = document.querySelector(deps.at)?.getAttribute('style') ?? '';
      const res = applyBoxValue({ at: deps.at, box: op.value });
      log.push({ step: 'previewBox', op, positioned: res.positioned, rect: res.rect, declarations: res.declarations });
    },
    revertPreview: async () => {
      const el = document.querySelector(deps.at);
      if (el && hosts.prevStyle !== null) {
        el.removeAttribute('data-ov-box');
        el.removeAttribute('data-ov-box-prev');
        el.removeAttribute('data-ov-box-at');
        if (hosts.prevStyle) el.setAttribute('style', hosts.prevStyle);
        else el.removeAttribute('style');
      }
      hosts.prevStyle = null;
      hosts.entries = hosts.prevEntries ?? hosts.entries;
      await applyOverrideEntries(hosts.entries);
      log.push({ step: 'revert', rect: el ? el.getBoundingClientRect().left : null });
    },
    commit: async (patch) => {
      hosts.commits += 1;
      const next = mergeOverridesAt(hosts.entries, deps.at, patch);
      const res = await client.commitOverrides({ clip: deps.clip, entries: next });
      log.push({ step: 'commit', ok: res.ok, code: res.code ?? null, status: res.status, request: res.request, response: res.response });
      if (res.ok) hosts.entries = next;
      return res;
    },
    commitBox: async (op) => {
      hosts.commits += 1;
      const res = await client.commitSet({ clip: deps.clip, field: op.field, value: op.value });
      log.push({
        step: 'commitBox',
        ok: res.ok,
        code: res.code ?? null,
        status: res.status,
        request: res.request,
        response: res.response
      });
      if (res.ok) {
        hosts.prevStyle = null;
        hosts.declaredBox = { ...op.value };
      }
      return res;
    },
    onConflict: (info) => {
      hosts.conflict = info;
    },
    expectedHash: deps.expectedHash
  };

  const panel = mountInspector(container, panelDeps);
  await panel.select({ clipId: deps.clip, at: deps.at, kind: 'iframe', name: deps.clip, depth: 0 });
  window.__panel = panel;
  window.__host = hosts;
  window.__client = client;
  window.__mod = mod;
  return panel.getState();
}

/** 打开真实 film.html 并挂面板。 */
async function openFilm(project, opts = {}) {
  const filmRel = path.relative(REPO_ROOT, project.filmPath).split(path.sep).join('/');
  const handle = await host.open(filmRel);
  const page = handle.page;
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  const declared = opts.declaredBox !== undefined ? opts.declaredBox : (await declaredBoxOf(project.projectId, 'card-a')).box;
  await page.evaluate(mountLive, {
    bundle: BUNDLE_URL,
    baseUrl: opts.baseUrl ?? studio.url,
    projectId: project.projectId,
    batchId: 'B-SUB1-R7-007',
    expectedHash: opts.expectedHash ?? project.hash,
    clip: 'card-a',
    at: '#card-a',
    entries: opts.entries ?? [],
    declaredBox: declared
  });
  return { handle, page, consoleErrors };
}

/** 真 input + change 事件改字段。 */
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
    fetches: window.__fetches.length,
    rect: (() => {
      const r = document.querySelector('#card-a').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    })(),
    inline: document.querySelector('#card-a').getAttribute('style') || '',
    inputValue: document.querySelector('.film-inspector [data-field="x"] input')?.value ?? null
  }));
}

/** 公共前后缀 diff（区间 + 字节数），用来证明「只动了这一段」。 */
function diffRange(before, after) {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p += 1;
  let s = 0;
  while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s += 1;
  const oldMid = before.slice(p, before.length - s);
  const newMid = after.slice(p, after.length - s);
  return {
    prefix: p,
    suffix: s,
    oldBytes: Buffer.byteLength(oldMid, 'utf8'),
    newBytes: Buffer.byteLength(newMid, 'utf8'),
    oldMid,
    newMid,
    beforeBytes: Buffer.byteLength(before, 'utf8'),
    afterBytes: Buffer.byteLength(after, 'utf8')
  };
}

/* ── A1 ─────────────────────────────────────────────────────────────────── */

test('S13-A1 left:10 → 40：/ops 200；磁盘只有该片段的 style 变；overrides 不动', async () => {
  const project = await makeProject('s13-a1');
  const { handle, page, consoleErrors } = await openFilm(project);

  const before1 = await fs.readFile(project.filmPath, 'utf8');
  const r1 = await editField(page, 'x', '10');
  const c1 = r1.log.find((l) => l.step === 'commitBox');
  assert.ok(c1, '没有发出 box 提交');
  assert.equal(c1.ok, true, `第一次提交失败：${JSON.stringify(c1.response)}`);
  assert.equal(c1.status, 200);
  assert.equal(c1.request.ops[0].op, 'set');
  assert.equal(c1.request.ops[0].field, 'box');
  const after1 = await fs.readFile(project.filmPath, 'utf8');
  const d1 = diffRange(before1, after1);

  assert.equal(d1.oldMid, '', `第一次提交应该只是插入：${d1.oldMid}`);
  assert.ok(d1.newMid.includes('style='), `改动没落在 style 上：${d1.newMid}`);
  assert.ok(d1.newMid.includes('left: 10px'), `style 里没有 left: 10px：${d1.newMid}`);
  assert.equal(d1.newMid.includes('overrides'), false, '几何提交不该碰 overrides');

  const before2 = after1;
  const r2 = await editField(page, 'x', '40');
  const c2 = r2.log.filter((l) => l.step === 'commitBox').at(-1);
  assert.equal(c2.ok, true, `第二次提交失败：${JSON.stringify(c2.response)}`);
  const after2 = await fs.readFile(project.filmPath, 'utf8');
  const d2 = diffRange(before2, after2);

  /* 最小 diff 落在 `left: 1|4` 这一个字符上：前后缀都非空，改动只有 1 字节 */
  assert.ok(before2.includes('left: 10px'), '第二次改前不是 left: 10px');
  assert.ok(after2.includes('left: 40px'), '第二次改后不是 left: 40px');
  assert.equal(d2.oldMid, '1', `最小 diff 的旧值应为 "1"：${JSON.stringify(d2.oldMid)}`);
  assert.equal(d2.newMid, '4', `最小 diff 的新值应为 "4"：${JSON.stringify(d2.newMid)}`);
  assert.equal(d2.oldBytes, 1);
  assert.equal(d2.newBytes, 1);
  assert.equal(d2.oldMid.includes('overrides') || d2.newMid.includes('overrides'), false, '第二次改动跑到 overrides 上去了');
  assert.ok(d2.prefix > 0 && d2.suffix > 0, '整份文件都被重写了');
  assert.ok(after2.startsWith(before2.slice(0, d2.prefix)), '前缀外被改了');
  const tagOf = (t) => (/<iframe id="card-a"[^>]*>/.exec(t) || [''])[0];
  assert.ok(tagOf(after2).includes('left: 40px'), `片段标签没更新：${tagOf(after2)}`);
  assert.equal(/overrides=/.test(tagOf(after2)), false, `几何提交给片段加了 overrides：${tagOf(after2)}`);

  const reparsed = parse(after2, { path: project.filmPath });
  const errors = reparsed.diagnostics.filter((x) => x.severity === 'error');
  assert.deepEqual(errors, [], `重解析出现错误诊断：${JSON.stringify(errors)}`);
  const cardA = reparsed.doc.tracks.flatMap((t) => t.clips).find((c) => c.id === 'card-a');
  assert.deepEqual(cardA.box, { x: 40, y: 0, w: 300, h: 150 }, `box=${JSON.stringify(cardA.box)}`);
  assert.equal(cardA.overrides ?? undefined, undefined, '几何提交不该写 overrides');
  assert.deepEqual(consoleErrors, [], `面板页有控制台错误：${consoleErrors.join(' | ')}`);

  await handle.dispose();
  evidence.cases['S13-A1'] = {
    ok: true,
    first: { request: c1.request, response: c1.response, diff: d1 },
    second: { request: c2.request, response: c2.response, diff: d2 },
    box: cardA.box,
    diagnostics: reparsed.diagnostics.length
  };
});

/* ── A2 ─────────────────────────────────────────────────────────────────── */

test('S13-A2 预览/舞台侧该片段 rect 左边界变化 ≈ 30px（算法写死）', async () => {
  const project = await makeProject('s13-a2');
  const { handle, page } = await openFilm(project);

  const base = await page.evaluate(() => {
    const r = document.querySelector('#card-a').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, position: getComputedStyle(document.querySelector('#card-a')).position };
  });
  assert.equal(base.position, 'absolute', '片段必须是绝对定位，left 才有视觉效果（舞台就是这么做的）');

  const r1 = await editField(page, 'x', '10');
  const rect10 = r1.rect;
  const r2 = await editField(page, 'x', '40');
  const rect40 = r2.rect;

  const delta = rect40.x - rect10.x;
  /* 算法：rect 是屏幕坐标；本页 1:1（没有缩放），所以 left 的 30px 等价于 rect.x 的 30px。
     允许 ≤1px 误差（子像素舍入 / 缩放误差）。 */
  assert.ok(Math.abs(delta - 30) <= 1, `rect.x 变化 ${delta}，期望 ≈30（10→40）`);
  assert.ok(Math.abs(rect10.x - 10) <= 1, `left:10 后 rect.x=${rect10.x}`);
  assert.ok(Math.abs(rect40.x - 40) <= 1, `left:40 后 rect.x=${rect40.x}`);
  assert.equal(rect40.w, base.w, '只改 left，宽度不该变');
  assert.equal(rect40.h, base.h, '只改 left，高度不该变');

  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, 's13-a2-panel.png') });
  const shot = await fs.readFile(path.join(EVIDENCE_DIR, 's13-a2-panel.png'));

  await handle.dispose();
  evidence.cases['S13-A2'] = {
    ok: true,
    base,
    rect10,
    rect40,
    delta,
    algorithm: 'rect.x(after) - rect.x(before)，页面 1:1 无缩放，容差 1px',
    screenshot: { file: 's13-a2-panel.png', sha256: sha(shot), bytes: shot.length }
  };
});

/* ── A3 ─────────────────────────────────────────────────────────────────── */

test('S13-A3 外部改盘后旧 hash → 409 CONFLICT；文件不变；显示 currentHash；输入复原', async () => {
  /* 外部改动必须发生在**本工程第一次写入之前**：
     `/ops` 落盘是 `rename()` 原子替换（packages/studio/server/film-io.mjs:110），
     首写之后 `fs.watch` 盯的还是旧 inode，外部改动认不到。这是主线行为，本批不改它。 */
  const project = await makeProject('s13-a3', async (dir) => {
    const filmPath = path.join(dir, 'film.html');
    const film = await fs.readFile(filmPath, 'utf8');
    await fs.writeFile(
      filmPath,
      film.replace(
        '<iframe id="card-a" src="scene-a.html#t=0,4" at="0">',
        '<iframe id="card-a" src="scene-a.html#t=0,4" at="0" style="left: 10px; top: 0px; width: 300px; height: 150px">'
      )
    );
  });
  const { handle, page } = await openFilm(project);

  const before = await page.evaluate(() => ({
    input: document.querySelector('.film-inspector [data-field="x"] input').value,
    rect: (() => {
      const r = document.querySelector('#card-a').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    })()
  }));
  assert.equal(before.input, '10', `面板初始 left 应为 10：${before.input}`);

  const edited = await fs.readFile(project.filmPath, 'utf8');
  const external = edited.replace('src="scene-b.html#t=0,4" at="4"', 'src="scene-b.html#t=0,4" at="5"');
  assert.notEqual(external, edited, '外部改动没生效');
  await fs.writeFile(project.filmPath, external);
  const externalHash = sha(external);

  let seen = '';
  for (let i = 0; i < 60; i += 1) {
    const doc = await get(`${studio.url}/api/projects/${encodeURIComponent(project.projectId)}/doc`);
    seen = doc.json?.hash ?? '';
    if (seen === externalHash) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(seen, externalHash, 'Studio 没有认到外部改动');

  const conflicted = await editField(page, 'x', '40');
  const commit = conflicted.log.filter((l) => l.step === 'commitBox').at(-1);
  assert.equal(commit.ok, false, '旧 hash 竟然写成功了');
  assert.equal(commit.status, 409);
  assert.equal(JSON.parse(commit.response.body).code, 'CONFLICT');
  assert.equal(commit.request.envelope.expectedHash, project.hash, '面板用的应是打开时的 hash');

  const banner = await page.evaluate(() => {
    const box = document.querySelector('.film-inspector .inspector-status');
    return { code: box.getAttribute('data-code'), hash: box.getAttribute('data-current-hash'), text: box.textContent };
  });
  assert.equal(banner.code, 'CONFLICT');
  assert.equal(banner.hash, externalHash, `data-current-hash 应等于磁盘 hash：${banner.hash}`);
  assert.ok(banner.text.includes(externalHash));

  const afterAttempt = await fs.readFile(project.filmPath, 'utf8');
  assert.equal(afterAttempt, external, '409 之后文件被写了');
  assert.equal(sha(afterAttempt), externalHash);
  assert.equal(conflicted.inputValue, '10', `输入框没复原：${conflicted.inputValue}`);
  assert.ok(Math.abs(conflicted.rect.x - 10) <= 1, `DOM 没回滚：rect.x=${conflicted.rect.x}`);

  await handle.dispose();
  evidence.cases['S13-A3'] = {
    ok: true,
    before,
    externalEdit: { from: 'at="4"', to: 'at="5"', externalHash },
    request: commit.request,
    response: commit.response,
    banner,
    inputAfter: conflicted.inputValue,
    rectAfter: conflicted.rect,
    fileUnchanged: true
  };
});

/* ── A4 ─────────────────────────────────────────────────────────────────── */

test('S13-A4 undo 后磁盘字节与修改前逐字节相同', async () => {
  const project = await makeProject('s13-a4');
  const original = await fs.readFile(project.filmPath, 'utf8');
  const originalHash = sha(original);
  const { handle, page } = await openFilm(project);

  const res = await editField(page, 'x', '40');
  const commit = res.log.filter((l) => l.step === 'commitBox').at(-1);
  assert.equal(commit.ok, true, commit.response?.body);
  const editedHash = JSON.parse(commit.response.body).hash;
  assert.notEqual(sha(await fs.readFile(project.filmPath, 'utf8')), originalHash);

  const undone = await post(`${studio.url}/api/projects/${encodeURIComponent(project.projectId)}/undo`, {
    expectedHash: editedHash
  });
  assert.equal(undone.status, 200, undone.text);
  const back = await fs.readFile(project.filmPath, 'utf8');
  assert.equal(back, original, '撤销后没有逐字节回到修改前');
  assert.equal(sha(back), originalHash);

  await handle.dispose();
  evidence.cases['S13-A4'] = {
    ok: true,
    originalHash,
    editedHash,
    undo: { status: undone.status, body: undone.text },
    byteEqual: sha(back) === originalHash
  };
});

/* ── A5 ─────────────────────────────────────────────────────────────────── */

test('S13-A5 锁轨 → LOCKED，且不发第二次请求', async () => {
  /* (a) 服务端锁：section locked */
  const p1 = await makeProject('s13-a5-server', async (dir) => {
    const filmPath = path.join(dir, 'film.html');
    const film = await fs.readFile(filmPath, 'utf8');
    await fs.writeFile(filmPath, film.replace('<section>', '<section locked>'));
  });
  const a = await openFilm(p1);
  const failed = await editField(a.page, 'x', '40');
  const commit = failed.log.filter((l) => l.step === 'commitBox').at(-1);
  assert.equal(commit.ok, false);
  assert.equal(commit.status, 400);
  assert.equal(JSON.parse(commit.response.body).code, 'LOCKED');
  assert.equal(failed.fetches, 1, `失败重试了 ${failed.fetches} 次`);
  assert.equal(failed.state.error.code, 'LOCKED');
  const diskLocked = await fs.readFile(p1.filmPath, 'utf8');
  assert.equal(sha(diskLocked), p1.hash, 'LOCKED 之后文件被写了');
  const positioned = await a.page.evaluate(() => getComputedStyle(document.querySelector('#card-a')).left);
  assert.equal(positioned, '0px', `LOCKED 后 DOM 被改了：left=${positioned}`);
  await a.handle.dispose();

  /* (b) 本地守卫：舞台报锁 → 输入框禁用、0 请求 */
  const p2 = await makeProject('s13-a5-local');
  const b = await openFilm(p2);
  await b.page.evaluate(async () => {
    document.querySelector('#card-a')?.setAttribute('data-lock', 'true');
    await window.__panel.select({ clipId: 'card-a', at: '#card-a', kind: 'iframe', name: 'card-a', depth: 0 });
  });
  const guard = await b.page.evaluate(() => {
    const root = document.querySelector('.film-inspector');
    const inputs = [...root.querySelectorAll('input')];
    return { locked: root.getAttribute('data-locked'), disabled: inputs.every((i) => i.disabled), count: inputs.length };
  });
  assert.equal(guard.locked, 'true');
  assert.ok(guard.count > 0);
  assert.equal(guard.disabled, true);
  const forced = await b.page.evaluate(() => window.__panel.commitField('x', '40'));
  assert.equal(forced.code, 'LOCKED');
  assert.equal(await b.page.evaluate(() => window.__fetches.length), 0, '本地守卫仍发了请求');
  await b.handle.dispose();

  evidence.cases['S13-A5'] = {
    ok: true,
    server: { request: commit.request, response: commit.response, fetches: failed.fetches, left: positioned },
    local: { guard, forced }
  };
});

/* ── A6 ─────────────────────────────────────────────────────────────────── */

test('S13-A6 清空 rotate：声明从 style 里消失（不是写成 0deg）', async () => {
  const project = await makeProject('s13-a6');
  const { handle, page } = await openFilm(project);

  const set = await editField(page, 'rotation', '15');
  const c1 = set.log.filter((l) => l.step === 'commitBox').at(-1);
  assert.equal(c1.ok, true, c1.response?.body);
  const withRotate = await fs.readFile(project.filmPath, 'utf8');
  assert.ok(withRotate.includes('rotate: 15deg'), `没写进 rotate：${withRotate.slice(0, 200)}`);
  const inlineWith = await page.evaluate(() => document.querySelector('#card-a').getAttribute('style'));

  const cleared = await editField(page, 'rotation', '');
  const c2 = cleared.log.filter((l) => l.step === 'commitBox').at(-1);
  assert.equal(c2.ok, true, c2.response?.body);
  assert.equal(c2.request.ops[0].field, 'box');
  assert.equal('r' in c2.request.ops[0].value, false, `清空时 value 里不该有 r：${JSON.stringify(c2.request.ops[0].value)}`);

  const afterClear = await fs.readFile(project.filmPath, 'utf8');
  const d = diffRange(withRotate, afterClear);
  assert.equal(afterClear.includes('rotate'), false, `rotate 声明还在：${d.newMid}`);
  assert.equal(afterClear.includes('0deg'), false, '清空被写成了 0deg');
  assert.ok(d.oldMid.includes('rotate: 15deg'), `旧值不是 rotate: 15deg：${d.oldMid}`);
  assert.equal(d.newMid, '', `清空应该只删不加：${d.newMid}`);

  const reparsed = parse(afterClear, { path: project.filmPath });
  const cardA = reparsed.doc.tracks.flatMap((t) => t.clips).find((c) => c.id === 'card-a');
  assert.equal(cardA.box.r, undefined, `box.r=${cardA.box.r}`);

  await handle.dispose();
  evidence.cases['S13-A6'] = {
    ok: true,
    setRequest: c1.request,
    setInline: inlineWith,
    clearRequest: c2.request,
    diff: d,
    boxAfterClear: cardA.box
  };
});

/* ── A7 ─────────────────────────────────────────────────────────────────── */

test('S13-A7 面板/客户端仍不写盘；两条写入口不互相污染；缺 commitBox 时几何置灰', async () => {
  const products = ['ops-client.mjs', 'inspector-panel.mjs', 'inspector-fields.mjs', 'apply-overrides.mjs'];
  /** @type {Record<string, string[]>} */
  const hits = {};
  for (const name of products) {
    const text = await fs.readFile(path.join(REPO_ROOT, 'packages/layers', name), 'utf8');
    const banned = [/from\s+['"]node:fs/, /require\(['"]fs['"]\)/, /writeFileSync/, /createWriteStream/, /film\.html/];
    hits[name] = banned.filter((re) => re.test(text)).map(String);
  }
  for (const [name, list] of Object.entries(hits)) {
    assert.deepEqual(list, [], `${name} 命中写盘/直读嫌疑：${list.join(',')}`);
  }

  const project = await makeProject('s13-a7');
  const { handle, page } = await openFilm(project);

  /* 同一个片段上，两条写入口各写一次：overrides 写 opacity，set 写 box */
  const o = await editField(page, 'opacity', '0.8');
  const oCommit = o.log.filter((l) => l.step === 'commit').at(-1);
  assert.equal(oCommit.ok, true, oCommit.response?.body);
  assert.equal(oCommit.request.ops[0].op, 'overrides');

  const x = await editField(page, 'x', '64');
  const xCommit = x.log.filter((l) => l.step === 'commitBox').at(-1);
  assert.equal(xCommit.ok, true, xCommit.response?.body);

  const film = await fs.readFile(project.filmPath, 'utf8');
  assert.ok(film.includes('left: 64px'), '几何没落盘');
  const reparsed = parse(film, { path: project.filmPath });
  const cardA = reparsed.doc.tracks.flatMap((tt) => tt.clips).find((c) => c.id === 'card-a');
  assert.ok(Array.isArray(cardA.overrides) && cardA.overrides.length > 0, 'overrides 没写进去');
  const opa = cardA.overrides.find((e2) => e2.at === '#card-a');
  assert.ok(opa && opa.style && opa.style.opacity === '0.8', `overrides 内容不对：${JSON.stringify(opa)}`);
  assert.deepEqual(cardA.box, { x: 64, y: 0, w: 300, h: 150 }, '几何被 overrides 那一笔改掉了');
  const diag = reparsed.diagnostics.filter((d) => d.severity === 'error');
  assert.deepEqual(diag, [], `重解析错误：${JSON.stringify(diag)}`);

  /* 有 commitBox：几何可编辑 */
  const withCommiter = await page.evaluate(() => {
    const row = document.querySelector('.film-inspector [data-field="x"]');
    return { editable: row.getAttribute('data-editable'), kind: row.getAttribute('data-kind'), reason: row.getAttribute('data-locked-reason') };
  });
  assert.equal(withCommiter.kind, 'box');
  assert.equal(withCommiter.editable, 'true');
  assert.equal(withCommiter.reason, '');

  /* 没有 commitBox 的宿主：几何置灰、给原因、点一下也不发请求 */
  const bare = await page.evaluate(async () => {
    const { mountInspector, readLayer, applyOverrideEntries, mergeOverridesAt } = window.__mod;
    const box = document.createElement('div');
    box.id = 'sub1-box-panel-bare';
    document.body.appendChild(box);
    const p = mountInspector(box, {
      describe: async (ref) => {
        const res = readLayer(ref.at);
        return res && res.ok ? res.value : res;
      },
      preview: async () => {},
      commit: async () => ({ ok: true, hash: 'x' })
    });
    await p.select({ clipId: 'card-a', at: '#card-a', kind: 'iframe', name: 'card-a', depth: 0 });
    const row = box.querySelector('[data-field="x"]');
    const input = row.querySelector('input');
    const before = window.__fetches.length;
    const forced = await p.commitField('x', '99');
    return {
      editable: row.getAttribute('data-editable'),
      reason: row.getAttribute('data-locked-reason'),
      disabled: input.disabled,
      forced,
      fetches: window.__fetches.length - before
    };
  });
  assert.equal(bare.editable, 'false', '缺 commitBox 时几何字段必须置灰');
  assert.equal(bare.reason, 'NO_BOX_COMMITTER');
  assert.equal(bare.disabled, true);
  assert.equal(bare.forced.code, 'NO_BOX_COMMITTER');
  assert.equal(bare.fetches, 0, '置灰后仍然发了请求');

  await handle.dispose();
  evidence.cases['S13-A7'] = {
    ok: true,
    hits,
    overridesEntry: cardA.overrides,
    box: cardA.box,
    diagnostics: reparsed.diagnostics.length,
    withCommiter,
    bare
  };
});
