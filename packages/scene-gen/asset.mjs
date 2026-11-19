/**
 * assetSpec · 颜色/尺寸/时长 → 素材 + 片段（M87-WP21，M93 搬进产品包）
 *
 * 两种模式：
 * - `video`（默认，验收链用）：源图 + ffmpeg 参数 → 真编码成 mp4，片段引 `.mp4`；
 * - `still`（产品请求内用）：**只**产出逐像素算的渐变 PNG，片段是一张 PNG 静帧，
 *   `time` 到 `seconds` 为止。产品在 HTTP 请求里**不起 ffmpeg**（那是导出作业的活），
 *   所以素材以静帧形式落盘——像素与 mp4 同源，这一点在 m93 的证据里写死，不藏。
 *
 * 源图不是 `-f lavfi gradients`：那个每次跑出来的画面都不一样，同一个 seed 也不稳，
 * 编码字节每次都变（M86 已踩过）。
 *
 * ops 只做一件事：把这个素材插进序列。文件名由「颜色 + 尺寸 + 时长」的哈希派生，
 * 换一组颜色就是**另一个文件**，不会读到上一次的缓存。
 */

import path from 'node:path';

import { encodePng } from '../render/png.mjs';
import { SCENE_GEN_CODES, sceneError } from './errors.mjs';

/** @param {unknown} value @param {number} [length] */
function stableHex(value, length = 8) {
  const text = String(value);
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.codePointAt(index) ?? 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').slice(0, length);
}

/**
 * `#3b6ea5` → [59,110,165]；不合法就抛（不默默当黑色）。
 * @param {string} text
 * @returns {[number, number, number]}
 */
export function parseHexColor(text) {
  const match = /^#([0-9a-fA-F]{6})$/.exec(String(text ?? '').trim());
  if (match === null) throw sceneError(SCENE_GEN_CODES.BAD_COLOR, `assetSpec 需要 #rrggbb 颜色，收到「${String(text)}」`);
  const value = Number.parseInt(match[1] ?? '0', 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/**
 * 水平线性渐变：`x/(w-1)` 从 from 插到 to。逐像素自己算，字节确定。
 * @param {{ w: number, h: number, from: readonly number[], to: readonly number[] }} input
 * @returns {Buffer}
 */
export function gradientPng(input) {
  const { w, h, from, to } = input;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
    throw sceneError(SCENE_GEN_CODES.BAD_VALUE, 'gradientPng 的 w/h 必须是正整数');
  }
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const k = w === 1 ? 0 : x / (w - 1);
      const index = (y * w + x) * 4;
      data[index] = Math.round((from[0] ?? 0) + ((to[0] ?? 0) - (from[0] ?? 0)) * k);
      data[index + 1] = Math.round((from[1] ?? 0) + ((to[1] ?? 0) - (from[1] ?? 0)) * k);
      data[index + 2] = Math.round((from[2] ?? 0) + ((to[2] ?? 0) - (from[2] ?? 0)) * k);
      data[index + 3] = 255;
    }
  }
  return encodePng({ width: w, height: h, data });
}

/**
 * @typedef {{
 *   kind: 'asset',
 *   mode: 'video' | 'still',
 *   name: string,
 *   png: Buffer,
 *   files: Array<{ path: string, data: Buffer }>,
 *   srcPath: string,
 *   outPath: string,
 *   ffmpegArgs: string[] | null,
 *   ops: any[],
 *   meta: {
 *     kind: 'gradient' | 'solid',
 *     mode: 'video' | 'still',
 *     from?: string,
 *     to?: string,
 *     w: number,
 *     h: number,
 *     seconds: number,
 *     fps: number,
 *     box: { x: number, y: number, w: number, h: number },
 *     clipId: string,
 *     frames: number,
 *     src: string,
 *   },
 * }} AssetSpecResult
 */

/**
 * @param {{
 *   kind?: 'gradient' | 'solid',
 *   mode?: 'video' | 'still',
 *   from: string,
 *   to?: string,
 *   w?: number,
 *   h?: number,
 *   seconds?: number,
 *   fps?: number,
 *   box?: { x: number, y: number, w: number, h: number },
 *   outDir?: string,
 *   clipId?: string,
 * }} input
 * @returns {AssetSpecResult}
 */
export function assetSpec(input) {
  const kind = input?.kind === 'solid' ? 'solid' : 'gradient';
  const mode = input?.mode === 'still' ? 'still' : 'video';
  const w = Number.isInteger(input?.w) ? Number(input?.w) : 640;
  const h = Number.isInteger(input?.h) ? Number(input?.h) : 360;
  const seconds = Number.isFinite(input?.seconds) ? Number(input?.seconds) : 2;
  const fps = Number.isInteger(input?.fps) ? Number(input?.fps) : 30;
  const from = parseHexColor(String(input?.from));
  const to = kind === 'solid' ? from : parseHexColor(String(input?.to ?? input?.from));
  const outDir = String(input?.outDir ?? '');
  if (mode === 'video' && outDir === '') {
    throw sceneError(SCENE_GEN_CODES.MISSING_OUTDIR, 'assetSpec 的 video 模式需要 outDir（工程根目录）');
  }
  if (!(seconds > 0)) throw sceneError(SCENE_GEN_CODES.BAD_SECONDS, 'assetSpec 的 seconds 必须大于 0');

  const box = input?.box ?? { x: Math.round((1280 - w) / 2), y: Math.round((720 - h) / 2), w, h };
  const name = `gen-${stableHex(
    `${kind}|${from.join(',')}|${to.join(',')}|${String(w)}x${String(h)}|${String(seconds)}s|${String(fps)}|${mode}`,
  )}`;
  const pngPath = path.join(outDir, 'assets', `${name}.png`);
  const mp4Path = path.join(outDir, 'assets', `${name}.mp4`);
  const clipId = typeof input?.clipId === 'string' && input.clipId !== '' ? input.clipId : 'gen';

  const png = gradientPng({ w, h, from, to });
  const src = mode === 'still' ? `assets/${name}.png` : `assets/${name}.mp4`;
  const ffmpegArgs =
    mode === 'still'
      ? null
      : [
          '-v', 'error',
          '-loop', '1',
          '-i', pngPath,
          '-t', String(seconds),
          '-r', String(fps),
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-pix_fmt', 'yuv420p',
          '-y', mp4Path,
        ];

  /** @type {any[]} */
  const ops = [
    {
      op: 'insert',
      clip: { id: clipId, src, time: [0, seconds], box },
      track: { insert: 0 },
    },
  ];

  return {
    kind: 'asset',
    mode,
    name,
    png,
    files: [{ path: `assets/${name}.png`, data: png }],
    srcPath: pngPath,
    outPath: mp4Path,
    ffmpegArgs,
    ops,
    meta: {
      kind,
      mode,
      from: input?.from,
      to: kind === 'solid' ? input?.from : input?.to,
      w,
      h,
      seconds,
      fps,
      box,
      clipId,
      frames: seconds * fps,
      src,
    },
  };
}
