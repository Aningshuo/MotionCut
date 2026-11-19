/**
 * 真实 provider 的 HTTP 适配层（M90 · WP19）。
 *
 * ## 它做什么 / 不做什么
 *
 * **做**：把一次「生成场景」翻译成一个 HTTP 请求，把响应（SSE 或 JSON）读成
 * `{ops, summary, warnings, toolCalls}`，把各种失败**分成不同的 code**。
 * **不做**：不解析成场景、不猜意图、不修补坏 ops——那是 provider 的事，
 * 产品这边的闸门（`agent-scene.mjs`）会拿现有 ops 校验器再验一遍。
 *
 * ## 为什么要 stub 才敢说「能跑」
 *
 * 仓库里没有任何真实 key。没有 key 就只剩两种诚实做法：要么说「没验」，
 * 要么用**本地 stub** 把 HTTP 契约跑通（`scripts/lib/` 下的验收链目录）。
 * 这个文件是第二种：协议、超时、重试、错误分类都是真的，只是对面不是真模型。
 * 证据里每条都标 `provider: "stub"`，**不许**当成 AI 生成能力。
 *
 * ## 错误码（刻意分开，不许统一成 AGENT_FAILED）
 *
 * | code | 什么时候 |
 * |---|---|
 * | `PROVIDER_UNAUTHORIZED` | 401 / 403。**不重试**、不降级到 mock |
 * | `PROVIDER_TIMEOUT` | 超过 `timeoutMs` 还没拿到完整响应（含读流中途） |
 * | `PROVIDER_RATE_LIMITED` | 429 且重试**耗尽** |
 * | `PROVIDER_BAD_STREAM` | SSE 帧不是 JSON、流里既没有 ops 也没有工具调用 |
 * | `PROVIDER_HTTP_ERROR` | 其它非 2xx（5xx 重试耗尽也归这里，`status` 带原码） |
 *
 * ## 重试
 *
 * 写死：**最多 2 次**（即最多 3 个请求），**只对 429/5xx**，间隔有上限
 * （`baseDelayMs × 2^n`，封顶 `maxDelayMs`；429 带 `Retry-After` 时用它，但同样封顶）。
 * 401 一次都不重试——重试 401 只是把同一个错误问三遍。
 *
 * ## 超时
 *
 * 每次尝试一个新 `AbortController`，`timeoutMs` 到点就 abort（**读流也算在同一个预算里**，
 * 否则「连上了但永不返回」能挂死）。默认 8000ms，可用
 * `OPENCUT_AGENT_SCENE_TIMEOUT_MS` 覆盖（验收要把它调到 800ms 才测得起）。
 */

/** 默认超时：一次场景生成最多等 8s。 */
export const DEFAULT_TIMEOUT_MS = 8000;

/** 重试策略（写死，证据里要能对着这几个数复核）。 */
export const RETRY_POLICY = Object.freeze({
  maxRetries: 2,
  retryableStatus: Object.freeze([429, 500, 502, 503, 504]),
  baseDelayMs: 120,
  maxDelayMs: 1000,
});

/** 错误码常量（外部按字符串比，不许各写各的）。 */
export const PROVIDER_CODES = Object.freeze({
  UNAUTHORIZED: 'PROVIDER_UNAUTHORIZED',
  TIMEOUT: 'PROVIDER_TIMEOUT',
  RATE_LIMITED: 'PROVIDER_RATE_LIMITED',
  BAD_STREAM: 'PROVIDER_BAD_STREAM',
  HTTP_ERROR: 'PROVIDER_HTTP_ERROR',
});

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, any>} [extra]
 */
function providerError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

/** @param {number} ms */
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * `Retry-After` 既可能是秒数也可能是 HTTP 日期；两种都认，**都要封顶**。
 * @param {string|null} value
 * @param {number} capMs
 * @returns {number|null}
 */
