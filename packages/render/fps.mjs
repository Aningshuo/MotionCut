/**
 * 帧率（P42 / RD-008）：**有理数**，不是小数。
 *
 * 为什么非要有这一层：`--fps 29.97` 以前直接 `Number()` 后一路当 29.97 用，
 * 送进 ffmpeg 就是 `-r 29.97`（= 2997/100）。
 *
 * - 2997/100 与 30000/1001 每帧差 0.0337ms，一小时差 **~3.6 秒**；
 * - 更致命的是 NLE/广播：FCP/Premiere 认的是 30000/1001，容器里写 `29.97` 会得到
 *   `r_frame_rate=2997/100`，一进时间线就被判成"非标准帧率"。
 *
 * 所以这里只做一件事：把用户写的 `30` / `29.97` / `23.976` / `59.94` / `30000/1001`
 * 归一成 `{num, den}`，之后**所有**帧数/时长/帧位置都用整数运算：
 *
 *   frames        = round(t × num / den)
 *   duration      = frames × den / num
 *   frameTime(i)  = (frameIndex) × den / num
 *
 * 整数帧率（den === 1）保持历史口径逐位不变：`round(t × fps)`、`i / fps`，
 * 连除法与乘法的先后顺序都照旧，否则 30fps 的产物 sha 会漂。
 *
 * 明确不做：不改 `contracts/render.ts` 的 `fps?: number`（合同里那行注释已经写了
 * 「29.97 = 30000/1001」）；有理数只在本模块、计划层内部与 ffmpeg 参数里出现。
 */

/** 帧率上限：与 `job.mjs` 的 spec 校验（0 < fps ≤ 120）取宽松的一侧，给高帧率留余量。 */
export const FPS_MAX = 240;

/**
 * NTSC 帧率的别名表。用户写的小数只是**别名**，真正要送出去的是右边的分数。
 *
 * 容差 0.01：`29.97`（29.97）与 `30000/1001`（29.97002997）差 0.00003，
 * `23.976` 差 0.000024，`59.94` 差 0.00006 —— 都在容差内，而 `29.9` / `24` 不会误命中。
 */
export const NTSC_RATES = Object.freeze([
  Object.freeze({ num: 24000, den: 1001, alias: 23.976 }),
  Object.freeze({ num: 30000, den: 1001, alias: 29.97 }),
  Object.freeze({ num: 60000, den: 1001, alias: 59.94 }),
]);

export class FpsError extends Error {
  /**
   * @param {string} detail
   */
  constructor(detail) {
    super(`INVALID_FPS: ${detail}`);
    this.name = 'FpsError';
    this.code = 'INVALID_FPS';
    this.detail = detail;
  }
}

/**
 * @typedef {{ num: number, den: number }} FpsRational
 * @typedef {FpsRational & { value: number, arg: string, source: string }} FpsRate
 */

/**
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function gcd(a, b) {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y > 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x || 1;
}

/**
 * @param {number} num
 * @param {number} den
 * @param {string} source 原样输入（写进 plan，便于对账）
 * @returns {FpsRate}
 */
function rateOf(num, den, source) {
  if (!Number.isInteger(num) || !Number.isInteger(den) || num <= 0 || den <= 0) {
    throw new FpsError(`"${source}" does not reduce to a positive integer ratio`);
  }
  const divisor = gcd(num, den);
  const n = num / divisor;
  const d = den / divisor;
  const value = n / d;
  if (!(value > 0) || value > FPS_MAX) {
    throw new FpsError(`fps must be in (0, ${FPS_MAX}], got ${value} (from "${source}")`);
  }
  return { num: n, den: d, value, arg: d === 1 ? String(n) : `${n}/${d}`, source };
}

/**
 * 用户输入 → 有理帧率。
 *
 * 接受：`30`（数或串）、`29.97`、`23.976`、`59.94`、`30000/1001`、`{num, den}`。
 * 拒绝：0、负数、> 240、非数、`29.97.5`、`30000/0`、`0/1001`。
 *
 * @param {unknown} raw
 * @returns {FpsRate}
 */
