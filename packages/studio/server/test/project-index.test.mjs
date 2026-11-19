/**
 * M55 工程索引单测（B-MAIN-R29-029）。
 *
 * 覆盖任务书 A1–A3 的逻辑面（UI 验收在 M56）：
 *
 * - 文件不存在不是错误；
 * - 倒序 + 12 条上限；
 * - 同一毫秒连续打开也严格递增；
 * - 坏 JSON：**先备份、不覆盖**，返回空 + corrupt；
 * - remove 只动索引、顺序不变；
 * - 原子写不留 `.tmp-*`。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_RECENT,
  indexPath,
  readProjectIndex,
  recordProjectOpen,
  removeProjectEntry,
  writeProjectIndex,
} from '../project-index.mjs';

/**
 * 每个用例一个临时 home。
 * @param {(ctx: { home: string, file: string }) => Promise<void>} fn
 */
async function withHome(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-index-'));
  try {
    await fn({ home, file: indexPath(home) });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

/** @param {string} home @param {number} i */
function projectPath(home, i) {
  return path.join(home, '.opencut', 'projects', `p${i}`);
}

test('A1 文件不存在 → 空列表且 corrupt=false', async () => {
  await withHome(async ({ home, file }) => {
    const read = await readProjectIndex({ home });
    assert.equal(read.corrupt, false);
    assert.deepEqual(read.projects, []);
    assert.equal(read.file, file);
  });
});

test('A2 三条按 openedAt 倒序，重复打开置顶', async () => {
  await withHome(async ({ home }) => {
    await recordProjectOpen({ path: projectPath(home, 1), name: '一' }, { home, now: 1000 });
    await recordProjectOpen({ path: projectPath(home, 2), name: '二' }, { home, now: 2000 });
    await recordProjectOpen({ path: projectPath(home, 3), name: '三' }, { home, now: 3000 });
    let read = await readProjectIndex({ home });
    assert.deepEqual(read.projects.map((p) => p.name), ['三', '二', '一']);

    // 再打开「一」→ 置顶，不新增条目
    await recordProjectOpen({ path: projectPath(home, 1), name: '一' }, { home, now: 4000 });
    read = await readProjectIndex({ home });
    assert.equal(read.projects.length, 3);
    assert.deepEqual(read.projects.map((p) => p.name), ['一', '三', '二']);
  });
});

test('A3 第 13 条挤掉最旧，最多 12 条', async () => {
  await withHome(async ({ home }) => {
    for (let i = 1; i <= MAX_RECENT + 1; i++) {
      await recordProjectOpen({ path: projectPath(home, i), name: `p${i}` }, { home, now: 1000 + i });
    }
    const read = await readProjectIndex({ home });
    assert.equal(read.projects.length, MAX_RECENT);
    assert.equal(read.projects[0]?.name, `p${MAX_RECENT + 1}`);
    assert.ok(!read.projects.some((p) => p.name === 'p1'), '最旧的 p1 应被挤掉');
  });
});

test('A3b 同一毫秒连续打开：openedAt 严格递增', async () => {
  await withHome(async ({ home }) => {
    await recordProjectOpen({ path: projectPath(home, 1), name: '一' }, { home, now: 5000 });
    await recordProjectOpen({ path: projectPath(home, 2), name: '二' }, { home, now: 5000 });
    await recordProjectOpen({ path: projectPath(home, 3), name: '三' }, { home, now: 5000 });
    const read = await readProjectIndex({ home });
    const t = read.projects
      .map((p) => Date.parse(p.openedAt))
      .slice()
      .reverse();
    assert.equal(t.length, 3);
    assert.ok((t[0] ?? 0) < (t[1] ?? 0) && (t[1] ?? 0) < (t[2] ?? 0), `应严格递增，实际 ${t.join(',')}`);
  });
});

test('A3c 坏 JSON：先备份、不覆盖原文件、返回 corrupt', async () => {
  await withHome(async ({ home, file }) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const bad = '{ this is not json';
    await fs.writeFile(file, bad, 'utf8');

    const read = await readProjectIndex({ home });
    assert.equal(read.corrupt, true);
    assert.deepEqual(read.projects, []);
    assert.ok(read.backup, '应返回备份路径');

    // 原文件字节不变
    assert.equal(await fs.readFile(file, 'utf8'), bad);
    // 备份内容与原文件一致
    assert.equal(await fs.readFile(/** @type {string} */ (read.backup), 'utf8'), bad);

    // 第二次读不重复备份
    const names = (await fs.readdir(path.dirname(file))).filter((n) => n.startsWith('projects.json.bak-'));
    const again = await readProjectIndex({ home });
    const names2 = (await fs.readdir(path.dirname(file))).filter((n) => n.startsWith('projects.json.bak-'));
    assert.equal(again.corrupt, true);
    assert.equal(names2.length, names.length, '坏文件只备份一次');

    // 下一次写入才落干净文件
    const wrote = await recordProjectOpen({ path: projectPath(home, 9), name: '九' }, { home, now: 9000 });
    assert.equal(wrote.ok, true);
    const after = await readProjectIndex({ home });
    assert.equal(after.corrupt, false);
    assert.equal(after.projects.length, 1);
  });
});

test('A3d remove 只删指定条目，其余顺序不变，磁盘不动', async () => {
  await withHome(async ({ home }) => {
    const p1 = projectPath(home, 1);
    const p2 = projectPath(home, 2);
    const p3 = projectPath(home, 3);
    await fs.mkdir(p1, { recursive: true });
    await recordProjectOpen({ path: p1, name: '一' }, { home, now: 1000 });
    await recordProjectOpen({ path: p2, name: '二' }, { home, now: 2000 });
    await recordProjectOpen({ path: p3, name: '三' }, { home, now: 3000 });

    const removed = await removeProjectEntry(p2, { home });
    assert.equal(removed.ok, true);
    assert.equal(removed.removed, true);
    assert.deepEqual(removed.projects.map((p) => p.name), ['三', '一']);

    // 磁盘目录还在
    assert.equal(await fs.stat(p1).then(() => true), true);

    // 再删一次 → removed=false，不报错
    const again = await removeProjectEntry(p2, { home });
    assert.equal(again.ok, true);
    assert.equal(again.removed, false);
  });
});

test('A3e 原子写：目录里不留 .tmp-*，回读 sha 与内容一致', async () => {
  await withHome(async ({ home, file }) => {
    const wrote = await writeProjectIndex([{ path: projectPath(home, 1), name: '一', openedAt: new Date(1000).toISOString() }], { home });
    assert.equal(wrote.ok, true);
    assert.equal(wrote.count, 1);
    const names = await fs.readdir(path.dirname(file));
    assert.equal(names.filter((n) => n.includes('.tmp-')).length, 0);
    const raw = await fs.readFile(file, 'utf8');
    assert.match(raw, /"version": 1/);
  });
});
