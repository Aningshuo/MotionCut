/**
 * Codex ACP 适配器启动器（P3）。
 *
 * Codex CLI 自身不是 ACP server；官方适配器 `@agentclientprotocol/codex-acp`
 * （Apache-2.0）把 Codex App Server 翻译成 ACP。适配器随应用安装，用 `CODEX_PATH`
 * 指向用户自己的 codex 可执行文件——应用不接触 token，登录发生在 Codex 自己里。
 *
 * 本文件只负责：
 * 1. 从 `node_modules` 定位适配器入口（不假设 PATH 有 `codex-acp`）；
 * 2. 找到用户的 codex（env → PATH → 常见安装位），失败给 AGENT_NOT_INSTALLED；
 * 3. 用 `process.execPath` 起适配器，env 只多传 CODEX_PATH / NO_BROWSER /
 *    沙箱模式 / 日志目录，不透传任何凭据；
 * 4. 提供一次真实探测（initialize → session/new），把原始回包留作证据。
 *
 * 安全：本文件不实现任何一键放行。沙箱模式只接受 `read-only` 与 `workspace-write`，
 * 拒绝 `agent` / `agent-full-access`；权限请求仍走 PermissionBroker（默认拒绝）。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { AgentSessions, readMcpCapabilities, redact, toAcpMcpServers } from './acp.mjs';
import { PermissionBroker } from './permission.mjs';
import { authorizeToolCall } from './tool-grant.mjs';
import { mcpServersForSettings, readSettings } from '../studio/server/settings-store.mjs';

export const ADAPTER_PACKAGE = '@agentclientprotocol/codex-acp';

/** 允许的沙箱模式：不含 `agent` / `agent-full-access`。 */
export const ALLOWED_SANDBOX_MODES = ['read-only', 'workspace-write'];

/**
 * 受控工具策略（CS2 · R30-125 收窄）。
 *
 * CS1 把它写成「4 个工具默认放行」——只要 agent 进程起来，这四把钥匙就一直在它手上。
 * 现在改成**按票裁决**：没有 grant 就一个也不放（`authorizeToolCall(null, …)` 回
 * `default-deny`），有票也只放票里列的那些、且工程/会话/回合都要对得上。
 *
 * 保留这个函数是给单测与调用方一个显式入口；**默认参数不再是一个放行策略**。
 *
 * @param {import('./tool-grant.mjs').ToolGrant | null} grant
 * @returns {(subject: { server: string | null, tool: string }, context?: any) => any}
 */
export function controlledToolPolicy(grant = null) {
  return (subject, context = {}) => authorizeToolCall(grant, subject, context);
}

/**
 * 定位适配器入口。优先按包名解析（pnpm 严格 node_modules 也可）；
 * 失败时回退到仓库根与工作树根的 node_modules。
 * @param {{ requireFrom?: string, root?: string }} [opts]
 * @returns {{ ok: true, adapterPath: string, packagePath: string, version: string } | { ok: false, error: 'ADAPTER_NOT_INSTALLED', detail: string }}
 */
export function resolveCodexAcp(opts = {}) {
  const requireFrom = opts.requireFrom ?? import.meta.url;
  /** @type {string[]} */
  const packageCandidates = [];
  try {
    packageCandidates.push(createRequire(requireFrom).resolve(`${ADAPTER_PACKAGE}/package.json`));
  } catch {
    /* 继续回退 */
  }
  if (opts.root) {
    packageCandidates.push(
      path.join(opts.root, 'node_modules', ...ADAPTER_PACKAGE.split('/'), 'package.json'),
    );
  }

  for (const packagePath of packageCandidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      const binEntry =
        (pkg.bin && typeof pkg.bin === 'object' ? pkg.bin['codex-acp'] : undefined) ??
        pkg.main ??
        'dist/index.js';
      const adapterPath = path.resolve(path.dirname(packagePath), binEntry);
      if (!fs.existsSync(adapterPath)) continue;
      return {
        ok: true,
        adapterPath,
        packagePath,
        version: typeof pkg.version === 'string' ? pkg.version : 'unknown',
      };
    } catch {
      /* 试下一个候选 */
    }
  }

  return {
    ok: false,
    error: 'ADAPTER_NOT_INSTALLED',
    detail: `${ADAPTER_PACKAGE} not found from ${requireFrom}`,
  };
}

