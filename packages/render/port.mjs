/**
 * 产品级 render 端口（P47 · B-SUB2-R24-024）。
 *
 * 在这之前 `export start` **没有执行器**：`createRenderPort` 只存在于验收脚本
 * （`scripts/r22-job-port.mjs`）和 mcp 测试 stub 里，真实环境里 `ctx.port('render')`
 * 直接抛 `WAIT_MAIN_FILM`。而 CLI 直出的 `export film` 早就支持多段/烧录/编码矩阵——
 * 同一个产品两条能力线。这个文件把第二条线接上：
 *
 * ```
 * export start  →  建作业目录 + 写 spec.json + fork(detached) worker  →  立刻返回 jobId+pid
 *                   worker 里跑 planFromFilm + prepareSubtitleBurn + renderFilmExport
 *                   → job.json（状态）+ events.jsonl（进度）
 * export status →  读 job.json + 最后一条事件
 * export cancel →  cancel.requested + SIGTERM（5s 后 SIGKILL）+ 清理 partial/lock/pid
 * ```
 *
 * 三条硬约束（任务书 §3.2）：
 * 1. **不阻塞**：start 只做校验与 fork，绝不等成片；CLI 进程退出后 worker 继续跑
 *    （`detached: true` + `stdio: 'ignore'` + `unref()`）。
 * 2. **不重造渲染**：worker 调的就是 `renderFilmExport`，多段/烧录/编码/响度都是它
 *    已有的能力，这里只做「计划 → 调用 → 记账」。
 * 3. **不碰 Studio**：Studio 的导出队列是另一条路（`packages/studio/server/export-job.mjs`）。
 *
 * 作业目录（= `spec.outputDir`）里的文件：
 * - `spec.json`：本次作业的完整 spec（含解析后的 projectPath / ffmpeg 路径）
 * - `job.json`：状态（state / phase / stage / framesDone / framesTotal / artifacts / error）
 * - `events.jsonl`：每行一条 `{type, phase, frame, totalFrames, stage, at}`
 * - `worker.pid` / `job.lock` / `cancel.requested`：进程与取消的现场
 *
 * 同一个 outputDir 的互斥（P50）：`job.lock` 是 `{jobId, pid, at}`，start 先看锁里
 * 的 pid 还活不活——活着且不是本次 jobId 就 `EXPORT_OUTPUT_BUSY`（退出码 3），
 * 目录里一个字节都不动；已死就按 stale 处理，拿到所有权后再按白名单清中间件。
 * status 检出「running/waiting 且 pid 已死」时回收现场并报 `WORKER_DIED` + `reaped:true`。
 * cancel 先核对 `job.json.jobId`，不符就 `CONFLICT`，不发任何信号。
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeFfmpeg } from './ffmpeg.mjs';
import { validateSpec } from './job.mjs';
import { admitUnderPressure, defaultFootprint } from './resource-guard.mjs';

const WORKER = fileURLToPath(new URL('./port-worker.mjs', import.meta.url));

/** 取消宽限：SIGTERM 之后等多久改 SIGKILL（与 Studio 的作业语义一致）。 */
const CANCEL_GRACE_MS = 5000;

/**
 * @typedef {{
 *   jobId: string,
 *   state: 'waiting' | 'running' | 'done' | 'failed' | 'cancelled',
 *   phase?: string,
 *   framesDone?: number,
 *   framesTotal?: number,
 *   stage?: string,
 *   artifacts?: any,
 *   error?: string,
 *   errorDetail?: string,
 *   pid?: number,
 *   startedAt?: number,
 *   finishedAt?: number,
 *   elapsedMs?: number,
 *   reaped?: boolean,
 * }} PortStatus
 */

/** @param {number} pid */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {any} */ (err)?.code === 'EPERM';
  }
}

/**
 * 中间件白名单（P50）：**只有**这些能在回收时删。
 *
 * 产物（`*.mp4` / `*.mov` / `*.webm` / `*.vtt` / `*.ass` / `spec.json` / `job.json` /
 * `events.jsonl`）一个都不许碰——崩溃回收是为了让目录能重新开工，不是清理用户的东西。
 * `frames/` 是 P49 的舞台帧序列目录，同样是中间物。
 * @param {string} name
 */
