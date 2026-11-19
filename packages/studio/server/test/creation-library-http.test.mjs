// @ts-nocheck
/** Real HTTP handler + registry + issued grant store; no browser, live model,
 * user key or real home is used. Only the unavailable voice inventory is injected. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCreationLibraryHttp } from '../creation-library-http.mjs';
import { createMediaServices } from '../media-services.mjs';
import { createProjectRegistry } from '../projects.mjs';
import { createFilmDocIo } from '../film-io.mjs';
import { createEventHub } from '../events.mjs';
import { createGrantStore } from '../grants.mjs';
import { createTools } from '../../../mcp/tools.mjs';
import { createContext } from '../../../cli/ops.mjs';
import { sha256 } from '../../../film-core/film-doc.mjs';

function wave() {
  const data = Buffer.alloc(44 + 16000); data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVE', 8); data.write('fmt ', 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(16000, 40); return data;
}
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-library-http-'))), home = path.join(root, 'home');
  await fs.mkdir(home, { recursive: true });
  const previousSkills = process.env.OPENCUT_SKILLS_DIR; process.env.OPENCUT_SKILLS_DIR = path.join(home, 'skills');
  const registry = createProjectRegistry({ hub: createEventHub(), io: createFilmDocIo(), history: false, watchImpl: () => ({ close() {} }) });
  const mediaServices = createMediaServices({ configFile: path.join(home, 'media-services.json'), run: async () => ({ stdout: '', stderr: '' }), resolveKey: async () => { throw new Error('this test must never request a real key'); } });
  const grants = createGrantStore(), projects = [];
  for (const name of ['one', 'two']) {
    const dir = path.join(root, name); await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
    await fs.writeFile(path.join(dir, 'film.html'), '<!doctype html><html><head><meta name="viewport" content="width=1280,height=720"></head><body><section><audio id="original" src="assets/original.wav#t=0,1" at="0"></audio></section></body></html>');
    await fs.writeFile(path.join(dir, 'assets', 'original.wav'), wave());
    await fs.writeFile(path.join(dir, 'assets', 'unused.wav'), wave());
    const opened = await registry.open(dir); assert.equal(opened.ok, true, opened.message); projects.push(registry.get(opened.project.projectId));
  }
  const authorize = (req, projectId) => {
    const grantId = req.headers['x-opencut-agent-grant'];
    if (!grantId) return { ok: true, by: 'person' };
    const verdict = grants.authorize(grantId, { projectId, projectPath: registry.get(projectId)?.dir, tool: 'film_apply_ops', sessionId: 'test-session', requestId: 'test-turn' });
    return verdict.ok ? { ok: true, by: 'agent' } : verdict;
  };
  const handler = createCreationLibraryHttp({ registry, mediaServices, libraryRoot: path.join(home, 'library'), contentOrigin: () => null, authorize });
  const server = http.createServer(async (req, res) => { if (!await handler(req, res, req.method, new URL(req.url, 'http://127.0.0.1'))) { res.writeHead(404); res.end(); } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); mediaServices.close(); await registry.closeAll(); if (previousSkills === undefined) delete process.env.OPENCUT_SKILLS_DIR; else process.env.OPENCUT_SKILLS_DIR = previousSkills; await fs.rm(root, { recursive: true, force: true }); });
  const base = (project = projects[0]) => `/api/projects/${project.projectId}/creation-library`;
  const json = async (rel, body, options = {}) => { const response = await fetch(url + rel, { method: body === undefined ? 'GET' : 'POST', ...options, headers: { 'content-type': 'application/json', ...options.headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, headers: response.headers, body: await response.json() }; };
  const hash = (project = projects[0]) => registry.docOf(project.projectId).hash;
  const grant = (project = projects[0]) => grants.issue({ tools: ['film_read', 'film_apply_ops'], projectId: project.projectId, projectPath: project.dir, sessionId: 'test-session', requestId: 'test-turn', runId: 'test-run' });
  return { root, home, registry, mediaServices, grants, projects, url, base, json, hash, grant };
}
test('HTTP read lists unused original media; import uses a real probe and does not change timeline/film', async (t) => {
  const f = await fixture(t), initial = f.hash();
  const read = await f.json(f.base()); assert.equal(read.status, 200, JSON.stringify(read.body)); assert.equal(read.body.ok, true); assert.ok(Array.isArray(read.body.audio)); assert.ok(read.body.captionSources?.sources);
  assert.ok(read.body.items.some(item => item.id === 'builtin:text-basic'));
  await assert.rejects(fs.stat(path.join(f.home, 'library', 'builtin')), { code: 'ENOENT' });
  const unused = read.body.items.find((x) => x.id === 'project:assets/unused.wav'); assert.equal(unused.refs, 0); assert.equal(unused.durationSec, 1);
  const imported = await f.json(`${f.base()}/import`, { name: '我的声音.wav', data: wave().toString('base64') }); assert.equal(imported.status, 200, JSON.stringify(imported.body)); assert.equal(imported.body.ok, true); assert.equal(imported.body.durationSec, 1);
  assert.equal(f.hash(), initial); assert.equal(f.registry.docOf(f.projects[0].projectId).doc.tracks.flatMap((x) => x.clips).length, 1);
  assert.ok((await f.json(f.base())).body.items.some((x) => x.id === imported.body.itemId));
});
test('real HTTP library GET of a copied project ignores foreign media jobs and leaves their complete receipt file untouched', async (t) => {
  const f = await fixture(t), [original, copied] = f.projects, source = path.join(original.dir, '.film', 'creation-media-jobs.json');
  await fs.mkdir(path.dirname(source), { recursive: true });
  const bytes = Buffer.from(JSON.stringify({ version: 1, projectId: original.projectId, entries: [{ opId: 'foreign-running', fingerprint: 'f'.repeat(64), job: { id: 'copied-old-job', projectId: original.projectId, kind: 'tts', state: 'running', progress: 0.1 } }] }, null, 2) + '\n');
  await fs.writeFile(source, bytes); await fs.cp(path.dirname(source), path.join(copied.dir, '.film'), { recursive: true });
  const target = path.join(copied.dir, '.film', 'creation-media-jobs.json'), stat = await fs.stat(target), filmHash = f.hash(copied);
  const read = await f.json(f.base(copied)); assert.equal(read.status, 200, JSON.stringify(read.body)); assert.equal(read.body.ok, true);
  assert.ok(read.body.items.some(item => item.id === 'project:assets/unused.wav')); assert.deepEqual(read.body.jobs, []);
  assert.deepEqual(await fs.readFile(target), bytes); assert.equal((await fs.stat(target)).mtimeMs, stat.mtimeMs); assert.deepEqual(await fs.readFile(source), bytes); assert.equal(f.hash(copied), filmHash);
  assert.equal(f.mediaServices.cancel(copied.projectId, 'copied-old-job').code, 'JOB_NOT_FOUND');
  await assert.rejects(fs.stat(path.join(copied.dir, '.film', 'creation-media-jobs.archive')), { code: 'ENOENT' });
});
test('HTTP action requires accurate CAS, uses one existing undo batch and replays the same stable op', async (t) => {
  const f = await fixture(t), before = f.hash();
  const request = { action: 'resource.apply', itemId: 'builtin:text-basic', expectedHash: before, opId: 'http-title', text: 'HTTP真实源标题', target: { at: 0, mode: 'overlay' } };
  const missing = await f.json(`${f.base()}/actions`, { ...request, opId: undefined }); assert.equal(missing.body.ok, false);
  const stale = await f.json(`${f.base()}/actions`, { ...request, expectedHash: '0'.repeat(64) }); assert.equal(stale.status, 409); assert.equal(stale.body.code, 'CONFLICT'); assert.equal(f.hash(), before);
  const result = await f.json(`${f.base()}/actions`, request); assert.equal(result.status, 200, JSON.stringify(result.body)); assert.ok(result.body.clipId);
  const replay = await f.json(`${f.base()}/actions`, request); assert.equal(replay.body.replayed, true); assert.equal(replay.body.hash, result.body.hash);
  const reused = await f.json(`${f.base()}/actions`, { ...request, text: '同key不同请求' }); assert.equal(reused.status, 409); assert.equal(reused.body.code, 'OP_ID_REUSED');
  assert.equal(f.registry.docOf(f.projects[0].projectId).undoDepth, 1);
  assert.equal((await f.registry.undo(f.projects[0].projectId, { expectedHash: f.hash(), opId: 'http-undo' })).ok, true); assert.equal(f.hash(), before);
});
test('HTML and SVG previews are sandboxed; byte ranges and bundle path scope stay accurate', async (t) => {
  const f = await fixture(t); const snap = await f.json(f.base()); const preview = snap.body.items.find((x) => x.id === 'builtin:text-basic').previewUrl;
  const html = await fetch(f.url + preview); assert.equal(html.status, 200); const csp = html.headers.get('content-security-policy'); assert.match(csp, /sandbox allow-scripts/); assert.doesNotMatch(csp, /allow-same-origin/); assert.match(csp, /connect-src 'none'/); assert.match(csp, /form-action 'none'/); assert.match(await html.text(), /window\.film/);
  const rel = 'assets/check.svg'; await fs.writeFile(path.join(f.projects[0].dir, rel), '<svg xmlns="http://www.w3.org/2000/svg"><text>真实SVG</text><script>window.parent.postMessage("untrusted","*")</script></svg>');
  const svgUrl = `${f.base()}/files/${encodeURIComponent(`project:${rel}`)}/${rel}`;
  const svg = await fetch(f.url + svgUrl); assert.equal(svg.status, 200); assert.match(svg.headers.get('content-security-policy'), /sandbox/);
  const audioUrl = `${f.base()}/files/${encodeURIComponent('project:assets/unused.wav')}/assets/unused.wav`;
  const range = await fetch(f.url + audioUrl, { headers: { range: 'bytes=0-11' } }); assert.equal(range.status, 206); assert.equal(range.headers.get('content-range'), `bytes 0-11/${wave().length}`); assert.equal(Buffer.from(await range.arrayBuffer()).toString('ascii', 0, 4), 'RIFF');
  const badRange = await fetch(f.url + audioUrl, { headers: { range: 'bytes=999999-' } }); assert.equal(badRange.status, 416);
  const privateUrl = `${f.base()}/files/${encodeURIComponent('project:film.html')}/film.html`; assert.equal((await fetch(f.url + privateUrl)).status, 400);
});
test('MCP lists original motion templates and applies a parameterized scene through the real granted HTTP handler', async t => {
  const f = await fixture(t), project = f.projects[0], { grantId } = f.grant();
  const tools = createTools(createContext({ root: f.root, cwd: project.dir, log() {} }), {
    allowWrite: true, studio: { baseUrl: f.url, grantId, projectId: project.projectId },
  });
  const listing = await tools.find(tool => tool.name === 'creation_library_read').run({ project: project.dir });
  const template = listing.items.find(item => item.id === 'builtin:template-route');
  assert.equal(template.paramSchema.step2.label, '第二步');
  const applied = await tools.find(tool => tool.name === 'creation_library_action').run({
    project: project.dir, confirm: true, request: { action: 'resource.apply', itemId: template.id,
      expectedHash: listing.sourceHash, opId: 'route-via-mcp', params: { step2: '校对字幕' }, target: { at: 0, mode: 'overlay' } },
  });
  assert.equal(applied.ok, true); assert.equal(applied.hash, f.hash());
  assert.match(await fs.readFile(path.join(project.dir, applied.src), 'utf8'), /data-aiedit-id="step2">校对字幕/);
});
test('real issued grants deny cross-project writes and Agent absolute-source imports; no authority is fabricated', async (t) => {
  const f = await fixture(t), issued = f.grant(), headers = { 'x-opencut-agent-grant': issued.grantId };
  const request = { action: 'resource.apply', itemId: 'builtin:text-basic', expectedHash: f.hash(), opId: 'grant-title', target: { at: 0, mode: 'overlay' } };
  const allowed = await f.json(`${f.base()}/actions`, request, { headers }); assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  const second = f.projects[1], original = f.hash(second);
  const denied = await f.json(`${f.base(second)}/actions`, { ...request, opId: 'wrong-project', expectedHash: original }, { headers }); assert.equal(denied.status, 403); assert.equal(f.hash(second), original);
  const source = path.join(f.root, 'source.wav'); await fs.writeFile(source, wave());
  const fileRead = await f.json(`${f.base()}/import`, { name: 'source.wav', source }, { headers }); assert.equal(fileRead.status, 403, JSON.stringify(fileRead.body)); assert.equal(fileRead.body.code, 'SOURCE_NOT_GRANTED');
  const unknown = await f.json(`${f.base()}/actions`, { ...request, expectedHash: f.hash(), opId: 'unknown-ticket' }, { headers: { 'x-opencut-agent-grant': 'no-such-issued-ticket' } }); assert.equal(unknown.status, 403);
});
test('settings persist only provider references, reject raw keys, and cannot be changed with project grants', async (t) => {
  const f = await fixture(t);
  const raw = await f.json('/api/settings/media-services', { config: { tts: { apiKey: 'do-not-persist-this' } } }, { method: 'PUT' }); assert.notEqual(raw.status, 200); assert.doesNotMatch(JSON.stringify(raw.body), /do-not-persist-this/);
  const issued = f.grant(); const denied = await f.json('/api/settings/media-services', { config: {} }, { method: 'PUT', headers: { 'x-opencut-agent-grant': issued.grantId } }); assert.equal(denied.status, 403);
  const saved = await f.json('/api/settings/media-services', { config: { tts: { mode: 'http', endpoint: 'http://127.0.0.1:49999', model: 'local-test', keyRef: 'model' } } }, { method: 'PUT' }); assert.equal(saved.status, 200, JSON.stringify(saved.body)); assert.equal(saved.body.config.tts.keyRef, 'model');
  assert.doesNotMatch(await fs.readFile(path.join(f.home, 'media-services.json'), 'utf8'), /apiKey|Bearer|do-not-persist-this/);
});
