// @ts-nocheck —— 版本存储以真实 git 子进程为准（同 packages/studio/server 其它模块口径）
/**
 * M62-WP09-NAMED-VERSIONS · 命名版本（B-MAIN-R30-030 · R50）
 *
 * ## 存储决定（大脑已定，见任务书 §5.1）
 *
 * - 版本库：`<project>/.film/versions.git`；每次子进程都显式
 *   `--git-dir <…> --work-tree <project realpath>`，**不依赖 cwd 推出来的仓库**。
 * - 只跟踪**文本**：`film.html`、`.film/**\/*.json`、以及
 *   `.html/.css/.js/.mjs/.json/.txt/.md/.srt/.ass/.vtt`，单文件 ≤ 2 MiB。
 *   媒体不进 git，只在 `$GIT_DIR/media/<commit>.json` 记清单 `{path,bytes,mtime}`。
 * - **不新增可写真源**：运行期只读 `film.html`；versions.git 只作快照存储，
 *   任何功能都不得把它当工程读。
 *
 * ## 安全边界（本批新增）
 *
 * - 路径：`path.resolve` → `realpath` 求根与目标，目标必须 `startsWith(root + sep)`；
 *   拒绝 `..`、绝对路径、realpath 落在根外的 symlink（`VERSIONS_PATH_ESCAPE`）。
 * - sha：`^[0-9a-f]{7,40}$` + `git rev-parse --verify <sha>^{commit}`，否则 400。
 * - 原子恢复：逐文件 blob → 同目录 `.tmp-<pid>-<rand>` → fsync → rename；
 *   任一文件失败 → 用备份目录回滚已写文件，抛 `VERSIONS_RESTORE_ROLLBACK`。
 * - 冲突：待恢复文件在工作树有未提交改动 → `VERSIONS_DIRTY_CONFLICT`（除非 force）；
 *   force 也会先备份。
 * - 并发：每工程单飞锁 `$GIT_DIR/opencut.lock`（`{pid,at}`，>60s 视为陈旧可回收）；
 *   启动时清 `*.tmp-*` 残留；列表从 `git log` 重建，不落独立索引文件。
 * - 失败可见：git 缺失 → `VERSIONS_GIT_UNAVAILABLE`(503)；仓库损坏 → 改名
 *   `versions.git.broken-<ts>` 后 `VERSIONS_REPO_BROKEN`（**不删**）。
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** 版本库相对工程根的位置。 */
export const VERSIONS_DIR = '.film/versions.git';
/** 恢复前备份目录。 */
export const BACKUP_DIR = '.film/versions-backup';
/** git 子进程超时（任务书 §5.1）。 */
export const GIT_TIMEOUT_MS = 15000;
/** 子进程输出上限（8 MiB）。 */
export const GIT_MAX_BUFFER = 8 << 20;
/** 单个文本文件上限 2 MiB。 */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
/** 名字长度上限（含）与下限。 */
export const NAME_MAX = 60;
/** 锁超过这个时长算陈旧（可回收）。 */
export const LOCK_STALE_MS = 60_000;

const TEXT_EXTENSIONS = new Set([
  '.html',
  '.css',
  '.js',
  '.mjs',
  '.json',
  '.txt',
  '.md',
  '.srt',
  '.ass',
  '.vtt',
]);

/** 写进 `$GIT_DIR/info/exclude`：媒体、缓存、版本库自己都不进快照。 */
const EXCLUDE_LINES = [
  '# OpenCut 版本库：只跟踪文本，媒体与缓存走清单',
  `${VERSIONS_DIR.replace('.film/', '')}/`,
  'versions-backup/',
  'history/',
  '.ghome/',
  'node_modules/',
  '*.mp4',
  '*.m4v',
  '*.mov',
  '*.webm',
  '*.mkv',
  '*.avi',
  '*.mp3',
  '*.m4a',
  '*.wav',
  '*.aac',
  '*.flac',
  '*.png',
  '*.jpg',
  '*.jpeg',
  '*.gif',
  '*.webp',
  '*.zip',
  '*.pdf',
];

/**
 * 带 code / status 的错误：路由按 status 回，测试按 code 断言。
 */
