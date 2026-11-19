/** Plans context-menu edits against one FilmDoc revision. The caller commits one batch through /ops. */
import { applyOpsDetailed } from './ops.mjs';
import { hasClipKeyframes, isClipDisabled } from './clip-state.mjs';
import { mainTrackIndex, spanOf } from './ripple.mjs';
import { fpsValue, frameSeconds } from './snap-magnet.mjs';
import { allClipsOf } from './track-audio.mjs';
import { listAppliedTransitions, TRANSITION_ATTRIBUTE } from './transition-presets.mjs';

/** @typedef {ReturnType<typeof allClipsOf>[number]} Row */
/** @typedef {{clip: any, trackIndex: number, role: string}} Copy */
/** @typedef {{start: number, end: number, length: number}} Span */
/** @typedef {{ok: boolean, ops: any[], ids: string[], code?: string, message?: string}} Result */
const EPS = 0.001;

/** @param {number} time */
const ms = (time) => Math.round(time * 1000) / 1000;

/** @param {string} code @param {string} message @returns {Result} */
const fail = (code, message) => ({ ok: false, code, message, ops: [], ids: [] });

/** @param {any[]} ops @param {string[]} [ids] @returns {Result} */
const success = (ops, ids = []) => ops.length ? { ok: true, ops, ids } : fail('NOTHING', '当前没有可执行的轨道修改');

/** @param {Row[]} rows @param {readonly string[]} ids */
function selectedRows(rows, ids) {
  const selected = new Set(ids);
  const groups = new Set(rows.filter(({ clip }) => selected.has(clip.id) && clip.link).map(({ clip }) => clip.link));
  return rows.filter(({ clip }) => selected.has(clip.id) || (clip.link && groups.has(clip.link)));
}

/** @param {Row[]} rows */
function usedIdentities(rows) {
  return new Set(rows.flatMap(({ clip }) => [clip.id, clip.link]).filter(Boolean));
}

/** @param {Set<string>} used @param {string} base */
function uniqueId(used, base) {
  const stem = /^[A-Za-z][\w-]*$/.test(base) ? base : 'clip';
  let id = stem;
  for (let n = 2; used.has(id); n += 1) id = `${stem}-${n}`;
  used.add(id);
  return id;
}

/**
 * Deep snapshot; no mutable source references escape to the user's clipboard.
 * @param {{doc: any, ids: readonly string[]}} input
 * @returns {{ok: true, clipboard: Copy[]} | {ok: false, code: string, message: string}}
 */
export function copyTimelineClips({ doc, ids }) {
  const rows = allClipsOf(doc);
  const chosen = selectedRows(rows, ids);
  if (chosen.length === 0 || ids.some((id) => !chosen.some(({clip}) => clip.id === id))) {
    return { ok: false, code: 'NOT_FOUND', message: '找不到要复制的片段' };
  }
  return {
    ok: true,
    clipboard: chosen.map(({ clip, trackIndex, track }) => ({ clip: structuredClone(clip), trackIndex, role: track.role })),
  };
}

