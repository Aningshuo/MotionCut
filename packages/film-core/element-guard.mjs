/**
 * 元素写入守卫（R143 / SUB1 · M14-R2 · A）—— **project / instance / element / epoch** 四维合同。
 *
 * 为什么要有这一层：写入口（`ops-write.mjs` → `film-doc.mjs`）只认「哪个片段、哪些覆盖条目」，
 * 对「这个元素现在还在不在、还是不是当初选中的那个节点」一无所知。于是把元素从页里删掉之后
 * 再提交样式，覆盖仍然会挂到一个已不存在的选择器上，`/ops` 返回 `ok:true`、doc sha 也变了。
 * 那不是「写成功了」，是**没有目标的写入**。
 *
 * 这一层只做判定，不读盘、不看时钟（纯函数）。观察值由调用方给：
 * - `intent`：客户端**选中元素时**看到的事实（`instanceId` + `signature`），随写请求一起上来；
 * - `observation`：服务端在**写之前**按同一份源码复算出来的事实；
 * - `state`：本会话的 epoch 台账（每个元素最后一次被接受的选中代数），只用于判「迟到的旧回包」。
 *
 * 判定顺序（先具体后笼统；每个码只对应一种真实情况，便于排障时一眼分辨）：
 * 1. `FOREIGN_PROJECT` —— 声明的工程不是正在写的工程（403）；
 * 2. `ELEMENT_GONE` —— 源码里已经找不到这个定位串（409）；
 * 3. `ELEMENT_UNMOUNTED` —— 还在源码里，但父级 `hidden` / `display:none` / `<template>`（409）；
 * 4. `ELEMENT_REPLACED` —— 定位串还在，节点签名变了（同 ref 新节点）（409）；
 * 5. 页面实例变了但节点签名没变 → **重建中**：放行并打标，连续超过 `GUARD_RETRY_MAX` 次才拒
 *    （`REBUILD_EXHAUSTED`，409）。重建不是失效，不能一律拒绝；
 * 6. `STALE_EPOCH` —— 代数比本会话已接受的旧（409）。**切换选中会涨代数，所以照常放行**。
 *
 * 关键取舍：后两条不能因为「怕写错」就把正常编辑挡掉。守卫宁可漏一次「重建中」的写，
 * 也不能把「用户换了个选择又写回来」判成失效。
 */

/** 守卫错误码（写进 `EditError.code` 与 HTTP 响应体，客户端据此给可解释提示）。 */
export const GUARD_CODES = Object.freeze({
  FOREIGN_PROJECT: 'FOREIGN_PROJECT',
  ELEMENT_GONE: 'ELEMENT_GONE',
  ELEMENT_UNMOUNTED: 'ELEMENT_UNMOUNTED',
  ELEMENT_REPLACED: 'ELEMENT_REPLACED',
  STALE_EPOCH: 'STALE_EPOCH',
  REBUILD_EXHAUSTED: 'REBUILD_EXHAUSTED',
  TARGET_MISMATCH: 'TARGET_MISMATCH',
  PAGE_UNREADABLE: 'PAGE_UNREADABLE',
});

/** 每个码对应的 HTTP 状态（`/ops` 直接用它；不给调用方自己猜）。 */
export const GUARD_HTTP = Object.freeze({
  FOREIGN_PROJECT: 403,
  ELEMENT_GONE: 409,
  ELEMENT_UNMOUNTED: 409,
  ELEMENT_REPLACED: 409,
  STALE_EPOCH: 409,
  REBUILD_EXHAUSTED: 409,
  TARGET_MISMATCH: 400,
  PAGE_UNREADABLE: 409,
});

/** 「重建中」允许连续写几次。第 `N+1` 次仍未拿到新实例 → 明确 BLOCKED，不无限重试。 */
export const GUARD_RETRY_MAX = 3;

/** 元素签名里参与哈希的属性（顺序固定，保证跨进程稳定）。 */
const SIGNATURE_ATTRS = Object.freeze([
  'data-name',
  'data-testid',
  'data-key',
  'data-id',
  'name',
  'alt',
  'aria-label',
  'src',
  'href',
]);

