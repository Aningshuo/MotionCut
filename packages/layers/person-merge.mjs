/**
 * 人工覆盖三方合并（副线1 · S12-PERSON-MERGE）
 *
 * 场景：Agent 重写场景后，人改过的 `overrides`（文字/样式/位置）不能被冲掉。
 * 这里做 base（Agent 读到的那版）/ ours（当前人工版）/ theirs（Agent 新写版）三方合并，
 * 规则来自合同 `edit-ops.ts` 的 `MergeReport`：
 *
 * - 只有 theirs 改 → 取 theirs（记 `tookWriter`）；
 * - 只有 ours 改 → 留 ours（记 `keptPerson`）；
 * - 两边都改且不同 → **留 ours**，并记一条冲突 `{unit, person, writer}`（值是 JSON 字符串，可审计）；
 * - 两边改成同一个值 → 取该值，不算冲突；
 * - `theirs` 删除且 `ours` 未改 → 删除；`ours` 删除 → 保持删除（人工优先，若 theirs 也改过则记冲突）。
 *
 * ## 边界（写死，别扩）
 *
 * - **只合并 overrides**。`at/time/speed/box/track/trackOrder` 这些时间线字段走 Op/写队列，本文件不碰；
 * - 不合并场景源码文本，不改 `.film/history`，不落盘、不读盘、不联网；
 * - 单层「把 patch 合并进完整数组」仍用 `override-merge.mjs` 的 `mergeOverridesAt`，本文件只做**三方决策**。
 *
 * ## 单位（unit）
 *
 * 一个「单位」= 一个片段的一个覆盖条目：
 * - 片段自有条目（没有 `at`，承载 `fade`）→ key `@own`
 * - 层条目 → key 是 `at`；同一 `at` 有多条时用 `n` 消歧（`<at>#n=<n>`）
 * - unit 字符串 = `<clipId>#<key>`，例如 `card-a#@own`、`card-a##subtitle`
 *
 * 输出顺序稳定：clip 按 ours → theirs 新增 → base 独有的顺序；clip 内 `@own` 在最前，其余按 key 字典序。
 */

export const MERGE_SCOPE = 'overrides';
export const OWN_KEY = '@own';

/** @param {unknown} entry */
export function entryKey(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const record = /** @type {any} */ (entry);
  if (record.at === undefined || record.at === null) return OWN_KEY;
  return record.n === undefined || record.n === null ? String(record.at) : `${record.at}#n=${record.n}`;
}

/**
 * 稳定 JSON：对象键排序，便于比较与审计（同样输入永远同样字符串）。
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(/** @type {any} */ (value)[k])}`).join(',')}}`;
}

/**
 * 把 FilmDoc 或投影取成 { order, byClip }。
 * 接受两种形状（二选一，文档里写清）：`{tracks:[{clips}]}` 或 `{clips:[...]}`。
 * @param {any} doc
 */
function project(doc) {
  /** @type {string[]} */
  const order = [];
  /** @type {Map<string, Map<string, any>>} */
  const byClip = new Map();
  const clips = Array.isArray(doc?.clips)
    ? doc.clips
    : Array.isArray(doc?.tracks)
      ? doc.tracks.flatMap((/** @type {any} */ track) => (Array.isArray(track?.clips) ? track.clips : []))
      : [];
  for (const clip of clips) {
    if (!clip || typeof clip.id !== 'string' || clip.id === '') continue;
    if (!byClip.has(clip.id)) {
      byClip.set(clip.id, new Map());
      order.push(clip.id);
    }
    const bucket = /** @type {Map<string, any>} */ (byClip.get(clip.id));
    const entries = Array.isArray(clip.overrides) ? clip.overrides : [];
    for (const entry of entries) {
      const key = entryKey(entry);
      if (key === null) continue;
      bucket.set(key, entry);
    }
  }
  return { order, byClip };
}

/** @param {unknown} a @param {unknown} b */
const same = (a, b) =>
  (a === undefined && b === undefined) ||
  (a !== undefined && b !== undefined && stableStringify(a) === stableStringify(b));

/** 冲突里给审计看的 JSON：不存在的条目写 `null`（合法 JSON，别写 `undefined`）。 @param {unknown} value */
const jsonOf = (value) => (value === undefined ? 'null' : stableStringify(value));

/**
 * 三方合并 overrides。
 *
 * @param {{base: any, ours: any, theirs: any}} input 三个文档（FilmDoc 或 `{clips}` 投影）
 * @returns {{
 *   clips: {clip: string, overrides: any[]}[],
 *   report: {keptPerson: string[], tookWriter: string[], conflicts: {unit: string, person: string, writer: string}[]},
 *   writerKept: {units: {unit: string, clip: string, key: string, entry: any|null}[], clips: {clip: string, overrides: any[]}[]}
 * }}
 */
export function mergePersonOverrides(input) {
  const B = project(input?.base);
  const O = project(input?.ours);
  const T = project(input?.theirs);

  /** @type {string[]} */
  const clipOrder = [];
  for (const id of [...O.order, ...T.order, ...B.order]) if (!clipOrder.includes(id)) clipOrder.push(id);

  /** @type {{clip: string, overrides: any[]}[]} */
  const clips = [];
  /** @type {string[]} */
  const keptPerson = [];
  /** @type {string[]} */
  const tookWriter = [];
  /** @type {{unit: string, person: string, writer: string}[]} */
  const conflicts = [];
  /** @type {{unit: string, clip: string, key: string, entry: any|null}[]} */
  const keptUnits = [];
  /** @type {Map<string, any[]>} */
  const keptByClip = new Map();

  for (const clipId of clipOrder) {
    /** @type {Map<string, any>} */
    const empty = new Map();
    const baseBucket = B.byClip.get(clipId) ?? empty;
    const oursBucket = O.byClip.get(clipId) ?? empty;
    const theirsBucket = T.byClip.get(clipId) ?? empty;
    /** @type {Set<string>} */
    const keys = new Set();
    for (const bucket of [baseBucket, oursBucket, theirsBucket]) for (const key of bucket.keys()) keys.add(key);
    if (keys.size === 0) {
      clips.push({ clip: clipId, overrides: [] });
      continue;
    }

    const sorted = [...keys].sort((a, b) => {
      if (a === OWN_KEY) return -1;
      if (b === OWN_KEY) return 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });

    /** @type {any[]} */
    const merged = [];
    for (const key of sorted) {
      const base = baseBucket.get(key);
      const ours = oursBucket.get(key);
      const theirs = theirsBucket.get(key);
      const unit = `${clipId}#${key}`;

      /** @type {any} */
      let value;
      if (same(ours, theirs)) {
        value = ours;
      } else if (same(theirs, base)) {
        value = ours;
        keptPerson.push(unit);
      } else if (same(ours, base)) {
        value = theirs;
        tookWriter.push(unit);
      } else {
        value = ours;
        keptPerson.push(unit);
        conflicts.push({ unit, person: jsonOf(ours), writer: jsonOf(theirs) });
        keptUnits.push({ unit, clip: clipId, key, entry: theirs === undefined ? null : theirs });
        if (theirs !== undefined) {
          const list = keptByClip.get(clipId) ?? [];
          list.push(theirs);
          keptByClip.set(clipId, list);
        }
      }
      if (value !== undefined) merged.push(value);
    }
    clips.push({ clip: clipId, overrides: merged });
  }

  return {
    clips,
    report: { keptPerson, tookWriter, conflicts },
    writerKept: {
      units: keptUnits,
      clips: [...keptByClip.entries()].map(([clip, overrides]) => ({ clip, overrides }))
    }
  };
}

export default mergePersonOverrides;
