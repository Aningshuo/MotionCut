/**
 * 时间线手势 → Op 批（纯函数，UI 只负责画 `placed` 与发送 `ops`）。
 *
 * 一个手势 = 一批 Op = 一次写 = 一步撤销。所有函数都不改入参，只返回
 * `{ ops, placed }`：`ops` 交给 `studio/server/edit-session.mjs` 落盘，
 * `placed` 用来在松手前就把片段画在新位置。
 */

import { snapSeconds } from '../../../../film-core/ripple.mjs';
import { clipSpan, pixelsToSeconds, roundMs, snapSecondsToFrame, sourceTimeAt } from './geometry.mjs';

/** 拖动/裁剪的最小可编辑长度：一帧（29.97 下约 33.37ms）。 */
/** @param {{ num: number, den: number }|undefined} fps */
function minLengthOf(fps) {
  return (fps?.den ?? 1) / (fps?.num ?? 30);
}

/**
 * @typedef {{ start: number, end: number, track: number } | null} Placed
 * @typedef {{ time: number, edge: 'start'|'end' }} SnapGuide
 * @typedef {{ targets: readonly number[], toleranceSec: number }} Magnetic
 * @typedef {{ ops: any[], placed: Record<string, Placed>, shortMs?: number, guide?: SnapGuide|null }} Plan
 */

/**
 * 磁吸：把「起点贴目标」和「终点贴目标」都算一遍，取偏差更小的那个。
 * `toleranceSec` 由调用方按**像素**阈值换算（阈值 ≤ 8px），这里只做秒空间比较。
 *
 * @param {{ at: number, length: number, magnetic?: Magnetic }} input
 * @returns {{ at: number, guide: SnapGuide|null }}
 */
function applyMagnetic(input) {
  const magnetic = input.magnetic;
  if (magnetic === undefined || magnetic === null || !Array.isArray(magnetic.targets) || magnetic.targets.length === 0) {
    return { at: input.at, guide: null };
  }
  const tolerance = Number(magnetic.toleranceSec);
  if (!Number.isFinite(tolerance) || tolerance <= 0) return { at: input.at, guide: null };
  const startSnap = snapSeconds({ value: input.at, targets: magnetic.targets, tolerance });
  const endSnap = snapSeconds({ value: input.at + input.length, targets: magnetic.targets, tolerance });
  // 一样近时优先「起点贴目标」：剪辑时更常对齐入点。
  if (startSnap.target !== null && (endSnap.target === null || startSnap.distance <= endSnap.distance)) {
    return { at: startSnap.value, guide: { time: startSnap.target, edge: 'start' } };
  }
  if (endSnap.target !== null) {
    return { at: Math.max(0, roundMs(endSnap.value - input.length)), guide: { time: endSnap.target, edge: 'end' } };
  }
  return { at: input.at, guide: null };
}


/**
 * 水平拖动：只改 `at`；给了 `targetTrack` 就同时换轨（同一批里字段先于换轨，互不踩）。
 *
 * `magnetic` 给了就做磁吸（起点/终点取更近的那个），命中后把落点**再吸附到帧**——
 * 落盘的值永远是整帧，29.97 也一样。
 * @param {{
 *   clip: any, track: number, deltaPx: number, pxPerSecond: number,
 *   targetTrack?: number, fps?: { num: number, den: number }, snap?: boolean,
 *   magnetic?: Magnetic,
 * }} input
 * @returns {Plan}
 */
