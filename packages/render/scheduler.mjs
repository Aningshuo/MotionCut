/**
 * 渲染/采集调度器（M67 · WP23）
 *
 * ## 为什么单独一层
 *
 * 导出作业（`studio/server/export-job.mjs`）是**单作业**的进度状态机；多工程并存时还需要
 * 一个「谁先跑、同时跑几个、怎么取消、重启后怎么收尾」的确定性调度层。这里不碰具体渲染，
 * 只做队列与槽位；真正的执行由 `runner(job, { signal })` 注入（测试用假 runner，e2e 用
 * 真子进程）。这样「并发上限/公平/取消/恢复」可以脱离 ffmpeg 单独证明。
 *
 * ## 写死的语义（任务书 §3）
 *
 * - 并发数由调用方给（默认已在 `concurrency.mjs#resolveRenderConcurrency` 解析）；
 * - 公平：某工程一入队就超过 3 个（成为 hog）且队列里有别的工程时，**每 2 个连续任务
 *   必须插 1 个其他工程**。规则只看队列与已派发历史，不含随机数；
 * - 取消：排队中立即移出；运行中 `abort()`，槽位最多 2s 释放（1s 内停是 runner 的义务）；
 * - 恢复：状态文件里 running/queued 一律 `failed(interrupted)`，**不重跑**；
 *   `partialDir` 下的半成品文件删除并记录 `{files, bytes}`；
 * - `status()` 固定返回 `{concurrency, running, queued, completed, failed}`。
 *
 * 状态落盘用「同目录临时文件 → fsync → rename」；写失败只记 issue，不影响调度。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const SCHEDULER_VERSION = 1;
/** 取消运行中任务后，槽位最迟多久释放（任务书 §3.4 的 2s）。 */
export const CANCEL_RELEASE_MS = 2000;
/** 同一工程一次排队超过这个数就算 hog（任务书 §3.3）。 */
export const FAIRNESS_HOG_THRESHOLD = 3;
/** 公平规则：hog 每连续派发 2 个，必须插 1 个其他工程。 */
export const FAIRNESS_INSERT_EVERY = 2;

/**
 * @typedef {{id: string, projectId: string, kind: 'export'|'capture', priority: number, createdAt: number}} JobInput
 */

/**
 * @typedef {JobInput & {
 *   status: 'queued'|'running'|'completed'|'failed'|'cancelled',
 *   startedAt?: number, finishedAt?: number, error?: string, result?: any,
 *   cancelRequestedAt?: number, releasedByTimeout?: boolean,
 *   controller?: AbortController,
 * }} Job
 */

/**
 * @param {any} a
 * @param {any} b
 */
