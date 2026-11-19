const LABEL_SPACING_PX = 60;
const TICK_SPACING_PX = 8;
const INTERVALS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 18000];
const DIVISIONS = [10, 5, 4, 2, 1];

/** @param {{pixelsPerSecond:number,duration:number,scrollLeft:number,viewportWidth:number}} view */
export function timelineRuler({ pixelsPerSecond, duration, scrollLeft, viewportWidth }) {
  const scale = Number.isFinite(pixelsPerSecond) && pixelsPerSecond > 0 ? pixelsPerSecond : 1;
  const major = INTERVALS.find(seconds => seconds * scale >= LABEL_SPACING_PX) ?? INTERVALS.at(-1) ?? 1;
  const majorPx = major * scale;
  const divisions = DIVISIONS.find(count => majorPx / count >= TICK_SPACING_PX) ?? 1;
  const first = Math.max(0, Math.floor(scrollLeft / majorPx) - 1);
  const last = Math.min(Math.floor(duration / major), Math.ceil((scrollLeft + viewportWidth) / majorPx) + 1);
  const labels = Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => (first + index) * major);
  return { majorPx, minorPx: majorPx / divisions, labels };
}

/**
 * Find the nearest scroll position that keeps a moving playhead in view.
 * @param {number} position
 * @param {number} scrollLeft
 * @param {number} viewportWidth
 * @param {number} maxScroll
 */
export function playheadScrollLeft(position, scrollLeft, viewportWidth, maxScroll) {
  if (viewportWidth <= 0 || maxScroll <= 0) return scrollLeft;
  const margin = Math.min(24, viewportWidth / 4);
  const target = Math.min(position - margin, Math.max(scrollLeft, position - viewportWidth + margin));
  return Math.max(0, Math.min(maxScroll, target));
}

/**
 * Horizontal scrub velocity in CSS pixels per second, signed toward the nearby edge.
 * @param {number} pointer
 * @param {number} left
 * @param {number} right
 */
export function scrubEdgeVelocity(pointer, left, right) {
  const edge = Math.min(32, (right - left) / 3);
  if (edge <= 0) return 0;
  const distanceLeft = Math.max(0, pointer - left);
  const distanceRight = Math.max(0, right - pointer);
  if (distanceLeft < edge) return -960 * (1 - distanceLeft / edge);
  if (distanceRight < edge) return 960 * (1 - distanceRight / edge);
  return 0;
}

/** @param {number} time */
export function formatRulerLabel(time) {
  const total = Math.floor(time);
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  if (minutes < 60) return `${String(minutes).padStart(2, '0')}:${seconds}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${seconds}`;
}
