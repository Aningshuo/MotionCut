/**
 * 字幕样式预设（S41 · B-SUB1-R21-021 / R30 · E12-P5 扩到六种）
 *
 * 六条，覆盖「同一句话换一种说法」的常见需求：默认、描边、底框、大字、高亮词、双语。
 *
 * ## 预设只是**样式字段的一组取值**，不是第二条渲染路径
 *
 * 表里每条 `style` 都是 `SUBTITLE_STYLE_DEFAULTS` 的子集，`applyStylePreset()`（在
 * `subtitle-style.mjs`）把这组值合并进样式；预览与成片随后各读**同一份**样式。
 * 所以落盘只写 `preset` 这个 id，不写派生出来的字号/描边 —— 写派生值会立刻分裂成两份真相。
 *
 * 预设表本身在 `subtitle-style.mjs` 的 `SUBTITLE_PRESET_BUNDLES`：那边是渲染侧，
 * 这边只补「给人看的名字与说明」。放一份在渲染侧是因为 `toAssStyle` / `toCssStyle`
 * 不能反过来 import UI 语义（会成环）。
 *
 * 预设不改默认值：`default` 是空覆盖（`{}`），跑出来必须与 `SUBTITLE_STYLE_DEFAULTS`
 * 归一后的结果逐字段相同（验收 A5 会验）。
 */

import { SUBTITLE_PRESET_BUNDLES, SUBTITLE_PRESET_IDS, normalizeSubtitleStyle } from './subtitle-style.mjs';

/**
 * @typedef {object} SubtitlePreset
 * @property {string} id
 * @property {string} label       给 UI 显示的中文名
 * @property {string} description 一句话说明（UI 的副标题/悬浮提示）
 * @property {Record<string, unknown>} style 只含 SUBTITLE_STYLE_DEFAULTS 里的字段
 */

/** id → `[标签, 说明]`。顺序由 `SUBTITLE_PRESET_IDS` 决定（表格顺序 = 面板按钮顺序）。 */
const META = Object.freeze({
  /* R32 校准：字号 4.5% → 4.0%（参照 `s8.md`）、描边 2px → 1px（R31 的 0.055）。 */
  default: ['默认', '与成片默认样式完全一致（字号 4% 舞台高、白字、黑描边 1px）'],
  /* 为什么是 2px：默认样式是 1px 描边（outlineRatio 0.055 × 字号 28.8 × 0.5 → 1），
     这一档 0.12 跑出来正好 2px，与「默认」在像素上分得开。
     （R30 写 4px 是因为当时默认自己就是 2px；R31 把默认收到 1px 后这一档落回 2px。） */
  outline: ['描边', '描边加粗到 2px（默认是 1px），花底/浅底上更清楚'],
  box: ['底框', '半透明黑底 + 圆角，压在画面上也读得清（成片走 ASS 的 BorderStyle=3）'],
  /* R32 校准：1.4× → 1.3×，正好落在参照的 lg 档（5.2% ÷ 默认 4%）。 */
  large: ['大字', '整档放大 1.3×（= 5.2% 舞台高），适合竖屏短视频'],
  highlight: ['高亮词', '白底黑字，关键词/标题句用'],
  bilingual: ['双语', '上行主字号、下行 0.72×（第二行起都缩）']
});

/** @type {Readonly<Record<string, SubtitlePreset>>} */
export const SUBTITLE_PRESETS = Object.freeze(
  Object.fromEntries(
    SUBTITLE_PRESET_IDS.map((id) => {
      const meta = /** @type {any} */ (META)[id] ?? [id, ''];
      return [
        id,
        Object.freeze({
          id,
          label: meta[0],
          description: meta[1],
          style: SUBTITLE_PRESET_BUNDLES[id] ?? Object.freeze({})
        })
      ];
    })
  )
);

/**
 * 预设 id 列表（UI 迭代用）。顺序 = 面板按钮从左到右。
 * @returns {string[]}
 */
export function listSubtitlePresets() {
  return [...SUBTITLE_PRESET_IDS];
}

/**
 * 取一条预设。未知 id 返回 `null`（不抛、也不悄悄给 default——宿主得知道自己传错了）。
 * @param {string} id
 * @returns {SubtitlePreset | null}
 */
export function getSubtitlePreset(id) {
  const key = String(id ?? '');
  if (!Object.prototype.hasOwnProperty.call(SUBTITLE_PRESETS, key)) return null;
  return /** @type {any} */ (SUBTITLE_PRESETS)[key] ?? null;
}

/**
 * 预设 → 归一后的样式（含 issue）。宿主想「先套预设再让用户微调」时用这个：
 *
 * ```js
 * const { style } = resolveSubtitlePreset('large', { color: '#ffe066' });
 * ```
 *
 * @param {string} id
 * @param {Record<string, unknown>} [overrides] 用户覆盖（优先级高于预设）
 * @returns {{style: import('./subtitle-style.mjs').SubtitleStyle,
 *   issues: Array<{code: string, field: string, value: unknown, fallback: unknown, message: string}>,
 *   preset: SubtitlePreset | null}}
 */
export function resolveSubtitlePreset(id, overrides = {}) {
  const preset = getSubtitlePreset(id);
  const base = preset ? preset.style : {};
  return {
    ...normalizeSubtitleStyle({ ...base, ...(overrides ?? {}) }),
    preset
  };
}
