/**
 * 工作台视图：顶栏 / 工程列表 / 时间线 / 检查器。
 *
 * 说明：仓库根的 `tsconfig.base.json` 没有 `jsx` 开关（那份配置归大脑，本批不动），
 * 所以组件用 `createElement` 写，不引入 JSX 语法；类型仍然完整（React 19 + TS）。
 */

import { RESOURCE_DRAG_MIME, parseResourceDrag, resourceDropTime } from './creation-drop';
import type { ResourceDrop } from './creation-drop';
import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode, RefObject } from 'react';

import { OBJECT_TABS } from '../../../../layers/inspector-fields.mjs';
import { collectSnapTargets } from '../../../../film-core/ripple.mjs';
import { copyTimelineClips, planTimelineAction } from '../../../../film-core/timeline-actions.mjs';
import { hasClipKeyframes, isClipDisabled, clipMarkersOf, timelineTimeOfClipMarker } from '../../../../film-core/clip-state.mjs';
import { formatCueTime } from '../../../../film-core/subtitle.mjs';
import { subtitleLineStep } from '../../../../film-core/subtitle-layout.mjs';
import { planRangeInputs } from '../../../../film-core/export-range.mjs';
import { parseSizeArg } from '../../../../render/delivery-size.mjs';
import { estimateDeliveryBytes, formatDeliveryEstimate } from '../../../shared/delivery-bytes.mjs';
import { getSubtitlePreset, listSubtitlePresets } from '../../../../layers/subtitle-presets.mjs';
import { parseCssColor } from '../../../../layers/subtitle-style.mjs';
import { mountTimelineGesture } from '../../../../layers/timeline-gesture.mjs';
import { listAppliedTransitions, planRemoveTransitionPreset, planResizeTransitionPreset } from '../../../../film-core/transition-presets.mjs';
import { planTransitionRemove, planTransitionResize } from '../../../../film-core/transition.mjs';
import {
  DEFAULT_VOLUME,
  VOLUME_MAX,
  audioSelection,
  clampFadeEdge,
  clampVolume,
  effectiveFade,
  effectiveVolume,
  fadeLimit,
  formatVolumeDb,
  muteStateOf,
  planFadeOps,
  planMuteOps,
  planResetOps,
  planVolumeOps,
} from '../../../../film-core/audio-edit.mjs';
import { SceneFilmstrip } from './scene-filmstrip';
import { formatRulerLabel, scrubEdgeVelocity, timelineRuler } from '../timeline/ruler.mjs';
import { clipSpan, snapSecondsToFrame } from '../timeline/geometry.mjs';
import { expandLinks, planSelectionMove, planSpeedEdge, planTrim } from '../timeline/plan.mjs';
import { WaveformLayer, WaveformStats, waveformUrlOf } from './waveform-track';
import { RECENT_LIMIT, matchHomeQuery, visibleHomeItems } from './home-projects';
import { GroupedInspector } from './inspector-groups-panel';
import { formatTimecode } from './stage-protocol.mjs';
import { STAGE_RATIOS } from './stage-ratios.mjs';
import {
  DEFAULT_TRACK_HEIGHT,
  TRACK_HEIGHTS,
  TRACK_HEIGHT_LABELS,
  TRACK_HEIGHT_PRESETS,
  clampTrackHeight,
  clipHeightOf,
  defaultHeightFor,
  rowHeight,
  lanesTotalHeight,
  laneTopOf,
  presetOf,
} from './track-height';
import type { AssetItem, Clip, CutPointView, EditOp, ExportHistoryItem, ExportJobView, FilmDoc, MediaStatusItem, MotionManageEntry, ProjectListItem, RecentProjectItem, SubtitleCue, SubtitleStyleFields, Track, TransitionView } from './types';
import { MotionPresets } from './motion-presets';
import type { MotionPresetsProps } from './motion-presets';
import { Filmstrip } from './filmstrip';
import { editorIcon } from './editor-icons';
import { TimelineMenu } from './timeline-menu';
import type { TimelineMenuGroups, TimelineMenuTarget } from './timeline-menu';
import { EditorTooltip } from './editor-tooltip';

const h = createElement;

/** 轨道头宽度（与 styles.css 的 --head-w 一致）。M38：放得下四个开关 + 名字 + 高度菜单。 */
export const HEAD_W = 132;

/**
 * 时间线缩放档位（M47）：**只改视图**（不写 film.html、不进 /ops/撤销栈）。
 *
 * `100%` = `DEFAULT_PPS` = 64px/s（M1 起的常量）。档位用按钮而不是滑杆：
 * 触摸下拖滑杆很难精确停在某一档，而且 6 个离散值本来就不需要连续调节。
 * 捏合可以落在档位之间（引擎给的是连续倍率），此时百分比照实显示、按钮跳到相邻档。
 */
export const PPS_STEPS: ReadonlyArray<number> = Object.freeze([16, 32, 64, 128, 256, 512]);
export const DEFAULT_PPS = 64;

/**
 * 波形占片段高度的比例（任务书要求 28–36%）。
 *
 * **别随手调这个数**：波形柱高按 RMS 画、并在最小可见柱处量化，改 1px 画布高度就会
 * 改变「安静段/响亮段」的**比值**——实测 11px 时 early/late = 2/5，12px 时变成 2/4，
 * M34 的 `late > early * 2.5` 直接翻脸。留在 33%（标准档 11px）。
 */
const WAVE_RATIO = 0.33;

/** @param {number} value @param {number} [digits] */
export function num(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return '—';
  const text = value.toFixed(digits);
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/** @param {Clip} clip */
export function clipLength(clip: Clip): number {
  return clipSpan(clip).length;
}

/** @param {Clip} clip */
function kindOf(clip: Clip): string {
  return clip.kind ?? 'video';
}

/**
 * E08（R19）：这条轨**会不会出声** —— 决定轨头给不给「喇叭 + S」。
 *
 * 参照（0.3.2）的键义：轨级 `muteSoundTrack` = "Mute track"、`solo` = "Solo: hear this
 * track alone"；两者对**不出声的轨**没有意义（网页 / 图片 / 文本轨拖不发声）。
 * 判定口径（只读文档，不探媒体文件）：
 *   1. `kind === 'sound'` → 有声（音频文件；`<audio src="x.mp4">` 是该视频的原声，解析时
 *      已经落成 `kind:'sound'` + `sound:true`）；
 *   2. `kind === 'video'` 且片段自己没写 `muted` → 有声（视频默认带原声）；
 *   3. 其余（`page`/`image`/空轨）→ 无声。
 * 注意：这是**文档级**判断，不是 ffprobe —— 视频文件的容器里到底有没有音轨，前端同步读不到；
 * 拿不准的轨在交接里逐行列出来（轨名 / 类型 / 判定 / 图标数）。
 * @param {{ clips: Clip[], role?: string }} track
 */
function trackHasSound(track: { clips: Clip[]; role?: string }): boolean {
  return (track.clips ?? []).some((clip) => {
    const kind = kindOf(clip);
    if (kind === 'sound') return true;
    if (kind === 'video') return clip.muted !== true;
    return false;
  });
}

/**
 * 片段里的第二行（E03 / R17 起只剩「附加项」）。
 * 起点与时长挪进了上沿那条胶囊（参照是 `scene-a 4.0s` 一条），这里不再重复，
 * 只留音量/变速/静音这些没有别处可看的。全空时返回 ''，调用方不渲染这一行。
 * @param {Clip} clip
 */
function metaOf(clip: Clip): string {
  const parts: string[] = [];
  if (typeof clip.volume === 'number') parts.push(`vol ${num(clip.volume)}`);
  if (clip.speed !== undefined && clip.speed !== 1) parts.push(`${num(clip.speed)}x`);
  if (clip.muted === true) parts.push('muted');
  return parts.join(' · ');
}

/** 胶囊里的时长段：参照写 `4.0s`，固定一位小数，别一会儿 `4s` 一会儿 `4.25s`。 */
function clipDurationLabel(clip: Clip): string {
  return `${clipLength(clip).toFixed(1)}s`;
}

/**
 * 轨头动作使用同一授权图标族；只改变呈现，不更改开关及历史语义。
 * 锁定、显隐和静音按当前状态绘制，S 为独奏。
 * @param {'muted'|'hidden'|'locked'|'solo'} field
 */
function flagIcon(field: 'muted' | 'hidden' | 'locked' | 'solo', on = false): ReactNode {
  if (field === 'hidden') return editorIcon(on ? 'eye-off' : 'eye', 12);
  if (field === 'locked') return editorIcon(on ? 'lock' : 'unlock', 12);
  if (field === 'muted') return editorIcon(on ? 'volume-off' : 'volume', 12);
  return h('span', { className: 'tl-solo-letter', 'aria-hidden': true }, 'S');
}

function timelineToolGlyph(
  name:
    | 'pointer'
    | 'select'
    | 'blade'
    | 'snap'
    | 'zoom-out'
    | 'zoom-in'
    | 'fit'
    | 'search'
    | 'frame-prev'
    | 'frame-next'
    | 'split'
    | 'delete'
    | 'ripple'
    | 'grid'
    | 'settings',
): ReactNode {
  if (name === 'blade' || name === 'select') {
    const path = name === 'blade'
      ? 'M3 16.5 14.5 5h5.7v5.7L8.7 22H3z M8.4 15.6l5.7-5.7 M15.7 6.5l3 3'
      : 'M8 4H4v4 M10.5 4h3 M16 4h4v4 M20 10.5v3 M20 16v4h-4 M13.5 20h-3 M8 20H4v-4 M4 13.5v-3';
    return h('svg', { width: 17, height: 17, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
      focusable: false, 'aria-hidden': true }, h('path', { d: path }));
  }
  const names = {
    pointer: 'pointer', snap: 'magnet', 'zoom-out': 'zoom-out', 'zoom-in': 'zoom-in',
    fit: 'fit', search: 'search', 'frame-prev': 'prev-frame', 'frame-next': 'next-frame',
    split: 'cut', delete: 'trash', ripple: 'ripple', grid: 'grid', settings: 'settings',
  } as const;
  return editorIcon(names[name], 17);
}

/**
 * 顶栏右端那三颗图标（R37 · 批次 A）。与工具条同一套笔画，只是画布 16×16
 * —— 顶栏按钮 26×26，14px 图标在里面偏小。
 * @param {'settings'|'export'|'layout'} name
 */
function chromeGlyph(name: 'settings' | 'export' | 'layout' | 'undo' | 'redo' | 'agent' | 'more' | 'versions' | 'motion' | 'batch' | 'refresh' | 'project'): ReactNode {
  return editorIcon(name, 17);
}

export interface TopBarProps {
  projectName: string;
  hash: string;
  transport: string;
  health: string;
  socket: 'connecting' | 'open' | 'closed';
  busy: boolean;
  undoDepth: number;
  redoDepth: number;
  onUndo: () => void;
  onRedo: () => void;
  onRefresh: () => void;
  onProjectHome?: () => void;
  moreMenuOpen: boolean;
  onToggleMoreMenu: () => void;
  onCloseMoreMenu: () => void;
  /** 打开导出面板（M17）—— R37 起是右端那颗图标按钮。 */
  onExport: () => void;
  /** 导出队列角标（M29）：面板关着也能看见还有几个在等/在跑。 */
  exportBadge?: { running: boolean; queued: number };
  /** 打开版本历史（S75 · WP09）：命名版本的列表/创建/对比/恢复。 */
  onVersions: () => void;
  /** 切到检查器「动效」页签（M27/M30 的入口；S85 起顶栏按钮只负责切页签，不再开第二套面板）。 */
  onMotion: () => void;
  /** 打开设置中心（M49）—— R37 起是右端那颗齿轮。 */
  onSettings: () => void;
  /** 打开 Agent 原创场景面板（WP21 · S70）。 */
  onAgent: () => void;
  /** 多选批量分离音频（S72 · NEW-01）：count = 当前选中片段数。 */
  batchDetach: { count: number; busy: boolean };
  onBatchDetach: () => void;
  /** 多序列切换器（S73）：工程名右边的槽位，组件自己管取数与状态。 */
  sequenceSlot?: ReactNode;
  /**
   * R102 · U1-R2：舞台状态行（`stage-status` / `stage-time`）。
   *
   * 它原来住播放器卡底（97px 那段）。R2 把卡底压到 **50**（控条一条），
   * 18px 的状态行没地方了；而它**不能**放回画面（`t=` 每帧都变，s81 拿两张截图的差集
   * 量裁剪边界，会把那一行算成墨迹），所以搬进「更多 → 诊断」——
   * 与 hash / 健康 / 通道同族，读它的人也确实是排障与量化脚本。
   * `data-testid` 一个没改，`textContent` 照常可读（隐藏只影响点击，不影响读文本）。
   */
  statusSlot?: ReactNode;
  /**
   * R102 · U1-R2：工程标签条（Electron 多工程时是 `TabBar`，Web 里是 null）。
   *
   * 补正书要求「工程标签紧跟 C 图标右侧**同一层**（`C | 工程标签1 × | 工程标签2 ×`）」。
   * 所以标签条不再是顶栏上面独立的一条 36px 横带 —— 它由 App 传进来，渲染在 C 与
   * 单个工程标签之间；没有标签时（浏览器单工程）只剩那一个标签。
   */
  tabsSlot?: ReactNode;
  /**
   * R34（R31-093 B）：工程块搬进顶栏。
   *
   * 抽屉模式下 `.sidebar` 是 `display:none`（`:has` 规则），工程切换只剩这一条路。
   * 名字本身就是按钮（「Studio p ▾」），下拉里是原来的 ProjectList —— **testid 一个没改**，
   * 所以量具只是从「左列直接点」变成「先开菜单再点」。
   */
  projectMenu: ReactNode;
  projectMenuOpen: boolean;
  onToggleProjectMenu: () => void;
  /**
   * R37（批次 A · 批注 2）：布局菜单。
   *
   * 只有「默认布局」一项 + 「复位」——**留接口**，不做多套布局：分栏可拖是批次 B
   * （主线）的地盘，本批先把入口和菜单形状立起来。
   */
  layoutMenuOpen: boolean;
  onToggleLayoutMenu: () => void;
  onLayoutDefault: () => void;
  onLayoutReset: () => void;
}

/** Original history callbacks, presented beside the timeline editing tools. */
export function HistoryActions(props: Pick<TopBarProps, 'busy' | 'undoDepth' | 'redoDepth' | 'onUndo' | 'onRedo'>): ReactNode {
  return h('span', { className: 'editor-history-actions', role: 'group', 'aria-label': '编辑历史' },
    h('button', { className: 'btn icon', type: 'button', onClick: props.onUndo, disabled: props.busy || props.undoDepth === 0, 'data-editor-hint': props.undoDepth > 0 ? `撤销上一步（${String(props.undoDepth)} 步可撤）` : '撤销上一步', 'aria-label': '撤销上一步', 'data-testid': 'undo', 'data-depth': String(props.undoDepth) }, chromeGlyph('undo')),
    h('button', { className: 'btn icon', type: 'button', onClick: props.onRedo, disabled: props.busy || props.redoDepth === 0, 'data-editor-hint': props.redoDepth > 0 ? `重做（${String(props.redoDepth)} 步可重做）` : '重做', 'aria-label': '重做', 'data-testid': 'redo', 'data-depth': String(props.redoDepth) }, chromeGlyph('redo')),
  );
}

export function TopBar(props: TopBarProps): ReactNode {
  const socketLabel = props.socket === 'open' ? '事件已连接' : props.socket === 'connecting' ? '事件连接中' : '事件断开';
  const socketClass = props.socket === 'open' ? 'dot ok' : props.socket === 'connecting' ? 'dot warn' : 'dot down';
  const { moreMenuOpen, onCloseMoreMenu } = props;
  const moreRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!moreMenuOpen) return;
    const closeOutside = (event: Event): void => {
      if (event.target instanceof Node && !moreRef.current?.contains(event.target)) onCloseMoreMenu();
    };
    const childDialogOpen = (): boolean => Boolean(moreRef.current?.querySelector('.modal-backdrop'));
    const onWindowBlur = (): void => {
      const focused = document.activeElement;
      if (childDialogOpen() || (focused instanceof HTMLSelectElement && moreRef.current?.contains(focused))) return;
      onCloseMoreMenu();
    };
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || childDialogOpen() || event.target instanceof HTMLSelectElement) return;
      // Consume Escape here so it does not also close the chat or clear the selection.
      event.preventDefault();
      event.stopPropagation();
      onCloseMoreMenu();
      moreButtonRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', closeOutside, true);
    document.addEventListener('focusin', closeOutside);
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('keydown', onEscape, true);
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true);
      document.removeEventListener('focusin', closeOutside);
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('keydown', onEscape, true);
    };
  }, [moreMenuOpen, onCloseMoreMenu]);
  /* 保存态：这个编辑器是「一步一写盘」（每次 /ops 都落 film.html），所以没有「未保存」这个概念，
     能说的是「写完了没有」。busy = 有请求在飞；socket 断了就说不准 → 显示离线。 */
  const saveText = props.busy ? '写入中…' : props.socket === 'open' ? '已同步' : '离线';
  const saveTitle = props.busy
    ? '正在写入工程（/ops 进行中）'
    : props.socket === 'open'
      ? '每一步编辑都已经写进 film.html（无「未保存」概念）'
      : '事件通道断开，写盘状态无法确认';
  return h(
    'header',
    { className: 'topbar' },
    h(EditorTooltip),
    h(
      props.onProjectHome === undefined ? 'div' : 'button',
      props.onProjectHome === undefined
        ? { className: 'brand', 'aria-label': 'MotionCut' }
        : { className: 'brand project-home-link', type: 'button', 'aria-label': '项目首页',
            'data-testid': 'project-home-link', 'data-editor-hint': '返回项目首页', onClick: props.onProjectHome },
      h('span', {
        className: 'brand-logo',
        'aria-hidden': true,
        'data-testid': 'brand-logo',
      }, editorIcon('media-library', 23)),
    ),
    h(
      'div',
      { className: 'topbar-project' },
      /* **R102 · U1-R2：工程标签紧跟 C 图标、同一层**（`C | 工程标签 ×`）。
         它不再是「下拉按钮」——工程切换/最近/导入素材/打包 全部移到右侧那颗
         「项目」图标（`data-testid="project-menu"`，菜单从它右对齐展开）。
         名字只留这一份：卡头里那份 `player-project` 是**播放器卡自己的标题**（s195 C2 读它），
         窗口标题是壳的，两者都不算「顶栏重复铺」。
         标签保留 `project-name` 这个 testid（s79/s84 按它读工程名）。 */
      props.tabsSlot ?? null,
      h(
        'div',
        {
          className: 'project-tab',
          'data-testid': 'project-tab',
          /* R164 · UI-V3-A（TOP-02）：有标签条时，活动标签已经显示同一个工程名，
             这一块就是**同一区的第二份**。隐藏（视觉收成 1px，保留无障碍名与 testid），
             没有标签条（浏览器单工程）时照旧显示 —— 那时它是唯一的一份。 */
          'data-redundant': props.tabsSlot == null ? 'false' : 'true',
          'data-open': props.projectName === '' ? 'false' : 'true',
          title: props.projectName === '' ? '未打开工程 —— 用右侧「项目」打开或新建' : props.projectName,
        },
        h('strong', { 'data-testid': 'project-name' }, props.projectName || '未打开工程'),
      ),
      /* U01：hash 不再挂在主行（它读的人只有量化脚本），收进「更多 → 诊断」。
         这里换成一个**人要看**的保存态：一步一写盘，所以只有「写入中 / 已同步 / 离线」三种。 */
      props.busy || props.socket !== 'open'
        ? h('span', { className: 'topbar-alert', role: 'status', 'aria-label': saveText, title: saveTitle }, editorIcon(props.busy ? 'refresh' : 'unlink', 14))
        : null,
    ),
    h('div', { className: 'window-drag-region', 'data-testid': 'window-drag-region', 'aria-hidden': true }),
    h(
      'div',
      { className: 'topbar-actions' },
      /* U01：主行不再放状态串（协议 / 健康 / hash 全进「更多 → 诊断」）。
         撤销 / 重做 / Agent 图标化：三颗都是高频动作，中文标签是主行宽度的大头；
         `undo` / `redo` / `agent-open` 三个 testid 原位保留（量具按 id 找，不按文字）。 */
      h('button', { className: 'btn icon topbar-agent-action', type: 'button', onClick: props.onAgent, 'data-testid': 'agent-open', 'data-editor-hint': '打开剪辑助手，生成场景或编辑片段', 'aria-label': 'Agent助手' }, chromeGlyph('agent'), h('span', { className: 'editor-action-label' }, 'Agent助手')),
      /* —— U01：「更多 ⋯」——
         版本 / 动效 / 批量分离音频 / 刷新 四件低频动作 + 诊断串收进一个菜单。
         为什么不各留一颗中文按钮：这四件在 1280 下要占 ~380px，是主行最宽的一段噪声；
         为什么不新建面板：它们各自已有落地页（版本面板 / 检查器动效页签 / 时间线批量 / 刷新），
         这里只是**入口收拢**。四个 testid 原样保留，命令与快捷键一个没动。 */
      h(
        'div',
        { className: 'topbar-more', ref: moreRef },
        h(
          'button',
          {
            className: 'btn icon',
            type: 'button',
            ref: moreButtonRef,
            'data-testid': 'topbar-more',
            'aria-haspopup': 'true',
            'aria-expanded': moreMenuOpen,
            'data-editor-hint': '更多：序列、动效、刷新与诊断',
            'aria-label': '更多',
            onClick: props.onToggleMoreMenu,
          },
          chromeGlyph('more'),
        ),
        h(
          'div',
          { className: 'topbar-more-panel', 'data-testid': 'topbar-more-panel', role: 'menu', 'aria-label': '更多', hidden: !moreMenuOpen },
          h('div', { className: 'topbar-document-controls' },
            h('span', { className: 'topbar-diag-title' }, '时间线'),
            props.sequenceSlot ?? null,
            h('span', { className: 'save-state', 'data-testid': 'save-state', 'data-busy': props.busy ? '1' : '0', title: saveTitle },
              h('span', { className: props.busy ? 'dot warn' : props.socket === 'open' ? 'dot ok' : 'dot down' }),
              h('span', { className: 'save-state-text' }, saveText)),
          ),
          /* R102 · U1-R2：版本历史已提到主行右侧（`version-open` 现在在 `.topbar-globals` 里），
             这里不再重复一份 —— 同名 testid 两颗会让 Playwright strict mode 直接炸。 */
          h(
            'button',
            {
              className: 'btn topbar-mi',
              type: 'button',
              role: 'menuitem',
              'data-testid': 'motion-open',
              disabled: props.projectName === '',
              title: '动效：切到检查器「动效」页签（模板列表 / 应用 / 另存 / 升级 / 回退 / 归档）',
              onClick: () => { onCloseMoreMenu(); props.onMotion(); },
            },
            chromeGlyph('motion'),
            h('span', { className: 'topbar-mi-label' }, '动效'),
          ),
          h(
            'button',
            {
              className: 'btn topbar-mi',
              type: 'button',
              role: 'menuitem',
              'data-testid': 'batch-detach',
              'data-count': String(props.batchDetach.count),
              'data-busy': props.batchDetach.busy ? 'true' : 'false',
              disabled: props.busy || props.batchDetach.busy || props.batchDetach.count < 2,
              title:
                props.batchDetach.count < 2
                  ? '批量分离音频：先选中 2 个以上片段（每个有音轨的视频各插一条音频，一次提交、一步撤销）'
                  : `批量分离音频：${String(props.batchDetach.count)} 个片段里每个有音轨的视频各插一条音频，合并成一次 /ops`,
              onClick: () => { onCloseMoreMenu(); props.onBatchDetach(); },
            },
            chromeGlyph('batch'),
            h('span', { className: 'topbar-mi-label' }, props.batchDetach.count >= 2 ? `批量分离音频（${String(props.batchDetach.count)}）` : '批量分离音频'),
          ),
          h(
            'button',
            {
              className: 'btn topbar-mi',
              type: 'button',
              role: 'menuitem',
              'data-testid': 'refresh',
              disabled: props.busy,
              title: '刷新工程状态',
              'aria-label': '刷新工程状态',
              onClick: () => { onCloseMoreMenu(); props.onRefresh(); },
            },
            chromeGlyph('refresh'),
            h('span', { className: 'topbar-mi-label' }, '刷新工程状态'),
          ),
          /* —— 诊断：hash / 健康 / 事件通道 / transport ——
             读的人只有量化脚本与排障，主行一颗都不留。`doc-hash` / `health` 两个 testid 仍在，
             量具按 textContent 读（隐藏不影响读文本，只影响点击）。 */
          h('div', { className: 'topbar-more-sep' }),
          h(
            'div',
            { className: 'topbar-diag', 'data-testid': 'topbar-diag' },
            h('span', { className: 'topbar-diag-title' }, '诊断'),
            /* 舞台状态行（U1-R2 从卡底搬来）：就绪态 + content origin + `t=` + 交付画幅提示。 */
            props.statusSlot === undefined ? null : h('div', { className: 'topbar-diag-row' }, props.statusSlot),
            props.hash === ''
              ? null
              : h('div', { className: 'topbar-diag-row' }, h('span', null, 'doc'), h('code', { 'data-testid': 'doc-hash' }, props.hash.slice(0, 8))),
            h('div', { className: 'topbar-diag-row' }, h('span', null, '健康'), h('span', { 'data-testid': 'health', title: props.health }, props.health)),
            h('div', { className: 'topbar-diag-row' }, h('span', null, '通道'), h('span', { className: socketClass }), h('span', { 'data-testid': 'socket-state' }, socketLabel)),
            h('div', { className: 'topbar-diag-row' }, h('span', null, 'transport'), h('code', null, props.transport)),
          ),
        ),
      ),
      /* —— R102 · U1-R2：右侧「全局动作」只剩四件 —— 项目 / 版本 / 设置 / 导出。
         原来的设置 / 导出两颗位置不动，只是现在归在 `.topbar-globals` 这一组里，
         与左边那簇「文档动作」（撤销 / 重做 / Agent / 布局 / 更多）用 `margin-left:auto`
         拉开距离。四件的 testid 一个没改（`project-menu` 从工程标签上移到这里，
         `version-open` 从「更多」菜单提到主行）。 */
      h(
        'div',
        { className: 'topbar-pop' },
        h(
          'button',
          {
            className: `btn icon${props.layoutMenuOpen ? ' active' : ''}`,
            type: 'button',
            'data-testid': 'layout-menu',
            'data-open': props.layoutMenuOpen ? 'true' : 'false',
            'aria-haspopup': 'menu',
            'aria-expanded': props.layoutMenuOpen ? 'true' : 'false',
            'aria-label': '布局',
            'data-editor-hint': '布局：恢复默认分栏与轨道尺寸',
            onClick: props.onToggleLayoutMenu,
          },
          chromeGlyph('layout'),
        ),
        /* **条件渲染**，不是 `hidden` 收起：这条菜单里没有草稿态（两颗按钮而已），
           而 DOM 里常驻一个 `role="menu"` 会把 s188 的「菜单数」量具顶掉 ——
           它是按全页 `[role="menu"]` 计数的，E09 的 `+` 菜单判「0→1」就不成立了。
           收起时干脆不渲染，语义与计数都干净。 */
        props.layoutMenuOpen
          ? h(
              'div',
              {
                className: 'topbar-menu layout-menu',
                'data-testid': 'layout-menu-panel',
                role: 'menu',
                'aria-label': '布局',
              },
              h(
                'button',
                {
                  type: 'button',
                  role: 'menuitemradio',
                  'aria-checked': 'true',
                  className: 'menu-item active',
                  'data-testid': 'layout-default',
                  onClick: props.onLayoutDefault,
                },
                '默认布局',
              ),
              h(
                'button',
                {
                  type: 'button',
                  role: 'menuitem',
                  className: 'menu-item',
                  'data-testid': 'layout-reset',
                  title: '把轨道高度与缩放复位到默认（分栏宽度由批次 B 接管后也归这里）',
                  onClick: props.onLayoutReset,
                },
                '复位',
              ),
            )
          : null,
      ),
      /* —— 全局动作：项目 · 版本 · 设置 · 导出（补正书 §2「右侧只留这四件」） ——
         `margin-left:auto` 把这一组推到最右，与左边的文档动作簇分开。 */
      h(
        'div',
        { className: 'topbar-globals' },
        h(
          'div',
          { className: 'topbar-pop' },
          h(
            'button',
            {
              className: 'btn icon',
              type: 'button',
              'data-testid': 'project-menu',
              'data-open': props.projectMenuOpen ? 'true' : 'false',
              'aria-haspopup': 'true',
              'aria-expanded': props.projectMenuOpen ? 'true' : 'false',
              'aria-label': '工程管理',
              'data-editor-hint': '打开、切换或打包工程',
              onClick: props.onToggleProjectMenu,
            },
            chromeGlyph('project'),
          ),
          /* 一直挂在 DOM 里（`hidden` 收起），不是条件渲染：ProjectList 自己有草稿态
             （导入包的手输路径），重建会把用户写了一半的路径清掉。 */
          h(
            'div',
            {
              className: 'topbar-menu topbar-menu-right',
              'data-testid': 'project-menu-panel',
              role: 'group',
              'aria-label': '工程',
              hidden: !props.projectMenuOpen,
            },
            props.projectMenu,
          ),
        ),
        h(
          'button',
          {
            className: 'btn icon',
            type: 'button',
            onClick: props.onVersions,
            disabled: props.projectName === '',
            'data-testid': 'version-open',
            'aria-label': '编辑记录',
            'data-editor-hint': '版本历史：保存、对比或恢复工程版本',
          },
          chromeGlyph('versions'),
        ),
        h(
          'button',
          {
            className: 'btn icon',
            type: 'button',
            onClick: props.onSettings,
            'data-testid': 'topbar-settings',
            'aria-label': '偏好设置',
            'data-editor-hint': '偏好设置：播放、导出、存储与快捷键',
          },
          chromeGlyph('settings'),
        ),
        h(
          'button',
          {
            className: 'btn icon primary editor-export-action',
            type: 'button',
            onClick: props.onExport,
            disabled: props.projectName === '',
            'data-testid': 'topbar-export',
            'aria-label': '导出',
            'data-editor-hint': '导出成片，选择范围与编码格式',
          },
          chromeGlyph('export'),
          h('span', { className: 'editor-action-label' }, '导出'),
        ),
      ),
      (props.exportBadge?.running === true || (props.exportBadge?.queued ?? 0) > 0)
        ? h(
            'button',
            {
              type: 'button',
              className: 'btn export-badge',
              'data-testid': 'export-badge',
              'data-running': props.exportBadge?.running === true ? 'true' : 'false',
              'data-queued': String(props.exportBadge?.queued ?? 0),
              title: '导出队列：点开看进度 / 取消',
              onClick: props.onExport,
            },
            props.exportBadge?.running === true ? '导出中' : '排队中',
            (props.exportBadge?.queued ?? 0) > 0 ? ` +${String(props.exportBadge?.queued)}` : '',
          )
        : null,

    ),
  );
}

export interface ProjectListProps {
  projects: ProjectListItem[];
  activeId: string;
  loading: boolean;
  error: string;
  onOpen: (item: ProjectListItem) => void;
  /** 导入素材（M18）：Electron 走系统对话框，浏览器走 <input type=file>。 */
  onImport: () => void;
  importing: boolean;
  /** 素材库（M20）：当前工程的 assets/ 清单。 */
  assets?: AssetItem[];
  assetsLoading?: boolean;
  assetsError?: string;
  /** 缩略图 URL（音频没有缩略图，不请求）。 */
  assetThumb?: (asset: AssetItem) => string;
  /** 点素材 → 在播放头插入（不复制文件）。 */
  onInsertAsset?: (asset: AssetItem) => void;
  /** 缺失素材条数（M26）：>0 时素材库顶部亮红角标，点开重链面板。 */
  missingCount?: number;
  onOpenRelink?: () => void;
  /** 最近工程（M56）：来自 `GET /api/projects` 的 `recent`，跨会话。 */
  recent?: RecentProjectItem[];
  /** 索引坏了（服务端已备份原文件）：提示一行，不阻断列表。 */
  recentCorrupt?: boolean;
  onOpenRecent?: (item: RecentProjectItem) => void;
  /** 从「最近」移除一条（只改索引，不删磁盘）。 */
  onRemoveRecent?: (item: RecentProjectItem) => void;
  /** 导出工程包（M59）：只有**已打开**的工程能打包（服务端 `/archive` 只认已打开的）。 */
  onArchive?: () => void;
  archiving?: boolean;
  /** 导入工程包（M59）：Electron 直接走系统打开框，浏览器退回「粘贴绝对路径」。 */
  onImportArchive?: () => void;
  importingArchive?: boolean;
  /** 浏览器兜底：没有系统文件框时，展开路径输入行（桌面版永远为 false）。 */
  archivePathOpen?: boolean;
  onSubmitArchivePath?: (zipPath: string) => void;
  onCancelArchivePath?: () => void;
}

/**
 * 相对时间（M56）：`openedAt` → “3 分钟前”。
 * 只做列表展示，不参与任何判据。
 * @param {string} iso
 */
function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return '刚刚';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(t).toLocaleDateString('zh-CN');
}

/** 人类可读的字节数。 @param {number} bytes */
function bytesText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 素材副标题：时长/尺寸 + 大小。 @param {AssetItem} asset */
function assetMeta(asset: AssetItem): string {
  const parts: string[] = [];
  if (asset.kind === 'still') parts.push('静帧');
  else if (asset.durationSec !== null) parts.push(`${num(asset.durationSec, 2)}s`);
  if (asset.width !== null && asset.height !== null) parts.push(`${asset.width}×${asset.height}`);
  parts.push(bytesText(asset.bytes));
  return parts.join(' · ');
}

