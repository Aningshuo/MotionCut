/**
 * WP18 MCP 验收（P5-A6/A7/A8，另含 A5 的 MCP 入口）。
 *
 * 两类证据：
 * 1. 进程内：直接喂 JSON-RPC 消息，断言协议细节；
 * 2. **真实 stdio**：spawn `packages/mcp/bin.mjs`，把整段会话存成 transcript
 *    （`test/fixtures/stdio-session.mjs`），断言的是子进程真实回包。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createContext } from '../../cli/ops.mjs';
import { createFilmPort, createProjectsPort } from '../../cli/test/fixtures/stub-ports.mjs';
import { createMcpServer } from '../server.mjs';

const execFileAsync = promisify(execFile);
const ROOT = new URL('../../../', import.meta.url).pathname;
const FIXTURE = path.join(ROOT, 'contracts/fixtures/film-v12.html');
const SESSION = path.join(ROOT, 'packages/mcp/test/fixtures/stdio-session.mjs');

/** @type {string} */
let workDir;

before(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-mcp-'));
  await fs.mkdir(path.join(workDir, 'proj'), { recursive: true });
  await fs.copyFile(FIXTURE, path.join(workDir, 'proj', 'film.html'));
});

after(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

/**
 * @param {{ allowWrite?: boolean }} [opts]
 */
function makeServer(opts = {}) {
  const ctx = createContext({
    film: createFilmPort(),
    projects: createProjectsPort({ root: workDir }),
    root: workDir,
    cwd: workDir,
    stateDir: path.join(workDir, '.state'),
    log: () => {},
  });
  return createMcpServer(ctx, opts);
}

/**
 * @param {string} project
 */
async function hashOf(project) {
  const buf = await fs.readFile(path.join(project, 'film.html'));
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---- A6 -----------------------------------------------------------------

test('A6 initialize 与 tools/list：六个 tool（MCP + CS2 提案），schema 完整', async () => {
  const server = makeServer();
  const init = await server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'opencut-mcp');
  assert.deepEqual(init.result.capabilities.tools, { listChanged: false });

  const list = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = /** @type {any[]} */ (list.result.tools).map((/** @type {any} */ t) => t.name).sort();
  assert.deepEqual(names, ['creation_library_action', 'creation_library_read', 'export_start', 'export_status', 'film_apply_ops', 'film_propose_ops', 'film_read', 'project_list']);
  for (const tool of /** @type {any[]} */ (list.result.tools)) {
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} schema`);
    assert.ok(tool.inputSchema.properties, `${tool.name} properties`);
    assert.ok(typeof tool.annotations?.readOnlyHint === 'boolean');
  }
  const apply = /** @type {any[]} */ (list.result.tools).find((/** @type {any} */ t) => t.name === 'film_apply_ops');
  assert.equal(apply.annotations.readOnlyHint, false);
  assert.deepEqual(apply.inputSchema.required, ['project', 'expectedHash', 'opId', 'ops']);
});

test('A6 notifications/initialized 不回包', async () => {
  const server = makeServer();
  const response = await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(response, null);
});

// ---- A7 -----------------------------------------------------------------

test('A7 未加 --allow-write：film_apply_ops 被明确拒绝', async () => {
  const server = makeServer();
  const response = await server.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'film_apply_ops', arguments: { project: 'proj', expectedHash: 'a'.repeat(64), opId: 'op-1', ops: [{ op: 'set' }] } },
  });
  assert.equal(response.result.isError, true);
  assert.equal(response.result.structuredContent.error.code, 'E_WRITE_DENIED');
});

test('A7 加 --allow-write：同一调用真的写盘（幂等仍生效）', async () => {
  const project = path.join(workDir, 'proj');
  const hash0 = await hashOf(project);
  const server = makeServer({ allowWrite: true });
  const args = {
    project: 'proj',
    expectedHash: hash0,
    opId: 'op-mcp-write',
    ops: [{ op: 'set', field: 'title', value: 'mcp-wrote-this' }],
    confirm: true,
  };
  const response = await server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'film_apply_ops', arguments: args } });
  assert.equal(response.result.isError, false);
  assert.equal(response.result.structuredContent.ok, true);
  assert.notEqual(response.result.structuredContent.hash, hash0);
  assert.equal(response.result.structuredContent.hash, await hashOf(project));
  assert.match(await fs.readFile(path.join(project, 'film.html'), 'utf8'), /mcp-wrote-this/);

  const replay = await server.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'film_apply_ops', arguments: args } });
  assert.equal(replay.result.structuredContent.replayed, true);
  assert.equal(replay.result.structuredContent.hash, response.result.structuredContent.hash);
});

// ---- A5（MCP 入口）-----------------------------------------------------

test('A5 MCP film_read 路径逃逸 → E_PATH_ESCAPE', async () => {
  const server = makeServer();
  const response = await server.handle({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'film_read', arguments: { project: '../../etc/passwd' } },
  });
  assert.equal(response.result.isError, true);
  assert.equal(response.result.structuredContent.error.code, 'E_PATH_ESCAPE');
});

// ---- A8 -----------------------------------------------------------------

test('A8 未知方法 → -32601；坏参数 → -32602；进程不崩（后续 ping 正常）', async () => {
  const server = makeServer();

  const unknown = await server.handle({ jsonrpc: '2.0', id: 7, method: 'resources/list' });
  assert.equal(unknown.error.code, -32601);

  const noName = await server.handle({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: {} });
  assert.equal(noName.error.code, -32602);

  const unknownTool = await server.handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  assert.equal(unknownTool.error.code, -32602);

  const badArgs = await server.handle({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'film_read', arguments: { project: 42 } } });
  assert.equal(badArgs.error.code, -32602);
  assert.ok(Array.isArray(badArgs.error.data.errors));

  const badEnvelope = await server.handle({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: { name: 'film_read', arguments: { project: 'proj', extra: true } },
  });
  assert.equal(badEnvelope.error.code, -32602);

  const badVersion = await server.handle({ jsonrpc: '1.0', id: 12, method: 'ping' });
  assert.equal(badVersion.error.code, -32600);

  const alive = await server.handle({ jsonrpc: '2.0', id: 13, method: 'ping' });
  assert.deepEqual(alive.result, {});
});

// ---- 真实 stdio ---------------------------------------------------------

test('真实 stdio 会话：initialize/tools/list/tools/call 全链路（transcript 落文件）', async () => {
  const transcript = path.join(workDir, 'stdio-transcript.json');
  await execFileAsync(
    process.execPath,
    [SESSION, '--transcript', transcript, '--project', 'proj', '--root', workDir],
    { cwd: workDir },
  );

  const data = JSON.parse(await fs.readFile(transcript, 'utf8'));
  assert.equal(data.layer, 'REAL_STDIO');
  assert.equal(data.exitCode, 0, `server should exit cleanly, stderr: ${data.stderr}`);
  assert.equal(data.allowWrite, false);

  const byId = new Map(/** @type {any[]} */ (data.exchanges).map((/** @type {any} */ e) => [e.request.id, e.response]));
  assert.equal(byId.get(1).result.serverInfo.name, 'opencut-mcp');
  assert.equal(byId.get(2).result.tools.length, 8);
  assert.equal(byId.get(3).result.isError, true);
  assert.equal(byId.get(3).result.structuredContent.error.code, 'E_WRITE_DENIED');
  assert.equal(byId.get(4).result.structuredContent.error.code, 'E_PATH_ESCAPE');
  assert.equal(byId.get(5).result.structuredContent.ok, true);
  assert.match(byId.get(5).result.structuredContent.sourceHash, /^[0-9a-f]{64}$/);
  assert.equal(byId.get(6).error.code, -32601);
  assert.equal(byId.get(7).error.code, -32602);
  assert.deepEqual(byId.get(8).result, {});
});
