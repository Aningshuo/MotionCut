/**
 * 关键帧 → 可 seek 的 CSS 动画（E05-P1）
 *
 * ## 这份模块只做三件事
 *
 * 1. **校验**（`validateKeyframeList`）：五条拒绝，各一个稳定错误码；
 * 2. **编译**（`compileKeyframes`）：一条 `kf` → 一段 `@keyframes` + 一条
 *    `[data-kf="<hash>"]` 规则；纯函数，同样输入必得同样字节；
 * 3. **给运行时一份计划**（返回值的 `plans`）：哪个选择器该拿哪个 hash。
 *
 * 它**不**碰 DOM、不读时钟、不写盘。元素上打 `data-kf` 与把 CSS 塞进 `<head>`
 * 由 `packages/layers/apply-keyframes.mjs` 做（那里能被 Playwright 序列化进页面）。
 *
 * ## 时钟：复用 `--motion-t`，不另造
 *
 * `packages/motion/instance.mjs` 已经立了唯一时间入口 `MOTION_TIME_VAR`（毫秒）：
 * 模板的写法是「`animation-play-state: paused` + `animation-delay: -t`」，于是画面
 * 只由这个变量决定，`renderInstanceAt(page, {tMs})` 每帧写一次就走带。
 *
 * 关键帧沿用**同一条时钟**，所以 `animation-delay` 里必须是 `var(--motion-t)`。
 *
 * ## 口径是「片段内局部毫秒」，不是全局时间（P2 改口径）
 *
 * 舞台侧唯一写时钟的入口是 `scene-runtime/motion-time.mjs` 的 `writeMotionTime(t)`，
 * 它写的是 `local = max(0, t − clip.at) * 1000`（见该模块 `localMsOf`），落在
 * `[data-instance]` 实例根或 `documentElement` 上，跨 iframe 时把整条 frame 链的
 * `at` 累加。生产导出走的是 `content-origin.mjs` 的 `STAGE_RUNTIME`（同一份源码原文）。
 *
 * 所以关键帧这边写成：
 *
 *     animation-delay: calc(-1 * var(--motion-t, 0) * 1ms)
 *
 * 也就是「已播放量 = 局部毫秒」，与模板的 `-t` 完全同义 —— **同一个变量、同一个口径**。
 * 不要再把片段起点折进 delay：
 *
 * - P1 曾写 `calc(<at>s - 1 * var(--motion-t) * 1ms)`（按设计书 §3 的「- <clipStart>」意图
 *   改成 at − t），它要求 `--motion-t` 是**全局**影片毫秒。但舞台给的是**局部**毫秒，
 *   两者相差一个 `at`：片段起点 1.5s、t=2.5s 时，舞台写 1000ms，而那个公式会算出
 *   `delay = 1.5 − 1 = 0.5s`（画面还停在首帧前面），正确值应是 40%。
 * - 证据：P1 的浏览器测试直接写 `--motion-t` 所以看不出差异；一旦接上舞台的写时钟就露馅。
 *
 * 改成本地口径后，`at` 已经从注入侧扣掉了，hash 也就不必再含 `clipStart`
 * （见 `keyframeHash` 的说明）。
 *
 * ## 确定性（本批唯一硬判据）
 *
 * 同一个 doc 编译两次，CSS **字节相同**。为此：
 * - 遍历顺序 = doc 的 track/clip/override 顺序（数组顺序，不用 Map 迭代序）；
 * - 每帧 `style` 的声明按**属性名字典序**输出；
 * - 百分比固定 4 位小数再截尾零；
 * - 同 hash 的规则只写一次（先出现者赢，后来者复用）。
 *
 * ## 与静态覆盖的边界
 *
 * `override.style` 是静态的，本模块**完全不读**它做编译；两者的互斥由
 * `film-doc.mjs` 的 parse 路径判 `KF_STATIC_CONFLICT`（写盘前拒）。
 * 本模块只负责「已经合法的 kf」→ CSS。
 *
 * ## 本批明确不做
 *
 * - 不做关键帧 UI（P3，副线1）；
 * - 不做导出逐帧（P2）；
 * - 不合并 `box` 与 `transform`（设计书 §6 风险 1 的 `KF_TRANSFORM_MERGE` 留 P4）：
 *   `transform` 与 `box` 派生的 `left/top/width/height/rotate` 是**不同属性名**，
 *   同时存在时按 CSS 规定叠加，不会静默覆盖；
 * - 字幕/音频关键帧不在 P1–P4 范围（设计书 §6 风险 4）。
 */

