/**
 * 检查器面板（副线1 · S10-INSPECTOR-BRIDGE）
 *
 * vanilla DOM 组件：不依赖 React，可被 React 壳用 ref 挂到容器上（`useEffect` 里 mount / 卸载时 destroy）。
 * 字段模型与最小 patch 全部来自 `inspector.ts`（`buildInspector` / `patchForField`），面板只负责：
 * 画字段、收输入、按顺序 preview → commit、把失败如实显示出来。
 *
 * ## 顺序（写死，不允许调用方颠倒）
 *
 *     film.frame(t)  →  apply-overrides(entries)  →  面板显示
 *
 * 面板自己的 `preview(patch)` 由宿主实现（宿主负责「合并成完整 entries → 在 frame 之后应用」）；
 * 面板不做 DOM 变换、不读 computed、不碰磁盘。
 *
 * ## 两条写入口（S13 起，互不污染）
 *
 * | 字段组 | patch 形状 | 宿主依赖 | 服务端 Op | 落点 |
 * |---|---|---|---|---|
 * | 文字 / 排版 / 外观 | `OverridePatch`（`t` / `style` / `lock`） | `preview` + `commit` | `overrides` | 片段的 `overrides` |
 * | 位置 / 尺寸 / 旋转 | `{op:'set', field:'box', value:{x,y,w,h,r?}}` | `previewBox` + `commitBox` | `set` | 片段的 `style`（`left/top/width/height/rotate`）|
 *
 * 几何字段**没有** `deps.commitBox` 时置灰（`data-locked-reason="NO_BOX_COMMITTER"`），
 * 不假装能改——这样主线只接一半时，用户看到的是「不可编辑」而不是「改了没保存」。
 *
 * ## 失败语义
 *
 * - `preview` 成功、`commit` 失败（409/400/网络）：**先把预览回滚**（`revertPreview`），
 *   再把 `currentHash`（409）或 `code`（400）显示出来。绝不把失败的预览留在画面上。
 * - 锁定层：字段 `disabled`，`commitField` 直接返回 `LOCKED`，不发请求。
 * - 成功：以**服务端返回的 hash** 为准（写进 `data-hash`），并重新取一次 describe +
 *   override，于是字段的 `data-source` 从 `computed` 变成 `override`。
 *
 * 真实落盘在 Studio 的 `/ops` + `FilmDocIo`：本模块只通过宿主注入的 `commit` 提交，
 * 自己不读写任何工程文件（`data-persist="real"` 表示「已接真实服务」，不是「本模块写盘」）。
 */
import { buildInspector, buildMultiInspector, patchForField, patchForBox, patchForBoxValue, normalizeBox, CUSTOM_OPTION, OBJECT_TABS } from './inspector-fields.mjs';
import { screenEditToBox, measuredPinHint, screenBoxToDeclared } from './geometry-space.mjs';
import { mountLayerTree } from './layer-tree.mjs';
/* R113 · L2（LI-A17/A18/A19）：效果栈的增删启停只调这一份纯函数（序列化在 inspector-adjust.mjs）。 */
import { EFFECT_DEFS, FADE_EDGES, FADE_MAX, FADE_MIN, effectPatch } from './inspector-adjust.mjs';
/* R125 · M11-A（LI-A20/A21）：六类蒙版的序列化/画布手势只在 inspector-mask.mjs 里（纯函数）。 */
import {
  MASK_DEFAULTS,
  MASK_PROP,
  MASK_RANGES,
  applyMaskGesture,
  formatMaskSpec,
  maskParamRows,
  maskPatch,
  parseMaskSpec
} from './inspector-mask.mjs';
/* R125 · M11-B（LI-A24）：四角裁切 / 换源的序列化也只在这一份。 */
import { CROP_CORNERS, CROP_PROP, cropPatch, mediaPatch, readCrop, readMedia } from './inspector-image.mjs';
/* S2H/R10：色值判据与左列 dock 共用同一个函数（`parseCssColor` 只认 hex/rgb，不能直接当「非法」用）。 */
import { isColorRejected } from './subtitle-style.mjs';

export const PANEL_STAGE = 'frame → apply-overrides → panel';
export const PANEL_MODES = Object.freeze(['single', 'multi']);
/** 真实持久化态：提交走 Studio `/ops`（成功即已落盘）；本模块仍不碰文件。 */
export const PANEL_PERSISTENCE = 'real';
/** @deprecated S11 起不再是面板状态；保留常量只为兼容旧引用。 */
export const WAIT_MAIN_IO = 'WAIT_MAIN_IO';

const NUMERIC_UNITS = new Set(['px', 'deg']);

/**
 * 字体候选（datalist 只是**候选**，不限制自填；缺字体由 describe 的 `fontCheck` 提示，不由这里判）。
 * 只列中英常见 + 通用族 —— 具体机器上有没有，是 `document.fonts.check` 的事。
 */
const COMMON_FONTS = Object.freeze([
  'system-ui',
  'sans-serif',
  'serif',
  'monospace',
  'PingFang SC',
  'Hiragino Sans GB',
  'Microsoft YaHei',
  'Noto Sans SC',
  'Source Han Sans SC',
  'Inter',
  'Helvetica Neue',
  'Arial'
]);

/** 四边渐隐的四个边（输入框 aria-label 与提示用）。 */
const EDGE_LABEL = Object.freeze({ top: '上', right: '右', bottom: '下', left: '左' });

/** 不可编辑原因码 → 人话（hover 的 title 与可见角标都用这份）。 */
export const PANEL_REASONS = Object.freeze({
  LOCKED: '有层已锁定：多选里只要有一层锁定，几何字段就整组不可编辑（一个字节都不写）',
  NO_COMMITTER: '宿主没提供批量提交口 deps.commitMany（一批 op、一步撤销）',
  MULTI_MIXED: '各层角度不一致：多选下不批量改角度（每层自己的角度算内容）',
  FIELD_UNSUPPORTED: '有层没有这个字段（例如不是文本层），套上去没有意义',
  /* R113 · L2：两条「有值但结构化不了」的原因 —— 不静默清空，也不假装是空值。 */
  FILTER_CUSTOM: '这一段 filter 是手写的（解析不了）：调色不改它，请到「滤镜」里改原文',
  EFFECT_CUSTOM: '这个效果是手写的（解析不了）：只能整条删除，参数请到「滤镜 / 高级」里改'
});

/**
 * 写入口拒绝里的「目标失效」码（R143 · M14-R2 · A3）。
 *
 * 这些码的共同点：**再改也不会成功**，得先重新选一层/把父级放回画面。
 * 面板据此禁用控件并给下一步；`LAYER_GONE` 是 describe 侧的同义状态（读不到这一层）。
 * 注意：UI 禁用 ≠ 写入口保护 —— 真正的拒绝在服务端（`film-core/element-guard.mjs`）。
 */
const TARGET_INVALID_CODES = new Set([
  'ELEMENT_GONE',
  'ELEMENT_REPLACED',
  'ELEMENT_UNMOUNTED',
  'STALE_EPOCH',
  'FOREIGN_PROJECT',
  'REBUILD_EXHAUSTED',
  'PAGE_UNREADABLE',
  'LAYER_GONE'
]);

/** 每个码给一句「下一步做什么」，不是复述错误。 */
const TARGET_INVALID_HINT = Object.freeze({
  ELEMENT_GONE: '元素已不在这一帧里。重新选一层再改；旧选择器不会套到同名元素上。',
  ELEMENT_REPLACED: '这一层已经被换成新节点（同一选择器指向了别的内容）。确认后再重选这一层。',
  ELEMENT_UNMOUNTED: '元素还在页面源码里，但父级已卸载（hidden / display:none / template）。先把父级放回画面。',
  STALE_EPOCH: '这次提交带的是旧的选择代数。重选这一层再提交。',
  FOREIGN_PROJECT: '目标属于另一个工程。切回那个工程再改。',
  REBUILD_EXHAUSTED: '页面一直在重建，连续多次都没对上。等重建结束后重选这一层。',
  PAGE_UNREADABLE: '页面源码读不到或不完整，写入口拒绝在半个树上判断。',
  LAYER_GONE: '元素已不在这一帧里。重新选一层再改。'
});

/**
 * R113 · L2 的局部样式（只挂 `.insp-*`，**不写 styles.css** —— 那个文件归 MAIN）。
 * 段标题 / 行内提示 / 效果栈行 / 混合模式矩阵四处用得到。
 */
const INSPECTOR_CSS_ID = 'r113-l2-inspector-css';
const INSPECTOR_CSS = `
.film-inspector .insp-sub { margin: 6px 0 2px; padding: 0 2px; font-size: 10px; letter-spacing: .04em; color: var(--text-mute, #8f8f99); text-transform: none; }
.film-inspector .insp-note { margin: 1px 0 4px 2px; font: 10px/1.4 ui-monospace, Menlo, monospace; color: #ffb86b; white-space: normal; overflow-wrap: anywhere; }
.film-inspector .insp-note[data-note="clipped"] { color: #ff9a9a; }
.film-inspector .insp-eff { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.film-inspector .insp-eff-head { display: flex; align-items: center; gap: 4px; min-width: 0; }
.film-inspector .insp-eff-state { flex: 0 0 auto; padding: 0 4px; border-radius: 3px; border: 1px solid var(--line, #2a2a30); font-size: 10px; color: var(--text-mute, #8f8f99); }
.film-inspector .insp-eff[data-state="custom"] .insp-eff-state,
.film-inspector .insp-eff[data-state="mixed"] .insp-eff-state { color: #ffb86b; border-color: #6b5220; }
.film-inspector .insp-eff-btn { flex: 0 0 auto; height: 18px; padding: 0 4px; font: 10px/18px inherit; color: inherit; background: rgba(255,255,255,.05); border: 1px solid var(--line, #2a2a30); border-radius: 3px; cursor: pointer; }
.film-inspector .insp-eff-btn:disabled { opacity: .45; cursor: default; }
.film-inspector .insp-eff-params { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-width: 0; }
.film-inspector .insp-eff-params input { width: 52px; min-width: 0; }
.film-inspector .insp-eff-params input[data-role="color"] { width: 92px; }
.film-inspector .insp-eff-note { font-size: 10px; color: var(--text-mute, #8f8f99); }
.film-inspector .insp-eff-order { margin: 1px 0 3px 2px; font-size: 10px; color: var(--text-mute, #8f8f99); }
/* —— R125 · M11-A：蒙版 —— */
.film-inspector .insp-mask { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.film-inspector .insp-mask-head { display: flex; align-items: center; gap: 4px; min-width: 0; }
.film-inspector .insp-mask-state { flex: 0 0 auto; padding: 0 4px; border-radius: 3px; border: 1px solid var(--line, #2a2a30); font-size: 10px; color: var(--text-mute, #8f8f99); }
.film-inspector .insp-mask[data-mask-state="custom"] .insp-mask-state { color: #ffb86b; border-color: #6b5220; }
.film-inspector .insp-mask-row { display: grid; grid-template-columns: 46px minmax(0, 1fr) 18px; align-items: center; gap: 4px; min-width: 0; }
.film-inspector .insp-mask-label { font-size: 10.5px; color: var(--text-dim, #b9b9c3); }
.film-inspector .insp-mask-unit { font-size: 9.5px; color: var(--text-mute, #8f8f99); }
.film-inspector .insp-mask-invert { display: flex; align-items: center; gap: 4px; font-size: 10.5px; color: var(--text-dim, #b9b9c3); }
.film-inspector .insp-mask-canvas { position: relative; height: 92px; margin-top: 3px; border: 1px solid var(--line, #2a2a30); border-radius: 3px; overflow: hidden; background: rgba(255, 255, 255, .03); touch-action: none; }
/* R147 · M16：形状旋转后轴对齐包围盒会超出画布，overflow:hidden 把右下角缩放手柄一起裁掉
   → 手柄在屏幕上「在」但 elementFromPoint 命不中（M12 的 HANDLE_NOT_HITTABLE）。
   改成 overflow:clip + 10px 余量：蒙版本体仍旧裁在画布里，手柄多出来的那几像素还能点到。
   clip 不被支持时上面那条 hidden 仍然生效。 */
.film-inspector .insp-mask-canvas { overflow: clip; overflow-clip-margin: 10px; }
.film-inspector .insp-mask-box { position: absolute; box-sizing: border-box; border: 1px solid var(--accent, #5b9dff); background: rgba(91, 157, 255, .12); cursor: move; }
.film-inspector .insp-mask-grip { position: absolute; right: -2px; bottom: -2px; width: 10px; height: 10px; border-radius: 2px; background: var(--accent, #5b9dff); cursor: nwse-resize; }
.film-inspector .insp-mask-rotor { position: absolute; left: calc(50% - 5px); top: -15px; width: 10px; height: 10px; border-radius: 50%; background: var(--accent, #5b9dff); cursor: grab; }
.film-inspector .insp-mask-apply { position: absolute; right: 3px; top: 3px; display: none; gap: 3px; }
.film-inspector .insp-mask-apply[data-dirty="1"] { display: flex; }
/* —— R143 · M14-R2（A3）：目标失效时的禁用态 + 可解释提示 ——
   只挂 .insp-*；styles.css 归 MAIN。禁用是**提示**，不是保护：
   真正的拒绝在写入口（element-guard），这里只负责别让用户继续对着空气改。 */
.film-inspector .insp-target-invalid { grid-column: 1 / -1; display: block; margin: 2px 0 6px; padding: 5px 6px; border: 1px solid #6b2a2a; border-radius: 3px; background: rgba(255, 90, 90, .08); font-size: 10.5px; line-height: 1.45; color: #ffb4b4; white-space: normal; overflow-wrap: anywhere; }
.film-inspector .insp-target-invalid code { font-family: ui-monospace, Menlo, monospace; color: #ffd7a1; }
.film-inspector .insp-target-invalid .insp-target-invalid-tail { display: block; margin-top: 2px; color: var(--text-mute, #8f8f99); }
.film-inspector[data-target-invalid="1"] .inspector-group input,
.film-inspector[data-target-invalid="1"] .inspector-group select,
.film-inspector[data-target-invalid="1"] .inspector-group textarea,
.film-inspector[data-target-invalid="1"] .inspector-group button { opacity: .45; }
/* —— R121 · M7-B（D02）：对象页签 ——
   R158：页签条搬到容器外的 .r158-insp-head（检查器第一行），所以这四条**不带 .film-inspector 前缀**；
   类名只在本面板用，样式不泄露到别处。 */
.insp-objtabs { display: flex; gap: 2px; margin: 1px 0 5px; padding: 0 1px; flex-wrap: nowrap; }
.film-inspector .insp-object-name { height: 16px; margin: 0 1px 3px; font-size: 11px; line-height: 16px; color: var(--text-dim, #b9b9c3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.insp-objtab { flex: 1 1 0; min-width: 0; height: 20px; /* ST14：padding 8/10 在现列（248 列 − 头部预留 64）会把 5 个页签压成省略号（实测每签 30px、文字需 39px）→ 保留 2px；字号/字重按 ST13。 */ padding: 0 2px; font-size: 11.5px; font-weight: 500; line-height: 18px; color: var(--text-dim, #b9b9c3); background: transparent; border: 1px solid transparent; border-radius: 3px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.insp-objtab:hover { color: var(--text, #f2f2f5); }
/* UI-V4-06：选中态从「整块反白」改成 accent 下划线（2px，画在 inset 里，不占高度）。
   六个页签的盒模型完全一致（同样 20px 高 + 1px 透明边框），基线不会因为选中而跳。 */
.insp-objtab[aria-selected="true"] { color: var(--text, #f2f2f5); border-color: transparent; background: transparent; box-shadow: inset 0 -2px 0 var(--accent, #00c1cd); font-weight: 600; }
/* 元素/片段：**次级**切换（同一套 tab 类，只降字号/高度，不改行为）。 */
.insp-tabs.secondary .insp-tab { height: 20px; font-size: 11px; line-height: 18px; padding: 0 6px; }
/* 「覆盖」小签：**只有覆盖行**多一列 9px（其余行栅格一个像素不动），行高仍是 30。
   之前把「实测」挂在每一行的第 4 格 → 换行 → 带单位的行高 70.78。 */
.film-inspector .inspector-field[data-has-source-chip="1"] { grid-template-columns: var(--of-w-prefix) minmax(0, 1fr) minmax(32px, max-content) 9px; }
.film-inspector .inspector-field[data-has-source-chip="1"] .inspector-field-source { font-size: 9.5px; line-height: 1; writing-mode: vertical-rl; text-align: center; }
.film-inspector .insp-blend { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px 4px; margin: 1px 0 4px 2px; }
.film-inspector .insp-blend-item { display: flex; align-items: center; gap: 3px; min-width: 0; font-size: 10px; color: var(--text-mute, #8f8f99); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.film-inspector .insp-blend-item[data-capability="passthrough"] { color: #ff9a9a; }
.film-inspector .insp-blend-dot { flex: 0 0 auto; width: 5px; height: 5px; border-radius: 50%; background: #4ade80; }
.film-inspector .insp-blend-item[data-capability="needs-backdrop"] .insp-blend-dot { background: #facc15; }
.film-inspector .insp-blend-item[data-capability="passthrough"] .insp-blend-dot { background: #ff9a9a; }

/* ── R158 · 检查器信息架构（用户 12:04 三条）────────────────────────────
   ① 「图层 / 锁定当前层」从检查器移除：那一行是 App 画的（views.ts），本批不改那个文件，
      由面板给它打 data-r158-legacy-layer 再隐藏；锁能力仍在左树行尾（stage-dock）。
   ② 片段段默认只留「外观」里的淡入淡出，其余分组收进「高级」（JS 注入的 details，
      见 installAdvanced；只隐藏，不改 handler/字段/只读语义）。
   ③ 五页签顶到面板顶部：页签条挪进 .r158-insp-head（挂在 App 的 layer-picker 之前），
      「元素/片段」不再占一行 —— 变成右上角的小号 chip（仍是可点的 tab，不删功能）。 */
.inspector { position: relative; }
[data-r158-legacy-layer="1"] { display: none !important; }
.inspector > .insp-tabs[data-r158-chip="1"] {
  position: absolute; top: 13px; right: 12px; z-index: 4;
  width: auto; max-width: 96px; gap: 2px; padding: 0; background: transparent;
}
.inspector > .insp-tabs[data-r158-chip="1"] .insp-tab {
  flex: 0 0 auto; min-width: 0; height: 16px; padding: 0 4px;
  font-size: 9.5px; line-height: 14px; border-radius: 8px; opacity: .78;
}
.inspector > .insp-tabs[data-r158-chip="1"] .insp-tab:hover { opacity: 1; }
.inspector > .insp-tabs[data-r158-chip="1"] .insp-tab.active { opacity: 1; }
.r158-insp-head { margin: 0 0 4px; }
.r158-insp-head[data-empty="1"] { display: none; }
.r158-insp-head .insp-objtabs { padding-right: 64px; }
/* ② 片段段的组顺序：外观 → 高级开关 → 其余组。
   展开时新增内容出现在开关**下面**（不加 order 会跑到开关上面，看着像开关没生效）。 */
.inspector-seg-clip .ig { display: flex; flex-direction: column; }
.inspector-seg-clip .ig > .ig-caption,
.inspector-seg-clip .ig > .ig-locked-banner { order: 0; }
.inspector-seg-clip .ig > [data-clip-group="appearance"] { order: 1; }
.inspector-seg-clip .ig > [data-r158-advanced] { order: 2; }
.inspector-seg-clip .ig > [data-clip-group]:not([data-clip-group="appearance"]) { order: 3; }
/* 高级收起时：只留外观组与其中一行「淡入淡出」 */
.inspector-seg-clip:not([data-advanced-settings]) .ig:not([data-r158-advanced-open="1"]) > [data-clip-group]:not([data-clip-group="appearance"]) { display: none; }
.inspector-seg-clip:not([data-advanced-settings]) .ig:not([data-r158-advanced-open="1"]) [data-clip-field="attrs"],
.inspector-seg-clip:not([data-advanced-settings]) .ig:not([data-r158-advanced-open="1"]) [data-clip-field="link"],
.inspector-seg-clip:not([data-advanced-settings]) .ig:not([data-r158-advanced-open="1"]) [data-clip-field="color"],
.inspector-seg-clip:not([data-advanced-settings]) .ig:not([data-r158-advanced-open="1"]) [data-clip-field="opacity"] { display: none; }
.r158-adv { margin: 8px 0 0; border-top: 1px dashed var(--line-soft, #2a2a30); padding-top: 6px; }
.r158-adv-head { cursor: pointer; }
.r158-adv-head .ig-title { font-size: var(--fs-sm); font-weight: 600; color: var(--text-dim, #b9b9c3); }
.r158-adv-head .ig-count { margin-left: 6px; font-size: 10px; color: var(--text-mute, #8f8f99); }
.r158-adv-note { margin: 4px 2px 0; font-size: 10.5px; line-height: 1.45; color: var(--text-mute, #8f8f99); }

/* —— R165 · INSP：两级分类（对象 → 组 → 字段） ——
   组变成可折叠的 details：summary 吸顶、带箭头与字段数；默认展开（字段一个不少）。
   只改外观与折叠，不改字段/handler/只读语义。 */
/* —— ST1 样式批（ST18）：分组从「厚卡片」弱化成「section + 单条下边界」。
   只动 border / background / radius / 下内边距：滚动容器、吸顶、字段行与命中一律不动。
   summary 仍是吸顶，底色换成与检查器同层的 --panel（不能透明，否则滚动时内容会透出来）。 */
.film-inspector .inspector-group { padding: 0 10px 12px; border-bottom: 1px solid var(--line); }
.film-inspector .inspector-group:last-child { border-bottom: 0; }
.film-inspector .inspector-group > summary.inspector-group-label {
  display: flex; align-items: center; gap: 6px;
  margin: 0 -10px 4px; padding: 7px 10px;
  position: sticky; top: 0; z-index: 2;
  background: var(--panel); border-radius: 0;
  cursor: pointer; list-style: none;
  /* ST15：12/600 保留，取消额外 .08em 字距（继承 body 的 -.006em）。 */
  font-size: var(--fs-sm); font-weight: 600; letter-spacing: normal;
  text-transform: uppercase; color: var(--text-mute);
}
.film-inspector .inspector-group > summary::-webkit-details-marker { display: none; }
.film-inspector .inspector-group > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.film-inspector .insp-group-chevron {
  flex: 0 0 auto; width: 7px; height: 7px;
  border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor;
  transform: rotate(-45deg); transition: transform .12s ease;
}
.film-inspector .inspector-group[open] > summary .insp-group-chevron { transform: rotate(45deg); }
.film-inspector .insp-group-count { margin-left: auto; font-size: 10.5px; font-weight: 500; opacity: .75; }
.film-inspector .inspector-group:not([open]) { padding-bottom: 0; }
.film-inspector .inspector-group > summary:hover { color: var(--text-dim); }

/* 对象头一行：有下拉时名称由下拉自己显示（名称 · id），下面重复名的那行让位；
   没有下拉（片段域）时仍保留名称行。 */
.film-inspector[data-object-head="picker"] .insp-object-name { display: none; }

/* Inspector field layout follows the actual panel width, independent of the agent pane. */
.film-inspector .insp-fields-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  container: inspector-fields / inline-size;
  gap: 4px 6px;
  padding-block: 5px 9px;
}
.film-inspector .insp-fields-grid > * { grid-column: 1 / -1; min-width: 0; }
.app .inspector .film-inspector .insp-fields-grid > .inspector-field {
  display: grid;
  grid-template-columns: minmax(48px, 24%) minmax(0, 1fr);
  align-items: center;
  gap: 3px 6px;
  min-width: 0;
  min-height: 26px;
  height: auto;
  padding: 0;
}
.app .inspector .film-inspector .insp-fields-grid > .inspector-field:where(:has(> .inspector-field-unit)) {
  grid-template-columns: minmax(48px, 24%) minmax(0, 1fr) auto;
}
.app .inspector .film-inspector .insp-fields-grid .inspector-input {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  height: 26px;
  border-radius: 4px;
  font-family: inherit;
  font-size: var(--of-fs-field, 11.5px);
  font-variant-numeric: tabular-nums;
}
.film-inspector .insp-fields-grid .inspector-field-label-cell { min-width: 0; gap: 4px; }
.film-inspector .insp-fields-grid .inspector-field-label { font-size: 11px; }
.film-inspector .insp-fields-grid .inspector-field-unit { color: var(--text-mute); font-size: 10px; }
.film-inspector .insp-fields-grid .inspector-field-space { display: none; }
.film-inspector .insp-fields-grid .inspector-field-source {
  flex: 0 0 4px; width: 4px; height: 4px; padding: 0;
  border: 0; border-radius: 50%; background: var(--accent);
  overflow: hidden; text-indent: 12px;
}
.film-inspector .insp-fields-grid .insp-color-swatch {
  flex: 0 0 10px; height: 10px; border-radius: 2px;
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / 22%);
}
.film-inspector .insp-fields-grid .inspector-custom { grid-column: 2 / -1; }
.app .inspector .film-inspector .insp-fields-grid > [data-control-kind='grade'],
.app .inspector .film-inspector .insp-fields-grid > .inspector-field:has(> .insp-opacity-range) {
  grid-template-columns: minmax(48px, 24%) minmax(0, 1fr) 48px;
}
.film-inspector .insp-fields-grid .insp-opacity-range {
  grid-column: 2; grid-row: 1; width: 100%; min-width: 0;
  accent-color: var(--accent); margin: 0;
}
.film-inspector .insp-fields-grid [data-field='opacity']:has(> .insp-opacity-range) > .inspector-input {
  grid-column: 3; grid-row: 1;
}
.app .inspector .film-inspector .insp-fields-grid > :is([data-control-kind='corners'], [data-control-kind='inset']) {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}
.film-inspector .insp-fields-grid :is([data-control-kind='corners'], [data-control-kind='inset']) > .inspector-field-label-cell {
  grid-column: 1 / -1;
}
.film-inspector .insp-fields-grid [data-control-kind='inset'] > .inspector-field-label-cell { grid-column: 1 / 4; grid-row: 1; }
.film-inspector .insp-fields-grid .inspector-inset-part { grid-row: 2; }
.film-inspector .insp-fields-grid .inspector-range { width: 100%; min-width: 0; }
.film-inspector .insp-fields-grid .inspector-inset-unit { grid-column: 4; grid-row: 1; }
@container inspector-fields (min-width: 198px) {
  .app .inspector .film-inspector .insp-fields-grid > :is([data-field='x'],[data-field='y'],[data-field='w'],[data-field='h']) {
    grid-column: span 1;
    grid-template-columns: max-content minmax(0, 1fr) auto;
    column-gap: 4px;
  }
}
@container inspector-fields (min-width: 234px) {
  .app .inspector .film-inspector .insp-fields-grid > :is([data-field='fontWeight'],[data-field='letterSpacing'],[data-field='lineHeight'],[data-field='fontSize']) {
    grid-column: span 1;
    grid-template-columns: max-content minmax(0, 1fr) auto;
    column-gap: 4px;
  }
}

`;
function ensureInspectorCss(/** @type {Document} */ doc) {
  if (!doc || typeof doc.getElementById !== 'function') return;
  if (doc.getElementById(INSPECTOR_CSS_ID) !== null) return;
  const node = doc.createElement('style');
  node.id = INSPECTOR_CSS_ID;
  node.textContent = INSPECTOR_CSS;
  (doc.head ?? doc.documentElement).appendChild(node);
}

