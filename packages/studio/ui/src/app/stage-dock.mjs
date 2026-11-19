// @ts-nocheck —— DOM 面板：以真实交互（Playwright）验收；类型由 tsc 只看导出签名。
/**
 * 舞台图层 / 元素检查器（S65 + S66）· M66 只读 API 的消费者
 *
 * 两块面板共用一列（右侧「舞台」列）：
 *
 * 1. **图层面板**：`GET /api/layers` 的 `layers[]`，按契约 v1 的 `tag` + 文本摘要 + 缩略占位渲染；
 *    行序 = DOM 层序（API 返回顺序，不再排序）。点行选中、双击定位、空态/错误态/骨架屏齐全。
 * 2. **元素检查器**：`POST /api/elements/inspect` 的 `groups[].fields[]`，按契约分组顺序渲染；
 *    六类字段（文本/几何/排印/外观/裁剪/变换）各有可编辑项；`editable:false` 禁用并给原因 tooltip。
 *
 * ## 写回只走现有 `/ops`
 *
 * - 几何（x/y/w/h/rotation）→ `set` op 的 `field:'box'`（整体替换，写片段自己的 style 声明）；
 * - 文本与其余样式 → `set` op 的 `field:'overrides'`（元素级覆盖，写进片段 overrides 数组）。
 *
 * 两者都是既有协议里的一等公民，不新增接口、不直接写 film.html。
 *
 * ## 一个必须说清的边界（S67 起，v2 页面域）
 *
 * **面板的数据只有一个来源**：图层面板 = `GET /api/layers`（带 page 片段 id 时进页面域），
 * 字段 = `POST /api/elements/inspect`（统一 id `<clipId>::<elementId>`）。
 * 舞台协议（`stage.request`）**只**用于「画布点选 → 拿一个定位串」，不再给列表或字段供数；
 * 早先两套 id 域互不相交（画布只能给出页面内部元素，列表只有 film.html 的行，BLK-R34-1）。
 *
 * 写回仍然只走 `/ops`：页面元素的 overrides 挂在**页面片段**上，`at` 用页面自己的定位串
 * （不是统一 id）；几何 `set:box` 只对片段有意义，所以页面元素的 x/y/w/h 在面板里只读。
 */

import { patchForField } from '../../../../layers/inspector-fields.mjs';
/* R31（E12-P2 / J6）：取帧毫秒与时间线胶片条共用一处口径（`frameMsAt` / `frameMsMidpoint`），
   连末尾 40ms 的容差都一起共用 —— 以前抽屉没有那一道，贴末尾的源会 422。 */
import { frameMsMidpoint } from '../../../../layers/frame-ms.mjs';
import { isColorRejected } from '../../../../layers/subtitle-style.mjs';
/* R34（E12-P5 第 ④ 步）：预设行复用 layers 的六条元表 —— 面板按钮的顺序、名字、说明
   与检查器「字幕样式」那六颗是**同一份**（`SUBTITLE_PRESET_IDS` 决定顺序）。 */
import { getSubtitlePreset, listSubtitlePresets } from '../../../../layers/subtitle-presets.mjs';
/* R24（E12-P5）：字幕面板的解析/时间格式化直接吃 film-core 的纯函数 ——
   与 App、时间线、导出用的是同一份口径（`HH:MM:SS.mmm`），不另写一套。 */
import { formatCueTime, parseSubtitles } from '../../../../film-core/subtitle.mjs';
/* R25（E12-P6）：转场**没有第二种写法** —— 一律走 M25 的那套纯函数（与时间线拖块同源）。 */
import { detectCutPoints, detectTransitions, planTransitionCreate, planTransitionRemove } from '../../../../film-core/transition.mjs';

/** 字段 key → 六类之一（契约 v1 的 groups 只有 4 组，裁剪/变换是字段级的类别）。 */
const CATEGORY_OF = Object.freeze({
  text: '文本',
  x: '几何',
  y: '几何',
  w: '几何',
  h: '几何',
  rotation: '变换',
  clipPath: '裁剪',
  fontSize: '排印',
  fontWeight: '排印',
  lineHeight: '排印',
  letterSpacing: '排印',
  textAlign: '排印',
  color: '外观',
  backgroundColor: '外观',
  opacity: '外观',
  filter: '外观',
  mixBlendMode: '外观',
  borderRadius: '外观',
  boxShadow: '外观',
  backdropFilter: '外观',
  backgroundImage: '外观',
  backgroundSize: '外观',
  backgroundPosition: '外观',
  boxShadowInset: '外观',
  strokeWidth: '外观',
  strokeColor: '外观',
  textShadow: '外观'
});

const GROUP_LABEL = Object.freeze({
  text: '文本',
  geometry: '几何',
  typography: '排印',
  appearance: '外观'
});

/** 几何 x/y/w/h 走 `set:box`；旋转走 overrides 的 `r`；其余样式走 overrides 的 style。 */
const BOX_KEYS = Object.freeze({ x: 'x', y: 'y', w: 'w', h: 'h' });

const ERROR_TEXT = Object.freeze({
  FILM_NOT_FOUND: '工程未打开（FILM_NOT_FOUND）：先打开一个工程再试',
  ELEMENT_NOT_FOUND: '找不到该元素（ELEMENT_NOT_FOUND）：它可能刚被删掉或改名',
  PAGE_UNREACHABLE: '页面不可达（PAGE_UNREACHABLE）：内容 origin 没起来或页面导航失败',
  BAD_REQUEST: '请求参数不对（BAD_REQUEST）',
  ELEMENT_NOT_EDITABLE: '该层只能像素级处理（ELEMENT_NOT_EDITABLE）'
});

const esc = (value) =>
  String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

/** 错误对象 → 人话。 */
function describeError(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const raw = typeof error?.message === 'string' ? error.message : String(error?.message ?? error ?? '');
  const known = ERROR_TEXT[code] ?? '';
  return { code, message: known === '' ? raw : `${known}${raw === '' ? '' : ` · ${raw}`}` };
}

/**
 * E12-P1a（R21）：左栏顶部那条分类栏。
 *
 * **这批只加栏与空壳**：6 个分类的按钮 + 5 个空态面板；`.dock-layers`（图层树）与
 * `.dock-inspector`（元素检查器，27 字段）**一个节点都不搬**，图层仍是默认内容。
 * 下一批（等副线2 的 `rail-guard.mjs` 能一键存 testid 快照）才把图层树换进 `rail-panel[layers]`。
 *
 * 顺序 = 设计顺序（用户拍板）：素材 · 音频 · 文本 · 字幕 · 转场 · 图层。
 * 默认选中「图层」——保持「打开就看到图层」的现有习惯。
 */
const RAIL_TABS = Object.freeze([
  { id: 'assets', label: '素材' },
  { id: 'audio', label: '音频' },
  { id: 'text', label: '文本' },
  { id: 'subtitle', label: '字幕' },
  { id: 'transition', label: '转场' },
  /* R112 / L1（LI-A02）：改回「图层」，并且**成为唯一入口** ——
     U05 当时改叫「结构」是为了避开右栏段1 的同名标题；现在右栏那棵树已经收掉
     （`styles.css` 的 `.inspector [data-inspector-tree]{display:none}`），
     重名问题不存在了，而「图层」才是用户认得的词。
     两侧都叫「图层」会分不清？现在只有这一份，不存在分不清。 */
  { id: 'layers', label: '图层' },
]);

/**
 * R102 / U05：图层的「锁 / 眼」两枚小按钮（悬停才出现）。
 *
 * 为什么是注入一段局部样式：`styles.css` 归 MAIN（本轮所有权冻结），
 * 而这两个动作按钮的显隐/定位必须跟着行结构走。这里只写 `.layer-item` / `.layer-act`
 * 两个**本模块自己的类**，不碰任何共享类（`.layer-row` 只覆盖三条与名称列有关的值）。
 */
const DOCK_CSS_ID = 'u05-layer-tree';
const LAYER_ACT_GLYPHS = Object.freeze({
  eye: '<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M1.4 7c1.6-2.5 3.4-3.7 5.6-3.7S11 4.5 12.6 7c-1.6 2.5-3.4 3.7-5.6 3.7S3 9.5 1.4 7Z"/><circle cx="7" cy="7" r="1.7"/></svg>',
  lock: '<svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="3" y="6.2" width="8" height="5.6" rx="1.2"/><path d="M4.9 6.2V4.6a2.1 2.1 0 0 1 4.2 0v1.6"/></svg>',
});
/**
 * R165 / UI-V3-B（LEFT）：**非默认状态常显**的两个小字形。
 *
 * 眼/锁按钮本身仍是 hover 才出现（原有交互）；但「已隐藏 / 已锁定」是状态，不是操作，
 * 不能只在 hover 时看得见。行里常驻一枚 10px 字形，形状也不同（斜线眼 / 实心锁），
 * 不靠颜色单独区分。`aria-hidden`，语义在 `title` 与 `data-layer-state` 上。
 */
