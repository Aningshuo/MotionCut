// 服务端 run 台账（R122 · M8-A · D08 / LI-A37）
//
// 这一批的「取消」是服务端语义，不再是前端 abort 一下就算完。台账本身是纯内存，
// 所以这一份测试**不启 Studio、不写盘**：直接把状态机的每条边跑一遍。
//
// 覆盖（任务书 A 的负向清单 + 状态机）：
//   ① 登记 / 查询 / 终态
//   ② 不存在 → 404（cancelHttp 与 cancel 两条路）
//   ③ 跨项目 → 403 且**不取消**（run 仍是 running）
//   ④ 跨会话 → 403 且不取消
//   ⑤ 重复取消 → 200 幂等（第二次 idempotent:true）
//   ⑥ finish 不覆盖终态；取消后的 run 不会被 done 洗回来
//   ⑦ abort 控制器被真的 abort（provider 能收到）
//   ⑧ 上限只淘汰终态，在跑的留下

import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRunError, MAX_RUNS, RUN_ID_RE, createAgentRuns } from '../agent-runs.mjs';

/** 取一条（测试里当 any 用：断言的是状态，不是类型）。 */
const snap = (/** @type {any} */ runs, /** @type {string} */ id) => /** @type {any} */ (runs.get(id));
/** 取消的 HTTP 回包（测试里按 any 读码）。 */
const bodyOf = (/** @type {any} */ out) => /** @type {any} */ (out.body);

/** @param {ReturnType<typeof createAgentRuns>} runs @param {string} runId */
function register(runs, runId, extra = {}) {
  return runs.register({ runId, projectId: 'p1', sessionId: 'saaaaaa1', generation: 1, ...extra });
}

test('① 登记 → running；查询给一份不含控制器的视图', () => {
  const runs = createAgentRuns({ now: () => 1700000000000 });
  const created = register(runs, 'run-1');
  assert.equal(created.state, 'running');
  assert.equal(created.generation, 1);
  assert.equal(runs.isCancelled('run-1'), false);
  const got = snap(runs, 'run-1');
  assert.equal(got.runId, 'run-1');
  assert.equal(got.projectId, 'p1');
  assert.equal(got.sessionId, 'saaaaaa1');
  assert.equal(got.terminal, false);
  assert.equal(got.createdAt, new Date(1700000000000).toISOString());
  /* 视图里没有 controller（那是内部句柄，不许从 HTTP 层漏出去）。 */
  assert.deepEqual(Object.keys(/** @type {any} */ (runs.list()[0])).includes('controller'), false);
});

test('①b（CS3 重写）终态实例不会被重试洗回 running；重载（换 pageId）= 新实例，旧实例留档', () => {
  const runs = createAgentRuns();
  const first = register(runs, 'run-2', { pageId: 'pg-aaaaaaaa' });
  runs.cancel('run-2', { projectId: 'p1', sessionId: 'saaaaaa1', pageId: 'pg-aaaaaaaa' });
  assert.equal(first.state, 'cancelled');
  /* 同一页面原样重放：仍是 409（不许借重试重跑）。 */
  assert.throws(
    () => register(runs, 'run-2', { pageId: 'pg-aaaaaaaa' }),
    (/** @type {any} */ error) => error.code === 'RUN_CANCELLED' && error.status === 409,
  );
  /* reload 后前端仍会发 run-1，但页面实例换了：必须开新实例，旧实例原样留档。 */
  const again = register(runs, 'run-2', { pageId: 'pg-bbbbbbbb' });
  assert.notEqual(again, first, '重载后重用同一 runId 必须开新实例');
  assert.equal(again.state, 'running');
  assert.ok(again.instance > first.instance);
  assert.equal(first.state, 'cancelled', '旧实例的状态不许被新实例洗掉');
  /* 旧实例迟到的 finish 不许把新实例写成 done。 */
  runs.finish(first, 'done');
  assert.equal(first.state, 'cancelled');
  assert.equal(again.state, 'running');
  assert.equal(runs.list().filter((row) => row.runId === 'run-2').length, 2);
});

test('①d 同一 runId、换了页面 → 顶替旧实例并真停旧控制器（重载后继续说话）', () => {
  const runs = createAgentRuns();
  const oldPage = register(runs, 'run-20', { pageId: 'pg-aaaaaaaa' });
  const oldController = new AbortController();
  runs.bindAbort(oldPage, oldController);
  const newPage = register(runs, 'run-20', { pageId: 'pg-bbbbbbbb' });
  assert.equal(oldPage.state, 'superseded');
  assert.equal(oldPage.reason, 'SUPERSEDED_BY_NEW_PAGE');
  assert.equal(oldPage.supersededBy, newPage.instance);
  assert.equal(oldController.signal.aborted, true, '顶替没有停掉旧回合的 provider');
  assert.equal(newPage.state, 'running');
  assert.equal(runs.isCurrent(oldPage), false);
  assert.equal(runs.isCurrent(newPage), true);
});

