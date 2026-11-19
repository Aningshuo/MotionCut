/**
 * 主轨磁吸 / 波纹的**可调用能力层**（M63 · B-MAIN-R30-031）。
 *
 * `ripple.mjs` 是 2026-06 的纯函数（秒空间、按片段集合算），这一层补三件它没管的事：
 *
 * 1. **像素 → 秒在服务端闭合**：`pxPerSecond`（或 `viewportWidth + durationSec`）与
 *    `tolerancePx` 一起换算出秒容差；任何一个非法值都**显式抛 `SnapError`**，不静默取 0。
 *    理由：磁吸「差 6px 吸附」和「差 0.2 秒吸附」是两件事，把像素容差漏成 0 会让磁吸静默失效。
 * 2. **帧是输出的一部分**：吸附结果给 `frame`，且 `value === frame / fps`（差值恒为 0，
 *    比「1e-6 以内」更硬）。非吸附时也量化到帧，这样调用方不会拿到「帧号对、时间不对」的组合。
 * 3. **主轨严格化**：`mainTrackIndex()` 遇到两条画面轨会挑最后一条（历史行为，UI 这么用）；
 *    波纹插入/删除必须**报错**（`MULTI_MAIN_TRACK`），否则「插到哪条轨」会变成随机。
 *
 * 不读盘、不写盘、不碰 DOM：写盘仍走 `/ops`（M63 的消费者是只读路由 `POST /api/timeline/snap`）。
 *
 * 术语：
 * - `edge = 'start' | 'end'`：**被拖的那一端**；
 * - `mode = 'move'`：整段平移（时长不变，另一端跟着走）；
 * - `mode = 'trim'`：裁剪（另一端钉住，只改被拖这端）。
 */

import { collectSnapTargets, mainTrackIndex, planRippleDelete, planRippleInsert, snapSeconds, spanOf } from './ripple.mjs';

/** 帧号与秒换算的容差（合同口径：1e-6）。 */
export const FRAME_EPS = 1e-6;

/** 时间写回保留的小数位：6 位足够压住 1e-6 判据，又不引入二进制噪声。 */
const TIME_DECIMALS = 6;

/**
 * 磁吸参数/输入非法。`code` 是给 HTTP 层映射 400 用的稳定字符串。
 */
export class SnapError extends Error {
  /**
   * @param {string} message
   * @param {'SNAP_INVALID_TOLERANCE'|'SNAP_INVALID_SCALE'|'SNAP_INVALID_FPS'|'SNAP_INVALID_VALUE'|'SNAP_INVALID_DURATION'} code
   */
  constructor(message, code) {
    super(message);
    this.name = 'SnapError';
    this.code = code;
  }
}

/**
 * `{num, den}` / 数字 / 字符串 → 每秒帧数。
 * @param {{ num?: number, den?: number }|number} fps
 * @returns {number}
 */
export function fpsValue(fps) {
  if (typeof fps === 'number') {
    if (!Number.isFinite(fps) || fps <= 0) throw new SnapError(`fps 非法：${fps}`, 'SNAP_INVALID_FPS');
    return fps;
  }
  const num = Number(fps?.num);
  const den = Number(fps?.den);
  if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) {
    throw new SnapError(`fps 非法：${JSON.stringify(fps)}`, 'SNAP_INVALID_FPS');
  }
  return num / den;
}

/** @param {number} value */
function roundTime(value) {
  const factor = 10 ** TIME_DECIMALS;
  return Math.round(value * factor) / factor;
}

/**
 * 秒 → 帧号（四舍五入）。
 * @param {number} seconds
 * @param {{ num?: number, den?: number }|number} fps
 * @returns {number}
 */
export function frameOf(seconds, fps) {
  return Math.round(Number(seconds) * fpsValue(fps));
}

/**
 * 秒 → 帧对齐后的秒（`frame / fps`，保留 6 位小数，误差 ≤ 5e-7）。
 * @param {number} seconds
 * @param {{ num?: number, den?: number }|number} fps
 * @returns {number}
 */
export function frameSeconds(seconds, fps) {
  const rate = fpsValue(fps);
  const frame = Math.round(Number(seconds) * rate);
  return roundTime(frame / rate);
}

