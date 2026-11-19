/**
 * CS2 · R30-125：授权真的接在 ACP 层。
 *
 * `cs2-grant.test.mjs` 验的是「票本身怎么判」；这里验的是「ACP 的权限请求有没有
 * 走到这张票上」—— 用 mock 适配器发一个 MCP 形状的 `session/request_permission`：
 *
 * - 票对得上（server/tool/工程/会话）→ allow，authz 记录带 grantId 与 toolCallId；
 * - 票是另一个工程的 → deny `PROJECT_MISMATCH`，agent 收到 deny。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AgentSessions } from '../acp.mjs';
import { authorizeToolCall, createToolGrant } from '../tool-grant.mjs';

const MOCK = new URL('../../../tests/fixtures/agents/mock-acp.mjs', import.meta.url).pathname;

/** @param {string} prefix */
async function tmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * @param {string} root
 * @param {{ projectPath?: string }} [opts]
 */
function makeManager(root, opts = {}) {
  /** @type {Record<string, string>} */
  const roots = { 'proj-cs2': root };
  /** @type {{ grant: any }} */
  const box = { grant: null };
  const mgr = new AgentSessions({
    resolveProject: (projectId) => roots[projectId] ?? '',
    command: process.execPath,
    args: [MOCK, '--mode', 'normal'],
    turnTimeoutMs: 8_000,
    cancelGraceMs: 300,
    /* 第一次裁决时才拿到会话 id —— 票必须在那一刻按**这个会话**签发。 */
    authorize: (subject, context) => {
      if (box.grant === null) {
        box.grant = createToolGrant({
          tools: ['film_apply_ops'],
          projectId: 'proj-cs2',
          projectPath: opts.projectPath ?? root,
          sessionId: String(context.sessionId),
          runId: 'run-cs2',
        });
      }
      return authorizeToolCall(box.grant, subject, context);
    },
  });
  return { mgr, box };
}

test('CS2 · ACP 权限请求按票放行：记录带 grantId / 工程 / toolCallId', async (t) => {
  const root = await tmpDir('cs2-acp-ok-');
  const { mgr, box } = makeManager(root);
  t.after(() => mgr.dispose());
  const opened = await mgr.open('proj-cs2', 'mock');
  assert.ok('sessionId' in opened);
  if (!('sessionId' in opened)) throw new Error('session 没开出来');

  /** @type {any[]} */
  const events = [];
  const pump = (async () => {
    for await (const event of mgr.events(opened.sessionId)) {
      events.push(event);
      if (event.type === 'turn_end') break;
    }
  })();
  await mgr.send(opened.sessionId, 'MCP_PERMISSION');
  await pump;

  const permission = events.find((event) => event.type === 'permission');
  assert.ok(permission, '必须有 permission 事件');
  assert.equal(permission.subject.server, 'opencut');
  assert.equal(permission.subject.tool, 'film_apply_ops');
  assert.equal(permission.authz.decision, 'allow');
  assert.equal(permission.authz.source, `grant:${box.grant.grantId}`);
  assert.equal(permission.authz.projectId, 'proj-cs2');
  assert.equal(permission.authz.sessionId, opened.sessionId);
  assert.equal(permission.authz.toolCallId, 'tc-mcp-1');
  assert.equal(typeof permission.authz.requestId, 'string');

  const text = events.filter((event) => event.type === 'text').map((event) => event.text).join('');
  assert.equal(text, 'permission:allow');

  const inspected = /** @type {any} */ (mgr.inspect(opened.sessionId));
  assert.equal(inspected.authz.length, 1);
  assert.equal(inspected.authz[0].decision, 'allow');
});

test('CS2 · 票绑的是别的工程 → deny PROJECT_MISMATCH，agent 收到 deny', async (t) => {
  const root = await tmpDir('cs2-acp-deny-');
  const other = await tmpDir('cs2-acp-other-');
  const { mgr, box } = makeManager(root, { projectPath: other });
  t.after(() => mgr.dispose());
  const opened = await mgr.open('proj-cs2', 'mock');
  if (!('sessionId' in opened)) throw new Error('session 没开出来');

  /** @type {any[]} */
  const events = [];
  const pump = (async () => {
    for await (const event of mgr.events(opened.sessionId)) {
      events.push(event);
      if (event.type === 'turn_end') break;
    }
  })();
  await mgr.send(opened.sessionId, 'MCP_PERMISSION');
  await pump;

  const permission = events.find((event) => event.type === 'permission');
  assert.equal(permission.authz.decision, 'deny');
  assert.equal(permission.authz.reason, 'PROJECT_MISMATCH');
  assert.equal(permission.authz.hard, true);
  const text = events.filter((event) => event.type === 'text').map((event) => event.text).join('');
  assert.equal(text, 'permission:deny');
  assert.equal(box.grant.projectId, 'proj-cs2');
});
