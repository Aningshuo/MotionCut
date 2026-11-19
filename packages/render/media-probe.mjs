/**
 * 素材体检（P21-GOP-ADVISOR）。
 *
 * 为什么需要它：R10 的对照实验把「导出慢」拆开了——同一份 30 秒工程、同样的 3 通道，
 * 素材是 1s GOP 时 134s，素材整段只有 1 个关键帧时 233s。也就是说用户抱怨的慢，
 * 很大一块**由素材的编码方式决定**，不是渲染实现的问题。
 * 这一层只回答一个事实问题：这条素材的关键帧有多稀。
 *
 * 口径：
 * - `avgGopSec = durationSec / keyframeCount`。整段只有 1 个关键帧时它等于时长（正确：
 *   从 0 到片尾都是同一个 GOP）；1s GOP 素材上它 ≈ 1。
 * - `maxGopSec` 取「相邻关键帧间隔」与「首帧前 / 末关键帧到片尾」三者中的最大值。
 * - 关键帧只用 `-skip_frame nokey` 取时间戳，**不做整片解码**。
 * - 扫描有硬预算（默认 5s）。超预算就退化成 `-read_intervals` 抽样并标 `sampled: true`，
 *   同时在 `note` 里写清楚抽样口径与误差方向（maxGop 只是下界）。
 *
 * 纯读：不写文件、不改工程、不联网。
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';

export const MEDIA_PROBE_VERSION = '1.0.0';

/** 关键帧扫描的时间预算（毫秒）。超过它就走抽样，别让一次导出前体检卡 30 秒。 */
export const DEFAULT_MAX_SCAN_MS = 5000;

/** 抽样窗口：个数与单窗时长。窗口至少 2s，否则长 GOP 素材窗口里一个关键帧都没有。 */
const SAMPLE_WINDOWS = 6;
const SAMPLE_MIN_WINDOW_SEC = 2;

const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * 素材体检的稳定错误码。
 * @typedef {'MEDIA_MISSING' | 'FFPROBE_FAILED' | 'NO_VIDEO_STREAM'} MediaProbeCode
 */
export class MediaProbeError extends Error {
  /**
   * @param {MediaProbeCode} code
   * @param {string} detail
   * @param {{ cause?: unknown }} [extra]
   */
  constructor(code, detail, extra = {}) {
    super(`${code}: ${detail}`);
    this.name = 'MediaProbeError';
    this.code = code;
    this.detail = detail;
    if (extra.cause !== undefined) this.cause = extra.cause;
  }
}

/**
 * @typedef {Object} VideoProfile
 * @property {string} path 绝对路径
 * @property {number | null} durationSec
 * @property {number | null} fps 平均帧率（`30000/1001` 会算成 29.97）
 * @property {number | null} frames 容器/码流里报的帧数（可能为 null）
 * @property {number} keyframeCount 关键帧个数（sampled 时为抽样推算值）
 * @property {number | null} avgGopSec 平均关键帧间隔 = durationSec / keyframeCount
 * @property {number | null} maxGopSec 观察到的最长关键帧间隔（sampled 时是下界）
 * @property {string | null} codec
 * @property {string | null} pixFmt
 * @property {number | null} bitrate 比特率（bps）
 * @property {boolean} hasVideo
 * @property {boolean} hasAudio
 * @property {number | null} sizeBytes
 * @property {number} scanMs 本次体检（基础探测 + 关键帧扫描）总耗时
 * @property {'full' | 'sampled' | 'none'} scanMethod
 * @property {boolean} sampled 是否走了抽样（scanMethod === 'sampled'）
 * @property {string | null} note 需要人看的一句话（抽样口径、无视频流、异常回退等）
 */

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ code: number, stdout: string, stderr: string, timedOut: boolean, ms: number }>}
 */
function run(bin, args, opts = {}) {
  return new Promise((resolve) => {
    const started = performance.now();
    const done = (/** @type {number} */ code, /** @type {string} */ stdout, /** @type {string} */ stderr, /** @type {boolean} */ timedOut) => {
      resolve({ code, stdout, stderr, timedOut, ms: performance.now() - started });
    };
    execFile(
      bin,
      args,
      {
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        ...(opts.timeoutMs !== undefined && opts.timeoutMs > 0
          ? { timeout: Math.max(1, Math.ceil(opts.timeoutMs)), killSignal: 'SIGKILL' }
          : {}),
      },
      (/** @type {any} */ err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        const timedOut = Boolean(err && (err.killed === true || err.signal === 'SIGKILL'));
        done(code, String(stdout ?? ''), String(stderr ?? ''), timedOut);
      },
    );
  });
}

