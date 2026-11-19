/**
 * 服务端 run 台账（R122 · M8-A · 验收 D08 / LI-A37；CS3 · R30-126 重写身份）。
 *
 * ## 为什么要有这个文件
 *
 * R118 的「停止」只 abort 了前端那一次 fetch：请求断了，服务端手上的
 * `provider.generate()` 还在跑，跑完照样把草稿算出来、把回合写进会话 ——
 * 用户在界面上看到「已取消」，账上却多了一回合（D08 实测 turns 1→2）。
 *
 * 这一批把取消变成**服务端的事**：草稿请求带上 `run`（`{runId, generation, pageId}`），
 * 服务端在生成前登记、生成后按台账判定。取消 = 把这一 run 标成 `cancelled` +
 * abort 它自己的 provider 控制器。生成回来的结果**不提交**（不建草稿、不记回合）。
 *
 * ## CS3 为什么要加「实例」
 *
 * 页面重载后前端的 `runSeq` 归零，第一句话又叫 `run-1`。旧台账按 runId 精确匹配，
 * 于是新 run 撞上那条**已经 done** 的旧行：`cancel()` 对终态只回执，ACP 那一回合
 * 还在 BUSY —— 用户点了停止，账上写着 done，进程里还在跑。
 *
 * 现在身份是三层：
 *
 *   runId（客户端，会重用） + generation（客户端，同一页面内 +1） + instance（服务端，单调）
 *
 * 作用域是 `projectId + sessionId`：两个工程/两条会话里的 `run-1` 是两回事，
 * 谁也不能把谁顶掉（「其他工程不受影响」的判据就在这里）。
 *
 * - 同一作用域、同一页面、还在跑 → 幂等采用（HTTP 重试）；
 * - 同一作用域、换了页面（重载/新标签）→ 顶替旧实例（abort 旧控制器）；
 * - 上一次是终态 → **新开一个实例**。旧实例原样留在台账里（可审计），
 *   迟到回包凭「自己那一行」判终态，不会把新实例写成 done；
 * - 不同作用域 → 各自一行，互不干扰。
 *
 * ## 断线（reload）不关 run，只记 `detachedAt`
 *
 * 页面重载会 abort 掉 fetch，但「用户还想不想继续」只有用户知道。所以断线只把这一行
 * 标成 `detached`（仍在跑、仍可被 Stop 找到），不自动关 —— 这样重载之后
 * 「找到并停掉自己那一回合」才有对象可停。真正的关闭只有两条路：用户取消，或
 * provider 自己到终态。`detached` 的迟到结果不写盘（`agent-scene` 判）。
 *
 * ## 状态机（终态不可逆）
 *
 * ```
 * running ──cancel()──→ cancelled
 *    ├────draft 成功──→ done
 *    ├────draft 失败──→ failed
 *    └────新页面顶替──→ superseded
 * ```
 *
 * `cancelled / done / failed / superseded` 都是终态：`finish()` 不覆盖已有终态，
 * `cancel()` 对终态只回执、不改状态 —— 「取消」不能把一次已经完成的生成改写成取消。
 *
 * ## 归属校验（越权取消 = 串台）
 *
 * 取消必须说清是谁在取消：`project` 与 run 登记的 projectId 不符 → 403
 * `RUN_FOREIGN_PROJECT`；带了 `session` 但不符 → 403 `RUN_FOREIGN_SESSION`。
 * **403 时 run 不动**（不能因为别人来问一句就把它停了）。
 *
 * 带了 `pageId` 且与目标行不符 → 409 `RUN_STALE`：这是**旧页面**的取消，
 * 不许落到新页面的 run 上。没带 pageId（旧客户端/单测）按工程+会话判定，
 * 与 R122 行为一致。
 */

/** runId 的合法形状：与前端 `run-<n>` 同族，也容得下外部编排器的 uuid。 */
export const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** 页面实例 id：前端每次文档加载生成一个（重载就换），只用来分「谁的取消」。 */
export const PAGE_ID_RE = /^[A-Za-z0-9._:-]{8,64}$/;

/** 台账上限：只留最近这些（终态优先淘汰，在跑的绝不淘汰）。 */
export const MAX_RUNS = 200;

