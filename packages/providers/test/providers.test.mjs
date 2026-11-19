/**
 * WP19 验收（P6-A1..A8）。A9（真实付费调用）不在测试里跑，交接写 NOT_RUN。
 *
 * 全部请求打到本地 **MOCK** 服务器（端口 0），没有任何外部网络。
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createProvider } from '../client.mjs';
import { createKeyStore, fakeKey } from '../keys.mjs';
import { ProviderError } from '../errors.mjs';
import { clearSecrets, redactText, redactValue, registerSecret } from '../redact.mjs';
import { startMock } from './mock-server.mjs';

/** @type {Awaited<ReturnType<typeof startMock>>} */
let mock;
/** @type {string} */
let workDir;

const WIRES = /** @type {const} */ (['openai-chat', 'openai-responses', 'anthropic-messages']);

before(async () => {
  mock = await startMock();
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-providers-'));
});

after(async () => {
  await mock.close();
  await fs.rm(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  mock.requests.length = 0;
});

/**
 * @param {'openai-chat' | 'openai-responses' | 'anthropic-messages'} wire
 * @param {string} model
 * @param {Record<string, any>} [extra]
 */
function provider(wire, model, extra = {}) {
  return createProvider({
    wire,
    baseUrl: mock.url,
    apiKey: fakeKey(),
    model,
    maxOutputTokens: 128,
    timeoutMs: 5000,
    ...extra,
  });
}

// ---- P6-A1 -------------------------------------------------------------

test('A1 三种 wire 各自解析文本增量与结束原因（MOCK）', async () => {
  for (const wire of WIRES) {
    /** @type {string[]} */
    const deltas = [];
    const result = await provider(wire, 'mock-text').complete(
      { messages: [{ role: 'user', content: 'hi' }] },
      { onDelta: (d) => deltas.push(d) },
    );
    assert.equal(result.text, 'Hello from mock', wire);
    assert.equal(result.finishReason, 'stop', wire);
    assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 3 }, wire);
    assert.deepEqual(deltas, ['Hello', ' from', ' mock'], wire);
    assert.equal(result.streamed, true);
  }
});

test('A1 非流式（stream:false）返回整包，且形态一致', async () => {
  const result = await provider('openai-chat', 'mock-text').complete(
    { messages: [{ role: 'user', content: 'hi' }] },
    { stream: false },
  );
  assert.equal(result.text, 'Hello from mock');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.streamed, false);
  assert.equal(mock.requests.length, 1);
  assert.equal(mock.requests[0].body.stream, false);
});

test('A1 三种 wire 的鉴权头各不相同（Bearer vs x-api-key）', async () => {
  const bearer = fakeKey();
  const xkey = fakeKey();
  await createProvider({ wire: 'openai-chat', baseUrl: mock.url, apiKey: bearer, model: 'mock-text' }).complete({
    messages: [{ role: 'user', content: 'hi' }],
  });
  await createProvider({ wire: 'anthropic-messages', baseUrl: mock.url, apiKey: xkey, model: 'mock-text' }).complete({
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(mock.requests[0].headers.authorization, `Bearer ${bearer}`);
  assert.equal(mock.requests[1].headers['x-api-key'], xkey);
  assert.equal(mock.requests[1].headers['anthropic-version'], '2023-06-01');
  clearSecrets();
});

// ---- P6-A2 -------------------------------------------------------------

test('A2 工具调用参数被拆 3 片仍拼回（三种 wire）', async () => {
  for (const wire of WIRES) {
    const result = await provider(wire, 'mock-tools').complete({
      messages: [{ role: 'user', content: 'read a.txt' }],
      tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }],
    });
    assert.equal(result.toolCalls.length, 1, wire);
    const call = /** @type {any} */ (result.toolCalls[0]);
    assert.equal(call.name, 'read_file', wire);
    assert.deepEqual(call.arguments, { path: 'a.txt' }, wire);
    assert.equal(call.id, wire === 'anthropic-messages' ? 'toolu_1' : 'call_abc', wire);
    assert.equal(result.finishReason, 'tool_calls', wire);
  }
});

// ---- P6-A3 -------------------------------------------------------------

test('A3 坏 JSON → PROVIDER_PROTOCOL_ERROR（chat / anthropic / responses）', async () => {
  for (const wire of WIRES) {
    await assert.rejects(
      () => provider(wire, 'mock-bad-json').complete({ messages: [{ role: 'user', content: 'hi' }] }),
      (err) => err instanceof ProviderError && err.code === 'PROVIDER_PROTOCOL_ERROR',
      wire,
    );
  }
});

test('A3 断流（连接中途销毁）→ PROVIDER_PROTOCOL_ERROR，不把半截文本当成功', async () => {
  for (const wire of WIRES) {
    await assert.rejects(
      () => provider(wire, 'mock-truncate').complete({ messages: [{ role: 'user', content: 'hi' }] }),
      (err) => err instanceof ProviderError && err.code === 'PROVIDER_PROTOCOL_ERROR',
      wire,
    );
  }
});

// ---- P6-A4 -------------------------------------------------------------

