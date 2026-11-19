/**
 * 最小 ACP 会话管理（WP17）。
 *
 * 协议：JSON-RPC 2.0，换行分隔，走子进程 stdin/stdout。方法与 contracts/agent.ts
 * 的事件类型一一对应；能力探测拿不到就是 false，不猜。
 *
 * 安全边界：
 * - 子进程 cwd 固定为工程目录；
 * - env 走白名单，且主动剔除含 TOKEN/SECRET/KEY/CREDENTIAL 的变量；
 * - 只 kill 自己 spawn 的进程组（detached 后按 -pid 杀），不碰用户其他进程；
 * - 拒绝 --allow-all / bypassPermissions / yolo 参数。
 *
 * @typedef {import('../../contracts/agent').SessionEvent} SessionEvent
 * @typedef {import('../../contracts/agent').AgentErrorCode} AgentErrorCode
 * @typedef {import('../../contracts/agent').AgentDescriptor} AgentDescriptor
 * @typedef {import('../../contracts/agent').PermissionRequest} PermissionRequest
 * @typedef {import('node:child_process').ChildProcessWithoutNullStreams} ChildProcess
 */

import { acpModelCatalog } from './acp-models.mjs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PermissionBroker, assertNoBypassArgs, classifyToolRequest, buildPermissionRequest, selectPermissionOption } from './permission.mjs';
import { mcpServersForSettings, readSettings } from '../studio/server/settings-store.mjs';

/** 默认放行的环境变量；不含任何凭据类变量。 */
export const DEFAULT_ENV_ALLOW = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
];

const SENSITIVE_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|AUTH)/i;

/**
 * 从白名单构造子进程 env；敏感键即使被显式加入白名单也会被剔除。
 * @param {Record<string, string | undefined>} source
 * @param {readonly string[]} allow
 * @returns {Record<string, string>}
 */
export function buildAgentEnv(source, allow = DEFAULT_ENV_ALLOW) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const key of allow) {
    if (SENSITIVE_ENV.test(key)) continue;
    const value = source[key];
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

/**
 * 日志脱敏：抹掉常见 token 形态并截断。
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
export function redact(text, max = 400) {
  const cleaned = text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b(sk|pk|ghp|gho|github_pat|xox[baprs])_[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, '[REDACTED]')
    .replace(/\bBearer\s+[^\s]+/gi, 'Bearer [REDACTED]');
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

/**
 * @template T
 */
class AsyncEventQueue {
  /** @type {T[]} */
  #buffer = [];
  /** @type {Array<(result: IteratorResult<T>) => void>} */
  #waiters = [];
  #closed = false;

  /** @param {T} item */
  push(item) {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.#buffer.push(item);
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  /** @returns {Promise<IteratorResult<T>>} */
  next() {
    const buffered = this.#buffer.shift();
    if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false });
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  /** @returns {AsyncIterableIterator<T>} */
  [Symbol.asyncIterator]() {
    /** @type {AsyncIterableIterator<T>} */
    const iterator = {
      next: () => this.next(),
      [Symbol.asyncIterator]() {
        return iterator;
      },
    };
    return iterator;
  }
}

/**
 * @typedef {Object} Session
 * @property {string} sessionId            本地 id
 * @property {string} agentSessionId       Agent 侧的 session id
 * @property {string} projectId
 * @property {string} cwd
 * @property {string} agentId
 * @property {ChildProcess} child
 * @property {AsyncEventQueue<SessionEvent>} queue
 * @property {'READY' | 'BUSY' | 'DISCONNECTED' | 'INCOMPATIBLE'} state
 * @property {string | null} turnId
 * @property {NodeJS.Timeout | null} turnTimer
 * @property {boolean} turnEnded
 * @property {Array<() => void>} turnWaiters
 * @property {Map<number, { resolve: (value: any) => void, reject: (err: Error) => void }>} pending
 * @property {number} seq
 * @property {number} badLines
 * @property {string} stderrTail
 * @property {AgentDescriptor} descriptor
 * @property {{ kind: string, label?: string, plan?: string } | null} authStatus
 * @property {ReturnType<typeof acpModelCatalog>} models
 * @property {string | null} currentModel
 * @property {string[]} transcript          真实 stdout 行（已脱敏），仅用于证据
 * @property {{ inputTokens?: number, outputTokens?: number, cost?: number } | null} turnUsage
 * @property {{ acp: boolean, http: boolean, sse: boolean } | null} mcpCapabilities
 * @property {Map<string, any>} toolInputs             toolCallId → rawInput（权限裁决要机器可读身份）
 * @property {any[]} authzLog                          本次会话的授权裁决记录（CS2；只增，上限 200 条）
 * @property {string | null} runId                     开这个会话时那一趟 run（票要绑它）
 * @property {Map<string, any>} pendingPermissions     等待用户答复的工具权限请求（CS3）
 * @property {any[]} permissionLog                     已终态的权限请求（过期/重复答复要能说清）
 * @property {number} permissionSeq
 * @property {string} [lastError]
 */

/** 一个 MCP server 在 ACP 里的三种运输方式（`session/new` 的 `type` 判别位）。 */
export const ACP_MCP_TRANSPORTS = Object.freeze(['stdio', 'http', 'sse', 'acp']);

/**
 * 读对端声明的 MCP 能力。缺失一律 false（“没声明”不等于“支持”）。
 * @param {any} init InitializeResponse
 * @returns {{ acp: boolean, http: boolean, sse: boolean }}
 */
export function readMcpCapabilities(init) {
  const caps = init?.agentCapabilities?.mcpCapabilities ?? {};
  return { acp: caps?.acp === true, http: caps?.http === true, sse: caps?.sse === true };
}

/**
 * 设置里的 MCP server（内部形状）→ **ACP 规范形状**。
 *
 * 这是 CS1 修掉的那处断链：`session/new` 的 `mcpServers` 是判别联合
 * （`{type:'stdio', command, args, env:[{name,value}]}` / `{type:'http', url, headers:[{name,value}]}`），
 * 直接把 `{name, command, args, env:{}}` 传过去会被对端拒成 `Invalid params`，
 * 整个会话开不起来（不是“工具不可用”，是连握手都过不去）。
 *
 * 规则：
 * - `type` 缺省按 `stdio`（设置面板只产出这一种）；
 * - `command` 必须是绝对路径（ACP 的 schema 是 zAbsolutePath）→ 非绝对时按 PATH 解析；
 * - `env` / `headers` 从对象转成 `[{name, value}]`；
 * - 对端明确声明不支持某种运输（例如 codex-acp 的 `{acp:false, http:true, sse:false}`）就**跳过并记账**，
 *   不硬塞——硬塞的结局同样是 Invalid params，而报错里看不出是哪一条。
 *
 * @param {Array<any>} servers
 * @param {{ capabilities?: { acp?: boolean, http?: boolean, sse?: boolean } | null, pathEnv?: string }} [opts]
 * @returns {{ servers: Array<Record<string, unknown>>, skipped: Array<{ name: string, reason: string }> }}
 */
export function toAcpMcpServers(servers, opts = {}) {
  const capabilities = opts.capabilities ?? null;
  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  /** @type {Array<{ name: string, reason: string }>} */
  const skipped = [];
  for (const server of Array.isArray(servers) ? servers : []) {
    if (!server || typeof server !== 'object') continue;
    const name = String(server.name ?? '').trim();
    if (name === '') continue;
    const type = ACP_MCP_TRANSPORTS.includes(server.type) ? server.type : 'stdio';
    if (capabilities && /** @type {any} */ (capabilities)[type] === false) {
      skipped.push({ name, reason: `UNSUPPORTED_TRANSPORT:${type}` });
      continue;
    }
    if (type === 'stdio') {
      const command = resolveCommandPath(String(server.command ?? ''), opts.pathEnv ?? process.env.PATH ?? '');
      if (command === null) {
        skipped.push({ name, reason: `COMMAND_NOT_FOUND:${String(server.command ?? '')}` });
        continue;
      }
      const env = toNameValuePairs(server.env);
      out.push({
        type: 'stdio',
        name,
        command,
        args: Array.isArray(server.args) ? server.args.map((/** @type {any} */ arg) => String(arg)) : [],
        env,
      });
      continue;
    }
    if (type === 'acp') {
      // ACP 中转：客户端只交身份（serverId），进程由对端自己管。
      out.push({ type: 'acp', name, serverId: String(server.serverId ?? name) });
      continue;
    }
    const url = String(server.url ?? '').trim();
    if (url === '') {
      skipped.push({ name, reason: 'URL_MISSING' });
      continue;
    }
    out.push({ type, name, url, headers: toNameValuePairs(server.headers) });
  }
  return { servers: out, skipped };
}


/**
 * MCP 工具调用的机器可读身份（ACP 的 rawInput 形状）。
 * @param {any} raw
 * @returns {{ server: string | null, tool: string } | null}
 */
export function subjectFromRawInput(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  if (typeof raw.tool !== 'string' || raw.tool === '') return null;
  return { server: typeof raw.server === 'string' ? raw.server : null, tool: raw.tool };
}

/**
 * 从工具标题里认身份：`mcp.<server>.<tool>` 或 `<server>/<tool>`。
 * 别的标题（`Read file` / `Edit files`）一律 null —— 宁可拒绝，不猜。
 * @param {any} title
 * @returns {{ server: string, tool: string } | null}
 */
export function subjectFromTitle(title) {
  const match = /^(?:mcp\.)?([a-z0-9_-]+)[./]([a-z0-9_-]+)$/i.exec(String(title ?? '').trim());
  if (match === null) return null;
  return { server: String(match[1]), tool: String(match[2]) };
}

/**
 * `{A:'1'}` 或 `[{name,value}]` → `[{name,value}]`。别的形状丢掉（宁可少传，不传垃圾）。
 * @param {any} source
 * @returns {Array<{ name: string, value: string }>}
 */
function toNameValuePairs(source) {
  if (Array.isArray(source)) {
    /** @type {Array<{ name: string, value: string }>} */
    const pairs = [];
    for (const item of source) {
      if (!item || typeof item !== 'object') continue;
      const name = String(item.name ?? '');
      if (name === '') continue;
      pairs.push({ name, value: String(item.value ?? '') });
    }
    return pairs;
  }
  if (source && typeof source === 'object') {
    return Object.entries(source).map(([name, value]) => ({ name, value: String(value ?? '') }));
  }
  return [];
}

/**
 * 绝对路径透传；裸命令名按 PATH 找。找不到回 null（调用方记 TODO 并跳过）。
 * @param {string} command
 * @param {string} pathEnv
 * @returns {string | null}
 */
export function resolveCommandPath(command, pathEnv) {
  const text = String(command ?? '').trim();
  if (text === '') return null;
  if (path.isAbsolute(text)) return text;
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, text);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* 继续找 */
    }
  }
  return null;
}


