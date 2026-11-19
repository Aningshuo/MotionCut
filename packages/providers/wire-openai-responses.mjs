/**
 * OpenAI Responses API wire（WP19）。
 *
 * 与 ChatCompletions 的区别不只是 URL：入参是 `input` 的 item 列表，事件是
 * `response.*` 命名事件，工具调用参数用 `item_id` 关联。
 *
 * 事件：
 *   response.output_text.delta                  → 文本增量
 *   response.output_item.added (function_call)  → 工具调用开始（id/name）
 *   response.function_call_arguments.delta      → 参数分片
 *   response.completed                          → 结束 + usage
 *   response.failed / error                     → 明确失败
 */

import { ProviderError } from './errors.mjs';

export const WIRE = 'openai-responses';

/** Responses API 同样用 Bearer。 */
/** @param {string} apiKey */
export function authHeaders(apiKey) {
  return { authorization: `Bearer ${apiKey}` };
}

/**
 * @param {{ model: string, messages: any[], tools?: any[], maxOutputTokens: number, stream: boolean }} req
 * @param {{ baseUrl: string }} cfg
 */
export function buildRequest(req, cfg) {
  /* CS2：Responses 的 input 是 item 列表 —— assistant 的工具调用是
     `function_call` item，工具结果是 `function_call_output` item，不是 message。 */
  /** @type {any[]} */
  const input = [];
  for (const m of req.messages) {
    if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.toolCallId ?? '', output: m.content ?? '' });
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
      if (typeof m.content === 'string' && m.content !== '') {
        input.push({ role: 'assistant', content: [{ type: 'output_text', text: m.content }] });
      }
      for (const call of m.toolCalls) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: typeof call.argumentsText === 'string' && call.argumentsText !== ''
            ? call.argumentsText
            : JSON.stringify(call.arguments ?? {}),
        });
      }
      continue;
    }
    input.push({
      role: m.role,
      content: [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: m.content ?? '' }],
    });
  }
  const body = {
    model: req.model,
    input,
    stream: req.stream,
    max_output_tokens: req.maxOutputTokens,
    ...(req.tools?.length
      ? {
          tools: req.tools.map((t) => ({
            type: 'function',
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        }
      : {}),
  };
  return {
    url: `${cfg.baseUrl.replace(/\/+$/, '')}/responses`,
    headers: { 'content-type': 'application/json' },
    body,
  };
}

/**
 * @param {unknown} raw
 * @returns {any}
 */
function parse(raw) {
  try {
    return JSON.parse(String(raw));
  } catch {
    throw new ProviderError('PROVIDER_PROTOCOL_ERROR', `invalid JSON in stream: ${String(raw).slice(0, 120)}`);
  }
}

export function createAccumulator() {
  /** @type {{ id: string, name: string, argsText: string, index: number }[]} */
  const calls = [];
  return {
    text: '',
    usage: { inputTokens: 0, outputTokens: 0 },
    /** @type {string | null} */
    finishReason: null,
    completed: false,
    toolCalls: calls,
    /**
     * @param {{ event: string | null, data: string }} frame
     * @param {((event: any) => void) | null} [emit]
     * @returns {string | null}
     */
    onFrame(frame, emit) {
      const body = parse(frame.data);
      const type = frame.event ?? body.type;

      if (type === 'response.output_text.delta') {
        const delta = typeof body.delta === 'string' ? body.delta : '';
        this.text += delta;
        return delta.length > 0 ? delta : null;
      }

      if (type === 'response.output_item.added' && body.item?.type === 'function_call') {
        const slot = {
          id: body.item.call_id ?? body.item.id ?? `call_${calls.length}`,
          name: body.item.name ?? '',
          argsText: '',
          index: calls.length,
        };
        calls.push(slot);
        emit?.({ type: 'tool_call_start', index: slot.index, id: slot.id, name: slot.name });
        return null;
      }

      if (type === 'response.function_call_arguments.delta') {
        const slot = calls.find((c) => c.id === body.item_id) ?? calls[calls.length - 1];
        if (slot) {
          const part = typeof body.delta === 'string' ? body.delta : '';
          slot.argsText += part;
          if (part.length > 0) emit?.({ type: 'tool_call_delta', index: slot.index, id: slot.id, argumentsText: part });
        }
        return null;
      }

      if (type === 'response.completed') {
        const usage = body.response?.usage ?? body.usage ?? {};
        this.usage.inputTokens = usage.input_tokens ?? this.usage.inputTokens;
        this.usage.outputTokens = usage.output_tokens ?? this.usage.outputTokens;
        this.finishReason = calls.length > 0 ? 'tool_calls' : 'stop';
        this.completed = true;
        return null;
      }

      if (type === 'response.failed' || type === 'error') {
        const message =
          body.response?.error?.message ?? body.error?.message ?? body.message ?? 'provider reported a failure';
        throw new ProviderError('HTTP_ERROR', `responses stream failed: ${message}`, { detail: body });
      }

      return null;
    },
  };
}

/**
 * @param {any} body
 */
export function parseFull(body) {
  let text = '';
  /** @type {{ id: string, name: string, argsText: string, index: number }[]} */
  const calls = [];
  for (const item of body?.output ?? []) {
    if (item?.type === 'message') {
      for (const part of item.content ?? []) {
        if (part?.type === 'output_text' && typeof part.text === 'string') text += part.text;
      }
    }
    if (item?.type === 'function_call') {
      calls.push({
        id: item.call_id ?? item.id ?? `call_${calls.length}`,
        name: item.name ?? '',
        argsText: item.arguments ?? '',
        index: calls.length,
      });
    }
  }
  return {
    text,
    toolCalls: calls,
    usage: {
      inputTokens: body?.usage?.input_tokens ?? 0,
      outputTokens: body?.usage?.output_tokens ?? 0,
    },
    finishReason: calls.length > 0 ? 'tool_calls' : 'stop',
    completed: true,
  };
}
