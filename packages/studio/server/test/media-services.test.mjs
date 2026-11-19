// @ts-nocheck -- Owned integration fixtures exercise process/HTTP boundaries without real provider credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createMediaServices, normalizeMediaConfig, runMediaProcess, synthesizeLibraryAudio } from '../media-services.mjs';
import { probeMedia } from '../../../render/verify.mjs';

const voicesRun = async () => ({ stdout: 'FixtureVoice zh_CN # fixture only\n', stderr: '' });
async function fixture(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const record = { path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
    requests.push(record);
    try { await handler(record, res); } catch { res.writeHead(500); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return { endpoint: `http://127.0.0.1:${server.address().port}/v1`, requests };
}
async function owned(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-media-services-test-'));
  const project = { projectId: 'owned-project', dir: path.join(dir, 'project') };
  await fs.mkdir(project.dir);
  const configFile = path.join(dir, 'config', 'media-services.json');
  const service = createMediaServices({ configFile, run: voicesRun, ...options });
  t.after(async () => { service.close(); await service.settled(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, project, configFile, service };
}
function speech(opId = 'speech-1', patch = {}) { return { action: 'media.tts', opId, text: '这是一次测试。', ...patch }; }
async function saveHttp(service, endpoint, patch = {}) {
  return service.saveConfig({ tts: { mode: 'http', endpoint, model: 'fixture-tts', voice: 'fixture', keyRef: null, ...patch } });
}

test('media settings reject secret values, unknown fields and remote unsafe endpoints', () => {
  for (const row of [{ apiKey: 'fixture-secret' }, { tts: { apiKey: 'fixture-secret' } }, { tts: { keyRef: 'raw-secret' } }, { tts: { endpoint: 'https://user:pass@example.test/v1' } }, { tts: { endpoint: 'https://example.test/v1?token=secret' } }, { tts: { endpoint: 'http://example.test/v1' } }]) {
    assert.throws(() => normalizeMediaConfig(row), (e) => e.code === 'CONFIG_INVALID' && !e.message.includes('fixture-secret'));
  }
});

test('malformed endpoint reports the configuration error contract', () => {
  assert.throws(() => normalizeMediaConfig({ tts: { endpoint: 'not-an-endpoint' } }), (e) => e.code === 'CONFIG_INVALID');
});

test('non-secret configuration saves atomically, uses private mode and returns actual capability metadata', async (t) => {
  const { service, configFile } = await owned(t);
  const out = await service.saveConfig({ tts: { mode: 'http', endpoint: 'http://localhost:5555/v1/', model: 'fixture', voice: 'fixture-voice', keyRef: 'model' } });
  assert.equal(out.config.tts.endpoint, 'http://localhost:5555/v1');
  assert.equal(out.config.tts.keyRef, 'model');
  const file = await fs.readFile(configFile, 'utf8');
  assert.ok(!file.includes('Bearer'));
  assert.deepEqual(JSON.parse(file), await service.readConfig());
  assert.equal((await fs.stat(configFile)).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(path.dirname(configFile))).filter((name) => name.endsWith('.tmp')), []);
  assert.equal(out.capabilities.subtitle.ready, false);
  assert.equal(out.capabilities.translate.ready, false);
});

test('HTTP TTS fixture yields a real probed WAV; stable replay never calls the provider twice', async (t) => {
  const wav = synthesizeLibraryAudio('test-valid-wave', 0.6);
  const http = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(wav); });
  const { service, project, dir } = await owned(t, { resolveKey: async () => 'fixture-key-only' });
  await saveHttp(service, http.endpoint, { keyRef: 'model' });
  let completed = 0; let staged;
  const complete = async (result) => { staged = result.file; completed += 1; await fs.copyFile(result.file, path.join(dir, 'verified.wav')); return { ok: true, hash: 'new-hash' }; };
  const request = speech('tts-fixture');
  const started = await service.start({ project, request, complete });
  assert.equal(started.ok, true);
  await service.settled();
  assert.equal(service.list(project.projectId)[0].state, 'completed');
  const probe = await probeMedia(path.join(dir, 'verified.wav'));
  assert.ok(probe.audio && probe.format.durationSec > 0);
  assert.equal(probe.audio.codec, 'pcm_s16le');
  assert.equal(probe.audio.channels, 1);
  assert.ok(await fs.stat(staged).then(() => false).catch(() => true), 'owned staged output cleaned after callback copied it');
  const replay = await service.start({ project, request, complete });
  assert.equal(replay.replay, true); assert.equal(replay.job.id, started.job.id);
  assert.equal(completed, 1); assert.equal(http.requests.length, 1);
  assert.equal(http.requests[0].headers.authorization, 'Bearer fixture-key-only');
  assert.equal(JSON.parse(http.requests[0].body).input, request.text);
  assert.ok(!(await fs.readFile(path.join(dir, 'config', 'media-services.json'), 'utf8')).includes('fixture-key-only'));
  const changed = await service.start({ project, request: { ...request, text: '变更文本' }, complete });
  assert.equal(changed.code, 'OP_ID_REUSED');
});

test('completed receipt is still replayable after service configuration becomes unavailable', async (t) => {
  const http = await fixture(t, (_req, res) => res.end(synthesizeLibraryAudio('receipt', 0.3)));
  const { service, project } = await owned(t);
  await saveHttp(service, http.endpoint);
  const request = speech('receipt-config-change');
  const first = await service.start({ project, request, complete: async () => ({ ok: true }) });
  await service.settled();
  await service.saveConfig({ tts: { mode: 'http', endpoint: '', model: '', voice: '', keyRef: null } });
  const replay = await service.start({ project, request, complete: async () => { throw new Error('must not rerun'); } });
  assert.equal(replay.ok, true); assert.equal(replay.replay, true); assert.equal(replay.job.id, first.job.id);
  assert.equal(http.requests.length, 1);
});

test('provider failure keeps the old project, survives restart and does not execute completion', async (t) => {
  const http = await fixture(t, (_req, res) => { res.writeHead(503); res.end('fixture failure'); });
  const { service, project, configFile } = await owned(t); await saveHttp(service, http.endpoint);
  let completed = 0;
  const out = await service.start({ project, request: speech('failed-provider'), complete: async () => { completed += 1; } });
  await service.settled();
  const job = service.list(project.projectId).find((one) => one.id === out.job.id);
  assert.equal(job.state, 'failed'); assert.equal(job.code, 'PROVIDER_FAILED'); assert.equal(completed, 0);
  assert.deepEqual(await fs.readdir(path.join(project.dir, '.film', 'media-jobs')), []);
  const restored = createMediaServices({ configFile, run: voicesRun });
  assert.equal((await restored.listForProject(project))[0].state, 'failed');
  const replay = await restored.start({ project, request: speech('failed-provider'), complete: async () => assert.fail('failed receipt must not retry') });
  assert.equal(replay.replay, true); assert.equal(replay.job.code, 'PROVIDER_FAILED'); assert.equal(http.requests.length, 1);
});

test('HTTP body labelled as audio must actually decode before completion is permitted', async (t) => {
  const http = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end('<html>not audio</html>'); });
  const { service, project } = await owned(t); await saveHttp(service, http.endpoint);
  let completed = 0;
  const out = await service.start({ project, request: speech('not-audio'), complete: async () => { completed += 1; return { ok: true }; } });
  await service.settled();
  assert.equal(service.list(project.projectId).find((one) => one.id === out.job.id).state, 'failed');
  assert.equal(completed, 0);
});

