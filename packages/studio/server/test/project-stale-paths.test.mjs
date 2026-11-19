// M73 收口 M72 遗留：`stalePaths` 由索引承载（唯一真源），sidecar 只做兜底。
//
// 三条：
//   1. 透传：写进去的 stalePaths 能被原样读回来（以前 normalizeEntry 会丢掉）；
//   2. 索引优先：索引与 sidecar 各说各话时，用索引里的那份，**不合并**；
//   3. 损坏 sidecar：不影响读（有索引就用索引；没索引就空数组，不抛）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readProjectIndex, writeProjectIndex } from '../project-index.mjs';
import { readStalePaths, stalePathFile } from '../project-move.mjs';

/** @param {(ctx: {home: string}) => Promise<void>} fn */
async function withHome(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-stale-'));
  try {
    await fs.mkdir(path.join(home, '.opencut'), { recursive: true });
    await fn({ home });
  } finally {
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/** @param {string} home @param {string} oldPath */
async function writeSidecar(home, oldPath) {
  await fs.writeFile(
    stalePathFile(home),
    `${JSON.stringify(
      { version: 1, entries: [{ oldPath, newPath: '/elsewhere', code: 'RECLAIM_FAILED', at: '2026-01-01T00:00:00.000Z' }] },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

test('S1 索引透传：stalePaths 写进去、读回来一字不差（缺省为 []）', async () => {
  await withHome(async ({ home }) => {
    const projectPath = path.join(home, 'proj');
    await fs.mkdir(projectPath, { recursive: true });
    const stale = [path.join(home, 'old-a'), path.join(home, 'old-b')];
    const wrote = await writeProjectIndex(
      [{ path: projectPath, name: 'proj', openedAt: '2026-11-09T00:00:00.000Z', stalePaths: stale }],
      { home },
    );
    assert.equal(wrote.ok, true);

    const read = await readProjectIndex({ home });
    assert.equal(read.projects.length, 1);
    assert.deepEqual(read.projects[0]?.stalePaths, stale);

    // 磁盘原文里也有（不是只在内存里补的）。
    const raw = JSON.parse(await fs.readFile(path.join(home, '.opencut', 'projects.json'), 'utf8'));
    assert.deepEqual(raw.projects[0].stalePaths, stale);

    // 没给 stalePaths 的条目补成 []
    const wrotePlain = await writeProjectIndex([{ path: projectPath, name: 'proj', openedAt: '2026-11-09T00:00:00.000Z' }], {
      home,
    });
    assert.equal(wrotePlain.ok, true);
    const again = await readProjectIndex({ home });
    assert.deepEqual(again.projects[0]?.stalePaths, []);
  });
});

test('S2 索引优先：索引与 sidecar 冲突时只认索引，不合并', async () => {
  await withHome(async ({ home }) => {
    const projectPath = path.join(home, 'moved');
    await fs.mkdir(projectPath, { recursive: true });
    const fromIndex = path.join(home, 'index-old');
    await writeProjectIndex(
      [{ path: projectPath, name: 'moved', openedAt: '2026-11-09T01:00:00.000Z', stalePaths: [fromIndex] }],
      { home },
    );
    await writeSidecar(home, path.join(home, 'sidecar-old'));

    const stale = await readStalePaths({ home });
    assert.equal(stale.source, 'index');
    assert.equal(stale.entries.length, 1);
    assert.equal(stale.entries[0]?.oldPath, fromIndex);
    assert.equal(stale.entries[0]?.newPath, projectPath);
  });
});

test('S3 损坏 sidecar 不影响读：无索引时返回空，有索引时照旧用索引', async () => {
  await withHome(async ({ home }) => {
    await fs.writeFile(stalePathFile(home), '{ not json', 'utf8');

    const empty = await readStalePaths({ home });
    assert.deepEqual(empty.entries, []);
    assert.equal(empty.source, 'sidecar');

    const projectPath = path.join(home, 'proj2');
    await fs.mkdir(projectPath, { recursive: true });
    await writeProjectIndex(
      [{ path: projectPath, name: 'proj2', openedAt: '2026-11-09T02:00:00.000Z', stalePaths: ['/old/x'] }],
      { home },
    );
    const viaIndex = await readStalePaths({ home });
    assert.equal(viaIndex.source, 'index');
    assert.deepEqual(
      viaIndex.entries.map((entry) => entry.oldPath),
      ['/old/x'],
    );
  });
});
