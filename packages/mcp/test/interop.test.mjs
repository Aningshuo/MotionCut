/**
 * P8 验收（A1–A9）：协议层互操作、门禁、审计、并发与限流。
 *
 * 边界：这是**原始 JSON-RPC over stdio 的自测**（模拟第三方客户端），
 * **不是**真实 Claude/Codex 宿主互通——后者仍是 UNVERIFIED（A9）。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createContext } from '../../cli/ops.mjs';
import { createFilmPort, createProjectsPort } from '../../cli/test/fixtures/stub-ports.mjs';
import { createMcpServer } from '../server.mjs';
import { hashArgs } from '../audit.mjs';

const ROOT = new URL('../../../', import.meta.url).pathname;
const FIXTURE = path.join(ROOT, 'contracts/fixtures/film-v12.html');
const BIN = path.join(ROOT, 'packages/mcp/bin.mjs');
const STUB = path.join(ROOT, 'packages/cli/test/fixtures/stub-ports.mjs');

/** @type {string} */
let workDir;

before(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-mcp-interop-'));
  for (const name of ['proj', 'proj-b']) {
    await fs.mkdir(path.join(workDir, name), { recursive: true });
    await fs.copyFile(FIXTURE, path.join(workDir, name, 'film.html'));
  }
});

after(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

/**
 * @param {{ allowWrite?: boolean, auditDir?: string, rateLimit?: number, stateDir?: string, sessionId?: string }} [opts]
 */
/** @param {any} [opts] */
function makeServer(opts = {}) {
  const ctx = createContext({
    film: createFilmPort(),
    projects: createProjectsPort({ root: workDir }),
    root: workDir,
    cwd: workDir,
    stateDir: opts.stateDir ?? path.join(workDir, 'state'),
    log: () => {},
  });
  return createMcpServer(ctx, {
    ...(opts.allowWrite !== undefined ? { allowWrite: opts.allowWrite } : {}),
    ...(opts.auditDir ? { auditDir: opts.auditDir } : {}),
    ...(opts.rateLimit !== undefined ? { rateLimit: opts.rateLimit } : {}),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.auditMaxBytes !== undefined ? { auditMaxBytes: opts.auditMaxBytes } : {}),
  });
}

let nextId = 1;
/**
 * @param {any} server
 * @param {string} method
 * @param {any} [params]
 */
function call(server, method, params) {
  return server.handle({ jsonrpc: '2.0', id: nextId++, method, ...(params === undefined ? {} : { params }) });
}

// ---- A1 -----------------------------------------------------------------

test('A1 完整握手：initialize / notifications/initialized', async () => {
  const server = makeServer();
  const init = await call(server, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'interop-test', version: '1.0.0' },
  });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities.tools, { listChanged: false });
  assert.equal(init.result.serverInfo.name, 'opencut-mcp');
  assert.match(init.result.instructions, /confirm/i);

  const initialized = await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(initialized, null, 'notification must not be answered');

  const ping = await call(server, 'ping');
  assert.deepEqual(ping.result, {});
});

// ---- A2 -----------------------------------------------------------------

test('A2 tools/list：6 个 tool，name/description/inputSchema 齐全且自检通过', async () => {
  const server = makeServer();
  const list = await call(server, 'tools/list');
  const tools = /** @type {any[]} */ (list.result.tools);
  assert.equal(tools.length, 8);
  for (const tool of tools) {
    assert.equal(typeof tool.name, 'string');
    assert.ok(tool.description.length > 0, `${tool.name} description`);
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} schema type`);
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} closed schema`);
    assert.ok(tool.inputSchema.properties && typeof tool.inputSchema.properties === 'object');
  }
  const writeTools = tools.filter((tool) => tool.annotations.readOnlyHint === false).map((tool) => tool.name);
  assert.deepEqual(writeTools.sort(), ['creation_library_action', 'export_start', 'film_apply_ops']);
  for (const name of writeTools) {
    const schema = tools.find((tool) => tool.name === name).inputSchema;
    assert.ok(schema.properties.confirm, `${name} must expose confirm`);
  }
});

// ---- A3 -----------------------------------------------------------------

