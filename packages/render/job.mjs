/**
 * 渲染作业状态机（WP10）。
 *
 * waiting → running → done | failed | cancelled
 * 同一队列内串行执行；cancel 对 waiting 立即生效，对 running 触发 abort。
 *
 * 与合同的一处显式扩展：
 * - `render.ts` 的错误码里没有「工程在渲染中被改」。本批在 expectedHash 之外
 *   增加 **PROJECT_CHANGED**（起点与提交前各校验一次）。它不属于 v1.0.0 的
 *   RenderErrorCode，需大脑在合同 v1.1 决定是否收编；这里先如实返回，不硬塞
 *   进 INVALID_RANGE。
 * - `ranges` 多段（1..100）自 P47 起身为正式能力：队列按段切窗口，与 `export film`
 *   的 `--range` 走同一套 `planFromFilm` 语义。
 * - P47 起作业白名单扩到 h264/hevc/prores422hq/prores4444 × draft/standard/high ×
 *   off/streaming/broadcast，并可带 subtitleBurn/subtitleStyle；alpha 仍明确拒绝
 *   （ALPHA_REQUIRES_STAGE，作业管线还没有舞台取帧）。
 *
 * @typedef {import('../../contracts/render').RenderJobSpec} RenderJobSpec
 * @typedef {import('../../contracts/render').RenderProgress} RenderProgress
 * @typedef {import('../../contracts/render').RenderOutput} RenderOutput
 * @typedef {import('../../contracts/render').RenderErrorCode} RenderErrorCode
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { computeRenderBudget } from './budget.mjs';
import { muxWithVideo, renderMix, validateAudioMixSpec } from './audio-mix.mjs';
import { RenderFailure, commitOutput, encodeVideo } from './ffmpeg.mjs';
import { frameTimes, produceFrames } from './frames.mjs';
import { durationOfFrames, frameCountAt, parseFps, rateOfFps } from './fps.mjs';
import { fileDigest, verifyOutput } from './verify.mjs';

/**
 * @typedef {Object} FrameSource
 * @property {string} [dir]
 * @property {string} [pattern]
 * @property {number} width
 * @property {number} height
 * @property {number} fps
 * @property {number} durationSec
 * @property {(timeSec: number, ctx: { index: number, attempt: number }) => Promise<Buffer | Uint8Array | { path: string } | { data: Buffer }>} [frameAt]
 * @property {number[]} [times]
 */

/**
 * @typedef {Object} Job
 * @property {RenderJobSpec} spec
 * @property {'waiting' | 'running' | 'done' | 'failed' | 'cancelled'} state
 * @property {string} [stage]
 * @property {number} framesDone
 * @property {number} framesTotal
 * @property {{ num: number, den: number, value: number, arg: string }} [fpsRate] 本次作业的有理帧率（P44）
 * @property {number} [startFrame] 区间起点所在的帧号（0 基）
 * @property {number} [durationSec] 实际编码的段长（frames×den/num）
 * @property {number} [measuredFps]
 * @property {number} [etaSec]
 * @property {number} startedAt
 * @property {number} [finishedAt]
 * @property {RenderOutput} [output]
 * @property {RenderErrorCode | 'PROJECT_CHANGED'} [errorCode]
 * @property {string} [errorDetail]
 * @property {AbortController} controller
 * @property {boolean} cancelledBeforeStart
 * @property {Promise<void>} done
 * @property {() => void} resolveDone
 * @property {any} [audioMix] 本次作业要先混音的显式时间线（P10）；有它就不走 resolveAudio
 * @property {{ clips: number, durationSec: number, peak: number }} [audioReport]
 * @property {import('../../contracts/render').RenderBudget} [budget]
 * @property {number} [workers]
 * @property {boolean} projectChanged
 * @property {'film' | 'spec'} [audioSource] 音轨来源（P14：film = 从 film.html 推导）
 * @property {number[]} [completionOrder]
 * @property {string} [framesDir]
 */

/**
 * @typedef {Object} HostInfo
 * @property {number} cpu
 * @property {number} freeMemBytes
 */

/* P47：作业管线能接的编码/质量/响度。三张表与 `export film` 的 CLI 值域同源：
   codec 来自 codec-matrix 的 CODEC_NAMES（去掉本批不支持的 vp9/png/hevc_alpha），
   quality 来自 quality.mjs 的三档，loudness 来自 loudness.mjs 的三档。
   写成常量而不是每次 inline，是为了让「作业能做什么」一眼可见。 */
