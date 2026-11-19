/**
 * P10-A5 的真实 stdio 会话：跑 `packages/mcp/bin.mjs` 子进程，调用 `export_start`
 * 两次（无 confirm / 有 confirm + audioMix），把请求响应原样写进 transcript。
 *
 *   node audio-export-session.mjs --transcript <out.json> --project <dir> --root <dir>
 *        --render-module <file> --audit-dir <dir> [--allow-write]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = new URL('../../../../', import.meta.url).pathname;
const BIN = path.join(ROOT, 'packages/mcp/bin.mjs');
const FILM_STUB = path.join(ROOT, 'packages/cli/test/fixtures/stub-ports.mjs');

/** @param {string[]} argv */
function parse(argv) {
  /** @type {Record<string, string | true>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i]);
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

const serverArgs = [
  BIN,
  '--root',
  root,
  '--film-module',
  FILM_STUB,
  '--state-dir',
  path.join(root, '.state-audio'),
];
if (typeof args['render-module'] === 'string') serverArgs.push('--render-module', String(args['render-module']));
if (typeof args['audit-dir'] === 'string') serverArgs.push('--audit-dir', String(args['audit-dir']));
if (args['allow-write'] === true) serverArgs.push('--allow-write');

const child = spawn(process.execPath, serverArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

/** @type {string} */
let buffer = '';
/** @type {string} */
let stderr = '';
/** @type {Array<{ request: any, response: any | null }>} */
const exchanges = [];
/** @type {Map<any, (value: any) => void>} */
const waiting = new Map();

child.stderr.on('data', (chunk) => {
  stderr += String(chunk);
});

child.once('exit', (code) => {
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

/** @param {any} request */
function send(request) {
  /** @type {{ request: any, response: any | null }} */
  const entry = { request, response: null };
  exchanges.push(entry);
  child.stdin.write(`${JSON.stringify(request)}\n`);
  if (request.id === undefined) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for id ${request.id}`)), 10_000);
    waiting.set(request.id, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

async function main() {
  await send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'p10-audio-session', version: '0.1.0' } },
  });
  await send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const spec = {
    jobId: 'p10-stdio',
    projectId: typeof args['project-id'] === 'string' ? String(args['project-id']) : 'proj',
    owner: 'SUB2',
    kind: 'video',
    range: [0, 1],
    fps: 30,
    outputDir: path.join(root, 'out-stdio'),
    // 证据脚本传真实工程哈希；测试默认用一个明显不存在的值（只验协议层）
    expectedHash: typeof args['expected-hash'] === 'string' ? String(args['expected-hash']) : 'a'.repeat(64),
  };
  const audioMix = {
    duration: 1,
    sampleRate: 48000,
    clips: [
      { src: path.join(root, 'tone.wav'), at: 0 },
      { src: path.join(root, 'tone.wav'), at: 0.5, volume: 0.5, fade: [0.1, 0.1] },
    ],
  };

  // 2) 没有 confirm：写门禁第二层必须拦住
  await send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'export_start', arguments: { project, spec, audioMix } },
  });

  // 3) 有 confirm：透传到 render 端口（stub）
  await send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'export_start', arguments: { project, spec, audioMix, confirm: true } },
  });

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
