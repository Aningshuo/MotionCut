/** R125 · M11-A：认出「我们自己写的 SVG 蒙版层」——它和四边渐隐共用 mask-image，但不是「手写蒙版」。 */
import { isOwnMaskLayer } from './inspector-mask.mjs';

/**
 * 检查器「调节 / 效果 / 混合模式」（R113 · L2 · LI-A16/A17/A18/A19）
 *
 * 本文件是**纯函数**：不碰 DOM、不写盘、不读时钟。所有序列化规则只在这里写一份，
 * 面板（`inspector-panel.mjs`）与字段模型（`inspector-fields.mjs`）都调它，单测直接打这里。
 *
 * 三条硬规矩（来自派单与参考实现 `dM` / `pM` / `YF`）：
 * 1. **调色五项是 `filter` 的可逆结构化编辑**：亮度/对比/饱和度/色相/黑白各一条滑杆，
 *    零值删函数，改一项保留其他函数与它们的顺序，新加的调色函数插在 drop-shadow 之前。
 *    解析不了的 filter 一律**不动**，标注「手写，请到高级」。
 * 2. **效果栈是函数级增删**：投影（drop-shadow）/ 内阴影（box-shadow inset）/ 图层模糊（filter blur）/
 *    背景模糊（backdrop-filter blur）/ 四边渐隐（mask-image）。每个效果只改自己那一个函数，
 *    别人的函数一个不碰；重置 = 回到默认参数（不是把别人的键清空）。
 * 3. **三态分开**：absent（没有这个效果）/ custom（有，但是手写、无法结构化）/
 *    mixed（同一元素里多处且参数不一致，或多选不一致）。三态各自有文案，绝不混成一个空值。
 *
 * 关于单位：所有 CSS 值都按「原样字符串」写进 `overrides.style`，
 * 由 `apply-overrides.mjs` 的 `style.setProperty()` 落到元素上——这里只保证**语法正确**。
 */

/** 调色五项：id / CSS 函数名 / 中文名 / GUI 范围 / 值 ↔ 参数。顺序 = 面板顺序 = 插入顺序。 */
export const GRADE_SPECS = Object.freeze([
  Object.freeze({
    id: 'gradeBrightness',
    fn: 'brightness',
    label: '亮度',
    min: -100,
    max: 100,
    /** `brightness(1 + v/100)` */
    toValue: (/** @type {number} */ n) => (n - 1) * 100,
    fromValue: (/** @type {number} */ v) => `brightness(${fmt(1 + v / 100)})`
  }),
  Object.freeze({
    id: 'gradeContrast',
    fn: 'contrast',
    label: '对比度',
    min: -100,
    max: 100,
    toValue: (/** @type {number} */ n) => (n - 1) * 100,
    fromValue: (/** @type {number} */ v) => `contrast(${fmt(1 + v / 100)})`
  }),
  Object.freeze({
    id: 'gradeSaturate',
    fn: 'saturate',
    label: '饱和度',
    min: -100,
    max: 100,
    toValue: (/** @type {number} */ n) => (n - 1) * 100,
    fromValue: (/** @type {number} */ v) => `saturate(${fmt(1 + v / 100)})`
  }),
  Object.freeze({
    id: 'gradeHue',
    fn: 'hue-rotate',
    label: '色相',
    min: -180,
    max: 180,
    toValue: (/** @type {number} */ n) => n,
    fromValue: (/** @type {number} */ v) => `hue-rotate(${fmt(v)}deg)`
  }),
  Object.freeze({
    id: 'gradeGrayscale',
    fn: 'grayscale',
    label: '黑白',
    min: 0,
    max: 100,
    toValue: (/** @type {number} */ n) => n,
    fromValue: (/** @type {number} */ v) => `grayscale(${fmt(v)}%)`
  })
]);

/** 调色函数名集合（插入位置与「已有几个调色函数」用）。 */
const GRADE_FN_SET = /** @type {Set<string>} */ (new Set(GRADE_SPECS.map((spec) => spec.fn)));

/** 数字格式化：最多 4 位小数、去掉尾零（`1.1500000000000001` → `1.15`）。 */
function fmt(/** @type {number} */ n) {
  if (!Number.isFinite(n)) return '0';
  const rounded = Math.round(n * 10000) / 10000;
  return String(rounded);
}

/** 按顶层空白切词（`rgb(0 0 0 / 35%)` 里的空格不能切）。 */
function splitTokens(/** @type {string} */ text) {
  /** @type {string[]} */
  const out = [];
  let depth = 0;
  let start = -1;
  const raw = String(text ?? '');
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (/\s/.test(/** @type {string} */ (ch)) && depth === 0) {
      if (start >= 0) {
        out.push(raw.slice(start, i));
        start = -1;
      }
      continue;
    }
    if (start < 0) start = i;
  }
  if (start >= 0) out.push(raw.slice(start));
  return out.filter((token) => token !== '');
}

/** 长度/数字：`0` / `-8px` / `.5` / `12%`。`px` 是唯一接受的绝对单位（面板只写 px）。 */
function asLength(/** @type {string} */ token) {
  const hit = /^([+-]?(?:\d+\.?\d*|\.\d+))(px|%)?$/i.exec(String(token ?? '').trim());
  if (!hit) return null;
  const value = Number(hit[1]);
  if (!Number.isFinite(value)) return null;
  return { value, unit: (hit[2] ?? '').toLowerCase() };
}