export const JOB_CODECS = Object.freeze(['h264', 'hevc', 'prores422hq', 'prores4444']);
export const JOB_QUALITIES = Object.freeze(['draft', 'standard', 'high']);
export const JOB_LOUDNESS = Object.freeze(['off', 'streaming', 'broadcast']);

export class RenderQueue {
  /** @type {(projectId: string) => string} */
  #resolveProject;
  /** @type {(spec: RenderJobSpec) => Promise<FrameSource> | FrameSource} */
  #resolveFrameSource;
  /** @type {(spec: RenderJobSpec) => Promise<string | null> | string | null} */
  #resolveAudio;
  #ffmpegPath;
  #ffprobePath;
  #preset;
  #crf;
  /** @type {((spec: RenderJobSpec) => 'ENOSPC' | null) | null} */
  #injectFault;
  /** @type {(() => HostInfo) | null} */
  #hostInfo;
  #projectCheckEveryFrames;
  /** @type {Map<string, Job>} */
  #jobs = new Map();
  /** @type {Promise<void>} */
  #tail = Promise.resolve();

  /**
   * @param {{
   *   resolveProject: (projectId: string) => string,
   *   resolveFrameSource: (spec: RenderJobSpec) => Promise<FrameSource> | FrameSource,
   *   resolveAudio?: (spec: RenderJobSpec) => Promise<string | null> | string | null,
   *   ffmpegPath?: string,
   *   ffprobePath?: string,
   *   preset?: string,
   *   crf?: number,
   *   injectFault?: (spec: RenderJobSpec) => 'ENOSPC' | null,
   *   hostInfo?: () => HostInfo,
   *   projectCheckEveryFrames?: number,
   * }} opts
   */
  constructor(opts) {
    if (typeof opts?.resolveProject !== 'function') throw new TypeError('resolveProject required');
    if (typeof opts?.resolveFrameSource !== 'function') throw new TypeError('resolveFrameSource required');
    this.#resolveProject = opts.resolveProject;
    this.#resolveFrameSource = opts.resolveFrameSource;
    this.#resolveAudio = opts.resolveAudio ?? (() => null);
    this.#ffmpegPath = opts.ffmpegPath ?? 'ffmpeg';
    this.#ffprobePath = opts.ffprobePath ?? 'ffprobe';
    this.#preset = opts.preset ?? 'medium';
    this.#crf = opts.crf ?? 20;
    this.#injectFault = opts.injectFault ?? null;
    this.#hostInfo = opts.hostInfo ?? null;
    this.#projectCheckEveryFrames = Math.max(1, Math.floor(opts.projectCheckEveryFrames ?? 120));
  }

  /**
   * @param {RenderJobSpec} spec
   * @param {{ audioMix?: any, audioSource?: 'film' | 'spec' }} [opts]
   *   `audioMix`：作业先用显式时间线混出 mix.wav，再入渲染；
   *   `audioSource`：这条时间线从哪来（写进 progress，便于区分 film 推导与调用方给的）
   * @returns {{ jobId: string } | { error: RenderErrorCode | 'PROJECT_CHANGED' | 'INVALID_FPS' | 'ALPHA_REQUIRES_STAGE' | 'INVALID', detail?: string }}
   */
  enqueue(spec, opts = {}) {
    const validation = validateSpec(spec);
    if (validation) return validation;
    if (opts.audioMix !== undefined) {
      const bad = validateAudioMixSpec(opts.audioMix);
      if (bad) return { error: 'INVALID_RANGE', detail: `audioMix: ${bad}` };
      if (spec.audio === false) return { error: 'INVALID_RANGE', detail: 'audioMix conflicts with audio:false' };
    }
    if (this.#jobs.has(spec.jobId)) {
      return { error: 'FRAME_FAILED', detail: `duplicate jobId: ${spec.jobId}` };
    }

    /** @type {Job} */
    const job = {
      spec,
      state: 'waiting',
      framesDone: 0,
      framesTotal: framesTotalOf(spec),
      startedAt: 0,
      controller: new AbortController(),
      cancelledBeforeStart: false,
      done: Promise.resolve(),
      resolveDone: () => {},
      projectChanged: false,
      ...(opts.audioMix !== undefined ? { audioMix: opts.audioMix } : {}),
      ...(opts.audioSource !== undefined ? { audioSource: opts.audioSource } : {}),
    };
    job.done = new Promise((resolve) => {
      job.resolveDone = resolve;
    });
    this.#jobs.set(spec.jobId, job);

    this.#tail = this.#tail.then(() => this.#run(job)).catch(() => {});
    return { jobId: spec.jobId };
  }

