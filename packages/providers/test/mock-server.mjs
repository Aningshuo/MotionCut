/**
 * 本地 mock provider（**MOCK**，WP19 全部流式证据的来源）。
 *
 * 三种 wire 的真实线格式：`/v1/chat/completions`、`/v1/responses`、`/v1/messages`。
 * 用**端口 0**（上批被硬编码端口咬过），行为由 model 名选择：
 *
 *   mock-text     三片文本 + 正常结束
 *   mock-tools    一次工具调用，参数被拆成 3 片
 *   mock-bad-json SSE data 里塞坏 JSON
 *   mock-truncate 发一片就断连接
 *   mock-401      401，响应体里**故意回显**请求里的 Key（用来证 redact）
 *   mock-slow     每帧 5s，用来测超时/取消
 *   mock-notools  带 tools → 400 "tools are not supported"；不带 tools → 正常文本
 *   mock-tool-loop 第一轮回工具调用；请求里带回工具结果后回文本（工具循环）
 *   mock-429      第一次 429 + Retry-After: 0，之后正常文本（限流重试）
 */

import http from 'node:http';

const DELTA_TEXT = ['Hello', ' from', ' mock'];

/**
 * @returns {Promise<{ url: string, port: number, requests: any[], openSockets: () => number, close: () => Promise<void> }>}
 */
