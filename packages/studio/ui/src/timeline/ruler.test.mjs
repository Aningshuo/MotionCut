import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRulerLabel, playheadScrollLeft, scrubEdgeVelocity, timelineRuler } from './ruler.mjs';

test('equal zoom uses equal major and minor ticks for short and long timelines', () => {
  const view = { pixelsPerSecond: 64, scrollLeft: 0, viewportWidth: 800 };
  const short = timelineRuler({ ...view, duration: 12 });
  const long = timelineRuler({ ...view, duration: 167.5 });
  assert.equal(short.majorPx, 64);
  assert.equal(short.minorPx, 12.8);
  assert.equal(short.majorPx, long.majorPx);
  assert.deepEqual(long.labels.slice(0, 4), [0, 1, 2, 3]);
});

test('scrolled labels start near the visible range and adapt to reduced zoom', () => {
  const { majorPx, minorPx, labels } = timelineRuler({
    pixelsPerSecond: 16, duration: 90_000, scrollLeft: 64_000, viewportWidth: 1100,
  });
  assert.equal(majorPx, 80);
  assert.ok(minorPx >= 8 && minorPx < majorPx);
  assert.ok(labels.length < 20);
  assert.equal(labels[1], 4000);
  assert.equal(formatRulerLabel(labels[1]), '1:06:40');
});

test('playhead follow scrolls the minimum distance in either direction within content bounds', () => {
  assert.equal(playheadScrollLeft(500, 200, 600, 1000), 200);
  assert.equal(playheadScrollLeft(215, 200, 600, 1000), 191);
  assert.equal(playheadScrollLeft(801, 200, 600, 1000), 225);
  assert.equal(playheadScrollLeft(0, 200, 600, 1000), 0);
  assert.equal(playheadScrollLeft(1600, 200, 600, 1000), 1000);
  assert.equal(playheadScrollLeft(400, 0, 600, 0), 0);
});

test('scrubbing scrolls toward either edge and stops in the middle', () => {
  assert.equal(scrubEdgeVelocity(132, 132, 900), -960);
  assert.equal(scrubEdgeVelocity(148, 132, 900), -480);
  assert.equal(scrubEdgeVelocity(300, 132, 900), 0);
  assert.equal(scrubEdgeVelocity(884, 132, 900), 480);
  assert.equal(scrubEdgeVelocity(910, 132, 900), 960);
  assert.equal(scrubEdgeVelocity(132, 132, 132), 0);
});
