/**
 * 元素级锁（S87 · B-SUB1-R31-045）：`overrides` 里 `lock: true` 的条目，**文档层**也要拦写。
 *
 * ## 为什么需要这个模块
 *
 * `apply-overrides.mjs` 的 `lock` 只在渲染时做两件事：给元素打 `data-locked="1"`、
 * 把 `pointer-events` 设成 `none`。前者是给检查器看的「这层锁了」，后者只挡鼠标命中。
 * 于是 Agent（或任何直接调 `/ops` 的客户端）照样能改一个「已锁定」的元素——
 * 检查器给了用户一个开关，锁上之后服务端不认，这个开关就是假的。
 *
 * 这里把**文档层**的那半条补上：一批 Op 只要有一条会改到「当前已锁定元素」的覆盖负载，
 * **整批**拒绝（`ELEMENT_LOCKED`，与轨道锁的 `LOCKED` 分开——原因不同，排查时不能混）。
 *
 * ## 什么算「改到锁定元素」
 *
 * 锁只保护**那一条覆盖条目里除了 `lock` 之外的负载**（`t` / `style` / `s` / `r` / 未来新增的键）。
 * 判据是「负载指纹」：把条目去掉 `lock` 之后做稳定序列化，前后不一致就是写入。
 * 由此得到三条自然结论（都不是特例代码）：
 *
 * - 解锁本身必须允许 → `{at, lock:true}` 变成 `{}`（条目消失或 `lock` 去掉）时，
 *   负载两边都是空，指纹相等 → 放行；
 * - 「解锁 + 顺手改一笔」不允许 → 同一条目既去 `lock` 又改 `t`，指纹变了 → 拒绝。
 *   解锁是一次独立动作，不能当后门；
 * - 夹具里 `{"at":"#footer","lock":true}` 这种**只有锁、没有负载**的条目，
 *   删掉它就是纯解锁，放行。
 *
 * ## 原子性
 *
 * 判据在 `applyOpsDetailed` **之前**跑，且沿批次逐条模拟（每条 Op 应用到一份克隆上）。
 * 任何一条命中锁定元素就整批拒——`edit-session.apply()` 拿到 `ok:false` 时磁盘一个字节没动，
 * 所以不存在「前半批写进去了」的中间态。
 *
 * ## 不覆盖什么（写清楚，别让下一个人以为漏了）
 *
 * 锁是**元素级**的（`at` 选择器），不是片段级：`remove` / `split` / `move` 这类动整条片段的
 * 结构 Op 不在这里拦——那是轨道锁（`film-core` 的 `track.locked`）与产品层的事。
 * 本模块只回答「这条覆盖会不会改到那个被锁住的元素」。
 */

import { applyOpsDetailed } from '../film-core/ops.mjs';

/** 与轨道锁的 `LOCKED` 分开：一个是轨道不让动，一个是元素不让改。 */
export const ELEMENT_LOCKED = 'ELEMENT_LOCKED';

/**
 * 稳定序列化（键排序），用来比较「同一条覆盖的负载有没有变」。
 * @param {any} value
 * @returns {string}
 */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

/**
 * 条目去掉 `lock`（锁本身）与 `at`（选择器是身份，不是负载）之后的指纹；只有锁的条目指纹是 `{}`。
 * @param {any} entry
 * @returns {string}
 */
function payloadOf(entry) {
  if (entry === null || entry === undefined) return '{}';
  /** @type {Record<string, unknown>} */
  const rest = {};
  for (const key of Object.keys(entry)) {
    if (key === 'lock' || key === 'at') continue;
    rest[key] = entry[key];
  }
  return canonical(rest);
}

/**
 * 一份 FilmDoc 里**所有**覆盖条目的负载指纹：`clipId -> Map<at, { fingerprint, locked }>`。
 * 解锁后条目还在、只是不带 `lock` 了，所以「批后」必须能查到它——只查锁定集合会把
 * 「解锁但保留负载」误判成「条目被删」。
 * @param {any} doc
 * @returns {Map<string, Map<string, { fingerprint: string, locked: boolean }>>}
 */
function indexEntries(doc) {
  /** @type {Map<string, Map<string, { fingerprint: string, locked: boolean }>>} */
  const out = new Map();
  for (const track of doc?.tracks ?? []) {
    for (const clip of track?.clips ?? []) {
      const entries = Array.isArray(clip?.overrides) ? clip.overrides : [];
      /** @type {Map<string, { fingerprint: string, locked: boolean }>} */
      const rows = new Map();
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object' || typeof entry.at !== 'string') continue;
        rows.set(entry.at, { fingerprint: payloadOf(entry), locked: entry.lock === true });
      }
      if (rows.size > 0) out.set(clip.id, rows);
    }
  }
  return out;
}

