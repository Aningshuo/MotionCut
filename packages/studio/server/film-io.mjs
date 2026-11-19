/**
 * `FilmDocIo`（合同 contracts/film-doc.ts v1.1.0）。
 *
 * 磁盘这一侧的唯一入口：核对 → 原子写 → 记历史。
 *
 * - 核对：`expectedHash` 必须等于磁盘当前内容的 sha256，否则 CONFLICT 且**不写**；
 *   在 rename 前再核对一次（缩短「读到一半被人改了」的窗口）。
 * - 原子写：同目录临时文件 → fsync → rename → 回读校验哈希。任何一步失败都清理临时文件，
 *   绝不留下半份 `film.html`。
 * - 历史：每次成功写入在 `<project>/.film/history` 这个**私有 Git 仓库**里落一条快照，
 *   `git log --oneline` 可见，message 含 op 摘要与源哈希短值。`git` 不可用时返回
 *   `GIT_MISSING` 明确错误，不静默降级。
 * - 冲突：Agent 原写与请求各留一份到 `<project>/.film/conflicts/`，文件名含时间与短哈希。
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** @param {string} text @returns {string} */
export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 读文件失败 → 合同诊断码（找不到 / 不可读），不把 ENOENT 直接抛给 UI。
 * @param {unknown} error
 * @returns {string}
 */
export function ioErrorCode(error) {
  const code = /** @type {NodeJS.ErrnoException} */ (error)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'FILM_NOT_FOUND';
  return 'FILM_UNREADABLE';
}

/**
 * @param {{
 *   now?: () => Date,
 *   gitRunner?: (args: string[], options: { cwd: string }) => Promise<{ ok: boolean, stdout?: string, stderr?: string, code?: string }>,
 *   hooks?: {
 *     beforeVerify?: (context: { path: string, expectedHash: string, actualHash: string }) => Promise<void>|void,
 *     beforeRename?: (context: { path: string, tempPath: string }) => Promise<void>|void,
 *   },
 *   fsyncDir?: boolean,
 * }} [options]
 */
