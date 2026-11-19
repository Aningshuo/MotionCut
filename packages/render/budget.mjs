/**
 * 自动并行预算（合同 `RenderBudget`）。
 *
 * 自动值 = min(max(1, cpu-1), max(1, floor(freeMem/2GiB)), max(1, ceil(frames/120)), 4)，下限 1。
 * `4` 只是参考自动默认上限；用户给了 `budget.workers` 就按用户的，`source='user'`，
 * 不被 4 卡死。`basis` 记录自动决策时看到的输入，UI 才能解释「为什么是 3」。
 *
 * 注意：这是**单作业内部**的帧并行度；同 Studio 的多作业仍排队一次一个。
 */

import os from 'node:os';

export const BYTES_PER_GIB = 1024 ** 3;
export const MEM_PER_WORKER_BYTES = 2 * BYTES_PER_GIB;
export const FRAMES_PER_WORKER = 120;
/** 参考自动默认上限，不是硬锁。 */
export const AUTO_WORKER_CAP = 4;
/** 用户值只做整数与合理上限校验，不被 4 限制。 */
export const MAX_USER_WORKERS = 64;

/**
 * @typedef {import('../../contracts/render').RenderBudget} RenderBudget
 */

/**
 * @param {{ cpu: number, freeMemBytes: number, frames: number, userWorkers?: number }} input
 * @returns {RenderBudget}
 */
export function computeRenderBudget(input) {
  const cpu = finitePositiveInt(input.cpu, 'cpu');
  const freeMemBytes = finiteNonNegative(input.freeMemBytes, 'freeMemBytes');
  const frames = finiteNonNegative(input.frames, 'frames');

  if (input.userWorkers !== undefined) {
    if (!Number.isInteger(input.userWorkers) || input.userWorkers < 1) {
      throw new TypeError(`userWorkers must be an integer >= 1, got ${String(input.userWorkers)}`);
    }
    const workers = Math.min(input.userWorkers, MAX_USER_WORKERS);
    return { source: 'user', workers };
  }

  const byCpu = Math.max(1, cpu - 1);
  const byMem = Math.max(1, Math.floor(freeMemBytes / MEM_PER_WORKER_BYTES));
  const byFrames = Math.max(1, Math.ceil(frames / FRAMES_PER_WORKER));
  const workers = Math.max(1, Math.min(byCpu, byMem, byFrames, AUTO_WORKER_CAP));

  return { source: 'auto', workers, basis: { cpu, freeMemBytes, frames } };
}

/**
 * 从本机读输入并算预算。`os` 可注入，测试不依赖真机数值。
 * @param {{ frames: number, userWorkers?: number, osModule?: { availableParallelism?: () => number, cpus?: () => unknown[], freemem?: () => number } }} input
 * @returns {RenderBudget}
 */
export function detectRenderBudget(input) {
  const osModule = input.osModule ?? os;
  const cpu =
    typeof osModule.availableParallelism === 'function'
      ? osModule.availableParallelism()
      : (osModule.cpus?.().length ?? 1);
  const freeMemBytes = typeof osModule.freemem === 'function' ? osModule.freemem() : 0;
  return computeRenderBudget({
    cpu,
    freeMemBytes,
    frames: input.frames,
    ...(input.userWorkers !== undefined ? { userWorkers: input.userWorkers } : {}),
  });
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function finitePositiveInt(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw new TypeError(`${name} must be a finite number >= 1, got ${String(value)}`);
  }
  return Math.floor(value);
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function finiteNonNegative(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite number >= 0, got ${String(value)}`);
  }
  return value;
}