test('running and queued cancellation are project scoped and never insert media', async (t) => {
  let started; const gate = new Promise((resolve) => { started = resolve; });
  const run = async (_binary, args, { signal } = {}) => {
    if (args.includes('?')) return voicesRun();
    started();
    return new Promise((_resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  };
  const { service, project, configFile } = await owned(t, { run });
  await service.saveConfig({ tts: { mode: 'system' } });
  let completed = 0; const complete = async () => { completed += 1; return { ok: true }; };
  const first = await service.start({ project, request: speech('cancel-running'), complete });
  const second = await service.start({ project, request: speech('cancel-queued'), complete });
  await gate;
  assert.equal(service.cancel('other-project', first.job.id).code, 'JOB_NOT_FOUND');
  assert.equal(service.cancel(project.projectId, second.job.id).job.state, 'cancelled');
  assert.equal(service.cancel(project.projectId, first.job.id).job.state, 'cancelled');
  await service.settled();
  assert.deepEqual(service.list(project.projectId).map((one) => one.state), ['cancelled', 'cancelled']);
  assert.equal(completed, 0);
  assert.deepEqual(await fs.readdir(path.join(project.dir, '.film', 'media-jobs')), []);
  const restarted = createMediaServices({ configFile, run: voicesRun });
  assert.deepEqual((await restarted.listForProject(project)).map(one => one.state), ['cancelled', 'cancelled']);
  const replay = await restarted.start({ project, request: speech('cancel-running'), complete: async () => assert.fail('cancelled job cannot be restarted by replay') });
  assert.equal(replay.replay, true); assert.equal(replay.job.state, 'cancelled');
});

test('translation fixture preserves cue times and rejects a malformed response atomically', async (t) => {
  let malformed = false;
  const http = await fixture(t, (_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: malformed ? '["one"]' : '["第一句","第二句"]' } }] })); });
  const { service, project } = await owned(t);
  await service.saveConfig({ translate: { mode: 'http', endpoint: http.endpoint, model: 'fixture-translate' } });
  const cues = [{ start: 1, end: 2, text: 'first' }, { start: 3, end: 4, text: 'second' }];
  let applied;
  await service.start({ project, request: { action: 'caption.translate', opId: 'translation-good', params: { cues, language: 'zh' } }, complete: async (result) => { applied = result; return { ok: true }; } });
  await service.settled();
  assert.deepEqual(applied.cues, [{ start: 1, end: 2, text: '第一句' }, { start: 3, end: 4, text: '第二句' }]);
  malformed = true; let called = false;
  await service.start({ project, request: { action: 'caption.translate', opId: 'translation-bad', params: { cues, language: 'zh' } }, complete: async () => { called = true; return { ok: true }; } });
  await service.settled();
  assert.equal(service.list(project.projectId).at(-1).code, 'TRANSLATION_INVALID');
  assert.equal(called, false);
});

