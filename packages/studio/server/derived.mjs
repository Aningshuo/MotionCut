/**
 * 派生帧（服务端缩略图 · R21 / BATCH-SUB2-R29-066）
 *
 * ## 它是什么
 *
 * `GET /api/projects/:id/derived?what=frame&rel=<工程相对路径>&ms=<int>&w=<int>`
 * 按毫秒从**源文件**切一帧 JPEG 回来。时间线的胶片条要的就是它：每 80 CSS px 一格，
 * 每格一个 `ms`，同一格反复请求必须拿到同一张图。
 *
 * 参照实现（OpenFilm 的 `studio/server/derived.mjs`）是同一套形状：
 * `-ss <ms/1000> -i <abs> -frames:v 1 -vf scale=<w>:-2 -f image2pipe -vcodec mjpeg -q:v 5 -`，
 * 缓存键里带 `rel + size + mtime`（源一换就是另一条缓存），宽度夹在 32–640。
 * 这里不引新依赖、不落中间 png、不碰 film.html。
 *
 * ## 边界（照任务书 §2）
 *
 * - **页片段不在这里**：`.html/.htm` 没有「文件」可切，由前端的页帧路径去画（无头浏览器）。
 *   服务端**明确 415**，不静默返回一张黑图或空图。
 * - **缓存键** = `rel + 源文件 size + 源文件 mtime + ms + w`，落 `.film/cache/frames/`；
 *   命中就直接读文件，**字节完全相同**（没有「重新压一遍可能略有差异」这回事）。
 * - **失败必须 4xx/5xx 带 code**：不存在的 rel 404、ms 超时长 400、w 越界 400、
 *   非媒体类型 415、ffmpeg 抽不出来 422。200 + 0 字节是被禁止的。
 * - 抽帧并发上限 3（参照实现的 SLOTS=3）：一条 2000px 的时间线会一次要几十帧，
 *   不限并发就是几十个 ffmpeg 同时起。
 */

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { probeMedia } from '../../render/verify.mjs';
import { mediaKindOf } from './media-import.mjs';
import { checkRelPath, isInside } from './project-file.mjs';

/** 缓存落点（工程内，`.film/` 不进 git 也不走内容 origin）。 */
export const FRAME_CACHE_DIR = path.join('.film', 'cache', 'frames');

/** 宽度上下限：太窄看不清，太宽比源码还费。 */
export const FRAME_WIDTH_MIN = 32;
export const FRAME_WIDTH_MAX = 640;
/** 与参照一致：调用方没给 w 时按 160（= 80 CSS px 的 2 倍）。 */
export const FRAME_WIDTH_DEFAULT = 160;

/** 单帧超时：宁可报错，不拖住请求。 */
const FFMPEG_TIMEOUT_MS = 30_000;

/**
 * 末尾容差（毫秒）：与参照的时间线同一口径 —— 它按 `源时长 − 40ms` 取最后一格。
 * 3.000s 的片最后一帧在 2.9667s，`-ss 2.999` 之后一帧都不剩（ffmpeg 直接空输出）；
 * 差这 40ms 在图上看不出来，但在 API 上就是「合法时刻却报错」。这里把它吸收掉。
 */
const END_TOLERANCE_MS = 40;

/** 同时最多跑几个 ffmpeg（参照 `SLOTS.size = 3`）。 */
const MAX_CONCURRENT = 3;
let busy = 0;
/** @type {Array<() => void>} */
const waiting = [];

/**
 * 取一个并发槽再干活。
 * @template T @param {() => Promise<T>} work @returns {Promise<T>}
 */
async function withSlot(work) {
  busy += 1;
  if (busy > MAX_CONCURRENT) await new Promise((resolve) => waiting.push(() => resolve(undefined)));
  try {
    return await work();
  } finally {
    busy -= 1;
    const next = waiting.shift();
    if (next !== undefined) next();
  }
}

/** 已探过的时长：绝对路径 + mtime + size → 毫秒（探不出来记 null）。 */
const durationCache = new Map();

/**
 * 源文件时长（毫秒）；探不出来给 null（不拿默认值冒充，静帧本来就没有时长）。
 * @param {string} file @param {{ mtimeMs: number, size: number }} statInfo
 * @returns {Promise<number|null>}
 */
async function durationMsOf(file, statInfo) {
  const key = `${file}\u0000${statInfo.mtimeMs}\u0000${statInfo.size}`;
  if (durationCache.has(key)) return durationCache.get(key) ?? null;
  /** @type {number|null} */
  let value = null;
  try {
    const probe = await probeMedia(file);
    const seconds = Number(probe?.video?.durationSec ?? probe?.format?.durationSec);
    if (Number.isFinite(seconds) && seconds > 0) value = Math.round(seconds * 1000);
  } catch {
    // 探不出来不是致命：ffmpeg 自己会判能不能切（切不出来走 422）。
  }
  durationCache.set(key, value);
  if (durationCache.size > 500) {
    let drop = 250;
    for (const cacheKey of durationCache.keys()) {
      durationCache.delete(cacheKey);
      if (--drop <= 0) break;
    }
  }
  return value;
}

