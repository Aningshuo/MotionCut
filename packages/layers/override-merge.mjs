/**
 * 覆盖合并的纯函数（副线1 · WP14）
 *
 * 只合并显式给出的键；**绝不**把 computed 整包写进 override。
 * .mjs 而不是 .ts：inspector.ts 与 edit-session.ts 都要在运行时引用，
 * Node 的 type-stripping 不允许无扩展名/带 .ts 的运行时 import。
 *
 * @typedef {import('../../contracts/layers').OverridePatch} OverridePatch
 */

/* E12-P3 B5（R38）：四个文本样式键的**唯一键表**（与写盘校验同一个模块）。 */
import { TEXT_STYLE_KEYS } from '../film-core/text-style.mjs';

/**
 * @param {OverridePatch|null|undefined} base
 * @param {OverridePatch} patch
 * @returns {OverridePatch}
 */
export function mergeOverride(base, patch) {
  /** @type {Record<string,string>} */
  const style = { ...(base && base.style ? base.style : {}) };
  for (const [k, v] of Object.entries(patch.style || {})) style[k] = v;
  /** @type {any} */
  const merged = { ...(base || {}) };
  if (patch.t !== undefined) merged.t = patch.t;
  if (patch.s !== undefined) merged.s = patch.s;
  if (patch.r !== undefined) merged.r = patch.r;
  if (patch.lock !== undefined) merged.lock = true;
  /* E05 关键帧（R27 · E12-P4）：`kf` 数组**整条替换**，不做逐帧合并 ——
     面板每次合成都给完整序列；`null` = 清除（`undefined` 表示这次不动它）。
     `OverridePatch`（contracts/layers.ts）没有这个键，这里按 any 读 ——
     不改契约、也不用 `@ts-ignore` 盖住整段。 */
  const patchAny = /** @type {any} */ (patch);
  if (patchAny.kf === null) delete /** @type {any} */ (merged).kf;
  else if (patchAny.kf !== undefined) /** @type {any} */ (merged).kf = patchAny.kf;
  /* E12-P3 B5（R38）：文本样式四项（stroke / bg / align / tracking）。
     与 `kf` **同一套 null 语义**：`null` = 删掉这个键（清空描边/底框），`undefined` = 这次不动它。
     不加这一段，面板四个输入框会「能显示、提交却静默丢掉」（`OverridePatch` 里没有这四键，
     它们只在 `OverrideEntry` 上）。 */
  for (const key of TEXT_STYLE_KEYS) {
    if (patchAny[key] === null) delete /** @type {any} */ (merged)[key];
    else if (patchAny[key] !== undefined) /** @type {any} */ (merged)[key] = patchAny[key];
  }
  if (Object.keys(style).length) merged.style = style;
  return merged;
}

/**
 * 覆盖里被改动过的键（含几何与文本）。
 * @param {OverridePatch|null|undefined} override
 * @returns {string[]}
 */
export function overrideKeys(override) {
  if (!override) return [];
  /** @type {string[]} */
  const keys = [];
  if (override.t !== undefined) keys.push('t');
  if (override.s !== undefined) keys.push('s');
  if (override.r !== undefined) keys.push('r');
  if (override.lock !== undefined) keys.push('lock');
  for (const k of Object.keys(override.style || {})) keys.push(`style:${k}`);
  return keys;
}

/**
 * @param {OverridePatch} patch
 * @returns {string[]}
 */
export function patchKeys(patch) {
  return overrideKeys(patch);
}

/**
 * 是否「片段自有」条目（没有 `at`）：只承载 `fade` 这类片段级属性。
 * @param {unknown} entry
 * @returns {boolean}
 */
export function isOwnEntry(entry) {
  return !!entry && typeof entry === 'object' && (/** @type {any} */ (entry).at === undefined || /** @type {any} */ (entry).at === null);
}

/**
 * 条目除 `at`/`n` 之外是否还有内容；没有内容的条目要删掉（清除语义）。
 * @param {unknown} entry
 * @returns {boolean}
 */
export function hasEntryBody(entry) {
  if (!entry || typeof entry !== 'object') return false;
  return Object.keys(entry).some((k) => k !== 'at' && k !== 'n' && /** @type {any} */ (entry)[k] !== undefined);
}

/**
 * 把某层的 patch 合并进**完整** overrides 数组（S10）。
 *
 * 规则（写死，别在 UI 里另写一份）：
 * - 片段自有条目（无 `at`，承载 `fade`）**原样保留**，位置不动；
 * - 目标层按 `at` 合并（`mergeOverride`），已有条目**原位**替换，新层追加到末尾；
 * - 其他层的条目一个字节都不改；
 * - 合并后没有内容的层条目删除；`patch === null` 表示删掉该层条目（回到场景值）；
 * - 不排序、不去重、不把 computed 烘进条目。
 *
 * @param {readonly any[]} entries 片段现有 overrides
 * @param {string} at 目标层定位串
 * @param {OverridePatch|null} patch 只含用户改的键；null = 清除该层覆盖
 * @returns {any[]} 新的完整数组（调用方负责提交，本函数不落盘）
 */
export function mergeOverridesAt(entries, at, patch) {
  const list = Array.isArray(entries) ? entries : [];
  /** @type {any[]} */
  const out = [];
  let merged = false;
  for (const entry of list) {
    if (isOwnEntry(entry) || !entry || typeof entry !== 'object') {
      out.push(entry);
      continue;
    }
    if (entry.at !== at || merged) {
      out.push(entry);
      continue;
    }
    merged = true;
    if (patch === null) continue;
    const next = mergeOverride(entry, patch);
    if (hasEntryBody(next)) out.push(next);
  }
  if (!merged && patch) {
    const fresh = mergeOverride(/** @type {any} */ ({ at }), patch);
    if (hasEntryBody(fresh)) out.push(fresh);
  }
  return out;
}

/**
 * @param {OverridePatch|null|undefined} a
 * @param {OverridePatch|null|undefined} b
 * @param {string} key
 * @returns {boolean}
 */
export function sameKeyValue(a, b, key) {
  /** @param {OverridePatch|null|undefined} o */
  const read = (o) => {
    if (!o) return undefined;
    if (key.startsWith('style:')) return o.style ? o.style[key.slice(6)] : undefined;
    if (key === 't') return o.t;
    if (key === 's') return o.s ? [...o.s] : undefined;
    if (key === 'r') return o.r;
    if (key === 'lock') return o.lock;
    /* E12-P3 B5（R38）：四个文本样式键 —— 不认它们的话「写回后读回比对」永远判不一致，
       面板会一直显示「已写回但读回不一致」（假红）。 */
    if (key === 'stroke' || key === 'bg' || key === 'align' || key === 'tracking') {
      return /** @type {any} */ (o)[key];
    }
    return undefined;
  };
  return JSON.stringify(read(a)) === JSON.stringify(read(b));
}
