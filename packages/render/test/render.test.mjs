import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { RenderQueue, hashProject } from '../job.mjs';
import { fileDigest, fullDecode, avSyncDeltaSec, probeMedia } from '../verify.mjs';

const execFileAsync = promisify(execFile);
const ROOT = new URL('../../../', import.meta.url).pathname;
const BARS = path.join(ROOT, 'tests/fixtures/media/bars-3s-720p30.mp4');
const TONE = path.join(ROOT, 'tests/fixtures/media/tone-1khz-3s.wav');
const FILM = path.join(ROOT, 'contracts/fixtures/film-v12.html');

/** @type {string} */
let workDir;
/** @type {string} */
let framesShort;
/** @type {string} */
let framesLong;

before(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'render-test-'));
  framesShort = path.join(workDir, 'frames-3s');
  framesLong = path.join(workDir, 'frames-10s');
  await fs.mkdir(framesShort, { recursive: true });
  await fs.mkdir(framesLong, { recursive: true });

  await execFileAsync('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    BARS,
    '-vsync',
    '0',
    path.join(framesShort, 'frame-%05d.png'),
  ]);
  await execFileAsync('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=1280x720:rate=30:duration=10',
    '-vsync',
    '0',
    path.join(framesLong, 'frame-%05d.png'),
  ]);
});

