/**
 * 字幕渲染层的**唯一接线点**（M24 · B-MAIN-R12-012）
 *
 * 冻结接口（任务书 4.2，字段名不许改）：
 *   mountSubtitleOverlay(container, { getCues, getTime, getStage, style, onError })
 *     → { render(t), destroy(), setVisible(v), getState(), updateStyle(patch) }
 *
 * **R12 联调（大脑）**：副线1 的 `packages/layers/subtitle-overlay.mjs` 已在集成树里
 * （S23-FROZEN，interfaceFreeze PASS），故把本入口从 stub 换成真组件。
 * stub 文件保留在 `tests/fixtures/main/` 仅供对照，不再被引用。
 */

// eslint-disable-next-line import/no-relative-packages
export { mountSubtitleOverlay, SUBTITLE_STYLE_DEFAULTS, SUBTITLE_OVERLAY_VERSION, computeVisibleWidth } from '../../../../layers/subtitle-overlay.mjs';
