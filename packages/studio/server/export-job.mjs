/**
 * 导出作业（M17 · B-MAIN-R9-009；M37 起接 render 的作业句柄）。
 *
 * Studio 进程内的**单作业**导出队列。它只编排**现成**的渲染链路
 * （`packages/render` 只读，不改一行）：
 *
 *     planFromFilm(doc, { projectRoot, range })
 *       → 有网页片段：captureFilmFrames（舞台取帧到临时目录）
 *       → renderFilmExport({ plan, outPath, capture, quality, signal, onProgress })
 *       → 把成品从临时目录搬到入队时就占住的输出路径
 *
 * ## M37：锁 / 取消 / 进度只有一个来源
 *
 * 以前这里自己维护 `AbortController`、自己按 partial 文件大小猜阶段，于是和
 * `render/export-job.mjs`（CLI 用的作业句柄）**两套取消语义并存**：
 * 副线2 在 P30 修的「收尾窗口取消会留锁」、R18 的「输出被占用 EXPORT_OUTPUT_BUSY」
 * 生产入口一个都用不上。现在：
 *
 * - **输出占用**：`createExportJob({ id, outputPath })` 在**入队**时就拿锁
 *   （`<out>.opencut-lock`，跨进程）。同名输出被占 → 作业层直接抛
 *   `EXPORT_OUTPUT_BUSY`（带持有者 pid/jobId），队列把它原样返回给 HTTP。
 *   不传 `outPath` 时自己挑 `film-<时间戳>.mp4`，被占就换 `-1`、`-2`（默认路径不该
 *   因为同秒并发而失败）。
 * - **取消**：`cancel(id)` 只调 `handle.cancel('user')`。真正停 ffmpeg / 关浏览器
 *   的是渲染链路里听 `handle.signal` 的地方（`runFfmpeg` 的 SIGTERM→SIGKILL），
 *   这里**不再**有第二条 kill 路径，也不自己结算锁——`runExportJob` 的 finally 放锁。
 * - **进度**：直接转发句柄事件。字段与 CLI `--progress jsonl` **同名同义**
 *   （`phase` / `frame` / `totalFrames` / `stage` / `code`），不再用文件大小估算。
 *   取帧阶段按**完成帧数**推进；编码阶段用 `renderFilmExport` 的 `onProgress`
 *   真实帧号；`muxing` 也来自它。队列自己的 `stage`/`percent` 仍然保留给 UI。
 *
 * ## 阶段与百分比（UI 用；单调不减，每次取 max）
 *
 * `plan → capture? → video → mux? → verify → done`
 * - `plan`：0 → 4%（无网页片段 0 → 5%）；计划算完即满。
 * - `capture`：4% → 55%，按真实完成帧数。
 * - `video`：55% → 86%，按 `onProgress` 的真实编码帧号。
 * - `mux`：86% → 93%。计划里有音轨时，`renderFilmExport` 报 `muxing` 进入。
 * - `verify`：93% → 99%。成品落到临时目录后（复制 + 摘要）进入。
 * - `done`：100%。`runExportJob` 正常 finish。
 *
 * 中间文件（`*.video.partial.mp4`）**只写在系统临时目录**，成功后把成品复制进
 * 输出目录（跨卷安全），因此输出目录里永远不会出现 partial。
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { planFromFilm } from '../../render/film-plan.mjs';
import { requiresTransitionStage } from '../../film-core/transition-presets.mjs';
import { requiresCreationStyleStage } from '../../film-core/creation-style-stage.mjs';
import { resolveFfmpegPath } from '../../render/ffmpeg.mjs';
import { warmVideoProxies } from '../../render/video-proxy.mjs';
import { renderFilmExport } from '../../render/film-export.mjs';
import { planDelivery, sizeFootprint } from '../../render/delivery-size.mjs';
import { QUALITY_NAMES } from '../../render/quality.mjs';
import { burnBaseOf, buildBurnBundle, subtitleLayoutOf, threePiecePaths, writeBurnFiles } from './export-burn.mjs';
// 只读引用：作业句柄（锁 / 取消 / 进度）由 render 提供，本文件不改它一行。
// `activeOutputClaims` 只用于诊断（GET /api/export 里带一份），让「谁占着输出」可见。
import {
  activeOutputClaims,
  createExportJob,
  lockPathFor,
  runExportJob,
} from '../../render/export-job.mjs';

/** 阶段词表（顺序即进度顺序）。
 *
 * `burn`（M50）：烧字幕是**第二次编码**，夹在 `video` 与 `mux` 之间。render 早就在发
 * `phase:'burn'`（`film-export.mjs`），只是这张表里没有它、`onProgress` 又把它折成了
 * `rendering`——长片烧字幕才会看起来卡在 86% 不动。 */
export const EXPORT_STAGES = Object.freeze(['plan', 'capture', 'video', 'burn', 'mux', 'verify', 'done']);

/** 编码（M50）：只允许这两个。默认 h264 —— 不传时行为与 R24 逐字节相同。 */
export const EXPORT_CODECS = Object.freeze(['h264', 'hevc']);

/**
 * 各阶段百分比区间。
 *
 * 规则：**单调、首尾相接、合计到 1**；没有的阶段不出现（`setStage` 对缺失的 band 只改
 * 字符串不动 percent）。`{scenes:false, burn:false}` 必须与 M42 的常量**逐值相同**。
 *
 * @param {{scenes: boolean, burn: boolean}} input
 * @returns {Record<string, [number, number]>}
 */
export function exportBandsFor(input) {
  const scenes = input.scenes === true;
  const burn = input.burn === true;
  if (!scenes && !burn) {
    // R20 基线：不改一个数字（A4 逐值对比的就是这张表）。
    return { plan: [0, 0.05], video: [0.05, 0.86], mux: [0.86, 0.93], verify: [0.93, 0.99], done: [1, 1] };
  }
  /** @type {Record<string, [number, number]>} */
  const bands = { plan: scenes ? [0, 0.02] : [0, 0.05] };
  if (scenes) bands.capture = [0.02, 0.35];
  bands.video = scenes ? [0.35, burn ? 0.6 : 0.86] : [0.05, burn ? 0.6 : 0.86];
  if (burn) bands.burn = [0.6, 0.93];
  bands.mux = burn ? [0.93, 0.97] : [0.86, 0.93];
  bands.verify = burn ? [0.97, 0.995] : [0.93, 0.99];
  bands.done = [1, 1];
  return bands;
}

/**
 * 质量档名（R9-C1 集成修正）。
 *
 * 这里**不再自己维护一份「档名 → ffmpeg 参数」表**：R9 合并时 MAIN 的旧表
 * （standard=veryfast/crf23）会和副线2 的档位默认值叠在一起，产出
 * `yuv444p + crf23 + veryfast` 这个既拿不到画质、又背 4:4:4 兼容性风险的组合
 * （大脑实测：合并后工作台导出 profile=High 4:4:4 Predictive）。档位参数的
 * 唯一权威是 `packages/render/quality.mjs`，这里只做**名字的合法性校验与透传**。
 */
export const EXPORT_QUALITIES = QUALITY_NAMES;

/** 请求里的合法字段（未知字段一律 400）。
 *
 * `outPath`（M37）：显式输出文件（绝对路径，必须在工程目录内）。不传就自己挑
 * `exports/film-<时间戳>.mp4`。显式路径是**同一个资源**：第二个作业会拿到
 * `EXPORT_OUTPUT_BUSY`（作业句柄的跨进程锁），而不是各自写一份。
 *
 * `subtitleBurn` / `subtitleSrc`（M41）：烧字幕。`subtitleSrc` 是字幕挂在哪条素材上
 * （工程相对路径），只有 `subtitleBurn:true` 时才必填；字幕源与工程样式都由服务端读，
 * 客户端**不上传字幕内容**。
 *
 * `size` / `fit` / `fps`（M42）：交付画幅与帧率。三个都可缺省；缺省 = 跟随工程 + 30fps，
 * 与 R20 逐字节相同。`size` 与 `fit` 交给 `render/delivery-size.mjs` 的 `planDelivery`，
 * studio 不自己算缩放（放大 720p 只会得到更糊的 1080p）。
 */
export const EXPORT_REQUEST_FIELDS = Object.freeze([
  'projectId',
  'range',
  'ranges',
  'quality',
  'codec',
  'outDir',
  'outPath',
  'subtitleBurn',
  'subtitleSrc',
  'size',
  'fit',
  'fps',
  // M78：序列（`POST /api/export {sequence}`）；缺省 = 当前打开序列。
  'sequence',
  'clipId',
  'expectedHash',
]);

