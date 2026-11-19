/**
 * WP18 A9：`export start|status|cancel` 与既有作业 API 一致，取消不留残件。
 *
 * 这里用**真实的** `RenderQueue` + 真实 ffmpeg（3 秒素材里截 0.5 秒），
 * 没有 mock 渲染器：验收要的正是"CLI 只是外壳，语义仍由 WP10 的队列决定"。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createCli } from '../index.mjs';
import { RenderQueue, hashProject } from '../../render/job.mjs';

const execFileAsync = promisify(execFile);
const ROOT = new URL('../../../', import.meta.url).pathname;
const BARS = path.join(ROOT, 'tests/fixtures/media/bars-3s-720p30.mp4');
const TONE = path.join(ROOT, 'tests/fixtures/media/tone-1khz-3s.wav');
const FILM = path.join(ROOT, 'contracts/fixtures/film-v12.html');

/** @type {string} */
let workDir;
/** @type {string} */
let project;
/** @type {string} */
let framesDir;

before(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-cli-export-'));
  project = path.join(workDir, 'proj');
  framesDir = path.join(workDir, 'frames');
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(framesDir, { recursive: true });
  await fs.copyFile(FILM, path.join(project, 'film.html'));
  await execFileAsync('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    BARS,
    '-frames:v',
    '15',
    '-vsync',
    '0',
    path.join(framesDir, 'frame-%05d.png'),
  ]);
});

after(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

/** @returns {{ write: (chunk: string) => void, text: string }} */
function sink() {
  /** @type {string[]} */
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(chunk);
    },
    get text() {
      return chunks.join('');
    },
  };
}

/**
 * @param {RenderQueue} queue
 * @param {Record<string, any>} [extra]
 */
function renderPort(queue, extra = {}) {
  return {
    start: (/** @type {any} */ spec) => queue.enqueue(spec),
    status: (/** @type {string} */ jobId) => queue.progress(jobId),
    cancel: (/** @type {string} */ jobId) => queue.cancel(jobId),
    ...extra,
  };
}

/**
 * @param {string} name
 * @param {RenderQueue} queue
 * @param {{ stateDir?: string }} [opts]
 */
function makeCli(name, queue, opts = {}) {
  return createCli({
    render: renderPort(queue),
    root: workDir,
    cwd: workDir,
    stateDir: opts.stateDir ?? path.join(workDir, '.state'),
    log: () => {},
  });
}

/**
 * @param {string} file
 * @param {Record<string, any>} spec
 * @returns {Promise<string>}
 */
async function writeSpec(file, spec) {
  const abs = path.join(workDir, file);
  await fs.writeFile(abs, JSON.stringify(spec, null, 2));
  return abs;
}

test('A9 export start → status → done：产物落地且无 .partial', async () => {
  const outputDir = path.join(workDir, 'out-ok');
  const expectedHash = await hashProject(project);
  const queue = new RenderQueue({
    resolveProject: () => project,
    resolveFrameSource: () => ({ dir: framesDir, pattern: 'frame-%05d.png', width: 1280, height: 720, fps: 30, durationSec: 3 }),
    resolveAudio: () => TONE,
    preset: 'ultrafast',
    crf: 28,
  });

  const spec = await writeSpec('spec-ok.json', {
    jobId: 'job-ok',
    projectId: 'proj',
    owner: 'SUB2',
    kind: 'video',
    range: [0, 0.5],
    fps: 30,
    audio: true,
    outputDir,
    expectedHash,
  });

  const cli = makeCli('ok', queue);
  const started = sink();
  assert.equal(await cli.run(['export', 'start', 'proj', '--spec', spec, '--json'], { stdout: started, stderr: sink() }), 0);
  const startPayload = JSON.parse(started.text);
  assert.equal(startPayload.jobId, 'job-ok');

  const statusNow = sink();
  assert.equal(await cli.run(['export', 'status', 'job-ok', '--json'], { stdout: statusNow, stderr: sink() }), 0);
  assert.ok(['waiting', 'running', 'done'].includes(JSON.parse(statusNow.text).state));

  await queue.idle();

  const done = sink();
  assert.equal(await cli.run(['export', 'status', 'job-ok', '--json'], { stdout: done, stderr: sink() }), 0);
  const progress = JSON.parse(done.text);
  assert.equal(progress.state, 'done');
  assert.equal(progress.framesTotal, 15);
  assert.deepEqual(progress, { ok: true, ...queue.progress('job-ok') }, 'CLI 不得改写队列的进度语义');

  const files = await fs.readdir(outputDir);
  const mp4 = files.filter((/** @type {string} */ f) => f.endsWith('.mp4'));
  assert.equal(mp4.length, 1);
  assert.ok(!files.some((/** @type {string} */ f) => f.includes('.partial')), `partial left behind: ${files.join(',')}`);
  const stat = await fs.stat(path.join(outputDir, /** @type {string} */ (mp4[0])));
  assert.ok(stat.size > 0);
});

test('A9 export cancel（running）→ cancelled，且不留残件', async () => {
  const outputDir = path.join(workDir, 'out-cancel');
  const expectedHash = await hashProject(project);
  const frame = await fs.readFile(path.join(framesDir, 'frame-00001.png'));

  const queue = new RenderQueue({
    resolveProject: () => project,
    // 每帧 40ms：够慢，能在 running 中途取消
    resolveFrameSource: () => ({
      width: 1280,
      height: 720,
      fps: 30,
      durationSec: 3,
      frameAt: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return frame;
      },
    }),
    resolveAudio: () => null,
    preset: 'ultrafast',
  });

  const spec = await writeSpec('spec-cancel.json', {
    jobId: 'job-cancel',
    projectId: 'proj',
    owner: 'SUB2',
    kind: 'video',
    range: [0, 0.5],
    fps: 30,
    audio: false,
    outputDir,
    expectedHash,
  });

  const cli = makeCli('cancel', queue);
  const started = sink();
  assert.equal(await cli.run(['export', 'start', 'proj', '--spec', spec], { stdout: started, stderr: sink() }), 0);
  assert.equal(started.text.trim(), 'JOB job-cancel');

  // 等它真的跑起来
  for (let i = 0; i < 100; i += 1) {
    if (queue.progress('job-cancel').state === 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(queue.progress('job-cancel').state, 'running');

  const cancelled = sink();
  assert.equal(await cli.run(['export', 'cancel', 'job-cancel', '--json'], { stdout: cancelled, stderr: sink() }), 0);
  const payload = JSON.parse(cancelled.text);
  assert.equal(payload.state, 'cancelled');

  const files = await fs.readdir(outputDir).catch(() => []);
  assert.deepEqual(files, [], `cancel left files behind: ${files.join(',')}`);

  // 未知作业 → NOT_FOUND（不能把"没这个作业"演成"渲染失败"）
  const missing = sink();
  assert.equal(await cli.run(['export', 'status', 'nope', '--json'], { stdout: missing, stderr: sink() }), 5);
  assert.equal(JSON.parse(missing.text).error.code, 'NOT_FOUND');
});
