/**
 * 编辑器的乐观状态：先按 Op 批在内存里画出结果，落盘成功才认账。
 *
 * 为什么需要它：一次写要经过 CAS，可能被拒（旧哈希）或写不动（IO）。UI 不能先把画面改了
 * 再发现磁盘没写成——`preview()` 把改动压在一个快照里，`commit()` 才合并，
 * `rollback()` 原样退回（选中、播放头都不受影响，因为那些不在值里）。
 */

import { EditError, applyOpsDetailed } from '../../../../film-core/ops.mjs';

/**
 * @param {{ value: any, sourceHash?: string }} input
 */
export function createEditorState(input) {
  let committedValue = input.value;
  let committedHash = input.sourceHash ?? '';
  /** @type {{ before: any, value: any, ops: any[], inverse: any[] } | null} */
  let pending = null;

  return {
    value: () => (pending === null ? committedValue : pending.value),
    sourceHash: () => committedHash,
    pending: () => pending !== null,

    /**
     * 乐观应用一批 Op。失败时状态不动，返回合同错误码。
     * @param {readonly any[]} ops
     */
    preview(ops) {
      const base = pending === null ? committedValue : pending.value;
      try {
        const applied = applyOpsDetailed(base, ops);
        pending = {
          before: base,
          value: applied.value,
          ops: /** @type {any[]} */ (structuredClone(ops)),
          inverse: applied.inverse,
        };
        return { ok: true, value: applied.value, inverse: applied.inverse, touched: applied.touched };
      } catch (error) {
        if (error instanceof EditError) return { ok: false, error: { code: error.code, message: error.message } };
        throw error;
      }
    },

    /** 落盘成功：承认这一版。 @param {string} [hash] */
    commit(hash) {
      if (pending !== null) {
        committedValue = pending.value;
        pending = null;
      }
      if (typeof hash === 'string' && hash !== '') committedHash = hash;
      return { ok: true, sourceHash: committedHash };
    },

    /** 落盘失败：退回上一次已承认的版本（= 磁盘上的那一版）。 */
    rollback() {
      const restored = committedValue;
      pending = null;
      return { ok: true, value: restored, sourceHash: committedHash };
    },

    /** 外部改了文件（film.changed）：只有在没有待落盘改动时才跟进。 @param {any} value @param {string} [hash] */
    adopt(value, hash) {
      if (pending !== null) return false;
      committedValue = value;
      committedHash = hash ?? committedHash;
      return true;
    },
  };
}
