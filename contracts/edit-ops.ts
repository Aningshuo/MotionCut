/**
 * 统一编辑操作合同 v1.0.0
 *
 * 所有改动（时间线、图层覆盖、字幕、轨道）都是 Op；只有主线拥有写队列与 CAS。
 * 两条副线提交 Op，不直接改用户作品文件。
 */

import type { Clip, OverrideEntry } from './film-doc.ts';

/** 每工程一条串行写队列；跨工程并行，不共享锁。 */
export interface Envelope {
  readonly projectId: string;
  readonly batchId: string;
  /** 发起方：brain 只用于集成，执行线必须写自己的席位。 */
  readonly owner: 'MAIN' | 'SUB1' | 'SUB2' | 'BRAIN';
  /** 读到的那份 film.html 的内容哈希。 */
  readonly expectedHash: string;
  /** 幂等键；同一 key 重放返回首次结果，不重复写入。 */
  readonly opId: string;
}

export type PropValue = number | string | boolean | readonly number[] | Readonly<Record<string, unknown>> | null;

export interface PropEdit {
  readonly clip: string;
  /** `at`/`start`/`end`/`volume`/`speed`/`box`/`overrides`/`link`/`fade`/`track`/`trackOrder` … */
  readonly prop: string;
  readonly value: PropValue;
}

export type Op =
  | { readonly op: 'set'; readonly clip: string; readonly field: string; readonly value?: unknown }
  | { readonly op: 'move'; readonly clip: string; readonly at: number; readonly track?: number | { readonly insert: number } }
  | { readonly op: 'insert'; readonly clip: Partial<Clip> & { readonly src: string }; readonly track?: number | { readonly insert: number } }
  | { readonly op: 'remove'; readonly clip: string }
  | { readonly op: 'split'; readonly clip: string; readonly at: number; readonly left: Record<string, PropValue>; readonly right: Record<string, PropValue>; readonly rightId?: string }
  | { readonly op: 'props'; readonly edits: readonly PropEdit[] }
  | { readonly op: 'stage'; readonly w: number; readonly h: number }
  | { readonly op: 'fields'; readonly clip: string; readonly fields: Readonly<Record<string, unknown>> }
  | { readonly op: 'track'; readonly track: number; readonly field: 'locked' | 'hidden' | 'muted'; readonly value: boolean }
  | { readonly op: 'reorder'; readonly from: number; readonly to: number }
  | { readonly op: 'overrides'; readonly clip: string; readonly entries: readonly OverrideEntry[] };

export type EditErrorCode =
  | 'CONFLICT'          // expectedHash 与当前不符：拒绝，返回当前 hash
  | 'INVALID'           // 参数非法（时间倒置、未知 prop、超源长）
  | 'NOT_FOUND'         // 片段/轨道不存在
  | 'LOCKED'            // 锁轨/锁层
  | 'IO'                // 磁盘写失败
  | 'QUEUE_TIMEOUT';    // 队列超时（不静默丢）

export interface EditError {
  readonly code: EditErrorCode;
  readonly message: string;
  /** CONFLICT 时给当前 hash，调用方可重读后重试。 */
  readonly currentHash?: string;
  readonly opId?: string;
}

export interface EditResult {
  readonly ok: boolean;
  readonly hash?: string;
  readonly error?: EditError;
  /** 一次 Op 内被改到的片段，供 UI 局部重绘。 */
  readonly touched?: readonly string[];
}

/** 合同不变量：同一 Op 在同一 baseHash 上应用两次，结果一致（除 insert 的 id 生成）。 */
export interface EditApi {
  apply(projectId: string, env: Envelope, ops: readonly Op[]): Promise<EditResult>;
}

/**
 * 三方合并保护（人工优先）
 * base   = Agent 读到的那一版（推断得出，见 person-merge）
 * ours   = 当前人工/Studio 的版本
 * theirs = Agent 新写入
 * 只有 theirs 改的取 theirs；只有 ours 改的留 ours；两边都改且不同，留 ours 并把冲突条目告诉 Agent。
 */
export interface MergeReport {
  readonly keptPerson: readonly string[];
  readonly tookWriter: readonly string[];
  readonly conflicts: readonly { readonly unit: string; readonly person: string; readonly writer: string }[];
  /** 合并失败时，writer 的原写留在历史里（不丢），Agent 得到说明。 */
  readonly writerKeptAt?: string;
}
