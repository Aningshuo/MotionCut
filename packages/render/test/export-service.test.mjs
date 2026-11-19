/**
 * P10（R5）验收：导出服务接音频。
 *
 * 真实 HTTP（127.0.0.1，端口 0）+ 真实 RenderQueue + 真实 ffmpeg。
 * 覆盖：新 body `{spec, audioMix}`、旧 body 回归、失败码、阶段序列、取消、
 *       临时 mix.wav 清理、两作业不串文件。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { RenderQueue, hashProject } from '../job.mjs';
import { probeMedia } from '../verify.mjs';
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
/** @type {string} */
let tmpRoot;
/** @type {string} */
let tone2;
/** @type {string} */
let longTone;
/** @type {string} */
let expectedHash;

before(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-export-service-'));
  tmpRoot = path.join(workDir, 'tmp');
  await fs.mkdir(tmpRoot, { recursive: true });
  // 让 os.tmpdir() 指向测试自己的目录：混音临时目录泄漏只可能出现在这里
  process.env.TMPDIR = tmpRoot;

  framesDir = path.join(workDir, 'frames');
  project = path.join(workDir, 'project');
  await fs.mkdir(framesDir, { recursive: true });
  await fs.mkdir(project, { recursive: true });
  await fs.copyFile(FILM, path.join(project, 'film.html'));

  // 1 秒、320x180、30fps 的帧序列（够验证作业链路，又不拖慢套件）
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', BARS, '-vf', 'scale=320:180', '-frames:v', '30', '-vsync', '0',
    path.join(framesDir, 'frame-%05d.png'),
  ]);

  tone2 = path.join(workDir, 'tone-500hz-3s.wav');
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=500:duration=3,volume=10', '-ar', '48000', '-ac', '2', tone2,
  ]);

  longTone = path.join(workDir, 'long-120s.wav');
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=120', '-ar', '48000', '-ac', '2', longTone,
  ]);

  expectedHash = await hashProject(project);
});

