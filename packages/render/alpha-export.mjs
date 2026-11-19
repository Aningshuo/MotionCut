/**
 * 透明输出（P31 / RD-021~025）。
 *
 * 目标不是「把 mp4 转成 ProRes」，而是**把舞台真正画出来的 alpha 一路带到成品**：
 *   1. 舞台取帧开 `omitBackground`，页面底色透明 → PNG 带 alpha（`stage-capture.mjs`）；
 *   2. 本文件把 PNG 序列编码成 ProRes 4444（`yuva444p10le`）或交付 PNG 序列 + zip；
 *   3. 逐帧量 alpha，产出**诚实的报告**：实心工程就报 `hasAlpha: false`，
 *      绝不允许「全 255 也叫透明导出」。
 *
 * 两种形态的分工：
 * - `prores4444`：单个 `.mov`，给别的剪辑软件叠。**只出画面，不出音轨**——
 *   透明素材的用途是合成层，音轨仍应来自主时间线；混进来只会让导入方多一条没用的轨。
 * - `png-seq`：目录 + zip。无损、alpha 精确，适合再进 AE/PS 二次加工。
 *
 * 打包用**纯 JS store-only zip**（不压缩）：理由写在 `buildStoreZip` 上面。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { PREMULTIPLY_FILTER, defaultAlphaMode } from './alpha-polarity.mjs';
import { runFfmpeg } from './film-export.mjs';
import { PNG_SEQ_VOLUME_LIMIT, estimatePngSequenceBytes, planPngSeqVolumes, sampleFrameIndices } from './png-seq.mjs';
import { alphaStats, crc32, decodePng } from './png.mjs';
import { fileDigest, probeMedia } from './verify.mjs';

export const ALPHA_MODULE_VERSION = '1.1.0';

/** @type {ReadonlyArray<'prores4444' | 'png-seq'>} */
export const ALPHA_FORMATS = Object.freeze(['prores4444', 'png-seq']);

/** zip 里的固定时间戳（见 buildStoreZip 的注释）。 */
const ZIP_EPOCH = new Date(Date.UTC(2000, 0, 1, 0, 0, 0));

