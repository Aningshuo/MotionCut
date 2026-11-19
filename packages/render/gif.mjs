/**
 * GIF 导出（P18）：PNG 序列 → 调色板 GIF。
 *
 * 两件事必须做对，否则 GIF 会「看着能播但颜色脏」或「不受控地抖」：
 * 1. **调色板**：用 `palettegen` 从整段统计出一张全局调色板（`stats_mode=diff` 只统计
 *    变化区域，避免静态背景把色位吃光），再用 `paletteuse` 上色；单帧各自 palettegen
 *    会让每帧调色板抖动，播起来闪。
 * 2. **抖动**：`dither=sierra2_4a`。不开抖动在渐变上会出现色带；开错算法（如 bayer）
 *    会有明显网点。这个组合是 ffmpeg 文档里给"照片/视频转 GIF"的推荐值。
 *
 * 循环：`-loop 0` = 无限循环。这是 GIF 自己的标记，不是靠播放器行为。
 *
 * 确定性：GIF 没有时间戳字段，ffmpeg 的 palettegen/paletteuse 不含随机性，
 * 所以同参数两次导出应当逐字节相同（R9 实测如此）。若哪天不同，先查 ffmpeg 版本。
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * @param {{
 *   framesDir: string,
 *   pattern?: string,
 *   frames: number,
 *   fps: number,
 *   width: number,
 *   outPath: string,
 *   ffmpegPath?: string,
 *   signal?: AbortSignal,
 *   dither?: string,
 * }} opts
 * @returns {Promise<{ path: string, bytes: number, frames: number, fps: number, width: number, filter: string }>}
 */
export async function renderGif(opts) {
  const frames = Number(opts.frames);
  const fps = Number(opts.fps);
  const width = Number(opts.width);
  if (!Number.isFinite(frames) || frames <= 0) throw invalid(`frames must be a positive integer, got ${opts.frames}`);
  if (!Number.isFinite(fps) || fps <= 0 || fps > 50) throw invalid(`fps must be 1..50, got ${opts.fps}`);
  if (!Number.isFinite(width) || width < 16 || width > 4096) throw invalid(`width must be 16..4096, got ${opts.width}`);

  const pattern = opts.pattern ?? 'frame-%06d.png';
  // 高度按比例取偶数：GIF 没有"半像素"，奇数高会被 ffmpeg 直接拒绝
  const filter =
    `scale=${width}:-1:flags=lanczos,split[a][b];` +
    `[a]palettegen=stats_mode=diff[p];` +
    `[b][p]paletteuse=dither=${opts.dither ?? 'sierra2_4a'}`;

  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-framerate', String(fps),
    '-i', path.join(opts.framesDir, pattern),
    '-vf', filter,
    '-frames:v', String(frames),
    '-loop', '0',
    opts.outPath,
  ];

  await fs.mkdir(path.dirname(opts.outPath), { recursive: true });
  const partial = `${opts.outPath}.partial.gif`;
  await fs.unlink(partial).catch(() => {});
  try {
    await execFileAsync(opts.ffmpegPath ?? 'ffmpeg', [...args.slice(0, -1), partial], {
      maxBuffer: 16 * 1024 * 1024,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (opts.signal?.aborted) throw invalid('CANCELLED: gif cancelled', 'CANCELLED');
    // 半成品绝不改名成成品：只有 ffmpeg 正常退出才 commit
    await fs.rename(partial, opts.outPath);
  } catch (err) {
    await fs.unlink(partial).catch(() => {});
    throw err;
  }
  const stat = await fs.stat(opts.outPath);
  return { path: opts.outPath, bytes: stat.size, frames, fps, width, filter };
}

/**
 * @param {string} message
 * @param {string} [code]
 */
function invalid(message, code = 'INVALID') {
  const err = new Error(`${code}: ${message}`);
  /** @type {any} */ (err).code = code;
  return err;
}