/** @param {number} ms */
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** @param {unknown} error */
function codeOf(error) {
  const code = /** @type {any} */ (error)?.code;
  return typeof code === 'string' && code !== '' ? code : 'EXPORT_FAILED';
}

/** 时间戳：`20261107-143012`（本地时间，文件名可读）。 */
function stamp(date = new Date()) {
  /** @param {number} n */
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * 作业状态机（M29）：**只允许这五条边**，别的一律不改状态。
 *
 *     queued  → running
 *     queued  → cancelled      （还没开工就取消：永远不会跑）
 *     running → done           （成功落盘）
 *     running → failed
 *     running → cancelled      （abort → 子进程 SIGKILL → 临时目录删除）
 *
 * 终态（done/failed/cancelled）是吸收态：`cancel` 打上去只会原样返回。
 * 迁移全部走 `transition()`，别的函数不直接写 `job.state`——状态机要能被审计。
 */
export const EXPORT_TRANSITIONS = Object.freeze({
  queued: Object.freeze(['running', 'cancelled']),
  running: Object.freeze(['done', 'failed', 'cancelled']),
  done: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([]),
});

/**
 * @typedef {object} ExportJob
 * @property {string} id
 * @property {string} projectId
 * @property {string} projectDir
 * @property {'queued'|'running'|'done'|'failed'|'cancelled'} state
 * @property {string} stage
 * @property {number} percent
 * @property {number} frames
 * @property {number} framesTotal
 * @property {any} output 成品（**永远是 master**：不烧录时就是唯一产物；老字段形状不变）
 * @property {Array<{kind: 'master'|'subbed'|'vtt', path: string, bytes: number, sha256: string}>} artifacts
 *   产物清单（M41）：不烧录时只有 `master` 一条；烧录时三条（顺序 master → subbed → vtt）
 * @property {{code: string, message: string}|null} error
 * @property {string} queuedAt
 * @property {string|null} startedAt
 * @property {string|null} finishedAt
 * @property {any} handle render 的作业句柄（锁 + 取消 + 进度；created at enqueue）
 * @property {string} targetPath 入队时占住的输出文件（绝对路径）
 * @property {string} lockPath 该输出的锁文件（`<target>.opencut-lock`）
 * @property {string|null} basePath 烧字幕时的三件套 base（不含扩展名）；不烧录 = null
 * @property {boolean} subtitleBurn 是否烧字幕（M41）
 * @property {string} subtitleSrc 字幕挂在哪条素材（工程相对路径）
 * @property {string} subtitleFile 找到的伴生文件（`assets/a.vtt`）
 * @property {any[]} subtitleCues 入队那一刻的字幕条目（排队期间改 vtt 不影响本作业）
 * @property {any} subtitle 烧录结果（ASS/VTT 摘要、样式来源、warnings）
 * @property {string} outDir
 * @property {'draft'|'standard'|'high'} quality
 * @property {'h264'|'hevc'} codec 视频编码（M50）；缺省 `h264`，与 R24 的 h264 路径逐字节相同
 * @property {[number, number]|null} range
 * @property {Array<[number, number]>|null} ranges 多段区间（M39）；`ranges` 与 `range` 互斥，前者优先
 * @property {{w: number, h: number}|null} size 请求的交付画幅（M42）；null = 跟随工程
 * @property {'letterbox'|'cover'|null} fit 画幅适配（M42）
 * @property {number} fps 输出帧率（M42；缺省 30）
 * @property {{id: string, name: string}|null} sequence 导出的是哪个序列（M78；null = 旧调用方没传，等价 main）
 * @property {string|null} clipId 独立导出的网页片段标识
 * @property {string|null} docHash 入队那一刻 film.html 的 sha256（M78：写进 spec.json，事后能对上版本）
 * @property {string|null} specPath 带序列的导出写出的 spec 旁挂文件（M78；main 的默认导出不写）
 * @property {{w: number, h: number}|null} outputSize delivery 实际输出尺寸（排障用）
 * @property {{scale: number, footprint: {pixels: number, vs720p: number}}|null} deliveryScale
 * @property {string|null} deliveryVf 实际传给 ffmpeg 的画幅滤镜（A3 要原文）
 * @property {{built: string[], cached: string[], supported: string[], failed: string[]}|null} [proxies] R184：本次导出准备/复用的视频代理（HEVC 等）
 * @property {{w: number, h: number}|null} stage 入队时的画面尺寸（历史里要记「尺寸」）
 * @property {{w: number, h: number}|null} stageSize 入队时的画面尺寸（历史里记「尺寸」）
 * @property {any} doc 入队那一刻的文档快照（排队期间后续编辑不影响本作业）
 * @property {any} runInput 入队那一刻固定的执行参数（M70：调度器开跑时用它，别读请求对象）
 * @property {any} result runner 的返回值（仅自定义 runner 会用到）
 * @property {Record<string, [number, number]>} bands 各阶段的百分比区间
 * @property {boolean} cancelRequested
 * @property {'planning'|'rendering'|'burn'|'muxing'|'done'|null} phase 与 CLI `--progress jsonl` 同名
 * @property {any} progress 最后一条进度事件（原样，字段同 CLI）
 * @property {Array<any>} events 句柄事件流水（progress/cancel/done/error，最多 200 条）
 * @property {boolean} cancelTooLate 取消落在工作完成之后（产物完整）
 * @property {Array<{at: string, state: string}>} stateLog 每一次状态迁移（审计用：跳态会留痕）
 */

/**
 * 入队时占住输出（M37）。
 *
 * - 显式 `outPath`：**只认这一条**。被别的作业/进程占着就原样返回
 *   `EXPORT_OUTPUT_BUSY`（带持有者），不换名字——用户指定了文件。
 * - 默认路径：`<outDir>/film-<时间戳>.mp4`，前提是文件不存在且锁拿得到；
 *   同秒并发就依次试 `-1`、`-2`（默认路径不该因为并发而失败）。
 *
 * 烧字幕（M41）：占的是三件套里的 **`<base>-master.mp4`**（锁也在它上面），
 * 另外两个文件名由 base 决定。默认路径的「已存在」判断要看**三个**文件：只看 master
 * 会出现「master 没被占、但上一轮的 subbed/vtt 还在」的半覆盖。
 *
 * 锁是跨进程的（`<target>.opencut-lock`，`wx` 打开）。作业一入队就持有它，
 * 直到 `runExportJob` 的 finally / 排队取消时 `release()`。
 *
 * @param {{ jobId: string, projectDir: string, outDir: string, outPath?: string|null, burn?: boolean, sequenceId?: string|null }} input
 * @returns {{ok: true, handle: any, target: string, lock: string, base: string|null}|{ok: false, code: string, message: string, holder?: any}}
 */
function claimOutput(input) {
  const dir = input.outDir !== '' ? input.outDir : path.join(input.projectDir, 'exports');
  /* M78：非 main 序列的默认文件名带序列 id（`film-<seq>-<stamp>.mp4`）；main 保持现名，避免回归。 */
  const sequenceId = typeof input.sequenceId === 'string' && input.sequenceId !== '' ? input.sequenceId : null;
  const stemOf = () => (sequenceId === null || sequenceId === 'main' ? `film-${stamp()}` : `film-${sequenceId}-${stamp()}`);
  try {
    fssync.mkdirSync(dir, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      code: 'EXPORT_OUTPUT_UNWRITABLE',
      message: `输出目录不可写：${dir}（${String(/** @type {any} */ (error)?.message ?? error)}）`,
      holder: null,
    };
  }

  /**
   * @param {string} target
   * @returns {{ok: true, handle: any, target: string, lock: string, base: null}}
   */
  const claim = (target) => {
    const handle = createExportJob({ id: input.jobId, outputPath: target });
    return { ok: true, handle, target, lock: lockPathFor(target), base: null };
  };

  /**
   * 烧录：锁落在 master 上，base 记进作业（三件套的另外两个由它推）。
   * @param {string} base
   * @returns {{ok: true, handle: any, target: string, lock: string, base: string}}
   */
  const claimBase = (base) => {
    const pieces = threePiecePaths(base);
    const handle = createExportJob({ id: input.jobId, outputPath: pieces.master });
    return { ok: true, handle, target: pieces.master, lock: lockPathFor(pieces.master), base };
  };

  if (input.burn === true) {
    if (typeof input.outPath === 'string' && input.outPath !== '') {
      try {
        return claimBase(burnBaseOf(path.resolve(input.outPath)));
      } catch (error) {
        return failedClaim(error);
      }
    }
    const stem = stemOf();
    /** @type {any} */
    let last = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const base = path.join(dir, attempt === 0 ? stem : `${stem}-${attempt}`);
      const pieces = threePiecePaths(base);
      // 三个文件里任何一个已经在了：换下一个 base，绝不半覆盖上一轮的三件套。
      if ([pieces.master, pieces.subbed, pieces.vtt].some((file) => fssync.existsSync(file))) continue;
      try {
        return claimBase(base);
      } catch (error) {
        last = error;
        if (/** @type {any} */ (error)?.code === 'EXPORT_OUTPUT_BUSY') continue;
        return failedClaim(error);
      }
    }
    return {
      ok: false,
      code: 'EXPORT_OUTPUT_BUSY',
      message: last === null ? `没有可用的输出文件名：${stem}` : String(/** @type {any} */ (last)?.message ?? last),
      holder: /** @type {any} */ (last)?.holder ?? null,
    };
  }

  if (typeof input.outPath === 'string' && input.outPath !== '') {
    try {
      return claim(path.resolve(input.outPath));
    } catch (error) {
      return failedClaim(error);
    }
  }

  const base = stemOf();
  /** @type {any} */
  let last = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const name = attempt === 0 ? `${base}.mp4` : `${base}-${attempt}.mp4`;
    const target = path.join(dir, name);
    // 文件已经在了（上一轮导出的同名产物）：换下一个，不覆盖。
    if (fssync.existsSync(target)) continue;
    try {
      return claim(target);
    } catch (error) {
      last = error;
      // 默认名字被同秒的另一个作业占着：换后缀继续试，这不是调用方的错。
      if (/** @type {any} */ (error)?.code === 'EXPORT_OUTPUT_BUSY') continue;
      return failedClaim(error);
    }
  }
  return {
    ok: false,
    code: 'EXPORT_OUTPUT_BUSY',
    message: last === null ? `没有可用的输出文件名：${base}` : String(/** @type {any} */ (last)?.message ?? last),
    holder: /** @type {any} */ (last)?.holder ?? null,
  };
}

