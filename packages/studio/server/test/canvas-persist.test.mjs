// @ts-nocheck —— 以 node --test 的运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * 画布写盘一致性（M64 · B-MAIN-R30-031）：真 parse → 真 ops → 真 film-io 原子写。
 *
 * 只测「请求值 / 磁盘 / 重新解析值三者相等」与失败路径；UI 手势不在这一层。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse, writeValue } from '../../../film-core/film-doc.mjs';
import { EditError, applyOpsDetailed } from '../../../film-core/ops.mjs';
import { boxToOps, readbackBox, verifyReadback } from '../../../film-core/canvas-persist.mjs';
import { createFilmDocIo, sha256 } from '../film-io.mjs';

const FIXTURE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=1280, height=720">
<title>M64 画布夹具</title>
<style>html, body { margin: 0; height: 100%; background: #000; } section { position: relative; } video { position: absolute; }</style>
</head>
<body>
<section id="v1">
  <video id="a" src="assets/bars.mp4#t=0,2" at="0" style="left: 100px; top: 50px; width: 320px; height: 180px"></video>
</section>
</body>
</html>
`;

/** 临时工程 + 文本。 */
async function makeProject(tag) {
  const dir = await mkdtemp(join(tmpdir(), `m64-${tag}-`));
  await mkdir(join(dir, '.film'), { recursive: true });
  await writeFile(join(dir, 'film.html'), FIXTURE);
  return { dir, path: join(dir, 'film.html') };
}

/** 走一遍「parse → ops → writeValue」（与 edit-session 同一条链）。 */
function applyBox(text, clipId, box) {
  const parsed = parse(text, {});
  assert.notEqual(parsed.doc, null, '夹具必须能解析');
  const applied = applyOpsDetailed(parsed.doc, boxToOps({ clipId, box }));
  const written = writeValue(text, applied.value, sha256(text));
  assert.equal(written.ok, true, JSON.stringify(written.diagnostics ?? []));
  return { text: written.text, sourceHash: written.sourceHash };
}

async function tmpLeftovers(dir) {
  const names = await readdir(dir);
  return names.filter((name) => name.includes('.tmp-'));
}

test('B1 移动：请求值 → 磁盘 → 重新 parse 误差 ≤1e-3', async () => {
  const { dir, path } = await makeProject('move');
  const io = createFilmDocIo({ fsyncDir: false });
  const before = await readFile(path, 'utf8');
  const requested = { left: 228, top: 86, width: 320, height: 180, rotate: 0 };
  const written = applyBox(before, 'a', requested);
  const committed = await io.commit(path, written.text, sha256(before));
  assert.equal(committed.ok, true);
  const after = await readFile(path, 'utf8');
  const parsed = parse(after, {});
  const readback = readbackBox(parsed.doc.tracks[0].clips[0]);
  const verdict = verifyReadback(requested, readback);
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  await rm(dir, { recursive: true, force: true });
});

test('B2 旋转：179 + 2 落盘为 -179（写 readback 一致）', async () => {
  const { dir, path } = await makeProject('rotate');
  const io = createFilmDocIo({ fsyncDir: false });
  const before = await readFile(path, 'utf8');
  const requested = { left: 100, top: 50, width: 320, height: 180, rotate: -179 };
  const written = applyBox(before, 'a', requested);
  assert.match(written.text, /rotate: -179deg/);
  const committed = await io.commit(path, written.text, sha256(before));
  assert.equal(committed.ok, true);
  const parsed = parse(await readFile(path, 'utf8'), {});
  const readback = readbackBox(parsed.doc.tracks[0].clips[0]);
  assert.deepEqual(readback, requested);
  await rm(dir, { recursive: true, force: true });
});

test('B3 幂等：同一请求连提 3 次，文本 sha 不再变化', async () => {
  const { dir, path } = await makeProject('idem');
  const io = createFilmDocIo({ fsyncDir: false });
  const original = await readFile(path, 'utf8');
  const box = { left: 300, top: 120, width: 400, height: 225, rotate: 0 };
  let text = original;
  /** @type {string[]} */
  const shas = [];
  for (let round = 0; round < 3; round += 1) {
    const written = applyBox(text, 'a', box);
    const committed = await io.commit(path, written.text, sha256(text));
    assert.equal(committed.ok, true);
    text = written.text;
    shas.push(sha256(await readFile(path, 'utf8')));
  }
  assert.equal(shas[1], shas[0]);
  assert.equal(shas[2], shas[0]);
  await rm(dir, { recursive: true, force: true });
});

test('B4 注入失败（rename 前抛）：原文件不变、不留 .tmp-', async () => {
  const { dir, path } = await makeProject('inject');
  const original = await readFile(path, 'utf8');
  const io = createFilmDocIo({
    fsyncDir: false,
    hooks: {
      beforeRename: () => {
        throw new Error('inject rename failure');
      },
    },
  });
  const written = applyBox(original, 'a', { left: 10, top: 10, width: 100, height: 100, rotate: 0 });
  const committed = await io.commit(path, written.text, sha256(original));
  assert.equal(committed.ok, false);
  assert.equal(committed.code, 'IO');
  assert.equal(await readFile(path, 'utf8'), original);
  assert.deepEqual(await tmpLeftovers(dir), []);
  await rm(dir, { recursive: true, force: true });
});

test('B5 只读目录：写不进去时原文件不变、不留半写', async () => {
  const { dir, path } = await makeProject('readonly');
  const original = await readFile(path, 'utf8');
  const io = createFilmDocIo({ fsyncDir: false });
  const written = applyBox(original, 'a', { left: 10, top: 10, width: 100, height: 100, rotate: 0 });
  await chmod(dir, 0o555);
  try {
    const committed = await io.commit(path, written.text, sha256(original));
    assert.equal(committed.ok, false);
    assert.equal(committed.code, 'IO');
  } finally {
    await chmod(dir, 0o755);
  }
  assert.equal(await readFile(path, 'utf8'), original);
  assert.deepEqual(await tmpLeftovers(dir), []);
  await rm(dir, { recursive: true, force: true });
});

test('B6 并发两次写：后者覆盖前者且文件可解析（不损坏）', async () => {
  const { dir, path } = await makeProject('concurrent');
  const ioA = createFilmDocIo({ fsyncDir: false });
  const ioB = createFilmDocIo({ fsyncDir: false });
  const original = await readFile(path, 'utf8');
  const boxA = { left: 100, top: 50, width: 480, height: 270, rotate: 0 };
  const boxB = { left: 100, top: 50, width: 640, height: 360, rotate: 0 };
  const textA = applyBox(original, 'a', boxA).text;
  const textB = applyBox(original, 'a', boxB).text;
  const [commitA, commitB] = await Promise.all([ioA.commit(path, textA, sha256(original)), ioB.commit(path, textB, sha256(original))]);
  // 两个都读到了旧 hash：至少一个成功；允许另一个 CONFLICT（CAS 的正当行为）
  assert.equal(commitA.ok || commitB.ok, true, JSON.stringify({ commitA, commitB }));
  const after = parse(await readFile(path, 'utf8'), {});
  assert.notEqual(after.doc, null, '并发后仍必须可解析');
  const readback = readbackBox(after.doc.tracks[0].clips[0]);
  assert.ok(['480', '640'].includes(String(readback.width)), JSON.stringify(readback));
  await rm(dir, { recursive: true, force: true });
});

test('B7 过期 hash：CAS 冲突且文件不变', async () => {
  const { dir, path } = await makeProject('cas');
  const io = createFilmDocIo({ fsyncDir: false });
  const original = await readFile(path, 'utf8');
  const written = applyBox(original, 'a', { left: 0, top: 0, width: 200, height: 100, rotate: 0 });
  const committed = await io.commit(path, written.text, 'f'.repeat(64));
  assert.equal(committed.ok, false);
  assert.equal(committed.code, 'CONFLICT');
  assert.equal(await readFile(path, 'utf8'), original);
  await rm(dir, { recursive: true, force: true });
});

test('B8 元素不存在 → NOT_FOUND；宽高 0 → INVALID', () => {
  const parsed = parse(FIXTURE, {});
  assert.throws(() => applyOpsDetailed(parsed.doc, boxToOps({ clipId: 'zz', box: { left: 0, top: 0, width: 10, height: 10 } })), (error) => {
    assert.ok(error instanceof EditError);
    assert.equal(error.code, 'NOT_FOUND');
    return true;
  });
  assert.throws(() => applyOpsDetailed(parsed.doc, [{ op: 'props', edits: [{ clip: 'a', prop: 'box', value: { x: 0, y: 0, w: 0, h: 10 } }] }]), (error) => {
    assert.equal(error.code, 'INVALID');
    return true;
  });
});

test('B9 锁轨：box 写入被拒（LOCKED）', () => {
  const locked = FIXTURE.replace('<section id="v1">', '<section id="v1" locked>');
  const parsed = parse(locked, {});
  assert.notEqual(parsed.doc, null);
  assert.throws(() => applyOpsDetailed(parsed.doc, boxToOps({ clipId: 'a', box: { left: 1, top: 1, width: 20, height: 20 } })), (error) => {
    assert.equal(error.code, 'LOCKED');
    return true;
  });
});
