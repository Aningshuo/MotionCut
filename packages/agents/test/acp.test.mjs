import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AgentSessions, buildAgentEnv, redact } from '../acp.mjs';
import { PermissionBroker, assertNoBypassArgs, classifyToolRequest, isWriteAllowed } from '../permission.mjs';

const MOCK = new URL('../../../tests/fixtures/agents/mock-acp.mjs', import.meta.url).pathname;

/**
 * @param {string} mode
 * @param {{ turnTimeoutMs?: number }} [opts]
 */
function makeManager(mode, opts = {}) {
  /** @type {Record<string, string>} */
  const roots = {};
  const mgr = new AgentSessions({
    resolveProject: (projectId) => {
      const root = roots[projectId];
      if (!root) throw new Error(`unknown project ${projectId}`);
      return root;
    },
    command: process.execPath,
    args: [MOCK, '--mode', mode],
    turnTimeoutMs: opts.turnTimeoutMs ?? 5_000,
    cancelGraceMs: 500,
  });
  return { mgr, roots };
}

test('a config-only ACP client accepts the chosen model over stdio', async () => {
  const { mgr, roots } = makeManager('config-models');
  roots.sample = os.tmpdir();
  try {
    const opened = await mgr.open('sample', 'opencode');
    assert.ok('sessionId' in opened);
    assert.deepEqual(mgr.modelCatalog(opened.sessionId).map((model) => model.id), ['fast', 'edit']);
    assert.equal(await mgr.selectModel(opened.sessionId, 'edit', null), 'edit');
    await assert.rejects(mgr.selectModel(opened.sessionId, 'unknown', null), { code: 'MODEL_UNAVAILABLE' });
  } finally {
    await mgr.dispose();
  }
});

/**
 * 增量读取事件流，支持「先取到某事件再继续」。
 * @param {AsyncIterable<any>} iterable
 */
function makeReader(iterable) {
  /** @type {any[]} */
  const queue = [];
  /** @type {Array<(event: any) => void>} */
  const waiters = [];
  let ended = false;

  void (async () => {
    for await (const event of iterable) {
      const waiter = waiters.shift();
      if (waiter) waiter(event);
      else queue.push(event);
    }
    ended = true;
    for (const waiter of waiters.splice(0)) waiter(null);
  })();

  return {
    /**
     * @param {(event: any) => boolean} predicate
     * @param {number} [timeoutMs]
     */
    async take(predicate, timeoutMs = 8_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        while (queue.length > 0) {
          const event = queue.shift();
          if (predicate(event)) return event;
        }
        if (ended) return null;
        const remaining = Math.max(1, deadline - Date.now());
        const result = await new Promise((resolve) => {
          const timer = setTimeout(() => {
            const index = waiters.indexOf(onEvent);
            if (index >= 0) waiters.splice(index, 1);
            resolve(SYMBOL_TIMEOUT);
          }, remaining);
          /** @param {any} event */
          const onEvent = (event) => {
            clearTimeout(timer);
            resolve(event);
          };
          waiters.push(onEvent);
        });
        if (result === SYMBOL_TIMEOUT) throw new Error('event timeout');
        if (result === null) return null;
        if (predicate(result)) return result;
      }
    },
    /** 收集到 turn_end 为止（含）。 */
    async drainTurn(timeoutMs = 8_000) {
      /** @type {any[]} */
      const events = [];
      const end = await this.take((event) => {
        events.push(event);
        return event.type === 'turn_end';
      }, timeoutMs);
      if (!end) throw new Error('stream ended before turn_end');
      return events;
    },
  };
}

const SYMBOL_TIMEOUT = Symbol('timeout');

/**
 * @param {string} prefix
 * @returns {Promise<string>}
 */
async function tmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('P1 mock 正常一轮：text → turn_end(done)，无重复', async (t) => {
  const root = await tmpDir('acp-p1-');
  const { mgr, roots } = makeManager('normal');
  t.after(() => mgr.dispose());
  roots['proj-p1'] = root;
  const opened = await mgr.open('proj-p1', 'mock');
  assert.ok('sessionId' in opened, JSON.stringify(opened));

  const reader = makeReader(mgr.events(opened.sessionId));
  const sent = await mgr.send(opened.sessionId, 'hi');
  assert.ok('turnId' in sent);
  const events = await reader.drainTurn();

  assert.deepEqual(
    events.map((e) => e.type),
    ['text', 'text', 'turn_end'],
  );
  assert.equal(events[0].text + events[1].text, 'Hello world');
  assert.equal(events.at(-1).reason, 'done');
  assert.equal(events.at(-1).error, undefined);
  assert.equal(events.filter((e) => e.type === 'turn_end').length, 1);

  const inspect = mgr.inspect(opened.sessionId);
  assert.equal(inspect?.cwd, root);
  assert.equal(inspect?.descriptor.capabilities.images, true);
  await mgr.dispose();
});

