import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createContext } from '../../../cli/ops.mjs';
import { createTools } from '../../../mcp/tools.mjs';
import { canonicalProjectDirectory } from '../project-identity.mjs';
import { projectIdFor } from '../project-create.mjs';
import { recordProjectOpen } from '../project-index.mjs';
import { startStudio } from '../studio-server.mjs';
import { getJson, makeProject, postJson } from './helpers.mjs';

/** @typedef {import('../../../../contracts/events.ts').StudioEvent} StudioEvent */

test('Agent opens the exact known project across duplicate names without transferring its grant', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'motioncut-navigation-'));
  const origin = await makeProject('同名项目');
  const target = await makeProject('同名项目');
  const studio = await startStudio({ port: 0, vitePort: 0, home, projectsRoot: origin.root, logger() {} });
  t.after(async () => {
    await studio.close();
    await Promise.all([rm(home, { recursive: true, force: true }), origin.cleanup(), target.cleanup()]);
  });
  await recordProjectOpen({ path: target.dir }, { home });
  const open = await postJson(`${studio.url}/api/projects/open`, { dir: origin.dir });
  assert.equal(open.status, 200);
  const sourceId = open.body.project.projectId;
  const targetId = projectIdFor(target.dir);
  assert.notEqual(sourceId, targetId);
  assert.equal(studio.registry.get(targetId), null, 'the target starts closed');
  const originalFilm = await readFile(origin.filmPath);
  const targetFilm = await readFile(target.filmPath);
  let turn = 'turn-a';
  Object.assign(studio.acpAgent, {
    sessionState: () => ({ alive: true }),
    turnOf: () => turn,
  });
  const grant = studio.grants.issue({
    tools: ['project_navigation_list', 'project_open', 'film_apply_ops'],
    projectId: sourceId,
    projectPath: origin.dir,
    sessionId: 'session-a',
    runId: 'run-a',
    requestId: turn,
  });
  const ctx = createContext({ root: origin.dir, cwd: origin.dir, stateDir: home, log() {} });
  const studioBridge = { baseUrl: studio.url, grantId: grant.grantId, projectId: sourceId };
  const tools = createTools(ctx, { studio: studioBridge, allowWrite: true });
  const list = tools.find(tool => tool.name === 'project_navigation_list');
  const navigate = tools.find(tool => tool.name === 'project_open');
  assert.ok(list && navigate);
  /** @type {{projects: Array<{ projectId: string, name: string, path: string }>}} */
  const catalog = await list.run({});
  assert.deepEqual(catalog.projects.map(p => p.projectId).sort(), [sourceId, targetId].sort());
  assert.equal(catalog.projects[0]?.name, catalog.projects[1]?.name);
  assert.equal(catalog.projects.find(p => p.projectId === targetId)?.path, canonicalProjectDirectory(target.dir));
  await assert.rejects(navigate.run({ projectId: targetId }), { code: 'E_CONFIRM_REQUIRED' });
  await assert.rejects(navigate.run({ projectId: '同名项目', confirm: true }), { code: 'NOT_FOUND' });

  /** @type {StudioEvent[]} */
  const events = [];
  studio.hub.subscribe({ send: envelope => events.push(envelope.event) });
  const beforeEvent = studio.hub.seq;
  const requested = await navigate.run({ projectId: targetId, confirm: true });
  assert.equal(requested.project.projectId, targetId);
  assert.equal(requested.navigationRequested, true);
  assert.deepEqual(events.filter(event => event.type === 'agent.projectOpen'), [
    { type: 'agent.projectOpen', projectId: sourceId, targetProjectId: targetId },
  ]);
  /** @type {StudioEvent[]} */
  const replay = [];
  const listener = studio.hub.subscribe({ since: beforeEvent, send: envelope => replay.push(envelope.event) });
  listener.unsubscribe();
  assert.ok(replay.every(event => event.type !== 'agent.projectOpen'));
  const siblingScope = createTools(ctx, { studio: { ...studioBridge, projectId: targetId } });
  const siblingList = siblingScope.find(tool => tool.name === 'project_navigation_list');
  assert.ok(siblingList);
  await assert.rejects(siblingList.run({}), { code: 'PROJECT_MISMATCH' });
  assert.equal(studio.grants.get(grant.grantId)?.projectId, sourceId);
  turn = 'next-turn';
  await assert.rejects(navigate.run({ projectId: targetId, confirm: true }), { code: 'REQUEST_MISMATCH' });
  assert.deepEqual(await readFile(origin.filmPath), originalFilm);
  assert.deepEqual(await readFile(target.filmPath), targetFilm);
});

