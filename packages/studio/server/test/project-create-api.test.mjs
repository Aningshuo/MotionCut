/**
 * M75-WP01：新建工程 API（B-MAIN-R30-037）。
 *
 * 这一批把「从零开始一个工程」从**测试脚本的私有动作**变成产品能力：
 * `POST /api/projects/create` → 原子落盘 → 索引可见 → 可 open / 可 ops / 可 layers。
 *
 * 逐条对应任务书 §1.1 的八项必做 + 测试清单（≥10 条）：
 *   A1 正常创建 · A2 已存在 409 · A3 并发同名 · A4 name 非法 · A5 dir 越界
 *   A6 原子失败不留半个目录 · A7 index 可见且与磁盘一致 · A8 open 后可 ops
 *   A9 layers 空页面 · A10 模板 sha 稳定 · A11 未知模板 · A12 未知字段
 *   A13 名字边界 64 · A14 create 的 projectId 与 open 的一致
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createProject, minimalFilm, projectIdFor } from '../project-create.mjs';
import { startStudio } from '../studio-server.mjs';

/** @param {string} text */
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * 假 page：`/api/layers` 只用到 evaluate（discover 的 snapshotLayers）。
 * 回的是模板那条空轨（`#main`）——A9 由此证明路由**真的进了工程文档**而不是短路返回空。
 * @param {{layers?: any[]}} [state]
 */
function fakePage(state = {}) {
  /** @type {{film: number}} */
  const calls = { film: 0 };
  const layers = state.layers ?? [{ at: '#main', kind: 'container', name: 'main', depth: 1, parentAt: null }];
  return {
    calls,
    isClosed: () => false,
    url: () => 'http://127.0.0.1:0/p/fake/film.html',
    on() {},
    /** @param {any} fn @param {any} arg */
    async evaluate(fn, arg) {
      const name = typeof fn === 'function' ? fn.name : '';
      if (name === 'snapshotLayers') {
        calls.film += 1;
        return { layers, unsupported: [], pixelOnly: [] };
      }
      if (name === 'measureLayersInPage') return (Array.isArray(arg) ? arg : []).map((at) => ({ at, tag: 'section', text: '', box: { x: 0, y: 0, w: 0, h: 0 } }));
      if (name === 'locateByAt') return { matches: 0 };
      if (name === '') return 'OK';
      return 3;
    },
  };
}

/**
 * 起一个 Studio（projectsRoot = 临时根）+ 一个 home。
 * @param {(ctx: {root: string, home: string, studio: any, page: any}) => Promise<void>} fn
 */
