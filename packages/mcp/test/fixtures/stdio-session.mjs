/**
 * 真实 stdio MCP 会话夹具（WP18-A6/A7/A8 的证据来源）。
 *
 * 它不是 mock：真的 `spawn` `packages/mcp/bin.mjs`，真的写 stdin、读 stdout，
 * 把请求/响应/退出码原样存成 transcript。测试与交接证据都吃这份 transcript。
 *
 *   node stdio-session.mjs --transcript <file.json> --project <dir> --root <dir> [--allow-write]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = new URL('../../../../', import.meta.url).pathname;
const BIN = path.join(ROOT, 'packages/mcp/bin.mjs');
const FILM_STUB = path.join(ROOT, 'packages/cli/test/fixtures/stub-ports.mjs');

/**
 * @param {string[]} argv
 */
function parse(argv) {
  /** @type {Record<string, string | true>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = /** @type {string} */ (argv[i]);
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[name] = true;
    else {
      out[name] = next;
      i += 1;
    }
  }
  return out;
}

const args = parse(process.argv.slice(2));
const transcriptPath = String(args.transcript);
const project = String(args.project);
const root = String(args.root);

const serverArgs = [BIN, '--root', root, '--film-module', FILM_STUB, '--state-dir', path.join(root, '.state')];
if (args['allow-write'] === true) serverArgs.push('--allow-write');

const child = spawn(process.execPath, serverArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

/** @type {string} */
let buffer = '';
/** @type {string} */
let stderr = '';
/** @type {Array<{ request: any, response: any | null }>} */
const exchanges = [];
/** @type {Map<number, (value: any) => void>} */
const waiting = new Map();

child.stderr.on('data', (chunk) => {
  stderr += String(chunk);
});

child.once('exit', (code) => {
  // 子进程先死（启动失败/崩溃）：别让调用方白等 10 秒
  for (const [id, resolve] of waiting) {
    resolve({ jsonrpc: '2.0', id, error: { code: 'CHILD_EXITED', message: `server exited with ${code}: ${stderr.slice(-400)}` } });
  }
  waiting.clear();
});

child.stdout.on('data', (chunk) => {
  buffer += String(chunk);
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length > 0) {
      const response = JSON.parse(line);
      const entry = exchanges.find((e) => e.response === null && e.request?.id === response.id);
      if (entry) entry.response = response;
      waiting.get(response.id)?.(response);
      waiting.delete(response.id);
    }
    index = buffer.indexOf('\n');
  }
});

/**
 * @param {any} request
 * @returns {Promise<any>}
 */
function send(request) {
  /** @type {{ request: any, response: any | null }} */
  const entry = { request, response: null };
  exchanges.push(entry);
  const id = request.id;
  child.stdin.write(`${JSON.stringify(request)}\n`);
  if (id === undefined) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for id ${id}`)), 10_000);
    waiting.set(id, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

async function main() {
  await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wp18-session', version: '0.1.0' } } });
  await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  await send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'film_apply_ops', arguments: { project, expectedHash: 'a'.repeat(64), opId: 'stdio-op-1', ops: [{ op: 'set', field: 'title', value: 'x' }] } },
  });
  await send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'film_read', arguments: { project: '../../etc/passwd' } } });
  await send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'film_read', arguments: { project } } });
  await send({ jsonrpc: '2.0', id: 6, method: 'session/whatever', params: {} });
  await send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'film_read', arguments: { project: 42 } } });
  await send({ jsonrpc: '2.0', id: 8, method: 'ping' });

  child.stdin.end();
  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve('timeout');
    }, 10_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  await fs.writeFile(
    transcriptPath,
    `${JSON.stringify(
      {
        layer: 'REAL_STDIO',
        binary: 'packages/mcp/bin.mjs',
        args: serverArgs.slice(1),
        allowWrite: args['allow-write'] === true,
        project,
        exchanges,
        stderr,
        exitCode,
        at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

main().catch(async (err) => {
  child.kill('SIGKILL');
  await fs.writeFile(
    transcriptPath,
    `${JSON.stringify({ layer: 'REAL_STDIO', error: String(err?.stack ?? err), exchanges, stderr }, null, 2)}\n`,
  );
  process.exitCode = 1;
});