export function parseRetryAfter(value, capMs = RETRY_POLICY.maxDelayMs) {
  if (value === null || String(value).trim() === '') return null;
  const text = String(value).trim();
  const asNumber = Number(text);
  let ms = Number.NaN;
  if (Number.isFinite(asNumber)) ms = asNumber * 1000;
  else {
    const at = Date.parse(text);
    if (Number.isFinite(at)) ms = Math.max(0, at - Date.now());
  }
  if (!Number.isFinite(ms)) return null;
  return Math.min(capMs, Math.max(0, Math.round(ms)));
}

/**
 * 把 SSE 文本解析成帧。
 *
 * 只认 `data:` 行（`event:`/`id:`/注释行按规范忽略）；`[DONE]` 是终止符。
 * 一帧里多行 `data:` 用换行拼回去（规范如此）。
 *
 * @param {string} text 已经切好的一段（不含结尾空行）
 * @returns {{frames: any[], done: boolean}}
 */
export function parseSseChunk(text) {
  /** @type {string[]} */
  const dataLines = [];
  let done = false;
  for (const line of String(text).split('\n')) {
    if (!line.startsWith('data:')) continue;
    const value = line.slice(5).replace(/^ /, '');
    if (value.trim() === '[DONE]') {
      done = true;
      continue;
    }
    dataLines.push(value);
  }
  if (dataLines.length === 0) return { frames: [], done };
  const payload = dataLines.join('\n');
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw providerError(PROVIDER_CODES.BAD_STREAM, `provider 的 SSE 帧不是 JSON：${payload.slice(0, 120)}`, {
      frame: payload.slice(0, 400),
    });
  }
  return { frames: [parsed], done };
}

/**
 * 把一串帧累加成一次生成结果。
 *
 * **工具帧单独收**：`tool_use` 只进 `toolCalls`，绝不拼进 `summary`/文本——
 * 否则界面会把一整段工具 JSON 当成人话念给用户听。
 *
 * @param {any[]} frames
 */
function accumulate(frames) {
  /** @type {any[]} */
  let ops = [];
  /** @type {any[]} */
  const toolCalls = [];
  /** @type {string[]} */
  const texts = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {string[]} */
  const targets = [];
  let summary = '';
  let provider = '';
  const ignoredTypes = new Set();

  for (const frame of frames) {
    if (frame === null || typeof frame !== 'object') continue;
    const type = typeof frame.type === 'string' ? frame.type : '';
    if (type === 'tool_use' || type === 'tool_call' || type === 'tool-call') {
      toolCalls.push({
        id: String(frame.id ?? ''),
        name: String(frame.name ?? frame.tool ?? ''),
        input: frame.input ?? frame.arguments ?? null,
      });
      continue;
    }
    if (type === 'text' || type === 'delta') {
      if (typeof frame.text === 'string') texts.push(frame.text);
      if (typeof frame.delta === 'string') texts.push(frame.delta);
      continue;
    }
    if (type === 'error') {
      throw providerError(PROVIDER_CODES.BAD_STREAM, `provider 在流里报了错：${String(frame.message ?? frame.error ?? '')}`, {
        frame,
      });
    }
    if (Array.isArray(frame.ops)) ops = frame.ops;
    if (Array.isArray(frame.targets)) targets.push(...frame.targets.map(String));
    if (typeof frame.summary === 'string' && frame.summary !== '') summary = frame.summary;
    if (Array.isArray(frame.warnings)) warnings.push(...frame.warnings.map(String));
    if (typeof frame.provider === 'string' && frame.provider !== '') provider = frame.provider;
    if (type !== '' && !Array.isArray(frame.ops)) ignoredTypes.add(type);
  }

  return {
    ops,
    targets,
    toolCalls,
    warnings,
    summary: summary !== '' ? summary : texts.join(''),
    text: texts.join(''),
    ...(provider !== '' ? { provider } : {}),
    ignoredTypes: [...ignoredTypes],
  };
}

/**
 * 读 SSE 响应体。**边读边切帧**，不是先 `text()` 再切——那样超时取消不了。
 *
 * @param {ReadableStream<Uint8Array>} body
 * @param {AbortSignal} signal
 */
