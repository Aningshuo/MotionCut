/**
 * P7 验收（A1–A9）：真实 ffmpeg 解码 + 真实混音 + 真实封装。
 *
 * 没有 mock：每条断言都对真实 WAV/MP4 取样。变速用例用**过零率**测基频
 * （1kHz 纯音在 50ms 窗口里约 100 次过零，分辨率足够 ±1%）。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
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
  softLimitSample,
} from '../audio-mix.mjs';

const execFileAsync = promisify(execFile);
const ROOT = new URL('../../../', import.meta.url).pathname;
const TONE = path.join(ROOT, 'tests/fixtures/media/tone-1khz-3s.wav');
const BARS = path.join(ROOT, 'tests/fixtures/media/bars-3s-720p30.mp4');

/** @type {string} */
let workDir;
/** @type {string} */
let pulse;
/** @type {string} */
let longTone;

before(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-audio-mix-'));
  pulse = path.join(workDir, 'pulse.wav');
  longTone = path.join(workDir, 'long.wav');
  await execFileAsync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=0.01', '-ar', '48000', pulse]);
  await execFileAsync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=120', '-ar', '48000', longTone]);
});

after(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

/**
 * 读 PCM f32le WAV（本包自己写的格式）。
 * @param {string} file
 */
async function readWav(file) {
  const buffer = await fs.readFile(file);
  let offset = 12;
  /** @type {any} */
  let fmt = null;
  /** @type {any} */
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      fmt = {
        format: buffer.readUInt16LE(offset + 8),
        channels: buffer.readUInt16LE(offset + 10),
        sampleRate: buffer.readUInt32LE(offset + 12),
        bits: buffer.readUInt16LE(offset + 22),
      };
    }
    if (id === 'data') data = { start: offset + 8, size };
    offset += 8 + size + (size % 2);
  }
  assert.ok(fmt && data, 'wav must have fmt and data chunks');
  const pcm = new Float32Array(data.size / 4);
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = buffer.readFloatLE(data.start + i * 4);
  return { ...fmt, pcm, frames: pcm.length / fmt.channels };
}

/**
 * 用 ffmpeg 独立解码任意音频为 f32le（不经过被测代码）。
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

/** @param {Float32Array} pcm @param {number} channels @param {number} fromFrame @param {number} toFrame */
function rms(pcm, channels, fromFrame, toFrame) {
  let sum = 0;
  let count = 0;
  for (let frame = fromFrame; frame < toFrame; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const value = pcm[frame * channels + channel] ?? 0;
      sum += value * value;
      count += 1;
    }
  }
  return count > 0 ? Math.sqrt(sum / count) : 0;
}

/** 过零率法测基频（纯音）。 @param {Float32Array} pcm @param {number} channels @param {number} sampleRate @param {number} fromSec @param {number} toSec */
function zeroCrossFrequency(pcm, channels, sampleRate, fromSec, toSec) {
  const from = Math.round(fromSec * sampleRate);
  const to = Math.round(toSec * sampleRate);
  let crossings = 0;
  let previous = pcm[from * channels] ?? 0;
  for (let frame = from + 1; frame < to; frame += 1) {
    const value = pcm[frame * channels] ?? 0;
    if ((previous < 0 && value >= 0) || (previous >= 0 && value < 0)) crossings += 1;
    previous = value;
  }
  return crossings / (2 * ((to - from) / sampleRate));
}

