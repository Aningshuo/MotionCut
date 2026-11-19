/**
 * M65：ACP 的 `mcpServers` 来自设置（B-MAIN-R30-032）。
 *
 * 这一组守的是「设置真的生效」：不是把数组拼出来就算，而是**子进程真的收到**了什么。
 * 用假 ACP 进程把 `session/new` 的 params 原样落盘，再逐字段对。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AgentSessions } from '../acp.mjs';

const MOCK = new URL('./mock-acp-capture.mjs', import.meta.url).pathname;

/**
 * @param {{settingsProvider?: () => Promise<any>, capture: string}} opts
 */
function makeManager(opts) {
  const cwd = path.dirname(opts.capture);
  return new AgentSessions({
    resolveProject: () => cwd,
    command: process.execPath,
    args: [MOCK, '--capture', opts.capture],
    turnTimeoutMs: 5_000,
    cancelGraceMs: 200,
    handshakeTimeoutMs: 8_000,
    ...(opts.settingsProvider ? { settingsProvider: opts.settingsProvider } : {}),
  });
}

/**
 * 等捕获文件出现并解析（子进程写盘是异步的）。
 * @param {string} file
 * @param {number} [timeoutMs]
 */
async function readCapture(file, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      if (Date.now() > deadline) throw new Error(`capture 超时：${file}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

/**
 * @param {any[]} servers
 */
function settingsWith(servers) {
  return { mcp: { servers } };
}

test('ACP：enabled 的 server 按设置顺序进入 session/new，disabled 不下发', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-acp-mcp-'));
  const capture = path.join(dir, 'capture.json');
  const servers = [
    { name: 'alpha', command: '/bin/alpha', args: ['--a'], env: { A: '1' }, enabled: true },
    { name: 'beta', command: '/bin/beta', args: [], env: {}, enabled: false },
    { name: 'gamma', command: '/bin/gamma', args: ['--g', 'x'], env: { G: 'two' }, enabled: true },
  ];
  const mgr = makeManager({ capture, settingsProvider: async () => settingsWith(servers) });
  try {
    const opened = await mgr.open('proj-1', 'mock-agent');
    const sessionId = /** @type {any} */ (opened).sessionId;
    assert.equal(typeof sessionId, 'string');
    const captured = await readCapture(capture);
    /* CS1（R30-124）：下发的必须是 **ACP 判别联合形状**，不是设置里的内部形状。
       以前期望值就是 `{name, command, args, env:{}}` —— 那正是 codex-acp 回
       `Invalid params` 的原因（`session/new` 的 mcpServers 按 `type` 分流）。 */
    assert.deepEqual(captured.params.mcpServers, [
      { type: 'stdio', name: 'alpha', command: '/bin/alpha', args: ['--a'], env: [{ name: 'A', value: '1' }] },
      { type: 'stdio', name: 'gamma', command: '/bin/gamma', args: ['--g', 'x'], env: [{ name: 'G', value: 'two' }] },
    ]);
    assert.equal(captured.params.cwd, dir);

    // 子进程 stdout 转录里不含 env 值（错误日志同样不得泄露）。
    const transcript = mgr.transcript(sessionId).join('\n');
    assert.ok(!transcript.includes('two'), 'transcript 不应包含 env 值');
    await mgr.close(sessionId);
  } finally {
    await mgr.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('ACP：设置读失败 → 会话照开，mcpServers 为空表', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-acp-mcp-'));
  const capture = path.join(dir, 'capture.json');
  const mgr = makeManager({
    capture,
    settingsProvider: async () => {
      throw new Error('settings unreadable');
    },
  });
  try {
    const opened = await mgr.open('proj-2', 'mock-agent');
    const sessionId = /** @type {any} */ (opened).sessionId;
    assert.equal(typeof sessionId, 'string');
    const captured = await readCapture(capture);
    assert.deepEqual(captured.params.mcpServers, []);
    await mgr.close(sessionId);
  } finally {
    await mgr.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('ACP：没有设置（无 mcp 分区）时是空表，而不是 undefined', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-acp-mcp-'));
  const capture = path.join(dir, 'capture.json');
  const mgr = makeManager({ capture, settingsProvider: async () => ({ playback: {} }) });
  try {
    const opened = await mgr.open('proj-3', 'mock-agent');
    const sessionId = /** @type {any} */ (opened).sessionId;
    assert.equal(typeof sessionId, 'string');
    const captured = await readCapture(capture);
    assert.ok(Array.isArray(captured.params.mcpServers));
    assert.deepEqual(captured.params.mcpServers, []);
    await mgr.close(sessionId);
  } finally {
    await mgr.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
