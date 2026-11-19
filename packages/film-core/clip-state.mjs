import { parseSeconds } from './time.mjs';

/** Editor clip state stored in ordinary, round-trippable film.html data attributes. */
export const CLIP_DISABLED_ATTR = 'data-opencut-disabled';
export const CLIP_DISABLED_VALUE = '1';
export const CLIP_MARKERS_ATTR = 'data-opencut-markers';

const MARKER_LIMIT = 100;
const MARKER_JSON_LIMIT = 131072;

/** @param {{overrides?: readonly Record<string, unknown>[]} | null | undefined} clip */
export function hasClipKeyframes(clip) {
  return clip?.overrides?.some(entry => Array.isArray(entry?.kf) && entry.kf.length > 0) === true;
}

/** @typedef {{ id: string, sourceTime: number, name?: string }} ClipMarker */
/** @typedef {{ at?: number, time?: readonly number[], speed?: number, nativeDuration?: number, attrs?: Record<string, string> }} ClipState */

/** @param {{ attrs?: Record<string, string> } | null | undefined} clip */
export function isClipDisabled(clip) {
  return clip?.attrs?.[CLIP_DISABLED_ATTR] === CLIP_DISABLED_VALUE;
}

/**
 * @param {unknown} value
 * @returns {ClipMarker[]}
 */
function validMarkers(value) {
  if (!Array.isArray(value)) return [];
  /** @type {ClipMarker[]} */
  const markers = [];
  const used = new Set();
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const { id, sourceTime, name } = entry;
    if (typeof id !== 'string' || !id.trim() || id.length > 80 || used.has(id)) continue;
    if (typeof sourceTime !== 'number' || !Number.isFinite(sourceTime) || sourceTime < 0) continue;
    const title = typeof name === 'string' ? name.trim().slice(0, 80) : '';
    used.add(id);
    markers.push({ id, sourceTime, ...(title ? { name: title } : {}) });
    if (markers.length >= MARKER_LIMIT) break;
  }
  return markers;
}

/** @param {{ attrs?: Record<string, string> } | null | undefined} clip */
export function clipMarkersOf(clip) {
  const raw = clip?.attrs?.[CLIP_MARKERS_ATTR];
  if (typeof raw !== 'string' || raw.length > MARKER_JSON_LIMIT) return [];
  try {
    return validMarkers(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** @param {readonly ClipMarker[]} markers */
export function encodeClipMarkers(markers) {
  const value = validMarkers(markers);
  return value.length ? JSON.stringify(value) : null;
}

/**
 * Use a probed source end only when there is no explicit source out point.
 * @param {ClipState} clip
 * @param {number} [durationSec] A known time occupied on the timeline, already adjusted by speed.
 */
function timingOf(clip, durationSec) {
  const at = clip.at ?? 0;
  const start = clip.time?.[0] ?? 0;
  const speed = clip.speed ?? 1;
  const native = clip.nativeDuration ?? parseSeconds(clip.attrs?.['data-native']);
  const end = clip.time?.[1] ?? (durationSec === undefined ? native : start + durationSec * speed);
  if (!Number.isFinite(at) || !Number.isFinite(start) || !Number.isFinite(speed) || speed <= 0) return null;
  if (typeof end !== 'number' || !Number.isFinite(end) || end <= start) return null;
  return { at, start, end, speed };
}

/**
 * @param {ClipState} clip
 * @param {number} timelineTime
 * @param {{ id: string, name?: string, durationSec?: number }} options
 * @returns {ClipMarker|null}
 */
export function clipMarkerAt(clip, timelineTime, { id, name, durationSec }) {
  const timing = timingOf(clip, durationSec);
  if (!timing || !Number.isFinite(timelineTime)) return null;
  const sourceTime = timing.start + (timelineTime - timing.at) * timing.speed;
  if (sourceTime < timing.start || sourceTime >= timing.end) return null;
  return validMarkers([{ id, sourceTime, name }])[0] ?? null;
}

/**
 * Markers outside a newly trimmed source span remain stored for future trim expansion.
 * @param {ClipState} clip
 * @param {ClipMarker} marker
 * @param {number} [durationSec]
 */
export function timelineTimeOfClipMarker(clip, marker, durationSec) {
  const timing = timingOf(clip, durationSec);
  if (!timing || !Number.isFinite(marker.sourceTime)) return null;
  if (marker.sourceTime < timing.start || marker.sourceTime >= timing.end) return null;
  return timing.at + (marker.sourceTime - timing.start) / timing.speed;
}
