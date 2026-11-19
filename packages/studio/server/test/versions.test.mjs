// @ts-nocheck
/**
 * M62-WP09-NAMED-VERSIONS · 命名版本（私有 git 只作快照存储）
 *
 * 这里守的不是「能提交就行」：
 *  - 首次提交 / 列表倒序 / 无改动 409；
 *  - diff 只报真正变的文件；restore 后 film.html **逐字节**相等；覆写前有备份；
 *  - 媒体不进 git → 删掉的 mp4 restore 之后**不复活**，但要出现在 mediaChanged / missingMedia；
 *  - restore-film 只动 film.html，不碰别的文件；
 *  - git 缺失降级 503、坏仓库改名留档（不删）、`../`/绝对路径/symlink 越界一律拒绝；
 *  - 工作树脏 → 409；注入写失败 → 回滚到恢复前内容并给出备份路径；
 *  - 陈旧锁（>60s）可回收；名字/sha 校验；>2 MiB 的文本不进版本库。
 *
 * 跑法：`node --test packages/studio/server/test/versions.test.mjs`
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  MAX_TEXT_BYTES,
  NAME_MAX,
  VERSIONS_DIR,
  createVersion,
  diffVersion,
  ensureRepo,
  listVersions,
  resetGitAvailabilityForTest,
  resolveProjectPath,
  restoreFilm,
  restoreVersion,
  sha256OfBuffer,
} from '../versions.mjs';

/** @param {Buffer|string} value */
const sha = (value) => createHash('sha256').update(value).digest('hex');

/** @param {string} [tag] */
async function makeProject(tag = 'p') {
  const dir = await mkdtemp(join(tmpdir(), `ocv-${tag}-`));
  await mkdir(join(dir, '.film'), { recursive: true });
  await writeFile(join(dir, 'film.html'), '<html>v0</html>\n');
  await writeFile(join(dir, '.film', 'style.json'), '{"fontSizeRatio":0.045}\n');
  return dir;
}

/**
 * @param {() => Promise<any>} fn
 * @param {string} code
 */
async function rejectsCode(fn, code) {
  try {
    await fn();
  } catch (error) {
    assert.equal(error.code, code, `期望 ${code}，实际 ${error.code}（${error.message}）`);
    return error;
  }
  assert.fail(`期望抛 ${code}，但没抛`);
}

/* ── 1. 首次提交 ───────────────────────────────────────────────────────── */

test('A1 首次提交：只把文本进快照，film.html 在列表里', async () => {
  const dir = await makeProject('first');
  const created = await createVersion(dir, { name: '初始版本' });
  assert.equal(created.ok, true);
  assert.equal(created.firstCommit, true);
  assert.match(created.version.sha, /^[0-9a-f]{40}$/);
  assert.equal(created.version.name, '初始版本');
  assert.ok(created.version.files >= 2, `至少 film.html + .film/style.json，实际 ${created.version.files}`);
  const list = await listVersions(dir);
  assert.equal(list.versions.length, 1);
  assert.equal(list.versions[0].sha, created.version.sha);
});

/* ── 2. 列表倒序 ───────────────────────────────────────────────────────── */

test('A2 列表倒序：最后提交的在最前', async () => {
  const dir = await makeProject('order');
  /** @type {string[]} */
  const names = [];
  for (const name of ['v1', 'v2', 'v3']) {
    await writeFile(join(dir, 'film.html'), `<html>${name}</html>\n`);
    const made = await createVersion(dir, { name });
    names.push(made.version.sha);
  }
  const list = await listVersions(dir);
  assert.deepEqual(
    list.versions.map((item) => item.name),
    ['v3', 'v2', 'v1'],
  );
  assert.deepEqual(
    list.versions.map((item) => item.sha),
    [...names].reverse(),
  );
});

/* ── 3. 无改动 409 ─────────────────────────────────────────────────────── */

test('A3 无改动：第二次提交给 VERSIONS_NOTHING_TO_COMMIT', async () => {
  const dir = await makeProject('nothing');
  await createVersion(dir, { name: 'v1' });
  await rejectsCode(() => createVersion(dir, { name: 'v2' }), 'VERSIONS_NOTHING_TO_COMMIT');
});

/* ── 4. diff 单文件 ────────────────────────────────────────────────────── */

