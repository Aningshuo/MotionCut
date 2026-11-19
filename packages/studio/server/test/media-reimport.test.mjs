/**
 * M76-WP16：源升级后覆盖重定位（B-MAIN-R30-037）。
 *
 * `packages/layers/revalidate.mjs` 的 `revalidateOverrides` 从交付起就没有服务端调用方——
 * `POST /api/projects/:id/media/:assetId/reimport` 是它的**第一个产品入口**。
 *
 * 逐条对应任务书 §2.1：
 *   B1 同 id 覆盖保留 · B2 id 变化重定位(MOVED) · B3 元素删除进 conflicts(GONE)
 *   B4 解析失败原子 · B5 源不存在 · B6 源不是 html · B7 hash 不符
 *   B8 重复幂等 · B9 并发只写一次 · B10 原素材 sha 不变 · B11 只写 film.html
 *   B12 非 html 片段/未知 assetId · B13 重开一致 · B14 同一份源的两个片段
 *   B15 工程未打开
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { startStudio } from '../studio-server.mjs';

/** @param {string|Buffer} value */
const sha = (value) => createHash('sha256').update(value).digest('hex');

/** 工程里的页面源（旧版）：三个带 id 的元素，正好对应三条覆盖。 */
const PAGE = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>scene</title></head>
<body>
<section id="stage">
  <h1 id="title">原始标题</h1>
  <img id="photo" src="assets/x.png">
  <p id="caption">原始说明</p>
</section>
</body>
</html>
`;

/** 页面源（第二版）：`#caption` 被删。 */
const PAGE_GONE = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>scene</title></head>
<body>
<section id="stage">
  <h1 id="title">原始标题</h1>
  <img id="photo" src="assets/x.png">
</section>
</body>
</html>
`;

/** 页面源（重命名）：`#title` 的 id 换成 `#headline`，其它不动。 */
const PAGE_RENAMED = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>scene</title></head>
<body>
<section id="stage">
  <h1 id="headline">原始标题</h1>
  <img id="photo" src="assets/x.png">
  <p id="caption">原始说明</p>
</section>
</body>
</html>
`;

/** 页面源（文案微调）：id 全部不变。 */
const PAGE_SAME_IDS = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>scene</title></head>
<body>
<section id="stage">
  <h1 id="title">改过的标题</h1>
  <img id="photo" src="assets/x.png">
  <p id="caption">原始说明</p>
</section>
</body>
</html>
`;

/** 截断的源：还有元素没闭合 → `parseScene` 判 `complete=false`。 */
const PAGE_BROKEN = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>scene</title></head>
<body>
<section id="stage">
  <h1 id="title">没闭合
