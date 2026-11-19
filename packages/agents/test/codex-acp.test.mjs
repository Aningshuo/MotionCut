import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ADAPTER_PACKAGE,
  ALLOWED_SANDBOX_MODES,
  buildCodexAcpEnv,
  findCodexExecutable,
  resolveCodexAcp,
} from '../codex-acp.mjs';

/**
 * @param {string} prefix
 * @returns {Promise<string>}
 */
async function tmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * @param {string} file
 * @param {string} content
 * @param {number} mode
 */
async function writeFile(file, content, mode = 0o644) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  await fs.chmod(file, mode);
}

test('P3-A1 适配器从 node_modules 解析，入口是 dist/index.js', () => {
  const adapter = resolveCodexAcp();
  assert.equal(adapter.ok, true, JSON.stringify(adapter));
  if (!adapter.ok) return;
  assert.match(adapter.adapterPath, /node_modules\/@agentclientprotocol\/codex-acp\/dist\/index\.js$/);
  assert.equal(adapter.version, '2.5.0');
  assert.ok(ADAPTER_PACKAGE.startsWith('@agentclientprotocol/'));
});

test('P3-A1 codex 路径探测：env → PATH → 常见安装位；不可执行被跳过', async () => {
  const bin = await tmpDir('codex-bin-');
  const decoy = await tmpDir('codex-decoy-');
  const known = await tmpDir('codex-known-');
  await writeFile(path.join(bin, 'codex'), '#!/bin/sh\necho codex\n', 0o755);
  await writeFile(path.join(decoy, 'codex'), 'not executable\n', 0o644);
  await writeFile(path.join(known, '.local', 'bin', 'codex'), '#!/bin/sh\necho codex\n', 0o755);

  const viaPath = await findCodexExecutable({ env: { PATH: `${decoy}${path.delimiter}${bin}`, HOME: known } });
  assert.equal(viaPath.ok, true);
  if (viaPath.ok) {
    assert.equal(viaPath.path, path.join(bin, 'codex'));
    assert.equal(viaPath.source, `path:${bin}`);
  }

  const explicit = await findCodexExecutable({
    env: { PATH: bin, HOME: known, CODEX_PATH: path.join(known, '.local', 'bin', 'codex') },
  });
  assert.equal(explicit.ok, true);
  if (explicit.ok) assert.equal(explicit.source, 'env:CODEX_PATH');

  const viaKnown = await findCodexExecutable({ env: { PATH: '', HOME: known } });
  assert.equal(viaKnown.ok, true);
  if (viaKnown.ok) assert.equal(viaKnown.path, path.join(known, '.local', 'bin', 'codex'));

  const missing = await findCodexExecutable({ env: { PATH: decoy, HOME: '/nonexistent-home' } });
  assert.deepEqual(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error, 'AGENT_NOT_INSTALLED');
});

test('P3-A9 适配器 env 只含启动项；拒绝 agent-full-access', () => {
  const env = buildCodexAcpEnv({
    codexPath: '/Users/x/.local/bin/codex',
    sandboxMode: 'workspace-write',
    logsDir: '/tmp/logs',
  });
  assert.deepEqual(Object.keys(env).sort(), ['APP_SERVER_LOGS', 'CODEX_PATH', 'INITIAL_AGENT_MODE', 'NO_BROWSER']);
  assert.equal(env.CODEX_PATH, '/Users/x/.local/bin/codex');
  assert.equal(env.INITIAL_AGENT_MODE, 'workspace-write');
  assert.equal('CODEX_API_KEY' in env, false);
  assert.equal('OPENAI_API_KEY' in env, false);

  assert.throws(() => buildCodexAcpEnv({ codexPath: '/x', sandboxMode: 'agent-full-access' }), /refusing sandbox mode/);
  assert.throws(() => buildCodexAcpEnv({ codexPath: '/x', sandboxMode: 'agent' }), /refusing sandbox mode/);
  assert.deepEqual(ALLOWED_SANDBOX_MODES, ['read-only', 'workspace-write']);
});
