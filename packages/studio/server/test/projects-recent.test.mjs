// @ts-nocheck
/**
 * M56 服务端验收：`GET /api/projects` 的 `recent` 字段 + 打开后写索引。
 *
 * 覆盖：
 *  - 初始 recent = []；
 *  - 打开两个工程后 recent 两条、倒序（后开的在前）；
 *  - recent 条目带 path/name/openedAt，path 是绝对路径；
 *  - 重复打开同一个工程不新增条目，只置顶；
 *  - 索引文件落在注入的 home 下，不碰真实 ~/.opencut。
 *
 * 跑法：`node --test packages/studio/server/test/projects-recent.test.mjs`
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { startStudio } from '../studio-server.mjs';
import { canonicalProjectDirectory } from '../project-identity.mjs';
import { getJson, makeProject, postJson } from './helpers.mjs';

const quietLogger = () => undefined;

let studio;
let home;
let alpha;
let beta;

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'opencut-recent-home-'));
  alpha = await makeProject('alpha');
  beta = await makeProject('beta');
  studio = await startStudio({
    port: 0,
    vitePort: 59371,
    home,
    projectsRoot: alpha.root,
    thumbnailTimeoutMs: 100,
    logger: quietLogger,
  });
});

after(async () => {
  await studio?.close?.();
  await alpha?.cleanup?.();
  await beta?.cleanup?.();
  await rm(home, { recursive: true, force: true });
});

test('M56-A1 初始 recent 为空数组', async () => {
  const listed = await getJson(`${studio.url}/api/projects`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.recent, []);
  assert.equal(listed.body.recentCorrupt, false);
});

test('M56-A2 打开两个工程后 recent 两条、后开的在前', async () => {
  const first = await postJson(`${studio.url}/api/projects/open`, { dir: alpha.dir });
  assert.equal(first.status, 200);
  const second = await postJson(`${studio.url}/api/projects/open`, { dir: beta.dir });
  assert.equal(second.status, 200);

  const listed = await getJson(`${studio.url}/api/projects`);
  const recent = listed.body.recent;
  assert.equal(recent.length, 2);
  assert.equal(recent[0].path, canonicalProjectDirectory(beta.dir));
  assert.equal(recent[1].path, canonicalProjectDirectory(alpha.dir));
  assert.ok(recent[0].name && typeof recent[0].name === 'string');
  assert.ok(Date.parse(recent[0].openedAt) > Date.parse(recent[1].openedAt));
});

test('M56-A3 重复打开同一工程：不新增，只置顶', async () => {
  await postJson(`${studio.url}/api/projects/open`, { dir: alpha.dir });
  const listed = await getJson(`${studio.url}/api/projects`);
  const recent = listed.body.recent;
  assert.equal(recent.length, 2);
  assert.equal(recent[0].path, canonicalProjectDirectory(alpha.dir));
  assert.equal(recent[1].path, canonicalProjectDirectory(beta.dir));
});

test('M56-A4 索引落在注入的 home，不碰真实用户目录', async () => {
  const raw = await readFile(join(home, '.opencut', 'projects.json'), 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.projects.length, 2);
});

test('M56-A5 film.html 被删 → missing=true，只标记不移除', async () => {
  const { rm } = await import('node:fs/promises');
  await rm(join(beta.dir, 'film.html'), { force: true });
  const listed = await getJson(`${studio.url}/api/projects`);
  const recent = listed.body.recent;
  const betaItem = recent.find((item) => item.path === canonicalProjectDirectory(beta.dir));
  const alphaItem = recent.find((item) => item.path === canonicalProjectDirectory(alpha.dir));
  assert.equal(betaItem?.missing, true);
  assert.equal(alphaItem?.missing, false);
  assert.equal(recent.length, 2, '只标记，不自动移除');
});

test('M56-A6 POST /api/projects/recent/remove：索引少一条，磁盘目录还在', async () => {
  const before = await getJson(`${studio.url}/api/projects`);
  assert.equal(before.body.recent.length, 2);

  const removed = await postJson(`${studio.url}/api/projects/recent/remove`, { path: beta.dir });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.removed, true);

  const after = await getJson(`${studio.url}/api/projects`);
  assert.equal(after.body.recent.length, 1);
  assert.equal(after.body.recent[0].path, canonicalProjectDirectory(alpha.dir));

  // 磁盘目录仍在（只删索引）
  const { stat } = await import('node:fs/promises');
  assert.equal(await stat(beta.dir).then(() => true), true);

  // 再删一次：removed=false，不报错
  const again = await postJson(`${studio.url}/api/projects/recent/remove`, { path: beta.dir });
  assert.equal(again.status, 200);
  assert.equal(again.body.removed, false);
});