/**
 * 像素容差 → 秒容差。
 *
 * 两种给法二选一：
 * - `{ tolerancePx, pxPerSecond }`；
 * - `{ tolerancePx, viewportWidth, durationSec }`（`pxPerSecond = viewportWidth / durationSec`）。
 *
 * 任一值为非有限、`tolerancePx <= 0`、`pxPerSecond <= 0`、`durationSec <= 0`、`viewportWidth <= 0`
 * 都抛 `SnapError`——磁吸失效必须吵，不许变成「永远不吸附」。
 *
 * @param {{ tolerancePx: number, pxPerSecond?: number, viewportWidth?: number, durationSec?: number }} input
 * @returns {{ tolerancePx: number, toleranceSec: number, pxPerSecond: number, source: 'pxPerSecond'|'viewport' }}
 */
export function toleranceSeconds(input) {
  const tolerancePx = Number(input?.tolerancePx);
  if (!Number.isFinite(tolerancePx) || tolerancePx <= 0) {
    throw new SnapError(`tolerancePx 必须是 > 0 的有限数：${input?.tolerancePx}`, 'SNAP_INVALID_TOLERANCE');
  }

  let pxPerSecond = Number(input?.pxPerSecond);
  /** @type {'pxPerSecond'|'viewport'} */
  let source = 'pxPerSecond';
  if (input?.pxPerSecond !== undefined && input?.pxPerSecond !== null) {
    if (!Number.isFinite(pxPerSecond) || pxPerSecond <= 0) {
      throw new SnapError(`pxPerSecond 必须是 > 0 的有限数：${input.pxPerSecond}`, 'SNAP_INVALID_SCALE');
    }
  } else {
    const viewportWidth = Number(input?.viewportWidth);
    const durationSec = Number(input?.durationSec);
    if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
      throw new SnapError(`viewportWidth 必须是 > 0 的有限数：${input?.viewportWidth}`, 'SNAP_INVALID_SCALE');
    }
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      throw new SnapError(`durationSec 必须是 > 0 的有限数：${input?.durationSec}`, 'SNAP_INVALID_DURATION');
    }
    pxPerSecond = viewportWidth / durationSec;
    source = 'viewport';
  }

  return {
    tolerancePx,
    toleranceSec: tolerancePx / pxPerSecond,
    pxPerSecond,
    source,
  };
}

/**
 * 吸附单点：候选 = 零点 + 播放头 + 非自身片段首尾；同距取**靠前**（`snapSeconds` 的严格小于
 * 保证升序候选里第一个胜出）；超容差返回未吸附。返回值永远是帧对齐的。
 *
 * @param {{
 *   tracks: readonly any[],
 *   seconds: number,
 *   fps: { num?: number, den?: number }|number,
 *   toleranceSec: number,
 *   playhead?: number,
 *   excludeIds?: readonly string[],
 * }} input
 * @returns {{
 *   raw: number,
 *   value: number,
 *   frame: number,
 *   target: number|null,
 *   distance: number,
 *   snapped: boolean,
 *   candidates: number[],
 * }}
 */
export function snapAt(input) {
  const raw = Number(input?.seconds);
  if (!Number.isFinite(raw)) throw new SnapError(`seconds 必须是有限数：${input?.seconds}`, 'SNAP_INVALID_VALUE');
  const tolerance = Number(input?.toleranceSec);
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new SnapError(`toleranceSec 必须是 ≥ 0 的有限数：${input?.toleranceSec}`, 'SNAP_INVALID_TOLERANCE');
  }
  const rate = fpsValue(input.fps);
  const targets = collectSnapTargets({
    tracks: input.tracks ?? [],
    ...(input.playhead === undefined ? {} : { playhead: input.playhead }),
    ...(input.excludeIds === undefined ? {} : { excludeIds: input.excludeIds }),
  });
  const hit = snapSeconds({ value: raw, targets, tolerance });
  const snapped = hit.target !== null;
  const base = snapped ? Number(hit.target) : raw;
  const frame = Math.round(base * rate);
  return {
    raw,
    value: roundTime(frame / rate),
    frame,
    target: hit.target,
    distance: roundTime(Math.abs(base - raw)),
    snapped,
    candidates: targets,
  };
}

/**
 * 严格主轨：恰好一条 `role === 'picture'`。0 条与多条都报错。
 *
 * @param {readonly any[]} tracks
 * @returns {{ ok: true, index: number, track: any } | { ok: false, code: 'NO_MAIN_TRACK'|'MULTI_MAIN_TRACK', indices: number[], message: string }}
 */
