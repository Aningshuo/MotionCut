/**
 * 导出作业句柄（P28）：把「一次导出」从黑箱进程变成**可观测、可中止、可被宿主驱动**的作业。
 *
 * 为什么单独一层而不是塞进 `film-export.mjs`：主线（M29 导出队列）与 CLI 用的是同一次导出，
 * 但一个要 `cancel()`/进度回调、另一个要 `--progress jsonl`。把「作业」抽出来，两边接的是
 * 同一个东西，而不是各写一套轮询（主线现在就在用「观察 partial 文件大小」猜阶段）。
 *
 * ## 形状（交接里也写了）
 *
 * ```js
 * const job = createExportJob({ outputPath: 'out.mp4' });   // 会占住输出路径
 * job.on((event) => { ... });                                // event.type: progress|cancel|done|error
 * job.progress({ phase: 'rendering', frame: 12, totalFrames: 240 });
 * job.cancel('user');                                        // 只置位，真正停 ffmpeg 由调用方
 * await job.done;                                            // resolve(result) / reject(错误)
 * job.release();                                             // 幂等；正常路径 finish/fail 会替你放
 * ```
 *
 * ## 输出占用是**跨进程**的
 *
 * 进程内一张 Map 只能挡住同一进程里的两个作业；用户完全可以开两个终端跑同一条命令。
 * 所以真正的锁是输出路径旁的 `<out>.opencut-lock`（`wx` 打开，失败即占用）：
 * - 锁里写 `{ pid, jobId, at }`；
 * - 进程已经不在（`kill(pid,0)` 抛 ESRCH）或锁超过 6 小时，视为**陈旧锁**，清掉重试一次；
 * - 拿到锁的作业结束时删锁（`release()` 在 finally 里也会调，幂等）。
 *
 * 冲突一律 `EXPORT_OUTPUT_BUSY`，**不覆盖、不排队**：排队会让「两个导出抢一个路径」
 * 看起来像成功，实际上是第二个把第一个的结果盖掉。
 *
 * ## 状态机（P30 修过一处：取消来晚了）
 *
 * `running` → `cancelled`（收到 cancel）→ 终态只有两种：`succeeded` / `failed`。
 *
 * 关键约定：**`cancel()` 不结算 `done`，也不放锁**。它只是「请求中止」；
 * 真正的终结点仍是 `finish()` / `fail()`——因为此刻 ffmpeg 可能还在 SIGTERM→SIGKILL 的
 * 宽限期里，提前放锁会让下一个作业立刻在同一路径上开工，两个进程写同一个临时文件。
 *
 * 由此带来一个必须处理的窗口：**取消落在「工作已经做完」之后**。
 * 典型场景是 muxing 完成、文件已 rename，但作业还没来得及 `finish()`（中间还有
 * 摘要、临时目录清理这些 await）。此时：
 * - 产物是**完整**的，报「失败」是撒谎；
 * - 但 `finish()` 如果因为 state 已经是 `cancelled` 就直接 return，锁就永远留在用户目录里。
 *
 * 所以 R18 起：`finish()` 接受 `cancelled` 态，把它当作「取消来晚了」——
 * 照常发 `done`、照常 resolve、照常释放锁，并在事件里带 `cancelTooLate: true`。
 * 同理 `fail()` 也接受 `cancelled` 态，否则取消后的失败会让 `done` 永远悬着。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const EXPORT_JOB_VERSION = '1.0.0';

/** 进度阶段：任务书要求的最小集合；`stage` 字段再区分同阶段里的取帧/编码。
 *  `burn`（P45）是烧录的第二遍编码：和 `rendering` 分开，否则帧号会往回跳。 */
export const EXPORT_JOB_PHASES = Object.freeze(
  /** @type {const} */ (['planning', 'rendering', 'burn', 'muxing', 'done']),
);

/** 陈旧锁阈值：比任何一次导出都长，短于「用户忘了删临时文件」的耐心。 */
const STALE_LOCK_MS = 6 * 60 * 60 * 1000;