const LAYER_STATE_GLYPHS = Object.freeze({
  hidden: '<svg width="10" height="10" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2 3.4 12 11.6"/><path d="M4.2 5.1C2.9 5.9 1.9 6.9 1.4 7c1.6 2.5 3.4 3.7 5.6 3.7 1 0 1.9-.3 2.7-.8"/><path d="M8.6 8.9c1.1-.8 1.9-1.7 2.4-1.9-1.6-2.5-3.4-3.7-5.6-3.7"/></svg>',
  locked: '<svg width="10" height="10" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="3.2" y="6.2" width="7.6" height="5.4" rx="1.2" fill="currentColor" stroke="none"/><path d="M4.9 6.2V4.6a2.1 2.1 0 0 1 4.2 0v1.6"/></svg>',
});
const DOCK_CSS = `
.layer-item { position: relative; }
/* R165 / LEFT：一行 30px，只有「缩略图 + 名称 + 状态点」。
   共享 .layer-row 是两行网格（缩略图跨两行、下面挂 id），这里覆盖成本行网格；
   只动本模块注入的这一段，styles.css 不动。 */
.layer-item .layer-row {
  width: 100%; min-height: 30px;
  padding: 4px 8px 4px calc(8px + var(--layer-depth, 0) * 8px);
  grid-template-columns: 20px minmax(0, 1fr) auto;
  grid-template-rows: 20px;
  gap: 0 7px;
}
.layer-item:hover .layer-row { background: rgba(255, 255, 255, 0.04); }
.layer-item .layer-row .thumb { grid-row: 1; width: 20px; height: 20px; line-height: 18px; font-size: 9px; }
.layer-item .layer-main { min-width: 0; align-items: center; }
.layer-item .layer-name { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.layer-states { display: flex; align-items: center; gap: 3px; color: var(--text-mute); }
.layer-state { display: inline-grid; place-items: center; width: 12px; height: 12px; }
.layer-state[data-layer-state='locked'] { color: var(--accent); }
.layer-item .layer-text { flex: 1 1 auto; min-width: 0; }
.layer-item .layer-id { display: flex; align-items: center; gap: 4px; min-width: 0; }
.layer-item .layer-scope { flex: 0 0 auto; padding: 0 4px; border: 1px solid var(--line); border-radius: 3px; color: var(--text-mute); font-size: var(--fs-xs); line-height: 13px; }
.layer-acts { position: absolute; top: 3px; right: 6px; display: flex; gap: 2px; opacity: 0; transition: opacity 80ms ease; }
.layer-item:hover .layer-acts, .layer-item:focus-within .layer-acts { opacity: 1; }
.layer-act { display: inline-grid; place-items: center; width: 18px; height: 18px; padding: 0; border: 1px solid transparent; border-radius: 4px; background: var(--panel-2); color: var(--text-dim); cursor: pointer; }
.layer-act:hover { color: var(--text); border-color: var(--line); }
.layer-act[aria-pressed='true'] { color: var(--accent); border-color: var(--line); }
.layer-act[data-unwired='1'] { cursor: default; opacity: 0.55; }
.layer-act:disabled { pointer-events: none; }

/* ── R102 / U2-R2（USER-UI-CORRECTION-20261114-R2）：左栏只导航 ──────────────
   用户补正**作废**了「元素上/片段下各自独立滚动」的旧 A 方案：左栏图层页只放结构树，
   **树下不再叠第二份元素属性**；元素属性只有右栏检查器那一份（页签「元素/片段」）。
   三条全部只动本模块自己的 .dock-* 类（styles.css 归 MAIN，本轮不直改）：
   ① .dock-inspector（左栏的 27 字段元素检查器）整段 display:none——
      节点保留（stage-inspector / inspector-body 等 testid 在全集里，删了就是 missing），
      更新循环照旧跑（getState() 的读数不变），只是不再可见；
   ② 图层面板不再让 38% 给下面的检查器（styles.css R71 的「图层例外」），整栏铺满；
   ③ 树底那条 1px 分界线（原本隔开下面的元素检查器）一并去掉——下面已经没有对象可隔。 */
.dock[data-nav-only='true'] .dock-inspector { display: none; }
.dock[data-nav-only='true'] .rail-panel-layers { flex: 1 1 auto; min-height: 0; }
.dock[data-nav-only='true'] .rail-panel-layers > .dock-layers { border-bottom: 0; }

/* ── R104 / U06（A20）：素材卡的三态与分工 ───────────────────────────────
   四件事，全部只动展示（插入/预览的 handler 原样复用）：
   ① 封面三态：loading（骨架）/ready（真帧）/failed（封面不可用 = 换一句人话，不破图）
      /placeholder（音频/网页/缺失：本来就没有帧，给类型图标——**不是假封面**）；
   ② 缺失/读不了来自 /media-status（data-media-status），缺文件的卡不请求缩略图（不制造 404 破图）；
   ③ 「预览」与「加入时间线」各一颗按钮（.dock-media-acts），不再让整卡点击在两件事之间摇摆；
   ④ 收藏星仍是右上角一格（所有状态卡同位）。
   选择器全部以 .dock 起头、类名全部 dock-media-*（本模块自己的局部样式）。 */
.dock .dock-media-meta { display: flex; align-items: center; gap: 4px; min-width: 0; font-size: 11px; color: var(--text-mute); line-height: 1.3; }.dock .dock-media-kind { flex: 0 0 auto; padding: 0 3px; border: 1px solid var(--line); border-radius: 3px; color: var(--text-dim); line-height: 12px; }
.dock .dock-media-src { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dock .dock-media-acts { display: flex; gap: 4px; }
.dock .dock-media-act { flex: 1 1 0; display: inline-grid; place-items: center; height: 18px; padding: 0; border: 1px solid var(--line); border-radius: 4px; background: var(--panel-2); color: var(--text-dim); cursor: pointer; font-size: 11px; line-height: 1; }
.dock .dock-media-act:hover { color: var(--text); border-color: var(--line-soft); }
.dock .dock-media-act[data-unwired='1'] { cursor: default; opacity: 0.5; }
.dock .dock-media-act:disabled { pointer-events: none; }
.dock .dock-media-thumb { position: relative; display: block; aspect-ratio: 16 / 9; overflow: hidden; border-radius: 6px; background: rgba(255, 255, 255, 0.04); }
.dock .dock-media-thumb .rail-media-img { width: 100%; height: 100%; object-fit: cover; }
.dock .dock-media-ph { position: absolute; inset: 0; display: grid; place-items: center; color: var(--text-mute); font-size: 12px; }
.dock .dock-media-fail { position: absolute; inset: 0; display: none; place-items: center; padding: 0 4px; text-align: center; color: var(--text-mute); font-size: 10px; line-height: 1.25; }
.dock [data-thumb-state='loading'] .rail-media-img { opacity: 0; }
.dock [data-thumb-state='loading'] .dock-media-skel { position: absolute; inset: 0; background: linear-gradient(90deg, rgba(255,255,255,.04), rgba(255,255,255,.09), rgba(255,255,255,.04)); background-size: 200% 100%; animation: dock-media-shimmer 1.1s linear infinite; }
.dock [data-thumb-state='ready'] .dock-media-skel { display: none; }
.dock [data-thumb-state='failed'] .rail-media-img { display: none; }
.dock [data-thumb-state='failed'] .dock-media-fail { display: grid; }
.dock [data-thumb-state='ready'] .dock-media-fail,
.dock [data-thumb-state='placeholder'] .dock-media-fail,
.dock [data-thumb-state='placeholder'] .dock-media-skel { display: none; }
.dock .dock-media-badge { position: absolute; left: 4px; bottom: 4px; padding: 0 4px; border-radius: 3px; background: rgba(0, 0, 0, 0.6); color: #ffb4a2; font-size: 10px; line-height: 14px; }
.dock .rail-media-card[data-media-status='missing'] .dock-media-thumb,
.dock .rail-media-card[data-media-status='unreadable'] .dock-media-thumb { border: 1px dashed var(--line); }
.dock .rail-media-card[data-media-status='missing'] .rail-media-name,
.dock .rail-media-card[data-media-status='unreadable'] .rail-media-name { color: var(--text-mute); }
@keyframes dock-media-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
.dock .dock-media-skeleton { display: flex; flex-direction: column; gap: 8px; padding: 2px 0; }
.dock .dock-media-skeleton span { display: block; height: 44px; border-radius: 5px; background: linear-gradient(90deg, rgba(255,255,255,.04), rgba(255,255,255,.09), rgba(255,255,255,.04)); background-size: 200% 100%; animation: dock-media-shimmer 1.1s linear infinite; }
.dock .dock-media-preview { position: absolute; inset: 0; z-index: 6; display: flex; flex-direction: column; gap: 8px; padding: 10px; background: rgba(10, 12, 13, 0.96); }
/* 预览浮层挂在素材面板里：给面板一个定位上下文（只加 position，不动它的布局）。 */
.dock [data-rail-panel='assets'] { position: relative; }
.dock .dock-media-preview[hidden] { display: none; }
.dock .dock-media-preview img { width: 100%; border-radius: 6px; background: rgba(255,255,255,.04); }
.dock .dock-media-preview .dock-media-preview-head { display: flex; align-items: center; gap: 6px; }
.dock .dock-media-preview .dock-media-preview-head strong { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.dock .dock-media-preview dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 3px 8px; font-size: 11px; color: var(--text-dim); }
.dock .dock-media-preview dt { color: var(--text-mute); }
.dock .dock-media-preview dd { margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

function ensureDockCss() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(DOCK_CSS_ID) !== null) return;
  const node = document.createElement('style');
  node.id = DOCK_CSS_ID;
  node.textContent = DOCK_CSS;
  document.head.appendChild(node);
}

/**
 * 15×15 线框图标（`currentColor`，只有 path/shape，没有 `<text>`）。
 *
 * 为什么要纯 path：R16/E01 与 R19/E08 都踩过 —— `<text>` 会在按钮里留下文字节点，
 * 「文本宽 = 0」这类判据当场失效。这里每个图标都是几何图形，`textContent` 恒为空。
 */
// 图标来自带许可的 Tabler 素材，CSS 统一着色；不再嵌入自绘 path。

/**
 * 6 个 tab 的按钮 HTML（**图标在上、文字在下**，照参照的竖排单元）。
 *
 * R22 曾把文字砍成纯图标：R21 的「图标 + 12px 文字、`flex:0 0 auto`」实测
 * `scrollWidth 378 > clientWidth 208`，一横滚就有三项看不见。那是**取舍**，不是参照的做法 ——
 * 参照每个 tab 都是图标 + 文字两行。R24 改回来，但换一种排法避开横滚：
 *   ① 竖排（`flex-direction: column`），图标 15 + 2 间隙 + 文字 10 = 27 → 栏高 38 装得下；
 *   ② 6 格仍然 `flex:1 1 0` 均分（208/6 ≈ 34.67），两个汉字 × 10px = 20 < 34.67，**不横滚**；
 *   ③ 文字 `line-height:1` + `white-space:nowrap`（不换行、不撑高）。
 * `data-testid` 与 `title` 一个都没改（rail-guard 靠它们做差集）。
 * 图标仍是纯几何图形、**没有 `<text>`**（E01/E08 踩过：`<text>` 会留下文字节点）。
 */
function railTabsHtml() {
  return RAIL_TABS.map(
    (tab) => `<button type="button" class="rail-tab" id="rail-tab-${tab.id}" role="tab" data-testid="rail-tab-${tab.id}" data-rail-tab="${tab.id}" aria-selected="${tab.id === 'layers' ? 'true' : 'false'}" aria-controls="rail-panel-${tab.id}" aria-label="${tab.label}"${tab.id === 'layers' ? '' : ' tabindex="-1"'} title="${tab.label}"><span class="rail-ico editor-icon" aria-hidden="true"></span><span class="rail-tab-text">${tab.label}</span></button>`,
  ).join('');
}

/**
 * E12-P2（R23）：素材网格的类型筛选。
 *
 * 顺序照参照抽屉（`REF-asset-drawer-annotated.png`）的分组：全部 → 视频 → 图片 → 音频 → 网页。
 * `id` 就是 film 文档里 `clip.kind` 的取值（`KIND_OF_TAG`：iframe=page / video / img=still / audio=sound），
 * 所以「筛选」不需要第二套映射表。
 */
const MEDIA_FILTERS = Object.freeze([
  { id: 'all', label: '全部' },
  { id: 'video', label: '视频' },
  { id: 'still', label: '图片' },
  { id: 'sound', label: '音频' },
  { id: 'page', label: '网页' },
]);

/** 没有缩略图的类型：`derived?what=frame` 对音频与页片段都是 415（音频没有画面、页面要无头浏览器）。 */
const NO_FRAME_KINDS = Object.freeze(['sound', 'page']);

/**
 * 挂载两块面板。
 *
 * @param {HTMLElement} host
 * @param {{
 *   creationLibrary?: boolean,
 *   projectId: () => string,
 *   clipId: () => string,
 *   t: () => number,
 *   getSelectedAt: () => string,
 *   resolveAt?: (at: string) => string,
 *   onSelect: (at: string, ownerClipId?: string) => void,
 *   onLocate: (at: string, box: {x: number, y: number, w: number, h: number} | null) => void,
 *   loadLayers: () => Promise<{ok: true, layers: any[], pageErrors: string[]} | {ok: false, code: string, message: string}>,
 *   inspect: (at: string) => Promise<{ok: true, groups: any[]} | {ok: false, code: string, message: string}>,
 *   commitBoxField: (arg: {key: string, value: number, fallback?: any}) => Promise<{ok: boolean, code?: string, message?: string, hash?: string}>,
 *   commitOverrideField: (arg: {at: string, key: string, patch: any, value?: any}) => Promise<{ok: boolean, code?: string, message?: string, hash?: string}>,
 *   getBox: () => Record<string, number> | null,
 *   getOverrides: () => any[],
 *   onNotice?: (text: string) => void,
 *   isHidden?: (at: string) => boolean,
 *   isLocked?: (at: string) => boolean,
 *   onToggleHidden?: (at: string) => void,
 *   onToggleLock?: (at: string) => void,
 *   onInsertAsset?: (item: { name: string, kind: string, path: string }) => void,
 *   bridge?: {
 *     seek?: (seconds: number) => void,
 *     reloadSubtitles?: () => void,
 *     getBurn?: () => boolean,
 *     setBurn?: (value: boolean) => void,
 *     commitOps?: (ops: any[], label: string) => void
 *   }
 * }} deps
 */
export function mountStageDock(host, deps) {
  /* R102 / U05：局部样式（`.layer-item` / `.layer-act` 是本模块自己的类，不碰 styles.css）。 */
  ensureDockCss();
  host.innerHTML = `
    <div class="dock" data-testid="stage-dock" data-rail="layers" data-nav-only="true">
      <!-- E12-P1a：分类栏只加在顶部；下面的 .dock-layers / .dock-inspector 一个节点都没搬。 -->
      <nav class="rail" data-testid="rail" role="tablist" aria-label="左栏分类">${railTabsHtml()}</nav>
      <!-- E12-P1b（R22）：图层树搬进「图层」分类的内容区。
           搬的**只是父容器**：.dock-layers 的 class 与 data-testid="stage-layers" 一个字没改，
           子树（dock-head / dock-body / layer-list / 每一行）连属性都没碰 —— 所以选中态、右键菜单、
           拖拽、滚动位置全部照旧（setRailTab 只切 hidden，不重建节点）。
           新父容器是个正常的 [data-rail-panel="layers"]，与另外五个空壳面板同一套显隐路径。
           注意：本模板是模板字符串，注释里**不许出现反引号**（R21 踩过，构建不报错、运行时炸）。 -->
      <section class="rail-panel rail-panel-layers" data-rail-panel="layers" id="rail-panel-layers" data-testid="rail-panel-layers" role="tabpanel" aria-labelledby="rail-tab-layers">
      <section class="dock-layers" data-testid="stage-layers">
        <header class="dock-head">
          <!-- R112 / L1：左栏是**唯一的**图层树（片段 → 页面 → 元素）。
               右栏那棵树已收掉（styles.css 一行），标题里不再需要「结构 / 属性」的区分。 -->
          <h2 data-testid="layers-heading">图层</h2>
          <span class="dock-count" data-testid="layers-count">—</span>
          <button type="button" class="btn tiny" data-testid="layers-retry" hidden>重试</button>
        </header>
        <div class="dock-banner" data-testid="layers-page-errors" hidden></div>
        <div class="dock-body" data-testid="layers-body">
          <div class="skeleton" data-testid="layers-skeleton">
            <div class="sk-row"></div><div class="sk-row"></div><div class="sk-row"></div>
            <div class="sk-row"></div><div class="sk-row"></div><div class="sk-row"></div>
          </div>
        </div>
      </section>
      </section>
      <!-- E12-P1a 空壳：每类一种形态（网格 / 网格 / 网格 / 表单 / 网格）。
           都只有「空态文案 + 一个主按钮」，不接数据、不查接口。
           主按钮不装哑巴：点了给一句 notice（说明这批只是空壳），不做假动作。
           注意：这里**不许**出现 技能/模板/配音/音效/音乐/贴纸/滤镜/特效 这些词（K5 反查 innerText）。 -->
      <!-- E12-P2（R23）：「素材」分类的真网格 —— 卡数 = 工程里被引用的 media 数。
           缩略图走 GET /api/projects/:id/derived?what=frame&rel&ms&w=160（R21 服务端已交付），
           ms 取片段源区间中点；音频与页片段该接口 415，所以那两类**不生成 img**，
           用占位块（音频 ♪ / 网页 html），不会出现破图。
           注意：本模板是模板字符串，注释里**不许出现反引号**（R21/R22 都踩过）。 -->
      <section class="rail-panel" data-rail-panel="assets" id="rail-panel-assets" data-testid="rail-panel-assets" role="tabpanel" aria-labelledby="rail-tab-assets" hidden>
        <div class="rail-body rail-body-media">
          <!-- R72：按用户拍板的原型（他自己画的那张）摆：
               分类栏整宽在最顶（.dock > .rail），下面左右两栏 —— 左「导入 / 收藏」，
               右「搜索 + 上传」→「全部」分组标题 → 网格。
               筛选 chips 删掉（原型没有）；工具栏那四个图标（视图/筛选/排序/新建文件夹）
               我们没这些功能，不加。 -->
          <div class="rail-assets-body">
            <div class="rail-media-sublist">
              <button type="button" class="rail-assets-row" data-testid="rail-assets-import" data-rail-delegate="import-media" title="把本地视频/音频/图片复制进 assets/">
                <span class="rail-assets-row-ico" aria-hidden="true">＋</span><span class="rail-assets-row-text">导入</span>
              </button>
              <button type="button" class="rail-assets-row" data-testid="rail-assets-favorite" data-rail-favorite-toggle="1" aria-pressed="false" title="只看收藏过的素材">
                <span class="rail-assets-row-ico" aria-hidden="true">★</span><span class="rail-assets-row-text">收藏</span>
              </button>
            </div>
            <div class="rail-assets-main">
              <div class="rail-media-toolbar">
                <span class="rail-field rail-field-search"><input class="rail-media-search" data-testid="rail-media-search" type="search" autocomplete="off" placeholder="搜索" aria-label="搜索素材文件名" /></span>
                <button type="button" class="rail-media-upload" data-testid="rail-media-import" data-rail-delegate="import-media" title="上传素材（= 导入素材）">上传</button>
              </div>
              <p class="rail-assets-title" data-testid="rail-assets-title">全部</p>
              <!-- R104 / U06（A20）：加载 / 失败 / 空 三态各一个节点，互不冒充。
                   加载是骨架，失败是错误条 + 重试（重试只重拉列表，不改任何 handler）。 -->
              <div class="dock-media-skeleton" data-testid="rail-media-loading" hidden><span></span><span></span><span></span></div>
              <p class="rail-sub-error" data-testid="rail-media-error" hidden></p>
              <button type="button" class="btn tiny" data-testid="rail-media-retry" hidden>重试</button>
              <div class="rail-media-grid" data-testid="rail-media-grid" role="list" aria-label="素材"></div>
              <p class="rail-empty-text" data-testid="rail-media-none" hidden>没有匹配的素材</p>
              <div class="rail-empty" data-testid="rail-empty-assets">
                <p class="rail-empty-text">这个工程还没有素材</p>
                <button type="button" class="btn tiny primary" data-testid="rail-assets-import-empty" data-rail-delegate="import-media">导入</button>
              </div>
              <!-- R104 / U06：预览浮层（纯展示：真封面 + 元信息；不改时间线、不发 /ops）。
                   「加入时间线」是卡片上的另一颗按钮，两者分开。 -->
              <div class="dock-media-preview" data-testid="rail-media-preview-overlay" hidden>
                <div class="dock-media-preview-head">
                  <strong data-testid="rail-media-preview-name"></strong>
                  <button type="button" class="btn tiny" data-testid="rail-media-preview-close">关闭</button>
                </div>
                <img alt="" data-testid="rail-media-preview-img" />
                <p class="rail-empty-text" data-testid="rail-media-preview-noframe" hidden>这一类没有画面帧（音频/网页）：不做假封面</p>
                <dl>
                  <dt>类型</dt><dd data-testid="rail-media-preview-kind"></dd>
                  <dt>时长</dt><dd data-testid="rail-media-preview-dur"></dd>
                  <dt>来源</dt><dd data-testid="rail-media-preview-src"></dd>
                  <dt>状态</dt><dd data-testid="rail-media-preview-status"></dd>
                </dl>
              </div>
            </div>
          </div>
        </div>
      </section>
      <section class="rail-panel" data-rail-panel="audio" id="rail-panel-audio" data-testid="rail-panel-audio" role="tabpanel" aria-labelledby="rail-tab-audio" hidden>
        <div class="rail-body">
          <div class="rail-empty" data-testid="rail-empty-audio">
            <p class="rail-empty-text">这个工程还没有素材</p>
            <button type="button" class="btn tiny primary" data-testid="rail-audio-import" data-rail-action="音频导入还没接数据：这批只做空壳，下一批接现有导入">导入</button>
          </div>
        </div>
      </section>
      <!-- E12-P3（R25 / R38）：「文本」分类 = 二级「我的」+ 文本元素列表。
           列表的数据是**页面片段里带文字的元素**（ GET /api/layers?clip=<pageClip> ），
           因为 film 的片段标签只有 iframe/video/img/audio 四种，没有「文本片段」——
           我们的文本元素一直是「页面里的一段文字 + overrides.text」。
           ① 新建文本：写入面已由 E12-P3 的 B1/B2/B3 验过（insert kind:text + 写回），
              这里只是入口 —— 走 deps.bridge.insertTextClip（App 侧 postOps），
              落点是播放头所在的页面片段；**没有页面片段时保持 disabled**，title 说事实。
              （R38 之前 title 写的「我们没有文本片段的写入面」在 B1/B2/B3 全绿后已不成立。）
           ② 样式四项走右栏检查器，面板里不复制第二套控件。
           注意：本模板是模板字符串，注释里**不许出现反引号**（R21/R22 都踩过）。 -->
      <section class="rail-panel" data-rail-panel="text" id="rail-panel-text" data-testid="rail-panel-text" role="tabpanel" aria-labelledby="rail-tab-text" hidden>
        <div class="rail-body rail-body-text">
          <div class="rail-subnav" role="tablist" aria-label="文本范围">
            <button type="button" class="rail-subnav-item" role="tab" aria-selected="true" data-testid="rail-text-scope-mine">我的</button>
          </div>
          <div class="rail-text-tools">
            <button type="button" class="btn tiny primary dense" data-testid="rail-text-new" disabled title="在播放头处插入一条文本（写入当前页面片段）">新建文本</button>
            <span class="rail-sub-count" data-testid="rail-text-count" data-count="0">0 条</span>
          </div>
          <div class="rail-text-list" data-testid="rail-text-list" role="list" aria-label="文本元素"></div>
          <p class="rail-empty-text" data-testid="rail-empty-text">还没有文本元素：这个工程里没有带文字的页面层</p>
          <p class="rail-sub-error" data-testid="rail-text-error" hidden></p>
        </div>
      </section>
      <section class="rail-panel" data-rail-panel="subtitle" id="rail-panel-subtitle" data-testid="rail-panel-subtitle" role="tabpanel" aria-labelledby="rail-tab-subtitle" hidden>
        <div class="rail-body rail-body-sub">
          <!-- E12-P5（R24）：字幕在参照里是**表单式**：来源两格（导入文件 / 播放头加一条），
               下面是段列表 + 烧录开关，没有二级树。
               「从语音生成」/「智能识别」不做 —— 我们没有转写服务，参照那格也是「连接服务」。
               注意：本模板是模板字符串，注释里**不许出现反引号**（R21/R22 都踩过）。 -->
          <div class="rail-form rail-form-sub" data-testid="rail-subtitle-form" data-mode="file">
            <div class="rail-modes" role="tablist" aria-label="字幕来源">
              <button type="button" class="rail-mode" role="tab" data-testid="rail-subtitle-mode-file" data-rail-mode="file" aria-selected="true">导入字幕文件</button>
              <button type="button" class="rail-mode" role="tab" data-testid="rail-subtitle-mode-playhead" data-rail-mode="playhead" aria-selected="false" tabindex="-1">播放头加一条</button>
            </div>
            <input type="file" accept=".srt,.vtt,text/vtt,application/x-subrip" data-testid="rail-subtitle-file" hidden />
            <div class="rail-form-act">
              <button type="button" class="btn tiny primary dense" data-testid="rail-subtitle-primary" data-rail-subtitle="primary">选择 SRT / VTT 文件</button>
              <button type="button" class="rail-switch" data-testid="rail-subtitle-burn" data-rail-subtitle="burn" role="switch" aria-checked="false" aria-label="烧录字幕" title="烧录字幕：导出时同一批帧再编一条带字幕的 -subbed.mp4"><span class="rail-switch-knob"></span></button>
            </div>
            <div class="rail-sub-meta">
              <span class="rail-sub-count" data-testid="rail-subtitle-count" data-count="0">段 0</span>
              <span class="rail-sub-file" data-testid="rail-subtitle-file-label" title="">无文件</span>
            </div>
            <!-- E12-P5（R34）：样式预设行。六颗按钮的顺序 = SUBTITLE_PRESET_IDS，
                 点击只写 preset 这个 id（派生值由 layers 的 applyStylePreset 在渲染时展开），
                 覆盖层由 App 的 updateStyle 即时重渲染 —— 不刷新页面。
                 注意：本模板是模板字符串，注释里不许出现反引号。 -->
            <div class="rail-presets" data-testid="rail-subtitle-presets" role="group" aria-label="字幕样式预设">${railPresetButtonsHtml('default')}</div>
            <div class="rail-cues" data-testid="rail-subtitle-cues" role="list" aria-label="字幕段"></div>
            <p class="rail-empty-text rail-sub-hint" data-testid="rail-empty-subtitle" data-rail-subtitle-hint>还没有字幕：可以导入 SRT / WebVTT，或在播放头处加一条</p>
            <p class="rail-sub-error" data-testid="rail-subtitle-error" hidden></p>
          </div>
        </div>
      </section>
      <!-- E12-P6（R25）：「转场」分类 = 一张「淡入淡出」卡 + 接缝选择 + 时长 + 加/移除。
           写回**只走 M25 的转场模型**（film-core/transition.mjs）：转场没有独立实体，
           它是「同轨相邻两段的几何重叠 + 上层 fade[0] 包络」。所以这里不自己拼 fade，
           一律 detectCutPoints / detectTransitions / planTransitionCreate|Remove，
           与时间线上拖转场块是同一个真值（不新增第二种写法）。
           注意：本模板是模板字符串，注释里**不许出现反引号**（R21/R22 都踩过）。 -->
      <section class="rail-panel" data-rail-panel="transition" id="rail-panel-transition" data-testid="rail-panel-transition" role="tabpanel" aria-labelledby="rail-tab-transition" hidden>
        <div class="rail-body rail-body-trans">
          <div class="rail-grid rail-grid-one" data-testid="rail-transition-grid">
            <!-- 只有一张卡：film 目前唯一允许的片段自有条目是 fade[in,out]。
                 用 div（不用 button）—— 卡片只是展示，动作在下面两颗按钮上。 -->
            <div class="rail-card rail-trans-card" data-testid="rail-transition-card-fade" data-on="false">
              <span class="rail-card-thumb"></span>
              <span class="rail-card-name">淡入淡出</span>
              <span class="rail-trans-badge" data-testid="rail-transition-count" data-count="0">已启用 0 处</span>
            </div>
          </div>
          <label class="rail-trans-row">
            <span class="rail-trans-label">接缝</span>
            <select class="rail-trans-seam" data-testid="rail-transition-seam" aria-label="接缝"></select>
          </label>
          <label class="rail-trans-row">
            <span class="rail-trans-label">时长</span>
            <span class="rail-field rail-field-dur"><input class="rail-trans-dur" data-testid="rail-transition-dur" type="text" inputmode="decimal" value="0.3" spellcheck="false" aria-label="转场时长（秒）" /></span>
            <span class="rail-trans-unit">s</span>
          </label>
          <div class="rail-form-act">
            <button type="button" class="btn tiny primary dense" data-testid="rail-transition-add" data-rail-trans="add">加淡入淡出</button>
            <button type="button" class="btn tiny dense" data-testid="rail-transition-remove" data-rail-trans="remove">移除</button>
          </div>
          <p class="rail-empty-text" data-testid="rail-empty-transition">这个工程还没有转场</p>
          <p class="rail-sub-error" data-testid="rail-transition-error" hidden></p>
        </div>
      </section>
      <!-- 节点留着（rail-layers-note 在 testid 全集里，删了就是 missing），但这句已经不成立：
           R22 起图层树就在「图层」分类的内容区里。常隐，不占位。 -->
      <p class="rail-note" data-testid="rail-layers-note" hidden>图层内容已在「图层」分类里</p>
      <!-- R102 / U2-R2：这一段（左栏的元素检查器）被用户补正**整段收起**——
           左栏只导航（结构树），元素属性只剩右栏检查器「元素」页签那一份。
           节点与更新循环一个不删（testid 全集 + getState 读数不变），只靠
           .dock[data-nav-only] .dock-inspector 这条 display:none 收起。 -->
      <section class="dock-inspector" data-testid="stage-inspector">
        <header class="dock-head">
          <h2>元素</h2>
          <span class="dock-target mono-dim" data-testid="inspector-target">未选中</span>
        </header>
        <!-- R102 / U05：交叉说明**常隐**（用户 20:12 的病灶：它占纵向空间、且与「左=结构树 / 右=属性」的新分工矛盾）。
             节点留着不删：dual-source-note 在 testid 全集里（同 rail-layers-note 的先例，删了就是 missing）。 -->
        <p class="dual-source-note" data-testid="dual-source-note" data-note-for="dock" hidden
           title="与右侧「元素」检查器是同一份字段，改一处即可">与右侧「元素」检查器是同一份字段，改一处即可</p>
        <div class="dock-banner" data-testid="inspector-page-errors" hidden></div>
        <div class="dock-body" data-testid="inspector-body">
          <p class="dock-empty" data-testid="inspector-empty">在画布或图层里选一个元素</p>
        </div>
      </section>
    </div>
  `;

  const root = host.querySelector('[data-testid="stage-dock"]');
  const railPanels = [...host.querySelectorAll('[data-rail-panel]')];
  const creationHost = document.createElement('div');
  creationHost.className = 'creation-library-host';
  const creationLayerContent = host.querySelector('[data-testid="stage-layers"]');
  if (deps.creationLibrary === true) {
    root.dataset.creationLibrary = 'true';
    root.querySelector('.rail').hidden = true;
    for (const panel of railPanels) panel.hidden = true;
    root.prepend(creationHost);
  }

  const layersBody = host.querySelector('[data-testid="layers-body"]');
  const layersCount = host.querySelector('[data-testid="layers-count"]');
  const retryBtn = host.querySelector('[data-testid="layers-retry"]');
  const layersBanner = host.querySelector('[data-testid="layers-page-errors"]');
  const inspectorBody = host.querySelector('[data-testid="inspector-body"]');
  const inspectorTarget = host.querySelector('[data-testid="inspector-target"]');
  const inspectorBanner = host.querySelector('[data-testid="inspector-page-errors"]');

  /**
   * @type {{ layers: any[], pageErrors: string[], status: 'idle'|'loading'|'ready'|'empty'|'error', error: {code: string, message: string} | null, lastRenderMs: number,
   *   page: { clipId: string, layers: any[], pageErrors: string[], frameStatus: string } | null }}
   * `layers` = film.html 的层（树骨架）；`page` = 页面片段内部元素（挂在片段行下面展开）。
   */
  const layerState = { layers: [], pageErrors: [], status: 'loading', error: null, lastRenderMs: 0, page: null, expandedClip: '' };
  /** @type {{ at: string, element: string, scope: 'clip'|'page', status: 'idle'|'loading'|'ready'|'error'|'empty', groups: any[], error: any, busy: boolean, notice: string }} */
  const inspState = { at: '', element: '', scope: 'clip', status: 'idle', groups: [], error: null, busy: false, notice: '' };
  let destroyed = false;
  let seq = 0;
  /** 单击选中的延迟句柄（双击时取消，见 onDoubleClick）。 */
  let pendingSelect = 0;
  /** 当前分类栏选中项（E12-P1a）。默认「图层」= 现有内容，这一项不动任何节点。 */
  let railTab = 'layers';

  /* ── 分类栏（E12-P1a）─────────────────────────────────────────────── */

  /**
   * 切分类：只改两样东西 —— 按钮的 `aria-selected`/`tabindex` 与六个面板的 `hidden`。
   * **不重建、不搬节点**（图层树与检查器连 `hidden` 之外一个属性都不碰），所以切回「图层」时
   * 图层树还是原来那棵树、滚动位置与选中都不丢。
   *
   * R22 起六个面板**同一套显隐路径**：图层那段的父容器也带 `data-rail-panel="layers"`，
   * 不再需要 `layersSection.hidden` 这条旁路。
   *
   * R22 起也**不再**把选中项滚进可视区 —— 6 个 tab 用 `flex:1` 均分，永远全在栏里。
   *
   * @param {string} id
   */
  function setRailTab(id) {
    if (!RAIL_TABS.some((tab) => tab.id === id)) return;
    railTab = id;
    for (const button of root.querySelectorAll('[data-rail-tab]')) {
      const on = button.getAttribute('data-rail-tab') === id;
      button.setAttribute('aria-selected', on ? 'true' : 'false');
      /* roving tabindex：Tab 只停一个，左右键切换（tablist 的标准键盘行为）。 */
      button.setAttribute('tabindex', on ? '0' : '-1');
    }
    for (const panel of railPanels) panel.hidden = deps.creationLibrary === true || panel.getAttribute('data-rail-panel') !== id;
    root.setAttribute('data-rail', id);
    /* 素材网格：首次进这一栏（或换了工程）才拉一次 film 文档。 */
    if (id === 'assets' && (mediaState.status === 'idle' || mediaState.projectId !== deps.projectId())) {
      void refreshMedia();
    }
    /* 字幕：首次进、或换了工程才拉数据；切回来只把烧录开关的镜像对齐一下
       （导出面板里也能改这个值，别让左栏那份留着旧读数）。 */
    if (id === 'subtitle') {
      if (subState.status === 'idle' || subState.projectId !== deps.projectId()) {
        void refreshSubtitles();
      } else {
        subState.burn = deps.bridge?.getBurn?.() === true;
        renderSubtitles();
      }
    }
    /* 文本 / 转场：同理，首次进或换工程才拉（页面域一跳不便宜，不每次切都打）。 */
    if (id === 'text' && (textState.status === 'idle' || textState.projectId !== deps.projectId())) {
      void refreshText();
    }
    if (id === 'transition' && (transState.status === 'idle' || transState.projectId !== deps.projectId())) {
      void refreshTransitions();
    }
  }

  /* ── 文本面板（E12-P3 / R25）────────────────────────────────────────── */

  /**
   * 「我的」里的文本元素。
   *
   * **数据来源**：`GET /api/layers?project&clip=<pageClip>&t=` —— 页面片段内部的元素域。
   * film 的片段标签只有 iframe/video/img/audio 四种（`KIND_OF_TAG`），没有「文本片段」；
   * 我们的文本一直是「页面里一段文字 + `overrides[].text`」。所以列表按**页面片段**逐个读，
   * 只留 `text` 非空的元素。
   *
   * 顺序 = 图层顺序：文档里轨道/片段的顺序（`doc.tracks[].clips[]`）→ 页面里的 DOM 顺序
   * （`/api/layers` 返回的就是 DOM 层序）。两个页面片段同名元素（`#title`）靠 `clipId` 区分。
   *
   * 页面域读是**瞬态**的（`PAGE_UNREACHABLE`：场景页自己导航会把 evaluate 打断）——
   * 与 App 的 `loadLayers` 一样「读三次再认输」，否则一次抖动就会让列表少一整页。
   *
   * @type {{ status: 'idle'|'loading'|'ready'|'error', projectId: string, rows: any[],
   *   error: string, pages: number, shown: number, selected: string }}
   */
  const textState = { status: 'idle', projectId: '', rows: [], error: '', pages: 0, shown: 0, selected: '' };
  /** 一览里最多读几个页面片段（每个都是无头浏览器一跳；超出的在 UI 里如实说）。 */
  const TEXT_PAGE_CAP = 6;
  /** 行首预览字数（书里 §3 第 2 条：前 12 字）。 */
  const TEXT_PREVIEW = 12;

  /** 一个层上的文字（压掉换行/多余空白；没有就是空串）。 */
  function textOfLayer(layer) {
    return String(layer?.text ?? '').replace(/\s+/g, ' ').trim();
  }

  /** 深度优先收集带文字的元素（顺序 = DOM 层序）。 */
  function collectTextLayers(layers, out) {
    for (const layer of layers ?? []) {
      const text = textOfLayer(layer);
      if (text !== '') out.push({ elementId: String(layer.id ?? ''), text, tag: String(layer.tag ?? '') });
      collectTextLayers(layer.children, out);
    }
  }

  /** 片段在时间线上的占用（与 `film-core/transition.mjs` 的 spanOf 同口径）。 */
  function clipSpan(clip) {
    const start = Number(clip?.at ?? 0) || 0;
    const time = Array.isArray(clip?.time) ? clip.time : null;
    const speed = typeof clip?.speed === 'number' && clip.speed > 0 ? clip.speed : 1;
    const length = time === null ? 0 : Math.max(0, (Number(time[1]) - Number(time[0])) / speed);
    return { start, end: start + length, length };
  }

  /** 起止时间的紧凑写法：`0–4.0s`。 */
  function textRangeLabel(start, end) {
    const fmt = (value) => (Math.abs(value - Math.round(value)) < 1e-6 ? String(Math.round(value)) : value.toFixed(1));
    return `${fmt(start)}–${fmt(end)}s`;
  }

  /** 读一个页面片段的元素域（瞬态错误重试三次，与 App 的 loadLayers 同一条策略）。 */
  async function fetchPageLayers(projectId, clipId, atSeconds) {
    let last = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await fetch(
          `/api/layers?project=${encodeURIComponent(projectId)}&clip=${encodeURIComponent(clipId)}&t=${encodeURIComponent(String(atSeconds))}`,
          { cache: 'no-store' },
        );
        const body = await res.json();
        if (body?.ok !== true && body?.layers === undefined) {
          throw Object.assign(new Error('LAYERS_FAILED'), { code: body?.code ?? 'LAYERS_FAILED', message: body?.message });
        }
        return Array.isArray(body?.layers) ? body.layers : [];
      } catch (error) {
        last = error;
        const code = String(/** @type {any} */ (error)?.code ?? '');
        if ((code !== 'PAGE_UNREACHABLE' && code !== 'DISCOVER_FAILED') || attempt === 2) break;
        await new Promise((done) => globalThis.setTimeout(done, 220));
      }
    }
    throw last ?? new Error('LAYERS_FAILED');
  }

  function renderText() {
    const list = host.querySelector('[data-testid="rail-text-list"]');
    const count = host.querySelector('[data-testid="rail-text-count"]');
    const empty = host.querySelector('[data-testid="rail-empty-text"]');
    const error = host.querySelector('[data-testid="rail-text-error"]');
    const rows = textState.rows;
    if (count !== null) {
      count.textContent = `${String(rows.length)} 条`;
      count.setAttribute('data-count', String(rows.length));
    }
    if (list !== null) {
      list.innerHTML = rows
        .map((row, index) => {
          const preview = row.text.length > TEXT_PREVIEW ? `${row.text.slice(0, TEXT_PREVIEW)}…` : row.text;
          /* R38：`kind:'text'` 片段是**片段级**（inspect 的 at 就是 film.html 定位串），
             页面元素是**统一 id**（`<clipId>::<elementId>`，inspect 按前缀分到页面域）。
             两种行的 `data-unified` 口径不同，别混。 */
          const unified = row.scope === 'text' ? row.elementId : `${row.clipId}::${row.elementId}`;
          return `<button type="button" class="rail-text-row${textState.selected === unified ? ' is-selected' : ''}" role="listitem" data-testid="rail-text-row-${String(index)}" data-unified="${esc(unified)}" data-scope="${esc(row.scope ?? 'page')}" data-clip="${esc(row.clipId)}" data-element="${esc(row.elementId)}" data-start="${String(row.start)}" data-end="${String(row.end)}" data-layer="${esc(row.clipId)}" title="${esc(row.text)} · ${esc(row.clipId)} · ${esc(textRangeLabel(row.start, row.end))}">
        <span class="rail-text-preview">${esc(preview)}</span>
        <span class="rail-text-meta"><span class="rail-text-layer">${esc(row.clipId)}</span><span class="rail-text-range">${esc(textRangeLabel(row.start, row.end))}</span></span>
      </button>`;
        })
        .join('');
      list.hidden = rows.length === 0;
    }
    if (empty !== null) {
      empty.hidden = !(textState.status === 'ready' && rows.length === 0);
      empty.textContent =
        textState.status === 'ready' && textState.pages > 0 && textState.shown < textState.pages
          ? `前 ${String(textState.shown)} 个页面片段里没有文字（这个工程共 ${String(textState.pages)} 个页面片段）`
          : '还没有文本元素：这个工程里没有带文字的页面层';
    }
    if (error !== null) {
      error.hidden = textState.error === '';
      error.textContent = textState.error;
    }
    /* R38（E12-P3）：新建文本的可点性 —— 只有「列表已就绪且工程里有页面片段」才放行。
       没有页面片段时不是缺陷，是真的插不进去（`insert kind:text` 需要一个 src），
       所以保持 disabled 并把原因写在 title 里（不再说「没有写入面」）。 */
    const newBtn = host.querySelector('[data-testid="rail-text-new"]');
    if (newBtn !== null) {
      const usable = textState.status === 'ready' && textState.pages > 0;
      /** @type {HTMLButtonElement} */ (newBtn).disabled = !usable;
      newBtn.setAttribute(
        'title',
        usable ? '在播放头处插入一条文本（写入当前页面片段）' : '当前工程没有页面片段，先插入一页再新建文本',
      );
    }
  }

  /**
   * R38（E12-P3）：在播放头处插一条文本。
   *
   * 写入面是 B3 验过的**最小形状**（`{ op:'insert', clip:{ kind:'text', src } }`，不带 at/time）；
   * `src` 由 App 侧从 doc 里找播放头处的页面片段 —— 面板不重复解析 doc。
   * 成功后重拉列表（新行要出现）、把播放头停在同一处（新条目就在那里）。
   */
  async function insertTextFromPlayhead() {
    const bridge = /** @type {any} */ (deps.bridge);
    if (typeof bridge?.insertTextClip !== 'function') return;
    const at = Math.max(0, Number(deps.t()) || 0);
    const result = await bridge.insertTextClip({ at });
    if (result?.ok === false) {
      deps.onNotice?.(String(result.message ?? '插入文本失败'));
      return;
    }
    await refreshText();
    deps.bridge?.seek?.(at);
    deps.onNotice?.('已插入文本（播放头处）');
  }

  /** 拉一次：文档 → 每个页面片段 → 带文字的元素。 */
  async function refreshText() {
    const projectId = deps.projectId();
    textState.projectId = projectId;
    if (projectId === '') {
      textState.status = 'ready';
      textState.rows = [];
      textState.pages = 0;
      textState.shown = 0;
      textState.error = '';
      renderText();
      return;
    }
    textState.status = 'loading';
    textState.error = '';
    try {
      const docRes = await fetch(`/api/projects/${encodeURIComponent(projectId)}/doc`, { cache: 'no-store' });
      const docBody = await docRes.json();
      if (destroyed) return;
      if (docBody?.ok !== true) throw Object.assign(new Error('DOC_FAILED'), { code: docBody?.code ?? 'DOC_FAILED' });
      const pageClips = [];
      /* R38（E12-P3 新建文本）：`kind:'text'` 的片段（film.html 根层的 <div>）单独收一份 ——
         「新建文本」插的就是它，列表里必须能看见，否则按钮点了没反应。
         注意它和「页面片段里的文字元素」不是一回事：前者是**片段级**、后者是 iframe 里的 DOM 元素。 */
      const textClips = [];
      for (const track of docBody.doc?.tracks ?? []) {
        for (const clip of track?.clips ?? []) {
          const kind = String(clip?.kind ?? '');
          if (kind === 'page') pageClips.push(clip);
          else if (kind === 'text') textClips.push(clip);
        }
      }
      const shown = pageClips.slice(0, TEXT_PAGE_CAP);
      const rows = [];
      const at = Math.max(0, Number(deps.t()) || 0);
      for (const clip of shown) {
        const layers = await fetchPageLayers(projectId, String(clip.id ?? ''), at);
        if (destroyed) return;
        const found = [];
        collectTextLayers(layers, found);
        const span = clipSpan(clip);
        for (const item of found) {
          rows.push({ ...item, scope: 'page', clipId: String(clip.id ?? ''), start: span.start, end: span.end });
        }
      }
      /* text 片段：没有内容的（`text` 是空串）不列 —— 与「带文字的元素」同一口径，行上要有东西可显示。 */
      for (const clip of textClips) {
        const body = String(clip?.text ?? '').replace(/\s+/g, ' ').trim();
        if (body === '') continue;
        const span = clipSpan(clip);
        rows.push({
          elementId: String(clip.id ?? ''),
          text: body,
          tag: 'text',
          scope: 'text',
          clipId: String(clip.id ?? ''),
          start: span.start,
          end: span.end,
        });
      }
      textState.rows = rows;
      textState.pages = pageClips.length;
      textState.shown = shown.length;
      textState.status = 'ready';
    } catch (error) {
      if (destroyed) return;
      textState.status = 'error';
      textState.rows = [];
      textState.error = `读不到文本元素：${describeError(error).message}`;
    }
    renderText();
  }

  /**
   * 点一条文本：选中承载它的页面片段 + 这一层，并让右栏「文字 / 内容」显示这一条。
   *
   * 为什么检查器要用**统一 id**（`<clipId>::<elementId>`）直接读：
   * `loadInspector` 的页面子行是靠 `layerState.page`（当前页面片段）认的，跨页面片段时认不出来，
   * 会退成片段域 → 右栏就没有「内容」那一组。统一 id 自带片段前缀，服务端按前缀解析，
   * 不依赖当前选中是谁（App 的 `inspect` 也是这么分流）。
   */
  function selectTextRow(unified, elementId, clipId, start, scope) {
    textState.selected = unified;
    renderText();
    deps.onSelect?.(elementId, clipId);
    /* E12-P3 B4c（R38）：**行上印了时间就必须跳**。
       与字幕段行（同文件下面 `deps.bridge?.seek` 那几处）同一套 —— 只多一个参数，
       不动选中/检查器那三行的顺序（先选中再 seek，视觉上高亮与播放头同时落）。
       `start` 缺失（老夹具/没有 data-start）时按 0 处理：`Number(null)` 是 0，
       所以调用点用 `?? '0'` 挡住 null。 */
    deps.bridge?.seek?.(Number(start));
    /* R38：`scope='text'` 的行是**片段级**（kind:text），走片段域检查器；
       其余（页面里的文字元素）仍走页面域。 */
    void loadInspector(unified, { scope: scope === 'text' ? 'clip' : 'page', element: elementId });
  }

  /* ── 转场面板（E12-P6 / R25）────────────────────────────────────────── */

  /**
   * 「转场」在这套方言里**没有独立实体**：它是同轨相邻两段的几何重叠 + 上层片段的 fade 包络
   * （见 `film-core/transition.mjs` 的头注释）。所以面板不自己拼 `fade`，一律走那四个纯函数：
   *
   * - `detectCutPoints` → 现在能加转场的硬切点（同轨相邻、首尾相接、没有重叠，且后段有余量）；
   * - `detectTransitions` → 已经启用的转场（有重叠的那些）；
   * - `planTransitionCreate` / `planTransitionRemove` → 一批 `props` Op。
   *
   * 这样与时间线上拖转场块读的是**同一份真值**，不会出现「面板里加了、时间线不认」的第二种写法。
   *
   * @type {{ status: 'idle'|'loading'|'ready'|'error', projectId: string, cuts: any[],
   *   transitions: any[], fps: { num: number, den: number }, pick: string, duration: string,
   *   error: string, code: string, notice: string }}
   */
  const transState = {
    status: 'idle',
    projectId: '',
    cuts: [],
    transitions: [],
    fps: { num: 30, den: 1 },
    pick: '',
    duration: '0.3',
    error: '',
    code: '',
    notice: '',
  };

  /** 面板允许的时长区间（书里 §4 第 2 条：默认 0.3s，范围 0.05–2s）。 */
  const TRANS_MIN = 0.05;
  const TRANS_MAX = 2;

  /** select 里的选项值：`c0..cN` 是硬切点（可加），`t0..tN` 是已启用的转场（可移除）。 */
  function transitionOptions() {
    const out = [];
    transState.cuts.forEach((cut, index) => {
      out.push({ value: `c${String(index)}`, kind: 'cut', cut, label: `${String(cut.from?.id ?? '?')} → ${String(cut.to?.id ?? '?')}${cut.canCreate === true ? '' : '（余量不足）'}` });
    });
    transState.transitions.forEach((transition, index) => {
      out.push({ value: `t${String(index)}`, kind: 'transition', transition, label: `${String(transition.from?.id ?? '?')} → ${String(transition.to?.id ?? '?')} · ${Number(transition.duration ?? 0).toFixed(2)}s` });
    });
    return out;
  }

  function currentTransitionPick() {
    const options = transitionOptions();
    return options.find((item) => item.value === transState.pick) ?? null;
  }

  function renderTransitions() {
    const count = host.querySelector('[data-testid="rail-transition-count"]');
    const card = host.querySelector('[data-testid="rail-transition-card-fade"]');
    const select = host.querySelector('[data-testid="rail-transition-seam"]');
    const addBtn = host.querySelector('[data-testid="rail-transition-add"]');
    const removeBtn = host.querySelector('[data-testid="rail-transition-remove"]');
    const empty = host.querySelector('[data-testid="rail-empty-transition"]');
    const error = host.querySelector('[data-testid="rail-transition-error"]');
    const options = transitionOptions();
    const enabled = transState.transitions.length;
    if (count !== null) {
      count.textContent = `已启用 ${String(enabled)} 处`;
      count.setAttribute('data-count', String(enabled));
    }
    if (card !== null) card.setAttribute('data-on', enabled > 0 ? 'true' : 'false');
    if (select !== null) {
      const keep = transState.pick;
      select.innerHTML = options
        .map((item) => `<option value="${esc(item.value)}"${item.value === keep ? ' selected' : ''}>${esc(item.label)}</option>`)
        .join('');
      const pickedNow = options.find((item) => item.value === (select.value || keep));
      select.setAttribute('title', pickedNow === undefined ? '' : pickedNow.label);
      select.disabled = options.length === 0;
      if (options.length > 0 && !options.some((item) => item.value === keep)) {
        transState.pick = options[0].value;
        select.value = options[0].value;
      }
    }
    const picked = currentTransitionPick();
    if (addBtn !== null) {
      addBtn.disabled = picked === null || picked.kind !== 'cut' || picked.cut?.canCreate !== true;
      addBtn.setAttribute('data-rail-trans', 'add');
    }
    if (removeBtn !== null) {
      removeBtn.disabled = picked === null || picked.kind !== 'transition';
      removeBtn.setAttribute('data-rail-trans', 'remove');
    }
    if (empty !== null) {
      empty.hidden = !(transState.status === 'ready' && options.length === 0);
      empty.textContent = '这个工程还没有转场';
    }
    if (error !== null) {
      error.hidden = transState.error === '';
      error.textContent = transState.error;
      if (transState.code === '') error.removeAttribute('data-code');
      else error.setAttribute('data-code', transState.code);
      error.setAttribute('data-notice', transState.notice);
    }
  }

  /** 拉一次：文档（切点/转场/帧率）+ 素材原生时长（源余量）。 */
  async function refreshTransitions() {
    const projectId = deps.projectId();
    transState.projectId = projectId;
    if (projectId === '') {
      transState.status = 'ready';
      transState.cuts = [];
      transState.transitions = [];
      transState.error = '';
      renderTransitions();
      return;
    }
    transState.status = 'loading';
    try {
      const [docBody, mediaBody] = await Promise.all([
        fetch(`/api/projects/${encodeURIComponent(projectId)}/doc`, { cache: 'no-store' }).then((res) => res.json()),
        fetch(`/api/projects/${encodeURIComponent(projectId)}/media-status`, { cache: 'no-store' }).then((res) => res.json()).catch(() => null),
      ]);
      if (destroyed) return;
      if (docBody?.ok !== true) throw Object.assign(new Error('DOC_FAILED'), { code: docBody?.code ?? 'DOC_FAILED' });
      /** @type {Record<string, number|null>} */
      const native = {};
      for (const item of mediaBody?.items ?? []) {
        const src = String(item?.src ?? '');
        if (src === '') continue;
        native[src] = item.durationSec ?? null;
        native[src.split('#')[0]] = item.durationSec ?? null;
      }
      const doc = docBody.doc;
      transState.fps = doc?.fps ?? { num: 30, den: 1 };
      transState.cuts = detectCutPoints({ tracks: doc?.tracks ?? [], stage: doc?.stage, native, fps: transState.fps }).cuts ?? [];
      transState.transitions = detectTransitions({ tracks: doc?.tracks ?? [], stage: doc?.stage, native, fps: transState.fps }).transitions ?? [];
      transState.status = 'ready';
      transState.error = '';
      transState.code = '';
      const options = transitionOptions();
      if (!options.some((item) => item.value === transState.pick)) transState.pick = options[0]?.value ?? '';
    } catch (error) {
      if (destroyed) return;
      transState.status = 'error';
      transState.cuts = [];
      transState.transitions = [];
      transState.error = `读不到转场：${describeError(error).message}`;
    }
    renderTransitions();
  }

  /** 拒绝：一个稳定码 + 人话，写进面板（不猜、不夹值）。 */
  function rejectTransition(code, message) {
    transState.code = code;
    transState.error = message;
    transState.notice = '';
    renderTransitions();
  }

  /**
   * 加淡入淡出：先按**面板口径**校验（0.05–2s，负/超界/非数字各一个码），
   * 再交给 `planTransitionCreate`（它还会按源余量往下吸帧，吸了就报 HEADROOM_CLAMPED）。
   */
  function addTransition() {
    const picked = currentTransitionPick();
    if (picked === null || picked.kind !== 'cut') {
      rejectTransition('TRANSITION_NO_CUT', '先在上面选一个接缝');
      return;
    }
    const raw = String(transState.duration ?? '').trim();
    if (raw === '' || !/^-?\d+(\.\d+)?$|^-?\.\d+$/.test(raw)) {
      rejectTransition('FADE_NOT_A_NUMBER', `「${raw}」不是数字：时长要写秒数（0.05–2）`);
      return;
    }
    const seconds = Number(raw);
    if (!Number.isFinite(seconds)) {
      rejectTransition('FADE_NOT_A_NUMBER', `「${raw}」不是数字：时长要写秒数（0.05–2）`);
      return;
    }
    if (seconds < 0) {
      rejectTransition('FADE_NEGATIVE', `时长不能是负值（收到 ${raw}）`);
      return;
    }
    if (seconds > TRANS_MAX) {
      rejectTransition('FADE_TOO_LONG', `时长最多 ${String(TRANS_MAX)}s（收到 ${raw}）`);
      return;
    }
    if (seconds < TRANS_MIN) {
      rejectTransition('FADE_TOO_SHORT', `时长至少 ${String(TRANS_MIN)}s（收到 ${raw}）`);
      return;
    }
    const planned = planTransitionCreate({ cut: picked.cut, durationSec: seconds, fps: transState.fps });
    if (planned.ok !== true) {
      rejectTransition(String(planned.code ?? 'TRANSITION_REJECTED'), String(planned.message ?? '加不上'));
      return;
    }
    transState.code = planned.code === null || planned.code === undefined ? '' : String(planned.code);
    transState.error = '';
    transState.notice = String(planned.message ?? '');
    renderTransitions();
    deps.bridge?.commitOps?.(planned.ops, '加淡入淡出');
  }

  /** 移除：`planTransitionRemove` 把后段推回硬切并清掉转场用的 fade（前段淡入/后段淡出保留）。 */
  function removeTransition() {
    const picked = currentTransitionPick();
    if (picked === null || picked.kind !== 'transition') {
      rejectTransition('TRANSITION_NONE', '这个接缝上没有转场可移除');
      return;
    }
    const planned = planTransitionRemove({ transition: picked.transition, fps: transState.fps });
    if (planned.ok !== true) {
      rejectTransition('TRANSITION_REMOVE_FAILED', String(planned.message ?? '移除失败'));
      return;
    }
    transState.code = '';
    transState.error = '';
    transState.notice = String(planned.message ?? '');
    renderTransitions();
    deps.bridge?.commitOps?.(planned.ops, '移除转场');
  }

  /* ── 字幕面板（E12-P5 / R24）────────────────────────────────────────── */

  /**
   * 字幕面板的**唯一**状态。
   *
   * 数据源与 App 完全同一套：`GET/PUT /api/projects/:id/subtitles`，宿主 src = 文档里
   * **第一个视频片段**的 src（`subtitleCandidate` 的口径，见 App.tsx M24 注释）。
   * 我们只有一条字幕轨（伴生 `.vtt`/`.srt`），所以「导入」= 写进这条轨；导入/编辑之后
   * 通过 `deps.bridge.reloadSubtitles()` 让 App 重取一次，时间线的 `.tl-cue` 立刻跟上。
   *
   * `burn` 是 App 导出表单里的 `subtitleBurn`（工程设置里没有这一项），
   * 由 `deps.bridge.getBurn/setBurn` 读写 —— 与导出面板那颗开关是同一个值。
   *
   * @type {{ status: 'idle'|'loading'|'ready'|'error', projectId: string, src: string,
   *   file: string | null, format: 'vtt'|'srt', cues: any[], skipped: number,
   *   mode: 'file'|'playhead', burn: boolean, busy: boolean, selected: number, error: string }}
   */
  const subState = {
    status: 'idle',
    projectId: '',
    src: '',
    file: null,
    format: 'vtt',
    cues: [],
    skipped: 0,
    mode: 'file',
    preset: 'default',
    burn: false,
    busy: false,
    selected: -1,
    error: '',
  };

  /**
   * 字幕挂在哪：文档里第一个视频片段的 src（剥 `#t=`）。
   * 与 App 的 `subtitleCandidate` 同一条规则 —— 两边算出不同的 src 就会写进两份文件。
   *
   * @param {any} doc
   */
  function subtitleHostSrc(doc) {
    for (const track of doc?.tracks ?? []) {
      for (const clip of track?.clips ?? []) {
        if (String(clip?.kind ?? '') !== 'video') continue;
        const src = String(clip?.src ?? '').split('#')[0] ?? '';
        if (src !== '') return src;
      }
    }
    return '';
  }

  /** 段列表里的时间：短于 1 小时给 `mm:ss`，否则 `HH:MM:SS`（完整值在 title 里）。 */
  function subTimeLabel(seconds) {
    const full = formatCueTime(seconds);
    return Number(seconds) >= 3600 ? full.slice(0, 8) : full.slice(3, 8);
  }

  /**
   * 六颗预设按钮的 HTML。顺序 = `SUBTITLE_PRESET_IDS`（与检查器那六颗同一份元表）。
   *
   * `data-active` 是 E12-P5 的 C5 读的那个属性：任意时刻**恰好一颗** `"true"`。
   * `aria-pressed` 给读屏与键盘用，两者同源，不各自维护。
   *
   * @param {string} active 当前预设 id（**必须显式传**：模板是在这个文件的 `subState`
   *   声明之前求值的，默认参数一碰 `subState` 就是 TDZ 的 `Cannot access ... before initialization`）
   */
  function railPresetButtonsHtml(active) {
    return listSubtitlePresets()
      .map((id) => {
        const preset = getSubtitlePreset(id);
        const on = id === active;
        return `<button type="button" class="rail-preset${on ? ' is-on' : ''}" data-testid="rail-subtitle-preset-${id}" data-rail-preset="${id}" data-active="${on ? 'true' : 'false'}" aria-pressed="${on ? 'true' : 'false'}" title="${esc(preset?.description ?? '')}">${esc(preset?.label ?? id)}</button>`;
      })
      .join('');
  }

  /**
   * 把高亮刷成 `subState.preset`。
   *
   * **只改属性、不重建节点**：重建会把键盘焦点扔掉（用户用 Tab 连点两颗就丢一次），
   * 而这条路径每次点击都会走一遍。节点数不对（模板还没铺/被别处清空）时才整体重铺。
   */
  function renderSubtitlePresets() {
    const row = host.querySelector('[data-testid="rail-subtitle-presets"]');
    if (row === null) return;
    const ids = listSubtitlePresets();
    if (row.children.length !== ids.length) {
      row.innerHTML = railPresetButtonsHtml(subState.preset);
      return;
    }
    for (const button of row.querySelectorAll('[data-rail-preset]')) {
      const on = button.getAttribute('data-rail-preset') === subState.preset;
      button.setAttribute('data-active', on ? 'true' : 'false');
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on) button.classList.add('is-on');
      else button.classList.remove('is-on');
    }
  }

  /**
   * 点一颗预设：**只写 `preset` 这个 id**，派生值（字号/描边/底色）由 layers 的
   * `applyStylePreset()` 在渲染时展开 —— 预览与成片读同一份，不存在第二套真相。
   *
   * 真正的写盘与重渲染在 App 侧（`bridge.applySubtitlePreset` → `changeSubtitleStyle` →
   * 覆盖层 `updateStyle`），所以这里**不自己 PUT**：两处都写就会有两个写入面。
   *
   * @param {string} id
   */
  function applyRailPreset(id) {
    if (getSubtitlePreset(id) === null) return;
    const applied = deps.bridge?.applySubtitlePreset?.(id);
    if (applied === false) {
      /* 宿主拒绝（没有打开的工程）：不要把高亮切过去骗人。 */
      subState.preset = String(deps.bridge?.getSubtitlePreset?.() ?? subState.preset);
      renderSubtitlePresets();
      return;
    }
    subState.preset = String(deps.bridge?.getSubtitlePreset?.() ?? id);
    renderSubtitlePresets();
  }

  /** 一条自定义项的段 HTML（时间按钮 + 文本输入；点时间跳时间线，改文本写回 VTT）。 */
  function subCueHtml(cue, index) {
    const full = formatCueTime(cue.start);
    return `<div class="rail-cue${index === subState.selected ? ' is-selected' : ''}" role="listitem" data-testid="rail-subtitle-cue" data-cue-index="${String(index)}" data-cue-start="${String(cue.start)}">
      <button type="button" class="rail-cue-t" data-rail-subtitle="seek" title="${esc(full)} · 跳到时间线" aria-label="跳到 ${esc(full)}">${esc(subTimeLabel(cue.start))}</button>
      <span class="rail-field rail-field-cue"><input class="rail-cue-i" data-testid="rail-subtitle-cue-text" data-cue-text="${String(index)}" type="text" value="${esc(String(cue.text ?? '').replace(/\n/g, ' '))}" spellcheck="false" aria-label="第 ${String(index + 1)} 段字幕文本" /></span>
    </div>`;
  }

  function renderSubtitles() {
    const form = host.querySelector('[data-testid="rail-subtitle-form"]');
    if (form === null) return;
    form.setAttribute('data-mode', subState.mode);
    renderSubtitlePresets();
    for (const button of form.querySelectorAll('[data-rail-mode]')) {
      const on = button.getAttribute('data-rail-mode') === subState.mode;
      button.setAttribute('aria-selected', on ? 'true' : 'false');
      button.setAttribute('tabindex', on ? '0' : '-1');
    }
    const primary = form.querySelector('[data-testid="rail-subtitle-primary"]');
    if (primary !== null) {
      primary.textContent = subState.mode === 'playhead' ? '在播放头加一条' : '选择 SRT / VTT 文件';
      primary.setAttribute('data-busy', subState.busy ? '1' : '0');
    }
    const count = form.querySelector('[data-testid="rail-subtitle-count"]');
    if (count !== null) {
      count.textContent = `段 ${String(subState.cues.length)}`;
      count.setAttribute('data-count', String(subState.cues.length));
    }
    const file = form.querySelector('[data-testid="rail-subtitle-file-label"]');
    if (file !== null) {
      file.textContent = subState.file ?? (subState.src === '' ? '无视频片段' : '无文件');
      file.setAttribute(
        'title',
        subState.file === null
          ? subState.src === ''
            ? '字幕挂在视频片段上：工程里还没有视频片段'
            : '还没有伴生字幕文件（导入后会在视频旁新建 .vtt）'
          : `${subState.file} · ${String(subState.format).toUpperCase()}${subState.skipped > 0 ? ` · 跳过 ${String(subState.skipped)} 条坏 cue` : ''}`,
      );
    }
    const list = form.querySelector('[data-testid="rail-subtitle-cues"]');
    if (list !== null) list.innerHTML = subState.cues.map(subCueHtml).join('');
    const hint = form.querySelector('[data-rail-subtitle-hint]');
    if (hint !== null) {
      hint.hidden = subState.cues.length > 0;
      hint.textContent =
        subState.mode === 'playhead'
          ? '还没有字幕：把播放头停到要加字幕的位置，再点上面的按钮'
          : '还没有字幕：可以导入 SRT / WebVTT，或在播放头处加一条';
    }
    const burn = form.querySelector('[data-testid="rail-subtitle-burn"]');
    if (burn !== null) {
      burn.setAttribute('aria-checked', subState.burn ? 'true' : 'false');
      burn.setAttribute('data-on', subState.burn ? 'true' : 'false');
      /* 与导出面板同一口径：没有字幕就没得烧（那颗按钮也是 burnAvailable 才可用）。 */
      const usable = subState.cues.length > 0;
      burn.disabled = !usable;
      burn.setAttribute('aria-disabled', usable ? 'false' : 'true');
      burn.setAttribute('title', usable ? '烧录字幕：导出时同一批帧再编一条带字幕的 -subbed.mp4' : '烧录字幕：先有字幕才能烧');
    }
    const error = form.querySelector('[data-testid="rail-subtitle-error"]');
    if (error !== null) {
      error.hidden = subState.error === '';
      error.textContent = subState.error;
    }
  }

  /**
   * 拉一次：文档（拿宿主 src）→ 伴生字幕（拿 cue）。
   * 换工程、切进「字幕」分类、导入/编辑之后都会走这里。
   */
  async function refreshSubtitles() {
    const projectId = deps.projectId();
    subState.projectId = projectId;
    /* 样式不是这条路管的（它在 `.film/subtitle-style.json`），但高亮得跟着真值走：
       检查器改了预设、或者换工程读了另一份样式，这里都要同步。 */
    subState.preset = String(deps.bridge?.getSubtitlePreset?.() ?? subState.preset);
    if (projectId === '') {
      subState.status = 'ready';
      subState.src = '';
      subState.cues = [];
      subState.file = null;
      subState.burn = deps.bridge?.getBurn?.() === true;
      subState.error = '';
      renderSubtitles();
      return;
    }
    subState.status = 'loading';
    renderSubtitles();
    try {
      const docRes = await fetch(`/api/projects/${encodeURIComponent(projectId)}/doc`, { cache: 'no-store' });
      const docBody = await docRes.json();
      if (destroyed) return;
      if (docBody?.ok !== true) throw Object.assign(new Error('DOC_FAILED'), { code: docBody?.code ?? 'DOC_FAILED' });
      const src = subtitleHostSrc(docBody.doc);
      subState.src = src;
      if (src === '') {
        subState.status = 'ready';
        subState.cues = [];
        subState.file = null;
        subState.skipped = 0;
        subState.burn = deps.bridge?.getBurn?.() === true;
        subState.error = '这个工程还没有视频片段：字幕跟着第一个视频片段走';
        renderSubtitles();
        return;
      }
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/subtitles?src=${encodeURIComponent(src)}`, { cache: 'no-store' });
      const body = await res.json();
      if (destroyed) return;
      if (body?.ok !== true) throw Object.assign(new Error('SUBTITLE_READ_FAILED'), { code: body?.code ?? 'SUBTITLE_READ_FAILED', message: body?.message });
      subState.status = 'ready';
      subState.cues = Array.isArray(body.cues) ? body.cues : [];
      subState.file = body.file ?? null;
      subState.format = body.format === 'srt' ? 'srt' : 'vtt';
      subState.skipped = Number(body.skipped) || 0;
      subState.selected = -1;
      subState.burn = deps.bridge?.getBurn?.() === true;
      subState.error = '';
    } catch (error) {
      if (destroyed) return;
      subState.status = 'error';
      subState.cues = [];
      subState.error = `读不到字幕：${describeError(error).message}`;
    }
    renderSubtitles();
  }

  /** 把一组 cue 写回（原子写 + 回读校验在服务端），成功后让 App 重取一次让时间线跟上。 */
  async function saveSubtitleCues(next, note) {
    const projectId = deps.projectId();
    if (projectId === '' || subState.src === '') return false;
    subState.busy = true;
    subState.error = '';
    renderSubtitles();
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/subtitles`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ src: subState.src, cues: next }),
      });
      const body = await res.json();
      if (destroyed) return false;
      if (body?.ok !== true) throw Object.assign(new Error('SUBTITLE_SAVE_FAILED'), { code: body?.code ?? 'SUBTITLE_SAVE_FAILED', message: body?.message });
      subState.cues = next;
      subState.file = body.file ?? subState.file;
      subState.format = body.format === 'srt' ? 'srt' : subState.format;
      subState.busy = false;
      renderSubtitles();
      /* 时间线/画布的字幕来自 App 的 cues 状态：写完必须让它重取，否则只有左栏变了。 */
      deps.bridge?.reloadSubtitles?.();
      if (note !== '') deps.onNotice?.(`${note} · ${String(body.file ?? '')} · ${String(body.bytes ?? 0)} B`);
      return true;
    } catch (error) {
      if (destroyed) return false;
      subState.busy = false;
      subState.error = `保存失败：${describeError(error).message}`;
      renderSubtitles();
      return false;
    }
  }

  /**
   * 导入 SRT / VTT：按**文件自身的时间**落进字幕轨（不重排、不搬到播放头）。
   * 解析用 film-core 的 `parseSubtitles`（与时间线/导出同一份），坏 cue 只跳过并计数。
   */
  async function importSubtitleFile(file) {
    if (subState.src === '') {
      subState.error = '先放一个视频片段：字幕挂在第一个视频片段旁边';
      renderSubtitles();
      return;
    }
    let text;
    try {
      text = await file.text();
    } catch (error) {
      subState.error = `读不了这个文件：${describeError(error).message}`;
      renderSubtitles();
      return;
    }
    const ext = String(file.name).toLowerCase();
    const parsed = parseSubtitles(text, { format: ext.endsWith('.srt') ? 'srt' : undefined });
    if (parsed.cues.length === 0) {
      subState.error = `${file.name} 里没有可用的字幕段（坏了 ${String(parsed.skipped)} 条）`;
      renderSubtitles();
      return;
    }
    subState.selected = -1;
    const ok = await saveSubtitleCues(parsed.cues, `已导入 ${file.name} · ${String(parsed.cues.length)} 段`);
    if (ok) subState.error = '';
  }

  /**
   * 播放头处加一条：起 = 播放头，止 = 下一条 cue 或 +2s（取小，至少 0.3s）。
   *
   * 文本先给「新字幕」而不是空串 —— 服务端 `normalizeCues` 明确拒绝空文本
   * （`第 N 条字幕没有文本`），新建时就落一份空文本会被 400 挡回来。
   * 聚焦 + 全选，直接打字就是覆盖。
   */
  async function addCueAtPlayhead() {
    if (subState.src === '') {
      subState.error = '先放一个视频片段：字幕挂在第一个视频片段旁边';
      renderSubtitles();
      return;
    }
    let at = Math.max(0, Math.round(Number(deps.t()) * 1000) / 1000);
    /* 播放头正落在某条 cue 里面（点段跳过来就会这样）时，从那条的结尾开始 ——
       不叠出两条同时出现的字幕（叠了也不报错，但成片会两行挤在一起）。 */
    for (const cue of subState.cues) {
      if (Number(cue.start) <= at && Number(cue.end) > at) at = Math.round(Number(cue.end) * 1000) / 1000;
    }
    const after = subState.cues.filter((cue) => Number(cue.start) > at).sort((a, b) => Number(a.start) - Number(b.start))[0];
    const limit = after === undefined ? at + 2 : Math.min(at + 2, Number(after.start));
    const end = Math.round(Math.max(at + 0.3, limit) * 1000) / 1000;
    const next = [...subState.cues, { start: at, end, text: '新字幕' }].sort((a, b) => a.start - b.start);
    const index = next.findIndex((cue) => cue.start === at && cue.text === '新字幕');
    subState.selected = index;
    const ok = await saveSubtitleCues(next, `已在 ${formatCueTime(at)} 加一条`);
    if (ok) {
      const input = host.querySelector(`[data-cue-text="${String(index)}"]`);
      if (input instanceof HTMLInputElement) {
        input.focus();
        input.select();
      }
    }
  }

  /** 改一条文本：先改内存再整份写回（服务端重序列化 → VTT 里只有这一行变）。 */
  async function commitCueText(index, text) {
    const cue = subState.cues[index];
    if (cue === undefined) return;
    const next = text.replace(/\r?\n/g, ' ').trim();
    if (next === String(cue.text)) return;
    if (next === '') {
      subState.error = '字幕文本不能为空（要删就用时间线右键删段）';
      renderSubtitles();
      return;
    }
    const cues = subState.cues.map((item, at) => (at === index ? { ...item, text: next } : item));
    subState.selected = index;
    await saveSubtitleCues(cues, `已改第 ${String(index + 1)} 段`);
  }

  /**
   * 字幕的两个来源 tab（表单式，没有二级树）：只切**主按钮的动作**与空态文案。
   * 段列表与烧录开关在两种模式下都在（它们不属于「来源」）。
   *
   * @param {string} mode 'file' | 'playhead'
   */
  function setSubtitleMode(mode) {
    subState.mode = mode === 'playhead' ? 'playhead' : 'file';
    renderSubtitles();
  }

  /* ── 素材网格（E12-P2 / R23）────────────────────────────────────────── */

  /**
   * 素材卡片的唯一数据源：**film 文档里被引用的源**（`GET /api/projects/:id/doc`）。
   *
   * 为什么不读 `/assets`：素材库要能出「网页」这一类（`.html` 页片段），而 `/assets` 只列
   * `assets/` 目录、不含 `scenes/*.html`。按文档里的 `clip.src` 去重，卡数天然等于「这个工程
   * 用到的 media 数」（同一个源被两个片段引用只算一张卡，`clips` 记引用次数）。
   *
   * @type {{ status: 'idle'|'loading'|'ready'|'error', items: any[], filter: string, query: string,
   *   error: string, projectId: string }}
   */
  /* R71：`favoriteOnly` + `favorites` 是「收藏」那一行用的。收藏只影响**看**，
     不动 film 文档、不进 /ops —— 存 localStorage（key 带 projectId），换工程各算各的。 */
  const mediaState = { status: 'idle', items: [], filter: 'all', query: '', error: '', projectId: '', favoriteOnly: false, favorites: new Set() };

  /** 收藏集合的 localStorage 键（每个工程一份）。 */
  function favoritesKey(projectId) {
    return `opencut.media.favorites.${projectId}`;
  }

  /** 从 localStorage 读当前工程的收藏集合；读坏了就当空（绝不因此让面板崩）。 */
  function loadFavorites(projectId) {
    if (projectId === '') return new Set();
    try {
      const raw = window.localStorage.getItem(favoritesKey(projectId));
      const list = raw === null ? [] : JSON.parse(raw);
      return new Set(Array.isArray(list) ? list.filter((value) => typeof value === 'string') : []);
    } catch {
      return new Set();
    }
  }

  /** 写回当前工程的收藏集合。 */
  function saveFavorites(projectId, set) {
    if (projectId === '') return;
    try {
      window.localStorage.setItem(favoritesKey(projectId), JSON.stringify([...set]));
    } catch {
      /* 隐私模式/配额满：收藏不落盘也不该打断操作。 */
    }
  }

  const MEDIA_KIND_LABEL = Object.freeze({ video: '视频', still: '图片', sound: '音频', page: '网页' });

  /** `clip.time` = `#t=in,out` 解析出来的数组（只有 in 时表示到结尾）。 */
  function mediaRangeOf(clip) {
    const time = Array.isArray(clip?.time) ? clip.time : null;
    if (time === null || time.length === 0) return null;
    const from = Number(time[0]);
    if (!Number.isFinite(from)) return null;
    const to = time.length >= 2 ? Number(time[1]) : NaN;
    return { from, to: Number.isFinite(to) && to > from ? to : null };
  }

  /** 取文件名（`assets/take-01.mp4` → `take-01.mp4`）。 */
  function mediaNameOf(src) {
    const bare = String(src ?? '').split('#')[0] ?? '';
    const cut = bare.lastIndexOf('/');
    return cut < 0 ? bare : bare.slice(cut + 1);
  }

  /** 时长角标：短于 10s 给一位小数（参照是 `0:04` / `4.0s` 两种，这里统一成 `4.0s`）。 */
  function mediaDurationLabel(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const m = Math.floor(seconds / 60);
    const rest = Math.round(seconds - m * 60);
    return `${m}:${String(rest).padStart(2, '0')}`;
  }

  /**
   * 片段源区间的中点（毫秒）：`derived` 的 `ms` 就取它。
   *
   * **不要在这里再写一次 `Math.round`** —— 时间线胶片条（`filmstrip.ts`）算的是同一个
   * 源时刻，两边必须过同一个函数（`layers/frame-ms.mjs` 的 `frameMsAt`），否则同一格
   * 会因为取整/末尾容差差 1ms，缓存就 miss 成另一张图。
   */
  function mediaMidMs(item) {
    return frameMsMidpoint(item?.from, item?.to);
  }

  /**
   * 缩略图 URL（`w=160` = 80 CSS px 的 2 倍，参照的胶片格就是 80）。
   *
   * 音频与网页**不生成 URL**：`derived?what=frame` 对这两类明确 415（没有画面 / 要无头浏览器），
   * 请求了只会拿到一张破图。它们在卡片里走占位块。
   */
  function mediaThumbUrl(item) {
    if (NO_FRAME_KINDS.includes(item.kind)) return '';
    if (mediaState.projectId === '') return '';
    const projectId = mediaState.projectId;
    return `/api/projects/${encodeURIComponent(projectId)}/derived?what=frame&rel=${encodeURIComponent(item.src)}&ms=${String(mediaMidMs(item))}&w=160`;
  }

  function mediaCardHtml(item) {
    const label = MEDIA_KIND_LABEL[item.kind] ?? item.kind;
    const dur = mediaDurationLabel(item.nativeDuration ?? item.duration);
    const missing = item.status === 'missing';
    const unreadable = item.status === 'unreadable';
    /** @type {'ok'|'missing'|'unreadable'|'unknown'} */
    const status = missing ? 'missing' : unreadable ? 'unreadable' : item.status === 'ok' ? 'ok' : 'unknown';
    /* 缺文件/读不了的卡不请求缩略图：请求只会拿回 404 破图，等于拿「失败」冒充「缺失」。 */
    const thumb = status === 'missing' || status === 'unreadable' ? '' : mediaThumbUrl(item);
    const placeholderKind = NO_FRAME_KINDS.includes(item.kind);
    /* 封面四态：placeholder（本来没帧：音频/网页/缺失/读不了）、loading（真帧在拉）、
       ready/failed 由 <img> 的 load/error 事件就地改写（见 bindMediaGrid）。 */
    const thumbState = thumb === '' ? 'placeholder' : 'loading';
    const phGlyph = item.kind === 'page' ? 'html' : item.kind === 'sound' ? '♪' : '';
    const inner =
      thumb !== ''
        ? `<img class="rail-media-img" src="${esc(thumb)}" alt="" loading="lazy" data-testid="rail-media-thumb" data-media-thumb="${esc(item.src)}" data-media-ms="${String(mediaMidMs(item))}" />`
        : `<span class="dock-media-ph" aria-hidden="true">${phGlyph}</span>`;
    const starred = mediaState.favorites.has(item.src);
    const statusBadge = missing ? '<span class="dock-media-badge" data-media-badge="missing">缺失</span>'
      : unreadable ? '<span class="dock-media-badge" data-media-badge="unreadable">读不了</span>'
        : '';
    const statusText = missing ? '文件不在（缺失）' : unreadable ? '文件在但读不了（失败）' : '可用';
    const wired = typeof deps.onInsertAsset === 'function';
    return `<div class="rail-media-card" role="listitem" data-testid="rail-media-card" data-media-src="${esc(item.src)}" data-media-kind="${esc(item.kind)}" data-media-clips="${String(item.clips)}" data-media-starred="${starred ? '1' : '0'}" data-media-status="${esc(status)}" data-thumb-state="${thumbState}">
      <button type="button" class="rail-media-pick" data-testid="rail-media-pick" data-media-preview="${esc(item.src)}" title="预览：${esc(item.src)} · ${esc(label)}${dur === '' ? '' : ` · ${esc(dur)}`}${status === 'ok' ? '' : ` · ${esc(statusText)}`}（只放大封面，不动时间线）">
        <span class="rail-media-thumb dock-media-thumb">
          ${inner}
          <span class="dock-media-skel" aria-hidden="true"></span>
          <span class="dock-media-fail" aria-hidden="true">封面不可用</span>
          ${dur === '' ? '' : `<span class="rail-media-dur">${esc(dur)}</span>`}
          ${statusBadge}
        </span>
        <span class="rail-media-name" title="${esc(item.name)}">${esc(item.name)}</span>
      </button>
      <span class="dock-media-meta" title="来源：${esc(item.src)} · ${esc(label)} · ${esc(statusText)} · 被 ${String(item.clips)} 个片段引用">
        <span class="dock-media-kind">${esc(label)}</span>
        <span class="dock-media-src">${esc(item.src)}</span>
      </span>
      <span class="dock-media-acts">
        <button type="button" class="dock-media-act" data-testid="rail-media-preview" data-media-preview="${esc(item.src)}" title="预览：放大看这张封面（不改时间线、不发 /ops）">预览</button>
        <button type="button" class="dock-media-act" data-testid="rail-media-insert" data-media-insert="${esc(item.src)}"${wired ? '' : ' disabled data-unwired="1"'} title="${wired ? `加入时间线：在播放头处插入 ${esc(item.name)}（与「导入素材」同一条插入链，一步撤销）` : '加入时间线：入口还没接线（等 MAIN 应用 R104 补丁；本卡不做假动作）'}">加入</button>
      </span>
      <button type="button" class="rail-media-star" data-testid="rail-media-star" data-rail-media-star="1" aria-pressed="${starred ? 'true' : 'false'}" title="${starred ? '取消收藏' : '收藏'}" aria-label="收藏 ${esc(item.name)}">★</button>
    </div>`;
  }

  /** 当前筛选 + 搜索 + 收藏之后的卡片（前端过滤，不改数据）。 */
  function mediaVisible() {
    const query = mediaState.query.trim().toLowerCase();
    return mediaState.items.filter((item) => {
      if (mediaState.favoriteOnly && !mediaState.favorites.has(item.src)) return false;
      if (mediaState.filter !== 'all' && item.kind !== mediaState.filter) return false;
      if (query === '') return true;
      return `${item.name} ${item.src}`.toLowerCase().includes(query);
    });
  }

  function renderMedia() {
    const grid = host.querySelector('[data-testid="rail-media-grid"]');
    const emptyBox = host.querySelector('[data-testid="rail-empty-assets"]');
    const noneMsg = host.querySelector('[data-testid="rail-media-none"]');
    const favBtn = host.querySelector('[data-testid="rail-assets-favorite"]');
    const title = host.querySelector('[data-testid="rail-assets-title"]');
    const loadingBox = host.querySelector('[data-testid="rail-media-loading"]');
    const errorBox = host.querySelector('[data-testid="rail-media-error"]');
    const retryBtn = host.querySelector('[data-testid="rail-media-retry"]');
    const visible = mediaVisible();
    if (grid !== null) {
      grid.innerHTML = visible.map(mediaCardHtml).join('');
      /* U06：读盘期间网格空着（骨架在加载节点里），不拿空态冒充「没有素材」。 */
      grid.hidden = mediaState.status !== 'ready' || visible.length === 0;
    }
    /* U06（A20）：加载 / 失败 / 空 三态各有各的节点，互不冒充。 */
    if (loadingBox !== null) loadingBox.hidden = mediaState.status !== 'loading';
    if (errorBox !== null) {
      errorBox.hidden = mediaState.status !== 'error';
      errorBox.textContent = mediaState.status === 'error' ? `素材读取失败：${mediaState.error}` : '';
    }
    if (retryBtn !== null) retryBtn.hidden = mediaState.status !== 'error';
    /* 收藏行是开关：开着 = 只看收藏；标题跟着说清「现在看的是哪一堆」。 */
    if (favBtn !== null) favBtn.setAttribute('aria-pressed', mediaState.favoriteOnly ? 'true' : 'false');
    if (title !== null) title.textContent = mediaState.favoriteOnly ? '收藏' : '全部';
    /* 空态只在「这个工程真的一张都没有」时出现；筛选筛没了给另一句，别把空态说成没素材。 */
    if (emptyBox !== null) emptyBox.hidden = !(mediaState.status === 'ready' && mediaState.items.length === 0);
    if (noneMsg !== null) noneMsg.hidden = !(mediaState.status === 'ready' && mediaState.items.length > 0 && visible.length === 0);
  }

  /** U06：预览浮层只读展示（真封面 + 元信息），不开写链、不动时间线。 */
  function openMediaPreview(src) {
    const overlay = host.querySelector('[data-testid="rail-media-preview-overlay"]');
    const item = mediaState.items.find((one) => one.src === src);
    if (overlay === null || item === undefined) return;
    const label = MEDIA_KIND_LABEL[item.kind] ?? item.kind;
    const dur = mediaDurationLabel(item.nativeDuration ?? item.duration);
    const statusText = item.status === 'missing' ? '文件不在（缺失）' : item.status === 'unreadable' ? '文件在但读不了（失败）' : '可用';
    const setText = (testid, text) => {
      const node = host.querySelector(`[data-testid="${testid}"]`);
      if (node !== null) node.textContent = text;
    };
    const img = host.querySelector('[data-testid="rail-media-preview-img"]');
    const noframe = host.querySelector('[data-testid="rail-media-preview-noframe"]');
    const noFrame = NO_FRAME_KINDS.includes(item.kind) || item.status !== 'ok';
    if (img !== null) {
      if (noFrame) img.removeAttribute('src');
      else img.setAttribute('src', `/api/projects/${encodeURIComponent(mediaState.projectId)}/derived?what=frame&rel=${encodeURIComponent(item.src)}&ms=${String(mediaMidMs(item))}&w=480`);
      img.hidden = noFrame;
    }
    if (noframe !== null) {
      noframe.hidden = !noFrame;
      noframe.textContent = item.status === 'missing' ? '文件不在：没有封面可看（缺失）'
        : item.status === 'unreadable' ? '文件读不了：没有封面可看（失败）'
          : '这一类没有画面帧（音频/网页）：不做假封面';
    }
    setText('rail-media-preview-name', item.name);
    setText('rail-media-preview-kind', label);
    setText('rail-media-preview-dur', dur === '' ? '—' : dur);
    setText('rail-media-preview-src', item.src);
    setText('rail-media-preview-status', statusText);
    overlay.hidden = false;
  }

  function closeMediaPreview() {
    const overlay = host.querySelector('[data-testid="rail-media-preview-overlay"]');
    if (overlay !== null) overlay.hidden = true;
    const img = host.querySelector('[data-testid="rail-media-preview-img"]');
    if (img !== null) img.removeAttribute('src');
  }

  /**
   * 拉一次 film 文档 → 去重出 media 列表。
   * 只在「进素材 tab」与「换工程」时跑，不在每次切 tab 都跑（文档没变就不该重打）。
   */
  async function refreshMedia() {
    const projectId = deps.projectId();
    mediaState.projectId = projectId;
    mediaState.favorites = loadFavorites(projectId);
    if (projectId === '') {
      mediaState.status = 'ready';
      mediaState.items = [];
      renderMedia();
      return;
    }
    mediaState.status = 'loading';
    renderMedia();
    try {
      /* U06（A20）：文档 + `/media-status` 一起拉 —— 后者给「缺失 / 读不了」，
         两者缺一就会把「文件不在」显示成「加载/失败」。只读 GET，不改任何 handler。 */
      const [res, statusRes] = await Promise.all([
        fetch(`/api/projects/${encodeURIComponent(projectId)}/doc`, { cache: 'no-store' }),
        fetch(`/api/projects/${encodeURIComponent(projectId)}/media-status`, { cache: 'no-store' })
          .then((one) => (one.ok ? one.json() : null))
          .catch(() => null),
      ]);
      const body = await res.json();
      if (destroyed) return;
      if (body?.ok !== true) throw Object.assign(new Error('DOC_FAILED'), { code: body?.code ?? 'DOC_FAILED' });
      /** @type {Map<string, {status: string, durationSec: number|null, hasAudio: boolean}>} */
      const statusOf = new Map();
      for (const item of statusRes?.items ?? []) {
        const src = String(item?.src ?? '').split('#')[0] ?? '';
        if (src === '') continue;
        statusOf.set(src, {
          status: String(item?.status ?? 'unknown'),
          durationSec: Number.isFinite(item?.durationSec) ? Number(item.durationSec) : null,
          hasAudio: item?.hasAudio === true,
        });
      }
      const byKey = new Map();
      for (const track of body.doc?.tracks ?? []) {
        for (const clip of track?.clips ?? []) {
          const src = String(clip?.src ?? '').split('#')[0] ?? '';
          if (src === '') continue;
          const kind = String(clip?.kind ?? 'video');
          const range = mediaRangeOf(clip);
          const prev = byKey.get(src);
          if (prev === undefined) {
            byKey.set(src, {
              src,
              kind,
              name: mediaNameOf(src),
              from: range === null ? null : range.from,
              to: range === null ? null : range.to,
              duration: range !== null && range.to !== null ? range.to - range.from : null,
              clips: 1,
              /* U06：文件真实状态（ok / missing / unreadable / unknown）与原生时长。 */
              status: statusOf.get(src)?.status ?? 'unknown',
              nativeDuration: statusOf.get(src)?.durationSec ?? null,
              hasAudio: statusOf.get(src)?.hasAudio === true,
            });
            continue;
          }
          prev.clips += 1;
          if (prev.duration === null && range !== null && range.to !== null) {
            prev.from = range.from;
            prev.to = range.to;
            prev.duration = range.to - range.from;
          }
        }
      }
      /* 排序跟筛选条同序（视频 → 图片 → 音频 → 网页），同类按文件名。
         这样一屏里先看到的是**真缩略图**（视频/图片），而不是一排页片段占位块。 */
      const kindRank = { video: 0, still: 1, sound: 2, page: 3 };
      mediaState.items = [...byKey.values()].sort((a, b) => {
        const rank = (kindRank[a.kind] ?? 9) - (kindRank[b.kind] ?? 9);
        if (rank !== 0) return rank;
        return a.name.localeCompare(b.name);
      });
      mediaState.status = 'ready';
      mediaState.error = '';
    } catch (error) {
      if (destroyed) return;
      mediaState.status = 'error';
      mediaState.error = describeError(error).message;
      mediaState.items = [];
    }
    renderMedia();
  }

  /* ── 图层面板 ─────────────────────────────────────────────────────── */

  /**
   * 把任意层 id 归到「面板里的那一行」。
   *
   * v2 起面板列的是**页面片段内部元素**（`scope:"page"`），行 id 是统一 id
   * `<clipId>::<elementId>`；画布点选（stage 协议的 `pick`）给的是页面文档里的裸定位串，
   * 所以这里先把裸 id 补成统一 id。补不上（不在本页）才交给宿主归并到所属片段行。
   */
  /** 页面子行的 id（= inspect 的入参）：`<clipId>::<页面定位串>`。 */
  function pageRowId(layer) {
    const page = layerState.page;
    return page === null ? layer.id : `${page.clipId}::${layer.id}`;
  }

  function rowFor(at) {
    if (at === '') return '';
    if (layerState.layers.some((layer) => layer.id === at)) return at;
    const page = layerState.page;
    if (page !== null) {
      if (page.layers.some((layer) => pageRowId(layer) === at)) return at;
      /* 画布点选给的是页面里的裸定位串，补给统一 id。 */
      if (!at.includes('::')) {
        const unified = `${page.clipId}::${at}`;
        if (page.layers.some((layer) => pageRowId(layer) === unified)) return unified;
      }
    }
    /* `resolveAt` 是「片段本体定位串」的兜底（`#<clipId>`）。**只有这个 at 确实就是片段本身**才认：
       页面域是异步到的，`page-main::#caption` 在页面还没列出来时会一路落到兜底，
       把坞错切到片段行（S94 实测：S6 因此偶发失败，`target` 变成 `#page-main`、`disabled` 变 0）。
       认不出就返回 ''——调用方（`setSelection`）保持原选中，等页面域到了再读。 */
    if (typeof deps.resolveAt !== 'function') return '';
    const clipAt = deps.resolveAt(at);
    if (clipAt === '') return '';
    const strip = (value) => String(value).replace(/^#/, '');
    return strip(clipAt) === strip(at) ? clipAt : '';
  }
  function renderLayers() {
    if (destroyed) return;
    const startedAt = performance.now();
    retryBtn.hidden = layerState.status !== 'error';
    layersCount.textContent =
      layerState.status === 'ready' || layerState.status === 'empty' ? `${layerState.layers.length} 层` : '—';

    if (layerState.pageErrors.length > 0) {
      layersBanner.hidden = false;
      layersBanner.textContent = `页面有 ${layerState.pageErrors.length} 个错误 · ${layerState.pageErrors[0]}`;
    } else {
      layersBanner.hidden = true;
      layersBanner.textContent = '';
    }

    if (layerState.status === 'loading') {
      layersBody.innerHTML = `
        <div class="skeleton" data-testid="layers-skeleton">
          <div class="sk-row"></div><div class="sk-row"></div><div class="sk-row"></div>
          <div class="sk-row"></div><div class="sk-row"></div><div class="sk-row"></div>
        </div>`;
      return;
    }
    if (layerState.status === 'error') {
      layersBody.innerHTML = `
        <div class="dock-error" data-testid="layers-error" data-code="${esc(layerState.error?.code ?? '')}">
          <strong>读不出图层</strong>
          <p>${esc(layerState.error?.message ?? '未知错误')}</p>
          <button type="button" class="btn tiny" data-testid="layers-retry-inline">重试</button>
        </div>`;
      return;
    }
    if (layerState.status === 'empty') {
      layersBody.innerHTML = `<p class="dock-empty" data-testid="layers-empty">无可发现图层</p>`;
      return;
    }

    /* 行按 API 顺序（= DOM 层序）。缩略图是占位：契约只给 tag/box/text，没有位图。
       v2 的页面域里 `layer.id` 是页面文档里的裸定位串，子行 id（也是 inspect 的入参）
       统一成 `<clipId>::<elementId>`；写回仍用裸定位串（override 挂在页面片段上）。

       树形：film.html 的层是骨架；**选中页面片段**（`#<clipId>`）时它在下面展开自己的页面元素。
       默认收起——这样 v1 的行序/行数在没人选中片段时一字不变（S65/S66 的既有断言仍然成立），
       选中片段或它的某个子行时展开，选中子行读页面域、选中片段行读片段域。 */
    const selected = rowFor(deps.getSelectedAt());
    const page = layerState.page;
    const pageClipRow = page === null ? '' : `#${page.clipId}`;
    const childSelected = page !== null && String(selected).startsWith(`${page.clipId}::`);
    /* 展开是**用户动作**（点片段行 / 画布点到它的子元素），不跟着「默认选中」走：
       否则一进工程就自动选中一个文字层，树会自己展开，v1 的行数就变了。 */
    const expanded = page !== null && layerState.expandedClip === page.clipId;

    const rowHtml = (layer, id, scope, opts = {}) => {
      /* 父行在子行被选中时也点亮（树形展开态），aria-pressed 一并置 true。 */
      const active = id === selected || (opts.parent === true && childSelected);
      const summary =
        typeof layer.text === 'string' && layer.text !== ''
          ? layer.text
          : `${Math.round(layer.box.w)}×${Math.round(layer.box.h)}`;
      /* R102 / U05：层级缩进 8px/级。film.html 的片段行 = 0 级。
         页面元素**没有** depth 字段（`layers-read.mjs` 的 projectLayers 只投影 id/tag/box/source/text，
         改服务端不在本批范围），所以从 `at` 的 DOM 路径里数：`body > div.page > h1` = 3 级；
         命中 id 的层（如 `#title`）只有一段 → 1 级。最深压到 4 级，再深名称列就没了。 */
      const pathOf = String(layer.at ?? id);
      const pathBody = pathOf.includes('::') ? pathOf.slice(pathOf.indexOf('::') + 2) : pathOf;
      const pathDepth = pathBody.split(' > ').length;
      const depth = scope === 'page' ? Math.min(4, Math.max(1, pathDepth)) : 0;
      const scopeLabel = scope === 'page' ? '场景 DOM' : '影片片段';
      const at = scope === 'page' ? id : layer.id;
      const hidden = typeof deps.isHidden === 'function' ? deps.isHidden(id) === true : false;
      const locked = typeof deps.isLocked === 'function' ? deps.isLocked(id) === true : false;
      /* 接线开关：App 把两个会话级回调传进来才可用（见交接 globalHunks H2）。
         没接线时按钮仍在（结构对），但 `disabled` + `data-unwired=1` —— 不做假动作。 */
      const wired = typeof deps.onToggleHidden === 'function' && typeof deps.onToggleLock === 'function';
      const act = (kind, on, hint) =>
        `<button type="button" class="layer-act" data-layer-act="${kind}" data-at="${esc(id)}" aria-pressed="${on ? 'true' : 'false'}"${wired ? '' : ' data-unwired="1" disabled'} title="${esc(hint)}">${LAYER_ACT_GLYPHS[kind] ?? ''}</button>`;
      /* R165 / UI-V3-B（LEFT）：**名称**只做展示。
         规则（方案 §2 图层行 / LEFT-03/05/06）：显式名称 → 原 id → DOM 类型 + 短后缀。
         这里的图层投影（layers-read.mjs）没有 name 字段，所以：
           · `#title` / `#card-a` 这类显式 id → 去掉 `#` 原样；
           · 路径（`body > … > section:nth-of-type(1)`）→ 取最后一段，`:nth-of-type(n)`
             收成短后缀（`section 1`），不猜语义、不改原 id、不影响选择。 */
      const raw = scope === 'page'
        ? String(id).slice(String(id).indexOf('::') + 2)
        : String(layer.id ?? id);
      const explicit = typeof layer.name === 'string' ? layer.name.trim() : '';
      /* 文本层用**正文**当名称（旧行也是这么显示；s207 的长中文名判据就挂在这条上）。
         不是猜语义：正文就是元素自己的可见文字，整串留着，CSS 截断、title 给全名。 */
      const textLabel = typeof layer.text === 'string' ? layer.text.replace(/\s+/g, ' ').trim() : '';
      const lastSegment = raw.includes(' > ') ? raw.slice(raw.lastIndexOf(' > ') + 3) : raw;
      const nth = /:nth-of-type\((\d+)\)$/.exec(lastSegment);
      const derived = nth === null ? lastSegment.replace(/^#/, '') : `${lastSegment.slice(0, nth.index)} ${nth[1]}`;
      const name = explicit !== '' ? explicit : textLabel !== '' ? textLabel : derived;
      /* 技术信息全部留在 tooltip（验收要求「行内技术信息在 tooltip 可见」）：
         友好名 / 域 / 段 / 尺寸 / 文本（有才给）/ 原 id 全在 —— 尺寸与文本都不再靠猜。 */
      const size = `${Math.round(layer.box.w)}×${Math.round(layer.box.h)}`;
      const techTitle = `${name} · ${scopeLabel} · ${layer.tag} · ${size}${
        typeof layer.text === 'string' && layer.text !== '' ? ` · ${layer.text}` : ''
      } · ${at}`;
      /* R165 / LEFT：非默认状态常显（形状 + title，不只看颜色）；默认状态不占位。 */
      const states = `${hidden ? `<span class="layer-state" data-layer-state="hidden" title="已隐藏（仅本会话）" aria-hidden="true">${LAYER_STATE_GLYPHS.hidden}</span>` : ''}${locked ? `<span class="layer-state" data-layer-state="locked" title="已锁定（仅本会话）" aria-hidden="true">${LAYER_STATE_GLYPHS.locked}</span>` : ''}`;
      return `<div class="layer-item" data-depth="${depth}" data-scope="${scope}" style="--layer-depth:${depth}">
        <button type="button" class="layer-row${active ? ' active' : ''}${opts.child === true ? ' child' : ''}" data-testid="layer-row" data-at="${esc(id)}" data-element="${esc(layer.id)}" data-scope="${scope}" data-scope-label="${scopeLabel}" data-depth="${depth}" data-expanded="${opts.expanded === true ? 'true' : 'false'}" data-tag="${esc(layer.tag)}" data-source="${esc(layer.source)}" data-name="${esc(name)}" data-hidden="${hidden ? '1' : '0'}" data-locked="${locked ? '1' : '0'}" aria-pressed="${active ? 'true' : 'false'}" title="${esc(techTitle)}">
        <span class="thumb" aria-hidden="true"></span>
        <span class="layer-main"><span class="layer-name layer-text" title="${esc(name)}">${esc(name)}</span></span>
        <span class="layer-states">${states}</span>
      </button>
        <span class="layer-acts">${act('eye', hidden, hidden ? '显示这一层（会话内，不写工程）' : '隐藏这一层（会话内，不写工程）')}${act('lock', locked, locked ? '解锁这一层（会话内）' : '锁定这一层（会话内：树里点不动、舞台不出框）')}</span>
      </div>`;
    };

    const parts = [];
    let extra = 0;
    for (const layer of layerState.layers) {
      const isPageHost = page !== null && layer.id === pageClipRow;
      parts.push(rowHtml(layer, layer.id, 'clip', { parent: isPageHost, expanded: isPageHost && expanded }));
      if (!isPageHost || !expanded) continue;
      for (const child of page.layers) {
        parts.push(rowHtml(child, pageRowId(child), 'page', { child: true }));
        extra += 1;
      }
    }
    layersBody.innerHTML = `<div class="layer-list" data-testid="layers-list" style="--rows:${layerState.layers.length + extra}">${parts.join('')}</div>`;
    root.setAttribute('data-scope', page === null ? 'clip' : 'page');
    /* 首屏渲染耗时（面板自己的，不含网络）：500 行的性能判据读它。 */
    layerState.lastRenderMs = Number((performance.now() - startedAt).toFixed(2));
  }

  async function refreshLayers() {
    const mySeq = ++seq;
    layerState.status = 'loading';
    layerState.error = null;
    renderLayers();
    const result = await deps.loadLayers();
    if (destroyed || mySeq !== seq) return;
    if (result?.ok !== true) {
      layerState.status = 'error';
      layerState.error = describeError(result);
      layerState.layers = [];
      renderLayers();
      return;
    }
    layerState.layers = Array.isArray(result.layers) ? result.layers : [];
    layerState.pageErrors = Array.isArray(result.pageErrors) ? result.pageErrors : [];
    /* 页面域（可选）：子元素挂在片段行下面；失败只少一层，不影响骨架。 */
    const page = result.page ?? null;
    layerState.page =
      page !== null && Array.isArray(page.layers) && page.layers.length > 0
        ? {
            clipId: String(page.clipId ?? ''),
            layers: page.layers,
            pageErrors: Array.isArray(page.pageErrors) ? page.pageErrors : [],
            frameStatus: String(page.frameStatus ?? ''),
          }
        : null;
    layerState.status = layerState.layers.length === 0 && layerState.page === null ? 'empty' : 'ready';
    /* 换页片段/工程：展开态跟着清掉（否则会用一个旧的 clipId 去比）。 */
    if (layerState.page === null || layerState.expandedClip !== '' && layerState.expandedClip !== layerState.page.clipId) {
      layerState.expandedClip = '';
    }
    renderLayers();
    scrollSelectedIntoView();
    /* 选中若是**页面元素**，要等页面域到齐才读得出检查器：
       `setSelection` 在页面还没列出来时会保持原选中（见 `rowFor` 的兜底规则），
       这里补一次「列表到了 → 再读一次」，否则这一屏会停在片段行或空态。
       注意要先过 `rowFor` 归一成**这一个面板认的 id**：宿主给的可能是裸定位串
       （`#caption`），直接拿去 inspect 会被当成片段域、落成 404 错误态。 */
    const selectedAt = rowFor(typeof deps.getSelectedAt === 'function' ? deps.getSelectedAt() : '');
    if (selectedAt !== '' && inspState.at !== selectedAt) void loadInspector(selectedAt);
  }

  function scrollSelectedIntoView() {
    const at = rowFor(deps.getSelectedAt());
    if (at === '') return;
    const row = layersBody.querySelector(`[data-at="${CSS.escape(at)}"]`);
    if (row instanceof HTMLElement) row.scrollIntoView({ block: 'nearest' });
  }

  /** 选中变化：高亮 + 滚动（画布点选走这条）。 */
  function setSelection(at) {
    if (destroyed) return;
    const target = rowFor(at);
    /* 未知 id（页面内部元素、或已消失的元素）不改高亮：画布点选由宿主直接给「所属片段行」。 */
    if (at !== '' && target === '') return;
    const page = layerState.page;
    const parentId = page === null ? '' : `#${page.clipId}`;
    const childOfPage = page !== null && String(target).startsWith(`${page.clipId}::`);
    /* 画布点到页面内部元素：把它的片段展开，否则这一行根本不在 DOM 里。 */
    if (childOfPage && layerState.expandedClip !== page.clipId) {
      layerState.expandedClip = page.clipId;
      renderLayers();
    }
    for (const row of layersBody.querySelectorAll('[data-testid="layer-row"]')) {
      const id = row.getAttribute('data-at');
      /* 子行选中时父行也点亮：树形展开态，不是「两个选中」。 */
      const active = id === target || (childOfPage && id === parentId);
      row.classList.toggle('active', active);
      row.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    if (target !== '') scrollSelectedIntoView();
    void loadInspector(target);
  }

  /* ── 元素检查器 ───────────────────────────────────────────────────── */

  /**
   * 渲染中标记：`innerHTML` 换掉带焦点的 input 会**同步**触发 blur，blur 里再进
   * `submitField` 就会在「外层还在删节点」时再改一次 innerHTML，浏览器直接抛
   * `NotFoundError: The node to be removed is no longer a child of this node`，
   * 面板跟着变空。渲染期间一律不接事件，事件里也先看节点还在不在文档里。
   */
  let rendering = false;

  function renderInspector() {
    if (destroyed) return;
    rendering = true;
    try {
      renderInspectorBody();
    } finally {
      rendering = false;
    }
  }

  function renderInspectorBody() {
    if (destroyed) return;
    inspectorTarget.textContent = inspState.at === '' ? '未选中' : inspState.at;
    root.setAttribute('data-busy', inspState.busy ? 'true' : 'false');

    if (inspState.at === '') {
      inspectorBody.innerHTML = `<p class="dock-empty" data-testid="inspector-empty">在画布或图层里选一个元素</p>`;
      return;
    }
    if (inspState.status === 'loading') {
      inspectorBody.innerHTML = `<div class="skeleton" data-testid="inspector-skeleton"><div class="sk-row"></div><div class="sk-row"></div><div class="sk-row"></div></div>`;
      return;
    }
    if (inspState.status === 'error') {
      inspectorBody.innerHTML = `
        <div class="dock-error" data-testid="inspector-error" data-code="${esc(inspState.error?.code ?? '')}">
          <strong>检查器读不出这个元素</strong>
          <p>${esc(inspState.error?.message ?? '未知错误')}</p>
          <button type="button" class="btn tiny" data-testid="inspector-retry">重试</button>
        </div>`;
      return;
    }
    if (inspState.groups.length === 0) {
      inspectorBody.innerHTML = `<p class="dock-empty" data-testid="inspector-empty">这个元素没有可显示的字段</p>`;
      return;
    }

    const groups = inspState.groups
      .map((group) => {
        const fields = (group.fields ?? [])
          .map((field) => {
            const category = CATEGORY_OF[field.key] ?? '外观';
            /* 页面内元素的 x/y/w/h 落不到 `set:box`（那会改页面片段自己的声明），所以只读；
               旋转/文本/排印/外观/裁剪都走 overrides，仍然可写。 */
            const boxInPage = inspState.scope === 'page' && field.key in BOX_KEYS;
            const disabled = field.editable !== true || boxInPage;
            const title =
              field.editable !== true
                ? '该字段只读（图层已锁定或该属性不可写）'
                : boxInPage
                  ? '页面内元素的位置尺寸由页面自身布局决定（几何只读；旋转/文本/样式可写）'
                  : `${field.label} · ${category}`;
            const value = field.value === null || field.value === undefined ? '' : String(field.value);
            const numeric = field.unit === 'px' || field.unit === 'deg' || field.unit === '无';
            const inputType = field.key === 'text' ? 'text' : numeric ? 'text' : 'text';
            return `<label class="field" data-testid="field-row" data-key="${esc(field.key)}" data-category="${esc(category)}">
              <span class="field-label" title="${esc(title)}">${esc(field.label)}</span>
              <input class="field-input" data-testid="field-input" type="${inputType}" value="${esc(value)}"
                data-unit="${esc(field.unit)}" ${disabled || inspState.busy ? 'disabled aria-disabled="true"' : ''}
                ${disabled ? `title="${esc(title)}"` : `title="${esc(value)}"`} />
              <span class="field-unit">${esc(field.unit === '无' ? '' : field.unit)}</span>
            </label>`;
          })
          .join('');
        return `<section class="group" data-group="${esc(group.id)}" data-testid="inspector-group">
          <h3>${esc(GROUP_LABEL[group.id] ?? group.id)}</h3>
          ${fields}
        </section>`;
      })
      .join('');

    const notice =
      inspState.notice === ''
        ? ''
        : `<div class="dock-status" data-testid="inspector-status">${esc(inspState.notice)}</div>`;
    inspectorBody.innerHTML = `${notice}<div class="groups" data-testid="inspector-groups">${groups}</div>`;
  }

  /**
   * @param {string} at 定位串：片段是 `#id`，页面元素是统一 id `<clipId>::<elementId>`
   * @param {{ scope: 'page'|'clip', element: string } | null} [explicit]
   *   R25 新增：跨页面片段读元素时**显式**给域与裸定位串。默认按 `layerState.page`
   *   （当前页面片段）推断 —— 那条路只对「正在编辑的那个页面」成立。
   */
  async function loadInspector(at, explicit = null) {
    inspState.at = at;
    inspState.notice = '';
    /* 页面子行：at 是统一 id，写回要的是页面元素自己的裸定位串（override 挂在页面片段）。
       片段行/未知 id：at 就是 film.html 的定位串，走片段域。 */
    const page = layerState.page;
    const pageChild = page === null ? undefined : page.layers.find((layer) => pageRowId(layer) === at);
    if (explicit !== null && explicit !== undefined) {
      inspState.element = explicit.element;
      inspState.scope = explicit.scope;
    } else if (pageChild !== undefined) {
      inspState.element = pageChild.id;
      inspState.scope = 'page';
    } else {
      inspState.element = at;
      inspState.scope = 'clip';
    }
    if (at === '') {
      inspState.status = 'idle';
      inspState.groups = [];
      renderInspector();
      return;
    }
    inspState.status = 'loading';
    renderInspector();
    const result = await deps.inspect(at);
    if (destroyed || inspState.at !== at) return;
    if (result?.ok !== true) {
      inspState.status = 'error';
      inspState.error = describeError(result);
      inspState.groups = [];
      renderInspector();
      return;
    }
    inspState.groups = Array.isArray(result.groups) ? result.groups : [];
    inspState.status = 'ready';
    inspState.error = null;
    renderInspector();
  }

  /**
   * 当前几何：优先片段自己的 `box` 声明；没有声明（首编辑）就用 inspect 读到的四个值拼，
   * 否则会拿 0 当宽高提交，被服务端 `w/h > 0` 拒掉。
   */
  function currentBox() {
    const declared = deps.getBox();
    /* 片段已声明 box：**整体**用它（同一声明空间），只替换被编辑的那一项。
       把「声明的宽」和「实测的高」混在一起提交，会被 film-core 的写回校验拒掉
       （实测：page 片段的 720 声明高混进 724 实测高 → UNKNOWN_FIELD 拒绝半写）。 */
    if (declared !== null && declared !== undefined) {
      const base = {
        x: Number(declared.x ?? 0),
        y: Number(declared.y ?? 0),
        w: Number(declared.w ?? 0),
        h: Number(declared.h ?? 0)
      };
      const r = Number(declared.r);
      return Number.isFinite(r) && r !== 0 ? { ...base, r } : base;
    }
    const fields = (inspState.groups ?? []).flatMap((group) => group.fields ?? []);
    const read = (key) => {
      const hit = fields.find((item) => item.key === key);
      const value = Number(hit?.value);
      return Number.isFinite(value) ? value : 0;
    };
    return { x: read('x'), y: read('y'), w: read('w'), h: read('h'), r: read('rotation') };
  }

  /**
   * 提交一个字段（S68：改走属性队列，按 (elementId, key) 合并 + 串行落盘）。
   *
   * 与修复前的差别只有两处，别的行为一个字节都不动：
   * 1. **乐观值**：先把面板里的值改成新值再发——于是「同一键、同一个值」的第二次
   *    Enter 是 no-op（S65 的 V3 断言「提交中不产生第二次写」仍然成立），
   *    但**新值**不会被 busy 静默吞掉；
   * 2. **失败只回滚这一次**：失败时把该字段恢复成提交前的值并就地报错，其余字段/图层不受影响。
   *
   * 拼包（`mergeOverridesAt` / `currentBox`）搬到了队列里：队列持有同步基座，
   * 不再读异步刷新的工程状态，所以后一次提交不会把前一次的键带走。
   */
  async function submitField(key, rawValue) {
    const field = (inspState.groups ?? [])
      .flatMap((group) => group.fields ?? [])
      .find((item) => item.key === key);
    if (!field || field.editable !== true) return;
    const value = String(rawValue);
    if (value === String(field.value ?? '')) return;

    /* 页面域：几何没有写入口（`set:box` 只会改页面片段自己的声明），就地挡住并说明原因。 */
    if (key in BOX_KEYS && inspState.scope === 'page') {
      showFieldError(key, '页面内元素的位置尺寸只读：改不了（旋转/文本/样式可以）');
      return;
    }

    /* 数值就地校验：宽高必须 > 0（服务端也会拒，先在界面挡住更清楚）。 */
    const numeric = Number(value);
    if ((key === 'w' || key === 'h') && (!Number.isFinite(numeric) || numeric <= 0)) {
      inspState.notice = '';
      showFieldError(key, '宽高必须大于 0');
      return;
    }
    /* R10：只拦「像 hex/rgb 但解析不了」的（`#zzz` / `rgb(999)`）；`white`/`red`/`hsl()`/`var()`
       一律放行交浏览器——判据与右列共用 `isColorRejected`，不各写一份。 */
    if (field.unit === '色值' && isColorRejected(value)) {
      showFieldError(key, `不是合法颜色：${value}`);
      return;
    }

    const previous = String(field.value ?? '');
    field.value = value;
    inspState.busy = true;
    inspState.notice = '';
    renderInspector();
    try {
      let result;
      if (key in BOX_KEYS) {
        result = await deps.commitBoxField({ key, value: numeric, fallback: currentBox() });
      } else if (key === 'rotation') {
        /* 旋转写 overrides 的 `r`：`set:box` 的 r 只落进 clip 的 style.rotate，
           describe 读不到（inspect 的 rotation 来自 override.r / 实测），读回会是 0。 */
        result = await deps.commitOverrideField({ at: inspState.element, key, patch: { r: numeric }, value: numeric });
      } else if (key === 'text') {
        result = await deps.commitOverrideField({ at: inspState.element, key, patch: { t: value }, value });
      } else {
        const built = patchForField(key, value, { box: currentBox() });
        if (built?.error) {
          field.value = previous;
          inspState.busy = false;
          renderInspector();
          showFieldError(key, built.error.message ?? '值不合法');
          return;
        }
        result = await deps.commitOverrideField({ at: inspState.element, key, patch: built.patch, value });
      }
      if (result?.ok !== true) {
        field.value = previous;
        inspState.busy = false;
        inspState.notice = '';
        renderInspector();
        showFieldError(key, describeError(result).message);
        return;
      }
      /* 写后重新 inspect 读回，把「提交值 vs 读回值」的比对结果写在面板上。
         页面域刚写完的那一次读可能拿到上一版页面（页面宿主按 hash 重载，读请求先到），
         不一致就隔 220ms 再读一次——只补读，不重发写。 */
      let readback = await deps.inspect(inspState.at);
      inspState.busy = false;
      if (readback?.ok !== true) {
        inspState.notice = `已写回（${String(result.hash ?? '').slice(0, 8)}），但读回失败`;
        renderInspector();
        return;
      }
      let after = (readback.groups ?? []).flatMap((group) => group.fields ?? []).find((item) => item.key === key);
      let same = valuesEqual(field.unit, String(after?.value ?? ''), value);
      if (!same) {
        await new Promise((done) => globalThis.setTimeout(done, 220));
        const again = await deps.inspect(inspState.at);
        if (again?.ok === true) {
          readback = again;
          after = (again.groups ?? []).flatMap((group) => group.fields ?? []).find((item) => item.key === key);
          same = valuesEqual(field.unit, String(after?.value ?? ''), value);
        }
      }
      inspState.groups = readback.groups ?? [];
      inspState.notice = same
        ? `已写回 · ${key} = ${String(after?.value ?? '')} · ${String(result.hash ?? '').slice(0, 8)}`
        : `已写回但读回不一致：提交 ${value} / 读回 ${String(after?.value ?? '')}`;
      renderInspector();
    } finally {
      inspState.busy = false;
      root.setAttribute('data-busy', 'false');
    }
  }

  /** 数字按 1e-3 容差比，其余按字符串比（服务端可能归一化，例如颜色）。 */
  function valuesEqual(unit, readback, submitted) {
    const a = Number(readback);
    const b = Number(submitted);
    if ((unit === 'px' || unit === 'deg') && Number.isFinite(a) && Number.isFinite(b)) {
      return Math.abs(a - b) <= 1e-3;
    }
    return readback.trim() === submitted.trim();
  }

  function showFieldError(key, message) {
    const row = inspectorBody.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (row === null) return;
    row.setAttribute('data-invalid', 'true');
    const existing = row.querySelector('[data-testid="field-error"]');
    if (existing !== null) existing.remove();
    const note = document.createElement('span');
    note.className = 'field-error';
    note.setAttribute('data-testid', 'field-error');
    note.textContent = message;
    row.appendChild(note);
    const input = row.querySelector('input');
    if (input !== null) {
      const field = (inspState.groups.flatMap((group) => group.fields ?? [])).find((item) => item.key === key);
      input.value = String(field?.value ?? '');
    }
  }

  /* ── 事件 ─────────────────────────────────────────────────────────── */

  const onClick = (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    /* E12-P1a：分类栏优先（它是本批唯一的新交互面）。 */
    const railTabBtn = target.closest('[data-rail-tab]');
    if (railTabBtn !== null) {
      setRailTab(railTabBtn.getAttribute('data-rail-tab') ?? 'layers');
      return;
    }
    const railMode = target.closest('[data-rail-mode]');
    if (railMode !== null) {
      setSubtitleMode(railMode.getAttribute('data-rail-mode') ?? 'file');
      return;
    }
    /* R38（E12-P3）：「新建文本」—— 在播放头处插一条。按钮在 renderText 里按
       「列表就绪 + 有页面片段」解禁；这里再挡一次（disabled 的按钮不会触发 click，双保险）。 */
    if (target.closest('[data-testid="rail-text-new"]') !== null) {
      void insertTextFromPlayhead();
      return;
    }
    /* E12-P3（R25）：文本元素行 —— 选中承载它的页面片段 + 这一层，右栏跟着显示「内容」。 */
    const textRow = target.closest('[data-testid^="rail-text-row-"]');
    if (textRow !== null) {
      selectTextRow(
        textRow.getAttribute('data-unified') ?? '',
        textRow.getAttribute('data-element') ?? '',
        textRow.getAttribute('data-clip') ?? '',
        /* E12-P3 B4c（R38）：行上 `data-start` 就是这一条所在页面片段的起点（秒）。 */
        Number(textRow.getAttribute('data-start') ?? '0'),
        /* R38：`page`（页面里的文字元素）/ `text`（film.html 根层的 text 片段）。 */
        textRow.getAttribute('data-scope') ?? 'page',
      );
      return;
    }
    /* E12-P6（R25）：转场的加 / 移除（写回走 M25 的同一套 plan*）。 */
    const transAction = target.closest('[data-rail-trans]');
    if (transAction !== null) {
      const what = transAction.getAttribute('data-rail-trans') ?? '';
      if (what === 'add') addTransition();
      else if (what === 'remove') removeTransition();
      return;
    }
    /* E12-P5（R34）：样式预设行 —— 只切高亮，写盘与重渲染在 App 侧。 */
    const railPreset = target.closest('[data-rail-preset]');
    if (railPreset !== null) {
      applyRailPreset(railPreset.getAttribute('data-rail-preset') ?? '');
      return;
    }
    /* E12-P5（R24）：字幕面板三个动作 —— 主按钮（选文件 / 加一条）、烧录开关、跳到时间线。 */
    const subAction = target.closest('[data-rail-subtitle]');
    if (subAction !== null) {
      const what = subAction.getAttribute('data-rail-subtitle') ?? '';
      if (what === 'primary') {
        if (subState.mode === 'playhead') {
          void addCueAtPlayhead();
          return;
        }
        const picker = host.querySelector('[data-testid="rail-subtitle-file"]');
        if (picker instanceof HTMLInputElement) picker.click();
        return;
      }
      if (what === 'burn') {
        subState.burn = !subState.burn;
        renderSubtitles();
        deps.bridge?.setBurn?.(subState.burn);
        return;
      }
      if (what === 'seek') {
        const row = subAction.closest('[data-cue-index]');
        const index = Number(row?.getAttribute('data-cue-index') ?? '-1');
        const cue = subState.cues[index];
        if (cue !== undefined) {
          subState.selected = index;
          renderSubtitles();
          deps.bridge?.seek?.(Number(cue.start));
        }
        return;
      }
    }
    /* 段行：点空白处也跳（输入框里的点击不算 —— 那是改文本）。 */
    const cueRow = target.closest('[data-cue-index]');
    if (cueRow !== null && !(target instanceof HTMLInputElement)) {
      const index = Number(cueRow.getAttribute('data-cue-index') ?? '-1');
      const cue = subState.cues[index];
      if (cue !== undefined) {
        subState.selected = index;
        renderSubtitles();
        deps.bridge?.seek?.(Number(cue.start));
      }
      return;
    }
    /* R71：「收藏」是开关（aria-pressed），开着只看收藏；关掉回全部。 */
    const favToggle = target.closest('[data-rail-favorite-toggle]');
    if (favToggle !== null) {
      mediaState.favoriteOnly = !mediaState.favoriteOnly;
      renderMedia();
      return;
    }
    /* R71：卡片右上角的星 —— 只改 localStorage，不动 film 文档、不进 /ops。 */
    const star = target.closest('[data-rail-media-star]');
    if (star !== null) {
      const card = star.closest('[data-testid="rail-media-card"]');
      const src = card === null ? '' : card.getAttribute('data-media-src') ?? '';
      if (src !== '') {
        if (mediaState.favorites.has(src)) mediaState.favorites.delete(src);
        else mediaState.favorites.add(src);
        saveFavorites(mediaState.projectId, mediaState.favorites);
        renderMedia();
        if (mediaState.favoriteOnly) deps.onNotice?.(`已${mediaState.favorites.has(src) ? '收藏' : '取消收藏'}：${src}`);
      }
      return;
    }
    /* E12-P2：素材类型筛选（tablist 的标准行为：点一下只换选中项，数据不动）。 */
    const mediaFilter = target.closest('[data-rail-media-filter]');
    if (mediaFilter !== null) {
      mediaState.filter = mediaFilter.getAttribute('data-rail-media-filter') ?? 'all';
      renderMedia();
      return;
    }
    /* R104 / U06（A20）：预览与「加入时间线」分开 —— 两条分支各管一件事，互不冒充。
       预览是纯展示浮层；加入复用宿主既有的插入链（onInsertAsset），本模块不写盘。 */
    const previewHit = target.closest('[data-media-preview]');
    if (previewHit !== null) {
      openMediaPreview(previewHit.getAttribute('data-media-preview') ?? '');
      return;
    }
    const previewClose = target.closest('[data-testid="rail-media-preview-close"]');
    if (previewClose !== null) {
      closeMediaPreview();
      return;
    }
    const previewOverlay = target.closest('[data-testid="rail-media-preview-overlay"]');
    if (previewOverlay !== null && previewClose === null) {
      /* 点浮层空白处 = 关（点内容区不关）。 */
      if (target === previewOverlay) closeMediaPreview();
      return;
    }
    const insertHit = target.closest('[data-media-insert]');
    if (insertHit !== null) {
      if (insertHit.getAttribute('data-unwired') === '1') return;
      const src = insertHit.getAttribute('data-media-insert') ?? '';
      const item = mediaState.items.find((one) => one.src === src);
      if (item === undefined) return;
      if (typeof deps.onInsertAsset !== 'function') {
        deps.onNotice?.('加入时间线：入口还没接线（等 MAIN 应用 R104 补丁）');
        return;
      }
      deps.onInsertAsset({ name: item.name, kind: item.kind, path: item.src });
      return;
    }
    /* U06：读取失败的重试只重拉列表（只读 GET），不是新的写路径。 */
    const mediaRetry = target.closest('[data-testid="rail-media-retry"]');
    if (mediaRetry !== null) {
      void refreshMedia();
      return;
    }
    /* 收藏按钮与筛选的行为在下面各自的 closest 分支里（保持原样）。 */
    /* 注意：整卡点击不再「给一句未接的话」——预览/加入是两颗明确的按钮，
       卡片本体不再是两件事混在一起的入口（U06 的 A20）。 */
    /* 「导入」接 M18：转发到工程栏那颗真的「导入素材」按钮，不自己复刻上传流程。 */
    const delegate = target.closest('[data-rail-delegate]');
    if (delegate !== null) {
      const selector = delegate.getAttribute('data-rail-delegate') ?? '';
      const real = selector === '' ? null : document.querySelector(`[data-testid="${selector}"]`);
      if (real instanceof HTMLElement && !(real instanceof HTMLButtonElement && real.disabled)) {
        real.click();
        return;
      }
      deps.onNotice?.('先在左侧「工程」里打开一个工程，再用「导入素材」');
      return;
    }
    /* 空壳主按钮：给一句「还没接数据」的 notice，不做假动作。 */
    const railAction = target.closest('[data-rail-action]');
    if (railAction !== null) {
      const text = railAction.getAttribute('data-rail-action') ?? '';
      if (text !== '') deps.onNotice?.(text);
      return;
    }
    const retry = target.closest('[data-testid="layers-retry"], [data-testid="layers-retry-inline"]');
    if (retry !== null) {
      void refreshLayers();
      return;
    }
    const retryInsp = target.closest('[data-testid="inspector-retry"]');
    if (retryInsp !== null) {
      void loadInspector(inspState.at);
      return;
    }
    /* R102 / U05：行尾的「眼 / 锁」。它们是按钮的**兄弟节点**（不嵌在 button 里，
       HTML 不允许嵌套按钮），所以先于行点击拦下来，别把一次显隐当成一次选中。 */
    const act = target.closest('[data-layer-act]');
    if (act !== null) {
      const at = act.getAttribute('data-at') ?? '';
      const kind = act.getAttribute('data-layer-act') ?? '';
      if (at === '' || act.getAttribute('data-unwired') === '1') return;
      const handler = kind === 'eye' ? deps.onToggleHidden : deps.onToggleLock;
      if (typeof handler === 'function') {
        handler(at);
        renderLayers();
      }
      return;
    }
    const row = target.closest('[data-testid="layer-row"]');
    if (row !== null) {
      const at = row.getAttribute('data-at') ?? '';
      /* 点页面片段行 = 展开它的页面元素（再点一次不收起：收起会让选中行消失）。 */
      const page = layerState.page;
      if (page !== null && at === `#${page.clipId}` && layerState.expandedClip !== page.clipId) {
        layerState.expandedClip = page.clipId;
        renderLayers();
      }
      /* 延迟一拍再选中：双击的第一下不该先改选中（定位明确不改选中）。 */
      if (pendingSelect !== 0) window.clearTimeout(pendingSelect);
      pendingSelect = window.setTimeout(() => {
        pendingSelect = 0;
        if (at !== '') deps.onSelect(at);
        setSelection(at);
      }, 220);
    }
  };

  const onDoubleClick = (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const row = target.closest('[data-testid="layer-row"]');
    if (row === null) return;
    if (pendingSelect !== 0) {
      window.clearTimeout(pendingSelect);
      pendingSelect = 0;
    }
    const at = row.getAttribute('data-at') ?? '';
    if (at === '') return;
    /* 定位**不改选中**：只让画布把该元素亮出来（行为写进测试）。 */
    root.setAttribute('data-locate', at);
    window.setTimeout(() => root.removeAttribute('data-locate'), 900);
    const located = layerState.layers.find((layer) => layer.id === at);
    deps.onLocate(at, located?.box ?? null);
  };

  const onSubmit = (event) => {
    if (rendering) return;
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.isConnected) return;
    const row = input.closest('[data-testid="field-row"]');
    if (row === null) return;
    event.preventDefault();
    row.removeAttribute('data-invalid');
    const stale = row.querySelector('[data-testid="field-error"]');
    if (stale !== null) stale.remove();
    void submitField(row.getAttribute('data-key') ?? '', input.value);
  };

  /**
   * 素材搜索：前端过滤，输入即生效。
   * 只重建 `.rail-media-grid` 的 innerHTML（输入框不在网格里），所以焦点与光标位置不丢。
   */
  const onInput = (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const testid = target.getAttribute('data-testid');
    /* 转场时长：只记值，不重画（重画会把光标顶掉；校验发生在点「加淡入淡出」时）。 */
    if (testid === 'rail-transition-dur') {
      transState.duration = target.value;
      return;
    }
    if (testid !== 'rail-media-search') return;
    mediaState.query = target.value;
    renderMedia();
  };

  const onBlur = (event) => {
    const input = event.target;
    if (rendering || !(input instanceof HTMLInputElement) || input.disabled || !input.isConnected) return;
    onSubmit(event);
  };

  /**
   * 字幕面板的两处「提交型」输入：
   * ① 文件选择（`change` 只在选完文件时来一次）；
   * ② 段文本（`change` = 失焦或回车，不是每次击键 —— 一次编辑只写一次盘）。
   * 两者都不在 `change` 里重建输入框本身（光标不丢）。
   */
  const onChange = (event) => {
    const target = event.target;
    /* 转场接缝：换一个选项只改「当前选中」（加/移除两颗按钮的可用性跟着变）。 */
    if (target instanceof HTMLSelectElement) {
      if (target.getAttribute('data-testid') === 'rail-transition-seam') {
        transState.pick = target.value;
        transState.error = '';
        transState.code = '';
        renderTransitions();
      }
      return;
    }
    if (!(target instanceof HTMLInputElement)) return;
    if (target.getAttribute('data-testid') === 'rail-subtitle-file') {
      const file = target.files?.[0] ?? null;
      /* 清空 value：同一个文件改完再导一次也要能触发 change。 */
      target.value = '';
      if (file !== null) void importSubtitleFile(file);
      return;
    }
    const textIndex = target.getAttribute('data-cue-text');
    if (textIndex !== null) {
      void commitCueText(Number(textIndex), target.value);
    }
  };

  /**
   * 分类栏的键盘行为：←/→ 在 6 个 tab 间移（tablist 标准）。
   * 只在焦点确实落在 tab 上时接管，别抢全局快捷键。
   */
  const onKeyDown = (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const tab = target.closest('[data-rail-tab]');
    if (tab === null) return;
    const ids = RAIL_TABS.map((item) => item.id);
    const at = ids.indexOf(tab.getAttribute('data-rail-tab') ?? '');
    if (at < 0) return;
    event.preventDefault();
    const next = ids[(at + (event.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
    setRailTab(next);
    const button = root.querySelector(`[data-rail-tab="${next}"]`);
    if (button instanceof HTMLElement) button.focus();
  };

  host.addEventListener('click', onClick);
  host.addEventListener('input', onInput);
  host.addEventListener('change', onChange);
  host.addEventListener('dblclick', onDoubleClick);
  host.addEventListener('submit', onSubmit);
  host.addEventListener('blur', onBlur, true);
  host.addEventListener('keydown', onKeyDown);
  host.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') onSubmit(event);
  });

  /* R104 / U06（A20）：封面加载两态就地改写（load/error 不冒泡 → 捕获阶段听）。
     只改卡片的 data-thumb-state，失败时 CSS 换成「封面不可用」那句话 —— 不破图、不假封面。 */
  host.addEventListener(
    'load',
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLImageElement)) return;
      if (target.getAttribute('data-testid') !== 'rail-media-thumb') return;
      const card = target.closest('[data-testid="rail-media-card"]');
      if (card !== null) card.setAttribute('data-thumb-state', 'ready');
    },
    true,
  );
  host.addEventListener(
    'error',
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLImageElement)) return;
      if (target.getAttribute('data-testid') !== 'rail-media-thumb') return;
      const card = target.closest('[data-testid="rail-media-card"]');
      if (card !== null) card.setAttribute('data-thumb-state', 'failed');
    },
    true,
  );

  /* 初始态：走一遍 setRailTab，保证「DOM 里写死的 aria-selected/hidden」与状态一致。 */
  setRailTab(railTab);

  renderLayers();
  renderInspector();
  if (deps.creationLibrary !== true) void refreshMedia();

  return {
    creationHost, creationLayerContent,
    /**
     * 重新拉图层（工程/片段/hash 变了时调用）。
     * R23：素材网格也在这时候重读 —— 导入/删除素材会改文档 hash，卡片必须跟着变。
     */
    refresh: () => {
      void refreshLayers();
      if (deps.creationLibrary === true) return;
      void refreshMedia();
      void refreshSubtitles();
      /* 文本 / 转场都吃文档：hash 变了必须重算，否则面板停在旧读数。
         但只在「这两个分类已经打开过」时重算 —— 文本要逐页面片段读页面域（每个一跳无头浏览器），
         没打开过的面板没必要为一次别的分类的写入付这个代价（也会在控制台刷 502 瞬态）。 */
      if (textState.status !== 'idle') void refreshText();
      if (transState.status !== 'idle') void refreshTransitions();
    },
    /** 外部选中变化（画布点击、时间线选中）同步进来。 */
    setSelection,
    /**
     * 预设高亮（R34）：宿主改了样式（检查器的六颗 / 打开工程读盘 / 撤销）时推过来。
     * 只动高亮，不写盘 —— 写盘只有一个方向：面板点击 → App。
     */
    setSubtitlePreset: (id) => {
      const next = String(id ?? 'default');
      if (next === subState.preset) return;
      subState.preset = next;
      renderSubtitlePresets();
    },
    /** 只刷新检查器（例如 doc 变了但选中没变）。 */
    reloadInspector: () => void loadInspector(inspState.at),
    /** 直接检查某个定位串（不经过列表）：元素不存在时走真实的 404 错误态。 */
    selectElement: (at) => void loadInspector(at),
    /** 页面 pageerror（来自 /api/layers 的 pageErrors）显示在顶部。 */
    setPageErrors(list) {
      layerState.pageErrors = Array.isArray(list) ? list : [];
      if (layerState.status === 'ready' || layerState.status === 'empty') renderLayers();
    },
    getState: () => ({ layers: layerState, inspector: inspState }),
    destroy() {
      destroyed = true;
      host.removeEventListener('click', onClick);
      host.removeEventListener('dblclick', onDoubleClick);
      host.removeEventListener('change', onChange);
      host.removeEventListener('submit', onSubmit);
      host.removeEventListener('blur', onBlur, true);
      host.removeEventListener('keydown', onKeyDown);
      host.innerHTML = '';
    }
  };
}
