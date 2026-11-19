/**
 * look 联系表（NEW-09 / P57）：**按 count-1 等分，两端都覆盖**。
 *
 * 旧写法是 `start + (end - start) * i / count`（i = 0..count-1）。两端都不到：
 * 0–3 秒取 4 格会得到 0 / 0.75 / 1.5 / 2.25 —— 最后一格离结尾还差 0.75 秒，
 * 「只在最后 5% 变色/闪烁/黑帧」的页面在联系表上永远看不见。
 *
 * 现在的规则（`sheetTimes`）：
 *
 *   first = start
 *   last  = end − 1/fps      ← 区间里**最后一帧**的时间，不是 end（end 是开区间）
 *   step  = (last − first) / (count − 1)
 *
 * 于是 0–3 秒取 4 格（30fps）就是 0 / 0.9889 / 1.9778 / 2.9667 —— 末格是
 * 3 秒前**最后一帧**，不是 3；`count = 1` 只取起点；
 * 短于 1 帧的区间退化成 `[start]` 并在 `plan` 里标 `degenerate`。
 *
 * `count` 大于区间内的帧数时**不会**造出重复时间戳：有效格数被夹到帧数
 * （`planSheetTimes().truncated === true`），相邻时间戳仍严格递增。
 * 这条是硬要求——重复格子会让「末格是不是倒数第二格的复制」这个判据失效。
 *
 * 拼格（`composeSheet`）在纯 JS 里做（`png.mjs` 的 decode/encode），不经过 ffmpeg：
 * 逐格拷进大图、再编码一次，**像素一个都不重采样**，所以「最后一格 == 直接取那一帧」
 * 可以用像素哈希逐字节证明，而不是靠肉眼看。
 */

import { createHash } from 'node:crypto';

import { decodePng, encodePng } from './png.mjs';

export const LOOK_SHEET_VERSION = '1.0.0';

/** 时间戳统一到微秒，避免 0.1+0.2 之类的浮点尾巴让「严格递增」变成玄学。 */
const TIME_DECIMALS = 6;

/** @param {number} value */
function roundTime(value) {
  return Number(value.toFixed(TIME_DECIMALS));
}

