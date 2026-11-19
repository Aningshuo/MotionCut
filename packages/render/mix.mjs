/**
 * 混合导出状态机（P4.3 / WP23）。
 *
 * 目标形态：实拍视频 + 网页场景帧 + 音频混音 → 一条 MP4。
 *
 * 本批**只做状态机与依赖注入**，不实现 film 解析器、不实现帧内核（frameAt）：
 * - `readFilm()` 由主线 film v1.1.0 提供；
 * - `frameAt()` 由副线1 提供；
 * - `audioPlan()` 由导出侧根据 film 的音轨计划给出。
 *
 * 真实混合导出 = WAIT：上游未冻结前，测试只用**显式标注 MOCK** 的 provider。
 * 状态机本身负责：片段时序、帧率换算、音画对齐校验、取消、失败回退。
 *
 * 上游要求的文件名与哈希见 `MIX_UPSTREAM_REQUIREMENTS`（哈希由 HANDOFF 里用 sha256sum 记录）。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { RenderFailure, encodeVideo } from './ffmpeg.mjs';
import { frameTimes, produceFrames } from './frames.mjs';
import { fileDigest, fullDecode, probeMedia, verifyOutput } from './verify.mjs';

/** 真实混合导出的上游依赖；未就绪就只能是 WAIT。 */
export const MIX_UPSTREAM_REQUIREMENTS = Object.freeze({
  status: 'WAIT',
  reason:
    'real mixed export needs the mainline film v1.1.0 reader and SUB1 frame kernel; ' +
    'this batch only ships the timeline state machine with injected providers',
  requires: Object.freeze([
    Object.freeze({
      owner: 'MAIN',
      file: 'packages/film-core/** (film.html v1.1.0 reader: duration/fps/segments/audio plan)',
      contract: 'contracts/film-doc.ts',
    }),
    Object.freeze({
      owner: 'SUB1',
      file: 'packages/scene-runtime/** (frameAt(t) freeze: deterministic frame kernel)',
      contract: 'contracts/frame.ts',
    }),
    Object.freeze({
      owner: 'MAIN',
      file: 'packages/film-core/** (audio plan: track path / start / gain)',
      contract: 'contracts/film-doc.ts',
    }),
  ]),
});

/**
 * @typedef {Object} MixSegmentInput
 * @property {'video' | 'scene'} kind
 * @property {string} [path]         video 片段的源文件
 * @property {number} [inSec]        视频片段从源文件的哪一秒开始
 * @property {string} [sceneId]      场景标识（交给 frameAt）
 * @property {number} durationSec
 */

/**
 * @typedef {Object} MixFilm
 * @property {number} durationSec
 * @property {number} fps
 * @property {number} width
 * @property {number} height
 * @property {MixSegmentInput[]} segments
 */

/**
 * @typedef {Object} MixAudioPlan
 * @property {string} path
 * @property {number} startSec
 * @property {number} durationSec
 * @property {number} [sampleRate]
 * @property {number} [channels]
 */

/**
 * 时间线规划：只做纯计算，不碰媒体。帧率换算与音画对齐在这里一次算清。
 * @param {{ film: MixFilm, audio: MixAudioPlan }} input
 * @returns {{ ok: true, plan: {
 *   fps: number, width: number, height: number, durationSec: number, frameCount: number,
 *   segments: Array<MixSegmentInput & { timelineStartSec: number, timelineEndSec: number, frameStart: number, frameCount: number }>,
 *   audio: MixAudioPlan & { avDeltaFrames: number }
 * }} | { ok: false, error: 'INVALID_TIMELINE' | 'AUDIO_MISMATCH', detail: string }}
 */
