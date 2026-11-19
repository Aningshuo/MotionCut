import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLIP_DISABLED_ATTR,
  CLIP_MARKERS_ATTR,
  clipMarkerAt,
  clipMarkersOf,
  encodeClipMarkers,
  isClipDisabled,
  timelineTimeOfClipMarker,
} from './clip-state.mjs';
import { parse, writeValue } from './film-doc.mjs';

test('clip markers stay attached to source time while moving, retiming and trimming', () => {
  const clip = { at: 5, time: [3, 11], speed: 2 };
  const marker = clipMarkerAt(clip, 6.5, { id: 'intro', name: ' 在这里入场 ' });
  assert.deepEqual(marker, { id: 'intro', sourceTime: 6, name: '在这里入场' });
  assert.ok(marker);
  assert.equal(timelineTimeOfClipMarker({ ...clip, at: 7 }, marker), 8.5);
  assert.equal(timelineTimeOfClipMarker({ ...clip, speed: 0.5 }, marker), 11);
  assert.equal(timelineTimeOfClipMarker({ ...clip, time: [7, 11] }, marker), null);
  assert.equal(clipMarkerAt(clip, 9, { id: 'end' }), null, 'out point is exclusive');
  assert.deepEqual(clipMarkerAt({ at: 5, time: [3], speed: 2 }, 6.5, { id: 'probed', durationSec: 2 }),
    { id: 'probed', sourceTime: 6 });
});

test('clip disabled state and markers round-trip through a film.html transaction', () => {
  const html = '<!doctype html><html><head><meta name="viewport" content="width=1280, height=720"></head><body><section><video id="a" src="assets/example.mp4#t=0,8"></video></section></body></html>';
  const before = parse(html);
  assert.ok(before.doc);
  const source = before.doc.tracks[0]?.clips[0];
  assert.ok(source);
  const marker = { id: 'm1', name: 'A & B “开场”', sourceTime: 6 };
  const encoded = encodeClipMarkers([marker, marker]);
  assert.ok(encoded);
  source.attrs = { ...(source.attrs ?? {}), [CLIP_DISABLED_ATTR]: '1', [CLIP_MARKERS_ATTR]: encoded };
  const write = writeValue(html, before.doc, before.sourceHash);
  assert.equal(write.ok, true, JSON.stringify(write));
  if (!write.ok) return;
  const reopened = parse(write.text).doc?.tracks[0]?.clips[0];
  assert.equal(isClipDisabled(reopened), true);
  assert.deepEqual(clipMarkersOf(reopened), [marker]);
  const modified = parse(write.text);
  const restored = modified.doc?.tracks[0]?.clips[0];
  assert.ok(restored);
  delete restored.attrs;
  const reenabled = writeValue(write.text, modified.doc, modified.sourceHash);
  assert.equal(reenabled.ok, true, JSON.stringify(reenabled));
  if (!reenabled.ok) return;
  assert.ok(!reenabled.text.includes(CLIP_DISABLED_ATTR));
  assert.ok(!reenabled.text.includes(CLIP_MARKERS_ATTR));
  assert.deepEqual(clipMarkersOf({ attrs: { [CLIP_MARKERS_ATTR]: '[{"id":"bad","sourceTime":-1}]' } }), []);
  assert.deepEqual(clipMarkersOf({ attrs: { [CLIP_MARKERS_ATTR]: 'invalid' } }), []);
});