/**
 * 作业层错误。`code` 是给宿主/脚本分支用的稳定字符串。
 * @typedef {'EXPORT_OUTPUT_BUSY' | 'EXPORT_OUTPUT_UNWRITABLE' | 'EXPORT_CANCELLED' | 'EXPORT_JOB_STATE'} ExportJobCode
 */
export class ExportJobError extends Error {
  /**
   * @param {ExportJobCode} code
   * @param {string} detail
   * @param {Record<string, unknown>} [extra]
   */
  constructor(code, detail, extra = {}) {
    super(`${code}: ${detail}`);
    this.name = 'ExportJobError';
    this.code = code;
    this.detail = detail;
    Object.assign(this, extra);
  }
}

/** @param {string} file */
export function lockPathFor(file) {
  return `${file}.opencut-lock`;
}

/**
 * 进程还活着吗。`kill(pid, 0)` 不发信号，只做权限/存在性检查。
 * @param {number} pid
 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {any} */ (err)?.code === 'EPERM';
  }
}

/**
 * 拿一个输出路径的锁。返回锁文件名，失败抛 `EXPORT_OUTPUT_BUSY`。
 * @param {string} file 已经解析过（绝对路径）
 * @param {{ jobId: string, now?: number }} info
 * @returns {string} 锁文件路径
 */