/** @param {string} file */
async function sha256(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

// ---- A1 -----------------------------------------------------------------

test('A1 at=1.0 的脉冲落在 1.0s ±1ms（样本位精确）', async () => {
  const outWav = path.join(workDir, 'a1.wav');
  const { report } = await renderMix(
    { duration: 2, clips: [{ src: pulse, at: 1.0 }] },
    { outWav },
  );
  const wav = await readWav(outWav);
  let first = -1;
  for (let frame = 0; frame < wav.frames; frame += 1) {
    if (Math.abs(wav.pcm[frame * wav.channels] ?? 0) > 0.001) {
      first = frame;
      break;
    }
  }
  assert.ok(first >= 0, 'pulse not found');
  const seconds = first / wav.sampleRate;
  assert.ok(Math.abs(seconds - 1.0) <= 0.001, `pulse at ${seconds}s, expected 1.0s ±1ms`);
  assert.equal(report.clips[0].sampleOffset, 48000);
});

// ---- A2 -----------------------------------------------------------------

test('A2 两条重叠：逐样本等于两者之和（<1e-6），未提前削波', async () => {
  const outWav = path.join(workDir, 'a2.wav');
  await renderMix(
    {
      duration: 1,
      clips: [
        { src: TONE, at: 0, volume: 0.3 },
        { src: TONE, at: 0, volume: 0.4 },
      ],
    },
    { outWav },
  );
  const mixed = await readWav(outWav);
  const source = await decode(TONE);
  const sourcePeak = source.pcm.reduce((/** @type {number} */ max, /** @type {number} */ value) => Math.max(max, Math.abs(value)), 0);
  let maxError = 0;
  for (let i = 0; i < mixed.pcm.length; i += 1) {
    const expected = (source.pcm[i] ?? 0) * 0.7;
    maxError = Math.max(maxError, Math.abs((mixed.pcm[i] ?? 0) - expected));
  }
  assert.ok(maxError < 1e-6, `max sample error ${maxError}`);
  // 0.3+0.4 的峰值 0.7 不应触发限幅
  const peak = mixed.pcm.reduce((/** @type {number} */ max, /** @type {number} */ value) => Math.max(max, Math.abs(value)), 0);
  assert.ok(Math.abs(peak - sourcePeak * 0.7) / (sourcePeak * 0.7) < 0.01, `peak ${peak} vs ${sourcePeak * 0.7}`);
});

// ---- A3 -----------------------------------------------------------------

test('A3 fade=[0.5,0.5]：幅度线性升降（RMS 采样点）', async () => {
  const outWav = path.join(workDir, 'a3.wav');
  await renderMix(
    { duration: 2, clips: [{ src: TONE, at: 0, time: [0, 2], fade: [0.5, 0.5] }] },
    { outWav },
  );
  const wav = await readWav(outWav);
  const window = Math.round(0.05 * wav.sampleRate);
  const windows = Math.floor(wav.frames / window);
  const curve = [];
  for (let i = 0; i < windows; i += 1) {
    curve.push(rms(wav.pcm, wav.channels, i * window, (i + 1) * window));
  }

  const rise = curve.slice(0, 10);
  for (let i = 1; i < rise.length; i += 1) {
    assert.ok(/** @type {number} */ (rise[i]) > /** @type {number} */ (rise[i - 1]), `fade-in not monotonic at window ${i}`);
  }
  // 线性：第 k 个窗口的增益应正比于 (k+0.5)/10
  for (let k = 0; k < 10; k += 1) {
    const expected = /** @type {number} */ (rise[9]) * ((k + 0.5) / 9.5);
    assert.ok(Math.abs(/** @type {number} */ (rise[k]) - expected) / expected < 0.2, `window ${k}: ${rise[k]} vs ${expected}`);
  }

  const fall = curve.slice(-10);
  for (let i = 1; i < fall.length; i += 1) {
    assert.ok(/** @type {number} */ (fall[i]) < /** @type {number} */ (fall[i - 1]), `fade-out not monotonic at window ${i}`);
  }
  assert.ok(/** @type {number} */ (fall.at(-1)) < 0.08 * /** @type {number} */ (rise[9]), 'tail should be near silence');
});

// ---- A4 -----------------------------------------------------------------

test('A4 volume=0.25：RMS 为原始的 1/4（±1%）', async () => {
  const full = path.join(workDir, 'a4-full.wav');
  const quarter = path.join(workDir, 'a4-quarter.wav');
  await renderMix({ duration: 1, clips: [{ src: TONE, at: 0 }] }, { outWav: full });
  await renderMix({ duration: 1, clips: [{ src: TONE, at: 0, volume: 0.25 }] }, { outWav: quarter });

  const a = await readWav(full);
  const b = await readWav(quarter);
  const ratio = rms(b.pcm, b.channels, 0, b.frames) / rms(a.pcm, a.channels, 0, a.frames);
  assert.ok(Math.abs(ratio - 0.25) / 0.25 < 0.01, `rms ratio ${ratio}`);
});

// ---- A5 -----------------------------------------------------------------

test('A5 保持音高：speed=2 → 时长 1/2、基频仍 1kHz；speed=0.25 → 4 倍、基频仍 1kHz', async () => {
  for (const [speed, expectedSeconds] of /** @type {Array<[number, number]>} */ ([[2, 1], [0.25, 8]])) {
    const outWav = path.join(workDir, `a5-${speed}.wav`);
    const { report } = await renderMix(
      { duration: 10, clips: [{ src: TONE, at: 0, time: [0, 2], speed }] },
      { outWav },
    );
    const wav = await readWav(outWav);

    // 时长：只看有声音的部分（末尾是静音）
    let last = 0;
    for (let frame = 0; frame < wav.frames; frame += 1) {
      if (Math.abs(wav.pcm[frame * wav.channels] ?? 0) > 0.01) last = frame;
    }
    const seconds = (last + 1) / wav.sampleRate;
    assert.ok(Math.abs(seconds - expectedSeconds) / expectedSeconds < 0.01, `speed=${speed}: ${seconds}s`);

    const frequency = zeroCrossFrequency(wav.pcm, wav.channels, wav.sampleRate, 0.2, Math.min(0.7, expectedSeconds - 0.2));
    assert.ok(Math.abs(frequency - 1000) / 1000 < 0.01, `speed=${speed}: ${frequency}Hz (pitch must stay 1kHz)`);

    const chain = report.clips[0].atempo;
    assert.equal(chain.speed, speed);
    if (speed === 0.25) assert.deepEqual(chain.factors, [0.5, 0.5]);
    if (speed === 2) assert.deepEqual(chain.factors, [2]);
    assert.ok(Math.abs(chain.product - speed) < 1e-6);
    for (const factor of chain.factors) assert.ok(factor >= 0.5 && factor <= 2, `factor ${factor} out of range`);
  }
});

test('A5 变速因子分解：0.1 与 3 都在约束内', () => {
  assert.deepEqual(atempoChain(0.1).factors, [0.5, 0.5, 0.5, 0.8]);
  assert.deepEqual(atempoChain(3).factors, [2, 1.5]);
  for (const speed of [0.1, 0.25, 0.5, 1, 1.5, 2, 3, 4]) {
    const chain = atempoChain(speed);
    assert.ok(Math.abs(chain.product - speed) < 1e-6, `product for ${speed}`);
    for (const factor of chain.factors) assert.ok(factor >= 0.5 - 1e-9 && factor <= 2 + 1e-9);
  }
});

// ---- A6 -----------------------------------------------------------------

test('A6 峰值 >1：软限幅后无 NaN/Inf、峰值 ≤1，且可复现', async () => {
  const spec = {
    duration: 1,
    clips: [
      { src: TONE, at: 0, volume: 9 },
      { src: TONE, at: 0, volume: 9 },
    ],
  };
  const first = path.join(workDir, 'a6-1.wav');
  const second = path.join(workDir, 'a6-2.wav');
  const { report } = await renderMix(spec, { outWav: first });
  await renderMix(spec, { outWav: second });

  assert.equal(report.limited, true);
  assert.ok(report.peakBeforeLimit > 1.2, `pre-limit peak ${report.peakBeforeLimit}`);

  const wav = await readWav(first);
  let peak = 0;
  for (const value of wav.pcm) {
    assert.ok(Number.isFinite(value), 'NaN/Inf in output');
    peak = Math.max(peak, Math.abs(value));
  }
  assert.ok(peak <= 1, `peak ${peak}`);
  assert.equal(await sha256(first), await sha256(second), 'limiter must be deterministic');
  assert.ok(softLimitSample(0) === 0 && softLimitSample(10) < 1);
});

// ---- A7 -----------------------------------------------------------------

test('A7 封装：h264 + aac、有 audio stream、时长正确、完整 decode exit 0', async () => {
  const outMp4 = path.join(workDir, 'a7.mp4');
  const result = await renderAudioMixExport(
    { duration: 2, clips: [{ src: TONE, at: 0 }, { src: TONE, at: 1, volume: 0.5 }] },
    { videoPath: BARS, outPath: outMp4 },
  );
  assert.ok(result.path.endsWith('.mp4'));

  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', result.path,
  ]);
  const probe = JSON.parse(stdout);
  const video = probe.streams.find((/** @type {any} */ stream) => stream.codec_type === 'video');
  const audio = probe.streams.find((/** @type {any} */ stream) => stream.codec_type === 'audio');
  assert.ok(video, 'video stream missing');
  assert.equal(video.codec_name, 'h264');
  assert.ok(audio, 'audio stream missing');
  assert.equal(audio.codec_name, 'aac');
  assert.equal(audio.channels, 2);
  assert.ok(Math.abs(Number(probe.format.duration) - 2) < 0.1, `duration ${probe.format.duration}`);

  await assert.doesNotReject(() =>
    execFileAsync('ffmpeg', ['-v', 'error', '-i', result.path, '-f', 'null', '-']),
  );
});