after(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

/**
 * @returns {Promise<{ url: string, close: () => Promise<void>, queue: RenderQueue }>}
 */
async function startApi() {
  const queue = new RenderQueue({
    resolveProject: () => project,
    resolveFrameSource: () => ({
      dir: framesDir,
      pattern: 'frame-%05d.png',
      width: 320,
      height: 180,
      fps: 30,
      durationSec: 1,
    }),
    // 旧路径（无 audioMix）用它；新路径不应碰它
    resolveAudio: () => TONE,
    preset: 'ultrafast',
  });
  const api = createExportsApi({ queue, port: 0 });
  const bound = await api.listen({ port: 0 });
  return { url: `http://127.0.0.1:${bound.port}`, close: () => api.close(), queue };
}

/**
 * @param {string} base
 * @param {any} body
 */
async function post(base, body) {
  const res = await fetch(`${base}/exports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/**
 * 轮询到终态，并收集途中出现过的 stage 序列。
 * @param {string} base
 * @param {string} jobId
 * @param {number} [timeoutMs]
 */
async function waitJob(base, jobId, timeoutMs = 60_000) {
  /** @type {string[]} */
  const stages = [];
  const deadline = Date.now() + timeoutMs;
  /** @type {any} */
  let progress;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/exports/${jobId}`);
    progress = await res.json();
    if (progress.stage && stages[stages.length - 1] !== progress.stage) stages.push(progress.stage);
    if (progress.state === 'done' || progress.state === 'failed' || progress.state === 'cancelled') break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { progress, stages };
}

/**
 * @param {string} jobId
 * @param {string} outputDir
 */
function spec(jobId, outputDir) {
  return {
    jobId,
    projectId: 'demo',
    owner: 'SUB2',
    kind: 'video',
    range: [0, 1],
    fps: 30,
    outputDir,
    expectedHash,
  };
}

/** @param {any} body */
function audioMix(body) {
  return {
    duration: 1,
    sampleRate: 48000,
    clips: [
      { src: TONE, at: 0, volume: 0.6 },
      { src: body, at: 0.25, volume: 0.4, fade: [0.1, 0.1] },
    ],
  };
}

/** @param {string} dir */
async function listMixDirs(dir) {
  const entries = await fs.readdir(dir).catch(() => []);
  return entries.filter((name) => name.startsWith('opencut-mix-')).sort();
}

// ---- P10-A1 -------------------------------------------------------------

test('P10-A1 新 body：audio 片段 → 202，作业完成且输出双流同长', async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  const outputDir = path.join(workDir, 'out-a1');

  const created = await post(api.url, { spec: spec('p10-a1', outputDir), audioMix: audioMix(tone2) });
  assert.equal(created.status, 202, JSON.stringify(created.body));
  assert.equal(created.body.jobId, 'p10-a1');
  assert.deepEqual(created.body.audio, { clips: 2, durationSec: 1 });

  const { progress, stages } = await waitJob(api.url, 'p10-a1');
  assert.equal(progress.state, 'done', JSON.stringify(progress));
  assert.ok(stages.includes('audio'), `no audio stage: ${stages.join(' -> ')}`);
  assert.ok(stages.includes('mux'), `no mux stage: ${stages.join(' -> ')}`);
  assert.ok(stages.indexOf('audio') < stages.indexOf('mux'), `stage order: ${stages.join(' -> ')}`);
  assert.deepEqual(progress.audio, { clips: 2, durationSec: 1, peak: progress.audio.peak });

  await api.queue.idle();
  const result = /** @type {any} */ (await api.queue.result('p10-a1'));
  assert.ok(result && result.path, JSON.stringify(result));
  const probe = await probeMedia(result.path);
  assert.ok(probe.audio, 'output has no audio stream');
  const videoSec = probe.video?.durationSec ?? Number.NaN;
  const audioSec = probe.audio?.durationSec ?? Number.NaN;
  assert.ok(Math.abs(videoSec - 1) <= 0.0334, `video ${videoSec}`);
  assert.ok(Math.abs(audioSec - 1) <= 0.0334, `audio ${audioSec}`);
  assert.ok(Math.abs(videoSec - audioSec) <= 0.0334, `video ${videoSec} vs audio ${audioSec}`);

  // 成功路径不留 mix 临时目录
  assert.deepEqual(await listMixDirs(tmpRoot), []);
  assert.deepEqual(
    (await fs.readdir(outputDir)).filter((name) => name.includes('.partial')),
    [],
  );
});

// ---- P10-A2 -------------------------------------------------------------

test('P10-A2 旧 body（纯 RenderJobSpec）仍可用', async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  const outputDir = path.join(workDir, 'out-a2');

  const created = await post(api.url, spec('p10-a2', outputDir));
  assert.equal(created.status, 202, JSON.stringify(created.body));
  assert.equal(created.body.audio, undefined);

  const { progress } = await waitJob(api.url, 'p10-a2');
  assert.equal(progress.state, 'done', JSON.stringify(progress));
  const result = await api.queue.result('p10-a2');
  const probe = await probeMedia(/** @type {any} */ (result).path);
  assert.ok(probe.audio, 'legacy path should still mux the resolved audio track');
  assert.ok(Math.abs((probe.audio?.durationSec ?? 0) - 1) <= 0.0334);
});

// ---- P10-A3 -------------------------------------------------------------

test('P10-A3 坏 audioMix：src 不存在 → 作业 failed，error=AUDIO_DECODE_FAILED，无 .partial', async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  const outputDir = path.join(workDir, 'out-a3');

  const created = await post(api.url, {
    spec: spec('p10-a3', outputDir),
    audioMix: { duration: 1, clips: [{ src: path.join(workDir, 'missing.wav'), at: 0 }] },
  });
  assert.equal(created.status, 202, JSON.stringify(created.body));

  const { progress } = await waitJob(api.url, 'p10-a3');
  assert.equal(progress.state, 'failed', JSON.stringify(progress));
  assert.equal(progress.error, 'AUDIO_DECODE_FAILED', JSON.stringify(progress));
  // 终态先于 finally 的临时目录清理可见，等作业真正收尾再查残留
  await api.queue.idle();

  const leftovers = (await fs.readdir(outputDir).catch(() => [])).filter((name) => name.includes('.partial'));
  assert.deepEqual(leftovers, []);
  assert.deepEqual(await listMixDirs(tmpRoot), []);
  assert.deepEqual(
    (await fs.readdir(tmpRoot)).filter((name) => name.startsWith('opencut-mix-')),
    [],
  );
});

