/**
 * CS3 · MAIN-CS3-AUTHZ：真实工具权限卡的生存周期。
 *
 * 用 mock ACP 对端发真的 `session/request_permission`，验四件事：
 *   1. 待答复请求能被列出来（UI 的数据源），带工程 / 会话 / 明细 / 过期时间；
 *   2. 允许本次 → agent 收到 allow；同一请求**重复答复** = PERMISSION_ANSWERED；
 *   3. 超时 → 一律 deny；**迟到的答复不生效**（PERMISSION_EXPIRED）；
 *   4. 回合结束（Stop）时还没答的卡一律 deny，之后答复也不再生效。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AgentSessions } from '../acp.mjs';

const MOCK = new URL('../../../tests/fixtures/agents/mock-acp.mjs', import.meta.url).pathname;

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {string} prefix */
async function tmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function waitFor(/** @type {() => any} */ fn, { timeout = 6000, interval = 40, label = 'condition' } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    last = fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`超时等待：${label}`);
}

/** @param {string} root @param {{ permissionTimeoutMs?: number }} [opts] */
function makeManager(root, opts = {}) {
  /** @type {Record<string, string>} */
  const roots = { 'proj-perm': root };
  return new AgentSessions({
    resolveProject: (projectId) => roots[projectId] ?? '',
    command: process.execPath,
    args: [MOCK, '--mode', 'normal'],
    turnTimeoutMs: 10_000,
    cancelGraceMs: 500,
    permissionUi: true,
    permissionTimeoutMs: opts.permissionTimeoutMs ?? 900,
  });
}

/** @param {AgentSessions} mgr @param {string} sessionId @param {any[]} events */
function pump(mgr, sessionId, events) {
  return (async () => {
    for await (const event of mgr.events(sessionId)) {
      events.push(event);
      if (event.type === 'turn_end') break;
    }
  })();
}

const textOf = (/** @type {any[]} */ events) =>
  events.filter((event) => event.type === 'text').map((event) => String(event.text)).join('');

test('CS3 · 真权限卡：允许本次生效，重复答复 = PERMISSION_ANSWERED', async (t) => {
  const root = await tmpDir('cs3-perm-allow-');
  const mgr = makeManager(root);
  t.after(() => mgr.dispose());
  const opened = await mgr.open('proj-perm', 'mock');
  if (!('sessionId' in opened)) throw new Error('会话没开出来');
  const sessionId = opened.sessionId;

  /** @type {any[]} */
  const events = [];
  const running = pump(mgr, sessionId, events);
  await mgr.send(sessionId, 'PERMISSION');

  const pending = await waitFor(() => mgr.listPermissions()[0] ?? null, { label: 'pending permission' });
  assert.equal(pending.projectId, 'proj-perm');
  assert.equal(pending.sessionId, sessionId);
  assert.equal(pending.subject, null, '这条不是我们自己的 MCP 工具，没有机器可读身份');
  assert.ok(String(pending.detail).includes('intro.html'));
  assert.ok(pending.remainingMs > 0);

  const allow = mgr.answerPermission(sessionId, pending.id, 'allow');
  assert.equal(allow.ok, true);
  const duplicate = mgr.answerPermission(sessionId, pending.id, 'deny');
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, 'PERMISSION_ANSWERED');

  await running;
  assert.equal(textOf(events), 'permission:allow');
  const state = mgr.inspect(sessionId);
  assert.equal(state?.permissions.length, 0, '答过之后不该还挂着');
  assert.equal(state?.permissionLog.at(-1)?.state, 'answered');
});

test('CS3 · 超时一律 deny，迟到的答复不生效', async (t) => {
  const root = await tmpDir('cs3-perm-timeout-');
  const mgr = makeManager(root, { permissionTimeoutMs: 500 });
  t.after(() => mgr.dispose());
  const opened = await mgr.open('proj-perm', 'mock');
  if (!('sessionId' in opened)) throw new Error('会话没开出来');
  const sessionId = opened.sessionId;

  /** @type {any[]} */
  const events = [];
  const running = pump(mgr, sessionId, events);
  await mgr.send(sessionId, 'PERMISSION');
  const pending = await waitFor(() => mgr.listPermissions()[0] ?? null, { label: 'pending (timeout)' });
  await sleep(800);
  assert.equal(mgr.listPermissions().length, 0, '超时后不该还挂着');

  const late = mgr.answerPermission(sessionId, pending.id, 'allow');
  assert.equal(late.ok, false);
  assert.equal(late.code, 'PERMISSION_EXPIRED');

  await running;
  assert.equal(textOf(events), 'permission:deny', '超时必须是 deny，不许放行');
});

test('CS3 · 取消 = deny（不是 allow），也不写文件', async (t) => {
  const root = await tmpDir('cs3-perm-cancel-');
  const mgr = makeManager(root);
  t.after(() => mgr.dispose());
  const opened = await mgr.open('proj-perm', 'mock');
  if (!('sessionId' in opened)) throw new Error('会话没开出来');
  const sessionId = opened.sessionId;

  /** @type {any[]} */
  const events = [];
  const running = pump(mgr, sessionId, events);
  await mgr.send(sessionId, 'PERMISSION');
  const pending = await waitFor(() => mgr.listPermissions()[0] ?? null, { label: 'pending (cancel)' });

  const cancelled = mgr.answerPermission(sessionId, pending.id, 'cancel');
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.decision, 'deny');

  await running;
  assert.equal(textOf(events), 'permission:deny');
  const exists = await fs.stat(path.join(root, 'allowed.txt')).then(() => true).catch(() => false);
  assert.equal(exists, false, '取消不许写 allowed.txt');
});

test('CS3 · 回合结束（Stop）时挂着的卡一律 deny，之后答复也不再生效', async (t) => {
  const root = await tmpDir('cs3-perm-turnend-');
  const mgr = makeManager(root, { permissionTimeoutMs: 5_000 });
  t.after(() => mgr.dispose());
  const opened = await mgr.open('proj-perm', 'mock');
  if (!('sessionId' in opened)) throw new Error('会话没开出来');
  const sessionId = opened.sessionId;

  /** @type {any[]} */
  const events = [];
  const running = pump(mgr, sessionId, events);
  const sent = await mgr.send(sessionId, 'PERMISSION');
  if (!('turnId' in sent)) throw new Error('回合没发出去');
  const pending = await waitFor(() => mgr.listPermissions()[0] ?? null, { label: 'pending (turn end)' });

  await mgr.cancel(sessionId, sent.turnId);
  await waitFor(() => mgr.listPermissions().length === 0, { label: 'pending flushed' });
  const late = mgr.answerPermission(sessionId, pending.id, 'allow');
  assert.equal(late.ok, false);
  assert.equal(late.code, 'PERMISSION_ANSWERED', '回合结束算一次终态：再答就是重复答复');

  await running;
  /* 取消时对端会立刻结束回合，`permission:deny` 那句文本可能来不及产出；
     真正要证的是**裁决记录**：这一条以 deny / TURN_ENDED 收尾，而且没写文件。 */
  const state = mgr.inspect(sessionId);
  const logged = state?.permissionLog.find((row) => row.id === pending.id);
  assert.equal(logged?.decision, 'deny');
  assert.equal(logged?.reason, 'TURN_ENDED');
  const exists = await fs.stat(path.join(root, 'allowed.txt')).then(() => true).catch(() => false);
  assert.equal(exists, false, '回合结束时挂着的卡不许放行');
});
