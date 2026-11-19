/**
 * 静帧导出（P18）：把某一时刻的**整帧**取出来（网页也合成进去）。
 *
 * 走的是和 `export film` 完全一样的取帧入口（`stage-capture.mjs` 的 `captureAt`），
 * 所以「导出静帧」和「导出视频第 N 帧」在像素上是同一套东西，不需要第二套合成器。
 *
 * PNG 是无损的：舞台截图本身就是 PNG，直接落盘，不做任何再编码。
 * JPG 才需要 ffmpeg 转一次——用 `-q:v`（2 最好、31 最差），默认 2。
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * 时刻 → 文件名里的一段（固定三位小数，保证字典序=时间序，且两次导出同名）。
 * @param {number} t
 * @returns {string}
 */
export function stillName(t) {
  return `still-${Number(t).toFixed(3)}s`;
}

/**
 * 取一批时刻的整帧。
 *
 * @param {{
 *   projectRoot: string,
 *   times: number[],
 *   contentPort?: number,
 *   projectsRoot?: string,
 *   frameTimeoutMs?: number,
 *   signal?: AbortSignal,
 *   logger?: (line: string) => void,
 *   size?: { w: number, h: number },
 *   stageFit?: 'none' | 'contain',
 * }} opts
 * @returns {Promise<{ stage: { w: number, h: number }, viewport: { w: number, h: number }, projectId: string, shots: Array<{ t: number, png: Buffer }>, bootErrors: any[], pageErrors: string[] }>}
 */
export async function captureStills(opts) {
  const times = opts.times.map((t) => Number(t));
  if (times.length === 0) throw new Error('INVALID: at least one time is required');
  const { startStageCapture } = await import('./stage-capture.mjs');
  const session = await startStageCapture({
    projectRoot: opts.projectRoot,
    // 画幅（P29）：静帧要能跟**成片**在同一个几何下比，否则「预览 vs 成片」永远差一层缩放，
    // 比出来的 p99 只能说明缩放算法，说明不了画面是否一致。
    ...(opts.size ? { size: opts.size } : {}),
    ...(opts.stageFit ? { stageFit: opts.stageFit } : {}),
    ...(opts.contentPort !== undefined ? { contentPort: opts.contentPort } : {}),
    ...(opts.projectsRoot ? { projectsRoot: opts.projectsRoot } : {}),
    ...(opts.frameTimeoutMs !== undefined ? { frameTimeoutMs: opts.frameTimeoutMs } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
  try {
    /** @type {Array<{ t: number, png: Buffer }>} */
    const shots = [];
    for (const t of times) {
      if (opts.signal?.aborted) {
        const err = new Error('CAPTURE_CANCELLED: still capture cancelled');
        /** @type {any} */ (err).code = 'CAPTURE_CANCELLED';
        throw err;
      }
      shots.push({ t, png: await session.captureAt(t) });
    }
    const after = await session.probe();
    const real = after.errors.slice(session.bootErrors.length);
    if (real.length > 0) {
      const first = real[0];
      const err = new Error(`${first.code}: ${first.message}`);
      /** @type {any} */ (err).code = first.code;
      throw err;
    }
    return {
      stage: session.stage,
      viewport: session.viewport ?? session.stage,
      projectId: session.projectId,
      shots,
      bootErrors: session.bootErrors,
      pageErrors: session.pageErrors,
    };
  } finally {
    await session.close().catch(() => {});
  }
}

/**
 * PNG 字节 → 裁切后的 PNG 字节。滤镜与成片的 cover 裁切**同一个** `crop=w:h:x:y`，
 * 所以「预览裁在哪」与「成片裁在哪」不会各说一套。
 * @param {Buffer} png
 * @param {{ w: number, h: number, x: number, y: number }} box
 * @param {{ ffmpegPath?: string }} [opts]
 * @returns {Promise<Buffer>}
 */
export async function cropPng(png, box, opts = {}) {
  const w = Math.max(2, Math.round(box.w));
  const h = Math.max(2, Math.round(box.h));
  const x = Math.max(0, Math.round(box.x));
  const y = Math.max(0, Math.round(box.y));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-crop-'));
  const input = path.join(dir, 'in.png');
  try {
    await fs.writeFile(input, png);
    const out = path.join(dir, 'out.png');
    await execFileAsync(opts.ffmpegPath ?? 'ffmpeg', [
      '-v', 'error', '-y', '-i', input,
      '-vf', `crop=${w}:${h}:${x}:${y}`,
      // PNG 是无损的：不指定编码参数，避免 ffmpeg 默认转成有损的东西
      '-frames:v', '1', out,
    ]);
    return await fs.readFile(out);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * PNG 字节 → JPG 字节（ffmpeg `-q:v`，2 最好、31 最差）。
 * @param {Buffer} png
 * @param {{ quality?: number, ffmpegPath?: string }} [opts]
 * @returns {Promise<Buffer>}
 */
export async function pngToJpg(png, opts = {}) {
  const quality = Number.isInteger(opts.quality) ? Number(opts.quality) : 2;
  if (!(quality >= 1 && quality <= 31)) throw new Error('INVALID: jpg quality must be 1..31 (lower is better)');
  const tmp = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-still-')), 'in.png');
  try {
    await fs.writeFile(tmp, png);
    const out = `${tmp}.jpg`;
    await execFileAsync(opts.ffmpegPath ?? 'ffmpeg', ['-v', 'error', '-y', '-i', tmp, '-q:v', String(quality), out]);
    return await fs.readFile(out);
  } finally {
    await fs.rm(path.dirname(tmp), { recursive: true, force: true }).catch(() => {});
  }
}
