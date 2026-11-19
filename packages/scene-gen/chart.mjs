/**
 * chartSpec · 一组数 → 坐标轴 + 每根柱（M87-WP21，M93 搬进产品包）
 *
 * 数据和几何都不写死：调用方给 `{title, values, labels?}`，这里自己算：
 *
 *   - 绘图区（默认 1280×720 的 160..1120 × 100..560）；
 *   - 柱宽 / 柱间距（柱数变了自己缩，5 根和 7 根都不会溢出错区）；
 *   - 柱高（`value / maxValue × 绘图区高`，不是 `value × 常数`）；
 *   - 颜色（按序号循环调色板）。
 *
 * 返回的 `ops` 直接进 `POST /api/projects/:id/ops`，`files` 由调用方落到工程的
 * `assets/` 下（产品里由 `agent-scene` 的 apply 写盘，见 `packages/studio/server/agent-scene.mjs`）。
 * **不改渲染链**：柱子就是 8×8 纯色 PNG 按 box 拉伸。
 *
 * `prefix` 参数（M93 新增）：同一工程里画两张图时，各自的 PNG 不能互相覆盖，
 * 所以调用方可以给一个子目录前缀（`gen-ab12cd/`）。默认空串，验收链的路径不变。
 */

import { encodePng } from '../render/png.mjs';
import { SCENE_GEN_CODES, sceneError } from './errors.mjs';

/** 舞台与绘图区默认值（与 M86 一致，方便对拍）。 */
export const CHART_STAGE = Object.freeze({ w: 1280, h: 720 });
export const CHART_PLOT = Object.freeze({ left: 160, right: 1120, top: 100, bottom: 560 });

/** 五色调色板；柱数多于 5 时循环。 */
export const CHART_COLORS = Object.freeze([
  [255, 209, 102],
  [142, 205, 247],
  [166, 227, 161],
  [245, 169, 127],
  [203, 166, 247],
]);

/**
 * 按舞台尺寸推绘图区（M93）：产品里工程画幅不一定 1280×720（默认模板是 1920×1080）。
 * 比例取自 1280×720 的那组边距，换画幅后柱子仍在画面中，不会挤在左上角。
 * @param {{ w: number, h: number }} stage
 */
export function plotForStage(stage) {
  const w = Number.isFinite(stage?.w) && stage.w > 0 ? stage.w : CHART_STAGE.w;
  const h = Number.isFinite(stage?.h) && stage.h > 0 ? stage.h : CHART_STAGE.h;
  return {
    left: Math.round(w * 0.125),
    right: Math.round(w * 0.875),
    top: Math.round(h * 0.1389),
    bottom: Math.round(h * 0.7778),
  };
}

/** 一次草稿最多 40 条 Op（`agent-scene` 的硬限制），两条轴 = 38 根柱的余量；取 12 根更保守。 */
export const CHART_MAX_VALUES = 12;

const AXIS_COLOR = [232, 237, 245];

/** 调色板里取第 index 个（越界循环）；空表也返回一个确定的颜色。 @param {number} index */
const colorAt = (index) => CHART_COLORS[index % CHART_COLORS.length] ?? [255, 209, 102];

/**
 * 8×8 纯色 PNG（柱子/轴都用它，靠 box 拉伸）。
 * @param {readonly number[]} rgb
 */
function solidPng(rgb) {
  const w = 8;
  const h = 8;
  const data = Buffer.alloc(w * h * 4);
  for (let index = 0; index < w * h; index += 1) {
    data[index * 4] = rgb[0] ?? 0;
    data[index * 4 + 1] = rgb[1] ?? 0;
    data[index * 4 + 2] = rgb[2] ?? 0;
    data[index * 4 + 3] = 255;
  }
  return encodePng({ width: w, height: h, data });
}

/**
 * @typedef {{ x: number, y: number, w: number, h: number }} Rect
 * @typedef {{ path: string, data: Buffer }} SceneFile
 * @typedef {{
 *   kind: 'chart',
 *   ops: any[],
 *   files: SceneFile[],
 *   assets: SceneFile[],
 *   layout: {
 *     stage: { w: number, h: number },
 *     plot: { left: number, right: number, top: number, bottom: number },
 *     plotRect: Rect,
 *     barW: number,
 *     gap: number,
 *     offsetX: number,
 *     maxValue: number,
 *     bars: Array<{ index: number, value: number, label: string, color: readonly number[], rect: Rect }>,
 *   },
 *   meta: { title: string, values: number[], labels: string[], count: number, ops: number, prefix: string },
 * }} ChartSpecResult
 */

