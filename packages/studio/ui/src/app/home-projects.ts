/**
 * 首页「最近工程 / 工程列表」的可见性规则（R107 · U08）。
 *
 * ## 为什么单独一个模块
 *
 * 病根是**测试残留把真实工程挤没了**：集成时把 projects 根指到
 * `.local-runs/integration/projects/`，`GET /api/projects` 的 `projects` 与 `recent`
 * 里就会混进上百条 `r4-sample-*` / `s11-a1-*`。过滤规则只写一处，
 * 列表、搜索、空态、计数都读它 —— 以后加「显示测试工程」开关时，
 * 只把 `includeTestResidue` 翻成 `true`，不必再改三个地方。
 *
 * ## 判定口径
 *
 * 按**路径段**匹配，不按子串：`/Users/m/Films/my.tmp.mov` 不该被藏，
 * 而 `/x/.tmp/y`、`/x/.local-runs/integration/projects/y`、
 * `/Users/x/.local-runs/...` 都该藏。三个段名来自派单：
 * `.local-runs` / `.tmp` / `integration`。
 *
 * 这里只做**展示层**过滤：不动服务端索引、不删磁盘、不改 `props.projects` 的语义
 * （App 仍按原始列表算 tab 与 activeId，隐藏只发生在渲染这一层）。
 */

/** 命中任一路径段即视为测试残留。**改规则只改这里。** */
export const RESIDUE_PATH_SEGMENTS: ReadonlyArray<string> = Object.freeze(['.local-runs', '.tmp', 'integration']);

/** 最近工程最多显示多少条（派单 §1.2）。 */
export const RECENT_LIMIT = 20;

/** 给后续「显示测试工程」开关留的位：默认 false = 藏。 */
export interface HomeFilterOptions {
  includeTestResidue?: boolean;
}

/**
 * 路径是否属于测试残留。
 * 大小写不敏感、反斜杠按 `/` 处理（Windows 路径也能判）。
 * @param {string} filePath
 */
export function isTestResiduePath(filePath: string): boolean {
  const raw = String(filePath ?? '').trim();
  if (raw === '') return false;
  const segments = raw.replace(/\\/g, '/').toLowerCase().split('/');
  return segments.some((segment) => RESIDUE_PATH_SEGMENTS.includes(segment));
}

/** 只有 `path` 字段的条目（project / recent 两用）。 */
interface PathItem {
  path: string;
}

/**
 * 过滤 + 分页，返回「该显示什么」与「藏了多少」。
 *
 * `hidden` 是给空态/角标用的：**藏了东西**和**本来就没有**是两种不同的空。
 * @template {PathItem} T
 * @param {readonly T[]} items
 * @param {number} limit 0 或负数 = 不分页（工程列表用）
 * @param {HomeFilterOptions} [options]
 */
export function visibleHomeItems<T extends PathItem>(
  items: readonly T[],
  limit: number,
  options: HomeFilterOptions = {},
): { shown: T[]; hidden: number; overflow: number } {
  const all = Array.isArray(items) ? items : [];
  const kept = options.includeTestResidue === true ? all.slice() : all.filter((item) => !isTestResiduePath(item.path));
  const shown = limit > 0 ? kept.slice(0, limit) : kept;
  return { shown, hidden: all.length - kept.length, overflow: Math.max(0, kept.length - shown.length) };
}

/**
 * 搜索：工程名或路径包含查询串（大小写不敏感）。空白查询 = 全通过。
 * @template {PathItem & { name?: string }} T
 * @param {readonly T[]} items
 * @param {string} query
 */
export function matchHomeQuery<T extends PathItem & { name?: string }>(items: readonly T[], query: string): T[] {
  const q = String(query ?? '').trim().toLowerCase();
  if (q === '') return items.slice();
  return items.filter((item) => `${item.name ?? ''} ${item.path}`.toLowerCase().includes(q));
}