export class AgentSessions {
  /** @type {(projectId: string) => string} */
  #resolveProject;
  /** @type {string} */
  #command;
  /** @type {string[]} */
  #args;
  #turnTimeoutMs;
  #cancelGraceMs;
  #handshakeTimeoutMs;
  #envAllow;
  /** @type {Record<string, string>} */
  #extraEnv;
  /** @type {() => Promise<any>} */
  #settingsProvider;
  /** @type {PermissionBroker} */
  #broker;
  /** @type {((subject: { server: string | null, tool: string }, context: any) => any) | null} */
  #authorize;
  /** @type {((ctx: { projectId: string, sessionId: string, cwd: string, runId?: string | null }) => Promise<Array<Record<string, unknown>> | null>) | null} */
  #mcpServersProvider;
  /** CS3：权限请求交给界面（真实权限卡）而不是直接按 broker 拒掉。 */
  #permissionUi = false;
  /** CS3：权限卡的有效期；到点一律 deny，迟到的答复不再生效。 */
  #permissionTimeoutMs = 30_000;
  /** @type {Map<string, Session>} */
  #sessions = new Map();
  /** @type {Map<string, string>} */
  #byAgentSession = new Map();
  /** 被跳过的 MCP server（名字 + 原因），给 inspect() 用；不含 env 值。 @type {Array<{ name: string, reason: string }>} */
  #mcpSkipped = [];
  #closed = false;

