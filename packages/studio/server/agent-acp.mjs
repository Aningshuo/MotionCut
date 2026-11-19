/**
 * Studio 侧的 ACP agent（CS2 · R30-125）。
 *
 * 把三样东西接在一起：
 *   1. `createCodexAcpSessions()` —— 真实 codex-acp 会话（CS1 已验）；
 *   2. 每会话一张**受控写票**（`grants.issue`），MCP server 凭票写 `/api/projects/:id/ops`；
 *   3. `createAcpSceneProvider()` —— 给 `/api/agent/scene` 用的 provider。
 *
 * 三条硬口径：
 * - **会话按工程复用**：同一工程连续两句话不必各起一个 codex 进程；
 *   进程死了（alive=false）才重开。
 * - **票按会话签发、按会话收回**：MCP server 是 codex 的子进程，它只能拿到这一张票；
 *   票里的工程路径与 projectId 都是服务端填的，agent 改不了。
 * - **失败不假装可用**：codex 没装 / 适配器缺 / 会话开不起来 → `generate()` 抛错，
 *   `agent-scene` 回 502 并带原因；名册里 codex 仍然是「已装未接」。
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCodexAcpSessions } from '../../agents/codex-acp.mjs';
import { LOCAL_ACP, openLocalAcp } from '../../agents/local-acp.mjs';
import { KNOWN_AGENTS } from '../../agents/probe.mjs';
import { createAcpSceneProvider } from '../../agents/provider-acp.mjs';
import { INERT_REQUEST_ID, authorizeToolCall } from '../../agents/tool-grant.mjs';

/** `packages/mcp/bin.mjs`（相对本文件）。 */
const MCP_BIN = fileURLToPath(new URL('../../mcp/bin.mjs', import.meta.url));
/** `packages/cli/ports/film-core.mjs`（MCP 的 film 端口）。 */
const FILM_MODULE = fileURLToPath(new URL('../../cli/ports/film-core.mjs', import.meta.url));

/** 每张票允许的工具：读、提案、写。写也留着 —— 万一 agent 直接写，也必须进撤销栈。 */
const GRANT_TOOLS = Object.freeze(['project_list', 'project_navigation_list', 'project_open', 'film_read', 'film_propose_ops', 'film_apply_ops']);

/** 票的寿命：一次会话的上限，不是「工作时段」。 */
const DEFAULT_GRANT_TTL_MS = 45 * 60_000;

/** The HTTP permission and grant routes own one session namespace across local clients.
 * @param {Parameters<typeof createStudioAcpAgent>[0]} options */
export function createStudioAcpClients(options) {
  const codex = createStudioAcpAgent(options);
  const local = LOCAL_ACP.map((entry) => createStudioAcpAgent({
    ...options, local: entry, stateDir: path.join(options.stateDir, entry.id),
  }));
  const clients = [codex, ...local];
  /** @param {string} id */
  const owner = (id) => clients.find((client) => client.sessionState(id) != null);
  return {
    ...codex, local,
    /** @param {string} id */
    sessionState: (id) => owner(id)?.sessionState(id) ?? null,
    /** @param {string} id */
    turnOf: (id) => owner(id)?.turnOf(id) ?? null,
    /** @param {Parameters<typeof codex.answerPermission>} args */
    answerPermission: (...args) => (owner(args[0]) ?? codex).answerPermission(...args),
    permissions: (projectId = '') => clients.flatMap((client) => client.permissions(projectId)),
    stats() {
      const states = clients.map((client) => client.stats());
      return { ready: states.some((s) => s.ready), failure: states.find((s) => s.failure)?.failure ?? null,
        grants: states.flatMap((s) => s.grants), permissions: states.flatMap((s) => s.permissions) };
    },
    dispose: () => Promise.all(clients.map((client) => client.dispose())),
  };
}

/**
 * @param {{
 *   registry: any,
 *   grants: ReturnType<typeof import('./grants.mjs').createGrantStore>,
 *   baseUrl: () => string,
 *   stateDir: string,
 *   log?: (line: string) => void,
 *   sandboxMode?: 'read-only' | 'workspace-write',
 *   turnTimeoutMs?: number,
 *   permissionTimeoutMs?: number,
 *   grantTtlMs?: number,
 *   adapterPath?: string,
 *   local?: typeof LOCAL_ACP[number],
 * }} options
 */
