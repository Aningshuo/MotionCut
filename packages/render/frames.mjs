/**
 * 帧并行生产（单作业内部）。
 *
 * 依赖注入：`frameAt(t, ctx)` 由上游（副线1）提供；本文件**不实现**帧内核。
 * 并行只影响「谁先算完」，不影响「写到第几号文件」：每帧按时间线索引落盘，
 * 因此最终序列顺序与时间顺序一致。`completionOrder` 用于证明确实乱序完成。
 *
 * @typedef {import('../../contracts/render').RenderErrorCode} RenderErrorCode
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { RenderFailure } from './ffmpeg.mjs';
import { durationOfFrames, frameCountAt, rateOfFps } from './fps.mjs';

/**
 * @typedef {Object} ProduceOptions
 * @property {(timeSec: number, ctx: { index: number, attempt: number }) => Promise<Buffer | Uint8Array | { path: string } | { data: Buffer }>} frameAt
 * @property {number[]} times          每帧时间（秒），长度 = 总帧数
 * @property {number} workers          并行度（>= 1）
 * @property {string} outDir
 * @property {string} [pattern]        默认 frame-%05d.png
 * @property {number} [startNumber]    默认 1
 * @property {AbortSignal} [signal]
 * @property {number} [checkEveryFrames] 每写 N 帧复核一次工程
 * @property {() => Promise<boolean>} [checkProject] 返回 false 表示工程已变
 * @property {(done: number, total: number) => void} [onProgress]
 */

/**
 * @param {ProduceOptions} opts
 * @returns {Promise<{ framesWritten: number, completionOrder: number[], duplicateWrites: number }>}
 */
export async function produceFrames(opts) {
  const workers = Math.max(1, Math.floor(opts.workers));
  const total = opts.times.length;
  const pattern = opts.pattern ?? 'frame-%05d.png';
  if (!pattern.includes('%05d')) {
    throw new RenderFailure('FRAME_FAILED', `frame pattern must contain %05d: ${pattern}`);
  }
  const startNumber = opts.startNumber ?? 1;
  const checkEvery = opts.checkEveryFrames ?? 120;

  await fs.mkdir(opts.outDir, { recursive: true });

  if (total === 0) return { framesWritten: 0, completionOrder: [], duplicateWrites: 0 };

  /** 已完成的下标；并发写不同文件，不需要锁。 */
  const written = new Set();
  /** @type {number[]} */
  const completionOrder = [];
  let nextIndex = 0;
  let completed = 0;
  let duplicateWrites = 0;
  /** @type {RenderFailure | null} */
  let failure = null;

  /**
   * @returns {Promise<void>}
   */
  const worker = async () => {
    for (;;) {
      if (failure) return;
      if (opts.signal?.aborted) {
        failure = new RenderFailure('CANCELLED', 'frame production cancelled');
        return;
      }
      const index = nextIndex;
      nextIndex += 1;
      if (index >= total) return;

      const timeSec = opts.times[index];
      if (timeSec === undefined) {
        failure = new RenderFailure('FRAME_FAILED', `missing time for frame ${index}`);
        return;
      }

      try {
        const frame = await opts.frameAt(timeSec, { index, attempt: 1 });
        if (opts.signal?.aborted) {
          failure = new RenderFailure('CANCELLED', 'frame production cancelled');
          return;
        }
        const buffer = await readFrame(frame);
        if (written.has(index)) duplicateWrites += 1;
        written.add(index);
        // 关键：文件名由时间线索引决定，与完成先后无关。
        const file = path.join(opts.outDir, pattern.replace('%05d', String(index + startNumber).padStart(5, '0')));
        await fs.writeFile(file, buffer);
        completionOrder.push(index);
        completed += 1;
        opts.onProgress?.(completed, total);

        if (checkEvery > 0 && completed % checkEvery === 0 && opts.checkProject) {
          const unchanged = await opts.checkProject();
          if (!unchanged) {
            failure = new RenderFailure(
              'PROJECT_CHANGED',
              `project changed after ${completed}/${total} frames`,
            );
            return;
          }
        }
      } catch (err) {
        failure =
          err instanceof RenderFailure
            ? err
            : new RenderFailure('FRAME_FAILED', err instanceof Error ? err.message : String(err));
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(workers, total) }, () => worker()));
  if (failure) throw failure;

  const missing = total - written.size;
  if (missing !== 0) {
    throw new RenderFailure('FRAME_FAILED', `${missing} frame(s) missing after parallel production`);
  }
  return { framesWritten: written.size, completionOrder, duplicateWrites };
}

/**
 * @param {Buffer | Uint8Array | { path: string } | { data: Buffer }} frame
 * @returns {Promise<Buffer>}
 */
async function readFrame(frame) {
  if (Buffer.isBuffer(frame)) return frame;
  if (frame instanceof Uint8Array) return Buffer.from(frame);
  if (frame && typeof frame === 'object' && 'data' in frame) return Buffer.from(frame.data);
  if (frame && typeof frame === 'object' && 'path' in frame) {
    return fs.readFile(frame.path);
  }
  throw new RenderFailure('FRAME_FAILED', 'frameAt returned unsupported frame payload');
}

/**
 * 时间线 → 每帧时间（秒）。半开区间 [start, end)。
 *
 * `fps` 可以是有理数 `{num, den}`（P44）：分数帧率下帧数是 `round(t×num/den)`、
 * 第 i 帧是 `i×den/num`，不再用 29.97 这个十进制近似。整数帧率保留老表达式
 * `i / fps`——`i * (1/30)` 与 `i / 30` 可能差 1 个 ULP，30fps 的帧内容会因此漂。
 *
 * @param {{ startSec: number, endSec: number, fps: number | { num: number, den: number } }} range
 * @returns {number[]}
 */
export function frameTimes(range) {
  const rate = rateOfFps(range.fps);
  const frameCount = Math.max(1, frameCountAt(rate, range.endSec - range.startSec));
  /** @type {number[]} */
  const times = [];
  for (let i = 0; i < frameCount; i += 1) {
    times.push(range.startSec + (rate.den === 1 ? i / rate.num : durationOfFrames(rate, i)));
  }
  return times;
}
