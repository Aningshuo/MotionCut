/**
 * P9（R5）验收：双流同长、片尾有画面、≥3 条错位片段、30 秒带声整片。
 *
 * 全部真实 ffmpeg/ffprobe；没有 mock。
 * - 目标时长规则：target = min(video, audio)，只裁不补（见 audio-mix.mjs 头）。
 * - 片尾检查：解末帧灰度图算平均亮度，并与首帧逐像素比；只看容器 duration 会漏。
 * - 脉冲定位：从**产物音轨**解回 PCM，找第一个超过阈值的样本。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  activeMixPids,
  atempoChain,
  mixClips,
  muxWithVideo,
  renderAudioMixExport,
  renderMix,
} from '../audio-mix.mjs';
import { probeMedia } from '../verify.mjs';

const execFileAsync = promisify(execFile);
const ROOT = new URL('../../../', import.meta.url).pathname;
const TONE = path.join(ROOT, 'tests/fixtures/media/tone-1khz-3s.wav');
const BARS = path.join(ROOT, 'tests/fixtures/media/bars-3s-720p30.mp4');

/** @type {string} */
let workDir;
/** @type {string} */
let pulse;
/** @type {string} */
let bed30;
/** @type {string} */
let video30;

before(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-av-export-'));

  pulse = path.join(workDir, 'pulse-1k-10ms.wav');
  // lavfi sine 的默认幅度只有 ~0.088，这里放大 11 倍做成清晰的 1kHz 脉冲
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=0.01,volume=11',
    '-ar', '48000', '-ac', '2', pulse,
  ]);

  bed30 = path.join(workDir, 'bed-220hz-30s.wav');
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=30',
    '-ar', '48000', '-ac', '2', bed30,
  ]);

  // 30s 画面：3s 素材循环 10 次，stream copy（不重编码，帧数与源一致：900）
  video30 = path.join(workDir, 'bars-30s.mp4');
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-stream_loop', '9', '-i', BARS, '-t', '30', '-c', 'copy', '-an', video30,
  ]);
});

