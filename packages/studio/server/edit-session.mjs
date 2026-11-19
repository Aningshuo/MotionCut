/**
 * 编辑会话：Op 批 → 值 → film.html，经 `FilmDocIo` 做 CAS + 历史快照（WP07 的落盘侧）。
 *
 * 一次 `apply()` 的顺序（任何一步失败都不留半份文件）：
 * 1. `applyOpsDetailed`：纯内存，失败抛 `EditError`（INVALID / NOT_FOUND / LOCKED），磁盘没动过；
 * 2. `writeValue`：把新值写成 `film.html` 的**局部补丁**，写前核对 `expectedHash`；
 * 3. `io.commit`：磁盘哈希必须仍等于 `expectedHash`（CAS），否则 CONFLICT 且不写；
 *    IO 失败（注入错误、写不动）返回 IO，同样不写；
 * 4. `io.snapshot`：成功写入才落一条 `.film/history` 快照；
 * 5. 只有全部成功才更新内存状态并把这一批压进撤销栈（栈满 200 步）。
 *
 * 撤销：以 Op 批为单位。模型侧用反向 Op（`applyOpsDetailed().inverse`，可审计），
 * 落盘侧直接用这一批之前的**原文**做 CAS 恢复——只有这样哈希才会逐字节回到起点。
 */

import { dirname } from 'node:path';

import { parse } from '../../film-core/film-doc.mjs';
import { EditError, applyOpsDetailed } from '../../film-core/ops.mjs';
import { writeValue } from '../../film-core/ops-write.mjs';
import {
  checkElementIntent,
  checkElementWrites,
  createGuardState,
  elementWritesOf,
  parseElementKey,
  recordElementIntent,
} from '../../film-core/element-guard.mjs';
import { findLockedWrites } from '../../layers/element-lock.mjs';

export const MAX_UNDO = 200;

/**
 * 按 id 找片段（守卫只需要 `src`）。
 * @param {any} value
 * @param {string} clipId
 * @returns {any | null}
 */
function findClipInValue(value, clipId) {
  for (const track of Array.isArray(value?.tracks) ? value.tracks : []) {
    for (const clip of Array.isArray(track?.clips) ? track.clips : []) {
      if (clip !== null && typeof clip === 'object' && clip.id === clipId) return clip;
    }
  }
  return null;
}

/**
 * @param {{
 *   path: string,
 *   io: any,
 *   history?: boolean,
 *   maxUndo?: number,
 *   projectId?: string,
 *   now?: () => Date,
 *   observe?: (input: { src: unknown, keys: string[] }) => Promise<
 *     | { ok: true, observation: any }
 *     | { ok: false, code: string, message: string }>,
 * }} options
 */
