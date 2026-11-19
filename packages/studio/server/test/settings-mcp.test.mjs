/**
 * M65-WP20-SETTINGS-MCP-SCHEMA 的服务端单测（B-MAIN-R30-032）。
 *
 * 守的是一条链：
 *   设置里的 `mcp.servers` 是**唯一真源** → PUT 严格校验（指到具体路径）→
 *   原子写 + 回读 → 读回时坏条目只丢自己 → `mcpServersForSettings` 只映射 enabled 的项。
 *
 * 另有三条硬边界：
 * - `env` 值**不出现在任何错误消息**里（错误可能被截图/贴进工单）；
 * - 旧 `mcp.json` 只检测存在性，**不读内容、不双写**；
 * - 坏 JSON 仍然「改名留证据、不覆盖」。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  MCP_MAX_SERVERS,
  MCP_SERVER_NAME_PATTERN,
  SETTINGS_DEFAULTS,
  applySettingsPatch,
  checkMcpServerEntry,
  defaultSettings,
  legacyMcpExists,
  legacyMcpPath,
  mcpServersForSettings,
  normalizeSettings,
  readSettings,
  writeSettings,
} from '../settings-store.mjs';

/**
 * @param {(ctx: {dir: string, file: string}) => Promise<void>} fn
 */
async function withSettingsDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-mcp-settings-'));
  const previous = process.env.OPENCUT_SETTINGS;
  process.env.OPENCUT_SETTINGS = path.join(dir, 'settings.json');
  try {
    await fn({ dir, file: process.env.OPENCUT_SETTINGS });
  } finally {
    if (previous === undefined) delete process.env.OPENCUT_SETTINGS;
    else process.env.OPENCUT_SETTINGS = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * 一条合法 server。
 * @param {any} [overrides]
 * @returns {any}
 */
function server(overrides = {}) {
  return {
    name: 'local-tools',
    command: '/usr/bin/node',
    args: ['server.mjs', '--stdio'],
    env: { MCP_TOKEN: 's3cr3t-value' },
    enabled: true,
    ...overrides,
  };
}

test('默认值：mcp.servers 是空数组，且不是共享引用', () => {
  assert.deepEqual(defaultSettings().mcp, { servers: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(SETTINGS_DEFAULTS)).mcp, { servers: [] });
  const a = defaultSettings();
  const b = defaultSettings();
  assert.notEqual(a.mcp.servers, b.mcp.servers);
  a.mcp.servers.push(server());
  assert.deepEqual(b.mcp.servers, []);
});

test('合法写入：PUT → 原子写 → 回读逐字段相等（args/env/enabled 原样）', async () => {
  await withSettingsDir(async (/** @type {{dir: string, file: string}} */ { dir }) => {
    const entry = server();
    const applied = applySettingsPatch({ mcp: { servers: [entry] } }, defaultSettings());
    assert.equal(applied.ok, true);
    const written = await writeSettings(applied.settings);
    assert.equal(written.ok, true);
    const read = await readSettings();
    assert.deepEqual(read.issues, []);
    assert.deepEqual(read.settings.mcp.servers, [entry]);
    // 原子写不留临时文件
    const names = await fs.readdir(dir);
    assert.deepEqual(names.filter((name) => name.endsWith('.tmp')), []);
  });
});

test('非法 name：大写 / 1 位 / 超长 / 头字符非法都指到 mcp.servers[0].name', () => {
  for (const name of ['Bad', 'a', 'a'.repeat(33), '-lead']) {
    const result = applySettingsPatch({ mcp: { servers: [server({ name })] } }, defaultSettings());
    assert.equal(result.ok, false, name);
    assert.equal(result.code, 'OUT_OF_RANGE', name);
    assert.equal(result.field, 'mcp.servers[0].name', name);
    assert.deepEqual(result.allowed, [MCP_SERVER_NAME_PATTERN.source], name);
    assert.equal(result.reason, 'NAME_PATTERN', name);
  }
  // 2 位、带 -/_ 的合法名能过
  const ok = applySettingsPatch({ mcp: { servers: [server({ name: 'a_b-9' })] } }, defaultSettings());
  assert.equal(ok.ok, true);
});

test('重名：第二条报 DUPLICATE_NAME，不静默覆盖', () => {
  const result = applySettingsPatch(
    { mcp: { servers: [server({ name: 'dup' }), server({ name: 'dup', command: '/bin/other' })] } },
    defaultSettings(),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'OUT_OF_RANGE');
  assert.equal(result.field, 'mcp.servers[1].name');
  assert.equal(result.reason, 'DUPLICATE_NAME');
});

test(`超 ${MCP_MAX_SERVERS} 条：指到 mcp.servers，allowed=[0,${MCP_MAX_SERVERS}]`, () => {
  const list = Array.from({ length: MCP_MAX_SERVERS + 1 }, (_, index) =>
    server({ name: `s-${index}` }),
  );
  const result = applySettingsPatch({ mcp: { servers: list } }, defaultSettings());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'OUT_OF_RANGE');
  assert.equal(result.field, 'mcp.servers');
  assert.deepEqual(result.allowed, [0, MCP_MAX_SERVERS]);
  // 正好 32 条能过
  const exact = applySettingsPatch(
    { mcp: { servers: list.slice(0, MCP_MAX_SERVERS) } },
    defaultSettings(),
  );
  assert.equal(exact.ok, true);
  assert.equal(exact.settings.mcp.servers.length, MCP_MAX_SERVERS);
});