export function createFilmDocIo(options = {}) {
  const now = options.now ?? (() => new Date());
  const gitRunner = options.gitRunner ?? defaultGitRunner;
  const hooks = options.hooks ?? {};
  const fsyncDir = options.fsyncDir ?? true;

  /**
   * 读原始字节与哈希；哈希就是修订号。
   * @param {string} path
   * @returns {Promise<{ text: string, sourceHash: string, mtimeMs: number }>}
   */
  async function read(path) {
    const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    return { text, sourceHash: sha256(text), mtimeMs: info.mtimeMs };
  }

  /**
   * CAS 落盘。
   * @param {string} path
   * @param {string} text
   * @param {string} expectedHash
   * @returns {Promise<{ ok: true, sourceHash: string } | { ok: false, code: 'CONFLICT'|'IO', actualHash?: string, message?: string }>}
   */
  async function commit(path, text, expectedHash) {
    /** @type {{ text: string, sourceHash: string, mtimeMs: number }} */
    let current;
    try {
      current = await read(path);
    } catch (error) {
      return {
        ok: false,
        code: 'IO',
        message: `${ioErrorCode(error)}: ${String(/** @type {Error} */ (error).message)}`,
      };
    }
    if (current.sourceHash !== expectedHash) {
      return { ok: false, code: 'CONFLICT', actualHash: current.sourceHash };
    }
    await hooks.beforeVerify?.({ path, expectedHash, actualHash: current.sourceHash });

    const tempPath = join(
      dirname(path),
      `.${basenameSafe(path)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    );
    const mode = await fileMode(path);
    let handle = null;
    try {
      handle = await open(tempPath, 'wx', mode);
      await handle.writeFile(text, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;

      // rename 前复核：如果这期间有人改了源文件，CAS 必须失败而不是覆盖别人的修改。
      const recheck = await read(path);
      if (recheck.sourceHash !== expectedHash) {
        await unlink(tempPath).catch(() => undefined);
        return { ok: false, code: 'CONFLICT', actualHash: recheck.sourceHash };
      }
      await hooks.beforeRename?.({ path, tempPath });

      await rename(tempPath, path);
    } catch (error) {
      if (handle !== null) await handle.close().catch(() => undefined);
      await unlink(tempPath).catch(() => undefined);
      return { ok: false, code: 'IO', message: String(/** @type {Error} */ (error).message) };
    }

    // 回读校验：rename 成功但内容不对，必须报错（这时无法回滚，交给上层与历史说明）。
    /** @type {string} */
    let back;
    try {
      back = await readFile(path, 'utf8');
    } catch (error) {
      return { ok: false, code: 'IO', message: `回读失败：${String(/** @type {Error} */ (error).message)}` };
    }
    const sourceHash = sha256(back);
    const expectedNewHash = sha256(text);
    if (sourceHash !== expectedNewHash) {
      return { ok: false, code: 'IO', message: `回读校验失败：${sourceHash} != ${expectedNewHash}` };
    }

    if (fsyncDir) await syncDirectory(dirname(path));
    return { ok: true, sourceHash };
  }

  /**
   * 落一条历史快照（私有 Git 仓库，不影响工程自己的版本控制）。
   * @param {{
   *   projectDir: string,
   *   text: string,
   *   sourceHash: string,
   *   prevSourceHash?: string,
   *   opId?: string,
   *   projectId?: string,
   *   ext?: string,
   * }} input
   * @returns {Promise<{ ok: true, dir: string, file: string, commit: string } | { ok: false, code: string, message: string }>}
   */
  async function snapshot(input) {
    const dir = join(input.projectDir, '.film', 'history');
    const snapshots = join(dir, 'snapshots');
    try {
      await mkdir(snapshots, { recursive: true });
    } catch (error) {
      return { ok: false, code: 'IO', message: String(/** @type {Error} */ (error).message) };
    }

    const stamp = timestampSlug(now());
    const short = input.sourceHash.slice(0, 8);
    // 扩展名只为可读：历史仓库里 film.html 是 .html，字幕是 .vtt/.srt（内容原样）。
    const ext = typeof input.ext === 'string' && input.ext !== '' ? input.ext.replace(/^\./, '') : 'html';
    let name = `${stamp}-${short}.${ext}`;
    let file = join(snapshots, name);
    for (let attempt = 2; attempt < 50; attempt += 1) {
      try {
        await stat(file);
        name = `${stamp}-${short}-${attempt}.${ext}`;
        file = join(snapshots, name);
      } catch {
        break;
      }
    }
    try {
      await writeFile(file, input.text, 'utf8');
    } catch (error) {
      return { ok: false, code: 'IO', message: String(/** @type {Error} */ (error).message) };
    }

    const gitDir = join(dir, '.git');
    let initialised = false;
    try {
      await stat(gitDir);
      initialised = true;
    } catch {
      initialised = false;
    }
    if (!initialised) {
      const init = await gitRunner(['init', '-q'], { cwd: dir });
      if (!init.ok) {
        return gitFailure(init, `无法初始化历史仓库：${dir}`);
      }
    }

    const add = await gitRunner(['add', '--', join('snapshots', name)], { cwd: dir });
    if (!add.ok) return gitFailure(add, '无法暂存历史快照');

    const prevShort = (input.prevSourceHash ?? '').slice(0, 8) || 'none';
    const message = `op=${input.opId ?? 'manual'} sha=${short} prev=${prevShort}${
      input.projectId === undefined ? '' : ` project=${input.projectId}`
    }`;
    const commit = await gitRunner(
      ['-c', 'user.name=opencut', '-c', 'user.email=opencut@local', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message, '--', join('snapshots', name)],
      { cwd: dir },
    );
    if (!commit.ok) return gitFailure(commit, '无法提交历史快照');
    const head = await gitRunner(['rev-parse', 'HEAD'], { cwd: dir });
    return {
      ok: true,
      dir,
      file,
      commit: head.ok ? String(head.stdout ?? '').trim() : '',
    };
  }

  /**
   * 冲突副本。Agent 原写（html）与请求（json）分开存，文件名含时间与短哈希，便于追溯。
   * @param {{
   *   projectDir: string,
   *   text?: string,
   *   edits?: unknown,
   *   opId?: string,
   *   expectedHash?: string,
   *   actualHash?: string,
   * }} input
   * @returns {Promise<{ ok: true, dir: string, files: string[] } | { ok: false, code: string, message: string }>}
   */
  async function keepConflict(input) {
    const dir = join(input.projectDir, '.film', 'conflicts');
    try {
      await mkdir(dir, { recursive: true });
    } catch (error) {
      return { ok: false, code: 'IO', message: String(/** @type {Error} */ (error).message) };
    }
    const stamp = timestampSlug(now());
    const expectedShort = (input.expectedHash ?? '').slice(0, 8) || 'nobase';
    const actualShort = (input.actualHash ?? '').slice(0, 8) || 'noactual';
    /** @type {string[]} */
    const files = [];
    try {
      if (typeof input.text === 'string') {
        const file = join(dir, `${stamp}-${actualShort}-agent.html`);
        await writeFile(file, input.text, 'utf8');
        files.push(file);
      }
      if (input.edits !== undefined) {
        const file = join(dir, `${stamp}-${expectedShort}-request.json`);
        await writeFile(
          file,
          JSON.stringify(
            {
              at: now().toISOString(),
              opId: input.opId ?? null,
              expectedHash: input.expectedHash ?? null,
              actualHash: input.actualHash ?? null,
              edits: input.edits,
            },
            null,
            2,
          ),
          'utf8',
        );
        files.push(file);
      }
    } catch (error) {
      return { ok: false, code: 'IO', message: String(/** @type {Error} */ (error).message) };
    }
    return { ok: true, dir, files };
  }

  return { read, commit, snapshot, keepConflict };
}

/**
 * @param {{ ok: boolean, stderr?: string, stdout?: string, code?: string }} result
 * @param {string} fallback
 */
function gitFailure(result, fallback) {
  if (result.code === 'GIT_MISSING') {
    return {
      ok: /** @type {const} */ (false),
      code: 'GIT_MISSING',
      message: '找不到 git 可执行文件：无法落历史快照（未静默降级）',
    };
  }
  const detail = String(result.stderr ?? result.stdout ?? '').trim();
  return { ok: /** @type {const} */ (false), code: 'GIT_FAILED', message: detail === '' ? fallback : `${fallback}：${detail}` };
}

/**
 * 默认 git 执行器：禁交互、禁可选锁，避免卡住写队列。
 * @param {string[]} args
 * @param {{ cwd: string }} options
 * @returns {Promise<{ ok: boolean, stdout?: string, stderr?: string, code?: string }>}
 */
function defaultGitRunner(args, options) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['--no-optional-locks', ...args],
      {
        cwd: options.cwd,
        timeout: 15_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true' },
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const code = /** @type {NodeJS.ErrnoException} */ (error).code;
          resolve({
            ok: false,
            code: code === 'ENOENT' ? 'GIT_MISSING' : 'GIT_FAILED',
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? '') || String(error.message),
          });
          return;
        }
        resolve({ ok: true, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

/** @param {string} path */
async function fileMode(path) {
  try {
    const info = await stat(path);
    return info.mode & fsConstants.S_IRWXU;
  } catch {
    return 0o644;
  }
}

/** @param {string} dir */
async function syncDirectory(dir) {
  /** @type {import('node:fs/promises').FileHandle|null} */
  let handle = null;
  try {
    handle = await open(dir, 'r');
    await handle.sync();
  } catch {
    // 某些文件系统不支持目录 fsync：不因此判定写入失败。
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
  }
}

/** @param {Date} date */
export function timestampSlug(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.(\d{3})Z$/, '$1Z');
}

/** @param {string} path */
function basenameSafe(path) {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? 'film.html';
}