after(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

/**
 * 独立解码为 f32le（不经过被测代码）。
 * @param {string} file
 * @param {{ channels?: number, sampleRate?: number, ss?: number, t?: number }} [opts]
 */
async function decode(file, opts = {}) {
  const channels = opts.channels ?? 2;
  const sampleRate = opts.sampleRate ?? 48000;
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
  if (opts.ss !== undefined) args.push('-ss', String(opts.ss));
  if (opts.t !== undefined) args.push('-t', String(opts.t));
  args.push('-i', file, '-vn', '-ac', String(channels), '-ar', String(sampleRate), '-f', 'f32le', '-');
  const { stdout } = await execFileAsync('ffmpeg', args, { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });
  const pcm = new Float32Array(stdout.length / 4);
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = stdout.readFloatLE(i * 4);
  return { pcm, frames: pcm.length / channels };
}

/**
 * 解一帧灰度图（用于片尾非黑/首末帧差异）。
 * @param {string} file
 * @param {number} index
 * @returns {Promise<Buffer>}
 */
async function grayFrame(file, index) {
  const { stdout } = await execFileAsync(
    'ffmpeg',
    [
      '-v', 'error', '-i', file,
      '-vf', `select='eq(n\\,${index})'`,
      '-vsync', '0', '-frames:v', '1',
      '-pix_fmt', 'gray', '-f', 'rawvideo', '-',
    ],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout;
}

/** @param {Buffer} gray */
function meanLuma(gray) {
  let sum = 0;
  for (const value of gray) sum += value;
  return sum / gray.length;
}

/**
 * @param {Buffer} a
 * @param {Buffer} b
 */
function meanAbsDiff(a, b) {
  const length = Math.min(a.length, b.length);
  assert.ok(length > 0, 'frames must not be empty');
  let sum = 0;
  for (let i = 0; i < length; i += 1) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return sum / length;
}

/** @param {Float32Array} pcm @param {number} channels @param {number} from @param {number} to */
function peakBetween(pcm, channels, from, to) {
  let peak = 0;
  for (let frame = from; frame < to; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const value = Math.abs(pcm[frame * channels + channel] ?? 0);
      if (value > peak) peak = value;
    }
  }
  return peak;
}

// ---- R5-A1 --------------------------------------------------------------

test('R5-A1 2s 音频 + 3s 视频：双流同为 2.000s、容器 2.000s、片尾不再只有声音', async () => {
  const out = path.join(workDir, 'a1-with-audio.mp4');
  const result = await renderAudioMixExport(
    { duration: 2, clips: [{ src: TONE, at: 0 }, { src: TONE, at: 1, volume: 0.5 }] },
    { videoPath: BARS, outPath: out },
  );

  assert.equal(result.target.basis, 'min');
  assert.equal(result.target.videoSec, 3);
  assert.equal(result.target.audioSec, 2);
  assert.equal(result.target.targetSec, 2);

  const probe = result.probe;
  assert.ok(probe.video && probe.audio, 'both streams required');
  const videoSec = probe.video.durationSec ?? Number.NaN;
  const audioSec = probe.audio.durationSec ?? Number.NaN;
  const formatSec = probe.format.durationSec ?? Number.NaN;

  assert.ok(Math.abs(videoSec - 2) <= 0.0334, `video ${videoSec}s`);
  assert.ok(Math.abs(audioSec - 2) <= 0.0334, `audio ${audioSec}s`);
  assert.ok(Math.abs(formatSec - 2) <= 0.0334, `container ${formatSec}s`);
  assert.ok(Math.abs(videoSec - audioSec) <= 0.0334, `video ${videoSec} vs audio ${audioSec}`);
  assert.equal(probe.video.frames, 60, `frames ${probe.video.frames}`);

  await assert.doesNotReject(() =>
    execFileAsync('ffmpeg', ['-v', 'error', '-i', result.path, '-f', 'null', '-']),
  );
});

// ---- R5-A5 --------------------------------------------------------------

test('R5-A5 三条错位/重叠片段：逐样本与独立参考和差 < 1e-6', async () => {
  const channels = 2;
  const sampleRate = 48000;
  const duration = 3;
  /** @type {Array<any>} */
  const clips = [
    { src: TONE, at: 0.25, volume: 0.8, fade: [0.1, 0.1] },
    { src: TONE, at: 0.9, volume: 0.5, time: [0, 1.5], speed: 2 },
    { src: TONE, at: 1.6, volume: 0.35, time: [0.5, 2.4], speed: 0.75, fade: [0.05, 0.2] },
  ];

  const { pcm, report } = await mixClips({ duration, sampleRate, channels, clips });
  assert.equal(report.clips.length, 3);

  // 独立参考：每条片段自己 decode（同一组 ffmpeg 参数）+ 同一包络，逐样本相加。
  const totalFrames = Math.round(duration * sampleRate);
  const reference = new Float32Array(totalFrames * channels);
  for (const clip of clips) {
    const chain = atempoChain(clip.speed ?? 1);
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
    if (Array.isArray(clip.time)) {
      args.push('-ss', String(clip.time[0]), '-t', String(clip.time[1] - clip.time[0]));
    }
    args.push('-i', clip.src);
    if (chain.factors.some((factor) => Math.abs(factor - 1) > 1e-9)) {
      args.push('-af', chain.factors.map((factor) => `atempo=${factor}`).join(','));
    }
    args.push('-vn', '-ac', String(channels), '-ar', String(sampleRate), '-f', 'f32le', '-');
    const { stdout } = await execFileAsync('ffmpeg', args, { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
    const source = new Float32Array(stdout.length / 4);
    for (let i = 0; i < source.length; i += 1) source[i] = stdout.readFloatLE(i * 4);

    const frames = source.length / channels;
    const offsetFrames = Math.round(clip.at * sampleRate);
    const volume = clip.volume ?? 1;
    const fadeInFrames = Math.round((clip.fade?.[0] ?? 0) * sampleRate);
    const fadeOutFrames = Math.round((clip.fade?.[1] ?? 0) * sampleRate);

    for (let frame = 0; frame < frames; frame += 1) {
      const target = offsetFrames + frame;
      if (target < 0 || target >= totalFrames) continue;
      let gain = volume;
      if (fadeInFrames > 0 && frame < fadeInFrames) gain *= frame / fadeInFrames;
      if (fadeOutFrames > 0 && frame >= frames - fadeOutFrames) {
        gain *= Math.max(0, (frames - frame - 1) / fadeOutFrames);
      }
      for (let channel = 0; channel < channels; channel += 1) {
        const at = target * channels + channel;
        reference[at] = (reference[at] ?? 0) + (source[frame * channels + channel] ?? 0) * gain;
      }
    }
  }

  let maxError = 0;
  let referencePeak = 0;
  for (let i = 0; i < pcm.length; i += 1) {
    const error = Math.abs((pcm[i] ?? 0) - (reference[i] ?? 0));
    if (error > maxError) maxError = error;
    const magnitude = Math.abs(reference[i] ?? 0);
    if (magnitude > referencePeak) referencePeak = magnitude;
  }
  assert.ok(referencePeak > 0.1, `reference is silent (peak ${referencePeak})`);
  assert.ok(referencePeak < 1, `reference must stay below the limiter (peak ${referencePeak})`);
  assert.ok(maxError < 1e-6, `max |mix - reference| = ${maxError}`);

  // 每条片段都要有可审的 offset/peak/rms/atempo
  for (const [index, entry] of report.clips.entries()) {
    assert.equal(entry.index, index);
    assert.ok(Number.isInteger(entry.sampleOffset));
    assert.equal(entry.sampleOffset, Math.round(clips[index].at * sampleRate));
    assert.ok(entry.peak > 0 && entry.rms > 0, `clip ${index} silent`);
    assert.ok(Array.isArray(entry.atempo.factors) && entry.atempo.factors.length > 0);
  }
});

// ---- R5-A6 --------------------------------------------------------------

test('R5-A6 变速因子：0.1 上报 [0.5,0.5,0.5,0.8]，乘积误差 < 1e-6', () => {
  const chain = atempoChain(0.1);
  assert.deepEqual(chain.factors, [0.5, 0.5, 0.5, 0.8]);
  assert.ok(Math.abs(chain.product - 0.1) < 1e-6, `product ${chain.product}`);
  assert.deepEqual(atempoChain(2).factors, [2]);
  assert.deepEqual(atempoChain(0.25).factors, [0.5, 0.5]);
});

// ---- R5-A7 --------------------------------------------------------------

test('R5-A7 坏音频 → AUDIO_DECODE_FAILED，失败无 .partial、无残留进程', async () => {
  const bad = path.join(workDir, 'not-really-audio.wav');
  await fs.writeFile(bad, Buffer.from('this is not a wav file at all', 'utf8'));
  const outWav = path.join(workDir, 'bad-mix.wav');
  const beforePids = activeMixPids();

  await assert.rejects(
    renderMix({ duration: 1, clips: [{ src: bad, at: 0 }] }, { outWav }),
    (/** @type {any} */ err) => err.code === 'AUDIO_DECODE_FAILED',
  );

  const leftovers = (await fs.readdir(workDir)).filter((name) => name.includes('bad-mix'));
  assert.deepEqual(leftovers, [], `partial left behind: ${leftovers.join(',')}`);
  assert.deepEqual(activeMixPids(), beforePids, 'mix child process leaked');
});

// ---- R5-A2 / A3 / A4 ----------------------------------------------------

test('R5-A2/A3/A4 30s 整片：双流 30.000s、末帧有画面、1.0s 脉冲偏差 ≤1ms', async () => {
  const out = path.join(workDir, 'a2-30s.mp4');
  const spec = {
    duration: 30,
    sampleRate: 48000,
    clips: [
      { src: bed30, at: 0, volume: 1.2 },
      { src: TONE, at: 5, volume: 0.05, time: [0, 6], speed: 0.5 },
      { src: pulse, at: 1.0, volume: 0.9 },
    ],
  };
  const started = Date.now();
  const result = await renderAudioMixExport(spec, { videoPath: video30, outPath: out });
  const elapsed = Date.now() - started;

  const { video, audio, format } = result.probe;
  assert.ok(video && audio, 'both streams required');
  assert.ok(Math.abs((video.durationSec ?? 0) - 30) <= 0.0334, `video ${video.durationSec}s`);
  assert.ok(Math.abs((audio.durationSec ?? 0) - 30) <= 0.0334, `audio ${audio.durationSec}s`);
  assert.ok(Math.abs((format.durationSec ?? 0) - 30) <= 0.0334, `container ${format.durationSec}s`);
  assert.ok(Math.abs((video.durationSec ?? 0) - (audio.durationSec ?? 0)) <= 0.0334, 'streams must match');
  assert.equal(video.frames, 900, `frames ${video.frames}`);
  assert.equal(audio.codec, 'aac');
  assert.equal(audio.channels, 2);
  assert.ok(elapsed < 240_000, `30s export took ${elapsed}ms`);

  // 完整 decode（A2）
  await assert.doesNotReject(() =>
    execFileAsync('ffmpeg', ['-v', 'error', '-i', result.path, '-f', 'null', '-'], { timeout: 180_000 }),
  );

  // 片尾（A3）：末帧非黑，且与首帧不同
  const first = await grayFrame(result.path, 0);
  const last = await grayFrame(result.path, 899);
  const firstLuma = meanLuma(first);
  const lastLuma = meanLuma(last);
  const diff = meanAbsDiff(first, last);
  assert.ok(lastLuma > 30, `last frame is too dark (mean ${lastLuma})`);
  assert.ok(diff > 0.5, `first and last frames look identical (mean |diff| ${diff})`);
  assert.ok(firstLuma > 30, `first frame is too dark (mean ${firstLuma})`);

  // 脉冲（A4）：从产物音轨解回 PCM 找 1.0s 处的 1kHz 脉冲
  const { pcm, frames } = await decode(result.path, { channels: 2, sampleRate: 48000 });
  const from = Math.round(0.9 * 48000);
  const to = Math.round(1.1 * 48000);
  const bedPeak = peakBetween(pcm, 2, Math.round(1.2 * 48000), Math.round(1.4 * 48000));
  let onset = -1;
  for (let frame = from; frame < to; frame += 1) {
    const value = Math.abs(pcm[frame * 2] ?? 0);
    if (value > 0.3) {
      onset = frame;
      break;
    }
  }
  assert.ok(onset >= 0, `pulse not found in [0.9, 1.1]s; bed peak ${bedPeak}`);
  const pulseSec = onset / 48000;
  assert.ok(bedPeak > 0.01, `bed is silent (${bedPeak})`);
  assert.ok(Math.abs(pulseSec - 1.0) <= 0.001, `pulse at ${pulseSec}s (offset ${(pulseSec - 1) * 1000}ms)`);
  assert.ok(frames >= 30 * 48000 - 1, `decoded ${frames} frames`);
});

// ---- R5-A8 回归 ---------------------------------------------------------

test('R5-A8 取消封装：收敛 CANCELLED、无 .partial', async () => {
  const out = path.join(workDir, 'a8-cancel.mp4');
  const controller = new AbortController();
  const running = renderAudioMixExport(
    { duration: 30, clips: [{ src: bed30, at: 0 }] },
    { videoPath: video30, outPath: out, signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(running, (/** @type {any} */ err) => err.code === 'CANCELLED');
  const leftovers = (await fs.readdir(workDir)).filter((name) => name.includes('a8-cancel'));
  assert.deepEqual(leftovers, [], `partial left behind: ${leftovers.join(',')}`);
});

test('R5-A8 muxWithVideo 不覆盖旧名（第二份加后缀，首份 sha 不变）', async () => {
  const first = path.join(workDir, 'a8-dup.mp4');
  const mix = await renderMix({ duration: 2, clips: [{ src: TONE, at: 0 }] }, { outWav: path.join(workDir, 'a8-dup.wav') });
  const r1 = await muxWithVideo(BARS, mix.path, first);
  const r2 = await muxWithVideo(BARS, mix.path, first);
  assert.notEqual(r1.path, r2.path);
  assert.ok(r2.path.includes(' 2.mp4'), r2.path);
  const stamp = await fs.stat(r1.path);
  assert.equal(stamp.size, r1.bytes);
});