function acquireFileLock(file, info) {
  const lock = lockPathFor(file);
  const body = `${JSON.stringify({ pid: process.pid, jobId: info.jobId, at: new Date(info.now ?? Date.now()).toISOString() })}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lock, 'wx');
      try {
        fs.writeSync(fd, body);
      } finally {
        fs.closeSync(fd);
      }
      return lock;
    } catch (err) {
      const code = /** @type {any} */ (err)?.code;
      // 输出目录不可写（只读挂载 / 权限 / 目录被删）：这是「目标位置不行」，
      // 不是「作业失败」。以前它裸着 EACCES 冒到 CLI，被兜成 JOB_FAILED + 一段 errno 文案，
      // 用户看不出该改哪儿（P30 的 notDone 就是这条）。
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS' || code === 'ENOTDIR' || code === 'ENOENT') {
        throw new ExportJobError(
          'EXPORT_OUTPUT_UNWRITABLE',
          `cannot write next to ${file}: ${code} (the output directory must exist and be writable — the lock file lives there too)`,
          { path: file, lock, errno: code },
        );
      }
      if (code !== 'EEXIST') throw err;
      // 已存在：只有确认是陈旧锁才敢清，否则一律拒绝
      if (attempt === 0 && isStaleLock(lock, info.now ?? Date.now())) {
        // 同 release()：删陈旧锁同样可能被 safe-delete 钩子拒（甚至删了还报错）。
        // 不在这里下结论——下一轮 `openSync` 会告诉我们锁到底还在不在。
        try {
          fs.unlinkSync(lock);
        } catch {
          // 忽略；下一轮见分晓
        }
        continue;
      }
      let holder = null;
      try {
        holder = JSON.parse(fs.readFileSync(lock, 'utf8'));
      } catch {
        holder = null;
      }
      throw new ExportJobError(
        'EXPORT_OUTPUT_BUSY',
        `another export is already writing ${file} (lock ${path.basename(lock)}, holder pid ${holder?.pid ?? '?'} job ${holder?.jobId ?? '?'})`,
        { path: file, lock, holder },
      );
    }
  }
  // 理论上到不了：第二次 EEXIST 已经在上面抛了
  throw new ExportJobError('EXPORT_OUTPUT_BUSY', `could not lock ${file}`, { path: file });
}

/**
 * 陈旧锁判定：持有进程不在，或锁太老。
 * @param {string} lock
 * @param {number} now
 */
function isStaleLock(lock, now) {
  try {
    const info = JSON.parse(fs.readFileSync(lock, 'utf8'));
    if (pidAlive(Number(info?.pid))) {
      // 进程还在：只按时间兜底（pid 复用 + 长时间不释放）
      const at = Date.parse(String(info?.at ?? ''));
      return Number.isFinite(at) ? now - at > STALE_LOCK_MS : false;
    }
    return true;
  } catch {
    // 锁文件写坏了/读不到：当成陈旧，清掉重试一次
    return true;
  }
}

/**
 * @param {string | readonly string[] | null | undefined} input
 * @returns {string[]}
 */
function normalizeOutputs(input) {
  if (input === null || input === undefined) return [];
  const list = Array.isArray(input) ? input : [input];
  /** @type {string[]} */
  const out = [];
  for (const item of list) {
    const text = String(item ?? '').trim();
    if (text === '') continue;
    out.push(path.resolve(text));
  }
  return [...new Set(out)];
}

/** 进程内已占用的输出路径（诊断/测试用；真正的互斥靠锁文件）。 */
const ACTIVE_CLAIMS = new Map();

/** @returns {Array<{ path: string, jobId: string, since: number }>} */
export function activeOutputClaims() {
  return [...ACTIVE_CLAIMS.entries()].map(([key, value]) => ({ path: key, ...value }));
}

let counter = 0;
/** @returns {string} */
function defaultJobId() {
  counter += 1;
  const stamp = Date.now().toString(36);
  const rand = crypto.randomBytes(3).toString('hex');
  return `exp_${stamp}_${counter}_${rand}`;
}

/**
 * @typedef {{
 *   jobId: string,
 *   elapsedMs: number,
 *   type: 'progress' | 'cancel' | 'done' | 'error',
 *   phase?: 'planning' | 'rendering' | 'burn' | 'muxing' | 'done',
 *   frame?: number,
 *   totalFrames?: number,
 *   stage?: 'capture' | 'encode',
 *   reason?: string,
 *   code?: string,
 *   message?: string,
 *   cancelTooLate?: boolean,
 *   result?: any,
 * }} ExportJobEvent
 */

/**
 * 造一个作业。**会立刻占住输出路径**（跨进程锁），拿不到就抛 `EXPORT_OUTPUT_BUSY`。
 *
 * @param {{ id?: string, outputPath?: string | readonly string[] | null, now?: () => number, onEvent?: (event: ExportJobEvent) => void }} [opts]
 */
export function createExportJob(opts = {}) {
  const jobId = typeof opts.id === 'string' && opts.id !== '' ? opts.id : defaultJobId();
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();
  const outputPaths = normalizeOutputs(opts.outputPath);

  /** @type {string[]} */
  const locks = [];
  try {
    for (const file of outputPaths) {
      const inProcess = ACTIVE_CLAIMS.get(file);
      if (inProcess !== undefined && inProcess.jobId !== jobId) {
        throw new ExportJobError(
          'EXPORT_OUTPUT_BUSY',
          `another export in this process is already writing ${file} (job ${inProcess.jobId})`,
          { path: file, holder: inProcess },
        );
      }
      locks.push(acquireFileLock(file, { jobId, now: now() }));
      ACTIVE_CLAIMS.set(file, { jobId, since: now() });
    }
  } catch (err) {
    // 半途失败：已经拿到的锁要还回去，否则会把自己的路径永久占住
    for (const lock of locks) fs.rmSync(lock, { force: true });
    for (const file of outputPaths) {
      if (ACTIVE_CLAIMS.get(file)?.jobId === jobId) ACTIVE_CLAIMS.delete(file);
    }
    throw err;
  }

  const controller = new AbortController();
  /** @type {Set<(event: ExportJobEvent) => void>} */
  const listeners = new Set();
  /** @type {'running' | 'succeeded' | 'failed' | 'cancelled'} */
  let state = 'running';
  /** @type {string | null} */
  let cancelReason = null;
  /** 取消来晚了：工作已经做完，但仍然记录用户确实按下过中止。 */
  let cancelTooLate = false;
  let released = false;
  /** 删锁失败记录（不抛，但要能在诊断里看到）。 @type {Array<{ lock: string, message: string }>} */
  const lockCleanupFailures = [];
  let lastEvent = /** @type {ExportJobEvent | null} */ (null);

  /** @type {(value: any) => void} */
  let resolveDone = () => {};
  /** @type {(reason: any) => void} */
  let rejectDone = () => {};
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  // 宿主可能只消费事件、不 await done：别让它变成 unhandledRejection
  done.catch(() => {});

  /** @param {ExportJobEvent} event */
  const dispatch = (event) => {
    lastEvent = event;
    if (typeof opts.onEvent === 'function') {
      try {
        opts.onEvent(event);
      } catch {
        // 监听器自己炸了不该把导出带崩
      }
    }
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // 同上：宿主回调的 bug 不算导出的 bug
      }
    }
  };

  /**
   * 订阅事件。返回退订函数。
   * @param {(event: ExportJobEvent) => void} listener
   */
  function on(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** 释放输出占用（幂等）。成功/失败/取消都会走到，正常路径不需要手动调。 */
  function release() {
    if (released) return;
    released = true;
    for (const lock of locks) {
      // 删锁失败**不能把导出判死**（P31 实测）：宿主沙箱的 safe-delete 钩子会
      // 「删掉了却抛 denied」，把一次成功的导出变成 exit 8，产物明明在磁盘上。
      // 锁本身有陈旧判定（pid 不在 / 超 6h）兜底，所以这里只记录，不抛。
      try {
        fs.rmSync(lock, { force: true });
      } catch (err) {
        lockCleanupFailures.push({ lock, message: String(/** @type {any} */ (err)?.message ?? err) });
      }
    }
    for (const file of outputPaths) {
      if (ACTIVE_CLAIMS.get(file)?.jobId === jobId) ACTIVE_CLAIMS.delete(file);
    }
  }

  /**
   * 内部发射：**不做状态检查**。`finish()` 要在「cancelled 但工作已完成」时也把 `done` 发出去，
   * 走公开的 `progress()` 会被状态检查吃掉（那样宿主会看到 cancel 之后直接 done，没有 done 进度）。
   * @param {{ phase: 'planning' | 'rendering' | 'burn' | 'muxing' | 'done', frame?: number, totalFrames?: number, stage?: 'capture' | 'encode' }} input
   */
  function emitProgress(input) {
    const phase = input.phase;
    if (!EXPORT_JOB_PHASES.includes(phase)) {
      throw new ExportJobError('EXPORT_JOB_STATE', `unknown phase "${phase}"`);
    }
    /** @type {ExportJobEvent} */
    const event = { type: 'progress', jobId, elapsedMs: now() - startedAt, phase };
    if (Number.isFinite(input.frame)) event.frame = Math.max(0, Math.floor(Number(input.frame)));
    if (Number.isFinite(input.totalFrames)) event.totalFrames = Math.max(0, Math.floor(Number(input.totalFrames)));
    if (input.stage !== undefined) event.stage = input.stage;
    dispatch(event);
  }

  /**
   * 记一条进度。取消之后一律丢弃：宿主不该在 cancel 之后还收到 rendering 事件。
   * @param {{ phase: 'planning' | 'rendering' | 'burn' | 'muxing' | 'done', frame?: number, totalFrames?: number, stage?: 'capture' | 'encode' }} input
   */
  function progress(input) {
    if (state !== 'running') return false;
    emitProgress(input);
    return true;
  }

  /**
   * 请求中止。**不直接杀进程**：只是把 `job.signal` 置位，真正停 ffmpeg / 关浏览器的是
   * 导出链路里那些听 signal 的地方（`runFfmpeg` 的 SIGTERM→SIGKILL、舞台取帧的协作式中止）。
   * @param {string} [reason]
   */
  function cancel(reason) {
    if (state !== 'running') return false;
    cancelReason = typeof reason === 'string' && reason !== '' ? reason : 'cancelled';
    state = 'cancelled';
    controller.abort(new ExportJobError('EXPORT_CANCELLED', `export cancelled (${cancelReason})`, { reason: cancelReason }));
    dispatch({ type: 'cancel', jobId, elapsedMs: now() - startedAt, reason: cancelReason });
    // `done` **不在这里结算**，锁也**不在这里放**（P30）：
    // ① 此刻 ffmpeg 可能还在 SIGTERM→宽限期→SIGKILL，提前放锁会让下一个作业
    //    立刻在同一路径开工，两个进程写同一个临时文件；
    // ② 取消可能来得比工作还晚（muxing 已完成）——这时候正确的结局是
    //    `finish()` 成功收尾，而不是把一个完整的片子报成失败。
    // 两条都由终态（finish/fail）统一处理。
    return true;
  }

  /**
   * 成功收尾：发 `done` 并把结果交给 `job.done`。
   *
   * **接受 `cancelled` 态**（P30）：取消落在「工作已完成之后」时，产物是完整的，
   * 该报成功而不是把锁和半截状态一起留下。事件里带 `cancelTooLate: true`，
   * 宿主据此知道「用户按过中止，但已经来不及了，文件是真的」。
   * @param {any} result
   */
  function finish(result) {
    if (state === 'succeeded' || state === 'failed') return;
    const tooLate = state === 'cancelled';
    if (tooLate) cancelTooLate = true;
    const frames = Number(result?.frames);
    // 先发进度再改状态：`progress()` 在非 running 时会丢弃事件
    emitProgress({ phase: 'done', frame: Number.isFinite(frames) ? frames : undefined, totalFrames: Number.isFinite(frames) ? frames : undefined });
    state = 'succeeded';
    // 事件里只放**摘要**：完整结果由 `job.done` 给，别让每一行流都背一份大对象
    dispatch({
      type: 'done',
      jobId,
      elapsedMs: now() - startedAt,
      ...(Number.isFinite(frames) ? { frame: frames, totalFrames: frames } : {}),
      ...(typeof result?.path === 'string' ? { path: result.path } : {}),
      ...(typeof result?.sha256 === 'string' ? { sha256: result.sha256 } : {}),
      ...(tooLate ? { cancelTooLate: true, cancelReason } : {}),
    });
    // 结果里也标一刀：CLI 的 `--json` 与宿主读的是这个对象，别只在流式事件里有
    if (tooLate && result && typeof result === 'object') {
      result.cancelTooLate = true;
      if (cancelReason !== null) result.cancelReason = cancelReason;
    }
    resolveDone(result);
    release();
  }

  /**
   * 失败收尾。
   *
   * **接受 `cancelled` 态**（P30）：取消后底层一定会抛错（ffmpeg 被杀、页面被关），
   * 那时 `fail()` 必须照常结算并放锁，否则 `done` 永远悬着、锁永远不还。
   * @param {any} err
   */
  function fail(err) {
    if (state === 'succeeded' || state === 'failed') return;
    const tooLate = cancelTooLate;
    state = 'failed';
    dispatch({
      type: 'error',
      jobId,
      elapsedMs: now() - startedAt,
      code: String(err?.code ?? 'JOB_FAILED'),
      message: String(err?.message ?? err),
      ...(tooLate ? { cancelTooLate: true } : {}),
    });
    rejectDone(err);
    release();
  }

  return {
    id: jobId,
    version: EXPORT_JOB_VERSION,
    outputPaths,
    signal: controller.signal,
    get state() {
      return state;
    },
    get cancelReason() {
      return cancelReason;
    },
    /** 取消是否「来晚了」：工作已经做完，产物完整。 */
    get cancelTooLate() {
      return cancelTooLate;
    },
    /** 删锁失败的记录（正常情况下为空）。清理失败不影响导出结果。 */
    get lockCleanupFailures() {
      return [...lockCleanupFailures];
    },
    get lastEvent() {
      return lastEvent;
    },
    startedAt,
    done,
    on,
    cancel,
    progress,
    finish,
    fail,
    release,
  };
}

/**
 * 用一个作业包住一段导出：成功 `finish`、失败 `fail`、无论哪条路都 `release` 输出占用。
 *
 * 这是给「已经拿到 job（比如宿主要提前 cancel）」的调用方用的；CLI 直接走 `exportFilm`
 * 的 `onEvent` 就够了。
 *
 * @template T
 * @param {ReturnType<typeof createExportJob>} job
 * @param {() => Promise<T>} body
 * @returns {Promise<T>}
 */
export async function runExportJob(job, body) {
  try {
    const result = await body();
    job.finish(result);
    return result;
  } catch (err) {
    if (job.signal.aborted || job.state === 'cancelled') {
      const reason = job.cancelReason ?? 'cancelled';
      const cancelled = new ExportJobError('EXPORT_CANCELLED', `export cancelled (${reason})`, { reason });
      job.fail(cancelled);
      throw cancelled;
    }
    job.fail(err);
    throw err;
  } finally {
    job.release();
  }
}
