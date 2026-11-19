/**
 * 字幕存储（M24 · B-MAIN-R12-012）
 *
 * 定位、读取、写回。**格式跟随原文件**：`.vtt` 存回 `.vtt`，`.srt` 存回 `.srt`（不偷偷转格式）。
 *
 * 写盘规格与 `FilmDocIo` 同一套（`film-io.mjs` 的口径）：
 *   同目录临时文件 → `fsync` → `rename` → 回读校验；任何一步失败都清理临时文件，
 *   绝不留下半份字幕文件。每次成功写入在 `.film/history` 记一条（私有 Git 仓库）。
 *
 * 安全：`src` 只能是工程目录内的相对路径（`..`、绝对路径一律 400）。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  companionCandidates,
  formatOf,
  normalizeCues,
  parseSubtitles,
  serializeSubtitles,
} from '../../film-core/subtitle.mjs';
import { createFilmDocIo, sha256 } from './film-io.mjs';

/** @typedef {{ projectId: string, dir: string }} Project */

/**
 * `src`（工程相对路径）→ 绝对路径。越界返回 null。
 * @param {Project} project
 * @param {string} src
 * @returns {{ abs: string, rel: string } | { error: string }}
 */
export function resolveSrc(project, src) {
  const value = (String(src ?? '').split('#')[0] ?? '').trim();
  if (value === '') return { error: 'src 不能为空' };
  if (path.isAbsolute(value)) return { error: `src 必须是工程内相对路径：${value}` };
  const abs = path.resolve(project.dir, value);
  const root = path.resolve(project.dir);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return { error: `src 越出工程目录：${value}` };
  }
  return { abs, rel: path.relative(root, abs).split(path.sep).join('/') };
}

/**
 * 找伴生字幕：同目录 `<stem>.vtt` 优先，其次 `.srt`。找不到不是错误。
 * @param {{ project: Project, src: string }} input
 * @returns {Promise<{ found: true, file: string, abs: string, format: 'vtt'|'srt', name: string } | { found: false, file: null, tried: string[] } | { error: string }>}
 */
export async function locateSubtitle(input) {
  const resolved = resolveSrc(input.project, input.src);
  if ('error' in resolved) return resolved;
  const tried = companionCandidates(resolved.rel).map((rel) => path.resolve(input.project.dir, rel));
  for (const abs of tried) {
    try {
      const info = await fs.stat(abs);
      if (!info.isFile()) continue;
    } catch {
      continue;
    }
    const format = formatOf(abs);
    if (format === null) continue;
    return {
      found: true,
      file: path.relative(input.project.dir, abs).split(path.sep).join('/'),
      abs,
      format,
      name: path.basename(abs),
    };
  }
  return { found: false, file: null, tried: tried.map((abs) => path.relative(input.project.dir, abs).split(path.sep).join('/')) };
}

/**
 * 读字幕（含解析）。找不到 = `found:false` + 空 cues（不是错误）。
 * @param {{ project: Project, src: string }} input
 * @returns {Promise<{ ok: true, found: boolean, file: string|null, format: 'vtt'|'srt', cues: any[], skipped: number, bytes: number, hash: string|null } | { ok: false, code: string, message: string }>}
 */
export async function readSubtitles(input) {
  const located = await locateSubtitle(input);
  if ('error' in located) {
    return { ok: false, code: 'SUBTITLE_SRC_INVALID', message: located.error };
  }
  if (located.found !== true) {
    return { ok: true, found: false, file: null, format: 'vtt', cues: [], skipped: 0, bytes: 0, hash: null };
  }
  let text;
  try {
    text = await fs.readFile(located.abs, 'utf8');
  } catch (error) {
    return { ok: false, code: 'SUBTITLE_UNREADABLE', message: `${located.file}: ${String(/** @type {Error} */ (error).message)}` };
  }
  const parsed = parseSubtitles(text, { format: located.format });
  return {
    ok: true,
    found: true,
    file: located.file,
    format: parsed.format,
    cues: parsed.cues,
    skipped: parsed.skipped,
    bytes: Buffer.byteLength(text, 'utf8'),
    hash: sha256(text),
  };
}

/**
 * 原子写（与 film-io 同规格）。`hooks.beforeRename` 是给 A7「写一半被 kill」用的测试点。
 * @param {{ path: string, text: string, hooks?: { beforeRename?: (context: { path: string, tempPath: string }) => Promise<void>|void, beforeVerify?: () => Promise<void>|void } }} input
 * @returns {Promise<{ ok: true, hash: string } | { ok: false, code: string, message: string }>}
 */