test('ASR rejects symlink escape before invoking a decoder or provider', async (t) => {
  const { service, project, dir } = await owned(t, { run: async (_binary, args) => { if (args.includes('?')) return voicesRun(); throw new Error('decoder must not run'); } });
  await fs.writeFile(path.join(dir, 'outside.wav'), synthesizeLibraryAudio('outside', 0.2));
  await fs.mkdir(path.join(project.dir, 'assets')); await fs.symlink(path.join(dir, 'outside.wav'), path.join(project.dir, 'assets', 'escape.wav'));
  await service.saveConfig({ asr: { mode: 'http', endpoint: 'http://127.0.0.1:9/v1', model: 'fixture' } });
  await service.start({ project, request: { action: 'caption.recognize', opId: 'asr-escape', src: 'assets/escape.wav' }, complete: async () => assert.fail('must not apply') });
  await service.settled();
  assert.equal(service.list(project.projectId)[0].code, 'SOURCE_INVALID');
});

test('system say produces one real owned Chinese WAV with valid duration', { skip: process.platform !== 'darwin' }, async (t) => {
  const { service, project, dir } = await owned(t, { run: runMediaProcess, ffmpeg: '/opt/homebrew/bin/ffmpeg' });
  const state = await service.settings();
  const voice = state.voices.find((one) => one.language.startsWith('zh'));
  await service.saveConfig({ tts: { mode: 'system', voice: voice?.id ?? '' } });
  const output = path.join(dir, 'real-chinese.wav');
  const started = await service.start({ project, request: speech('system-say-real', { text: '你好，剪辑测试。' }), complete: async (result) => { await fs.copyFile(result.file, output); return { ok: true }; } });
  await service.settled();
  assert.equal(service.list(project.projectId).find((job) => job.id === started.job.id).state, 'completed');
  const probe = await probeMedia(output);
  assert.equal(probe.audio.codec, 'pcm_s16le'); assert.equal(probe.audio.sampleRate, 48000); assert.equal(probe.audio.channels, 1);
  assert.ok(probe.format.durationSec > 0.1); assert.ok((await fs.stat(output)).size > 44);
});

