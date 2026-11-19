// @ts-nocheck —— 纯逻辑模块，靠 scripts/s68-props-merge.mjs 的真跑用例验收；类型只经由 App 的调用签名约束。
/**
 * 属性提交队列（S68 · NEW-02 的修复点）
 *
 * ## 修的是什么
 *
 * 修复前，检查器每提交一次都是「读本地工程状态 → 改一个键 → 整包发 `/ops`」。
 * 本地状态来自**异步** `refresh()`（`/api/projects/:id/doc` 回来后才更新），于是：
 *
 *     A 图层改 left=120  → /ops 成功，refresh 还在路上
 *     B 图层改 top=80    → 从「A 之前」的旧 base 拼包 → set:box 整体替换
 *     ⇒ 盘上 left 回到 0，A 的改动被 B 覆盖
 *
 * 已用真 Studio + 真 `/ops` + 真磁盘复现（见 `evidence/rounds/R50-SUB1/s68-props-merge.json`
 * 的 `repro`）：`set:box` 是**整体替换**，旧 base 拼出来的第二包一定带走前一次的键。
 *
 * ## 怎么修
 *
 * 1. **同步基座**：本模块持有每个片段的最新 overrides / box（`base`），提交成功再叠加
 *    `applied`，任何时刻 `snapshot()` 都是「上一个成功写 + 所有排队写」的结果，
 *    不再读异步刷新的工程状态；
 * 2. **按 (elementId, key) 合并**：同键排队时后一次替换前一次（`superseded`），
 *    不同键各自保留；
 * 3. **串行化**：一次只有一个在途 `/ops`，下一包在前一包返回后用**新 hash** 拼；
 * 4. **一次提交 = 一个批次**：每个意图一个 `batchId` / 一次 `/ops`，不并成大包
 *    （批次可归因：`records()` 里 batchId → elementId/key/value/status/hash）；
 * 5. **失败只回滚这一次**：失败的意图不进 `applied`，重放时自然消失，
 *    其余已成功/排队的不受影响。
 *
 * 纯逻辑、不碰 DOM、不直接发请求：写盘由注入的 `commit` 完成（App 里接 `/ops`）。
 */

import { mergeOverridesAt } from '../../../../layers/override-merge.mjs';

/**
 * 几何字段 → 片段 box 的字段名（与 film-core `set:box` 的 `{x,y,w,h,r}` 对齐）。
 *
 * 两套写法都收：检查器字段 id（`x/y/w/h/rotation`）和 CSS 名（`left/top/width/height/rotate`）。
 * 面板传的是前者；调用方若按 CSS 名传也不会静默失败（`setBox` 会回 INVALID）。
 */
const BOX_FIELD = Object.freeze({
  x: 'x',
  y: 'y',
  w: 'w',
  h: 'h',
  rotation: 'r',
  left: 'x',
  top: 'y',
  width: 'w',
  height: 'h',
  rotate: 'r',
});

/**
 * @typedef {object} Intent
 * @property {number} seq
 * @property {string} batchId
 * @property {string} clip
 * @property {'overrides'|'box'} kind
 * @property {string} elementId   overrides=定位串；box=片段 id
 * @property {string} key         字段键（overrides 的 field.key / box 的 left|top|…）
 * @property {any} value          归因用的原值
 * @property {any} patch          overrides 的 OverridePatch
 * @property {string} status      queued | sending | ok | failed | superseded | skipped
 * @property {string} hash
 * @property {string} error
 * @property {string} [owner]     提交归属（'MAIN' = 人在写；缺省/其它 = 画布坞的历史口径）
 */

/**
 * @param {{
 *   commit: (arg: {batchId: string, opId: string, op: any, intent: Intent}) => Promise<{ok: boolean, hash?: string, code?: string, message?: string}>,
 *   now?: () => number,
 *   batchPrefix?: string,
 *   limit?: number
 * }} opts
 */
