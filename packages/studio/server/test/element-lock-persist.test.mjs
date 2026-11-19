// @ts-nocheck —— 单测以运行时断言为准；被测模块仍由 tsc 严格检查。
/**
 * S89 · 元素锁的持久化与并发（B-SUB1-R31-046）。
 *
 * S87 证的是「同一个会话里，服务端会拒」。这一组盯的是另外两件用户真会遇到的事：
 *
 * 1. **锁存得住**：锁写在 `film.html` 的 `overrides` 里，**换一个会话（= 重启 Studio 后）**
 *    仍然生效；换到另一个工程不受影响（不串）。
 * 2. **并发也不许漏**：两个会话同时对同一个锁定元素发 Op（交错到达），两条都必须被拒，
 *    磁盘一个字节不动 —— 不许出现「先到的那条改了、后到的才被拒」。
 *
 * 跑法：`node --test packages/studio/server/test/element-lock-persist.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ELEMENT_LOCKED } from '../../../layers/element-lock.mjs';
import { createEditSession } from '../edit-session.mjs';
import { createFilmDocIo } from '../film-io.mjs';

const LOCKED_AT = '#footer';
const FREE_AT = '#card';

const FILM = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=1280, height=720">
<title>元素锁持久化单测</title>
</head>
<body>
<section id="pages">
  <iframe id="page-main" src="page.html#t=0,12" at="0" size="1280x720"
          overrides='[{"at":"#footer","lock":true}]'
          style="left: 0px; top: 0px; width: 1280px; height: 720px; border: 0"></iframe>
</section>
</body>
</html>
`;

/** 一个工程目录（两个工程各一份，用来验「不串」）。 */
async function makeProject(name, film = FILM) {
  const root = await mkdtemp(join(tmpdir(), 'opencut-element-lock-persist-'));
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  const filmPath = join(dir, 'film.html');
  await writeFile(filmPath, film, 'utf8');
  await writeFile(join(dir, 'page.html'), '<!doctype html><meta charset="utf-8"><div id="card"></div><p id="footer">锁</p>', 'utf8');
  return { root, dir, filmPath, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const shaOf = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');

/** 改某个元素（可带锁）——与 UI 走的是同一种 Op 形状。 */
const writeEntry = (at, entry) => [{ op: 'fields', clip: 'page-main', fields: { overrides: [entry ?? { at }] } }];

test('S89-B1 锁落盘后换一个会话（= 重启 Studio）仍然生效，另一个工程不受影响', async () => {
  const a = await makeProject('工程-锁');
  const b = await makeProject('工程-干净', FILM.replace(/\s*overrides='[^']*'/, ''));
  try {
    /* 第一个会话：把锁写进去（真实落盘路径，不是内存标记）。 */
    const first = createEditSession({ path: a.filmPath, io: createFilmDocIo(), projectId: '工程-锁' });
    const loaded = await first.load();
    assert.equal(loaded.ok, true);
    const locked = await first.apply(writeEntry(LOCKED_AT, { at: LOCKED_AT, lock: true }), { opId: 'b1-lock' });
    assert.equal(locked.ok, true, JSON.stringify(locked));
    const textAfterLock = await readFile(a.filmPath, 'utf8');
    assert.match(textAfterLock, /"lock":true/, '.film 源文件里要找得到这条锁');
    const shaAfterLock = await shaOf(a.filmPath);

    /* 第二个会话：**新建实例、重新 load**，模拟重启 Studio 后读盘。 */
    const reopened = createEditSession({ path: a.filmPath, io: createFilmDocIo(), projectId: '工程-锁' });
    const reloaded = await reopened.load();
    assert.equal(reloaded.ok, true);

    const blocked = await reopened.apply(writeEntry(LOCKED_AT, { at: LOCKED_AT, t: '重启后 Agent 想改' }), { opId: 'b1-after-restart' });
    assert.equal(blocked.ok, false, '锁必须跟着文件活下来');
    assert.equal(blocked.error.code, ELEMENT_LOCKED);
    assert.equal(await shaOf(a.filmPath), shaAfterLock, '被拒的写入不许碰磁盘');

    /* 同一个文件里，没锁的元素照常能改（锁不是「整个片段只读」）。 */
    const free = await reopened.apply(writeEntry(FREE_AT, { at: FREE_AT, t: '可以改' }), { opId: 'b1-free' });
    assert.equal(free.ok, true, JSON.stringify(free));

    /* 另一个工程：同样的 Op → 200（锁不串工程）。 */
    const other = createEditSession({ path: b.filmPath, io: createFilmDocIo(), projectId: '工程-干净' });
    const otherOpened = await other.load();
    assert.equal(otherOpened.ok, true);
    const otherWrite = await other.apply(writeEntry(LOCKED_AT, { at: LOCKED_AT, t: '另一个工程' }), { opId: 'b1-other' });
    assert.equal(otherWrite.ok, true, JSON.stringify(otherWrite));
    assert.match(await readFile(b.filmPath, 'utf8'), /另一个工程/);
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

test('S89-B2 两个会话同时对同一锁定元素发 Op：两条都拒，磁盘不动', async () => {
  const project = await makeProject('工程-并发');
  try {
    const shaBefore = await shaOf(project.filmPath);
    /* 两个**独立**会话各自 load 同一份文件（等价于两个客户端同时挂着这个工程）。 */
    const one = createEditSession({ path: project.filmPath, io: createFilmDocIo(), projectId: '工程-并发' });
    const two = createEditSession({ path: project.filmPath, io: createFilmDocIo(), projectId: '工程-并发' });
    assert.equal((await one.load()).ok, true);
    assert.equal((await two.load()).ok, true);

    const [r1, r2] = await Promise.all([
      one.apply(writeEntry(LOCKED_AT, { at: LOCKED_AT, t: '会话一' }), { opId: 'b2-one' }),
      two.apply(writeEntry(LOCKED_AT, { at: LOCKED_AT, t: '会话二' }), { opId: 'b2-two' }),
    ]);
    assert.equal(r1.ok, false, '会话一必须被拒');
    assert.equal(r2.ok, false, '会话二必须被拒');
    assert.equal(r1.error.code, ELEMENT_LOCKED);
    assert.equal(r2.error.code, ELEMENT_LOCKED, `两条都必须是元素锁，不许退化成 CONFLICT：${JSON.stringify(r2.error)}`);
    assert.equal(await shaOf(project.filmPath), shaBefore, '并发里任何一条都不许落盘');
    assert.doesNotMatch(await readFile(project.filmPath, 'utf8'), /会话一|会话二/);

    /* 负向对照：解锁之后同样的两条并发写，至少有一条必须成功（证明上面的「都拒」是锁在挡，
       不是并发本身把两条都搞挂了）。 */
    const unlock = await one.apply(writeEntry(LOCKED_AT, { at: LOCKED_AT }), { opId: 'b2-unlock' });
    assert.equal(unlock.ok, true, JSON.stringify(unlock));
    const [u1, u2] = await Promise.all([
      one.apply(writeEntry(LOCKED_AT, { at: LOCKED_AT, t: '解锁后一' }), { opId: 'b2-u1' }),
      two.apply(writeEntry(LOCKED_AT, { at: LOCKED_AT, t: '解锁后二' }), { opId: 'b2-u2' }),
    ]);
    assert.equal([u1, u2].some((item) => item.ok === true), true, `解锁后至少要有一条写得进去：${JSON.stringify([u1, u2])}`);
  } finally {
    await project.cleanup();
  }
});
