/**
 * 覆盖提交客户端（副线1 · S10 建，S11 接真实 Studio）
 *
 * 只做一件事：把「某一层的完整 overrides 数组」按**与 MAIN 相同的路由合同**发成一个 Op。
 * 不自己发明协议、不直接写盘、不碰 `.film/history`——落盘是 Studio 的写队列 + CAS。
 *
 * ## 路由合同（照抄 Studio，`packages/studio/server`）
 *
 *     POST /api/projects/:id/ops
 *     { "envelope": { "projectId", "batchId", "owner", "expectedHash", "opId" },
 *       "ops": [ { "op": "overrides", "clip": "<clipId>", "entries": [ ...完整 overrides 数组... ] } ] }
 *
 *     POST /api/projects/:id/ops        ← S13 起：几何走 set
 *     { "envelope": { …同上… },
 *       "ops": [ { "op": "set", "clip": "<clipId>", "field": "box", "value": { "x", "y", "w", "h", "r"? } } ] }
 *
 *     200 { ok: true,  hash, changed, touched, undoDepth, redoDepth }
 *     409 { ok: false, code: "CONFLICT", currentHash, message }
 *     400 { ok: false, code: "INVALID" | "NOT_FOUND" | "LOCKED" | "ELEMENT_LOCKED", message, violations? }
 *
 *     POST /api/projects/:id/undo   { "expectedHash" }
 *     200 { ok: true, hash, changed, ... } / 409 CONFLICT / 400 INVALID
 *
 * ## 硬约束
 *
 * - **单条入口一批一个 Op**：`commitOverrides` 每次只发一条 `{op:'overrides'}`，`commitSet` 只发一条
 *   `{op:'set', field:'box'}`。
 * - **多条入口（S24 起）**：`commitOps(ops)` 把 N 条 op 放进**同一次** `/ops`——一条 CAS、一步撤销。
 *   多选对齐/分布/批量编辑必须走它，否则「改两层」会变成两步撤销。
 * - **entries 是完整数组**（合并后的全量），不是增量补丁。注意 Studio 侧对层条目按 `at`
 *   合并、只增不减（删条目要走 `set` 或 undo），本客户端不假装能「删掉某层覆盖」。
 * - **一份 CAS**：`expectedHash` 用上一次成功返回的 `hash`；409 时把 `currentHash` 交回调用方，
 *   由人决定重读还是放弃，这里**不自动重试**（自动重试会把别人的改动盖掉）。
 * - **不伪造成功**：网络失败/未知状态一律 `ok:false`，绝不返回假 hash。
 *
 * 落盘由 Studio 的 `/ops` + `FilmDocIo` 完成；本文件只产 HTTP 请求，不读写任何工程文件。
 */

/** @deprecated 兼容常量：S11 起真实落盘由 Studio `/ops` 完成，持久化状态见 `OPS_PERSISTENCE`。 */
export const WAIT_MAIN_IO = 'WAIT_MAIN_IO';
/** 真实持久化状态：请求发给 Studio 的 `/ops`，成功即已落盘（本侧仍不直接写文件）。 */
export const OPS_PERSISTENCE = 'studio-ops';
export const OPS_METHOD = 'POST';
export const OPS_OP_KIND = 'overrides';

/**
 * 路由路径（与 MAIN 一致；`:id` 用 `encodeURIComponent`）。
 * @param {string} projectId
 * @returns {string}
 */
export function opsPath(projectId) {
  return `/api/projects/${encodeURIComponent(projectId)}/ops`;
}

/** 合同摘要，便于交接/自检时不必翻协议。 */
export const OPS_CONTRACT = Object.freeze({
  method: OPS_METHOD,
  path: '/api/projects/:id/ops',
  undoPath: '/api/projects/:id/undo',
  op: OPS_OP_KIND,
  ok: { status: 200, body: { ok: true, hash: 'string', changed: 'boolean' } },
  conflict: { status: 409, body: { ok: false, code: 'CONFLICT', currentHash: 'string', message: 'string' } },
  invalid: { status: 400, body: { ok: false, code: 'INVALID|NOT_FOUND|LOCKED', message: 'string' } },
  persistence: OPS_PERSISTENCE
});

