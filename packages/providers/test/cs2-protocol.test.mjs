// @ts-nocheck —— 测试用本地 stub，事件对象是动态形状
/**
 * CS2 · BYOK 三协议：流事件 / 工具循环 / 取消 / 错误与限流（SUB1）。
 *
 * 为什么不是「再验一遍 200/端点/头」：那些在 `providers.test.mjs` 里已经验过。
 * 这里补的是**真实 Agent 需要、但之前没实现**的四件事：
 *
 * 1. 流式事件（text_delta / tool_call_start / tool_call_delta / usage / done）——
 *    上层要按事件更新 UI，而不是等整段文本；
 * 2. 工具循环（模型要工具 → 执行 → 按**各协议自己的形状**回灌 → 再问）；
 * 3. 取消（abort 后不再发起下一轮，连接真的断）；
 * 4. 错误/限流（429 尊重 Retry-After 重试；401 不重试；工具循环有轮次上限）。
 *
 * 三条 wire 的差异不是 URL：Chat 用 role:"tool"、Responses 用 function_call_output、
 * Anthropic 用 tool_result block。测试逐条检查**请求体里的真实形状**。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createProvider, runToolLoop, WIRES } from '../client.mjs';
import { startMock } from './mock-server.mjs';

const WIRE_LIST = ['openai-chat', 'openai-responses', 'anthropic-messages'];

/** @param {string} wire */
const keyFor = (wire) => (wire === 'anthropic-messages' ? 'sk-ant-cs2' : 'sk-cs2-stub');

/**
 * @param {string} wire
 * @param {string} baseUrl
 * @param {string} model
 */
function make(wire, baseUrl, model) {
  return createProvider({
    wire: /** @type {any} */ (wire),
    baseUrl,
    apiKey: keyFor(wire),
    model,
    maxOutputTokens: 64,
    timeoutMs: 4000,
    maxConcurrent: 1,
    retry: { maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 20 },
  });
}

/** @param {any} body */
function toolCallsOf(body) {
  return Array.isArray(body?.messages) ? body.messages.filter((/** @type {any} */ m) => m?.role === 'tool') : [];
}

test('CS2 · 三条 wire 都发流式事件（text/tool/usage/done）', async () => {
  const mock = await startMock();
  try {
    for (const wire of WIRE_LIST) {
      const events = [];
      const result = await make(wire, mock.url, 'mock-text').complete(
        { messages: [{ role: 'user', content: 'hi' }] },
        { onEvent: (event) => events.push(event) },
      );
      assert.equal(result.text, 'Hello from mock', wire);
      assert.equal(result.streamed, true, wire);
      const types = events.map((event) => event.type);
      assert.equal(types.filter((type) => type === 'text_delta').length, 3, `${wire} 文本分片`);
      assert.ok(types.includes('usage'), `${wire} 要有 usage 事件`);
      assert.ok(types.includes('done'), `${wire} 要有 done 事件`);
      assert.deepEqual(events[events.length - 1], {
        type: 'done',
        finishReason: result.finishReason,
        usage: result.usage,
      });
      assert.equal(events.filter((event) => event.type === 'text_delta').map((event) => event.text).join(''), 'Hello from mock', wire);
    }
  } finally {
    await mock.close();
  }
});

test('CS2 · 三条 wire 的工具循环：形状各按本协议回灌', async () => {
  const mock = await startMock();
  try {
    for (const wire of WIRE_LIST) {
      const calls = [];
      const events = [];
      const result = await runToolLoop(make(wire, mock.url, 'mock-tool-loop'), { messages: [{ role: 'user', content: '读 a.txt' }] }, {
        execute: async (/** @type {any} */ call) => {
          calls.push(call);
          return { content: 'file: a.txt' };
        },
        maxRounds: 4,
        onEvent: (/** @type {any} */ event) => events.push(event),
      });
      assert.equal(result.rounds.length, 2, `${wire} 应有两轮（工具 → 最终答案）`);
      assert.equal(result.text, 'Hello from mock', wire);
      assert.equal(calls.length, 1, wire);
      assert.equal(calls[0].name, 'read_file', wire);
      assert.deepEqual(calls[0].arguments, { path: 'a.txt' }, wire);
      assert.ok(events.some((event) => event.type === 'tool_result' && event.ok === true), `${wire} 要有 tool_result 事件`);

      const suffix = wire === 'openai-chat' ? '/chat/completions' : wire === 'openai-responses' ? '/responses' : '/messages';
      const requests = mock.requests.filter((entry) => String(entry.url).endsWith(suffix));
      assert.equal(requests.length, 2, `${wire} 应有两次真实请求`);
      const second = requests[1].body;
      if (wire === 'openai-chat') {
        const toolMessages = toolCallsOf(second);
        assert.equal(toolMessages.length, 1);
        assert.equal(toolMessages[0].tool_call_id, 'call_abc');
        assert.equal(toolMessages[0].content, 'file: a.txt');
        const assistant = second.messages.find((/** @type {any} */ m) => m?.role === 'assistant' && Array.isArray(m.tool_calls));
        assert.ok(assistant, 'assistant 要带 tool_calls');
        assert.equal(assistant.tool_calls[0].id, 'call_abc');
        assert.equal(assistant.tool_calls[0].function.name, 'read_file');
      } else if (wire === 'openai-responses') {
        const output = (second.input ?? []).find((/** @type {any} */ item) => item?.type === 'function_call_output');
        assert.ok(output, 'Responses 要有 function_call_output');
        assert.equal(output.call_id, 'call_abc');
        assert.equal(output.output, 'file: a.txt');
        const callItem = (second.input ?? []).find((/** @type {any} */ item) => item?.type === 'function_call');
        assert.ok(callItem, 'Responses 要有 function_call item');
        assert.equal(callItem.name, 'read_file');
        assert.deepEqual(JSON.parse(callItem.arguments), { path: 'a.txt' });
      } else {
        const last = second.messages[second.messages.length - 1];
        assert.equal(last.role, 'user');
        assert.equal(last.content[0].type, 'tool_result');
        assert.equal(last.content[0].tool_use_id, 'toolu_1');
        assert.equal(last.content[0].content, 'file: a.txt');
        const assistant = second.messages.find((/** @type {any} */ m) => m?.role === 'assistant' && Array.isArray(m.content));
        const toolUse = assistant.content.find((/** @type {any} */ block) => block?.type === 'tool_use');
        assert.ok(toolUse, 'Anthropic 要有 tool_use block');
        assert.deepEqual(toolUse.input, { path: 'a.txt' });
      }
    }
  } finally {
    await mock.close();
  }
});

