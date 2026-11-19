// @ts-nocheck -- Browser drag JSON is a dynamic boundary; these are executable contract fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Compile the real pure helper in memory: no browser, Vite server, or generated build files.
const moduleUrl = (source, fileName) => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {
  fileName,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText).toString('base64');
const typesUrl = moduleUrl(await readFile(new URL('./creation-library-types.ts', import.meta.url), 'utf8'), 'creation-library-types.ts');
const helperSource = (await readFile(new URL('./creation-drop.ts', import.meta.url), 'utf8'))
  .replaceAll("'./creation-library-types'", JSON.stringify(typesUrl));
const { parseResourceDrag, resourceDropTime, resourceDropAction, RESOURCE_DRAG_MIME } = await import(moduleUrl(helperSource, 'creation-drop.ts'));
const { resourceDragPayload } = await import(typesUrl);
const fps = { num: 30, den: 1 };
const resource = { projectId: 'current-project', itemId: 'transition/dissolve', category: 'transition', at: 4, track: 1 };
const cuts = [
  { from: { id: 'a' }, to: { id: 'b' }, trackIndex: 1, at: 4 },
  { from: { id: 'c' }, to: { id: 'd' }, trackIndex: 2, at: 4.02 },
];

test('resource identity is scoped to the exact project and never carries file access information', () => {
  const payload = resourceDragPayload('current-project', { id: 'project:assets/a.mp4', category: 'media', src: '/private/a.mp4' });
  assert.deepEqual(parseResourceDrag(payload, 'current-project'), { projectId: 'current-project', itemId: 'project:assets/a.mp4', category: 'media' });
  assert.equal(parseResourceDrag(payload, 'other-project'), null);
  assert.ok(!payload.includes('/private/'));
  assert.equal(RESOURCE_DRAG_MIME, 'application/x-opencut-resource+json');
});

test('malformed, oversized and unsupported-version drag envelopes are rejected', () => {
  for (const raw of ['{', 'null', '[]', JSON.stringify({ version: 2, projectId: 'current-project', itemId: 'a', category: 'media' }), JSON.stringify({ version: 1, projectId: 'current-project', itemId: 'a'.repeat(2049), category: 'media' })]) {
    assert.equal(parseResourceDrag(raw, 'current-project'), null);
  }
});

test('CSS coordinates include horizontal scrolling through the actual content rectangle exactly once', () => {
  const leftAtZeroScroll = 100, head = 148, pps = 64, time = 3.5;
  assert.equal(resourceDropTime(leftAtZeroScroll + head + time * pps, leftAtZeroScroll, head, pps, fps), time);
  const scrollLeft = 220;
  const scrolledContentLeft = leftAtZeroScroll - scrollLeft;
  const viewportPointer = scrolledContentLeft + head + time * pps;
  assert.equal(resourceDropTime(viewportPointer, scrolledContentLeft, head, pps, fps), time);
  assert.equal(resourceDropTime(viewportPointer + 300, scrolledContentLeft + 300, head, pps, fps), time, 'moving the editor window does not shift film time');
});

test('drop time snaps to rational project frames, independent of display DPR', () => {
  const rational = { num: 30000, den: 1001 };
  const rate = rational.num / rational.den;
  const time = resourceDropTime(423.2, 71.1, 148, 73, rational);
  assert.ok(Math.abs(time * rate - Math.round(time * rate)) < 1e-9);
  assert.equal(time, Math.round((423.2 - 71.1 - 148) / 73 * rate) / rate);
  assert.equal(resourceDropTime(423.2, 71.1, 148, 73, rational), time, 'browser coordinates are CSS pixels and must not be multiplied by DPR');
});

test('negative or invalid drop geometry never produces negative time, NaN or Infinity', () => {
  assert.equal(resourceDropTime(20, 100, 148, 64, fps), 0);
  for (const args of [[NaN, 0, 148, 64, fps], [200, 0, 148, 0, fps], [200, 0, 148, 64, { num: 30, den: 0 }], [200, 0, 148, 64, { num: 0, den: 1 }]]) assert.equal(resourceDropTime(...args), 0);
});

test('a transition drop resolves only a nearby seam on the chosen track and clip', () => {
  const action = resourceDropAction({ ...resource, at: 4.03, clipId: 'b', toleranceSec: 16 / 64 }, cuts);
  assert.deepEqual(action, { action: 'resource.apply', itemId: 'transition/dissolve', target: { from: 'a', to: 'b', durationSec: 0.6 } });
  assert.throws(() => resourceDropAction({ ...resource, clipId: 'd' }, cuts), /接缝/);
  assert.throws(() => resourceDropAction({ ...resource, track: 3 }, cuts), /接缝/);
});

test('a distant transition drop cannot silently change a different cut elsewhere in the film', () => {
  assert.throws(() => resourceDropAction({ ...resource, at: 100, toleranceSec: 16 / 64 }, cuts), /接缝/);
  assert.throws(() => resourceDropAction({ ...resource, at: 4.3, toleranceSec: 0.25 }, cuts), /接缝/);
  const action = resourceDropAction({ ...resource, track: 2, at: 4.02 }, cuts);
  assert.equal(action.target.from, 'c');
  assert.equal(action.target.to, 'd');
});

test('regular resources preserve exact destination and reject overlap unless a new track was requested', () => {
  const media = { ...resource, category: 'media', itemId: 'project:assets/a.mp4', at: 7.5, track: 2 };
  assert.deepEqual(resourceDropAction(media, []), { action: 'resource.apply', itemId: media.itemId, target: { at: 7.5, track: 2, mode: 'reject-overlap' } });
  assert.equal(resourceDropAction({ ...media, newTrack: true }, []).target.mode, 'new-track');
  assert.equal(resourceDropAction({ ...media, track: null }, []).target.mode, 'new-track');
});

test('filters dropped on a clip target that clip rather than inserting a second scene or changing time', () => {
  const action = resourceDropAction({ ...resource, category: 'filter', itemId: 'filter/soft', at: 2, clipId: 'clip-a' }, []);
  assert.deepEqual(action.target, { at: 2, track: 1, mode: 'clip', clipId: 'clip-a' });
});