/** 颜色：`#rgb` / `rgb()` / `rgba()` / `hsl()` / 颜色名。只做「像不像颜色」的判定，不改写。 */
function looksLikeColor(/** @type {string} */ token) {
  const text = String(token ?? '').trim();
  if (text === '') return false;
  if (text.startsWith('#')) return /^#[0-9a-z]{3,8}$/i.test(text);
  if (/^(rgb|rgba|hsl|hsla)\(/i.test(text)) return true;
  if (/^[a-z]+$/i.test(text)) return true;
  return false;
}

/**
 * 把 `filter` / `backdrop-filter` 扫成函数列表（**保留未知函数**，供调色与效果共存）。
 *
 * 与 `inspector-fields.mjs` 的 `parseFilterList` 不同：那边是**写入校验**（只收白名单函数），
 * 这边是**编辑底座**（必须能原样带着作者写的 `url(#f)`、`sepia(0.3)` 一起回写）。
 *
 * @param {unknown} text
 * @returns {{ok: true, funcs: Array<{name: string, arg: string, raw: string}>, value: string}
 *   | {ok: false, error: {code: string, message: string}}}
 */
export function parseFilterFunctions(text) {
  const raw = String(text ?? '').trim();
  if (raw === '' || /^none$/i.test(raw)) return { ok: true, funcs: [], value: '' };
  if (/[;{}<>]/.test(raw)) {
    return { ok: false, error: { code: 'INVALID_VALUE', message: `filter 含非法字符：${raw}` } };
  }
  /** @type {Array<{name: string, arg: string, raw: string}>} */
  const funcs = [];
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && /[\s,]/.test(/** @type {string} */ (raw[i]))) i += 1;
    if (i >= raw.length) break;
    const nameStart = i;
    while (i < raw.length && /[a-zA-Z-]/.test(/** @type {string} */ (raw[i]))) i += 1;
    const name = raw.slice(nameStart, i);
    if (name === '' || raw[i] !== '(') {
      return { ok: false, error: { code: 'INVALID_VALUE', message: `filter 写不成函数列表：${raw}` } };
    }
    let depth = 0;
    const argStart = i + 1;
    let argEnd = -1;
    for (; i < raw.length; i += 1) {
      if (raw[i] === '(') depth += 1;
      else if (raw[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          argEnd = i;
          break;
        }
      }
    }
    if (depth !== 0 || argEnd < 0) {
      return { ok: false, error: { code: 'INVALID_VALUE', message: `filter 的括号没闭合：${raw}` } };
    }
    const arg = raw.slice(argStart, argEnd);
    funcs.push({ name: name.toLowerCase(), arg, raw: `${name}(${arg})` });
    i = argEnd + 1;
  }
  const squeeze = (/** @type {string} */ s) => s.replace(/\s+/g, '').toLowerCase();
  if (squeeze(funcs.map((fn) => fn.raw).join(' ')) !== squeeze(raw)) {
    return { ok: false, error: { code: 'INVALID_VALUE', message: `filter 里有看不懂的片段：${raw}` } };
  }
  return { ok: true, funcs, value: raw.replace(/\s+/g, ' ') };
}

/** 函数列表 → 一条 CSS 值（空列表 → `none`）。 */
function joinFunctions(/** @type {Array<{raw: string}>} */ funcs) {
  return funcs.length === 0 ? 'none' : funcs.map((fn) => fn.raw).join(' ');
}

/**
 * 从 `filter` 读五项调色（GUI 值）。
 *
 * 三种结果，面板要分开显示：
 * - `custom: true`：整条 filter 解析不了（或某项参数超出 GUI 范围）→ 该字段标「手写，请到高级」；
 * - `values[key]`：读到的 GUI 值；没有该函数 → `null`（= 未添加，等价 0）；
 * - `unknownFunctions`：函数列表里有不认识的函数（`url()` / `sepia()` 等）——**不是错**，
 *   编辑时原样保留。只有解析失败才 `custom`。
 *
 * @param {unknown} filterText
 */
export function gradeFromFilter(filterText) {
  const parsed = parseFilterFunctions(filterText);
  if (!parsed.ok) {
    return {
      ok: false,
      custom: true,
      reason: '这一段 filter 是手写的（解析不了），调色不改它：请到「滤镜」里改原文',
      values: /** @type {Record<string, number|null>} */ ({}),
      unknownFunctions: []
    };
  }
  /** @type {Record<string, number|null>} */
  const values = {};
  /** @type {string[]} */
  const outOfRange = [];
  const unknownFunctions = [];
  /** @type {Map<string, number[]>} */
  const seen = new Map();
  for (const fn of parsed.funcs) {
    const spec = GRADE_SPECS.find((item) => item.fn === fn.name);
    if (spec === undefined) {
      if (!GRADE_FN_SET.has(fn.name)) unknownFunctions.push(fn.name);
      continue;
    }
    const parsedValue = gradeValueOf(spec, fn.arg);
    if (parsedValue === null) {
      outOfRange.push(`${spec.label}（${fn.raw}）`);
      continue;
    }
    const list = seen.get(spec.id) ?? [];
    list.push(parsedValue);
    seen.set(spec.id, list);
  }
  /** @type {string[]} */
  const mixedFields = [];
  for (const spec of GRADE_SPECS) {
    const list = seen.get(spec.id) ?? [];
    if (list.length === 0) {
      values[spec.id] = null;
      continue;
    }
    const first = /** @type {number} */ (list[0]);
    const same = list.every((item) => Math.abs(item - first) < 0.01);
    if (!same) mixedFields.push(spec.label);
    values[spec.id] = first;
  }
  return {
    ok: true,
    custom: outOfRange.length > 0,
    reason: outOfRange.length > 0 ? `有调色参数超出滑杆范围：${outOfRange.join('、')}（改它会重写成滑杆值）` : '',
    values,
    mixedFields,
    unknownFunctions,
    funcs: parsed.funcs
  };
}