export function resolveMainTrackStrict(tracks) {
  const list = Array.isArray(tracks) ? tracks : [];
  /** @type {{ index: number, track: any }[]} */
  const pictures = [];
  for (const track of list) {
    if (track === null || typeof track !== 'object') continue;
    if (String(track.role ?? '') !== 'picture') continue;
    const index = Number.isInteger(track.index) ? track.index : list.indexOf(track);
    pictures.push({ index, track });
  }
  if (pictures.length === 0) {
    return { ok: false, code: 'NO_MAIN_TRACK', indices: [], message: '没有画面轨，无法判定主轨' };
  }
  if (pictures.length > 1) {
    const indices = pictures.map((item) => item.index).sort((a, b) => a - b);
    return {
      ok: false,
      code: 'MULTI_MAIN_TRACK',
      indices,
      message: `存在 ${pictures.length} 条画面轨（${indices.join('/')}），波纹需要唯一主轨`,
    };
  }
  const only = pictures[0];
  if (only === undefined) return { ok: false, code: 'NO_MAIN_TRACK', indices: [], message: '没有画面轨，无法判定主轨' };
  return { ok: true, index: only.index, track: only.track };
}

/**
 * 磁吸的 move / trim 规划。
 *
 * - `move`：整段平移，时长不变；被拖端吸附，另一端按原时长跟过去。
 * - `trim`：被拖端吸附，另一端**不动**（起点端裁剪时 `at` 与 `time[0]` 一起改，尾端裁剪只改 `time[1]`）。
 * - 结果拒绝负起点 / 零时长 / 负时长；`ops` 仍是现有 `props`（`at` / `time`），不新增 op 类型。
 *
 * @param {{
 *   mode: 'move'|'trim',
 *   tracks: readonly any[],
 *   clipId: string,
 *   edge: 'start'|'end',
 *   seconds: number,
 *   fps: { num?: number, den?: number }|number,
 *   toleranceSec: number,
 *   playhead?: number,
 * }} input
 * @returns {{
 *   ok: boolean,
 *   code?: 'CLIP_NOT_FOUND'|'NOT_FOUND'|'NEGATIVE_START'|'ZERO_DURATION'|'NEGATIVE_DURATION'|'INVALID_MODE'|'INVALID_EDGE',
 *   message?: string,
 *   mode?: 'move'|'trim',
 *   edge?: 'start'|'end',
 *   fps?: number,
 *   before?: { start: number, end: number, duration: number, frameStart: number, frameEnd: number },
 *   after?: { start: number, end: number, duration: number, frameStart: number, frameEnd: number },
 *   snap?: ReturnType<typeof snapAt>,
 *   ops?: any[],
 *   changed?: boolean,
 * }}
 */
