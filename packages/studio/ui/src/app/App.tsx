/**
 * 工作台外壳：工程列表 → 打开 → doc → 时间线（只读字段 + 手势写回）。
 *
 * 数据流向只有一个方向：
 *   GET /api/projects → POST /api/projects/open → GET /api/projects/:id/doc
 *   → 画时间线；手势 → 一批 Op → POST /api/projects/:id/ops → 以响应 hash 为准重取 doc。
 * 事件（WS /events 的 doc.changed）只是「该重取了」的通知，不是权威数据。
 */

import { createElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CreationLibraryBridge } from './creation-library-bridge';
import { resourceDropAction } from './creation-drop';
import type { ResourceDrop } from './creation-drop';
import type { LibraryActionResult } from './creation-library-types';
import { listAppliedTransitions, planRemoveTransitionPreset } from '../../../../film-core/transition-presets.mjs';

import { clipSpan } from '../timeline/geometry.mjs';
import { expandLinks } from '../timeline/plan.mjs';
import { mainTrackIndex, planRippleDelete } from '../../../../film-core/ripple.mjs';
import { formatCueTime, parseCueTime } from '../../../../film-core/subtitle.mjs';
import {
  CLIP_DISABLED_ATTR, CLIP_DISABLED_VALUE, CLIP_MARKERS_ATTR, clipMarkerAt, clipMarkersOf, encodeClipMarkers,
  hasClipKeyframes, isClipDisabled, timelineTimeOfClipMarker,
} from '../../../../film-core/clip-state.mjs';
import { copyTimelineClips, planTimelineAction } from '../../../../film-core/timeline-actions.mjs';
import type { TimelineMenuGroups, TimelineMenuItem, TimelineMenuTarget } from './timeline-menu';
import { planRangeInputs, parseRangeTime } from '../../../../film-core/export-range.mjs';
// 画幅（M42）：`parseSizeArg` 是 CLI `--size` 的同一个解析器（WxH + 别名），只读引用。
import { parseSizeArg } from '../../../../render/delivery-size.mjs';
import { mountMotionPanel } from '../../../../motion/panel.mjs';
import { DEFAULT_TRANSITION_SECONDS, detectCutPoints, detectTransitions, planTransitionCreate, planTransitionRemove } from '../../../../film-core/transition.mjs';
// 检查器与其依赖全部来自 packages/layers（现成导出，不在这里重写一份）。
import { applyOverrideEntries } from '../../../../layers/apply-overrides.mjs';
import { readLayer } from '../../../../layers/describe';
import { snapshotLayers } from '../../../../layers/dom-probe.mjs';
import { mountInspector } from '../../../../layers/inspector-panel.mjs';
import { mountStageDock } from './stage-dock.mjs';
import { createPropsQueue } from './props-queue.mjs';
import { ZoneHandles, resetAllZones } from './zone-handles';
import { buildFieldOp } from './inspector-groups-panel';
import { mountCanvasGesture } from '../../../../layers/canvas-gesture.mjs';
import { checkHost } from '../../../../layers/host-contract.mjs';
import { createOpsClient } from '../../../../layers/ops-client.mjs';
import { mergeOverridesAt } from '../../../../layers/override-merge.mjs';
import {
  ApiError,
  assetThumbUrl,
  cancelExport,
  getDoc,
  listExports,
  getProject,
  getMediaStatus,
  health,
  history,
  importMedia,
  getSubtitles,
  insertAsset,
  listAssets,
  archiveProject,
  importProject,
  listProjects,
  listProjectsWithRecent,
  openProject,
  removeRecentProject,
  postOps,
  archiveMotionTemplate,
  getMotionLibrary,
  planMotionApply,
  rollbackMotionTemplate,
  saveMotionTemplate,
  upgradeMotionTemplate,
  relinkMedia,
  saveSubtitles,
  scanRelink,
  startExport,
  measureClipLoudness,
  getSubtitleStyle,
  putSubtitleStyle,
  getSettings,
  putSettings,
  getSettingsDiagnostics,
  getSettingsStorage,
  cleanSettingsCache,
  getStageLayers,
  inspectElement,
} from './api';
import type { McpServerEntry, SettingsAiCard, SettingsDiagnostics, SettingsFields, StorageReport } from './api';
import { SettingsPanel } from './settings-panel';
import { applyStudioTheme, rememberStudioTheme } from './studio-theme';
import { AgentPanel } from './agent-panel';
import { VersionPanel } from './version-panel';
import { SequenceBar } from './sequences';
import { matchShortcut } from './keymap.mjs';
import { installProbe } from './bridge';
import { clearHistory, historyFromJob, loadHistory, recordHistory } from './export-history';
import { resetWaveformCache } from './waveform-track';
import {
  DEFAULT_GRID_SIZE,
  TRACK_HEIGHT_PRESETS,
  TRACK_HEIGHT_LABELS,
  TRACK_HEIGHTS,
  clampGridSize,
  loadGrid,
  loadTrackHeights,
  saveGrid,
  saveTrackHeight,
  trackHeightKey,
} from './track-height';
import type { GridSetting, TrackHeightMap } from './track-height';
import { LevelMeter, publishLevels } from './level-meter';
import {
  elementSpaceOf,
  pageFit,
  layoutToStage,
  declaredDelta,
  geometryStylePatch,
  resettableKeys,
  type Rect as ElementRect,
} from './element-space';
/* R112 · L1：统一选中目标（LI-A03/A04/A06）。纯函数在那边，写状态只有本文件一处。 */
import {
  EMPTY_TARGET,
  bareAt,
  emptyStateOf,
  framePathOf,
  isElementTarget,
  makeTarget,
  staleReason,
  targetSignature,
  unifiedAt,
} from './selected-target';
import type { SelectedTarget, SelectionOrigin, StaleReason } from './selected-target';
import { VOLUME_MAX, effectiveFade, formatVolumeDb, planFadeOps, planMuteOps, planResetOps, planVolumeOps } from '../../../../film-core/audio-edit.mjs';
import { audioSplitOf, bareSrcOf, planSplitAudioOps } from '../../../../film-core/track-audio.mjs';
import { planBatchDetach } from './batch-detach.mjs';
import { listSubtitlePresets, resolveSubtitlePreset } from '../../../../layers/subtitle-presets.mjs';
// 16 字段的**规范**默认值在 layers/subtitle-style.mjs（S41）；
// `subtitle-surface.mjs` 同名导出的是 S23 的 11 字段别名视图，别拿错那份。
import { SUBTITLE_STYLE_DEFAULTS, applyStylePreset } from '../../../../layers/subtitle-style.mjs';
import { mountSubtitleOverlay } from './subtitle-surface.mjs';
import { computeVisibleWidth } from './subtitle-surface.mjs';
import { formatTimecode } from './stage-protocol.mjs';
import { attachStage, stageUrl } from './stage-preview';
import type { StageHandle, StageUpdate } from './stage-preview';
import { TabBar, tabsApi, useTabs } from './tabs';
import type {
  AssetItem,
  Clip,
  EditOp,
  Envelope,
  ExportHistoryItem,
  ExportJobView,
  FilmDoc,
  MediaStatus,
  MediaStatusItem,
  MotionManageEntry,
  CutPointView,
  ProjectListItem,
  ProjectSummary,
  RecentProjectItem,
  SubtitleCue,
  SubtitleStyleFields,
  Track,
  TransitionView,
} from './types';
import { DEFAULT_PPS, EmptyStage, ExportPanel, HEAD_W, HistoryActions, Inspector, ProjectList, RatioPicker, RelinkPanel, StageInfo, StagePreview, StageStatus, SubtitleStylePanel, Timeline, TopBar, TransportBar, num } from './views';
import { ratioIdOf, ratioPick } from './stage-ratios.mjs';
import { playheadScrollLeft } from '../timeline/ruler.mjs';
import type { ExportForm, ExportRangeRow, InspectorObjectTab, RelinkNote, SubtitleDraft, TrackAudioProps } from './views';
import type { MotionManageResult } from './api';
import './styles.css';
import './editor-polish.css';
import './timeline-polish.css';
import './studio-theme.css';
import { recordNotice } from './notice-log';

interface Notice {
  kind: 'info' | 'error';
  text: string;
  /** R150 · M16-R3：守卫拒绝的**专属**码（ELEMENT_GONE / REPLACED / UNMOUNTED / FOREIGN_PROJECT）。
      写进 DOM 的 `data-guard-code`，量具据此区分「守卫拒绝」与「他人已改」的 CAS 冲突，
      不再靠文案猜。 */
  guardCode?: string;
}

/**
 * R150 · M16-R3（A5）：守卫拒绝要有一句**说得出原因**的话。
 *
 * 改前所有 409 都落进同一条「他人已改，已刷新」——元素被删/被换/父级卸载与
 * 「别人先写了」混在一起，用户照着刷新再点一次，还是被拒。这里按服务端码给专属文案；
 * 只有没有守卫码的 409 才退回 CAS 口径。
 */
const GUARD_REJECT_HINT: Record<string, string> = {
  ELEMENT_GONE: '这个元素在页面源码里已经删掉了（ELEMENT_GONE）：这次改动没有落盘，请重新选一层再改',
  ELEMENT_REPLACED: '这个元素已经换成了新节点（ELEMENT_REPLACED）：这次改动没有落盘，请重新选一层再改',
  ELEMENT_UNMOUNTED: '这个元素所在的分支被卸载了（ELEMENT_UNMOUNTED）：这次改动没有落盘，请重新选一层再改',
  FOREIGN_PROJECT: '这次改动带的是另一个工程的目标（FOREIGN_PROJECT）：已拒绝，没有落盘',
  /* R154 · M17-A3：这三个原来漏在表外 —— 于是「重建超限 / 旧代数 / 页面读不出」被拒时，
     顶部 notice **停在上一笔的成功文案**上，看着像写成功了。守卫码一个都不能漏。 */
  REBUILD_EXHAUSTED: '页面一直在重建：同一个元素连续 3 次在旧实例上提交，已停止重试（REBUILD_EXHAUSTED）——这次改动没有落盘，重新观察后再写',
  STALE_EPOCH: '这次改动带着旧代数（STALE_EPOCH）：目标可能已经换过，这次没有落盘，请重新选一层',
  PAGE_UNREADABLE: '服务端读不出页面源码（PAGE_UNREADABLE）：守卫无法校验，这次改动没有落盘',
  TARGET_MISMATCH: '这批改动没有落在声明的目标上（TARGET_MISMATCH）：已拒绝，没有落盘',
};

/** 图层目标：面板 select() 需要的 ref（clipId + 场景里的 at）。 */
interface LayerTarget {
  clip: string;
  at: string;
  kind: string;
  name: string;
  depth: number;
}

/** `mountInspector` 的控制器（packages/layers/inspector-panel.mjs 的返回）。 */
interface InspectorController {
  setObjectTab(tab: InspectorObjectTab): void;
  select(ref: { clipId: string; at: string; kind?: string; name?: string; depth?: number }): Promise<unknown>;
  /** 多选（S93 接上）：`[]` 清空、1 项自动退回单选、≥2 项进 multi。只 describe，不写盘。 */
  selectMany(refs: readonly { clipId: string; at: string; kind?: string; name?: string; depth?: number }[]): Promise<unknown>;
  idle(): Promise<string>;
  getState(): unknown;
  setTreeLayers?(layers: readonly unknown[]): unknown;
  getTree?(): unknown;
  destroy(): void;
}

/** `mountCanvasGesture` 的控制器（packages/layers/canvas-gesture.mjs 的返回）。 */
interface GestureController {
  refresh(): void;
  getState(): {
    mode?: string | null;
    at?: string | null;
    ats?: string[];
    error?: { code: string; message: string } | null;
  } | null;
  /** 悬停描边（`null` 清除）：只读，不发 op。 */
  setHighlight(at: string | null): void;
  /** 程序化换选中（宿主同步自己的选择后用）。 */
  setSelection(layers: readonly unknown[]): string[];
  /** 舞台 iframe 里按下时由宿主转发（坐标已换算到父文档视口）。 */
  stagePointerDown(info: { clientX: number; clientY: number; shiftKey?: boolean; button?: number }): {
    handled: boolean;
    at?: string;
  };
  stageBodyPointer(phase: 'down' | 'move' | 'up' | 'cancel', at: string, event: {
    clientX: number; clientY: number; pointerId: number; pointerType: string; altKey: boolean; shiftKey: boolean;
  }): void;
  destroy(): void;
}

/** 舞台坐标下的矩形（`{x,y,w,h}`，未乘预览缩放）。 */
interface StageBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 服务端错误码 → 用户能懂的一句话（S87）。
 *
 * 只给**需要换动作**的码写人话：`ELEMENT_LOCKED` 不是「重试」能解决的，
 * 它要求用户先去解锁；把码和这句话一起显示，排查时还能对得上证据里的码。
 * 其余码保持 `CODE: 原消息`，不在这里编翻译。
 */
const ERROR_HINTS: Record<string, string> = {
  ELEMENT_LOCKED: '这个元素已锁定，改动没有写入：先在图层里解锁再改',
};

/** @param {unknown} error */
function describe(error: unknown): string {
  if (error instanceof ApiError) {
    const hint = ERROR_HINTS[error.code];
    return hint === undefined ? `${error.code}: ${error.message}` : `${hint}（${error.code}）`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 覆盖 patch → 属性队列的合并键（R11 · A2）。
 *
 * 队列按 `(elementId, key)` 合并**同键排队**的意图；不同键各自保留。
 * 面板只给 patch，不给字段 id，所以从 patch 的形状反推：
 * `t`（文本）/ `r`（旋转）/ `style:<属性>`（其余样式）。认不出时退化成 `patch`
 * （宁可多一条 /ops，也不要把两次不同的写合成一条）。
 * @param {unknown} patch
 */
function overrideKeyOf(patch: unknown): string {
  if (patch === null || typeof patch !== 'object') return 'patch';
  const value = patch as { t?: unknown; r?: unknown; style?: Record<string, unknown> };
  if (value.t !== undefined) return 't';
  if (value.r !== undefined) return 'r';
  if (value.style !== undefined && value.style !== null && typeof value.style === 'object') {
    const keys = Object.keys(value.style);
    if (keys.length === 1) return `style:${keys[0]}`;
    if (keys.length > 1) return `style:${keys.sort().join('+')}`;
  }
  return 'patch';
}

/** 选中 id → {clip, track}（按 doc 的当前内容解析，不缓存副本）。 */
function resolveSelection(doc: FilmDoc | null, ids: string[]): Array<{ clip: Clip; track: Track }> {
  if (doc === null) return [];
  const found: Array<{ clip: Clip; track: Track }> = [];
  for (const track of doc.tracks) {
    for (const clip of track.clips) {
      if (ids.includes(clip.id)) found.push({ clip, track });
    }
  }
  return found;
}

/**
 * 片段声明的几何（film-core 已解析的 `pageClip.box`）→ 队列/面板用的 `{x,y,w,h,r?}`。
 *
 * 没有声明、或宽高不是正数 → `null`（面板会退回 describe 的实测矩形）。
 * `r = 0` 与「没有 rotate 声明」在 film-core 里是同一个状态，所以不保留 0。
 */
function boxOfPageClip(clip: { box?: any } | null): { x: number; y: number; w: number; h: number; r?: number } | null {
  const box = clip?.box;
  if (!box) return null;
  const x = Number(box.x ?? 0);
  const y = Number(box.y ?? 0);
  const w = Number(box.w);
  const h = Number(box.h);
  if (![x, y, w, h].every((value) => Number.isFinite(value)) || w <= 0 || h <= 0) return null;
  const r = Number(box.r);
  return Number.isFinite(r) && r !== 0 ? { x, y, w, h, r } : { x, y, w, h };
}

/**
 * Agent 浮层的开合记忆（D 批 · 批注 4 / 判据 D8）。
 *
 * - **全局键**，不带 projectId：判据要求「同一把 profile 下换工程也一致」；
 * - 存 `'1'` / `'0'` 两个值，**开与关都写** —— 只记「开」的实现会让
 *   「关着刷新又自己打开」（D8 第三条专门抓这个）。
 * - localStorage 读写都包 try：Safari 隐私模式 / 禁用存储会直接抛，不能让开面板这个动作炸掉。
 */
const AGENT_OPEN_KEY = 'opencut.agent.open';

function readAgentOpen(): boolean {
  /* R102 · U1-R2：Agent **默认开启、全高常驻**（补正书 §1 的 1140,40 300×860 是常驻列）。
     只有用户明确关过（存了 '0'）才收起来 —— 旧口径是「只有存了 '1' 才开」，
     那样新用户/新 profile 永远见不到那一列，与目标布局不符。 */
  try {
    return window.localStorage.getItem(AGENT_OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}

function writeAgentOpen(open: boolean): void {
  try {
    window.localStorage.setItem(AGENT_OPEN_KEY, open ? '1' : '0');
  } catch {
    /* 存不了就只活这一屏：不影响开合本身，也不阻断其它存储项。 */
  }
}

export function App(): ReactNode {
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  /* M56：最近工程（跨会话）+ 索引是否损坏；坏了只提示，不影响列表。 */
  const [recentProjects, setRecentProjects] = useState<RecentProjectItem[]>([]);
  const [recentCorrupt, setRecentCorrupt] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [project, setProject] = useState<ProjectSummary | null>(null);
  /**
   * R34（R31-093 B）：工程块搬进顶栏后，它是**下拉**而不是常驻面板。
   *
   * 默认关着；**没有工程时自动打开** —— 左列顶部不再有 `.sidebar`，不打开就等于
   * 一块空画布加一条「未打开工程」，没有任何入口。打开工程后自动收起（见下面两个 effect）。
   */
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const closeMoreMenu = useCallback(() => setMoreMenuOpen(false), []);

  /* R34：没有工程 → 自动摊开（唯一的选工程入口）；列表还在加载时先不摊，免得弹一个空盒子。
     用户手动关掉后不会再自己弹：依赖没变，effect 不会重跑。 */
  useEffect(() => {
    if (project === null && listLoading === false) setProjectMenuOpen(true);
  }, [project, listLoading]);

  /* R34：工程一打开就收起（菜单是「切工程 / 打包」的地方，不是常驻面板）。
     放在 `projectId` 上而不是点击处：URL 恢复、标签页切换、导入工程都走同一条收口。 */
  useEffect(() => {
    if (project !== null) setProjectMenuOpen(false);
    closeMoreMenu();
  }, [project?.projectId, closeMoreMenu]);

  /* R34：点外面 / Esc 收起。`pointerdown` 用捕获：等 click 再收，菜单里的按钮已经把
     自己的 click 处理完了，看着像「点一下没反应又自己关了」。 */
  useEffect(() => {
    if (!projectMenuOpen) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('[data-testid="project-menu-panel"]') !== null) return;
      if (target.closest('[data-testid="project-menu"]') !== null) return;
      setProjectMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setProjectMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [projectMenuOpen]);

  /**
   * R37（批次 A · 批注 2）：布局菜单。与工程菜单同一套「点外面 / Esc 收起」，
   * 只是它挂在右端那颗布局图标上。**只有「默认布局」+「复位」** —— 多套布局是接口位，
   * 分栏可拖由批次 B（主线）提供；这一批不假装已经有多套。
   */
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);

  useEffect(() => {
    if (!layoutMenuOpen) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('[data-testid="layout-menu-panel"]') !== null) return;
      if (target.closest('[data-testid="layout-menu"]') !== null) return;
      setLayoutMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setLayoutMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [layoutMenuOpen]);
  const [doc, setDoc] = useState<FilmDoc | null>(null);
  const [hash, setHash] = useState('');
  const [undoDepth, setUndoDepth] = useState(0);
  const [redoDepth, setRedoDepth] = useState(0);
  const [selection, setSelection] = useState<string[]>([]);
  const [playhead, setPlayhead] = useState(0);
  /**
   * 时间线模式（M23）：波纹删除 / 吸附。都是**会话内开关**（不写 film.html），默认都开——
   * 「删了合上」「拖了贴齐」是剪辑默认期望，要留间隙就点一下波纹关掉。
   */
  const [ripple, setRipple] = useState(true);
  const [snap, setSnap] = useState(true);
  const rippleRef = useRef(true);
  const snapRef = useRef(true);
  /** 字幕跟着第一个视频的伴生文件，时间线和舞台读取已保存的字幕。 */
  const [{ projectId: subtitleProjectId, src: subtitleSrc }, setSubtitleSource] = useState({ projectId: '', src: '' });
  const [subtitleFile, setSubtitleFile] = useState<string | null>(null);
  const [subtitleFormat, setSubtitleFormat] = useState<'vtt' | 'srt'>('vtt');
  const [cues, setCues] = useState<SubtitleCue[]>([]);
  const [cueSkipped, setCueSkipped] = useState(0);
  const [cueIndex, setCueIndex] = useState<number | null>(null);
  const [cueDrafts, setCueDrafts] = useState(() => new Map<SubtitleCue, SubtitleDraft>());
  const [cueError, setCueError] = useState<{ cue: SubtitleCue; message: string } | null>(null);
  const [subtitleBusy, setSubtitleBusy] = useState(false);
  const subtitleRevision = useRef(0);
  const subtitleWrite = useRef(false);
  const cueTextRef = useRef<HTMLTextAreaElement | null>(null);
  const [cueFocusRequest, setCueFocusRequest] = useState(0);
  const cuesRef = useRef<SubtitleCue[]>([]);
  const subtitleOverlayRef = useRef<{
    render: (t: number) => void;
    destroy?: () => void;
    updateStyle?: (patch: any) => unknown;
  } | null>(null);
  /**
   * 字幕样式（M40）：**工程设置**，来源是 `<project>/.film/subtitle-style.json`。
   *
   * 三条约束写在这里，免得后面有人「顺手」改：
   * - 不进 `film.html`、不进 `/ops`：所以改样式不会让 film.html 的 sha 变，也不占撤销栈；
   * - 预览用 `updateStyle(patch)` 实时改，**不重建 overlay**（重建会闪一下、还丢当前 cue）；
   * - 落盘 400ms 防抖：拖滑杆时只写一次文件。
   */
  const [subtitleStyle, setSubtitleStyle] = useState<SubtitleStyleFields>(() => ({ ...SUBTITLE_STYLE_DEFAULTS }));
  const [subtitleStyleExists, setSubtitleStyleExists] = useState(false);
  const [subtitleStyleSavedAt, setSubtitleStyleSavedAt] = useState<string | null>(null);
  const [subtitleStyleBusy, setSubtitleStyleBusy] = useState(false);
  const [subtitleStyleError, setSubtitleStyleError] = useState('');
  const [subtitleStyleOpen, setSubtitleStyleOpen] = useState(false);
  const subtitleStyleRef = useRef<SubtitleStyleFields>(subtitleStyle);
  const subtitleStyleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * 待落盘的样式补丁（M45）。**带工程 id**：切工程后旧补丁只能写给旧 id，
   * 不能拿 `projectIdRef.current` 现算——那会在切换后写到新工程上。
   */
  const subtitleStylePendingRef = useRef<{ id: string; style: SubtitleStyleFields } | null>(null);
  /**
   * 时间线缩放（M47）：**视图状态**，不写 film.html、不进 /ops、不进撤销栈。
   * 刷新回 64px/s（不做持久化，见交接 notDone）。
   * `ppsRef` 给播放时的 rAF 用：`paintStage` 不该因为 pps 变化重建闭包。
   */
  const [pps, setPps] = useState(DEFAULT_PPS);
  const ppsRef = useRef(DEFAULT_PPS);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  /** 音频（M31）：最近一次「被夹住/被拒」的一句话，显示在检查器的音频区。 */
  const [audioNote, setAudioNote] = useState('');
  /** 批量分离音频（S72）：最近一次结果（逐条 done/skipped + 原因），null = 没做过。 */
  const [detachResult, setDetachResult] = useState<{
    items: Array<{ clipId: string; status: string; code: string; label: string; reason: string; audioId?: string }>;
    done: number;
    skipped: number;
    opCount: number;
  } | null>(null);
  /** 检查器页签（M27）：动效面板只在选中单个片段时可挂。 */
  const [inspectorTab, setInspectorTab] = useState<'props' | 'motion'>('props');
  const [inspectorChoice, setInspectorChoice] = useState<{ target: string; tab: InspectorObjectTab } | null>(null);
  /** 动效面板的挂载点（React 回调 ref → state，挂载 effect 依赖它）。 */
  const [motionHost, setMotionHost] = useState<HTMLDivElement | null>(null);
  /** 模板管理（M30）：含归档的全量、是否显示归档、另存名字、忙碌与最近一次结果。 */
  const [motionManage, setMotionManage] = useState<MotionManageEntry[]>([]);
  const [motionShowArchived, setMotionShowArchived] = useState(false);
  const [motionName, setMotionName] = useState('');
  const [motionBusy, setMotionBusy] = useState(false);
  const [motionNote, setMotionNote] = useState<{ ok: boolean; code?: string; text: string } | null>(null);
  /** 当前片段挂的模板（`data-props`）：用来标「在用」并把当前参数回填成表单初值。 */
  const [motionCurrent, setMotionCurrent] = useState<{ template: string; values: Record<string, unknown> } | null>(null);
  /** 舞台重载计数：模板升级/回退后源文件变了，iframe 必须重建才会重画。 */
  const [stageEpoch, setStageEpoch] = useState(0);
  /** 面板句柄（模板管理动作后 refresh）。 */
  const motionPanelRef = useRef<{ refresh: () => void } | null>(null);
  const [transportKind, setTransportKind] = useState('browser');
  const [healthText, setHealthText] = useState('检查中…');
  const [socket, setSocket] = useState<'connecting' | 'open' | 'closed'>('connecting');
  // 舞台（内容 origin）：端口从 /healthz 读，不在页面里写死。
  const [contentOrigin, setContentOrigin] = useState('');
  /** 波形缓存所属的工程（换工程才清，见下面的 effect）。 */
  const waveformProjectRef = useRef('');
  /**
   * 轨道高度（M36）：**视图偏好，不写 film.html**。按工程存 localStorage。
   * 改高度不走 `/ops`、不进撤销栈、不动 hash。
   */
  const [trackHeights, setTrackHeights] = useState<TrackHeightMap>({});
  /** 网格吸附（M36）：宿主开关 + 步长，交给 canvas-gesture 的 `opts.grid`。 */
  const [grid, setGrid] = useState<GridSetting>({ enabled: false, size: DEFAULT_GRID_SIZE });
  /**
   * 独奏（M38）：**视图态**，不写 film.html、不发 /ops、导出看不到。
   * 只活在这个会话里（换工程清空）；界面明写「导出不看独奏」。
   */
  const [soloTracks, setSoloTracks] = useState<number[]>([]);
  const [stageReady, setStageReady] = useState(false);
  const [stageError, setStageError] = useState<{ code: string; message: string } | null>(null);
  const [stageTime, setStageTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [loop, setLoop] = useState(false);
  // Electron 多标签（M16）：浏览器里为 null，不画标签栏。
  const tabsSnapshot = useTabs();
  // 导出（M17）：面板开关、表单、作业快照（轮询更新）。
  const [exportOpen, setExportOpen] = useState(false);
  const [exportForm, setExportForm] = useState<ExportForm>({
    range: 'all',
    start: '',
    end: '',
    ranges: [{ start: '', end: '' }],
    quality: 'standard',
    codec: 'h264',
    outDir: '',
    subtitleBurn: false,
    size: '',
    fit: 'letterbox',
    fps: 30,
  });
  /**
   * 导出队列（M29）：服务端快照，**入队顺序**。串行执行，最多一个 running。
   * 不再是「一个 job」：连续点导出会排队，面板里逐条可见、逐条可取消。
   */
  const [exportQueue, setExportQueue] = useState<ExportJobView[]>([]);
  const [exportQueued, setExportQueued] = useState(0);
  const [exportBusy, setExportBusy] = useState(false);
  /** 历史：localStorage 侧（工程目录不写一个字节）。 */
  const [exportHistory, setExportHistory] = useState<ExportHistoryItem[]>(() => loadHistory());
  /** 已经记进历史的作业 id：轮询会重复看到同一个终态，只记一次。 */
  const exportRecorded = useRef<Set<string>>(new Set());
  /**
   * 预览的「交付画幅」（S74）：导出面板里选了画幅，预览就按那个画幅的**可见宽**排字幕，
   * 否则会出现「预览两行、成片三行」——用户以为预览坏了。
   *
   * 跟随工程（`size` 为空）时是 `null`：letterbox、全宽可见，与旧行为逐像素一致。
   */
  const deliveryCanvas = useMemo(() => {
    const text = exportForm.size.trim();
    if (text === '') return null;
    try {
      const size = parseSizeArg(text);
      return size === null ? null : { w: size.w, h: size.h };
    } catch {
      return null;
    }
  }, [exportForm.size]);
  const deliveryRef = useRef<{ w: number; h: number } | null>(deliveryCanvas);
  deliveryRef.current = deliveryCanvas;
  const deliveryFitRef = useRef<'letterbox' | 'cover'>(exportForm.fit);
  deliveryFitRef.current = exportForm.fit;
  // 素材导入（M18）：文件输入（浏览器兜底）与忙碌标记。
  const mediaInputRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);
  /** 工程包（M59）：打包/导入各自一个忙标记，互不影响。 */
  const [archiving, setArchiving] = useState(false);
  const [importingArchive, setImportingArchive] = useState(false);
  const [archivePathOpen, setArchivePathOpen] = useState(false);
  // 素材库（M20）：assets/ 清单（缩略图走 GET /assets/:name/thumb）。
  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [assetsError, setAssetsError] = useState('');
  // —— 素材状态（M26）：逐条 bare src 的 ok/missing/unreadable；顺带给 M25 提供原生时长 ——
  const [media, setMedia] = useState<MediaStatus | null>(null);
  // —— 转场（M25）：选中的转场块；Delete 移除它 ——
  const [activeTransitionId, setActiveTransitionId] = useState<string | null>(null);
  // —— 重链面板（M26）——
  const [relinkOpen, setRelinkOpen] = useState(false);
  const [relinkPaths, setRelinkPaths] = useState<Record<string, string>>({});
  const [relinkBusy, setRelinkBusy] = useState(false);
  const [relinkNote, setRelinkNote] = useState<RelinkNote | null>(null);
  const [relinkDir, setRelinkDir] = useState('');
  const [relinkBatch, setRelinkBatch] = useState<{
    dir: string;
    matched: Array<{ clip: string; oldSrc: string; newSrc: string; name: string }>;
    skipped: Array<{ clip: string; oldSrc: string; reason: string; name?: string }>;
    summary: { relink: number; skip: number };
  } | null>(null);
  /** 批量重链最终要写的目标（= 预检通过的那些，确认后原样发出去）。 */
  const [relinkBatchTargets, setRelinkBatchTargets] = useState<Array<{ clip: string; src: string }>>([]);

  /* ── 设置中心（M49）─────────────────────────────────────────────────
   * 用户级设置：**不写 film.html、不写 .film/**。改一个控件只发一次 PUT（300ms 防抖），
   * 面板打开时 Space/S/Delete 不触发播放/切分/删除（两个全局 keydown 都要先看这里）。
   */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsOpenRef = useRef(false);
  /** Agent 面板（S70 / D 批 R40）：无遮罩浮层，落在舞台右侧；开合状态记在 localStorage。 */
  const [agentOpen, setAgentOpen] = useState(readAgentOpen);
  const [clipReferenceRequest, setClipReferenceRequest] = useState<{ projectId: string; sequenceId: string; ids: string[] } | null>(null);
  const [loudnessScope, setLoudnessScope] = useState('');
  const [speedEdge, setSpeedEdge] = useState<{ scope: string; id: string } | null>(null);
  const consumeClipReferences = useCallback(() => setClipReferenceRequest(null), []);
  const clipClipboard = useRef<{
    scope: string; entries: Extract<ReturnType<typeof copyTimelineClips>, {ok:true}>['clipboard'];
  } | null>(null);
  const clipPropertyClipboard = useRef<{ scope: string; clip: Clip } | null>(null);

  /* D 批（R40 · 批注 4 / 判据 D8）：**开与关都写** —— 只记「开」的实现会让
     「关着刷新又自己打开」。写失败（隐私模式）不影响开合本身。 */
  useEffect(() => {
    writeAgentOpen(agentOpen);
  }, [agentOpen]);

  /* D 批（R40 / 判据 D10）：点浮层外面 / Esc 收起。
     `pointerdown` 用捕获 —— 与工程菜单、布局菜单同一条理由：等 click 再收，
     浮层里的按钮已经把自己的 click 处理完了，看着像「点一下没反应又自己关了」。
     `agent-open` 那颗按钮要排除：它是开关，交给它自己的 onClick；
     否则一次点击会「先被这里关掉、再被 onClick 打开」，等于点了没反应。 */
  useEffect(() => {
    if (!agentOpen) return undefined;
    /* R102 · U1-R2：**取消「点外部即关」**。
       补正书 §1 把 Agent 定成 `1140,40 300×860` 的**全高常驻列**；而这个监听器是
       D 批（浮层形态）留下的：面板当时是浮层，点画布就该收起。改成常驻列之后，
       任何一次编辑点击（点舞台、点时间线、点播放）都会把它关掉 —— 实测就是
       s195 的第一次点击把卡宽从 540 变成 820，后面所有缓存坐标全失效
       （C7/C8/C11 连红，副读数显示 play 按钮从 x405 跑到 x545）。
       现在只保留两条明确的关闭路径：**Esc** 与面板右上角「关闭」按钮。
       **不再**因为点在别处就消失 —— 那与「常驻」自相矛盾。 */
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      /* 收口顺序（D 批 R40）：面板里还有更内层的 Esc 时先让它们吃掉这一下 ——
         E09 的 A4a 就是「`+` 菜单开着时按 Esc 只关菜单、面板留着」。
         ① 菜单在不在用 DOM 判（与监听器注册顺序无关，最可靠）；
         ② `defaultPrevented` 兜住「生成中 / 权限提示」那两条（它们各自 preventDefault）。 */
      if (event.defaultPrevented) return;
      if (document.querySelector('[data-testid="agent-panel"] [data-testid="agent-plus-menu"]') !== null) return;
      setAgentOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [agentOpen]);
  /** 版本历史（S75 · WP09）：模态面板；恢复成功后跑 `reloadAll`（不另写一套刷新）。 */
  const [versionsOpen, setVersionsOpen] = useState(false);
  /** 当前序列（S73）：导出面板要显示「将导出：<名字>」并决定请求体带不带 sequence。 */
  const [sequence, setSequence] = useState<{ id: string; name: string } | null>(null);
  const sequenceRef = useRef<{ id: string; name: string } | null>(null);
  sequenceRef.current = sequence;
  const [settingsSection, setSettingsSection] = useState('playback');
  const [settings, setSettings] = useState<SettingsFields>({
    playback: { volume: 100, loop: false, hideCursorWhilePlaying: false },
    export: { fps: 30, codec: 'h264', quality: 'standard' },
  });
  const settingsRef = useRef(settings);
  const [settingsDefaults, setSettingsDefaults] = useState<SettingsFields>(settings);
  const [settingsIssues, setSettingsIssues] = useState<string[]>([]);
  const [settingsPathText, setSettingsPathText] = useState('');
  const [settingsUpdatedAt, setSettingsUpdatedAt] = useState<string | null>(null);
  const [settingsAi, setSettingsAi] = useState<SettingsAiCard[]>([]);
  const [settingsDiag, setSettingsDiag] = useState<SettingsDiagnostics | null>(null);
  const [settingsStorage, setSettingsStorage] = useState<StorageReport | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [settingsNotice, setSettingsNotice] = useState('');
  const settingsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsPendingRef = useRef<Partial<SettingsFields> | null>(null);
  const settingsWriteRef = useRef(Promise.resolve());
  const settingsRevisionRef = useRef(0);
  /** 新开工程时要推给舞台的音量（舞台就绪那一刻才发得出去）。 */
  const pendingVolumeRef = useRef<number | null>(null);
  /** 导出表单有没有被人动过：动过就不再被「默认值」覆盖（任务书 §4.3 生效范围）。 */
  const exportFormTouchedRef = useRef(false);

  const projectIdRef = useRef('');
  const projectRef = useRef<ProjectSummary | null>(null);
  const hashRef = useRef('');
  const opSeq = useRef(0);
  const refreshRef = useRef<(id?: string) => Promise<void>>(async () => {});
  /**
   * R24（E12-P5）：左栏「字幕」面板与 App 之间**唯一**的一座桥。
   *
   * 面板是 `mountStageDock` 里的命令式 DOM（stage-dock.mjs），它自己走
   * `GET/PUT /api/projects/:id/subtitles` 读写字幕文件；但它拿不到三样只存在于 App 状态里的东西：
   *   ① 播放头（点段要跳到时间线）→ `seek`
   *   ② App 的 `cues`（时间线的 `.tl-cue` 与画布字幕都吃它）→ `reloadSubtitles`
   *   ③ 导出表单的 `subtitleBurn` → `getBurn` / `setBurn`
   * 所以这里放一个**稳定对象**，方法在每次渲染末尾重挂（闭包永远拿到最新的 state），
   * 面板按名字取用。只加这三件事，不碰布局、不碰 JSX。
   */
  const dockBridgeRef = useRef<Record<string, unknown>>({});
  // 舞台连接与「播放时不整树重绘」用的 ref（时间码/播放头直接改 DOM）。
  const stageRef = useRef<StageHandle | null>(null);
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const playheadHandleRef = useRef<HTMLDivElement | null>(null);
  const timelineScrollerRef = useRef<HTMLDivElement | null>(null);
  const timecodeRef = useRef<HTMLSpanElement | null>(null);
  /**
   * R37：轨道工具栏中段那颗时间码。与走带那颗同一套 —— 播放时 `paintStage`
   * 每帧只写它的 `textContent`，**不 setState**（否则 60fps 重绘整棵树）。
   */
  const trackTimecodeRef = useRef<HTMLSpanElement | null>(null);
  /**
   * R38（C 批）：播放器卡介绍区里那颗 `t=0.00s`（`[data-testid="stage-time"]`）。
   *
   * 以前它只在 `state` 的**停播**分支里 `setStageTime`（播放中整棵树不重绘），
   * 所以播放时这个读数一动不动 —— C11「播放真能驱动」读它会当成死按钮。
   * 现在与时间码同源：`paintStage` 每帧写文本，暂停时仍由 state 兜底。
   */
  const stageTimeRef = useRef<HTMLSpanElement | null>(null);
  const playingRef = useRef(false);
  const durationRef = useRef(0);
  const loopRef = useRef(false);
  const playheadValueRef = useRef(0);
  /** UI-V4-01：舞台拖拽 seek 要调 `seekTo`，但那条 useCallback 在本文件后半段才定义
      （源码顺序在前会触发 TDZ 检查）；用 ref 转一手，回调体运行时才取值。 */
  const seekToRef = useRef<(time: number, scrubbing?: boolean) => void>(() => {});
  const fpsRef = useRef<{ num: number; den: number }>({ num: 30, den: 1 });
  const stagePaintRaf = useRef(0);
  const stagePaintTime = useRef(0);
  const seekRaf = useRef(0);
  const seekValue = useRef<{ time: number; scrubbing: boolean } | null>(null);
  const scrubbingRef = useRef(false);
  const pendingScrubTime = useRef<number | null>(null);
  /** 最后一次 setTime 的 seq：更早的 state 回包是迟到的，不覆盖播放头。 */
  const lastSeekSeq = useRef(0);
  const pendingTransportSeq = useRef(0);
  const stageUpdateRef = useRef<(update: StageUpdate) => void>(() => {});
  const stageReadyRef = useRef(false);
  // —— 检查器（M13-A7）：挂载点、控制器、图层目标、已提交覆盖（预览与提交的基线）——
  const [inspectorHost, setInspectorHost] = useState<HTMLDivElement | null>(null);
  const inspectorRef = useRef<InspectorController | null>(null);
  const layersInstalledRef = useRef(false);
  const baseEntriesRef = useRef<unknown[]>([]);
  const inspectorTargetRef = useRef<LayerTarget | null>(null);
  /**
   * 面板几何编辑的基准片段（`pageClip` 的实时值）。
   * deps 只在 [project, hasDoc] 重挂时构造一次，闭包会过期——几何读写必须走 ref。
   */
  const pageClipRef = useRef<Clip | null>(null);
  /** 面板自己提交出来的 hash：不为空时说明这次 hash 变化是面板自己造成的，不重挂。 */
  const selfCommitHashRef = useRef('');
  const [layerOptions, setLayerOptions] = useState<
    Array<{ at: string; kind: string; name: string; depth: number; parentAt: string | null }>
  >([]);
  const [layerAt, setLayerAt] = useState('');
  /**
   * R28 · A：动效三槽的**显式重置令牌**。只有「元素真的没了 / 用户真的清空了选中」才自增；
   * doc 刷新期间的短暂空目标**不**自增 —— 面板靠它区分「等它回来」和「确实清了」。
   */
  const [motionResetToken, setMotionResetToken] = useState(0);
  /**
   * 元素多选（S93）：画布 Shift 加选出来的集合，存**裸 at**（`#title`），只在当前页面片段内。
   *
   * 与 `layerAt` 的分工：`layerAt` 是「主选中」（画布属性坞、层框、树的单选高亮都用它，
   * 页面元素的写法是统一 id `clipId::at`）；`elementSel` 是**批量编辑**的集合，
   * 只喂给 `panel.selectMany`。`0/1` 项时两者等价，`≥2` 项时面板走 multi、坞仍停在最后点的那层。
   */
  const [elementSel, setElementSel] = useState<string[]>([]);
  const [layerError, setLayerError] = useState('');
  const layerOptionsRef = useRef<
    Array<{ at: string; kind: string; name: string; depth: number; parentAt: string | null }>
  >([]);
  /** 舞台图层 / 元素检查器（S65+S66）：挂载点与控制器。 */
  const stageDockHostRef = useRef<HTMLDivElement | null>(null);
  const [creationMount, setCreationMount] = useState<{host:HTMLElement;layers:HTMLElement|null}|null>(null);
  const stageDockRef = useRef<{
    refresh: () => void;
    setSelection: (at: string) => void;
    reloadInspector: () => void;
    /** R34：字幕预设高亮（左栏那颗 = 检查器那颗，同一份样式）。 */
    setSubtitlePreset?: (id: string) => void;
    destroy: () => void;
  } | null>(null);
  const setStageDockHost = useCallback((element: HTMLDivElement | null): void => {
    stageDockHostRef.current = element;
  }, []);
  /**
   * 属性提交队列（S68 · NEW-02）：检查器的每一次写都经过它。
   *
   * 它持有每个片段的**同步** overrides / box 基座，按 `(elementId, key)` 合并、串行发
   * `/ops`。修复前是「读异步刷新的工程状态 → 拼整包」，两次提交挨得近了后一次会把
   * 前一次的键带走（`set:box` 整体替换尤其明显）。
   */
  const propsQueueRef = useRef<ReturnType<typeof createPropsQueue> | null>(null);

  // —— 画布手势与图层树（M19）——
  /** 'clip' = 时间线选中的片段在手上（可拖/可拉手柄）；'layer' = 树/舞台选中的层（只读框）。 */
  const [composeMode, setComposeMode] = useState<'clip' | 'layer'>('clip');
  const composeModeRef = useRef<'clip' | 'layer'>('clip');
  /** 会话内锁定的层（`at` 集合）；不写 film.html——合同没有 locked 字段。 */
  const [lockedLayers, setLockedLayers] = useState<string[]>([]);
  const lockedLayersRef = useRef<string[]>([]);
  /** 会话内隐藏的层（`at` 集合）：同一条规则——不写 film.html，只影响树/舞台框与点选。 */
  const [hiddenLayers, setHiddenLayers] = useState<string[]>([]);
  const hiddenLayersRef = useRef<string[]>([]);
  /** 层矩形缓存（stage 局部）：树悬停描边与舞台点选用，由 `layerRects` 一次性取回。 */
  const layerRectsRef = useRef<Map<string, StageBox>>(new Map());
  /** 手势提交轨迹（只留最近 60 条）：验收/排障时读 `window.__gestureTrace`，不写盘、不绕过校验。 */
  const gestureTraceRef = useRef<Array<Record<string, unknown>>>([]);
  /** 层框（舞台坐标）：由 describeLayer 实测，等比映射；null = 不显示。 */
  const [layerRect, setLayerRect] = useState<StageBox | null>(null);
  /**
   * R120 · M6：元素手柄的**进行中**读数（屏幕 px 位移/角度，只用于画预览框）。
   * 落盘时再换算成声明坐标 —— 「拖动中不写盘」靠这一条。
   */
  const [elementDrag, setElementDrag] = useState<{ mode: 'move' | 'resize' | 'rotate'; handle: string; dx: number; dy: number; dr: number } | null>(null);
  const elementDragRef = useRef<{
    mode: 'move' | 'resize' | 'rotate';
    handle: string;
    startX: number;
    startY: number;
    startAngle: number;
    centerX: number;
    centerY: number;
    scale: number;
    moved: boolean;
    /** 最后一次位移/角度（松手提交时用；只在内存里，不落盘）。 */
    dx: number;
    dy: number;
    dr: number;
    facts: NonNullable<typeof elementFactsRef.current>;
    space: { linear: { a: number; b: number; c: number; d: number }; rotationDeg: number };
  } | null>(null);
  /** 就地文本编辑（LI-A05）：位置/字体来自 describe，提交走同一条 overrides 链。 */
  type BodyUpdate = Extract<StageUpdate, { type: 'body' }>;
  const stageBodyRef = useRef<(update: BodyUpdate) => void>(() => {});
  const bodyDragRef = useRef<{ id: number; clip: string; at: string; move: (x: number, y: number, event: BodyUpdate) => void; finish: (cancel: boolean) => void } | null>(null);
  const [textEdit, setTextEdit] = useState<{ clipId: string; at: string; original: string; value: string; rect: ElementRect; font: Record<string, string> } | null>(null);
  /** 面板的写入口（mount 效果里塞进来）：手柄与文本编辑共用它 = 同一条事务。 */
  const elementWriteRef = useRef<{
    commit: (patch: unknown, target?: { clip: string; at: string }) => Promise<{ ok?: boolean; message?: string }>;
    preview: (patch: unknown) => Promise<unknown>;
  } | null>(null);
  /**
   * R120 · M6：当前元素的**几何事实**（describe 的 layout / 祖先链 / rotate / block）。
   * 手柄与数值路径都读这一份，别各算一套。`null` = 还没读到（不等于没有）。
   */
  const elementFactsRef = useRef<{
    at: string;
    clipId: string;
    layout: { x: number; y: number; w: number; h: number };
    visual: { x: number; y: number; w: number; h: number };
    chain:
      | { ok: true; a: number; b: number; c: number; d: number; rotationDeg: number; nodes: readonly string[] }
      | { ok: false; code: string; reason: string; nodes: readonly string[] };
    rotate: { total: number; property: number; author: number };
    style: Readonly<Record<string, string>>;
    inline: Readonly<Record<string, string>>;
    textEdit: { childElements: number; textNodes: number; pureText: boolean } | null;
    text: string;
    block: {
      position: string; display: string; parentTag: string; parentDisplay: string;
      parentPosition: string; isFlexItem: boolean; isGridItem: boolean;
      widthFrom: string; heightFrom: string;
    } | null;
    viewport: { w: number; h: number } | null;
  } | null>(null);
  /* 调试/验收句柄（与 `__layerRects` 同一性质）：只读几何事实，不绕过任何校验。 */
  (globalThis as unknown as { __elementFactsRef?: unknown }).__elementFactsRef = elementFactsRef;
  /**
   * R134 · M12：最近一次成功 describe 换算出的**舞台矩形**。
   *
   * `layerRect` 是 state，异步生效；重建期「等到事实」之后立刻要用矩形（开文本编辑器、
   * 起手势），读 state 会拿到上一帧甚至 null。这里存一份同步可读的镜像。
   */
  const elementRectRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const gestureRef = useRef<GestureController | null>(null);
  const gestureHostRef = useRef<HTMLDivElement | null>(null);
  const gestureTargetRef = useRef<{ clipId: string } | null>(null);
  /** 正在拖（含按下未动到松手）：期间屏蔽 Delete/Backspace。 */
  const draggingRef = useRef(false);
  /** 舞台相关的最新值：手势回调用 ref 读，不重建覆盖层。 */
  const docRef = useRef<FilmDoc | null>(null);
  const selectionRef = useRef<string[]>([]);
  const layerAtRef = useRef('');
  const elementSelRef = useRef<string[]>([]);
  const pageClipIdRef = useRef('');
  /**
   * R112 · L1 · **唯一的选中目标**（LI-A03）。
   *
   * 改动前「选中了什么」有三套答案：`layerAt`（画布/树）、`elementSel`（Shift 多选）、
   * `selection`（时间线）。三者各写各的，异步回包（describe/pick/listLayers）回来时
   * 没有「这是给谁的」标记，只能按 `at` 字符串往当前状态上盖 —— 换片段/换工程后会串写。
   *
   * 现在：三条入口（树 / 画布 / 时间线）都调 `writeTarget`，写同一份
   * `{projectId, sequenceId, clipId, framePath, elementKey, sourceRevision, selectionEpoch}`；
   * `layerAt` / `elementSel` / `selection` 保留为**渲染投影**（面板与探针读它们，行为不变），
   * 但不再有第二个「目标」。
   *
   * `selectionEpoch` 每次写 +1：回包拿着旧 epoch 回来 → `staleReason()` 判掉，不落地。
   */
  const [selectedTarget, setSelectedTarget] = useState<SelectedTarget>(EMPTY_TARGET);
  const targetRef = useRef<SelectedTarget>(EMPTY_TARGET);
  const targetEpochRef = useRef(0);
  /**
   * R146 / M15：元素写守卫要的「页面实例 + 每层签名」，来自 `GET /api/layers`（page 域）。
   * 服务端读不到页面就不发这两个字段 → 这里保持 null，写入一律按**老客户端**处理
   * （服务端回 `guard:"skipped"` + warn），绝不伪造目标。
   */
  const guardMarksRef = useRef<{ clipId: string; instanceId: string; fingerprints: Record<string, string | null> } | null>(null);
  /**
   * 把「当前选中的元素」翻成 `envelope.target`。只有三者同时成立才发：
   * 选中的就是这一层、`/api/layers` 给过实例与签名、写入的 clip 与选中一致。
   * 批量/多目标（一次写多层）没有单一目标 → 返回 null，走老客户端跳过分支。
   */
  const guardTargetOf = useCallback((clip: string, at: string) => {
    const marks = guardMarksRef.current;
    const target = targetRef.current;
    if (marks === null || target === null) return null;
    if (clip === '' || at === '') return null;
    if (target.clipId !== clip || target.elementKey !== at) return null;
    if (marks.clipId !== clip || marks.instanceId === '') return null;
    const signature = marks.fingerprints[at] ?? '';
    if (signature === '') return null;
    return {
      projectId: target.projectId,
      elementKey: `${clip}::${at}`,
      instanceId: marks.instanceId,
      signature,
      epoch: target.selectionEpoch,
    };
  }, []);
  /** 目标写入轨迹（最近 60 条）：证据里要能看见「谁在什么时候写了什么」，只读不写盘。 */
  const targetTraceRef = useRef<Array<{ at: number; origin: SelectionOrigin; signature: string; epoch: number }>>([]);

  /** 由当前 App 状态拼目标：片段 → 帧路径，at → 元素键（`<clipId>::` 前缀在这里剥掉）。 */
  const composeTarget = useCallback((clipId: string, at: string): SelectedTarget => {
    const clips = docRef.current?.tracks.flatMap((track) => track.clips) ?? [];
    const clip = clips.find((item) => item.id === clipId) ?? null;
    return makeTarget(
      {
        projectId: projectIdRef.current,
        sequenceId: sequenceRef.current?.id ?? 'main',
        clipId,
        framePath: clip === null ? '' : framePathOf(clip.src),
        elementKey: bareAt(clipId, at),
        sourceRevision: hashRef.current,
      },
      0,
    );
  }, []);

  /** 写目标（**唯一写入点**）：epoch +1，ref/state/调试句柄一起走。 */
  const writeTarget = useCallback(
    (clipId: string, at: string, origin: SelectionOrigin): SelectedTarget => {
      // The server retains each element's accepted epoch across renderer reloads.
      targetEpochRef.current = Math.max(targetEpochRef.current + 1, Date.now());
      const target: SelectedTarget = { ...composeTarget(clipId, at), selectionEpoch: targetEpochRef.current };
      targetRef.current = target;
      setSelectedTarget(target);
      const trace = targetTraceRef.current;
      trace.push({ at: Date.now(), origin, signature: targetSignature(target), epoch: target.selectionEpoch });
      if (trace.length > 60) trace.splice(0, trace.length - 60);
      const debug = globalThis as unknown as { __selectedTarget?: unknown; __targetTrace?: unknown };
      debug.__selectedTarget = { ...target };
      debug.__targetTrace = trace.slice();
      return target;
    },
    [composeTarget],
  );

  /**
   * 清空目标。**不置 null**：写一份「只剩工程/序列」的空目标，epoch 照样 +1 ——
   * 不然清空之后到达的旧回包会因为「当前没有目标」被当成可落（NO_TARGET 与
   * 「这是给上一个目标的」是两件事）。
   */
  const clearTarget = useCallback((origin: SelectionOrigin): SelectedTarget => writeTarget('', '', origin), [writeTarget]);

  /**
   * 旧回包守卫（LI-A06）：把「现在是什么」交给纯函数判，返回 null 才允许落地。
   * 调试出口给验收脚本用 —— 探针不需要伪造状态，直接问产品「这份回包该不该丢」。
   */
  useEffect(() => {
    const debug = globalThis as unknown as { __targetGuard?: unknown; __targetTruth?: unknown };
    debug.__targetGuard = (scope: {
      projectId?: string;
      sequenceId?: string;
      selectionEpoch?: number;
      sourceRevision?: string;
    }): StaleReason =>
      staleReason(targetRef.current, {
        projectId: scope.projectId ?? projectIdRef.current,
        sequenceId: scope.sequenceId ?? sequenceRef.current?.id ?? 'main',
        selectionEpoch: scope.selectionEpoch ?? targetEpochRef.current,
        sourceRevision: scope.sourceRevision ?? hashRef.current,
      });
    debug.__targetTruth = () => ({
      epoch: targetEpochRef.current,
      target: { ...targetRef.current },
      trace: targetTraceRef.current.slice(),
    });
  }, []);

  const setPreviewFrame = useCallback((element: HTMLDivElement | null): void => {
    gestureHostRef.current = element;
  }, []);

  /**
   * 下发元素选择集合（S93）。**只读**：`selectMany` 只 describe 选中的层，一条 Op 都不发
   * （S89 的「选中不写盘」这条不能破）。
   *
   * `apply=false` 用于「单选」：面板由下面的 `layerAt` effect 走 `select`（老路径，行为不变），
   * 这里只同步集合，避免同一次点击 describe 两遍。
   */
  const setElementSelection = useCallback((next: string[], apply = true): void => {
    elementSelRef.current = next;
    setElementSel(next);
    (globalThis as unknown as { __elementSel?: unknown }).__elementSel = next;
    if (!apply) return;
    const controller = inspectorRef.current;
    if (controller === null) return;
    const clipId = pageClipIdRef.current;
    const refs = next.map((at) => {
      const option = layerOptionsRef.current.find((item) => item.at === at);
      return { clipId, at, kind: option?.kind ?? 'unknown', name: option?.name ?? at, depth: option?.depth ?? 1 };
    });
    void controller.selectMany(refs);
  }, []);

  /**
   * S95 · 探针开关（验收用）：`__s95IgnoreExclusive === true` 时关掉下面那段互斥清理。
   * 只为一件事服务——证明 S4 的绿确实来自这条规则（关掉它，两套集合就会同时非空）。
   * 产品默认不设这个键；用 kill switch 而不是注掉源码重构建，理由同 S93 的 S10。
   */
  const exclusiveIgnored = (): boolean =>
    (globalThis as unknown as { __s95IgnoreExclusive?: boolean }).__s95IgnoreExclusive === true;

  /**
   * **模式是「当前选中什么」的唯一判别位**（S95 · B：显式互斥）。
   *
   * S93 之前这里是纯赋值，于是存在两个答案：
   * - 时间线 Shift 加选（`selectClips`）走的是片段集合，**不碰**元素集合；
   * - 画布 Shift 加选（pick 的 shift 分支）走元素集合，片段集合收成 1。
   * 先 Shift 选两层、再在时间线 Shift 点一个片段 → 两套同时非空，检查器显示上一批层，
   * 拖的却是片段。**没有测试测过它**，因为它取决于两条链路谁最后写。
   *
   * 规则：进入 `clip` ⇒ 元素集合必须为空（片段级手势接管，「哪一层」没有答案）；
   * 进入 `layer` 时**不**在这里清片段选择——它还要承载 `pageClipId`（谁的场景），
   * 由 `selectLayer` 收成「承载这一层的那一个片段」。
   */
  const changeComposeMode = useCallback(
    (mode: 'clip' | 'layer'): void => {
      if (mode === 'clip' && elementSelRef.current.length > 0 && !exclusiveIgnored()) {
        setElementSelection([]);
      }
      composeModeRef.current = mode;
      setComposeMode(mode);
    },
    [setElementSelection],
  );

  /**
   * 选中某一层（S95）：元素集合非空时，片段级多选到此为止——片段选择收成**承载它的那一个片段**。
   *
   * 为什么收成 1 而不是清空：`pageClipId` 是从选中片段推出来的（谁的场景、检查器读哪个片段），
   * 清空会让画布/检查器瞬间失去归属；收成 owner 既保住归属，也不再有「片段多选」这个第二答案。
   */
  const selectLayer = useCallback(
    (at: string, clipId?: string): void => {
      setCueIndex(null);
      setInspectorChoice(null);
      const owner = clipId ?? pageClipIdRef.current;
      if (owner !== '' && (selectionRef.current.length !== 1 || selectionRef.current[0] !== owner)) {
        setSelection([owner]);
      }
      /* 元素集合也跟着落到「就是这一层」：树/下拉这条入口以前只改 `layerAt`，集合是空的——
         于是「选中什么」在这两条入口上又变成了两个答案（`layerAt` 说 #title，集合说没有）。
         `apply=false`：面板已经由树/下拉那条路 describe 过了，这里只同步集合，不重复读。 */
      if (elementSelRef.current.length !== 1 || elementSelRef.current[0] !== at) setElementSelection([at], false);
      layerAtRef.current = at;
      setLayerAt(at);
      changeComposeMode('layer');
      /* R112：树这条入口写同一份目标（origin=tree；`at` 里的 `<clipId>::` 由 composeTarget 剥掉）。 */
      writeTarget(owner, at, 'tree');
    },
    [changeComposeMode, setElementSelection, writeTarget],
  );

  /**
   * S95 诊断位：验收脚本读「此刻两套集合各是什么」——不靠猜 DOM，也不靠面板的渲染态。
   *
   * `gestureCount` 是**片段级拖 box 真正会用到的那个集合**（`canvas-gesture` 的 `state.layers`，
   * 由 `getSelectionSet` 喂，而 `getSelectionSet` 在 layer 模式下返回空）。`clips` 是 App 的片段选择，
   * layer 模式下只允许是 1（承载这一层的那个片段）。
   */
  useEffect(() => {
    (globalThis as unknown as { __selectionTruth?: unknown }).__selectionTruth = () => {
      const gestureCount = (gestureRef.current?.getState?.() as { count?: number } | undefined)?.count ?? 0;
      const elements = elementSelRef.current.slice();
      return {
        mode: composeModeRef.current,
        clips: selectionRef.current.slice(),
        clipCount: selectionRef.current.length,
        elements,
        elementCount: elements.length,
        gestureCount,
        pageClipId: pageClipIdRef.current,
        /** S4 的不变量：任一时刻两套集合至少一套为空。 */
        exclusive: elements.length === 0 || gestureCount === 0,
      };
    };
  }, []);

  const refreshDoc = useCallback(async (id?: string, isCurrent?: () => boolean): Promise<void> => {
    const target = id ?? projectIdRef.current;
    if (target === '') return;
    const res = await getDoc(target);
    if (isCurrent?.() === false) return;
    setDoc(res.doc);
    setHash(res.hash);
    hashRef.current = res.hash;
    setUndoDepth(res.undoDepth ?? 0);
    setRedoDepth(res.redoDepth ?? 0);
    setSelection((previous) =>
      previous.filter((clipId) => res.doc.tracks.some((track) => track.clips.some((clip) => clip.id === clipId))),
    );
  }, []);
  refreshRef.current = refreshDoc;

  const keepPlayheadVisible = useCallback((time: number): void => {
    const scroller = timelineScrollerRef.current;
    if (scroller === null) return;
    const scrollLeft = scroller.scrollLeft;
    const width = scroller.clientWidth;
    const next = playheadScrollLeft(time * ppsRef.current, scrollLeft, width - HEAD_W, scroller.scrollWidth - width);
    if (Math.abs(next - scrollLeft) >= 1) scroller.scrollLeft = next;
  }, []);

  /** 播放与拖动时直接更新时间码和播放头。 */
  const paintStage = useCallback((time: number): void => {
    if (timecodeRef.current !== null) timecodeRef.current.textContent = formatTimecode(time, fpsRef.current);
    if (trackTimecodeRef.current !== null) trackTimecodeRef.current.textContent = formatTimecode(time, fpsRef.current);
    /* R38：卡片介绍区的 `t=` 也走这条（播放中不 setState，见 stageTimeRef 的注释）。 */
    if (stageTimeRef.current !== null) stageTimeRef.current.textContent = `t=${num(time, 2)}s`;
    const playheadX = time * ppsRef.current;
    if (playheadRef.current !== null) playheadRef.current.style.left = `${HEAD_W + playheadX}px`;
    if (playheadHandleRef.current !== null) playheadHandleRef.current.style.left = `${playheadX}px`;
    if (playingRef.current) keepPlayheadVisible(time);
    // 字幕跟着播放头走：播放时每帧一次（rAF 合并），暂停时 seek 也会到这里。
    subtitleOverlayRef.current?.render(time);
  }, [keepPlayheadVisible]);

  const sendSeek = useCallback((time: number, scrubbing = false): void => {
    const sent = stageRef.current?.send('setTime', scrubbing ? { t: time, scrubbing: true } : { t: time });
    if (typeof sent === 'number') lastSeekSeq.current = sent;
  }, []);

  const queueSeek = useCallback((time: number, scrubbing = false): void => {
    scrubbingRef.current = scrubbing;
    seekValue.current = { time, scrubbing };
    if (seekRaf.current) return;
    seekRaf.current = requestAnimationFrame(() => {
      seekRaf.current = 0;
      const target = seekValue.current;
      seekValue.current = null;
      if (target !== null && stageReadyRef.current) sendSeek(target.time, target.scrubbing);
    });
  }, [sendSeek]);

  // Keep the user's transport choice while a replacement stage is loading.
  const requestPlaying = useCallback((next: boolean): void => {
    playingRef.current = next;
    if (next) scrubbingRef.current = false;
    setPlaying(next);
    if (!stageReadyRef.current) return;
    if (next && seekValue.current !== null) {
      sendSeek(seekValue.current.time);
      seekValue.current = null;
    }
    pendingTransportSeq.current = stageRef.current?.send('setPlaying', { playing: next }) ?? 0;
  }, [sendSeek]);

  /**
   * 停播（R112 · L1 上移）：画布点选、精确编辑事务、走带按钮共用这一处。
   *
   * 只发 `setPlaying:false`，**不发 setTime** —— 舞台会带着「停在哪个 t」回一条 state，
   * 播放头因此停在当前时刻。以前「播放中点画布」直接改选中、根本不停播：
   * 用户以为自己在选元素，画面还在跑，选框停在旧帧上（LI-A04 的病灶）。
   */
  const pausePlayback = useCallback((): void => {
    if (playingRef.current) requestPlaying(false);
  }, [requestPlaying]);

  const scheduleStagePaint = useCallback(
    (time: number): void => {
      stagePaintTime.current = time;
      if (stagePaintRaf.current !== 0) return;
      stagePaintRaf.current = requestAnimationFrame(() => {
        stagePaintRaf.current = 0;
        paintStage(stagePaintTime.current);
      });
    },
    [paintStage],
  );

  /* ── R112 · L1 · 精确编辑事务（LI-A05）──────────────────────────────
   *
   * `beginPreciseEdit → commitPreciseEdit | cancelPreciseEdit`，拖动 / 双击 / 数值共用一套。
   *
   * 为什么事务要包住「暂停」：参考语义是「双击/拖动进入精确编辑就停在固定时刻」，
   * 编辑期间画面不许跑（不然用户按下的坐标和松手时看到的那一帧不是同一帧）。
   * 所以 begin 顺手停播、记下 `atTime`；commit 之后**不恢复播放、也不从 0 重播**，
   * 画面停在提交时刻（`refreshDoc` 换 hash 会让 iframe 重挂，重挂后由
   * 新舞台首次就绪时把同一个 t 送回去）。
   *
   * 为什么 cancel 不用回滚盘上状态：本产品的拖动与数值编辑都是**松手/确认才发一条 op**，
   * 过程中只有覆盖层预览（`onPreview` 只改 DOM，不发 /ops）。所以「没提交」= 盘上没变，
   * 取消只需要把播放头与提示复位。真出现「发了 op 但失败」（CAS 409 / 400），
   * 落盘方会 refresh 读回盘上真值 —— 这里只负责把事务关掉并说清楚为什么。
   */
  type PreciseKind = 'drag' | 'number' | 'dblclick';
  interface PreciseTxn {
    id: number;
    kind: PreciseKind;
    /** 事务开始时的目标快照：提交后要能说清「改的是谁」，串不串看它。 */
    target: SelectedTarget;
    baseHash: string;
    atTime: number;
    wasPlaying: boolean;
    beganAt: number;
  }
  const preciseIdRef = useRef(0);
  const preciseRef = useRef<PreciseTxn | null>(null);
  const preciseStatsRef = useRef<{ begun: number; committed: number; cancelled: number; lastReject: string }>({
    begun: 0,
    committed: 0,
    cancelled: 0,
    lastReject: '',
  });

  const beginPreciseEdit = useCallback(
    (kind: PreciseKind): boolean => {
      /* 拖动每帧都会到 onPreview：已在事务里就幂等返回 false，不重置起点。 */
      if (preciseRef.current !== null) return false;
      const wasPlaying = playingRef.current;
      /* 进入编辑就停在当前时刻（不是回到 0）：参考的 pause 挂在同一处手势入口上。 */
      if (wasPlaying) pausePlayback();
      preciseIdRef.current += 1;
      preciseRef.current = {
        id: preciseIdRef.current,
        kind,
        target: { ...targetRef.current },
        baseHash: hashRef.current,
        atTime: playheadValueRef.current,
        wasPlaying,
        beganAt: Date.now(),
      };
      preciseStatsRef.current.begun += 1;
      return true;
    },
    [pausePlayback],
  );

  /** 失败/取消共用的「回原状」：播放头回事务起点（盘上没变，只需复位视图），不自动重播。 */
  const restorePreciseView = useCallback(
    (atTime: number): void => {
      pendingScrubTime.current = atTime;
      playheadValueRef.current = atTime;
      setPlayhead(atTime);
      scheduleStagePaint(atTime);
      queueSeek(atTime);
    },
    [queueSeek, scheduleStagePaint],
  );

  const commitPreciseEdit = useCallback(
    /* `quiet`：落盘方已经用同一条 notice 说过原因（CAS 409 / 400 都是服务端原话），
       这里再报一次只会把那条盖掉 —— 只剩一个「未提交」的笼统提示，反而更难查。 */
    (ok: boolean, code?: string, quiet = false): void => {
      const txn = preciseRef.current;
      if (txn === null) return;
      preciseRef.current = null;
      if (ok) {
        preciseStatsRef.current.committed += 1;
        /* 不恢复播放：停在提交时刻，用户能立刻看清改成了什么（LI-A05 的「不从 0 重播」）。 */
        return;
      }
      preciseStatsRef.current.cancelled += 1;
      preciseStatsRef.current.lastReject = code ?? 'COMMIT_FAILED';
      restorePreciseView(txn.atTime);
      if (!quiet) setNotice({ kind: 'error', text: `精确编辑未提交（${code ?? 'COMMIT_FAILED'}）：已回到编辑前` });
    },
    [restorePreciseView],
  );

  const cancelPreciseEdit = useCallback(
    (reason: string): void => {
      const txn = preciseRef.current;
      if (txn === null) return;
      preciseRef.current = null;
      preciseStatsRef.current.cancelled += 1;
      preciseStatsRef.current.lastReject = reason;
      restorePreciseView(txn.atTime);
      setNotice({ kind: 'info', text: `已取消（${reason}）：目标与播放头回到编辑前` });
    },
    [restorePreciseView],
  );

  /** 调试/验收句柄：探针不伪造状态，直接问产品当前事务是什么、做过几次。 */
  useEffect(() => {
    (globalThis as unknown as { __preciseEdit?: unknown }).__preciseEdit = {
      begin: beginPreciseEdit,
      commit: commitPreciseEdit,
      cancel: cancelPreciseEdit,
      state: () => ({
        active: preciseRef.current === null ? null : { ...preciseRef.current },
        stats: { ...preciseStatsRef.current },
        playhead: playheadValueRef.current,
        playing: playingRef.current,
        target: { ...targetRef.current },
      }),
    };
  }, [beginPreciseEdit, commitPreciseEdit, cancelPreciseEdit]);

  /**
   * 舞台消息：只处理状态/错误；播放中不 setState（时间码和播放头走 ref + rAF）。 */
  const onStageUpdate = useCallback(
    (update: StageUpdate): void => {
      /* S93：舞台转发的按键（目前只有 Escape）。跨源 iframe 里的按键不冒泡到父文档，
         所以「清空多选」这条路只能从这里进来。 */
      if (update.type === 'body') {
        if (update.phase === 'down' || update.phase === 'edit') closeMoreMenu();
        stageBodyRef.current(update);
        return;
      }
      if (update.type === 'key') {
        if (update.key !== 'Escape') return;
        if (elementSelRef.current.length === 0) return;
        setElementSelection([]);
        layerAtRef.current = '';
        setLayerAt('');
        stageDockRef.current?.setSelection('');
        return;
      }
      /* UI-V4-01：舞台空白拖拽 → 比例换时间。比例由舞台按 rAF 合并后发来，
         这里落到与时间线/走带同一条 `seekTo`（会暂停、写播放头、重画时间码）。 */
      if (update.type === 'seek') {
        closeMoreMenu();
        const total = durationRef.current;
        if (!(total > 0)) return;
        seekToRef.current(update.ratio * total, !update.commit);
        return;
      }
      if (update.type === 'pick') {
        closeMoreMenu();
        // 舞台里的点击（M19-A4）：点层 → 树高亮 + 层框；点片段本体 → 片段在手上。
        (globalThis as unknown as { __lastPick?: unknown }).__lastPick = update;
        const current = docRef.current;
        if (current === null || draggingRef.current) return;
        /**
         * LI-A04：**普通画布单击 = 暂停在当前时刻**。
         *
         * 参考实证（增量包 §5）：主键 pointerdown 立刻走 pause（`kl` 2172531），
         * 暂停回调 `onPause` 在 2121054 —— 也就是「点一下画布就先停住」，不是点完继续跑。
         * 这里只停播、**不发 setTime**：舞台会带着它停住的那个 t 回一条 state，
         * 播放头因此落在当前帧（跳回 0 是旧行为里最刺眼的一种）。
         * Shift 加选不暂停：它是一条连续的批量选择手势，中途停播会让第二次点选打偏。
         */
        if (update.shift !== true) pausePlayback();
        /* S97：`clip === ''` = 点在舞台空白（不在任何片段里）。这条消息以前根本不存在
           （场景只在命中片段时才上报），所以没有旧行为要保：两套集合一起清空。 */
        if (update.clip === '') {
          setCueIndex(null);
          setSelection([]);
          setElementSelection([], false);
          layerAtRef.current = '';
          setLayerAt('');
          stageDockRef.current?.setSelection('');
          changeComposeMode('clip');
          /* R112：点空白 = 目标清空（写一份空目标，epoch 照走 —— 旧回包仍要被判掉）。 */
          clearTarget('canvas');
          return;
        }
        const owner = current.tracks.find((track) => track.clips.some((clip) => clip.id === update.clip)) ?? null;
        const clip = owner?.clips.find((item) => item.id === update.clip) ?? null;
        if (clip === null) return;
        // 锁定/隐藏的层点不动：连选中都不换（与树的 lockedAt/hiddenAt 同一条规则）。
        if (update.at !== '' && lockedLayersRef.current.includes(update.at)) return;
        if (update.at !== '' && hiddenLayersRef.current.includes(update.at)) return;
        setCueIndex(null);
        const isPageLayer = update.at !== '' && (clip.kind ?? '') === 'page';
        /**
         * 探针开关（S93 验收用）：`__s93IgnoreShift === true` 时把 Shift 分支关掉。
         * 只为一件事服务——证明「S1 的绿确实来自这条分支」。产品默认不设这个键；
         * 用 kill switch 而不是在验收脚本里注掉源码重构建，是因为后者会把源码留在
         * 「注掉」的状态（脚本中途挂掉就没人恢复）。
         */
        const shiftIgnored = (globalThis as unknown as { __s93IgnoreShift?: boolean }).__s93IgnoreShift === true;
        if (isPageLayer && update.shift === true && !shiftIgnored) {
          /* ── Shift 加选（S93）─────────────────────────────────────────
           * 只改选择，不发 Op。三条规则：
           * 1. 跨片段**拒绝**（整件事都不发生 + 一句人话）：批量提交本身只支持同一页面片段
           *    （`commitMany` 里那道 `jobClip !== clip` 就是它），悄悄把用户刚攒的三层换掉
           *    比拒绝更坏——他下一次提交的就不是他以为的那批。
           *    「拒绝」必须连**片段选择**也不动：`pageClipId` 是从选中的片段推出来的
           *    （`selected` 里有 page 片段就用它），先 `setSelection` 再拒绝会让当前片段
           *    偷偷换成另一个，接着连原片段的层都点不动了（S93 施工时踩过）。
           * 2. 已选中的层再 Shift 点 → 从集合里移除（toggle）。
           * 3. 集合空了 → 面板回空态（count 0），不留半选。
           */
          if (clip.id !== pageClipIdRef.current) {
            setNotice({ kind: 'error', text: `多选只支持同一页面片段：${update.at} 属于另一个片段，原选择保持不变` });
            return;
          }
          setSelection([clip.id]);
          const before = elementSelRef.current;
          const next = before.includes(update.at)
            ? before.filter((item) => item !== update.at)
            : [...before, update.at];
          setElementSelection(next);
          const focusAt = next.length === 0 ? '' : `${clip.id}::${next[next.length - 1]}`;
          layerAtRef.current = focusAt;
          setLayerAt(focusAt);
          setComposeMode('layer');
          composeModeRef.current = 'layer';
          stageDockRef.current?.setSelection(focusAt);
          return;
        }
        setSelection([clip.id]);
        if (isPageLayer) {
          setInspectorChoice(null);
          /* v2：页面内部元素有统一 id（`<clipId>::<elementId>`），面板直接命中那一行。
             单选时集合归一成一项（面板走 single 路径，`selectMany` 一项会自动退回单选）。 */
          const unified = unifiedAt(clip.id, update.at);
          setElementSelection([update.at], false);
          layerAtRef.current = unified;
          setLayerAt(unified);
          setComposeMode('layer');
          composeModeRef.current = 'layer';
          stageDockRef.current?.setSelection(unified);
          /* R112：画布这条入口也写同一份目标（origin=canvas）——树/画布/时间线不各存一套。 */
          writeTarget(clip.id, update.at, 'canvas');
          /* 面板若停在多选（Shift 攒过几层），**普通点击**要把它退回单选。
             只在这里做、且只在 mode === 'multi' 时做：别处（含 hash 变化）一律不许
             把 multi 打散——S92 的批量用例就是靠这一点才稳。 */
          const panelMode = (inspectorRef.current?.getState() as { mode?: string } | undefined)?.mode ?? null;
          if (panelMode === 'multi') {
            const option = layerOptionsRef.current.find((item) => item.at === update.at);
            void inspectorRef.current?.select({
              clipId: clip.id,
              at: update.at,
              kind: option?.kind ?? 'unknown',
              name: option?.name ?? update.at,
              depth: option?.depth ?? 1,
            });
          }
        } else {
          /* 点到片段本体或页面背景：两边一起清（面板高亮 + 元素检查器）。
             S95 的探针开关也管这一处——否则「关掉互斥」只关得掉 `changeComposeMode`，
             而这条分支自己会把集合清掉，探针就证明不了因果。 */
          if (!exclusiveIgnored()) setElementSelection([], false);
          if (update.at === '') {
            layerAtRef.current = '';
            setLayerAt('');
            stageDockRef.current?.setSelection('');
          }
          /* R112：点到片段本体/背景 —— 目标是「这个片段，没有元素」；epoch 照走。 */
          writeTarget(clip.id, '', 'canvas');
          /* S95：模式切换走唯一入口（它会顺手把元素集合清干净，互斥规则只有那一处）。 */
          changeComposeMode('clip');
        }
        return;
      }
      if (update.type === 'error') {
        setStageError({ code: update.code, message: update.message });
        return;
      }
      if (update.type === 'state') {
        const firstReady = update.state.ready && !stageReadyRef.current;
        stageReadyRef.current = update.state.ready;
        setStageReady(update.state.ready);
        if (!update.state.ready) return;
        // Boot acknowledges its own initial clock before the current host seek.
        durationRef.current = update.state.duration;
        if (firstReady) {
          const back = Math.min(playheadValueRef.current, update.state.duration);
          if (back < playheadValueRef.current) {
            // The edit shortened the film. Retire any pending seek past its new end.
            playheadValueRef.current = back;
            if (pendingScrubTime.current !== null) pendingScrubTime.current = back;
            setPlayhead(back);
            setStageTime(back);
          }
          seekValue.current = null;
          sendSeek(back);
          if (update.state.rate !== rate) stageRef.current?.send('setRate', { rate });
          if (update.state.volume !== volume) stageRef.current?.send('setVolume', { volume });
          if (playingRef.current) requestPlaying(true);
          scheduleStagePaint(back);
          subtitleOverlayRef.current?.render(back);
          // The boot reply predates this seek. Its time must not move the playhead.
          return;
        }
        // 迟到的旧回包：seq 比最后一次 setTime 小，不能把播放头拉回去。
        // 舞台自发的 state 是 seq 0（播放推进/停），暂停时用时间差兜底挡掉 ready 前的旧状态。
        if (pendingTransportSeq.current > 0) {
          if (update.seq < pendingTransportSeq.current) return;
          pendingTransportSeq.current = 0;
        }
        if (update.seq > 0 && update.seq < lastSeekSeq.current) return;
        // Pointer input can advance before the next animation frame sends setTime.
        // Only the reply for the latest target may take ownership of the playhead.
        if (pendingScrubTime.current !== null) {
          if (update.state.playing || Math.abs(update.state.t - pendingScrubTime.current) > 0.001) return;
          if (update.seq > 0 && update.seq === lastSeekSeq.current) pendingScrubTime.current = null;
        }
        if (update.seq === 0 && !update.state.playing && Math.abs(update.state.t - playheadValueRef.current) > 0.5) return;
        playheadValueRef.current = update.state.t;
        scheduleStagePaint(update.state.t);
        if (update.state.playing !== playingRef.current) {
          playingRef.current = update.state.playing;
          setPlaying(update.state.playing);
        }
        if (!update.state.playing && !scrubbingRef.current) {
          setPlayhead(update.state.t);
          setStageTime(update.state.t);
          // 停播：电平表归零（舞台也会发一条零值，这里兜住「还没收到」的空窗）。
          publishLevels(null);
          if (loopRef.current && update.state.duration > 0 && update.state.t >= update.state.duration - 1e-3) {
            sendSeek(0);
            requestPlaying(true);
          }
        }
        return;
      }
      if (update.type === 'levels') {
        // 25Hz 的读数只喂给电平表（canvas 自己画），**不进 React state**。
        publishLevels(update.levels);
        return;
      }
      if (update.type === 'frame' && update.settled && !scrubbingRef.current && !playingRef.current
        && Math.abs(update.t - playheadValueRef.current) < 0.001) setStageTime(update.t);
    },
    [scheduleStagePaint, sendSeek, setElementSelection, changeComposeMode, pausePlayback, requestPlaying, rate, volume, writeTarget, clearTarget, closeMoreMenu],
  );
  stageUpdateRef.current = onStageUpdate;

  const onStageIframe = useCallback(
    (element: HTMLIFrameElement | null, onPresent: () => void): void => {
      // The retired document may stay visible while its replacement decodes.
      stageRef.current?.send('setPlaying', { playing: false });
      const body = bodyDragRef.current;
      bodyDragRef.current = null;
      body?.finish(true);
      stageRef.current?.dispose();
      stageRef.current = null;
      // 图层函数装在舞台内存里：iframe 一换就要重装。
      layersInstalledRef.current = false;
      // 同步把「就绪」按住：state 的 false 要等下一帧，这段空窗里发 describe 会干等 6 秒超时。
      stageReadyRef.current = false;
      pendingTransportSeq.current = 0;
      scrubbingRef.current = false;
      if (element === null || contentOrigin === '') return;
      let presented = false;
      stageRef.current = attachStage({
        iframe: element,
        contentOrigin,
        studioOrigin: location.origin,
        onUpdate: (update: StageUpdate) => {
          if (!presented) {
            const target = playheadValueRef.current;
            const atTarget = update.type === 'frame' && update.settled && Math.abs(update.t - target) < 0.001;
            const livePlayback = update.type === 'state' && update.seq === 0 && update.state.playing;
            if (atTarget || livePlayback || update.type === 'error') {
              presented = true;
              onPresent();
            }
          }
          stageUpdateRef.current(update);
        },
      });
      // Undo can reactivate the already loaded document still on screen.
      if (element.dataset.stageAttached === 'true') stageRef.current.send('ping');
      element.dataset.stageAttached = 'true';
    },
    [contentOrigin],
  );

  const refreshList = useCallback(async (): Promise<void> => {
    try {
      const body = await listProjectsWithRecent();
      setProjects(body.projects);
      setRecentProjects(body.recent);
      setRecentCorrupt(body.recentCorrupt);
      setListError('');
    } catch (error) {
      setListError(describe(error));
    }
  }, []);

  const openByPath = useCallback(
    async (item: ProjectListItem, options: { newTab?: boolean; keepNotice?: boolean; expectedId?: string } = {}): Promise<void> => {
      setBusy(true);
      try {
        const opened = await openProject(item.path);
        if (options.expectedId !== undefined && opened.project.projectId !== options.expectedId) {
          throw new Error('工程路径已变化，请从工程管理重新打开');
        }
        // Electron：左侧列表点一下就开视图并切过去（M16-A4），本页随后被主进程隐藏。
        const api = tabsApi();
        if (api !== null && options.newTab === true) {
          const tab = await api.open({ projectId: opened.project.projectId });
          if (!tab.ok) throw new Error(tab.message ?? '无法打开工程标签');
          if (options.keepNotice !== true) setNotice(null);
          return;
        }
        if (projectIdRef.current !== opened.project.projectId) {
          pausePlayback();
          pendingScrubTime.current = 0;
          playheadValueRef.current = 0;
          seekValue.current = null;
          setPlayhead(0);
          setStageTime(0);
        }
        setProject(opened.project);
        projectRef.current = opened.project;
        projectIdRef.current = opened.project.projectId;
        const url = new URL(location.href);
        url.searchParams.set('project', opened.project.projectId);
        globalThis.history.replaceState(null, '', `${url.pathname}${url.search}`);
        await refreshDoc(opened.project.projectId);
        // 设置里的「播放默认音量」（M49）：新开工程时生效。舞台还没挂就先记着，
        // stageReady 的 effect 会补发（否则这一句会丢在 attach 之前）。
        const defaultVolume = Math.max(0, Math.min(1, settingsRef.current.playback.volume / 100));
        pendingVolumeRef.current = defaultVolume;
        setVolume(defaultVolume);
        stageRef.current?.send('setVolume', { volume: defaultVolume });
        // 导入工程包（M59）要保住「已导入 …」那一条：它是对用户刚才动作的唯一回执，
        // 打开成功后立刻清掉等于什么都没说。
        if (options.keepNotice !== true) setNotice(null);
        await refreshList();
      } catch (error) {
        setNotice({ kind: 'error', text: describe(error) });
      } finally {
        setBusy(false);
      }
    },
    [pausePlayback, refreshDoc, refreshList],
  );

  // —— 素材导入（M18）：复制进 assets/ + insert op，成功后重取 doc 并选中新片段 ——
  const postMedia = useCallback(
    async (payload: { source?: string; name?: string; data?: string }): Promise<void> => {
      const projectId = projectIdRef.current;
      if (projectId === '') return;
      setImporting(true);
      try {
        const result = await importMedia({ projectId, ...payload });
        setNotice({ kind: 'info', text: `已导入 ${result.assetPath}（${result.kind}，${num(Number(result.at))}s 起）` });
        await refreshRef.current();
        setSelection([result.clipId]);
        await refreshList();
      } catch (error) {
        setNotice({ kind: 'error', text: describe(error) });
      } finally {
        setImporting(false);
      }
    },
    [refreshList],
  );

  const pickMedia = useCallback(async (): Promise<void> => {
    const bridge = (globalThis as unknown as {
      opencut?: { pickMedia?: () => Promise<{ canceled: boolean; path?: string }> };
    }).opencut;
    if (typeof bridge?.pickMedia === 'function') {
      try {
        const picked = await bridge.pickMedia();
        if (picked?.canceled !== true && typeof picked.path === 'string' && picked.path !== '') {
          await postMedia({ source: picked.path });
        }
      } catch (error) {
        setNotice({ kind: 'error', text: describe(error) });
      }
      return;
    }
    // 浏览器：没有系统目录 API，用 <input type=file> 兜底。
    mediaInputRef.current?.click();
  }, [postMedia]);

  /**
   * 导出工程包（M59）。
   *
   * 顺序：先问宿主要保存位置（Electron 有系统保存框，浏览器返回 `ELECTRON_ONLY`），
   * 拿到位置就带 `outPath`，拿不到就让服务端落到 `<工程>/exports/`——**两条路都真的导出**，
   * 不会因为「没弹框」就 silently 什么都不做。
   */
  const archiveActive = useCallback(async (): Promise<void> => {
    const current = project;
    if (current === null || current === undefined) return;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
    const defaultName = `${current.name}-${stamp}.zip`;
    const bridge = (globalThis as unknown as {
      opencut?: { pickArchiveSave?: (name?: string) => Promise<{ canceled: boolean; path?: string; code?: string }> };
    }).opencut;
    setArchiving(true);
    try {
      let outPath: string | undefined;
      if (typeof bridge?.pickArchiveSave === 'function') {
        const picked = await bridge.pickArchiveSave(defaultName);
        if (picked?.canceled === true && picked.code !== 'ELECTRON_ONLY') return; // 用户按了取消
        if (picked?.canceled !== true && typeof picked.path === 'string' && picked.path !== '') outPath = picked.path;
      }
      const archived = await archiveProject(current.projectId, outPath);
      setNotice({
        kind: 'info',
        text: `已导出工程包 ${(archived.bytes / 1024 / 1024).toFixed(2)}MB（${String(archived.files)} 个文件）→ ${archived.path}`,
      });
    } catch (error) {
      setNotice({ kind: 'error', text: describe(error) });
    } finally {
      setArchiving(false);
    }
  }, [project]);

  /** 导入工程包（M59）：解包成功后刷列表，并把新工程直接打开。 */
  const runImportArchive = useCallback(
    async (zipPath: string): Promise<void> => {
      setImportingArchive(true);
      try {
        const imported = await importProject(zipPath);
        setArchivePathOpen(false);
        await refreshList();
        const warn =
          imported.mismatch.length > 0
            ? `；清单有 ${String(imported.mismatch.length)} 处对不上（${imported.mismatch[0]?.path ?? ''}）`
            : '';
        setNotice({
          kind: imported.mismatch.length > 0 ? 'error' : 'info',
          text: `已导入「${imported.project.name ?? imported.dir}」${String(imported.files)} 个文件 → ${imported.dir}${warn}`,
        });
        await openByPath(
          { projectId: '', name: imported.project.name ?? imported.dir, path: imported.dir, opened: false },
          { newTab: true, keepNotice: true },
        );
      } catch (error) {
        setNotice({ kind: 'error', text: describe(error) });
      } finally {
        setImportingArchive(false);
      }
    },
    [openByPath, refreshList],
  );

  /** 「导入包」按钮：有系统打开框就问，没有就展开路径输入（浏览器/测试宿主）。 */
  const pickArchive = useCallback(async (): Promise<void> => {
    const bridge = (globalThis as unknown as {
      opencut?: { pickArchiveOpen?: () => Promise<{ canceled: boolean; path?: string; code?: string }> };
    }).opencut;
    if (typeof bridge?.pickArchiveOpen !== 'function') {
      setArchivePathOpen(true);
      return;
    }
    try {
      const picked = await bridge.pickArchiveOpen();
      if (picked?.canceled === true) {
        if (picked.code === 'ELECTRON_ONLY') setArchivePathOpen(true);
        return;
      }
      if (typeof picked.path === 'string' && picked.path !== '') await runImportArchive(picked.path);
    } catch (error) {
      setNotice({ kind: 'error', text: describe(error) });
    }
  }, [runImportArchive]);

  const onMediaFile = useCallback(
    async (file: File | null): Promise<void> => {
      if (file === null) return;
      // Electron 的 File 带绝对路径（Chromium 的 File.path）：直接走路径模式。
      const absolute = (file as File & { path?: string }).path;
      if (typeof absolute === 'string' && absolute !== '') {
        await postMedia({ source: absolute });
        return;
      }
      if (file.size > 24 * 1024 * 1024) {
        setNotice({
          kind: 'error',
          text: `「${file.name}」${(file.size / 1024 / 1024).toFixed(1)}MB 超过浏览器兜底上限 24MB；大文件请在桌面版导入`,
        });
        return;
      }
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const text = String(reader.result ?? '');
          const comma = text.indexOf(',');
          resolve(comma < 0 ? text : text.slice(comma + 1));
        };
        reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
        reader.readAsDataURL(file);
      });
      await postMedia({ name: file.name, data });
    },
    [postMedia],
  );

  // —— 素材库（M20）：列 assets/、点一下插回时间线 ——
  const refreshAssets = useCallback(async (id?: string): Promise<void> => {
    const target = id ?? projectIdRef.current;
    if (target === '') {
      setAssets([]);
      setAssetsError('');
      return;
    }
    setAssetsLoading(true);
    try {
      const listed = await listAssets(target);
      setAssets(listed);
      setAssetsError('');
    } catch (error) {
      setAssetsError(describe(error));
    } finally {
      setAssetsLoading(false);
    }
  }, []);

  /** 工程/文档变化后刷新（导入也会改 hash，所以素材导入完自动出现）。 */
  useEffect(() => {
    void refreshAssets();
  }, [project, hash, refreshAssets]);

  // —— 素材状态（M26）：hash 变了就重扫一遍（重链/导入/删除都会改 hash）——
  const refreshMedia = useCallback(async (id?: string): Promise<void> => {
    const target = id ?? projectIdRef.current;
    if (target === '') {
      setMedia(null);
      return;
    }
    try {
      const status = await getMediaStatus(target);
      if (projectIdRef.current === target) setMedia(status);
    } catch {
      // 状态读不到不是致命错误：时间线照画，只是没有缺失角标/源余量。
    }
  }, []);

  useEffect(() => {
    void refreshMedia();
  }, [project, hash, refreshMedia]);

  /** 裸 src → 原生时长（M25 的源余量要用；静帧/读不出 = null）。 */
  const nativeDurations = useMemo(() => {
    /** @type {Record<string, number|null>} */
    const map: Record<string, number | null> = {};
    for (const item of media?.items ?? []) map[item.src] = item.durationSec;
    return map;
  }, [media]);

  /** 转场列表（M25）：纯函数识别，UI 只画。 */
  const transitions = useMemo<TransitionView[]>(() => {
    if (doc === null) return [];
    const presets = listAppliedTransitions(doc);
    const legacy = detectTransitions({ tracks: doc.tracks, stage: doc.stage, native: nativeDurations, fps: doc.fps }).transitions.filter((t: TransitionView) => !presets.some((p: {from:string;to:string}) => p.from === t.from.id && p.to === t.to.id));
    const expanded = presets.flatMap((p: {id:string;presetId:string;name:string;from:string;to:string;start:number;end:number;duration:number}) => {
      const track = doc.tracks.find(t => t.clips.some(c => c.id === p.to));
      const to = track?.clips.find(c => c.id === p.to), from = doc.tracks.flatMap(t => t.clips).find(c => c.id === p.from) ?? to;
      if (!track || !from || !to) return [];
      const viewClip = (c: typeof from) => { const span = clipSpan(c); return {id:c.id,src:c.src ?? '',kind:c.kind,at:span.start,end:span.end,length:span.length,sourceIn:c.time?.[0] ?? 0,sourceOut:c.time?.[1] ?? 0,fade:[0,0],audioId:null}; };
      return [{...p,trackIndex:track.index,top:'to' as const,doubleSided:true,crossfadeOk:true,fadeOnLower:false,fullFrame:true,headroom:{start:p.start,end:p.end},ramp:{clip:to.id,side:'in' as const,seconds:p.duration},from:viewClip(from),to:viewClip(to)}];
    });
    return [...legacy,...expanded] as TransitionView[];
  }, [doc, nativeDurations]);

  /**
   * 可加转场的硬切点（M28）：同轨相邻、首尾相接、没有重叠。
   * 已在重叠里的位置**不出现**（那是转场块 + 拖边缘的事）。
   */
  const cuts = useMemo<CutPointView[]>(() => {
    if (doc === null) return [];
    return detectCutPoints({ tracks: doc.tracks, stage: doc.stage, native: nativeDurations, fps: doc.fps }).cuts as CutPointView[];
  }, [doc, nativeDurations]);

  /** 缺失/读不出的素材（M26）：时间线角标 + 素材库红 chip + 导出守门都读它。 */
  const missingItems = useMemo<MediaStatusItem[]>(
    () => (media?.items ?? []).filter((item) => item.status !== 'ok'),
    [media],
  );
  const missingClips = useMemo<string[]>(() => missingItems.flatMap((item) => item.clips), [missingItems]);

  useEffect(() => {
    if (activeTransitionId !== null && !transitions.some((item) => item.id === activeTransitionId)) setActiveTransitionId(null);
  }, [activeTransitionId, transitions]);

  /**
   * 点素材 → 在播放头插入。走 M20 的 assets/:name/insert：**不复制文件**，
   * src 仍指向同一个 `assets/<name>`（M18 才会复制）。
   *
   * 波纹开时（M23-A3）同时带上 `track` = 主轨 id：服务端在**同一个 Op 批**里把该轨
   * 插入点之后的片段右移，不覆盖——所以还是一次 `/ops`、一步撤销。
   */
  const insertAssetAtPlayhead = useCallback(
    async (asset: AssetItem): Promise<void> => {
      const projectId = projectIdRef.current;
      if (projectId === '') return;
      const main = mainTrackIndex(docRef.current?.tracks ?? []);
      const rippleInsert = rippleRef.current && main !== null;
      setBusy(true);
      try {
        const result = await insertAsset(projectId, asset.name, playheadValueRef.current, {
          ...(rippleInsert ? { ripple: true, track: main } : {}),
        });
        await refreshRef.current();
        setSelection([result.clipId]);
        changeComposeMode('clip');
        const shifted = Number(result.shifted ?? 0);
        setNotice({
          kind: 'info',
          text: `已插入 ${asset.name} · ${num(Number(result.at))}s 起${shifted > 0 ? ` · ${shifted} 段右移` : ''}`,
        });
        void refreshAssets();
      } catch (error) {
        setNotice({ kind: 'error', text: describe(error) });
      } finally {
        setBusy(false);
      }
    },
    [refreshAssets],
  );

  // —— 导出队列（M29）：轮询全量队列；忙时 400ms，闲时只在面板开着时 1200ms ——
  const exportActive = exportQueue.some((job) => job.state === 'running' || job.state === 'queued') || exportQueued > 0;

  const refreshExportQueue = useCallback(async (): Promise<void> => {
    try {
      const view = await listExports();
      setExportQueue(view.jobs);
      setExportQueued(view.summary.queued);
    } catch {
      /* Studio 没起来/正在重启：保留最后一次快照，别把面板清空 */
    }
  }, []);

  useEffect(() => {
    if (!exportOpen && !exportActive) return undefined;
    void refreshExportQueue();
    const timer = globalThis.setInterval(() => {
      void refreshExportQueue();
    }, exportActive ? 400 : 1200);
    return () => {
      globalThis.clearInterval(timer);
    };
  }, [exportOpen, exportActive, refreshExportQueue]);

  /**
   * 切序列后的**整页重取**（S73 §1.1.1）。
   *
   * 为什么不能只改标签：`P` 在服务端指向「当前序列」，切换之后 doc / 轨道 / layers /
   * 字幕 / 素材 / 舞台全是另一份。这里按顺序把每一份都重新拉一遍，并把只属于上一份的
   * 界面状态清掉（选中、播放头、字幕缓存、图层树）。
   *
   * 字幕要**强制**重取：`subtitleCandidate` 只是 `assets/x.webm` 这样的相对路径，
   * 两个序列里很可能同名——靠「src 变了才重载」的 effect 会直接跳过，那就是假切换。
   */
  const reloadAll = useCallback(async (): Promise<void> => {
    const id = projectIdRef.current;
    if (id === '') return;
    setSelection([]);
    selectionRef.current = [];
    setLayerAt('');
    setLayerError('');
    layerOptionsRef.current = [];
    pausePlayback();
    pendingScrubTime.current = 0;
    queueSeek(0);
    setPlayhead(0);
    playheadValueRef.current = 0;
    cuesRef.current = [];
    setCues([]);
    subtitleRevision.current++;
    setSubtitleSource({ projectId: '', src: '' });
    setSubtitleFile(null);
    setCueDrafts(new Map());
    setCueError(null);
    setCueIndex(null);
    await refreshDoc(id);
    await refreshAssets(id);
    await refreshMedia(id);
    await refreshExportQueue();
    stageDockRef.current?.reloadInspector?.();
    subtitleOverlayRef.current?.render(0);
  }, [pausePlayback, queueSeek, refreshAssets, refreshDoc, refreshExportQueue, refreshMedia]);

  /**
   * 删除序列之后（S73）。
   *
   * 服务端的 `DELETE` 会把这个工程的**所有**序列条目一起关掉（`sequences.mjs` 的
   * `close()` 遍历了全部 slot），于是紧接着的 `GET /doc` 就是 404「工程未打开」。
   * 属服务端口径问题（交接记 BLK-R38-1），界面侧只能按「重新打开工程再重取」恢复。
   */
  const recoverAfterDelete = useCallback(async (): Promise<void> => {
    const current = projectRef.current;
    const dir = current?.path ?? '';
    if (dir === '') {
      await reloadAll();
      return;
    }
    try {
      const opened = await openProject(dir);
      projectRef.current = opened.project;
      setProject(opened.project);
      projectIdRef.current = opened.project.projectId;
      setHash(opened.project.sourceHash ?? '');
      hashRef.current = opened.project.sourceHash ?? '';
    } catch (error) {
      setNotice({ kind: 'error', text: `删除后重开工程失败：${describe(error)}` });
      return;
    }
    await reloadAll();
  }, [reloadAll]);


  /**
   * 终态作业写进历史（每 id 一次）。
   * 历史只在浏览器里：`recordHistory` 里做 localStorage 读写，失败也不影响导出。
   */
  const projectNamesRef = useRef<Map<string, string>>(new Map());
  projectNamesRef.current = new Map(projects.map((item) => [item.projectId, item.name ?? item.path ?? item.projectId]));
  useEffect(() => {
    const fresh = exportQueue.filter(
      (job) => (job.state === 'done' || job.state === 'failed' || job.state === 'cancelled') && !exportRecorded.current.has(job.id),
    );
    if (fresh.length === 0) return;
    let list = exportHistory;
    for (const job of fresh) {
      const item = historyFromJob(job, projectNamesRef.current.get(job.projectId) ?? job.projectId);
      if (item === null) continue;
      exportRecorded.current.add(job.id);
      list = recordHistory(item);
    }
    setExportHistory(list);
    // exportHistory 只在写入后变化；把它放进依赖会自激，这里刻意只跟队列走。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportQueue]);

  const openExportPanel = useCallback((): void => {
    closeMoreMenu();
    // 入出点没填过就按整片给个默认值（只是输入框初值，不代表时间线上有标记）。
    const whole = String(Math.max(0, Math.round(durationRef.current * 100) / 100));
    setExportForm((previous) => ({
      ...previous,
      start: previous.start === '' ? '0' : previous.start,
      end: previous.end === '' ? whole : previous.end,
      // 多段的第一行同理：空着就预填「整片」，第二段起才是空的（要人自己填）。
      ranges:
        previous.ranges[0] !== undefined && previous.ranges[0].end !== ''
          ? previous.ranges
          : [{ start: previous.ranges[0]?.start || '0', end: whole }],
    }));
    setExportOpen(true);
  }, [closeMoreMenu]);

  /* ── 多段导出（M39）────────────────────────────────────────────────
   * 行的增删移只改本地表单；解析、段数上限（100）、正负与顺序校验都在
   * `film-core/export-range.mjs`，提交时一次过。
   */

  const changeExportRange = useCallback((index: number, patch: Partial<ExportRangeRow>): void => {
    setExportForm((previous) => ({
      ...previous,
      ranges: previous.ranges.map((row, at) => (at === index ? { ...row, ...patch } : row)),
    }));
  }, []);

  const addExportRange = useCallback((): void => {
    setExportForm((previous) =>
      previous.ranges.length >= 100 ? previous : { ...previous, ranges: [...previous.ranges, { start: '', end: '' }] },
    );
  }, []);

  const removeExportRange = useCallback((index: number): void => {
    setExportForm((previous) =>
      previous.ranges.length <= 1 ? previous : { ...previous, ranges: previous.ranges.filter((_, at) => at !== index) },
    );
  }, []);

  const moveExportRange = useCallback((index: number, delta: number): void => {
    setExportForm((previous) => {
      const target = index + delta;
      if (target < 0 || target >= previous.ranges.length) return previous;
      const next = [...previous.ranges];
      const [row] = next.splice(index, 1);
      if (row === undefined) return previous;
      next.splice(target, 0, row);
      return { ...previous, ranges: next };
    });
  }, []);

  const submitExport = useCallback(async (): Promise<void> => {
    const projectId = projectIdRef.current;
    if (projectId === '') return;
    /** @type {'all'|{start:number,end:number}} */
    let range: 'all' | { start: number; end: number } = 'all';
    /** @type {Array<[number, number]>|null} */
    let ranges: Array<[number, number]> | null = null;
    if (exportForm.range === 'multi') {
      // 解析/校验/估算全在 film-core：这里只把 message 原样交给提示条。
      // `duration` 传进去是为了在**提交前**就拦掉「第 2 段超出片长」——服务端还会再拦一次。
      const planned = planRangeInputs(exportForm.ranges, {
        ...(durationRef.current > 0 ? { duration: durationRef.current } : {}),
      });
      if (planned.ok !== true) {
        setNotice({ kind: 'error', text: planned.message });
        return;
      }
      ranges = planned.ranges;
    } else if (exportForm.range === 'inout') {
      const start = parseRangeTime(exportForm.start);
      const end = parseRangeTime(exportForm.end);
      if (start === null || end === null || start < 0 || end <= start) {
        setNotice({
          kind: 'error',
          text: `入出点不合法：需要 0 ≤ 入点 < 出点（当前 ${exportForm.start} → ${exportForm.end}）`,
        });
        return;
      }
      range = { start, end };
    }
    setExportBusy(true);
    try {
      // 画幅（M42）：空 = 跟随工程（size/fit 都不发）；否则交给 render 的 parseSizeArg
      // （认 `1080x1920` / `1080×1920` / `1080p` / `portrait` 这些别名，不自己写正则）。
      /** @type {{w: number, h: number}|null} */
      let size = null;
      if (exportForm.size.trim() !== '') {
        try {
          size = parseSizeArg(exportForm.size);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setNotice({ kind: 'error', text: `画幅不合法：${message}` });
          return;
        }
      }
      // 烧字幕（M41）：只有「开关开着 + 这个工程真有字幕」才发请求字段；
      // 否则一个字段都不发——不烧录的请求体与 R20 逐字节相同（A1/A8 的回归靠这个）。
      // 用 `subtitleSrc`（当前加载的那份）而不是重新推一个：烧的必须是面板里看到的同一份。
      const burnOn = exportForm.subtitleBurn === true && subtitleSrc !== '' && (subtitleFile ?? '') !== '' && cues.length > 0;
      const job = await startExport({
        projectId,
        range,
        ...(ranges === null ? {} : { ranges }),
        quality: exportForm.quality,
        // 编码（M50）：默认 h264 = 服务端缺省值，**不发字段**——不选时的请求体与 R24 逐字节相同。
        ...(exportForm.codec === 'h264' ? {} : { codec: exportForm.codec }),
        outDir: exportForm.outDir,
        ...(size === null ? {} : { size, fit: exportForm.fit }),
        fps: exportForm.fps,
        ...(burnOn ? { subtitleBurn: true, subtitleSrc } : {}),
        // 序列（S73）：main 不发这个字段（旧请求体逐字节不变），其它序列显式带上。
        sequence: sequenceRef.current?.id ?? null,
      });
      // 入队即返回（可能 queued 也可能 running）；队列本身由轮询同步。
      await refreshExportQueue();
      // 记住这次的参数（M54）。**入队成功就记**，不等编码完成：参数在点下按钮那一刻
      // 就已经定了，而「上次排了 40 分钟最后失败」的人下次更该看到同一套值。
      // 写失败不影响导出本身——下次初值退回设置中心的默认值，不是错误。
      void putSettings({
        export: {
          last: {
            codec: exportForm.codec,
            quality: exportForm.quality,
            fps: exportForm.fps,
            size: exportForm.size,
            fit: exportForm.fit,
            subtitleBurn: burnOn,
          },
        },
      }).catch(() => undefined);
      setNotice({
        kind: 'info',
        text: job.state === 'queued' ? `已排到第 ${job.position ?? 1} 位：前面的导出结束后自动开工` : '已开始导出（队列里第 1 个）',
      });
    } catch (error) {
      setNotice({ kind: 'error', text: describe(error) });
    } finally {
      setExportBusy(false);
    }
  }, [cues.length, exportForm, refreshExportQueue, subtitleFile, subtitleSrc]);

  /** 取消某一个：排队中的立刻出队（永不执行），运行中的 abort → 杀 ffmpeg。 */
  const cancelExportJob = useCallback(
    async (id: string): Promise<void> => {
      if (id === '') return;
      try {
        const job = await cancelExport(id);
        await refreshExportQueue();
        setNotice({
          kind: 'info',
          text: job.state === 'cancelled' ? '已取消（没有留下半成品）' : '取消请求已发出：正在停子进程…',
        });
      } catch (error) {
        setNotice({ kind: 'error', text: describe(error) });
      }
    },
    [refreshExportQueue],
  );

  /**
   * 定位产物：Electron 用 `shell.showItemInFolder`（真的在 Finder 里选中文件）；
   * 浏览器拿不到系统能力，退化为**复制路径**（提示里也把路径写全，方便手选）。
   */
  const revealOutput = useCallback(async (path: string): Promise<void> => {
    if (path === '') return;
    const host = (globalThis as unknown as { opencut?: { transport?: string; showItemInFolder?: (p: string) => Promise<{ ok: boolean; code?: string; message?: string }> } }).opencut;
    if (host?.transport === 'electron' && typeof host.showItemInFolder === 'function') {
      try {
        const result = await host.showItemInFolder(path);
        if (result?.ok !== true) setNotice({ kind: 'error', text: result?.message ?? `定位失败（${result?.code ?? 'UNKNOWN'}）` });
      } catch (error) {
        setNotice({ kind: 'error', text: describe(error) });
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(path);
      setNotice({ kind: 'info', text: `已复制产物路径：${path}` });
    } catch {
      setNotice({ kind: 'info', text: `产物路径：${path}` });
    }
  }, []);

  /** 失败详情一键复制：码 + 人话 + 作业上下文（支持让别人复现）。 */
  const copyExportDetail = useCallback(async (job: ExportJobView): Promise<void> => {
    const text = [
      `code: ${job.error?.code ?? 'EXPORT_FAILED'}`,
      `message: ${job.error?.message ?? ''}`,
      `job: ${job.id}`,
      `project: ${job.projectId}`,
      `queuedAt: ${job.queuedAt ?? ''}`,
      `startedAt: ${job.startedAt ?? ''}`,
      `finishedAt: ${job.finishedAt ?? ''}`,
      `stage: ${job.stage} · ${Math.round(job.percent * 1000) / 10}% · ${job.frames}/${job.framesTotal} 帧`,
      `quality: ${job.quality ?? ''} · range: ${job.range === null || job.range === undefined ? 'all' : `${job.range[0]}-${job.range[1]}`}`,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setNotice({ kind: 'info', text: '失败详情已复制（码 + 原始消息 + 作业上下文）' });
    } catch {
      setNotice({ kind: 'error', text: `复制失败，详情：${job.error?.message ?? ''}` });
    }
  }, []);

  // 启动：探针 → 健康 → 工程列表 → 按 URL 或 Studio 的「已打开」状态恢复现场。
  useEffect(() => {
    let alive = true;
    void (async () => {
      const probe = installProbe();
      setTransportKind(probe.transport);
      const healthBody = await health();
      if (alive) {
        setHealthText(healthBody.ok ? `Studio ${healthBody.version ?? ''} 在线`.trim() : 'Studio 离线');
        setContentOrigin(healthBody.contentOrigin?.origin ?? '');
      }
      let list: ProjectListItem[] = [];
      try {
        const body = await listProjectsWithRecent();
        list = body.projects;
        setRecentProjects(body.recent);
        setRecentCorrupt(body.recentCorrupt);
      } catch (error) {
        if (alive) setListError(describe(error));
      }
      if (!alive) return;
      setProjects(list);
      setListLoading(false);

      const wanted = new URLSearchParams(location.search).get('project');
      let target: ProjectListItem | undefined;
      if (wanted !== null && wanted !== '') {
        target = list.find((item) => item.projectId === wanted);
        if (target === undefined) {
          const summary = await getProject(wanted).catch(() => null);
          if (summary !== null) {
            target = { projectId: wanted, name: summary.name ?? wanted, path: summary.path ?? '', opened: true };
          }
        }
      }
      if (!alive) return;
      if (wanted) {
        if (target === undefined) {
          setListError('找不到指定的工程，请从工程管理重新打开');
          return;
        }
        await openByPath(target, { expectedId: wanted });
        return;
      }
      target = list.find((item) => item.opened === true);
      if (target !== undefined) await openByPath(target);
    })();
    return () => {
      alive = false;
    };
  }, [openByPath]);

  // 事件：WS /events；只用来触发重取，不当作数据。
  useEffect(() => {
    let stopped = false;
    let socketRef: WebSocket | null = null;
    let timer: number | null = null;
    let since: number | null = null;

    const connect = (): void => {
      if (stopped) return;
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${protocol}://${location.host}/events`);
      socketRef = ws;
      setSocket('connecting');
      ws.onopen = () => {
        if (stopped) return;
        setSocket('open');
        ws.send(JSON.stringify({ type: 'subscribe', ...(since === null ? {} : { since }) }));
      };
      ws.onmessage = (event) => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(String(event.data)) as Record<string, unknown>;
        } catch {
          return;
        }
        if (typeof message.seq === 'number') since = message.seq;
        const payload = (message.event ?? message) as Record<string, unknown>;
        const type = payload.type;
        const projectId = payload.projectId;
        if (type === 'doc.changed' || type === 'film.changed') {
          if (projectId === projectIdRef.current) void refreshRef.current();
        } else if (type === 'agent.projectOpen' && projectId === projectIdRef.current &&
          typeof payload.targetProjectId === 'string' && /^[0-9a-f]{16}$/.test(payload.targetProjectId)) {
          const api = tabsApi();
          if (api === null) return;
          void api.open({ projectId: payload.targetProjectId }).then(result => {
            if (!result.ok) setNotice({ kind: 'error', text: result.message ?? '无法打开 Agent 选定的项目' });
          }).catch(error => setNotice({ kind: 'error', text: describe(error) }));
        } else if (type === 'resync') {
          const current = projectRef.current;
          if (current !== null && typeof current.path === 'string' && current.path !== '') {
            void openByPath({ projectId: current.projectId, name: current.name ?? current.projectId, path: current.path, opened: true });
          }
        }
      };
      ws.onclose = () => {
        if (stopped) return;
        setSocket('closed');
        timer = globalThis.setTimeout(connect, 800) as unknown as number;
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          // 已经关了
        }
      };
    };

    connect();
    return () => {
      stopped = true;
      if (timer !== null) globalThis.clearTimeout(timer);
      try {
        socketRef?.close();
      } catch {
        // 同上
      }
    };
  }, [openByPath]);

  const selected = useMemo(() => resolveSelection(doc, selection), [doc, selection]);
  const allClips = useMemo(() => (doc === null ? [] : doc.tracks.flatMap((track) => track.clips)), [doc]);
  const subtitleCandidate = useMemo(() => {
    const video = allClips.find((clip) => clip.kind === 'video');
    return video?.src.split('#')[0] ?? '';
  }, [allClips]);
  const hasCurrentSubtitle = project?.projectId === subtitleProjectId && subtitleCandidate === subtitleSrc;
  /** 音频手势的目标（顺序与选择一致；多选时判「混合」）。 */
  const audioTargets = useMemo(() => selected.map((item) => ({ id: item.clip.id, clip: item.clip })), [selected]);
  /** 单选的那一个片段（检查器/动效/音轨提示都按它判；多选时 null）。 */
  const selectedClip = selected.length === 1 ? (selected[0]?.clip ?? null) : null;
  /** 工程里有没有声音片段：没有就显示「无音轨」，而不是一条平线冒充。 */
  const hasAudio = useMemo(
    () => allClips.some((clip) => (clip.kind ?? '') === 'sound'),
    [allClips],
  );
  const duration = useMemo(() => {
    let end = 0;
    for (const clip of allClips) end = Math.max(end, clipSpan(clip).end);
    return end;
  }, [allClips]);
  fpsRef.current = doc?.fps ?? { num: 30, den: 1 };
  loopRef.current = loop;

  // —— 检查器（M13-A7）——
  const pageClips = useMemo(() => allClips.filter((clip) => (clip.kind ?? '') === 'page'), [allClips]);
  const pageClip = useMemo(() => {
    const chosen = selected.find((item) => (item.clip.kind ?? '') === 'page');
    return chosen?.clip ?? pageClips[0] ?? null;
  }, [selected, pageClips]);
  const pageClipId = pageClip?.id ?? '';
  pageClipRef.current = pageClip;
  /* S68：把服务端真值补进属性队列的同步基座。队列有排队/在途的写时会自己忽略这次补水，
     否则一次 refresh 就能把用户刚提交的乐观值打回旧值。 */
  if (pageClip !== null) {
    propsQueueRef.current?.hydrate(pageClip.id, { entries: pageClip.overrides ?? [], box: boxOfPageClip(pageClip) });
  }
  docRef.current = doc;
  selectionRef.current = selection;
  layerAtRef.current = layerAt;
  pageClipIdRef.current = pageClipId;
  lockedLayersRef.current = lockedLayers;
  hiddenLayersRef.current = hiddenLayers;
  layerOptionsRef.current = layerOptions;
  rippleRef.current = ripple;
  snapRef.current = snap;


  /** 舞台内容在编辑器视口里的矩形 + 有效缩放（内容 origin 的 fitStage 规则，见 content-origin）。 */
  const stageRectNow = useCallback((): { x: number; y: number; w: number; h: number; scale: number } | null => {
    const iframe = stageRef.current?.iframe ?? null;
    const current = docRef.current;
    if (iframe === null || current === null) return null;
    const r = iframe.getBoundingClientRect();
    const sw = current.stage.w;
    const sh = current.stage.h;
    if (!(r.width > 0) || !(r.height > 0) || !(sw > 0) || !(sh > 0)) return null;
    const scale = Math.min(r.width / sw, r.height / sh);
    const w = sw * scale;
    const h = sh * scale;
    return {
      x: r.x + Math.max(0, (r.width - w) / 2),
      y: r.y + Math.max(0, (r.height - h) / 2),
      w,
      h,
      scale,
    };
  }, []);

  /**
   * 覆盖层（选框 / 尺寸 HUD）的定位基座（F03 · R30-062）。
   *
   * 为什么不能直接用 `stageRectNow()`：它读的是 iframe 的 `getBoundingClientRect()`，在 render
   * 期间读到的还是**上一次布局**。面板一开合（画布 824 → 520，纯 CSS 轨道变化）不会有第二次
   * render，fixed 覆盖层就停在旧坐标上，跨进检查器/Agent 列。这里在**布局落定后**量一次
   * （layout effect + ResizeObserver），并且把结果裁进 `[data-testid="preview"]` 的实际 rect ——
   * 覆盖层永远不出预览面板。只改定位，不碰手势/事件/选择状态。
   */
  const [overlayStage, setOverlayStage] = useState<{ x: number; y: number; w: number; h: number; scale: number } | null>(null);
  const measureOverlay = useCallback((): void => {
    const next = stageRectNow();
    const previewEl = gestureHostRef.current?.closest('[data-testid="preview"]') ?? null;
    let bounded = next;
    if (next !== null && previewEl !== null) {
      const pr = previewEl.getBoundingClientRect();
      const x = Math.max(next.x, pr.x);
      const y = Math.max(next.y, pr.y);
      const right = Math.min(next.x + next.w, pr.right);
      const bottom = Math.min(next.y + next.h, pr.bottom);
      const w = Math.max(0, right - x);
      const h = Math.max(0, bottom - y);
      if (w > 0 && h > 0) bounded = { x, y, w, h, scale: next.scale };
    }
    setOverlayStage((previous) => {
      if (bounded === null) return previous === null ? previous : null;
      if (
        previous !== null
        && Math.abs(previous.x - bounded.x) <= 0.5
        && Math.abs(previous.y - bounded.y) <= 0.5
        && Math.abs(previous.w - bounded.w) <= 0.5
        && Math.abs(previous.h - bounded.h) <= 0.5
      ) return previous;
      return bounded;
    });
  }, [stageRectNow]);
  useLayoutEffect(() => {
    measureOverlay();
  });
  useEffect(() => {
    const host = gestureHostRef.current;
    if (host === null) return undefined;
    const previewEl = host.closest('[data-testid="preview"]') ?? host;
    /**
     * R34-B：字幕覆盖层和选框覆盖层是**同一个失效原因** —— 面板开合是纯 CSS 轨道变化
     * （画布 824 → 520），window 不 resize，字幕模块内部只听 `resize`，于是 inline
     * `left/width` 停在旧舞台上（R33 实测右溢 261/330/292，字幕中心偏 152/170/180）。
     * 这里复用同一处 ResizeObserver：预览列或舞台容器一变就按新几何重画，
     * 覆盖面板开合 / 栏宽变化 / 时间线高度变化 / 窗口缩放所有路径。
     * 只重算定位，不碰字幕内容、样式与事件。
     *
     * 依赖里必须有「有没有文档」：没打开工程时这里渲染的是 `EmptyStage`，`.preview-frame`
     * 根本不存在，`gestureHostRef.current` 是 null —— 只依赖稳定回调的话这段 effect
     * 会永远早退，observer 一次都挂不上（R30-062 的选框覆盖层就一直是这个状态，
     * 它靠"每次渲染都跑的 useLayoutEffect"兜住，所以没暴露）。
     */
    const syncSubtitle = (): void => {
      subtitleOverlayRef.current?.render(playheadValueRef.current);
    };
    const observer = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          measureOverlay();
          syncSubtitle();
        })
      : null;
    observer?.observe(previewEl);
    observer?.observe(host);
    const onViewport = (): void => measureOverlay();
    window.addEventListener('resize', onViewport);
    window.addEventListener('scroll', onViewport, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', onViewport);
      window.removeEventListener('scroll', onViewport, true);
    };
  }, [measureOverlay, doc !== null]);
  /* 覆盖层位置变了，手势环/把手也要按同一套 rect 重画（它自己只监听 window resize/scroll）。 */
  useEffect(() => {
    gestureRef.current?.refresh();
  }, [overlayStage]);

  /**
   * 片段在舞台上**实际画出来的**矩形（舞台坐标）。
   * 网页片段按自有尺寸等比放进声明的 box（letterbox），其余片段直接取 box；没有 box = 铺满舞台。
   * 与 content-origin 的 `pictureRect` 同一套规则（这里只是只读推算，不写盘）。
   */
  const pictureRectOf = useCallback((clip: Clip): StageBox | null => {
    const current = docRef.current;
    if (current === null) return null;
    const st = current.stage;
    if ((clip.kind ?? '') === 'page') {
      const own = clip.size && Number(clip.size.w) > 0 ? clip.size : st;
      const raw = clip.box;
      const hasBox = raw !== undefined && Number(raw?.w) > 0 && Number(raw?.h) > 0;
      const b = hasBox
        ? { x: Number(raw?.x ?? 0), y: Number(raw?.y ?? 0), w: Number(raw?.w), h: Number(raw?.h) }
        : { x: (st.w - own.w) / 2, y: (st.h - own.h) / 2, w: own.w, h: own.h };
      const k = Math.min(b.w / own.w, b.h / own.h);
      const w = own.w * k;
      const h = own.h * k;
      return { x: b.x + (b.w - w) / 2, y: b.y + (b.h - h) / 2, w, h };
    }
    const box = clip.box;
    if (box !== undefined && Number(box.w) > 0 && Number(box.h) > 0) {
      return { x: Number(box.x ?? 0), y: Number(box.y ?? 0), w: Number(box.w), h: Number(box.h) };
    }
    return { x: 0, y: 0, w: st.w, h: st.h };
  }, []);

  /** 手势的起始声明 box：有声明用声明，没有就用实测矩形（第一次拖动把尺寸写进 style）。 */
  const declaredBoxOf = useCallback(
    (clip: Clip): { x: number; y: number; w: number; h: number; r?: number } | null => {
      const rect = pictureRectOf(clip);
      const box = clip.box;
      const r = Number(box?.r ?? 0);
      if (box !== undefined && Number(box.w) > 0 && Number(box.h) > 0) {
        const value = { x: Number(box.x ?? 0), y: Number(box.y ?? 0), w: Number(box.w), h: Number(box.h) };
        return Number.isFinite(r) && r !== 0 ? { ...value, r } : value;
      }
      return rect === null ? null : { ...rect };
    },
    [pictureRectOf],
  );

  /**
   * 手势提交轨迹（只留最近 60 条，内存里）。
   *
   * 为什么留：R8（boxOf/commitBox 没接）、R9（quality 被覆盖）、R10（旋转静默不提交）
   * 三次接缝事故都是「界面看起来动了、磁盘没动」。有这条轨迹就能一眼看出 op 到没到宿主、
   * 被哪个条件挡下、服务端回了什么码——不用再靠猜。
   */
  const traceGesture = useCallback((step: string, data?: Record<string, unknown>): void => {
    const list = gestureTraceRef.current;
    list.push({ at: new Date().toISOString(), step, ...(data ?? {}) });
    if (list.length > 60) list.splice(0, list.length - 60);
    (globalThis as unknown as { __gestureTrace?: unknown[] }).__gestureTrace = list;
  }, []);

  /** 手势出错统一出口：显示成 notice（不许静默吞掉），同时进轨迹。 */
  const gestureError = useCallback(
    (code: string, message: string): void => {
      traceGesture('error', { code, message });
      setNotice({ kind: 'error', text: `${code}: ${message}` });
    },
    [traceGesture],
  );

  /**
   * 舞台上「可点 / 可拖」的对象。
   *
   * **是片段，不是场景层**：合同只有片段的 `box` 写入口（`set field:'box'`）；层几何要走
   * overrides 的 style 且没有可靠写入口（R10-F3 仍未解决），所以把层交给手势层只会产生
   * 「写不进去的框」。层点选仍由 content-origin 的 pick 负责并路由到检查器。
   */
  const clipPickables = useCallback((): Array<{
    at: string;
    clip: string;
    box: { x: number; y: number; w: number; h: number; r?: number };
    rect: StageBox;
  }> => {
    const current = docRef.current;
    if (current === null) return [];
    const out: Array<{
      at: string;
      clip: string;
      box: { x: number; y: number; w: number; h: number; r?: number };
      rect: StageBox;
    }> = [];
    for (const track of current.tracks) {
      for (const clip of track.clips) {
        if ((clip.kind ?? '') === 'sound') continue;
        if (hiddenLayersRef.current.includes(clip.id)) continue;
        const rect = pictureRectOf(clip);
        const box = declaredBoxOf(clip);
        if (rect === null || box === null) continue;
        out.push({ at: clip.id, clip: clip.id, box, rect });
      }
    }
    return out;
  }, [pictureRectOf, declaredBoxOf]);

  /**
   * 手势的「手上是谁」：时间线选中集合 → 可编辑片段。
   *
   * 剔除规则（每条都对应一次踩过的坑）：轨道锁定 / 音频片段（没有 box）/ 会话内隐藏 /
   * 层模式（`composeMode === 'layer'` 时片段不在手上，层框是只读的）。
   * `gestureTargetRef` 同时更新：单选记下 clipId（兼容单条提交），多选/空集置空。
   */
  const gestureSelection = useCallback((): Array<{
    at: string;
    clip: string;
    box: { x: number; y: number; w: number; h: number; r?: number };
    rect: StageBox;
  }> => {
    gestureTargetRef.current = null;
    if (composeModeRef.current !== 'clip') return [];
    const current = docRef.current;
    if (current === null || stageRectNow() === null) return [];
    const out: Array<{
      at: string;
      clip: string;
      box: { x: number; y: number; w: number; h: number; r?: number };
      rect: StageBox;
    }> = [];
    for (const { clip, track } of resolveSelection(current, selectionRef.current)) {
      if (track.locked === true) continue;
      if ((clip.kind ?? '') === 'sound') continue;
      if (hiddenLayersRef.current.includes(clip.id)) continue;
      const rect = pictureRectOf(clip);
      const box = declaredBoxOf(clip);
      if (rect === null || box === null) continue;
      out.push({ at: clip.id, clip: clip.id, box, rect });
    }
    if (out.length === 1 && out[0] !== undefined) gestureTargetRef.current = { clipId: out[0].at };
    return out;
  }, [pictureRectOf, declaredBoxOf, stageRectNow]);

  /**
   * 吸附目标：其他片段的画面矩形（舞台局部）；模块自己按 `at` 排除选中项。
   */
  const snapTargetsOf = useCallback((): Array<StageBox & { at: string }> => {
    const current = docRef.current;
    if (current === null) return [];
    const out: Array<StageBox & { at: string }> = [];
    for (const track of current.tracks) {
      for (const clip of track.clips) {
        if ((clip.kind ?? '') === 'sound') continue;
        if (hiddenLayersRef.current.includes(clip.id)) continue;
        const rect = pictureRectOf(clip);
        if (rect !== null) out.push({ at: clip.id, ...rect });
      }
    }
    return out;
  }, [pictureRectOf]);

  /**
   * 一次手势 = 一批 Op（未必一条）。
   *
   * 单选与多选走同一个出口：`/ops` 的 `ops` 数组一次发完 —— 多选是**一步撤销**，
   * 不许拆成 N 次请求（拆了撤销就要按 N 次）。
   */
  const commitGestureOps = useCallback(
    /* R112 · L1：返回值给精确编辑事务用（`true` = 落盘成功）。以前是 void——
       事务拿不到成败就只能「假装提交成功」，与「取消/失败回原状」直接冲突。 */
    async (ops: readonly unknown[], intent: 'single' | 'many'): Promise<boolean> => {
      const projectId = projectIdRef.current;
      const envelope: Envelope = {
        projectId,
        batchId: 'B-MAIN-R11-011',
        owner: 'MAIN',
        expectedHash: hashRef.current,
        opId: `main-r11:${intent}:${Date.now()}:${Math.random().toString(16).slice(2, 6)}`,
      };
      const list = ops.filter((op): op is EditOp => op !== null && typeof op === 'object') as EditOp[];
      if (projectId === '' || list.length === 0) {
        gestureError('GESTURE_EMPTY', `没有可提交的 op（${intent}，${list.length} 条）`);
        return false;
      }
      const bad = list.find((op) => op.op !== 'set' || op.field !== 'box');
      if (bad !== undefined) {
        gestureError('GESTURE_OP_UNSUPPORTED', `手势只产 set/field:'box'，收到 ${String(bad.op)}/${String(bad.field)}`);
        return false;
      }
      traceGesture('commit:send', {
        intent,
        count: list.length,
        clips: list.map((op) => String(op.clip ?? '')),
        rotate: list.map((op) => Number((op.value as { r?: number } | undefined)?.r ?? 0)),
      });
      try {
        const result = await postOps(projectId, envelope, list);
        if (typeof result.hash === 'string' && result.hash !== '') {
          hashRef.current = result.hash;
          // 不设 selfCommitHash：hash 变化要触发面板重选一次，把落盘后的值读回来。
          setHash(result.hash);
        }
        traceGesture('commit:ok', { intent, count: list.length, hash: String(result.hash ?? '') });
        setNotice({
          kind: 'info',
          text:
            intent === 'many'
              ? `${list.length} 个片段已一起提交 · ${String(result.hash ?? '').slice(0, 8)}`
              : `几何已提交 · ${String(result.hash ?? '').slice(0, 8)}`,
        });
        void refreshRef.current();
        return true;
      } catch (error) {
        const code = error instanceof ApiError ? error.code : 'GESTURE_COMMIT_FAILED';
        // ApiError.message 是服务端原话（已经写了原因），不要再把 code 前缀一次。
        gestureError(code, error instanceof ApiError ? error.message : describe(error));
        return false;
      }
    },
    [gestureError, traceGesture],
  );

  /** 单选：一条 `set field:'box'`。不再有静默 return——每个不提交的分支都留痕。 */
  const commitGestureBox = useCallback(
    async (op: unknown): Promise<boolean> => {
      const target = gestureTargetRef.current;
      const boxOp = (op ?? {}) as { field?: string; value?: unknown; clip?: string };
      const clipId = String(boxOp.clip ?? target?.clipId ?? '');
      if (boxOp.field !== 'box') {
        gestureError('GESTURE_OP_UNSUPPORTED', `手势只接受 field:'box'，收到 ${String(boxOp.field)}`);
        return false;
      }
      if (clipId === '') {
        gestureError('NO_BASE_BOX', '没有手势目标片段：选中集合为空或全是不可编辑片段');
        return false;
      }
      return await commitGestureOps([{ op: 'set', clip: clipId, field: 'box', value: boxOp.value }], 'single');
    },
    [commitGestureOps, gestureError],
  );

  const toggleLayerLock = useCallback((): void => {
    const at = layerAtRef.current;
    if (at === '') return;
    const next = !lockedLayersRef.current.includes(at);
    // 树是锁定的唯一真相：先让树改（它会回调 onLockChange 把集合写回来），
    // 这样「锁定当前层」按钮与树行尾的锁按钮不会各存一份。
    const tree = inspectorRef.current?.getTree?.() as { setLocked?: (target: string, locked: boolean) => boolean } | null;
    if (typeof tree?.setLocked === 'function' && tree.setLocked(at, next)) return;
    const merged = next
      ? [...lockedLayersRef.current, at]
      : lockedLayersRef.current.filter((item) => item !== at);
    lockedLayersRef.current = merged;
    setLockedLayers(merged);
  }, []);

  /** 时间线选片段 = 把片段放到手上（层框让位给片段框与手柄）。 */
  const selectClips = useCallback(
    (ids: string[], additive: boolean): void => {
      setCueIndex(null);
      setSelection((previous) => (additive ? [...new Set([...previous, ...ids])] : ids));
      /* S95：片段级手势（含 Shift 加选）一律进 clip 模式——元素集合由 `changeComposeMode` 清掉。
         以前只有「非加选且恰好一个」才切模式，于是加选时会留着一个多选中的检查器。 */
      changeComposeMode('clip');
      /* R112：时间线这条入口写同一份目标（片段级 = 没有 elementKey）。
         多选时 clipId 留空：几个片段不是一个可编辑目标，拿其中一个冒充会让右栏
         把「其它片段的属性」当成这一批的代表（LI-A03 明说的混合选择问题）。 */
      if (ids.length === 1 && ids[0] !== undefined) writeTarget(ids[0], '', 'timeline');
      else clearTarget('timeline');
    },
    [changeComposeMode, writeTarget, clearTarget],
  );

  /** 换网页片段 → 会话内锁定/隐藏清零（锁的是「那个场景里的那层」），层矩形缓存也换一份。 */
  useEffect(() => {
    lockedLayersRef.current = [];
    setLockedLayers([]);
    hiddenLayersRef.current = [];
    setHiddenLayers([]);
    layerRectsRef.current = new Map();
  }, [pageClipId]);

  const layerLocked = layerAt !== '' && lockedLayers.includes(layerAt);

  /**
   * R112 · L1（LI-A02/A05）：右栏空态由**目标**决定 —— 不是「先选片段才可编辑」。
   *
   * `knownLayerAts` 三态：`null` = 还没列回来（**不知道 ≠ 没了**，R28 · A 的假消失就栽在这）；
   * `[]` = 列回来了但这一帧没有层；有值 = 清单。空态文案因此能说清「元素没了」还是「没选目标」。
   */
  const knownLayerAts: readonly string[] | null =
    pageClipId === ''
      ? null
      : layerError !== ''
        ? []
        : layerOptions.length > 0
          ? layerOptions.map((layer) => layer.at)
          : null;
  const targetEmptyState = emptyStateOf(selectedTarget, knownLayerAts);
  const hasInspectorElement = pageClipId !== '' && layerAt !== '' && (
    composeMode === 'layer' || (selection.length === 1 && selection[0] === pageClipId)
  );
  const activeCue = selection.length === 0 && !hasInspectorElement && cueIndex !== null && hasCurrentSubtitle
    ? cues[cueIndex] ?? null
    : null;
  const inspectorTarget = JSON.stringify([project?.projectId, sequence?.id, selection, activeCue === null ? null : cueIndex,
    composeMode, hasInspectorElement ? layerAt : '', hasInspectorElement ? elementSel : []]);
  const activeLayer = hasInspectorElement ? layerOptions.find(layer => layer.at === bareAt(pageClipId, layerAt)) : undefined;
  const defaultInspectorTab: InspectorObjectTab = hasInspectorElement
    ? (elementSel.length < 2 && activeLayer?.kind === 'text' ? 'text' : 'props')
    : (selection.length > 0 ? 'advanced' : 'props');
  const inspectorObjectTab = inspectorChoice?.target === inspectorTarget ? inspectorChoice.tab : defaultInspectorTab;
  useEffect(() => {
    setInspectorChoice(previous => previous?.target === inspectorTarget ? previous : null);
  }, [inspectorTarget]);


  // 已提交的覆盖是预览/提交的基线：doc 变了（含撤销）就跟着变。
  useEffect(() => {
    baseEntriesRef.current = Array.isArray(pageClip?.overrides) ? (pageClip.overrides as unknown[]) : [];
  }, [pageClipId, hash]);

  /**
   * 舞台就绪 → 装上 packages/layers 的三段现成函数 → 列这个片段场景里的图层。
   * 传源码而不是模块：函数里的 document 必须是**场景**的 document（同 origin 的 realm）。
   */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stageReady || doc === null || pageClipId === '' || stage === null) {
      setLayerOptions([]);
      return;
    }
    let cancelled = false;
    /* R112 · L1（LI-A06）：这一刻的选中代数。异步回包（list/describe）回来时若已经换过目标，
       **读可以照收（列表本身是通用的），但「按旧目标决定选中」的那两处必须放弃** ——
       否则一次慢 list 会把用户刚点的新层顶回默认文字层。 */
    const listEpoch = targetEpochRef.current;
    void (async () => {
      try {
        if (!layersInstalledRef.current) {
          await stage.request(
            'installLayers',
            {
              readLayer: String(readLayer),
              applyOverrideEntries: String(applyOverrideEntries),
              snapshotLayers: String(snapshotLayers),
            },
            8000,
          );
          layersInstalledRef.current = true;
        }
        const reply = await stage.request('listLayers', { clip: pageClipId }, 8000);
        if (cancelled) return;
        const result = (reply.result ?? {}) as {
          ok?: boolean;
          layers?: Array<{ at: string; kind: string; name: string; depth?: number; parentAt?: string | null }>;
          error?: { message?: string };
        };
        if (result.ok !== true) {
          setLayerOptions([]);
          setLayerError(result.error?.message ?? '图层列表不可用');
          return;
        }
        const options = (result.layers ?? []).map((layer) => ({
          at: layer.at,
          kind: layer.kind,
          name: layer.name,
          depth: layer.depth ?? 1,
          parentAt: typeof layer.parentAt === 'string' ? layer.parentAt : null,
        }));
        setLayerOptions(options);
        // 树的数据与面板同一份快照（父链带上，depth 兜底）；树挂在面板 root 外，重绘不丢。
        inspectorRef.current?.setTreeLayers?.(options);
        setLayerError('');
        // 层矩形（舞台局部）：一次请求取全量，供树悬停描边与舞台点选用。
        // 失败不报错——描边是增强能力，缺了只是不画，不影响选中与编辑。
        try {
          const rectReply = await stage.request('layerRects', { clip: pageClipId }, 8000);
          if (cancelled) return;
          const rectResult = (rectReply.result ?? {}) as {
            ok?: boolean;
            layers?: Array<{ at: string; rect?: { x: number; y: number; w: number; h: number } }>;
          };
          const map = new Map<string, StageBox>();
          for (const layer of rectResult.layers ?? []) {
            const rect = layer.rect;
            if (rect === undefined) continue;
            const box = { x: Number(rect.x), y: Number(rect.y), w: Number(rect.w), h: Number(rect.h) };
            if ([box.x, box.y, box.w, box.h].every((value) => Number.isFinite(value)) && box.w > 0 && box.h > 0) {
              map.set(layer.at, box);
            }
          }
          layerRectsRef.current = map;
          (globalThis as unknown as { __layerRects?: unknown }).__layerRects = [...map.entries()];
        } catch {
          layerRectsRef.current = new Map();
        }
        /**
         * R28 · A（真产品缺陷）：**「不在列表里」不等于「元素没了」**。
         *
         * `snapshotLayers` 的 `isVisible` 会把 `opacity === 0` 的元素整条滤掉
         * （`dom-probe.mjs`），而「入场淡入」的第 0 帧正好是 `opacity: 0` ——
         * 写完盘 re-list 时用户刚选中的元素就在快照里消失了，下面那句兜底便把它
         * 顶到默认文字层：面板换目标、三槽被清空、探针只能靠「重选 + 补齐」绕开。
         *
         * 所以先按定位串问一次 `describeLayer`（它只 `querySelector`，不看可见性）：
         * 还在就保持选中；只有真问不到才清空并给一行提示。
         */
        const current = layerAtRef.current;
        const bare = pageClipId !== '' && current.startsWith(`${pageClipId}::`) ? current.slice(pageClipId.length + 2) : current;
        if (bare !== '' && options.length > 0 && !options.some((option) => option.at === bare)) {
          let alive = false;
          try {
            const probe = await stage.request('describeLayer', { clip: pageClipId, at: bare }, 5000);
            alive = ((probe.result ?? {}) as { ok?: boolean }).ok === true;
          } catch {
            alive = false;
          }
          if (cancelled) return;
          /* 探针期间换过选中 → 这条「元素没了」的结论是给旧目标的，丢掉（不拿旧结论清新目标）。 */
          if (listEpoch !== targetEpochRef.current) return;
          if (!alive) {
            layerAtRef.current = '';
            setLayerAt('');
            setElementSelection([], false);
            stageDockRef.current?.setSelection('');
            setMotionResetToken((previous) => previous + 1);
            /* R112（LI-A02/A06）：元素没了要**说得清**，而且只退到片段级 ——
               `selection` 里还是这个片段，目标要是被清成「什么都没有」，时间线与右栏
               就对同一件事给出两个答案（这正是本批要收掉的那类不一致）。
               旧定位串也**不许**留着等新页的同名元素来认领：elementKey 直接置空。 */
            writeTarget(pageClipId, '', 'system');
            setLayerError(`元素 ${bare} 已不在这一帧里：重新选一层，旧定位串不会套到新页的同名元素上`);
            setNotice({ kind: 'info', text: `元素 ${bare} 已不在文档里：已退回片段级，重新选一层` });
            return;
          }
          /* 还在（只是这一帧不可见）：保持选中，不重选、不换目标。 */
          return;
        }
        // 默认挑一个文字层（最像「改一处看得见」），没有就第一个。
        // v2 起面板的选中是统一 id（`<clipId>::<at>`），比对前先剥掉片段前缀，
        // 否则每次写完（hash 变）都会把用户选的元素顶回默认文字层。
        /* R112：这一下是「替用户选」。如果期间用户自己点过（epoch 变了），
           谁都不许把他的选择改成默认层 —— 直接跳过。 */
        if (listEpoch !== targetEpochRef.current) return;
        setLayerAt((previous) => {
          const prevBare = pageClipId !== '' && previous.startsWith(`${pageClipId}::`) ? previous.slice(pageClipId.length + 2) : previous;
          if (options.some((option) => option.at === prevBare)) return previous;
          const preferred = options.find((option) => option.kind === 'text') ?? options[0];
          return preferred?.at ?? '';
        });
      } catch (error) {
        if (cancelled) return;
        setLayerOptions([]);
        setLayerError(describe(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [stageReady, doc, pageClipId, hash]);

  /** 挂面板：每份 doc（含撤销/重开）重建一次，保证 expectedHash 与盘上一致。 */
  const hasDoc = doc !== null;
  useEffect(() => {
    const host = inspectorHost;
    // 不随舞台重建（hash 变化会让预览 iframe 重挂）：面板常驻，舞台回来后再 select 一次。
    if (host === null || !host.isConnected || !hasDoc || project === null) return;
    const deps = {
      externalTabs: true,
      describe: async (ref: { clipId?: string; at: string }) => {
        const stage = stageRef.current;
        const target = inspectorTargetRef.current;
        const clip = typeof ref.clipId === 'string' && ref.clipId !== '' ? ref.clipId : (target?.clip ?? '');
        if (stage === null) {
          return { ok: false, error: { code: 'NO_FILM', message: '舞台未就绪', at: ref.at } };
        }
        // 换 hash 时 iframe 正在重建：等它回 ready，别把 6 秒超时当成层不存在。
        const started = Date.now();
        while (!stageReadyRef.current && Date.now() - started < 3000) {
          await new Promise((done) => globalThis.setTimeout(done, 80));
        }
        if (!stageReadyRef.current) {
          return { ok: false, error: { code: 'NO_FILM', message: '舞台未就绪', at: ref.at } };
        }
        try {
          const reply = await stage.request('describeLayer', { clip, at: ref.at }, 6000);
          const result = (reply.result ?? {}) as { ok?: boolean; value?: unknown };
          // 面板要的是「value 或带 error 的对象」，不是 {ok,value} 信封。
          if (result.ok !== true) return result;
          /**
           * R120 · M6（LI-A11/A12/A13）：**数值路径的唯一基准 = 布局盒**。
           *
           * 面板回写公式是 `left = 目标 − 实测 + 当前 computed left`（inspector-panel 的
           * `elementGeometryPatch`，本批禁写那个文件）。把 `box` 从「视觉矩形」换成
           * `layout`（offset*）之后，这条公式在四种情形下都对：
           * ① 舞台缩放 / ④ iframe fit —— 页内 offset* 根本不受父文档缩放影响；
           * ② 父级 scale+rotate —— offset* 是布局值，不含 transform；
           * ③ 容器 scroll —— offset* 不含滚动。
           * `visual` 留给画框/点选（它才是屏幕上看到的那个矩形）。
           */
          const value = result.value as Record<string, unknown> | null;
          if (value !== null && typeof value === 'object') {
            const layout = value.layout as { x?: unknown; y?: unknown; w?: unknown; h?: unknown } | undefined;
            const visual = value.box as { x?: unknown; y?: unknown; w?: unknown; h?: unknown; rotation?: unknown } | undefined;
            const w = Number(layout?.w);
            const h = Number(layout?.h);
            if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
              value.visual = visual ?? null;
              value.box = {
                x: Number(layout?.x) || 0,
                y: Number(layout?.y) || 0,
                w,
                h,
                rotation: Number(visual?.rotation) || 0,
              };
            }
          }
          return value ?? result;
        } catch (error) {
          return { ok: false, error: { code: 'NO_FILM', message: describe(error), at: ref.at } };
        }
      },
      overrideOf: (at: string) => baseEntriesRef.current.find((entry) => (entry as { at?: string })?.at === at) ?? null,
      /* R155 · M18：面板对账要一个**确定性**的「文档现在在哪」信号。
         条目 `overrideOf` 会滞后一拍（提交后要等 doc 刷新），撤销后也可能还是旧值；
         hash 是 `/ops` 回包与撤销都会更新的那一个。只读，不改任何写入路径。 */
      hashOf: () => hashRef.current,
      /**
       * 声明几何（M15）：直接读 film-core 已解析的 `pageClip.box`
       * （style → left/top/width/height/rotate 五属性），**不**在这里重新解析 CSS。
       * 没有声明、或宽高不是正数 → `null`，面板退回 describe 的实测矩形。
       */
      boxOf: (_at: string) => {
        const box = pageClipRef.current?.box;
        if (!box) return null;
        const x = Number(box.x ?? 0);
        const y = Number(box.y ?? 0);
        const w = Number(box.w);
        const h = Number(box.h);
        if (![x, y, w, h].every((value) => Number.isFinite(value)) || w <= 0 || h <= 0) return null;
        const r = Number(box.r);
        return Number.isFinite(r) && r !== 0 ? { x, y, w, h, r } : { x, y, w, h };
      },
      preview: async (patch: unknown) => {
        const stage = stageRef.current;
        const target = inspectorTargetRef.current;
        /* 舞台正在按新 hash 重建时一个预览都不发：`setOverrides` 只会等到超时，
           而预览是尽力而为的（R11 · A2：它以前把下一笔提交挡住 5s）。 */
        if (stage === null || target === null || stageReadyRef.current !== true) return;
        /* 预览用队列的同步基座（最近一次落盘 + 已排队），不用异步刷新的 doc 副本：
           否则连改两键时，第二笔的预览会把第一笔的键从画面上抹掉。 */
        const base = propsQueueRef.current?.snapshot(target.clip).entries ?? (baseEntriesRef.current as never);
        const entries = mergeOverridesAt(base, target.at, patch as never);
        await stage.request('setOverrides', { clip: target.clip, entries }, 1200).catch(() => {});
      },
      revertPreview: async () => {
        const stage = stageRef.current;
        const target = inspectorTargetRef.current;
        if (stage === null || target === null) return;
        /* 回滚到「已落盘」的基座（不含排队/在途），不是内存里那份可能过期的 doc 副本。 */
        const entries = propsQueueRef.current?.snapshot(target.clip, false).entries ?? (baseEntriesRef.current as never);
        await stage.request('setOverrides', { clip: target.clip, entries }, 5000).catch(() => {});
      },
      commit: async (patch: unknown, owner?: { clip: string; at: string }) => {
        const target = owner ?? inspectorTargetRef.current;
        const projectId = projectIdRef.current;
        if (target === null || projectId === '') {
          return { ok: false, code: 'INVALID', message: '没有选中图层' };
        }
        /* R11 · A2：连改多键必须基于「含前一笔」的 base。
           直连 /ops 时 base 是 `baseEntriesRef`：它只在成功后才回写，而 `hash` 一变
           下面那个 effect 又会把它重置成 doc 的旧快照 → 后一笔能把前一笔的键整条带走。
           属性队列的基座 = 最近一次 hydrate + **所有已成功与排队的意图**，并且串行发；
           同一个键排队时只留最后一次（不同键各自保留），正是「三笔输入 → 三条 /ops」。 */
        const queue = propsQueueRef.current;
        if (queue !== null) {
          return queue.setOverride({
            clip: target.clip,
            elementId: target.at,
            key: overrideKeyOf(patch),
            patch,
            owner: 'MAIN',
          }).promise;
        }
        /* 队列没挂上（画布坞卸载）时的兜底：仍是老路径，一个字节不改。 */
        const clip = docRef.current?.tracks.flatMap(track => track.clips).find(item => item.id === target.clip);
        const base = owner ? clip?.overrides ?? [] : baseEntriesRef.current;
        const entries = mergeOverridesAt(base as never, target.at, patch as never);
        // 真实 /ops：expectedHash 用最新一次 doc 的 hash，opId 由 client 生成。
        const client = createOpsClient({
          projectId,
          batchId: 'B-MAIN-R7-007',
          owner: 'MAIN',
          expectedHash: hashRef.current,
          target: guardTargetOf(target.clip, target.at),
        });
        const result = await client.commitOverrides({ clip: target.clip, entries: entries as never });
        if (result.ok === true) {
          baseEntriesRef.current = entries as unknown[];
          if (typeof result.hash === 'string' && result.hash !== '') {
            hashRef.current = result.hash;
            selfCommitHashRef.current = result.hash;
            setHash(result.hash);
          }
          opSeq.current += 1;
          setNotice({ kind: 'info', text: `图层已提交 · ${String(result.hash ?? '').slice(0, 8)}` });
          void refreshRef.current();
        }
        return result;
      },
      /**
       * 批量提交（S92）：多选改一个字段 → **一次** `/ops`、**一步**撤销。
       *
       * 为什么不是「每层一条 Op」：`overrides` 是**整组替换**（film-core 收到 `overrides` 就
       * `clip.overrides = validateOverrides(value)`），同一片段发两条，第二条会把第一条刚写进去的
       * 值带回旧值。所以先把所有层的 patch 合进**同一个完整数组**，一个片段只发一条 `overrides` Op。
       *
       * 几何（`set:box`）是**片段级整体替换**，同一片段上的多层只发一条（值相同的去重）。
       * 原子性由服务端保证：一次 CAS、一步撤销；元素锁在 `findLockedWrites` 里**整批**判，
       * 任何一条命中锁定元素 → 400 `ELEMENT_LOCKED`，磁盘一个字节不动。
       */
      commitMany: async (jobs: unknown) => {
        const list = Array.isArray(jobs)
          ? (jobs as { ref?: { at?: string; clipId?: string }; kind?: string; patch?: unknown; op?: { value?: unknown } }[])
          : [];
        const projectId = projectIdRef.current;
        if (projectId === '') return { ok: false, code: 'INVALID', message: '还没有打开的工程' };
        if (list.length === 0) return { ok: false, code: 'INVALID', message: '空批次：没有要提交的层' };
        const clip = pageClipRef.current?.id ?? '';
        if (clip === '') return { ok: false, code: 'INVALID', message: '没有选中的页面片段' };
        /* 先把单条队列排空：批量要用「上一笔成功」的 hash 做 CAS，否则自己跟自己 409。 */
        await propsQueueRef.current?.drain();

        /* 基座同样取队列的同步快照：它包含刚才排空的单条提交，不会把这批之外的键带走。 */
        let entries = (propsQueueRef.current?.snapshot(clip).entries ?? baseEntriesRef.current) as unknown[];
        let touchedOverrides = false;
        const ops: unknown[] = [];
        const boxSeen = new Set<string>();
        for (const job of list) {
          const at = typeof job?.ref?.at === 'string' ? job.ref.at : '';
          if (at === '') return { ok: false, code: 'INVALID', message: '批量任务缺少图层定位串' };
          const jobClip = typeof job?.ref?.clipId === 'string' && job.ref.clipId !== '' ? job.ref.clipId : clip;
          if (jobClip !== clip) return { ok: false, code: 'INVALID', message: `多选只支持同一页面片段：${jobClip} ≠ ${clip}` };
          if (job.kind === 'overrides') {
            entries = mergeOverridesAt(entries as never, at, job.patch as never);
            touchedOverrides = true;
          } else if (job.kind === 'box') {
            const value = job.op?.value;
            if (value === undefined || value === null) return { ok: false, code: 'INVALID', message: '几何任务缺少 value' };
            const key = JSON.stringify(value);
            if (!boxSeen.has(key)) {
              boxSeen.add(key);
              ops.push({ op: 'set', clip, field: 'box', value });
            }
          } else {
            return { ok: false, code: 'INVALID', message: `未知的批量任务：${String(job?.kind)}` };
          }
        }
        if (touchedOverrides) ops.unshift({ op: 'overrides', clip, entries });
        if (ops.length === 0) return { ok: false, code: 'INVALID', message: '空批次：没有可写的 Op' };

        const client = createOpsClient({
          projectId,
          batchId: `S92-${Math.random().toString(36).slice(2, 6)}`,
          owner: 'SUB1',
          expectedHash: hashRef.current,
        });
        const result = await client.commitOps(ops as never[], { kind: 'overrides' });
        if (result.ok === true) {
          if (touchedOverrides) {
            baseEntriesRef.current = entries;
            /* 批量这条不走属性队列，但队列是单条提交的基座：提交成功后把结果补进去，
               否则紧接着的单条提交会从旧基座拼包，把这一批的键带走（R11 · A2）。 */
            propsQueueRef.current?.hydrate(clip, { entries, box: boxOfPageClip(pageClipRef.current) });
          }
          if (typeof result.hash === 'string' && result.hash !== '') {
            hashRef.current = result.hash;
            selfCommitHashRef.current = result.hash;
            setHash(result.hash);
          }
          opSeq.current += 1;
          setNotice({ kind: 'info', text: `批量已提交 ${String(list.length)} 层 · 一步撤销 · ${String(result.hash ?? '').slice(0, 8)}` });
          void refreshRef.current();
        } else if (result.code === 'ELEMENT_LOCKED') {
          /* 服务端会带 violations（哪一条、哪一层）；这里只说人话，细节留在返回值与 console。 */
          setNotice({ kind: 'error', text: `批量提交被元素锁拒绝：整批未落盘（${String(result.violations?.length ?? 0)} 处命中）` });
        }
        return result;
      },
      /**
       * 几何提交（M15）：走 `set` op 的 `field:'box'`，落盘到片段自己的 `style` 声明。
       * 与上面的 `commit`（overrides）是两条独立写入口，互不改写对方的条目。
       * `expectedHash` 用最新的 doc hash；409 原样把 `currentHash` 交回面板（面板负责复原输入与预览）。
       */
      commitBox: async (op: unknown) => {
        const target = inspectorTargetRef.current;
        const projectId = projectIdRef.current;
        const clip = pageClipRef.current?.id ?? '';
        const boxOp = (op ?? {}) as { field?: string; value?: unknown };
        if (target === null || projectId === '' || clip === '') {
          return { ok: false, code: 'INVALID', message: '没有可提交几何的网页片段' };
        }
        if (boxOp.field !== 'box') {
          return { ok: false, code: 'INVALID', message: `只接受 field:'box'：${String(boxOp.field)}` };
        }
        const client = createOpsClient({
          projectId,
          batchId: 'B-MAIN-R8-008',
          owner: 'MAIN',
          expectedHash: hashRef.current,
        });
        const result = await client.commitSet({ clip, field: 'box', value: boxOp.value });
        if (result.ok === true) {
          if (typeof result.hash === 'string' && result.hash !== '') {
            hashRef.current = result.hash;
            selfCommitHashRef.current = result.hash;
            setHash(result.hash);
          }
          setNotice({ kind: 'info', text: `几何已提交 · ${String(result.hash ?? '').slice(0, 8)}` });
          // hash 变了 → 预览 iframe 换 URL 重挂 → 舞台重取 doc.json，按新 box 重画。
          void refreshRef.current();
        }
        return result;
      },
      /**
       * 图层树（M19 建，M21 补 hover/隐藏/锁定同步）：数据是 `listLayers` 的快照（带 parentAt）。
       * 锁定与隐藏都是**会话态**（不写 film.html——合同没有 locked/hidden 字段）；
       * 树自己的 `setLocked/setHidden` 与这里的 ref 是同一条真相，按钮与树行不会各走一套。
       */
      tree: {
        layers: layerOptionsRef.current,
        clipId: pageClipIdRef.current,
        selectedAt: layerAtRef.current,
        lockedAt: (at: string) => lockedLayersRef.current.includes(at),
        hiddenAt: (at: string) => hiddenLayersRef.current.includes(at),
        idPrefix: 'm19-tree',
        /** 树行悬停 → 舞台淡描边（模块的 setHighlight + getHighlightRect）；移开清除。 */
        onHover: (at: string | null) => {
          gestureRef.current?.setHighlight(at ?? null);
        },
        /** 锁定集合变化（树行尾的锁按钮走这里）：与「锁定当前层」按钮共用一份状态。 */
        onLockChange: (ats: string[]) => {
          lockedLayersRef.current = ats;
          setLockedLayers(ats);
        },
        /** 显隐集合变化（树行尾的眼按钮走这里）：隐藏后舞台不出框、也点不中。 */
        onHiddenChange: (ats: string[]) => {
          hiddenLayersRef.current = ats;
          setHiddenLayers(ats);
          const at = layerAtRef.current;
          if (at !== '' && ats.includes(at)) {
            // 当前正在编辑的层被隐藏：收回层框（不然会看着一个「看不见的层」的框）。
            setLayerRect(null);
            gestureRef.current?.setHighlight(null);
          }
        },
        onSelect: (at: string) => {
          // 树已经走完面板自己的 select（describe/预览一条龙）；这里只切「手上是谁」。
          // S95：图层树的点选也是「进入这一层」——片段多选到此为止（收成承载它的片段）。
          selectLayer(at);
        },
      },
      expectedHash: hashRef.current,
    };
    /* R112 · L1（LI-A05）：右栏的**每一次写**都包进精确编辑事务。
       面板（`packages/layers/inspector-panel.mjs`，副线1 在改）自己不认识事务，
       所以在这里把它的两个出口包一圈：begin 停播定帧 → 结果回来 commit/cancel。
       为什么包在 `deps` 上而不是改面板：改面板会与副线1 撞车，而事务本来就该由
       宿主（谁发 /ops 谁负责）拥有 —— 拖动/双击/数值三条路因此共用同一套。 */
    const rawCommit = deps.commit;
    deps.commit = async (patch: unknown, owner?: { clip: string; at: string }) => {
      beginPreciseEdit('number');
      const result = await rawCommit(patch, owner);
      const ok = (result as { ok?: boolean } | null)?.ok === true;
      commitPreciseEdit(ok, ok ? undefined : String((result as { code?: string } | null)?.code ?? 'COMMIT_FAILED'), true);
      return result;
    };
    const rawCommitBox = deps.commitBox;
    deps.commitBox = async (op: unknown) => {
      beginPreciseEdit('number');
      const result = await rawCommitBox(op);
      const ok = (result as { ok?: boolean } | null)?.ok === true;
      commitPreciseEdit(ok, ok ? undefined : String((result as { code?: string } | null)?.code ?? 'BOX_COMMIT_FAILED'), true);
      return result;
    };
    /* R120 · M6：手柄与就地文本编辑复用**同一条**写入口（同一个事务包装、同一个队列）。
       面板之外不许再有一套「先 merge 再 /ops」的实现——那正是两处不一致的来路。 */
    elementWriteRef.current = {
      commit: deps.commit as never,
      preview: (deps.preview ?? (async () => undefined)) as never,
    };
    const controller = mountInspector(host, deps as never) as unknown as InspectorController;
    inspectorRef.current = controller;
    controller.setTreeLayers?.(layerOptionsRef.current);
    if (elementSelRef.current.length > 1 && pageClipIdRef.current !== '') {
      setElementSelection(elementSelRef.current);
    }
    // 调试/验收句柄（与舞台的 __stageProbe 同一性质）：只读状态，不绕过任何校验。
    (globalThis as unknown as { __inspectorPanel?: InspectorController }).__inspectorPanel = controller;

    /**
     * R7 / S1H：单位位 `.inspector-field-unit` 由 `packages/layers/inspector-panel.mjs` 渲染
     * （本批产品 diff 只许 `packages/studio/ui/src/**`，所以不改那个模块）。这里只补一个
     * **展示性** `title` = 该节点的 textContent，让「值放不下时悬停看全文」成立。
     * 面板每次 render 都 `root.textContent = ''` 重建节点，故用 MutationObserver 在重建后同步；
     * 不动 value / readOnly / disabled / handler，也不改任何可见文案。
     */
    const decorateUnitTitles = () => {
      for (const el of host.querySelectorAll('.inspector-field-unit')) {
        const text = (el.textContent ?? '').trim();
        if (text !== '' && el.getAttribute('title') !== text) el.setAttribute('title', text);
      }
    };
    decorateUnitTitles();
    const titleObserver =
      typeof MutationObserver === 'undefined' ? null : new MutationObserver(decorateUnitTitles);
    titleObserver?.observe(host, { childList: true, subtree: true });

    return () => {
      titleObserver?.disconnect();
      inspectorRef.current = null;
      elementWriteRef.current = null;
      controller.destroy();
    };
  }, [inspectorHost, project, hasDoc, setElementSelection]);
  useEffect(() => {
    inspectorRef.current?.setObjectTab(inspectorObjectTab);
  }, [inspectorHost, project, hasDoc, inspectorObjectTab]);


  /**
   * 舞台面板（S65 元素检查器 + S66 图层面板）：消费 M66 的两个只读接口。
   *
   * 写回仍只走 `/ops`：几何 → `set:box`；文本/样式 → `set:overrides`。
   * 挂载点不随 hash 重建（面板常驻），数据变化通过 refresh/setSelection 推给它。
   */
  useEffect(() => {
    const host = stageDockHostRef.current;
    if (host === null || !hasDoc || project === null) return;

    /**
     * 属性队列（S68 · NEW-02）：面板的每次写 = 一个独立 `/ops` 批次，串行落盘。
     *
     * - **一次提交一个批次**：`batchId` 递增（`S68-001`…），`opId` 随批次走，便于归因；
     * - **串行 + CAS**：`expectedHash` 取上一批返回的 hash，下一批在上一次成功后才发；
     * - **写走既有协议**：overrides → `{op:'overrides'}`，几何 → `{op:'set', field:'box'}`，
     *   不新增接口、不直接写盘。
     */
    const queue = createPropsQueue({
      /* 批次前缀带会话随机后缀：`/ops` 按 opId 幂等重放（write-queue 首次结果复用），
         两个窗口/一个脚本用同一串 id 会让后发的写被当成重放而**静默不落盘**。 */
      batchPrefix: `S68-${Math.random().toString(36).slice(2, 6)}`,
      commit: async ({ batchId, opId, op, intent }) => {
        const projectId = projectIdRef.current;
        if (projectId === '') return { ok: false, code: 'INVALID', message: '还没有打开的工程' };
        /* R11 · A2：右列是**人**在写（owner=MAIN），画布坞仍是历史口径 SUB1。
           服务端按 owner 区分 by=person / agent（studio-server 1652），不能一律记成 agent。 */
        const owner = intent?.owner === 'MAIN' ? 'MAIN' : 'SUB1';
        const client = createOpsClient({
          projectId,
          batchId,
          owner,
          expectedHash: hashRef.current,
          opIdPrefix: batchId,
          /* R146：元素写守卫的目标（单层覆盖写才有；批量/多目标走老客户端）。 */
          target: guardTargetOf(String((op as { clip?: string } | null)?.clip ?? ''), String(intent?.elementId ?? '')),
        });
        const result = await client.commitOps([op], { opId });
        if (result.ok === true) {
          if (typeof result.hash === 'string' && result.hash !== '') {
            hashRef.current = result.hash;
            selfCommitHashRef.current = result.hash;
            setHash(result.hash);
          }
          opSeq.current += 1;
          setNotice({ kind: 'info', text: `已写回 · ${String(result.hash ?? '').slice(0, 8)}` });
          void refreshRef.current();
        } else {
          /* R150 · M16-R3（A5）：属性队列是**字段编辑的主通路**（不是 sendOps），
             守卫的 409 也会从这里回来 —— 拒绝必须在界面上有专属说法，
             否则页面停在「上一次已写回」的成功提示上，看着像写成功了。 */
          const code = String((result as { code?: string }).code ?? '');
          const guardHint = GUARD_REJECT_HINT[code];
          if (guardHint !== undefined) {
            setNotice({ kind: 'error', text: guardHint, guardCode: code });
            void refreshRef.current();
          }
        }
        return result;
      },
    });
    propsQueueRef.current = queue;
    (globalThis as unknown as { __propsQueue?: unknown }).__propsQueue = queue;

    const dock = mountStageDock(host, {
      creationLibrary: true,
      projectId: () => projectIdRef.current,
      /* R24：字幕面板的三个 App 侧能力（见 dockBridgeRef 的注释）。对象稳定，方法每次渲染重挂。 */
      bridge: dockBridgeRef.current,
      clipId: () => pageClipIdRef.current,
      t: () => playheadValueRef.current,
      getSelectedAt: () => layerAtRef.current,
      /* 画布点击的 id 属于页面片段内部；归并到承载它的片段行（见 DEV-R34 记录）。 */
      resolveAt: () => (pageClipIdRef.current === '' ? '' : `#${pageClipIdRef.current}`),
      /* R104 / U06（A20）：左栏素材卡的「加入时间线」复用**既有插入链**
         （insertAssetAtPlayhead → insertAsset → /ops，与工程栏素材卡同一个 handler）。
         这里只加一个入口，不改 handler 本身；卡片自己的「预览」是纯展示，不走这里。 */
      onInsertAsset: (item: { name: string }) => {
        void insertAssetAtPlayhead(item as AssetItem);
      },
      onSelect: (at: string, ownerClipId?: string) => {
        /* 行 id 是 film.html 的定位串：命中片段元素就选那个片段，否则当图层选中。 */
        const current = docRef.current;
        const clips = current === null ? [] : current.tracks.flatMap((track) => track.clips);
        const owned = clips.find((clip) => at === `#${clip.id}` || at === clip.id) ?? null;
        if (owned !== null) {
          setSelection([owned.id]);
          /* S95：片段行 = clip 模式；元素集合由入口统一清（互斥规则只有一处）。 */
          changeComposeMode('clip');
          /* R112 · L1：树里的**片段行**也是目标的一条入口（片段级，没有元素）。
             以前这条分支只改 `selection` 就 return —— 于是「点了片段」在目标里看不见，
             下一条回包仍按上一层的 clipId 判定（LI-A03 的三入口不一致就是从这漏的）。 */
          writeTarget(owned.id, '', 'tree');
          (globalThis as unknown as { __stageDockSel?: unknown }).__stageDockSel = { at, kind: 'clip', clipId: owned.id };
          return;
        }
        (globalThis as unknown as { __stageDockSel?: unknown }).__stageDockSel = { at, kind: 'layer', clipId: null };
        /* S95：图层行 = 进入这一层；片段多选到此为止（收成承载它的片段）。
           R25：`ownerClipId` 是「这一层属于哪个页面片段」——左栏文本列表会跨页面片段点选，
           不带 owner 时 `selectLayer` 只能落在当前页面片段上（同名 `#title` 会读错页）。 */
        selectLayer(at, ownerClipId);
      },
      onLocate: (at: string, box: { x: number; y: number; w: number; h: number } | null) => {
        locateStageBox(box, at);
      },
      /* 面板数据的**唯一来源**：`/api/layers`（v2）。舞台协议只用来「画布点选 → 拿 id」，
         不再给列表/字段供数——两套 id 域曾经对不上（BLK-R34-1）。
         一次取两域：不带 clip = film.html 的层（树的骨架），带 page 片段 id = 该片段的页面元素
         （挂在片段行下面展开）。页面域首次发现会与页面宿主导航撞车（服务端回
         PAGE_UNREACHABLE / DISCOVER_FAILED，"Execution context was destroyed"），
         那是读接口的瞬态，读三次再认输。 */
      loadLayers: async () => {
        const clip = pageClipIdRef.current;
        const readFilm = async () => {
          let last: unknown = null;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              return { ok: true as const, value: await getStageLayers(projectIdRef.current, { t: playheadValueRef.current }) };
            } catch (error) {
              last = error;
              if (!(error instanceof ApiError && error.code === 'PAGE_UNREACHABLE') || attempt === 2) break;
              await new Promise((done) => globalThis.setTimeout(done, 220));
            }
          }
          return { ok: false as const, error: last };
        };
        const film = await readFilm();
        if (film.ok !== true) {
          return {
            ok: false as const,
            code: film.error instanceof ApiError ? film.error.code : 'UNKNOWN',
            message: describe(film.error),
          };
        }
        /* 页面域失败不拖垮整棵树：骨架照常显示，只在顶部挂一条提示。 */
        let page: { clipId: string; layers: unknown[]; pageErrors: string[]; frameStatus: string } | null = null;
        if (clip !== '') {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              const reply = await getStageLayers(projectIdRef.current, { clip, t: playheadValueRef.current });
              page = {
                clipId: reply.clipId ?? clip,
                layers: reply.layers,
                pageErrors: reply.pageErrors,
                frameStatus: String(reply.frameStatus ?? ''),
              };
              /* R146：服务端在 page 域追加的观察标（实例 + 每层签名）。读不到就不发目标。 */
              guardMarksRef.current = {
                clipId: reply.clipId ?? clip,
                instanceId: String(reply.instance?.id ?? ''),
                fingerprints: (reply.fingerprints ?? {}) as Record<string, string | null>,
              };
              (globalThis as unknown as { __guardMarks?: unknown }).__guardMarks = guardMarksRef.current;
              break;
            } catch {
              page = null;
              if (attempt < 2) await new Promise((done) => globalThis.setTimeout(done, 220));
            }
          }
        }
        return {
          ok: true as const,
          layers: film.value.layers,
          pageErrors: film.value.pageErrors,
          page,
        };
      },
      inspect: async (at: string) => {
        try {
          /* 统一 id（`<clipId>::<elementId>`）自带片段前缀，clipId 只在裸 id 时才有意义。 */
          const reply = await inspectElement(projectIdRef.current, at, at.includes('::') ? '' : pageClipIdRef.current);
          return { ok: true as const, groups: reply.groups };
        } catch (error) {
          const code = error instanceof ApiError ? error.code : 'UNKNOWN';
          /* S94：页面域的读是**瞬态**的——`page.evaluate` 撞上场景页自己的导航
             （`Execution context was destroyed`）就回 PAGE_UNREACHABLE。
             `loadLayers` 早就按「读三次再认输」处理过同一种瞬态，这里补一次重读：
             画面上的表现是「解锁后画布坞偶发变成读不出这个元素」，等一次就好。 */
          if (code === 'PAGE_UNREACHABLE' || code === 'DISCOVER_FAILED') {
            await new Promise((done) => globalThis.setTimeout(done, 180));
            try {
              const retry = await inspectElement(projectIdRef.current, at, at.includes('::') ? '' : pageClipIdRef.current);
              return { ok: true as const, groups: retry.groups };
            } catch (again) {
              return {
                ok: false as const,
                code: again instanceof ApiError ? again.code : 'UNKNOWN',
                message: describe(again),
              };
            }
          }
          return { ok: false as const, code, message: describe(error) };
        }
      },
      /* S68：几何/覆盖都走属性队列——按 (elementId, key) 合并、串行落盘。 */
      commitBoxField: (arg: { key: string; value: number; fallback?: Record<string, number> }) =>
        queue.setBox({ clip: pageClipIdRef.current, key: arg.key, value: arg.value, fallback: arg.fallback }).promise,
      commitOverrideField: (arg: { at: string; key: string; patch: unknown }) =>
        queue.setOverride({ clip: pageClipIdRef.current, elementId: arg.at, key: arg.key, patch: arg.patch }).promise,
      /* 面板读的是队列的同步基座（不是异步刷新的 pageClipRef），否则两次提交之间会读到旧值。 */
      getBox: () => boxOfPageClip({ box: queue.snapshot(pageClipIdRef.current).box }) ?? boxOfPageClip(pageClipRef.current),
      getOverrides: () => queue.snapshot(pageClipIdRef.current).entries,
    });
    stageDockRef.current = dock as never;
    setCreationMount({host:dock.creationHost,layers:dock.creationLayerContent as HTMLElement|null});
    (globalThis as unknown as { __stageDock?: unknown }).__stageDock = dock;
    return () => {
      stageDockRef.current = null;
      setCreationMount(null);
      propsQueueRef.current = null;
      dock.destroy();
    };
  }, [project, hasDoc]);

  /**
   * 面板重列：工程/片段/文档哈希变了就重新取一次图层。
   *
   * S89：**还要重读当前元素的检查器**。只 `refresh()` 的话，元素属性坞会停在上一版
   * `inspect` 的结果上——元素解锁/上锁之后那一屏不会跟着变（实测：解锁后输入框仍然是
   * `disabled`，要手动重新选一次层才恢复）。`reloadInspector` 是坞自己的公开方法。
   */
  useEffect(() => {
    if (stageDockRef.current === null) return;
    stageDockRef.current.refresh();
    stageDockRef.current.reloadInspector?.();
  }, [hash, project, pageClipId]);

  /** 选中变化（画布点选、时间线选中）→ 面板高亮 + 检查器读一次。 */
  useEffect(() => {
    if (stageDockRef.current === null) return;
    stageDockRef.current.setSelection(layerAt);
  }, [layerAt]);

  /**
   * 双击图层行的「定位」：在画布上把该元素闪一下（**不改选中**）。
   *
   * 舞台是 fit 缩放（整页始终完整可见），没有可滚动区，所以「滚动到该元素」
   * 落到可视层面就是「在画布上把它标出来」；元素超出画布时这里仍会贴边显示。
   */
  const locateStageBox = useCallback((box: { x: number; y: number; w: number; h: number } | null, at: string) => {
    const frame = gestureHostRef.current;
    const current = docRef.current;
    if (frame === null || current === null) return;
    if (box === null) {
      setNotice({ kind: 'error', text: `定位失败：${at} 没有可用的矩形` });
      return;
    }
    const rect = frame.getBoundingClientRect();
    const stage = current.stage;
    const scale = Math.min(rect.width / stage.w, rect.height / stage.h);
    const offX = (rect.width - stage.w * scale) / 2;
    const offY = (rect.height - stage.h * scale) / 2;
    const marker = document.createElement('div');
    marker.className = 'stage-locate';
    marker.setAttribute('data-testid', 'stage-locate');
    marker.setAttribute('data-at', at);
    marker.style.left = `${offX + box.x * scale}px`;
    marker.style.top = `${offY + box.y * scale}px`;
    marker.style.width = `${Math.max(4, box.w * scale)}px`;
    marker.style.height = `${Math.max(4, box.h * scale)}px`;
    frame.appendChild(marker);
    window.setTimeout(() => marker.remove(), 1100);
    setNotice({ kind: 'info', text: `已在画布上定位 ${at}` });
  }, []);

  /** 外部改盘（撤销/重做/他人写入）后让面板重新读一遍；自己提交的那次跳过（它已自己刷新）。 */
  useEffect(() => {
    const controller = inspectorRef.current;
    if (controller === null) return;
    if (selfCommitHashRef.current === hash) {
      selfCommitHashRef.current = '';
      return;
    }
    /* 多选（S93）：外部改动后把**整组**重读一遍，别默默退回一层——
       撤销一次批量提交时，用户手上的三层不该突然只剩一层。 */
    if (elementSelRef.current.length > 1) {
      setElementSelection(elementSelRef.current);
      return;
    }
    const target = inspectorTargetRef.current;
    if (target === null || target.clip !== pageClipIdRef.current) return;
    void controller.select({ clipId: target.clip, at: target.at, kind: target.kind, name: target.name, depth: target.depth });
  }, [hash, setElementSelection]);

  /** 选中图层 → 面板 describe 一次。只在「图层集合变了」或「换了层」时跑，重列同一批不重选。 */
  const layerKey = layerOptions.map((layer) => layer.at).join('|');
  useEffect(() => {
    const controller = inspectorRef.current;
    /* 多层（S93）：集合由 `setElementSelection` 统一下发；这里再 select 一次会把它打回一层。 */
    if (elementSel.length > 1) return;
    /* `layerAt` 可能是统一 id（画布点选给的是 `clipId::at`），比对前剥掉片段前缀——
       不剥的话画布点选永远匹配不到 `layerOptions`，面板就不跟着走（S93 之前就是这样）。 */
    const bare = pageClipId !== '' && layerAt.startsWith(`${pageClipId}::`) ? layerAt.slice(pageClipId.length + 2) : layerAt;
    const option = layerOptions.find((item) => item.at === bare);
    if (controller === null || option === undefined || pageClipId === '') return;
    /* R11 · A1：**先把提交目标同步掉，再判断要不要重新 select**。
       图层树点击时面板自己已经 `select()` 过，走到下面必然 `current.at === option.at`；
       以前 target 写在早退之后，于是 `inspectorTargetRef` 停在上一个元素，
       右列写回打到上一层（s137 的 T1/T4）。下拉那条路本来就不早退，行为不变。 */
    const target: LayerTarget = {
      clip: pageClipId,
      at: option.at,
      kind: option.kind,
      name: option.name,
      depth: option.depth,
    };
    const previousClip = inspectorTargetRef.current?.clip;
    inspectorTargetRef.current = target;
    // 已经是这一层且没有错误：不重选（否则「已提交」状态和输入焦点会被舞台重建冲掉）。
    /* 这里**不**看 `mode`：面板的 multi 可能不是 App 摆出来的（验收脚本直接调 selectMany），
       在这个 effect 里强行退回单选会把别人刚选的三层打散——S92 的 S8 就是这么被弄红的。
       「普通点击把多选退回一层」这件事放在点击那一处做（pick 分支里判定 mode === 'multi'）。 */
    const current = controller.getState() as { at?: string | null; status?: string };
    if (previousClip === pageClipId && current.at === option.at && current.status !== 'error') return;
    void controller.select({ clipId: target.clip, at: target.at, kind: target.kind, name: target.name, depth: target.depth });
  }, [inspectorHost, project, hasDoc, layerAt, layerKey, pageClipId, stageReady, elementSel.length]);

  /**
   * `describeLayer` 的回包 → 几何事实 + 舞台矩形。**唯一写法**（轮询、重建期补读共用）。
   * 返回 true = 这次回包可用；false = 明确失败（调用方自己决定「等」还是「清」）。
   */
  const storeDescribe = (
    result: {
      ok?: boolean;
      value?: {
        box?: { x: number; y: number; w: number; h: number; rotation?: number };
        layout?: { x: number; y: number; w: number; h: number };
        chain?: unknown;
        rotate?: unknown;
        block?: unknown;
        viewport?: unknown;
        style?: unknown;
        inline?: unknown;
        textEdit?: unknown;
      };
    },
    clipId: string,
    at: string,
  ): boolean => {
    const current = docRef.current;
    const box = result.ok === true ? result.value?.box : null;
    if (current === null || !box) return false;
    /* 同一份回包就是手柄的输入：布局盒 + 祖先链 + rotate 分解 + 块级事实。 */
    const facts = result.value ?? {};
    if (!facts.layout) {
      elementFactsRef.current = null;
      return false;
    }
    elementFactsRef.current = {
      at,
      clipId,
      layout: facts.layout,
      visual: { x: Number(box.x) || 0, y: Number(box.y) || 0, w: Number(box.w) || 0, h: Number(box.h) || 0 },
      chain: (facts.chain ?? { ok: false, code: 'UNSUPPORTED_ANCESTOR_MATRIX', reason: '没有链路读数', nodes: [] }) as never,
      rotate: (facts.rotate ?? { total: 0, property: 0, author: 0 }) as never,
      style: (result.value?.style ?? {}) as Readonly<Record<string, string>>,
      inline: (result.value?.inline ?? {}) as Readonly<Record<string, string>>,
      textEdit: (result.value?.textEdit ?? null) as never,
      text: String((result.value as { text?: unknown } | undefined)?.text ?? ''),
      block: (facts.block ?? null) as never,
      viewport: (facts.viewport ?? null) as never,
    };
    const clip = current.tracks.flatMap((track) => track.clips).find((item) => item.id === clipId) ?? null;
    const picture = clip === null ? null : pictureRectOf(clip);
    const own = clip === null ? null : clip.size && Number(clip.size.w) > 0 ? clip.size : current.stage;
    if (picture === null || own === null || !(own.w > 0) || !(own.h > 0)) {
      setLayerRect(null);
      elementRectRef.current = null;
      return false;
    }
    const kx = picture.w / own.w;
    const ky = picture.h / own.h;
    const rect = {
      x: picture.x + Number(box.x) * kx,
      y: picture.y + Number(box.y) * ky,
      w: Number(box.w) * kx,
      h: Number(box.h) * ky,
    };
    elementRectRef.current = rect;
    setLayerRect(rect);
    return true;
  };

  /**
   * 层框实测（M19-A4）：`describeLayer` 给的是**场景坐标**，按网页片段自己的缩放
   * 映射回舞台坐标。锁定层、没有网页片段、舞台未就绪 → 不显示。
   */
  useEffect(() => {
    const controller = stageRef.current;
    const current = docRef.current;
    const at = layerAt;
    const clipId = pageClipId;
    /**
     * R120 · M6（顺带修掉 R112 的回归）：`layerAt` 现在是**统一 id**（`<clipId>::<at>`，
     * 树行与右栏都写这个）。`describeLayer` 收的是**页内定位串**，拿 `card-a::#title`
     * 去 `querySelector` 会抛非法选择器 → 回包 `LAYER_GONE` → `layerRect` 永远 null，
     * 层框只能退回 `layerRects` 的粗快照（手柄会跟着不准）。这里先剥前缀。
     */
    const bare = clipId !== '' && at.startsWith(`${clipId}::`) ? at.slice(clipId.length + 2) : at;
    const locked = lockedLayers.includes(at);
    const hidden = hiddenLayers.includes(at);
    /**
     * R134 · M12：**`!stageReady` 不再清框**。
     *
     * 每写一次盘都会换 hash → 舞台 iframe 重建（实测 150–200ms）。原先这里把「舞台未就绪」
     * 当成「这一层没了」：选中框和几何事实一起清空，用户看到的是「拖完一下，框没了，
     * 要等半秒再拖」。压测 20/20 命中（m74-r134-font-gone ②）。
     *
     * 重建 ≠ 目标没了。清空只留一种判据：**连续三次明确失败**（真删了是持久的，重建是短暂的，
     * 120ms 一次的重试能跨过重建窗口）。
     */
    if (
      composeMode !== 'layer' ||
      controller === null ||
      current === null ||
      clipId === '' ||
      bare === '' ||
      locked ||
      hidden
    ) {
      elementFactsRef.current = null;
      setLayerRect(null);
      return;
    }
    let cancelled = false;
    let retryTimer: number | null = null;
    let missStreak = 0;
    const scheduleRetry = (): void => {
      if (cancelled || retryTimer !== null) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void run();
      }, 120);
    };
    /**
     * R120 · M6（四情形之「容器 scroll」）：iframe 里的滚动**父文档收不到事件**
     * （跨源，没有 scroll 冒泡），层框只靠 deps 变化重读会在滚动后一直偏着。
     * 所以选中期间轻量轮询一次 describe（700ms、手势中跳过）—— 一条消息，不写盘。
     */
    const run = async (): Promise<void> => {
      try {
        const reply = await controller.request('describeLayer', { clip: clipId, at: bare }, 6000);
        if (cancelled) return;
        if (storeDescribe(reply.result ?? {}, clipId, bare)) {
          missStreak = 0;
          return;
        }
        /* 回包明确失败（describe 回了 ok:false / 没有布局）：
           可能是元素真被删了，也可能只是重建后页面还没挂上。连错三次才认「没了」。 */
        missStreak += 1;
        if (missStreak >= 3) {
          elementFactsRef.current = null;
          setLayerRect(null);
        } else {
          scheduleRetry();
        }
      } catch {
        /* 重建期 `request` 直接 reject（"舞台已重建，在途请求作废" / "发不出"）：
           这不是「目标没了」—— 保留上一帧的框，120ms 后再试。 */
        if (!cancelled) scheduleRetry();
      }
    };
    void run();
    const timer = window.setInterval(() => {
      if (elementDragRef.current === null) void run();
    }, 700);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [composeMode, stageReady, pageClipId, layerAt, hash, lockedLayers, hiddenLayers, pictureRectOf]);

  /**
   * R120 · M6（LI-A11/A12/A13）：**元素手柄**（拖 / 8 向拉角 / 旋转）。
   *
   * 为什么画在父文档、不画进 iframe：页面是另一个 origin 的 iframe，父文档拿不到里面的
   * pointerdown（`stage.js` 只回 `pick`），所以手柄只能盖在舞台上。画框用
   * `layerRect`（视觉矩形，含自身 transform），**换算**用 `elementSpaceOf`（祖先链 ×
   * 页面 fit × 舞台缩放）——与数值字段同一套声明坐标，这就是「同一入口」。
   *
   * 三条纪律（写死）：
   * 1. 拖动中**只预览**（`setOverrides`，不落盘）；
   * 2. 松手才 `commit` **一次** → 一条 overrides = 一步撤销；
   * 3. Esc / `pointercancel` → 丢弃预览，一个字节都不写（`pointerup` 之前不 commit）。
   */
  /**
   * R120：手柄/文本写完之后**让面板重读一次**。
   *
   * 面板只在它自己发起的写之后安排读回（`scheduleReadback`）；宿主直接 `deps.commit` 的
   * 那几笔（手柄、原位文本、reset）它不知道，`App` 的 select 效果又会因为「同一层」跳过
   * （`current.at === option.at`）—— 结果字段停在旧值（实测：转 30° 后「旋转」仍显示 0）。
   */
  const refreshInspectorNow = (): void => {
    const target = inspectorTargetRef.current;
    const controller = inspectorRef.current;
    if (target === null || controller === null) return;
    void controller.select({
      clipId: target.clip,
      at: target.at,
      kind: target.kind,
      name: target.name,
      depth: target.depth,
    });
  };

  const elementBare = (): string =>
    pageClipId !== '' && layerAt.startsWith(`${pageClipId}::`) ? layerAt.slice(pageClipId.length + 2) : layerAt;

  /** 把「当前预览状态」折成一条最小 style patch（预览与提交共用，绝不各算一套）。 */
  const buildElementPatch = (
    drag: NonNullable<typeof elementDragRef.current>,
  ): { style: Record<string, string>; notes: string[]; fixed: string[] } | { error: { code: string; message: string } } => {
    const facts = drag.facts;
    const base = facts.layout;
    const own = Number(facts.rotate?.total ?? 0);
    const style: Record<string, string> = {};
    const notes: string[] = [];
    const fixed: string[] = [];
    const take = (built: ReturnType<typeof geometryStylePatch>): { error: { code: string; message: string } } | null => {
      if ('error' in built) return built;
      Object.assign(style, built.style);
      notes.push(...built.notes);
      fixed.push(...built.fixed);
      return null;
    };

    if (drag.mode === 'rotate') {
      const built = geometryStylePatch({
        field: 'rotate',
        target: own + drag.dr,
        layout: base,
        computed: facts.style,
        block: facts.block,
        authorRotation: facts.rotate?.author ?? 0,
      });
      const bad = take(built);
      return bad ?? { style, notes, fixed };
    }

    // left/top move along the containing block's axes; resize uses the element's own axes.
    const delta = declaredDelta(drag.space, drag.mode === 'move' ? 0 : own, drag.scale, drag.dx, drag.dy);
    if (drag.mode === 'move') {
      for (const pair of [
        ['x', base.x + delta.x],
        ['y', base.y + delta.y],
      ] as const) {
        const bad = take(
          geometryStylePatch({
            field: pair[0],
            target: pair[1],
            layout: base,
            computed: facts.style,
            block: facts.block,
            authorRotation: facts.rotate?.author ?? 0,
          }),
        );
        if (bad !== null) return bad;
      }
      return { style, notes, fixed };
    }

    /* resize：按手柄方向决定哪条边动，对侧边锚定。 */
    const SIGNS: Readonly<Record<string, readonly [number, number]>> = {
      nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0],
    };
    const sign = SIGNS[drag.handle] ?? [1, 1];
    let x = base.x;
    let y = base.y;
    let w = base.w;
    let h = base.h;
    if (sign[0] > 0) w = base.w + delta.x;
    else if (sign[0] < 0) {
      x = base.x + delta.x;
      w = base.w - delta.x;
    }
    if (sign[1] > 0) h = base.h + delta.y;
    else if (sign[1] < 0) {
      y = base.y + delta.y;
      h = base.h - delta.y;
    }
    /* 最小 8×8（与 canvas-gesture 的 GESTURE_MIN_SIZE 同值）：小于它就停在 8，不写负尺寸。 */
    if (w < 8) {
      if (sign[0] < 0) x = base.x + base.w - 8;
      w = 8;
    }
    if (h < 8) {
      if (sign[1] < 0) y = base.y + base.h - 8;
      h = 8;
    }
    if (sign[0] !== 0) {
      const bad = take(
        geometryStylePatch({
          field: 'w',
          target: w,
          layout: base,
          computed: facts.style,
          block: facts.block,
          authorRotation: facts.rotate?.author ?? 0,
        }),
      );
      if (bad !== null) return bad;
    }
    if (sign[1] !== 0) {
      const bad = take(
        geometryStylePatch({
          field: 'h',
          target: h,
          layout: base,
          computed: facts.style,
          block: facts.block,
          authorRotation: facts.rotate?.author ?? 0,
        }),
      );
      if (bad !== null) return bad;
    }
    if (sign[0] < 0) {
      const bad = take(
        geometryStylePatch({
          field: 'x',
          target: x,
          layout: base,
          computed: facts.style,
          block: facts.block,
          authorRotation: facts.rotate?.author ?? 0,
        }),
      );
      if (bad !== null) return bad;
    }
    if (sign[1] < 0) {
      const bad = take(
        geometryStylePatch({
          field: 'y',
          target: y,
          layout: base,
          computed: facts.style,
          block: facts.block,
          authorRotation: facts.rotate?.author ?? 0,
        }),
      );
      if (bad !== null) return bad;
    }
    return { style, notes, fixed };
  };

  /**
   * R120 · M6（LI-A13）：**reset 回作者布局**。
   *
   * 做法是「把覆盖里那几个几何键删掉」而不是写回一组 computed 值：
   * 写 computed 会把作者用 `calc()/clamp()/%` 写的表达式烘成死 px，那不是恢复原布局。
   * 只删我们写过的键（`resettableKeys`：作者自己内联过的 `position/flex` 不碰）。
   * 一条 `overrides` op = 一步撤销。
   */
  const resetElementGeometry = (): void => {
    const facts = elementFactsRef.current;
    const current = docRef.current;
    if (facts === null || current === null) {
      setNotice({ kind: 'info', text: '还没有选中层：先选一层再 reset' });
      return;
    }
    const clip = current.tracks.flatMap((track) => track.clips).find((item) => item.id === facts.clipId) ?? null;
    const raw = (clip as { overrides?: unknown } | null)?.overrides;
    const entries = (Array.isArray(raw) ? raw : []) as Array<Record<string, unknown> & { at?: string; style?: Record<string, string> }>;
    const entry = entries.find((item) => item !== null && item !== undefined && item.at === facts.at) ?? null;
    const keys = resettableKeys({ overrideStyle: entry?.style ?? null, inline: facts.inline });
    if (keys.length === 0) {
      setNotice({ kind: 'info', text: '这一层没有几何覆盖：已经是作者布局' });
      return;
    }
    const next: Array<Record<string, unknown>> = [];
    for (const item of entries) {
      if (item === null || item === undefined || item.at !== facts.at) {
        next.push(item);
        continue;
      }
      const style = { ...(item.style ?? {}) };
      for (const key of keys) delete style[key];
      const copy: Record<string, unknown> = { ...item };
      if (Object.keys(style).length === 0) delete copy.style;
      else copy.style = style;
      const hasBody = Object.keys(copy).some((key) => key !== 'at' && key !== 'n');
      if (hasBody) next.push(copy);
    }
    void sendOps([{ op: 'overrides', clip: facts.clipId, entries: next } as never], '几何 reset').then((ok) => {
      if (ok) {
        setNotice({ kind: 'info', text: `已回到作者布局（删掉 ${keys.join(' / ')}）· 一步撤销` });
        refreshInspectorNow();
      }
    });
  };

  /**
   * R134 · M12：**等一次 describe**，别把这一下判成「元素没了」。
   *
   * 每次写盘都会换 hash → iframe 重建（实测 150–200ms）。重建期 `describeLayer` 要么
   * reject（"舞台已重建"），要么回空；元素一直都在。原来的写法立刻拒绝（"手柄还没拿到
   * 几何事实" / "目标已失效"），压测 20/20 命中 —— 这是误判，不是保护。
   *
   * 规则：已有事实且同一层 → 立即返回；否则在预算内每 120ms 重试一次 describe，
   * 只有「连续三次明确失败」才返回 null（真被删了是持久的，重建是短暂的）。
   */
  const freshenElementFacts = async (timeoutMs = 1800): Promise<typeof elementFactsRef.current> => {
    const clipId = pageClipIdRef.current;
    const rawAt = layerAtRef.current;
    const bare = clipId !== '' && rawAt.startsWith(`${clipId}::`) ? rawAt.slice(clipId.length + 2) : rawAt;
    const same = (value: typeof elementFactsRef.current): boolean => value !== null && value.at === bare && value.clipId === clipId;
    if (same(elementFactsRef.current)) return elementFactsRef.current;
    const controller = stageRef.current;
    if (controller === null || clipId === '' || bare === '') return null;
    const deadline = Date.now() + Math.max(240, timeoutMs);
    let misses = 0;
    while (Date.now() < deadline) {
      try {
        const reply = await controller.request('describeLayer', { clip: clipId, at: bare }, 1500);
        if (storeDescribe(reply.result ?? {}, clipId, bare)) {
          return same(elementFactsRef.current) ? elementFactsRef.current : null;
        }
        misses += 1;
        if (misses >= 3) return null;
      } catch {
        /* 重建中：不算失败，继续等。 */
        misses = 0;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 120));
    }
    return null;
  };

  /** 手势的**起点**（拿到事实之后才跑）：锁定/不可编辑照旧拒绝，只是不再因为「没事实」拒绝。 */
  const beginElementDrag = (
    facts: NonNullable<typeof elementFactsRef.current>,
    startX: number,
    startY: number,
    mode: 'move' | 'resize' | 'rotate',
    handle: string,
    forwarded = false,
  ) => {
    const current = docRef.current;
    if (current === null) return;
    if (lockedLayers.includes(facts.at)) {
      setNotice({ kind: 'info', text: '这一层被锁定了：先解锁再拖' });
      return;
    }
    const clip = current.tracks.flatMap((track) => track.clips).find((item) => item.id === facts.clipId) ?? null;
    const space = elementSpaceOf(clip, current.stage, facts.chain);
    if (space.ok !== true) {
      setNotice({ kind: 'error', text: `这层不能用手柄改：${space.reason}（${space.code}）` });
      return;
    }
    const stage = stageRectNow();
    const rect = elementRectRef.current ?? layerRect;
    const scale = stage === null ? 1 : stage.scale;
    const centerX = stage !== null && rect !== null ? stage.x + (rect.x + rect.w / 2) * scale : startX;
    const centerY = stage !== null && rect !== null ? stage.y + (rect.y + rect.h / 2) * scale : startY;
    elementDragRef.current = {
      mode,
      handle,
      startX,
      startY,
      startAngle: (Math.atan2(startY - centerY, startX - centerX) * 180) / Math.PI,
      centerX,
      centerY,
      scale,
      moved: false,
      dx: 0,
      dy: 0,
      dr: 0,
      facts,
      space: { linear: space.linear, rotationDeg: space.rotationDeg },
    };
    setElementDrag({ mode, handle, dx: 0, dy: 0, dr: 0 });

    const move = (x: number, y: number): void => {
      const drag = elementDragRef.current;
      if (drag === null) return;
      if (drag.mode === 'rotate') {
        const angle = (Math.atan2(y - drag.centerY, x - drag.centerX) * 180) / Math.PI;
        const dr = angle - drag.startAngle;
        if (Math.abs(dr) >= 0.5) drag.moved = true;
        drag.dr = dr;
        setElementDrag({ mode: 'rotate', handle: drag.handle, dx: 0, dy: 0, dr });
        return;
      }
      const dx = x - drag.startX;
      const dy = y - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 2) return;
      drag.moved = true;
      drag.dx = dx;
      drag.dy = dy;
      if (forwarded) {
        const patch = buildElementPatch(drag);
        if ('style' in patch) stageRef.current?.send('previewBody', { clip: facts.clipId, at: facts.at, style: patch.style });
      }
      setElementDrag({ mode: drag.mode, handle: drag.handle, dx, dy, dr: 0 });
    };
    const finish = (cancel: boolean): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      const drag = elementDragRef.current;
      elementDragRef.current = null;
      setElementDrag(null);
      if (cancel || drag === null || drag.moved !== true) return;
      const built = buildElementPatch(drag);
      if ('error' in built) {
        setNotice({ kind: 'error', text: `手势未提交（${built.error.code}）：${built.error.message}` });
        return;
      }
      const write = elementWriteRef.current;
      if (write === null) {
        setNotice({ kind: 'error', text: '写入口未就绪（面板没挂上）：这次手势没有落盘' });
        return;
      }
      const style = built.style;
      if (Object.keys(style).length === 0) return;
      void write.commit({ style }, { clip: drag.facts.clipId, at: drag.facts.at }).then((result) => {
        if (!result?.ok) { setNotice({ kind: 'error', text: result?.message || '移动未保存' }); return; }
        const text = built.notes.length > 0 ? built.notes.join('；') : '已提交 · 一步撤销';
        setNotice({ kind: 'info', text });
        refreshInspectorNow();
      });
    };
    const onMove = (ev: PointerEvent): void => move(ev.clientX, ev.clientY);
    const onUp = (ev: PointerEvent): void => { onMove(ev); finish(false); };
    const onCancel = (): void => finish(true);
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(true);
    };
    if (!forwarded) {
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('keydown', onKey, true);
    }
    return { move, finish };
  };

  /**
   * 手柄 / 拖动条的按下入口。**不再因为「事实暂时没有」直接拒绝**：
   * 有事实 → 立刻起手；没有 → 先等一次 describe（≤1.8s），等到了照常起手。
   * 指针捕获在等待前就做完，等待期间指针移出父文档也不会丢事件。
   */
  const elementGestureStart = (
    event: {
      clientX: number;
      clientY: number;
      pointerId?: number;
      currentTarget?: { setPointerCapture?: (id: number) => void };
      preventDefault: () => void;
      stopPropagation: () => void;
    },
    mode: 'move' | 'resize' | 'rotate',
    handle: string,
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    /**
     * R120：**必须捕获指针**。舞台是一层跨源 iframe，指针一移出父文档（移到画面上），
     * `pointermove` 就派给 iframe 了 —— 窗口级监听收不到，表现为「手柄按下没反应」。
     * 捕获之后所有 move/up 都回到这个节点，再冒泡到 window。
     */
    const pointerId = typeof event.pointerId === 'number' ? event.pointerId : null;
    if (pointerId !== null && event.currentTarget?.setPointerCapture !== undefined) {
      try {
        event.currentTarget.setPointerCapture(pointerId);
      } catch {
        /* 合成事件/浏览器不支持：退回窗口监听，不阻断手势。 */
      }
    }
    const startX = event.clientX;
    const startY = event.clientY;
    const facts = elementFactsRef.current;
    if (facts !== null && facts.clipId === pageClipIdRef.current) {
      beginElementDrag(facts, startX, startY, mode, handle);
      return;
    }
    void (async () => {
      const fresh = await freshenElementFacts();
      if (fresh === null) {
        setNotice({ kind: 'error', text: '目标已失效（这一层不在当前页面上了）：这次手势没有开始' });
        return;
      }
      beginElementDrag(fresh, startX, startY, mode, handle);
    })();
  };

  /** 双击 / 按钮进入**原位**文本编辑（LI-A05）。含子元素的层拒绝，不拍平。 */
  const openTextEditorWith = (facts: NonNullable<typeof elementFactsRef.current>): void => {
    const rectBox = elementRectRef.current ?? layerRect;
    if (rectBox === null) return;
    if (facts.textEdit !== null && facts.textEdit.pureText !== true) {
      setNotice({
        kind: 'info',
        text: `这层里有 ${facts.textEdit.childElements} 个子元素（em / icon 之类）：就地改文字会把它们拍平，已拒绝。请在右栏逐个改。`,
      });
      return;
    }
    const rect: ElementRect = {
      x: rectBox.x,
      y: rectBox.y,
      w: rectBox.w,
      h: rectBox.h,
    };
    const font: Record<string, string> = {
      fontSize: String(facts.style['font-size'] ?? ''),
      lineHeight: String(facts.style['line-height'] ?? ''),
      fontFamily: String(facts.style['font-family'] ?? ''),
      color: String(facts.style.color ?? ''),
      textAlign: String(facts.style['text-align'] ?? ''),
      fontWeight: String(facts.style['font-weight'] ?? ''),
      letterSpacing: String(facts.style['letter-spacing'] ?? ''),
      /* R123 · M9：内容盒对齐（下面渲染时按舞台缩放乘回去）+ 两个会影响字宽的字体属性。 */
      fontStyle: String(facts.style['font-style'] ?? ''),
      textTransform: String(facts.style['text-transform'] ?? ''),
      paddingTop: String(facts.style['padding-top'] ?? '0px'),
      paddingRight: String(facts.style['padding-right'] ?? '0px'),
      paddingBottom: String(facts.style['padding-bottom'] ?? '0px'),
      paddingLeft: String(facts.style['padding-left'] ?? '0px'),
      borderTop: String(facts.style['border-top-width'] ?? '0px'),
      borderRight: String(facts.style['border-right-width'] ?? '0px'),
      borderBottom: String(facts.style['border-bottom-width'] ?? '0px'),
      borderLeft: String(facts.style['border-left-width'] ?? '0px'),
      textIndent: String(facts.style['text-indent'] ?? '0px'),
    };
    setTextEdit({ clipId: facts.clipId, at: facts.at, original: facts.text, value: facts.text, rect, font });
  };

  /**
   * R134 · M12：进编辑器也**先等一次 describe**。重建期事实为空时原先是**静默 return**——
   * 用户双击没反应，也没有任何提示（比明确拒绝更难查）。等到就开，等不到才说清楚。
   */
  const openElementTextEditor = (): void => {
    const facts = elementFactsRef.current;
    if (facts !== null && facts.clipId === pageClipIdRef.current && (elementRectRef.current ?? layerRect) !== null) {
      openTextEditorWith(facts);
      return;
    }
    void (async () => {
      const fresh = await freshenElementFacts();
      if (fresh === null) {
        setNotice({ kind: 'error', text: '目标已失效（这一层不在当前页面上了）：没有打开文字编辑' });
        return;
      }
      openTextEditorWith(fresh);
    })();
  };

  const commitElementText = (): void => {
    const edit = textEdit;
    setTextEdit(null);
    if (edit === null || edit.value === edit.original) return;
    if (edit.at === '') {
      void sendOps([{ op: 'fields', clip: edit.clipId, fields: { text: edit.value } }], '修改文字');
      return;
    }
    /**
     * R123 · M9：**目标失效要拒绝，而且要说清楚**。
     *
     * 编辑器打开后页面可能自己变了（脚本换页/删节点/切片段）：这时 `describe` 会回
     * `LAYER_GONE`，`elementFactsRef` 被清空。原先是照着 `edit.at` 直接写 —— 数据会落到
     * 一个已经不存在的定位串上（当前页面无元素可贴，用户以为改上了）。
     * 现在按「事实还在、且还是同一层」放行；否则明确拒绝，一个字节都不写。
     *
     * R134 · M12：**拒绝之前先等一次 describe**。原来这里写「重建期会多拒绝一次，
     * 用户重开编辑器即可」—— 那是把误判当保护：元素一直在，只是 iframe 在重建。
     * 现在 1.2s 内等到同一层就照常提交，等不到（真被删/连续失败）才拒绝。
     */
    const finish = (facts: typeof elementFactsRef.current): void => {
      if (facts === null || facts.clipId !== edit.clipId || facts.at !== edit.at) {
        setNotice({ kind: 'error', text: '目标已失效（这一层不在当前页面上了）：文字没有落盘。重新选一次再改。' });
        return;
      }
      const write = elementWriteRef.current;
      if (write === null) {
        setNotice({ kind: 'error', text: '写入口未就绪（面板没挂上）：文字没有落盘' });
        return;
      }
      void write.commit({ t: edit.value }, { clip: edit.clipId, at: edit.at }).then((result) => {
        if (!result?.ok) { setNotice({ kind: 'error', text: result?.message || '文字未保存' }); return; }
        setNotice({ kind: 'info', text: `文字已提交（${edit.value === '' ? '空串' : `${edit.value.length} 字`}）· 一步撤销` });
        refreshInspectorNow();
      });
    };
    const facts = elementFactsRef.current;
    if (facts !== null && facts.clipId === edit.clipId && facts.at === edit.at) {
      finish(facts);
      return;
    }
    void freshenElementFacts(1200).then(finish);
  };

  useEffect(() => {
    const cancelBody = (event: KeyboardEvent): void => {
      const drag = bodyDragRef.current;
      if (event.key !== 'Escape' || !drag) return;
      event.preventDefault();
      event.stopPropagation();
      bodyDragRef.current = null;
      stageRef.current?.send('previewBody', { clip: drag.clip, at: drag.at, clear: true });
      drag.finish(true);
    };
    window.addEventListener('keydown', cancelBody, true);
    return () => window.removeEventListener('keydown', cancelBody, true);
  }, []);

  stageBodyRef.current = (event) => {
    const { phase, clip: clipId, at, x, y } = event;
    const pointer = { clientX: x, clientY: y, pointerId: event.pointerId, pointerType: event.pointerType, altKey: event.altKey, shiftKey: event.shiftKey };
    if (phase === 'move' || phase === 'up' || phase === 'cancel') {
      const active = bodyDragRef.current;
      if (!active || active.id !== event.pointerId || active.clip !== clipId || active.at !== at) return;
      if (phase !== 'cancel') active.move(x, y, event);
      if (phase !== 'move') {
        bodyDragRef.current = null;
        active.finish(phase === 'cancel');
      }
      return;
    }
    const owner = docRef.current?.tracks.find(track => track.clips.some(clip => clip.id === clipId));
    const clip = owner?.clips.find(clip => clip.id === clipId);
    const ids = [clipId, at, unifiedAt(clipId, at)];
    if (!clip || owner?.locked || owner?.hidden || ids.some(id => lockedLayersRef.current.includes(id) || hiddenLayersRef.current.includes(id))) return;
    if ((event.description?.value as { locked?: boolean } | undefined)?.locked) return;
    onStageUpdate({ type: 'pick', seq: 0, clip: clipId, at, rect: event.rect, point: null, shift: false });
    if (at) {
      if (!event.description || !storeDescribe(event.description as Parameters<typeof storeDescribe>[0], clipId, at)) return;
      const facts = elementFactsRef.current;
      if (!facts) return;
      if (phase === 'edit') { openTextEditorWith(facts); return; }
      const drag = beginElementDrag(facts, x, y, 'move', '', true);
      if (drag) bodyDragRef.current = { ...drag, id: event.pointerId, clip: clipId, at };
    } else if (phase === 'edit') {
      if (clip.kind !== 'text' || !event.rect) return;
      const value = String((clip as Clip & { text?: string }).text ?? '');
      setTextEdit({ clipId, at: '', original: value, value, rect: event.rect, font: event.font });
    } else {
      const gesture = gestureRef.current;
      if (!gesture) return;
      gesture.stageBodyPointer('down', clipId, pointer);
      bodyDragRef.current = { id: event.pointerId, clip: clipId, at,
        move: (cx, cy, latest) => {
          pointer.clientX = cx;
          pointer.clientY = cy;
          pointer.altKey = latest.altKey;
          pointer.shiftKey = latest.shiftKey;
          gesture.stageBodyPointer('move', clipId, pointer);
        },
        finish: cancel => gesture.stageBodyPointer(cancel ? 'cancel' : 'up', clipId, pointer) };
    }
  };

  /**
   * 挂画布手势（M19 建，M21 补齐宿主接口）。
   *
   * **下面这份 opts 就是宿主契约的全部**：模块（packages/layers/canvas-gesture.mjs）只会调这些键，
   * 少一个就少一项能力——少 `getSelectionSet` 多选永远不生效、少 `getSnapTargets` 只吸舞台线、
   * 少 `getHighlightRect` 悬停描边永不显示、少 `onCommitMany` 多选报 NO_BATCH_COMMITTER、
   * 少 `onError` 错误被静默吞掉。接口再扩时先对照模块头部的 @param 清单。
   *
   * | 键 | 能力 |
   * |---|---|
   * | getStageRect | 舞台画面在视口里的矩形 + 有效缩放（画框/换算位移的基准） |
   * | getSelection / getSelectionSet | 手上是谁：单选 / 多选（多选优先） |
   * | getLayerRects | 舞台可点对象（这里是**片段**，见 clipPickables 的说明） |
   * | getSnapTargets | 吸附目标：其他可见片段的边/中线（舞台局部） |
   * | getHighlightRect | 树悬停 → 该层的舞台局部矩形（只读描边） |
   * | isHidden | 会话内隐藏：不画框、不可点 |
   * | onPreview | 每次位移一次（只更新覆盖层，**不发 /ops**） |
   * | onCommit / onCommitMany | 松手：单选一条 / 多选一批（一次请求、一步撤销） |
   * | onSelectionChange | 舞台加选/框选后把选择同步回时间线与右栏 |
   * | onClickThrough | 片段框上「按下不移动就松手」→ 转给场景页 pick（S97 点击穿透） |
   * | onError | 模块侧错误（NO_BATCH_COMMITTER / MULTI_RESIZE_UNSUPPORTED / NO_BASE_BOX…）→ notice |
   * | onCancel | Esc / 右键取消 |
   * | stageSize | 舞台声明尺寸（吸附到舞台边/中线用） |
   */
  useEffect(() => {
    const host = gestureHostRef.current;
    if (!hasDoc || project === null || !stageReady || host === null) return;
    const gestureOpts = {
      stageBodyInput: true,
      getStageRect: stageRectNow,
      /** 单选（R9 兼容位）：多选由 getSelectionSet 接管，这里给第一项。 */
      getSelection: () => {
        const set = gestureSelection();
        return set.length === 1 ? (set[0] as never) : null;
      },
      /** 多选：时间线 Cmd/Shift 选的片段全部交付；一项不可编辑就整项剔除（不猜）。 */
      getSelectionSet: () => gestureSelection() as never,
      getLayerRects: () => clipPickables() as never,
      getSnapTargets: () => snapTargetsOf() as never,
      getHighlightRect: (at: string) => {
        const cached = layerRectsRef.current.get(at);
        if (cached !== undefined) {
          return { x: cached.x, y: cached.y, w: cached.w, h: cached.h };
        }
        const clip = clipPickables().find((item) => item.at === at);
        return clip === undefined ? null : { ...clip.rect };
      },
      isHidden: (at: string) => hiddenLayersRef.current.includes(at),
      onPreview: (op: { __dxStage?: number; __dyStage?: number }) => {
        const body = bodyDragRef.current;
        if (body && !body.at) {
          stageRef.current?.send('previewBody', { clip: body.clip, at: '', dx: op.__dxStage, dy: op.__dyStage });
        }
        draggingRef.current = true;
        /* R112：拖动的第一帧开事务（幂等）—— 按参考语义，进入精确编辑就停在当前时刻。 */
        beginPreciseEdit('drag');
        traceGesture('gesture:preview', {});
      },
      /**
       * S97 · 点击穿透：片段框盖着舞台时，一次「按下 → 不移动 → 松手」由这里转给场景页。
       *
       * 为什么不在父文档里自己算命中：最小命中（文字压卡片）、letterbox 换算、隐藏层排除
       * 只有 content origin 那边知道；父文档只知道片段的画面矩形。所以这里只做
       * 「视口坐标 → 舞台坐标」，pick 仍由场景页做——与真实点击走同一条路（`postPick`）。
       */
      onClickThrough: (info: { clientX: number; clientY: number; at?: string; shiftKey?: boolean }) => {
        /* 拖动期宿主把 pick 挡在门外（`draggingRef`）；这一下已被判定为点击，先把旗子放下。 */
        draggingRef.current = false;
        traceGesture('gesture:click-through', { at: info.at ?? '' });
        const current = docRef.current;
        const rect = stageRectNow();
        const stage = stageRef.current;
        if (current === null || rect === null || stage === null) return;
        const clip = current.tracks.flatMap((track) => track.clips).find((item) => item.id === info.at) ?? null;
        /* 只有页面片段有元素级层；视频/图片片段没有接收方，别白发一条命令（旧行为一字节不变）。 */
        if (clip === null || (clip.kind ?? '') !== 'page') return;
        const x = (info.clientX - rect.x) / rect.scale;
        const y = (info.clientY - rect.y) / rect.scale;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        if (x < 0 || y < 0 || x > current.stage.w || y > current.stage.h) return;
        stage.send('pickAt', { clip: clip.id, x, y, shift: info.shiftKey === true });
      },
      onCommit: (op: unknown) => {
        draggingRef.current = false;
        traceGesture('gesture:commit', { field: String((op as { field?: string } | null)?.field ?? '') });
        /* 没有 preview（按下即松手）也要有事务：begin 幂等，commit 按落盘结果关账。 */
        beginPreciseEdit('drag');
        void commitGestureBox(op).then((ok) => commitPreciseEdit(ok, ok ? undefined : 'GESTURE_COMMIT_FAILED', true));
      },
      onCommitMany: (ops: unknown[]) => {
        draggingRef.current = false;
        traceGesture('gesture:commit-many', { count: ops.length });
        beginPreciseEdit('drag');
        void commitGestureOps(ops, 'many').then((ok) => commitPreciseEdit(ok, ok ? undefined : 'BATCH_COMMIT_FAILED', true));
      },
      onSelectionChange: (ats: string[]) => {
        const current = docRef.current;
        if (current === null) return;
        setCueIndex(null);
        const known = new Set(current.tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
        const clips = ats.filter((at) => known.has(at));
        /* S95：**空集合也要同步**。以前 `clips.length === 0` 直接 return——Shift 点掉最后一个片段时，
           手势模块的集合是 0、App 的 `selection` 还是 1，等到下一次 refresh 才「自愈」；
           中间那一屏就是两个答案。 */
        if (clips.length === 0) {
          traceGesture('gesture:selection', { ats: [] });
          setSelection([]);
          changeComposeMode('clip');
          return;
        }
        traceGesture('gesture:selection', { ats: clips });
        setSelection(clips);
        changeComposeMode('clip');
      },
      onCancel: () => {
        draggingRef.current = false;
        traceGesture('gesture:cancel');
        /* R112：Esc / 右键 = 取消事务（回原状，不是「静默不动」）。 */
        cancelPreciseEdit('gesture-cancel');
      },
      onError: (info: { code: string; message: string }) => {
        draggingRef.current = false;
        gestureError(info.code, info.message);
        commitPreciseEdit(false, info.code, true);
      },
      stageSize: docRef.current?.stage,
      hostSizeLabel: null,
      /**
       * 网格吸附（M36）：副线1 的 `snapRect`/`snapEdges` 早就支持 `grid`，
       * 只是一直没人往宿主契约里传。`null` = 关（连网格线都不生成）。
       */
      grid: grid.enabled ? grid.size : null,
    };
    /**
     * 宿主契约自检（M23 §4.0）：把**同一份 opts** 交给副线1 的 `checkHost`。
     *
     * 这是 R8/R9/R10 三次接缝事故的防线——之前它是个没人调用的库，现在通电了：
     * 缺硬能力（`getStageRect` / 选择源）→ error 并列出名字；缺能力位（多选/吸附到层/
     * 悬停/隐藏/批量提交）→ warn 并说清「因此失去什么」。
     *
     * 只在 dev 或 `?diag=1`（诊断）时跑：生产不刷屏，也绝不阻塞启动。
     */
    const meta = import.meta as unknown as { env?: { DEV?: boolean } };
    const diagnose = meta.env?.DEV === true || new URLSearchParams(location.search).get('diag') === '1';
    if (diagnose) {
      const report = checkHost(gestureOpts as never);
      (globalThis as unknown as { __hostContract?: unknown }).__hostContract = report;
      if (!report.ok) {
        console.error('[host] 手势宿主契约缺能力：', report.missing);
      }
      if (report.degraded.length > 0) {
        console.warn('[host] 降级能力：', report.degraded);
      }
      traceGesture('host:contract', {
        ok: report.ok,
        missing: report.missing.map((item) => item.name),
        degraded: report.degraded.map((item) => item.capability),
      });
    }
    const controller = mountCanvasGesture(host, gestureOpts as never) as unknown as GestureController;
    gestureRef.current = controller;
    // 调试/验收句柄（与 __inspectorPanel、__stageProbe 同一性质）：只读状态，不绕过任何校验。
    const debugGlobal = globalThis as unknown as { __gesture?: GestureController; __gestureMounts?: number };
    debugGlobal.__gesture = controller;
    debugGlobal.__gestureMounts = (debugGlobal.__gestureMounts ?? 0) + 1;
    /**
     * 手势开始前把焦点从舞台 iframe 拿回来：时间线的 pointerdown 会 preventDefault，
     * 焦点可能还留在场景/舞台文档里，那边按 Esc 传不到编辑器（M19-A6 的真实坑）。
     */
    const blurActive = (): void => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
    };
    host.addEventListener('pointerdown', blurActive, true);
    /**
     * 给覆盖层上的元素做**指针捕获**（M21-A1 的根因修复）：
     * 舞台是 iframe，指针一旦离开框体（旋转手柄在框外 24px）就进了 iframe 的文档，
     * 父文档再也收不到 pointermove/pointerup —— 表现就是「HUD 走到 35° 卡住、松手零请求」。
     *
     * 必须挂在 **document 捕获阶段**：模块自己的 onPointerDown 也在 document 捕获阶段，
     * 并且会 `stopPropagation()` —— 挂在容器（.preview-frame）上的监听器根本收不到。
     * 同一节点上的监听器不受 stopPropagation 影响（那要 stopImmediatePropagation），
     * 所以这里能稳定拿到事件。捕获设在**吃事件的那个元素**（框体/手柄）上，
     * `pointer-events:none` 的覆盖层本身不行。
     */
    const capturePointer = (event: PointerEvent): void => {
      const target = event.target as Element | null;
      if (target === null || typeof target.closest !== 'function') return;
      if (target.closest('[data-canvas-gesture]') === null) return;
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        // 拿不到捕获就退回「指针不出框」的老行为，不阻断手势。
      }
    };
    document.addEventListener('pointerdown', capturePointer, true);
    return () => {
      gestureRef.current = null;
      host.removeEventListener('pointerdown', blurActive, true);
      document.removeEventListener('pointerdown', capturePointer, true);
      controller.destroy();
    };
  }, [
    hasDoc,
    project,
    stageReady,
    stageRectNow,
    gestureSelection,
    clipPickables,
    snapTargetsOf,
    commitGestureBox,
    commitGestureOps,
    gestureError,
    traceGesture,
    changeComposeMode,
    beginPreciseEdit,
    commitPreciseEdit,
    cancelPreciseEdit,
    // 网格（M36）变了要重挂手势：opts 是挂载时读一次的，模块内部不订阅宿主 state。
    grid.enabled,
    grid.size,
  ]);

  // —— 字幕（M24）：读伴生文件、改、存回 ——

  const loadSubtitles = useCallback(
    async (src: string): Promise<void> => {
      const id = projectIdRef.current;
      const revision = ++subtitleRevision.current;
      const resetDrafts = (): void => {
        setCueIndex(null);
        setCueDrafts(new Map());
        setCueError(null);
      };
      if (id === '' || src === '') {
        cuesRef.current = [];
        setCues([]);
        setSubtitleSource({ projectId: id, src: '' });
        setSubtitleFile(null);
        setCueSkipped(0);
        resetDrafts();
        return;
      }
      try {
        const result = await getSubtitles(id, src);
        if (revision !== subtitleRevision.current || id !== projectIdRef.current) return;
        cuesRef.current = result.cues;
        setCues(result.cues);
        setSubtitleSource({ projectId: id, src });
        setSubtitleFile(result.file);
        setSubtitleFormat(result.format);
        setCueSkipped(result.skipped);
        resetDrafts();
        subtitleOverlayRef.current?.render(playheadValueRef.current);
      } catch (error) {
        if (revision !== subtitleRevision.current || id !== projectIdRef.current) return;
        setNotice({ kind: 'error', text: describe(error) });
      }
    },
    [],
  );

  // 换工程 / 换片段来源 → 重新找伴生字幕（找不到不是错误，只是「没有」）。
  useEffect(() => {
    if (subtitleCandidate === subtitleSrc && (project?.projectId ?? '') === subtitleProjectId) return;
    void loadSubtitles(subtitleCandidate);
  }, [subtitleCandidate, subtitleSrc, project?.projectId, subtitleProjectId, loadSubtitles]);

  /** 拖动与属性编辑共用一个提交入口，写成功后才更新字幕轨和预览。 */
  const persistCue = useCallback(
    async (previous: SubtitleCue, updated: SubtitleCue, source: 'drag' | 'editor'): Promise<void> => {
      const id = projectIdRef.current;
      const current = cuesRef.current;
      if (subtitleWrite.current || !hasCurrentSubtitle || id === '' || id !== subtitleProjectId ||
          subtitleSrc === '' || !current.includes(previous)) return;
      const revision = subtitleRevision.current;
      const isCurrent = () => revision === subtitleRevision.current && id === projectIdRef.current;
      const next = current.map((cue) => cue === previous ? updated : cue).sort((a, b) => a.start - b.start || a.end - b.end);
      subtitleWrite.current = true;
      setSubtitleBusy(true);
      try {
        const saved = await saveSubtitles(id, subtitleSrc, next);
        if (!isCurrent()) return;
        cuesRef.current = next;
        setCues(next);
        setCueIndex((index) => {
          if (index === null) return null;
          const selected = current[index];
          const nextIndex = next.findIndex((cue) => cue === (selected === previous ? updated : selected));
          return nextIndex < 0 ? null : nextIndex;
        });
        setSubtitleFile(saved.file);
        setCueDrafts((drafts) => {
          const draft = drafts.get(previous);
          if (draft === undefined) return drafts;
          const remaining = new Map(drafts);
          remaining.delete(previous);
          if (source === 'drag') {
            remaining.set(updated, {
              ...draft,
              start: draft.start === formatCueTime(previous.start) ? formatCueTime(updated.start) : draft.start,
              end: draft.end === formatCueTime(previous.end) ? formatCueTime(updated.end) : draft.end,
            });
          }
          return remaining;
        });
        setCueError(null);
        subtitleOverlayRef.current?.render(playheadValueRef.current);
        setNotice({
          kind: 'info',
          text: `${source === 'drag' ? '字幕时间已保存' : '字幕已保存'} · ${saved.file} · ${saved.bytes} B`,
        });
      } catch (error) {
        if (!isCurrent()) return;
        const message = describe(error);
        if (source === 'editor') setCueError({ cue: previous, message });
        setNotice({ kind: 'error', text: `字幕保存失败：${message}` });
      } finally {
        subtitleWrite.current = false;
        setSubtitleBusy(false);
      }
    },
    [hasCurrentSubtitle, subtitleProjectId, subtitleSrc],
  );

  /** 时间线拖完一条：改本地 + 立刻写回（起止已吸到帧）。 */
  const moveCue = useCallback(
    (index: number, start: number, end: number): void => {
      const cue = cuesRef.current[index];
      if (cue !== undefined) void persistCue(cue, { ...cue, start, end }, 'drag');
    },
    [persistCue],
  );

  /** 字幕接管时间线选中状态，清掉上一组片段和转场。 */
  const selectCue = useCallback((index: number): void => {
    if (cuesRef.current[index] === undefined) return;
    selectClips([], false);
    setActiveTransitionId(null);
    setCueIndex(index);
    setInspectorChoice(null);
  }, [selectClips]);

  /** 双击或键盘从字幕块把焦点直接移到右栏正文。 */
  const openCueEditor = useCallback((index: number): void => {
    selectCue(index);
    setCueFocusRequest((request) => request + 1);
  }, [selectCue]);
  useEffect(() => {
    if (cueFocusRequest !== 0) cueTextRef.current?.focus();
  }, [cueFocusRequest]);

  const savedCueDraft = activeCue === null ? null :
    { start: formatCueTime(activeCue.start), end: formatCueTime(activeCue.end), text: activeCue.text };
  const cueDraft = activeCue === null ? null : cueDrafts.get(activeCue) ?? savedCueDraft;
  const cueDirty = cueDraft !== null && savedCueDraft !== null &&
    (cueDraft.text !== savedCueDraft.text || cueDraft.start !== savedCueDraft.start || cueDraft.end !== savedCueDraft.end);

  function saveCueDraft(): void {
    if (activeCue === null || cueDraft === null || !cueDirty) return;
    const start = parseCueTime(cueDraft.start);
    const end = parseCueTime(cueDraft.end);
    if (start === null || end === null) {
      setCueError({ cue: activeCue, message: '时间格式为 HH:MM:SS.mmm' });
      return;
    }
    if (!(end > start)) {
      setCueError({ cue: activeCue, message: '结束时间必须大于开始时间' });
      return;
    }
    if (cueDraft.text.trim() === '') {
      setCueError({ cue: activeCue, message: '字幕文本不能为空' });
      return;
    }
    void persistCue(activeCue, { start, end, text: cueDraft.text }, 'editor');
  }

  /**
   * 舞台字幕层（M24 §4.2 冻结接口）：挂在预览容器上，`pointer-events:none` 不挡手势。
   *
   * R12 起接的就是副线1 的**真组件** `packages/layers/subtitle-overlay.mjs`
   * （`subtitle-surface.mjs` 只是转发，stub 早已不在引用链上；R23-C9 的过期注释在此更正）。
   *
   * M40：`style` 不再写死 `{}`，而是**工程样式**（`subtitleStyleRef`）。挂载时读一次，
   * 之后改样式走 `updateStyle(patch)`——不重建 overlay，当前 cue 与折行缓存都不丢。
   */
  useEffect(() => {
    const host = gestureHostRef.current;
    if (!hasDoc || host === null) return;
    const overlay = mountSubtitleOverlay(host as unknown as HTMLElement, {
      getCues: () => cuesRef.current,
      getTime: () => playheadValueRef.current,
      getStage: () => {
        const rect = stageRectNow();
        return rect === null ? { x: 0, y: 0, w: 0, h: 0 } : { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
      },
      // S74：可见宽与成片同一套规则。单元与 getStage 一致（都是屏幕像素），
      // letterbox / 跟随工程 → 等于 stage.w（一个字都不多放）；cover 才收窄。
      getVisibleWidth: () => {
        const rect = stageRectNow();
        if (rect === null) return null;
        return computeVisibleWidth({
          fit: deliveryFitRef.current,
          stage: { w: rect.w, h: rect.h },
          canvas: deliveryRef.current,
        });
      },
      /**
       * 成片实际用的字号折回预览坐标（S74）。
       *
       * 成片的 `Fontsize` 是 `round(舞台高 × fontSizeRatio × fontScale × 交付缩放)`
       * （1920×1080 的 16:9 是 43；R32 字号 0.045 → 0.04 之前是 49），预览按自己的屏幕高度
       * 取整只有 15——两者差 2.4%，墨迹边界就永远差十几个像素。这里把成片那个**已经取整的字号**
       * 折算回预览，比例 `fontSizeRatio` 一个字都不改（不是缩字号躲裁切）。
       */
      getFontSizePx: () => {
        const rect = stageRectNow();
        const current = docRef.current;
        if (rect === null || current === null || current.stage.h <= 0) return null;
        const canvas = deliveryRef.current;
        const fit = deliveryFitRef.current;
        const deliveryScale =
          canvas === null
            ? 1
            : fit === 'cover'
              ? Math.max(canvas.w / current.stage.w, canvas.h / current.stage.h)
              : Math.min(canvas.w / current.stage.w, canvas.h / current.stage.h);
        if (!(deliveryScale > 0) || !Number.isFinite(deliveryScale)) return null;
        /* R34：**先展开预设再读 fontScale**。`subtitleStyleRef` 里只有 `preset` 这个 id，
           派生值由 `applyStylePreset()` 给 —— 直接用原始值的话「大字」的 1.3× 会被这里
           折回 1（override 把 fontSizePx 钉死在默认字号），预览就永远大不起来（C6 的 ratio）。 */
        const style = applyStylePreset(subtitleStyleRef.current ?? {});
        const ratio = Number(style?.fontSizeRatio) > 0 ? Number(style.fontSizeRatio) : 0.04;
        const fontScale = Number(style?.fontScale) > 0 ? Number(style.fontScale) : 1;
        const assPx = Math.round(current.stage.h * ratio * fontScale * deliveryScale);
        if (!(assPx > 0)) return null;
        return (assPx / deliveryScale) * (rect.h / current.stage.h);
      },
      style: subtitleStyleRef.current,
      onError: (info: { code: string; message: string }) => {
        traceGesture('subtitle:error', { code: info.code });
        setNotice({ kind: 'error', text: `${info.code}: ${info.message}` });
      },
    });
    subtitleOverlayRef.current = overlay;
    overlay.render(playheadValueRef.current);
    return () => {
      subtitleOverlayRef.current = null;
      overlay.destroy?.();
    };
  }, [hasDoc, project?.projectId, stageRectNow, traceGesture]);

  // cues 变了（加载/保存后）→ 立刻按当前播放头重画一次，不用等下一帧。
  useEffect(() => {
    subtitleOverlayRef.current?.render(playheadValueRef.current);
  }, [cues]);

  // 交付画幅/适配变了（S74）→ 立即按新的可见宽重排，不等下一次 timeupdate。
  useEffect(() => {
    subtitleOverlayRef.current?.render(playheadValueRef.current);
  }, [exportForm.size, exportForm.fit]);

  /* ── 字幕样式（M40）────────────────────────────────────────────────
   * 读：工程一打开就取 `<project>/.film/subtitle-style.json`（没有文件 = 默认值）。
   * 写：每次交互 → 立刻 `updateStyle`（预览跟手）→ 400ms 防抖落盘（一次交互一条文件写入）。
   * 样式不写 film.html、不进 /ops：所以改样式时 film.html 的 sha 与撤销深度都不变。
   */
  /**
   * 把待落盘的样式补丁写出去（M45）。三个触发点共用这一个函数：
   * 切工程（读新工程**之前**）、`beforeunload`（keepalive）、卸载。
   *
   * 三条纪律（R25-C3）：
   * 1. **先清 pending 再发请求**：定时器不会再补一枪（一次 flush 只 1 个请求）；
   * 2. 目标 id 取自补丁自己（`pending.id`），不是当前工程——顺序反了会写错工程；
   * 3. `.then/.catch` 里比对 id 与 `projectIdRef.current`：不相等就**只算磁盘结果**，
   *    不碰 `subtitleStyleExists` / `savedAt` / `busy`（否则旧请求会污染新工程的「已保存」）。
   */
  const flushSubtitleStyle = useCallback(async (options: { keepalive?: boolean } = {}): Promise<void> => {
    const pending = subtitleStylePendingRef.current;
    if (pending === null) return;
    subtitleStylePendingRef.current = null;
    if (subtitleStyleTimerRef.current !== null) {
      clearTimeout(subtitleStyleTimerRef.current);
      subtitleStyleTimerRef.current = null;
    }
    const isCurrent = pending.id === projectIdRef.current;
    if (isCurrent) setSubtitleStyleBusy(true);
    try {
      const res = await putSubtitleStyle(pending.id, pending.style, { keepalive: options.keepalive === true });
      if (pending.id !== projectIdRef.current) return;
      setSubtitleStyleExists(true);
      setSubtitleStyleSavedAt(res.updatedAt);
      setSubtitleStyleError('');
    } catch (error) {
      if (pending.id !== projectIdRef.current) return;
      setSubtitleStyleError(describe(error));
    } finally {
      if (pending.id === projectIdRef.current) setSubtitleStyleBusy(false);
    }
  }, []);

  useEffect(() => {
    const id = project?.projectId ?? '';
    if (id === '') return undefined;
    let alive = true;
    void (async () => {
      // 切工程：**先**把旧工程没落盘的补丁写到旧 id，**再**读新工程。
      // 反过来（先 GET 新、旧 PUT 后到）会让旧请求的 `.then` 指到新工程的 UI 状态上。
      await flushSubtitleStyle();
      if (!alive) return;
      try {
        const res = await getSubtitleStyle(id);
        if (!alive) return;
        subtitleStyleRef.current = res.style;
        setSubtitleStyle(res.style);
        setSubtitleStyleExists(res.exists);
        setSubtitleStyleSavedAt(res.updatedAt);
        setSubtitleStyleError('');
        subtitleOverlayRef.current?.updateStyle?.(res.style);
      } catch (error) {
        if (alive) setSubtitleStyleError(describe(error));
      }
    })();
    return () => {
      alive = false;
    };
  }, [project?.projectId, flushSubtitleStyle]);

  /* ── 设置中心（M49）────────────────────────────────────────────────── */

  /**
   * 把待写补丁落盘。**一次交互只发一个 PUT**：300ms 防抖由 `changeSettings` 负责，
   * 这里只是「发出去」；关面板/卸载时立即调用（不等防抖）。
   */
  const flushSettings = useCallback((): void => {
    const patch = settingsPendingRef.current;
    if (patch === null) return;
    settingsPendingRef.current = null;
    const revision = settingsRevisionRef.current;
    setSettingsBusy(true);
    settingsWriteRef.current = settingsWriteRef.current.then(async () => {
      try {
        const saved = await putSettings(patch);
        if (patch.appearance && settingsRef.current.appearance?.theme === patch.appearance.theme) {
          rememberStudioTheme(saved.settings.appearance?.theme ?? 'dark');
        }
        if (revision !== settingsRevisionRef.current) return;
        settingsRef.current = saved.settings;
        setSettings(settingsRef.current);
        setSettingsUpdatedAt(saved.updatedAt);
        setSettingsError('');
      } catch (error) {
        setSettingsError(describe(error));
        if (patch.appearance && revision === settingsRevisionRef.current) {
          const actual = await getSettings().catch(() => null);
          if (actual && revision === settingsRevisionRef.current) rememberStudioTheme(actual.settings.appearance?.theme ?? 'dark');
        }
      } finally {
        if (revision === settingsRevisionRef.current) setSettingsBusy(false);
      }
    });
  }, []);

  const changeSettings = useCallback(
    (patch: Partial<SettingsFields>): void => {
      const next = { ...settingsRef.current, ...patch };
      settingsRevisionRef.current += 1;
      settingsRef.current = next;
      setSettings(next);
      if (patch.appearance) applyStudioTheme(patch.appearance.theme);
      settingsPendingRef.current = { ...settingsPendingRef.current, ...patch };
      if (settingsTimerRef.current !== null) clearTimeout(settingsTimerRef.current);
      settingsTimerRef.current = setTimeout(() => {
        settingsTimerRef.current = null;
        flushSettings();
      }, 300);
    },
    [flushSettings],
  );

  /**
   * MCP 分区（S69）自己负责读与写，宿主只把**服务端回读的列表**并回设置状态：
   * 不触发 300ms 防抖的 `changeSettings`（那条路是给播放/导出的滑杆用的，
   * 拿来合并数组会把刚写进去的整段 server 列表再 PUT 一遍）。
   */
  const applyMcpServers = useCallback((servers: McpServerEntry[]): void => {
    const next = { ...settingsRef.current, mcp: { servers } };
    settingsRef.current = next;
    setSettings(next);
  }, []);

  // 首次加载：设置是用户级的，与工程无关，所以只在挂载时读一次。
  useEffect(() => {
    let alive = true;
    void getSettings()
      .then((res) => {
        if (!alive) return;
        if (settingsRevisionRef.current === 0) {
          settingsRef.current = res.settings;
          setSettings(res.settings);
          rememberStudioTheme(res.settings.appearance?.theme ?? 'dark');
        }
        setSettingsDefaults(res.defaults);
        setSettingsIssues(res.issues ?? []);
        setSettingsPathText(res.path);
        setSettingsUpdatedAt(res.updatedAt);
        setSettingsAi(res.ai ?? []);
        // 导出默认值只在表单没被人动过时套用（「不改已填的表单」）。
        // M54：优先用 `export.last`（上次真导出的那套参数），没有再退回设置中心的默认值。
        if (!exportFormTouchedRef.current) {
          const last = res.settings.export.last ?? null;
          setExportForm((previous) => ({
            ...previous,
            ...(last === null
              ? {
                  fps: res.settings.export.fps,
                  quality: res.settings.export.quality,
                  codec: res.settings.export.codec === 'hevc' ? 'hevc' : 'h264',
                }
              : {
                  ...(last.size === undefined ? {} : { size: last.size }),
                  ...(last.fit === undefined ? {} : { fit: last.fit }),
                  ...(typeof last.fps === 'number' && last.fps > 0 ? { fps: last.fps } : {}),
                  ...(last.codec === undefined ? {} : { codec: last.codec }),
                  ...(last.quality === undefined ? {} : { quality: last.quality }),
                  // 烧字幕也一起还回来；没有伴生字幕的工程，面板会禁用并在提交时压回 false。
                  ...(last.subtitleBurn === undefined ? {} : { subtitleBurn: last.subtitleBurn }),
                }),
          }));
        }
      })
      .catch((error: unknown) => {
        if (alive) setSettingsError(describe(error));
      });
    return () => {
      alive = false;
    };
  }, []);

  const openSettings = useCallback((): void => {
    closeMoreMenu();
    settingsOpenRef.current = true;
    setSettingsOpen(true);
    setSettingsError('');
    setSettingsNotice('');
    void getSettingsDiagnostics()
      .then((report) => setSettingsDiag(report))
      .catch((error: unknown) => setSettingsError(describe(error)));
    const id = projectIdRef.current;
    if (id !== '') {
      void getSettingsStorage(id)
        .then((report) => setSettingsStorage(report))
        .catch(() => setSettingsStorage(null));
    }
  }, [closeMoreMenu]);

  /* CS1（CHAT06）：聊天菜单里的「设置 · 智能体」入口。设置的开合状态只有 App 有，
     所以由事件请求打开；section 允许指定（智能体 / 聊天模型），不指定就保持当前分区。
     这条事件只对设置开合负责，不携带任何配置数据。 */
  useEffect(() => {
    const onOpenSettings = (event: Event): void => {
      const detail = (event as CustomEvent<{ section?: string }>).detail;
      openSettings();
      if (typeof detail?.section === 'string' && detail.section !== '') setSettingsSection(detail.section);
    };
    window.addEventListener('opencut:open-settings', onOpenSettings);
    return () => window.removeEventListener('opencut:open-settings', onOpenSettings);
  }, [openSettings]);

  const closeSettings = useCallback((): void => {
    settingsOpenRef.current = false;
    setSettingsOpen(false);
    if (settingsTimerRef.current !== null) {
      clearTimeout(settingsTimerRef.current);
      settingsTimerRef.current = null;
    }
    // 关面板立刻落盘（不等 300ms）；焦点回齿轮（A1）。
    // R38：齿轮的约定 testid 是 `topbar-settings`（原名 `settings-open`）。
    flushSettings();
    const gear = document.querySelector('[data-testid="topbar-settings"]');
    if (gear instanceof HTMLElement) gear.focus();
  }, [flushSettings]);

  /** 舞台就绪那一刻补发默认音量（新开工程时 stage 还没 attach）。 */
  useEffect(() => {
    if (!stageReady) return;
    const pending = pendingVolumeRef.current;
    if (pending === null) return;
    pendingVolumeRef.current = null;
    stageRef.current?.send('setVolume', { volume: pending });
  }, [stageReady]);

  const refreshSettingsStorage = useCallback((): void => {
    const id = projectIdRef.current;
    if (id === '') {
      setSettingsStorage(null);
      return;
    }
    void getSettingsStorage(id)
      .then((report) => setSettingsStorage(report))
      .catch(() => setSettingsStorage(null));
  }, []);

  const cleanSettingsCacheNow = useCallback(
    (keep: number): void => {
      const id = projectIdRef.current;
      if (id === '') return;
      setSettingsBusy(true);
      void cleanSettingsCache(id, { keep, confirm: true })
        .then((result) => {
          setSettingsNotice(`已删除 ${result.deleted ?? 0} 个旧快照（保留 ${result.kept ?? 0} 个）`);
          refreshSettingsStorage();
        })
        .catch((error: unknown) => setSettingsError(describe(error)))
        .finally(() => setSettingsBusy(false));
    },
    [refreshSettingsStorage],
  );

  const copySettingsDiagnostics = useCallback((): void => {
    const diag = settingsDiag;
    const lines = [
      `MotionCut ${diag?.studioVersion ?? '?'}`,
      `node ${diag?.node ?? '?'} · ${diag?.platform ?? '?'}`,
      `ports studio=${diag?.ports.studio ?? '?'} vite=${diag?.ports.vite ?? '?'} content=${diag?.ports.content ?? '?'}`,
      `ffmpeg ${diag?.ffmpeg.ok === true ? diag.ffmpeg.line : `不可用（${diag?.ffmpeg.line ?? '?'}）`}`,
      `ffmpeg path ${diag?.ffmpeg.path ?? '?'}`,
      `settings ${settingsPathText}`,
      `projectRoot ${diag?.projectRoot ?? '?'}`,
      `logs ${diag?.logsDir ?? '?'}`,
      `ua ${typeof navigator === 'undefined' ? '?' : navigator.userAgent}`,
    ];
    const text = lines.join('\n');
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (clipboard === undefined) {
      setSettingsError('剪贴板不可用：请手动复制下面的信息');
      setSettingsNotice(text);
      return;
    }
    void clipboard.writeText(text).then(
      () => setSettingsNotice('诊断信息已复制到剪贴板'),
      () => setSettingsError('剪贴板不可用：请手动复制'),
    );
  }, [settingsDiag, settingsPathText]);

  const changeSubtitleStyle = useCallback((patch: Partial<SubtitleStyleFields>): void => {
    const next = { ...subtitleStyleRef.current, ...patch };
    subtitleStyleRef.current = next;
    setSubtitleStyle(next);
    // 预览立刻生效（补丁语义，overlay 自己 merge；不重建 DOM）。
    subtitleOverlayRef.current?.updateStyle?.(patch as Record<string, unknown>);
    const id = projectIdRef.current;
    if (id === '') return;
    subtitleStylePendingRef.current = { id, style: next };
    if (subtitleStyleTimerRef.current !== null) clearTimeout(subtitleStyleTimerRef.current);
    subtitleStyleTimerRef.current = setTimeout(() => {
      subtitleStyleTimerRef.current = null;
      void flushSubtitleStyle();
    }, 400);
  }, [flushSubtitleStyle]);

  const applySubtitlePreset = useCallback(
    (id: SubtitleStyleFields['preset']): void => {
      /* R30：预设**只写 id**，派生值（描边/底色/字号倍率）由 layers 的 `applyStylePreset()`
         在渲染时展开。写派生值的话，「切回默认」会留下一身 preset 的字段（底色尤其明显），
         而且存盘文件里会有两份互相矛盾的真相。 */
      changeSubtitleStyle({ preset: id });
      /* R34：预设是**离散动作**，不吃 400ms 防抖 —— 立刻落盘。
         防抖是给滑杆用的（连续拖动只写最后一次）；点一下预设却要等 400ms 才落盘，
         期间读文件的人（量具、另一个窗口、导出）看到的是上一颗，E12-P5 的 C5 就这么红过一次。 */
      if (subtitleStyleTimerRef.current !== null) {
        clearTimeout(subtitleStyleTimerRef.current);
        subtitleStyleTimerRef.current = null;
      }
      void flushSubtitleStyle();
    },
    [changeSubtitleStyle, flushSubtitleStyle],
  );

  const resetSubtitleStyle = useCallback((): void => {
    changeSubtitleStyle({ ...SUBTITLE_STYLE_DEFAULTS });
  }, [changeSubtitleStyle]);

  // 卸载：**flush，不是只 clearTimeout**（R25-C3）。补丁自带工程 id，所以「组件没了还写盘」
  // 写的是用户刚才那个工程，不是拿当前状态猜出来的。
  useEffect(
    () => () => {
      void flushSubtitleStyle();
    },
    [flushSubtitleStyle],
  );

  // 关页面（beforeunload）：`fetch` + `keepalive`。`sendBeacon` 只能 POST，这里是 PUT，用不了。
  // 与卸载那条不重复：flush 先清 pending，第二个调用是 no-op。
  useEffect(() => {
    const onBeforeUnload = (): void => {
      void flushSubtitleStyle({ keepalive: true });
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [flushSubtitleStyle]);


  /** 选中/换层/换 hash 后重读舞台 rect 与选择（模块只在滚动/缩放时自己重绘）。 */
  useEffect(() => {
    gestureRef.current?.refresh();
  }, [selection, composeMode, hash, layerAt, layerRect, stageReady]);

  /** 缩放只改视图：不写文档、不发 op；`ppsRef` 与 state 同步（播放时的 rAF 读 ref）。 */
  const changePps = useCallback((value: number): void => {
    ppsRef.current = value;
    setPps(value);
  }, []);

  const changeRate = useCallback((value: number): void => {
    setRate(value);
    stageRef.current?.send('setRate', { rate: value });
  }, []);

  const changeVolume = useCallback((value: number): void => {
    const clamped = Math.max(0, Math.min(1, value));
    setVolume(clamped);
    stageRef.current?.send('setVolume', { volume: clamped });
  }, []);

  /* R112 · L1：`pausePlayback` 已上移到 `sendSeek` 之后 —— 画布点选（onStageUpdate）
     要用它，而那个 useCallback 在渲染时就要求依赖数组里已经有值。 */

  /** 拖动/点击播放头：先暂停（不自动恢复），再定位。 */
  const seekTo = useCallback(
    (time: number, scrubbing = false): void => {
      const limit = durationRef.current > 0 ? durationRef.current : duration;
      const clamped = Math.max(0, Math.min(Number.isFinite(time) ? time : 0, limit > 0 ? limit : Number.MAX_SAFE_INTEGER));
      pendingScrubTime.current = clamped;
      pausePlayback();
      const finishingScrub = scrubbingRef.current && !scrubbing;
      queueSeek(clamped, scrubbing);
      playheadValueRef.current = clamped;
      if (!scrubbing) {
        if (!finishingScrub) keepPlayheadVisible(clamped);
        setPlayhead(clamped);
        setStageTime(clamped);
      }
      scheduleStagePaint(clamped);
    },
    [duration, keepPlayheadVisible, pausePlayback, queueSeek, scheduleStagePaint],
  );

  seekToRef.current = seekTo;

  /**
   * R24：把「跳播放头 / 重取字幕 / 烧录开关」挂到那座桥上（见 `dockBridgeRef` 的注释）。
   *
   * 挂在这里是因为 `seekTo`、`loadSubtitles`、`subtitleCandidate` 都已经定义完；
   * 每次渲染重挂一遍 = 闭包里的 state 永远最新，而对象引用不变（面板持的是同一个对象）。
   * 左栏「字幕」面板点一段 → 这里 seek；导入/改文本存盘后 → 这里让 App 重取一次，
   * 时间线的 `.tl-cue` 与画布字幕才跟着变。
   */
  const dockBridge = dockBridgeRef.current;
  dockBridge.seek = (seconds: unknown): void => seekTo(Number(seconds));
  dockBridge.reloadSubtitles = (): void => {
    void loadSubtitles(subtitleCandidate);
  };
  dockBridge.getBurn = (): boolean => exportForm.subtitleBurn === true;
  dockBridge.setBurn = (value: unknown): void => {
    setExportForm((previous) => ({ ...previous, subtitleBurn: value === true }));
  };
  /* R34（E12-P5 第 ④ 步）：左栏预设行。
     读：高亮跟真值走（换工程读到别的 preset、检查器改了，都由这一个函数回答）。
     写：只接受六条预设 id；写盘与重渲染复用检查器那条路（`applySubtitlePreset` →
     `changeSubtitleStyle` → 覆盖层 `updateStyle`），所以「点一下立刻变」与「400ms 后落盘」
     两件事只有一处实现，不会左边写一套、右边写另一套。 */
  dockBridge.getSubtitlePreset = (): string => String(subtitleStyleRef.current?.preset ?? 'default');
  dockBridge.applySubtitlePreset = (id: unknown): boolean => {
    const key = String(id ?? '');
    if (!listSubtitlePresets().includes(key)) return false;
    if (projectIdRef.current === '') return false;
    applySubtitlePreset(key as SubtitleStyleFields['preset']);
    return true;
  };

  /* R34：换工程读盘、检查器点预设、撤销 —— 高亮都跟着 `subtitleStyle.preset` 走。
     这里是**唯一**的推送点；左栏自己点的那一下也会走一遍（值相同 → 面板内部早退）。 */
  useEffect(() => {
    stageDockRef.current?.setSubtitlePreset?.(String(subtitleStyle.preset ?? 'default'));
  }, [subtitleStyle.preset]);

  const stepBy = useCallback(
    (delta: number): void => {
      seekTo(playheadValueRef.current + delta);
    },
    [seekTo],
  );

  const togglePlay = useCallback((): void => {
    if (doc === null) return;
    if (playingRef.current) {
      pausePlayback();
      return;
    }
    pendingScrubTime.current = null;
    const limit = durationRef.current > 0 ? durationRef.current : duration;
    if (limit > 0 && playheadValueRef.current >= limit - 1e-3) {
      playheadValueRef.current = 0;
      setPlayhead(0);
      scheduleStagePaint(0);
      sendSeek(0);
    }
    requestPlaying(true);
  }, [doc, duration, pausePlayback, requestPlaying, scheduleStagePaint, sendSeek]);

  /** L：没在播就先播（1x）；在播则 1x↔2x。 */
  const lKey = useCallback((): void => {
    if (!playingRef.current) {
      pendingScrubTime.current = null;
      requestPlaying(true);
      if (rate !== 1) changeRate(1);
      return;
    }
    changeRate(rate === 1 ? 2 : 1);
  }, [changeRate, rate, requestPlaying]);

  const toggleLoop = useCallback((): void => {
    setLoop((previous) => {
      const next = !previous;
      loopRef.current = next;
      return next;
    });
  }, []);

  // 换工程：波形缓存跟着换（URL 里带 projectId，本来不会串；这里只是不把上一个工程的
  // 峰值挂在内存里）。**只跟 projectId**——跟 hash 的话每次 /ops 都会重新解码。
  // 第一次打开工程不清：那时缓存还是空的，清一下只会和「片段刚发的解码请求」抢时序。
  useEffect(() => {
    const id = project?.projectId ?? '';
    if (id === '' || id === waveformProjectRef.current) return;
    if (waveformProjectRef.current === '') {
      waveformProjectRef.current = id;
      return;
    }
    waveformProjectRef.current = id;
    resetWaveformCache();
  }, [project?.projectId]);

  /**
   * 换工程时读视图偏好（轨道高度 / 网格）。
   *
   * **只按 projectId 读一次**：之后由用户操作改 state 并顺手写回 localStorage。
   * 不要把 `hash` 放进来——每次 `/ops` 都重读会把用户正在拖的高度弹回去。
   */
  useEffect(() => {
    const id = project?.projectId ?? '';
    setTrackHeights(id === '' ? {} : loadTrackHeights(id));
    setGrid(id === '' ? { enabled: false, size: DEFAULT_GRID_SIZE } : loadGrid(id));
  }, [project?.projectId]);

  /** 改一条轨道的高度（拖下沿松手 / 点预设菜单）：只写 localStorage。 */
  const changeTrackHeight = useCallback((trackIndex: number, height: number): void => {
    const id = projectIdRef.current;
    if (id === '') return;
    setTrackHeights((current) => saveTrackHeight(id, current, trackIndex, height));
  }, []);

  const toggleGrid = useCallback((): void => {
    const id = projectIdRef.current;
    setGrid((current) => saveGrid(id, !current.enabled, current.size));
  }, []);

  const changeGridSize = useCallback((size: number): void => {
    const id = projectIdRef.current;
    const next = clampGridSize(size);
    setGrid((current) => saveGrid(id, current.enabled, next));
  }, []);

  /**
   * R37（批次 A · 批注 2 / 批次 B · 批注 1）：布局菜单的「默认布局」与「复位」。
   *
   * 两项落到**同一件事**上：把视图侧的「布局相关」状态恢复默认 ——
   * 轨道高度（localStorage 与 state）、缩放档，以及**三条分栏边界**
   * （R37-B 起由 `resetAllZones()` 一起清：清 localStorage 键 + 清 `.app` 上的内联变量，
   * 于是四条边回到 CSS 断点的默认值 —— `left=224 / inspector=280 / timeline=240` @1440）。
   * **不写 film.html、不发 op**：布局是「我怎么看」，不是影片内容。
   * 两项各自保留自己的文案，是为了将来接上多套布局后能分开走，今天它们等价。
   */
  const resetLayout = useCallback((): void => {
    const id = projectIdRef.current;
    if (id !== '') {
      try {
        localStorage.removeItem(trackHeightKey(id));
      } catch {
        /* 隐私模式 / 配额：清不掉就算了 —— 内存里的 state 照样复位 */
      }
    }
    setTrackHeights({});
    changePps(DEFAULT_PPS);
    resetAllZones();
    setLayoutMenuOpen(false);
    /* 文案比改版前**更短**：顶栏是 `flex-wrap: wrap`，状态串一长就会换行、把 `.layout`
       压矮 32px（首轨 y 跟着变）。这条提示不能成为「复位之后首轨下移」的原因。 */
    setNotice({ kind: 'info', text: '布局已复位：轨道 / 缩放 / 分栏' });
  }, [changePps]);

  /* ── 轨道开关（M38）────────────────────────────────────────────────
   * 静音/隐藏/锁定是**文档属性**：一条 `track` Op、一次 /ops、一步撤销。
   * 独奏是视图态：只改本地 state，再发舞台 `setSolo`，film.html 一个字节都不动。
   * `toggleTrackFlag` 依赖 `sendOps`，所以定义在它后面（见下）。
   */

  const toggleSolo = useCallback((trackIndex: number): void => {
    setSoloTracks((current) => {
      const next = current.includes(trackIndex)
        ? current.filter((index) => index !== trackIndex)
        : [...current, trackIndex].sort((left, right) => left - right);
      return next;
    });
  }, []);

  // 换工程：独奏是会话内的视图态，别把上一个工程的独奏带过来。
  useEffect(() => {
    setSoloTracks([]);
  }, [project?.projectId]);

  // 舞台就绪（含每次 iframe 重建后的就绪）：把当前独奏送过去。
  // 依赖 hash 是故意的——/ops 改文档会重建 iframe，重建后舞台不记得独奏。
  useEffect(() => {
    if (!stageReady) return;
    stageRef.current?.send('setSolo', { tracks: soloTracks });
  }, [stageReady, soloTracks, hash]);

  // 换工程 / 换 doc：舞台 iframe 会重建，先把「就绪」放下；新的 ready 到了再把播放头送过去。
  useEffect(() => {
    setStageReady(false);
    setStageError(null);
    setStageTime(playheadValueRef.current);
    // 舞台重建后旧的电平读数作废（别让新工程继承上一个工程的电平）。
    publishLevels(null);
    setAudioNote('');
  }, [hash, project?.projectId, stageEpoch]);

  const sendOps = useCallback(
    /* R112 · L1：返回是否落盘（精确编辑事务要据此 commit / cancel）。调用方仍可 `void`。 */
    async (ops: EditOp[], label: string, noticeText?: string): Promise<boolean> => {
      const id = projectIdRef.current;
      if (id === '' || ops.length === 0) return false;
      setBusy(true);
      opSeq.current += 1;
      const opId = `ui-${Date.now().toString(36)}-${opSeq.current.toString(36)}`;
      const envelope: Envelope = {
        projectId: id,
        batchId: opId,
        owner: 'MAIN',
        expectedHash: hashRef.current,
        opId,
      };
      try {
        const result = await postOps(id, envelope, ops);
        await refreshDoc(id);
        setNotice({
          kind: 'info',
          text:
            noticeText ??
            `${label} · ${ops.length} 个 Op · ${result.replayed === true ? '同 opId 重放' : '已落盘'} · ${result.hash.slice(0, 8)}`,
        });
        return true;
      } catch (error) {
        const code = error instanceof ApiError ? error.code : '';
        const guardHint = GUARD_REJECT_HINT[code];
        if (guardHint !== undefined) {
          /* R150 · M16-R3（A5）：守卫拒绝 = 目标本身失效，不是 CAS 抢写。刷新是为了让树/
             面板回到现状，文案要说清「没落盘 + 要重选」，不能复用「他人已改」。 */
          await refreshDoc(id).catch(() => {});
          setNotice({ kind: 'error', text: guardHint, guardCode: code });
        } else if (error instanceof ApiError && error.status === 409) {
          await refreshDoc(id).catch(() => {});
          setNotice({
            kind: 'error',
            text: `他人已改，已刷新（currentHash ${String(error.currentHash ?? '').slice(0, 8)}）`,
          });
        } else {
          setNotice({ kind: 'error', text: describe(error) });
        }
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refreshDoc],
  );

  /**
   * R25：左栏「转场」面板把 `props` Op（`at` + `fade`）交给同一个 `sendOps` ——
   * 与时间线上拖转场块写的是同一条路（CAS + 历史 + 事件 + 刷新），面板不自己拼请求。
   * 挂在这里是因为 `sendOps` 在上面才定义完（桥对象本身是稳定的，方法每次渲染重挂）。
   */
  dockBridge.commitOps = (ops: unknown, label: unknown): void => {
    void sendOps(ops as EditOp[], String(label));
  };

  /**
   * R38（E12-P3 · 新建文本）：在播放头处插一条 `kind:'text'`。
   *
   * 写入面用 B3 已验过的**最小形状** `{ op:'insert', clip:{ kind:'text', src } }` ——
   * **不带 `at`/`time`**：同时给会拼成 `#t=0,6#t=0,3` → `400 BAD_TIME`（视频片段同理）。
   * `src` 取播放头所在**页面片段**的 src —— 文本元素活在页面里，面板不自己解析 doc
   * （左栏 `refreshText()` 也是按 `kind === 'page'` 找的，两处口径一致）。
   * 没有命中页面片段时返回 `{ ok:false }`，面板据此提示「先插入一页」并保持禁用。
   */
  dockBridge.insertTextClip = async (payload: unknown): Promise<{ ok: boolean; message?: string }> => {
    const id = projectIdRef.current;
    if (id === '') return { ok: false, message: '没有打开工程' };
    const asked = Number((payload as { at?: number } | null)?.at);
    const at = Math.max(0, Number.isFinite(asked) ? asked : playheadValueRef.current);
    let src = '';
    for (const track of docRef.current?.tracks ?? []) {
      for (const clip of track.clips) {
        if (String(clip.kind ?? '') !== 'page') continue;
        const span = clipSpan(clip);
        if (at + 1e-6 < span.start || at - 1e-6 > span.end) continue;
        src = String(clip.src ?? '');
        break;
      }
      if (src !== '') break;
    }
    if (src === '') return { ok: false, message: '播放头处没有页面片段：先插入一页再新建文本' };
    /* R38：给 `text` + `at` + `time` ——
       - 只给 kind/src 会写回一个**空文本片段**（列表里看不见，用户以为没反应）；
       - 不给 `time` 的话片段时长是 0，行上会显示「0–0s」；
       - `src` **不带 `#t=`**，所以这里再给 `time` 不会拼出两套区间
         （施工单警告的是 `src#t=…` + `time` 同时给 → `400 BAD_TIME`）。
       时长取 3s：短到不会盖住整段，又足够在时间线上看见并拖动。 */
    await sendOps(
      [{ op: 'insert', clip: { kind: 'text', src, text: '新建文本', at, time: [0, 3] } }],
      '插入文本',
      '已插入文本 · 播放头处',
    );
    return { ok: true };
  };

  /** 轨道静音/隐藏/锁定（M38）：一条 `track` Op = 一次 /ops = 一步撤销。 */
  const toggleTrackFlag = useCallback(
    (trackIndex: number, field: 'muted' | 'hidden' | 'locked'): void => {
      const current = docRef.current;
      if (current === null) return;
      const track = current.tracks.find((item) => item.index === trackIndex);
      if (track === undefined) return;
      const value = track[field] !== true;
      const label = field === 'muted' ? '静音' : field === 'hidden' ? '隐藏' : '锁定';
      void sendOps(
        [{ op: 'track', track: trackIndex, field, value }] as EditOp[],
        `${value ? '开' : '关'}${label} · T${trackIndex}`,
      );
    },
    [sendOps],
  );

  /* ── 音频（M31）──────────────────────────────────────────────────
   * 写盘只有两处：`volume` 属性、`overrides` 里没有 `at` 的那条 `fade`。
   * 一次手势 = 一批 `props` Op = 一步撤销；夹到边界要把原因说出来，不静默吞。
   */

  const audioReject = useCallback((message: string): void => {
    setAudioNote(message);
    setNotice({ kind: 'error', text: message });
  }, []);

  const editAudioVolume = useCallback(
    (value: number): void => {
      const planned = planVolumeOps(audioTargets, value);
      if (planned.clamped) audioReject(`音量刻度是 0–${VOLUME_MAX}（${formatVolumeDb(VOLUME_MAX)}），已夹到 ${num(planned.value, 2)}`);
      else setAudioNote('');
      if (planned.ops.length === 0) return;
      void sendOps(planned.ops as EditOp[], `音量 ${num(planned.value, 2)}（${formatVolumeDb(planned.value)}）`);
    },
    [audioReject, audioTargets, sendOps],
  );

  const editAudioFade = useCallback(
    (edge: 'in' | 'out', seconds: number): void => {
      const planned = planFadeOps(audioTargets, edge, seconds);
      if (planned.clamped) {
        audioReject(`${edge === 'in' ? '淡入' : '淡出'}最多 ${num(planned.limit, 2)}s（片段时长/源区间的一半），已夹到 ${planned.fade[edge === 'in' ? 0 : 1]}s`);
      } else setAudioNote('');
      if (planned.ops.length === 0) return;
      void sendOps(planned.ops as EditOp[], `${edge === 'in' ? '淡入' : '淡出'} ${num(planned.fade[edge === 'in' ? 0 : 1], 2)}s`);
    },
    [audioReject, audioTargets, sendOps],
  );

  /**
   * 静音开关：只写片段级 `muted`（`fields`），**不动 volume**——取消静音回到原来的音量。
   * 多选时一批 fields Op = 一步撤销。
   */
  const toggleAudioMute = useCallback(
    (muted: boolean): void => {
      const planned = planMuteOps(audioTargets, muted);
      setAudioNote('');
      if (planned.ops.length === 0) return;
      void sendOps(planned.ops as EditOp[], muted ? '静音' : '取消静音');
    },
    [audioTargets, sendOps],
  );

  const resetAudio = useCallback((): void => {
    const planned = planResetOps(audioTargets, 'all');
    setAudioNote('');
    if (planned.ops.length === 0) return;
    void sendOps(planned.ops as EditOp[], '音频回默认');
  }, [audioTargets, sendOps]);

  /**
   * 分离视频自带的音轨（M35）：一条 `insert` Op → 一次 `/ops` → 一步撤销可回原。
   *
   * 生成的是**指向同一个 mp4** 的 `<audio>` 片段（方言里 `<audio src="x.mp4">` 会解析成
   * `sound: true`），不复制媒体、不新增属性。
   */
  const splitAudio = useCallback((clipId = selectedClip?.id): void => {
    const current = docRef.current;
    if (current === null || clipId === undefined) return;
    const planned = planSplitAudioOps(current, clipId);
    if (!planned.ok) {
      // 已经分过 / 不是视频 / 读不出区间：说出来，不静默
      setNotice({ kind: 'error', text: planned.message });
      return;
    }
    void sendOps(planned.ops as EditOp[], `分离音频 · ${planned.clipId}`);
  }, [selectedClip, sendOps]);

  /**
   * 多选批量分离音频（S72 · NEW-01）。
   *
   * 每个 `hasAudio` 的视频各一条 `insert`，**合并成一个 ops 数组** → 一次 `/ops` →
   * 一步撤销就能回到提交前。跳过（已分离/无音轨/读不出区间/非视频）逐条写原因，
   * 结果卡片可展开；空结果不静默，直接说清为什么零操作。
   */
  const batchDetach = useCallback((): void => {
    if (doc === null) return;
    const ids = selected.map((item) => item.clip.id);
    if (ids.length < 2) return;
    const planned = planBatchDetach(doc, ids, { assets });
    setDetachResult({ items: planned.items, done: planned.done, skipped: planned.skipped, opCount: planned.opCount });
    if (planned.ops.length === 0) {
      const counts = new Map<string, number>();
      for (const item of planned.items) counts.set(item.label, (counts.get(item.label) ?? 0) + 1);
      const tail = [...counts.entries()].map(([label, count]) => `${label} ${count}`).join(' / ');
      setNotice({ kind: 'error', text: `没有可分离的音频（${tail || '未选中片段'}）` });
      return;
    }
    void sendOps(
      planned.ops as EditOp[],
      '批量分离音频',
      `已分离 ${planned.done} 条，跳过 ${planned.skipped} 条`,
    );
  }, [assets, doc, selected, sendOps]);

  /** 检查器里那条「视频自带音轨」提示。
   *
   * 只在**素材确认有音轨**（`hasAudio === true`）时出现：看不到 hasAudio 就不猜
   * （例如素材被重链到 assets/relinked/ 之后列表里没有它）。
   */
  const trackAudio = useMemo((): TrackAudioProps | null => {
    if (doc === null || selectedClip === null) return null;
    const state = audioSplitOf(doc, selectedClip);
    if (state.status === 'not-video' || state.status === 'no-span') return null;
    const bare = bareSrcOf(selectedClip.src);
    const asset = assets.find((item) => `assets/${item.name}` === bare);
    if (asset === undefined || asset.hasAudio !== true) return null;
    if (state.status === 'split') {
      return { status: 'split', splitId: String(state.twin?.id ?? ''), clipId: selectedClip.id, onSplit: splitAudio };
    }
    return { status: 'pending', clipId: selectedClip.id, onSplit: splitAudio };
  }, [doc, selectedClip, assets, splitAudio]);

  const splitAt = useCallback((ids: string[], at: number): void => {
    const current = docRef.current;
    if (busy || current === null) return;
    const plan = planTimelineAction({ doc: current, action: 'split', ids, at });
    if (!plan.ok) {
      setNotice({ kind: 'error', text: plan.message ?? '无法在此处切开片段' });
      return;
    }
    const projectId = projectIdRef.current;
    void sendOps(plan.ops as EditOp[], '分割').then(ok => {
      if (ok && projectId === projectIdRef.current) selectClips(plan.ids, false);
    });
  }, [busy, selectClips, sendOps]);

  const splitSelected = useCallback((): void => splitAt(selection, playhead), [splitAt, selection, playhead]);

  /**
   * 删除（M23）：波纹开 → 主轨后续左移保持闭合；波纹关 → 留间隙。
   *
   * 锁轨一律拒绝（一个 Op 都不发）：`planRippleDelete` 会把锁轨上的片段挑出来，
   * 全都被锁就 `ok:false`，这里只负责把原因说给人听（A7）。
   */
  const deleteSelected = useCallback((): void => {
    const current = docRef.current;
    if (selection.length === 0 || current === null) return;
    const ids = expandLinks(allClips as any[], selection) as string[];
    const plan = planRippleDelete({ tracks: current.tracks, ids, ripple: rippleRef.current });
    if (plan.ok !== true || plan.ops.length === 0) {
      setNotice({ kind: 'error', text: plan.message ?? '没有可删除的片段' });
      return;
    }
    if (plan.skippedLocked.length > 0) {
      // 部分被锁：能删的照删，但必须说清「哪些没动、为什么」。
      setNotice({ kind: 'error', text: String(plan.message ?? '部分片段因锁定跳过') });
    }
    const label = plan.ripple ? (plan.moved.length > 0 ? `波纹删除（${plan.moved.length} 段左移）` : '波纹删除') : '删除';
    void sendOps(plan.ops as EditOp[], label);
  }, [allClips, selection, sendOps]);

  /* ── 转场（M25）────────────────────────────────────────────────
   * 识别/调长都在 film-core/transition.mjs（纯函数）；这里只负责「选中 → 移除」和把
   * 时间线递上来的那一批 Op 发出去。一次手势 = 一批 Op = 一步撤销。
   */

  /** @returns {boolean} 有没有吃掉这次按键（Delete 先给转场，其次是片段） */
  const removeActiveTransition = useCallback((): boolean => {
    if (activeTransitionId === null) return false;
    const transition = transitions.find((item) => item.id === activeTransitionId);
    if (transition === undefined) return false;
    const plan = transition.presetId ? planRemoveTransitionPreset({ doc:docRef.current,transitionId:transition.id }) : planTransitionRemove({ transition });
    if (plan.ok !== true) {
      setNotice({ kind: 'error', text: 'message' in plan ? String(plan.message) : '无法移除此转场' });
      return true;
    }
    setActiveTransitionId(null);
    void sendOps(plan.ops as EditOp[], '移除转场');
    return true;
  }, [activeTransitionId, transitions, sendOps]);

  /**
   * 硬切 → 交叉溶解（M28）。
   *
   * 写盘形状由 `planTransitionCreate` 决定（后段 at 前移 D、fade[0]=D、总时长 −D）；
   * 一次点击 = 一批 Op = 一步撤销。夹紧/放不下都把原因码显示出来，不静默。
   */
  const addTransition = useCallback(
    (cut: CutPointView): void => {
      const plan = planTransitionCreate({ cut, durationSec: DEFAULT_TRANSITION_SECONDS, fps: docRef.current?.fps });
      if (plan.ok !== true) {
        setNotice({ kind: 'error', text: `${plan.code ?? 'TRANSITION_FAILED'} · ${plan.message}` });
        return;
      }
      const before = hashRef.current;
      void sendOps(plan.ops as EditOp[], `加转场 ${num(plan.applied, 2)}s`).then(() => {
        if (hashRef.current === before) return; // 写盘失败：sendOps 已经报过错了，别覆盖
        setActiveTransitionId(cut.id);
        setNotice({ kind: 'info', text: `${plan.code === null ? '' : `${plan.code} · `}${plan.message}` });
      });
    },
    [sendOps],
  );

  /* ── 动效（M27）──────────────────────────────────────────────
   * 面板是副线1 的冻结接口：宿主只提供 `loadLibrary`（工程内 motion/library.json 的清单）
   * 与 `applyEntry`（校验 + 规划 ops → 走 /ops 落盘，一处写盘、一步撤销）。
   * 面板自己带 `data-no-stage-gesture`，这里**不再包一层**手势拦截。
   */

  /** 当前可用于动效的片段 id（必须恰好选中一个；换片段要重挂面板）。 */
  const motionClipId = selected.length === 1 ? (selected[0]?.clip?.id ?? '') : '';
  const activeProjectId = project?.projectId ?? '';
  /** 给回调用的稳定引用（避免每次开关归档都重建面板）。 */
  const motionShowArchivedRef = useRef(motionShowArchived);
  motionShowArchivedRef.current = motionShowArchived;
  const motionClipIdRef = useRef(motionClipId);
  motionClipIdRef.current = motionClipId;

  useEffect(() => {
    motionPanelRef.current?.refresh();
  }, [motionShowArchived]);

  useEffect(() => {
    if (motionHost === null || motionClipId === '' || activeProjectId === '') return undefined;
    const clipId = motionClipId;
    const projectId = activeProjectId;
    let active = true;
    let latestLoad = 0;
    const panel = mountMotionPanel(motionHost, {
      loadLibrary: async () => {
        // `clip=clipId`：让面板把当前实例的参数当成**默认值**回填（重开工程后不回到模板默认）。
        const loadId = ++latestLoad;
        const library = await getMotionLibrary(projectId, { includeArchived: motionShowArchivedRef.current, clipId });
        if (library.ok !== true) {
          return {
            ok: false,
            error: { code: library.code ?? 'MOTION_LIBRARY_UNREADABLE', message: library.message ?? '动效库读不出来' },
          };
        }
        if (active && loadId === latestLoad) {
          setMotionManage(library.all);
          setMotionCurrent(library.current);
        }
        return { ok: true, entries: library.entries };
      },
      applyEntry: async (entryId: string, params: Record<string, unknown>) => {
        const planned = await planMotionApply(projectId, { clipId, entryId, params });
        if (planned.ok !== true) {
          return { ok: false, error: { code: planned.code ?? 'MOTION_APPLY_FAILED', message: planned.message ?? '应用失败' } };
        }
        // 唯一写入口：一批 props Op。sendOps 成功后会 refreshDoc，预览/时间线一起更新。
        await sendOps(planned.ops as EditOp[], `应用动效 ${entryId}`);
        return { ok: true };
      },
      onApplied: (result: { id: string; params: Record<string, unknown> }) => {
        setNotice({
          kind: 'info',
          text: `动效 ${result.id} 已写入 ${clipId} 的 overrides（${Object.keys(result.params).length} 个参数）· 一步可撤销`,
        });
        // 应用后 data-props 变了：管理列表里的「在用」标记与回填值要跟上。
        if (active) motionPanelRef.current?.refresh();
      },
      onError: (info: { code: string; message: string }) => {
        setNotice({ kind: 'error', text: `${info.code} · ${info.message}` });
      },
    });
    motionPanelRef.current = panel;
    return () => {
      active = false;
      motionPanelRef.current = null;
      panel.destroy();
    };
  }, [motionHost, motionClipId, activeProjectId, sendOps]);

  /**
   * E12-P4：把三槽合成出来的 `kf` 写到「选中片段 + 选中元素」的那条 overrides 上。
   *
   * 写盘仍走属性队列（`setOverride`）：它负责串行、CAS、成功后回填基座 ——
   * 与右列 27 字段、画布坞是同一条链，不新开写入口。
   * 队列没这个片段的基座时先用 doc 真值 hydrate：`overrides` 是**整组替换**，
   * 基座空了就会把该片段已有的条目一起抹掉。
   */
  const applyMotionKf = useCallback(
    async (kf: unknown, at: string, clipId: string, clear: boolean): Promise<{ ok: boolean; code?: string; message?: string }> => {
      const queue = propsQueueRef.current;
      if (queue === null) return { ok: false, code: 'NO_QUEUE', message: '写入队列未就绪' };
      if (clipId === '' || at === '') return { ok: false, code: 'INVALID', message: '没有选中片段或元素' };
      await queue.drain();
      const known = queue.snapshot(clipId);
      if (!Array.isArray(known.entries) || known.entries.length === 0) {
        const clip = (docRef.current?.tracks ?? []).flatMap((track) => track.clips).find((item) => item.id === clipId) ?? null;
        queue.hydrate(clipId, { entries: (clip?.overrides ?? []) as never, box: null });
      }
      const patch = clear ? { kf: null } : { kf };
      const result = await queue.setOverride({ clip: clipId, elementId: at, key: 'kf', patch, value: patch, owner: 'MAIN' }).promise;
      if (result.ok === true) {
        setNotice({ kind: 'info', text: clear ? `已清除 ${at} 的关键帧 · 一步撤销` : `动效已写入 ${at}（${clipId}）· 一步撤销` });
        void refreshRef.current();
      }
      return result;
    },
    [],
  );

  /* ── 模板管理（M30）────────────────────────────────────────────
   * 能力全在引擎（另存/升级/回退/归档 + 原子写）；这里只做四件事：
   * 传对参数、把结果说成人话、刷新列表与面板、让舞台重画（源文件变了）。
   */
  const runMotionAction = useCallback(
    async (
      action: (projectId: string, clipId: string) => Promise<MotionManageResult>,
      describeOk: (result: MotionManageResult) => string,
      opts: { reloadStage?: boolean } = {},
    ): Promise<void> => {
      const projectId = projectIdRef.current;
      const clipId = motionClipIdRef.current;
      if (projectId === '' || clipId === '') return;
      setMotionBusy(true);
      setMotionNote(null);
      try {
        const result = await action(projectId, clipId);
        if (result.ok !== true) {
          setMotionNote({
            ok: false,
            code: result.code,
            text: `${result.code ?? 'MOTION_FAILED'} · ${result.message ?? '操作失败'}${
              result.referencedBy !== undefined && result.referencedBy.length > 0 ? `（引用者：${result.referencedBy.join('、')}）` : ''
            }`,
          });
          return;
        }
        motionPanelRef.current?.refresh();
        setMotionNote({ ok: true, text: describeOk(result) });
        // 升级/回退改的是**模板源文件**，film.html 没变 → iframe key 不变，必须手动让舞台重建。
        if (opts.reloadStage === true) {
          pausePlayback();
          setStageEpoch((previous) => previous + 1);
        }
      } catch (error) {
        setMotionNote({ ok: false, text: describe(error) });
      } finally {
        setMotionBusy(false);
      }
    },
    [pausePlayback],
  );

  const saveMotionAs = useCallback((): void => {
    const name = motionName.trim();
    if (name === '') return;
    void runMotionAction(
      (projectId) => saveMotionTemplate(projectId, motionClipIdRef.current, name),
      (result) =>
        `已另存为模板 ${result.entry?.name ?? name}（${result.entry?.id ?? ''}）· v${String(result.entry?.version ?? 1)}${
          result.reused === true ? ' · 命中已有同源模板（未新增）' : ''
        }${(result.copiedAssets ?? []).length > 0 ? ` · 一并复制 ${String((result.copiedAssets ?? []).length)} 个资产` : ''}${
          (result.assetIssues ?? []).length > 0 ? ` · 仍有 ${String((result.assetIssues ?? []).length)} 个资产缺失` : ''
        }`,
    );
    setMotionName('');
  }, [motionName, runMotionAction]);

  const upgradeMotion = useCallback(
    (entryId: string): void => {
      void runMotionAction(
        (projectId) => upgradeMotionTemplate(projectId, entryId),
        (result) => `已升级 ${entryId} → v${String(result.version ?? '?')}（旧版本 ${String(result.historyCount ?? 0)} 个）· 舞台已重画`,
        { reloadStage: true },
      );
    },
    [runMotionAction],
  );

  const rollbackMotion = useCallback(
    (entryId: string): void => {
      void runMotionAction(
        (projectId) => rollbackMotionTemplate(projectId, entryId),
        (result) => `已回退 ${entryId} → v${String(result.version ?? '?')}（源文件字节也回退）· 舞台已重画`,
        { reloadStage: true },
      );
    },
    [runMotionAction],
  );

  const archiveMotion = useCallback(
    (entryId: string): void => {
      void runMotionAction(
        (projectId) => archiveMotionTemplate(projectId, entryId),
        (result) => `已归档 ${entryId}（文件仍在磁盘；勾「显示已归档」可查）${(result.referencedBy ?? []).length > 0 ? ` · 引用者：${(result.referencedBy ?? []).join('、')}` : ''}`,
      );
    },
    [runMotionAction],
  );

  /* ── 素材重链（M26）────────────────────────────────────────────
   * 校验全在服务端（类型/时长/尺寸/越界），这里只负责收集路径、显示报码、刷新状态。
   * 重链只换 src：`#t=in,out` 与 `at` 一个字节都不动（服务端拼好后缀）。
   */

  const nextEnvelope = useCallback((): Envelope => {
    opSeq.current += 1;
    const opId = `ui-${Date.now().toString(36)}-${opSeq.current.toString(36)}`;
    return { projectId: projectIdRef.current, batchId: opId, owner: 'MAIN', expectedHash: hashRef.current, opId };
  }, []);

  const openRelink = useCallback((): void => {
    setRelinkOpen(true);
    setRelinkNote(null);
    void refreshMedia();
  }, [refreshMedia]);

  const afterRelink = useCallback(
    async (id: string): Promise<void> => {
      await refreshDoc(id);
      await refreshMedia(id);
      await refreshAssets(id);
    },
    [refreshDoc, refreshMedia, refreshAssets],
  );

  const applyRelink = useCallback(
    async (clipId: string, src: string): Promise<void> => {
      const id = projectIdRef.current;
      if (id === '' || clipId === '') return;
      if (src.trim() === '') {
        setRelinkNote({ ok: false, text: '先填新文件路径（或点「选择…」）', codes: [] });
        return;
      }
      setRelinkBusy(true);
      try {
        const result = await relinkMedia(id, nextEnvelope(), [{ clip: clipId, src: src.trim() }]);
        if (!result.ok) {
          setRelinkNote({ ok: false, text: result.message ?? result.code ?? '重链失败', codes: result.rejected });
          return;
        }
        await afterRelink(id);
        setRelinkNote({ ok: true, text: `已重链 ${result.applied.length} 个片段 · ${String(result.hash ?? '').slice(0, 8)}`, codes: [] });
        setNotice({ kind: 'info', text: `已重链 ${clipId} → ${result.applied[0]?.to ?? ''}` });
      } catch (error) {
        setRelinkNote({ ok: false, text: describe(error), codes: [] });
      } finally {
        setRelinkBusy(false);
      }
    },
    [afterRelink, nextEnvelope],
  );

  const scanRelinkBatch = useCallback(async (): Promise<void> => {
    const id = projectIdRef.current;
    if (id === '') return;
    if (relinkDir.trim() === '') {
      setRelinkNote({ ok: false, text: '先填素材目录（或点「选择目录…」）', codes: [] });
      return;
    }
    setRelinkBusy(true);
    setRelinkNote(null);
    try {
      const scanned = await scanRelink(id, relinkDir.trim());
      if (!scanned.ok) {
        setRelinkBatch(null);
        setRelinkBatchTargets([]);
        setRelinkNote({ ok: false, text: scanned.message ?? scanned.code ?? '扫描失败', codes: [] });
        return;
      }
      setRelinkBatch({ dir: scanned.dir ?? relinkDir.trim(), matched: scanned.matched, skipped: scanned.skipped, summary: scanned.summary });
      // 工程外的同名文件：src 发**原始绝对路径** + copy，由服务端复制进 assets/relinked/ 再写相对路径。
      const toTarget = (item: { clip: string; newSrc: string; path: string; copy?: boolean }) => ({
        clip: item.clip,
        src: item.copy === true ? item.path : item.newSrc,
        copy: item.copy === true,
      });
      // 先干跑一遍：把「类型/时长过不了校验」的现在就挑出来，别等确认后才报。
      const dry = await relinkMedia(id, null, scanned.matched.map(toTarget), { dryRun: true });
      // 只把「预检通过」的写进去。
      const readyIds = new Set(dry.applied.map((item) => item.clip));
      const ready = scanned.matched.filter((item) => readyIds.has(item.clip)).map(toTarget);
      setRelinkBatchTargets(ready);
      if (ready.length === 0) {
        setRelinkNote({ ok: false, text: dry.message ?? '没有一个能通过校验', codes: dry.rejected });
        return;
      }
      setRelinkNote(
        dry.rejected.length === 0
          ? { ok: true, text: `预检通过：${ready.length} 个可重链`, codes: [] }
          : { ok: false, text: `${ready.length} 个可重链、${dry.rejected.length} 个被拒（确认时只写通过的）`, codes: dry.rejected },
      );
    } catch (error) {
      setRelinkNote({ ok: false, text: describe(error), codes: [] });
    } finally {
      setRelinkBusy(false);
    }
  }, [nextEnvelope, relinkDir]);

  const applyRelinkBatch = useCallback(async (): Promise<void> => {
    const id = projectIdRef.current;
    if (id === '' || relinkBatchTargets.length === 0) return;
    setRelinkBusy(true);
    try {
      const result = await relinkMedia(id, nextEnvelope(), relinkBatchTargets);
      if (!result.ok) {
        setRelinkNote({ ok: false, text: result.message ?? result.code ?? '批量重链失败', codes: result.rejected });
        return;
      }
      await afterRelink(id);
      setRelinkNote({ ok: true, text: `批量重链完成：${result.applied.length} 个片段 · ${String(result.hash ?? '').slice(0, 8)}`, codes: [] });
      setRelinkBatch(null);
      setRelinkBatchTargets([]);
      setNotice({ kind: 'info', text: `批量重链：${result.applied.length} 个片段已指回（一步撤销可全部回原）` });
    } catch (error) {
      setRelinkNote({ ok: false, text: describe(error), codes: [] });
    } finally {
      setRelinkBusy(false);
    }
  }, [afterRelink, nextEnvelope, relinkBatchTargets]);

  const pickRelinkFile = useCallback(async (clipId: string): Promise<void> => {
    const bridge = (globalThis as unknown as { opencut?: { pickRelinkFile?: () => Promise<{ canceled: boolean; path?: string }> } }).opencut;
    if (typeof bridge?.pickRelinkFile !== 'function') return;
    const picked = await bridge.pickRelinkFile();
    if (picked.canceled || picked.path === undefined) return;
    setRelinkPaths((previous) => ({ ...previous, [clipId]: String(picked.path) }));
  }, []);

  function contextActions(target: TimelineMenuTarget): TimelineMenuGroups {
    const current = docRef.current;
    const projectId = projectIdRef.current;
    if (!current || !projectId) return [];
    const sequenceId = sequenceRef.current?.id ?? 'main';
    const scope = `${projectId}/${sequenceRef.current?.id ?? 'main'}`;
    const basis = hashRef.current;
    const selectionRows = current.tracks.flatMap(track => track.clips
      .filter(clip => target.ids.includes(clip.id)).map(clip => ({ track, clip })));
    const one = selectionRows.length === 1 ? selectionRows[0]?.clip : undefined;
    const editable = selectionRows.length > 0 && selectionRows.every(row => !row.track.locked);
    const locked = busy || !editable;
    const clipboard = clipClipboard.current?.scope === scope ? clipClipboard.current.entries : [];
    const properties = clipPropertyClipboard.current?.scope === scope ? clipPropertyClipboard.current.clip : null;
    const lane = current.tracks.find(track => track.index === target.track);
    const platformKey = /mac/i.test(navigator.userAgent) ? '⌘' : 'Ctrl+';
    const scopeAlive = () => projectId === projectIdRef.current &&
      sequenceId === (sequenceRef.current?.id ?? 'main');
    const alive = () => scopeAlive() && basis === hashRef.current;
    const entry = (id: string, label: string, run: () => void, options: Partial<TimelineMenuItem> = {}): TimelineMenuItem =>
      ({ id, label, run: () => {
        if (!alive()) { setNotice({ kind: 'error', text: '工程已更新，请重新打开轨道菜单' }); return; }
        run();
      }, ...options });

    const planned = (action: string, label: string, at: number, options: Partial<TimelineMenuItem> = {}): TimelineMenuItem => {
      const plan = planTimelineAction({ doc: current, action, ids: target.ids, at, track: target.track, clipboard });
      return entry(action, label, () => {
        if (!plan.ok) { setNotice({ kind: 'error', text: plan.message ?? '此处无法执行' }); return; }
        void sendOps(plan.ops as EditOp[], label).then(ok => {
          if (!ok || projectId !== projectIdRef.current || scope !== `${projectIdRef.current}/${sequenceRef.current?.id ?? 'main'}`) return;
          if (['paste', 'duplicate', 'split'].includes(action)) selectClips(plan.ids, false);
          if (action === 'ripple-trim-start' && one) seekTo(Number(one.at ?? 0));
        });
      }, { disabled: busy || !plan.ok || plan.ops.length === 0, ...options });
    };

    const paste = planned('paste', '粘贴', target.at, { shortcut: `${platformKey}V` });
    const gaps = [
      planned('close-gap', '移除这处空隙', target.at),
      planned('close-all-gaps', '移除此轨所有空隙', target.at),
    ];
    if (target.kind === 'space') return [[paste], gaps];

    if (target.kind === 'track' && lane) {
      const hasAudio = lane.clips.some(clip => (clip.kind === 'video' || clip.kind === 'sound'));
      return [[
        entry('track-lock', lane.locked ? '解锁轨道' : '锁定轨道', () => toggleTrackFlag(lane.index, 'locked'), { disabled: busy }),
        entry('track-visibility', lane.hidden ? '显示轨道' : '隐藏轨道', () => toggleTrackFlag(lane.index, 'hidden'), { disabled: busy }),
        ...(hasAudio || lane.muted ? [
          entry('track-mute', lane.muted ? '取消轨道静音' : '轨道静音', () => toggleTrackFlag(lane.index, 'muted'), { disabled: busy }),
          entry('track-solo', soloTracks.includes(lane.index) ? '退出独听' : '独听此轨', () => toggleSolo(lane.index)),
        ] : []),
      ], TRACK_HEIGHT_PRESETS.map(preset =>
        entry(`track-height-${preset}`, `轨道高度 · ${TRACK_HEIGHT_LABELS[preset]}`, () => changeTrackHeight(lane.index, TRACK_HEIGHTS[preset])),
      ), [gaps[1]!, entry('track-delete', '删除轨道', () => {
        void sendOps(lane.clips.map(clip => ({ op: 'remove', clip: clip.id })), '删除轨道');
      }, { disabled: busy || lane.locked || lane.clips.length === 0 ||
        lane.clips.some(clip => clip.link || listAppliedTransitions(current).some((item: { from: string; to: string }) =>
          item.from === clip.id || item.to === clip.id)), danger: true })]];
    }

    const presetEndpoints = new Set(listAppliedTransitions(current).flatMap((item: { from: string; to: string }) => [item.from, item.to]));
    const hasPreset = selectionRows.some(({ clip }) => presetEndpoints.has(clip.id));
    const applyProperties = (group: 'visual' | 'sound' | 'all'): void => {
      if (!properties) return;
      const ops = selectionRows.flatMap(({clip}) => {
        const fields: Record<string, unknown> = {};
        if (group !== 'sound' && clip.kind !== 'sound' && properties.kind !== 'sound') {
          fields.box = properties.box ?? null;
          fields.size = properties.size ?? null;
          fields.style = properties.style ?? null;
        }
        const sourceAudio = properties.kind === 'video' || properties.kind === 'sound';
        if (group !== 'visual' && sourceAudio && (clip.kind === 'video' || clip.kind === 'sound')) {
          fields.volume = properties.volume ?? null;
          fields.muted = properties.muted ?? null;
        }
        if (group === 'all' && clip.kind !== 'subtitle') {
          const fade = effectiveFade(properties);
          const sum = fade[0] + fade[1];
          const scale = sum > 0 ? Math.min(1, clipSpan(clip).length / sum) : 1;
          fields.fade = [fade[0] * scale, fade[1] * scale];
        }
        return Object.keys(fields).length ? [{ op: 'fields', clip: clip.id, fields }] : [];
      });
      void sendOps(ops, '粘贴属性');
    };
    const targets = selectionRows.map(({ clip }) => ({ id: clip.id, clip }));
    const reference = entry('reference', '添加到对话', () => {
      setClipReferenceRequest({ projectId, sequenceId, ids: target.ids });
      setAgentOpen(true);
    });
    const save = entry('save-source', '收藏片段', () => {
      if (!one) return;
      void fetch(`/api/projects/${encodeURIComponent(projectId)}/creation-library/actions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'resource.save', target: { clipId: one.id }, expectedHash: basis, opId: crypto.randomUUID() }),
      }).then(async response => {
        const result = await response.json() as LibraryActionResult;
        if (!response.ok || !result.ok) throw new Error(result.message ?? '无法收藏此片段');
        if (projectId !== projectIdRef.current) return;
        window.dispatchEvent(new CustomEvent('opencut:creation-library-refresh', { detail: { projectId } }));
        setNotice({ kind: 'info', text: '已保存到我的收藏' });
      }).catch(error => { if (projectId === projectIdRef.current) setNotice({ kind: 'error', text: describe(error) }); });
    }, { disabled: busy || !one || missingClips.includes(one.id) });
    const replace = entry('replace', '替换素材…', () => {
      if (!one) return;
      const bridge = (globalThis as unknown as { opencut?: { pickRelinkFile?: () => Promise<{ canceled: boolean; path?: string }> } }).opencut;
      if (!bridge?.pickRelinkFile) { if (missingClips.includes(one.id)) openRelink(); return; }
      void bridge.pickRelinkFile().then(async picked => {
        if (picked.canceled || !picked.path || !alive()) return;
        const routeId = `${projectId}::${sequenceId}`;
        const result = await relinkMedia(routeId, { ...nextEnvelope(), projectId: routeId }, [{ clip: one.id, src: picked.path, copy: true }]);
        if (!result.ok) throw new Error(result.message ?? '替换失败');
        if (!scopeAlive()) return;
        await refreshDoc(routeId, scopeAlive);
        if (scopeAlive()) setNotice({ kind: 'info', text: '素材已替换' });
      }).catch(error => { if (scopeAlive()) setNotice({ kind: 'error', text: describe(error) }); });
    }, { disabled: locked || !one || !['video','sound','still','page'].includes(one.kind ?? '') ||
      !('opencut' in globalThis) && !missingClips.includes(one.id) });
    const exportClip = entry('export-clip', '导出网页动效…', () => {
      if (!one) return;
      setExportBusy(true);
      void startExport({ projectId, clipId: one.id, expectedHash: basis, sequence: sequenceId }).then(async () => {
        await refreshExportQueue();
        if (projectId !== projectIdRef.current) return;
        setExportOpen(true);
        setNotice({ kind: 'info', text: '网页动效已加入导出队列' });
      }).catch(error => {
        if (projectId === projectIdRef.current) setNotice({ kind: 'error', text: describe(error) });
      }).finally(() => setExportBusy(false));
    }, { disabled: exportBusy || !one || one.kind !== 'page' || !one.time ||
      selectionRows[0]?.track.hidden || isClipDisabled(one) || hasPreset });
    const hasSound = one && (one.kind === 'sound' || (one.kind === 'video' &&
      (assets.some(asset => `assets/${asset.name}` === bareSrcOf(one.src) && asset.hasAudio) ||
        media?.items.some(item => item.src === bareSrcOf(one.src) && item.hasAudio))));
    const normalizeEntries = (['streaming', 'broadcast'] as const).map(preset => {
      const label = preset === 'streaming' ? '响度标准化 · 网络' : '响度标准化 · 广播';
      return entry(`normalize-${preset}`, label, () => {
        if (!one) return;
        setLoudnessScope(scope);
        setNotice({ kind: 'info', text: '正在测量片段响度…' });
        const routeId = `${projectId}::${sequenceId}`;
        void measureClipLoudness(routeId, one.id, basis, preset).then(result => {
          if (!alive() || result.hash !== basis) {
            if (projectId === projectIdRef.current) setNotice({ kind: 'error', text: '工程已更新，请重新测量响度' });
            return;
          }
          const estimate = result.loudness.estimatedLufs.toFixed(1);
          const limited = result.loudness.limitedBy ? '（已保护峰值或音量上限）' : '';
          return sendOps(result.ops, label, `响度预估 ${estimate} LUFS${limited}`);
        }).catch(error => {
          if (alive()) setNotice({ kind: 'error', text: describe(error) });
        }).finally(() => setLoudnessScope(previous => previous === scope ? '' : previous));
      }, { disabled: locked || !hasSound || !one || one.muted || isClipDisabled(one) ||
        selectionRows[0]?.track.hidden || selectionRows[0]?.track.muted || loudnessScope !== '' || missingClips.includes(one.id) });
    });
    const canRetime = one && ['video', 'sound', 'page'].includes(one.kind ?? '') && !one.link && !hasPreset && !hasClipKeyframes(one);
    const isRetime = speedEdge?.scope === scope && speedEdge.id === one?.id;
    const speed = entry('speed-edge', isRetime ? '退出边缘变速' : '拖动边缘变速', () => {
      setSpeedEdge(isRetime || !one ? null : { scope, id: one.id });
    }, { disabled: locked || !canRetime, shortcut: `${platformKey}R` });
    const disabling = targets.some(({ clip }) => !isClipDisabled(clip));
    const toggleEnabled = entry('clip-enabled', disabling ? '停用片段' : '启用片段', () => {
      const ops = targets.map(({ id, clip }) => {
        const attrs = { ...clip.attrs };
        if (disabling) attrs[CLIP_DISABLED_ATTR] = CLIP_DISABLED_VALUE;
        else delete attrs[CLIP_DISABLED_ATTR];
        return { op: 'fields', clip: id, fields: { attrs: Object.keys(attrs).length ? attrs : null } };
      });
      void sendOps(ops, disabling ? '停用片段' : '启用片段');
    }, { disabled: locked || (disabling && hasPreset), shortcut: '⇧E' });
    const markers = one ? clipMarkersOf(one) : [];
    const spanLength = one ? clipSpan(one).length : 0;
    const tolerance = current.fps.den / current.fps.num / 2;
    const existingMarker = one ? markers.find(marker => {
      const position = timelineTimeOfClipMarker(one, marker, spanLength);
      return position !== null && Math.abs(position - playhead) <= tolerance;
    }) : undefined;
    const marker = entry('clip-marker', existingMarker ? '删除播放头标记' : '在片段上加标记', () => {
      if (!one) return;
      const created = clipMarkerAt(one, playhead, { id: crypto.randomUUID(), durationSec: spanLength });
      const next = existingMarker ? markers.filter(item => item.id !== existingMarker.id) : created ? [...markers, created] : markers;
      const attrs = { ...one.attrs };
      const encoded = encodeClipMarkers(next);
      if (encoded) attrs[CLIP_MARKERS_ATTR] = encoded;
      else delete attrs[CLIP_MARKERS_ATTR];
      void sendOps([{ op: 'fields', clip: one.id, fields: { attrs: Object.keys(attrs).length ? attrs : null } }], existingMarker ? '删除片段标记' : '添加片段标记');
    }, { disabled: locked || !one || !clipMarkerAt(one, playhead, { id: 'check', durationSec: spanLength }), shortcut: 'M' });
    const main = mainTrackIndex(current.tracks);
    const plainDelete = planned(ripple && selectionRows.every(row => row.track.index === main) ? 'ripple-delete' : 'delete',
      '删除', playhead, { id: 'normal-delete', danger: true });
    return [
      [reference, save, replace, marker],
      [
        entry('copy-attributes', '复制属性', () => {
          if (one) clipPropertyClipboard.current = { scope, clip: structuredClone(one) };
          setNotice({ kind: 'info', text: '已复制片段属性' });
        }, { disabled: !one }),
        entry('paste-attributes', '粘贴属性', () => applyProperties('all'), { disabled: locked || !properties || hasPreset }),
        entry('paste-visual', '只粘贴画面属性', () => applyProperties('visual'), { disabled: locked || !properties || properties.kind === 'sound' || targets.every(({clip}) => clip.kind === 'sound') }),
        entry('paste-audio', '只粘贴音频属性', () => applyProperties('sound'), { disabled: locked || !properties || !['video','sound'].includes(properties.kind ?? '') || targets.every(({clip}) => !['video','sound'].includes(clip.kind ?? '')) }),
      ],
      [
        planned('split', '在播放头处分割', playhead, { shortcut: `${platformKey}B` }),
        planned('ripple-trim-start', '波纹裁剪开头', playhead, { shortcut: 'Q' }),
        planned('ripple-trim-end', '波纹裁剪结尾', playhead, { shortcut: 'W' }),
        speed,
      ],
      [
        entry('link', '链接片段', () => {
          const link = `link-${crypto.randomUUID()}`;
          void sendOps([{ op: 'props', edits: targets.map(({id}) => ({ clip: id, prop: 'link', value: link })) }], '链接片段');
        }, { disabled: locked || targets.length < 2 }),
        entry('unlink', '解除链接', () => void sendOps([
          { op: 'props', edits: targets.map(({id}) => ({ clip: id, prop: 'link', value: null })) },
        ], '解除链接'), { disabled: locked || !targets.some(({clip}) => clip.link) }),
        entry('detach-audio', '分离音频', () => splitAudio(one!.id), {
          disabled: locked || !one || !assets.some(asset => `assets/${asset.name}` === bareSrcOf(one.src) && asset.hasAudio) ||
            audioSplitOf(current, one).status !== 'pending',
        }),
        toggleEnabled,
        ...normalizeEntries,
        ...(['in','out'] as const).map(edge => {
          const label = edge === 'in' ? '淡入' : '淡出';
          const plan = planFadeOps(targets, edge, 0.3);
          return entry(`fade-${edge}`, `${label} 0.3 秒`, () => void sendOps(plan.ops as EditOp[], label), {
            disabled: locked || hasPreset || !plan.ops.length,
          });
        }),
      ],
      [
        entry('copy', '复制', () => {
          const result = copyTimelineClips({ doc: current, ids: target.ids });
          if (result.ok) clipClipboard.current = { scope, entries: result.clipboard };
          setNotice(result.ok ? {kind:'info',text:'已复制片段'} : {kind:'error',text:result.message});
        }, { disabled: !targets.length, shortcut: `${platformKey}C` }),
        paste,
        planned('duplicate', '创建副本', playhead, { shortcut: `${platformKey}D` }),
      ],
      [exportClip],
      [plainDelete, planned('ripple-delete', '波纹删除', playhead, { danger: true, shortcut: '⇧⌫' })],
    ];
  }

  const pickRelinkDir = useCallback(async (): Promise<void> => {
    const bridge = (globalThis as unknown as { opencut?: { pickRelinkDir?: () => Promise<{ canceled: boolean; path?: string }> } }).opencut;
    if (typeof bridge?.pickRelinkDir !== 'function') return;
    const picked = await bridge.pickRelinkDir();
    if (picked.canceled || picked.path === undefined) return;
    setRelinkDir(String(picked.path));
  }, []);

  const doHistory = useCallback(
    async (kind: 'undo' | 'redo'): Promise<void> => {
      const id = projectIdRef.current;
      if (id === '') return;
      setBusy(true);
      try {
        await history(id, kind, hashRef.current);
        await refreshDoc(id);
        setNotice({ kind: 'info', text: kind === 'undo' ? '已撤销一批' : '已重做一批' });
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          await refreshDoc(id).catch(() => {});
          setNotice({ kind: 'error', text: '他人已改，已刷新后又撤销/重做；请再点一次' });
        } else {
          setNotice({ kind: 'error', text: describe(error) });
        }
      } finally {
        setBusy(false);
      }
    },
    [refreshDoc],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // 设置面板打开时：Esc 关面板，其余编辑键一律不生效（A8）。
      if (settingsOpenRef.current) {
        if (matchShortcut(event) === 'escape') {
          event.preventDefault();
          closeSettings();
        }
        return;
      }
      const focused = event.target instanceof Element ? event.target : null;
      if (focused?.closest('input, textarea, select, [contenteditable="true"], .oc-timeline-menu')) return;
      const key = event.key.toLowerCase();
      const modifier = event.metaKey || event.ctrlKey;
      const onTimeline = focused?.closest('.timeline, .timeline-shell') !== null && focused !== null;
      if (onTimeline && !event.altKey) {
        const id = modifier ? ({ b: 'split', c: event.shiftKey ? 'copy-attributes' : 'copy', v: event.shiftKey ? 'paste-attributes' : 'paste', d: 'duplicate', r: 'speed-edge' } as Record<string,string>)[key] :
          key === 'q' ? 'ripple-trim-start' : key === 'w' ? 'ripple-trim-end' : key === 'm' ? 'clip-marker' :
          event.shiftKey && key === 'e' ? 'clip-enabled' :
          event.shiftKey && (key === 'backspace' || key === 'delete') ? 'ripple-delete' : undefined;
        if (id) {
          const action = contextActions({ kind: 'clip', ids: selection, at: playhead }).flat().find(item => item.id === id);
          if (action && !action.disabled) { event.preventDefault(); action.run(); }
          return;
        }
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        // 拖拽中不删片段：手势期间的删除键留给「取消/继续拖」，松手后再说（M19-A6 的同一条规则）。
        // 双保险：draggingRef（onPreview 起）与模块自己的 mode（按下即非空，不必先移动）。
        if (draggingRef.current) return;
        const mode = gestureRef.current?.getState?.()?.mode ?? null;
        if (mode !== null) return;
        event.preventDefault();
        // 转场先吃：选中转场块时 Delete = 移除转场（恢复硬切），不动片段。
        if (!removeActiveTransition()) deleteSelected();
      } else if (event.key === 'Escape') {
        if (speedEdge) setSpeedEdge(null);
        // 手势的 Esc 由模块自己吃掉（capture + stopPropagation）；到这里说明只是在选层状态。
        /* S93：先清元素多选（集合 → 空、面板回空态），再退出层模式。
           焦点在舞台 iframe 里时这条收不到——那种情况由舞台转发（onStageUpdate 的 key 分支）。 */
        if (elementSelRef.current.length > 0) {
          setElementSelection([]);
          layerAtRef.current = '';
          setLayerAt('');
          stageDockRef.current?.setSelection('');
        }
        if (composeModeRef.current === 'layer') changeComposeMode('clip');
      } else if (key === 's' && !modifier && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        splitSelected();
      }
    };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  });

  // 走带键盘：Space / J K L / , . / Home End；输入框聚焦时不拦截。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // 设置面板打开时走带键全部让路（Space 不该开始播放）。
      if (settingsOpenRef.current) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName ?? '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable === true) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === ' ') {
        // 焦点在按钮上时 Space 是「按下按钮」，不抢。
        if (tag === 'BUTTON') return;
        event.preventDefault();
        togglePlay();
      } else if (event.key === 'k' || event.key === 'K') {
        event.preventDefault();
        pausePlayback();
      } else if (event.key === 'l' || event.key === 'L') {
        event.preventDefault();
        lKey();
      } else if (event.key === 'j' || event.key === 'J' || event.key === ',') {
        event.preventDefault();
        stepBy(-1 / 30);
      } else if (event.key === '.') {
        event.preventDefault();
        stepBy(1 / 30);
      } else if (event.key === 'Home') {
        event.preventDefault();
        seekTo(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        seekTo(durationRef.current > 0 ? durationRef.current : duration);
      }
    };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [duration, lKey, pausePlayback, seekTo, stepBy, togglePlay]);

  // Informational notices can also explain a blocked action or an uncopied
  // output path. Only routine confirmations should be visually silent.
  const passiveNotice = notice?.kind === 'info' && (
    /^(?:已(?:撤销一批|重做一批|写回|导入 |复制产物路径|回到作者布局|在画布上定位|清除 |重链 )|(?:图层|批量|几何|文字)已提交|(?:手势|文字编辑)已取消|布局已复位|(?:吸附|波纹删除|网格吸附)：|动效已写入 |批量重链：)/.test(notice.text)
    || / · \d+ 个 Op · 已落盘 · /.test(notice.text)
  );
  /* 编辑区不弹任何提示框（用户要求）：info 与 error 一律只记日志，
     由「设置 → 诊断」按时间列出；passive 的极简状态行保留（不占位、无边框）。 */
  if (notice !== null) {
    recordNotice({ level: notice.kind, text: notice.text, guardCode: notice.guardCode });
  }
  const noticeBar =
    notice === null || !passiveNotice
      ? null
      : createElement('span', {
          className: 'editor-passive-status',
          role: 'status',
          'aria-live': 'polite',
          'data-testid': 'notice',
          'data-notice-level': 'info',
        }, notice.text);

  const previewProject = doc === null ? '' : project?.projectId ?? '';
  // Snapshot the initial time only when the document changes. Scrubbing uses the bridge.
  const previewUrl = useMemo(
    () => previewProject === '' || contentOrigin === ''
      ? null
      : stageUrl(contentOrigin, previewProject, location.origin, hash, playheadValueRef.current),
    [previewProject, contentOrigin, hash, stageEpoch],
  );

  // —— 画布层框按画布坐标和预览缩放换算成 client 坐标 ——
  // 坐标基座用**布局后量到的** overlayStage（见 measureOverlay）；首帧还没量到时退回即时读。
  const stageRect = overlayStage ?? stageRectNow();
  /**
   * 层框（S93 起是**一组**）：单层用实测矩形（`describeLayer`，最准）；多层时主层用实测、
   * 其它层用 `layerRects` 的快照（同一批，够画框）。拿不到矩形的跳过——不画半截框。
   * `data-primary` 标出主选中，`data-count` 是这一屏一共几个框（可复算）。
   */
  const layerOutlineBoxes: Array<{ at: string; box: StageBox; label: string; primary: boolean }> = (() => {
    if (composeMode !== 'layer' || stageRect === null) return [];
    const bareOf = (id: string): string =>
      pageClipId !== '' && id.startsWith(`${pageClipId}::`) ? id.slice(pageClipId.length + 2) : id;
    const primary = bareOf(layerAt);
    const list = elementSel.length > 1 ? elementSel : primary === '' ? [] : [primary];
    const out: Array<{ at: string; box: StageBox; label: string; primary: boolean }> = [];
    for (const at of list) {
      if (at === '' || hiddenLayers.includes(at)) continue;
      const box = at === primary && layerRect !== null ? layerRect : (layerRectsRef.current.get(at) ?? null);
      if (box === null) continue;
      const name = layerOptions.find((item) => item.at === at)?.name ?? at;
      out.push({ at, box, label: `${name} · ${Math.round(box.w)}×${Math.round(box.h)}`, primary: at === primary });
    }
    return out;
  })();
  const layerOutline =
    stageRect === null
      ? null
      : layerOutlineBoxes.map((item) =>
          createElement(
            'div',
            {
              key: `layer-outline-${item.at}`,
              className: 'layer-outline',
              'data-testid': 'layer-outline',
              'data-at': item.at,
              'data-primary': String(item.primary),
              'data-count': String(layerOutlineBoxes.length),
              style: {
                left: `${stageRect.x + item.box.x * stageRect.scale}px`,
                top: `${stageRect.y + item.box.y * stageRect.scale}px`,
                width: `${item.box.w * stageRect.scale}px`,
                height: `${item.box.h * stageRect.scale}px`,
              },
            },
            createElement('span', { className: 'layer-outline-label' }, item.label),
          ),
        );

  /**
   * R120 · M6（LI-A12）：元素框 + 8 向手柄 + 旋转柄。
   *
   * 只在**单层**（`composeMode==='layer'` 且这一层有几何事实）时出现。
   * 预览位移 `p` 全是**屏幕 px**，落盘时才换成声明坐标（`buildElementPatch`）。
   */
  const elementFrame = (() => {
    if (composeMode !== 'layer' || layerRect === null || stageRect === null) return null;
    const facts = elementFactsRef.current;
    if (facts === null || facts.at !== elementBare() || facts.clipId !== pageClipId) return null;
    const p = elementDrag;
    let bx = layerRect.x;
    let by = layerRect.y;
    let bw = layerRect.w;
    let bh = layerRect.h;
    /**
     * R123 · M9：**屏幕 px → 声明坐标**。
     *
     * `p.dx/p.dy` 是指针位移（屏幕 px），而 `bx/bw` 是舞台声明坐标 —— 下面还要
     * `× stageRect.scale` 才变成屏幕位置。R120 直接把 `p.dx` 加进 `bx`，等于缩放被算了两次：
     * 实测 1920（scale 0.846875）指针走 48，框只走 40.64；1440（0.4969）只有一半。
     * 落盘那条路（`declaredDelta`，除以 `fit × scale`）一直是对的，所以只有**预览**慢半拍。
     */
    const toDoc = (v: number): number => (stageRect.scale > 0 ? v / stageRect.scale : 0);
    const pdx = p === null ? 0 : toDoc(p.dx);
    const pdy = p === null ? 0 : toDoc(p.dy);
    if (p !== null && p.mode === 'move') {
      bx += pdx;
      by += pdy;
    } else if (p !== null && p.mode === 'resize') {
      const signs: Readonly<Record<string, readonly [number, number]>> = {
        nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0],
      };
      const sign = signs[p.handle] ?? [1, 1];
      if (sign[0] < 0) {
        bx += pdx;
        bw -= pdx;
      } else if (sign[0] > 0) bw += pdx;
      if (sign[1] < 0) {
        by += pdy;
        bh -= pdy;
      } else if (sign[1] > 0) bh += pdy;
      bw = Math.max(8, bw);
      bh = Math.max(8, bh);
    }
    const left = stageRect.x + bx * stageRect.scale;
    const top = stageRect.y + by * stageRect.scale;
    const width = Math.max(1, bw * stageRect.scale);
    const height = Math.max(1, bh * stageRect.scale);
    return createElement(
      'div',
      {
        className: 'element-frame',
        'data-testid': 'element-frame',
        /* 手势层的显式免疫区（`canvas-gesture.mjs` 的 `onPointerDown` 会先看这个属性）：
           没有它，按在手柄上的那一下会先被当成「点舞台片段」，选中切回片段、框当场消失。 */
        'data-no-stage-gesture': '',
        'data-at': facts.at,
        'data-mode': p === null ? 'idle' : p.mode,
        style: {
          left: `${left}px`,
          top: `${top}px`,
          width: `${width}px`,
          height: `${height}px`,
          transform: p !== null && p.mode === 'rotate' ? `rotate(${p.dr}deg)` : undefined,
        },
      },
      createElement(
        'div',
        {
          className: 'element-frame-chip',
          'data-testid': 'element-drag',
          title: '拖动移动；双击就地改文字',
          /* 捕获阶段：舞台手势层挂在祖先上（冒泡），冒泡期再截就晚了 ——
             R120 实测：普通 onPointerDown 时，这一下先被手势层当成「点片段」，
             选中切回片段 → 元素框与手柄在按下瞬间就没了。 */
          onPointerDownCapture: (event: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void }) =>
            elementGestureStart(event, 'move', ''),
          onDoubleClick: () => openElementTextEditor(),
        },
        '拖动 · 双击改文字',
      ),
      createElement(
        'button',
        {
          type: 'button',
          className: 'element-text-open',
          'data-testid': 'element-text-open',
          title: '就地改文字（双击框也行）',
          onPointerDownCapture: (event: { stopPropagation: () => void }) => event.stopPropagation(),
          onClick: () => openElementTextEditor(),
        },
        'T',
      ),
      createElement(
        'button',
        {
          type: 'button',
          className: 'element-reset',
          'data-testid': 'element-reset',
          title: '回到作者布局（删掉这层的几何覆盖；一步撤销）',
          onPointerDownCapture: (event: { stopPropagation: () => void }) => event.stopPropagation(),
          onClick: () => resetElementGeometry(),
        },
        '↺',
      ),
      ...['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((dir) =>
        createElement('div', {
          key: `element-handle-${dir}`,
          className: `element-handle h-${dir}`,
          'data-handle': dir,
          onPointerDownCapture: (event: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void }) =>
            elementGestureStart(event, 'resize', dir),
        }),
      ),
      createElement('div', {
        className: 'element-rotate-handle',
        'data-testid': 'element-rotate',
        title: '拖动旋转（默认 1° 吸附的粗粒度由指针决定）',
        onPointerDownCapture: (event: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void }) =>
          elementGestureStart(event, 'rotate', ''),
      }),
    );
  })();

  /**
   * 就地文本编辑（LI-A05）：盖在元素原位，字体按 describe 的 computed 值走。
   *
   * R123 · M9：**内容盒必须对齐**。原先是 `padding: 0 2px` + `border: 1px`（CSS 里写死），
   * 文字比页内右移 3px、可换行宽度少 6px —— 一旦某行最后几个字落在这 6px 里，
   * 换行位置就和成片不一样。现在：边框/内边距/文本缩进都按**元素自己的 computed 值 ×
   * 舞台缩放**给，`box-sizing: border-box` 让外框仍等于元素视觉矩形。
   * 虚线描边改成 `box-shadow: inset`（不占布局）。
   */
  /** 元素自身的内边距/边框/缩进按舞台缩放折算；`extra` 只在真需要补偿时用（现在不用）。 */
  const pxOf = (value: unknown, scaleBy: number, extra = 0): string => {
    const n = Number.parseFloat(String(value ?? ''));
    return `${(Number.isFinite(n) ? n * scaleBy : 0) + extra}px`;
  };
  /* 字号/行高/字距也是**长度**：编辑器是「按舞台缩放缩小的复制品」，不乘缩放就会
     在 1440（0.4969）渲成两倍大。`normal` 之类不可解析的值原样交回浏览器。 */
  const lenPx = (value: unknown, scaleBy: number): string | undefined => {
    const n = Number.parseFloat(String(value ?? ''));
    return Number.isFinite(n) ? `${n * scaleBy}px` : undefined;
  };
  /* R150 · M16-R3：想过给编辑器补 0.5px（页内墨迹比原生渲染高半像素），实测**无效** ——
     padding-top 从 0 改成 0.5px 后 computed 确实是 0.5px，但行带读数一个 0.5 都没动
     （textarea 的内层文本布局按整像素取整）。所以这里**不留**这个常数：
     剩下的 0.5–1.5px 是「整页缩放后光栅化 vs 原生渲染」的墨迹差，归 KNOWN_DIFF。 */
  const elementTextEditor =
    textEdit === null || stageRect === null
      ? null
      : createElement('textarea', {
          className: 'element-text-editor',
          'data-testid': 'element-text-editor',
          'data-no-stage-gesture': '',
          'data-at': textEdit.at,
          value: textEdit.value,
          autoFocus: true,
          spellCheck: false,
          style: {
            /* R150 · M16-R3（旧编辑层补偿退役）：M9 这里补过 1.5/0.5 的内边距、盒子再放大
               1px/2px，注释说那是「Chromium textarea 自带的内建内缩」。独立对照实测
               （同一套样式下 div 与 textarea 的墨迹原点逐位相同：10/10、7/7、19/19、15/15）
               证明 **textarea 没有内建内缩** —— 那几个补偿量其实一直在抵页面片段 iframe 的
               2px 边框。边框清零后（content-origin.mjs）编辑器必须**逐项等于元素自己的
               computed × 缩放**，多补 1.5px 反而会把字整体压低、1920 直接掉出判据。 */
            left: `${stageRect.x + textEdit.rect.x * stageRect.scale}px`,
            top: `${stageRect.y + textEdit.rect.y * stageRect.scale}px`,
            width: `${Math.max(60, textEdit.rect.w * stageRect.scale)}px`,
            height: `${Math.max(28, textEdit.rect.h * stageRect.scale)}px`,
            boxSizing: 'border-box',
            paddingTop: pxOf(textEdit.font.paddingTop, stageRect.scale),
            paddingRight: pxOf(textEdit.font.paddingRight, stageRect.scale),
            paddingBottom: pxOf(textEdit.font.paddingBottom, stageRect.scale),
            paddingLeft: pxOf(textEdit.font.paddingLeft, stageRect.scale),
            borderStyle: 'solid',
            borderColor: 'transparent',
            borderTopWidth: pxOf(textEdit.font.borderTop, stageRect.scale),
            borderRightWidth: pxOf(textEdit.font.borderRight, stageRect.scale),
            borderBottomWidth: pxOf(textEdit.font.borderBottom, stageRect.scale),
            borderLeftWidth: pxOf(textEdit.font.borderLeft, stageRect.scale),
            textIndent: pxOf(textEdit.font.textIndent, stageRect.scale),
            fontStyle: textEdit.font.fontStyle === '' || textEdit.font.fontStyle === 'normal' ? undefined : textEdit.font.fontStyle,
            textTransform: (textEdit.font.textTransform === '' || textEdit.font.textTransform === 'none' ? undefined : textEdit.font.textTransform) as never,
            fontSize: lenPx(textEdit.font.fontSize, stageRect.scale),
            lineHeight: lenPx(textEdit.font.lineHeight, stageRect.scale),
            fontFamily: textEdit.font.fontFamily === '' ? undefined : textEdit.font.fontFamily,
            fontWeight: textEdit.font.fontWeight === '' ? undefined : textEdit.font.fontWeight,
            letterSpacing: lenPx(textEdit.font.letterSpacing, stageRect.scale),
            color: textEdit.font.color === '' ? undefined : textEdit.font.color,
            textAlign: (textEdit.font.textAlign === '' ? undefined : textEdit.font.textAlign) as never,
          },
          onChange: (event: { target: { value: string } }) => setTextEdit({ ...textEdit, value: event.target.value }),
          onKeyDown: (event: { key: string; preventDefault: () => void; stopPropagation: () => void; metaKey: boolean; ctrlKey: boolean; nativeEvent: { isComposing?: boolean } }) => {
            /* IME 组字时的 Enter 是「上屏」，不是提交（LI-A05 的 IME/emoji 两项都靠这条）。 */
            if (event.nativeEvent?.isComposing === true) return;
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setTextEdit(null);
              setNotice({ kind: 'info', text: '文字编辑已取消：没有落盘' });
              return;
            }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              commitElementText();
            }
          },
          onBlur: () => commitElementText(),
        });

  const preview =
    doc === null
      ? createElement(EmptyStage, {
          title: project === null ? '还没有打开工程' : '工程已打开但没有可用文档',
          detail:
            project === null
              ? '从左侧选择一个含 film.html 的工程（列表来自 GET /api/projects）。'
              : 'GET /api/projects/:id/doc 没有返回可画的轨；先看顶部错误提示。',
          busy,
        })
      : createElement(StagePreview, {
          key: previewProject + '@' + contentOrigin,
          url: previewUrl,
          // epoch：模板升级/回退改了模板源文件而 film.html 没变，靠它强制重建舞台。
          iframeKey: `${project?.projectId ?? ''}:${hash}:${stageEpoch}`,
          ready: stageReady,
          contentOrigin,
          missingReason:
            contentOrigin === ''
              ? '内容 origin 未启动：Studio 启动时 env.json 里没有 contentPort。'
              : '还没有打开工程。',
          errorCode: stageError?.code ?? '',
          errorMessage: stageError?.message ?? '',
          onIframe: onStageIframe,
          frameRef: setPreviewFrame,
        });

  /**
   * R38（C 批 · 批注 3）：播放器卡的**左上角介绍位**。
   * 原来那条 26px 的 `.preview-status` 横条整条搬到卡头 —— 元素、testid、data-* 全留，
   * 只是不再占画面下方那一行。s74 的「等就绪」仍读 `[data-testid="stage-status"][data-ready]`。
   */
  const stageStatus =
    doc === null
      ? null
      : createElement(StageStatus, {
          hasStage: previewUrl !== null,
          ready: stageReady,
          playing,
          time: stageTime,
          timeRef: stageTimeRef,
          contentOrigin,
          // S74：只在「交付画幅 ≠ 工程画幅」时才提示，避免默认视图多一行字。
          deliveryNote:
            deliveryCanvas === null
              ? ''
              : deliveryCanvas.w === doc.stage.w && deliveryCanvas.h === doc.stage.h
                ? ''
                : `字幕按导出画幅 ${deliveryCanvas.w}×${deliveryCanvas.h} · ${exportForm.fit} 预排`,
        });

  /**
   * R38（C 批）：右下角的**基本参数**（帧率 · 总时长）。
   *
   * 时长用 `mm:ss` 而不是 `mm:ss.ff`：左下角的时间码是 `mm:ss.ff`（精确到帧），
   * 总时长用粗粒度才对得上「基本参数」的语义，也不会和 C5 的判法（排除 `mm:ss.ff`）打架。
   */
  const totalSeconds = Math.max(0, Math.round(duration));
  const durationText = `${String(Math.floor(totalSeconds / 60)).padStart(2, '0')}:${String(totalSeconds % 60).padStart(2, '0')}`;
  /* R164 · UI-V3-A（B01）：帧率 · 总时长不再占走带条一行 —— 它们和工程/序列/分辨率一起
     进「画布信息」浮层（`stage-meta` 这个 testid 跟着走，文本一字不改）。 */
  const stageMetaText = `${Math.round(fpsRef.current.num / fpsRef.current.den)} fps · ${durationText}`;

  const transport =
    doc === null
      ? null
      : createElement(TransportBar, {
          disabled: false,
          playing,
          rate,
          volume,
          loop,
          timecode: formatTimecode(stageTime, fpsRef.current),
          timecodeRef,
          onPlayPause: togglePlay,
          onHome: () => seekTo(0),
          onEnd: () => seekTo(durationRef.current > 0 ? durationRef.current : duration),
          onPrevFrame: () => stepBy(-1 / 30),
          onNextFrame: () => stepBy(1 / 30),
          onRate: (value: number) => changeRate(value),
          onVolume: changeVolume,
          onLoop: toggleLoop,
          meter: createElement(LevelMeter, { hasAudio, playing }),
          ratios: createElement(RatioPicker, {
            /* R164 · UI-V3-A（B06）：主行只留「当前比例 ▾」，四档在弹层里。 */
            compact: true,
            current: ratioIdOf(doc.stage),
            onPick: (id: string) => {
              const next = ratioPick(doc.stage, id);
              if (next === null) return; // 已经是这一档：不发空 op、不多一步撤销
              void sendOps([{ op: 'stage', w: next.w, h: next.h }], `画幅 ${id}（${next.w}×${next.h}）`);
            },
          }),
        });

  /**
   * E07（R36）：吸附开关的写入面 —— 按钮从顶栏搬进时间线工具条的视图组。
   * 状态机与文案一字未改，只是把「谁调它」从顶栏换成时间线；`snapRef` 仍是最新的那份。
   */
  const toggleSnap = (): void => {
    const next = !snapRef.current;
    snapRef.current = next;
    setSnap(next);
    setNotice({ kind: 'info', text: next ? '吸附：开（零点 / 邻片边界 / 播放头）' : '吸附：关' });
  };

  const timeline =
    doc === null
      ? null
      :     createElement(Timeline, {
          historySlot: createElement(HistoryActions, {
            busy,
            undoDepth,
            redoDepth,
            onUndo: () => void doHistory('undo'),
            onRedo: () => void doHistory('redo'),
          }),
          doc,
          projectId: project?.projectId ?? '',
          onResourceDrop: (drop:ResourceDrop) => {
            const id = projectIdRef.current;
            if (!id || busy || drop.projectId !== id) return;
            let request;
            try { request = resourceDropAction(drop, cuts); } catch(error) { setNotice({kind:'error',text:describe(error)}); return; }
            setBusy(true);
            void fetch(`/api/projects/${encodeURIComponent(id)}/creation-library/actions`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...request,expectedHash:hashRef.current,opId:crypto.randomUUID()})}).then(async r => {
              const result = await r.json() as LibraryActionResult;
              if (!r.ok || !result.ok) throw new Error(result.message ?? result.code ?? '素材未加入');
              if (id !== projectIdRef.current) return;
              if (result.clipId && !selection.includes(result.clipId)) {
                layerAtRef.current = ''; setLayerAt(''); setElementSelection([], false); setLayerError('');
                stageDockRef.current?.setSelection('');
              }
              await refreshRef.current();
              if (id !== projectIdRef.current) return;
              if (result.clipId) { setSelection([result.clipId]); writeTarget(result.clipId, '', 'system'); }
              window.dispatchEvent(new CustomEvent('opencut:creation-library-refresh',{detail:{projectId:id}}));
            }).catch((error:unknown) => { if (id === projectIdRef.current) setNotice({kind:'error',text:describe(error)}); }).finally(() => setBusy(false));
          },
          selection,
          playhead,
          pps,
          onZoom: changePps,
          playheadRef,
          playheadHandleRef,
          timelineScrollerRef,
          onSelect: selectClips,
          onPlayhead: seekTo,
          /* 时间线只关心「发出去了」，不关心成败（它自己的 notice 在 sendOps 里）。 */
          onOps: (ops: EditOp[], label: string): Promise<void> => sendOps(ops, label).then(() => undefined),
          snap,
          onToggleSnap: toggleSnap,
          /* R37（批次 A · 批注 5）：原来在顶栏的那几件，全部改成 Timeline 的口子。
             **testid 一个没改**（split / delete / ripple-toggle / grid-toggle / grid-size）。 */
          onStepFrame: (direction: -1 | 1) => {
            const fps = fpsRef.current;
            const rate = fps.num > 0 ? fps.num / (fps.den > 0 ? fps.den : 1) : 30;
            stepBy(direction / rate);
          },
          onSplit: splitSelected,
          canSplit: planTimelineAction({ doc, action: 'split', ids: selection, at: playhead }).ok,
          onDelete: deleteSelected,
          canDelete: selection.length > 0,
          busy,
          ripple,
          onToggleRipple: () => {
            const next = !rippleRef.current;
            rippleRef.current = next;
            setRipple(next);
            setNotice({ kind: 'info', text: next ? '波纹删除：开（主轨删了合上）' : '波纹删除：关（删了留间隙）' });
          },
          grid,
          onToggleGrid: () => {
            toggleGrid();
            setNotice({ kind: 'info', text: grid.enabled ? '网格吸附：关' : `网格吸附：开（${grid.size}px，舞台画布手势）` });
          },
          onGridSize: changeGridSize,
          mainTrack: mainTrackIndex(doc?.tracks ?? []),
          onSettings: openSettings,
          timecodeRef: trackTimecodeRef,
          transitions,
          cuts,
          onAddTransition: addTransition,
          activeTransitionId,
          onTransitionSelect: (id: string | null) => {
            if (id !== null) setCueIndex(null);
            setActiveTransitionId(id);
          },
          onTransitionReject: (message: string) => setNotice({ kind: 'error', text: message }),
          onAudioNotice: audioReject,
          // 轨道开关（M38）：静音/隐藏/锁定写文档，独奏只改预览。
          trackControls: { solo: soloTracks, onFlag: toggleTrackFlag, onSolo: toggleSolo },
          onEditReject: (message: string) => setNotice({ kind: 'error', text: message }),
          // 触摸手势（M43）：换工程就重挂一套监听（旧工程的监听必须拆掉，否则一次手势两次提交）。
          gestureScope: `${project?.projectId ?? ''}/${sequence?.id ?? 'main'}`,
          // 波形（M34）：同源只读出口；工程没打开就不画（时间线其余部分照常）。
          waveform:
            project === null
              ? null
              : { fileBase: `/api/projects/${encodeURIComponent(project.projectId)}/file` },
          /* E04（R29）：胶片条的取帧出口；同一台 Studio 的 derived 路由（页片段 415，前端不铺）。 */
          filmstrip:
            project === null
              ? null
              : { base: `/api/projects/${encodeURIComponent(project.projectId)}/derived` },
          trackHeight: { heights: trackHeights, onChange: changeTrackHeight },
          missingClips,
          sourceDurations: nativeDurations,
          speedEdgeClip: speedEdge?.scope === `${project?.projectId}/${sequence?.id ?? 'main'}` ? speedEdge.id : null,
          onBlade: (clipId: string, at: number) => splitAt([clipId], at),
          onContextActions: contextActions,
          subtitle: !hasCurrentSubtitle ? undefined : {
            file: subtitleFile,
            format: subtitleFormat,
            cues,
            activeIndex: cueIndex,
            busy: subtitleBusy,
            skipped: cueSkipped,
            onSelect: selectCue,
            onEdit: openCueEditor,
            onMove: moveCue,
            onStyle: () => setSubtitleStyleOpen(true),
            fps: doc.fps,
          },
        });

  /**
   * R34（R31-093 B）：工程块的**唯一一份** —— 渲染在顶栏「工程 ▾」菜单里（见 TopBar 的
   * `projectMenu`）。不再放进 `.layout`：抽屉模式下 `.sidebar` 本来就被 `:has` 隐藏，
   * 两处都渲染会让 `archive-export` / `data-project-id` 这些 testid 出现两次，
   * Playwright 的 strict 模式会直接判错（那才是真正的破坏）。
   */
  const projectPanel = createElement(ProjectList, {
    projects,
    activeId: project?.projectId ?? '',
    loading: listLoading,
    error: listError,
    onOpen: (item: ProjectListItem) => {
      /* R34：选了工程就收起菜单（这就是「切工程」的完成态）。 */
      setProjectMenuOpen(false);
      void openByPath(item, { newTab: true });
    },
    onImport: () => void pickMedia(),
    importing,
    assets,
    assetsLoading,
    assetsError,
    assetThumb: (asset: AssetItem) => assetThumbUrl(project?.projectId ?? '', asset.name),
    onInsertAsset: (asset: AssetItem) => void insertAssetAtPlayhead(asset),
    missingCount: missingItems.length,
    onOpenRelink: openRelink,
    recent: recentProjects,
    recentCorrupt,
    onOpenRecent: (item: RecentProjectItem) => {
      setProjectMenuOpen(false);
      void openByPath({ projectId: '', name: item.name, path: item.path, opened: false }, { newTab: true });
    },
    onArchive: () => void archiveActive(),
    archiving,
    onImportArchive: () => void pickArchive(),
    importingArchive,
    archivePathOpen,
    onSubmitArchivePath: (zipPath: string) => void runImportArchive(zipPath),
    onCancelArchivePath: () => setArchivePathOpen(false),
    onRemoveRecent: (item: RecentProjectItem) => {
      void (async () => {
        try {
          await removeRecentProject(item.path);
          await refreshList();
        } catch (error) {
          setNotice({ kind: 'error', text: describe(error) });
        }
      })();
    },
  });

  /* R102 · U1-R2：工程标签条收进顶栏（补正书 §1「紧跟 C 图标右侧同一层」）。
     它原来是顶栏**上面**独立的一条 36px 横带，会把顶栏整体压下 36px、与
     「顶栏 0,0 1440×40」直接冲突。现在作为槽位传给 TopBar，渲染在 C 与单工程标签之间。 */
  const tabsSlot =
    tabsSnapshot === null
      ? null
      : createElement(TabBar, {
          snapshot: tabsSnapshot,
          names: Object.fromEntries(projects.map((item) => [item.projectId, item.name])),
          onSelect: (projectId: string) => void tabsApi()?.activate(projectId),
          onClose: (projectId: string) => void tabsApi()?.close(projectId),
        });
  return createElement(
    'div',
    { className: 'app', 'data-ui-polish': 'r3' },
    createElement('input', {
      ref: mediaInputRef,
      type: 'file',
      accept:
        '.mp4,.m4v,.mov,.webm,.mkv,.avi,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.png,.jpg,.jpeg,.webp,.gif,.avif,.bmp',
      style: { display: 'none' },
      'data-testid': 'media-input',
      onChange: (event: { target: HTMLInputElement }) => {
        const file = event.target.files?.[0] ?? null;
        event.target.value = '';
        void onMediaFile(file);
      },
    }),
    createElement(TopBar, {
      projectName: project?.name ?? '',
      onProjectHome: tabsSnapshot === null ? undefined : () => {
        void tabsApi()?.home().catch((error: unknown) => setNotice({ kind: 'error', text: describe(error) }));
      },
      /* R102 · U1-R2：工程标签（Electron 多工程时是 TabBar）+ 舞台状态行（搬进「诊断」）。 */
      tabsSlot,
      statusSlot: stageStatus,
      /* R34：工程块（列表/最近/导入素材/导出包/导入包）挂在名字那个下拉里。 */
      projectMenu: projectPanel,
      projectMenuOpen,
      moreMenuOpen,
      onToggleMoreMenu: () => {
        setProjectMenuOpen(false);
        setLayoutMenuOpen(false);
        setMoreMenuOpen(previous => !previous);
      },
      onCloseMoreMenu: closeMoreMenu,
      onToggleProjectMenu: () => { closeMoreMenu(); setProjectMenuOpen((previous) => !previous); },
      hash,
      transport: transportKind,
      health: healthText,
      socket,
      busy,
      undoDepth,
      redoDepth,
      onUndo: () => void doHistory('undo'),
      onRedo: () => void doHistory('redo'),
      /* R37：切分 / 删除 / 波纹 / 网格 都搬进了轨道工具栏（Timeline 那边接），
         顶栏只留全局动作（撤销 / 重做 / 版本 / 动效 / 批量分离音频 / 刷新）
         与右端三颗图标（设置 / 导出 / 布局）。 */
      layoutMenuOpen,
      onToggleLayoutMenu: () => { closeMoreMenu(); setLayoutMenuOpen((previous) => !previous); },
      onLayoutDefault: resetLayout,
      onLayoutReset: resetLayout,
      exportBadge: { running: exportQueue.some((job) => job.state === 'running'), queued: exportQueued },
      onExport: openExportPanel,
      onSettings: openSettings,
      onVersions: () => { closeMoreMenu(); setVersionsOpen(true); },
      /* 顶栏「动效」只负责把检查器切到「动效」页签：那里才有完整的模板管理（应用/另存/升级/回退/归档）。 */
      onMotion: () => {
        setInspectorChoice({ target: inspectorTarget, tab: 'advanced' });
        setInspectorTab('motion');
      },
      onAgent: () => { closeMoreMenu(); setAgentOpen((previous) => !previous); },
      batchDetach: { count: selected.length, busy },
      onBatchDetach: batchDetach,
      sequenceSlot:
        project === null
          ? null
          : createElement(SequenceBar, {
              projectId: project.projectId,
              hostOpen: moreMenuOpen,
              onReload: reloadAll,
              onDeleted: recoverAfterDelete,
              onCurrent: (next: { id: string; name: string }) => setSequence(next),
              disabled: busy,
              onNotify: (kind: 'info' | 'error', text: string) => setNotice({ kind, text }),
            }),
      onRefresh: () => {
        void refreshList();
        void refreshDoc().catch((error: unknown) => setNotice({ kind: 'error', text: describe(error) }));
        // 素材可能是被外部改名/移走的：刷新时连媒体状态一起重扫（缺失角标才追得上）。
        void refreshMedia();
      },
    }),
    settingsOpen
      ? createElement(SettingsPanel, {
          section: settingsSection,
          onSection: setSettingsSection,
          settings,
          defaults: settingsDefaults,
          issues: settingsIssues,
          settingsPath: settingsPathText,
          updatedAt: settingsUpdatedAt,
          ai: settingsAi,
          diagnostics: settingsDiag,
          storage: settingsStorage,
          busy: settingsBusy,
          error: settingsError,
          notice: settingsNotice,
          projectOpen: project !== null,
          version: settingsDiag?.studioVersion ?? '0.2.0',
          onClose: closeSettings,
          onChange: changeSettings,
          onReloadStorage: refreshSettingsStorage,
          onCleanCache: cleanSettingsCacheNow,
          onCopyDiagnostics: copySettingsDiagnostics,
          onMcpSaved: applyMcpServers,
        })
      : null,
    agentOpen
      ? createElement(AgentPanel, {
          enabledAgents: settings.agent?.enabled,
          projectId: project?.projectId ?? '',
          projectName: project?.name ?? '',
          clipReferenceRequest,
          onClipReferencesAccepted: consumeClipReferences,
          /* R120 · M6-R2：`AgentContext.sequenceId` 必须是**当前真实序列**。
             以前没传 → 面板回退成常量 `main`，多序列工程里 Agent 记到错的序列上。
             `sequence` 为 null（还没加载到）时留空，面板按自己的兜底走。 */
          sequenceId: sequence?.id ?? '',
          contentOrigin,
          /* E09 · E7（R35）：`+` 菜单的「上传素材」走宿主这条**唯一**入口 ——
             桌面版 electronBridge.pickMedia、浏览器版 <input type=file> 都在 pickMedia() 里，
             两条路都落到 api.importMedia。面板不复制第二套选文件逻辑。 */
          onPickMedia: () => void pickMedia(),
          onClose: () => setAgentOpen(false),
          /* apply/rollback 都改了 film.html：刷新 doc 让预览与 hash 跟上（面板不碰舞台）。 */
          onApplied: () => {
            void refreshRef.current();
          },
        })
      : null,
    versionsOpen && project !== null
      ? createElement(VersionPanel, {
          projectId: project.projectId,
          onClose: () => setVersionsOpen(false),
          /* 恢复只改 film.html：走 S73 的 reloadAll（doc/素材/媒体/导出队列/图层树），不另写一套。 */
          onReload: reloadAll,
          onNotify: (kind: 'info' | 'error', text: string) => setNotice({ kind, text }),
        })
      : null,
    detachResult === null
      ? null
      : createElement(
          'div',
          {
            className: 'batch-detach-card',
            'data-testid': 'batch-detach-card',
            'data-done': String(detachResult.done),
            'data-skipped': String(detachResult.skipped),
            'data-ops': String(detachResult.opCount),
          },
          createElement(
            'div',
            { className: 'batch-detach-head' },
            createElement('strong', { 'data-testid': 'batch-detach-summary' }, `已分离 ${String(detachResult.done)} 条，跳过 ${String(detachResult.skipped)} 条`),
            createElement(
              'button',
              { type: 'button', className: 'btn tiny', 'data-testid': 'batch-detach-close', onClick: () => setDetachResult(null) },
              '关闭',
            ),
          ),
          createElement(
            'details',
            { 'data-testid': 'batch-detach-details' },
            createElement('summary', null, '逐条结果'),
            ...detachResult.items.map((item) =>
              createElement(
                'div',
                {
                  key: item.clipId,
                  className: 'batch-detach-item',
                  'data-testid': 'batch-detach-item',
                  'data-clip': item.clipId,
                  'data-status': item.status,
                  'data-code': item.code,
                },
                `${item.clipId} · ${item.label}：${item.reason}`,
              ),
            ),
          ),
        ),
    creationMount && project ? createPortal(createElement(CreationLibraryBridge, {
      projectId: project.projectId, hash, playhead, selectedClipIds:selection, layerContent:creationMount.layers,
      onChanged: async (result:LibraryActionResult) => {
        const id = projectIdRef.current;
        if (result.clipId && !selection.includes(result.clipId)) {
          layerAtRef.current = ''; setLayerAt(''); setElementSelection([], false); setLayerError('');
          stageDockRef.current?.setSelection('');
        }
        await refreshRef.current(); await refreshAssets(); await refreshMedia();
        if (id !== projectIdRef.current) return;
        if (result.clipId) { setSelection([result.clipId]); writeTarget(result.clipId, '', 'system'); }
        void loadSubtitles(typeof result.src === 'string' && /\.(?:vtt|srt)$/i.test(result.src) ? result.src : subtitleCandidate);
      },
      onOpenSettings: () => { setSettingsSection('media'); setSettingsOpen(true); },
      onSubtitleStyle: () => setSubtitleStyleOpen(true),
      onAgentPrompt: (text:string) => { setAgentOpen(true); window.setTimeout(() => window.dispatchEvent(new CustomEvent('opencut:agent-insert-prompt',{detail:{projectId:projectIdRef.current,text}})),0); },
      onLargeImport: async (files:File[]) => {
        const id=projectIdRef.current;
        for (const file of files) {
          const res=await fetch(`/api/projects/${encodeURIComponent(id)}/creation-library/upload?name=${encodeURIComponent(file.name)}`,{method:'POST',headers:{'content-type':'application/octet-stream'},body:file});
          const out=await res.json() as LibraryActionResult; if(!res.ok||!out.ok) throw new Error(out.message ?? '大文件导入失败');
        }
      },
    }),creationMount.host) : null,
    noticeBar,
    layerOutline,
    elementFrame,
    elementTextEditor,
    subtitleStyleOpen && project !== null
      ? createElement(SubtitleStylePanel, {
          style: subtitleStyle,
          exists: subtitleStyleExists,
          savedAt: subtitleStyleSavedAt,
          busy: subtitleStyleBusy,
          error: subtitleStyleError,
          onChange: changeSubtitleStyle,
          onPreset: applySubtitlePreset,
          onReset: resetSubtitleStyle,
          onClose: () => setSubtitleStyleOpen(false),
        })
      : null,
    relinkOpen
      ? createElement(RelinkPanel, {
          items: missingItems,
          paths: relinkPaths,
          busy: relinkBusy,
          note: relinkNote,
          batch: relinkBatch,
          canPick: (globalThis as unknown as { opencut?: { transport?: string } }).opencut?.transport === 'electron',
          onPath: (clip: string, value: string) => setRelinkPaths((previous) => ({ ...previous, [clip]: value })),
          onPickFile: (clip: string) => void pickRelinkFile(clip),
          onApply: (clip: string) => void applyRelink(clip, relinkPaths[clip] ?? ''),
          onDir: (dir: string) => setRelinkDir(dir),
          onPickDir: () => void pickRelinkDir(),
          onScan: () => void scanRelinkBatch(),
          onApplyBatch: () => void applyRelinkBatch(),
          onClose: () => setRelinkOpen(false),
        })
      : null,
    exportOpen
      ? createElement(ExportPanel, {
          form: exportForm,
          queue: exportQueue,
          duration,
          busy: exportBusy,
          missing: { count: missingItems.length, clips: missingClips },
          subtitle: { src: subtitleCandidate, file: subtitleFile ?? '', cues: cues.length },
          sequence: sequence ?? { id: 'main', name: 'main' },
          history: exportHistory,
          canReveal: (globalThis as unknown as { opencut?: { transport?: string } }).opencut?.transport === 'electron',
          onChange: (patch: Partial<ExportForm>) => {
            // 人动过表单之后，设置里的「导出默认值」就不再套用（不改已填的表单）。
            exportFormTouchedRef.current = true;
            setExportForm((previous) => ({ ...previous, ...patch }));
          },
          onRangeChange: changeExportRange,
          onRangeAdd: addExportRange,
          onRangeRemove: removeExportRange,
          onRangeMove: moveExportRange,
          onStart: () => void submitExport(),
          onCancel: (id: string) => void cancelExportJob(id),
          onReveal: (path: string) => void revealOutput(path),
          onCopyDetail: (job: ExportJobView) => void copyExportDetail(job),
          onOpenRelink: () => {
            setExportOpen(false);
            openRelink();
          },
          onClearHistory: () => setExportHistory(clearHistory()),
          onClose: () => setExportOpen(false),
        })
      : null,
    createElement(
      'div',
      { className: 'layout' },
      /* R37（B 批 · 批注 1）：四条功能区边界的手柄。**不占布局**（absolute），
         只改容器尺寸；`.layout` 因此需要 `position: relative`（见 styles.css）。 */
      createElement(ZoneHandles, { agentOpen }),
      createElement(
        'main',
        {
          className: 'main',
          'data-zone': 'stage',
          /* R38：画幅的两个数字给 CSS 自己算边框盒（见 styles.css 的 `.preview-frame`）——
             `100cqh * --stage-w / --stage-h` 需要的是**数值**，不是 `16 / 9` 这段文本。 */
          style:
            doc === null
              ? undefined
              : ({
                  '--stage-w': String(doc.stage.w),
                  '--stage-h': String(doc.stage.h),
                } as unknown as CSSProperties),
        },
        missingItems.length > 0
          ? createElement(
              'div',
              {
                className: 'missing-banner',
                'data-testid': 'missing-banner',
                'data-missing-count': String(missingItems.length),
                role: 'status',
              },
              createElement('span', null, `缺 ${missingItems.length} 个文件`),
              createElement(
                'button',
                { type: 'button', className: 'btn tiny', onClick: openRelink },
                '查看并重新定位',
              ),
            )
          : null,
        /* R38（C 批 · 批注 3）：舞台收成**一张播放器卡** —— 卡头是介绍位，
           中间是画面，卡底是中下偏左的走带 + 右下角的参数与比例。
           原来压在轨道上方的那条约 90px 横条（40px transport + 26px 状态行 + 
           hint 行）全部腾空：状态行进了卡头、走带进了卡底、hint 并进卡头与右下参数。
           卡只吃 `.main` 自己的行高，**不向上/向下要空间** —— 首轨 y 因此一位不动（C10）。 */
        createElement(
          'section',
          {
            className: 'stage-card',
            'data-testid': 'stage-card',
            /* R46：卡上这个属性叫 `data-stage-ratio`，**不能叫 `data-ratio`** ——
               `data-ratio` 是四颗比例按钮（`RatioPicker`）的排他命名，判据 C5/C8 与
               MAIN 的复核都用 `querySelectorAll('[data-ratio]')` 数档位。卡也带一个
               `data-ratio="16:9"` 时计数变 5（16:9 重复），「四档」就永远数不对。
               卡这边要的是「当前档」快照，语义不同，名字也该不同。 */
            'data-stage-ratio': doc === null ? '' : (ratioIdOf(doc.stage) ?? 'custom'),
          },
          /* R164 · UI-V3-A（VIEW-01）：卡头的常驻统计横条（工程/序列/分辨率/轨·片段·时长）
             整条撤掉 —— 它与顶栏的工程标签重复，又压在画面左上。四项搬进画面右下角的
             信息按钮（`StageInfo`，点开才显示），testid 全部保留。 */
          createElement('div', { className: 'sc-screen' }, preview, doc === null ? null : createElement(StageInfo, {
            projectName: project?.name ?? '未打开工程',
            sequenceName: sequence?.name ?? 'main',
            stage: { w: doc.stage.w, h: doc.stage.h },
            tracks: doc.tracks.length,
            clips: allClips.length,
            duration,
            metaText: stageMetaText,
          })),
          /* 状态行（`t=` 会随播放头变）**不能压在画面上**：s81 用「有裁剪 / 无裁剪」两张
             截图的差集量裁剪边界，画面里任何会变的像素都会被算成裁剪的墨迹，
             差集包围盒会扩到那一行去（实测 outerDelta.top −219.65）。
             所以它跟走带一起住卡底：那里在舞台矩形之外，不参与像素判据。 */
          /* R102 · U1-R2：卡底只剩走带一条 50px（控条）。状态行走「更多 → 诊断」，
             `stage-status` / `stage-time` 两个 testid 与 `data-*` 全留。 */
          doc === null
            ? null
            : createElement('div', { className: 'sc-foot' }, transport),
        ),
      ),
      /* V02：时间线不再是 `.main` 的 flex 子项 —— 它是 `.layout` 的第 3 行，
         横跨左列 + 画布 + 检查器（`.layout > .timeline-row`，见 styles.css）。
         工程没打开时不渲染这一行，行高 240px 也就不会白占。 */
      doc === null ? null : createElement('div', { className: 'timeline-row', 'data-zone': 'timeline' }, timeline),
      createElement('div', { className: 'stage-dock', ref: setStageDockHost, 'data-testid': 'stage-dock-host', 'data-zone': 'left' }),
      createElement(Inspector, {
        key: JSON.stringify([project?.projectId, sequence?.id]),
        clip: selectedClip,
        onFieldCommit: (field: string, value: unknown) => {
          if (selectedClip === null) return;
          const built = buildFieldOp(selectedClip, field, value, layerAtRef.current);
          if (built.ops.length === 0) {
            setNotice({ kind: 'error', text: built.error ?? '这个字段现在写不了' });
            return;
          }
          /* R112 · L1：数值/文本字段 = 一条精确编辑事务（begin 停播定帧 → 落盘后 commit）。
             取消或失败由 commit 的 `quiet` 分支回原状；成功则停在改完的那一帧，不自动重播。 */
          beginPreciseEdit('number');
          void sendOps(built.ops as EditOp[], `检查器 · ${field}`).then((ok) =>
            commitPreciseEdit(ok, ok ? undefined : 'FIELD_COMMIT_FAILED', true),
          );
        },
        fieldBusy: busy,
        selectedCount: selection.length,
        playhead,
        fps: doc?.fps ?? { num: 30, den: 1 },
        hash,
        mountRef: setInspectorHost,
        layers: layerOptions,
        layerAt,
        onLayer: (at: string) => {
          /* S95：下拉选层 = 进入这一层；片段多选到此为止（收成承载它的片段，
             `pageClipId` 因此不会被「选中的另一个页面片段」偷偷换走）。 */
          selectLayer(at);
        },
        layerError: targetEmptyState?.message ?? layerError,
        emptyReason: targetEmptyState?.code ?? null,
        layerClipId: pageClipId,
        layerLocked,
        onToggleLayerLock: toggleLayerLock,
        audio:
          audioTargets.length === 0
            ? null
            : {
                targets: audioTargets,
                onVolume: editAudioVolume,
                onFade: editAudioFade,
                onMute: toggleAudioMute,
                onReset: resetAudio,
                note: audioNote,
              },
        trackAudio,
        tab: selection.length === 1 ? inspectorTab : 'props',
        objectTab: inspectorObjectTab,
        subtitle: activeCue === null || cueIndex === null || cueDraft === null ? null : {
          index: cueIndex,
          total: cues.length,
          draft: cueDraft,
          error: cueError?.cue === activeCue ? cueError.message : '',
          busy: subtitleBusy,
          dirty: cueDirty,
          textRef: cueTextRef,
          onChange: (patch: Partial<SubtitleDraft>) => {
            setCueDrafts((drafts) => new Map(drafts).set(activeCue, { ...(drafts.get(activeCue) ?? cueDraft), ...patch }));
            setCueError(null);
          },
          onSave: saveCueDraft,
          onReset: () => {
            setCueDrafts((drafts) => {
              const remaining = new Map(drafts);
              remaining.delete(activeCue);
              return remaining;
            });
            setCueError(null);
          },
        },
        hasElement: hasInspectorElement,
        multipleElements: elementSel.length > 1,
        onObjectTab: (tab: InspectorObjectTab) => setInspectorChoice({ target: inspectorTarget, tab }),
        onTab: (next: 'props' | 'motion') => {
          if (next === 'motion' && selection.length !== 1) {
            setNotice({ kind: 'error', text: '先选中一个片段，再切到「动效」' });
            return;
          }
          setInspectorTab(next);
        },
        motionMountRef: setMotionHost,
        motionPresets:
          selectedClip === null
            ? null
            : (() => {
                const entry = (selectedClip.overrides ?? []).find((item) => item.at === layerAt) ?? null;
                const kf = entry !== null && Array.isArray((entry as { kf?: unknown }).kf) ? ((entry as { kf: unknown[] }).kf) : null;
                const time = selectedClip.time;
                const speed = Number(selectedClip.speed ?? 1) || 1;
                const length = Array.isArray(time) && time.length === 2 ? (Number(time[1]) - Number(time[0])) / speed : 0;
                return {
                  clipId: selectedClip.id,
                  at: layerAt,
                  atLabel: layerAt === '' ? '未选元素' : `${selectedClip.id} · ${layerAt}`,
                  clipDuration: Number.isFinite(length) && length > 0 ? length : 0,
                  currentKf: kf,
                  busy,
                  resetToken: motionResetToken,
                  onApply: (next: unknown[]) => applyMotionKf(next, layerAt, selectedClip.id, false),
                  onClear: () => applyMotionKf(null, layerAt, selectedClip.id, true),
                };
              })(),
        motionManage: {
          entries: motionManage,
          showArchived: motionShowArchived,
          name: motionName,
          busy: motionBusy,
          note: motionNote,
          current: motionCurrent,
          onName: (value: string) => setMotionName(value),
          onSave: saveMotionAs,
          onUpgrade: upgradeMotion,
          onRollback: rollbackMotion,
          onArchive: archiveMotion,
          onRefresh: () => motionPanelRef.current?.refresh(),
          onToggleArchived: () => setMotionShowArchived(previous => !previous),
        },
      }),
    ),
  );
}
