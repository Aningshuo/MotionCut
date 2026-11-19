/**
 * Studio 侧的受控写授权台账（CS2 · R30-125）。
 *
 * 这张表只做三件事：
 * 1. **签发**：ACP 会话打开时由服务端给一张票（`createToolGrant`），票里写着
 *    工程 / 会话 / run / 工具表 / 过期时间；
 * 2. **核验**：`/ops` 收到 `x-opencut-agent-grant` 时核票 —— 票在不在、过没过期、
 *    工程对不对、这张票有没有 `film_apply_ops`；
 * 3. **可追**：每次核验都留一条记录（放行/拒绝 + 原因 + 五元组），`inspect`/交接能回读。
 *
 * 为什么不在 MCP 进程里自证：MCP 进程是 agent 的子进程，agent 能改它的参数。
 * 授权必须由**服务端**记账，凭票写入 —— 这样「谁批的、批给哪个工程」不依赖 agent 自觉。
 */

import { INERT_REQUEST_ID, bindToolGrant, createToolGrant, grantSummary } from '../../agents/tool-grant.mjs';

/**
 * @param {{ now?: () => number, maxGrants?: number }} [opts]
 */
export function createGrantStore(opts = {}) {
  const now = opts.now ?? Date.now;
  const maxGrants = Number.isFinite(opts.maxGrants) ? Math.max(1, Number(opts.maxGrants)) : 200;
  /** @type {Map<string, ReturnType<typeof createToolGrant>>} */
  const grants = new Map();
  /** @type {Array<{ at: string, grantId: string | null, projectId: string | null, tool: string, sessionId: string | null, requestId: string | null, decision: 'allow' | 'deny', reason: string }>} */
  const decisions = [];

  function prune() {
    const at = now();
    for (const [id, grant] of grants) {
      if (grant.expiresAt < at) grants.delete(id);
    }
    while (grants.size > maxGrants) {
      const oldest = grants.keys().next();
      if (oldest.done === true) break;
      grants.delete(oldest.value);
    }
  }

  /**
   * 签发一张票。构造失败（通配、空表、路径太浅…）直接抛给调用方，不吞。
   * @param {Parameters<typeof createToolGrant>[0]} input
   */
  function issue(input) {
    const grant = createToolGrant({ ...input, now });
    grants.set(grant.grantId, grant);
    prune();
    return grant;
  }

  /**
   * 核票。**总是**返回一条可追记录里的核心字段。
   *
   * CS3（MAIN-CS3-AUTHZ）起多核三样：`requestId`（回合）、`projectPath`（真实目录）、
   * `sessionId`（会话）。缺省的不当作「不校验」—— 只要调用方给了就必须相等。
   *
   * @param {string | null | undefined} grantId
   * @param {{ projectId: string, tool: string, requestId?: string | null, projectPath?: string | null, sessionId?: string | null }} input
   * @returns {{ ok: true, grant: ReturnType<typeof createToolGrant> } | { ok: false, code: string, grantId: string | null, reason?: string }}
   */
  function authorize(grantId, input) {
    const at = now();
    const id = typeof grantId === 'string' && grantId !== '' ? grantId : null;
    /** @param {'allow'|'deny'} decision @param {string} reason */
    const record = (decision, reason) => {
      decisions.push({
        at: new Date(at).toISOString(),
        grantId: id,
        projectId: input?.projectId ?? null,
        tool: String(input?.tool ?? ''),
        sessionId: typeof input?.sessionId === 'string' ? input.sessionId : null,
        requestId: typeof input?.requestId === 'string' ? input.requestId : null,
        decision,
        reason,
      });
      if (decisions.length > 500) decisions.shift();
    };

    if (id === null) {
      record('deny', 'GRANT_MISSING');
      return { ok: false, code: 'GRANT_MISSING', grantId: null };
    }
    const grant = grants.get(id);
    if (grant === undefined) {
      record('deny', 'GRANT_UNKNOWN');
      return { ok: false, code: 'GRANT_UNKNOWN', grantId: id };
    }
    if (at > grant.expiresAt) {
      grants.delete(id);
      record('deny', 'GRANT_EXPIRED');
      return { ok: false, code: 'GRANT_EXPIRED', grantId: id };
    }
    if (grant.projectId !== input?.projectId) {
      record('deny', 'PROJECT_MISMATCH');
      return { ok: false, code: 'PROJECT_MISMATCH', grantId: id };
    }
    if (typeof input?.projectPath === 'string' && input.projectPath !== '' && input.projectPath !== grant.projectPath) {
      record('deny', 'PROJECT_PATH_MISMATCH');
      return { ok: false, code: 'PROJECT_PATH_MISMATCH', grantId: id };
    }
    if (!grant.tools.includes(String(input?.tool ?? ''))) {
      record('deny', 'TOOL_NOT_GRANTED');
      return { ok: false, code: 'TOOL_NOT_GRANTED', grantId: id };
    }
    if (typeof input?.sessionId === 'string' && input.sessionId !== '' && input.sessionId !== grant.sessionId) {
      record('deny', 'SESSION_MISMATCH');
      return { ok: false, code: 'SESSION_MISMATCH', grantId: id };
    }
    /* 会话票一直绑着 requestId（未开回合时是 INERT_REQUEST_ID）：
       调用方拿不出同一回合的 id 就一律拒 —— 这是「票不等于常驻放行」的关键一条。 */
    if (grant.requestId !== null && input?.requestId !== grant.requestId) {
      record('deny', 'REQUEST_MISMATCH');
      return { ok: false, code: 'REQUEST_MISMATCH', grantId: id };
    }
    record('allow', 'GRANT_OK');
    return { ok: true, grant };
  }

  /**
   * 把票绑到真实回合（turnId）。返回新快照；票不存在返回 null。
   * @param {string} grantId
   * @param {{ runId?: string | null, requestId: string }} input
   */
  /** @param {string} grantId @param {{ runId?: string | null, requestId: string }} input */
  function bind(grantId, input) {
    const grant = grants.get(String(grantId));
    if (grant === undefined) return null;
    const next = bindToolGrant(grant, { runId: input?.runId ?? grant.runId, requestId: input.requestId, now });
    grants.set(next.grantId, next);
    return next;
  }

  /** 回合结束：票回到惰性状态（仍可复用给下一回合，但必须再 bind）。 */
  /** @param {string} grantId */
  function unbind(grantId) {
    const grant = grants.get(String(grantId));
    if (grant === undefined) return null;
    const next = bindToolGrant(grant, { requestId: INERT_REQUEST_ID, now });
    grants.set(next.grantId, next);
    return next;
  }

  /** 当前快照（in-process 裁决读它，保证与 /ops 核票看的是同一份）。 */
  /** @param {string} grantId */
  function view(grantId) {
    return grants.get(String(grantId)) ?? null;
  }

  /** @param {string} grantId */
  function revoke(grantId) {
    return grants.delete(String(grantId));
  }

  /**
   * 会话结束时收回它名下的全部票（run 结束 / 归档 / 工程关闭都该调）。
   * @param {string} sessionId
   * @returns {number} 收回的张数
   */
  function revokeSession(sessionId) {
    let removed = 0;
    for (const [id, grant] of grants) {
      if (grant.sessionId === sessionId) {
        grants.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  /** 脱敏摘要（不含密钥；只给 id/工程/工具/时间）。 */
  function list() {
    prune();
    return [...grants.values()].map((grant) => grantSummary(grant));
  }

  /** 最近的核验记录（倒序由调用方决定；这里按发生顺序）。 */
  function trail(limit = 50) {
    const n = Number.isFinite(limit) ? Math.max(1, Number(limit)) : 50;
    return decisions.slice(-n);
  }

  return {
    issue,
    authorize,
    bind,
    unbind,
    view,
    revoke,
    revokeSession,
    list,
    trail,
    /** @param {string} id */
    get: (id) => grants.get(String(id)) ?? null,
  };
}
