/**
 * 文本样式覆盖的四个键（E05-P3 前置 / R15 · R30-073）
 *
 * `OverrideEntry` 上新增的文本样式：**描边**（`stroke`）、**底框**（`bg`）、
 * **对齐**（`align`）、**字距**（`tracking`）。
 *
 * ## 为什么单独一个模块
 *
 * 白名单在仓库里是**两份**：`film-doc.mjs` 的 `OVERRIDE_KEYS`（parse 用）与
 * `ops.mjs` 的 `OPS_OVERRIDE_KEYS`（`/ops` 写盘用）。历史教训是「加字段只加一处 →
 * 另一条路静默丢字段」。键集合那两份仍然各自写着（便于逐字比对），但**取值规则只有这一份**：
 * 两个入口都调 `validateTextStyle()`，规则不可能分叉。
 *
 * ## 各键的契约
 *
 * | 键 | 类型 | 取值域 | 拒绝码 | 写盘 HTML 形态 |
 * |---|---|---|---|---|
 * | `stroke` | `{color, width?}` | color 见 `isCssColor`；width 0–64 px（缺省 1） | `STROKE_INVALID` | `"stroke":{"color":"#ffcc00","width":2}` |
 * | `bg` | `{color, padX?, padY?, radius?}` | color 同上；padX/padY/radius 0–200 px | `BG_INVALID` | `"bg":{"color":"#000000cc","padX":12,"padY":6,"radius":4}` |
 * | `align` | `'left'｜'center'｜'right'｜'justify'` | 这四个字符串 | `ALIGN_INVALID` | `"align":"center"` |
 * | `tracking` | `number` | −50…400 px（可小数） | `TRACKING_INVALID` | `"tracking":1.5` |
 *
 * 颜色只收**无歧义**写法：`#rgb/#rgba/#rrggbb/#rrggbbaa` 与 `rgb()/rgba()/hsl()/hsla()`。
 * 命名色（`red`）与 `var()` / `url()` / `currentColor` 一律拒——它们要么依赖环境、
 * 要么能把任意串带进样式表，写盘后在不同机器上不是同一个颜色。
 *
 * ## 与静态 `style` / `kf` 的关系
 *
 * 这四键是**静态**覆盖（不是关键帧属性），因此：
 * - 不进 `keyframes.mjs` 的 `INTERPOLABLE_PROPERTIES`，`kf[].style` 里写它们会被
 *   `KF_NOT_INTERPOLABLE` 拒；
 * - 同一元素上 `stroke`/`bg`/`align`/`tracking` 与 `style` 里对应的 CSS 属性
 *   属于「同值同义」，但**不算** `KF_STATIC_CONFLICT`（那条只针对 kf 与静态争同一属性）。
 */

/** 四个键（顺序即写盘/展示顺序）。 */
export const TEXT_STYLE_KEYS = Object.freeze(['stroke', 'bg', 'align', 'tracking']);

/** 每个键的拒绝码（一个键一个稳定码，便于 UI 定位到具体字段）。 */
export const TEXT_STYLE_CODES = Object.freeze({
  stroke: 'STROKE_INVALID',
  bg: 'BG_INVALID',
  align: 'ALIGN_INVALID',
  tracking: 'TRACKING_INVALID',
});

