/**
 * 画幅比例（R38 · C 批 · 批注 3 第 5 条）—— 纯函数，node --test 直接跑。
 *
 * 为什么单独一个文件：比例到舞台尺寸的映射是**产品口径**（写进 film.html 的
 * `<meta name="viewport">`），判据 C7/C8 又盯着具体数字。放进 React 组件里就只能靠
 * 浏览器量，放这里能拿单测钉死。
 *
 * ## 四档与尺寸（与 `sequence-errors.ts` 的序列预设对齐）
 *
 * | 档 | 尺寸 | 来源 |
 * |---|---|---|
 * | 16:9 | 1920×1080 | 序列预设 `16x9` |
 * | 9:16 | 1080×1920 | 序列预设 `9x16`（C8 要的就是这一组数） |
 * | 1:1  | 1080×1080 | 新增（预设里没有方形，取短边 1080） |
 * | 4:3  | 1440×1080 | 序列预设 `4x3` |
 *
 * **为什么不「保持长边」**：C8 明写「点 9:16 后 `doc.stage` = 1080×1920」。
 * 长边保持会把 1280×720 变成 720×1280，判据直接红 —— 所以这里用固定档位，
 * 换档 = 换一整套分辨率，这是产品选择，不是判据迁就。
 *
 * ## 「已经是这一档就不写盘」
 *
 * `ratioPick()` 在当前 `w/h` 已经等于目标档时返回 `null`（调用方据此不发 op）。
 * 两个作用：① 点已选中的档位不该产生一次空的 `/ops` 与撤销步；
 * ② 同一比例的不同分辨率（1280×720 与 1920×1080）都算 16:9 —— 点 16:9 不会
 * 把用户手调的 1280×720 悄悄改成 1920×1080。
 */

/** @typedef {{ id: string, w: number, h: number }} StageRatio */

/** 四档，顺序即界面顺序。 */
export const STAGE_RATIOS = Object.freeze([
  Object.freeze({ id: '16:9', w: 1920, h: 1080 }),
  Object.freeze({ id: '9:16', w: 1080, h: 1920 }),
  Object.freeze({ id: '1:1', w: 1080, h: 1080 }),
  Object.freeze({ id: '4:3', w: 1440, h: 1080 }),
]);

/** 比例相等判定的容差：1080×1920 / 1280×720 这类整数的浮点误差远小于它。 */
const EPS = 0.005;

/** @param {unknown} stage @returns {{w: number, h: number} | null} */
function sizeOf(stage) {
  if (stage === null || typeof stage !== 'object') return null;
  const w = Number(/** @type {any} */ (stage).w);
  const h = Number(/** @type {any} */ (stage).h);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return { w, h };
}

/**
 * 当前舞台落在哪一档（拿不到 / 不在四档内 → `null`，界面上四颗都不高亮）。
 * @param {{w: number, h: number} | null | undefined} stage
 * @returns {string | null}
 */
export function ratioIdOf(stage) {
  const size = sizeOf(stage);
  if (size === null) return null;
  const r = size.w / size.h;
  for (const option of STAGE_RATIOS) {
    if (Math.abs(r - option.w / option.h) <= EPS) return option.id;
  }
  return null;
}

/**
 * 某一档的尺寸（未知档 → `null`）。
 * @param {string} id
 * @returns {{ id: string, w: number, h: number } | null}
 */
export function stageForRatio(id) {
  return STAGE_RATIOS.find((option) => option.id === id) ?? null;
}

/**
 * 点某一档之后**要写进文档的尺寸**；已经是这一档 → `null`（不发 op）。
 * @param {{w: number, h: number} | null | undefined} stage
 * @param {string} id
 * @returns {{ w: number, h: number } | null}
 */
export function ratioPick(stage, id) {
  const option = stageForRatio(id);
  if (option === null) return null;
  if (ratioIdOf(stage) === id) return null;
  return { w: option.w, h: option.h };
}