import { createHash } from 'node:crypto';

import { MOTION_TIME_VAR } from '../motion/instance.mjs';
import { clipDuration } from './time.mjs';

/**
 * 六条拒绝码（`KF_STATIC_CONFLICT` 不在 `kf` 自身结构里，由 parse 判，但码表放一起）。
 * 稳定、可判定、可写进验收；宿主/CI 按码判断，不解析人话。
 */
export const KEYFRAME_ERROR_CODES = Object.freeze([
  'KF_TOO_SHORT',
  'KF_ORDER',
  'KF_PROPS_MISMATCH',
  'KF_NOT_INTERPOLABLE',
  'KF_OUT_OF_RANGE',
  'KF_STATIC_CONFLICT',
]);

/** `Keyframe.ease` 的全部合法值。 */
export const KEYFRAME_EASES = Object.freeze(['linear', 'ease-in', 'ease-out', 'ease-in-out', 'steps-2']);

/** 缓动名 → CSS `animation-timing-function` 值（`steps-2` 明确写成 `steps(2, end)`）。 */
export const EASE_TO_CSS = Object.freeze({
  linear: 'linear',
  'ease-in': 'ease-in',
  'ease-out': 'ease-out',
  'ease-in-out': 'ease-in-out',
  'steps-2': 'steps(2, end)',
});

/**
 * 可插值属性白名单。
 *
 * 为什么是白名单而不是黑名单：漏判的代价不对称 —— 黑名单漏一个（比如 `content`）
 * 会在渲染时得到「中间态跳变」，而白名单漏一个只是让用户暂时改不了、报
 * `KF_NOT_INTERPOLABLE` 并给出可读提示。宁可保守。
 *
 * 名字都是**规范属性名**（小写、带连字符），不接受简写别名。
 */
export const INTERPOLABLE_PROPERTIES = Object.freeze([
  // 不透明度与颜色
  'opacity',
  'color',
  'background-color',
  'border-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline-color',
  'text-decoration-color',
  'accent-color',
  'caret-color',
  'fill',
  'stroke',
  'stop-color',
  'flood-color',
  'lighting-color',
  // 尺寸与定位
  'width',
  'height',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'left',
  'top',
  'right',
  'bottom',
  'inset',
  // 盒模型
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border-width',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-radius',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-left-radius',
  'border-bottom-right-radius',
  'outline-width',
  'outline-offset',
  // 字体与文本
  'font-size',
  'font-weight',
  'letter-spacing',
  'word-spacing',
  'line-height',
  'text-indent',
  'text-shadow',
  // 效果与变换
  'box-shadow',
  'filter',
  'backdrop-filter',
  'clip-path',
  'background-position',
  'background-size',
  'transform',
  'transform-origin',
  'translate',
  'rotate',
  'scale',
  // 布局（可插值但少用；留着免得「想动 gap」被判不可插值）
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'gap',
  'row-gap',
  'column-gap',
  'order',
  'z-index',
]);

const INTERPOLABLE = new Set(INTERPOLABLE_PROPERTIES);

/**
 * 明确**不可**插值的少数几个，只用来把错误信息写具体
 * （「`background-image` 不能插值」比「不在白名单里」有用得多）。
 */
export const NON_INTERPOLABLE_EXAMPLES = Object.freeze([
  'background-image',
  'background',
  'border-image',
  'border-image-source',
  'content',
  'display',
  'position',
  'font-family',
  'visibility',
  'animation',
  'animation-name',
  'animation-duration',
  'transition',
  'will-change',
  'content-visibility',
  'float',
  'overflow',
  'overflow-x',
  'overflow-y',
]);

const NON_INTERPOLABLE = new Set(NON_INTERPOLABLE_EXAMPLES);

/**
 * 这个属性能不能做关键帧。
 * @param {string} prop
 * @returns {boolean}
 */
export function isInterpolableProperty(prop) {
  return typeof prop === 'string' && INTERPOLABLE.has(prop);
}