test('completed receipts survive restart without persisting prompts, credentials or arbitrary adapter results', async (t) => {
  const http = await fixture(t, (_req, res) => res.end(synthesizeLibraryAudio('restart-valid', 0.2)));
  const { service, project, configFile } = await owned(t);
  await saveHttp(service, http.endpoint);
  const request = speech('restart-complete', { text: 'PRIVATE_PROMPT_MUST_NOT_BE_PERSISTED' });
  const first = await service.start({ project, request, complete: async () => ({ ok: true, hash: 'a'.repeat(64), clipId: 'created-1', src: 'assets/created.wav', mapping: { clipId: 'created-1', at: 3, sourceIn: 4, sourceOut: 8, speed: 2, secret: 'PRIVATE_RESULT_SECRET' }, secret: 'PRIVATE_RESULT_SECRET' }) });
  await service.settled(); service.close();
  const store = path.join(project.dir, '.film', 'creation-media-jobs.json');
  const text = await fs.readFile(store, 'utf8');
  assert.ok(!text.includes(request.text)); assert.ok(!text.includes('PRIVATE_RESULT_SECRET')); assert.ok(!text.includes('Authorization'));
  assert.equal((await fs.stat(store)).mode & 0o777, 0o600);
  let calls = 0; const restarted = createMediaServices({ configFile, fetch: async () => { calls += 1; throw new Error('must not call a provider on replay'); }, run: voicesRun });
  t.after(async () => { restarted.close(); await restarted.settled(); });
  const restored = await restarted.listForProject(project);
  assert.equal(restored[0].state, 'completed'); assert.equal(restored[0].result.clipId, 'created-1');
  assert.deepEqual(restored[0].result.mapping, { clipId: 'created-1', at: 3, sourceIn: 4, sourceOut: 8, speed: 2 });
  const replay = await restarted.start({ project, request, validate: async () => assert.fail('validate only applies to a new task'), complete: async () => assert.fail('must not run') });
  assert.equal(replay.replay, true); assert.equal(replay.job.id, first.job.id); assert.equal(calls, 0); assert.equal(http.requests.length, 1);
  const reused = await restarted.start({ project, request: { ...request, text: 'different request' }, complete: async () => ({ ok: true }) });
  assert.equal(reused.code, 'OP_ID_REUSED');
});

test('a prior-process queued/running receipt recovers to interrupted failure and never restarts a paid task', async (t) => {
  const { project, configFile } = await owned(t);
  const stable = x => Array.isArray(x) ? x.map(stable) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, stable(x[k])])) : x;
  const requests = ['interrupted-running', 'interrupted-queued'].map(opId => speech(opId));
  await fs.mkdir(path.join(project.dir, '.film'), { recursive: true });
  const store = path.join(project.dir, '.film', 'creation-media-jobs.json');
  await fs.writeFile(store, JSON.stringify({ version: 1, projectId: project.projectId, entries: requests.map((request, index) => ({ opId: request.opId, fingerprint: createHash('sha256').update(JSON.stringify(stable({ project: project.projectId, request }))).digest('hex'), job: { id: `previous-job-${index}`, projectId: project.projectId, kind: 'tts', state: index ? 'queued' : 'running', progress: 0.1 } })) }));
  let calls = 0; const restarted = createMediaServices({ configFile, fetch: async () => { calls++; throw new Error('must not run'); }, run: voicesRun });
  t.after(async () => { restarted.close(); await restarted.settled(); });
  const restored = await restarted.listForProject(project);
  assert.deepEqual(restored.map(job => job.state), ['failed', 'failed']);
  assert.ok(restored.every(job => job.code === 'JOB_INTERRUPTED'));
  for (const request of requests) { const replay = await restarted.start({ project, request, complete: async () => assert.fail('must not apply') }); assert.equal(replay.replay, true); assert.equal(replay.job.code, 'JOB_INTERRUPTED'); }
  assert.equal(calls, 0);
  assert.ok(JSON.parse(await fs.readFile(store, 'utf8')).entries.every(entry => entry.job.state === 'failed'));
});

