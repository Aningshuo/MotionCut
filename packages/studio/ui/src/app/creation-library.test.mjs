import test from 'node:test';
import assert from 'node:assert/strict';
const {
  CREATION_CATEGORIES, RESOURCE_DRAG_MIME, arrangedLibraryCategories, filterLibraryItems,
  libraryActionTarget, libraryAudioSources, libraryCaptionRows, libraryCaptionVersions, libraryDuration, libraryPreviewKind, pickLibrarySelection,
  resourceDragPayload, safeLibraryPreviewUrl,
} = /** @type {typeof import('./creation-library-types.ts')} */ (await import(new URL('./creation-library-types.ts', import.meta.url).href));

/** @param {Record<string, any>} patch @returns {import('./creation-library-types.ts').LibraryItem} */
const item = (patch = {}) => ({ id: 'a', name: '录屏', category: 'media', group: '本地', source: 'project', kind: 'video', mediaKind: 'video', availability: 'ready', ...patch });
/** @type {import('./creation-library-types.ts').LibraryFilter} */
const filter = { category: 'media', query: '', scope: 'all', mediaKind: 'all', sort: 'recent' };

test('an undone page copy stays in project resources without duplicating the media grid', () => {
  const source = item({ id: 'source', src: 'scenes/card.html', refs: 0 });
  const copy = item({ id: 'copy', src: 'assets/creation-library/0123456789abcdef01234567/scenes/card.html', refs: 0 });
  assert.deepEqual(filterLibraryItems([source, copy], filter), [source]);
  assert.ok(filterLibraryItems([source, copy], { ...filter, scope: 'project' }).includes(copy));
  assert.ok(filterLibraryItems([source, copy], { ...filter, query: copy.name }).includes(copy));
  for (const visible of [{ ...copy, refs: 1 }, { ...copy, favorite: true }]) assert.deepEqual(filterLibraryItems([visible], filter), [visible]);
});

test('all twelve creation domains plus the existing layers remain navigable after a partial preference order', () => {
  assert.deepEqual(arrangedLibraryCategories().slice(0, 3).map(one => one.id), ['media', 'layers', 'effect']);
  assert.equal(arrangedLibraryCategories(['media', 'layers', 'skill', 'effect'])[2]?.label, '动画库');
  const result = arrangedLibraryCategories(['music', 'media', 'unknown', 'music']);
  assert.equal(result.length, 13);
  assert.equal(new Set(result.map((one) => one.id)).size, 13);
  assert.deepEqual(new Set(result.map((one) => one.id)), new Set(CREATION_CATEGORIES.map((one) => one.id)));
  assert.ok(result.find((one) => one.id === 'layers'));
});

test('catalog filtering composes category, Unicode search, source and media type without mutating server data', () => {
  const source = [item(), item({ id: 'b', name: '旁白', mediaKind: 'sound', kind: 'sound', tags: ['教程'], source: 'saved' }), item({ id: 'c', category: 'music', name: '教程音乐' })];
  assert.deepEqual(filterLibraryItems(source, { ...filter, query: '教程', scope: 'saved', mediaKind: 'sound' }).map((one) => one.id), ['b']);
  assert.deepEqual(source.map((one) => one.id), ['a', 'b', 'c']);
});

test('favorites and folder scope use the persisted identity rather than labels or paths', () => {
  const source = [item({ folderId: 'f1', favorite: true }), item({ id: 'b', name: '录屏', folderId: 'f2' })];
  assert.deepEqual(filterLibraryItems(source, { ...filter, scope: 'folder:f2' }).map((one) => one.id), ['b']);
  assert.deepEqual(filterLibraryItems(source, { ...filter, scope: 'favorites' }).map((one) => one.id), ['a']);
});

test('recent and duration sorting tolerate missing metadata, with unknown durations at the end', () => {
  const source = [item({ id: 'a' }), item({ id: 'b', durationSec: 10, modifiedAt: '2026-11-17T01:00:00Z' }), item({ id: 'c', durationSec: 2, modifiedAt: '2026-11-16T01:00:00Z' })];
  assert.deepEqual(filterLibraryItems(source, filter).map((one) => one.id), ['b', 'c', 'a']);
  assert.deepEqual(filterLibraryItems(source, { ...filter, sort: 'duration' }).map((one) => one.id), ['c', 'b', 'a']);
});

test('range selection follows filtered order; modifiers preserve or toggle only the requested resources', () => {
  const visible = ['a', 'c', 'd'];
  assert.deepEqual(pickLibrarySelection(['z'], 'd', visible, { anchor: 'a', range: true }), ['a', 'c', 'd']);
  assert.deepEqual(pickLibrarySelection(['z'], 'd', visible, { anchor: 'a', range: true, additive: true }), ['z', 'a', 'c', 'd']);
  assert.deepEqual(pickLibrarySelection(['a', 'd'], 'a', visible, { additive: true }), ['d']);
  assert.deepEqual(pickLibrarySelection(['z'], 'c', visible, { anchor: 'hidden', range: true }), ['c']);
});

test('drag payload only carries opaque identity and project scope, never a source path or token', () => {
  const source = item({ src: '/Users/private/secret.mp4', previewUrl: 'https://example.test/?token=secret' });
  const data = resourceDragPayload('project-2', source);
  assert.equal(RESOURCE_DRAG_MIME, 'application/x-opencut-resource+json');
  assert.deepEqual(JSON.parse(data), { version: 1, projectId: 'project-2', itemId: 'a', category: 'media' });
  assert.ok(!data.includes('secret'));
});