test('A3 缺必填 / 类型错 / 多余字段 → -32602 且 data.path 指到字段', async () => {
  const server = makeServer();

  const missing = await call(server, 'tools/call', {
    name: 'film_apply_ops',
    arguments: { project: 'proj', expectedHash: 'a'.repeat(64), ops: [{ op: 'set' }] },
  });
  assert.equal(missing.error.code, -32602);
  assert.equal(missing.error.data.path, '$.opId');

  const wrongType = await call(server, 'tools/call', { name: 'film_read', arguments: { project: 42 } });
  assert.equal(wrongType.error.code, -32602);
  assert.equal(wrongType.error.data.path, '$.project');

  const extra = await call(server, 'tools/call', { name: 'film_read', arguments: { project: 'proj', extra: true } });
  assert.equal(extra.error.code, -32602);
  assert.equal(extra.error.data.path, '$.extra');

  const badOp = await call(server, 'tools/call', {
    name: 'no-such-tool',
    arguments: {},
  });
  assert.equal(badOp.error.code, -32602);
  assert.equal(badOp.error.data.path, 'params.name');
});

// ---- A4 -----------------------------------------------------------------

test('A4 三种路径逃逸 → E_PATH_ESCAPE，且目标文件未被读', async () => {
  const server = makeServer();
  const target = path.join(workDir, 'outside.txt');
  await fs.writeFile(target, 'secret outside the sandbox');
  const before = await fs.stat(target);

  for (const project of ['../../etc/passwd', '/etc/passwd', 'escape-link']) {
    if (project === 'escape-link') {
      await fs.rm(path.join(workDir, project), { force: true });
      await fs.symlink('/etc', path.join(workDir, project));
    }
    const response = await call(server, 'tools/call', { name: 'film_read', arguments: { project } });
    assert.equal(response.result.isError, true, project);
    assert.equal(response.result.structuredContent.error.code, 'E_PATH_ESCAPE', project);
  }

  const afterStat = await fs.stat(target);
  assert.equal(afterStat.mtimeMs, before.mtimeMs, 'outside file must not be touched');
});

// ---- A5 -----------------------------------------------------------------

test('A5 写门禁：无开关 E_WRITE_DENIED；有开关但无 confirm → E_CONFIRM_REQUIRED（附示例）', async () => {
  const args = {
    project: 'proj',
    expectedHash: 'a'.repeat(64),
    opId: 'op-gate',
    ops: [{ op: 'set', field: 'title', value: 'x' }],
  };

  const noSwitch = await call(makeServer({ allowWrite: false }), 'tools/call', { name: 'film_apply_ops', arguments: { ...args, confirm: true } });
  assert.equal(noSwitch.result.isError, true);
  assert.equal(noSwitch.result.structuredContent.error.code, 'E_WRITE_DENIED');

  const noConfirm = await call(makeServer({ allowWrite: true }), 'tools/call', { name: 'film_apply_ops', arguments: args });
  assert.equal(noConfirm.result.isError, true);
  const failure = noConfirm.result.structuredContent.error;
  assert.equal(failure.code, 'E_CONFIRM_REQUIRED');
  assert.equal(failure.example.confirm, true, 'error must carry a correct call example');

  const confirmed = await call(makeServer({ allowWrite: true }), 'tools/call', { name: 'film_apply_ops', arguments: { ...args, confirm: true } });
  // confirm 之后才进入真实语义；这里 expectedHash 是假的，所以应是 CONFLICT 而不是门禁错误
  assert.equal(confirmed.result.isError, true);
  assert.equal(confirmed.result.structuredContent.error.code, 'CONFLICT');
});

test('A5 export_start 同样需要 confirm', async () => {
  const args = {
    project: 'proj',
    spec: { jobId: 'j-gate', projectId: 'proj', kind: 'video', expectedHash: 'a'.repeat(64) },
  };
  const denied = await call(makeServer({ allowWrite: true }), 'tools/call', { name: 'export_start', arguments: { ...args, dryRun: true } });
  assert.equal(denied.result.structuredContent.error.code, 'E_CONFIRM_REQUIRED');
  const allowed = await call(makeServer({ allowWrite: true }), 'tools/call', { name: 'export_start', arguments: { ...args, dryRun: true, confirm: true } });
  assert.equal(allowed.result.isError, false);
  assert.equal(allowed.result.structuredContent.dryRun, true);
});