export class VersionsError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [status]
   * @param {Record<string, any>} [extra]
   */
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.name = 'VersionsError';
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

/** @param {string} rel */
function isTextPath(rel) {
  const base = path.posix.basename(rel);
  if (base === 'film.html') return true;
  if (rel.startsWith('.film/') && rel.endsWith('.json')) return true;
  return TEXT_EXTENSIONS.has(path.posix.extname(rel).toLowerCase());
}

/** 媒体后缀：只进清单，不进 git。 */
function isMediaPath(rel) {
  return /\.(mp4|m4v|mov|webm|mkv|avi|mp3|m4a|wav|aac|flac|png|jpe?g|gif|webp)$/i.test(rel);
}

/** 工程根：realpath，符号链接先解开（后面所有比较都用它）。 */
async function rootOf(projectDir) {
  const real = await fs.realpath(projectDir);
  return real;
}

/**
 * 路径边界：resolve 之后必须落在根内；再对已存在的最深父目录求 realpath，
 * 防止 `.film/link -> /tmp` 这类 symlink 把写操作带出工程。
 *
 * @param {string} root 工程 realpath
 * @param {string} rel 相对路径（git 里的 path）
 */
async function safeJoin(root, rel) {
  if (typeof rel !== 'string' || rel === '') throw new VersionsError('VERSIONS_PATH_ESCAPE', '空路径', 400);
  if (path.isAbsolute(rel)) throw new VersionsError('VERSIONS_PATH_ESCAPE', `不接受绝对路径：${rel}`, 400);
  const normalized = rel.split('\\').join('/');
  if (normalized.split('/').includes('..')) {
    throw new VersionsError('VERSIONS_PATH_ESCAPE', `路径里不许出现 ..：${rel}`, 400);
  }
  const target = path.resolve(root, normalized);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new VersionsError('VERSIONS_PATH_ESCAPE', `路径越界：${rel}`, 400);
  }
  // 找到最深的已存在祖先，realpath 后仍须在根内（symlink 逃逸）
  /** @type {string} */
  let probe = target;
  for (let i = 0; i < 40; i += 1) {
    try {
      const real = await fs.realpath(probe);
      if (real !== root && !real.startsWith(root + path.sep)) {
        throw new VersionsError('VERSIONS_PATH_ESCAPE', `symlink 指向工程外：${rel}`, 400);
      }
      break;
    } catch (error) {
      if (error instanceof VersionsError) throw error;
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return target;
}

/**
 * 把 git 里的相对路径解析成工程内的绝对路径（对外暴露，供测试直接打越界用例）。
 *
 * @param {string} projectDir
 * @param {string} rel
 * @returns {Promise<string>}
 */
export async function resolveProjectPath(projectDir, rel) {
  const root = await rootOf(projectDir);
  return safeJoin(root, rel);
}

/** @param {string} root */
function gitEnv(root) {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/true',
    HOME: path.join(root, '.film', '.ghome'),
    // 不要继承调用方可能注入的仓库变量：一切以 --git-dir/--work-tree 为准。
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_INDEX_FILE: undefined,
  };
}

/**
 * 跑一条 git（每次都带 --git-dir/--work-tree 与三条加固 -c）。
 *
 * @param {string} root 工程 realpath
 * @param {string[]} args
 * @param {{input?: Buffer|string|null, timeoutMs?: number}} [options]
 * @returns {Promise<{code: number, stdout: Buffer, stderr: string, timedOut: boolean}>}
 */