/** @param {any} doc @param {Row[]} rows @param {Copy[]} copies @param {number} [at] @param {number} [track] @param {boolean} [duplicate] */
function planInsertCopies(doc, rows, copies, at, track, duplicate = false) {
  if (!copies.length) return fail('EMPTY_CLIPBOARD', '还没有复制片段');
  const spans = copies.map((row) => spanOf(row.clip));
  if (spans.some((span) => !(span.length > 0))) return fail('NO_SPAN', '片段缺少明确的源区间');
  const first = Math.min(...spans.map((span) => span.start));
  const firstTrack = Math.min(...copies.map((copy) => copy.trackIndex));
  const destinations = copies.map((copy) => track === undefined ? copy.trackIndex : track + copy.trackIndex - firstTrack);
  for (const [index, copy] of copies.entries()) {
    const target = doc.tracks[destinations[index] ?? -1];
    if (!target || target.role !== copy.role) return fail('TRACK_TYPE', '目标轨道和复制的轨道类型不一致');
    if (target.locked) return fail('LOCKED', '目标轨道已锁定');
  }
  const base = duplicate ? Math.max(...spans.map((span) => span.end)) : ms(frameSeconds(Number(at), doc.fps));
  if (!(base >= 0 && Number.isFinite(base))) return fail('INVALID_TIME', '粘贴位置无效');
  const lanes = new Set(destinations);
  if (rows.some(({ trackIndex, clip }) => lanes.has(trackIndex) && !(spanOf(clip).length > 0))) {
    return fail('NO_SPAN', '目标轨有时长未知的片段，无法确认是否会重叠');
  }
  /** @type {any[]} */
  const preceding = [];
  /** @type {Map<string, number>} */
  const moves = new Map();
  let placedRows = rows;
  if (duplicate) {
    const crossing = rows.filter(({ clip, trackIndex }) => {
      const span = spanOf(clip);
      return lanes.has(trackIndex) && span.start < base - EPS && span.end > base + EPS;
    });
    // Cut an existing clip at the insertion seam before shifting its right half.
    let splitDoc = doc;
    if (crossing.length > 0) {
      const linked = selectedRows(rows, crossing.map(({ clip }) => clip.id));
      if (linked.some(({ track: lane }) => lane.locked)) return fail('LOCKED', '腾位需要切分锁定轨道上的链接片段');
      const split = planSplitAt(doc, rows, linked, base);
      if (!split.ok) return split;
      preceding.push(...split.ops);
      splitDoc = applyOpsDetailed(doc, split.ops).value;
      placedRows = allClipsOf(splitDoc);
    }
    const width = ms(base - first);
    for (const { clip, trackIndex } of placedRows) {
      if (lanes.has(trackIndex) && spanOf(clip).start >= base - EPS) moves.set(clip.id, width);
    }
    if (moves.size > 0) {
      const shift = finishRipple(splitDoc, placedRows, moves, new Map(), new Set());
      if (!shift.ok) return shift;
      preceding.push(...shift.ops);
    }
  }
  for (const [index, span] of spans.entries()) {
    const start = ms(base + span.start - first);
    for (const existing of placedRows) {
      if (existing.trackIndex !== destinations[index]) continue;
      const other = spanOf(existing.clip);
      const offset = moves.get(existing.clip.id) ?? 0;
      if (start + span.length > other.start + offset + EPS && start < other.end + offset - EPS) {
        return fail('OVERLAP', duplicate ? '副本插入后仍与目标轨素材重叠' : '粘贴会覆盖目标轨已有片段');
      }
    }
  }

  const used = usedIdentities(placedRows);
  /** @type {Map<string, string>} */
  const links = new Map();
  const ops = copies.map((copy, index) => {
    const clip = structuredClone(copy.clip);
    clip.id = uniqueId(used, `${clip.id}-copy`);
    if (clip.link) {
      if (!links.has(clip.link)) links.set(clip.link, uniqueId(used, `${clip.link}-copy`));
      clip.link = links.get(clip.link);
    }
    // The preset owns a specific pair of IDs and absolute timeline interval.
    if (clip.attrs?.[TRANSITION_ATTRIBUTE]) {
      delete clip.attrs[TRANSITION_ATTRIBUTE];
      if (!Object.keys(clip.attrs).length) delete clip.attrs;
    }
    return { op: 'insert', clip, at: ms(base + spanOf(clip).start - first), track: destinations[index] };
  });
  return success([...preceding, ...ops], ops.map(({clip}) => clip.id));
}

/** @param {Span[]} spans */
function mergeIntervals(spans) {
  /** @type {Span[]} */
  const merged = [];
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && span.start <= last.end + EPS) {
      last.end = Math.max(span.end, last.end);
      last.length = last.end - last.start;
    } else merged.push({ ...span });
  }
  return merged;
}

/** @param {Span[]} remove @param {Span[]} keep */
function uncoveredCuts(remove, keep) {
  const occupied = mergeIntervals(keep);
  /** @type {Span[]} */
  const cuts = [];
  for (const area of mergeIntervals(remove)) {
    let start = area.start;
    for (const span of occupied) {
      if (span.end <= start) continue;
      if (span.start >= area.end) break;
      if (span.start > start + EPS) cuts.push({ start, end: span.start, length: span.start - start });
      start = Math.max(start, span.end);
    }
    if (area.end > start + EPS) cuts.push({ start, end: area.end, length: area.end - start });
  }
  return cuts;
}

