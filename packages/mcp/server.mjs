/**
 * MCP server 核心（P8 / WP25）。
 *
 * 这一层不碰文件系统，只做协议、门禁与审计：
 *   消息进 → 校验 → 限流 → 执行 → 审计 → 响应出。
 *
 * 错误分层（A3/A5/A9 靠这个区分）：
 * - **协议错误**（-32700/-32600/-32601/-32602/-32603）：回 JSON-RPC `error`，
 *   参数错误时 `data.path` 指到具体字段；
 * - **领域错误**（E_WRITE_DENIED / E_CONFIRM_REQUIRED / E_PATH_ESCAPE / E_RATE_LIMITED …）：
 *   回 `tools/call` 的 `result`，带 `isError:true` 与稳定 `code`。
 *
 * 审计只记 `tool/argsHash/ok/code/durationMs`，不记参数原文（A6）。
 */

import crypto from 'node:crypto';
import path from 'node:path';

import { validate } from '../cli/jsonschema.mjs';
import { normalizeError } from '../cli/ops.mjs';
import { createAuditLog, hashArgs } from './audit.mjs';
import { createRateLimiter, DEFAULT_LIMIT, DEFAULT_WINDOW_MS } from './ratelimit.mjs';
import { LATEST_PROTOCOL, PROTOCOL_VERSIONS, RPC, rpcError, rpcResult } from './jsonrpc.mjs';
import { createTools } from './tools.mjs';

const SERVER_INFO = Object.freeze({ name: 'opencut-mcp', version: '0.2.0' });

/**
 * @param {string | undefined} requested
 * @returns {string}
 */
function negotiate(requested) {
  return typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL ?? '2025-06-18';
}

/**
 * @param {ReturnType<typeof import('../cli/ops.mjs').createContext>} ctx
 * @param {{ allowWrite?: boolean, instructions?: string, auditDir?: string, rateLimit?: number, rateWindowMs?: number, auditMaxBytes?: number, sessionId?: string, now?: () => number, studio?: { baseUrl: string, grantId: string, projectId?: string } }} [opts]
 */
