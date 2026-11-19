/**
 * 导出体积估算（M54-A3）。
 *
 * 面板上那行「预计 ≈ X MB」的唯一来源。**不是**「像素数 × 经验系数」：
 * 这条流水线的 standard/high 是 **yuv444p + crf 8/2**（`packages/render/quality.mjs`），
 * 码率比网页常见的 4:2:0 crf 20 高一个量级，套通用经验值会差 3–10 倍。
 *
 * ## 模型（只有一个自由参数）
 *
 *   bytes = 锚点(codec,quality) × 1024² × 秒数 × (像素数 / 720p像素数)^α
 *
 * - `锚点` 是 **720p / 30fps 下实测的每秒字节数**（MB/s），见下表；
 * - `α = 0.55` 是「码率不随像素线性涨」的那条曲线：h264 720p→1080p 实测给出 0.583，
 *   hevc 720p→4K 实测给出 0.517，取 0.55 是两个留出样本的折中（−2.7% / +7.2%）。
 *
 * ## 常数出处（`evidence/rounds/R29-MAIN/m54-bytes.json`，7 个真导出）
 *
 * | 用例 | 字节 | MB/s |
 * |---|---|---|
 * | 720p 1s draft    | 207,358  | 0.198 |
 * | 720p 3s standard | 3,532,789 | 1.123 |
 * | 720p 1s standard | 1,148,080 | 1.095 |
 * | 720p 1s high     | 1,683,870 | 1.606 |
 * | 720p 1s hevc high| 715,726  | 0.683 |
 * | 1080p 3s std     | 5,691,791 | 1.809 |
 * | 4K 1s hevc high  | 2,138,748 | 2.040 |
 *
 * **标定组只有 720p 那五个**；1080p / 4K 是留出验证（A3 要求误差 ≤15%）。
 * hevc 的 standard/draft 没有实测（交付预设不用它们），按「hevc ≈ h264 的 0.425」
 * 推导并标了 `derived`，UI 照常显示数字，但不要拿它当承诺。
 *
 * 纯函数、不碰 IO：面板可以每帧重算，也不会因为「估了一下」就动工程里的文件。
 */

export const DELIVERY_BYTES_VERSION = '2.0.0';

/** 720p 的像素数，像素指数的基准。 */
const BASE_PIXELS = 1280 * 720;

/**
 * 「码率随像素增长」的指数。0.55 = h264 实测 0.583 与 hevc 实测 0.517 的折中。
 * 改这个数必须重跑 `scripts/m54-export-bytes.mjs`，否则注释里的误差就对不上了。
 */
export const PIXEL_EXPONENT = 0.55;

/**
 * 720p / 30fps 下每秒多少 MB。
 * `derived: true` 的是推导值（没有实测），用来让人手选 hevc standard 时也有个数。
 * @type {Readonly<Record<string, Readonly<{ mbPerSec: number, derived?: true }>>>}
 */
export const ANCHOR_MB_PER_SEC = Object.freeze({
  'h264:draft': Object.freeze({ mbPerSec: 0.198 }),
  'h264:standard': Object.freeze({ mbPerSec: 1.123 }),
  'h264:high': Object.freeze({ mbPerSec: 1.606 }),
  'hevc:high': Object.freeze({ mbPerSec: 0.683 }),
  'hevc:standard': Object.freeze({ mbPerSec: 0.477, derived: true }),
  'hevc:draft': Object.freeze({ mbPerSec: 0.084, derived: true }),
});

/**
 * 估算交付字节数。
 *
 * @param {{ w?: number, h?: number, frames?: number, fps?: number,
 *   quality?: string, codec?: string }} input
 * @returns {{ bytes: number, mbPerSec: number, derived: boolean } | null}
 *   `null` = 这个组合没有锚点（未知画质/编码），调用方显示「—」而不是编一个数。
 */
export function estimateDeliveryBytes(input) {
  const w = Number(input.w);
  const h = Number(input.h);
  const frames = Number(input.frames);
  const fps = Number(input.fps);
  if (!(w > 0) || !(h > 0) || !(frames > 0) || !(fps > 0)) return null;
  const key = `${String(input.codec ?? 'h264')}:${String(input.quality ?? 'standard')}`;
  const anchor = ANCHOR_MB_PER_SEC[key];
  if (anchor === undefined) return null;
  const seconds = frames / fps;
  const scale = Math.pow((w * h) / BASE_PIXELS, PIXEL_EXPONENT);
  const mbPerSec = anchor.mbPerSec * scale;
  return {
    bytes: Math.round(mbPerSec * 1024 * 1024 * seconds),
    mbPerSec,
    derived: anchor.derived === true,
  };
}

/**
 * 面板上显示的那句话。`null` 时给「—」而不是 `NaN MB`。
 * @param {ReturnType<typeof estimateDeliveryBytes>} estimate
 * @returns {string}
 */
export function formatDeliveryEstimate(estimate) {
  if (estimate === null) return '预计 ≈ —';
  const mb = estimate.bytes / 1024 / 1024;
  const text = mb >= 100 ? `${Math.round(mb)} MB` : mb >= 10 ? `${mb.toFixed(1)} MB` : `${mb.toFixed(2)} MB`;
  return `预计 ≈ ${text}${estimate.derived === true ? '（推导值）' : ''}`;
}