export function planMove(input) {
  const { clip, track, deltaPx, pxPerSecond } = input;
  const delta = pixelsToSeconds(deltaPx, pxPerSecond);
  const span = clipSpan(clip);
  const length = span.length;
  const raw = Math.max(0, Number(clip.at ?? 0) + delta);
  const snapped = applyMagnetic({ at: raw, length, magnetic: input.magnetic });
  let at = roundMs(Math.max(0, snapped.at));
  if ((input.snap === true || snapped.guide !== null) && input.fps !== undefined) at = snapSecondsToFrame(at, input.fps);
  const targetTrack = input.targetTrack;
  /** @type {any[]} */
  const edits = [{ clip: clip.id, prop: 'at', value: at }];
  if (targetTrack !== undefined && targetTrack !== track) edits.push({ clip: clip.id, prop: 'track', value: targetTrack });
  return {
    ops: [{ op: 'props', edits }],
    placed: { [clip.id]: { start: at, end: roundMs(at + length), track: targetTrack ?? track } },
    guide: snapped.guide,
  };
}

/**
 * 边缘拖拽：左手柄改 `start` 与 `at`（画面内容不动），右手柄只改 `end`。
 * 两端都保留至少一帧，且不越过另一端。`magnetic` 只作用在**正在拖的那条边**上。
 * @param {{
 *   clip: any, track: number, edge: 'start'|'end', deltaPx: number, pxPerSecond: number,
 *   fps?: { num: number, den: number }, sourceEnd?: number|null, magnetic?: Magnetic,
 *   snap?: boolean,
 * }} input
 * @returns {Plan}
 */
export function planTrim(input) {
  const { clip, track, edge, deltaPx, pxPerSecond } = input;
  const speed = typeof clip.speed === 'number' && clip.speed > 0 ? clip.speed : 1;
  const time = Array.isArray(clip.time) ? /** @type {number[]} */ (clip.time) : [0, 0];
  const from = Number(time[0]);
  const to = Number(time[1]);
  const min = minLengthOf(input.fps);
  const delta = pixelsToSeconds(deltaPx, pxPerSecond);

  if (edge === 'start') {
    const span = clipSpan(clip);
    const magnet = applyMagnetic({ at: span.start + delta, length: 0, magnetic: input.magnetic });
    const guide = magnet.guide;
    let at = roundMs(Math.max(0, magnet.at));
    if ((input.snap === true || guide !== null) && input.fps !== undefined) at = snapSecondsToFrame(at, input.fps);
    // 起点移动多少，源入点就跟着移多少（画面内容原地不动）。
    const shift = roundMs(at - span.start);
    const maxFrom = Math.max(0, to - min * speed);
    const nextFrom = Math.min(maxFrom, Math.max(0, roundMs(from + shift * speed)));
    const realShift = roundMs((nextFrom - from) / speed);
    const finalAt = roundMs(Math.max(0, span.start + realShift));
    return {
      ops: [{ op: 'props', edits: [{ clip: clip.id, prop: 'start', value: nextFrom }, { clip: clip.id, prop: 'at', value: finalAt }] }],
      placed: { [clip.id]: { start: finalAt, end: roundMs(finalAt + (to - nextFrom) / speed), track } },
      guide: nextFrom === from ? null : guide,
    };
  }

  const spanEndTime = clipSpan(clip).end;
  const magnet = applyMagnetic({ at: spanEndTime + delta, length: 0, magnetic: input.magnetic });
  let guideEnd = magnet.guide;
  let wantEnd = roundMs(Math.max(0, magnet.at));
  if ((input.snap === true || guideEnd !== null) && input.fps !== undefined) wantEnd = snapSecondsToFrame(wantEnd, input.fps);
  const minTo = roundMs(from + min * speed);
  let maxTo = input.sourceEnd === undefined || input.sourceEnd === null ? Infinity : Number(input.sourceEnd);
  maxTo = Math.max(minTo, maxTo);
  // 时间线终点 → 源出点：时间线每前进 1 秒，源里前进 speed 秒。
  const nextTo = Math.min(maxTo, Math.max(minTo, roundMs(from + (wantEnd - clipSpan(clip).start) * speed)));
  const at = Number(clip.at ?? 0);
  return {
    ops: [{ op: 'props', edits: [{ clip: clip.id, prop: 'end', value: nextTo }] }],
    placed: { [clip.id]: { start: at, end: roundMs(at + (nextTo - from) / speed), track } },
    // 拖的是右手柄：参考线永远标在「终点」这条边上。
    guide: guideEnd === null ? null : { time: guideEnd.time, edge: 'end' },
  };
}

