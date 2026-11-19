/**
 * 多序列（M78 · B-MAIN-R30-038，WP26 第一阶段：数据模型 + API，**不含 UI**）。
 *
 * ## 结构（照任务书，不另造）
 *
 * - **一个序列 = 一份独立 film.html**，不是「一份文档里多条轨道」。方言不动。
 * - 默认序列 `main` 就在工程根（`<proj>/film.html`）——旧工程语义完全不变。
 * - 其它序列在 `<proj>/sequences/<id>/film.html`，**自带** `assets/`、`.film/`、`exports/`：
 *   每个序列是一个自包含的工程目录（因此导入、导出、图层、历史都不用改一行去「跨目录找素材」）。
 * - 工程级索引 `<proj>/.film/sequences.json`：
 *   `{version:1, current:"main", sequences:[{id,name,dir,stage,createdAt}]}`。
 * - **懒创建**：索引不存在时 `GET` 只返回单条 `main`（`dir` = 工程根），**一个字节都不落盘**；
 *   只有写操作（新建 / 切换 / 删除）才创建索引。
 *
 * ## 一致性
 *
 * - 每个序列在 registry 里是**独立的工程条目**（自己的写队列、自己的编辑会话、自己的 watcher）：
 *   往 A 写 `/ops` 不会碰 B 的 film.html，A/B 并发写也各有各的队列。
 * - 同一序列并发写仍走原来的乐观锁（同一个条目、同一条串行链、同一份 CAS）。
 * - 切换 current **只写索引**：任何 film.html 的 sha 都不变（证据里逐一记录）。
 *
 * ## 地址
 *
 * 工程 id `P` 指向「当前打开的序列」。`P::<seqId>` 是**序列作用域 id**：
 * 显式地址到某个序列（并发编辑 A/B、导出非当前序列时用），不改变 current。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { parse as parseFilm } from '../../film-core/film-doc.mjs';
import { minimalFilm, projectIdFor, sha256, writeFilmDirAtomic } from './project-create.mjs';
import { canonicalProjectDirectory } from './project-identity.mjs';
import { readProjectIndex } from './project-index.mjs';

export const MAIN_SEQUENCE = 'main';
export const SEQUENCES_INDEX_VERSION = 1;
/** 序列 id：与任务书一致（2–32 位，小写字母/数字开头）。 */
export const SEQUENCE_ID_RE = /^[a-z0-9][a-z0-9-_]{1,31}$/;
/** `POST /api/projects/:id/sequences` 的合法字段。 */
export const SEQUENCE_REQUEST_FIELDS = Object.freeze(['name', 'stage']);

/** `SEQUENCE_*` 错误：带 HTTP 状态与字段名。 */
export class SequenceError extends Error {
  /**
   * @param {string} code @param {number} status @param {string} message
   * @param {{ field?: string, extra?: Record<string, any> }} [options]
   */
  constructor(code, status, message, options = {}) {
    super(message);
    this.name = 'SequenceError';
    this.code = code;
    this.status = status;
    this.field = options.field ?? null;
    this.extra = options.extra ?? {};
  }
}

/** @param {string} projectDir @param {string} id */
export function sequenceDirOf(projectDir, id) {
  return id === MAIN_SEQUENCE ? projectDir : path.join(projectDir, 'sequences', id);
}

/** @param {string} projectDir @param {string} id */
export function sequenceFilmPathOf(projectDir, id) {
  return path.join(sequenceDirOf(projectDir, id), 'film.html');
}

/** @param {string} projectDir */
export function sequencesIndexPathOf(projectDir) {
  return path.join(projectDir, '.film', 'sequences.json');
}

/** @param {unknown} value */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `20261109T143015` 这类紧凑时间戳（与 versions / trash 同一写法）。 */
function stampOf(/** @type {Date} */ date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
}

/** @param {string} file */
async function fileExists(file) {
  try {
    const info = await fs.stat(file);
    return info.isFile();
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === 'ENOENT') return false;
    throw error;
  }
}