test('A4 取消：Abort 后 500ms 内收敛 CANCELLED，且不留悬挂 socket', async () => {
  const controller = new AbortController();
  const client = provider('openai-chat', 'mock-slow', { timeoutMs: 30_000 });
  const started = Date.now();
  const running = client.complete({ messages: [{ role: 'user', content: 'hi' }] }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 120);

  await assert.rejects(running, (err) => err instanceof ProviderError && err.code === 'CANCELLED');
  assert.ok(Date.now() - started < 500, `cancel took ${Date.now() - started}ms`);

  // 这一条请求的响应流真的关了（最多等 1s 收尾）
  const entry = mock.requests[mock.requests.length - 1];
  for (let i = 0; i < 20; i += 1) {
    if (entry.responseClosed) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(entry.responseClosed, true, 'the request socket is still open after cancel');
});

// ---- P6-A5 -------------------------------------------------------------

test('A5 Key 不出现在错误消息/序列化里（401 回显 Key 的两种头）', async () => {
  for (const wire of WIRES) {
    const key = fakeKey();
    const client = createProvider({ wire, baseUrl: mock.url, apiKey: key, model: 'mock-401' });
    await assert.rejects(
      () => client.complete({ messages: [{ role: 'user', content: 'hi' }] }),
      (err) => {
        assert.ok(err instanceof ProviderError, wire);
        assert.equal(err.code, 'AUTH_REQUIRED', wire);
        assert.equal(err.status, 401, wire);
        const serialized = JSON.stringify(err.toJSON());
        assert.ok(!err.message.includes(key), `${wire}: message leaked key`);
        assert.ok(!serialized.includes(key), `${wire}: toJSON leaked key`);
        return true;
      },
    );
  }
});

test('A5 登记过的密文在任何文本/结构里都被替换', () => {
  const key = 'custom-gateway-token-9f8e7d6c';
  registerSecret(key);
  assert.equal(redactText(`failed with ${key}`), 'failed with [REDACTED]');
  const value = redactValue({ note: `token=${key}`, nested: [{ authorization: key }] });
  assert.ok(!JSON.stringify(value).includes(key));
  clearSecrets();
});

// ---- P6-A6 -------------------------------------------------------------

test('A6 safeStorage 不可用 → 0600 文件，权限位实测', async () => {
  const dir = path.join(workDir, 'keys-plain');
  const store = createKeyStore({ dir });
  assert.equal(store.backend, 'file-0600');
  const key = fakeKey();
  const saved = await store.save('openai', key);
  assert.equal(saved.source, 'file');
  assert.equal(saved.mode, 0o600);
  const stat = await fs.stat(path.join(dir, 'openai.key'));
  assert.equal(stat.mode & 0o777, 0o600);

  assert.equal(await store.load('openai'), key);
  const described = await store.describe('openai');
  assert.deepEqual(Object.keys(described).sort(), ['bytes', 'name', 'present', 'source']);
  assert.ok(!JSON.stringify(described).includes(key));
});

test('A6 safeStorage 可用 → 加密落盘，明文不在文件里', async () => {
  const dir = path.join(workDir, 'keys-safe');
  /** @type {Map<string, string>} */
  const vault = new Map();
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (/** @type {string} */ value) => {
      const token = `enc-${Buffer.from(value).toString('base64')}`;
      vault.set(token, value);
      return Buffer.from(token, 'utf8');
    },
    decryptString: (/** @type {Buffer} */ buffer) => {
      const token = buffer.toString('utf8');
      const value = vault.get(token);
      if (!value) throw new Error('bad ciphertext');
      return value;
    },
  };
  const store = createKeyStore({ dir, safeStorage });
  assert.equal(store.backend, 'safeStorage');
  const key = fakeKey();
  const saved = await store.save('anthropic', key);
  assert.equal(saved.source, 'safeStorage');
  const raw = await fs.readFile(path.join(dir, 'anthropic.enc'), 'utf8');
  assert.ok(!raw.includes(key), 'plaintext must not be in the encrypted file');
  assert.equal(await store.load('anthropic'), key);
});

// ---- P6-A7 -------------------------------------------------------------

test('A7 并发上限：同 provider 两条请求串行（总耗时≈2×超时）', async () => {
  const shared = provider('openai-chat', 'mock-slow', { timeoutMs: 250, maxConcurrent: 1 });
  const started = Date.now();
  const first = shared.complete({ messages: [{ role: 'user', content: 'one' }] }).catch((err) => err);
  const second = shared.complete({ messages: [{ role: 'user', content: 'two' }] }).catch((err) => err);
  const [a, b] = await Promise.all([first, second]);
  const elapsed = Date.now() - started;

  assert.equal(a.code, 'TIMEOUT');
  assert.equal(b.code, 'TIMEOUT');
  // 串行：250ms + 250ms；若并发则约 250ms
  assert.ok(elapsed >= 450, `requests were not serialized (${elapsed}ms)`);
  assert.ok(elapsed < 2000, `queue is too slow (${elapsed}ms)`);
});

test('A7 超时不影响另一个 provider 的请求', async () => {
  const slow = provider('openai-chat', 'mock-slow', { timeoutMs: 250 });
  const fast = provider('openai-chat', 'mock-text', { timeoutMs: 5000 });
  const failing = slow.complete({ messages: [{ role: 'user', content: 'slow' }] }).catch((err) => err);
  const ok = await fast.complete({ messages: [{ role: 'user', content: 'fast' }] });
  assert.equal(ok.text, 'Hello from mock');
  const failure = await failing;
  assert.equal(failure.code, 'TIMEOUT');
});

// ---- P6-A8 -------------------------------------------------------------

test('A8 不支持工具的模型 → 明确降级，不伪造 toolCalls', async () => {
  const result = await provider('openai-chat', 'mock-notools').complete({
    messages: [{ role: 'user', content: 'read a.txt' }],
    tools: [{ name: 'read_file', parameters: { type: 'object' } }],
  });
  assert.deepEqual(result.toolCalls, []);
  assert.equal(result.text, 'Hello from mock');
  assert.deepEqual(/** @type {any} */ (result).degraded, { tools: 'unsupported', reason: 'provider rejected tools; retried without them' });
  // 两次请求：第一次带 tools（被拒），第二次不带
  assert.equal(mock.requests.length, 2);
  assert.ok(Array.isArray(mock.requests[0].body.tools));
  assert.equal(mock.requests[1].body.tools, undefined);
});
