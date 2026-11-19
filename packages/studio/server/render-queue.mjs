/**
 * Studio 侧的渲染队列单例（M67 · WP23）。
 *
 * `packages/render/scheduler.mjs` 是纯调度核心；这里只做三件事：
 * 1. 解析并发（env 覆盖 + 越界报错）；
 * 2. 把状态文件/半成品目录固定到 `<home>/.opencut/render-queue/`；
 * 3. 给 HTTP 观测面一个不会抛的 `status()`（初始化失败时保留错误，路由回 400）。
 *
 * M70 起它是**真实导出**的唯一并发权威：`export-job.mjs` 入队后由这里的 runner 开跑
 * （runner 通过 `setRunner()` 晚绑定，避免两个模块的构造顺序打结）。**不再另存一份状态**：
 * `GET /api/render/queue` 与导出作业读的是同一个调度器实例。
 */

import os from 'node:os';
import path from 'node:path';

import { resolveRenderConcurrency } from '../../render/concurrency.mjs';
import { createScheduler } from '../../render/scheduler.mjs';

/**
 * @param {{
 *   home?: string,
 *   root?: string,
 *   env?: Record<string, string|undefined>,
 *   plan?: any,
 *   concurrency?: number,
 *   runner?: (job: any, ctx: {signal: AbortSignal, scheduler: any}) => any,
 *   logger?: (line: string) => void,
 * }} [options]
 */
export function createRenderQueue(options = {}) {
  const home = options.home ?? os.homedir();
  const root = options.root ?? path.join(home, '.opencut', 'render-queue');
  /** 所有 Studio 实例共享的半成品父目录；每个实例只在自己的子目录里干活（P81/M94）。 */
  const partialRoot = path.join(root, 'partial');
  const partialDir = path.join(partialRoot, `inst-${process.pid}-${Date.now().toString(36)}`);
  const env = options.env ?? process.env;
  /** 执行体：M70 由 Studio 晚绑定到 `exportJobs.runScheduled`。 */
  /** @type {((job: any, ctx: any) => any) | null} */
  let runner = typeof options.runner === 'function' ? options.runner : null;
  /** @type {{code: string, message: string, allowed?: any[]}|null} */
  let error = null;
  /** @type {any} */
  let scheduler = null;
  try {
    const concurrency = options.concurrency ?? resolveRenderConcurrency({ plan: options.plan ?? null, env });
    scheduler = createScheduler({
      concurrency,
      runner: (job, ctx) => {
        if (runner === null) {
          throw Object.assign(new Error('渲染队列没有执行体（先 setRunner）'), { code: 'RENDER_QUEUE_NO_RUNNER' });
        }
        return runner(job, ctx);
      },
      statePath: path.join(root, 'state.json'),
      partialDir,
      sweepRoot: partialRoot,
      ...(typeof options.logger === 'function' ? { logger: options.logger } : {}),
    });
  } catch (caught) {
    const typed = /** @type {any} */ (caught);
    error = {
      code: typeof typed?.code === 'string' ? typed.code : 'RENDER_QUEUE_INIT_FAILED',
      message: String(typed?.message ?? caught),
      ...(Array.isArray(typed?.allowed) ? { allowed: typed.allowed } : {}),
    };
  }
  const empty = { concurrency: 0, running: [], queued: [], completed: 0, failed: 0 };
  if (scheduler !== null) {
    // 崩溃恢复的结果只在这一刻拿得到：留一行可核对的日志（e2e 从子进程 stdout 里读）。
    void scheduler.ready.then(() => {
      const recovered = scheduler.recovery();
      if (recovered.interrupted.length > 0 || recovered.cleaned.files > 0 || recovered.issues.length > 0) {
        const line =
          `RENDER_QUEUE_RECOVER interrupted=${recovered.interrupted.length} ` +
          `cleanedFiles=${recovered.cleaned.files} cleanedBytes=${recovered.cleaned.bytes} ` +
          `issues=${recovered.issues.length}`;
        if (typeof options.logger === 'function') options.logger(line);
      }
    });
  }
  return {
    root,
    partialDir,
    /** M70：晚绑定执行体（Studio 在 exportJobs 建好之后调）。 */
    setRunner: (/** @type {any} */ fn) => {
      runner = typeof fn === 'function' ? fn : null;
    },
    get error() {
      return error;
    },
    ready: scheduler === null ? Promise.resolve() : scheduler.ready,
    status: () => (scheduler === null ? { ...empty } : scheduler.status()),
    /** @param {any} job */
    enqueue: (job) =>
      scheduler === null
        ? { ok: false, code: error?.code ?? 'RENDER_QUEUE_UNAVAILABLE', message: error?.message ?? '渲染队列不可用' }
        : scheduler.enqueue(job),
    /** @param {string} jobId */
    cancel: (jobId) =>
      scheduler === null
        ? { ok: false, code: error?.code ?? 'RENDER_QUEUE_UNAVAILABLE', message: error?.message ?? '渲染队列不可用' }
        : scheduler.cancel(jobId),
    get: (/** @type {string} */ jobId) => (scheduler === null ? null : scheduler.get(jobId)),
    recovery: () =>
      scheduler === null
        ? { interrupted: [], cleaned: { files: 0, bytes: 0 }, issues: [] }
        : scheduler.recovery(),
    insertions: () => (scheduler === null ? [] : scheduler.insertions()),
    /** 等状态文件落盘（测试/证据用：崩溃前必须确认 running/queued 已经写进磁盘）。 */
    flush: () => (scheduler === null ? Promise.resolve() : scheduler.flush()),
    close: () => (scheduler === null ? Promise.resolve() : scheduler.close()),
  };
}
