// @ts-nocheck
// 运行时测试：类型由源文件（tsc --checkJs）保证；测试里大量断言会让联合类型收窄成本高于收益。
/**
 * M3-A5 ~ M3-A11：纯写、CAS 原子写、历史快照、连续编辑不丢写、冲突副本。
 * 跑法：node --test packages/studio/server/test/write-path.test.mjs
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { parse, sha256, write } from '../../../film-core/film-doc.mjs';
import { createEventHub } from '../events.mjs';
import { createFilmDocIo } from '../film-io.mjs';
import { createProjectRegistry } from '../projects.mjs';
import { makeProject } from './helpers.mjs';

const filmDocSource = await readFile(new URL('../../../film-core/film-doc.mjs', import.meta.url), 'utf8');
const harnessSource = await readFile(new URL('../film-io.mjs', import.meta.url), 'utf8');

/** 收集 hub 事件，便于断言「真的发出来了」。 */
function createHubProbe() {
  const hub = createEventHub();
  /** @type {any[]} */
  const events = [];
  hub.subscribe({ send: (envelope) => events.push(envelope.event) });
  return { hub, events, types: () => events.map((event) => event.type) };
}

/** @param {any[]} events @param {string} type */
const eventsOf = (events, type) => events.filter((event) => event.type === type);