/**
 * 一个调色函数的参数 → GUI 值；读不出/超范围 → null。
 * @param {{fn: string, min: number, max: number, toValue: (n: number) => number}} spec
 * @param {string} arg
 */
function gradeValueOf(spec, arg) {
  const text = String(arg ?? '').trim();
  if (spec.fn === 'hue-rotate') {
    const hit = /^([+-]?(?:\d+\.?\d*|\.\d+))(deg)?$/i.exec(text);
    if (!hit) return null;
    const value = Number(hit[1]);
    if (!Number.isFinite(value) || value < spec.min || value > spec.max) return null;
    return Math.round(value * 100) / 100;
  }
  if (spec.fn === 'grayscale') {
    const hit = /^([+-]?(?:\d+\.?\d*|\.\d+))(%?)$/i.exec(text);
    if (!hit) return null;
    const raw = Number(hit[1]);
    if (!Number.isFinite(raw)) return null;
    const value = hit[2] === '%' ? raw : raw <= 1 ? raw * 100 : raw;
    if (value < spec.min || value > spec.max) return null;
    return Math.round(value * 100) / 100;
  }
  const hit = /^([+-]?(?:\d+\.?\d*|\.\d+))(%?)$/i.exec(text);
  if (!hit) return null;
  const raw = Number(hit[1]);
  if (!Number.isFinite(raw)) return null;
  const n = hit[2] === '%' ? raw / 100 : raw;
  const value = spec.toValue(n);
  if (!Number.isFinite(value) || value < spec.min || value > spec.max) return null;
  return Math.round(value * 100) / 100;
}

/** 新调色函数插在哪里：已有调色函数 → 紧跟其后；否则插在 drop-shadow / url 之前；再否则末尾。 */
function gradeInsertIndex(/** @type {Array<{name: string}>} */ funcs) {
  let last = -1;
  for (let i = 0; i < funcs.length; i += 1) {
    if (GRADE_FN_SET.has(/** @type {{name: string}} */ (funcs[i]).name)) last = i;
  }
  if (last >= 0) return last + 1;
  const cut = funcs.findIndex((fn) => fn.name === 'drop-shadow' || fn.name === 'url');
  return cut < 0 ? funcs.length : cut;
}

/**
 * 改一项调色 → 新的 `filter` 值。
 *
 * 规则（与参考 `dM` 一致）：
 * - 值是 0 且函数存在 → **删掉**这个函数；
 * - 值是 0 且函数不存在 → 不动（不写 `brightness(1)` 占位）；
 * - 函数存在 → 原位替换（保留其他函数与顺序）；
 * - 函数不存在 → 插在调色区末尾 / drop-shadow 之前。
 *
 * @param {unknown} filterText 当前生效的 filter（override → inline → computed）
 * @param {string} fieldId `gradeBrightness` 等
 * @param {number|string} value GUI 值
 * @returns {{ok: true, value: string, unchanged?: boolean, note?: string}
 *   | {ok: false, error: {code: string, message: string}}}
 */
export function filterWithGrade(filterText, fieldId, value) {
  const spec = GRADE_SPECS.find((item) => item.id === fieldId);
  if (spec === undefined) return { ok: false, error: { code: 'NOT_EDITABLE', message: `不是调色字段：${fieldId}` } };
  const parsed = parseFilterFunctions(filterText);
  if (!parsed.ok) {
    return {
      ok: false,
      error: { code: 'FILTER_CUSTOM', message: '当前滤镜是手写的（解析不了），调色不改它：请到「滤镜」里改原文' }
    };
  }
  const numeric = Number(String(value ?? '').trim());
  if (!Number.isFinite(numeric)) {
    return { ok: false, error: { code: 'INVALID_VALUE', message: `${spec.label}需要数字（收到「${String(value ?? '')}」）` } };
  }
  if (numeric < spec.min || numeric > spec.max) {
    return {
      ok: false,
      error: { code: 'INVALID_VALUE', message: `${spec.label}必须在 ${spec.min}..${spec.max}（收到 ${numeric}）` }
    };
  }
  const funcs = parsed.funcs.map((fn) => ({ ...fn }));
  const index = funcs.findIndex((fn) => fn.name === spec.fn);
  if (index >= 0) {
    if (numeric === 0) {
      funcs.splice(index, 1);
      const next = joinFunctions(funcs);
      return { ok: true, value: next, note: `${spec.label}归零：删掉 ${spec.fn}()` };
    }
    funcs[index] = { name: spec.fn, arg: argsOf(spec.fromValue(numeric)), raw: spec.fromValue(numeric) };
    return { ok: true, value: joinFunctions(funcs) };
  }
  if (numeric === 0) return { ok: true, value: parsed.value === '' ? 'none' : parsed.value, unchanged: true };
  const at = gradeInsertIndex(funcs);
  const raw = spec.fromValue(numeric);
  funcs.splice(at, 0, { name: spec.fn, arg: argsOf(raw), raw });
  return { ok: true, value: joinFunctions(funcs) };
}