export class LookSheetError extends Error {
  /** @param {string} code @param {string} message @param {Record<string, any>} [extra] */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'LookSheetError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * 区间 → 联系表时间戳（秒）。
 *
 * @param {number} from 起点（含）
 * @param {number} to 终点（**开区间**：最后一格是 `to − 1/fps`）
 * @param {number} count 想要的格数（≥1）
 * @param {{ fps?: number }} [opts] `fps` 决定「最后一帧」在哪；默认 30
 * @returns {number[]}
 */
export function sheetTimes(from, to, count, opts = {}) {
  return planSheetTimes({ start: from, end: to, count, ...opts }).times;
}

/**
 * 同 `sheetTimes`，但把「为什么是这些时间」一并返回（证据/日志要用）。
 *
 * @param {{ start: number, end: number, count: number, fps?: number }} input
 * @returns {{
 *   times: number[], requested: number, effective: number, truncated: boolean,
 *   degenerate: boolean, fps: number, start: number, end: number,
 *   lastFrameTime: number, step: number | null,
 * }}
 */
export function planSheetTimes(input) {
  const fps = Number(input.fps) > 0 ? Number(input.fps) : 30;
  const start = Number(input.start);
  const end = Number(input.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new LookSheetError('INVALID_RANGE', `sheetTimes needs finite numbers, got ${input.start}..${input.end}`);
  }
  if (!(end > start)) {
    throw new LookSheetError('INVALID_RANGE', `sheetTimes needs end > start, got ${start}..${end}`);
  }
  const requested = Math.max(1, Math.floor(Number(input.count) || 1));

  /* 末格 = 区间里**最后一帧**的时间：end 是开区间，最后一帧在 end − 1/fps。
     注意这里**不**把 end 对齐到帧格：end 可能是 3、10、29.97 的任意倍数，
     验收判据就是「end − 1/fps，误差 ≤ 1e-3」，对齐会引入最多 1 帧的偏差。 */
  const lastFrameTime = roundTime(end - 1 / fps);

  /* 从 start 到 lastFrameTime 之间还能放下几个「整帧格」。
     12 帧的片段（0.4s @30fps）→ 12；比 1 帧还短的区间 → 退化。 */
  const capacity = lastFrameTime > start
    ? Math.floor((lastFrameTime - start) * fps + 1e-9) + 1
    : 0;
  if (capacity === 0) {
    /* 短于 1 帧：只有起点这一个时刻是「有帧」的。不硬凑格数，如实退化。 */
    return {
      times: [roundTime(start)],
      requested,
      effective: 1,
      truncated: requested > 1,
      degenerate: true,
      fps,
      start,
      end,
      lastFrameTime: roundTime(start),
      step: null,
    };
  }

  const effective = Math.min(requested, capacity);
  if (effective === 1) {
    return {
      times: [roundTime(start)],
      requested,
      effective: 1,
      truncated: requested > 1,
      degenerate: false,
      fps,
      start,
      end,
      lastFrameTime,
      step: null,
    };
  }

  const step = (lastFrameTime - start) / (effective - 1);
  /** @type {number[]} */
  const times = [];
  for (let index = 0; index < effective; index += 1) times.push(roundTime(start + step * index));
  /* 末格钉死在 lastFrameTime：浮点累加不参与最后一格，避免 0.9999999 这种尾巴。 */
  times[effective - 1] = lastFrameTime;
  for (let index = 1; index < times.length; index += 1) {
    const previous = times[index - 1] ?? Number.NaN;
    const current = times[index] ?? Number.NaN;
    if (!(current > previous)) {
      throw new LookSheetError(
        'DUPLICATE_TIMES',
        `sheetTimes produced a non-increasing pair at ${index}: ${previous} → ${current}`,
        { times },
      );
    }
  }
  return {
    times,
    requested,
    effective,
    truncated: effective < requested,
    degenerate: false,
    fps,
    start,
    end,
    lastFrameTime,
    step: roundTime(step),
  };
}

/**
 * 解码 PNG → RGBA 图（统一成 4 通道，拼格时不用再管源是 RGB 还是 RGBA）。
 * @param {Buffer} png
 * @returns {{ width: number, height: number, channels: 4, data: Buffer }}
 */
export function toRgbaImage(png) {
  const image = decodePng(png);
  if (image.channels === 4) return /** @type {any} */ (image);
  /** @type {Buffer} */
  const data = Buffer.alloc(image.width * image.height * 4);
  for (let index = 0; index < image.width * image.height; index += 1) {
    const src = index * image.channels;
    const dst = index * 4;
    data[dst] = image.data[src] ?? 0;
    data[dst + 1] = image.data[src + 1] ?? 0;
    data[dst + 2] = image.data[src + 2] ?? 0;
    data[dst + 3] = image.channels === 2 ? (image.data[src + 1] ?? 0) : 255;
  }
  return { width: image.width, height: image.height, channels: 4, data };
}

/**
 * 按列数排成联系表（左→右、上→下，最后一格在**右下角**）。
 * 只做整像素拷贝，不缩放、不重采样。
 *
 * @param {Array<{ width: number, height: number, channels: 4, data: Buffer }>} tiles 顺序 = 时间顺序
 * @param {{ cols?: number }} [opts]
 * @returns {{ image: { width: number, height: number, channels: 4, data: Buffer }, cols: number, rows: number, cell: { w: number, h: number } }}
 */
export function composeSheet(tiles, opts = {}) {
  if (!Array.isArray(tiles) || tiles.length === 0) {
    throw new LookSheetError('INVALID', 'composeSheet needs at least one tile');
  }
  const first = /** @type {{ width: number, height: number, channels: 4, data: Buffer }} */ (tiles[0]);
  const cell = { w: first.width, h: first.height };
  if (!(cell.w > 0) || !(cell.h > 0)) {
    throw new LookSheetError('INVALID', `tile 0 has a zero dimension: ${cell.w}x${cell.h}`);
  }
  for (const [index, tile] of tiles.entries()) {
    if (tile.width !== cell.w || tile.height !== cell.h) {
      throw new LookSheetError(
        'INVALID',
        `tile ${index} is ${tile.width}x${tile.height}, earlier tiles were ${cell.w}x${cell.h}`,
      );
    }
  }
  const cols = Math.min(tiles.length, Math.max(1, Math.floor(Number(opts.cols) || Math.ceil(Math.sqrt(tiles.length)))));
  const rows = Math.ceil(tiles.length / cols);
  const width = cols * cell.w;
  const height = rows * cell.h;
  const data = Buffer.alloc(width * height * 4);
  for (const [index, tile] of tiles.entries()) {
    const col = index % cols;
    const row = Math.floor(index / cols);
    for (let y = 0; y < cell.h; y += 1) {
      const srcStart = y * cell.w * 4;
      const dstStart = ((row * cell.h + y) * width + col * cell.w) * 4;
      tile.data.copy(data, dstStart, srcStart, srcStart + cell.w * 4);
    }
  }
  return { image: { width, height, channels: 4, data }, cols, rows, cell };
}

/**
 * 从拼好的大图里切回第 `index` 格（与 `composeSheet` 的排布严格互逆）。
 * @param {{ width: number, height: number, channels: 4, data: Buffer }} sheet
 * @param {{ cols: number, cell: { w: number, h: number } }} layout
 * @param {number} index
 */
export function cropTile(sheet, layout, index) {
  if (!Number.isInteger(index) || index < 0 || index >= layout.cols * Math.ceil(sheet.height / layout.cell.h)) {
    throw new LookSheetError('INVALID', `cropTile index ${index} is out of the sheet`);
  }
  const col = index % layout.cols;
  const row = Math.floor(index / layout.cols);
  const { w, h } = layout.cell;
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const srcStart = ((row * h + y) * sheet.width + col * w) * 4;
    sheet.data.copy(data, y * w * 4, srcStart, srcStart + w * 4);
  }
  return { width: w, height: h, channels: /** @type {const} */ (4), data };
}