test('P1 工具事件与 usage 规范化', async (t) => {
  const root = await tmpDir('acp-p1b-');
  const { mgr, roots } = makeManager('normal');
  t.after(() => mgr.dispose());
  roots['proj-p1b'] = root;
  const opened = await mgr.open('proj-p1b', 'mock');
  assert.ok('sessionId' in opened);
  const reader = makeReader(mgr.events(opened.sessionId));
  await mgr.send(opened.sessionId, 'TOOLS');
  const events = await reader.drainTurn();
  assert.deepEqual(
    events.map((e) => e.type),
    ['tool_start', 'tool_progress', 'tool_end', 'usage', 'text', 'turn_end'],
  );
  const end = events.find((e) => e.type === 'tool_end');
  assert.equal(end.ok, true);
  const usage = events.find((e) => e.type === 'usage');
  assert.equal(usage.inputTokens, 11);
  await mgr.dispose();
});

test('P2 权限请求默认拒绝，Agent 收到 deny', async (t) => {
  const root = await tmpDir('acp-p2-');
  const { mgr, roots } = makeManager('normal');
  t.after(() => mgr.dispose());
  roots['proj-p2'] = root;
  const opened = await mgr.open('proj-p2', 'mock');
  assert.ok('sessionId' in opened);
  const reader = makeReader(mgr.events(opened.sessionId));
  await mgr.send(opened.sessionId, 'PERMISSION');

  const permission = await reader.take((e) => e.type === 'permission');
  assert.equal(permission.request.kind, 'fs_write');
  assert.equal(permission.request.default, 'deny');

  const events = await reader.drainTurn();
  const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
  assert.equal(text, 'permission:deny');
  const toolEnd = events.find((e) => e.type === 'tool_end');
  assert.equal(toolEnd?.ok, false);
  await assert.rejects(fs.access(path.join(root, 'allowed.txt')), 'mock must not write when denied');
  await mgr.dispose();
});

test('P2 默认策略/放行参数/写入沙箱', async () => {
  const broker = new PermissionBroker();
  assert.equal(broker.mode, 'deny');
  assert.equal(await broker.decide({ kind: 'fs_write', detail: 'x', default: 'deny' }), 'deny');

  assert.throws(() => assertNoBypassArgs(['codex', '--allow-all']), /BYPASS_FLAG_REJECTED/);
  assert.throws(() => assertNoBypassArgs(['codex', '--yolo']), /BYPASS_FLAG_REJECTED/);
  assert.throws(() => assertNoBypassArgs(['codex', 'bypassPermissions']), /BYPASS_FLAG_REJECTED/);

  assert.equal(classifyToolRequest('edit_file', { path: 'a.html' }), 'fs_write');
  assert.equal(classifyToolRequest('search_files', {}), 'fs_read');
  assert.equal(classifyToolRequest('run_command', { cmd: 'ls' }), 'shell');

  const policy = {
    cwd: '/proj',
    allowWriteUnder: ['/proj'],
    denyWrite: ['/proj/.git', '/proj/.film'],
  };
  assert.deepEqual(isWriteAllowed(policy, '/proj/scenes/a.html'), { ok: true });
  assert.deepEqual(isWriteAllowed(policy, '/other/x'), { ok: false, reason: 'OUTSIDE_WORKSPACE' });
  assert.deepEqual(isWriteAllowed(policy, '/proj/.git/config'), { ok: false, reason: 'DENY_WRITE' });
});

test('P1 子进程 env 白名单：不含任何密钥', () => {
  const env = buildAgentEnv({
    PATH: '/usr/bin',
    HOME: '/Users/x',
    LANG: 'zh_CN.UTF-8',
    OPENAI_API_KEY: 'sk-should-not-leak',
    GITHUB_TOKEN: 'ghp_should_not_leak',
    CODEX_API_KEY: 'nope',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
  });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'PATH']);
  assert.equal(redact('Bearer abcdefg'), 'Bearer [REDACTED]');
});

test('P3 卡死 30s：TURN_TIMEOUT，进程被回收', async (t) => {
  const root = await tmpDir('acp-p3-');
  const { mgr, roots } = makeManager('normal', { turnTimeoutMs: 30_000 });
  t.after(() => mgr.dispose());
  roots['proj-p3'] = root;
  const opened = await mgr.open('proj-p3', 'mock');
  assert.ok('sessionId' in opened);
  const reader = makeReader(mgr.events(opened.sessionId));
  await mgr.send(opened.sessionId, 'HANG');

  const started = Date.now();
  const events = await reader.drainTurn(35_000);
  const elapsed = Date.now() - started;
  const end = events.at(-1);
  assert.equal(end.error, 'TURN_TIMEOUT');
  assert.equal(end.reason, 'error');
  assert.ok(elapsed >= 29_000, `timeout fired too early: ${elapsed}ms`);

  const pid = mgr.inspect(opened.sessionId)?.pid;
  assert.equal(typeof pid, 'number');
  await waitDead(/** @type {number} */ (pid));
  assert.equal(mgr.inspect(opened.sessionId)?.alive, false);
  await mgr.dispose();
});