function runGit(root, args, options = {}) {
  const gitDir = path.join(root, VERSIONS_DIR);
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = spawn(
        'git',
        [
          '--git-dir',
          gitDir,
          '--work-tree',
          root,
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'core.fsmonitor=false',
          '-c',
          'gc.auto=0',
          ...args,
        ],
        { cwd: root, shell: false, env: gitEnv(root), stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch (error) {
      reject(new VersionsError('VERSIONS_GIT_UNAVAILABLE', `git 启动失败：${String(error?.message ?? error)}`, 503));
      return;
    }

    /** @type {Buffer[]} */
    const outChunks = [];
    let outBytes = 0;
    /** @type {string[]} */
    const errChunks = [];
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (/** @type {Buffer} */ chunk) => {
      outBytes += chunk.length;
      if (outBytes <= GIT_MAX_BUFFER) outChunks.push(chunk);
    });
    child.stderr?.on('data', (/** @type {Buffer} */ chunk) => {
      if (errChunks.length < 200) errChunks.push(chunk.toString('utf8'));
    });
    child.on('error', (/** @type {any} */ error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error?.code === 'ENOENT') {
        reject(new VersionsError('VERSIONS_GIT_UNAVAILABLE', '这台机器上没有 git', 503));
        return;
      }
      reject(error);
    });
    child.on('close', (/** @type {number|null} */ code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new VersionsError('VERSIONS_GIT_TIMEOUT', `git ${args[0] ?? ''} 超过 ${timeoutMs}ms`, 504, {
            args,
          }),
        );
        return;
      }
      resolve({
        code: code ?? 124,
        stdout: Buffer.concat(outChunks),
        stderr: errChunks.join(''),
        timedOut: false,
      });
    });
    if (options.input !== undefined && options.input !== null) {
      child.stdin?.end(options.input);
    } else {
      child.stdin?.end();
    }
  });
}

/** @type {boolean|null} 只存确定答案：true=有 git，false=确认没有；null=还没问过/上次是抖动。 */
let gitAvailableCache = null;

/**
 * git 是否可用。
 *
 * 只缓存**确定答案**：ENOENT（真的没装）缓存 false；`--version` 成功缓存 true；
 * 其它瞬时失败（EAGAIN/被杀/机器过载）**不缓存**，下次再试——否则一次抖动会把
 * 整个进程的版本功能判死（R50 实测：并发 31 个 Chromium 时 12 条单测因此集体变红）。
 *
 * @returns {Promise<boolean>}
 */
export async function gitAvailable() {
  if (gitAvailableCache !== null) return gitAvailableCache;
  /** @type {'ok'|'missing'|'unknown'} */
  const verdict = await new Promise((resolve) => {
    try {
      const child = spawn('git', ['--version'], { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
      child.on('error', (/** @type {any} */ error) => resolve(error?.code === 'ENOENT' ? 'missing' : 'unknown'));
      child.on('close', (code) => resolve(code === 0 ? 'ok' : 'unknown'));
    } catch (error) {
      resolve(/** @type {any} */ (error)?.code === 'ENOENT' ? 'missing' : 'unknown');
    }
  });
  if (verdict === 'ok') gitAvailableCache = true;
  if (verdict === 'missing') gitAvailableCache = false;
  return verdict === 'ok';
}

/** 测试用：重置可用性缓存。 */
export function resetGitAvailabilityForTest() {
  gitAvailableCache = null;
}

/**
 * 确保版本库就绪（幂等）：init + 加固配置 + info/exclude + HOME 目录。
 *
 * @param {string} projectDir
 * @returns {Promise<{root: string, gitDir: string, created: boolean}>}
 */
export async function ensureRepo(projectDir) {
  const root = await rootOf(projectDir);
  if (!(await gitAvailable())) {
    throw new VersionsError('VERSIONS_GIT_UNAVAILABLE', '这台机器上没有 git，命名版本不可用', 503);
  }
  const gitDir = path.join(root, VERSIONS_DIR);
  /** @type {boolean} */
  let exists = false;
  try {
    const stat = await fs.stat(gitDir);
    exists = stat.isDirectory();
  } catch {
    exists = false;
  }

  if (exists) {
    const probe = await runGit(root, ['rev-parse', '--git-dir']).catch((error) => error);
    if (probe instanceof VersionsError) throw probe;
    if (probe.code !== 0) {
      // 仓库损坏：改名留档，不删（任务书 §5.2「不许删」）
      const broken = `${gitDir}.broken-${Date.now()}`;
      await fs.rename(gitDir, broken).catch(() => {});
      throw new VersionsError('VERSIONS_REPO_BROKEN', '版本库损坏，已改名保留，请重建版本库', 500, {
        broken: path.relative(root, broken),
        gitError: probe.stderr.slice(-400),
      });
    }
  } else {
    await fs.mkdir(path.dirname(gitDir), { recursive: true });
    const init = await runGit(root, ['init', '--quiet']);
    if (init.code !== 0) {
      throw new VersionsError('VERSIONS_GIT_FAILED', `git init 失败：${init.stderr.slice(-400)}`, 500);
    }
  }

  // 加固配置：直接写 config（少两次子进程），重复写是幂等的。
  const configPath = path.join(gitDir, 'config');
  const config = [
    '[core]',
    '\tautocrlf = false',
    '\tfileMode = false',
    '\tquotepath = false',
    '[user]',
    '\tname = OpenCut Versions',
    '\temail = versions@opencut.local',
    '[commit]',
    '\tgpgsign = false',
    '',
  ].join('\n');
  await fs.writeFile(configPath, config, 'utf8');

  await fs.mkdir(path.join(gitDir, 'info'), { recursive: true });
  await fs.writeFile(path.join(gitDir, 'info', 'exclude'), `${EXCLUDE_LINES.join('\n')}\n`, 'utf8');
  await fs.mkdir(path.join(root, '.film', '.ghome'), { recursive: true });

  return { root, gitDir, created: !exists };
}

/* ── 锁与临时文件 ─────────────────────────────────────────────────────── */

/** @param {string} root */
function lockPathOf(root) {
  return path.join(root, VERSIONS_DIR, 'opencut.lock');
}

/**
 * 单飞锁：`wx` 建文件是原子的；陈旧（>60s）可回收。
 *
 * @template T
 * @param {string} root
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withLock(root, fn) {
  const lockPath = lockPathOf(root);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`, 'utf8');
      await handle.close();
      try {
        return await fn();
      } finally {
        await fs.unlink(lockPath).catch(() => {});
      }
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 'EEXIST') throw error;
      /** @type {{pid?: number, at?: number}|null} */
      let info = null;
      try {
        info = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      } catch {
        info = null;
      }
      const at = Number(info?.at ?? 0);
      if (Number.isFinite(at) && Date.now() - at < LOCK_STALE_MS) {
        throw new VersionsError('VERSIONS_BUSY', '另一个版本操作正在进行', 409, { lock: info });
      }
      await fs.unlink(lockPath).catch(() => {});
    }
  }
  throw new VersionsError('VERSIONS_BUSY', '版本操作锁竞争失败', 409);
}

