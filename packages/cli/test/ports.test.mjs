// @ts-nocheck —— 端口返回的是 `any`（film-core 没有 TS 声明）；断言在运行期，产品模块仍由 tsc 严格检查。
// M74：真实 film / projects 端口（`packages/cli/ports/*`）。
//
// 这两个模块是 CLI 与 MCP 唯一的「接真实 film-core」的缝；以前只有测试桩，
// 这里把「读 / 写 / CAS / 不重复写 / 原子写 / 错误码」钉住，免得接线层悄悄漂移。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createFilmPort } from '../ports/film-core.mjs';
import { createProjectsPort } from '../ports/projects-index.mjs';

const FILM = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>M74 端口夹具</title></head>
<body>
<section id="v1">
  <video id="a" src="assets/bars.mp4#t=0,3" at="0" style="left:0px;top:0px;width:320px;height:180px"></video>
</section>
</body>
</html>
`;

/** @param {string|Buffer} value */
const sha = (value) => createHash('sha256').update(value).digest('hex');

/** @param {(ctx: {root: string, project: string}) => Promise<void>} fn */
async function withProject(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-m74-port-'));
  const project = path.join(root, 'proj');
  try {
    await fs.mkdir(path.join(project, 'assets'), { recursive: true });
    await fs.writeFile(path.join(project, 'film.html'), FILM, 'utf8');
    await fs.writeFile(path.join(project, 'assets', 'bars.mp4'), 'not-a-real-mp4', 'utf8');
    await fn({ root, project });
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/** @param {string} project */
async function currentHash(project) {
  return sha(await fs.readFile(path.join(project, 'film.html')));
}

test('读：返回 sourceHash 与解析后的 doc，diagnostics 为空', async () => {
  await withProject(async ({ project }) => {
    const port = createFilmPort({});
    const read = await port.read(project);
    assert.equal(read.ok, true);
    assert.equal(read.sourceHash, await currentHash(project));
    assert.equal(read.doc.tracks.length, 1);
    assert.equal(read.doc.tracks[0].clips[0].id, 'a');
    assert.deepEqual(read.diagnostics, []);
  });
});

test('写：applyOps 落盘，hash 与磁盘一致，touched 含目标片段', async () => {
  await withProject(async ({ project }) => {
    const port = createFilmPort({});
    const before = await port.read(project);
    const applied = await port.applyOps(
      project,
      { opId: 'op-1', expectedHash: before.sourceHash },
      [{ op: 'set', clip: 'a', field: 'at', value: 2 }],
    );
    assert.equal(applied.ok, true);
    assert.equal(applied.changed, true);
    assert.deepEqual(applied.touched, ['a']);
    assert.equal(applied.hash, await currentHash(project));
    const reread = await port.read(project);
    assert.equal(reread.doc.tracks[0].clips[0].at, 2);
  });
});

test('不重复写：同一 Op 第二次内容未变 → changed:false，mtime 不动', async () => {
  await withProject(async ({ project }) => {
    const port = createFilmPort({});
    const first = await port.read(project);
    const ops = [{ op: 'set', clip: 'a', field: 'at', value: 2 }];
    const one = await port.applyOps(project, { opId: 'op-1', expectedHash: first.sourceHash }, ops);
    assert.equal(one.changed, true);
    const statAfterFirst = await fs.stat(path.join(project, 'film.html'));

    const two = await port.applyOps(project, { opId: 'op-2', expectedHash: one.hash }, ops);
    assert.equal(two.ok, true);
    assert.equal(two.hash, one.hash);
    assert.equal(two.changed, false);
    const statAfterSecond = await fs.stat(path.join(project, 'film.html'));
    assert.equal(statAfterSecond.mtimeMs, statAfterFirst.mtimeMs, '内容没变就不该碰文件');
  });
});

test('CAS：expectedHash 过期 → CONFLICT，磁盘不动', async () => {
  await withProject(async ({ project }) => {
    const port = createFilmPort({});
    const before = await currentHash(project);
    const result = await port.applyOps(
      project,
      { opId: 'op-1', expectedHash: 'f'.repeat(64) },
      [{ op: 'set', clip: 'a', field: 'at', value: 2 }],
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'CONFLICT');
    assert.equal(result.error.currentHash, before);
    assert.equal(await currentHash(project), before);
  });
});

test('错误码：缺文件 NOT_FOUND、坏文件 INVALID_FILM、Op 不合法 INVALID', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-m74-port-'));
  try {
    const port = createFilmPort({});
    const missing = await port.read(path.join(root, 'nope'));
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'NOT_FOUND');

    const bad = path.join(root, 'bad');
    await fs.mkdir(bad, { recursive: true });
    await fs.writeFile(path.join(bad, 'film.html'), '<!doctype html><html><body><div>x</div></body></html>', 'utf8');
    const parsed = await port.read(bad);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, 'INVALID_FILM');

    await withProject(async ({ project }) => {
      const before = await port.read(project);
      const broken = await port.applyOps(project, { opId: 'op-1', expectedHash: before.sourceHash }, [
        { op: 'set', clip: 'ghost', field: 'at', value: 1 },
      ]);
      assert.equal(broken.ok, false);
      assert.equal(broken.error.code, 'NOT_FOUND');
      assert.equal(await currentHash(project), before.sourceHash, '失败的 Op 不许留半截写');
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('原子写：目录里不留 .tmp-*（写入失败也不留）', async () => {
  await withProject(async ({ project }) => {
    const port = createFilmPort({});
    const before = await port.read(project);
    await port.applyOps(project, { opId: 'op-1', expectedHash: before.sourceHash }, [
      { op: 'set', clip: 'a', field: 'at', value: 1 },
    ]);
    const names = await fs.readdir(project);
    assert.equal(names.filter((name) => name.includes('.tmp-')).length, 0);
  });
});

test('projects 端口：索引里只列 root 内的工程，id 与 Studio 同算法', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-m74-idx-'));
  const home = path.join(root, 'home');
  try {
    const inside = path.join(root, 'inside');
    const outside = path.join(root, '..', `opencut-m74-outside-${process.pid}`);
    await fs.mkdir(inside, { recursive: true });
    await fs.mkdir(path.join(home, '.opencut'), { recursive: true });
    await fs.writeFile(
      path.join(home, '.opencut', 'projects.json'),
      `${JSON.stringify(
        {
          version: 1,
          projects: [
            { path: inside, name: 'in', openedAt: '2026-11-09T00:00:00.000Z', stalePaths: [] },
            { path: outside, name: 'out', openedAt: '2026-11-09T00:00:01.000Z', stalePaths: [] },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const port = createProjectsPort({ root, env: { home } });
    const rows = await port.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'in');
    const real = await fs.realpath(inside);
    assert.equal(rows[0].path, real);
    assert.equal(rows[0].id, sha(path.resolve(inside)).slice(0, 16));

    // 索引不存在 = 空列表，不是错误。
    const empty = createProjectsPort({ root, env: { home: path.join(root, 'nohome') } });
    assert.deepEqual(await empty.list(), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
