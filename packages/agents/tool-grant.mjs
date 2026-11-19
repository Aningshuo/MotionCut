/**
 * 受控工具授权（CS2 · R30-125）。
 *
 * ## 为什么不是「4 个工具默认放行」
 *
 * CS1（R30-124）为了让剪辑请求走得到 `film_apply_ops`，把
 * `project_list / film_read / film_apply_ops / export_status` 写成**默认白名单**。
 * 那等于：只要 agent 进程起来了，这四把钥匙就一直在它手上 —— 换工程、换会话、
 * 换一次请求都不需要重新授权。这轮把它收回成**一次会话一张票**：
 *
 *   grant = { grantId, server, tools[], projectId, projectPath,
 *             sessionId, runId, requestId, issuedAt, expiresAt }
 *
 * 五个绑定各管一件事：
 * - **project / path**：`args.project` 解析后必须**等于**授权里那个工程目录（不是前缀、
 *   不是同名前缀）。目录外、`..` 逃逸、换一个工程都拒。
 * - **session / run**：grant 在 `AgentSessions.open()` 时按本次会话签发，
 *   `inspect()` 里能回读到同一对 id；会话关了 grant 就作废。
 * - **request**：每次裁决都记下当次 ACP turnId（`requestId`）。grant 若声明了
 *   `requestId`（单回合票），别的回合一律拒。
 *
 * ## 来源可追
 *
 * `authorizeToolCall()` 返回的**每一条**都是一份可落盘的记录：`source` 是
 * `grant:<grantId>` 或 `default-deny`，带上 server/tool/project/session/run/request/
 * toolCallId 与时间戳。调用方（ACP 层）把这条记录挂进 permission 事件与 `inspect()`，
 * 事后能回答「谁在什么时候、凭哪张票、对哪个工程放行了什么」。
 *
 * ## 不做什么
 *
 * - 不接受 `*` / `all` / 空 tools（构造时直接抛）。
 * - 不接受相对 `projectPath`、根目录、以及没写工程名的 grant。
 * - 不做「记住上次的选择」：票过期就过期，重新开会话才有新票。
 */

import { randomUUID as nodeRandomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {ReturnType<typeof createToolGrant>} ToolGrant
 */

/** 可被授权的工具闭集（产品自己的 MCP 工具；shell / fs / 网络不在里面）。 */
export const GRANTABLE_TOOLS = Object.freeze([
  'project_list',
  'project_navigation_list',
  'project_open',
  'film_read',
  'film_propose_ops',
  'film_apply_ops',
  'export_status',
]);

/** 需要 `args.project` 的工具：路径绑定对它们生效。 */
export const PROJECT_TOOLS = Object.freeze(['film_read', 'film_propose_ops', 'film_apply_ops']);

/** 票的默认寿命与上限：一次会话够用，但不许当长期通行证。 */
export const DEFAULT_GRANT_TTL_MS = 15 * 60_000;
export const MAX_GRANT_TTL_MS = 2 * 60 * 60_000;

/**
 * 「这一回合还没开始」的占位 requestId（CS3 · MAIN-CS3-AUTHZ）。
 *
 * 票在 ACP 会话创建时就签发（MCP server 的 `--grant` 是启动参数，只能在那一刻给），
 * 但那一刻**还没有回合**。以前这里写 `null` = 这张票不校验回合 ⇒ 票在整个 45 分钟里
 * 一直有效，等于「4 工具常驻放行」。现在默认绑这个占位值：任何真实回合 id 都不等于它，
 * 票在开回合之前是**惰性**的；`bindToolGrant()` 把它绑到真实 turnId 才生效，
 * 回合结束再绑回占位值。
 */
export const INERT_REQUEST_ID = '__no_active_turn__';

/** 拒绝 `*` 一类的通配（大小写不敏感）。 */
const WILDCARD = /^(?:\*|all|any|\*\/\*)$/i;

export class GrantError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'GrantError';
    this.code = code;
  }
}