/**
 * 找 codex 可执行文件。顺序：
 * 1. `CODEX_PATH`（显式指定，最高优先）
 * 2. PATH 各目录（等价 `which codex`）
 * 3. 常见安装位（~/.local/bin、/opt/homebrew/bin、/usr/local/bin、~/.cargo/bin）
 * @param {{ env?: Record<string, string | undefined>, extraDirs?: readonly string[] }} [opts]
 * @returns {Promise<{ ok: true, path: string, source: string } | { ok: false, error: 'AGENT_NOT_INSTALLED', searched: string[] }>}
 */
export async function findCodexExecutable(opts = {}) {
  const env = opts.env ?? process.env;
  const home = env.HOME ?? os.homedir();
  /** @type {Array<{ candidate: string, source: string }>} */
  const candidates = [];

  if (env.CODEX_PATH) {
    candidates.push({ candidate: env.CODEX_PATH, source: 'env:CODEX_PATH' });
  }
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir) candidates.push({ candidate: path.join(dir, 'codex'), source: `path:${dir}` });
  }
  for (const extra of [
    ...(opts.extraDirs ?? []),
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.cargo', 'bin'),
    ...(process.platform === 'darwin' ? [...(opts.env ? [] : ['/Applications']), path.join(home, 'Applications')].flatMap((dir) => [
      path.join(dir, 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'bin'),
      path.join(dir, 'Codex.app', 'Contents', 'Resources'),
    ]) : []),
  ]) {
    candidates.push({ candidate: path.join(extra, 'codex'), source: `known:${extra}` });
  }

  /** @type {string[]} */
  const searched = [];
  for (const { candidate, source } of candidates) {
    searched.push(candidate);
    if (await isExecutable(candidate)) return { ok: true, path: candidate, source };
  }
  return { ok: false, error: 'AGENT_NOT_INSTALLED', searched: [...new Set(searched)] };
}

/**
 * @param {string} candidate
 * @returns {Promise<boolean>}
 */