test('P4 取消 running：500ms 内结束，不影响其它会话', async (t) => {
  const rootA = await tmpDir('acp-p4a-');
  const rootB = await tmpDir('acp-p4b-');
  const { mgr, roots } = makeManager('normal', { turnTimeoutMs: 10_000 });
  t.after(() => mgr.dispose());
  roots['proj-a'] = rootA;
  roots['proj-b'] = rootB;

  const a = await mgr.open('proj-a', 'mock');
  const b = await mgr.open('proj-b', 'mock');
  assert.ok('sessionId' in a && 'sessionId' in b);

  const readerA = makeReader(mgr.events(a.sessionId));
  const readerB = makeReader(mgr.events(b.sessionId));

  const sentA = await mgr.send(a.sessionId, 'CANCEL');
  const sentB = await mgr.send(b.sessionId, 'hi');
  assert.ok('turnId' in sentA && 'turnId' in sentB);

  await readerA.take((e) => e.type === 'text' && e.text === 'working');
  const t0 = Date.now();
  await mgr.cancel(a.sessionId, sentA.turnId);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 500, `cancel took ${elapsed}ms`);
  const endA = await readerA.take((e) => e.type === 'turn_end');
  assert.equal(endA.reason, 'cancelled');
  assert.equal(endA.error, 'TURN_CANCELLED');

  const eventsB = await readerB.drainTurn();
  assert.equal(eventsB.at(-1).reason, 'done');
  assert.equal(
    eventsB.filter((e) => e.type === 'text').map((e) => e.text).join(''),
    'Hello world',
  );
  await mgr.dispose();
});

test('P5 输出非 JSON：不崩宿主，错误码明确', async (t) => {
  const root = await tmpDir('acp-p5-');
  const { mgr, roots } = makeManager('normal');
  t.after(() => mgr.dispose());
  roots['proj-p5'] = root;
  const opened = await mgr.open('proj-p5', 'mock');
  assert.ok('sessionId' in opened);
  const reader = makeReader(mgr.events(opened.sessionId));
  await mgr.send(opened.sessionId, 'GARBAGE');
  const events = await reader.drainTurn(8_000);
  const end = events.at(-1);
  assert.ok(
    end.error === 'PROCESS_DIED' || end.error === 'AGENT_INCOMPATIBLE',
    `unexpected error code: ${end.error}`,
  );

  // 宿主仍可开新会话。
  const reopened = await mgr.open('proj-p5', 'mock');
  assert.ok('sessionId' in reopened);
  const reader2 = makeReader(mgr.events(reopened.sessionId));
  await mgr.send(reopened.sessionId, 'hi');
  const ok = await reader2.drainTurn();
  assert.equal(ok.at(-1).reason, 'done');
  await mgr.dispose();
});

test('P6 两工程并发：cwd 正确，事件不串流', async (t) => {
  const rootA = await tmpDir('acp-p6a-');
  const rootB = await tmpDir('acp-p6b-');
  const { mgr, roots } = makeManager('normal');
  t.after(() => mgr.dispose());
  roots['proj-a'] = rootA;
  roots['proj-b'] = rootB;

  const a = await mgr.open('proj-a', 'mock');
  const b = await mgr.open('proj-b', 'mock');
  assert.ok('sessionId' in a && 'sessionId' in b);

  const readerA = makeReader(mgr.events(a.sessionId));
  const readerB = makeReader(mgr.events(b.sessionId));
  await mgr.send(a.sessionId, 'ECHO_CWD');
  await mgr.send(b.sessionId, 'ECHO_CWD');

  const textA = await readerA.take((e) => e.type === 'text');
  const textB = await readerB.take((e) => e.type === 'text');
  const realA = await fs.realpath(rootA);
  const realB = await fs.realpath(rootB);
  assert.equal(textA.text, `cwd=${realA}`);
  assert.equal(textB.text, `cwd=${realB}`);
  assert.ok(!textA.text.includes(rootB));
  assert.ok(!textB.text.includes(rootA));
  assert.equal(mgr.inspect(a.sessionId)?.cwd, rootA);
  assert.equal(mgr.inspect(b.sessionId)?.cwd, rootB);

  await readerA.drainTurn();
  await readerB.drainTurn();
  await mgr.dispose();
});

/**
 * @param {number} pid
 */
async function waitDead(pid) {
  for (let i = 0; i < 40; i += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`process ${pid} still alive`);
}
