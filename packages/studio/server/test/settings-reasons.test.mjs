/**
 * M80 · `PUT /api/settings` 的 `reason` 契约（B-MAIN-R30-039）。
 *
 * 副线1 的设置面板要按原因给不同修复建议（「名字不合规」vs「重名」是两种改法），
 * 但以前错误体只有 `code + message`。这里钉住三件事：
 * 1. 七种口径各有一个**固定枚举**值（NAME_PATTERN / DUPLICATE_NAME / TOO_MANY_SERVERS /
 *    ARGS_NOT_ARRAY / ENV_VALUE_NOT_STRING / UNKNOWN_FIELD / COMMAND_EMPTY）；
 * 2. 错误体形状固定：`{ok:false, code, field, reason, message}`（HTTP 真实往返，不是只测函数）；
 * 3. 成功写入**没有** `reason` 字段（别让 UI 把成功也当失败分支）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { startStudio } from '../studio-server.mjs';
import {
  MCP_MAX_SERVERS,
  MCP_SERVER_NAME_PATTERN,
  SETTINGS_ERROR_REASONS,
  applySettingsPatch,
  defaultSettings,
} from '../settings-store.mjs';

/** @param {any} [overrides] @returns {any} */
function server(overrides = {}) {
  return {
    name: 'local-tools',
    command: '/usr/bin/node',
    args: ['server.mjs'],
    env: { MCP_TOKEN: 's3cr3t-value' },
    enabled: true,
    ...overrides,
  };
}

/** @param {any} patch @returns {any} */
function apply(patch) {
  return applySettingsPatch(patch, defaultSettings());
}

