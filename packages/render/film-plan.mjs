/**
 * 从 FilmDoc 推导导出计划（P11）。
 *
 * 这一层**不做 DSP、不渲染**：只把 film.html 里「哪一段用哪个素材的哪几秒」
 * 读成稳定的计划对象，交给 `film-export.mjs` 渲染、`audio-mix.mjs` 混音。
 *
 * 口径（与合同 v1.2.0 一致）：
 * - 轨道 = `<section>`，`index` 0 在最上层；`muted` 轨整条不进入音频。
 * - **`hidden` 轨整条跳过**（P35）：画面与声音都不进计划，并留一条 warning。
 * - **`locked` 轨只影响编辑**（P35）：导出侧不看它。
 * - **`solo` 不是方言属性**（P35）：导出不看独奏；要只导一条轨请用 `--range` 或隐藏。
 * - 片段 = `<iframe>`(page) / `<video>` / `<img>`(still) / `<audio>`(sound)。
 * - 源入出点来自 `src` 的 `#t=in,out`（单值 `#t=in` = 到结尾），没有 `time` 属性。
 * - 时间线位置 `at`，变速 `speed`，音量 `volume`，淡入淡出 `fade`（片段自有覆盖）。
 * - 影片时长 = max(at + (out-in)/speed)；没有 `#t=` 的用源真实时长，**探测不到就报错，不猜**。
 *   **隐藏轨也参与时长计算**：它占着时间线，只是不画（否则「隐藏最长的一条」会悄悄缩短成片）。
 * - `range` 缺省 `[0, duration]`；越界报 `INVALID_RANGE`，不静默截。
 * - 多段 `ranges`（P36）：按给出顺序拼接，帧对齐规则见 `timeline-range.mjs` 文件头。
 *
 * 安全：所有媒体 `src` 先去 `#t=`，相对路径拼 `projectRoot`，**逐字与 realpath 两道**
 * 都必须在工程内；越界 `E_PATH_ESCAPE`，不存在 `MEDIA_MISSING`。URL 不猜、不联网。
 *
 * 网页片段（page）进 `sceneClips` 并标 `requiresStage: true`：它们**能导出**，但只能由
 * 舞台逐帧画（`stage-capture.mjs`），ffmpeg 合成路径画不了。
 * 没有 capture 却带着网页片段时，`film-export.mjs` 仍然在开渲染前拒绝
 * （`UNSUPPORTED_SCENE_CLIP`）——那是"这条路径不支持"，不是"这个片段不支持"。
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { promisify } from 'node:util';

import { rateOfFps } from './fps.mjs';
import { JOIN_FADE_SEC, TimelineRangeError, buildTimeline, normalizeRanges } from './timeline-range.mjs';
import { TRANSITION_ATTRIBUTE, requiresTransitionStage, transitionSpecOf } from '../film-core/transition-presets.mjs';
import { isClipDisabled } from '../film-core/clip-state.mjs';
import { parseSeconds } from '../film-core/time.mjs';
import { creationClipStyle, requiresCreationStyleStage } from '../film-core/creation-style-stage.mjs';

const execFileAsync = promisify(execFile);

/** 采样率/声道沿用混音层的白名单。 */
export const FILM_SAMPLE_RATE = 48000;
export const FILM_CHANNELS = 2;

const RANGE_EPS = 1e-6;

/**
 * 计划阶段的稳定错误码（CLI 会原样透出）。
 * @typedef {'E_PATH_ESCAPE' | 'MEDIA_MISSING' | 'MEDIA_DURATION_UNKNOWN' | 'INVALID_RANGE' | 'INVALID_FILM' | 'EMPTY_FILM' | 'UNSUPPORTED_SCENE_CLIP' | 'UNSUPPORTED' | 'OUTPUT_UNVERIFIED'} FilmPlanErrorCode
 */

export class FilmPlanError extends Error {
  /**
   * @param {FilmPlanErrorCode} code
   * @param {string} detail
   * @param {{ clipId?: string, cause?: unknown }} [extra]
   */
  constructor(code, detail, extra = {}) {
    super(`${code}: ${detail}`);
    this.name = 'FilmPlanError';
    this.code = code;
    this.detail = detail;
    if (extra.clipId !== undefined) this.clipId = extra.clipId;
    if (extra.cause !== undefined) this.cause = extra.cause;
  }
}

/**
 * @param {string} a
 * @param {string} p
 */
