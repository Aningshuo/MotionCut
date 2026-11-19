/**
 * 视频自带的音轨（M35 · R21）——识别、是否已分离、分离计划。全是纯函数。
 *
 * ## 方言里怎么表达「同一个 mp4 的声音」
 *
 * `<audio src="assets/x.mp4#t=0,3">`。`film-doc.mjs` 有专门分支：
 *
 * ```js
 * if (kind === 'sound' && actual === 'video') clip.sound = true;
 * ```
 *
 * 也就是「用 `<audio>` 装一个视频文件」是**既有的合法写法**（投影里 `sound: true`），
 * 不新增属性、不改方言。渲染侧本来就把 `kind==='sound'` 收进混音、按 `src` 直接
 * `ffmpeg -i`（容器里的音轨 ffmpeg 自己会挑），所以这条路零改动就能出音轨。
 *
 * ## 为什么不导出一份 wav
 *
 * 复制媒体会让工程体积翻倍、也对不上「同一素材」这件事：用户改了视频片段的
 * `at` / `time`，那份 wav 不会跟着走。指向同一个文件则天然同步，`#t=` 一致即可。
 *
 * ## 两个坑（实测）
 *
 * 1. `insert` 的 clip 必须**同时**给 `kind:'sound'` 与 `sound:true`：前者决定写回
 *    哪个标签（`<audio>`），后者让写回后的重新解析与目标 doc 逐字段相等——
 *    少了它 `writeValue` 会报 `UNKNOWN_FIELD`（「写回后的文档与目标值不一致」）。
 * 2. `src` **不要**自己拼 `#t=`，区间走 `clip.time`：两边都给会写成一坨
 *    `#t=0,3#t=0,3`（`BAD_TIME`）。写回时由 `film-doc.mjs` 统一拼。
 */

/** 视频容器后缀（与 `ops.mjs` 的 `KIND_BY_EXT` 同口径，这里只关心「视频容器」）。 */
const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi']);

const EPS = 1e-3;