/** @param {unknown} error @returns {{ok: false, code: string, message: string, holder: any}} */
function failedClaim(error) {
  const raw = /** @type {any} */ (error);
  // 进程内占用（同一 Studio 里的另一个作业）只带 jobId；补上本进程 pid，
  // 与锁文件里的 `{pid, jobId, at}` 形状一致——报错要能指认持有者。
  const held = raw?.holder ?? null;
  const holder = held === null || typeof held !== 'object' ? null : { pid: process.pid, ...held };
  return {
    ok: false,
    code: typeof raw?.code === 'string' && raw.code !== '' ? raw.code : 'EXPORT_OUTPUT_UNWRITABLE',
    message: String(raw?.message ?? error),
    holder,
  };
}

/**
 * 把作业句柄的事件记进队列作业：对外字段与 CLI `--progress jsonl` 同名同义。
 * @param {ExportJob} job
 * @param {any} event
 */
function recordEvent(job, event) {
  job.events.push(event);
  // 只留最近 200 条：整条流水够验收/排障，不会让每 400ms 的轮询背一座山。
  if (job.events.length > 200) job.events.shift();
  if (event?.type === 'progress') {
    job.phase = event.phase ?? job.phase;
    if (Number.isFinite(event.frame)) job.frames = Math.max(job.frames, event.frame);
    if (Number.isFinite(event.totalFrames) && event.totalFrames > 0) job.framesTotal = event.totalFrames;
    job.progress = event;
    return;
  }
  if (event?.type === 'cancel') {
    job.cancelRequested = true;
    return;
  }
  if (event?.type === 'error') {
    job.error = { code: String(event.code ?? 'EXPORT_FAILED'), message: String(event.message ?? '') };
    return;
  }
  if (event?.type === 'done' && event.cancelTooLate === true) job.cancelTooLate = true;
}

/**
 * 建一个进程内导出队列。
 *
 * **串行**：同一时刻最多 1 个 `running`；连续 `start` 会排队（`queued`），
 * 前一个结束（成败取消都算）自动开下一个。
 *
 * @param {{ logger?: (line: string) => void, keepFinished?: number, runner?: Function, partialDir?: string }} [options]
 *   `runner` 只给单测用：默认就是本文件的 `run()`（真 ffmpeg）。生产路径不传。
 *   `partialDir` 是中间文件目录（M70）：空 = 系统临时目录；Studio 传渲染队列的 `partial/`。
 */
