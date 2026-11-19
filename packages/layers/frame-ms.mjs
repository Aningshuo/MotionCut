/**
 * 取帧毫秒的**唯一口径**（R31 · E12-P2 / J6）
 *
 * ## 为什么要有这个文件
 *
 * 同一张缩略图有两个来源，它们各自算过一次 `ms`：
 *
 * | 谁 | 位置 | 算的是 |
 * |---|---|---|
 * | 素材抽屉（E12-P2） | `stage-dock.mjs: mediaMidMs()` | 源区间 `#t=in,out` 的**中点** |
 * | 时间线胶片条（E04） | `filmstrip.ts: filmstripCells()` | 片段内第 k 格的**屏幕位置**换算回源时刻 |
 *
 * 两处各写一遍 `Math.round(秒 × 1000)`，看着一样，实际**已经分叉**：
 * 时间线把末格夹到 `源出点 − 40ms`（`derived` 的末尾容差，见 `server/derived.mjs` 的
 * `END_TOLERANCE_MS`），抽屉**没有**这一道。于是同一个源、都被裁到贴近末尾时，
 * 时间线拿到一张图、抽屉拿到 `422`（ffmpeg 在末帧之后切不出东西）。
 *
 * 现在两边都只调 `frameMsAt()`：取整规则、下界、末尾容差各只有一处。
 *
 * ## 口径（三条，写死在这里）
 *
 * 1. **取整**：`Math.round(秒 × 1000)` —— 四舍五入到整毫秒。服务端的 `ms` 只收整数
 *    （`parseMs()` 对小数明确 400），所以取整必须在客户端做，且只能有一种做法。
 * 2. **下界**：`ms ≥ 0`。负的源时刻（`#t=-1,...` 这种脏数据）不上送。
 * 3. **末尾容差**：给得出源出点时，夹到 `round(源出点 × 1000) − 40ms`。
 *    40ms 不是新常数 —— 与 `server/derived.mjs` 的 `END_TOLERANCE_MS` 是同一档：
 *    3.000s 的片最后一帧在 2.9667s，`-ss 2.999` 之后一帧都不剩。
 *
 * 改这个文件等于改 E04 与 E12-P2 两条判据；`frame-ms.test.mjs` 钉着边界值。
 */

/**
 * 末尾容差（毫秒）。与 `packages/studio/server/derived.mjs` 的 `END_TOLERANCE_MS` 同值 ——
 * 那边是「请求合法但切不出帧」的吸收带，这边是「不要发出那一帧」的预防。
 */
export const END_TOLERANCE_MS = 40;

/**
 * 毫秒域的原语：取整 + 下界。已经是整数的值原样返回（幂等）。
 *
 * @param {unknown} ms
 * @returns {number} 非负整数毫秒
 */
export function normalizeFrameMs(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

/**
 * **秒 → 帧毫秒**。抽屉与时间线都调这一个函数。
 *
 * @param {unknown} seconds 源文件里的时刻（秒，可带小数）
 * @param {unknown} [sourceOut] 源出点（秒）。给得出就夹末尾容差；`null`/`undefined`/`<=0` 表示不知道
 * @returns {number} 非负整数毫秒
 */
export function frameMsAt(seconds, sourceOut) {
  const ms = normalizeFrameMs(Number(seconds) * 1000);
  const out = Number(sourceOut);
  if (!Number.isFinite(out) || out <= 0) return ms;
  /* 源出点自己也要取整：`8.5 × 1000` 在浮点里是 8500.000000000001 这类值，
     不先归一就会出现「夹出来的上限比末帧还晚 1ms」的偶发 422。 */
  const limit = Math.max(0, normalizeFrameMs(out * 1000) - END_TOLERANCE_MS);
  return Math.min(ms, limit);
}

/**
 * 素材卡的取帧时刻：源区间中点（`#t=in` 只有入点时就是入点）。
 *
 * @param {unknown} from 入点（秒）
 * @param {unknown} to 出点（秒，可空 = 到结尾）
 * @returns {number} 非负整数毫秒
 */
export function frameMsMidpoint(from, to) {
  const start = Number(from);
  const startSec = Number.isFinite(start) && start > 0 ? start : 0;
  const end = Number(to);
  const hasOut = Number.isFinite(end) && end > startSec;
  const endSec = hasOut ? end : startSec;
  /* 只有**真给了出点**才夹末尾容差：`#t=2` （到结尾）的夹法应该是「不知道出点」，
     拿 2s 当出点会把中点从 2000 挪到 1960 —— 那是凭空改帧，不是容差。 */
  return frameMsAt((startSec + endSec) / 2, hasOut ? endSec : null);
}