async function withStudio(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-m75-'));
  const home = path.join(root, 'home');
  await fs.mkdir(home);
  const page = fakePage();
  const studio = await startStudio({
    port: 0,
    vitePort: 0,
    home,
    projectsRoot: root,
    readApiPage: async () => page,
  });
  try {
    await fn({ root, home, studio, page });
  } finally {
    await studio.close().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/**
 * @param {string} url @param {unknown} [body]
 */
async function post(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** @param {string} url */
async function get(url) {
  const response = await fetch(url);
  return { status: response.status, body: await response.json().catch(() => null) };
}

/* ── A1 正常创建 ──────────────────────────────────────────────────────── */

test('A1 正常创建：201、dir/sha 回显、film.html 就是模板、舞台 1920×1080', async () => {
  await withStudio(async ({ root, studio }) => {
    const created = await post(`${studio.url}/api/projects/create`, { name: 'my-film' });
    assert.equal(created.status, 201);
    assert.equal(created.body.ok, true);
    assert.equal(created.body.dir, path.join(root, 'my-film'));
    assert.equal(created.body.projectId, projectIdFor(path.join(root, 'my-film')));
    assert.match(created.body.filmHtmlSha256, /^[0-9a-f]{64}$/);

    const text = await fs.readFile(path.join(root, 'my-film', 'film.html'), 'utf8');
    assert.equal(sha(text), created.body.filmHtmlSha256);
    assert.equal(created.body.bytes, Buffer.byteLength(text, 'utf8'));
    assert.equal(created.body.template, 'default');

    const opened = await post(`${studio.url}/api/projects/open`, { dir: created.body.dir });
    assert.equal(opened.status, 200);
    const summary = opened.body.project;
    assert.deepEqual(summary.stage, { w: 1920, h: 1080 });
    assert.equal(summary.clipCount, 0);
    // film 方言的结构下限：写路径要求至少一条 `<section>` 轨道，所以「空」= 1 条空轨 0 片段。
    assert.equal(summary.trackCount, 1);
    assert.deepEqual(summary.diagnostics, []);
  });
});

/* ── A2 已存在不覆盖 ──────────────────────────────────────────────────── */

test('A2 目标目录已存在：409 PROJECT_EXISTS，原内容一个字节不动', async () => {
  await withStudio(async ({ root, studio }) => {
    const first = await post(`${studio.url}/api/projects/create`, { name: 'dup' });
    assert.equal(first.status, 201);
    const filmPath = path.join(root, 'dup', 'film.html');
    const before = await fs.readFile(filmPath, 'utf8');

    const second = await post(`${studio.url}/api/projects/create`, { name: 'dup' });
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'PROJECT_EXISTS');
    assert.equal(await fs.readFile(filmPath, 'utf8'), before);

    const entries = await fs.readdir(root);
    assert.ok(!entries.some((name) => name.startsWith('.dup.tmp-')), `不该有临时残留：${entries.join(',')}`);
  });
});

/* ── A3 并发同名只成功一个 ───────────────────────────────────────────── */

test('A3 并发 2 个同名请求：只成功一个，另一个 409', async () => {
  await withStudio(async ({ root, studio }) => {
    const [left, right] = await Promise.all([
      post(`${studio.url}/api/projects/create`, { name: 'race' }),
      post(`${studio.url}/api/projects/create`, { name: 'race' }),
    ]);
    const statuses = [left.status, right.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [201, 409]);
    const ok = left.status === 201 ? left : right;
    assert.equal(ok.body.dir, path.join(root, 'race'));

    const entries = await fs.readdir(root);
    assert.equal(entries.filter((name) => name === 'race').length, 1);
    assert.ok(!entries.some((name) => name.startsWith('.race.tmp-')));
  });
});

/* ── A4 name 非法：逐项带 field ──────────────────────────────────────── */

test('A4 name 非法（空/超长/斜杠/反斜杠/控制字符/..）：400 + field=name', async () => {
  await withStudio(async ({ root, home, studio }) => {
    const initialEntries = await fs.readdir(root);
    const cases = ['', ' '.repeat(2), 'a'.repeat(65), 'a/b', 'a\\b', 'a\u0001b', '..'];
    for (const name of cases) {
      const result = await post(`${studio.url}/api/projects/create`, { name });
      assert.equal(result.status, 400, `name=${JSON.stringify(name)} 应 400`);
      assert.equal(result.body.code, 'PROJECT_NAME_INVALID');
      assert.equal(result.body.field, 'name');
    }
    // 全部被拒之后，根目录和工程索引都不应有新记录。
    assert.deepEqual(await fs.readdir(root), initialEntries);
    assert.equal(await exists(path.join(home, '.opencut', 'projects.json')), false);
  });
});

/* ── A5 路径边界：落盘前抛 ───────────────────────────────────────────── */

test('A5 dir 越界：400 E_PATH_ESCAPE，越界目录里一个文件都没写', async () => {
  await withStudio(async ({ studio }) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-m75-outside-'));
    try {
      const result = await post(`${studio.url}/api/projects/create`, { name: 'sneaky', dir: outside });
      assert.equal(result.status, 400);
      assert.equal(result.body.code, 'E_PATH_ESCAPE');
      assert.equal(result.body.field, 'dir');
      assert.deepEqual(await fs.readdir(outside), []);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

/* ── A6 原子失败不留半个目录 ─────────────────────────────────────────── */

test('A6 落盘中途失败：目标目录不存在、父目录无临时残留', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-m75-atomic-'));
  try {
    await assert.rejects(
      createProject({
        name: 'half',
        root,
        probe: () => {
          throw new Error('probe: 模拟 rename 之前失败');
        },
      }),
      /probe/,
    );
    assert.equal(await exists(path.join(root, 'half')), false);
    const entries = await fs.readdir(root);
    assert.deepEqual(entries, [], `父目录不该留下任何东西：${entries.join(',')}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/* ── A7 索引可见且与磁盘一致 ─────────────────────────────────────────── */

test('A7 创建后 GET /api/projects 立刻可见，projects.json 条目与磁盘一致', async () => {
  await withStudio(async ({ root, home, studio }) => {
    const created = await post(`${studio.url}/api/projects/create`, { name: 'indexed' });
    assert.equal(created.status, 201);
    assert.equal(created.body.index.ok, true);

    const listed = await get(`${studio.url}/api/projects`);
    assert.equal(listed.status, 200);
    const scanned = listed.body.projects.map((/** @type {any} */ item) => item.projectId);
    assert.ok(scanned.includes(created.body.projectId), `扫描列表缺 ${created.body.projectId}：${scanned.join(',')}`);
    const canonicalDir = await fs.realpath(created.body.dir);
    const recent = listed.body.recent.map((/** @type {any} */ item) => item.path);
    assert.ok(recent.includes(canonicalDir), `最近列表缺 ${canonicalDir}：${recent.join(',')}`);

    const raw = JSON.parse(await fs.readFile(path.join(home, '.opencut', 'projects.json'), 'utf8'));
    const entry = raw.projects.find((/** @type {any} */ item) => item.path === canonicalDir);
    assert.ok(entry !== undefined);
    assert.equal(entry.name, 'indexed');
    const stat = await fs.stat(created.body.dir);
    assert.equal(stat.isDirectory(), true);
  });
});

/* ── A8 创建后可 ops ─────────────────────────────────────────────────── */

test('A8 创建 → open → /ops 能写（先改舞台，再插一条片段）', async () => {
  await withStudio(async ({ studio }) => {
    const created = await post(`${studio.url}/api/projects/create`, { name: 'writable' });
    assert.equal(created.status, 201);
    const opened = await post(`${studio.url}/api/projects/open`, { dir: created.body.dir });
    assert.equal(opened.status, 200);
    const projectId = opened.body.project.projectId;
    assert.equal(projectId, created.body.projectId);

    /**
     * 两批分开写：`writeValue` 里「舞台变了」是**独占分支**（patchStage 之后直接 finish），
     * 同一批再带时间线改动会被判「写回后的文档与目标值不一致」。那是 film-core 的既有边界，
     * 不是新工程的问题——所以这里按它支持的方式分两批，两批都是真写。
     */
    const before = await get(`${studio.url}/api/projects/${projectId}/doc`);
    const stage = await post(`${studio.url}/api/projects/${projectId}/ops`, {
      envelope: {
        projectId,
        batchId: 'B-MAIN-R30-037',
        owner: 'MAIN',
        opId: 'm75-a8-stage',
        expectedHash: before.body.hash,
      },
      ops: [{ op: 'stage', w: 1280, h: 720 }],
    });
    assert.equal(stage.status, 200);
    assert.equal(stage.body.ok, true);
    assert.notEqual(stage.body.hash, before.body.hash);

    const insert = await post(`${studio.url}/api/projects/${projectId}/ops`, {
      envelope: {
        projectId,
        batchId: 'B-MAIN-R30-037',
        owner: 'MAIN',
        opId: 'm75-a8-insert',
        expectedHash: stage.body.hash,
      },
      ops: [{ op: 'insert', clip: { id: 'c1', src: 'assets/none.mp4', time: [0, 3] } }],
    });
    assert.equal(insert.status, 200);
    assert.equal(insert.body.ok, true);

    const after = await get(`${studio.url}/api/projects/${projectId}/doc`);
    assert.deepEqual(after.body.doc.stage, { w: 1280, h: 720 });
    assert.equal(after.body.doc.tracks[0].clips[0].id, 'c1');
  });
});

/* ── A9 layers 读到空页面 ────────────────────────────────────────────── */

test('A9 新工程的 /api/layers 可读（假 page 证路由，真浏览器证据在 m75 脚本）', async () => {
  await withStudio(async ({ studio, page }) => {
    const created = await post(`${studio.url}/api/projects/create`, { name: 'empty-page' });
    const opened = await post(`${studio.url}/api/projects/open`, { dir: created.body.dir });
    const projectId = opened.body.project.projectId;
    const layers = await get(`${studio.url}/api/layers?project=${encodeURIComponent(projectId)}`);
    assert.equal(layers.status, 200);
    // 假 page 只证「路由把请求接到了元素域，并且真的进了工程文档」；
    // 真 DOM 的几何/路径由 `scripts/m75-project-create.mjs` 的 S9（真 headless Chromium）证明。
    assert.ok(Array.isArray(layers.body.layers));
    assert.deepEqual(
      layers.body.layers.map((/** @type {any} */ layer) => layer.id),
      ['#main'],
    );
    assert.ok(page.calls.film >= 1, 'layers 必须真的去读工程文档');

    const doc = await get(`${studio.url}/api/projects/${projectId}/doc`);
    assert.equal(doc.body.doc.tracks.length, 1);
    assert.equal(doc.body.doc.tracks[0].clips.length, 0);
  });
});

/* ── A10 模板 sha 稳定 ──────────────────────────────────────────────── */

test('A10 模板 sha 稳定：不同名字同一模板 → 同一个 sha，且等于 minimalFilm()', async () => {
  await withStudio(async ({ studio }) => {
    const one = await post(`${studio.url}/api/projects/create`, { name: 'alpha' });
    const two = await post(`${studio.url}/api/projects/create`, { name: 'beta' });
    assert.equal(one.status, 201);
    assert.equal(two.status, 201);
    assert.equal(one.body.filmHtmlSha256, two.body.filmHtmlSha256);
    assert.equal(one.body.filmHtmlSha256, sha(minimalFilm()));
  });
});

/* ── A11 未知模板 ────────────────────────────────────────────────────── */

test('A11 未知模板：400 PROJECT_TEMPLATE_UNKNOWN + field=template', async () => {
  await withStudio(async ({ studio }) => {
    const result = await post(`${studio.url}/api/projects/create`, { name: 'x', template: 'fancy' });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'PROJECT_TEMPLATE_UNKNOWN');
    assert.equal(result.body.field, 'template');
  });
});

/* ── A12 未知字段 ────────────────────────────────────────────────────── */

test('A12 未知字段：400 UNKNOWN_FIELD（不静默忽略）', async () => {
  await withStudio(async ({ root, studio }) => {
    const initialEntries = await fs.readdir(root);
    const result = await post(`${studio.url}/api/projects/create`, { name: 'x', width: 800 });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'UNKNOWN_FIELD');
    assert.deepEqual(result.body.fields, ['width']);
    assert.deepEqual(await fs.readdir(root), initialEntries);
  });
});

/* ── A13 名字边界 64 ────────────────────────────────────────────────── */

test('A13 名字恰好 64 个字符：201（边界是闭区间）', async () => {
  await withStudio(async ({ root, studio }) => {
    const name = 'n'.repeat(64);
    const result = await post(`${studio.url}/api/projects/create`, { name });
    assert.equal(result.status, 201);
    assert.equal(result.body.dir, path.join(root, name));
  });
});

/* ── A14 projectId 两处一致 ─────────────────────────────────────────── */

test('A14 create 返回的 projectId 与 open 之后的 projectId 一致（同一公式）', async () => {
  await withStudio(async ({ studio }) => {
    const created = await post(`${studio.url}/api/projects/create`, { name: 'same-id' });
    const opened = await post(`${studio.url}/api/projects/open`, { dir: created.body.dir });
    assert.equal(opened.body.project.projectId, created.body.projectId);
    assert.equal(created.body.projectId, projectIdFor(created.body.dir));
  });
});

/** @param {string} target */
async function exists(target) {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}
