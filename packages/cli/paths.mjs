/**
 * 路径边界（WP18 安全面）。
 *
 * 规则只有一条：**调用方给的任何工程路径，必须落在 CLI 的沙箱根内**。
 * 越界一律 `E_PATH_ESCAPE`，而且是在读盘/写盘**之前**判定——先解析、后校验、
 * 最后才动文件，绝不"先读一眼看看是不是越界"。
 *
 * 两类越界都要挡住：
 * 1. 字面越界：`../../etc/passwd`、`/etc/passwd`；
 * 2. 符号链接越界：工程根内放一个 `link -> /etc`，字面看着在内，真实路径在外。
 *    所以对**已存在**的路径再比一次 realpath。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { CliError } from './errors.mjs';

/**
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
export function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

/**
 * 真实路径；不存在时退回字面绝对路径（新建工程/新文件是正常情况）。
 * @param {string} p
 * @returns {Promise<string>}
 */
async function realpathOrSelf(p) {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * macOS 的 `os.tmpdir()` 给 `/var/...`，realpath 却是 `/private/var/...`；两边都得认。
 * 只要字面路径与真实路径各落在字面根或真实根之一，就算在内。
 * @param {string[]} roots
 * @param {string[]} candidates
 * @returns {boolean}
 */
function insideAny(roots, candidates) {
  return candidates.some((target) => roots.some((root) => isInside(root, target)));
}

/**
 * 把调用方的路径解析成绝对路径并校验沙箱边界。
 * @param {string} root 沙箱根（绝对）
 * @param {string} input 调用方给的路径（可相对）
 * @param {{ base?: string, what?: string, also?: string[] }} [opts]
 *   `base` 是相对路径基准（默认沙箱根）；`also` 是额外的合法根
 *   （如 `outputRoot`：导出产物本来就在工程根之外）
 * @returns {Promise<string>} 绝对路径（未 realpath，保留调用方语义）
 */
export async function resolveInside(root, input, opts = {}) {
  const what = opts.what ?? 'project';
  if (typeof input !== 'string' || input.length === 0) {
    throw new CliError('E_USAGE', `${what}: a path is required`);
  }
  if (input.includes('\0')) {
    throw new CliError('E_PATH_ESCAPE', `${what}: NUL byte in path`);
  }

  const lexicalRoots = [root, ...(opts.also ?? [])].map((p) => path.resolve(p));
  const realRoots = await Promise.all(lexicalRoots.map((p) => realpathOrSelf(p)));
  const base = path.resolve(opts.base ?? /** @type {string} */ (lexicalRoots[0]));
  const abs = path.resolve(base, input);

  // 1) 字面必须先在内：挡掉 `../..` 与绝对路径
  //    （macOS 的 `process.cwd()` 会给 `/private/var/...` 而传入的根是 `/var/...`，两形都认）
  if (!insideAny([...lexicalRoots, ...realRoots], [abs])) {
    throw new CliError('E_PATH_ESCAPE', `${what}: ${input} escapes the sandbox root`, {
      input,
      root: lexicalRoots[0],
    });
  }

  // 2) 已存在的路径再比 realpath：挡掉指向外部的符号链接
  const real = await realpathOrSelf(abs);
  if (!insideAny([...realRoots, ...lexicalRoots], [real])) {
    throw new CliError('E_PATH_ESCAPE', `${what}: ${input} resolves outside the sandbox root (symlink)`, {
      input,
      root: lexicalRoots[0],
    });
  }
  return abs;
}

/**
 * 只做边界判定、不落盘，供"已经拿到绝对路径"的调用点复核（如 MCP 的 tool 入口）。
 * @param {string} root
 * @param {string} abs
 * @param {string} [what]
 * @returns {Promise<void>}
 */
export async function assertInside(root, abs, what = 'project') {
  const lexicalRoot = path.resolve(root);
  const realRoot = await realpathOrSelf(root);
  const target = path.resolve(abs);
  const real = await realpathOrSelf(target);
  if (!insideAny([lexicalRoot, realRoot], [target]) || !insideAny([realRoot, lexicalRoot], [real])) {
    throw new CliError('E_PATH_ESCAPE', `${what}: ${abs} is outside the sandbox root`, {
      root: lexicalRoot,
    });
  }
}
