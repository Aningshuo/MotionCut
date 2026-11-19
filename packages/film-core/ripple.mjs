/**
 * 主轨磁吸 / 波纹（ED-042 · ED-043 · ED-045）——纯函数，不碰 DOM、不读盘。
 *
 * 三个决定写在这里，别在 UI 里重猜：
 *
 * 1. **主轨 = 最低画面轨（V1）**。`tracks` 的**数组顺序就是层叠顺序**（第一个在最上层），
 *    所以「最低」= 从后往前第一个 `role === 'picture'` 的轨。`page`（网页片段）不算画面轨。
 * 2. **波纹只动被删片段所在的那条轨**，而且只有主轨触发。非主轨删除保持留间隙（老行为）。
 * 3. **锁轨不动**：要删的片段在锁轨上 → 整条拒绝（A7）；波纹位移只发生在主轨，
 *    主轨一旦被锁就已经拒绝了，不会出现「删了却只移一半」。
 *
 * 所有 Op 都落在现有 5 类里：`remove` + `props(at)`。不新增 op 类型、不改合同。
 * 一批 Op = 一次 `/ops` = 一步撤销（`invertOps` 会把这个批整体反演）。
 */

/**
 * 片段在时间线上的占用区间。与 `studio/ui/src/timeline/geometry.mjs` 的 `clipSpan`
 * **必须一致**（那边给 UI 画、这边给落盘算）；`test/ripple.test.mjs` 有一条对拍断言。
 * @param {{ at?: number, time?: number[], speed?: number }} clip
 * @returns {{ start: number, end: number, length: number }}
 */
export function spanOf(clip) {
  const start = Number(clip.at ?? 0);
  const time = Array.isArray(clip.time) ? clip.time : null;
  const speed = typeof clip.speed === 'number' && clip.speed > 0 ? clip.speed : 1;
  const length = time === null ? 0 : (Number(time[1]) - Number(time[0])) / speed;
  return { start, end: roundMs(start + length), length: roundMs(length) };
}

/** @param {number} value */
function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * 主轨（V1）：`tracks` 数组里**最后一个** `role === 'picture'` 的轨。
 * 返回轨的 `index`（写 Op 用的那个编号），没有画面轨返回 `null`。
 * @param {readonly any[]} tracks
 * @returns {number|null}
 */
export function mainTrackIndex(tracks) {
  if (!Array.isArray(tracks)) return null;
  for (let i = tracks.length - 1; i >= 0; i -= 1) {
    const track = tracks[i];
    if (track === null || typeof track !== 'object') continue;
    if (String(track.role ?? '') !== 'picture') continue;
    return Number.isInteger(track.index) ? /** @type {number} */ (track.index) : i;
  }
  return null;
}

/**
 * 主轨判定 + 它的锁定态（UI 用来显示「V1 已锁」）。
 * @param {readonly any[]} tracks
 * @returns {{ index: number, locked: boolean, track: any }|null}
 */
export function mainTrackOf(tracks) {
  const index = mainTrackIndex(tracks);
  if (index === null) return null;
  const track = tracks.find((item) => Number(item?.index) === index) ?? null;
  if (track === null) return null;
  return { index, locked: track.locked === true, track };
}

/**
 * 波纹删除 / 普通删除的 Op 批。
 *
 * - `ripple !== false` 且删的是主轨片段 → 主轨后续片段整体左移，保持闭合；
 * - 其它轨道只删不移（留间隙，与 R4 以来的行为一致）；
 * - 要删的片段在**锁轨**上 → 不删它；全都被锁 → `ok:false, reason:'LOCKED'`（一个 Op 都不发）。
 *
 * @param {{ tracks: readonly any[], ids: readonly string[], ripple?: boolean }} input
 * @returns {{
 *   ok: boolean,
 *   reason?: 'LOCKED'|'NOTHING',
 *   ops: any[],
 *   ripple: boolean,
 *   mainTrack: number|null,
 *   removed: string[],
 *   skippedLocked: { id: string, track: number }[],
 *   moved: { id: string, from: number, to: number }[],
 *   message?: string,
 * }}
 */
