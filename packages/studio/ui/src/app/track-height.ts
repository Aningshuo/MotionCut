/**
 * 轨道高度（M36 / ED-034）——**只存 UI 侧**。
 *
 * 为什么不是方言属性：轨道高度是「我现在怎么看这条时间线」，不是影片内容。
 * 写进 `film.html` 会让同一份工程在不同人的显示器上互相覆盖，也会让
 * 「只改视图」变成一次 `/ops`、一步撤销、一个 hash 变化。所以按工程存
 * localStorage（与 M29 的导出历史同一策略），`film.html` 一个字节都不动。
 *
 * 三档（紧凑 28 / 标准 44 / 高 72）是**菜单**的值；拖下沿可以停在中间任意高度，
 * 所以存储的是数字而不是档位名。`presetOf()` 只用于把当前高度映射回菜单的高亮项。
 */

export type TrackHeightPreset = 'compact' | 'standard' | 'tall';

/** 三档预设（px）。28 是「能看到片段但很紧」，72 是「波形能看清强弱」。 */
export const TRACK_HEIGHTS: Readonly<Record<TrackHeightPreset, number>> = Object.freeze({
  compact: 28,
  standard: 44,
  tall: 72,
});

/** 拖下沿的钳制（px）：参照 0.3.2 的 `VR(e)=Math.round(Math.max(28,Math.min(160,e)))`。
 *  下限 28 = 参照的 `ZMe`（再小片段放不下名字），上限 160 = `JMe`（再大一条轨占满屏）。 */
export const TRACK_HEIGHT_MIN = 28;
export const TRACK_HEIGHT_MAX = 160;

/** 默认档（与改造前的时间线观感接近：原来 lane 40 + clip 30）。 */
export const DEFAULT_TRACK_HEIGHT = 44;

/** Default display geometry; explicit per-project row sizes take precedence. */
export const CAPTION_ROW_HEIGHT = 26;

export const ROLE_DEFAULT_HEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  page: 64,
  picture: 64,
  audio: 44,
  subtitle: CAPTION_ROW_HEIGHT,
});

/** 轨道之间的外部间隙（参考 timelineRowGap=2）；不算进行高，单独加。 */
export const LANE_GAP = 2;

export function defaultHeightFor(role: string | undefined, index?: number, mainTrack?: number | null): number {
  if (role === 'subtitle' || index === -1) return CAPTION_ROW_HEIGHT;
  if (index != null && index === mainTrack && (role === 'picture' || role === 'page')) return 76;
  const hit = role === undefined ? undefined : ROLE_DEFAULT_HEIGHTS[role];
  return hit ?? DEFAULT_TRACK_HEIGHT;
}

type TimelineTrack = { index: number; role?: string };

export function rowHeight(heights: TrackHeightMap, track: TimelineTrack, mainTrack?: number | null): number {
  const saved = heights[String(track.index)];
  return saved === undefined ? defaultHeightFor(track.role, track.index, mainTrack) : clampTrackHeight(saved);
}

/** 轨道顶偏移：`index → 距轨道区顶部 px`（含行间 gap）。渲染与命中都调它。 */
export function laneTopOf(heights: TrackHeightMap, tracks: readonly TimelineTrack[], mainTrack?: number | null): Map<number, number> {
  const tops = new Map<number, number>();
  let y = 0;
  let first = true;
  for (const track of tracks) {
    if (!first) y += LANE_GAP;
    tops.set(track.index, y);
    y += rowHeight(heights, track, mainTrack);
    first = false;
  }
  return tops;
}

/**
 * 轨道区总高（D54 · R16）：与 `laneTopOf` 同一套算术，再加字幕副轨那一条。
 *
 * 为什么要它：`.tl-lanes` 的 min-height 以前是「各轨高度之和 + 44（写死的副轨）**不加行间 gap**」，
 * 于是轨高拖大之后 min-height 比真实内容高 10px（44 的副轨实际是 26、4 条 gap 又没算）
 * —— 纵滚量里多出一段纯空白。这里把「行间 gap + 真实字幕行高」算进去，与渲染逐像素一致。
 */
export function lanesTotalHeight(
  heights: TrackHeightMap,
  tracks: readonly TimelineTrack[],
  hasSubLane: boolean,
  mainTrack?: number | null,
): number {
  let total = tracks.reduce((sum, track) => sum + rowHeight(heights, track, mainTrack), 0);
  total += Math.max(0, tracks.length - 1) * LANE_GAP;
  if (hasSubLane) total += (tracks.length ? LANE_GAP : 0) + CAPTION_ROW_HEIGHT;
  return total;
}

/** UI 片段上下留白；与 R3 的 .tl-clip top 同源。轨高与轨间 LANE_GAP 不变。 */
export const CLIP_INSET = 0;

/** @type {readonly TrackHeightPreset[]} */
export const TRACK_HEIGHT_PRESETS: readonly TrackHeightPreset[] = Object.freeze([
  'compact',
  'standard',
  'tall',
] as const);

