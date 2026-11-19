#!/usr/bin/env node
/**
 * B5 独立用例：端口被占时必须明确失败，不静默换端口。
 *
 * 跑法：node apps/desktop/test/port-busy.mjs
 * 退出码：0 PASS / 1 FAIL / 2 BLOCKED（缺 Electron 二进制）
 *
 * 单独成文件的原因：B5 只需要 Node + Electron，不需要 Playwright；
 * 与 GUI 用例隔离后，端口占用这条失败路径可以独立复跑。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const mainPath = join(repoRoot, 'apps', 'desktop', 'src', 'main.mjs');
const envPath = process.env.OPENCUT_ENV_JSON ?? join(repoRoot, '.local-runs', 'main', 'env.json');
const studioPort = JSON.parse(readFileSync(envPath, 'utf8')).studioPort;

/** @type {string} */
let electronPath = '';
try {
  electronPath = String(require('electron'));
} catch {
  electronPath = '';
}
if (!existsSync(electronPath)) {
  process.stdout.write(`BLOCKED electron 二进制缺失：${electronPath || '(未安装)'}\n`);
  process.exit(2);
}

/** @type {Record<string, string>} */
const env = {};
for (const [key, value] of Object.entries(process.env)) {
  if (typeof value === 'string' && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value;
}
env.OPENCUT_ENV_JSON = envPath;
env.OPENCUT_NO_SANDBOX = process.env.OPENCUT_REQUIRE_SANDBOX === '1' ? '0' : '1';

/** @type {Set<import('node:net').Socket>} */
const sockets = new Set();
const blocker = createServer((socket) => {
  // 故意不应答：只要占住端口即可（健康检查会挂在这里，直到进程被杀）。
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});
await new Promise((resolveListen, rejectListen) => {
  blocker.once('error', rejectListen);
  blocker.listen(studioPort, '127.0.0.1', () => resolveListen(undefined));
});

const run = spawn(electronPath, [mainPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
run.stdout.on('data', (chunk) => {
  output += String(chunk);
});
run.stderr.on('data', (chunk) => {
  output += String(chunk);
});

/** @type {number|string|null} */
let exitCode = await new Promise((resolveExit) => {
  const timer = globalThis.setTimeout(() => {
    run.kill('SIGKILL');
    resolveExit('timeout');
  }, 25_000);
  run.on('exit', (code) => {
    globalThis.clearTimeout(timer);
    resolveExit(code);
  });
});

// 不 await close：Electron 侧可能还挂着一条被占端口的连接，等它会空转。
blocker.close();
for (const socket of sockets) socket.destroy();

try {
  assert.notEqual(exitCode, 'timeout', '端口被占时进程 25s 内未退出');
  assert.notEqual(exitCode, 0, `端口被占却以 0 退出；日志：${output.slice(-300)}`);
  assert.match(output, /STUDIO_PORT_IN_USE/);
  process.stdout.write(`B5 PASS 占用 59369 后退出码 ${String(exitCode)}，日志含 STUDIO_PORT_IN_USE\n`);
  process.stdout.write(`B5_EVIDENCE ${output.split('\n').filter((line) => /PORT_IN_USE|EXITED|MAIN_EXIT/.test(line)).join(' | ')}\n`);
  process.exitCode = 0;
} catch (error) {
  process.stdout.write(`B5 FAIL ${String(/** @type {Error} */ (error).message).slice(0, 400)}\n`);
  process.exitCode = 1;
}