function isInside(a, p) {
  const rel = path.relative(a, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 媒体源解析：`src` → 工程内绝对路径（realpath）。
 * @param {string} src
 * @param {{ projectRoot: string, realRoot?: string, clipId: string }} ctx
 * @returns {Promise<string>}
 */
async function resolveMedia(src, ctx) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(src) || src.startsWith('data:')) {
    throw new FilmPlanError('MEDIA_MISSING', `clip ${ctx.clipId}: remote/data URLs are not supported (${src})`, {
      clipId: ctx.clipId,
    });
  }
  const lexicalRoot = path.resolve(ctx.projectRoot);
  const abs = path.isAbsolute(src) ? path.resolve(src) : path.resolve(lexicalRoot, src);
  if (!isInside(lexicalRoot, abs)) {
    throw new FilmPlanError('E_PATH_ESCAPE', `clip ${ctx.clipId}: ${src} escapes the project root`, {
      clipId: ctx.clipId,
    });
  }

  let real;
  try {
    real = await fs.realpath(abs);
  } catch (err) {
    throw new FilmPlanError('MEDIA_MISSING', `clip ${ctx.clipId}: ${src} does not exist`, {
      clipId: ctx.clipId,
      cause: err,
    });
  }
  const realRoot = ctx.realRoot ?? (await fs.realpath(lexicalRoot));
  if (!isInside(realRoot, real)) {
    throw new FilmPlanError('E_PATH_ESCAPE', `clip ${ctx.clipId}: ${src} resolves outside the project root`, {
      clipId: ctx.clipId,
    });
  }
  const stat = await fs.stat(real);
  if (!stat.isFile()) {
    throw new FilmPlanError('MEDIA_MISSING', `clip ${ctx.clipId}: ${src} is not a file`, { clipId: ctx.clipId });
  }
  return real;
}

/**
 * @typedef {Object} SourceInfo
 * @property {number | null} durationSec
 * @property {number | null} width
 * @property {number | null} height
 * @property {boolean} hasAudio 源里有没有音频流（探不到一律 false：不猜）
 */

/**
 * ffprobe 只读取时长/尺寸；失败或没有时长 → 调用方决定报什么。
 * @param {string} file
 * @param {{ ffprobePath?: string }} [opts]
 * @returns {Promise<SourceInfo>}
 */
export async function probeSource(file, opts = {}) {
  try {
    const { stdout } = await execFileAsync(opts.ffprobePath ?? 'ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      file,
    ]);
    const parsed = JSON.parse(stdout);
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const video = streams.find((/** @type {any} */ s) => s.codec_type === 'video');
    const duration = Number(parsed.format?.duration ?? video?.duration);
    return {
      durationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
      width: Number.isFinite(Number(video?.width)) ? Number(video.width) : null,
      height: Number.isFinite(Number(video?.height)) ? Number(video.height) : null,
      hasAudio: streams.some((/** @type {any} */ s) => s.codec_type === 'audio'),
    };
  } catch {
    return { durationSec: null, width: null, height: null, hasAudio: false };
  }
}

/**
 * 一个片段在**源内**占多长（秒），以及它的时间线长度。
 * @param {{ time?: readonly number[], speed?: number, kind?: string }} clip
 * @param {number | null} native
 * @returns {{ inSec: number, outSec: number, span: number } | null}
 */
function sourceSpan(clip, native) {
  const speed = Number.isFinite(clip.speed) && Number(clip.speed) > 0 ? Number(clip.speed) : 1;
  const time = Array.isArray(clip.time) ? clip.time : null;
  if (time !== null && time.length >= 2) {
    const [from, to] = time;
    if (!(Number(to) > Number(from))) return null;
    return { inSec: Number(from), outSec: Number(to), span: (Number(to) - Number(from)) / speed };
  }
  if (native === null) return null;
  const from = time !== null && time.length === 1 ? Number(time[0]) : 0;
  if (!(native > from)) return null;
  return { inSec: from, outSec: native, span: (native - from) / speed };
}

/**
 * @param {any} clip
 * @returns {boolean}
 */
function isMutedClip(clip) {
  return clip?.muted === true;
}

/**
 * 影片总时长（所有片段 at + span 的最大值）。
 * @param {any} doc
 * @param {{ projectRoot: string, ffprobePath?: string, native?: Map<string, number | null> }} opts
 * @returns {Promise<number>}
 */