export function planMix(input) {
  const film = input?.film;
  const audio = input?.audio;
  if (!film || typeof film !== 'object') {
    return { ok: false, error: 'INVALID_TIMELINE', detail: 'film is required' };
  }
  const { durationSec, fps, width, height } = film;
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return { ok: false, error: 'INVALID_TIMELINE', detail: `invalid film duration: ${String(durationSec)}` };
  }
  if (!Number.isFinite(fps) || fps <= 0) {
    return { ok: false, error: 'INVALID_TIMELINE', detail: `invalid fps: ${String(fps)}` };
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return { ok: false, error: 'INVALID_TIMELINE', detail: `invalid size: ${width}x${height}` };
  }
  if (!Array.isArray(film.segments) || film.segments.length === 0) {
    return { ok: false, error: 'INVALID_TIMELINE', detail: 'film.segments must be a non-empty array' };
  }

  const totalFrames = Math.round(durationSec * fps);
  /** @type {ReturnType<typeof planMix> extends never ? never : any[]} */
  const segments = [];
  let cursorSec = 0;
  let cursorFrame = 0;

  for (const [index, segment] of film.segments.entries()) {
    if (!segment || (segment.kind !== 'video' && segment.kind !== 'scene')) {
      return { ok: false, error: 'INVALID_TIMELINE', detail: `segment ${index}: unknown kind` };
    }
    if (!Number.isFinite(segment.durationSec) || segment.durationSec <= 0) {
      return { ok: false, error: 'INVALID_TIMELINE', detail: `segment ${index}: invalid duration` };
    }
    if (segment.kind === 'video') {
      if (typeof segment.path !== 'string' || segment.path.length === 0) {
        return { ok: false, error: 'INVALID_TIMELINE', detail: `segment ${index}: video.path required` };
      }
      if (!Number.isFinite(segment.inSec ?? 0) || (segment.inSec ?? 0) < 0) {
        return { ok: false, error: 'INVALID_TIMELINE', detail: `segment ${index}: invalid inSec` };
      }
    }
    if (segment.kind === 'scene' && (typeof segment.sceneId !== 'string' || segment.sceneId.length === 0)) {
      return { ok: false, error: 'INVALID_TIMELINE', detail: `segment ${index}: sceneId required` };
    }

    const frames = Math.round(segment.durationSec * fps);
    if (frames < 1) {
      return { ok: false, error: 'INVALID_TIMELINE', detail: `segment ${index}: shorter than one frame` };
    }
    segments.push({
      ...segment,
      timelineStartSec: cursorSec,
      timelineEndSec: cursorSec + frames / fps,
      frameStart: cursorFrame,
      frameCount: frames,
    });
    cursorSec += frames / fps;
    cursorFrame += frames;
  }

  // 规划后的总帧数必须与宣称时长一致（误差不超过半帧）。
  if (Math.abs(cursorFrame - totalFrames) > 0.5) {
    return {
      ok: false,
      error: 'INVALID_TIMELINE',
      detail: `segments cover ${cursorFrame} frames but film claims ${totalFrames}`,
    };
  }
  if (Math.abs(cursorSec - durationSec) > 0.5 / fps) {
    return {
      ok: false,
      error: 'INVALID_TIMELINE',
      detail: `segments cover ${cursorSec}s but film claims ${durationSec}s`,
    };
  }

  if (!audio || typeof audio.path !== 'string' || audio.path.length === 0) {
    return { ok: false, error: 'AUDIO_MISMATCH', detail: 'audioPlan must return a path' };
  }
  if (!Number.isFinite(audio.durationSec) || audio.durationSec <= 0) {
    return { ok: false, error: 'AUDIO_MISMATCH', detail: 'audioPlan.durationSec invalid' };
  }
  if (!Number.isFinite(audio.startSec ?? 0) || (audio.startSec ?? 0) < 0) {
    return { ok: false, error: 'AUDIO_MISMATCH', detail: 'audioPlan.startSec invalid' };
  }
  const audioDelta = Math.abs(audio.durationSec - durationSec);
  const avDeltaFrames = Math.round(audioDelta * fps);
  if (avDeltaFrames > 1) {
    return {
      ok: false,
      error: 'AUDIO_MISMATCH',
      detail: `audio ${audio.durationSec}s vs video ${durationSec}s (${avDeltaFrames} frames > 1)`,
    };
  }

  return {
    ok: true,
    plan: {
      fps,
      width,
      height,
      durationSec: cursorFrame / fps,
      frameCount: cursorFrame,
      segments,
      audio: { ...audio, durationSec, avDeltaFrames },
    },
  };
}

/**
 * 混合导出状态机。
 *
 * 状态：idle → validating → planning → rendering → muxing → verifying → done
 *       任一阶段失败 → failed（可选 fallback 后进入 degraded 并继续）
 *       cancel → cancelled（只杀本作业创建的进程）
 */
