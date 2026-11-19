/**
 * 工程目录移动（M72-NEW-04）。
 *
 * ## 要解决的那个坑
 *
 * 跨盘移动的真实步骤是「复制 → 校验 → 切索引 → 删旧目录」。前两步成功、**第三步失败**
 * 时工程其实已经在新位置可用：这时报 `failed` 会让调用方回滚（把新副本删掉），
 * 旧目录又因为只读/权限删不掉——两边一折腾就**丢数据**。
 *
 * 所以这里的语义是：
 * - 复制 + 校验 + 切索引成功 → `status:"moved"`；
 *   旧目录回收失败只是**警告**（`RECLAIM_FAILED:<oldPath>` + `reclaimed:false`），
 *   并把旧路径记进 `stalePaths`（写进工程索引条目，同时留一份
 *   `~/.opencut/stale-paths.json` 作耐久记录——`project-index.mjs` 的 `normalizeEntry`
 *   会丢弃未知字段，本批 owner 不含该文件）。
 * - 只有「新位置不可用」才 `status:"failed"`：校验不过或索引写失败时，删掉目标侧半成品，
 *   原目录**一字不动**，并把工程重新打开（调用方还能继续用）。
 *
 * ## 边界
 *
 * 同盘优先 `rename`（原子、不复制字节）；`EXDEV` 或 `{forceCopy:true}` 才走复制。
 * 复制与校验都**不跟随符号链接**（链接按链接复制），避免把工程外面的东西卷进来。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readProjectIndex, writeProjectIndex } from './project-index.mjs';

/** 旧目录没能回收时，耐久记录放这里（诊断会读）。 */
export const STALE_FILE = 'stale-paths.json';

/** @param {string} [home] */
export function stalePathFile(home = os.homedir()) {
  return path.join(home, '.opencut', STALE_FILE);
}

/** 移动失败：带 HTTP 状态与错误码，路由层直接映射。 */
export class MoveError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} status
   * @param {Record<string, any>} [detail]
   */
  constructor(code, message, status, detail = {}) {
    super(message);
    this.name = 'MoveError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/** @param {Buffer|string} data */
function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * 解析成 realpath：路径不存在时，先找到最近的已存在祖先再拼回去。
 * （`..` 与符号链接都在这里被吃掉，后面的「目标在工程内部」判断才可信。）
 * @param {string} input
 * @returns {Promise<string>}
 */
export async function resolveReal(input) {
  let current = path.resolve(input);
  /** @type {string[]} */
  const tail = [];
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(input);
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * 递归统计：文件数、总字节、相对路径集合、film.html 的 sha256。
 * 不跟随符号链接（链接算一个条目、0 字节）。
 * @param {string} root
 */
export async function measureTree(root) {
  /** @type {{ files: number, bytes: number, filmSha: string|null, paths: Set<string> }} */
  const out = { files: 0, bytes: 0, filmSha: null, paths: new Set() };
  /** @param {string} rel */
  async function walk(rel) {
    const abs = rel === '' ? root : path.join(root, rel);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      const childAbs = path.join(root, childRel);
      if (entry.isSymbolicLink()) {
        out.files += 1;
        out.paths.add(childRel);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.lstat(childAbs);
      out.files += 1;
      out.bytes += stat.size;
      out.paths.add(childRel);
      if (childRel === 'film.html') out.filmSha = sha256(await fs.readFile(childAbs));
    }
  }
  await walk('');
  return out;
}

/**
 * 递归复制（目录 / 普通文件 / 符号链接）。返回复制的文件数。
 * @param {string} source
 * @param {string} target
 */
export async function copyTree(source, target) {
  await fs.mkdir(target, { recursive: true });
  let copied = 0;
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isSymbolicLink()) {
      const link = await fs.readlink(from);
      await fs.symlink(link, to);
      copied += 1;
      continue;
    }
    if (entry.isDirectory()) {
      copied += await copyTree(from, to);
      continue;
    }
    if (entry.isFile()) {
      await fs.copyFile(from, to);
      copied += 1;
    }
  }
  return copied;
}