test('A4 diff：只报 film.html 一个文件 +1/-1', async () => {
  const dir = await makeProject('diff');
  await createVersion(dir, { name: 'v1' });
  await writeFile(join(dir, 'film.html'), '<html>v1 改过</html>\n');
  const v2 = await createVersion(dir, { name: 'v2' });
  const diff = await diffVersion(dir, v2.version.short);
  assert.equal(diff.files.length, 1, JSON.stringify(diff.files));
  assert.equal(diff.files[0].path, 'film.html');
  assert.equal(diff.files[0].status, 'modified');
  assert.equal(diff.files[0].additions, 1);
  assert.equal(diff.files[0].deletions, 1);
});

/* ── 5. restore 后逐字节相等 ───────────────────────────────────────────── */

test('A5 restore：film.html 与 v1 逐字节相同（sha 相等）', async () => {
  const dir = await makeProject('restore');
  const v1 = await createVersion(dir, { name: 'v1' });
  const filmV1 = sha(await readFile(join(dir, 'film.html')));
  await writeFile(join(dir, 'film.html'), '<html>v2 完全不同</html>\n');
  await createVersion(dir, { name: 'v2' });
  const restored = await restoreVersion(dir, v1.version.short);
  assert.deepEqual(restored.restored.sort(), ['.film/style.json', 'film.html']);
  assert.equal(sha(await readFile(join(dir, 'film.html'))), filmV1);
  assert.equal(restored.ok, true);
});

/* ── 6. 覆写前备份 ─────────────────────────────────────────────────────── */