export class MixExporter {
  /** @type {() => Promise<MixFilm> | MixFilm} */
  #readFilm;
  /** @type {(sceneId: string, timeSec: number, ctx: { index: number, segmentIndex: number }) => Promise<Buffer | Uint8Array | { path: string } | { data: Buffer }>} */
  #frameAt;
  /** @type {() => Promise<MixAudioPlan> | MixAudioPlan} */
  #audioPlan;
  #ffmpegPath;
  #ffprobePath;
  #workDir;
  #workers;
  /** @type {'fail' | 'color'} */
  #fallback;
  /** @type {AbortSignal | undefined} */
  #signal;
  /** @type {string[]} */
  #transitions = [];

  /**
   * @param {{
   *   readFilm: () => Promise<MixFilm> | MixFilm,
   *   frameAt: (sceneId: string, timeSec: number, ctx: { index: number, segmentIndex: number }) => Promise<Buffer | Uint8Array | { path: string } | { data: Buffer }>,
   *   audioPlan: () => Promise<MixAudioPlan> | MixAudioPlan,
   *   workDir: string,
   *   workers?: number,
   *   fallback?: 'fail' | 'color',
   *   ffmpegPath?: string,
   *   ffprobePath?: string,
   *   signal?: AbortSignal,
   * }} opts
   */
  constructor(opts) {
    if (typeof opts?.readFilm !== 'function') throw new TypeError('readFilm required');
    if (typeof opts?.frameAt !== 'function') throw new TypeError('frameAt required');
    if (typeof opts?.audioPlan !== 'function') throw new TypeError('audioPlan required');
    if (typeof opts?.workDir !== 'string' || opts.workDir.length === 0) throw new TypeError('workDir required');
    this.#readFilm = opts.readFilm;
    this.#frameAt = opts.frameAt;
    this.#audioPlan = opts.audioPlan;
    this.#ffmpegPath = opts.ffmpegPath ?? 'ffmpeg';
    this.#ffprobePath = opts.ffprobePath ?? 'ffprobe';
    this.#workDir = opts.workDir;
    this.#workers = Math.max(1, Math.floor(opts.workers ?? 2));
    this.#fallback = opts.fallback === 'color' ? 'color' : 'fail';
    this.#signal = opts.signal;
  }

