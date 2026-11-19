/**
 * 时间与帧率：有理数秒，禁止浮点累加计时。
 * 合同：contracts/film-doc.ts v1.0.0（Rational / PAST_END_EPS）。
 */

/** @typedef {{ readonly num: number, readonly den: number }} Rational */
/** @typedef {{ readonly from: number, readonly to: number }} TimeRange */
/** @typedef {'BAD_TIME'|'TIME_INVERTED'|'TIME_PAST_END'} TimeCode */
/** @typedef {{ readonly code: TimeCode, readonly message: string }} TimeProblem */

/** 末端容差：素材可能是 2.166667s，film.html 写 2.167 必须接受。误差上限 1ms + 1e-6。 */
export const PAST_END_EPS = 0.001 + 1e-6;

const DECIMAL = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;
const RATIONAL = /^(-?\d+)(?:\/(\d+))?$/;
const FRAGMENT = /#t=([^&]*)$/;

/**
 * 解析十进制秒（只接受纯十进制，拒绝 1e3 / 0x10 / 空串）。
 * @param {unknown} input
 * @returns {number|null}
 */
export function parseSeconds(input) {
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (text === '' || !DECIMAL.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * 解析有理数帧率，如 `30000/1001`、`30`；约分后返回。
 * @param {unknown} input
 * @returns {Rational|null}
 */
export function parseRational(input) {
  if (typeof input !== 'string') return null;
  const match = RATIONAL.exec(input.trim());
  if (match === null) return null;
  const numText = match[1];
  const denText = match[2];
  if (numText === undefined) return null;
  const num = Number(numText);
  const den = denText === undefined ? 1 : Number(denText);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0 || num <= 0) return null;
  return reduce({ num, den });
}

/**
 * @param {Rational} value
 * @returns {Rational}
 */
export function reduce(value) {
  const divisor = gcd(Math.abs(value.num), Math.abs(value.den));
  return { num: value.num / divisor, den: value.den / divisor };
}

/**
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function gcd(a, b) {
  let x = a;
  let y = b;
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x === 0 ? 1 : x;
}

/**
 * @param {Rational} value
 * @returns {number}
 */
export function rationalToNumber(value) {
  return value.num / value.den;
}

/**
 * @param {Rational} value
 * @returns {string}
 */
export function formatRational(value) {
  return `${value.num}/${value.den}`;
}

/**
 * 解析 `from,to`（区间与淡入淡出共用的写法）。
 * @param {unknown} input
 * @returns {TimeRange|null}
 */
export function parseTimeRange(input) {
  if (typeof input !== 'string') return null;
  const parts = input.split(',');
  if (parts.length !== 2) return null;
  const from = parseSeconds(parts[0]);
  const to = parseSeconds(parts[1]);
  if (from === null || to === null) return null;
  return { from, to };
}

/**
 * 解析 URL 片段 `#t=from,to`（可选前导 `t=` 之外的内容一律拒绝）。
 * @param {unknown} href
 * @returns {TimeRange|null}
 */
export function parseTimeFragment(href) {
  if (typeof href !== 'string') return null;
  const match = FRAGMENT.exec(href);
  const body = match?.[1];
  if (body === undefined) return null;
  return parseTimeRange(body);
}

/**
 * 校验区间：负数/非数 → BAD_TIME；倒置 → TIME_INVERTED；超出素材真实时长 → TIME_PAST_END。
 * `native` 为 null 表示真实时长未知（不得用 0 冒充）。
 * @param {TimeRange} range
 * @param {number|null} native
 * @returns {TimeProblem|null}
 */
export function validateRange(range, native) {
  if (!Number.isFinite(range.from) || !Number.isFinite(range.to)) {
    return { code: 'BAD_TIME', message: '时间必须是有限数值' };
  }
  if (range.from < 0 || range.to < 0) {
    return { code: 'BAD_TIME', message: `时间不得为负：${range.from},${range.to}` };
  }
  if (range.to < range.from) {
    return { code: 'TIME_INVERTED', message: `区间倒置：${range.from} > ${range.to}` };
  }
  if (native !== null && range.to > native + PAST_END_EPS) {
    return {
      code: 'TIME_PAST_END',
      message: `区间末端 ${range.to} 超出素材真实时长 ${native}（容差 ${PAST_END_EPS}）`,
    };
  }
  return null;
}

/**
 * 片段在时间线上占用的时长（秒）；speed 只影响播放速度，不影响区间长度。
 * @param {TimeRange|null} range
 * @param {number} speed
 * @returns {number|null}
 */
export function clipDuration(range, speed) {
  if (range === null) return null;
  if (!Number.isFinite(speed) || speed <= 0) return null;
  return (range.to - range.from) / speed;
}

/**
 * 时间线时间 t → 源内时间。`at` 缺省按 0。
 * @param {{ at?: number, range?: TimeRange|null, speed?: number }} clip
 * @param {number} t
 * @returns {number|null}
 */
export function sourceTimeAt(clip, t) {
  const range = clip.range ?? null;
  if (range === null) return null;
  const speed = clip.speed ?? 1;
  if (!Number.isFinite(speed) || speed <= 0) return null;
  const at = clip.at ?? 0;
  return range.from + (t - at) * speed;
}

/**
 * 帧号 ↔ 秒（有理数，避免浮点累加）。frame 从 0 开始。
 * @param {number} frame
 * @param {Rational} fps
 * @returns {number}
 */
export function frameToSeconds(frame, fps) {
  return (frame * fps.den) / fps.num;
}

/**
 * @param {number} seconds
 * @param {Rational} fps
 * @returns {number}
 */
export function secondsToFrame(seconds, fps) {
  return Math.round((seconds * fps.num) / fps.den);
}
