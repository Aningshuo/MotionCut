/**
 * 最近工程索引（M55 · B-MAIN-R29-029）。
 *
 * ## 为什么单独一个文件
 *
 * `projects.mjs` 管的是「当前打开的工程」（内存注册表 + 缩略图），进程一退就没了。
 * 首页要的「最近工程」是**跨会话**的，落在用户级：
 *
 *   `~/.opencut/projects.json`
 *
 * 只存索引，不复制工程内容；用户手动打开的工程也只记路径。
 *
 * ## 写盘规格
 *
 * 与 `settings-store` / `subtitle-style-store` 同一套：同目录临时文件 → `fsync` →
 * `rename` → **回读校验**；失败清临时文件，不留半份索引。
 *
 * ## 坏 JSON 不覆盖
 *
 * 解析失败时先把原文件复制成 `projects.json.bak-<ts>`（保留证据），本次返回
 * `{ projects: [], corrupt: true }`，**不写新文件**；下一次 `recordProjectOpen`
 * 才会落一份干净的。同一份坏文件只备份一次。
 *
 * ## openedAt 严格递增
 *
 * 列表按 `openedAt` 倒序，同一毫秒连续打开两个工程时，后者取「当前最大值 + 1ms」，
 * 保证顺序稳定、可断言（验收 A1 就比这个）。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalProjectDirectory } from './project-identity.mjs';

export const INDEX_VERSION = 1;
/** 首页最多显示 12 条。 */
export const MAX_RECENT = 12;

/**
 * 索引文件绝对路径。
 * @param {string} [home]
 */
export function indexPath(home = os.homedir()) {
  return path.join(home, '.opencut', 'projects.json');
}

/** @param {string} text */
function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 一条索引记录。
 *
 * `stalePaths`（M73 收口 M72 遗留）：这个工程搬走以后**旧目录没能回收**的绝对路径。
 * 以前 `normalizeEntry` 会把它当未知字段丢掉，于是「索引是唯一真源」这句话不成立，
 * 只能靠 `~/.opencut/stale-paths.json` 兜底；现在它随索引一起读写，sidecar 只做兜底备份。
 *
 * 调用方可以只给 path/name/openedAt；`normalizeEntry` 会把 `stalePaths` 补成 `[]`。
 * @typedef {{ path: string, name: string, openedAt: string, cover?: string, stalePaths?: string[] }} RecentProject
 */

/**
 * 把任意输入规范成一条索引记录；不合法返回 null。
 * @param {any} entry
 * @returns {RecentProject | null}
 */
function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.path !== 'string' || entry.path.trim() === '') return null;
  const abs = canonicalProjectDirectory(entry.path);
  const name =
    typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : path.basename(abs);
  /** @type {RecentProject} */
  const out = {
    path: abs,
    name,
    openedAt: typeof entry.openedAt === 'string' ? entry.openedAt : '',
    // 缺省 []：这个字段是「搬走了但旧目录还在」的耐久记录，丢掉它等于把证据抹掉。
    stalePaths: Array.isArray(entry.stalePaths)
      ? [...new Set(entry.stalePaths.filter((/** @type {any} */ item) => typeof item === 'string' && item !== ''))]
      : [],
  };
  if (typeof entry.cover === 'string' && entry.cover !== '') out.cover = entry.cover;
  return out;
}

/** @param {RecentProject | null} entry @returns {entry is RecentProject} */
function isEntry(entry) {
  return entry !== null;
}

/** @param {RecentProject} entry */
function sortKey(entry) {
  const t = Date.parse(entry.openedAt);
  return Number.isFinite(t) ? t : 0;
}

/**
 * 排序（openedAt 倒序）+ 截断到 MAX_RECENT。
 * @param {RecentProject[]} projects
 */
