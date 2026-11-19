/**
 * 输出校验（WP10 · R1–R3）。
 *
 * 成功定义：ffprobe 能读回约定的 codec/尺寸/帧率/时长/音轨，**并且**
 * `ffmpeg -v error -i out.mp4 -f null -` 完整解码 exit 0。
 * 「文件存在且 > 0 字节」不叫成功。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

/** @typedef {import('../../contracts/render').RenderOutput} RenderOutput */

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, timedOut: boolean }>}
 */
function run(command, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return new Promise((resolve) => {
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: String(err), timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/**
 * @typedef {Object} MediaProbe
 * @property {{ codec: string | null, width: number | null, height: number | null, fps: string | null,
 *   pixFmt?: string | null, profile?: string | null, codecTag?: string | null,
 *   durationSec: number | null, frames: number | null } | null} video
 * @property {{ codec: string | null, channels: number | null, sampleRate: number | null, durationSec: number | null } | null} audio
 * @property {{ durationSec: number | null, sizeBytes: number | null, formatName: string | null }} format
 */

/**
 * @param {string} file
 * @param {{ ffprobePath?: string }} [opts]
 * @returns {Promise<MediaProbe>}
 */
export async function probeMedia(file, opts = {}) {
  const ffprobePath = opts.ffprobePath ?? 'ffprobe';
  const result = await run(ffprobePath, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_streams',
    '-show_format',
    file,
  ]);

  if (result.code !== 0) {
    throw new Error(`ffprobe failed (${result.code}): ${result.stderr.trim()}`);
  }

  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error('ffprobe returned non-JSON output');
  }

  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const videoStream = streams.find((/** @type {any} */ s) => s.codec_type === 'video');
  const audioStream = streams.find((/** @type {any} */ s) => s.codec_type === 'audio');
  const formatDuration = toNumber(parsed.format?.duration);

  /** @type {MediaProbe} */
  const probe = {
    video: videoStream
      ? {
          codec: stringOrNull(videoStream.codec_name),
          width: toNumber(videoStream.width),
          height: toNumber(videoStream.height),
          fps: stringOrNull(videoStream.r_frame_rate ?? videoStream.avg_frame_rate),
          // P31：透明导出要证明 alpha 通道还在（yuva444p10le），只报 codec 不够
          pixFmt: stringOrNull(videoStream.pix_fmt),
          // P38：编码矩阵的回读面——hevc 必须是 hvc1，prores 要看 profile=HQ
          profile: stringOrNull(videoStream.profile),
          codecTag: stringOrNull(videoStream.codec_tag_string),
          durationSec: toNumber(videoStream.duration) ?? formatDuration,
          frames: toNumber(videoStream.nb_frames),
        }
      : null,
    audio: audioStream
      ? {
          codec: stringOrNull(audioStream.codec_name),
          channels: toNumber(audioStream.channels),
          sampleRate: toNumber(audioStream.sample_rate),
          durationSec: toNumber(audioStream.duration) ?? formatDuration,
        }
      : null,
    format: {
      durationSec: formatDuration,
      sizeBytes: toNumber(parsed.format?.size),
      formatName: stringOrNull(parsed.format?.format_name),
    },
  };
  return probe;
}

/**
 * 完整 decode：exit 0 且 stderr 无 error 行。
 * @param {string} file
 * @param {{ ffmpegPath?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: boolean, exitCode: number | null, stderr: string, timedOut: boolean, errorLines: string[] }>}
 */
export async function fullDecode(file, opts = {}) {
  const result = await run(
    opts.ffmpegPath ?? 'ffmpeg',
    ['-hide_banner', '-v', 'error', '-i', file, '-f', 'null', '-'],
    { timeoutMs: opts.timeoutMs ?? 120_000 },
  );
  const errorLines = result.stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && /error|invalid|corrupt|failed/i.test(line));
  return {
    ok: result.code === 0 && !result.timedOut && errorLines.length === 0,
    exitCode: result.code,
    stderr: result.stderr.trim(),
    timedOut: result.timedOut,
    errorLines,
  };
}

/**
 * @typedef {Object} VerifyExpectation
 * @property {string} [videoCodec]
 * @property {string} [videoTag]
 * @property {number} [width]
 * @property {number} [height]
 * @property {number} [fps]
 * @property {number} [durationSec]
 * @property {number} [durationToleranceSec]
 * @property {string} [audioCodec]
 * @property {number} [channels]
 * @property {number} [sampleRate]
 * @property {boolean} [requireAudio]
 */

/**
 * @param {string} file
 * @param {VerifyExpectation} expect
 * @param {{ ffmpegPath?: string, ffprobePath?: string }} [opts]
 * @returns {Promise<{ ok: boolean, code: 'OUTPUT_UNVERIFIED' | null, probe: MediaProbe | null, decode: { ok: boolean, exitCode: number | null, errorLines: string[] } | null, mismatches: Array<{ field: string, expected: unknown, actual: unknown }> }>}
 */