/**
 * 菜单上的字（R20：照参照的档位口径改成 **小 / 中 / 大**）。
 *
 * 参照（0.3.2）的键义：`trackHeight:"Track height"`、`size:{small:"Small",medium:"Medium",large:"Large"}`、
 * `resizeTrack:"Drag to make the track taller or shorter · double-click: its usual height"` ——
 * **它根本不显示像素数**，只有档位 + 拖拽 + 双击复位。所以我们菜单也用档位字，
 * 自定义值（拖出来的高度）显示不带单位的整数（`76`），完整值进 `title`。
 * 三档的实际 px 见 `TRACK_HEIGHTS`（28 / 44 / 72，不是 64/76/96）。
 */
export const TRACK_HEIGHT_LABELS: Readonly<Record<TrackHeightPreset, string>> = Object.freeze({
  compact: '小',
  standard: '中',
  tall: '大',
});

export function clampTrackHeight(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_TRACK_HEIGHT;
  return Math.min(TRACK_HEIGHT_MAX, Math.max(TRACK_HEIGHT_MIN, Math.round(n)));
}

/**
 * 当前高度对应哪一档（拖到 50px 就不是任何一档 → null，菜单显示当前 px）。
 */
export function presetOf(height: number): TrackHeightPreset | null {
  const value = clampTrackHeight(height);
  for (const preset of TRACK_HEIGHT_PRESETS) if (TRACK_HEIGHTS[preset] === value) return preset;
  return null;
}

/** 片段高度：轨道高度减上下留白（不小于 12px，否则名字都没地方放）。 */
export function clipHeightOf(laneHeight: number): number {
  return Math.max(12, clampTrackHeight(laneHeight) - CLIP_INSET * 2);
}

/** localStorage 键：按工程分开（同名工程不同目录也各存各的）。 */
export function trackHeightKey(projectId: string): string {
  return `opencut.trackHeights.v1:${String(projectId ?? '')}`;
}

export type TrackHeightMap = Record<string, number>;

/**
 * 读一个工程的高度表。
 *
 * 存储形状：`{ "0": 44, "1": 72 }`（track index → px）。读坏了就当没存过——
 * 视图偏好丢了不是错误，不值得弹框。
 */
export function loadTrackHeights(projectId: string): TrackHeightMap {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(trackHeightKey(projectId));
    if (raw === null || raw === '') return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: TrackHeightMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!/^\d+$/.test(key)) continue;
      const height = Number(value);
      if (Number.isFinite(height)) out[key] = clampTrackHeight(height);
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 写一条轨道的高度，返回新的整表（调用方拿它 setState）。
 */
export function saveTrackHeight(projectId: string, current: TrackHeightMap, trackIndex: number, height: number): TrackHeightMap {
  const next: TrackHeightMap = { ...current, [String(trackIndex)]: clampTrackHeight(height) };
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(trackHeightKey(projectId), JSON.stringify(next));
    } catch {
      // 隐私模式 / 配额满：视图偏好存不下就算了，本次会话仍然生效。
    }
  }
  return next;
}

/** 取某条轨道的高度（没设过就默认档）。 */
export function heightOf(heights: TrackHeightMap, trackIndex: number): number {
  const value = heights?.[String(trackIndex)];
  return value === undefined ? DEFAULT_TRACK_HEIGHT : clampTrackHeight(value);
}

/* ── 网格设置（M36）：也是视图偏好，按工程存 ──────────────────────────── */

export const DEFAULT_GRID_SIZE = 8;
export const GRID_SIZE_MIN = 2;
export const GRID_SIZE_MAX = 64;

export interface GridSetting {
  enabled: boolean;
  size: number;
}

export function clampGridSize(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_GRID_SIZE;
  return Math.min(GRID_SIZE_MAX, Math.max(GRID_SIZE_MIN, Math.round(n)));
}

export function gridKey(projectId: string): string {
  return `opencut.grid.v1:${String(projectId ?? '')}`;
}

export function loadGrid(projectId: string): GridSetting {
  if (typeof localStorage === 'undefined') return { enabled: false, size: DEFAULT_GRID_SIZE };
  try {
    const raw = localStorage.getItem(gridKey(projectId));
    if (raw === null || raw === '') return { enabled: false, size: DEFAULT_GRID_SIZE };
    const parsed: unknown = JSON.parse(raw);
    const record = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    return { enabled: record.enabled === true, size: clampGridSize(record.size) };
  } catch {
    return { enabled: false, size: DEFAULT_GRID_SIZE };
  }
}

export function saveGrid(projectId: string, enabled: boolean, size: number): GridSetting {
  const next: GridSetting = { enabled: enabled === true, size: clampGridSize(size) };
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(gridKey(projectId), JSON.stringify(next));
    } catch {
      // 同上：存不下就算了。
    }
  }
  return next;
}
