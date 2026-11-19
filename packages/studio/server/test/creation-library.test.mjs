// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createProjectRegistry } from '../projects.mjs';
import { createEventHub } from '../events.mjs';
import { createFilmDocIo } from '../film-io.mjs';
import { parse, sha256 } from '../../../film-core/film-doc.mjs';
import { readCreationLibrary, applyCreationLibraryAction, resolveCreationLibraryFile } from '../creation-library.mjs';
import { ORIGINAL_CATALOG } from '../creation-library-catalog.mjs';
import { readState, writeSceneBundle } from '../creation-library-store.mjs';

const film = (locked = false, stage = { w: 1280, h: 720 }) => `<!doctype html><html><head><meta name="viewport" content="width=${stage.w},height=${stage.h}"><meta name="fps" content="30"></head><body><section${locked ? ' locked' : ''}><video id="first" src="assets/main.mp4#t=2,6" at="0"></video><video id="next" src="assets/main.mp4#t=6,10" at="4"></video></section></body></html>`;
async function fixture(t, locked = false, stage = { w: 1280, h: 720 }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-creation-library-'));
  const libraryRoot = path.join(root, 'library'), dir = path.join(root, 'project');
  await fs.mkdir(path.join(dir, 'assets', 'nested'), { recursive: true });
  await fs.writeFile(path.join(dir, 'film.html'), film(locked, stage));
  await fs.writeFile(path.join(dir, 'assets', 'main.mp4'), 'fixture-placeholder-bytes-not-a-preview');
  await fs.writeFile(path.join(dir, 'assets', 'nested', 'unused.png'), 'unused-bytes');
  const registry = createProjectRegistry({ hub: createEventHub(), io: createFilmDocIo(), history: false, watchImpl: () => ({ close() {} }) });
  const opened = await registry.open(dir); assert.equal(opened.ok, true, opened.message);
  const project = registry.get(opened.project.projectId);
  const services = { skillsRoot: path.join(root, 'no-user-skills') };
  const base = { registry, project, libraryRoot, services };
  t.after(async () => { await registry.closeAll(); await fs.rm(root, { recursive: true, force: true }); });
  return { ...base, root, dir, hash: () => registry.docOf(project.projectId).hash, doc: () => registry.docOf(project.projectId).doc,
    action: (request) => applyCreationLibraryAction({ ...base, request }), read: () => readCreationLibrary(base) };
}
test('library exposes unused recursive assets, real HTML previews, original catalog and actual transition cuts', async (t) => {
  const f = await fixture(t); const snap = await f.read();
  assert.ok(snap.items.some((x) => x.id === 'project:assets/nested/unused.png' && x.refs === 0));
  assert.equal(snap.items.find((x) => x.id === 'project:assets/main.mp4').refs, 2);
  for (const category of ['text', 'template', 'sticker', 'filter', 'effect']) {
    const rows = snap.items.filter((x) => x.category === category); assert.ok(rows.length >= 8);
    for (const row of rows) { assert.equal(row.availability, 'ready'); assert.equal(row.thumbUrl, undefined); const file = await resolveCreationLibraryFile({ ...f, itemId: row.id, asset: 'scene.html' }); const html = await fs.readFile(file.path, 'utf8'); assert.match(html, /window\.film/); assert.match(file.mime, /text\/html/); }
  }
  assert.ok(snap.items.filter((x) => x.category === 'transition').length >= 40);
  assert.equal(snap.cuts[0].from, 'first'); assert.equal(snap.cuts[0].to, 'next');
  assert.equal(snap.items.some((x) => ['music', 'sound'].includes(x.category) && x.availability === 'ready'), false, 'no invented audio availability');
});
test('motion catalog templates apply editable parameters, produce reproducible seeks and reopen as scene clips', async t => {
  const f = await fixture(t);
  const items = (await f.read()).items.filter(item => item.category === 'template' && item.group === '动态图形');
  assert.deepEqual(items.map(item => item.variant).sort(), ['compare', 'dial', 'folio', 'route']);
  for (const item of items) {
    const params = { title: '测试 <标题>', duration: 4, accent: '#e5a300' };
    const result = await f.action({ action: 'resource.apply', itemId: item.id, params,
      target: { mode: 'overlay', at: 0 }, expectedHash: f.hash(), opId: `motion-${item.variant}` });
    assert.equal(result.ok, true, JSON.stringify(result));
    const clip = parse(await fs.readFile(path.join(f.dir, 'film.html'), 'utf8')).doc.tracks.flatMap(track => track.clips).find(one => one.id === result.clipId);
    assert.equal(clip.kind, 'page'); assert.deepEqual(clip.time, [0, 4]);
    const file = path.join(f.dir, clip.src);
    const html = await fs.readFile(file, 'utf8');
    const values = JSON.parse(await fs.readFile(path.join(path.dirname(file), 'props.json'), 'utf8')).values;
    assert.equal(values.title, params.title); assert.match(html, /测试 &lt;标题&gt;/);
    assert.equal(values.accent, params.accent); assert.match(html, /data-aiedit-id="title"/);
    const state = {};
    const context = { window: {}, document: { documentElement: { style: { setProperty(key, value) { state[key] = value; } } } } };
    vm.runInNewContext(/<script>([\s\S]*?)<\/script>/.exec(html)[1], context);
    const sample = time => { context.window.film.frame(time); return { ...state }; };
    const opening = sample(.25); assert.notDeepEqual(sample(2), opening);
    assert.deepEqual(sample(.25), opening); assert.equal(context.window.film.meta.duration, 4);
  }
});