// ---- A8 -----------------------------------------------------------------

test('A8 取消：abort 后 500ms 内收敛 CANCELLED，无 .partial、无残留 ffmpeg', async () => {
  const outWav = path.join(workDir, 'a8.wav');
  const controller = new AbortController();
  /* P70：计时从 **abort() 那一刻** 起，不是从 renderMix() 起。
     这条测的是「取消能不能及时收敛」，不是「起 ffmpeg 有多快」——把 spawn 的时间算进去，
     机器一忙就会假红（实测并发 8 跑整包时偶发 >500ms，单独跑永远过）。 */
  let abortedAt = 0;
  const running = renderMix(
    { duration: 120, clips: [{ src: longTone, at: 0, time: [0, 120] }] },
    { outWav, signal: controller.signal },
  );
  setTimeout(() => {
    abortedAt = Date.now();
    controller.abort();
  }, 50);

  await assert.rejects(running, (/** @type {any} */ err) => err.code === 'CANCELLED');
  const elapsed = Date.now() - abortedAt;
  assert.ok(abortedAt > 0 && elapsed < 500, `cancel took ${elapsed}ms after abort`);

  const leftovers = (await fs.readdir(workDir)).filter((name) => name.startsWith('a8.wav'));
  assert.deepEqual(leftovers, [], `leftovers: ${leftovers.join(',')}`);
  assert.deepEqual(activeMixPids(), [], 'ffmpeg child still alive');
});