`;

/** 三条层覆盖（`at` 都是页内唯一 id，`pathOf` 会给出 `#id`）。 */
const OVERRIDES = JSON.stringify([
  { at: '#title', text: '我的标题' },
  { at: '#photo', s: [1.2, 1.2] },
  { at: '#caption', text: '我的说明' },
]).replace(/'/g, '&#39;');

/** @param {string} overridesAttr */
function filmOf(overridesAttr) {
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=1280, height=720"><title>m76</title></head>
<body>
<section id="pages">
<iframe id="scene" src="pages/scene.html#t=0,10" at="1" size="1280x720" overrides='${overridesAttr}' style="left:0px;top:0px;width:1280px;height:720px"></iframe>
</section>
</body>
</html>
`;
}

const FILM = filmOf(OVERRIDES);

/** 两个片段共用同一份源（按文件名解析 assetId 的用例）。 */
const FILM_TWO = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=1280, height=720"><title>m76</title></head>
<body>
<section id="pages">
<iframe id="scene-a" src="pages/scene.html#t=0,5" size="1280x720" overrides='[{"at":"#title","text":"A"}]' style="left:0px;top:0px;width:1280px;height:720px"></iframe>
<iframe id="scene-b" src="pages/scene.html#t=5,10" at="5" size="1280x720" overrides='[{"at":"#caption","text":"B"}]' style="left:0px;top:0px;width:1280px;height:720px"></iframe>
</section>
</body>
</html>
`;

/** 带一个视频片段（用来验「非 page 片段拒绝」）。 */
const FILM_VIDEO = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=1280, height=720"><title>m76</title></head>
<body>
<section id="main">
<video id="v1" src="assets/none.mp4#t=0,3" style="left:0px;top:0px;width:64px;height:36px"></video>
</section>
</body>
</html>
`;

/**
 * 起 Studio + 建工程 + 落夹具 + 打开。
 * @param {(ctx: {root: string, home: string, studio: any, dir: string, projectId: string}) => Promise<void>} fn
 * @param {{pageHtml?: string, filmHtml?: string, open?: boolean}} [options]
 */
async function withProject(fn, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-m76-'));
  const home = path.join(root, 'home');
  const studio = await startStudio({ port: 0, vitePort: 0, home, projectsRoot: root });
  try {
    const created = await post(`${studio.url}/api/projects/create`, { name: 'p' });
    assert.equal(created.status, 201);
    const dir = created.body.dir;
    await fs.mkdir(path.join(dir, 'pages'), { recursive: true });
    await fs.writeFile(path.join(dir, 'pages', 'scene.html'), options.pageHtml ?? PAGE, 'utf8');
    await fs.writeFile(path.join(dir, 'film.html'), options.filmHtml ?? FILM, 'utf8');
    /** @type {string} */
    let projectId = '';
    if (options.open !== false) {
      const opened = await post(`${studio.url}/api/projects/open`, { dir });
      assert.equal(opened.status, 200);
      projectId = opened.body.project.projectId;
    }
    await fn({ root, home, studio, dir, projectId });
  } finally {
    await studio.close().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/** @param {string} url @param {unknown} [body] */
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

/** @param {string} dir */
const filmPathOf = (dir) => path.join(dir, 'film.html');

/** 把一段新源写到工程外的临时文件（reimport 只读它，不复制）。 @param {string} root @param {string} name @param {string} text */
async function writeSource(root, name, text) {
  const file = path.join(root, name);
  await fs.writeFile(file, text, 'utf8');
  return file;
}

/** 读 film.html 里那个 iframe 的 overrides。
 * @param {string} dir @param {string} [clipId]
 * @returns {Promise<any[]>}
 */
async function overridesOf(dir, clipId = 'scene') {
  const text = await fs.readFile(filmPathOf(dir), 'utf8');
  const match = new RegExp(`id="${clipId}"[^>]*overrides='([^']*)'`).exec(text);
  if (match === null) return [];
  return JSON.parse(String(match[1]).replace(/&#39;/g, "'"));
}

/** 工程里除 `.film/**` 之外的文件的相对路径 → sha。 @param {string} dir */
async function treeOf(dir) {
  /** @type {Record<string, string>} */
  const out = {};
  /** @param {string} rel */
  const walk = async (rel) => {
    const abs = path.join(dir, rel);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    for (const entry of entries) {
      const next = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (next === '.film' || next.startsWith('.film/')) continue;
      if (entry.isDirectory()) await walk(next);
      else out[next] = sha(await fs.readFile(path.join(dir, next)));
    }
  };
  await walk('');
  return out;
}

/* ── B1 同 id 保留 ───────────────────────────────────────────────────── */

test('B1 同 id 覆盖保留：三条全 KEPT，无变化 → 不写盘', async () => {
  await withProject(async ({ root, studio, dir, projectId }) => {
    const before = await fs.readFile(filmPathOf(dir), 'utf8');
    const source = await writeSource(root, 'same.html', PAGE_SAME_IDS);
    const result = await post(`${studio.url}/api/projects/${projectId}/media/scene/reimport`, { sourceFile: source });
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.kept, 3);
    assert.equal(result.body.moved, 0);
    assert.equal(result.body.dropped, 0);
    assert.equal(result.body.conflicts, 0);
    assert.equal(result.body.changed, false);
    assert.equal(result.body.alreadyUpToDate, true);
    assert.equal(result.body.filmHtmlSha256, sha(before));
    assert.equal(await fs.readFile(filmPathOf(dir), 'utf8'), before);
    assert.deepEqual(
      result.body.clips[0].entries.map((/** @type {any} */ entry) => entry.status),
      ['KEPT', 'KEPT', 'KEPT'],
    );
  });
});

