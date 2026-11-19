/**
 * 素材库（M20 · B-MAIN-R10-010）
 *
 * `assets/` 是唯一真源：这里只**读**它、给 UI 一份可显示的清单、按需生成缩略图。
 * 插回时间线也直接引用同一个 `assets/<name>`——**不复制第二份**（M18 的导入才复制）。
 *
 * ## 边界
 *
 * - 列表：目录不存在 → 空数组（不是 404）；只列文件，不递归。
 * - 缩略图：只给视频/图片；音频返回 404（不拿占位图假装有画面）。
 * - 文件名：必须是 basename（含 `..`、`/`、`\\` 一律 400），拒绝路径穿越。
 * - 缓存：`.film/thumbs/`，文件名带 mtime+size；源文件变了自然换新文件，不做失效扫描。
 *
 * ffprobe 只探一次并缓存（键 = 绝对路径 + mtime + size）；ffmpeg 只用来抽一帧 PNG（不引新依赖）。
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { planRippleInsert } from '../../film-core/ripple.mjs';
import { mediaKindOf, buildInsertOp } from './media-import.mjs';
import { probeMedia } from '../../render/verify.mjs';

/** 缩略图宽度（px）；高度按比例（-2 保证偶数）。 */
export const THUMB_WIDTH = 320;

/** 抽帧超时（ms）：单帧失败就报错，不拖住请求。 */
const FFMPEG_TIMEOUT_MS = 30_000;

/** @typedef {'video'|'sound'|'still'} AssetKind */

/** 工程里的 assets 目录。 @param {{ dir: string }} project */
export function assetsDirOf(project) {
  return path.join(project.dir, 'assets');
}

/**
 * 文件名必须是 basename；返回错误码或 null。
 * @param {string} name
 * @returns {null | { code: string, message: string }}
 */
export function checkAssetName(name) {
  const value = String(name ?? '');
  if (value === '' || value === '.' || value === '..') {
    return { code: 'ASSET_NAME_INVALID', message: `素材名非法：${JSON.stringify(value)}` };
  }
  if (value !== path.basename(value) || value.includes('/') || value.includes('\\') || value.includes('\0')) {
    return { code: 'ASSET_NAME_INVALID', message: `素材名只能是文件名（不许路径）：${value}` };
  }
  return null;
}

/** 已探过的元数据：绝对路径 + mtime + size → 结果。 */
const probeCache = new Map();

/** @param {string} file @param {AssetKind} kind */
async function describeAsset(file, kind) {
  const stat = await fs.stat(file);
  const key = `${file}\u0000${stat.mtimeMs}\u0000${stat.size}`;
  const hit = probeCache.get(key);
  if (hit !== undefined) return hit;
  /** @type {{ durationSec: number|null, width: number|null, height: number|null, hasAudio: boolean }} */
  let value = { durationSec: null, width: null, height: null, hasAudio: false };
  try {
    const probe = await probeMedia(file);
    const duration = Number(probe?.format?.durationSec ?? probe?.video?.durationSec ?? probe?.audio?.durationSec);
    const width = Number(probe?.video?.width);
    const height = Number(probe?.video?.height);
    value = {
      // 静帧没有「时长」这回事：给 null，别拿 4 秒默认值冒充。
      durationSec: kind === 'still' ? null : Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) / 1000 : null,
      width: Number.isFinite(width) && width > 0 ? width : null,
      height: Number.isFinite(height) && height > 0 ? height : null,
      hasAudio: probe?.audio !== null && probe?.audio !== undefined
    };
  } catch {
    // 探不出来不是致命错误：列表照列，字段留 null（UI 显示「—」）。
  }
  probeCache.set(key, value);
  // 缓存别无限长：超过 500 条清一半（按插入顺序，Map 保序）。
  if (probeCache.size > 500) {
    let drop = 250;
    for (const cacheKey of probeCache.keys()) {
      probeCache.delete(cacheKey);
      if (--drop <= 0) break;
    }
  }
  return value;
}

/**
 * 列出 assets/ 下的素材。
 * @param {{ project: { dir: string } }} input
 * @returns {Promise<{ name: string, path: string, bytes: number, mtime: string, kind: AssetKind, durationSec: number|null, width: number|null, height: number|null, hasAudio: boolean }[]>}
 */
