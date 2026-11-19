/**
 * 源改动后的覆盖重定位（副线1 · S6-WP16）
 *
 * AI 或人改了 `scenes/x.html` 的结构之后，旧的覆盖条目必须**逐条**得到结论：
 *
 * - `KEPT`      内容身份在新源里仍唯一命中同一位置（或原位形状没变）
 * - `MOVED`     节点还在，但位置序号变了 → 给新的 `at`，值原样保留
 * - `GONE`      节点没了 → `LAYER_GONE`，条目移到旁挂区（**不删**）
 * - `AMBIGUOUS` 命中多个、无法消歧 → 不自动改，连同候选一起报冲突
 *
 * 本模块**只产建议**：返回新的覆盖集合 + 冲突文件内容与建议路径，
 * 一个字节都不写盘。真正的落盘是主线 `FilmDocIo` 的事（`persistence: 'WAIT_MAIN_IO'`），
 * 所以这里的输出可以被审核、被重放、被比对指纹。
 *
 * 判决顺序是刻意安排的：先用**内容身份**（id / data-name / src / 自身文本）找节点，
 * 找不到才退回「原位形状没变」，最后才用「同形状 + 内容相似」候选。位置（nth-of-type）
 * 永远只作最后一级证据——它正是会被结构改动改掉的东西。
 */
import crypto from 'node:crypto';
import {
  parseScene,
  pathOf,
  resolveAt,
  identityOf,
  shapeCompatible,
  indexByShape
} from './scene-tree.mjs';

/** @typedef {import('./scene-tree.mjs').SceneNode} SceneNode */
/** @typedef {import('./scene-tree.mjs').SceneTree} SceneTree */

export const STATUS = Object.freeze({
  KEPT: 'KEPT',
  MOVED: 'MOVED',
  GONE: 'GONE',
  AMBIGUOUS: 'AMBIGUOUS',
  /** 旧源里根本找不到这个节点：多半是脚本生成的 DOM，静态重定位不可信，明确拒绝。 */
  DYNAMIC_LAYER: 'DYNAMIC_LAYER'
});

/** 落盘不在本模块：给主线的显式标记。 */
export const PERSISTENCE = 'WAIT_MAIN_IO';
export const CONFLICT_DIR = '.film/conflicts';
export const DEFAULT_STAMP = 'NO-CLOCK';

/**
 * @typedef {object} OverrideEntry
 * @property {string} [at]
 * @property {number} [n]
 * @property {string} [t]
 * @property {readonly [number, number]} [s]
 * @property {number} [r]
 * @property {Readonly<Record<string, string>>} [style]
 * @property {true} [lock]
 * @property {string} [text]
 */

/**
 * @typedef {object} Candidate
 * @property {string} at
 * @property {string} tag
 * @property {string} text
 * @property {number} score
 * @property {string} why
 */

/**
 * @typedef {object} EntryResult
 * @property {string} at
 * @property {'KEPT'|'MOVED'|'GONE'|'AMBIGUOUS'|'DYNAMIC_LAYER'} status
 * @property {string} reason
 * @property {string|null} newAt
 * @property {Candidate[]} candidates
 * @property {OverrideEntry} override
 */

/**
 * @param {string} text
 */
export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * @param {Date|number|string|undefined} now
 * @returns {string}
 */
export function stampOf(now) {
  if (now === undefined) return DEFAULT_STAMP;
  const d = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(d.getTime())) return DEFAULT_STAMP;
  return d.toISOString().slice(0, 19).replace(/[-:]/g, '');
}

/**
 * @param {{oldHtml: string, newHtml: string, overrides: readonly OverrideEntry[], now?: Date|number|string, conflictDir?: string, batch?: string}} input
 * @returns {{
 *   persistence: 'WAIT_MAIN_IO',
 *   treeError: 'TREE_INCOMPLETE' | null,
 *   entries: EntryResult[],
 *   ownOverrides: OverrideEntry[],
 *   suggestedOverrides: OverrideEntry[],
 *   orphanedOverrides: OverrideEntry[],
 *   conflict: {path: string, content: object, text: string} | null,
 *   fingerprint: string,
 *   stats: {total: number, kept: number, moved: number, gone: number, ambiguous: number, dynamic: number, own: number, ms: number},
 *   notes: string[]
 * }}
 */
