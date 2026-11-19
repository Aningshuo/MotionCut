/**
 * 按 film 计划渲染画面，并把 P11 的音轨接上（P12）。
 *
 * 两段职责分明：
 * 1. `renderFilmVideo`：`visualClips` → 一条 ffmpeg `filter_complex` 的**无声** H.264；
 *    每段 trim 到源入出点、`setpts` 处理 speed/at、`scale` 到 box、`fade` 用 alpha、
 *    按时间窗 `overlay` 到黑底上；轨道 `trackIndex` 小的（0）在上层。
 * 2. `renderFilmExport`：无声视频 → `renderMix`（P11 的 audioMix）→ `muxWithVideo`
 *    （沿用 P9 规则：`target=min`、只裁不补、回探双流差 ≤1 帧）→ `verify` 完整 decode。
 *
 * 第三条路（P13）：计划里**有网页片段**时，画面整段改由舞台运行时逐帧抓下来
 * （`stage-capture.mjs`，Web 页面 + 视频 + 摆位 + 淡入淡出都由舞台合成），
 * 本文件只负责把 PNG 序列编成无声 H.264，后面接同一套混音/封装/校验。
 * 调用方没给 `capture` 却带着网页片段 → 仍旧 `UNSUPPORTED_SCENE_CLIP`：
 * 缺网页的片子绝不悄悄产出。
 *
 * 明确不做：圆角（`box.r≠0` → `UNSUPPORTED`）；旋转。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { muxWithVideo, renderMix } from './audio-mix.mjs';
import {
  applyPixFmt,
  codecQuality,
  containerArgs,
  describeCodec,
  resolveCodec,
  resolvePixFmtMode,
  videoEncodeArgs,
} from './codec-matrix.mjs';
import { FilmPlanError } from './film-plan.mjs';
import { rateOfFps } from './fps.mjs';
import { measureDeliveredLoudness, normalizeLoudness, summarizeLoudness } from './loudness.mjs';
import { resolveQuality } from './quality.mjs';
import { subtitleFilterArg } from './subtitles.mjs';
import { RenderFailure, commitOutput } from './ffmpeg.mjs';
import { fileDigest, probeMedia, verifyOutput } from './verify.mjs';
import { requiresCreationStyleStage } from '../film-core/creation-style-stage.mjs';

/** 正在跑的渲染子进程（取消/残留检查用）。 */
const LIVE_PIDS = new Set();

/** @returns {number[]} */
export function activeFilmPids() {
  return [...LIVE_PIDS];
}

/**
 * 取消 ffmpeg 时的宽限期：先 SIGTERM 让它自己收尾（删半截文件、关文件句柄），
 * 超过这个时间还在就 SIGKILL。直接 SIGKILL 会留下半个 mp4 的 moov 缺失，
 * 而且 ffmpeg 子进程组的清理会变成"看运气"。
 */
const CANCEL_GRACE_MS = 1500;

/**
 * @param {string[]} args
 * @param {{ ffmpegPath?: string, signal?: AbortSignal, onProgress?: (info: { frame: number }) => void }} [opts]
 * 导出给 alpha 导出复用（P31）：取消语义（SIGTERM → 宽限 → SIGKILL）只该有一份实现。
 * @returns {Promise<void>}
 */
export function runFfmpeg(args, opts = {}) {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new RenderFailure('CANCELLED', 'cancelled before ffmpeg started'));
      return;
    }
    // `-progress pipe:1` 只在**有人要听**的时候加：不带回调时命令行与 R13 逐字节相同，
    // 产物 sha 才守得住（A5）。
    const wantProgress = typeof opts.onProgress === 'function';
    const argv = wantProgress ? ['-progress', 'pipe:1', '-nostats', ...args] : args;
    const child = spawn(opts.ffmpegPath ?? 'ffmpeg', argv, {
      stdio: ['ignore', wantProgress ? 'pipe' : 'ignore', 'pipe'],
    });
    if (child.pid) LIVE_PIDS.add(child.pid);
    let stderr = '';
    /** @type {NodeJS.Timeout | null} */
    let killTimer = null;
    const cleanup = () => {
      if (child.pid) LIVE_PIDS.delete(child.pid);
      if (killTimer) clearTimeout(killTimer);
      killTimer = null;
      opts.signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (!child.pid) return;
      try {
        child.kill('SIGTERM');
      } catch {
        // 已经退出
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // 同上
        }
      }, CANCEL_GRACE_MS);
      if (typeof killTimer.unref === 'function') killTimer.unref();
    };
    if (wantProgress && child.stdout) {
      // ffmpeg 的 -progress 是 key=value 逐行；只认 `frame=`，别的一律不看
      let buffered = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (/** @type {string} */ chunk) => {
        buffered += chunk;
        let cut = buffered.indexOf('\n');
        while (cut >= 0) {
          const line = buffered.slice(0, cut).trim();
          buffered = buffered.slice(cut + 1);
          const match = /^frame=(\d+)$/.exec(line);
          if (match) {
            const frame = Number(match[1]);
            if (Number.isFinite(frame)) {
              try {
                opts.onProgress?.({ frame });
              } catch {
                // 回调的 bug 不该把编码带崩
              }
            }
          }
          cut = buffered.indexOf('\n');
        }
      });
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-8000);
    });
    child.on('error', (err) => {
      cleanup();
      reject(new RenderFailure('CODEC_UNAVAILABLE', `ffmpeg failed to start: ${err.message}`));
    });
    child.on('close', (code) => {
      // aborted 的判断在 cleanup 之前：killTimer 要在读完状态后才清
      const aborted = opts.signal?.aborted === true;
      cleanup();
      if (aborted) {
        reject(new RenderFailure('CANCELLED', 'film render cancelled'));
        return;
      }
      if (code !== 0) {
        reject(new RenderFailure('FRAME_FAILED', stderr.trim() || `ffmpeg exit ${code}`));
        return;
      }
      resolve();
    });
  });
}

