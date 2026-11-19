// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S11-INSPECTOR-LIVE 验收 A1..A9（A10 是 tsc + 全量回归，在批次日志里）
 *
 * 这里**没有 stub**：起的是起点树里真实的 Studio（`startStudio({port:0})`），
 * 面板页（真实计划样例的 scene-a.html）通过真实 `POST /api/projects/:id/ops` 改工程，
 * 落盘、CAS、409、LOCKED、undo 全部由服务端完成。本侧只用 HTTP，不写工程文件。
 *
 * 运行：node --test --test-concurrency=1 packages/layers/inspector-panel.test.mjs（env 由 test-env.mjs 自动准备；`OPENCUT_ENV_JSON` 可显式覆盖）
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

const TEST_ENV = await resolveLayerTestEnv({ suite: 'inspector-panel' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');
const PROJECTS = path.join(RUN_ROOT, 'projects');
const BUNDLE_ABS = path.join(RUN_ROOT, 'tmp/panel-build/panel.mjs');
const BUNDLE_URL = '/' + path.relative(REPO_ROOT, BUNDLE_ABS).split(path.sep).join('/');

const SAMPLE =
  '/tmp/motioncut-optional-scene-fixture';

const evidence = {
  batch: 'B-SUB1-R6-006',
  suite: 'inspector-panel.test.mjs',
  cases: {},
  studio: {},
  startedAt: new Date().toISOString()
};

/** @type {SceneHost} */
let host;
/** @type {any} */
let studio;
let harnessOrigin = '';

const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const relToRepo = (abs) => path.relative(REPO_ROOT, abs).split(path.sep).join('/');

async function buildBundle() {
  await fs.mkdir(path.dirname(BUNDLE_ABS), { recursive: true });
  await esbuild({
    stdin: {
      contents: [
        "export { mountInspector } from './packages/layers/inspector-panel.mjs';",
        "export { readLayer } from './packages/layers/describe.ts';",
        "export { applyOverrideEntries } from './packages/layers/apply-overrides.mjs';",
        "export { createOpsClient } from './packages/layers/ops-client.mjs';",
        "export { mergeOverridesAt } from './packages/layers/override-merge.mjs';"
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
  await fs.writeFile(path.join(EVIDENCE_DIR, 's11-inspector-live.json'), JSON.stringify(evidence, null, 2) + '\n');
}

before(async () => {
  const env = JSON.parse(await fs.readFile(path.join(RUN_ROOT, 'env.json'), 'utf8'));
  evidence.batch = env.batchId ?? evidence.batch;
  await buildBundle();
  host = await new SceneHost({ port: Number(env.studioPort) }).start();
  const harnessPort = host.http.port;
  harnessOrigin = `http://127.0.0.1:${harnessPort}`;
  /* 真实 Studio：随机端口；vitePort = harness 端口，CORS 才放行这一页（服务端行为，不改） */
  studio = await startStudio({ port: 0, vitePort: harnessPort, logger: () => {} });
  evidence.studio = { port: studio.port, url: studio.url, harnessOrigin, vitePort: harnessPort };
});

after(async () => {
  await save();
  if (studio) await studio.close();
  if (host) await host.stop();
});

/* ── HTTP 小工具（Node 侧；面板侧走浏览器 fetch） ───────────────────────── */

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

/** 复制计划样例到运行根，可先改一刀，然后真实 open + 读 doc。 */
async function makeProject(name, mutate) {
  const dir = path.join(PROJECTS, `${name}-${process.pid}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.cp(SAMPLE, dir, { recursive: true });
  if (mutate) await mutate(dir);
  const opened = await post(`${studio.url}/api/projects/open`, { dir });
  assert.equal(opened.status, 200, `open 失败：${opened.text}`);
  const projectId = opened.json.project.projectId;
  const doc = await get(`${studio.url}/api/projects/${encodeURIComponent(projectId)}/doc`);
  assert.equal(doc.status, 200, `doc 失败：${doc.text}`);
  return { dir, projectId, hash: doc.json.hash, filmPath: path.join(dir, 'film.html') };
}

/**
 * 页内：把面板挂到**真实场景页**上（不复制、不改造样例），依赖真实 Studio 的 HTTP。
 * 回滚语义：这一步没有第二个文档可重载，所以按「提交前的文本快照」还原场景文本，
 * 再重新应用提交前的 entries——顺序等价于宿主「重画该帧 → 应用旧覆盖」。
 */
async function mountLive(deps) {
  const mod = await import(deps.bundle);
  const { createOpsClient, mountInspector, readLayer, applyOverrideEntries, mergeOverridesAt } = mod;

  /* 记一笔真实请求次数，用来证明「失败只发一次、不重试风暴」 */
  window.__fetches = [];
  const realFetch = window.fetch.bind(window);
  window.fetch = (...args) => {
    window.__fetches.push(String(args[0]));
    return realFetch(...args);
  };

  const log = [];
  const el0 = document.querySelector(deps.at);
  const baselineText = el0 ? el0.textContent : null;
  const hosts = { entries: [...deps.entries], prevEntries: null, commits: 0, committedHash: deps.expectedHash, log, baselineText };
  const readText = (sel) => document.querySelector(sel)?.textContent ?? null;

  const client = createOpsClient({
    projectId: deps.projectId,
    batchId: deps.batchId,
    owner: 'SUB1',
    expectedHash: deps.expectedHash,
    baseUrl: deps.baseUrl
  });

  const container = document.createElement('div');
  container.id = 'sub1-panel-root';
  container.setAttribute(
    'style',
    'position:fixed;right:0;top:0;width:300px;height:100vh;background:#111a2e;color:#eef2ff;z-index:2147483647;' +
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
      log.push({ step: 'preview', patch, text: readText(deps.at) });
    },
    revertPreview: async () => {
      hosts.entries = hosts.prevEntries ?? hosts.entries;
      const el = document.querySelector(deps.at);
      if (el) el.textContent = hosts.baselineText;
      await applyOverrideEntries(hosts.entries);
      log.push({ step: 'revert', text: readText(deps.at) });
    },
    commit: async (patch) => {
      hosts.commits += 1;
      const next = mergeOverridesAt(hosts.entries, deps.at, patch);
      const res = await client.commitOverrides({ clip: deps.clip, entries: next });
      log.push({
        step: 'commit',
        ok: res.ok,
        code: res.code ?? null,
        status: res.status,
        request: res.request,
        response: res.response
      });
      if (res.ok) {
        hosts.entries = next;
        hosts.committedHash = res.hash;
      }
      return res;
    },
    onConflict: (info) => {
      hosts.conflict = info;
    },
    expectedHash: deps.expectedHash
  };

  const panel = mountInspector(container, panelDeps);
  await panel.select({ clipId: deps.clip, at: deps.at, kind: 'text', name: 'subtitle', depth: 1 });
  window.__panel = panel;
  window.__host = hosts;
  window.__client = client;
  window.__mod = mod;
  return panel.getState();
}

/** 打开真实场景页并挂面板。 */
async function openScene(project, opts = {}) {
  const sceneRel = relToRepo(path.join(project.dir, 'scene-a.html'));
  const handle = await host.open(sceneRel);
  const page = handle.page;
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  await page.evaluate(mountLive, {
    bundle: BUNDLE_URL,
    baseUrl: opts.baseUrl ?? studio.url,
    projectId: project.projectId,
    batchId: 'B-SUB1-R6-006',
    expectedHash: opts.expectedHash ?? project.hash,
    clip: 'card-a',
    at: '#subtitle',
    entries: opts.entries ?? []
  });
  if (opts.lockAttr) {
    await page.evaluate(async () => {
      document.querySelector('#subtitle')?.setAttribute('data-lock', 'true');
      await window.__panel.select({ clipId: 'card-a', at: '#subtitle', kind: 'text', name: 'subtitle', depth: 1 });
    });
  }
  return { handle, page, consoleErrors };
}

/** 通过真实 input + change 事件改字段（走面板的事件链，不是直接调内部函数）。 */
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
    text: document.querySelector('#subtitle').textContent,
    fetches: window.__fetches.length,
    persist: document.querySelector('.film-inspector')?.getAttribute('data-persist')
  }));
}

/* ── A1 ─────────────────────────────────────────────────────────────────── */

test('S11-A1 真实 Studio 随机端口；OPTIONS 204 且 ACAO 只回 harness origin', async () => {
  const project = await makeProject('s11-a1');
  const url = `${studio.url}/api/projects/${encodeURIComponent(project.projectId)}/ops`;

  const ok = await fetch(url, { method: 'OPTIONS', headers: { origin: harnessOrigin } });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), harnessOrigin, 'ACAO 必须回 harness origin');
  assert.notEqual(ok.headers.get('access-control-allow-origin'), '*', 'ACAO 不得是通配');

  const foreign = await fetch(url, { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:1' } });
  const foreignBody = await foreign.text();
  assert.equal(foreign.status, 403, '外来 origin 必须被拒');
  assert.match(foreignBody, /ORIGIN_REJECTED/);

  const { handle, consoleErrors } = await openScene(project);
  const mounted = await handle.page.evaluate(() => window.__panel.getState());
  assert.equal(mounted.at, '#subtitle');
  assert.deepEqual(consoleErrors, [], `面板页有控制台错误：${consoleErrors.join(' | ')}`);
  await handle.dispose();

  evidence.cases['S11-A1'] = {
    ok: true,
    studioPort: studio.port,
    harnessOrigin,
    preflight: { status: ok.status, acao: ok.headers.get('access-control-allow-origin') },
    foreignOrigin: { status: foreign.status, body: foreignBody, sentOrigin: 'http://127.0.0.1:1' },
    consoleErrors
  };
});

/* ── A2 ─────────────────────────────────────────────────────────────────── */

test('S11-A2 真实写入 200：响应 hash == 磁盘 hash，只变目标条目，重解析 0 诊断', async () => {
  const project = await makeProject('s11-a2');
  const before = await fs.readFile(project.filmPath, 'utf8');
  const { handle, page } = await openScene(project);

  const textBefore = await page.evaluate(() => document.querySelector('#subtitle').textContent);
  assert.equal(textBefore, '选中文字后修改样式');

  const res = await editField(page, 'text', '面板写进工程的副标题');
  const commit = res.log.find((l) => l.step === 'commit');
  assert.ok(commit, '没有发出提交');
  assert.equal(commit.ok, true, `提交失败：${JSON.stringify(commit.response)}`);
  assert.equal(commit.status, 200);

  const after = await fs.readFile(project.filmPath, 'utf8');
  const diskHash = sha(after);
  const responseJson = JSON.parse(commit.response.body);
  assert.equal(responseJson.hash, diskHash, '响应 hash 与磁盘 hash 不一致');
  assert.equal(res.state.hash, diskHash);
  assert.equal(res.persist, 'real', `data-persist 应为 real，实际 ${res.persist}`);
  const shownHash = await page.evaluate(() => document.querySelector('.film-inspector').getAttribute('data-hash'));
  assert.equal(shownHash, diskHash);

  /* 只变目标条目：公共前缀/后缀之外只有 overrides 那一段 */
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p += 1;
  let s = 0;
  while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s += 1;
  const oldMid = before.slice(p, before.length - s);
  const newMid = after.slice(p, after.length - s);
  assert.equal(oldMid.includes('overrides'), false, `改动不该落在已有 overrides 之外：${oldMid.slice(0, 80)}`);
  assert.ok(newMid.includes('overrides'), `改动没落在 overrides 上：${newMid.slice(0, 120)}`);
  assert.ok(newMid.includes('面板写进工程的副标题'));
  assert.ok(after.startsWith(before.slice(0, p)) && after.endsWith(before.slice(before.length - s)), '其他区域字节应保持不变');

  const reparsed = parse(after, { path: project.filmPath });
  const errors = reparsed.diagnostics.filter((d) => d.severity === 'error');
  assert.deepEqual(errors, [], `重解析出现错误诊断：${JSON.stringify(errors)}`);
  const cardA = reparsed.doc.tracks.flatMap((t) => t.clips).find((c) => c.id === 'card-a');
  const entry = cardA.overrides.find((o) => o.at === '#subtitle');
  assert.equal(entry.t, '面板写进工程的副标题');
  assert.equal(res.text, '面板写进工程的副标题');

  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, 's11-a2-panel.png') });

  await handle.dispose();
  evidence.cases['S11-A2'] = {
    ok: true,
    diskHash,
    request: commit.request,
    response: commit.response,
    changedRegion: { oldMid, newMid },
    diagnostics: reparsed.diagnostics.length,
    entry,
    textOnPage: res.text
  };
});

/* ── A3 ─────────────────────────────────────────────────────────────────── */

test('S11-A3 第二次用上次 hash；opId 不同；磁盘再变；面板 data-hash 同步', async () => {
  const project = await makeProject('s11-a3');
  const { handle, page } = await openScene(project);

  const first = await editField(page, 'text', '第一次');
  const c1 = first.log.filter((l) => l.step === 'commit').at(-1);
  assert.equal(c1.ok, true, c1.response?.body);

  const second = await editField(page, 'text', '第二次');
  const c2 = second.log.filter((l) => l.step === 'commit').at(-1);
  assert.equal(c2.ok, true, c2.response?.body);

  const h1 = JSON.parse(c1.response.body).hash;
  const h2 = JSON.parse(c2.response.body).hash;
  assert.notEqual(h1, h2, '两次写入的 hash 应不同');
  assert.equal(c2.request.envelope.expectedHash, h1, '第二次必须用第一次返回的 hash');
  assert.notEqual(c1.request.envelope.opId, c2.request.envelope.opId, 'opId 重复');

  const disk = await fs.readFile(project.filmPath, 'utf8');
  assert.equal(sha(disk), h2);
  const shown = await page.evaluate(() => document.querySelector('.film-inspector').getAttribute('data-hash'));
  assert.equal(shown, h2);

  await handle.dispose();
  evidence.cases['S11-A3'] = {
    ok: true,
    hashes: [h1, h2],
    opIds: [c1.request.envelope.opId, c2.request.envelope.opId],
    expectHashUsed: c2.request.envelope.expectedHash,
    shownHash: shown
  };
});

/* ── A4 ─────────────────────────────────────────────────────────────────── */

test('S11-A4 外部改盘后旧 hash → 真 409；currentHash 正确；DOM 回滚；文件未被写', async () => {
  const project = await makeProject('s11-a4');
  const { handle, page } = await openScene(project);

  const original = await fs.readFile(project.filmPath, 'utf8');
  const external = original.replace('src="scene-b.html#t=0,4" at="4"', 'src="scene-b.html#t=0,4" at="5"');
  assert.notEqual(external, original, '外部改动没生效');
  await fs.writeFile(project.filmPath, external);
  const externalHash = sha(external);

  /* 等 Studio 的 watcher 认到磁盘变化（doc.hash 变成新 hash 才算认到） */
  let seen = '';
  for (let i = 0; i < 40; i += 1) {
    const doc = await get(`${studio.url}/api/projects/${encodeURIComponent(project.projectId)}/doc`);
    seen = doc.json?.hash ?? '';
    if (seen === externalHash) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(seen, externalHash, 'Studio 没有认到外部改动');

  const res = await editField(page, 'text', '冲突时不该写进去');
  const commit = res.log.find((l) => l.step === 'commit');
  assert.equal(commit.ok, false, '旧 hash 竟然写成功了');
  assert.equal(commit.status, 409);
  assert.equal(JSON.parse(commit.response.body).code, 'CONFLICT');

  const banner = await page.evaluate(() => {
    const box = document.querySelector('.film-inspector .inspector-status');
    return { code: box.getAttribute('data-code'), hash: box.getAttribute('data-current-hash'), text: box.textContent };
  });
  assert.equal(banner.code, 'CONFLICT');
  assert.equal(banner.hash, externalHash, `data-current-hash 应等于磁盘当前 hash：${banner.hash}`);
  assert.ok(banner.text.includes(externalHash), banner.text);

  const afterAttempt = await fs.readFile(project.filmPath, 'utf8');
  assert.equal(sha(afterAttempt), externalHash, '409 之后文件被写了');
  assert.equal(afterAttempt, external, '409 之后文件内容变了');
  assert.equal(res.text, '选中文字后修改样式', `DOM 没回滚：${res.text}`);

  await handle.dispose();
  evidence.cases['S11-A4'] = {
    ok: true,
    externalEdit: { from: 'at="4"', to: 'at="5"', externalHash },
    request: commit.request,
    response: commit.response,
    banner,
    domAfter: res.text,
    fileUnchanged: sha(afterAttempt) === externalHash
  };
});

/* ── A5 ─────────────────────────────────────────────────────────────────── */

test('S11-A5 锁定两路：本地守卫 0 请求；服务端 400 LOCKED 且 DOM 回滚', async () => {
  /* (a) 本地守卫：舞台报告锁定（#subtitle 带 data-lock）→ 面板直接拒绝，不发请求 */
  const p1 = await makeProject('s11-a5-local');
  const a = await openScene(p1, { lockAttr: true });
  const lockedView = await a.page.evaluate(() => {
    const root = document.querySelector('.film-inspector');
    const inputs = [...root.querySelectorAll('input')];
    return { locked: root.getAttribute('data-locked'), disabled: inputs.every((i) => i.disabled), count: inputs.length };
  });
  assert.equal(lockedView.locked, 'true');
  assert.ok(lockedView.count > 0);
  assert.equal(lockedView.disabled, true);
  const forced = await a.page.evaluate(() => window.__panel.commitField('text', '锁定层不该被改'));
  assert.equal(forced.code, 'LOCKED');
  const localFetches = await a.page.evaluate(() => window.__fetches.length);
  assert.equal(localFetches, 0, `本地守卫仍发了 ${localFetches} 个请求`);
  const localText = await a.page.evaluate(() => document.querySelector('#subtitle').textContent);
  assert.equal(localText, '选中文字后修改样式');
  await a.handle.dispose();

  /* (b) 服务端 LOCKED：整条轨锁住（section locked），面板本地不知道，打到服务端才被拒 */
  const p2 = await makeProject('s11-a5-server', async (dir) => {
    const film = await fs.readFile(path.join(dir, 'film.html'), 'utf8');
    await fs.writeFile(path.join(dir, 'film.html'), film.replace('<section>', '<section locked>'));
  });
  const b = await openScene(p2);
  const res = await editField(b.page, 'text', '锁轨上的改动');
  const commit = res.log.find((l) => l.step === 'commit');
  assert.equal(commit.ok, false);
  assert.equal(commit.status, 400);
  assert.equal(JSON.parse(commit.response.body).code, 'LOCKED');
  assert.equal(res.state.error.code, 'LOCKED');
  assert.equal(res.text, '选中文字后修改样式', `LOCKED 后 DOM 没回滚：${res.text}`);
  assert.equal(res.fetches, 1, '失败只该发一次请求');
  const diskLocked = await fs.readFile(p2.filmPath, 'utf8');
  assert.equal(sha(diskLocked), p2.hash, 'LOCKED 之后文件被写了');

  const banner = await b.page.evaluate(() => {
    const box = document.querySelector('.film-inspector .inspector-status');
    return { code: box.getAttribute('data-code'), text: box.textContent };
  });
  assert.equal(banner.code, 'LOCKED');
  await b.handle.dispose();

  evidence.cases['S11-A5'] = {
    ok: true,
    local: { lockedView, forced, fetches: localFetches, text: localText },
    server: { request: commit.request, response: commit.response, state: res.state.error, dom: res.text, banner }
  };
});

/* ── A6 ─────────────────────────────────────────────────────────────────── */

test('S11-A6 撤销：/undo 200；磁盘逐字节回到编辑前；面板 data-source 回 computed', async () => {
  const project = await makeProject('s11-a6');
  const original = await fs.readFile(project.filmPath, 'utf8');
  const { handle, page } = await openScene(project);

  const before = await page.evaluate(() => document.querySelector('.film-inspector [data-field="text"]').getAttribute('data-source'));
  assert.equal(before, 'computed');

  const res = await editField(page, 'text', '待撤销的改动');
  const commit = res.log.find((l) => l.step === 'commit');
  assert.equal(commit.ok, true);
  const editedHash = JSON.parse(commit.response.body).hash;
  assert.notEqual(sha(await fs.readFile(project.filmPath, 'utf8')), sha(original));

  const undone = await post(`${studio.url}/api/projects/${encodeURIComponent(project.projectId)}/undo`, {
    expectedHash: editedHash
  });
  assert.equal(undone.status, 200, undone.text);
  const backText = await fs.readFile(project.filmPath, 'utf8');
  assert.equal(backText, original, '撤销后磁盘文本没有逐字节回到编辑前');
  assert.equal(sha(backText), sha(original));
  await handle.dispose();

  /* 撤销后重开舞台（真实宿主会重载 iframe）：面板重新 describe → override 没了 → data-source 回 computed */
  const restoredHash = JSON.parse(undone.text).hash;
  const reopened = await openScene(project, { expectedHash: restoredHash, entries: [] });
  const afterUndo = await reopened.page.evaluate(() => {
    const row = document.querySelector('.film-inspector [data-field="text"]');
    return { source: row.getAttribute('data-source'), value: row.querySelector('input').value, text: document.querySelector('#subtitle').textContent };
  });
  assert.equal(afterUndo.source, 'computed', '撤销后字段来源没回到 computed');
  assert.equal(afterUndo.value, '选中文字后修改样式');
  assert.equal(afterUndo.text, '选中文字后修改样式');
  await reopened.handle.dispose();
  evidence.cases['S11-A6'] = {
    ok: true,
    beforeSource: before,
    afterSource: afterUndo,
    undo: { status: undone.status, body: undone.text, editedHash },
    byteEqual: sha(backText) === sha(original)
  };
});

/* ── A7 ─────────────────────────────────────────────────────────────────── */

test('S11-A7 产品模块无写盘：无 fs 写接口、无直接读写 film.html', async () => {
  const products = [
    'ops-client.mjs',
    'inspector-panel.mjs',
    'inspector-fields.mjs',
    'override-merge.mjs',
    'apply-overrides.mjs',
    'person-merge.mjs'
  ];
  /** @type {Record<string, string[]>} */
  const hits = {};
  /** @type {string[]} */
  const scanned = [];
  for (const name of products) {
    let text;
    try {
      text = await fs.readFile(path.join(REPO_ROOT, 'packages/layers', name), 'utf8');
    } catch {
      continue; // person-merge 在 S12 之后才有
    }
    scanned.push(name);
    const banned = [
      /from\s+['"]node:fs/,
      /from\s+['"]fs['"]/,
      /require\(['"]fs['"]\)/,
      /writeFile\s*\(/,
      /writeFileSync/,
      /createWriteStream/,
      /film\.html/
    ];
    hits[name] = banned.filter((re) => re.test(text)).map((re) => String(re));
  }
  for (const [name, list] of Object.entries(hits)) {
    assert.deepEqual(list, [], `${name} 命中写盘/直读嫌疑：${list.join(',')}`);
  }

  const client = await import(new URL('./ops-client.mjs', import.meta.url).href);
  const panel = await import(new URL('./inspector-panel.mjs', import.meta.url).href);
  assert.equal(client.OPS_CONTRACT.persistence, 'studio-ops');
  assert.equal(panel.PANEL_PERSISTENCE, 'real');

  evidence.cases['S11-A7'] = {
    ok: true,
    scanned,
    hits,
    exports: { opsPersistence: client.OPS_CONTRACT.persistence, panelPersistence: panel.PANEL_PERSISTENCE }
  };
});

/* ── A8 ─────────────────────────────────────────────────────────────────── */

test('S11-A8 data-persist 为真实态；CAPABILITY.md 更新为「真实 /ops 已接」', async () => {
  const project = await makeProject('s11-a8');
  const { handle, page } = await openScene(project);
  const persist = await page.evaluate(() => {
    const root = document.querySelector('.film-inspector');
    const box = document.querySelector('.film-inspector .inspector-status');
    return { root: root.getAttribute('data-persist'), status: box.getAttribute('data-persist') };
  });
  assert.equal(persist.root, 'real');
  assert.equal(persist.status, 'real');
  await handle.dispose();

  const readme = await fs.readFile(path.join(REPO_ROOT, 'packages/layers/CAPABILITY.md'), 'utf8');
  assert.ok(readme.includes('data-persist'), 'README 未写 data-persist');
  assert.ok(readme.includes('/api/projects/:id/ops'), 'README 未写真实路由');
  assert.equal(/当前状态[^\n]*WAIT_MAIN_IO/.test(readme), false, 'README 仍把 WAIT_MAIN_IO 当当前状态');

  evidence.cases['S11-A8'] = { ok: true, persist, readmeRoute: true };
});

/* ── A9 ─────────────────────────────────────────────────────────────────── */

test('S11-A9 网络失败 → 错误态且只请求一次；非法 payload → 400 INVALID 而非 200', async () => {
  const project = await makeProject('s11-a9');
  const sceneRel = relToRepo(path.join(project.dir, 'scene-a.html'));

  /* (a) 端口关掉：面板提交 → IO 错误、只发一次、无重试风暴 */
  const deadPort = 59399;
  const handle = await host.open(sceneRel);
  const page = handle.page;
  await page.evaluate(mountLive, {
    bundle: BUNDLE_URL,
    baseUrl: `http://127.0.0.1:${deadPort}`,
    projectId: project.projectId,
    batchId: 'B-SUB1-R6-006',
    expectedHash: project.hash,
    clip: 'card-a',
    at: '#subtitle',
    entries: []
  });
  const failed = await editField(page, 'text', '死端口上的改动');
  const commit = failed.log.find((l) => l.step === 'commit');
  assert.equal(commit.ok, false);
  assert.equal(commit.code, 'IO');
  assert.equal(failed.fetches, 1, `失败重试了 ${failed.fetches} 次`);
  assert.equal(failed.state.status, 'error');
  const diskAfterFail = await fs.readFile(project.filmPath, 'utf8');
  assert.equal(sha(diskAfterFail), project.hash, '网络失败竟然写了盘');
  await handle.dispose();

  /* (b) 非法 payload：服务端必须 400 INVALID，而不是 200 */
  const handle2 = await host.open(sceneRel);
  const page2 = handle2.page;
  await page2.evaluate(mountLive, {
    bundle: BUNDLE_URL,
    baseUrl: studio.url,
    projectId: project.projectId,
    batchId: 'B-SUB1-R6-006',
    expectedHash: project.hash,
    clip: 'card-a',
    at: '#subtitle',
    entries: []
  });
  const bad = await page2.evaluate(async () => {
    const res = await window.__client.commitOverrides({
      clip: 'card-a',
      entries: [{ at: '#subtitle', bogus: 'nope' }]
    });
    return { ok: res.ok, code: res.code, status: res.status, response: res.response };
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);
  assert.equal(bad.code, 'INVALID');
  const diskAfterBad = await fs.readFile(project.filmPath, 'utf8');
  assert.equal(sha(diskAfterBad), project.hash, '非法 payload 竟然写了盘');
  await handle2.dispose();

  evidence.cases['S11-A9'] = {
    ok: true,
    network: { code: commit.code, status: commit.status, fetches: failed.fetches, state: failed.state.status },
    invalid: bad
  };
});
