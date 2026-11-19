#!/usr/bin/env node
/**
 * `opencut` 可执行入口（WP18）。
 *
 * 只做三件事：读环境、按 `--*-module` 注入端口、把 argv 交给 CLI。
 * 它**不含业务逻辑**，也**没有内建 film 解析器**——真实 film 读写由 main 的
 * `film-core` 提供，集成时用 `--film-module` 接进来；本树默认 `WAIT_MAIN_FILM`。
 *
 *   OPENCUT_ENV_JSON=<abs> node packages/cli/bin.mjs film read <project> --json
 *   node packages/cli/bin.mjs ... --film-module ./my-film-port.mjs
 */

import path from 'node:path';

import { createCli, EXIT } from './index.mjs';
import { loadPorts, readEnvJson, splitHostFlags } from './modules.mjs';

async function main() {
  /** @type {Map<string, string | true>} */
  let host;
  /** @type {string[]} */
  let rest;
  try {
    ({ host, rest } = splitHostFlags(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`E_USAGE: ${/** @type {Error} */ (err).message}\n`);
    process.exitCode = EXIT.USAGE;
    return;
  }

  const cwd = process.cwd();
  /** @type {Record<string, any>} */
  let env = {};
  const envFile = host.get('--env') ?? process.env.OPENCUT_ENV_JSON;
  if (typeof envFile === 'string' && envFile.length > 0) {
    try {
      env = await readEnvJson(envFile, cwd);
    } catch (err) {
      process.stderr.write(`E_USAGE: cannot read env json ${envFile}: ${/** @type {Error} */ (err).message}\n`);
      process.exitCode = EXIT.USAGE;
      return;
    }
  }

  const root = path.resolve(/** @type {string} */ (host.get('--root')) ?? env.projectsRoot ?? cwd);
  const ctx = { root, env, cwd };

  /** @type {{ projects?: any, film?: any, render?: any }} */
  let injected = {};
  for (const flag of ['--projects-module', '--film-module', '--render-module']) {
    const file = host.get(flag);
    if (typeof file !== 'string') continue;
    try {
      injected = { ...injected, ...(await loadPorts(file, ctx)) };
    } catch (err) {
      process.stderr.write(`E_NOT_WIRED: ${flag} ${file}: ${/** @type {Error} */ (err).message}\n`);
      process.exitCode = EXIT.NOT_WIRED;
      return;
    }
  }

  /* P47：`export start` 的默认执行器。
     以前这里没有 render 端口 → 真实环境里 `export start` 直接 WAIT_MAIN_FILM，
     而 `export film` 早就支持多段/烧录/编码矩阵。`packages/render/port.mjs` 用
     detached worker 跑 renderFilmExport，是**产品实现**而不是验收脚本；
     `--render-module` 仍然可以覆盖它（宿主注入优先）。 */
  if (!injected.render) {
    try {
      const { createRenderPort } = await import('../render/port.mjs');
      injected.render = createRenderPort(ctx);
    } catch (err) {
      process.stderr.write(`E_NOT_WIRED: default render port: ${/** @type {Error} */ (err).message}\n`);
      process.exitCode = EXIT.NOT_WIRED;
      return;
    }
  }

  const cli = createCli({
    ...injected,
    env,
    root,
    cwd,
    ...(typeof host.get('--state-dir') === 'string'
      ? { stateDir: path.resolve(cwd, /** @type {string} */ (host.get('--state-dir'))) }
      : {}),
  });

  process.exitCode = await cli.run(rest);
}

main().catch((err) => {
  process.stderr.write(`JOB_FAILED: ${err?.stack ?? err}\n`);
  process.exitCode = EXIT.JOB_FAILED;
});
