/**
 * 宿主级开关与端口模块加载（WP18 / WP19 共用的集成缝）。
 *
 * CLI 和 MCP 两个入口都要做同样的事：从 argv 摘出"建进程之前就得生效"的开关，
 * 再按 `--film-module` / `--render-module` / `--projects-module` 动态 import 端口。
 * 写两份迟早会漂移，所以放这里。
 *
 * 模块契约（集成方按这个实现）：
 *   export function createPorts({ root, env, cwd }) → { film?, render?, projects? }
 * 或分别导出 createFilmPort / createRenderPort / createProjectsPort。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const HOST_FLAGS = Object.freeze(['--root', '--state-dir', '--env', '--film-module', '--render-module', '--projects-module', '--allow-write']);

/**
 * @param {readonly string[]} argv
 * @param {readonly string[]} [valueFlags] 需要取值的开关（其余按布尔处理）
 * @returns {{ host: Map<string, string | true>, rest: string[] }}
 */
export function splitHostFlags(argv, valueFlags = HOST_FLAGS) {
  /** @type {Map<string, string | true>} */
  const host = new Map();
  /** @type {string[]} */
  const rest = [];
  const booleanOnly = new Set(['--allow-write']);

  for (let i = 0; i < argv.length; i += 1) {
    const token = /** @type {string} */ (argv[i]);
    if (token === '--') {
      rest.push(...argv.slice(i));
      break;
    }
    if (booleanOnly.has(token)) {
      host.set(token, true);
      continue;
    }
    if (valueFlags.includes(token)) {
      const value = /** @type {string | undefined} */ (argv[i + 1]);
      if (value === undefined) throw new Error(`${token} needs a value`);
      host.set(token, value);
      i += 1;
      continue;
    }
    const eq = token.indexOf('=');
    if (token.startsWith('--') && eq > 0 && valueFlags.includes(token.slice(0, eq))) {
      host.set(token.slice(0, eq), token.slice(eq + 1));
      continue;
    }
    rest.push(token);
  }
  return { host, rest };
}

/**
 * @param {string} file
 * @param {{ root: string, env: Record<string, any>, cwd: string }} ctx
 * @returns {Promise<{ projects?: any, film?: any, render?: any }>}
 */
export async function loadPorts(file, ctx) {
  const abs = path.resolve(ctx.cwd, file);
  await fs.access(abs);
  const mod = await import(pathToFileURL(abs).href);

  if (typeof mod.createPorts === 'function') {
    return (await mod.createPorts(ctx)) ?? {};
  }

  /** @type {{ projects?: any, film?: any, render?: any }} */
  const ports = {};
  if (typeof mod.createProjectsPort === 'function') ports.projects = await mod.createProjectsPort(ctx);
  if (typeof mod.createFilmPort === 'function') ports.film = await mod.createFilmPort(ctx);
  if (typeof mod.createRenderPort === 'function') ports.render = await mod.createRenderPort(ctx);
  if (!ports.projects && !ports.film && !ports.render) {
    throw new Error(`${abs} exports no createPorts()/create*Port() (integration contract)`);
  }
  return ports;
}

/**
 * 读 `--env` / `OPENCUT_ENV_JSON`；没有就返回空对象（CLI 也能只靠 --root 工作）。
 * @param {string | undefined} file
 * @param {string} cwd
 * @returns {Promise<Record<string, any>>}
 */
export async function readEnvJson(file, cwd) {
  if (!file) return {};
  const abs = path.resolve(cwd, file);
  const text = await fs.readFile(abs, 'utf8');
  return JSON.parse(text);
}