/**
 * 清理上次崩溃留下的 `*.tmp-<pid>-<rand>`（只删本模块的命名，不动别人的临时文件）。
 * @param {string} root
 */
export async function cleanupTempFiles(root) {
  /** @type {string[]} */
  const removed = [];
  /** @param {string} rel @param {number} depth */
  async function walk(rel, depth) {
    if (depth > 8) return;
    const abs = rel === '' ? root : path.join(root, rel);
    /** @type {import('node:fs').Dirent[]} */
    let entries = [];
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'versions.git') continue;
        await walk(childRel, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (/\.tmp-\d+-[a-z0-9]+$/.test(entry.name)) {
        await fs.unlink(path.join(root, childRel)).catch(() => {});
        removed.push(childRel);
      }
    }
  }
  await walk('', 0);
  return removed;
}

/* ── 名字 / sha ───────────────────────────────────────────────────────── */

/**
 * @param {any} name
 * @returns {string}
 */
export function normalizeName(name) {
  if (typeof name !== 'string') throw new VersionsError('VERSIONS_NAME_INVALID', 'name 必须是字符串', 400);
  const trimmed = name.trim();
  if (trimmed === '') throw new VersionsError('VERSIONS_NAME_INVALID', 'name 不能为空', 400);
  if (/[\r\n]/.test(trimmed)) throw new VersionsError('VERSIONS_NAME_INVALID', 'name 不能换行', 400);
  if ([...trimmed].length > NAME_MAX) {
    throw new VersionsError('VERSIONS_NAME_INVALID', `name 最长 ${NAME_MAX} 个字符`, 400);
  }
  return trimmed;
}

/**
 * @param {string} root
 * @param {any} sha
 * @returns {Promise<string>} 完整 sha
 */
