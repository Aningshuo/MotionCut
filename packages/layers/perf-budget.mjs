/**
 * 计时用例的判据工具（S49 · B-SUB1-R25-025）
 *
 * ## 为什么要有它（R22-C5 → R28-C3）
 *
 * 两条计时用例连续三轮在**有负载**的机器上假红：
 *
 * - `snap-perf.test.mjs` 的 B5：`dragIntervalP95 22.4ms > 20ms`
 * - `stage.test.mjs` 的 S4-A10：`marquee.max 17.727ms > 16ms`
 *
 * 两次单独复跑都全绿。问题不在产品，在**判据的形状**：
 *
 * 1. 判据是**绝对值**：机器一忙，同样的代码就是会慢 —— 阈值不动，红灯必来。
 * 2. 判据吃**单次最坏值**（`max`）：一条 GC 或一次调度抖动就能把 50 个样本里的
 *    一个 17.7ms 顶成红色，而 p95 还在 1ms。
 *
 * 这类红灯训练所有人「忽略测试」，比没有测试更糟。
 *
 * ## 换成什么
 *
 * 1. **同页基线**：在同一页面、同一次会话里先跑一遍**同样的工作量**，但把被测的
 *    那段处理换成空实现。基线量到的就是「这台机器此刻的搬运成本」（事件派发、
 *    rAF 调度、循环本身）。判据变成相对量：
 *
 *        measured ≤ max(floor, baseline × factor + slack)
 *
 *    `floor` 是产品预算（例如一帧 16ms）——机器再快也不许超过它；
 *    `baseline × factor + slack` 是「机器此刻就是这个速度」的让步。
 * 2. **p95 而不是 max**：`max` 只记账。40 个样本里允许有 2 个掉队，
 *    但第 38 个必须还在预算内。
 *
 * 这个文件只做算术，不碰 DOM、不读盘 —— 两条用例与它们的证据都用同一套公式，
 * 免得「B5 的 p95 取整方式」和「S4-A10 的」又长成两个版本。
 *
 * @typedef {{n: number, p50: number, p95: number, max: number, min: number}} PerfStats
 */

/**
 * 分位数（nearest-rank）。
 *
 * `ceil(p × n) − 1` 是教科书定义：n=30 的 p95 取第 29 个（第二大的），
 * n=200 的 p95 取第 190 个。**不用插值**：插值会让「只有 1 个样本」的 p95
 * 变成那个样本本身，看起来更稳，其实是在替被测代码圆谎。
 *
 * @param {ArrayLike<number>} values
 * @param {number} p 0..1
 * @returns {number} 空数组返回 0
 */
export function percentile(values, p) {
  const n = values?.length ?? 0;
  if (n === 0) return 0;
  const sorted = Array.from(values, Number).sort((a, b) => a - b);
  const rank = Math.ceil(Math.min(Math.max(p, 0), 1) * n) - 1;
  return sorted[Math.min(n - 1, Math.max(0, rank))] ?? 0;
}

/**
 * 一组采样的四个数。`max` 进证据、**不进判据**（见文件头）。
 *
 * @param {ArrayLike<number>} values
 * @param {number} [digits]
 * @returns {PerfStats}
 */
export function summarize(values, digits = 3) {
  const n = values?.length ?? 0;
  if (n === 0) return { n: 0, p50: 0, p95: 0, max: 0, min: 0 };
  /** @param {number} x */
  const round = (x) => Math.round(Number(x) * 10 ** digits) / 10 ** digits;
  let max = -Infinity;
  let min = Infinity;
  for (let i = 0; i < n; i += 1) {
    const v = Number(values[i]);
    if (v > max) max = v;
    if (v < min) min = v;
  }
  return { n, p50: round(percentile(values, 0.5)), p95: round(percentile(values, 0.95)), max: round(max), min: round(min) };
}

/**
 * 相对判据：`measured ≤ max(floor, baseline × factor + slack)`。
 *
 * @param {{
 *   measuredP95: number, baselineP95: number, floor: number,
 *   factor?: number, slack?: number, digits?: number
 * }} input
 * @returns {{budget: number, pass: boolean, formula: string,
 *   measuredP95: number, baselineP95: number, floor: number, factor: number, slack: number}}
 */
export function judgeAgainstBaseline(input) {
  const digits = input?.digits ?? 3;
  /** @param {number} x */
  const round = (x) => Math.round(Number(x) * 10 ** digits) / 10 ** digits;
  const measuredP95 = Number(input?.measuredP95);
  const baselineP95 = Number(input?.baselineP95);
  const floor = Number(input?.floor);
  const factor = Number(input?.factor ?? 1.5);
  const slack = Number(input?.slack ?? 0);
  if (![measuredP95, baselineP95, floor, factor, slack].every(Number.isFinite)) {
    throw new TypeError('judgeAgainstBaseline: 五个数都必须是有限数');
  }
  const relative = baselineP95 * factor + slack;
  const budget = round(Math.max(floor, relative));
  return {
    budget,
    pass: measuredP95 <= budget,
    /** 证据里直接贴这一行，评审不用重算 */
    formula: `${measuredP95} ≤ max(${floor}, ${round(baselineP95)}×${factor}${slack === 0 ? '' : `+${slack}`}) = ${budget}`,
    measuredP95: round(measuredP95),
    baselineP95: round(baselineP95),
    floor: round(floor),
    factor,
    slack
  };
}

/**
 * `judgeAgainstBaseline` 的别名，参数名换成 `{measured, baseline}`（R31 / S52 起的统一入口）。
 *
 * 两条大场景用例（`large-scene-perf` / `large-scene-500`）的指标名是 `mountMs` / `selectMs` /
 * `dragP95Ms` / `treeRenderMs`，不是「p95」两个字；调用侧写 `{measured, baseline, floor, ...}`
 * 读起来就是判据本身。**实现只有一份**——这里不复制算术，避免两套 p95 取整方式。
 *
 * @param {{measured: number, baseline: number, floor: number, factor?: number, slack?: number, digits?: number}} input
 * @returns {ReturnType<typeof judgeAgainstBaseline>}
 */
export function judgeByBaseline(input) {
  return judgeAgainstBaseline({
    measuredP95: Number(input?.measured),
    baselineP95: Number(input?.baseline),
    floor: Number(input?.floor),
    factor: input?.factor,
    slack: input?.slack,
    digits: input?.digits
  });
}