/**
 * @param {number} value
 */
function num(value) {
  const rounded = Number(Number(value).toFixed(6));
  return String(rounded);
}

/**
 * @param {number} value
 */
function even(value) {
  return Math.max(2, Math.round(Number(value) / 2) * 2);
}

/**
 * 渲染层的前置校验：能在开 ffmpeg 之前拒绝的，绝不先写文件。
 * @param {any} plan
 * @param {{ allowScenes?: boolean }} [opts] `allowScenes`：调用方已经拿到舞台帧
 */
export function assertRenderable(plan, opts = {}) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.visualClips)) {
    throw new FilmPlanError('INVALID_FILM', 'plan.visualClips must be an array');
  }
  const hasScenes = Array.isArray(plan.sceneClips) && plan.sceneClips.length > 0;
  if ((plan.requiresStage === true || requiresCreationStyleStage(plan)) && opts.allowScenes !== true) {
    throw new FilmPlanError('UNSUPPORTED', 'This film has stage-rendered transitions or clip CSS; use a stage capture instead of the media-only renderer.');
  }
  if (hasScenes && opts.allowScenes !== true) {
    const first = plan.sceneClips[0];
    throw new FilmPlanError(
      'UNSUPPORTED_SCENE_CLIP',
      `clip ${first?.id ?? '?'} is a web page: pass a stage capture (see stage-capture.mjs) to render it`,
      { clipId: first?.id },
    );
  }
  // `emptyPicture`（P35）：整个画面轨都被 hidden 跳过时，计划层会显式打开这个开关——
  // 隐藏是可见性而不是长度，仍然要出片（黑场），所以这里放行**只有计划层能开**的这条路。
  if (plan.visualClips.length === 0 && !hasScenes && plan.emptyPicture !== true) {
    throw new FilmPlanError('INVALID_FILM', 'plan has no visual clips');
  }
  for (const clip of plan.visualClips) {
    if (clip.box && Number(clip.box.r) !== 0) {
      throw new FilmPlanError('UNSUPPORTED', `clip ${clip.id}: rotation / rounded corners (box.r) are not supported`, {
        clipId: clip.id,
      });
    }
    if (clip.kind !== 'video' && clip.kind !== 'still' && clip.kind !== 'img') {
      throw new FilmPlanError('UNSUPPORTED', `clip ${clip.id}: kind ${clip.kind} cannot be rendered as picture`, {
        clipId: clip.id,
      });
    }
  }
}

/**
 * `visualClips` → 无声视频（编码由 codec 决定；缺省 h264）。输出路径由调用方给（通常是 `.partial`）。
 *
 * @param {{ plan: any, outPath: string, codec?: any, encode?: { crf: number | null, preset: string | null, pixFmt: string }, ffmpegPath?: string, signal?: AbortSignal, preset?: string, crf?: number, pixFmt?: string, subtitleAss?: string, vf?: string, onProgress?: (info: { frame: number }) => void }} opts
 * @returns {Promise<{ path: string, frames: number, durationSec: number, bytes: number, sha256: string }>}
 */