/* ── B2 id 变化 → MOVED ─────────────────────────────────────────────── */

test('B2 元素 id 变化：MOVED 并把 at 改到新路径，覆盖值原样保留', async () => {
  await withProject(async ({ root, studio, dir, projectId }) => {
    const before = await fs.readFile(filmPathOf(dir), 'utf8');
    const source = await writeSource(root, 'renamed.html', PAGE_RENAMED);
    const result = await post(`${studio.url}/api/projects/${projectId}/media/scene/reimport`, { sourceFile: source });
    assert.equal(result.status, 200);
    assert.equal(result.body.kept, 2);
    assert.equal(result.body.moved, 1);
    assert.equal(result.body.dropped, 0);
    assert.equal(result.body.conflicts, 0);
    assert.equal(result.body.changed, true);
    assert.notEqual(result.body.filmHtmlSha256, sha(before));

    const moved = result.body.clips[0].entries.find((/** @type {any} */ entry) => entry.status === 'MOVED');
    assert.equal(moved.at, '#title');
    assert.equal(moved.newAt, '#headline');

    const after = await overridesOf(dir);
    assert.deepEqual(
      after.map((/** @type {any} */ entry) => entry.at),
      ['#headline', '#photo', '#caption'],
    );
    // 值原样保留：文案还是「我的标题」，只是 at 跟着节点走。
    assert.equal(after.find((/** @type {any} */ entry) => entry.at === '#headline').text, '我的标题');
    assert.deepEqual(after.find((/** @type {any} */ entry) => entry.at === '#photo').s, [1.2, 1.2]);
    assert.equal(sha(await fs.readFile(filmPathOf(dir), 'utf8')), result.body.filmHtmlSha256);
  });
});

/* ── B3 元素删除 → conflicts ────────────────────────────────────────── */

test('B3 元素被删：GONE → conflicts 留档，覆盖从 film.html 移除但不静默丢', async () => {
  await withProject(async ({ root, studio, dir, projectId }) => {
    const source = await writeSource(root, 'gone.html', PAGE_GONE);
    const result = await post(`${studio.url}/api/projects/${projectId}/media/scene/reimport`, { sourceFile: source });
    assert.equal(result.status, 200);
    assert.equal(result.body.kept, 2);
    assert.equal(result.body.dropped, 1);
    assert.equal(result.body.conflicts, 1);
    assert.equal(result.body.changed, true);
    assert.match(String(result.body.conflictFile), /^\.film\/conflicts\/scene-[\dT]+\.json$/);

    const gone = result.body.clips[0].entries.find((/** @type {any} */ entry) => entry.status === 'GONE');
    assert.equal(gone.at, '#caption');
    assert.equal(gone.reason, 'LAYER_GONE');

    const conflicts = await overridesOf(dir);
    assert.deepEqual(
      conflicts.map((/** @type {any} */ entry) => entry.at),
      ['#title', '#photo'],
    );

    const raw = JSON.parse(await fs.readFile(path.join(dir, result.body.conflictFile), 'utf8'));
    assert.equal(raw.kind, 'overrides');
    assert.equal(raw.assetId, 'scene');
    assert.deepEqual(raw.clips, ['scene']);
    assert.equal(raw.entries.length, 1);
    assert.equal(raw.entries[0].at, '#caption');
    assert.equal(raw.entries[0].status, 'GONE');
    assert.equal(raw.entries[0].override.text, '我的说明');
    assert.equal(raw.counts.gone, 1);
    assert.match(String(raw.newSourceHash), /^[0-9a-f]{64}$/);
  });
});

