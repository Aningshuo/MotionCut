/**
 * 动效/组件库（副线1 · S5-WP15）
 *
 * 条目**不存 HTML**：只记「相对工程根的源路径 + 源字节哈希 + 依赖 + 参数 schema + 版本」。
 * 模板源始终是磁盘上的一个 `.html` 文件，所以：
 * - 另存模板 = 复制源文件（重名**不覆盖**），再登记一行元数据；
 * - 实例化 = 生成片段（`src` 指模板、参数进 `overrides` / `attrs['data-props']`），
 *   **模板源一个字节都不改**；
 * - 升级/回退 = 显式动作，靠 `motion/versions/<id>/<hash>.html` 的快照把旧表现复现出来。
 *
 * 落盘只碰 `motion/library.json` 与 `scenes/<name>.html`、`motion/versions/**`；
 * 真正的 `film.html` 写入仍归主线的 `FilmDocIo`，本模块不碰。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { validateSchema, validateParams, overridesOf, describeIssues } from './params.mjs';
import { scanLinked } from './wall-clock-check.mjs';

/** @typedef {import('./params.mjs').ParamSchema} ParamSchema */
/** @typedef {import('./params.mjs').ParamValues} ParamValues */
/** @typedef {import('./params.mjs').ParamIssue} ParamIssue */

export const LIBRARY_FILE = 'motion/library.json';
export const LIBRARY_VERSION = 1;
export const ENTRY_KINDS = Object.freeze(['animation', 'component', 'saved']);

/**
 * @typedef {object} AssetRef
 * @property {string} ref      源里写的引用（原样）
 * @property {string} path     相对工程根的路径
 */

/**
 * @typedef {object} HistoryRecord
 * @property {string} sourceHash
 * @property {number} version
 * @property {string} snapshot 相对工程根的快照路径；旧版条目可能没有
 */

/**
 * @typedef {object} LibraryEntry
 * @property {string} id
 * @property {string} name
 * @property {'animation'|'component'|'saved'} kind
 * @property {string} sourcePath
 * @property {string} sourceHash
 * @property {AssetRef[]} assets
 * @property {ParamSchema} params
 * @property {number} version
 * @property {string} createdAt
 * @property {boolean} [archived]
 * @property {boolean} [deterministic] 画面是否只由 t 决定。模板里有墙钟动画（未暂停的
 *   animation / transition / rAF 自增 / 读 performance.now）时为 false；缺省视为 true。
 * @property {HistoryRecord[]} history
 */

/**
 * @typedef {object} Library
 * @property {number} version
 * @property {LibraryEntry[]} entries
 */

/**
 * @typedef {object} LibraryStatus
 * @property {LibraryEntry} entry
 * @property {'ready'|'changed'|'missing-asset'|'archived'|'source-missing'} status
 * @property {AssetRef[]} missingAssets
 * @property {string} [actualHash]
 */

/** @param {string} root */
export function libraryPath(root) {
  return path.join(root, LIBRARY_FILE);
}

/** @param {string} root @param {string} rel */
function abs(root, rel) {
  return path.join(root, rel.split('/').join(path.sep));
}

/** @param {string} text */
export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** @returns {Library} */
export function emptyLibrary() {
  return { version: LIBRARY_VERSION, entries: [] };
}

/**
 * @param {unknown} value
 * @returns {value is Library}
 */
function isLibrary(value) {
  if (value === null || typeof value !== 'object') return false;
  const v = /** @type {Record<string, unknown>} */ (value);
  return typeof v.version === 'number' && Array.isArray(v.entries);
}

/**
 * 读库。文件不存在 → 空库（不是错误）；损坏 → `corrupt: true` 并给空库，调用方必须显示出来而不是静默重建。
 * @param {string} root
 * @returns {Promise<{library: Library, hash: string|null, exists: boolean, corrupt?: boolean}>}
 */
export async function readLibrary(root) {
  const file = libraryPath(root);
  /** @type {string} */
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return { library: emptyLibrary(), hash: null, exists: false };
    }
    throw err;
  }
  const hash = sha256(text);
  try {
    const parsed = JSON.parse(text);
    if (!isLibrary(parsed)) return { library: emptyLibrary(), hash, exists: true, corrupt: true };
    return { library: normalize(parsed), hash, exists: true };
  } catch {
    return { library: emptyLibrary(), hash, exists: true, corrupt: true };
  }
}

