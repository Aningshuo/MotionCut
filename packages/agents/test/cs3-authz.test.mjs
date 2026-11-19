/**
 * CS3 · MAIN-CS3-AUTHZ：票的绑定与「没有 allow-all」。
 *
 * 与 `cs2-grant.test.mjs` 的分工：那份验「票本来怎么判」，这份验 **CS3 新加的三条**：
 *   1. 会话票出生时是**惰性**的（requestId = INERT_REQUEST_ID），绑到真实回合才生效；
 *   2. 真实目录（projectPath）与工程 id 是两把锁，任一不符都拒；
 *   3. allow-all / yolo / bypass 在构造期就炸，不留「静默降级」的口子。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PermissionPolicyError, PermissionBroker, assertNoBypassArgs } from '../permission.mjs';
import {
  INERT_REQUEST_ID,
  authorizeToolCall,
  bindToolGrant,
  createToolGrant,
} from '../tool-grant.mjs';
import { createGrantStore } from '../../studio/server/grants.mjs';

/** @param {string} name */
function makeProject(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs3-authz-'));
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return { root, dir: fs.realpathSync.native(dir) };
}

/** @param {any} project @param {any} [over] */
const grantOf = (project, over = {}) =>
  createToolGrant({
    tools: ['project_list', 'film_read', 'film_propose_ops', 'film_apply_ops'],
    projectId: 'proj-a',
    projectPath: project.dir,
    sessionId: 'sess-1',
    runId: 'run-1',
    ...over,
  });

test('CS3 · 会话票出生时是惰性的：没绑回合 → REQUEST_MISMATCH', () => {
  const project = makeProject('p1');
  const grant = grantOf(project, { requestId: INERT_REQUEST_ID });
  const denied = authorizeToolCall(grant, { server: 'opencut', tool: 'film_apply_ops' }, {
    args: { project: project.dir },
    cwd: project.dir,
    sessionId: 'sess-1',
    requestId: 'turn_1',
  });
  assert.equal(denied.decision, 'deny');
  assert.equal(denied.reason, 'REQUEST_MISMATCH');
  assert.equal(denied.hard, true);
});

test('CS3 · 绑到真实回合才生效；换一回合/不传回合都不行', () => {
  const project = makeProject('p2');
  const grant = grantOf(project, { requestId: INERT_REQUEST_ID });
  const bound = bindToolGrant(grant, { runId: 'run-2', requestId: 'turn_7' });
  assert.equal(bound.grantId, grant.grantId, 'grantId 不许变（MCP 手里还指着它）');
  assert.equal(bound.runId, 'run-2');
  assert.equal(bound.requestId, 'turn_7');

  /** @param {string | null} requestId */
  const ctx = (requestId) => ({ args: { project: project.dir }, cwd: project.dir, sessionId: 'sess-1', ...(requestId === null ? {} : { requestId }) });
  assert.equal(authorizeToolCall(bound, { server: 'opencut', tool: 'film_read' }, ctx('turn_7')).decision, 'allow');
  assert.equal(authorizeToolCall(bound, { server: 'opencut', tool: 'film_read' }, ctx('turn_8')).reason, 'REQUEST_MISMATCH');
  assert.equal(authorizeToolCall(bound, { server: 'opencut', tool: 'film_read' }, ctx(null)).reason, 'REQUEST_MISMATCH');
});

test('CS3 · 真实目录是第二把锁：id 对、路径不对也拒', () => {
  const project = makeProject('p3');
  const sibling = makeProject('p3-sibling');
  const grant = grantOf(project, { requestId: 'turn-1' });
  const record = authorizeToolCall(grant, { server: 'opencut', tool: 'film_read' }, {
    args: { project: project.dir },
    cwd: project.dir,
    requestId: 'turn-1',
    projectPath: sibling.dir,
  });
  assert.equal(record.decision, 'deny');
  assert.equal(record.reason, 'PROJECT_PATH_MISMATCH');
});

test('CS3 · grant store：bind / unbind / view 同一个 grantId', () => {
  const project = makeProject('p4');
  const store = createGrantStore();
  const issued = store.issue({
    tools: ['film_apply_ops'],
    projectId: 'proj-a',
    projectPath: project.dir,
    sessionId: 'sess-1',
    runId: 'run-1',
    requestId: INERT_REQUEST_ID,
  });
  const base = { projectId: 'proj-a', tool: 'film_apply_ops', projectPath: project.dir, sessionId: 'sess-1' };

  assert.equal(store.authorize(issued.grantId, { ...base, requestId: 'turn_1' }).ok, false);
  store.bind(issued.grantId, { runId: 'run-1', requestId: 'turn_1' });
  assert.equal(store.view(issued.grantId)?.requestId, 'turn_1');
  assert.equal(store.authorize(issued.grantId, { ...base, requestId: 'turn_1' }).ok, true);
  assert.equal(store.authorize(issued.grantId, { ...base, requestId: 'turn_2' }).ok, false);

  store.unbind(issued.grantId);
  const after = store.authorize(issued.grantId, { ...base, requestId: 'turn_1' });
  assert.equal(after.ok, false);
  assert.equal(after.code, 'REQUEST_MISMATCH');
  assert.equal((/** @type {any} */ (store.authorize(issued.grantId, { ...base, projectPath: '/tmp', requestId: 'turn_1' }))).code, 'PROJECT_PATH_MISMATCH');
});

test('CS3 · broker 不接受 allow-all / yolo / bypass（构造期就炸，不静默降级）', () => {
  for (const opts of [{ mode: 'allow' }, { allowAll: true }, { yolo: true }, { bypass: true }]) {
    assert.throws(
      () => new PermissionBroker(/** @type {any} */ (opts)),
      (error) => error instanceof PermissionPolicyError && error.code === 'BYPASS_FLAG_REJECTED',
      `opts=${JSON.stringify(opts)} 不该构造成功`,
    );
  }
  assert.equal(new PermissionBroker().mode, 'deny');
});

test('CS3 · 启动参数里的 bypass 开关被拒（含 codex 真名）', () => {
  for (const flag of ['--yolo', '--allow-all', '--bypass-permissions', '--dangerously-skip-permissions', '--dangerously-bypass-approvals-and-sandbox']) {
    assert.throws(
      () => assertNoBypassArgs([flag]),
      (error) => error instanceof PermissionPolicyError && error.code === 'BYPASS_FLAG_REJECTED',
      `flag=${flag} 不该被接受`,
    );
  }
  assert.doesNotThrow(() => assertNoBypassArgs(['--mode', 'normal']));
});