export function createMcpServer(ctx, opts = {}) {
  const tools = createTools(ctx, {
    allowWrite: opts.allowWrite === true,
    ...(opts.studio !== undefined && opts.studio !== null ? { studio: opts.studio } : {}),
  });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const sessionId = opts.sessionId ?? crypto.randomUUID();
  const limiter = createRateLimiter({
    ...(opts.rateLimit !== undefined ? { limit: opts.rateLimit } : {}),
    ...(opts.rateWindowMs !== undefined ? { windowMs: opts.rateWindowMs } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  const audit = createAuditLog({
    dir: opts.auditDir ?? path.join(ctx.stateDir, 'audit'),
    session: sessionId,
    ...(opts.auditMaxBytes !== undefined ? { maxBytes: opts.auditMaxBytes } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });

  /**
   * @param {any} message
   * @returns {Promise<any>} null = 通知，不回
   */
  async function handle(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return rpcError(null, RPC.INVALID_REQUEST, 'invalid request: expected a JSON-RPC object');
    }
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
    const id = hasId ? message.id ?? null : null;

    if (message.jsonrpc !== '2.0') {
      return hasId ? rpcError(id, RPC.INVALID_REQUEST, 'invalid request: jsonrpc must be "2.0"') : null;
    }
    if (typeof message.method !== 'string' || message.method.length === 0) {
      return hasId ? rpcError(id, RPC.INVALID_REQUEST, 'invalid request: method is required') : null;
    }

    const method = message.method;
    const params = message.params;

    try {
      switch (method) {
        case 'initialize':
          return hasId
            ? rpcResult(id, {
                protocolVersion: negotiate(params?.protocolVersion),
                capabilities: { tools: { listChanged: false } },
                serverInfo: { ...SERVER_INFO },
                instructions:
                  opts.instructions ??
                  `opencut machine interface. Write tools need --allow-write AND "confirm": true on every call. ` +
                    `Paths are confined to the sandbox root. Rate limit: ${limiter.limit} tool calls / ${limiter.windowMs} ms.`,
              })
            : null;

        case 'notifications/initialized':
        case 'initialized':
          return null;

        case 'ping':
          return hasId ? rpcResult(id, {}) : null;

        case 'tools/list':
          return hasId
            ? rpcResult(id, {
                tools: tools.map((tool) => ({
                  name: tool.name,
                  title: tool.title,
                  description: tool.description,
                  inputSchema: tool.inputSchema,
                  annotations: { readOnlyHint: !tool.write, destructiveHint: tool.write },
                })),
              })
            : null;

        case 'tools/call': {
          if (!hasId) return null;
          if (!params || typeof params !== 'object' || Array.isArray(params)) {
            return rpcError(id, RPC.INVALID_PARAMS, 'invalid params: expected an object', { path: 'params' });
          }
          const { name, arguments: args } = params;
          if (typeof name !== 'string' || name.length === 0) {
            return rpcError(id, RPC.INVALID_PARAMS, 'invalid params: name is required', { path: 'params.name' });
          }
          const tool = byName.get(name);
          if (!tool) {
            return rpcError(id, RPC.INVALID_PARAMS, `invalid params: unknown tool "${name}"`, {
              path: 'params.name',
              tools: [...byName.keys()],
            });
          }
          const input = args ?? {};
          if (typeof input !== 'object' || Array.isArray(input)) {
            return rpcError(id, RPC.INVALID_PARAMS, 'invalid params: arguments must be an object', {
              path: 'params.arguments',
            });
          }
          const checked = validate(/** @type {any} */ (tool.inputSchema), input);
          if (!checked.ok) {
            const first = checked.errors[0];
            return rpcError(id, RPC.INVALID_PARAMS, `invalid params for ${name}`, {
              path: first?.path ?? null,
              errors: checked.errors.slice(0, 8),
            });
          }

          const argsHash = hashArgs(input);
          // 审计只记「有没有音频时间线」，不记片段路径/内容（素材路径属于用户数据）
          const auditExtra =
            name === 'export_start'
              ? { hasAudioMix: typeof input.audioMix === 'object' && input.audioMix !== null }
              : {};
          const rate = limiter.take();
          if (!rate.ok) {
            await audit.record({ tool: name, argsHash, ok: false, code: 'E_RATE_LIMITED', durationMs: 0, ...auditExtra });
            return rpcResult(
              id,
              toolResult(
                {
                  ok: false,
                  error: {
                    code: 'E_RATE_LIMITED',
                    message: `rate limit exceeded: ${limiter.limit} calls / ${limiter.windowMs} ms`,
                    retryAfterMs: rate.retryAfterMs,
                  },
                },
                true,
              ),
            );
          }

          const started = Date.now();
          try {
            const structured = await tool.run(input);
            await audit.record({
              tool: name,
              argsHash,
              ok: true,
              code: null,
              durationMs: Date.now() - started,
              ...auditExtra,
            });
            return rpcResult(id, toolResult(structured, false));
          } catch (err) {
            const failure = normalizeError(err);
            await audit.record({
              tool: name,
              argsHash,
              ok: false,
              code: failure.code,
              durationMs: Date.now() - started,
              ...auditExtra,
            });
            return rpcResult(id, toolResult({ ok: false, error: failure.toJSON() }, true));
          }
        }

        default:
          return hasId ? rpcError(id, RPC.METHOD_NOT_FOUND, `method not found: ${method}`) : null;
      }
    } catch (err) {
      return hasId ? rpcError(id, RPC.INTERNAL_ERROR, `internal error: ${normalizeError(err).message}`) : null;
    }
  }

  return {
    handle,
    sessionId,
    limiter,
    audit,
    tools: tools.map((tool) => ({ name: tool.name, write: tool.write })),
    /** 等审计落盘（测试/关闭用）。 */
    close: () => audit.flush(),
  };
}

/**
 * @param {unknown} structured
 * @param {boolean} isError
 */
function toolResult(structured, isError) {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
    isError,
  };
}

export { DEFAULT_LIMIT, DEFAULT_WINDOW_MS };