/** @param {string} file */
async function readTextOrNull(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * 读一个序列的现状：sha 现算、stage 现解析（GET 的「sha 必须现算」就是这里）。
 * @param {string} projectDir @param {string} id @param {any} [stored]
 */
async function inspectSequence(projectDir, id, stored = null) {
  const filmPath = sequenceFilmPathOf(projectDir, id);
  const text = await readTextOrNull(filmPath);
  if (text === null) {
    return {
      id,
      name: typeof stored?.name === 'string' && stored.name !== '' ? stored.name : id,
      dir: sequenceDirOf(projectDir, id),
      stage: null,
      filmHtmlSha256: null,
      bytes: 0,
      missing: true,
      createdAt: typeof stored?.createdAt === 'string' ? stored.createdAt : null,
    };
  }
  let parsed = null;
  try {
    parsed = parseFilm(text, { path: filmPath });
  } catch {
    parsed = null;
  }
  return {
    id,
    name: typeof stored?.name === 'string' && stored.name !== '' ? stored.name : id,
    dir: sequenceDirOf(projectDir, id),
    stage: parsed?.doc?.stage ?? null,
    filmHtmlSha256: sha256(text),
    bytes: Buffer.byteLength(text, 'utf8'),
    missing: false,
    createdAt: typeof stored?.createdAt === 'string' ? stored.createdAt : null,
  };
}

/** 懒索引：索引不存在时只描述 `main`（**不落盘**）。 @param {string} projectDir */
async function lazyIndex(projectDir) {
  const main = await inspectSequence(projectDir, MAIN_SEQUENCE);
  if (main.missing) {
    throw new SequenceError('FILM_NOT_FOUND', 404, `工程根没有 film.html：${projectDir}`);
  }
  return {
    version: SEQUENCES_INDEX_VERSION,
    current: MAIN_SEQUENCE,
    sequences: [{ id: MAIN_SEQUENCE, name: MAIN_SEQUENCE, dir: projectDir, stage: main.stage, createdAt: null }],
  };
}

/**
 * 读索引；不存在就返回懒索引（`materialized:false`）。
 * @param {string} projectDir
 * @returns {Promise<{ index: { version: number, current: string, sequences: any[] }, materialized: boolean, file: string, sha256: string|null }>}
 */
export async function readSequenceIndex(projectDir) {
  const file = sequencesIndexPathOf(projectDir);
  const text = await readTextOrNull(file);
  if (text === null) {
    return { index: await lazyIndex(projectDir), materialized: false, file, sha256: null };
  }
  /** @type {any} */
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new SequenceError('SEQUENCES_INDEX_INVALID', 409, `索引不是合法 JSON：${file}`, {
      extra: { reason: String(/** @type {Error} */ (error)?.message ?? error) },
    });
  }
  if (!isPlainObject(raw) || !Array.isArray(raw.sequences)) {
    throw new SequenceError('SEQUENCES_INDEX_INVALID', 409, `索引形状不对（需要 {version,current,sequences[]}）：${file}`);
  }
  /** @type {any[]} */
  const sequences = [];
  for (const item of raw.sequences) {
    if (!isPlainObject(item) || typeof item.id !== 'string' || !SEQUENCE_ID_RE.test(item.id)) {
      throw new SequenceError('SEQUENCES_INDEX_INVALID', 409, `索引里有非法序列 id：${JSON.stringify(item?.id ?? null)}`);
    }
    sequences.push({
      id: item.id,
      name: typeof item.name === 'string' && item.name !== '' ? item.name : item.id,
      dir: typeof item.dir === 'string' && item.dir !== '' ? item.dir : sequenceDirOf(projectDir, item.id),
      stage: isPlainObject(item.stage) ? { w: Number(item.stage.w), h: Number(item.stage.h) } : null,
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : null,
    });
  }
  // `main` 是结构下限：索引里丢了它也要补回来（否则「删掉 main」这种坏索引会静默生效）。
  if (!sequences.some((item) => item.id === MAIN_SEQUENCE)) {
    const main = await inspectSequence(projectDir, MAIN_SEQUENCE);
    sequences.unshift({ id: MAIN_SEQUENCE, name: MAIN_SEQUENCE, dir: projectDir, stage: main.stage, createdAt: null });
  }
  const current = typeof raw.current === 'string' && sequences.some((item) => item.id === raw.current) ? raw.current : MAIN_SEQUENCE;
  return {
    index: { version: Number(raw.version) || SEQUENCES_INDEX_VERSION, current, sequences },
    materialized: true,
    file,
    sha256: sha256(text),
  };
}

/**
 * 原子写索引：临时文件 → fsync → rename → fsync 目录（与本仓其它索引同一套）。
 * @param {string} projectDir @param {{ version: number, current: string, sequences: any[] }} index
 */
