/**
 * 真实多轨音频混合（P7 / WP24）。
 *
 * 与 `mix.mjs` 的分工：`mix.mjs` 是"混合导出状态机"（计划/校验/回退），这里只做
 * **DSP 与封装**——把多条声音按时间线叠成一条，再和画面封在一起。
 *
 * 口径（ADR-R2-03，不可自选）：
 * - 变速**保持音高**，只走 `atempo`；任何改变采样率/基频的滤镜都被禁止。
 *   本文件不含那类滤镜名——验收会对 packages/render 做整目录 grep，必须 0 命中。
 * - `atempo` 单级因子必须落在 0.5–2.0；超出就串联：`speed = f1·f2·…`。
 *   分解是贪心的：>2 反复乘 2，<0.5 反复乘 0.5，最后一个因子落在区间内。
 *   例：0.25 → 0.5×0.5；2 → 2；0.1 → 0.5×0.5×0.5×0.8。
 *   （任务书示例写 0.1 → 0.5×0.2，但 0.2 低于同一句规定的 0.5 下限；这里按约束
 *   求解，并在报告里列出实际因子。）
 * - 时间：`at` 精确到样本 `round(at*sr)`，**逐条独立取整**，不累计误差。
 * - 包络：`volume` 线性；`fade` 是**幅度线性**（不是 dB），in 在头、out 在尾。
 * - 混音：逐样本相加；不加任何"防削波预留"。
 * - 限幅：只有峰值 > 1 才启用，软拐点 0.95、渐近线 1.0（见 `softLimitSample`），
 *   确定性、无 NaN/Inf；未超限时**逐样本等于求和**。
 * - 输出 WAV：PCM **f32le**（format 3），便于逐样本比对；封装 AAC 192k。
 *
 * ## 封装目标时长规则（R5 定死，调用点不许自选）
 *
 * 旧实现只写 `-shortest`，实测 `2s 音频 + 3s 视频` 会得到 video 1.9s/57f、
 * audio 2.0s、容器 2.0s —— 片尾 0.1s **只有声音没有画面**。规则改成：
 *
 * 1. 先 `ffprobe` 两路：video 流时长、audio 流时长；
 * 2. `target = min(video, audio)`，**只裁不补**（选择 trim，不做静音 pad）；
 * 3. `-t target` 卡容器；再用 `-frames:v round(target·fps)` 卡视频帧数。
 *    只写 `-t` 不够：stream copy 会多带 1–2 帧（实测 `-t 2.0` 得到 2.0667s/62f）。
 * 4. **不用 `-shortest`**：它按解码进度停，会把较长的视频截短成 1.9s，正是本缺陷来源。
 * 5. 封装后立刻回探，两路流时长差 > 1 帧就报 `OUTPUT_UNVERIFIED`，不交给上层当成功。
 *
 * 结论：两路流时长差 ≤ 1 帧（30fps = 0.0333s），容器时长 = `target`。
 * 片尾检查方法（验收用）：解末帧灰度图算平均亮度，与首帧逐像素比 —— 只看容器
 * duration 是发现不了这个缺陷的。
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { RenderFailure, commitOutput } from './ffmpeg.mjs';
import { probeMedia, rationalToNumber } from './verify.mjs';

/** 采样率白名单：合同只允许这两个。 */
export const MIX_SAMPLE_RATES = Object.freeze([48000, 44100]);

/** `audioMix` 规格允许的键（多一个都拒绝，和合同对 spec 的态度一致）。 */
const AUDIO_MIX_KEYS = new Set(['duration', 'sampleRate', 'channels', 'clips']);
const AUDIO_CLIP_KEYS = new Set(['src', 'at', 'time', 'volume', 'speed', 'fade']);

/**
 * 结构化校验 `audioMix`（HTTP/CLI/MCP 共用；文件是否存在只能在渲染时才知道）。
 * @param {unknown} value
 * @returns {string | null} 错误说明；null = 通过
 */
