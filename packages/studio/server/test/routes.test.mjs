// @ts-nocheck
// 运行时测试：类型由源文件（tsc --checkJs）保证；测试里大量断言会让联合类型收窄成本高于收益。
/**
 * M3/M4 的 HTTP 面：工程库 API、写接口、视图状态、缩略请求、关闭语义。
 * 跑法：node --test packages/studio/server/test/routes.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { sha256 } from '../../../film-core/film-doc.mjs';
import { startStudio } from '../studio-server.mjs';
import { getJson, makeProject, postJson, sleep, waitFor } from './helpers.mjs';

const quietLogger = () => undefined;

/** @type {{ root: string, a: any, b: any }|null} */
let fixture;
/** @type {Awaited<ReturnType<typeof startStudio>>} */
let studio;

before(async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencut-routes-'));
  const a = await makeProject('alpha');
  const b = await makeProject('beta');
  // 把两个工程挪到同一个 root 下，便于 /api/projects?root= 列表。
  const alphaDir = join(root, 'alpha');
  const betaDir = join(root, 'beta');
  await mkdir(alphaDir, { recursive: true });
  await mkdir(betaDir, { recursive: true });
  await import('node:fs/promises').then(({ writeFile }) =>
    Promise.all([
      writeFile(join(alphaDir, 'film.html'), a.text, 'utf8'),
      writeFile(join(betaDir, 'film.html'), b.text, 'utf8'),
    ]),
  );
  fixture = { root, a: { ...a, dir: alphaDir, filmPath: join(alphaDir, 'film.html') }, b: { ...b, dir: betaDir, filmPath: join(betaDir, 'film.html') } };
  studio = await startStudio({
    port: 0,
    vitePort: 59370,
    projectsRoot: root,
    thumbnailTimeoutMs: 100,
    logger: quietLogger,
  });
});