/** 对齐的取值域。 */
export const TEXT_ALIGNS = Object.freeze(['left', 'center', 'right', 'justify']);

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FUNC_COLOR = /^(?:rgba?|hsla?)\([-+0-9.%\s,/a-zA-Z]+\)$/;
/** 能把任意 CSS 带进声明、或依赖外部环境的东西，一律不进颜色值。 */
const COLOR_DANGER = /(?:[;{}<>\\]|url\s*\(|var\s*\(|expression\s*\(|\/\*)/i;

/**
 * 这个字符串能不能当颜色值写进样式表。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isCssColor(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text === '' || text.length > 64) return false;
  if (COLOR_DANGER.test(text)) return false;
  return HEX_COLOR.test(text) || FUNC_COLOR.test(text);
}

/** @param {unknown} value @param {number} min @param {number} max */
function inRange(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @typedef {{ok: true} | {ok: false, code: string, message: string}} TextStyleVerdict
 */

/**
 * 校验一条层覆盖里的**文本样式键**（`stroke` / `bg` / `align` / `tracking`）。
 *
 * 没给这些键 → `{ok:true}`（零成本，不影响既有文档）。
 * 给了就逐键校验：类型、取值域、未知子键都算非法，绝不放行后静默丢弃。
 *
 * @param {Record<string, unknown>} entry 一条层覆盖（已确认是对象）
 * @returns {TextStyleVerdict}
 */
export function validateTextStyle(entry) {
  if (!isPlainObject(entry)) return { ok: true };

  if (entry.stroke !== undefined) {
    const stroke = entry.stroke;
    if (!isPlainObject(stroke)) {
      return { ok: false, code: TEXT_STYLE_CODES.stroke, message: `stroke 必须是 {color, width?}，收到 ${JSON.stringify(stroke)}` };
    }
    const extra = Object.keys(stroke).filter((key) => key !== 'color' && key !== 'width');
    if (extra.length > 0) {
      return { ok: false, code: TEXT_STYLE_CODES.stroke, message: `stroke 含未知字段：${extra.join(',')}（只认 color / width）` };
    }
    if (!isCssColor(stroke.color)) {
      return { ok: false, code: TEXT_STYLE_CODES.stroke, message: `stroke.color 不是可写的颜色值：${JSON.stringify(stroke.color)}` };
    }
    if (stroke.width !== undefined && !inRange(stroke.width, 0, 64)) {
      return { ok: false, code: TEXT_STYLE_CODES.stroke, message: `stroke.width 必须在 0–64（px），收到 ${JSON.stringify(stroke.width)}` };
    }
  }

  if (entry.bg !== undefined) {
    const bg = entry.bg;
    if (!isPlainObject(bg)) {
      return { ok: false, code: TEXT_STYLE_CODES.bg, message: `bg 必须是 {color, padX?, padY?, radius?}，收到 ${JSON.stringify(bg)}` };
    }
    const extra = Object.keys(bg).filter((key) => !['color', 'padX', 'padY', 'radius'].includes(key));
    if (extra.length > 0) {
      return { ok: false, code: TEXT_STYLE_CODES.bg, message: `bg 含未知字段：${extra.join(',')}（只认 color / padX / padY / radius）` };
    }
    if (!isCssColor(bg.color)) {
      return { ok: false, code: TEXT_STYLE_CODES.bg, message: `bg.color 不是可写的颜色值：${JSON.stringify(bg.color)}` };
    }
    for (const key of ['padX', 'padY', 'radius']) {
      if (bg[key] !== undefined && !inRange(bg[key], 0, 200)) {
        return { ok: false, code: TEXT_STYLE_CODES.bg, message: `bg.${key} 必须在 0–200（px），收到 ${JSON.stringify(bg[key])}` };
      }
    }
  }

  if (entry.align !== undefined) {
    if (typeof entry.align !== 'string' || !TEXT_ALIGNS.includes(entry.align)) {
      return { ok: false, code: TEXT_STYLE_CODES.align, message: `align 只能是 ${TEXT_ALIGNS.join(' / ')}，收到 ${JSON.stringify(entry.align)}` };
    }
  }

  if (entry.tracking !== undefined) {
    if (!inRange(entry.tracking, -50, 400)) {
      return { ok: false, code: TEXT_STYLE_CODES.tracking, message: `tracking 必须在 −50…400（px），收到 ${JSON.stringify(entry.tracking)}` };
    }
  }

  return { ok: true };
}

/*
 * 为什么这里没有「键 → CSS 声明」的映射函数
 *
 * 那一步要跑在**页内**（`packages/layers/apply-overrides.mjs` 的 `applyOverrideEntries`
 * 会被 `Function.prototype.toString()` 塞进舞台运行时，页面里没有模块作用域）。
 * 如果在这里再写一份供测试比对，就变成「两份映射」，与白名单的老毛病同型。
 * 所以映射只写在页内函数里一处；本模块只负责**校验规则**（唯一一份），
 * 验收时用真浏览器读 computed style 反证映射写对了。
 */