export function validateAudioMixSpec(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'must be an object';
  const record = /** @type {Record<string, unknown>} */ (value);
  const unknown = Object.keys(record).filter((key) => !AUDIO_MIX_KEYS.has(key));
  if (unknown.length > 0) return `unknown field(s): ${unknown.join(', ')}`;

  if (typeof record.duration !== 'number' || !Number.isFinite(record.duration) || record.duration <= 0) {
    return 'duration must be a positive number';
  }
  if (record.sampleRate !== undefined && !MIX_SAMPLE_RATES.includes(/** @type {number} */ (record.sampleRate))) {
    return `sampleRate must be one of ${MIX_SAMPLE_RATES.join('|')}`;
  }
  if (record.channels !== undefined && record.channels !== 2) return 'channels must be 2';
  if (!Array.isArray(record.clips) || record.clips.length === 0) return 'clips must be a non-empty array';

  for (const [index, rawClip] of record.clips.entries()) {
    if (!rawClip || typeof rawClip !== 'object' || Array.isArray(rawClip)) return `clips[${index}] must be an object`;
    const clip = /** @type {Record<string, unknown>} */ (rawClip);
    const extra = Object.keys(clip).filter((key) => !AUDIO_CLIP_KEYS.has(key));
    if (extra.length > 0) return `clips[${index}] unknown field(s): ${extra.join(', ')}`;
    if (typeof clip.src !== 'string' || clip.src.length === 0) return `clips[${index}].src must be a path`;
    if (typeof clip.at !== 'number' || !Number.isFinite(clip.at) || clip.at < 0) {
      return `clips[${index}].at must be a number >= 0`;
    }
    if (clip.time !== undefined) {
      const time = clip.time;
      if (!Array.isArray(time) || time.length !== 2 || !time.every((t) => typeof t === 'number' && Number.isFinite(t))) {
        return `clips[${index}].time must be [in, out]`;
      }
      if (!(time[1] > time[0])) return `clips[${index}].time must have out > in`;
    }
    if (clip.volume !== undefined && (typeof clip.volume !== 'number' || !Number.isFinite(clip.volume) || clip.volume < 0)) {
      return `clips[${index}].volume must be a number >= 0`;
    }
    if (clip.speed !== undefined && (typeof clip.speed !== 'number' || !Number.isFinite(clip.speed) || clip.speed <= 0)) {
      return `clips[${index}].speed must be a positive number`;
    }
    if (clip.fade !== undefined) {
      const fade = clip.fade;
      if (!Array.isArray(fade) || fade.length !== 2 || !fade.every((f) => typeof f === 'number' && Number.isFinite(f) && f >= 0)) {
        return `clips[${index}].fade must be [in, out] with values >= 0`;
      }
    }
  }
  return null;
}

/** 软限幅拐点：|x| ≤ 0.95 原样通过。 */
export const SOFT_KNEE = 0.95;

/** 单级 atempo 因子的上下限。 */
export const ATEMPO_MIN = 0.5;
export const ATEMPO_MAX = 2;

/**
 * 音频解码/混音失败。`AUDIO_DECODE_FAILED` 已在合同 1.2.0-r4 收编，直接用；
 * 不塞进 `FRAME_FAILED`，用户才知道该换素材而不是查渲染器。
 * @param {string} detail
 */
function decodeFailure(detail) {
  return new RenderFailure('AUDIO_DECODE_FAILED', detail);
}

/** 正在跑的混音子进程（取消/残留检查用）。 */
const LIVE_PIDS = new Set();

/** @returns {number[]} */
export function activeMixPids() {
  return [...LIVE_PIDS];
}

/**
 * 把 speed 分解成 0.5–2.0 的 atempo 因子序列。
 * @param {number} speed
 * @returns {{ speed: number, factors: number[], product: number }}
 */
