import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { probeAgents, parseVersion } from '../probe.mjs';
import { programVersionInfo, clearVersionCache } from '../../../apps/desktop/src/agent-installation.mjs';

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

test('P7 探测：PATH + 可执行过滤 + 版本 + 认证 UNKNOWN', async () => {
  const bin = await tmpDir('probe-bin-');
  const decoy = await tmpDir('probe-decoy-');

  await writeFile(path.join(bin, 'codex'), '#!/bin/sh\necho "codex-cli 9.9.9"\n', 0o755);
  // 同名但不可执行：必须被跳过。
  await writeFile(path.join(decoy, 'codex'), 'not executable\n', 0o644);

  const result = await probeAgents({
    searchDirs: [decoy, bin],
    appDirs: [],
    agents: [
      { id: 'codex', displayName: 'Codex CLI', commands: ['codex'] },
      { id: 'claude-code', displayName: 'Claude Code', commands: ['claude'] },
    ],
    versionTimeoutMs: 5_000,
  });

  const codex = result.descriptors.find((d) => d.id === 'codex');
  assert.equal(codex?.state, 'READY');
  assert.equal(codex?.version, '9.9.9');
  assert.equal(codex?.auth, 'UNKNOWN');
  assert.equal(codex?.path, path.join(bin, 'codex'));
  assert.equal(codex?.capabilities.images, false, 'probe must not invent capabilities');

  const claude = result.descriptors.find((d) => d.id === 'claude-code');
  assert.equal(claude?.state, 'NOT_INSTALLED');
  assert.deepEqual(result.found.map((f) => f.id), ['codex']);
  assert.equal(parseVersion('codex-cli 0.159.2'), '0.159.2');
});

test('P7 探测：不执行 GUI 二进制，只读 Info.plist', async () => {
  const appDir = await tmpDir('probe-apps-');
  const marker = path.join(appDir, 'gui-executed.marker');
  const appPath = path.join(appDir, 'ChatGPT.app');
  await fs.mkdir(path.join(appPath, 'Contents', 'MacOS'), { recursive: true });
  await writeFile(
    path.join(appPath, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleShortVersionString</key><string>26.1023.51421</string>
</dict></plist>
`,
  );
  await writeFile(
    path.join(appPath, 'Contents', 'MacOS', 'ChatGPT'),
    `#!/bin/sh\necho executed > ${marker}\n`,
    0o755,
  );

  const result = await probeAgents({
    searchDirs: [],
    appDirs: [appDir],
    agents: [],
    versionTimeoutMs: 1_000,
  });

  const app = result.descriptors.find((d) => d.id === 'chatgpt-app');
  assert.equal(app?.state, 'INCOMPATIBLE');
  assert.equal(app?.version, '26.1023.51421');
  assert.equal(app?.note, 'GUI_ONLY_NOT_ACP');
  await assert.rejects(fs.access(marker), 'GUI binary must not be executed');
});

test('程序版本：--version 优先，package.json / 目录名 / .version 回退', async () => {
  clearVersionCache();
  const dir = await tmpDir('install-');

  // 1) --version
  const codexApp = path.join(dir, 'Codex.app');
  await fs.mkdir(path.join(codexApp, 'Contents', 'MacOS'), { recursive: true });
  await writeFile(path.join(codexApp, 'Contents', 'MacOS', 'Codex'), '#!/bin/sh\necho "codex 1.2.3"\n', 0o755);
  const fromBinary = await programVersionInfo(codexApp);
  assert.equal(fromBinary.version, '1.2.3');
  assert.match(fromBinary.source, /--version/);

  // 2) package.json
  const chatgptApp = path.join(dir, 'ChatGPT.app');
  await writeFile(
    path.join(chatgptApp, 'Contents', 'Resources', 'app', 'package.json'),
    JSON.stringify({ name: 'chatgpt', version: '4.5.6' }),
  );
  const fromPkg = await programVersionInfo(chatgptApp);
  assert.equal(fromPkg.version, '4.5.6');
  assert.match(fromPkg.source, /package\.json/);

  // 3) 目录名
  const claudeApp = path.join(dir, 'Claude 7.8.9.app');
  await fs.mkdir(path.join(claudeApp, 'Contents'), { recursive: true });
  const fromName = await programVersionInfo(claudeApp);
  assert.equal(fromName.version, '7.8.9');
  assert.equal(fromName.source, 'directory name');

  // 4) .version
  const cursorApp = path.join(dir, 'Cursor.app');
  await writeFile(path.join(cursorApp, 'Contents', 'Resources', '.version'), '3.2.1\n');
  const fromDot = await programVersionInfo(cursorApp);
  assert.equal(fromDot.version, '3.2.1');
  assert.equal(fromDot.source, '.version');

  // 5) 缓存键 realpath + mtime：touch 后必须换 key。
  const before = await programVersionInfo(codexApp);
  const future = new Date(Date.now() + 5_000);
  await fs.utimes(codexApp, future, future);
  const after = await programVersionInfo(codexApp);
  assert.notEqual(before.cacheKey, after.cacheKey);
  assert.equal(after.version, '1.2.3');
});
