#!/usr/bin/env node
/**
 * M2 冒烟：B1–B6。
 *
 * 跑法：node apps/desktop/test/smoke.mjs
 * 退出码：0 全 PASS；1 有 FAIL；2 BLOCKED（缺 Electron 二进制/无图形会话）。
 *
 * 只读自己的目录：userData 指向 .local-runs/main/userdata，端口 59369/59370 仅本线使用。
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const mainPath = join(repoRoot, 'apps', 'desktop', 'src', 'main.mjs');
const envPath = process.env.OPENCUT_ENV_JSON ?? join(repoRoot, '.local-runs', 'main', 'env.json');

/** @type {Record<string, string>} */
const env = {};
for (const [key, value] of Object.entries(process.env)) {
  // 宿主（WorkBuddy/VS Code 等 Electron 应用）会把 ELECTRON_RUN_AS_NODE=1 漏给子进程，
  // 带着它启动会让 Electron 退化成纯 Node，require('electron') 拿不到内置 API。
  if (typeof value === 'string' && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value;
}
env.OPENCUT_ENV_JSON = envPath;
// 本机是签名受限会话：Chromium OS 沙箱起不来（Operation not permitted）。
// 仅关闭 OS 沙箱与 GPU，webPreferences.sandbox 仍为 true，B2 仍验证页面无 Node 权限。
env.OPENCUT_NO_SANDBOX = process.env.OPENCUT_REQUIRE_SANDBOX === '1' ? '0' : '1';
// 端口从 env.json 读，不写死：集成根与三条线各用独立端口段，写死会在别的树里假失败。
const studioPort = JSON.parse(readFileSync(envPath, 'utf8')).studioPort;
const studioOrigin = `http://127.0.0.1:${studioPort}`;

/** @type {{id: string, status: 'PASS'|'FAIL'|'BLOCKED', detail: string}[]} */
const results = [];

/** @param {string} id @param {string} detail */
function pass(id, detail) {
  results.push({ id, status: 'PASS', detail });
  process.stdout.write(`${id} PASS ${detail}\n`);
}

/** @param {string} id @param {string} detail */
function fail(id, detail) {
  results.push({ id, status: 'FAIL', detail });
  process.stdout.write(`${id} FAIL ${detail}\n`);
}

/** @param {string} message */
function blocked(message) {
  process.stdout.write(`BLOCKED ${message}\n`);
  process.exitCode = 2;
}

/** 用 pgrep 数 Electron 主进程（补 ps 在受限会话里不可用）。 @returns {number} */
function electronProcessCount() {
  try {
    const output = execFileSync('pgrep', ['-f', 'Electron.app/Contents/MacOS/Electron'], { encoding: 'utf8' });
    return output.split('\n').filter((line) => line.trim() !== '').length;
  } catch (error) {
    // pgrep 无匹配时退出码 1，等价于 0 个进程。
    return /** @type {any} */ (error)?.status === 1 ? 0 : -1;
  }
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** @type {string} */
let electronPath = '';
try {
  electronPath = require('electron');
} catch (error) {
  blocked(`electron 模块不可用：${String(/** @type {Error} */ (error).message)}`);
  electronPath = '';
}
if (process.exitCode === 2) {
  // already blocked
} else if (typeof electronPath !== 'string' || !existsSync(electronPath)) {
  blocked(`electron 二进制缺失（${String(electronPath)}），先跑 node node_modules/electron/install.js`);
}

/** @type {import('playwright').ElectronApplication | null} */
let app = null;
/** @type {import('playwright').Page | null} */
let page = null;
/** @type {string[]} */
const mainLog = [];

async function main() {
  if (process.exitCode === 2) return;

  // ---------- 启动 ----------
  const startedAt = Date.now();
  try {
    app = await electron.launch({
      executablePath: /** @type {string} */ (electronPath),
      args: [mainPath],
      env,
      timeout: 20_000,
    });
  } catch (error) {
    blocked(`Electron 启动失败（可能缺图形会话）：${String(/** @type {Error} */ (error).message).slice(0, 400)}`);
    return;
  }

  const child = app.process();
  child.stdout?.on('data', (chunk) => mainLog.push(String(chunk)));
  child.stderr?.on('data', (chunk) => mainLog.push(String(chunk)));

  /** @type {string[]} */
  const pageErrors = [];
  try {
    page = await app.firstWindow({ timeout: 15_000 });
  } catch (error) {
    fail('B1', `窗口未在 15s 内出现：${String(/** @type {Error} */ (error).message).slice(0, 300)}`);
    await app.close().catch(() => undefined);
    return;
  }
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  // ---------- B1 冷启动 ----------
  try {
    await page.waitForFunction(() => document.readyState === 'complete', undefined, { timeout: 10_000 });
    const visible = await app.evaluate(({ BrowserWindow }) => {
      const [window] = BrowserWindow.getAllWindows();
      return window !== undefined && window.isVisible();
    });
    const elapsed = Date.now() - startedAt;
    assert.equal(visible, true, '窗口 isVisible() 为 false');
    await sleep(300);
    const uncaught = mainLog.join('').match(/MAIN_UNCAUGHT|uncaughtException/);
    assert.equal(uncaught, null, `主进程日志含 uncaught：${String(uncaught)}`);
    assert.deepEqual(pageErrors, [], `页面 uncaught：${pageErrors.join(' | ')}`);
    pass('B1', `窗口可见 ${elapsed}ms，主进程/页面无 uncaught`);
  } catch (error) {
    fail('B1', String(/** @type {Error} */ (error).message).slice(0, 400));
  }

  // ---------- B2 页面能力探测 ----------
  try {
    const probe = await page.evaluate(() => /** @type {any} */ (window).__opencutProbe);
    assert.ok(probe !== undefined && probe !== null, '__opencutProbe 不存在');
    assert.equal(probe.require, 'undefined', `typeof require = ${String(probe.require)}`);
    assert.equal(probe.process, 'undefined', `typeof process = ${String(probe.process)}`);
    assert.deepEqual(probe.opencut, ['health', 'onEvent', 'openProjectDialog', 'tabs']);
    assert.equal(await page.evaluate(() => 'ipcRenderer' in window), false, 'window.ipcRenderer 泄漏');
    const health = await page.evaluate(() => /** @type {any} */ (window).opencut.health());
    assert.equal(health?.ok, true, `window.opencut.health() = ${JSON.stringify(health)}`);
    pass('B2', `require/process undefined，opencut 仅 ${probe.opencut.join(',')}，health.ok=true pid=${String(health.pid)}`);
  } catch (error) {
    fail('B2', String(/** @type {Error} */ (error).message).slice(0, 400));
  }

  // ---------- B3 第二个 origin ----------
  try {
    const bad = await fetch(`${studioOrigin}/healthz`, { headers: { origin: 'http://evil.example' } });
    const badBody = await bad.text();
    assert.equal(bad.status, 403, `非允许 origin 返回 ${bad.status}`);
    assert.match(badBody, /ORIGIN_REJECTED/);
    const good = await fetch(`${studioOrigin}/healthz`, { headers: { origin: studioOrigin } });
    assert.equal(good.status, 200);
    assert.equal(await page.evaluate(() => 'ok'), 'ok');
    pass('B3', 'evil origin → 403 ORIGIN_REJECTED；自身 origin → 200');
  } catch (error) {
    fail('B3', String(/** @type {Error} */ (error).message).slice(0, 400));
  }

  // ---------- B6 导航拦截 ----------
  try {
    const before = app.windows().length;
    await page.evaluate(() => {
      window.location.href = 'https://example.com';
    });
    await sleep(1200);
    const url = page.url();
    assert.ok(url.startsWith(studioOrigin), `导航未被拦截，当前 URL=${url}`);
    const opened = await page.evaluate(() => {
      const handle = window.open('https://example.com', '_blank');
      return handle === null;
    });
    await sleep(600);
    assert.equal(opened, true, 'window.open 返回了窗口句柄（未被 deny）');
    assert.equal(app.windows().length, before, '出现了新窗口');
    assert.ok(mainLog.join('').includes('NAVIGATION_BLOCKED'), '主进程未记录 NAVIGATION_BLOCKED');
    assert.ok(mainLog.join('').includes('WINDOW_OPEN_DENIED'), '主进程未记录 WINDOW_OPEN_DENIED');
    pass('B6', 'https 导航被阻止、window.open 被 deny、窗口数不变');
  } catch (error) {
    fail('B6', String(/** @type {Error} */ (error).message).slice(0, 400));
  }

  // ---------- B7 多标签：每工程独立视图，切标签不重建，关标签释放订阅 ----------
  try {
    const openA = await page.evaluate(() => /** @type {any} */ (window).opencut.tabs.open({ projectId: 'smoke-a', url: 'about:blank#a' }));
    const openB = await page.evaluate(() => /** @type {any} */ (window).opencut.tabs.open({ projectId: 'smoke-b', url: 'about:blank#b' }));
    assert.equal(openA.ok, true, JSON.stringify(openA));
    assert.equal(openB.ok, true, JSON.stringify(openB));
    assert.equal(openA.created, true);
    assert.equal(openB.created, true);

    await page.evaluate(() => /** @type {any} */ (window).opencut.tabs.activate('smoke-a'));
    await page.evaluate(() => /** @type {any} */ (window).opencut.tabs.activate('smoke-b'));
    const again = await page.evaluate(() => /** @type {any} */ (window).opencut.tabs.open({ projectId: 'smoke-a', url: 'about:blank#a' }));
    assert.equal(again.created, false, '重复打开不得新建实例');

    const listed = await page.evaluate(() => /** @type {any} */ (window).opencut.tabs.list());
    assert.equal(listed.open, 2);
    assert.equal(listed.created, 2, '两个工程两个视图实例');
    assert.equal(listed.subscriptions, 2, '每个工程一条事件订阅');
    const alpha = listed.projects.find((/** @type {any} */ item) => item.projectId === 'smoke-a');
    assert.equal(alpha.creations, 1, '切标签后创建计数仍为 1');

    await page.evaluate(() => /** @type {any} */ (window).opencut.tabs.close('smoke-a'));
    const afterClose = await page.evaluate(() => /** @type {any} */ (window).opencut.tabs.list());
    assert.equal(afterClose.open, 1);
    assert.equal(afterClose.destroyed, 1);
    assert.equal(afterClose.subscriptions, 1, '关标签后该工程订阅必须释放');
    pass('B7', `两标签 created=${listed.created} subscriptions=${listed.subscriptions}；切标签 creations=1；关闭后 destroyed=${afterClose.destroyed} subscriptions=${afterClose.subscriptions}`);
  } catch (error) {
    fail('B7', String(/** @type {Error} */ (error).message).slice(0, 400));
  }

  // ---------- B4 退出清理 ----------
  try {
    const health = await (await fetch(`${studioOrigin}/healthz`)).json();
    const studioPid = Number(health.pid);
    const mainPid = child.pid ?? -1;
    const before = electronProcessCount();
    assert.ok(studioPid > 0, '未取到 Studio pid');
    assert.ok(alive(studioPid), `Studio pid ${studioPid} 启动后不存在`);

    await app.close();
    app = null;

    let waited = 0;
    while (waited < 8000 && (alive(studioPid) || alive(mainPid))) {
      await sleep(150);
      waited += 150;
    }
    assert.equal(alive(studioPid), false, `Studio pid ${studioPid} 退出后仍存活`);
    assert.equal(alive(mainPid), false, `Electron main pid ${mainPid} 退出后仍存活`);
    const after = electronProcessCount();
    if (before >= 0 && after >= 0) {
      assert.ok(after <= before, `Electron 进程数从 ${before} 涨到 ${after}（残留）`);
    }
    pass(
      'B4',
      `退出后 Studio pid ${studioPid} 与 main pid ${mainPid} 均消失（${waited}ms 内），pgrep Electron 数 ${before}→${after}`,
    );
  } catch (error) {
    fail('B4', String(/** @type {Error} */ (error).message).slice(0, 400));
    if (app !== null) await app.close().catch(() => undefined);
  }

  // ---------- B5 端口被占（独立进程跑，避免与 Playwright 生命周期纠缠） ----------
  try {
    const code = await new Promise((resolveExit) => {
      const child = spawn(process.execPath, [join(here, 'port-busy.mjs')], { stdio: ['ignore', 'inherit', 'inherit'] });
      child.on('exit', (exitCode) => resolveExit(exitCode));
    });
    if (code === 0) {
      pass('B5', '独立用例 port-busy.mjs：占用 59369 → 退出码非 0 且日志含 STUDIO_PORT_IN_USE');
    } else if (code === 2) {
      fail('B5', 'BLOCKED：port-busy.mjs 缺 Electron 二进制');
    } else {
      fail('B5', `port-busy.mjs 退出码 ${String(code)}`);
    }
  } catch (error) {
    fail('B5', String(/** @type {Error} */ (error).message).slice(0, 400));
  }

  const failed = results.filter((item) => item.status === 'FAIL');
  process.stdout.write(`SUMMARY pass=${results.filter((item) => item.status === 'PASS').length} fail=${failed.length}\n`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  process.stdout.write(`SMOKE_CRASH ${String(/** @type {Error} */ (error).stack ?? error)}\n`);
  process.exitCode = 1;
});