/** @param {Row[]} lane @param {Span[]} cuts @param {Map<string,number>} moves */
function shiftAfterCuts(lane, cuts, moves) {
  for (const { clip } of lane) {
    const start = spanOf(clip).start;
    const shift = ms(cuts.filter((cut) => cut.end <= start + EPS).reduce((sum, cut) => sum + cut.length, 0));
    if (shift > EPS) moves.set(clip.id, -shift);
  }
}

/** @param {any} doc @param {Row[]} rows @param {Map<string,number>} moves @param {Map<string,number[]>} trims @param {Set<string>} removals */
function finishRipple(doc, rows, moves, trims, removals) {
  /** @type {Map<string,number>} */
  const groupMove = new Map();
  for (const { clip } of rows) {
    if (!clip.link || !moves.has(clip.id)) continue;
    const offset = moves.get(clip.id) ?? 0;
    const existing = groupMove.get(clip.link);
    if (existing !== undefined && Math.abs(existing - offset) > EPS) {
      return fail('LINK_CONFLICT', '不同轨道的波纹位移会使链接片段失去同步');
    }
    groupMove.set(clip.link, offset);
  }
  for (const { clip, track } of rows) {
    const offset = groupMove.get(clip.link);
    if (offset === undefined || removals.has(clip.id)) continue;
    if (track.locked) return fail('LOCKED', '波纹操作会移动锁定轨道里的链接片段');
    if (spanOf(clip).start + offset < -EPS) return fail('LINK_CONFLICT', '波纹位移会把链接片段移到时间线起点之前');
    moves.set(clip.id, offset);
  }
  const touched = new Set([...moves.keys(), ...trims.keys(), ...removals]);
  for (const { from, to } of listAppliedTransitions(doc)) {
    if ((touched.has(from) || touched.has(to)) && !(removals.has(from) && removals.has(to))) {
      return fail('TRANSITION_ACTIVE', '先移除受影响的转场，再执行该波纹操作');
    }
  }

  // A ripple may preserve an intentional overlap; it may not introduce or enlarge one.
  for (const { clip, track } of rows) {
    if (!moves.has(clip.id) || removals.has(clip.id)) continue;
    for (const peer of track.clips) {
      if (peer.id === clip.id || removals.has(peer.id)) continue;
      const a = spanOf(clip);
      const b = spanOf(peer);
      if (!(a.length > 0 && b.length > 0)) return fail('NO_SPAN', '同轨存在时长未知的片段，无法校验波纹结果');
      const before = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
      const changedA = spanOf({ ...clip, time: trims.get(clip.id) ?? clip.time, at: a.start + (moves.get(clip.id) ?? 0) });
      const changedB = spanOf({ ...peer, time: trims.get(peer.id) ?? peer.time, at: b.start + (moves.get(peer.id) ?? 0) });
      const after = Math.max(0, Math.min(changedA.end, changedB.end) - Math.max(changedA.start, changedB.start));
      if (after > before + EPS) return fail('OVERLAP', '波纹操作会覆盖同轨的另一段素材');
    }
  }
  const ops = [...removals].map((clip) => ({ op: 'remove', clip }));
  const edits = rows.flatMap(({ clip }) => {
    const time = trims.get(clip.id);
    const move = moves.get(clip.id);
    return [
      ...(time ? [{ clip: clip.id, prop: 'time', value: time }] : []),
      ...(move === undefined ? [] : [{ clip: clip.id, prop: 'at', value: ms(Math.max(0, spanOf(clip).start + move)) }]),
    ];
  });
  return success([...ops, ...(edits.length ? [{ op: 'props', edits }] : [])], [...trims.keys()]);
}

