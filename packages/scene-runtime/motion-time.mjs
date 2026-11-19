/**
 * 取帧期的动效时间注入（副线1 · S33-MOTION-CAPTURE）
 *
 * ## 为什么要有它
 *
 * S31 把三条模板改成了「暂停 + 负延迟」：画面只由 `--motion-t` 决定。但**取帧**这条路上没人写这个
 * 变量——预览能按 t 定格，导出却让模板停在自己的默认相位。同一工程两次导出就会不一样，而且和预览
 * 也对不上。这里补的就是这一笔：取帧前把「本帧的 t」交给页面里每个动效实例。
 *
 * ## 时间怎么算
 *
 * `local = max(0, (t - at)) * 1000`，**毫秒**（与 `instance.mjs` 的 `tMs` 同口径）。
 *
 * - `t` 是影片时间（秒），`at` 是该片段在时间线上的起点（秒），来自 **clip 元素上的 `at` 属性**——
 *   就是 `contracts/film-doc.ts` 里 `Clip.at` 读的那个属性，不另造字段。
 * - 跨 iframe 时把整条 frame 链上的 `at` 累加：外层 clip 的 `at` + 内层 clip 的 `at`。
 * - `t < at` 给 0。CSS 那边入场类模板是 `fill: both`，0 就是「还没开始」的起始帧，与「片段尚未
 *   出现在时间线上」一致；不额外做负值或隐藏（可见性归舞台）。
 * - `t` 超过模板周期**照常给**，取模交给 CSS 的 `animation-delay`。宿主里不做取模，否则周期一变
 *   就要改宿主。
 *
 * ## 写到谁身上
 *
 * 每个同源文档里：
 * - 有 `[data-instance]`（动效实例根，`instantiate()` 产出的挂载点）→ 写在每个实例根上；
 * - 一个实例根都没有（例如 clip 的 `src` 直接指向模板文件）→ 写在 `documentElement` 上，
 *   自定义属性会继承给整篇文档。这一档与 motion-wire 的「没有 data-instance 就退到 body」同源。
 *
 * 跨源 iframe 进不去（`contentDocument === null`），计入 `crossOrigin` 而不是假装写过。
 *
 * ## 与 stage runtime 的关系（重要）
 *
 * 本模块服务 `SceneHost` 的取帧（`SceneHandle.frame` / `captureOnce`）。**生产导出**走的是
 * `render/stage-capture.mjs` → `studio/server/content-origin.mjs` 里那段生成出来的 `STAGE_RUNTIME`
 * 字符串，它在另一个包里。两边的时间口径必须一致：`--motion-t = (t - clip.at) * 1000`。
 * `writeMotionTime()` 是自包含函数（不引用任何模块级变量），可以原样搬进那段字符串。
 */
import { MOTION_TIME_VAR } from '../motion/instance.mjs';

/** 时间变量名（与 S31 冻结的模板约定一致，从 instance.mjs 再导出，避免两处各写一份）。 */
export { MOTION_TIME_VAR };

/** clip 在时间线上的起点属性（`Clip.at` 读的就是它）。 */
export const MOTION_CLIP_ATTR = 'at';

/** 动效实例根的选择器（`instantiate()` 的 `attrs` 里那个属性）。 */
export const MOTION_INSTANCE_ATTR = 'data-instance';

/** 注入后写在实例根上的自省属性（与 `applyInstanceTime` 一致，便于宿主导出后核对）。 */
export const MOTION_TIME_ATTR = 'data-motion-t';

/**
 * 片段本地时间（毫秒）。
 * @param {number} t 影片时间（秒）
 * @param {number} at 片段起点（秒）
 * @returns {number}
 */
export function localMsOf(t, at) {
  const start = Number.isFinite(at) ? at : 0;
  const now = Number.isFinite(t) ? t : 0;
  const local = (now - start) * 1000;
  return local > 0 ? local : 0;
}

