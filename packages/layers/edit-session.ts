/**
 * 连续编辑合成（副线1 · WP14 / NEW-02）
 *
 * 同一个层连续改字号 → 颜色 → 描边：
 * - 每次编辑都基于**最新**覆盖，而不是打开检查器时的快照；
 * - 旧快照提交：字段不重叠 → 自动 rebase（保留别人/之前的改动），字段重叠且值不同 → 报 CONFLICT；
 * - 先 paint（画面立刻变）再 commit（落盘）；commit 失败 → paint 回旧值，哈希不变。
 *
 * 纯逻辑 + 注入的 paint/commit：测试可以精确证明调用顺序与回滚。
 */
import type { LayerError, OverridePatch } from '../../contracts/layers';
import { mergeOverride, overrideKeys, patchKeys, sameKeyValue } from './override-merge.mjs';
import type { InspectorField } from './inspector';

export interface SessionSnapshot {
  readonly override: OverridePatch;
  readonly hash: string;
}

export type CommitOutcome =
  | { readonly ok: true; readonly hash: string }
  | { readonly ok: false; readonly code: 'CONFLICT' | 'IO' | 'LOCKED' | 'INVALID'; readonly actualHash?: string };

export type CommitFn = (next: OverridePatch, expectedHash: string) => Promise<CommitOutcome>;
export type PaintFn = (override: OverridePatch) => void | Promise<void>;

export type EditStatus = 'applied' | 'rebased' | 'conflict' | 'rolledback' | 'rejected';

export interface EditResult {
  readonly status: EditStatus;
  readonly override: OverridePatch;
  readonly hash: string;
  /** 旧快照里被别人改过、且本次没有覆盖的键（rebase 时保留）。 */
  readonly keptKeys?: readonly string[];
  /** 冲突键：本次拒绝写入。 */
  readonly conflicts?: readonly string[];
  readonly error?: LayerError;
  /** 调用轨迹，证明 paint → commit →（失败）paint 回滚的顺序。 */
  readonly trace: readonly string[];
}

export interface EditSessionOptions {
  readonly initialOverride?: OverridePatch;
  readonly initialHash: string;
  readonly commit: CommitFn;
  readonly paint?: PaintFn;
  readonly locked?: boolean;
}

/**
 * 一次编辑会话 = 一个层的最新覆盖 + 磁盘哈希。
 * `edit(patch, snapshot)` 里的 `snapshot` 是**发起这次编辑时所看到的**状态；
 * 它可能已经过期。过期时不静默覆盖，而是按上面规则 rebase / 报冲突。
 */
export class EditSession {
  #override: OverridePatch;
  #hash: string;
  #commit: CommitFn;
  #paint: PaintFn;
  #locked: boolean;
  readonly #trace: string[] = [];

  constructor(opts: EditSessionOptions) {
    this.#override = opts.initialOverride ?? {};
    this.#hash = opts.initialHash;
    this.#commit = opts.commit;
    this.#paint = opts.paint ?? (() => {});
    this.#locked = Boolean(opts.locked);
  }

  get override(): OverridePatch {
    return this.#override;
  }

  get hash(): string {
    return this.#hash;
  }

  get locked(): boolean {
    return this.#locked;
  }

  get trace(): readonly string[] {
    return [...this.#trace];
  }

  snapshot(): SessionSnapshot {
    return { override: this.#override, hash: this.#hash };
  }

  /** 锁定的层：在 paint 之前就拒绝，画面不应出现一个磁盘上不会有的样子。 */
  rejectLocked(): EditResult {
    this.#trace.push('reject:LOCKED');
    return {
      status: 'rejected',
      override: this.#override,
      hash: this.#hash,
      error: { code: 'LOCKED', message: '该层已锁定，禁止写入' },
      trace: this.trace
    };
  }

  /**
   * 用快照提交一次编辑。
   *
   * @param patch 最小覆盖（只含用户改的键）
   * @param snapshot 发起编辑时看到的状态；省略等价于“最新”
   */
  async edit(patch: OverridePatch, snapshot?: SessionSnapshot): Promise<EditResult> {
    if (this.#locked) return this.rejectLocked();

    const from = snapshot ?? this.snapshot();
    const stale = from.hash !== this.#hash;

    /* 旧快照：冲突键 = 双方都改过且值不同；保留键 = 当前已有、但快照里没有/不同的改动 */
    let conflicts: string[] = [];
    let keptKeys: string[] = [];
    if (stale) {
      const currentKeys = overrideKeys(this.#override);
      const mine = new Set(patchKeys(patch));
      /* 本次要改的键，如果在当前值已存在且与快照不同 → 同一字段被别人改过，报冲突 */
      conflicts = [...mine].filter(
        (k) => currentKeys.includes(k) && !sameKeyValue(from.override, this.#override, k)
      );
      keptKeys = currentKeys.filter((k) => !sameKeyValue(from.override, this.#override, k) && !mine.has(k));
    }

    if (conflicts.length) {
      this.#trace.push(`conflict:${conflicts.join(',')}`);
      return {
        status: 'conflict',
        override: this.#override,
        hash: this.#hash,
        conflicts,
        error: {
          code: 'AMBIGUOUS',
          message: `编辑基于旧快照，以下字段已被改动：${conflicts.join(', ')}；请刷新后重试`
        },
        trace: this.trace
      };
    }

    const before = this.#override;
    const next = mergeOverride(before, patch);

    /* 1) 先画：画面立刻变成新值 */
    await this.#paint(next);
    this.#trace.push('paint:next');

    /* 2) 再落盘：CAS 用**当前**哈希，不是旧快照的哈希 */
    this.#trace.push(`commit:${this.#hash}`);
    let outcome: CommitOutcome;
    try {
      outcome = await this.#commit(next, this.#hash);
    } catch (err) {
      outcome = { ok: false, code: 'IO' };
      this.#trace.push(`commit:throw:${err instanceof Error ? err.message : String(err)}`);
    }

    if (outcome.ok) {
      this.#override = next;
      this.#hash = outcome.hash;
      this.#trace.push('commit:ok');
      return {
        status: stale && keptKeys.length ? 'rebased' : 'applied',
        override: next,
        hash: this.#hash,
        ...(keptKeys.length ? { keptKeys } : {}),
        trace: this.trace
      };
    }

    /* 3) 失败：画面回滚，哈希不动 */
    await this.#paint(before);
    this.#trace.push('paint:rollback');
    return {
      status: 'rolledback',
      override: before,
      hash: this.#hash,
      error: {
        code: outcome.code === 'LOCKED' ? 'LOCKED' : 'NOT_EDITABLE',
        message:
          outcome.code === 'CONFLICT'
            ? `写入冲突：磁盘已被改动（expectedHash=${this.#hash}${outcome.actualHash ? `, actual=${outcome.actualHash}` : ''}）`
            : `写入失败：${outcome.code}`
      },
      trace: this.trace
    };
  }
}

/** 从检查器字段直接构造最小 patch（跳过不可编辑字段）。 */
export function patchFromField(
  field: InspectorField,
  value: string | number
): OverridePatch | null {
  if (!field.editable) return null;
  if (field.overrideKey === 't') return { t: String(value) };
  if (field.overrideKey === 'r') {
    const n = typeof value === 'number' ? value : parseFloat(String(value));
    return Number.isFinite(n) ? { r: n } : null;
  }
  if (field.overrideKey.startsWith('style:')) {
    return { style: { [field.overrideKey.slice(6)]: String(value) } };
  }
  return null;
}