/**
 * 一份 FilmDoc 里所有元素级锁：`clipId -> Map<at, 负载指纹>`。
 * 没有锁的片段不进 Map（调用方据此走快路径）。
 * @param {any} doc
 * @returns {Map<string, Map<string, string>>}
 */
export function elementLocks(doc) {
  /** @type {Map<string, Map<string, string>>} */
  const out = new Map();
  for (const [clipId, rows] of indexEntries(doc)) {
    /** @type {Map<string, string>} */
    const locked = new Map();
    for (const [at, row] of rows) if (row.locked) locked.set(at, row.fingerprint);
    if (locked.size > 0) out.set(clipId, locked);
  }
  return out;
}

/**
 * 一批 Op 会不会改到当前已锁定的元素。
 *
 * 逐条模拟（每条应用到克隆上），所以「同一批里先加锁、后改同一条目」也拦得住。
 * 遇到非法 Op 时按 `applyOpsDetailed` 的语义抛 `EditError`（调用方原本就要处理）。
 *
 * @param {any} doc 批前文档
 * @param {readonly any[]} ops
 * @returns {{ ok: boolean, code?: string, message?: string, violations: { clip: string, at: string, opIndex: number, op: string, before: string, after: string }[], checkedOps: number }}
 */
export function findLockedWrites(doc, ops) {
  const before = elementLocks(doc);
  /* 快路径：文档里本来没有锁，这批 Op 也不含 `lock:true` —— 不可能凭空命中。
     （`lock:false` / 没有 lock 的批次都走这里，正常编辑不受影响。） */
  if (before.size === 0 && !ops.some((op) => JSON.stringify(op).includes('"lock":true'))) {
    return { ok: true, violations: [], checkedOps: 0 };
  }

  /**
   * 只有这几类 Op 会写到 `overrides`（`t` / `style` / `s` / `r` / `lock` 都住在这里），
   * 其余（move / split / remove / stage …）与元素锁无关，跳过。
   */
  const touchesOverrides = (/** @type {any} */ op) => {
    if (op === null || typeof op !== 'object') return false;
    if (op.op === 'overrides') return true;
    if (op.op === 'fields' && op.fields !== null && typeof op.fields === 'object') {
      return Object.prototype.hasOwnProperty.call(op.fields, 'overrides');
    }
    if (op.op === 'props' && Array.isArray(op.edits)) return op.edits.some((/** @type {any} */ edit) => edit?.prop === 'overrides');
    if (op.op === 'set' && op.field === 'overrides') return true;
    return false;
  };

  /** @type {{ clip: string, at: string, opIndex: number, op: string, before: string, after: string }[]} */
  const violations = [];
  for (let index = 0; index < ops.length; index += 1) {
    if (!touchesOverrides(ops[index])) continue;
    /* 用**前缀**重放（`ops[0..i]`）而不是逐条应用到影子文档上：
       前缀本身是一批合法的 Op，`dropEmptyTracks` / 排序这些批级收尾语义与真跑一致；
       逐条应用会让中间态与真实批次不同（例如先删空一条轨、再插到别处）。 */
    const after = indexEntries(applyOpsDetailed(doc, ops.slice(0, index + 1)).value);
    for (const [clipId, ats] of before) {
      for (const [at, fingerprint] of ats) {
        const now = after.get(clipId)?.get(at)?.fingerprint ?? '{}';
        if (now === fingerprint) continue;
        violations.push({
          clip: clipId,
          at,
          opIndex: index,
          op: typeof ops[index]?.op === 'string' ? ops[index].op : 'unknown',
          before: fingerprint,
          after: now,
        });
      }
    }
    if (violations.length > 0) break; // 整批已经要拒了，不必再往后算
  }

  if (violations.length === 0) return { ok: true, violations, checkedOps: ops.length };
  const where = violations.map((item) => `${item.at}（第 ${String(item.opIndex + 1)} 条 ${item.op}）`).join('、');
  return {
    ok: false,
    code: ELEMENT_LOCKED,
    message: `元素已锁定，不能修改：${where}。这批 ${String(ops.length)} 条 Op 全部未写入——先在图层里解锁再改。`,
    violations,
    checkedOps: ops.length,
  };
}