async function isExecutable(candidate) {
  try {
    const stat = await fsp.stat(candidate);
    if (!stat.isFile()) return false;
    if (process.platform !== 'win32') await fsp.access(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 适配器 env：只加启动必需项，不传任何 token。
 * @param {{ codexPath: string, sandboxMode?: string, logsDir?: string }} opts
 * @returns {Record<string, string>}
 */
export function buildCodexAcpEnv(opts) {
  const sandboxMode = opts.sandboxMode ?? 'read-only';
  if (!ALLOWED_SANDBOX_MODES.includes(sandboxMode)) {
    throw new TypeError(
      `refusing sandbox mode ${sandboxMode}; allowed: ${ALLOWED_SANDBOX_MODES.join(', ')}`,
    );
  }
  return {
    CODEX_PATH: opts.codexPath,
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
    // 浏览器登录在无头环境会卡住；登录仍由 Codex 自己完成。
    NO_BROWSER: '1',
    INITIAL_AGENT_MODE: sandboxMode,
    ...(opts.logsDir ? { APP_SERVER_LOGS: opts.logsDir } : {}),
  };
}

/**
 * 创建绑定真实 codex-acp 的会话管理器。
 * 每个工程一个独立子进程与独立 cwd（由 AgentSessions 保证）。
 * @param {{
 *   resolveProject: (projectId: string) => string,
 *   sandboxMode?: 'read-only' | 'workspace-write',
 *   logsDir?: string,
 *   permissionBroker?: PermissionBroker,
 *   permissionUi?: boolean,
 *   permissionTimeoutMs?: number,
 *   turnTimeoutMs?: number,
 *   handshakeTimeoutMs?: number,
 *   cancelGraceMs?: number,
 *   codexPath?: string,
 *   root?: string,
 *   adapterPath?: string,
 *   authorize?: ((subject: { server: string | null, tool: string }, context: any) => any) | null,
 *   mcpServersProvider?: ((ctx: { projectId: string, sessionId: string, cwd: string }) => Promise<Array<Record<string, unknown>> | null>) | null,
 * }} opts
 * @returns {Promise<{
 *   sessions: AgentSessions,
 *   adapter: { path: string, version: string },
 *   codex: { path: string, source: string },
 *   env: Record<string, string>,
 *   commandLine: string,
 * }>}
 */
export async function createCodexAcpSessions(opts) {
  /** @type {{ ok: true, adapterPath: string, version: string } | { ok: false, error: 'ADAPTER_NOT_INSTALLED', detail: string }} */
  const adapter =
    typeof opts.adapterPath === 'string' && opts.adapterPath !== ''
      ? { ok: true, adapterPath: opts.adapterPath, version: 'caller' }
      : resolveCodexAcp({ root: opts.root });
  if (!adapter.ok) {
    const error = new Error(`${adapter.error}: ${adapter.detail}`);
    // @ts-expect-error 附加稳定错误码
    error.code = adapter.error;
    throw error;
  }

  /** @type {{ ok: true, path: string, source: string } | { ok: false, error: 'AGENT_NOT_INSTALLED', searched: string[] }} */
  const codex =
    opts.codexPath !== undefined
      ? { ok: true, path: opts.codexPath, source: 'caller' }
      : await findCodexExecutable();
  if (!codex.ok) {
    const error = new Error(`${codex.error}: searched ${codex.searched.join(', ')}`);
    // @ts-expect-error 附加稳定错误码
    error.code = codex.error;
    throw error;
  }
  if (!(await isExecutable(codex.path))) {
    const error = new Error(`AGENT_NOT_INSTALLED: ${codex.path} is not executable`);
    // @ts-expect-error 附加稳定错误码
    error.code = 'AGENT_NOT_INSTALLED';
    throw error;
  }

  const env = buildCodexAcpEnv({
    codexPath: codex.path,
    sandboxMode: opts.sandboxMode ?? 'read-only',
    ...(opts.logsDir ? { logsDir: opts.logsDir } : {}),
  });

  const sessions = new AgentSessions({
    resolveProject: opts.resolveProject,
    command: process.execPath,
    args: [adapter.adapterPath],
    extraEnv: env,
    /* 默认：**一个工具都不放**（broker 的 deny 模式）。要放行必须显式给
       `authorize`（按 grant 裁决）或自定义 broker —— 没有「默认白名单」这条路了。 */
    permissionBroker: opts.permissionBroker ?? new PermissionBroker(),
    ...(opts.permissionUi === true ? { permissionUi: true } : {}),
    ...(opts.permissionTimeoutMs !== undefined ? { permissionTimeoutMs: opts.permissionTimeoutMs } : {}),
    ...(typeof opts.authorize === 'function' ? { authorize: opts.authorize } : {}),
    ...(typeof opts.mcpServersProvider === 'function' ? { mcpServersProvider: opts.mcpServersProvider } : {}),
    turnTimeoutMs: opts.turnTimeoutMs ?? 180_000,
    handshakeTimeoutMs: opts.handshakeTimeoutMs ?? 60_000,
    ...(opts.cancelGraceMs !== undefined ? { cancelGraceMs: opts.cancelGraceMs } : {}),
  });

  return {
    sessions,
    adapter: { path: adapter.adapterPath, version: adapter.version },
    codex: { path: codex.path, source: codex.source },
    env,
    commandLine: `${process.execPath} ${adapter.adapterPath}`,
  };
}

/**
 * 真实探测：适配器可执行 → initialize → session/new。每步都留原始行。
 * 不读任何凭据文件；认证状态只由适配器自己的 `_auth/status_update` 或错误原文得出。
 * `extraEnv` 是**给验收脚本做负向对照用的**（例如把 `CODEX_HOME` 指到一个空目录，验证
 * 「没登录的机器必须给 AUTH_REQUIRED 而不是报红」）。它只往子进程 env 里加键，不接受
 * 任何凭据——调用方拿它传 token 是自己的事，本函数不读也不落。
 *
 * @param {{ cwd: string, sandboxMode?: 'read-only' | 'workspace-write', logsDir?: string, timeoutMs?: number, codexPath?: string, root?: string, extraEnv?: Record<string, string> }} opts
 * @returns {Promise<{
 *   ok: boolean,
 *   adapter: { path: string, version: string } | null,
 *   codex: { path: string, source: string } | null,
 *   commandLine: string | null,
 *   steps: Array<{ name: string, ok: boolean, evidence: string }>,
 *   auth: 'READY' | 'AUTH_REQUIRED' | 'UNVERIFIED',
 *   authEvidence: string,
 *   sessionId: string | null,
 *   models: { currentModelId: string | null, ids: string[], count: number } | null,
 *   error?: string,
 * }>}
 */
export async function probeCodexAcp(opts) {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  /** @type {Array<{ name: string, ok: boolean, evidence: string }>} */
  const steps = [];

  const adapter = resolveCodexAcp({ root: opts.root });
  if (!adapter.ok) {
    steps.push({ name: 'adapter', ok: false, evidence: `${adapter.error}: ${adapter.detail}` });
    return {
      ok: false,
      adapter: null,
      codex: null,
      commandLine: null,
      steps,
      auth: 'UNVERIFIED',
      authEvidence: 'adapter not installed; auth cannot be probed',
      sessionId: null,
      models: null,
      error: adapter.error,
    };
  }
  steps.push({
    name: 'adapter',
    ok: true,
    evidence: `${adapter.adapterPath} (${ADAPTER_PACKAGE}@${adapter.version})`,
  });

  /** @type {{ ok: true, path: string, source: string } | { ok: false, error: 'AGENT_NOT_INSTALLED', searched: string[] }} */
  const codex =
    opts.codexPath !== undefined
      ? { ok: true, path: opts.codexPath, source: 'caller' }
      : await findCodexExecutable();
  if (!codex.ok) {
    steps.push({ name: 'codex', ok: false, evidence: `${codex.error}: ${codex.searched.join(', ')}` });
    return {
      ok: false,
      adapter: { path: adapter.adapterPath, version: adapter.version },
      codex: null,
      commandLine: null,
      steps,
      auth: 'UNVERIFIED',
      authEvidence: 'codex executable not found; auth cannot be probed',
      sessionId: null,
      models: null,
      error: codex.error,
    };
  }
  steps.push({ name: 'codex', ok: true, evidence: `${codex.path} (${codex.source})` });
  // 上面的 early-return 已收窄；闭包里保留明确的快照，避免 TS 丢失收窄。
  const adapterInfo = { path: adapter.adapterPath, version: adapter.version };
  const codexInfo = { path: codex.path, source: codex.source };

  const env = buildCodexAcpEnv({
    codexPath: codex.path,
    sandboxMode: opts.sandboxMode ?? 'read-only',
    ...(opts.logsDir ? { logsDir: opts.logsDir } : {}),
  });
  const commandLine = `${process.execPath} ${adapter.adapterPath}`;

  await fsp.mkdir(opts.cwd, { recursive: true });

  const child = spawn(process.execPath, [adapter.adapterPath], {
    cwd: opts.cwd,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? os.homedir(),
      LANG: process.env.LANG ?? 'C',
      TERM: process.env.TERM ?? 'dumb',
      ...env,
      ...(opts.extraEnv ?? {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });

  /** @type {Map<number, (msg: any) => void>} */
  const pending = new Map();
  /** @type {{ kind: string, label?: string, plan?: string } | null} */
  let authStatus = null;
  /** session/new 的回执：会话 id 与模型目录（模型 id 只从这里读，不在脚本里写死）。 */
  /** @type {string | null} */
  let sessionId = null;
  /** @type {{ currentModelId: string | null, ids: string[], count: number } | null} */
  let models = null;
  let transcriptTail = '';
  let buffer = '';
  let seq = 0;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (!line.trim()) continue;
      transcriptTail = `${transcriptTail}\n${redact(line, 600)}`.slice(-4000);
      /** @type {any} */
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.method === '_auth/status_update' && msg.params?.authStatus) {
        const status = msg.params.authStatus;
        authStatus = {
          kind: String(status.kind ?? 'unknown'),
          ...(typeof status.label === 'string' ? { label: status.label } : {}),
          ...(typeof status.account?.plan === 'string' ? { plan: status.account.plan } : {}),
        };
      }
      if (typeof msg.id === 'number' && (('result' in msg) || ('error' in msg)) && !msg.method) {
        const waiter = pending.get(msg.id);
        if (waiter) {
          pending.delete(msg.id);
          waiter(msg);
        }
      }
      if (msg.method === 'session/request_permission') {
        // 探测阶段不授权任何工具；显式 cancelled，避免对端卡住。
        try {
          child.stdin.write(
            `${JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { outcome: { outcome: 'cancelled' } },
            })}\n`,
          );
        } catch {
          /* gone */
        }
      }
    }
  });

  /**
   * @param {string} method
   * @param {Record<string, unknown>} params
   * @returns {Promise<any>}
   */
  const request = (method, params) => {
    const id = ++seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ __timeout: true, id });
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (err) {
        clearTimeout(timer);
        resolve({ __error: String(err), id });
      }
    });
  };

  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const init = await request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'opencut-probe', version: '0.0.0' },
    });

    if (init?.__timeout || init?.error || !init?.result) {
      steps.push({
        name: 'initialize',
        ok: false,
        evidence: redact(JSON.stringify(init), 1200),
      });
      return finishProbe('UNVERIFIED', `initialize failed: ${redact(JSON.stringify(init), 600)}`);
    }
    steps.push({
      name: 'initialize',
      ok: true,
      evidence: redact(JSON.stringify(init.result), 1600),
    });

    // M65：`mcpServers` 来自设置 `mcp.servers` 里 enabled 的项，不再是写死的 `[]`。
    // 设置读不出来按空表处理（探测不该因设置坏掉而失败）；env 值不写进任何日志。
    /** @type {Array<{name: string, command: string, args: string[], env: Record<string,string>}>} */
    /** @type {Array<Record<string, unknown>>} */
    let mcpServers = [];
    try {
      // CS1：探测与真实会话必须走**同一条**转换（ACP 判别联合 + 能力过滤），
      // 否则探测绿了、开会话照样 Invalid params。
      const raw = mcpServersForSettings((await readSettings()).settings);
      mcpServers = toAcpMcpServers(raw, { capabilities: readMcpCapabilities(init.result) }).servers;
    } catch {
      mcpServers = [];
    }
    const created = await request('session/new', { cwd: opts.cwd, mcpServers });
    if (created?.__timeout || created?.error || !created?.result?.sessionId) {
      steps.push({
        name: 'session/new',
        ok: false,
        evidence: redact(JSON.stringify(created), 1600),
      });
      const raw = redact(JSON.stringify(created), 1000);
      const authRelated = /auth|login|log in|unauthor|credential|token expired|sign in/i.test(raw);
      return finishProbe(authRelated ? 'AUTH_REQUIRED' : 'UNVERIFIED', raw);
    }
    sessionId = String(created.result.sessionId);
    const rawModels = created.result.models;
    /** @type {string[]} */
    const modelIds = Array.isArray(rawModels?.availableModels)
      ? rawModels.availableModels
          .map((/** @type {any} */ item) => (typeof item?.id === 'string' ? item.id : typeof item?.modelId === 'string' ? item.modelId : ''))
          .filter((/** @type {string} */ id) => id !== '')
      : [];
    models = {
      currentModelId: typeof rawModels?.currentModelId === 'string' ? rawModels.currentModelId : null,
      ids: modelIds,
      count: modelIds.length,
    };
    steps.push({
      name: 'session/new',
      ok: true,
      evidence: redact(
        JSON.stringify({
          sessionId,
          currentModelId: models.currentModelId,
          models: models.count,
        }),
        800,
      ),
    });

    // 认证：只认适配器自己汇报的状态。
    if (authStatus) {
      const kind = String(/** @type {{kind:string}} */ (authStatus).kind).toLowerCase();
      const state = ['account', 'chatgpt', 'api_key', 'external', 'gateway'].includes(kind) ? 'READY'
        : ['none', 'unauthenticated', 'loggedout'].includes(kind) ? 'AUTH_REQUIRED' : 'UNVERIFIED';
      return finishProbe(state, `_auth/status_update ${kind}`);
    }
    return finishProbe('UNVERIFIED', 'no _auth/status_update received; not guessing login state');
  } finally {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  /**
   * @param {'READY' | 'AUTH_REQUIRED' | 'UNVERIFIED'} auth
   * @param {string} authEvidence
   */
  function finishProbe(auth, authEvidence) {
    return {
      ok: steps.every((step) => step.ok),
      adapter: adapterInfo,
      codex: codexInfo,
      commandLine,
      steps,
      auth,
      authEvidence,
      sessionId,
      models,
      ...(steps.some((step) => !step.ok) ? { error: authEvidence } : {}),
      transcriptTail,
    };
  }
}