export async function renderFilmVideo(opts) {
  const { plan } = opts;
  assertRenderable(plan);
  /* 编码矩阵（P38）：不传 codec 就是 h264；h264 的 args 顺序与 R22 逐项相同。 */
  const codec = opts.codec ?? resolveCodec(undefined);
  const encode = opts.encode ?? {
    crf: opts.crf ?? 20,
    preset: opts.preset ?? 'veryfast',
    pixFmt: opts.pixFmt ?? 'yuv420p',
  };

  /* 帧率（P42）：`-r` 与滤镜里的 `r=` 都送有理数（30000/1001），不送 29.97。
     整数帧率时 `arg` 就是 "30"，与 R22 的 args 逐字符相同 —— 默认产物 sha 不漂。 */
  const rate = rateOfFps(plan.fpsRational ?? plan.fps ?? 30);
  const fpsArg = rate.arg;
  // range 只导一段时，窗口长度才是输出时长（plan.duration 是整片长度）
  const duration = Number(plan.outputDuration ?? plan.duration);
  const frames = Number(plan.frames);
  const width = even(plan.stage.w);
  const height = even(plan.stage.h);

  // 轨道 0 在最上层：先叠底层（trackIndex 大的），最后叠 0，后者盖住前者。
  const ordered = /** @type {any[]} */ (plan.visualClips)
    .map((/** @type {any} */ clip, /** @type {number} */ index) => ({ clip, index }))
    .sort((/** @type {any} */ a, /** @type {any} */ b) => b.clip.trackIndex - a.clip.trackIndex || a.index - b.index)
    .map((/** @type {any} */ entry) => entry.clip);

  /** @type {string[]} */
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y'];
  for (const clip of ordered) {
    if (clip.kind === 'video') {
      args.push('-i', clip.src);
    } else {
      // 图片：循环成帧流，时长由 trim/fade 决定
      args.push('-loop', '1', '-framerate', fpsArg, '-i', clip.src);
    }
  }

  /** @type {string[]} */
  const graph = [`color=c=black:s=${width}x${height}:r=${fpsArg}:d=${num(duration)}[base0]`];
  let last = 'base0';
  for (const [i, clip] of /** @type {any[]} */ (ordered).entries()) {
    const [inSec, outSec] = clip.time;
    const speed = Number(clip.speed) > 0 ? Number(clip.speed) : 1;
    const clipDuration = Number(clip.duration) > 0 ? Number(clip.duration) : (outSec - inSec) / speed;
    const fadeIn = Math.max(0, Math.min(Number(clip.fade?.[0]) || 0, clipDuration));
    const fadeOut = Math.max(0, Math.min(Number(clip.fade?.[1]) || 0, clipDuration));
    const at = Number(clip.at) || 0;
    const box = clip.box ?? { x: 0, y: 0, w: width, h: height };
    const bw = even(box.w);
    const bh = even(box.h);

    /** @type {string[]} */
    const chain = [
      `trim=start=${num(inSec)}:end=${num(outSec)}`,
      `setpts=(PTS-STARTPTS)/${num(speed)}`,
      `scale=${bw}:${bh}`,
      'format=rgba',
    ];
    if (fadeIn > 0) chain.push(`fade=t=in:st=0:d=${num(fadeIn)}:alpha=1`);
    if (fadeOut > 0) chain.push(`fade=t=out:st=${num(Math.max(0, clipDuration - fadeOut))}:d=${num(fadeOut)}:alpha=1`);
    chain.push(`setpts=PTS+${num(at)}/TB`);
    graph.push(`[${i}:v]${chain.join(',')}[v${i}]`);

    const end = at + clipDuration;
    graph.push(
      `[${last}][v${i}]overlay=x=${num(box.x)}:y=${num(box.y)}:eof_action=pass:enable='between(t,${num(at)},${num(end)})'[b${i + 1}]`,
    );
    last = `b${i + 1}`;
  }

  // 画幅变换（P24）与字幕（P23）都在**合成之后**接：前者把整张画面缩放到目标画幅，
  // 后者按画面高等比排版——顺序反了，字会先被烧进 1280×720 再被整体缩放，安全区就不对了。
  /** @type {string[]} */
  const post = [];
  if (opts.vf) post.push(opts.vf);
  if (opts.subtitleAss) post.push(subtitleFilterArg(opts.subtitleAss));
  let outLabel = last;
  if (post.length > 0) {
    graph.push(`[${last}]${post.join(',')}[vout]`);
    outLabel = 'vout';
  }

  args.push(
    '-filter_complex',
    graph.join(';'),
    '-map',
    `[${outLabel}]`,
    '-an',
    ...videoEncodeArgs(codec, encode),
    '-r',
    fpsArg,
    '-frames:v',
    String(frames),
    '-t',
    num(duration),
    ...containerArgs(codec),
    opts.outPath,
  );

  await fs.mkdir(path.dirname(opts.outPath), { recursive: true });
  await fs.unlink(opts.outPath).catch(() => {});
  await runFfmpeg(args, {
    ffmpegPath: opts.ffmpegPath,
    signal: opts.signal,
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
  });

  const digest = await fileDigest(opts.outPath);
  return { path: opts.outPath, frames, durationSec: duration, bytes: digest.bytes, sha256: digest.sha256 };
}

/**
 * PNG 序列 → 无声视频（舞台取帧路径；编码由 codec 决定，缺省 h264）。
 *
 * 输入是 `stage-capture.mjs` 写好的 `frame-%06d.png`：`-framerate` 定帧率、
 * `-frames:v` 钉帧数，和 ffmpeg 那条路一样不接受浮动的「大概这么多帧」。
 *
 * @param {{
 *   framesDir: string, pattern?: string, frames: number, fps: number,
 *   width: number, height: number, outPath: string, codec?: any,
 *   encode?: { crf: number | null, preset: string | null, pixFmt: string },
 *   ffmpegPath?: string, signal?: AbortSignal, preset?: string, crf?: number, pixFmt?: string,
 *   subtitleAss?: string, vf?: string, onProgress?: (info: { frame: number }) => void,
 * }} opts
 * @returns {Promise<{ path: string, frames: number, durationSec: number, bytes: number, sha256: string }>}
 */
export async function renderFilmVideoFromFrames(opts) {
  const frames = Number(opts.frames);
  const rate = rateOfFps(opts.fps ?? 30);
  const fpsArg = rate.arg;
  if (!Number.isFinite(frames) || frames <= 0) {
    throw new FilmPlanError('INVALID_FILM', `frame sequence needs a positive count, got ${opts.frames}`);
  }
  const width = even(opts.width);
  const height = even(opts.height);
  const pattern = opts.pattern ?? 'frame-%06d.png';
  const duration = (frames * rate.den) / rate.num;
  const codec = opts.codec ?? resolveCodec(undefined);
  const encode = opts.encode ?? {
    crf: opts.crf ?? 20,
    preset: opts.preset ?? 'veryfast',
    pixFmt: opts.pixFmt ?? 'yuv420p',
  };

  // 字幕只能在**编码前**烧：PNG 序列是无损中间物，烧在这一层与舞台取帧无关。
  // 滤镜链按顺序拼：先缩放/裁切（P24 的画幅），再烧字幕，保证字随画面一起被缩放。
  /** @type {string[]} */
  const filters = [];
  if (opts.vf) filters.push(opts.vf);
  if (opts.subtitleAss) filters.push(subtitleFilterArg(opts.subtitleAss));

  /** @type {string[]} */
  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    '-framerate',
    fpsArg,
    '-i',
    path.join(opts.framesDir, pattern),
    ...(filters.length > 0 ? ['-vf', filters.join(',')] : []),
    '-an',
    ...videoEncodeArgs(codec, encode),
    '-r',
    fpsArg,
    '-frames:v',
    String(frames),
    ...containerArgs(codec),
    opts.outPath,
  ];
  void width;
  void height;

  await fs.mkdir(path.dirname(opts.outPath), { recursive: true });
  await fs.unlink(opts.outPath).catch(() => {});
  await runFfmpeg(args, {
    ffmpegPath: opts.ffmpegPath,
    signal: opts.signal,
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
  });

  const digest = await fileDigest(opts.outPath);
  return { path: opts.outPath, frames, durationSec: duration, bytes: digest.bytes, sha256: digest.sha256 };
}

