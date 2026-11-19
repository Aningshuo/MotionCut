import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { RenderQueue, hashProject } from '../job.mjs';
import { activeEncoderPids } from '../ffmpeg.mjs';
import { fullDecode, probeMedia } from '../verify.mjs';

const execFileAsync = promisify(execFile);
const ROOT = new URL('../../../', import.meta.url).pathname;
const FILM = path.join(ROOT, 'contracts/fixtures/film-v12.html');
const BARS = path.join(ROOT, 'tests/fixtures/media/bars-3s-720p30.mp4');
const GIB = 1024 ** 3;

/** @type {string} */
let workDir;
/** @type {string} */
let frames150;
/** @type {string} */
let frames300;

before(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'render-parallel-'));
  frames150 = path.join(workDir, 'frames-150');
  frames300 = path.join(workDir, 'frames-300');
  await fs.mkdir(frames150, { recursive: true });
  await fs.mkdir(frames300, { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=5',
    '-vsync', '0', path.join(frames150, 'frame-%05d.png'),
  ]);
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=10',
    '-vsync', '0', path.join(frames300, 'frame-%05d.png'),
  ]);
});

after(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

/**
 * @param {number} ms
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {string} prefix
 * @returns {Promise<{ project: string, expectedHash: string }>}
 */
async function makeProject(prefix) {
  const project = path.join(workDir, `${prefix}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(project, { recursive: true });
  await fs.copyFile(FILM, path.join(project, 'film.html'));
  return { project, expectedHash: await hashProject(project) };
}

/**
 * @param {(...args: any[]) => boolean} predicate
 * @param {{ timeoutMs?: number }} [opts]
 */
async function waitFor(predicate, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error('waitFor timeout');
    await sleep(20);
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

/**
 * @param {number} index
 * @returns {Promise<Buffer>}
 */
function sourceFrame(index) {
  return fs.readFile(path.join(frames150, `frame-${String(index + 1).padStart(5, '0')}.png`));
}

test('P4-A1/A4/A8 单作业并行：乱序完成、按序落盘、帧序与 PTS 正确、ffprobe+decode 通过', async (t) => {
  const { project, expectedHash } = await makeProject('par');
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const outputDir = path.join(workDir, 'out-parallel');
  /** @type {number[]} */
  const completionSeen = [];

  const queue = new RenderQueue({
    resolveProject: () => project,
    hostInfo: () => ({ cpu: 4, freeMemBytes: 4 * GIB }),
    resolveFrameSource: () => ({
      width: 1280,
      height: 720,
      fps: 30,
      durationSec: 5,
      frameAt: async (_time, ctx) => {
        // 越大越先算完：完成顺序必然不是升序。
        // 每 4 帧里有一帧故意慢：该帧会晚于其后多帧完成，顺序必然乱。
        await sleep(ctx.index % 4 === 0 ? 80 : 0);
        return sourceFrame(ctx.index);
      },
    }),
  });

  queue.enqueue({
    jobId: 'par-1',
    projectId: 'proj-par',
    owner: 'SUB2',
    kind: 'video',
    range: [0, 5],
    fps: 30,
    audio: false,
    outputDir,
    expectedHash,
  });

  await queue.idle();
  const result = /** @type {any} */ (await queue.result('par-1'));
  assert.ok(!('error' in result), JSON.stringify(result));

  const inspected = queue.inspectJob('par-1');
  assert.ok(inspected);
  assert.equal(inspected.budget?.source, 'auto');
  // min(cpu-1=3, mem 4GiB/2=2, ceil(150/120)=2, 4) = 2
  assert.equal(inspected.workers, 2);
  assert.deepEqual(inspected.budget?.basis, { cpu: 4, freeMemBytes: 4 * GIB, frames: 150 });

  const order = inspected.completionOrder ?? [];
  completionSeen.push(...order);
  assert.equal(order.length, 150);
  assert.notDeepEqual(order, [...order].sort((a, b) => a - b), 'frames must complete out of order');

  // 输出帧序：解码 150 帧，与源帧做 PSNR 对比（顺序错了 PSNR 会崩）。
  const decodedDir = path.join(workDir, 'decoded-par');
  await fs.rm(decodedDir, { recursive: true, force: true });
  await fs.mkdir(decodedDir, { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', result.path, '-vsync', '0', path.join(decodedDir, 'frame-%05d.png'),
  ]);
  const decoded = (await fs.readdir(decodedDir)).sort();
  assert.equal(decoded.length, 150);

  const statsFile = path.join(workDir, 'psnr.log');
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-v', 'error',
    '-framerate', '30', '-i', path.join(decodedDir, 'frame-%05d.png'),
    '-framerate', '30', '-i', path.join(frames150, 'frame-%05d.png'),
    '-lavfi', `psnr=stats_file=${statsFile}`,
    '-f', 'null', '-',
  ]);
  const stats = await fs.readFile(statsFile, 'utf8');
  const psnrs = stats
    .trim()
    .split('\n')
    .map((line) => {
      const match = line.match(/psnr_avg:([0-9.]+)/);
      return match ? Number(match[1]) : Number.NaN;
    });
  assert.equal(psnrs.length, 150);
  const worst = Math.min(...psnrs);
  assert.ok(worst > 30, `frame order mismatch? worst psnr=${worst}`);

  // PTS：单调递增，首尾与 i/fps 对齐（抽查 0 / 75 / 149）。
  const { stdout: ptsOut } = await execFileAsync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', result.path,
  ]);
  const pts = ptsOut
    .trim()
    .split('\n')
    .map((line) => Number(line.replace(/,/g, '')))
    .filter((value) => Number.isFinite(value));
  assert.equal(pts.length, 150);
  for (let i = 1; i < pts.length; i += 1) {
    const prev = pts[i - 1] ?? 0;
    const current = pts[i] ?? 0;
    assert.ok(current > prev, `pts not increasing at ${i}: ${prev} -> ${current}`);
  }
  for (const i of [0, 75, 149]) {
    const value = pts[i] ?? Number.NaN;
    assert.ok(Math.abs(value - i / 30) <= 1 / 30, `pts[${i}]=${value}`);
  }

  const decode = await fullDecode(result.path);
  assert.equal(decode.ok, true, decode.stderr);
  const probe = await probeMedia(result.path);
  assert.equal(probe.video?.fps, '30/1');
  assert.equal(probe.video?.width, 1280);
  console.log(
    `A4 evidence: completionOrder first=[${order.slice(0, 8).join(',')}] last=[${order.slice(-8).join(',')}], ` +
      `worst_psnr=${worst.toFixed(2)}dB, pts0=${pts[0]} pts75=${pts[75]} pts149=${pts[149]}`,
  );
});

test('P4-A2 用户 workers=8：source=user、实际 8、仍能完成且 decode 通过', async (t) => {
  const { project, expectedHash } = await makeProject('user');
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const outputDir = path.join(workDir, 'out-user');
  const queue = new RenderQueue({
    resolveProject: () => project,
    hostInfo: () => ({ cpu: 8, freeMemBytes: 8 * GIB }),
    resolveFrameSource: () => ({
      width: 1280,
      height: 720,
      fps: 30,
      durationSec: 5,
      frameAt: async (_time, ctx) => sourceFrame(ctx.index),
    }),
  });

  queue.enqueue({
    jobId: 'user-8',
    projectId: 'proj-user',
    owner: 'SUB2',
    kind: 'video',
    range: [0, 5],
    fps: 30,
    audio: false,
    budget: { workers: 8 },
    outputDir,
    expectedHash,
  });
  await queue.idle();
  const result = /** @type {any} */ (await queue.result('user-8'));
  assert.ok(!('error' in result), JSON.stringify(result));
  const inspected = queue.inspectJob('user-8');
  assert.deepEqual(inspected?.budget, { source: 'user', workers: 8 });
  assert.equal(inspected?.workers, 8);
  const decode = await fullDecode(result.path);
  assert.equal(decode.ok, true, decode.stderr);
});

test('P4-A3 三作业严格串行；取消中间一个不影响其余', async (t) => {
  const { project, expectedHash } = await makeProject('serial');
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  /** @type {string[]} */
  const started = [];
  /** @type {RenderQueue | null} */
  let queueRef = null;
  const queue = new RenderQueue({
    resolveProject: () => project,
    resolveFrameSource: (spec) => {
      // 严格串行证据：s3 开始取帧时，s1 必须已经是 done（不是「同时跑」）。
      if (spec.jobId === 's3') {
        assert.equal(queueRef?.progress('s1').state, 'done', 's3 must not start before s1 finishes');
        assert.notEqual(queueRef?.progress('s2').state, 'running', 'cancelled s2 must never run');
      }
      started.push(spec.jobId);
      return { dir: frames150, pattern: 'frame-%05d.png', width: 1280, height: 720, fps: 30, durationSec: 5 };
    },
    resolveAudio: () => null,
  });
  queueRef = queue;

  const base = {
    projectId: 'proj-serial',
    owner: /** @type {const} */ ('SUB2'),
    kind: /** @type {const} */ ('video'),
    range: /** @type {const} */ ([0, 1]),
    fps: 30,
    audio: false,
    expectedHash,
  };
  for (const id of ['s1', 's2', 's3']) {
    const accepted = queue.enqueue({ ...base, jobId: id, outputDir: path.join(workDir, `out-${id}`) });
    assert.ok('jobId' in accepted);
    if (id === 's2') await queue.cancel('s2');
  }
  await queue.idle();

  assert.deepEqual(started, ['s1', 's3'], 'cancelled waiting job must not start; order preserved');
  assert.equal(queue.progress('s1').state, 'done');
  assert.equal(queue.progress('s2').state, 'cancelled');
  assert.equal(queue.progress('s3').state, 'done');
  assert.deepEqual(await listFiles(path.join(workDir, 'out-s2')), []);
  assert.ok((await listFiles(path.join(workDir, 'out-s1'))).length > 0);
  assert.ok((await listFiles(path.join(workDir, 'out-s3'))).length > 0);
});

test('P4-A5 PROJECT_CHANGED：中途改工程 → 失败、无正式输出、无 partial', async (t) => {
  const { project, expectedHash } = await makeProject('changed');
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const outputDir = path.join(workDir, 'out-changed');
  const queue = new RenderQueue({
    resolveProject: () => project,
    hostInfo: () => ({ cpu: 8, freeMemBytes: 8 * GIB }),
    projectCheckEveryFrames: 10,
    resolveFrameSource: () => ({
      width: 1280,
      height: 720,
      fps: 30,
      durationSec: 5,
      frameAt: async (_time, ctx) => {
        await sleep(6);
        return sourceFrame(ctx.index);
      },
    }),
  });

  queue.enqueue({
    jobId: 'changed-1',
    projectId: 'proj-changed',
    owner: 'SUB2',
    kind: 'video',
    range: [0, 5],
    fps: 30,
    audio: false,
    outputDir,
    expectedHash,
  });
  await waitFor(() => queue.progress('changed-1').state === 'running');
  await sleep(150);
  await fs.appendFile(path.join(project, 'film.html'), '\n<!-- changed mid-render -->\n');

  await queue.idle();
  const result = /** @type {any} */ (await queue.result('changed-1'));
  assert.equal(result.error, 'PROJECT_CHANGED', JSON.stringify(result));
  assert.equal(queue.progress('changed-1').state, 'failed');
  assert.deepEqual(await listFiles(outputDir), [], 'no formal output, no .partial');
  const framesDirs = (await fs.readdir(outputDir).catch(() => [])).filter((name) => name.startsWith('.frames-'));
  assert.deepEqual(framesDirs, [], 'temporary frame dir must be cleaned');
});

test('P4-A7 取消 running：只杀本作业 ffmpeg，别的进程还活着，无残件', async (t) => {
  const { project, expectedHash } = await makeProject('cancel');
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const outputDir = path.join(workDir, 'out-cancel');
  const queue = new RenderQueue({
    resolveProject: () => project,
    hostInfo: () => ({ cpu: 8, freeMemBytes: 8 * GIB }),
    resolveFrameSource: () => ({
      dir: frames300,
      pattern: 'frame-%05d.png',
      width: 1280,
      height: 720,
      fps: 30,
      durationSec: 10,
    }),
  });

  // 一个与渲染无关的进程，代表「别的作业/别的线」。
  const decoy = spawn('sleep', ['30'], { stdio: 'ignore', detached: false });
  t.after(() => {
    try {
      decoy.kill('SIGKILL');
    } catch {
      /* gone */
    }
  });

  queue.enqueue({
    jobId: 'cancel-1',
    projectId: 'proj-cancel',
    owner: 'SUB2',
    kind: 'video',
    range: [0, 10],
    fps: 30,
    audio: false,
    outputDir,
    expectedHash,
  });

  await waitFor(() => {
    const p = queue.progress('cancel-1');
    return p.state === 'running' && (p.framesDone ?? 0) > 0;
  });
  const encoderPids = activeEncoderPids();
  assert.equal(encoderPids.length, 1, `expected one encoder, got ${encoderPids.join(',')}`);
  await queue.cancel('cancel-1');

  assert.equal(queue.progress('cancel-1').state, 'cancelled');
  assert.equal(decoy.exitCode, null, 'decoy process must survive');
  for (const pid of encoderPids) {
    assert.throws(() => process.kill(pid, 0), /ESRCH/, `encoder pid ${pid} still alive`);
  }
  assert.deepEqual(activeEncoderPids(), [], 'no encoder child left behind');
  assert.deepEqual(await listFiles(outputDir), []);
});
