/**
 * 模板候选控件发现（副线1 · S32-MOTION-CONTROL-DISCOVERY / 计划 SC-010）
 *
 * ## 为什么要有它
 *
 * 每条新模板都要手写一遍 `params`，写错了要到用的时候才发现（面板空表单 / 参数落不下去）。
 * 这里让模板**自己声明**参数：元素上写 `data-motion-param="<key>"` 加若干可选属性，
 * `discoverControls(html)` 直接产出与手写 schema **同形**的 `ParamSchema`，能直接喂面板。
 *
 * ## 标注约定
 *
 * | 属性 | 含义 |
 * | --- | --- |
 * | `data-motion-param` | 参数键（必填，同一个模板里唯一） |
 * | `data-motion-type` | `number`/`enum`/`boolean`/`color`/`string`；不写按元素推 |
 * | `data-motion-label` | 显示名；不写用键名 |
 * | `data-motion-min` / `-max` / `-step` / `-integer` | number 用 |
 * | `data-motion-maxlength` | string 用 |
 * | `data-motion-options` | enum 用，逗号分隔 |
 * | `data-motion-default` | 默认值；**文本参数不写时取元素文本** |
 * | `data-motion-apply` | `text` → 改该元素文本（选择器从 id/class 推）；不写 = 实例根的 CSS 变量 |
 *
 * 类型推断（没写 `data-motion-type`）：`input[type=range|number]`→number、
 * `input[type=color]`→color、`input[type=checkbox]`→boolean、`select`→enum、其余 string。
 *
 * 多条 css-var 参数没法挤在同一个元素上（一个元素只能有一个 `data-motion-param`），
 * 所以模板里用一个 `<div data-motion-decls hidden>` 装声明项；它不渲染、不参与布局。
 *
 * ## 纯函数
 *
 * `discoverControls` 只吃字符串，**不碰 DOM 全局**（不上 jsdom）：自带一个容错分词器，
 * 注释 / `<script>` / `<style>` / 自闭合 / 属性引号都能处理。解析不了就给 `PARSE_FAILED`，
 * 不静默返回半份。
 *
 * ## 合并
 *
 * `mergeParams(handwritten, discovered)`：**手写优先**，标注只补手写没有的键，
 * 两边同键但内容不同 → 记 `MERGE_CONFLICT`（不静默丢）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { validateSchema } from './params.mjs';

/** 稳定的错误码（宿主/CI 按码判断，不解析人话）。 */
export const DISCOVERY_ERROR_CODES = Object.freeze({
  PARSE_FAILED: 'PARSE_FAILED',
  DUPLICATE_PARAM: 'DUPLICATE_PARAM',
  UNKNOWN_TYPE: 'UNKNOWN_TYPE',
  ENUM_NO_OPTIONS: 'ENUM_NO_OPTIONS',
  BAD_DEFAULT: 'BAD_DEFAULT',
  BAD_RANGE: 'BAD_RANGE',
  MERGE_CONFLICT: 'MERGE_CONFLICT',
  SOURCE_MISSING: 'SOURCE_MISSING'
});

/** 属性名（宿主写文档/工具时照这个，别各写一份）。 */
export const MOTION_ATTRS = Object.freeze({
  param: 'data-motion-param',
  type: 'data-motion-type',
  label: 'data-motion-label',
  min: 'data-motion-min',
  max: 'data-motion-max',
  step: 'data-motion-step',
  integer: 'data-motion-integer',
  maxLength: 'data-motion-maxlength',
  options: 'data-motion-options',
  default: 'data-motion-default',
  apply: 'data-motion-apply',
  decls: 'data-motion-decls'
});

const TYPES = new Set(['number', 'string', 'boolean', 'color', 'enum']);
const BOOLEAN_TRUE = new Set(['true', '1', 'yes', 'on', '']);
const BOOLEAN_FALSE = new Set(['false', '0', 'no', 'off']);