function tidy(projects) {
  const ordered = [...projects].sort((a, b) => sortKey(b) - sortKey(a));
  /** @type {Map<string, RecentProject>} */
  const byPath = new Map();
  for (const item of ordered) {
    const prior = byPath.get(item.path);
    if (prior === undefined) {
      byPath.set(item.path, item);
      continue;
    }
    byPath.set(item.path, {
      ...prior,
      ...(prior.cover === undefined && item.cover !== undefined ? { cover: item.cover } : {}),
      stalePaths: [...new Set([...(prior.stalePaths ?? []), ...(item.stalePaths ?? [])])],
    });
  }
  return [...byPath.values()].slice(0, MAX_RECENT);
}

/** @type {Map<string, Promise<unknown>>} */
const pendingUpdates = new Map();

/** Serialize each profile's recent-project read/modify/write transaction. @template T @param {string | undefined} home @param {() => Promise<T>} update @returns {Promise<T>} */
function updateProjectIndex(home, update) {
  const file = indexPath(home);
  const previous = pendingUpdates.get(file) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(update);
  pendingUpdates.set(file, next);
  return next.finally(() => {
    if (pendingUpdates.get(file) === next) pendingUpdates.delete(file);
  });
}

/**
 * 读索引。文件不存在返回空；坏 JSON 备份后返回空 + `corrupt: true`。
 * @param {{ home?: string }} [opts]
 * @returns {Promise<{ version: number, projects: RecentProject[], corrupt: boolean, file: string, backup?: string }>}
 */
export async function readProjectIndex({ home } = {}) {
  const file = indexPath(home);
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (/** @type {any} */ (error)?.code === 'ENOENT') {
      return { version: INDEX_VERSION, projects: [], corrupt: false, file };
    }
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.projects) ? parsed.projects : [];
    const projects = tidy(list.map(normalizeEntry).filter(isEntry));
    return { version: INDEX_VERSION, projects, corrupt: false, file };
  } catch {
    /* 坏文件：保留证据，只备份一次，不覆盖 */
    const dir = path.dirname(file);
    const names = await fs.readdir(dir).catch(() => /** @type {string[]} */ ([]));
    let backup;
    if (!names.some((n) => n.startsWith('projects.json.bak-'))) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      backup = `${file}.bak-${ts}`;
      await fs.copyFile(file, backup).catch(() => {
        backup = undefined;
      });
    }
    return { version: INDEX_VERSION, projects: [], corrupt: true, file, backup };
  }
}

/**
 * 原子写索引：临时文件 → fsync → rename → 回读校验。
 * @param {RecentProject[]} projects
 * @param {{ home?: string }} [opts]
 * @returns {Promise<{ ok: true, file: string, hash: string, count: number } | { ok: false, code: string, message: string }>}
 */