/**
 * 切刀：在时间线 `at` 处把片段切两半。两半的源区间由这里算（引擎不做业务推断），
 * 淡入留给左半、淡出留给右半由 `applyOps` 的 `split` 负责。
 * @param {{ clip: any, track: number, at: number, fps?: { num: number, den: number }, rightId?: string }} input
 * @returns {Plan}
 */
export function planSplit(input) {
  const { clip, track, at } = input;
  const time = Array.isArray(clip.time) ? /** @type {number[]} */ (clip.time) : null;
  const span = clipSpan(clip);
  if (time === null || at <= span.start || at >= span.end) {
    return { ops: [], placed: {}, shortMs: 0 };
  }
  const cut = roundMs(at);
  const sourceCut = /** @type {number} */ (sourceTimeAt(clip, cut));
  return {
    ops: [
      {
        op: 'split',
        clip: clip.id,
        at: cut,
        left: { end: sourceCut },
        right: { start: sourceCut, at: cut },
        ...(input.rightId === undefined ? {} : { rightId: input.rightId }),
      },
    ],
    placed: {
      [clip.id]: { start: span.start, end: cut, track },
      [`${clip.id}-b`]: { start: cut, end: span.end, track },
    },
  };
}

/**
 * 复制（粘贴时用）：按片段当前的样子复制，粘贴位置由 `planPaste` 决定。
 * @param {any[]} clips
 */
export function planCopy(clips) {
  return clips.map((clip) => structuredClone(clip));
}

/**
 * 粘贴：以 `at` 为落点（最早那一条对齐到 `at`），原 id 不带过去（由引擎按 src 生成可复现 id）。
 * @param {{ clips: any[], at: number, track?: number, link?: string|null }} input
 * @returns {Plan}
 */
export function planPaste(input) {
  const clips = input.clips;
  if (clips.length === 0) return { ops: [], placed: {} };
  const base = Math.min(...clips.map((/** @type {any} */ clip) => Number(clip.at ?? 0)));
  /** @type {any[]} */
  const ops = [];
  /** @type {Record<string, Placed>} */
  const placed = {};
  for (const clip of clips) {
    const at = roundMs(Math.max(0, input.at + (Number(clip.at ?? 0) - base)));
    const copy = structuredClone(clip);
    // 复制品带一个可预期的 id（引擎发现被占用时会退回按 src 生成的可复现 id）。
    copy.id = `${clip.id}-copy`;
    // 单条粘贴不带 link（否则会牵动原片段）；整组粘贴由调用方给新的 link。
    if (input.link === undefined || input.link === null) delete copy.link;
    else copy.link = input.link;
    ops.push({ op: 'insert', clip: copy, at, ...(input.track === undefined ? {} : { track: input.track }) });
    placed[`paste:${ops.length}`] = { start: at, end: roundMs(at + clipSpan(clip).length), track: input.track ?? 0 };
  }
  return { ops, placed };
}

/**
 * 删除：`remove` 一批。链接片段（同一 `link`）一起删——这是「链接」的语义，不是隐藏规则。
 * @param {{ clips: any[] }} input
 * @returns {Plan}
 */
export function planDelete(input) {
  const ids = expandLinks(input.clips);
  return {
    ops: ids.map((id) => ({ op: 'remove', clip: id })),
    placed: Object.fromEntries(ids.map((id) => [id, null])),
  };
}

/**
 * 选中集合里的链接组：给了任何一条，整组都在。
 * @param {any[]} clips @param {string[]} [ids]
 * @returns {string[]}
 */