/**
 * @typedef {import('./params.mjs').ParamSpec} ParamSpec
 * @typedef {import('./params.mjs').ParamSchema} ParamSchema
 */

/**
 * @typedef {object} DiscoveryIssue
 * @property {string} code
 * @property {string} key
 * @property {number} line
 * @property {string} detail
 * @property {'TYPE'|'RANGE'|'OTHER'} [conflict] 仅 MERGE_CONFLICT 有：冲突属于哪一类
 */

/**
 * @typedef {object} ParsedTag
 * @property {string} name
 * @property {Record<string, string>} attrs
 * @property {number} index   起始偏移
 * @property {string} textAfter 标签之后、下一个 `<` 之前的那段文本（trim 过）
 */

/** @param {string} text @param {number} index */
function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

/**
 * 容错分词：只取开始标签（属性表 + 标签后文本）。
 * 注释、`<!doctype>`、`<script>`/`<style>` 内容跳过；结束标签当作文本跳过。
 *
 * @param {string} html
 * @returns {{tags: ParsedTag[], error: {index: number, detail: string}|null}}
 */
export function tokenizeTags(html) {
  /** @type {ParsedTag[]} */
  const tags = [];
  const lower = html.toLowerCase();
  const n = html.length;
  let i = 0;

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end < 0) return { tags, error: { index: lt, detail: '注释没有闭合（`<!--` 缺 `-->`）' } };
      i = end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt);
      if (end < 0) return { tags, error: { index: lt, detail: '标记声明没有闭合' } };
      i = end + 1;
      continue;
    }
    const nameMatch = /^<([A-Za-z][\w:-]*)/.exec(html.slice(lt, lt + 80));
    if (!nameMatch) {
      /* 文本里的 `<`（例如 `a < b`）：当字符跳过，不报错 */
      i = lt + 1;
      continue;
    }
    const name = (nameMatch[1] ?? '').toLowerCase();
    let p = lt + nameMatch[0].length;
    /** @type {Record<string, string>} */
    const attrs = {};
    let closed = false;

    while (p < n) {
      while (p < n && /\s/.test(html.charAt(p))) p += 1;
      if (p >= n) break;
      const ch = html.charAt(p);
      if (ch === '>') {
        p += 1;
        closed = true;
        break;
      }
      if (ch === '/' && html.charAt(p + 1) === '>') {
        p += 2;
        closed = true;
        break;
      }
      const attrMatch = /^[^\s=/>]+/.exec(html.slice(p));
      if (!attrMatch) {
        p += 1;
        continue;
      }
      const attrName = attrMatch[0].toLowerCase();
      p += attrMatch[0].length;
      while (p < n && /\s/.test(html.charAt(p))) p += 1;
      if (html.charAt(p) !== '=') {
        attrs[attrName] = '';
        continue;
      }
      p += 1;
      while (p < n && /\s/.test(html.charAt(p))) p += 1;
      const quote = html.charAt(p);
      if (quote === '"' || quote === "'") {
        const end = html.indexOf(quote, p + 1);
        if (end < 0) return { tags, error: { index: p, detail: `属性 ${attrName} 的引号没有闭合` } };
        attrs[attrName] = html.slice(p + 1, end);
        p = end + 1;
      } else {
        const unquoted = /^[^\s>]*/.exec(html.slice(p));
        const value = unquoted ? unquoted[0] : '';
        attrs[attrName] = value;
        p += value.length;
      }
    }

    if (!closed) return { tags, error: { index: lt, detail: `<${name}> 标签没有闭合` } };

    const next = html.indexOf('<', p);
    const textAfter = html.slice(p, next < 0 ? n : next).trim();
    tags.push({ name, attrs, index: lt, textAfter });

    /* 原始文本元素：内容里的 `<` 不是标签，跳到结束标签 */
    if (name === 'script' || name === 'style' || name === 'template') {
      const close = lower.indexOf(`</${name}`, p);
      if (close < 0) return { tags, error: { index: lt, detail: `<${name}> 没有结束标签` } };
      i = close;
    } else {
      i = p;
    }
  }
  return { tags, error: null };
}