/** @param {any} doc @param {Row[]} rows @param {Row[]} picked @param {number} at */
function planSplitAt(doc, rows, picked, at) {
  /** @type {Set<string>} */
  const participants = new Set();
  for (const transition of listAppliedTransitions(doc)) {
    participants.add(transition.from);
    participants.add(transition.to);
  }
  const used = usedIdentities(rows);
  /** @type {Map<string,string>} */
  const rightLinks = new Map();
  const ops = [];
  const ids = [];
  for (const { clip } of picked) {
    const span = spanOf(clip);
    const sourceIn = Number(clip.time?.[0]), sourceOut = Number(clip.time?.[1]);
    const sourceCut = ms(sourceIn + (at - span.start) * (clip.speed ?? 1));
    if (!(at > span.start + EPS && at < span.end - EPS && sourceCut > sourceIn && sourceCut < sourceOut)) {
      return fail('PLAYHEAD_OUTSIDE_CLIP', '播放头须在每个选中或链接片段的有效区间内');
    }
    if (hasClipKeyframes(clip)) return fail('KEYFRAMES_ACTIVE', '此片段含关键帧，需先处理动画关键帧再分割');
    if (participants.has(clip.id)) return fail('TRANSITION_ACTIVE', '先移除该片段的转场，再分割');
    const rightId = uniqueId(used, `${clip.id}-b`);
    const hasLinkedPeer = clip.link && picked.some((row) => row.clip.id !== clip.id && row.clip.link === clip.link);
    if (hasLinkedPeer && !rightLinks.has(clip.link)) {
      rightLinks.set(clip.link, uniqueId(used, `${clip.link}-right`));
    }
    ops.push({
      op: 'split', clip: clip.id, at, rightId,
      left: { end: sourceCut },
      right: { start: sourceCut, at, ...(clip.link ? { link: rightLinks.get(clip.link) ?? null } : {}) },
    });
    ids.push(rightId);
  }
  return success(ops, ids);
}

/** @param {any} doc @param {Row[]} rows @param {readonly string[]} ids @param {number} at */
function planSelectedSplit(doc, rows, ids, at) {
  const frame = 1 / fpsValue(doc.fps);
  /** @param {Row} row */
  const crosses = ({ clip }) => {
    const { start, end } = spanOf(clip);
    const sourceIn = Number(clip.time?.[0]), sourceOut = Number(clip.time?.[1]);
    const sourceCut = ms(sourceIn + (at - start) * (clip.speed ?? 1));
    return at - start >= frame - EPS && end - at >= frame - EPS && sourceCut > sourceIn && sourceCut < sourceOut;
  };
  let targets = ids;
  if (targets.length === 0) {
    const visible = rows.filter((row) => !row.track.hidden && !row.track.locked && !isClipDisabled(row.clip) && crosses(row));
    const main = mainTrackIndex(doc.tracks.filter((/** @type {Row['track']} */ track) => !track.hidden));
    const target = visible.find(({ track, trackIndex }) => (track.index ?? trackIndex) === main) ?? visible[0];
    targets = target ? [target.clip.id] : [];
  }
  const crossing = selectedRows(rows, targets).filter(crosses);
  const locked = crossing.filter(({ track }) => track.locked);
  const lockedLinks = new Set(locked.map(({ clip }) => clip.link).filter(Boolean));
  const picked = crossing.filter(({ clip, track }) => !track.locked && !lockedLinks.has(clip.link));
  if (picked.length === 0) {
    return locked.length ? fail('LOCKED', '播放头处的片段或其链接片段位于锁定轨道')
      : fail('PLAYHEAD_OUTSIDE_CLIP', '播放头所在位置没有可分割的片段');
  }
  return planSplitAt(doc, rows, picked, at);
}

/**
 * `track` is the addressed track index; `at` is an absolute timeline second.
 * Clips and linked groups are addressed explicitly, independent of React selection changes.
 * @param {{doc: any, action: string, ids?: readonly string[], track?: number, at?: number, clipboard?: Copy[]}} input
 * @returns {Result}
 */