/**
 * 补齐旧条目缺的字段，读的时候不因为少一个数组就崩。
 * @param {Library} lib
 * @returns {Library}
 */
function normalize(lib) {
  const entries = lib.entries.map((e) => ({
    ...e,
    assets: Array.isArray(e.assets) ? e.assets : [],
    params: e.params && typeof e.params === 'object' ? e.params : {},
    /* 三态：true / false / **缺省（未知）**。老条目没有这个字段就是未知——
       S34 起不再默认成 true：没扫过就写「可复现」等于替作者撒谎。 */
    deterministic: typeof e.deterministic === 'boolean' ? e.deterministic : undefined,
    history: Array.isArray(e.history) ? e.history : []
  }));
  return { version: LibraryVersionOf(lib), entries };
}

/** @param {Library} lib */
function LibraryVersionOf(lib) {
  return typeof lib.version === 'number' ? lib.version : LIBRARY_VERSION;
}

/**
 * 原子写库：同目录临时文件 → fsync → rename；条目按 name/id 排序，字节稳定。
 * @param {string} root
 * @param {Library} library
 * @returns {Promise<{hash: string, file: string}>}
 */
export async function writeLibrary(root, library) {
  const file = libraryPath(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const sorted = {
    version: LIBRARY_VERSION,
    entries: [...library.entries].sort((a, b) => (a.name === b.name ? a.id.localeCompare(b.id) : a.name.localeCompare(b.name)))
  };
  const text = JSON.stringify(sorted, null, 2) + '\n';
  const tmp = path.join(path.dirname(file), `.library.${process.pid}.${Date.now()}.tmp`);
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(text, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
  return { hash: sha256(text), file };
}

/**
 * 条目 id：由「名字 + 源路径」决定，重复登记同一件事只会命中同一条（幂等键）。
 * @param {string} name
 * @param {string} sourcePath
 */
export function entryId(name, sourcePath) {
  return `motion_${sha256(`${name}\n${sourcePath}`).slice(0, 12)}`;
}

/** @param {Library} library @param {string} id */
export function findEntry(library, id) {
  return library.entries.find((e) => e.id === id) ?? null;
}

/**
 * 列表：始终包含不可用条目（缺资源 / 源缺失），并带上原因——「不可用」不等于「看不见」。
 * @param {string} root
 * @param {Library} library
 * @param {{includeArchived?: boolean}} [opts]
 * @returns {Promise<LibraryStatus[]>}
 */
export async function listEntries(root, library, opts = {}) {
  /** @type {LibraryStatus[]} */
  const out = [];
  for (const entry of library.entries) {
    if (entry.archived && !opts.includeArchived) continue;
    const source = await checkSource(root, entry);
    const assets = await checkAssets(root, entry);
    const missingAssets = assets.filter((a) => !a.exists).map(({ ref, path: p }) => ({ ref, path: p }));
    /** @type {LibraryStatus['status']} */
    let status = 'ready';
    if (entry.archived) status = 'archived';
    else if (source.status === 'missing') status = 'source-missing';
    else if (source.status === 'changed') status = 'changed';
    else if (missingAssets.length) status = 'missing-asset';
    out.push({
      entry,
      status,
      missingAssets,
      ...(source.actualHash ? { actualHash: source.actualHash } : {})
    });
  }
  return out;
}

/**
 * 源是否被外部改过（= 模板升级的触发条件）。
 * @param {string} root
 * @param {LibraryEntry} entry
 * @returns {Promise<{status: 'current'|'changed'|'missing', actualHash?: string}>}
 */
export async function checkSource(root, entry) {
  try {
    const text = await fs.readFile(abs(root, entry.sourcePath), 'utf8');
    const actualHash = sha256(text);
    return actualHash === entry.sourceHash
      ? { status: 'current', actualHash }
      : { status: 'changed', actualHash };
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return { status: 'missing' };
    throw err;
  }
}

/**
 * 库文件的错误码（稳定字符串，宿主与 CLI 都按这个判断，不解析人话）。
 *
 * 为什么 `DEFAULT_OUT_OF_RANGE` 要单列：`validateSchema` 把「默认值越界/不在枚举里」和
 * 「类型写错、options 不是数组」都归到 `INVALID_SCHEMA`。作者修起来是两件完全不同的事
 * （一个是改数字，一个是改结构），所以要能分开报。
 */
/** @typedef {{code: string, entryId: string, key: string, path: string, reason: string, detail: string}} LibraryIssue */

export const LIBRARY_ERROR_CODES = Object.freeze({
  LIBRARY_SHAPE: 'LIBRARY_SHAPE',
  BAD_VERSION: 'BAD_VERSION',
  DUPLICATE_ID: 'DUPLICATE_ID',
  BAD_ENTRY: 'BAD_ENTRY',
  INVALID_SCHEMA: 'INVALID_SCHEMA',
  DEFAULT_OUT_OF_RANGE: 'DEFAULT_OUT_OF_RANGE',
  SOURCE_MISSING: 'SOURCE_MISSING',
  MISSING_ASSET: 'MISSING_ASSET'
});

/** 这些 reason 说明「schema 结构没问题，只是默认值越界」 */
const DEFAULT_REASONS = new Set(['DEFAULT_BELOW_MIN', 'DEFAULT_ABOVE_MAX', 'DEFAULT_NOT_IN_OPTIONS']);

/**
 * 校验一份库（结构 + 每条模板的 schema + 源文件 + 资产）。
 *
 * 只读，不改盘。返回 `ok` + 首个错误码 `code` + 去重后的 `codes` + 逐条 `errors`；
 * 调用方拿 `code` 做分支、拿 `errors` 给人看。
 *
 * @param {string} root 工程根
 * @param {unknown} library
 * @returns {Promise<{ok: boolean, code: string|null, codes: string[], errors: LibraryIssue[]}>}
 */
export async function validateLibrary(root, library) {
  /** @type {LibraryIssue[]} */
  const errors = [];
  /** @param {string} code @param {Record<string, string>} [extra] */
  const push = (code, extra = {}) => {
    errors.push({ code, entryId: extra.entryId ?? '', key: extra.key ?? '', path: extra.path ?? '', reason: extra.reason ?? '', detail: extra.detail ?? '' });
  };

  if (library === null || typeof library !== 'object' || Array.isArray(library)) {
    push(LIBRARY_ERROR_CODES.LIBRARY_SHAPE, { detail: '库不是对象' });
    return finish(errors);
  }
  const lib = /** @type {Record<string, unknown>} */ (library);
  if (!Number.isInteger(lib.version)) {
    push(LIBRARY_ERROR_CODES.BAD_VERSION, { detail: `library.version=${String(lib.version)} 不是整数` });
  }
  if (!Array.isArray(lib.entries)) {
    push(LIBRARY_ERROR_CODES.LIBRARY_SHAPE, { detail: 'library.entries 不是数组' });
    return finish(errors);
  }

  /** @type {Set<string>} */
  const seen = new Set();
  for (const raw of lib.entries) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      push(LIBRARY_ERROR_CODES.BAD_ENTRY, { detail: '条目不是对象' });
      continue;
    }
    const entry = /** @type {Record<string, any>} */ (raw);
    const entryIdValue = typeof entry.id === 'string' ? entry.id : '';
    if (!entryIdValue) {
      push(LIBRARY_ERROR_CODES.BAD_ENTRY, { detail: '条目缺 id' });
      continue;
    }
    if (seen.has(entryIdValue)) {
      push(LIBRARY_ERROR_CODES.DUPLICATE_ID, { entryId: entryIdValue, detail: '同一个 id 出现多次' });
      continue;
    }
    seen.add(entryIdValue);

    if (!Number.isInteger(entry.version)) {
      push(LIBRARY_ERROR_CODES.BAD_VERSION, { entryId: entryIdValue, detail: `entry.version=${String(entry.version)} 不是整数` });
    }
    if (typeof entry.name !== 'string' || !entry.name.trim()) {
      push(LIBRARY_ERROR_CODES.BAD_ENTRY, { entryId: entryIdValue, detail: '条目缺 name' });
    }
    if (!ENTRY_KINDS.includes(entry.kind)) {
      push(LIBRARY_ERROR_CODES.BAD_ENTRY, { entryId: entryIdValue, detail: `未知 kind：${String(entry.kind)}` });
    }
    if (typeof entry.sourcePath !== 'string' || !entry.sourcePath.trim()) {
      push(LIBRARY_ERROR_CODES.BAD_ENTRY, { entryId: entryIdValue, detail: '条目缺 sourcePath' });
      continue;
    }

    /* schema：结构错与「默认值越界」分开报 */
    const schema = entry.params ?? {};
    const schemaCheck = validateSchema(schema);
    if (!schemaCheck.ok) {
      const onlyDefaults = schemaCheck.errors.every((issue) => DEFAULT_REASONS.has(issue.reason));
      const code = onlyDefaults ? LIBRARY_ERROR_CODES.DEFAULT_OUT_OF_RANGE : LIBRARY_ERROR_CODES.INVALID_SCHEMA;
      for (const issue of schemaCheck.errors) {
        push(code, {
          entryId: entryIdValue,
          key: issue.key,
          reason: issue.reason,
          detail: issue.detail ?? ''
        });
      }
    }

    /* 源文件 */
    const sourceAbs = abs(root, entry.sourcePath);
    /** @type {string|null} */
    let html = null;
    try {
      html = await fs.readFile(sourceAbs, 'utf8');
    } catch {
      push(LIBRARY_ERROR_CODES.SOURCE_MISSING, { entryId: entryIdValue, path: entry.sourcePath, detail: '模板源不存在或读不了' });
    }

    /* 资产：先看登记表，再按源里的引用补扫（防止登记表漏项） */
    /** @type {Set<string>} */
    const declared = new Set();
    for (const asset of Array.isArray(entry.assets) ? entry.assets : []) {
      const rel = asset && typeof asset.path === 'string' ? asset.path : '';
      if (!rel) continue;
      declared.add(rel);
      try {
        await fs.access(abs(root, rel), fsConstants.R_OK);
      } catch {
        push(LIBRARY_ERROR_CODES.MISSING_ASSET, { entryId: entryIdValue, path: rel, detail: '登记的资产不存在' });
      }
    }
    if (html !== null) {
      for (const ref of scanAssetRefs(html)) {
        const candidates = [path.resolve(path.dirname(sourceAbs), ref), path.resolve(root, ref.replace(/^\.?\//, ''))];
        let found = null;
        let chosen = candidates[0] ?? '';
        for (const candidate of candidates) {
          try {
            await fs.access(candidate, fsConstants.R_OK);
            found = candidate;
            break;
          } catch {
            /* 下一个 */
          }
        }
        chosen = found ?? candidates[0] ?? '';
        const rel = path.relative(root, chosen).split(path.sep).join('/');
        if (!found) {
          push(LIBRARY_ERROR_CODES.MISSING_ASSET, { entryId: entryIdValue, path: rel, detail: `源里引用的资产不存在：${ref}` });
        } else if (!declared.has(rel)) {
          /* 有文件但没登记：不是错误，登记表由 listEntries 现算，这里只保证不漏报缺失 */
        }
      }
    }
  }

  return finish(errors);
}

/**
 * @param {LibraryIssue[]} errors
 * @returns {{ok: boolean, code: string|null, codes: string[], errors: LibraryIssue[]}}
 */
function finish(errors) {
  const codes = [...new Set(errors.map((issue) => issue.code))];
  return { ok: errors.length === 0, code: codes[0] ?? null, codes, errors };
}

/**
 * 源里引用的本地资源是否存在。绝对地址（http:/data:/#）不检查，跨源也算「不是我的资源」。
 * @param {string} root
 * @param {LibraryEntry} entry
 * @returns {Promise<{ref: string, path: string, exists: boolean}[]>}
 */
export async function checkAssets(root, entry) {
  const sourceAbs = abs(root, entry.sourcePath);
  /** @type {string} */
  let html;
  try {
    html = await fs.readFile(sourceAbs, 'utf8');
  } catch {
    return [];
  }
  const refs = scanAssetRefs(html);
  /** @type {{ref: string, path: string, exists: boolean}[]} */
  const out = [];
  const baseDir = path.dirname(sourceAbs);
  for (const ref of refs) {
    const first = path.resolve(baseDir, ref);
    const candidates = [first, path.resolve(root, ref.replace(/^\.?\//, ''))];
    let exists = false;
    /** @type {string} */
    let chosen = path.relative(root, first).split(path.sep).join('/');
    for (const c of candidates) {
      try {
        await fs.access(c, fsConstants.R_OK);
        exists = true;
        chosen = path.relative(root, c).split(path.sep).join('/');
        break;
      } catch {
        /* 换下一个候选 */
      }
    }
    out.push({ ref, path: chosen, exists });
  }
  return out;
}

/**
 * 从 HTML 里挑出本地资源引用：img/source/video/audio/link/script 的 src|href，
 * 以及 style 属性与 <style> 里的 url(...)。
 * @param {string} html
 * @returns {string[]}
 */
export function scanAssetRefs(html) {
  /** @type {Set<string>} */
  const found = new Set();
  /** @param {string} raw */
  const add = (raw) => {
    const ref = raw.trim().replace(/^['"]|['"]$/g, '');
    if (!ref) return;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(ref)) return; // 地址、锚点、站点绝对路径：不是工程内资源
    found.add(ref);
  };
  const tagRe = /<(img|source|video|audio|link|script|iframe)\b[^>]*>/gi;
  /** @type {RegExpExecArray | null} */
  let m;
  while ((m = tagRe.exec(html))) {
    const tag = m[1] ?? '';
    const body = m[0];
    const attrRe = /\b(?:src|href|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
    /** @type {RegExpExecArray | null} */
    let a;
    while ((a = attrRe.exec(body))) add(a[1] ?? a[2] ?? a[3] ?? '');
    if (tag.toLowerCase() === 'link') continue;
  }
  const styleAttrRe = /style\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  while ((m = styleAttrRe.exec(html))) {
    for (const ref of urlRefs(m[1] ?? m[2] ?? '')) add(ref);
  }
  const styleBlockRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  while ((m = styleBlockRe.exec(html))) {
    for (const ref of urlRefs(m[1] ?? '')) add(ref);
  }
  return [...found].sort();
}

/** @param {string} css */
function urlRefs(css) {
  /** @type {string[]} */
  const out = [];
  const re = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi;
  /** @type {RegExpExecArray | null} */
  let m;
  while ((m = re.exec(css))) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

/**
 * 另存为模板：复制源到 `scenes/<name>.html`，登记条目。
 *
 * 重名**不覆盖**：默认 `NAME_TAKEN`；显式 `onConflict:'suffix'` 才退到 `-2`、`-3`。
 * 复制用 `COPYFILE_EXCL`，即便并发也只会有一个赢。
 *
 * @param {string} root
 * @param {{name: string, from: string, kind?: 'animation'|'component'|'saved', params?: ParamSchema, onConflict?: 'reject'|'suffix', now?: Date|number|string}} opts
 * @returns {Promise<
 *   {ok: true, entry: LibraryEntry, dest: string, reused: boolean, library: Library, hash: string}
 *   | {ok: false, code: 'INVALID_NAME'|'INVALID_SCHEMA'|'SOURCE_MISSING'|'NAME_TAKEN'|'IO', message: string, errors?: ParamIssue[]}
 * >}
 */
export async function saveAsTemplate(root, opts) {
  const name = String(opts.name ?? '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)) {
    return { ok: false, code: 'INVALID_NAME', message: '模板名只允许字母数字下划线（1–64），且以字母或数字开头' };
  }
  const kind = opts.kind ?? 'component';
  if (!ENTRY_KINDS.includes(kind)) {
    return { ok: false, code: 'INVALID_NAME', message: `未知模板类型：${kind}` };
  }
  const params = opts.params ?? {};
  const schemaCheck = validateSchema(params);
  if (!schemaCheck.ok) {
    return { ok: false, code: 'INVALID_SCHEMA', message: describeIssues(schemaCheck.errors), errors: schemaCheck.errors };
  }

  const { library } = await readLibrary(root);
  let destName = `${name}.html`;
  let sourcePath = `scenes/${destName}`;
  const idBase = entryId(name, sourcePath);
  const existingId = findEntry(library, idBase);

  /** @type {string} */
  let sourceText;
  try {
    sourceText = await fs.readFile(abs(root, opts.from), 'utf8');
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return { ok: false, code: 'SOURCE_MISSING', message: `源不存在：${opts.from}` };
    }
    throw err;
  }
  const sourceHash = sha256(sourceText);

  /* 同一份源、同一个名字：幂等命中，不新增条目 */
  if (existingId && existingId.sourceHash === sourceHash && !existingId.archived) {
    return {
      ok: true,
      entry: existingId,
      dest: abs(root, existingId.sourcePath),
      reused: true,
      library,
      hash: sha256(JSON.stringify(library))
    };
  }

  await fs.mkdir(abs(root, 'scenes'), { recursive: true });
  /** @type {string|null} */
  let createdDest = null;
  for (let attempt = 0; attempt < 200; attempt++) {
    const candidate = attempt === 0 ? destName : destName.replace(/\.html$/, `-${attempt + 1}.html`);
    const candidatePath = `scenes/${candidate}`;
    if (attempt > 0 && opts.onConflict !== 'suffix') {
      return { ok: false, code: 'NAME_TAKEN', message: `模板已存在且不覆盖：${destName}` };
    }
    try {
      await fs.copyFile(abs(root, opts.from), abs(root, candidatePath), fsConstants.COPYFILE_EXCL);
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EEXIST') {
        if (opts.onConflict !== 'suffix') {
          return { ok: false, code: 'NAME_TAKEN', message: `模板已存在且不覆盖：${candidate}` };
        }
        continue;
      }
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
        return { ok: false, code: 'SOURCE_MISSING', message: `源不存在：${opts.from}` };
      }
      return { ok: false, code: 'IO', message: String(/** @type {Error} */ (err).message ?? err) };
    }
    createdDest = candidatePath;
    sourcePath = candidatePath;
    destName = candidate;
    break;
  }
  if (!createdDest) return { ok: false, code: 'NAME_TAKEN', message: '同名模板过多，拒绝继续加后缀' };

  const entry = await makeEntry(root, {
    id: entryId(name, createdDest),
    name,
    kind,
    sourcePath: createdDest,
    sourceHash,
    params,
    now: opts.now
  });
  const next = { version: LIBRARY_VERSION, entries: [...library.entries.filter((e) => e.id !== entry.id), entry] };
  const written = await writeLibrary(root, next);
  return { ok: true, entry, dest: abs(root, createdDest), reused: false, library: next, hash: written.hash };
}

/**
 * @param {string} root
 * @param {{id: string, name: string, kind: 'animation'|'component'|'saved', sourcePath: string, sourceHash: string, params: ParamSchema, now?: Date|number|string}} input
 * @returns {Promise<LibraryEntry>}
 */
async function makeEntry(root, input) {
  /** @type {AssetRef[]} */
  const assets = [];
  /* 依赖只在条目里记相对路径；存在性每次现算（换机器/换盘也能如实显示） */
  const html = await fs.readFile(abs(root, input.sourcePath), 'utf8');
  const refs = scanAssetRefs(html);
  for (const ref of refs) assets.push({ ref, path: ref.replace(/^\.\//, '') });
  /* 存模板时顺手判一次「画面是不是 t 的函数」：连它 link 的 CSS 一起扫
     （S29 的 pulse 就是墙钟写在 pulse.css 里，只看 HTML 会误判成 true）。
     有样式表读不到 → 判不了 → 留空（unknown），不写死 true。 */
  const clock = await scanLinked(root, input.sourcePath, html);
  const deterministic = clock.hits.length > 0 ? false : clock.missing.length === 0 ? true : undefined;
  const snapshot = `motion/versions/${input.id}/${input.sourceHash.slice(0, 12)}.html`;
  await fs.mkdir(path.dirname(abs(root, snapshot)), { recursive: true });
  await fs.copyFile(abs(root, input.sourcePath), abs(root, snapshot)).catch(async (err) => {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') throw err;
  });
  return {
    id: input.id,
    name: input.name,
    kind: input.kind,
    sourcePath: input.sourcePath,
    sourceHash: input.sourceHash,
    assets,
    params: input.params,
    /* 判不了就整个键都不写（undefined 落盘也会消失，但内存里也别留着让人误读） */
    ...(deterministic === undefined ? {} : { deterministic }),
    version: 1,
    createdAt: toIso(input.now),
    history: [{ sourceHash: input.sourceHash, version: 1, snapshot }]
  };
}

/** @param {Date|number|string|undefined} now */
function toIso(now) {
  if (now === undefined) return new Date().toISOString();
  const d = now instanceof Date ? now : new Date(now);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

/**
 * 实例化：给片段一组参数，产出「片段形状」的结果，**不写模板源**。
 *
 * @param {string} root
 * @param {Library} library
 * @param {string} entryIdValue
 * @param {{clipId: string, params?: unknown}} opts
 * @returns {Promise<
 *   {ok: true, clip: {id: string, src: string, attrs: Record<string,string>, overrides: {at: string, style?: Record<string,string>, t?: string}[]}, values: ParamValues, rootAt: string, template: {id: string, version: number, sourceHash: string}}
 *   | {ok: false, code: 'TEMPLATE_MISSING'|'TEMPLATE_ARCHIVED'|'MISSING_ASSET'|'INVALID_PARAM'|'INVALID_SCHEMA'|'INVALID_CLIP_ID', message: string, errors?: ParamIssue[], missing?: AssetRef[]}
 * >}
 */
export async function instantiate(root, library, entryIdValue, opts) {
  const entry = findEntry(library, entryIdValue);
  if (!entry) return { ok: false, code: 'TEMPLATE_MISSING', message: `模板不存在：${entryIdValue}` };
  if (entry.archived) return { ok: false, code: 'TEMPLATE_ARCHIVED', message: `模板已归档：${entry.name}` };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(opts.clipId)) {
    return { ok: false, code: 'INVALID_CLIP_ID', message: 'clipId 只允许字母数字下划线连字符（1–64）' };
  }
  const assets = await checkAssets(root, entry);
  const missing = assets.filter((a) => !a.exists).map(({ ref, path: p }) => ({ ref, path: p }));
  if (missing.length) {
    return { ok: false, code: 'MISSING_ASSET', message: `模板依赖缺失：${missing.map((m) => m.ref).join(', ')}`, missing };
  }
  const checked = validateParams(entry.params, opts.params);
  if (!checked.ok) {
    return { ok: false, code: checked.code, message: describeIssues(checked.errors), errors: checked.errors };
  }
  const rootAt = `[data-instance="${opts.clipId}"]`;
  const overrides = overridesOf(entry.params, checked.values, rootAt);
  const attrs = {
    'data-instance': opts.clipId,
    'data-props': stableJson({
      template: entry.id,
      version: entry.version,
      sourceHash: entry.sourceHash,
      values: checked.values
    })
  };
  return {
    ok: true,
    clip: { id: opts.clipId, src: entry.sourcePath, attrs, overrides },
    values: checked.values,
    rootAt,
    template: { id: entry.id, version: entry.version, sourceHash: entry.sourceHash }
  };
}

/** @param {unknown} value */
export function stableJson(value) {
  return JSON.stringify(sortKeys(value));
}

/** @param {unknown} value @returns {unknown} */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of Object.keys(/** @type {Record<string, unknown>} */ (value)).sort()) {
      out[key] = sortKeys(/** @type {Record<string, unknown>} */ (value)[key]);
    }
    return out;
  }
  return value;
}

/**
 * 升级：源哈希变了才允许；记新版本 + 留快照，旧版本仍可回退。
 * @param {string} root
 * @param {Library} library
 * @param {string} id
 * @returns {Promise<{ok: true, from: string, to: string, version: number, library: Library}
 *   | {ok: false, code: 'TEMPLATE_MISSING'|'SOURCE_MISSING'|'NO_CHANGE', message: string}>}
 */
export async function upgradeTemplate(root, library, id) {
  const entry = findEntry(library, id);
  if (!entry) return { ok: false, code: 'TEMPLATE_MISSING', message: `模板不存在：${id}` };
  const source = await checkSource(root, entry);
  if (source.status === 'missing') return { ok: false, code: 'SOURCE_MISSING', message: `源不存在：${entry.sourcePath}` };
  if (source.status === 'current' || !source.actualHash) {
    return { ok: false, code: 'NO_CHANGE', message: '源哈希未变，无需升级' };
  }
  const snapshot = `motion/versions/${entry.id}/${source.actualHash.slice(0, 12)}.html`;
  await fs.mkdir(path.dirname(abs(root, snapshot)), { recursive: true });
  await fs.copyFile(abs(root, entry.sourcePath), abs(root, snapshot));
  const version = entry.version + 1;
  const nextEntry = {
    ...entry,
    sourceHash: source.actualHash,
    version,
    history: [...entry.history, { sourceHash: source.actualHash, version, snapshot }]
  };
  const next = { version: LIBRARY_VERSION, entries: library.entries.map((e) => (e.id === entry.id ? nextEntry : e)) };
  await writeLibrary(root, next);
  return { ok: true, from: entry.sourceHash, to: source.actualHash, version, library: next };
}

/**
 * 回退：把上一版的快照写回源文件，条目回到上一版哈希/版本号。
 * 回退后源文件字节与旧版一致，所以实例的**表现**可复现，而不只是元数据回滚。
 * @param {string} root
 * @param {Library} library
 * @param {string} id
 * @returns {Promise<{ok: true, restoredHash: string, version: number, library: Library}
 *   | {ok: false, code: 'TEMPLATE_MISSING'|'NO_HISTORY'|'SNAPSHOT_MISSING'|'IO', message: string}>}
 */
export async function rollbackTemplate(root, library, id) {
  const entry = findEntry(library, id);
  if (!entry) return { ok: false, code: 'TEMPLATE_MISSING', message: `模板不存在：${id}` };
  if (entry.history.length < 2) return { ok: false, code: 'NO_HISTORY', message: '没有可回退的上一版' };
  const prev = entry.history[entry.history.length - 2];
  if (!prev || !prev.snapshot) return { ok: false, code: 'SNAPSHOT_MISSING', message: '上一版没有快照' };
  /** @type {string} */
  let text;
  try {
    text = await fs.readFile(abs(root, prev.snapshot), 'utf8');
  } catch {
    return { ok: false, code: 'SNAPSHOT_MISSING', message: `快照不存在：${prev.snapshot}` };
  }
  const hash = sha256(text);
  if (hash !== prev.sourceHash) {
    return { ok: false, code: 'IO', message: `快照哈希不符：期望 ${prev.sourceHash}，实际 ${hash}` };
  }
  const target = abs(root, entry.sourcePath);
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(text, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, target);
  const nextEntry = { ...entry, sourceHash: prev.sourceHash, version: prev.version, history: entry.history.slice(0, -1) };
  const next = { version: LIBRARY_VERSION, entries: library.entries.map((e) => (e.id === entry.id ? nextEntry : e)) };
  await writeLibrary(root, next);
  return { ok: true, restoredHash: prev.sourceHash, version: prev.version, library: next };
}

/**
 * 删除：被实例引用时**拒绝**（给出引用者）；没人用则归档而不是物理删除。
 * @param {string} root
 * @param {Library} library
 * @param {string} id
 * @param {{referencedBy?: readonly string[]}} [opts]
 * @returns {Promise<{ok: true, archived: true, library: Library}
 *   | {ok: false, code: 'TEMPLATE_MISSING'|'TEMPLATE_IN_USE', message: string, referencedBy?: readonly string[]}>}
 */
export async function deleteTemplate(root, library, id, opts = {}) {
  const entry = findEntry(library, id);
  if (!entry) return { ok: false, code: 'TEMPLATE_MISSING', message: `模板不存在：${id}` };
  const refs = opts.referencedBy ?? [];
  if (refs.length) {
    return {
      ok: false,
      code: 'TEMPLATE_IN_USE',
      message: `模板仍被 ${refs.length} 个实例引用：${refs.join(', ')}；先删除实例或改用归档`,
      referencedBy: refs
    };
  }
  const nextEntry = { ...entry, archived: true };
  const next = { version: LIBRARY_VERSION, entries: library.entries.map((e) => (e.id === entry.id ? nextEntry : e)) };
  await writeLibrary(root, next);
  return { ok: true, archived: true, library: next };
}

/**
 * 哪些实例在用某个模板（实例可以是片段、也可以是库里记的引用表）。
 * @param {{clipId: string, templateId: string}[]} instances
 * @param {string} id
 * @returns {string[]}
 */
export function usageOf(instances, id) {
  return instances.filter((i) => i.templateId === id).map((i) => i.clipId).sort();
}

/**
 * 从片段的 `data-props` 读回模板与参数（检查器/重开时用）。
 * @param {Record<string, string>|undefined} attrs
 * @returns {{template: string, version: number, sourceHash: string, values: ParamValues} | null}
 */
export function propsOf(attrs) {
  const raw = attrs?.['data-props'];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      template: String(/** @type {any} */ (parsed).template ?? ''),
      version: Number(/** @type {any} */ (parsed).version ?? 0),
      sourceHash: String(/** @type {any} */ (parsed).sourceHash ?? ''),
      values: /** @type {ParamValues} */ (/** @type {any} */ (parsed).values ?? {})
    };
  } catch {
    return null;
  }
}