test('M3-A5 write() 纯：源码无 node:fs；同入参两次结果字节一致', () => {
  assert.equal(/node:fs/.test(filmDocSource), false, 'film-doc.mjs 不允许引用 node:fs');
  assert.equal(/(?:import|require)\(['"]node:fs/.test(filmDocSource), false);
  assert.equal(/node:fs/.test(harnessSource), true, 'FilmDocIo 才是磁盘侧（这里有 fs 是应该的）');

  const project = {
    text: '<!doctype html><html><head><meta name="viewport" content="width=1280, height=720"></head><body><section><video id="v1" src="a.mp4" at="0"></video></section></body></html>',
  };
  const hash = sha256(project.text);
  const edits = [{ clipId: 'v1', field: 'at', value: 2 }];
  const first = write(project.text, edits, hash);
  const second = write(project.text, edits, hash);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.text, second.text);
  assert.ok(Buffer.from(String(first.text), 'utf8').equals(Buffer.from(String(second.text), 'utf8')));
  assert.equal(first.bytes, Buffer.byteLength(String(first.text), 'utf8'));
});

test('M3-A6 write() 返回 text/bytes/sourceHash/prevSourceHash/changed，hash 自洽', async () => {
  const project = await makeProject('a6');
  try {
    const before = await readFile(project.filmPath, 'utf8');
    const prevHash = sha256(before);
    const result = write(before, [{ clipId: 'c1', field: 'volume', value: 0.25 }], prevHash);
    assert.equal(result.ok, true);
    assert.equal(typeof result.text, 'string');
    assert.equal(result.bytes, Buffer.byteLength(String(result.text), 'utf8'));
    assert.equal(result.sourceHash, sha256(String(result.text)));
    assert.equal(result.prevSourceHash, prevHash);
    assert.equal(result.changed, true);
    assert.notEqual(result.sourceHash, prevHash);

    const noop = write(before, [], prevHash);
    assert.equal(noop.changed, false);
    assert.equal(noop.sourceHash, prevHash);

    const conflict = write(before, [{ clipId: 'c1', field: 'volume', value: 0.5 }], 'deadbeef');
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, 'CONFLICT');
    assert.equal(conflict.text, undefined, '失败结果不允许带 text');
  } finally {
    await project.cleanup();
  }
});

test('M3-A7 旧 baseHash → CONFLICT，磁盘哈希不变', async () => {
  const project = await makeProject('a7');
  const probe = createHubProbe();
  const registry = createProjectRegistry({ hub: probe.hub, io: createFilmDocIo() });
  try {
    const opened = await registry.open(project.dir);
    assert.equal(opened.ok, true);
    const staleHash = sha256(project.text);
    const diskBefore = sha256(await readFile(project.filmPath, 'utf8'));

    // 先做一次真写，让 staleHash 过期。
    const first = await registry.write(opened.project.projectId, {
      opId: 'a7-1',
      expectedHash: staleHash,
      edits: [{ clipId: 'c1', field: 'at', value: 1 }],
    });
    assert.equal(first.ok, true);
    const afterFirst = sha256(await readFile(project.filmPath, 'utf8'));
    assert.notEqual(afterFirst, diskBefore);

    const rejected = await registry.write(opened.project.projectId, {
      opId: 'a7-2',
      expectedHash: staleHash,
      edits: [{ clipId: 'c1', field: 'volume', value: 0.4 }],
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'CONFLICT');
    assert.equal(rejected.error.currentHash, afterFirst);

    const afterRejected = sha256(await readFile(project.filmPath, 'utf8'));
    assert.equal(afterRejected, afterFirst, '被拒的写不得改动磁盘');

    const rejectedEvents = eventsOf(probe.events, 'film.writeRejected');
    assert.ok(rejectedEvents.length >= 1);
    assert.equal(rejectedEvents[0].code, 'CONFLICT');
    assert.equal(rejectedEvents[0].actualHash, afterFirst);
  } finally {
    await registry.closeAll();
    await project.cleanup();
  }
});

test('M3-A8 原子写：rename 前抛错 → 文件仍是旧内容，无 .tmp 残留', async () => {
  const project = await makeProject('a8');
  let explode = true;
  const io = createFilmDocIo({
    hooks: {
      beforeRename: () => {
        if (explode) throw new Error('模拟断电：rename 前失败');
      },
    },
  });
  const before = await readFile(project.filmPath, 'utf8');
  const beforeHash = sha256(before);
  const next = `${before}\n<!-- touched -->\n`;

  try {
    const crashed = await io.commit(project.filmPath, next, beforeHash);
    assert.equal(crashed.ok, false);
    assert.equal(crashed.code, 'IO');
    assert.match(String(crashed.message), /模拟断电/);
    assert.equal(sha256(await readFile(project.filmPath, 'utf8')), beforeHash, '文件必须保持旧内容');

    const leftovers = (await readdir(project.dir)).filter((name) => name.includes('.tmp-'));
    assert.deepEqual(leftovers, [], `不允许残留临时文件：${leftovers.join(', ')}`);

    // 正常路径仍然可用：同一份 io，关掉故障注入后能落盘。
    explode = false;
    const ok = await io.commit(project.filmPath, next, beforeHash);
    assert.equal(ok.ok, true);
    assert.equal(ok.sourceHash, sha256(next));
    assert.equal(sha256(await readFile(project.filmPath, 'utf8')), sha256(next));
  } finally {
    await project.cleanup();
  }
});

test('M3-A9 连续三次编辑都保留；旧 baseHash 的第二次编辑被拒', async () => {
  const project = await makeProject('a9');
  const probe = createHubProbe();
  const registry = createProjectRegistry({ hub: probe.hub, io: createFilmDocIo() });
  try {
    const opened = await registry.open(project.dir);
    assert.equal(opened.ok, true);
    const projectId = opened.project.projectId;

    const base = opened.project.sourceHash;
    const first = await registry.write(projectId, {
      opId: 'a9-1',
      expectedHash: base,
      edits: [{ clipId: 'c1', field: 'at', value: 1 }],
    });
    assert.equal(first.ok, true);

    // 模拟「第二次编辑拿着旧 baseHash」：用第一次之前的 hash 提交。
    const rejected = await registry.write(projectId, {
      opId: 'a9-stale',
      expectedHash: base,
      edits: [{ clipId: 'c1', field: 'volume', value: 0.5 }],
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'CONFLICT');
    const afterReject = sha256(await readFile(project.filmPath, 'utf8'));
    assert.equal(afterReject, first.hash, '被拒写不得改磁盘');

    const second = await registry.write(projectId, {
      opId: 'a9-2',
      expectedHash: String(first.hash),
      edits: [{ clipId: 'c1', field: 'volume', value: 0.5 }],
    });
    assert.equal(second.ok, true, JSON.stringify(second));
    const third = await registry.write(projectId, {
      opId: 'a9-3',
      expectedHash: String(second.hash),
      edits: [{ clipId: 'c1', field: 'speed', value: 2 }],
    });
    assert.equal(third.ok, true, JSON.stringify(third));

    const finalText = await readFile(project.filmPath, 'utf8');
    const parsed = parse(finalText, { path: project.filmPath });
    assert.equal(parsed.doc !== null, true, JSON.stringify(parsed.diagnostics));
    const clip = parsed.doc.tracks.flatMap((track) => track.clips).find((item) => item.id === 'c1');
    assert.equal(clip.at, 1, '第一次编辑（at）必须还在');
    assert.equal(clip.volume, 0.5, '第二次编辑（volume）必须还在');
    assert.equal(clip.speed, 2, '第三次编辑（speed）必须还在');
    assert.equal(sha256(finalText), third.hash);

    const changed = eventsOf(probe.events, 'film.changed');
    assert.ok(changed.length >= 3, `每次成功写入都要有 film.changed，实际 ${changed.length}`);
    assert.ok(changed.every((event) => event.projectId === projectId));
  } finally {
    await registry.closeAll();
    await project.cleanup();
  }
});

test('M3-A10 每次成功写入落 .film/history git commit；GIT_MISSING 有明确错误', async () => {
  const project = await makeProject('a10');
  const registry = createProjectRegistry({ hub: createHubProbe().hub, io: createFilmDocIo() });
  try {
    const opened = await registry.open(project.dir);
    const projectId = opened.project.projectId;
    let hash = opened.project.sourceHash;
    for (const [index, value] of [1, 2, 3].entries()) {
      const result = await registry.write(projectId, {
        opId: `a10-${index}`,
        expectedHash: hash,
        edits: [{ clipId: 'c1', field: 'at', value }],
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.history?.ok, true, JSON.stringify(result.history));
      hash = String(result.hash);
    }

    const historyDir = join(project.dir, '.film', 'history');
    const log = execFileSync('git', ['-C', historyDir, 'log', '--oneline'], { encoding: 'utf8' })
      .trim()
      .split('\n');
    assert.equal(log.length, 3, `每次写入一条快照，实际：\n${log.join('\n')}`);
    assert.ok(log.every((line) => /op=a10-\d/.test(line)), log.join('\n'));
    assert.ok(log[0].includes(hash.slice(0, 8)), `commit message 应含源哈希短值：${log[0]}`);
    const files = (await readdir(join(historyDir, 'snapshots'))).filter((name) => name.endsWith('.html'));
    assert.equal(files.length, 3);
  } finally {
    await registry.closeAll();
    await project.cleanup();
  }

  // GIT_MISSING：注入一个找不到 git 的执行器，写本身成功，但历史必须有明确错误。
  const brokenProject = await makeProject('a10-gitmissing');
  const io = createFilmDocIo({ gitRunner: async () => ({ ok: false, code: 'GIT_MISSING', stderr: 'spawn git ENOENT' }) });
  try {
    const text = await readFile(brokenProject.filmPath, 'utf8');
    const hash = sha256(text);
    const next = write(text, [{ clipId: 'c1', field: 'volume', value: 0.3 }], hash);
    const committed = await io.commit(brokenProject.filmPath, String(next.text), hash);
    assert.equal(committed.ok, true);
    const snapshot = await io.snapshot({
      projectDir: brokenProject.dir,
      text: String(next.text),
      sourceHash: String(next.sourceHash),
      prevSourceHash: hash,
      opId: 'git-missing',
    });
    assert.equal(snapshot.ok, false);
    assert.equal(snapshot.code, 'GIT_MISSING');
    assert.match(snapshot.message, /git/i);
  } finally {
    await brokenProject.cleanup();
  }
});

test('M3-A11 冲突副本落 .film/conflicts/：文件名可追溯，内容为 Agent 原写', async () => {
  const project = await makeProject('a11');
  const probe = createHubProbe();
  let injectRace = false;
  const io = createFilmDocIo({
    hooks: {
      beforeVerify: async () => {
        if (!injectRace) return;
        injectRace = false;
        // 模拟另一个写入者在 CAS 与 rename 之间改了文件。
        const { writeFile } = await import('node:fs/promises');
        const current = await readFile(project.filmPath, 'utf8');
        await writeFile(project.filmPath, current.replace('volume="1"', 'volume="0.11"'), 'utf8');
      },
    },
  });
  const registry = createProjectRegistry({ hub: probe.hub, io });
  try {
    const opened = await registry.open(project.dir);
    const projectId = opened.project.projectId;
    const baseText = await readFile(project.filmPath, 'utf8');
    const baseHash = sha256(baseText);
    const edits = [{ clipId: 'c1', field: 'volume', value: 0.42 }];
    const agentWrite = write(baseText, edits, baseHash);
    assert.equal(agentWrite.ok, true);

    injectRace = true;
    const result = await registry.write(projectId, { opId: 'a11-race', expectedHash: baseHash, edits });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'CONFLICT');

    const conflictDir = join(project.dir, '.film', 'conflicts');
    const files = await readdir(conflictDir);
    const agentFile = files.find((name) => /^\d{8}T\d{6}\d{3}Z-[0-9a-f]{8}-agent\.html$/.test(name));
    assert.ok(agentFile !== undefined, `冲突文件名必须含时间+短哈希：${files.join(', ')}`);
    const stored = await readFile(join(conflictDir, agentFile), 'utf8');
    assert.equal(stored, agentWrite.text, '冲突副本内容必须是 Agent 原写');

    const requestFile = files.find((name) => name.endsWith('-request.json'));
    assert.ok(requestFile !== undefined, '请求也要留档（用于追溯旧 baseHash）');
    const request = JSON.parse(await readFile(join(conflictDir, requestFile), 'utf8'));
    assert.equal(request.expectedHash, baseHash);
    assert.deepEqual(request.edits, edits);

    const conflicts = eventsOf(probe.events, 'film.conflict');
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].projectId, projectId);
    assert.match(conflicts[0].keptAside, /\.film\/conflicts\//);
    assert.deepEqual(conflicts[0].keys, ['c1.volume']);
    const rejected = eventsOf(probe.events, 'film.writeRejected');
    assert.equal(rejected.at(-1).code, 'CONFLICT');
  } finally {
    await registry.closeAll();
    await project.cleanup();
  }
});