  /**
   * @param {string} jobId
   * @returns {RenderProgress & { error?: RenderErrorCode | 'PROJECT_CHANGED', detail?: string, audio?: { clips: number, durationSec: number, peak: number },
   *   fpsRational?: { num: number, den: number }, startFrame?: number, durationSec?: number }}
   */
  progress(jobId) {
    const job = this.#jobs.get(jobId);
    if (!job) {
      return { jobId, state: 'failed' };
    }
    return {
      jobId,
      state: job.state,
      ...(job.stage ? { stage: job.stage } : {}),
      framesDone: job.framesDone,
      framesTotal: job.framesTotal,
      ...(job.measuredFps !== undefined ? { fps: round(job.measuredFps, 2) } : {}),
      ...(job.etaSec !== undefined ? { etaSec: Math.max(0, Math.round(job.etaSec)) } : {}),
      ...(job.budget ? { budget: job.budget } : {}),
      /* P44：时间线帧率与区间起点。`fps` 那个字段是**实测编码速度**（framesDone/elapsed），
         不是时间线帧率——两者同名不同义，所以这里另给 fpsRational + startFrame + durationSec。 */
      ...(job.fpsRate ? { fpsRational: { num: job.fpsRate.num, den: job.fpsRate.den } } : {}),
      ...(job.startFrame !== undefined ? { startFrame: job.startFrame } : {}),
      ...(job.durationSec !== undefined ? { durationSec: job.durationSec } : {}),
      // 失败时把错误码带出来：HTTP 客户端不靠猜 state 判断该换素材还是查渲染器
      ...(job.errorCode ? { error: job.errorCode } : {}),
      ...(job.errorDetail ? { detail: job.errorDetail } : {}),
      ...(job.audioReport ? { audio: job.audioReport } : {}),
    };
  }

  /**
   * @param {string} jobId
   * @returns {Promise<void>}
   */
  async cancel(jobId) {
    const job = this.#jobs.get(jobId);
    if (!job) return;
    if (job.state === 'done' || job.state === 'failed' || job.state === 'cancelled') return;

    if (job.state === 'waiting') {
      job.cancelledBeforeStart = true;
      job.state = 'cancelled';
      job.finishedAt = Date.now();
      job.resolveDone();
      return;
    }

    job.controller.abort();
    await job.done;
  }

  /**
   * @param {string} jobId
   * @returns {Promise<RenderOutput | { error: RenderErrorCode | 'PROJECT_CHANGED', detail?: string }>}
   */
  async result(jobId) {
    const job = this.#jobs.get(jobId);
    if (!job) throw new Error(`UNKNOWN_JOB: ${jobId}`);
    await job.done;
    if (job.state === 'done' && job.output) return job.output;
    if (job.state === 'cancelled') return { error: 'CANCELLED' };
    return { error: job.errorCode ?? 'FRAME_FAILED', ...(job.errorDetail ? { detail: job.errorDetail } : {}) };
  }

  /** 等队列清空（测试/关闭用）。 */
  async idle() {
    await this.#tail;
  }

  /**
   * @param {string} jobId
   * @returns {boolean}
   */
  has(jobId) {
    return this.#jobs.has(jobId);
  }

  /**
   * 观测用：预算、实际并行度、完成顺序、工程是否中途变化。
   * @param {string} jobId
   * @returns {null | { budget?: import('../../contracts/render').RenderBudget, workers?: number, completionOrder?: number[], projectChanged: boolean, stage?: string }}
   */
  inspectJob(jobId) {
    const job = this.#jobs.get(jobId);
    if (!job) return null;
    return {
      ...(job.budget ? { budget: job.budget } : {}),
      ...(job.workers !== undefined ? { workers: job.workers } : {}),
      ...(job.completionOrder ? { completionOrder: [...job.completionOrder] } : {}),
      projectChanged: job.projectChanged,
      ...(job.stage ? { stage: job.stage } : {}),
    };
  }

  /**
   * @param {Job} job
   * @returns {Promise<void>}
   */
  async #run(job) {
    if (job.cancelledBeforeStart) {
      job.resolveDone();
      return;
    }

    const { spec } = job;
    job.state = 'running';
    job.stage = 'validate';
    job.startedAt = Date.now();