/** @typedef {{ ok: true, path: string, cached: boolean, bytes: number, rel: string, ms: number, requestedMs: number, width: number, contentType: string } | { ok: false, status: number, code: string, message: string }} FrameResult */

/**
 * 跑一次 ffmpeg，把 stdout 收成 Buffer。
 * @param {string[]} args
 * @returns {Promise<{ ok: true, bytes: Buffer } | { ok: false, code: number|null, stderr: string }>}
 */
function runFfmpeg(args) {
  return new Promise((resolve) => {
    execFile(
      'ffmpeg',
      args,
      { timeout: FFMPEG_TIMEOUT_MS, killSignal: 'SIGKILL', encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ ok: true, bytes: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '') });
          return;
        }
        const raw = /** @type {any} */ (error);
        const killed = raw.killed === true || raw.signal === 'SIGKILL';
        const text = String(stderr ?? '') || String(raw.message ?? error);
        resolve({
          ok: false,
          code: typeof raw.code === 'number' ? raw.code : null,
          stderr: killed ? `${text}\n（超过 ${FFMPEG_TIMEOUT_MS}ms）` : text,
        });
      },
    );
  });
}

/**
 * 解析 `ms`：必须是整数毫秒且 ≥ 0。字符串空、`NaN`、小数一律 400（不替调用方猜）。
 * @param {unknown} raw
 * @returns {{ ok: true, ms: number } | { ok: false, status: number, code: string, message: string }}
 */
function parseMs(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return { ok: false, status: 400, code: 'DERIVED_MS_INVALID', message: 'ms 必填：整数毫秒（≥ 0）' };
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    return { ok: false, status: 400, code: 'DERIVED_MS_INVALID', message: `ms 必须是 ≥ 0 的整数毫秒：${JSON.stringify(raw)}` };
  }
  return { ok: true, ms: value };
}

/**
 * 解析 `w`：整数、在 [32, 640] 内；宽度取偶数（H.264/JPEG 的 scale 对奇数宽会裁 1px）。
 * **越界是 400，不是夹到边界** —— 夹边界会让调用方以为自己要到了 9999 宽的图。
 * @param {unknown} raw
 * @returns {{ ok: true, width: number } | { ok: false, status: number, code: string, message: string }}
 */
function parseWidth(raw) {
  const fallback = raw === null || raw === undefined || String(raw).trim() === '';
  const value = fallback ? FRAME_WIDTH_DEFAULT : Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return { ok: false, status: 400, code: 'DERIVED_WIDTH_OUT_OF_RANGE', message: `w 必须是整数像素：${JSON.stringify(raw)}` };
  }
  if (value < FRAME_WIDTH_MIN || value > FRAME_WIDTH_MAX) {
    return {
      ok: false,
      status: 400,
      code: 'DERIVED_WIDTH_OUT_OF_RANGE',
      message: `w 必须在 ${String(FRAME_WIDTH_MIN)}–${String(FRAME_WIDTH_MAX)} 之间：${String(value)}`,
    };
  }
  return { ok: true, width: Math.round(value / 2) * 2 };
}

/**
 * 缓存键：`rel + size + mtime + ms + w`。
 *
 * 前 20 位是「源文件这一版」的指纹（与参照的 `sha1(rel\0size\0mtime)[:20]` 同形），
 * 文件名里再带 `ms` 与 `w`，一眼能看出是哪一帧、多宽 —— 排障不用再算哈希。
 * @param {string} projectDir @param {string} rel @param {{ mtimeMs: number, size: number }} statInfo @param {number} ms @param {number} width
 */
function cachePathOf(projectDir, rel, statInfo, ms, width) {
  const digest = createHash('sha1')
    .update(`${rel}\u0000${String(statInfo.size)}\u0000${String(Math.round(statInfo.mtimeMs))}`)
    .digest('hex')
    .slice(0, 20);
  return path.join(projectDir, FRAME_CACHE_DIR, `${digest}-${String(ms)}-${String(width)}.jpg`);
}

/**
 * 取（必要时生成）一帧。
 *
 * @param {{ project: { dir: string }, what: unknown, rel: unknown, ms: unknown, w: unknown }} input
 * @returns {Promise<FrameResult>}
 */