/**
 * @param {{
 *   title?: string,
 *   values: number[],
 *   labels?: string[],
 *   stage?: { w: number, h: number },
 *   plot?: { left: number, right: number, top: number, bottom: number },
 *   prefix?: string,
 * }} input
 * @returns {ChartSpecResult}
 */
export function chartSpec(input) {
  const values = Array.isArray(input?.values) ? input.values : [];
  if (values.length === 0) throw sceneError(SCENE_GEN_CODES.EMPTY_VALUES, 'chartSpec 需要至少一个数值');
  if (values.length > CHART_MAX_VALUES) {
    throw sceneError(
      SCENE_GEN_CODES.TOO_MANY_VALUES,
      `chartSpec 最多 ${String(CHART_MAX_VALUES)} 根柱（收到 ${String(values.length)} 根）：一次草稿限 40 条 Op`,
    );
  }
  for (const [index, value] of values.entries()) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw sceneError(SCENE_GEN_CODES.BAD_VALUE, `chartSpec values[${String(index)}] 不是非负有限数：${String(value)}`);
    }
  }
  const stage = input?.stage ?? CHART_STAGE;
  /* 画幅变了，绘图区跟着变（M93）：默认模板是 1920×1080，写死 1280×720 的坐标会让
     柱子挤在左上角，导出成 1280×720 时面积也对不上。显式给 `plot` 时以它为准。 */
  const plot = input?.plot ?? (input?.stage === undefined ? CHART_PLOT : plotForStage(stage));
  const title = typeof input?.title === 'string' ? input.title : '';
  const labels = Array.isArray(input?.labels) ? input.labels.map(String) : [];
  const prefix = typeof input?.prefix === 'string' ? input.prefix : '';
  const assetDir = `assets/${prefix}`;

  const plotW = plot.right - plot.left;
  const plotH = plot.bottom - plot.top;
  const count = values.length;
  // 柱间距随柱数收缩（5 根时 40px，7 根时更窄），再按剩余宽度均分柱宽。
  const gap = count <= 1 ? 0 : Math.max(10, Math.min(40, Math.round(plotW / (count * 4))));
  const barW = Math.max(8, Math.floor((plotW - gap * (count - 1)) / count));
  const total = count * barW + (count - 1) * gap;
  const offsetX = plot.left + Math.round((plotW - total) / 2);
  const maxValue = Math.max(...values);

  const bars = values.map((value, index) => {
    // 高度相对最大值算：换一组量纲（0..1 或 0..30）图形一致，这是「图表」而不是「常数放大」。
    const ratio = maxValue === 0 ? 0 : value / maxValue;
    // 0 值画 1px 基线：ops 不接受零面积矩形，且「有这根柱、值为 0」需要看得见。
    const h = Math.max(1, Math.round(ratio * plotH));
    return {
      index,
      value,
      label: labels[index] ?? '',
      color: colorAt(index),
      rect: { x: offsetX + index * (barW + gap), y: plot.bottom - h, w: barW, h },
    };
  });

  const axisW = plotW + 10;
  const axisH = plotH + 3;
  /** @type {any[]} */
  const ops = [
    {
      op: 'insert',
      clip: {
        id: 'axis-x',
        src: `${assetDir}axis.png`,
        time: [0, 4],
        box: { x: plot.left - 10, y: plot.bottom, w: axisW, h: 3 },
      },
      track: { insert: 0 },
    },
    {
      op: 'insert',
      clip: {
        id: 'axis-y',
        src: `${assetDir}axis.png`,
        time: [0, 4],
        box: { x: plot.left - 10, y: plot.top, w: 3, h: axisH },
      },
      track: 0,
    },
  ];
  for (const bar of bars) {
    ops.push({
      op: 'insert',
      clip: { id: `bar-${String(bar.index)}`, src: `${assetDir}bar-${String(bar.index)}.png`, time: [0, 4], box: bar.rect },
      track: 0,
    });
  }

  const files = [
    { path: `${assetDir}axis.png`, data: solidPng(AXIS_COLOR) },
    ...bars.map((bar) => ({ path: `${assetDir}bar-${String(bar.index)}.png`, data: solidPng(bar.color) })),
  ];

  return {
    kind: 'chart',
    ops,
    // 轴 + 每根柱一张 8×8 PNG：文件名与 ops 里的 src 一一对应。
    files,
    /* `assets` 是 M87 验收链用的旧名字，和 `files` 同一份（M93 搬包时保留，别让老脚本改一圈）。 */
    assets: files,
    layout: {
      stage,
      plot,
      plotRect: { x: plot.left - 10, y: plot.top, w: axisW, h: axisH + 3 },
      barW,
      gap,
      offsetX,
      maxValue,
      bars,
    },
    meta: { title, values, labels, count, ops: ops.length, prefix },
  };
}
