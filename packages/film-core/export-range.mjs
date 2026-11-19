/**
 * 导出区间的输入解析与估算（M39 · B-MAIN-R20-020）——纯函数，不碰 DOM、不读盘。
 *
 * 这一层只回答三件事，且**只回答这三件**：
 *
 * 1. 用户敲进输入框的一串字符是什么意思（`parseRangeTime`）；
 * 2. 这一组区间能不能提交（`planRangeInputs`）——段数、先后、正负都在这儿判；
 * 3. 按 30fps 估算会出多少帧、多长（`estimateRangePlan`）。
 *
 * ## 为什么时间解析要复用 `parseCueTime`
 *
 * 字幕那套（`subtitle.mjs`）已经把 `HH:MM:SS.mmm` / `MM:SS.mmm` / 逗号毫秒都吃下了，
 * 而且**有一套自己的舍入**（毫秒四舍五入到整毫秒）。导出面板再写一个「差不多」的解析器，
 * 就会重演 R14-C1 的双解析器事故：同一串 `00:12.500` 在两边差 1ms，p99 断言就会偶发飘。
 * 所以这里只补一个 `parseCueTime` 认不了的形式——**纯小数秒**（`12.5`），
 * 其余全部原样交给它。
 *
 * ## 估算口径（写进交接，别猜）
 *
 * 面板显示的是**估算**，不是承诺：
 *
 *     总时长 = Σ(end − start)
 *     预计帧数 = Σ round((end − start) × 30)
 *
 * 30fps 是舞台的默认帧率（`film.html` 的 `<section fps>`，缺省 30）。真实帧数以
 * 202 返回的 `plan.frames` 为准——多段走的是**帧对齐**口径（见 `render/timeline-range.mjs`），
 * 非整帧边界上会有 ±1 帧的差，估算只用来让人心里有数。
 */

import { parseCueTime } from './subtitle.mjs';

/** 段数上限，与 `render/timeline-range.mjs` 的 `MAX_RANGES` 同一个数（1..100）。 */
export const MAX_EXPORT_RANGES = 100;

/** 估算用的默认帧率（面板标注「30fps 估算」）。 */
export const DEFAULT_ESTIMATE_FPS = 30;

/** 纯小数秒：`12`、`12.5`、`.5`、`0.125`。**不接受**科学计数法（用户不会那么敲）。 */
const PLAIN_SECONDS = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * 输入框文本 → 秒。两种写法都收：
 *
 * - `12.5`（纯小数秒，导出面板最常用）
 * - `00:12.500` / `0:12.5` / `00:00:12,500`（`parseCueTime` 的既有口径）
 *
 * 空串、负数、坏格式一律返回 `null`（不抛、不猜 0）。数字原样透传（有限且 ≥0）。
 *
 * @param {unknown} input
 * @returns {number|null}
 */