/**
 * 默认校验：film.html sha256 + 文件数 + 总字节 + 路径集合。
 * @param {{source: string, target: string, before: Awaited<ReturnType<typeof measureTree>>}} input
 */
export async function verifyCopy(input) {
  const after = await measureTree(input.target);
  const before = input.before;
  if (after.filmSha !== before.filmSha) {
    return { ok: false, reason: 'FILM_SHA_MISMATCH', before: before.filmSha, after: after.filmSha };
  }
  if (after.files !== before.files) {
    return { ok: false, reason: 'FILE_COUNT_MISMATCH', before: before.files, after: after.files };
  }
  if (after.bytes !== before.bytes) {
    return { ok: false, reason: 'BYTES_MISMATCH', before: before.bytes, after: after.bytes };
  }
  for (const rel of before.paths) {
    if (!after.paths.has(rel)) return { ok: false, reason: `MISSING:${rel}` };
  }
  return { ok: true, files: after.files, bytes: after.bytes };
}

/**
 * 读「旧目录没回收掉」的记录（诊断用）。
 *
 * **索引优先**（M73 收口）：`project-index.mjs` 现在会透传 `stalePaths`，所以索引条目
 * 就是唯一真源；只有当索引里一条都没有时，才读 `~/.opencut/stale-paths.json` 兜底
 * （老版本写的 sidecar、或索引被外部工具重写丢了字段）。
 * @param {{home?: string}} [options]
 * @returns {Promise<{file: string, version: number, entries: Array<{oldPath: string, newPath: string, code: string, at: string}>, source: 'index'|'sidecar'}>}
 */
export async function readStalePaths(options = {}) {
  const file = stalePathFile(options.home);
  /** @type {Array<{oldPath: string, newPath: string, code: string, at: string}>} */
  const fromIndex = [];
  try {
    const index = await readProjectIndex({ home: options.home });
    for (const item of index.projects) {
      for (const oldPath of item.stalePaths ?? []) {
        fromIndex.push({
          oldPath,
          newPath: item.path,
          code: 'RECLAIM_FAILED',
          at: typeof item.openedAt === 'string' ? item.openedAt : '',
        });
      }
    }
  } catch {
    /* 索引读不了不算错：退回 sidecar */
  }
  if (fromIndex.length > 0) return { file, version: 1, entries: fromIndex, source: 'index' };
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    const entries = Array.isArray(parsed?.entries)
      ? parsed.entries.filter(
          (/** @type {any} */ entry) =>
            entry !== null && typeof entry === 'object' && typeof entry.oldPath === 'string',
        )
      : [];
    return { file, version: 1, entries, source: 'sidecar' };
  } catch {
    return { file, version: 1, entries: [], source: 'sidecar' };
  }
}

/**
 * 原子写 JSON：临时文件 → fsync → rename → 回读比对。
 * @param {string} file
 * @param {any} value
 */
async function writeJsonAtomic(file, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const temp = path.join(dir, `${path.basename(file)}.tmp-${String(process.pid)}-${Math.random().toString(36).slice(2, 8)}`);
  /** @type {import('node:fs/promises').FileHandle|null} */
  let handle = null;
  try {
    handle = await fs.open(temp, 'wx');
    await handle.writeFile(body, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temp, file);
  } catch (error) {
    if (handle !== null) await handle.close().catch(() => undefined);
    await fs.unlink(temp).catch(() => undefined);
    throw error;
  }
  const back = await fs.readFile(file, 'utf8');
  if (back !== body) throw new Error('回读校验失败：写入内容与内存不一致');
}

/**
 * 把旧路径写进索引条目的 `stalePaths[]`（诊断可见）。
 *
 * M73 起 `normalizeEntry` 会透传这个字段，所以这里走正常的读写 API（原子写 + 回读校验），
 * 不再「按原文读改写」绕过索引层。
 * @param {{home?: string, newPath: string, oldPath: string}} input
 */