after(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

/**
 * @param {{ preset?: string, audioPath?: string | null, injectFault?: (spec: any) => 'ENOSPC' | null }} [opts]
 */
async function makeProjectAndQueue(opts = {}) {
  const project = path.join(workDir, `proj-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(project, { recursive: true });
  await fs.copyFile(FILM, path.join(project, 'film.html'));
  const expectedHash = await hashProject(project);

  const queue = new RenderQueue({
    resolveProject: () => project,
    resolveFrameSource: (spec) =>
      spec.jobId.startsWith('long')
        ? { dir: framesLong, pattern: 'frame-%05d.png', width: 1280, height: 720, fps: 30, durationSec: 10 }
        : { dir: framesShort, pattern: 'frame-%05d.png', width: 1280, height: 720, fps: 30, durationSec: 3 },
    resolveAudio: () => (opts.audioPath === null ? null : TONE),
    preset: opts.preset ?? 'medium',
    ...(opts.injectFault ? { injectFault: opts.injectFault } : {}),
  });

  return { project, expectedHash, queue };
}

/**
 * @param {(...args: any[]) => boolean} predicate
 * @param {{ timeoutMs?: number, intervalMs?: number }} [opts]
 */
async function waitFor(predicate, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const intervalMs = opts.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listFiles(dir) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} current */
  const walk = async (current) => {
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else out.push(abs);
    }
  };
  await walk(dir);
  return out;
}

test('R1/R2/R3 3 秒合成：ffprobe 读回 + 完整 decode + 音画差', async (t) => {
  const { project, expectedHash, queue } = await makeProjectAndQueue();
  t.after(() => fs.rm(project, { recursive: true, force: true }));

  const outputDir = path.join(workDir, 'out-r1');
  const accepted = queue.enqueue({
    jobId: 'r1',
    projectId: 'proj-r1',
    owner: 'SUB2',
    kind: 'video',
    range: [0, 3],
    fps: 30,
    outputDir,
    expectedHash,
  });
  assert.deepEqual(accepted, { jobId: 'r1' });

  /** @type {any[]} */
  const samples = [];
  const timer = setInterval(() => samples.push(queue.progress('r1')), 20);
  await queue.idle();
  clearInterval(timer);

  const result = /** @type {any} */ (await queue.result('r1'));
  assert.ok(!('error' in result), JSON.stringify(result));
  assert.equal(result.probe.videoCodec, 'h264');
  assert.equal(result.probe.audioCodec, 'aac');
  assert.equal(result.probe.width, 1280);
  assert.equal(result.probe.height, 720);
  assert.equal(result.probe.fps, '30/1');
  assert.equal(result.probe.channels, 2);
  assert.equal(result.probe.sampleRate, 48000);
  assert.ok(Math.abs((result.probe.durationSec ?? 0) - 3) <= 0.1, `duration ${result.probe.durationSec}`);
  assert.ok(result.bytes > 0);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);

  // 进度：至少有一次 running，且 framesTotal=90、framesDone 递增到 90。
  assert.ok(samples.some((s) => s.state === 'running' && s.framesTotal === 90));
  assert.ok(samples.some((s) => s.framesDone > 0));
  const final = queue.progress('r1');
  assert.equal(final.state, 'done');
  assert.equal(final.framesDone, 90);

  const decode = await fullDecode(result.path);
  assert.equal(decode.ok, true, decode.stderr);
  assert.equal(decode.exitCode, 0);
  assert.deepEqual(decode.errorLines, []);

  const probe = await probeMedia(result.path);
  const delta = avSyncDeltaSec(probe);
  assert.notEqual(delta, null);
  assert.ok(/** @type {number} */ (delta) <= 1 / 30, `av delta ${delta}`);
  // 记录实测值供交接。
  console.log(`R3 av_delta_sec=${delta}`);
});

test('无音轨默认报 AUDIO_MISSING，不产出文件', async (t) => {
  const { project, expectedHash, queue } = await makeProjectAndQueue({ audioPath: null });
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const outputDir = path.join(workDir, 'out-noaudio');

  queue.enqueue({
    jobId: 'noaudio',
    projectId: 'proj-noaudio',
    owner: 'SUB2',
    kind: 'video',
    range: [0, 1],
    fps: 30,
    outputDir,
    expectedHash,
  });
  await queue.idle();
  const result = /** @type {any} */ (await queue.result('noaudio'));
  assert.equal(result.error, 'AUDIO_MISSING');
  const files = await listFiles(outputDir);
  assert.deepEqual(files, []);
});

test('R4 取消 running：cancelled，无正式 mp4，无 partial 残留', async (t) => {
  const { project, expectedHash, queue } = await makeProjectAndQueue();
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const outputDir = path.join(workDir, 'out-r4');

  const accepted = queue.enqueue({
    jobId: 'long-r4',
    projectId: 'proj-r4',
    owner: 'SUB2',
    kind: 'video',
    range: [0, 10],
    fps: 30,
    outputDir,
    expectedHash,
  });
  assert.ok('jobId' in accepted);

  await waitFor(() => {
    const p = queue.progress('long-r4');
    return p.state === 'running' && (p.framesDone ?? 0) > 0;
  });

  await queue.cancel('long-r4');
  const progress = queue.progress('long-r4');
  assert.equal(progress.state, 'cancelled');

  const result = /** @type {any} */ (await queue.result('long-r4'));
  assert.deepEqual(result, { error: 'CANCELLED' });

  const files = await listFiles(outputDir);
  assert.deepEqual(files, [], `residual files: ${files.join(', ')}`);
});

test('R5 非法区间 [10,5]：INVALID_RANGE，不启动编码', async (t) => {
  const { project, expectedHash, queue } = await makeProjectAndQueue();
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const outputDir = path.join(workDir, 'out-r5');

  const accepted = queue.enqueue({
    jobId: 'r5',
    projectId: 'proj-r5',
    owner: 'SUB2',
    kind: 'video',
    range: [10, 5],
    fps: 30,
    outputDir,
    expectedHash,
  });
  assert.equal(/** @type {any} */ (accepted).error, 'INVALID_RANGE');
  assert.equal(queue.has('r5'), false);
  await assert.rejects(fs.access(outputDir));
});

test('R6 磁盘满（注入）：ENOSPC，明确提示，不留残件', async (t) => {
  const { project, expectedHash, queue } = await makeProjectAndQueue({
    injectFault: (spec) => (spec.jobId === 'r6' ? 'ENOSPC' : null),
  });
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const outputDir = path.join(workDir, 'out-r6');

  queue.enqueue({
    jobId: 'r6',
    projectId: 'proj-r6',
    owner: 'SUB2',
    kind: 'video',
    range: [0, 3],
    fps: 30,
    outputDir,
    expectedHash,
  });
  await queue.idle();
  const result = /** @type {any} */ (await queue.result('r6'));
  assert.equal(result.error, 'ENOSPC');
  assert.match(String(result.detail), /space/i);
  const files = await listFiles(outputDir);
  assert.deepEqual(files, [], `residual files: ${files.join(', ')}`);
});

test('R7 重名输出：生成 " 2.mp4"，旧文件字节不变', async (t) => {
  const { project, expectedHash, queue } = await makeProjectAndQueue();
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const outputDir = path.join(workDir, 'out-r7');

  /** @type {any} */
  const spec = {
    projectId: 'proj-r7',
    owner: 'SUB2',
    kind: 'video',
    range: [0, 1],
    fps: 30,
    outputDir,
    expectedHash,
  };

  queue.enqueue({ ...spec, jobId: 'r7a' });
  await queue.idle();
  const first = /** @type {any} */ (await queue.result('r7a'));
  assert.ok(!('error' in first));
  const firstBytes = await fs.readFile(first.path);

  queue.enqueue({ ...spec, jobId: 'r7b' });
  await queue.idle();
  const second = /** @type {any} */ (await queue.result('r7b'));
  assert.ok(!('error' in second));

  assert.equal(path.basename(first.path), 'proj-r7-video.mp4');
  assert.equal(path.basename(second.path), 'proj-r7-video 2.mp4');
  assert.deepEqual(await fs.readFile(first.path), firstBytes, 'first output must stay byte-identical');
});

test('R8 渲染中改工程：PROJECT_CHANGED，不产出不一致成品', async (t) => {
  const { project, expectedHash, queue } = await makeProjectAndQueue();
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const outputDir = path.join(workDir, 'out-r8');

  queue.enqueue({
    jobId: 'long-r8',
    projectId: 'proj-r8',
    owner: 'SUB2',
    kind: 'video',
    range: [0, 10],
    fps: 30,
    outputDir,
    expectedHash,
  });

  await waitFor(() => queue.progress('long-r8').state === 'running');
  await fs.appendFile(path.join(project, 'film.html'), '\n<!-- edited during render -->\n');

  await queue.idle();
  const result = /** @type {any} */ (await queue.result('long-r8'));
  assert.equal(result.error, 'PROJECT_CHANGED');
  const files = await listFiles(outputDir);
  assert.deepEqual(files, [], `residual files: ${files.join(', ')}`);
});