async function resolveSha(root, sha) {
  const text = String(sha ?? '').trim();
  if (!/^[0-9a-f]{7,40}$/.test(text)) {
    throw new VersionsError('VERSIONS_SHA_INVALID', 'sha 只接受 7–40 位小写十六进制', 400);
  }
  const result = await runGit(root, ['rev-parse', '--verify', `${text}^{commit}`]);
  if (result.code !== 0) {
    throw new VersionsError('VERSIONS_SHA_INVALID', `版本不存在：${text}`, 400);
  }
  return result.stdout.toString('utf8').trim();
}

/* ── 列表 / 提交 / diff ───────────────────────────────────────────────── */

/**
 * @param {string} root
 * @param {string} sha
 */
async function filesOfCommit(root, sha) {
  const result = await runGit(root, ['ls-tree', '-r', '--name-only', sha]);
  if (result.code !== 0) return [];
  return result.stdout
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * @param {string} root
 * @param {string} sha
 */
async function mediaOfCommit(root, sha) {
  try {
    const raw = await fs.readFile(path.join(root, VERSIONS_DIR, 'media', `${sha}.json`), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

/**
 * 工作树里还没提交的改动（相对 HEAD）。
 * @param {string} root
 */
async function dirtyOf(root) {
  const result = await runGit(root, ['status', '--porcelain']);
  /** @type {{added: string[], modified: string[], deleted: string[]}} */
  const dirty = { added: [], modified: [], deleted: [] };
  if (result.code !== 0) return dirty;
  for (const line of result.stdout.toString('utf8').split('\n')) {
    if (line.trim() === '') continue;
    const code = line.slice(0, 2);
    const file = line.slice(3).trim();
    if (code.includes('?')) dirty.added.push(file);
    else if (code.includes('D')) dirty.deleted.push(file);
    else dirty.modified.push(file);
  }
  return dirty;
}

/**
 * 版本列表：`git log` 里读，**不落独立索引文件**（任务书 §5.2）。
 *
 * @param {string} projectDir
 * @param {{limit?: number}} [options]
 */
export async function listVersions(projectDir, options = {}) {
  const root = await rootOf(projectDir);
  const available = await gitAvailable();
  if (!available) return { gitAvailable: false, versions: [], dirty: { added: [], modified: [], deleted: [] } };
  const gitDir = path.join(root, VERSIONS_DIR);
  /** @type {boolean} */
  let exists = false;
  try {
    exists = (await fs.stat(gitDir)).isDirectory();
  } catch {
    exists = false;
  }
  if (!exists) return { gitAvailable: true, versions: [], dirty: { added: [], modified: [], deleted: [] }, initialized: false };

  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 200) : 50;
  const log = await runGit(root, ['log', `-n${limit}`, '--format=%H%x09%ct%x09%s', '--name-only']);
  /** @type {Array<{sha: string, short: string, name: string, at: string, files: number, mediaCount: number}>} */
  const versions = [];
  if (log.code === 0) {
    /** @type {any} */
    let current = null;
    for (const line of log.stdout.toString('utf8').split('\n')) {
      if (line === '') continue;
      if (/^[0-9a-f]{40}\t/.test(line)) {
        if (current) versions.push(current);
        const [sha, ct, ...rest] = line.split('\t');
        current = {
          sha,
          short: sha.slice(0, 7),
          name: rest.join('\t'),
          at: new Date(Number(ct) * 1000).toISOString(),
          files: 0,
          mediaCount: 0,
        };
      } else if (current) {
        current.files += 1;
      }
    }
    if (current) versions.push(current);
  }
  // 空仓库（还没有提交）：git log 退出码非 0，直接当空列表。
  for (const version of versions) {
    version.mediaCount = (await mediaOfCommit(root, version.sha)).length;
  }
  return { gitAvailable: true, versions, dirty: await dirtyOf(root), initialized: true };
}

/**
 * 收集工程里当前的媒体清单（不进 git，只记 path/bytes/mtime）。
 * @param {string} root
 */
async function collectMedia(root) {
  /** @type {Array<{path: string, bytes: number, mtime: string}>} */
  const entries = [];
  /** @param {string} rel @param {number} depth */
  async function walk(rel, depth) {
    if (depth > 8) return;
    const abs = rel === '' ? root : path.join(root, rel);
    /** @type {import('node:fs').Dirent[]} */
    let list = [];
    try {
      list = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of list) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'versions.git') continue;
        if (childRel === '.film/history' || childRel === '.film/versions-backup') continue;
        await walk(childRel, depth + 1);
        continue;
      }
      if (!entry.isFile() || !isMediaPath(childRel)) continue;
      try {
        const stat = await fs.stat(path.join(root, childRel));
        entries.push({ path: childRel, bytes: stat.size, mtime: stat.mtime.toISOString() });
      } catch {
        // 读不到就跳过：清单是提示，不是真源
      }
    }
  }
  await walk('', 0);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * 工程里**该进版本库的文本文件**（白名单扩展名 + ≤2 MiB）。
 * 只把这些交给 `git add`，别的一律不进快照（任务书 §5.1 第 2 条）。
 *
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function listTextFiles(root) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} rel @param {number} depth */
  async function walk(rel, depth) {
    if (depth > 10) return;
    const abs = rel === '' ? root : path.join(root, rel);
    /** @type {import('node:fs').Dirent[]} */
    let entries = [];
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'versions.git', 'versions-backup', 'history', '.ghome'].includes(entry.name)) continue;
        await walk(childRel, depth + 1);
        continue;
      }
      if (!entry.isFile() || !isTextPath(childRel)) continue;
      try {
        const stat = await fs.stat(path.join(root, childRel));
        if (stat.size <= MAX_TEXT_BYTES) out.push(childRel);
      } catch {
        // 读不到就跳过
      }
    }
  }
  await walk('', 0);
  return out.sort();
}