export function planRippleDelete(input) {
  const tracks = Array.isArray(input.tracks) ? input.tracks : [];
  const ripple = input.ripple !== false;
  const ids = [...new Set((input.ids ?? []).filter((id) => typeof id === 'string' && id !== ''))];
  const mainTrack = mainTrackIndex(tracks);

  /** @type {{ id: string, track: number, span: { start: number, end: number, length: number }, trackRef: any }[]} */
  const removed = [];
  /** @type {{ id: string, track: number }[]} */
  const skippedLocked = [];
  for (const track of tracks) {
    const trackIndex = Number.isInteger(track?.index) ? track.index : tracks.indexOf(track);
    for (const clip of track?.clips ?? []) {
      if (!ids.includes(clip.id)) continue;
      if (track.locked === true) {
        skippedLocked.push({ id: clip.id, track: trackIndex });
        continue;
      }
      removed.push({ id: clip.id, track: trackIndex, span: spanOf(clip), trackRef: track });
    }
  }

  if (removed.length === 0) {
    return {
      ok: false,
      reason: 'LOCKED',
      ops: [],
      ripple,
      mainTrack,
      removed: [],
      skippedLocked,
      moved: [],
      message:
        skippedLocked.length > 0
          ? `轨道已锁定，未删除：${skippedLocked.map((item) => item.id).join('、')}`
          : '没有可删除的片段',
    };
  }

  /** @type {any[]} */
  const ops = removed.map((item) => ({ op: 'remove', clip: item.id }));
  /** @type {{ id: string, from: number, to: number }[]} */
  const moved = [];

  if (ripple && mainTrack !== null) {
    const mainRemoved = removed.filter((item) => item.track === mainTrack).map((item) => item.span);
    if (mainRemoved.length > 0) {
      const mainTrackRef = tracks.find((item) => Number(item?.index) === mainTrack);
      for (const clip of mainTrackRef?.clips ?? []) {
        if (ids.includes(clip.id)) continue;
        const span = spanOf(clip);
        // 只把「起点在被删片段之后」的往回拉：被删片段之前的片段不受影响。
        const shift = mainRemoved
          .filter((gone) => gone.start < span.start)
          .reduce((sum, gone) => sum + gone.length, 0);
        if (shift <= 0) continue;
        const to = roundMs(Math.max(0, span.start - shift));
        if (to === span.start) continue;
        ops.push({ op: 'props', edits: [{ clip: clip.id, prop: 'at', value: to }] });
        moved.push({ id: clip.id, from: span.start, to });
      }
    }
  }

  return {
    ok: true,
    ops,
    ripple: ripple && mainTrack !== null && removed.some((item) => item.track === mainTrack),
    mainTrack,
    removed: removed.map((item) => item.id),
    skippedLocked,
    moved,
    ...(skippedLocked.length > 0
      ? { message: `因锁定跳过 ${skippedLocked.length} 个：${skippedLocked.map((item) => item.id).join('、')}` }
      : {}),
  };
}

/**
 * 波纹插入：往主轨插一段后，原本「在插入点及之后」的片段整体右移，不覆盖。
 * 传入的 `tracks` 必须是**插入前**的 doc（这样不用去区分刚插进来的那一条）。
 *
 * @param {{ tracks: readonly any[], track: number, at: number, length: number }} input
 * @returns {{ ops: any[], moved: { id: string, from: number, to: number }[] }}
 */
export function planRippleInsert(input) {
  const tracks = Array.isArray(input.tracks) ? input.tracks : [];
  const at = roundMs(Math.max(0, Number(input.at) || 0));
  const length = roundMs(Number(input.length) || 0);
  const track = tracks.find((item) => Number(item?.index) === Number(input.track)) ?? null;
  /** @type {any[]} */
  const ops = [];
  /** @type {{ id: string, from: number, to: number }[]} */
  const moved = [];
  if (track === null || length <= 0 || track.locked === true) return { ops, moved };
  for (const clip of track.clips ?? []) {
    const span = spanOf(clip);
    // 插入点之后的（含正好卡在插入点上的）都要让位；插入点之前的原地不动。
    if (span.start + 1e-6 < at) continue;
    const to = roundMs(span.start + length);
    ops.push({ op: 'props', edits: [{ clip: clip.id, prop: 'at', value: to }] });
    moved.push({ id: clip.id, from: span.start, to });
  }
  return { ops, moved };
}

/**
 * 吸附目标：零点 + 播放头 + 所有其它片段的边界（秒）。
 * 标记（marker）这一轮没有数据模型，不做（见交接 notDone）。
 *
 * @param {{ tracks: readonly any[], playhead?: number, excludeIds?: readonly string[] }} input
 * @returns {number[]} 升序、去重、非负
 */
export function collectSnapTargets(input) {
  const exclude = new Set(input.excludeIds ?? []);
  /** @type {Set<number>} */
  const out = new Set([0]);
  if (Number.isFinite(Number(input.playhead))) out.add(roundMs(Math.max(0, Number(input.playhead))));
  for (const track of input.tracks ?? []) {
    for (const clip of track?.clips ?? []) {
      if (exclude.has(clip.id)) continue;
      const span = spanOf(clip);
      out.add(span.start);
      out.add(span.end);
    }
  }
  return [...out].filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
}

/**
 * 在秒空间里找最近的目标（**判定本身**由调用方按像素换算好 `tolerance`）。
 * @param {{ value: number, targets: readonly number[], tolerance: number }} input
 * @returns {{ value: number, target: number|null, distance: number }}
 */
export function snapSeconds(input) {
  const value = Number(input.value) || 0;
  const tolerance = Number(input.tolerance);
  const targets = Array.isArray(input.targets) ? input.targets : [];
  if (!Number.isFinite(tolerance) || tolerance < 0 || targets.length === 0) {
    return { value, target: null, distance: Number.POSITIVE_INFINITY };
  }
  let best = null;
  /** @type {number} */
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const target of targets) {
    const distance = Math.abs(Number(target) - value);
    if (distance < bestDistance) {
      best = Number(target);
      bestDistance = distance;
    }
  }
  // 容差按「含等号」处理：0.05 的容差遇到 2.05 时，浮点差是 0.050000000000000044，
  // 直接比会判成超差。加 1e-9 只为吸收二进制噪声，不放宽判据（1px=0.01s 仍然超差）。
  if (best === null || bestDistance > tolerance + 1e-9) {
    return { value, target: null, distance: roundMs(bestDistance) };
  }
  return { value: roundMs(best), target: roundMs(best), distance: roundMs(bestDistance) };
}