// ---- A6 -----------------------------------------------------------------

test('A6 审计：10 次调用 10 行、字段齐全、无 Key、轮转生效', async () => {
  const auditDir = path.join(workDir, 'audit-a6');
  const secret = 'sk-live-abcdef1234567890';
  const server = makeServer({ auditDir, sessionId: 'sess-a6' });

  for (let i = 0; i < 9; i += 1) {
    await call(server, 'tools/call', { name: 'project_list', arguments: {} });
  }
  // 第 10 次带一个假 Key 作为路径（会失败），用来自证日志里没有它
  await call(server, 'tools/call', { name: 'film_read', arguments: { project: secret } });
  await server.close();

  const file = path.join(auditDir, 'audit.jsonl');
  const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 10, `expected 10 audit lines, got ${lines.length}`);
  for (const line of lines) {
    const entry = JSON.parse(line);
    assert.deepEqual(Object.keys(entry).sort(), ['argsHash', 'code', 'durationMs', 'ok', 'session', 'tool', 'ts']);
    assert.equal(entry.session, 'sess-a6');
    assert.match(entry.argsHash, /^[0-9a-f]{64}$/);
    assert.equal(typeof entry.durationMs, 'number');
    assert.equal(typeof entry.ok, 'boolean');
  }
  assert.equal(lines.at(-1) && JSON.parse(lines.at(-1) ?? '{}').ok, false);
  const raw = await fs.readFile(file, 'utf8');
  assert.ok(!raw.includes(secret), 'audit log leaked the key');

  // 轮转：阈值 400 字节 → 10 次调用应产生多份
  const rotateDir = path.join(workDir, 'audit-rotate');
  const rotating = makeServer({ auditDir: rotateDir, sessionId: 'sess-rotate', auditMaxBytes: 400 });
  for (let i = 0; i < 10; i += 1) {
    await call(rotating, 'tools/call', { name: 'project_list', arguments: {} });
  }
  await rotating.close();
  const files = (await fs.readdir(rotateDir)).filter((name) => name.endsWith('.jsonl'));
  assert.ok(files.length >= 2, `rotation did not happen: ${files.join(',')}`);
});

test('A6 argsHash 稳定：同一参数不同键序哈希一致', () => {
  assert.equal(hashArgs({ a: 1, b: [2, 3] }), hashArgs({ b: [2, 3], a: 1 }));
  assert.notEqual(hashArgs({ a: 1 }), hashArgs({ a: 2 }));
});

// ---- A8 -----------------------------------------------------------------

test('A8 限流：第 N+1 次 E_RATE_LIMITED，带 retryAfterMs', async () => {
  const server = makeServer({ rateLimit: 3, auditDir: path.join(workDir, 'audit-a8') });
  for (let i = 0; i < 3; i += 1) {
    const ok = await call(server, 'tools/call', { name: 'project_list', arguments: {} });
    assert.equal(ok.result.isError, false, `call ${i + 1}`);
  }
  const limited = await call(server, 'tools/call', { name: 'project_list', arguments: {} });
  assert.equal(limited.result.isError, true);
  const failure = limited.result.structuredContent.error;
  assert.equal(failure.code, 'E_RATE_LIMITED');
  assert.ok(failure.retryAfterMs > 0 && failure.retryAfterMs <= 1000, `retryAfterMs ${failure.retryAfterMs}`);
  await server.close();
});

// ---- 真实 stdio：A7 / A9 --------------------------------------------------

/**
 * 极简 stdio 会话：真的 spawn bin，按行收发。
 */
class StdioSession {
  /**
   * @param {string[]} args
   * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [opts]
   */
  constructor(args, opts = {}) {
    this.child = spawn(process.execPath, [BIN, ...args], {
      cwd: opts.cwd ?? workDir,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.buffer = '';
    this.stderr = '';
    /** @type {Map<any, (value: any) => void>} */
    this.waiting = new Map();
    this.exited = new Promise((resolve) => this.child.once('exit', (code) => resolve(code)));
    this.child.stdout.on('data', (chunk) => this.#onData(String(chunk)));
    this.child.stderr.on('data', (chunk) => {
      this.stderr += String(chunk);
    });
  }

  /** @param {string} text */
  #onData(text) {
    this.buffer += text;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) {
        const message = JSON.parse(line);
        const resolve = this.waiting.get(message.id);
        if (resolve) {
          this.waiting.delete(message.id);
          resolve(message);
        }
      }
      index = this.buffer.indexOf('\n');
    }
  }