export function atempoChain(speed) {
  if (!Number.isFinite(speed) || speed <= 0) {
    throw new RenderFailure('INVALID_RANGE', `speed must be a positive number, got ${String(speed)}`);
  }
  /** @type {number[]} */
  const factors = [];
  let remaining = speed;
  let guard = 0;
  while (remaining > ATEMPO_MAX) {
    factors.push(ATEMPO_MAX);
    remaining /= ATEMPO_MAX;
    if ((guard += 1) > 32) break;
  }
  while (remaining < ATEMPO_MIN) {
    factors.push(ATEMPO_MIN);
    remaining /= ATEMPO_MIN;
    if ((guard += 1) > 32) break;
  }
  factors.push(Number(remaining.toFixed(6)));
  const product = factors.reduce((acc, factor) => acc * factor, 1);
  return { speed, factors, product: Number(product.toFixed(9)) };
}

/**
 * 软限幅：|x| ≤ 0.95 原样；以上在 0.95 与 1.0 之间做 tanh 过渡。
 * 连续（拐点处值为 0.95、斜率为 1）、单调、|y| < 1、对任意有限输入都不产生 NaN。
 * @param {number} x
 * @returns {number}
 */
export function softLimitSample(x) {
  if (!Number.isFinite(x)) return 0;
  const sign = x < 0 ? -1 : 1;
  const magnitude = Math.abs(x);
  if (magnitude <= SOFT_KNEE) return x;
  const span = 1 - SOFT_KNEE;
  // tanh 在双精度里会饱和到 1；留 1e-7 的余量，保证严格 < 1 且不出现 0/0
  const mapped = SOFT_KNEE + span * Math.tanh((magnitude - SOFT_KNEE) / span);
  return sign * Math.min(mapped, 1 - 1e-7);
}

/**
 * @param {Float32Array} pcm
 * @returns {{ peakBefore: number, peakAfter: number, limited: boolean, limitedSamples: number }}
 */
export function applySoftLimit(pcm) {
  let peakBefore = 0;
  for (let i = 0; i < pcm.length; i += 1) {
    const value = Math.abs(pcm[i] ?? 0);
    if (value > peakBefore) peakBefore = value;
  }
  if (peakBefore <= 1) return { peakBefore, peakAfter: peakBefore, limited: false, limitedSamples: 0 };

  let peakAfter = 0;
  let limitedSamples = 0;
  for (let i = 0; i < pcm.length; i += 1) {
    const original = pcm[i] ?? 0;
    if (Math.abs(original) > SOFT_KNEE) limitedSamples += 1;
    const value = softLimitSample(original);
    pcm[i] = value;
    const magnitude = Math.abs(value);
    if (magnitude > peakAfter) peakAfter = magnitude;
  }
  return { peakBefore, peakAfter, limited: true, limitedSamples };
}

/**
 * 跑一次 ffmpeg；stdout 收成 Buffer（解码用），stderr 留最后 8KB。
 * @param {string[]} args
 * @param {{ ffmpegPath?: string, signal?: AbortSignal, toBuffer?: boolean }} [opts]
 * @returns {Promise<Buffer>}
 */