/**
 * 元素统一 id：`<clipId>::<元素定位串>`（与 `layers-read.parseElementId` 同一写法）。
 * @param {string} clipId
 * @param {string} at
 * @returns {string}
 */
export function elementKeyOf(clipId, at) {
  if (typeof clipId !== 'string' || clipId === '') return '';
  if (typeof at !== 'string' || at === '') return '';
  return `${clipId}::${at}`;
}

/**
 * 拆 `<clipId>::<at>`。没有前缀 = 不是元素级目标，返回 null（不猜）。
 * @param {string} key
 * @returns {{ clipId: string, at: string } | null}
 */
export function parseElementKey(key) {
  if (typeof key !== 'string') return null;
  const at = key.indexOf('::');
  if (at <= 0) return null;
  const clipId = key.slice(0, at);
  const local = key.slice(at + 2);
  if (clipId === '' || local === '') return null;
  return { clipId, at: local };
}

/**
 * 节点签名：把「这一个节点」压成一个短串（FNV-1a 32 位，8 位十六进制）。
 *
 * 参与哈希的是**内容身份**，不是位置：`at` 本身已经是位置了，再拿位置算签名就等于
 * 「位置没变就算同一个节点」，而同 ref 换节点恰恰是位置不变、内容变了。
 * 文本只取前 120 字（与图层列表同一截断），避免长文本让签名对不可见空白敏感。
 * @param {{tag?: string, id?: string, classes?: readonly string[], text?: string, childCount?: number, parentKey?: string|null, attrs?: Record<string, string>}} facts
 * @returns {string}
 */