export async function filmDuration(doc, opts) {
  const clips = allClips(doc);
  if (clips.length === 0) throw new FilmPlanError('EMPTY_FILM', 'film.html has no clips');
  const realRoot = await fs.realpath(path.resolve(opts.projectRoot));
  const cache = opts.native ?? new Map();
  let duration = 0;
  for (const { clip, track } of clips) {
    void track;
    const kind = clip.kind ?? 'video';
    const declaredDuration = parseSeconds(clip.attrs?.['data-native']);
    const disabledSpan = isClipDisabled(clip) ? sourceSpan(clip, declaredDuration) : null;
    let native = null;
    if (!disabledSpan && kind !== 'page' && kind !== 'still') {
      const real = await resolveMedia(clip.src, { projectRoot: opts.projectRoot, realRoot, clipId: clip.id });
      native = await nativeDuration(real, cache, opts.ffprobePath);
    }
    const span = disabledSpan ?? sourceSpan(clip, native);
    if (span === null) {
      throw new FilmPlanError(
        'MEDIA_DURATION_UNKNOWN',
        `clip ${clip.id}: cannot determine duration (no #t=out and no probed source duration)`,
        { clipId: clip.id },
      );
    }
    const at = Number.isFinite(clip.at) ? Number(clip.at) : 0;
    duration = Math.max(duration, at + span.span);
  }
  return round(duration, 6);
}

/**
 * @param {string} real
 * @param {Map<string, number | null>} cache
 * @param {string | undefined} ffprobePath
 */
async function nativeDuration(real, cache, ffprobePath) {
  if (cache.has(real)) return cache.get(real) ?? null;
  const info = await probeSource(real, ffprobePath ? { ffprobePath } : {});
  cache.set(real, info.durationSec);
  return info.durationSec;
}

/**
 * 源里有没有音频流（按**真实路径**缓存；与 `nativeDuration` 各一张表，别互相覆盖类型）。
 * @param {string} real
 * @param {Map<string, boolean>} cache
 * @param {string | undefined} ffprobePath
 */
async function nativeHasAudio(real, cache, ffprobePath) {
  if (cache.has(real)) return cache.get(real) === true;
  const info = await probeSource(real, ffprobePath ? { ffprobePath } : {});
  const has = info.hasAudio === true;
  cache.set(real, has);
  return has;
}

/**
 * @param {any} doc
 * @returns {Array<{ clip: any, track: any }>}
 */
function allClips(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.tracks)) {
    throw new FilmPlanError('INVALID_FILM', 'doc.tracks must be an array');
  }
  /** @type {Array<{ clip: any, track: any }>} */
  const out = [];
  for (const track of doc.tracks) {
    const clips = Array.isArray(track?.clips) ? track.clips : [];
    for (const clip of clips) out.push({ clip, track });
  }
  return out;
}

/**
 * 轨道的稳定标签：`id` 属性优先，其次 `name`，最后用序号。
 * 只用于 warning 文案，不参与任何渲染决策。
 * @param {any} track
 */
function trackLabel(track) {
  const id = track?.attrs?.id;
  if (typeof id === 'string' && id.length > 0) return id;
  if (typeof track?.name === 'string' && track.name.length > 0) return track.name;
  const index = Number.isInteger(track?.index) ? track.index : '?';
  return `#${index}`;
}

/**
 * 片段与某一拼接段的交集（都是**原片**时间轴的秒）。
 * @param {number} timelineStart
 * @param {number} timelineEnd
 * @param {{ start: number, end: number }} segment
 * @returns {{ takeStart: number, takeEnd: number, outDuration: number } | null}
 */
function clipWindow(timelineStart, timelineEnd, segment) {
  if (timelineEnd <= segment.start + RANGE_EPS || timelineStart >= segment.end - RANGE_EPS) return null;
  const takeStart = Math.max(timelineStart, segment.start);
  const takeEnd = Math.min(timelineEnd, segment.end);
  const outDuration = Math.max(0, takeEnd - takeStart);
  if (outDuration <= RANGE_EPS) return null;
  return { takeStart, takeEnd, outDuration };
}

/**
 * 第一个与 [start,end] 有交集的拼接段，以及它在**成片**里的起点。
 * @param {any[]} segments
 * @param {number} start
 * @param {number} end
 * @returns {{ segment: any, at: number } | null}
 */