/* ── B4 解析失败原子 ────────────────────────────────────────────────── */

test('B4 新源结构不完整：422 TREE_INCOMPLETE，film.html 与 conflicts 都不动', async () => {
  await withProject(async ({ root, studio, dir, projectId }) => {
    const before = await fs.readFile(filmPathOf(dir), 'utf8');
    const source = await writeSource(root, 'broken.html', PAGE_BROKEN);
    const result = await post(`${studio.url}/api/projects/${projectId}/media/scene/reimport`, { sourceFile: source });
    assert.equal(result.status, 422);
    assert.equal(result.body.code, 'TREE_INCOMPLETE');
    assert.equal(await fs.readFile(filmPathOf(dir), 'utf8'), before);
    assert.equal(await exists(path.join(dir, '.film/conflicts')), false);
  });
});

/* ── B5/B6/B7 输入错误 ──────────────────────────────────────────────── */

test('B5 sourceFile 不存在：404 SOURCE_NOT_FOUND，film.html 不变', async () => {
  await withProject(async ({ root, studio, dir, projectId }) => {
    const before = await fs.readFile(filmPathOf(dir), 'utf8');
    const result = await post(`${studio.url}/api/projects/${projectId}/media/scene/reimport`, {
      sourceFile: path.join(root, 'nope.html'),
    });
    assert.equal(result.status, 404);
    assert.equal(result.body.code, 'SOURCE_NOT_FOUND');
    assert.equal(await fs.readFile(filmPathOf(dir), 'utf8'), before);
  });
});

test('B6 sourceFile 不是 HTML：400 SOURCE_NOT_HTML', async () => {
  await withProject(async ({ root, studio, projectId }) => {
    const source = await writeSource(root, 'notes.txt', 'hello');
    const result = await post(`${studio.url}/api/projects/${projectId}/media/scene/reimport`, { sourceFile: source });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'SOURCE_NOT_HTML');
  });
});