  /** @returns {string[]} */
  get transitions() {
    return [...this.#transitions];
  }

  /**
   * @param {{ outputPath: string }} opts
   * @returns {Promise<{
   *   state: 'done' | 'degraded',
   *   output?: { path: string, bytes: number, sha256: string, probe: any },
   *   plan?: any,
   *   fallbacks: Array<{ segmentIndex: number, reason: string }>,
   *   transitions: string[],
   *   mock?: true,
   * } | { state: 'failed' | 'cancelled', error: string, detail: string, transitions: string[] }>}
   */
  async run(opts) {
    /** @type {Array<{ segmentIndex: number, reason: string }>} */
    const fallbacks = [];
    const outputPath = opts.outputPath;
    const partial = `${outputPath}.partial.mp4`;
    try {
      this.#move('validating');
      const film = await this.#readFilm();
      const audio = await this.#audioPlan();
      const planned = planMix({ film, audio });
      if (!planned.ok) {
        return this.#fail(planned.error, planned.detail);
      }
      const plan = planned.plan;
      this.#move('planning');

      await fs.mkdir(this.#workDir, { recursive: true });
      await fs.mkdir(path.dirname(outputPath), { recursive: true });

      this.#move('rendering');
      /** @type {string[]} */
      const segmentFiles = [];
      for (const [index, segment] of plan.segments.entries()) {
        this.#throwIfAborted();
        const segmentPath = path.join(this.#workDir, `segment-${String(index).padStart(3, '0')}.mp4`);
        try {
          if (segment.kind === 'scene') {
            await this.#renderSceneSegment(segment, index, segmentPath, plan);
          } else {
            await this.#renderVideoSegment(segment, segmentPath, plan);
          }
          segmentFiles.push(segmentPath);
        } catch (err) {
          if (err instanceof RenderFailure && err.code === 'CANCELLED') throw err;
          if (this.#fallback === 'fail') throw err;
          // 回退：用同尺寸纯色片段占位，时长不变；明确记录，不假装场景渲染成功。
          const reason = err instanceof Error ? err.message : String(err);
          fallbacks.push({ segmentIndex: index, reason });
          await this.#renderColorSegment(segment, segmentPath, plan);
          segmentFiles.push(segmentPath);
        }
      }

      this.#move('muxing');
      const concatList = path.join(this.#workDir, 'concat.txt');
      await fs.writeFile(
        concatList,
        `${segmentFiles.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join('\n')}\n`,
      );
      const videoOnly = path.join(this.#workDir, 'video-only.mp4');
      await this.#ffmpeg([
        '-hide_banner', '-v', 'error', '-y',
        '-f', 'concat', '-safe', '0', '-i', concatList,
        '-c', 'copy', videoOnly,
      ]);

      await this.#ffmpeg([
        '-hide_banner', '-v', 'error', '-y',
        '-i', videoOnly,
        ...(plan.audio.startSec > 0 ? ['-ss', String(plan.audio.startSec)] : []),
        '-i', plan.audio.path,
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
        '-t', String(plan.durationSec),
        '-movflags', '+faststart',
        partial,
      ]);

      this.#move('verifying');
      const expected = {
        videoCodec: 'h264',
        width: plan.width,
        height: plan.height,
        fps: plan.fps,
        durationSec: plan.durationSec,
        durationToleranceSec: 1 / plan.fps,
        audioCodec: 'aac',
        channels: 2,
        sampleRate: 48000,
        requireAudio: true,
      };
      const verified = await verifyOutput(partial, expected, {
        ffmpegPath: this.#ffmpegPath,
        ffprobePath: this.#ffprobePath,
      });
      if (!verified.ok) {
        await fs.unlink(partial).catch(() => {});
        return this.#fail(
          'OUTPUT_UNVERIFIED',
          verified.mismatches.map((m) => `${m.field}: ${m.actual} != ${m.expected}`).join('; '),
        );
      }
      const decode = await fullDecode(partial, { ffmpegPath: this.#ffmpegPath });
      if (!decode.ok) {
        await fs.unlink(partial).catch(() => {});
        return this.#fail('OUTPUT_UNVERIFIED', `full decode failed: ${decode.errorLines.join('; ')}`);
      }

      await fs.rename(partial, outputPath);
      const probe = await probeMedia(outputPath, { ffprobePath: this.#ffprobePath });
      const digest = await fileDigest(outputPath);
      this.#move(fallbacks.length > 0 ? 'degraded' : 'done');
      return {
        state: fallbacks.length > 0 ? 'degraded' : 'done',
        output: {
          path: outputPath,
          bytes: digest.bytes,
          sha256: digest.sha256,
          probe: {
            videoCodec: probe.video?.codec ?? undefined,
            width: probe.video?.width ?? undefined,
            height: probe.video?.height ?? undefined,
            fps: probe.video?.fps ?? undefined,
            durationSec: probe.video?.durationSec ?? probe.format.durationSec ?? undefined,
            audioCodec: probe.audio?.codec ?? undefined,
            channels: probe.audio?.channels ?? undefined,
            sampleRate: probe.audio?.sampleRate ?? undefined,
          },
        },
        plan: {
          fps: plan.fps,
          durationSec: plan.durationSec,
          frameCount: plan.frameCount,
          avDeltaFrames: plan.audio.avDeltaFrames,
          segments: plan.segments.map((s) => ({
            kind: s.kind,
            timelineStartSec: s.timelineStartSec,
            timelineEndSec: s.timelineEndSec,
            frameStart: s.frameStart,
            frameCount: s.frameCount,
          })),
        },
        fallbacks,
        transitions: this.transitions,
      };
    } catch (err) {
      if (err instanceof RenderFailure && err.code === 'CANCELLED') {
        await fs.unlink(partial).catch(() => {});
        this.#move('cancelled');
        return { state: 'cancelled', error: 'CANCELLED', detail: err.detail, transitions: this.transitions };
      }
      await fs.unlink(partial).catch(() => {});
      return this.#fail(
        err instanceof RenderFailure ? err.code : 'FRAME_FAILED',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * @param {any} segment
   * @param {number} index
   * @param {string} out
   * @param {any} plan
   */
  async #renderSceneSegment(segment, index, out, plan) {
    const framesDir = path.join(this.#workDir, `frames-${String(index).padStart(3, '0')}`);
    const times = frameTimes({
      startSec: segment.timelineStartSec,
      endSec: segment.timelineEndSec,
      fps: plan.fps,
    });
    await produceFrames({
      frameAt: (timeSec, ctx) =>
        this.#frameAt(segment.sceneId, timeSec, { index: ctx.index, segmentIndex: index }),
      times,
      workers: this.#workers,
      outDir: framesDir,
      pattern: 'frame-%05d.png',
      startNumber: 1,
      ...(this.#signal ? { signal: this.#signal } : {}),
    });
    await encodeVideo({
      framesDir,
      framePattern: 'frame-%05d.png',
      width: plan.width,
      height: plan.height,
      fps: plan.fps,
      durationSec: segment.frameCount / plan.fps,
      startNumber: 1,
      frameCount: segment.frameCount,
      partialPath: `${out}.partial.mp4`,
      ffmpegPath: this.#ffmpegPath,
      preset: 'veryfast',
      crf: 18,
      ...(this.#signal ? { signal: this.#signal } : {}),
    });
    await fs.rename(`${out}.partial.mp4`, out);
  }

  /**
   * @param {any} segment
   * @param {string} out
   * @param {any} plan
   */
  async #renderVideoSegment(segment, out, plan) {
    await this.#ffmpeg([
      '-hide_banner', '-v', 'error', '-y',
      '-ss', String(segment.inSec ?? 0),
      '-t', String(segment.durationSec),
      '-i', segment.path,
      '-an',
      '-vf', `scale=${plan.width}:${plan.height}:force_original_aspect_ratio=decrease,pad=${plan.width}:${plan.height}:(ow-iw)/2:(oh-ih)/2,fps=${plan.fps}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-frames:v', String(segment.frameCount),
      `${out}.partial.mp4`,
    ]);
    await fs.rename(`${out}.partial.mp4`, out);
  }

  /**
   * @param {any} segment
   * @param {string} out
   * @param {any} plan
   */
  async #renderColorSegment(segment, out, plan) {
    await this.#ffmpeg([
      '-hide_banner', '-v', 'error', '-y',
      '-f', 'lavfi',
      '-i', `color=c=black:s=${plan.width}x${plan.height}:r=${plan.fps}:d=${segment.frameCount / plan.fps}`,
      '-an',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-frames:v', String(segment.frameCount),
      `${out}.partial.mp4`,
    ]);
    await fs.rename(`${out}.partial.mp4`, out);
  }

  /**
   * 只操作本作业创建的子进程组。
   * @param {string[]} args
   * @returns {Promise<void>}
   */
  #ffmpeg(args) {
    this.#throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(this.#ffmpegPath, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: true,
      });
      let stderr = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-3000);
      });
      /** @param {NodeJS.Signals} signal */
      const killGroup = (signal) => {
        const pid = child.pid;
        if (typeof pid !== 'number') return;
        try {
          process.kill(-pid, signal);
        } catch {
          try {
            child.kill(signal);
          } catch {
            /* gone */
          }
        }
      };
      const onAbort = () => {
        killGroup('SIGTERM');
        const timer = setTimeout(() => killGroup('SIGKILL'), 300);
        timer.unref?.();
      };
      this.#signal?.addEventListener('abort', onAbort, { once: true });
      child.on('error', () => {
        this.#signal?.removeEventListener('abort', onAbort);
        reject(new RenderFailure('CODEC_UNAVAILABLE', `cannot spawn ${this.#ffmpegPath}`));
      });
      child.on('close', (code) => {
        this.#signal?.removeEventListener('abort', onAbort);
        if (this.#signal?.aborted) {
          reject(new RenderFailure('CANCELLED', 'mix cancelled'));
          return;
        }
        if (code === 0) resolve();
        else reject(new RenderFailure('FRAME_FAILED', stderr.trim() || `ffmpeg exit ${code}`));
      });
    });
  }

  #throwIfAborted() {
    if (this.#signal?.aborted) throw new RenderFailure('CANCELLED', 'mix cancelled');
  }

  /** @param {string} state */
  #move(state) {
    this.#transitions.push(state);
  }

  /**
   * @param {string} error
   * @param {string} detail
   */
  #fail(error, detail) {
    this.#move('failed');
    return { state: /** @type {const} */ ('failed'), error, detail, transitions: this.transitions };
  }
}