/** @param {ParsedTag} tag */
function inferType(tag) {
  const type = (tag.attrs.type ?? '').trim().toLowerCase();
  if (tag.name === 'input') {
    if (type === 'range' || type === 'number') return 'number';
    if (type === 'color') return 'color';
    if (type === 'checkbox') return 'boolean';
    return 'string';
  }
  if (tag.name === 'select') return 'enum';
  return 'string';
}

/** 文本参数的落点：`#id` → `.第一个 class`；都没有就没法唯一定位。
 * @param {ParsedTag} tag
 */
function selectorOf(tag) {
  const id = (tag.attrs.id ?? '').trim();
  if (id) return `#${id}`;
  const cls = (tag.attrs.class ?? '').trim().split(/\s+/).filter(Boolean)[0];
  if (cls) return `.${cls}`;
  return '';
}

/**
 * `validateSchema` 的 reason → 发现器的码。
 *
 * 为什么要翻译而不是直接把 reason 抛出去：面板/CI 按**发现器的码**分支，
 * 而 params.mjs 的 reason 是给「改模板的人」看的细节。两层各司其职。
 */
const DOMAIN_REASON_MAP = Object.freeze({
  DEFAULT_BELOW_MIN: DISCOVERY_ERROR_CODES.BAD_DEFAULT,
  DEFAULT_ABOVE_MAX: DISCOVERY_ERROR_CODES.BAD_DEFAULT,
  DEFAULT_NOT_IN_OPTIONS: DISCOVERY_ERROR_CODES.BAD_DEFAULT,
  DEFAULT_TOO_LONG: DISCOVERY_ERROR_CODES.BAD_DEFAULT,
  BAD_DEFAULT: DISCOVERY_ERROR_CODES.BAD_DEFAULT,
  MIN_ABOVE_MAX: DISCOVERY_ERROR_CODES.BAD_RANGE,
  BAD_STEP: DISCOVERY_ERROR_CODES.BAD_RANGE,
  BAD_MAX_LENGTH: DISCOVERY_ERROR_CODES.BAD_RANGE
});

/**
 * 值域校验：把「能不能解析」之外的第四条也算上——**值在不在域内**。
 *
 * 规则本身不在这里写一遍：交给 `params.mjs` 的 `validateSchema`（与库校验、应用校验同一套）。
 * 这里只把 reason 翻成发现器的码。**不做静默夹紧**：越界就 `ok:false`，让作者去改数字。
 *
 * @param {string} key
 * @param {unknown} spec
 * @returns {{code: string, detail: string}[]}
 */
export function checkSpecDomain(key, spec) {
  const result = validateSchema({ [key]: spec });
  if (result.ok) return [];
  return result.errors.map((issue) => ({
    code: /** @type {Record<string, string>} */ (DOMAIN_REASON_MAP)[issue.reason] ?? DISCOVERY_ERROR_CODES.BAD_RANGE,
    detail: `${issue.reason}${issue.detail ? `：${issue.detail}` : ''}`
  }));
}

/** @param {string|undefined} raw */
function parseBoolean(raw) {
  const value = (raw ?? '').trim().toLowerCase();
  if (BOOLEAN_TRUE.has(value)) return true;
  if (BOOLEAN_FALSE.has(value)) return false;
  return null;
}

/**
 * 从模板 HTML 发现参数。
 *
 * @param {string} html
 * @param {{file?: string}} [opts]
 * @returns {{ok: boolean, params: ParamSchema, issues: DiscoveryIssue[], stats: {tags: number, annotations: number}}}
 */