test('P10-A3 结构错误：400 INVALID_AUDIO_MIX；新 body 未知字段：400', async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  const outputDir = path.join(workDir, 'out-a3b');

  const badClips = await post(api.url, {
    spec: spec('p10-a3b', outputDir),
    audioMix: { duration: 1, clips: [] },
  });
  assert.equal(badClips.status, 400);
  assert.equal(badClips.body.error, 'INVALID_AUDIO_MIX');

  const badKey = await post(api.url, {
    spec: spec('p10-a3c', outputDir),
    audioMix: { duration: 1, clips: [{ src: TONE, at: 0, bogus: 1 }] },
  });
  assert.equal(badKey.status, 400);
  assert.match(badKey.body.detail, /bogus/);

  const extraTop = await post(api.url, { spec: spec('p10-a3d', outputDir), extra: 1 });
  assert.equal(extraTop.status, 400);
  assert.equal(extraTop.body.error, 'UNKNOWN_FIELD');
});

// ---- P10-A4 -------------------------------------------------------------

test('P10-A4 取消在 audio 阶段生效：无残件、无悬挂 ffmpeg', async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  const outputDir = path.join(workDir, 'out-a4');

  const created = await post(api.url, {
    spec: spec('p10-a4', outputDir),
    audioMix: { duration: 60, clips: [{ src: longTone, at: 0, time: [0, 60] }] },
  });
  assert.equal(created.status, 202);

  // 等到真的进 audio 阶段再取消
  const deadline = Date.now() + 10_000;
  /** @type {any} */
  let progress;
  while (Date.now() < deadline) {
    const res = await fetch(`${api.url}/exports/p10-a4`);
    progress = await res.json();
    if (progress.stage === 'audio' || progress.state !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(progress.stage, 'audio', JSON.stringify(progress));

  const cancelled = await fetch(`${api.url}/exports/p10-a4`, { method: 'DELETE' });
  assert.equal(cancelled.status, 200);
  const afterCancel = await cancelled.json();
  assert.equal(afterCancel.state, 'cancelled', JSON.stringify(afterCancel));

  assert.deepEqual(await listMixDirs(tmpRoot), []);
  assert.deepEqual(
    (await fs.readdir(outputDir).catch(() => [])).filter((name) => name.includes('.partial')),
    [],
  );
});

// ---- P10-A7 -------------------------------------------------------------

test('P10-A7 两个作业排队：各自 mix.wav 独立、输出不同、全部清理', async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  const outputDir = path.join(workDir, 'out-a7');

  const first = await post(api.url, {
    spec: spec('p10-a7a', outputDir),
    audioMix: { duration: 1, clips: [{ src: TONE, at: 0 }] },
  });
  const second = await post(api.url, {
    spec: spec('p10-a7b', outputDir),
    audioMix: { duration: 1, clips: [{ src: tone2, at: 0 }] },
  });
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);

  const a = await waitJob(api.url, 'p10-a7a');
  const b = await waitJob(api.url, 'p10-a7b');
  assert.equal(a.progress.state, 'done', JSON.stringify(a.progress));
  assert.equal(b.progress.state, 'done', JSON.stringify(b.progress));

  await api.queue.idle();
  const ra = await api.queue.result('p10-a7a');
  const rb = await api.queue.result('p10-a7b');
  assert.notEqual(/** @type {any} */ (ra).path, /** @type {any} */ (rb).path);
  assert.notEqual(/** @type {any} */ (ra).sha256, /** @type {any} */ (rb).sha256);
  assert.equal(a.progress.audio.clips, 1);
  assert.equal(b.progress.audio.clips, 1);

  assert.deepEqual(await listMixDirs(tmpRoot), []);
});
