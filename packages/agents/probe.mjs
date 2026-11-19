/**
 * 真实 Agent 探测（WP17 · P7）。
 *
 * 只做三件事：找可执行文件、跑 `--version`、读 App 的 Info.plist 版本。
 * **绝不**打开 ~/.codex/auth.json、keychain、Keychain、.claude/.credentials.json
 * 之类的凭据文件；认证状态未知就写 UNKNOWN / UNVERIFIED。
 *
 * @typedef {import('../../contracts/agent').AgentDescriptor} AgentDescriptor
 * @typedef {AgentDescriptor & { path?: string, note?: string, kind?: 'cli' | 'gui' }} ProbeDescriptor
 */

import { findCodexExecutable } from './codex-acp.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * 已知 CLI 名称 → 展示名。只探测这些，不做 PATH 全量扫描。
 * @type {ReadonlyArray<{ id: string, displayName: string, commands: readonly string[] }>}
 */
export const KNOWN_AGENTS = [
  { id: 'codex', displayName: 'Codex CLI', commands: ['codex'] },
  { id: 'claude-code', displayName: 'Claude Code', commands: ['claude'] },
  { id: 'cursor-agent', displayName: 'Cursor Agent', commands: ['cursor-agent'] },
  { id: 'gemini-cli', displayName: 'Gemini CLI', commands: ['gemini'] },
  { id: 'opencode', displayName: 'OpenCode', commands: ['opencode'] },
  { id: 'aider', displayName: 'Aider', commands: ['aider'] },
  { id: 'goose', displayName: 'Goose', commands: ['goose'] },
  { id: 'copilot', displayName: 'GitHub Copilot', commands: ['copilot'] },
  { id: 'codebuddy', displayName: 'CodeBuddy', commands: ['codebuddy', 'cbc'] },
  { id: 'qwen', displayName: 'Qwen Code', commands: ['qwen'] },
  { id: 'kimi', displayName: 'Kimi Code', commands: ['kimi'] },
  { id: 'minimax', displayName: 'MiniMax Code', commands: ['mcode'] },
  { id: 'deepseek', displayName: 'DeepSeek Harness', commands: ['dsh'] },
  { id: 'antigravity', displayName: 'Google Antigravity CLI', commands: ['agy'] },
];

/** 已知 GUI App（不是 ACP CLI，仅记录，不执行其二进制以免弹窗）。 */
const KNOWN_APPS = [
  { id: 'chatgpt-app', displayName: 'ChatGPT.app', match: /^chatgpt\.app$/i },
  { id: 'codex-app', displayName: 'Codex.app', match: /^codex\.app$/i },
  { id: 'claude-app', displayName: 'Claude.app', match: /^claude\.app$/i },
  { id: 'workbuddy-app', displayName: 'WorkBuddy.app', match: /^workbuddy\.app$/i },
  { id: 'workbuddy-ai-app', displayName: 'WorkBuddy AI.app', match: /^workbuddy ai\.app$/i },
  { id: 'cursor-app', displayName: 'Cursor.app', match: /^cursor\.app$/i },
  { id: 'antigravity-app', displayName: 'Google Antigravity', match: /^(?:google )?antigravity\.app$/i },
];

/**
 * @param {{
 *   searchDirs?: readonly string[],
 *   appDirs?: readonly string[],
 *   agents?: typeof KNOWN_AGENTS,
 *   versionTimeoutMs?: number,
 *   includeGuiApps?: boolean,
 * }} [opts]
 */
