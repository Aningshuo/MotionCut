/**
 * 交付编码矩阵（P38 · RD 编解码）：h264 / hevc / vp9 / prores422hq。
 *
 * 一张表回答四件事，**每种编码只有一处定义**：
 * 1. 容器与扩展名（`--out` 的扩展名必须匹配，不自动改路径）；
 * 2. 视频编码器与每档 quality 的参数（h264 的档位仍在 `quality.mjs`，不在这里复制）；
 * 3. 音频编码器（mp4=aac / webm=opus / mov=pcm_s16le）；
 * 4. ffprobe 回读时该看到什么（`codec_name` / tag / pix_fmt），供 verify 与证据共用。
 *
 * 为什么 H.264 的档位不搬进来：`quality.mjs` 是 ADR-R8-01 的交付层门槛（p99≤8），
 * 它的 crf/preset/pixFmt 是**实测**出来的，复制一份就会漂。这里只把「h264 用哪张表」
 * 指过去，其余编码器才在本文件给档位。
 *
 * ProRes 422 HQ 不吃 quality 档：它本来就是帧内近无损，`-profile:v 3` +
 * `yuv422p10le` 就是它的定义。给它套 crf 只会写出一个不是 422 HQ 的文件。
 */

/** CLI 认的编码名（顺序即帮助里的顺序）。 */
export const CODEC_NAMES = Object.freeze(['h264', 'hevc', 'vp9', 'prores422hq', 'prores4444']);

/** 缺省编码：行为与 R22 逐字节相同（libx264 / mp4 / aac）。 */
export const DEFAULT_CODEC = 'h264';

/**
 * 像素格式策略（P41）：`auto` 跟随档位表（默认，行为一个字节都不变），
 * `420` / `444` 强制覆盖。
 *
 * 为什么需要 `420`：`standard` 档是 `yuv444p`（H.264 的 High 4:4:4 Predictive），
 * QuickTime/Safari/部分硬解不认。`--also-compat` 只能产**第二份**副本，而且不能与
 * 烧录/多段组合；主产物直接出 4:2:0 才是"交付给别人的那条路"。
 */
export const PIX_FMT_MODES = Object.freeze(['auto', '420', '444']);

/** 缺省策略：跟随档位表。 */
export const DEFAULT_PIX_FMT_MODE = 'auto';