/**
 * 把工程路径归一成真实绝对路径；不存在也允许（创建 grant 时目录一定在，但单测会造临时路径）。
 * @param {string} input
 * @returns {string}
 */
function realProjectPath(input) {
  const absolute = path.resolve(input);
  if (!path.isAbsolute(absolute)) throw new GrantError('GRANT_PATH_INVALID', `projectPath 必须是绝对路径：${input}`);
  const root = path.parse(absolute).root;
  if (absolute === root) throw new GrantError('GRANT_PATH_INVALID', 'projectPath 不能是文件系统根');
  const depth = absolute.split(path.sep).filter(Boolean).length;
  if (depth < 2) throw new GrantError('GRANT_PATH_INVALID', `projectPath 太浅，像是公共父目录：${absolute}`);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

/**
 * 签发一张票。
 * @param {{
 *   server?: string,
 *   tools: readonly string[],
 *   projectId: string,
 *   projectPath: string,
 *   sessionId: string,
 *   runId: string,
 *   requestId?: string | null,
 *   ttlMs?: number,
 *   now?: () => number,
 *   randomUUID?: () => string,
 * }} input
 */
export function createToolGrant(input) {
  const server = typeof input?.server === 'string' && input.server.trim() !== '' ? input.server.trim() : 'opencut';
  const rawTools = Array.isArray(input?.tools) ? input.tools : [];
  if (rawTools.length === 0) throw new GrantError('GRANT_TOOLS_EMPTY', 'grant 必须显式列出 tools（空表等于没授权）');
  /** @type {string[]} */
  const tools = [];
  for (const tool of rawTools) {
    if (typeof tool !== 'string' || tool.trim() === '') throw new GrantError('GRANT_TOOL_INVALID', 'tools 里只能放非空字符串');
    const name = tool.trim();
    if (WILDCARD.test(name)) throw new GrantError('GRANT_WILDCARD_REJECTED', `拒绝通配授权：${name}（不得 allow-all）`);
    if (!GRANTABLE_TOOLS.includes(name)) throw new GrantError('GRANT_TOOL_UNKNOWN', `不是可授权的受控工具：${name}`);
    if (!tools.includes(name)) tools.push(name);
  }

  const projectId = typeof input?.projectId === 'string' ? input.projectId.trim() : '';
  if (projectId === '') throw new GrantError('GRANT_PROJECT_REQUIRED', 'grant 必须绑定 projectId');
  const projectPath = realProjectPath(String(input?.projectPath ?? ''));
  const sessionId = typeof input?.sessionId === 'string' ? input.sessionId.trim() : '';
  if (sessionId === '') throw new GrantError('GRANT_SESSION_REQUIRED', 'grant 必须绑定 sessionId（一次会话一张票）');
  const runId = typeof input?.runId === 'string' ? input.runId.trim() : '';
  if (runId === '') throw new GrantError('GRANT_RUN_REQUIRED', 'grant 必须绑定 runId');

  const now = input?.now ?? Date.now;
  const issuedAt = now();
  const ttlMs = Number.isFinite(input?.ttlMs)
    ? Math.min(MAX_GRANT_TTL_MS, Math.max(1_000, Number(input.ttlMs)))
    : DEFAULT_GRANT_TTL_MS;
  const uuid = input?.randomUUID ?? nodeRandomUUID;

  return Object.freeze({
    grantId: `g-${uuid()}`,
    server,
    tools: Object.freeze(tools),
    projectId,
    projectPath,
    sessionId,
    runId,
    requestId: typeof input?.requestId === 'string' && input.requestId !== '' ? input.requestId : null,
    issuedAt,
    expiresAt: issuedAt + ttlMs,
  });
}

/**
 * 解析工具参数里的 `project`，判它是不是授权里的那个工程。
 * 相对名有两种写法：
 * - **裸工程名**（等于授权目录的 basename）→ 直接就是授权目录。agent 常把工程名当 id 传，
 *   而会话 cwd 已经是工程目录，按 cwd 解析会变成 `<工程>/<工程>`（CS1 实测踩过）。
 * - 带分隔符的相对路径 → 按 cwd 解析，解析结果仍要等于授权目录。
 * @param {unknown} value
 * @param {string} cwd 会话 cwd（工程目录）
 * @param {string} [expectedPath] 授权里的工程目录（用于识别裸工程名）
 * @returns {{ ok: true, path: string } | { ok: false, reason: string }}
 */
export function resolveGrantedProject(value, cwd, expectedPath = '') {
  if (typeof value !== 'string' || value.trim() === '') return { ok: false, reason: 'PROJECT_REQUIRED' };
  const raw = value.trim();
  const base = typeof cwd === 'string' && cwd !== '' ? cwd : '/';
  if (!path.isAbsolute(raw) && !raw.includes('/') && !raw.includes(path.sep) && expectedPath !== '' && raw === path.basename(expectedPath)) {
    return { ok: true, path: expectedPath };
  }
  const candidate = path.resolve(base, raw);
  let real;
  try {
    real = fs.realpathSync.native(candidate);
  } catch {
    real = candidate;
  }
  return { ok: true, path: real };
}

/**
 * 把一张票重绑到「真实 run + 真实回合」。grantId 不变（MCP server 的 `--grant` 仍指同一张），
 * 返回新的冻结快照；票的工程/会话/工具/寿命都不许在这里改。
 *
 * @param {ReturnType<typeof createToolGrant>} grant
 * @param {{ runId?: string | null, requestId: string, now?: () => number }} input
 * @returns {ReturnType<typeof createToolGrant>}
 */
export function bindToolGrant(grant, input) {
  if (grant === null || typeof grant !== 'object') {
    throw new GrantError('GRANT_REQUIRED', 'bindToolGrant 需要一张已签发的票');
  }
  const requestId = typeof input?.requestId === 'string' ? input.requestId.trim() : '';
  if (requestId === '') throw new GrantError('GRANT_REQUEST_REQUIRED', '绑回合需要 requestId');
  const runId = typeof input?.runId === 'string' && input.runId.trim() !== '' ? input.runId.trim() : grant.runId;
  const now = input?.now ?? Date.now;
  return Object.freeze({ ...grant, runId, requestId, boundAt: now() });
}

/**
 * 一次工具调用的授权裁决。**总是**返回一条记录（allow 或 deny），永不返回 undefined。
 *
 * @param {ReturnType<typeof createToolGrant> | null} grant
 * @param {{ server: string | null, tool: string } | null} subject
 * @param {{ args?: any, cwd?: string | null, sessionId?: string | null, projectId?: string | null, projectPath?: string | null, requestId?: string | null, toolCallId?: string | null, now?: () => number }} [context]
 * @returns {{
 *   decision: 'allow' | 'deny',
 *   hard: boolean,
 *   reason: string,
 *   source: string,
 *   at: number,
 *   grantId: string | null,
 *   server: string | null,
 *   tool: string | null,
 *   projectId: string | null,
 *   projectPath: string | null,
 *   sessionId: string | null,
 *   runId: string | null,
 *   requestId: string | null,
 *   toolCallId: string | null,
 * }}
 */
export function authorizeToolCall(grant, subject, context = {}) {
  const now = context.now ?? Date.now;
  const at = now();
  /** @type {any} */
  const base = {
    at,
    grantId: grant?.grantId ?? null,
    server: subject?.server ?? null,
    tool: subject?.tool ?? null,
    projectId: grant?.projectId ?? null,
    projectPath: grant?.projectPath ?? null,
    sessionId: grant?.sessionId ?? null,
    runId: grant?.runId ?? null,
    requestId: context.requestId ?? null,
    toolCallId: context.toolCallId ?? null,
  };
  /** @param {'allow'|'deny'} decision @param {string} reason @param {boolean} hard */
  const record = (decision, reason, hard) => ({
    ...base,
    decision,
    hard,
    reason,
    source: grant === null ? 'default-deny' : `grant:${grant.grantId}`,
  });

  if (grant === null) return record('deny', 'NO_GRANT', false);
  if (subject === null || typeof subject.tool !== 'string' || subject.tool === '') return record('deny', 'NO_SUBJECT', true);
  if (at > grant.expiresAt) return record('deny', 'GRANT_EXPIRED', true);
  if (subject.server !== grant.server) return record('deny', 'SERVER_MISMATCH', true);
  // Library capabilities reuse existing exact project read/write scopes. They do
  // not mint an independent broader ticket or bypass per-call MCP confirmation.
  const requiredTool = subject.tool === 'creation_library_read' ? 'film_read' : subject.tool === 'creation_library_action' ? 'film_apply_ops' : subject.tool;
  if (!grant.tools.includes(requiredTool)) return record('deny', 'TOOL_NOT_GRANTED', true);
  if (typeof context.sessionId === 'string' && context.sessionId !== '' && context.sessionId !== grant.sessionId) {
    return record('deny', 'SESSION_MISMATCH', true);
  }
  /* 路径绑定：调用方给出「这次真正要写的工程目录」时，必须与票里的目录逐字相等
     （realpath 已经在签发时归一）。只判 projectId 不够 —— id 可能是哈希、也可能是目录名。 */
  if (typeof context.projectPath === 'string' && context.projectPath !== '' && context.projectPath !== grant.projectPath) {
    return record('deny', 'PROJECT_PATH_MISMATCH', true);
  }
  /* 回合绑定：票若绑了 requestId（会话票默认绑 INERT_REQUEST_ID），调用必须来自同一回合。
     `context.requestId` 缺失/null 一律不算命中 —— 缺席不等于「不校验」。 */
  if (grant.requestId !== null && context.requestId !== grant.requestId) return record('deny', 'REQUEST_MISMATCH', true);

  if (PROJECT_TOOLS.includes(requiredTool)) {
    const args = context.args !== null && typeof context.args === 'object' ? context.args : {};
    const resolved = resolveGrantedProject(args.project, String(context.cwd ?? grant.projectPath), grant.projectPath);
    if (resolved.ok !== true) return record('deny', resolved.reason, true);
    if (resolved.path !== grant.projectPath) return record('deny', 'PROJECT_MISMATCH', true);
  }

  return record('allow', 'GRANT_OK', true);
}

/**
 * 可交给 `AgentSessions({ authorize })` 的策略：一张票 → 一个函数。
 * 票为 null 时返回的函数**一律不硬拒**（交给 broker 的 deny/ask 模式），
 * 但绝不会返回 allow —— 「没有票」永远不等于「放行」。
 * @param {ReturnType<typeof createToolGrant> | null} grant
 */
export function grantAuthorizer(grant) {
  /** @param {{ server: string | null, tool: string } | null} subject @param {any} [context] */
  return (subject, context = {}) => authorizeToolCall(grant, subject, context);
}

/**
 * 给 inspect()/交接用的脱敏摘要：不出现任何凭据、不出现绝对路径以外的东西。
 * @param {ReturnType<typeof createToolGrant>} grant
 */
export function grantSummary(grant) {
  return {
    grantId: grant.grantId,
    server: grant.server,
    tools: [...grant.tools],
    projectId: grant.projectId,
    projectPath: grant.projectPath,
    sessionId: grant.sessionId,
    runId: grant.runId,
    requestId: grant.requestId,
    issuedAt: new Date(grant.issuedAt).toISOString(),
    expiresAt: new Date(grant.expiresAt).toISOString(),
  };
}
