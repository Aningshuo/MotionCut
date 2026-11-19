/**
 * 响度标准化（P34 / RD-014）。
 *
 * 导出器一直有个洞：画面能压、音量能调、区间能裁，但**成片响度**要用户自己拉。
 * 交到平台（YouTube/B站/播客）手上是 -18 LUFS 还是 -8 LUFS，全看素材本身的运气。
 * 本文件把这件事收进导出：两遍 `loudnorm`（先测后规范化），目标是可交付的响度。
 *
 * ## 三档
 *
 * | `--loudness` | I | TP | LRA | 用途 |
 * |---|---|---|---|---|
 * | `off`（默认） | — | — | — | 一行都不多走，产物逐字节不变 |
 * | `streaming` | −14 LUFS | ≤ −1.0 dBTP | 11 | 视频平台（YouTube/Spotify 的口径） |
 * | `broadcast` | −23 LUFS | ≤ −1.0 dBTP | 15 | 广播（EBU R128） |
 *
 * ## 为什么是两遍
 *
 * 单遍 `loudnorm` 是**动态**的（逐段调增益），对音乐/对话会压掉起伏。
 * 两遍的写法是：第一遍只测（`-f null`，输出 JSON 到 stderr），第二遍带上
 * `measured_*` 走 `linear=true` —— 整条音轨只用**一个常数增益**，动态一点不动。
 * 只有「线性增益会把 TP 顶过线」时，loudnorm 才自己收敛到能保住 TP 的增益
 * （代价是 I 到不了目标，报告里会如实写 `applied` 与实测值）。
 *
 * ## TP 为什么留 0.5dB 余量
 *
 * 我们标准化的是**混音 WAV**，交付的是 **AAC**。AAC 是有损的，重建后的采样点
 * 可能比源高零点几 dB（实测 192k 立体声在 −1.0 dBTP 附近基本不超，但没保证）。
 * 所以送进编码器的目标定成 `TP = −1.5 dBTP`，交付件实测仍要求 ≤ −1.0 dBTP。
 * 报告里两个数都给：`encodeTarget.TP`（送编码器）与 `delivered.TP`（交付件实测）。
 *
 * ## 边界（任务书 §4.5）
 *
 * - **全静音**：`loudnorm` 的 `input_i` 会是 `-inf`，没有可归一的量 → `LOUDNESS_UNMEASURABLE`，
 *   **继续出片**（用原始混音），并写清为什么。把静音工程判成失败是错的：
 *   静音是合法的作品，不是坏文件。
 * - **单声道源**：混音阶段已经 `-ac 2` 上混，响度测量在立体声混音上做，不受影响。
 * - **超短区间（<1s）**：`loudnorm` 的积分窗口只有 400ms 块，样本太少时它给的值
 *   不可信（甚至给 `-inf`）；同样按 `UNMEASURABLE` 处理，不猜。
 *
 * ## 与进度事件的关系
 *
 * 两遍都跑在**混音 WAV** 上（8s 立体声 f32 才 3MB），不是全片视频解码；
 * 整个过程在既有的 `muxing` 阶段内完成，不产生新的帧进度，也不会让帧号回退。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

/** 三档预设。`off` 用 null 表示「什么都不做」，避免调用点写成 `preset.I ?? ...` 这种含糊。 */
export const LOUDNESS_PRESETS = Object.freeze({
  off: null,
  streaming: Object.freeze({ I: -14, TP: -1.0, LRA: 11, label: 'streaming', note: 'video platforms (YouTube/Spotify)' }),
  broadcast: Object.freeze({ I: -23, TP: -1.0, LRA: 15, label: 'broadcast', note: 'EBU R128' }),
});

/** 送编码器时额外预留的 TP 余量（dB）。交付件实测仍按 −1.0 判。 */
export const TP_HEADROOM_DB = 0.5;

/** 低于这个积分响度就当「测不到」（EBU R128 的绝对门限是 −70 LUFS）。 */
export const UNMEASURABLE_LUFS = -70;