/** @param {unknown} value @returns {value is number} */
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * 把一条 `kf` 规格化成可哈希的形状：帧按 t 升序、每帧属性名字典序、ease 显式化。
 * 只用于**哈希**与**输出字节**，不改调用方的对象。
 * @param {readonly any[]} kf
 * @returns {{t: number, ease: string, style: [string, string][]}[]}
 */
function canonicalFrames(kf) {
  return kf
    .map((frame) => ({
      t: Number(frame.t),
      ease: typeof frame.ease === 'string' ? frame.ease : 'linear',
      style: Object.keys(frame.style ?? {})
        .sort()
        .map((key) => /** @type {[string, string]} */ ([key, String(/** @type {any} */ (frame.style)[key])])),
    }))
    .sort((a, b) => a.t - b.t);
}

/**
 * 规则名（也是 `data-kf` 的值）。
 *
 * 含**选择器 + 属性集 + 帧序列 + 缓动**。
 *
 * **不含片段起点**：`--motion-t` 是片段内局部毫秒（注入侧已经减掉 `clip.at`），
 * 所以同选择器 + 同帧序列 + 不同起点的两条 kf，走的是**同一段 CSS**，只是各自的
 * 元素被写了不同的局部毫秒数 —— 规则可以安全复用。
 *
 * （P1 曾把 `clipStart` 也算进 hash，因为那时 delay 里含 `at`、两片段不能共用一条规则。
 * P2 改成本地口径后这个约束消失了，hash 回到设计书 §3 列的三个输入。）
 *
 * @param {string} at 选择器
 * @param {readonly any[]} kf
 * @returns {string} 10 位十六进制
 */
export function keyframeHash(at, kf) {
  const payload = JSON.stringify({
    v: 2,
    at: String(at),
    frames: canonicalFrames(kf),
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 10);
}

/**
 * 一条 `kf` 的五条拒绝（不含 `KF_STATIC_CONFLICT`：那要跨条目看，归 parse）。
 *
 * 报错**按结构→语义**的顺序短路：一条 `kf` 只报第一类问题，避免同一处刷五条。
 *
 * @param {unknown} kf
 * @param {{ at?: string, duration?: number|null, clipId?: string }} [ctx]
 *   `duration`：片段在时间线上的时长（秒）。`null`/`undefined` = 时长未知
 *   （`#t=in` 到结尾、或整段素材没写 `#t=`），此时**不判**越界。
 * @returns {{ok: true} | {ok: false, code: string, message: string, index?: number}}
 */
export function validateKeyframeList(kf, ctx = {}) {
  const where = typeof ctx.at === 'string' && ctx.at !== '' ? `（${ctx.at}）` : '';

  if (!Array.isArray(kf)) {
    return { ok: false, code: 'KF_TOO_SHORT', message: `kf 必须是数组${where}` };
  }
  if (kf.length < 2) {
    return {
      ok: false,
      code: 'KF_TOO_SHORT',
      message: `kf 至少 2 条关键帧，只有 ${kf.length} 条${where}：一条没有「从哪到哪」`,
    };
  }

  /** @type {number[]} */
  const times = [];
  for (let index = 0; index < kf.length; index += 1) {
    const frame = kf[index];
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
      return { ok: false, code: 'KF_ORDER', message: `kf[${index}] 必须是对象${where}`, index };
    }
    if (!finite(frame.t)) {
      return { ok: false, code: 'KF_ORDER', message: `kf[${index}].t 必须是有限数值（秒）${where}`, index };
    }
    if (frame.t < 0) {
      return { ok: false, code: 'KF_OUT_OF_RANGE', message: `kf[${index}].t 不能为负：${frame.t}${where}`, index };
    }
    if (frame.style === null || typeof frame.style !== 'object' || Array.isArray(frame.style)) {
      return { ok: false, code: 'KF_PROPS_MISMATCH', message: `kf[${index}].style 必须是对象${where}`, index };
    }
    const props = Object.keys(frame.style);
    if (props.length === 0) {
      return { ok: false, code: 'KF_PROPS_MISMATCH', message: `kf[${index}].style 不能为空${where}`, index };
    }
    if (frame.ease !== undefined && !KEYFRAME_EASES.includes(frame.ease)) {
      return {
        ok: false,
        code: 'KF_PROPS_MISMATCH',
        message: `kf[${index}].ease 只能是 ${KEYFRAME_EASES.join(' / ')}：${String(frame.ease)}${where}`,
        index,
      };
    }
    times.push(frame.t);
  }

  for (let index = 1; index < times.length; index += 1) {
    const previous = /** @type {number} */ (times[index - 1]);
    const current = /** @type {number} */ (times[index]);
    if (!(current > previous)) {
      return {
        ok: false,
        code: 'KF_ORDER',
        message: `kf 的 t 必须严格升序：第 ${index - 1} 条 ${previous}s，第 ${index} 条 ${current}s${where}`,
        index,
      };
    }
  }

  const first = Object.keys(kf[0].style).sort().join(',');
  for (let index = 1; index < kf.length; index += 1) {
    const keys = Object.keys(kf[index].style).sort().join(',');
    if (keys !== first) {
      return {
        ok: false,
        code: 'KF_PROPS_MISMATCH',
        message: `kf 每帧的属性集必须一致：第 0 条是 [${first}]，第 ${index} 条是 [${keys}]${where}（否则中间态会跳）`,
        index,
      };
    }
  }

  for (let index = 0; index < kf.length; index += 1) {
    for (const prop of Object.keys(kf[index].style)) {
      if (INTERPOLABLE.has(prop)) continue;
      const why = NON_INTERPOLABLE.has(prop)
        ? `${prop} 不是可插值属性`
        : `${prop} 不在可插值白名单里（见 keyframes.mjs 的 INTERPOLABLE_PROPERTIES）`;
      return { ok: false, code: 'KF_NOT_INTERPOLABLE', message: `kf[${index}] 的 ${why}${where}`, index };
    }
  }

  const duration = ctx.duration;
  if (finite(duration)) {
    const last = /** @type {number} */ (times[times.length - 1]);
    /* 允许恰好等号（设计书 §2：「允许恰好等号」）；只拒真的超出。 */
    if (last > duration) {
      return {
        ok: false,
        code: 'KF_OUT_OF_RANGE',
        message: `kf 末帧 ${last}s 超出片段时长 ${duration}s${where}`,
        index: times.length - 1,
      };
    }
  }

  return { ok: true };
}

