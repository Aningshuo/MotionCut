/**
 * 字幕样式的工程级读取（P48 · B-SUB2-R24-024；P65 起形状/取值都不许静默）。
 *
 * 背景：Studio 从 M40 起把字幕样式存在 `<project>/.film/subtitle-style.json`
 * （`packages/studio/server/subtitle-style-store.mjs`），CLI 一直没读它——同一个工程
 * Studio 烧黄字、CLI 烧白字（R27-C1 / R29-C6 两轮都记过）。这个文件把「读」补上，
 * 写法与 Studio 同一套 schema、同一套 `normalizeSubtitleStyle`，但**只读**：
 * CLI 不回写工程，也不改样式的默认值/校验（`packages/layers/subtitle-style.mjs` 的默认值
 * 与版本号一个字都不动）。
 *
 * 优先级：
 *
 * ```
 * 显式 --subtitle-style / spec.subtitleStyle   >   .film/subtitle-style.json   >   默认
 * ```
 *
 * ## P65：三种形状必须分得清（R50-B-SUB2-R29-034）
 *
 * P48 的实现只认 `parsed.style`。用户把字段直接写在顶层（`{"fontSizeRatio":1.0}`）时，
 * 它**静默**返回 `style:null` → 走默认：改样式、成片不变、一个提示都没有。
 * 现在按形状分三类，并把结论放进 `warnings`：
 *
 * | 文件形状 | style | warnings |
 * |---|---|---|
 * | `{style:{…}}` | 用 style | — |
 * | 顶层有样式字段、没有 `style` 键 | null（用默认） | `TOP_LEVEL_STYLE_IGNORED` |
 * | 两者并存 | 用 style（顶层被遮蔽） | `TOP_LEVEL_SHADOWED` |
 *
 * `warnings` 会出现在 `readProjectSubtitleStyle()` 与 `resolveSubtitleStyle()` 的返回值里
 * （后者另有 `audit.shape`），调用方不用再去猜「为什么没生效」。
 *
 * ## P65：非法取值不再「回退 + 一条 issue」了事
 *
 * `normalizeSubtitleStyle` 对越界值是**回退默认 + issue**（Studio 的交互语义）。
 * 但工程文件不是表单：写坏一个 `lineHeight: 0` 却照样出片，用户只会以为「设置没用」。
 * 所以读取端在归一化**之前**做一次硬校验，命中就抛 `INVALID_SUBTITLE_STYLE`，
 * 消息里带字段名与实际值：
 *
 * - 字号（`fontSizeRatio` / 旧 `fontSize`）必须是 > 0 的有限数；
 * - `lineHeight` 必须 > 0；
 * - `color` / `outlineColor` / `shadowColor` / `background` 必须能解析成颜色。
 *
 * 其余字段（`fontScale` 越界等）仍走 `normalizeSubtitleStyle` 的 issues 路径——
 * 与 Studio 一致，不阻断。未知字段保留但 warn（`STYLE_UNKNOWN_KEY` 由归一化产出）。
 *
 * 三条边界（P48 起就没变过）：
 * 1. 文件不存在 = 默认值（**不是错误**：新工程本来就没有），默认 ASS 的 sha 不能漂；
 * 2. 坏 JSON / 顶层不是对象 / 主版本不同 → `INVALID`（CLI 退出码 2），**不写任何文件**；
 * 3. 归一化产生的 issues **不阻断**（与 Studio 一致：带着回退继续烧），但要进审计字段。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { SUBTITLE_STYLE_VERSION, normalizeSubtitleStyle } from '../layers/subtitle-style.mjs';

/** 工程内相对路径。报错与审计都用它，不暴露绝对路径。 */
export const SUBTITLE_STYLE_FILE = '.film/subtitle-style.json';

/**
 * `style` 里认得的字段名（S41 canonical + 旧 schema 的两个别名）。
 * 用来判断「顶层是不是写了样式字段」——只认这些键，避免把 `version` / `updatedAt`
 * 这类文件元数据误判成样式。
 */
export const STYLE_FIELDS = Object.freeze([
  'fontFamily',
  'assFontName',
  'fontSizeRatio',
  'fontSize',
  'color',
  'outlineColor',
  'outlineRatio',
  'shadowColor',
  'shadowRatio',
  'background',
  'align',
  'lineHeight',
  'maxLines',
  'bottomSafeRatio',
  'fontScale',
  'bold',
  'cpsWarn',
  'strokeWidthRatio',
]);