/**
 * 图 → PNG（`png.mjs` 的编码器是确定性的：同一份 RGBA 永远同一串字节）。
 * @param {{ width: number, height: number, channels: 4, data: Buffer }} image
 */
export function sheetPng(image) {
  return encodePng(image);
}

/**
 * 取一整套联系表：算时间 → 取帧（`stills.mjs`，一次 launch 循环多个 t）→ 拼格。
 *
 * 取帧走的是和 `export still` 完全一样的入口，所以「联系表里的最后一格」
 * 与「直接 seek 到 end − 1/fps 取的那一帧」是同一套合成结果。
 *
 * @param {{
 *   projectRoot: string,
 *   start: number,
 *   end: number,
 *   count: number,
 *   fps?: number,
 *   cols?: number,
 *   size?: { w: number, h: number },
 *   contentPort?: number,
 *   signal?: AbortSignal,
 *   logger?: (line: string) => void,
 * }} opts
 * @returns {Promise<{
 *   plan: ReturnType<typeof planSheetTimes>,
 *   times: number[],
 *   tiles: Array<{ t: number, png: Buffer, pixelSha256: string }>,
 *   sheet: { png: Buffer, width: number, height: number, cols: number, rows: number, cell: { w: number, h: number } },
 *   stage: { w: number, h: number },
 *   viewport: { w: number, h: number },
 * }>}
 */
export async function captureLookSheet(opts) {
  const plan = planSheetTimes(opts);
  const { captureStills } = await import('./stills.mjs');
  const captured = await captureStills({
    projectRoot: opts.projectRoot,
    times: plan.times,
    ...(opts.size ? { size: opts.size } : {}),
    ...(opts.contentPort !== undefined ? { contentPort: opts.contentPort } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
  /** @type {Array<{ t: number, png: Buffer, pixelSha256: string }>} */
  const tiles = [];
  /** @type {Array<{ width: number, height: number, channels: 4, data: Buffer }>} */
  const images = [];
  for (const shot of captured.shots) {
    const image = toRgbaImage(shot.png);
    images.push(image);
    tiles.push({ t: shot.t, png: shot.png, pixelSha256: pixelDigest(image) });
  }
  const composed = composeSheet(images, { cols: opts.cols });
  return {
    plan,
    times: plan.times,
    tiles,
    sheet: {
      png: sheetPng(composed.image),
      width: composed.image.width,
      height: composed.image.height,
      cols: composed.cols,
      rows: composed.rows,
      cell: composed.cell,
    },
    stage: captured.stage,
    viewport: captured.viewport,
  };
}

/**
 * 像素哈希：sha256(RGBA 原始字节)。PNG 文件字节会随编码器变（filter/压缩级别），
 * 像素哈希不会——「两张图是不是同一帧」要用这个口径判。
 * @param {{ width: number, height: number, channels: 4, data: Buffer }} image
 */
export function pixelDigest(image) {
  return createHash('sha256')
    .update(`${image.width}x${image.height}:`)
    .update(image.data)
    .digest('hex');
}