export function isIntermediate(name) {
  return (
    name.includes('.partial') ||
    name.endsWith('.opencut-lock') ||
    name === 'job.lock' ||
    name === 'worker.pid' ||
    name === 'cancel.requested' ||
    name === 'frames'
  );
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 作业注册表：jobId → 作业目录。
 *
 * 为什么要它：`export status` 是一次**新的 CLI 进程**，手上只有 jobId，没有 spec。
 * 注册表放在系统临时目录（与 CLI 的 stateDir 同一层），跨进程可读；`ctx.env.renderStateDir`
 * 可以改位置（验收/测试用）。
 *
 * @param {Record<string, any>} env
 */
function registryDirOf(env) {
  const raw = env.renderStateDir ?? path.join(os.tmpdir(), 'opencut-render-jobs');
  return path.resolve(String(raw));
}

/**
 * @param {{ root: string, env?: Record<string, any>, cwd?: string,
 *   sampleFootprint?: () => Promise<number | null> }} ctx
 */
export function createRenderPort(ctx) {
  const root = path.resolve(ctx.root);
  const env = ctx.env ?? {};
  const registryDir = registryDirOf(env);
  const ffmpegPath = typeof env.ffmpegPath === 'string' ? env.ffmpegPath : undefined;
  const ffprobePath = typeof env.ffprobePath === 'string' ? env.ffprobePath : undefined;

  /** @param {string} jobId */
  const registryFile = (jobId) => path.join(registryDir, `${jobId}.json`);

  /**
   * @param {string} jobId
   * @returns {Promise<string | null>}
   */
  async function jobDirOf(jobId) {
    try {
      const text = await fs.readFile(registryFile(jobId), 'utf8');
      const parsed = JSON.parse(text);
      return typeof parsed?.dir === 'string' ? parsed.dir : null;
    } catch {
      return null;
    }
  }

  /**
   * @param {string} dir
   * @returns {Promise<any | null>}
   */
  async function readJob(dir) {
    try {
      return JSON.parse(await fs.readFile(path.join(dir, 'job.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * 最后一条事件。events.jsonl 是**追加**写的：worker 挂了也能看到它跑到哪。
   * @param {string} dir
   */
  async function lastEvent(dir) {
    let text;
    try {
      text = await fs.readFile(path.join(dir, 'events.jsonl'), 'utf8');
    } catch {
      return null;
    }
    const lines = text.split('\n').filter((line) => line.trim().length > 0);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (line === undefined) continue;
      try {
        return JSON.parse(line);
      } catch {
        // 半行（worker 正在写）：往上看一条
      }
    }
    return null;
  }

  /**
   * 清掉一次失败/取消留下的中间件。成品（job.json / events.jsonl / 成片）不动。
   * @param {string} dir
   */
  async function cleanupArtifacts(dir) {
    /** @type {string[]} */
    let names = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (isIntermediate(name)) {
        await fs.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  /**
   * 读 `job.lock`（P50 起内容是 `{jobId, pid, at}`）。
   * 读不出来（半截写/旧格式坏文件）返回 null——按 stale 处理，由调用方清场。
   * @param {string} dir
   * @returns {Promise<{ jobId?: string, pid?: number, at?: number } | null>}
   */
  async function readLock(dir) {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(dir, 'job.lock'), 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * 原子写 job.json（回收崩溃作业时要把终态落盘，否则下次 status 又要重算一遍）。
   * @param {string} dir
   * @param {any} state
   */
  async function writeJob(dir, state) {
    const target = path.join(dir, 'job.json');
    const temp = `${target}.tmp-${process.pid}`;
    await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8').catch(() => {});
    await fs.rename(temp, target).catch(() => {});
  }

  /**
   * 注册表清理（P50）：删「目录已不存在」和「超过 7 天且已终态」的项。
   * 活着的作业（目录在、状态非终态）一项都不动——清掉它等于让 status 失联。
   */
  async function pruneRegistry() {
    /** @type {string[]} */
    let names = [];
    try {
      names = await fs.readdir(registryDir);
    } catch {
      return;
    }
    const now = Date.now();
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(registryDir, name);
      /** @type {any} */
      let entry = null;
      try {
        entry = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch {
        await fs.rm(file, { force: true }).catch(() => {});
        continue;
      }
      const entryDir = typeof entry?.dir === 'string' ? entry.dir : null;
      if (!entryDir) {
        await fs.rm(file, { force: true }).catch(() => {});
        continue;
      }
      const exists = await fs.stat(entryDir).then((s) => s.isDirectory()).catch(() => false);
      if (!exists) {
        await fs.rm(file, { force: true }).catch(() => {});
        continue;
      }
      const at = Number(entry?.at ?? 0) || 0;
      if (at > 0 && now - at > 7 * 24 * 60 * 60 * 1000) {
        const job = await readJob(entryDir);
        const terminal = job !== null && ['done', 'failed', 'cancelled'].includes(String(job.state));
        if (terminal) await fs.rm(file, { force: true }).catch(() => {});
      }
    }
  }

  return {
    /**
     * 建作业并 fork worker，**立刻**返回。
     * @param {any} spec
     * @param {{ audioMix?: any }} [opts]
     * @returns {Promise<{ jobId: string, pid?: number, startedAt?: number } | { error: string, detail?: string }>}
     */
    async start(spec, opts = {}) {
      const problem = validateSpec(spec);
      if (problem) return { error: problem.error, detail: problem.detail };

      const projectPath = path.resolve(root, String(spec.projectId));
      const stat = await fs.stat(projectPath).catch(() => null);
      if (!stat || !stat.isDirectory()) {
        return { error: 'NOT_FOUND', detail: `project ${projectPath} is not a directory` };
      }

      /* ── 资源压力准入（P52）────────────────────────────────────────────────
         名额（P51）管的是浏览器个数，管不了内存。这里在**动手之前**量一次占用：
         超过阈值就先等（默认 30s，1s 轮询），等不到就明确拒绝 RESOURCE_PRESSURE，
         并落一条 `<registryDir>/pressure/<jobId>.json` 记录——不是静默失败。

         采样读不到（没有 libproc / pgrep）时按 `available:false` 记一笔然后放行：
         读不到进程表不等于机器满了，不能让"看不见"变成"永远不开工"。 */
      const admit = await admitUnderPressure({
        jobId: String(spec.jobId),
        registryDir,
        env: { ...process.env, ...env },
        sample:
          typeof ctx.sampleFootprint === 'function'
            ? /** @type {() => Promise<number|null>} */ (ctx.sampleFootprint)
            : () => defaultFootprint(registryDir),
      });
      if (admit.action === 'rejected') {
        return {
          error: 'RESOURCE_PRESSURE',
          detail:
            `render is under memory pressure: ${Math.round(Number(admit.measuredBytes ?? 0) / 1024 / 1024)}MB ` +
            `> ${Math.round(admit.limitBytes / 1024 / 1024)}MB (${admit.limitSource}), ` +
            `waited ${admit.waitedMs}ms; record ${admit.recordPath ?? 'n/a'}`,
        };
      }

      const dir = path.resolve(String(spec.outputDir));
      await fs.mkdir(dir, { recursive: true });

      /* ── 目录所有权（P50）──────────────────────────────────────────────────
         同一个 outputDir 起两个作业，实测的后果是：两个 worker 并行、job.json 只剩
         后开工的、events.jsonl 交错；`cancel A` 之后 A 和 B 都被杀（status B 里出现
         A 的 pid）。根因是 start 无条件 truncate events.jsonl + rm job.json，
         谁后开工谁把前一个的现场抹掉。

         现在的规则：**先判锁，再拿所有权，最后才清场**。
         - 锁里（或 job.json 里）的 pid 还活着、且不是本次 jobId → 拒绝，一个字节都不动；
         - pid 已死 / 锁读不出来 → stale，拿到所有权后按白名单清中间件再开工；
         - 同一个 jobId 重跑 → 允许（覆盖自己的锁，与 P47 行为一致）。 */
      const lock = await readLock(dir);
      const existing = (await readJob(dir)) ?? {};
      const owner = resolveOwnership(lock, existing, spec.jobId);
      if (owner.action === 'busy') {
        return {
          error: 'EXPORT_OUTPUT_BUSY',
          detail: `outputDir ${dir} is busy: job ${owner.jobId} (pid ${owner.pid}) is still running`,
        };
      }

      const startedAt = Date.now();
      // 到这里才算「拿到了目录所有权」：清 stale 现场 + 自己的旧现场
      await cleanupArtifacts(dir);
      await fs.writeFile(path.join(dir, 'events.jsonl'), '', 'utf8');
      await fs.rm(path.join(dir, 'job.json'), { force: true }).catch(() => {});

      /* P70：把「这次用的是哪个 ffmpeg、`-version` 首行、有没有 subtitles 滤镜」写进 spec.json。
         探不到不拦（没有字幕的导出不该因为探不到 ffmpeg 信息而失败），只把事实记下来；
         真要烧字幕时会走 assertBurnCapable()，那里才是硬门禁。 */
      const ffmpegInfo = await describeFfmpeg({
        projectRoot: projectPath,
        env: { ...process.env, ...env },
        ...(ffmpegPath ? { explicit: ffmpegPath } : {}),
      });

      const specForWorker = {
        ...spec,
        projectPath,
        ffmpeg: ffmpegInfo,
        ...(ffmpegPath ? { ffmpegPath } : {}),
        ...(ffprobePath ? { ffprobePath } : {}),
        ...(opts.audioMix !== undefined ? { audioMix: opts.audioMix } : {}),
      };
      await fs.writeFile(path.join(dir, 'spec.json'), `${JSON.stringify(specForWorker, null, 2)}\n`, 'utf8');

      await fs.mkdir(registryDir, { recursive: true });
      await pruneRegistry();
      await fs.writeFile(registryFile(spec.jobId), `${JSON.stringify({ jobId: spec.jobId, dir, at: startedAt })}\n`, 'utf8');

      /* 用 spawn 而不是 fork：fork 默认会建一条 IPC 通道，父进程退出时会被它拖住
         （实测 export start 的 real 时间 ≈ 整个渲染时长）。这里只要一个 detached 的
         独立进程，stdio 全忽略、不留任何管道。 */
      const child = spawn(process.execPath, [WORKER, dir], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, OPENCUT_JOB_ID: String(spec.jobId) },
      });
      const pid = child.pid ?? 0;
      child.unref();
      if (pid > 0) await fs.writeFile(path.join(dir, 'worker.pid'), String(pid), 'utf8').catch(() => {});
      // 锁要绑**进程身份**（P50）：只有 jobId 的话，没法回答「占用者还活着吗」
      await fs.writeFile(path.join(dir, 'job.lock'), `${JSON.stringify({ jobId: spec.jobId, pid, at: startedAt })}\n`, 'utf8');

      return { jobId: spec.jobId, pid, startedAt };
    },

    /**
     * 读状态 + 最后一条事件。
     * @param {string} jobId
     * @returns {Promise<PortStatus>}
     */
    async status(jobId) {
      const dir = await jobDirOf(jobId);
      if (!dir) return { jobId, state: 'failed' }; // CLI 用 framesTotal 是否出现区分 NOT_FOUND
      const job = (await readJob(dir)) ?? {};
      const event = await lastEvent(dir);
      const state = /** @type {PortStatus['state']} */ (job.state ?? 'waiting');
      const pid = Number(job.pid ?? 0) || undefined;
      // worker 被杀/崩了但没来得及写终态：如实报 WORKER_DIED，别让 UI 永远转圈
      if ((state === 'running' || state === 'waiting') && pid && !alive(pid)) {
        /* 崩溃回收（P50）：SIGKILL / 断电之后目录里会永久留下 `*.partial.mp4` /
           `job.lock` / `worker.pid`。加了锁检查以后，这些残留就是这个目录的
           「永远 BUSY」死锁源，所以在这里一次清掉——**只删中间件白名单**，
           产物、job.json、events.jsonl 一个都不动。终态落盘，下次 status 不再重算。 */
        await cleanupArtifacts(dir);
        const reaped = {
          ...job,
          state: 'failed',
          error: 'WORKER_DIED',
          errorDetail: `worker pid ${pid} is no longer running; intermediates were reaped`,
          finishedAt: job.finishedAt ?? Date.now(),
        };
        await writeJob(dir, reaped);
        return {
          jobId,
          state: 'failed',
          ...(job.phase ?? event?.phase ? { phase: job.phase ?? event?.phase } : {}),
          ...(job.stage ?? event?.stage ? { stage: job.stage ?? event?.stage } : {}),
          error: 'WORKER_DIED',
          errorDetail: String(reaped.errorDetail),
          framesDone: Number(job.framesDone ?? 0) || 0,
          framesTotal: Number(job.framesTotal ?? event?.totalFrames ?? 0) || 0,
          ...(pid ? { pid } : {}),
          ...(job.startedAt ? { startedAt: job.startedAt } : {}),
          finishedAt: reaped.finishedAt,
          reaped: true,
        };
      }
      /* 帧号（P49）：`stage` 从 capture 翻到 encode 时，帧号会从 240 重新数。
         只在与 job.json 同一 stage（或还没写 stage）时才取「事件里的更大值」，
         否则会把上一阶段的最后一帧当成这一阶段的进度。 */
      const jobStage = typeof job.stage === 'string' ? job.stage : null;
      const eventStage = typeof event?.stage === 'string' ? event.stage : null;
      const sameStage = jobStage === null || eventStage === null || jobStage === eventStage;
      const framesDone = (sameStage
        ? Math.max(Number(job.framesDone ?? 0), Number(event?.frame ?? 0))
        : Number(job.framesDone ?? 0)) || 0;
      const framesTotal = Number(job.framesTotal ?? event?.totalFrames ?? 0) || 0;
      return {
        jobId,
        state,
        ...(job.phase ?? event?.phase ? { phase: job.phase ?? event?.phase } : {}),
        ...(jobStage ?? eventStage ? { stage: jobStage ?? eventStage } : {}),
        framesDone,
        framesTotal,
        ...(job.artifacts ? { artifacts: job.artifacts } : {}),
        ...(job.error ? { error: job.error } : {}),
        ...(job.errorDetail ? { errorDetail: job.errorDetail } : {}),
        ...(pid ? { pid } : {}),
        ...(job.startedAt ? { startedAt: job.startedAt } : {}),
        ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
        ...(job.startedAt ? { elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt } : {}),
      };
    },

    /**
     * 取消：写标记 → SIGTERM → 最多等 5s → SIGKILL → 清理。
     * @param {string} jobId
     */
    async cancel(jobId) {
      const dir = await jobDirOf(jobId);
      if (!dir) return { state: 'failed' };
      const job = (await readJob(dir)) ?? {};
      const lock = await readLock(dir);
      /* 只杀自己（P50）：目录可能已经被另一个作业接管（或 job.json 被改坏），
         这时候拿 job.pid 去 SIGTERM 就是杀别人。identity 不符 → CONFLICT，一个信号都不发。 */
      const ownerId = typeof job.jobId === 'string' ? job.jobId : typeof lock?.jobId === 'string' ? lock.jobId : null;
      if (ownerId !== null && ownerId !== jobId) {
        return {
          error: 'CONFLICT',
          detail: `job.json in ${dir} belongs to ${ownerId}, not ${jobId}; refusing to signal its worker`,
        };
      }
      const terminal = job.state === 'done' || job.state === 'failed' || job.state === 'cancelled';
      if (!terminal) {
        await fs.writeFile(path.join(dir, 'cancel.requested'), `${Date.now()}\n`, 'utf8').catch(() => {});
      }
      const pid = Number(
        job.pid ?? lock?.pid ?? (await fs.readFile(path.join(dir, 'worker.pid'), 'utf8').catch(() => '0')),
      );
      if (!terminal && Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // 已经退出
        }
        const deadline = Date.now() + CANCEL_GRACE_MS;
        while (Date.now() < deadline) {
          const current = (await readJob(dir)) ?? {};
          if (current.state === 'cancelled' || current.state === 'done' || current.state === 'failed') break;
          if (!alive(pid)) break;
          await sleep(50);
        }
        if (alive(pid)) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // 同上
          }
        }
      }
      await cleanupArtifacts(dir);
      return { jobId, state: /** @type {any} */ (job.state ?? 'cancelled') };
    },

    /**
     * 产物（宿主的 `RenderApi.result` 语义；CLI 现在不用，留给集成方）。
     * @param {string} jobId
     */
    async result(jobId) {
      const dir = await jobDirOf(jobId);
      if (!dir) return { error: 'NOT_FOUND' };
      const job = (await readJob(dir)) ?? {};
      if (job.state !== 'done') return { error: job.error ?? 'JOB_FAILED' };
      return job.artifacts?.master ?? { error: 'JOB_FAILED' };
    },
  };
}

/** 给测试/诊断用：worker 脚本的绝对路径。 */
export const PORT_WORKER_PATH = WORKER;

/**
 * 给测试/诊断用：作业注册表目录。
 * @param {Record<string, any>} [env]
 */
export function renderRegistryDir(env) {
  return registryDirOf(env ?? {});
}

/**
 * 纯函数：作业目录里的 job.json 路径（避免测试自己拼）。
 * @param {string} dir
 */
export function jobStatePath(dir) {
  return path.join(dir, 'job.json');
}

/**
 * 目录所有权判定（P50）——纯函数，单测直接喂假锁/假 job。
 *
 * 规则（先锁、后 job.json；都只看**活着的**不同 jobId）：
 * - `job.lock` 记的 pid 活着且不是本次 jobId → busy（占用者身份一并返回）；
 * - 没有锁（或锁里的 pid 已死）时看 `job.json`：state=running/waiting 且 pid 活着 → busy；
 * - 其余（锁 stale / 同一个 jobId 重跑 / 上一作业已终态）→ proceed。
 *
 * 为什么不信「目录用过就废」：A 跑完（done）之后同一个目录必须能复用，
 * 锁是**活着的进程**占的，不是目录本身占的。
 *
 * @param {{ jobId?: string, pid?: number } | null} lock
 * @param {any} job
 * @param {string} jobId
 * @param {(pid: number) => boolean} [isAlive]
 * @returns {{ action: 'proceed' } | { action: 'busy', jobId: string, pid: number }}
 */
export function resolveOwnership(lock, job, jobId, isAlive = alive) {
  /** @param {string | null} owner @param {number} pid */
  const running = (owner, pid) => owner !== null && owner !== jobId && pid > 0 && isAlive(pid);
  const lockId = typeof lock?.jobId === 'string' ? lock.jobId : null;
  const lockPid = Number(lock?.pid) || 0;
  if (running(lockId, lockPid)) return { action: 'busy', jobId: /** @type {string} */ (lockId), pid: lockPid };

  const state = String(job?.state ?? '');
  const jobRowId = typeof job?.jobId === 'string' ? job.jobId : null;
  const jobPid = Number(job?.pid) || 0;
  if ((state === 'running' || state === 'waiting') && running(jobRowId, jobPid)) {
    return { action: 'busy', jobId: /** @type {string} */ (jobRowId), pid: jobPid };
  }
  return { action: 'proceed' };
}

/** 生成一个稳定的 jobId（没有 crypto.randomUUID 时退回随机 hex）。 */
export function newJobId() {
  return `job_${crypto.randomBytes(6).toString('hex')}`;
}