export async function startMock() {
  /** @type {any[]} */
  const requests = [];
  /** @type {Map<string, number>} */
  const hits = new Map();
  let sockets = 0;

  /** @param {http.ServerResponse} res */
  const sse = (res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
  };

  /** @param {http.ServerResponse} res @param {string} event @param {unknown} data */
  const emit = (res, event, data) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
  };

  const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * @param {string} model
   * @param {http.ServerResponse} res
   */
  async function streamChat(model, res) {
    sse(res);
    if (model === 'mock-bad-json') {
      res.write('data: {"choices": [oops\n\n');
      res.end();
      return;
    }
    if (model === 'mock-truncate') {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] })}\n\n`);
      // 让这一片先 flush 到客户端，再断——"流断在半路"才是要测的东西
      setTimeout(() => res.destroy(), 30);
      return;
    }
    if (model === 'mock-tools') {
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_abc', function: { name: 'read_file', arguments: '{"pa' } }] } }],
        })}\n\n`,
      );
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th": "a' } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '.txt"}' } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 11, completion_tokens: 9 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    for (const delta of DELTA_TEXT) {
      if (model === 'mock-slow') await sleep(1500);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }

  /**
   * @param {string} model
   * @param {http.ServerResponse} res
   */
  async function streamResponses(model, res) {
    sse(res);
    if (model === 'mock-bad-json') {
      emit(res, 'response.output_text.delta', '{"type": nope}');
      res.end();
      return;
    }
    if (model === 'mock-truncate') {
      emit(res, 'response.output_text.delta', { type: 'response.output_text.delta', delta: 'Hel' });
      setTimeout(() => res.destroy(), 30);
      return;
    }
    if (model === 'mock-tools') {
      emit(res, 'response.output_item.added', {
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_abc', name: 'read_file' },
      });
      for (const part of ['{"pa', 'th": "a', '.txt"}']) {
        emit(res, 'response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          item_id: 'call_abc',
          delta: part,
        });
      }
      emit(res, 'response.completed', {
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 11, output_tokens: 9 } },
      });
      res.end();
      return;
    }
    for (const delta of DELTA_TEXT) {
      if (model === 'mock-slow') await sleep(1500);
      emit(res, 'response.output_text.delta', { type: 'response.output_text.delta', delta });
    }
    emit(res, 'response.completed', {
      type: 'response.completed',
      response: { status: 'completed', usage: { input_tokens: 7, output_tokens: 3 } },
    });
    res.end();
  }

  /**
   * @param {string} model
   * @param {http.ServerResponse} res
   */
  async function streamAnthropic(model, res) {
    sse(res);
    if (model === 'mock-bad-json') {
      res.write('data: {"type": nope}\n\n');
      res.end();
      return;
    }
    if (model === 'mock-truncate') {
      emit(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } });
      setTimeout(() => res.destroy(), 30);
      return;
    }
    emit(res, 'message_start', { type: 'message_start', message: { usage: { input_tokens: 7 } } });
    if (model === 'mock-tools') {
      emit(res, 'content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file' },
      });
      for (const part of ['{"pa', 'th": "a', '.txt"}']) {
        emit(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: part },
        });
      }
      emit(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
      emit(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } });
      emit(res, 'message_stop', { type: 'message_stop' });
      res.end();
      return;
    }
    emit(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    for (const delta of DELTA_TEXT) {
      if (model === 'mock-slow') await sleep(1500);
      emit(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: delta },
      });
    }
    emit(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    emit(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } });
    emit(res, 'message_stop', { type: 'message_stop' });
    res.end();
  }

  const server = http.createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      /** @type {any} */
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = { invalid: true };
      }
      /** @type {any} */
      const entry = { url: req.url, headers: req.headers, body, responseClosed: false, closedAt: 0 };
      requests.push(entry);
      res.on('close', () => {
        entry.responseClosed = true;
        entry.closedAt = Date.now();
      });

      const model = typeof body.model === 'string' ? body.model : 'mock-text';
      const path = req.url ?? '';
      const count = (hits.get(model) ?? 0) + 1;
      hits.set(model, count);

      /* CS2：限流重试。Retry-After 给 0 秒，测试不必真等。 */
      if (model === 'mock-429' && count === 1) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
        res.end(JSON.stringify({ error: { message: 'rate limited by mock', type: 'rate_limit_error' } }));
        return;
      }

      /* 工具结果回灌的三种形状：Chat role=tool；Responses function_call_output；
         Anthropic content block tool_result。 */
      const hasToolResult = (() => {
        if (Array.isArray(body.messages)) {
          if (body.messages.some((/** @type {any} */ m) => m?.role === 'tool')) return true;
          if (body.messages.some((/** @type {any} */ m) => Array.isArray(m?.content) && m.content.some((/** @type {any} */ part) => part?.type === 'tool_result'))) return true;
        }
        if (Array.isArray(body.input) && body.input.some((/** @type {any} */ item) => item?.type === 'function_call_output')) return true;
        if (Array.isArray(body.content) && body.content.some((/** @type {any} */ block) => block?.type === 'tool_result')) return true;
        return false;
      })();
      const effectiveModel = model === 'mock-tool-loop' ? (hasToolResult ? 'mock-text' : 'mock-tools') : model;

      if (model === 'mock-401') {
        const echo = req.headers.authorization ?? req.headers['x-api-key'] ?? 'none';
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `invalid api key: ${echo}`, type: 'invalid_request_error' } }));
        return;
      }
      if (model === 'mock-notools' && Array.isArray(body.tools) && body.tools.length > 0) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'tools are not supported by this model', type: 'invalid_request_error' } }));
        return;
      }

      // 非流式：同一个 model，回整包 JSON（客户端 stream:false 走的路径）
      if (body.stream === false) {
        const payload = path.endsWith('/responses')
          ? {
              output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello from mock' }] }],
              usage: { input_tokens: 7, output_tokens: 3 },
            }
          : path.endsWith('/messages')
            ? {
                content: [{ type: 'text', text: 'Hello from mock' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 7, output_tokens: 3 },
              }
            : {
                choices: [{ message: { content: 'Hello from mock' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 7, completion_tokens: 3 },
              };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
      }

      try {
        if (path.endsWith('/chat/completions')) await streamChat(effectiveModel, res);
        else if (path.endsWith('/responses')) await streamResponses(effectiveModel, res);
        else if (path.endsWith('/messages')) await streamAnthropic(effectiveModel, res);
        else {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `no such endpoint: ${path}` } }));
        }
      } catch {
        /* 客户端提前断开时 write 会抛；mock 不需要处理 */
      }
    });
  });

  server.on('connection', (socket) => {
    sockets += 1;
    socket.on('close', () => {
      sockets -= 1;
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    openSockets: () => sockets,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve(undefined));
      }),
  };
}
