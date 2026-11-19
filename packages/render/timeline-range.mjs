/**
 * 多段范围 → 拼接时间轴（P36 / RD-003）。
 *
 * 这一层只做**算术**：把用户给的一串 `a:b` 变成「每一段在成片里占哪几帧、对应原片哪一秒」。
 * 不碰媒体、不碰 ffmpeg、不写盘 —— 计划层（`film-plan.mjs`）拿它算 `at`/`time`，
 * 舞台层（`stage-capture.mjs`）拿它算第 i 帧该在哪一秒。
 *
 * 两条口径，写在最前面，因为它们是这一批唯一容易搞错的地方：
 *
 * 1. **单段保持历史语义**（R21 及以前）：`--range a:b` 的帧数是
 *    `round((b-a)*fps)`，第 i 帧在 `a + i/fps`。这是「窗口」，不要求 a/b 落在帧格上。
 *    改了它，R21 的产物 sha 就守不住了。
 * 2. **多段按帧对齐**：每段的起止先落到帧格 `round(t*fps)`，段内帧数 = 起止帧之差。
 *    理由是拼接必须帧连续：两段各多半帧会在接缝处多出/丢掉一帧，而帧序列是
 *    `-frames:v` 钉死的。多段的实际取用窗口就是**对齐后**的窗口，音画字幕都用同一个数。
 *
 * 两种口径的差别只在「非整帧边界」上（比如 30fps 下的 2.01s）：
 * 单段从 2.0100s 取 60 帧，多段从 2.0000s 取 61 帧。README 里有对照表。
 *
 * **帧率是 29.97 这类分数时（P42）**：`fps` 参数接受 `{num, den}`（或能归一成有理数的
 * 数字/字符串），帧数与时长一律整数运算（`round(t×num/den)`、`frames×den/num`）。
 * 单段的 `outputDuration` 在分数帧率下改用**帧格时长**（frames×den/num）而不是窗口长度：
 * 容器只认整帧：`-t 10` 配 300 帧（帧率 30000/1001）会在 10.0s 截断，元数据就成 10.0 了。
 * 整数帧率不动这一行 —— `-t` 与产物 sha 都保持 R21 口径。
 */

import { durationOfFrames, frameCountAt, rateOfFps } from './fps.mjs';

/** 有理帧率（`{num, den}`）。类型从 fps.mjs 借，避免每个文件各写一份。 */
/** @typedef {import('./fps.mjs').FpsRational} FpsRational */

/** 段数上限：与 job.mjs 的 spec.ranges 校验保持一致（1..100）。 */
export const MAX_RANGES = 100;

/**
 * 拼接点的防咔嗒淡入淡出（秒）。
 *
 * 只加在**被切开的**段首/段尾：波形在切点两侧本来就不连续，硬接会有一声"咔"。
 * 2ms 在 48kHz 下是 96 个采样，听感上是一瞬间的斜坡，不会削掉字头。
 * 片段的自然起止（源本身的开始/结束）不加，用户的 fade 属性也不覆盖。
 */
export const JOIN_FADE_SEC = 0.002;

const EPS = 1e-6;

/**
 * @typedef {{ code: string, message: string }} TimelineIssue
 */