test('ordinary applies are overlays, with a copy of selected targets and a valid playhead', () => {
  const selected = ['clip-a'];
  const target = libraryActionTarget(-2, selected);
  selected.push('clip-b');
  assert.deepEqual(target, { at: 0, mode: 'overlay', selectedClipIds: ['clip-a'] });
  assert.equal('clipId' in target, false);
  assert.equal(libraryActionTarget(Number.NaN, []).at, 0);
});

test('HTML resources are previewed as documents even when their category is an effect or text', () => {
  assert.equal(libraryPreviewKind(item({ category: 'effect', kind: 'effect', previewUrl: '/api/creation-library/file?itemId=x&asset=scene.html' })), 'page');
  assert.equal(libraryPreviewKind(item({ category: 'text', kind: 'textstyle', mediaKind: 'page' })), 'page');
  assert.equal(libraryPreviewKind(item({ kind: 'sound', mediaKind: 'sound' })), 'audio');
  assert.equal(libraryPreviewKind(item()), 'video');
  assert.equal(libraryPreviewKind(item({ kind: 'still', mediaKind: 'still' })), 'image');
});

test('preview URLs reject active/file schemes and protocol-relative hosts', () => {
  for (const input of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd', '//external.test/x', '\u0000/x']) assert.equal(safeLibraryPreviewUrl(input), '');
  for (const input of ['/api/projects/a/creation-library/file?itemId=b', 'blob:https://app.test/a', 'https://app.test/preview']) assert.equal(safeLibraryPreviewUrl(input), input);
});

test('duration badge omits invalid durations rather than displaying NaN or made-up lengths', () => {
  assert.equal(libraryDuration(61.9), '1:01');
  assert.equal(libraryDuration(0), '0:00');
  assert.equal(libraryDuration(null), '');
  assert.equal(libraryDuration(-1), '');
  assert.equal(libraryDuration(Number.NaN), '');
});

test('source-clock caption snapshot keeps original source indices when trimmed cues are shown on the timeline', () => {
  const snapshot = { projectId: 'p', sourceHash: 'a', items: [], folders: [], captions: { file: 'a.vtt', cues: [{ start: 0, end: 1, text: 'outside' }, { start: 12, end: 14, text: 'visible' }], timelineCues: [{ start: 5, end: 6, text: 'visible', sourceIndex: 1, clipId: 'trimmed' }] } };
  const rows = libraryCaptionRows(snapshot);
  assert.equal(rows[0]?.sourceIndex, 1);
  assert.equal(rows[0]?.start, 5);
  assert.equal(snapshot.captions.cues[1]?.start, 12, 'read-only adaptation does not rewrite source times');
});

test('new caption audio source shape uses real clip identity and speed-adjusted duration, with legacy compatibility', () => {
  const snapshot = { projectId: 'p', sourceHash: 'a', items: [], folders: [], audio: { sources: [{ clipId: 'clip-2', src: 'assets/voice.wav', mapping: { clipId: 'clip-2', at: 5, sourceIn: 10, sourceOut: 16, speed: 2 } }] } };
  assert.deepEqual(libraryAudioSources(snapshot), [{ id: 'clip-2', name: 'voice.wav', src: 'assets/voice.wav', durationSec: 3 }]);
  assert.deepEqual(libraryAudioSources({ ...snapshot, audio: [{ id: 'legacy', name: '旧音轨', src: 'a.wav', durationSec: 2 }] })[0]?.id, 'legacy');
  assert.equal(libraryAudioSources({ ...snapshot, audio: [{ id: 'project:asset.wav', name: '资产', src: 'asset.wav', durationSec: 9 }], captionSources: snapshot.audio })[0]?.id, 'clip-2', 'caption picker uses clip identity rather than the generic asset-pool identity');
});

test('subtitle versions list only real completed translations of the currently selected media', () => {
  const mapping = { clipId: 'a', at: 0, sourceIn: 0, sourceOut: 20, speed: 1 };
  const snapshot = { projectId: 'p', sourceHash: 'a', items: [], folders: [], captions: { file: 'assets/a.vtt', src: 'assets/a.mp4', cues: [], mapping }, captionSources: { sources: [{ clipId: 'a', src: 'assets/a.mp4', mapping }] }, jobs: [
    { id: 'real', kind: 'translate', state: 'completed', result: { ok: true, src: 'assets/a.translated-en.vtt', mediaSrc: 'assets/a.mp4', mapping } },
    { id: 'failed', kind: 'translate', state: 'failed', result: { src: 'assets/a.translated-ja.vtt', mediaSrc: 'assets/a.mp4' } },
    { id: 'other', kind: 'translate', state: 'completed', result: { src: 'assets/b.translated-en.vtt', mediaSrc: 'assets/b.mp4' } },
  ] };
  assert.deepEqual(libraryCaptionVersions(snapshot).map(one => one.src), ['assets/a.mp4', 'assets/a.translated-en.vtt']);
  const translated = { ...snapshot, captions: { ...snapshot.captions, src: 'assets/a.translated-en.vtt', mediaSrc: 'assets/a.mp4' } };
  assert.equal(libraryCaptionVersions(translated)[0]?.src, 'assets/a.mp4', 'switching a version never replaces the identity of the original');
});