export function ProjectList(props: ProjectListProps): ReactNode {
  // 只在「浏览器兜底」那条路上用得到：手输的绝对路径是草稿，提交后由 App 清空。
  const [draftPath, setDraftPath] = useState('');
  /* U08：最近工程的搜索串。**只过滤展示** —— 不改 props.recent，也不动索引。 */
  const [recentQuery, setRecentQuery] = useState('');
  /* U08：测试残留过滤（规则在 home-projects.ts 一处）。
     `recent` 与 `projects` 读同一条规则，但用法不同：
     最近要「搜索 + 上限 20」，工程列表只过滤、不分页（分页会把真实工程也藏掉）。 */
  const recentRaw = props.recent ?? [];
  const recentKept = visibleHomeItems(recentRaw, 0);
  const recentMatched = matchHomeQuery(recentKept.shown, recentQuery);
  const recentShown = recentMatched.slice(0, RECENT_LIMIT);
  const recentOverflow = Math.max(0, recentMatched.length - recentShown.length);
  const projectsSeen = visibleHomeItems(props.projects, 0);
  const projectsShown = projectsSeen.shown;
  return h(
    'aside',
    { className: 'sidebar' },
    h(
      'div',
      { className: 'sidebar-head' },
      h('span', null, '工程'),
      /* U08：计数跟着**可见**条数走。藏了测试残留时另给一颗角标说明，避免「数字变小了但不知道为什么」。 */
      h('span', { className: 'chip', 'data-testid': 'project-count', title: projectsSeen.hidden > 0 ? `已隐藏 ${String(projectsSeen.hidden)} 个测试工程` : undefined }, String(projectsShown.length)),
      projectsSeen.hidden > 0
        ? h('span', { className: 'chip', 'data-testid': 'project-hidden-count', title: '路径含 .local-runs / .tmp / integration 的测试工程；不改磁盘，只隐藏' }, `藏 ${String(projectsSeen.hidden)}`)
        : null,
      h(
        'button',
        {
          type: 'button',
          className: 'btn tiny',
          'data-testid': 'import-media',
          title: '把本地视频/音频/图片复制进 assets/ 并插入时间线',
          disabled: props.importing || props.activeId === '',
          onClick: props.onImport,
        },
        props.importing ? '导入中…' : '导入素材',
      ),
    ),
    h(
      'div',
      { className: 'sidebar-actions', 'data-testid': 'archive-actions' },
      /* R41（R31-100 A）：文案从「导出包」改成「打包工程」。
         理由：右上那颗 `topbar-export` 叫「导出」（成片 mp4），两个「导出」并排会被读成同一件事。
         这里做的是**把工程打成一个 zip**（film.html + assets/，不含 history），
         是工程级的搬运，不是成片交付 —— 「打包」比「导出」准确，也和进行态「打包中…」一致。
         testid `archive-export` 不变（m59 / s187 / m58 按 id 找，不看文字）。 */
      h(
        'button',
        {
          type: 'button',
          className: 'btn tiny',
          'data-testid': 'archive-export',
          title: props.activeId === '' ? '先打开一个工程，才能打包' : '把 film.html 与 assets/ 打成一个 zip（工程包，不含撤销快照）',
          disabled: props.activeId === '' || props.archiving === true,
          onClick: props.onArchive,
        },
        props.archiving === true ? '打包中…' : '打包工程',
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'btn tiny',
          'data-testid': 'archive-import',
          title: '从 zip 恢复一个工程：解到 projects 根，重名自动追加 -2',
          disabled: props.importingArchive === true,
          onClick: props.onImportArchive,
        },
        props.importingArchive === true ? '导入中…' : '导入包',
      ),
    ),
    props.archivePathOpen === true
      ? h(
          'form',
          {
            className: 'archive-path',
            'data-testid': 'archive-path-form',
            onSubmit: (event: { preventDefault: () => void }) => {
              event.preventDefault();
              const value = draftPath.trim();
              if (value !== '') props.onSubmitArchivePath?.(value);
            },
          },
          h('input', {
            className: 'archive-path-input',
            'data-testid': 'archive-path-input',
            placeholder: '/绝对路径/工程包.zip',
            value: draftPath,
            spellCheck: false,
            onChange: (event: { target: { value: string } }) => setDraftPath(event.target.value),
          }),
          h('button', { type: 'submit', className: 'btn tiny', 'data-testid': 'archive-path-submit' }, '确定'),
          h(
            'button',
            {
              type: 'button',
              className: 'btn tiny',
              'data-testid': 'archive-path-cancel',
              onClick: () => {
                setDraftPath('');
                props.onCancelArchivePath?.();
              },
            },
            '取消',
          ),
          h(
            'span',
            { className: 'archive-path-hint' },
            '浏览器没有系统文件框：粘贴 .zip 的绝对路径',
          ),
        )
      : null,
    recentRaw.length > 0
      ? h(
          'div',
          { className: 'recent-projects', 'data-testid': 'recent-projects' },
          h(
            'div',
            { className: 'recent-head' },
            h('span', null, '最近'),
            /* U08：计数 = 当前**可见且命中搜索**的条数（不再是索引里的原始条数）。 */
            h('span', { className: 'chip', 'data-testid': 'recent-count' }, String(recentMatched.length)),
            recentKept.hidden > 0
              ? h(
                  'span',
                  { className: 'chip', 'data-testid': 'recent-hidden-count', title: '路径含 .local-runs / .tmp / integration 的测试工程；只隐藏，不删索引' },
                  `藏 ${String(recentKept.hidden)}`,
                )
              : null,
            props.recentCorrupt === true
              ? h('span', { className: 'chip danger', title: '索引已损坏，原文件已备份为 projects.json.bak-*' }, '索引异常')
              : null,
          ),
          /* U08：搜索（工程名或路径，大小写不敏感）。只在「有可见条目」时出现 ——
             全被过滤掉时，搜索框没有可搜的东西，空态文案更重要。 */
          recentKept.shown.length > 0
            ? h(
                'div',
                { className: 'recent-search-row' },
                h('input', {
                  className: 'recent-search',
                  type: 'search',
                  'data-testid': 'recent-search',
                  'aria-label': '搜索最近工程',
                  placeholder: '搜索工程名或路径',
                  value: recentQuery,
                  onChange: (event: { target: { value: string } }) => setRecentQuery(event.target.value),
                  onKeyDown: (event: { key: string }) => {
                    if (event.key === 'Escape') setRecentQuery('');
                  },
                }),
                recentQuery.trim() === ''
                  ? null
                  : h(
                      'button',
                      {
                        type: 'button',
                        className: 'btn tiny',
                        'data-testid': 'recent-search-clear',
                        title: '清空搜索',
                        onClick: () => setRecentQuery(''),
                      },
                      '清空',
                    ),
              )
            : null,
          recentShown.length > 0
            ? h(
                'ul',
                { className: 'projects recent-list' },
                recentShown.map((item) =>
                  h(
                    'li',
                    { key: item.path, className: 'recent-item' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: `project recent${item.missing === true ? ' missing' : ''}`,
                        'data-recent-path': item.path,
                        'data-recent-missing': item.missing === true ? 'true' : 'false',
                        title: item.path,
                        onClick: () => props.onOpenRecent?.(item),
                      },
                      h(
                        'span',
                        { className: 'project-body' },
                        item.cover !== undefined && item.cover !== ''
                          ? h('img', {
                              className: 'project-cover',
                              // 封面是打开工程时抽的一帧，落在 ~/.opencut/covers；缺了就是占位块
                              src: `/api/covers/${encodeURIComponent(item.cover)}`,
                              alt: '',
                              loading: 'lazy',
                              draggable: false,
                            })
                          : h('span', { className: 'project-cover placeholder', 'aria-hidden': 'true' }),
                        h(
                          'span',
                          { className: 'project-text' },
                          h(
                            'span',
                            { className: 'project-name' },
                            item.missing === true ? h('span', { className: 'dot bad' }) : null,
                            item.name,
                          ),
                          h(
                            'span',
                            { className: 'project-path' },
                            item.missing === true ? '路径已失效' : relativeTime(item.openedAt),
                          ),
                        ),
                      ),
                    ),
                    item.missing === true
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'recent-remove',
                            'data-recent-remove': item.path,
                            title: '只从「最近」移除，不删磁盘',
                            onClick: (event: { stopPropagation: () => void }) => {
                              event.stopPropagation();
                              props.onRemoveRecent?.(item);
                            },
                          },
                          '移除',
                        )
                      : null,
                  ),
                ),
              )
            : null,
          /* 两种「空」要分开说：全被过滤（有残留、没真工程）vs 搜索没命中。 */
          recentShown.length === 0
            ? recentKept.shown.length === 0
              ? h(
                  'div',
                  { className: 'empty recent-empty', 'data-testid': 'recent-empty' },
                  h('strong', null, '只显示你自己的工程'),
                  h(
                    'span',
                    null,
                    `已隐藏 ${String(recentKept.hidden)} 条测试残留（路径含 .local-runs / .tmp / integration）；索引在 ~/.opencut/projects.json`,
                  ),
                )
              : h(
                  'div',
                  { className: 'empty recent-empty', 'data-testid': 'recent-no-match' },
                  h('strong', null, '没有匹配的工程'),
                  h('span', null, `「${recentQuery.trim()}」在最近 ${String(recentKept.shown.length)} 条里没有命中`),
                )
            : null,
          recentOverflow > 0
            ? h(
                'div',
                { className: 'recent-more', 'data-testid': 'recent-more' },
                `仅显示最近 ${String(RECENT_LIMIT)} 条（共 ${String(recentMatched.length)} 条）`,
              )
            : null,
        )
      : null,
    props.error !== '' ? h('div', { className: 'empty' }, h('strong', null, '列表读取失败'), h('span', null, props.error)) : null,
    props.loading
      ? h('div', { className: 'empty' }, h('span', null, '正在读取 /api/projects…'))
      : projectsShown.length === 0
        ? props.projects.length > 0
          ? /* U08：列表里全是测试残留时的空态 —— 与「真的没有工程」分开说。 */
            h(
              'div',
              { className: 'empty project-empty', 'data-testid': 'project-empty-residue' },
              /* 文案带「工程列表」四个字：这块渲染在「最近」下面，光写「只显示你自己的工程」
                 会被读成最近列表的说明。 */
              h('strong', null, '工程列表只显示你自己的工程'),
              h('span', null, `已隐藏 ${String(projectsSeen.hidden)} 个测试工程（路径含 .local-runs / .tmp / integration）`),
            )
          : h('div', { className: 'empty' }, h('strong', null, '没有工程'), h('span', null, '把含 film.html 的目录放进 projects 根'))
        : h(
            'ul',
            { className: 'projects', 'data-testid': 'project-list' },
            projectsShown.map((item) =>
              h(
                'li',
                { key: item.projectId },
                h(
                  'button',
                  {
                    type: 'button',
                    className: `project${item.projectId === props.activeId ? ' active' : ''}`,
                    'data-project-id': item.projectId,
                    'data-opened': item.opened ? 'true' : 'false',
                    onClick: () => props.onOpen(item),
                  },
                  h('span', { className: 'project-name' }, item.opened ? h('span', { className: 'dot ok' }) : null, item.name),
                  h('span', { className: 'project-path' }, item.path),
                ),
              ),
            ),
          ),
    h(
      'div',
      { className: 'sidebar-head asset-head' },
      h('span', null, '素材'),
      h('span', { className: 'chip' }, String((props.assets ?? []).length)),
      (props.missingCount ?? 0) > 0
        ? h(
            'button',
            {
              type: 'button',
              className: 'chip danger',
              'data-testid': 'media-missing-badge',
              'data-missing-count': String(props.missingCount),
              title: '有片段的素材文件不在了：点开重链',
              onClick: props.onOpenRelink,
            },
            `缺失 ${String(props.missingCount)}`,
          )
        : null,
    ),
    props.assetsError !== undefined && props.assetsError !== ''
      ? h('div', { className: 'empty', 'data-testid': 'asset-error' }, h('strong', null, '素材读取失败'), h('span', null, props.assetsError))
      : props.activeId === ''
        ? h('div', { className: 'empty', 'data-testid': 'asset-empty' }, h('span', null, '先打开一个工程，这里会列出它的 assets/'))
        : props.assetsLoading === true
          ? h('div', { className: 'empty' }, h('span', null, '正在读取素材…'))
          : (props.assets ?? []).length === 0
            ? h(
                'div',
                { className: 'empty', 'data-testid': 'asset-empty' },
                h('strong', null, '还没有素材'),
                h('span', null, '点上面的「导入素材」把视频/音频/图片放进工程 assets/，之后会出现在这里'),
              )
            : h(
                'div',
                { className: 'asset-grid', 'data-testid': 'asset-grid' },
                (props.assets ?? []).map((asset) =>
                  h(
                    'button',
                    {
                      key: asset.name,
                      type: 'button',
                      className: 'asset-card',
                      'data-asset-name': asset.name,
                      'data-asset-kind': asset.kind,
                      title: `在播放头插入 ${asset.name}`,
                      onClick: () => props.onInsertAsset?.(asset),
                    },
                    asset.kind === 'sound'
                      ? h('span', { className: 'asset-thumb audio', 'aria-hidden': 'true' }, '♪')
                      : h('img', {
                          className: 'asset-thumb',
                          src: props.assetThumb?.(asset) ?? '',
                          alt: '',
                          loading: 'lazy',
                          'data-thumb': '1',
                        }),
                    // — M35：视频容器里带音轨就标出来。**别只靠颜色**：带文字，
                    //   并且 title 说清楚「导出不含 · 选中片段后在检查器里分离」。
                    asset.kind === 'video' && asset.hasAudio === true
                      ? h(
                          'span',
                          {
                            className: 'asset-flag audio',
                            'data-testid': 'asset-has-audio',
                            'data-asset-name': asset.name,
                            title: '这个视频自带音轨，但导出不会自动包含它：选中片段后在检查器里点「分离音频」',
                          },
                          '含音频',
                        )
                      : null,
                    h('span', { className: 'asset-name' }, asset.name),
                    h('span', { className: 'asset-meta' }, assetMeta(asset)),
                  ),
                ),
              ),
  );
}

interface DragState {
  mode: 'move' | 'start' | 'end';
  clipId: string;
  track: number;
  clip: Clip;
  startX: number;
  startY: number;
  startScroll: number;
  pointer: number;
  pps: number;
  doc: FilmDoc;
  ids: string[];
  moved: boolean;
  plan: { ops: EditOp[] } | null;
  preview: Record<string, { start: number; end: number; track: number } | null>;
  rejection: string;
  retime: boolean;
  copy: boolean;
  label: string;
  /** 吸附命中时的那条参考线（秒）；null = 没吸上。 */
  guide: { time: number; edge: 'start' | 'end' } | null;
}

export interface TimelineProps {
  projectId?: string;
  onResourceDrop?: (drop: ResourceDrop) => void;
  doc: FilmDoc;
  selection: string[];
  playhead: number;
  pps: number;
  playheadRef?: RefObject<HTMLDivElement | null>;
  playheadHandleRef?: RefObject<HTMLDivElement | null>;
  timelineScrollerRef?: RefObject<HTMLDivElement | null>;
  onSelect: (ids: string[], additive: boolean) => void;
  onPlayhead: (seconds: number, scrubbing?: boolean) => void;
  onOps: (ops: EditOp[], label: string) => Promise<void>;
  /** 吸附开关（M23）：拖动/裁剪时吸到零点、邻片边界、播放头。 */
  snap?: boolean;
  /**
   * 吸附开关的写入面（E07 · R36）：按钮从顶栏搬进时间线工具条的**视图组**。
   * 只搬位置、换图标，`data-testid="snap-toggle"`、`aria-pressed`、状态机与吸附算法一字未改
   * —— 所以顶栏那条同名的文字按钮本批删掉了（同名 testid 两颗按钮会让 Playwright strict mode 直接炸）。
   */
  onToggleSnap?: () => void;
  /** 字幕轨（M24）；不给就不画这条轨。 */
  subtitle?: SubtitleLaneProps;
  /** 转场（M25）：同轨两段重叠 + fade 的识别结果；画成块，拖边缘调长。 */
  transitions?: TransitionView[];
  /** 当前选中的转场 id；Delete 会移除它。 */
  activeTransitionId?: string | null;
  onTransitionSelect?: (id: string | null) => void;
  /** 调长到源余量边界 / 没有可改的位移时，把原因说出来（不静默吞）。 */
  onTransitionReject?: (message: string) => void;
  /** 素材缺失的片段 id（M26）：红边 + ⚠ 角标。 */
  missingClips?: string[];
  speedEdgeClip?: string | null;
  sourceDurations?: Record<string, number | null>;
  onBlade?: (clipId: string, at: number) => void;
  onContextActions?: (target: TimelineMenuTarget) => TimelineMenuGroups;
  /** 可加转场的硬切点（M28）：只在 `canCreate` 的位置画「+」。 */
  cuts?: CutPointView[];
  /** 点「+」→ 在这一对之间建交叉溶解（默认 0.5s，余量不够会夹紧）。 */
  onAddTransition?: (cut: CutPointView) => void;
  /** 音频手势被夹住/被拒时的一句话（M31）；不给就静默夹紧。 */
  onAudioNotice?: (message: string) => void;
  /**
   * 波形（M34）：`fileBase` 是同源只读出口（`/api/projects/<id>/file`）。
   * 不给就不画波形（例如没有 contentOrigin 的环境），时间线其余部分照常。
   */
  waveform?: { fileBase: string } | null;
  /**
   * E04（R29）：胶片条的取帧出口。`base` = `/api/projects/<id>/derived`
   * （每格按 `?what=frame&rel&ms&w=160` 取一张）。不给就不铺胶片条，
   * 时间线其余部分照常（与 `waveform` 同一条「没有出口就退回纯色」的规则）。
   */
  filmstrip?: { base: string } | null;
  /**
   * 轨道高度（M36）：按轨道 index 存的高度表 + 落盘回调。
   * 不给就用默认档（44），时间线其余部分照常。
   */
  trackHeight?: {
    heights: Record<string, number>;
    /** 松手/点菜单时调一次（宿主写 localStorage；不写 film.html）。 */
    onChange: (trackIndex: number, height: number) => void;
  } | null;
  /**
   * 轨道开关（M38）：静音/隐藏/锁定写回 film.html 的轨道属性（一次 /ops、一步撤销）；
   * 独奏只是**视图态**（不发 /ops、不进 film.html），`solo` 是当前独奏的轨道下标。
   */
  trackControls?: {
    solo: number[];
    onFlag: (trackIndex: number, field: 'muted' | 'hidden' | 'locked') => void;
    onSolo: (trackIndex: number) => void;
  } | null;
  /** 锁定轨上的手势被拒时的一句话（M38）；不给就静默。 */
  onEditReject?: (message: string) => void;
  /**
   * 触摸手势的作用域（M43）：换成别的工程就 destroy + 重新挂一遍。
   * 不传 = 一个实例一个作用域（组件卸载时才拆）。
   */
  gestureScope?: string;
  /**
   * 缩放（M47）：把新的 pps 交回宿主（`−`/`+` 与捏合共用）。**只改视图**，
   * 不写文档、不发 op；宿主负责把 state 记住并再传回 `pps`。
   */
  onZoom?: (pps: number) => void;
  /* ── R37（批次 A · 批注 5）：轨道工具栏要用的口子 ─────────────────────
   * 这些控件原来在顶栏，**testid 一个没改**，只是搬到时间线上方那条 32px 的栏里。
   * 顶栏同样删掉了那份副本 —— 同名 testid 两颗按钮会让 Playwright strict mode 直接炸。 */
  /** 播放头逐帧（-1 / +1）；宿主用现成的 `stepBy(±1/fps)`。 */
  onStepFrame?: (direction: -1 | 1) => void;
  /** 在播放头处切分（原顶栏 `split`）。 */
  onSplit?: () => void;
  canSplit?: boolean;
  /** 删除选中片段（原顶栏 `delete`）。 */
  onDelete?: () => void;
  canDelete?: boolean;
  /** 正在提交 / 写盘时，切分与删除跟着禁用。 */
  busy?: boolean;
  /** 波纹删除（M23）：原来在顶栏，R37 搬进左段。 */
  ripple?: boolean;
  onToggleRipple?: () => void;
  /**
   * 网格吸附（M36）：舞台画布手势的宿主开关，与时间线的 `snap` 是两套
   * （时间线吸边界，画布吸格子）。R37 与那串开关一起下移。
   */
  grid?: { enabled: boolean; size: number };
  onToggleGrid?: () => void;
  onGridSize?: (size: number) => void;
  /** 主轨编号（V1）；null = 这个工程没有画面轨。只用于波纹删除的说明文案。 */
  mainTrack?: number | null;
  /** 打开设置中心（右段那颗齿轮；顶栏那颗仍在，这是同一个面板的第二个入口）。 */
  onSettings?: () => void;
  /** 原撤销/重做节点的展示槽；操作与历史仍由原宿主负责。 */
  historySlot?: ReactNode;
  /**
   * 中段时间码的 DOM 节点。播放时 App 每帧只写这个节点的 `textContent`
   * （与走带那颗 `timecode` 同一套 `paintStage`），**不 setState** ——
   * 所以播放中的时间码会走，而 React 树不重渲染。
   */
  timecodeRef?: RefObject<HTMLSpanElement | null>;
}

/** 吸附的像素阈值（ED-045 要求 ≤ 8px）：判定在像素空间，落盘前再吸到帧。 */
export const SNAP_THRESHOLD_PX = 8;

/**
 * 时间线字幕轨（M24）。cue 从 `film-core/subtitle.mjs` 来（秒 + 纯文本），
 * 这里只负责画与拖；写回由 App 走 `PUT /subtitles`（原子写 + 历史）。
 */
export interface SubtitleLaneProps {
  /** 伴生字幕文件（工程相对路径）；null = 这个片段没有字幕文件。 */
  file: string | null;
  format: 'vtt' | 'srt';
  cues: SubtitleCue[];
  /** 选中/正在编辑的 cue 下标；null = 没选。 */
  activeIndex: number | null;
  busy?: boolean;
  /** 解析时跳过的坏 cue 条数（>0 要在轨头说出来）。 */
  skipped: number;
  onSelect: (index: number) => void;
  onEdit: (index: number) => void;
  /** 拖动松手：新的起止（秒，已吸到帧）。App 负责写进 state 并等用户保存。 */
  onMove: (index: number, start: number, end: number) => void;
  /** 打开样式面板（M40）：样式是工程设置，不写进字幕文件。 */
  onStyle?: () => void;
  fps: { num: number; den: number };
}


function TimelineRuler({ scrollerRef, handleRef, duration, playhead, pps, onSeek }: {
  scrollerRef: RefObject<HTMLDivElement | null>;
  handleRef?: RefObject<HTMLDivElement | null>;
  duration: number;
  playhead: number;
  pps: number;
  onSeek: (seconds: number, scrubbing?: boolean) => void;
}): ReactNode {
  const scrubPointer = useRef<{
    id: number; offset: number; time: number; clientX: number; frame: number; lastFrame: number;
  } | null>(null);
  const rulerRef = useRef<HTMLDivElement | null>(null);
  const [rulerViewport, setRulerViewport] = useState({ scrollLeft: 0, width: 1280 });
  const ruler = timelineRuler({
    pixelsPerSecond: pps, duration, scrollLeft: rulerViewport.scrollLeft, viewportWidth: rulerViewport.width,
  });

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const updateRuler = () => {
      const scrollLeft = scroller.scrollLeft;
      scroller.style.setProperty('--tl-scroll-left', `${scrollLeft}px`);
      const width = Math.max(1, scroller.clientWidth - HEAD_W);
      setRulerViewport(previous => previous.scrollLeft === scrollLeft && previous.width === width
        ? previous : { scrollLeft, width });
    };
    const observer = new ResizeObserver(updateRuler);
    observer.observe(scroller);
    scroller.addEventListener('scroll', updateRuler, { passive: true });
    updateRuler();
    return () => {
      observer.disconnect();
      scroller.removeEventListener('scroll', updateRuler);
    };
  }, [scrollerRef]);
  useEffect(() => () => {
    if (scrubPointer.current !== null) cancelAnimationFrame(scrubPointer.current.frame);
  }, []);

  function scrubBounds(scroller: HTMLDivElement, origin: number): { left: number; right: number } {
    const left = origin + scroller.scrollLeft;
    const right = scroller.getBoundingClientRect().left + scroller.clientLeft + scroller.clientWidth;
    return { left, right: Math.max(left, right - 1) };
  }

  function scrubTime(clientX: number, offset: number): number {
    const origin = rulerRef.current?.getBoundingClientRect().left;
    if (origin === undefined) return scrubPointer.current?.time ?? 0;
    const scroller = scrollerRef.current;
    const x = clientX - offset;
    if (scroller === null) return Math.max(0, (x - origin) / pps);
    const { left, right } = scrubBounds(scroller, origin);
    return Math.max(0, (Math.max(left, Math.min(right, x)) - origin) / pps);
  }

  function scrollWhileScrubbing(now: number): void {
    const active = scrubPointer.current;
    const scroller = scrollerRef.current;
    const origin = rulerRef.current?.getBoundingClientRect().left;
    if (active === null) return;
    active.frame = 0;
    if (scroller === null || origin === undefined) return;
    const { left, right } = scrubBounds(scroller, origin);
    const speed = scrubEdgeVelocity(active.clientX, left, right);
    const before = scroller.scrollLeft;
    const maxScroll = scroller.scrollWidth - scroller.clientWidth;
    if (speed === 0 || (speed < 0 && before <= 0) || (speed > 0 && before >= maxScroll)) return;
    const elapsed = Math.min(40, now - active.lastFrame);
    active.lastFrame = now;
    scroller.scrollLeft = Math.max(0, Math.min(maxScroll, before + speed * elapsed / 1000));
    const time = scrubTime(active.clientX, active.offset);
    if (time !== active.time) {
      active.time = time;
      onSeek(time, true);
    }
    active.frame = requestAnimationFrame(scrollWhileScrubbing);
  }

  function onRulerDown(event: ReactPointerEvent<HTMLDivElement>, fromHandle = false): void {
    if (event.button !== 0 || scrubPointer.current !== null || rulerRef.current === null) return;
    event.stopPropagation();
    event.preventDefault();
    const origin = rulerRef.current.getBoundingClientRect().left;
    const handlePosition = Number.parseFloat(event.currentTarget.style.left);
    const x = fromHandle && Number.isFinite(handlePosition) ? origin + handlePosition : event.clientX;
    const time = Math.max(0, (x - origin) / pps);
    scrubPointer.current = { id: event.pointerId, offset: event.clientX - x, time, clientX: event.clientX, frame: 0, lastFrame: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
    onSeek(time, true);
  }

  function finishRulerScrub(event: ReactPointerEvent<HTMLDivElement>): void {
    const active = scrubPointer.current;
    if (active?.id !== event.pointerId) return;
    cancelAnimationFrame(active.frame);
    const time = event.type === 'pointerup' ? scrubTime(event.clientX, active.offset) : active.time;
    scrubPointer.current = null;
    onSeek(time);
  }
  /** @param {ReactPointerEvent<HTMLDivElement>} event */
  function onRulerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const active = scrubPointer.current;
    if (active?.id !== event.pointerId || rulerRef.current === null) return;
    active.clientX = event.clientX;
    active.time = scrubTime(event.clientX, active.offset);
    onSeek(active.time, true);
    if (active.frame === 0) {
      active.lastFrame = performance.now();
      active.frame = requestAnimationFrame(scrollWhileScrubbing);
    }
  }

  return h(
    'div',
    { className: 'tl-ruler', 'data-scrolled': rulerViewport.scrollLeft > 0 ? 'true' : undefined },
    h('div', { className: 'tl-ruler-head', 'aria-hidden': 'true' }),
    h(
      'div',
      {
        className: 'tl-ruler-track',
        ref: rulerRef,
        'data-testid': 'ruler',
        style: { '--tl-major-step': `${ruler.majorPx}px`, '--tl-minor-step': `${ruler.minorPx}px` } as CSSProperties,
        onPointerDown: onRulerDown,
        onPointerMove: onRulerMove,
        onPointerUp: finishRulerScrub,
        onPointerCancel: finishRulerScrub,
        onLostPointerCapture: finishRulerScrub,
      },
      ruler.labels.map(tick =>
        h('span', { className: 'tl-tick', key: tick, style: { left: `${tick * pps}px` } }, formatRulerLabel(tick))),
      h('div', {
        className: 'tl-playhead-handle',
        ref: handleRef,
        style: { left: `${playhead * pps}px` },
        'data-testid': 'playhead-handle',
        'aria-hidden': 'true',
        onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => onRulerDown(event, true),
      }),
    ),
  );
}

