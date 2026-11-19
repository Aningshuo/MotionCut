/**
 * 极小 JSON Schema 校验器（无第三方依赖）。
 *
 * 为什么自己写：本树不允许改 `package.json`（锁由大脑持有），装不了 ajv；
 * 而 CLI/MCP 都需要在**输出**和**入参**两侧做"可被 schema 校验"的硬检查。
 *
 * 只实现用得到的子集，遇到不认识的 keyword 直接抛错——静默忽略等于没校验：
 * type / const / enum / required / properties / additionalProperties /
 * items / minItems / maxItems / minimum / maximum / minLength / maxLength /
 * pattern / anyOf / oneOf / nullable(忽略，用 type 列表代替)
 */

/**
 * @typedef {{ ok: true } | { ok: false, errors: Array<{ path: string, message: string }> }} ValidationResult
 */

const KNOWN_KEYWORDS = new Set([
  '$schema',
  '$id',
  'title',
  'description',
  'type',
  'const',
  'enum',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'anyOf',
  'oneOf',
  'default',
  'examples',
]);

/**
 * @param {Record<string, unknown>} schema
 * @param {unknown} value
 * @param {string} [root]
 * @returns {ValidationResult}
 */
export function validate(schema, value, root = '$') {
  /** @type {Array<{ path: string, message: string }>} */
  const errors = [];
  walk(schema, value, root, errors);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * @param {any} schema
 * @param {any} value
 * @param {string} at
 * @param {Array<{ path: string, message: string }>} errors
 */
function walk(schema, value, at, errors) {
  if (schema === true || schema === undefined) return;
  if (schema === false) {
    errors.push({ path: at, message: 'no value allowed here' });
    return;
  }
  if (typeof schema !== 'object' || Array.isArray(schema)) {
    throw new TypeError(`invalid schema at ${at}`);
  }

  for (const key of Object.keys(schema)) {
    if (!KNOWN_KEYWORDS.has(key)) throw new TypeError(`unsupported schema keyword "${key}" at ${at}`);
  }

  if ('const' in schema && !deepEqual(schema.const, value)) {
    errors.push({ path: at, message: `must equal ${JSON.stringify(schema.const)}` });
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((/** @type {unknown} */ candidate) => deepEqual(candidate, value))) {
    errors.push({ path: at, message: `must be one of ${schema.enum.map((/** @type {unknown} */ v) => JSON.stringify(v)).join(', ')}` });
    return;
  }

  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.some((/** @type {string} */ type) => matchesType(type, value))) {
      errors.push({ path: at, message: `must be ${allowed.join(' | ')}, got ${typeName(value)}` });
      return;
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push({ path: at, message: `must be at least ${schema.minLength} characters` });
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push({ path: at, message: `must be at most ${schema.maxLength} characters` });
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
      errors.push({ path: at, message: `must match /${schema.pattern}/` });
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push({ path: at, message: `must be >= ${schema.minimum}` });
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push({ path: at, message: `must be <= ${schema.maximum}` });
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push({ path: at, message: `must have at least ${schema.minItems} items` });
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push({ path: at, message: `must have at most ${schema.maxItems} items` });
    }
    if (schema.items) {
      value.forEach((item, index) => walk(schema.items, item, `${at}[${index}]`, errors));
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = /** @type {Record<string, unknown>} */ (value);
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in obj)) errors.push({ path: `${at}.${key}`, message: 'is required' });
      }
    }
    const props = /** @type {Record<string, any>} */ (schema.properties ?? {});
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) walk(sub, obj[key], `${at}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) errors.push({ path: `${at}.${key}`, message: 'is not allowed' });
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) walk(schema.additionalProperties, obj[key], `${at}.${key}`, errors);
      }
    }
  }

  if (Array.isArray(schema.anyOf)) {
    const results = schema.anyOf.map((/** @type {any} */ sub) => {
      /** @type {Array<{ path: string, message: string }>} */
      const local = [];
      walk(sub, value, at, local);
      return local;
    });
    if (!results.some((/** @type {any[]} */ local) => local.length === 0)) {
      errors.push({ path: at, message: 'does not match any allowed shape' });
    }
  }

  if (Array.isArray(schema.oneOf)) {
    const results = schema.oneOf.map((/** @type {any} */ sub) => {
      /** @type {Array<{ path: string, message: string }>} */
      const local = [];
      walk(sub, value, at, local);
      return local;
    });
    if (results.filter((/** @type {any[]} */ local) => local.length === 0).length !== 1) {
      errors.push({ path: at, message: 'must match exactly one allowed shape' });
    }
  }
}

/**
 * @param {string} type
 * @param {unknown} value
 * @returns {boolean}
 */
function matchesType(type, value) {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      throw new TypeError(`unsupported schema type "${type}"`);
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function typeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
