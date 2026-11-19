/**
 * 值 → film.html 的写回出口（layout patch）。
 *
 * 实现与 `analyze()` 的元素区间放在同一个模块（`film-doc.mjs`）：写回需要「哪一段字节是哪个属性」
 * 的精确区间，拆成两个模块会来回引用。这里只保留既有导入路径与一组稳定的再导出，
 * 调用方（`edit-session.mjs`、测试、脚本）不用改写。
 *
 * v1.2.0 方言要点（都在 `film-doc.mjs` 里实现）：
 * - 片段属性不带 `data-` 前缀；`time` 写进 `src` 的 `#t=in,out`；
 * - `fade` 写进 `overrides` 里没有 `at` 的那一条（去重成一条，0,0 时删掉）；
 * - 轨道是普通 `<section>`，只写 `hidden/muted/locked` 三个标志；
 * - 舞台是 `<meta name="viewport">`，**不写帧率**。
 */

export { writeValue, write, canonicalDoc, sameCanonical, derivedOverrides, clipAttributes } from './film-doc.mjs';

/**
 * 元素写入守卫（R143）：写入口的**四维合同**（project / instance / element / epoch）。
 * 从这里再导出，调用方不必知道它实现在 `element-guard.mjs` —— 写回出口只有一个。
 */
export {
  GUARD_CODES,
  GUARD_HTTP,
  GUARD_RETRY_MAX,
  checkElementIntent,
  checkElementWrites,
  createGuardState,
  elementKeyOf,
  elementWritesOf,
  parseElementKey,
  recordElementIntent,
  signatureOf,
} from './element-guard.mjs';