test('args 非数组 / 含非字符串：指到 mcp.servers[0].args', () => {
  for (const args of ['nope', [1, 2], [null]]) {
    const result = applySettingsPatch({ mcp: { servers: [server({ args })] } }, defaultSettings());
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.equal(result.code, 'OUT_OF_RANGE');
    assert.equal(result.field, 'mcp.servers[0].args');
    assert.deepEqual(result.allowed, ['string[]']);
  }
  // 空数组合法
  assert.equal(
    applySettingsPatch({ mcp: { servers: [server({ args: [] })] } }, defaultSettings()).ok,
    true,
  );
});

test('env 值非字符串：指到具体键，且错误里**不含值**', () => {
  const secret = 'hunter2-should-not-leak';
  const result = applySettingsPatch(
    { mcp: { servers: [server({ env: { MCP_TOKEN: 12345, NOTE: secret } })] } },
    defaultSettings(),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'OUT_OF_RANGE');
  assert.equal(result.field, 'mcp.servers[0].env.MCP_TOKEN');
  assert.equal(result.reason, 'ENV_VALUE_NOT_STRING');
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('12345'), '错误里不许出现非法值');
  assert.ok(!serialized.includes(secret), '错误里不许出现同条目的其它 env 值');
  assert.ok(result.message.includes('值不回显'));
});

test('patch 语义：只改传进来的分区，未传字段保持原值', () => {
  const current = defaultSettings();
  current.playback.volume = 55;
  const withMcp = applySettingsPatch({ mcp: { servers: [server()] } }, current);
  assert.equal(withMcp.ok, true);
  assert.equal(withMcp.settings.playback.volume, 55);
  assert.equal(withMcp.settings.export.fps, 30);
  assert.equal(withMcp.settings.mcp.servers.length, 1);

  // 只改播放：mcp 原样保留
  const after = applySettingsPatch({ playback: { volume: 40 } }, withMcp.settings);
  assert.equal(after.ok, true);
  assert.equal(after.settings.playback.volume, 40);
  assert.deepEqual(after.settings.mcp.servers, [server()]);

  // mcp: {} 不清空列表
  const empty = applySettingsPatch({ mcp: {} }, after.settings);
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.settings.mcp.servers, [server()]);
});

test('未知字段：条目内指到 mcp.servers[0].foo，分区内指到 mcp.foo', () => {
  const item = applySettingsPatch(
    { mcp: { servers: [{ ...server(), foo: 1 }] } },
    defaultSettings(),
  );
  assert.equal(item.ok, false);
  assert.equal(item.code, 'UNKNOWN_FIELD');
  assert.equal(item.field, 'mcp.servers[0].foo');

  const section = applySettingsPatch({ mcp: { nope: true } }, defaultSettings());
  assert.equal(section.ok, false);
  assert.equal(section.code, 'UNKNOWN_FIELD');
  assert.equal(section.field, 'mcp.nope');
});

test('command 缺失/空白、enabled 非布尔：各指到自己的字段', () => {
  const noCommand = applySettingsPatch(
    { mcp: { servers: [{ name: 'x1', args: [] }] } },
    defaultSettings(),
  );
  assert.equal(noCommand.code, 'OUT_OF_RANGE');
  assert.equal(noCommand.field, 'mcp.servers[0].command');

  const blank = applySettingsPatch(
    { mcp: { servers: [server({ command: '   ' })] } },
    defaultSettings(),
  );
  assert.equal(blank.field, 'mcp.servers[0].command');

  const badEnabled = applySettingsPatch(
    { mcp: { servers: [server({ enabled: 'yes' })] } },
    defaultSettings(),
  );
  assert.equal(badEnabled.code, 'OUT_OF_RANGE');
  assert.equal(badEnabled.field, 'mcp.servers[0].enabled');
});