export class AlphaExportError extends Error {
  /** @param {string} code @param {string} message @param {Record<string, any>} [extra] */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'AlphaExportError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * `--alpha-format` 归一。默认 prores4444（任务书 §3.1）。
 * @param {string | undefined | null} raw
 * @returns {'prores4444' | 'png-seq'}
 */
export function resolveAlphaFormat(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return 'prores4444';
  const text = String(raw).trim().toLowerCase();
  if (text === 'prores4444' || text === 'prores' || text === '4444') return 'prores4444';
  if (text === 'png-seq' || text === 'pngseq' || text === 'png') return 'png-seq';
  throw new AlphaExportError(
    'INVALID',
    `--alpha-format must be one of ${ALPHA_FORMATS.join('|')}, got "${raw}"`,
  );
}

/**
 * @param {string} pattern `frame-%06d.png`
 * @param {number} index 0 基
 */
export function frameFileName(pattern, index) {
  return pattern.includes('%06d')
    ? pattern.replace('%06d', String(index).padStart(6, '0'))
    : pattern.replace('%d', String(index));
}

/**
 * 逐帧判透明（RD-024/025）。
 *
 * 判据是「有没有任何像素 alpha < 250」而不是「平均 alpha 小于多少」：
 * 一张 960×320 的卡片放在 1280×720 的画布上，透明像素占 69%；
 * 而一个只画了一条 1px 细线的动效，透明像素占 99.99% —— 两个都必须算「有 alpha」。
 *
 * @param {{
 *   framesDir: string,
 *   pattern?: string,
 *   frames: number,
 *   threshold?: number,
 *   onProgress?: (info: { index: number, total: number }) => void,
 * }} opts
 * @returns {Promise<{
 *   hasAlpha: boolean, framesWithAlpha: number, firstFrame: number | null, lastFrame: number | null,
 *   maxTransparentRatio: number, minAlphaOverall: number, threshold: number,
 *   fullyTransparentFrames: number[], size: { w: number, h: number },
 *   perFrame: Array<{ frame: number, transparentRatio: number, minAlpha: number, bytes: number }>,
 * }>}
 */
export async function analyzeAlphaFrames(opts) {
  const pattern = opts.pattern ?? 'frame-%06d.png';
  const frames = Number(opts.frames);
  const threshold = Number(opts.threshold) > 0 ? Number(opts.threshold) : 250;
  if (!Number.isFinite(frames) || frames <= 0) {
    throw new AlphaExportError('INVALID', `analyzeAlphaFrames needs a positive frame count, got ${opts.frames}`);
  }
  /** @type {Array<{ frame: number, transparentRatio: number, minAlpha: number, bytes: number }>} */
  const perFrame = [];
  let framesWithAlpha = 0;
  /** @type {number | null} */
  let firstFrame = null;
  /** @type {number | null} */
  let lastFrame = null;
  let maxTransparentRatio = 0;
  let minAlphaOverall = 255;
  /** @type {number[]} */
  const fullyTransparentFrames = [];
  /** @type {{ w: number, h: number }} */
  let size = { w: 0, h: 0 };

  for (let index = 0; index < frames; index += 1) {
    const file = path.join(opts.framesDir, frameFileName(pattern, index));
    const bytes = await fs.readFile(file);
    const image = decodePng(bytes);
    if (size.w === 0) size = { w: image.width, h: image.height };
    else if (image.width !== size.w || image.height !== size.h) {
      throw new AlphaExportError(
        'INVALID',
        `frame ${index} is ${image.width}x${image.height}, earlier frames were ${size.w}x${size.h}`,
      );
    }
    const stats = alphaStats(image, { threshold });
    if (stats.transparentPixels > 0) {
      framesWithAlpha += 1;
      if (firstFrame === null) firstFrame = index;
      lastFrame = index;
    }
    if (stats.transparentRatio > maxTransparentRatio) maxTransparentRatio = stats.transparentRatio;
    if (stats.minAlpha < minAlphaOverall) minAlphaOverall = stats.minAlpha;
    if (stats.transparentRatio >= 1) fullyTransparentFrames.push(index);
    perFrame.push({
      frame: index,
      transparentRatio: stats.transparentRatio,
      minAlpha: stats.minAlpha,
      bytes: bytes.length,
    });
    opts.onProgress?.({ index, total: frames });
  }

  return {
    hasAlpha: framesWithAlpha > 0,
    framesWithAlpha,
    firstFrame,
    lastFrame,
    maxTransparentRatio: Number(maxTransparentRatio.toFixed(6)),
    minAlphaOverall,
    threshold,
    fullyTransparentFrames,
    size,
    perFrame,
  };
}

/**
 * 从**编好的视频**里抽几帧量 alpha —— 证明 alpha 通道真的穿过了编码器，
 * 而不是只存在于中间 PNG 里。
 *
 * @param {{ video: string, frames: number[], size: { w: number, h: number }, ffmpegPath?: string, threshold?: number }} opts
 * @returns {Promise<Array<{ frame: number, transparentRatio: number, minAlpha: number }>>}
 */
export async function measureVideoAlpha(opts) {
  const ffmpegPath = opts.ffmpegPath ?? 'ffmpeg';
  const threshold = Number(opts.threshold) > 0 ? Number(opts.threshold) : 250;
  const expected = opts.size.w * opts.size.h * 4;
  /** @type {Array<{ frame: number, transparentRatio: number, minAlpha: number }>} */
  const out = [];
  for (const frame of opts.frames) {
    const buf = await decodeFrameRgba(ffmpegPath, opts.video, frame);
    if (buf.length < expected) {
      throw new AlphaExportError(
        'INVALID',
        `frame ${frame} of ${opts.video}: decoded ${buf.length}B, expected ${expected}B`,
      );
    }
    const stats = alphaStats(
      { width: opts.size.w, height: opts.size.h, channels: 4, data: buf.subarray(0, expected) },
      { threshold },
    );
    out.push({ frame, transparentRatio: stats.transparentRatio, minAlpha: stats.minAlpha });
  }
  return out;
}

/**
 * @param {string} ffmpegPath
 * @param {string} video
 * @param {number} frame
 * @returns {Promise<Buffer>}
 */
async function decodeFrameRgba(ffmpegPath, video, frame) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const { stdout } = await run(
    ffmpegPath,
    [
      '-hide_banner', '-loglevel', 'error',
      '-i', video,
      '-vf', `select=eq(n\\,${frame})`,
      '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
    ],
    /** @type {any} */ ({ maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' }),
  );
  return /** @type {Buffer} */ (stdout);
}

/**
 * 交付用的 PNG 序列目录名 / zip 名。
 *
 * 规则：`--out take.mp4` → `take/` + `take.zip`；`--out take.zip` → `take/` + `take.zip`。
 * 这样用户不用为了透明导出再记一套命名，`--out` 依旧是「产物叫什么」。
 * @param {string} outPath
 */
export function resolvePngSeqPaths(outPath) {
  const zipExplicit = /\.zip$/i.test(outPath);
  const stem = outPath.replace(/\.(mp4|mov|m4v|zip)$/i, '');
  return { dir: stem, zip: zipExplicit ? outPath : `${stem}.zip` };
}

/**
 * zip 的 DOS 时间/日期字段。
 *
 * 固定时间戳：zip 的 DOS 时间字段只能表示 1980 年以后，用 `new Date(0)`
 * 会溢出成 2098 年（实测 `unzip -l` 显示 01-01-2098）。用 2000-01-01 UTC，
 * 既在可表示范围内，又让同一批帧打出来的 zip 字节可复现。
 * @param {Date} when
 */
function dosDateTime(when) {
  return {
    time: ((when.getUTCHours() & 0x1f) << 11) | ((when.getUTCMinutes() & 0x3f) << 5) | ((when.getUTCSeconds() >> 1) & 0x1f),
    date: (((when.getUTCFullYear() - 1980) & 0x7f) << 9) | (((when.getUTCMonth() + 1) & 0x0f) << 5) | (when.getUTCDate() & 0x1f),
  };
}

/**
 * @param {{ nameLength: number, crc: number, size: number, dosTime: number, dosDate: number }} f
 */
function zipLocalHeader(f) {
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(0, 8); // method: store
  local.writeUInt16LE(f.dosTime, 10);
  local.writeUInt16LE(f.dosDate, 12);
  local.writeUInt32LE(f.crc, 14);
  local.writeUInt32LE(f.size, 18);
  local.writeUInt32LE(f.size, 22);
  local.writeUInt16LE(f.nameLength, 26);
  local.writeUInt16LE(0, 28);
  return local;
}

/**
 * @param {{ nameLength: number, crc: number, size: number, dosTime: number, dosDate: number, offset: number }} f
 */
function zipCentralRecord(f) {
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(f.dosTime, 12);
  central.writeUInt16LE(f.dosDate, 14);
  central.writeUInt32LE(f.crc, 16);
  central.writeUInt32LE(f.size, 20);
  central.writeUInt32LE(f.size, 24);
  central.writeUInt16LE(f.nameLength, 28);
  central.writeUInt16LE(0, 30); // extra
  central.writeUInt16LE(0, 32); // comment
  central.writeUInt16LE(0, 34); // disk
  central.writeUInt16LE(0, 36); // internal attrs
  central.writeUInt32LE(0, 38); // external attrs
  central.writeUInt32LE(f.offset, 42);
  return central;
}

/**
 * @param {{ count: number, centralBytes: number, centralOffset: number }} f
 */
function zipEocd(f) {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(f.count, 8);
  eocd.writeUInt16LE(f.count, 10);
  eocd.writeUInt32LE(f.centralBytes, 12);
  eocd.writeUInt32LE(f.centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return eocd;
}

/**
 * 写一个 **store-only**（不压缩）zip —— **流式**版，产品路径用它。
 *
 * 为什么必须流式：4K 240 帧是 2.6GB。把每帧 Buffer 攒在内存里再 `Buffer.concat`，
 * 峰值就是「整个序列 + 整个 zip」≈ 5GB，还没开始写盘就先 OOM。
 * 这里一次只持有一张 PNG，边读边写，峰值内存 = 单帧（4K 约 10MB）。
 *
 * `entries` 可以是同步数组也可以是异步生成器 —— 异步的那种能在读帧时顺带报进度。
 *
 * @param {string} target
 * @param {AsyncIterable<{ name: string, data: Buffer, mtime?: Date }> | Iterable<{ name: string, data: Buffer, mtime?: Date }>} entries
 * @param {{ onEntry?: (info: { name: string, bytes: number, written: number }) => void }} [opts]
 * @returns {Promise<{ path: string, bytes: number, count: number }>}
 */
export async function writeStoreZip(target, entries, opts = {}) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const partial = `${target}.partial`;
  const handle = await fs.open(partial, 'w');
  /** @type {Buffer[]} */
  const centrals = [];
  let offset = 0;
  let count = 0;
  try {
    for await (const entry of entries) {
      const name = Buffer.from(entry.name, 'utf8');
      const data = entry.data;
      const crc = crc32(data);
      const when = entry.mtime ?? ZIP_EPOCH;
      const { time, date } = dosDateTime(when);
      const local = zipLocalHeader({ nameLength: name.length, crc, size: data.length, dosTime: time, dosDate: date });
      await handle.write(local);
      await handle.write(name);
      await handle.write(data);
      centrals.push(
        zipCentralRecord({
          nameLength: name.length,
          crc,
          size: data.length,
          dosTime: time,
          dosDate: date,
          offset,
        }),
        name,
      );
      offset += local.length + name.length + data.length;
      count += 1;
      opts.onEntry?.({ name: entry.name, bytes: data.length, written: count });
    }
    const centralBuf = Buffer.concat(centrals);
    await handle.write(centralBuf);
    await handle.write(zipEocd({ count, centralBytes: centralBuf.length, centralOffset: offset }));
    await handle.close();
  } catch (err) {
    await handle.close().catch(() => {});
    await fs.unlink(partial).catch(() => {});
    throw err;
  }
  await fs.rename(partial, target);
  const stat = await fs.stat(target);
  return { path: target, bytes: stat.size, count };
}

/**
 * 写一个 **store-only**（不压缩）zip —— 内存版。
 *
 * 为什么不用系统 `zip`：`--alpha` 是要给别人/别的机器用的导出能力，
 * 依赖 `zip` 二进制意味着「在我的机器上能导，在你的机器上要装东西」。
 * 纯 JS store-only 只用 Node 内置 zlib 的 crc32（自己实现的表），零依赖、字节确定。
 * PNG 本身已经压过了，再 deflate 一遍收益 <2%，不值得为此引入压缩实现。
 *
 * 产品路径用流式版（`writeStoreZip`）；这一份留给小序列与逐字节比对（测试、zip 结构断言）。
 *
 * @param {Array<{ name: string, data: Buffer, mtime?: Date }>} entries
 * @returns {Buffer}
 */
export function buildStoreZip(entries) {
  /** @type {Buffer[]} */
  const locals = [];
  /** @type {Buffer[]} */
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const crc = crc32(data);
    const { time, date } = dosDateTime(entry.mtime ?? ZIP_EPOCH);
    const local = zipLocalHeader({ nameLength: name.length, crc, size: data.length, dosTime: time, dosDate: date });
    locals.push(local, name, data);
    centrals.push(
      zipCentralRecord({ nameLength: name.length, crc, size: data.length, dosTime: time, dosDate: date, offset }),
    );
    centrals.push(name);
    offset += local.length + name.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  return Buffer.concat([...locals, centralBuf, zipEocd({ count: entries.length, centralBytes: centralBuf.length, centralOffset: offset })]);
}

/**
 * 透明导出的两种落盘形态。
 *
 * @param {{
 *   outPath: string,
 *   format: 'prores4444' | 'png-seq',
 *   mode?: 'premultiplied' | 'straight',
 *   volumeLimitBytes?: number,
 *   framesDir: string,
 *   pattern?: string,
 *   frames: number,
 *   fps: number,
 *   fpsArg?: string,
 *   durationSec?: number,
 *   size: { w: number, h: number },
 *   report: any,
 *   ffmpegPath?: string,
 *   ffprobePath?: string,
 *   signal?: AbortSignal,
 *   verifyFrames?: number[],
 *   onProgress?: (info: { phase: string, frame?: number, totalFrames?: number }) => void,
 * }} opts
 * @returns {Promise<any>}
 */
export async function writeAlphaOutput(opts) {
  const pattern = opts.pattern ?? 'frame-%06d.png';
  /* P42：分数帧率要送 `30000/1001`，不是 `29.97`；整数帧率时 fpsArg 就是 "30"，
     与 R16 的 args 逐字符相同。durationSec 由调用方按有理数算好（frames×den/num）。 */
  const fpsArg = opts.fpsArg ?? String(opts.fps);
  const width = Math.max(2, Math.round(opts.size.w));
  const height = Math.max(2, Math.round(opts.size.h));

  if (opts.format === 'png-seq') {
    const mode = opts.mode ?? defaultAlphaMode('png-seq');
    if (mode !== 'straight') {
      // 见 alpha-polarity.mjs 文件头：PNG 规范是非预乘，写预乘 PNG 是给下游一张
      // 「没有标记的假数据」。这条在 CLI 层已经拦过一次，这里是最后一道。
      throw new AlphaExportError(
        'INVALID',
        'png-seq cannot be premultiplied: PNG is non-premultiplied by specification (use --alpha-format prores4444)',
      );
    }
    const { dir, zip } = resolvePngSeqPaths(opts.outPath);
    const stem = path.basename(zip).replace(/\.zip$/i, '');

    // ---- 1) 体积预算：先量（不写任何产物），再决定分不分卷 ----
    // 只 stat 源帧，不读内容：这一步在 4K 240 帧上是几百次 stat，毫秒级。
    /** @type {Array<{ index: number, bytes: number }>} */
    const frameBytes = [];
    for (let index = 0; index < opts.frames; index += 1) {
      const src = path.join(opts.framesDir, frameFileName(pattern, index));
      const stat = await fs.stat(src);
      frameBytes.push({ index, bytes: stat.size });
    }
    const samples = sampleFrameIndices(opts.frames);
    const estimate = estimatePngSequenceBytes({
      frames: opts.frames,
      sampleBytes: samples.map((index) => frameBytes[index]?.bytes ?? 0),
    });

    // `sequence.json` + `alpha-report.json` 是**卷内固定开销**，必须在切卷前预留出来，
    // 否则一个刚好卡在上限的卷会因为这 40KB 超限。256KB 是「逐帧报告 900 帧」的上界。
    const RESERVED_MANIFEST_BYTES = 256 * 1024;
    const planned = planPngSeqVolumes({
      frameBytes,
      overheadBytes: 0,
      limitBytes: opts.volumeLimitBytes ?? PNG_SEQ_VOLUME_LIMIT - RESERVED_MANIFEST_BYTES,
      stem,
    });

    // ---- 2) 产物写出 ----
    // 单卷：`<stem>/` + `<stem>.zip`（R16 行为一字不改）；
    // 多卷：只出 `<stem>.partNNN.zip`，**不落帧目录** —— 4K 240 帧的帧目录本身就是 2.6GB，
    //       再留一份等于让用户为同一批数据付两遍盘。
    const keepDir = planned.split === false;
    if (keepDir) await fs.mkdir(dir, { recursive: true });

    const fileEntry = (/** @type {number} */ index) => `frame-${String(index + 1).padStart(6, '0')}.png`;
    /** @type {Array<{ name: string, bytes: number }>} */
    const volumeWritten = [];

    // 清单对所有卷是同一份（它描述整批帧与整张卷表），所以只序列化一次。
    const sequence = {
      pattern: 'frame-%06d.png',
      startNumber: 1,
      frames: opts.frames,
      fps: opts.fps,
      ...(opts.fpsArg ? { fpsArg: opts.fpsArg } : {}),
      durationSec: opts.durationSec ?? Number((opts.frames / opts.fps).toFixed(6)),
      size: { w: width, h: height },
      pixelFormat: 'rgba8',
      alphaMode: mode,
      volumeBytesLimit: planned.limitBytes,
      volumeCount: planned.volumes.length,
      totalBytes: planned.totalBytes,
      volumes: planned.volumes,
    };
    const sequenceBody = Buffer.from(`${JSON.stringify(sequence, null, 2)}\n`, 'utf8');
    const reportBody = Buffer.from(`${JSON.stringify({ ...opts.report, sequence }, null, 2)}\n`, 'utf8');

    for (const volume of planned.volumes) {
      /** @type {number[]} */
      const framesInVolume = [];
      for (let index = volume.firstIndex; index <= volume.lastIndex; index += 1) framesInVolume.push(index);

      /**
       * 异步生成器：一次只有一张 PNG 在内存里。4K 240 帧 × 10MB 若全攒下来就是 2.6GB，
       * 加上 zip 本身 ≈ 5GB，还没写盘就先 OOM。
       */
      async function* feed() {
        for (const index of framesInVolume) {
          const src = path.join(opts.framesDir, frameFileName(pattern, index));
          const data = await fs.readFile(src);
          const name = fileEntry(index);
          // 单卷时顺手把帧目录也写出来（R16 语义：目录 + zip 都在）
          if (keepDir) await fs.writeFile(path.join(dir, name), data);
          yield { name, data, mtime: ZIP_EPOCH };
        }
        // 清单放卷 1 的**末尾**（与 R16 的条目顺序一致：先帧后清单），
        // 拿到 part001 的人不需要别的卷就知道总共有几卷、每卷是什么。
        if (volume.index === 1) {
          yield { name: 'sequence.json', data: sequenceBody, mtime: ZIP_EPOCH };
          yield { name: 'alpha-report.json', data: reportBody, mtime: ZIP_EPOCH };
        }
      }
      const volumePath = path.join(path.dirname(zip), volume.name);
      const written = await writeStoreZip(volumePath, feed(), {
        onEntry: (/** @type {{ name: string }} */ info) => {
          if (!info.name.startsWith('frame-')) return;
          const index = Number(info.name.slice(6, 12)) - 1;
          opts.onProgress?.({ phase: 'encode', frame: index + 1, totalFrames: opts.frames });
        },
      });
      if (written.bytes > (opts.volumeLimitBytes ?? PNG_SEQ_VOLUME_LIMIT)) {
        // 预算失准到把单卷写超了：删掉这卷并如实报错，不交一个「说好 ≤2GB 却是 2.1GB」的产物
        await fs.unlink(volumePath).catch(() => {});
        throw new AlphaExportError(
          'INVALID',
          `volume ${volume.name} is ${written.bytes}B, over the ${opts.volumeLimitBytes ?? PNG_SEQ_VOLUME_LIMIT}B limit`,
        );
      }
      volumeWritten.push({ name: volume.name, bytes: written.bytes });
    }

    if (keepDir) {
      // 目录里也放一份清单：不然拿到 `<stem>/` 的人不知道这批帧的 fps/画幅
      await fs.writeFile(path.join(dir, 'sequence.json'), sequenceBody);
      await fs.writeFile(path.join(dir, 'alpha-report.json'), reportBody);
    }

    const volumes = planned.volumes.map((volume, index) => ({
      ...volume,
      bytes: volumeWritten[index]?.bytes ?? volume.bytes,
    }));
    const totalBytes = volumes.reduce((acc, volume) => acc + volume.bytes, 0);
    const first = volumes[0];
    if (!first) {
      throw new AlphaExportError('INVALID', 'png-seq produced no volumes (frame count was zero)');
    }
    const digest = await fileDigest(path.join(path.dirname(zip), first.name));
    return {
      kind: 'png-seq',
      path: path.join(path.dirname(zip), first.name),
      ...(keepDir ? { dir } : {}),
      dirKept: keepDir,
      frames: opts.frames,
      // `bytes`/`sha256` 永远指**同一个文件**（卷 1）；多卷时总量看 `totalBytes`。
      // 混着写会让人拿卷 1 的 sha 去核总字节，怎么都对不上。
      bytes: first.bytes,
      sha256: digest.sha256,
      size: { w: width, h: height },
      mode,
      entries: opts.frames + 2,
      volumes,
      volumeCount: volumes.length,
      totalBytes,
      budget: {
        ...estimate,
        actualBytes: totalBytes,
        errorPct: Number((((totalBytes - estimate.estimatedBytes) / Math.max(1, estimate.estimatedBytes)) * 100).toFixed(2)),
        volumeLimitBytes: planned.limitBytes,
        split: planned.split,
        oversizedFrames: planned.oversizedFrames,
      },
      report: opts.report,
    };
  }

  // prores4444
  const mode = opts.mode ?? defaultAlphaMode('prores4444');
  const moviePath = /\.mov$/i.test(opts.outPath)
    ? opts.outPath
    : `${opts.outPath.replace(/\.(mp4|mov|m4v)$/i, '')}.mov`;
  await fs.mkdir(path.dirname(moviePath), { recursive: true });
  await fs.unlink(moviePath).catch(() => {});
  /** @type {string[]} */
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-framerate', fpsArg,
    '-i', path.join(opts.framesDir, pattern),
  ];
  if (mode === 'premultiplied') {
    // 只在这一层乘：取帧 PNG 一个像素都不动（PNG 序列与 alpha 报告看到的还是 straight）。
    // straight 时不加 -vf —— 命令行与 R16 逐字节相同，产物 sha 才守得住（A2）。
    args.push('-vf', PREMULTIPLY_FILTER);
  }
  args.push(
    '-an',
    '-c:v', 'prores_ks',
    '-profile:v', '4444',
    // 10bit 4:4:4 + alpha。写成 yuva444p10le 是为了让 alpha 不被 quietly 丢掉：
    // 只写 `-profile:v 4444` 时 ffmpeg 会按输入选 pix_fmt，遇到 RGB PNG 常常落到 yuv444p。
    '-pix_fmt', 'yuva444p10le',
    '-vendor', 'apl0',
    '-frames:v', String(opts.frames),
    '-r', fpsArg,
    moviePath,
  );
  await runFfmpeg(args, {
    ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    // 统一成「编码帧号」这一种形状：runFfmpeg 只认 frame，阶段由调用方补
    ...(opts.onProgress
      ? {
          onProgress: (/** @type {{ frame: number }} */ info) =>
            opts.onProgress?.({ phase: 'encode', frame: info.frame, totalFrames: opts.frames }),
        }
      : {}),
  });
  const digest = await fileDigest(moviePath);
  const probe = await probeMedia(moviePath, opts.ffprobePath ? { ffprobePath: opts.ffprobePath } : {});
  const pixFmt = probe?.video?.pixFmt ?? null;
  const alphaInEncode = typeof pixFmt === 'string' && /^yuva|^rgba|^bgra|^ya/.test(pixFmt);
  if (!alphaInEncode) {
    // 编码器没给 alpha 通道 = 交出去的「透明素材」其实是实心的。宁可失败，不撒谎。
    await fs.unlink(moviePath).catch(() => {});
    throw new AlphaExportError(
      'ALPHA_ENCODE_LOST',
      `prores encoder produced ${pixFmt ?? 'unknown pix_fmt'} without an alpha channel`,
      { pixFmt },
    );
  }
  const verifyFrames = Array.isArray(opts.verifyFrames) ? opts.verifyFrames : [];
  const encodedAlpha = verifyFrames.length > 0
    ? await measureVideoAlpha({
        video: moviePath,
        frames: verifyFrames,
        size: { w: width, h: height },
        ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}),
      })
    : [];
  const reportPath = moviePath.replace(/\.mov$/i, '.alpha.json');
  const polarity = {
    mode,
    // 写进报告的不只是「乘了没乘」，还有**用什么乘的**：换滤镜等于换数值口径，
    // 下一次改这里必须重新量一遍三档误差。
    filter: mode === 'premultiplied' ? PREMULTIPLY_FILTER : null,
    premultiplied: mode === 'premultiplied',
  };
  await fs.writeFile(
    reportPath,
    `${JSON.stringify({ ...opts.report, polarity, encode: { pixFmt, probe: probe?.video ?? null, encodedAlpha } }, null, 2)}\n`,
    'utf8',
  );
  return {
    kind: 'prores4444',
    path: moviePath,
    frames: opts.frames,
    bytes: digest.bytes,
    sha256: digest.sha256,
    size: { w: width, h: height },
    pixFmt,
    mode,
    polarity,
    probe: probe?.video ?? null,
    encodedAlpha,
    reportPath,
    report: opts.report,
  };
}