export function parseFps(raw) {
  if (raw === undefined || raw === null || raw === '') {
    throw new FpsError('fps is required here (callers default to 30 before calling)');
  }
  if (typeof raw === 'object') {
    const value = /** @type {any} */ (raw);
    if (Number.isFinite(value.num) && Number.isFinite(value.den)) {
      return rateOf(Number(value.num), Number(value.den), `${value.num}/${value.den}`);
    }
    throw new FpsError(`fps object must be {num, den}, got ${JSON.stringify(raw)}`);
  }
  const text = String(raw).trim();
  if (text === '') throw new FpsError('fps is empty');

  const slash = text.indexOf('/');
  if (slash >= 0) {
    const numText = text.slice(0, slash).trim();
    const denText = text.slice(slash + 1).trim();
    if (!/^\d+$/.test(numText) || !/^\d+$/.test(denText)) {
      throw new FpsError(`"${text}" is not a num/den ratio`);
    }
    return rateOf(Number(numText), Number(denText), text);
  }

  const value = Number(text);
  if (!Number.isFinite(value)) throw new FpsError(`"${text}" is not a number`);
  if (value <= 0) throw new FpsError(`fps must be positive, got ${text}`);
  if (value > FPS_MAX) throw new FpsError(`fps must be <= ${FPS_MAX}, got ${text}`);
  if (Number.isInteger(value)) return rateOf(value, 1, text);

  for (const ntsc of NTSC_RATES) {
    if (Math.abs(value - ntsc.alias) < 0.01) return rateOf(ntsc.num, ntsc.den, text);
  }
  // 自定义小数：round(x*1000)/1000 后转有理再约分，写进 plan 的是约分后的分数
  const thousandths = Math.round(value * 1000);
  if (thousandths <= 0) throw new FpsError(`fps is too small: ${text}`);
  return rateOf(thousandths, 1000, text);
}

/**
 * 计划层/渲染层内部用：已经归一过的就透传，没给就按 30。
 *
 * @param {unknown} raw
 * @param {number} [fallback]
 * @returns {FpsRate}
 */
export function rateOfFps(raw, fallback = 30) {
  if (raw === undefined || raw === null || raw === '') return parseFps(fallback);
  if (typeof raw === 'object' && raw !== null && 'num' in raw && 'den' in raw && 'arg' in raw) {
    return /** @type {FpsRate} */ (raw);
  }
  return parseFps(raw);
}

/**
 * 秒 → 帧数。整数运算：`round(t × num / den)`。
 * @param {FpsRate | FpsRational} rate
 * @param {number} seconds
 * @returns {number}
 */
export function frameCountAt(rate, seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return 0;
  return Math.round((value * rate.num) / rate.den);
}

/**
 * 帧数 → 秒。`frames × den / num`，不累加浮点。
 * @param {FpsRate | FpsRational} rate
 * @param {number} frames
 * @returns {number}
 */
export function durationOfFrames(rate, frames) {
  const count = Number(frames);
  if (!Number.isFinite(count)) return 0;
  return (count * rate.den) / rate.num;
}

/**
 * 第 i 帧的秒数（相对某个起点 0）。
 * @param {FpsRate | FpsRational} rate
 * @param {number} index
 * @returns {number}
 */
export function secondOfFrame(rate, index) {
  return durationOfFrames(rate, Number(index));
}

/**
 * 秒 → 所在帧格的**帧号**（向下取整，带 1e-9 的容差吃掉浮点毛刺）。
 *
 * 容差的方向与字幕映射一致（P23 起）：起点宁可早半帧，终点宁可晚半帧，
 * 不能因为 0.0333333 与 0.0333334 的差别把句首吞掉。
 *
 * @param {FpsRate | FpsRational} rate
 * @param {number} seconds
 * @returns {number}
 */
export function frameIndexAt(rate, seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return 0;
  return Math.floor((value * rate.num) / rate.den + 1e-9);
}

/**
 * 秒 → 覆盖它所需的**结束帧号**（向上取整）。
 * @param {FpsRate | FpsRational} rate
 * @param {number} seconds
 * @returns {number}
 */
export function frameIndexCeil(rate, seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return 0;
  return Math.ceil((value * rate.num) / rate.den - 1e-9);
}

/**
 * 帧号 → 秒，但**整数帧率保持历史表达式** `Math.floor(sec/(1/fps))*(1/fps)`。
 *
 * 这不是洁癖：`i * (1/30)` 与 `i / 30` 可能差 1 个 ULP，30fps 的 VTT 会因此
 * 差 1 微秒，sha 就守不住了。分数帧率才走整数运算。
 *
 * @param {FpsRate | FpsRational} rate
 * @param {number} seconds
 * @param {'floor' | 'ceil'} mode
 * @returns {number}
 */
export function snapSecondsToFrame(rate, seconds, mode) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return 0;
  if (rate.den === 1) {
    const frame = 1 / rate.num;
    return mode === 'floor'
      ? Math.floor(value / frame + 1e-9) * frame
      : Math.ceil(value / frame - 1e-9) * frame;
  }
  const index = mode === 'floor' ? frameIndexAt(rate, value) : frameIndexCeil(rate, value);
  return durationOfFrames(rate, index);
}

/**
 * 给计划/结果/证据用的稳定摘要。
 * @param {FpsRate} rate
 */
export function describeFps(rate) {
  return { fps: rate.value, fpsRational: { num: rate.num, den: rate.den }, fpsArg: rate.arg };
}