export class PixFmtError extends Error {
  /**
   * @param {string} code
   * @param {string} detail
   */
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'PixFmtError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * CLI 的 `--pix-fmt` 值 → 策略名。未知值抛 `INVALID`（退出码 2）。
 * @param {unknown} raw
 * @returns {'auto' | '420' | '444'}
 */
export function resolvePixFmtMode(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_PIX_FMT_MODE;
  const key = String(raw).trim();
  if (/** @type {readonly string[]} */ (PIX_FMT_MODES).includes(key)) {
    return /** @type {'auto' | '420' | '444'} */ (key);
  }
  throw new PixFmtError(
    'INVALID',
    `--pix-fmt must be ${PIX_FMT_MODES.join('|')}, got "${key}"`,
  );
}

/**
 * 某编码在某像素格式下的**自然** profile（ffprobe 会报的名字）。
 * 只用于计划/结果里的可读标签，不参与编码参数。
 * @param {ReturnType<typeof resolveCodec>} codec
 * @param {string} pixFmt
 * @returns {string}
 */
export function naturalProfile(codec, pixFmt) {
  switch (codec.name) {
    case 'h264':
      if (pixFmt === 'yuv420p') return 'High';
      if (pixFmt === 'yuv422p') return 'High 4:2:2';
      if (pixFmt === 'yuv444p') return 'High 4:4:4 Predictive';
      return pixFmt;
    case 'hevc':
      if (pixFmt === 'yuv420p') return 'Main';
      // ffprobe 对 HEVC 4:4:4（8-bit）报的是 "Rext"（Range Extensions），
      // 不是规范里的 "Main 4:4:4"；plan 里的名字要跟 ffprobe 对齐，否则 A6 那种对账会假失败。
      if (pixFmt === 'yuv444p') return 'Rext';
      return pixFmt;
    case 'vp9':
      if (pixFmt === 'yuv420p') return 'Profile 0';
      if (pixFmt === 'yuv444p') return 'Profile 1';
      return pixFmt;
    case 'prores4444':
      return '4444';
    case 'prores422hq':
      return 'HQ';
    default:
      // ProRes 422 HQ 是 profile 3；ffprobe 报 "HQ"
      return codec.proresProfile === 3 ? 'HQ' : String(codec.proresProfile ?? pixFmt);
  }
}

/**
 * 应用 `--pix-fmt`：返回最终的编码参数 + 要写进 ffmpeg 的 profile 参数。
 *
 * - `auto`：**原样返回**档位表给的 crf/preset/pixFmt，不追加任何 `-profile:v`
 *   （默认产物 sha 一个字都不能变）；
 * - `420` / `444`：只换像素格式并**按编码器收敛 profile** —— 光给 `-pix_fmt yuv420p`
 *   时 libx264 会自己挑 High，但 hevc/vp9 的 profile 不能靠猜，显式钉死才可复现；
 * - ProRes 422 HQ 的像素格式是格式定义的一部分（`yuv422p10le`），改它就等于
 *   写出一个不是 422 HQ 的文件 → `E_USAGE`。
 *
 * @param {ReturnType<typeof resolveCodec>} codec
 * @param {'auto' | '420' | '444'} mode
 * @param {{ crf: number | null, preset: string | null, pixFmt: string }} q
 * @returns {{ crf: number | null, preset: string | null, pixFmt: string, profile: string, profileArg: string[] }}
 */
export function applyPixFmt(codec, mode, q) {
  if (mode === DEFAULT_PIX_FMT_MODE) {
    return { crf: q.crf, preset: q.preset, pixFmt: q.pixFmt, profile: naturalProfile(codec, q.pixFmt), profileArg: [] };
  }
  if (codec.proresProfile !== null) {
    throw new PixFmtError(
      'E_USAGE',
      `--pix-fmt ${mode} does not apply to ${codec.name}: ProRes defines its own pixel format (profile ${String(codec.proresProfile)}); changing it would not be that profile`,
    );
  }
  const pixFmt = mode === '420' ? 'yuv420p' : 'yuv444p';
  /** @type {string | null} */
  let profileArgValue = null;
  if (codec.name === 'h264') profileArgValue = mode === '420' ? 'high' : 'high444';
  else if (codec.name === 'hevc') profileArgValue = mode === '420' ? 'main' : null; // 444 交给 x265 自己挑 Main 4:4:4
  else if (codec.name === 'vp9') profileArgValue = mode === '420' ? '0' : '1';
  return {
    crf: q.crf,
    preset: q.preset,
    pixFmt,
    profile: naturalProfile(codec, pixFmt),
    profileArg: profileArgValue === null ? [] : ['-profile:v', profileArgValue],
  };
}

/**
 * @typedef {object} CodecQuality
 * @property {number} crf
 * @property {string} preset
 * @property {string} pixFmt
 */

/**
 * 每种编码的定义。`probeTag` 只对 mp4 系的 hevc 有意义（hvc1），其余为 null。
 * @type {Readonly<Record<string, {
 *   name: string, container: 'mp4' | 'webm' | 'mov', extension: string,
 *   encoder: string, probeVideo: string, probeTag: string | null,
 *   audio: { codec: string, encoder: string, probe: string, bitrate: string | null },
 *   quality: Readonly<Record<string, CodecQuality>> | null,
 *   proresProfile: number | null, pixFmt: string | null,
 * }>>}
 */
export const CODEC_MATRIX = Object.freeze({
  h264: Object.freeze({
    name: 'h264',
    container: 'mp4',
    extension: '.mp4',
    encoder: 'libx264',
    probeVideo: 'h264',
    probeTag: null,
    audio: Object.freeze({ codec: 'aac', encoder: 'aac', probe: 'aac', bitrate: '192k' }),
    /** null = 用 `quality.mjs` 的 QUALITY_LEVELS（ADR-R8-01 的实测表）。 */
    quality: null,
    proresProfile: null,
    pixFmt: null,
  }),
  hevc: Object.freeze({
    name: 'hevc',
    container: 'mp4',
    extension: '.mp4',
    encoder: 'libx265',
    probeVideo: 'hevc',
    // hvc1：Apple/QuickTime 只认这个 tag（hev1 在 QuickTime 里放不出来）。
    probeTag: 'hvc1',
    audio: Object.freeze({ codec: 'aac', encoder: 'aac', probe: 'aac', bitrate: '192k' }),
    quality: Object.freeze({
      draft: Object.freeze({ crf: 28, preset: 'veryfast', pixFmt: 'yuv420p' }),
      standard: Object.freeze({ crf: 20, preset: 'medium', pixFmt: 'yuv420p' }),
      high: Object.freeze({ crf: 16, preset: 'slow', pixFmt: 'yuv420p' }),
    }),
    proresProfile: null,
    pixFmt: null,
  }),
  vp9: Object.freeze({
    name: 'vp9',
    container: 'webm',
    extension: '.webm',
    encoder: 'libvpx-vp9',
    probeVideo: 'vp9',
    probeTag: null,
    audio: Object.freeze({ codec: 'libopus', encoder: 'libopus', probe: 'opus', bitrate: '128k' }),
    quality: Object.freeze({
      draft: Object.freeze({ crf: 30, preset: 'realtime', pixFmt: 'yuv420p' }),
      /* 4:2:0 有一条与码率无关的色度地板（R8 在 h264 上量过：crf 降到 0，p99 仍 17）。
         vp9 同理：420/crf22 实测 36.3dB，换成 444 才过 40。standard/high 跟 h264 一样用 444。 */
      standard: Object.freeze({ crf: 28, preset: 'good', pixFmt: 'yuv444p' }),
      high: Object.freeze({ crf: 24, preset: 'good', pixFmt: 'yuv444p' }),
    }),
    proresProfile: null,
    pixFmt: null,
  }),
  prores422hq: Object.freeze({
    name: 'prores422hq',
    container: 'mov',
    extension: '.mov',
    encoder: 'prores_ks',
    probeVideo: 'prores',
    probeTag: null,
    audio: Object.freeze({ codec: 'pcm_s16le', encoder: 'pcm_s16le', probe: 'pcm_s16le', bitrate: null }),
    /** 不吃 quality：帧内近无损，档位只影响 h264/hevc/vp9。 */
    quality: null,
    proresProfile: 3,
    pixFmt: 'yuv422p10le',
  }),
  /* P47：作业矩阵要求 prores4444 也能作为**交付编码**（不是 alpha 导出）。
     与 prores422hq 同一套 prores_ks，区别只有 profile 与像素格式（带 alpha 通道，
     不透明画面写满 255）。alpha 导出仍走 alpha-export.mjs 自己那条链。 */
  prores4444: Object.freeze({
    name: 'prores4444',
    container: 'mov',
    extension: '.mov',
    encoder: 'prores_ks',
    probeVideo: 'prores',
    probeTag: null,
    audio: Object.freeze({ codec: 'pcm_s16le', encoder: 'pcm_s16le', probe: 'pcm_s16le', bitrate: null }),
    quality: null,
    proresProfile: 4444,
    pixFmt: 'yuva444p10le',
  }),
});

/**
 * 编码名 → 定义。未知编码抛 `INVALID_CODEC`（CLI 层翻成 `INVALID`）。
 * @param {unknown} name
 * @returns {typeof CODEC_MATRIX[string]}
 */
export function resolveCodec(name) {
  const key = name === undefined || name === null || name === '' ? DEFAULT_CODEC : String(name);
  const def = CODEC_MATRIX[key];
  if (!def) {
    const err = new Error(
      `INVALID_CODEC: unknown codec "${String(name)}" (expected one of ${CODEC_NAMES.join('|')})`,
    );
    /** @type {any} */ (err).code = 'INVALID_CODEC';
    throw err;
  }
  return def;
}

/**
 * 某编码在某画质档下的视频参数。
 *
 * @param {ReturnType<typeof resolveCodec>} codec
 * @param {{ name: string, crf: number, preset: string, pixFmt: string }} level `quality.mjs` 的档位
 * @returns {{ crf: number | null, preset: string | null, pixFmt: string }}
 */
export function codecQuality(codec, level) {
  if (codec.quality === null) {
    if (codec.name === 'h264') {
      // h264 的档位来自 quality.mjs（ADR-R8-01 的实测表），这里只做透传
      return { crf: level.crf, preset: level.preset, pixFmt: level.pixFmt };
    }
    // prores：没有 crf/preset，像素格式由编码定义决定
    return { crf: null, preset: null, pixFmt: codec.pixFmt ?? 'yuv422p10le' };
  }
  const table = codec.quality;
  /** @type {CodecQuality} */
  const picked = table[level.name] ?? /** @type {CodecQuality} */ (table.standard);
  return { crf: picked.crf, preset: picked.preset, pixFmt: picked.pixFmt };
}

/**
 * 视频编码参数（`-c:v` 起，到 `-r` 之前）。**这是唯一一处拼编码参数的地方**，
 * `renderFilmVideo` / `renderFilmVideoFromFrames` 都调它，避免两条路径各写一套。
 *
 * h264 的分支必须与 R22 的 args 逐项相同（顺序也相同），否则默认产物 sha 会变。
 *
 * @param {ReturnType<typeof resolveCodec>} codec
 * @param {{ crf: number | null, preset: string | null, pixFmt: string, profileArg?: string[] }} q
 * @returns {string[]}
 */
export function videoEncodeArgs(codec, q) {
  // P41：`--pix-fmt` 显式要求时才带 -profile:v；auto 时 profileArg 是空数组，
  // 下面四条分支的 args 与 R22/R23 逐项相同（默认 sha 不漂）。
  const profile = Array.isArray(q.profileArg) ? q.profileArg : [];
  switch (codec.name) {
    case 'hevc':
      return [
        '-c:v',
        codec.encoder,
        '-preset',
        String(q.preset),
        '-crf',
        String(q.crf),
        '-pix_fmt',
        q.pixFmt,
        '-tag:v',
        'hvc1',
        ...profile,
      ];
    case 'vp9':
      // `-b:v 0` 是 VP9 的恒定质量模式：只给 crf 不给码率上限，否则 crf 会被码率顶回去
      return [
        '-c:v',
        codec.encoder,
        '-crf',
        String(q.crf),
        '-b:v',
        '0',
        '-pix_fmt',
        q.pixFmt,
        '-row-mt',
        '1',
        '-deadline',
        q.preset === 'realtime' ? 'realtime' : 'good',
        '-cpu-used',
        q.preset === 'realtime' ? '5' : '2',
        ...profile,
      ];
    case 'prores422hq':
    case 'prores4444':
      return ['-c:v', codec.encoder, '-profile:v', String(codec.proresProfile), '-pix_fmt', q.pixFmt];
    default:
      return [
        '-c:v',
        codec.encoder,
        '-preset',
        String(q.preset),
        '-crf',
        String(q.crf),
        '-pix_fmt',
        q.pixFmt,
        ...profile,
      ];
  }
}

/**
 * 容器相关参数：只有 mp4/mov 吃 `+faststart`；webm 给了会直接报错。
 * @param {ReturnType<typeof resolveCodec>} codec
 * @returns {string[]}
 */
export function containerArgs(codec) {
  return codec.container === 'webm' ? [] : ['-movflags', '+faststart'];
}

/**
 * 音频编码参数（封装阶段用）。mp4=aac 192k、webm=opus 128k、mov=pcm_s16le。
 * @param {ReturnType<typeof resolveCodec>} codec
 * @returns {string[]}
 */
export function audioEncodeArgs(codec) {
  const args = ['-c:a', codec.audio.codec];
  if (codec.audio.bitrate) args.push('-b:a', codec.audio.bitrate);
  if (codec.container === 'webm') args.push('-ar', '48000', '-ac', '2');
  return args;
}

/**
 * 探测某编码需要的**全部**编码器（视频 + 音频）。缺了要在开渲之前报
 * `CODEC_UNAVAILABLE`，别等 ffmpeg 跑到一半才炸。
 * @param {ReturnType<typeof resolveCodec>} codec
 * @returns {string[]}
 */
export function requiredEncoders(codec) {
  return [codec.encoder, codec.audio.encoder];
}

/**
 * 给计划/结果用的稳定摘要（A6：`--dry-run --json` 里能看到 codec/container/encoder）。
 * @param {ReturnType<typeof resolveCodec>} codec
 */
export function describeCodec(codec) {
  return {
    name: codec.name,
    container: codec.container,
    encoder: codec.encoder,
    audio: codec.audio.probe,
    extension: codec.extension,
    ...(codec.probeTag ? { tag: codec.probeTag } : {}),
  };
}
