/**
 * OpenAI ChatCompletions wire（WP19）。
 *
 * 流式分片形状：
 *   choices[0].delta.content                     → 文本增量
 *   choices[0].delta.tool_calls[{index,id,function:{name,arguments}}] → 工具调用分片
 *   choices[0].finish_reason                     → 结束原因
 *   usage                                        → 末帧用量（需 stream_options.include_usage）
 */

import { ProviderError } from './errors.mjs';

export const WIRE = 'openai-chat';

/** ChatCompletions 用 Bearer。 */
/** @param {string} apiKey */
export function authHeaders(apiKey) {
  return { authorization: `Bearer ${apiKey}` };
}

/**
 * @param {{ model: string, messages: any[], tools?: any[], maxOutputTokens: number, stream: boolean }} req
 * @param {{ baseUrl: string }} cfg
 */
export function buildRequest(req, cfg) {
  const body = {
    model: req.model,
    /* CS2：工具循环回灌需要三种消息形状：普通消息、带 tool_calls 的 assistant、
       带 tool_call_id 的 tool 结果。这里按 ChatCompletions 的真实字段映射。 */
    messages: req.messages.map((m) => {
      if (m.role === 'tool') {
        return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content ?? '' };
      }
      if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
        return {
          role: 'assistant',
          content: typeof m.content === 'string' && m.content !== '' ? m.content : null,
          tool_calls: m.toolCalls.map((/** @type {any} */ call) => ({
            id: call.id,
            type: 'function',
            function: {
              name: call.name,
              arguments: typeof call.argumentsText === 'string' && call.argumentsText !== ''
                ? call.argumentsText
                : JSON.stringify(call.arguments ?? {}),
            },
          })),
        };
      }
      return { role: m.role, content: m.content ?? '' };
    }),
    stream: req.stream,
    ...(req.stream ? { stream_options: { include_usage: true } } : {}),
    ...(req.tools?.length
      ? {
          tools: req.tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
        }
      : {}),
    max_tokens: req.maxOutputTokens,
  };
  return {
    url: `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`,
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
     * @returns {string | null} 文本增量
     */
    onFrame(frame, emit) {
      const body = parse(frame.data);
      if (body.usage) {
        this.usage.inputTokens = body.usage.prompt_tokens ?? this.usage.inputTokens;
        this.usage.outputTokens = body.usage.completion_tokens ?? this.usage.outputTokens;
      }
      const choice = body.choices?.[0];
      if (!choice) return null;

      let delta = null;
      if (typeof choice.delta?.content === 'string' && choice.delta.content.length > 0) {
        this.text += choice.delta.content;
        delta = choice.delta.content;
      }
      for (const part of choice.delta?.tool_calls ?? []) {
        const index = Number.isInteger(part.index) ? part.index : calls.length;
        let slot = calls.find((c) => c.index === index);
        if (!slot) {
          slot = { id: '', name: '', argsText: '', index };
          calls.push(slot);
          emit?.({ type: 'tool_call_start', index, id: part.id ?? '', name: part.function?.name ?? '' });
        }
        if (part.id) slot.id = part.id;
        if (part.function?.name) slot.name = part.function.name;
        if (typeof part.function?.arguments === 'string') {
          slot.argsText += part.function.arguments;
          if (part.function.arguments.length > 0) {
            emit?.({ type: 'tool_call_delta', index, id: slot.id, argumentsText: part.function.arguments });
          }
        }
      }
      if (choice.finish_reason) {
        this.finishReason = choice.finish_reason === 'tool_calls' ? 'tool_calls' : choice.finish_reason;
        this.completed = true;
      }
      return delta;
    },
  };
}

/**
 * 非流式整包解析。
 * @param {any} body
 */
export function parseFull(body) {
  const message = body?.choices?.[0]?.message ?? {};
  const calls = /** @type {any[]} */ (message.tool_calls ?? []).map((/** @type {any} */ call, /** @type {number} */ index) => ({
    id: call.id ?? `call_${index}`,
    name: call.function?.name ?? '',
    argsText: call.function?.arguments ?? '',
    index,
  }));
  return {
    text: typeof message.content === 'string' ? message.content : '',
    toolCalls: calls,
    usage: {
      inputTokens: body?.usage?.prompt_tokens ?? 0,
      outputTokens: body?.usage?.completion_tokens ?? 0,
    },
    finishReason: body?.choices?.[0]?.finish_reason ?? 'stop',
    completed: true,
  };
}