test('B7 expectedHash 不符：409 CONFLICT，一个字节都不写', async () => {
  await withProject(async ({ root, studio, dir, projectId }) => {
    const before = await fs.readFile(filmPathOf(dir), 'utf8');
    const source = await writeSource(root, 'renamed.html', PAGE_RENAMED);
    const result = await post(`${studio.url}/api/projects/${projectId}/media/scene/reimport`, {
      sourceFile: source,
      expectedHash: 'f'.repeat(64),
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'CONFLICT');
    assert.equal(result.body.currentHash, sha(before));
    assert.equal(await fs.readFile(filmPathOf(dir), 'utf8'), before);
  });
});

/* ── B8 重复幂等 ────────────────────────────────────────────────────── */

test('B8 同 sourceFile 二次 reimport：alreadyUpToDate 且不写盘、不重复留档', async () => {
  await withProject(async ({ root, studio, dir, projectId }) => {
    const source = await writeSource(root, 'gone.html', PAGE_GONE);
    const first = await post(`${studio.url}/api/projects/${projectId}/media/scene/reimport`, { sourceFile: source });
    assert.equal(first.status, 200);
    assert.equal(first.body.changed, true);
    const afterFirst = await fs.readFile(filmPathOf(dir), 'utf8');
    const conflictFiles = await fs.readdir(path.join(dir, '.film/conflicts'));

    const second = await post(`${studio.url}/api/projects/${projectId}/media/scene/reimport`, { sourceFile: source });
    assert.equal(second.status, 200);
    assert.equal(second.body.alreadyUpToDate, true);
    assert.equal(second.body.changed, false);
    assert.equal(second.body.filmHtmlSha256, sha(afterFirst));
    assert.equal(await fs.readFile(filmPathOf(dir), 'utf8'), afterFirst);
    assert.deepEqual(await fs.readdir(path.join(dir, '.film/conflicts')), conflictFiles);
    assert.equal(second.body.conflictFile, null);
  });
});

/* ── B9 并发只写一次 ───────────────────────────────────────────────── */

test('B9 并发 2 次同一个源：只有一次真写，另一次回放/已最新', async () => {
  await withProject(async ({ root, studio, dir, projectId }) => {
    const source = await writeSource(root, 'renamed.html', PAGE_RENAMED);
    const [left, right] = await Promise.all([
      post(`${studio.url}/api/projects/${projectId}/media/scene/reimport`, { sourceFile: source }),
      post(`${studio.url}/api/projects/${projectId}/media/scene/reimport`, { sourceFile: source }),
    ]);
    assert.deepEqual([left.status, right.status], [200, 200]);
    const changed = [left, right].filter((item) => item.body.changed === true);
    assert.equal(changed.length, 1, `只该有一次 changed=true：${JSON.stringify([left.body.changed, right.body.changed])}`);
    const winner = changed[0];
    assert.ok(winner !== undefined);
    const finalSha = sha(await fs.readFile(filmPathOf(dir), 'utf8'));
    assert.equal(winner.body.filmHtmlSha256, finalSha);
    assert.equal(left.body.filmHtmlSha256, finalSha);
    assert.equal(right.body.filmHtmlSha256, finalSha);
    assert.deepEqual(
      (await overridesOf(dir)).map((/** @type {any} */ entry) => entry.at),
      ['#headline', '#photo', '#caption'],
    );
  });
});

/* ── B10 原素材只读 ────────────────────────────────────────────────── */

test('B10 原素材只读：工程里的源与 sourceFile 前后 sha 都不变', async () => {
  await withProject(async ({ root, studio, dir, projectId }) => {
    const pagePath = path.join(dir, 'pages', 'scene.html');
    const pageBefore = sha(await fs.readFile(pagePath));
    const source = await writeSource(root, 'renamed.html', PAGE_RENAMED);
    const sourceBefore = sha(await fs.readFile(source));

    const result = await post(`${studio.url}/api/projects/${projectId}/media/scene/reimport`, { sourceFile: source });
    assert.equal(result.status, 200);
    assert.equal(sha(await fs.readFile(pagePath)), pageBefore);
    assert.equal(sha(await fs.readFile(source)), sourceBefore);
    assert.equal(result.body.sources.length, 1);
    assert.equal(result.body.sources[0].sha256Before, pageBefore);
    assert.equal(result.body.sources[0].sha256After, pageBefore);
    assert.equal(result.body.source.sha256, sourceBefore);
  });
});

/* ── B11 只写 film.html ────────────────────────────────────────────── */

test('B11 只写 film.html：工程里除 .film/** 外只有 film.html 变了', async () => {
  await withProject(async ({ root, studio, dir, projectId }) => {
    const before = await treeOf(dir);
    const source = await writeSource(root, 'goner.html', PAGE_GONE);
    const result = await post(`${studio.url}/api/projects/${projectId}/media/scene/reimport`, { sourceFile: source });
    assert.equal(result.status, 200);
    const after = await treeOf(dir);

    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), '不该新增/删除任何源文件');
    const changed = Object.keys(before).filter((file) => before[file] !== after[file]);
    assert.deepEqual(changed, ['film.html']);
    // 冲突只进 .film/conflicts/，不另立一份「覆盖库」。
    const filmDir = await fs.readdir(path.join(dir, '.film'));
    assert.ok(filmDir.includes('conflicts'));
    assert.ok(!filmDir.includes('overrides.json'));
    assert.ok(!filmDir.some((name) => name.includes('overrides') && name.endsWith('.json') && !name.startsWith('.')));
  });
});