export function revalidateOverrides(input) {
  const started = performance.now();
  const oldHtml = String(input.oldHtml ?? '');
  const newHtml = String(input.newHtml ?? '');
  const overrides = Array.isArray(input.overrides) ? input.overrides : [];
  const conflictDir = input.conflictDir ?? CONFLICT_DIR;
  const batch = input.batch ?? 'B-SUB1-R4-004R1';

  const oldTree = parseScene(oldHtml);
  const newTree = parseScene(newHtml);

  /** @type {string[]} */
  const notes = [];
  for (const issue of oldTree.issues) notes.push(`old:${issue.code}:${issue.tag ?? ''}`);
  for (const issue of newTree.issues) notes.push(`new:${issue.code}:${issue.tag ?? ''}`);

  /* 截断/坏到不能当真源的树：一条建议都不给，原样退回，让人先修源 */
  if (!oldTree.complete || !newTree.complete) {
    return {
      persistence: PERSISTENCE,
      treeError: 'TREE_INCOMPLETE',
      entries: [],
      ownOverrides: overrides.filter((o) => typeof o.at !== 'string' || !o.at),
      suggestedOverrides: [...overrides],
      orphanedOverrides: [],
      conflict: null,
      fingerprint: sha256(canonical({ treeError: 'TREE_INCOMPLETE', old: notes, newText: newHtml.length })),
      stats: { total: 0, kept: 0, moved: 0, gone: 0, ambiguous: 0, dynamic: 0, own: 0, ms: Math.round((performance.now() - started) * 1000) / 1000 },
      notes
    };
  }

  const shapeIndex = indexByShape(newTree);
  const identityIndex = buildIdentityIndex(newTree);

  /** @type {EntryResult[]} */
  const entries = [];
  /** @type {OverrideEntry[]} */
  const ownOverrides = [];
  /** @type {OverrideEntry[]} */
  const suggestedOverrides = [];
  /** @type {OverrideEntry[]} */
  const orphanedOverrides = [];
  /** @type {object[]} */
  const conflictEntries = [];

  for (const override of overrides) {
    const at = typeof override.at === 'string' ? override.at : '';
    /* 片段自有条目（`{fade}`）：不是层覆盖，原样保留、不参与匹配、不计入四态 */
    if (!at) {
      ownOverrides.push(override);
      suggestedOverrides.push(override);
      continue;
    }
    const verdict = classify(oldTree, newTree, shapeIndex, identityIndex, at);
    /** @type {EntryResult} */
    const result = {
      at,
      status: /** @type {EntryResult['status']} */ (verdict.status),
      reason: verdict.reason,
      newAt: verdict.newAt ?? null,
      candidates: verdict.candidates ?? [],
      override
    };
    entries.push(result);

    if (result.status === STATUS.KEPT) {
      suggestedOverrides.push(override);
    } else if (result.status === STATUS.MOVED) {
      suggestedOverrides.push({ ...override, at: /** @type {string} */ (result.newAt) });
    } else if (result.status === STATUS.AMBIGUOUS) {
      /* 不自动改：原样留在集合里，同时进冲突清单等人决定 */
      suggestedOverrides.push(override);
      conflictEntries.push(conflictOf(result));
    } else if (result.status === STATUS.DYNAMIC_LAYER) {
      /* 静态源里没有它：不动覆盖，也不假装它还在；冲突清单里写清原因 */
      suggestedOverrides.push(override);
      conflictEntries.push(conflictOf(result));
    } else {
      orphanedOverrides.push(override);
      conflictEntries.push(conflictOf(result));
    }
  }

  const counts = {
    total: entries.length,
    kept: entries.filter((e) => e.status === STATUS.KEPT).length,
    moved: entries.filter((e) => e.status === STATUS.MOVED).length,
    gone: entries.filter((e) => e.status === STATUS.GONE).length,
    ambiguous: entries.filter((e) => e.status === STATUS.AMBIGUOUS).length,
    dynamic: entries.filter((e) => e.status === STATUS.DYNAMIC_LAYER).length,
    own: ownOverrides.length
  };

  const oldHash = sha256(oldHtml);
  const newHash = sha256(newHtml);
  /** @type {{path: string, content: object, text: string} | null} */
  let conflict = null;
  if (conflictEntries.length) {
    /** @type {object} */
    const content = {
      kind: 'overrides',
      batch,
      oldSourceHash: oldHash,
      newSourceHash: newHash,
      counts,
      entries: conflictEntries
    };
    conflict = {
      path: `${conflictDir}/${stampOf(input.now)}-${newHash.slice(0, 8)}-overrides.json`,
      content,
      text: JSON.stringify(content, null, 2) + '\n'
    };
  }

  const fingerprint = sha256(
    canonical({
      entries: entries.map((e) => ({ at: e.at, status: e.status, reason: e.reason, newAt: e.newAt })),
      ownOverrides,
      suggestedOverrides,
      orphanedOverrides,
      conflict: conflict ? { path: conflict.path, content: conflict.content } : null
    })
  );

  return {
    persistence: PERSISTENCE,
    treeError: null,
    entries,
    ownOverrides,
    suggestedOverrides,
    orphanedOverrides,
    conflict,
    fingerprint,
    stats: { ...counts, ms: Math.round((performance.now() - started) * 1000) / 1000 },
    notes
  };
}