/** 与 `packages/layers/subtitle-style.mjs` 的颜色解析同一套可接受形态。 */
const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*\d{1,3}(?:\.\d+)?%?(?:\s*,\s*\d{1,3}(?:\.\d+)?%?){2,3}\s*\)|transparent|none)$/;

/** 需要「> 0」的字号字段：新 schema 的 ratio 与旧 schema 的 fontSize。 */
const FONT_SIZE_FIELDS = ['fontSizeRatio', 'fontSize'];
/** 需要「> 0」的行距字段。 */
const POSITIVE_FIELDS = ['lineHeight'];
/** 颜色字段。 */
const COLOR_FIELDS = ['color', 'outlineColor', 'shadowColor', 'background'];

/**
 * @typedef {{
 *   origin: 'explicit' | 'project' | 'default',
 *   file: string | null,
 *   exists: boolean,
 *   issues: any[],
 *   sha256: string | null,
 *   shape?: 'wrapped' | 'top-level' | 'both' | 'empty' | 'missing' | 'explicit',
 *   warnings?: string[],
 *   ignoredFields?: string[],
 * }} StyleAudit
 */

export class SubtitleStyleSourceError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'SubtitleStyleSourceError';
    this.code = code;
  }
}

/** @param {string} text */
function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 值的可读形态：字符串带引号，数字原样，其余 JSON。 @param {unknown} value */
function showValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  return JSON.stringify(value);
}

/**
 * 归一化之前的硬校验。只查「写坏了会让人以为设置没生效」的那几个字段，
 * 其余（fontScale 越界等）继续走 `normalizeSubtitleStyle` 的 issues 路径。
 *
 * @param {any} style
 * @param {string} where 报错前缀（文件名或 explicit）
 */
export function assertValidStyleValues(style, where = SUBTITLE_STYLE_FILE) {
  if (style === undefined || style === null) return;
  if (typeof style !== 'object' || Array.isArray(style)) {
    throw new SubtitleStyleSourceError(
      'INVALID_SUBTITLE_STYLE',
      `${where}: "style" must be a JSON object (got ${showValue(style)})`,
    );
  }
  /** @param {string} field @param {unknown} value @param {string} rule */
  const fail = (field, value, rule) => {
    throw new SubtitleStyleSourceError(
      'INVALID_SUBTITLE_STYLE',
      `${where}: field "${field}" ${rule} (got ${showValue(value)})`,
    );
  };

  for (const field of [...FONT_SIZE_FIELDS, ...POSITIVE_FIELDS]) {
    if (!Object.prototype.hasOwnProperty.call(style, field)) continue;
    const value = style[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(field, value, 'must be a finite number');
    if (!(value > 0)) fail(field, value, 'must be > 0');
  }

  for (const field of COLOR_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(style, field)) continue;
    const value = style[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !COLOR_RE.test(value.trim())) {
      fail(field, value, 'must be a color (#rgb / #rrggbb / #rrggbbaa / rgb() / rgba() / transparent)');
    }
  }
}

/**
 * 读工程里保存的样式（只读）。
 *
 * 返回里的 `shape` 是**文件形状**的判定结果，`warnings` 是给用户看的一句话原因：
 * 形状不对时不再静默回默认，而是把「你写的顶层字段被忽略了」说出来。
 *
 * @param {string} projectRoot
 * @returns {Promise<{
 *   exists: boolean,
 *   style: any | null,
 *   version: string,
 *   updatedAt: string | null,
 *   sha256: string | null,
 *   shape: 'wrapped' | 'top-level' | 'both' | 'empty' | 'missing',
 *   warnings: string[],
 *   ignoredFields: string[],
 * }>}
 */
