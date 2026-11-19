/**
 * P10-A6：CLI `export start --audio-spec` 透传音频时间线。
 *
 * 真实 RenderQueue + 真实 ffmpeg（1 秒 320x180），没有 mock 渲染器。
 * `resolveAudio` 故意返回 null：只有 audioMix 真的透传到队列，作业才可能成功。
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
import { probeMedia } from '../../render/verify.mjs';

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
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-cli-audio-'));
  project = path.join(workDir, 'proj');
  framesDir = path.join(workDir, 'frames');
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(framesDir, { recursive: true });
  await fs.copyFile(FILM, path.join(project, 'film.html'));
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', BARS, '-vf', 'scale=320:180', '-frames:v', '30', '-vsync', '0',
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

/** @param {RenderQueue} queue */
function makeCli(queue) {
  return createCli({
    render: {
      start: (/** @type {any} */ spec, /** @type {any} */ opts) => queue.enqueue(spec, opts),
      status: (/** @type {string} */ jobId) => queue.progress(jobId),
      cancel: (/** @type {string} */ jobId) => queue.cancel(jobId),
    },
    root: workDir,
    cwd: workDir,
    stateDir: path.join(workDir, '.state'),
    log: () => {},
  });
}

/** @param {string} file @param {any} value */
async function writeJson(file, value) {
  const abs = path.join(workDir, file);
  await fs.writeFile(abs, JSON.stringify(value, null, 2));
  return abs;
}

test('P10-A6 export start --audio-spec：透传、产物有音轨、双流同长', async () => {
  const outputDir = path.join(workDir, 'out-audio');
  const expectedHash = await hashProject(project);
  const queue = new RenderQueue({
    resolveProject: () => project,
    resolveFrameSource: () => ({ dir: framesDir, pattern: 'frame-%05d.png', width: 320, height: 180, fps: 30, durationSec: 1 }),
    // 故意没有现成音轨：只有 audioMix 生效才能出带声产物
    resolveAudio: () => null,
    preset: 'ultrafast',
    crf: 28,
  });

  const spec = await writeJson('spec-audio.json', {
    jobId: 'job-audio',
    projectId: 'proj',
    owner: 'SUB2',
    kind: 'video',
    range: [0, 1],
    fps: 30,
    audio: true,
    outputDir,
    expectedHash,
  });
  const audioSpec = await writeJson('audio-audio.json', {
    duration: 1,
    sampleRate: 48000,
    clips: [
      { src: TONE, at: 0, volume: 0.6 },
      { src: TONE, at: 0.2, volume: 0.4, fade: [0.1, 0.1] },
    ],
  });

  const cli = makeCli(queue);
  const stdout = sink();
  const code = await cli.run(['export', 'start', 'proj', '--spec', spec, '--audio-spec', audioSpec, '--json'], {
    stdout,
    stderr: sink(),
  });
  assert.equal(code, 0, stdout.text);
  const payload = JSON.parse(stdout.text);
  assert.equal(payload.jobId, 'job-audio');
  assert.deepEqual(payload.audio, { clips: 2, durationSec: 1 });

  await queue.idle();
  const progress = queue.progress('job-audio');
  assert.equal(progress.state, 'done', JSON.stringify(progress));
  assert.deepEqual(progress.audio, { clips: 2, durationSec: 1, peak: progress.audio?.peak });

  const result = await queue.result('job-audio');
  const probe = await probeMedia(/** @type {any} */ (result).path);
  assert.ok(probe.audio, 'output has no audio stream');
  assert.ok(Math.abs((probe.video?.durationSec ?? 0) - 1) <= 0.0334, `video ${probe.video?.durationSec}`);
  assert.ok(Math.abs((probe.audio?.durationSec ?? 0) - 1) <= 0.0334, `audio ${probe.audio?.durationSec}`);
  assert.ok(
    Math.abs((probe.video?.durationSec ?? 0) - (probe.audio?.durationSec ?? 0)) <= 0.0334,
    'stream durations must match',
  );
});

test('P10-A6 错误 audio-spec：明确码（INVALID），不静默忽略', async () => {
  const expectedHash = await hashProject(project);
  const queue = new RenderQueue({
    resolveProject: () => project,
    resolveFrameSource: () => ({ dir: framesDir, pattern: 'frame-%05d.png', width: 320, height: 180, fps: 30, durationSec: 1 }),
    resolveAudio: () => TONE,
    preset: 'ultrafast',
  });
  const spec = await writeJson('spec-bad-audio.json', {
    jobId: 'job-bad-audio',
    projectId: 'proj',
    owner: 'SUB2',
    kind: 'video',
    range: [0, 1],
    fps: 30,
    outputDir: path.join(workDir, 'out-bad-audio'),
    expectedHash,
  });
  const audioSpec = await writeJson('audio-bad.json', {
    duration: 1,
    clips: [{ src: TONE, at: 0, volume: 1, nope: true }],
  });

  const cli = makeCli(queue);
  const stdout = sink();
  const code = await cli.run(['export', 'start', 'proj', '--spec', spec, '--audio-spec', audioSpec, '--json'], {
    stdout,
    stderr: sink(),
  });
  assert.notEqual(code, 0);
  const payload = JSON.parse(stdout.text);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'INVALID');
  assert.match(payload.error.message, /audioMix/);
});