export function Timeline(props: TimelineProps): ReactNode {
  const { doc, selection, playhead, pps } = props;
  const [resourceGhost, setResourceGhost] = useState<{at:number;track:number|null;left:number;top:number}|null>(null);
  useEffect(()=>{setResourceGhost(null);const clear=()=>setResourceGhost(null);window.addEventListener('dragend',clear);window.addEventListener('drop',clear);return()=>{window.removeEventListener('dragend',clear);window.removeEventListener('drop',clear);};},[props.projectId]);
  const [contextMenu, setContextMenu] = useState<{ target: TimelineMenuTarget; x: number; y: number; doc: FilmDoc; scope?: string } | null>(null);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  useEffect(closeContextMenu, [closeContextMenu, props.gestureScope, doc]);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  /** 字幕块拖动（M24）：与片段拖动分开，松手才 onMove（一次编辑一个 cue）。 */
  const [cueDrag, setCueDrag] = useState<{ index: number; startX: number; start: number; end: number; previewStart: number; previewEnd: number; moved: boolean } | null>(null);
  const cueDragRef = useRef<typeof cueDrag>(null);
  /** 转场块拖动（M25）：只改重叠与 fade，松手才发一批 Op。 */
  const [tDrag, setTDrag] = useState<{
    id: string;
    edge: 'start' | 'end';
    startX: number;
    pps: number;
    moved: boolean;
    preview: { start: number; end: number } | null;
    plan: { ops: EditOp[]; limited: string | null; message: string } | null;
  } | null>(null);
  const tDragRef = useRef<typeof tDrag>(null);
  /**
   * 音频手势（M31）：淡变圆柄与音量线共用一套「按下去 → 拖 → 松手发一批 Op」。
   * 拖动中只更新这个本地状态（浮标上的数字），**不发 /ops**。
   */
  const [audioDrag, setAudioDrag] = useState<
    | { kind: 'fade'; clipId: string; edge: 'in' | 'out'; startX: number; start: number; current: number; moved: boolean; clamped: boolean }
    | { kind: 'volume'; clipId: string; startY: number; start: number; current: number; moved: boolean; clamped: boolean }
    | null
  >(null);
  const audioDragRef = useRef<typeof audioDrag>(null);
  /**
   * 轨道高度拖动（M36）：与上面的手势分开——它**不发 Op**，只在松手时把高度写进
   * localStorage（视图偏好）。拖动中每次 move 只改本地状态，波形跟着重画
   * （`WaveformLayer` 的签名含 height，走缓存不重新解码）。
   */
  const [laneDrag, setLaneDrag] = useState<{ index: number; startY: number; startHeight: number; height: number } | null>(null);
  const laneDragRef = useRef<typeof laneDrag>(null);
  /**
   * E07（R36）：时间线工具模式。
   *
   * - `pointer`（默认）：选中 / 拖动 / 裁剪 —— **与改前逐字节同一条路**，本批只是给它在工具条上立了个身份；
   * - `select`：在空白处拉框多选（框内的片段一次选中）；
   * - `blade`：点片段，在点击处切开（走 `film-core` 的 `op:'split'`，带逆操作）。
   *
   * 模式只改「按下时走哪条分支」，不动任何一条既有手势的落盘逻辑。
   */
  const [tool, setTool] = useState<'pointer' | 'select' | 'blade'>('pointer');
  /**
   * 框选（E07）：存**视口坐标**（`clientX/clientY`），渲染时再换算成 `.tl` 内的偏移。
   * 存视口坐标是因为手势监听挂在 window 上——`.tl` 自己会随横向滚动移动，跟着它算会抖。
   */
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const marqueePointer = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  /** 时间线搜索（E07）：一个输入框，输入秒数或 `mm:ss` 就把播放头跳过去。 */
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const opsRef = useRef(props.onOps);
  opsRef.current = props.onOps;
  const audioNoticeRef = useRef(props.onAudioNotice);
  audioNoticeRef.current = props.onAudioNotice;
  const editRejectRef = useRef(props.onEditReject);
  editRejectRef.current = props.onEditReject;
  /** 锁定轨（M38）：拖动/裁剪/淡变/音量/转场一律在本地拒掉，别等 /ops 报错。 */
  const lockedTracks = new Set(doc.tracks.filter((track) => track.locked === true).map((track) => track.index));
  const soloTracks = new Set(props.trackControls?.solo ?? []);
  /**
   * 被锁定就提示并返回 true（调用方直接 return，不发 Op）。
   * @param {number} trackIndex @param {string} what
   */
  function rejectLocked(trackIndex: number, what: string): boolean {
    if (!lockedTracks.has(trackIndex)) return false;
    editRejectRef.current?.(`轨道 T${trackIndex} 已锁定：先解锁再${what}`);
    return true;
  }

  /* ── 触摸 / 触控笔手势（M43 · B-MAIN-R22-022）──────────────────────────
   *
   * 引擎（`packages/layers/timeline-gesture.mjs`，S46）只被**接线**，一行都不改：
   * 它把指针翻译成与 `plan.mjs` 同形的 op，我们只回答两个问题——「视口是哪块 DOM」
   * 与「哪些指针归它」。四件必须说清楚的事：
   *
   * 1. **坐标原点**。引擎算 `left = at×pps − scrollLeft`、`top = track×trackHeight`，
   *    原点在视口左上。产品的片段原点在「轨道头右侧、标尺下方」，而且每条轨可以
   *    不同高（M36）。所以挂载后把引擎自己建的**热区层**挪到片段原点，并把「轨顶
   *    偏移」折进 `track`（`track = laneTop ÷ 44`）——引擎只做乘加，折进去不影响它
   *    的任何判定，`getState()` 里看到的 `track` 是折过的值。
   * 2. **滚动**。滚动条在 `.timeline`，`.tl` 自身不滚（它跟着内容一起移动）。所以
   *    在 `.tl` 这个坐标系里 `scrollLeft` 恒为 0，`onScroll(next)` 收到的是「相对按下
   *    那一刻还要往右多少」；映射回真实滚动条 = 按下时的值 + next。这样 `pointercancel`
   *    时引擎回放 `onScroll(0)` 正好回到按下时的位置。
   * 3. **鼠标零回归**。`shouldHandle` 只放 touch/pen 进来（ADR-R27-01）；但引擎的
   *    44×44 热区会盖住片段的 8px 边带，所以鼠标在时间线上移动时把热区整体关掉
   *    （`data-tl-hits="off"`，见 styles.css），鼠标裁剪继续走 React 的老路径。
   * 4. **锁定轨**。引擎不知道 `locked` 是文档属性，所以由 `shouldHandle` 在按下那一
   *    刻拒掉，文案与鼠标同一条（与 `rejectLocked` 一个字不差），不发 op。
   *
   * 触摸**只做**选中 / 拖动 / 裁剪 / 空白横拖滚动：`.tl` 里的其他手势件（标尺、轨道头、
   * 字幕块、转场块、淡变柄、音量线、轨高下沿）都在 `GESTURE_DENY` 里，仍走各自的老路。
   */
  const GESTURE_DENY = '.tl-ruler, .tl-lane-head, .tl-lane-resize, .tl-cue, .tl-transition, .tl-fade-handle, .tl-clip-vol, .tl-cut-add';
  const tlRef = useRef<HTMLDivElement | null>(null);
  const localScrollerRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = props.timelineScrollerRef ?? localScrollerRef;
  const gestureRef = useRef<{ refresh: () => void; getState: () => any; destroy: () => void } | null>(null);
  /** 触摸拖动中的本地预览（只画，不发网络）；松手/取消都清掉。 */
  const [touchPreview, setTouchPreview] = useState<{ clipId: string; start: number; end: number } | null>(null);
  /** 按下那一刻的滚动位置：引擎的 `onScroll` 是相对量，要靠它换成绝对值。 */
  const touchScroll0 = useRef(0);
  /** 按下那一刻的 pps（M47）：捏合补偿 `S × ratio` 里的分母，必须用**手势开始**的那一档。 */
  const touchPps0 = useRef(DEFAULT_PPS);
  /**
   * 缩放后要落到的 scrollLeft（M47）。**不能当场写**：`scrollWidth` 要等 pps 渲染完才变，
   * 当场夹紧会用旧宽度算错。所以只记目标值，等 `[pps]` 的 effect（DOM 已提交）再夹紧落位。
   */
  const pendingScroll = useRef<number | null>(null);
  /** `props.onZoom` 的最新值：挂载 effect 只依赖 `gestureScope`，不能把回调锁死在旧闭包里。 */
  const zoomRef = useRef(props.onZoom);
  zoomRef.current = props.onZoom;
  /** 这次手势抓着哪个片段（给 `getSnapTargets` 排除自己）。 */
  const gestureClip = useRef<string | null>(null);
  const selectRef = useRef(props.onSelect);
  selectRef.current = props.onSelect;
  /** 引擎回调里要读**当前**的文档/视图，不能锁在挂载那一刻的闭包里。 */
  const liveRef = useRef({ doc, pps, playhead, mainTrack: props.mainTrack, heights: props.trackHeight?.heights ?? ({} as Record<string, number>), snap: props.snap === true });
  liveRef.current = { doc, pps, playhead, mainTrack: props.mainTrack, heights: props.trackHeight?.heights ?? {}, snap: props.snap === true };

  /** 外层滚动条的最大值（内容宽 − 视口宽；`.tl` 自身不滚）。 */
  function maxScrollOf(scroller: HTMLElement): number {
    return Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  }

  /**
   * 换档（M47）：**以播放头为锚**——缩放前后播放头在屏幕上的 x 不变。
   *
   *   x = HEAD_W + t×pps0 − scroll0 = HEAD_W + t×pps1 − scroll1
   *   → scroll1 = scroll0 + t×(pps1 − pps0)
   *
   * 为什么锚播放头而不是视口中心：A2 的判据就是它；而且用户按 `+/−` 时眼睛在播放头附近。
   * 落位不在这里做（`scrollWidth` 还是旧的），交给 `[pps]` 的 effect。
   * @param {number} nextPps
   */
  function zoomTo(nextPps: number): void {
    if (typeof props.onZoom !== 'function' || !Number.isFinite(nextPps)) return;
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    const clamped = Math.min(PPS_STEPS[PPS_STEPS.length - 1] ?? 512, Math.max(PPS_STEPS[0] ?? 16, nextPps));
    if (clamped === pps) return;
    const paintedX = Number.parseFloat(props.playheadHandleRef?.current?.style.left ?? '');
    const anchorTime = Number.isFinite(paintedX) ? paintedX / pps : playhead;
    pendingScroll.current = scroller.scrollLeft + anchorTime * (clamped - pps);
    props.onZoom(clamped);
  }

  /** 跳到相邻档（不是 ×2）：捏合可能落在两档之间，`+` 应该去「上一个更大的档」。 */
  function stepZoom(direction: -1 | 1): void {
    if (direction < 0) {
      const previous = [...PPS_STEPS].reverse().find((value) => value < pps);
      if (previous !== undefined) zoomTo(previous);
      return;
    }
    const next = PPS_STEPS.find((value) => value > pps);
    if (next !== undefined) zoomTo(next);
  }

  /**
   * 缩放滑块（R37 · 批注 5：右段那颗）。
   *
   * 档位是 16…512 的**几何级数**，线性滑块会把 90% 的行程都花在高倍率上，
   * 所以滑块位置取对数：`v = 100 · ln(pps/16) / ln(512/16)`。反过来解 pps。
   * 滑块只调 `zoomTo`（与 `−`/`+`、捏合同一条路），不写文档、不发 op。
   * @param {number} value 0…100
   */
  function ppsOfSlider(value: number): number {
    const lo = PPS_STEPS[0] ?? 16;
    const hi = PPS_STEPS[PPS_STEPS.length - 1] ?? 512;
    const t = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0)) / 100;
    return Math.round(lo * Math.pow(hi / lo, t) * 100) / 100;
  }

  /** @param {number} current */
  function sliderOfPps(current: number): number {
    const lo = PPS_STEPS[0] ?? 16;
    const hi = PPS_STEPS[PPS_STEPS.length - 1] ?? 512;
    const clamped = Math.max(lo, Math.min(hi, current));
    return Math.round((Math.log(clamped / lo) / Math.log(hi / lo)) * 100);
  }

  /**
   * 适配（E07 · R36）：把整条时间线缩到「刚好装进可视宽」。
   *
   *   pps = (可视宽 − 轨头 − 右边距) ÷ 时长
   *
   * 和 `zoomTo` 同一套落位：档位仍夹在 `PPS_STEPS` 的两端（视图不引入新档），
   * 只是这回滚动条要回到 0（适配的语义是「从零点开始刚好看到尾」）。
   * 时长比最小可视宽还短时 `pps` 会被夹到 512，这是档位上限，不是 bug。
   */
  function fitToWindow(): void {
    const scroller = scrollerRef.current;
    if (scroller === null) return;
    const avail = Math.max(80, scroller.clientWidth - HEAD_W - 24);
    zoomTo(avail / Math.max(0.25, duration));
    pendingScroll.current = pendingScroll.current === null ? null : 0;
    scroller.scrollLeft = 0;
  }

  /**
   * 解析搜索框的输入：纯秒数（`12.5`）或 `m:ss` / `h:mm:ss`。
   * 解不出数字就返回 null（此时不动播放头，也不清空用户正在打的字）。
   * @param {string} text
   */
  function parseSeekText(text: string): number | null {
    const raw = text.trim();
    if (raw === '') return null;
    if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw);
    const parts = raw.split(':');
    if (parts.length < 2 || parts.length > 3) return null;
    const nums = parts.map((one) => Number(one));
    if (nums.some((one) => !Number.isFinite(one) || one < 0)) return null;
    return nums.reduce((acc, one) => acc * 60 + one, 0);
  }

  /**
   * 框选（E07 · R36）：在空白处按下 → 拉一个矩形 → 松手把**与矩形相交的片段**一次选中。
   *
   * 判定用 DOM 矩形（`[data-clip-id]` 的 `getBoundingClientRect`）而不是文档里的秒数：
   * 轨高可拖（M36），每条轨的 y 不一样，用 DOM 矩形才和眼睛看到的一致。
   * 捕获本次指针，取消或在时间线外松手时丢弃框选。
   * @param {ReactPointerEvent<HTMLDivElement>} event
   */
  function onLanesDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (tool !== 'select' || event.pointerType !== 'mouse' || event.button !== 0) return;
    const target = event.target as Element | null;
    /* 字幕轨独立选择。媒体框选只从媒体轨内的空白处起手。 */
    if (target !== null && typeof target.closest === 'function' && target.closest('[data-clip-id], .tl-lane-head, .tl-lane-resize, .tl-sub-lane, .tl-transition, .tl-flag') !== null) return;
    const tl = tlRef.current;
    if (tl === null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    marqueePointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  }

  const clearMarquee = useCallback((): void => {
    marqueePointer.current = null;
    setMarquee(null);
  }, []);
  useEffect(() => {
    clearMarquee();
    window.addEventListener('blur', clearMarquee);
    return () => window.removeEventListener('blur', clearMarquee);
  }, [clearMarquee, props.gestureScope, tool]);

  function onLanesMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const start = marqueePointer.current;
    if (start === null || start.id !== event.pointerId) return;
    if (!start.moved && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5) return;
    start.moved = true;
    setMarquee({ x0: start.x, y0: start.y, x1: event.clientX, y1: event.clientY });
  }

  function onLanesUp(event: ReactPointerEvent<HTMLDivElement>): void {
    const start = marqueePointer.current;
    if (start === null || start.id !== event.pointerId) return;
    clearMarquee();
    const tl = tlRef.current;
    const viewport = scrollerRef.current?.getBoundingClientRect();
    const { clientX: x, clientY: y } = event;
    if (!tl || !viewport || x < viewport.left || x > viewport.right || y < viewport.top || y > viewport.bottom) return;
    if (!start.moved) {
      selectRef.current([], false);
      return;
    }
    const box = {
      left: Math.min(start.x, x),
      right: Math.max(start.x, x),
      top: Math.min(start.y, y),
      bottom: Math.max(start.y, y),
    };
    const ids = [...tl.querySelectorAll<HTMLElement>('.tl-clip[data-clip-id]')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom;
      })
      .flatMap((el) => el.dataset.clipId ? [el.dataset.clipId] : []);
    selectRef.current(ids, false);
  }

  function cancelLanesSelection(event: ReactPointerEvent<HTMLDivElement>): void {
    if (marqueePointer.current?.id === event.pointerId) clearMarquee();
  }

  /** @param {Element|null} target */
  function gestureClipIdAt(target: Element | null): string | null {
    if (target === null || typeof target.closest !== 'function') return null;
    const hit = target.closest('[data-tl-hit]');
    const hitId = hit === null ? null : hit.getAttribute('data-tl-clip');
    if (typeof hitId === 'string' && hitId !== '') return hitId;
    const clipEl = target.closest('[data-clip-id]');
    return clipEl === null ? null : clipEl.getAttribute('data-clip-id');
  }

  /** 这个片段在哪条锁定轨上（不在锁定轨 → null）。 @param {string|null} clipId */
  function lockedTrackOf(clipId: string | null): number | null {
    if (clipId === null) return null;
    for (const track of liveRef.current.doc.tracks) {
      if (track.locked !== true) continue;
      if (track.clips.some((clip) => clip.id === clipId)) return track.index;
    }
    return null;
  }

  /** 鼠标把热区关掉 / 触摸再打开。 @param {HTMLElement|null} el @param {boolean} on */
  function setGestureHits(el: HTMLElement | null, on: boolean): void {
    if (el === null) return;
    if (on) el.removeAttribute('data-tl-hits');
    else el.setAttribute('data-tl-hits', 'off');
  }

  useEffect(() => {
    const viewport = tlRef.current;
    const scroller = scrollerRef.current;
    if (viewport === null || scroller === null) return undefined;
    // 同一容器第二次挂载前先拆干净：两套监听 = 一次手势两次提交。
    gestureRef.current?.destroy();
    gestureRef.current = null;

    const live = () => liveRef.current;
    /** 轨顶偏移表：`index → 距轨道区顶部的 px`（高度按 M36 的表，缺省 44）。 */
    function laneTops(): Map<number, number> {
      const { doc: current, heights } = live();
      /* 与渲染同一份算术（`laneTopOf`：默认高按 role + 行间 gap2）。 */
      return laneTopOf(heights, current.tracks, live().mainTrack);
    }

    const controller = mountTimelineGesture(viewport, {
      // 与渲染**同一份** clip 列表：不另建索引，`doc.tracks[].clips` 展开就是全部。
      getClips: () => {
        const { doc: current } = live();
        const tops = laneTops();
        const out: Array<Record<string, unknown>> = [];
        for (const track of current.tracks) {
          for (const clip of track.clips) {
            out.push({
              id: clip.id,
              at: clip.at,
              time: clip.time,
              speed: clip.speed,
              // 折成「轨顶像素 / 44」：引擎只拿它乘 trackHeight，多档轨高也能对齐。
              track: (tops.get(track.index) ?? 0) / DEFAULT_TRACK_HEIGHT,
            });
          }
        }
        return out;
      },
      getView: () => ({ pxPerSecond: live().pps, scrollLeft: 0, trackHeight: DEFAULT_TRACK_HEIGHT }),
      // 磁吸与鼠标同源：关掉吸附就不给目标（引擎拿到空表就不吸）。
      getSnapTargets: () => {
        const { doc: current, playhead: head, snap } = live();
        if (snap !== true) return [];
        const exclude = gestureClip.current === null ? [] : [gestureClip.current];
        return collectSnapTargets({ tracks: current.tracks, playhead: head, excludeIds: exclude });
      },
      shouldHandle: (event: PointerEvent) => {
        if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return false;
        const target = event.target instanceof Element ? event.target : null;
        if (target !== null && target.closest(GESTURE_DENY) !== null) return false;
        // 手下这一按的真实滚动位置（引擎的 onScroll 是相对量）。
        touchScroll0.current = scroller.scrollLeft;
        touchPps0.current = live().pps;
        setGestureHits(viewport, true);
        gestureClip.current = gestureClipIdAt(target);
        const lockedTrack = lockedTrackOf(gestureClip.current);
        if (lockedTrack !== null) {
          // 与鼠标一致：先选中，再拒掉并说原因，一个 op 都不发。
          if (gestureClip.current !== null) selectRef.current([gestureClip.current], false);
          editRejectRef.current?.(`轨道 T${lockedTrack} 已锁定：先解锁再拖动或裁剪`);
          gestureClip.current = null;
          return false;
        }
        return true;
      },
      onSelect: (id: string | null) => {
        if (id !== null) selectRef.current([id], false);
      },
      onPreview: (placed: Record<string, { start: number; end: number }>) => {
        const first = Object.entries(placed)[0];
        if (first === undefined) return;
        setTouchPreview({ clipId: first[0], start: first[1].start, end: first[1].end });
      },
      onCommit: (ops: EditOp[]) => {
        setTouchPreview(null);
        if (!Array.isArray(ops) || ops.length === 0) return;
        // 标签只影响提示条（ops 本身才是落盘内容）：开始/结束改区间 = 裁剪，否则 = 拖动。
        const trims = ops.some((op) => (op as any)?.edits?.some?.((edit: any) => edit?.prop === 'start' || edit?.prop === 'end'));
        void opsRef.current(ops, trims ? '裁剪' : '拖动');
      },
      onCancel: () => setTouchPreview(null),
      onScroll: (next: number) => {
        /* ADR-R29-01：引擎给的是**未夹紧**的内容坐标（可以为负，表示往回拖）。
           夹的是「按下时的位置 + 相对量」这个**和**，不是 `next` 本身——夹 `next`
           会把往回拖吃掉（R29-C1：`max(0, 0−dx)` 恒 0，时间线只能往一个方向滚）。 */
        scroller.scrollLeft = Math.min(Math.max(0, touchScroll0.current + next), maxScrollOf(scroller));
      },
      onZoom: (view: { pxPerSecond: number; scrollLeft: number }) => {
        /* 捏合（M47）。锚点时刻仍由引擎算（不重写 `pinchView`），宿主只负责把滚动落位。
         *
         * **本挂载的坐标系**：引擎的视口是 `.tl`，它随外层 `.timeline` 一起滚动，所以
         * `localX()` 量到的是**内容坐标**，`emitted.scrollLeft` 里已经含了 `−当前滚动`。
         * 要保持「指尖下的内容不动」，宿主要补的是**当前滚动**：
         *   desired = T×pps1 − mid_screen = (T×pps1 − mid_content) + scroll
         *           = emitted.scrollLeft + scroll
         * 任务书写的 `S × ratio` 是「视口局部坐标」的写法；在这里用它会震荡
         * （实测 200 → 1200 → 200 …，见交接 zoom.pinchFormula 的六步表）。
         */
        const nextPps = Math.round(Number(view.pxPerSecond));
        if (!Number.isFinite(nextPps)) return;
        if (nextPps === touchPps0.current) {
          // 引擎回滚（pointercancel）：把 pps 与滚动都还原成按下那一刻。
          pendingScroll.current = touchScroll0.current;
          zoomRef.current?.(nextPps);
          return;
        }
        if (nextPps === live().pps) return;
        pendingScroll.current = Number(view.scrollLeft) + scroller.scrollLeft;
        zoomRef.current?.(nextPps);
      }
    } as any);
    gestureRef.current = controller;

    // 引擎的坐标系原点在视口左上；产品的片段原点在轨道头右侧、标尺下方。
    // 热区层是引擎的**输出**（不是输入），这里只把它挪到片段原点，不动引擎代码。
    const layer = viewport.querySelector<HTMLElement>('[data-tl-hit-layer]');
    const lanes = viewport.querySelector<HTMLElement>('.tl-lanes');
    let geometryObserver: ResizeObserver | undefined;
    if (layer && lanes) {
      const placeLayer = () => {
        layer.style.left = `${HEAD_W}px`;
        layer.style.top = `${lanes.offsetTop}px`;
        layer.style.width = `calc(100% - ${HEAD_W}px)`;
        layer.style.height = `${lanes.offsetHeight}px`;
      };
      placeLayer();
      geometryObserver = new ResizeObserver(placeLayer);
      geometryObserver.observe(lanes);
      geometryObserver.observe(viewport);
    }
    controller.refresh();
    // 验收探针（与舞台的 `window.__stageProbe` 同一条约定）：页面在加载**之前**把
    // `window.__opencutGestureProbe` 置 true，就把控制器挂出来读 taps/commits/previews。
    // 默认不挂：产品页面不该多一个全局变量。
    if ((globalThis as any).__opencutGestureProbe === true) (globalThis as any).__timelineGesture = controller;

    // 鼠标在时间线上移动 → 关掉 44px 热区（否则它会盖住片段的 8px 边带，鼠标就没法裁剪了）。
    // 鼠标离开 / 触摸按下 → 再打开。鼠标不会「凭空按下」，所以移动一定先于点击。
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'mouse') setGestureHits(viewport, false);
      else setGestureHits(viewport, true);
    };
    const onPointerLeave = () => setGestureHits(viewport, true);
    viewport.addEventListener('pointermove', onPointerMove, true);
    viewport.addEventListener('pointerleave', onPointerLeave, true);

    return () => {
      geometryObserver?.disconnect();
      viewport.removeEventListener('pointermove', onPointerMove, true);
      viewport.removeEventListener('pointerleave', onPointerLeave, true);
      controller.destroy();
      if (gestureRef.current === controller) gestureRef.current = null;
      if ((globalThis as any).__timelineGesture === controller) delete (globalThis as any).__timelineGesture;
      setTouchPreview(null);
    };
    // 切工程要换一套监听（`gestureScope` 变了就 destroy + 重新挂）。
  }, [props.gestureScope]);

  // 片段/轨高/缩放变了要重摆热区，否则热区还停在旧位置。
  // 缩放后的滚动落位也在这里：此刻 DOM 已按新 pps 提交，`scrollWidth` 才是新宽度。
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller !== null && pendingScroll.current !== null) {
      const target = pendingScroll.current;
      pendingScroll.current = null;
      scroller.scrollLeft = Math.min(Math.max(0, target), maxScrollOf(scroller));
    }
    gestureRef.current?.refresh();
  }, [doc, pps, props.trackHeight?.heights]);

  // 时长要算上字幕 cue：否则 10s 的字幕块会画到时间线宽度之外（M24 的实测坑）。
  const duration = Math.max(
    4,
    ...doc.tracks.flatMap((track) => track.clips.map((clip) => clipSpan(clip).end)),
    ...(props.subtitle?.cues ?? []).map((cue) => Number(cue.end) || 0),
    playhead + 1,
  );
  const width = Math.ceil(duration * pps) + 24;

  function update(next: DragState | null): void {
    dragRef.current = next;
    setDrag(next);
  }

  useEffect(() => {
    const cancel = () => {
      if (dragRef.current !== null) update(null);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || dragRef.current === null) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener('keydown', onEscape, true);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('keydown', onEscape, true);
      window.removeEventListener('blur', cancel);
    };
  }, []);

  function openContextMenu(element: Element, x: number, y: number): void {
    if (!props.onContextActions || dragRef.current !== null) return;
    const lane = element.closest<HTMLElement>('.tl-lane[data-track-index]');
    if (lane?.dataset.trackIndex === 'S' || element.closest('.tl-transition, .tl-cut-add, .tl-lane-resize')) return;
    const rawTrack = lane?.dataset.trackIndex;
    const clipId = element.closest<HTMLElement>('[data-clip-id]')?.dataset.clipId;
    const kind = clipId ? 'clip' : element.closest('.tl-lane-head') ? 'track' : 'space';
    const ids = clipId ? selection.includes(clipId) ? selection : expandLinks(doc.tracks.flatMap(row => row.clips), [clipId]) : [];
    if (clipId && !selection.includes(clipId)) props.onSelect(ids, false);
    const anchor = tlRef.current?.getBoundingClientRect();
    const at = kind !== 'track' && anchor !== undefined
      ? snapSecondsToFrame(Math.max(0, (x - anchor.left - HEAD_W) / pps), doc.fps)
      : playhead;
    setContextMenu({
      target: { kind, ids, at, ...(rawTrack === undefined ? {} : { track: Number(rawTrack) }) },
      x, y, doc, scope: props.gestureScope,
    });
  }

  function onTimelineContext(event: ReactMouseEvent<HTMLDivElement>): void {
    if (!(event.target instanceof Element)) return;
    event.preventDefault();
    event.stopPropagation();
    openContextMenu(event.target, event.clientX, event.clientY);
  }

  function onClipDown(event: ReactPointerEvent<HTMLDivElement>, clip: Clip, track: Track): void {
    if (event.pointerType !== 'mouse' || event.button !== 0 || props.busy) return;
    event.preventDefault();
    event.stopPropagation();
    const element = event.currentTarget;
    element.focus({ preventScroll: true });
    const rect = element.getBoundingClientRect();
    const offset = event.clientX - rect.left;
    if (tool === 'blade') {
      if (!rejectLocked(track.index, '分割')) {
        const at = snapSecondsToFrame(clipSpan(clip).start + offset / pps, doc.fps);
        props.onBlade?.(clip.id, at);
      }
      return;
    }
    const edge = Math.min(8, rect.width / 5);
    const mode = offset < edge ? 'start' : offset > rect.width - edge ? 'end' : 'move';
    const selected = selection.includes(clip.id);
    if (event.metaKey || event.ctrlKey) { props.onSelect([clip.id], true); return; }
    if (event.shiftKey && !selected) props.onSelect([...selection, clip.id], false);
    if (!selected && !event.shiftKey) props.onSelect([clip.id], false);
    if (rejectLocked(track.index, '拖动或裁剪')) return;
    const ids = expandLinks(doc.tracks.flatMap(row => row.clips), selected || event.shiftKey ? [...new Set([...selection, clip.id])] : [clip.id]);
    const retime = mode !== 'move' && props.speedEdgeClip === clip.id;
    const copy = mode === 'move' && event.altKey;
    element.setPointerCapture(event.pointerId);
    update({
      mode, clipId: clip.id, track: track.index, clip, ids, doc,
      startX: event.clientX, startY: event.clientY, pointer: event.pointerId,
      startScroll: scrollerRef.current?.scrollLeft ?? 0, pps,
      moved: false, plan: null, preview: {}, rejection: '',
      label: copy ? '拖动复制片段' : mode === 'move' ? '移动片段' : retime ? '变速片段' : '裁剪片段',
      guide: null, retime, copy,
    });
  }

  function onClipMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const current = dragRef.current;
    if (current === null || event.pointerId !== current.pointer || current.doc !== doc) return;
    const deltaPx = event.clientX - current.startX + (scrollerRef.current?.scrollLeft ?? 0) - current.startScroll;
    const threshold = current.mode === 'move' ? 5 : 1;
    const moved = current.moved || Math.abs(deltaPx) >= threshold ||
      (current.mode === 'move' && Math.abs(event.clientY - current.startY) >= threshold);
    if (!moved) return;
    const magnetic = props.snap === true
      ? {
        targets: collectSnapTargets({ tracks: doc.tracks, playhead, excludeIds: current.mode === 'move' ? current.ids : [current.clipId] }),
        toleranceSec: SNAP_THRESHOLD_PX / current.pps,
      }
      : undefined;
    const rows = tlRef.current?.querySelectorAll<HTMLElement>('.tl-lane[data-track-index]');
    const hit = Array.from(rows ?? []).find((row) => {
      const box = row.getBoundingClientRect();
      return event.clientY >= box.top && event.clientY < box.bottom;
    });
    const track = hit?.dataset.trackIndex;
    const targetTrack = track === 'S' ? -1 : track === undefined ? current.track : Number(track);
    const protectedIds = listAppliedTransitions(doc).flatMap((item: { from: string; to: string }) => [item.from, item.to]);
    const plan = current.mode === 'move'
      ? planSelectionMove({
        tracks: doc.tracks, ids: current.ids, anchorId: current.clipId, targetTrack, deltaPx,
        pxPerSecond: current.pps, fps: doc.fps, magnetic, protectedIds, copy: current.copy,
      })
      : (current.retime ? planSpeedEdge : planTrim)({
        clip: current.clip, track: current.track, edge: current.mode, deltaPx, pxPerSecond: current.pps,
        fps: doc.fps, snap: true, magnetic,
        sourceEnd: props.sourceDurations?.[current.clip.src.split('#')[0] ?? ''],
      });
    let rejection = 'message' in plan ? String(plan.message ?? '') : '';
    const placement = plan.placed[current.clipId];
    if (current.mode !== 'move' && hasClipKeyframes(current.clip) && plan.ops.length > 0) {
      rejection = '此片段含关键帧，需先处理动画关键帧再调整边缘';
    }
    if (current.mode !== 'move' && protectedIds.includes(current.clipId) && plan.ops.length > 0) {
      rejection = '请先移除相连的转场，再调整片段边缘';
    }
    if (current.mode !== 'move' && placement && doc.tracks.find(row => row.index === current.track)?.clips.some(other => {
      if (other.id === current.clipId) return false;
      const span = clipSpan(other);
      const initial = clipSpan(current.clip);
      return Math.min(placement.end, span.end) - Math.max(placement.start, span.start) >
        Math.max(0, Math.min(initial.end, span.end) - Math.max(initial.start, span.start)) + 0.001;
    })) rejection = '此侧有相邻片段，无法继续延长';
    let ops = plan.ops as EditOp[];
    if (current.copy && !rejection && placement) {
      const clipboard = copyTimelineClips({ doc, ids: current.ids });
      if (clipboard.ok) {
        const placed = Object.values(plan.placed).filter(item => item !== null);
        const pasted = planTimelineAction({
          doc, action: 'paste', at: Math.min(...placed.map(item => item.start)),
          track: Math.min(...placed.map(item => item.track)), clipboard: clipboard.clipboard,
        });
        if (pasted.ok) {
          ops = pasted.ops as EditOp[];
        } else rejection = pasted.message ?? '此处无法复制';
      } else rejection = clipboard.message;
    }
    update({ ...current, moved, plan: { ops }, preview: rejection ? {} : plan.placed,
      guide: rejection ? null : plan.guide ?? null, rejection });
  }

  function onClipUp(event: ReactPointerEvent<HTMLDivElement>): void {
    const current = dragRef.current;
    if (current === null || current.pointer !== event.pointerId) return;
    update(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (current.doc !== doc || props.busy) return;
    if (!current.moved) {
      if (!event.shiftKey && selection.length > 1) props.onSelect([current.clipId], false);
      return;
    }
    if (current.rejection) { editRejectRef.current?.(current.rejection); return; }
    const ops = current.plan?.ops ?? [];
    if (ops.length > 0) void opsRef.current(ops, current.label);
  }

  function cancelClipDrag(event: ReactPointerEvent<HTMLDivElement>): void {
    if (dragRef.current?.pointer === event.pointerId) update(null);
  }

  /* ── 音频手势（M31）：淡变圆柄 / 音量线 ─────────────────────────────────
   *
   * 三者共用一条纪律：**拖动中只本地预览，松手才发一批 Op**。
   * 夹到边界时不静默——`onAudioNotice` 把「最多 x.xxs」说给用户。
   */

  /**
   * 音频控件（圆柄/音量线）也会被点：点它们不该把多选拆掉。
   * 已经在选中集合里就什么都不做；不在就按当前修饰键（Shift/Cmd）加选。
   */
  function selectIfNeeded(clipId: string, additive: boolean): void {
    if (selection.includes(clipId)) return;
    props.onSelect([clipId], additive);
  }

  /** @param {ReactPointerEvent<HTMLElement>} event @param {Clip} clip @param {Track} track @param {'in'|'out'} edge */
  function onFadeDown(event: ReactPointerEvent<HTMLElement>, clip: Clip, track: Track, edge: 'in' | 'out'): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (rejectLocked(track.index, '改淡变')) return;
    const [fadeIn, fadeOut] = effectiveFade(clip);
    selectIfNeeded(clip.id, event.shiftKey || event.metaKey || event.ctrlKey);
    event.currentTarget.setPointerCapture(event.pointerId);
    const next = {
      kind: 'fade' as const,
      clipId: clip.id,
      edge,
      startX: event.clientX,
      start: edge === 'in' ? fadeIn : fadeOut,
      current: edge === 'in' ? fadeIn : fadeOut,
      moved: false,
      clamped: false,
    };
    audioDragRef.current = next;
    setAudioDrag(next);
  }

  /** @param {ReactPointerEvent<HTMLElement>} event @param {Clip} clip */
  function onFadeMove(event: ReactPointerEvent<HTMLElement>, clip: Clip): void {
    const current = audioDragRef.current;
    if (current === null || current.kind !== 'fade' || current.clipId !== clip.id) return;
    const deltaSeconds = (event.clientX - current.startX) / pps;
    // 往里拖才是「加长」：淡入向右、淡出向左。
    const wanted = current.start + (current.edge === 'in' ? deltaSeconds : -deltaSeconds);
    const planned = clampFadeEdge(clip, current.edge, wanted);
    const next = {
      ...current,
      current: current.edge === 'in' ? planned.fade[0] : planned.fade[1],
      moved: current.moved || Math.abs(event.clientX - current.startX) > 2,
      clamped: planned.clamped,
    };
    audioDragRef.current = next;
    setAudioDrag(next);
  }

  /** @param {ReactPointerEvent<HTMLElement>} event @param {Clip} clip */
  function onFadeUp(event: ReactPointerEvent<HTMLElement>, clip: Clip): void {
    const current = audioDragRef.current;
    audioDragRef.current = null;
    setAudioDrag(null);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // 指针已经不在元素上（cancel 之后），忽略。
    }
    if (current === null || current.kind !== 'fade' || !current.moved) return;
    const limit = fadeLimit(clip, current.edge, effectiveFade(clip));
    if (current.clamped) {
      // 面板里留一句（toast 会被「已落盘」覆盖，所以原因也写进 Op 的 label）。
      audioNoticeRef.current?.(`淡变最多 ${num(limit, 2)}s（片段时长/源区间的一半，另一侧已占用的会扣掉），已夹到 ${num(current.current, 2)}s`);
    }
    if (Math.abs(current.current - current.start) < 1e-9) return;
    const planned = planFadeOps([{ id: clip.id, clip }], current.edge, current.current);
    if (planned.ops.length === 0) return;
    const suffix = current.clamped ? `（已夹到上限 ${num(limit, 2)}s）` : '';
    void opsRef.current(planned.ops as EditOp[], `${current.edge === 'in' ? '淡入' : '淡出'} ${num(current.current, 2)}s${suffix}`);
  }

  /** 双击圆柄：淡变回 0（两侧一起，界面上就一个「淡变」概念）。 */
  function resetFade(clip: Clip): void {
    if (rejectLocked(trackIndexOfClip(clip.id), '改淡变')) return;
    const planned = planResetOps([{ id: clip.id, clip }], 'fade');
    if (planned.ops.length === 0) return;
    void opsRef.current(planned.ops as EditOp[], '淡变归零');
  }

  /** @param {string} clipId */
  function trackIndexOfClip(clipId: string): number {
    for (const track of doc.tracks) {
      if (track.clips.some((clip) => clip.id === clipId)) return track.index;
    }
    return -1;
  }

  /** @param {ReactPointerEvent<HTMLElement>} event @param {Clip} clip @param {Track} track */
  function onVolumeDown(event: ReactPointerEvent<HTMLElement>, clip: Clip, track: Track): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (rejectLocked(track.index, '改音量')) return;
    selectIfNeeded(clip.id, event.shiftKey || event.metaKey || event.ctrlKey);
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = effectiveVolume(clip);
    const next = {
      kind: 'volume' as const,
      clipId: clip.id,
      startY: event.clientY,
      start,
      current: start,
      moved: false,
      clamped: false,
    };
    audioDragRef.current = next;
    setAudioDrag(next);
  }

  /** @param {ReactPointerEvent<HTMLElement>} event @param {Clip} clip @param {number} height 片段高度（px） */
  function onVolumeMove(event: ReactPointerEvent<HTMLElement>, clip: Clip, height: number): void {
    const current = audioDragRef.current;
    if (current === null || current.kind !== 'volume' || current.clipId !== clip.id) return;
    const dy = event.clientY - current.startY;
    const span = height > 4 ? height : 30;
    // 全高 = 整个刻度（0…2），往上拖变大。
    const wanted = current.start - (dy / span) * VOLUME_MAX;
    const clamped = clampVolume(wanted);
    const next = {
      ...current,
      current: clamped,
      moved: current.moved || Math.abs(dy) > 2,
      clamped: Math.abs(clamped - wanted) > 1e-9,
    };
    audioDragRef.current = next;
    setAudioDrag(next);
  }

  /** @param {ReactPointerEvent<HTMLElement>} event @param {Clip} clip */
  function onVolumeUp(event: ReactPointerEvent<HTMLElement>, clip: Clip): void {
    const current = audioDragRef.current;
    audioDragRef.current = null;
    setAudioDrag(null);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // 同上
    }
    if (current === null || current.kind !== 'volume' || !current.moved) return;
    if (current.clamped) {
      audioNoticeRef.current?.(`音量刻度是 0–${VOLUME_MAX}（${formatVolumeDb(VOLUME_MAX)}），已夹到 ${num(current.current, 2)}`);
    }
    if (Math.abs(current.current - current.start) < 1e-9) return;
    const planned = planVolumeOps([{ id: clip.id, clip }], current.current);
    if (planned.ops.length === 0) return;
    const suffix = current.clamped ? `（已夹到 ${num(current.current, 2)}）` : '';
    void opsRef.current(planned.ops as EditOp[], `音量 ${num(current.current, 2)}（${formatVolumeDb(current.current)}）${suffix}`);
  }

  /** 双击音量线：回 1.0（默认）。 */
  function resetVolume(clip: Clip): void {
    if (rejectLocked(trackIndexOfClip(clip.id), '改音量')) return;
    const planned = planResetOps([{ id: clip.id, clip }], 'volume');
    if (planned.ops.length === 0) return;
    void opsRef.current(planned.ops as EditOp[], '音量回默认');
  }

  /** 字幕块按下：选中 + 开始拖。 */
  function onCueDown(event: ReactPointerEvent<HTMLButtonElement>, index: number): void {
    if (event.button !== 0) return;
    const lane = props.subtitle;
    if (lane === undefined) return;
    const cue = lane.cues[index];
    if (cue === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    lane.onSelect(index);
    if (lane.busy) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const next = { index, startX: event.clientX, start: cue.start, end: cue.end, previewStart: cue.start, previewEnd: cue.end, moved: false };
    cueDragRef.current = next;
    setCueDrag(next);
  }

  function onCueMove(event: ReactPointerEvent<HTMLButtonElement>): void {
    const current = cueDragRef.current;
    if (current === null || props.subtitle === undefined) return;
    const delta = (event.clientX - current.startX) / pps;
    const length = current.end - current.start;
    const start = Math.max(0, snapSecondsToFrame(current.start + delta, props.subtitle.fps));
    const end = snapSecondsToFrame(start + length, props.subtitle.fps);
    const next = { ...current, previewStart: start, previewEnd: end, moved: current.moved || Math.abs(delta) > 0.5 / pps };
    cueDragRef.current = next;
    setCueDrag(next);
  }

  function onCueUp(event: ReactPointerEvent<HTMLButtonElement>): void {
    const current = cueDragRef.current;
    cueDragRef.current = null;
    setCueDrag(null);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // 指针已经不在这个元素上（取消之后），释放失败可以忽略。
    }
    if (current === null || !current.moved || props.subtitle === undefined) return;
    if (current.previewStart === current.start && current.previewEnd === current.end) return;
    props.subtitle.onMove(current.index, current.previewStart, current.previewEnd);
  }


  /* ── 转场块（M25）──────────────────────────────────────────────
   * 块的左边缘 = 后段 `at`，右边缘 = 前段结束；拖哪个边就只改那个边。
   * 拖的时候先画 preview（松手前就能看见），松手才把那一批 Op 发出去。
   */

  /** @param {ReactPointerEvent<HTMLDivElement>} event @param {TransitionView} transition @param {'start'|'end'} edge */
  function onTransitionDown(event: ReactPointerEvent<HTMLDivElement>, transition: TransitionView, edge: 'start' | 'end'): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (rejectLocked(transition.trackIndex, '调转场')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    props.onTransitionSelect?.(transition.id);
    const next = { id: transition.id, edge, startX: event.clientX, pps, moved: false, preview: null, plan: null };
    tDragRef.current = next;
    setTDrag(next);
  }

  /** @param {ReactPointerEvent<HTMLDivElement>} event */
  function onTransitionMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const current = tDragRef.current;
    if (current === null) return;
    const transition = (props.transitions ?? []).find((item) => item.id === current.id);
    if (transition === undefined) return;
    const deltaSec = (event.clientX - current.startX) / current.pps;
    const preset = transition.presetId ? planResizeTransitionPreset({ doc, transitionId: transition.id, duration: Math.max(1 / (doc.fps.num/doc.fps.den), transition.duration + (current.edge === 'end' ? deltaSec : -deltaSec)) }) : null;
    const plan = preset ? { ...preset, next: {start: preset.transition?.start ?? transition.start, end: preset.transition?.end ?? transition.end}, limited: null, message: preset.message ?? '' } : planTransitionResize({ transition, edge: current.edge, deltaSec, fps: doc.fps });
    const moved = current.moved || Math.abs(event.clientX - current.startX) > 2;
    const next = {
      ...current,
      moved,
      preview: plan.ok ? { start: plan.next.start, end: plan.next.end } : current.preview,
      plan: { ops: plan.ops as EditOp[], limited: plan.limited ?? null, message: plan.message ?? '' },
    };
    tDragRef.current = next;
    setTDrag(next);
  }

  /** @param {ReactPointerEvent<HTMLDivElement>} event */
  function onTransitionUp(event: ReactPointerEvent<HTMLDivElement>): void {
    const current = tDragRef.current;
    tDragRef.current = null;
    setTDrag(null);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // 指针已经不在这个元素上（取消之后），释放失败可以忽略。
    }
    if (current === null || !current.moved || current.plan === null) return;
    if (current.plan.ops.length === 0) {
      if (current.plan.message !== '') props.onTransitionReject?.(current.plan.message);
      return;
    }
    void opsRef.current(current.plan.ops, current.edge === 'start' ? '转场调长（左）' : '转场调长（右）');
    // 到边界时 Op 已经夹到边界值，仍要把「为什么停在这」说出来。
    if (current.plan.limited !== null && current.plan.message !== '') props.onTransitionReject?.(current.plan.message);
  }

  /** @param {TransitionView} transition */
  function removeTransition(transition: TransitionView): void {
    if (rejectLocked(transition.trackIndex, '移除转场')) return;
    const plan = transition.presetId ? planRemoveTransitionPreset({ doc, transitionId: transition.id }) : planTransitionRemove({ transition });
    if (plan.ok !== true) {
      props.onTransitionReject?.('message' in plan ? String(plan.message) : '无法移除此转场');
      return;
    }
    props.onTransitionSelect?.(null);
    void opsRef.current(plan.ops as EditOp[], '移除转场');
  }


  /** @param {ReactPointerEvent<HTMLDivElement>} event @param {number} trackIndex @param {number} height */
  function onLaneResizeDown(event: ReactPointerEvent<HTMLDivElement>, trackIndex: number, height: number): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const next = { index: trackIndex, startY: event.clientY, startHeight: height, height };
    laneDragRef.current = next;
    setLaneDrag(next);
  }

  /** @param {ReactPointerEvent<HTMLDivElement>} event */
  function onLaneResizeMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const current = laneDragRef.current;
    if (current === null) return;
    // 向下拖 = 变高；夹在 28–160 之间（参照 ZMe/JMe：再小放不下名字，再大一条轨占满屏）。
    const height = clampTrackHeight(current.startHeight + (event.clientY - current.startY));
    if (height === current.height) return;
    const next = { ...current, height };
    laneDragRef.current = next;
    setLaneDrag(next);
  }

  /** @param {ReactPointerEvent<HTMLDivElement>} event */
  function onLaneResizeUp(event: ReactPointerEvent<HTMLDivElement>): void {
    const current = laneDragRef.current;
    laneDragRef.current = null;
    setLaneDrag(null);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // 指针已经不在这个元素上（取消之后），释放失败可以忽略。
    }
    if (current === null) return;
    props.trackHeight?.onChange(current.index, current.height);
  }

  /* E08（R18）：类型标签 = 类型字母 + **该类型内**的序号，从下往上数（最下面那条是 1）。
     画轨（page / picture / video / still）用 V、音轨用 A —— 参照是 `V2 / V1 / A1`：
     同一个 V 组里，越靠上的序号越大。E02 当时把这行整条去掉了，是错的（书里已更正）。 */
  const trackLabels = new Map<number, string>();
  for (const letter of ['V', 'A'] as const) {
    doc.tracks
      .filter((track) => (letter === 'V' ? track.role !== 'audio' : track.role === 'audio'))
      .slice()
      .sort((a, b) => b.index - a.index)
      .forEach((track, position) => trackLabels.set(track.index, `${letter}${position + 1}`));
  }

  const lanes = doc.tracks.map((track) => {
    const laneTransitions = (props.transitions ?? []).filter((item) => item.trackIndex === track.index);
    const missing = new Set(props.missingClips ?? []);
    // —— 轨道高度（M36）：拖动中的高度优先（本地即时），否则读宿主给的表 ——
    const baseHeight = rowHeight(props.trackHeight?.heights ?? {}, track, props.mainTrack);
    const dragged = laneDrag !== null && laneDrag.index === track.index ? laneDrag.height : null;
    const laneHeight = dragged === null ? baseHeight : dragged;
    const clipHeight = clipHeightOf(laneHeight);
    const activePreset = presetOf(laneHeight);
    // 三档密度：28 档两行各 12px，44 档各 16px，72 档放大到 18px（都不裁、不叠）。
    const density = laneHeight <= 32 ? 'compact' : laneHeight >= 60 ? 'roomy' : 'normal';
    const soloed = soloTracks.has(track.index);
    const trackLabel = trackLabels.get(track.index) ?? `T${track.index}`;
    const trackTitle = [trackLabel, props.mainTrack === track.index ? '主轨' : '', track.name ?? track.role].filter(Boolean).join(' · ');
    /**
     * 轨道开关（M38）：前三个写回 film.html（一次 /ops、一步撤销），
     * 独奏只是视图态（不进文档，导出看不到）。
     */
    /* E08（R19）：动作按**这条轨会不会出声**裁剪、顺序照参照的**左→右**抄
       （ref/REF-trackhead-zoom.png）：
         有声音的轨（音频 / 带原声的视频）= 锁 → 眼 → 喇叭 → S 四个；
         不出声的轨（网页 / 图片 / 空轨）      = 锁 → 眼 两个。
       不是「按 role 一刀切」——参照的 V1 是**有原声的视频轨**所以有四个，
       网页轨没有喇叭/S 是因为它不发声，不是因为它是"画面轨"。
       R18 当时写成「喇叭 → 眼 → 锁 → S」，与参照左右顺序不符。 */
    const hasSound = trackHasSound(track);
    /* R20（B3）：喇叭的显示条件 = **有声 || 已 muted**。
       手写的 muted 若落在不出声的轨上（网页/图片轨），只按 hasSound 判会把喇叭藏起来，
       界面上就没有取消入口、解析层也只能悄悄留着这个状态。让它自己触发喇叭显示，
       既不改解析、也不在 dock 加控件，还永远留着一条能取消的路。
       S（独奏）仍然只给有声轨 —— 对不发声的轨独奏没有意义。 */
    const showSpeaker = hasSound || track.muted === true;
    const flagButtons: Array<{ field: 'muted' | 'hidden' | 'locked'; on: boolean; title: string }> = [
      { field: 'locked', on: track.locked === true, title: '锁定此轨：禁止拖动 / 裁剪 / 改属性（写回 film.html 的 locked）' },
      { field: 'hidden', on: track.hidden === true, title: '关闭此轨：不出画面也不出声（写回 film.html 的 hidden；导出整条跳过）' },
      ...(showSpeaker
        ? [{ field: 'muted' as const, on: track.muted === true, title: '静音此轨：预览与导出都不出声（写回 film.html 的 muted）' }]
        : []),
    ];
    return h(
      'div',
      {
        className: `tl-lane${track.locked === true ? ' locked' : ''}`,
        key: `track-${track.index}`,
        'data-track-index': String(track.index),
        /* 主轨与波纹删除取同一索引，轨头和轨身共享底色。 */
        'data-main-track': props.mainTrack === track.index ? 'true' : 'false',
        'data-lane-height': String(laneHeight),
        style: { '--lane-h': `${laneHeight}px` },
      },
      h(
        'div',
        {
          className: 'tl-lane-head tl-lane-head-track',
          'data-testid': `track-head-${track.index}`,
          'data-density': density,
          /* E08（R18）：类型标签回来了，但换成 `V{n}` / `A{n}`（见上面 trackLabels）。
             `.tl-lane-role`（page/picture/audio）仍然 display:none —— 量测脚本靠它认轨
             （uir-dmap-scan 的 D55–D58、s119 的 trackhead.roles），删节点会让扫描读到 null。
             `data-track-sound`（E08/R19）：这一轨**判定为会不会出声**，决定有没有喇叭/S。
             写进 DOM 是为了让「按类型猜」变成可核对的事实（取证脚本与交接都读它）。 */
          title: trackTitle,
          'aria-label': trackTitle,
          'data-track-sound': hasSound ? 'true' : 'false',
          'data-track-role': track.role,
        },
        h(
          'div',
          { className: 'tl-lane-line' },
          h('span', { className: 'tl-lane-index' }, trackLabel),
          h(
            'span',
            { className: 'tl-lane-role', 'data-testid': `track-role-${track.index}`, title: track.name ?? track.role },
            track.role || '—',
          ),
          // 档位菜单（R20 照参照）：三档 = 小/中/大；拖过下沿就是自定义，显示不带单位的整数。
          h(
            'select',
            {
              className: 'tl-height-select',
              'data-testid': `track-height-${track.index}`,
              'data-height': String(laneHeight),
              'data-preset': activePreset ?? 'custom',
              /* R20：参照 `trackHeight:"Track height"` / `size:{small,medium,large}`；
                 面板上**不显示像素数**，完整值（px + 档位名）只在 title 里。
                 R19 之前这里是「76px」，46px 宽的下拉把它截成「76p」。 */
              title: `轨道高度 ${laneHeight}px（${activePreset === null ? '自定义' : TRACK_HEIGHT_LABELS[activePreset]}）· 拖下沿改高度，双击回默认`,
              'aria-label': `T${track.index} 轨道高度 ${laneHeight} 像素`,
              value: activePreset ?? 'custom',
              onChange: (event: { target: { value: string } }) => {
                const value = event.target.value;
                if (value === 'custom') return;
                const preset = TRACK_HEIGHT_PRESETS.find((item) => item === value);
                if (preset === undefined) return;
                props.trackHeight?.onChange(track.index, TRACK_HEIGHTS[preset]);
              },
            },
            TRACK_HEIGHT_PRESETS.map((preset) =>
              h('option', { key: preset, value: preset }, TRACK_HEIGHT_LABELS[preset]),
            ),
            /* 自定义档只写整数（`76`），不带 px；选中档位时这一项只是「拖出来会进这里」的入口。 */
            h('option', { key: 'custom', value: 'custom' }, String(laneHeight)),
          ),
        ),
        h(
          'div',
          { className: 'tl-lane-line tl-lane-switches' },
          flagButtons.map((flag) =>
            h(
              'button',
              {
                key: flag.field,
                type: 'button',
                className: 'tl-flag',
                'data-testid': `track-${flag.field === 'muted' ? 'mute' : flag.field === 'hidden' ? 'hidden' : 'lock'}-${track.index}`,
                'data-on': flag.on ? 'true' : 'false',
                'aria-pressed': flag.on,
                title: flag.title,
                onClick: () => props.trackControls?.onFlag(track.index, flag.field),
              },
              flagIcon(flag.field, flag.on),
            ),
          ),
          /* E08（R19）：独奏只给**发声轨**（参照的 V2 没有 S）。 */
          hasSound
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'tl-flag solo',
                  'data-testid': `track-solo-${track.index}`,
                  'data-on': soloed ? 'true' : 'false',
                  'aria-pressed': soloed,
                  title: '独奏：只听这条轨（⌥ 点击 = 只听这一条；视图态，不写 film.html，导出不看独奏）',
                  onClick: () => props.trackControls?.onSolo(track.index),
                },
                flagIcon('solo'),
              )
            : null,
        ),
      ),
      h(
        'div',
        { className: 'tl-lane-clips', 'data-testid': `lane-${track.index}` },
        track.clips.length === 0 ? h('div', { className: 'tl-empty-lane' }, '空轨') : null,
        track.clips.map((clip) => {
          const span = clipSpan(clip);
          const mousePreview = drag?.preview[clip.id] ?? null;
          const touch = touchPreview !== null && touchPreview.clipId === clip.id ? touchPreview : null;
          const preview = mousePreview ?? touch;
          const start = preview === null ? span.start : preview.start;
          const end = preview === null ? span.end : preview.end;
          const selected = selection.includes(clip.id);
          const gone = missing.has(clip.id);
          const clipWidth = Math.max(6, (end - start) * pps);
          const style: CSSProperties = { left: `${start * pps}px`, width: `${clipWidth}px`, height: `${clipHeight}px` };
          if (mousePreview !== null && mousePreview.track !== track.index) {
            const tops = laneTopOf(props.trackHeight?.heights ?? {}, doc.tracks, props.mainTrack);
            style.transform = `translateY(${(tops.get(mousePreview.track) ?? 0) - (tops.get(track.index) ?? 0)}px)`;
            style.zIndex = 8;
          }
          // —— 音频手势（M31）：拖动中显示的是本地预览值，松手才落盘 ——
          const activeFade = audioDrag !== null && audioDrag.kind === 'fade' && audioDrag.clipId === clip.id ? audioDrag : null;
          const activeVolume = audioDrag !== null && audioDrag.kind === 'volume' && audioDrag.clipId === clip.id ? audioDrag : null;
          const [baseIn, baseOut] = effectiveFade(clip);
          const fadeIn = activeFade !== null && activeFade.edge === 'in' ? activeFade.current : baseIn;
          const fadeOut = activeFade !== null && activeFade.edge === 'out' ? activeFade.current : baseOut;
          const isSound = kindOf(clip) === 'sound';
          const clipVolume = activeVolume === null ? effectiveVolume(clip) : activeVolume.current;
          // —— 波形（M34）：片段底部 34% 的一条，裁剪/变速都按源区间对齐 ——
          const waveBase = props.waveform?.fileBase ?? '';
          const waveUrl = isSound && waveBase !== '' ? waveformUrlOf(waveBase, clip.src) : '';
          const waveWidth = Math.max(0, clipWidth - 2);
          // 波形占片段底部 33%；片段高度随轨道高度走（M36），所以波形也跟着长。
          const waveHeight = Math.max(6, Math.round(clipHeight * WAVE_RATIO));
          const sourceIn = Array.isArray(clip.time) ? Number(clip.time[0]) || 0 : 0;
          const sourceOut = Array.isArray(clip.time) && Number.isFinite(Number(clip.time[1])) ? Number(clip.time[1]) : Number.POSITIVE_INFINITY;
          const handleMax = Math.max(0, clipWidth - 11);
          const fadeInLeft = Math.min(Math.max(0, fadeIn * pps), handleMax);
          const fadeOutRight = Math.min(Math.max(0, fadeOut * pps), handleMax);
          // Video and sandboxed scene thumbnails both sample clip-relative source time.
          const stripBase = props.filmstrip?.base ?? '';
          const stripKind = kindOf(clip);
          const strip =
            stripBase !== '' && !gone && (stripKind === 'video' || stripKind === 'still') && clipHeight - 15 >= 9
              ? h(Filmstrip, {
                  key: `strip-${clip.id}`,
                  base: stripBase,
                  src: clip.src,
                  clipId: clip.id,
                  width: clipWidth,
                  pps,
                  speed: Number(clip.speed ?? 1) || 1,
                  sourceIn,
                  sourceOut,
                })
              : stripKind === 'page' && !gone && !isClipDisabled(clip) && props.projectId && clipHeight - 15 >= 9 && clipWidth >= 24
                ? h(SceneFilmstrip, {
                    projectId: props.projectId, src: clip.src, width: clipWidth, height: clipHeight - 15,
                    pps, speed: Number(clip.speed ?? 1) || 1, sourceIn, sourceOut,
                  })
                : null;
          return h(
            'div',
            {
              key: clip.id,
              className: `tl-clip kind-${kindOf(clip)}${selected ? ' selected' : ''}${gone ? ' missing' : ''}${isClipDisabled(clip) ? ' oc-clip-disabled' : ''}${props.speedEdgeClip === clip.id ? ' oc-clip-speed' : ''}${clip.muted === true ? ' muted' : ''}${waveUrl === '' ? '' : ' has-wave'}`,
              style,
              'data-clip-id': clip.id,
              'data-clip-kind': kindOf(clip),
              'data-clip-at': num(Number(clip.at ?? 0)),
              'data-clip-missing': gone ? '1' : '0',
              tabIndex: selected ? 0 : -1,
              'aria-label': `片段 ${clip.id}`,
              onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
                if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
                event.preventDefault();
                event.stopPropagation();
                const bounds = event.currentTarget.getBoundingClientRect();
                openContextMenu(event.currentTarget, bounds.left, bounds.top + bounds.height);
              },
              title: gone ? `${clip.id} · ${clip.src}\n素材文件不在了：右键/素材库角标里重链` : `${clip.id} · ${clip.src}`,
              onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => onClipDown(event, clip, track),
              onPointerMove: onClipMove,
              onPointerUp: onClipUp,
              onPointerCancel: cancelClipDrag,
              onLostPointerCapture: cancelClipDrag,
            },
            strip,
            waveUrl === ''
              ? null
              : h(WaveformLayer, {
                  key: `wave-${clip.id}`,
                  url: waveUrl,
                  src: clip.src,
                  width: waveWidth,
                  height: waveHeight,
                  volume: clipVolume,
                  muted: clip.muted === true,
                  clipStart: sourceIn,
                  clipEnd: sourceOut,
                }),
            clipMarkersOf(clip).map(marker => {
              const time = timelineTimeOfClipMarker(clip, marker);
              if (time === null) return null;
              return h('button', {
                type: 'button', className: 'oc-clip-marker', key: marker.id,
                style: { left: `${(time - span.start) * pps}px` },
                title: marker.name ?? '片段标记', 'aria-label': marker.name ?? '片段标记',
                onPointerDown: (event: ReactPointerEvent) => event.stopPropagation(),
                onClick: (event: ReactMouseEvent) => { event.stopPropagation(); props.onPlayhead(time); },
              });
            }),
            h('span', { className: 'tl-clip-handle left' }),
            h('span', { className: 'tl-clip-handle right' }),
            gone ? h('span', { className: 'tl-clip-warn', 'data-testid': 'clip-missing-badge', title: '素材缺失' }, '⚠') : null,
            isSound && clip.muted === true
              ? h('span', { className: 'tl-clip-mute', 'data-testid': 'clip-mute-badge', title: 'muted：静音开关（volume 没变）' }, 'M')
              : null,
            fadeIn > 0 ? h('span', { className: 'tl-fade-shade in', style: { width: `${Math.min(clipWidth, fadeIn * pps)}px` } }) : null,
            fadeOut > 0 ? h('span', { className: 'tl-fade-shade out', style: { width: `${Math.min(clipWidth, fadeOut * pps)}px` } }) : null,
            isSound
              ? h('span', {
                  className: 'tl-clip-vol',
                  style: { top: `${(1 - Math.min(VOLUME_MAX, Math.max(0, clipVolume)) / VOLUME_MAX) * 100}%` },
                  'data-testid': 'clip-volume-line',
                  'data-clip': clip.id,
                  'data-volume': num(clipVolume, 2),
                  title: `音量 ${num(clipVolume, 2)}（${formatVolumeDb(clipVolume)}）\n上下拖动改音量，双击回 1.0`,
                  onPointerDown: (event: ReactPointerEvent<HTMLSpanElement>) => onVolumeDown(event, clip, track),
                  // 片高随轨道高度变（M36）：灵敏度按当前片高算，别写死 30。
                  onPointerMove: (event: ReactPointerEvent<HTMLSpanElement>) => onVolumeMove(event, clip, clipHeight),
                  onPointerUp: (event: ReactPointerEvent<HTMLSpanElement>) => onVolumeUp(event, clip),
                  onPointerCancel: (event: ReactPointerEvent<HTMLSpanElement>) => onVolumeUp(event, clip),
                  onDoubleClick: (event: { preventDefault: () => void; stopPropagation: () => void }) => {
                    event.preventDefault();
                    event.stopPropagation();
                    resetVolume(clip);
                  },
                })
              : null,
            activeVolume === null
              ? null
              : h('span', { className: 'tl-clip-vol-badge', 'data-testid': 'clip-volume-badge' }, `${num(activeVolume.current, 2)}×`),
            h('span', {
              className: 'tl-fade-handle in',
              style: { left: `${fadeInLeft}px` },
              'data-testid': 'clip-fade-in',
              'data-clip': clip.id,
              'data-fade': num(fadeIn, 2),
              title: `淡入 ${num(fadeIn, 2)}s（向内拖加长，双击归零）`,
              onPointerDown: (event: ReactPointerEvent<HTMLSpanElement>) => onFadeDown(event, clip, track, 'in'),
              onPointerMove: (event: ReactPointerEvent<HTMLSpanElement>) => onFadeMove(event, clip),
              onPointerUp: (event: ReactPointerEvent<HTMLSpanElement>) => onFadeUp(event, clip),
              onPointerCancel: (event: ReactPointerEvent<HTMLSpanElement>) => onFadeUp(event, clip),
              onDoubleClick: (event: { preventDefault: () => void; stopPropagation: () => void }) => {
                event.preventDefault();
                event.stopPropagation();
                resetFade(clip);
              },
            }),
            h('span', {
              className: 'tl-fade-handle out',
              style: { right: `${fadeOutRight}px` },
              'data-testid': 'clip-fade-out',
              'data-clip': clip.id,
              'data-fade': num(fadeOut, 2),
              title: `淡出 ${num(fadeOut, 2)}s（向内拖加长，双击归零）`,
              onPointerDown: (event: ReactPointerEvent<HTMLSpanElement>) => onFadeDown(event, clip, track, 'out'),
              onPointerMove: (event: ReactPointerEvent<HTMLSpanElement>) => onFadeMove(event, clip),
              onPointerUp: (event: ReactPointerEvent<HTMLSpanElement>) => onFadeUp(event, clip),
              onPointerCancel: (event: ReactPointerEvent<HTMLSpanElement>) => onFadeUp(event, clip),
              onDoubleClick: (event: { preventDefault: () => void; stopPropagation: () => void }) => {
                event.preventDefault();
                event.stopPropagation();
                resetFade(clip);
              },
            }),
            activeFade === null ? null : h('span', { className: 'tl-fade-badge', 'data-testid': 'clip-fade-badge' }, `${num(activeFade.current, 2)}s`),
            /* E03（R17）：参照是一条胶囊「`scene-a 4.0s`」——名字在前、时长在后（间隔 4px）。
               R16 时名字在胶囊里、`at 0 · 4s` 还在片段里，是两条；现在并成一条，
               片段内的第二行只留 vol / 变速 / muted 这些附加项（全空就不渲染）。
               窄片段（< 72px）放不下两段：先舍时长、保住名字 —— 否则 sfx（51px）
               的胶囊会只剩「0.8s」，片段反而认不出来。 */
            h(
              'span',
              { className: 'tl-clip-name' },
              h('span', { className: 'tl-clip-name-text' }, clip.attrs?.['data-creation-name'] || clip.id),
              clipWidth >= 72 ? h('span', { className: 'tl-clip-dur' }, clipDurationLabel(clip)) : null,
            ),
            // 紧凑档（片高 < 24px）放不下第二行：只留胶囊，别让 meta 被裁成半截压在波形上。
            clipHeight >= 24 && metaOf(clip) !== '' ? h('span', { className: 'tl-clip-meta' }, metaOf(clip)) : null,
          );
        }),
        (props.cuts ?? [])
          .filter((cut) => cut.trackIndex === track.index && cut.canCreate)
          .map((cut) =>
            h(
              'button',
              {
                key: `cut-${cut.id}`,
                type: 'button',
                className: 'tl-cut-add',
                style: { left: `${cut.at * pps - 9}px` },
                'data-testid': 'cut-add-transition',
                'data-cut-id': cut.id,
                'data-cut-at': num(cut.at),
                'data-cut-room': num(cut.room),
                title: `${cut.from.id} → ${cut.to.id}\n加交叉溶解（默认 0.5s，最多 ${num(cut.room, 2)}s）${cut.audioToId !== null && cut.audioFromId !== null ? ' · 声音同步交叉' : ''}`,
                onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
                  event.preventDefault();
                  event.stopPropagation();
                },
                onClick: (event: { preventDefault: () => void; stopPropagation: () => void }) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (rejectLocked(track.index, '加转场')) return;
                  props.onAddTransition?.(cut);
                },
              },
              '+',
            ),
          ),
        laneTransitions.map((transition) => {
          const dragging = tDrag !== null && tDrag.id === transition.id;
          const start = dragging && tDrag.preview !== null ? tDrag.preview.start : transition.start;
          const end = dragging && tDrag.preview !== null ? tDrag.preview.end : transition.end;
          const active = props.activeTransitionId === transition.id;
          const shape = transition.doubleSided ? 'double' : 'single';
          const title = [
            `${transition.from.id} → ${transition.to.id}`,
            `重叠 ${num(end - start, 2)}s · ${transition.doubleSided ? '两侧淡（兼容）' : '单边淡（上层）'}`,
            transition.crossfadeOk ? '' : '上层没有 fade：溶不起来',
            active ? `可向左 ${num(transition.headroom.start, 2)}s / 向右 ${num(transition.headroom.end, 2)}s` : '',
          ]
            .filter((line) => line !== '')
            .join('\n');
          return h(
            'div',
            {
              key: `tr-${transition.id}`,
              className: `tl-transition${active ? ' selected' : ''} shape-${shape}${transition.crossfadeOk ? '' : ' broken'}`,
              style: { left: `${start * pps}px`, width: `${Math.max(10, (end - start) * pps)}px` },
              'data-testid': 'transition-block',
              'data-transition-id': transition.id,
              'data-transition-start': num(start),
              'data-transition-end': num(end),
              'data-transition-duration': num(end - start),
              'data-transition-top': transition.top,
              'data-transition-shape': shape,
              title,
              onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
                event.stopPropagation();
                props.onTransitionSelect?.(transition.id);
              },
            },
            h('span', {
              className: 'tl-transition-handle left',
              'data-testid': 'transition-handle-left',
              onPointerDown: (event: ReactPointerEvent<HTMLSpanElement>) => onTransitionDown(event as unknown as ReactPointerEvent<HTMLDivElement>, transition, 'start'),
              onPointerMove: onTransitionMove as unknown as (event: ReactPointerEvent<HTMLSpanElement>) => void,
              onPointerUp: onTransitionUp as unknown as (event: ReactPointerEvent<HTMLSpanElement>) => void,
              onPointerCancel: onTransitionUp as unknown as (event: ReactPointerEvent<HTMLSpanElement>) => void,
            }),
            h('span', { className: 'tl-transition-label' }, `转场 ${num(end - start, 2)}s`),
            h('span', {
              className: 'tl-transition-handle right',
              'data-testid': 'transition-handle-right',
              onPointerDown: (event: ReactPointerEvent<HTMLSpanElement>) => onTransitionDown(event as unknown as ReactPointerEvent<HTMLDivElement>, transition, 'end'),
              onPointerMove: onTransitionMove as unknown as (event: ReactPointerEvent<HTMLSpanElement>) => void,
              onPointerUp: onTransitionUp as unknown as (event: ReactPointerEvent<HTMLSpanElement>) => void,
              onPointerCancel: onTransitionUp as unknown as (event: ReactPointerEvent<HTMLSpanElement>) => void,
            }),
            active
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'tl-transition-remove',
                    'data-testid': 'transition-remove',
                    title: '移除转场（恢复硬切）',
                    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
                      event.preventDefault();
                      event.stopPropagation();
                    },
                    onClick: (event: { preventDefault: () => void; stopPropagation: () => void }) => {
                      event.preventDefault();
                      event.stopPropagation();
                      removeTransition(transition);
                    },
                  },
                  '×',
                )
              : null,
          );
        }),
      ),
      // 轨道下沿：拖改高度（只写 localStorage，不写 film.html）
      h('div', {
        className: 'tl-lane-resize',
        'data-testid': `track-resize-${track.index}`,
        'data-lane-height': String(laneHeight),
        /* E08（R19）：参照 `resizeTrack` = "Drag to make the track taller or shorter ·
           double-click: its usual height" —— 双击回到**这条轨的默认高度**
           （参考 track-height.ts 的 defaultHeightFor）。 */
        title: '拖我改高度 · 双击回到默认高度',
        'aria-label': `拖 T${track.index} 的下沿改高度（双击回到默认高度）`,
        onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => onLaneResizeDown(event, track.index, laneHeight),
        onPointerMove: onLaneResizeMove,
        onPointerUp: onLaneResizeUp,
        onPointerCancel: onLaneResizeUp,
        onDoubleClick: (event: { preventDefault: () => void; stopPropagation: () => void }) => {
          event.preventDefault();
          event.stopPropagation();
          props.trackHeight?.onChange(track.index, defaultHeightFor(track.role, track.index, props.mainTrack));
        },
      }),
    );
  });


  const subLane =
    !props.subtitle || (!props.subtitle.file && !props.subtitle.cues.length && !props.subtitle.skipped)
      ? null
      : h(
          'div',
          { className: 'tl-lane tl-sub-lane', 'data-track-index': 'S', 'data-testid': 'subtitle-lane' },
          h(
            'div',
            { className: 'tl-lane-head', title: 'S · 字幕', 'aria-label': 'S · 字幕' },
            h('span', { className: 'tl-lane-index' }, 'S'),
            h('span', { className: 'tl-lane-role' }, '字幕'),
            h(
              'span',
              { className: 'tl-lane-flags', 'data-testid': 'subtitle-file' },
              props.subtitle.file === null ? '无文件' : String(props.subtitle.format).toUpperCase(),
            ),
            props.subtitle.skipped > 0
              ? h('span', { className: 'tl-lane-flags', 'data-testid': 'subtitle-skipped', title: '解析时跳过的坏 cue' }, `跳过 ${props.subtitle.skipped}`)
              : null,
            props.subtitle.onStyle === undefined
              ? null
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'btn tiny',
                    'data-testid': 'subtitle-style-open',
                    title: '字幕样式（工程设置：预览实时生效，不写 film.html）',
                    onClick: (event: { preventDefault: () => void; stopPropagation: () => void }) => {
                      event.preventDefault();
                      event.stopPropagation();
                      props.subtitle?.onStyle?.();
                    },
                  },
                  '样式',
                ),
          ),
          h(
            'div',
            { className: 'tl-lane-clips', 'data-testid': 'subtitle-lane-clips' },
            props.subtitle.cues.length === 0
              ? h(
                  'div',
                  { className: 'tl-empty-lane' },
                  props.subtitle.file === null ? '没有伴生字幕（同目录放 a.vtt / a.srt）' : '这个文件里没有可用 cue',
                )
              : null,
            props.subtitle.cues.map((cue, index) => {
              const dragging = cueDrag !== null && cueDrag.index === index;
              const start = dragging ? cueDrag.previewStart : cue.start;
              const end = dragging ? cueDrag.previewEnd : cue.end;
              return h(
                'button',
                {
                  key: `cue-${index}-${cue.start}`,
                  type: 'button',
                  className: `tl-cue${props.subtitle?.activeIndex === index ? ' selected' : ''}`,
                  style: { left: `${start * pps}px`, width: `${Math.max(4, (end - start) * pps)}px` },
                  'data-cue-index': String(index),
                  'data-cue-start': num(start),
                  'data-cue-end': num(end),
                  title: `${formatCueTime(start)} → ${formatCueTime(end)}\n${cue.text}\n双击编辑字幕`,
                  'aria-label': cue.text,
                  'aria-pressed': props.subtitle?.activeIndex === index,
                  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => onCueDown(event, index),
                  onPointerMove: onCueMove,
                  onPointerUp: onCueUp,
                  onPointerCancel: onCueUp,
                  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => {
                    // 键盘或辅助功能触发 click 时，直接打开编辑器。
                    if (event.detail === 0) props.subtitle?.onEdit(index);
                  },
                  onDoubleClick: (event: ReactMouseEvent<HTMLButtonElement>) => {
                    event.preventDefault();
                    props.subtitle?.onEdit(index);
                  },
                },
                /* R7 / S1H：文本包一层才能吃到 `text-overflow`（flex 容器的裸文本
                   在 Chromium 里不生效，仍是硬裁——R5 的 `.status-text` 同一个坑）。 */
                h('span', { className: 'tl-cue-text' }, cue.text.split('\n')[0]),
              );
            }),
          ),
        );

  /**
   * E07（R36）：工具条按钮的**唯一**形态 —— `btn dense icon`（22×22 热区）+ 14×14 内联 svg + 零文字节点。
   *
   * 为什么集中成一个工厂：判据要「按钮内文本节点宽 = 0」，以前 `−`/`+` 是字符、`吸附 开/关`
   * 是文字；这里把按钮名称给 `aria-label`，功能说明交给统一的悬停提示。
   * @param {string} testid @param {string} label @param {string} hint @param {ReactNode} glyph
   * @param {() => void} onClick
   * @param {{ pressed?: boolean, extraClass?: string, expanded?: boolean, ppsAt?: number, disabled?: boolean }} [options]
   */
  function toolButton(
    testid: string,
    label: string,
    hint: string,
    glyph: ReactNode,
    onClick: () => void,
    options: { pressed?: boolean; extraClass?: string; expanded?: boolean; ppsAt?: number; disabled?: boolean } = {},
  ): ReactNode {
    const props: Record<string, any> = {
      type: 'button',
      className: `btn icon dense${options.extraClass === undefined ? '' : ` ${options.extraClass}`}${options.pressed === true ? ' active' : ''}`,
      'data-testid': testid,
      'aria-label': label,
      'data-editor-hint': hint,
      'aria-description': hint,
      onClick,
    };
    if (options.pressed !== undefined) {
      props['aria-pressed'] = options.pressed ? 'true' : 'false';
      props['data-on'] = options.pressed ? 'true' : 'false';
    }
    if (options.expanded !== undefined) props['aria-expanded'] = options.expanded ? 'true' : 'false';
    if (options.ppsAt !== undefined) props['data-pps'] = String(options.ppsAt);
    if (options.disabled !== undefined) props.disabled = options.disabled;
    return h('button', props, glyph);
  }

  return h(
    'div',
    { className: 'timeline', ref: scrollerRef,
      onDragOver: (event: import('react').DragEvent<HTMLDivElement>) => {
        if (!props.onResourceDrop || !event.dataTransfer.types.includes(RESOURCE_DRAG_MIME)) return;
        event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
        const el = event.target instanceof Element ? event.target : null;
        const lane = el?.closest<HTMLElement>('.tl-lane[data-track-index]');
        const track = lane ? Number(lane.dataset.trackIndex) : null;
        if (track !== null && (!Number.isInteger(track) || lockedTracks.has(track))) { event.dataTransfer.dropEffect = 'none'; setResourceGhost(null); return; }
        const rect = tlRef.current?.getBoundingClientRect();
        if (!rect) return;
        const at = resourceDropTime(event.clientX, rect.left, HEAD_W, pps, doc.fps);
        const lanes = tlRef.current?.querySelector<HTMLElement>('.tl-lanes');
        const top = lane ? lane.getBoundingClientRect().top - rect.top : lanes?.offsetTop ?? 0;
        setResourceGhost({ at, track, left: HEAD_W + at * pps, top });
      },
      onDragLeave: (event: import('react').DragEvent<HTMLDivElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node|null)) setResourceGhost(null); },
      onDrop: (event: import('react').DragEvent<HTMLDivElement>) => {
        if (!props.onResourceDrop || !event.dataTransfer.types.includes(RESOURCE_DRAG_MIME)) return;
        event.preventDefault(); event.stopPropagation(); setResourceGhost(null);
        const item = parseResourceDrag(event.dataTransfer.getData(RESOURCE_DRAG_MIME), props.projectId ?? '');
        if (!item) { props.onTransitionReject?.('请使用当前工程的素材'); return; }
        const el = event.target instanceof Element ? event.target : null;
        const lane = el?.closest<HTMLElement>('.tl-lane[data-track-index]');
        const track = lane ? Number(lane.dataset.trackIndex) : null;
        if (track !== null && (!Number.isInteger(track) || lockedTracks.has(track))) { props.onTransitionReject?.('目标轨道已锁定或不可放置'); return; }
        const rect = tlRef.current?.getBoundingClientRect(); if (!rect || event.clientX < rect.left+HEAD_W) return;
        props.onResourceDrop({...item,at:resourceDropTime(event.clientX,rect.left,HEAD_W,pps,doc.fps),track,clipId:el?.closest('[data-clip-id]')?.getAttribute('data-clip-id') ?? undefined,newTrack:event.altKey,toleranceSec:16/pps,ripple:props.ripple===true&&props.mainTrack===track});
      },
    },
    resourceGhost ? h('div', {className:'creation-drop-feedback',role:'status','data-testid':'creation-drop-feedback'}, `${resourceGhost.track === null ? '新轨道' : '轨道 '+String(resourceGhost.track)} · ${resourceGhost.at.toFixed(2)}s`) : null,
    h(WaveformStats, { key: 'waveform-stats' }),
    // 独奏（M38）：明确写「导出不看独奏」，别让用户以为只导这一条。
    (props.trackControls?.solo.length ?? 0) > 0
      ? h(
          'div',
          { className: 'tl-solo-note', 'data-testid': 'solo-note' },
          `独奏中：${(props.trackControls?.solo ?? []).map((index) => `T${index}`).join(' / ')} · 只影响预览，导出不看独奏`,
        )
      : null,
    /* Sticky viewport-width toolbar above the independently scrolling tracks. */
    h(
      'div',
      { className: 'track-toolbar-sticky' },
      /* 栏本体沿用原缩进：只多包一层壳，不为纯空白重排 180 行（review 时 diff 才看得清）。 */
      h(
      'div',
      { className: 'track-toolbar', 'data-testid': 'track-toolbar' },
      h(
        'div',
        {
          className: 'tt-row',
          'data-testid': 'timeline-tools',
          'data-tool': tool,
          /* 时长给量具用：A8「适配」的期望值 =（可视宽 − 轨头 − 余量）÷ 时长，别让量具去猜。 */
          'data-duration': num(duration),
        },
        /* —— 左段：轨道操作 —— */
        h(
          'div',
          { className: 'tt-seg tt-left', role: 'group', 'aria-label': '时间线编辑' },
          toolButton('tl-pointer', '指针工具', '指针：选中、移动或裁剪片段', timelineToolGlyph('pointer'), () => setTool('pointer'), {
            pressed: tool === 'pointer',
          }),
          toolButton('tl-select', '选择工具', '框选：拖出选区，批量选中片段', timelineToolGlyph('select'), () => setTool('select'), {
            pressed: tool === 'select',
          }),
          toolButton('tl-blade', '刀片工具', '刀片：单击片段，在点击处切开', timelineToolGlyph('blade'), () => setTool('blade'), {
            pressed: tool === 'blade',
          }),
          h('span', { className: 'tt-gap', 'aria-hidden': 'true' }),
          props.historySlot ?? null,
          /* 切分 / 删除：这两颗原来是顶栏的中文按钮，testid 不变（`split` / `delete`）。 */
          toolButton(
            'split',
            '在播放头处切分',
            '在播放头位置切分选中的片段',
            timelineToolGlyph('split'),
            () => props.onSplit?.(),
            { disabled: props.busy === true || props.canSplit === false },
          ),
          toolButton(
            'delete',
            '删除选中片段',
            '删除选中片段；开启波纹删除时自动补齐主轨空隙',
            timelineToolGlyph('delete'),
            () => props.onDelete?.(),
            { disabled: props.busy === true || props.canDelete === false },
          ),
          h('span', { className: 'tt-gap', 'aria-hidden': 'true' }),
          /* 播放头逐帧：`‹` 退一帧、`›` 进一帧（1/fps，走宿主的 seekTo —— 会顺带暂停）。 */
          toolButton('playhead-prev', '上一帧', '播放头退一帧（1/fps）', timelineToolGlyph('frame-prev'), () => props.onStepFrame?.(-1)),
          toolButton('playhead-next', '下一帧', '播放头进一帧（1/fps）', timelineToolGlyph('frame-next'), () => props.onStepFrame?.(1)),
        ),
        /* —— 中段：时间码 `当前 / 总长`（mm:ss.ff，与走带同一套 formatTimecode）——
           播放中由宿主的 `paintStage` 每帧写这个 `span` 的 textContent（不 setState）。 */
        h(
          'div',
          { className: 'tt-seg tt-mid' },
          h(
            'span',
            {
              className: 'tt-timecode',
              'data-testid': 'track-timecode',
              'data-playhead': num(playhead),
              'data-duration': num(duration),
              title: '播放头 / 总长（mm:ss.ff）',
            },
            h('span', { className: 'tt-now', ref: props.timecodeRef }, formatTimecode(playhead, doc.fps)),
            h('span', { className: 'tt-sep', 'aria-hidden': 'true' }, ' / '),
            h('span', { className: 'tt-total' }, formatTimecode(duration, doc.fps)),
          ),
        ),
        /* —— 右段：缩放滑块 / 适配 / 搜索 / 设置 —— */
        h(
          'div',
          { className: 'tt-seg tt-right', role: 'group', 'aria-label': '吸附与时间线视图' },
          /* 从顶栏下移的开关：吸附 / 波纹 / 网格（+ 步长）。 |
             `snap-toggle` / `ripple-toggle` / `grid-toggle` / `grid-size` 的 testid 与
             `aria-pressed` 全部照旧 —— 只换位置与图标。 */
          toolButton(
            'snap-toggle',
            '吸附',
            '吸附：拖动片段时贴齐边界或播放头',
            timelineToolGlyph('snap'),
            () => props.onToggleSnap?.(),
            { pressed: props.snap === true },
          ),
          toolButton(
            'ripple-toggle',
            '波纹删除',
            props.mainTrack === null
              ? '波纹删除：当前工程没有画面轨'
              : `波纹删除：删除 V${props.mainTrack} 上的片段后合上空隙`,
            timelineToolGlyph('ripple'),
            () => props.onToggleRipple?.(),
            { pressed: props.ripple === true },
          ),
          toolButton(
            'grid-toggle',
            '网格吸附',
            `网格吸附：在画布上贴齐 ${props.grid?.size ?? 8}px 网格`,
            timelineToolGlyph('grid'),
            () => props.onToggleGrid?.(),
            { pressed: props.grid?.enabled === true },
          ),
          h('input', {
            className: 'grid-size',
            type: 'number',
            min: 2,
            max: 64,
            step: 1,
            value: String(props.grid?.size ?? 8),
            'data-testid': 'grid-size',
            title: '画布网格间距（像素）',
            'aria-label': '画布网格间距（像素）',
            disabled: props.grid?.enabled !== true,
            onChange: (event: { target: { value: string } }) => props.onGridSize?.(Number(event.target.value)),
          }),
          h('span', { className: 'tt-gap', 'aria-hidden': 'true' }),
          toolButton('zoom-out', '缩小一档', '缩小一档（播放头在屏幕上的位置不变）', timelineToolGlyph('zoom-out'), () => stepZoom(-1), {
            ppsAt: pps,
            disabled: pps <= (PPS_STEPS[0] ?? 16),
          }),
          h('input', {
            className: 'tt-zoom-slider',
            'data-testid': 'zoom-slider',
            type: 'range',
            min: 0,
            max: 100,
            step: 1,
            value: String(sliderOfPps(pps)),
            style: { '--zoom-fill': `${sliderOfPps(pps)}%` } as CSSProperties,
            'aria-label': '时间线缩放',
            title: `时间线缩放：${pps}px/s（拖动改变比例；与「−」「+」同一条路）`,
            onChange: (event: { target: { value: string } }) => zoomTo(ppsOfSlider(Number(event.target.value))),
          }),
          toolButton('zoom-in', '放大一档', '放大一档（播放头在屏幕上的位置不变）', timelineToolGlyph('zoom-in'), () => stepZoom(1), {
            ppsAt: pps,
            disabled: pps >= (PPS_STEPS[PPS_STEPS.length - 1] ?? 512),
          }),
          h(
            'span',
            {
              className: 'tl-zoom',
              'data-testid': 'zoom-level',
              'data-pps': String(pps),
              'data-percent': String(Math.round((pps / DEFAULT_PPS) * 100)),
            },
            `${Math.round((pps / DEFAULT_PPS) * 100)}%`,
          ),
          h('span', { className: 'tl-zoom-pps', 'data-testid': 'zoom-pps' }, `${pps}px/s`),
          h('span', { className: 'tt-gap', 'aria-hidden': 'true' }),
          toolButton('tl-fit', '适配', '适配：让整条时间线进入可视范围', timelineToolGlyph('fit'), fitToWindow, {
            ppsAt: pps,
          }),
          toolButton('tl-search', '搜索', '搜索：按秒数 / mm:ss 跳转播放头', timelineToolGlyph('search'), () => setSearchOpen((open) => !open), {
            expanded: searchOpen,
          }),
          searchOpen
            ? h('input', {
                className: 'tl-search-input',
                'data-testid': 'timeline-search',
                type: 'text',
                inputMode: 'decimal',
                placeholder: '秒 / m:ss',
                value: searchText,
                'aria-label': '跳到时间',
                title: '输入秒数（12.5）或时间码（1:02.5）→ 播放头直接跳过去；Esc 收起',
                onChange: (event: { target: { value: string } }) => {
                  const next = event.target.value;
                  setSearchText(next);
                  const at = parseSeekText(next);
                  /* 能解出数字就跟着跳（边打边跳），解不出就只留字、不动播放头。 */
                  if (at !== null) props.onPlayhead(Math.min(at, duration));
                },
                onKeyDown: (event: { key: string }) => {
                  if (event.key !== 'Escape') return;
                  setSearchOpen(false);
                  setSearchText('');
                },
              })
            : null,
          toolButton('track-settings', '设置', '打开偏好设置', timelineToolGlyph('settings'), () => props.onSettings?.()),
        ),
      ),
      ),
    ),
    h(
      'div',
      { className: 'tl', ref: tlRef, 'data-tool': tool, style: { width: `${HEAD_W + width}px`, minWidth: '100%' }, 'data-testid': 'timeline' },
      resourceGhost ? h('div', {className:'creation-drop-line','aria-hidden':true,style:{left:resourceGhost.left,top:resourceGhost.top}}) : null,
      h(TimelineRuler, {
        scrollerRef, handleRef: props.playheadHandleRef, playhead, duration, pps, onSeek: props.onPlayhead,
      }),
      h(
        'div',
        {
          className: 'tl-lanes',
          'data-tool': tool,
          /* 框选（E07）：只在 `select` 模式下接鼠标按下；其它模式这一行等于不存在。 */
          onPointerDown: onLanesDown,
          onPointerMove: onLanesMove,
          onPointerUp: onLanesUp,
          onPointerCancel: cancelLanesSelection,
          onLostPointerCapture: cancelLanesSelection,
          onContextMenu: onTimelineContext,
          /* 高度按每条轨自己的设置求和（M36），**行间 gap 与字幕副轨的真实行高都算进去**
             （D54 · R16：旧写法写死副轨 44 又不加 gap，轨高拖大后 min-height 比内容高 10px，
             纵滚量里多一段空白）。`lanesTotalHeight` 与 `laneTopOf` 同一套算术。 */
          style: {
            minHeight: `${lanesTotalHeight(props.trackHeight?.heights ?? {}, doc.tracks, subLane !== null, props.mainTrack)}px`,
          },
        },
        subLane === null ? lanes : [...lanes, subLane],
        contextMenu?.doc === doc && contextMenu.scope === props.gestureScope && props.onContextActions ? h(TimelineMenu, {
          x: contextMenu.x, y: contextMenu.y, target: contextMenu.target,
          close: closeContextMenu, groups: props.onContextActions(contextMenu.target),
        }) : null,
      ),
      drag !== null && drag.guide !== null
        ? h('div', {
            className: 'tl-snap-guide',
            'data-testid': 'snap-guide',
            'data-snap-time': num(drag.guide.time),
            'data-snap-edge': drag.guide.edge,
            style: { left: `${HEAD_W + drag.guide.time * pps}px` },
          })
        : null,
      marquee === null
        ? null
        : (() => {
            const box = tlRef.current?.getBoundingClientRect() ?? null;
            if (box === null) return null;
            const left = Math.min(marquee.x0, marquee.x1) - box.left;
            const top = Math.min(marquee.y0, marquee.y1) - box.top;
            const w = Math.abs(marquee.x1 - marquee.x0);
            const tall = Math.abs(marquee.y1 - marquee.y0);
            return h('div', {
              className: 'tl-marquee',
              'data-testid': 'timeline-marquee',
              'data-w': String(Math.round(w)),
              'data-h': String(Math.round(tall)),
              style: { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${tall}px` },
            });
          })(),
      h('div', { className: 'tl-head-divider', 'aria-hidden': 'true' }),
      h('div', { className: 'tl-playhead-viewport', 'aria-hidden': 'true' },
        h('div', {
          className: 'tl-playhead',
          ref: props.playheadRef,
          style: { left: `${HEAD_W + playhead * pps}px` },
          'data-testid': 'playhead',
        }),
      ),
    ),
  );
}

// —— 字幕样式面板（M40）——

export interface SubtitleStylePanelProps {
  /** **归一后**的完整样式（服务端 normalize 过；面板只负责显示与提交补丁）。 */
  style: SubtitleStyleFields;
  /** 工程里是否已经有 `.film/subtitle-style.json`。 */
  exists: boolean;
  /** 最近一次成功落盘的时间（ISO）或 null。 */
  savedAt: string | null;
  busy: boolean;
  /** 保存失败的可见提示（服务端 message 原文）。 */
  error: string;
  onChange: (patch: Partial<SubtitleStyleFields>) => void;
  onPreset: (id: SubtitleStyleFields['preset']) => void;
  onReset: () => void;
  onClose: () => void;
}

/** 0.04 → "4.0%"；面板显示用（不是再算一份真值，真值仍来自 props.style）。 */
function pctText(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

/**
 * 1.25 → "1.00×"、1.8 → "1.44×"：显示**相对默认的倍数**，不是绝对值。
 *
 * 为什么这么显示：`lineHeight` 的语义由 `film-core/subtitle-layout.mjs` 的
 * `subtitleLineStep()` 定义成 `em = lineHeight / 1.25`（默认 1.25 就是 1em），
 * 成片那边的行步进就是这个 em × 字号。界面若显示绝对值 1.8，用户会以为成片行距
 * 变成 1.8 倍字号，实际上只有 1.44 —— 两把尺子对不上。
 *
 * **只用于显示**：滑杆 `onChange` 写回去的仍是绝对值（1.8 不能写成 1.44），
 * 否则会把 0.8/1.44 这类派生值存进 `.film/subtitle-style.json`。
 */
function relativeLineHeight(value: number): string {
  const step = subtitleLineStep({ lineHeight: value });
  return `${step.em.toFixed(2)}×${step.isDefault ? '（默认）' : ''}`;
}

/**
 * CSS 颜色 → `<input type="color">` 能显示的 `#rrggbb`。
 *
 * 颜色控件**不接受 alpha**，而默认的 `shadowColor` 是 `rgba(0,0,0,0.608)`：直接把原串塞进去
 * 浏览器会当非法值、显示成 `#000000`，用户一碰就把 60% 的阴影改成不透明黑。所以这里显式
 * 取 RGB 三通道给控件，透明度仍由右侧的数值文本（原串）显示；只有用户真的改色时才覆盖原值。
 * 解析复用 layers 的 `parseCssColor`（不在 UI 里写第二套颜色解析）。
 * @param {string} css
 */
function colorSwatch(css: string): string {
  const parsed = parseCssColor(css);
  if (parsed === null) return '#000000';
  /** @param {number} n */
  const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${hex(parsed.r)}${hex(parsed.g)}${hex(parsed.b)}`;
}

/**
 * 字体下拉的选项（M45）。顺序 = 回退链顺序：选中的那个提到最前，其余按这张表跟在后面，
 * 末尾恒有 `sans-serif`。`Heiti SC` 排第一时拼出来与 `SUBTITLE_STYLE_DEFAULTS.fontFamily`
 * **逐字符相同**（A6 选回 Heiti 要复现 A5 的 ASS 与默认样式）。
 */
const FONT_FAMILY_CHOICES = ['Heiti SC', 'PingFang SC', 'Microsoft YaHei', 'sans-serif'] as const;

/**
 * 选中的族 → CSS 族列表。
 *
 * 为什么不是直接写 `fontFamily: 'PingFang SC'`：预览要保留缺字回退链（Heiti 缺的符号
 * 退到 PingFang → 雅黑 → sans-serif），这条链是 S45 / ADR-R24-02 定下的，面板只换**首位**。
 * `sans-serif` 是通用族关键字，不能加引号，也不该再往前塞具体族。
 *
 * @param {string} name
 */
function fontFamilyChain(name: string): string {
  if (name === 'sans-serif') return 'sans-serif';
  const rest = FONT_FAMILY_CHOICES.filter((item) => item !== name && item !== 'sans-serif');
  return [`"${name}"`, ...rest.map((item) => `"${item}"`), 'sans-serif'].join(', ');
}

/**
 * CSS 族列表 → 首族（下拉的当前值）。
 *
 * 只取逗号前第一项并去掉成对引号；`assFontName` 永远跟它一致（A6：预览与成片必须同族）。
 * @param {string} list
 */
function firstFontFamily(list: string): string {
  const first = String(list).split(',')[0]?.trim() ?? '';
  return first.replace(/^["']|["']$/g, '');
}

/**
 * 字幕样式面板（M45）：14 个控件 + 3 条预设 + 恢复默认。
 *
 * 16 个字段里**不暴露**两个（ADR-R28-01）：
 * - `background`：`BorderStyle: 3` 会吃掉字形描边，底色要走矢量矩形（等 S50 的文本度量），
 *   现在暴露只会让界面能调、成片没有；
 * - 单独的 `assFontName`：它必须与 `fontFamily` 首族一致，所以只作为字体下拉的联动值。
 *
 * 预设表与默认值都来自 `packages/layers`（`listSubtitlePresets` / `getSubtitlePreset`），
 * 面板不复制一份——否则「预设」和「默认」会变成两份真相。
 *
 * 每次交互只发**补丁**（`onChange({fontSizeRatio})`），宿主立刻 `updateStyle` 到预览，
 * 并 400ms 防抖落盘；所以拖动滑杆时画面是跟手的，写盘只有一次。
 */
export function SubtitleStylePanel(props: SubtitleStylePanelProps): ReactNode {
  const style = props.style;
  const presetIds = listSubtitlePresets();
  /* 行距的唯一权威是 film-core：这里只为「显示」和 `title` 取一次，写回值不变。 */
  const lineStep = subtitleLineStep({ lineHeight: style.lineHeight });

  /** @param {string} id @param {string} [extra] */
  const row = (id: string, label: string, control: ReactNode, valueText: string) =>
    h(
      'div',
      { className: 'modal-row style-row', 'data-control': id },
      h('span', { className: 'modal-label' }, label),
      h(
        'div',
        { className: 'style-control' },
        control,
        h('span', { className: 'style-value', 'data-testid': `subtitle-style-${id}-value` }, valueText),
      ),
    );

  return h(
    'div',
    { className: 'modal-backdrop', 'data-testid': 'subtitle-style-backdrop' },
    h(
      'section',
      {
        className: 'modal style-panel',
        'data-testid': 'subtitle-style-panel',
        'data-exists': String(props.exists),
        'data-saved-at': props.savedAt ?? '',
        'data-error': props.error === '' ? '' : '1',
      },
      h(
        'header',
        { className: 'modal-head' },
        h('strong', null, '字幕样式'),
        h(
          'span',
          { className: 'mono-dim', style: { fontSize: '11px' } },
          '工程设置 · 不进 film.html、不进撤销栈',
        ),
        h('button', { type: 'button', className: 'btn', 'data-testid': 'subtitle-style-close', onClick: props.onClose }, '×'),
      ),

      h(
        'div',
        { className: 'style-presets', 'data-testid': 'subtitle-style-presets' },
        ...presetIds.map((id) => {
          const preset = getSubtitlePreset(id);
          return h(
            'button',
            {
              type: 'button',
              /* 当前生效的那条给 `active`（样式里是已选的青边）—— 用户得能看出「现在用的是哪种」，
                 验收也能一条断言读出来，不用去猜按钮顺序。 */
              className: `btn tiny${style.preset === id ? ' active' : ''}`,
              key: id,
              'data-testid': `subtitle-style-preset-${id}`,
              'data-active': style.preset === id ? 'true' : 'false',
              title: preset?.description ?? '',
              onClick: () => props.onPreset(/** @type {any} */ (id) as SubtitleStyleFields['preset']),
            },
            preset?.label ?? id,
          );
        }),
        h(
          'button',
          {
            type: 'button',
            className: 'btn tiny',
            'data-testid': 'subtitle-style-reset',
            title: '恢复默认（与成片默认样式一致）',
            onClick: props.onReset,
          },
          '恢复默认',
        ),
      ),

      row(
        'fontsize',
        '字号',
        h('input', {
          className: 'style-slider',
          type: 'range',
          min: '2',
          max: '12',
          step: '0.1',
          'data-testid': 'subtitle-style-fontsize',
          value: String(Number((style.fontSizeRatio * 100).toFixed(1))),
          onChange: (event: { target: { value: string } }) =>
            props.onChange({ fontSizeRatio: Number(event.target.value) / 100 }),
        }),
        pctText(style.fontSizeRatio),
      ),
      row(
        'fontscale',
        '字号倍率',
        h('input', {
          className: 'style-slider',
          type: 'range',
          min: '0.5',
          max: '2',
          step: '0.05',
          'data-testid': 'subtitle-style-fontscale',
          value: String(Number(style.fontScale.toFixed(2))),
          onChange: (event: { target: { value: string } }) => props.onChange({ fontScale: Number(event.target.value) }),
        }),
        `${Number(style.fontScale.toFixed(2))}×`,
      ),
      row(
        'color',
        '字色',
        h('input', {
          className: 'style-color',
          type: 'color',
          'data-testid': 'subtitle-style-color',
          value: style.color,
          onChange: (event: { target: { value: string } }) => props.onChange({ color: event.target.value }),
        }),
        style.color,
      ),
      row(
        'outline',
        '描边',
        h('input', {
          className: 'style-slider',
          type: 'range',
          min: '0',
          max: '50',
          step: '1',
          'data-testid': 'subtitle-style-outline',
          value: String(Math.round(style.outlineRatio * 100)),
          onChange: (event: { target: { value: string } }) =>
            props.onChange({ outlineRatio: Number(event.target.value) / 100 }),
        }),
        pctText(style.outlineRatio, 0),
      ),
      row(
        'outline-color',
        '描边色',
        h('input', {
          className: 'style-color',
          type: 'color',
          'data-testid': 'subtitle-style-outline-color',
          value: style.outlineColor,
          onChange: (event: { target: { value: string } }) => props.onChange({ outlineColor: event.target.value }),
        }),
        style.outlineColor,
      ),
      row(
        'shadow',
        '阴影',
        h('input', {
          className: 'style-slider',
          type: 'range',
          min: '0',
          max: '0.02',
          step: '0.0005',
          'data-testid': 'subtitle-style-shadow',
          // 显示到 1/10000：0.0015 这种默认值在 1 位小数下会变成 0.0%，看不出差别。
          value: String(Number(style.shadowRatio.toFixed(4))),
          onChange: (event: { target: { value: string } }) => props.onChange({ shadowRatio: Number(event.target.value) }),
        }),
        pctText(style.shadowRatio, 2),
      ),
      row(
        'shadow-color',
        '阴影色',
        h('input', {
          className: 'style-color',
          type: 'color',
          'data-testid': 'subtitle-style-shadow-color',
          value: colorSwatch(style.shadowColor),
          onChange: (event: { target: { value: string } }) => props.onChange({ shadowColor: event.target.value }),
        }),
        style.shadowColor,
      ),
      row(
        'bottom',
        '底部安全区',
        h('input', {
          className: 'style-slider',
          type: 'range',
          min: '0',
          max: '30',
          step: '1',
          'data-testid': 'subtitle-style-bottom',
          value: String(Math.round(style.bottomSafeRatio * 100)),
          onChange: (event: { target: { value: string } }) =>
            props.onChange({ bottomSafeRatio: Number(event.target.value) / 100 }),
        }),
        pctText(style.bottomSafeRatio, 0),
      ),
      row(
        'maxlines',
        '最多行数',
        h(
          'select',
          {
            className: 'input',
            'data-testid': 'subtitle-style-maxlines',
            value: String(style.maxLines),
            onChange: (event: { target: { value: string } }) => props.onChange({ maxLines: Number(event.target.value) }),
          },
          ...[1, 2, 3, 4].map((n) => h('option', { key: n, value: String(n) }, `${n} 行`)),
        ),
        `${style.maxLines} 行`,
      ),
      row(
        'lineheight',
        `行高（相对默认 ${lineStep.defaultLineHeight}）`,
        h('input', {
          className: 'style-slider',
          type: 'range',
          min: '1',
          max: '2',
          step: '0.05',
          'data-testid': 'subtitle-style-lineheight',
          value: String(Number(style.lineHeight.toFixed(2))),
          /* 读数与无障碍值用同一串：读屏用户听到的与屏幕上看到的必须一致。 */
          'aria-valuetext': relativeLineHeight(style.lineHeight),
          title: `绝对值 ${Number(style.lineHeight.toFixed(2))}，成片行步进 = ${Number(lineStep.em.toFixed(2))}em × 字号`,
          onChange: (event: { target: { value: string } }) => props.onChange({ lineHeight: Number(event.target.value) }),
        }),
        relativeLineHeight(style.lineHeight),
      ),
      row(
        'align',
        '对齐',
        h(
          'select',
          {
            className: 'input',
            'data-testid': 'subtitle-style-align',
            value: style.align,
            onChange: (event: { target: { value: string } }) => {
              const value = event.target.value;
              if (value === 'left' || value === 'center' || value === 'right') props.onChange({ align: value });
            },
          },
          h('option', { value: 'left' }, '左'),
          h('option', { value: 'center' }, '中'),
          h('option', { value: 'right' }, '右'),
        ),
        style.align === 'left' ? '左' : style.align === 'right' ? '右' : '中',
      ),
      row(
        'fontfamily',
        '字体',
        h(
          'select',
          {
            className: 'input',
            'data-testid': 'subtitle-style-fontfamily',
            value: firstFontFamily(style.fontFamily),
            onChange: (event: { target: { value: string } }) => {
              const name = event.target.value;
              // 两个字段一起写：`assFontName` 是 ASS 的单值 Fontname，必须与预览首族一致，
              // 否则就是 R14-C1 那种「预览一个字体、成片另一个字体」。
              props.onChange({ fontFamily: fontFamilyChain(name), assFontName: name });
            },
          },
          ...FONT_FAMILY_CHOICES.map((name) => h('option', { key: name, value: name }, name)),
        ),
        firstFontFamily(style.fontFamily),
      ),
      row(
        'bold',
        '加粗',
        h(
          'button',
          {
            className: 'btn tiny style-toggle',
            type: 'button',
            'data-testid': 'subtitle-style-bold',
            'data-on': style.bold ? 'true' : 'false',
            'aria-pressed': style.bold ? 'true' : 'false',
            onClick: () => props.onChange({ bold: !style.bold }),
          },
          style.bold ? '加粗 开' : '加粗 关',
        ),
        style.bold ? 'Bold -1' : '不加粗',
      ),
      row(
        'cpswarn',
        '语速提示',
        h('input', {
          className: 'input',
          type: 'number',
          min: '5',
          max: '60',
          step: '1',
          'data-testid': 'subtitle-style-cpswarn',
          value: String(style.cpsWarn),
          onChange: (event: { target: { value: string } }) => {
            const value = Number(event.target.value);
            if (Number.isFinite(value)) props.onChange({ cpsWarn: value });
          },
        }),
        `${style.cpsWarn} 字/秒`,
      ),

      props.error === ''
        ? null
        : h('div', { className: 'subtitle-error', 'data-testid': 'subtitle-style-error' }, props.error),
      h(
        'footer',
        { className: 'modal-foot' },
        h(
          'span',
          { className: 'mono-dim', style: { fontSize: '11px' }, 'data-testid': 'subtitle-style-status' },
          props.busy ? '保存中…' : props.savedAt === null ? '未保存（用默认样式）' : `已保存 ${clockIso(props.savedAt)}`,
        ),
        h('span', { className: 'spacer' }),
        h('span', { className: 'mono-dim', style: { fontSize: '11px' } }, '预览实时生效；导出烧录与预览同源（M41/M44）'),
      ),
    ),
  );
}

/** ISO → `HH:MM:SS`。 @param {string} iso */
function clockIso(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  /** @param {number} n */
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export interface SubtitleDraft {
  start: string;
  end: string;
  text: string;
}

export interface SubtitleEditorProps {
  index: number;
  total: number;
  draft: SubtitleDraft;
  error: string;
  busy: boolean;
  dirty: boolean;
  textRef: RefObject<HTMLTextAreaElement | null>;
  onChange: (patch: Partial<SubtitleDraft>) => void;
  onSave: () => void;
  onReset: () => void;
}

/** Selected cue fields in the properties inspector. */
function SubtitleEditor(props: SubtitleEditorProps): ReactNode {
  function timeField(field: 'start' | 'end', label: string): ReactNode {
    return h('label', { className: 'subtitle-field' }, label,
      h('input', {
        className: 'input',
        'data-testid': `subtitle-${field}`,
        value: props.draft[field],
        disabled: props.busy,
        spellCheck: false,
        onChange: (event: { target: HTMLInputElement }) => props.onChange({ [field]: event.target.value }),
      }),
    );
  }
  return h('section', {
      className: 'inspector-seg inspector-subtitle',
      'data-inspector-seg': 'subtitle',
      'data-testid': 'subtitle-editor',
    },
    h('h3', { className: 'panel-title' }, `字幕 ${props.index + 1} / ${props.total}`),
    h('label', { className: 'subtitle-field' }, '内容',
      h('textarea', {
        className: 'input subtitle-text',
        'data-testid': 'subtitle-text',
        'aria-label': '字幕正文',
        ref: props.textRef,
        value: props.draft.text,
        rows: 4,
        disabled: props.busy,
        spellCheck: false,
        onChange: (event: { target: HTMLTextAreaElement }) => props.onChange({ text: event.target.value }),
        onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
          if (event.nativeEvent.isComposing || event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return;
          event.preventDefault();
          props.onSave();
        },
      }),
    ),
    h('div', { className: 'subtitle-times' }, timeField('start', '开始'), timeField('end', '结束')),
    props.error === '' ? null : h('p', { className: 'subtitle-error', role: 'alert', 'data-testid': 'subtitle-error' }, props.error),
    h('footer', { className: 'subtitle-actions' },
      h('button', { type: 'button', className: 'btn', 'data-testid': 'subtitle-cancel', disabled: !props.dirty || props.busy, onClick: props.onReset }, '还原'),
      h('button', { type: 'button', className: 'btn primary', 'data-testid': 'subtitle-save', disabled: !props.dirty || props.busy, onClick: props.onSave },
        props.busy ? '保存中…' : '保存',
      ),
    ),
  );
}

export interface AudioPanelProps {
  /** 当前选中的片段（顺序与 selection 一致）；多选时用来判「混合」。 */
  targets: Array<{ id: string; clip: Clip }>;
  /** 改音量（App 负责夹边界 + 一批 props Op）。 */
  onVolume: (value: number) => void;
  /** 改单侧淡变（秒）。 */
  onFade: (edge: 'in' | 'out', seconds: number) => void;
  /** 静音开关（写片段级 muted，不动 volume）。 */
  onMute: (muted: boolean) => void;
  /** 回到默认（volume=1、fade=0）。 */
  onReset: () => void;
  /** 上一次被夹住/被拒绝的原因。 */
  note?: string;
}

/**
 * 检查器的「音频 / 淡变」区（M31）。
 *
 * 三条规矩：
 * 1. 显示的是**投影**（`clip.volume` / `clip.fade`），不是自己存一份；
 * 2. 多选时不同值显示「混合」，改一次对全部选中生效（App 发一批 props Op）；
 * 3. 拖动中的滑块只改本地草稿，松手才提交——一次手势一步撤销。
 */
export function AudioPanel(props: AudioPanelProps): ReactNode {
  const view = audioSelection(props.targets);
  const [volumeDraft, setVolumeDraft] = useState<string | null>(null);
  const [volumeDrag, setVolumeDrag] = useState<number | null>(null);
  const [fadeDraft, setFadeDraft] = useState<{ edge: 'in' | 'out'; text: string } | null>(null);
  const [fadeDrag, setFadeDrag] = useState<{ edge: 'in' | 'out'; value: number } | null>(null);

  const hasSound = view.soundCount > 0;
  const noClips = props.targets.length === 0;
  const mute = muteStateOf(props.targets);
  const shownVolume = volumeDrag ?? view.volume;
  const volumeText =
    volumeDraft ?? (view.volumeMixed ? '' : view.volume === null ? '' : num(view.volume, 3));

  function commitVolume(text: string): void {
    const parsed = Number(text);
    if (Number.isFinite(parsed)) props.onVolume(clampVolume(parsed));
    setVolumeDraft(null);
  }

  function commitFade(edge: 'in' | 'out', text: string): void {
    const parsed = Number(text);
    if (Number.isFinite(parsed)) props.onFade(edge, parsed);
    setFadeDraft(null);
  }

  /** 一侧淡变的显示值（拖动 > 草稿 > 投影）；混合时给空串（占位符说「混合」）。 */
  function fadeText(edge: 'in' | 'out'): string {
    const index = edge === 'in' ? 0 : 1;
    if (fadeDrag !== null && fadeDrag.edge === edge) return num(fadeDrag.value, 3);
    if (fadeDraft !== null && fadeDraft.edge === edge) return fadeDraft.text;
    const value = view.fade[index];
    return value === null ? '' : num(value, 3);
  }

  function fadeRow(edge: 'in' | 'out'): ReactNode {
    const index = edge === 'in' ? 0 : 1;
    const mixed = index === 0 ? view.fadeMixedIn : view.fadeMixedOut;
    const shown = fadeDrag !== null && fadeDrag.edge === edge ? fadeDrag.value : view.fade[index];
    const limit = fadeLimitOf(props.targets, edge);
    return h(
      'div',
      { className: 'audio-row', 'data-testid': `audio-${edge}-row`, 'data-edge': edge },
      h('label', { className: 'audio-label' }, edge === 'in' ? '淡入' : '淡出'),
      h(
        'div',
        { className: 'audio-control' },
        h('input', {
          type: 'range',
          min: 0,
          max: Math.max(0.1, limit),
          step: 0.05,
          value: shown === null ? 0 : Math.min(shown, Math.max(0.1, limit)),
          'data-testid': `audio-fade-${edge}-slider`,
          'data-mixed': mixed ? '1' : '0',
          onChange: (event: { currentTarget: HTMLInputElement }) =>
            setFadeDrag({ edge, value: Number(event.currentTarget.value) }),
          onPointerUp: () => {
            if (fadeDrag !== null && fadeDrag.edge === edge) props.onFade(edge, fadeDrag.value);
            setFadeDrag(null);
          },
          onKeyUp: () => {
            if (fadeDrag !== null && fadeDrag.edge === edge) props.onFade(edge, fadeDrag.value);
            setFadeDrag(null);
          },
        }),
        h('input', {
          className: 'audio-number',
          type: 'number',
          min: 0,
          max: limit,
          step: 0.05,
          value: fadeText(edge),
          placeholder: mixed ? '混合' : '0',
          'data-testid': `audio-fade-${edge}`,
          'data-mixed': mixed ? '1' : '0',
          onChange: (event: { currentTarget: HTMLInputElement }) => setFadeDraft({ edge, text: event.currentTarget.value }),
          onBlur: (event: { currentTarget: HTMLInputElement }) => commitFade(edge, event.currentTarget.value),
          onKeyDown: (event: { key: string; currentTarget: HTMLInputElement }) => {
            if (event.key === 'Enter') commitFade(edge, event.currentTarget.value);
          },
        }),
        h('span', { className: 'audio-unit' }, 's'),
        h('span', { className: 'audio-limit', 'data-testid': `audio-fade-${edge}-limit` }, `≤ ${num(limit, 2)}s`),
      ),
    );
  }

  return h(
    'div',
    { className: 'inspector-section audio-panel', 'data-testid': 'audio-panel', 'data-sound-count': String(view.soundCount) },
    h(
      'div',
      { className: 'panel-title-row' },
      h('div', { className: 'panel-title' }, '音频'),
      h(
        'span',
        { className: 'audio-summary', 'data-testid': 'audio-summary' },
        noClips ? '未选中' : `${view.soundCount} 个声音片段 / 共 ${props.targets.length} 个选中`,
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'btn tiny',
          'data-testid': 'audio-reset',
          disabled: noClips,
          title: '回到默认：音量 1.0、淡入淡出 0',
          onClick: props.onReset,
        },
        '默认',
      ),
    ),
    h(
      'p',
      { className: 'hint', 'data-testid': 'audio-hint' },
      hasSound
        ? '音量和淡变都可以撤销。'
        : '此片段没有声音，淡入淡出仍可作用于画面。',
    ),
    h(
      'div',
      { className: 'audio-row', 'data-testid': 'audio-volume-row' },
      h('label', { className: 'audio-label' }, '音量'),
      h(
        'div',
        { className: 'audio-control' },
        h('input', {
          type: 'range',
          min: 0,
          max: VOLUME_MAX,
          step: 0.01,
          value: shownVolume === null ? DEFAULT_VOLUME : shownVolume,
          disabled: !hasSound,
          'data-testid': 'audio-volume-slider',
          'data-mixed': view.volumeMixed ? '1' : '0',
          onChange: (event: { currentTarget: HTMLInputElement }) => setVolumeDrag(Number(event.currentTarget.value)),
          onPointerUp: () => {
            if (volumeDrag !== null) props.onVolume(volumeDrag);
            setVolumeDrag(null);
          },
          onKeyUp: () => {
            if (volumeDrag !== null) props.onVolume(volumeDrag);
            setVolumeDrag(null);
          },
        }),
        h('input', {
          className: 'audio-number',
          type: 'number',
          min: 0,
          max: VOLUME_MAX,
          step: 0.01,
          value: volumeText,
          placeholder: view.volumeMixed ? '混合' : '1',
          disabled: !hasSound,
          'data-testid': 'audio-volume-number',
          'data-mixed': view.volumeMixed ? '1' : '0',
          onChange: (event: { currentTarget: HTMLInputElement }) => setVolumeDraft(event.currentTarget.value),
          onBlur: (event: { currentTarget: HTMLInputElement }) => commitVolume(event.currentTarget.value),
          onKeyDown: (event: { key: string; currentTarget: HTMLInputElement }) => {
            if (event.key === 'Enter') commitVolume(event.currentTarget.value);
          },
        }),
        h(
          'span',
          { className: 'audio-db', 'data-testid': 'audio-volume-db' },
          view.volumeMixed ? '混合' : formatVolumeDb(view.volume ?? DEFAULT_VOLUME),
        ),
      ),
    ),
    h(
      'div',
      { className: 'audio-row', 'data-testid': 'audio-mute-row' },
      h('label', { className: 'audio-label' }, '静音'),
      h(
        'div',
        { className: 'audio-control' },
        h(
          'button',
          {
            type: 'button',
            className: `btn tiny${mute.mixed ? ' mixed' : mute.muted ? ' active' : ''}`,
            'data-testid': 'audio-mute',
            'data-muted': mute.mixed ? 'mixed' : mute.muted ? 'true' : 'false',
            disabled: !hasSound,
            title: '静音开关只写 muted，不改写 volume：取消静音会回到原来的音量',
            onClick: () => props.onMute(!mute.muted),
          },
          mute.mixed ? '混合' : mute.muted ? '已静音' : '未静音',
        ),
        h(
          'span',
          { className: 'audio-limit', 'data-testid': 'audio-mute-hint' },
          mute.count === 0 ? '只对声音片段' : mute.muted ? 'muted（volume 未改）' : '',
        ),
      ),
    ),
    fadeRow('in'),
    fadeRow('out'),
    props.note === undefined || props.note === '' ? null : h('p', { className: 'audio-note', 'data-testid': 'audio-note' }, props.note),
  );
}

/** 多选时取最紧的淡变上限（和 `audioSelection` 的口径一致）。 */
function fadeLimitOf(targets: Array<{ id: string; clip: Clip }>, edge: 'in' | 'out'): number {
  let limit = Number.POSITIVE_INFINITY;
  for (const item of targets) {
    const own = fadeLimit(item.clip, edge);
    if (own < limit) limit = own;
  }
  return Number.isFinite(limit) ? limit : 0;
}

export type InspectorObjectTab = 'text' | 'props' | 'adjust' | 'effects' | 'advanced';

export interface InspectorProps {
  clip: Clip | null;
  selectedCount: number;
  playhead: number;
  fps: { num: number; den: number };
  hash: string;
  sourceHashFromDisk?: string;
  /** 检查器（packages/layers）挂载点：由 App 通过 ref 交给 mountInspector。 */
  mountRef?: (element: HTMLDivElement | null) => void;
  /** 当前片段场景里的图层（来自舞台 listLayers）；空数组 = 没有可编辑层。 */
  layers?: Array<{ at: string; kind: string; name: string; depth?: number; parentAt?: string | null }>;
  layerAt?: string;
  onLayer?: (at: string) => void;
  layerError?: string;
  /**
   * R112 · L1（LI-A02/A05）：右栏空态的**原因码**，由 App 从统一 target 推出来
   * （`selected-target.ts: emptyStateOf`）。面板不再自己判断「是不是没选片段」——
   * 那种判断正是「先选片段才能编辑」错误空态的来路。
   */
  emptyReason?: 'NO_TARGET' | 'NO_CLIP' | 'ELEMENT_GONE' | 'NO_LAYERS' | null;
  /** 正在喂检查器的网页片段（选中的或第一个 page 片段）；空 = 没有可改场景图层的片段。 */
  layerClipId?: string;
  /** 当前层的锁定态（会话内，不写 film.html）；锁定层树里点不动、舞台不出框/手柄。 */
  layerLocked?: boolean;
  onToggleLayerLock?: () => void;
  /** 检查器页签（M27）：「属性/图层」或「动效」（住在片段段里，U2-R2 起管不到元素段）。 */
  tab?: 'props' | 'motion';
  objectTab?: InspectorObjectTab;
  subtitle?: SubtitleEditorProps | null;
  hasElement?: boolean;
  multipleElements?: boolean;
  onObjectTab?: (tab: InspectorObjectTab) => void;
  /** S80：分组面板里可写字段的提交出口（App 负责拼 /ops）。 */
  onFieldCommit?: (field: string, value: unknown) => void;
  /** 提交中（禁用输入，避免连点）。 */
  fieldBusy?: boolean;
  onTab?: (tab: 'props' | 'motion') => void;
  /** 动效面板的挂载点（副线1 的 mountMotionPanel 挂这里，宿主不包手势拦截）。 */
  motionMountRef?: (element: HTMLDivElement | null) => void;
  /** 模板管理（M30）：宿主自己的存/升/退/归档列表，排在面板上方。 */
  motionManage?: MotionManageProps | null;
  /** E12-P4：三槽预设面板（入场/循环/出场）；null = 没选中单个片段。 */
  motionPresets?: MotionPresetsProps | null;
  /** 音频（M31）：音量/淡变的可编辑控件；null = 不显示（没选中片段）。 */
  audio?: AudioPanelProps | null;
  /**
   * 视频自带的音轨（M35）：`pending` 才显示「导出不会包含」的提示 + 「分离音频」按钮；
   * `split` 只留一行灰字说明声音去哪了；null = 不显示（不是带音轨的视频）。
   */
  trackAudio?: TrackAudioProps | null;
}

/** 视频音轨（M35）。`pending` 是唯一带按钮的状态。 */
export interface TrackAudioProps {
  status: 'pending' | 'split';
  /** 已经分离出来的声音片段 id（`split` 时有）。 */
  splitId?: string;
  /** 片段 id（按钮上带着，便于断言「点的是哪个」）。 */
  clipId: string;
  onSplit: () => void;
}

/**
 * 视频音轨提示（M35）。
 *
 * 为什么要做得这么显眼：方言里只有 `kind==='sound'` 进混音，`<video>` 在舞台上是静音的。
 * 用户拿手机视频导进来，导出就是一部没有声音的片子——这不是「未验收」，是当场就踩。
 * 所以提示必须写明**后果**（导出不包含），按钮必须就在旁边。
 */
export function TrackAudioPanel(props: TrackAudioProps): ReactNode {
  if (props.status === 'split') {
    return h(
      'div',
      { className: 'audio-note plain', 'data-testid': 'track-audio-split', 'data-clip': props.clipId },
      `音轨已分离${props.splitId === undefined ? '' : `到 ${props.splitId}`}：声音走那条 audio 片段，视频保持静音。`,
    );
  }
  return h(
    'div',
    { className: 'audio-note warn', 'data-testid': 'track-audio-prompt', 'data-clip': props.clipId },
    h('strong', null, '此片段含音轨，导出不包含'),
    h(
      'button',
      {
        type: 'button',
        className: 'btn tiny primary',
        'data-testid': 'split-audio',
        'data-clip': props.clipId,
        title: '生成一条指向同一个文件的音频片段（at / time 对齐，一步撤销可回原）',
        onClick: props.onSplit,
      },
      '分离音频',
    ),
  );
}

export function Inspector(props: InspectorProps): ReactNode {
  const clip = props.clip;
  /* S80：原来那张 11 行的只读 `dl.fields` 换成了分组面板（GroupedInspector）。
     字段顺序/可写性由 `inspector-groups.ts` + film-core 白名单决定，这里不再自己列字段。 */
  const layers = props.layers ?? [];
  const isPage = (props.layerClipId ?? '') !== '';
  const tab = props.objectTab ?? 'props';
  const hasElement = props.hasElement === true;
  const clipId = clip?.id ?? '';
  const [visitedClip, setVisitedClip] = useState('');
  useEffect(() => {
    setVisitedClip(previous => tab === 'advanced' ? clipId : previous === clipId ? previous : '');
  }, [tab, clipId]);
  const showClipFields = tab === 'advanced' || (clipId !== '' && visitedClip === clipId);
  const motionIsOpen = tab === 'advanced' && props.tab === 'motion' && props.selectedCount === 1;
  const [visitedMotionClip, setVisitedMotionClip] = useState('');
  useEffect(() => {
    setVisitedMotionClip(previous => motionIsOpen ? clipId : previous === clipId ? previous : '');
  }, [motionIsOpen, clipId]);
  // 按需建面板；暂时切换页签时保留同一片段正在编辑的模板参数。
  const showMotion = motionIsOpen || (clipId !== '' && visitedMotionClip === clipId);
  const tabs = OBJECT_TABS.filter(({ id }) =>
    (hasElement && !props.multipleElements) || id === 'advanced' ||
    (id === 'props' && (hasElement || props.selectedCount === 0)),
  );

  return h(
    'aside',
    { className: 'inspector', 'data-testid': 'inspector', 'data-zone': 'inspector' },
    h('div', { className: 'insp-objtabs', role: 'tablist', 'aria-label': '检查器', 'data-testid': 'inspector-object-tabs' },
      tabs.map(({ id, label }) => h('button', {
        key: id, type: 'button', role: 'tab', className: id === tab ? 'insp-objtab active' : 'insp-objtab',
        'aria-selected': id === tab, 'data-object-tab': id, 'data-testid': `inspector-object-${id}`,
        onClick: () => props.onObjectTab?.(id as InspectorObjectTab),
      }, label))),
    tab === 'props' && props.subtitle
      ? h(SubtitleEditor, props.subtitle)
      : !hasElement && tab === 'props'
        ? h('p', { className: 'hint', 'data-testid': 'inspector-selection-hint' }, '点选画面、图层或时间线字幕以编辑属性')
        : null,
    h(
      'div',
      {
        className: 'inspector-seg inspector-seg-element',
        'data-inspector-seg': 'element',
        'data-testid': 'inspector-seg-element',
        style: hasElement && (!props.multipleElements || tab === 'props') ? undefined : { display: 'none' },
      },
      h(
        'div',
        { className: 'panel-title-row' },
        h('div', { className: 'panel-title' }, '图层'),
        h(
          'button',
          {
            type: 'button',
            className: `btn tiny${props.layerLocked === true ? ' active' : ''}`,
            'data-testid': 'layer-lock',
            'data-locked': props.layerLocked === true ? 'true' : 'false',
            disabled: (props.layerAt ?? '') === '' || props.onToggleLayerLock === undefined,
            title: '锁定此层，暂时禁止点选与拖动（仅本次会话）',
            onClick: props.onToggleLayerLock,
          },
          props.layerLocked === true ? '解锁当前层' : '锁定当前层',
        ),
      ),
      /* R107 · U08（U05 文案收尾）：**整块删除** R7/S2G-C 那条交叉说明。
         原句指向舞台侧那份元素属性，并声称两处共享字段、只需改一处 ——
         舞台侧的第二份已经不在（左栏只剩结构树），这句话指向不存在的面板；
         而「共享字段」的语义仍暗示「还有另一处可改」，留着依旧是错信息。
         比改成「与右侧检查器一致」更干净：只有一个检查器时，任何交叉说明都是噪音。
         若将来真的回到双检查器，应重新加一条**指向真实目标**的说明，而不是复活这句。
         testid 一并移除：留着空节点只会让「文案是否存在」类量具读到假阳性。 */
      isPage
        ? h(
            'div',
            { className: 'layer-picker', 'data-empty-reason': props.emptyReason ?? '' },
            layers.length === 0
              ? h(
                  'span',
                  {
                    className: 'hint',
                    'data-testid': 'layer-empty',
                    'data-empty-reason': props.emptyReason ?? 'NO_LAYERS',
                  },
                  props.layerError || '这个片段的场景里没有可编辑图层',
                )
              : (() => {
                  /* R150 · M16-R3（图02 真错）：这颗 `<select>` 是元素段**唯一的选择头部**，
                     label 与 value 必须同源。树的选中给的是统一 id（`<clipId>::<at>`），
                     而选项来自 `listLayers` 的裸 `at`；两者不相等时 `<select>` 会**静默显示
                     第一项**（`bg · #bg`），与树/请求里的 `#fx` 打架 —— 图02 就是这么来的。
                     归一后：值 = 树上选中的那一层的裸 at；label = 同一层的 name/kind + 同一个 at。
                     不在列表里（层刚被重建/删除）也补一条合成项显示真身，不再退回第一项。 */
                  const raw = props.layerAt ?? '';
                  const bare = (at: string): string =>
                    props.layerClipId !== undefined && props.layerClipId !== '' && at.startsWith(`${props.layerClipId}::`)
                      ? at.slice(props.layerClipId.length + 2)
                      : at;
                  const selected = bare(raw);
                  const known = layers.filter((layer) => layer.at === selected);
                  const options = selected === '' || known.length > 0 ? layers : [...layers, { at: selected, kind: 'unknown', name: '', depth: 1, parentAt: null }];
                  return h(
                    'select',
                    {
                      className: 'layer-select',
                      'data-testid': 'layer-select',
                      /* s95（副线门）明确断言「layer-select 恰好 1 个」：它在这里是
                         **当前目标的读数 + 快捷切换**，不是第二棵结构树（树只在左栏）。
                         删它要先改那条判据 —— 本批不改判据。 */
                      value: selected,
                      onChange: (event: { target: { value: string } }) => props.onLayer?.(event.target.value),
                    },
                    options.map((layer) =>
                      h(
                        'option',
                        { key: layer.at, value: layer.at },
                        layer.name === '' || layer.name === layer.at ? layer.at : `${layer.name} · ${layer.at}`,
                      ),
                    ),
                  );
                })(),
          )
        : h(
            'span',
            {
              className: 'hint',
              'data-testid': 'layer-empty',
              'data-empty-reason': props.emptyReason ?? 'NO_TARGET',
            },
            /* R112 · L1（LI-A02）：这里原来是一句**前置条件**口吻的空态（「先选片段才可编辑」），
               而参考里点元素就直接出字段。现在只说「下一步在哪点」——
               入口是画布与左栏图层树，不是「先选一个片段」。 */
            props.layerError || '在画布或左侧图层中选择一个元素',
          ),
      h('div', { className: 'inspector-mount', 'data-inspector': 'mount', ref: props.mountRef }),
    ),
    /* ── 片段段（页签「片段」）────────────────────────────────────────── */
    h(
      'div',
      {
        className: 'inspector-seg inspector-seg-clip',
        'data-inspector-seg': 'clip',
        'data-testid': 'inspector-seg-clip',
        'data-advanced-settings': true,
        style: tab === 'advanced' ? undefined : { display: 'none' },
      },
      props.selectedCount > 0 ? h('h3', { className: 'panel-title' }, '片段设置') : null,
      clip === null || !showClipFields
        ? null
        : h(GroupedInspector, {
            key: clip.id,
            clip,
            kind: kindOf(clip),
            layerAt: props.layerAt ?? '',
            busy: props.fieldBusy === true,
            onCommit: props.onFieldCommit ?? (() => {}),
          }),
      // —— 页签（M27）：属性/图层 vs 动效。动效页只在选中单个片段时可用 ——
      h(
        'div',
        { className: 'inspector-tabs', 'data-testid': 'inspector-tabs', style: props.selectedCount === 1 ? undefined : { display: 'none' } },
        h(
          'button',
          {
            type: 'button',
            className: `inspector-tab${(props.tab ?? 'props') === 'props' ? ' active' : ''}`,
            'data-testid': 'inspector-tab-props',
            onClick: () => props.onTab?.('props'),
          },
          '参数',
        ),
        h(
          'button',
          {
            type: 'button',
            className: `inspector-tab${props.tab === 'motion' ? ' active' : ''}`,
            'data-testid': 'inspector-tab-motion',
            'data-enabled': props.selectedCount === 1 ? 'true' : 'false',
            title: props.selectedCount === 1 ? '为当前片段添加动效，可撤销' : '选中单个片段后才能应用动效',
            onClick: () => props.onTab?.('motion'),
          },
          '动效',
        ),
      ),
      // —— 视频自带的音轨（M35）：只在属性页签下出现，排在音频区之前 ——
      props.trackAudio === null || props.trackAudio === undefined
        ? null
        : h(
            'div',
            {
              className: 'inspector-section',
              'data-testid': 'inspector-track-audio',
              style: { display: props.tab === 'motion' ? 'none' : undefined },
            },
            h(TrackAudioPanel, props.trackAudio),
          ),
      // —— 音频（M31）：音量 / 淡变的可编辑控件；只在属性页签下出现 ——
      props.audio === null || props.audio === undefined
        ? null
        : h(
            'div',
            {
              className: 'inspector-section',
              'data-testid': 'inspector-audio',
              style: { display: props.tab === 'motion' ? 'none' : undefined },
            },
            h(AudioPanel, props.audio),
          ),
      // —— 动效（M27）：副线1 的面板挂这里；空库/缺源/加载失败都由面板自己给出口 ——
      h(
        'div',
        {
          className: 'inspector-section',
          'data-testid': 'inspector-motion',
          style: { display: props.tab === 'motion' ? undefined : 'none' },
        },
        h('div', { className: 'panel-title-row' }, h('div', { className: 'panel-title' }, '动效')),
        h(
          'p',
          { className: 'hint', 'data-testid': 'motion-hint' },
          props.selectedCount === 1
            ? '选择动效模板，应用后可撤销。'
            : '选择一个场景片段以添加动效。',
        ),
        showMotion && props.motionPresets !== null && props.motionPresets !== undefined
          ? h(MotionPresets, props.motionPresets)
          : null,
        showMotion && props.motionManage !== null && props.motionManage !== undefined
          ? h(MotionManage, props.motionManage)
          : null,
        showMotion
          ? h('div', { className: 'motion-mount', 'data-testid': 'motion-panel-mount', ref: props.motionMountRef })
          : null,
      ),
      h(
        'details',
        { className: 'inspector-document-details', 'data-testid': 'inspector-document-details' },
        h('summary', null, '工程详情'),
        h(
          'dl',
          { className: 'fields' },
          h('div', { style: { display: 'contents' } }, h('dt', null, '版本指纹'), h('dd', { 'data-testid': 'doc-hash-full' }, props.hash || '—')),
          h('div', { style: { display: 'contents' } }, h('dt', null, '播放位置'), h('dd', null, num(props.playhead))),
          h('div', { style: { display: 'contents' } }, h('dt', null, '帧率'), h('dd', null, `${props.fps.num}/${props.fps.den}`)),
        ),

      ),
    ),
  );
}

export interface EmptyStageProps {
  title: string;
  detail: string;
  busy?: boolean;
}

export function EmptyStage(props: EmptyStageProps): ReactNode {
  return h(
    'div',
    { className: 'empty', 'data-testid': 'stage-empty' },
    h('strong', null, props.title),
    h('span', null, props.detail),
    props.busy === true ? h('span', { className: 'chip' }, '处理中…') : null,
  );
}

/** —— 舞台预览（内容 origin 的 iframe） —— */

export interface StagePreviewProps {
  /** 舞台页 URL；null = 内容 origin 没起。 */
  url: string | null;
  /** 换工程/换 doc 时重建 iframe（保证 doc.json 是新的）。 */
  iframeKey: string;
  ready: boolean;
  contentOrigin: string;
  missingReason: string;
  errorCode: string;
  errorMessage: string;
  onIframe: (element: HTMLIFrameElement | null, onPresent: () => void) => void;
  /** 舞台容器（画布手势的覆盖层挂这里；覆盖层 position:fixed，不参与布局）。 */
  frameRef?: (element: HTMLDivElement | null) => void;
}

export function StagePreview(props: StagePreviewProps): ReactNode {
  const hasStage = props.url !== null;
  const [presented, setPresented] = useState<{ key: string; url: string } | null>(null);
  const url = props.url;
  const activeKey = `${props.iframeKey}@${url ?? ''}`;
  const previous = hasStage && presented !== null && presented.key !== activeKey ? presented : null;
  const setIframe = useCallback((element: HTMLIFrameElement | null) => {
    props.onIframe(element, () => {
      if (url !== null) setPresented({ key: activeKey, url });
    });
  }, [activeKey, url, props.onIframe]);

  // An unavailable document must eventually show its own loading/error state.
  useEffect(() => {
    if (previous === null) return;
    const timer = window.setTimeout(() => setPresented(null), 8000);
    return () => window.clearTimeout(timer);
  }, [activeKey, previous]);

  function frame(key: string, src: string, active: boolean): ReactNode {
    const covered = active && previous !== null;
    return h('iframe', {
      key, src, ref: active ? setIframe : undefined,
      className: 'preview-iframe', title: active ? '舞台预览' : '上一画面',
      allow: 'autoplay', inert: !active || covered, 'aria-hidden': !active || covered,
      style: { opacity: covered ? 0 : 1, pointerEvents: active && !covered ? 'auto' : 'none' },
      'data-testid': active ? 'preview-iframe' : 'preview-previous-frame',
      'data-content-origin': props.contentOrigin,
    });
  }
  return h(
    'div',
    { className: 'preview', 'data-testid': 'preview' },
    h(
      'div',
      { className: 'preview-frame', ref: props.frameRef, 'data-testid': 'preview-frame' },
      hasStage && url !== null
        ? [
            previous === null ? null : frame(previous.key, previous.url, false),
            frame(activeKey, url, true),
          ]
        : h('div', { className: 'empty' }, h('strong', null, '预览不可用'), h('span', null, props.missingReason)),
      hasStage && props.errorCode !== ''
        ? h(
            'div',
            { className: 'preview-error', 'data-testid': 'stage-error', 'data-code': props.errorCode },
            h('strong', null, props.errorCode),
            h('span', null, props.errorMessage),
          )
        : null,
      hasStage && previous === null && !props.ready && props.errorCode === ''
        ? h('div', { className: 'preview-overlay', 'data-testid': 'stage-pending' }, '画面准备中…')
        : null,
    ),
  );
}

/**
 * 舞台状态行（R38 · C 批：从画面的**下方**搬进播放器卡左上角的介绍区）。
 *
 * 元素、testid、data-* 一个没删（`stage-status` / `stage-time` / `stage-delivery-note`
 * 是 s74 的等就绪信号与像素对齐的读数），只是换了宿主与排版：
 * 原来它是一条 26px 高的整宽横条，现在缩成卡片头部的一组内联文本。
 *
 * `timeRef` 是**播放中**那段的关键：`App.paintStage` 每帧直接写这个节点的文本
 * （播放时整棵树不 setState，见 App 的「时间码与播放头走 ref + rAF」）。
 * 不接这根 ref 的话，`t=` 只在暂停时才跳一次 —— C11「播放真能驱动」会读成不动。
 */
export interface StageStatusProps {
  hasStage: boolean;
  ready: boolean;
  playing: boolean;
  time: number;
  /** 播放中由 `paintStage` 每帧写 `t=`（不 setState）。 */
  timeRef?: RefObject<HTMLSpanElement | null>;
  contentOrigin: string;
  deliveryNote?: string;
}

export function StageStatus(props: StageStatusProps): ReactNode {
  const statusText = !props.hasStage ? '内容 origin 未启动' : props.ready ? '舞台就绪' : '舞台连接中';
  return h(
    'div',
    {
      className: 'preview-status',
      'data-testid': 'stage-status',
      'data-ready': props.ready ? 'true' : 'false',
      'data-playing': props.playing ? 'true' : 'false',
      'data-content-origin': props.contentOrigin,
    },
    h('span', { className: `dot ${!props.hasStage ? 'down' : props.ready ? 'ok' : 'warn'}` }),
    h('span', { className: 'sc-status-text' }, statusText),
    props.hasStage ? h('span', { className: 'mono-dim sc-origin', title: props.contentOrigin }, `· ${props.contentOrigin}`) : null,
    props.hasStage ? h('span', { className: 'mono-dim', 'data-testid': 'stage-time', ref: props.timeRef }, `t=${num(props.time, 2)}s`) : null,
    props.hasStage && props.deliveryNote !== undefined && props.deliveryNote !== ''
      ? h('span', { className: 'chip', 'data-testid': 'stage-delivery-note' }, props.deliveryNote)
      : null,
  );
}

/**
 * R164 · UI-V3-A（VIEW-01）：画布右下角的**信息按钮** + 点开的工程信息浮层。
 *
 * 改前：工程名 / 序列 / 分辨率 / 轨数·片段数·时长 以 30px 暗角横条**常驻压在画面左上**，
 * 与顶栏的工程标签重复（图 B01）。改后：画面上一律不显示统计，只留一颗 22px 的 `i`；
 * 点开才出这四项。**四个 testid 一个没改**（`player-project` / `player-sequence` /
 * `player-stage` / `player-counts`），s195 C2、s201 C8 仍按 id 读文本，只是默认隐藏。
 *
 * 交互：点击开合；Esc 关；点外面关；焦点回按钮。按钮在画面右下角（不挡字幕/角标）。
 */
export interface StageInfoProps {
  projectName: string;
  sequenceName: string;
  stage: { w: number; h: number };
  tracks: number;
  clips: number;
  duration: number;
  /** 帧率 · 总时长（原走带条右下的 `stage-meta`）。 */
  metaText: string;
}

export function StageInfo(props: StageInfoProps): ReactNode {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: PointerEvent): void => {
      const box = boxRef.current;
      if (box !== null && event.target instanceof Node && !box.contains(event.target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      btnRef.current?.focus();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  const row = (label: string, testid: string, text: string): ReactNode =>
    h(
      'div',
      { className: 'sc-info-row', key: testid },
      h('span', { className: 'sc-info-key' }, label),
      h('span', { className: 'sc-info-val', 'data-testid': testid }, text),
    );
  return h(
    'div',
    { className: 'sc-info', ref: boxRef, 'data-open': open ? 'true' : 'false' },
    h(
      'button',
      {
        ref: btnRef,
        className: 'sc-info-btn',
        type: 'button',
        'data-testid': 'stage-info',
        'aria-label': '画面信息',
        'aria-haspopup': 'dialog',
        'aria-expanded': open ? 'true' : 'false',
        title: '查看画面与工程信息',
        onClick: () => setOpen((previous) => !previous),
      },
      h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true', focusable: 'false' },
        h('circle', { cx: 8, cy: 8, r: 6.4, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
        h('path', { d: 'M8 7.2 V11.2', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
        h('circle', { cx: 8, cy: 4.9, r: 0.85, fill: 'currentColor' }),
      ),
    ),
    h(
      'div',
      { className: 'sc-info-panel', 'data-testid': 'stage-info-panel', role: 'dialog', 'aria-label': '画面信息', hidden: !open },
      row('工程', 'player-project', props.projectName),
      row('序列', 'player-sequence', props.sequenceName),
      row('分辨率', 'player-stage', `${props.stage.w} × ${props.stage.h}`),
      row('统计', 'player-counts', `${props.tracks} 轨 · ${props.clips} 片段 · ${num(props.duration)}s`),
      row('播放参数', 'stage-meta', props.metaText),
    ),
  );
}

/**
 * 播放器卡底栏（R38 · C 批）：走带条从「舞台下方一条通栏」改成**卡内三段式**。
 *
 * ```
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ 时间码  音量 ▬▬▬▬        ⏮ ◀| ▶ |▶ ⏭ 1x 循环       30fps·00:12  比例 │
 * │ 电平表 ▁▁                                                    16:9 … │
 * └──────────────────────────────────────────────────────────────────────┘
 *        ↑ 左下角（C3）          ↑ 中下偏左（C4）              ↑ 右下角（C5）
 * ```
 *
 * 为什么不是「把 transport 整条搬进卡」：**C3 要求音量的中心落在 `cx<35%`**，
 * 而原来音量在整条的最右边（cx 84.5%）—— 只换宿主不重排，判据照样红。
 * 所以按角色分成三段：时间码+音量靠左、走带居中偏左、参数+比例靠右。
 *
 * 九个既有控件的 `data-testid` 一个没改（s79 按 testid 找它们），
 * 去掉的只有 `.spacer` 与原来的换行规则（`flex-wrap` 是 S79 为了「不压控件」加的，
 * 现在三段各自收紧，不再需要靠换行兜底）。
 */
export interface TransportBarProps {
  disabled: boolean;
  playing: boolean;
  rate: number;
  volume: number;
  loop: boolean;
  timecode: string;
  timecodeRef: RefObject<HTMLSpanElement | null>;
  onPlayPause: () => void;
  onHome: () => void;
  onEnd: () => void;
  onPrevFrame: () => void;
  onNextFrame: () => void;
  onRate: (value: number) => void;
  onVolume: (value: number) => void;
  onLoop: () => void;
  /** M32 电平表（App 传 <LevelMeter/>；没有声音的工程自己显示「无音轨」）。 */
  meter?: ReactNode;
  /** 右下角第一行：基本参数（帧率 · 总时长）。 */
  meta?: ReactNode;
  /** 右下角第二行：比例选择（四档）。 */
  ratios?: ReactNode;
}

/**
 * E01（R16）：播放控件的两段 path（同一个 viewBox 0 0 16 16）。
 * 停＝实心三角；播放中＝两根竖条（两个子路径，一条 path 就能画完）。
 * 只换 `d`，不换 path 节点数 —— 证据里「d 变了」才是状态真的换了图标。
 */
const TRANSPORT_ICON_PLAY = 'M4.5 2.5 L13.5 8 L4.5 13.5 Z';
const TRANSPORT_ICON_PAUSE = 'M4.5 2.5 H7.1 V13.5 H4.5 Z M8.9 2.5 H11.5 V13.5 H8.9 Z';

export function TransportBar(props: TransportBarProps): ReactNode {
  /* R164 · UI-V3-A（B03/B04/B05）：低频项收进两个弹层，主行只留「时间码 · 音量 · 逐帧/播放 · 比例 · 设置」。
     · 音量：图标常驻；滑块与 L/R 电平表进弹层 —— `transport-volume` 还是原来那个 input，handler 不变。
     · 播放设置：首尾跳转 / 倍速 / 循环收进齿轮 —— 四个 testid 与 `onHome`/`onEnd`/`onRate`/`onLoop` 一个没改。
     弹层规则：点击开合、Esc 关且焦点回触发键、点外面关；两者都向上展开（不压时间线）。 */
  const [panel, setPanel] = useState<'volume' | 'settings' | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const volumeRef = useRef<HTMLButtonElement | null>(null);
  const settingsRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (panel === null) return undefined;
    const onDown = (event: PointerEvent): void => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && !root.contains(event.target)) setPanel(null);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      const back = panel === 'volume' ? volumeRef.current : settingsRef.current;
      setPanel(null);
      back?.focus();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [panel]);
  const toggle = (which: 'volume' | 'settings'): void => setPanel((previous) => (previous === which ? null : which));
  const muted = props.volume <= 0.0001;
  return h(
    'div',
    { className: 'transport', 'data-testid': 'transport', 'data-panel': panel ?? '', ref: rootRef },
    /* ── 左：时间码 + 音量图标（弹层里有滑块与电平） ── */
    h(
      'div',
      { className: 'tp-left' },
      h('span', { className: 'tc', ref: props.timecodeRef, 'data-testid': 'timecode' }, props.timecode),
      h(
        'div',
        { className: 'tp-pop-host' },
        h(
          'button',
          {
            ref: volumeRef,
            className: 'btn icon tp-icon-btn',
            type: 'button',
            title: `音量 ${String(Math.round(props.volume * 100))}%（点开滑块与电平）`,
            'aria-label': '音量',
            'aria-haspopup': 'dialog',
            'aria-expanded': panel === 'volume' ? 'true' : 'false',
            'data-testid': 'transport-volume-toggle',
            'data-muted': muted ? 'true' : 'false',
            onClick: () => toggle('volume'),
          },
          editorIcon(muted ? 'volume-off' : 'volume', 16),
        ),
        h(
          'div',
          { className: 'tp-pop tp-pop-volume', 'data-testid': 'transport-volume-panel', role: 'dialog', 'aria-label': '音量', hidden: panel !== 'volume' },
          h(
            'div',
            { className: 'tp-pop-row' },
            h('span', { className: 'tp-pop-key' }, '音量'),
            h('input', {
              type: 'range',
              min: 0,
              max: 1,
              step: 0.01,
              value: props.volume,
              disabled: props.disabled,
              'aria-label': '音量',
              'data-testid': 'transport-volume',
              onChange: (event: { currentTarget: HTMLInputElement }) => props.onVolume(Number(event.currentTarget.value)),
            }),
            h('span', { className: 'tp-pop-val' }, `${String(Math.round(props.volume * 100))}%`),
          ),
          props.meter === undefined ? null : h('div', { className: 'tp-meter' }, props.meter),
        ),
      ),
    ),
    /* ── 中：逐帧 / 播放暂停 / 逐帧（主操作常驻） ── */
    h(
      'div',
      { className: 'tp-center' },
      h('button', { className: 'btn icon', type: 'button', title: '上一帧（,）', 'aria-label': '上一帧', disabled: props.disabled, onClick: props.onPrevFrame, 'data-testid': 'transport-prev-frame' }, editorIcon('prev-frame', 16)),
      h(
        'button',
        {
          className: 'btn primary icon',
          type: 'button',
          disabled: props.disabled,
          onClick: props.onPlayPause,
          'data-testid': 'transport-play',
          'data-playing': props.playing ? 'true' : 'false',
          'aria-label': props.playing ? '暂停' : '播放',
          title: props.playing ? '暂停' : '播放',
        },
        editorIcon(props.playing ? 'pause' : 'play', 16),
      ),
      h('button', { className: 'btn icon', type: 'button', title: '下一帧（.）', 'aria-label': '下一帧', disabled: props.disabled, onClick: props.onNextFrame, 'data-testid': 'transport-next-frame' }, editorIcon('next-frame', 16)),
    ),
    /* ── 右：参数（帧率 · 总时长）+ 当前比例 + 播放设置 ── */
    h(
      'div',
      { className: 'tp-right' },
      props.meta === undefined ? null : h('div', { className: 'tp-meta' }, props.meta),
      props.ratios === undefined ? null : h('div', { className: 'tp-ratios' }, props.ratios),
      h(
        'div',
        { className: 'tp-pop-host' },
        h(
          'button',
          {
            ref: settingsRef,
            className: 'btn icon tp-icon-btn',
            type: 'button',
            title: '播放设置：首尾跳转 / 倍速 / 循环',
            'aria-label': '播放设置',
            'aria-haspopup': 'menu',
            'aria-expanded': panel === 'settings' ? 'true' : 'false',
            'data-testid': 'transport-settings',
            onClick: () => toggle('settings'),
          },
          chromeGlyph('settings'),
        ),
        h(
          'div',
          { className: 'tp-pop tp-pop-settings', role: 'menu', 'aria-label': '播放设置', 'data-testid': 'transport-settings-panel', hidden: panel !== 'settings' },
          h('div', { className: 'tp-pop-title' }, '播放设置'),
          h(
            'button',
            { className: 'tp-pop-item', type: 'button', role: 'menuitem', disabled: props.disabled, onClick: props.onHome, 'data-testid': 'transport-home', title: '跳到开头（Home）' },
            h('span', { className: 'tp-pop-ico', 'aria-hidden': 'true' }, editorIcon('home')),
            h('span', { className: 'tp-pop-name' }, '跳到开头'),
            h('span', { className: 'tp-pop-hint' }, 'Home'),
          ),
          h(
            'button',
            { className: 'tp-pop-item', type: 'button', role: 'menuitem', disabled: props.disabled, onClick: props.onEnd, 'data-testid': 'transport-end', title: '跳到结尾（End）' },
            h('span', { className: 'tp-pop-ico', 'aria-hidden': 'true' }, editorIcon('end')),
            h('span', { className: 'tp-pop-name' }, '跳到结尾'),
            h('span', { className: 'tp-pop-hint' }, 'End'),
          ),
          h(
            'button',
            {
              className: 'tp-pop-item',
              type: 'button',
              role: 'menuitem',
              disabled: props.disabled,
              onClick: () => props.onRate(props.rate === 1 ? 2 : 1),
              'data-testid': 'transport-rate',
              'data-rate': String(props.rate),
              title: 'J/K/L：L 倍速，K 暂停，J 逐帧倒退',
            },
            h('span', { className: 'tp-pop-ico', 'aria-hidden': 'true' }, `${num(props.rate, 2)}x`),
            h('span', { className: 'tp-pop-name' }, '倍速'),
            h('span', { className: 'tp-pop-hint' }, 'J/K/L'),
          ),
          h(
            'button',
            {
              className: `tp-pop-item${props.loop ? ' active' : ''}`,
              type: 'button',
              role: 'menuitemcheckbox',
              'aria-checked': props.loop ? 'true' : 'false',
              disabled: props.disabled,
              onClick: props.onLoop,
              'data-testid': 'transport-loop',
              'data-on': props.loop ? 'true' : 'false',
              title: '循环播放',
            },
            h('span', { className: 'tp-pop-ico', 'aria-hidden': 'true' }, editorIcon('loop')),
            h('span', { className: 'tp-pop-name' }, '循环'),
            h('span', { className: 'tp-pop-hint' }, props.loop ? '循环 开' : '循环 关'),
          ),
        ),
      ),
    ),
  );
}
/**
 * 比例选择（R38 · C 批）：四颗按钮，**文字就是比例本身**（`16:9` 这种），
 * 不放图标、不加后缀 —— 判据 C5 按「文本正好是比例」认控件，C8 按
 * `aria-pressed`/`data-on` 认选中态。
 *
 * 尺寸映射在 `stage-ratios.mjs`（纯函数 + 单测）；这里只管画和点。
 */
export interface RatioPickerProps {
  /** 当前档（`ratioIdOf(doc.stage)`；不在四档内 → null，四颗都不选中）。 */
  current: string | null;
  disabled?: boolean;
  onPick: (id: string) => void;
  /**
   * R164 · UI-V3-A（B06）：**永远收成一颗「当前档 ▾」**。
   * 四颗 `[data-ratio]` 仍留在 DOM 里（C5/C8 数得到 4，`aria-pressed` 照旧），
   * 只是视觉上不占主行 —— 主行只剩当前比例一项，四档完整菜单在弹层里。
   */
  compact?: boolean;
}

export function RatioPicker(props: RatioPickerProps): ReactNode {
  /* R102 · U1-R2（补正书 §3）：**窄卡把四画幅收进「更多 ▾」**，仍可达、有 aria-label。
     宽卡（≥500 容器宽）四颗照旧一排；窄卡收成一颗「当前档 ▾」。
     菜单项用独立 testid（`ratio-more-*`）且**不带 `data-ratio`** —— 那个属性是
     「四档」的排他标记，C5 按 `querySelectorAll('[data-ratio]')` 数 4，重一份就变 8。 */
  const [moreOpen, setMoreOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!moreOpen) return undefined;
    const onDown = (event: PointerEvent): void => {
      const box = boxRef.current;
      if (box !== null && event.target instanceof Node && !box.contains(event.target)) setMoreOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setMoreOpen(false);
      moreRef.current?.focus();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [moreOpen]);
  const current = STAGE_RATIOS.find((option) => option.id === props.current) ?? null;
  return h(
    'div',
    {
      className: `ratios${props.compact === true ? ' ratios-compact' : ''}`,
      'data-testid': 'stage-ratios',
      role: 'group',
      'aria-label': '画幅比例',
      ref: boxRef,
    },
    STAGE_RATIOS.map((option) =>
      h(
        'button',
        {
          key: option.id,
          type: 'button',
          className: `ratio-btn${props.current === option.id ? ' primary' : ''}`,
          'data-testid': `stage-ratio-${option.id.replace(':', '-')}`,
          'data-ratio': option.id,
          'data-on': props.current === option.id ? 'true' : 'false',
          'aria-pressed': props.current === option.id ? 'true' : 'false',
          /* U02：窄卡里文字钮会收成几何小图标（文字用 CSS 隐藏），
             可访问名不能跟着没 —— 这里显式给 aria-label，宽卡时与可见文字一致。 */
          'aria-label': `${option.id} 画幅（${String(option.w)}×${String(option.h)}）`,
          title: `${option.id} · ${option.w}×${option.h}`,
          disabled: props.disabled === true,
          onClick: () => props.onPick(option.id),
        },
        option.id,
      ),
    ),
    h(
      'div',
      { className: 'ratio-more' },
      h(
        'button',
        {
          ref: moreRef,
          type: 'button',
          className: 'ratio-btn ratio-more-toggle',
          'data-testid': 'ratio-more',
          'data-current': current?.id ?? '',
          'aria-haspopup': 'menu',
          'aria-expanded': moreOpen ? 'true' : 'false',
          'aria-label': `画幅比例：${current?.id ?? '未选'}（展开四档）`,
          title: '更多画幅（16:9 / 9:16 / 1:1 / 4:3）',
          disabled: props.disabled === true,
          onClick: () => setMoreOpen((previous) => !previous),
        },
        h('span', { className: 'ratio-more-label' }, current?.id ?? '画幅'),
        h('span', { className: 'ratio-more-caret', 'aria-hidden': 'true' }, '▾'),
      ),
      h(
        'div',
        { className: 'ratio-more-panel', 'data-testid': 'ratio-more-panel', role: 'menu', 'aria-label': '画幅比例', hidden: !moreOpen },
        STAGE_RATIOS.map((option) =>
          h(
            'button',
            {
              key: option.id,
              type: 'button',
              role: 'menuitemradio',
              'aria-checked': props.current === option.id ? 'true' : 'false',
              'data-testid': `ratio-more-${option.id.replace(':', '-')}`,
              className: `ratio-more-item${props.current === option.id ? ' active' : ''}`,
              onClick: () => {
                setMoreOpen(false);
                props.onPick(option.id);
              },
            },
            h('span', null, option.id),
            h('small', null, `${String(option.w)}×${String(option.h)}`),
          ),
        ),
      ),
    ),
  );
}

// —— 导出面板（M17）——

/** 多段导出的单行（M39）：两个输入框都是**原始文本**，解析交给 film-core。 */
export interface ExportRangeRow {
  start: string;
  end: string;
}

export interface ExportForm {
  range: 'all' | 'inout' | 'multi';
  /** 入出点（秒，字符串来自输入框；只有 range='inout' 时用）。 */
  start: string;
  end: string;
  /** 多段区间（M39）：1–100 行，顺序即拼接顺序。 */
  ranges: ExportRangeRow[];
  /** 档名与 packages/render/quality.mjs 一致（draft=4:2:0 最大兼容，standard/high=4:4:4 画质档）。 */
  quality: 'draft' | 'standard' | 'high';
  /**
   * 视频编码（M50）：与 `packages/render/codec-matrix.mjs` 的 CODEC_NAMES 一致。
   * 默认 `h264` —— 不选时请求体不带这个字段之外的东西，产物与 R24 逐字节相同。
   */
  codec: 'h264' | 'hevc';
  /** 空 = 工程内 exports/。 */
  outDir: string;
  /**
   * 烧字幕（M41）：开关本身是请求字段 `subtitleBurn`，字幕源由 `subtitleSrc` 单独给。
   * 关掉时不发这两个字段（请求体与 R20 逐字节相同）。
   */
  subtitleBurn: boolean;
  /**
   * 画幅（M42）：`''` = 跟随工程（不发 size/fit）；否则是 `WxH` 文本，提交时交给
   * `render/delivery-size.mjs` 的 `parseSizeArg`（不自己写正则）。
   */
  size: string;
  /** 适配：letterbox（默认，不裁内容）/ cover（填满，裁边）。 */
  fit: 'letterbox' | 'cover';
  /** 输出帧率（24/25/30/50/60）。 */
  fps: number;
}

/**
 * 平台预设（M54）：**六个字段一起填**，不是只改画幅。
 *
 * 每一行都必须能和 CLI `export film --size/--quality/--codec/--fps/--fit` 一一对上：
 * 服务端没有 `preset` 字段，也不许有（否则预设会变成第三个真相源）。
 *
 * `follow` 是「什么都不发」的那一档——跟随工程，请求体里没有 size/fit。
 * 竖屏用 `cover`：交付竖屏短片时上下黑边不可接受，宁可裁两侧；横屏/4K 用
 * `letterbox`，不裁内容。这条口径来自 M54 任务书，与 M42 时期的竖屏预设相反，
 * 已同步更新 `scripts/m42-export-presets.mjs` 的 A6 期望。
 *
 * @type {ReadonlyArray<Readonly<{ id: string, label: string, size: string, fit: 'letterbox'|'cover', fps: number, codec: 'h264'|'hevc', quality: 'draft'|'standard'|'high' }>>}
 */
export const EXPORT_PRESETS = Object.freeze([
  Object.freeze({ id: 'follow', label: '跟随工程', size: '', fit: /** @type {const} */ ('letterbox'), fps: 30, codec: /** @type {const} */ ('h264'), quality: /** @type {const} */ ('standard') }),
  Object.freeze({ id: 'landscape', label: '1080p 横屏', size: '1920x1080', fit: /** @type {const} */ ('letterbox'), fps: 30, codec: /** @type {const} */ ('h264'), quality: /** @type {const} */ ('standard') }),
  Object.freeze({ id: 'portrait', label: '竖屏 1080×1920', size: '1080x1920', fit: /** @type {const} */ ('cover'), fps: 30, codec: /** @type {const} */ ('h264'), quality: /** @type {const} */ ('high') }),
  Object.freeze({ id: '4k', label: '4K HEVC', size: '3840x2160', fit: /** @type {const} */ ('letterbox'), fps: 30, codec: /** @type {const} */ ('hevc'), quality: /** @type {const} */ ('high') }),
]);


/** 帧率档位（M42）：与任务书的 24/25/30/50/60 一致。 */
export const EXPORT_FPS_CHOICES = Object.freeze([24, 25, 30, 50, 60]);

/** 导出面板要知道「这个工程有没有伴生字幕」（M41）：没有就禁用烧录开关。 */
export interface ExportSubtitleInfo {
  /** 第一个视频片段的 src（剥掉 `#t=`）：烧录用它找伴生文件。 */
  src: string;
  /** 找到的伴生文件（`assets/a.vtt`）；空 = 没有。 */
  file: string;
  /** 条目数（0 = 文件在但没内容）。 */
  cues: number;
}

export interface ExportPanelProps {
  form: ExportForm;
  /** 队列（**入队顺序**；串行执行，最多一个 running）。 */
  queue: ExportJobView[];
  duration: number;
  busy: boolean;
  /** 缺失素材（M26）：导出前守门——列出来，让人明确知道会失败在哪里。 */
  missing?: { count: number; clips: string[] };
  /** 伴生字幕（M41）：没有就禁用「烧字幕」，并说明原因。 */
  subtitle?: ExportSubtitleInfo | null;
  /**
   * 要导出的序列（S73）。`main` 时请求体**不带** `sequence`（旧行为逐字节一致），
   * 面板上仍显示「将导出：main」——让人确认导出的是哪一份，而不是猜。
   */
  sequence?: { id: string; name: string } | null;
  /** 历史（localStorage 侧；M29）。 */
  history?: ExportHistoryItem[];
  /** 能不能调系统「在文件夹中显示」（Electron）。浏览器里退化为复制路径。 */
  canReveal?: boolean;
  onChange: (patch: Partial<ExportForm>) => void;
  /** 多段（M39）：逐行改 / 增 / 删 / 上移下移。顺序即拼接顺序。 */
  onRangeChange: (index: number, patch: Partial<ExportRangeRow>) => void;
  onRangeAdd: () => void;
  onRangeRemove: (index: number) => void;
  onRangeMove: (index: number, delta: number) => void;
  onStart: () => void;
  /** 取消某一个（队列里的或正在跑的）。 */
  onCancel: (id: string) => void;
  /** 完成后定位产物：Electron = showItemInFolder；浏览器 = 复制路径。 */
  onReveal: (path: string) => void;
  /** 失败详情一键复制（code + 人话 + 作业 id + 时间）。 */
  onCopyDetail: (job: ExportJobView) => void;
  /** MEDIA_MISSING：跳到「素材 · 缺失」。 */
  onOpenRelink: () => void;
  onClearHistory: () => void;
  onClose: () => void;
}

/**
 * 预设覆盖的五个字段快照（M54 A4）：`appliedRef` 存的就是这个形状。
 * @param {{ size: string, fit: string, fps: number, codec: string, quality: string }} form
 */
function snapshotOf(form: { size: string; fit: string; fps: number; codec: string; quality: string }) {
  return { size: form.size, fit: form.fit, fps: form.fps, codec: form.codec, quality: form.quality };
}

/** @param {number} bytes */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

const STAGE_LABEL: Record<string, string> = {
  queued: '排队中',
  plan: '解析计划',
  capture: '舞台取帧',
  video: '编码画面',
  // 烧录（M50）：第二次编码。以前没有这个阶段，长片烧字幕看起来卡在 86%。
  burn: '烧录字幕',
  mux: '封装音轨',
  verify: '校验成品',
  done: '完成',
};

const STATE_LABEL: Record<string, string> = {
  queued: '排队',
  running: '进行中',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
};

/** 三件套的标签（M41）：master 是主产物，subbed 是烧了字幕的那份。 */
const ARTIFACT_LABEL: Record<string, string> = {
  master: '主片',
  subbed: '带字幕',
  vtt: '字幕文件',
};

/** 失败码 → 一句人话（没有条目就退回服务端的 message）。 */
const ERROR_HUMAN: Record<string, string> = {
  MEDIA_MISSING: '有片段找不到素材文件：先去「素材 · 缺失」重链，再重导。',
  NO_FILM: '这个目录里没有 film.html：先打开一个工程。',
  INVALID_RANGE: '入出点不合法：需要 0 ≤ 入点 < 出点，且不超出片长。',
  EMPTY_FILM: '片子里没有可导出的画面片段。',
  UNSUPPORTED_SCENE_CLIP: '网页片段需要走舞台取帧那条路（本机没装 Chromium？）。',
  CODEC_UNAVAILABLE: 'ffmpeg 起不来：检查本机 ffmpeg 是否在 PATH 里。',
  FRAME_FAILED: '编码器报错：详情里有 ffmpeg 的原始输出。',
  OUTPUT_UNVERIFIED: '产物校验没过：文件可能不完整，别直接用。',
  CANCELLED: '已取消。',
};

/** @param {string} iso */
function clockOf(iso: string): string {
  if (iso === '') return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  /** @param {number} n */
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** @param {number} ms */
function durationText(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`;
}

export function ExportPanel(props: ExportPanelProps): ReactNode {
  const queue = props.queue;
  const running = queue.find((item) => item.state === 'running') ?? null;
  const queued = queue.filter((item) => item.state === 'queued');
  // 焦点作业：在跑的优先；否则最近一个终态（错误/结果块都看它，保持 M17 的判据不变）。
  const focus =
    running ??
    [...queue].reverse().find((item) => item.state === 'done' || item.state === 'failed' || item.state === 'cancelled') ??
    null;
  const percent = focus === null ? 0 : Math.round(focus.percent * 1000) / 10;
  /**
   * 烧录帧计数（M50）：烧录是**第二次编码**，`job.frames` 是母版编码的计数（早就满了）。
   * 这里取的是最后一条 `phase:'burn'` 事件里的 frame/totalFrames。
   */
  const burnEvent = focus?.stage === 'burn' ? (focus.progress ?? null) : null;
  const burnFrame = Number(burnEvent?.frame);
  const burnTotal = Number(burnEvent?.totalFrames);
  /**
   * 队列里显示什么：**在跑/在等的全显示**，终态只留最近 4 条。
   * 否则一上午导十次，面板里堆二十行历史态的作业，真正在跑的反而要往下翻。
   * （完整记录在「历史」里，那份是持久化的。）
   */
  const visibleQueue = (() => {
    const active = queue.filter((item) => item.state === 'running' || item.state === 'queued');
    const terminal = queue.filter((item) => item.state !== 'running' && item.state !== 'queued').slice(-4);
    const keep = new Set([...active, ...terminal].map((item) => item.id));
    return queue.filter((item) => keep.has(item.id));
  })();
  const history = props.history ?? [];
  const canReveal = props.canReveal === true;
  const failedWithMissing = focus !== null && focus.state === 'failed' && (focus.error?.code ?? '') === 'MEDIA_MISSING';
  /**
   * 多段的预估（M39）：**解析与算术都在 `film-core/export-range.mjs`**，
   * 面板只负责把结果画出来。非法时不编数字，直接把「第几段哪里不对」显示在估算位。
   */
  const rangeRows = props.form.ranges ?? [];
  const multiPreview = (() => {
    const planned = planRangeInputs(rangeRows);
    return planned.ok === true
      ? { ok: true as const, seconds: planned.totalSec, frames: planned.frames, segments: planned.ranges.length }
      : { ok: false as const, message: planned.message };
  })();
  /**
   * 烧字幕（M41）：能不能开、现在开没开。没有伴生字幕时按钮禁用——不做「点了没反应」。
   * 表单里残留的 `true`（换了工程 / 删了字幕）在**提交时**也会被 App 压回 false。
   */
  const subtitleInfo = props.subtitle ?? null;
  const burnAvailable = subtitleInfo !== null && subtitleInfo.file !== '' && subtitleInfo.cues > 0;
  const burnOn = props.form.subtitleBurn === true && burnAvailable;
  /**
   * 预设（M54）：**当前表单值**能对上一组就高亮哪一组，对不上就是「自定义」。
   * 现在比对五个字段（画幅/适配/帧率/编码/画质）——只比画幅会出现
   * 「显示 4K HEVC、实际还是 h264」这种骗人的高亮。
   */
  const activePreset =
    EXPORT_PRESETS.find(
      (preset) =>
        preset.size === props.form.size &&
        preset.fit === props.form.fit &&
        preset.fps === props.form.fps &&
        preset.codec === props.form.codec &&
        preset.quality === props.form.quality,
    )?.id ?? 'custom';

  /**
   * 不静默覆盖（M54 A4）：切预设前先算「会覆盖几项手工改动」。
   *
   * `appliedRef` 是**上一次应用预设（或刚打开面板）时的快照**——只有跟它比，
   * 才知道哪些字段是人手动改过的。跟「当前高亮的预设」比会把预设自己写进去的值
   * 当成改动，于是每次切预设都弹确认，人会习惯性点「覆盖」。
   */
  const appliedRef = useRef<Record<string, unknown> | null>(null);
  if (appliedRef.current === null) appliedRef.current = snapshotOf(props.form);
  const [pendingPreset, setPendingPreset] = useState<{
    preset: (typeof EXPORT_PRESETS)[number];
    changed: number;
  } | null>(null);

  const applyPreset = (preset: (typeof EXPORT_PRESETS)[number]): void => {
    appliedRef.current = snapshotOf({ ...props.form, ...preset });
    setPendingPreset(null);
    props.onChange({ size: preset.size, fit: preset.fit, fps: preset.fps, codec: preset.codec, quality: preset.quality });
  };

  const requestPreset = (preset: (typeof EXPORT_PRESETS)[number]): void => {
    const base = appliedRef.current ?? snapshotOf(props.form);
    // 「会覆盖你改过的 N 项」只数**人改过、且预设会改掉**的那五个字段
    // （画幅 / 适配 / 帧率 / 编码 / 画质）。写死成五组而不是循环，是为了让 tsc
    // 认得出每个字段的真实类型——用字符串索引会把 `fps: number` 变成 any。
    /** @type {Array<[unknown, unknown, unknown]>} */
    const pairs = [
      [props.form.size, base.size, preset.size],
      [props.form.fit, base.fit, preset.fit],
      [props.form.fps, base.fps, preset.fps],
      [props.form.codec, base.codec, preset.codec],
      [props.form.quality, base.quality, preset.quality],
    ];
    let changed = 0;
    for (const [now, was, target] of pairs) {
      if (now !== was && now !== target) changed += 1;
    }
    if (changed > 0) {
      setPendingPreset({ preset, changed });
      return;
    }
    applyPreset(preset);
  };

  /**
   * 体积估算（M54-A3）：「跟随工程」不给数字——面板不知道工程画幅，
   * 编一个出来不如老实显示「—」。画幅非法/区间非法时同样返回 null。
   *
   * 帧数复用 `planRangeInputs`（跟提交走同一份算术），所以估的就是真正会导的那几帧。
   */
  const deliveryEstimate = (() => {
    if (props.form.size.trim() === '') return null;
    /** @type {{ w: number, h: number } | null} */
    let size = null;
    try {
      size = parseSizeArg(props.form.size);
    } catch {
      return null;
    }
    if (size === null) return null;
    const rows =
      props.form.range === 'multi'
        ? rangeRows
        : props.form.range === 'inout'
          ? [{ start: props.form.start, end: props.form.end }]
          : props.duration > 0
            ? [{ start: '0', end: String(props.duration) }]
            : [];
    if (rows.length === 0) return null;
    const planned = planRangeInputs(rows, {
      fps: props.form.fps,
      ...(props.duration > 0 ? { duration: props.duration } : {}),
    });
    if (planned.ok !== true) return null;
    return estimateDeliveryBytes({
      w: size.w,
      h: size.h,
      frames: planned.frames,
      fps: props.form.fps,
      quality: props.form.quality,
      codec: props.form.codec,
    });
  })();

  return h(
    'div',
    { className: 'modal-backdrop', 'data-testid': 'export-backdrop' },
    h(
      'section',
      {
        className: 'modal export-panel',
        'data-testid': 'export-panel',
        'data-state': focus?.state ?? 'idle',
        'data-queued': String(queued.length),
      },
      h(
        'header',
        { className: 'modal-head' },
        h('strong', null, '导出影片'),
        queued.length > 0 || running !== null
          ? h(
              'span',
              { className: 'chip', 'data-testid': 'export-queue-badge' },
              `${running === null ? '空闲' : '进行中 1'} · 排队 ${queued.length}`,
            )
          : null,
        h('button', { type: 'button', className: 'btn', 'data-testid': 'export-close', onClick: props.onClose }, '×'),
      ),

      /* 序列（S73）：先让人确认「导的是哪一份」，再看范围/画幅。 */
      h(
        'div',
        {
          className: 'export-sequence',
          'data-testid': 'export-sequence',
          'data-seq-id': props.sequence?.id ?? 'main',
          'data-carried': props.sequence === null || props.sequence === undefined || props.sequence.id === 'main' ? 'false' : 'true',
        },
        h('span', { className: 'modal-label' }, '序列'),
        h('strong', null, `将导出：${props.sequence?.name ?? 'main'}`),
        props.sequence === null || props.sequence === undefined || props.sequence.id === 'main'
          ? h('small', { className: 'modal-hint' }, 'main 是默认序列：请求体不带 sequence 字段（与旧版本逐字节一致）')
          : h('small', { className: 'modal-hint' }, `请求体带 sequence="${props.sequence.id}"，导的是这一份 film.html`),
      ),

      (props.missing?.count ?? 0) > 0
        ? h(
            'div',
            {
              className: 'export-warning',
              'data-testid': 'export-missing-warning',
              'data-missing-count': String(props.missing?.count ?? 0),
            },
            h('strong', null, `有 ${String(props.missing?.count)} 个片段找不到素材`),
            h('span', null, `这些片段：${(props.missing?.clips ?? []).join('、')}`),
            h(
              'span',
              null,
              '可以先去「素材 · 缺失」里重链；仍然导出会以 MEDIA_MISSING 失败——不会悄悄产出一部缺画面的片子。',
            ),
            h(
              'button',
              { type: 'button', className: 'btn tiny', 'data-testid': 'export-missing-open-relink', onClick: props.onOpenRelink },
              '去重链',
            ),
          )
        : null,

      h(
        'div',
        { className: 'modal-row' },
        h('span', { className: 'modal-label' }, '范围'),
        h(
          'div',
          { className: 'segmented', 'data-testid': 'export-range' },
          h(
            'button',
            {
              type: 'button',
              className: `btn${props.form.range === 'all' ? ' on' : ''}`,
              'data-testid': 'export-range-all',
              'data-on': String(props.form.range === 'all'),
              onClick: () => props.onChange({ range: 'all' }),
            },
            `全片（${num(props.duration)}s）`,
          ),
          h(
            'button',
            {
              type: 'button',
              className: `btn${props.form.range === 'inout' ? ' on' : ''}`,
              'data-testid': 'export-range-inout',
              'data-on': String(props.form.range === 'inout'),
              onClick: () => props.onChange({ range: 'inout' }),
            },
            '入出点',
          ),
          h(
            'button',
            {
              type: 'button',
              className: `btn${props.form.range === 'multi' ? ' on' : ''}`,
              'data-testid': 'export-range-multi',
              'data-on': String(props.form.range === 'multi'),
              onClick: () => props.onChange({ range: 'multi' }),
            },
            '多段',
          ),
          props.form.range === 'inout'
            ? h(
                'span',
                { className: 'modal-inline' },
                h('input', {
                  className: 'input',
                  type: 'text',
                  'data-testid': 'export-in',
                  placeholder: '0 或 00:00.000',
                  value: props.form.start,
                  onChange: (event: { target: { value: string } }) => props.onChange({ start: event.target.value }),
                }),
                h('span', null, '→'),
                h('input', {
                  className: 'input',
                  type: 'text',
                  'data-testid': 'export-out',
                  placeholder: '12.5 或 00:12.500',
                  value: props.form.end,
                  onChange: (event: { target: { value: string } }) => props.onChange({ end: event.target.value }),
                }),
              )
            : null,
        ),
      ),

      // 多段区间（M39）：一行一段，顺序就是拼接顺序（不合并、不重排）
      props.form.range === 'multi'
        ? h(
            'div',
            { className: 'modal-row' },
            h('span', { className: 'modal-label' }, '分段'),
            h(
              'div',
              { className: 'export-ranges', 'data-testid': 'export-ranges', 'data-rows': String(rangeRows.length) },
              rangeRows.map((row, index) =>
                h(
                  'div',
                  {
                    className: 'export-range-row',
                    key: `range-${index}`,
                    'data-row': String(index + 1),
                    'data-testid': `export-range-row-${index}`,
                  },
                  h('span', { className: 'export-range-index' }, `${index + 1}`),
                  h('input', {
                    className: 'input',
                    type: 'text',
                    'data-testid': `export-range-start-${index}`,
                    placeholder: '0 或 00:00.000',
                    value: row.start,
                    onChange: (event: { target: { value: string } }) =>
                      props.onRangeChange(index, { start: event.target.value }),
                  }),
                  h('span', { className: 'export-range-arrow' }, '→'),
                  h('input', {
                    className: 'input',
                    type: 'text',
                    'data-testid': `export-range-end-${index}`,
                    placeholder: '2 或 00:02.000',
                    value: row.end,
                    onChange: (event: { target: { value: string } }) =>
                      props.onRangeChange(index, { end: event.target.value }),
                  }),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'btn tiny',
                      'data-testid': `export-range-up-${index}`,
                      title: '上移（顺序即拼接顺序）',
                      disabled: index === 0,
                      onClick: () => props.onRangeMove(index, -1),
                    },
                    '↑',
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'btn tiny',
                      'data-testid': `export-range-down-${index}`,
                      title: '下移（顺序即拼接顺序）',
                      disabled: index === rangeRows.length - 1,
                      onClick: () => props.onRangeMove(index, 1),
                    },
                    '↓',
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'btn tiny',
                      'data-testid': `export-range-del-${index}`,
                      title: '删除这一段',
                      disabled: rangeRows.length <= 1,
                      onClick: () => props.onRangeRemove(index),
                    },
                    '×',
                  ),
                ),
              ),
              h(
                'div',
                { className: 'export-range-foot' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'btn tiny',
                    'data-testid': 'export-range-add',
                    disabled: rangeRows.length >= 100,
                    onClick: props.onRangeAdd,
                  },
                  '+ 添加一段',
                ),
                h(
                  'span',
                  {
                    className: 'modal-hint',
                    'data-testid': 'export-range-estimate',
                    'data-segments': String(multiPreview.ok ? multiPreview.segments : rangeRows.length),
                    'data-seconds': String(multiPreview.ok ? multiPreview.seconds : ''),
                    'data-frames': String(multiPreview.ok ? multiPreview.frames : ''),
                  },
                  multiPreview.ok
                    ? `共 ${multiPreview.segments} 段 · 总时长 ${num(multiPreview.seconds)}s · 预计 ${multiPreview.frames} 帧（30fps 估算，实际以作业为准）`
                    : multiPreview.message,
                ),
              ),
            ),
          )
        : null,

      h(
        'div',
        { className: 'modal-row' },
        h('span', { className: 'modal-label' }, '质量'),
        h(
          'div',
          { className: 'segmented', 'data-testid': 'export-quality' },
          h(
            'button',
            {
              type: 'button',
              className: `btn${props.form.quality === 'draft' ? ' on' : ''}`,
              'data-testid': 'export-quality-draft',
              'data-on': String(props.form.quality === 'draft'),
              onClick: () => props.onChange({ quality: 'draft' }),
            },
            '草稿（兼容）',
          ),
          h(
            'button',
            {
              type: 'button',
              className: `btn${props.form.quality === 'standard' ? ' on' : ''}`,
              'data-testid': 'export-quality-standard',
              'data-on': String(props.form.quality === 'standard'),
              onClick: () => props.onChange({ quality: 'standard' }),
            },
            '标准',
          ),
          h(
            'button',
            {
              type: 'button',
              className: `btn${props.form.quality === 'high' ? ' on' : ''}`,
              'data-testid': 'export-quality-high',
              'data-on': String(props.form.quality === 'high'),
              onClick: () => props.onChange({ quality: 'high' }),
            },
            '高质量',
          ),
        ),
        h(
          'span',
          { className: 'modal-hint', 'data-testid': 'export-quality-hint' },
          '标准/高 = 4:4:4（画质达标，个别老播放器/手机可能不支持）；草稿 = 4:2:0（到处能播，文字略糊）',
        ),
      ),

      // 编码（M50）：默认 H.264（与以前逐字节相同）；HEVC 体积更小，老设备可能解不动。
      h(
        'div',
        { className: 'modal-row' },
        h('span', { className: 'modal-label' }, '编码'),
        h(
          'div',
          { className: 'segmented', 'data-testid': 'export-codec', 'data-codec': props.form.codec },
          h(
            'button',
            {
              type: 'button',
              className: `btn${props.form.codec === 'h264' ? ' on' : ''}`,
              'data-testid': 'export-codec-h264',
              'data-on': String(props.form.codec === 'h264'),
              onClick: () => props.onChange({ codec: 'h264' }),
            },
            'H.264',
          ),
          h(
            'button',
            {
              type: 'button',
              className: `btn${props.form.codec === 'hevc' ? ' on' : ''}`,
              'data-testid': 'export-codec-hevc',
              'data-on': String(props.form.codec === 'hevc'),
              onClick: () => props.onChange({ codec: 'hevc' }),
            },
            'HEVC（H.265）',
          ),
          h(
            'span',
            { className: 'modal-hint', 'data-testid': 'export-codec-hint' },
            props.form.codec === 'hevc' ? '体积更小；老播放器/部分手机可能解不动' : '默认；兼容性最好',
          ),
        ),
      ),

      // 画幅（M42）：预设只填表单；自定义 WxH 直接写输入框（提交时用 parseSizeArg 解析）。
      h(
        'div',
        { className: 'modal-row' },
        h('span', { className: 'modal-label' }, '画幅'),
        h(
          'div',
          { className: 'segmented', 'data-testid': 'export-size-presets', 'data-preset': activePreset },
          EXPORT_PRESETS.map((preset) =>
            h(
              'button',
              {
                type: 'button',
                key: preset.id,
                className: `btn${activePreset === preset.id ? ' on' : ''}`,
                'data-testid': `export-preset-${preset.id}`,
                'data-on': String(activePreset === preset.id),
                onClick: () => requestPreset(preset),
              },
              preset.label,
            ),
          ),
          h('input', {
            className: 'input',
            type: 'text',
            'data-testid': 'export-size',
            placeholder: '自定义 WxH，如 1080x1350',
            title: '自定义画幅：WxH（也认 1080p / portrait / 4k 这些别名）',
            value: props.form.size,
            onChange: (event: { target: { value: string } }) => props.onChange({ size: event.target.value }),
          }),
          activePreset === 'custom'
            ? h('span', { className: 'chip', 'data-testid': 'export-preset-custom' }, '自定义')
            : null,
        ),
      ),

      // 不静默覆盖（M54 A4）：改过字段再切预设，先问一句。取消 = 表单一个字节都不动。
      pendingPreset !== null
        ? h(
            'div',
            {
              className: 'export-warning',
              'data-testid': 'export-preset-confirm',
              'data-changed': String(pendingPreset.changed),
              'data-preset': pendingPreset.preset.id,
            },
            h('strong', null, `切到「${pendingPreset.preset.label}」会覆盖你改过的 ${pendingPreset.changed} 项`),
            h('span', null, '画幅 / 适配 / 帧率 / 编码 / 画质 里被预设改掉的那几项'),
            h(
              'div',
              { className: 'export-chip-groups' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'btn tiny',
                  'data-testid': 'export-preset-confirm-cancel',
                  onClick: () => setPendingPreset(null),
                },
                '取消',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'btn tiny on',
                  'data-testid': 'export-preset-confirm-apply',
                  onClick: () => applyPreset(pendingPreset.preset),
                },
                '覆盖',
              ),
            ),
          )
        : null,

      // 交付体积（M54-A3）：模型与常数在 `studio/shared/delivery-bytes.mjs`，面板只画数。
      h(
        'div',
        { className: 'modal-row' },
        h('span', { className: 'modal-label' }, '预计体积'),
        h(
          'div',
          { className: 'export-chip-groups' },
          h('span', { className: 'modal-hint', 'data-testid': 'export-size-estimate' }, formatDeliveryEstimate(deliveryEstimate)),
          h('span', { className: 'modal-hint' }, '按画幅/画质/编码与实际帧数估算，成品误差一般在 15% 内'),
        ),
      ),

      // 适配 + 帧率（M42）：两者都进请求体（fit 只在给了 size 时发）。
      // 两个 .segmented 必须包在**一个**格子里：`.modal-row` 是 68px + 1fr 的两列网格，
      // 直接把第三个子元素丢进去会落到下一行第一列（68px 宽），按钮会竖着堆成一列。
      h(
        'div',
        { className: 'modal-row' },
        h('span', { className: 'modal-label' }, '适配 / 帧率'),
        h(
          'div',
          { className: 'export-chip-groups' },
          h(
            'div',
            { className: 'segmented', 'data-testid': 'export-fit', 'data-fit': props.form.fit },
            h(
              'button',
              {
                type: 'button',
                className: `btn${props.form.fit === 'letterbox' ? ' on' : ''}`,
                'data-testid': 'export-fit-letterbox',
                'data-on': String(props.form.fit === 'letterbox'),
                onClick: () => props.onChange({ fit: 'letterbox' }),
              },
              'letterbox（不裁）',
            ),
            h(
              'button',
              {
                type: 'button',
                className: `btn${props.form.fit === 'cover' ? ' on' : ''}`,
                'data-testid': 'export-fit-cover',
                'data-on': String(props.form.fit === 'cover'),
                onClick: () => props.onChange({ fit: 'cover' }),
              },
              'cover（裁边）',
            ),
          ),
          h(
            'div',
            { className: 'segmented', 'data-testid': 'export-fps', 'data-fps': String(props.form.fps) },
            EXPORT_FPS_CHOICES.map((fps) =>
              h(
                'button',
                {
                  type: 'button',
                  key: fps,
                  className: `btn${props.form.fps === fps ? ' on' : ''}`,
                  'data-testid': `export-fps-${fps}`,
                  'data-on': String(props.form.fps === fps),
                  onClick: () => props.onChange({ fps }),
                },
                `${fps}`,
              ),
            ),
          ),
        ),
      ),

      h(
        'div',
        { className: 'modal-row' },
        h('span', { className: 'modal-label' }, '输出目录'),
        h('input', {
          className: 'input wide',
          type: 'text',
          placeholder: '留空 = 工程内 exports/',
          'data-testid': 'export-outdir',
          value: props.form.outDir,
          onChange: (event: { target: { value: string } }) => props.onChange({ outDir: event.target.value }),
        }),
      ),

      // 烧字幕（M41）：开关是请求字段 subtitleBurn；字幕源是第一个视频片段的伴生文件。
      // 没有伴生字幕时**禁用**（不是点了再 400）：提示写清找的是什么。
      h(
        'div',
        { className: 'modal-row' },
        h('span', { className: 'modal-label' }, '字幕'),
        h(
          'div',
          {
            className: 'segmented',
            'data-testid': 'export-burn',
            'data-on': String(burnOn),
            'data-available': String(burnAvailable),
          },
          h(
            'button',
            {
              type: 'button',
              className: `btn${burnOn ? ' on' : ''}`,
              'data-testid': 'export-burn-toggle',
              disabled: !burnAvailable,
              title: burnAvailable ? '烧字幕：同一批帧再编一条带字幕的 -subbed.mp4' : '这个工程没有伴生字幕',
              onClick: () => props.onChange({ subtitleBurn: !burnOn }),
            },
            '烧进画面',
          ),
        ),
        h(
          'span',
          { className: 'modal-hint', 'data-testid': 'export-burn-hint' },
          !burnAvailable
            ? '这个工程没有伴生字幕（找不到 .vtt/.srt），不能烧字幕'
            : burnOn
              ? `字幕：${subtitleInfo?.file ?? ''} · ${String(subtitleInfo?.cues ?? 0)} 条 · 样式来自工程设置（.film/subtitle-style.json）`
              : `有字幕：${subtitleInfo?.file ?? ''}（${String(subtitleInfo?.cues ?? 0)} 条）· 打开后出 -master / -subbed / .vtt 三个文件`,
        ),
      ),

      // —— 焦点作业的进度（M17 的判据原样保留：export-progress / export-progress-text）——
      h(
        'div',
        { className: 'modal-row' },
        h('span', { className: 'modal-label' }, '进度'),
        h(
          'div',
          { className: 'progress-wrap' },
          h(
            'div',
            { className: 'progress', 'data-testid': 'export-progress', 'data-percent': String(percent), 'data-stage': focus?.stage ?? '' },
            h('div', { className: 'progress-fill', style: { width: `${Math.max(0, Math.min(100, percent))}%` } }),
          ),
          h(
            'span',
            { className: 'progress-text', 'data-testid': 'export-progress-text' },
            focus === null
              ? '未开始'
              : `${STAGE_LABEL[focus.stage] ?? focus.stage} · ${percent}%${
                  // 烧录阶段单独报「烧录字幕 x/y 帧」（第二次编码自己的计数）。
                  focus.stage === 'burn' && Number.isFinite(burnFrame) && Number.isFinite(burnTotal) && burnTotal > 0
                    ? ` · 烧录字幕 ${burnFrame}/${burnTotal} 帧`
                    : // 帧数只在真有帧进度时显示：ffmpeg 那条路没有帧回调，写 0/240 会像卡住了。
                      focus.frames > 0 && focus.framesTotal > 0
                      ? ` · 已渲染 ${focus.frames}/${focus.framesTotal} 帧`
                      : ''
                }`,
          ),
        ),
      ),

      focus !== null && focus.state === 'done' && focus.output !== null
        ? h(
            'div',
            { className: 'modal-result ok', 'data-testid': 'export-result' },
            h('strong', null, '导出完成'),
            h('code', { 'data-testid': 'export-result-path' }, focus.output.path),
            h('span', { 'data-testid': 'export-result-size' }, `${formatBytes(focus.output.bytes)} · ${num(Number(focus.output.durationSec ?? 0))}s`),
            // 烧字幕（M41）：三个文件都要能看到、能定位（master 已在上面一行，这里列全）。
            (focus.artifacts?.length ?? 0) > 1
              ? h(
                  'div',
                  { className: 'export-artifacts', 'data-testid': 'export-artifacts', 'data-count': String(focus.artifacts?.length ?? 0) },
                  (focus.artifacts ?? []).map((artifact) =>
                    h(
                      'div',
                      { className: 'export-artifact', key: artifact.kind, 'data-kind': artifact.kind, 'data-path': artifact.path },
                      h('span', { className: 'chip' }, ARTIFACT_LABEL[artifact.kind] ?? artifact.kind),
                      h('code', { 'data-testid': `export-artifact-${artifact.kind}` }, artifact.path.split('/').pop() ?? artifact.path),
                      h('span', { className: 'modal-hint' }, formatBytes(artifact.bytes)),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'btn tiny',
                          'data-testid': `export-artifact-reveal-${artifact.kind}`,
                          onClick: () => props.onReveal(artifact.path),
                        },
                        canReveal ? '显示' : '复制路径',
                      ),
                    ),
                  ),
                )
              : null,
            h(
              'div',
              { className: 'modal-inline' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'btn tiny',
                  'data-testid': 'export-reveal',
                  'data-mode': canReveal ? 'reveal' : 'copy',
                  onClick: () => props.onReveal(focus.output?.path ?? ''),
                },
                canReveal ? '在文件夹中显示' : '复制路径（浏览器）',
              ),
            ),
          )
        : null,

      focus !== null && focus.state === 'failed' && focus.error !== null
        ? h(
            'div',
            { className: 'modal-result bad', 'data-testid': 'export-error', 'data-code': focus.error.code },
            h('strong', { 'data-testid': 'export-error-code' }, focus.error.code),
            h('span', { 'data-testid': 'export-error-message' }, ERROR_HUMAN[focus.error.code] ?? focus.error.message),
            h('details', { className: 'export-detail' }, h('summary', null, '可复制的详情'), h('code', { 'data-testid': 'export-error-detail' }, focus.error.message)),
            h(
              'div',
              { className: 'modal-inline' },
              h(
                'button',
                { type: 'button', className: 'btn tiny', 'data-testid': 'export-copy-detail', onClick: () => props.onCopyDetail(focus) },
                '复制详情',
              ),
              failedWithMissing
                ? h(
                    'button',
                    { type: 'button', className: 'btn tiny primary', 'data-testid': 'export-goto-relink', onClick: props.onOpenRelink },
                    '去「素材 · 缺失」重链',
                  )
                : null,
            ),
          )
        : null,

      focus !== null && focus.state === 'cancelled'
        ? h('div', { className: 'modal-result warn', 'data-testid': 'export-cancelled' }, '已取消（没有留下成品）')
        : null,

      // —— 队列（M29）：串行；每行都能单独取消 ——
      h(
        'div',
        {
          className: 'export-queue',
          'data-testid': 'export-queue',
          'data-count': String(visibleQueue.length),
          'data-total': String(queue.length),
        },
        h(
          'div',
          { className: 'export-section-head' },
          h('strong', null, '队列'),
          h('span', { className: 'modal-hint' }, `串行执行：一个跑完才开下一个${queue.length > visibleQueue.length ? ` · 共 ${String(queue.length)} 个，这里显示在跑/在等 + 最近 4 个` : ''}`),
        ),
        visibleQueue.length === 0
          ? h('div', { className: 'empty' }, '队列是空的')
          : visibleQueue.map((item) =>
              h(
                'div',
                {
                  key: item.id,
                  className: `export-row state-${item.state}`,
                  'data-testid': 'export-queue-row',
                  'data-job-id': item.id,
                  'data-state': item.state,
                  'data-position': String(item.position ?? 0),
                  'data-export-clip-id': item.clipId ?? undefined,
                },
                h('span', { className: `chip state-${item.state}` }, STATE_LABEL[item.state] ?? item.state),
                h(
                  'span',
                  { className: 'export-row-stage' },
                  item.clipId ? `动效 ${item.clipId} · ` : '',
                  item.state === 'queued'
                    ? `排队第 ${String(item.position ?? 0)} 位`
                    : `${STAGE_LABEL[item.stage] ?? item.stage} · ${Math.round(item.percent * 1000) / 10}%`,
                ),
                h(
                  'span',
                  { className: 'export-row-meta' },
                  item.framesTotal > 0 ? `${item.frames}/${item.framesTotal} 帧` : '—',
                  item.error?.code ? ` · ${item.error.code}` : '',
                ),
                h('span', { className: 'export-row-time' }, clockOf(item.queuedAt ?? item.startedAt ?? '')),
                item.state === 'queued' || item.state === 'running'
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'btn tiny',
                        'data-testid': 'export-row-cancel',
                        'data-job-id': item.id,
                        onClick: () => props.onCancel(item.id),
                      },
                      item.state === 'queued' ? '取消排队' : '取消',
                    )
                  : item.state === 'done' && item.output !== null
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'btn tiny',
                          'data-testid': 'export-row-reveal',
                          'data-job-id': item.id,
                          onClick: () => props.onReveal(item.output?.path ?? ''),
                        },
                        canReveal ? '显示' : '复制路径',
                      )
                    : h('span', { className: 'export-row-time' }, '—'),
              ),
            ),
      ),

      // —— 历史（M29）：localStorage，刷新还在 ——
      h(
        'div',
        { className: 'export-history', 'data-testid': 'export-history', 'data-count': String(history.length) },
        h(
          'div',
          { className: 'export-section-head' },
          h('strong', null, '历史'),
          h('span', { className: 'modal-hint' }, '只存在这台机器的浏览器里（不写工程目录）'),
          history.length === 0
            ? null
            : h('button', { type: 'button', className: 'btn tiny', 'data-testid': 'export-history-clear', onClick: props.onClearHistory }, '清空'),
        ),
        history.length === 0
          ? h('div', { className: 'empty' }, '还没有导出记录')
          : history.slice(0, 20).map((item) =>
              h(
                'div',
                {
                  key: item.id,
                  className: `export-row state-${item.state}`,
                  'data-testid': 'export-history-row',
                  'data-job-id': item.id,
                  'data-state': item.state,
                  'data-path': item.path ?? '',
                  'data-size': item.size,
                },
                h('span', { className: `chip state-${item.state}` }, STATE_LABEL[item.state] ?? item.state),
                h('span', { className: 'export-row-stage' }, `${clockOf(item.finishedAt || item.startedAt)} · ${item.quality}${item.range === 'all' ? '' : ` · ${item.range}s`}`),
                h(
                  'span',
                  { className: 'export-row-meta' },
                  `${item.size === '' ? '' : `${item.size} · `}${item.framesTotal > 0 ? `${item.framesTotal} 帧` : '—'} · ${durationText(item.elapsedMs)}${
                    item.bytes === null ? '' : ` · ${formatBytes(item.bytes)}`
                  }${item.errorCode === null ? '' : ` · ${item.errorCode}`}`,
                ),
                item.path === null
                  ? h('span', { className: 'export-row-time' }, '无产物')
                  : h(
                      'button',
                      {
                        type: 'button',
                        className: 'btn tiny',
                        'data-testid': 'export-history-reveal',
                        'data-job-id': item.id,
                        title: item.path,
                        onClick: () => props.onReveal(item.path ?? ''),
                      },
                      canReveal ? '定位' : '复制路径',
                    ),
              ),
            ),
      ),

      h(
        'footer',
        { className: 'modal-foot' },
        h(
          'button',
          {
            type: 'button',
            className: 'btn primary',
            'data-testid': 'export-start',
            disabled: props.busy || props.duration <= 0,
            onClick: props.onStart,
          },
          queued.length > 0 || running !== null ? '加入队列' : '开始导出',
        ),
        h('span', { className: 'modal-hint' }, '产物写工程内 exports/；文件名带时间戳；中间文件不进 exports/。'),
      ),
    ),
  );
}
/* ── 素材重链（M26）────────────────────────────────────────────── */

export interface RelinkNote {
  ok: boolean;
  text: string;
  /** 服务端报码逐条（RELINK_DURATION_SHORT 会带建议区间）。 */
  codes: Array<{ clip: string; code: string; message: string; suggest?: { trim: [number, number]; availableSec: number } }>;
}

export interface RelinkPanelProps {
  items: MediaStatusItem[];
  /** clipId → 输入框里的路径。 */
  paths: Record<string, string>;
  busy: boolean;
  note: RelinkNote | null;
  batch: {
    dir: string;
    matched: Array<{ clip: string; oldSrc: string; newSrc: string; name: string }>;
    skipped: Array<{ clip: string; oldSrc: string; reason: string; name?: string }>;
    summary: { relink: number; skip: number };
  } | null;
  /** 有没有系统文件对话框（Electron）。浏览器里退化为手输路径。 */
  canPick: boolean;
  onPath: (clip: string, value: string) => void;
  onPickFile: (clip: string) => void;
  onApply: (clip: string) => void;
  onDir: (dir: string) => void;
  onPickDir: () => void;
  onScan: () => void;
  onApplyBatch: () => void;
  onClose: () => void;
}

const SKIP_REASON: Record<string, string> = {
  NOT_MISSING: '文件还在，不用重链',
  NO_SAME_NAME: '目录里没有同名文件',
  OUTSIDE_PROJECT: '目录在工程外',
};

export function RelinkPanel(props: RelinkPanelProps): ReactNode {
  const missing = props.items;
  return h(
    'div',
    { className: 'modal-backdrop', 'data-testid': 'relink-backdrop' },
    h(
      'section',
      { className: 'modal relink-panel', 'data-testid': 'relink-panel', 'data-missing-count': String(missing.length) },
      h(
        'header',
        { className: 'modal-head' },
        h('strong', null, '素材重链'),
        h('button', { type: 'button', className: 'btn', 'data-testid': 'relink-close', onClick: props.onClose }, '×'),
      ),
      h(
        'p',
        { className: 'relink-hint' },
        '重链只换文件名，片段的 #t=in,out 与 at 一个字节都不动；类型/时长不匹配会报码，不硬塞。',
      ),
      h(
        'div',
        { className: 'relink-list', 'data-testid': 'relink-list' },
        missing.length === 0
          ? h('div', { className: 'empty' }, '没有缺失素材')
          : missing.map((item) =>
              h(
                'div',
                {
                  key: item.src,
                  className: 'relink-row',
                  'data-relink-src': item.src,
                  'data-relink-status': item.status,
                },
                h('span', { className: 'relink-name' }, item.src),
                h('span', { className: 'relink-clips' }, item.clips.join(', ')),
                item.status === 'unreadable' ? h('span', { className: 'chip danger' }, '读不出') : null,
                h('input', {
                  className: 'input relink-input',
                  type: 'text',
                  placeholder: '新文件（绝对路径或工程内相对路径）',
                  'data-testid': 'relink-path',
                  value: props.paths[item.clips[0] ?? ''] ?? '',
                  onChange: (event: { target: { value: string } }) => {
                    for (const clip of item.clips) props.onPath(clip, event.target.value);
                  },
                }),
                props.canPick
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'btn tiny',
                        'data-testid': 'relink-pick',
                        disabled: props.busy,
                        onClick: () => props.onPickFile(item.clips[0] ?? ''),
                      },
                      '选择…',
                    )
                  : null,
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'btn tiny primary',
                    'data-testid': 'relink-apply',
                    disabled: props.busy,
                    onClick: () => props.onApply(item.clips[0] ?? ''),
                  },
                  '重链',
                ),
              ),
            ),
      ),
      h(
        'div',
        { className: 'relink-batch' },
        h('strong', null, '批量重链（按文件名匹配）'),
        h(
          'div',
          { className: 'modal-row' },
          h('input', {
            className: 'input',
            type: 'text',
            placeholder: '素材目录（绝对路径）',
            'data-testid': 'relink-dir',
            value: props.batch?.dir ?? '',
            onChange: (event: { target: { value: string } }) => props.onDir(event.target.value),
          }),
          props.canPick
            ? h('button', { type: 'button', className: 'btn tiny', 'data-testid': 'relink-pick-dir', disabled: props.busy, onClick: props.onPickDir }, '选择目录…')
            : null,
          h('button', { type: 'button', className: 'btn tiny', 'data-testid': 'relink-scan', disabled: props.busy, onClick: props.onScan }, '扫描'),
        ),
        props.batch === null
          ? null
          : h(
              'div',
              { className: 'relink-batch-result', 'data-testid': 'relink-batch-summary' },
              h('span', null, `将重链 ${props.batch.summary.relink} 个 / 跳过 ${props.batch.summary.skip} 个`),
              props.batch.matched.length > 0
                ? h(
                    'ul',
                    { className: 'relink-batch-list' },
                    props.batch.matched.map((item) => h('li', { key: item.clip }, `${item.clip} ← ${item.name}`)),
                  )
                : null,
              props.batch.skipped.length > 0
                ? h(
                    'ul',
                    { className: 'relink-batch-list skipped' },
                    props.batch.skipped.map((item) => h('li', { key: `${item.clip}-${item.reason}` }, `${item.clip} 跳过：${SKIP_REASON[item.reason] ?? item.reason}`)),
                  )
                : null,
              h(
                'button',
                {
                  type: 'button',
                  className: 'btn primary',
                  'data-testid': 'relink-batch-apply',
                  disabled: props.busy || props.batch.matched.length === 0,
                  onClick: props.onApplyBatch,
                },
                `确认重链 ${props.batch.summary.relink} 个`,
              ),
            ),
      ),
      props.note === null
        ? null
        : h(
            'div',
            {
              className: `relink-note${props.note.ok ? ' ok' : ' error'}`,
              'data-testid': props.note.ok ? 'relink-ok' : 'relink-error',
            },
            h('strong', null, props.note.text),
            props.note.codes.length === 0
              ? null
              : h(
                  'ul',
                  null,
                  props.note.codes.map((item) =>
                    h(
                      'li',
                      { key: `${item.clip}-${item.code}`, 'data-code': item.code },
                      `${item.clip}: ${item.code} · ${item.message}`,
                      item.suggest === undefined
                        ? ''
                        : `（建议区间 ${num(item.suggest.trim[0], 2)}–${num(item.suggest.trim[1], 2)}s，可用 ${num(item.suggest.availableSec, 2)}s）`,
                    ),
                  ),
                ),
          ),
    ),
  );
}

/* ── 模板管理（M30）──────────────────────────────────────────────
 * 面板（副线1）负责「选模板 + 调参数 + 应用」，这里负责「存 / 升 / 退 / 归档」。
 * 两部分共用同一个库文件，动作完都刷新面板（panel.refresh()）。
 */

export interface MotionManageProps {
  /** 含已归档的全量（服务端 `all`）。 */
  entries: MotionManageEntry[];
  showArchived: boolean;
  /** 另存为的模板名（只允许字母数字下划线连字符）。 */
  name: string;
  busy: boolean;
  note: { ok: boolean; code?: string; text: string } | null;
  /** 当前片段挂的模板（回填命中时用它标「在用」并说明参数来源）。 */
  current: { template: string; values: Record<string, unknown> } | null;
  onName: (value: string) => void;
  onSave: () => void;
  onUpgrade: (id: string) => void;
  onRollback: (id: string) => void;
  onArchive: (id: string) => void;
  onToggleArchived: () => void;
  /** 重新读库（外部改了模板源之后，靠它把状态刷成「源已改」）。 */
  onRefresh: () => void;
}

const MANAGE_STATUS: Record<string, string> = {
  ready: '可用',
  changed: '源已改（可升级）',
  'source-missing': '源缺失',
  'missing-asset': '资产缺失',
  archived: '已归档',
};

export function MotionManage(props: MotionManageProps): ReactNode {
  const rows = props.showArchived ? props.entries : props.entries.filter((entry) => entry.archived !== true);
  return h(
    'div',
    { className: 'motion-manage', 'data-testid': 'motion-manage', 'data-count': String(rows.length) },
    h(
      'div',
      { className: 'motion-manage-head' },
      h('strong', null, '模板管理'),
      h(
        'span',
        { className: 'motion-manage-tools' },
        h(
          'button',
          { type: 'button', className: 'btn tiny', 'data-testid': 'motion-refresh', disabled: props.busy, onClick: props.onRefresh },
          '刷新',
        ),
        h(
          'label',
          { className: 'motion-toggle' },
          h('input', {
            type: 'checkbox',
            'data-testid': 'motion-show-archived',
            checked: props.showArchived,
            onChange: props.onToggleArchived,
          }),
          '显示已归档',
        ),
      ),
    ),
    h(
      'div',
      { className: 'motion-save-row' },
      h('input', {
        className: 'input',
        type: 'text',
        placeholder: '模板名（字母/数字/下划线）',
        'data-testid': 'motion-save-name',
        value: props.name,
        onChange: (event: { target: { value: string } }) => props.onName(event.target.value),
      }),
      h(
        'button',
        {
          type: 'button',
          className: 'btn tiny primary',
          'data-testid': 'motion-save',
          disabled: props.busy || props.name.trim() === '',
          onClick: props.onSave,
        },
        '另存为模板',
      ),
    ),
    props.note === null
      ? null
      : h(
          'div',
          {
            className: `motion-note${props.note.ok ? ' ok' : ' error'}`,
            'data-testid': props.note.ok ? 'motion-manage-ok' : 'motion-manage-error',
            'data-code': props.note.code ?? '',
          },
          props.note.text,
        ),
    rows.length === 0
      ? h('div', { className: 'empty' }, '还没有模板')
      : rows.map((entry) =>
          h(
            'div',
            {
              key: entry.id,
              className: `motion-row${entry.archived ? ' archived' : ''}`,
              'data-testid': 'motion-manage-row',
              'data-entry-id': entry.id,
              'data-version': String(entry.version),
              'data-history-count': String(entry.historyCount),
              'data-archived': entry.archived ? 'true' : 'false',
              'data-status': entry.status,
            },
            h('span', { className: 'motion-row-name' }, entry.name),
            h('span', { className: 'motion-row-id' }, entry.id),
            h(
              'span',
              { className: 'motion-row-version', 'data-testid': 'motion-row-version' },
              `v${String(entry.version)} · ${entry.historyCount} 个旧版本`,
            ),
            h('span', { className: 'motion-row-status' }, MANAGE_STATUS[entry.status] ?? entry.status),
            props.current !== null && props.current.template === entry.id
              ? h('span', { className: 'chip', 'data-testid': 'motion-row-in-use' }, '当前片段在用')
              : null,
            h(
              'span',
              { className: 'motion-row-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'btn tiny',
                  'data-testid': 'motion-upgrade',
                  'data-entry-id': entry.id,
                  disabled: props.busy || entry.archived === true || entry.status !== 'changed',
                  title: '源文件被改过时存成新版本（没有变化会报 NO_CHANGE）',
                  onClick: () => props.onUpgrade(entry.id),
                },
                '升级',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'btn tiny',
                  'data-testid': 'motion-rollback',
                  'data-entry-id': entry.id,
                  disabled: props.busy || entry.archived === true || entry.historyCount === 0,
                  title: '回到上一版（源文件也回退，舞台重画）',
                  onClick: () => props.onRollback(entry.id),
                },
                '回退',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'btn tiny',
                  'data-testid': 'motion-archive',
                  'data-entry-id': entry.id,
                  disabled: props.busy || entry.archived === true,
                  title: '归档（不物理删；被实例引用时会被拒绝）',
                  onClick: () => props.onArchive(entry.id),
                },
                entry.archived ? '已归档' : '归档',
              ),
            ),
          ),
        ),
  );
}