export function createStudioAcpAgent(options) {
  const registry = options.registry;
  const grants = options.grants;
  const log = options.log ?? (() => {});
  const local = options.local;
  const agentId = local?.id ?? 'codex';
  const agentName = local ? KNOWN_AGENTS.find((item) => item.id === agentId)?.displayName ?? agentId : 'Codex';
  /** @param {Parameters<typeof createCodexAcpSessions>[0]} settings */
  const createSessions = (settings) => local ? openLocalAcp(local, settings) : createCodexAcpSessions(settings);
  const baseUrl = options.baseUrl;
  const stateDir = options.stateDir;

  /** @type {Map<string, any>} ACP sessionId → grant（签发时的快照；现行版本从 grants.view 读） */
  const sessionGrants = new Map();
  /** @type {Promise<any> | null} */
  let ready = null;
  /** @type {any} */
  let readyInner = null;
  /** @type {Error | null} */
  let failure = null;
  /** 最近一次真实回合的结果（`providerStatus` 的 realModelReady/Verified 只看它）。 */
  /** @type {{ ok: boolean, at: number, ops?: number, error?: string } | null} */
  let lastTurn = null;

  /** @type {{available:boolean, auth:string, session:boolean, adapterVersion:string|null, reason:string|null, models:ReturnType<typeof import('../../agents/acp-models.mjs').acpModelCatalog>}} */
  let catalog = { available: false, auth: 'UNKNOWN', session: false, adapterVersion: null, reason: null, models: [] };
  let checkedAt = 0;
  /** @type {Promise<void> | null} */
  let checking = null;
  let editVerified = false;

  async function probeConnection() {
    const cwd = path.join(stateDir, 'discovery');
    await mkdir(cwd, { recursive: true });
    const created = await createSessions({
      resolveProject: () => cwd,
      adapterPath: options.adapterPath,
      sandboxMode: 'read-only',
      handshakeTimeoutMs: 15_000,
      mcpServersProvider: async () => [],
    });
    try {
      catalog.adapterVersion = created.adapter.version;
      const opened = await created.sessions.open('discovery', agentId);
      if ('error' in opened) throw Object.assign(new Error(opened.error), { code: opened.error });
      const session = created.sessions.inspect(opened.sessionId);
      const auth = session?.descriptor.auth ?? 'UNKNOWN';
      const models = created.sessions.modelCatalog(opened.sessionId);
      const reason = auth === 'LOGGED_OUT' ? 'AGENT_NOT_LOGGED_IN' : models.length === 0 ? 'MODEL_CATALOG_EMPTY' : null;
      catalog = { available: reason === null, session: true, auth, models, adapterVersion: created.adapter.version, reason };
    } finally {
      await created.sessions.dispose();
    }
  }

  /** @param {boolean} [refresh] */
  async function connection(refresh = false) {
    if (checking || refresh || Date.now() - checkedAt > (catalog.available ? 300_000 : 15_000)) {
      checking ??= probeConnection().catch((error) => {
        const reason = String(error.code ?? 'ACP_HANDSHAKE_FAILED');
        catalog = { ...catalog, available: false, auth: reason === 'AGENT_NOT_LOGGED_IN' ? 'LOGGED_OUT' : 'UNKNOWN',
          adapterVersion: reason === 'ADAPTER_NOT_INSTALLED' ? null : catalog.adapterVersion, session: false, models: [], reason };
      }).finally(() => { checkedAt = Date.now(); checking = null; });
      await checking;
    }
    return { ...catalog, agentId, agentName, lastOk: lastTurn?.ok === true, editVerified, lastAt: lastTurn?.at ?? null, lastError: lastTurn?.error ?? null };
  }

  const provider = {
    id: 'acp-' + agentId,
    agentId,
    label: agentName + '（ACP 会话）',
    mock: false,
    allowTextOnly: true,
    get models() { return catalog.models; },
    confirmedProposal() { editVerified = true; },
    /** @param {any} input */
    async generate(input) {
      const inner = await ensure();
      try {
        const out = await inner.generate(input);
        lastTurn = { ok: true, at: Date.now(), ops: Array.isArray(out?.ops) ? out.ops.length : 0 };
        return out;
      } catch (error) {
        lastTurn = { ok: false, at: Date.now(), error: String(/** @type {any} */ (error)?.code ?? error) };
        throw error;
      }
    },
  };

  async function ensure() {
    failure = null;
    if (ready !== null) return ready;
    ready = (async () => {
      const created = await createSessions({
        resolveProject: (/** @type {string} */ projectId) => {
          const entry = registry.get(projectId);
          if (entry === null || entry === undefined || typeof entry.dir !== 'string') {
            throw new Error(`PROJECT_NOT_OPEN: ${projectId}`);
          }
          return entry.dir;
        },
        sandboxMode: options.sandboxMode ?? 'workspace-write',
        turnTimeoutMs: options.turnTimeoutMs ?? 240_000,
        /* 真实权限卡：票覆盖不到的工具（例如 agent 想直接写文件）交给用户逐次决定，
           超时/回合结束一律 deny。 */
        permissionUi: true,
        ...(Number.isFinite(options.permissionTimeoutMs) ? { permissionTimeoutMs: Number(options.permissionTimeoutMs) } : {}),
        /* 验收接缝：只在探针里指向 mock ACP 对端；产品调用不传 = 用真实 codex-acp。 */
        ...(typeof options.adapterPath === 'string' && options.adapterPath !== ''
          ? { adapterPath: options.adapterPath }
          : {}),
        /* 授权：按**会话**取票，票不在就没有任何工具放行（不回落白名单）。
           每次裁决都读 grants.view() 的最新快照 —— 票被 bind/unbind 过才看得见。 */
        authorize: (/** @type {any} */ subject, /** @type {any} */ context) => {
          const issued = sessionGrants.get(String(context?.sessionId ?? ''));
          const live = issued === undefined ? null : grants.view(issued.grantId);
          return authorizeToolCall(live, subject, context);
        },
        /* 每个 ACP 会话一个绑定工程的 MCP server：--root 只圈这个工程，凭票写 Studio。
           票在这里**只绑到 run**；requestId 先给惰性占位值，等回合真的开了再 bind。 */
        mcpServersProvider: async (/** @type {any} */ ctx) => {
          const entry = registry.get(ctx.projectId);
          const projectDir = entry !== null && entry !== undefined && typeof entry.dir === 'string' ? entry.dir : ctx.cwd;
          const runId = typeof ctx.runId === 'string' && ctx.runId !== '' ? ctx.runId : '';
          if (runId === '' || projectDir === '') {
            /* 拿不到真实 run / 工程目录 → **一个 MCP server 都不给**。
               绝不回落到设置里的全局 MCP 表：那会把用户自己的别的 server 也接进来。 */
            log(`ACP_GRANT_SKIPPED session=${String(ctx.sessionId)} reason=${runId === '' ? 'NO_RUN' : 'NO_PROJECT'}`);
            return [];
          }
          const grant = grants.issue({
            tools: GRANT_TOOLS,
            projectId: ctx.projectId,
            projectPath: projectDir,
            sessionId: ctx.sessionId,
            runId,
            requestId: INERT_REQUEST_ID,
            ttlMs: Number.isFinite(options.grantTtlMs) ? Number(options.grantTtlMs) : DEFAULT_GRANT_TTL_MS,
          });
          sessionGrants.set(ctx.sessionId, grant);
          log(`ACP_GRANT session=${ctx.sessionId} grant=${grant.grantId} project=${ctx.projectId} run=${runId} request=${INERT_REQUEST_ID}`);
          return [
            {
              name: 'opencut',
              command: process.execPath,
              args: [
                MCP_BIN,
                '--root',
                projectDir,
                '--allow-write',
                '--film-module',
                FILM_MODULE,
                '--state-dir',
                path.join(stateDir, 'mcp', String(ctx.sessionId)),
                '--studio-url',
                baseUrl(),
                '--grant',
                grant.grantId,
                '--project-id',
                ctx.projectId,
              ],
              env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
            },
          ];
        },
      });
      const inner = createAcpSceneProvider({
        agentId, providerId: provider.id,
        sessions: created.sessions,
        log,
        /* CS3：回合边界 = 票的生效边界。开回合绑 turnId，收尾绑回惰性值。 */
        onTurnStart: ({ sessionId, turnId, runId }) => {
          const issued = sessionGrants.get(sessionId);
          if (issued === undefined) {
            log(`ACP_GRANT_BIND_MISSING session=${sessionId} turn=${String(turnId)}`);
            return;
          }
          if (turnId === null) return;
          const bound = grants.bind(issued.grantId, { runId: runId ?? issued.runId, requestId: turnId });
          log(`ACP_GRANT_BIND session=${sessionId} grant=${issued.grantId} turn=${turnId} run=${String(runId)} ok=${bound !== null}`);
        },
        onTurnEnd: ({ sessionId, turnId }) => {
          const issued = sessionGrants.get(sessionId);
          if (issued === undefined) return;
          grants.unbind(issued.grantId);
          log(`ACP_GRANT_UNBIND session=${sessionId} grant=${issued.grantId} turn=${String(turnId)}`);
        },
      });
      log(`ACP_READY adapter=${created.adapter.version} agent=${agentId}`);
      readyInner = { ...inner, sessions: created.sessions, adapter: created.adapter, codex: created.codex };
      return readyInner;
    })().catch((error) => {
      failure = error instanceof Error ? error : new Error(String(error));
      log(`ACP_FAILED ${String(/** @type {any} */ (failure).message ?? failure)}`);
      ready = null;
      throw failure;
    });
    return ready;
  }

  return {
    provider,
    ensure,
    /** 只读状态面：ACP 是否可用 + 最近一次真实回合的结果。 */
    connection,
    status() {
      return { available: catalog.available, lastOk: lastTurn?.ok === true, lastAt: lastTurn?.at ?? null, lastError: lastTurn?.ok === false ? lastTurn.error ?? null : null };
    },
    /** inspect/交接用：当前活着的 ACP 会话、票、以及会话终态（Stop 的判据读这里）。 */
    stats() {
      const inner = readyInner;
      const rows = [...sessionGrants.entries()].map(([sessionId, issued]) => {
        const live = grants.view(issued.grantId) ?? issued;
        const state = inner?.sessions?.inspect?.(sessionId) ?? null;
        return {
          sessionId,
          grantId: issued.grantId,
          projectId: issued.projectId,
          projectPath: issued.projectPath,
          runId: live.runId,
          requestId: live.requestId,
          expiresAt: new Date(live.expiresAt).toISOString(),
          state: state?.state ?? null,
          alive: state?.alive ?? null,
          turnId: state?.turnId ?? null,
          authz: Array.isArray(state?.authz) ? state.authz.length : 0,
          permissions: Array.isArray(state?.permissions) ? state.permissions.length : 0,
        };
      });
      return {
        ready: ready !== null,
        failure: failure === null ? null : String(/** @type {any} */ (failure).message ?? failure),
        grants: rows,
        permissions: inner?.sessions?.listPermissions?.() ?? [],
      };
    },
    /**
     * 真实权限卡的数据源（只读）：可按工程过滤，别的工程的卡不会串台。
     * @param {string} [projectId]
     * @returns {any[]}
     */
    permissions(projectId = '') {
      return this.stats().permissions.filter((/** @type {any} */ row) => projectId === '' || row.projectId === projectId);
    },
    /**
     * 用户答复一条权限请求：允许本次 / 拒绝 / 取消。
     * @param {string} sessionId @param {string} permissionId @param {'allow'|'deny'|'cancel'} decision
     * @param {{ projectId?: string | null }} [opts]
     */
    answerPermission(sessionId, permissionId, decision, opts = {}) {
      const inner = readyInner;
      if (inner === null) return { ok: false, code: 'ACP_UNAVAILABLE' };
      return inner.sessions.answerPermission(sessionId, permissionId, decision, opts);
    },
    /**
     * 这一会话当前回合 id；`/ops` 核票拿它比对 requestId。
     * @param {string} sessionId
     */
    turnOf(sessionId) {
      return readyInner?.sessions?.turnOf?.(sessionId) ?? null;
    },
    /**
     * 会话是否还活着（已被杀掉的会话，其票一律不再生效）。
     * @param {string} sessionId
     */
    sessionState(sessionId) {
      return readyInner?.sessions?.inspect?.(sessionId) ?? null;
    },
    async dispose() {
      for (const [sessionId, grant] of sessionGrants) {
        grants.revoke(grant.grantId);
        sessionGrants.delete(sessionId);
      }
      if (checking) await checking;
      if (ready !== null) {
        const inner = await ready.catch(() => null);
        await inner?.dispose?.();
      }
    },
  };
}