/**
 * `30000/1001` → 29.97；`30/1` → 30。
 * @param {unknown} raw
 * @returns {number | null}
 */
function parseRate(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '' || text === '0/0' || text === 'N/A') return null;
  const [numText, denText] = text.split('/');
  const num = Number(numText);
  const den = denText === undefined ? 1 : Number(denText);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  const value = num / den;
  return Number.isFinite(value) && value > 0 ? Math.round(value * 1000) / 1000 : null;
}

/**
 * @param {unknown} raw
 * @returns {number | null}
 */
function toNumber(raw) {
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * @param {number} value
 * @returns {number}
 */
function round3(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * 从 `csv=p=0` 的输出里取时间戳列。
 * ffprobe 8 已经不再输出 `pkt_pts_time`（本机 8.1.2 上该字段直接为空），
 * 所以这里同时兼容两种列顺序：取第一个能解析成数字的字段。
 * @param {string} stdout
 * @returns {number[]}
 */
function parseTimes(stdout) {
  /** @type {number[]} */
  const out = [];
  for (const line of stdout.split('\n')) {
    const text = line.trim();
    if (text === '') continue;
    for (const cell of text.split(',')) {
      const value = Number(cell);
      if (Number.isFinite(value)) {
        out.push(value);
        break;
      }
    }
  }
  out.sort((a, b) => a - b);
  return out;
}

/**
 * 抽样窗口：把整片按时间切成若干段，每段取 `%+windowSec`。
 * 窗口不少于 2s：窗口比 GOP 还短时，窗口内一个关键帧都没有，抽样就退化成噪声。
 * @param {number} durationSec
 * @returns {{ spec: string, windowSec: number, starts: number[] }}
 */
function sampleWindows(durationSec) {
  const windowSec = Math.max(SAMPLE_MIN_WINDOW_SEC, Math.min(10, durationSec / (SAMPLE_WINDOWS * 2)));
  /** @type {number[]} */
  const starts = [];
  const span = durationSec - windowSec;
  for (let i = 0; i < SAMPLE_WINDOWS; i += 1) {
    const at = span <= 0 ? 0 : (span * i) / (SAMPLE_WINDOWS - 1);
    starts.push(Math.round(at * 1000) / 1000);
  }
  const spec = starts.map((at) => `${at}%+${Math.round(windowSec * 1000) / 1000}`).join(',');
  return { spec, windowSec, starts };
}

/**
 * 从关键帧时间戳算 GOP 事实。
 * @param {number[]} times 排序后的关键帧时间戳（秒）
 * @param {number | null} durationSec
 * @returns {{ keyframeCount: number, avgGopSec: number | null, maxGopSec: number | null }}
 */
function gopFacts(times, durationSec) {
  const count = times.length;
  if (count === 0) return { keyframeCount: 0, avgGopSec: null, maxGopSec: null };
  if (durationSec === null || durationSec <= 0) {
    return { keyframeCount: count, avgGopSec: null, maxGopSec: null };
  }
  // avgGop = 时长 / 关键帧数：单关键帧素材恰好等于时长，1s GOP 素材恰好 ≈1。
  const avgGopSec = round3(durationSec / count);
  /** @type {number[]} */
  const gaps = [];
  const first = times[0] ?? 0;
  const last = times[count - 1] ?? first;
  const head = first - 0;
  if (head > 0) gaps.push(head);
  for (let i = 1; i < count; i += 1) gaps.push((times[i] ?? 0) - (times[i - 1] ?? 0));
  const tail = durationSec - last;
  if (tail > 0) gaps.push(tail);
  const maxGopSec = gaps.length === 0 ? avgGopSec : round3(Math.max(...gaps));
  return { keyframeCount: count, avgGopSec, maxGopSec };
}

/**
 * 素材体检主入口。
 *
 * @param {string} file
 * @param {{ ffprobePath?: string, maxScanMs?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<VideoProfile>}
 */
export async function probeVideoProfile(file, opts = {}) {
  const ffprobePath = opts.ffprobePath ?? 'ffprobe';
  const maxScanMs = Number.isFinite(opts.maxScanMs) ? Number(opts.maxScanMs) : DEFAULT_MAX_SCAN_MS;
  const started = performance.now();

  let stat;
  try {
    stat = await fs.stat(file);
  } catch (err) {
    throw new MediaProbeError('MEDIA_MISSING', `${file} does not exist`, { cause: err });
  }
  if (!stat.isFile()) throw new MediaProbeError('MEDIA_MISSING', `${file} is not a file`);

  // 1) 基础信息（时长/帧率/codec/pix_fmt/码率）。这一步恒定很便宜，不计入扫描预算。
  const base = await run(ffprobePath, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    file,
  ]);
  if (base.code !== 0) {
    throw new MediaProbeError('FFPROBE_FAILED', `${ffprobePath} exited ${base.code}: ${base.stderr.trim().slice(0, 400)}`);
  }
  let parsedBase = null;
  try {
    parsedBase = JSON.parse(base.stdout);
  } catch (err) {
    throw new MediaProbeError('FFPROBE_FAILED', 'ffprobe returned non-JSON output', { cause: err });
  }
  const streams = Array.isArray(parsedBase?.streams) ? parsedBase.streams : [];
  const videoStream = streams.find((/** @type {any} */ s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audioStream = streams.find((/** @type {any} */ s) => s.codec_type === 'audio');
  const formatDuration = toNumber(parsedBase?.format?.duration);
  const durationSec = formatDuration ?? (videoStream ? toNumber(videoStream.duration) : null);

  /** @type {VideoProfile} */
  const profile = {
    path: file,
    durationSec: durationSec === null ? null : round3(durationSec),
    fps: videoStream ? parseRate(videoStream.r_frame_rate ?? videoStream.avg_frame_rate) : null,
    frames: videoStream ? toNumber(videoStream.nb_frames) : null,
    keyframeCount: 0,
    avgGopSec: null,
    maxGopSec: null,
    codec: videoStream ? (typeof videoStream.codec_name === 'string' ? videoStream.codec_name : null) : null,
    pixFmt: videoStream ? (typeof videoStream.pix_fmt === 'string' ? videoStream.pix_fmt : null) : null,
    bitrate:
      toNumber(parsedBase?.format?.bit_rate) ?? (videoStream ? toNumber(videoStream.bit_rate) : null) ?? null,
    hasVideo: Boolean(videoStream),
    hasAudio: Boolean(audioStream),
    sizeBytes: stat.size,
    scanMs: 0,
    scanMethod: 'none',
    sampled: false,
    note: null,
  };

  if (!videoStream) {
    profile.note = 'no video stream (audio-only or still): no keyframes to measure';
    profile.scanMs = Math.round(performance.now() - started);
    return profile;
  }

  // 2) 关键帧扫描。预算 = maxScanMs - 已经花掉的基础探测时间。
  const budgetMs = Math.max(0, maxScanMs - (performance.now() - started));
  const remainingFetch = () => Math.max(0, maxScanMs - (performance.now() - started));

  /** @type {number[] | null} */
  let times = null;
  /** @type {string | null} */
  let fallbackReason = null;

  if (budgetMs >= 50) {
    const scan = await run(
      ffprobePath,
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-skip_frame',
        'nokey',
        '-show_entries',
        'frame=pts_time',
        '-of',
        'csv=p=0',
        file,
      ],
      { timeoutMs: budgetMs },
    );
    if (scan.timedOut) fallbackReason = `full keyframe scan exceeded ${maxScanMs}ms`;
    else if (scan.code !== 0) fallbackReason = `full keyframe scan failed (exit ${scan.code})`;
    else times = parseTimes(scan.stdout);
  } else {
    fallbackReason = `keyframe scan budget used up by base probe (${maxScanMs}ms)`;
  }

  if (times !== null) {
    profile.scanMethod = 'full';
    const facts = gopFacts(times, durationSec);
    profile.keyframeCount = facts.keyframeCount;
    profile.avgGopSec = facts.avgGopSec;
    profile.maxGopSec = facts.maxGopSec;
    profile.scanMs = Math.round(performance.now() - started);
    if (facts.keyframeCount === 0) profile.note = 'ffprobe reported no keyframes (unusual container); GOP unknown';
    return profile;
  }

  // 3) 抽样回退：只读若干时间窗，标 sampled，把口径写进 note。
  const sampled = await sampleKeyframes(ffprobePath, file, durationSec, {
    timeoutMs: Math.max(1000, Math.min(maxScanMs, remainingFetch() || 1000)),
  });
  profile.scanMethod = 'sampled';
  profile.sampled = true;
  profile.keyframeCount = sampled.keyframeCount;
  profile.avgGopSec = sampled.avgGopSec;
  profile.maxGopSec = sampled.maxGopSec;
  profile.scanMs = Math.round(performance.now() - started);
  const why = fallbackReason ?? 'sampled';
  const windowText = `${Math.round(sampled.windowSec * 1000) / 1000}s`;
  profile.note =
    sampled.keyframeCount === 0
      ? `${why}; sampled ${sampled.windows} windows (${windowText} each) saw no keyframes: GOP longer than window, spacing unknown`
      : `${why}; sampled ${sampled.windows} windows (${windowText} each): avgGop is estimated from within-window spacing, maxGop is a lower bound`;
  return profile;
}

/**
 * `-read_intervals` 抽样。
 *
 * 只在窗口内取关键帧，所以「整片解码」这一步被彻底避开；代价是：
 * - avgGop 只能从窗口内的相邻关键帧间隔估，
 * - maxGop 只是观察到的最大值（真正的最大间隔可能落在窗口之外）。
 * @param {string} ffprobePath
 * @param {string} file
 * @param {number | null} durationSec
 * @param {{ timeoutMs: number }} opts
 * @returns {Promise<{ keyframeCount: number, avgGopSec: number | null, maxGopSec: number | null, windows: number, windowSec: number }>}
 */
async function sampleKeyframes(ffprobePath, file, durationSec, opts) {
  if (durationSec === null || durationSec <= 0) {
    return { keyframeCount: 0, avgGopSec: null, maxGopSec: null, windows: 0, windowSec: 0 };
  }
  const { spec, windowSec, starts } = sampleWindows(durationSec);
  const scan = await run(
    ffprobePath,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-skip_frame',
      'nokey',
      '-show_entries',
      'frame=pts_time',
      '-of',
      'csv=p=0',
      '-read_intervals',
      spec,
      file,
    ],
    { timeoutMs: opts.timeoutMs },
  );
  if (scan.code !== 0 || scan.timedOut) {
    return { keyframeCount: 0, avgGopSec: null, maxGopSec: null, windows: starts.length, windowSec };
  }
  const times = parseTimes(scan.stdout);
  /** @type {number[]} */
  const gaps = [];
  for (const start of starts) {
    const end = start + windowSec;
    const inside = times.filter((t) => t >= start - 1e-6 && t <= end + 1e-6);
    for (let i = 1; i < inside.length; i += 1) {
      const gap = (inside[i] ?? 0) - (inside[i - 1] ?? 0);
      if (gap > 1e-6) gaps.push(gap);
    }
  }
  if (gaps.length === 0) {
    return { keyframeCount: times.length, avgGopSec: null, maxGopSec: null, windows: starts.length, windowSec };
  }
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)] ?? 0;
  const avgGopSec = round3(median);
  const keyframeCount = avgGopSec > 0 ? Math.max(1, Math.round(durationSec / avgGopSec)) : times.length;
  return {
    keyframeCount,
    avgGopSec,
    maxGopSec: round3(gaps[gaps.length - 1] ?? 0),
    windows: starts.length,
    windowSec,
  };
}

/**
 * 一次体检多条素材：去重 + 并发（每个 ffprobe 是独立进程，2~3 条并起来几乎不互相拖）。
 * @param {string[]} files
 * @param {{ ffprobePath?: string, maxScanMs?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<VideoProfile[]>}
 */
export async function probeVideoProfiles(files, opts = {}) {
  const unique = Array.from(new Set(files.map((f) => String(f))));
  /** @type {VideoProfile[]} */
  const out = [];
  for (const file of unique) {
    if (opts.signal?.aborted) throw new MediaProbeError('FFPROBE_FAILED', 'probe cancelled');
    out.push(await probeVideoProfile(file, opts));
  }
  return out;
}

/** 方便调用方判断「这条素材是不是稀关键帧」：默认门槛 5s（R10 的经验分界线）。 */
export const SPARSE_GOP_SEC = 5;

/**
 * @param {VideoProfile} profile
 * @param {number} [thresholdSec]
 * @returns {boolean}
 */
export function isSparseGop(profile, thresholdSec = SPARSE_GOP_SEC) {
  const avg = profile.avgGopSec;
  return typeof avg === 'number' && avg > thresholdSec;
}
