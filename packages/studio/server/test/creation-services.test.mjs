// @ts-nocheck -- Real registry/files/ffprobe and owned HTTP fixtures; no browser or real provider credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { importCreationMedia, streamCreationMedia, creationServiceItems, resolveCreationAudio, startCreationMediaTask } from '../creation-services.mjs';
import { createMediaServices, synthesizeLibraryAudio } from '../media-services.mjs';
import { applyCreationLibraryAction, readCreationLibrary, resolveCreationLibraryFile } from '../creation-library.mjs';
import { createProjectRegistry } from '../projects.mjs';
import { createEventHub } from '../events.mjs';
import { makeProject } from './helpers.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function owned(t) {
  const fixture = await makeProject('creation-services-business');
  const registry = createProjectRegistry({ hub: createEventHub(), watchImpl: () => ({ close() {} }) });
  const opened = await registry.open(fixture.dir);
  assert.equal(opened.ok, true);
  const project = opened.project;
  const libraryRoot = path.join(fixture.root, 'library'); await fs.mkdir(libraryRoot);
  t.after(async () => { await registry.closeAll(); await fixture.cleanup(); });
  return { ...fixture, registry, project, libraryRoot };
}
async function httpTts(t, handler) {
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume only fixture request */ }
    requests += 1;
    if (handler) await handler(req, res); else { res.setHeader('content-type', 'audio/wav'); res.end(synthesizeLibraryAudio('creation-tts', 0.5)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { endpoint: `http://127.0.0.1:${server.address().port}/v1`, count: () => requests };
}
async function taskServices(t, ctx, endpoint) {
  const mediaServices = createMediaServices({ configFile: path.join(ctx.root, 'media-services.json'), run: async () => ({ stdout: '', stderr: '' }) });
  await mediaServices.saveConfig({ tts: { mode: 'http', endpoint, model: 'fixture', voice: 'fixture', keyRef: null } });
  t.after(async () => { mediaServices.close(); await mediaServices.settled(); });
  const services = {};
  services.media = (request, { project }) => startCreationMediaTask({ project, registry: ctx.registry, request, libraryRoot: ctx.libraryRoot, services, mediaServices });
  return { mediaServices, services };
}

test('asset-pool import returns real duration without editing film; identical content never duplicates or overwrites', async (t) => {
  const ctx = await owned(t); const wav = synthesizeLibraryAudio('asset-test', 0.75);
  const hashBefore = ctx.registry.docOf(ctx.project.projectId).hash;
  const first = await importCreationMedia({ project: ctx.project, name: '旁白.wav', data: wav.toString('base64') });
  const again = await importCreationMedia({ project: ctx.project, name: '旁白.wav', data: wav.toString('base64') });
  assert.equal(first.ok, true); assert.ok(first.durationSec > 0.7 && first.durationSec < 0.8);
  assert.equal(first.itemId, again.itemId); assert.equal(first.src, again.src);
  assert.equal(sha(await fs.readFile(path.join(ctx.dir, first.src))), sha(wav));
  assert.equal((await fs.readdir(path.join(ctx.dir, 'assets'))).filter(name => name.endsWith('.wav')).length, 1);
  assert.equal(ctx.registry.docOf(ctx.project.projectId).hash, hashBefore);
});

test('bad file/type/base64 and symlink destinations never replace old media or write outside the project', async (t) => {
  const ctx = await owned(t);
  await assert.rejects(importCreationMedia({ project: ctx.project, name: 'page.html', data: 'aGVsbG8=' }), e => e.code === 'MEDIA_UNSUPPORTED');
  await assert.rejects(importCreationMedia({ project: ctx.project, name: 'clip.wav', data: 'not base64!' }), e => e.code === 'UPLOAD_INVALID');
  await assert.rejects(importCreationMedia({ project: ctx.project, name: 'clip.wav', data: Buffer.from('not audio').toString('base64') }), e => e.code === 'MEDIA_INVALID');
  assert.deepEqual(await fs.readdir(path.join(ctx.dir, 'assets')), []);
  const outside = path.join(ctx.root, 'outside'); await fs.mkdir(outside);
  await fs.rmdir(path.join(ctx.dir, 'assets')); await fs.symlink(outside, path.join(ctx.dir, 'assets'));
  await assert.rejects(importCreationMedia({ project: ctx.project, name: 'clip.wav', data: synthesizeLibraryAudio('escape').toString('base64') }), e => e.code === 'PATH_ESCAPE');
  assert.deepEqual(await fs.readdir(outside), []);
});

test('streamed import verifies all existing bytes before reusing a content-addressed name', async (t) => {
  const ctx = await owned(t), wav = synthesizeLibraryAudio('stream-collision', 0.5);
  const first = await streamCreationMedia({ project: ctx.project, name: 'stream.wav', stream: Readable.from([wav]) });
  const again = await streamCreationMedia({ project: ctx.project, name: 'stream.wav', stream: Readable.from([wav]) });
  assert.equal(again.src, first.src);
  const altered = Buffer.from(wav); altered[altered.length - 1] ^= 0xff;
  await fs.writeFile(path.join(ctx.dir, first.src), altered);
  await assert.rejects(streamCreationMedia({ project: ctx.project, name: 'stream.wav', stream: Readable.from([wav]) }), e => e.code === 'IMPORT_COLLISION');
  assert.equal(sha(await fs.readFile(path.join(ctx.dir, first.src))), sha(altered));
  assert.equal((await fs.readdir(path.join(ctx.dir, 'assets'))).some(n => n.startsWith('.pending-upload')), false);
});

test('original sound/music catalog stays in shared cache; reads never write into project or clobber old assets', async (t) => {
  const ctx = await owned(t);
  const service = { settings: async () => ({ config: { tts: { mode: 'system', voice: '' } }, voices: [{ id: 'fixture', name: '测试声音', language: 'zh_CN' }], capabilities: { voice: { ready: false } } }) };
  const previous = path.join(ctx.dir, 'assets', 'sound', 'opencut-original-tap.wav'); await fs.mkdir(path.dirname(previous), { recursive: true }); await fs.writeFile(previous, 'user-old-media');
  const before = await fs.readdir(ctx.dir, { recursive: true }), hash = ctx.registry.docOf(ctx.project.projectId).hash;
  const first = await creationServiceItems(ctx, service);
  assert.equal(first.filter(item => item.category === 'sound').length, 6);
  assert.equal(first.filter(item => item.category === 'music').length, 3);
  assert.equal(first.find(item => item.category === 'voice').availability, 'needs-provider');
  const audio = first.find(item => item.category === 'sound'); const cached = await resolveCreationAudio({ libraryRoot: ctx.libraryRoot, itemId: audio.id }), file = cached.file;
  const original = await fs.readFile(file); const stat = await fs.stat(file);
  assert.equal(original.toString('ascii', 0, 4), 'RIFF');
  assert.ok(file.startsWith(await fs.realpath(ctx.libraryRoot) + path.sep)); assert.equal(audio.src, undefined);
  await creationServiceItems(ctx, service);
  assert.equal(sha(await fs.readFile(file)), sha(original)); assert.equal((await fs.stat(file)).mtimeMs, stat.mtimeMs);
  assert.deepEqual(await fs.readdir(ctx.dir, { recursive: true }), before); assert.equal(ctx.registry.docOf(ctx.project.projectId).hash, hash);
  assert.equal(await fs.readFile(previous, 'utf8'), 'user-old-media');
  await assert.rejects(resolveCreationAudio({ libraryRoot: ctx.libraryRoot, itemId: 'builtin-audio:../../private' }), { code: 'ITEM_NOT_FOUND' });
  await assert.rejects(resolveCreationLibraryFile({ ...ctx, itemId: audio.id, asset: 'state.json' }), { code: 'PATH_ESCAPE' });
  const preview = await resolveCreationLibraryFile({ ...ctx, itemId: audio.id, asset: 'audio.wav' }); assert.equal(preview.mime, 'audio/wav'); assert.equal(preview.path, file);
});

test('cached original audio materializes only after Apply CAS and placement checks, replays once and undoes original film', async (t) => {
  const ctx = await owned(t), beforeText = await fs.readFile(ctx.filmPath, 'utf8'), before = ctx.registry.docOf(ctx.project.projectId).hash;
  const service = { settings: async () => ({ config: { tts: { mode: 'system', voice: '' } }, voices: [], capabilities: { voice: { ready: false } } }) };
  const services = { skillsRoot: path.join(ctx.root, 'unused-skills'), items: input => creationServiceItems(input, service) };
  const assetNames = () => fs.readdir(path.join(ctx.dir, 'assets')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const snap = await readCreationLibrary({ ...ctx, services }), item = snap.items.find(x => x.id === 'builtin-audio:sound-tap');
  assert.equal(item.availability, 'ready'); assert.deepEqual(await assetNames(), []);
  const request = { action: 'resource.apply', itemId: item.id, expectedHash: before, opId: 'audio-original-once', target: { at: 3, mode: 'new-track' } };
  const act = request => applyCreationLibraryAction({ ...ctx, services, request });
  assert.equal((await act({ ...request, expectedHash: '0'.repeat(64) })).code, 'CONFLICT');
  assert.equal((await act({ ...request, target: { at: -1, mode: 'new-track' } })).code, 'INVALID_TIME');
  assert.deepEqual(await assetNames(), []);
  const result = await act(request); assert.equal(result.ok, true, JSON.stringify(result));
  const clip = ctx.registry.docOf(ctx.project.projectId).doc.tracks.flatMap(x => x.clips).find(x => x.id === result.clipId);
  assert.equal(clip.kind, 'sound'); assert.equal(clip.at, 3); assert.deepEqual(clip.time, [0, 0.5]); assert.match(clip.src, /^assets\/creation-library\/[a-f0-9]+\/audio\.wav$/);
  const copied = await fs.readFile(path.join(ctx.dir, clip.src)), cached = await resolveCreationAudio({ libraryRoot: ctx.libraryRoot, itemId: item.id });
  assert.equal(sha(copied), sha(await fs.readFile(cached.file)));
  const fileStat = await fs.stat(path.join(ctx.dir, clip.src)); const replay = await act(request); assert.equal(replay.replayed, true); assert.equal((await fs.stat(path.join(ctx.dir, clip.src))).mtimeMs, fileStat.mtimeMs);
  assert.equal(ctx.registry.docOf(ctx.project.projectId).doc.tracks.flatMap(x => x.clips).filter(x => x.id === clip.id).length, 1);
  assert.equal((await ctx.registry.undo(ctx.project.projectId, { expectedHash: result.hash, opId: 'undo-original-audio' })).ok, true);
  assert.equal(await fs.readFile(ctx.filmPath, 'utf8'), beforeText); assert.equal(ctx.registry.docOf(ctx.project.projectId).hash, before);
  assert.equal(sha(await fs.readFile(path.join(ctx.dir, clip.src))), sha(copied), 'undo retains source for history/recovery');
});

test('HTTP voice catalog uses the configured remote voice instead of installing a system voice into its request', async (t) => {
  const ctx = await owned(t);
  const service = { settings: async () => ({ config: { tts: { mode: 'http', voice: 'remote-fixture-voice' } }, voices: [{ id: 'LocalFixtureVoice', name: '本机声音', language: 'zh_CN' }], capabilities: { voice: { ready: true } } }) };
  const voices = (await creationServiceItems(ctx, service)).filter(item => item.category === 'voice');
  assert.ok(voices.length > 0);
  assert.ok(!voices.some(item => item.id === 'voice:LocalFixtureVoice'), 'system voice IDs must not override a remote provider selection');
  assert.ok(voices.some(item => item.params?.voice === 'remote-fixture-voice'));
});

test('TTS task inserts exactly one playable sound clip through registry and the public action replay stays stable', async (t) => {
  const ctx = await owned(t); const http = await httpTts(t); const { mediaServices, services } = await taskServices(t, ctx, http.endpoint);
  const before = ctx.registry.docOf(ctx.project.projectId); const countBefore = before.doc.tracks.flatMap(track => track.clips).length;
  const request = { action: 'media.tts', opId: 'public-tts-single-insert', expectedHash: before.hash, text: '一句测试', target: { at: 9 } };
  const result = await applyCreationLibraryAction({ ...ctx, request, services }); assert.equal(result.ok, true, result.message);
  await mediaServices.settled();
  const job = mediaServices.list(ctx.project.projectId).find(item => item.id === result.job.id);
  assert.equal(job.state, 'completed', job.error);
  const after = ctx.registry.docOf(ctx.project.projectId); const clips = after.doc.tracks.flatMap(track => track.clips);
  assert.equal(clips.length, countBefore + 1);
  const added = clips.find(clip => clip.id === job.result.clipId); assert.equal(added.kind, 'sound'); assert.equal(added.at, 9);
  assert.ok(added.time[1] > 0); assert.ok((await fs.stat(path.join(ctx.dir, added.src.split('#')[0]))).size > 44);
  const replay = await applyCreationLibraryAction({ ...ctx, request, services }); assert.equal(replay.ok, true); assert.equal(replay.replayed, true); assert.equal(replay.job.id, result.job.id);
  await mediaServices.settled();
  assert.equal(http.count(), 1); assert.equal(ctx.registry.docOf(ctx.project.projectId).hash, after.hash);
  const undo = await ctx.registry.undo(ctx.project.projectId, { expectedHash: after.hash });
  assert.equal(undo.ok, true); assert.equal(ctx.registry.docOf(ctx.project.projectId).doc.tracks.flatMap(track => track.clips).length, countBefore);
});

test('direct TTS service wrapper replays a completed task even after its first insertion changed the film hash', async (t) => {
  const ctx = await owned(t); const http = await httpTts(t); const { mediaServices, services } = await taskServices(t, ctx, http.endpoint);
  const before = ctx.registry.docOf(ctx.project.projectId);
  const request = { action: 'media.tts', opId: 'direct-tts-replay', expectedHash: before.hash, text: '一句测试', target: { at: 9 } };
  const first = await startCreationMediaTask({ ...ctx, request, services, mediaServices });
  await mediaServices.settled(); assert.equal(mediaServices.list(ctx.project.projectId)[0].state, 'completed');
  const replay = await startCreationMediaTask({ ...ctx, request, services, mediaServices });
  assert.equal(replay.ok, true); assert.equal(replay.replay, true); assert.equal(replay.job.id, first.job.id); assert.equal(http.count(), 1);
});

test('late TTS completion cannot overwrite an intervening human film edit or invent a saved result', async (t) => {
  const ctx = await owned(t); let arrived; const reached = new Promise(resolve => { arrived = resolve; }); let release;
  const http = await httpTts(t, async (_req, res) => { arrived(); await new Promise(resolve => { release = resolve; }); res.end(synthesizeLibraryAudio('late', 0.3)); });
  const { mediaServices, services } = await taskServices(t, ctx, http.endpoint);
  const before = ctx.registry.docOf(ctx.project.projectId);
  const request = { action: 'media.tts', opId: 'late-conflict', expectedHash: before.hash, text: '一句测试', target: { at: 9 } };
  await startCreationMediaTask({ ...ctx, request, services, mediaServices }); await reached;
  const change = await ctx.registry.applyOps(ctx.project.projectId, { expectedHash: before.hash, opId: 'human-change', by: 'person' }, [{ op: 'stage', w: 1282, h: 720 }]);
  assert.equal(change.ok, true); const humanHash = ctx.registry.docOf(ctx.project.projectId).hash; release(); await mediaServices.settled();
  const job = mediaServices.list(ctx.project.projectId)[0]; assert.equal(job.state, 'failed'); assert.equal(job.code, 'CONFLICT');
  assert.equal(ctx.registry.docOf(ctx.project.projectId).hash, humanHash);
  assert.ok(!job.error.includes('从素材库加入'), 'no asset was imported before the hash conflict');
});