function compareJobs(a, b) {
  if (b.priority !== a.priority) return b.priority - a.priority;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** @param {string} text */
function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * 创建调度器。
 *
 * @param {{
 *   concurrency: number,
 *   runner?: (job: Job, ctx: {signal: AbortSignal, scheduler: any}) => Promise<any>|any,
 *   statePath?: string,
 *   partialDir?: string,
 *   sweepRoot?: string,
 *   now?: () => number,
 *   autoStart?: boolean,
 *   logger?: (line: string) => void,
 * }} options
 */
export function createScheduler(options) {
  if (!Number.isInteger(options?.concurrency) || options.concurrency < 1) {
    throw new TypeError('createScheduler requires concurrency >= 1');
  }
  const concurrency = options.concurrency;
  const runner = typeof options.runner === 'function' ? options.runner : async () => undefined;
  const statePath = typeof options.statePath === 'string' ? options.statePath : '';
  const partialDir = typeof options.partialDir === 'string' ? options.partialDir : '';
  /* 所有实例共享的父目录（`…/render-queue/partial`）。给了它，启动时只清**死进程**的
     `inst-<pid>-*` 子目录；不给就退回「把 partialDir 整棵清掉」的老行为（单实例假定）。 */
  const sweepRoot = typeof options.sweepRoot === 'string' ? options.sweepRoot : '';
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const log = typeof options.logger === 'function' ? options.logger : () => {};

  /**
   * pid 还活着吗（与 `port.mjs` 同一判据：EPERM 说明进程在，只是没权限）。
   * @param {number} pid
   */
  function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return /** @type {any} */ (error)?.code === 'EPERM';
    }
  }

  /**
   * 数一棵子树里的文件数与字节（清理前记账，删完就不知道清了多少）。
   * @param {string} dir
   * @returns {Promise<{files: number, bytes: number}>}
   */
  async function countFiles(dir) {
    let files = 0;
    let bytes = 0;
    /** @param {string} current */
    const walk = async (current) => {
      /** @type {import('node:fs').Dirent[]} */
      let entries;
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        const info = await fs.stat(full).catch(() => null);
        if (info === null) continue;
        files += 1;
        bytes += info.size;
      }
    };
    await walk(dir);
    return { files, bytes };
  }

  /** @type {Map<string, Job>} */
  const jobs = new Map();
  /** @type {Map<string, Job>} */
  const queued = new Map();
  /** @type {Map<string, Job>} */
  const running = new Map();
  /** @type {Map<string, Promise<any>>} */
  const active = new Map();
  /** 已派发顺序（projectId），用于公平判定；只留最近 8 个。 */
  /** @type {string[]} */
  const history = [];
  /** 一次入队超过阈值的工程（hog）；队列清空即摘帽。 */
  /** @type {Set<string>} */
  const hogs = new Set();
  /** @type {{at: number, projectId: string, hogProjectId: string}[]} */
  const insertions = [];

  let completed = 0;
  let failed = 0;
  let closed = false;
  let started = false;
  let stateIssue = '';
  /** @type {Promise<any>} */
  let persistChain = Promise.resolve();
  /** @type {{interrupted: string[], cleaned: {files: number, bytes: number}, issues: string[]}} */
  let recovery = { interrupted: [], cleaned: { files: 0, bytes: 0 }, issues: [] };

  /**
   * 状态快照：只记「还在路上」的 + 计数；完成/失败的明细不落盘（重启后也不需要）。
   * @returns {any}
   */
  function snapshot() {
    const view = (/** @type {Job} */ job) => ({
      id: job.id,
      projectId: job.projectId,
      kind: job.kind,
      priority: job.priority,
      createdAt: job.createdAt,
      startedAt: job.startedAt ?? null,
    });
    return {
      version: SCHEDULER_VERSION,
      savedAt: new Date(now()).toISOString(),
      concurrency,
      running: [...running.values()].map(view),
      queued: [...queued.values()].map(view),
      completed,
      failed,
    };
  }

  /** 临时文件 → fsync → rename（失败只记 issue）。 */
  function persist() {
    if (statePath === '') return Promise.resolve();
    const text = `${JSON.stringify(snapshot(), null, 2)}\n`;
    persistChain = persistChain
      .then(async () => {
        const dir = path.dirname(statePath);
        await fs.mkdir(dir, { recursive: true });
        const temp = path.join(dir, `.${path.basename(statePath)}.${process.pid}.${Date.now()}.tmp`);
        const handle = await fs.open(temp, 'w');
        try {
          await handle.writeFile(text, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(temp, statePath);
      })
      .catch((error) => {
        stateIssue = String(/** @type {Error} */ (error)?.message ?? error);
        log(`SCHEDULER_STATE_WRITE_FAILED ${stateIssue}`);
      });
    return persistChain;
  }

  /**
   * 统计某工程当前排队数；> 阈值就戴上 hog 帽。
   * @param {string} projectId
   */
  function refreshHog(projectId) {
    let count = 0;
    for (const job of queued.values()) if (job.projectId === projectId) count += 1;
    if (count > FAIRNESS_HOG_THRESHOLD) hogs.add(projectId);
    if (count === 0) hogs.delete(projectId);
  }

  /**
   * 取下一个：priority 高 → createdAt 早 → id 字典序。
   * 若队头工程是 hog 且已连续派发 2 个，则强制插一个别的工程（确定性，不随机）。
   * @returns {Job|null}
   */
  function pickNext() {
    const candidates = [...queued.values()].sort(compareJobs);
    if (candidates.length === 0) return null;
    const top = candidates[0];
    if (top === undefined) return null;
    const last = history[history.length - 1];
    const prev = history[history.length - 2];
    const hogged = hogs.has(top.projectId) && last === top.projectId && prev === top.projectId;
    if (hogged) {
      const other = candidates.find((/** @type {Job} */ job) => job.projectId !== top.projectId);
      if (other !== undefined) {
        insertions.push({ at: history.length, projectId: other.projectId, hogProjectId: top.projectId });
        return other;
      }
    }
    return top;
  }

  /**
   * 派发一个；同步占槽，异步执行。
   * @param {Job} job
   */
  function start(job) {
    queued.delete(job.id);
    job.status = 'running';
    job.startedAt = now();
    running.set(job.id, job);
    history.push(job.projectId);
    if (history.length > 8) history.shift();
    refreshHog(job.projectId);
    const controller = new AbortController();
    job.controller = controller;
    const promise = Promise.resolve()
      .then(() => runner(job, { signal: controller.signal, scheduler: api }))
      .then((result) => {
        if (job.status === 'cancelled') return;
        job.status = 'completed';
        job.result = result;
        completed += 1;
      })
      .catch((error) => {
        if (job.status === 'cancelled') return;
        job.status = 'failed';
        job.error = String(/** @type {Error} */ (error)?.message ?? error);
        failed += 1;
      })
      .finally(() => {
        running.delete(job.id);
        active.delete(job.id);
        job.controller = undefined;
        if (job.finishedAt === undefined) job.finishedAt = now();
        void persist();
        if (!closed) pump();
      });
    active.set(job.id, promise);
    void persist();
  }

  function pump() {
    if (closed || !started) return;
    while (running.size < concurrency) {
      const job = pickNext();
      if (job === null) break;
      start(job);
    }
  }

  /**
   * 崩溃恢复：状态文件里的 running/queued 全标 `failed(interrupted)`，不重跑；
   * partialDir 下的文件删除并记录字节。
   */
  async function recover() {
    /** @type {string[]} */
    const issues = [];
    /** @type {string[]} */
    const interrupted = [];
    if (statePath !== '') {
      let text = '';
      try {
        text = await fs.readFile(statePath, 'utf8');
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') issues.push(`STATE_UNREADABLE:${statePath}`);
        text = '';
      }
      if (text !== '') {
        /** @type {any} */
        let state = null;
        try {
          state = JSON.parse(text);
        } catch {
          state = null;
        }
        if (state === null || typeof state !== 'object') {
          issues.push(`STATE_CORRUPT:${statePath}`);
        } else {
          const stale = [...(Array.isArray(state.running) ? state.running : []), ...(Array.isArray(state.queued) ? state.queued : [])];
          for (const raw of stale) {
            if (raw === null || typeof raw !== 'object' || typeof raw.id !== 'string') continue;
            interrupted.push(raw.id);
            jobs.set(raw.id, {
              id: raw.id,
              projectId: String(raw.projectId ?? ''),
              kind: raw.kind === 'capture' ? 'capture' : 'export',
              priority: Number.isFinite(raw.priority) ? raw.priority : 0,
              createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now(),
              status: 'failed',
              error: 'interrupted',
              finishedAt: now(),
            });
          }
          failed += interrupted.length;
          // 计数以状态文件为准（进程重启后内存计数归零，但已完成/失败是历史事实）。
          if (Number.isFinite(state.completed)) completed = Math.max(completed, Number(state.completed));
          if (Number.isFinite(state.failed)) failed = Math.max(failed, Number(state.failed), interrupted.length);
        }
      }
    }
    const cleaned = await cleanPartial();
    if (cleaned.issues.length > 0) issues.push(...cleaned.issues);
    recovery = { interrupted, cleaned: { files: cleaned.files, bytes: cleaned.bytes }, issues };
    await persist();
  }

  /** 删掉 partialDir 里的半成品（不跟随符号链接）。 */
  async function cleanPartial() {
    /** @type {{files: number, bytes: number, issues: string[]}} */
    const result = { files: 0, bytes: 0, issues: [] };
    if (partialDir === '') return result;

    /**
     * P81（M94）· 根因修复：`partialDir` 曾经是所有 Studio **共享**的
     * `~/.opencut/render-queue/partial`，启动时整棵删。于是「A 正在导出、B 启动」
     * 会把 A 手里那个 `.video.partial.mp4` 删掉，A 的 `commitOutput` 拿到
     * `ENOENT` → `FRAME_FAILED: commit failed: ENOENT`（s74 的抖动就是这个）。
     *
     * 现在每个 Studio 实例用自己的 `inst-<pid>-<tag>/` 子目录（见 render-queue.mjs），
     * 启动时只清**owner 进程已经死了**的子目录；活着的一律不碰。
     */
    if (sweepRoot !== '') {
      /** @param {string} dir */
      const sweepDeadInstance = async (dir) => {
        /** @type {import('node:fs').Dirent[]} */
        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (error) {
          if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') result.issues.push(`UNREADABLE:${dir}`);
          return;
        }
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          if (!entry.isDirectory()) continue;
          const full = path.join(dir, entry.name);
          /* 自己的实例目录不碰。 */
          if (path.resolve(full) === path.resolve(partialDir)) continue;
          const match = /^inst-(\d+)-/.exec(entry.name);
          if (match !== null) {
            const pid = Number(match[1]);
            /* 同一进程的**别的**实例目录也不能碰：导出作业自己会在进程内起一个
               stage-capture Studio（它也有自己的实例目录），而导出中的 tmpDir 在
               另一个实例目录里 —— P81 复现到的正是这一下（s74 的 `film-subbed.mp4`
               被自己进程里的 capture Studio 清掉）。同 pid 的残留交给下一个进程回收。 */
            if (pid === process.pid) continue;
            /* 别的活着的进程同理：那是另一台 Studio 正在导出的活儿。 */
            if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) continue;
          }
          /* 走到这里：要么是死进程的 `inst-*`，要么是 R50 之前那种 `opencut-export-*`
             老现场 —— 都按「crash 残留」清掉并记账。 */
          const counted = await countFiles(full);
          await fs.rm(full, { recursive: true, force: true }).catch(() => undefined);
          result.files += counted.files;
          result.bytes += counted.bytes;
        }
      };
      await sweepDeadInstance(sweepRoot);
    }

    /** @param {string} dir */
    const walk = async (dir) => {
      /** @type {import('node:fs').Dirent[]} */
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
          result.issues.push(`UNREADABLE:${dir}`);
        }
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          await walk(full);
          await fs.rmdir(full).catch(() => {});
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          const info = await fs.stat(full);
          await fs.unlink(full);
          result.files += 1;
          result.bytes += info.size;
        } catch {
          result.issues.push(`UNREADABLE:${full}`);
        }
      }
    };
    await walk(partialDir);
    return result;
  }

  /**
   * @param {unknown} input
   * @returns {{ok: true, job: any} | {ok: false, code: string, message: string}}
   */
  function enqueue(input) {
    if (closed) return { ok: false, code: 'SCHEDULER_CLOSED', message: '调度器已关闭' };
    if (input === null || typeof input !== 'object') {
      return { ok: false, code: 'INVALID_JOB', message: 'job 必须是对象' };
    }
    const raw = /** @type {Record<string, any>} */ (input);
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (id === '') return { ok: false, code: 'INVALID_JOB', message: 'job.id 必须是非空字符串' };
    if (jobs.has(id)) return { ok: false, code: 'DUPLICATE_JOB', message: `job.id 重复：${id}` };
    const projectId = typeof raw.projectId === 'string' ? raw.projectId.trim() : '';
    if (projectId === '') return { ok: false, code: 'INVALID_JOB', message: 'job.projectId 必须是非空字符串' };
    if (raw.kind !== 'export' && raw.kind !== 'capture') {
      return { ok: false, code: 'INVALID_KIND', message: `job.kind 只能是 export / capture（收到 ${String(raw.kind)}）` };
    }
    const priority = raw.priority === undefined ? 0 : Number(raw.priority);
    if (!Number.isFinite(priority)) return { ok: false, code: 'INVALID_JOB', message: 'job.priority 必须是有限数字' };
    const createdAt = raw.createdAt === undefined ? now() : Number(raw.createdAt);
    if (!Number.isFinite(createdAt)) return { ok: false, code: 'INVALID_JOB', message: 'job.createdAt 必须是有限数字' };
    /** @type {Job} */
    const job = { id, projectId, kind: raw.kind, priority, createdAt, status: 'queued' };
    jobs.set(id, job);
    queued.set(id, job);
    refreshHog(projectId);
    void persist();
    pump();
    return { ok: true, job: { id, projectId, kind: raw.kind, priority, createdAt } };
  }

  /**
   * @param {string} jobId
   */
  async function cancel(jobId) {
    const job = jobs.get(jobId);
    if (job === undefined) return { ok: false, code: 'JOB_NOT_FOUND', message: `没有这个任务：${jobId}` };
    if (job.status === 'cancelled') return { ok: true, already: true, status: 'cancelled', was: 'cancelled' };
    if (job.status === 'completed' || job.status === 'failed') {
      return { ok: false, code: 'JOB_NOT_CANCELLABLE', status: job.status, message: `任务已 ${job.status}` };
    }
    if (job.status === 'queued') {
      queued.delete(job.id);
      job.status = 'cancelled';
      job.finishedAt = now();
      refreshHog(job.projectId);
      await persist();
      pump();
      return { ok: true, status: 'cancelled', was: 'queued', releasedMs: 0 };
    }
    // running
    const began = Date.now();
    job.status = 'cancelled';
    job.cancelRequestedAt = now();
    job.controller?.abort();
    const entry = active.get(job.id);
    const raced = await Promise.race([
      entry === undefined ? Promise.resolve('settled') : entry.then(() => 'settled').catch(() => 'settled'),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), CANCEL_RELEASE_MS);
        timer.unref?.();
      }),
    ]);
    running.delete(job.id);
    if (job.finishedAt === undefined) job.finishedAt = now();
    job.releasedByTimeout = raced === 'timeout';
    await persist();
    pump();
    return {
      ok: true,
      status: 'cancelled',
      was: 'running',
      settled: raced === 'settled',
      releasedMs: Date.now() - began,
    };
  }

  /** @param {string} jobId */
  function get(jobId) {
    const job = jobs.get(jobId);
    if (job === undefined) return null;
    return {
      id: job.id,
      projectId: job.projectId,
      kind: job.kind,
      priority: job.priority,
      createdAt: job.createdAt,
      status: job.status,
      startedAt: job.startedAt ?? null,
      finishedAt: job.finishedAt ?? null,
      error: job.error ?? null,
      releasedByTimeout: job.releasedByTimeout === true,
    };
  }

  function status() {
    /** @param {Job} job */
    const view = (job) => ({
      id: job.id,
      projectId: job.projectId,
      kind: job.kind,
      priority: job.priority,
      createdAt: job.createdAt,
      ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
    });
    return {
      concurrency,
      running: [...running.values()].sort(compareJobs).map(view),
      queued: [...queued.values()].sort(compareJobs).map(view),
      completed,
      failed,
    };
  }

  async function close() {
    if (closed) return;
    closed = true;
    for (const job of running.values()) {
      job.status = 'cancelled';
      job.cancelRequestedAt = now();
      job.controller?.abort();
    }
    const pending = [...active.values()];
    if (pending.length > 0) {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, CANCEL_RELEASE_MS);
          timer.unref?.();
        }),
      ]);
    }
    running.clear();
    queued.clear();
    for (const job of jobs.values()) {
      if (job.status === 'queued' || job.status === 'running') job.status = 'cancelled';
    }
    await persist();
  }

  /** @type {any} */
  const api = {
    concurrency,
    ready: Promise.resolve(),
    enqueue,
    cancel,
    get,
    status,
    close,
    /** 等待状态文件落盘（测试/证据用）。 */
    flush: () => persistChain,
    recovery: () => ({
      interrupted: [...recovery.interrupted],
      cleaned: { ...recovery.cleaned },
      issues: [...recovery.issues],
      stateIssue,
    }),
    insertions: () => insertions.map((item) => ({ ...item })),
    /** 当前状态文件 sha256（没配 statePath 时为空串）。 */
    stateSha: async () => {
      if (statePath === '') return '';
      try {
        return sha256(await fs.readFile(statePath, 'utf8'));
      } catch {
        return '';
      }
    },
  };

  /** @type {Promise<any>} */
  const ready = recover()
    .catch((error) => {
      stateIssue = String(/** @type {Error} */ (error)?.message ?? error);
      recovery = { interrupted: [], cleaned: { files: 0, bytes: 0 }, issues: [`RECOVER_FAILED:${stateIssue}`] };
    })
    .then(() => {
      started = true;
      pump();
    });
  api.ready = ready;
  return api;
}