/** `brightness(1.15)` → `1.15`（写回时只换参数，函数名不变）。 */
function argsOf(/** @type {string} */ raw) {
  const hit = /\(([\s\S]*)\)$/.exec(raw);
  return hit ? String(hit[1] ?? '') : '';
}

/* ────────────────────────────── 效果栈 ────────────────────────────── */

/**
 * 五个效果的固定顺序（= 面板顺序 = `data-order`）。
 * **不支持重排**：不画拖拽手柄、不假装能拖（A19 的「不支持的重排不能假成功」）。
 */
export const EFFECT_DEFS = Object.freeze([
  Object.freeze({ id: 'effectShadow', kind: 'drop-shadow', label: '投影', order: 1, writes: 'filter' }),
  Object.freeze({ id: 'effectInnerShadow', kind: 'inset-shadow', label: '内阴影', order: 2, writes: 'box-shadow' }),
  Object.freeze({ id: 'effectBlur', kind: 'blur', label: '图层模糊', order: 3, writes: 'filter' }),
  Object.freeze({ id: 'effectBackdrop', kind: 'backdrop-blur', label: '背景模糊', order: 4, writes: 'backdrop-filter' }),
  Object.freeze({ id: 'effectFade', kind: 'edge-fade', label: '四边渐隐', order: 5, writes: 'mask-image' })
]);

/** 四边渐隐的四条边（顺序 = `data-edge` 顺序 = 面板顺序）。 */
export const FADE_EDGES = Object.freeze(['top', 'right', 'bottom', 'left']);
/** 渐隐强度的合法范围（%）。 */
export const FADE_MIN = 0.5;
export const FADE_MAX = 50;

/** 默认参数（添加 / 重置时用）。 */
export const EFFECT_DEFAULTS = Object.freeze({
  'drop-shadow': Object.freeze({ x: 0, y: 8, blur: 24, color: 'rgba(0, 0, 0, 0.35)' }),
  'inset-shadow': Object.freeze({ x: 0, y: 2, blur: 8, spread: 0, color: 'rgba(0, 0, 0, 0.35)' }),
  blur: Object.freeze({ value: 4 }),
  'backdrop-blur': Object.freeze({ value: 8 }),
  'edge-fade': Object.freeze({ edges: Object.freeze({ top: 12, right: 0, bottom: 0, left: 0 }) })
});

/** 渐隐层：只认我们自己写的那种写法（`mask-composite` 之外的作者蒙版原样保留）。 */
const FADE_RE = /^linear-gradient\(to (top|bottom|left|right), rgba\(0,\s*0,\s*0,\s*0\) 0%, rgba\(0,\s*0,\s*0,\s*1\) ([\d.]+)%\)$/;
/** 方向词 → 被渐隐的那条边（`to bottom` = 从顶部开始透明 → 顶边渐隐）。 */
const FADE_DIRECTION_EDGE = { bottom: 'top', top: 'bottom', right: 'left', left: 'right' };

/** 生成一条渐隐层。 */
function fadeLayer(/** @type {string} */ edge, /** @type {number} */ percent) {
  const direction = edge === 'top' ? 'bottom' : edge === 'bottom' ? 'top' : edge === 'left' ? 'right' : 'left';
  return `linear-gradient(to ${direction}, rgba(0,0,0,0) 0%, rgba(0,0,0,1) ${fmt(percent)}%)`;
}

/**
 * 读一个效果的三态 + 参数。
 * @param {{filter?: unknown, boxShadow?: unknown, backdropFilter?: unknown, maskImage?: unknown}} css
 * @param {string} kind
 * @returns {{state: 'absent'|'present'|'custom'|'mixed', params: any, count: number, note: string}}
 */