async function patchIndexStale(input) {
  const current = await readProjectIndex({ home: input.home });
  const entry = current.projects.find((item) => item.path === input.newPath);
  if (entry === undefined) return { ok: false, code: 'INDEX_ENTRY_MISSING' };
  const stale = Array.isArray(entry.stalePaths) ? [...entry.stalePaths] : [];
  if (!stale.includes(input.oldPath)) stale.push(input.oldPath);
  const next = current.projects.map((item) =>
    item.path === input.newPath ? { ...item, stalePaths: stale } : item,
  );
  const written = await writeProjectIndex(next, { home: input.home });
  if (!written.ok) return { ok: false, code: written.code, message: written.message };
  return { ok: true, stalePaths: stale };
}

/**
 * 把工程索引里的一条从旧路径换成新路径。
 * @param {{home?: string, oldPath: string, newPath: string}} input
 */
async function switchIndex(input) {
  const current = await readProjectIndex({ home: input.home });
  // 索引里的路径可能是 `/var/...`（macOS 的符号链接）而这里是 `/private/var/...`：
  // 按 realpath 比对，否则切不中条目会留下一条指向旧目录的僵尸记录。
  /** @type {any} */
  let entry = current.projects.find((item) => item.path === input.oldPath);
  if (entry === undefined) {
    for (const item of current.projects) {
      const real = await resolveReal(item.path).catch(() => item.path);
      if (real === input.oldPath) {
        entry = item;
        break;
      }
    }
  }
  const rest = current.projects.filter((item) => item !== entry && item.path !== input.newPath);
  /** @type {any} */
  const moved = {
    path: input.newPath,
    name: path.basename(input.newPath),
    openedAt: entry?.openedAt ?? new Date().toISOString(),
  };
  if (typeof entry?.cover === 'string' && entry.cover !== '') moved.cover = entry.cover;
  // 历史遗留的 stalePaths 跟着条目走：换个位置并不会把上一次没删掉的旧目录变没。
  if (Array.isArray(entry?.stalePaths) && entry.stalePaths.length > 0) moved.stalePaths = entry.stalePaths;
  const written = await writeProjectIndex([moved, ...rest], { home: input.home });
  if (!written.ok) return { ok: false, code: written.code, message: written.message };
  return { ok: true, count: written.count };
}

/**
 * @param {{
 *   registry: any,
 *   home?: string,
 *   logger?: (line: string) => void,
 *   verify?: (input: any) => Promise<{ok: boolean, reason?: string}>,
 *   forceCopy?: boolean,
 * }} options
 */