    /** @type {string} */
    let partialPath = '';
    /** @type {string} */
    let framesDirToClean = '';
    /** @type {string} */
    let mixDirToClean = '';
    /** @type {string} */
    let videoOnlyPartial = '';
    try {
      const projectRoot = this.#resolveProject(spec.projectId);
      const startHash = await hashProject(projectRoot);
      if (startHash !== spec.expectedHash) {
        throw new RenderFailure(
          'PROJECT_CHANGED',
          'project hash does not match expectedHash at start; refusing to render a stale project',
        );
      }

      const source = await this.#resolveFrameSource(spec);
      if (!source || (!source.dir && typeof source.frameAt !== 'function')) {
        throw new RenderFailure('FRAME_FAILED', 'no frame source');
      }
      const fps = spec.fps ?? source.fps;
      if (!Number.isFinite(fps) || Math.abs(fps - source.fps) > 0.001) {
        throw new RenderFailure(
          'CODEC_UNAVAILABLE',
          `fps conversion not supported in this batch (spec ${fps}, source ${source.fps})`,
        );
      }
      /* P44：`spec.fps` 的外部形状还是数字（29.97 / 30），内部一律换成有理数。
         帧数、时长、起始帧号、逐帧时间全走整数运算——与 `export film` 同一套
         `fps.mjs`，不再出现「一条路 30000/1001、另一条路 29.97」的双解析器。 */
      const rate = rateOfFps(fps);

      // 音频来源二选一：显式 audioMix（先混音，阶段 audio）或宿主给的现成音轨（resolveAudio）。
      /** @type {string | null} */
      let audioPath = null;
      const needsMuxStage = job.audioMix !== undefined;
      if (job.audioMix !== undefined) {
        job.stage = 'audio';
        // 每个作业独立临时目录：并发队列里两份 mix.wav 不互相覆盖
        mixDirToClean = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-mix-'));
        const mixed = await renderMix(job.audioMix, {
          outWav: path.join(mixDirToClean, 'mix.wav'),
          signal: job.controller.signal,
        });
        audioPath = mixed.path;
        job.audioReport = {
          clips: mixed.report.clips.length,
          durationSec: mixed.report.durationSec,
          peak: mixed.report.peak,
          // 只在有来源时出现：P10 的显式 audioMix 仍旧是 {clips,durationSec,peak}
          ...(job.audioSource ? { source: job.audioSource } : {}),
        };
      } else {
        audioPath = spec.audio === false ? null : await this.#resolveAudio(spec);
        if (spec.audio !== false && !audioPath) {
          throw new RenderFailure('AUDIO_MISSING', 'film has no audio track; pass audio:false for silent output');
        }
      }

      const range = currentRange(spec);
      /* 帧数 / 时长 / 起始帧号：`round(t×num/den)`、`frames×den/num`。
         整数帧率下与老表达式（`round(t×fps)`、`frames/fps`、`round(start×fps)+1`）
         逐位相同——30fps 的产物 sha 就是这么守住的。 */
      let frames = Math.max(1, frameCountAt(rate, range[1] - range[0]));
      let durationSec = durationOfFrames(rate, frames);
      let startNumber = Math.round((range[0] * rate.num) / rate.den) + 1;
      let startFrame = startNumber - 1;
      job.framesTotal = frames;
      job.fpsRate = rate;
      job.startFrame = startFrame;
      job.durationSec = durationSec;

      // 自动并行预算：用户值优先，否则按 CPU/内存/帧数算，并落 basis。
      const host = this.#hostInfo ? this.#hostInfo() : defaultHostInfo();
      const userWorkers = spec.budget?.workers;
      const budget = computeRenderBudget({
        cpu: host.cpu,
        freeMemBytes: host.freeMemBytes,
        frames,
        ...(userWorkers !== undefined ? { userWorkers } : {}),
      });
      job.budget = budget;
      job.workers = budget.workers;

      /** @type {string} */
      const outputDir = spec.outputDir;
      await fs.mkdir(outputDir, { recursive: true });
      const baseName = `${sanitize(spec.projectId)}-${spec.kind}`;
      const desiredPath = path.join(outputDir, `${baseName}.mp4`);
      const uniqueDesired = await pickFreeName(desiredPath);
      partialPath = uniqueDesired.replace(/\.mp4$/, '.partial.mp4');

      /** @type {string} */
      let framesDir = source.dir ?? '';
      /** @type {string} */
      let framePattern = source.pattern ?? 'frame-%05d.png';

      // 依赖注入路径：帧由上游 frameAt 生产，本层只负责并行与按序落盘。
      if (typeof source.frameAt === 'function') {
        framesDir = path.join(outputDir, `.frames-${sanitize(spec.jobId)}`);
        framesDirToClean = framesDir;
        framePattern = 'frame-%05d.png';
        job.stage = 'frames';
        const times = source.times ?? frameTimes({ startSec: range[0], endSec: range[1], fps: rate });
        frames = times.length;
        durationSec = durationOfFrames(rate, frames);
        startNumber = 1;
        startFrame = 0;
        job.framesTotal = frames;
        job.startFrame = startFrame;
        job.durationSec = durationSec;
        const produced = await produceFrames({
          frameAt: source.frameAt,
          times,
          workers: budget.workers,
          outDir: framesDir,
          pattern: framePattern,
          startNumber,
          signal: job.controller.signal,
          checkEveryFrames: this.#projectCheckEveryFrames,
          checkProject: async () => (await hashProject(projectRoot)) === spec.expectedHash,
          onProgress: (done, total) => {
            job.framesDone = done;
            job.framesTotal = total;
          },
        });
        job.completionOrder = produced.completionOrder;
      }

      job.stage = 'encode';
      const encodeStarted = Date.now();
      /** @type {{ at: number, running: boolean }} */
      const projectCheck = { at: 0, running: false };
      /**
       * @param {number} framesDone
       */
      const checkProjectDuringEncode = (framesDone) => {
        if (projectCheck.running || job.projectChanged) return;
        if (framesDone - projectCheck.at < this.#projectCheckEveryFrames) return;
        projectCheck.at = framesDone;
        projectCheck.running = true;
        void hashProject(projectRoot)
          .then((hash) => {
            if (hash !== spec.expectedHash && !job.projectChanged) {
              job.projectChanged = true;
              job.controller.abort();
            }
          })
          .catch(() => {
            /* 读盘失败让编码自己报错，不在这里吞掉 */
          })
          .finally(() => {
            projectCheck.running = false;
          });
      };

      // 有 audioMix 时先出无声画面，再单独 mux：这样 audio / mux 两个阶段都是真的，
      // 而且复用 P9 的「双流同长」规则（-shortest 的旧缺陷不会从这条路径回来）。
      const encodePartial = needsMuxStage ? partialPath.replace(/\.partial\.mp4$/, '.video.partial.mp4') : partialPath;
      if (needsMuxStage) videoOnlyPartial = encodePartial;
      await encodeVideo({
        framesDir,
        framePattern,
        audioPath: needsMuxStage ? undefined : audioPath ?? undefined,
        width: source.width,
        height: source.height,
        fps,
        fpsArg: rate.arg,
        durationSec,
        startNumber,
        frameCount: frames,
        audioStartSec: range[0],
        partialPath: encodePartial,
        ffmpegPath: this.#ffmpegPath,
        preset: this.#preset,
        crf: this.#crf,
        threads: budget.workers,
        signal: job.controller.signal,
        injectFault: this.#injectFault?.(spec) ?? null,
        onProgress: (p) => {
          const elapsed = (Date.now() - encodeStarted) / 1000;
          job.framesDone = Math.min(p.framesDone, frames);
          if (elapsed > 0.2) {
            job.measuredFps = job.framesDone / elapsed;
            job.etaSec = job.measuredFps > 0 ? (frames - job.framesDone) / job.measuredFps : undefined;
          }
          checkProjectDuringEncode(job.framesDone);
        },
      });

      if (needsMuxStage && audioPath) {
        job.stage = 'mux';
        await muxWithVideo(encodePartial, audioPath, partialPath, {
          ffmpegPath: this.#ffmpegPath,
          ffprobePath: this.#ffprobePath,
          signal: job.controller.signal,
        });
        await fs.unlink(encodePartial).catch(() => {});
        videoOnlyPartial = '';
      }

      if (job.projectChanged) {
        throw new RenderFailure('PROJECT_CHANGED', 'project changed during render; output discarded');
      }

      // 提交前再校验一次：渲染中被改工程 → 丢弃成品。
      const endHash = await hashProject(projectRoot);
      if (endHash !== spec.expectedHash) {
        throw new RenderFailure(
          'PROJECT_CHANGED',
          'project changed during render; output discarded',
        );
      }

      job.stage = 'verify';
      const expected = {
        videoCodec: 'h264',
        width: source.width,
        height: source.height,
        fps: rate.value,
        durationSec,
        durationToleranceSec: Math.max(1 / rate.value, 0.1),
        ...(audioPath
          ? { audioCodec: 'aac', channels: 2, sampleRate: 48000, requireAudio: true }
          : {}),
      };
      const verified = await verifyOutput(partialPath, expected, {
        ffmpegPath: this.#ffmpegPath,
        ffprobePath: this.#ffprobePath,
      });
      if (!verified.ok || !verified.probe) {
        await fs.unlink(partialPath).catch(() => {});
        throw new RenderFailure(
          'OUTPUT_UNVERIFIED',
          verified.mismatches.map((m) => `${m.field}: ${String(m.actual)} != ${String(m.expected)}`).join('; '),
        );
      }

      job.stage = 'commit';
      const finalPath = await commitOutput(partialPath, uniqueDesired);
      partialPath = '';
      const digest = await fileDigest(finalPath);
      const probe = verified.probe;
      job.output = {
        path: finalPath,
        bytes: digest.bytes,
        sha256: digest.sha256,
        probe: {
          ...(probe.video?.codec ? { videoCodec: probe.video.codec } : {}),
          ...(probe.video?.width !== null && probe.video?.width !== undefined
            ? { width: probe.video.width }
            : {}),
          ...(probe.video?.height !== null && probe.video?.height !== undefined
            ? { height: probe.video.height }
            : {}),
          ...(probe.video?.fps ? { fps: probe.video.fps } : {}),
          ...(probe.video?.durationSec !== null && probe.video?.durationSec !== undefined
            ? { durationSec: probe.video.durationSec }
            : {}),
          ...(probe.audio?.codec ? { audioCodec: probe.audio.codec } : {}),
          ...(probe.audio?.channels !== null && probe.audio?.channels !== undefined
            ? { channels: probe.audio.channels }
            : {}),
          ...(probe.audio?.sampleRate !== null && probe.audio?.sampleRate !== undefined
            ? { sampleRate: probe.audio.sampleRate }
            : {}),
        },
      };
      job.state = 'done';
      job.stage = 'done';
      job.framesDone = frames;
      job.finishedAt = Date.now();
    } catch (err) {
      const failure =
        err instanceof RenderFailure
          ? err
          : new RenderFailure('FRAME_FAILED', err instanceof Error ? err.message : String(err));

      if (partialPath) await fs.unlink(partialPath).catch(() => {});
      if (videoOnlyPartial) await fs.unlink(videoOnlyPartial).catch(() => {});

      if (job.projectChanged || failure.code === 'PROJECT_CHANGED') {
        job.state = 'failed';
        job.errorCode = 'PROJECT_CHANGED';
        job.errorDetail = failure.detail;
        job.stage = 'failed';
      } else if (job.controller.signal.aborted) {
        job.state = 'cancelled';
        job.errorCode = 'CANCELLED';
        job.stage = 'cancelled';
      } else {
        job.state = 'failed';
        job.errorCode = failure.code;
        job.errorDetail = failure.detail;
        job.stage = 'failed';
      }
      job.finishedAt = Date.now();
    } finally {
      if (framesDirToClean) await fs.rm(framesDirToClean, { recursive: true, force: true }).catch(() => {});
      // mix.wav 是作业内部中间件：成功/失败/取消都不留
      if (mixDirToClean) await fs.rm(mixDirToClean, { recursive: true, force: true }).catch(() => {});
      job.resolveDone();
    }
  }
}