export function readEffect(css, kind) {
  const filterText = String(css.filter ?? '');
  const boxShadowText = String(css.boxShadow ?? '');
  const backdropText = String(css.backdropFilter ?? '');
  const maskText = String(css.maskImage ?? '');

  if (kind === 'drop-shadow') {
    const parsed = parseFilterFunctions(filterText);
    if (!parsed.ok) return customOf('滤镜是手写的，投影无法结构化');
    const hits = parsed.funcs.filter((fn) => fn.name === 'drop-shadow');
    if (hits.length === 0) return absentOf();
    const params = hits.map((fn) => parseDropShadow(fn.arg));
    if (params.some((item) => item === null)) return customOf('投影参数是手写的，无法结构化');
    const list = /** @type {any[]} */ (params);
    if (list.length > 1 && !list.every((item) => sameJson(item, list[0]))) {
      return { state: 'mixed', params: list[0], count: list.length, note: `${list.length} 处投影参数不一致` };
    }
    return { state: 'present', params: list[0], count: list.length, note: '' };
  }

  if (kind === 'inset-shadow') {
    const parts = splitTopLevel(boxShadowText);
    /* Chromium 的计算值把 inset 放在**最后**（`rgba(...) 0px 18px 8px 0px inset`），
       只认前导 inset 会让刚写下去的内阴影读成「未添加」。 */
    const hits = parts.filter((part) => /(^|\s)inset(\s|$)/i.test(part));
    if (hits.length === 0) return absentOf();
    const params = hits.map((part) => parseInsetShadow(part));
    if (params.some((item) => item === null)) return customOf('内阴影参数是手写的，无法结构化');
    const list = /** @type {any[]} */ (params);
    if (list.length > 1 && !list.every((item) => sameJson(item, list[0]))) {
      return { state: 'mixed', params: list[0], count: list.length, note: `${list.length} 处内阴影参数不一致` };
    }
    return { state: 'present', params: list[0], count: list.length, note: '' };
  }

  if (kind === 'blur' || kind === 'backdrop-blur') {
    const source = kind === 'blur' ? filterText : backdropText;
    const parsed = parseFilterFunctions(source);
    if (!parsed.ok) return customOf('滤镜是手写的，模糊无法结构化');
    const hits = parsed.funcs.filter((fn) => fn.name === 'blur');
    if (hits.length === 0) return absentOf();
    const values = hits.map((fn) => {
      const token = asLength(String(fn.arg ?? '').trim());
      return token !== null && token.unit !== '%' ? token.value : null;
    });
    if (values.some((item) => item === null)) return customOf('模糊参数是手写的，无法结构化');
    const list = /** @type {number[]} */ (values);
    if (list.length > 1 && !list.every((item) => Math.abs(item - /** @type {number} */ (list[0])) < 0.001)) {
      return { state: 'mixed', params: { value: list[0] }, count: list.length, note: `${list.length} 处模糊参数不一致` };
    }
    return { state: 'present', params: { value: list[0] }, count: list.length, note: '' };
  }

  if (kind === 'edge-fade') {
    /* R125 · M11-A：我们的 SVG 蒙版层**不算**「手写蒙版」——否则加了蒙版之后，
       四边渐隐那行会变成「手写（无法结构化）」、添加/停用按钮全消失（实测）。
       两层同时存在是正常状态：蒙版管形状，渐隐管四边。 */
    const layers = splitTopLevel(maskText).filter((layer) => !isOwnMaskLayer(layer));
    if (layers.length === 0) return absentOf();
    /** @type {Record<string, number>} */
    const edges = {};
    let matched = 0;
    let foreign = 0;
    for (const layer of layers) {
      const hit = FADE_RE.exec(layer.trim());
      if (hit === null) {
        foreign += 1;
        continue;
      }
      const edge = FADE_DIRECTION_EDGE[/** @type {'top'|'bottom'|'left'|'right'} */ (hit[1])];
      if (edge === undefined) {
        foreign += 1;
        continue;
      }
      edges[edge] = Number(hit[2]);
      matched += 1;
    }
    if (matched === 0) {
      return { state: 'custom', params: { edges: {} }, count: foreign, note: '已有自定义蒙版（不是四边渐隐）：不改它' };
    }
    return {
      state: 'present',
      params: { edges, foreign },
      count: matched,
      note: foreign > 0 ? `另外保留 ${foreign} 层作者蒙版` : ''
    };
  }

  return absentOf();
}

/** @returns {{state: 'absent', params: null, count: number, note: string}} */
function absentOf() {
  return { state: 'absent', params: null, count: 0, note: '' };
}

/** @param {string} note @returns {{state: 'custom', params: null, count: number, note: string}} */
function customOf(note) {
  return { state: 'custom', params: null, count: 0, note };
}

