// @ts-nocheck —— 单测以运行时断言为准；被测模块仍由 tsc 严格检查。
/**
 * S87 · 元素级锁在文档层生效（B-SUB1-R31-045）。
 *
 * 这一组测试盯的是「检查器给了用户一个锁开关，服务端认不认」：
 * 1. 改一个 `lock:true` 元素的覆盖负载 → `ELEMENT_LOCKED`（不是轨道锁的 `LOCKED`）；
 * 2. **原子性**：同一批里一条改别的元素、一条改锁定元素 → 整批拒，磁盘一个字节不动；
 * 3. 解锁之后同样的写入必须 200 且真的落盘（否则锁就是个只能锁不能开的坑）；
 * 4. 「解锁 + 顺手改一笔」不算解锁 → 拒（不能拿解锁当后门）。
 *
 * 跑法：`node --test packages/studio/server/test/element-lock.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ELEMENT_LOCKED, elementLocks, findLockedWrites } from '../../../layers/element-lock.mjs';
import { applyOpsDetailed } from '../../../film-core/ops.mjs';
import { parse as parseFilm } from '../../../film-core/film-doc.mjs';
import { createEditSession } from '../edit-session.mjs';
import { createFilmDocIo } from '../film-io.mjs';

const LOCKED_AT = '#footer';
const FREE_AT = '#card';

/** 带一条「只有锁」的覆盖条目的工程（与 s76/s81 夹具同形）。 */
const FILM = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=1280, height=720">
<title>元素锁单测</title>
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

async function makeFilm() {
  const root = await mkdtemp(join(tmpdir(), 'opencut-element-lock-'));
  const dir = join(root, 'lock');
  await mkdir(dir, { recursive: true });
  const filmPath = join(dir, 'film.html');
  await writeFile(filmPath, FILM, 'utf8');
  await writeFile(join(dir, 'page.html'), '<!doctype html><meta charset="utf-8"><div id="card"></div><p id="footer">锁</p>', 'utf8');
  return { root, dir, filmPath, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const shaOf = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');

/** 解析出 FilmDoc（`parse` 在 ops.mjs 里是值解析器；文件名不要和 film-doc 的 parse 混）。 */
function docOf() {
  const parsed = parseFilm(FILM);
  assert.notEqual(parsed.doc, null, `夹具解析失败：${JSON.stringify(parsed.diagnostics ?? [])}`);
  return parsed.doc;
}

/** 整份 overrides（含别人的条目）→ 写回。 */
function writeOverrides(next) {
  return [{ op: 'fields', clip: 'page-main', fields: { overrides: next } }];
}

test('S87-A1 锁定元素的负载改动被拒，码是 ELEMENT_LOCKED（不是 LOCKED）', () => {
  const doc = docOf();
  const ops = writeOverrides([{ at: LOCKED_AT, lock: true, t: 'Agent 想改这行字' }]);
  const verdict = findLockedWrites(doc, ops);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, ELEMENT_LOCKED);
  assert.notEqual(verdict.code, 'LOCKED');
  assert.equal(verdict.violations.length, 1);
  assert.equal(verdict.violations[0].at, LOCKED_AT);
  assert.equal(verdict.violations[0].opIndex, 0);
  assert.match(verdict.message, /已锁定/);

  /* 同一个 op 换成没锁的元素 → 放行（证明判据不是「一律拒绝」）。 */
  const allowed = findLockedWrites(doc, writeOverrides([{ at: LOCKED_AT, lock: true }, { at: FREE_AT, t: '可以改' }]));
  assert.equal(allowed.ok, true);
});

test('S87-A2 一批里只要有一条打到锁定元素，整批拒（原子性）', () => {
  const doc = docOf();
  const ops = [
    { op: 'props', edits: [{ clip: 'page-main', prop: 'volume', value: 0.4 }] },
    writeOverrides([{ at: LOCKED_AT, lock: true, style: { 'background-color': '#ff0000' } }])[0],
  ];
  const verdict = findLockedWrites(doc, ops);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.violations[0].opIndex, 1, '命中的是第二条 Op，但整批都要拒');

  /* 整批拒之后，模型侧不能有任何一条 Op 的效果：把同一批拆开单跑第一条，值必须还能干净应用。 */
  const alone = applyOpsDetailed(doc, [ops[0]]);
  assert.equal(alone.value.tracks[0].clips[0].volume, 0.4);
  /* 而原文档没被这批 Op 碰过（纯函数，`value` 入参不被修改）。 */
  assert.equal(doc.tracks[0].clips[0].volume, undefined);
});

test('S87-A3 解锁写回必须 200 且真的落盘；「解锁 + 顺手改」不算解锁', async () => {
  const project = await makeFilm();
  try {
    const session = createEditSession({ path: project.filmPath, io: createFilmDocIo(), projectId: 'lock' });
    const opened = await session.load();
    assert.equal(opened.ok, true);
    const before = await shaOf(project.filmPath);

    /* 1) 锁着改 → 拒，磁盘不动。 */
    const rejected = await session.apply([{ op: 'fields', clip: 'page-main', fields: { overrides: [{ at: LOCKED_AT, lock: true, t: '改' }] } }], { opId: 'a3-1' });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, ELEMENT_LOCKED);
    assert.equal(await shaOf(project.filmPath), before, '被拒的写入不许碰磁盘');

    /* 2) 只去锁（负载为空）→ 放行，且 sha 变了（真的落盘）。 */
    const unlocked = await session.apply([{ op: 'fields', clip: 'page-main', fields: { overrides: [] } }], { opId: 'a3-2' });
    assert.equal(unlocked.ok, true, JSON.stringify(unlocked));
    const afterUnlock = await shaOf(project.filmPath);
    assert.notEqual(afterUnlock, before);

    /* 3) 解锁后同样的写入 → 200，覆盖真的写进去了。 */
    const written = await session.apply([{ op: 'fields', clip: 'page-main', fields: { overrides: [{ at: LOCKED_AT, t: '解锁后可以改' }] } }], { opId: 'a3-3' });
    assert.equal(written.ok, true, JSON.stringify(written));
    assert.match(await readFile(project.filmPath, 'utf8'), /解锁后可以改/);
  } finally {
    await project.cleanup();
  }
});

test('S87-A4 同一条目既去锁又改负载 → 仍拒（解锁不能当后门）', () => {
  const doc = docOf();
  /* 夹具里 #footer 那条只有锁：先给它一个负载（相当于用户之前用别的批次写进去的）。 */
  const withPayload = applyOpsDetailed(doc, [{ op: 'fields', clip: 'page-main', fields: { overrides: [{ at: LOCKED_AT, lock: true, style: { color: '#ffffff' } }] } }]).value;
  const bypass = findLockedWrites(withPayload, writeOverrides([{ at: LOCKED_AT, t: '删掉锁顺手改一笔' }]));
  assert.equal(bypass.ok, false);
  assert.equal(bypass.code, ELEMENT_LOCKED);

  /* 单纯把锁去掉（负载一字不动）→ 放行。 */
  const pureUnlock = findLockedWrites(withPayload, writeOverrides([{ at: LOCKED_AT, style: { color: '#ffffff' } }]));
  assert.equal(pureUnlock.ok, true);
  assert.equal(elementLocks(withPayload).get('page-main').get(LOCKED_AT) !== undefined, true);
  assert.equal(elementLocks(applyOpsDetailed(withPayload, writeOverrides([{ at: LOCKED_AT, style: { color: '#ffffff' } }])).value).size, 0);
});