export async function writeProjectIndex(projects, { home } = {}) {
  const file = indexPath(home);
  const dir = path.dirname(file);
  const list = tidy((Array.isArray(projects) ? projects : []).map(normalizeEntry).filter(isEntry));
  const body = `${JSON.stringify({ version: INDEX_VERSION, projects: list }, null, 2)}\n`;
  const tempPath = path.join(dir, `projects.json.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  /** @type {import('node:fs/promises').FileHandle | null} */
  let handle = null;
  try {
    await fs.mkdir(dir, { recursive: true });
    handle = await fs.open(tempPath, 'wx');
    await handle.writeFile(body, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tempPath, file);
  } catch (error) {
    if (handle !== null) await handle.close().catch(() => undefined);
    await fs.unlink(tempPath).catch(() => undefined);
    return { ok: false, code: 'PROJECT_INDEX_WRITE_FAILED', message: String(/** @type {Error} */ (error).message) };
  }
  let back;
  try {
    back = await fs.readFile(file, 'utf8');
  } catch (error) {
    return { ok: false, code: 'PROJECT_INDEX_WRITE_FAILED', message: `回读失败：${String(/** @type {Error} */ (error).message)}` };
  }
  if (back !== body) {
    return { ok: false, code: 'PROJECT_INDEX_WRITE_FAILED', message: '回读校验失败：写入内容与内存不一致' };
  }
  return { ok: true, file, hash: sha256(back), count: list.length };
}

/**
 * 记录一次「打开工程」：存在则更新 openedAt 并置顶，不存在则插入；最后截到 12 条。
 *
 * `openedAt` 取 `max(now, 现有最大值 + 1ms)`，保证严格递增。
 *
 * @param {{ path: string, name?: string, cover?: string }} entry
 * @param {{ home?: string, now?: number }} [opts]
 * @returns {Promise<{ ok: boolean, projects: RecentProject[], file?: string, code?: string, message?: string }>}
 */
export async function recordProjectOpen(entry, { home, now } = {}) {
  const normalized = normalizeEntry(entry);
  if (normalized === null) {
    return { ok: false, projects: [], code: 'PROJECT_INDEX_INVALID_ENTRY', message: 'path 不能为空' };
  }
  return updateProjectIndex(home, async () => {
    const current = await readProjectIndex({ home });
    const prior = current.projects.find((item) => item.path === normalized.path);
    const max = current.projects.reduce((acc, item) => Math.max(acc, sortKey(item)), 0);
    const at = Math.max(typeof now === 'number' ? now : Date.now(), max + 1);
    const next = current.projects.filter((item) => item.path !== normalized.path);
    next.unshift({ ...prior, ...normalized, stalePaths: prior?.stalePaths ?? normalized.stalePaths, openedAt: new Date(at).toISOString() });
    const written = await writeProjectIndex(next, { home });
    if (!written.ok) {
      return { ok: false, projects: current.projects, code: written.code, message: written.message };
    }
    const after = await readProjectIndex({ home });
    return { ok: true, projects: after.projects, file: written.file };
  });
}

/**
 * 给某条最近工程补封面（M57）。
 *
 * 封面是**打开工程之后**才算得出来的（要读 doc 找第一个视频片段），所以不能在
 * `recordProjectOpen` 里一次写完。工程不在索引里就返回 `PROJECT_INDEX_NOT_FOUND`，
 * 由调用方忽略——封面失败不该冒泡成打开失败。
 *
 * @param {string} projectPath
 * @param {string} cover 封面文件名（由 `project-covers.mjs` 生成）
 * @param {{ home?: string }} [options]
 */
export async function setProjectCover(projectPath, cover, { home } = {}) {
  if (typeof cover !== 'string' || cover === '') {
    return { ok: false, code: 'PROJECT_COVER_INVALID', message: 'cover 不能为空' };
  }
  const abs = canonicalProjectDirectory(projectPath);
  return updateProjectIndex(home, async () => {
    const current = await readProjectIndex({ home });
    if (!current.projects.some((item) => item.path === abs)) {
      return { ok: false, code: 'PROJECT_INDEX_NOT_FOUND', message: '工程不在最近列表里' };
    }
    const next = current.projects.map((item) => (item.path === abs ? { ...item, cover } : item));
    const written = await writeProjectIndex(next, { home });
    if (!written.ok) return { ok: false, code: written.code, message: written.message };
    return { ok: true, cover, file: written.file };
  });
}

/**
 * 从索引里移除一个工程（只改索引，不动磁盘）。
 * @param {string} projectPath
 * @param {{ home?: string }} [opts]
 * @returns {Promise<{ ok: boolean, removed: boolean, projects: RecentProject[], code?: string, message?: string }>}
 */
export async function removeProjectEntry(projectPath, { home } = {}) {
  if (typeof projectPath !== 'string' || projectPath.trim() === '') {
    return { ok: false, removed: false, projects: [], code: 'PROJECT_INDEX_INVALID_ENTRY', message: 'path 不能为空' };
  }
  const target = canonicalProjectDirectory(projectPath);
  return updateProjectIndex(home, async () => {
    const current = await readProjectIndex({ home });
    const next = current.projects.filter((item) => item.path !== target);
    const removed = next.length !== current.projects.length;
    if (!removed) return { ok: true, removed: false, projects: current.projects };
    const written = await writeProjectIndex(next, { home });
    if (!written.ok) {
      return { ok: false, removed: false, projects: current.projects, code: written.code, message: written.message };
    }
    return { ok: true, removed: true, projects: next };
  });
}