/**
 * 烧录第二遍的进度归并器（P45）。
 *
 * ffmpeg 的 `-progress pipe:1` 是**按时间**上报的（默认 0.5s 一条），一条 `frame=N`
 * 的意思是「已经编完 N 帧」。宿主要的是「第几帧」，中间那几十帧不能靠猜：这里把 gap
 * 补成逐帧事件——补的每一帧在收到这一报的时候**都已经编完**，不是预测。
 *
 * 契约：
 *  - `phase: 'burn'`、`stage: 'encode'`：和母版的 `rendering` 分开，宿主可以单独画一条；
 *  - `frame` 从 1 严格 +1 到 `totalFrames`，不回头、不重复；
 *  - `finish()` 只在编码**成功**后调用，补齐尾部（ffmpeg 的最后一报可能小于总帧数）；
 *    取消/失败时不补，否则宿主会看到「取消了进度还在涨」。
 *
 * @param {number} totalFrames 成片总帧数
 * @param {(event: { phase: 'burn', stage: 'encode', frame: number, totalFrames: number }) => void} emit
 */
export function createBurnProgress(totalFrames, emit) {
  const total = Number.isFinite(Number(totalFrames)) ? Math.max(0, Math.floor(Number(totalFrames))) : 0;
  let last = 0;
  /** @param {number} upTo */
  const fillTo = (upTo) => {
    const target = Math.min(total, Math.max(0, Math.floor(upTo)));
    while (last < target) {
      last += 1;
      emit({ phase: 'burn', stage: 'encode', frame: last, totalFrames: total });
    }
  };
  return {
    /** @param {{ frame: number }} info */
    update(info) {
      const reported = Number(info?.frame);
      if (Number.isFinite(reported)) fillTo(reported);
    },
    /** 编码结束（成功路径）：把尾部补齐 */
    finish() {
      fillTo(total);
    },
    /** @returns {number} 已发出的最后帧号 */
    get frame() {
      return last;
    },
  };
}

/**
 * 一段 film 的完整导出：画面 → 混音 → 封装 → 校验。
 *
 * @param {{
 *   plan: any,
 *   projectRoot: string,
 *   outPath: string,
 *   capture?: { framesDir?: string, dir?: string, pattern?: string, frames?: number, stage?: { w: number, h: number } },
 *   ffmpegPath?: string,
 *   ffprobePath?: string,
 *   signal?: AbortSignal,
 *   quality?: string,
 *   preset?: string,
 *   crf?: number,
 *   pixFmt?: string,
 *   outputSize?: { w: number, h: number },
 *   codec?: string,
 *   pixFmtMode?: 'auto' | '420' | '444',
 *   vf?: string,
 *   subtitles?: { assPath: string, outPath: string },
 *   loudness?: 'off' | 'streaming' | 'broadcast',
 *   onProgress?: (info: { phase: 'rendering' | 'burn' | 'muxing', stage?: 'capture' | 'encode', frame?: number, totalFrames?: number }) => void,
 * }} opts `quality` 选档（draft|standard|high）；显式 `crf`/`preset`/`pixFmt` 优先，供集成方覆盖
 * @returns {Promise<any>}
 */