export function createEditSession(options) {
  const { path, io } = options;
  const projectDir = dirname(path);
  const withHistory = options.history !== false;
  const maxUndo = options.maxUndo ?? MAX_UNDO;
  const observe = typeof options.observe === 'function' ? options.observe : null;
  /* 元素目标的 epoch 台账：只在**本会话**内有效（重载/重开清零，见 load()）。 */
  const guardState = createGuardState();
  /** @type {{ intent: any, verdict: any } | null} */
  let pendingGuard = null;

  /** @type {{ text: string, value: any, sourceHash: string } | null} */
  let current = null;
  /** @type {{ beforeText: string, beforeHash: string, afterHash: string, ops: any[], inverse: any[] }[]} */
  const undoStack = [];
  /** @type {{ beforeText: string, beforeHash: string, afterHash: string, ops: any[], inverse: any[] }[]} */
  const redoStack = [];
  let loaded = false;

  /** @returns {Promise<{ ok: true, value: any, sourceHash: string } | { ok: false, code: string, message: string }>} */
  async function load() {
    /** @type {{ text: string, sourceHash: string }} */
    let read;
    try {
      read = await io.read(path);
    } catch (error) {
      return { ok: false, code: 'FILM_UNREADABLE', message: String(/** @type {Error} */ (error).message) };
    }
    const parsed = parse(read.text, { path });
    if (parsed.doc === null) {
      return {
        ok: false,
        code: 'INVALID',
        message: parsed.diagnostics.filter((/** @type {any} */ diag) => diag.severity === 'error').map((/** @type {any} */ diag) => diag.code).join(','),
      };
    }
    current = { text: read.text, value: parsed.doc, sourceHash: parsed.sourceHash };
    loaded = true;
    /* 重载 = 磁盘被外部改过（或刚打开）：目标台账清零，不能让上一份文档的代数继续生效。 */
    guardState.epochs = {};
    guardState.rebuilds = {};
    pendingGuard = null;
    return { ok: true, value: parsed.doc, sourceHash: read.sourceHash };
  }

  function ensure() {
    if (current === null || !loaded) throw new EditError('会话尚未 load()', 'INVALID');
    return /** @type {{ text: string, value: any, sourceHash: string }} */ (current);
  }


  /**
   * R143 元素写守卫：把「这批 op 写到的元素」与「声明的目标」对一遍。
   *
   * 返回 `null` = 放行；否则返回可以直接交给 HTTP 的拒绝结果（**磁盘一个字节没动**）。
   * 只在请求带 `target` 时生效：片段级编辑（时间线/音量/几何）没有元素，不该被这条挡住。
   * @param {any} value
   * @param {readonly any[]} ops
   * @param {{ opId?: string, target?: any }} meta
   * @returns {Promise<null | { ok: false, error: any, touched?: string[] }>}
   */
  async function guardTarget(value, ops, meta) {
    const target = meta.target;
    if (target === null || target === undefined) return null;
    if (observe === null) {
      return rejectTarget('PAGE_UNREADABLE', '服务端没有接页面观察器，无法校验元素目标', 409, { elementKey: String(target.elementKey ?? '') });
    }
    const parsed = parseElementKey(String(target.elementKey ?? ''));
    if (parsed === null) {
      return rejectTarget('TARGET_MISMATCH', `elementKey 必须形如 <clipId>::<at>（收到 ${String(target.elementKey)}）`, 400, {});
    }
    const clip = findClipInValue(value, parsed.clipId);
    if (clip === null) {
      return rejectTarget('ELEMENT_GONE', `片段不在当前文档里：${parsed.clipId}`, 409, { elementKey: String(target.elementKey) });
    }
    const writes = elementWritesOf(value, ops);
    const keys = [...new Set([String(target.elementKey), ...writes.map((write) => write.elementKey)])];
    const observed = await observe({ src: clip.src, keys });
    if (observed.ok !== true) {
      return rejectTarget(observed.code, observed.message, 409, { elementKey: String(target.elementKey) });
    }
    const intent = {
      projectId: String(target.projectId ?? ''),
      instanceId: String(target.instanceId ?? ''),
      elementKey: String(target.elementKey),
      signature: String(target.signature ?? ''),
      epoch: Number(target.epoch),
    };
    const verdict = checkElementIntent(intent, observed.observation, guardState);
    if (verdict.ok !== true) {
      return rejectTarget(verdict.code, verdict.message, verdict.status, verdict.detail);
    }
    const shape = checkElementWrites(intent, writes, observed.observation);
    if (shape.ok !== true) {
      return rejectTarget(shape.code, shape.message, shape.status, shape.detail);
    }
    /* 只有**写成功**才记账（见 recordElementIntent 的两处调用），失败不消耗代数。 */
    pendingGuard = { intent, verdict };
    return null;
  }

  /**
   * @param {string} code
   * @param {string} message
   * @param {number} status
   * @param {Record<string, unknown>} detail
   */
  function rejectTarget(code, message, status, detail) {
    pendingGuard = null;
    return {
      ok: /** @type {const} */ (false),
      error: { code, message, status, detail, opId: undefined },
    };
  }

  /**
   * 写成功之后把代数记进台账，并给客户端一份**新的观察标**（它下一次写要带新的 epoch/实例）。
   * @returns {{ elementKey: string, epoch: number, rebuilding: boolean } | null}
   */
  function settleGuard() {
    const pending = pendingGuard;
    pendingGuard = null;
    if (pending === null) return null;
    recordElementIntent(pending.intent, guardState, pending.verdict);
    return {
      elementKey: pending.intent.elementKey,
      epoch: Number(guardState.epochs[pending.intent.elementKey] ?? pending.intent.epoch),
      rebuilding: pending.verdict.rebuilding === true,
      /* R150 · M16-R3：「重建中」是一次**记账过的重试**，不是布尔。把计数与上限一起交出去，
         客户端/量具才能分清「第 1 次命中」与「快用完了」。 */
      ...(pending.verdict.rebuilding === true
        ? { attempts: Number(pending.verdict.attempts ?? 0), limit: Number(pending.verdict.limit ?? 0) }
        : {}),
    };
  }

  /**
   * 应用一批 Op。
   * @param {readonly any[]} ops
   * @param {{ opId?: string, by?: 'person'|'agent', target?: any }} [meta]
   * @returns {Promise<
   *   | { ok: true, hash: string, changed: boolean, touched?: string[], inverse?: any[], history?: any, undoDepth?: number, element?: any }
   *   | { ok: false, error: { code: string, message: string, currentHash?: string, opId?: string, violations?: any[], status?: number, detail?: any }, touched?: string[] }
   * >}
   */
  async function apply(ops, meta = {}) {
    if (!loaded) {
      const opened = await load();
      if (opened.ok !== true) {
        return { ok: false, error: { code: opened.code, message: opened.message } };
      }
    }
    const state = ensure();
    const opId = meta.opId ?? `op-${state.sourceHash.slice(0, 8)}-${undoStack.length}-${Date.now()}`;

    /* R143：元素写守卫。**在** applyOps 之前判（applyOps 是纯函数，磁盘还没动），
       拒绝时整批不写 —— 这就是「拒绝 + 零写」。 */
    pendingGuard = null;
    const guarded = await guardTarget(state.value, ops, meta ?? {});
    if (guarded !== null) {
      guarded.error.opId = opId;
      return guarded;
    }

    /** @type {{ value: any, inverse: any[], touched: string[] }} */
    let applied;
    try {
      /* S87：元素级锁在**这里**拦，不用改 film-core（禁改）。
         判据是纯函数 `findLockedWrites`：沿批次逐条模拟，任何一条 Op 改到「当前已锁定元素」
         的覆盖负载就整批拒 —— 走到这里时磁盘一个字节还没动，所以天然是原子的。 */
      const guard = findLockedWrites(state.value, ops);
      if (!guard.ok) {
        return {
          ok: false,
          error: {
            code: guard.code ?? 'ELEMENT_LOCKED',
            message: guard.message ?? '元素已锁定',
            violations: guard.violations,
            opId,
          },
        };
      }
      applied = applyOpsDetailed(state.value, ops);
    } catch (error) {
      if (error instanceof EditError) {
        return { ok: false, error: { code: error.code, message: error.message, opId } };
      }
      throw error;
    }

    const written = writeValue(state.text, applied.value, state.sourceHash);
    if (written.ok !== true) {
      return {
        ok: false,
        error: {
          code: written.code === 'CONFLICT' ? 'CONFLICT' : 'INVALID',
          message: (written.diagnostics ?? []).map((/** @type {any} */ diag) => `${diag.code}: ${diag.message}`).join('; ') || '写回被拒绝',
          opId,
        },
        touched: applied.touched,
      };
    }

    if (written.changed === false) {
      // 值没变（例如 set 成同一个数）：不落盘、不记历史、不占撤销栈。
      current = { ...state, value: applied.value, sourceHash: String(written.sourceHash) };
      const element = settleGuard();
      return { ok: true, hash: current.sourceHash, changed: false, touched: applied.touched, inverse: applied.inverse, ...(element === null ? {} : { element }) };
    }

    const committed = await io.commit(path, String(written.text), state.sourceHash);
    if (committed.ok !== true) {
      // 注入 IO 错与 CAS 冲突都走这里：内存状态不动，磁盘没写过。
      return {
        ok: false,
        error: {
          code: committed.code === 'CONFLICT' ? 'CONFLICT' : 'IO',
          message: committed.code === 'CONFLICT' ? 'CAS 失败：磁盘内容已被改动，请重读后再编辑' : String(committed.message ?? '写入失败'),
          ...(committed.code === 'CONFLICT' ? { currentHash: committed.actualHash } : {}),
          opId,
        },
        touched: applied.touched,
      };
    }

    /** @type {{ ok: boolean, code?: string, message?: string, commit?: string }} */
    let history = { ok: true };
    if (withHistory) {
      const snapshot = await io.snapshot({
        projectDir,
        text: String(written.text),
        sourceHash: committed.sourceHash,
        prevSourceHash: state.sourceHash,
        opId,
        projectId: options.projectId,
      });
      history = snapshot.ok
        ? { ok: true, commit: snapshot.commit }
        : { ok: false, code: snapshot.code, message: snapshot.message };
    }

    undoStack.push({
      beforeText: state.text,
      beforeHash: state.sourceHash,
      afterHash: committed.sourceHash,
      ops: /** @type {any[]} */ (structuredClone(ops)),
      inverse: applied.inverse,
    });
    if (undoStack.length > maxUndo) undoStack.shift();
    redoStack.length = 0;

    current = { text: String(written.text), value: applied.value, sourceHash: committed.sourceHash };
    const element = settleGuard();
    return {
      ok: true,
      hash: committed.sourceHash,
      changed: true,
      touched: applied.touched,
      inverse: applied.inverse,
      history,
      undoDepth: undoStack.length,
      ...(element === null ? {} : { element }),
    };
  }

  /**
   * 撤销一批：把这一批之前的原文 CAS 写回。
   * @returns {Promise<{ ok: boolean, hash?: string, error?: any, restoredValue?: any }>}
   */
  async function undo() {
    const state = ensure();
    const entry = undoStack[undoStack.length - 1];
    if (entry === undefined) return { ok: false, error: { code: 'INVALID', message: '没有可撤销的编辑' } };
    const committed = await io.commit(path, entry.beforeText, state.sourceHash);
    if (committed.ok !== true) {
      return {
        ok: false,
        error: {
          code: committed.code === 'CONFLICT' ? 'CONFLICT' : 'IO',
          message: committed.code === 'CONFLICT' ? 'CAS 失败：磁盘内容已被改动，撤销未执行' : String(committed.message ?? '撤销写入失败'),
          ...(committed.code === 'CONFLICT' ? { currentHash: committed.actualHash } : {}),
        },
      };
    }
    const parsed = parse(entry.beforeText, { path });
    if (parsed.doc === null) return { ok: false, error: { code: 'INVALID', message: '历史原文无法解析' } };
    undoStack.pop();
    redoStack.push(entry);
    current = { text: entry.beforeText, value: parsed.doc, sourceHash: committed.sourceHash };
    if (withHistory) {
      await io.snapshot({
        projectDir,
        text: entry.beforeText,
        sourceHash: committed.sourceHash,
        prevSourceHash: state.sourceHash,
        opId: `undo:${entry.ops.map((/** @type {any} */ op) => op.op).join('+')}`,
        projectId: options.projectId,
      });
    }
    return { ok: true, hash: committed.sourceHash, restoredValue: parsed.doc };
  }

  /** 重做：把撤销掉的那一批 Op 重新应用到「撤销后」的值上。 */
  async function redo() {
    const state = ensure();
    const entry = redoStack[redoStack.length - 1];
    if (entry === undefined) return { ok: false, error: { code: 'INVALID', message: '没有可重做的编辑' } };

    /** @type {{ value: any }} */
    let replayed;
    try {
      replayed = applyOpsDetailed(state.value, entry.ops);
    } catch (error) {
      return { ok: false, error: { code: error instanceof EditError ? error.code : 'INVALID', message: String(/** @type {Error} */ (error).message) } };
    }
    const written = writeValue(state.text, replayed.value, state.sourceHash);
    if (written.ok !== true) {
      return { ok: false, error: { code: written.code ?? 'INVALID', message: '重做写回被拒绝' } };
    }
    const committed = await io.commit(path, String(written.text), state.sourceHash);
    if (committed.ok !== true) {
      return {
        ok: false,
        error: {
          code: committed.code === 'CONFLICT' ? 'CONFLICT' : 'IO',
          message: String(committed.message ?? '重做写入失败'),
          ...(committed.code === 'CONFLICT' ? { currentHash: committed.actualHash } : {}),
        },
      };
    }
    redoStack.pop();
    undoStack.push({ ...entry, beforeText: state.text, beforeHash: state.sourceHash, afterHash: committed.sourceHash });
    current = { text: String(written.text), value: replayed.value, sourceHash: committed.sourceHash };
    // 重做也是一次成功写入：同样落一条历史快照，历史里不会出现「空白一步」。
    if (withHistory) {
      await io.snapshot({
        projectDir,
        text: String(written.text),
        sourceHash: committed.sourceHash,
        prevSourceHash: state.sourceHash,
        opId: `redo:${entry.ops.map((/** @type {any} */ op) => op.op).join('+')}`,
        projectId: options.projectId,
      });
    }
    return { ok: true, hash: committed.sourceHash };
  }

  return {
    path,
    load,
    reload: load,
    apply,
    undo,
    redo,
    get value() {
      return current?.value ?? null;
    },
    get text() {
      return current?.text ?? null;
    },
    get sourceHash() {
      return current?.sourceHash ?? null;
    },
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    depths: () => ({ undo: undoStack.length, redo: redoStack.length }),
  };
}