/**
 * @typedef {object} CommitOk
 * @property {true} ok
 * @property {string} hash            服务端返回的新 hash（下一次 CAS 就用它）
 * @property {boolean} changed
 * @property {number} status
 * @property {object} request         原文（envelope/ops），便于交接
 * @property {{status: number, body: string}} response
 *
 * @typedef {object} CommitFail
 * @property {false} ok
 * @property {'CONFLICT'|'INVALID'|'NOT_FOUND'|'LOCKED'|'ELEMENT_LOCKED'|'IO'
 *   |'ELEMENT_GONE'|'ELEMENT_REPLACED'|'ELEMENT_UNMOUNTED'|'REBUILD_EXHAUSTED'|'STALE_EPOCH'|'PAGE_UNREADABLE'|'TARGET_MISMATCH'} code
 * @property {string} message
 * @property {string} [currentHash]
 * @property {number} status
 * @property {object} request
 * @property {{status: number, body: string}|null} response
 * @property {any[]} [violations] 元素锁命中明细（S92 起透传；服务端只在这一类 400 里给）
 */

/**
 * @param {{
 *   projectId: string,
 *   batchId: string,
 *   owner?: 'MAIN'|'SUB1'|'SUB2'|'BRAIN',
 *   expectedHash?: string,
 *   baseUrl?: string,
 *   fetchImpl?: typeof fetch,
 *   opIdPrefix?: string,
 *   target?: { projectId: string, elementKey: string, instanceId: string, signature: string, epoch: number } | null
 * }} opts
 */
