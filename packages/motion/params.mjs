/**
 * 组件参数 schema 与校验（副线1 · S5-WP15）
 *
 * 两件事分开：
 * - `validateSchema` 看**模板作者**写的参数声明对不对（类型、默认值、范围自洽）→ `INVALID_SCHEMA`
 * - `validateParams` 看**某个实例**给的值对不对（类型、范围、枚举、未知键）→ `INVALID_PARAM`
 *
 * 校验失败**绝不静默丢键**：未知键、类型错、越界、缺省且无默认值，全部逐条报出来，
 * 调用方拿不到 `values`，因此也不可能把半份参数写进覆盖。
 *
 * `apply` 说明参数落到哪：默认是该实例根节点上的 CSS 自定义属性 `--<key>`；
 * 也可以声明 `text`（改某个后代节点的文本）或 `attr`（布尔开关）。
 */

/**
 * @typedef {{kind: 'css-var', name: string}
 *   | {kind: 'text', selector: string}
 *   | {kind: 'attr', name: string}} ParamApply
 */

/**
 * @typedef {object} NumberSpec
 * @property {'number'} type
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 * @property {boolean} [integer]
 * @property {number} [default]
 * @property {string} [label]
 * @property {ParamApply} [apply]
 */

/**
 * @typedef {object} StringSpec
 * @property {'string'} type
 * @property {number} [maxLength]
 * @property {string} [default]
 * @property {string} [label]
 * @property {ParamApply} [apply]
 */

/**
 * @typedef {object} BooleanSpec
 * @property {'boolean'} type
 * @property {boolean} [default]
 * @property {string} [label]
 * @property {ParamApply} [apply]
 */

/**
 * @typedef {object} ColorSpec
 * @property {'color'} type
 * @property {string} [default]
 * @property {string} [label]
 * @property {ParamApply} [apply]
 */

/**
 * @typedef {object} EnumSpec
 * @property {'enum'} type
 * @property {readonly string[]} options
 * @property {string} [default]
 * @property {string} [label]
 * @property {ParamApply} [apply]
 */

/** @typedef {NumberSpec | StringSpec | BooleanSpec | ColorSpec | EnumSpec} ParamSpec */
/** @typedef {Record<string, ParamSpec>} ParamSchema */
/** @typedef {Record<string, string | number | boolean>} ParamValues */

/**
 * @typedef {object} ParamIssue
 * @property {string} key
 * @property {string} reason
 * @property {string} [detail]
 */

/** @typedef {{ok: true, values: ParamValues, defaultsApplied: string[]} | {ok: false, code: 'INVALID_PARAM' | 'INVALID_SCHEMA', errors: ParamIssue[]}} ParamResult */

const TYPES = new Set(['number', 'string', 'boolean', 'color', 'enum']);
const MAX_STRING = 500;

/** 颜色只接受能安全写进自定义属性的写法：十六进制、rgb()/rgba()、hsl()/hsla()、关键字。 */
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgba?\(\s*[\d.%]+\s*,\s*[\d.%]+\s*,\s*[\d.%]+\s*(?:,\s*(?:[\d.]+%?)\s*)?\)$/i;
const HSL = /^hsla?\(\s*-?[\d.]+(?:deg|turn|rad)?\s*,\s*[\d.]+%\s*,\s*[\d.]+%\s*(?:,\s*[\d.]+%?\s*)?\)$/i;
const KEYWORD = /^[a-z]{3,24}$/;
const IDENT = /^[A-Za-z_][\w-]{0,63}$/;

/**
 * 校验模板声明的 schema 自身。
 * @param {unknown} schema
 * @returns {{ok: true} | {ok: false, code: 'INVALID_SCHEMA', errors: ParamIssue[]}}
 */
