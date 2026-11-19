/**
 * 新建工程（M75 · B-MAIN-R30-037，WP01）。
 *
 * ## 为什么要有它
 *
 * M73 的 30 秒闭环第一步是「脚本自己 `mkdir` + `writeFile` 造一个空工程」，也就是说
 * 「从零开始一个工程」这件事在产品里**没有入口**——WP01 的端到端证明因此有一半是
 * 测试脚本的私有动作。本模块把这一步变成真 API：
 *
 *   `POST /api/projects/create {name, dir?, template?} → {projectId, dir, filmHtmlSha256}`
 *
 * ## 落盘规格（与 settings-store / project-index / versions 同一套）
 *
 * 1. 校验（名字 / 模板 / 路径边界）**全部在碰磁盘之前**做完；
 * 2. 在**父目录**里建临时目录 `.name.tmp-<pid>-<rand>`，写 `film.html` → `fsync` 文件 →
 *    `fsync` 目录 → **rename** 成正式目录；中途任何失败都删掉临时目录，
 *    正式目录一个字节都不留（断言「目录不存在」是验收 A6 的判据）；
 * 3. rename 到已存在的目录会 `ENOTEMPTY`/`EEXIST`：**不覆盖**，映射成 `409 PROJECT_EXISTS`。
 *    并发同名靠这一层（OS 的原子 rename）+ 进程内的 pending 集合双保险；
 * 4. rename 成功后再回读 `film.html` 复算 sha，与模板 sha 比对——落盘的不是模板就报错，
 *    绝不「写了个别的文件还说成功」；
 * 5. 最后写最近工程索引（`~/.opencut/projects.json`），让 `GET /api/projects` 的
 *    `recent` 与磁盘一致。索引失败**不回滚**已建好的工程（工程已经在盘上了），
 *    只在响应里 `index.ok=false` 如实说明。
 *
 * ## dir 语义（明确写死，避免两种解读）
 *
 * `dir` 是**父目录**，工程目录 = `<dir>/<name>`；缺省 = `projectsRoot`（没有则 cwd）。
 * `dir` 必须落在允许根内，否则 `E_PATH_ESCAPE`，且**在落盘前**抛。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { recordProjectOpen, readProjectIndex } from './project-index.mjs';
import { canonicalProjectDirectory } from './project-identity.mjs';
import { isInside } from './project-file.mjs';

/** 模板版本：模板文本变了就升这个号，证据里能看出用的是哪一版。 */
export const PROJECT_TEMPLATE_VERSION = '1.0.0';

/** `POST /api/projects/create` 的合法字段（未知字段一律 400）。 */
export const CREATE_REQUEST_FIELDS = Object.freeze(['name', 'dir', 'template']);

/** 名字长度上限（1–64）。 */
export const MAX_PROJECT_NAME = 64;

/** 默认模板 id。 */
export const DEFAULT_TEMPLATE = 'default';

/** 模板登记表：v1 只有 `default`（1920×1080、空时间线）。 */
export const TEMPLATES = Object.freeze({
  [DEFAULT_TEMPLATE]: Object.freeze({ id: DEFAULT_TEMPLATE, w: 1920, h: 1080 }),
});

/** 控制字符（含 DEL）：名字里出现就拒。 */
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * 模板的最小 film.html。
 *
 * 刻意**不含工程名**：同一个模板必须产出同一个 sha（验收 A10「模板 sha 稳定」），
 * 名字只进索引与响应。舞台尺寸写在 viewport 里（film-doc 的唯一来源）。
 *
 * body 里**必须有一条空 `<section>`**：film-doc 的写路径在「文档里没有 <section> 轨道」时
 * 直接拒绝写入（`insert` 会 400），所以「空工程」= 一条空轨 + 0 个片段，
 * 而不是「一个 section 都没有」。`/api/layers` 因此会读到这一条空轨（1 层、0 片段）——
 * 这是 film 方言的结构下限，不是模板偷懒。
 * @param {{ w?: number, h?: number, title?: string }} [input]
 * @returns {string}
 */