async function readSse(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  /** @type {any[]} */
  const frames = [];
  let buffer = '';
  let done = false;
  const drain = (flush = false) => {
    for (;;) {
      const index = buffer.indexOf('\n\n');
      if (index < 0) break;
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const parsed = parseSseChunk(chunk);
      frames.push(...parsed.frames);
      if (parsed.done) done = true;
    }
    if (flush && buffer.trim() !== '') {
      const parsed = parseSseChunk(buffer);
      frames.push(...parsed.frames);
      if (parsed.done) done = true;
      buffer = '';
    }
  };
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done === true) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    drain();
    if (done) {
      await reader.cancel().catch(() => undefined);
      break;
    }
    if (signal.aborted) break;
  }
  buffer += decoder.decode();
  drain(true);
  return frames;
}

/**
 * 建一个 HTTP provider。
 *
 * `apiKey`（B-SUB1-R31-054）：用户自己填的 key，随每次请求现取（可传字符串或
 * `() => Promise<string|null>`）。只在**有值**时加 `authorization: Bearer …`；
 * 没有就不发这个头——「清除了 key 还带着旧头」是比不发更糟的 bug。
 *
 * @param {{
 *   url: string,
 *   id?: string,
 *   apiKey?: string | (() => Promise<string | null> | string | null),
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   retry?: Partial<typeof RETRY_POLICY>,
 * }} input
 */