export function expandLinks(clips, ids) {
  const chosen = ids === undefined ? clips.map((/** @type {any} */ clip) => clip.id) : ids;
  /** @type {Set<string>} */
  const links = new Set();
  for (const clip of clips) {
    if (chosen.includes(clip.id) && typeof clip.link === 'string' && clip.link !== '') links.add(clip.link);
  }
  /** @type {string[]} */
  const out = [...chosen];
  for (const clip of clips) {
    if (typeof clip.link === 'string' && links.has(clip.link) && !out.includes(clip.id)) out.push(clip.id);
  }
  return out;
}

/**
 * 链接：给一组片段写同一个 `data-link`。
 * @param {{ ids: string[], group: string }} input
 * @returns {Plan}
 */
export function planLink(input) {
  return {
    ops: [{ op: 'props', edits: input.ids.map((id) => ({ clip: id, prop: 'link', value: input.group })) }],
    placed: {},
  };
}

/**
 * 解链：只清被选中的那些（同组的其它条目不动）。
 * @param {{ ids: string[] }} input
 * @returns {Plan}
 */
export function planUnlink(input) {
  return {
    ops: [{ op: 'props', edits: input.ids.map((id) => ({ clip: id, prop: 'link', value: null })) }],
    placed: {},
  };
}

/**
 * 多选批量改属性：一条 `props`，只落在选中的片段上。
 * @param {{ ids: string[], prop: string, value: any }} input
 * @returns {Plan}
 */
export function planBatchProp(input) {
  return {
    ops: [{ op: 'props', edits: input.ids.map((id) => ({ clip: id, prop: input.prop, value: input.value })) }],
    placed: {},
  };
}

/**
 * 拖到另一条轨道（纯换轨，不改时间）。
 * @param {{ clip: any, track: number, targetTrack: number }} input
 * @returns {Plan}
 */
export function planMoveTrack(input) {
  const span = clipSpan(input.clip);
  return {
    ops: [{ op: 'props', edits: [{ clip: input.clip.id, prop: 'track', value: input.targetTrack }] }],
    placed: { [input.clip.id]: { start: span.start, end: span.end, track: input.targetTrack } },
  };
}

/**
 * Plan one move for all selected and linked clips. The grabbed clip supplies the
 * common snap offset; every clip keeps its relative time and layer position.
 * @param {{ tracks: any[], ids: string[], anchorId: string, targetTrack: number,
 *   deltaPx: number, pxPerSecond: number, fps: {num: number, den: number},
 *   magnetic?: Magnetic, protectedIds?: string[], copy?: boolean }} input
 * @returns {Plan & {message: string}}
 */