/**
 * 单条判决。
 * @param {SceneTree} oldTree
 * @param {SceneTree} newTree
 * @param {Map<string, SceneNode[]>} shapeIndex
 * @param {Map<string, SceneNode[]>} identityIndex
 * @param {string} at
 * @returns {{status: string, reason: string, newAt?: string|null, candidates?: Candidate[]}}
 */
function classify(oldTree, newTree, shapeIndex, identityIndex, at) {
  const old = resolveAt(oldTree, at);
  const exact = resolveAt(newTree, at);

  /* 旧源里根本没有这个节点：脚本生成的 DOM（或覆盖来自别的源）。
     静态重定位对它一定不可信，明确拒绝，并把建议写给人看。 */
  if (!old) {
    return { status: STATUS.DYNAMIC_LAYER, reason: 'NOT_IN_OLD_SOURCE' };
  }

  const identity = identityOf(old);

  /* 一级：内容身份（跨位置可信） */
  if (identity.kind !== 'none') {
    const key = `${identity.kind}:${identity.value}`;
    const hits = identityIndex.get(key) ?? [];
    if (hits.length === 1) {
      const node = /** @type {SceneNode} */ (hits[0]);
      const newAt = pathOf(newTree, node);
      return newAt === at
        ? { status: STATUS.KEPT, reason: `IDENTITY_${identity.kind.toUpperCase()}` }
        : { status: STATUS.MOVED, reason: `IDENTITY_${identity.kind.toUpperCase()}`, newAt };
    }
    if (hits.length > 1) {
      return {
        status: STATUS.AMBIGUOUS,
        reason: 'MULTI_IDENTITY',
        candidates: candidatesOf(newTree, hits, 0)
      };
    }
  }

  /* 二级：原位还是它（文本/属性被就地改掉，但标签与首类没变）。
     但若两边都有**强身份**（id / data-name / src）且不同，原位那个已经是别人了——
     不能拿「位置一样」冒充「节点还在」。 */
  const exactIdentity = exact ? identityOf(exact) : { kind: 'none', value: '' };
  if (exact && shapeCompatible(old, exact) && !strongMismatch(identity, exactIdentity)) {
    return { status: STATUS.KEPT, reason: 'SHAPE_AT_PATH' };
  }

  /* 三级：同形状 + 内容相似 */
  const tag = old.tag;
  const cls = old.classes[0] ?? '';
  const pool = shapeIndex.get(`${tag}|${cls}`) ?? [];
  /** @type {{node: SceneNode, score: number, why: string[]}[]} */
  const scored = [];
  for (const node of pool) {
    if (node === exact) continue;
    const s = scoreCandidate(old, node);
    if (s.score >= 3) scored.push({ node, ...s });
  }
  scored.sort((a, b) => (b.score === a.score ? pathOf(newTree, a.node).localeCompare(pathOf(newTree, b.node)) : b.score - a.score));

  if (scored.length === 1) {
    const only = scored[0];
    if (!only) return { status: STATUS.GONE, reason: 'LAYER_GONE' };
    return {
      status: STATUS.MOVED,
      reason: 'SIMILAR_CONTENT',
      newAt: pathOf(newTree, only.node)
    };
  }
  if (scored.length > 1) {
    const top = scored[0];
    if (!top) return { status: STATUS.GONE, reason: 'LAYER_GONE' };
    const tied = scored.filter((s) => s.score === top.score);
    if (tied.length === 1) {
      const onlyTied = tied[0];
      if (!onlyTied) return { status: STATUS.GONE, reason: 'LAYER_GONE' };
      return { status: STATUS.MOVED, reason: 'SIMILAR_CONTENT', newAt: pathOf(newTree, onlyTied.node) };
    }
    return {
      status: STATUS.AMBIGUOUS,
      reason: 'MULTI_SIMILAR',
      candidates: candidatesOf(newTree, tied.map((t) => t.node), top.score)
    };
  }

  return { status: STATUS.GONE, reason: 'LAYER_GONE' };
}