export function createOpsClient(opts) {
  if (!opts || !opts.projectId) throw new Error('createOpsClient 需要 projectId');
  if (!opts.batchId) throw new Error('createOpsClient 需要 batchId');

  const projectId = opts.projectId;
  const batchId = opts.batchId;
  const owner = opts.owner ?? 'SUB1';
  const baseUrl = (opts.baseUrl ?? '').replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const opIdPrefix = opts.opIdPrefix ?? batchId;
  /* R146 / M15：元素写守卫的目标（`envelope.target`）。**不传 = 老客户端**，
     服务端按跳过处理（响应体 guard:"skipped" + warn），片段级编辑照旧。 */
  const target = opts.target ?? null;
  const targetField = target === null ? {} : { target };

  let hash = opts.expectedHash ?? '';
  let seq = 0;
  /** @type {string[]} */
  const sentOpIds = [];
  /** @type {{request: object, response: {status: number, body: string}}|null} */
  let last = null;

  if (typeof fetchImpl !== 'function') throw new Error('没有可用的 fetch');

  /** 幂等键：同一客户端内不重复；带上批次与 Op 种类，便于在 Studio 的日志里认人。 */
  function nextOpId(kind = 'ov') {
    let id = '';
    do {
      seq += 1;
      id = `${opIdPrefix}:${kind}:${seq}:${Math.random().toString(16).slice(2, 6)}`;
    } while (sentOpIds.includes(id));
    sentOpIds.push(id);
    return id;
  }

  /**
   * 提交一个 `overrides` Op（一批一个）。
   * @param {{clip: string, entries: readonly any[], opId?: string}} arg
   * @returns {Promise<CommitOk|CommitFail>}
   */
  async function commitOverrides(arg) {
    const clip = arg?.clip;
    const entries = arg?.entries;
    /** @type {{envelope: {projectId: string, batchId: string, owner: string, expectedHash: string, opId: string}, ops: {op: string, clip: string, entries: readonly any[]}[]}} */
    const request = {
      envelope: {
        projectId,
        batchId,
        owner,
        expectedHash: hash,
        ...targetField,
        opId: arg?.opId ?? nextOpId()
      },
      ops: [{ op: OPS_OP_KIND, clip, entries }]
    };

    /* 本地前置校验：明显发不出去的请求不发（与服务端 400 同码，便于上层统一处理）。 */
    if (!clip || typeof clip !== 'string') {
      return fail('INVALID', '缺少 clip', 0, request, null);
    }
    if (!Array.isArray(entries)) {
      return fail('INVALID', 'entries 必须是完整数组', 0, request, null);
    }
    if (!hash) {
      return fail('INVALID', '缺少 expectedHash：先读一次工程拿到 hash 再提交', 0, request, null);
    }
    if (request.ops.length !== 1) {
      return fail('INVALID', '一批只允许一个 Op', 0, request, null);
    }
    return send(opsPath(projectId), request);
  }

  /**
   * 提交一个 `set` Op（S13 起：检查器改「位置/尺寸/旋转」走这条，`field:'box'`）。
   *
   * 与 `commitOverrides` 是**两条独立写入口**：`set` 写片段自己的 `style` 声明，
   * `overrides` 写层覆盖数组；一批仍然只发一个 Op。
   *
   * 已知语义（按 film-core 实现，本批不改它）：
   * - `field` 必须在 `SETTABLE` 白名单里（`at/time/box/size/volume/speed/overrides/src`）；
   * - `box` 是**整体替换**：`{x,y,w,h}` 必填且 `w/h > 0`，`r` 可选；
   *   写回时展开成 `left/top/width/height/rotate`（`r` 为 0 或缺失则 `rotate` 声明消失）。
   *
   * @param {{clip: string, field: string, value: any, opId?: string}} arg
   * @returns {Promise<CommitOk|CommitFail>}
   */
  async function commitSet(arg) {
    const clip = arg?.clip;
    const field = arg?.field;
    const value = arg?.value;
    /** @type {any} */
    const request = {
      envelope: {
        projectId,
        batchId,
        owner,
        expectedHash: hash,
        ...targetField,
        opId: arg?.opId ?? nextOpId('set')
      },
      ops: [{ op: 'set', clip, field, value }]
    };

    if (!clip || typeof clip !== 'string') return fail('INVALID', '缺少 clip', 0, request, null);
    if (!field || typeof field !== 'string') return fail('INVALID', '缺少 field', 0, request, null);
    if (value === undefined) return fail('INVALID', '缺少 value（清空某条覆盖要显式传 null）', 0, request, null);
    if (!hash) {
      return fail('INVALID', '缺少 expectedHash：先读一次工程拿到 hash 再提交', 0, request, null);
    }
    return send(opsPath(projectId), request);
  }

  /**
   * 一批多 Op 一次请求（S24 对齐/分布、S26 多选批量编辑共用这一条通路）。
   *
   * 与 `commitOverrides` / `commitSet` 的差别只有一个：`ops` 可以有多条。协议没变
   * （`{envelope, ops:[…]}`），服务的仍是同一个 `/ops`；一次 CAS、一步撤销。
   * 每条 op 自带 `clip`（`set` 走 `value`，`overrides` 走 `entries`）。
   *
   * @param {readonly any[]} ops
   * @param {{opId?: string, kind?: string}} [arg]
   * @returns {Promise<CommitOk|CommitFail>}
   */
  async function commitOps(ops, arg = {}) {
    /** @type {any[]} */
    const list = Array.isArray(ops) ? ops.slice() : [];
    /** @type {any} */
    const request = {
      envelope: {
        projectId,
        batchId,
        owner,
        expectedHash: hash,
        ...targetField,
        opId: arg.opId ?? nextOpId(arg.kind === 'overrides' ? 'ovbatch' : 'batch')
      },
      ops: list
    };
    if (list.length === 0) return fail('INVALID', '空批次：至少一条 op', 0, request, null);
    for (const op of list) {
      if (!op || typeof op !== 'object') return fail('INVALID', '每条 op 必须是对象', 0, request, null);
      if (!op.clip || typeof op.clip !== 'string') return fail('INVALID', `op 缺少 clip：${JSON.stringify(op)}`, 0, request, null);
      if (op.op === 'set' && typeof op.field !== 'string') return fail('INVALID', 'set op 缺少 field', 0, request, null);
      if (op.op === 'overrides' && !Array.isArray(op.entries)) return fail('INVALID', 'overrides op 的 entries 必须是完整数组', 0, request, null);
    }
    if (!hash) return fail('INVALID', '缺少 expectedHash：先读一次工程拿到 hash 再提交', 0, request, null);
    return send(opsPath(projectId), request);
  }

  /**
   * 撤销一步（服务端按 Op 批回退，原文 CAS 恢复，哈希逐字节回到编辑前）。
   * @param {{expectedHash?: string}} [arg]
   * @returns {Promise<CommitOk|CommitFail>}
   */
  async function undo(arg = {}) {
    const expectedHash = typeof arg.expectedHash === 'string' && arg.expectedHash ? arg.expectedHash : hash;
    /** @type {{expectedHash: string}} */
    const request = { expectedHash };
    if (!expectedHash) return fail('INVALID', '缺少 expectedHash：先读一次工程拿到 hash 再撤销', 0, request, null);
    return send(`/api/projects/${encodeURIComponent(projectId)}/undo`, request);
  }

  /**
   * 发一次 POST 并按合同把状态码映射成结果（commit 与 undo 共用一套，避免两处错误码漂移）。
   * @param {string} path
   * @param {object} request
   * @returns {Promise<CommitOk|CommitFail>}
   */
  async function send(path, request) {
    const url = `${baseUrl}${path}`;
    /** @type {Response} */
    let res;
    try {
      res = await fetchImpl(url, {
        method: OPS_METHOD,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request)
      });
    } catch (err) {
      return fail('IO', `请求失败：${err instanceof Error ? err.message : String(err)}`, 0, request, null);
    }

    const text = await res.text().catch(() => '');
    last = { request, response: { status: res.status, body: text } };
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (res.status === 200 && json && json.ok === true) {
      const nextHash = typeof json.hash === 'string' ? json.hash : '';
      if (!nextHash) return fail('IO', '服务端 200 但没有 hash：不认这次成功', 200, request, last.response);
      hash = nextHash;
      return {
        ok: true,
        hash: nextHash,
        changed: json.changed !== false,
        status: 200,
        request,
        response: last.response
      };
    }
    if (res.status === 409) {
      const currentHash = typeof json?.currentHash === 'string' ? json.currentHash : undefined;
      /* R150 · M16-R3：409 原来一律折成 `CONFLICT` —— 于是「元素被删/被换/父级卸载/
         重建超限」在客户端看起来和「别人先写了」一模一样，界面只能给一句「他人已改」。
         守卫的码本来就是精确的，这里**按白名单透传**；其余 409 仍是 CAS 冲突。 */
      const guardCode =
        json?.code === 'ELEMENT_GONE' ||
        json?.code === 'ELEMENT_REPLACED' ||
        json?.code === 'ELEMENT_UNMOUNTED' ||
        json?.code === 'REBUILD_EXHAUSTED' ||
        json?.code === 'STALE_EPOCH' ||
        json?.code === 'PAGE_UNREADABLE'
          ? json.code
          : 'CONFLICT';
      return fail(guardCode, json?.message ?? '工程已被别人改过', 409, request, last.response, currentHash);
    }
    if (res.status === 400) {
      /* S92：`ELEMENT_LOCKED`（元素锁）与 `LOCKED`（轨道锁）都是 400，码不同，
         前端要能分开讲。这类响应还带 `violations`（哪一条 Op、哪一层），一并透传。 */
      const code =
        json?.code === 'NOT_FOUND' || json?.code === 'LOCKED' || json?.code === 'ELEMENT_LOCKED' ? json.code : 'INVALID';
      return fail(code, json?.message ?? '请求非法', 400, request, last.response, undefined, json?.violations);
    }
    return fail('IO', `未预期的响应：HTTP ${res.status}`, res.status, request, last.response);
  }

  /**
   * @param {CommitFail['code']} code
   * @param {string} message
   * @param {number} status
   * @param {object} request
   * @param {{status: number, body: string}|null} response
   * @param {string} [currentHash]
   * @param {any[]} [violations]
   * @returns {CommitFail}
   */
  function fail(code, message, status, request, response, currentHash, violations) {
    /** @type {CommitFail} */
    const out = { ok: false, code, message, status, request, response };
    if (currentHash) out.currentHash = currentHash;
    if (Array.isArray(violations) && violations.length > 0) out.violations = violations;
    return out;
  }

  return {
    /** 下一次 CAS 用的 hash（成功后自动更新）。 */
    get hash() {
      return hash;
    },
    get batchId() {
      return batchId;
    },
    /** 手工换 hash（例如人工重读工程后）。 @param {string} next */
    setHash(next) {
      hash = typeof next === 'string' ? next : '';
    },
    nextOpId,
    commitOverrides,
    commitSet,
    commitOps,
    undo,
    /** 最近一次请求/响应原文（交接证据用）。 */
    last,
    state() {
      return { projectId, batchId, owner, hash, sentOpIds: [...sentOpIds], persistence: OPS_PERSISTENCE };
    }
  };
}