export function createExportJobs(options = {}) {
  const log = options.logger ?? (() => {});
  const keepFinished = Number.isInteger(options.keepFinished) ? Number(options.keepFinished) : 20;
  /** 真渲染链；单测可注入一个受控的假 runner 来观察状态机本身。 */
  const runner = typeof options.runner === 'function' ? options.runner : run;
  /**
   * 中间文件的落脚目录（M70）。
   *
   * 给空 = `os.tmpdir()`（R50 之前的行为）。Studio 传渲染队列的 `partial/`：
   * 进程被 kill 时残留的整段 `opencut-export-*` 目录就落在调度器的半成品目录里，
   * 重启时由 `scheduler.recovery()` 统一清理并记账（不然只能扫系统临时目录猜）。
   */
  const partialDir = typeof options.partialDir === 'string' ? options.partialDir : '';
  /** @type {Map<string, ExportJob>} */
  const jobs = new Map();
  /** @type {string[]} 入队顺序（含已结束的，用于「位置」与裁剪） */
  const order = [];
  /** @type {string[]} 已完成作业的 id（按完成顺序，用于裁剪） */
  const finished = [];
  /** 正在跑的作业（M70：接调度器后可以同时有多个；不接时最多 1 个）。 */
  /** @type {Set<string>} */
  const runningIds = new Set();
  /** 调度器（M70）：给了就走队列，`pump()` 退化成 no-op。 */
  /** @type {any} */
  let scheduler = null;

  /**
   * 唯一的状态写入口：非法迁移直接抛（不是静默忽略），这样跳态会在日志里炸出来。
   * @param {ExportJob} job
   * @param {'queued'|'running'|'done'|'failed'|'cancelled'} next
   */
  function transition(job, next) {
    /** @type {readonly string[]} */
    const allowed = /** @type {Record<string, readonly string[]>} */ (EXPORT_TRANSITIONS)[job.state] ?? [];
    if (job.state !== next && !allowed.includes(next)) {
      throw new Error(`非法状态迁移：${job.state} → ${next}（job ${job.id}）`);
    }
    job.state = next;
    // 迁移逐条留痕：UI 的轮询会漏掉毫秒级的中间态（比如 plan 里就失败的作业），
    // 所以「有没有跳态」不能靠采样断言，要看这份日志。
    job.stateLog.push({ at: new Date().toISOString(), state: next });
  }

  /**
   * 队列位置：1 = 下一个开工，0 = 不在排队（running/终态）。
   * @param {ExportJob} job
   */
  function positionOf(job) {
    if (job.state !== 'queued') return 0;
    if (scheduler !== null) {
      const view = typeof scheduler.status === 'function' ? scheduler.status() : null;
      const queued = Array.isArray(view?.queued) ? view.queued : [];
      const index = queued.findIndex((/** @type {any} */ item) => item?.id === job.id);
      return index < 0 ? 0 : index + 1;
    }
    let position = 0;
    for (const id of order) {
      const item = jobs.get(id);
      if (item === undefined || item.state !== 'queued') continue;
      position += 1;
      if (item.id === job.id) return position;
    }
    return 0;
  }

  /** @param {ExportJob} job */
  function snapshot(job) {
    return {
      id: job.id,
      projectId: job.projectId,
      state: job.state,
      stage: job.stage,
      percent: Number(job.percent.toFixed(4)),
      frames: job.frames,
      framesTotal: job.framesTotal,
      // —— M37：与 CLI `--progress jsonl` 同名同义的对外字段 ——
      phase: job.phase,
      frame: job.frames,
      totalFrames: job.framesTotal,
      progress: job.progress,
      events: job.events,
      code: job.error === null ? null : job.error.code,
      cancelTooLate: job.cancelTooLate === true,
      targetPath: job.targetPath,
      lockPath: job.lockPath,
      outDir: job.outDir,
      // M78：序列（老作业是 null）。
      sequence: job.sequence ?? null,
      ...(job.clipId ? { clipId: job.clipId } : {}),
      filmHtmlSha256: job.docHash ?? null,
      specPath: job.specPath ?? null,
      quality: job.quality,
      // M50：编码。缺省 h264 —— 老客户端读到的字段多了一个，形状不变。
      codec: job.codec,
      range: job.range,
      // M39：多段是 `range` 的**另一条**通道（不是数组化 range）：单段/整片的快照形状一字不变。
      ranges: job.ranges,
      // M41：烧字幕。不烧录时 `subtitleBurn:false` / `artifacts` 只有 master 一条，
      // 其余字段为 null——老客户端读到的形状仍然可用。
      subtitleBurn: job.subtitleBurn === true,
      subtitleSrc: job.subtitleSrc,
      subtitleFile: job.subtitleFile,
      subtitle: job.subtitle,
      artifacts: job.artifacts,
      // 终态才带 ASS 原文（几 KB）：轮询期间不带，交接/排障要核「样式到底写成了什么」时能取。
      ...(job.state === 'done' && typeof job.subtitle?.assText === 'string' ? { assText: job.subtitle.assText } : {}),
      stageSize: job.stageSize ?? null,
      // M42：交付画幅与帧率（null = 跟随工程）。`outputSize` 是 delivery 算出来的实际输出。
      size: job.size ?? null,
      fit: job.fit ?? null,
      fps: job.fps,
      outputSize: job.outputSize ?? null,
      deliveryScale: job.deliveryScale ?? null,
      /** 实际传给 ffmpeg 的画幅滤镜（A3 要原文；null = 没传）。 */
      vf: job.deliveryVf ?? null,
      output: job.output,
      error: job.error,
      queuedAt: job.queuedAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      position: positionOf(job),
      cancelRequested: job.cancelRequested === true,
      stateLog: job.stateLog,
    };
  }

  /**
   * 单调推进：`percent` 只会被抬高，阶段只会往后走。
   * @param {ExportJob} job
   * @param {string} stage
   * @param {number} [fraction] 0..1 该阶段内部完成度
   */
  function setStage(job, stage, fraction = 0) {
    const order = EXPORT_STAGES.indexOf(stage);
    const current = EXPORT_STAGES.indexOf(job.stage);
    if (order < current) return;
    job.stage = stage;
    const band = job.bands[stage];
    if (band === undefined) return;
    const span = band[1] - band[0];
    const value = band[0] + span * Math.max(0, Math.min(1, fraction));
    if (value > job.percent) job.percent = value;
  }

  /**
   * 把临时目录里的成品搬到**入队时占住的输出路径**（跨卷安全：copyFile + 摘要）。
   *
   * 目标在导出期间被别人抢先创建（锁挡的是作业，防不了人手/别的程序）：退到同目录的
   * `-1`、`-2` 后缀，**绝不覆盖**已有文件。正常路径第一个候选就是占住的那个名字。
   * @param {ExportJob} job
   * @param {string} tmpOut
   */
  async function placeOutput(job, tmpOut) {
    const preferred = job.targetPath;
    const dir = path.dirname(preferred);
    const ext = path.extname(preferred);
    const stem = preferred.slice(0, preferred.length - ext.length);
    /** @type {string[]} */
    const candidates = [preferred];
    for (let attempt = 1; attempt < 50; attempt += 1) candidates.push(`${stem}-${attempt}${ext}`);
    for (const target of candidates) {
      try {
        await fs.copyFile(tmpOut, target, fssync.constants.COPYFILE_EXCL);
        const stat = await fs.stat(target);
        const digest = await new Promise((resolve, reject) => {
          const hash = crypto.createHash('sha256');
          const stream = fssync.createReadStream(target);
          stream.on('data', (chunk) => hash.update(chunk));
          stream.on('error', reject);
          stream.on('end', () => resolve(hash.digest('hex')));
        });
        return { path: target, bytes: stat.size, sha256: digest, outDir: dir };
      } catch (error) {
        if (/** @type {any} */ (error)?.code === 'EEXIST') continue;
        throw error;
      }
    }
    throw new Error(`输出目录里同名文件过多：${preferred}`);
  }

  /** @param {string} file */
  async function hashFile(file) {
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
      const stream = fssync.createReadStream(file);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(undefined));
    });
    return hash.digest('hex');
  }

  /**
   * 烧录的三件套落盘（M41）：master + subbed 从临时目录复制，vtt 直接写。
   *
   * **三个文件一起成功，或者一个都不留**：base 候选按 `-1`、`-2` 退让（导出期间
   * 有人手工往 exports/ 放了同名文件才会走到），某个候选里只要有一个名字被占，
   * 就把这个候选里刚写下的文件删掉再试下一个——不留半套三件套。
   *
   * @param {ExportJob} job
   * @param {string} tmpMaster
   * @param {string} tmpSubbed
   * @param {string} vttText
   * @returns {Promise<{master: any, subbed: any, vtt: any}>}
   */
  async function placeBurnOutput(job, tmpMaster, tmpSubbed, vttText) {
    const base0 = job.basePath ?? burnBaseOf(job.targetPath);
    /** @type {string[]} */
    const candidates = [base0];
    for (let attempt = 1; attempt < 50; attempt += 1) candidates.push(`${base0}-${attempt}`);
    for (const base of candidates) {
      const pieces = threePiecePaths(base);
      /** @type {string[]} */
      const created = [];
      try {
        await fs.copyFile(tmpMaster, pieces.master, fssync.constants.COPYFILE_EXCL);
        created.push(pieces.master);
        await fs.copyFile(tmpSubbed, pieces.subbed, fssync.constants.COPYFILE_EXCL);
        created.push(pieces.subbed);
        await fs.writeFile(pieces.vtt, vttText, { encoding: 'utf8', flag: 'wx' });
        created.push(pieces.vtt);
        const [masterBytes, subbedBytes, vttBytes] = await Promise.all([
          fs.stat(pieces.master).then((info) => info.size),
          fs.stat(pieces.subbed).then((info) => info.size),
          fs.stat(pieces.vtt).then((info) => info.size),
        ]);
        return {
          master: { kind: 'master', path: pieces.master, bytes: masterBytes, sha256: await hashFile(pieces.master) },
          subbed: { kind: 'subbed', path: pieces.subbed, bytes: subbedBytes, sha256: await hashFile(pieces.subbed) },
          vtt: { kind: 'vtt', path: pieces.vtt, bytes: vttBytes, sha256: crypto.createHash('sha256').update(vttText, 'utf8').digest('hex') },
        };
      } catch (error) {
        for (const file of created) await fs.unlink(file).catch(() => {});
        if (/** @type {any} */ (error)?.code === 'EEXIST') continue;
        throw error;
      }
    }
    throw new Error(`输出目录里同名文件过多：${base0}`);
  }


  /**
   * 跑一个作业。**成功/失败/取消的收尾都交给 `runExportJob`**：
   * 它负责 finish/fail（含「取消来晚了」）以及 finally 放锁——这里不再自己结算锁。
   *
   * @param {ExportJob} job
   * @param {any} doc
   * @param {{ range?: [number, number]|null, ranges?: Array<[number, number]>|null, quality: string,
   *   size?: {w: number, h: number}|null, fit?: 'letterbox'|'cover'|null, fps?: number|null,
   *   filmSnapshot?: {doc: any, text: string, hash: string} }} input
   */
  async function run(job, doc, input) {
    const handle = job.handle;
    const signal = handle.signal;
    // 中间文件（成片、烧录版、取帧）全在这个目录里：正常结束/取消由 finally 删掉；
    // 进程被 kill 时它留在 `partialDir` 下，调度器重启时统一清理并记账（M70）。
    const tmpRoot = partialDir !== '' ? partialDir : os.tmpdir();
    if (partialDir !== '') await fs.mkdir(tmpRoot, { recursive: true });
    const tmpDir = await fs.mkdtemp(path.join(tmpRoot, 'opencut-export-'));
    const tmpOut = path.join(tmpDir, 'film.mp4');
    const quality = EXPORT_QUALITIES.includes(input.quality) ? input.quality : 'standard';
    /** 请求中止：抛这个让 `runExportJob` 走 cancelled 分支（不要自己吞掉）。 */
    const abort = () => Object.assign(new Error('导出已取消'), { code: 'EXPORT_CANCELLED' });
    try {
      /** @type {any} */
      const output = await runExportJob(handle, async () => {
        // plan 阶段先不推到具体百分比：bands 要等计划算完才知道（有没有网页片段决定后面的区间）。
        // M39：多段走 `ranges`（`planFromFilm` 里 `ranges` 优先于 `range`）。
        // 只有一段时也照传 `ranges`：与 CLI 的 `--range a:b,c:d` 归一化后的路径**同一条**，
        // 少一个分支就少一处「面板和命令行算得不一样」。
        // M42：`fps` 直接透传（缺省仍是 30，planFromFilm 自己兜底）。
        const plan = await planFromFilm(doc, {
          projectRoot: job.projectDir,
          ...(Number.isFinite(input.fps) && Number(input.fps) > 0 ? { fps: Number(input.fps) } : {}),
          ...(input.ranges && input.ranges.length > 0
            ? { ranges: input.ranges }
            : input.range
              ? { range: input.range }
              : {}),
        });
        job.framesTotal = Number(plan.frames) || 0;
        /* 交付画幅（M42）：与 CLI 同一条路——`planDelivery` 算输出尺寸/取帧视口/滤镜，
           studio 不自己写缩放。不传 size 时 fit='none'、viewPort=stage、vf=null，
           后面两个分支都不会进，args 与 R20 逐项相同。 */
        const delivery = planDelivery({
          stage: plan.stage,
          size: input.size ?? null,
          fit: input.fit ?? null,
        });
        job.outputSize = { w: delivery.output.w, h: delivery.output.h };
        job.deliveryScale =
          delivery.fit === 'none'
            ? null
            : { scale: Number(delivery.scale.toFixed(4)), footprint: sizeFootprint(delivery.output) };
        // 计划层可能把越界/短于一帧的段判掉；把**归一后的**区间记回快照，
        // 队列里看到的就是真实取用窗口（多段是帧对齐后的窗口）。
        if (Array.isArray(plan.ranges)) {
          job.ranges = plan.ranges.map((item) => [Number(item[0]), Number(item[1])]);
          if (job.ranges.length === 1 && job.range === null) {
            const only = /** @type {[number, number]} */ (job.ranges[0]);
            job.range = [only[0], only[1]];
          }
        }
        const hasScenes = (Array.isArray(plan.sceneClips) && plan.sceneClips.length > 0) || requiresTransitionStage(plan) || requiresCreationStyleStage(plan);
        // M50：烧录是第二次编码，单独占一段 band。不烧录/不取帧时这张表与 M42 逐值相同。
        job.bands = exportBandsFor({ scenes: hasScenes, burn: job.subtitleBurn === true });
        setStage(job, 'plan', 1);
        handle.progress({ phase: 'planning', frame: 0, totalFrames: job.framesTotal });
        if (signal.aborted) throw abort();

        /* R184：Chromium 放不了的源（HEVC / ProRes …）先转 H.264 代理。
           为什么放在这里：舞台 `page.goto()` 只有 30s 预算，冷转 167.5s 的 4K HEVC 要 60–90s，
           塞进舞台引导必超时；plan 阶段没有这个限制，而且失败能在取帧前失败（PROXY_FAILED）。
           代理缓存进 `<project>/proxies/<hash>.mp4`，第二次导出直接复用。 */
        {
          const resolved = await resolveFfmpegPath({ projectRoot: job.projectDir });
          const besideFfprobe = path.join(path.dirname(resolved.path), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
          const ffprobePath = (await fs.access(besideFfprobe).then(() => true).catch(() => false)) ? besideFfprobe : 'ffprobe';
          const proxies = await warmVideoProxies(job.projectDir, doc, {
            ffmpegPath: resolved.path,
            ffprobePath,
            log: (line) => log(line),
          });
          job.proxies = proxies;
          if (proxies.built.length > 0 || proxies.cached.length > 0) {
            log(`EXPORT_PROXIES id=${job.id} built=${proxies.built.length} cached=${proxies.cached.length} supported=${proxies.supported.length}`);
          }
          if (proxies.failed.length > 0) {
            throw Object.assign(new Error(`视频源缺失，无法准备代理：${proxies.failed.join(', ')}`), { code: 'PROXY_FAILED' });
          }
        }

        /* 烧字幕（M41）：准备放在**取帧之前**——坏 vtt / 缺样式要在开渲之前失败，
           别让人等三分钟才看到错（CLI 的 prepareSubtitleBurn 也是这个顺序）。
           样式在**开工这一刻**从 `.film/subtitle-style.json` 读，与 CLI 同口径；
           读到的 sha256 记进快照，事后能对上「这条成片用的是哪份样式」。 */
        /** @type {any} */
        let burn = null;
        if (job.subtitleBurn === true) {
          /* 字幕几何（M42）：交付画幅 ≠ 舞台时，ASS 必须按**舞台**算再整体缩放到画面里
             （与 CLI 的 subtitleLayout 一字不差）。不传 size 时 delivery.fit='none'，
             layout 为 null → ASS 的 PlayRes = 舞台，与 M41 逐字节相同。
             M44：这段几何抽到 `export-burn.mjs` 的 `subtitleLayoutOf`——入队前预检用同一个。 */
          const subtitleLayout = subtitleLayoutOf(delivery, plan.stage);
          const bundle = await buildBurnBundle({
            projectDir: job.projectDir,
            src: job.subtitleSrc,
            file: job.subtitleFile,
            cues: job.subtitleCues,
            plan,
            size: delivery.output,
            ...(subtitleLayout ? { layout: subtitleLayout } : {}),
          });
          if (bundle.ok !== true) throw Object.assign(new Error(bundle.message), { code: bundle.code });
          const written = await writeBurnFiles({
            assPath: path.join(tmpDir, 'subs', 'subtitles.ass'),
            vttPath: path.join(tmpDir, 'subs', 'subtitles.vtt'),
            assText: bundle.assText,
            vttText: bundle.vttText,
          });
          if (written.ok !== true) throw Object.assign(new Error(written.message), { code: written.code });
          const assSha256 = crypto.createHash('sha256').update(bundle.assText, 'utf8').digest('hex');
          burn = {
            ...bundle,
            assPath: path.join(tmpDir, 'subs', 'subtitles.ass'),
            assSha256,
            vttSha256: crypto.createHash('sha256').update(bundle.vttText, 'utf8').digest('hex'),
          };
          job.subtitle = {
            src: job.subtitleSrc,
            file: job.subtitleFile,
            cues: burn.cues.length,
            styleExists: burn.styleExists,
            styleSha256: burn.styleSha256,
            assSha256,
            vttSha256: burn.vttSha256,
            warnings: burn.warnings,
            dropped: burn.dropped,
          };
          log(`EXPORT_BURN id=${job.id} cues=${burn.cues.length} style=${burn.styleExists ? 'file' : 'default'} file=${job.subtitleFile}`);
        }

        /** @type {any} */
        let capture = null;
        if (hasScenes) {
          setStage(job, 'capture', 0);
          const framesDir = path.join(tmpDir, 'frames');
          // 惰性加载：舞台取帧会拉起一个独立 Studio + Chromium，只有真需要时才付这个代价。
          const { captureFilmFrames } = await import('../../render/stage-capture.mjs');
          capture = await captureFilmFrames({
            plan,
            projectRoot: job.projectDir,
            framesDir,
            signal,
            logger: () => {},
            ...(input.filmSnapshot ? { filmSnapshot: input.filmSnapshot } : {}),
            // 画幅（M42）：只改「视口 + 舞台 fit」，舞台内部坐标仍是工程尺寸（CLI 同款）。
            ...(delivery.fit !== 'none' ? { size: delivery.viewport, stageFit: delivery.stageFit } : {}),
            onFrame: () => {
              // 取帧是**多通道并行**的（stage-capture 的 concurrency>1），`index` 到达顺序是乱的：
              // 用 `index+1` 会让「已渲染」在 121 → 46 之间来回跳。这里数**完成了几帧**。
              job.frames += 1;
              setStage(job, 'capture', job.framesTotal > 0 ? job.frames / job.framesTotal : 1);
              handle.progress({
                phase: 'rendering',
                stage: 'capture',
                frame: job.frames,
                ...(job.framesTotal > 0 ? { totalFrames: job.framesTotal } : {}),
              });
            },
          });
          job.frames = capture.frames;
          setStage(job, 'capture', 1);
        }
        if (signal.aborted) throw abort();

        setStage(job, 'video', 0);
        /** 烧录版先落临时目录：成功后与 master 一起搬到 exports/，失败/取消随 tmpDir 一起删。 */
        const tmpSubbed = path.join(tmpDir, 'film-subbed.mp4');
        /* 画幅滤镜（M42）：舞台路径画面已是目标尺寸（cover 才裁），ffmpeg 合成路径的
           画布还是 stage 尺寸（缩放/留边必须由滤镜补）——与 `cli/ops.mjs:1105` 同一行。 */
        const postVf = hasScenes ? delivery.vf : delivery.ffmpegVf;
        job.deliveryVf = postVf ?? null;
        const rendered = await renderFilmExport({
          plan,
          projectRoot: job.projectDir,
          outPath: tmpOut,
          ...(capture !== null ? { capture } : {}),
          signal,
          // 只传档名：参数（crf/preset/pixFmt）由 quality.mjs 决定，别再在这里覆盖一份。
          quality,
          // 编码（M50）：缺省 h264 —— resolveCodec('h264') 与 resolveCodec(undefined) 同一份矩阵。
          codec: job.codec,
          ...(delivery.fit !== 'none' ? { outputSize: delivery.output } : {}),
          ...(postVf ? { vf: postVf } : {}),
          // 烧字幕（M41）：render 收到 assPath 会**同一批帧再编一遍**，不重新取帧。
          ...(burn !== null ? { subtitles: { assPath: burn.assPath, outPath: tmpSubbed } } : {}),
          // 真帧进度（M37）：以前这里没有回调，只能看 partial 文件大小猜；现在与 CLI 同一条数据源。
          onProgress: (/** @type {any} */ info) => {
            if (signal.aborted) return;
            if (info.phase === 'burn') {
              // M50：烧录是**第二次编码**，帧号是它自己的计数。不能拿 `job.frames`
              // （母版编码早已跑满，会把百分比钉死在 93%）。原样透出 phase/stage。
              const burnFrame = Number(info.frame);
              const burnTotal = Number(info.totalFrames);
              const ratio =
                Number.isFinite(burnTotal) && burnTotal > 0 && Number.isFinite(burnFrame) ? burnFrame / burnTotal : 0;
              setStage(job, 'burn', ratio);
              handle.progress({
                phase: 'burn',
                stage: 'encode',
                ...(Number.isFinite(burnFrame) ? { frame: burnFrame } : {}),
                ...(Number.isFinite(burnTotal) ? { totalFrames: burnTotal } : {}),
              });
              return;
            }
            if (info.phase === 'muxing') {
              setStage(job, 'mux', 0);
              handle.progress({
                phase: 'muxing',
                ...(Number.isFinite(info.totalFrames) ? { totalFrames: info.totalFrames } : {}),
              });
              return;
            }
            const frame = Number(info.frame);
            if (Number.isFinite(frame)) {
              job.frames = Math.max(job.frames, frame);
              setStage(job, 'video', job.framesTotal > 0 ? job.frames / job.framesTotal : 1);
            }
            handle.progress({
              phase: 'rendering',
              ...(info.stage ? { stage: info.stage } : {}),
              ...(Number.isFinite(frame) ? { frame } : {}),
              ...(Number.isFinite(info.totalFrames) ? { totalFrames: info.totalFrames } : {}),
            });
          },
        });
        if (signal.aborted) throw abort();

        // 编码结束：帧数就是成片的帧数（取帧阶段可能只报了完成数）。
        job.frames = Number(rendered.frames) || job.framesTotal;
        setStage(job, 'verify', 0);
        const verifyStarted = Date.now();
        /** @type {any} */
        let placed;
        /** @type {Array<any>} */
        let artifacts;
        if (burn !== null) {
          // 三件套一起落盘：master / subbed / vtt。任何一个名字被占就整套换 base，
          // 不会留下「有 master 没 subbed」的半套。
          if (rendered.subtitles === undefined || rendered.subtitles === null) {
            throw Object.assign(new Error('render 没有产出烧录版（subtitles 入参未被消费）'), { code: 'OUTPUT_UNVERIFIED' });
          }
          const three = await placeBurnOutput(job, tmpOut, tmpSubbed, burn.vttText);
          placed = { path: three.master.path, bytes: three.master.bytes, sha256: three.master.sha256 };
          artifacts = [three.master, three.subbed, three.vtt];
          job.subtitle = {
            ...job.subtitle,
            subbedSha256: three.subbed.sha256,
            subbedBytes: three.subbed.bytes,
            vttPath: three.vtt.path,
            assText: burn.assText,
          };
        } else {
          placed = await placeOutput(job, tmpOut);
          artifacts = [{ kind: 'master', path: placed.path, bytes: placed.bytes, sha256: placed.sha256 }];
        }
        // 校验阶段的真实工作（复制 + 摘要）只有几十毫秒，客户端 400ms 轮询会直接跳过它；
        // 给一个 300ms 的**展示下限**，让用户看得到"校验成品"这一步（不改变作业结果）。
        const spent = Date.now() - verifyStarted;
        if (spent < 300) await sleep(300 - spent);
        setStage(job, 'verify', 1);
        job.percent = 1;
        job.artifacts = artifacts;
        /* M78：序列导出的 spec 旁挂文件（放在产出旁边，ffprobe/核对都从它取序列与 film 版本）。 */
        if (job.sequence !== null) {
          job.specPath = await writeExportSpec(job, { path: placed.path, bytes: placed.bytes, sha256: placed.sha256 }, artifacts);
        }
        return {
          path: placed.path,
          bytes: placed.bytes,
          sha256: placed.sha256,
          frames: rendered.frames,
          durationSec: rendered.durationSec,
          picture: rendered.pictureSource ?? null,
          video: rendered.video ? { bytes: rendered.video.bytes, sha256: rendered.video.sha256 } : null,
          audio: rendered.audio ?? null,
        };
      });
      job.output = output;
      job.stage = 'done';
      transition(job, 'done');
      log(`EXPORT_DONE id=${job.id} path=${output.path} bytes=${output.bytes}`);
    } catch (error) {
      // 句柄的 cancel 与队列的 cancelRequested 都算「用户取消」。
      const code = signal.aborted ? 'CANCELLED' : codeOf(error);
      const message = String(/** @type {any} */ (error)?.message ?? error);
      if (code === 'CANCELLED') {
        transition(job, 'cancelled');
        job.error = { code: 'CANCELLED', message: '导出已取消' };
      } else {
        transition(job, 'failed');
        job.error = { code, message };
      }
      // 取消/失败都不留成品：临时目录整体删掉，输出目录里一行都不写。
      log(`EXPORT_${job.state.toUpperCase()} id=${job.id} code=${code} ${message.slice(0, 200)}`);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * 入队（M29）。**不再因为「已有作业在跑」而拒绝**：直接排到队尾，`queued`。
   *
   * 文档快照在入队这一刻固定：排队期间继续剪辑不会改变这个作业要导的内容
   * （否则「排队→改片→开工」会导出一个用户没预期的版本）。
   *
   * M37 起**入队即占输出**：`claimOutput` 拿作业句柄的跨进程锁。同一个输出
   * （显式 `outPath`）被占时这里直接返回 `{ok:false, code:'EXPORT_OUTPUT_BUSY', holder}`，
   * 调用方（HTTP 层）原样 409 出去，不建作业、不排队。
   *
   * @param {{
   *   projectId: string,
   *   projectDir: string,
   *   doc: any,
   *   range?: [number, number]|null,
   *   ranges?: Array<[number, number]>|null,
   *   quality?: string,
   *   codec?: string,
   *   outDir?: string,
   *   outPath?: string|null,
   *   subtitleBurn?: boolean,
   *   subtitleSrc?: string,
   *   subtitleFile?: string,
   *   subtitleCues?: any[],
   *   size?: {w: number, h: number}|null,
   *   fit?: 'letterbox'|'cover'|null,
   *   fps?: number|null,
   *   priority?: number,
   *   sequence?: { id: string, name: string }|null,
   *   docHash?: string|null,
   *   clipId?: string|null,
   *   filmSnapshot?: {doc: any, text: string, hash: string},
   * }} input
   * @returns {{ok: true, job: any}|{ok: false, code: string, message: string, holder?: any}}
   */
  function start(input) {
    /** @type {'draft'|'standard'|'high'} */
    const quality =
      typeof input.quality === 'string' && EXPORT_QUALITIES.includes(input.quality)
        ? /** @type {'draft'|'standard'|'high'} */ (input.quality)
        : 'standard';
    // 编码（M50）：白名单在 HTTP 层（UNSUPPORTED_CODEC）；这里再兜一层，非法值一律落回 h264。
    /** @type {'h264'|'hevc'} */
    const codec = input.codec === 'hevc' ? 'hevc' : 'h264';
    const id = `exp-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const outDir = typeof input.outDir === 'string' ? input.outDir : '';
    const burn = input.subtitleBurn === true;
    const sequence = input.sequence !== undefined && input.sequence !== null && typeof input.sequence.id === 'string'
      ? { id: input.sequence.id, name: typeof input.sequence.name === 'string' ? input.sequence.name : input.sequence.id }
      : null;
    const claim = claimOutput({
      jobId: id,
      projectDir: input.projectDir,
      outDir,
      outPath: typeof input.outPath === 'string' ? input.outPath : null,
      burn,
      sequenceId: sequence === null ? null : sequence.id,
    });
    if (claim.ok !== true) {
      log(
        `EXPORT_REJECT id=${id} project=${input.projectId} code=${claim.code} ` +
          `holder=${JSON.stringify(claim.holder ?? null)} ${claim.message.slice(0, 200)}`,
      );
      return claim;
    }
    /** @type {ExportJob} */
    const job = {
      id,
      projectId: input.projectId,
      projectDir: input.projectDir,
      sequence,
      clipId: input.clipId ?? null,
      docHash: typeof input.docHash === 'string' && input.docHash !== '' ? input.docHash : null,
      specPath: null,
      state: 'queued',
      stage: 'queued',
      percent: 0,
      frames: 0,
      framesTotal: 0,
      outDir,
      quality,
      codec,
      range: input.range ?? null,
      ranges: Array.isArray(input.ranges) && input.ranges.length > 0 ? input.ranges : null,
      size: input.size ?? null,
      fit: input.fit ?? null,
      fps: Number.isFinite(input.fps) && Number(input.fps) > 0 ? Number(input.fps) : 30,
      outputSize: null,
      deliveryScale: null,
      deliveryVf: null,
      stageSize:
        input.doc?.stage && Number.isFinite(Number(input.doc.stage.w)) && Number.isFinite(Number(input.doc.stage.h))
          ? { w: Number(input.doc.stage.w), h: Number(input.doc.stage.h) }
          : null,
      output: null,
      error: null,
      queuedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      handle: claim.handle,
      targetPath: claim.target,
      lockPath: claim.lock,
      basePath: claim.base ?? null,
      subtitleBurn: burn,
      subtitleSrc: burn ? String(input.subtitleSrc ?? '') : '',
      subtitleFile: burn ? String(input.subtitleFile ?? '') : '',
      subtitleCues: burn && Array.isArray(input.subtitleCues) ? input.subtitleCues : [],
      subtitle: null,
      artifacts: [],
      doc: input.doc,
      runInput: null,
      result: null,
      bands: exportBandsFor({ scenes: false, burn }),
      cancelRequested: false,
      phase: null,
      progress: null,
      events: [],
      cancelTooLate: false,
      stateLog: [{ at: new Date().toISOString(), state: 'queued' }],
    };
    claim.handle.on((/** @type {any} */ event) => recordEvent(job, event));
    // 执行参数在入队这一刻固定（排队期间改请求不影响本作业）。
    job.runInput = {
      range: job.range,
      ranges: job.ranges,
      quality: job.quality,
      size: job.size,
      fit: job.fit,
      fps: job.fps,
      ...(input.filmSnapshot ? { filmSnapshot: input.filmSnapshot } : {}),
    };
    jobs.set(job.id, job);
    order.push(job.id);
    if (scheduler !== null) {
      // M70：并发/排队/公平/取消全部交给渲染调度器；这里只把它要的字段给它。
      const queued = scheduler.enqueue({
        id: job.id,
        projectId: input.projectId,
        kind: 'export',
        priority: Number.isFinite(input.priority) ? Number(input.priority) : 0,
        createdAt: Date.now(),
      });
      if (queued.ok !== true) {
        // 队列拒绝（env 并发越界 / 调度器已关闭）：回滚这次入队，锁立刻放掉。
        jobs.delete(job.id);
        order.pop();
        claim.handle.cancel('queued');
        claim.handle.release();
        log(`EXPORT_QUEUE_REJECT id=${job.id} code=${String(queued.code ?? '')} ${String(queued.message ?? '').slice(0, 160)}`);
        return {
          ok: false,
          code: typeof queued.code === 'string' ? queued.code : 'RENDER_QUEUE_REJECTED',
          message: typeof queued.message === 'string' ? queued.message : '渲染队列拒绝了这次导出',
        };
      }
    }
    log(
      `EXPORT_QUEUED id=${job.id} project=${input.projectId} quality=${quality} ` +
        `target=${path.basename(job.targetPath)} position=${positionOf(job)}`,
    );
    if (scheduler === null) pump();
    return { ok: true, job: snapshot(job) };
  }

  /**
   * 派发一个作业：占槽、迁移 running、跑 runner。
   *
   * 成功/失败/取消的**收尾字段**与 R50 之前逐行相同；唯一的行为变化是**返回的 Promise
   * 会 reject**——`scheduler` 要靠它区分 completed / failed。取消时调度器自己的状态
   * 已经被 `scheduler.cancel()` 先置成 cancelled，所以那个 reject 会被它忽略。
   *
   * @param {ExportJob} job
   */
  function launch(job) {
    transition(job, 'running');
    job.stage = 'plan';
    job.startedAt = new Date().toISOString();
    runningIds.add(job.id);
    log(`EXPORT_START id=${job.id} project=${job.projectId} quality=${job.quality}`);
    const settled = runner(job, job.doc, job.runInput)
      .then((/** @type {any} */ result) => {
        // 自定义 runner 可能自己迁移到 done（老测试就是这么做的）；这里只兜「没迁移」的情况。
        if (job.state === 'running') {
          transition(job, 'done');
          job.result = result;
        }
        if (job.state !== 'done') {
          const error = /** @type {any} */ (new Error(job.error?.message ?? `导出作业结束于 ${job.state}`));
          error.code = job.error?.code ?? 'EXPORT_FAILED';
          throw error;
        }
        return result;
      })
      .catch((/** @type {any} */ error) => {
        // run() 自己会把正常失败写成 failed；这里只兜「run 抛到外面」的意外。
        // 取消也算：只要句柄已 abort 或错误码是 CANCELLED/EXPORT_CANCELLED，就落 cancelled
        // 而不是 failed（否则「点了取消却显示失败」）。
        if (job.state === 'running') {
          const code = codeOf(error);
          if (job.handle.signal.aborted || code === 'CANCELLED' || code === 'EXPORT_CANCELLED') {
            transition(job, 'cancelled');
            job.error = { code: 'CANCELLED', message: '导出已取消' };
          } else {
            transition(job, 'failed');
            job.error = { code, message: String(/** @type {any} */ (error)?.message ?? error) };
          }
        }
        throw error;
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString();
        if (job.state === 'running') {
          transition(job, 'failed');
          job.error = job.error ?? { code: 'EXPORT_FAILED', message: '作业提前结束' };
        }
        // 兜底放锁：正常路径 runExportJob 已经放过（幂等），测试注入的假 runner 不会，
        // 不兜这里会让一个「已完成」的作业永久占着输出。
        job.handle.release();
        runningIds.delete(job.id);
        finished.push(job.id);
        while (finished.length > keepFinished) {
          const oldest = finished.shift();
          if (oldest !== undefined && jobs.get(oldest)?.state !== 'queued' && jobs.get(oldest)?.state !== 'running') {
            jobs.delete(oldest);
          } else if (oldest !== undefined) {
            // 排队的作业不能被「已完成裁剪」删掉：放回去，下一轮再裁。
            finished.unshift(oldest);
            break;
          }
        }
        // 串行模式（没有调度器）下，前面结束了队首接着开工；接了调度器时这是 no-op。
        pump();
      });
    return settled;
  }

  /**
   * 队首开工。**串行**：只在没有 running 时取一个 queued。
   *
   * M70 起这只在「没有调度器」时生效（单测/无队列宿主）；Studio 里并发由
   * `packages/render/scheduler.mjs` 决定，`pump()` 什么都不做。
   */
  function pump() {
    if (scheduler !== null) return;
    if (runningIds.size > 0) return;
    /** @type {ExportJob|null} */
    let next = null;
    for (const id of order) {
      const item = jobs.get(id);
      if (item !== undefined && item.state === 'queued') {
        next = item;
        break;
      }
    }
    if (next === null) return;
    void launch(next).catch(() => {});
  }

  /**
   * 调度器的执行体（M70）：按队列任务 id 找到导出作业并真正开跑。
   *
   * 找不到 = 队列里有一条没有对应作业的陈旧记录（进程重启后又被入队？）：
   * 抛 `QUEUE_JOB_ORPHANED` 让调度器把它记成 failed，而不是静默占着并发槽。
   *
   * @param {any} queueJob
   * @param {{signal?: AbortSignal}} [ctx]
   */
  async function runScheduled(queueJob, ctx = {}) {
    const id = typeof queueJob?.id === 'string' ? queueJob.id : '';
    const job = jobs.get(id);
    if (job === undefined) {
      const error = /** @type {any} */ (new Error(`队列任务没有对应的导出作业：${id}`));
      error.code = 'QUEUE_JOB_ORPHANED';
      throw error;
    }
    if (job.state !== 'queued') return { id, skipped: job.state };
    // 调度器关闭时 abort 的是**队列的** signal：把它桥到作业句柄上，ffmpeg 才会真的停。
    const signal = ctx?.signal;
    const onAbort = () => job.handle.cancel('shutdown');
    if (signal !== undefined && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      await launch(job);
      return { id, state: job.state };
    } finally {
      if (signal !== undefined && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
    }
  }

  /**
   * 接上渲染调度器（M70）。调用后：
   * - `start()` 只入队，不自己开工；`pump()` 变成 no-op；
   * - 队列里「重启前还在跑」的任务被采纳成 `failed(EXPORT_INTERRUPTED)`，
   *   `/api/export/:id` 能查到它（不自动重跑）。
   *
   * @param {any} queue `render-queue.mjs` 的实例
   */
  function attachScheduler(queue) {
    scheduler = queue;
    const ready = queue !== null && typeof queue === 'object' && queue.ready && typeof queue.ready.then === 'function' ? queue.ready : Promise.resolve();
    void Promise.resolve(ready)
      .then(() => {
        adoptInterrupted();
      })
      .catch((/** @type {any} */ error) => {
        log(`EXPORT_RECOVER_FAILED ${String(error?.message ?? error)}`);
      });
  }

  /**
   * 采纳「进程重启前未完成」的任务：状态进 failed，**不重跑**。
   * @returns {{adopted: string[]}}
   */
  function adoptInterrupted() {
    if (scheduler === null) return { adopted: [] };
    const recovery = typeof scheduler.recovery === 'function' ? scheduler.recovery() : { interrupted: [] };
    /** @type {string[]} */
    const adopted = [];
    for (const id of recovery.interrupted ?? []) {
      if (typeof id !== 'string' || id === '' || jobs.has(id)) continue;
      const stale = typeof scheduler.get === 'function' ? scheduler.get(id) : null;
      const createdAt = Number.isFinite(stale?.createdAt) ? Number(stale.createdAt) : Date.now();
      const startedAt = Number.isFinite(stale?.startedAt) ? Number(stale.startedAt) : null;
      const now = new Date().toISOString();
      /** @type {any} */
      const job = {
        id,
        projectId: typeof stale?.projectId === 'string' ? stale.projectId : '',
        projectDir: '',
        state: 'failed',
        stage: 'queued',
        percent: 0,
        frames: 0,
        framesTotal: 0,
        outDir: '',
        quality: 'standard',
        codec: 'h264',
        range: null,
        ranges: null,
        size: null,
        fit: null,
        fps: 30,
        outputSize: null,
        deliveryScale: null,
        deliveryVf: null,
        stageSize: null,
        output: null,
        error: { code: 'EXPORT_INTERRUPTED', message: '进程中断：导出未完成，不自动重跑' },
        queuedAt: new Date(createdAt).toISOString(),
        startedAt: startedAt === null ? null : new Date(startedAt).toISOString(),
        finishedAt: now,
        handle: { signal: new AbortController().signal, cancel() {}, release() {}, on() {} },
        targetPath: '',
        lockPath: '',
        basePath: null,
        subtitleBurn: false,
        subtitleSrc: '',
        subtitleFile: '',
        subtitleCues: [],
        subtitle: null,
        artifacts: [],
        doc: null,
        bands: exportBandsFor({ scenes: false, burn: false }),
        cancelRequested: false,
        phase: null,
        progress: null,
        events: [],
        cancelTooLate: false,
        stateLog: [{ at: now, state: 'failed' }],
      };
      jobs.set(id, job);
      order.unshift(id);
      adopted.push(id);
    }
    if (adopted.length > 0) log(`EXPORT_RECOVERED_INTERRUPTED ${adopted.length} ${adopted.join(',')}`);
    return { adopted };
  }

  /** @param {string} id */
  function status(id) {
    const job = jobs.get(id);
    return job === undefined ? null : snapshot(job);
  }

  /**
   * 取消。三种情况**真的不一样**：
   * - `queued`：还没开工 → 句柄 cancel + **立即放锁** → `cancelled`，它永远不会跑
   *   （不是「开工后立刻取消」）。
   * - `running`：只调 `handle.cancel('user')`。真正停 ffmpeg 的是渲染链路里听
   *   `handle.signal` 的 `runFfmpeg`（SIGTERM→SIGKILL）；`runExportJob` 的 finally 放锁。
   *   这里**没有**第二条 kill 路径。
   * - 终态：原样返回（幂等）。
   * @param {string} id
   */
  function cancel(id) {
    const job = jobs.get(id);
    if (job === undefined) return null;
    if (job.state === 'queued') {
      job.cancelRequested = true;
      // 先让调度器摘队（同步生效），再放输出锁：取消后不能还占着输出挡住下一次导出。
      if (scheduler !== null) void Promise.resolve(scheduler.cancel(id)).catch(() => {});
      job.handle.cancel('queued');
      job.handle.release();
      transition(job, 'cancelled');
      job.finishedAt = new Date().toISOString();
      job.error = { code: 'CANCELLED', message: '排队时已取消（未开工）' };
      log(`EXPORT_CANCEL id=${id} state=queued`);
      return snapshot(job);
    }
    if (job.state === 'running') {
      job.cancelRequested = true;
      job.handle.cancel('user');
      // 队列侧同步置 cancelled 并 abort（槽位由调度器在 runner settle 后释放）。
      if (scheduler !== null) void Promise.resolve(scheduler.cancel(id)).catch(() => {});
      log(`EXPORT_CANCEL id=${id} state=running`);
    }
    return snapshot(job);
  }

  return {
    start,
    status,
    cancel,
    /** M70：接渲染调度器（入队/回写/恢复采纳）。 */
    attachScheduler,
    /** M70：调度器的执行体（runner 由 `render-queue.mjs` 透传）。 */
    runScheduled,
    /** M70：采纳「重启前未完成」的任务（attachScheduler 会自动调；测试可直接调）。 */
    adoptInterrupted,
    /** 状态迁移表（交接里要逐条写清楚，所以直接从这里导出）。 */
    transitions: EXPORT_TRANSITIONS,
    /**
     * @param {string} id
     * @returns {any}
     */
    snapshot: (id) => (jobs.has(id) ? snapshot(/** @type {ExportJob} */ (jobs.get(id))) : null),
    running: () => {
      const first = runningIds.values().next();
      return first.done === true ? null : status(String(first.value));
    },
    /** 全量快照，**入队顺序**（不是完成顺序）：UI 的队列视图直接用这个。 */
    list: () =>
      order
        .map((id) => jobs.get(id))
        .filter((job) => job !== undefined)
        .map((job) => snapshot(/** @type {ExportJob} */ (job))),
    /** 队列摘要：running / queued 数量与队首 id。 */
    summary: () => {
      const all = order
        .map((id) => jobs.get(id))
        .filter((job) => job !== undefined);
      const queued = all.filter((job) => job.state === 'queued');
      const firstRunning = runningIds.values().next();
      return {
        running: firstRunning.done === true ? null : String(firstRunning.value),
        queued: queued.length,
        next: queued.length > 0 ? (queued[0]?.id ?? null) : null,
        total: all.length,
      };
    },
    /**
     * 进程内已占用的输出（作业句柄的 `activeOutputClaims()`，只读诊断）。
     * GET /api/export 带一份：`EXPORT_OUTPUT_BUSY` 的持有者能在这里对上。
     */
    claims: () => activeOutputClaims(),
  };
}

/**
 * 写 `<base>.spec.json`（M78）——只有带 `sequence` 的导出才写。
 *
 * 为什么不给 main 也写：`exports/` 里多一个文件就是一次可见的回归（老脚本按文件名/数量断言）。
 * 序列导出的产物本来就要能回答「这是哪个序列、哪一版 film.html」，所以只给它们补这份 spec。
 *
 * @param {any} job @param {{ path: string, bytes: number, sha256: string }} placed @param {any[]} artifacts
 */
async function writeExportSpec(job, placed, artifacts) {
  const base = path.basename(String(job.basePath ?? job.targetPath));
  const stem = base.replace(/\.(mp4|mov|webm|mkv)$/i, '');
  const file = path.join(path.dirname(String(job.targetPath)), `${stem}.spec.json`);
  const spec = {
    version: 1,
    kind: 'opencut-export-spec',
    jobId: job.id,
    projectId: job.projectId,
    sequence: job.sequence,
    ...(job.clipId ? { clipId: job.clipId } : {}),
    filmHtmlSha256: job.docHash ?? null,
    stage: job.stageSize ?? null,
    fps: job.fps,
    quality: job.quality,
    codec: job.codec,
    range: job.range,
    ranges: job.ranges,
    size: job.size,
    fit: job.fit,
    output: placed,
    artifacts: artifacts.map((/** @type {any} */ item) => ({
      kind: item.kind,
      path: item.path,
      bytes: item.bytes,
      sha256: item.sha256,
    })),
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(file, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
  return file;
}