export class TimelineRangeError extends Error {
  /**
   * @param {string} code
   * @param {string} detail
   */
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'TimelineRangeError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * @param {string} detail
 * @returns {never}
 */
function fail(detail) {
  throw new TimelineRangeError('INVALID_RANGE', detail);
}

/**
 * 校验并规整用户给的范围。
 *
 * - 不传 → `[[0, duration]]`（整片）。
 * - 段与段**允许重叠、不合并、不重排**：用户写 `6:8,2:4` 就是要那个顺序，
 *   写 `2:4,3:5` 就是要把重叠的两秒各放一遍。
 * - 越界不静默截：`end > duration` 直接报错（与单段 R21 语义一致）。
 *
 * @param {readonly (readonly [number, number])[] | undefined} input
 * @param {number} duration
 * @returns {Array<[number, number]>}
 */
export function normalizeRanges(input, duration) {
  if (input === undefined || input === null) {
    if (!(Number.isFinite(duration) && duration > 0)) {
      fail(`cannot default the range: film duration is ${String(duration)}`);
    }
    return [[0, round(duration, 6)]];
  }
  if (!Array.isArray(input) || input.length === 0) {
    fail('ranges must be a non-empty array of [start, end] pairs');
  }
  if (input.length > MAX_RANGES) {
    fail(`at most ${MAX_RANGES} ranges are supported, got ${input.length}`);
  }
  return input.map((range, index) => {
    if (!Array.isArray(range) || range.length !== 2) {
      fail(`range #${index + 1} must be [start, end] in seconds`);
    }
    const start = Number(range[0]);
    const end = Number(range[1]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      fail(`range #${index + 1} must be finite numbers`);
    }
    if (start < 0 || end <= start) {
      fail(`range #${index + 1} (${start}-${end}) is empty or negative`);
    }
    if (end > duration + EPS) {
      fail(`range #${index + 1} ends at ${end}s past film duration ${duration}s`);
    }
    return /** @type {[number, number]} */ ([round(start, 6), round(Math.min(end, duration), 6)]);
  });
}

/**
 * 把规整后的范围变成拼接时间轴。
 *
 * @param {Array<[number, number]>} ranges
 * @param {number | FpsRational} fps 整数/小数（29.97 → 30000/1001）或显式分数
 * @returns {{
 *   frameAligned: boolean,
 *   frames: number,
 *   outputDuration: number,
 *   segments: Array<{
 *     index: number, start: number, end: number, frames: number,
 *     startFrame: number | null, endFrame: number | null,
 *     outStartFrame: number, outStartSec: number, frameStartSec: number,
 *   }>,
 * }}
 */
export function buildTimeline(ranges, fps) {
  if (!Array.isArray(ranges) || ranges.length === 0) fail('ranges must not be empty');
  /** @type {ReturnType<typeof rateOfFps>} */
  let rate;
  try {
    rate = rateOfFps(fps);
  } catch (err) {
    fail(/** @type {any} */ (err)?.detail ?? String(err));
  }
  const fpsLabel = rate.arg;

  // 单段：保持 R21 语义 —— 窗口长度可以是任意小数，帧数四舍五入
  if (ranges.length === 1) {
    const [start, end] = /** @type {[number, number]} */ (ranges[0]);
    const frames = frameCountAt(rate, end - start);
    if (!(frames > 0)) {
      fail(`range ${start}-${end} is shorter than half a frame at ${fpsLabel}fps`);
    }
    return {
      frameAligned: false,
      frames,
      // 整数帧率：窗口长度就是输出时长（`-t` 与 R21 逐字节相同）；
      // 分数帧率：只能落帧格（frames×den/num），否则容器时长会漂出半帧。
      outputDuration: rate.den === 1 ? round(end - start, 6) : round(durationOfFrames(rate, frames), 6),
      segments: [
        {
          index: 0,
          start,
          end,
          frames,
          startFrame: null,
          endFrame: null,
          outStartFrame: 0,
          outStartSec: 0,
          frameStartSec: start,
        },
      ],
    };
  }

  let cumulative = 0;
  const segments = ranges.map(([rawStart, rawEnd], index) => {
    const startFrame = frameCountAt(rate, rawStart);
    const endFrame = frameCountAt(rate, rawEnd);
    const frames = endFrame - startFrame;
    if (!(frames > 0)) {
      fail(
        `range #${index + 1} (${rawStart}-${rawEnd}) is shorter than one frame at ${fpsLabel}fps ` +
          `(snapped to ${startFrame}-${endFrame})`,
      );
    }
    const segment = {
      index,
      // start/end 是**对齐后**的实际取用窗口：音画字幕全部按这两个数走
      start: round(durationOfFrames(rate, startFrame), 6),
      end: round(durationOfFrames(rate, endFrame), 6),
      frames,
      startFrame,
      endFrame,
      outStartFrame: cumulative,
      outStartSec: round(durationOfFrames(rate, cumulative), 6),
      frameStartSec: round(durationOfFrames(rate, startFrame), 6),
    };
    cumulative += frames;
    return segment;
  });

  return {
    frameAligned: true,
    frames: cumulative,
    outputDuration: round(durationOfFrames(rate, cumulative), 6),
    segments,
  };
}

/**
 * 第 i 帧对应原片的哪一秒。
 *
 * 单段时这就是 `start + i/fps`（与 R21 的 `range[0] + index/fps` 逐位相同，
 * 连 `toFixed(6)` 的取整方向都一样）；多段时先定位到段，再用段内偏移。
 *
 * @param {Array<{ frames: number, outStartFrame: number, frameStartSec: number }>} segments
 * @param {number | FpsRational} fps
 * @param {number} index 0 基帧号
 * @returns {number}
 */
export function frameTimeAt(segments, fps, index) {
  const i = Math.trunc(Number(index));
  const last = segments[segments.length - 1];
  if (!last) fail('cannot map a frame without segments');
  let segment = last;
  for (const candidate of segments) {
    if (i >= candidate.outStartFrame && i < candidate.outStartFrame + candidate.frames) {
      segment = candidate;
      break;
    }
  }
  /** @type {ReturnType<typeof rateOfFps>} */
  let rate;
  try {
    rate = rateOfFps(fps);
  } catch (err) {
    fail(/** @type {any} */ (err)?.detail ?? String(err));
  }
  const offset = i - segment.outStartFrame;
  // 整数帧率保持 `offset / num`：与 R21 的 `range[0] + i/fps` 逐位相同
  const t = segment.frameStartSec + (rate.den === 1 ? offset / rate.num : (offset * rate.den) / rate.num);
  return Number(t.toFixed(6));
}

/**
 * 某段在成片里的起止（秒），给报告与人读输出用。
 * @param {{ outStartFrame: number, frames: number }} segment
 * @param {number} fps
 */
export function segmentOutputWindow(segment, fps) {
  const rate = rateOfFps(fps);
  return {
    startSec: round(durationOfFrames(rate, segment.outStartFrame), 6),
    endSec: round(durationOfFrames(rate, segment.outStartFrame + segment.frames), 6),
  };
}

/**
 * @param {number} value
 * @param {number} digits
 */
function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
