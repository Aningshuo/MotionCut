/**
 * CS1（R30-124）：ACP 会话链路的两处断链回归。
 *
 * 1. `session/new` 的 `mcpServers` 是**判别联合**（`type: stdio|http|sse`），
 *    设设置里的内部形状（`{name, command, args, env:{}}`）直接下发会被对端拒成
 *    `Invalid params` —— 会话开不起来，且报错里看不出是哪一条。
 * 2. PermissionBroker 默认 `deny`，连产品自己的 `film_apply_ops` 也被拒：
 *    agent 的写盘永远走不到 MCP，审计里一条都没有。受控工具必须免问，其余照旧拒绝。
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { readMcpCapabilities, resolveCommandPath, toAcpMcpServers } from '../acp.mjs';
import { controlledToolPolicy } from '../codex-acp.mjs';
import { createToolGrant } from '../tool-grant.mjs';
import { PermissionBroker } from '../permission.mjs';

test('CS1 · mcpCapabilities 只认对端显式声明，缺失一律 false', () => {
  assert.deepEqual(readMcpCapabilities({ agentCapabilities: { mcpCapabilities: { acp: false, http: true } } }), {
    acp: false,
    http: true,
    sse: false,
  });
  assert.deepEqual(readMcpCapabilities({}), { acp: false, http: false, sse: false });
  // 真声明（codex-acp 2.5.0 实测）：acp 不支持、http 支持、sse 不支持
  assert.deepEqual(readMcpCapabilities({ agentCapabilities: { mcpCapabilities: { acp: false, http: true, sse: false } } }), {
    acp: false,
    http: true,
    sse: false,
  });
});

test('CS1 · 设置形状 → ACP 判别联合：带 type、env 转 [{name,value}]、保持顺序', () => {
  const { servers, skipped } = toAcpMcpServers([
    { name: 'opencut', command: '/usr/bin/node', args: ['x.mjs'], env: { A: '1' } },
    { name: 'remote', type: 'http', command: '', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'x' } },
  ]);
  assert.deepEqual(skipped, []);
  assert.deepEqual(servers, [
    { type: 'stdio', name: 'opencut', command: '/usr/bin/node', args: ['x.mjs'], env: [{ name: 'A', value: '1' }] },
    { type: 'http', name: 'remote', url: 'http://127.0.0.1:1/mcp', headers: [{ name: 'Authorization', value: 'x' }] },
  ]);
});

test('CS1 · 对端不支持的运输方式不硬塞（skip 记账，不静默）', () => {
  const caps = { acp: false, http: false, sse: false };
  const { servers, skipped } = toAcpMcpServers(
    [
      { name: 'doc', type: 'acp', serverId: 's1' },
      { name: 'web', type: 'http', url: 'http://x/y' },
      { name: 'stream', type: 'sse', url: 'http://x/s' },
      { name: 'local', command: '/bin/node', args: [] },
    ],
    { capabilities: caps },
  );
  assert.deepEqual(servers.map((server) => server.name), ['local']);
  assert.deepEqual(skipped, [
    { name: 'doc', reason: 'UNSUPPORTED_TRANSPORT:acp' },
    { name: 'web', reason: 'UNSUPPORTED_TRANSPORT:http' },
    { name: 'stream', reason: 'UNSUPPORTED_TRANSPORT:sse' },
  ]);
});

test('CS1 · 裸命令名按 PATH 解析成绝对路径，找不到就跳过并记账', () => {
  const pathEnv = `/definitely/not/here:${path.dirname(process.execPath)}`;
  assert.equal(resolveCommandPath(path.basename(process.execPath), pathEnv), process.execPath);
  assert.equal(resolveCommandPath('/custom/node', pathEnv), '/custom/node');
  assert.equal(resolveCommandPath('nope-not-a-binary', pathEnv), null);

  const { servers, skipped } = toAcpMcpServers([{ name: 'bare', command: 'nope-not-a-binary' }], { pathEnv });
  assert.deepEqual(servers, []);
  assert.deepEqual(skipped, [{ name: 'bare', reason: 'COMMAND_NOT_FOUND:nope-not-a-binary' }]);
});

test('CS2 · 没有票 = 一个工具都不放（CS1 的默认 4 工具白名单已收回）', () => {
  const policy = controlledToolPolicy();
  for (const tool of ['project_list', 'film_read', 'film_apply_ops', 'export_status', 'film_propose_ops']) {
    assert.equal(policy({ server: 'opencut', tool }).decision, 'deny', `${tool} 没有票就不该放行`);
  }
});

test('CS2 · 有票时只放票里的工具，且工程/会话/回合对得上', async () => {
  const grant = createToolGrant({
    tools: ['film_read', 'film_apply_ops'],
    projectId: 'proj',
    projectPath: '/tmp/cs2-test/proj',
    sessionId: 'sess-1',
    runId: 'run-1',
  });
  const policy = controlledToolPolicy(grant);
  assert.equal(policy({ server: 'opencut', tool: 'film_read' }, { args: { project: '/tmp/cs2-test/proj' }, requestId: 'turn-1' }).decision, 'allow');
  assert.equal(policy({ server: 'opencut', tool: 'export_status' }, { requestId: 'turn-1' }).decision, 'deny');
  assert.equal(policy({ server: 'opencut', tool: 'film_read' }, { args: { project: '/etc' }, requestId: 'turn-1' }).decision, 'deny');

  const broker = new PermissionBroker({ allowControl: policy });
  /** @type {any} */
  const request = { kind: 'other', detail: 'opencut/film_read', default: 'deny' };
  assert.equal(await broker.decide(request, { server: 'opencut', tool: 'film_read' }, { args: { project: '/tmp/cs2-test/proj' }, requestId: 't' }), 'allow');
  assert.equal(await broker.decide(request, { server: 'opencut', tool: 'export_status' }, { requestId: 't' }), 'deny');
  // 没有 allowControl 的老行为不变
  assert.equal(await new PermissionBroker().decide(request, { server: 'opencut', tool: 'film_read' }), 'deny');
});
