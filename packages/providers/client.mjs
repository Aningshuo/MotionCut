/**
 * 统一 `complete()`（WP19）。
 *
 * 三种 wire 共用同一条流水线：预算/并发 → 组请求 → fetch → SSE 逐帧 → wire 累积
 * → 结构化 toolCalls + usage。差别全在 `wire-*.mjs` 里，这里只做协议无关的事。
 *
 * 四个"必须明确"的地方：
 * 1. 取消与超时分开（`CANCELLED` / `TIMEOUT`），且都真的把 socket 关掉；
 * 2. 断流/坏 JSON → `PROVIDER_PROTOCOL_ERROR`，不把半截文本当成功；
 * 3. 模型不支持工具 → 明确 `degraded`（去掉 tools 重试一次），不伪造 toolCalls；
 * 4. Key 只在 header 里出现一次，错误消息与序列化一律过 redact。
 */

import { createDeadline, createLimiter, resolveMaxOutputTokens } from './budget.mjs';
import { codeForStatus, isUnsupportedToolsError, parseRetryAfter, ProviderError } from './errors.mjs';
import { isDoneFrame, SseDecoder } from './sse.mjs';
import { registerSecret, redactText, redactValue } from './redact.mjs';
import * as chat from './wire-openai-chat.mjs';
import * as responses from './wire-openai-responses.mjs';
import * as anthropic from './wire-anthropic-messages.mjs';

export const WIRES = Object.freeze({
  'openai-chat': chat,
  'openai-responses': responses,
  'anthropic-messages': anthropic,
});

/** @typedef {'openai-chat' | 'openai-responses' | 'anthropic-messages'} WireName */

/**
 * @typedef {{ role: 'system' | 'user' | 'assistant', content: string }} Message
 * @typedef {{ name: string, description?: string, parameters?: Record<string, unknown> }} ToolSpec
 * @typedef {{ id: string, name: string, arguments: Record<string, unknown>, argumentsText: string }} ToolCall
 */

/**
 * @param {{
 *   wire: WireName,
 *   baseUrl: string,
 *   apiKey: string,
 *   model: string,
 *   maxOutputTokens?: number,
 *   timeoutMs?: number,
 *   maxConcurrent?: number,
 *   headers?: Record<string, string>,
 *   fetchImpl?: typeof fetch,
 *   anthropicVersion?: string,
 *   retry?: { maxAttempts?: number, baseDelayMs?: number, maxDelayMs?: number, sleep?: (ms: number, signal?: AbortSignal) => Promise<void> },
 * }} options
 */