test('①e 旧页面的取消 → 409 RUN_STALE，**绝不动**新 run', () => {
  const runs = createAgentRuns();
  register(runs, 'run-21', { pageId: 'pg-aaaaaaaa' });
  runs.finish('run-21', 'done');
  register(runs, 'run-21', { pageId: 'pg-bbbbbbbb' });
  const stale = runs.cancelHttp('run-21', { project: 'p1', session: 'saaaaaa1', pageId: 'pg-aaaaaaaa' });
  assert.equal(stale.status, 409);
  assert.equal(bodyOf(stale).code, 'RUN_STALE');
  const rows = runs.list().filter((row) => row.runId === 'run-21');
  const newest = rows.at(-1);
  assert.ok(newest);
  assert.equal(newest.state, 'running', '旧页面的取消把新 run 停了');
});

test('①f 同一 runId 在两个工程里并存：取消 A 不动 B', () => {
  const runs = createAgentRuns();
  const a = register(runs, 'run-1', { projectId: 'p1', pageId: 'pg-aaaaaaaa' });
  const b = register(runs, 'run-1', { projectId: 'p2', pageId: 'pg-aaaaaaaa' });
  assert.notEqual(a, b);
  assert.equal(runs.isCurrent(a), true);
  assert.equal(runs.isCurrent(b), true);
  const out = runs.cancelHttp('run-1', { project: 'p1', pageId: 'pg-aaaaaaaa' });
  assert.equal(out.status, 200);
  assert.equal(a.state, 'cancelled');
  assert.equal(b.state, 'running', '跨工程串台了');
});

test('①g 断线只记 detachedAt：run 仍在跑、Stop 仍找得到', () => {
  const runs = createAgentRuns({ now: () => 1700000000000 });
  const row = register(runs, 'run-22', { pageId: 'pg-aaaaaaaa' });
  const detached = runs.detach('run-22', { projectId: 'p1', sessionId: 'saaaaaa1', pageId: 'pg-aaaaaaaa' });
  assert.equal(detached, row);
  assert.equal(row.state, 'running', '断线把 run 关了');
  assert.equal(row.detachedAt, new Date(1700000000000).toISOString());
  assert.equal(runs.isRowDetached(row), true);
  const out = runs.cancelHttp('run-22', { project: 'p1', session: 'saaaaaa1', pageId: 'pg-aaaaaaaa' });
  assert.equal(out.status, 200);
  assert.equal(out.body.cancelled, true);
  assert.equal(row.state, 'cancelled');
});

test('①c runId 形状不对 → 400 RUN_INVALID；缺 projectId 也 400', () => {
  const runs = createAgentRuns();
  assert.throws(
    () => runs.register({ runId: '', projectId: 'p1' }),
    (/** @type {any} */ error) => error instanceof AgentRunError && error.status === 400 && error.code === 'RUN_INVALID',
  );
  assert.throws(() => runs.register({ runId: 'a b', projectId: 'p1' }), (/** @type {any} */ error) => error.code === 'RUN_INVALID');
  assert.throws(() => runs.register(/** @type {any} */ ({ runId: 'run-3' })), (/** @type {any} */ error) => error.code === 'RUN_INVALID');
  assert.equal(RUN_ID_RE.test('run-12'), true);
  assert.equal(RUN_ID_RE.test('x'.repeat(65)), false, '超长 runId 不该放进来');
});

test('② 不存在的 run：cancel 抛 404；cancelHttp 回 404 且带码', () => {
  const runs = createAgentRuns();
  assert.throws(
    () => runs.cancel('run-none', { projectId: 'p1' }),
    (/** @type {any} */ error) => error instanceof AgentRunError && error.status === 404 && error.code === 'RUN_NOT_FOUND',
  );
  const out = runs.cancelHttp('run-none', { project: 'p1' });
  assert.equal(out.status, 404);
  assert.equal(bodyOf(out).ok, false);
  assert.equal(bodyOf(out).code, 'RUN_NOT_FOUND');
});

test('②b 缺 project → 400（不能凭 runId 就停别人的生成）', () => {
  const runs = createAgentRuns();
  register(runs, 'run-4');
  const out = runs.cancelHttp('run-4', {});
  assert.equal(out.status, 400);
  assert.equal(bodyOf(out).code, 'BAD_REQUEST');
  assert.equal(snap(runs, 'run-4').state, 'running', '400 之后 run 不许被动过');
});

test('③ 跨项目 → 403 RUN_FOREIGN_PROJECT，**不取消**', () => {
  const runs = createAgentRuns();
  register(runs, 'run-5', { projectId: 'p1' });
  const out = runs.cancelHttp('run-5', { project: 'p2' });
  assert.equal(out.status, 403);
  assert.equal(bodyOf(out).code, 'RUN_FOREIGN_PROJECT');
  assert.equal(bodyOf(out).runProject, 'p1');
  assert.equal(snap(runs, 'run-5').state, 'running', '越权取消把别人的 run 停了');
  assert.equal(runs.isCancelled('run-5'), false);
});