/**
 * 静态覆盖里「占用了哪些 CSS 属性」。
 *
 * `s`/`r` 不是 `style` 的键，但它们最终写到 `scale`/`rotate` 两个个体属性上
 * （见 `packages/layers/apply-overrides.mjs` 的变换所有权表）—— kf 若同时动
 * `scale`/`rotate`，就是同一属性的两套写法，必须按冲突拒掉。
 *
 * @param {{ style?: Record<string, string>, s?: unknown, r?: unknown }} entry
 * @returns {Set<string>}
 */
export function staticPropsOf(entry) {
  /** @type {Set<string>} */
  const props = new Set();
  for (const key of Object.keys(entry?.style ?? {})) props.add(key);
  if (entry?.s !== undefined && entry.s !== null) props.add('scale');
  if (finite(entry?.r)) props.add('rotate');
  return props;
}

/**
 * 编译整份文档。
 *
 * @param {{tracks?: readonly any[]}} doc
 * @returns {{
 *   css: string,
 *   plans: {clipId: string, at: string, hash: string, span: number, clipStart: number, selector: string}[],
 *   diagnostics: {code: string, message: string, clipId?: string, at?: string}[],
 *   stats: {rules: number, plans: number, deduped: number, declarationCount: number}
 * }}
 */
export function compileKeyframes(doc) {
  /** @type {{code: string, message: string, clipId?: string, at?: string}[]} */
  const diagnostics = [];
  /** @type {{clipId: string, at: string, hash: string, span: number, clipStart: number, selector: string}[]} */
  const plans = [];
  /** @type {Map<string, string>} */
  const rules = new Map();
  let deduped = 0;
  let declarationCount = 0;

  const tracks = Array.isArray(doc?.tracks) ? doc.tracks : [];
  for (const track of tracks) {
    const clips = Array.isArray(track?.clips) ? track.clips : [];
    for (const clip of clips) {
      const entries = Array.isArray(clip?.overrides) ? clip.overrides : [];
      const start = finite(clip?.at) ? Number(clip.at) : 0;
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object') continue;
        const kf = /** @type {any} */ (entry).kf;
        if (kf === undefined) continue;
        const at = typeof entry.at === 'string' ? entry.at : '';
        if (at === '') {
          diagnostics.push({ code: 'KF_TOO_SHORT', message: 'kf 只能挂在「层覆盖」上（条目缺 at）', clipId: clip?.id });
          continue;
        }

        /* 时长：只有 `#t=in,out` 才可算；`#t=in`（到结尾）与没写 `#t=` 都是未知。 */
        const range = Array.isArray(clip?.time) && clip.time.length === 2 ? { from: Number(clip.time[0]), to: Number(clip.time[1]) } : null;
        const duration = clipDuration(range, finite(clip?.speed) && clip.speed > 0 ? clip.speed : 1);

        const verdict = validateKeyframeList(kf, { at, duration, clipId: clip?.id });
        if (!verdict.ok) {
          diagnostics.push({ code: verdict.code, message: verdict.message, clipId: clip?.id, at });
          continue;
        }

        const staticProps = staticPropsOf(/** @type {any} */ (entry));
        const clash = Object.keys(kf[0].style).filter((prop) => staticProps.has(prop));
        if (clash.length > 0) {
          diagnostics.push({
            code: 'KF_STATIC_CONFLICT',
            message: `元素 ${at} 的 ${clash.join(',')} 同时有静态覆盖与关键帧：二者只能留一个`,
            clipId: clip?.id,
            at,
          });
          continue;
        }

        const frames = canonicalFrames(kf);
        const span = /** @type {{t: number}} */ (frames[frames.length - 1]).t;
        if (!(span > 0)) {
          diagnostics.push({ code: 'KF_ORDER', message: `kf 的末帧 t 必须大于 0（否则没有时长）${at}`, clipId: clip?.id, at });
          continue;
        }
        const hash = keyframeHash(at, kf);
        const selector = `[data-kf="${hash}"]`;

        if (!rules.has(hash)) {
          const body = frames
            .map((frame, index) => {
              const pct = formatPercent(frame.t, span, index === frames.length - 1);
              /** @type {string[]} */
              const decls = frame.style.map(([prop, value]) => `${prop}: ${value};`);
              declarationCount += decls.length;
              /* 缓动只对「本帧 → 下一帧」有意义；末帧不写，免得写出死声明。 */
              if (index < frames.length - 1) {
                decls.push(`animation-timing-function: ${EASE_TO_CSS[/** @type {keyof typeof EASE_TO_CSS} */ (frame.ease)] ?? 'linear'};`);
              }
              return `  ${pct} { ${decls.join(' ')} }`;
            })
            .join('\n');
          rules.set(
            hash,
            `@keyframes kf-${hash} {\n${body}\n}\n${selector} {\n  animation: kf-${hash} ${formatSeconds(span)}s linear both;\n  animation-play-state: paused;\n  animation-delay: calc(-1 * var(${MOTION_TIME_VAR}, 0) * 1ms);\n}`,
          );
        } else {
          deduped += 1;
        }

        plans.push({ clipId: String(clip?.id ?? ''), at, hash, span, clipStart: start, selector });
      }
    }
  }

  const css = rules.size === 0 ? '' : `${[...rules.values()].join('\n\n')}\n`;
  return { css, plans, diagnostics, stats: { rules: rules.size, plans: plans.length, deduped, declarationCount } };
}

/**
 * 百分比串：`t / span`，4 位小数后截尾零。
 * 末帧强制 `100%`（避免 `99.9999%` 这类浮点残留）。
 * @param {number} t @param {number} span @param {boolean} isLast @returns {string}
 */
function formatPercent(t, span, isLast) {
  if (isLast) return '100%';
  const raw = (t / span) * 100;
  const rounded = Math.round(raw * 10000) / 10000;
  const text = String(rounded);
  return `${text}%`;
}

/** 秒数的最短确定性写法（不用 toFixed，免得 `0.5000s` 这种噪声进字节）。 @param {number} value */
function formatSeconds(value) {
  const rounded = Math.round(Number(value) * 1000) / 1000;
  return String(rounded);
}

/**
 * 只要 CSS 的便捷出口（调用方不需要 plans 时）。
 * @param {{tracks?: readonly any[]}} doc
 * @returns {string}
 */
export function keyframesCss(doc) {
  return compileKeyframes(doc).css;
}

/** 供测试断言「这份 CSS 真的挂了时钟」：`animation-delay` 必须含这个子串。 */
export const MOTION_TIME_REFERENCE = `var(${MOTION_TIME_VAR}`;