export function validateSchema(schema) {
  /** @type {ParamIssue[]} */
  const errors = [];
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return { ok: false, code: 'INVALID_SCHEMA', errors: [{ key: '', reason: 'SCHEMA_NOT_OBJECT' }] };
  }
  for (const [key, spec] of Object.entries(/** @type {Record<string, unknown>} */ (schema))) {
    if (!IDENT.test(key)) {
      errors.push({ key, reason: 'BAD_KEY', detail: '参数键只允许字母数字下划线，且不能以数字开头' });
      continue;
    }
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
      errors.push({ key, reason: 'SPEC_NOT_OBJECT' });
      continue;
    }
    const s = /** @type {Record<string, unknown>} */ (spec);
    const type = s.type;
    if (typeof type !== 'string' || !TYPES.has(type)) {
      errors.push({ key, reason: 'BAD_TYPE', detail: String(type) });
      continue;
    }
    if (type === 'number') {
      const min = typeof s.min === 'number' ? s.min : undefined;
      const max = typeof s.max === 'number' ? s.max : undefined;
      const def = typeof s.default === 'number' ? s.default : undefined;
      if (s.min !== undefined && !isFiniteNumber(s.min)) errors.push({ key, reason: 'BAD_MIN' });
      if (s.max !== undefined && !isFiniteNumber(s.max)) errors.push({ key, reason: 'BAD_MAX' });
      if (min !== undefined && max !== undefined && min > max) errors.push({ key, reason: 'MIN_ABOVE_MAX' });
      if (s.default !== undefined) {
        if (def === undefined) errors.push({ key, reason: 'BAD_DEFAULT' });
        else if (min !== undefined && def < min) errors.push({ key, reason: 'DEFAULT_BELOW_MIN' });
        else if (max !== undefined && def > max) errors.push({ key, reason: 'DEFAULT_ABOVE_MAX' });
      }
      if (s.integer !== undefined && typeof s.integer !== 'boolean') errors.push({ key, reason: 'BAD_INTEGER_FLAG' });
      if (s.step !== undefined && !(isFiniteNumber(s.step) && s.step > 0)) errors.push({ key, reason: 'BAD_STEP' });
    } else if (type === 'string') {
      const rawMaxLength = s.maxLength;
      const maxLength = typeof rawMaxLength === 'number' && Number.isInteger(rawMaxLength) && rawMaxLength > 0 ? rawMaxLength : undefined;
      if (rawMaxLength !== undefined && maxLength === undefined) {
        errors.push({ key, reason: 'BAD_MAX_LENGTH' });
      }
      if (s.default !== undefined && typeof s.default !== 'string') errors.push({ key, reason: 'BAD_DEFAULT' });
      else if (maxLength !== undefined && typeof s.default === 'string' && s.default.length > maxLength) {
        /* 默认值比上限还长：装得进去、一编辑就非法（R16-C1）。不许静默截断。 */
        errors.push({ key, reason: 'DEFAULT_TOO_LONG', detail: `${s.default.length} > ${maxLength}` });
      }
    } else if (type === 'boolean') {
      if (s.default !== undefined && typeof s.default !== 'boolean') errors.push({ key, reason: 'BAD_DEFAULT' });
    } else if (type === 'color') {
      const def = s.default;
      if (def !== undefined && (typeof def !== 'string' || !isColor(def))) {
        errors.push({ key, reason: 'BAD_DEFAULT' });
      }
    } else {
      const options = s.options;
      if (!Array.isArray(options) || options.length === 0 || !options.every((o) => typeof o === 'string')) {
        errors.push({ key, reason: 'BAD_OPTIONS' });
      } else if (typeof s.default === 'string' && !options.includes(s.default)) {
        errors.push({ key, reason: 'DEFAULT_NOT_IN_OPTIONS' });
      } else if (s.default !== undefined && typeof s.default !== 'string') {
        errors.push({ key, reason: 'BAD_DEFAULT' });
      }
    }
    if (s.apply !== undefined) {
      const apply = /** @type {Record<string, unknown>} */ (s.apply);
      const kind = apply.kind;
      if (kind !== 'css-var' && kind !== 'text' && kind !== 'attr') {
        errors.push({ key, reason: 'BAD_APPLY_KIND' });
      } else if (kind === 'text') {
        if (typeof apply.selector !== 'string' || !apply.selector.trim()) errors.push({ key, reason: 'BAD_APPLY_SELECTOR' });
      } else if (typeof apply.name !== 'string' || !apply.name.trim()) {
        errors.push({ key, reason: 'BAD_APPLY_NAME' });
      }
    }
  }
  return errors.length ? { ok: false, code: 'INVALID_SCHEMA', errors } : { ok: true };
}