/** 结构比较（参数对象都是纯数据）。 */
function sameJson(/** @type {any} */ a, /** @type {any} */ b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 顶层逗号切分（颜色里的逗号不能切）。 */
function splitTopLevel(/** @type {string} */ text) {
  const raw = String(text ?? '').trim();
  if (raw === '' || /^none$/i.test(raw)) return [];
  /** @type {string[]} */
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      out.push(raw.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(raw.slice(start).trim());
  return out.filter((part) => part !== '');
}

/** `0 8px 24px rgba(0,0,0,.35)` → `{x,y,blur,color}`；读不出 → null。 */
export function parseDropShadow(/** @type {string} */ arg) {
  const tokens = splitTokens(arg);
  if (tokens.length < 2) return null;
  /** @type {Array<{value: number, unit: string}>} */
  const lengths = [];
  let color = '';
  for (const token of tokens) {
    const len = asLength(token);
    /* R121 · M7-A：**颜色可以在任意位置**。Chromium 读回时把 drop-shadow 序列化成
       `drop-shadow(rgba(...) 0px 8px 24px)`（颜色在前），旧逻辑一旦先见到颜色就再也不收
       长度 → 自己刚写下去的效果被当成「手写」，重置/启停整排按钮消失。
       这里只按「是不是长度」归类，颜色顺序不影响解析。 */
    if (len !== null && lengths.length < 3) lengths.push(len);
    else if (looksLikeColor(token)) color = color === '' ? token : `${color} ${token}`;
    else return null;
  }
  if (lengths.length < 2) return null;
  const [x, y, blur] = lengths;
  return {
    x: /** @type {{value: number}} */ (x).value,
    y: /** @type {{value: number}} */ (y).value,
    blur: blur === undefined ? 0 : blur.value,
    color: color === '' ? 'rgba(0, 0, 0, 0.35)' : color
  };
}

/**
 * `inset 0 2px 8px 0 rgba(...)` → `{x,y,blur,spread,color}`；读不出 → null。
 *
 * R121 · M7-A：`inset` 可以**在尾**——Chromium 计算值把 box-shadow 序列化成
 * `rgba(...) 0px 18px 8px 0px inset`。旧实现只剥**前导** inset，于是自己写的内阴影
 * 读回来是「未添加」，再点一次「添加」就会叠出两条（实测重复了一条）。
 */
export function parseInsetShadow(/** @type {string} */ part) {
  const text = String(part ?? '').trim().replace(/\binset\b/gi, ' ').replace(/\s+/g, ' ').trim();
  const tokens = splitTokens(text);
  if (tokens.length < 2) return null;
  /** @type {Array<{value: number, unit: string}>} */
  const lengths = [];
  let color = '';
  for (const token of tokens) {
    const len = asLength(token);
    /* 同 parseDropShadow：颜色在前（Chromium 的序列化顺序）也要认。 */
    if (len !== null && lengths.length < 4) lengths.push(len);
    else if (looksLikeColor(token)) color = color === '' ? token : `${color} ${token}`;
    else return null;
  }
  if (lengths.length < 2) return null;
  const [x, y, blur, spread] = lengths;
  return {
    x: /** @type {{value: number}} */ (x).value,
    y: /** @type {{value: number}} */ (y).value,
    blur: blur === undefined ? 0 : blur.value,
    spread: spread === undefined ? 0 : spread.value,
    color: color === '' ? 'rgba(0, 0, 0, 0.35)' : color
  };
}

/** 参数 → CSS 片段。 */
export function dropShadowCss(/** @type {any} */ params) {
  const p = { ...EFFECT_DEFAULTS['drop-shadow'], ...(params ?? {}) };
  return `drop-shadow(${fmt(numOr(p.x, 0))}px ${fmt(numOr(p.y, 8))}px ${fmt(Math.max(0, numOr(p.blur, 24)))}px ${String(p.color ?? 'rgba(0, 0, 0, 0.35)')})`;
}

export function insetShadowCss(/** @type {any} */ params) {
  const p = { ...EFFECT_DEFAULTS['inset-shadow'], ...(params ?? {}) };
  return `inset ${fmt(numOr(p.x, 0))}px ${fmt(numOr(p.y, 2))}px ${fmt(Math.max(0, numOr(p.blur, 8)))}px ${fmt(numOr(p.spread, 0))}px ${String(p.color ?? 'rgba(0, 0, 0, 0.35)')}`;
}

function numOr(/** @type {any} */ value, /** @type {number} */ fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 某个效果的默认参数（`EFFECT_DEFAULTS` 是只读对象，用 any 取值免得联合类型报 undefined）。 */
function defaultOf(/** @type {string} */ kind) {
  return /** @type {any} */ (EFFECT_DEFAULTS)[kind] ?? {};
}

/**
 * 效果栈的一次编辑 → 一条 patch（只带**受影响的那一个键**）。
 *
 * @param {{filter?: unknown, boxShadow?: unknown, backdropFilter?: unknown, maskImage?: unknown}} css
 * @param {string} kind `drop-shadow` / `inset-shadow` / `blur` / `backdrop-blur` / `edge-fade`
 * @param {'add'|'set'|'remove'|'reset'|'toggle'} action
 * @param {any} [params]
 * @returns {{ok: true, patch: {style: Record<string, string>}, note?: string, unchanged?: boolean}
 *   | {ok: false, error: {code: string, message: string}}}
 */
export function effectPatch(css, kind, action, params) {
  const def = EFFECT_DEFS.find((item) => item.kind === kind);
  if (def === undefined) return { ok: false, error: { code: 'NOT_EDITABLE', message: `不是效果：${kind}` } };
  const label = def.label;

  if (kind === 'edge-fade') return fadePatch(css, action, params);

  const current = readEffect(css, kind);
  /* 手写（custom）：只允许整条删除（且删的是我们认得出的函数，见下）；其余动作拒绝，
     绝不把「看不懂的值」当成空值覆写（那正是会误删 Agent 手写效果的做法）。 */
  if (current.state === 'custom' && action !== 'remove' && action !== 'toggle') {
    return {
      ok: false,
      error: { code: 'EFFECT_CUSTOM', message: `${label}是手写的，无法结构化：请到「滤镜 / 高级」里改原文` }
    };
  }

  if (kind === 'drop-shadow' || kind === 'blur' || kind === 'backdrop-blur') {
    const key = kind === 'drop-shadow' ? 'filter' : kind === 'blur' ? 'filter' : 'backdrop-filter';
    const source = key === 'filter' ? css.filter : css.backdropFilter;
    const parsed = parseFilterFunctions(source);
    if (!parsed.ok) {
      return { ok: false, error: { code: 'FILTER_CUSTOM', message: '当前滤镜是手写的（解析不了）：请到「滤镜」里改原文' } };
    }
    const fnName = kind === 'drop-shadow' ? 'drop-shadow' : 'blur';
    const funcs = parsed.funcs.map((fn) => ({ ...fn }));
    const indexes = funcs.map((fn, i) => (fn.name === fnName ? i : -1)).filter((i) => i >= 0);
    const present = indexes.length > 0;

    if (action === 'remove' || (action === 'toggle' && present)) {
      for (let i = funcs.length - 1; i >= 0; i -= 1) {
        if (funcs[i]?.name === fnName) funcs.splice(i, 1);
      }
      return { ok: true, patch: { style: { [key]: joinFunctions(funcs) } }, note: `已去掉${label}` };
    }
    if (action === 'add' && present) {
      return { ok: true, patch: { style: {} }, unchanged: true, note: `${label}已经在了` };
    }
    if (action === 'reset' && present) {
      /* 重置 = 回到默认参数（只重写我们自己这一条函数）。 */
      const raw = kind === 'drop-shadow' ? dropShadowCss(defaultOf('drop-shadow')) : `blur(${fmt(Number(defaultOf(kind).value))}px)`;
      funcs[indexes[0] ?? 0] = { name: fnName, arg: argsOf(raw), raw };
      for (let i = indexes.length - 1; i >= 1; i -= 1) funcs.splice(indexes[i] ?? 0, 1);
      return { ok: true, patch: { style: { [key]: joinFunctions(funcs) } }, note: `${label}已重置为默认` };
    }
    if (action === 'set' || action === 'add' || action === 'reset' || action === 'toggle') {
      const raw = kind === 'drop-shadow'
        ? dropShadowCss(params ?? EFFECT_DEFAULTS['drop-shadow'])
        : `blur(${fmt(clampBlur(params?.value ?? defaultOf(kind).value))}px)`;
      if (present) funcs[indexes[0] ?? 0] = { name: fnName, arg: argsOf(raw), raw };
      else if (kind === 'blur') {
        /* 图层模糊排在 drop-shadow **之前**（同 filter 内固定次序：调色 → 模糊 → 投影）。 */
        const cut = funcs.findIndex((fn) => fn.name === 'drop-shadow');
        funcs.splice(cut < 0 ? funcs.length : cut, 0, { name: fnName, arg: argsOf(raw), raw });
      } else funcs.push({ name: fnName, arg: argsOf(raw), raw });
      return { ok: true, patch: { style: { [key]: joinFunctions(funcs) } }, note: `${label}已${present ? '更新' : '添加'}` };
    }
    return { ok: false, error: { code: 'INVALID_ACTION', message: `不认识的动作：${action}` } };
  }

  if (kind === 'inset-shadow') {
    const parts = splitTopLevel(String(css.boxShadow ?? ''));
    /* 与 readEffect 同一条判法：inset 可以在尾（Chromium 计算值），别只认前导。 */
    /** @param {string} part */
    const isInset = (part) => /(^|\s)inset(\s|$)/i.test(part);
    const others = parts.filter((part) => !isInset(part));
    const insets = parts.filter((part) => isInset(part));
    const present = insets.length > 0;
    if (action === 'remove' || (action === 'toggle' && present)) {
      const next = others.length === 0 ? 'none' : others.join(', ');
      return { ok: true, patch: { style: { 'box-shadow': next } }, note: `已去掉${label}` };
    }
    const raw = insetShadowCss(action === 'reset' ? defaultOf('inset-shadow') : params ?? defaultOf('inset-shadow'));
    const next = [...insets, ...others];
    if (present) next[0] = raw;
    else next.unshift(raw);
    /* 内阴影排在**前面**（与面板顺序一致），外阴影原样跟在后面。 */
    return {
      ok: true,
      patch: { style: { 'box-shadow': next.join(', ') } },
      note: `${def.label}已${present ? '更新' : '添加'}`
    };
  }

  return { ok: false, error: { code: 'NOT_EDITABLE', message: `不是效果：${kind}` } };
}

function clampBlur(/** @type {any} */ value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 4;
  return Math.min(1000, Math.max(0, n));
}

/**
 * 四边渐隐：把作者其它蒙版原样留着，只增删我们自己那几层 `linear-gradient`。
 * @param {{maskImage?: unknown}} css
 * @param {'add'|'set'|'remove'|'reset'|'toggle'} action
 * @param {any} [params] `{edges:{top,right,bottom,left}}` 或 `{edge:'top', value:12}`
 * @returns {{ok: true, patch: {style: Record<string, string>}, note?: string, unchanged?: boolean}
 *   | {ok: false, error: {code: string, message: string}}}
 */
function fadePatch(css, action, params) {
  const label = EFFECT_DEFS.find((item) => item.kind === 'edge-fade')?.label ?? '四边渐隐';
  const layers = splitTopLevel(String(css.maskImage ?? ''));
  /** @type {string[]} */
  const foreign = [];
  /** @type {Record<string, number>} */
  let edges = {};
  for (const layer of layers) {
    const hit = FADE_RE.exec(layer);
    if (hit === null) {
      foreign.push(layer);
      continue;
    }
    const edge = FADE_DIRECTION_EDGE[/** @type {'top'|'bottom'|'left'|'right'} */ (hit[1])];
    if (edge !== undefined) edges[edge] = Number(hit[2]);
  }
  const current = { ...edges };
  /** @type {Record<string, number>} */
  let next = {};
  if (action === 'remove') {
    next = {};
  } else if (action === 'reset') {
    next = { .../** @type {any} */ (EFFECT_DEFAULTS['edge-fade'].edges) };
  } else if (action === 'toggle') {
    /* R121 · M7-A：停用 = 有边就全关、无边就回默认。
       必须排在 `params` 分支**之前**：面板点「停用」时会把当前参数一起带过来
       （`paramsOf(field)` = `{edges:{…}}`），先走 params 就变成「重写同样的值」——
       实测提示变了、文档一字节没改、像素 0 差，停用按钮看起来失灵。 */
    next = Object.keys(current).length > 0 ? {} : { .../** @type {any} */ (EFFECT_DEFAULTS['edge-fade'].edges) };
  } else if (params && typeof params === 'object' && params.edge !== undefined) {
    /* 单边改：其余边保留。 */
    const edge = String(params.edge);
    if (!FADE_EDGES.includes(/** @type {any} */ (edge))) {
      return { ok: false, error: { code: 'INVALID_VALUE', message: `不是四边之一：${edge}` } };
    }
    next = { ...current };
    const raw = Number(params.value);
    if (!Number.isFinite(raw)) {
      return { ok: false, error: { code: 'INVALID_VALUE', message: `渐隐强度需要数字（收到「${String(params.value)}」）` } };
    }
    if (raw === 0) delete next[edge];
    else if (raw < FADE_MIN || raw > FADE_MAX) {
      return {
        ok: false,
        error: { code: 'INVALID_VALUE', message: `渐隐强度必须在 ${FADE_MIN}..${FADE_MAX}%（收到 ${raw}）；0 = 关掉这一边` }
      };
    } else next[edge] = Math.round(raw * 100) / 100;
  } else if (params && typeof params === 'object' && params.edges) {
    for (const edge of FADE_EDGES) {
      const raw = Number((params.edges ?? {})[edge] ?? 0);
      if (raw > 0) next[edge] = Math.min(FADE_MAX, Math.max(FADE_MIN, raw));
    }
  } else {
    next = { .../** @type {any} */ (EFFECT_DEFAULTS['edge-fade'].edges) };
  }

  const ours = FADE_EDGES.filter((edge) => Number(next[edge]) > 0).map((edge) => fadeLayer(edge, Number(next[edge])));
  const all = [...ours, ...foreign];
  /** @type {Record<string, string>} */
  const style = {};
  if (all.length === 0) {
    style['mask-image'] = 'none';
  } else {
    style['mask-image'] = all.join(', ');
    if (all.length > 1) {
      /* 多层蒙版：第一层 add，其余 intersect（交集 = 每条边都真的渐隐）。 */
      style['mask-composite'] = ['add', ...all.slice(1).map(() => 'intersect')].join(', ');
    }
  }
  const count = Object.keys(next).length;
  return {
    ok: true,
    patch: { style },
    note: count === 0 ? `${label}已关闭` : `${label}：${count} 边`
  };
}

/* ────────────────────────── 混合模式能力矩阵 ────────────────────────── */

/**
 * 17 种混合模式（参考 `cM` 的固定枚举 + 中文名）。
 *
 * 顺序与参考一致：正常 / 正片叠底 / 滤色 / 叠加 / 变暗 / 变亮 / 相加 / 颜色减淡 / 颜色加深 /
 * 柔光 / 强光 / 差值 / 排除 / 色相 / 饱和度 / 颜色 / 明度。
 */
export const BLEND_ITEMS = Object.freeze([
  Object.freeze({ mode: 'normal', label: '正常' }),
  Object.freeze({ mode: 'multiply', label: '正片叠底' }),
  Object.freeze({ mode: 'screen', label: '滤色' }),
  Object.freeze({ mode: 'overlay', label: '叠加' }),
  Object.freeze({ mode: 'darken', label: '变暗' }),
  Object.freeze({ mode: 'lighten', label: '变亮' }),
  Object.freeze({ mode: 'plus-lighter', label: '相加' }),
  Object.freeze({ mode: 'color-dodge', label: '颜色减淡' }),
  Object.freeze({ mode: 'color-burn', label: '颜色加深' }),
  Object.freeze({ mode: 'soft-light', label: '柔光' }),
  Object.freeze({ mode: 'hard-light', label: '强光' }),
  Object.freeze({ mode: 'difference', label: '差值' }),
  Object.freeze({ mode: 'exclusion', label: '排除' }),
  Object.freeze({ mode: 'hue', label: '色相' }),
  Object.freeze({ mode: 'saturation', label: '饱和度' }),
  Object.freeze({ mode: 'color', label: '颜色' }),
  Object.freeze({ mode: 'luminosity', label: '明度' })
]);

/**
 * 逐项能力矩阵。
 *
 * 三种能力，**不是**同一种「支持」：
 * - `visible`：当前合成器真实可见（`CSS.supports` 通过；预览与导出同一个 Chromium，所以同源）；
 * - `passthrough`：浏览器不支持这个值 → CSS 会整条忽略，画面等同 normal（**不能假装能用**）；
 * - `needs-backdrop`：合成器支持，但下层没有内容时看不出差别（在空背景上等同 normal）。
 *   这是「看起来没生效」的最常见误会，所以单列一档，并在选项文案里写清。
 *
 * @param {(property: string, value: string) => boolean} [supports] 浏览器侧传 `CSS.supports`；
 *   纯函数测试/Node 侧不传 → 按 Chromium 140 的能力表（全部 true）。
 */
export function blendMatrix(supports) {
  const check = typeof supports === 'function' ? supports : null;
  return BLEND_ITEMS.map((item) => {
    const supported = item.mode === 'normal' ? true : check === null ? true : check('mix-blend-mode', item.mode);
    const capability = supported ? (item.mode === 'normal' ? 'visible' : 'needs-backdrop') : 'passthrough';
    return {
      mode: item.mode,
      label: item.label,
      supported,
      capability,
      note: capability === 'passthrough'
        ? '本机合成器不支持：写了也不会生效（等同正常）'
        : capability === 'needs-backdrop'
          ? '需要下层有内容：空背景上等同正常'
          : '与下层像素合成'
    };
  });
}