test('④ 跨会话 → 403 RUN_FOREIGN_SESSION，**不取消**；会话可省略', () => {
  const runs = createAgentRuns();
  register(runs, 'run-6', { projectId: 'p1', sessionId: 'saaaaaa1' });
  const wrong = runs.cancelHttp('run-6', { project: 'p1', session: 'sbbbbbb2' });
  assert.equal(wrong.status, 403);
  assert.equal(bodyOf(wrong).code, 'RUN_FOREIGN_SESSION');
  assert.equal(snap(runs, 'run-6').state, 'running');
  /* 不带 session = 只按工程判定（UI 的「停止」只知道当前会话，但会话可能为空）。 */
  const ok = runs.cancelHttp('run-6', { project: 'p1' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.cancelled, true);
});

test('⑤ 重复取消 → 200 幂等：第二次 idempotent:true 且状态仍是 cancelled', () => {
  const runs = createAgentRuns();
  register(runs, 'run-7');
  const first = runs.cancelHttp('run-7', { project: 'p1', session: 'saaaaaa1' });
  assert.equal(first.status, 200);
  assert.equal(bodyOf(first).cancelled, true);
  assert.equal(bodyOf(first).idempotent, false);
  const second = runs.cancelHttp('run-7', { project: 'p1', session: 'saaaaaa1' });
  assert.equal(second.status, 200);
  assert.equal(bodyOf(second).cancelled, true);
  assert.equal(bodyOf(second).idempotent, true);
  assert.equal(bodyOf(second).state, 'cancelled');
});

test('⑥ finish 不覆盖终态：取消后 done 洗不回来；正常结束是 done', () => {
  const runs = createAgentRuns();
  register(runs, 'run-8');
  runs.cancel('run-8', { projectId: 'p1' });
  runs.finish('run-8', 'done');
  assert.equal(snap(runs, 'run-8').state, 'cancelled', '取消被 done 覆盖了');

  register(runs, 'run-9');
  runs.finish('run-9', 'done');
  assert.equal(snap(runs, 'run-9').state, 'done');
  assert.equal(snap(runs, 'run-9').terminal, true);
  /* 已完成的 run 再取消：200 回执，但状态仍是 done，不算「取消成功」。 */
  const late = runs.cancelHttp('run-9', { project: 'p1' });
  assert.equal(late.status, 200);
  assert.equal(bodyOf(late).cancelled, false);
  assert.equal(bodyOf(late).state, 'done');

  register(runs, 'run-10');
  runs.finish('run-10', 'failed');
  assert.equal(snap(runs, 'run-10').state, 'failed');
});

test('⑦ 取消会 abort 绑定的控制器；unbind 之后不再动它', () => {
  const runs = createAgentRuns();
  register(runs, 'run-11');
  const controller = new AbortController();
  runs.bindAbort('run-11', controller);
  assert.equal(controller.signal.aborted, false);
  runs.cancel('run-11', { projectId: 'p1' });
  assert.equal(controller.signal.aborted, true, '取消没有真的停掉 provider');

  register(runs, 'run-12');
  const other = new AbortController();
  runs.bindAbort('run-12', other);
  runs.unbindAbort('run-12');
  runs.finish('run-12', 'done');
  assert.equal(other.signal.aborted, false, '已收尾的 run 不该被后来的动作 abort');
});

test('⑧ 上限只淘汰终态：在跑的留下，最旧的终态先走', () => {
  const runs = createAgentRuns({ maxRuns: 3 });
  register(runs, 'run-keep');
  register(runs, 'run-a');
  runs.finish('run-a', 'done');
  register(runs, 'run-b');
  runs.finish('run-b', 'done');
  register(runs, 'run-c'); // 4 条 > 3 → 淘汰最旧终态 run-a
  assert.equal(runs.size(), 3);
  assert.equal(snap(runs, 'run-keep').state, 'running', '在跑的 run 被淘汰了');
  assert.equal(snap(runs, 'run-a'), null, '最旧的终态应该先淘汰');
  assert.notEqual(snap(runs, 'run-b'), null);
  assert.notEqual(snap(runs, 'run-c'), null);
});

test('⑧b 全是 running 时不淘汰（宁可超上限，也不丢在跑的）', () => {
  const runs = createAgentRuns({ maxRuns: 2 });
  register(runs, 'run-x');
  register(runs, 'run-y');
  register(runs, 'run-z');
  assert.equal(runs.size(), 3);
  for (const id of ['run-x', 'run-y', 'run-z']) assert.equal(snap(runs, id).state, 'running');
});

test('⑨ 默认上限常量对外可见（交接里要能引用）', () => {
  assert.equal(MAX_RUNS, 200);
});