export function minimalFilm(input = {}) {
  const w = Number.isInteger(input.w) && Number(input.w) > 0 ? Number(input.w) : 1920;
  const h = Number.isInteger(input.h) && Number(input.h) > 0 ? Number(input.h) : 1080;
  const title = typeof input.title === 'string' && input.title !== '' ? input.title : 'OpenCut 工程';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${w}, height=${h}">
<title>${title}</title>
</head>
<body>
<section id="main"></section>
</body>
</html>
`;
}

/** @param {string} text */
export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 工程 id 的公式：与 `projects.mjs` 的 `registry.open` **同一个**（绝对路径的 sha256 前 16 位）。
 * 单测有一条专门对拍：create 回的 id 必须等于 open 之后 `/api/projects/:id` 用的 id。
 * @param {string} dir
 */
export function projectIdFor(dir) {
  return sha256(canonicalProjectDirectory(dir)).slice(0, 16);
}


/**
 * 建工程的错误：带 HTTP 状态与字段名（400 时告诉调用方是哪个字段坏了）。
 */
export class ProjectCreateError extends Error {
  /**
   * @param {string} code
   * @param {number} status
   * @param {string} message
   * @param {{ field?: string, extra?: Record<string, unknown> }} [options]
   */
  constructor(code, status, message, options = {}) {
    super(message);
    this.name = 'ProjectCreateError';
    this.code = code;
    this.status = status;
    this.field = options.field ?? null;
    this.extra = options.extra ?? {};
  }
}

/**
 * 名字校验：非空、1–64、不含 `/`、`\`、控制字符，也不是 `.` / `..`。
 * @param {unknown} name
 * @returns {string}
 */
export function validateProjectName(name) {
  if (typeof name !== 'string') {
    throw new ProjectCreateError('PROJECT_NAME_INVALID', 400, 'name 必须是字符串', { field: 'name' });
  }
  const value = name.trim();
  if (value === '') {
    throw new ProjectCreateError('PROJECT_NAME_INVALID', 400, 'name 不能为空', { field: 'name' });
  }
  if (value.length > MAX_PROJECT_NAME) {
    throw new ProjectCreateError(
      'PROJECT_NAME_INVALID',
      400,
      `name 最长 ${MAX_PROJECT_NAME} 个字符（收到 ${value.length}）`,
      { field: 'name' },
    );
  }
  if (value.includes('/') || value.includes('\\')) {
    throw new ProjectCreateError('PROJECT_NAME_INVALID', 400, 'name 不能包含 / 或 \\', { field: 'name' });
  }
  if (CONTROL_RE.test(value)) {
    throw new ProjectCreateError('PROJECT_NAME_INVALID', 400, 'name 不能包含控制字符', { field: 'name' });
  }
  if (value === '.' || value === '..') {
    throw new ProjectCreateError('PROJECT_NAME_INVALID', 400, 'name 不能是 . 或 ..', { field: 'name' });
  }
  return value;
}

/**
 * 模板校验：只认登记表里的 id。
 * @param {unknown} template
 * @returns {{ id: string, w: number, h: number }}
 */
export function resolveTemplate(template) {
  const id = template === undefined || template === null || template === '' ? DEFAULT_TEMPLATE : String(template);
  const hit = TEMPLATES[/** @type {keyof typeof TEMPLATES} */ (id)];
  if (hit === undefined) {
    throw new ProjectCreateError(
      'PROJECT_TEMPLATE_UNKNOWN',
      400,
      `不认识的模板：${id}（可用 ${Object.keys(TEMPLATES).join('/')}）`,
      { field: 'template' },
    );
  }
  return /** @type {{ id: string, w: number, h: number }} */ (hit);
}

/** 正在建的目录（进程内并发同名第二只手直接 409，不用等 OS）。 `@type {Set<string>}` */
const pending = new Set();

/**
 * 原子写一个「只含 film.html 的目录」（M78 起 `createProject` 与 `sequences` 共用）。
 *
 * 顺序：校验/占用 → `mkdir` 父目录 → 临时目录 `.name.tmp-<pid>-<rand>` → 写 film.html →
 * fsync 文件 → fsync 目录 → （可选 probe）→ 回读 sha → **rename** → fsync 父目录 → 再回读。
 * 未提交前任何失败都删临时目录；rename 撞名映射成 `409 PROJECT_EXISTS`（不覆盖）。
 *
 * @param {{
 *   parent: string,
 *   name: string,
 *   html: string,
 *   probe?: (context: { tmpDir: string, targetDir: string, filmPath: string }) => Promise<void>|void,
 * }} input
 * @returns {Promise<{ dir: string, filmHtmlSha256: string, bytes: number, parentSyncError: string|null }>}
 */
export async function writeFilmDirAtomic(input) {
  const parent = path.resolve(input.parent);
  const name = input.name;
  const html = input.html;
  const expectedSha = sha256(html);
  const bytes = Buffer.byteLength(html, 'utf8');
  const targetDir = path.resolve(parent, name);

  if (await exists(targetDir)) {
    throw new ProjectCreateError('PROJECT_EXISTS', 409, `目录已存在：${targetDir}`, { extra: { dir: targetDir } });
  }
  if (pending.has(targetDir)) {
    throw new ProjectCreateError('PROJECT_EXISTS', 409, `同名目录正在创建：${targetDir}`, { extra: { dir: targetDir } });
  }
  pending.add(targetDir);
  const tmpDir = path.join(parent, `.${name}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  let committed = false;
  try {
    try {
      await fs.mkdir(parent, { recursive: true });
    } catch (error) {
      throw new ProjectCreateError('PROJECT_DIR_INVALID', 400, `父目录不可用：${parent}`, {
        field: 'dir',
        extra: { reason: String(/** @type {Error} */ (error)?.message ?? error) },
      });
    }

    await fs.mkdir(tmpDir);

    /* 文件：写 → fsync → 关；目录项：fsync 之后再 rename，掉电也不会留半个目录。 */
    const filmPath = path.join(tmpDir, 'film.html');
    const handle = await fs.open(filmPath, 'wx');
    try {
      await handle.writeFile(html, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    const dirHandle = await fs.open(tmpDir, 'r');
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }

    /* 测试注入点：写完还没 rename 时抛错，验「不留半个目录」。生产路径不传。 */
    if (typeof input.probe === 'function') await input.probe({ tmpDir, targetDir, filmPath });

    /* 回读校验：盘上必须就是模板本身（不是写了别的文件还说成功）。 */
    const written = await fs.readFile(filmPath, 'utf8');
    if (sha256(written) !== expectedSha) {
      throw new ProjectCreateError('PROJECT_CREATE_FAILED', 500, '临时文件回读 sha 与模板不一致');
    }

    try {
      await fs.rename(tmpDir, targetDir);
    } catch (error) {
      const code = String(/** @type {NodeJS.ErrnoException} */ (error)?.code ?? '');
      if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM' || code === 'EACCES') {
        throw new ProjectCreateError('PROJECT_EXISTS', 409, `目录已存在：${targetDir}`, { extra: { dir: targetDir } });
      }
      throw new ProjectCreateError('PROJECT_CREATE_FAILED', 500, `rename 失败：${String(/** @type {Error} */ (error)?.message ?? error)}`, {
        extra: { code },
      });
    }
    committed = true;

    /* rename 之后 fsync 父目录：目录项本身落稳。失败不改结论（文件已在），只记一笔。 */
    /** @type {string|null} */
    let parentSyncError = null;
    try {
      const parentHandle = await fs.open(parent, 'r');
      try {
        await parentHandle.sync();
      } finally {
        await parentHandle.close();
      }
    } catch (error) {
      parentSyncError = String(/** @type {Error} */ (error)?.message ?? error);
    }

    /* 提交后复算一次：rename 不该改内容，但「返回的 sha 就是盘上的 sha」必须可验。 */
    const finalText = await fs.readFile(path.join(targetDir, 'film.html'), 'utf8');
    const finalSha = sha256(finalText);
    if (finalSha !== expectedSha) {
      throw new ProjectCreateError('PROJECT_CREATE_FAILED', 500, `落盘后 sha 不一致：${finalSha} ≠ ${expectedSha}`, {
        extra: { dir: targetDir },
      });
    }
    return { dir: targetDir, filmHtmlSha256: finalSha, bytes, parentSyncError };
  } catch (error) {
    /* 未提交 → 临时目录必须消失；已提交 → 什么都不删（目录是真的）。 */
    if (!committed) await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    throw error;
  } finally {
    pending.delete(targetDir);
  }
}