export async function listAssets(input) {
  const dir = assetsDirOf(input.project);
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  /** @type {Array<{ name: string, path: string, bytes: number, mtime: string, kind: AssetKind, durationSec: number|null, width: number|null, height: number|null, hasAudio: boolean, mtimeMs: number }>} */
  const assets = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    const kind = mediaKindOf(name);
    if (kind === null) continue;
    const file = path.join(dir, name);
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      continue;
    }
    const info = await describeAsset(file, kind);
    assets.push({
      name,
      path: `assets/${name}`,
      bytes: stat.size,
      mtime: new Date(stat.mtimeMs).toISOString(),
      kind,
      durationSec: info.durationSec,
      width: info.width,
      height: info.height,
      // M35：素材卡片要标「含音频」——视频自带的音轨在方言里不会自动进混音，
      // 用户在导入时就得看见这件事（不然导完才发现导出是静音的）。
      hasAudio: info.hasAudio === true,
      mtimeMs: stat.mtimeMs
    });
  }
  assets.sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));
  for (const asset of assets) delete /** @type {any} */ (asset).mtimeMs;
  return assets;
}

/**
 * 缩略图缓存文件（名字带 mtime+size：源变了就是另一个文件）。
 * @param {{ dir: string }} project
 * @param {string} name
 * @param {{ mtimeMs: number, size: number }} stat
 */
function thumbCachePath(project, name, stat) {
  const digest = createHash('sha1').update(`${name}\u0000${stat.mtimeMs}\u0000${stat.size}`).digest('hex').slice(0, 12);
  return path.join(project.dir, '.film', 'thumbs', `${digest}.png`);
}

/**
 * 跑一个短命令（只用来抽缩略图）。
 *
 * M37：改成 `execFile`（自带 `timeout` + `killSignal`），studio 侧不再自己
 * `spawn` 再 `kill`——导出取消走作业句柄，这里连一条「第二套 kill」都不留。
 * 语义不变：超时按 SIGKILL 收，stderr 尾部带一句「超过 N ms」。
 *
 * @param {string} command @param {string[]} args
 */
function run(command, args) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: FFMPEG_TIMEOUT_MS, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stderr: String(stderr ?? '') });
          return;
        }
        const raw = /** @type {any} */ (error);
        const code = typeof raw.code === 'number' ? raw.code : null;
        const killed = raw.killed === true || raw.signal === 'SIGKILL';
        const text = String(stderr ?? '') || String(raw.message ?? error);
        resolve({ code, stderr: killed ? `${text}\n（超过 ${FFMPEG_TIMEOUT_MS}ms）` : text });
      },
    );
  });
}

/**
 * 取（必要时生成）缩略图。
 * @param {{ project: { dir: string }, name: string }} input
 * @returns {Promise<{ ok: true, path: string, cached: boolean, bytes: number } | { ok: false, status: number, code: string, message: string }>}
 */
export async function thumbOf(input) {
  const problem = checkAssetName(input.name);
  if (problem !== null) return { ok: false, status: 400, ...problem };
  const kind = mediaKindOf(input.name);
  if (kind === null) {
    return { ok: false, status: 404, code: 'ASSET_UNSUPPORTED', message: `不是可显示的素材：${input.name}` };
  }
  if (kind === 'sound') {
    return { ok: false, status: 404, code: 'ASSET_NO_THUMB', message: `音频没有缩略图：${input.name}` };
  }
  const dir = assetsDirOf(input.project);
  const file = path.join(dir, input.name);
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return { ok: false, status: 404, code: 'ASSET_NOT_FOUND', message: `素材不存在：${input.name}` };
  }
  if (!stat.isFile()) {
    return { ok: false, status: 404, code: 'ASSET_NOT_FOUND', message: `不是文件：${input.name}` };
  }
  // 符号链接也可能指到工程外：真实路径必须在 assets/ 里。
  try {
    const [real, root] = await Promise.all([fs.realpath(file), fs.realpath(dir)]);
    if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
      return { ok: false, status: 400, code: 'ASSET_PATH_ESCAPE', message: '素材真实路径在工程外' };
    }
  } catch {
    return { ok: false, status: 404, code: 'ASSET_NOT_FOUND', message: `素材不存在：${input.name}` };
  }

  const target = thumbCachePath(input.project, input.name, stat);
  try {
    const cached = await fs.stat(target);
    if (cached.isFile() && cached.size > 0) return { ok: true, path: target, cached: true, bytes: cached.size };
  } catch {
    // 没缓存，生成
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  const result = await run('ffmpeg', [
    '-v', 'error',
    '-y',
    '-i', file,
    '-vf', `scale=${THUMB_WIDTH}:-2:flags=lanczos`,
    '-frames:v', '1',
    target
  ]);
  if (result.code !== 0) {
    await fs.unlink(target).catch(() => {});
    return {
      ok: false,
      status: 500,
      code: 'THUMB_FAILED',
      message: `ffmpeg 抽帧失败（exit ${String(result.code)}）：${result.stderr.trim().slice(-300)}`
    };
  }
  let generated;
  try {
    generated = await fs.stat(target);
  } catch {
    return { ok: false, status: 500, code: 'THUMB_FAILED', message: 'ffmpeg 没有产出缩略图' };
  }
  return { ok: true, path: target, cached: false, bytes: generated.size };
}