export function planTimelineAction({ doc, action, ids = [], track, at, clipboard = [] }) {
  const rows = allClipsOf(doc);
  if (action === 'paste') return planInsertCopies(doc, rows, clipboard, at, track);
  if (action === 'split') {
    if (!Number.isFinite(at)) return fail('INVALID_TIME', '播放头位置无效');
    return planSelectedSplit(doc, rows, ids, ms(frameSeconds(Number(at), doc.fps)));
  }

  /** @type {Map<string, number>} */
  const moves = new Map();
  /** @type {Map<string, number[]>} */
  const trims = new Map();
  /** @type {Set<string>} */
  const removals = new Set();
  if (action === 'close-gap' || action === 'close-all-gaps') {
    const lane = rows.filter((row) => row.trackIndex === track);
    if (!lane.length) return fail('NOT_FOUND', '找不到有片段的轨道');
    if (lane[0]?.track.locked) return fail('LOCKED', '轨道已锁定');
    const spans = lane.map(({ clip }) => spanOf(clip));
    if (spans.some((span) => !(span.length > 0))) return fail('NO_SPAN', '该轨有时长未知的片段');
    let end = 0;
    const cuts = mergeIntervals(spans).flatMap((span) => {
      const start = end;
      end = span.end;
      return span.start > start + EPS ? [{ start, end: span.start, length: span.start - start }] : [];
    });
    const picked = action === 'close-all-gaps' ? cuts : cuts.filter((cut) => Number(at) >= cut.start && Number(at) < cut.end);
    shiftAfterCuts(lane, picked, moves);
    return finishRipple(doc, rows, moves, trims, removals);
  }

  const picked = selectedRows(rows, ids);
  if (!picked.length || ids.some((id) => !picked.some(({clip}) => clip.id === id))) {
    return fail('NOT_FOUND', '找不到选中的片段');
  }
  if (picked.some(({ track: lane }) => lane.locked)) return fail('LOCKED', '所选片段或其链接片段位于锁定轨道');
  if (action === 'duplicate') {
    const copied = copyTimelineClips({ doc, ids });
    return copied.ok ? planInsertCopies(doc, rows, copied.clipboard, undefined, undefined, true) : fail(copied.code, copied.message);
  }

  if (action === 'delete' || action === 'ripple-delete') {
    for (const { clip } of picked) removals.add(clip.id);
    if (action === 'ripple-delete') {
      for (const laneIndex of new Set(picked.map((row) => row.trackIndex))) {
        const lane = rows.filter((row) => row.trackIndex === laneIndex);
        const keep = lane.filter(({clip}) => !removals.has(clip.id));
        const remove = lane.filter(({clip}) => removals.has(clip.id));
        if (lane.some(({clip}) => !(spanOf(clip).length > 0))) return fail('NO_SPAN', '该轨有时长未知的片段');
        const cuts = uncoveredCuts(remove.map(({clip}) => spanOf(clip)), keep.map(({clip}) => spanOf(clip)));
        shiftAfterCuts(keep, cuts, moves);
      }
    }
    return finishRipple(doc, rows, moves, trims, removals);
  }

  if (!Number.isFinite(at)) return fail('INVALID_TIME', '播放头位置无效');
  const cut = ms(frameSeconds(Number(at), doc.fps));
  if (action !== 'ripple-trim-start' && action !== 'ripple-trim-end') return fail('UNKNOWN_ACTION', '不支持的轨道操作');
  if (new Set(picked.map((row) => row.trackIndex)).size !== picked.length) {
    return fail('AMBIGUOUS_SELECTION', '每条轨道只可同时波纹裁剪一个片段');
  }
  /** @type {Map<string,number>} */
  const trimmedByGroup = new Map();
  if (picked.some(({ clip }) => hasClipKeyframes(clip))) {
    return fail('KEYFRAMES_ACTIVE', '所选片段含关键帧，需先处理动画关键帧再波纹裁剪');
  }
  // On each affected lane the kept part starts at the original at. Subsequent clips move
  // by the removed duration only; pre-existing gaps and earlier clips retain their timing.
  for (const { clip, trackIndex } of picked) {
    const span = spanOf(clip);
    const sourceIn = Number(clip.time?.[0]), sourceOut = Number(clip.time?.[1]);
    const speed = Number(clip.speed ?? 1);
    const sourceCut = ms(sourceIn + (cut - span.start) * speed);
    if (!(cut > span.start + EPS && cut < span.end - EPS && sourceCut > sourceIn && sourceCut < sourceOut)) {
      return fail('PLAYHEAD_OUTSIDE_CLIP', '播放头须在每个选中或链接片段的有效区间内');
    }
    const time = action === 'ripple-trim-start' ? [sourceCut, sourceOut] : [sourceIn, sourceCut];
    const length = (time[1] ?? sourceOut) - (time[0] ?? sourceIn);
    const removed = ms(span.length - length / speed);
    if (clip.link) {
      const previous = trimmedByGroup.get(clip.link);
      if (previous !== undefined && Math.abs(removed - previous) > EPS) {
        return fail('LINK_CONFLICT', '链接片段起止不同，波纹裁剪会改变它们的相对同步');
      }
      trimmedByGroup.set(clip.link, removed);
    }
    trims.set(clip.id, time);
    shiftAfterCuts(rows.filter((row) => row.trackIndex === trackIndex && row.clip.id !== clip.id),
      [{ start: span.start + length / speed, end: span.end, length: removed }], moves);
  }
  return finishRipple(doc, rows, moves, trims, removals);
}
