#!/usr/bin/env node
/**
 * `opencut-mcp` 可执行入口（WP18）。
 *
 * stdio MCP server。写类 tool 需要**两道门**：启动时的 `--allow-write`，以及
 * **每次调用**参数里的 `"confirm": true`。
 *
 *   node packages/mcp/bin.mjs --root <sandbox> --allow-write --film-module ./film-port.mjs
 *
 * 会话隔离（P8-A7）：每个进程一个 sessionId，opId 账本落在
 * `<state-dir>/session-<id>/`，两个会话的幂等状态不互相污染；审计共用一个
 * `<state-dir>/audit/audit.jsonl`，每行带 session 字段。
 *
 * 与 CLI 共用端口契约（`createPorts`/`create*Port`）。本树没有 film-core，
 * 默认 `E_NOT_WIRED`；集成时由大脑注入。
 */

import crypto from 'node:crypto';
import path from 'node:path';

import { createContext } from '../cli/ops.mjs';
import { loadPorts, readEnvJson, splitHostFlags } from '../cli/modules.mjs';
import { createMcpServer } from './server.mjs';
import { serveStdio } from './index.mjs';

async function main() {
  /** @type {Map<string, string | true>} */
  let host;
  const argv = process.argv.slice(2);
  // 这两个是 MCP 自己的旋钮（CLI 不认识），先摘掉再交给公共解析
  /** @type {number | undefined} */
  let rateLimit;
  /** @type {number | undefined} */
  let auditMaxBytes;
  /** @type {string | undefined} */
  let auditDir;
  /** @type {string | undefined} */
  let studioUrl;
  /** @type {string | undefined} */
  let grantId;
  /** @type {string | undefined} */
  let studioProjectId;
  for (const name of ['--rate-limit', '--audit-dir', '--audit-max-bytes', '--studio-url', '--grant', '--project-id']) {
    const index = argv.indexOf(name);
    if (index < 0) continue;
    const value = argv[index + 1];
    if (value === undefined) {
      process.stderr.write(`E_USAGE: ${name} needs a value\n`);
      process.exitCode = 1;
      return;
    }
    if (name === '--rate-limit') rateLimit = Number(value);
    else if (name === '--audit-max-bytes') auditMaxBytes = Number(value);
    else if (name === '--studio-url') studioUrl = value;
    else if (name === '--grant') grantId = value;
    else if (name === '--project-id') studioProjectId = value;
    else auditDir = value;
    argv.splice(index, 2);
  }
  try {
    ({ host } = splitHostFlags(argv));
  } catch (err) {
    process.stderr.write(`E_USAGE: ${/** @type {Error} */ (err).message}\n`);
    process.exitCode = 1;
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
      process.exitCode = 1;
      return;
    }
  }

  const root = path.resolve(/** @type {string} */ (host.get('--root')) ?? env.projectsRoot ?? cwd);
  const ctxForModules = { root, env, cwd };

  /** @type {{ projects?: any, film?: any, render?: any }} */
  let injected = {};
  for (const flag of ['--projects-module', '--film-module', '--render-module']) {
    const file = host.get(flag);
    if (typeof file !== 'string') continue;
    try {
      injected = { ...injected, ...(await loadPorts(file, ctxForModules)) };
    } catch (err) {
      process.stderr.write(`E_NOT_WIRED: ${flag} ${file}: ${/** @type {Error} */ (err).message}\n`);
      process.exitCode = 7;
      return;
    }
  }

  const sessionId = crypto.randomUUID();
  const baseState = path.resolve(
    cwd,
    typeof host.get('--state-dir') === 'string'
      ? /** @type {string} */ (host.get('--state-dir'))
      : path.join(env.tmpRoot ?? path.join(cwd, '.opencut-mcp'), 'state'),
  );
  const ctx = createContext({
    ...injected,
    env,
    root,
    cwd,
    // 每个会话自己的账本目录：两个 stdio 会话并发时 opId 不互相污染
    stateDir: path.join(baseState, `session-${sessionId.slice(0, 8)}`),
  });

  /* CS2（R30-125）：`--studio-url` + `--grant` 同时给了，`film_apply_ops` 就走
     Studio 的唯一写入口（进撤销栈）；只给一个视为配置错误 —— 半套配置比没有更危险。 */
  if ((studioUrl === undefined) !== (grantId === undefined)) {
    process.stderr.write('E_USAGE: --studio-url 与 --grant 必须同时给（半套配置等于没有授权）\n');
    process.exitCode = 1;
    return;
  }
  const server = createMcpServer(ctx, {
    allowWrite: host.get('--allow-write') === true,
    sessionId,
    auditDir: auditDir ? path.resolve(cwd, auditDir) : path.join(baseState, 'audit'),
    ...(rateLimit !== undefined ? { rateLimit } : {}),
    ...(auditMaxBytes !== undefined ? { auditMaxBytes } : {}),
    ...(studioUrl !== undefined && grantId !== undefined
      ? { studio: { baseUrl: studioUrl, grantId, ...(studioProjectId === undefined ? {} : { projectId: studioProjectId }) } }
      : {}),
  });
  await serveStdio({ server });
}

main().catch((err) => {
  process.stderr.write(`JOB_FAILED: ${err?.stack ?? err}\n`);
  process.exitCode = 8;
});