test('a real copied project reads without adopting foreign receipts; its first explicit task preserves all original bytes before a new identity', async (t) => {
  const http = await fixture(t, (_req, res) => res.end(synthesizeLibraryAudio('clone-explicit', 0.2)));
  const { service, project, dir } = await owned(t); await saveHttp(service, http.endpoint);
  const request = speech('same-op-in-copied-project');
  const source = await service.start({ project, request, complete: async () => ({ ok: true, clipId: 'original-clip' }) }); await service.settled();
  const sourceStore = path.join(project.dir, '.film', 'creation-media-jobs.json');
  const sourceBytes = await fs.readFile(sourceStore);
  const copied = { projectId: 'copied-project', dir: path.join(dir, 'copied-project') }; await fs.cp(project.dir, copied.dir, { recursive: true });
  const store = path.join(copied.dir, '.film', 'creation-media-jobs.json'), before = await fs.stat(store), beforeFiles = await fs.readdir(path.dirname(store), { recursive: true });
  assert.deepEqual(await service.listForProject(copied), []); assert.deepEqual(service.list(copied.projectId), []);
  assert.equal(service.cancel(copied.projectId, source.job.id).code, 'JOB_NOT_FOUND');
  assert.deepEqual(await fs.readFile(store), sourceBytes); assert.equal((await fs.stat(store)).mtimeMs, before.mtimeMs); assert.deepEqual(await fs.readdir(path.dirname(store), { recursive: true }), beforeFiles);
  assert.equal(http.requests.length, 1, 'reading/cancelling the copy never resends the old paid task');
  const denied = await service.start({ project: copied, request, validate: async () => ({ ok: false, code: 'CONFLICT' }), complete: async () => assert.fail('invalid request must not run') });
  assert.equal(denied.code, 'CONFLICT'); assert.deepEqual(await fs.readFile(store), sourceBytes); assert.deepEqual(await fs.readdir(path.dirname(store), { recursive: true }), beforeFiles);
  let completions = 0;
  const first = await service.start({ project: copied, request, complete: async () => { completions++; return { ok: true, clipId: 'copied-new-clip' }; } });
  assert.equal(first.ok, true); assert.equal(first.replay, undefined); assert.notEqual(first.job.id, source.job.id); await service.settled();
  const digest = createHash('sha256').update(sourceBytes).digest('hex');
  const archive = path.join(path.dirname(store), 'creation-media-jobs.archive', `${digest}.json`);
  assert.deepEqual(await fs.readFile(archive), sourceBytes); assert.equal((await fs.stat(archive)).mode & 0o777, 0o600); assert.equal((await fs.stat(archive)).nlink, 1);
  assert.deepEqual(await fs.readFile(sourceStore), sourceBytes, 'original project evidence remains untouched');
  const current = JSON.parse(await fs.readFile(store, 'utf8'));
  assert.equal(current.projectId, copied.projectId); assert.equal(current.entries.length, 1); assert.equal(current.entries[0].job.projectId, copied.projectId); assert.equal(current.entries[0].job.result.clipId, 'copied-new-clip');
  const replay = await service.start({ project: copied, request, complete: async () => assert.fail('new receipt must replay instead of running again') });
  assert.equal(replay.replay, true); assert.equal(replay.job.id, first.job.id); assert.equal(completions, 1); assert.equal(http.requests.length, 2, 'only the explicitly requested new task used the provider');
  assert.equal(service.cancel(copied.projectId, source.job.id).code, 'JOB_NOT_FOUND');
  assert.deepEqual((await fs.readdir(path.dirname(archive))).filter(name => name.endsWith('.tmp')), []);
});