/**
 * 把已有素材插回时间线（不复制文件）。
 * @param {{ registry: any, project: { projectId: string, dir: string }, doc: any, name: string, at?: number|null, track?: number|null, ripple?: boolean }} input
 * @returns {Promise<{ ok: true, hash: string, clipId: string, assetPath: string, kind: AssetKind, bytes: number, at: number, shifted: number } | { ok: false, status: number, code: string, message: string }>}
 */
export async function insertExistingAsset(input) {
  const problem = checkAssetName(input.name);
  if (problem !== null) return { ok: false, status: 400, ...problem };
  const kind = mediaKindOf(input.name);
  if (kind === null) {
    return { ok: false, status: 400, code: 'ASSET_UNSUPPORTED', message: `不是可插入的素材：${input.name}` };
  }
  const file = path.join(assetsDirOf(input.project), input.name);
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return { ok: false, status: 404, code: 'ASSET_NOT_FOUND', message: `素材不存在：${input.name}` };
  }
  const info = await describeAsset(file, kind);
  const duration = kind === 'still' ? 4 : info.durationSec;
  if (!Number.isFinite(Number(duration)) || Number(duration) <= 0) {
    return { ok: false, status: 400, code: 'ASSET_DURATION_UNKNOWN', message: `读不出时长：${input.name}` };
  }
  const built = buildInsertOp({
    doc: input.doc,
    assetName: input.name,
    kind,
    duration: Number(duration),
    hasAudio: info.hasAudio,
    at: input.at,
    track: input.track
  });
  const current = input.registry.docOf(input.project.projectId);
  if (current === null) {
    return { ok: false, status: 404, code: 'FILM_NOT_FOUND', message: '工程未打开' };
  }
  /**
   * 波纹插入（M23-A3）：往主轨插一段后，原本在插入点之后的片段整体右移，不覆盖。
   *
   * 位移 Op 与 insert Op **拼在同一批**里 → 一次 `/ops`、一步撤销、要么都成要么都不成。
   * 用 `input.doc`（插入前的 doc）算位移，所以不用去区分刚插进来的那一条。
   */
  const ops = [built.op];
  let shifted = 0;
  if (input.ripple === true && Number.isInteger(input.track)) {
    const plan = planRippleInsert({
      tracks: input.doc?.tracks ?? [],
      track: Number(input.track),
      at: built.at,
      length: Number(duration)
    });
    ops.push(...plan.ops);
    shifted = plan.moved.length;
  }
  const result = await input.registry.applyOps(
    input.project.projectId,
    { opId: `asset:${createHash('sha1').update(`${input.name}:${Date.now()}`).digest('hex').slice(0, 12)}`, expectedHash: current.hash, by: 'person' },
    ops
  );
  if (result?.ok !== true) {
    return {
      ok: false,
      status: 400,
      code: typeof result?.code === 'string' ? result.code : 'ASSET_OP_FAILED',
      message: typeof result?.message === 'string' ? result.message : '写入 film.html 失败'
    };
  }
  return {
    ok: true,
    hash: String(result.hash ?? ''),
    clipId: built.clipId,
    assetPath: `assets/${input.name}`,
    kind,
    bytes: stat.size,
    at: built.at,
    shifted
  };
}