  /** @param {any} message */
  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    if (message.id === undefined) return Promise.resolve(null);
    return new Promise((resolve) => this.waiting.set(message.id, resolve));
  }

  /** 原始写一行（用于坏 JSON）。 @param {string} line */
  raw(line) {
    this.child.stdin.write(`${line}\n`);
  }

  async close() {
    this.child.stdin.end();
    return this.exited;
  }

  kill() {
    this.child.kill('SIGKILL');
    return this.exited;
  }
}

test('A7 两会话并发：账本隔离；杀掉一个另一个继续可用', async () => {
  const stateBase = path.join(workDir, 'state-a7');
  const baseArgs = ['--root', workDir, '--film-module', STUB, '--allow-write', '--state-dir', stateBase];

  const a = new StdioSession(baseArgs);
  const b = new StdioSession(baseArgs);

  const initA = await a.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'A', version: '1' } } });
  const initB = await b.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'B', version: '1' } } });
  assert.notEqual(initA.result.serverInfo, undefined);
  assert.notEqual(initB.result.serverInfo, undefined);

  /** @param {string} project */
  const hashOf = async (project) => {
    const { createHash } = await import('node:crypto');
    const buffer = await fs.readFile(path.join(project, 'film.html'));
    return createHash('sha256').update(buffer).digest('hex');
  };

  const hashA = await hashOf(path.join(workDir, 'proj'));
  const hashB = await hashOf(path.join(workDir, 'proj-b'));

  // 同一个 opId，两边内容不同：若账本共享，第二次会 E_OPID_REUSE
  const applyA = await a.send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'film_apply_ops',
      arguments: { project: 'proj', expectedHash: hashA, opId: 'shared-op', ops: [{ op: 'set', field: 'title', value: 'from-A' }], confirm: true },
    },
  });
  const applyB = await b.send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'film_apply_ops',
      arguments: { project: 'proj-b', expectedHash: hashB, opId: 'shared-op', ops: [{ op: 'set', field: 'title', value: 'from-B' }], confirm: true },
    },
  });
  assert.equal(applyA.result.isError, false, JSON.stringify(applyA.result.structuredContent));
  assert.equal(applyB.result.isError, false, JSON.stringify(applyB.result.structuredContent));

  // 各自的工程真的被改成了各自的标题
  assert.match(await fs.readFile(path.join(workDir, 'proj', 'film.html'), 'utf8'), /from-A/);
  assert.match(await fs.readFile(path.join(workDir, 'proj-b', 'film.html'), 'utf8'), /from-B/);

  // 杀掉 A，B 仍然能 ping / tools-list
  await a.kill();
  const alive = await b.send({ jsonrpc: '2.0', id: 9, method: 'ping' });
  assert.deepEqual(alive.result, {});
  await b.close();
});

test('A9 未知方法 → -32601；坏 JSON → -32700；进程不崩（exitCode 0）', async () => {
  const session = new StdioSession(['--root', workDir, '--film-module', STUB, '--state-dir', path.join(workDir, 'state-a9')]);
  await session.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'A9', version: '1' } } });
  const unknown = await session.send({ jsonrpc: '2.0', id: 2, method: 'resources/list' });
  assert.equal(unknown.error.code, -32601);

  // 坏 JSON：没有 id，回 -32700（id 为 null）
  /** @type {any} */
  const parseError = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ error: { code: 'NO_RESPONSE' } }), 3000);
    session.waiting.set(null, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    session.raw('{not json');
  });
  assert.equal(parseError.error.code, -32700);

  const ping = await session.send({ jsonrpc: '2.0', id: 3, method: 'ping' });
  assert.deepEqual(ping.result, {});

  const exitCode = await session.close();
  assert.equal(exitCode, 0);
});