/**
 * 新建一个命名版本。
 *
 * @param {string} projectDir
 * @param {{name: string, message?: string}} input
 */
export async function createVersion(projectDir, input) {
  const name = normalizeName(input?.name);
  const { root } = await ensureRepo(projectDir);
  return withLock(root, async () => {
    await cleanupTempFiles(root);
    const before = await runGit(root, ['rev-parse', '--verify', 'HEAD']).catch(() => ({ code: 128 }));
    // 只把白名单文本加进去：`git add -A` 会把别的东西也带进快照。
    const texts = await listTextFiles(root);
    if (texts.length > 0) {
      const add = await runGit(root, ['add', '--force', '--', ...texts]);
      if (add.code !== 0) {
        throw new VersionsError('VERSIONS_GIT_FAILED', `git add 失败：${add.stderr.slice(-400)}`, 500);
      }
    }
    // 已经不在白名单里的历史跟踪文件 → 从索引里删掉（工作树不动）
    const trackedList = await runGit(root, ['ls-files', '-z']);
    if (trackedList.code === 0) {
      const tracked = trackedList.stdout
        .toString('utf8')
        .split('\0')
        .filter((line) => line !== '');
      const keep = new Set(texts);
      const dropped = tracked.filter((file) => !keep.has(file));
      if (dropped.length > 0) {
        await runGit(root, ['rm', '--cached', '--quiet', '--ignore-unmatch', '--', ...dropped]);
      }
    }
    const staged = await runGit(root, ['diff', '--cached', '--quiet']);
    if (staged.code === 0) {
      throw new VersionsError('VERSIONS_NOTHING_TO_COMMIT', '没有可提交的改动', 409);
    }
    // 名字即 subject；message 只作为正文（可空）
    /** @type {string[]} */
    const commitArgs = ['commit', '--quiet', '--no-verify', '-m', name];
    if (typeof input?.message === 'string' && input.message.trim() !== '') {
      commitArgs.push('-m', input.message.trim());
    }
    const commit = await runGit(root, commitArgs);
    if (commit.code !== 0) {
      throw new VersionsError('VERSIONS_GIT_FAILED', `git commit 失败：${commit.stderr.slice(-400)}`, 500);
    }
    const head = await runGit(root, ['rev-parse', 'HEAD']);
    const sha = head.stdout.toString('utf8').trim();
    const files = await filesOfCommit(root, sha);
    const media = await collectMedia(root);
    await fs.mkdir(path.join(root, VERSIONS_DIR, 'media'), { recursive: true });
    await fs.writeFile(
      path.join(root, VERSIONS_DIR, 'media', `${sha}.json`),
      `${JSON.stringify({ sha, at: new Date().toISOString(), entries: media }, null, 2)}\n`,
      'utf8',
    );
    return {
      ok: true,
      version: {
        sha,
        short: sha.slice(0, 7),
        name,
        at: new Date().toISOString(),
        files: files.length,
        mediaCount: media.length,
      },
      firstCommit: before.code !== 0,
    };
  });
}