test('A6 覆写前备份：备份目录里是被覆盖前的内容', async () => {
  const dir = await makeProject('backup');
  const v1 = await createVersion(dir, { name: 'v1' });
  await writeFile(join(dir, 'film.html'), '<html>要被覆盖的内容</html>\n');
  const beforeContent = await readFile(join(dir, 'film.html'));
  await createVersion(dir, { name: 'v2' });
  const result = await restoreVersion(dir, v1.version.short);
  assert.match(result.backup, /^\.film\/versions-backup\//);
  const backupContent = await readFile(join(dir, result.backup, 'film.html'));
  assert.equal(sha(backupContent), sha(beforeContent));
});

/* ── 7. 媒体不复活 ─────────────────────────────────────────────────────── */

test('A7 媒体：2 MiB 假 mp4 不进 git，删掉后 restore 不复活但要报 missingMedia', async () => {
  const dir = await makeProject('media');
  const mediaPath = join(dir, '.film', 'clip.mp4');
  await writeFile(mediaPath, Buffer.alloc(2 * 1024 * 1024, 7));
  const v1 = await createVersion(dir, { name: '带媒体' });
  assert.equal(v1.version.mediaCount, 1);
  await rm(mediaPath, { force: true });
  await writeFile(join(dir, 'film.html'), '<html>改一下再提交</html>\n');
  const v2 = await createVersion(dir, { name: '删媒体后' });
  // v2 自己的清单里没有媒体了
  const v2diff = await diffVersion(dir, v2.version.short);
  assert.equal(v2diff.missingMedia, 0);
  // 恢复 v1（它的清单里有这个 mp4）→ 文本回来，媒体**不能**复活
  const restored = await restoreVersion(dir, v1.version.short);
  await assert.rejects(() => stat(mediaPath));
  assert.ok(restored.mediaChanged.includes('.film/clip.mp4'), JSON.stringify(restored.mediaChanged));
  assert.equal(restored.missingMedia, 1);
  // v1 的清单里也有它
  const diff = await diffVersion(dir, v1.version.short);
  assert.equal(diff.missingMedia, 1);
});

/* ── 8. restore-film 只动 film ─────────────────────────────────────────── */

test('A8 restore-film：只回写 film.html，别的文件保持现状', async () => {
  const dir = await makeProject('film-only');
  const v1 = await createVersion(dir, { name: 'v1' });
  const filmV1 = sha(await readFile(join(dir, 'film.html')));
  await writeFile(join(dir, 'film.html'), '<html>v2</html>\n');
  await writeFile(join(dir, '.film', 'style.json'), '{"fontSizeRatio":0.06}\n');
  await createVersion(dir, { name: 'v2' });
  const result = await restoreFilm(dir, v1.version.short);
  assert.deepEqual(result.restored, ['film.html']);
  assert.equal(sha(await readFile(join(dir, 'film.html'))), filmV1);
  assert.equal(await readFile(join(dir, '.film', 'style.json'), 'utf8'), '{"fontSizeRatio":0.06}\n');
});

/* ── 9. git 缺失降级 ───────────────────────────────────────────────────── */

test('A9 git 缺失：ensureRepo 503 VERSIONS_GIT_UNAVAILABLE，列表降级不抛', async () => {
  const dir = await makeProject('nogit');
  const pathBackup = process.env.PATH;
  process.env.PATH = '';
  resetGitAvailabilityForTest();
  try {
    await rejectsCode(() => ensureRepo(dir), 'VERSIONS_GIT_UNAVAILABLE');
    const list = await listVersions(dir);
    assert.equal(list.gitAvailable, false);
    assert.deepEqual(list.versions, []);
  } finally {
    process.env.PATH = pathBackup;
    resetGitAvailabilityForTest();
  }
});

/* ── 10. 坏仓库改名 ────────────────────────────────────────────────────── */

test('A10 坏仓库：改名 versions.git.broken-<ts> 后报 VERSIONS_REPO_BROKEN，不删', async () => {
  const dir = await makeProject('broken');
  const gitDir = join(dir, VERSIONS_DIR);
  await mkdir(gitDir, { recursive: true });
  await writeFile(join(gitDir, 'HEAD'), '这不是 git 仓库\n');
  const error = await rejectsCode(() => ensureRepo(dir), 'VERSIONS_REPO_BROKEN');
  assert.match(String(error.extra?.broken ?? ''), /versions\.git\.broken-\d+/);
  const entries = await readdir(join(dir, '.film'));
  const broken = entries.filter((name) => name.startsWith('versions.git.broken-'));
  assert.equal(broken.length, 1, JSON.stringify(entries));
  // 原目录已不在，坏库还在（只是改名）
  await assert.rejects(() => stat(gitDir));
  assert.ok((await stat(join(dir, '.film', broken[0]))).isDirectory());
});

/* ── 11. 路径越界 ──────────────────────────────────────────────────────── */

test('A11 路径越界：../ 、绝对路径、symlink 出工程一律 VERSIONS_PATH_ESCAPE', async () => {
  const dir = await makeProject('escape');
  await rejectsCode(() => resolveProjectPath(dir, '../etc/passwd'), 'VERSIONS_PATH_ESCAPE');
  await rejectsCode(() => resolveProjectPath(dir, '/etc/passwd'), 'VERSIONS_PATH_ESCAPE');
  const outside = await mkdtemp(join(tmpdir(), 'ocv-outside-'));
  await writeFile(join(outside, 'secret.json'), '{}\n');
  await symlink(outside, join(dir, 'ext'));
  await rejectsCode(() => resolveProjectPath(dir, 'ext/secret.json'), 'VERSIONS_PATH_ESCAPE');
  // 工程内的正常路径要能过（返回的是 realpath：macOS 上 /var → /private/var）
  const inside = await resolveProjectPath(dir, '.film/style.json');
  const realDir = await realpath(dir);
  assert.ok(inside.startsWith(realDir + '/'), `${inside} 不在 ${realDir} 下`);
});

/* ── 12. 脏冲突 409 ────────────────────────────────────────────────────── */

test('A12 脏冲突：工作树有未提交改动 → 409 并列出冲突文件', async () => {
  const dir = await makeProject('dirty');
  const v1 = await createVersion(dir, { name: 'v1' });
  await writeFile(join(dir, 'film.html'), '<html>未提交的改动</html>\n');
  const error = await rejectsCode(() => restoreVersion(dir, v1.version.short), 'VERSIONS_DIRTY_CONFLICT');
  assert.deepEqual(error.extra?.conflicts, ['film.html']);
  // force 可以过，但仍然先备份
  const forced = await restoreVersion(dir, v1.version.short, { force: true });
  assert.equal(forced.ok, true);
  assert.ok((await readdir(join(dir, forced.backup))).includes('film.html'));
});

/* ── 13. 注入失败回滚 ──────────────────────────────────────────────────── */

test('A13 注入失败：写到第三个文件炸了 → 前两个回滚到恢复前内容', async () => {
  const dir = await makeProject('rollback');
  await writeFile(join(dir, 'zzz.txt'), 'zzz v1\n');
  const v1 = await createVersion(dir, { name: 'v1' });
  // 三个文件都改一遍（未提交）
  await writeFile(join(dir, 'film.html'), '<html>改过</html>\n');
  await writeFile(join(dir, '.film', 'style.json'), '{"fontSizeRatio":0.08}\n');
  await rm(join(dir, 'zzz.txt'));
  await mkdir(join(dir, 'zzz.txt')); // 同名目录：rename 到它身上必失败
  const filmBefore = sha(await readFile(join(dir, 'film.html')));
  const styleBefore = sha(await readFile(join(dir, '.film', 'style.json')));
  const error = await rejectsCode(() => restoreVersion(dir, v1.version.short, { force: true }), 'VERSIONS_RESTORE_ROLLBACK');
  assert.ok(Array.isArray(error.extra?.rolledBack) && error.extra.rolledBack.length >= 2, JSON.stringify(error.extra));
  // 回滚之后：前两个文件还是「恢复前」的内容
  assert.equal(sha(await readFile(join(dir, 'film.html'))), filmBefore);
  assert.equal(sha(await readFile(join(dir, '.film', 'style.json'))), styleBefore);
  assert.ok(error.extra?.backup, '要给出备份路径');
});

/* ── 14. 陈旧锁回收 ────────────────────────────────────────────────────── */

test('A14 陈旧锁：>60s 的锁可回收，提交照常成功', async () => {
  const dir = await makeProject('stale-lock');
  await ensureRepo(dir);
  const lockPath = join(dir, VERSIONS_DIR, 'opencut.lock');
  await writeFile(lockPath, `${JSON.stringify({ pid: 999999, at: Date.now() - 120_000 })}\n`);
  await createVersion(dir, { name: 'v1' });
  await assert.rejects(() => stat(lockPath), '锁应在提交结束后被删除');
});

/* ── 15. 名字与 sha 校验 ───────────────────────────────────────────────── */

test('A15 校验：空名字/超长名字/sha 非法都被挡', async () => {
  const dir = await makeProject('validate');
  await rejectsCode(() => createVersion(dir, { name: '   ' }), 'VERSIONS_NAME_INVALID');
  await rejectsCode(() => createVersion(dir, { name: 'x'.repeat(NAME_MAX + 1) }), 'VERSIONS_NAME_INVALID');
  await rejectsCode(() => createVersion(dir, { name: 'a\nb' }), 'VERSIONS_NAME_INVALID');
  await createVersion(dir, { name: '正常名字' });
  await rejectsCode(() => diffVersion(dir, '../../etc/passwd'), 'VERSIONS_SHA_INVALID');
  await rejectsCode(() => restoreVersion(dir, 'deadbeefdeadbeef'), 'VERSIONS_SHA_INVALID');
});

/* ── 16. 大文件不进版本库 ──────────────────────────────────────────────── */

test('A16 白名单：>2 MiB 的文本文件不进版本库', async () => {
  const dir = await makeProject('large');
  await writeFile(join(dir, '.film', 'big.json'), 'x'.repeat(MAX_TEXT_BYTES + 1024));
  const v1 = await createVersion(dir, { name: 'v1' });
  const list = await listVersions(dir);
  assert.equal(list.versions[0].sha, v1.version.sha);
  assert.ok(v1.version.files < 3, `大文件不该被跟踪，实际 files=${v1.version.files}`);
  const restored = await restoreVersion(dir, v1.version.short, { force: true });
  assert.ok(!restored.restored.includes('.film/big.json'), JSON.stringify(restored.restored));
  // 文件本身还在（只是不进版本）
  assert.equal((await stat(join(dir, '.film', 'big.json'))).size, MAX_TEXT_BYTES + 1024);
});

/* ── 附加：sha256OfBuffer 与真实 restore 一致 ─────────────────────────── */

test('A17 sha256OfBuffer：与磁盘上 film.html 的 sha 一致', async () => {
  const dir = await makeProject('hash');
  const v1 = await createVersion(dir, { name: 'v1' });
  await writeFile(join(dir, 'film.html'), '<html>别的</html>\n');
  await createVersion(dir, { name: 'v2' });
  const restored = await restoreFilm(dir, v1.version.short);
  const onDisk = await readFile(join(dir, 'film.html'));
  assert.equal(restored.filmSha, sha256OfBuffer(onDisk));
});

/* ── 附加：版本里没有 film.html → restore-film 必须 404 ───────────────── */

test('A18 restore-film：版本里没有 film.html → VERSIONS_NO_FILM_IN_SHA', async () => {
  const dir = await makeProject('no-film');
  await rm(join(dir, 'film.html'), { force: true });
  const v1 = await createVersion(dir, { name: '只有样式' });
  await rejectsCode(() => restoreFilm(dir, v1.version.short), 'VERSIONS_NO_FILM_IN_SHA');
});