test('simultaneous normal and alias opens allocate one queue and one history row', async (t) => {
  const project = await makeProject('original');
  const other = await makeProject('other');
  const home = await mkdtemp(join(tmpdir(), 'motioncut-project-alias-'));
  const alias = join(project.root, 'alias');
  await symlink(project.dir, alias);
  const studio = await startStudio({ port: 0, vitePort: 0, home, projectsRoot: project.root, logger() {} });
  t.after(async () => {
    await studio.close();
    await Promise.all([project.cleanup(), other.cleanup(), rm(home, { recursive: true, force: true })]);
  });
  const endpoint = `${studio.url}/api/projects/open`;
  const [first, second, third] = await Promise.all([
    postJson(endpoint, { dir: alias }),
    postJson(endpoint, { dir: project.dir }),
    postJson(endpoint, { dir: other.dir }),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(third.status, 200);
  assert.equal(first.body.project.projectId, second.body.project.projectId);
  assert.notEqual(first.body.project.projectId, third.body.project.projectId);
  assert.deepEqual([first.body.existing, second.body.existing].sort(), [false, true]);
  assert.equal(studio.registry.stats().queuesCreated, 2);
  const projects = await getJson(`${studio.url}/api/projects`);
  assert.equal(projects.body.projects.length, 1);
  assert.deepEqual(projects.body.recent.map((/** @type {{path: string}} */ item) => item.path).sort(),
    [canonicalProjectDirectory(project.dir), canonicalProjectDirectory(other.dir)].sort());
  const removed = await postJson(`${studio.url}/api/projects/recent/remove`, { path: alias });
  assert.equal(removed.body.removed, true);
  assert.equal((await getJson(`${studio.url}/api/projects`)).body.recent.length, 1);
});

test('explicit export accepts an alias of the same project and rejects destinations outside it', async (t) => {
  const project = await makeProject('export');
  const home = await mkdtemp(join(tmpdir(), 'motioncut-export-alias-'));
  const alias = join(project.root, 'alias');
  await symlink(project.dir, alias);
  await symlink(home, join(project.dir, 'outside'));
  await symlink(join(home, 'missing'), join(project.dir, 'dangling'));
  const studio = await startStudio({
    port: 0,
    vitePort: 0,
    home,
    logger() {},
    exportRunner: async () => { throw new Error('No media encoding needed to verify output routing'); },
  });
  t.after(async () => {
    await studio.close();
    await Promise.all([project.cleanup(), rm(home, { recursive: true, force: true })]);
  });
  const opened = await postJson(`${studio.url}/api/projects/open`, { dir: alias });
  assert.equal(opened.status, 200);
  const projectId = opened.body.project.projectId;
  const endpoint = `${studio.url}/api/export`;
  for (const outPath of [
    join(home, 'reject.mp4'),
    join(alias, 'outside', 'reject.mp4'),
    join(alias, 'dangling', 'reject.mp4'),
  ]) {
    const result = await postJson(endpoint, { projectId, outPath });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'E_PATH_ESCAPE');
  }
  const result = await postJson(endpoint, { projectId, outPath: join(alias, 'exports', 'preview.mp4') });
  assert.equal(result.status, 202, JSON.stringify(result.body));
  assert.equal(result.body.job.targetPath, join(canonicalProjectDirectory(project.dir), 'exports', 'preview.mp4'));
});