/**
 * 建一个工程。
 *
 * @param {{
 *   name: string,
 *   dir?: string,
 *   template?: string,
 *   root: string,
 *   home?: string,
 *   now?: Date|number,
 *   probe?: (context: { tmpDir: string, targetDir: string, filmPath: string }) => Promise<void>|void,
 * }} input
 * @returns {Promise<{
 *   ok: true, projectId: string, dir: string, name: string, template: string,
 *   filmHtmlSha256: string, bytes: number, templateVersion: string,
 *   index: { ok: boolean, file: string|null, entries: number, code?: string, message?: string },
 * }>}
 */
export async function createProject(input) {
  const name = validateProjectName(input.name);
  const template = resolveTemplate(input.template);
  const allowedRoot = path.resolve(input.root);

  /** @type {string} */
  let parent;
  if (input.dir === undefined || input.dir === null || input.dir === '') {
    parent = allowedRoot;
  } else {
    if (typeof input.dir !== 'string') {
      throw new ProjectCreateError('PROJECT_DIR_INVALID', 400, 'dir 必须是字符串', { field: 'dir' });
    }
    if (!path.isAbsolute(input.dir)) {
      throw new ProjectCreateError('PROJECT_DIR_INVALID', 400, `dir 必须是绝对路径：${input.dir}`, { field: 'dir' });
    }
    parent = path.resolve(input.dir);
  }

  /* 路径边界：在**碰磁盘之前**判死（A5：越界时父目录里一个新文件都没有）。 */
  if (!isInside(allowedRoot, parent)) {
    throw new ProjectCreateError('E_PATH_ESCAPE', 400, `dir 越界：${parent} 不在允许根 ${allowedRoot} 内`, {
      field: 'dir',
      extra: { root: allowedRoot },
    });
  }
  const targetDir = path.resolve(parent, name);
  if (targetDir === allowedRoot || !isInside(allowedRoot, targetDir)) {
    throw new ProjectCreateError('E_PATH_ESCAPE', 400, `目标目录越界：${targetDir}`, {
      field: 'name',
      extra: { root: allowedRoot },
    });
  }

  const html = minimalFilm({ w: template.w, h: template.h });
  const written = await writeFilmDirAtomic({
    parent,
    name,
    html,
    ...(typeof input.probe === 'function' ? { probe: input.probe } : {}),
  });

  /* 索引：创建后 `GET /api/projects` 的 recent 与磁盘一致。失败不回滚。 */
  /** @type {{ ok: boolean, file: string|null, entries: number, code?: string, message?: string }} */
  let index = { ok: false, file: null, entries: 0 };
  try {
    const recorded = await recordProjectOpen({ path: targetDir, name }, { home: input.home });
    if (recorded.ok === true) {
      const after = await readProjectIndex({ home: input.home });
      index = { ok: true, file: recorded.file ?? null, entries: after.projects.length };
    } else {
      index = {
        ok: false,
        file: null,
        entries: 0,
        ...(typeof recorded.code === 'string' ? { code: recorded.code } : {}),
        ...(typeof recorded.message === 'string' ? { message: recorded.message } : {}),
      };
    }
  } catch (error) {
    index = { ok: false, file: null, entries: 0, code: 'PROJECT_INDEX_WRITE_FAILED', message: String(/** @type {Error} */ (error)?.message ?? error) };
  }

  return {
    ok: true,
    projectId: projectIdFor(targetDir),
    dir: targetDir,
    name,
    template: template.id,
    filmHtmlSha256: written.filmHtmlSha256,
    bytes: written.bytes,
    templateVersion: PROJECT_TEMPLATE_VERSION,
    index,
    ...(written.parentSyncError === null ? {} : { parentSyncError: written.parentSyncError }),
  };
}

/** @param {string} target */
async function exists(target) {
  try {
    await fs.stat(target);
    return true;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code === 'ENOENT') return false;
    throw error;
  }
}
