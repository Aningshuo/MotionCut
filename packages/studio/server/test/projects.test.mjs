// @ts-nocheck
// 运行时测试：类型由源文件（tsc --checkJs）保证；测试里大量断言会让联合类型收窄成本高于收益。
/**
 * M4-A1 ~ M4-A10：工程库 / 多标签 / 每工程状态（注册表层）。
 * M4-A4（每工程视图实例）在 apps/desktop/test/views.test.mjs。
 * 跑法：node --test packages/studio/server/test/projects.test.mjs
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { sha256 } from '../../../film-core/film-doc.mjs';
import { createEventHub } from '../events.mjs';
import { createFilmDocIo } from '../film-io.mjs';
import { createProjectRegistry, THUMBNAIL_TIMEOUT_MS } from '../projects.mjs';
import { makeProject, sleep, waitFor } from './helpers.mjs';

function probeHub() {
  const hub = createEventHub();
  /** @type {any[]} */
  const events = [];
  hub.subscribe({ send: (envelope) => events.push(envelope.event) });
  return { hub, events };
}

/** @param {any[]} events @param {string} type */
const ofType = (events, type) => events.filter((event) => event.type === type);

test('M4-A1 打开夹具：3 轨 4 片段 / 1280×720 / fps 30 / 8s 与 parse() 一致', async () => {
  const project = await makeProject('m4a1');
  const { hub } = probeHub();
  const registry = createProjectRegistry({ hub, io: createFilmDocIo() });
  try {
    const opened = await registry.open(project.dir);
    assert.equal(opened.ok, true, opened.ok ? '' : `${opened.code}: ${opened.message}`);
    const summary = registry.summary(opened.project.projectId);
    assert.deepEqual(summary.stage, { w: 1280, h: 720 });
    assert.deepEqual(summary.fps, { num: 30, den: 1 });
    assert.equal(summary.trackCount, 3);
    assert.equal(summary.clipCount, 4);
    assert.equal(summary.durationSec, 8);
    assert.equal(summary.sourceHash, sha256(project.text));
    assert.deepEqual(summary.diagnostics, []);
  } finally {
    await registry.closeAll();
    await project.cleanup();
  }
});

test('M4-A2 两个工程各自写队列并发，互不阻塞（延迟注入 + 区间重叠）', async () => {
  const a = await makeProject('m4a2-a');
  const b = await makeProject('m4a2-b');
  const { hub } = probeHub();
  const base = createFilmDocIo();
  /** @type {{ path: string, enter: number, exit: number }[]} */
  const spans = [];
  const registry = createProjectRegistry({
    hub,
    ioFactory: () => ({
      ...base,
      commit: async (path, text, expected) => {
        const enter = Date.now();
        await sleep(180);
        const result = await base.commit(path, text, expected);
        const exit = Date.now();
        spans.push({ path, enter, exit });
        return result;
      },
    }),
  });
  try {
    const openedA = await registry.open(a.dir);
    const openedB = await registry.open(b.dir);
    assert.equal(openedA.ok, true);
    assert.equal(openedB.ok, true);
    assert.notEqual(openedA.project.projectId, openedB.project.projectId);
    assert.notEqual(openedA.project.queue, openedB.project.queue, '每个工程必须有自己的队列');

    const startedAt = Date.now();
    const [writeA, writeB] = await Promise.all([
      registry.write(openedA.project.projectId, {
        opId: 'a2-a',
        expectedHash: openedA.project.sourceHash,
        edits: [{ clipId: 'c1', field: 'at', value: 1 }],
      }),
      registry.write(openedB.project.projectId, {
        opId: 'a2-b',
        expectedHash: openedB.project.sourceHash,
        edits: [{ clipId: 'c1', field: 'at', value: 2 }],
      }),
    ]);
    const elapsed = Date.now() - startedAt;
    assert.equal(writeA.ok, true, JSON.stringify(writeA));
    assert.equal(writeB.ok, true, JSON.stringify(writeB));
    assert.equal(spans.length, 2);
    const sorted = spans.slice().sort((left, right) => left.enter - right.enter);
    assert.ok(
      sorted[1].enter < sorted[0].exit,
      `两个工程的 commit 必须重叠（说明不共享串行锁）：${JSON.stringify(sorted)}`,
    );
    process.stdout.write(`# A2 并发总耗时 ${elapsed}ms，commit 区间=${JSON.stringify(sorted)}\n`);
    // 判据只看「两个 commit 时间区间是否重叠」——那才是「不共享串行锁」的直接证据。
    // 不再断言总耗时上限：写路径每次都会落一条私有 Git 快照，其开销随机器/负载变化，
    // 拿墙钟时间当并发判据会在慢机器上假失败（本集成轮就出现过 645ms 的抖动）。
    // 串行会体现为区间不重叠，而这里已经断言了重叠。
  } finally {
    await registry.closeAll();
    await a.cleanup();
    await b.cleanup();
  }
});