export async function probeAgents(opts = {}) {
  const searchDirs = opts.searchDirs ?? defaultSearchDirs();
  const appDirs = opts.appDirs ?? defaultAppDirs();
  const agents = opts.agents ?? KNOWN_AGENTS;
  const versionTimeoutMs = opts.versionTimeoutMs ?? 2_000;

  /** @type {ProbeDescriptor[]} */
  const descriptors = [];
  /** @type {Array<{ id: string, path: string, version?: string, state: string, auth: string }>} */
  const found = [];

  for (const agent of agents) {
    const codex = agent.id === 'codex' && !opts.searchDirs ? await findCodexExecutable() : null;
    const executable = codex?.ok ? codex.path : await findFirstExecutable(agent.commands, searchDirs);
    if (!executable) {
      descriptors.push({
        id: agent.id,
        displayName: agent.displayName,
        state: 'NOT_INSTALLED',
        auth: 'UNKNOWN',
        capabilities: noCapabilities(),
      });
      continue;
    }

    const version = await probeVersion(executable, versionTimeoutMs);
    /** @type {ProbeDescriptor} */
    const descriptor = {
      id: agent.id,
      displayName: agent.displayName,
      ...(version ? { version } : {}),
      // 版本能回 = CLI 可执行；登录态未验证 → auth UNKNOWN，整体仍是 UNVERIFIED。
      state: version ? 'READY' : 'INCOMPATIBLE',
      auth: 'UNKNOWN',
      capabilities: noCapabilities(),
      path: executable,
      note: version ? 'AUTH_UNVERIFIED' : 'VERSION_PROBE_FAILED',
      kind: 'cli',
    };
    descriptors.push(descriptor);
    found.push({
      id: agent.id,
      path: executable,
      ...(version ? { version } : {}),
      state: descriptor.state,
      auth: 'UNKNOWN',
    });
  }

  if (opts.includeGuiApps !== false) {
    const apps = await findGuiApps(appDirs);
    for (const app of apps) {
      const version = await readBundleVersion(app.path);
      descriptors.push({
        id: app.id,
        displayName: app.displayName,
        ...(version ? { version } : {}),
        // GUI 不是 ACP CLI：明确 INCOMPATIBLE，不假装能开会话。
        state: 'INCOMPATIBLE',
        auth: 'UNKNOWN',
        capabilities: noCapabilities(),
        path: app.path,
        note: 'GUI_ONLY_NOT_ACP',
        kind: 'gui',
      });
    }
  }

  return {
    checkedAt: new Date().toISOString(),
    auth: 'UNKNOWN',
    found,
    descriptors,
    missing: descriptors.filter((d) => d.state === 'NOT_INSTALLED').map((d) => d.id),
  };
}

/** @returns {string[]} */
export function defaultSearchDirs() {
  /** @type {string[]} */
  const dirs = [];
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    if (entry) dirs.push(entry);
  }
  for (const extra of ['/opt/homebrew/bin', '/usr/local/bin', ...['.local', '.cargo', '.opencode', '.kimi-code', '.minimax-code'].map((dir) => path.join(os.homedir(), dir, 'bin'))]) {
    dirs.push(extra);
  }
  return [...new Set(dirs)];
}

/** @returns {string[]} */
export function defaultAppDirs() {
  return ['/Applications', path.join(os.homedir(), 'Applications')];
}

/**
 * 在候选目录里找第一个可执行文件；同名但不可执行的文件会被跳过（P7 要求）。
 * @param {readonly string[]} names
 * @param {readonly string[]} dirs
 * @returns {Promise<string | null>}
 */
export async function findFirstExecutable(names, dirs) {
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * @param {string} candidate
 * @returns {Promise<boolean>}
 */
export async function isExecutableFile(candidate) {
  try {
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) return false;
    if (process.platform !== 'win32') await fs.access(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 跑 `--version`，超时/无输出返回 null。只读 stdout/stderr，不碰任何凭据文件。
 * @param {string} executable
 * @param {number} timeoutMs
 * @returns {Promise<string | null>}
 */
export async function probeVersion(executable, timeoutMs = 2_000) {
  return new Promise((resolve) => {
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = spawn(executable, ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH ?? '', HOME: os.homedir(), LANG: process.env.LANG ?? 'C' },
        detached: true,
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
            /* already gone */
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
    child.on('exit', () => {
      const version = parseVersion(output);
      finish(version);
    });
  });
}

/**
 * @param {string} text
 * @returns {string | null}
 */
export function parseVersion(text) {
  const match = text.match(/\b(\d+\.\d+(?:\.\d+){0,3})\b/);
  return match && match[1] ? match[1] : null;
}

/**
 * @param {readonly string[]} appDirs
 * @returns {Promise<Array<{ id: string, displayName: string, path: string }>>}
 */
async function findGuiApps(appDirs) {
  /** @type {Array<{ id: string, displayName: string, path: string }>} */
  const apps = [];
  for (const dir of appDirs) {
    /** @type {string[]} */
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.app')) continue;
      const known = KNOWN_APPS.find((app) => app.match.test(entry));
      if (!known) continue;
      apps.push({ id: known.id, displayName: known.displayName, path: path.join(dir, entry) });
    }
  }
  return apps;
}

/**
 * 读 Info.plist（文本 XML）里的 CFBundleShortVersionString；二进制 plist 返回 null。
 * 这是 App 元数据，不是凭据。
 * @param {string} appPath
 * @returns {Promise<string | null>}
 */
async function readBundleVersion(appPath) {
  try {
    const plist = await fs.readFile(path.join(appPath, 'Contents', 'Info.plist'), 'utf8');
    const match = plist.match(
      /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/,
    );
    return match && match[1] ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/** @returns {AgentDescriptor['capabilities']} */
function noCapabilities() {
  return { images: false, resume: false, steering: false, permissions: false, models: false };
}