function firstOverlap(segments, start, end) {
  for (const segment of segments) {
    const window = clipWindow(start, end, segment);
    if (window === null) continue;
    return { segment, at: round(segment.outStartSec + (window.takeStart - segment.start), 6) };
  }
  return null;
}

/**
 * @param {any} doc
 * @param {{
 *   projectRoot: string,
 *   fps?: number,
 *   fpsRational?: { num: number, den: number },
 *   range?: readonly [number, number],
 *   ranges?: Array<readonly [number, number]>,
 *   ffprobePath?: string,
 *   native?: Map<string, number | null>,
 * }} opts `ranges` 优先于 `range`（CLI 的 `--range` 重复/逗号写法最终都归一到 `ranges`）。
 * `fpsRational`（P42）优先于 `fps`：29.97 必须按 30000/1001 算帧，不然一小时漂 3.6 秒。
 */
export async function planFromFilm(doc, opts) {
  const projectRoot = path.resolve(opts.projectRoot);
  const realRoot = await fs.realpath(projectRoot);
  /* 帧率（P42）：有理数是唯一真值，`fps` 只是它的十进制投影（合同里 fps 仍是 number）。 */
  /** @type {ReturnType<typeof rateOfFps>} */
  const rate = rateOfFps(opts.fpsRational ?? (Number.isFinite(opts.fps) && Number(opts.fps) > 0 ? Number(opts.fps) : 30));
  const fps = rate.value;
  const stage = { w: Number(doc?.stage?.w) || 1920, h: Number(doc?.stage?.h) || 1080 };
  const cache = opts.native ?? new Map();
  /** @type {Map<string, boolean>} 源有没有音频流：与时长缓存分开，类型别混。 */
  const audioProbe = new Map();
  const warnings = [];

  const duration = await filmDuration(doc, {
    projectRoot,
    ...(opts.ffprobePath ? { ffprobePath: opts.ffprobePath } : {}),
    native: cache,
  });

  /** @type {Array<[number, number]>} */
  let ranges;
  /** @type {ReturnType<typeof buildTimeline>} */
  let timeline;
  try {
    ranges = normalizeRanges(
      opts.ranges ?? (opts.range !== undefined ? [opts.range] : undefined),
      duration,
    );
    timeline = buildTimeline(ranges, rate);
  } catch (err) {
    if (err instanceof TimelineRangeError) throw new FilmPlanError('INVALID_RANGE', err.detail);
    throw err;
  }
  const segments = timeline.segments;
  /** @type {{ start: number, end: number }} */
  const firstSegment = /** @type {any} */ (segments[0]);
  /** @type {[number, number]} */
  const firstRange = /** @type {[number, number]} */ (ranges[0]);
  const multi = segments.length > 1;
  const rangeLabel = multi
    ? ranges.map(([start, end]) => `${start}-${end}`).join(', ')
    : `${firstRange[0]}-${firstRange[1]}`;

  // 轨道开关（P35）：hidden 整条跳过；muted 只影响音频（在片段分支里处理）；
  // locked 只影响编辑，导出侧**不看**它（所以这里没有 locked 分支——是刻意的）；
  // solo 不是方言属性（film-doc 的 TRACK_FLAGS 里没有），导出不看独奏。
  /** @type {Set<any>} */
  const hiddenTracks = new Set();
  /** @type {string[]} */
  const hiddenTrackLabels = [];
  for (const track of Array.isArray(doc?.tracks) ? doc.tracks : []) {
    if (track?.hidden === true) {
      hiddenTracks.add(track);
      const label = trackLabel(track);
      hiddenTrackLabels.push(label);
      warnings.push(`track ${label} is hidden; skipped`);
    }
  }

  /** @type {any[]} */
  const visualClips = [];
  /** @type {any[]} */
  const sceneClips = [];
  /** @type {any[]} */
  const audioClips = [];

  const entries = allClips(doc);
  const disabledIds = new Set(entries.filter(({ clip }) => isClipDisabled(clip)).map(({ clip }) => clip.id));
  for (const { clip, track } of entries) {
    if (hiddenTracks.has(track)) continue;
    if (disabledIds.has(clip.id)) {
      warnings.push(`clip ${clip.id} is disabled; skipped`);
      continue;
    }
    const kind = clip.kind ?? 'video';
    const at = Number.isFinite(clip.at) ? Number(clip.at) : 0;
    const speed = Number.isFinite(clip.speed) && Number(clip.speed) > 0 ? Number(clip.speed) : 1;
    const fadeIn = Array.isArray(clip.fade) ? Number(clip.fade[0]) || 0 : 0;
    const fadeOut = Array.isArray(clip.fade) ? Number(clip.fade[1]) || 0 : 0;

    if (kind === 'page') {
      const span = sourceSpan(clip, null);
      if (span === null) {
        warnings.push(`page clip ${clip.id} has no #t=in,out: its duration is unknown`);
        sceneClips.push({
          id: clip.id,
          src: clip.src,
          at: round(Math.max(at, firstSegment.start) - firstSegment.start, 6),
          time: null,
          trackIndex: track.index,
          // R15 之前这里是 `unsupported: 'UNSUPPORTED_SCENE_CLIP'`：字段名在说"渲染不了"，
          // 而实际上从 P13 起舞台取帧就能画它了。名字留着会继续骗人，改成它真正表达的意思。
          requiresStage: true,
        });
        continue;
      }
      if (multi) {
        // 多段时一个网页片段可能横跨两段；sceneClips 只登记一次（舞台按**绝对时间**画，
        // 不靠这张表定位），取第一个命中的段算它在成片里的起点。
        const hit = firstOverlap(segments, at, at + span.span);
        if (hit === null) {
          warnings.push(`clip ${clip.id} is outside range ${rangeLabel}; skipped`);
          continue;
        }
        sceneClips.push({
          id: clip.id,
          src: clip.src,
          at: round(hit.at, 6),
          time: [round(span.inSec, 6), round(span.outSec, 6)],
          trackIndex: track.index,
          requiresStage: true,
        });
      } else {
        // 单段保持 R21 语义：网页片段不做越界裁剪（舞台只认整片时间，越界部分本来也画不到）
        sceneClips.push({
          id: clip.id,
          src: clip.src,
          at: round(Math.max(at, firstSegment.start) - firstSegment.start, 6),
          time: [round(span.inSec, 6), round(span.outSec, 6)],
          trackIndex: track.index,
          requiresStage: true,
        });
      }
      continue;
    }

    let native = null;
    const src = await resolveMedia(clip.src, { projectRoot, realRoot, clipId: clip.id });
    /* R10 / F09：音轨与视频走同一条探测。以前只探 `video`，于是**没有 `#t=` 的音轨**
       必然拿到 `native=null` → `sourceSpan()` 返回 null → 抛 MEDIA_DURATION_UNKNOWN，
       与 `filmDuration()`（它探所有非 page/still）口径不一致。
       `#t=in,out` 仍在 `sourceSpan()` 里先命中，优先级不变；探测不到时长仍是
       `durationSec=null` → 照样抛同一个错误码，**不会**变成"静默猜一个时长"。 */
    if (kind === 'video' || kind === 'sound') native = await nativeDuration(src, cache, opts.ffprobePath);
    /* R189：**画面片段自带的音轨也要进混音**。
       导入侧早就按「没有音轨才 muted」写片段（media-import：没有音轨的视频静音，避免空音轨
       参与混音），混音侧却只收 `kind === 'sound'` → 带声音的 <video> 在成片里被静默丢掉
       音频流（实测：源 aac 44.1kHz 立体声 167.5s，成片 0 条音频流）。判定口径与导入侧一致：
       源真有音频流 + 片段没静音 + 轨道没静音；任一不满足就不加，**不造空音轨**。 */
    const sourceAudio = kind === 'video' ? await nativeHasAudio(src, audioProbe, opts.ffprobePath) : false;
    const videoMuted = sourceAudio && (isMutedClip(clip) || track.muted === true);
    if (videoMuted) {
      // 静音是**决定**，不是无事发生：不写一条警告，用户会以为成片里该有声音。
      warnings.push(
        `video clip ${clip.id} is muted${track.muted === true ? ' (track muted)' : ''}: its audio is not in the mix`,
      );
    }
    const carriesAudio = sourceAudio && !videoMuted;
    // 图片没有内在时长：必须靠 #t=in,out 给出「放多久」，不猜
    const span = sourceSpan(clip, kind === 'still' ? null : native);
    if (span === null) {
      throw new FilmPlanError(
        'MEDIA_DURATION_UNKNOWN',
        `clip ${clip.id}: cannot determine duration (${kind === 'still' ? 'a still needs #t=in,out' : 'no #t=out and no probed duration'})`,
        { clipId: clip.id },
      );
    }

    const timelineStart = at;
    const timelineEnd = at + span.span;
    /** @type {Array<{ segment: any, takeStart: number, takeEnd: number, outDuration: number }>} */
    const windows = [];
    for (const segment of segments) {
      const window = clipWindow(timelineStart, timelineEnd, segment);
      if (window !== null) windows.push({ segment, ...window });
    }
    if (windows.length === 0) {
      warnings.push(`clip ${clip.id} is outside range ${rangeLabel}; skipped`);
      continue;
    }

    if (kind === 'sound' && (isMutedClip(clip) || track.muted === true)) {
      warnings.push(`audio clip ${clip.id} is muted${track.muted === true ? ' (track muted)' : ''}`);
      continue;
    }

    const box = kind === 'sound'
      ? null
      : await normalizeBox(clip, stage, { src, kind, realRoot, projectRoot, ffprobePath: opts.ffprobePath });

    for (const { segment, takeStart, takeEnd, outDuration } of windows) {
      const sourceOffset = (takeStart - timelineStart) * speed;
      const inSec = span.inSec + sourceOffset;
      const outSec = inSec + outDuration * speed;
      const dur6 = round(outDuration, 6);
      const atOut = round(segment.outStartSec + (takeStart - segment.start), 6);
      // 多段拼接的接缝：只有被**切开**的边才算接缝。
      // 单段保持历史行为（不加），所以单段产物与 R21 逐字节相同。
      const cutStart = multi && takeStart > timelineStart + RANGE_EPS;
      const cutEnd = multi && takeEnd < timelineEnd - RANGE_EPS;

      if (kind === 'sound') {
        // 音频接缝补 2ms 斜坡防咔嗒：波形在切点两侧本来就不连续，硬接会有一声"咔"。
        audioClips.push({
          src,
          at: atOut,
          time: [round(inSec, 6), round(outSec, 6)],
          volume: Number.isFinite(clip.volume) ? Number(clip.volume) : 1,
          speed,
          fade: [
            cutStart ? Math.min(JOIN_FADE_SEC, dur6) : Math.min(fadeIn, dur6),
            cutEnd ? Math.min(JOIN_FADE_SEC, dur6) : Math.min(fadeOut, dur6),
          ],
        });
        continue;
      }

      // 画面**不做**接缝淡入淡出：`fade=alpha=1` 的 2ms 斜坡落在 33ms 的一帧上，
      // 段首帧会只剩 ~6% 不透明度 —— 观众看到的是"闪一下黑"，比硬切难看得多。
      // 画面接缝就该是硬切；用户的 fade 也只加在片段的**自然**起止上。
      if (carriesAudio) {
        // 声音走的是**另一门**手艺：接缝要 2ms 斜坡（硬接会"咔"一声），和 `kind==='sound'`
        // 完全同一套口径——否则同一条源当音频片段用和当视频用，听起来是两回事。
        audioClips.push({
          src,
          at: atOut,
          time: [round(inSec, 6), round(outSec, 6)],
          volume: Number.isFinite(clip.volume) ? Number(clip.volume) : 1,
          speed,
          fade: [
            cutStart ? Math.min(JOIN_FADE_SEC, dur6) : Math.min(fadeIn, dur6),
            cutEnd ? Math.min(JOIN_FADE_SEC, dur6) : Math.min(fadeOut, dur6),
          ],
        });
      }
      visualClips.push({
        id: clip.id,
        kind,
        src,
        at: atOut,
        time: [round(inSec, 6), round(outSec, 6)],
        speed,
        duration: dur6,
        box,
        fade: [
          cutStart ? 0 : Math.min(fadeIn, dur6),
          cutEnd ? 0 : Math.min(fadeOut, dur6),
        ],
        trackIndex: track.index,
        ...(creationClipStyle(clip) ? { style: creationClipStyle(clip) } : {}),
      });
    }
  }

  const audioMix =
    audioClips.length > 0
      ? {
          duration: timeline.outputDuration,
          sampleRate: FILM_SAMPLE_RATE,
          channels: FILM_CHANNELS,
          clips: audioClips,
        }
      : null;
  if (audioMix === null) warnings.push('film has no audible clips: audioMix is null (no silent track invented)');

  // Hidden tracks and disabled clips retain their time on the timeline.
  const emptyPicture = visualClips.length === 0 && sceneClips.length === 0
    && (hiddenTrackLabels.length > 0 || entries.some(({ clip }) => disabledIds.has(clip.id) && clip.kind !== 'sound'));
  if (emptyPicture) {
    warnings.push(disabledIds.size > 0
      ? 'all picture clips are hidden or disabled: exporting black frames (duration unchanged)'
      : 'all picture tracks are hidden: exporting black frames (duration unchanged)');
  }

  const stageDoc = disabledIds.size === 0 ? doc : {
    ...doc,
    tracks: doc.tracks.map((/** @type {any} */ track) => ({
      ...track,
      clips: (track.clips ?? []).filter((/** @type {any} */ clip) => !disabledIds.has(clip.id)).map((/** @type {any} */ clip) => {
        const transition = transitionSpecOf(clip);
        if (transition === null || (!disabledIds.has(transition.from) && !disabledIds.has(transition.to))) return clip;
        const attrs = { ...clip.attrs };
        delete attrs[TRANSITION_ATTRIBUTE];
        return { ...clip, attrs };
      }),
    })),
  };

  return {
    fps,
    // P42：帧率的**唯一真值**。`fps` 是它的数值投影（29.97002997…），
    // 需要精确帧格的地方（ffmpeg -r、字幕网格、duration=frames×den/num）一律读这一对。
    fpsRational: { num: rate.num, den: rate.den },
    duration,
    // 历史字段：单段就是那一段；多段只表示**第一段**，完整账在 `ranges` / `segments`。
    range: [firstRange[0], firstRange[1]],
    ranges,
    frameAligned: timeline.frameAligned,
    segments: timeline.segments,
    frames: timeline.frames,
    // 导出窗口长度（range 可能短于整片；渲染/封装/校验都用它）
    outputDuration: timeline.outputDuration,
    stage: { w: stage.w, h: stage.h },
    visualClips,
    sceneClips,
    // CSS/mask/overlay transitions need the same stage pixels as the preview,
    // including a pure-media film with zero HTML page clips.
    ...(requiresTransitionStage(stageDoc) || requiresCreationStyleStage(stageDoc) ? { requiresStage: true } : {}),
    audioMix,
    hiddenTracks: hiddenTrackLabels,
    ...(emptyPicture ? { emptyPicture: true } : {}),
    warnings,
  };
}