export async function writeAtomic(input) {
  const dir = path.dirname(input.path);
  const tempPath = path.join(
    dir,
    `.${path.basename(input.path)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
  );
  let handle = null;
  try {
    await fs.mkdir(dir, { recursive: true });
    handle = await fs.open(tempPath, 'wx');
    await handle.writeFile(input.text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await input.hooks?.beforeVerify?.();
    await input.hooks?.beforeRename?.({ path: input.path, tempPath });
    await fs.rename(tempPath, input.path);
  } catch (error) {
    if (handle !== null) await handle.close().catch(() => undefined);
    await fs.unlink(tempPath).catch(() => undefined);
    return { ok: false, code: 'SUBTITLE_WRITE_FAILED', message: String(/** @type {Error} */ (error).message) };
  }
  // 回读校验：rename 成功但内容不对，必须报错（这时回滚不了，交给调用方与历史说明）。
  let back;
  try {
    back = await fs.readFile(input.path, 'utf8');
  } catch (error) {
    return { ok: false, code: 'SUBTITLE_WRITE_FAILED', message: `回读失败：${String(/** @type {Error} */ (error).message)}` };
  }
  if (back !== input.text) {
    return { ok: false, code: 'SUBTITLE_WRITE_FAILED', message: '回读校验失败：写入内容与内存不一致' };
  }
  return { ok: true, hash: sha256(back) };
}

/**
 * 保存字幕：格式跟随原文件；原文件不存在就新建 `<stem>.<format>`（缺省 `.vtt`）。
 *
 * `format`（R30-086 新增，可选）：只在**新建**时用得上。导入 `.srt` 到一个还没有
 * 伴生字幕的片段上时，落盘应该是 `.srt` 而不是悄悄转成 `.vtt`（`serializeSubtitles`
 * 两种都写得出，转格式不会丢内容，但会在工程里留一个用户没要求过的文件）。
 * 已有伴生文件时仍然**跟随已有那份**——不因为这次导入改了它的格式。
 * 老调用方（不给 `format`）行为逐字节不变。
 *
 * @param {{
 *   project: Project,
 *   src: string,
 *   cues: unknown,
 *   format?: 'vtt'|'srt',
 *   hooks?: { beforeRename?: (context: { path: string, tempPath: string }) => Promise<void>|void },
 *   io?: ReturnType<typeof createFilmDocIo>,
 * }} input
 * @returns {Promise<{ ok: true, file: string, format: 'vtt'|'srt', bytes: number, hash: string, history: any } | { ok: false, code: string, message: string }>}
 */
export async function saveSubtitles(input) {
  /** @type {any[]} */
  let cues;
  try {
    cues = normalizeCues(input.cues);
  } catch (error) {
    return { ok: false, code: 'SUBTITLE_INVALID', message: String(/** @type {Error} */ (error).message) };
  }

  const located = await locateSubtitle(input);
  if ('error' in located) {
    return { ok: false, code: 'SUBTITLE_SRC_INVALID', message: located.error };
  }

  /** @type {string} */
  let abs;
  /** @type {'vtt'|'srt'} */
  let format;
  if (located.found === true) {
    abs = located.abs;
    format = located.format;
  } else {
    const resolved = resolveSrc(input.project, input.src);
    if ('error' in resolved) return { ok: false, code: 'SUBTITLE_SRC_INVALID', message: resolved.error };
    const ext = path.extname(resolved.abs) || '.mp4';
    /* 新建时用调用方给的格式（导入 .srt 就落 .srt），不给就是 vtt —— 与 R30-086 之前一致。 */
    const wanted = input.format === 'srt' ? 'srt' : 'vtt';
    abs = resolved.abs.slice(0, resolved.abs.length - ext.length) + `.${wanted}`;
    format = wanted;
  }

  const text = serializeSubtitles(cues, { format });
  const before = await fs.readFile(abs, 'utf8').catch(() => null);
  const written = await writeAtomic({ path: abs, text, hooks: input.hooks });
  if (written.ok !== true) return written;

  const io = input.io ?? createFilmDocIo();
  const history = await io
    .snapshot({
      projectDir: input.project.dir,
      text,
      sourceHash: written.hash,
      ...(before === null ? {} : { prevSourceHash: createHash('sha256').update(before).digest('hex') }),
      opId: `subtitle:${path.basename(abs)}`,
      projectId: input.project.projectId,
      ext: format,
    })
    .catch((error) => ({ ok: false, code: 'IO', message: String(error?.message ?? error) }));

  return {
    ok: true,
    file: path.relative(input.project.dir, abs).split(path.sep).join('/'),
    format,
    bytes: Buffer.byteLength(text, 'utf8'),
    hash: written.hash,
    history,
  };
}