/**
 * 强身份（id / data-name / src 类）不同 → 原位不是同一个节点。
 * 文本身份是弱身份：就地改文案是常态，不该因此判定「节点没了」。
 * @param {{kind: string, value: string}} a
 * @param {{kind: string, value: string}} b
 */
function strongMismatch(a, b) {
  /** @param {string} k */
  const strong = (k) => k === 'id' || k === 'data-name' || k === 'src';
  return strong(a.kind) && strong(b.kind) && a.value !== b.value;
}

/**
 * @param {SceneNode|null} old
 * @param {SceneNode} node
 * @returns {{score: number, why: string[]}}
 */
function scoreCandidate(old, node) {
  /** @type {string[]} */
  const why = [];
  let score = 0;
  if (!old) return { score, why };
  if (old.attrs['data-name'] && old.attrs['data-name'] === node.attrs['data-name']) {
    score += 3;
    why.push('data-name');
  }
  if (old.text && old.text === node.text) {
    score += 3;
    why.push('text');
  }
  for (const key of ['src', 'href', 'poster', 'alt']) {
    if (old.attrs[key] && old.attrs[key] === node.attrs[key]) {
      score += 2;
      why.push(key);
      break;
    }
  }
  if (old.parent && node.parent && old.parent.tag === node.parent.tag) {
    score += 1;
    why.push('parent-tag');
  }
  if (old.index === node.index) {
    score += 1;
    why.push('same-index');
  }
  return { score, why };
}

/**
 * @param {SceneTree} tree
 * @param {readonly SceneNode[]} nodes
 * @param {number} score
 * @returns {Candidate[]}
 */
function candidatesOf(tree, nodes, score) {
  return nodes
    .map((node) => ({
      at: pathOf(tree, node),
      tag: node.tag,
      text: node.text.slice(0, 40),
      score,
      why: 'identity'
    }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * @param {SceneTree} tree
 * @returns {Map<string, SceneNode[]>}
 */
function buildIdentityIndex(tree) {
  /** @type {Map<string, SceneNode[]>} */
  const map = new Map();
  for (const node of tree.nodes) {
    const id = identityOf(node);
    if (id.kind === 'none') continue;
    const key = `${id.kind}:${id.value}`;
    const list = map.get(key) ?? [];
    list.push(node);
    map.set(key, list);
  }
  return map;
}

/**
 * @param {EntryResult} e
 */
function conflictOf(e) {
  return {
    at: e.at,
    status: e.status,
    reason: e.reason,
    newAt: e.newAt,
    candidates: e.candidates,
    override: e.override
  };
}

/**
 * 稳定序列化：键排序，数组保序。
 * @param {unknown} value
 * @returns {string}
 */
function canonical(value) {
  /** @param {unknown} v @returns {unknown} */
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === 'object') {
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const key of Object.keys(/** @type {Record<string, unknown>} */ (v)).sort()) {
        out[key] = sort(/** @type {Record<string, unknown>} */ (v)[key]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/**
 * 只应用 MOVED 的建议（给主线写路径前的预览用）；GONE/AMBIGUOUS 不在这里处理。
 * @param {readonly OverrideEntry[]} overrides
 * @param {ReturnType<typeof revalidateOverrides>} report
 */
export function applyMoves(overrides, report) {
  const byOld = new Map(report.entries.map((e) => [e.at, e]));
  return overrides.map((o) => {
    const hit = byOld.get(typeof o.at === 'string' ? o.at : '');
    return hit && hit.status === STATUS.MOVED && hit.newAt ? { ...o, at: hit.newAt } : o;
  });
}