export function createProvider(options) {
  const wireModule = WIRES[options.wire];
  if (!wireModule) {
    throw new ProviderError('INVALID_REQUEST', `unknown wire: ${String(options.wire)}`);
  }
  if (typeof options.apiKey !== 'string' || options.apiKey.length === 0) {
    throw new ProviderError('KEY_MISSING', 'apiKey is required (BYOK: the user supplies it, we never ship one)');
  }
  registerSecret(options.apiKey);

  const baseUrl = options.baseUrl;
  const model = options.model;
  const ceiling = options.maxOutputTokens ?? 1024;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const limiter = createLimiter(options.maxConcurrent ?? 2);
  const fetchImpl = options.fetchImpl ?? fetch;
  const extraHeaders = options.headers ?? {};
  const retryOptions = options.retry ?? {};
  const maxAttempts = Math.max(1, Math.floor(retryOptions.maxAttempts ?? 3));
  const baseDelayMs = Math.max(0, retryOptions.baseDelayMs ?? 600);
  const maxDelayMs = Math.max(baseDelayMs, retryOptions.maxDelayMs ?? 8000);
  const sleep = retryOptions.sleep ?? defaultSleep;

  /**
   * @param {Response} response
   * @returns {Promise<never>}
   */
  async function throwHttp(response) {
    const text = await response.text().catch(() => '');
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* 非 JSON 错误体：保留原文，后面统一 redact */
    }
    const message =
      parsed?.error?.message ?? parsed?.message ?? (text.length > 0 ? text.slice(0, 300) : response.statusText);
    /* 限流不是「重试就好」：优先尊重服务端给的 Retry-After（秒数或 HTTP 日期），
       没给才走指数退避。header 拿不到时再看常见的 body 字段。 */
    const headerRetry = parseRetryAfter(response.headers?.get?.('retry-after') ?? null);
    const bodyRetryRaw = parsed?.error?.retry_after ?? parsed?.retry_after ?? parsed?.error?.retryAfterMs ?? null;
    const bodyRetry = typeof bodyRetryRaw === 'number' && Number.isFinite(bodyRetryRaw)
      ? Math.max(0, Math.round(bodyRetryRaw > 1000 ? bodyRetryRaw : bodyRetryRaw * 1000))
      : parseRetryAfter(typeof bodyRetryRaw === 'string' ? bodyRetryRaw : null);
    throw new ProviderError(codeForStatus(response.status), `HTTP ${response.status}: ${redactText(String(message))}`, {
      status: response.status,
      retryable: response.status === 429 || response.status >= 500,
      retryAfterMs: headerRetry ?? bodyRetry,
      detail: redactValue(parsed ?? text.slice(0, 300)),
    });
  }

  /**
   * @param {{ messages: Message[], tools?: ToolSpec[], maxOutputTokens?: number, timeoutMs?: number, enableTools?: boolean }} req
   * @param {{ signal?: AbortSignal, onDelta?: (delta: string) => void, onEvent?: (event: any) => void, stream?: boolean }} [opts]
   */
  async function once(req, opts = {}) {
    const stream = opts.stream ?? true;
    /** 统一事件出口：wire 只报协议相关（tool/usage），文本/结束由这里补齐。 */
    const emit = typeof opts.onEvent === 'function' ? opts.onEvent : null;
    const maxOutputTokens = resolveMaxOutputTokens(req.maxOutputTokens, ceiling);
    const built = wireModule.buildRequest(
      {
        model,
        messages: req.messages,
        tools: req.enableTools === false ? [] : req.tools ?? [],
        maxOutputTokens,
        stream,
      },
      { baseUrl, ...(options.anthropicVersion ? { anthropicVersion: options.anthropicVersion } : {}) },
    );

    const deadline = createDeadline({ signal: opts.signal, timeoutMs: req.timeoutMs ?? timeoutMs });
    /** @type {Response | null} */
    let response = null;
    try {
      response = await fetchImpl(built.url, {
        method: 'POST',
        headers: { ...built.headers, ...wireModule.authHeaders(options.apiKey), ...extraHeaders },
        body: JSON.stringify(built.body),
        signal: deadline.signal,
      }).catch((err) => {
        throw mapAbort(err, deadline);
      });

      if (!response.ok) await throwHttp(response);

      if (!stream) {
        const body = await response.json().catch(() => {
          throw new ProviderError('PROVIDER_PROTOCOL_ERROR', 'response body is not valid JSON');
        });
        const parsed = wireModule.parseFull(body);
        return finalize(parsed);
      }

      const decoder = new SseDecoder();
      const accumulator = wireModule.createAccumulator();
      const body = response.body;
      if (!body) throw new ProviderError('PROVIDER_PROTOCOL_ERROR', 'streaming response has no body');

      try {
        for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (/** @type {unknown} */ (body))) {
          for (const frame of decoder.push(chunk)) {
            if (isDoneFrame(frame)) {
              accumulator.completed = true;
              continue;
            }
            const usageBefore = `${String(accumulator.usage?.inputTokens ?? 0)}/${String(accumulator.usage?.outputTokens ?? 0)}`;
            const delta = accumulator.onFrame(frame, emit);
            if (delta) {
              if (opts.onDelta) opts.onDelta(delta);
              emit?.({ type: 'text_delta', text: delta });
            }
            const usageAfter = `${String(accumulator.usage?.inputTokens ?? 0)}/${String(accumulator.usage?.outputTokens ?? 0)}`;
            if (usageAfter !== usageBefore) emit?.({ type: 'usage', usage: { ...accumulator.usage } });
          }
          if (accumulator.completed) break;
        }
        for (const frame of decoder.end()) {
          if (isDoneFrame(frame)) {
            accumulator.completed = true;
            continue;
          }
          const usageBefore = `${String(accumulator.usage?.inputTokens ?? 0)}/${String(accumulator.usage?.outputTokens ?? 0)}`;
          const delta = accumulator.onFrame(frame, emit);
          if (delta) {
            if (opts.onDelta) opts.onDelta(delta);
            emit?.({ type: 'text_delta', text: delta });
          }
          const usageAfter = `${String(accumulator.usage?.inputTokens ?? 0)}/${String(accumulator.usage?.outputTokens ?? 0)}`;
          if (usageAfter !== usageBefore) emit?.({ type: 'usage', usage: { ...accumulator.usage } });
        }
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        const raw = /** @type {any} */ (err);
        // 取消/超时由外层按 deadline 判定；其余读流错误就是"流断了"
        if (raw?.name === 'AbortError' || raw?.code === 'ABORT_ERR') throw err;
        throw new ProviderError('PROVIDER_PROTOCOL_ERROR', `stream interrupted: ${raw?.message ?? String(raw)}`, {
          cause: err,
        });
      } finally {
        // 提前 break 时把连接放掉，别留悬挂 socket（A4）
        await body.cancel().catch(() => {});
      }

      if (!accumulator.completed) {
        throw new ProviderError('PROVIDER_PROTOCOL_ERROR', 'stream ended before the provider finished (truncated)');
      }

      return finalize(accumulator);
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw mapAbort(err, deadline);
    } finally {
      deadline.cleanup();
    }
  }

  /**
   * @param {{ text: string, toolCalls: any[], usage: { inputTokens: number, outputTokens: number }, finishReason: string | null }} accumulator
   */
  function finalize(accumulator) {
    /** @type {ToolCall[]} */
    const toolCalls = [];
    for (const call of accumulator.toolCalls ?? []) {
      if (!call.name) continue; // 没有名字的分片不是一次调用
      const argumentsText = call.argsText.trim().length > 0 ? call.argsText : '{}';
      let parsedArgs;
      try {
        parsedArgs = JSON.parse(argumentsText);
      } catch {
        throw new ProviderError(
          'PROVIDER_PROTOCOL_ERROR',
          `tool call ${call.id || call.name} has invalid JSON arguments`,
          { detail: { name: call.name, argumentsText: argumentsText.slice(0, 200) } },
        );
      }
      toolCalls.push({
        id: call.id || `call_${toolCalls.length}`,
        name: call.name,
        arguments: parsedArgs,
        argumentsText,
      });
    }
    return {
      text: accumulator.text,
      toolCalls,
      usage: accumulator.usage,
      finishReason: accumulator.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
      completed: true,
    };
  }

  return {
    wire: options.wire,
    model,
    baseUrl,
    /** 安全描述：不含 Key。 */
    describe() {
      return { wire: options.wire, model, baseUrl, key: 'present', maxOutputTokens: ceiling, timeoutMs };
    },

    /**
     * @param {{ messages: Message[], tools?: ToolSpec[], maxOutputTokens?: number, timeoutMs?: number }} request
     * @param {{ signal?: AbortSignal, onDelta?: (delta: string) => void, onEvent?: (event: any) => void, stream?: boolean }} [opts]
     */
    async complete(request, opts = {}) {
      if (!Array.isArray(request?.messages) || request.messages.length === 0) {
        throw new ProviderError('INVALID_REQUEST', 'messages must be a non-empty array');
      }
      const wanted = Boolean(request.tools?.length);
      const emit = typeof opts.onEvent === 'function' ? opts.onEvent : null;
      return limiter.run(async () => {
        for (let attempt = 1; ; attempt += 1) {
          try {
            const result = await once(request, opts);
            emit?.({ type: 'done', finishReason: result.finishReason, usage: { ...result.usage } });
            return { ...result, wire: options.wire, model, streamed: opts.stream ?? true, attempts: attempt };
          } catch (err) {
            const failure = err instanceof ProviderError ? err : mapAbort(err, { reason: () => null });
            // 模型明确说不支持工具：去掉 tools 再来一次，并如实标记降级（A8）
            if (wanted && failure.code === 'HTTP_ERROR' && failure.status === 400 && isUnsupportedToolsError(failure.detail)) {
              const result = await once({ ...request, enableTools: false }, opts);
              emit?.({ type: 'done', finishReason: result.finishReason, usage: { ...result.usage }, degraded: 'tools-unsupported' });
              return {
                ...result,
                wire: options.wire,
                model,
                streamed: opts.stream ?? true,
                attempts: attempt,
                degraded: { tools: 'unsupported', reason: 'provider rejected tools; retried without them' },
              };
            }
            /* 限流/5xx 的重试预算：取消立刻停，鉴权/协议/参数错误不重试。 */
            const retryable = failure.code === 'RATE_LIMITED' || (failure.code === 'HTTP_ERROR' && failure.retryable === true);
            if (!retryable || attempt >= maxAttempts || opts.signal?.aborted === true) throw failure;
            const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
            const delayMs = Math.min(maxDelayMs, failure.retryAfterMs ?? backoff) + Math.floor(Math.random() * 120);
            emit?.({ type: 'retry', attempt, nextAttempt: attempt + 1, maxAttempts, code: failure.code, status: failure.status, delayMs });
            await sleep(delayMs, opts.signal);
          }
        }
      });
    },
  };
}