/** 终态集合（不可逆）。 */
export const RUN_TERMINAL_STATES = Object.freeze(['cancelled', 'done', 'failed', 'superseded']);

/**
 * run 台账的错误：`code` / `status` 与 HTTP 一一对应，`detail` 直接进回包。
 */
export class AgentRunError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} status
   * @param {Record<string, any>} [detail]
   */
  constructor(code, message, status, detail = {}) {
    super(message);
    this.name = 'AgentRunError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/** @param {unknown} value */
function nonEmptyString(value) {
  return typeof value === 'string' && value !== '' ? value : '';
}

/**
 * 台账。**纯内存**：Studio 重启就没了（在途 run 本来就随进程消失）。
 * @param {{ now?: () => number, maxRuns?: number }} [options]
 */
export function createAgentRuns(options = {}) {
  const maxRuns = Number.isInteger(options.maxRuns) && Number(options.maxRuns) > 0 ? Number(options.maxRuns) : MAX_RUNS;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  /**
   * runId → 这一 id 的**所有实例**（旧 → 新）。作用域看行上的 projectId/sessionId。
   * @type {Map<string, Array<{
   *   runId: string, instance: number, projectId: string, sessionId: string | null,
   *   pageId: string | null, generation: number, state: string, reason: string | null,
   *   createdAt: string, endedAt: string | null, cancelRequestedAt: string | null,
   *   detachedAt: string | null, supersededBy: number | null, controller: AbortController | null
   * }>>}
   */
  const byRunId = new Map();
  /** 全局实例序号（单调递增；交接里能按它排序）。 */
  let instanceSeq = 0;

  /** @param {string} runId */
  function rowsOf(runId) {
    return byRunId.get(String(runId ?? '')) ?? [];
  }

  /** @param {string} runId @returns {any} */
  function latest(runId) {
    const rows = rowsOf(runId);
    return rows.length === 0 ? null : rows[rows.length - 1];
  }

  /**
   * 同一作用域里的当前实例（旧→新里最后一条同 project+session 的行）。
   * @param {any} row
   * @returns {any}
   */
  function latestInScope(row) {
    const same = rowsOf(row.runId).filter(
      (candidate) => candidate.projectId === row.projectId && candidate.sessionId === row.sessionId,
    );
    return same.length === 0 ? null : same[same.length - 1];
  }

  /** 全量（旧 → 新）。 */
  function allRows() {
    return [...byRunId.values()].flat();
  }

  /** 淘汰：只淘汰终态，且从最旧的开始；在跑的一条都不动。 */
  function trim() {
    if (allRows().length <= maxRuns) return;
    for (const row of allRows()) {
      if (allRows().length <= maxRuns) break;
      if (!RUN_TERMINAL_STATES.includes(row.state)) continue;
      const rows = byRunId.get(row.runId);
      if (rows === undefined) continue;
      const index = rows.indexOf(row);
      if (index >= 0) rows.splice(index, 1);
      if (rows.length === 0) byRunId.delete(row.runId);
    }
  }

  /**
   * @param {{ runId: string, projectId: string, sessionId?: string | null, generation?: number, pageId?: string | null }} input
   * @param {number} instance
   */
  function makeRow(input, instance) {
    return {
      runId: input.runId,
      instance,
      projectId: input.projectId,
      sessionId: nonEmptyString(input?.sessionId) === '' ? null : String(input.sessionId),
      pageId: nonEmptyString(input?.pageId) === '' ? null : String(input.pageId),
      generation: Number.isInteger(input?.generation) && Number(input?.generation) >= 0 ? Number(input.generation) : 0,
      state: 'running',
      reason: null,
      createdAt: new Date(now()).toISOString(),
      endedAt: null,
      cancelRequestedAt: null,
      detachedAt: null,
      supersededBy: null,
      controller: null,
    };
  }

  /**
   * 顶替：旧实例进终态并真的停掉它的 provider。
   * @param {any} row @param {number} byInstance
   */
  function supersede(row, byInstance) {
    row.state = 'superseded';
    row.reason = 'SUPERSEDED_BY_NEW_PAGE';
    row.endedAt = new Date(now()).toISOString();
    row.supersededBy = byInstance;
    try {
      row.controller?.abort();
    } catch {
      /* 已结束的控制器 abort 不抛；真抛了也不能把顶替变成 500。 */
    }
  }

  /** @param {string} runId @param {any} row */
  function pushRow(runId, row) {
    const rows = byRunId.get(runId);
    if (rows === undefined) byRunId.set(runId, [row]);
    else rows.push(row);
  }

  /**
   * 登记一次 run。
   *
   * - 同作用域、同页面、**在跑** → 幂等采用（HTTP 重试用）。
   * - 同作用域、**换了页面**（重载/新标签）→ 顶替旧实例。
   * - 上一次是终态 → 新实例（runId 可重用，这是 reload 的常态）。
   * - 不同工程/会话 → 各自一行，互不影响。
   *
   * @param {{ runId: string, projectId: string, sessionId?: string | null, generation?: number, pageId?: string | null }} input
   */
  function register(input) {
    const runId = nonEmptyString(input?.runId);
    if (!RUN_ID_RE.test(runId)) {
      throw new AgentRunError('RUN_INVALID', `runId 不合法：${String(input?.runId)}`, 400);
    }
    const projectId = nonEmptyString(input?.projectId);
    if (projectId === '') {
      throw new AgentRunError('RUN_INVALID', '登记 run 需要 projectId', 400);
    }
    const pageId = nonEmptyString(input?.pageId) === '' ? null : String(input.pageId);
    if (pageId !== null && PAGE_ID_RE.test(pageId) !== true) {
      throw new AgentRunError('RUN_INVALID', `pageId 不合法：${pageId}`, 400);
    }
    const sessionId = nonEmptyString(input?.sessionId) === '' ? null : String(input.sessionId);
    const scope = { runId, projectId, sessionId, generation: input?.generation, ...(pageId === null ? {} : { pageId }) };

    const existing = rowsOf(runId)
      .filter((row) => row.projectId === projectId && row.sessionId === sessionId)
      .at(-1);
    if (existing !== undefined && existing.state === 'running') {
      if (existing.pageId === pageId) return existing;
      const next = ++instanceSeq;
      supersede(existing, next);
      const row = makeRow(scope, next);
      pushRow(runId, row);
      trim();
      return row;
    }
    /* 同一页面把**已取消**的 runId 再发一次 = 重试/重放，不许借它重跑一遍。
       换了页面（reload）才允许重用 —— 那是新一代，旧实例留档不动。 */
    if (existing !== undefined && existing.state === 'cancelled' && existing.pageId === pageId) {
      throw new AgentRunError('RUN_CANCELLED', '这次生成已经被取消：同一页面不再重放', 409, {
        runId,
        runInstance: existing.instance,
      });
    }

    const row = makeRow(scope, ++instanceSeq);
    pushRow(runId, row);
    trim();
    return row;
  }

  /**
   * 查一条（对外视图，不带控制器）。`runId` 给的是**全台账最新**的那一实例；
   * 交接/排障要看某工程的那一行请用 `latestInScopeOf()` 或 `list()`。
   * @param {string} runId
   */
  function get(runId) {
    const row = latest(runId);
    return row === null ? null : view(row);
  }

  /** @param {string} runId */
  function isCancelled(runId) {
    const row = latest(runId);
    return row !== null && row.state === 'cancelled';
  }

  /** 这一行自己是不是取消态（迟到回包用它，而不是看 runId 的最新行）。 @param {any} row */
  function isRowCancelled(row) {
    return row !== null && row !== undefined && row.state === 'cancelled';
  }

  /** 这一行还是不是**本作用域**的当前实例（被顶替/淘汰的旧实例一律 false）。 @param {any} row */
  function isCurrent(row) {
    if (row === null || row === undefined) return false;
    return latestInScope(row) === row;
  }

  /** 页面已经走了（重载/关标签），但 run 还没被取消。 @param {any} row */
  function isRowDetached(row) {
    return row !== null && row !== undefined && row.detachedAt !== null && row.state === 'running';
  }

  /**
   * 给这一行的 provider 绑控制器：取消时一起 abort（HTTP provider 会真的断流）。
   * @param {any} rowOrRunId 行对象，或 runId（兼容旧调用）
   * @param {AbortController} controller
   */
  function bindAbort(rowOrRunId, controller) {
    const row = rowOrRunId !== null && typeof rowOrRunId === 'object' ? rowOrRunId : latest(rowOrRunId);
    if (row !== null && row !== undefined) row.controller = controller;
  }

  /** @param {any} rowOrRunId */
  function unbindAbort(rowOrRunId) {
    const row = rowOrRunId !== null && typeof rowOrRunId === 'object' ? rowOrRunId : latest(rowOrRunId);
    if (row !== null && row !== undefined) row.controller = null;
  }

  /**
   * 找出这次取消要落的那一行。找不到返回 kind（由调用方决定 404/403/409）。
   * @param {string} runId
   * @param {{ projectId?: string, sessionId?: string, pageId?: string }} scope
   * @returns {any}
   */
  function pickTarget(runId, scope) {
    const rows = rowsOf(runId);
    if (rows.length === 0) return { kind: 'missing' };
    const projectId = nonEmptyString(scope?.projectId);
    if (projectId === '') return { kind: 'bad-request' };
    const inProject = rows.filter((row) => row.projectId === projectId);
    if (inProject.length === 0) return { kind: 'foreign-project', row: rows[rows.length - 1] };
    const sessionId = nonEmptyString(scope?.sessionId);
    const inSession = sessionId === '' ? inProject : inProject.filter((row) => row.sessionId === sessionId);
    if (inSession.length === 0) return { kind: 'foreign-session', row: inProject[inProject.length - 1] };
    const pageId = nonEmptyString(scope?.pageId);
    if (pageId !== '') {
      const inPage = inSession.filter((row) => row.pageId === pageId);
      if (inPage.length === 0) {
        /* 旧页面的取消：runId 相同，但这张票不是它的 —— 绝不落到别人的新 run 上。 */
        return { kind: 'stale', row: inSession[inSession.length - 1] };
      }
      const pageRow = inPage[inPage.length - 1] ?? null;
      const scopeRow = inSession[inSession.length - 1] ?? null;
      if (pageRow === null || scopeRow === null) return { kind: 'missing' };
      /* 这一页的 run 已经收尾、而同一作用域又有了更新的一代：
         这条取消是**旧页面**发的，只回执会让人以为「停掉了新 run」，显式 409。 */
      if (pageRow !== scopeRow && pageRow.state !== 'running') {
        return { kind: 'stale', row: scopeRow };
      }
      return { kind: 'ok', row: pageRow };
    }
    return { kind: 'ok', row: inSession[inSession.length - 1] };
  }

  /**
   * 取消。终态只回执不改状态；**归属不符一律 403 且不动 run**。
   * @param {string} runId
   * @param {{ projectId?: string, sessionId?: string, pageId?: string, reason?: string }} [scope]
   * @returns {{ row: any, changed: boolean }}
   */
  function cancel(runId, scope = {}) {
    const target = pickTarget(runId, scope);
    if (target.kind === 'missing') {
      throw new AgentRunError('RUN_NOT_FOUND', `没有这次生成（或已过期）：${String(runId)}`, 404);
    }
    if (target.kind === 'bad-request') {
      throw new AgentRunError('BAD_REQUEST', '取消要说明是哪个工程（project）', 400);
    }
    if (target.kind === 'foreign-project') {
      throw new AgentRunError('RUN_FOREIGN_PROJECT', '这次生成不属于这个工程：拒绝取消', 403, {
        runProject: target.row.projectId,
      });
    }
    if (target.kind === 'foreign-session') {
      throw new AgentRunError('RUN_FOREIGN_SESSION', '这次生成不属于这条会话：拒绝取消', 403, {
        runSession: target.row.sessionId,
      });
    }
    if (target.kind === 'stale') {
      throw new AgentRunError('RUN_STALE', '这是旧页面的取消：它对应的 run 已经换了一代，拒绝落到新 run 上', 409, {
        runInstance: target.row.instance,
        runPage: target.row.pageId,
      });
    }
    const row = target.row;
    if (row.state !== 'running') {
      return { row, changed: false };
    }
    row.state = 'cancelled';
    row.reason = nonEmptyString(scope?.reason) === '' ? 'USER_CANCEL' : String(scope.reason);
    row.cancelRequestedAt = new Date(now()).toISOString();
    row.endedAt = row.cancelRequestedAt;
    /* 真的停：provider 拿到的是这个 signal（HTTP 那条会断流；ACP 那条会等 turn_end）。 */
    try {
      row.controller?.abort();
    } catch {
      /* 控制器已结束时 abort 也不该把「取消」变成 500。 */
    }
    return { row, changed: true };
  }

  /**
   * 断线：页面走了，但**不关 run**（重载之后还要能找到它、停它）。
   * 只记 `detachedAt`；同一行重复断线保留第一次的时间。
   * @param {string} runId
   * @param {{ projectId?: string, sessionId?: string, pageId?: string }} [scope]
   */
  function detach(runId, scope = {}) {
    const target = pickTarget(runId, scope);
    if (target.kind !== 'ok') return null;
    const row = target.row;
    if (row.state !== 'running') return null;
    if (row.detachedAt === null) row.detachedAt = new Date(now()).toISOString();
    return row;
  }

  /**
   * 收尾。只从 `running` 迁移；终态不动（已取消的不会被写成 done）。
   * @param {any} rowOrRunId 行对象（推荐）或 runId（兼容旧调用）
   * @param {'done'|'failed'|'cancelled'} outcome
   */
  function finish(rowOrRunId, outcome) {
    const row = rowOrRunId !== null && typeof rowOrRunId === 'object' ? rowOrRunId : latest(rowOrRunId);
    if (row === null || row === undefined) return null;
    if (row.state !== 'running') return row;
    row.state = outcome === 'failed' ? 'failed' : outcome === 'cancelled' ? 'cancelled' : 'done';
    row.endedAt = new Date(now()).toISOString();
    return row;
  }

  /**
   * 对外的一份（不带控制器）。
   * @param {any} row
   */
  function view(row) {
    return {
      runId: row.runId,
      instance: row.instance,
      projectId: row.projectId,
      sessionId: row.sessionId,
      pageId: row.pageId,
      generation: row.generation,
      state: row.state,
      reason: row.reason,
      createdAt: row.createdAt,
      endedAt: row.endedAt,
      cancelRequestedAt: row.cancelRequestedAt,
      detachedAt: row.detachedAt,
      supersededBy: row.supersededBy,
      terminal: RUN_TERMINAL_STATES.includes(row.state),
    };
  }

  /** 终态查询（一次/全部）。 */
  function list() {
    return allRows().map(view);
  }

  /**
   * HTTP 映射：**不抛错**，返回 `{status, body}`。
   * 路由只做 `sendJson(res, out.status, out.body)`。
   * @param {string} runId
   * @param {any} body
   */
  function cancelHttp(runId, body) {
    try {
      const { row, changed } = cancel(runId, {
        projectId: body?.project,
        sessionId: body?.session,
        pageId: body?.pageId,
      });
      return {
        status: 200,
        body: {
          ok: true,
          runId: row.runId,
          instance: row.instance,
          state: row.state,
          /* `cancelled` 说的是「状态是取消」，`idempotent` 说的是「这次没改动」。 */
          cancelled: row.state === 'cancelled',
          idempotent: changed === false,
          projectId: row.projectId,
          sessionId: row.sessionId,
          pageId: row.pageId,
          reason: row.reason,
        },
      };
    } catch (error) {
      if (error instanceof AgentRunError) {
        return {
          status: error.status,
          body: { ok: false, code: error.code, message: error.message, ...error.detail },
        };
      }
      return {
        status: 500,
        body: { ok: false, code: 'RUN_INTERNAL', message: `取消失败：${String(/** @type {any} */ (error)?.message ?? error)}` },
      };
    }
  }

  return {
    register,
    get,
    latest,
    isCancelled,
    isRowCancelled,
    isCurrent,
    isRowDetached,
    bindAbort,
    unbindAbort,
    cancel,
    cancelHttp,
    detach,
    finish,
    view,
    list,
    size: () => allRows().length,
    /** @visibleForTesting */
    clear: () => {
      byRunId.clear();
      instanceSeq = 0;
    },
  };
}