/**
 * `spec.fps` 的校验（P44）：不合法就给出**人读的原因**，合法返回 null。
 *
 * 为什么单独一个函数：`validateSpec`（建作业前）和 CLI 的 `export start`
 * （连 dry-run 也要先拦）必须用同一套判据，否则会出现「dry-run 通过、真跑拒绝」
 * 或者两个入口给出不同的错误码。上限 120 是 job 这条路径的历史口径，比 `fps.mjs`
 * 的 240 更严——这里不改宽，只把**错误码**统一成 INVALID_FPS。
 *
 * @param {unknown} fps
 * @returns {string | null}
 */
export function specFpsProblem(fps) {
  if (fps === undefined || fps === null) return null;
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0 || fps > 120) {
    return `invalid fps: ${String(fps)} (must be a number in (0, 120])`;
  }
  try {
    parseFps(fps);
  } catch (err) {
    return /** @type {any} */ (err)?.detail ?? String(err);
  }
  return null;
}

/**
 * @param {RenderJobSpec} specIn
 * @returns {{ error: RenderErrorCode | 'PROJECT_CHANGED' | 'INVALID_FPS' | 'ALPHA_REQUIRES_STAGE' | 'INVALID', detail?: string } | null}
 */
export function validateSpec(specIn) {
  /* P47：spec 在合同之外还带 subtitleBurn/subtitleStyle/alpha 三个字段（合同 1.2.0/r5
     不改）。这里用 any 视图读它们——合同里没有的三个字段不该让整个类型系统失真。 */
  const spec = /** @type {any} */ (specIn);
  if (!spec || typeof spec !== 'object') return { error: 'FRAME_FAILED', detail: 'spec required' };
  if (
    typeof spec.jobId !== 'string' ||
    typeof spec.projectId !== 'string' ||
    typeof spec.outputDir !== 'string' ||
    typeof spec.expectedHash !== 'string' ||
    spec.jobId.length === 0 ||
    spec.projectId.length === 0 ||
    spec.outputDir.length === 0 ||
    spec.expectedHash.length === 0
  ) {
    return { error: 'FRAME_FAILED', detail: 'jobId/projectId/outputDir/expectedHash are required' };
  }
  if (!['MAIN', 'SUB1', 'SUB2', 'BRAIN'].includes(spec.owner)) {
    return { error: 'FRAME_FAILED', detail: `unknown owner: ${String(spec.owner)}` };
  }
  if (!['video', 'gif', 'audio', 'stills', 'project'].includes(spec.kind)) {
    return { error: 'FRAME_FAILED', detail: `unknown kind: ${String(spec.kind)}` };
  }
  if (!path.isAbsolute(spec.outputDir)) {
    return { error: 'FRAME_FAILED', detail: 'outputDir must be absolute' };
  }
  if (spec.kind !== 'video') {
    return { error: 'CODEC_UNAVAILABLE', detail: `kind ${spec.kind} not supported in this batch` };
  }
  /* P47：作业管线接上 `export film` 已有的能力（编码矩阵 / 三档质量 / 响度）。
     仍然逐个白名单，而不是「有值就放行」——未知值要在**建作业之前**变成
     CODEC_UNAVAILABLE，而不是等 worker 跑到一半才发现。 */
  if (spec.codec !== undefined && !JOB_CODECS.includes(String(spec.codec))) {
    return { error: 'CODEC_UNAVAILABLE', detail: `codec ${spec.codec} not supported in this batch` };
  }
  if (spec.quality !== undefined && !JOB_QUALITIES.includes(String(spec.quality))) {
    return { error: 'CODEC_UNAVAILABLE', detail: `quality ${spec.quality} not supported in this batch` };
  }
  if (spec.loudness !== undefined && !JOB_LOUDNESS.includes(String(spec.loudness))) {
    return { error: 'CODEC_UNAVAILABLE', detail: `loudness ${spec.loudness} not supported in this batch` };
  }
  /* 透明输出（P47 明确不做）：alpha 需要舞台真透明像素，而作业管线还没有舞台取帧。
     保持与 `export film --alpha` 同一个码，别让它退化成 JOB_FAILED。 */
  if (spec.alpha !== undefined && spec.alpha !== false) {
    return { error: 'ALPHA_REQUIRES_STAGE', detail: 'alpha export is not available on the job pipeline yet' };
  }
  if (spec.subtitleBurn !== undefined && typeof spec.subtitleBurn !== 'boolean') {
    return { error: 'INVALID', detail: 'subtitleBurn must be boolean' };
  }
  if (spec.subtitleStyle !== undefined) {
    const style = /** @type {any} */ (spec.subtitleStyle);
    if (style === null || typeof style !== 'object' || Array.isArray(style)) {
      return { error: 'INVALID', detail: 'subtitleStyle must be an object' };
    }
  }
  if (spec.audio !== undefined && typeof spec.audio !== 'boolean') {
    return { error: 'FRAME_FAILED', detail: 'audio must be boolean' };
  }
  if (spec.budget !== undefined) {
    const budget = /** @type {any} */ (spec.budget);
    if (!budget || typeof budget !== 'object' || Array.isArray(budget)) {
      return { error: 'FRAME_FAILED', detail: 'budget must be an object' };
    }
    const unknownBudgetKeys = Object.keys(budget).filter((key) => key !== 'workers');
    if (unknownBudgetKeys.length > 0) {
      return { error: 'FRAME_FAILED', detail: `unknown budget field(s): ${unknownBudgetKeys.join(', ')}` };
    }
    if (budget.workers !== undefined && (!Number.isInteger(budget.workers) || budget.workers < 1)) {
      return { error: 'INVALID_RANGE', detail: 'budget.workers must be an integer >= 1' };
    }
  }
  if (spec.frame !== undefined && spec.frame !== 'native') {
    return { error: 'CODEC_UNAVAILABLE', detail: 'only frame=native is supported in this batch' };
  }
  if (spec.shortEdge !== undefined || spec.fill !== undefined) {
    return { error: 'CODEC_UNAVAILABLE', detail: 'shortEdge/fill not supported in this batch' };
  }
  if (spec.fps !== undefined) {
    /* P44：帧率错误统一走 INVALID_FPS（与 `export film` 同一套码、同一个退出码 2）。
       以前这里返回 INVALID_RANGE —— 同一件事两个码，脚本要分两支。 */
    const problem = specFpsProblem(spec.fps);
    if (problem) return { error: 'INVALID_FPS', detail: problem };
  }

  const hasRange = spec.range !== undefined;
  const hasRanges = spec.ranges !== undefined;
  if (hasRange && hasRanges) {
    return { error: 'INVALID_RANGE', detail: 'range and ranges are mutually exclusive' };
  }
  /* 两个都不给 = **整片**（与 `export film` 不传 --range 同义）。
     P47 之前这里要求「必须给一个」；作业管线要能跑整片，这条改成可选。 */
  if (!hasRange && !hasRanges) return null;

  /** @type {Array<readonly [number, number]>} */
  const ranges = hasRange ? [spec.range] : [...(spec.ranges ?? [])];
  if (ranges.length === 0 || ranges.length > 100) {
    return { error: 'INVALID_RANGE', detail: `ranges count ${ranges.length} not in 1..100` };
  }
  for (const range of ranges) {
    if (!Array.isArray(range) || range.length !== 2) {
      return { error: 'INVALID_RANGE', detail: 'range must be [start, end]' };
    }
    const [start, end] = range;
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)) {
      return { error: 'INVALID_RANGE', detail: 'range bounds must be finite numbers' };
    }
    if (start < 0) return { error: 'INVALID_RANGE', detail: 'range start must be >= 0' };
    if (end <= start) return { error: 'INVALID_RANGE', detail: `range end (${end}) must be > start (${start})` };
  }
  return null;
}