/**
 * 两个版本之间的差异（对某个版本而言：相对它的父提交）。
 *
 * @param {string} projectDir
 * @param {string} sha 版本（支持短 sha）
 */
export async function diffVersion(projectDir, sha) {
  const root = await rootOf(projectDir);
  const full = await resolveSha(root, sha);
  const numstat = await runGit(root, ['show', '--numstat', '--format=', '--no-renames', full]);
  const nameStatus = await runGit(root, ['show', '--name-status', '--format=', '--no-renames', full]);
  /** @type {Map<string, string>} */
  const statusByPath = new Map();
  if (nameStatus.code === 0) {
    for (const line of nameStatus.stdout.toString('utf8').split('\n')) {
      if (line.trim() === '') continue;
      const [status, ...rest] = line.split('\t');
      const file = rest.join('\t');
      statusByPath.set(file, status.slice(0, 1) === 'A' ? 'added' : status.slice(0, 1) === 'D' ? 'deleted' : 'modified');
    }
  }
  /** @type {Array<{path: string, status: string, additions: number, deletions: number}>} */
  const files = [];
  if (numstat.code === 0) {
    for (const line of numstat.stdout.toString('utf8').split('\n')) {
      if (line.trim() === '') continue;
      const [added, deleted, ...rest] = line.split('\t');
      const file = rest.join('\t');
      files.push({
        path: file,
        status: statusByPath.get(file) ?? 'modified',
        additions: added === '-' ? 0 : Number(added),
        deletions: deleted === '-' ? 0 : Number(deleted),
      });
    }
  }
  const recorded = await mediaOfCommit(root, full);
  const missing = [];
  for (const entry of recorded) {
    try {
      const stat = await fs.stat(path.join(root, entry.path));
      if (stat.size !== entry.bytes) missing.push(entry.path);
    } catch {
      missing.push(entry.path);
    }
  }
  return { ok: true, sha: full, files, mediaChanged: missing, missingMedia: missing.length };
}

/* ── 恢复 ─────────────────────────────────────────────────────────────── */

/** @param {string} root */
async function backupDirFor(root) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(root, BACKUP_DIR, stamp);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * 原子写：同目录 `.tmp-<pid>-<rand>` → fsync → rename。
 * @param {string} target 绝对路径
 * @param {Buffer} data
 */