test('a copied running receipt never becomes a live task in the new project or gains cancellation authority over the source', async (t) => {
  let reached, release; const entered = new Promise(resolve => { reached = resolve; });
  const http = await fixture(t, async (_req, res) => { reached(); await new Promise(resolve => { release = resolve; }); res.end(synthesizeLibraryAudio('clone-running', 0.2)); });
  const { service, project, dir } = await owned(t); await saveHttp(service, http.endpoint);
  const source = await service.start({ project, request: speech('source-running'), complete: async () => ({ ok: true }) }); await entered;
  try {
    const copied = { projectId: 'copied-live-project', dir: path.join(dir, 'copied-live-project') }; await fs.cp(project.dir, copied.dir, { recursive: true });
    const store = path.join(copied.dir, '.film', 'creation-media-jobs.json'), bytes = await fs.readFile(store);
    assert.equal(JSON.parse(bytes).entries[0].job.state, 'running');
    assert.deepEqual(await service.listForProject(copied), []); assert.equal(service.cancel(copied.projectId, source.job.id).code, 'JOB_NOT_FOUND');
    assert.equal(service.list(project.projectId)[0].state, 'running'); assert.equal(http.requests.length, 1); assert.deepEqual(await fs.readFile(store), bytes);
    await assert.rejects(fs.stat(path.join(path.dirname(store), 'creation-media-jobs.archive')), { code: 'ENOENT' });
  } finally { release(); await service.settled(); }
  assert.equal(service.list(project.projectId)[0].state, 'completed');
});

test('foreign receipt archives reject collisions and symlink paths without replacing evidence or starting a provider', async (t) => {
  for (const kind of ['collision', 'directory-symlink', 'file-symlink']) {
    let calls = 0; const { service, project, dir } = await owned(t, { fetch: async () => { calls++; throw new Error('archive safety failure must precede any provider request'); } });
    await saveHttp(service, 'http://localhost:5555/v1');
    const store = path.join(project.dir, '.film', 'creation-media-jobs.json'); await fs.mkdir(path.dirname(store), { recursive: true });
    const bytes = Buffer.from(JSON.stringify({ version: 1, projectId: 'old-project', entries: [{ opId: 'old-op', fingerprint: 'f'.repeat(64), job: { id: 'old-queued', projectId: 'old-project', kind: 'tts', state: 'queued', progress: 0 } }] }, null, 2) + '\n');
    await fs.writeFile(store, bytes);
    const archiveDir = path.join(path.dirname(store), 'creation-media-jobs.archive'), digest = createHash('sha256').update(bytes).digest('hex');
    const outside = path.join(dir, 'outside'); await fs.mkdir(outside); const sentinel = path.join(outside, `${digest}.json`); await fs.writeFile(sentinel, 'do-not-overwrite');
    if (kind === 'directory-symlink') await fs.symlink(outside, archiveDir);
    else { await fs.mkdir(archiveDir); if (kind === 'file-symlink') await fs.symlink(sentinel, path.join(archiveDir, `${digest}.json`)); else await fs.writeFile(path.join(archiveDir, `${digest}.json`), 'different-archive'); }
    assert.deepEqual(await service.listForProject(project), [], 'read does not inspect/create an archive');
    await assert.rejects(service.start({ project, request: speech('new-explicit'), complete: async () => assert.fail('must not apply') }), error => error.code === (kind === 'collision' ? 'JOB_STORE_ARCHIVE_COLLISION' : 'JOB_STORE_PATH'));
    assert.equal(calls, 0); assert.deepEqual(await fs.readFile(store), bytes); assert.equal(await fs.readFile(sentinel, 'utf8'), 'do-not-overwrite'); assert.deepEqual(service.list(project.projectId), []);
    if (kind === 'collision') assert.equal(await fs.readFile(path.join(archiveDir, `${digest}.json`), 'utf8'), 'different-archive');
  }
});