export function createHttpProvider(input) {
  const id = typeof input.id === 'string' && input.id !== '' ? input.id : 'http';
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = Number.isFinite(input.timeoutMs) ? Number(input.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const retry = { ...RETRY_POLICY, ...(input.retry ?? {}) };
  const retryable = new Set(retry.retryableStatus);
  /** @type {string | (() => Promise<string | null> | string | null) | null} */
  let keySource = input.apiKey ?? null;

  /** 每次请求现取；取不到就不带头。key 本身**不进**错误消息。 */
  async function currentKey() {
    if (keySource === null) return '';
    const value = typeof keySource === 'function' ? await keySource() : keySource;
    return typeof value === 'string' ? value.trim() : '';
  }

  return {
    id,
    mock: false,
    timeoutMs,
    retryPolicy: { ...retry, retryableStatus: [...retry.retryableStatus] },

    /**
     * 给宿主换一个 key 源（设置里改了 key 不必重建 provider）。
     * @param {string | (() => Promise<string | null> | string | null) | null} next
     */
    setApiKeySource(next) {
      keySource = next;
    },

    /** @param {any} request */
    async generate(request) {
      /** @type {any} */
      let lastError = null;
      let attempts = 0;
      /* R122（M8-A）：调用方的取消信号（服务端 run 取消）。
         外部信号一断，就别再重试 —— 取消不是「这次失败，换一次再来」。 */
      const external = request?.signal instanceof AbortSignal ? request.signal : null;
      if (external?.aborted === true) {
        throw providerError(PROVIDER_CODES.TIMEOUT, 'provider 调用已被取消（生成前）', { attempts: 0, retryable: false, cancelled: true });
      }

      for (let attempt = 0; attempt <= retry.maxRetries; attempt += 1) {
        attempts = attempt + 1;
        if (external?.aborted === true) break;
        const controller = new AbortController();
        const onExternalAbort = () => controller.abort();
        external?.addEventListener('abort', onExternalAbort, { once: true });
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const apiKey = await currentKey();
          const response = await fetchImpl(input.url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'text/event-stream, application/json',
              ...(apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` }),
            },
            /* R122（M8-B）：引用与聊天附件**随请求发出去** —— 远端模型是消费者，
               不给它内容就等于没引用。附件内容用 base64（Buffer 直接 JSON 会变成
               `{type:'Buffer',data:[...]}`，对方读不出来）。 */
            body: JSON.stringify({
              prompt: request?.prompt,
              seed: request?.seed,
              doc: request?.doc,
              ...(Array.isArray(request?.refs) && request.refs.length > 0 ? { refs: request.refs } : {}),
              ...(Array.isArray(request?.attachments) && request.attachments.length > 0
                ? {
                    attachments: request.attachments.map((/** @type {any} */ file) => ({
                      name: file.name,
                      kind: file.kind,
                      bytes: file.bytes,
                      sha256: file.sha256,
                      available: file.available,
                      head: file.head,
                      ...(file.data instanceof Uint8Array ? { data: Buffer.from(file.data).toString('base64') } : {}),
                    })),
                  }
                : {}),
            }),
            signal: controller.signal,
          });

          if (!response.ok) {
            const status = response.status;
            const detail = await response.text().catch(() => '');
            const common = { status, attempts, retryAfterMs: parseRetryAfter(response.headers.get('retry-after'), retry.maxDelayMs) };
            if (status === 401 || status === 403) {
              throw providerError(PROVIDER_CODES.UNAUTHORIZED, `provider 拒绝授权（${String(status)}）：${detail.slice(0, 160)}`, {
                ...common,
                retryable: false,
              });
            }
            if (status === 429) {
              throw providerError(PROVIDER_CODES.RATE_LIMITED, `provider 限流（429）：${detail.slice(0, 160)}`, {
                ...common,
                retryable: true,
              });
            }
            throw providerError(PROVIDER_CODES.HTTP_ERROR, `provider 返回 ${String(status)}：${detail.slice(0, 160)}`, {
              ...common,
              retryable: retryable.has(status),
            });
          }

          const contentType = String(response.headers.get('content-type') ?? '');
          /** @type {any[]} */
          let frames = [];
          if (contentType.includes('text/event-stream')) {
            if (response.body === null) {
              throw providerError(PROVIDER_CODES.BAD_STREAM, 'provider 说自己是 SSE，但没有响应体', { status: 200, attempts, retryable: false });
            }
            frames = await readSse(response.body, controller.signal);
          } else {
            const text = await response.text();
            let parsed;
            try {
              parsed = JSON.parse(text);
            } catch {
              throw providerError(PROVIDER_CODES.BAD_STREAM, `provider 的响应不是 JSON：${text.slice(0, 120)}`, {
                status: 200,
                attempts,
                retryable: false,
              });
            }
            frames = [parsed];
          }

          const result = accumulate(frames);
          if (result.ops.length === 0 && result.toolCalls.length === 0) {
            throw providerError(PROVIDER_CODES.BAD_STREAM, 'provider 的流里既没有 ops 也没有工具调用', {
              status: 200,
              attempts,
              retryable: false,
              frames: frames.length,
            });
          }
          return {
            ops: result.ops,
            targets: result.targets,
            summary: result.summary,
            warnings: result.warnings,
            toolCalls: result.toolCalls,
            ...(result.provider !== undefined ? { provider: result.provider } : {}),
            attempts,
            httpStatus: response.status,
          };
        } catch (error) {
          const isAbort = controller.signal.aborted === true || /** @type {any} */ (error)?.name === 'AbortError';
          const normalized = isAbort
            ? providerError(PROVIDER_CODES.TIMEOUT, `provider 超时：${String(timeoutMs)}ms 内没有拿到完整响应`, {
                attempts,
                timeoutMs,
                retryable: false,
              })
            : /** @type {any} */ (error);
          if (normalized.code === undefined) {
            normalized.code = PROVIDER_CODES.HTTP_ERROR;
          }
          normalized.attempts = attempts;
          lastError = normalized;
          const canRetry = normalized.retryable === true && attempt < retry.maxRetries && external?.aborted !== true;
          if (!canRetry) break;
          const backoff = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** attempt);
          const delay = typeof normalized.retryAfterMs === 'number' ? Math.min(retry.maxDelayMs, normalized.retryAfterMs) : backoff;
          await sleep(delay);
        } finally {
          clearTimeout(timer);
          external?.removeEventListener('abort', onExternalAbort);
        }
      }

      throw lastError ?? providerError(PROVIDER_CODES.HTTP_ERROR, 'provider 失败但没有留下错误', { attempts });
    },
  };
}