/**
 * AbortError → CANCELLED / TIMEOUT；其它网络错误 → HTTP_ERROR。
 * @param {unknown} err
 * @param {{ reason: () => 'external' | 'timeout' | null }} deadline
 * @returns {ProviderError}
 */
function mapAbort(err, deadline) {
  if (err instanceof ProviderError) return err;
  const raw = /** @type {any} */ (err);
  // abort 的形状因运行时/原因而异（DOMException、TypeError: fetch failed、自定义 reason），
  // 所以先信 deadline 的记录，再看 AbortError 特征。
  const reason = deadline.reason();
  if (reason === 'timeout') return new ProviderError('TIMEOUT', 'request exceeded its deadline');
  if (reason === 'external') return new ProviderError('CANCELLED', 'request was cancelled');
  if (raw?.name === 'AbortError' || raw?.code === 'ABORT_ERR') {
    return new ProviderError('CANCELLED', 'request was cancelled');
  }
  return new ProviderError('HTTP_ERROR', `network failure: ${raw?.message ?? String(raw)}`, { cause: err });
}


/**
 * 工具循环（CS2 · AC11）：模型 → 工具 → 结果回灌 → 再问，直到不再要工具。
 *
 * 三件事必须成立：
 * 1. **协议形状由 wire 决定**：工具结果以各协议自己的 item/block 形式回灌
 *    （Chat `role:"tool"`、Responses `function_call_output`、Anthropic `tool_result`）；
 * 2. **取消穿透**：signal 在任意一轮中断 → CANCELLED，不再发起下一次调用；
 * 3. **预算有上限**：maxRounds 到了还想要工具 → TOOL_LOOP_LIMIT，不无限循环。
 *
 * execute(call) 返回 `{ content, isError? }` 或直接字符串；抛错按工具失败回灌，
 * 让模型有机会改参数（这也是真实 Agent 的常见行为）。
 *
 * @param {{ complete: Function }} provider
 * @param {{ messages: any[], tools?: any[], maxOutputTokens?: number, timeoutMs?: number }} request
 * @param {{ execute: (call: any, meta: { round: number, signal?: AbortSignal }) => Promise<any> | any, maxRounds?: number, signal?: AbortSignal, stream?: boolean, onEvent?: (event: any) => void, onDelta?: (delta: string) => void }} opts
 */
