// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createContext } from '../../cli/ops.mjs';
import { createTools } from '../tools.mjs';
import { validate } from '../../cli/jsonschema.mjs';
import { createCli } from '../../cli/index.mjs';
import { authorizeToolCall, createToolGrant } from '../../agents/tool-grant.mjs';

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-library-transport-'));
  const project = path.join(root, 'project'); await fs.mkdir(project); await fs.writeFile(path.join(project, 'film.html'), '<html><body><section></section></body></html>');
  const calls = [], expectedHash = 'a'.repeat(64);
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null; calls.push({ method: req.method, url: req.url, grant: req.headers['x-opencut-agent-grant'], body });
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.headers['x-opencut-agent-grant'] !== 'test-ticket') { res.statusCode = 403; res.end(JSON.stringify({ ok: false, code: 'GRANT_UNKNOWN', message: 'wrong grant' })); return; }
    res.end(JSON.stringify(req.method === 'GET' ? { projectId: 'scope::main', sourceHash: expectedHash, items: [{ id: 'builtin:text-basic' }], folders: [] } : { ok: true, hash: expectedHash, clipId: 'created-through-original-domain' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const studio = { baseUrl: `http://127.0.0.1:${server.address().port}`, grantId: 'test-ticket', projectId: 'scope::main' };
  const ctx = createContext({ root, cwd: root, log() {} });
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  return { root, project, calls, studio, ctx, expectedHash };
}
test('library MCP tools expose real typed actions and insert schemas accept object clips', async (t) => {
  const f = await setup(t), tools = createTools(f.ctx, { studio: f.studio, allowWrite: true });
  assert.ok(tools.find((x) => x.name === 'creation_library_read'));
  const action = tools.find((x) => x.name === 'creation_library_action'); assert.equal(action.write, true);
  const args = { project: f.project, confirm: true, request: { action: 'resource.apply', itemId: 'builtin:text-basic', expectedHash: f.expectedHash, opId: 'title', target: { at: 0, mode: 'overlay' } } };
  assert.equal(validate(action.inputSchema, args).ok, true);
  for (const name of ['film_apply_ops', 'film_propose_ops']) {
    const tool = tools.find((x) => x.name === name);
    assert.equal(validate(tool.inputSchema, { project: f.project, expectedHash: f.expectedHash, opId: 'insert', ops: [{ op: 'insert', clip: { id: 'new', kind: 'page', src: 'scenes/new.html', time: [0, 4] }, track: { insert: 0 }, at: 0 }] }).ok, true);
  }
  const read = await tools.find((x) => x.name === 'creation_library_read').run({ project: f.project }); assert.equal(read.sourceHash, f.expectedHash);
  const applied = await action.run(args); assert.equal(applied.ok, true); assert.equal(f.calls[1].body.opId, 'title'); assert.equal(f.calls[1].grant, 'test-ticket'); assert.match(f.calls[1].url, /scope%3A%3Amain\/creation-library\/actions$/);
});
test('library MCP startup + per-call confirmation + original Studio grant gates remain mandatory', async (t) => {
  const f = await setup(t), request = { action: 'resource.apply', opId: 'x', expectedHash: f.expectedHash };
  await assert.rejects(createTools(f.ctx, { studio: f.studio }).find((x) => x.name === 'creation_library_action').run({ project: f.project, request, confirm: true }), { code: 'E_WRITE_DENIED' });
  await assert.rejects(createTools(f.ctx, { studio: f.studio, allowWrite: true }).find((x) => x.name === 'creation_library_action').run({ project: f.project, request }), { code: 'E_CONFIRM_REQUIRED' });
  await assert.rejects(createTools(f.ctx, { allowWrite: true }).find((x) => x.name === 'creation_library_action').run({ project: f.project, request, confirm: true }), { code: 'NEEDS_STUDIO' });
  await assert.rejects(createTools(f.ctx, { studio: { ...f.studio, grantId: 'wrong' }, allowWrite: true }).find((x) => x.name === 'creation_library_action').run({ project: f.project, request, confirm: true }), { code: 'GRANT_UNKNOWN' });
  assert.equal(f.calls.length, 1, 'denied local calls must not reach the service');
});
test('ACP library aliases inherit existing project read/write grants without new wider tickets', async (t) => {
  const f = await setup(t);
  const grant = (tools) => createToolGrant({ tools, projectId: 'scope::main', projectPath: f.project, sessionId: 's1', runId: 'r1', requestId: 'turn-1' });
  const scope = { args: { project: f.project }, cwd: f.project, sessionId: 's1', requestId: 'turn-1' };
  const readOnly = grant(['film_read']);
  assert.equal(authorizeToolCall(readOnly, { server: 'opencut', tool: 'creation_library_read' }, scope).decision, 'allow');
  assert.equal(authorizeToolCall(readOnly, { server: 'opencut', tool: 'creation_library_action' }, scope).reason, 'TOOL_NOT_GRANTED');
  const write = grant(['film_apply_ops']);
  assert.equal(authorizeToolCall(write, { server: 'opencut', tool: 'creation_library_action' }, scope).decision, 'allow');
  assert.equal(authorizeToolCall(write, { server: 'opencut', tool: 'creation_library_action' }, { ...scope, requestId: 'wrong' }).reason, 'REQUEST_MISMATCH');
  const other = path.join(f.root, 'other'); await fs.mkdir(other);
  assert.equal(authorizeToolCall(write, { server: 'opencut', tool: 'creation_library_action' }, { ...scope, args: { project: other } }).reason, 'PROJECT_MISMATCH');
  assert.throws(() => grant(['creation_library_action']), /不是可授权/);
});
test('CLI library-list/library-action use identical service requests; detached execution refuses a second editor', async (t) => {
  const f = await setup(t), cli = createCli({ root: f.root, cwd: f.root, log() {} }); let stdout = '', stderr = '';
  const io = { stdout: { write(s) { stdout += s; } }, stderr: { write(s) { stderr += s; } } };
  assert.equal(await cli.run(['library-list', f.project, '--studio-url', f.studio.baseUrl, '--project-id', f.studio.projectId, '--json'], io), 0);
  assert.equal(JSON.parse(stdout).sourceHash, f.expectedHash); stdout = '';
  const file = path.join(f.root, 'action.json'); await fs.writeFile(file, JSON.stringify({ action: 'resource.apply', itemId: 'builtin:text-basic', opId: 'from-cli', expectedHash: f.expectedHash, target: { at: 0, mode: 'overlay' } }));
  assert.equal(await cli.run(['library-action', f.project, '--studio-url', f.studio.baseUrl, '--project-id', f.studio.projectId, '--grant', f.studio.grantId, '--action-file', file, '--allow-write', '--confirm', '--json'], io), 0);
  assert.equal(JSON.parse(stdout).ok, true); assert.equal(f.calls[1].body.opId, 'from-cli'); stdout = '';
  assert.notEqual(await cli.run(['library-list', f.project, '--json'], io), 0); assert.match(stdout, /NEEDS_STUDIO/);
});
