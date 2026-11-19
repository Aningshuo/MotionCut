/**
 * 桌面端程序版本探测（NEW-07）。
 *
 * 顺序：先用可执行文件 `--version`，失败再回退 package.json → 目录名 → `.version`。
 * 不是所有 .app 都响应 `--version`（Electron 应用常直接开窗），所以只对本批
 * 已知的 Agent 应用名执行二进制；其他 .app 直接走元数据回退，避免误启动 GUI。
 *
 * 缓存键：`realpath + mtimeMs`。文件/App 更新后 mtime 变化，缓存自然失效。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** @type {Map<string, { version: string | null, source: string }>} */
const versionCache = new Map();

/** 允许执行 --version 的 App 名（避免启动无关 GUI）。 */
const EXECUTABLE_APP_NAMES = /^(codex|chatgpt|claude|cursor|gemini)(\s|$|\.)/i;
const VERSION_RE = /\b(\d+\.\d+(?:\.\d+){0,3})\b/;

export function clearVersionCache() {
  versionCache.clear();
}

/**
 * @param {string} programPath
 * @param {{ timeoutMs?: number, useCache?: boolean }} [opts]
 * @returns {Promise<string | null>}
 */
export async function programVersion(programPath, opts = {}) {
  const info = await programVersionInfo(programPath, opts);
  return info.version;
}

/**
 * @param {string} programPath
 * @param {{ timeoutMs?: number, useCache?: boolean }} [opts]
 * @returns {Promise<{ version: string | null, source: string, cacheKey?: string }>}
 */
export async function programVersionInfo(programPath, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 1_500;
  const useCache = opts.useCache !== false;

  /** @type {string} */
  let real;
  /** @type {number} */
  let mtimeMs;
  try {
    real = await fs.realpath(programPath);
    const stat = await fs.stat(real);
    mtimeMs = stat.mtimeMs;
  } catch {
    return { version: null, source: 'not-found' };
  }

  const cacheKey = `${real}::${mtimeMs}`;
  if (useCache) {
    const hit = versionCache.get(cacheKey);
    if (hit) return { ...hit, cacheKey };
  }

  const isApp = real.endsWith('.app');
  /** @type {{ version: string | null, source: string }} */
  let result = { version: null, source: 'none' };

  if (isApp) {
    const appName = path.basename(real, '.app');
    const exeName = await readBundleExecutable(real).catch(() => null);
    const candidateExe = exeName ?? appName;

    if (EXECUTABLE_APP_NAMES.test(appName)) {
      const exePath = path.join(real, 'Contents', 'MacOS', candidateExe);
      const fromBinary = await runVersionFlag(exePath, timeoutMs);
      if (fromBinary) {
        result = { version: fromBinary, source: 'app-executable --version' };
      }
    }

    if (!result.version) {
      for (const pkgPath of [
        path.join(real, 'Contents', 'Resources', 'app', 'package.json'),
        path.join(real, 'Contents', 'Resources', 'app.asar.unpacked', 'package.json'),
        path.join(real, 'Contents', 'Resources', 'package.json'),
        path.join(real, 'package.json'),
      ]) {
        const version = await readPackageVersion(pkgPath);
        if (version) {
          result = { version, source: `package.json (${pkgPath})` };
          break;
        }
      }
    }

    if (!result.version) {
      const dotVersion = await readDotVersion(real);
      if (dotVersion) result = { version: dotVersion, source: '.version' };
    }

    if (!result.version) {
      const fromName = extractVersion(appName);
      if (fromName) result = { version: fromName, source: 'directory name' };
    }
  } else {
    const fromBinary = await runVersionFlag(real, timeoutMs);
    if (fromBinary) {
      result = { version: fromBinary, source: 'executable --version' };
    } else {
      const fromName = extractVersion(path.basename(real));
      if (fromName) result = { version: fromName, source: 'file name' };
    }
  }

  if (useCache) versionCache.set(cacheKey, result);
  return { ...result, cacheKey };
}

/**
 * @param {string} exePath
 * @param {number} timeoutMs
 * @returns {Promise<string | null>}
 */
async function runVersionFlag(exePath, timeoutMs) {
  try {
    await fs.access(exePath, fs.constants.X_OK);
  } catch {
    return null;
  }

  return new Promise((resolve) => {
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = spawn(exePath, ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        // 最小 env：不需要用户密钥，也不透传全部环境。
        env: { PATH: process.env.PATH ?? '', HOME: os.homedir(), LANG: process.env.LANG ?? 'C' },
        detached: true,
        cwd: os.tmpdir(),
      });
    } catch {
      resolve(null);
      return;
    }

    let output = '';
    let settled = false;
    const finish = (/** @type {string | null} */ value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            /* gone */
          }
        }
      }
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', () => finish(null));
    child.on('exit', () => finish(extractVersion(output)));
  });
}

/**
 * @param {string} appPath
 * @returns {Promise<string | null>}
 */
async function readBundleExecutable(appPath) {
  const plist = await fs.readFile(path.join(appPath, 'Contents', 'Info.plist'), 'utf8');
  const match = plist.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/);
  return match && match[1] ? match[1].trim() : null;
}

/**
 * @param {string} pkgPath
 * @returns {Promise<string | null>}
 */
async function readPackageVersion(pkgPath) {
  try {
    const raw = await fs.readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(raw);
    if (typeof pkg?.version === 'string') return extractVersion(pkg.version);
  } catch {
    /* missing or malformed package.json */
  }
  return null;
}

/**
 * @param {string} appPath
 * @returns {Promise<string | null>}
 */
async function readDotVersion(appPath) {
  for (const candidate of [
    path.join(appPath, 'Contents', 'Resources', '.version'),
    path.join(appPath, '.version'),
  ]) {
    try {
      const raw = await fs.readFile(candidate, 'utf8');
      const version = extractVersion(raw.trim());
      if (version) return version;
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * @param {string} text
 * @returns {string | null}
 */
function extractVersion(text) {
  const match = text.match(VERSION_RE);
  return match && match[1] ? match[1] : null;
}

/**
 * 列出已知 Agent App 的版本（供桌面端展示）；不读任何凭据。
 * @param {readonly string[]} [appDirs]
 * @returns {Promise<Array<{ path: string, name: string, version: string | null, source: string }>>}
 */
export async function listAgentAppVersions(appDirs = ['/Applications', path.join(os.homedir(), 'Applications')]) {
  /** @type {Array<{ path: string, name: string, version: string | null, source: string }>} */
  const out = [];
  for (const dir of appDirs) {
    /** @type {string[]} */
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.app') || !EXECUTABLE_APP_NAMES.test(entry)) continue;
      const full = path.join(dir, entry);
      const info = await programVersionInfo(full);
      out.push({ path: full, name: entry, version: info.version, source: info.source });
    }
  }
  return out;
}