/**
 * 校验一个实例给的参数值，并补默认值。
 *
 * 有任何一个问题就整体失败：**不返回 values**，所以调用方无从把非法参数写进覆盖或落盘。
 *
 * @param {ParamSchema} schema
 * @param {unknown} [values]
 * @returns {ParamResult}
 */
export function validateParams(schema, values) {
  const schemaCheck = validateSchema(schema);
  if (!schemaCheck.ok) {
    return { ok: false, code: 'INVALID_SCHEMA', errors: schemaCheck.errors };
  }
  /** @type {ParamIssue[]} */
  const errors = [];
  /** @type {ParamValues} */
  const out = {};
  /** @type {string[]} */
  const defaultsApplied = [];

  if (values !== undefined && (values === null || typeof values !== 'object' || Array.isArray(values))) {
    return { ok: false, code: 'INVALID_PARAM', errors: [{ key: '', reason: 'VALUES_NOT_OBJECT' }] };
  }
  const given = /** @type {Record<string, unknown>} */ (values ?? {});

  for (const key of Object.keys(given)) {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) {
      errors.push({ key, reason: 'UNKNOWN_PARAM' });
    }
  }

  for (const [key, spec] of Object.entries(schema)) {
    const has = Object.prototype.hasOwnProperty.call(given, key);
    const raw = has ? given[key] : undefined;
    if (!has) {
      const def = defaultOf(spec);
      if (def === undefined) {
        errors.push({ key, reason: 'MISSING_PARAM' });
      } else {
        out[key] = def;
        defaultsApplied.push(key);
      }
      continue;
    }
    const checked = checkValue(key, spec, raw);
    if (checked.ok) out[key] = checked.value;
    else errors.push(checked.issue);
  }

  if (errors.length) return { ok: false, code: 'INVALID_PARAM', errors };
  return { ok: true, values: out, defaultsApplied };
}

/**
 * @param {ParamSpec} spec
 * @returns {string | number | boolean | undefined}
 */
export function defaultOf(spec) {
  if (spec.type === 'number') return spec.default;
  if (spec.type === 'string') return spec.default;
  if (spec.type === 'boolean') return spec.default;
  if (spec.type === 'color') return spec.default;
  return spec.default;
}

/**
 * 参数的落点：默认是该实例根上的 CSS 自定义属性。
 * @param {string} key
 * @param {ParamSpec} spec
 * @returns {ParamApply}
 */
export function applyOf(key, spec) {
  const apply = spec.apply;
  if (!apply) return { kind: 'css-var', name: `--${key}` };
  if (apply.kind === 'text') return { kind: 'text', selector: apply.selector };
  if (apply.kind === 'attr') return { kind: 'attr', name: apply.name };
  return { kind: 'css-var', name: apply.name };
}

/**
 * 把参数值变成实例根/后代的覆盖条目（结构化，不是字符串拼 CSS）。
 * `rootAt` 是实例根在宿主页里的选择器（例如 `[data-instance="clip-a"]`）。
 * @param {ParamSchema} schema
 * @param {ParamValues} values
 * @param {string} rootAt
 * @returns {{at: string, style?: Record<string, string>, t?: string}[]}
 */
export function overridesOf(schema, values, rootAt) {
  /** @type {{at: string, style?: Record<string, string>, t?: string}[]} */
  const out = [];
  /** @type {Record<string, string>} */
  const vars = {};
  /** @type {{at: string, t: string}[]} */
  const texts = [];
  for (const [key, spec] of Object.entries(schema)) {
    const value = values[key];
    if (value === undefined) continue;
    const apply = applyOf(key, spec);
    if (apply.kind === 'css-var') {
      vars[apply.name] = cssValue(value, spec);
    } else if (apply.kind === 'text') {
      /* 键名用 `t`：这是 `OverrideEntry` 里检查器（inspector-fields 的 `{text:{t}}`）与
         `apply-overrides` 都认的那个；写成 `text` 的话落不了 DOM（S29 修掉的接缝）。 */
      texts.push({ at: `${rootAt} ${apply.selector}`, t: String(value) });
    } else {
      /* 布尔开关：真值写属性，假值不写（缺省即关） */
      if (value === true) vars[apply.name] = '1';
    }
  }
  if (Object.keys(vars).length) out.push({ at: rootAt, style: vars });
  for (const entry of texts) out.push({ at: entry.at, t: entry.t });
  return out;
}

