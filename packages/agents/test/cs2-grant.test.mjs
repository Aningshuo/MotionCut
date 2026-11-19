/**
 * CS2 · R30-125：受控工具授权。
 *
 * 这组断言只回答一件事：**一张票能覆盖什么、不能覆盖什么**。
 * 判据都从 `authorizeToolCall()` 的记录读，不从「意图」推。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GrantError, authorizeToolCall, createToolGrant, grantAuthorizer, resolveGrantedProject } from '../tool-grant.mjs';

/** 造一个真实存在的工程目录（grant 会 realpath）。 */
function makeProject(/** @type {string} */ name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs2-grant-'));
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return { root, dir: fs.realpathSync.native(dir) };
}

const grantOf = (/** @type {any} */ project, /** @type {any} */ over = {}) =>
  createToolGrant({
    tools: ['project_list', 'film_read', 'film_propose_ops', 'film_apply_ops', 'export_status'],
    projectId: 'proj-a',
    projectPath: project.dir,
    sessionId: 'sess-1',
    runId: 'run-1',
    ...over,
  });

test('CS2 · 没有票：一律 default-deny，且不硬拒（留给 deny/ask 模式）', () => {
  const record = authorizeToolCall(null, { server: 'opencut', tool: 'film_apply_ops' }, { args: { project: '/x/y' } });
  assert.equal(record.decision, 'deny');
  assert.equal(record.reason, 'NO_GRANT');
  assert.equal(record.source, 'default-deny');
  assert.equal(record.hard, false, '没有票不是「这张票被拒」，是「根本没有票」');
  assert.equal(record.grantId, null);
});

test('CS2 · 通配/空表/未知工具在签发时就被拒（不得 allow-all）', () => {
  const project = makeProject('p1');
  for (const tools of [['*'], ['all'], ['film_read', '*'], []]) {
    assert.throws(
      () => grantOf(project, { tools }),
      (error) => error instanceof GrantError,
      `tools=${JSON.stringify(tools)} 不该签发成功`,
    );
  }
  assert.throws(() => grantOf(project, { tools: ['shell'] }), /不是可授权的受控工具/);
});

test('CS2 · 票绑定工程目录：同名/父目录/子目录/相对名都不算', () => {
  const project = makeProject('p2');
  const sibling = makeProject('p2-sibling');
  const grant = grantOf(project);
  const context = (/** @type {string} */ p) => ({ args: { project: p }, cwd: project.dir, requestId: 'turn-1', toolCallId: 'call-1' });

  assert.equal(authorizeToolCall(grant, { server: 'opencut', tool: 'film_read' }, context(project.dir)).decision, 'allow');
  assert.equal(authorizeToolCall(grant, { server: 'opencut', tool: 'film_read' }, context('p2')).decision, 'allow', '裸工程名直接命中授权目录');
  assert.equal(authorizeToolCall(grant, { server: 'opencut', tool: 'film_read' }, context('.')).decision, 'allow');

  const siblingRecord = authorizeToolCall(grant, { server: 'opencut', tool: 'film_read' }, context(sibling.dir));
  assert.equal(siblingRecord.decision, 'deny');
  assert.equal(siblingRecord.reason, 'PROJECT_MISMATCH');

  assert.equal(authorizeToolCall(grant, { server: 'opencut', tool: 'film_read' }, context(path.dirname(project.dir))).reason, 'PROJECT_MISMATCH');
  assert.equal(authorizeToolCall(grant, { server: 'opencut', tool: 'film_read' }, context(path.join(project.dir, 'sub'))).reason, 'PROJECT_MISMATCH');
  assert.equal(authorizeToolCall(grant, { server: 'opencut', tool: 'film_read' }, context('../p2')).decision, 'allow', '../p2 解析回同一个目录');
  assert.equal(authorizeToolCall(grant, { server: 'opencut', tool: 'film_read' }, context('../p2-sibling')).reason, 'PROJECT_MISMATCH');
  assert.equal(authorizeToolCall(grant, { server: 'opencut', tool: 'film_read' }, { args: {}, cwd: project.dir }).reason, 'PROJECT_REQUIRED');
});

test('CS2 · 票绑定 server / 工具 / 会话 / 回合 / 过期', () => {
  const project = makeProject('p3');
  let now = 1_000_000;
  const grant = grantOf(project, { now: () => now, ttlMs: 5_000, requestId: 'turn-A' });
  const ctx = { args: { project: project.dir }, cwd: project.dir, requestId: 'turn-A', now: () => now };

  assert.equal(authorizeToolCall(grant, { server: 'evil', tool: 'film_read' }, ctx).reason, 'SERVER_MISMATCH');
  assert.equal(authorizeToolCall(grant, { server: 'opencut', tool: 'rm_rf' }, ctx).reason, 'TOOL_NOT_GRANTED');
  assert.equal(authorizeToolCall(grant, { server: 'opencut', tool: 'film_read' }, { ...ctx, requestId: 'turn-B' }).reason, 'REQUEST_MISMATCH');

  now += 5_001;
  const expired = authorizeToolCall(grant, { server: 'opencut', tool: 'film_read' }, { ...ctx, now: () => now });
  assert.equal(expired.reason, 'GRANT_EXPIRED');
  assert.equal(expired.decision, 'deny');
});

test('CS2 · 每条记录都能回答「凭哪张票、对哪个工程、哪一回合、哪个调用」', () => {
  const project = makeProject('p4');
  const grant = grantOf(project);
  const record = authorizeToolCall(
    grant,
    { server: 'opencut', tool: 'film_apply_ops' },
    { args: { project: project.dir }, cwd: project.dir, requestId: 'turn-9', toolCallId: 'call-9' },
  );
  assert.equal(record.decision, 'allow');
  assert.equal(record.source, `grant:${grant.grantId}`);
  assert.equal(record.grantId, grant.grantId);
  assert.equal(record.projectId, 'proj-a');
  assert.equal(record.projectPath, project.dir);
  assert.equal(record.sessionId, 'sess-1');
  assert.equal(record.runId, 'run-1');
  assert.equal(record.requestId, 'turn-9');
  assert.equal(record.toolCallId, 'call-9');
  assert.equal(record.server, 'opencut');
  assert.equal(record.tool, 'film_apply_ops');
  assert.equal(typeof record.at, 'number');
});

test('CS2 · grantAuthorizer 与 broker 的接线：票不认时回 false，不越权放行', async () => {
  const project = makeProject('p5');
  const grant = grantOf(project);
  const authorize = grantAuthorizer(grant);
  assert.equal(authorize({ server: 'opencut', tool: 'film_read' }, { args: { project: project.dir } }).decision, 'allow');
  const denied = authorize({ server: 'opencut', tool: 'film_read' }, { args: { project: '/etc' } });
  assert.equal(denied.decision, 'deny');
  assert.equal(denied.hard, true);
});

test('CS2 · resolveGrantedProject：不存在的路径按 resolve 结果比较，不做前缀匹配', () => {
  const project = makeProject('p6');
  const resolved = resolveGrantedProject('nope', project.dir);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.path, path.join(project.dir, 'nope'));
  assert.notEqual(resolved.path, project.dir);
});
