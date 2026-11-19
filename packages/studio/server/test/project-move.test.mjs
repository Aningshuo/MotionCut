// M72-NEW-04：跨磁盘移动工程不得误报。
//
// 关键语义（任务书 §4）：
// - 校验失败 → status:"failed"，目标侧半成品删掉、原目录一字不动、工程还能打开；
// - 回收失败 → status:"moved" + warnings:["RECLAIM_FAILED:<oldPath>"] + reclaimed:false，
//   并把旧路径记进索引 stalePaths（诊断可见）。**禁止**报 failed，也禁止静默吞。
//
// 同盘/跨盘用两个临时根模拟：`forceCopyMove` 强制走复制分支（两个临时根在同一块盘上，
// 靠 dev 判断分不出跨盘），真实 `EXDEV` 也走同一条复制分支。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { copyTree, measureTree, resolveReal } from '../project-move.mjs';
import { startStudio } from '../studio-server.mjs';

const FILM = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=1280, height=720"><title>M72 夹具</title></head>
<body>
<section id="t1">
  <img id="a" src="assets/a.png" at="0" style="left: 0px; top: 0px; width: 100px; height: 100px">
</section>
</body>
</html>
`;

/** @param {string} file */
async function shaOfFile(file) {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

/** @param {string} base @param {string} pathname @param {any} [body] */
async function postJson(base, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json() };
}

/** @param {string} base @param {string} pathname */
async function getJson(base, pathname) {
  const response = await fetch(`${base}${pathname}`);
  return { status: response.status, body: await response.json() };
}

/**
 * @param {string} dir
 * @param {string} name
 */
async function makeProject(dir, name = 'film.html') {
  await fs.mkdir(path.join(dir, '.film', 'cache'), { recursive: true });
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  await fs.writeFile(path.join(dir, 'film.html'), FILM, 'utf8');
  await fs.writeFile(path.join(dir, 'assets', 'a.png'), 'png-bytes', 'utf8');
  await fs.writeFile(path.join(dir, '.film', 'cache', 'x.bin'), 'cache-bytes', 'utf8');
  return path.join(dir, name);
}

/**
 * 一个临时根 + 一个真工程 + 真 Studio。
 * @param {(ctx: any) => Promise<void>} fn
 * @param {{studio?: any}} [options]
 */
async function withMove(fn, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-m72-'));
  const home = path.join(root, 'home');
  const source = path.join(root, 'source');
  await fs.mkdir(home, { recursive: true });
  await makeProject(source);
  const studio = await startStudio({ port: 0, vitePort: 59999, home, projectsRoot: root, ...(options.studio ?? {}) });
  try {
    const opened = await postJson(studio.url, '/api/projects/open', { dir: source });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    await fn({ root, home, source, studio, projectId: opened.body.project.projectId });
  } finally {
    await studio.close().catch(() => undefined);
    // 回收失败的用例会把源目录改成只读：先恢复权限，否则清理会失败。
    await fs.chmod(source, 0o755).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/* ── 主路径 ─────────────────────────────────────────────────────── */

test('同盘：rename 成功，旧目录消失、新目录逐字节相同、索引只剩新路径', async () => {
  await withMove(async ({ root, home, source, studio, projectId }) => {
    const before = await shaOfFile(path.join(source, 'film.html'));
    const target = path.join(root, 'moved');
    const moved = await postJson(studio.url, `/api/projects/${projectId}/move`, { targetDir: target });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.status, 'moved');
    assert.equal(moved.body.strategy, 'rename');
    assert.equal(moved.body.reclaimed, true);
    assert.deepEqual(moved.body.warnings, []);
    assert.equal(moved.body.newPath, await fs.realpath(target));
    assert.notEqual(moved.body.projectId, projectId, '路径变了，projectId 也要变');
    assert.equal(await shaOfFile(path.join(target, 'film.html')), before);
    assert.equal(await fs.stat(source).then(() => true).catch(() => false), false, '旧目录应已消失');
    assert.equal(moved.body.filesMoved, 3);
    assert.ok(moved.body.bytesMoved >= before.length);
    // 索引：只剩新路径，旧路径不在了。
    const index = JSON.parse(await fs.readFile(path.join(home, '.opencut', 'projects.json'), 'utf8'));
    assert.deepEqual(index.projects.map((/** @type {any} */ item) => item.path), [await fs.realpath(target)]);
    // 新工程能打开、能读 doc。
    const reopened = await getJson(studio.url, `/api/projects/${moved.body.projectId}`);
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.project.path, await fs.realpath(target));
  });
});

test('目标为空目录：允许（先摘掉空目录再移动）', async () => {
  await withMove(async ({ root, studio, projectId }) => {
    const target = path.join(root, 'empty-target');
    await fs.mkdir(target, { recursive: true });
    const moved = await postJson(studio.url, `/api/projects/${projectId}/move`, { targetDir: target });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.status, 'moved');
  });
});

test('跨盘（强制复制）：copy → 校验 → 切索引 → 回收旧目录', async () => {
  await withMove(
    async ({ root, source, studio, projectId }) => {
      const before = await shaOfFile(path.join(source, 'film.html'));
      const beforeTree = await measureTree(source);
      const target = path.join(root, 'copied');
      const moved = await postJson(studio.url, `/api/projects/${projectId}/move`, { targetDir: target });
      assert.equal(moved.status, 200, JSON.stringify(moved.body));
      assert.equal(moved.body.status, 'moved');
      assert.equal(moved.body.strategy, 'copy');
      assert.equal(moved.body.reclaimed, true);
      assert.equal(moved.body.filesMoved, beforeTree.files);
      assert.equal(moved.body.bytesMoved, beforeTree.bytes);
      assert.equal(await shaOfFile(path.join(target, 'film.html')), before);
      assert.equal(await fs.stat(source).then(() => true).catch(() => false), false);
    },
    { studio: { forceCopyMove: true } },
  );
});

/* ── 失败路径 ───────────────────────────────────────────────────── */

test('校验失败：status=failed、目标半成品删掉、原目录不动、工程仍可打开', async () => {
  await withMove(
    async ({ root, source, studio, projectId }) => {
      const before = await shaOfFile(path.join(source, 'film.html'));
      const beforeTree = await measureTree(source);
      const target = path.join(root, 'verify-fail');
      const moved = await postJson(studio.url, `/api/projects/${projectId}/move`, { targetDir: target });
      assert.equal(moved.status, 500, JSON.stringify(moved.body));
      assert.equal(moved.body.status, 'failed');
      assert.equal(moved.body.ok, false);
      assert.ok(moved.body.reasons.some((/** @type {string} */ reason) => reason.startsWith('VERIFY_FAILED:')));
      assert.equal(moved.body.filesMoved, 0);
      assert.equal(await fs.stat(target).then(() => true).catch(() => false), false, '目标侧半成品必须删掉');
      const afterTree = await measureTree(source);
      assert.equal(afterTree.files, beforeTree.files, '原目录文件数不变');
      assert.equal(afterTree.bytes, beforeTree.bytes, '原目录字节数不变');
      assert.equal(await shaOfFile(path.join(source, 'film.html')), before);
      // 工程仍可正常打开（同一 id，因为路径没变）。
      const summary = await getJson(studio.url, `/api/projects/${projectId}`);
      assert.equal(summary.status, 200);
      assert.equal(summary.body.project.sourceHash, before);
      const doc = await getJson(studio.url, `/api/projects/${projectId}/doc`);
      assert.equal(doc.status, 200);
    },
    { studio: { forceCopyMove: true, moveVerify: async () => ({ ok: false, reason: 'FORCED_VERIFY_FAIL' }) } },
  );
});

test('回收失败：status=moved + RECLAIM_FAILED 警告 + stalePaths 进索引与诊断', async () => {
  await withMove(
    async ({ root, home, source, studio, projectId }) => {
      const target = path.join(root, 'reclaim-fail');
      // 只读源目录：copy 能读，rm 删不掉（unlink 需要父目录写权限）。
      await fs.chmod(source, 0o500);
      const moved = await postJson(studio.url, `/api/projects/${projectId}/move`, { targetDir: target });
      assert.equal(moved.status, 200, JSON.stringify(moved.body));
      assert.equal(moved.body.status, 'moved', '回收失败不许报 failed');
      assert.equal(moved.body.reclaimed, false);
      assert.deepEqual(moved.body.warnings, [`RECLAIM_FAILED:${await fs.realpath(source)}`]);
      assert.equal(await fs.stat(source).then(() => true).catch(() => false), true, '旧目录还在');
      assert.equal(await shaOfFile(path.join(target, 'film.html')), await shaOfFile(path.join(source, 'film.html')));
      // 索引条目带 stalePaths。
      const realTarget = await fs.realpath(target);
      const realSource = await fs.realpath(source);
      const index = JSON.parse(await fs.readFile(path.join(home, '.opencut', 'projects.json'), 'utf8'));
      const entry = index.projects.find((/** @type {any} */ item) => item.path === realTarget);
      assert.ok(entry, '新路径应在索引里');
      assert.deepEqual(entry.stalePaths, [realSource]);
      // 诊断可见（耐久记录 sidecar）。
      const diagnostics = await getJson(studio.url, '/api/settings/diagnostics');
      assert.equal(diagnostics.status, 200);
      assert.equal(diagnostics.body.stalePaths.length, 1);
      assert.equal(diagnostics.body.stalePaths[0].oldPath, realSource);
      assert.equal(diagnostics.body.stalePaths[0].newPath, realTarget);
      assert.equal(diagnostics.body.stalePaths[0].code, 'RECLAIM_FAILED');
    },
    { studio: { forceCopyMove: true } },
  );
});

test('移动中再次移动 → 409 MOVE_IN_PROGRESS', async () => {
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  /** @type {() => void} */
  let enteredResolve = () => {};
  const entered = new Promise((resolve) => {
    enteredResolve = () => resolve(undefined);
  });
  await withMove(
    async ({ root, studio, projectId }) => {
      const target = path.join(root, 'slow');
      const first = postJson(studio.url, `/api/projects/${projectId}/move`, { targetDir: target });
      await entered;
      const second = await postJson(studio.url, `/api/projects/${projectId}/move`, {
        targetDir: path.join(root, 'slow-2'),
      });
      assert.equal(second.status, 409, JSON.stringify(second.body));
      assert.equal(second.body.code, 'MOVE_IN_PROGRESS');
      release();
      const done = await first;
      assert.equal(done.status, 200, JSON.stringify(done.body));
    },
    {
      studio: {
        forceCopyMove: true,
        moveVerify: async () => {
          enteredResolve();
          await gate;
          return { ok: true };
        },
      },
    },
  );
});

/* ── 参数与边界 ─────────────────────────────────────────────────── */

test('目标非空 → 409 TARGET_NOT_EMPTY；目标在工程内部 → 400 TARGET_INSIDE_PROJECT', async () => {
  await withMove(async ({ root, source, studio, projectId }) => {
    const busy = path.join(root, 'busy');
    await fs.mkdir(busy, { recursive: true });
    await fs.writeFile(path.join(busy, 'keep.txt'), 'x', 'utf8');
    const notEmpty = await postJson(studio.url, `/api/projects/${projectId}/move`, { targetDir: busy });
    assert.equal(notEmpty.status, 409);
    assert.equal(notEmpty.body.code, 'TARGET_NOT_EMPTY');

    const inside = await postJson(studio.url, `/api/projects/${projectId}/move`, {
      targetDir: path.join(source, 'sub'),
    });
    assert.equal(inside.status, 400);
    assert.equal(inside.body.code, 'TARGET_INSIDE_PROJECT');

    // `..` 规范化后仍然落在工程内部（`source/../source/sub`）。
    const dotdot = await postJson(studio.url, `/api/projects/${projectId}/move`, {
      targetDir: path.join(source, '..', path.basename(source), 'sub'),
    });
    assert.equal(dotdot.status, 400);
    assert.equal(dotdot.body.code, 'TARGET_INSIDE_PROJECT');
  });
});

test('符号链接指向工程内部 → 400 TARGET_INSIDE_PROJECT（按 realpath 判断）', async () => {
  await withMove(async ({ root, source, studio, projectId }) => {
    const link = path.join(root, 'link-to-source');
    await fs.symlink(source, link, 'dir');
    const moved = await postJson(studio.url, `/api/projects/${projectId}/move`, { targetDir: link });
    assert.equal(moved.status, 400, JSON.stringify(moved.body));
    assert.equal(moved.body.code, 'TARGET_INSIDE_PROJECT');
    assert.equal(await fs.stat(source).then(() => true).catch(() => false), true);
  });
});

test('工程未打开 → 404；targetDir 空 → 400', async () => {
  await withMove(async ({ studio }) => {
    const missing = await postJson(studio.url, '/api/projects/nope/move', { targetDir: '/tmp/x' });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'PROJECT_NOT_FOUND');

    const empty = await postJson(studio.url, '/api/projects/nope/move', {});
    assert.equal(empty.status, 404, '先查工程存在性，再校验参数');

    const index = await getJson(studio.url, '/api/projects');
    assert.equal(index.status, 200);
  });
});

test('空 targetDir 对已打开工程 → 400 BAD_REQUEST', async () => {
  await withMove(async ({ studio, projectId }) => {
    const bad = await postJson(studio.url, `/api/projects/${projectId}/move`, { targetDir: '   ' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'BAD_REQUEST');
  });
});

/* ── 纯函数 ─────────────────────────────────────────────────────── */

test('resolveReal：`..` 与符号链接都被吃掉', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-m72-real-'));
  try {
    const real = await fs.realpath(root);
    const sub = path.join(root, 'a');
    await fs.mkdir(sub);
    const link = path.join(root, 'l');
    await fs.symlink(sub, link, 'dir');
    assert.equal(await resolveReal(path.join(sub, '..', 'a')), path.join(real, 'a'));
    assert.equal(await resolveReal(link), path.join(real, 'a'));
    assert.equal(await resolveReal(path.join(root, 'not', 'yet')), path.join(real, 'not', 'yet'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('measureTree/copyTree：符号链接按链接复制、不跟随（不会把工程外的东西卷进来）', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-m72-copy-'));
  try {
    const source = path.join(root, 'source');
    const outside = path.join(root, 'outside');
    await fs.mkdir(source, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(source, 'film.html'), FILM, 'utf8');
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret', 'utf8');
    await fs.symlink(outside, path.join(source, 'link-out'), 'dir');

    const before = await measureTree(source);
    assert.equal(before.files, 2, 'film.html + 链接本身');
    assert.equal(before.bytes, Buffer.byteLength(FILM), '链接不计字节、也不读目标');

    const target = path.join(root, 'target');
    await copyTree(source, target);
    const after = await measureTree(target);
    assert.equal(after.files, before.files);
    assert.equal(after.bytes, before.bytes);
    assert.equal((await fs.lstat(path.join(target, 'link-out'))).isSymbolicLink(), true, '链接还是链接');
    assert.equal(await fs.readlink(path.join(target, 'link-out')), outside);
    assert.equal(await shaOfFile(path.join(target, 'film.html')), await shaOfFile(path.join(source, 'film.html')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
