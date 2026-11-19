/**
 * 历史合同 v1.0.0
 *
 * 按参考结构：每工程 `.film/history` 是一个**私有 Git 仓库**，大媒体以内容哈希存为对象/指针。
 * 用户工程根自己的 `.git` 绝不触碰；`.film/history` 独立 init，独立 config。
 *
 * 与 R1 的差别：R1 曾把「Git 历史」判为 REPLACE（用内容哈希 + 快照替代），这是错的。
 * 本轮恢复为同类私有 Git；快照只作为迁移输入与冲突留档，不是第二权威。
 */

export interface HistoryRepo {
  /** 固定为 <project>/.film/history，独立 git dir + work tree。 */
  readonly dir: string;
  /** 绝不等于工程根，也绝不读取工程根的 .git。 */
  readonly projectRoot: string;
  readonly gitVersion: string;
}

export type HistoryErrorCode =
  | 'GIT_MISSING'
  | 'REPO_CORRUPT'
  | 'NOT_A_VERSION'
  | 'MEDIA_OBJECT_MISSING'
  | 'WRITE_BUSY'
  | 'PERMISSION';

export interface VersionEntry {
  readonly id: string;          // commit sha
  readonly at: number;
  readonly label?: string;      // 命名版本
  readonly auto: boolean;
  readonly files: readonly string[];
  readonly mediaRefs: readonly MediaRef[];
}

/** 大媒体不进 Git 对象库本体：按内容哈希外置，历史里只存指针。 */
export interface MediaRef {
  readonly path: string;        // 相对工程根
  readonly sha256: string;
  readonly bytes: number;
  readonly objectPath: string;  // .film/objects/<sha[0:2]>/<sha>
}

export interface HistoryApi {
  init(projectRoot: string): Promise<HistoryRepo | { error: HistoryErrorCode }>;
  commit(projectRoot: string, message: string, opts?: { readonly label?: string }): Promise<{ id: string } | { error: HistoryErrorCode }>;
  list(projectRoot: string): Promise<readonly VersionEntry[]>;
  /** 只读预览某个版本：检出到临时 worktree，不改变当前工程。 */
  preview(projectRoot: string, id: string): Promise<{ dir: string } | { error: HistoryErrorCode }>;
  /** 恢复单个文件（如误删的 film.html），不覆盖其他文件。 */
  restoreFile(projectRoot: string, id: string, path: string): Promise<{ ok: boolean; error?: HistoryErrorCode }>;
  /** 冲突副本：Agent 原写与合并结果双双留档，永不静默丢。 */
  keepAside(projectRoot: string, reason: string, files: readonly string[]): Promise<{ id: string } | { error: HistoryErrorCode }>;
}

/**
 * 生命周期与删除边界：
 * - `history/`、`recovery/`、`conflicts/` 是**持久资料**：清缓存不得删除，迁移必须带走；
 * - `cache/`、`index/` 才是可重建的。
 */
export const KEEP_ON_CACHE_CLEAR = ['.film/history', '.film/recovery', '.film/conflicts'] as const;
export const REBUILDABLE = ['.film/cache', '.film/index', '.film/thumbs', '.film/waveforms'] as const;
