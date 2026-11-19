/**
 * 音频 stems 导出（P18）：每条音频片段一个 wav，外加一份 mix.wav。
 *
 * 不写第二套混音器：stem 就是把 `audioMix` 的 clips 拆成"每份只含一条"的 spec，
 * 交给 P11 的 `renderMix` 各跑一遍。这样 stem 与 mix 走的是**同一段 DSP**
 * （同样的采样率/声道/衰减/软限幅），stems 相加与 mix 的差别只剩限幅器。
 *
 * 每条 stem 都是整片长度而不是片段长度：stem 要能直接叠回时间线才有意义。
 */

import path from 'node:path';

import { renderMix } from './audio-mix.mjs';

/**
 * @typedef {{ src: string, at: number, time: number[], volume: number, speed: number, fade: number[] }} StemClip
 */

/**
 * 把一条音频片段包成"只有它"的混音 spec（整片长度）。
 * @param {{ duration: number, sampleRate?: number, channels?: number }} base
 * @param {StemClip} clip
 */
export function stemSpec(base, clip) {
  return {
    duration: base.duration,
    sampleRate: base.sampleRate ?? 48000,
    channels: base.channels ?? 2,
    clips: [
      {
        src: clip.src,
        at: clip.at,
        time: [...clip.time],
        volume: clip.volume,
        speed: clip.speed,
        fade: [...clip.fade],
      },
    ],
  };
}

/**
 * 文件名安全化：片段 id 可能带空格/斜杠，不能直接当文件名。
 *
 * 保留 Unicode 字母数字（`\p{L}\p{N}`）而不是只留 `\w`：这条产品的片段 id
 * 大量是中文（「人声 01」「旁白」），用 `\w` 会把中文全吃掉、只剩 `01`，
 * 用户拿到一堆分不清谁是谁的 wav。真正的非法字符只有路径分隔符和 Windows 保留符号。
 * @param {string} id
 */
export function stemFileName(id) {
  const safe = String(id)
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, 80);
  return `${safe || 'clip'}.wav`;
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {never}
 */
function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  /** @type {any} */ (error).code = code;
  throw error;
}

/**
 * 逐条渲染 stems，再渲染一次完整 mix。
 *
 * `clipIds` 必须与 `audioMix.clips` 一一对应且同序（都由同一个 doc 顺序产生），
 * 对不上就报错而不是猜：名字贴错比不导出更糟。
 *
 * @param {{
 *   audioMix: { duration: number, sampleRate?: number, channels?: number, clips: any[] },
 *   clipIds: string[],
 *   outDir: string,
 *   ffmpegPath?: string,
 *   signal?: AbortSignal,
 *   skipMix?: boolean,
 * }} opts
 * @returns {Promise<{ dir: string, stems: Array<{ id: string, file: string, bytes: number, sha256: string, durationSec: number, peak: number }>, mix: { file: string, bytes: number, sha256: string, durationSec: number } | null }>}
 */
export async function renderStems(opts) {
  const { audioMix, clipIds, outDir } = opts;
  if (!Array.isArray(audioMix?.clips) || audioMix.clips.length === 0) {
    fail('INVALID_FILM', 'film has no audible clips, nothing to stem out');
  }
  if (clipIds.length !== audioMix.clips.length) {
    fail(
      'INVALID_FILM',
      `${clipIds.length} audio clip ids vs ${audioMix.clips.length} mixed clips (order cannot be matched)`,
    );
  }

  /** @type {Array<{ id: string, file: string, bytes: number, sha256: string, durationSec: number, peak: number }>} */
  const stems = [];
  for (const [index, clip] of audioMix.clips.entries()) {
    if (opts.signal?.aborted) fail('CANCELLED', 'stems cancelled');
    // 上面已经校验过长度相等；这里再兜一次，避免 id 变成 undefined 后被当成文件名
    const id = clipIds[index];
    if (typeof id !== 'string' || id === '') fail('INVALID_FILM', `audio clip #${index} has no id`);
    const file = path.join(outDir, stemFileName(id));
    const mixed = await renderMix(stemSpec(audioMix, clip), {
      outWav: file,
      ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    stems.push({
      id,
      file,
      bytes: mixed.bytes,
      sha256: mixed.sha256,
      durationSec: mixed.report.durationSec,
      peak: mixed.report.peak,
    });
  }

  let mix = null;
  if (opts.skipMix !== true) {
    const mixPath = path.join(outDir, 'mix.wav');
    const mixed = await renderMix(audioMix, {
      outWav: mixPath,
      ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    mix = {
      file: mixPath,
      bytes: mixed.bytes,
      sha256: mixed.sha256,
      durationSec: mixed.report.durationSec,
    };
  }
  return { dir: outDir, stems, mix };
}