/* ── B12 非 html 片段 / 未知 assetId ───────────────────────────────── */

test('B12 视频片段与非 HTML 源：400 SOURCE_NOT_HTML；未知 assetId：404', async () => {
  await withProject(
    async ({ root, studio, projectId }) => {
      const source = await writeSource(root, 'renamed.html', PAGE_RENAMED);
      const video = await post(`${studio.url}/api/projects/${projectId}/media/v1/reimport`, { sourceFile: source });
      assert.equal(video.status, 400);
      assert.equal(video.body.code, 'SOURCE_NOT_HTML');

      const unknown = await post(`${studio.url}/api/projects/${projectId}/media/nobody/reimport`, { sourceFile: source });
      assert.equal(unknown.status, 404);
      assert.equal(unknown.body.code, 'ASSET_NOT_FOUND');
    },
    { filmHtml: FILM_VIDEO },
  );
});

/* ── B13 重开一致 ──────────────────────────────────────────────────── */

test('B13 重开一致：close/open 之后覆盖仍是重定位后的 at（层读得到）', async () => {
  await withProject(async ({ root, studio, dir, projectId }) => {
    const source = await writeSource(root, 'renamed.html', PAGE_RENAMED);
    const result = await post(`${studio.url}/api/projects/${projectId}/media/scene/reimport`, { sourceFile: source });
    assert.equal(result.status, 200);

    const closed = await post(`${studio.url}/api/projects/close`, { projectId });
    assert.equal(closed.status, 200);
    const reopened = await post(`${studio.url}/api/projects/open`, { dir });
    assert.equal(reopened.status, 200);
    const newId = reopened.body.project.projectId;

    const doc = await get(`${studio.url}/api/projects/${newId}/doc`);
    const clip = doc.body.doc.tracks[0].clips[0];
    assert.deepEqual(
      clip.overrides.map((/** @type {any} */ entry) => entry.at),
      ['#headline', '#photo', '#caption'],
    );
    assert.equal(doc.body.hash, result.body.filmHtmlSha256);
  });
});

/* ── B14 同一份源的两个片段 ────────────────────────────────────────── */

test('B14 两个片段共用一份源：按文件名解析 assetId，两条覆盖都重定位', async () => {
  await withProject(
    async ({ root, studio, dir, projectId }) => {
      const source = await writeSource(root, 'renamed.html', PAGE_RENAMED);
      const result = await post(`${studio.url}/api/projects/${projectId}/media/scene.html/reimport`, { sourceFile: source });
      assert.equal(result.status, 200);
      assert.equal(result.body.clips.length, 2);
      assert.deepEqual(
        result.body.clips.map((/** @type {any} */ clip) => clip.clipId),
        ['scene-a', 'scene-b'],
      );
      assert.equal(result.body.moved, 1, '只有 #title 需要挪，#caption 原地还在');
      assert.equal(result.body.kept, 1);

      const text = await fs.readFile(filmPathOf(dir), 'utf8');
      assert.ok(text.includes('id="scene-a"'));
      assert.match(text, /id="scene-a"[^>]*overrides='\[\{"at":"#headline"/);
      assert.match(text, /id="scene-b"[^>]*overrides='\[\{"at":"#caption"/);
    },
    { filmHtml: FILM_TWO },
  );
});

/* ── B15 工程未打开 ────────────────────────────────────────────────── */

test('B15 工程未打开：404 FILM_NOT_FOUND', async () => {
  await withProject(
    async ({ root, studio }) => {
      const source = await writeSource(root, 'renamed.html', PAGE_RENAMED);
      const result = await post(`${studio.url}/api/projects/deadbeefdeadbeef/media/scene/reimport`, { sourceFile: source });
      assert.equal(result.status, 404);
      assert.equal(result.body.code, 'FILM_NOT_FOUND');
    },
    { open: false },
  );
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