export function createProjectMover(options) {
  const registry = options.registry;
  const home = options.home;
  const log = options.logger ?? (() => {});
  const verify = typeof options.verify === 'function' ? options.verify : verifyCopy;
  const defaultForceCopy = options.forceCopy === true;

  /** @type {Set<string>} */
  const inFlight = new Set();

  /** @param {string} dir */
  async function reopen(dir) {
    const opened = await registry.open(dir);
    if (opened.ok !== true) log(`PROJECT_MOVE_REOPEN_FAILED ${dir} ${String(opened.code ?? '')}`);
    return opened;
  }

  /**
   * 移动一个已打开的工程。
   * @param {string} projectId
   * @param {string} targetDir
   * @param {{forceCopy?: boolean}} [callOptions]
   */
  async function move(projectId, targetDir, callOptions = {}) {
    if (typeof projectId !== 'string' || projectId === '') {
      throw new MoveError('PROJECT_NOT_FOUND', '缺少 projectId', 404);
    }
    if (inFlight.has(projectId)) {
      throw new MoveError('MOVE_IN_PROGRESS', `这个工程正在移动：${projectId}`, 409);
    }
    inFlight.add(projectId);
    try {
      const summary = registry.summary(projectId);
      if (summary === null) {
        throw new MoveError('PROJECT_NOT_FOUND', `工程未打开：${projectId}`, 404);
      }
      if (typeof targetDir !== 'string' || targetDir.trim() === '') {
        throw new MoveError('BAD_REQUEST', 'targetDir 必须是非空字符串', 400);
      }
      // `summary.path` 是 registry 里那个字符串（可能带 `/var` 这类符号链接段），
      // 打开工程必须用它——projectId 是按这个字符串算的；文件系统操作用 realpath。
      const sourceKey = summary.path;
      const source = await resolveReal(summary.path);
      const target = await resolveReal(targetDir);
      if (target === source || target.startsWith(`${source}${path.sep}`)) {
        throw new MoveError('TARGET_INSIDE_PROJECT', '目标目录在工程内部', 400, { targetDir: target, source });
      }

      await fs.mkdir(path.dirname(target), { recursive: true });
      const existing = await fs.lstat(target).catch(() => null);
      if (existing !== null) {
        if (!existing.isDirectory()) {
          throw new MoveError('TARGET_NOT_EMPTY', `目标已存在且不是目录：${target}`, 409, { targetDir: target });
        }
        const entries = await fs.readdir(target);
        if (entries.length > 0) {
          throw new MoveError('TARGET_NOT_EMPTY', `目标目录非空：${target}`, 409, { targetDir: target, entries: entries.length });
        }
        await fs.rmdir(target);
      }

      const closed = await registry.close(projectId, { waitMs: 3000 });
      if (closed.ok !== true) {
        await reopen(sourceKey);
        throw new MoveError('PROJECT_BUSY', '工程有未落盘的写入，暂不能移动', 409, {
          pendingWrites: closed.pendingWrites ?? 0,
          cancelled: closed.cancelled ?? 0,
        });
      }

      /** @type {{ files: number, bytes: number, filmSha: string|null, paths: Set<string> }} */
      let before;
      try {
        before = await measureTree(source);
      } catch (error) {
        await reopen(sourceKey);
        throw new MoveError('MEASURE_FAILED', `读不了原目录：${String(/** @type {any} */ (error)?.message ?? error)}`, 500);
      }

      const forceCopy = callOptions.forceCopy === true || defaultForceCopy;
      let strategy = forceCopy ? 'copy' : (await fs.stat(source)).dev === (await fs.stat(path.dirname(target))).dev ? 'rename' : 'copy';
      /** @type {string[]} */
      const warnings = [];

      if (strategy === 'rename') {
        try {
          await fs.rename(source, target);
        } catch (error) {
          if (/** @type {any} */ (error)?.code === 'EXDEV') {
            strategy = 'copy';
          } else {
            await reopen(sourceKey);
            throw error;
          }
        }
      }

      if (strategy === 'rename') {
        const switched = await switchIndex({ home, oldPath: source, newPath: target });
        if (switched.ok !== true) {
          // 索引没写成：把目录挪回去，工程重新打开——两边都保持可用。
          await fs.rename(target, source).catch(() => undefined);
          await reopen(sourceKey);
          return failedResult({
            source,
            target,
            warnings,
            reasons: [`INDEX_WRITE_FAILED:${String(switched.code ?? '')}`],
            strategy,
          });
        }
        const opened = await reopen(target);
        if (opened.ok !== true) warnings.push(`REOPEN_FAILED:${String(opened.code ?? '')}`);
        log(`PROJECT_MOVE ${projectId} ${source} -> ${target} strategy=rename`);
        return {
          ok: true,
          status: 'moved',
          newPath: target,
          oldPath: source,
          projectId: opened.ok === true ? opened.project.projectId : null,
          warnings,
          reclaimed: true,
          bytesMoved: before.bytes,
          filesMoved: before.files,
          strategy,
        };
      }

      // ── 跨盘：copy → verify → index → reclaim ─────────────────────────────
      try {
        await copyTree(source, target);
      } catch (error) {
        await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
        await reopen(sourceKey);
        return failedResult({
          source,
          target,
          warnings,
          reasons: [`COPY_FAILED:${String(/** @type {any} */ (error)?.message ?? error)}`],
          strategy,
        });
      }

      /** @type {any} */
      let verdict;
      try {
        verdict = await verify({ source, target, before });
      } catch (error) {
        verdict = { ok: false, reason: `VERIFY_THREW:${String(/** @type {any} */ (error)?.message ?? error)}` };
      }
      if (verdict?.ok !== true) {
        await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
        await reopen(sourceKey);
        log(`PROJECT_MOVE_VERIFY_FAILED ${projectId} ${String(verdict?.reason ?? 'UNKNOWN')}`);
        return failedResult({
          source,
          target,
          warnings,
          reasons: [`VERIFY_FAILED:${String(verdict?.reason ?? 'UNKNOWN')}`],
          strategy,
        });
      }

      const switched = await switchIndex({ home, oldPath: source, newPath: target });
      if (switched.ok !== true) {
        await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
        await reopen(sourceKey);
        return failedResult({
          source,
          target,
          warnings,
          reasons: [`INDEX_WRITE_FAILED:${String(switched.code ?? '')}`],
          strategy,
        });
      }

      let reclaimed = false;
      /** sidecar 只是兜底：写失败不改判定，只在结果里留一个可查的标记。 */
      let sidecarFailed = false;
      try {
        await fs.rm(source, { recursive: true, force: false, maxRetries: 2 });
        reclaimed = true;
      } catch (error) {
        warnings.push(`RECLAIM_FAILED:${source}`);
        log(`PROJECT_MOVE_RECLAIM_FAILED ${projectId} ${String(/** @type {any} */ (error)?.code ?? error)}`);
        // 索引是唯一真源：写失败才是真问题（还不至于把移动判失败，但要留痕）。
        const patched = await patchIndexStale({ home, newPath: target, oldPath: source }).catch(() => ({
          ok: false,
          code: 'INDEX_PATCH_FAILED',
        }));
        if (patched.ok !== true) warnings.push(`STALE_INDEX_FAILED:${String(patched.code ?? '')}`);
        const sidecar = await recordStale({ home, oldPath: source, newPath: target })
          .then(() => true)
          .catch(() => false);
        if (!sidecar) {
          sidecarFailed = true;
          warnings.push('STALE_SIDECAR_FAILED');
        }
      }

      const opened = await reopen(target);
      if (opened.ok !== true) warnings.push(`REOPEN_FAILED:${String(opened.code ?? '')}`);
      log(
        `PROJECT_MOVE ${projectId} ${source} -> ${target} strategy=copy ` +
          `files=${String(before.files)} bytes=${String(before.bytes)} reclaimed=${String(reclaimed)}`,
      );
      return {
        ok: true,
        status: 'moved',
        newPath: target,
        oldPath: source,
        projectId: opened.ok === true ? opened.project.projectId : null,
        warnings,
        reclaimed,
        sidecarFailed,
        bytesMoved: before.bytes,
        filesMoved: before.files,
        strategy,
      };
    } finally {
      inFlight.delete(projectId);
    }
  }

  /**
   * @param {{source: string, target: string, warnings: string[], reasons: string[], strategy: string}} input
   */
  function failedResult(input) {
    return {
      ok: false,
      status: 'failed',
      newPath: input.target,
      oldPath: input.source,
      warnings: [...input.warnings, ...input.reasons],
      reasons: input.reasons,
      reclaimed: false,
      bytesMoved: 0,
      filesMoved: 0,
      strategy: input.strategy,
    };
  }

  /** @param {{home?: string, oldPath: string, newPath: string}} input */
  async function recordStale(input) {
    const current = await readStalePaths({ home: input.home ?? home });
    const entries = current.entries.filter((entry) => entry.oldPath !== input.oldPath);
    entries.unshift({
      oldPath: input.oldPath,
      newPath: input.newPath,
      code: 'RECLAIM_FAILED',
      at: new Date().toISOString(),
    });
    await writeJsonAtomic(stalePathFile(input.home ?? home), {
      version: 1,
      entries: entries.slice(0, 50),
    });
  }

  return {
    move,
    /** @param {string} projectId */
    isMoving: (projectId) => inFlight.has(projectId),
  };
}