test('R1 非法 name → reason=NAME_PATTERN（文案不变）', () => {
  const result = apply({ mcp: { servers: [server({ name: 'Bad Name' })] } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'NAME_PATTERN');
  assert.equal(result.field, 'mcp.servers[0].name');
  assert.equal(result.message, `mcp.servers[0].name 必须匹配 ${MCP_SERVER_NAME_PATTERN.source}`);
  assert.ok(SETTINGS_ERROR_REASONS.includes(result.reason));
});

test('R2 重名 → reason=DUPLICATE_NAME', () => {
  const result = apply({ mcp: { servers: [server({ name: 'dup' }), server({ name: 'dup' })] } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'DUPLICATE_NAME');
  assert.equal(result.field, 'mcp.servers[1].name');
});

test('R3 超条数 → reason=TOO_MANY_SERVERS', () => {
  const list = Array.from({ length: MCP_MAX_SERVERS + 1 }, (_, index) => server({ name: `s-${index}` }));
  const result = apply({ mcp: { servers: list } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'TOO_MANY_SERVERS');
  assert.equal(result.field, 'mcp.servers');
  assert.deepEqual(result.allowed, [0, MCP_MAX_SERVERS]);
});

test('R4 args 非数组 → reason=ARGS_NOT_ARRAY', () => {
  for (const args of ['nope', [1], [null]]) {
    const result = apply({ mcp: { servers: [server({ args })] } });
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.equal(result.reason, 'ARGS_NOT_ARRAY');
    assert.equal(result.field, 'mcp.servers[0].args');
  }
});

test('R5 env 值非字符串 → reason=ENV_VALUE_NOT_STRING，且不回显值', () => {
  const result = apply({ mcp: { servers: [server({ env: { MCP_TOKEN: 12345 } })] } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ENV_VALUE_NOT_STRING');
  assert.equal(result.field, 'mcp.servers[0].env.MCP_TOKEN');
  assert.ok(!JSON.stringify(result).includes('12345'));
});

test('R6 未知字段 → reason=UNKNOWN_FIELD（条目内与分区内都指到路径）', () => {
  const item = apply({ mcp: { servers: [{ ...server(), foo: 1 }] } });
  assert.equal(item.reason, 'UNKNOWN_FIELD');
  assert.equal(item.field, 'mcp.servers[0].foo');

  const section = apply({ mcp: { nope: true } });
  assert.equal(section.reason, 'UNKNOWN_FIELD');
  assert.equal(section.field, 'mcp.nope');
});

test('R7 command 空/缺失 → reason=COMMAND_EMPTY', () => {
  for (const command of [undefined, '', '   ']) {
    const result = apply({ mcp: { servers: [server({ command })] } });
    assert.equal(result.ok, false, String(command));
    assert.equal(result.reason, 'COMMAND_EMPTY');
    assert.equal(result.field, 'mcp.servers[0].command');
  }
});

test('R8 合法写入：没有 reason 字段（也不该有）', () => {
  const result = apply({ mcp: { servers: [server()] } });
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result, 'reason'), false);
  assert.equal(Object.hasOwn(result, 'field'), false);

  const playback = apply({ playback: { volume: 40 } });
  assert.equal(playback.ok, true);
  assert.equal(Object.hasOwn(playback, 'reason'), false);
});

test('R9 所有失败路径的 reason 都在固定枚举里（形状统一）', () => {
  /** @type {any[]} */
  const bad = [
    null,
    [],
    { nope: {} },
    { mcp: 'x' },
    { mcp: { servers: 'x' } },
    { mcp: { servers: [null] } },
    { mcp: { servers: [server({ env: 'x' })] } },
    { mcp: { servers: [server({ enabled: 'yes' })] } },
    { playback: { volume: 101 } },
    { playback: { loop: 'yes' } },
    { export: { fps: 29.97 } },
    { export: { codec: 'av1' } },
    { export: { last: { fps: 'x' } } },
  ];
  for (const patch of bad) {
    const result = apply(patch);
    assert.equal(result.ok, false, JSON.stringify(patch));
    assert.equal(typeof result.reason, 'string', JSON.stringify(patch));
    assert.ok(SETTINGS_ERROR_REASONS.includes(result.reason), `${JSON.stringify(patch)} → ${result.reason}`);
    assert.equal(typeof result.field, 'string');
    assert.equal(typeof result.message, 'string');
  }
});

test('R10 HTTP：PUT /api/settings 的错误体是五键固定形状', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-reasons-'));
  const previous = process.env.OPENCUT_SETTINGS;
  process.env.OPENCUT_SETTINGS = path.join(root, 'settings.json');
  const studio = await startStudio({ port: 0, vitePort: 0, home: root, projectsRoot: root, logger: () => {} });
  /** @param {any} body */
  const put = async (body) => {
    const response = await fetch(`${studio.url}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  try {
    /** @type {{patch: any, reason: string, field: string}[]} */
    const cases = [
      { patch: { mcp: { servers: [server({ name: 'Bad' })] } }, reason: 'NAME_PATTERN', field: 'mcp.servers[0].name' },
      { patch: { mcp: { servers: [server({ name: 'dup' }), server({ name: 'dup' })] } }, reason: 'DUPLICATE_NAME', field: 'mcp.servers[1].name' },
      {
        patch: { mcp: { servers: Array.from({ length: MCP_MAX_SERVERS + 1 }, (_, index) => server({ name: `h-${index}` })) } },
        reason: 'TOO_MANY_SERVERS',
        field: 'mcp.servers',
      },
      { patch: { mcp: { servers: [server({ args: 'x' })] } }, reason: 'ARGS_NOT_ARRAY', field: 'mcp.servers[0].args' },
      { patch: { mcp: { servers: [server({ env: { A: 1 } })] } }, reason: 'ENV_VALUE_NOT_STRING', field: 'mcp.servers[0].env.A' },
      { patch: { mcp: { servers: [{ ...server(), foo: 1 }] } }, reason: 'UNKNOWN_FIELD', field: 'mcp.servers[0].foo' },
      { patch: { mcp: { servers: [server({ command: '' })] } }, reason: 'COMMAND_EMPTY', field: 'mcp.servers[0].command' },
    ];
    for (const item of cases) {
      const result = await put(item.patch);
      assert.equal(result.status, 400, item.reason);
      const body = result.body;
      assert.equal(body.ok, false, item.reason);
      assert.equal(body.reason, item.reason);
      assert.equal(body.field, item.field);
      assert.equal(typeof body.code, 'string');
      assert.equal(typeof body.message, 'string');
      // 五键必须都在（allowed 是既有字段，保留）
      for (const key of ['ok', 'code', 'field', 'reason', 'message']) {
        assert.ok(Object.hasOwn(body, key), `${item.reason} 缺少 ${key}`);
      }
      assert.equal(body.field === null, false);
    }

    const ok = await put({ mcp: { servers: [server()] } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.equal(Object.hasOwn(ok.body, 'reason'), false);
  } finally {
    await studio.close();
    if (previous === undefined) delete process.env.OPENCUT_SETTINGS;
    else process.env.OPENCUT_SETTINGS = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