/**
 * @typedef {object} MotionWriteEntry
 * @property {string} id     实例 id（文档兜底时为空串）
 * @property {number} at     片段起点（秒）
 * @property {number} ms     写进去的毫秒数
 * @property {'instance'|'document'} scope
 */

/**
 * @typedef {object} MotionWriteStats
 * @property {number} t
 * @property {number} documents        走过的同源文档数
 * @property {number} roots            `[data-instance]` 个数
 * @property {number} written          实际写入次数（实例根 + 文档兜底）
 * @property {number} crossOrigin      进不去的跨源 iframe 数
 * @property {MotionWriteEntry[]} entries
 */

/**
 * 页内执行：给页面内所有动效实例写下本帧相位。
 *
 * **必须自包含**：它会被 Playwright 序列化进页面，也会被原样搬进 stage runtime 的字符串，
 * 所以不能引用模块常量、不能读时钟、不能依赖上一帧的状态。
 *
 * @param {number} t 影片时间（秒）
 * @returns {MotionWriteStats}
 */
export function writeMotionTime(t) {
  const VAR = '--motion-t';
  const INSTANCE = 'data-instance';
  const TIME_ATTR = 'data-motion-t';
  const now = Number.isFinite(Number(t)) ? Number(t) : 0;

  /** @type {MotionWriteStats} */
  const stats = { t: now, documents: 0, roots: 0, written: 0, crossOrigin: 0, entries: [] };
  /** @type {Set<Document>} */
  const seen = new Set();

  /** @param {string|null} raw */
  const num = (raw) => {
    const value = Number(raw);
    return Number.isFinite(value) ? value : 0;
  };

  /**
   * @param {Document} doc
   * @param {number} frameOffset 整条 frame 链上的 at 之和
   */
  function visit(doc, frameOffset) {
    if (!doc || seen.has(doc)) return;
    seen.add(doc);
    stats.documents += 1;

    const roots = doc.querySelectorAll('[' + INSTANCE + ']');
    if (roots.length > 0) {
      stats.roots += roots.length;
      for (const node of roots) {
        const el = /** @type {HTMLElement} */ (node);
        /* 文档内如果还有一层带 at 的 clip 容器，叠加它；跨文档的 at 已由 frameOffset 带上 */
        let at = frameOffset;
        if (typeof el.closest === 'function') {
          const owner = el.closest('[at]');
          if (owner) at += num(owner.getAttribute('at'));
        }
        const ms = now > at ? (now - at) * 1000 : 0;
        el.style.setProperty(VAR, String(ms));
        el.setAttribute(TIME_ATTR, String(ms));
        stats.written += 1;
        stats.entries.push({ id: el.getAttribute(INSTANCE) || '', at, ms, scope: 'instance' });
      }
    } else if (doc.documentElement) {
      const ms = now > frameOffset ? (now - frameOffset) * 1000 : 0;
      doc.documentElement.style.setProperty(VAR, String(ms));
      doc.documentElement.setAttribute(TIME_ATTR, String(ms));
      stats.written += 1;
      stats.entries.push({ id: '', at: frameOffset, ms, scope: 'document' });
    }

    for (const node of doc.querySelectorAll('iframe,frame')) {
      const frame = /** @type {HTMLIFrameElement} */ (node);
      /** @type {Document|null} */
      let child = null;
      try {
        child = frame.contentDocument;
      } catch {
        child = null;
      }
      if (!child) {
        stats.crossOrigin += 1;
        continue;
      }
      visit(child, frameOffset + num(frame.getAttribute('at')));
    }
  }

  visit(document, 0);
  return stats;
}

/**
 * 宿主侧：把本帧的 t 写到页面上。
 * @param {import('playwright').Page} page
 * @param {number} t 影片时间（秒）
 * @returns {Promise<MotionWriteStats>}
 */
export async function injectMotionTime(page, t) {
  const fn = /** @type {(tt: number) => MotionWriteStats} */ (writeMotionTime);
  return page.evaluate(fn, Number(t));
}