test('CS2 · 取消：abort 后不再发起下一轮，连接被放掉', async () => {
  const mock = await startMock();
  try {
    const provider = make('openai-chat', mock.url, 'mock-slow');
    const controller = new AbortController();
    const events = [];
    const running = provider.complete(
      { messages: [{ role: 'user', content: 'slow' }] },
      {
        signal: controller.signal,
        onEvent: (/** @type {any} */ event) => {
          events.push(event);
          if (event.type === 'text_delta' && events.filter((item) => item.type === 'text_delta').length === 1) controller.abort();
        },
      },
    );
    await assert.rejects(running, (error) => error?.code === 'CANCELLED');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(mock.requests.length, 1, '取消后不应重发');
    assert.equal(mock.requests[0].responseClosed, true, '连接应被关闭');
    assert.ok(events.filter((event) => event.type === 'text_delta').length <= 2, '取消后不再吐文本');
  } finally {
    await mock.close();
  }
});

test('CS2 · 限流：429 按 Retry-After 重试一次并成功', async () => {
  const mock = await startMock();
  try {
    const events = [];
    const result = await make('openai-chat', mock.url, 'mock-429').complete(
      { messages: [{ role: 'user', content: 'hi' }] },
      { onEvent: (/** @type {any} */ event) => events.push(event) },
    );
    assert.equal(result.text, 'Hello from mock');
    assert.equal(result.attempts, 2);
    const retry = events.find((event) => event.type === 'retry');
    assert.ok(retry, '要有 retry 事件');
    assert.equal(retry.code, 'RATE_LIMITED');
    assert.equal(retry.status, 429);
    assert.ok(retry.delayMs <= 20 + 120, `Retry-After: 0 应几乎立刻重试（收到 ${retry.delayMs}ms）`);
    assert.equal(mock.requests.length, 2);
  } finally {
    await mock.close();
  }
});

test('CS2 · 鉴权错误不重试（401 只打一次）', async () => {
  const mock = await startMock();
  try {
    await assert.rejects(make('openai-chat', mock.url, 'mock-401').complete({ messages: [{ role: 'user', content: 'hi' }] }), (error) => {
      assert.equal(error?.code, 'AUTH_REQUIRED');
      assert.equal(error?.retryable, false);
      return true;
    });
    assert.equal(mock.requests.length, 1, '401 不应重试');
  } finally {
    await mock.close();
  }
});

test('CS2 · 工具循环有轮次上限（不会无限循环）', async () => {
  const mock = await startMock();
  try {
    let calls = 0;
    await assert.rejects(
      runToolLoop(make('openai-chat', mock.url, 'mock-tools'), { messages: [{ role: 'user', content: 'loop' }] }, {
        execute: () => {
          calls += 1;
          return 'again';
        },
        maxRounds: 2,
      }),
      (error) => error?.code === 'TOOL_LOOP_LIMIT',
    );
    assert.equal(calls, 2, '两轮各执行一次工具');
    assert.equal(mock.requests.length, 2);
  } finally {
    await mock.close();
  }
});

test('CS2 · 三条 wire 都声明了工具结果形状（buildRequest 可单独调用）', () => {
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a' }, argumentsText: '{"path":"a"}' }] },
    { role: 'tool', toolCallId: 'c1', content: 'ok' },
  ];
  for (const wire of WIRE_LIST) {
    const built = WIRES[wire].buildRequest({ model: 'm', messages, tools: [], maxOutputTokens: 8, stream: false }, { baseUrl: 'http://x/v1' });
    const text = JSON.stringify(built.body);
    assert.ok(text.includes('c1'), `${wire} 要保留 call id`);
    assert.ok(text.includes('read_file'), `${wire} 要保留工具名`);
    assert.ok(text.includes('ok'), `${wire} 要保留工具结果`);
  }
});