test('enabled 缺省 = true；显式 false 保留但不下发', () => {
  const check = checkMcpServerEntry({ name: 'on-by-default', command: '/bin/echo' });
  assert.equal(check.ok, true);
  assert.equal(check.value.enabled, true);
  assert.deepEqual(check.value.args, []);
  assert.deepEqual(check.value.env, {});

  const settings = {
    mcp: {
      servers: [
        server({ name: 'first', enabled: undefined }),
        server({ name: 'second', enabled: true }),
        server({ name: 'third', enabled: false }),
      ],
    },
  };
  const mapped = mcpServersForSettings(settings);
  assert.deepEqual(mapped.map((/** @type {any} */ entry) => entry.name), ['first', 'second']);
  const first = /** @type {any} */ (mapped[0]);
  assert.ok(!Object.hasOwn(first, 'enabled'), 'enabled 不下发');
  assert.deepEqual(Object.keys(first).sort(), ['args', 'command', 'env', 'name']);
  assert.equal(first.env.MCP_TOKEN, 's3cr3t-value');
  // 每条都是新对象：改映射结果不污染设置
  first.args.push('--x');
  const original = /** @type {any} */ (settings).mcp.servers[0];
  assert.deepEqual(original.args, ['server.mjs', '--stdio']);
});

test('读路径宽容：坏条目/重名逐条留痕，好条目保留', async () => {
  await withSettingsDir(async (/** @type {{file: string}} */ { file }) => {
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        settings: {
          mcp: {
            servers: [
              server({ name: 'keep-1' }),
              { name: 'BAD', command: '/bin/x' },
              server({ name: 'keep-2', args: 5 }),
              server({ name: 'keep-1', command: '/bin/dup' }),
              server({ name: 'keep-3' }),
            ],
          },
        },
      }),
      'utf8',
    );
    const read = await readSettings();
    assert.deepEqual(read.settings.mcp.servers.map((/** @type {any} */ entry) => entry.name), ['keep-1', 'keep-3']);
    assert.ok(read.issues.includes('mcp.servers[1].name'));
    assert.ok(read.issues.includes('mcp.servers[2].args'));
    assert.ok(read.issues.includes('mcp.servers[3].name'));

    const shape = normalizeSettings({ mcp: 'nope' });
    assert.ok(shape.issues.includes('MCP_SHAPE'));
    const notArray = normalizeSettings({ mcp: { servers: 'nope' } });
    assert.ok(notArray.issues.includes('mcp.servers'));
  });
});

test('坏 JSON 仍不覆盖：改名留证据，mcp 回默认', async () => {
  await withSettingsDir(async (/** @type {{dir: string, file: string}} */ { dir, file }) => {
    await fs.writeFile(file, '{bad', 'utf8');
    const read = await readSettings();
    assert.deepEqual(read.issues, ['SETTINGS_CORRUPT']);
    assert.deepEqual(read.settings.mcp, { servers: [] });
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });
    const names = await fs.readdir(dir);
    assert.ok(names.some((name) => name.startsWith('settings.json.bak-')));
  });
});

test('legacy mcp.json：只检测存在性，不读内容、不写', async () => {
  await withSettingsDir(async (/** @type {{dir: string, file: string}} */ { dir, file }) => {
    assert.equal(legacyMcpPath(), path.join(dir, 'mcp.json'));
    assert.equal(legacyMcpExists(), false);
    const legacy = path.join(dir, 'mcp.json');
    const original = '{"servers":[{"name":"legacy-only"}]}\n';
    await fs.writeFile(legacy, original, 'utf8');
    assert.equal(legacyMcpExists(), true);

    // 读设置（不写盘）之后 legacy 内容与修改时间都不变
    const before = await fs.stat(legacy);
    const read = await readSettings();
    assert.equal(read.settings.mcp.servers.length, 0);
    assert.equal(await fs.readFile(legacy, 'utf8'), original);
    const after = await fs.stat(legacy);
    assert.equal(after.mtimeMs, before.mtimeMs);

    // 写设置也不会动 legacy
    const applied = applySettingsPatch({ mcp: { servers: [server()] } }, defaultSettings());
    await writeSettings(applied.settings);
    assert.equal(await fs.readFile(legacy, 'utf8'), original);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).settings.mcp.servers.length, 1);
  });
});
