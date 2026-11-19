/**
 * 时间线几何：像素 ↔ 秒 ↔ 帧。纯函数，不碰 DOM。
 *
 * 所有对外的时间值都**取整到毫秒**（film.html 写毫秒，拖动带浮点噪声），
 * 帧号一律用有理数帧率换算（29.97 = 30000/1001），不用浮点累加。
 */

import { frameToSeconds, secondsToFrame } from '../../../../film-core/time.mjs';

/** 拖动落点的精度：毫秒。 */
export const TIME_STEP = 0.001;

/** @param {number} value */
export function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * @param {number} px @param {number} pxPerSecond
 * @returns {number} 秒（毫秒精度）
 */
export function pixelsToSeconds(px, pxPerSecond) {
  if (!Number.isFinite(px) || !Number.isFinite(pxPerSecond) || pxPerSecond <= 0) return 0;
  return roundMs(px / pxPerSecond);
}

/**
 * @param {number} seconds @param {number} pxPerSecond
 * @returns {number} 像素
 */
export function secondsToPixels(seconds, pxPerSecond) {
  if (!Number.isFinite(seconds) || !Number.isFinite(pxPerSecond)) return 0;
  return Math.round(seconds * pxPerSecond * 100) / 100;
}

/**
 * 吸附到最近的帧边界（有理数）。
 * @param {number} seconds @param {{ num: number, den: number }} fps
 */
export function snapSecondsToFrame(seconds, fps) {
  return frameToSeconds(secondsToFrame(seconds, fps), fps);
}

/**
 * 一帧在给定缩放下的像素宽度。
 * @param {{ num: number, den: number }} fps @param {number} pxPerSecond
 */
export function pixelsPerFrame(fps, pxPerSecond) {
  return (fps.den / fps.num) * pxPerSecond;
}

/**
 * 片段在时间线上占的区间（秒）。`at` 缺省 0；`speed` 只影响占用长度，不改源区间。
 * @param {{ at?: number, time?: number[], speed?: number }} clip
 * @returns {{ start: number, end: number, length: number }}
 */
export function clipSpan(clip) {
  const start = Number(clip.at ?? 0);
  const time = Array.isArray(clip.time) ? clip.time : null;
  const speed = typeof clip.speed === 'number' && clip.speed > 0 ? clip.speed : 1;
  const length = time === null ? 0 : (Number(time[1]) - Number(time[0])) / speed;
  return { start, end: roundMs(start + length), length: roundMs(length) };
}

/**
 * 时间线时间 t → 源内时间（裁剪用）。
 * @param {{ at?: number, time?: number[], speed?: number }} clip @param {number} t
 */
export function sourceTimeAt(clip, t) {
  const time = Array.isArray(clip.time) ? clip.time : null;
  if (time === null) return null;
  const speed = typeof clip.speed === 'number' && clip.speed > 0 ? clip.speed : 1;
  return roundMs(Number(time[0]) + (t - Number(clip.at ?? 0)) * speed);
}

/**
 * 源内时间 → 时间线时间。
 * @param {{ at?: number, time?: number[], speed?: number }} clip @param {number} s
 */
export function timelineTimeAt(clip, s) {
  const time = Array.isArray(clip.time) ? clip.time : null;
  if (time === null) return null;
  const speed = typeof clip.speed === 'number' && clip.speed > 0 ? clip.speed : 1;
  return roundMs(Number(clip.at ?? 0) + (s - Number(time[0])) / speed);
}
