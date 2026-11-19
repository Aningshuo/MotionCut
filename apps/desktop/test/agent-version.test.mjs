// @ts-nocheck
/**
 * NEW-07：桌面端 Agent 版本探测的四条来源断言（M84 · B-MAIN-R30-041）。
 *
 * 为什么断言「来源」而不只是版本号：回退路径也能碰巧给出同一个版本字符串，
 * 只比字符串等于没测「先问程序、失败才回退」。这里每条都钉 `source`。
 *
 * 用临时目录造假 `.app`（三行 shell 脚本 + Info.plist + package.json），
 * 不依赖系统真的装了 codex。
 *
 * 跑法：node --test apps/desktop/test/agent-version.test.mjs
 */

import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { clearVersionCache, programVersionInfo } from '../src/agent-installation.mjs';

const PACKAGE_VERSION = '9.9.9';

/**
 * 造一个 `Codex.app`：
 * `Contents/Info.plist` 指到 `Contents/MacOS/codex`，`Contents/Resources/app/package.json` 给回退版本。
 * @param {{ script?: string|null, chmodExec?: boolean }} [options]
 */
async function makeApp(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencut-new07-'));
  const app = path.join(root, 'Codex.app');
  const macos = path.join(app, 'Contents', 'MacOS');
  const resources = path.join(app, 'Contents', 'Resources', 'app');
  await mkdir(macos, { recursive: true });
  await mkdir(resources, { recursive: true });
  await writeFile(
    path.join(app, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>codex</string></dict></plist>
`,
    'utf8',
  );
  await writeFile(path.join(resources, 'package.json'), `${JSON.stringify({ name: 'codex', version: PACKAGE_VERSION })}\n`, 'utf8');
  if (options.script !== undefined && options.script !== null) {
    const exe = path.join(macos, 'codex');
    await writeFile(exe, options.script, 'utf8');
    if (options.chmodExec !== false) await chmod(exe, 0o755);
  }
  return { root, app };
}

/** 每个用例用独立临时目录；清缓存避免 realpath+mtime 命中别的用例。 */
async function withApp(options, fn) {
  const { root, app } = await makeApp(options);
  clearVersionCache();
  try {
    await fn(app);
  } finally {
    clearVersionCache();
    await rm(root, { recursive: true, force: true });
  }
}

test('NEW-07-1 假 exe 输出 codex-cli 1.2.3：采用它，不读 package.json', async () => {
  await withApp({ script: '#!/bin/sh\necho "codex-cli 1.2.3"\n' }, async (app) => {
    const info = await programVersionInfo(app, { timeoutMs: 5_000 });
    assert.equal(info.version, '1.2.3');
    assert.equal(info.source, 'app-executable --version');
  });
});

test('NEW-07-2 假 exe 退出码非 0：回退 package.json，并标明来源', async () => {
  await withApp({ script: '#!/bin/sh\nexit 3\n' }, async (app) => {
    const info = await programVersionInfo(app, { timeoutMs: 5_000 });
    assert.equal(info.version, PACKAGE_VERSION);
    assert.ok(info.source.startsWith('package.json ('), `来源不对：${info.source}`);
    assert.ok(info.source.includes('Contents/Resources/app/package.json'), `来源路径不对：${info.source}`);
  });
});

test('NEW-07-3 假 exe 不存在：回退 package.json，不抛', async () => {
  await withApp({ script: null }, async (app) => {
    const info = await programVersionInfo(app, { timeoutMs: 5_000 });
    assert.equal(info.version, PACKAGE_VERSION);
    assert.ok(info.source.startsWith('package.json ('), `来源不对：${info.source}`);
  });
});

test('NEW-07-4 假 exe 输出乱码：回退 package.json，不抛', async () => {
  await withApp({ script: '#!/bin/sh\necho "@@@@ not a version"\n' }, async (app) => {
    const info = await programVersionInfo(app, { timeoutMs: 5_000 });
    assert.equal(info.version, PACKAGE_VERSION);
    assert.ok(info.source.startsWith('package.json ('), `来源不对：${info.source}`);
  });
});