// ---- A9 -----------------------------------------------------------------

test('A9 重名不覆盖：第二次加后缀，旧文件字节不变', async () => {
  const target = path.join(workDir, 'a9.mp4');
  const spec = { duration: 1, clips: [{ src: TONE, at: 0 }] };
  const first = await renderAudioMixExport(spec, { videoPath: BARS, outPath: target });
  const before = await sha256(first.path);
  const second = await renderAudioMixExport(spec, { videoPath: BARS, outPath: target });

  assert.notEqual(second.path, first.path);
  assert.match(path.basename(second.path), / 2\.mp4$/);
  assert.equal(await sha256(first.path), before, 'first export must not change');
  assert.ok((await fs.stat(second.path)).size > 0);
});

test('A9 muxWithVideo 直接调用同样不覆盖', async () => {
  const wav = path.join(workDir, 'a9b.wav');
  await renderMix({ duration: 1, clips: [{ src: TONE, at: 0 }] }, { outWav: wav });
  const target = path.join(workDir, 'a9b.mp4');
  const one = await muxWithVideo(BARS, wav, target);
  const two = await muxWithVideo(BARS, wav, target);
  assert.notEqual(one.path, two.path);
  assert.ok((await fs.stat(one.path)).size > 0);
});

test('A9 mix 中间件：混音本身也不覆盖', async () => {
  const target = path.join(workDir, 'a9c.wav');
  const spec = { duration: 0.5, clips: [{ src: TONE, at: 0 }] };
  const one = await renderMix(spec, { outWav: target });
  const two = await renderMix(spec, { outWav: target });
  assert.notEqual(one.path, two.path);
});

// 检查：mixClips 在 duration 之外的声音被丢弃，不越界
test('边界：超出 duration 的片段被裁掉，不写越界内存', async () => {
  const { report } = await mixClips({ duration: 0.2, clips: [{ src: TONE, at: 0.1 }] });
  assert.equal(report.frames, Math.round(0.2 * 48000));
  assert.equal(report.clips[0].frames, Math.round(0.1 * 48000));
});
