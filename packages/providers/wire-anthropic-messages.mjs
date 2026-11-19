/**
 * Anthropic Messages wire（WP19）。
 *
 * 与 OpenAI 的两处硬差别：
 * 1. 鉴权头是 `x-api-key` + `anthropic-version`，不是 Bearer；
 * 2. system 是顶层字段，不在 messages 里；流式事件叫 `content_block_*`。
 *
 * 事件：
 *   message_start                → usage.input_tokens
 *   content_block_start          → text / tool_use(id,name) 开始
 *   content_block_delta          → text_delta / input_json_delta
 *   message_delta                → stop_reason + usage.output_tokens
 *   message_stop                 → 结束
 *   error                        → 明确失败
 */

import { ProviderError } from './errors.mjs';

export const WIRE = 'anthropic-messages';

/** Anthropic 用 x-api-key，不用 Bearer。 */
/** @param {string} apiKey */
export function authHeaders(apiKey) {
  return { 'x-api-key': apiKey };
}

/**
 * @param {{ model: string, messages: any[], tools?: any[], maxOutputTokens: number, stream: boolean }} req
 * @param {{ baseUrl: string, anthropicVersion?: string }} cfg
 */
export function buildRequest(req, cfg) {
  const system = req.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  /* CS2：Anthropic 的工具回灌是 content block —— assistant 的 tool_use，
     user 的 tool_result（多个结果可合并在同一条 user 消息里）。 */
  /** @type {any[]} */
  const messages = [];
  for (const m of req.messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: m.toolCallId ?? '',
        content: m.content ?? '',
        ...(m.isError === true ? { is_error: true } : {}),
      };
      const last = messages[messages.length - 1];
      const lastIsResults = last?.role === 'user'
        && Array.isArray(last.content)
        && last.content.length > 0
        && last.content.every((/** @type {any} */ part) => part?.type === 'tool_result');
      if (lastIsResults) last.content.push(block);
      else messages.push({ role: 'user', content: [block] });
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
      /** @type {any[]} */
      const blocks = [];
      if (typeof m.content === 'string' && m.content !== '') blocks.push({ type: 'text', text: m.content });
      for (const call of m.toolCalls) {
        /** @type {any} */
        let input = call.arguments ?? {};
        if ((input === null || typeof input !== 'object') && typeof call.argumentsText === 'string') {
          try {
            input = JSON.parse(call.argumentsText);
          } catch {
            input = {};
          }
        }
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input });
      }
      messages.push({ role: 'assistant', content: blocks });
      continue;
    }
    messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content ?? '' });
  }
  const body = {
    model: req.model,
    max_tokens: req.maxOutputTokens,
    messages,
    stream: req.stream,
    ...(system.length > 0 ? { system } : {}),
    ...(req.tools?.length
      ? {
          tools: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters,
          })),
        }
      : {}),
  };
  return {
    url: `${cfg.baseUrl.replace(/\/+$/, '')}/messages`,
    headers: { 'content-type': 'application/json', 'anthropic-version': cfg.anthropicVersion ?? '2023-06-01' },
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

/**
 * @param {string | null | undefined} reason
 * @returns {string}
 */
function mapStop(reason) {
  if (reason === 'tool_use') return 'tool_calls';
  if (reason === 'max_tokens') return 'length';
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'stop';
  return reason ?? 'stop';
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

      if (type === 'message_start') {
        this.usage.inputTokens = body.message?.usage?.input_tokens ?? 0;
        return null;
      }
      if (type === 'content_block_start' && body.content_block?.type === 'tool_use') {
        const slot = {
          id: body.content_block.id ?? `toolu_${calls.length}`,
          name: body.content_block.name ?? '',
          argsText: '',
          index: Number.isInteger(body.index) ? body.index : calls.length,
        };
        calls.push(slot);
        emit?.({ type: 'tool_call_start', index: slot.index, id: slot.id, name: slot.name });
        return null;
      }
      if (type === 'content_block_delta') {
        const delta = body.delta ?? {};
        if (delta.type === 'text_delta') {
          this.text += delta.text ?? '';
          return delta.text ?? null;
        }
        if (delta.type === 'input_json_delta') {
          const slot = calls.find((c) => c.index === body.index) ?? calls[calls.length - 1];
          if (slot) {
            const part = delta.partial_json ?? '';
            slot.argsText += part;
            if (part.length > 0) emit?.({ type: 'tool_call_delta', index: slot.index, id: slot.id, argumentsText: part });
          }
        }
        return null;
      }
      if (type === 'message_delta') {
        this.finishReason = mapStop(body.delta?.stop_reason);
        if (body.usage?.output_tokens !== undefined) this.usage.outputTokens = body.usage.output_tokens;
        return null;
      }
      if (type === 'message_stop') {
        this.completed = true;
        this.finishReason = this.finishReason ?? (calls.length > 0 ? 'tool_calls' : 'stop');
        return null;
      }
      if (type === 'error') {
        const message = body.error?.message ?? 'anthropic reported a stream error';
        throw new ProviderError('HTTP_ERROR', `messages stream failed: ${message}`, { detail: body });
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
  for (const block of body?.content ?? []) {
    if (block?.type === 'text') text += block.text ?? '';
    if (block?.type === 'tool_use') {
      calls.push({
        id: block.id ?? `toolu_${calls.length}`,
        name: block.name ?? '',
        argsText: JSON.stringify(block.input ?? {}),
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
    finishReason: mapStop(body?.stop_reason),
    completed: true,
  };
}