test('asset pool omits unreferenced sidecars and internal instance folders while preserving real source diagnostics', async (t) => {
  const f = await fixture(t), auxiliaries = ['demo.vtt', 'demo.srt', 'notes.json', 'scene.js', 'style.css', 'unused.unknown'];
  for (const name of auxiliaries) await fs.writeFile(path.join(f.dir, 'assets', name), `user-source:${name}`);
  const applied = await f.action({ action: 'resource.apply', itemId: 'builtin:text-basic', expectedHash: f.hash(), opId: 'internal-folder', target: { mode: 'overlay', at: 0 } }); assert.equal(applied.ok, true);
  const initial = await f.read();
  for (const name of auxiliaries) assert.equal(initial.items.some(item => item.id === `project:assets/${name}`), false, name);
  assert.ok(initial.items.some(item => item.src === applied.src && item.availability === 'ready'), 'editable generated scene remains visible');
  assert.equal(initial.folders.some(folder => folder.id.startsWith('project-folder:assets/creation-library')), false);
  assert.ok(initial.folders.some(folder => folder.id === 'project-folder:assets/nested'), 'ordinary user folder remains');
  const originalHash = f.hash(), originalBytes = await fs.readFile(path.join(f.dir, 'film.html'));
  const changed = await f.registry.applyOps(f.project.projectId, { expectedHash: originalHash, opId: 'real-unsupported-reference', by: 'person' }, [{ op: 'fields', clip: 'first', fields: { src: 'assets/demo.vtt' } }, { op: 'fields', clip: 'next', fields: { src: 'assets/missing.unknown' } }]); assert.equal(changed.ok, true, JSON.stringify(changed));
  const beforeRead = f.hash(), snapshot = await f.read();
  const referenced = snapshot.items.find(item => item.id === 'project:assets/demo.vtt'); assert.equal(referenced.refs, 1); assert.equal(referenced.availability, 'failed'); assert.match(referenced.reason, /仍引用/); assert.equal(referenced.previewUrl, undefined);
  const missing = snapshot.items.find(item => item.id === 'project:assets/missing.unknown'); assert.equal(missing.availability, 'missing'); assert.equal(missing.refs, 1);
  assert.equal(f.hash(), beforeRead, 'read never rewrites film');
  for (const name of auxiliaries) assert.equal(await fs.readFile(path.join(f.dir, 'assets', name), 'utf8'), `user-source:${name}`);
  assert.equal((await f.registry.undo(f.project.projectId, { expectedHash: f.hash(), opId: 'undo-unsupported-reference' })).ok, true); assert.deepEqual(await fs.readFile(path.join(f.dir, 'film.html')), originalBytes);
});
test('HTML apply uses original registry ops, one undo, stable replay and editable source after reopen', async (t) => {
  const f = await fixture(t), before = f.hash();
  const request = { action: 'resource.apply', itemId: 'builtin:text-basic', text: '这是真实标题', expectedHash: before, opId: 'html-1', target: { at: 1.02, mode: 'overlay' } };
  const applied = await f.action(request); assert.equal(applied.ok, true, JSON.stringify(applied));
  const clip = f.doc().tracks.flatMap((x) => x.clips).find((x) => x.id === applied.clipId);
  assert.equal(clip.kind, 'page'); assert.ok(Math.abs(clip.at - 1.0333333333333334) < 0.001);
  assert.match(await fs.readFile(path.join(f.dir, clip.src), 'utf8'), /这是真实标题/);
  const replay = await f.action(request); assert.equal(replay.replayed, true); assert.equal(replay.hash, applied.hash);
  assert.equal((await f.action({ ...request, text: '不得用同key改内容' })).code, 'OP_ID_REUSED');
  assert.equal(f.doc().tracks.flatMap((x) => x.clips).filter((x) => x.id === clip.id).length, 1);
  const parsed = parse(await fs.readFile(path.join(f.dir, 'film.html'), 'utf8')); assert.ok(parsed.doc.tracks.some((x) => x.clips.some((c) => c.src === clip.src)));
  const undone = await f.registry.undo(f.project.projectId, { expectedHash: f.hash(), opId: 'undo-html' }); assert.equal(undone.ok, true, JSON.stringify(undone)); assert.equal(f.hash(), before);
});
test('new original pages contain their editable 1280x720 design inside small and portrait film stages', async (t) => {
  const { stripTypeScriptTypes } = await import('node:module');
  const js = stripTypeScriptTypes(await fs.readFile(new URL('../../ui/src/app/element-space.ts', import.meta.url), 'utf8'));
  const { pageFit } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
  for (const stage of [{ w: 640, h: 360 }, { w: 360, h: 640 }]) {
    const f = await fixture(t, false, stage), before = f.hash();
    const result = await f.action({ action: 'resource.apply', itemId: 'builtin:template-chart', expectedHash: before, opId: `chart-${stage.w}-${stage.h}`, target: { mode: 'overlay', at: 0 } });
    assert.equal(result.ok, true, JSON.stringify(result));
    const clip = f.doc().tracks.flatMap(track => track.clips).find(clip => clip.id === result.clipId);
    assert.deepEqual(clip.size, { w: 1280, h: 720 }); assert.deepEqual(clip.box, { x: 0, y: 0, ...stage });
    const fit = pageFit(clip, stage), expectedScale = stage.w / 1280;
    assert.equal(fit.k, expectedScale); assert.equal(fit.x, 0); assert.equal(fit.y, (stage.h - 720 * expectedScale) / 2);
    assert.ok(fit.y >= 0 && fit.y + 720 * fit.k <= stage.h, 'no clipping or aspect stretch');
    const reopened = parse(await fs.readFile(path.join(f.dir, 'film.html'), 'utf8')).doc.tracks.flatMap(track => track.clips).find(c => c.id === clip.id);
    assert.deepEqual(reopened.box, clip.box); assert.deepEqual(reopened.size, clip.size);
    assert.equal((await f.registry.undo(f.project.projectId, { expectedHash: f.hash(), opId: 'undo-fit' })).ok, true); assert.equal(f.hash(), before);
  }
});
test('film writes reject missing envelope, stale hash, lock and overlap without changing film', async (t) => {
  const f = await fixture(t, true), before = await fs.readFile(path.join(f.dir, 'film.html'));
  const base = { action: 'resource.apply', itemId: 'builtin:text-basic', expectedHash: f.hash(), opId: 'lock', target: { at: 0, track: 0, mode: 'reject-overlap' } };
  assert.equal((await f.action({ ...base, expectedHash: undefined })).code, 'EXPECTED_HASH_REQUIRED');
  assert.equal((await f.action({ ...base, opId: undefined })).code, 'OP_ID_REQUIRED');
  assert.equal((await f.action({ ...base, expectedHash: '0'.repeat(64) })).code, 'CONFLICT');
  assert.equal((await f.action(base)).code, 'LOCKED'); assert.deepEqual(await fs.readFile(path.join(f.dir, 'film.html')), before);
  const u = await fixture(t);
  assert.equal((await u.action({ ...base, expectedHash: u.hash(), opId: 'overlap' })).code, 'OVERLAP');
  const ripple = await u.action({ ...base, expectedHash: u.hash(), opId: 'ripple', target: { at: 4, track: 0, mode: 'ripple', durationSec: 2 } }); assert.equal(ripple.ok, true, JSON.stringify(ripple));
  assert.equal(u.doc().tracks[0].clips.find((x) => x.id === 'next').at, 6);
});
test('filter click creates a true adjustment layer; clip drop changes only that clip and respects intensity', async (t) => {
  const f = await fixture(t);
  const clip = await f.action({ action: 'resource.apply', itemId: 'builtin:filter-mono', params: { intensity: 0.5 }, target: { mode: 'clip', clipId: 'first' }, expectedHash: f.hash(), opId: 'filter-clip' });
  assert.equal(clip.ok, true, JSON.stringify(clip)); assert.match(f.doc().tracks[0].clips[0].style, /grayscale\(0.5\)/); assert.equal(f.doc().tracks[0].clips[1].style, undefined);
  const layer = await f.action({ action: 'resource.apply', itemId: 'builtin:filter-warm', target: { mode: 'overlay', at: 0, durationSec: 3 }, expectedHash: f.hash(), opId: 'filter-layer' });
  assert.equal(layer.ok, true, JSON.stringify(layer)); const inserted = f.doc().tracks.flatMap((x) => x.clips).find((x) => x.id === layer.clipId); assert.match(inserted.style, /backdrop-filter: sepia/); assert.equal(inserted.kind, 'page');
});
test('Saved deep copies local dependencies; cross-project instances retain source trims and stay independent', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.dir, 'scenes', 'card'), { recursive: true });
  await fs.writeFile(path.join(f.dir, 'scenes', 'card', 'scene.html'), '<link rel="stylesheet" href="style.css"><div id="title">源码</div><img srcset="data:image/png;base64,dA== 1x, bg.png 2x"><script src="scene.js"></script>');
  await fs.writeFile(path.join(f.dir, 'scenes', 'card', 'style.css'), '.card{color:red;background:url(bg.png)}');
  await fs.writeFile(path.join(f.dir, 'scenes', 'card', 'scene.js'), 'window.film={frame(){}}; import("./dependency.js");');
  await fs.writeFile(path.join(f.dir, 'scenes', 'card', 'dependency.js'), 'export const ownDependency=true;');
  await fs.writeFile(path.join(f.dir, 'scenes', 'card', 'bg.png'), 'background');
  const saved = await f.action({ action: 'resource.save', itemId: 'project:scenes/card/scene.html', opId: 'save-source', name: '可编辑卡片' }); assert.equal(saved.ok, true, JSON.stringify(saved));
  const use = async (id) => f.action({ action: 'resource.apply', itemId: saved.itemId, target: { mode: 'overlay', at: 0 }, expectedHash: f.hash(), opId: id });
  const a = await use('saved-a'), b = await use('saved-b'); assert.equal(a.ok, true, JSON.stringify(a)); assert.equal(b.ok, true, JSON.stringify(b)); assert.notEqual(a.src, b.src);
  const firstCss = path.join(path.dirname(a.src), 'style.css'); await fs.writeFile(path.join(f.dir, firstCss), '.card{color:blue}');
  assert.match(await fs.readFile(path.join(f.dir, path.dirname(b.src), 'style.css'), 'utf8'), /color:red/);
  assert.match(await fs.readFile(path.join(f.dir, path.dirname(b.src), 'dependency.js'), 'utf8'), /ownDependency/);
  assert.match(await fs.readFile(path.join(f.dir, 'scenes', 'card', 'style.css'), 'utf8'), /color:red/);
  const savedVideo = await f.action({ action: 'resource.save', itemId: 'project:assets/main.mp4', target: { clipId: 'first' }, opId: 'save-trim' }); assert.equal(savedVideo.ok, true, JSON.stringify(savedVideo));
  const applied = await f.action({ action: 'resource.apply', itemId: savedVideo.itemId, expectedHash: f.hash(), opId: 'trim-copy', target: { mode: 'overlay', at: 1 } }); assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.deepEqual(f.doc().tracks.flatMap((x) => x.clips).find((x) => x.id === applied.clipId).time, [2, 6]);
  const otherDir = path.join(f.root, 'other'); await fs.mkdir(otherDir); await fs.writeFile(path.join(otherDir, 'film.html'), film()); const opened = await f.registry.open(otherDir); assert.equal(opened.ok, true);
  const other = f.registry.get(opened.project.projectId);
  const cross = await applyCreationLibraryAction({ ...f, project: other, request: { action: 'resource.apply', itemId: saved.itemId, expectedHash: other.sourceHash, opId: 'cross', target: { mode: 'overlay', at: 0 } } }); assert.equal(cross.ok, true, JSON.stringify(cross));
  assert.match(await fs.readFile(path.join(otherDir, path.dirname(cross.src), 'style.css'), 'utf8'), /color:red/);
});
test('virtual names/folders/favorites/remove preserve sources and film, safe static resolver blocks traversal/symlinks', async (t) => {
  const f = await fixture(t), hash = f.hash(); const itemId = 'project:assets/main.mp4';
  const folder = await f.action({ action: 'folder.create', name: '口播素材' }); assert.equal(folder.ok, true);
  assert.equal((await f.action({ action: 'resource.rename', itemId, name: '原始口播' })).ok, true);
  await f.action({ action: 'resource.move', itemId, folderId: folder.folderId }); await f.action({ action: 'resource.favorite', itemId, value: true });
  const renamed = (await f.read()).items.find((x) => x.id === itemId); assert.equal(renamed.name, '原始口播'); assert.equal(renamed.folderId, folder.folderId); assert.equal(renamed.favorite, true);
  await f.action({ action: 'resource.remove', itemId }); assert.equal((await f.read()).items.some((x) => x.id === itemId), false); assert.equal(f.hash(), hash); assert.ok(await fs.stat(path.join(f.dir, 'assets/main.mp4')));
  await assert.rejects(resolveCreationLibraryFile({ ...f, itemId, asset: '../film.html' }), { code: 'PATH_ESCAPE' });
  await fs.symlink(path.join(f.dir, 'film.html'), path.join(f.dir, 'assets', 'escape.html'));
  await assert.rejects(resolveCreationLibraryFile({ ...f, itemId: 'project:assets/escape.html', asset: 'assets/escape.html' }), { code: 'PATH_ESCAPE' });
  await assert.rejects(resolveCreationLibraryFile({ ...f, itemId: 'project:assets/main.mp4', asset: 'film.html' }), { code: 'PATH_ESCAPE' });
  await fs.writeFile(path.join(f.dir, 'private-config.json'), '{"private":true}');
  await assert.rejects(resolveCreationLibraryFile({ ...f, itemId: 'project:private-config.json', asset: 'private-config.json' }), { code: 'PATH_ESCAPE' });
  await writeSceneBundle(f.libraryRoot, 'test-bundle', { 'scene.html': '<main>one</main>' });
  await assert.rejects(writeSceneBundle(f.libraryRoot, 'test-bundle', { 'scene.html': '<main>two</main>' }), { code: 'INSTANCE_EXISTS' });
});
test('page/skill imports follow UI params; skill use yields a prompt only, unsupported external services remain explicit', async (t) => {
  const f = await fixture(t);
  const imported = await f.action({ action: 'resource.import-page', params: { fileName: '我的网页.html', content: '<html><body><main>用户源码</main><script>window.film={frame(){}}</script></body></html>' } }); assert.equal(imported.ok, true, JSON.stringify(imported));
  assert.equal((await f.read()).items.find((x) => x.id === imported.itemId).name, '我的网页');
  const skill = await f.action({ action: 'skill.import', params: { fileName: 'mine.md', content: '---\nname: 我的剪辑技能\ndescription: 保留原声\n---\n先检查工程再剪辑' } }); assert.equal(skill.ok, true, JSON.stringify(skill));
  const prompt = await f.action({ action: 'skill.use', itemId: skill.itemId }); assert.equal(prompt.ok, true, JSON.stringify(prompt)); assert.match(prompt.agentPrompt, /先检查工程再剪辑/);
  await f.action({ action: 'skill.toggle', itemId: skill.itemId, value: false }); assert.equal((await f.action({ action: 'skill.use', itemId: skill.itemId })).code, 'SKILL_DISABLED');
  assert.equal((await f.action({ action: 'media.voice', text: '你好' })).code, 'CAPABILITY_UNAVAILABLE');
  assert.equal((await f.action({ action: 'captions.recognize', expectedHash: f.hash(), opId: 'no-caption' })).code, 'CAPABILITY_UNAVAILABLE');
});
test('transitions use shared operations, preview runtime, preserve remove path and undo the full batch', async (t) => {
  const f = await fixture(t), before = f.hash();
  const applied = await f.action({ action: 'resource.apply', itemId: 'transition/dissolve', target: { from: 'first', to: 'next', durationSec: 0.5 }, expectedHash: before, opId: 'transition' }); assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.ok((await f.read()).cuts.some((x) => x.from === 'first' && x.to === 'next'));
  const preview = await resolveCreationLibraryFile({ ...f, itemId: 'transition/dissolve', asset: 'scene.html' }); assert.match(await fs.readFile(preview.path, 'utf8'), /createTransitionRuntime|transitionFrame/);
  const removed = await f.action({ action: 'transition.remove', target: { to: 'next' }, expectedHash: f.hash(), opId: 'remove-transition' }); assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(f.doc().tracks[0].clips.find((x) => x.id === 'next').at, 4);
  const current = await fs.readFile(path.join(f.dir, 'film.html'), 'utf8'); assert.equal(sha256(current), f.hash());
});
test('unreferenced media uses probed duration and includes video sound; track roles reject mismatched drops', async (t) => {
  const f = await fixture(t);
  const services = { ...f.services, describeMedia: async () => ({ format: { durationSec: 12 }, audio: { durationSec: 12 } }) };
  await fs.writeFile(path.join(f.dir, 'assets', 'unused.mp4'), 'probed-source');
  const snap = await readCreationLibrary({ ...f, services });
  const item = snap.items.find((x) => x.id === 'project:assets/unused.mp4'); assert.equal(item.durationSec, 12); assert.equal(item.refs, 0); assert.ok(snap.audio.some((x) => x.id === item.id));
  assert.equal((await applyCreationLibraryAction({ ...f, services, request: { action: 'resource.apply', itemId: item.id, opId: 'past-source', expectedHash: f.hash(), target: { mode: 'overlay', at: 0, durationSec: 13 } } })).code, 'DURATION_PAST_SOURCE');
  const applied = await applyCreationLibraryAction({ ...f, services, request: { action: 'resource.apply', itemId: item.id, opId: 'unused-video', expectedHash: f.hash(), target: { mode: 'overlay', at: 0 } } }); assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.deepEqual(f.doc().tracks.flatMap((x) => x.clips).find((x) => x.id === applied.clipId).time, [0, 12]);
  const wav = Buffer.alloc(44 + 16000); wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(16000, 40);
  await fs.writeFile(path.join(f.dir, 'assets', 'test.wav'), wav);
  const deniedSound = await f.action({ action: 'resource.apply', itemId: 'project:assets/test.wav', opId: 'bad-audio', expectedHash: f.hash(), target: { mode: 'reject-overlap', track: 0, at: 20 } }); assert.equal(deniedSound.code, 'TRACK_KIND_MISMATCH');
  const audio = await f.action({ action: 'resource.apply', itemId: 'project:assets/test.wav', opId: 'good-audio', expectedHash: f.hash(), target: { mode: 'new-track', at: 0 } }); assert.equal(audio.ok, true, JSON.stringify(audio)); assert.equal(f.doc().tracks[0].role, 'audio');
  const deniedVideo = await applyCreationLibraryAction({ ...f, services, request: { action: 'resource.apply', itemId: item.id, opId: 'bad-video', expectedHash: f.hash(), target: { mode: 'reject-overlap', track: 0, at: 20 } } }); assert.equal(deniedVideo.code, 'TRACK_KIND_MISMATCH');
});
test('media imports share durable opId receipts and caption reads remain live without write-receipt pollution', async (t) => {
  const f = await fixture(t); let imports = 0, reads = 0;
  const services = { ...f.services,
    importMedia: async (request) => { imports++; return { ok: true, itemId: `project:assets/${request.params.fileName}`, bytes: Buffer.from(request.params.data, 'base64').length }; },
    caption: async () => ({ ok: true, captions: { hash: `hash-${++reads}`, cues: [] } }),
    captionSnapshot: async () => ({ captions: { cues: [] }, audio: { sources: [{ clipId: 'first', src: 'assets/main.mp4' }] } }),
  };
  const request = { action: 'resource.import-media', opId: 'import-data', expectedHash: f.hash(), params: { fileName: 'clip.mp4', data: Buffer.from('same-bytes').toString('base64') } };
  const apply = (request) => applyCreationLibraryAction({ ...f, services, request });
  assert.equal((await apply(request)).ok, true); assert.equal((await apply(request)).replayed, true); assert.equal(imports, 1);
  assert.equal((await apply({ ...request, params: { ...request.params, data: Buffer.from('other-bytes').toString('base64') } })).code, 'OP_ID_REUSED'); assert.equal(imports, 1);
  const readRequest = { action: 'caption.read', opId: 'stable-read', expectedHash: f.hash() };
  assert.equal((await apply(readRequest)).captions.hash, 'hash-1'); assert.equal((await apply(readRequest)).captions.hash, 'hash-2');
  const state = await readState(f.libraryRoot); assert.equal(Object.keys(state.receipts).some((x) => x.endsWith(':stable-read')), false);
  const snap = await readCreationLibrary({ ...f, services }); assert.ok(Array.isArray(snap.audio)); assert.equal(snap.captionSources.sources[0].clipId, 'first');
});
test('middle ripple insertion uses formal split + ripple + insert as one undoable batch', async (t) => {
  const f = await fixture(t), beforeText = await fs.readFile(path.join(f.dir, 'film.html'), 'utf8'), beforeHash = f.hash();
  const request = { action: 'resource.apply', itemId: 'builtin:text-basic', expectedHash: beforeHash, opId: 'middle-ripple', target: { mode: 'ripple', track: 0, at: 2, durationSec: 2 } };
  const inserted = await f.action(request); assert.equal(inserted.ok, true, JSON.stringify(inserted));
  const clips = f.doc().tracks[0].clips;
  const left = clips.find((c) => c.id === 'first'), right = clips.find((c) => c.id.startsWith('creation-split-'));
  assert.deepEqual(left.time, [2, 4]); assert.deepEqual(right.time, [4, 6]); assert.equal(right.src, left.src); assert.equal(right.at, 4);
  assert.equal(clips.find((c) => c.id === inserted.clipId).at, 2); assert.equal(clips.find((c) => c.id === 'next').at, 6); assert.equal(f.registry.docOf(f.project.projectId).undoDepth, 1);
  assert.equal((await f.action(request)).replayed, true); assert.equal(f.doc().tracks[0].clips.filter((c) => c.id.startsWith('creation-split-')).length, 1);
  const after = f.hash(); assert.equal((await f.action({ ...request, opId: 'stale-middle' })).code, 'CONFLICT'); assert.equal(f.hash(), after);
  const undone = await f.registry.undo(f.project.projectId, { expectedHash: after, opId: 'undo-middle' }); assert.equal(undone.ok, true, JSON.stringify(undone));
  assert.equal(await fs.readFile(path.join(f.dir, 'film.html'), 'utf8'), beforeText, 'one undo must restore original bytes, source trims and downstream positions'); assert.equal(f.hash(), beforeHash);
  const again = await f.action({ ...request, opId: 'middle-second' }); assert.equal(again.ok, true, JSON.stringify(again));
  const locked = await fixture(t, true), lockedHash = locked.hash();
  assert.equal((await locked.action({ ...request, expectedHash: lockedHash, opId: 'locked-middle' })).code, 'LOCKED'); assert.equal(locked.hash(), lockedHash);
});
test('ripple preserves page source clocks, refuses detached linked audio and existing transition metadata instead of drifting them', async (t) => {
  const f = await fixture(t);
  const firstPage = await f.action({ action: 'resource.apply', itemId: 'builtin:template-title', expectedHash: f.hash(), opId: 'base-page', target: { mode: 'overlay', at: 0, durationSec: 6 } }); assert.equal(firstPage.ok, true);
  const beforePage = f.hash(); const pageInsert = await f.action({ action: 'resource.apply', itemId: 'builtin:sticker-check', expectedHash: beforePage, opId: 'middle-page', target: { mode: 'ripple', track: 0, at: 2, durationSec: 1 } }); assert.equal(pageInsert.ok, true, JSON.stringify(pageInsert));
  const pages = f.doc().tracks[0].clips, left = pages.find((c) => c.id === firstPage.clipId), right = pages.find((c) => c.id.startsWith('creation-split-'));
  assert.equal(left.src, right.src); assert.deepEqual(left.time, [0, 2]); assert.deepEqual(right.time, [2, 6]); assert.equal(right.at, 3);
  assert.equal((await f.registry.undo(f.project.projectId, { expectedHash: f.hash(), opId: 'undo-page-ripple' })).ok, true); assert.equal(f.hash(), beforePage);
  const linked = await fixture(t);
  const setLink = await linked.registry.applyOps(linked.project.projectId, { expectedHash: linked.hash(), opId: 'original-link', by: 'person' }, [{ op: 'fields', clip: 'first', fields: { link: 'picture-and-detached-audio' } }]); assert.equal(setLink.ok, true);
  const linkedHash = linked.hash();
  const blocked = await linked.action({ action: 'resource.apply', itemId: 'builtin:text-basic', expectedHash: linkedHash, opId: 'do-not-drift-audio', target: { mode: 'ripple', track: 0, at: 2, durationSec: 2 } }); assert.equal(blocked.code, 'RIPPLE_LINKED_CLIPS'); assert.equal(linked.hash(), linkedHash);
  const transition = await fixture(t);
  assert.equal((await transition.action({ action: 'resource.apply', itemId: 'transition/dissolve', expectedHash: transition.hash(), opId: 'existing-transition', target: { from: 'first', to: 'next', durationSec: 0.5 } })).ok, true);
  const transitionHash = transition.hash();
  assert.equal((await transition.action({ action: 'resource.apply', itemId: 'builtin:text-basic', expectedHash: transitionHash, opId: 'do-not-drift-transition', target: { mode: 'ripple', track: 0, at: 1, durationSec: 1 } })).code, 'RIPPLE_TRANSITION_BOUNDARY'); assert.equal(transition.hash(), transitionHash);
});
test('save current text resolves only the frozen clip id and retains edited HTML plus instance overrides', async (t) => {
  const f = await fixture(t);
  const created = await f.action({ action: 'resource.apply', itemId: 'builtin:text-basic', text: '初始文字', expectedHash: f.hash(), opId: 'save-current-create', target: { mode: 'overlay', at: 0 } }); assert.equal(created.ok, true);
  const source = path.join(f.dir, created.src); await fs.writeFile(source, (await fs.readFile(source, 'utf8')).replace('初始文字', '实际源码修改'));
  const overrides = [{ at: '#title', t: '当前人工文字', style: { color: '#ff0000' } }];
  assert.equal((await f.registry.applyOps(f.project.projectId, { expectedHash: f.hash(), opId: 'manual-current-style', by: 'person' }, [{ op: 'fields', clip: created.clipId, fields: { style: 'opacity: 0.7', overrides } }])).ok, true);
  const before = f.hash();
  const request = { action: 'resource.save', name: '我的当前样式', params: { category: 'text' }, target: { clipId: created.clipId }, expectedHash: before, opId: 'save-current-only-id', src: '../untrusted-caller-path.html' };
  const saved = await f.action(request); assert.equal(saved.ok, true, JSON.stringify(saved)); assert.equal(f.hash(), before);
  const record = (await readState(f.libraryRoot)).saved.find((x) => x.id === saved.itemId); assert.equal(record.item.category, 'text'); assert.equal(record.clip.id, created.clipId); assert.deepEqual(record.clip.overrides, overrides);
  const applied = await f.action({ action: 'resource.apply', itemId: saved.itemId, expectedHash: before, opId: 'use-current-style', target: { mode: 'overlay', at: 8 } }); assert.equal(applied.ok, true, JSON.stringify(applied));
  const clip = f.doc().tracks.flatMap((track) => track.clips).find((x) => x.id === applied.clipId); assert.deepEqual(clip.overrides, overrides); assert.match(clip.style, /opacity: 0.7/); assert.match(await fs.readFile(path.join(f.dir, clip.src), 'utf8'), /实际源码修改/);
  assert.equal((await f.action({ ...request, opId: 'stale-save', expectedHash: '0'.repeat(64) })).code, 'CONFLICT');
  assert.equal((await f.action({ ...request, opId: 'video-is-not-text', expectedHash: f.hash(), target: { clipId: 'first' } })).code, 'NOT_TEXT_RESOURCE');
});
test('saved native text stays native and preserves actual text/style/geometry rather than becoming the picked builtin', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.registry.applyOps(f.project.projectId, { expectedHash: f.hash(), opId: 'native-title', by: 'person' }, [{ op: 'insert', clip: { id: 'native-title', kind: 'text', text: '原生文字', src: '', time: [0, 3], style: 'color: #ffcc00; font-size: 44px', box: { x: 80, y: 120, w: 600, h: 80 } }, at: 1, track: { insert: 0 } }])).ok, true);
  const saved = await f.action({ action: 'resource.save', name: '原生样式', params: { category: 'text' }, target: { clipId: 'native-title' }, expectedHash: f.hash(), opId: 'save-native' }); assert.equal(saved.ok, true, JSON.stringify(saved));
  const record = (await readState(f.libraryRoot)).saved.find((x) => x.id === saved.itemId); assert.equal(record.nativeText, true); assert.equal(record.clip.text, '原生文字');
  const use = await f.action({ action: 'resource.apply', itemId: saved.itemId, expectedHash: f.hash(), opId: 'apply-native', target: { mode: 'overlay', at: 6 } }); assert.equal(use.ok, true, JSON.stringify(use));
  const clip = f.doc().tracks.flatMap((track) => track.clips).find((x) => x.id === use.clipId); assert.equal(clip.kind, 'text'); assert.equal(clip.text, '原生文字'); assert.equal(clip.src, ''); assert.match(clip.style, /font-size: 44px/); assert.deepEqual(clip.box, record.clip.box); assert.equal(clip.at, 6);
  const preview = await resolveCreationLibraryFile({ ...f, itemId: saved.itemId, asset: 'scene.html' }); assert.match(await fs.readFile(preview.path, 'utf8'), /原生文字/);
});