  /**
   * @param {{
   *   resolveProject: (projectId: string) => string,
   *   command: string,
   *   args?: string[],
   *   turnTimeoutMs?: number,
   *   cancelGraceMs?: number,
   *   handshakeTimeoutMs?: number,
   *   envAllow?: readonly string[],
   *   permissionBroker?: PermissionBroker,
   *   permissionUi?: boolean,
   *   permissionTimeoutMs?: number,
   *   authorize?: ((subject: { server: string | null, tool: string }, context: any) => any) | null,
   *   mcpServersProvider?: ((ctx: { projectId: string, sessionId: string, cwd: string, runId?: string | null }) => Promise<Array<Record<string, unknown>> | null>) | null,
   *   extraEnv?: Record<string, string>,
   *   settingsProvider?: () => Promise<any>,
   * }} opts
   */
  constructor(opts) {
    if (typeof opts?.resolveProject !== 'function') {
      throw new TypeError('AgentSessions requires resolveProject(projectId)');
    }
    if (!opts.command) throw new TypeError('AgentSessions requires command');
    assertNoBypassArgs([opts.command, ...(opts.args ?? [])]);
    this.#resolveProject = opts.resolveProject;
    this.#command = opts.command;
    this.#args = opts.args ?? [];
    this.#turnTimeoutMs = opts.turnTimeoutMs ?? 30_000;
    this.#cancelGraceMs = opts.cancelGraceMs ?? 500;
    this.#handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 5_000;
    this.#envAllow = opts.envAllow ?? DEFAULT_ENV_ALLOW;
    this.#broker = opts.permissionBroker ?? new PermissionBroker();
    this.#permissionUi = opts.permissionUi === true;
    this.#permissionTimeoutMs = Number.isFinite(opts.permissionTimeoutMs)
      ? Math.max(100, Number(opts.permissionTimeoutMs))
      : 30_000;
    this.#authorize = typeof opts.authorize === 'function' ? opts.authorize : null;
    this.#mcpServersProvider = typeof opts.mcpServersProvider === 'function' ? opts.mcpServersProvider : null;
    this.#extraEnv = { ...(opts.extraEnv ?? {}) };
    // 设置读取（M65）：默认读 settings.json；测试可注入，避免依赖磁盘。
    this.#settingsProvider = opts.settingsProvider ?? (async () => (await readSettings()).settings);
    // 额外 env 只允许显式传入的非凭据变量；键名命中敏感模式的一律拒绝。
    for (const key of Object.keys(this.#extraEnv)) {
      if (SENSITIVE_ENV.test(key)) {
        throw new TypeError(`AgentSessions refuses sensitive env key: ${key}`);
      }
    }
  }

  /**
   * 本次会话要带的 MCP server（M65）。
   *
   * 只读设置、只对**新建会话**生效。读失败按空表处理：设置坏了不该连带开不了会话；
   * 这里也**不写任何日志**——`env` 值可能是密钥，出了问题只回错误码。
   *
   * CS1（R30-124）：返回值必须是 **ACP 规范形状**（带 `type` 判别位），不是设置里的
   * 内部形状。以前直接把 `{name, command, args, env:{}}` 原样塞进 `session/new`，
   * 对端按 `{type:'stdio'|'http'|'sse', …}` 解析 → `Invalid params`，会话根本开不起来。
   * @param {{ acp?: boolean, http?: boolean, sse?: boolean } | null} capabilities
   * @param {Session | null} [session] 本次会话（有它才走 per-session 配置）
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
  async #mcpServers(capabilities = null, session = null) {
    /* CS2：优先用**本次会话**的 MCP server 配置（按 grant 绑定工程/会话/run）。
       它由调用方在 open() 之后注入；返回 null 时才回落到设置里的全局表。 */
    if (this.#mcpServersProvider !== null && session !== null) {
      try {
        const perSession = await this.#mcpServersProvider({
          projectId: session.projectId,
          sessionId: session.sessionId,
          cwd: session.cwd,
          runId: session.runId,
        });
        if (Array.isArray(perSession)) {
          const { servers, skipped } = toAcpMcpServers(perSession, { capabilities });
          this.#mcpSkipped = skipped;
          return servers;
        }
      } catch {
        /* 回落设置：per-session 配置坏掉不该连带开不了会话，但 inspect 会显示 skipped */
      }
    }
    try {
      const raw = mcpServersForSettings(await this.#settingsProvider());
      const { servers, skipped } = toAcpMcpServers(raw, { capabilities });
      this.#mcpSkipped = skipped;
      return servers;
    } catch {
      this.#mcpSkipped = [];
      return [];
    }
  }

  /**
   * 只启动绑定 projectId 的会话；每次 open 都是一个独立进程，不复用。
   * @param {string} projectId
   * @param {string} agentId
   * @param {{ resume?: string, runId?: string | null }} [opts]
   * @returns {Promise<{ sessionId: string } | { error: AgentErrorCode, detail?: string }>}
   */
  async open(projectId, agentId, opts = {}) {
    if (this.#closed) return { error: 'SESSION_BIND_FAILED' };

    /** @type {string} */
    let cwd;
    try {
      cwd = this.#resolveProject(projectId);
    } catch {
      return { error: 'SESSION_BIND_FAILED' };
    }

    /** @type {ChildProcess} */
    let child;
    try {
      child = spawn(this.#command, this.#args, {
        cwd,
        env: { ...buildAgentEnv(process.env, this.#envAllow), ...this.#extraEnv },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch {
      return { error: 'SESSION_BIND_FAILED' };
    }

    const localId = `sess_${randomUUID()}`;
    /** @type {Session} */
    const session = {
      sessionId: localId,
      agentSessionId: '',
      projectId,
      cwd,
      agentId,
      child,
      queue: new AsyncEventQueue(),
      state: 'READY',
      turnId: null,
      turnTimer: null,
      turnEnded: true,
      turnWaiters: [],
      pending: new Map(),
      seq: 0,
      badLines: 0,
      stderrTail: '',
      descriptor: {
        id: agentId,
        displayName: agentId,
        state: 'PROBING',
        auth: 'UNKNOWN',
        capabilities: defaultCapabilities(),
      },
      authStatus: null,
      models: [],
      currentModel: null,
      transcript: [],
      turnUsage: null,
      mcpCapabilities: null,
      toolInputs: new Map(),
      authzLog: [],
      runId: typeof opts.runId === 'string' && opts.runId !== '' ? opts.runId : null,
      pendingPermissions: new Map(),
      permissionLog: [],
      permissionSeq: 0,
    };
    this.#sessions.set(localId, session);

    this.#wireStdio(session);

    const spawnError = await waitForSpawn(child);
    if (spawnError) {
      this.#sessions.delete(localId);
      session.queue.close();
      return { error: 'SESSION_BIND_FAILED' };
    }

    try {
      const init = await this.#request(session, 'initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          // 本客户端不代 Agent 读/写文件：不声明就不能被调用，避免「声明了但没人接」的挂起。
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: 'opencut', version: '0.0.0' },
      }, this.#handshakeTimeoutMs);

      session.descriptor = {
        ...session.descriptor,
        version: pickString(init?.agentInfo?.version),
        state: 'READY',
        auth: 'UNKNOWN',
        capabilities: readCapabilities(init),
      };

      // ACP：session/new 只接受 cwd + mcpServers（其余靠 session/load、config 选项）。
      // mcpServers 来自设置 `mcp.servers`（M65），但**必须转成 ACP 形状**（带 type 判别位），
      // 且要按对端声明的 mcpCapabilities 过滤——不支持 http 的对端收到 http 条目同样会 Invalid params。
      const mcpCapabilities = readMcpCapabilities(init);
      session.mcpCapabilities = mcpCapabilities;
      const created = await this.#request(session, 'session/new', {
        cwd,
        mcpServers: await this.#mcpServers(mcpCapabilities, session),
      }, this.#handshakeTimeoutMs);

      if (typeof created?.sessionId !== 'string' || created.sessionId.length === 0) {
        throw new Error('session/new returned no sessionId');
      }
      session.agentSessionId = created.sessionId;
      this.#byAgentSession.set(created.sessionId, localId);

      // 模型列表是能力证据，不是猜测：只有 Agent 真返回了才算 models 能力。
      session.models = acpModelCatalog(created);
      session.currentModel = created?.models?.currentModelId ?? session.models.find((item) => item.default)?.id ?? null;
      if (session.models.length > 0) {
        session.descriptor = {
          ...session.descriptor,
          capabilities: { ...session.descriptor.capabilities, models: true },
        };
      }
      return { sessionId: localId };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      session.lastError = detail;
      // 认证类错误必须显式区分，不能一律归成握手失败。
      const authRelated = /auth|login|log in|unauthor|credential|token expired|sign in/i.test(detail);
      const code = authRelated ? 'AGENT_NOT_LOGGED_IN' : 'ACP_HANDSHAKE_FAILED';
      session.descriptor = {
        ...session.descriptor,
        state: authRelated ? 'INSTALLED_NOT_LOGGED_IN' : 'INCOMPATIBLE',
        auth: authRelated ? 'LOGGED_OUT' : session.descriptor.auth,
      };
      session.queue.push({
        type: 'turn_end',
        reason: 'error',
        error: code,
      });
      await this.#killTree(session);
      this.#sessions.delete(localId);
      session.queue.close();
      return { error: code, detail };
    }
  }

  /** @param {string} sessionId */
  modelCatalog(sessionId) {
    return this.#sessions.get(sessionId)?.models ?? [];
  }

  /** @param {string} sessionId @param {string} modelId @param {string | null} effort */
  async selectModel(sessionId, modelId, effort) {
    const session = this.#sessions.get(sessionId);
    if (!session || session.turnId) throw new Error('SESSION_UNAVAILABLE');
    const model = session.models.find((item) => item.id === modelId);
    const wire = model?.wireIds[effort ?? ''];
    if (!wire) throw Object.assign(new Error(`会话未提供模型或思考强度：${modelId} / ${effort ?? ''}`), { code: 'MODEL_UNAVAILABLE' });
    if (wire !== session.currentModel) {
      if (model.configId) {
        await this.#request(session, 'session/set_config_option', { sessionId: session.agentSessionId, configId: model.configId, value: wire }, this.#handshakeTimeoutMs);
      } else {
        await this.#request(session, 'session/set_model', { sessionId: session.agentSessionId, modelId: wire }, this.#handshakeTimeoutMs);
      }
      session.currentModel = wire;
    }
    return wire;
  }

  /**
   * @param {string} sessionId
   * @param {string} input
   * @param {readonly string[]} [attachments]
   * @returns {Promise<{ turnId: string } | { error: AgentErrorCode }>}
   */
  async send(sessionId, input, attachments) {
    const session = this.#sessions.get(sessionId);
    if (!session) return { error: 'SESSION_BIND_FAILED' };
    if (session.state === 'INCOMPATIBLE') return { error: 'AGENT_INCOMPATIBLE' };
    if (session.state === 'DISCONNECTED') return { error: 'PROCESS_DIED' };
    if (session.turnId) throw new Error('TURN_IN_PROGRESS');

    const turnId = `turn_${++session.seq}`;
    session.turnId = turnId;
    session.turnEnded = false;
    session.state = 'BUSY';
    session.turnTimer = setTimeout(() => {
      if (session.turnId !== turnId || session.turnEnded) return;
      this.#finishTurn(session, 'error', 'TURN_TIMEOUT');
      void this.#killTree(session);
    }, this.#turnTimeoutMs);
    session.turnTimer.unref?.();

    /** ACP prompt 是 ContentBlock[]；附件用 resource_link，不自创字段。 */
    /** @type {Array<Record<string, unknown>>} */
    const content = [{ type: 'text', text: input }];
    for (const attachment of attachments ?? []) {
      content.push({
        type: 'resource_link',
        uri: pathToFileUri(attachment),
        name: attachment.split('/').pop() ?? attachment,
      });
    }

    const prompt = {
      sessionId: session.agentSessionId,
      prompt: content,
    };

    // 不等待本轮结束；send 只保证「已交给 Agent」，结果走 events。
    // ACP 的轮次结束由 session/prompt 的响应（stopReason）表示，不是自定义通知。
    void this.#request(session, 'session/prompt', prompt, Math.max(this.#turnTimeoutMs, 5_000))
      .then((result) => {
        if (session.turnId !== turnId || session.turnEnded) return;
        const stop = typeof result?.stopReason === 'string' ? result.stopReason : '';
        const reason = stop === 'cancelled' ? 'cancelled' : stop === 'refusal' ? 'error' : 'done';
        const usage = result?.usage;
        if (usage && typeof usage === 'object') {
          const inputTokens = numberOrUndefined(usage.inputTokens);
          const outputTokens = numberOrUndefined(usage.outputTokens);
          if (inputTokens !== undefined || outputTokens !== undefined) {
            session.queue.push({
              type: 'usage',
              ...(inputTokens !== undefined ? { inputTokens } : {}),
              ...(outputTokens !== undefined ? { outputTokens } : {}),
            });
          }
        }
        this.#finishTurn(
          session,
          /** @type {'done' | 'cancelled' | 'error'} */ (reason),
          reason === 'cancelled' ? 'TURN_CANCELLED' : reason === 'error' ? 'UNVERIFIED' : undefined,
        );
      })
      .catch((err) => {
        if (session.turnId !== turnId || session.turnEnded) return;
        const msg = err instanceof Error ? err.message : String(err);
        session.lastError = redact(msg, 400);
        this.#finishTurn(session, 'error', msg.includes('PROCESS_DIED') ? 'PROCESS_DIED' : 'UNVERIFIED');
      });

    return { turnId };
  }

  /**
   * 先发 ACP cancel；cancelGraceMs 内没结束则杀掉本会话进程树。
   * @param {string} sessionId
   * @param {string} turnId
   * @returns {Promise<void>}
   */
  async cancel(sessionId, turnId) {
    const session = this.#sessions.get(sessionId);
    if (!session || session.turnId !== turnId || session.turnEnded) return;

    const ended = new Promise((resolve) => session.turnWaiters.push(() => resolve(undefined)));
    try {
      session.child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/cancel',
          // ACP 的 cancel 是通知（无 id），参数只有 sessionId。
          params: { sessionId: session.agentSessionId },
        })}\n`,
      );
    } catch {
      // 管道已断，直接走强杀路径。
    }

    const timedOut = await Promise.race([
      ended.then(() => false),
      delay(this.#cancelGraceMs).then(() => true),
    ]);

    if (timedOut && !session.turnEnded) {
      this.#finishTurn(session, 'cancelled', 'TURN_CANCELLED');
      await this.#killTree(session);
    }
  }

  /**
   * @param {string} sessionId
   * @returns {AsyncIterable<SessionEvent>}
   */
  events(sessionId) {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return {
        async *[Symbol.asyncIterator]() {
          return;
        },
      };
    }
    return session.queue;
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  async close(sessionId) {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    if (session.turnId && !session.turnEnded) {
      await this.cancel(sessionId, session.turnId);
    }
    await this.#killTree(session);
    this.#sessions.delete(sessionId);
    if (session.agentSessionId) this.#byAgentSession.delete(session.agentSessionId);
    session.queue.close();
  }

  /**
   * 回收本线启动的进程；传 projectId 只回收该工程。
   * @param {string} [projectId]
   * @returns {Promise<void>}
   */
  async reap(projectId) {
    const targets = [...this.#sessions.values()].filter(
      (s) => projectId === undefined || s.projectId === projectId,
    );
    for (const session of targets) {
      if (session.turnId && !session.turnEnded) {
        this.#finishTurn(session, 'cancelled', 'TURN_CANCELLED');
      }
      await this.#killTree(session);
      this.#sessions.delete(session.sessionId);
      if (session.agentSessionId) this.#byAgentSession.delete(session.agentSessionId);
      session.queue.close();
    }
  }

  /** @returns {Promise<void>} */
  async dispose() {
    this.#closed = true;
    await this.reap();
  }

  /**
   * 观测用（测试断言无僵尸进程）。
   * @param {string} sessionId
   * @returns {{ pid: number | undefined, alive: boolean, state: string, cwd: string, projectId: string, runId: string | null, turnId: string | null, descriptor: AgentDescriptor, authStatus: { kind: string, label?: string, plan?: string } | null, mcp: { capabilities: any, skipped: Array<{ name: string, reason: string }> }, authz: any[], permissions: any[], permissionLog: any[], lastError: string | null } | null}
   */
  inspect(sessionId) {
    const session = this.#sessions.get(sessionId);
    if (!session) return null;
    const pid = session.child.pid;
    let alive = session.child.exitCode === null && session.child.signalCode === null;
    if (alive && typeof pid === 'number') {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
    }
    return /** @type {any} */ ({
      pid,
      alive,
      state: session.state,
      cwd: session.cwd,
      projectId: session.projectId,
      runId: session.runId,
      turnId: session.turnId,
      descriptor: session.descriptor,
      authStatus: session.authStatus,
      mcp: {
        capabilities: session.mcpCapabilities,
        skipped: [...this.#mcpSkipped],
      },
      /* CS2：本次会话的授权裁决（谁、哪张票、哪个工程、放行/拒绝、为什么）。 */
      authz: session.authzLog.slice(),
      /* CS3：真实权限卡的数据源 + 已终态记录（过期/重复答复要能回读）。 */
      permissions: [...session.pendingPermissions.values()].map((record) => ({
        id: record.id,
        sessionId: record.sessionId,
        projectId: record.projectId,
        toolCallId: record.toolCallId,
        detail: record.detail,
        kind: record.kind,
        subject: record.subject,
        authzReason: record.authzReason,
        options: record.options,
        requestedAt: new Date(record.requestedAt).toISOString(),
        expiresAt: new Date(record.expiresAt).toISOString(),
        remainingMs: Math.max(0, record.expiresAt - Date.now()),
        state: record.state,
      })),
      permissionLog: session.permissionLog.slice(-20),
      lastError: session.lastError ?? null,
    });
  }

  /**
   * 真实 stdout 行（已脱敏）。只用于验收取证，不是协议数据源。
   * @param {string} sessionId
   * @returns {string[]}
   */
  transcript(sessionId) {
    return [...(this.#sessions.get(sessionId)?.transcript ?? [])];
  }

  /**
   * @param {Session} session
   */
  #wireStdio(session) {
    let buffer = '';
    session.child.stdout.setEncoding('utf8');
    session.child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) this.#onLine(session, line);
        index = buffer.indexOf('\n');
      }
    });

    session.child.stderr.setEncoding('utf8');
    session.child.stderr.on('data', (chunk) => {
      session.stderrTail = redact(`${session.stderrTail}${chunk}`.slice(-800));
    });

    session.child.on('error', () => {
      if (!session.turnEnded) this.#finishTurn(session, 'error', 'PROCESS_DIED');
      session.state = 'DISCONNECTED';
    });

    session.child.on('exit', () => {
      if (!session.turnEnded) {
        this.#finishTurn(session, 'error', 'PROCESS_DIED');
      }
      if (session.state !== 'INCOMPATIBLE') session.state = 'DISCONNECTED';
      // 进程已退出，管道不会再有事件。
      for (const waiter of session.pending.values()) {
        waiter.reject(new Error('PROCESS_DIED'));
      }
      session.pending.clear();
      session.queue.close();
    });
  }

  /**
   * @param {Session} session
   * @param {string} line
   */
  #onLine(session, line) {
    // 证据留存：脱敏后的原始行。不是解析结果，出问题能直接看 Agent 说了什么。
    session.transcript.push(redact(line, 800));
    if (session.transcript.length > 200) session.transcript.shift();

    /** @type {any} */
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      session.badLines += 1;
      session.state = 'INCOMPATIBLE';
      if (!session.turnEnded) this.#finishTurn(session, 'error', 'AGENT_INCOMPATIBLE');
      void this.#killTree(session);
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (typeof msg.id === 'number' && (('result' in msg) || ('error' in msg)) && !msg.method) {
      const pending = session.pending.get(msg.id);
      if (!pending) return;
      session.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(String(msg.error.message ?? 'ACP_ERROR')));
      else pending.resolve(msg.result);
      return;
    }

    if (msg.method === 'session/update') {
      this.#onUpdate(session, msg.params);
      return;
    }

    // Codex 适配器的认证状态通知：这是 Agent 自己汇报的登录态，不是我们读凭据猜的。
    if (msg.method === '_auth/status_update') {
      const status = msg.params?.authStatus;
      if (status && typeof status === 'object') {
        session.authStatus = {
          kind: String(status.kind ?? 'unknown'),
          ...(pickString(status.label) ? { label: /** @type {string} */ (pickString(status.label)) } : {}),
          ...(pickString(status.account?.plan) ? { plan: /** @type {string} */ (pickString(status.account.plan)) } : {}),
        };
        session.descriptor = {
          ...session.descriptor,
          auth: authFromStatus(session.authStatus),
        };
      }
      return;
    }

    if (msg.method === 'session/turn_end') {
      if (session.turnEnded) return;
      const reason = msg.params?.reason;
      const mapped = reason === 'cancelled' ? 'cancelled' : reason === 'error' ? 'error' : 'done';
      this.#finishTurn(
        session,
        mapped,
        mapped === 'cancelled' ? 'TURN_CANCELLED' : mapped === 'error' ? 'PROCESS_DIED' : undefined,
      );
      return;
    }

    if (msg.method === 'session/request_permission') {
      void this.#onPermissionRequest(session, msg);
      return;
    }

    // 未声明的客户端能力被调用时，明确回错，不让对端挂起等一个永不到来的响应。
    if (typeof msg.id === 'number' && typeof msg.method === 'string') {
      try {
        session.child.stdin.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32601, message: `METHOD_NOT_SUPPORTED: ${msg.method}` },
          })}\n`,
        );
      } catch {
        /* process already gone */
      }
    }
  }

  /**
   * @param {Session} session
   * @param {any} params
   */
  #onUpdate(session, params) {
    if (params?.sessionId && params.sessionId !== session.agentSessionId) return;
    const update = params?.update;
    if (!update || typeof update !== 'object') return;

    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = extractText(update.content);
        if (text) session.queue.push({ type: 'text', text });
        return;
      }
      case 'agent_thought_chunk': {
        const text = extractText(update.content);
        if (text) session.queue.push({ type: 'thinking', text });
        return;
      }
      case 'tool_call': {
        /* 记下 rawInput：权限请求（session/request_permission）里常常**没有** rawInput，
           只有 title/toolCallId。要按机器可读身份判「是不是我们自己的受控工具」，
           就得在 tool_call 这一刻把 input 按 toolCallId 存住。 */
        if (update.rawInput !== undefined) {
          session.toolInputs.set(String(update.toolCallId ?? update.id ?? ''), update.rawInput);
          if (session.toolInputs.size > 200) {
            const oldest = session.toolInputs.keys().next();
            if (!oldest.done) session.toolInputs.delete(oldest.value);
          }
        }
        session.queue.push({
          type: 'tool_start',
          id: String(update.toolCallId ?? update.id ?? ''),
          name: String(update.title ?? update.kind ?? 'tool'),
          ...(update.rawInput !== undefined ? { input: update.rawInput } : {}),
        });
        return;
      }
      case 'tool_call_update': {
        const id = String(update.toolCallId ?? update.id ?? '');
        const status = String(update.status ?? '');
        if (status === 'completed' || status === 'failed') {
          session.queue.push({ type: 'tool_end', id, ok: status === 'completed', output: update.rawOutput });
        } else {
          session.queue.push({
            type: 'tool_progress',
            id,
            ...(update.title ? { note: String(update.title) } : {}),
          });
        }
        return;
      }
      case 'usage_update': {
        session.queue.push({
          type: 'usage',
          ...(typeof update.inputTokens === 'number' ? { inputTokens: update.inputTokens } : {}),
          ...(typeof update.outputTokens === 'number' ? { outputTokens: update.outputTokens } : {}),
          ...(typeof update.cost === 'number' ? { cost: update.cost } : {}),
        });
        return;
      }
      default:
        return;
    }
  }

  /**
   * 权限请求：先把 permission 事件交给 UI，再按默认策略裁决（deny）。
   * @param {Session} session
   * @param {any} msg
   */
  async #onPermissionRequest(session, msg) {
    const params = msg.params ?? {};
    const tool = params.toolCall ?? {};
    // 语义来自 title/kind 两处：适配器常把 kind 报成传输方式（execute），
    // 真正要做的事在 title（Read file / Edit files / Search files）里。
    const kind = classifyToolRequest(`${tool.kind ?? ''} ${tool.title ?? ''}`.trim(), tool.rawInput);
    const locations = Array.isArray(tool.locations)
      ? tool.locations.map((/** @type {any} */ l) => String(l?.path ?? '')).filter(Boolean)
      : [];
    const detail =
      String(tool.title ?? tool.toolCallId ?? 'agent requested permission') +
      (locations.length > 0 ? ` (${locations.join(', ')})` : '');
    /** @type {PermissionRequest} */
    const request = buildPermissionRequest(kind, detail);
    const id = String(tool.toolCallId ?? msg.id ?? 'perm');

    /* 受控工具的机器可读身份：适配器把 MCP 调用原样放在 rawInput 里
       （`{server:'opencut', tool:'film_apply_ops', arguments:{…}}`）。只把人话 detail
       交给 broker 是不够的——按标题字符串白名单等于用文案当权限位。 */
    const remembered = session.toolInputs.get(String(tool.toolCallId ?? ''));
    const rawInput = tool.rawInput ?? remembered ?? null;
    /* 身份有两处来源，按可靠性排：
       ① rawInput（`{server, tool, arguments}`）——机器可读，首选；
       ② title（`mcp.opencut.film_read` / `opencut/film_read`）——权限请求常常只带它，
          而 tool_call 的 rawInput 可能还没到（首轮实测就是这个竞态：问答回合的 film_read
          被拒成 cancelled，编辑回合却放行）。两处都不像 MCP 调用 → null，走默认拒绝。 */
    const subject = subjectFromRawInput(rawInput) ?? subjectFromTitle(tool.title);

    /* CS2（R30-125）：一次裁决 = 一条可追记录。args / cwd / requestId（本回合）/
       toolCallId 都进 context —— 授权要能回答「凭哪张票、对哪个工程、哪一回合、哪个调用」。 */
    const context = {
      args: rawInput !== null && typeof rawInput === 'object' ? /** @type {any} */ (rawInput).arguments ?? null : null,
      cwd: session.cwd,
      sessionId: session.sessionId,
      projectId: session.projectId,
      requestId: session.turnId,
      toolCallId: String(tool.toolCallId ?? tool.id ?? ''),
    };
    /** @type {any} */
    const authz = this.#authorize === null || subject === null ? null : this.#authorize(subject, context);
    if (authz !== null) {
      session.authzLog.push(authz);
      if (session.authzLog.length > 200) session.authzLog.shift();
    }

    session.queue.push({
      type: 'permission',
      id,
      request,
      ...(subject === null ? {} : { subject }),
      ...(authz === null ? {} : { authz }),
    });

    let decision = 'deny';
    /** @type {string | null} */
    let permissionId = null;
    /** @type {string} */
    let denyReason = authz === null ? 'PERMISSION_DENIED' : `PERMISSION_DENIED:${authz.reason}`;
    try {
      if (authz !== null && authz.decision === 'allow') decision = 'allow';
      else if (authz !== null && authz.decision === 'deny' && authz.hard === true) decision = 'deny';
      else if (this.#permissionUi) {
        /* CS3：票不覆盖、也不是硬拒 → 交给**真实权限卡**。等用户点「允许本次 / 拒绝 / 取消」，
           超时一律 deny；回合结束也一律 deny（迟到的答复不再生效）。 */
        const ask = await this.#awaitPermission(session, {
          request,
          subject,
          authz,
          toolCallId: context.toolCallId,
          options: Array.isArray(params.options) ? params.options : [],
        });
        decision = ask.decision;
        permissionId = ask.permissionId;
        if (ask.reason !== 'USER_ALLOW') denyReason = `PERMISSION_DENIED:${ask.reason}`;
      } else {
        decision = await this.#broker.decide(request, subject, context);
      }
    } catch {
      decision = 'deny';
    }

    if (decision !== 'allow') {
      session.queue.push({
        type: 'tool_end',
        id,
        ok: false,
        output: denyReason,
        ...(permissionId === null ? {} : { permissionId }),
      });
    }

    // ACP RequestPermissionResponse：{ outcome: { outcome: 'selected', optionId } }。
    // 拒绝时选 reject_once；没有可选 option 就报 cancelled，绝不默认放行。
    const optionId = selectPermissionOption(
      Array.isArray(params.options) ? params.options : [],
      decision === 'allow' ? 'allow' : 'deny',
    );
    const result = optionId
      ? { outcome: { outcome: 'selected', optionId } }
      : { outcome: { outcome: 'cancelled' } };

    try {
      session.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`);
    } catch {
      // 进程已死；事件已记录，无需再补。
    }
  }

  /**
   * 把一条权限请求挂成**待答复**（真实权限卡的数据源）。
   *
   * 语义边界：
   * - 有效期一到 → 解析成 deny(`PERMISSION_TIMEOUT`)；之后答复一律不生效。
   * - 回合结束（cancel/error/done）→ 解析成 deny(`TURN_ENDED`)。
   * - 每条只解析一次；重复答复由 `answerPermission()` 回 409。
   *
   * @param {Session} session
   * @param {{ request: PermissionRequest, subject: any, authz: any, toolCallId: string, options: any[] }} info
   * @returns {Promise<{ decision: 'allow' | 'deny', reason: string, permissionId: string }>}
   */
  #awaitPermission(session, info) {
    const permissionId = `perm_${++session.permissionSeq}`;
    const requestedAt = Date.now();
    const expiresAt = requestedAt + this.#permissionTimeoutMs;
    return new Promise((resolve) => {
      /** @type {any} */
      const record = {
        id: permissionId,
        sessionId: session.sessionId,
        projectId: session.projectId,
        toolCallId: info.toolCallId ?? '',
        detail: info.request?.detail ?? '',
        kind: info.request?.kind ?? 'other',
        subject: info.subject ?? null,
        authzReason: info.authz?.reason ?? 'NEEDS_USER',
        options: info.options.map((/** @type {any} */ option) => ({
          optionId: String(option?.optionId ?? ''),
          kind: String(option?.kind ?? ''),
          name: String(option?.name ?? ''),
        })),
        requestedAt,
        expiresAt,
        state: 'pending',
        settle: /** @type {any} */ (null),
        timer: /** @type {any} */ (null),
      };
      const timer = setTimeout(() => {
        this.#settlePermission(session, permissionId, 'deny', 'PERMISSION_TIMEOUT');
      }, this.#permissionTimeoutMs);
      timer.unref?.();
      record.timer = timer;
      record.settle = (/** @type {'allow'|'deny'} */ decision, /** @type {string} */ reason) => {
        clearTimeout(timer);
        resolve({ decision, reason, permissionId });
      };
      session.pendingPermissions.set(permissionId, record);
      /* 事件流里的 `permission` 已经在这之前推过（带 subject/authz）；
         待答复状态走 `inspect()/listPermissions()`，不新增事件类型
         （`contracts/agent.ts` 是共享类型，本线不改它）。 */
    });
  }

  /**
   * 解析一条待答复权限（内部）。返回是否正好解析了这一条。
   * @param {Session} session
   * @param {string} permissionId
   * @param {'allow' | 'deny'} decision
   * @param {string} reason
   */
  #settlePermission(session, permissionId, decision, reason) {
    const record = session.pendingPermissions.get(permissionId);
    if (record === undefined) return false;
    session.pendingPermissions.delete(permissionId);
    if (record.state !== 'pending') return false;
    /* 超时与「用户刚点」可能同一毫秒到：以 expiresAt 为准，晚到的算过期。 */
    const expired = reason === 'PERMISSION_TIMEOUT' || Date.now() >= record.expiresAt;
    record.state = expired ? 'expired' : 'answered';
    session.permissionLog.push({
      id: record.id,
      projectId: record.projectId,
      toolCallId: record.toolCallId,
      detail: record.detail,
      state: record.state,
      decision: expired ? 'deny' : decision,
      reason: expired ? 'PERMISSION_TIMEOUT' : reason,
      at: new Date().toISOString(),
    });
    if (session.permissionLog.length > 100) session.permissionLog.shift();
    record.settle(expired ? 'deny' : decision, expired ? 'PERMISSION_TIMEOUT' : reason);
    return true;
  }

  /**
   * 用户对一条真实权限请求的答复（CS3）。
   *
   * @param {string} sessionId
   * @param {string} permissionId
   * @param {'allow' | 'deny' | 'cancel'} decision
   * @param {{ projectId?: string | null }} [opts]
   * @returns {{ ok: true, permissionId: string, decision: 'allow' | 'deny', state: string }
   *   | { ok: false, code: 'PERMISSION_SESSION_UNKNOWN' | 'PERMISSION_NOT_FOUND' | 'PERMISSION_EXPIRED' | 'PERMISSION_ANSWERED' | 'PERMISSION_PROJECT_MISMATCH' | 'PERMISSION_DECISION_INVALID' }}
   */
  answerPermission(sessionId, permissionId, decision, opts = {}) {
    if (decision !== 'allow' && decision !== 'deny' && decision !== 'cancel') {
      return { ok: false, code: 'PERMISSION_DECISION_INVALID' };
    }
    const session = this.#sessions.get(String(sessionId));
    if (session === undefined) return { ok: false, code: 'PERMISSION_SESSION_UNKNOWN' };
    if (typeof opts.projectId === 'string' && opts.projectId !== '' && opts.projectId !== session.projectId) {
      return { ok: false, code: 'PERMISSION_PROJECT_MISMATCH' };
    }
    const record = session.pendingPermissions.get(String(permissionId));
    if (record === undefined) {
      /* 已经终态过：说清是过期还是重复答复，别混成 404。 */
      const logged = session.permissionLog.find((row) => row.id === permissionId);
      if (logged?.state === 'expired') return { ok: false, code: 'PERMISSION_EXPIRED' };
      if (logged?.state === 'answered') return { ok: false, code: 'PERMISSION_ANSWERED' };
      return { ok: false, code: 'PERMISSION_NOT_FOUND' };
    }
    const resolved = decision === 'cancel' ? 'deny' : decision;
    const reason = decision === 'allow' ? 'USER_ALLOW' : decision === 'cancel' ? 'USER_CANCEL' : 'USER_DENY';
    this.#settlePermission(session, String(permissionId), resolved, reason);
    if (record.state === 'expired') return { ok: false, code: 'PERMISSION_EXPIRED' };
    return { ok: true, permissionId: String(permissionId), decision: resolved, state: 'answered' };
  }

  /** 当前所有待答复的工具权限（按会话分组，交给 UI 轮询）。 */
  listPermissions() {
    /** @type {any[]} */
    const rows = [];
    for (const session of this.#sessions.values()) {
      for (const record of session.pendingPermissions.values()) {
        rows.push({
          id: record.id,
          sessionId: record.sessionId,
          projectId: record.projectId,
          toolCallId: record.toolCallId,
          detail: record.detail,
          kind: record.kind,
          subject: record.subject,
          authzReason: record.authzReason,
          options: record.options,
          requestedAt: new Date(record.requestedAt).toISOString(),
          expiresAt: new Date(record.expiresAt).toISOString(),
          remainingMs: Math.max(0, record.expiresAt - Date.now()),
          state: record.state,
        });
      }
    }
    return rows;
  }

  /**
   * 这一会话当前回合 id（`/ops` 核票要拿它比对 requestId）。
   * @param {string} sessionId
   */
  turnOf(sessionId) {
    return this.#sessions.get(String(sessionId))?.turnId ?? null;
  }

  /**
   * @param {Session} session
   * @param {string} method
   * @param {Record<string, unknown>} params
   * @param {number} timeoutMs
   * @returns {Promise<any>}
   */
  #request(session, method, params, timeoutMs) {
    const id = ++session.seq + 10_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new Error('ACP_REQUEST_TIMEOUT'));
      }, timeoutMs);
      timer.unref?.();
      session.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      try {
        session.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch {
        session.pending.delete(id);
        clearTimeout(timer);
        reject(new Error('PROCESS_DIED'));
      }
    });
  }

  /**
   * 只结束一次；保证 turn_end 有序且不重复。
   * @param {Session} session
   * @param {'done' | 'cancelled' | 'error'} reason
   * @param {AgentErrorCode} [error]
   */
  #finishTurn(session, reason, error) {
    if (session.turnEnded) return;
    session.turnEnded = true;
    /* CS3：回合结束，还没答复的权限卡一律 deny —— 不许「回合都完了，卡还挂着让人点允许」。 */
    for (const permissionId of [...session.pendingPermissions.keys()]) {
      this.#settlePermission(session, permissionId, 'deny', 'TURN_ENDED');
    }
    session.turnId = null;
    if (session.turnTimer) {
      clearTimeout(session.turnTimer);
      session.turnTimer = null;
    }
    session.queue.push({
      type: 'turn_end',
      reason,
      ...(error ? { error } : {}),
    });
    if (session.state === 'BUSY') session.state = 'READY';
    for (const waiter of session.turnWaiters.splice(0)) waiter();
  }

  /**
   * 先 SIGTERM 进程组，300ms 后 SIGKILL；只动自己 spawn 的组。
   * @param {Session} session
   * @returns {Promise<void>}
   */
  async #killTree(session) {
    const child = session.child;
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    if (exited()) return;

    signalGroup(child, 'SIGTERM');
    if (await waitForExit(child, 300)) return;
    signalGroup(child, 'SIGKILL');
    await waitForExit(child, 1_000);
  }
}

/**
 * @param {ChildProcess} child
 * @param {NodeJS.Signals} signal
 */
function signalGroup(child, signal) {
  const pid = child.pid;
  if (typeof pid !== 'number') return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // 已退出。
    }
  }
}

/**
 * @param {ChildProcess} child
 * @param {number} ms
 * @returns {Promise<boolean>}
 */
function waitForExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * @param {ChildProcess} child
 * @returns {Promise<Error | null>}
 */
function waitForSpawn(child) {
  if (child.pid !== undefined) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(new Error('spawn timeout')), 2_000);
    timer.unref?.();
    child.once('spawn', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      resolve(err);
    });
  });
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * @param {unknown} content
 * @returns {string}
 */
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text) : ''))
      .join('');
  }
  if (content && typeof content === 'object' && 'text' in content) return String(content.text);
  return '';
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function pickString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * 能力只能由 Agent 明确声明；缺失一律 false。
 * 读的是 ACP InitializeResponse 的 agentCapabilities / _meta，不猜。
 * @param {any} init
 * @returns {AgentDescriptor['capabilities']}
 */
function readCapabilities(init) {
  const caps = init?.agentCapabilities ?? {};
  return {
    images: caps?.promptCapabilities?.image === true,
    resume: caps?.loadSession === true,
    steering: init?._meta?.steering?.supported === true,
    // ACP 没有「permissions」能力位；只有对端主动声明 auth 扩展时才算。
    permissions: caps?.auth !== undefined,
    models: false,
  };
}

/**
 * @param {{ kind: string } | null} status
 * @returns {AgentDescriptor['auth']}
 */
function authFromStatus(status) {
  if (!status) return 'UNKNOWN';
  const kind = status.kind.toLowerCase();
  if (kind === 'account' || kind === 'chatgpt' || kind === 'loggedin' || kind === 'api_key' || kind === 'external' || kind === 'gateway') return 'LOGGED_IN';
  if (kind === 'unauthenticated' || kind === 'loggedout' || kind === 'none') return 'LOGGED_OUT';
  return 'UNKNOWN';
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function numberOrUndefined(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * 本地绝对路径 → file:// URI（仅用于附件表达，不读取文件内容）。
 * @param {string} filePath
 * @returns {string}
 */
function pathToFileUri(filePath) {
  const absolute = filePath.startsWith('/') ? filePath : `/${filePath}`;
  return `file://${absolute.split('/').map((part) => encodeURIComponent(part)).join('/')}`;
}

/** @returns {AgentDescriptor['capabilities']} */
export function defaultCapabilities() {
  return { images: false, resume: false, steering: false, permissions: false, models: false };
}