test('concurrent identical starts reserve one durable job and invoke provider/completion only once', async (t) => {
  const http = await fixture(t, (_req, res) => res.end(synthesizeLibraryAudio('concurrent', 0.2)));
  const { service, project } = await owned(t); await saveHttp(service, http.endpoint);
  let completed = 0; const request = speech('parallel-single-reservation');
  const outputs = await Promise.all(Array.from({ length: 12 }, () => service.start({ project, request, complete: async () => { completed++; return { ok: true }; } })));
  await service.settled();
  assert.equal(new Set(outputs.map(out => out.job.id)).size, 1); assert.equal(completed, 1); assert.equal(http.requests.length, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(project.dir, '.film', 'creation-media-jobs.json'), 'utf8')).entries.length, 1);
});

test('a second in-process service observes its live peer without marking it interrupted or closing its job', async (t) => {
  let reached; const entered = new Promise(resolve => { reached = resolve; }); let release;
  const http = await fixture(t, async (_req, res) => { reached(); await new Promise(resolve => { release = resolve; }); res.end(synthesizeLibraryAudio('peer', 0.2)); });
  const { service, project, configFile } = await owned(t); await saveHttp(service, http.endpoint);
  const request = speech('live-owner');
  const first = await service.start({ project, request, complete: async () => ({ ok: true }) }); await entered;
  const peer = createMediaServices({ configFile, run: voicesRun }); t.after(async () => { peer.close(); await peer.settled(); });
  assert.equal((await peer.listForProject(project))[0].state, 'running');
  const replay = await peer.start({ project, request, complete: async () => assert.fail('must not rerun') }); assert.equal(replay.job.id, first.job.id);
  peer.close(); release(); await service.settled(); assert.equal(service.list(project.projectId)[0].state, 'completed'); assert.equal(http.requests.length, 1);
});

test('committing cannot be cancelled into a false failure after the project was written', async (t) => {
  const http = await fixture(t, (_req, res) => res.end(synthesizeLibraryAudio('commit', 0.2)));
  const { service, project } = await owned(t); await saveHttp(service, http.endpoint);
  let reached; const entered = new Promise(resolve => { reached = resolve; }); let release;
  const out = await service.start({ project, request: speech('commit-cancel'), complete: async () => { reached(); await new Promise(resolve => { release = resolve; }); return { ok: true, clipId: 'actually-written' }; } });
  await entered;
  assert.equal(service.cancel(project.projectId, out.job.id).code, 'JOB_FINALIZING');
  release(); await service.settled();
  assert.equal(service.list(project.projectId)[0].state, 'completed'); assert.equal(service.list(project.projectId)[0].result.clipId, 'actually-written');
});

test('symlink and corrupt receipt stores fail closed and preserve evidence', async (t) => {
  const { project, dir, configFile } = await owned(t);
  const service = createMediaServices({ configFile, run: voicesRun });
  await fs.mkdir(path.join(project.dir, '.film')); const outside = path.join(dir, 'outside.json'); await fs.writeFile(outside, 'DO_NOT_CHANGE');
  const file = path.join(project.dir, '.film', 'creation-media-jobs.json'); await fs.symlink(outside, file);
  await assert.rejects(service.listForProject(project), e => e.code === 'JOB_STORE_PATH'); assert.equal(await fs.readFile(outside, 'utf8'), 'DO_NOT_CHANGE');
  await fs.unlink(file); await fs.writeFile(file, '{broken-json');
  await assert.rejects(service.listForProject(project), e => e.code === 'JOB_STORE_INVALID'); assert.equal(await fs.readFile(file, 'utf8'), '{broken-json');
});

test('timeout escalates only the owned stubborn child, leaving no running process', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-owned-child-')); const pidFile = path.join(dir, 'pid'); let pid;
  t.after(async () => { if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} } await fs.rm(dir, { recursive: true, force: true }); });
  const code = "require('fs').writeFileSync(process.argv[1],String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  await assert.rejects(runMediaProcess(process.execPath, ['-e', code, pidFile], { timeoutMs: 300 }), e => e.code === 'TIMEOUT');
  pid = Number(await fs.readFile(pidFile, 'utf8'));
  const deadline = Date.now() + 1500; let running = true;
  while (running && Date.now() < deadline) { try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 25)); } catch { running = false; } }
  assert.equal(running, false, 'owned child must exit after TERM grace period');
  if (!running) pid = undefined;
});
