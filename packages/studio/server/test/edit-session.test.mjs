/**
 * M5-WP07 验收 A7–A10：落盘会话（CAS + 历史 + 撤销/重做）、写失败回滚、并发冲突、性能记录。
 * 跑法：node --test packages/studio/server/test/edit-session.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sha256 } from '../../../film-core/film-doc.mjs';
import { createEditSession } from '../edit-session.mjs';
import { createFilmDocIo } from '../film-io.mjs';
import { makeProject } from './helpers.mjs';

/** @param {string} path */
const hashOf = async (path) => sha256(await readFile(path, 'utf8'));

/** 造一个 100 片段的工程（4 轨 × 25，v1.2.0 方言）。 */
async function makeBigProject() {
  const root = await mkdtemp(join(tmpdir(), 'opencut-big-'));
  const dir = join(root, 'big');
  await mkdir(dir, { recursive: true });
  /** @type {string[]} */
  const sections = [];
  for (let track = 0; track < 4; track += 1) {
    /** @type {string[]} */
    const clips = [];
    for (let index = 0; index < 25; index += 1) {
      const n = track * 25 + index;
      clips.push(`    <video id="v${n}" src="assets/take-${n}.mp4#t=0,3" at="${index * 4}"></video>`);
    }
    sections.push(`  <section id="T${track}">\n${clips.join('\n')}\n  </section>`);
  }
  const text = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=1280, height=720">
<title>100 片段</title>
</head>
<body>
${sections.join('\n')}
</body>
</html>
`;
  const filmPath = join(dir, 'film.html');
  await writeFile(filmPath, text, 'utf8');
  return { root, dir, filmPath, text, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('A7 撤销/重做 10 步：文档哈希回到起点，重做回到终点', async () => {
  const project = await makeProject('undo');
  try {
    const io = createFilmDocIo();
    const session = createEditSession({ path: project.filmPath, io, projectId: 'undo' });
    await session.load();

    const startHash = await hashOf(project.filmPath);
    /** @type {string[]} */
    const hashChain = [startHash];

    const steps = [
      [{ op: 'props', edits: [{ clip: 'c1', prop: 'volume', value: 0.3 }] }],
      [{ op: 'props', edits: [{ clip: 'c2', prop: 'at', value: 6 }] }],
      [{ op: 'insert', clip: { src: 'assets/take-c.mp4', time: [0, 2] }, at: 9, track: 0 }],
      [{ op: 'split', clip: 'c1', at: 2, left: { end: 2 }, right: { start: 2, at: 2 } }],
      [{ op: 'props', edits: [{ clip: 'a1', prop: 'fade', value: [0.5, 0.5] }] }],
      [{ op: 'track', track: 2, field: 'muted', value: true }],
      [{ op: 'props', edits: [{ clip: 'c2', prop: 'track', value: 1 }] }],
      [{ op: 'overrides', clip: 'c2', entries: [{ at: 'div#x', t: '改' }] }],
      [{ op: 'props', edits: [{ clip: 'a1', prop: 'link', value: 'g9' }] }],
      [{ op: 'stage', w: 1920, h: 1080 }],
    ];

    for (const [index, ops] of steps.entries()) {
      const result = await session.apply(ops, { opId: `step-${index}` });
      assert.equal(result.ok, true, `第 ${index + 1} 步失败：${JSON.stringify(/** @type {any} */ (result).error ?? {})}`);
      hashChain.push(result.hash);
      assert.notEqual(result.hash, hashChain[hashChain.length - 2], `第 ${index + 1} 步没有改变文件`);
    }
    const endHash = hashChain[hashChain.length - 1];
    assert.equal(await hashOf(project.filmPath), endHash);
    assert.equal(session.depths().undo, 10);

    // 撤 10 步 → 回到起点（逐字节）
    for (let index = 0; index < 10; index += 1) {
      const undone = await session.undo();
      assert.equal(undone.ok, true, `撤销第 ${index + 1} 步失败`);
    }
    assert.equal(await hashOf(project.filmPath), startHash, '撤销 10 步后应回到起点哈希');
    assert.equal(session.depths().undo, 0);
    assert.equal(session.depths().redo, 10);

    // 重做 10 步 → 回到终点
    for (let index = 0; index < 10; index += 1) {
      const redone = await session.redo();
      assert.equal(redone.ok, true, `重做第 ${index + 1} 步失败`);
    }
    assert.equal(await hashOf(project.filmPath), endHash, '重做 10 步后应回到终点哈希');

    // 每次成功写入都有一条历史快照（10 次编辑 + 10 次撤销 + 10 次重做）
    const snapshots = await readdir(join(project.dir, '.film', 'history', 'snapshots'));
    assert.ok(snapshots.length >= 30, `历史快照数 ${snapshots.length}`);
  } finally {
    await project.cleanup();
  }
});

test('A8 写失败（注入 IO 错）：报 IO、磁盘哈希不变、会话状态不动', async () => {
  const project = await makeProject('iofail');
  try {
    const io = createFilmDocIo({
      hooks: {
        beforeRename: () => {
          throw new Error('injected: disk full');
        },
      },
    });
    const session = createEditSession({ path: project.filmPath, io, projectId: 'iofail' });
    await session.load();

    const before = await hashOf(project.filmPath);
    const beforeText = session.text;
    const result = await session.apply([{ op: 'props', edits: [{ clip: 'c1', prop: 'volume', value: 0.1 }] }], { opId: 'io-1' });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'IO');
    assert.match(result.error.message, /disk full/);
    assert.equal(await hashOf(project.filmPath), before, '磁盘哈希不该变');
    assert.equal(session.text, beforeText, '会话里的文本不该变');
    assert.equal(session.depths().undo, 0);
    // 没有半份文件、没有临时文件残留
    const files = await readdir(project.dir);
    assert.deepEqual(files.filter((name) => name.includes('.tmp-')), []);
    assert.deepEqual(files, ['film.html'], `目录里不该多出东西：${files.join(',')}`);
  } finally {
    await project.cleanup();
  }
});

test('A9 并发两批编辑：旧 expectedHash 被拒 CONFLICT，磁盘不变，重读后可继续', async () => {
  const project = await makeProject('conflict');
  try {
    const io = createFilmDocIo();
    const first = createEditSession({ path: project.filmPath, io, projectId: 'conflict' });
    const second = createEditSession({ path: project.filmPath, io, projectId: 'conflict' });
    await first.load();
    await second.load();

    const applied = await first.apply([{ op: 'props', edits: [{ clip: 'c1', prop: 'volume', value: 0.25 }] }], { opId: 'a-1' });
    assert.equal(applied.ok, true);
    const afterFirst = await hashOf(project.filmPath);

    // 第二个会话还拿着旧哈希
    const stale = await second.apply([{ op: 'props', edits: [{ clip: 'c2', prop: 'volume', value: 0.25 }] }], { opId: 'b-1' });
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, 'CONFLICT');
    assert.equal(stale.error.currentHash, afterFirst, '冲突时应返回当前哈希供重读');
    assert.equal(await hashOf(project.filmPath), afterFirst, '磁盘不该被旧版本覆盖');

    // 重读后再写就成功
    const reloaded = await second.reload();
    assert.equal(reloaded.ok, true);
    const retried = await second.apply([{ op: 'props', edits: [{ clip: 'c2', prop: 'volume', value: 0.25 }] }], { opId: 'b-2' });
    assert.equal(retried.ok, true);
    assert.notEqual(await hashOf(project.filmPath), afterFirst);
  } finally {
    await project.cleanup();
  }
});

test('A10 100 片段工程连续 50 次编辑：总耗时与单次 P95（只记录，不设假阈值）', async () => {
  const project = await makeBigProject();
  try {
    const io = createFilmDocIo();
    const session = createEditSession({ path: project.filmPath, io, projectId: 'big' });
    await session.load();

    /** @type {number[]} */
    const durations = [];
    const startedAll = performance.now();
    for (let index = 0; index < 50; index += 1) {
      const clipId = `v${(index * 7) % 100}`;
      /** @type {any[]} */
      let ops;
      if (index % 5 === 0) ops = [{ op: 'props', edits: [{ clip: clipId, prop: 'volume', value: 0.5 + (index % 3) / 10 }] }];
      else if (index % 5 === 1) ops = [{ op: 'props', edits: [{ clip: clipId, prop: 'at', value: (index % 20) + 0.5 }] }];
      else if (index % 5 === 2) ops = [{ op: 'insert', clip: { src: `assets/new-${index}.mp4`, time: [0, 2] }, at: index, track: index % 4 }];
      else if (index % 5 === 3) ops = [{ op: 'props', edits: [{ clip: clipId, prop: 'fade', value: [0.2, 0.3] }] }];
      else ops = [{ op: 'remove', clip: `v${(index * 11 + 90) % 100}` }];

      const started = performance.now();
      const result = await session.apply(ops, { opId: `perf-${index}` });
      durations.push(performance.now() - started);
      assert.equal(result.ok, true, `第 ${index} 次编辑失败：${JSON.stringify(/** @type {any} */ (result).error ?? {})}`);
    }
    const total = performance.now() - startedAll;

    const sorted = [...durations].sort((a, b) => a - b);
    const p95 = Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]);
    const average = durations.reduce((sum, value) => sum + value, 0) / durations.length;

    // 同一组编辑再来一遍、关掉历史快照：把「写文件」与「每写一次 git 快照」的成本分开。
    const bare = createEditSession({ path: project.filmPath, io, projectId: 'big', history: false });
    await bare.load();
    const startedBare = performance.now();
    for (let index = 0; index < 50; index += 1) {
      const alive = /** @type {any} */ (bare.value).tracks.flatMap((/** @type {any} */ track) => track.clips.map((/** @type {any} */ clip) => clip.id));
      const ops = [{ op: 'props', edits: [{ clip: alive[(index * 3) % alive.length], prop: 'at', value: (index % 30) + 0.25 }] }];
      const result = await bare.apply(ops, { opId: `bare-${index}` });
      assert.equal(result.ok, true, `无历史第 ${index} 次失败：${JSON.stringify(/** @type {any} */ (result).error ?? {})}`);
    }
    const bareTotal = performance.now() - startedBare;

    // 只记录，不设阈值：数字进交接文件，由大脑按机器实际情况判断。
    console.log(
      JSON.stringify({
        clips: 100,
        edits: durations.length,
        withHistory: {
          totalMs: Number(total.toFixed(1)),
          avgMs: Number(average.toFixed(2)),
          p95Ms: Number(p95.toFixed(2)),
          maxMs: Number(Number(sorted[sorted.length - 1]).toFixed(2)),
          minMs: Number(Number(sorted[0]).toFixed(2)),
        },
        withoutHistory: {
          edits: 50,
          totalMs: Number(bareTotal.toFixed(1)),
          avgMs: Number((bareTotal / 50).toFixed(2)),
        },
      }),
    );
    assert.equal(durations.length, 50);
    assert.ok(total > 0);
  } finally {
    await project.cleanup();
  }
});