export async function readProjectSubtitleStyle(projectRoot) {
  const file = path.join(projectRoot, '.film', 'subtitle-style.json');
  /** @type {string} */
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (/** @type {any} */ (error)?.code === 'ENOENT') {
      return {
        exists: false,
        style: null,
        version: SUBTITLE_STYLE_VERSION,
        updatedAt: null,
        sha256: null,
        shape: 'missing',
        warnings: [],
        ignoredFields: [],
      };
    }
    throw new SubtitleStyleSourceError(
      'INVALID',
      `${SUBTITLE_STYLE_FILE}: cannot read (${String(/** @type {Error} */ (error).message)})`,
    );
  }

  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SubtitleStyleSourceError(
      'INVALID',
      `${SUBTITLE_STYLE_FILE} is not valid JSON: ${String(/** @type {Error} */ (error).message)}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SubtitleStyleSourceError('INVALID', `${SUBTITLE_STYLE_FILE} must contain a JSON object`);
  }
  const version = typeof parsed.version === 'string' ? parsed.version : '';
  if (version !== '' && version.split('.')[0] !== SUBTITLE_STYLE_VERSION.split('.')[0]) {
    throw new SubtitleStyleSourceError(
      'INVALID',
      `${SUBTITLE_STYLE_FILE} has version ${version}, this build supports ${SUBTITLE_STYLE_VERSION}`,
    );
  }

  const hasStyleKey = Object.prototype.hasOwnProperty.call(parsed, 'style');
  const topLevelFields = STYLE_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(parsed, field));

  /** @type {'wrapped' | 'top-level' | 'both' | 'empty'} */
  let shape = 'empty';
  /** @type {any | null} */
  let style = null;
  /** @type {string[]} */
  const warnings = [];
  /** @type {string[]} */
  const ignoredFields = [];

  if (hasStyleKey) {
    const raw = parsed.style;
    if (raw === null || raw === undefined) {
      /* `{"style":null}` 与「没有 style」等价：不算错，走默认。 */
      shape = topLevelFields.length ? 'top-level' : 'empty';
      if (topLevelFields.length) {
        warnings.push('TOP_LEVEL_STYLE_IGNORED');
        ignoredFields.push(...topLevelFields);
      }
    } else if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new SubtitleStyleSourceError(
        'INVALID_SUBTITLE_STYLE',
        `${SUBTITLE_STYLE_FILE}: "style" must be a JSON object (got ${showValue(raw)})`,
      );
    } else {
      shape = topLevelFields.length ? 'both' : 'wrapped';
      style = raw;
      if (topLevelFields.length) warnings.push('TOP_LEVEL_SHADOWED');
    }
  } else if (topLevelFields.length) {
    shape = 'top-level';
    warnings.push('TOP_LEVEL_STYLE_IGNORED');
    ignoredFields.push(...topLevelFields);
  }

  /* 形状对了再查值：形状不对时 style 根本没被采用，先别用「值非法」盖掉「形状不对」。 */
  if (style !== null) assertValidStyleValues(style, SUBTITLE_STYLE_FILE);

  return {
    exists: true,
    style,
    version: SUBTITLE_STYLE_VERSION,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    sha256: sha256(text),
    shape,
    warnings,
    ignoredFields,
  };
}

/**
 * 决定这次烧录用哪份样式。
 *
 * 返回值里的 `style` **可能是 undefined**：那是「用默认」的显式表达——
 * `prepareSubtitleBurn` 不传 subtitleStyle 时走的还是 R22 那条逐字节路径
 * （默认 ASS `be1f7325…` 就是靠这个守住的）。
 *
 * `warnings` 是 P65 加的：形状不对（顶层写了字段 / 顶层被 style 遮蔽）时非空，
 * 调用方（CLI 结果、导出 job、Studio）应当原样透出去，别让用户猜。
 *
 * @param {{ projectRoot: string, explicit?: any }} input
 * @returns {Promise<{ style: any | undefined, audit: StyleAudit, warnings: string[] }>}
 */
export async function resolveSubtitleStyle(input) {
  if (input.explicit !== undefined) {
    const normalized = normalizeSubtitleStyle(input.explicit);
    return {
      style: normalized.style,
      audit: {
        origin: 'explicit',
        file: null,
        exists: false,
        issues: normalized.issues ?? [],
        sha256: null,
        shape: 'explicit',
        warnings: [],
        ignoredFields: [],
      },
      warnings: [],
    };
  }

  const stored = await readProjectSubtitleStyle(input.projectRoot);
  const warnings = Array.isArray(stored.warnings) ? [...stored.warnings] : [];
  if (!stored.exists || stored.style === null) {
    return {
      style: undefined,
      audit: {
        origin: 'default',
        file: SUBTITLE_STYLE_FILE,
        exists: stored.exists,
        issues: [],
        sha256: stored.sha256,
        shape: stored.shape,
        warnings,
        ignoredFields: Array.isArray(stored.ignoredFields) ? [...stored.ignoredFields] : [],
      },
      warnings,
    };
  }
  const normalized = normalizeSubtitleStyle(stored.style);
  return {
    style: normalized.style,
    audit: {
      origin: 'project',
      file: SUBTITLE_STYLE_FILE,
      exists: true,
      issues: normalized.issues ?? [],
      sha256: stored.sha256,
      shape: stored.shape,
      warnings,
      ignoredFields: Array.isArray(stored.ignoredFields) ? [...stored.ignoredFields] : [],
    },
    warnings,
  };
}
