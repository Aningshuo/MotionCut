import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { RenderQueue, hashProject } from '../job.mjs';
import { createExportsApi } from '../../studio/server/exports.mjs';

const execFileAsync = promisify(execFile);
const ROOT = new URL('../../../', import.meta.url).pathname;
const BARS = path.join(ROOT, 'tests/fixtures/media/bars-3s-720p30.mp4');
const TONE = path.join(ROOT, 'tests/fixtures/media/tone-1khz-3s.wav');
const FILM = path.join(ROOT, 'contracts/fixtures/film-v12.html');

/** @type {string} */
let workDir;
/** @type {string} */
let framesDir;
/** @type {string} */
let project;

before(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exports-test-'));
  framesDir = path.join(workDir, 'frames');
  project = path.join(workDir, 'project');
  await fs.mkdir(framesDir, { recursive: true });
  await fs.mkdir(project, { recursive: true });
  await fs.copyFile(FILM, path.join(project, 'film.html'));
  await execFileAsync('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    BARS,
    '-vsync',
    '0',
    path.join(framesDir, 'frame-%05d.png'),
  ]);
});

after(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

/**
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
async function startApi() {
  const queue = new RenderQueue({
    resolveProject: () => project,
    resolveFrameSource: () => ({
      dir: framesDir,
      pattern: 'frame-%05d.png',
      width: 1280,
      height: 720,
      fps: 30,
      durationSec: 3,
    }),
    resolveAudio: () => TONE,
    preset: 'medium',
  });
  const api = createExportsApi({ queue, port: 0 });

  // 端口由内核分配：集成树里三条线的测试会同时跑，写死 59375..59377 必然撞车。
  // 产品侧端口仍由 .local-runs/sub2/env.json 固定（不漂移），这里只测 API 行为。
  const bound = await api.listen({ port: 0 });
  return {
    url: `http://127.0.0.1:${bound.port}`,
    close: () => api.close(),
  };
}

test('exports API：POST/GET/DELETE + 未知字段拒绝', async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  const expectedHash = await hashProject(project);
  const outputDir = path.join(workDir, 'out-api');

  /** @type {any} */
  const spec = {
    projectId: 'proj-api',
    owner: 'SUB2',
    kind: 'video',
    range: [0, 3],
    fps: 30,
    outputDir,
    expectedHash,
  };

  // 未知字段：400，不静默忽略。
  const unknown = await fetch(`${api.url}/exports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...spec, jobId: 'api-unknown', bogusField: 1 }),
  });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error, 'UNKNOWN_FIELD');

  // 非法区间：400。
  const invalid = await fetch(`${api.url}/exports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...spec, jobId: 'api-invalid', range: [10, 5] }),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, 'INVALID_RANGE');

  // 正常作业：202 → 轮询到 done。
  const created = await fetch(`${api.url}/exports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...spec, jobId: 'api-1' }),
  });
  assert.equal(created.status, 202);
  assert.deepEqual(await created.json(), { jobId: 'api-1', state: 'waiting' });

  /** @type {any} */
  let progress;
  for (let i = 0; i < 300; i += 1) {
    const res = await fetch(`${api.url}/exports/api-1`);
    assert.equal(res.status, 200);
    progress = await res.json();
    if (progress.state === 'done' || progress.state === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(progress.state, 'done');
  assert.equal(progress.framesTotal, 90);
  assert.equal(progress.framesDone, 90);

  // 404
  const missing = await fetch(`${api.url}/exports/nope`);
  assert.equal(missing.status, 404);

  // DELETE 取消 waiting 的作业。
  const second = await fetch(`${api.url}/exports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...spec, jobId: 'api-2', outputDir: path.join(workDir, 'out-api-2') }),
  });
  assert.equal(second.status, 202);
  const cancelled = await fetch(`${api.url}/exports/api-2`, { method: 'DELETE' });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).state, 'cancelled');

  const files = await fs.readdir(path.join(workDir, 'out-api-2')).catch(() => []);
  assert.deepEqual(files, []);

  // budget 是合同字段：能透传，并在 progress 里如实回显 source='user'。
  const budgeted = await fetch(`${api.url}/exports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...spec,
      jobId: 'api-budget',
      budget: { workers: 2 },
      outputDir: path.join(workDir, 'out-api-budget'),
    }),
  });
  assert.equal(budgeted.status, 202);
  /** @type {any} */
  let budgetProgress;
  for (let i = 0; i < 300; i += 1) {
    const res = await fetch(`${api.url}/exports/api-budget`);
    budgetProgress = await res.json();
    if (budgetProgress.state === 'done' || budgetProgress.state === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(budgetProgress.state, 'done');
  assert.deepEqual(budgetProgress.budget, { source: 'user', workers: 2 });

  // 非法 budget 直接 400，不静默忽略。
  const badBudget = await fetch(`${api.url}/exports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...spec, jobId: 'api-bad-budget', budget: { workers: 0 } }),
  });
  assert.equal(badBudget.status, 400);
});