/** @param {unknown} value @returns {number} */
function numOf(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 去掉 `#t=` 与查询串。 @param {unknown} src */
export function bareSrcOf(src) {
  const value = String(src ?? '');
  const cut = value.search(/[?#]/);
  return cut < 0 ? value : value.slice(0, cut);
}

/** 扩展名（小写、不带点）。 @param {unknown} src */
function extOf(src) {
  const bare = bareSrcOf(src);
  const dot = bare.lastIndexOf('.');
  return dot < 0 ? '' : bare.slice(dot + 1).toLowerCase();
}

/** 是不是视频容器。 @param {unknown} src */
export function isVideoSrc(src) {
  return VIDEO_EXT.has(extOf(src));
}

/** 片段类型（与 `ops.mjs` 的 `clipKindOf` 同口径，只读投影上的字段）。 @param {any} clip */
export function kindOfClip(clip) {
  const declared = clip?.kind;
  if (declared === 'video' || declared === 'sound' || declared === 'page' || declared === 'still') return declared;
  const ext = extOf(clip?.src);
  if (['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'].includes(ext)) return 'sound';
  if (['html', 'htm'].includes(ext)) return 'page';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'svg'].includes(ext)) return 'still';
  return 'video';
}

/**
 * 遍历所有片段。
 * @param {any} doc
 * @returns {Array<{ clip: any, trackIndex: number, track: any }>}
 */
export function allClipsOf(doc) {
  /** @type {Array<{ clip: any, trackIndex: number, track: any }>} */
  const out = [];
  const tracks = Array.isArray(doc?.tracks) ? doc.tracks : [];
  tracks.forEach((/** @type {any} */ track, /** @type {number} */ trackIndex) => {
    for (const clip of Array.isArray(track?.clips) ? track.clips : []) out.push({ clip, trackIndex, track });
  });
  return out;
}

/**
 * 按 id 找片段。
 * @param {any} doc @param {unknown} clipId
 * @returns {{ clip: any, trackIndex: number, track: any } | null}
 */
export function findClipOf(doc, clipId) {
  const id = String(clipId ?? '');
  if (id === '') return null;
  return allClipsOf(doc).find((item) => String(item.clip?.id) === id) ?? null;
}

/** @param {any} clip */
function spanOf(clip) {
  const time = Array.isArray(clip?.time) ? clip.time : null;
  if (time === null) return null;
  const from = numOf(time[0]);
  const to = time.length > 1 ? numOf(time[1]) : from;
  const speed = typeof clip?.speed === 'number' && clip.speed > 0 ? clip.speed : 1;
  return { from, to, length: (to - from) / speed };
}

/**
 * 找「已经是这个视频的音频孪生」的 sound 片段。
 *
 * 判据（四条全中）：`kind==='sound'`、`bareSrc` 相同、`at` 相同、`time` 区间相同。
 * 只认「同一段」：用户自己另加一段指向同一个 mp4 但区间不同的声音，不算孪生
 * （那是他自己要的第二条声，不该被「已分离」吞掉）。
 *
 * @param {any} doc @param {any} videoClip
 * @returns {any | null}
 */
export function audioTwinOf(doc, videoClip) {
  const bare = bareSrcOf(videoClip?.src);
  if (bare === '') return null;
  const at = numOf(videoClip?.at);
  const span = spanOf(videoClip);
  for (const { clip } of allClipsOf(doc)) {
    if (String(clip?.id) === String(videoClip?.id)) continue;
    if (kindOfClip(clip) !== 'sound') continue;
    if (bareSrcOf(clip.src) !== bare) continue;
    if (Math.abs(numOf(clip.at) - at) > EPS) continue;
    const other = spanOf(clip);
    // 视频没有区间（读不出时长）时只比 at + 源：不能再要求区间相等。
    if (span !== null && other !== null) {
      if (Math.abs(other.from - span.from) > EPS || Math.abs(other.to - span.to) > EPS) continue;
    } else if (span !== null || other !== null) {
      continue;
    }
    return clip;
  }
  return null;
}

/**
 * 这个视频片段的音轨现状。
 *
 * @param {any} doc @param {any} clip
 * @returns {{ status: 'not-video'|'split'|'pending'|'no-span', twin: any | null, reason: string }}
 */
export function audioSplitOf(doc, clip) {
  if (clip === null || clip === undefined) {
    return { status: 'not-video', twin: null, reason: '没有片段' };
  }
  if (kindOfClip(clip) !== 'video') {
    return { status: 'not-video', twin: null, reason: `不是视频片段（${kindOfClip(clip)}）` };
  }
  if (!isVideoSrc(clip.src)) {
    return { status: 'not-video', twin: null, reason: '源不是视频容器' };
  }
  const twin = audioTwinOf(doc, clip);
  if (twin !== null) {
    return { status: 'split', twin, reason: `已分离出 ${String(twin.id)}` };
  }
  if (spanOf(clip) === null) {
    return { status: 'no-span', twin: null, reason: '片段没有时间区间（源时长未知），不知道要分离哪一段' };
  }
  return { status: 'pending', twin: null, reason: '含音轨，尚未分离' };
}

/**
 * 分离出来的声音片段 id：`<视频 id>-audio`，撞了就加序号。
 * @param {any} doc @param {string} videoId
 */
export function splitAudioIdOf(doc, videoId) {
  const used = new Set(allClipsOf(doc).map((item) => String(item.clip?.id)));
  const base = `${videoId}-audio`;
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/**
 * 计划「分离音频」：一条 `insert` Op，指向**同一个文件**、`at`/`time` 与视频一致。
 *
 * 不改视频片段：它在舞台上本来就强制 `muted`（`content-origin.mjs` 的 `playMedia`），
 * 分离出来的 `<audio>` 才是出声的那条；一次 `/ops` → 一步撤销可回原。
 *
 * @param {any} doc @param {unknown} clipId
 * @returns {{ ok: true, ops: any[], clipId: string, videoId: string, src: string, at: number, time: [number, number], volume: number }
 *   | { ok: false, code: string, message: string, videoId: string }}
 */
export function planSplitAudioOps(doc, clipId) {
  const found = findClipOf(doc, clipId);
  if (found === null) {
    return { ok: false, code: 'CLIP_NOT_FOUND', message: `找不到片段 ${String(clipId)}`, videoId: String(clipId ?? '') };
  }
  const video = found.clip;
  const state = audioSplitOf(doc, video);
  if (state.status === 'not-video') {
    return { ok: false, code: 'NOT_VIDEO', message: `只对视频片段分离音频：${state.reason}`, videoId: String(video.id) };
  }
  if (state.status === 'split') {
    return { ok: false, code: 'ALREADY_SPLIT', message: `已经分离过了（${String(state.twin?.id)}），不重复生成`, videoId: String(video.id) };
  }
  if (state.status === 'no-span') {
    return { ok: false, code: 'NO_TIME_SPAN', message: state.reason, videoId: String(video.id) };
  }

  const span = /** @type {{from: number, to: number}} */ (spanOf(video));
  const at = numOf(video.at);
  const id = splitAudioIdOf(doc, String(video.id));
  const speed = typeof video.speed === 'number' && video.speed > 0 ? video.speed : null;

  /** @type {any} */
  const clip = {
    id,
    // 两个都要：`kind` 决定写回哪个标签，`sound` 让写回后的重新解析与目标逐字段相等。
    kind: 'sound',
    sound: true,
    src: bareSrcOf(video.src),
    time: [span.from, span.to],
    volume: 1,
  };
  if (at !== 0) clip.at = at;
  // 视频变速过就跟着变：否则时间线长度对不上，声音会拖尾/提前结束。
  if (speed !== null && Math.abs(speed - 1) > 1e-9) clip.speed = speed;

  /** @type {any} */
  const op = { op: 'insert', clip, at };

  return {
    ok: true,
    ops: [op],
    clipId: id,
    videoId: String(video.id),
    src: bareSrcOf(video.src),
    at,
    time: [span.from, span.to],
    volume: 1,
  };
}