export function signatureOf(facts) {
  const tag = String(facts.tag ?? '').toLowerCase();
  const id = String(facts.id ?? '');
  const classes = [...(facts.classes ?? [])].map(String).sort().join('.');
  const text = String(facts.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const childCount = Number.isFinite(Number(facts.childCount)) ? Number(facts.childCount) : 0;
  const parent = String(facts.parentKey ?? '');
  const attrs = facts.attrs ?? {};
  const attrPart = SIGNATURE_ATTRS.map((key) => `${key}=${String(attrs[key] ?? '')}`).join('\u0001');
  const material = [tag, id, classes, text, String(childCount), parent, attrPart].join('\u0002');
  let hash = 0x811c9dc5;
  for (let index = 0; index < material.length; index += 1) {
    hash ^= material.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * 一次写里**真正落到元素上**的条目：只认 `overrides` 的 `at` 条目（`props`/`fields` 是片段级）。
 *
 * `isNew` = 这个 `at` 在该片段现有覆盖里还没有。旧条目会随「完整数组」每次重发，
 * 它们不代表这次要新写一个元素；只有新条目才需要过存在性检查，否则删掉一个元素之后
 * 连改别的元素都会被历史条目挡住（那是把守卫变成拦路虎）。
 * @param {any} value 解析后的 FilmDoc
 * @param {readonly any[]} ops
 * @returns {{ elementKey: string, clipId: string, at: string, isNew: boolean }[]}
 */
export function elementWritesOf(value, ops) {
  /** @type {{ elementKey: string, clipId: string, at: string, isNew: boolean }[]} */
  const out = [];
  if (!Array.isArray(ops) || value === null || typeof value !== 'object') return out;
  const clips = indexClips(value);
  for (const op of ops) {
    if (op === null || typeof op !== 'object' || op.op !== 'overrides') continue;
    const clipId = typeof op.clip === 'string' ? op.clip : '';
    if (clipId === '') continue;
    const clip = clips.get(clipId);
    const existing = new Set(
      (Array.isArray(clip?.overrides) ? clip.overrides : [])
        .filter((/** @type {any} */ entry) => entry !== null && typeof entry === 'object' && typeof entry.at === 'string')
        .map((/** @type {any} */ entry) => String(entry.at)),
    );
    for (const entry of Array.isArray(op.entries) ? op.entries : []) {
      if (entry === null || typeof entry !== 'object') continue;
      const at = typeof entry.at === 'string' ? entry.at : '';
      if (at === '') continue;
      out.push({ elementKey: elementKeyOf(clipId, at), clipId, at, isNew: !existing.has(at) });
    }
  }
  return out;
}

/**
 * @param {any} value
 * @returns {Map<string, any>}
 */
function indexClips(value) {
  /** @type {Map<string, any>} */
  const map = new Map();
  for (const track of Array.isArray(value?.tracks) ? value.tracks : []) {
    for (const clip of Array.isArray(track?.clips) ? track.clips : []) {
      if (clip !== null && typeof clip === 'object' && typeof clip.id === 'string') map.set(clip.id, clip);
    }
  }
  return map;
}

/**
 * 空台账：一个工程一份（放编辑会话里，随会话重载清空）。
 * @returns {{ epochs: Record<string, number>, rebuilds: Record<string, number> }}
 */
export function createGuardState() {
  return { epochs: {}, rebuilds: {} };
}

/**
 * @typedef {object} ElementIntent
 * @property {string} projectId     写的是哪个工程
 * @property {string} instanceId    选中时页面实例（页面源码哈希）
 * @property {string} elementKey    `<clipId>::<at>`
 * @property {string} signature     选中时节点签名
 * @property {number} epoch         选中代数（单调递增）
 */

/**
 * @typedef {object} ElementObservation
 * @property {string} projectId
 * @property {string} instanceId
 * @property {Record<string, { present: boolean, mounted: boolean, signature: string }>} elements
 */

/**
 * @typedef {{ ok: true, rebuilding: boolean, attempts: number, limit: number }
 *   | { ok: false, code: string, status: number, message: string, detail: Record<string, unknown> }} GuardVerdict
 */

/**
 * 判一次写能不能落到这个元素上。**不改台账**（改台账是 `recordElementIntent`，只有写成功才调）。
 * @param {ElementIntent} intent
 * @param {ElementObservation} observation
 * @param {{ epochs: Record<string, number>, rebuilds: Record<string, number> }} state
 * @returns {GuardVerdict}
 */
export function checkElementIntent(intent, observation, state) {
  const key = String(intent?.elementKey ?? '');
  if (intent.projectId !== observation.projectId) {
    return reject(
      GUARD_CODES.FOREIGN_PROJECT,
      `目标元素属于别的工程：请求 ${String(intent.projectId)}，当前 ${String(observation.projectId)}`,
      { intentProject: intent.projectId, projectId: observation.projectId },
    );
  }
  const entry = observation.elements[key];
  if (entry === undefined || entry.present !== true) {
    return reject(GUARD_CODES.ELEMENT_GONE, `元素已不在这一帧里：${key}`, { elementKey: key });
  }
  if (entry.mounted !== true) {
    return reject(GUARD_CODES.ELEMENT_UNMOUNTED, `元素仍在源码里但父级已卸载（hidden / display:none / template）：${key}`, {
      elementKey: key,
    });
  }
  if (String(intent.signature) !== entry.signature) {
    /* 同 ref 新节点：位置/选择器没变，节点内容变了。epoch 一并记下来，便于分辨
       「用户换了选择」与「页面在背后被换过」。 */
    return reject(GUARD_CODES.ELEMENT_REPLACED, `元素已被替换（同一选择器指向了新节点）：${key}`, {
      elementKey: key,
      intentSignature: String(intent.signature),
      observedSignature: entry.signature,
      intentEpoch: Number(intent.epoch),
      currentEpoch: Number(state.epochs[key] ?? 0),
    });
  }
  const lastEpoch = Number(state.epochs[key] ?? 0);
  const epoch = Number(intent.epoch);
  if (!Number.isFinite(epoch)) {
    return reject(GUARD_CODES.TARGET_MISMATCH, `epoch 必须是数字（收到 ${String(intent.epoch)}）`, { elementKey: key });
  }
  if (epoch < lastEpoch) {
    return reject(GUARD_CODES.STALE_EPOCH, `这次写带着旧代数（${epoch} < ${lastEpoch}）：目标可能已经换过，请重选后再写`, {
      elementKey: key,
      intentEpoch: epoch,
      currentEpoch: lastEpoch,
    });
  }
  const rebuilding = String(intent.instanceId) !== observation.instanceId;
  if (!rebuilding) return { ok: true, rebuilding: false, attempts: 0, limit: GUARD_RETRY_MAX };
  const attempts = Number(state.rebuilds[key] ?? 0) + 1;
  if (attempts > GUARD_RETRY_MAX) {
    return reject(
      GUARD_CODES.REBUILD_EXHAUSTED,
      `页面一直在重建：同一个元素连续 ${GUARD_RETRY_MAX} 次在旧实例上提交，已停止重试（重新观察后再写）`,
      { elementKey: key, attempts: attempts - 1, limit: GUARD_RETRY_MAX, intentInstance: String(intent.instanceId), observedInstance: observation.instanceId },
    );
  }
  return { ok: true, rebuilding: true, attempts, limit: GUARD_RETRY_MAX };
}

/**
 * 写成功之后才记台账：epoch 取较大值；重建次数按「连续」计（下一次不是重建就清零）。
 * @param {ElementIntent} intent
 * @param {{ epochs: Record<string, number>, rebuilds: Record<string, number> }} state
 * @param {{ ok: true, rebuilding: boolean, attempts: number, limit: number }} verdict
 */
export function recordElementIntent(intent, state, verdict) {
  const key = String(intent.elementKey ?? '');
  const epoch = Number(intent.epoch);
  if (Number.isFinite(epoch)) state.epochs[key] = Math.max(Number(state.epochs[key] ?? 0), epoch);
  if (verdict.rebuilding) state.rebuilds[key] = verdict.attempts;
  else delete state.rebuilds[key];
}

/**
 * 一批 op 里的元素写是否都落在声明的目标上。
 *
 * 规矩：**声明了目标**就必须真有写到它（否则「守卫一个元素、写另一个」可以绕过去）；
 * 新条目必须都在观察里且已挂载；历史条目（`isNew=false`）不重复判。
 * @param {ElementIntent} intent
 * @param {{ elementKey: string, clipId: string, at: string, isNew: boolean }[]} writes
 * @param {ElementObservation} observation
 * @returns {{ ok: true } | { ok: false, code: string, status: number, message: string, detail: Record<string, unknown> }}
 */
export function checkElementWrites(intent, writes, observation) {
  const target = String(intent.elementKey ?? '');
  if (writes.length === 0) {
    return reject(GUARD_CODES.TARGET_MISMATCH, `这批 op 没有写到任何元素，但请求声明了目标 ${target}`, { elementKey: target });
  }
  if (!writes.some((write) => write.elementKey === target)) {
    return reject(GUARD_CODES.TARGET_MISMATCH, `这批 op 没有写到声明的目标 ${target}`, {
      elementKey: target,
      written: writes.map((write) => write.elementKey),
    });
  }
  for (const write of writes) {
    if (!write.isNew) continue;
    const entry = observation.elements[write.elementKey];
    if (entry === undefined || entry.present !== true) {
      return reject(GUARD_CODES.ELEMENT_GONE, `元素已不在这一帧里：${write.elementKey}`, { elementKey: write.elementKey });
    }
    if (entry.mounted !== true) {
      return reject(GUARD_CODES.ELEMENT_UNMOUNTED, `元素仍在源码里但父级已卸载：${write.elementKey}`, {
        elementKey: write.elementKey,
      });
    }
  }
  return { ok: true };
}

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} detail
 * @returns {{ ok: false, code: string, status: number, message: string, detail: Record<string, unknown> }}
 */
function reject(code, message, detail) {
  const status = /** @type {Record<string, number>} */ (GUARD_HTTP)[code] ?? 409;
  return { ok: false, code, status, message, detail };
}