export function planMagnetEdit(input) {
  const mode = input?.mode;
  const edge = input?.edge;
  if (mode !== 'move' && mode !== 'trim') {
    return { ok: false, code: 'INVALID_MODE', message: `mode 只接受 move/trim：${String(mode)}` };
  }
  if (edge !== 'start' && edge !== 'end') {
    return { ok: false, code: 'INVALID_EDGE', message: `edge 只接受 start/end：${String(edge)}` };
  }
  const rate = fpsValue(input.fps);

  /** @type {any} */
  let clip = null;
  /** @type {any} */
  let host = null;
  for (const track of input.tracks ?? []) {
    for (const item of track?.clips ?? []) {
      if (item?.id === input.clipId) {
        clip = item;
        host = track;
        break;
      }
    }
    if (clip !== null) break;
  }
  if (clip === null || host === null) {
    return { ok: false, code: 'CLIP_NOT_FOUND', message: `片段不存在：${input.clipId}` };
  }
  if (host.locked === true) {
    return { ok: false, code: 'NOT_FOUND', message: `片段所在轨道已锁定：${host.index}` };
  }

  const span = spanOf(clip);
  const length = span.length;
  const speed = typeof clip.speed === 'number' && clip.speed > 0 ? clip.speed : 1;
  const inPoint = Array.isArray(clip.time) ? Number(clip.time[0]) : 0;
  const outPoint = Array.isArray(clip.time) ? Number(clip.time[1]) : 0;

  const rawStart = mode === 'move' ? (edge === 'start' ? Number(input.seconds) : Number(input.seconds) - length) : edge === 'start' ? Number(input.seconds) : span.start;
  const rawEnd = mode === 'move' ? rawStart + length : edge === 'end' ? Number(input.seconds) : span.end;
  const draggedRaw = edge === 'start' ? rawStart : rawEnd;
  if (!Number.isFinite(draggedRaw)) {
    throw new SnapError(`seconds 必须是有限数：${input.seconds}`, 'SNAP_INVALID_VALUE');
  }

  // 原始请求位置先验：拖到负时间/拖成零时长属于输入非法，不该靠「有没有吸附」来兜。
  const rawDuration = roundTime(rawEnd - rawStart);
  if (rawStart < -FRAME_EPS) {
    return { ok: false, code: 'NEGATIVE_START', message: `结果起点为负：${rawStart}` };
  }
  if (rawDuration < 0) {
    return { ok: false, code: 'NEGATIVE_DURATION', message: `结果时长为负：${rawDuration}` };
  }
  if (rawDuration <= FRAME_EPS) {
    return { ok: false, code: 'ZERO_DURATION', message: `结果时长为 0（${rawDuration}）` };
  }

  const snap = snapAt({
    tracks: input.tracks,
    seconds: draggedRaw,
    fps: rate,
    toleranceSec: input.toleranceSec,
    ...(input.playhead === undefined ? {} : { playhead: input.playhead }),
    excludeIds: [input.clipId],
  });

  if (!snap.snapped) {
    return {
      ok: true,
      mode,
      edge,
      fps: rate,
      before: {
        start: roundTime(span.start),
        end: roundTime(span.end),
        duration: roundTime(length),
        frameStart: Math.round(span.start * rate),
        frameEnd: Math.round(span.end * rate),
      },
      after: {
        start: roundTime(span.start),
        end: roundTime(span.end),
        duration: roundTime(length),
        frameStart: Math.round(span.start * rate),
        frameEnd: Math.round(span.end * rate),
      },
      snap,
      ops: [],
      changed: false,
    };
  }

  const start = mode === 'move' ? (edge === 'start' ? snap.value : snap.value - length) : edge === 'start' ? snap.value : span.start;
  const end = mode === 'move' ? start + length : edge === 'end' ? snap.value : span.end;
  const duration = roundTime(end - start);

  if (start < -FRAME_EPS) {
    return { ok: false, code: 'NEGATIVE_START', message: `结果起点为负：${start}` };
  }
  if (duration < 0) {
    return { ok: false, code: 'NEGATIVE_DURATION', message: `结果时长为负：${duration}` };
  }
  if (duration <= FRAME_EPS) {
    return { ok: false, code: 'ZERO_DURATION', message: `结果时长为 0（${duration}）` };
  }

  /** @type {any[]} */
  const ops = [];
  if (mode === 'move') {
    const nextAt = roundTime(Math.max(0, start));
    if (Math.abs(nextAt - span.start) > FRAME_EPS) {
      ops.push({ op: 'props', edits: [{ clip: clip.id, prop: 'at', value: nextAt }] });
    }
  } else if (edge === 'start') {
    const delta = start - span.start;
    const nextAt = roundTime(Math.max(0, start));
    const nextIn = roundTime(inPoint + delta * speed);
    if (Math.abs(nextIn - inPoint) <= FRAME_EPS) {
      // 裁到 0 时长会被上面拦掉；这里只剩「吸附回原位」，不发 op。
    } else {
      ops.push({
        op: 'props',
        edits: [
          { clip: clip.id, prop: 'at', value: nextAt },
          { clip: clip.id, prop: 'time', value: [Math.max(0, nextIn), outPoint] },
        ],
      });
    }
  } else {
    const delta = end - span.end;
    const nextOut = roundTime(outPoint + delta * speed);
    if (Math.abs(nextOut - outPoint) > FRAME_EPS) {
      ops.push({ op: 'props', edits: [{ clip: clip.id, prop: 'time', value: [inPoint, Math.max(0, nextOut)] }] });
    }
  }

  return {
    ok: true,
    mode,
    edge,
    fps: rate,
    before: {
      start: roundTime(span.start),
      end: roundTime(span.end),
      duration: roundTime(length),
      frameStart: Math.round(span.start * rate),
      frameEnd: Math.round(span.end * rate),
    },
    after: {
      start: roundTime(start),
      end: roundTime(end),
      duration,
      frameStart: Math.round(start * rate),
      frameEnd: Math.round(end * rate),
    },
    snap,
    ops,
    changed: ops.length > 0,
  };
}

/**
 * 波纹插入（严格主轨）：`track` 必须是唯一主轨；插入点之后的片段整体后移。
 * 非主轨 → 不报错但不位移（与 `planRippleInsert` 一致，留间隙）；多主轨 → 报错。
 *
 * @param {{ tracks: readonly any[], track: number, at: number, length: number, fps?: { num?: number, den?: number }|number }} input
 * @returns {{ ok: boolean, code?: 'MULTI_MAIN_TRACK'|'NO_MAIN_TRACK'|'INVALID_LENGTH', message?: string, mainTrack?: number, ops: any[], moved: { id: string, from: number, to: number }[] }}
 */