export async function renderFilmExport(opts) {
  const { plan, outPath } = opts;
  const capture = opts.capture ?? null;
  // 档位只决定**默认**参数；显式传入的仍然赢，保证主线那边 {preset,crf} 的老调用不受影响。
  // 编码矩阵（P38）：codec 决定容器/编码器/像素格式；h264 仍走 quality.mjs 的档位表。
  const codec = resolveCodec(opts.codec);
  const level = resolveQuality(opts.quality);
  const settings = codecQuality(codec, level);
  // 显式 preset/crf/pixFmt 只对 h264 有意义（hevc/vp9 的档位由矩阵给，prores 不吃 crf）
  const preset = codec.name === 'h264' ? opts.preset ?? settings.preset : settings.preset;
  const crf = codec.name === 'h264' ? opts.crf ?? settings.crf : settings.crf;
  // `--pix-fmt`（P41）：auto 时这一行**原样**返回档位表的值（默认 sha 不变）。
  const fmt = applyPixFmt(codec, resolvePixFmtMode(opts.pixFmtMode), {
    crf,
    preset,
    pixFmt: codec.name === 'h264' ? opts.pixFmt ?? settings.pixFmt : settings.pixFmt,
  });
  const encode = { preset: fmt.preset, crf: fmt.crf, pixFmt: fmt.pixFmt, profileArg: fmt.profileArg };
  const hasScenes = Array.isArray(plan?.sceneClips) && plan.sceneClips.length > 0;
  if ((plan?.requiresStage === true || requiresCreationStyleStage(plan)) && capture === null) {
    throw new FilmPlanError('UNSUPPORTED', 'This film has stage-rendered transitions or clip CSS; capture its stage frames before encoding.');
  }
  // 先拒绝：网页片段绝不能走到「渲了一半才发现少东西」
  assertRenderable(plan, { allowScenes: capture !== null });

  const totalFrames = Number(plan?.frames) || 0;
  /**
   * 编码进度：把 ffmpeg 的 `frame=N` 翻成统一事件。
   * **只接母版那一次**编码——烧录版是同一批帧的第二次编码，再报一遍会让帧号往回跳。
   * @param {{ frame: number }} info
   */
  const encodeProgress = (info) =>
    opts.onProgress?.({ phase: 'rendering', stage: 'encode', frame: info.frame, totalFrames });
  /**
   * 烧录进度（P45）：**独立的一条线**，不复用母版回调——第二遍是从第 1 帧重新编的，
   * 混进 `rendering` 会让帧号往回跳。只在有 subtitles 时创建。
   */
  const burnProgress = createBurnProgress(totalFrames, (event) => {
    opts.onProgress?.(event);
  });

  // 中间件的扩展名必须跟容器一致，ffmpeg 才选得到 muxer（webm/mov 不能落 .mp4）
  const partialFor = (/** @type {string} */ target) =>
    new RegExp(`\\.(${codec.container === 'webm' ? 'webm' : codec.container === 'mov' ? 'mov' : 'mp4'})$`, 'i').test(target)
      ? target.replace(new RegExp(`\\.(${codec.container === 'webm' ? 'webm' : codec.container === 'mov' ? 'mov' : 'mp4'})$`, 'i'), `.video.partial${codec.extension}`)
      : `${target}.video.partial${codec.extension}`;
  const videoPartial = partialFor(outPath);
  // 烧录版（P23）：同一份画面再编一条，只多一个 subtitles 滤镜。**不重新取帧**。
  const subbedRequest = /** @type {{ assPath: string, outPath: string } | null} */ (opts.subtitles ?? null);
  const subbedPartial = subbedRequest ? partialFor(subbedRequest.outPath) : '';
  const mixDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-film-'));
  /** @type {string} */
  let produced = '';

  try {
    /** @type {{ path: string, frames: number, durationSec: number, bytes: number, sha256: string }} */
    let video;
    if (capture !== null) {
      const framesDir = capture.framesDir ?? capture.dir;
      if (!framesDir) throw new FilmPlanError('INVALID_FILM', 'capture is missing framesDir');
      const frameCount = Number(capture.frames ?? plan.frames);
      if (frameCount !== Number(plan.frames)) {
        throw new FilmPlanError(
          'OUTPUT_UNVERIFIED',
          `capture produced ${frameCount} frames, plan expects ${plan.frames}`,
        );
      }
      video = await renderFilmVideoFromFrames({
        framesDir,
        ...(capture.pattern ? { pattern: capture.pattern } : {}),
        frames: frameCount,
        fps: plan.fpsRational ?? plan.fps ?? 30,
        width: Number(plan.stage.w),
        height: Number(plan.stage.h),
        outPath: videoPartial,
        ...(opts.vf ? { vf: opts.vf } : {}),
        codec,
        encode,
        ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.onProgress ? { onProgress: encodeProgress } : {}),
      });
    } else {
      video = await renderFilmVideo({
        plan,
        outPath: videoPartial,
        ...(opts.vf ? { vf: opts.vf } : {}),
        codec,
        encode,
        ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.onProgress ? { onProgress: encodeProgress } : {}),
      });
    }

    // 烧录版：与母版同一批帧、同一组编码参数，唯一差别是字幕滤镜。
    // 「cue 外逐像素相同」这条能不能成立，全靠这里只多一个滤镜、别的都不动。
    /** @type {{ path: string, frames: number, durationSec: number, bytes: number, sha256: string } | null} */
    let subbedVideo = null;
    if (subbedRequest) {
      subbedVideo =
        capture !== null
          ? await renderFilmVideoFromFrames({
              framesDir: /** @type {string} */ (capture.framesDir ?? capture.dir),
              ...(capture.pattern ? { pattern: capture.pattern } : {}),
              frames: Number(capture.frames ?? plan.frames),
              fps: plan.fpsRational ?? plan.fps ?? 30,
              width: Number(plan.stage.w),
              height: Number(plan.stage.h),
              outPath: subbedPartial,
              ...(opts.vf ? { vf: opts.vf } : {}),
              subtitleAss: subbedRequest.assPath,
              codec,
              encode,
              ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}),
              ...(opts.signal ? { signal: opts.signal } : {}),
              // 没人听就不加 `-progress pipe:1`：argv 与 R22 逐项相同（P45）
              ...(opts.onProgress ? { onProgress: burnProgress.update } : {}),
            })
          : await renderFilmVideo({
              plan,
              outPath: subbedPartial,
              ...(opts.vf ? { vf: opts.vf } : {}),
              subtitleAss: subbedRequest.assPath,
              codec,
              encode,
              ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}),
              ...(opts.signal ? { signal: opts.signal } : {}),
              ...(opts.onProgress ? { onProgress: burnProgress.update } : {}),
            });
      // 只有编码成功才补尾部：取消/失败时这句根本走不到，宿主不会看到「取消后进度还在涨」
      burnProgress.finish();
    }

    /** @type {any} */
    let muxed;
    /** @type {any} */
    let subbed = null;
    /** @type {any} */
    let loudnessReport = null;
    if (plan.audioMix) {
      // 有音轨才有「封装」这道工序；无音轨只是一次 rename，不谎报一个阶段
      opts.onProgress?.({ phase: 'muxing', totalFrames });
      // 混音只做一次：母版与烧录版共用同一份 wav，避免两次混音带来的偏差
      const mixed = await renderMix(plan.audioMix, {
        outWav: path.join(mixDir, 'mix.wav'),
        ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      // 响度（P34）：在**混音 WAV** 上做两遍 loudnorm，再交给封装。
      // 放在这里而不是最后改 mp4，是因为：① 不用二次解码视频；② 音量/淡入淡出/
      // 区间/静音全部已经烘进 wav，标准化作用在最终波形上，语义不会被覆盖。
      let audioPath = mixed.path;
      const loudnessPreset = opts.loudness ?? 'off';
      if (loudnessPreset !== 'off') {
        loudnessReport = await normalizeLoudness({
          wavPath: mixed.path,
          outPath: path.join(mixDir, 'mix.loudnorm.wav'),
          preset: /** @type {'streaming' | 'broadcast'} */ (loudnessPreset),
          ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        // 测不到（静音/超短）时 normalize 原样返回输入路径：继续出片，不装作标准化过。
        audioPath = loudnessReport.path;
      }
      muxed = await muxWithVideo(videoPartial, audioPath, outPath, {
        audio: codec.audio,
        container: codec.container,
        ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}),
        ...(opts.ffprobePath ? { ffprobePath: opts.ffprobePath } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      muxed.audioReport = mixed.report;
      if (subbedVideo) {
        subbed = await muxWithVideo(subbedPartial, audioPath, /** @type {any} */ (subbedRequest).outPath, {
          // 烧录版与母版同一个容器/音频：漏了这两个参数会拿 aac 去封 webm（P41 组合验收时抓到）
          audio: codec.audio,
          container: codec.container,
          ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}),
          ...(opts.ffprobePath ? { ffprobePath: opts.ffprobePath } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        subbed.audioReport = mixed.report;
      }
    } else {
      // 没有音轨就**不造静音轨**：直接提交无声视频
      const finalPath = await commitOutput(videoPartial, outPath);
      const digest = await fileDigest(finalPath);
      muxed = { path: finalPath, bytes: digest.bytes, sha256: digest.sha256, probe: null, audioReport: null };
      // 用户显式要了响度，但这条片子没有音轨：**说清楚**，别让 loudness 字段凭空消失。
      // 不造静音轨的理由不变（P9 定的：没有声音就是没有声音）。
      if ((opts.loudness ?? 'off') !== 'off') {
        loudnessReport = {
          preset: opts.loudness,
          measurable: false,
          code: 'LOUDNESS_UNMEASURABLE',
          reason: 'film has no audible clips (audioMix is null): nothing to measure, and no silent track is invented',
          path: finalPath,
          target: null,
          encodeTarget: null,
          input: { I: null, TP: null, LRA: null, thresh: null },
          output: { I: null, TP: null, LRA: null },
          gainDb: null,
          peakGainDb: null,
          uniformGain: null,
          applied: null,
          measured: null,
          raw: null,
        };
      }
      if (subbedVideo) {
        const subFinal = await commitOutput(subbedPartial, /** @type {any} */ (subbedRequest).outPath);
        const subDigest = await fileDigest(subFinal);
        subbed = {
          path: subFinal,
          bytes: subDigest.bytes,
          sha256: subDigest.sha256,
          probe: null,
          audioReport: null,
        };
      }
    }
    produced = muxed.path;

    const probe = await probeMedia(muxed.path, opts.ffprobePath ? { ffprobePath: opts.ffprobePath } : {});
    // 画幅覆盖（P24）：`--size` 时输出尺寸与舞台的 1280×720 不同，校验按目标画幅来。
    const outW = Number(opts.outputSize?.w) > 0 ? Number(opts.outputSize?.w) : Number(plan.stage.w);
    const outH = Number(opts.outputSize?.h) > 0 ? Number(opts.outputSize?.h) : Number(plan.stage.h);
    const expected = {
      videoCodec: codec.probeVideo,
      ...(codec.probeTag ? { videoTag: codec.probeTag } : {}),
      width: outW,
      height: outH,
      fps: rateOfFps(plan.fpsRational ?? plan.fps ?? 30).value,
      durationSec: Number(plan.outputDuration ?? plan.duration),
      durationToleranceSec: 1 / rateOfFps(plan.fpsRational ?? plan.fps ?? 30).value + 0.001,
      ...(plan.audioMix
        ? { audioCodec: codec.audio.probe, channels: 2, sampleRate: 48000, requireAudio: true }
        : {}),
    };
    const verified = await verifyOutput(muxed.path, expected, {
      ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}),
      ...(opts.ffprobePath ? { ffprobePath: opts.ffprobePath } : {}),
    });
    if (!verified.ok) {
      await fs.unlink(muxed.path).catch(() => {});
      produced = '';
      throw new FilmPlanError(
        'OUTPUT_UNVERIFIED',
        verified.mismatches.map((m) => `${m.field}: ${String(m.actual)} != ${String(m.expected)}`).join('; '),
      );
    }

    // 交付件的实测响度（P34）：在**最终的 mp4** 上量，而不是信 loudnorm 自己报的数。
    // AAC 是有损的，重建后的峰可能比送进去的高零点几 dB —— 只有量成品才知道交出去的是什么。
    if (loudnessReport && loudnessReport.measurable) {
      const delivered = await measureDeliveredLoudness(muxed.path, {
        ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      const target = loudnessReport.target;
      loudnessReport.delivered = {
        source: 'master mp4 (aac 192k)',
        I: delivered.integratedLufs,
        TP: delivered.truePeakDbtp,
        LRA: delivered.lra,
        iWithinHalfLu: delivered.integratedLufs !== null && Math.abs(delivered.integratedLufs - target.I) <= 0.5,
        tpWithinTarget: delivered.truePeakDbtp !== null && delivered.truePeakDbtp <= target.TP,
        summary: delivered.summary,
      };
    }

    // 烧录版也走同一套校验：尺寸/帧率/时长/音轨任何一项对不上都不许当成品交出去。
    /** @type {any} */
    let subbedReport = null;
    if (subbed) {
      const subProbe = await probeMedia(subbed.path, opts.ffprobePath ? { ffprobePath: opts.ffprobePath } : {});
      const subVerified = await verifyOutput(subbed.path, expected, {
        ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}),
        ...(opts.ffprobePath ? { ffprobePath: opts.ffprobePath } : {}),
      });
      if (!subVerified.ok) {
        await fs.unlink(subbed.path).catch(() => {});
        throw new FilmPlanError(
          'OUTPUT_UNVERIFIED',
          `subbed: ${subVerified.mismatches.map((m) => `${m.field}: ${String(m.actual)} != ${String(m.expected)}`).join('; ')}`,
        );
      }
      subbedReport = {
        path: subbed.path,
        bytes: subbed.bytes,
        sha256: subbed.sha256,
        frames: subbedVideo ? subbedVideo.frames : video.frames,
        durationSec: subbedVideo ? subbedVideo.durationSec : video.durationSec,
        video: subbedVideo ? { bytes: subbedVideo.bytes, sha256: subbedVideo.sha256 } : null,
        probe: subProbe,
        decode: subVerified.decode,
      };
    }

    return {
      path: muxed.path,
      bytes: muxed.bytes,
      sha256: muxed.sha256,
      frames: video.frames,
      durationSec: video.durationSec,
      video: { bytes: video.bytes, sha256: video.sha256 },
      pictureSource: capture !== null ? 'stage' : 'ffmpeg',
      codec: describeCodec(codec),
      quality: { name: level.name, crf: fmt.crf, preset: fmt.preset, pixFmt: fmt.pixFmt },
      // A6：plan 与结果里都要能读到最终像素格式与 profile（auto 时是档位解析后的值）
      pixelFormat: { mode: resolvePixFmtMode(opts.pixFmtMode), pixFmt: fmt.pixFmt, profile: fmt.profile },
      ...(subbedReport ? { subtitles: subbedReport } : {}),
      audio: muxed.audioReport
        ? {
            clips: muxed.audioReport.clips.length,
            durationSec: muxed.audioReport.durationSec,
            peak: muxed.audioReport.peak,
          }
        : null,
      ...(loudnessReport ? { loudness: loudnessReport } : {}),
      probe,
      decode: verified.decode,
    };
  } catch (err) {
    if (produced) await fs.unlink(produced).catch(() => {});
    throw err;
  } finally {
    // R8-F6：无声视频是**中间件**不是产物。有音轨时 muxWithVideo 只做流拷贝，
    // 那份 .video.partial.mp4 不会被消费掉；以前只有 catch 里删，成功路径就把它
    // 留在输出目录里（用户看到两个文件、分不清哪个是成品）。放到 finally 里，
    // 成功/失败都只剩成品。无音轨时 commitOutput 已经把它重命名成成品，
    // 这里的 unlink 是 no-op。
    await fs.unlink(videoPartial).catch(() => {});
    // 烧录版的中间件同理：只留成品，不留 .video.partial.mp4
    if (subbedPartial) await fs.unlink(subbedPartial).catch(() => {});
    // 混音中间件（mix.wav）不留在系统临时目录
    await fs.rm(mixDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 产物摘要（CLI 输出用，避免把整份 probe 灌进 stdout）。
 * @param {any} result
 */
export function summarizeFilmExport(result) {
  return {
    path: result.path,
    bytes: result.bytes,
    sha256: result.sha256,
    frames: result.frames,
    durationSec: result.durationSec,
    audio: result.audio,
    ...(result.loudness ? { loudness: summarizeLoudness(result.loudness) } : {}),
    ...(result.pictureSource ? { picture: result.pictureSource } : {}),
    ...(result.codec ? { codec: result.codec } : {}),
    ...(result.pixelFormat ? { pixelFormat: result.pixelFormat } : {}),
    ...(result.quality ? { quality: result.quality } : {}),
    ...(result.subtitles
      ? {
          subtitles: {
            path: result.subtitles.path,
            bytes: result.subtitles.bytes,
            sha256: result.subtitles.sha256,
            frames: result.subtitles.frames,
            durationSec: result.subtitles.durationSec,
          },
        }
      : {}),
  };
}

/**
 * 兼容副本（P20）：同一次导出顺手再产一份 **4:2:0 / veryfast / crf20** 的 mp4。
 *
 * 为什么需要它：`standard` 档为了让 p99≤8 用了 4:4:4，而 High 4:4:4 Predictive
 * 在不少播放器/硬解上放不出来。用户要发朋友圈/微信/剪映时需要的是一份"哪儿都能播"
 * 的文件，而不是再导一次（再导要重新取帧，几分钟）。
 *
 * 关键：**不重新取帧**。PNG 序列在导出过程中本来就有，这里只是拿同一批帧用另一组
 * 编码参数再编一次 + 混一次音 + 封一次装，成本约等于一次纯编码（900 帧 ≈ 6s）。
 *
 * 只在显式要求时调用；默认路径一行都不走（A4：不加开关时行为不变）。
 *
 * @param {{
 *   plan: any,
 *   outPath: string,
 *   framesDir?: string,
 *   pattern?: string,
 *   frames?: number,
 *   ffmpegPath?: string,
 *   ffprobePath?: string,
 *   signal?: AbortSignal,
 *   loudness?: 'off' | 'streaming' | 'broadcast',
 * }} opts `framesDir` 给了就从 PNG 序列编；没给就退回 ffmpeg 按计划合成
 * @returns {Promise<any>}
 */
export async function renderCompatCopy(opts) {
  const { plan, outPath } = opts;
  const videoPartial = /\.mp4$/i.test(outPath)
    ? outPath.replace(/\.mp4$/i, '.video.partial.mp4')
    : `${outPath}.video.partial.mp4`;
  const mixDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-compat-'));
  /** @type {string} */
  let produced = '';

  try {
    /** @type {{ path: string, frames: number, durationSec: number, bytes: number, sha256: string }} */
    let video;
    if (opts.framesDir) {
      video = await renderFilmVideoFromFrames({
        framesDir: opts.framesDir,
        ...(opts.pattern ? { pattern: opts.pattern } : {}),
        frames: Number(opts.frames ?? plan.frames),
        fps: plan.fpsRational ?? plan.fps ?? 30,
        width: Number(plan.stage.w),
        height: Number(plan.stage.h),
        outPath: videoPartial,
        preset: 'veryfast',
        crf: 20,
        pixFmt: 'yuv420p',
        ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } else {
      video = await renderFilmVideo({
        plan,
        outPath: videoPartial,
        preset: 'veryfast',
        crf: 20,
        pixFmt: 'yuv420p',
        ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    }

    /** @type {any} */
    let muxed;
    if (plan.audioMix) {
      const mixed = await renderMix(plan.audioMix, {
        outWav: path.join(mixDir, 'mix.wav'),
        ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      // 兼容副本是「同一部片子的另一份编码」，响度必须与母版一致：
      // 母版 −14 LUFS、兼容副本 −21 LUFS 会让人以为是两个作品。
      let audioPath = mixed.path;
      if (opts.loudness && opts.loudness !== 'off') {
        const normalized = await normalizeLoudness({
          wavPath: mixed.path,
          outPath: path.join(mixDir, 'mix.loudnorm.wav'),
          preset: /** @type {'streaming' | 'broadcast'} */ (opts.loudness),
          ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        audioPath = normalized.path;
      }
      muxed = await muxWithVideo(videoPartial, audioPath, outPath, {
        ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}),
        ...(opts.ffprobePath ? { ffprobePath: opts.ffprobePath } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      muxed.audioReport = mixed.report;
    } else {
      const finalPath = await commitOutput(videoPartial, outPath);
      const digest = await fileDigest(finalPath);
      muxed = { path: finalPath, bytes: digest.bytes, sha256: digest.sha256, probe: null, audioReport: null };
    }
    produced = muxed.path;

    const probe = await probeMedia(muxed.path, opts.ffprobePath ? { ffprobePath: opts.ffprobePath } : {});
    const expected = {
      videoCodec: 'h264',
      width: Number(plan.stage.w),
      height: Number(plan.stage.h),
      fps: rateOfFps(plan.fpsRational ?? plan.fps ?? 30).value,
      durationSec: Number(plan.outputDuration ?? plan.duration),
      durationToleranceSec: 1 / rateOfFps(plan.fpsRational ?? plan.fps ?? 30).value + 0.001,
      ...(plan.audioMix ? { audioCodec: 'aac', channels: 2, sampleRate: 48000, requireAudio: true } : {}),
    };
    const verified = await verifyOutput(muxed.path, expected, {
      ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}),
      ...(opts.ffprobePath ? { ffprobePath: opts.ffprobePath } : {}),
    });
    if (!verified.ok) {
      await fs.unlink(muxed.path).catch(() => {});
      produced = '';
      throw new FilmPlanError(
        'OUTPUT_UNVERIFIED',
        verified.mismatches.map((m) => `${m.field}: ${String(m.actual)} != ${String(m.expected)}`).join('; '),
      );
    }

    return {
      path: muxed.path,
      bytes: muxed.bytes,
      sha256: muxed.sha256,
      frames: video.frames,
      durationSec: video.durationSec,
      quality: { name: 'compat', crf: 20, preset: 'veryfast', pixFmt: 'yuv420p' },
      probe,
      decode: verified.decode,
    };
  } catch (err) {
    if (produced) await fs.unlink(produced).catch(() => {});
    throw err;
  } finally {
    await fs.unlink(videoPartial).catch(() => {});
    await fs.rm(mixDir, { recursive: true, force: true }).catch(() => {});
  }
}