async function writeAtomic(target, data) {
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `${path.basename(target)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.write(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, target);
}

/**
 * 恢复一个版本到工作树（只回写受跟踪文本；媒体不复活）。
 *
 * @param {string} projectDir
 * @param {string} sha
 * @param {{files?: string[]|null, force?: boolean}} [options]
 */
export async function restoreVersion(projectDir, sha, options = {}) {
  const root = await rootOf(projectDir);
  await ensureRepo(projectDir);
  const full = await resolveSha(root, sha);
  const force = options.force === true;

  return withLock(root, async () => {
    await cleanupTempFiles(root);
    const tracked = await filesOfCommit(root, full);
    const trackedText = [];
    for (const rel of tracked) {
      if (!isTextPath(rel)) continue;
      const target = await safeJoin(root, rel);
      trackedText.push({ rel, target });
    }
    /** @type {Array<{rel: string, target: string}>} */
    let targets = trackedText;
    if (Array.isArray(options.files) && options.files.length > 0) {
      const wanted = new Set(options.files.map((file) => String(file).split('\\').join('/')));
      targets = [];
      for (const want of wanted) {
        const hit = trackedText.find((item) => item.rel === want);
        if (!hit) {
          throw new VersionsError('VERSIONS_FILE_NOT_IN_SHA', `该版本里没有这个文件：${want}`, 404);
        }
        targets.push(hit);
      }
    }

    // 脏冲突：这些文件在工作树有未提交改动就不覆盖（force 例外，但先备份）
    if (!force) {
      const dirty = await dirtyOf(root);
      const dirtySet = new Set([...dirty.added, ...dirty.modified, ...dirty.deleted]);
      const conflicts = targets.filter((item) => dirtySet.has(item.rel)).map((item) => item.rel);
      if (conflicts.length > 0) {
        throw new VersionsError('VERSIONS_DIRTY_CONFLICT', '工作树有未提交改动，先提交或用 force', 409, {
          conflicts,
        });
      }
    }

    const backupDir = await backupDirFor(root);
    /** @type {Array<{rel: string, backup: string|null, existed: boolean}>} */
    const journal = [];
    try {
      for (const item of targets) {
        const blob = await runGit(root, ['show', `${full}:${item.rel}`]);
        if (blob.code !== 0) {
          throw new VersionsError('VERSIONS_GIT_FAILED', `读 blob 失败：${item.rel}`, 500);
        }
        const data = blob.stdout;
        if (data.length > MAX_TEXT_BYTES) {
          throw new VersionsError('VERSIONS_FILE_TOO_LARGE', `文件超过 2 MiB：${item.rel}`, 400);
        }
        // 备份现状（不存在就记 existed=false）
        const backupPath = path.join(backupDir, item.rel);
        /** @type {boolean} */
        let existed = true;
        try {
          await fs.mkdir(path.dirname(backupPath), { recursive: true });
          await fs.copyFile(item.target, backupPath);
        } catch (error) {
          if (/** @type {any} */ (error)?.code === 'ENOENT') existed = false;
          else throw error;
        }
        journal.push({ rel: item.rel, backup: existed ? backupPath : null, existed });
        await writeAtomic(item.target, data);
      }
    } catch (error) {
      // 回滚：已写的用备份还原，新建的删掉
      /** @type {string[]} */
      const rolledBack = [];
      for (const entry of journal.slice().reverse()) {
        try {
          if (entry.existed && entry.backup) {
            await fs.copyFile(entry.backup, path.join(root, entry.rel));
          } else {
            await fs.unlink(path.join(root, entry.rel)).catch(() => {});
          }
          rolledBack.push(entry.rel);
        } catch {
          // 回滚失败也要把原始错误抛出去
        }
      }
      throw new VersionsError(
        'VERSIONS_RESTORE_ROLLBACK',
        `恢复失败，已回滚 ${rolledBack.length} 个文件；备份在 ${path.relative(root, backupDir)}`,
        500,
        {
          cause: String(/** @type {any} */ (error)?.code ?? error?.message ?? error),
          backup: path.relative(root, backupDir),
          rolledBack,
        },
      );
    }

    const recorded = await mediaOfCommit(root, full);
    /** @type {string[]} */
    const mediaChanged = [];
    for (const entry of recorded) {
      try {
        const stat = await fs.stat(path.join(root, entry.path));
        if (stat.size !== entry.bytes) mediaChanged.push(entry.path);
      } catch {
        mediaChanged.push(entry.path);
      }
    }
    return {
      ok: true,
      sha: full,
      restored: targets.map((item) => item.rel),
      backup: path.relative(root, backupDir),
      mediaChanged,
      missingMedia: mediaChanged.length,
    };
  });
}

/**
 * 只恢复 `film.html`。
 * @param {string} projectDir
 * @param {string} sha
 * @param {{force?: boolean}} [options]
 */
export async function restoreFilm(projectDir, sha, options = {}) {
  const root = await rootOf(projectDir);
  const full = await resolveSha(root, sha);
  const tracked = await filesOfCommit(root, full);
  if (!tracked.includes('film.html')) {
    throw new VersionsError('VERSIONS_NO_FILM_IN_SHA', '这个版本里没有 film.html', 404);
  }
  const result = await restoreVersion(projectDir, full, { files: ['film.html'], force: options.force === true });
  return { ...result, filmSha: sha256OfBuffer(await fs.readFile(path.join(root, 'film.html'))) };
}

/** @param {Buffer} buffer */
export function sha256OfBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}