export function planRippleInsertStrict(input) {
  const main = resolveMainTrackStrict(input.tracks ?? []);
  if (!main.ok) {
    return { ok: false, code: main.code, message: main.message, ops: [], moved: [] };
  }
  const length = Number(input.length);
  if (!Number.isFinite(length) || length <= 0) {
    return { ok: false, code: 'INVALID_LENGTH', message: `插入长度必须是 > 0 的有限数：${input.length}`, ops: [], moved: [] };
  }
  // 只有主轨插入才让位：副线/叠加轨插入不该拉动主轨（口径与波纹删除一致）。
  if (Number(input.track) !== main.index) {
    return { ok: true, mainTrack: main.index, ops: [], moved: [] };
  }
  const plan = planRippleInsert({
    tracks: input.tracks,
    track: Number(input.track),
    at: Number(input.at),
    length,
  });
  return { ok: true, mainTrack: main.index, ops: plan.ops, moved: plan.moved };
}

/**
 * 波纹删除（严格主轨）：多主轨报错；单主轨沿用 `planRippleDelete` 的闭合规则。
 *
 * @param {{ tracks: readonly any[], ids: readonly string[], ripple?: boolean }} input
 * @returns {{ ok: boolean, code?: 'MULTI_MAIN_TRACK'|'NO_MAIN_TRACK', message?: string, mainTrack?: number, ops: any[], removed?: string[], moved?: { id: string, from: number, to: number }[] }}
 */
export function planRippleDeleteStrict(input) {
  const main = resolveMainTrackStrict(input.tracks ?? []);
  if (!main.ok) {
    return { ok: false, code: main.code, message: main.message, ops: [] };
  }
  const plan = planRippleDelete({
    tracks: input.tracks,
    ids: input.ids,
    ...(input.ripple === undefined ? {} : { ripple: input.ripple }),
  });
  return {
    ok: plan.ok,
    ...(plan.ok ? {} : { code: 'NO_MAIN_TRACK' }),
    ...(plan.ok ? {} : { message: plan.message }),
    mainTrack: main.index,
    ops: plan.ops,
    removed: plan.removed,
    moved: plan.moved,
  };
}

/**
 * 只读规划入口：给定被拖端的新位置，返回吸附结果 + 需要发的 op，但**不做任何写盘**。
 * 路由 `POST /api/timeline/snap` 就是它的薄包装。
 *
 * @param {{
 *   lanes: readonly any[],
 *   mode?: 'move'|'trim',
 *   clipId?: string,
 *   edge?: 'start'|'end',
 *   seconds?: number,
 *   fps: { num?: number, den?: number }|number,
 *   tolerancePx: number,
 *   pxPerSecond?: number,
 *   viewportWidth?: number,
 *   durationSec?: number,
 *   playhead?: number,
 * }} input
 * @returns {{ tolerance: ReturnType<typeof toleranceSeconds>, plan: ReturnType<typeof planMagnetEdit>|null, snap: ReturnType<typeof snapAt>|null }}
 */
export function planTimelineSnap(input) {
  const tolerance = toleranceSeconds({
    tolerancePx: Number(input.tolerancePx),
    ...(input.pxPerSecond === undefined ? {} : { pxPerSecond: Number(input.pxPerSecond) }),
    ...(input.viewportWidth === undefined ? {} : { viewportWidth: Number(input.viewportWidth) }),
    ...(input.durationSec === undefined ? {} : { durationSec: Number(input.durationSec) }),
  });

  if (input.clipId === undefined || input.clipId === null || input.clipId === '') {
    const snap = snapAt({
      tracks: input.lanes,
      seconds: Number(input.seconds),
      fps: input.fps,
      toleranceSec: tolerance.toleranceSec,
      ...(input.playhead === undefined ? {} : { playhead: input.playhead }),
    });
    return { tolerance, plan: null, snap };
  }

  const plan = planMagnetEdit({
    mode: input.mode ?? 'move',
    tracks: input.lanes,
    clipId: input.clipId,
    edge: input.edge ?? 'start',
    seconds: Number(input.seconds),
    fps: input.fps,
    toleranceSec: tolerance.toleranceSec,
    ...(input.playhead === undefined ? {} : { playhead: input.playhead }),
  });
  return { tolerance, plan, snap: plan.ok ? (plan.snap ?? null) : null };
}

export { mainTrackIndex };