export async function frameOf(input) {
  if (String(input.what ?? '') !== 'frame') {
    return { ok: false, status: 400, code: 'DERIVED_WHAT_UNSUPPORTED', message: 'what 目前只支持 frame' };
  }

  const checked = checkRelPath(input.rel);
  if (checked.ok !== true) return { ok: false, status: 400, code: checked.code, message: checked.message };
  const rel = checked.rel;

  /* 页片段：没有「文件」可切（前端走无头浏览器画），明确 415，不返回黑图。 */
  if (/\.html?$/i.test(rel)) {
    return {
      ok: false,
      status: 415,
      code: 'DERIVED_PAGE_NOT_MEDIA',
      message: `页片段没有可切的帧（要页帧请走前面的页帧路径）：${rel}`,
    };
  }
  const kind = mediaKindOf(path.basename(rel));
  if (kind === null) {
    return { ok: false, status: 415, code: 'DERIVED_UNSUPPORTED', message: `不是可切帧的媒体：${rel}` };
  }
  if (kind === 'sound') {
    return { ok: false, status: 415, code: 'DERIVED_NO_PICTURE', message: `音频没有画面：${rel}` };
  }

  const ms = parseMs(input.ms);
  if (ms.ok !== true) return ms;
  const width = parseWidth(input.w);
  if (width.ok !== true) return width;

  const root = path.resolve(input.project.dir);
  const target = path.resolve(root, rel);
  if (!isInside(root, target)) {
    return { ok: false, status: 400, code: 'E_PATH_ESCAPE', message: '越界路径' };
  }
  let realRoot;
  let realTarget;
  let statInfo;
  try {
    realRoot = await fs.realpath(root);
    realTarget = await fs.realpath(target);
    statInfo = await fs.stat(realTarget);
  } catch {
    return { ok: false, status: 404, code: 'DERIVED_SOURCE_NOT_FOUND', message: `源文件不存在：${rel}` };
  }
  if (!isInside(realRoot, realTarget)) {
    return { ok: false, status: 400, code: 'E_PATH_ESCAPE', message: '源文件真实路径在工程外（符号链接）' };
  }
  if (!statInfo.isFile()) {
    return { ok: false, status: 400, code: 'DERIVED_NOT_A_FILE', message: `不是普通文件：${rel}` };
  }

  /* ms 超时长：先说清楚，不让 ffmpeg 去产出最后那帧（那会让「末帧」看起来永远成功）。 */
  let seekMs = ms.ms;
  if (kind !== 'still') {
    const durationMs = await durationMsOf(realTarget, statInfo);
    if (durationMs !== null && ms.ms >= durationMs) {
      return {
        ok: false,
        status: 400,
        code: 'DERIVED_MS_OUT_OF_RANGE',
        message: `ms 超出时长：${String(ms.ms)}ms ≥ ${String(durationMs)}ms（${rel}）`,
      };
    }
    if (durationMs !== null && ms.ms > durationMs - END_TOLERANCE_MS) {
      seekMs = Math.max(0, durationMs - END_TOLERANCE_MS);
    }
  }

  const cachePath = cachePathOf(input.project.dir, rel, statInfo, seekMs, width.width);
  try {
    const cached = await fs.stat(cachePath);
    if (cached.isFile() && cached.size > 0) {
      return {
        ok: true,
        path: cachePath,
        cached: true,
        bytes: cached.size,
        rel,
        ms: seekMs,
        requestedMs: ms.ms,
        width: width.width,
        contentType: 'image/jpeg',
      };
    }
  } catch {
    // 没缓存 → 生成
  }

  /* 静帧没有可 seek 的时间轴：带 -ss 在 image2 demuxer 上会失败，直接取那张图。 */
  const args = ['-v', 'error', ...(kind === 'still' ? [] : ['-ss', String(seekMs / 1000)]), '-i', realTarget, '-frames:v', '1', '-vf', `scale=${String(width.width)}:-2`, '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '5', '-'];
  const made = await withSlot(() =>
    runFfmpeg(args),
  );
  if (made.ok !== true) {
    return {
      ok: false,
      status: 422,
      code: 'DERIVED_FRAME_FAILED',
      message: `ffmpeg 切帧失败（exit ${String(made.code)}）：${made.stderr.trim().slice(-300)}`,
    };
  }
  if (made.bytes.byteLength === 0) {
    return { ok: false, status: 422, code: 'DERIVED_FRAME_EMPTY', message: `ffmpeg 没有产出字节：${rel} @ ${String(seekMs)}ms` };
  }

  /* 先写临时名再 rename：另一个并发请求不会读到半张图。 */
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const temp = `${cachePath}.${String(process.pid)}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temp, made.bytes);
    await fs.rename(temp, cachePath);
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    return {
      ok: false,
      status: 500,
      code: 'DERIVED_CACHE_WRITE_FAILED',
      message: `写缓存失败：${String(/** @type {any} */ (error)?.message ?? error)}`,
    };
  }

  return {
    ok: true,
    path: cachePath,
    cached: false,
    bytes: made.bytes.byteLength,
    rel,
    ms: seekMs,
    requestedMs: ms.ms,
    width: width.width,
    contentType: 'image/jpeg',
  };
}