export function discoverControls(html, opts = {}) {
  const file = opts.file ?? '<inline>';
  /** @type {DiscoveryIssue[]} */
  const issues = [];
  const { tags, error } = tokenizeTags(String(html ?? ''));
  if (error) {
    issues.push({ code: DISCOVERY_ERROR_CODES.PARSE_FAILED, key: '', line: lineOf(String(html ?? ''), error.index), detail: `${file}: ${error.detail}` });
  }

  /** @type {ParamSchema} */
  const params = {};
  /** @type {Set<string>} */
  const seen = new Set();
  let annotations = 0;

  /** @param {string} code @param {string} key @param {number} index @param {string} detail */
  const push = (code, key, index, detail) => {
    issues.push({ code, key, line: lineOf(String(html ?? ''), index), detail });
  };

  for (const tag of tags) {
    const key = (tag.attrs[MOTION_ATTRS.param] ?? '').trim();
    if (!key) continue;
    annotations += 1;

    if (seen.has(key)) {
      push(DISCOVERY_ERROR_CODES.DUPLICATE_PARAM, key, tag.index, `参数键 ${key} 重复声明（保留第一次出现的那条）`);
      continue;
    }

    const explicitType = (tag.attrs[MOTION_ATTRS.type] ?? '').trim().toLowerCase();
    const type = explicitType || inferType(tag);
    if (!TYPES.has(type)) {
      push(DISCOVERY_ERROR_CODES.UNKNOWN_TYPE, key, tag.index, `未知控件类型：${type}（只认 number/string/boolean/color/enum）`);
      continue;
    }

    /** @type {Record<string, unknown>} */
    const spec = { type };
    const label = (tag.attrs[MOTION_ATTRS.label] ?? '').trim();
    spec.label = label || key;

    let ok = true;
    if (type === 'number') {
      /** @param {string} attr @returns {number|undefined} */
      const num = (attr) => {
        const raw = tag.attrs[attr];
        if (raw === undefined || raw.trim() === '') return undefined;
        const value = Number(raw);
        if (!Number.isFinite(value)) {
          push(DISCOVERY_ERROR_CODES.PARSE_FAILED, key, tag.index, `${attr}="${raw}" 不是数字`);
          ok = false;
          return undefined;
        }
        return value;
      };
      const min = num(MOTION_ATTRS.min);
      const max = num(MOTION_ATTRS.max);
      const step = num(MOTION_ATTRS.step);
      if (min !== undefined) spec.min = min;
      if (max !== undefined) spec.max = max;
      if (step !== undefined) spec.step = step;
      if ((tag.attrs[MOTION_ATTRS.integer] ?? '').trim().toLowerCase() === 'true') spec.integer = true;
      const rawDefault = tag.attrs[MOTION_ATTRS.default];
      if (rawDefault !== undefined && rawDefault.trim() !== '') {
        const value = Number(rawDefault);
        if (!Number.isFinite(value)) {
          push(DISCOVERY_ERROR_CODES.BAD_DEFAULT, key, tag.index, `默认值 "${rawDefault}" 不是数字`);
          ok = false;
        } else {
          spec.default = value;
        }
      }
    } else if (type === 'boolean') {
      const parsed = parseBoolean(tag.attrs[MOTION_ATTRS.default]);
      if (parsed === null) {
        push(DISCOVERY_ERROR_CODES.BAD_DEFAULT, key, tag.index, `布尔默认值只认 true/false/1/0/on/off，收到 "${tag.attrs[MOTION_ATTRS.default]}"`);
        ok = false;
      } else if (tag.attrs[MOTION_ATTRS.default] !== undefined) {
        spec.default = parsed;
      }
    } else if (type === 'enum') {
      const options = (tag.attrs[MOTION_ATTRS.options] ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      if (options.length === 0) {
        push(DISCOVERY_ERROR_CODES.ENUM_NO_OPTIONS, key, tag.index, 'enum 必须给 data-motion-options（逗号分隔）');
        ok = false;
      } else {
        spec.options = options;
        const rawDefault = tag.attrs[MOTION_ATTRS.default];
        if (rawDefault !== undefined && rawDefault.trim() !== '') {
          if (!options.includes(rawDefault)) {
            push(DISCOVERY_ERROR_CODES.BAD_DEFAULT, key, tag.index, `默认值 "${rawDefault}" 不在 options 里（${options.join('/')}）`);
            ok = false;
          } else {
            spec.default = rawDefault;
          }
        }
      }
    } else {
      /* string / color */
      const rawDefault = tag.attrs[MOTION_ATTRS.default];
      if (rawDefault !== undefined && rawDefault !== '') spec.default = rawDefault;
      else if (type === 'string' && tag.textAfter) spec.default = tag.textAfter;
      if (type === 'string') {
        const rawMax = (tag.attrs[MOTION_ATTRS.maxLength] ?? '').trim();
        if (rawMax) {
          const value = Number(rawMax);
          if (!Number.isInteger(value) || value <= 0) {
            push(DISCOVERY_ERROR_CODES.PARSE_FAILED, key, tag.index, `data-motion-maxlength="${rawMax}" 不是正整数`);
            ok = false;
          } else {
            spec.maxLength = value;
          }
        }
      }
    }

    const applyKind = (tag.attrs[MOTION_ATTRS.apply] ?? '').trim().toLowerCase();
    if (applyKind === 'text') {
      const selector = selectorOf(tag);
      if (!selector) {
        push(DISCOVERY_ERROR_CODES.PARSE_FAILED, key, tag.index, '文本参数需要元素有 id 或 class，才能生成唯一选择器');
        ok = false;
      } else {
        spec.apply = { kind: 'text', selector };
      }
    } else if (applyKind && applyKind !== 'css-var') {
      push(DISCOVERY_ERROR_CODES.PARSE_FAILED, key, tag.index, `未知 data-motion-apply="${applyKind}"（只认 text / css-var）`);
      ok = false;
    }

    if (!ok) continue;

    /* 值域：解析成功不等于值合法（R16-C1） */
    for (const domain of checkSpecDomain(key, /** @type {ParamSpec} */ (/** @type {unknown} */ (spec)))) {
      push(domain.code, key, tag.index, domain.detail);
      ok = false;
    }
    if (!ok) continue;

    seen.add(key);
    params[key] = /** @type {ParamSpec} */ (/** @type {unknown} */ (spec));
  }

  return {
    ok: issues.length === 0,
    params,
    issues,
    stats: { tags: tags.length, annotations }
  };
}

/**
 * 合并手写 schema 与发现结果。
 *
 * ## 冲突策略（写死，不留给调用方猜）
 *
 * | 情况 | 结果 |
 * | --- | --- |
 * | 键只出现在手写 | 用手写；记进 `handwrittenOnly`（不报 issue——手写多写一个参数是作者的正常选择） |
 * | 键只出现在标注 | 补进来；记进 `added` |
 * | 两边都有且完全相同 | 用手写（同一份），记进 `agreed`，不报 issue |
 * | 两边都有但**类型不同** | **手写赢** + `MERGE_CONFLICT`（`conflict:'TYPE'`） |
 * | 同类型但范围/枚举/长度不同 | **手写赢** + `MERGE_CONFLICT`（`conflict:'RANGE'`） |
 * | 同类型同范围，只差 label/default/apply | **手写赢** + `MERGE_CONFLICT`（`conflict:'OTHER'`） |
 *
 * 为什么不用「标注覆盖手写」：手写是作者显式写的意图，标注更可能只是顺手抄的；
 * 而且手写能表达标注表达不了的东西（`apply` 的具体选择器、`integer`）。
 * 冲突一律留痕（不静默丢），让作者自己决定要不要删一边。
 *
 * @param {ParamSchema|undefined|null} handwritten
 * @param {ParamSchema|undefined|null} discovered
 * @returns {{params: ParamSchema, issues: DiscoveryIssue[], added: string[], conflicts: string[], agreed: string[], handwrittenOnly: string[], kinds: Record<string, 'TYPE'|'RANGE'|'OTHER'>}}
 */
export function mergeParams(handwritten, discovered) {
  const hand = /** @type {ParamSchema} */ (handwritten ?? {});
  const auto = /** @type {ParamSchema} */ (discovered ?? {});
  /** @type {ParamSchema} */
  const params = {};
  /** @type {DiscoveryIssue[]} */
  const issues = [];
  const added = [];
  const conflicts = [];
  const agreed = [];

  const handwrittenOnly = [];
  /** @type {Record<string, 'TYPE'|'RANGE'|'OTHER'>} */
  const kinds = {};

  for (const [key, spec] of Object.entries(hand)) {
    params[key] = spec;
    if (!Object.prototype.hasOwnProperty.call(auto, key)) {
      handwrittenOnly.push(key);
      continue;
    }
    const other = /** @type {ParamSpec} */ (auto[key]);
    if (isDeepStrictEqual(spec, other)) {
      agreed.push(key);
      continue;
    }
    conflicts.push(key);
    const fields = [...new Set([...Object.keys(spec), ...Object.keys(other)])].filter(
      (field) => !isDeepStrictEqual(/** @type {any} */ (spec)[field], /** @type {any} */ (other)[field])
    );
    /** @type {'TYPE'|'RANGE'|'OTHER'} */
    let kind = 'OTHER';
    if (spec.type !== other.type) kind = 'TYPE';
    else if (fields.some((field) => ['min', 'max', 'step', 'maxLength', 'options', 'integer'].includes(field))) kind = 'RANGE';
    kinds[key] = kind;
    const label = kind === 'TYPE' ? `类型冲突：手写 ${spec.type} / 标注 ${other.type}` : `字段：${fields.join('/')}`;
    issues.push({
      code: DISCOVERY_ERROR_CODES.MERGE_CONFLICT,
      key,
      line: 0,
      conflict: kind,
      detail: `手写与标注不一致（${label}），按手写生效`
    });
  }
  for (const [key, spec] of Object.entries(auto)) {
    if (Object.prototype.hasOwnProperty.call(hand, key)) continue;
    params[key] = spec;
    added.push(key);
  }
  return { params, issues, added, conflicts, agreed, handwrittenOnly, kinds };
}

/**
 * 宿主侧：条目有手写 params 就用手写，没有就从模板源发现（面板空表单的兜底）。
 * @param {string} root
 * @param {{params?: ParamSchema, sourcePath?: string, name?: string}} entry
 * @returns {Promise<{params: ParamSchema, source: 'handwritten'|'discovered'|'none', issues: DiscoveryIssue[], added: string[], conflicts: string[]}>}
 */
export async function discoverEntryParams(root, entry) {
  const handwritten = entry?.params ?? {};
  if (Object.keys(handwritten).length > 0) {
    return { params: handwritten, source: 'handwritten', issues: [], added: [], conflicts: [] };
  }
  const sourcePath = String(entry?.sourcePath ?? '');
  if (!sourcePath) {
    return { params: {}, source: 'none', issues: [{ code: DISCOVERY_ERROR_CODES.SOURCE_MISSING, key: '', line: 0, detail: '条目没有 sourcePath' }], added: [], conflicts: [] };
  }
  try {
    const html = await fs.readFile(path.join(root, sourcePath), 'utf8');
    const found = discoverControls(html, { file: sourcePath });
    return { params: found.params, source: 'discovered', issues: found.issues, added: Object.keys(found.params), conflicts: [] };
  } catch {
    return {
      params: {},
      source: 'none',
      issues: [{ code: DISCOVERY_ERROR_CODES.SOURCE_MISSING, key: '', line: 0, detail: `读不到模板源：${sourcePath}` }],
      added: [],
      conflicts: []
    };
  }
}