export function createPropsQueue(opts) {
  if (typeof opts?.commit !== 'function') throw new Error('createPropsQueue 需要 commit');
  const commit = opts.commit;
  const now = opts.now ?? (() => Date.now());
  const batchPrefix = opts.batchPrefix ?? 'S68';
  const limit = Number.isFinite(opts.limit) ? Number(opts.limit) : 500;

  /** @type {Map<string, {entries: any[], box: any}>} 服务端真值（最近一次 hydrate） */
  const base = new Map();
  /** @type {Map<string, Intent[]>} 已成功的意图（重放用） */
  const applied = new Map();
  /** @type {Intent[]} 排队中（不含在途） */
  const queue = [];
  /** @type {Intent[]} 全量归因记录 */
  const records = [];
  /** @type {Intent|null} */
  let inFlight = null;
  let seq = 0;
  /** @type {{resolve: Function, reject: Function}[]} */
  let drains = [];

  /* ── 重放：base + applied + queued ─────────────────────────────── */

  /** @param {{entries: any[], box: any}} state @param {Intent} intent */
  function applyOne(state, intent) {
    if (intent.kind === 'overrides') {
      return { entries: mergeOverridesAt(state.entries, intent.elementId, intent.patch), box: state.box };
    }
    const field = BOX_FIELD[intent.key];
    if (field === null || field === undefined) return state;
    const box = { ...(state.box ?? {}), [field]: intent.value };
    return { entries: state.entries, box };
  }

  /**
   * 片段当前应有的状态。`withQueued=false` 只看已成功的部分（诊断用）。
   * @param {string} clip
   * @param {boolean} [withQueued]
   */
  function snapshot(clip, withQueued = true) {
    const seed = base.get(clip) ?? { entries: [], box: null };
    let state = { entries: Array.isArray(seed.entries) ? seed.entries : [], box: seed.box ?? null };
    for (const intent of applied.get(clip) ?? []) state = applyOne(state, intent);
    if (withQueued) {
      for (const intent of queue) {
        if (intent.clip === clip && intent.status === 'queued') state = applyOne(state, intent);
      }
    }
    return state;
  }

  /* ── 入队 ─────────────────────────────────────────────────────── */

  /**
   * 同键合并：只合并「还没发出去」的那一条，在途/已成功的不动。
   *
   * 合并时把新意图的等待者挂到被替换的那一条上——否则调用方 `await` 的那个 promise
   * 永远不会被唤醒（合并掉的那次本来就没有自己的批次）。
   * @param {Intent} intent
   */
  function coalesce(intent) {
    for (const item of queue) {
      if (item.status !== 'queued') continue;
      if (item.clip !== intent.clip || item.kind !== intent.kind || item.elementId !== intent.elementId || item.key !== intent.key) continue;
      /* 状态**保持在 queued**：这一条还要发，只是把值换成最后一次。
         若在这里改成 superseded，泵（只找 queued）就再也捡不到它，队列会永久卡住。 */
      item.value = intent.value;
      /* 位置保持在被替换的那一条上：顺序仍是用户操作顺序，只是值取最后一次。 */
      item.patch = intent.patch;
      item.batchId = intent.batchId;
      item.supersededCount = (item.supersededCount ?? 1) + 1;
      item._waiters.push(...intent._waiters);
      return item;
    }
    return null;
  }

  /**
   * @param {Omit<Intent, 'seq'|'status'|'hash'|'error'>} shape
   * @returns {{intent: Intent, promise: Promise<any>}}
   */
  function enqueue(shape) {
    seq += 1;
    const intent = /** @type {Intent} */ ({
      ...shape,
      seq,
      batchId: `${batchPrefix}-${String(seq).padStart(3, '0')}`,
      status: 'queued',
      hash: '',
      error: '',
      /* 合并掉的意图没有自己的批次，等待者挂到胜出的那一条上（见 coalesce）。 */
      _waiters: [],
    });
    const promise = new Promise((done) => {
      intent._waiters.push(done);
    });

    const merged = coalesce(intent);
    if (merged === null) {
      queue.push(intent);
      records.push(intent);
      if (records.length > limit) records.splice(0, records.length - limit);
    }
    pump();
    return { intent: merged ?? intent, promise };
  }

  /* ── 串行泵 ───────────────────────────────────────────────────── */

  async function pump() {
    if (inFlight !== null) return;
    const next = queue.find((item) => item.status === 'queued');
    if (next === undefined) {
      flushDrains();
      return;
    }
    inFlight = next;
    next.status = 'sending';

    /* 只重放**已成功**的意图：本条自己还没算进去，由下面 applyOne 叠上去。 */
    const state = snapshot(next.clip, false);
    const withSelf = applyOne(state, next);
    const op =
      next.kind === 'overrides'
        ? { op: 'overrides', clip: next.clip, entries: withSelf.entries }
        : { op: 'set', clip: next.clip, field: 'box', value: { ...(withSelf.box ?? {}) } };

    let result;
    try {
      result = await commit({ batchId: next.batchId, opId: `${next.batchId}:1`, op, intent: next });
    } catch (error) {
      result = { ok: false, code: 'IO', message: error instanceof Error ? error.message : String(error) };
    }

    const at = queue.indexOf(next);
    if (at >= 0) queue.splice(at, 1);
    inFlight = null;

    if (result?.ok === true) {
      next.status = 'ok';
      next.hash = String(result.hash ?? '');
      next.at = now();
      const list = applied.get(next.clip) ?? [];
      list.push(next);
      /* 只留最近 200 条：更早的已被服务端真值覆盖，重放它们只会重复幂等写。 */
      if (list.length > 200) list.splice(0, list.length - 200);
      applied.set(next.clip, list);
    } else {
      /* 失败只回滚这一次：不进 applied，重放时自动消失。 */
      next.status = 'failed';
      next.code = String(result?.code ?? 'UNKNOWN');
      next.error = String(result?.message ?? '');
      next.at = now();
    }
    /* 合并进来的等待者一起唤醒：它们等的是「这个键最终落地」，不是一个自己的批次。 */
    const reply = { ok: result?.ok === true, hash: next.hash, code: next.code ?? '', message: next.error, batchId: next.batchId, status: next.status };
    for (const done of next._waiters ?? []) done(reply);
    next._waiters = [];

    if (queue.some((item) => item.status === 'queued')) {
      void pump();
    } else {
      flushDrains();
    }
  }

  function flushDrains() {
    if (inFlight !== null || queue.some((item) => item.status === 'queued')) return;
    const list = drains;
    drains = [];
    for (const done of list) done();
  }

  /* ── 对外 ─────────────────────────────────────────────────────── */

  return {
    /** 从服务端真值补水；有排队/在途时不覆盖（否则会把乐观值打回去）。 */
    hydrate(clip, state) {
      if (typeof clip !== 'string' || clip === '') return;
      const busy = inFlight !== null && inFlight.clip === clip;
      if (busy || queue.some((item) => item.clip === clip && item.status === 'queued')) return;
      base.set(clip, { entries: Array.isArray(state?.entries) ? state.entries : [], box: state?.box ?? null });
    },

    snapshot,

    /**
     * 提交一条 overrides 字段。
     * @param {{clip: string, elementId: string, key: string, patch: any, value?: any, owner?: string}} arg
     *   `owner` 只透传给注入的 `commit`（右列是人写 → MAIN，画布坞是历史口径 SUB1）。
     */
    setOverride(arg) {
      return enqueue({
        clip: arg.clip,
        kind: 'overrides',
        elementId: arg.elementId,
        key: arg.key,
        value: arg.value ?? arg.patch,
        patch: arg.patch,
        owner: arg.owner,
      });
    },

    /**
     * 提交一条几何字段（`set:box` 整体替换，所以按 key 从同步 base 拼）。
     * @param {{clip: string, key: string, value: number, fallback?: any, owner?: string}} arg
     */
    setBox(arg) {
      const field = BOX_FIELD[arg.key];
      if (field === null || field === undefined) {
        return {
          intent: null,
          promise: Promise.resolve({ ok: false, code: 'INVALID', message: `不是几何键：${arg.key}`, status: 'skipped' }),
        };
      }
      const current = snapshot(arg.clip);
      if (current.box === null && arg.fallback !== undefined && arg.fallback !== null) {
        base.set(arg.clip, { entries: current.entries, box: { ...arg.fallback } });
      }
      return enqueue({ clip: arg.clip, kind: 'box', elementId: arg.clip, key: arg.key, value: arg.value, patch: null, owner: arg.owner });
    },

    /** 在途或排队条数（面板据此显示 busy）。 */
    size() {
      return queue.length + (inFlight === null ? 0 : 1);
    },

    /** 是否还有未落盘的写。 */
    busy() {
      return inFlight !== null || queue.some((item) => item.status === 'queued');
    },

    /** 等所有排队写落地。 */
    drain() {
      if (!this.busy()) return Promise.resolve();
      return new Promise((resolve) => drains.push(resolve));
    },

    /** 归因记录（batchId → elementId/key/value/status/hash）。 */
    records() {
      return records.map((item) => ({
        seq: item.seq,
        batchId: item.batchId,
        clip: item.clip,
        kind: item.kind,
        elementId: item.elementId,
        key: item.key,
        value: item.value,
        status: item.status,
        hash: item.hash,
        code: item.code ?? '',
        error: item.error,
        supersededCount: item.supersededCount ?? 0,
        at: item.at ?? null,
      }));
    },

    /** 同一键最后落盘的值（测试与证据用）。 */
    lastApplied(clip, elementId, key) {
      const list = applied.get(clip) ?? [];
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const item = list[index];
        if (item.elementId === elementId && item.key === key) return item.value;
      }
      return undefined;
    },
  };
}

export { BOX_FIELD };