test('M4-A3 两标签各存播放头/选区，切换不串', async () => {
  const a = await makeProject('m4a3-a');
  const b = await makeProject('m4a3-b');
  const { hub } = probeHub();
  const registry = createProjectRegistry({ hub, io: createFilmDocIo() });
  try {
    const openedA = await registry.open(a.dir);
    const openedB = await registry.open(b.dir);
    registry.setView(openedA.project.projectId, { playhead: 1.25, selection: ['c1'] });
    registry.setView(openedB.project.projectId, { playhead: 6.5, selection: ['a1'] });

    assert.deepEqual(registry.summary(openedA.project.projectId).view, { playhead: 1.25, selection: ['c1'], cwd: a.dir });
    assert.deepEqual(registry.summary(openedB.project.projectId).view, { playhead: 6.5, selection: ['a1'], cwd: b.dir });

    // cwd（Agent 用，本批只存字段）也只影响本工程。
    assert.equal(registry.setCwd(openedA.project.projectId, `${a.dir}/work`).ok, true);
    assert.equal(registry.summary(openedA.project.projectId).view.cwd, `${a.dir}/work`);
    assert.equal(registry.summary(openedB.project.projectId).view.cwd, b.dir);

    // 更新一个不影响另一个
    registry.setView(openedA.project.projectId, { playhead: 2 });
    assert.equal(registry.summary(openedA.project.projectId).view.playhead, 2);
    assert.equal(registry.summary(openedB.project.projectId).view.playhead, 6.5);
    assert.deepEqual(registry.summary(openedB.project.projectId).view.selection, ['a1']);
  } finally {
    await registry.closeAll();
    await a.cleanup();
    await b.cleanup();
  }
});

test('M4-A5 外部改 film.html → film.changed（新 hash），不自动覆盖', async () => {
  const project = await makeProject('m4a5');
  const { hub, events } = probeHub();
  const registry = createProjectRegistry({ hub, io: createFilmDocIo() });
  try {
    const opened = await registry.open(project.dir);
    const projectId = opened.project.projectId;
    const externalText = (await readFile(project.filmPath, 'utf8')).replace('volume="1"', 'volume="0.33"');
    const externalHash = sha256(externalText);
    await writeFile(project.filmPath, externalText, 'utf8');

    const received = await waitFor(
      () => ofType(events, 'film.changed').some((event) => event.sourceHash === externalHash),
      4000,
    );
    assert.equal(received, true, `未收到 film.changed，已收：${JSON.stringify(events)}`);
    const event = ofType(events, 'film.changed').find((item) => item.sourceHash === externalHash);
    assert.equal(event.projectId, projectId);
    assert.equal(event.by, 'external');

    // 不自动回写：磁盘仍是外部那一版
    assert.equal(await readFile(project.filmPath, 'utf8'), externalText);
    assert.equal(registry.summary(projectId).sourceHash, externalHash);
    assert.equal(registry.summary(projectId).external.count, 1);

    // 内存编辑（投影）不会反向覆盖磁盘：再等一拍仍是外部内容。
    await sleep(120);
    assert.equal(await readFile(project.filmPath, 'utf8'), externalText);
  } finally {
    await registry.closeAll();
    await project.cleanup();
  }
});

test('M4-A6 重复打开同一工程 → 单标签、单写队列', async () => {
  const project = await makeProject('m4a6');
  const { hub } = probeHub();
  const registry = createProjectRegistry({ hub, io: createFilmDocIo() });
  try {
    const first = await registry.open(project.dir);
    const second = await registry.open(project.dir);
    const third = await registry.open(`${project.dir}/`);
    assert.equal(first.existing, false);
    assert.equal(second.existing, true);
    assert.equal(third.existing, true);
    assert.equal(first.project.projectId, second.project.projectId);
    assert.equal(first.project.queue, second.project.queue, '必须复用同一个写队列');
    assert.equal(registry.stats().queuesCreated, 1);
    assert.equal(registry.stats().watchesCreated, 1);
    assert.equal(registry.summaries().length, 1);
  } finally {
    await registry.closeAll();
    await project.cleanup();
  }
});

test('M4-A7 坏路径/坏文件 → 稳定错误码，进程不崩', async () => {
  const { hub } = probeHub();
  const registry = createProjectRegistry({ hub, io: createFilmDocIo() });
  const missing = await registry.open('/definitely/not/here/opencut');
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'FILM_NOT_FOUND');

  const broken = await makeProject('m4a7-broken');
  try {
    await writeFile(
      join(broken.dir, 'film.html'),
      '<!doctype html><html><head><meta name="viewport" content="width=1280, height=720"></head><body><section><video id="x" src="a.mp4" at="0" bogus="1"></video></section></body></html>',
      'utf8',
    );
    const invalid = await registry.open(broken.dir);
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, 'FILM_INVALID');
    assert.ok(invalid.diagnostics.length > 0);
    assert.equal(invalid.diagnostics[0].code, 'UNKNOWN_ATTRIBUTE');

    // 目录存在但没有 film.html
    const emptyDirRoot = await makeProject('m4a7-empty');
    const { rm } = await import('node:fs/promises');
    await rm(join(emptyDirRoot.dir, 'film.html'));
    try {
      const noFilm = await registry.open(emptyDirRoot.dir);
      assert.equal(noFilm.ok, false);
      assert.equal(noFilm.code, 'FILM_NOT_FOUND');
    } finally {
      await emptyDirRoot.cleanup();
    }
    // 进程还活着，能继续打开正常工程
    const good = await makeProject('m4a7-good');
    try {
      const opened = await registry.open(good.dir);
      assert.equal(opened.ok, true);
    } finally {
      await good.cleanup();
    }
  } finally {
    await broken.cleanup();
    await registry.closeAll();
  }
});

