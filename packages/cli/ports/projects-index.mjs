/**
 * 真实 projects 端口（M74）：把 `~/.opencut/projects.json`（Studio 的最近工程索引）
 * 接成 CLI / MCP 的 `project list` 数据源。
 *
 * 为什么读索引而不是现扫目录：索引是「用户打开过的工程」的**唯一真源**（M55 定的），
 * 现扫出来的目录既没有名字也没有打开时间，`project list` 的 `name` 就只能是目录名。
 *
 * 沙箱边界：只列 `root` 之内的工程（与 `resolveProject` 的越界判定同一套语义）。
 * `id` 与 Studio 的 projectId 同算法（`sha256(realpath).slice(0,16)`），
 * 这样 CLI 打印的 id 能直接喂给 Studio 的 `/api/projects/:id/...`。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** @param {string} text */
function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** @param {string} home */
function indexPath(home) {
  return path.join(home, '.opencut', 'projects.json');
}

/** @param {string} root @param {string} target */
function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * @param {{ root?: string, env?: Record<string, any>, cwd?: string }} [ctx]
 */
export function createProjectsPort(ctx = {}) {
  const root = path.resolve(ctx.root ?? ctx.env?.projectsRoot ?? ctx.cwd ?? process.cwd());
  const home = typeof ctx.env?.home === 'string' && ctx.env.home !== '' ? path.resolve(ctx.env.home) : os.homedir();

  /**
   * @returns {Promise<Array<{ id: string, name?: string, path: string }>>}
   */
  async function list() {
    let raw;
    try {
      raw = await fs.readFile(indexPath(home), 'utf8');
    } catch (error) {
      // 索引不存在 = 还没打开过任何工程：空列表，不是错误。
      if (/** @type {any} */ (error)?.code === 'ENOENT') return [];
      throw error;
    }
    /** @type {any} */
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    const entries = Array.isArray(parsed?.projects) ? parsed.projects : [];
    /** @type {Array<{ id: string, name?: string, path: string }>} */
    const rows = [];
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string' || entry.path === '') continue;
      const abs = path.resolve(entry.path);
      let real = abs;
      try {
        real = await fs.realpath(abs);
      } catch {
        /* 索引里的目录可能已经没了：按原路径照样列出来（用户要能看到它） */
      }
      if (!isInside(root, real) && !isInside(root, abs)) continue;
      rows.push({
        id: sha256(abs).slice(0, 16),
        ...(typeof entry.name === 'string' && entry.name !== '' ? { name: entry.name } : {}),
        path: real,
      });
    }
    return rows;
  }

  return { list, home, root };
}

export default createProjectsPort;
