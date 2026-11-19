import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { MIX_UPSTREAM_REQUIREMENTS, MixExporter, planMix } from '../mix.mjs';
import { activeEncoderPids } from '../ffmpeg.mjs';
import { probeMedia, avSyncDeltaSec } from '../verify.mjs';

const execFileAsync = promisify(execFile);
const ROOT = new URL('../../../', import.meta.url).pathname;
const BARS = path.join(ROOT, 'tests/fixtures/media/bars-3s-720p30.mp4');
const TONE = path.join(ROOT, 'tests/fixtures/media/tone-1khz-3s.wav');

/** @type {string} */
let workDir;
/** @type {string} */
let sceneFrames;

before(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mix-test-'));
  sceneFrames = path.join(workDir, 'scene-frames');
  await fs.mkdir(sceneFrames, { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=2',
    '-vsync', '0', path.join(sceneFrames, 'frame-%05d.png'),
  ]);
});

after(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

/**
 * 显式 MOCK：film 结构由测试写死，不是主线 film 解析器的结果。
 * @returns {any}
 */
function MOCK_readFilm() {
  return {
    durationSec: 3,
    fps: 30,
    width: 1280,
    height: 720,
    segments: [
      { kind: 'video', path: BARS, inSec: 0, durationSec: 1 },
      { kind: 'scene', sceneId: 'scene-a', durationSec: 2 },
    ],
  };
}

/** 显式 MOCK：帧来自预抽好的测试序列，不是副线1 的 frame 内核。 */
function MOCK_frameAt() {
  return async (
    /** @type {string} */ _sceneId,
    /** @type {number} */ _time,
    /** @type {{ index: number }} */ ctx,
  ) => {
    // 乱序完成，验证状态机不依赖完成顺序。
    await new Promise((resolve) => setTimeout(resolve, ((59 - ctx.index) % 20) * 2));
    return fs.readFile(path.join(sceneFrames, `frame-${String(ctx.index + 1).padStart(5, '0')}.png`));
  };
}

/** 显式 MOCK：固定一条 3 秒音轨。 */
function MOCK_audioPlan() {
  return { path: TONE, startSec: 0, durationSec: 3, sampleRate: 48000, channels: 2 };
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {Promise<number>}
 */
async function psnr(a, b) {
  const { stderr } = await execFileAsync('ffmpeg', [
    '-hide_banner', '-i', a, '-i', b,
    '-lavfi', 'psnr', '-f', 'null', '-',
  ]).catch((err) => ({ stderr: String(err.stderr ?? err) }));
  const match = String(stderr).match(/average:([0-9.]+|inf)/);
  if (!match) return Number.NaN;
  return match[1] === 'inf' ? Infinity : Number(match[1]);
}

test('P4-A6 MOCK 混合：视频+场景+音频按时间线合成，音画对齐 ≤1 帧', async (t) => {
  const outDir = path.join(workDir, 'out-mix');
  const exporter = new MixExporter({
    readFilm: MOCK_readFilm,
    frameAt: MOCK_frameAt(),
    audioPlan: MOCK_audioPlan,
    workDir: path.join(workDir, 'mix-work'),
    workers: 2,
    fallback: 'fail',
  });
  const result = await exporter.run({ outputPath: path.join(outDir, 'mixed.mp4') });
  t.after(() => fs.rm(outDir, { recursive: true, force: true }));

  assert.equal(result.state, 'done', JSON.stringify(result));
  const output = /** @type {any} */ (result).output;
  assert.ok(output, 'output required');
  assert.deepEqual(/** @type {any} */ (result).fallbacks, []);
  assert.deepEqual(
    /** @type {any} */ (result).transitions,
    ['validating', 'planning', 'rendering', 'muxing', 'verifying', 'done'],
  );
  assert.equal(/** @type {any} */ (result).plan.avDeltaFrames, 0);

  const probe = await probeMedia(output.path);
  const delta = avSyncDeltaSec(probe);
  assert.notEqual(delta, null);
  assert.ok(/** @type {number} */ (delta) <= 1 / 30, `av delta ${delta}s`);
  assert.ok(Math.abs((probe.video?.durationSec ?? 0) - 3) <= 1 / 30);
  assert.ok(Math.abs((probe.format.durationSec ?? 0) - 3) <= 1 / 30);
  assert.equal(probe.video?.fps, '30/1');
  assert.equal(probe.audio?.codec, 'aac');
  assert.equal(probe.audio?.channels, 2);
  assert.equal(probe.audio?.sampleRate, 48000);

  // 时间线正确性：0.5s 应是实拍段，2.0s 应是场景段（用 PSNR 对照源）。
  const framesDir = path.join(workDir, 'decoded-mix');
  await fs.rm(framesDir, { recursive: true, force: true });
  await fs.mkdir(framesDir, { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', output.path, '-vsync', '0', path.join(framesDir, 'frame-%05d.png'),
  ]);
  const decoded = (await fs.readdir(framesDir)).sort();
  assert.equal(decoded.length, 90);

  // 输出第 16 帧 (t=0.5) vs bars 第 16 帧
  const barsFrames = path.join(workDir, 'bars-frames');
  await fs.mkdir(barsFrames, { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', BARS, '-vsync', '0', path.join(barsFrames, 'frame-%05d.png'),
  ]);
  const psnrVideo = await psnr(
    path.join(framesDir, 'frame-00016.png'),
    path.join(barsFrames, 'frame-00016.png'),
  );
  // 输出第 61 帧 (t=2.0) vs 场景第 31 帧 (scene 从 t=1s 开始)
  const psnrScene = await psnr(
    path.join(framesDir, 'frame-00061.png'),
    path.join(sceneFrames, 'frame-00031.png'),
  );
  assert.ok(psnrVideo > 30, `0.5s should be the shot segment, psnr=${psnrVideo}`);
  assert.ok(psnrScene > 30, `2.0s should be the scene segment, psnr=${psnrScene}`);
  console.log(
    `A6 MOCK evidence: av_delta=${delta}s, video_dur=${probe.video?.durationSec}s, ` +
      `psnr@0.5s=${psnrVideo.toFixed(2)} psnr@2.0s=${psnrScene.toFixed(2)}`,
  );
});

test('P4-A6 MOCK 失败回退：场景段失败 → 纯色占位，仍产出可验证文件（degraded）', async () => {
  const outDir = path.join(workDir, 'out-fallback');
  const exporter = new MixExporter({
    readFilm: MOCK_readFilm,
    frameAt: async (_sceneId, _time, ctx) => {
      if (ctx.index === 10) throw new Error('MOCK frame failure at index 10');
      return fs.readFile(path.join(sceneFrames, `frame-${String(ctx.index + 1).padStart(5, '0')}.png`));
    },
    audioPlan: MOCK_audioPlan,
    workDir: path.join(workDir, 'fallback-work'),
    workers: 2,
    fallback: 'color',
  });
  const result = /** @type {any} */ (await exporter.run({ outputPath: path.join(outDir, 'fallback.mp4') }));

  assert.equal(result.state, 'degraded', JSON.stringify(result));
  assert.equal(result.fallbacks.length, 1);
  assert.equal(result.fallbacks[0].segmentIndex, 1);
  assert.match(result.fallbacks[0].reason, /MOCK frame failure/);
  assert.deepEqual(result.transitions.slice(-2), ['verifying', 'degraded']);
  const probe = await probeMedia(result.output.path);
  assert.ok(Math.abs((probe.format.durationSec ?? 0) - 3) <= 1 / 30);
  assert.equal(probe.audio?.codec, 'aac');
  console.log(`A6 fallback evidence: ${JSON.stringify(result.fallbacks)}`);
});

test('P4-A6 MOCK 取消：mid-run abort → cancelled，无输出、无 partial、无残留编码进程', async () => {
  const outDir = path.join(workDir, 'out-cancel-mix');
  const controller = new AbortController();
  const exporter = new MixExporter({
    readFilm: MOCK_readFilm,
    frameAt: async (_sceneId, _time, ctx) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return fs.readFile(path.join(sceneFrames, `frame-${String(ctx.index + 1).padStart(5, '0')}.png`));
    },
    audioPlan: MOCK_audioPlan,
    workDir: path.join(workDir, 'cancel-work'),
    workers: 2,
    fallback: 'fail',
    signal: controller.signal,
  });

  const pending = exporter.run({ outputPath: path.join(outDir, 'cancelled.mp4') });
  await new Promise((resolve) => setTimeout(resolve, 250));
  controller.abort();
  const result = /** @type {any} */ (await pending);
  assert.equal(result.state, 'cancelled', JSON.stringify(result));
  assert.equal(result.error, 'CANCELLED');

  const leftovers = await fs.readdir(outDir).catch(() => []);
  assert.deepEqual(leftovers, []);
  assert.deepEqual(activeEncoderPids(), [], 'no encoder child left behind');
});

test('P4-A9 真实混合导出 = WAIT（附上游文件名/合同），不写「已支持」', () => {
  assert.equal(MIX_UPSTREAM_REQUIREMENTS.status, 'WAIT');
  assert.ok(MIX_UPSTREAM_REQUIREMENTS.requires.length >= 2);
  const owners = MIX_UPSTREAM_REQUIREMENTS.requires.map((item) => item.owner);
  assert.ok(owners.includes('MAIN'));
  assert.ok(owners.includes('SUB1'));
  for (const item of MIX_UPSTREAM_REQUIREMENTS.requires) {
    assert.match(item.file, /packages\/(film-core|scene-runtime)/);
    assert.match(item.contract, /^contracts\//);
  }
  assert.doesNotMatch(JSON.stringify(MIX_UPSTREAM_REQUIREMENTS), /supported|已支持/i);
});

test('P4-A6 时间线校验：段长不符 / 音画差 >1 帧 直接拒绝', () => {
  const badTimeline = planMix({
    film: {
      durationSec: 3,
      fps: 30,
      width: 1280,
      height: 720,
      segments: [
        { kind: 'video', path: BARS, inSec: 0, durationSec: 1 },
        { kind: 'scene', sceneId: 'a', durationSec: 1.5 },
      ],
    },
    audio: { path: TONE, startSec: 0, durationSec: 3 },
  });
  assert.equal(badTimeline.ok, false);
  if (!badTimeline.ok) assert.equal(badTimeline.error, 'INVALID_TIMELINE');

  const badAudio = planMix({
    film: MOCK_readFilm(),
    audio: { path: TONE, startSec: 0, durationSec: 1 },
  });
  assert.equal(badAudio.ok, false);
  if (!badAudio.ok) assert.equal(badAudio.error, 'AUDIO_MISMATCH');
});