/**
 * S2H 的旧文案（历史常量，仍被交接文档与老探针 s67/s130 引用）。
 *
 * **B02（R108）起不再拦**：页面内元素的 x/y/w/h 现在真的能写——写的是**元素自己**的
 * `left/top/width/height`（overrides 的 `style`，与这个面板里旋转/文本/样式同一条
 * `deps.commit` 链），不是片段的 `set:box`。旧行为（整组只读）见 BATCH-SUB1-R31-061 §2；
 * 改判依据见 BATCH-SUB1-R108-B2 §1 与 A25（「不是改片段 box 冒称」）。
 */
export const PAGE_GEOMETRY_MESSAGE = '页面内元素的位置尺寸只读：改不了（旋转/文本/样式可以）';

/** 页面域几何的字段 id（与 `stage-dock.mjs` 的 `BOX_KEYS` 同一组：不含 rotation）。 */
const PAGE_GEOMETRY_FIELDS = new Set(['x', 'y', 'w', 'h']);

/**
 * B02（R108 / A25、A26、A27）：页面内元素几何 → **元素自己的 CSS 声明**。
 *
 * 为什么不是 `set:box`：那是片段自己的 `left/top/width/height`，对页面内元素发出去会挪整页
 * （A25 明写「不是改片段 box 冒称」）。这里改走 overrides 的 `style`（白名单字段，任意 CSS 映射），
 * 由页内 `applyOverrideEntries` 落到元素内联声明上 —— 与旋转（`r`）、文本（`t`）、
 * 其余样式**同一条** `deps.commit` 链，所以「一个键 = 一批 op = 一步撤销」照旧成立。
 */
/** @type {Readonly<Record<string, string>>} */
export const ELEMENT_GEOMETRY_STYLE = Object.freeze({ x: 'left', y: 'top', w: 'width', h: 'height' });

/** 写元素几何时给人看的说明（行 title / 状态行）。 */
export const ELEMENT_GEOMETRY_MESSAGE =
  '写元素自己的 left/top/width/height（overrides.style，走 /ops，一步撤销）；不是改片段 box';

/**
 * 越界钳制（B02 / A25）：负坐标 → 0；宽高 ≤ 0 → 1；超舞台 → 收进舞台。
 *
 * 「舞台」= 页面自己的视口（`describe().viewport`，页内文档 `clientWidth/clientHeight`），
 * 与 `box`/`left`/`top` 同一个坐标系。判的是**这个值本身**越没越界，不是「整块必须装得下」：
 * `x ∈ [0, W−1]`、`y ∈ [0, H−1]`、`w ∈ [1, W]`、`h ∈ [1, H]`。
 * 故意留一半在舞台外是常见设计（滑入/滑出），所以不把元素往里赶。
 *
 * 纯函数（不碰 DOM），返回 `{ value, note }` 或 `{ error }`；`note` 只在真钳过时给，
 * 由面板写进就地提示（`data-hint=CLAMPED`）。
 *
 * @param {string} fieldId 'x' | 'y' | 'w' | 'h'
 * @param {number|string} raw 用户输入
 * @param {{w?:number,h?:number}} [viewport] 页面视口；缺/非正数时**不做**上限钳制（只钳下界）
 * @returns {{value?: number, note?: string, error?: string}}
 */
export function clampElementGeometry(fieldId, raw, viewport) {
  const value = Number(String(raw ?? '').trim());
  if (!Number.isFinite(value)) return { error: `不是数字：${JSON.stringify(String(raw ?? ''))}` };
  const vw = Number(viewport?.w);
  const vh = Number(viewport?.h);
  const hasW = Number.isFinite(vw) && vw > 0;
  const hasH = Number.isFinite(vh) && vh > 0;
  /** @param {number} n */
  const round2 = (n) => Math.round(n * 100) / 100;

  if (fieldId === 'x' || fieldId === 'y') {
    const stage = fieldId === 'x' ? vw : vh;
    const has = fieldId === 'x' ? hasW : hasH;
    if (value < 0) return { value: 0, note: `${fieldId.toUpperCase()} 不能是负数：${value} → 0` };
    if (has && value > stage - 1) return { value: round2(stage - 1), note: `${fieldId.toUpperCase()} 超出舞台 ${stage}px：${value} → ${round2(stage - 1)}` };
    return { value };
  }

  if (fieldId === 'w' || fieldId === 'h') {
    const stage = fieldId === 'w' ? vw : vh;
    const has = fieldId === 'w' ? hasW : hasH;
    const cn = fieldId === 'w' ? '宽' : '高';
    if (value <= 0) return { value: 1, note: `${cn}必须大于 0：${value} → 1` };
    if (has && value > stage) return { value: stage, note: `${cn}超出舞台：${value} → ${stage}` };
    return { value };
  }

  return { error: `不是几何字段：${fieldId}` };
}


/**
 * 会话内的分组折叠状态。
 * 放在模块级：面板重挂/重选都还在（同一页面会话），**刷新页面 = 重新加载模块 = 回到默认展开**。
 * 不写 localStorage、不写盘。
 */
const GROUP_COLLAPSED = new Set();

/**
 * @typedef {object} InspectorPanelDeps
 * @property {boolean} [externalTabs] Host supplies the object tabs and advanced section.
 * @property {(ref: any) => Promise<any>} describe        运行时 describe（返回 {box,style,locked,text} 或 {error}）
 * @property {(at: string) => any} [overrideOf]           该层当前的 OverridePatch（无则 null）
 * @property {() => string} [hashOf]                      App 当前的 doc hash（提交/撤销都会更新；对账用）
 * @property {(at: string) => any} [boxOf]                该片段**声明**的 box（`{x,y,w,h,r?}`）；没有就返回 null
 * @property {(at: string) => Promise<any>} [geometry]    祖先坐标系（`readGeometrySpace`）：给了就把几何输入当**屏幕像素**，
 *                                                        提交前换算成声明值；不给则与 R7 一致（输入即声明值）
 * @property {(patch: any) => Promise<any>} preview       预览：宿主合并进完整 entries 并在 frame 之后应用
 * @property {(op: any) => Promise<any>} [previewBox]     预览几何：宿主把 `set box` 的 value 应用到舞台副本
 * @property {() => Promise<any>} [revertPreview]         回滚预览到提交前
 * @property {(patch: any) => Promise<any>} commit        提交：宿主发一个 overrides Op
 * @property {(op: any) => Promise<any>} [commitBox]      提交几何：宿主发一个 `set`（field:'box'）Op
 * @property {(jobs: any[]) => Promise<any>} [commitMany] 批量提交（S26）：一次请求、**一步撤销**。
 *   job 形状：`{ref, kind:'box', op}` 或 `{ref, kind:'overrides', patch}`；宿主把每个 job 翻成一条 op
 *   （`set` / `overrides`），用 `ops-client.commitOps([…])` 发**同一次** `/ops`。
 * @property {(jobs: any[]) => Promise<any>} [previewMany] 批量预览（可选）：多选改值时先打到舞台副本
 * @property {(info: {currentHash?: string, message?: string}) => void} [onConflict]
 * @property {string} [expectedHash]
 * @property {InspectorTreeDep} [tree]                    可选图层树（S18）。传了就在面板上方渲染树，没传与 R8 完全一致
 */

/**
 * 可选图层树依赖（S18）：形状就是 `snapshotLayers` 的层列表 + 宿主回调。
 * @typedef {object} InspectorTreeDep
 * @property {readonly any[]} [layers]                层列表（`{at,kind,name,depth,parentAt?,locked?}`）
 * @property {string} [clipId]                        首次点树时还没有 ref 的兜底片段 id
 * @property {string} [selectedAt]
 * @property {(at: string) => boolean} [lockedAt]
 * @property {(at: string) => boolean} [hiddenAt]     会话内隐藏（宿主隐藏舞台框用）
 * @property {(at: string, result: any) => void} [onSelect] 额外回调（面板自己的 select 已经跑过）
 * @property {(at: string | null) => void} [onHover]  悬停联动
 * @property {(ats: string[]) => void} [onLockChange]
 * @property {(ats: string[]) => void} [onHiddenChange]
 * @property {boolean} [filterable]                    树顶过滤框（默认 true）
 * @property {string} [idPrefix]
 */

/**
 * 挂载检查器面板。返回的控制器是**唯一**入口，外部不改内部 DOM。
 * @param {HTMLElement} container
 * @param {InspectorPanelDeps} deps
 */