export class LoudnessError extends Error {
  /** @param {string} code @param {string} message @param {Record<string, any>} [extra] */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'LoudnessError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * `--loudness` 归一。缺省 = `off`（行为不变）。
 * @param {string | undefined | null} raw
 * @returns {'off' | 'streaming' | 'broadcast'}
 */
export function resolveLoudnessPreset(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return 'off';
  const text = String(raw).trim().toLowerCase();
  if (text === 'off' || text === 'none') return 'off';
  if (text === 'streaming' || text === 'stream') return 'streaming';
  if (text === 'broadcast' || text === 'ebu') return 'broadcast';
  throw new LoudnessError(
    'E_USAGE',
    `--loudness must be off|streaming|broadcast, got "${raw}"`,
  );
}

/**
 * 跑一次 ffmpeg 并拿回 stdout/stderr（不抛：调用方自己看 exit code 决定死活）。
 * @param {string[]} args
 * @param {{ ffmpegPath?: string, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runCapture(args, opts = {}) {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new LoudnessError('CANCELLED', 'loudness cancelled before ffmpeg started'));
      return;
    }
    const child = spawn(opts.ffmpegPath ?? 'ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const onAbort = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk) => {
      stdout = `${stdout}${String(chunk)}`.slice(-200000);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-200000);
    });
    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(new LoudnessError('CODEC_UNAVAILABLE', `ffmpeg failed to start: ${err.message}`));
    });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) {
        reject(new LoudnessError('CANCELLED', 'loudness cancelled'));
        return;
      }
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

/**
 * 从 loudnorm 的 stderr 里抠出那段 JSON。
 *
 * 不用 `JSON.parse` 整块：静音时 ffmpeg 打的是 `"input_i" : "-inf"`，不是合法 JSON。
 * 逐字段正则更稳，也免得为了一个字段去改文本再 parse（改了就不是原文了）。
 * @param {string} stderr
 */
export function parseLoudnormJson(stderr) {
  const blocks = stderr.split('\n{');
  /** @type {Record<string, string>} */
  const fields = {};
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const chunk = blocks[i] ?? '';
    const text = i === 0 ? chunk : `{${chunk}`;
    if (!text.includes('"input_i"')) continue;
    for (const name of [
      'input_i',
      'input_tp',
      'input_lra',
      'input_thresh',
      'output_i',
      'output_tp',
      'output_lra',
      'output_thresh',
      'normalization_type',
      'target_offset',
    ]) {
      const match = new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`).exec(text);
      if (match && match[1] !== undefined) fields[name] = match[1];
    }
    break;
  }
  return fields;
}

/**
 * 从 ebur128 的 summary 里抠出 I / LRA / TP。
 * @param {string} stderr
 * @returns {{ I: number | null, LRA: number | null, TP: number | null, summary: string }}
 */
export function parseEbur128(stderr) {
  const at = stderr.lastIndexOf('Summary:');
  if (at < 0) return { I: null, LRA: null, TP: null, summary: '' };
  const summary = stderr.slice(at);
  const grab = (/** @type {RegExp} */ re) => {
    const match = re.exec(summary);
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
  };
  return {
    I: grab(/I:\s+(-?(?:\d+(?:\.\d+)?|inf))\s+LUFS/),
    LRA: grab(/LRA:\s+(-?(?:\d+(?:\.\d+)?|inf))\s+LU/),
    TP: grab(/Peak:\s+(-?(?:\d+(?:\.\d+)?|inf))\s+dBFS/),
    summary: summary.split('\n').filter((line) => line.trim().length > 0).slice(0, 12).join('\n'),
  };
}

/**
 * 第一遍：只测。
 * @param {string} wavPath
 * @param {{ target: { I: number, TP: number, LRA: number }, ffmpegPath?: string, signal?: AbortSignal }} opts
 */
export async function measureLoudness(wavPath, opts) {
  const { I, TP, LRA } = opts.target;
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'info',
    '-i', wavPath,
    '-af', `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:print_format=json`,
    '-f', 'null', '-',
  ];
  const result = await runCapture(args, opts);
  const fields = parseLoudnormJson(result.stderr);
  return {
    exitCode: result.code,
    fields,
    raw: result.stderr,
    stderrTail: result.stderr.trim().split('\n').slice(-24).join('\n'),
  };
}

/**
 * 在**交付件**上量最终响度（`ebur128`，带真峰值）。
 * `-vn` 是关键：不然后台会把整条视频也解一遍，白白多花几秒。
 * @param {string} file
 * @param {{ ffmpegPath?: string, signal?: AbortSignal }} [opts]
 */
export async function measureDeliveredLoudness(file, opts = {}) {
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'info',
    '-i', file,
    '-vn',
    '-af', 'ebur128=peak=true',
    '-f', 'null', '-',
  ];
  const result = await runCapture(args, opts);
  const parsed = parseEbur128(result.stderr);
  return {
    exitCode: result.code,
    integratedLufs: parsed.I,
    lra: parsed.LRA,
    truePeakDbtp: parsed.TP,
    summary: parsed.summary,
    raw: result.stderr,
  };
}

/**
 * 两遍 loudnorm 的核心：量 → 规范化 → 落一份新 wav。
 *
 * **不改原混音**：输入 `mix.wav` 原样留着。这样 `off` 与失败回退都指向同一份数据，
 * 也不用担心「规范化写坏了原本要交付的东西」。
 *
 * @param {{
 *   wavPath: string,
 *   outPath: string,
 *   preset: 'streaming' | 'broadcast',
 *   ffmpegPath?: string,
 *   signal?: AbortSignal,
 * }} opts
 * @returns {Promise<any>} 报告结构（`--json` 的 `loudness` 段就是它的精简版）：
 *   `{ measurable, code, reason, path, preset, target, encodeTarget,
 *      input: {I,TP,LRA,thresh}, output: {I,TP,LRA}, gainDb, applied, measured, raw }`
 */
export async function normalizeLoudness(opts) {  const preset = /** @type {'streaming' | 'broadcast'} */ (opts.preset);
  const target = LOUDNESS_PRESETS[preset];
  if (!target) throw new LoudnessError('E_USAGE', `unknown loudness preset "${String(preset)}"`);
  const encodeTarget = { I: target.I, TP: Number((target.TP - TP_HEADROOM_DB).toFixed(2)), LRA: target.LRA };

  const pass1 = await measureLoudness(opts.wavPath, { target, ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}), ...(opts.signal ? { signal: opts.signal } : {}) });
  const fields = pass1.fields;
  const inputI = Number(fields.input_i);
  const inputTp = Number(fields.input_tp);
  const inputLra = Number(fields.input_lra);
  const inputThresh = Number(fields.input_thresh);

  /** @type {Record<string, any>} */
  const base = {
    preset,
    target: { I: target.I, TP: target.TP, LRA: target.LRA },
    encodeTarget,
    tpHeadroomDb: TP_HEADROOM_DB,
    input: {
      I: Number.isFinite(inputI) ? inputI : null,
      TP: Number.isFinite(inputTp) ? inputTp : null,
      LRA: Number.isFinite(inputLra) ? inputLra : null,
      thresh: Number.isFinite(inputThresh) ? inputThresh : null,
    },
    measured: fields,
    raw: { pass1: pass1.stderrTail, pass2: '' },
  };

  // 「测不到」不是失败：静音/超短本来就没有可归一的量。交给调用方继续出片。
  const unmeasurable = (/** @type {string} */ reason) => ({
    ...base,
    measurable: false,
    code: 'LOUDNESS_UNMEASURABLE',
    reason,
    path: opts.wavPath,
    output: { I: null, TP: null, LRA: null },
    gainDb: null,
    peakGainDb: null,
    uniformGain: null,
    applied: null,
  });

  if (pass1.exitCode !== 0) {
    return unmeasurable(`loudnorm measurement exited ${pass1.exitCode}: ${pass1.stderrTail.split('\n').slice(-2).join(' ')}`);
  }
  if (!Number.isFinite(inputI)) {
    return unmeasurable(`loudnorm reported input_i="${fields.input_i ?? 'missing'}" (no integrated loudness to normalize)`);
  }
  if (inputI <= UNMEASURABLE_LUFS) {
    return unmeasurable(`input integrated loudness ${inputI} LUFS is at/below ${UNMEASURABLE_LUFS} LUFS (silence or far too short)`);
  }

  const filter = [
    `loudnorm=I=${target.I}`,
    `TP=${encodeTarget.TP}`,
    `LRA=${target.LRA}`,
    `measured_I=${fields.input_i}`,
    `measured_TP=${fields.input_tp}`,
    `measured_LRA=${fields.input_lra}`,
    `measured_thresh=${fields.input_thresh}`,
    `offset=${fields.target_offset ?? '0.00'}`,
    // 线性：整条轨只乘一个常数增益，动态一点不动。只有 TP 顶到线时才由 loudnorm 收敛。
    'linear=true',
    'print_format=json',
  ].join(':');

  await fs.mkdir(path.dirname(opts.outPath), { recursive: true });
  await fs.unlink(opts.outPath).catch(() => {});
  const pass2 = await runCapture(
    [
      '-hide_banner', '-nostdin', '-loglevel', 'info', '-y',
      '-i', opts.wavPath,
      '-af', filter,
      '-ar', '48000', '-ac', '2',
      '-c:a', 'pcm_f32le',
      opts.outPath,
    ],
    { ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}), ...(opts.signal ? { signal: opts.signal } : {}) },
  );
  if (pass2.code !== 0) {
    // 规范化失败与「测不到」不是一回事：用户明确要了 streaming/broadcast，
    // 交一个没标准化的片子还报成功才是撒谎。这里让它失败。
    throw new LoudnessError(
      'JOB_FAILED',
      `loudnorm normalization exited ${pass2.code}: ${pass2.stderr.trim().split('\n').slice(-2).join(' ')}`,
    );
  }
  const pass2Fields = parseLoudnormJson(pass2.stderr);

  // 第二遍的 output_* 是**编码器输入**的响度（loudnorm 自己算的），再用 ebur128 独立复核一遍
  const verified = await measureDeliveredLoudness(opts.outPath, {
    ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const outputI = verified.integratedLufs ?? (Number.isFinite(Number(pass2Fields.output_i)) ? Number(pass2Fields.output_i) : null);
  const outputTp = verified.truePeakDbtp;
  // 独立于 loudnorm 标签的判据：**积分增益**（output_i − input_i）与**峰值增益**
  // （output_tp − input_tp）一致 ⇒ 整条轨乘的是同一个常数，动态一点没动。
  // 两个数差得远 ⇒ 真走了动态。ffmpeg 的 `normalization_type` 字段在个别素材上
  // 与实际行为不符（实测 1kHz 纯音：标签 dynamic，两个增益都是 +7.1dB），所以报告里
  // 以这两个实测增益为准，标签原样保留给需要核对的人。
  const integratedGain =
    Number.isFinite(inputI) && outputI !== null && Number.isFinite(outputI)
      ? Number((outputI - inputI).toFixed(2))
      : null;
  const peakGain =
    Number.isFinite(inputTp) && outputTp !== null && Number.isFinite(outputTp)
      ? Number((outputTp - inputTp).toFixed(2))
      : null;

  return {
    ...base,
    measurable: true,
    code: null,
    reason: null,
    path: opts.outPath,
    output: { I: outputI, TP: outputTp, LRA: verified.lra },
    gainDb: integratedGain,
    peakGainDb: peakGain,
    // 两个增益之差 ≤0.3dB 就算常数增益（0.3 是 8bit 量化的余量，不是审美）
    uniformGain: integratedGain !== null && peakGain !== null && Math.abs(integratedGain - peakGain) <= 0.3,
    applied: pass2Fields.normalization_type ?? (fields.input_i ? 'linear' : null),
    measured: { ...fields, ...prefixKeys('pass2_', pass2Fields) },
    raw: { pass1: pass1.stderrTail, pass2: verified.summary },
  };
}

/**
 * @param {string} prefix
 * @param {Record<string, string>} fields
 */
function prefixKeys(prefix, fields) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(fields)) out[`${prefix}${key}`] = value;
  return out;
}

/**
 * CLI 结果里的 `loudness` 段（`--json` 直接给这一段，人读模式压成一行）。
 * @param {any} report
 */
export function summarizeLoudness(report) {
  if (!report) return null;
  return {
    preset: report.preset,
    target: report.target,
    encodeTarget: report.encodeTarget,
    input: report.input,
    output: report.output,
    delivered: report.delivered ?? null,
    gainDb: report.gainDb,
    peakGainDb: report.peakGainDb ?? null,
    uniformGain: report.uniformGain ?? null,
    applied: report.applied,
    // loudnorm 第一遍的原始字段（字符串原样），第二遍的 `output_*` 前缀成 `pass2_*`：
    // 「测量原文」就是这个，别在报告里只留一个四舍五入过的数字。
    measured: report.measured ?? null,
    code: report.code ?? null,
    reason: report.reason ?? null,
    passes: 2,
  };
}

/**
 * 人读一行：`loudness=streaming -21.1→-14.0 LUFS (+7.1dB) TP -14.0dBTP ok`
 * @param {any} report
 */
export function formatLoudnessLine(report) {
  if (!report) return 'loudness=off';
  if (report.code === 'LOUDNESS_UNMEASURABLE') {
    return `loudness=${report.preset} UNMEASURABLE (${report.reason ?? 'no measurable loudness'})`;
  }
  const fixed = (/** @type {number | null} */ value) => (value === null || value === undefined ? '?' : Number(value).toFixed(1));
  const delivered = report.delivered ?? report.output ?? {};
  const tp = delivered.truePeakDbtp ?? delivered.TP ?? null;
  const gain = report.gainDb === null || report.gainDb === undefined ? '?' : `${report.gainDb > 0 ? '+' : ''}${Number(report.gainDb).toFixed(1)}`;
  return `loudness=${report.preset} ${fixed(report.input?.I)}→${fixed(report.output?.I)} LUFS (${gain}dB) TP ${fixed(tp)}dBTP`;
}