/**
 * 只取音轨（R7 复用；不依赖画面计划）。
 * @param {any} doc
 * @param {{ projectRoot: string, range?: readonly [number, number], ranges?: Array<readonly [number, number]>, ffprobePath?: string, native?: Map<string, number | null> }} opts
 */
export async function audioMixFromFilm(doc, opts) {
  const plan = await planFromFilm(doc, { ...opts, fps: 30 });
  return plan.audioMix;
}

/**
 * box 归一化：缺省满幅；给了单边就按源比例补另一边；圆角保留给渲染层报 UNSUPPORTED。
 * @param {any} clip
 * @param {{ w: number, h: number }} stage
 * @param {{ src: string, kind: string, realRoot: string, projectRoot: string, ffprobePath?: string }} ctx
 */
async function normalizeBox(clip, stage, ctx) {
  const box = clip.box && typeof clip.box === 'object' ? clip.box : null;
  if (box === null) return { x: 0, y: 0, w: stage.w, h: stage.h, r: 0 };

  const x = Number.isFinite(box.x) ? Number(box.x) : 0;
  const y = Number.isFinite(box.y) ? Number(box.y) : 0;
  let w = Number.isFinite(box.w) ? Number(box.w) : null;
  let h = Number.isFinite(box.h) ? Number(box.h) : null;
  const r = Number.isFinite(box.r) ? Number(box.r) : 0;

  if (w === null || h === null) {
    const info = await probeSource(ctx.src, ctx.ffprobePath ? { ffprobePath: ctx.ffprobePath } : {});
    const iw = info.width ?? stage.w;
    const ih = info.height ?? stage.h;
    if (w === null && h === null) {
      w = stage.w;
      h = stage.h;
    } else if (w === null) {
      w = (Number(h) * iw) / ih;
    } else {
      h = (Number(w) * ih) / iw;
    }
  }
  return { x, y, w: round(Number(w), 6), h: round(Number(h), 6), r };
}

/**
 * @param {number} value
 * @param {number} digits
 */
function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