export async function runToolLoop(provider, request, opts) {
  const maxRounds = Math.max(1, Math.floor(opts?.maxRounds ?? 6));
  const messages = [...request.messages];
  const rounds = [];
  const usage = { inputTokens: 0, outputTokens: 0 };

  for (let round = 0; round < maxRounds; round += 1) {
    if (opts?.signal?.aborted) throw new ProviderError('CANCELLED', 'request was cancelled');
    const result = await provider.complete({ ...request, messages }, {
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(opts?.stream !== undefined ? { stream: opts.stream } : {}),
      ...(opts?.onEvent ? { onEvent: opts.onEvent } : {}),
      ...(opts?.onDelta ? { onDelta: opts.onDelta } : {}),
    });
    usage.inputTokens += Number(result.usage?.inputTokens ?? 0);
    usage.outputTokens += Number(result.usage?.outputTokens ?? 0);
    const calls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
    rounds.push({ round, text: result.text, toolCalls: calls, finishReason: result.finishReason, usage: { ...result.usage } });
    if (calls.length === 0) {
      return { text: result.text, rounds, messages, usage, finishReason: result.finishReason, toolCalls: [] };
    }
    messages.push({ role: 'assistant', content: result.text, toolCalls: calls });
    for (const call of calls) {
      if (opts?.signal?.aborted) throw new ProviderError('CANCELLED', 'request was cancelled');
      let outcome;
      try {
        outcome = await opts.execute(call, { round, signal: opts?.signal });
      } catch (error) {
        outcome = { content: String(/** @type {Error} */ (error)?.message ?? error), isError: true };
      }
      const content = typeof outcome === 'string' ? outcome : String(outcome?.content ?? '');
      const isError = typeof outcome === 'object' && outcome !== null && outcome.isError === true;
      messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content, isError });
      opts?.onEvent?.({ type: 'tool_result', id: call.id, name: call.name, ok: !isError, contentLength: content.length });
    }
  }
  throw new ProviderError('TOOL_LOOP_LIMIT', `tool loop exceeded ${maxRounds} rounds without a final answer`);
}

/**
 * 可被 signal 打断的 sleep（重试退避用）。取消时立即返回，让下一轮循环抛 CANCELLED。
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve(undefined);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(undefined);
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}