export function parseRangeTime(input) {
  if (typeof input === 'number') {
    return Number.isFinite(input) && input >= 0 ? input : null;
  }
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (text === '') return null;
  /* 先看纯小数：`parseCueTime` 要求至少 `秒.毫秒` 两段，认不了 `12.5` */
  if (PLAIN_SECONDS.test(text)) {
    const value = Number(text);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  return parseCueTime(text);
}

/**
 * 秒 → 输入框里最好看的那种写法。
 *
 * 整秒不留小数点（`12`），否则最多三位（`12.5`、`12.125`）——与 `parseRangeTime`
 * 对称：写回去的字符串再解析回来必须还是同一个数（单测 A0 会跑这个 round-trip）。
 *
 * @param {number} seconds
 * @returns {string}
 */
export function formatRangeTime(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return '0';
  const rounded = Math.round(value * 1000) / 1000;
  if (Number.isInteger(rounded)) return String(rounded);
  return String(rounded);
}

/**
 * @typedef {{ code: string, index: number, field: 'ranges'|'start'|'end', message: string }} RangeIssue
 */

/**
 * 一组输入行 → 可提交的区间数组 + 估算。
 *
 * 行可以是 `{ start, end }` 字符串（UI 的形态），也可以直接是 `[start, end]` 数字
 * （脚本/接口的形态）；两种都收，返回永远是 `[[start, end], ...]`。
 *
 * 判据（与任务书 A5 的五条一一对应）：
 * - 0 段 → `INVALID_RANGE`（`index: -1`，message 说「至少要一段」）
 * - >100 段 → `INVALID_RANGE`
 * - 某段解析不出来 → `index` 是该段 1 基序号，`field` 指出是 start 还是 end
 * - `start < 0` 或 `end <= start` → 同上
 * - 给了 `duration` 且 `end > duration`（超出 1e-6 容差）→ `index` + 实际时长写进 message
 *
 * **不合并、不重排、不裁剪**：用户写 `6:8` 在前就是那个顺序（A3 的判据）；越界不静默截。
 *
 * @param {Array<{start: unknown, end: unknown}|readonly [unknown, unknown]>} rows
 * @param {{ duration?: number, fps?: number }} [options]
 * @returns {{ ok: true, ranges: Array<[number, number]>, totalSec: number, frames: number, fps: number }
 *   | { ok: false, code: 'INVALID_RANGE', issue: RangeIssue, message: string }}
 */
export function planRangeInputs(rows, options = {}) {
  const fps = Number.isFinite(options.fps) && Number(options.fps) > 0 ? Number(options.fps) : DEFAULT_ESTIMATE_FPS;
  const duration = Number.isFinite(options.duration) && Number(options.duration) > 0 ? Number(options.duration) : null;
  /** @param {RangeIssue} issue @returns {{ok: false, code: 'INVALID_RANGE', issue: RangeIssue, message: string}} */
  const fail = (issue) => ({ ok: false, code: /** @type {const} */ ('INVALID_RANGE'), issue, message: issue.message });

  if (!Array.isArray(rows)) {
    return fail({ code: 'INVALID_RANGE', index: -1, field: 'ranges', message: 'ranges 必须是数组' });
  }
  if (rows.length === 0) {
    return fail({ code: 'INVALID_RANGE', index: -1, field: 'ranges', message: '至少要一段区间' });
  }
  if (rows.length > MAX_EXPORT_RANGES) {
    return fail({
      code: 'INVALID_RANGE',
      index: -1,
      field: 'ranges',
      message: `最多 ${MAX_EXPORT_RANGES} 段，收到 ${rows.length} 段`,
    });
  }

  /** @type {Array<[number, number]>} */
  const ranges = [];
  for (const [offset, row] of rows.entries()) {
    const index = offset + 1;
    const rawStart = Array.isArray(row) ? row[0] : /** @type {any} */ (row)?.start;
    const rawEnd = Array.isArray(row) ? row[1] : /** @type {any} */ (row)?.end;
    const start = parseRangeTime(rawStart);
    if (start === null) {
      return fail({
        code: 'INVALID_RANGE',
        index,
        field: 'start',
        message: `第 ${index} 段的起点看不懂：${JSON.stringify(rawStart ?? '')}（可写 12.5 或 00:12.500）`,
      });
    }
    const end = parseRangeTime(rawEnd);
    if (end === null) {
      return fail({
        code: 'INVALID_RANGE',
        index,
        field: 'end',
        message: `第 ${index} 段的终点看不懂：${JSON.stringify(rawEnd ?? '')}（可写 12.5 或 00:12.500）`,
      });
    }
    if (!(start < end)) {
      return fail({
        code: 'INVALID_RANGE',
        index,
        field: 'end',
        message: `第 ${index} 段需要 0 ≤ 起点 < 终点（当前 ${start} → ${end}）`,
      });
    }
    if (duration !== null && end > duration + 1e-6) {
      return fail({
        code: 'INVALID_RANGE',
        index,
        field: 'end',
        message: `第 ${index} 段终点 ${end}s 超出影片时长 ${duration}s`,
      });
    }
    ranges.push([start, end]);
  }

  const estimate = estimateRangePlan(ranges, fps);
  return { ok: true, ranges, totalSec: estimate.seconds, frames: estimate.frames, fps };
}

/**
 * 估算：总时长与预计帧数（**逐段**四舍五入后相加）。
 *
 * 逐段而不是先求总和：多段在计划层就是逐段帧对齐的（`buildTimeline`），
 * 先把 4 段各 0.49 帧合成 2 帧再取整，会与真实产出差一帧。
 *
 * @param {Array<readonly [number, number]>} ranges
 * @param {number} [fps]
 * @returns {{ seconds: number, frames: number, segments: number, fps: number }}
 */
export function estimateRangePlan(ranges, fps = DEFAULT_ESTIMATE_FPS) {
  const rate = Number.isFinite(fps) && Number(fps) > 0 ? Number(fps) : DEFAULT_ESTIMATE_FPS;
  let seconds = 0;
  let frames = 0;
  for (const range of Array.isArray(ranges) ? ranges : []) {
    const start = Number(range?.[0]);
    const end = Number(range?.[1]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    seconds += end - start;
    frames += Math.round((end - start) * rate);
  }
  return {
    seconds: Math.round(seconds * 1000) / 1000,
    frames,
    segments: Array.isArray(ranges) ? ranges.length : 0,
    fps: rate,
  };
}