export function mountInspector(container, deps) {
  if (!container || !container.appendChild) throw new Error('mountInspector 需要一个容器元素');
  if (!deps || typeof deps.describe !== 'function') throw new Error('mountInspector 需要 deps.describe');
  if (typeof deps.preview !== 'function' || typeof deps.commit !== 'function') {
    throw new Error('mountInspector 需要 deps.preview 与 deps.commit');
  }
  const doc = container.ownerDocument ?? /** @type {Document} */ (globalThis.document);

  const root = doc.createElement('div');
  root.className = 'film-inspector';
  root.setAttribute('data-stage', PANEL_STAGE);
  container.appendChild(root);
  /* R113 · L2：段标题 / 效果栈 / 混合模式矩阵的局部样式（不改 styles.css）。 */
  ensureInspectorCss(doc);

  const state = {
    /** 'single' | 'multi' */
    mode: 'single',
    /** 多选时每层一份 `{ref, override, described, declaredBox, baseBox, geometry, locked}` @type {any[]} */
    items: [],
    /** @type {any} */ ref: null,
    /** @type {any} */ described: null,
    /** @type {any} */ model: null,
    /** @type {any} */ override: null,
    /** 片段声明的 box（`{x,y,w,h,r?}`）；面板提交几何时的基准。 @type {any} */
    declaredBox: null,
    /** @type {{x: number, y: number, w: number, h: number, r?: number} | null} */
    baseBox: null,
    /** 祖先坐标系（`readGeometrySpace` 的结果）；null = 宿主没提供或读不到。 @type {any} */
    geometry: null,
    /** 面板上要显示的提示（实测固定尺寸 / 祖先矩阵表达不了）。 @type {{code: string, text: string} | null} */
    hint: null,
    /** S2H：就地报错（挂在出错那行下面；成功提交 / 重新选中时清掉）。 @type {{field: string, code: string, message: string} | null} */
    fieldError: null,
    /**
     * R113 · L2：刚提交、还没被 describe 证实的声明（键 → 值）。
     *
     * 为什么需要：提交后舞台 iframe 按新 hash 重画，`describe` 有可能在重画完成前跑，
     * 读回的还是**旧** computed。此时拿它当「底座」再改第二项，就会把第一项丢掉
     * （实测：连改亮度/对比/色相只剩最后一项）。所以面板记住自己刚写的值，
     * 用它当底座，直到某次 describe 的 computed 与它一致才清掉。
     * @type {Record<string, string>}
     */
    pendingStyle: {},
    /**
     * R151 · M17：`pendingStyle` 里哪些键**已经被文档证实**（key → true）。
     *
     * 这是「声明作废」的门槛：一条声明只有先被文档证实过，之后文档给出不同值时才有资格
     * 被判作废。没证实就作废会把「刚发出去、台账还没回写」当成撤销（用户刚改的值会被弹回去）。
     * @type {Record<string, boolean>}
     */
    pendingSeen: {},
    /**
     * R155 · M18：`pendingStyle` 属于哪个元素（`at`）。
     *
     * 证实/作废都不能只看「当前选中」：应用之后 App 会插一帧空选中，撤销之后也可能换选中；
     * 以前 `confirmPendingLater()` 因为 `state.ref.at !== at` 直接 return，声明永远等不到证实，
     * 于是 `reconcilePending()` 的「先证实、后作废」永远不成立（R151 的 step2 红）。
     * 记下归属，采样时按归属去取文档条目。
     * @type {string}
     */
    pendingAt: '',
    /** R155 · M18：这份声明是在哪个 doc hash 上写的（提交回包的 hash）。 @type {string} */
    pendingHash: '',
    /** R161 · M19（C8）：本次 select 的读回对账记录（诊断/证据用；不是写入口）。 @type {any[] | null} */
    describeAttempts: null,
    /** R161 · M19（C8）：宿主条目被页内实测纠正掉的键（证据用；不改宿主状态）。 @type {any[]} */
    overrideDropped: [],
    /** R151 · M17：最近一次被判「文档已另走一步」而作废的声明（证据用，不参与渲染）。 @type {any} */
    pendingDropped: null,
    /* R121 · M7-B（D02）：当前对象页签（视图态，不写盘）。
       默认「属性」：位置/尺寸是最常改的，也是 s207 那类几何验收第一眼要找的东西。 */
    activeTab: 'props',
    locked: false,
    /** 'idle' | 'ok' | 'conflict' | 'error' */
    status: 'idle',
    /** @type {{code: string, message: string, currentHash?: string}|null} */
    error: null,
    hash: deps.expectedHash ?? null,
    /** @type {Promise<any>} */
    pending: Promise.resolve()
  };

  /** 提交后的读回链（与 `state.pending` 分开：它不挡下一笔提交）。 @type {Promise<any>} */
  let readback = Promise.resolve();
  /** 逐键预览链（同样与提交链分开：预览是尽力而为，绝不能挡住落盘）。 @type {Promise<any>} */
  let previewing = Promise.resolve();

  /** @param {string} tag @param {string} [className] @param {string} [text] */
  function el(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /* R15 / D31：前缀列收到 22px、字 10.5px 之后，超过 2 个汉字的标签会出省略号 ——
     label 自己必须带 `title`，hover 才能看到全名（dock 那边 27/27 本来就有）。
     单选行与多选行共用同一个构造，避免两处漂移。 */
  /** @param {string} text */
  function fieldLabel(text) {
    const node = el('span', 'inspector-field-label', text);
    node.setAttribute('title', text);
    return node;
  }

  /* ── 可选图层树（S18） ────────────────────────────────────────────────
     挂在 root **外面**（容器的前一个子节点）：面板每次 `render()` 都会清空 root，
     树如果放在里面会被连根拔掉，展开状态也就没了。没传 `deps.tree` 时一个节点都不加，
     容器子节点与 R8 完全一致（向后兼容）。 */
  /** @type {HTMLElement | null} */
  let treeHost = null;
  /** @type {any} */
  let tree = null;
  if (deps.tree) {
    treeHost = doc.createElement('div');
    treeHost.className = 'film-inspector-tree';
    treeHost.setAttribute('data-inspector-tree', deps.tree.idPrefix ?? 'layer-tree');
    container.insertBefore(treeHost, root);
    tree = mountLayerTree(treeHost, {
      layers: deps.tree.layers ?? [],
      selectedAt: deps.tree.selectedAt ?? '',
      lockedAt: deps.tree.lockedAt,
      hiddenAt: deps.tree.hiddenAt,
      onHover: deps.tree.onHover,
      onLockChange: deps.tree.onLockChange,
      onHiddenChange: deps.tree.onHiddenChange,
      filterable: deps.tree.filterable,
      idPrefix: deps.tree.idPrefix ?? 'layer-tree',
      onSelect: (/** @type {string} */ at) => {
        void selectFromTree(at);
      }
    });
  }

  /* ── R158 · 检查器信息架构（用户 12:04 三条）─────────────────────────────
     ①「图层 / 锁定当前层」与 ③「元素 / 片段」页签条都是 App 画的（views.ts）；
       本批不动那个文件：这里只给它们打标记 / 搬位置，行为一个不改。
     ③ 五页签宿主 `.r158-insp-head` 挂在 App 的 `layer-picker` **之前**（容器外面，
       和 treeHost 同理）：`render()` 清 root 不会把页签连根拔掉，切换页签也不重建。 */
  const headHost = doc.createElement('div');
  headHost.className = 'r158-insp-head';
  headHost.setAttribute('data-testid', 'inspector-object-head');
  headHost.setAttribute('data-empty', '1');
  if (!deps.externalTabs) {
    const parent = container.parentElement;
    if (parent) parent.insertBefore(headHost, parent.querySelector('.layer-picker') ?? container);
    else container.insertBefore(headHost, root);
  }

  /**
   * ② 片段段：默认只留「外观」里的淡入淡出，其余分组收进「高级」。
   *
   * 片段段的九个组是 App 的 `inspector-groups-panel.ts` 画的，本批不改；这里**只加一个
   * `<details data-r158-advanced>` 开关**，用 CSS 收起其余分组（节点一个不删、handler 不碰）。
   * 外观组默认是折叠的，而它正是「淡入淡出」的家 —— 首次注入时替用户展开一次（只一次，
   * 之后用户自己收起来就不再抢）。
   */
  function ensureAdvanced() {
    const col = root.closest('[data-testid="inspector"]');
    const ig = col?.querySelector('[data-inspector-seg="clip"] .ig') ?? null;
    if (ig === null) return;
    if (ig.querySelector('[data-r158-advanced]') === null) {
      const details = doc.createElement('details');
      details.className = 'r158-adv';
      details.setAttribute('data-r158-advanced', '1');
      details.setAttribute('data-testid', 'inspector-clip-advanced');
      const summary = doc.createElement('summary');
      summary.className = 'ig-head r158-adv-head';
      const title = doc.createElement('span');
      title.className = 'ig-title';
      title.textContent = '高级';
      const count = doc.createElement('span');
      count.className = 'ig-count';
      count.textContent = String(ig.querySelectorAll('[data-clip-group]').length - 1);
      summary.appendChild(title);
      summary.appendChild(count);
      const note = doc.createElement('p');
      note.className = 'r158-adv-note';
      note.textContent = '变换 / 裁剪 / 排印 / 几何 / 音频 / 时间 / 来源 —— 字段、写法与只读语义都不变，展开后原样出现';
      details.appendChild(summary);
      details.appendChild(note);
      details.addEventListener('toggle', () => {
        const host = details.parentElement;
        if (host === null) return;
        if (details.open) host.setAttribute('data-r158-advanced-open', '1');
        else host.removeAttribute('data-r158-advanced-open');
      });
      ig.appendChild(details);
    }
    const appearance = /** @type {HTMLDetailsElement|null} */ (ig.querySelector('[data-clip-group="appearance"]'));
    if (appearance !== null && appearance.open !== true && appearance.getAttribute('data-r158-forced') !== '1') {
      appearance.setAttribute('data-r158-forced', '1');
      appearance.open = true;
    }
  }

  /** 给 App 的两块打标记，并保证页签宿主在 `layer-picker` 之前（App 重排后补一次）。 */
  function syncChrome() {
    const col = root.closest('[data-testid="inspector"]');
    if (col === null) return;
    const row = col.querySelector('[data-testid="layer-lock"]')?.closest('.panel-title-row') ?? null;
    if (row !== null) row.setAttribute('data-r158-legacy-layer', '1');
    const bar = col.querySelector(':scope > .insp-tabs');
    if (bar !== null) bar.setAttribute('data-r158-chip', '1');
    const seg = container.parentElement;
    if (seg !== null) {
      const picker = seg.querySelector('.layer-picker');
      if (!deps.externalTabs && (headHost.parentElement !== seg || (picker !== null && (headHost.compareDocumentPosition(picker) & 2) !== 0))) {
        seg.insertBefore(headHost, picker ?? container);
      }
      /* R165 · INSP：对象头一行 = App 的 `.layer-picker`（里面有唯一的 `layer-select`）。
         面板只打标记并让自己那行重复名让位，不改 App 的 DOM/选项/handler。 */
      if (picker !== null) {
        picker.setAttribute('data-insp-object-head', '1');
        const hasSelect = picker.querySelector('select[data-testid="layer-select"]') !== null;
        root.setAttribute('data-object-head', hasSelect ? 'picker' : 'name');
      } else {
        root.setAttribute('data-object-head', 'name');
      }
    }
    if (!deps.externalTabs) ensureAdvanced();
  }

  /* App 每次重渲染都会重建/搬动子节点：观察整列，按帧去抖后补标记（幂等，不产生新节点）。 */
  let syncQueued = false;
  const queueSync = () => {
    if (syncQueued) return;
    syncQueued = true;
    const run = () => { syncQueued = false; syncChrome(); };
    if (typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(run);
    else globalThis.setTimeout(run, 16);
  };
  const inspectorCol = root.closest('[data-testid="inspector"]');
  const chromeObserver = typeof globalThis.MutationObserver === 'function' && inspectorCol !== null
    ? new globalThis.MutationObserver(() => queueSync())
    : null;
  chromeObserver?.observe(/** @type {Node} */ (inspectorCol ?? container), { childList: true, subtree: true });
  syncChrome();

  /**
   * 画一个字段的输入控件（S51）。返回要挂进 row 的节点（下拉可能多带一个自定义文本框）。
   *
   * 三种控件：
   * - `field.control === 'select'`：枚举/预设。带「自定义」哨兵的那种（`filter`/`backdropFilter`）
   *   额外给一个文本框；选到哨兵**不提交**（只把文本框露出来），选到预设才提交。
   * - 数值（`numeric` 或单位是 px/deg）：`<input type=number>`。
   * - 其余：文本。
   *
   * 多选时值不一致（`mixed`）：下拉加一个空选项「—」并选中它，文本框留空 + 占位「—」。
   * 拿第一层的值冒充共同值是错的（S26 的规矩）。
   *
   * @param {any} field
   * @param {(value: string) => void} commit
   * @param {((value: string) => void) | null} preview 多选不逐键预览，传 null
   */
  function fieldControls(field, commit, preview) {
    const mixed = field.mixed === true;
    /** @type {any[]} */
    const nodes = [];
    /** @type {any} */
    let primary;

    /* 裁切（S54）：四个数值框 + 一个单位下拉，合成 `inset(t r b l)` 提交。
       为什么要合成一个字段：`clip-path` 是**一条** CSS 声明，四次提交会各写一次整条值。 */
    if (field.control === 'inset') {
      const unit = /** @type {HTMLSelectElement} */ (el('select', 'inspector-input inspector-inset-unit'));
      for (const value of ['px', '%']) {
        const option = /** @type {HTMLOptionElement} */ (el('option'));
        option.value = value;
        option.textContent = value;
        unit.appendChild(option);
      }
      unit.value = String(field.unitValue ?? 'px');
      unit.disabled = !field.editable;
      unit.setAttribute('data-field', field.id);
      unit.setAttribute('data-role', 'inset-unit');
      /** @type {HTMLInputElement[]} */
      /** @type {HTMLInputElement[]} */
      const inputs = [];
      const compose = () =>
        `inset(${inputs
          .map((input) => `${String(input.value).trim() === '' ? 0 : String(input.value).trim()}${unit.value}`)
          .join(' ')})`;
      /* 四格是**一条**声明：同一 tick 里改几格都只提交一次（真实用户一次只改一格，
         也是「改一格 = 一次 /ops」；程序化一次填四格不会打出四个 op）。 */
      let scheduled = false;
      const scheduleCommit = () => {
        if (scheduled) return;
        scheduled = true;
        Promise.resolve().then(() => {
          scheduled = false;
          commit(compose());
        });
      };
      for (const part of field.parts ?? []) {
        const input = /** @type {HTMLInputElement} */ (el('input', 'inspector-input inspector-inset-part'));
        input.type = 'number';
        input.step = 'any';
        input.min = '0';
        input.setAttribute('data-field', field.id);
        input.setAttribute('data-part', part.id);
        input.setAttribute('data-source', field.source);
        input.value = mixed ? '' : String(part.value ?? '');
        input.placeholder = mixed ? '—' : String(part.label ?? '');
        input.disabled = !field.editable;
        if (!field.editable) input.setAttribute('data-disabled-reason', field.lockedReason ?? 'LOCKED');
        input.addEventListener('change', scheduleCommit);
        inputs.push(input);
        nodes.push(input);
      }
      unit.addEventListener('change', scheduleCommit);
      nodes.push(unit);
      return nodes;
    }

    /* R113 · L2（LI-A16）：四角圆角 —— 四个数值框合成**一条** border-radius 提交。
       有裁切时改任意一角 = 四角同步（不一致会被 patchForField 拒，这里先替用户做对）。 */
    if (field.control === 'corners') {
      /** @type {HTMLInputElement[]} */
      const inputs = [];
      let scheduled = false;
      const commitAll = () => {
        if (scheduled) return;
        scheduled = true;
        Promise.resolve().then(() => {
          scheduled = false;
          commit(
            inputs
              .map((input) => (String(input.value).trim() === '' ? '0' : String(input.value).trim()))
              .join(' ')
          );
        });
      };
      for (const part of field.parts ?? []) {
        const input = /** @type {HTMLInputElement} */ (el('input', 'inspector-input inspector-corner-part'));
        input.type = 'text';
        input.inputMode = 'decimal';
        input.setAttribute('data-control', 'number');
        input.setAttribute('data-field', field.id);
        input.setAttribute('data-part', part.id);
        input.setAttribute('data-source', field.source);
        input.value = String(part.value ?? '');
        input.placeholder = String(part.label ?? '');
        input.title = String(part.label ?? '');
        input.disabled = !field.editable;
        if (!field.editable) input.setAttribute('data-disabled-reason', field.lockedReason ?? 'LOCKED');
        input.addEventListener('change', () => {
          if (field.clipLinked === true) {
            for (const other of inputs) other.value = input.value;
          }
          commitAll();
        });
        inputs.push(input);
        nodes.push(input);
      }
      return nodes;
    }

    /* R113 · L2（LI-A17）：调色五项 —— 滑杆 + 数值框，两个控件写同一个值。 */
    if (field.control === 'grade') {
      const min = Number(field.gradeMin ?? -100);
      const max = Number(field.gradeMax ?? 100);
      const range = /** @type {HTMLInputElement} */ (el('input', 'inspector-range inspector-grade-range'));
      range.type = 'range';
      range.min = String(min);
      range.max = String(max);
      range.step = String(field.step ?? 1);
      range.value = String(mixed ? 0 : Number(field.display ?? field.current ?? 0) || 0);
      range.setAttribute('data-field', field.id);
      range.setAttribute('data-role', 'grade-range');
      range.setAttribute('data-source', field.source);
      range.disabled = !field.editable;
      if (!field.editable) range.setAttribute('data-disabled-reason', field.lockedReason ?? 'LOCKED');
      const number = /** @type {HTMLInputElement} */ (el('input', 'inspector-input inspector-grade-number'));
      number.type = 'text';
      number.inputMode = 'decimal';
      number.setAttribute('data-control', 'number');
      number.setAttribute('data-field', field.id);
      number.setAttribute('data-role', 'grade-number');
      number.setAttribute('data-source', field.source);
      number.setAttribute('data-min', String(min));
      number.setAttribute('data-max', String(max));
      number.value = mixed ? '' : String(field.display ?? field.current ?? '');
      if (mixed) number.placeholder = '—';
      number.title = `${min}..${max}`;
      number.disabled = !field.editable;
      if (!field.editable) number.setAttribute('data-disabled-reason', field.lockedReason ?? 'LOCKED');
      range.addEventListener('input', () => {
        number.value = range.value;
        if (preview) preview(String(range.value));
      });
      range.addEventListener('change', () => commit(String(range.value)));
      number.addEventListener('change', () => commit(String(number.value)));
      nodes.push(range, number);
      return nodes;
    }

    /* R113 · L2（LI-A10）：字体家族 —— 文本框 + 常用字体候选（只是候选，不限制自填）。 */
    if (field.control === 'font') {
      const listId = 'insp-font-choices';
      if (doc.getElementById(listId) === null) {
        const datalist = el('datalist');
        datalist.id = listId;
        for (const family of COMMON_FONTS) {
          const option = /** @type {HTMLOptionElement} */ (el('option'));
          option.value = family;
          datalist.appendChild(option);
        }
        (doc.body ?? doc.documentElement).appendChild(datalist);
      }
      const input = /** @type {HTMLInputElement} */ (el('input', 'inspector-input inspector-font'));
      input.type = 'text';
      input.setAttribute('list', listId);
      input.setAttribute('data-field', field.id);
      input.setAttribute('data-source', field.source);
      input.value = mixed ? '' : String(field.current ?? '');
      input.placeholder = '字体名（可写多个，逗号分隔）';
      input.disabled = !field.editable;
      if (!field.editable) input.setAttribute('data-disabled-reason', field.lockedReason ?? 'LOCKED');
      if (preview) input.addEventListener('input', () => preview(String(input.value)));
      input.addEventListener('change', () => commit(String(input.value)));
      nodes.push(input);
      return nodes;
    }

    if (field.control === 'select') {
      primary = el('select', 'inspector-input');
      if (mixed) {
        const blank = /** @type {HTMLOptionElement} */ (el('option'));
        blank.value = '';
        blank.textContent = '—';
        primary.appendChild(blank);
      }
      for (const option of field.options ?? []) {
        const node = /** @type {HTMLOptionElement} */ (el('option'));
        node.value = option.value;
        node.textContent = option.label;
        /* R113 · L2（LI-F16）：混合模式逐项能力。合成器不支持的项**显式标「仅透传」并禁用**，
           不给一个选了也不生效的假下拉；作者原文不在 17 种里时保留（不禁用）。 */
        if (typeof option.capability === 'string') {
          node.setAttribute('data-capability', option.capability);
          node.title = String(option.note ?? '');
        }
        if (option.disabled === true) node.disabled = true;
        primary.appendChild(node);
      }
      primary.value = mixed ? '' : String(field.selected ?? field.current ?? '');
      primary.setAttribute('data-select', '1');
      primary.addEventListener('change', () => {
        const value = String(primary.value);
        if (value === '') return;
        if (value === CUSTOM_OPTION) {
          /* 「自定义」不是值：只把文本框露出来并聚焦，一个请求都不发 */
          const custom = nodes.find((node2) => node2.getAttribute('data-custom') === '1');
          if (custom) {
            custom.hidden = false;
            custom.focus();
          }
          return;
        }
        commit(value);
      });
    } else {
      primary = el('input', 'inspector-input');
      primary.type = field.numeric || NUMERIC_UNITS.has(field.unit) ? 'number' : 'text';
      /* B02（R108）：页面内元素的几何框用 text + inputmode=decimal ——
         `type=number` 会把非法输入读成空串（等于静默丢值），而这条路径要求
         「错误就地显示、已输入的值不清空」；与「片段」页签 U04 的类型化控件同一口径。 */
      if (field.kind === 'box' && isPageDomain()) {
        primary.type = 'text';
        primary.inputMode = 'decimal';
        primary.setAttribute('data-control', 'number');
      }
      if (field.numeric) {
        primary.step = 'any';
        primary.setAttribute('data-numeric', '1');
        if (field.emptyState) primary.setAttribute('data-empty-state', field.emptyState);
      }
      if (field.kind === 'box') {
        primary.step = 'any';
        primary.setAttribute('data-space', field.space);
      }
      /* 有坐标系时显示屏幕值（display），否则与 R7 一样显示声明值 */
      primary.value = mixed ? '' : String(field.display ?? field.current ?? '');
      if (mixed) primary.placeholder = '—';
      if (preview) primary.addEventListener('input', () => preview(String(primary.value)));
      primary.addEventListener('change', () => commit(String(primary.value)));
    }

    primary.setAttribute('data-field', field.id);
    /* E12-P3 B5（R38）：文本样式四项带约定 testid（`inspector-field-stroke` / `-bg` / `-align` / `-tracking`）
       与 `name` —— 副线2 的量具按 `data-testid + name + label` 跑 `/stroke|bg|align|tracking/i`
       （`s190-r52-e12p3-accept.mjs:553`），只有中文 label（「描边」）判不到、会一直 PENDING。
       **只给这四个加**，不给全部字段加：别的判据按 `[data-testid="field-row"]` 计数，别搅动。 */
    if (field.id === 'stroke' || field.id === 'bg' || field.id === 'align' || field.id === 'tracking') {
      primary.setAttribute('data-testid', `inspector-field-${field.id}`);
      primary.setAttribute('name', field.id);
    }
    primary.setAttribute('data-source', field.source);
    primary.setAttribute('data-kind', field.kind ?? 'override');
    primary.disabled = !field.editable;
    if (!field.editable) primary.setAttribute('data-disabled-reason', field.lockedReason ?? 'LOCKED');
    nodes.push(primary);

    // Keep the numeric field as the canonical editor, including its exact precision and unit.
    if (field.id === 'opacity' && preview && String(primary.value).trim() !== ''
        && Number(primary.value) >= 0 && Number(primary.value) <= 1) {
      const slider = /** @type {HTMLInputElement} */ (el('input', 'insp-opacity-range'));
      slider.type = 'range';
      slider.min = '0';
      slider.max = '1';
      slider.step = '0.01';
      slider.value = primary.value;
      slider.disabled = primary.disabled;
      slider.setAttribute('aria-label', '调节不透明度');
      slider.addEventListener('input', () => {
        primary.value = slider.value;
        preview(slider.value);
      });
      slider.addEventListener('change', () => commit(slider.value));
      primary.addEventListener('input', () => {
        if (primary.value !== '' && Number.isFinite(Number(primary.value))) slider.value = primary.value;
      });
      nodes.push(slider);
    }

    /* 预设 + 自定义：文本框常驻（`hidden` 控制显隐），手改成非预设值时也走这里提交 */
    if (field.control === 'select' && (field.options ?? []).some((/** @type {any} */ option) => option.value === CUSTOM_OPTION)) {
      const custom = /** @type {HTMLInputElement} */ (el('input', 'inspector-input inspector-custom'));
      custom.type = 'text';
      custom.setAttribute('data-field', field.id);
      custom.setAttribute('data-custom', '1');
      custom.setAttribute('data-source', field.source);
      custom.placeholder = '自定义';
      custom.value = field.custom === true && !mixed ? String(field.current ?? '') : '';
      custom.hidden = field.custom !== true;
      custom.disabled = !field.editable;
      if (preview) custom.addEventListener('input', () => preview(String(custom.value)));
      custom.addEventListener('change', () => commit(String(custom.value)));
      nodes.push(custom);
    }

    return nodes;
  }

  /** 效果三态 → 人话（面板与验收脚本共用这一份）。 */
  const EFFECT_STATE_LABEL = {
    absent: '未添加',
    present: '已添加',
    custom: '手写（无法结构化）',
    mixed: '多处不一致'
  };

  /** 一条行内提示（`data-note` 分类，验收按它取）。 */
  function noteNode(/** @type {string} */ kind, /** @type {string} */ text) {
    const note = el('p', 'insp-note', text);
    note.setAttribute('data-note', kind);
    note.setAttribute('data-testid', `inspector-note-${kind}`);
    return note;
  }

  /**
   * R113 · L2 的四条行内提示。只在该字段真的有话说时返回节点。
   * @param {any} field
   */
  function fieldNotes(field) {
    /** @type {HTMLElement[]} */
    const out = [];
    if (field.id === 'fontFamily' && field.fontCheck && field.fontCheck.available === false) {
      out.push(
        noteNode(
          'font-fallback',
          `本机没有「${String(field.fontCheck.family)}」：浏览器会用回退字体渲染（写回的值不改，换台机器还能用）`
        )
      );
    }
    if (field.id === 'radiusCorners' && field.clipLinked === true) {
      out.push(noteNode('radius-linked', '这个元素有裁切：四角必须一致，改一个角会同步四个角'));
    }
    if (field.clipped === true && (field.id === 'outlinePosition' || field.id === 'outlineWidth')) {
      out.push(noteNode('clipped', '元素（或祖辈）有裁切：外描边可能被裁掉一半 —— 要外描边请先去掉裁切'));
    }
    if (field.control === 'grade' && field.gradeCustom === true) {
      out.push(noteNode('filter-custom', '这一段 filter 是手写的：调色不改它，请到「滤镜」里改原文'));
    }
    return out;
  }

  /**
   * 一条效果行：状态 + 动作按钮 + 参数。
   * @param {any} field
   */
  function effectControl(field) {
    const box = el('div', 'insp-eff');
    box.setAttribute('data-effect', field.effectKind);
    box.setAttribute('data-field', field.id);
    box.setAttribute('data-state', field.effectState);
    box.setAttribute('data-order', String(field.effectOrder ?? 0));
    box.setAttribute('data-count', String(field.effectCount ?? 0));
    /* 顺序固定：不画拖拽手柄、也不假装能拖（A19：不支持的重排不能假成功）。 */
    box.setAttribute('data-reorder', 'fixed');

    const head = el('div', 'insp-eff-head');
    const stateText = EFFECT_STATE_LABEL[/** @type {keyof typeof EFFECT_STATE_LABEL} */ (field.effectState)] ?? String(field.effectState);
    const chip = el('span', 'insp-eff-state', stateText);
    chip.setAttribute('data-testid', `inspector-effect-state-${field.id}`);
    head.appendChild(chip);

    const params = () => paramsOf(field);
    const button = (/** @type {string} */ label, /** @type {string} */ action, /** @type {boolean} */ disabled, /** @type {string} */ why = '') => {
      const btn = /** @type {HTMLButtonElement} */ (el('button', 'insp-eff-btn', label));
      btn.type = 'button';
      btn.setAttribute('data-effect-action', action);
      btn.setAttribute('data-testid', `inspector-effect-${action}-${field.id}`);
      btn.disabled = disabled;
      if (why) btn.title = why;
      btn.addEventListener('click', () => {
        state.pending = state.pending.then(() => commitEffect(field, /** @type {any} */ (action), params())).catch(() => {});
      });
      return btn;
    };

    if (field.effectState === 'absent') {
      head.appendChild(button('+ 添加', 'add', field.editable !== true));
    } else if (field.effectState === 'custom') {
      head.appendChild(button('删除', 'remove', false));
      head.appendChild(button('重置', 'reset', true, '手写效果没有结构化参数可重置：删除后就回到默认'));
    } else {
      head.appendChild(button(field.effectState === 'mixed' ? '全部删除' : '删除', 'remove', false));
      head.appendChild(button('重置', 'reset', false));
      head.appendChild(button('停用', 'toggle', false));
    }
    box.appendChild(head);

    if (field.effectState === 'present' || field.effectState === 'mixed') {
      box.appendChild(effectParamsNode(field));
    }
    if (typeof field.effectNote === 'string' && field.effectNote !== '') {
      const note = el('span', 'insp-eff-note', field.effectNote);
      note.setAttribute('data-effect-note', '1');
      note.setAttribute('data-testid', `inspector-effect-note-${field.id}`);
      box.appendChild(note);
    }
    return box;
  }

  /** 一个参数输入框（text + inputmode=decimal：`type=number` 会把非法输入读成空串）。 */
  function paramInput(/** @type {string} */ role, /** @type {string} */ label, /** @type {any} */ value, /** @type {number|null} */ min = null, /** @type {number|null} */ max = null) {
    const input = /** @type {HTMLInputElement} */ (el('input', 'inspector-input'));
    input.type = 'text';
    input.inputMode = 'decimal';
    input.setAttribute('data-control', 'number');
    input.setAttribute('data-effect-param', role);
    input.setAttribute('data-role', role);
    input.setAttribute('aria-label', label);
    input.setAttribute('title', `${label}${min === null ? '' : `（${min}..${max}）`}`);
    input.value = value === null || value === undefined ? '' : String(value);
    input.placeholder = label;
    return input;
  }

  /**
   * 一行效果参数：随效果类型不同（投影 4 项 / 内阴影 5 项 / 模糊 1 项 / 四边渐隐 4 边）。
   * @param {any} field
   */
  function effectParamsNode(field) {
    const wrap = el('div', 'insp-eff-params');
    wrap.setAttribute('data-effect-params', field.effectKind);
    const params = field.effectParams ?? {};
    const kind = String(field.effectKind);

    if (kind === 'edge-fade') {
      const edges = params.edges ?? {};
      for (const edge of FADE_EDGES) {
        const input = paramInput(edge, EDGE_LABEL[/** @type {keyof typeof EDGE_LABEL} */ (edge)] ?? edge, edges[edge] ?? 0, 0, FADE_MAX);
        input.setAttribute('data-edge', edge);
        input.addEventListener('change', () => {
          state.pending = state.pending
            .then(() => commitEffect(field, 'set', { edge, value: String(input.value) }))
            .catch(() => {});
        });
        wrap.appendChild(input);
      }
      const hint = el('span', 'insp-eff-note', `${FADE_MIN}–${FADE_MAX}%（0 = 关掉这一边）`);
      hint.setAttribute('data-effect-hint', 'fade-range');
      wrap.appendChild(hint);
      return wrap;
    }

    if (kind === 'blur' || kind === 'backdrop-blur') {
      const input = paramInput('value', '模糊', params.value ?? 0, 0, 1000);
      input.addEventListener('change', () => {
        state.pending = state.pending.then(() => commitEffect(field, 'set', { value: String(input.value) })).catch(() => {});
      });
      wrap.appendChild(input);
      const unit = el('span', 'inspector-field-unit', 'px');
      unit.setAttribute('data-unit-chip', '1');
      wrap.appendChild(unit);
      return wrap;
    }

    const fields = kind === 'inset-shadow'
      ? [['x', 'X'], ['y', 'Y'], ['blur', '模糊'], ['spread', '扩展']]
      : [['x', 'X'], ['y', 'Y'], ['blur', '模糊']];
    for (const pair of fields) {
      const key = String(pair[0]);
      wrap.appendChild(paramInput(key, String(pair[1]), params[key] ?? 0));
    }
    const color = paramInput('color', '颜色', params.color ?? 'rgba(0, 0, 0, 0.35)');
    color.setAttribute('data-role', 'color');
    wrap.appendChild(color);

    /** 每次改一项：把**整组**参数一起提交（一次 /ops、一步撤销）。 */
    const readAll = () => {
      /** @type {Record<string, any>} */
      const next = {};
      for (const node of wrap.querySelectorAll('[data-effect-param]')) {
        const role = node.getAttribute('data-effect-param');
        if (role === null) continue;
        next[role] = role === 'color' ? String(/** @type {HTMLInputElement} */ (node).value) : String(/** @type {HTMLInputElement} */ (node).value);
      }
      return next;
    };
    for (const node of wrap.querySelectorAll('[data-effect-param]')) {
      node.addEventListener('change', () => {
        state.pending = state.pending.then(() => commitEffect(field, 'set', readAll())).catch(() => {});
      });
    }
    return wrap;
  }

  /** 当前参数（按钮动作要带「现在这一组值」，否则「重置/停用」会拿不到参数）。 */
  /* ── R125 · M11-A（LI-A20/A21）：蒙版 ────────────────────────────────────
     一个字段（`data-field="mask"`）+ 一个画布。写入口只有一个：`maskPatch()`。
     画布手势的顺序固定为 **preview → 应用/取消**：
     - 拖动中只调 `deps.preview`（舞台立刻变），**不写盘**；
     - 「应用」= 一条 `/ops`（`--oc-mask` + `mask-image` 一起落）；
     - 「取消」= `revertPreview()` + 草稿回滚 → 文档**逐字节无残留**（从没写过）。 */

  /** 当前蒙版草稿（画布拖动时的临时值；null = 没有未应用的改动）。 */
  /** @type {any} */
  let maskDraft = null;
  /**
   * 「手势已经发生过、还没应用」——**必须存在状态里，不能只写在 DOM 属性上**。
   *
   * R136/M12 实测：`pointerup` 之后 400ms 内面板会连做两次整块重画（读回 → `render()`），
   * 画布与应用条都是**新节点**，`data-dirty` 回到 0 → 按钮 `display:none`，
   * 拖到手的东西提交不了（旧代码只在事件里 `applybar.setAttribute('data-dirty','1')`，
   * 写的是**已经被换掉**的那个节点）。现在真相在 `maskDirty`，每次 `render()` 都重新派生属性。
   */
  let maskDirty = false;
  /**
   * 这一份草稿**开始时**的规格（R151 · M17）。
   *
   * 「应用」只写这次真改过的字段，其余以文档为准 —— 判据就是「草稿 vs 起点」。
   * 起点只在「本来没有草稿」时记：连拖两次（中间没应用）时字段并集仍在，不会被第二次覆盖掉。
   * @type {any}
   */
  let maskDraftBase = null;
  /** 有没有手势正在进行（用来区分「用户正在拖」与「遗留草稿」）。 */
  let maskGestureActive = false;
  /**
   * 草稿属于哪个元素（`ref.at`）。**不能靠「换层」来清草稿**：`pointerup` 之后 App 会先
   * 清空选中再重新选中同一个元素（实测 4ms 内 `inspector-empty` → 正常面板），
   * 那条路会把「刚拖完、还没应用」的草稿误删。所以按**归属**判：草稿的 at 与当前 at 不同才丢。
   */
  let maskDraftFor = '';
  /** 当前这一份应用条（重画会换节点；`syncMaskBar()` 只改还挂在树上的那一个）。 */
  /** @type {HTMLElement|null} */
  let maskBar = null;
  /** 把「有没有未应用的手势」同步到当前应用条上（可见性只有这一个开关）。 */
  function syncMaskBar() {
    if (maskBar !== null && maskBar.isConnected === true) {
      maskBar.setAttribute('data-dirty', maskDirty && maskDraft !== null ? '1' : '0');
    }
  }

  function maskBoxPx() {
    const box = state.described?.box;
    if (!box || !(Number(box.w) > 0) || !(Number(box.h) > 0)) return null;
    return { w: Number(box.w), h: Number(box.h) };
  }

  /** 蒙版补丁（草稿 → patch），画布预览与提交共用。 */
  function maskBuild(/** @type {any} */ params, /** @type {any} */ baseSpec = null, /** @type {'add'|'set'|'remove'|'invert'|'reset'} */ action = 'set') {
    const css = cssBase();
    /* R155 · M18：落盘草稿的底座用**手势起点**（pointerdown 时从文档取的 `maskDraftBase`），
       不是 `cssBase()`。后者含 `pendingStyle`；声明还没作废时，未改字段会从这里复活
       （R151 的 step3：草稿 rot=0，写回却是 39.65）。 */
    const maskSpec = baseSpec === null ? css.maskSpec : formatMaskSpec(baseSpec);
    return maskPatch({ maskImage: css.maskImage, maskSpec }, action, params, maskBoxPx());
  }

  /**
   * 画布草稿 → 真正要写的那几个字段（R151 · M17）。
   *
   * 只写「这次手势改过的」；没改的字段以**文档**为准。以前把整份草稿发出去，
   * 撤销之后草稿里还留着上一份文档的 `rot`，一应用就把旧旋转复活（R147 的 knownRed）。
   * 逐字段：草稿 ≠ 起点 → 用户改的，写草稿；草稿 = 起点但文档 ≠ 起点 → 文档动过，写文档。
   * @param {any} params
   * @returns {Record<string, any>}
   */
  function maskWriteParams(params) {
    const base = maskDraftBase ?? params;
    /* 用**草稿的归属**取文档：`pointerup` 之后 App 可能先清一次选中，`state.ref` 会是 null，
       那一刻取不到文档就会退回「整份旧声明」（实测把形状写回 star）。 */
    const docSpec = docMaskSpec(maskDraftFor || state.ref?.at || '');
    const doc = docSpec === null ? null : parseMaskSpec(docSpec);
    const keyOf = (/** @type {unknown} */ value) => String(value ?? '').trim().toLowerCase();
    /** @type {Record<string, any>} */
    const out = {};
    for (const [key, value] of Object.entries(/** @type {Record<string, any>} */ (params))) {
      const started = /** @type {any} */ (base)[key];
      if (keyOf(value) !== keyOf(started)) {
        out[key] = value;
        continue;
      }
      /** @type {any} */
      const inDoc = doc === null ? undefined : doc[key];
      if (inDoc !== undefined && keyOf(inDoc) !== keyOf(started)) out[key] = inDoc;
    }
    return out;
  }

  /**
   * @param {string} action
   * @param {any} params
   * @param {boolean} [fromDraft] 这一笔就是把画布草稿落盘（应用按钮）
   */
  async function commitMask(/** @type {'add'|'set'|'remove'|'invert'|'reset'} */ action, /** @type {any} */ params, /** @type {boolean} */ fromDraft = false) {
    if (state.locked) return failField('mask', 'LOCKED', '锁定层不可编辑');
    /* 这次提交是不是「把画布上那份草稿落盘」？
       不是的话（形状/参数/反转/删除这些排队提交），成功时**绝不能清草稿** ——
       R136 的 `commit-one-op` 就是被它吃掉的：上一次参数提交排到队列里，落地时
       把用户正在拖的草稿清成 null，「应用」于是写回旧值。 */
    const consumesDraft = fromDraft === true || (params !== null && params !== undefined && params === maskDraft);
    /* R155 · M18：把画布草稿落盘时，底座 = 这份草稿的起点（文档）。
       参数只写手势改过的键（`maskWriteParams`），其余字段由底座给文档值；
       其它动作（add/remove/reset/invert）仍走 `cssBase()`，一个字节不改。 */
    const built = /** @type {any} */ (maskBuild(params, consumesDraft ? maskDraftBase : null, action));
    if (built.ok !== true) return failField('mask', built.error.code, built.error.message);
    if (built.unchanged === true) return { ok: true, unchanged: true };
    const patch = built.patch;
    await deps.preview(patch);
    const res = await deps.commit(patch);
    if (res && res.ok) {
      state.hash = res.hash ?? state.hash;
      state.status = 'ok';
      state.error = null;
      state.fieldError = null;
      declarePending(patch);
      if (typeof built.note === 'string') state.hint = { code: 'MASK', text: built.note };
      if (deps.overrideOf) state.override = deps.overrideOf(state.ref.at);
      if (consumesDraft) {
        maskDraft = null;
        maskDirty = false;
        maskDraftBase = null;
        maskDraftFor = '';
        maskAnchorTop = null;
        syncMaskBar();
      }
      renderStatusInPlace();
      scheduleReadback();
      return { ok: true, hash: state.hash };
    }
    const code = res?.code ?? 'IO';
    state.status = code === 'CONFLICT' ? 'conflict' : 'error';
    state.error = { code, message: res?.message ?? '提交失败' };
    if (res?.currentHash) state.error.currentHash = res.currentHash;
    if (typeof deps.revertPreview === 'function') await deps.revertPreview();
    renderStatusInPlace();
    return { ok: false, code };
  }

  /** 只预览不写盘（画布拖动时每帧调一次）。 */
  async function previewMask(/** @type {any} */ params) {
    const built = maskBuild(params);
    if (built.ok !== true) return;
    await deps.preview(built.patch);
  }

  /**
   * 蒙版控件：状态 + 形状 + 参数 + 画布。
   * 不支持的参数是 **disabled + 人话理由**（`MASK_CAPS`），不是藏起来。
   * @param {any} field
   */
  function maskControl(field) {
    /* 草稿只属于**拖它的那个元素**：换到别的元素就丢掉（同元素的重画/重选一律保留）。 */
    const nowAt = state.ref?.at ?? '';
    if (maskDraft !== null && maskDraftFor !== '' && nowAt !== '' && maskDraftFor !== nowAt) {
      maskDraft = null;
      maskDirty = false;
      maskDraftBase = null;
    }
    const wrap = el('div', 'insp-mask');
    wrap.setAttribute('data-mask-state', field.maskState);
    /* 参数行读**当前真值**（`--oc-mask` 的现在值，含刚写还没被读回证实的 pending），
       不读模型快照：模型是上一次读回的，切形状之后控件会短暂停留在旧形状的参数上
       （圆还显示着「旋转」可用），看起来像能力矩阵没生效。 */
    const liveSpec = parseMaskSpec(cssBase().maskSpec);
    const spec = { ...MASK_DEFAULTS, ...(liveSpec ?? field.maskSpec ?? {}) };
    const draft = () => maskDraft ?? spec;

    const head = el('div', 'insp-mask-head');
    const STATE_TEXT = /** @type {Record<string, string>} */ ({ absent: '未设置', params: '已设置', custom: '作者写的' });
    const stateText = STATE_TEXT[String(field.maskState)] ?? String(field.maskState);
    const chip = el('span', 'insp-mask-state', stateText);
    chip.setAttribute('data-testid', 'inspector-mask-state');
    head.appendChild(chip);

    const action = (/** @type {string} */ label, /** @type {string} */ act, /** @type {boolean} */ disabled, /** @type {string} */ why = '') => {
      const b = /** @type {HTMLButtonElement} */ (el('button', 'insp-eff-btn', label));
      b.type = 'button';
      b.setAttribute('data-mask-action', act);
      /* 动作按钮统一 `-action-` 前缀：`inspector-mask-invert` 已经是**勾选框**的 id，
         同一棵树里两个同名 testid 会让「点反转」点到按钮或框（实测 strict mode 报错）。 */
      b.setAttribute('data-testid', `inspector-mask-action-${act}`);
      b.disabled = disabled;
      if (why) b.title = why;
      b.addEventListener('click', () => {
        state.pending = state.pending.then(() => commitMask(/** @type {any} */ (act), null)).catch(() => {});
      });
      return b;
    };
    if (field.maskState === 'absent') {
      head.appendChild(action('+ 新建蒙版', 'add', field.editable !== true));
    } else {
      head.appendChild(action(field.maskState === 'custom' ? '替换' : '反转', field.maskState === 'custom' ? 'add' : 'invert', field.editable !== true));
      head.appendChild(action('重置', 'reset', field.maskState === 'custom', '作者写的蒙版没有结构化参数可重置'));
      head.appendChild(action('删除', 'remove', false));
    }
    wrap.appendChild(head);

    if (field.maskState === 'custom') {
      const note = el('p', 'insp-note', field.maskNote || '这个元素本来就有蒙版');
      note.setAttribute('data-mask-note', 'custom');
      wrap.appendChild(note);
      return wrap;
    }
    if (field.maskState === 'absent') {
      const note = el('p', 'insp-note', '还没有蒙版：点「新建蒙版」按当前形状加一层（不动作者的样式）');
      note.setAttribute('data-mask-note', 'absent');
      wrap.appendChild(note);
      return wrap;
    }

    /* 形状 */
    const shapeRow = el('div', 'insp-mask-row');
    shapeRow.appendChild(el('span', 'insp-mask-label', '形状'));
    const select = /** @type {HTMLSelectElement} */ (el('select', 'inspector-input'));
    select.setAttribute('data-mask-shape', '1');
    select.setAttribute('data-testid', 'inspector-mask-shape');
    for (const item of field.maskShapes ?? []) {
      const opt = /** @type {HTMLOptionElement} */ (el('option', '', item.label));
      opt.value = item.id;
      if (item.id === spec.shape) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      state.pending = state.pending.then(() => commitMask('set', { shape: select.value })).catch(() => {});
    });
    shapeRow.appendChild(select);
    wrap.appendChild(shapeRow);

    /* 参数（每项一行；不支持的置灰 + 理由） */
    for (const row of maskParamRows(spec.shape)) {
      const line = el('div', 'insp-mask-row');
      line.setAttribute('data-mask-param', row.id);
      line.appendChild(el('span', 'insp-mask-label', row.label));
      const input = /** @type {HTMLInputElement} */ (el('input', 'inspector-input'));
      input.type = 'text';
      input.inputMode = 'decimal';
      input.value = String(draft()[row.id] ?? '');
      input.disabled = row.enabled !== true || field.editable !== true;
      input.setAttribute('data-mask-input', row.id);
      input.setAttribute('data-testid', `inspector-mask-${row.id}`);
      if (row.enabled !== true) {
        input.setAttribute('data-mask-unsupported', '1');
        input.title = row.reason;
        line.setAttribute('data-mask-unsupported', '1');
      }
      const commit = () => {
        const raw = Number(input.value);
        if (!Number.isFinite(raw)) {
          failField('mask', 'INVALID_VALUE', `${row.label}需要数字（收到「${input.value}」）`);
          return;
        }
        state.pending = state.pending.then(() => commitMask('set', { [row.id]: raw })).catch(() => {});
      };
      input.addEventListener('change', commit);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
      });
      line.appendChild(input);
      line.appendChild(el('span', 'insp-mask-unit', row.unit));
      wrap.appendChild(line);
    }

    /* 反转（布尔，单独一行勾选） */
    const invLine = el('div', 'insp-mask-row');
    const invLabel = el('label', 'insp-mask-invert');
    const inv = /** @type {HTMLInputElement} */ (el('input', 'insp-mask-check'));
    inv.type = 'checkbox';
    inv.checked = Number(spec.invert) === 1;
    inv.setAttribute('data-testid', 'inspector-mask-invert');
    inv.addEventListener('change', () => {
      state.pending = state.pending.then(() => commitMask('set', { invert: inv.checked ? 1 : 0 })).catch(() => {});
    });
    invLabel.appendChild(inv);
    invLabel.appendChild(el('span', '', '反转（挖掉形状本身的区域）'));
    invLine.appendChild(invLabel);
    wrap.appendChild(invLine);

    wrap.appendChild(maskCanvas(field, draft));
    return wrap;
  }

  /**
   * 蒙版画布：拖动移动、右下角缩放、上方手柄旋转。
   * 手势 → `applyMaskGesture()`（纯函数）→ 只 preview；松手后停在「待应用」态。
   * @param {any} field
   * @param {() => any} draft
   */
  function maskCanvas(field, draft) {
    /**
     * 新一支手势的起点：草稿已在就接着拖；否则**以文档为准**（文档没有才退回模型）。
     * 撤销/外部写入之后模型可能还压着旧声明，文档才是这一笔该基于的东西。
     */
    const draftBase = () => {
      if (maskDraft !== null) return { ...maskDraft };
      const raw = docMaskSpec(maskDraftFor || state.ref?.at || '');
      const parsed = raw === null ? null : parseMaskSpec(raw);
      return { ...(parsed ?? draft()) };
    };
    const canvas = el('div', 'insp-mask-canvas');
    canvas.setAttribute('data-testid', 'inspector-mask-canvas');
    const shape = el('div', 'insp-mask-box');
    shape.setAttribute('data-mask-handle', 'move');
    shape.setAttribute('data-testid', 'inspector-mask-box');
    const grip = el('span', 'insp-mask-grip');
    grip.setAttribute('data-mask-handle', 'resize');
    const rotor = el('span', 'insp-mask-rotor');
    rotor.setAttribute('data-mask-handle', 'rotate');
    rotor.setAttribute('title', '拖动旋转');
    shape.appendChild(grip);
    shape.appendChild(rotor);
    canvas.appendChild(shape);

    const paint = () => {
      const live = draft();
      /* 画布是「元素盒子」，x/y/w/h 都是百分比 → 直接当 inset 百分比用（y 轴向下）。 */
      shape.style.left = `${Number(live.x) - Number(live.w) / 2}%`;
      shape.style.top = `${Number(live.y) - Number(live.h) / 2}%`;
      shape.style.width = `${Number(live.w)}%`;
      shape.style.height = `${Number(live.h)}%`;
      shape.style.transform = `rotate(${Number(live.rot)}deg)`;
      shape.setAttribute('data-mask-rot', String(live.rot));
      shape.textContent = '';
      shape.appendChild(grip);
      shape.appendChild(rotor);
      shape.setAttribute('data-mask-w', String(live.w));
      shape.setAttribute('data-mask-h', String(live.h));
    };
    paint();

    let pendingFrame = false;
    const livePreview = () => {
      if (pendingFrame) return;
      pendingFrame = true;
      requestAnimationFrame(() => {
        pendingFrame = false;
        previewMask(draft()).catch(() => {});
      });
    };

    canvas.addEventListener('pointerdown', (ev) => {
      if (state.locked) return;
      const target = /** @type {HTMLElement} */ (ev.target);
      /* R147 · M16：应用条就挂在画布**里面**，按「应用 / 取消」也是按在 canvas 上。
         不在这里早退的话，这条 pointerdown 会先把草稿复制一份、松手时 `finish()` 以
         `!moved` 把它清成 null，按钮的 click 才轮到 —— 应用拿到回落的 `draft()`（上一次读回的
         旧规格），取消把用户刚拖出来的草稿丢掉。M11A/canvas 三红是同一个根因。 */
      if (typeof target.closest === 'function' && target.closest('.insp-mask-apply') !== null) return;
      const mode = target.getAttribute('data-mask-handle') ?? 'move';
      const rect = canvas.getBoundingClientRect();
      const startX = ev.clientX;
      const startY = ev.clientY;
      /* 按下之前有没有草稿、草稿长什么样：没拖就松手时要**原样还回去**，不能清。 */
      const prevDraft = maskDraft;
      const hadDraft = maskDraft !== null;
      /* R151：手势的起点取**文档**（草稿 → 文档 → 模型）。
         模型里可能还压着一条没被证实的旧声明（撤销之后就是它），拿它当起点会把旧值带回来；
         文档才是「下一笔该基于什么」。 */
      const startSpec = { ...draftBase() };
      /* R151：这一份草稿的起点（只在「本来没有草稿」时记；连拖两次仍算同一份草稿）。 */
      if (!hadDraft) maskDraftBase = { ...startSpec };
      maskDraft = { ...startSpec };
      maskDraftFor = state.ref?.at ?? '';
      maskAnchorTop = canvas.getBoundingClientRect().top;
      /* 只按下不拖 = 不是手势：不置待应用（否则点一下画布就冒出「应用/取消」）。 */
      let moved = false;
      maskGestureActive = true;
      canvas.setPointerCapture?.(ev.pointerId);
      const apply = (/** @type {PointerEvent} */ e) => {
        const dxPct = ((e.clientX - startX) / Math.max(1, rect.width)) * 100;
        const dyPct = ((e.clientY - startY) / Math.max(1, rect.height)) * 100;
        if (Math.abs(e.clientX - startX) < 1 && Math.abs(e.clientY - startY) < 1 && moved !== true) return;
        moved = true;
        const gesture = mode === 'rotate'
          ? { kind: 'rotate', dRot: dxPct * 2 }
          : mode === 'resize'
            ? { kind: 'resize', dwPct: dxPct, dhPct: dyPct }
            : { kind: 'move', dxPct, dyPct };
        maskDraft = applyMaskGesture(startSpec, /** @type {any} */ (gesture)).spec;
        paint();
        livePreview();
      };
      const finish = () => {
        maskGestureActive = false;
        canvas.removeEventListener('pointermove', apply);
        canvas.removeEventListener('pointerup', finish);
        canvas.removeEventListener('pointercancel', finish);
        if (!moved) {
          /* 没拖：什么都没预览。**按下前有草稿就原样还回去**（一次误触不该吃掉用户拖了一半
             的东西）；按下前没有草稿才是 null，别留一个假「待应用」。 */
          maskDraft = hadDraft ? prevDraft : null;
          if (!hadDraft) {
            maskDirty = false;
            maskDraftBase = null;
          }
          syncMaskBar();
          return;
        }
        /* 待应用是**状态**（`maskDirty`），不是这个节点的属性：`pointerup` 之后面板会重画，
           新应用条要从状态里重新派生（`syncMaskBar()` 在 maskControl 里也会再跑一次）。 */
        maskDirty = true;
        syncMaskBar();
      };
      canvas.addEventListener('pointermove', apply);
      canvas.addEventListener('pointerup', finish);
      canvas.addEventListener('pointercancel', finish);
    });

    const applybar = el('div', 'insp-mask-apply');
    maskBar = applybar;
    /* 初始值从状态派生：一次重画后如果草稿还在，条子必须**仍然可见**。 */
    applybar.setAttribute('data-dirty', maskDirty && maskDraft !== null ? '1' : '0');
    const okBtn = /** @type {HTMLButtonElement} */ (el('button', 'insp-eff-btn', '应用'));
    okBtn.type = 'button';
    okBtn.setAttribute('data-testid', 'inspector-mask-commit');
    okBtn.addEventListener('click', () => {
      /* R147：应用只认**画布上那份草稿**。
         以前写的是 `maskDraft ?? draft()`：草稿被上一条 pointerdown 吃掉时，这里会回落到
         `draft()`（= 上一次读回的模型），把旧形状/旧 x 写回去 —— 表面「提交成功」，
         实际把用户刚拖的位置丢了，还顺手改掉形状（实测把 rect 写成 star、invert 写回 1）。
         没有草稿就不该有这一笔。 */
      const params = maskDraft;
      if (params === null) {
        maskDirty = false;
        syncMaskBar();
        return;
      }
      /* R151 · M17：只写这次手势改过的字段；没改的以文档为准（撤销后旧 rot 不再复活）。 */
      const writeParams = maskWriteParams(params);
      /* 点下去就收条（防重复提交出两条 /ops）；提交失败再把它放回来，让用户能重试。 */
      maskDirty = false;
      syncMaskBar();
      state.pending = state.pending
        .then(() => commitMask('set', writeParams, true))
        .then((res) => {
          if (res && res.ok !== true) {
            maskDirty = true;
            syncMaskBar();
          }
        })
        .catch(() => {});
    });
    const cancelBtn = /** @type {HTMLButtonElement} */ (el('button', 'insp-eff-btn', '取消'));
    cancelBtn.type = 'button';
    cancelBtn.setAttribute('data-testid', 'inspector-mask-cancel');
    cancelBtn.addEventListener('click', async () => {
      maskDraft = null;
      maskDirty = false;
      maskDraftBase = null;
      maskDraftFor = '';
      maskAnchorTop = null;
      syncMaskBar();
      if (typeof deps.revertPreview === 'function') await deps.revertPreview();
      state.hint = { code: 'MASK', text: '已取消（草稿没有写盘）' };
      render();
    });
    applybar.appendChild(okBtn);
    applybar.appendChild(cancelBtn);
    canvas.appendChild(applybar);

    return canvas;
  }

  /* ── R125 · M11-B（LI-A24）：四角裁切 / 换源 ───────────────────────────── */

  /** 一条 style 补丁 → 预览 + 提交（与 commitEffect 同一套失败语义）。 */
  async function commitStylePatch(/** @type {string} */ fieldId, /** @type {any} */ built) {
    if (state.locked) return failField(fieldId, 'LOCKED', '锁定层不可编辑');
    if (built.ok !== true) return failField(fieldId, built.error.code, built.error.message);
    const patch = built.patch;
    await deps.preview(patch);
    const res = await deps.commit(patch);
    if (res && res.ok) {
      state.hash = res.hash ?? state.hash;
      state.status = 'ok';
      state.error = null;
      state.fieldError = null;
      declarePending(patch);
      if (typeof built.note === 'string') state.hint = { code: 'STYLE', text: built.note };
      if (deps.overrideOf) state.override = deps.overrideOf(state.ref.at);
      renderStatusInPlace();
      scheduleReadback();
      return { ok: true, hash: state.hash };
    }
    const code = res?.code ?? 'IO';
    state.status = code === 'CONFLICT' ? 'conflict' : 'error';
    state.error = { code, message: res?.message ?? '提交失败' };
    if (res?.currentHash) state.error.currentHash = res.currentHash;
    if (typeof deps.revertPreview === 'function') await deps.revertPreview();
    renderStatusInPlace();
    return { ok: false, code };
  }

  /** 四角裁切：八个百分比输入（每角 X/Y），谁改谁提交一条 polygon。 */
  function cropControl(/** @type {any} */ field) {
    const wrap = el('div', 'insp-mask');
    wrap.setAttribute('data-crop-state', field.cropState ?? 'absent');
    const info = readCrop({ cropSpec: field.cropSpec, clipPath: field.clipPathRaw });
    const crop = info.crop ?? { tl: [0, 0], tr: [100, 0], br: [100, 100], bl: [0, 100] };

    const head = el('div', 'insp-mask-head');
    head.appendChild(el('span', 'insp-mask-state', info.state === 'custom' ? '手写 polygon' : '四角'));
    const btn = (/** @type {string} */ label, /** @type {string} */ act) => {
      const b = /** @type {HTMLButtonElement} */ (el('button', 'insp-eff-btn', label));
      b.type = 'button';
      b.setAttribute('data-crop-action', act);
      b.setAttribute('data-testid', `inspector-crop-${act}`);
      b.addEventListener('click', () => {
        state.pending = state.pending.then(() => commitStylePatch('cropCorners', cropPatch({ clipPath: field.clipPathRaw, cropSpec: field.cropSpec }, /** @type {any} */ (act)))).catch(() => {});
      });
      return b;
    };
    head.appendChild(btn('重置', 'reset'));
    head.appendChild(btn('清除', 'remove'));
    wrap.appendChild(head);

    if (info.state === 'custom') {
      const note = el('p', 'insp-note', info.note);
      note.setAttribute('data-crop-note', 'custom');
      wrap.appendChild(note);
    }

    for (const corner of CROP_CORNERS) {
      const line = el('div', 'insp-mask-row insp-crop-row');
      line.setAttribute('data-crop-corner', corner.id);
      line.appendChild(el('span', 'insp-mask-label', corner.label));
      for (const [i, axis] of ['x', 'y'].entries()) {
        const input = /** @type {HTMLInputElement} */ (el('input', 'inspector-input'));
        input.type = 'text';
        input.inputMode = 'decimal';
        input.value = String(crop[corner.id]?.[i] ?? '');
        input.disabled = field.editable !== true;
        input.setAttribute('data-crop-input', `${corner.id}${axis}`);
        input.setAttribute('data-testid', `inspector-crop-${corner.id}-${axis}`);
        const commit = () => {
          const raw = Number(input.value);
          if (!Number.isFinite(raw)) {
            failField('cropCorners', 'INVALID_VALUE', `${corner.label} ${axis.toUpperCase()} 需要数字（收到「${input.value}」）`);
            return;
          }
          const params = { [`${corner.id}${axis}`]: raw };
          state.pending = state.pending
            .then(() => commitStylePatch('cropCorners', cropPatch({ clipPath: field.clipPathRaw, cropSpec: field.cropSpec }, 'set', params)))
            .catch(() => {});
        };
        input.addEventListener('change', commit);
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        });
        line.appendChild(input);
      }
      wrap.appendChild(line);
    }
    return wrap;
  }

  /** 换源：一条 `content: url(…)`。只收工程内相对路径 / data:image（白名单在 inspector-image.mjs）。 */
  function mediaControl(/** @type {any} */ field) {
    const wrap = el('div', 'insp-mask');
    const info = readMedia({ mediaSpec: field.mediaSpec, content: field.contentRaw });
    const head = el('div', 'insp-mask-head');
    head.appendChild(el('span', 'insp-mask-state', info.state === 'replaced' ? '已换源' : info.state === 'custom' ? '手写 content' : '原素材'));
    if (info.state === 'replaced') {
      const back = /** @type {HTMLButtonElement} */ (el('button', 'insp-eff-btn', '换回原素材'));
      back.type = 'button';
      back.setAttribute('data-testid', 'inspector-media-restore');
      back.addEventListener('click', () => {
        state.pending = state.pending
          .then(() => commitStylePatch('mediaSrc', mediaPatch({ mediaSpec: field.mediaSpec }, { action: 'restore' })))
          .catch(() => {});
      });
      head.appendChild(back);
    }
    wrap.appendChild(head);

    const line = el('div', 'insp-crop-row insp-media-row');
    const input = /** @type {HTMLInputElement} */ (el('input', 'inspector-input'));
    input.type = 'text';
    input.value = info.src;
    input.placeholder = 'assets/xxx.png';
    input.disabled = field.editable !== true;
    input.setAttribute('data-testid', 'inspector-media-src');
    const go = () => {
      state.pending = state.pending
        .then(() => commitStylePatch('mediaSrc', mediaPatch({ mediaSpec: field.mediaSpec }, { action: 'set', src: input.value })))
        .catch(() => {});
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); go(); }
    });
    line.appendChild(input);
    const btn = /** @type {HTMLButtonElement} */ (el('button', 'insp-eff-btn', '换源'));
    btn.type = 'button';
    btn.setAttribute('data-testid', 'inspector-media-set');
    btn.addEventListener('click', go);
    line.appendChild(btn);
    wrap.appendChild(line);

    const note = el('p', 'insp-eff-note', '换源只改这一层的内容；新素材比当前框小会被拉伸/留白，一次 /ops，可一步撤销');
    note.setAttribute('data-media-note', '1');
    wrap.appendChild(note);
    return wrap;
  }

  function paramsOf(/** @type {any} */ field) {
    return field.effectParams ?? null;
  }

  /**
   * 文档里的蒙版原文（**写盘的真相**）：条目 style 的 `--oc-mask`。
   *
   * R155 · M18：只要还有**未作废**的声明，它就是最新一份文档（提交成功才算声明；
   * 撤销/外部写入会让 doc hash 离开声明时的 hash，`reconcilePending()` 会先把它作废）。
   * 宿主条目 `deps.overrideOf` 会滞后一拍，直接拿它当底座会把上一份形状带回来
   * （M11A/canvas/commit-content 回退到 star 就是这条）。
   * @returns {string|null}
   */
  function docMaskSpec(/** @type {string} */ at = state.ref?.at ?? '') {
    const pending = state.pendingStyle[MASK_PROP];
    if (typeof pending === 'string' && pending.trim() !== '') return pending;
    if (typeof deps.overrideOf !== 'function' || at === '') return null;
    const entry = deps.overrideOf(at);
    const raw = entry?.style?.[MASK_PROP];
    return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
  }

  /**
   * 乐观声明与文档对齐（R151 · M17）。
   *
   * `pendingStyle` 是「我刚写、还没被证实」的声明，用来顶住提交后那一小段读回空窗。
   * 但它以前**没有过期机制**：按一次撤销（或别的线写同一层）之后，文档已经回到 `rot=0`，
   * 声明还写着 `rot=45.81`；下一次缩放手势以它为底座，就把旧旋转一起写回去
   * —— R147 遗留的那条 knownRed 就是这条。
   *
   * 规则：声明先被文档证实过（`pendingSeen`），之后文档给出不同值 → 声明作废、文档为准。
   * 没证实过就不动（在途写、读回早于落盘都长这样）。作废记录留在 `pendingDropped`，
   * 量具能直接看到「哪一条、声明值、文档值」。
   * @param {any} [entry] 文档条目（`deps.overrideOf(at)`）；不传就现取
   * @returns {any[]} 这次作废的条目
   */
  function reconcilePending(entry = null, at = '') {
    const keys = Object.keys(state.pendingStyle);
    if (keys.length === 0) return [];
    /* R155 · M18：按**声明的归属元素**取文档条目，不按「此刻选中」。
       应用/撤销都可能让选中短暂变空或换层；按当前选中取会把对账直接跳过。 */
    const target = at !== '' ? at : (state.pendingAt !== '' ? state.pendingAt : (state.ref?.at ?? ''));
    const resolved = entry ?? (typeof deps.overrideOf === 'function' && target !== '' ? deps.overrideOf(target) : null);
    const style = /** @type {Record<string, string>} */ (resolved?.style ?? {});
    /* R155 · M18：**doc hash 是确定性信号**。声明记下提交回包的 hash；之后 App 的当前 hash
       变了（撤销/重做/别的线写同一层），这条声明就不是文档里那份了 —— 直接作废，
       不再依赖「先在某次读回里看见它」那道容易错过的闸。 */
    const currentHash = typeof deps.hashOf === 'function' ? String(deps.hashOf() ?? '') : '';
    const hashMoved = state.pendingHash !== '' && currentHash !== '' && currentHash !== state.pendingHash;
    const squash = (/** @type {unknown} */ value) => String(value ?? '').replace(/\s+/g, '').toLowerCase();
    const dropped = [];
    for (const key of keys) {
      const docValue = style[key];
      if (hashMoved) {
        dropped.push({ key, pending: state.pendingStyle[key], doc: typeof docValue === 'string' ? docValue : null, why: 'HASH_MOVED' });
        delete state.pendingStyle[key];
        delete state.pendingSeen[key];
        continue;
      }
      if (typeof docValue !== 'string' || docValue === '') continue;
      if (squash(docValue) === squash(state.pendingStyle[key])) {
        state.pendingSeen[key] = true;
        continue;
      }
      if (state.pendingSeen[key] !== true) continue;
      dropped.push({ key, pending: state.pendingStyle[key], doc: docValue });
      delete state.pendingStyle[key];
      delete state.pendingSeen[key];
    }
    if (dropped.length > 0) {
      state.pendingDropped = { at: target, items: dropped };
      if (Object.keys(state.pendingStyle).length === 0) {
        state.pendingAt = '';
        state.pendingHash = '';
      }
    }
    return dropped;
  }

  /**
   * 记下「我刚写、还没被证实」的声明（R151 · M17）。
   *
   * 同一个键重新声明时**必须撤掉「已证实」标记**：那是给上一份值打的，套到新值上会让
   * 「文档还停在上一份」被误判成撤销（实测：m12 的 resize 起点被读成默认 40×60，
   * 因为一次误作废让模型回落到更旧的条目）。
   * @param {any} patch
   */
  function declarePending(patch) {
    /* 归属优先取当前选中；瞬时空选中（App 在 pointerup 后插一帧）时沿用上一次的归属，
       不能把声明记到空字符串上——那样后续采样全被跳过。 */
    const at = state.ref?.at || state.pendingAt || '';
    state.pendingAt = at;
    /* R155 · M18：记下这一笔落盘后的 doc hash（App 的当前 hash，提交成功时已更新）。
       之后 hash 一变就整份作废 —— 不靠读回「先看见」那道闸。 */
    state.pendingHash = typeof deps.hashOf === 'function' ? String(deps.hashOf() ?? '') : String(state.hash ?? '');
    for (const [key, value] of Object.entries(/** @type {Record<string, string>} */ (patch?.style ?? {}))) {
      state.pendingStyle[key] = String(value);
      /* 只有读回采样能把它标成「已证实」：提交回包不等于宿主条目已刷新，
         提前标 true 会让下一次读回把在途写入误判成撤销（m11a 的形状会回退）。 */
      state.pendingSeen[key] = false;
    }
    confirmPendingLater(at);
  }

  /**
   * 声明之后补两次采样：提交回包 → 宿主把新 doc 刷进 `overrideOf` 之间有一小段延迟，
   * 只靠读回那一次采样会漏确认（那时文档条目还是上一份）。这里**只确认、不作废**。
   * @param {string} at
   */
  function confirmPendingLater(at) {
    if (typeof globalThis.setTimeout !== 'function') return;
    const tick = () => {
      /* R155 · M18：按**声明归属**取条目；不再因为「此刻选中不是它」而放弃证实。 */
      const target = state.pendingAt || at;
      if (target === '') return;
      const entry = typeof deps.overrideOf === 'function' ? deps.overrideOf(target) : null;
      const style = /** @type {Record<string, string>} */ (entry?.style ?? {});
      const squash = (/** @type {unknown} */ value) => String(value ?? '').replace(/\s+/g, '').toLowerCase();
      for (const key of Object.keys(state.pendingStyle)) {
        if (typeof style[key] !== 'string' || style[key] === '') continue;
        if (squash(style[key]) === squash(state.pendingStyle[key])) state.pendingSeen[key] = true;
      }
    };
    globalThis.setTimeout(tick, 350);
    globalThis.setTimeout(tick, 900);
    /* 队列提交 → 宿主 doc 刷新可能晚于 900ms（实测 m17 的 step2 在 900ms 时还没证实）。
       再补一拍，只确认、不作废。 */
    globalThis.setTimeout(tick, 1600);
  }

  /**
   * 重选之后补几次对账（R151 · M17）。
   *
   * 为什么不能只对一次：`select()` 是**因为 hash 变了**才跑起来的，而宿主手里的文档条目
   * 要等它自己刷新完才更新 —— 撤销那一拍进来时，条目往往还是**撤销前**的值（正好等于声明），
   * 一比对就「确认」了，永远判不出作废（实测 `pendingDropped` 一直是 null）。
   * 所以隔几拍各看一次：文档刷新落地之后那几次就能看见「文档已经另走一步」。
   * @param {string} at
   */
  function reconcileSoon(/** @type {string} */ at) {
    if (typeof globalThis.setTimeout !== 'function') return;
    for (const delay of [150, 450, 1000, 1800]) {
      globalThis.setTimeout(() => {
        /* R155 · M18：按声明归属对账；选中变空/换层不阻断（撤销后 App 可能先清一次选中）。 */
        const target = state.pendingAt || at;
        if (target === '') return;
        const dropped = reconcilePending(typeof deps.overrideOf === 'function' ? deps.overrideOf(target) : null, target);
        if (dropped.length === 0) return;
        /* 草稿也跟着作废：它是按上一份文档拖出来的。手势正在进行时不碰它。 */
        if (maskGestureActive !== true && maskDraft !== null) {
          maskDraft = null;
          maskDirty = false;
          maskDraftBase = null;
          maskDraftFor = '';
          syncMaskBar();
        }
        state.model = rebuildModel();
        state.locked = state.model.locked;
        render();
      }, delay);
    }
  }

  /**
   * 效果栈的底座原文：模型里的生效值 + 面板刚写还没被证实的声明。
   * 与 `patchOpts().base.filter` 同一份真相（都优先 `pendingStyle`）。
   */
  function cssBase() {
    const css = { ...(state.model?.adjust?.css ?? {}) };
    /** @type {Record<string, string>} */
    const aliases = {
      filter: 'filter',
      'box-shadow': 'boxShadow',
      'backdrop-filter': 'backdropFilter',
      'mask-image': 'maskImage',
      /* R125 · M11-A：蒙版参数行（自定义属性，面板与舞台同一条真值） */
      [MASK_PROP]: 'maskSpec'
    };
    for (const [key, prop] of Object.entries(aliases)) {
      if (state.pendingStyle[key] !== undefined) css[prop] = state.pendingStyle[key];
    }
    return css;
  }

  /**
   * 效果栈的一次编辑：`effectPatch`（纯函数）出 patch → 与样式字段**同一条** preview/commit 链。
   * 失败语义与 `commitField` 一致（409 → 状态栏 + 回滚预览；400 → 就地报错）。
   * @param {any} field @param {'add'|'set'|'remove'|'reset'|'toggle'} action @param {any} params
   */
  async function commitEffect(field, action, params) {
    if (state.locked) return failField(field.id, 'LOCKED', '锁定层不可编辑');
    const built = effectPatch(cssBase(), field.effectKind, action, params);
    if (built.ok !== true) return failField(field.id, built.error.code, built.error.message);
    if (built.unchanged === true) return { ok: true, unchanged: true };
    const patch = built.patch;
    await deps.preview(patch);
    const res = await deps.commit(patch);
    if (res && res.ok) {
      state.hash = res.hash ?? state.hash;
      state.status = 'ok';
      state.error = null;
      state.fieldError = null;
      declarePending(patch);
      if (typeof built.note === 'string') state.hint = { code: 'EFFECT', text: built.note };
      if (deps.overrideOf) state.override = deps.overrideOf(state.ref.at);
      renderStatusInPlace();
      scheduleReadback();
      return { ok: true, hash: state.hash };
    }
    const code = res?.code ?? 'IO';
    state.status = code === 'CONFLICT' ? 'conflict' : 'error';
    /** @type {{code: string, message: string, currentHash?: string}} */
    state.error = { code, message: res?.message ?? '提交失败' };
    if (res?.currentHash) state.error.currentHash = res.currentHash;
    if (code === 'CONFLICT' && typeof deps.onConflict === 'function') {
      deps.onConflict({ currentHash: res.currentHash, message: res.message });
    }
    if (typeof deps.revertPreview === 'function') await deps.revertPreview();
    state.model = rebuildModel();
    state.locked = state.model.locked;
    render();
    return { ok: false, code, currentHash: res?.currentHash, message: state.error.message };
  }

  function renderStatus() {
    const box = el('div', 'inspector-status', statusText());
    box.setAttribute('data-status', state.status);
    box.setAttribute('data-code', state.error?.code ?? '');
    box.setAttribute('data-current-hash', state.error?.currentHash ?? '');
    box.setAttribute('data-persist', PANEL_PERSISTENCE);
    return box;
  }

  function statusText() {
    if (state.status === 'ok') return `已提交 · ${state.hash ?? ''}`;
    if (state.status === 'conflict') return `冲突：工程已被改过（当前 hash ${state.error?.currentHash ?? '未知'}）`;
    if (state.status === 'error') return `${state.error?.code ?? '错误'}：${state.error?.message ?? ''}`;
    return '未改动';
  }

  /**
   * 只更新根属性与状态条（R11 · A2）。
   *
   * 提交成功后**不**重建字段：`render()` 会把 `root.textContent` 清空再画，
   * 正在输入的框会被换掉（焦点/未提交的键入一起丢）。连改多键时这就是
   * 「第三笔根本没发出去」的帮凶之一。状态条是独立节点，就地改文本即可。
   */
  function renderStatusInPlace() {
    root.setAttribute('data-status', state.status);
    root.setAttribute('data-hash', state.hash ?? '');
    root.setAttribute('data-locked', String(state.locked));
    const box = root.querySelector('.inspector-status');
    if (box === null) return;
    box.textContent = statusText();
    box.setAttribute('data-status', state.status);
    box.setAttribute('data-code', state.error?.code ?? '');
    box.setAttribute('data-current-hash', state.error?.currentHash ?? '');
    box.setAttribute('data-persist', PANEL_PERSISTENCE);
  }

  /**
   * 提交后的读回链（R11 · A2）：`describe → rebuildModel → render` 排在**独立**的链上，
   * 不占 `state.pending`（提交链）。
   *
   * 为什么必须分开：hash 一变舞台 iframe 就重建，`deps.describe` 要先等 stageReady
   * （最多 3s）再发请求；实测一次读回把下一笔提交挡住 **5.3s**——用户在 300ms 内
   * 连改三键，第三笔的 `/ops` 在观察窗口里根本没发出去（s137 T3 的真因）。
   *
   * 期间用户换了层（`state.ref` 变了）就丢弃这次读回，别把旧层的字段画到新层上。
   */
  function scheduleReadback() {
    const ref = state.ref;
    readback = readback
      .then(async () => {
        if (ref === null || state.ref !== ref || state.mode === 'multi') return;
        /* 换 hash 时舞台 iframe 正在重建：**第一次 describe 可能打到旧帧**（读回旧值）。
           所以先等一拍；如果还有「刚写、没被证实」的声明对不上，再等久一点重读一次。
           两次都失败就用手上这份（宁可显示旧值，也不卡死读回链）。 */
        await new Promise((done) => setTimeout(done, 160));
        let refreshed = await deps.describe(ref);
        if (state.ref !== ref) return;
        const pendingKeys = Object.keys(state.pendingStyle);
        const squashValue = (/** @type {unknown} */ value) => String(value ?? '').replace(/\s+/g, '').toLowerCase();
        const stalePending = () => {
          if (pendingKeys.length === 0) return false;
          const fresh = /** @type {Record<string, string>} */ (refreshed?.style ?? {});
          return pendingKeys.some((key) => fresh[key] !== undefined && squashValue(fresh[key]) !== squashValue(state.pendingStyle[key]));
        };
        if (stalePending()) {
          await new Promise((done) => setTimeout(done, 520));
          const again = await deps.describe(ref);
          if (state.ref !== ref) return;
          if (again && !again.error) refreshed = again;
        }
        if (refreshed && !refreshed.error) state.described = refreshed;
        /* R151 · M17：读回 = 文档现在长什么样的一次采样：证实声明，或判它作废。 */
        reconcilePending(typeof deps.overrideOf === 'function' ? deps.overrideOf(ref.at) : null, ref.at);
        /* 乐观值**不在这里清**：读回可能早于舞台重画，拿旧 computed 当底座会把上一项丢掉。
           清它的时机只有两个：换层，或调用方显式 `refresh()`（见 refresh 的注释）。 */
        state.model = rebuildModel();
        state.locked = state.model.locked;
        /* 用户正在某个输入框里打字：这次读回**只更新模型**，不重画（重画会把输入框连焦点一起换掉，
           四个角/两条调色连着改时尤其致命）。失焦后的下一次提交/读回再画。 */
        const focused = doc.activeElement;
        const typing = focused !== null && focused !== undefined
          && root.contains(focused)
          && /^(INPUT|SELECT|TEXTAREA)$/.test(String(focused.tagName ?? ''));
        if (!typing) render();
      })
      .catch(() => {});
    return readback;
  }

  /** 元素/片段那排降为**次级**：只加一个类（样式在上面注入的那套里）。可重复调用。 */
  function demotePaneTabs() {
    const doc = root.ownerDocument;
    if (!doc) return;
    const col = root.closest('[data-testid="inspector"]');
    const bar = col === null ? null : col.querySelector('.insp-tabs');
    if (bar !== null && bar.classList.contains('secondary') !== true) bar.classList.add('secondary');
    /* 检查器列本身是滚动区：给它 tabindex，键盘也能滚达（Chromium 只对**能滚动**的
       元素隐式 focusable；页签化之后 1920 宽下内容不再溢出，隐式资格会消失）。 */
    if (col !== null && !col.hasAttribute('tabindex')) col.setAttribute('tabindex', '0');
  }

  /**
   * 对象页签条（文本/属性/调节/效果/高级）。
   * 只是视图分流：切页签不动 target、不重选中、不发请求（`s210 · B2` 钉住）。
   * @param {any} model
   */
  function objectTabs(model) {
    const bar = el('div', 'insp-objtabs');
    bar.setAttribute('data-testid', 'inspector-object-tabs');
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', '对象分组');
    const tabs = Array.isArray(model.tabs) && model.tabs.length > 0 ? model.tabs : OBJECT_TABS;
    for (const tab of tabs) {
      const btn = /** @type {HTMLButtonElement} */ (el('button', 'insp-objtab'));
      btn.type = 'button';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('data-object-tab', tab.id);
      btn.setAttribute('data-testid', `inspector-object-${tab.id}`);
      btn.setAttribute('data-count', String(tab.count ?? 0));
      const on = tab.id === state.activeTab;
      btn.setAttribute('aria-selected', String(on));
      if (on) btn.classList.add('active');
      btn.textContent = tab.label;
      btn.title = `${tab.label}（${tab.count ?? 0} 项）`;
      btn.addEventListener('click', () => {
        if (state.activeTab === tab.id) return;
        state.activeTab = tab.id;
        render();
      });
      bar.appendChild(btn);
    }
    return bar;
  }

  /**
   * 有「未结算的手势」时，重画要把**蒙版画布**钉回原来的屏幕位置。
   *
   * `render()` 是「清空再画」：过程中内容会短暂塌成零高（`pointerup` 前后 App 还会插一帧
   * 「未选中图层」），列上的 `scrollTop` 因此被钳到 0 —— 用户刚在折叠线以下拖完蒙版，
   * 一松手面板就跳回顶部，「应用」跑到视口外面（实测按钮 y=1493，视口高 900）。
   * 锚点记的是**按下时**画布的屏幕 y（不是重画时）：那一帧画布已经不在了，
   * 现场取不到（实测 `hadCanvas:false`）。只在这个窗口内动滚动，别的时候一次都不碰。
   */
  /** 按下时画布在屏幕上的 y；`null` = 没有未结算的手势。 */
  /** @type {number|null} */
  let maskAnchorTop = null;

  /**
   * 目标失效时的面板态（R143 · A3）：根属性 + 提示条 + **真禁用**编辑控件。
   *
   * 判据只认「已经发生过的拒绝/读不到」：`state.status === 'error'` 且码在
   * `TARGET_INVALID_CODES` 里。成功提交或重选一层会把 `state.error` 清掉，
   * 这个态自然消失——它不是一个需要手动关的开关。
   */
  function applyTargetInvalidState() {
    const code = state.status === 'error' ? String(state.error?.code ?? '') : '';
    const invalid = TARGET_INVALID_CODES.has(code);
    root.setAttribute('data-target-invalid', invalid ? '1' : '0');
    root.setAttribute('data-target-invalid-code', invalid ? code : '');
    if (!invalid) return;
    /* 提示条放在面板第一行：用户不用滚到底才知道「这一层写不了了」。 */
    let box = root.querySelector('.insp-target-invalid');
    if (box === null) {
      box = el('div', 'insp-target-invalid');
      root.insertBefore(box, root.firstChild);
    }
    box.setAttribute('data-code', code);
    box.textContent = '';
    const title = el('code', '', code);
    box.appendChild(title);
    const hint = /** @type {Record<string, string>} */ (TARGET_INVALID_HINT)[code] ?? String(state.error?.message ?? '');
    box.appendChild(doc.createTextNode(`：${hint}`));
    /* UI 禁用 ≠ 写入口保护：这一句必须跟着提示出现，别让人以为面板就是闸门。 */
    box.appendChild(el('span', 'insp-target-invalid-tail', 'UI 禁用只是提示；真正的保护在写入口（服务端拒绝，磁盘未写）。'));
    for (const node of root.querySelectorAll('input, select, textarea, button')) {
      /* 页签是导航（换页签不该被禁用），其余可改控件一律真禁用。 */
      if (node.closest('.insp-tabs, .insp-objtabs') !== null) continue;
      /** @type {any} */ (node).disabled = true;
    }
  }

  function render() {
    const scrollHost = /** @type {HTMLElement|null} */ (root.closest('[data-testid="inspector"]'));
    paintPanel();
    applyTargetInvalidState();
    /* R158：App 那两块（图层行 / 元素·片段 chip）与片段段的「高级」开关，每次重画补一次。 */
    syncChrome();
    if (scrollHost === null || maskAnchorTop === null) return;
    const place = () => {
      /* 只在「被清空钳到顶」时补一次：`scrollTop > 2` 说明用户/量具已经滚到别处，
         再补就会和滚动打架（实测把点击目标顶到隔壁按钮上）。 */
      if (scrollHost.scrollTop > 2) return;
      const now = root.querySelector('[data-testid="inspector-mask-canvas"]');
      if (now === null) return;
      const delta = now.getBoundingClientRect().top - /** @type {number} */ (maskAnchorTop);
      if (Math.abs(delta) > 1) scrollHost.scrollTop += delta;
    };
    place();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(place);
  }

  /**
   * 对象名（R151 · M17 · B）：**与 `data-at` 同源** —— 都从这一次读回算。
   *
   * 名字不取调用方带来的 `ref.name`（那是上层快照，文档重建后可能还指着旧元素），
   * 而是「选择器里的 id + 这一次 describe 的 tag / 文本」。于是面板上显示的对象名
   * 和 `data-at` 永远描述同一个元素；App 头部那个下拉归 MAIN（M16-A），这里不另造控件。
   * @param {string} at
   * @param {any} described
   * @returns {string}
   */
  function objectNameOf(at, described) {
    if (typeof at !== 'string' || at === '') return '';
    const tag = String(described?.tag ?? '').toLowerCase();
    const id = /#([A-Za-z0-9_-]+)/.exec(at)?.[1] ?? '';
    const text = String(described?.text ?? '').replace(/\s+/g, ' ').trim();
    const head = `${tag === '' ? 'element' : tag}${id === '' ? '' : `#${id}`}`;
    return text === '' ? head : `${head} ${text.slice(0, 16)}`;
  }

  function paintPanel() {
    root.textContent = '';
    demotePaneTabs();
    root.setAttribute('data-mode', state.mode);
    root.setAttribute('data-at', state.ref?.at ?? '');
    /* R151 · M17 · B：对象名与 data-at 同源（同一次读回），并且明写来源，量具可核。 */
    root.setAttribute('data-object-name', state.mode === 'multi' ? '' : objectNameOf(state.ref?.at ?? '', state.described));
    root.setAttribute('data-object-name-source', state.mode === 'multi' ? 'multi' : 'describe');
    root.setAttribute('data-locked', String(state.locked));
    root.setAttribute('data-status', state.status);
    root.setAttribute('data-hash', state.hash ?? '');
    root.setAttribute('data-persist', PANEL_PERSISTENCE);
    root.setAttribute('data-count', String(state.mode === 'multi' ? state.items.length : state.ref ? 1 : 0));

    /* 多选：另一套渲染（单选那条路径一个字节都不动，A7 有回归用例） */
    if (state.mode === 'multi') {
      headHost.textContent = '';
      headHost.setAttribute('data-empty', '1');
      renderMulti();
      root.appendChild(renderStatus());
      return;
    }

    const model = state.model;
    if (!model) {
      headHost.textContent = '';
      headHost.setAttribute('data-empty', '1');
      root.appendChild(el('div', 'inspector-empty', '未选中图层'));
      root.appendChild(renderStatus());
      return;
    }

    /* R121 · M7-B（D02）：**对象页签**（文本/属性/调节/效果/高级）。
       R158：页签条挂在容器外的 `.r158-insp-head`（App 的 `layer-picker` 之前）——
       它是检查器的**第一行**，不再被「元素/片段」那一行挤到第二行。
       元素/片段那排由 App 画，面板只把它降成右上角 chip（`data-r158-chip`）。 */
    root.setAttribute('data-object-tab', state.activeTab);
    headHost.textContent = '';
    headHost.removeAttribute('data-empty');
    if (!deps.externalTabs) headHost.appendChild(objectTabs(model));
    /* R155 · M18 · B：**可见**对象名 —— 与 `data-at` 取自同一次 describe 读回。
       只加一行只读文本，不加第二个标题/下拉控件；App 头部那个下拉仍归 MAIN（M16-A）。 */
    const visibleName = objectNameOf(state.ref?.at ?? '', state.described);
    if (visibleName !== '') {
      const nameLine = el('div', 'insp-object-name');
      nameLine.setAttribute('data-testid', 'inspector-object-name');
      nameLine.setAttribute('data-object-name-visible', visibleName);
      nameLine.setAttribute('data-object-name-at', state.ref?.at ?? '');
      nameLine.setAttribute('title', `${visibleName}（${state.ref?.at ?? ''}）`);
      nameLine.textContent = visibleName;
      root.appendChild(nameLine);
    }

    for (const group of model.groups) {
      const inTab = group.fields.filter((/** @type {any} */ field) => (field.tab ?? 'props') === state.activeTab);
      if (inTab.length === 0) continue;
      /* R165 · INSP：两级分类 —— 对象（上面的对象头一行）→ 组 → 字段。
         组是可折叠的 `<details>`（默认展开，字段一开始就全在；收起状态记忆在 `state.closedGroups`，
         重绘/换页签都按用户的选择还原，不会每次刷新又弹开）。
         `summary` 是组标题：吸顶、带箭头与字段数；只加结构，不改任何字段/handler/只读语义。 */
      const section = /** @type {HTMLDetailsElement} */ (el('details', 'inspector-group'));
      section.setAttribute('data-group', group.id);
      /* 折叠记忆复用多选那条路已有的 `GROUP_COLLAPSED`（getState().collapsed 也读它），
         不另造第二份状态；重绘/换页签都按用户的选择还原。 */
      section.open = GROUP_COLLAPSED.has(group.id) !== true;
      section.setAttribute('data-open', section.open ? '1' : '0');
      const summary = el('summary', 'inspector-group-label');
      summary.setAttribute('data-group-toggle', group.id);
      summary.appendChild(el('span', 'insp-group-chevron', ''));
      summary.appendChild(el('span', 'insp-group-name', group.label));
      summary.appendChild(el('span', 'insp-group-count', String(inTab.length)));
      summary.setAttribute('title', `${group.label} · ${inTab.length} 个字段（点标题展开/收起）`);
      section.appendChild(summary);
      section.addEventListener('toggle', () => {
        section.setAttribute('data-open', section.open ? '1' : '0');
        if (section.open) GROUP_COLLAPSED.delete(group.id);
        else GROUP_COLLAPSED.add(group.id);
      });
      const fieldsGrid = el('div', 'insp-fields-grid');
      section.appendChild(fieldsGrid);
      /** 组内小标题：字段带 `section` 时，值变化处插一条（外观组里分 外观 / 描边 / 调节 / 效果）。 */
      let lastSection = '';
      for (const field of inTab) {
        if (typeof field.section === 'string' && field.section !== lastSection) {
          lastSection = field.section;
          const sub = el('h4', 'insp-sub', field.section);
          sub.setAttribute('data-insp-sub', field.section);
          fieldsGrid.appendChild(sub);
          /* R121 · M7-A（D06）：顺序固定就说出来 —— 不画拖拽手柄，也不让用户猜「为什么拖不动」。
             文案只在「效果」这一段的段标题下出现一次。 */
          if (field.section === '效果') {
            const orderNote = el('p', 'insp-eff-order', '顺序固定（1–5）：不支持拖排');
            orderNote.setAttribute('data-effect-order-note', '1');
            fieldsGrid.appendChild(orderNote);
          }
        }
        const row = el('label', 'inspector-field');
        row.setAttribute('data-field', field.id);
        row.setAttribute('data-control-kind', field.control ?? 'value');
        row.setAttribute('data-source', field.source);
        row.setAttribute('data-editable', String(field.editable));
        row.setAttribute('data-unit', field.unit);
        row.setAttribute('data-locked-reason', field.lockedReason ?? '');
        row.setAttribute('data-kind', field.kind ?? 'override');
        if (typeof field.section === 'string') row.setAttribute('data-insp-section', field.section);
        /* B02 / 只读原因矩阵：第四列「改哪里」。x/y/w/h 写 overrides.style，
           其余（旋转/文本/样式）走 /ops 的常规字段；锁定层统一「先解锁」。 */
        const pageGeoRow = field.kind === 'box' && isPageGeometryField(field.id);
        row.setAttribute(
          'data-where',
          field.editable ? (pageGeoRow ? '本页签直接改（overrides.style）' : '本页签直接改（/ops）') : '先解锁图层'
        );
        if (field.kind === 'box') {
          row.setAttribute('data-box-key', field.boxKey);
          row.setAttribute('data-style-prop', field.styleProp);
          row.setAttribute('data-declared', String(field.declared));
          /* S15：值来自「声明」还是「实测」；输入的是屏幕像素还是声明值 */
          row.setAttribute('data-source-label', field.sourceLabel);
          row.setAttribute('data-space', field.space);
        }
        /* R20（B2）：label 与 space-chip 同占**第 1 格**（22px）。
           原来 chip 是行的第 4 个子节点，会换到第 2 行，把 X/Y/宽/高/旋转 撑到 73.69
           （其余行 30）。并进这一格后行高回到 30，且列宽一个像素不动。
           `.inspector-field-label` 本身仍是**纯文本** —— s124 的 `labels.film` 读它的
           textContent，chip 放在外层 `.inspector-field-label-cell` 里，不会污染那 27 条。 */
        const labelCell = el('span', 'inspector-field-label-cell');
        labelCell.appendChild(fieldLabel(field.label));
        if (field.unit === '色值' && globalThis.CSS?.supports('color', field.current)) {
          const swatch = el('span', 'insp-color-swatch');
          swatch.style.backgroundColor = field.current;
          swatch.setAttribute('aria-hidden', 'true');
          labelCell.appendChild(swatch);
        }
        row.appendChild(labelCell);

        /* R113 · L2：效果栈的行是**一小组控件**（添加/启停/删除/重置 + 参数），不是单个输入框。
           行本身仍带 data-field / data-editable / data-where，只读原因矩阵照样能抽到它。 */
        if (field.control === 'effect') {
          row.appendChild(effectControl(field));
          fieldsGrid.appendChild(row);
          continue;
        }
        /* R125 · M11-A：蒙版不是一个输入框，是「形状 + 参数 + 画布」一小块。 */
        if (field.control === 'mask') {
          row.appendChild(maskControl(field));
          fieldsGrid.appendChild(row);
          continue;
        }
        /* R125 · M11-B：四角裁切（八个百分比）与换源（一条 content: url）。 */
        if (field.control === 'crop4') {
          row.appendChild(cropControl(field));
          fieldsGrid.appendChild(row);
          continue;
        }
        if (field.control === 'media') {
          row.appendChild(mediaControl(field));
          fieldsGrid.appendChild(row);
          continue;
        }

        /* 控件（S51）：下拉/数值/文本三种，事件链与 R7 完全一致（input 预览、change 提交） */
        for (const control of fieldControls(
          field,
          (/** @type {string} */ value) => {
            state.pending = state.pending.then(() => commitField(field.id, value)).catch(() => {});
          },
          (/** @type {string} */ value) => {
            /* R11 · A2：预览**不排在提交链上**。舞台 iframe 按新 hash 重建时
               `setOverrides` 要等到 5s 超时；排在它后面的 change 提交就一起被挡 5s
               （s137 T3 的第三笔：输入已 change，/ops 却迟迟不发）。 */
            previewing = previewing.then(() => previewField(field.id, value)).catch(() => {});
          }
        )) {
          row.appendChild(control);
        }
        /* B02（R108 · A25）：页面域几何**可写**——写的是元素自己的 left/top/width/height
           （overrides.style），不是片段 box。行与输入都标出写入目标，便于验收脚本区分两条路径；
           不再有 `data-readonly="page-geometry"`（S2H 的整组只读到此为止，理由见顶部常量注释）。 */
        if (field.kind === 'box' && isPageGeometryField(field.id)) {
          const writes = `overrides.style.${ELEMENT_GEOMETRY_STYLE[field.id] ?? field.id}`;
          row.setAttribute('data-geometry-target', 'element');
          row.setAttribute('data-writes', writes);
          row.setAttribute('title', ELEMENT_GEOMETRY_MESSAGE);
          for (const control of row.querySelectorAll('input')) {
            control.setAttribute('data-writes', writes);
            control.setAttribute('title', ELEMENT_GEOMETRY_MESSAGE);
          }
        }
        /* S16：单位后缀（px / 倍 / normal）。输入框里只放数字，单位不进输入值。 */
        if (field.numeric) {
          const unitText =
            field.suffix || (field.emptyState === 'normal' ? 'normal' : '') || (field.id === 'lineHeight' ? '倍' : '');
          if (unitText) {
            const unitChip = el('span', 'inspector-field-unit', unitText);
            unitChip.setAttribute('data-unit-chip', '1');
            row.appendChild(unitChip);
          }
        }
        /* R10 · A 方案第二步的**别名**：右列从此也应答旧 dock 的选择器
           （`[data-testid="field-row"][data-key=…] input.field-input`）。只加属性/类名，
           不改结构、不改值/事件/disabled；`data-alias="1"` 让「按 field-row 计数」的脚本
           能用 `:not([data-alias])` 排除，避免与仍在的左列 dock 双计。
           注意：`.field-input` 的样式全被 `.film-inspector .inspector-input`（0,2,0）盖住，
           类名只为选择器兼容，不改变右列外观。 */
        row.setAttribute('data-testid', 'field-row');
        row.setAttribute('data-key', field.id);
        row.setAttribute('data-alias', '1');
        for (const control of row.querySelectorAll('input, select')) {
          control.classList.add('field-input');
          control.setAttribute('data-alias', '1');
        }
        /* R121 · M7-B（D02）：「实测」是默认态，不该每行都挂一个（那正是把行挤成两行的元凶）。
           只留**有意义**的「覆盖」；并且并进第 1 格（R20 的 label-cell），不再当第 4 个格子。 */
        if (field.source === 'override') {
          const chip = el('span', 'inspector-field-source', '覆盖');
          chip.setAttribute('data-source-chip', 'override');
          chip.setAttribute('title', '这个值来自本工程的覆盖（不是页面原样）');
          row.setAttribute('data-has-source-chip', '1');
          labelCell.appendChild(chip);
        }
        if (field.kind === 'box') {
          /* R20（B2）：22px 的标签格放不下「宽 + 实测」（10.5 + 21 = 31.5），
             所以 chip 只显示**首字**（实 / 声），全词进 title；放不下时 chip 先让位
             （CSS 里 `flex-shrink: 1000`），标签一个字都不少。 */
          const declared = field.sourceLabel === 'declared';
          const chip = el('span', 'inspector-field-space', declared ? '声' : '实');
          chip.setAttribute('data-space-chip', '1');
          chip.setAttribute('data-space-label', declared ? '声明' : '实测');
          chip.setAttribute('title', declared ? '空间来源：声明（页面声明的值）' : '空间来源：实测（按当前布局量到的值）');
          labelCell.setAttribute('title', chip.getAttribute('title') ?? '');
          labelCell.appendChild(chip);
        }
        fieldsGrid.appendChild(row);

        /* R113 · L2：三条行内提示（缺字体回退 / 有裁切时四角锁一致 / 描边被裁 / 调色手写）。
           只在需要时多一个节点，行与字段集不变。 */
        for (const note of fieldNotes(field)) fieldsGrid.appendChild(note);

        /* R113 · L2（LI-F16）：17 种混合模式的**能力矩阵**就摆在字段下面 ——
           每个模式一颗点：绿 = 真实可见、黄 = 需下层有内容、红 = 仅透传（不支持）。 */
        if (Array.isArray(field.matrix)) {
          const grid = el('div', 'insp-blend');
          grid.setAttribute('data-testid', 'inspector-blend-matrix');
          grid.setAttribute('data-count', String(field.matrix.length));
          for (const item of field.matrix) {
            const chip = el('span', 'insp-blend-item');
            chip.setAttribute('data-blend-mode', item.mode);
            chip.setAttribute('data-capability', item.capability);
            chip.setAttribute('title', `${item.label}（${item.mode}）：${item.note}`);
            chip.appendChild(el('span', 'insp-blend-dot'));
            chip.appendChild(el('span', 'insp-blend-label', item.label));
            grid.appendChild(chip);
          }
          fieldsGrid.appendChild(grid);
        }
      }
      root.appendChild(section);
    }
    /* S2H：三种校验的就地报错——挂在出错字段那一行**下面**（与左列 `showFieldError` 同位）。
       只在出错时多一个节点；27 个 `.inspector-field` 行与分组结构不变。 */
    if (state.fieldError) {
      const failed = root.querySelector(`.inspector-field[data-field="${state.fieldError.field}"]`);
      if (failed) {
        const note = el('p', 'inspector-field-error', state.fieldError.message);
        note.setAttribute('data-testid', 'inspector-field-error');
        note.setAttribute('data-field', state.fieldError.field);
        note.setAttribute('data-code', state.fieldError.code);
        note.style.cssText =
          'margin:2px 0 6px 2px;font:11px/1.4 ui-monospace,Menlo,monospace;color:#ffb86b;white-space:normal;overflow-wrap:anywhere';
        failed.after(note);
      }
    }
    if (state.hint) {
      const hint = el('div', 'inspector-hint', state.hint.text);
      hint.setAttribute('data-hint', state.hint.code);
      root.appendChild(hint);
    }
    root.appendChild(renderStatus());
  }

  /** 用当前 ref/override/describe/声明 box 重建字段模型（select 与提交成功后共用一份）。 */
  function rebuildModel() {
    const supports =
      typeof globalThis.CSS !== 'undefined' && typeof globalThis.CSS.supports === 'function'
        ? (/** @type {string} */ property, /** @type {string} */ value) => globalThis.CSS.supports(property, value)
        : undefined;
    return buildInspector(state.ref, state.override, state.described, {
      box: state.declaredBox,
      baseBox: state.baseBox,
      boxEditable: typeof deps.commitBox === 'function',
      geometry: state.geometry && state.geometry.ok === true ? state.geometry : null,
      /* R113 · L2：能力矩阵按**本机合成器**算（预览与导出同一个 Chromium，所以两边同源）。 */
      supports,
      fontCheck: state.described?.fontCheck ?? null,
      clipped: state.described?.clipped === true,
      /* R113 · L2：刚写还没被证实的声明（见 state.pendingStyle 的注释）。 */
      pendingStyle: state.pendingStyle
    });
  }

  /** 读一次祖先坐标系（宿主没提供就返回 null，行为回到 R7）。 */
  async function readGeometry() {
    if (typeof deps.geometry !== 'function' || !state.ref) return null;
    try {
      return await deps.geometry(state.ref.at);
    } catch {
      return null;
    }
  }

  /**
   * 树里点了某层：用树节点的 kind/name/depth 拼出面板要的 ref，再走同一条 `select`。
   * 面板自己的选中逻辑只有一份，树不复制一套 describe/预览。
   * @param {string} at
   */
  async function selectFromTree(at) {
    const node = tree?.nodeOf(at) ?? null;
    const ref = {
      clipId: state.ref?.clipId ?? deps.tree?.clipId ?? '',
      at,
      kind: node?.kind ?? 'unknown',
      name: node?.name ?? at,
      depth: node?.depth ?? 1
    };
    const result = await select(ref);
    if (typeof deps.tree?.onSelect === 'function') deps.tree.onSelect(at, result);
    return result;
  }

  /**
   * 最近一个**真正选中过**的元素（`select(null)` 不算换层）。
   *
   * R147 · M16：`pointerup` 之后 App 会插一帧「未选中图层」再重新选中同一元素
   * （R136 已知的同一条路）。`select(null)` 会把 `state.ref` 清成 null，下一次
   * `select(#fx)` 的 `previousAt` 于是变成 `''` → 被当成「换层」把 `pendingStyle` 清空。
   * 清空之后模型回落到上一次读回（可能比文档旧），画布草稿就带着旧形状，
   * 「应用」把旧形状写回去 —— M11A/canvas/commit-content 就是这么红的。
   * @type {string}
   */
  let lastAt = '';

  /**
   * 选中一层：describe → 建模型 → 渲染。
   * @param {any} ref
   */
  /**
   * R161 · M19（C8）：重选后的读回要**和文档对齐**，不能只 describe 一次。
   *
   * 现象（书里给的主线定位）：写 borderRadius 30/36/42 → 重选 `#pad` → 再选 `#fx`，
   * 面板显示 36，页内与 doc 都是 42。舞台在 hash 变化后重建 iframe，重建期里
   * `describeLayer` 可能由旧帧回答；`select()` 以前只读一次，就把上一笔画到新一帧上。
   *
   * 对账口径：拿宿主手上的**文档条目**（`deps.overrideOf(at).style`）当真相，只比
   * 「两边都是同一个单位的数值」的键（`42px` vs `42px`；`#fff` vs `rgb()` 这类格式不同的
   * 一律跳过，免得每次选层都白等）。不一致就按 90 / 180ms 退避重读，**最多 3 次 describe**
   * （2 次重试）——不是「延后到 1s」，也不是无限重试；第 3 次仍不一致就用这一份（宁可显示
   * 旧值，也不卡死选择）。每次尝试都记进 `describeAttempts`，量具据此判「竞态还是缓存」。
   */
  const DESCRIBE_RETRY_DELAYS = [90, 180];
  const NUMERIC_CSS = /^(-?\d+(?:\.\d+)?)(px|deg|%|s|ms|em|rem)?$/;
  function numericCss(/** @type {unknown} */ value) {
    const m = NUMERIC_CSS.exec(String(value ?? '').trim().toLowerCase());
    return m === null ? null : { n: Number(m[1]), unit: m[2] ?? '' };
  }
  /**
   * 「这一次读回是旧的」的唯一可信判据：**面板刚写、还没被证实的声明**（`pendingStyle`）。
   * 不能拿 `deps.overrideOf` 当真相 —— 实测它比盘上慢一笔（盘上 42px、条目 36px），
   * 拿它判陈旧会把**正确的新读回**判成旧帧（R161 的对账记录就是这么暴露的）。
   */
  function staleAgainstPending(/** @type {any} */ described) {
    const style = described?.style;
    if (style === null || typeof style !== 'object') return [];
    const squash = (/** @type {unknown} */ value) => String(value ?? '').replace(/\s+/g, '').toLowerCase();
    const stale = [];
    for (const key of Object.keys(state.pendingStyle)) {
      const got = style[key];
      if (typeof got !== 'string' || got === '') continue;
      if (squash(got) !== squash(state.pendingStyle[key])) stale.push({ key, pending: state.pendingStyle[key], got });
    }
    return stale;
  }
  async function describeFresh(/** @type {any} */ ref) {
    /** @type {any[]} */
    const attempts = [];
    let described = null;
    for (let i = 0; i <= DESCRIBE_RETRY_DELAYS.length; i += 1) {
      if (i > 0) await new Promise((done) => setTimeout(done, DESCRIBE_RETRY_DELAYS[i - 1]));
      const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
      described = await deps.describe(ref);
      const stale = described && !described.error ? staleAgainstPending(described) : [];
      const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
      attempts.push({
        attempt: i + 1,
        ms: Math.round(t1 - t0),
        stale: stale.length > 0,
        mismatches: stale,
        error: described?.error?.code ?? null
      });
      if (stale.length === 0) break;
    }
    state.describeAttempts = attempts;
    return described;
  }

  /**
   * R161 · M19（C8）：宿主条目 vs 页内实测的对账。
   *
   * 只处理「两边都是同单位数值且差 >0.01」的键（`border-radius: 42px` vs `36px`）。
   * 命中说明条目落后（页内已是新值），从**副本**里删掉这个键，让字段回落到 computed；
   * 宿主状态一个字节不动（App 的 baseEntriesRef 归 MAIN）。剔除项记进 `overrideDropped`。
   */
  function reconcileEntryWithDescribe(/** @type {any} */ entry, /** @type {any} */ described) {
    if (entry === null || entry === undefined || typeof entry !== 'object') return { entry: entry ?? null, dropped: [] };
    const style = entry.style;
    const seen = described?.style;
    if (style === null || typeof style !== 'object' || seen === null || typeof seen !== 'object') {
      return { entry, dropped: [] };
    }
    /** @type {Record<string, string>} */
    const nextStyle = { ...style };
    const dropped = [];
    for (const [key, entryValue] of Object.entries(style)) {
      const want = numericCss(entryValue);
      if (want === null) continue;
      const got = numericCss(seen[key]);
      if (got === null || got.unit !== want.unit) continue;
      if (Math.abs(got.n - want.n) <= 0.01) continue;
      delete nextStyle[key];
      dropped.push({ key, entry: String(entryValue), described: String(seen[key]), at: entry.at ?? null });
    }
    return dropped.length === 0 ? { entry, dropped } : { entry: { ...entry, style: nextStyle }, dropped };
  }

  async function select(/** @type {any} */ ref) {
    /* 清空（S93）：`selectMany([])` 走的就是这里。以前直接读 `ref.at` 会抛 TypeError——
       `getState()` 已经是 0 项、DOM 却停在上一屏，「Escape 清空」在界面上看不见。 */
    if (ref === null || ref === undefined) {
      state.mode = 'single';
      state.items = [];
      state.ref = null;
      state.status = 'idle';
      state.error = null;
      state.fieldError = null;
      state.model = null;
      state.described = null;
      state.override = null;
      state.declaredBox = null;
      state.baseBox = null;
      state.geometry = null;
      state.locked = false;
      if (tree) tree.setSelected('');
      render();
      return { ok: true, mode: 'single', count: 0 };
    }
    state.mode = 'single';
    state.items = [];
    /** B02：换没换层——钳制提示只在同层重选（提交后的读回）时保留。 */
    const previousAt = lastAt;
    /* R113 · L2：换层才丢「刚写还没证实」的声明（同层 refresh 必须保留，那正是底座）。
       R147：判据用 `lastAt`（真实的上一层），不是 `state.ref`——它会被一次空选中抹成 null。 */
    if (previousAt !== ref.at) {
      state.pendingStyle = {};
      state.pendingSeen = {};
      state.pendingAt = '';
      state.pendingHash = '';
    }
    lastAt = ref.at;
    state.ref = ref;
    if (tree) tree.setSelected(ref.at);
    state.status = 'idle';
    state.error = null;
    state.fieldError = null;
    const described = await describeFresh(ref);
    if (!described || described.error) {
      state.described = null;
      state.status = 'error';
      state.error = { code: described?.error?.code ?? 'LAYER_GONE', message: described?.error?.message ?? 'describe 失败' };
      /* R143 · A3：**同一层**的读回失败（元素被删/父级卸载）保留上一份模型再禁用，
         用户能看到「最后一次读到的值」而不是整块空白；换了层还读不到就清空，
         否则会把上一层的字段画到新层上（那是更坏的错）。 */
      if (previousAt !== ref.at) state.model = null;
      render();
      return { ok: false, error: state.error };
    }
    state.described = described;
    /* R161 · M19（C8）：宿主条目（baseEntriesRef）会落后盘上一笔 —— 面板「声明值优先」，
       于是重选后显示的是上一笔（36）而页内/盘上都是 42。以**页内实测**为准把明显落后的
       数值键从这次渲染的副本里剔掉（不改宿主状态，只影响本次读回），字段回落到 computed。
       只比「同单位数值」：颜色/滤镜这类格式不同的键一律跳过。 */
    const baseEntry = deps.overrideOf ? deps.overrideOf(ref.at) : null;
    const reconciled = reconcileEntryWithDescribe(baseEntry, described);
    state.override = reconciled.entry;
    state.overrideDropped = reconciled.dropped;
    /* R151 · M17：这一次重选是**因为文档变了**（撤销/重做/别的线写入）就先把旧声明作废，
       否则 `pendingStyle` 会把上一份文档的值盖在这一次读回上（面板显示 rot=45.81，
       而盘上已经是 0 —— 下一支手势就照着假的底座写）。 */
    reconcilePending(state.override);
    reconcileSoon(ref.at);

    /* 几何基准：片段声明的 box 优先（精确），否则用实测矩形（第一次编辑会把宽高写进声明）。
       B02（R108）：**页面内元素不吃 `boxOf`** —— 宿主给的 `boxOf` 是页面片段自己的 box，
       拿它当元素的声明值会让 X/Y 显示成整页的坐标（改一次还会把整页 box 当基准）。
       页面元素的基准就是实测矩形（`describe().box`），写回走 overrides.style。 */
    let declared = null;
    if (typeof deps.boxOf === 'function' && !isPageDomain()) {
      try {
        declared = await deps.boxOf(ref.at);
      } catch {
        declared = null;
      }
    }
    state.declaredBox = declared && typeof declared === 'object' ? declared : null;
    state.geometry = await readGeometry();
    /* 没有声明 box 时用实测矩形当基准：祖先有 scale 时必须先除回声明空间，
       否则第一次编辑会把放大后的屏幕尺寸写进 style。 */
    if (state.declaredBox) {
      state.baseBox = normalizeBox(state.declaredBox);
    } else if (state.geometry && state.geometry.ok === true) {
      state.baseBox = screenBoxToDeclared(described.box, state.geometry) ?? normalizeBox(described.box);
    } else {
      state.baseBox = normalizeBox(described.box);
    }
    /* B02：钳制提示要活过「提交后的读回重选」——读回会再走一遍 select，同层重选不能
       把「X 已钳到 0」擦掉（擦掉就等于静默改值）。换层/清空才清。其他提示照旧清。 */
    const sameLayer = previousAt === (ref?.at ?? '');
    if (state.hint?.code !== 'CLAMPED' || !sameLayer) state.hint = null;

    state.model = rebuildModel();
    state.locked = state.model.locked;
    render();
    return { ok: true, model: state.model };
  }

  /* ── 多选（S26） ─────────────────────────────────────────────────────── */

  /** @param {string} groupId */
  function groupCollapsed(groupId) {
    return GROUP_COLLAPSED.has(groupId);
  }

  /** @param {string} groupId */
  function toggleGroup(groupId) {
    if (GROUP_COLLAPSED.has(groupId)) GROUP_COLLAPSED.delete(groupId);
    else GROUP_COLLAPSED.add(groupId);
    render();
    return !GROUP_COLLAPSED.has(groupId);
  }

  /** 多选里的一个字段行。与单选的行属性同名同序，额外带 `data-mixed` / `data-values` / 原因角标。 */
  /** @param {any} field */
  function multiFieldRow(field) {
    const row = el('label', 'inspector-field');
    row.setAttribute('data-field', field.id);
    row.setAttribute('data-source', field.source);
    row.setAttribute('data-editable', String(field.editable));
    row.setAttribute('data-unit', field.unit);
    row.setAttribute('data-locked-reason', field.lockedReason ?? '');
    row.setAttribute('data-kind', field.kind ?? 'override');
    row.setAttribute('data-mixed', String(field.mixed === true));
    row.setAttribute('data-values', (field.values ?? []).map((/** @type {any} */ value) => String(value)).join('|'));
    if (field.kind === 'box') {
      row.setAttribute('data-box-key', field.boxKey);
      row.setAttribute('data-style-prop', field.styleProp);
      row.setAttribute('data-declared', String(field.declared));
      row.setAttribute('data-source-label', field.sourceLabel);
      row.setAttribute('data-space', field.space);
    }
    if (!field.editable) {
      const text = PANEL_REASONS[/** @type {keyof typeof PANEL_REASONS} */ (field.lockedReason ?? '')] ?? field.lockedReason ?? '';
      row.setAttribute('title', `${field.lockedReason ?? 'LOCKED'}：${text}`);
    }
    row.appendChild(fieldLabel(field.label));

    /* 多选：同一套控件，提交走 commitMultiField（一批 op、一步撤销），不逐键预览 */
    for (const control of fieldControls(
      field,
      (/** @type {string} */ value) => {
        state.pending = state.pending.then(() => commitMultiField(field.id, value)).catch(() => {});
      },
      null
    )) {
      control.setAttribute('data-mixed', String(field.mixed === true));
      row.appendChild(control);
    }

    if (field.numeric) {
      const unitText =
        field.suffix || (field.emptyState === 'normal' ? 'normal' : '') || (field.id === 'lineHeight' ? '倍' : '');
      if (unitText) {
        const chip = el('span', 'inspector-field-unit', unitText);
        chip.setAttribute('data-unit-chip', '1');
        row.appendChild(chip);
      }
    }
    row.appendChild(el('span', 'inspector-field-source', field.mixed ? '多个值' : field.source === 'override' ? '覆盖' : '实测'));
    if (field.kind === 'box') {
      const chip = el('span', 'inspector-field-space', field.sourceLabel === 'declared' ? '声明' : '实测');
      chip.setAttribute('data-space-chip', '1');
      row.appendChild(chip);
    }
    /* 原因码要「看得见」，不能只靠 hover */
    if (!field.editable && field.lockedReason) {
      const reason = el('span', 'inspector-field-reason', field.lockedReason);
      reason.setAttribute('data-reason-chip', field.lockedReason);
      reason.style.cssText = 'color:#ffb86b;font:11px/1.4 ui-monospace,Menlo,monospace;margin-left:4px';
      row.appendChild(reason);
    }
    return row;
  }

  function renderMulti() {
    const model = state.model;
    const summary = el('div', 'inspector-multi-summary');
    summary.setAttribute('data-multi-count', String(state.items.length));
    summary.setAttribute('data-mixed-count', String(model?.mixedCount ?? 0));
    summary.textContent = model
      ? `已选 ${state.items.length} 层 · ${model.mixedCount} 个字段值不同`
      : `已选 ${state.items.length} 层`;
    root.appendChild(summary);

    if (!model || model.fields.length === 0) {
      root.appendChild(el('div', 'inspector-empty', '多选里没有可编辑字段'));
      return;
    }

    for (const group of model.groups) {
      const section = el('section', 'inspector-group');
      section.setAttribute('data-group', group.id);
      const collapsed = groupCollapsed(group.id);
      section.setAttribute('data-collapsed', String(collapsed));

      const head = /** @type {HTMLButtonElement} */ (el('button', 'inspector-group-toggle'));
      head.type = 'button';
      head.setAttribute('data-group-toggle', group.id);
      head.setAttribute('aria-expanded', String(!collapsed));
      head.textContent = `${collapsed ? '▸' : '▾'} ${group.label}（${group.fields.length}）`;
      head.style.cssText =
        'display:block;width:100%;text-align:left;background:none;border:0;color:inherit;font:inherit;padding:2px 0;cursor:pointer';
      head.addEventListener('click', () => {
        toggleGroup(group.id);
      });
      section.appendChild(head);

      const body = el('div', 'inspector-group-body');
      body.setAttribute('data-group-body', group.id);
      body.style.display = collapsed ? 'none' : 'block';
      for (const field of group.fields) body.appendChild(multiFieldRow(field));
      section.appendChild(body);
      root.appendChild(section);
    }
  }

  /** 多选提交失败时的统一收尾（与单选同样的失败语义）。 */
  /** @param {{code: string, message: string, currentHash?: string}} error */
  function failMulti(error) {
    state.status = error.code === 'CONFLICT' ? 'conflict' : 'error';
    state.error = error;
    render();
    return { ok: false, ...error };
  }

  /**
   * 多选改一个字段 → 应用到全部选中层 → **一批**（一次 `/ops`、一步撤销）。
   * 几何走 `boxOpForItem`（每层自己的 baseBox/geometry），文字/样式走同一个 `patchForField`。
   * @param {string} fieldId
   * @param {string|number} value
   * @returns {Promise<any>}
   */
  async function commitMultiField(fieldId, value) {
    if (state.mode !== 'multi') return commitField(fieldId, value);
    const field = fieldOf(fieldId);
    if (!field) return failMulti({ code: 'NOT_EDITABLE', message: `未知字段：${fieldId}` });
    if (!field.editable) {
      return failMulti({
        code: field.lockedReason || 'FIELD_UNSUPPORTED',
        message: `${field.label}在多选下不可编辑：${PANEL_REASONS[/** @type {keyof typeof PANEL_REASONS} */ (field.lockedReason ?? '')] ?? ''}`
      });
    }
    if (typeof deps.commitMany !== 'function') {
      return failMulti({ code: 'NO_COMMITTER', message: '多选需要宿主提供 deps.commitMany（一批 op、一步撤销）' });
    }

    /** @type {any[]} */
    const jobs = [];
    if (field.kind === 'box') {
      for (const item of state.items) {
        const built = await boxOpForItem(item, fieldId, value);
        if ('error' in built) return failMulti(built.error);
        jobs.push({ ref: item.ref, kind: 'box', op: built.op });
      }
    } else {
      const built = patchForField(fieldId, value, {
        suffix: field.suffix,
        box: state.items?.[0]?.described?.box,
        other: field.sibling
      });
      if ('error' in built) return failMulti(built.error);
      for (const item of state.items) jobs.push({ ref: item.ref, kind: 'overrides', patch: built.patch });
    }

    if (typeof deps.previewMany === 'function') {
      try {
        await deps.previewMany(jobs);
      } catch {
        /* 预览失败不影响提交 */
      }
    }

    const res = await deps.commitMany(jobs);
    if (res && res.ok) {
      state.hash = res.hash ?? state.hash;
      state.error = null;
      await refreshMulti();
      state.status = 'ok';
      render();
      return { ok: true, hash: state.hash, jobs: jobs.length, ops: res.ops?.length ?? jobs.length, opId: res.request?.envelope?.opId };
    }

    const code = res?.code ?? 'IO';
    /** @type {{code: string, message: string, currentHash?: string}} */
    const error = { code, message: res?.message ?? '批量提交失败' };
    if (res?.currentHash) error.currentHash = res.currentHash;
    if (code === 'CONFLICT' && typeof deps.onConflict === 'function') {
      deps.onConflict({ currentHash: res.currentHash, message: res.message });
    }
    if (typeof deps.revertPreview === 'function') await deps.revertPreview();
    return failMulti(error);
  }

  /** 重新读一遍所有选中层（提交成功 / 宿主外部改动后用）。 */
  async function refreshMulti() {
    const refs = state.items.map((item) => item.ref);
    if (refs.length === 0) return { ok: false };
    return selectMany(refs);
  }

  /**
   * 选中多层（S26）。`refs` 是 `{clipId, at, kind, name, depth}` 数组，也可以是 `at` 字符串数组。
   * 1 层时自动退回单选（与 S16 行为完全一致）；有层 describe 失败就跳过它。
   * @param {readonly any[]} refs
   */
  async function selectMany(refs) {
    const raw = Array.isArray(refs) ? refs.filter(Boolean) : [];
    if (raw.length === 0) return select(null);
    /** @type {any[]} */
    const list = raw.map((ref) =>
      typeof ref === 'string'
        ? { clipId: state.ref?.clipId ?? deps.tree?.clipId ?? '', at: ref, kind: 'unknown', name: ref, depth: 1 }
        : ref
    );
    if (list.length === 1) return select(list[0]);

    /** @type {any[]} */
    const items = [];
    for (const ref of list) {
      const described = await deps.describe(ref);
      if (!described || described.error) continue;
      const override = deps.overrideOf ? deps.overrideOf(ref.at) : null;
      let declared = null;
      if (typeof deps.boxOf === 'function') {
        try {
          declared = await deps.boxOf(ref.at);
        } catch {
          declared = null;
        }
      }
      let geometry = null;
      if (typeof deps.geometry === 'function') {
        try {
          geometry = await deps.geometry(ref.at);
        } catch {
          geometry = null;
        }
      }
      const baseBox = declared
        ? normalizeBox(declared)
        : geometry && geometry.ok === true
          ? screenBoxToDeclared(described.box, geometry) ?? normalizeBox(described.box)
          : normalizeBox(described.box);
      const lockedByTree = deps.tree && typeof deps.tree.lockedAt === 'function' ? deps.tree.lockedAt(ref.at) === true : false;
      items.push({
        ref,
        override,
        described,
        declaredBox: declared && typeof declared === 'object' ? declared : null,
        baseBox,
        geometry,
        locked: described.locked === true || lockedByTree
      });
    }

    if (items.length === 0) {
      state.model = null;
      state.mode = 'multi';
      state.items = [];
      state.status = 'error';
      state.error = { code: 'LAYER_GONE', message: '选中的层都 describe 失败' };
      render();
      return { ok: false, error: state.error };
    }
    if (items.length === 1) return select(items[0].ref);

    const first = /** @type {any} */ (items[0]);
    state.mode = 'multi';
    state.items = items;
    state.ref = first.ref;
    state.described = first.described;
    state.override = first.override;
    state.declaredBox = first.declaredBox;
    state.baseBox = first.baseBox;
    state.geometry = first.geometry;
    state.status = 'idle';
    state.error = null;
    state.model = buildMultiInspector(items, {
      boxEditable: typeof deps.commitMany === 'function',
      commitManyAvailable: typeof deps.commitMany === 'function'
    });
    state.locked = state.model.locked === true;
    if (tree) tree.setSelected('');
    render();
    return { ok: true, mode: 'multi', count: items.length, model: state.model };
  }

  /** 单层的 box op（多选时每层各算一份：各自的 baseBox 与祖先坐标系）。 */
  /**
   * @param {any} item @param {string} fieldId @param {string|number} value
   * @returns {Promise<{op: any} | {error: {code: string, message: string}}>}
   */
  async function boxOpForItem(item, fieldId, value) {
    const geom = item.geometry ?? null;
    if (geom && geom.ok === false) {
      return {
        error: {
          code: typeof geom.code === 'string' && geom.code ? geom.code : 'UNSUPPORTED_ANCESTOR_MATRIX',
          message: geom.reason ?? '祖先变换无法用 2D 表达'
        }
      };
    }
    const raw = String(value ?? '').trim();
    if (geom && geom.ok === true && raw !== '' && item.baseBox) {
      const converted = screenEditToBox(fieldId, Number(raw), item.baseBox, geom);
      if ('error' in converted) return { error: converted.error };
      const built = patchForBoxValue(converted.box);
      if ('error' in built) return { error: built.error };
      return { op: built.op };
    }
    const built = patchForBox(fieldId, value, item.baseBox);
    if ('error' in built) return { error: built.error };
    return { op: built.op };
  }

  /** @param {string} fieldId */
  function fieldOf(fieldId) {
    return state.model?.fields?.find((/** @type {any} */ f) => f.id === fieldId) ?? null;
  }

  /**
   * 页面域判定（S2H）：这一层是不是页面片段**内部**的元素。
   *
   * 判据用图层树（`deps.tree` → `mountLayerTree` 的 `nodeOf`）：树里的层就是 `listLayers`
   * 给出的页面元素；同一棵树的节点带 `parentAt`，与左列 dock 的 `scope==='page'` 同源。
   * 没传树（其它宿主）时一律 false——与 R8 行为逐字节一致，不靠猜。
   */
  function isPageDomain() {
    const at = state.ref?.at ?? '';
    if (at === '') return false;
    if (!tree || typeof tree.nodeOf !== 'function') return false;
    return tree.nodeOf(at) !== null;
  }

  /** @param {string} fieldId */
  function isPageGeometryField(fieldId) {
    return PAGE_GEOMETRY_FIELDS.has(fieldId) && isPageDomain();
  }

  /**
   * 就地报错（S2H）：状态栏照旧写 `code：message`，出错那行下面再挂一条**可见**文案。
   * 与左列 `showFieldError` 同一位置语义（挂在行下面），文案与左列同源或同款。
   * @param {string} fieldId @param {string} code @param {string} message
   */
  function failField(fieldId, code, message) {
    state.status = 'error';
    state.error = { code, message };
    state.fieldError = { field: fieldId, code, message };
    render();
    return { ok: false, code, message };
  }

  /**
   * 就地报错且**不清空已输入的值**（B02 硬要求：不弹窗、不清空）。
   *
   * `failField` 会重渲染（错误条挂在出错那一行下面），输入框按模型值重建 ——
   * 用户刚敲的 `abc` 就没了。这里在重渲染后把原文放回输入框并聚焦：
   * 行/字段集一个不变，只多一条错误节点。
   * @param {string} fieldId @param {string} code @param {string} message @param {string} raw
   */
  function failFieldKeepingDraft(fieldId, code, message, raw) {
    const result = failField(fieldId, code, message);
    const input = /** @type {HTMLInputElement|null} */ (root.querySelector(`.inspector-field[data-field="${fieldId}"] input.inspector-input`));
    if (input) {
      input.value = raw;
      /* 下面这行让「改哪个格」一目了然：错误行还在，光标也在原格。 */
      input.focus();
    }
    return result;
  }

  /**
   * `patchForField` 的公共 opts。
   *
   * R113 · L2 起多三项，都是「当前生效值」而不是用户输入：
   * - `base.filter`：调色五项要重写的那条 filter（乐观值优先，避免连改两项时把上一项丢掉）；
   * - `clipped`：四角圆角要锁一致；
   * - `outline`：改描边位置/粗细时一起算 `outline-offset`。
   * @param {string} fieldId
   */
  function patchOpts(fieldId) {
    const field = fieldOf(fieldId);
    /* 描边：粗细细与位置都优先用「刚写、还没被 describe 证实」的值 —— 否则连改两步时
       第二步会拿旧值算 offset（实测：粗细 4 之后紧接着选「中」，offset 会算成 −3 而不是 −2）。 */
    const width = Number.parseFloat(String(state.pendingStyle['outline-width'] ?? fieldOf('outlineWidth')?.display ?? fieldOf('outlineWidth')?.current ?? 0));
    const widthNow = Number.isFinite(width) ? width : 0;
    const offsetText = String(state.pendingStyle['outline-offset'] ?? state.described?.style?.['outline-offset'] ?? '0');
    const offsetNow = Number.parseFloat(offsetText);
    const position = widthNow <= 0
      ? 'outer'
      : offsetNow <= -widthNow + 0.01
        ? 'inner'
        : offsetNow <= -widthNow / 2 + 0.01
          ? 'center'
          : 'outer';
    return {
      suffix: field?.suffix,
      box: state.described?.box,
      other: field?.sibling,
      base: { filter: String(state.pendingStyle.filter ?? fieldOf('filter')?.current ?? '') },
      clipped: state.described?.clipped === true,
      outline: { width: widthNow, position }
    };
  }

  /**
   * 几何字段 → 一个 `set` Op。
   *
   * **坐标系**：宿主给了 `deps.geometry` 且读得到（`ok:true`）时，输入按**屏幕像素**解释，
   * 先用 `screenEditToBox` 换回声明值再建 Op；读不到（`ok:false`，例如祖先有 matrix3d）就当场拒绝，
   * 一个字节都不写。宿主没提供这个 dep 时与 R7 完全一致（输入就是声明值）。
   *
   * @param {string} fieldId
   * @param {string|number} value
   * @returns {Promise<{op?: any, error?: {code: string, message: string}, hint?: string, declared?: any, geometry?: any}>}
   */
  async function boxOpFor(fieldId, value) {
    const geom = await readGeometry();
    if (geom) state.geometry = geom;

    if (geom && geom.ok === false) {
      return {
        error: {
          code: typeof geom.code === 'string' && geom.code ? geom.code : 'UNSUPPORTED_ANCESTOR_MATRIX',
          message: geom.reason ?? '祖先变换无法用 2D 表达'
        }
      };
    }

    const field = fieldOf(fieldId);
    const raw = String(value ?? '').trim();
    const hint = field && field.sourceLabel === 'measured' && state.baseBox ? measuredPinHint(state.baseBox) : '';

    if (geom && geom.ok === true && raw !== '' && state.baseBox) {
      const converted = screenEditToBox(fieldId, Number(raw), state.baseBox, geom);
      if ('error' in converted) return { error: converted.error, geometry: geom };
      const built = patchForBoxValue(converted.box);
      if ('error' in built) return { error: built.error, geometry: geom };
      return { op: built.op, hint, declared: converted.box, geometry: geom };
    }

    const built = patchForBox(fieldId, value, state.baseBox);
    if ('error' in built) return { error: built.error, geometry: geom };
    return { op: built.op, hint, declared: state.baseBox, geometry: geom };
  }

  /**
   * 只预览：合并进 entries 并在 frame 之后应用（宿主负责顺序）。
   * @param {string} fieldId
   * @param {string|number} value
   */
  async function previewField(fieldId, value) {
    if (state.mode === 'multi') {
      /* 多选不做逐键预览：一批 op 打到一半再回滚，比不预览更糟。change 时才提交。 */
      return { ok: false, code: 'MULTI_NO_PREVIEW', message: '多选在 change 时一次提交，不做逐键预览' };
    }
    if (state.locked) return { ok: false, code: 'LOCKED', message: '锁定层不可编辑' };

    if (fieldOf(fieldId)?.kind === 'box') {
      /* B02：页面内元素只**预览** overrides.style（左/top/宽/高），不碰 `set:box`。
         预览是尽力而为：非法输入这里**不报错也不重渲染**——render() 会把正在输入的框
         整个重建掉（焦点和已输入的字符一起没）。错误留给 change/Enter 提交时就地显示。 */
      if (isPageDomain()) {
        const element = elementGeometryPatch(fieldId, value);
        if (element.error) return { ok: false, ...element.error };
        await deps.preview(element.patch);
        return { ok: true, patch: element.patch, value: element.value };
      }
      const built = await boxOpFor(fieldId, value);
      if (built.error) {
        state.status = 'error';
        state.error = { code: built.error.code, message: built.error.message };
        render();
        return { ok: false, ...state.error };
      }
      if (built.hint) state.hint = { code: 'MEASURED_PINNED', text: built.hint };
      if (typeof deps.previewBox === 'function') await deps.previewBox(built.op);
      return { ok: true, op: built.op, declared: built.declared };
    }

    /* 裁切要盒子尺寸判「四边合计超盒」；阴影要另一半（内/外）才能合回一条 box-shadow；
       R113 · L2 的调色/四角/描边三项在 patchOpts 里统一给（见那边的注释）。 */
    const built = patchForField(fieldId, value, patchOpts(fieldId));
    if ('error' in built) {
      state.status = 'error';
      state.error = { code: built.error.code, message: built.error.message };
      render();
      return { ok: false, ...state.error };
    }
    await deps.preview(built.patch);
    return { ok: true, patch: built.patch };
  }

  /**
   * 预览 + 提交一个 Op。失败先回滚预览，再显示原因。
   * @param {string} fieldId
   * @param {string|number} value
   * @returns {Promise<any>}
   */
  async function commitField(fieldId, value) {
    if (state.mode === 'multi') return commitMultiField(fieldId, value);
    if (state.locked) {
      state.status = 'error';
      state.error = { code: 'LOCKED', message: '锁定层不可编辑' };
      render();
      return { ok: false, code: 'LOCKED' };
    }
    if (fieldOf(fieldId)?.kind === 'box') {
      /* B02（A25、A27）：页面内元素 → 元素自己的 CSS 声明（overrides.style），
         与旋转/文本/样式同一条 `deps.commit` 链；片段几何仍走 `set:box`。 */
      if (isPageDomain()) return commitElementGeometry(fieldId, value);
      return commitBoxField(fieldId, value);
    }

    /* B02（R108）：页面域几何的第二道闸（S2H 的「只读」兜底）已撤——页面内元素的
       x/y/w/h 现在真能写，写的是元素自己的声明（见 `commitElementGeometry`）。 */
    /* S2H：色值校验与左列 dock 同一份解析器。合法的才发 `/ops`；`#zzz` / `rgb(999)`
       这类浏览器会整条忽略的值，写进去只会得到「提交成功但没效果」。 */
    const colorField = fieldOf(fieldId);
    if (colorField && colorField.unit === '色值' && isColorRejected(value)) {
      return failField(fieldId, 'INVALID_VALUE', `不是合法颜色：${value}`);
    }

    const built = patchForField(fieldId, value, patchOpts(fieldId));
    if ('error' in built) {
      state.status = 'error';
      state.error = { code: built.error.code, message: built.error.message };
      state.fieldError = { field: fieldId, code: built.error.code, message: built.error.message };
      render();
      return { ok: false, ...state.error };
    }

    await deps.preview(built.patch);
    const res = await deps.commit(built.patch);

    if (res && res.ok) {
      state.hash = res.hash ?? state.hash;
      state.status = 'ok';
      state.error = null;
      state.fieldError = null;
      /* R113 · L2 + R151：记住刚写进去的声明（读回前再改第二项时以它为底座）。 */
      declarePending(built.patch);
      if (deps.overrideOf) state.override = deps.overrideOf(state.ref.at);
      /* R11 · A2：读回不占提交链（见 `scheduleReadback` 的注释）。
         就地更新状态条 → 下一笔立刻能发；describe + 重渲染交给读回链。 */
      renderStatusInPlace();
      scheduleReadback();
      return { ok: true, hash: state.hash, changed: res.changed, opId: res.request?.envelope?.opId };
    }

    const code = res?.code ?? 'IO';
    state.status = code === 'CONFLICT' ? 'conflict' : 'error';
    /** @type {{code: string, message: string, currentHash?: string}} */
    state.error = { code, message: res?.message ?? '提交失败' };
    if (res?.currentHash) state.error.currentHash = res.currentHash;
    if (code === 'CONFLICT' && typeof deps.onConflict === 'function') {
      deps.onConflict({ currentHash: res.currentHash, message: res.message });
    }
    if (typeof deps.revertPreview === 'function') await deps.revertPreview();
    state.model = rebuildModel();
    state.locked = state.model.locked;
    render();
    return { ok: false, code, currentHash: res?.currentHash, message: state.error.message };
  }

  /**
   * 页面内元素几何 → 一条 overrides patch（B02 / A25、A26、A27）。
   *
   * 四条规矩：
   * 1. **输入的是坐标，写的是偏移**：`left = 目标 − 实测 + 当前 computed left`。
   *    relative/absolute 的 `left` 是「相对原位」的偏移，直接把输入写进 `left`
   *    会让元素跑到 `原位 + 输入`（实测 92 + 200 = 292，值不回环）。这样写完
   *    `describe().box` 恰好等于输入值，X/Y 才和屏幕一致（A26 的「数值一致」）。
   * 2. **宽高按差值折算**：`width = 当前 computed width + (目标 − 实测宽)`；
   *    盒子有 padding/border 时（border-box 实测 vs content-box 声明）直接写输入会胖一圈。
   * 3. **只带改的那一个键**（＋必要时 `position`）：同一条覆盖里的其他人工改动一个不动（A27）。
   *    静态定位的元素 `left/top` 是死键 → 第一次写 x/y 时顺带 `position: relative`
   *    （relative 不脱离文档流，flex/grid 布局不塌；作者自己写过 position 就不碰）。
   * 4. 清空输入 = **回到源样式**：写 CSS 的 `auto`，而不是删别人的键（删键要整条替换覆盖，
   *    会把同一条里的其他键一起带走）。
   *
   * @param {string} fieldId @param {string|number} value
   * @returns {{patch?: {style: Record<string,string>}, value?: number, note?: string, error?: {code: string, message: string}}}
   */
  function elementGeometryPatch(fieldId, value) {
    const prop = ELEMENT_GEOMETRY_STYLE[fieldId];
    if (!prop) return { error: { code: 'INVALID', message: `不是几何字段：${fieldId}` } };
    const raw = String(value ?? '').trim();
    if (raw === '') return { patch: { style: { [prop]: 'auto' } }, note: `${prop} 回到源样式（auto）` };

    const judged = clampElementGeometry(fieldId, raw, state.described?.viewport);
    if (judged.error !== undefined) return { error: { code: 'INVALID', message: judged.error } };
    const target = Number(judged.value);
    const measured = state.described?.box ?? {};
    const computedStyle = state.described?.style ?? {};
    /** computed 的 px 值；`auto`/空 → 0。 @param {string} key */
    const cssPx = (key) => {
      const n = Number.parseFloat(String(computedStyle[key] ?? ''));
      return Number.isFinite(n) ? n : 0;
    };
    /** @param {number} n */
    const round2 = (n) => Math.round(n * 100) / 100;

    /** @type {Record<string,string>} */
    const style = {};
    if (fieldId === 'x' || fieldId === 'y') {
      const measuredNow = Number(measured[fieldId === 'x' ? 'x' : 'y']);
      const currentOffset = cssPx(prop);
      const next = Number.isFinite(measuredNow) ? target - measuredNow + currentOffset : target;
      style[prop] = `${round2(next)}px`;
    } else {
      const measuredNow = Number(measured[fieldId === 'w' ? 'w' : 'h']);
      const currentSize = cssPx(prop);
      const next = Number.isFinite(measuredNow) && currentSize > 0 ? currentSize + (target - measuredNow) : target;
      style[prop] = `${round2(Math.max(1, next))}px`;
    }

    const computedPosition = String(computedStyle.position ?? '');
    const currentStyle = state.override && typeof state.override.style === 'object' && state.override.style !== null ? state.override.style : {};
    const authorSetPosition = Object.prototype.hasOwnProperty.call(currentStyle, 'position') || (state.described?.inline?.position ?? '') !== '';
    if ((fieldId === 'x' || fieldId === 'y') && computedPosition === 'static' && !authorSetPosition) {
      style.position = 'relative';
    }
    return { patch: { style }, value: target, ...(judged.note === undefined ? {} : { note: judged.note }) };
  }

  /**
   * 提交页面内元素的几何（B02）：与旋转/文本/样式**同一条** `deps.commit`（属性队列 → `/ops`），
   * 所以一次编辑 = 一批 op = 一步撤销；`set:box` 一个字节都不发（A25 的「不是改片段 box 冒称」）。
   * @param {string} fieldId @param {string|number} value
   * @returns {Promise<any>}
   */
  async function commitElementGeometry(fieldId, value) {
    const built = elementGeometryPatch(fieldId, value);
    if (built.error !== undefined) {
      /* 就地报错、**不清空**用户刚输入的值（B02 §1.4）。 */
      return failFieldKeepingDraft(fieldId, built.error.code, built.error.message, String(value ?? ''));
    }
    const patch = /** @type {{style: Record<string,string>}} */ (built.patch);

    await deps.preview(patch);
    const res = await deps.commit(patch);
    if (res && res.ok) {
      state.hash = res.hash ?? state.hash;
      state.status = 'ok';
      state.error = null;
      state.fieldError = null;
      /* 钳制不是错：说清「钳到哪了」，别让用户以为白改了一次。 */
      state.hint = built.note === undefined ? null : { code: 'CLAMPED', text: built.note };
      /* 乐观回显：读回要等舞台按新 hash 重画（几百毫秒到 1 秒），这期间输入框
         不该还显示旧值——否则「刚输入 200、框里又跳回 92」看着像没生效。
         只动基准（baseBox），不动 declaredBox：页面元素本来就没有「声明值」。 */
      if (typeof built.value === 'number') {
        const now = state.baseBox ?? normalizeBox(state.described?.box ?? {});
        const next = now === null ? null : normalizeBox({ ...now, [fieldId]: built.value });
        if (next !== null) {
          state.baseBox = next;
          state.model = rebuildModel();
        }
      }
      renderStatusInPlace();
      scheduleReadback();
      return { ok: true, hash: state.hash, changed: res.changed, patch, value: built.value, opId: res.request?.envelope?.opId };
    }

    const code = res?.code ?? 'IO';
    state.status = code === 'CONFLICT' ? 'conflict' : 'error';
    /** @type {{code: string, message: string, currentHash?: string}} */
    state.error = { code, message: res?.message ?? '提交失败' };
    if (res?.currentHash) state.error.currentHash = res.currentHash;
    if (code === 'CONFLICT' && typeof deps.onConflict === 'function') {
      deps.onConflict({ currentHash: res.currentHash, message: res.message });
    }
    if (typeof deps.revertPreview === 'function') await deps.revertPreview();
    state.model = rebuildModel();
    state.locked = state.model.locked;
    render();
    return { ok: false, code, currentHash: res?.currentHash, message: state.error.message };
  }

  /**
   * 几何（box）提交：`set` op，`field:'box'`。
   * 与 overrides 共用同一套失败语义（409 → currentHash + 回滚；400 → 代码 + 回滚），
   * 但走的是**另一条**写入口，两条不会互相改写对方的条目。
   * @param {string} fieldId
   * @param {string|number} value
   */
  async function commitBoxField(fieldId, value) {
    /* S2H ①：宽高必须 > 0（film-core 也拒，先在界面挡住并给可见文案）。
       先于页面域判定：值本身不合法时，理由应当是「宽高必须大于 0」而不是「只读」。 */
    if (fieldId === 'w' || fieldId === 'h') {
      const size = Number(String(value ?? '').trim());
      if (!Number.isFinite(size) || size <= 0) return failField(fieldId, 'INVALID', '宽高必须大于 0');
    }
    /* B02（R108）：页面域几何不再在这里拦 —— 它由 `commitElementGeometry` 走 overrides.style。
       本函数只负责**片段**几何（`set:box` 整体替换）。 */
    if (typeof deps.commitBox !== 'function') {
      state.status = 'error';
      state.error = { code: 'NO_BOX_COMMITTER', message: '宿主没有提供 box 提交口（deps.commitBox）' };
      render();
      return { ok: false, code: 'NO_BOX_COMMITTER' };
    }
    const built = await boxOpFor(fieldId, value);
    if (built.error) {
      state.status = 'error';
      state.error = { code: built.error.code, message: built.error.message };
      render();
      return { ok: false, ...state.error };
    }
    const op = built.op;
    if (built.hint) state.hint = { code: 'MEASURED_PINNED', text: built.hint };
    if (typeof deps.previewBox === 'function') await deps.previewBox(op);
    const res = await deps.commitBox(op);

    if (res && res.ok) {
      state.hash = res.hash ?? state.hash;
      state.status = 'ok';
      state.error = null;
      state.fieldError = null;
      /* 刚落盘的 box 就是新的声明值：直接当基准与显示值，不必再解析 style。 */
      state.declaredBox = { ...op.value };
      state.baseBox = normalizeBox(state.declaredBox);
      /* 同 overrides：读回/重渲染排到读回链，别把下一笔提交挡住（R11 · A2）。 */
      renderStatusInPlace();
      scheduleReadback();
      return {
        ok: true,
        hash: state.hash,
        changed: res.changed,
        opId: res.request?.envelope?.opId,
        op,
        box: op.value
      };
    }

    const code = res?.code ?? 'IO';
    state.status = code === 'CONFLICT' ? 'conflict' : 'error';
    /** @type {{code: string, message: string, currentHash?: string}} */
    state.error = { code, message: res?.message ?? '几何提交失败' };
    if (res?.currentHash) state.error.currentHash = res.currentHash;
    if (code === 'CONFLICT' && typeof deps.onConflict === 'function') {
      deps.onConflict({ currentHash: res.currentHash, message: res.message });
    }
    if (typeof deps.revertPreview === 'function') await deps.revertPreview();
    state.model = rebuildModel();
    state.locked = state.model.locked;
    render();
    return { ok: false, code, currentHash: res?.currentHash, message: state.error.message };
  }

  render();

  return {
    setObjectTab(/** @type {string} */ tab) {
      if (state.activeTab === tab || !OBJECT_TABS.some(item => item.id === tab)) return;
      state.activeTab = tab;
      render();
    },
    /** 选中一层并渲染。 */
    select,
    /** 选中多层（S26）：1 层自动退回单选；describe 失败的层跳过。 */
    selectMany,
    /**
     * 重新读一遍当前选择（单选/多选都适用）。
     *
     * R113 · L2：这是**显式**的「以盘上/页面为准」，所以先把乐观值丢掉 ——
     * 外部（Agent / 另一条线）改了同一个键之后，调一次 refresh 就能看到真实值。
     */
    async refresh() {
      if (state.mode === 'multi') return refreshMulti();
      if (!state.ref) return { ok: false };
      state.pendingStyle = {};
      state.pendingSeen = {};
      state.pendingAt = '';
      state.pendingHash = '';
      return select(state.ref);
    },
    /** 多选改一个字段（一批 op、一步撤销）；单选时转发给 commitField。 */
    commitMultiField,
    /** 折叠/展开一个分组（会话内记住，不写盘）。 */
    toggleGroup,
    /** @param {string} groupId @param {boolean} collapsed */
    setGroupCollapsed(groupId, collapsed) {
      if (collapsed) GROUP_COLLAPSED.add(groupId);
      else GROUP_COLLAPSED.delete(groupId);
      render();
      return !GROUP_COLLAPSED.has(groupId);
    },
    /** 会话内已折叠的分组 id。 */
    getCollapsedGroups() {
      return [...GROUP_COLLAPSED];
    },
    previewField,
    commitField,
    /** 只走几何（`set` op）那条路径，便于程序化调用与验收。 */
    commitBoxField,
    /** B02：页面内元素的几何（overrides.style 的 left/top/width/height，一步撤销）。 */
    commitElementGeometry,
    /** 等面板上所有在途操作（input/change 事件链 + 提交后的读回链）结束。 */
    async idle() {
      await state.pending;
      /* 提交链结束时读回链的尾巴才最终确定：先等链，再取一次 tail。 */
      await readback;
      return state.status;
    },
    /** 换图层树的数据（宿主重新 listLayers 后调用）；没传 deps.tree 时是空操作。 @param {readonly any[]} next */
    setTreeLayers(next) {
      if (!tree) return null;
      return tree.setLayers(next);
    },
    /** 只读：树控制器（没传 deps.tree 时为 null）。 */
    getTree() {
      return tree;
    },
    getState() {
      return {
        mode: state.mode,
        at: state.ref?.at ?? null,
        ats: state.mode === 'multi' ? state.items.map((item) => item.ref.at) : state.ref ? [state.ref.at] : [],
        /**
         * R151 · M17 · B：对象名与 `at` 的**同一份**读数（同一次 describe）。
         * 头部的下拉仍由 App 渲染（MAIN · M16-A）；这里只保证面板自己这一份同源。
         */
        object: {
          at: state.ref?.at ?? null,
          name: state.mode === 'multi' ? '' : objectNameOf(state.ref?.at ?? '', state.described),
          kind: state.ref?.kind ?? null,
          source: state.mode === 'multi' ? 'multi' : 'describe'
        },
        /** R151 · M17：还没被文档证实的声明（证据用；写回仍然只走 /ops）。 */
        pending: { ...state.pendingStyle },
        /** R151 · M17：哪些声明已经被文档证实（key → true）。 */
        pendingConfirmed: { ...state.pendingSeen },
        /** R151 · M17：最近一次被判「文档已另走一步」而作废的声明。 */
        pendingDropped: state.pendingDropped,
        /** R155 · M18：这条声明属于哪个元素（证实/作废按它取文档条目）。 */
        pendingAt: state.pendingAt,
        /** R155 · M18：这份声明写在哪份 doc hash 上（诊断用）。 */
        pendingHash: state.pendingHash,
        /** R151 · M17：宿主给的文档条目（名字/样式都由它来；诊断用）。 */
        overrideStyleKeys: Object.keys(/** @type {any} */ (state.override?.style) ?? {}),
        /** R161 · M19（C8）：重选读回的对账记录（每次尝试的 stale/mismatches/耗时）。 */
        describeAttempts: state.describeAttempts,
        /** R161 · M19（C8）：这一次读回拿到的圆角（证据用；面板显示的就是它）。 */
        describedRadius: state.described?.style?.['border-radius'] ?? null,
        /** R161 · M19（C8）：宿主条目被页内实测纠正掉的键（C8 的根因证据）。 */
        overrideDropped: state.overrideDropped,
        /** R151 · M17：画布草稿（诊断用：它是「下一笔的起点」）。 */
        draft: maskDraft === null ? null : { for: maskDraftFor, shape: maskDraft.shape, rot: maskDraft.rot, w: maskDraft.w, h: maskDraft.h, dirty: maskDirty, active: maskGestureActive },
        count: state.mode === 'multi' ? state.items.length : state.ref ? 1 : 0,
        status: state.status,
        error: state.error,
        hash: state.hash,
        locked: state.locked,
        override: state.override,
        box: state.baseBox,
        declaredBox: state.declaredBox,
        fields: state.model?.fields ?? [],
        /** 多选时有值的字段里哪些是「各层不一致」 */
        mixed: state.model?.fields?.filter((/** @type {any} */ field) => field.mixed === true).map((/** @type {any} */ field) => field.id) ?? [],
        collapsed: [...GROUP_COLLAPSED],
        /** 就地提示（B02 的钳制说明会挂在这里；`data-hint` 也写在 DOM 上）。 */
        hint: state.hint,
        /** B02：这一层是页面内元素吗、几何写到哪（验收用来区分两条写入口）。 */
        elementGeometry: {
          pageDomain: isPageDomain(),
          target: isPageDomain() ? 'element' : 'clip',
          writes: isPageDomain() ? { x: 'left', y: 'top', w: 'width', h: 'height' } : { x: 'box.x', y: 'box.y', w: 'box.w', h: 'box.h' },
          viewport: state.described?.viewport ?? null
        },
        stage: PANEL_STAGE,
        persistence: PANEL_PERSISTENCE
      };
    },
    destroy() {
      chromeObserver?.disconnect();
      if (tree) tree.destroy();
      if (treeHost) treeHost.remove();
      headHost.remove();
      root.remove();
    },
    root
  };
}