/** @param {RenderJobSpec} spec @returns {readonly [number, number]} */
function currentRange(spec) {
  if (spec.range) return spec.range;
  const first = spec.ranges?.[0];
  if (!first) throw new RenderFailure('INVALID_RANGE', 'no range');
  return first;
}

/** @param {RenderJobSpec} spec @returns {number} */
function framesTotalOf(spec) {
  // P44：建作业时就要给出 total（UI 一进队列就显示分母），同样走有理帧率
  const rate = rateOfFps(spec.fps ?? 30);
  const range = spec.range ?? spec.ranges?.[0];
  if (!range) return 0;
  return Math.max(1, frameCountAt(rate, range[1] - range[0]));
}

/**
 * 工程哈希：film.html + scenes/** + assets/**（跳过 .film/.git/node_modules）。
 * 文件名与内容一起进哈希，避免只改文件名检测不到。
 * @param {string} projectRoot
 * @returns {Promise<string>}
 */
export async function hashProject(projectRoot) {
  const hash = crypto.createHash('sha256');
  const entries = await collectProjectFiles(projectRoot);
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  for (const entry of entries) {
    const data = await fs.readFile(entry.abs);
    hash.update(entry.rel);
    hash.update('\0');
    hash.update(String(data.byteLength));
    hash.update('\0');
    hash.update(data);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * @param {string} projectRoot
 * @returns {Promise<Array<{ rel: string, abs: string }>>}
 */
async function collectProjectFiles(projectRoot) {
  /** @type {Array<{ rel: string, abs: string }>} */
  const out = [];
  const IGNORE = new Set(['.film', '.git', 'node_modules']);

  /** @param {string} dir @param {string} rel */
  const walk = async (dir, rel) => {
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORE.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, childRel);
      } else if (entry.isFile()) {
        out.push({ rel: childRel, abs });
      }
    }
  };

  try {
    await fs.access(path.join(projectRoot, 'film.html'));
    out.push({ rel: 'film.html', abs: path.join(projectRoot, 'film.html') });
  } catch {
    throw new RenderFailure('FRAME_FAILED', `film.html not found under ${projectRoot}`);
  }

  await walk(path.join(projectRoot, 'scenes'), 'scenes');
  await walk(path.join(projectRoot, 'assets'), 'assets');
  return out;
}

/**
 * @param {string} desiredPath
 * @returns {Promise<string>}
 */
async function pickFreeName(desiredPath) {
  const ext = path.extname(desiredPath);
  const base = path.basename(desiredPath, ext);
  const dir = path.dirname(desiredPath);
  for (let n = 1; n < 1000; n += 1) {
    const candidate = n === 1 ? desiredPath : path.join(dir, `${base} ${n}${ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  throw new RenderFailure('FRAME_FAILED', 'too many duplicate output names');
}

/**
 * @param {string} name
 * @returns {string}
 */
function sanitize(name) {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'project';
}

/**
 * @param {number} value
 * @param {number} digits
 * @returns {number}
 */
function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * 本机自动预算输入。测试可注入 hostInfo 固定数值。
 * @returns {HostInfo}
 */
function defaultHostInfo() {
  const cpu =
    typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return { cpu, freeMemBytes: os.freemem() };
}
