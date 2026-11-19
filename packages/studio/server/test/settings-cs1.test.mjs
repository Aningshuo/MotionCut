/**
 * CS1 · 设置的三个新契约（AC08 / AC10 / AC11）：
 *
 * 1. `agent.enabled`：null = 没配过（全部启用）；数组 = 白名单；非数组/超长/坏 id → 400。
 * 2. `byok`：三种 API 格式是枚举（不是自由字符串），越界字段一律 400；默认值不写进请求。
 * 3. `modelEndpoint`：**env 显式覆盖 > settings.byok > 缺省**，且三种 wire 原样透传
 *    ——「设置改了但请求没变」这条要能被判红。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applySettingsPatch, defaultSettings, normalizeSettings, readSettingsSync } from '../settings-store.mjs';
import { MODEL_WIRES, modelEndpoint } from '../model-key.mjs';

test('默认值：agent.enabled=null（不过滤）、byok 用 OpenAI Chat 缺省', () => {
  const settings = defaultSettings();
  assert.equal(settings.agent.enabled, null);
  assert.equal(settings.byok.format, 'openai-chat');
  assert.equal(settings.byok.baseUrl, '');
  assert.equal(settings.byok.contextTokens, 0);
});

test('agent.enabled：白名单数组可写；非数组 / 超长 / 坏 id 一律 400', () => {
  const base = defaultSettings();
  const ok = applySettingsPatch({ agent: { enabled: ['mock', 'codex'] } }, base);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.settings.agent.enabled, ['mock', 'codex']);

  const cleared = applySettingsPatch({ agent: { enabled: null } }, ok.ok ? ok.settings : base);
  assert.equal(cleared.ok, true);
  assert.equal(cleared.settings.agent.enabled, null);

  const notArray = applySettingsPatch({ agent: { enabled: 'mock' } }, base);
  assert.equal(notArray.ok, false);
  assert.equal(notArray.field, 'agent.enabled');

  const tooMany = applySettingsPatch({ agent: { enabled: Array.from({ length: 25 }, (_, i) => `a${String(i)}`) } }, base);
  assert.equal(tooMany.ok, false);

  const badId = applySettingsPatch({ agent: { enabled: ['ok', '../etc/passwd'] } }, base);
  assert.equal(badId.ok, false);
});

test('byok：format 只认三条 wire；未知格式 400；坏 baseUrl 长度 400', () => {
  assert.deepEqual([...MODEL_WIRES], ['openai-chat', 'openai-responses', 'anthropic-messages']);
  const base = defaultSettings();
  for (const wire of MODEL_WIRES) {
    const res = applySettingsPatch({ byok: { format: wire } }, base);
    assert.equal(res.ok, true, wire);
    assert.equal(res.settings.byok.format, wire);
  }
  const unknown = applySettingsPatch({ byok: { format: 'grpc' } }, base);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.field, 'byok.format');

  const longUrl = applySettingsPatch({ byok: { baseUrl: `https://x.test/${'a'.repeat(320)}` } }, base);
  assert.equal(longUrl.ok, false);
  assert.equal(longUrl.field, 'byok.baseUrl');

  const badContext = applySettingsPatch({ byok: { contextTokens: -1 } }, base);
  assert.equal(badContext.ok, false);
});

test('normalizeSettings：坏 agent/byok 值丢字段但保留其余（读不整体失败）', () => {
  const { settings, issues } = normalizeSettings({
    agent: { enabled: 'nope' },
    byok: { format: 'openai-responses', model: 'claude-x' },
    playback: { volume: 60 },
  });
  assert.equal(settings.agent.enabled, null);
  assert.equal(settings.byok.format, 'openai-responses');
  assert.equal(settings.byok.model, 'claude-x');
  assert.equal(settings.playback.volume, 60);
  assert.ok(issues.includes('agent.enabled'));
});

test('modelEndpoint：env 优先；否则读 settings.byok；都没有才用缺省', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs1-settings-'));
  const file = path.join(dir, 'settings.json');
  const previous = process.env.OPENCUT_SETTINGS;
  process.env.OPENCUT_SETTINGS = file;
  try {
    // 没有文件 → 缺省
    assert.equal(modelEndpoint({}).wire, 'openai-chat');
    assert.equal(modelEndpoint({}).baseUrl, 'https://api.openai.com/v1');

    // 写入 byok → 生效
    const written = applySettingsPatch(
      { byok: { format: 'anthropic-messages', baseUrl: 'http://127.0.0.1:9/v1', model: 'claude-stub' } },
      defaultSettings(),
    );
    assert.equal(written.ok, true);
    await fs.writeFile(file, `${JSON.stringify({ version: 1, settings: written.settings }, null, 1)}\n`, 'utf8');
    assert.deepEqual(readSettingsSync().byok.format, 'anthropic-messages');
    const fromSettings = modelEndpoint({});
    assert.equal(fromSettings.wire, 'anthropic-messages');
    assert.equal(fromSettings.baseUrl, 'http://127.0.0.1:9/v1');
    assert.equal(fromSettings.model, 'claude-stub');
    assert.equal(fromSettings.source, 'settings');

    // env 显式覆盖 → env 胜
    const fromEnv = modelEndpoint({ OPENCUT_MODEL_BASE_URL: 'http://127.0.0.1:8/v1', OPENCUT_MODEL_WIRE: 'openai-responses', OPENCUT_MODEL_NAME: 'env-model' });
    assert.equal(fromEnv.wire, 'openai-responses');
    assert.equal(fromEnv.baseUrl, 'http://127.0.0.1:8/v1');
    assert.equal(fromEnv.model, 'env-model');
    assert.equal(fromEnv.source, 'env');
  } finally {
    if (previous === undefined) delete process.env.OPENCUT_SETTINGS;
    else process.env.OPENCUT_SETTINGS = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