export async function writeSequenceIndex(projectDir, index) {
  const file = sequencesIndexPathOf(projectDir);
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.sequences.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  const text = `${JSON.stringify(index, null, 2)}\n`;
  try {
    const handle = await fs.open(tmp, 'wx');
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  try {
    const dirHandle = await fs.open(dir, 'r');
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // 目录 fsync 失败不改结论（文件已经在盘上）。
  }
  return { file, sha256: sha256(text), bytes: Buffer.byteLength(text, 'utf8') };
}

/**
 * `GET /api/projects/:id/sequences`
 * @param {string} projectDir
 */
export async function listSequences(projectDir) {
  const read = await readSequenceIndex(projectDir);
  /** @type {any[]} */
  const sequences = [];
  for (const item of read.index.sequences) {
    sequences.push(await inspectSequence(projectDir, item.id, item));
  }
  return {
    ok: true,
    current: read.index.current,
    sequences,
    materialized: read.materialized,
    indexPath: read.file,
    indexSha256: read.sha256,
  };
}

/** @param {unknown} name @returns {string} */
export function validateSequenceId(name) {
  if (typeof name !== 'string') {
    throw new SequenceError('SEQUENCE_NAME_INVALID', 400, 'name 必须是字符串', { field: 'name' });
  }
  const value = name.trim();
  if (value === '') throw new SequenceError('SEQUENCE_NAME_INVALID', 400, 'name 不能为空', { field: 'name' });
  if (!SEQUENCE_ID_RE.test(value)) {
    throw new SequenceError(
      'SEQUENCE_NAME_INVALID',
      400,
      `name 必须匹配 ${SEQUENCE_ID_RE.source}（收到 ${value}）`,
      { field: 'name' },
    );
  }
  return value;
}

/** @param {unknown} stage @returns {{ w: number, h: number }} */
export function validateSequenceStage(stage) {
  if (stage === undefined || stage === null) return { w: 1920, h: 1080 };
  if (!isPlainObject(stage)) {
    throw new SequenceError('SEQUENCE_STAGE_INVALID', 400, 'stage 必须是 {w,h}', { field: 'stage' });
  }
  for (const dim of /** @type {const} */ (['w', 'h'])) {
    const size = /** @type {any} */ (stage)[dim];
    if (!Number.isInteger(size) || size < 1 || size > 8192) {
      throw new SequenceError(
        'SEQUENCE_STAGE_INVALID',
        400,
        `stage.${dim} 必须是 1..8192 的整数（收到 ${String(size)}）`,
        { field: `stage.${dim}` },
      );
    }
  }
  return { w: Number(/** @type {any} */ (stage).w), h: Number(/** @type {any} */ (stage).h) };
}

/**
 * `POST /api/projects/:id/sequences`：原子建目录（复用 project-create 的原子写），再落索引。
 * @param {{ projectDir: string, name: unknown, stage?: unknown, now?: Date, probe?: (context: { tmpDir: string, targetDir: string, filmPath: string }) => void|Promise<void> }} input
 */
export async function createSequence(input) {
  const id = validateSequenceId(input.name);
  const stage = validateSequenceStage(input.stage);
  const read = await readSequenceIndex(input.projectDir);
  if (read.index.sequences.some((item) => item.id === id)) {
    throw new SequenceError('SEQUENCE_EXISTS', 409, `序列已存在：${id}`, { extra: { id } });
  }

  const html = minimalFilm({ w: stage.w, h: stage.h });
  const written = await writeFilmDirAtomic({
    parent: path.join(input.projectDir, 'sequences'),
    name: id,
    html,
    ...(typeof input.probe === 'function' ? { probe: input.probe } : {}),
  });

  const createdAt = (input.now ?? new Date()).toISOString();
  const next = {
    version: SEQUENCES_INDEX_VERSION,
    current: read.index.current,
    sequences: [
      ...read.index.sequences.map((item) => ({
        id: item.id,
        name: item.name,
        dir: item.dir,
        stage: item.stage,
        createdAt: item.createdAt,
      })),
      { id, name: id, dir: written.dir, stage, createdAt },
    ],
  };
  try {
    const saved = await writeSequenceIndex(input.projectDir, next);
    return {
      ok: true,
      sequence: {
        id,
        name: id,
        dir: written.dir,
        stage,
        filmHtmlSha256: written.filmHtmlSha256,
        bytes: written.bytes,
        createdAt,
      },
      current: next.current,
      index: { path: saved.file, sha256: saved.sha256 },
      template: 'default',
    };
  } catch (error) {
    // 索引没写成功 = 没人知道这条序列：把刚建的目录收回去，不留孤儿。
    await fs.rm(written.dir, { recursive: true, force: true }).catch(() => undefined);
    throw new SequenceError('SEQUENCES_INDEX_WRITE_FAILED', 500, `索引写入失败：${String(/** @type {Error} */ (error)?.message ?? error)}`);
  }
}

/**
 * `PUT /api/projects/:id/sequences/current`：**只改索引的 current**，不碰任何 film.html。
 * @param {string} projectDir @param {unknown} id @param {{ now?: Date }} [options]
 */
export async function setCurrentSequence(projectDir, id, options = {}) {
  const wanted = validateSequenceId(id);
  const read = await readSequenceIndex(projectDir);
  const known = read.index.sequences.find((item) => item.id === wanted);
  if (known === undefined) {
    throw new SequenceError('SEQUENCE_NOT_FOUND', 404, `没有这个序列：${wanted}`);
  }
  /** 现算所有序列的 sha（切换前后各一次，证明「一个字节都没动」）。 */
  const shas = async () => {
    /** @type {Record<string, string|null>} */
    const out = {};
    for (const item of read.index.sequences) {
      const inspected = await inspectSequence(projectDir, item.id, item);
      out[item.id] = inspected.filmHtmlSha256;
    }
    return out;
  };
  const before = await shas();

  // 旧工程 + 切到 main：已经是 current，**不为了「切到自己」凭空造一个索引**。
  if (!read.materialized && wanted === read.index.current) {
    return {
      ok: true,
      current: wanted,
      changed: false,
      materialized: false,
      shas: { before, after: before },
      index: { path: read.file, sha256: null, beforeSha256: null },
    };
  }

  const next = {
    version: SEQUENCES_INDEX_VERSION,
    current: wanted,
    sequences: read.index.sequences.map((item) => ({
      id: item.id,
      name: item.name,
      dir: item.dir,
      stage: item.stage,
      createdAt: item.createdAt,
    })),
  };
  const saved = await writeSequenceIndex(projectDir, next);
  return {
    ok: true,
    current: wanted,
    changed: read.index.current !== wanted,
    materialized: true,
    shas: { before, after: await shas() },
    index: { path: saved.file, sha256: saved.sha256, beforeSha256: read.sha256 },
  };
}

/**
 * `DELETE /api/projects/:id/sequences/:sid`：只移 `.film/trash/`，**从不真删**。
 * @param {string} projectDir @param {unknown} sid @param {{ now?: Date }} [options]
 */
export async function removeSequence(projectDir, sid, options = {}) {
  const id = validateSequenceId(sid);
  const read = await readSequenceIndex(projectDir);
  const known = read.index.sequences.find((item) => item.id === id);
  if (known === undefined) {
    throw new SequenceError('SEQUENCE_NOT_FOUND', 404, `没有这个序列：${id}`);
  }
  /* 顺序有意如此：「只剩一条」是结构下限（删了就再没有东西可打开），
     比「main 保留」更早判 —— 只有一条时删 main 报 LAST，多条时删 main 报 PROTECTED。 */
  if (read.index.sequences.length <= 1) {
    throw new SequenceError('SEQUENCE_LAST', 409, '这是最后一个序列，不能删除');
  }
  if (id === MAIN_SEQUENCE) {
    throw new SequenceError('SEQUENCE_PROTECTED', 409, 'main 是默认序列，不能删除');
  }
  if (read.index.current === id) {
    throw new SequenceError('SEQUENCE_IS_CURRENT', 409, `序列 ${id} 是当前序列，先切到别的序列再删`);
  }

  const source = sequenceDirOf(projectDir, id);
  const stamp = stampOf(options.now ?? new Date());
  const trashRoot = path.join(projectDir, '.film', 'trash');
  await fs.mkdir(trashRoot, { recursive: true });
  /** @type {string} */
  let target = path.join(trashRoot, `${id}-${stamp}`);
  for (let attempt = 2; attempt < 100; attempt += 1) {
    if (!(await fileExists(path.join(target, 'film.html'))) && !(await fs.stat(target).then(() => true).catch(() => false))) break;
    target = path.join(trashRoot, `${id}-${stamp}-${attempt}`);
  }
  await fs.rename(source, target);

  const next = {
    version: SEQUENCES_INDEX_VERSION,
    current: read.index.current,
    sequences: read.index.sequences
      .filter((item) => item.id !== id)
      .map((item) => ({ id: item.id, name: item.name, dir: item.dir, stage: item.stage, createdAt: item.createdAt })),
  };
  try {
    const saved = await writeSequenceIndex(projectDir, next);
    return {
      ok: true,
      removed: id,
      trash: target,
      current: next.current,
      index: { path: saved.file, sha256: saved.sha256 },
    };
  } catch (error) {
    // 索引没改成 = 序列还在索引里：把目录搬回去，别让索引指向一个空位置。
    await fs.rename(target, source).catch(() => undefined);
    throw new SequenceError('SEQUENCES_INDEX_WRITE_FAILED', 500, `索引写入失败：${String(/** @type {Error} */ (error)?.message ?? error)}`);
  }
}

/* ── registry 包装：稳定工程 id → 具体序列条目 ────────────────────────── */

/** @param {string} projectId @param {string} sequenceId */
function slotKey(projectId, sequenceId) {
  return `${projectId}::${sequenceId}`;
}

/** @param {string} key */
function splitKey(key) {
  if (typeof key !== 'string' || key === '') return null;
  const at = key.indexOf('::');
  if (at < 0) return { projectId: key, sequenceId: null };
  const sequenceId = key.slice(at + 2);
  return { projectId: key.slice(0, at), sequenceId: sequenceId === '' ? null : sequenceId };
}

/**
 * 把 `createProjectRegistry` 包一层：对外仍是「一个工程一个 id」，内部按序列分条目。
 * @param {{
 *   registry: any,
 *   home?: string,
 *   now?: () => Date,
 * }} options
 */
export function createSequenceRegistry(options) {
  const registry = options.registry;
  const home = options.home;
  const now = options.now ?? (() => new Date());

  /** 工程 id → 工程根目录 */
  const projectDirs = new Map();
  /** 工程 id → 当前打开/切换到的序列 */
  const active = new Map();
  /** `<P>::<seq>` → registry 条目 id */
  const entries = new Map();
  /** registry 条目 id → 工程 id */
  const ownerOf = new Map();
  /** registry 条目 id → 序列 id */
  const sequenceOf = new Map();
  /** 工程 id → 它开着的所有槽位 */
  const slotsOf = new Map();

  /** @param {string} projectId @param {string} projectDir @param {string} sequenceId @param {string} entryId */
  function register(projectId, projectDir, sequenceId, entryId) {
    projectDirs.set(projectId, projectDir);
    entries.set(slotKey(projectId, sequenceId), entryId);
    ownerOf.set(entryId, projectId);
    sequenceOf.set(entryId, sequenceId);
    const slots = slotsOf.get(projectId) ?? new Set();
    slots.add(slotKey(projectId, sequenceId));
    slotsOf.set(projectId, slots);
  }

  /** @param {string} projectId */
  async function resolveDir(projectId) {
    const known = projectDirs.get(projectId);
    if (known !== undefined) return known;
    const index = await readProjectIndex({ home }).catch(() => ({ projects: [] }));
    for (const item of index.projects ?? []) {
      if (typeof item?.path !== 'string' || item.path === '') continue;
      if (projectIdFor(item.path) === projectId) {
        projectDirs.set(projectId, item.path);
        return item.path;
      }
    }
    return null;
  }

  /** 同步解析：拿当前 / 指定序列的 registry 条目 id。 @param {string} key */
  function slotOf(key) {
    if (typeof key !== 'string' || key === '') return null;
    /* 兼容旧调用方：有些模块拿 `project.projectId`（= registry 条目 id）回查，
       那是内部 id 不是工程 id —— 认得出来就映射回 (工程, 序列)。 */
    /* 注意：main 序列的条目 id 与工程 id 是同一个值（同一个目录、同一个公式），
       所以「这是不是内部条目 id」必须在「这是不是已知工程 id」之后判。 */
    if (!projectDirs.has(key) && sequenceOf.has(key)) {
      return { projectId: ownerOf.get(key) ?? key, sequenceId: sequenceOf.get(key), entryId: key };
    }
    const parts = splitKey(key);
    if (parts === null) return null;
    const sequenceId = parts.sequenceId ?? active.get(parts.projectId)?.sequenceId ?? null;
    if (sequenceId === null) return null;
    const entryId = entries.get(slotKey(parts.projectId, sequenceId));
    if (entryId === undefined) return null;
    return { projectId: parts.projectId, sequenceId, entryId };
  }

  /**
   * 确保条目已开（`P::seq` 未开就先开；**不改 current**）。
   * @param {string} key
   */
  async function ensureEntry(key) {
    /* 内部条目 id（模块之间拿 `project.projectId` 回查）：直接用，不再往工程目录上解析。 */
    if (typeof key === 'string' && !projectDirs.has(key) && sequenceOf.has(key)) {
      const direct = registry.get(key);
      if (direct !== null) return direct;
    }
    const parts = splitKey(key);
    if (parts === null) return null;
    const projectDir = await resolveDir(parts.projectId);
    if (projectDir === null) return null;
    /** @type {any} */
    let index;
    try {
      index = await readSequenceIndex(projectDir);
    } catch {
      return null;
    }
    /* 裸工程 id 只认「已经开着」的序列：关掉的工程不该因为一次写入被悄悄重新打开。
       `P::<seq>` 才是显式寻址（那里允许按需打开）。 */
    const sequenceId = parts.sequenceId ?? active.get(parts.projectId)?.sequenceId ?? null;
    if (sequenceId === null) return null;
    if (!index.index.sequences.some((/** @type {any} */ item) => item.id === sequenceId)) return null;

    const slot = slotKey(parts.projectId, sequenceId);
    const existingId = entries.get(slot);
    if (existingId !== undefined) {
      const entry = registry.get(existingId);
      if (entry !== null) return entry;
      entries.delete(slot);
    }
    const film = sequenceFilmPathOf(projectDir, sequenceId);
    if (!(await fileExists(film))) return null;
    const opened = await registry.open(sequenceDirOf(projectDir, sequenceId));
    if (opened.ok !== true) return null;
    register(parts.projectId, projectDir, sequenceId, opened.project.projectId);
    return opened.project;
  }

  /** @param {string} entryId */
  function decorate(entryId) {
    const raw = registry.summary(entryId);
    if (raw === null) return null;
    const projectId = ownerOf.get(entryId) ?? entryId;
    const sequenceId = sequenceOf.get(entryId) ?? MAIN_SEQUENCE;
    const projectDir = projectDirs.get(projectId) ?? raw.path;
    return {
      ...raw,
      projectId,
      path: projectDir,
      name: path.basename(projectDir),
      filmPath: sequenceFilmPathOf(projectDir, sequenceId),
      sequence: { id: sequenceId, name: sequenceId },
    };
  }

  return {
    /* ── 读 ─────────────────────────────────────────────────────────── */
    /** 同步：路由里大量 `registry.summary(id)` 是同步调用的。 @param {string} key */
    summary(key) {
      const slot = slotOf(key);
      if (slot === null) {
        // 工程还没开过任何序列：给一条「只有 main」的投影，别让 UI 以为工程不存在。
        const parts = splitKey(key);
        const dir = parts === null ? undefined : projectDirs.get(parts.projectId);
        if (parts === null || parts.sequenceId !== null || dir === undefined) return null;
        const raw = registry.summary(parts.projectId);
        return raw === null ? null : decorate(parts.projectId);
      }
      return decorate(slot.entryId);
    },
    /** @param {string} key */
    get(key) {
      const slot = slotOf(key);
      return slot === null ? null : registry.get(slot.entryId);
    },
    /** @param {string} key */
    docOf(key) {
      const slot = slotOf(key);
      return slot === null ? null : registry.docOf(slot.entryId);
    },
    /**
     * 读 doc 的异步版：`P::<seq>` 还没打开时先开（读一次不该要求调用方先 open）。
     * @param {string} key
     */
    async docOfAsync(key) {
      const entry = await ensureEntry(key);
      return entry === null ? null : registry.docOf(entry.projectId);
    },
    /**
     * 拿条目（必要时打开）。媒体导入这类「先读再写」的路由用它。
     * @param {string} key
     */
    async getAsync(key) {
      return ensureEntry(key);
    },
    /** @param {string} key */
    thumbnails(key) {
      const slot = slotOf(key);
      return slot === null ? null : registry.thumbnails(slot.entryId);
    },
    /** @param {string} key @param {string[]|undefined} [clipIds] */
    requestThumbnails(key, clipIds) {
      const slot = slotOf(key);
      return slot === null ? null : registry.requestThumbnails(slot.entryId, clipIds);
    },
    /** @param {string} key @param {{ playhead?: number, selection?: unknown[] }} view */
    setView(key, view) {
      const slot = slotOf(key);
      return slot === null ? { ok: false, code: 'FILM_NOT_FOUND' } : registry.setView(slot.entryId, view);
    },
    /** @param {string} key @param {string} cwd */
    setCwd(key, cwd) {
      const slot = slotOf(key);
      return slot === null ? { ok: false, code: 'FILM_NOT_FOUND' } : registry.setCwd(slot.entryId, cwd);
    },
    summaries() {
      /** @type {Map<string, any>} */
      const byProject = new Map();
      for (const entryId of ownerOf.keys()) {
        const view = decorate(entryId);
        if (view === null) continue;
        const isActive = active.get(view.projectId)?.sequenceId === view.sequence.id;
        if (isActive || !byProject.has(view.projectId)) byProject.set(view.projectId, view);
      }
      return [...byProject.values()];
    },
    stats() {
      return registry.stats();
    },
    /** @param {string} root */
    async list(root) {
      const listed = await registry.list(root);
      if (listed.ok !== true) return listed;
      return {
        ...listed,
        projects: listed.projects.map((/** @type {any} */ item) => ({
          ...item,
          opened: item.opened === true || projectDirs.has(projectIdFor(item.path)),
        })),
      };
    },

    /* ── 写 ─────────────────────────────────────────────────────────── */
    /** @param {string} dirPath @param {{ sequence?: string|null }} [openOptions] */
    async open(dirPath, openOptions = {}) {
      if (typeof dirPath !== 'string' || dirPath.trim() === '') {
        return { ok: false, code: 'FILM_NOT_FOUND', message: '工程路径为空' };
      }
      const projectDir = canonicalProjectDirectory(dirPath);
      /** @type {any} */
      let read;
      try {
        read = await readSequenceIndex(projectDir);
      } catch (error) {
        if (error instanceof SequenceError) {
          return { ok: false, code: error.code, message: error.message, status: error.status };
        }
        throw error;
      }
      const explicit = /** @type {any} */ (openOptions).sequence;
      const hasExplicit = typeof explicit === 'string' && explicit !== '';
      if (hasExplicit && !SEQUENCE_ID_RE.test(explicit)) {
        return { ok: false, code: 'SEQUENCE_NAME_INVALID', status: 400, message: `序列 id 非法：${explicit}` };
      }
      const wanted = hasExplicit ? explicit : read.index.current;
      const known = read.index.sequences.find((/** @type {any} */ item) => item.id === wanted);
      if (known === undefined) {
        return { ok: false, code: 'SEQUENCE_NOT_FOUND', message: `没有这个序列：${wanted}`, status: 404 };
      }
      const opened = await registry.open(sequenceDirOf(projectDir, wanted));
      if (opened.ok !== true) return opened;
      const projectId = projectIdFor(projectDir);
      register(projectId, projectDir, wanted, opened.project.projectId);
      active.set(projectId, { sequenceId: wanted });
      /** @type {any} */
      let index = { ok: true, written: false, path: read.file, sha256: read.sha256 };
      if (hasExplicit) {
        try {
          const switched = await setCurrentSequence(projectDir, wanted);
          index = { ok: true, written: switched.materialized, path: switched.index.path, sha256: switched.index.sha256 };
        } catch (error) {
          if (error instanceof SequenceError) {
            return { ok: false, code: error.code, status: error.status, message: error.message };
          }
          throw error;
        }
      }
      return {
        ok: true,
        existing: opened.existing,
        projectId,
        sequence: { id: wanted, name: known.name },
        /* 给路由的是**真条目**（带 doc/dir/queue/session）：
           封面抽帧、缩略请求这类逻辑要读 `project.doc` 与 `project.dir`，摘要对象给不了。 */
        project: opened.project,
        summary: decorate(opened.project.projectId),
        index,
      };
    },
    /** @param {string} key @param {any} envelope @param {readonly any[]} ops */
    async applyOps(key, envelope, ops) {
      const entry = await ensureEntry(key);
      if (entry === null) return { ok: false, code: 'FILM_NOT_FOUND', message: `工程未打开：${key}` };
      return registry.applyOps(entry.projectId, envelope, ops);
    },
    /** @param {string} key @param {{ expectedHash?: string }} [input] */
    async undo(key, input) {
      const entry = await ensureEntry(key);
      if (entry === null) return { ok: false, code: 'FILM_NOT_FOUND' };
      return registry.undo(entry.projectId, input);
    },
    /** @param {string} key @param {{ expectedHash?: string }} [input] */
    async redo(key, input) {
      const entry = await ensureEntry(key);
      if (entry === null) return { ok: false, code: 'FILM_NOT_FOUND' };
      return registry.redo(entry.projectId, input);
    },
    /** @param {string} key @param {any} payload */
    async write(key, payload) {
      const entry = await ensureEntry(key);
      if (entry === null) return { ok: false, error: { code: 'FILM_NOT_FOUND', message: `工程未打开：${key}` } };
      return registry.write(entry.projectId, payload);
    },
    /** @param {string} key @param {{ waitMs?: number }} [input] */
    async close(key, input = {}) {
      const parts = splitKey(key);
      if (parts === null) return { ok: false, code: 'FILM_NOT_FOUND', message: '工程未打开' };
      const slot = slotOf(key);
      const projectId = slot?.projectId ?? parts.projectId;
      const slots = [...(slotsOf.get(projectId) ?? new Set())];
      if (slots.length === 0) return { ok: false, code: 'FILM_NOT_FOUND', message: '工程未打开' };
      /** @type {any} */
      let result = null;
      for (const one of slots) {
        const entryId = entries.get(one);
        if (entryId === undefined) continue;
        const closed = await registry.close(entryId, input);
        if (result === null) result = closed;
        entries.delete(one);
        ownerOf.delete(entryId);
        sequenceOf.delete(entryId);
      }
      slotsOf.delete(projectId);
      active.delete(projectId);
      return { ...(result ?? { ok: true }), closedSequences: slots.length };
    },
    async closeAll() {
      const results = await registry.closeAll();
      for (const map of [entries, ownerOf, sequenceOf, active, slotsOf]) map.clear();
      projectDirs.clear();
      return results;
    },

    /* ── 序列专用 ───────────────────────────────────────────────────── */
    /** @param {string} projectId */
    async projectDirOf(projectId) {
      return resolveDir(projectId);
    },
    /**
     * 导出目标：拿到某个序列的 doc / 目录 / 序列信息（非当前序列也能导）。
     * @param {string} projectId @param {string|undefined|null} sequenceId
     */
    async sequenceTarget(projectId, sequenceId) {
      const projectDir = await resolveDir(projectId);
      if (projectDir === null) return { ok: false, code: 'FILM_NOT_FOUND', status: 404, message: `工程未知：${projectId}` };
      /** @type {any} */
      let read;
      try {
        read = await readSequenceIndex(projectDir);
      } catch (error) {
        if (error instanceof SequenceError) {
          return { ok: false, code: error.code, status: error.status, message: error.message };
        }
        throw error;
      }
      /* 不传 sequence = 当前打开的序列：工程没开就 404（与「关掉的工程不接受操作」一致）。
         传了 = 那个序列，工程开着就够（不必是当前序列，也不必先打开它）。 */
      const explicit = typeof sequenceId === 'string' && sequenceId !== '';
      const activeId = active.get(projectId)?.sequenceId ?? null;
      if (!explicit && activeId === null) {
        return { ok: false, code: 'FILM_NOT_FOUND', status: 404, message: `工程未打开：${projectId}` };
      }
      const wanted = explicit ? String(sequenceId) : activeId;
      const known = read.index.sequences.find((/** @type {any} */ item) => item.id === wanted);
      if (known === undefined) {
        return { ok: false, code: 'SEQUENCE_NOT_FOUND', status: 404, message: `没有这个序列：${wanted}` };
      }
      const dir = sequenceDirOf(projectDir, wanted);
      const entry = await ensureEntry(slotKey(projectId, wanted));
      if (entry !== null) {
        const current = registry.docOf(entry.projectId);
        if (current !== null) {
          return {
            ok: true,
            project: entry,
            doc: current.doc,
            hash: current.hash,
            dir,
            sequence: { id: wanted, name: known.name ?? wanted },
          };
        }
      }
      const text = await readTextOrNull(sequenceFilmPathOf(projectDir, wanted));
      if (text === null) {
        return { ok: false, code: 'SEQUENCE_NOT_FOUND', status: 404, message: `序列目录不完整：${wanted}` };
      }
      const parsed = parseFilm(text, { path: sequenceFilmPathOf(projectDir, wanted) });
      if (parsed.doc === null) {
        return { ok: false, code: 'FILM_INVALID', status: 422, message: 'film.html 存在错误级诊断', diagnostics: parsed.diagnostics };
      }
      return {
        ok: true,
        project: { projectId, dir, filmPath: sequenceFilmPathOf(projectDir, wanted) },
        doc: parsed.doc,
        hash: parsed.sourceHash,
        dir,
        sequence: { id: wanted, name: known.name ?? wanted },
      };
    },
    /** 当前打开/切换到的序列（导出缺省用）。 @param {string} projectId */
    activeSequenceOf(projectId) {
      return active.get(projectId)?.sequenceId ?? null;
    },
    /**
     * 给路由用：切 current 后同步「哪个序列算当前」。
     * **只有工程真的开着才记**：没开过的工程切 current 只是改索引，别因此让下一次写入把它悄悄打开。
     * @param {string} projectId @param {string} sequenceId
     */
    markActive(projectId, sequenceId) {
      const open = (slotsOf.get(projectId)?.size ?? 0) > 0;
      if (sequenceId === '' || !open) active.delete(projectId);
      else active.set(projectId, { sequenceId });
    },
    /** 已开条目 id（证据脚本用来证明 A/B 各有独立队列）。 @param {string} projectId */
    entryIdsOf(projectId) {
      return [...(slotsOf.get(projectId) ?? new Set())].map((one) => ({ slot: one, entryId: entries.get(one) ?? null }));
    },
  };
}