function runFfmpeg(args, opts = {}) {
  const ffmpegPath = opts.ffmpegPath ?? 'ffmpeg';
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new RenderFailure('CANCELLED', 'cancelled before ffmpeg started'));
      return;
    }
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (child.pid) LIVE_PIDS.add(child.pid);
    /** @type {Buffer[]} */
    const chunks = [];
    let stderr = '';

    const cleanup = () => {
      if (child.pid) LIVE_PIDS.delete(child.pid);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      child.kill('SIGKILL');
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-8000);
    });
    child.on('error', (err) => {
      cleanup();
      reject(decodeFailure(`ffmpeg failed to start: ${err.message}`));
    });
    child.on('close', (code) => {
      cleanup();
      if (opts.signal?.aborted) {
        reject(new RenderFailure('CANCELLED', 'mix cancelled'));
        return;
      }
      if (code !== 0) {
        reject(decodeFailure(stderr.trim() || `ffmpeg exit ${code}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

/**
 * 解码一条片段为 f32le 交错采样。
 * `time` 先按 `#t` 截取，再按 `speed` 用 atempo 拉伸（保持音高）。
 * @param {{ src: string, at: number, time?: [number, number], volume?: number, speed?: number, fade?: [number, number] }} clip
 * @param {{ sampleRate: number, channels: number, ffmpegPath?: string, signal?: AbortSignal }} opts
 * @returns {Promise<{ pcm: Float32Array, frames: number, chain: ReturnType<typeof atempoChain> }>}
 */
export async function decodeClip(clip, opts) {
  if (typeof clip?.src !== 'string' || clip.src.length === 0) {
    throw new RenderFailure('INVALID_RANGE', 'clip.src is required');
  }
  if (!Number.isFinite(clip.at) || clip.at < 0) {
    throw new RenderFailure('INVALID_RANGE', `clip.at must be >= 0, got ${String(clip.at)}`);
  }
  const sampleRate = opts.sampleRate;
  const channels = opts.channels;
  const chain = atempoChain(clip.speed ?? 1);

  /** @type {string[]} */
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
  if (Array.isArray(clip.time)) {
    const [from, to] = clip.time;
    if (!(to > from)) throw new RenderFailure('INVALID_RANGE', `clip.time must be [in, out] with out > in`);
    args.push('-ss', String(from), '-t', String(to - from));
  }
  args.push('-i', clip.src);
  if (chain.factors.some((factor) => Math.abs(factor - 1) > 1e-9)) {
    args.push('-af', chain.factors.map((factor) => `atempo=${factor}`).join(','));
  }
  args.push('-vn', '-ac', String(channels), '-ar', String(sampleRate), '-f', 'f32le', '-');

  const buffer = await runFfmpeg(args, { ffmpegPath: opts.ffmpegPath, signal: opts.signal });
  const usable = buffer.length - (buffer.length % (4 * channels));
  const pcm = new Float32Array(usable / 4);
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = buffer.readFloatLE(i * 4);
  return { pcm, frames: pcm.length / channels, chain };
}

/**
 * 逐样本相加。`at` 用 `round(at*sr)` 落到样本位；包络在写入时乘上。
 * @param {{ duration: number, sampleRate?: number, channels?: number, clips: any[] }} spec
 * @param {{ ffmpegPath?: string, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ pcm: Float32Array, report: any }>}
 */
export async function mixClips(spec, opts = {}) {
  const sampleRate = spec.sampleRate ?? 48000;
  const channels = spec.channels ?? 2;
  if (!MIX_SAMPLE_RATES.includes(sampleRate)) {
    throw new RenderFailure('INVALID_RANGE', `sampleRate must be one of ${MIX_SAMPLE_RATES.join('|')}, got ${sampleRate}`);
  }
  if (channels !== 2) throw new RenderFailure('INVALID_RANGE', `channels must be 2, got ${channels}`);
  if (!Number.isFinite(spec.duration) || spec.duration <= 0) {
    throw new RenderFailure('INVALID_RANGE', `duration must be > 0, got ${String(spec.duration)}`);
  }
  if (!Array.isArray(spec.clips)) throw new RenderFailure('INVALID_RANGE', 'clips must be an array');

  const totalFrames = Math.round(spec.duration * sampleRate);
  const mix = new Float32Array(totalFrames * channels);
  /** @type {any[]} */
  const clipReports = [];

  for (const [index, clip] of spec.clips.entries()) {
    const { pcm, frames, chain } = await decodeClip(clip, { ...opts, sampleRate, channels });
    const offsetFrames = Math.round((clip.at ?? 0) * sampleRate);
    const volume = Number.isFinite(clip.volume) ? Number(clip.volume) : 1;
    const fadeIn = Array.isArray(clip.fade) ? Math.max(0, Number(clip.fade[0]) || 0) : 0;
    const fadeOut = Array.isArray(clip.fade) ? Math.max(0, Number(clip.fade[1]) || 0) : 0;
    const fadeInFrames = Math.round(fadeIn * sampleRate);
    const fadeOutFrames = Math.round(fadeOut * sampleRate);

    let peak = 0;
    let sumSquares = 0;
    let written = 0;

    for (let frame = 0; frame < frames; frame += 1) {
      // 混音是纯 CPU 循环：解码结束后仍要能被取消（A8 的 500ms 收敛）
      if ((frame & 0x3fff) === 0 && opts.signal?.aborted) {
        throw new RenderFailure('CANCELLED', 'mix cancelled');
      }
      const target = offsetFrames + frame;
      if (target < 0 || target >= totalFrames) continue;

      let gain = volume;
      if (fadeInFrames > 0 && frame < fadeInFrames) gain *= frame / fadeInFrames;
      if (fadeOutFrames > 0 && frame >= frames - fadeOutFrames) {
        gain *= Math.max(0, (frames - frame - 1) / fadeOutFrames);
      }

      for (let channel = 0; channel < channels; channel += 1) {
        const sample = (pcm[frame * channels + channel] ?? 0) * gain;
        const at = target * channels + channel;
        mix[at] = (mix[at] ?? 0) + sample;
        const magnitude = Math.abs(sample);
        if (magnitude > peak) peak = magnitude;
        sumSquares += sample * sample;
      }
      written += 1;
    }

    const samples = written * channels;
    clipReports.push({
      index,
      src: clip.src,
      at: clip.at ?? 0,
      sampleOffset: offsetFrames,
      frames: written,
      peak: round(peak, 6),
      rms: round(samples > 0 ? Math.sqrt(sumSquares / samples) : 0, 6),
      volume,
      fade: [fadeIn, fadeOut],
      speed: clip.speed ?? 1,
      atempo: chain,
    });
  }

  const limit = applySoftLimit(mix);
  let peak = 0;
  let sumSquares = 0;
  for (let i = 0; i < mix.length; i += 1) {
    const value = mix[i] ?? 0;
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
    sumSquares += value * value;
  }

  return {
    pcm: mix,
    report: {
      sampleRate,
      channels,
      durationSec: spec.duration,
      frames: totalFrames,
      clips: clipReports,
      peak: round(peak, 6),
      rms: round(mix.length > 0 ? Math.sqrt(sumSquares / mix.length) : 0, 6),
      peakBeforeLimit: round(limit.peakBefore, 6),
      limited: limit.limited,
      limitedSamples: limit.limitedSamples,
      softKnee: SOFT_KNEE,
    },
  };
}

/**
 * 写 PCM f32le WAV（format 3）。先写 `.partial` 再按"不覆盖旧名"提交。
 * @param {string} target
 * @param {{ sampleRate: number, channels: number, pcm: Float32Array }} audio
 * @returns {Promise<{ path: string, bytes: number, sha256: string }>}
 */
export async function writeWav(target, audio) {
  const { sampleRate, channels, pcm } = audio;
  const dataBytes = pcm.length * 4;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(3, 20); // IEEE float
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 4, 28);
  buffer.writeUInt16LE(channels * 4, 32);
  buffer.writeUInt16LE(32, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i += 1) buffer.writeFloatLE(pcm[i] ?? 0, 44 + i * 4);

  await fs.mkdir(path.dirname(target), { recursive: true });
  const partial = `${target}.partial`;
  await fs.writeFile(partial, buffer);
  const finalPath = await commitOutput(partial, target);
  const digest = crypto.createHash('sha256').update(buffer).digest('hex');
  return { path: finalPath, bytes: buffer.length, sha256: digest };
}

/**
 * 混音 → mix.wav。取消时删 `.partial`。
 * @param {{ duration: number, sampleRate?: number, channels?: number, clips: any[] }} spec
 * @param {{ outWav: string, ffmpegPath?: string, signal?: AbortSignal }} opts
 */
export async function renderMix(spec, opts) {
  const { pcm, report } = await mixClips(spec, opts);
  if (opts.signal?.aborted) throw new RenderFailure('CANCELLED', 'mix cancelled');
  try {
    const wav = await writeWav(opts.outWav, {
      sampleRate: report.sampleRate,
      channels: report.channels,
      pcm,
    });
    // 写盘是同步的一大段；abort 可能正好落在里面，落盘后再确认一次
    if (opts.signal?.aborted) {
      await fs.unlink(wav.path).catch(() => {});
      throw new RenderFailure('CANCELLED', 'mix cancelled');
    }
    return { ...wav, report };
  } catch (err) {
    await fs.unlink(`${opts.outWav}.partial`).catch(() => {});
    throw err;
  }
}

/**
 * 目标时长 = min(视频流, 音频流)。只裁不补：视频长就裁视频，音频长就裁音频。
 * 探测不到的极端情况退回可用的一路；两路都探测不到时返回 null（调用点退回 -shortest）。
 * @param {{ video?: { durationSec: number | null } | null, audio?: { durationSec: number | null } | null }} probe
 * @returns {{ targetSec: number | null, basis: 'min' | 'video' | 'audio' | 'unknown', videoSec: number | null, audioSec: number | null }}
 */
export function muxTarget(probe) {
  const videoSec = probe?.video?.durationSec ?? null;
  const audioSec = probe?.audio?.durationSec ?? null;
  if (videoSec !== null && audioSec !== null) {
    return { targetSec: Math.min(videoSec, audioSec), basis: 'min', videoSec, audioSec };
  }
  if (videoSec !== null) return { targetSec: videoSec, basis: 'video', videoSec, audioSec };
  if (audioSec !== null) return { targetSec: audioSec, basis: 'audio', videoSec, audioSec };
  return { targetSec: null, basis: 'unknown', videoSec, audioSec };
}

/**
 * 与画面封装。
 *
 * 规则见文件头：`target = min(video, audio)`，`-t target` + `-frames:v`，
 * **不用 `-shortest`**；封装后回探，两路流差 > 1 帧即 `OUTPUT_UNVERIFIED`。
 *
 * @param {string} videoPath
 * @param {string} wavPath
 * @param {string} outPath
 * `audio` / `container`（P38）：mp4=aac、webm=opus、mov=pcm_s16le；容器决定中间件后缀与
 * 是否写 `-movflags +faststart`（webm 不认识这个 flag）。不传时是 mp4 + aac 192k，
 * 与 R22 的 args 逐项相同。
 *
 * @param {{ ffmpegPath?: string, ffprobePath?: string, signal?: AbortSignal, bitrate?: string,
 *   audio?: { codec: string, bitrate: string | null }, container?: 'mp4' | 'webm' | 'mov' }} [opts]
 * @returns {Promise<{ path: string, bytes: number, sha256: string, target: ReturnType<typeof muxTarget>, probe: Awaited<ReturnType<typeof probeMedia>> }>}
 */
export async function muxWithVideo(videoPath, wavPath, outPath, opts = {}) {
  const ffprobePath = opts.ffprobePath ?? 'ffprobe';

  /** @type {Awaited<ReturnType<typeof probeMedia>>} */
  let videoProbe;
  try {
    videoProbe = await probeMedia(videoPath, { ffprobePath });
  } catch (err) {
    throw new RenderFailure('FRAME_FAILED', `cannot probe video: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!videoProbe.video) throw new RenderFailure('FRAME_FAILED', `no video stream in ${videoPath}`);

  /** @type {Awaited<ReturnType<typeof probeMedia>>} */
  let audioProbe;
  try {
    audioProbe = await probeMedia(wavPath, { ffprobePath });
  } catch (err) {
    throw decodeFailure(`cannot probe audio: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!audioProbe.audio) throw decodeFailure(`no audio stream in ${wavPath}`);

  const target = muxTarget({ video: videoProbe.video, audio: audioProbe.audio });
  const fps = rationalToNumber(videoProbe.video.fps);

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  // 保留容器后缀，ffmpeg 才认得出封装格式（`.partial` 结尾会选不到 muxer）
  const container = opts.container ?? 'mp4';
  const ext = container === 'webm' ? '.webm' : container === 'mov' ? '.mov' : '.mp4';
  const extRe = new RegExp(`\\.(${container === 'webm' ? 'webm' : container === 'mov' ? 'mov' : 'mp4'})$`, 'i');
  const partial = extRe.test(outPath) ? outPath.replace(extRe, `.partial${ext}`) : `${outPath}.partial${ext}`;
  const audioCodec = opts.audio?.codec ?? 'aac';
  const audioBitrate = opts.audio ? opts.audio.bitrate : opts.bitrate ?? '192k';
  /** @type {string[]} */
  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    '-i',
    videoPath,
    '-i',
    wavPath,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'copy',
    '-c:a',
    audioCodec,
    ...(audioBitrate ? ['-b:a', audioBitrate] : []),
    ...(container === 'webm' ? ['-ar', '48000', '-ac', '2'] : []),
  ];

  if (target.targetSec !== null) {
    args.push('-t', String(target.targetSec));
    if (fps !== null && fps > 0) {
      // stream copy 对 -t 有半帧级宽容，必须用帧数把视频尾巴钉死
      args.push('-frames:v', String(Math.max(1, Math.round(target.targetSec * fps))));
    }
  } else {
    // 两路都探不到时长：只能退回旧行为，并在返回里如实标 basis=unknown
    args.push('-shortest');
  }
  if (container === 'webm') args.push(partial);
  else args.push('-movflags', '+faststart', partial);

  try {
    await runFfmpeg(args, { ffmpegPath: opts.ffmpegPath, signal: opts.signal });
    if (opts.signal?.aborted) throw new RenderFailure('CANCELLED', 'mux cancelled');
    const finalPath = await commitOutput(partial, outPath);
    const outProbe = await probeMedia(finalPath, { ffprobePath });

    // 硬判据：双流同长。容器 duration 一致不算通过，必须两路自己的 duration 对齐。
    const videoSec = outProbe.video?.durationSec ?? null;
    const audioSec = outProbe.audio?.durationSec ?? null;
    if (!outProbe.audio) {
      await fs.unlink(finalPath).catch(() => {});
      throw new RenderFailure('OUTPUT_UNVERIFIED', 'muxed output has no audio stream');
    }
    const frameSec = fps !== null && fps > 0 ? 1 / fps : 0.0334;
    if (videoSec !== null && audioSec !== null && Math.abs(videoSec - audioSec) > frameSec + 1e-3) {
      await fs.unlink(finalPath).catch(() => {});
      throw new RenderFailure(
        'OUTPUT_UNVERIFIED',
        `stream durations diverge: video ${videoSec}s vs audio ${audioSec}s (target ${target.targetSec}s)`,
      );
    }

    const stat = await fs.stat(finalPath);
    const hash = crypto.createHash('sha256');
    hash.update(await fs.readFile(finalPath));
    return { path: finalPath, bytes: stat.size, sha256: hash.digest('hex'), target, probe: outProbe };
  } catch (err) {
    await fs.unlink(partial).catch(() => {});
    throw err;
  }
}

/**
 * 一步到位：混音 → wav → 封装 mp4。
 * @param {{ duration: number, sampleRate?: number, channels?: number, clips: any[] }} spec
 * @param {{ videoPath: string, outPath: string, wavPath?: string, ffmpegPath?: string, signal?: AbortSignal }} opts
 */
export async function renderAudioMixExport(spec, opts) {
  const wavPath = opts.wavPath ?? `${opts.outPath.replace(/\.mp4$/i, '')}.mix.wav`;
  const mix = await renderMix(spec, { outWav: wavPath, ffmpegPath: opts.ffmpegPath, signal: opts.signal });
  try {
    const muxed = await muxWithVideo(opts.videoPath, mix.path, opts.outPath, {
      ffmpegPath: opts.ffmpegPath,
      signal: opts.signal,
    });
    return { ...muxed, wav: mix, report: mix.report };
  } catch (err) {
    // 封装失败：wav 留着（它是可复现的中间产物），但 mp4 的半成品必须清掉
    await fs.unlink(opts.outPath.replace(/\.mp4$/i, '.partial.mp4')).catch(() => {});
    await fs.unlink(`${opts.outPath}.partial`).catch(() => {});
    throw err;
  }
}

/**
 * @param {number} value
 * @param {number} digits
 * @returns {number}
 */
function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