export function planSelectionMove(input) {
  const { tracks, ids, anchorId } = input;
  const rows = tracks.flatMap(track => track.clips.map((/** @type {any} */ clip) => ({ track, clip })));
  const byId = new Map(rows.map(row => [row.clip.id, row]));
  const anchor = byId.get(anchorId);
  const chosen = new Set(ids);
  const items = ids.map(id => byId.get(id)).filter(row => row !== undefined);
  const reject = (/** @type {string} */ message) => ({ ops: [], placed: {}, guide: null, message });
  if (!anchor || items.length !== ids.length || items.length === 0) return reject('片段或轨道已变动');
  const shiftTrack = input.targetTrack - anchor.track.index;
  const byTrack = new Map(tracks.map(track => [track.index, track]));
  const earliest = Math.min(...items.map(({clip}) => Number(clip.at ?? 0)));
  const anchorAt = Number(anchor.clip.at ?? 0);
  const requested = planMove({
    clip: anchor.clip, track: anchor.track.index, deltaPx: input.deltaPx, pxPerSecond: input.pxPerSecond,
    fps: input.fps, snap: true, magnetic: input.magnetic,
  });
  const anchorPlaced = requested.placed[anchorId];
  if (anchorPlaced === null || anchorPlaced === undefined) return reject('无法计算移动位置');
  const delta = roundMs(Math.max(-earliest, anchorPlaced.start - anchorAt));
  if (!input.copy && (delta || shiftTrack) && input.protectedIds?.some(id => chosen.has(id))) {
    return reject('请先移除相连的转场，再移动片段');
  }
  /** @type {Record<string, Placed>} */
  const placed = {};
  /** @type {any[]} */
  const edits = [];
  for (const { track, clip } of items) {
    const nextIndex = track.index + shiftTrack;
    const nextTrack = byTrack.get(nextIndex);
    if (track.locked || !nextTrack || nextTrack.locked) return reject('目标或选中的轨道不可编辑');
    if (shiftTrack !== 0 && ((clip.kind === 'sound') !== (nextTrack.role === 'audio'))) {
      return reject('音频与画面片段需要放到对应的轨道');
    }
    const span = clipSpan(clip);
    const start = roundMs(span.start + delta);
    const end = roundMs(start + span.length);
    if (!Number.isFinite(end) || span.length <= 0) return reject('片段的时长不可用');
    // An edited transition may already overlap; a drag cannot increase that overlap.
    for (const other of nextTrack.clips) {
      if (!input.copy && chosen.has(other.id)) continue;
      const bounds = clipSpan(other);
      const oldOverlap = !input.copy && shiftTrack === 0 ? Math.max(0, Math.min(span.end, bounds.end) - Math.max(span.start, bounds.start)) : 0;
      const newOverlap = Math.max(0, Math.min(end, bounds.end) - Math.max(start, bounds.start));
      if (newOverlap > oldOverlap + 0.001) return reject('该位置已有片段，请换一个位置或轨道');
    }
    placed[clip.id] = { start, end, track: nextIndex };
    if (start !== span.start) edits.push({ clip: clip.id, prop: 'at', value: start });
    if (nextIndex !== track.index) edits.push({ clip: clip.id, prop: 'track', value: nextIndex });
  }
  return {
    ops: edits.length > 0 ? [{ op: 'props', edits }] : [],
    placed,
    guide: delta === roundMs(anchorPlaced.start - anchorAt) ? requested.guide ?? null : null,
    message: '',
  };
}

/** Edge retiming holds the source interval fixed and preserves the opposite timeline edge.
 * @param {{clip:any, track:number, edge:'start'|'end', deltaPx:number, pxPerSecond:number, fps:{num:number,den:number}, magnetic?: Magnetic}} input
 * @returns {Plan}
 */
export function planSpeedEdge(input) {
  const span = clipSpan(input.clip);
  const speed = Number(input.clip.speed ?? 1);
  const sourceDuration = span.length * speed;
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) return { ops: [], placed: {} };
  let edge = input.edge === 'start' ? span.start : span.end;
  const next = applyMagnetic({ at: edge + pixelsToSeconds(input.deltaPx, input.pxPerSecond), length: 0, magnetic: input.magnetic });
  const candidate = snapSecondsToFrame(Math.max(0, next.at), input.fps);
  const min = Math.max(minLengthOf(input.fps), sourceDuration / 16);
  const max = sourceDuration / 0.0625;
  const wanted = input.edge === 'start' ? span.end - candidate : candidate - span.start;
  const length = Math.min(input.edge === 'start' ? Math.min(max, span.end) : max, Math.max(min, wanted));
  if (!(length >= min)) return { ops: [], placed: {} };
  const start = input.edge === 'start' ? roundMs(span.end - length) : span.start;
  const end = input.edge === 'end' ? roundMs(span.start + length) : span.end;
  const nextSpeed = sourceDuration / (end - start);
  if (Math.abs(nextSpeed - speed) < 1e-6 && start === span.start) return { ops: [], placed: {} };
  /** @type {any[]} */
  const edits = [{ clip: input.clip.id, prop: 'speed', value: nextSpeed }];
  if (start !== span.start) edits.push({ clip: input.clip.id, prop: 'at', value: start });
  return {
    ops: [{ op: 'props', edits }], placed: { [input.clip.id]: { start, end, track: input.track } },
    guide: next.guide && (input.edge === 'start' ? start : end) === candidate ? { time: next.guide.time, edge: input.edge } : null,
  };
}