export async function verifyOutput(file, expect, opts = {}) {
  /** @type {Array<{ field: string, expected: unknown, actual: unknown }>} */
  const mismatches = [];

  let probe = null;
  try {
    probe = await probeMedia(file, opts);
  } catch (err) {
    return {
      ok: false,
      code: 'OUTPUT_UNVERIFIED',
      probe: null,
      decode: null,
      mismatches: [{ field: 'probe', expected: 'readable', actual: String(err) }],
    };
  }

  if (!probe.video) {
    mismatches.push({ field: 'video', expected: 'present', actual: 'missing' });
  } else {
    if (expect.videoCodec && probe.video.codec !== expect.videoCodec) {
      mismatches.push({ field: 'videoCodec', expected: expect.videoCodec, actual: probe.video.codec });
    }
    if (expect.videoTag && probe.video.codecTag !== expect.videoTag) {
      // hvc1 是 QuickTime/Apple 的硬要求；写成 hev1 在 mac 上直接放不出来
      mismatches.push({ field: 'videoTag', expected: expect.videoTag, actual: probe.video.codecTag });
    }
    if (expect.width !== undefined && probe.video.width !== expect.width) {
      mismatches.push({ field: 'width', expected: expect.width, actual: probe.video.width });
    }
    if (expect.height !== undefined && probe.video.height !== expect.height) {
      mismatches.push({ field: 'height', expected: expect.height, actual: probe.video.height });
    }
    if (expect.fps !== undefined) {
      const actual = rationalToNumber(probe.video.fps);
      if (actual === null || Math.abs(actual - expect.fps) > 0.01) {
        mismatches.push({ field: 'fps', expected: expect.fps, actual: probe.video.fps });
      }
    }
    if (expect.durationSec !== undefined) {
      const tolerance = expect.durationToleranceSec ?? 0.1;
      const actual = probe.video.durationSec ?? probe.format.durationSec;
      if (actual === null || Math.abs(actual - expect.durationSec) > tolerance) {
        mismatches.push({
          field: 'durationSec',
          expected: `${expect.durationSec}±${tolerance}`,
          actual,
        });
      }
    }
  }

  if (expect.requireAudio) {
    if (!probe.audio) {
      mismatches.push({ field: 'audio', expected: 'present', actual: 'missing' });
    } else {
      if (expect.audioCodec && probe.audio.codec !== expect.audioCodec) {
        mismatches.push({ field: 'audioCodec', expected: expect.audioCodec, actual: probe.audio.codec });
      }
      if (expect.channels !== undefined && probe.audio.channels !== expect.channels) {
        mismatches.push({ field: 'channels', expected: expect.channels, actual: probe.audio.channels });
      }
      if (expect.sampleRate !== undefined && probe.audio.sampleRate !== expect.sampleRate) {
        mismatches.push({ field: 'sampleRate', expected: expect.sampleRate, actual: probe.audio.sampleRate });
      }
    }
  }

  const decode = await fullDecode(file, { ffmpegPath: opts.ffmpegPath });
  if (!decode.ok) {
    mismatches.push({
      field: 'decode',
      expected: 'exit 0 with no errors',
      actual: decode.timedOut ? 'timeout' : `exit ${decode.exitCode}`,
    });
  }

  return {
    ok: mismatches.length === 0,
    code: mismatches.length === 0 ? null : 'OUTPUT_UNVERIFIED',
    probe,
    decode,
    mismatches,
  };
}

/**
 * 音画时长差（秒），任一侧缺失返回 null。
 * @param {MediaProbe} probe
 * @returns {number | null}
 */
export function avSyncDeltaSec(probe) {
  if (!probe.video || !probe.audio) return null;
  const v = probe.video.durationSec;
  const a = probe.audio.durationSec;
  if (v === null || a === null) return null;
  return Math.abs(v - a);
}

/**
 * @param {string | null} fps
 * @returns {number | null}
 */
export function rationalToNumber(fps) {
  if (!fps) return null;
  const parts = fps.split('/').map(Number);
  const num = parts[0] ?? Number.NaN;
  const den = parts[1] ?? 1;
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  return num / den;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function stringOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * @param {string} file
 * @returns {Promise<{ bytes: number, sha256: string }>}
 */
export async function fileDigest(file) {
  const crypto = await import('node:crypto');
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(file, 'r');
  try {
    for await (const chunk of handle.createReadStream()) hash.update(/** @type {Buffer} */ (chunk));
  } finally {
    await handle.close();
  }
  const stat = await fs.stat(file);
  return { bytes: stat.size, sha256: hash.digest('hex') };
}