test('M4-A8 关标签时有未完成写：完成或明确取消，磁盘状态可解释', async () => {
  const steady = await makeProject('m4a8-wait');
  const abrupt = await makeProject('m4a8-cancel');
  const { hub } = probeHub();
  const base = createFilmDocIo();
  const registry = createProjectRegistry({
    hub,
    ioFactory: () => ({
      ...base,
      commit: async (path, text, expected) => {
        await sleep(250);
        return base.commit(path, text, expected);
      },
    }),
  });
  try {
    const opened = await registry.open(steady.dir);
    const writePromise = registry.write(opened.project.projectId, {
      opId: 'a8-wait',
      expectedHash: opened.project.sourceHash,
      edits: [{ clipId: 'c1', field: 'at', value: 3 }],
    });
    await sleep(30);
    const closed = await registry.close(opened.project.projectId, { waitMs: 2000 });
    const result = await writePromise;
    assert.equal(closed.drained, true, JSON.stringify(closed));
    assert.equal(closed.cancelled, 0);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(sha256(await readFile(steady.filmPath, 'utf8')), result.hash);

    // 取消分支：等待时间不够，明确报告未排空；在途写完成后磁盘仍与结果一致。
    const opened2 = await registry.open(abrupt.dir);
    const slowWrite = registry.write(opened2.project.projectId, {
      opId: 'a8-cancel',
      expectedHash: opened2.project.sourceHash,
      edits: [{ clipId: 'c1', field: 'at', value: 4 }],
    });
    await sleep(30);
    const closed2 = await registry.close(opened2.project.projectId, { waitMs: 10 });
    assert.equal(closed2.drained, false, JSON.stringify(closed2));
    assert.ok(closed2.cancelled >= 1, JSON.stringify(closed2));
    const settled = await slowWrite;
    const diskHash = sha256(await readFile(abrupt.filmPath, 'utf8'));
    if (settled.ok === true) assert.equal(diskHash, settled.hash, '在途写完成后磁盘必须与返回 hash 一致');
    else assert.notEqual(settled.error, undefined, '未完成写必须有明确错误');
  } finally {
    await registry.closeAll();
    await steady.cleanup();
    await abrupt.cleanup();
  }
});

test('M4-A9 关掉重开进程 → 同一工程解析结果与哈希不变', async () => {
  const project = await makeProject('m4a9');
  const script = new URL('./open-once.mjs', import.meta.url).pathname;
  const run = () =>
    execFileSync(process.execPath, [script, project.dir], { encoding: 'utf8' }).trim().split('\n').at(-1);
  try {
    const first = JSON.parse(String(run()));
    const second = JSON.parse(String(run()));
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(first.hash, second.hash);
    assert.deepEqual(first.summary, second.summary);
    assert.equal(first.hash, sha256(project.text));
  } finally {
    await project.cleanup();
  }
});

test('M4-A10 缩略请求可观测：PENDING_FRAME → 超时码；计数正确', async () => {
  const project = await makeProject('m4a10');
  const { hub } = probeHub();
  const registry = createProjectRegistry({ hub, io: createFilmDocIo(), thumbnailTimeoutMs: 80 });
  try {
    const opened = await registry.open(project.dir);
    const snapshot = registry.thumbnails(opened.project.projectId);
    assert.equal(snapshot.requested, 4);
    assert.equal(snapshot.pending, 4);
    assert.equal(snapshot.frameConnected, false);
    assert.ok(snapshot.items.every((item) => item.state === 'PENDING_FRAME'));
    assert.ok(snapshot.items.every((item) => item.code === 'PENDING_FRAME'));
    assert.ok(snapshot.items.every((item) => typeof item.deadlineAt === 'string'));

    const timedOut = await waitFor(() => registry.thumbnails(opened.project.projectId).timedOut === 4, 3000);
    assert.equal(timedOut, true, JSON.stringify(registry.thumbnails(opened.project.projectId)));
    const after = registry.thumbnails(opened.project.projectId);
    assert.equal(after.pending, 0);
    assert.equal(after.timedOut, 4);
    assert.ok(after.items.every((item) => item.code === 'THUMBNAIL_TIMEOUT' && item.timedOut === true));
    assert.equal(THUMBNAIL_TIMEOUT_MS >= 500, true, '默认超时不应过短，避免误判');
  } finally {
    await registry.closeAll();
    await project.cleanup();
  }
});
