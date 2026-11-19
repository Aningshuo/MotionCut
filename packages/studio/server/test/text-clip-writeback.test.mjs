// @ts-nocheck
// 运行时测试：类型由源文件（tsc --checkJs）保证；这里断言密集，收窄成本高于收益。
/**
 * R36 / E12-P3 服务端单测（不是量具脚本）。
 *
 * 走的是**服务端真正那条路**：`createEditSession().apply()` → `writeValue()` → `io.commit()` 落盘，
 * 不是 `film-doc` 的纯函数直调。断言一条链：
 *
 *   插 text → 磁盘上真多一行 `<div>` → 重新 parse → 元素还在、kind 仍是 text → 换一个新会话重开还在
 *
 * 为什么必须有这条：R35 的 `m140` 是**脚本**（起子进程、打 HTTP），它证明的是「整条产品链」；
 * 单测证明的是「服务端模块自己」——脚本红了要人读日志，单测红了 `node --test` 直接给断言行。
 *
 * 跑法：node --test packages/studio/server/test/text-clip-writeback.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { parse } from '../../../film-core/film-doc.mjs';
import { createEditSession } from '../edit-session.mjs';
import { createFilmDocIo } from '../film-io.mjs';
import { makeProject } from './helpers.mjs';

/** 取一台轨道上全部片段（服务端文档结构：`doc.tracks[].clips[]`）。 */
const clipsOf = (doc) => (doc?.tracks ?? []).flatMap((track) => track.clips);

/** 服务端文档里找一个片段。 */
const clipById = (doc, id) => clipsOf(doc).find((clip) => clip.id === id) ?? null;

test('R36-E12P3 插 text → 落盘成 <div> → 重新 parse 元素还在且 kind=text → 重开还在', async () => {
  const project = await makeProject('r36-text');
  try {
    const io = createFilmDocIo({ fsyncDir: false });
    const session = createEditSession({ path: project.filmPath, io, projectId: 'r36-text' });
    const opened = await session.load();
    assert.equal(opened.ok, true, JSON.stringify(opened));

    const beforeClips = clipsOf(session.value);
    assert.deepEqual(beforeClips.map((clip) => clip.id), ['c1', 'c2', 'a1', 'a2'], '夹具应有 4 个片段');

    /* 1) 插一条文本片段：`kind:'text'`，内容走 `text`。 */
    const applied = await session.apply(
      [{ op: 'insert', clip: { id: 'title-1', kind: 'text', src: 'scenes/card-a.html', at: 0, time: [0, 3], text: '你好，世界' } }],
      { opId: 'r36-text-1' },
    );
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.changed, true, '插新片段必须真改文件');

    /* 2) 磁盘：真的多了一行 `<div>`，不是 `<video>`（写错标签就是 TAG_OF_KIND 缺键的老坑）。 */
    const onDisk = await readFile(project.filmPath, 'utf8');
    assert.match(onDisk, /<div id="title-1"[^>]*>你好，世界<\/div>/, onDisk);
    assert.equal(onDisk.includes('<video id="title-1"'), false, '文本片段被写成 <video> 了');
    assert.equal(onDisk.includes('<text id="title-1"'), false, '`<text>` 只是解析别名，写回必须统一成 <div>');

    /* 3) 重新 parse（读磁盘字节，不是读内存）：元素还在、kind 仍是 text、内容与区间都对。 */
    const reparsed = parse(onDisk);
    assert.deepEqual(reparsed.diagnostics.map((diag) => diag.code), [], '写回后的文档不允许有诊断');
    const readBack = clipById(reparsed.doc, 'title-1');
    assert.equal(readBack === null, false, '重新 parse 后片段丢了');
    assert.equal(readBack.kind, 'text');
    assert.equal(readBack.text, '你好，世界');
    assert.deepEqual(readBack.time, [0, 3]);
    assert.equal(readBack.src, 'scenes/card-a.html');

    /* 4) 老片段一个不差、相对顺序不变；新片段落在**画面轨**（没给 track 时按角色找同类型轨，
         再按 `at` 排位 —— `at=0` 与 c1 并列，因此排在 c1 之后、c2 之前）。 */
    assert.deepEqual(clipsOf(reparsed.doc).map((clip) => clip.id).filter((id) => id !== 'title-1'), ['c1', 'c2', 'a1', 'a2']);
    assert.deepEqual(reparsed.doc?.tracks?.[0]?.clips?.map((clip) => clip.id), ['c1', 'title-1', 'c2'], '文本片段应落在画面轨并按 at 排位');

    /* 5) 重开：新 io + 新 session（模拟进程重启后重新打开工程），元素还在。 */
    const reopened = createEditSession({ path: project.filmPath, io: createFilmDocIo({ fsyncDir: false }), projectId: 'r36-text' });
    const reopenedLoad = await reopened.load();
    assert.equal(reopenedLoad.ok, true, JSON.stringify(reopenedLoad));
    const stillThere = clipById(reopened.value, 'title-1');
    assert.equal(stillThere === null, false, '重开后片段没了');
    assert.equal(stillThere.kind, 'text');
    assert.equal(stillThere.text, '你好，世界');

    /* 6) 撤销：文件回到与开始**逐字节相同**（写入链路的 inverse 必须能吃掉这一行）。 */
    const undone = await session.undo();
    assert.equal(undone.ok, true, JSON.stringify(undone));
    const afterUndo = await readFile(project.filmPath, 'utf8');
    assert.equal(afterUndo, project.text, '撤销后应与原夹具逐字节相同');
    assert.equal(parse(afterUndo).diagnostics.length, 0);
  } finally {
    await project.cleanup();
  }
});

test('R36-E12P3 文本片段可以没有 src：写回不落裸 src 属性，重新 parse 仍是 text', async () => {
  const project = await makeProject('r36-text-nosrc');
  try {
    const io = createFilmDocIo({ fsyncDir: false });
    const session = createEditSession({ path: project.filmPath, io, projectId: 'r36-text-nosrc' });
    assert.equal((await session.load()).ok, true);

    const applied = await session.apply([{ op: 'insert', clip: { id: 'card', kind: 'text', text: '只有字' } }], { opId: 'r36-text-2' });
    assert.equal(applied.ok, true, JSON.stringify(applied));

    const onDisk = await readFile(project.filmPath, 'utf8');
    const line = onDisk.split('\n').find((row) => row.includes('id="card"')) ?? '';
    assert.ok(line.includes('<div'), line);
    assert.equal(/\ssrc(?:=|\s|>)/.test(line), false, `空 src 被写成了裸属性：${line}`);

    const reparsed = parse(onDisk);
    assert.deepEqual(reparsed.diagnostics.map((diag) => diag.code), []);
    const readBack = clipById(reparsed.doc, 'card');
    assert.equal(readBack?.kind, 'text');
    assert.equal(readBack?.text, '只有字');
    assert.equal(readBack?.src, '');
  } finally {
    await project.cleanup();
  }
});