/**
 * 参数值 → CSS 值。数字带单位时由模板自己的 `calc()` 决定，这里只写裸数字。
 * @param {string | number | boolean} value
 * @param {ParamSpec} spec
 * @returns {string}
 */
function cssValue(value, spec) {
  if (spec.type === 'boolean') return value === true ? '1' : '0';
  if (spec.type === 'number') return String(Number(value));
  return String(value);
}

/**
 * @param {string} key
 * @param {ParamSpec} spec
 * @param {unknown} raw
 * @returns {{ok: true, value: string | number | boolean} | {ok: false, issue: ParamIssue}}
 */
function checkValue(key, spec, raw) {
  if (spec.type === 'number') {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return { ok: false, issue: { key, reason: 'TYPE', detail: 'number' } };
    }
    if (spec.integer === true && !Number.isInteger(raw)) {
      return { ok: false, issue: { key, reason: 'NOT_INTEGER', detail: String(raw) } };
    }
    if (spec.min !== undefined && raw < spec.min) {
      return { ok: false, issue: { key, reason: 'BELOW_MIN', detail: `${raw} < ${spec.min}` } };
    }
    if (spec.max !== undefined && raw > spec.max) {
      return { ok: false, issue: { key, reason: 'ABOVE_MAX', detail: `${raw} > ${spec.max}` } };
    }
    if (spec.step !== undefined) {
      const base = spec.min ?? 0;
      const k = (raw - base) / spec.step;
      if (Math.abs(k - Math.round(k)) > 1e-9) {
        return { ok: false, issue: { key, reason: 'NOT_ON_STEP', detail: `${raw} 不在 step=${spec.step} 上` } };
      }
    }
    return { ok: true, value: raw };
  }
  if (spec.type === 'string') {
    if (typeof raw !== 'string') return { ok: false, issue: { key, reason: 'TYPE', detail: 'string' } };
    const max = spec.maxLength ?? MAX_STRING;
    if (raw.length > max) {
      return { ok: false, issue: { key, reason: 'TOO_LONG', detail: `${raw.length} > ${max}` } };
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(raw)) {
      return { ok: false, issue: { key, reason: 'CONTROL_CHARS' } };
    }
    return { ok: true, value: raw };
  }
  if (spec.type === 'boolean') {
    if (typeof raw !== 'boolean') return { ok: false, issue: { key, reason: 'TYPE', detail: 'boolean' } };
    return { ok: true, value: raw };
  }
  if (spec.type === 'color') {
    if (typeof raw !== 'string') return { ok: false, issue: { key, reason: 'TYPE', detail: 'color' } };
    if (!isColor(raw)) return { ok: false, issue: { key, reason: 'BAD_COLOR', detail: raw } };
    return { ok: true, value: raw };
  }
  if (!spec.options.includes(/** @type {string} */ (raw))) {
    return { ok: false, issue: { key, reason: 'NOT_IN_OPTIONS', detail: String(raw) } };
  }
  return { ok: true, value: /** @type {string} */ (raw) };
}

/**
 * 颜色是否合法（与 `validateSchema` 里用的是同一个判定）。
 * @param {string} value
 * @returns {boolean}
 */
export function isValidColor(value) {
  return isColor(value);
}

/** @param {string} value */
function isColor(value) {
  const v = value.trim();
  return HEX.test(v) || RGB.test(v) || HSL.test(v) || KEYWORD.test(v);
}

/** @param {unknown} v @returns {v is number} */
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 人可读的失败摘要（UI 与诊断共用同一句，不各写一套）。
 * @param {ParamIssue[]} errors
 */
export function describeIssues(errors) {
  return errors.map((e) => (e.key ? `${e.key}: ${e.reason}${e.detail ? ` (${e.detail})` : ''}` : e.reason)).join('; ');
}

export const PARAM_TYPES = Object.freeze([...TYPES]);