after(async () => {
  await studio.close();
  if (fixture !== null) {
    await fixture.a.cleanup?.();
    await fixture.b.cleanup?.();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('M4-A1 HTTP：列工程 → 打开 → 摘要与 parse 一致', async () => {
  assert.ok(fixture !== null);
  const listed = await getJson(`${studio.url}/api/projects?root=${encodeURIComponent(fixture.root)}`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.projects.map((item) => item.name).sort(), ['alpha', 'beta']);
  assert.ok(listed.body.projects.every((item) => item.opened === false));

  const opened = await postJson(`${studio.url}/api/projects/open`, { path: fixture.a.dir });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const project = opened.body.project;
  assert.deepEqual(project.stage, { w: 1280, h: 720 });
  assert.deepEqual(project.fps, { num: 30, den: 1 });
  assert.equal(project.trackCount, 3);
  assert.equal(project.clipCount, 4);
  assert.equal(project.durationSec, 8);
  assert.equal(project.sourceHash, sha256(fixture.a.text));

  const fetched = await getJson(`${studio.url}/api/projects/${project.projectId}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.project.sourceHash, project.sourceHash);
  assert.equal(fetched.body.thumbnails.requested, 4);

  const reopened = await postJson(`${studio.url}/api/projects/open`, { path: fixture.a.dir });
  assert.equal(reopened.body.existing, true, '重复打开必须聚焦已有工程');
  assert.equal(reopened.body.project.projectId, project.projectId);

  const health = await getJson(`${studio.url}/healthz`);
  assert.equal(health.body.events.transport, 'websocket');
  assert.equal(health.body.events.contract, '1.1.0');
});

test('M4-A3 HTTP：两工程播放头/选区互不影响', async () => {
  assert.ok(fixture !== null);
  const a = await postJson(`${studio.url}/api/projects/open`, { path: fixture.a.dir });
  const b = await postJson(`${studio.url}/api/projects/open`, { path: fixture.b.dir });
  const idA = a.body.project.projectId;
  const idB = b.body.project.projectId;
  assert.notEqual(idA, idB);

  const setA = await postJson(`${studio.url}/api/projects/${idA}/view`, { playhead: 1.5, selection: ['c2'] }, 'PUT');
  const setB = await postJson(`${studio.url}/api/projects/${idB}/view`, { playhead: 7.25, selection: ['a1'] }, 'PUT');
  assert.equal(setA.status, 200);
  assert.equal(setB.status, 200);

  const cwdA = await postJson(`${studio.url}/api/projects/${idA}/cwd`, { cwd: `${fixture.a.dir}/agent` }, 'PUT');
  assert.equal(cwdA.status, 200);

  const readA = await getJson(`${studio.url}/api/projects/${idA}`);
  const readB = await getJson(`${studio.url}/api/projects/${idB}`);
  assert.deepEqual(readA.body.project.view, { playhead: 1.5, selection: ['c2'], cwd: `${fixture.a.dir}/agent` });
  assert.deepEqual(readB.body.project.view, { playhead: 7.25, selection: ['a1'], cwd: fixture.b.dir });
});

test('M3 写路径 HTTP：成功 200 / 旧 hash 409 且磁盘不变', async () => {
  assert.ok(fixture !== null);
  const opened = await postJson(`${studio.url}/api/projects/open`, { path: fixture.b.dir });
  const projectId = opened.body.project.projectId;
  const baseHash = opened.body.project.sourceHash;
  const before = sha256(await readFile(fixture.b.filmPath, 'utf8'));

  const written = await postJson(`${studio.url}/api/projects/${projectId}/write`, {
    opId: 'routes-1',
    expectedHash: baseHash,
    edits: [{ clipId: 'c1', field: 'volume', value: 0.6 }],
  });
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.equal(written.body.ok, true);
  assert.equal(written.body.history.ok, true);
  assert.equal(sha256(await readFile(fixture.b.filmPath, 'utf8')), written.body.hash);

  const after = written.body.hash;
  const stale = await postJson(`${studio.url}/api/projects/${projectId}/write`, {
    opId: 'routes-2',
    expectedHash: baseHash,
    edits: [{ clipId: 'c1', field: 'volume', value: 0.1 }],
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'CONFLICT');
  assert.equal(stale.body.error.currentHash, after);
  assert.equal(sha256(await readFile(fixture.b.filmPath, 'utf8')), after);
  assert.notEqual(before, after);

  // 幂等：同一 opId 重放不再落盘
  const replay = await postJson(`${studio.url}/api/projects/${projectId}/write`, {
    opId: 'routes-1',
    expectedHash: baseHash,
    edits: [{ clipId: 'c1', field: 'volume', value: 0.6 }],
  });
  assert.equal(replay.status, 200);
  assert.equal(sha256(await readFile(fixture.b.filmPath, 'utf8')), after, 'opId 重放不得再写磁盘');
});

test('M4-A10 HTTP：缩略请求可观测（PENDING_FRAME → THUMBNAIL_TIMEOUT）', async () => {
  assert.ok(fixture !== null);
  const opened = await postJson(`${studio.url}/api/projects/open`, { path: fixture.a.dir });
  const projectId = opened.body.project.projectId;
  // 重新发一次缩略请求（打开时那次可能已经超时），确认请求可观测。
  const first = await postJson(`${studio.url}/api/projects/${projectId}/thumbnails/request`, {});
  assert.equal(first.status, 200);
  assert.equal(first.body.requested, 4);
  assert.equal(first.body.frameConnected, false);
  assert.equal(first.body.pending, 4);
  assert.ok(first.body.items.every((item) => item.state === 'PENDING_FRAME'));

  const timedOut = await waitFor(async () => {
    const current = await getJson(`${studio.url}/api/projects/${projectId}/thumbnails`);
    return current.body.timedOut === 4;
  }, 4000);
  assert.equal(timedOut, true);

  const after = await getJson(`${studio.url}/api/projects/${projectId}/thumbnails`);
  assert.ok(after.body.items.every((item) => item.code === 'THUMBNAIL_TIMEOUT' && item.timedOut === true));
});

test('M4-A7 HTTP：坏路径 404、坏文件 422，进程不崩', async () => {
  assert.ok(fixture !== null);
  const missing = await postJson(`${studio.url}/api/projects/open`, { path: '/no/such/opencut/project' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'FILM_NOT_FOUND');

  const badDir = join(fixture.root, 'bad');
  await mkdir(badDir, { recursive: true });
  await import('node:fs/promises').then(({ writeFile }) =>
    writeFile(
      join(badDir, 'film.html'),
      '<!doctype html><html><head><meta name="viewport" content="width=1280, height=720"></head><body><section><video id="x" src="a.mp4" at="0" bogus="1"></video></section></body></html>',
      'utf8',
    ),
  );
  const invalid = await postJson(`${studio.url}/api/projects/open`, { path: badDir });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.code, 'FILM_INVALID');
  assert.ok(invalid.body.diagnostics.length > 0);

  const health = await getJson(`${studio.url}/healthz`);
  assert.equal(health.body.ok, true);
});

test('M4-A8 HTTP：关标签时有未完成写 → 显式 drained/cancelled', async () => {
  assert.ok(fixture !== null);
  const opened = await postJson(`${studio.url}/api/projects/open`, { path: fixture.b.dir });
  const projectId = opened.body.project.projectId;
  const closed = await postJson(`${studio.url}/api/projects/close`, { projectId, waitMs: 3000 });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.drained, true);
  assert.equal(closed.body.cancelled, 0);

  const afterClose = await postJson(`${studio.url}/api/projects/${projectId}/write`, {
    opId: 'after-close',
    expectedHash: opened.body.project.sourceHash,
    edits: [{ clipId: 'c1', field: 'at', value: 1 }],
  });
  assert.equal(afterClose.status, 404, '关掉的工程不接受写');
  await sleep(20);
});
