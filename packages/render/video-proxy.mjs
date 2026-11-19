/**
 * 视频代理（R184）：Chromium 解不了的源（HEVC / ProRes …）在导出前转成 H.264 代理。
 *
 * ## 为什么需要
 *
 * 舞台取帧靠 `<video>` + Playwright Chromium。Chromium **不带 HEVC 解码**：
 * `canPlayType('video/mp4; codecs="hvc1…"')` 返回空串，元素 `readyState` 能到 4、
 * `duration` 也对，但 `videoWidth/videoHeight` 是 0、`error` 是 null —— 画面上什么都不出现，
 * 导出却一路 `done`。R180 的 `演示工程-网页片段` 就是这么出一支 727KB 的黑片。
 *
 * ## 口径
 *
 * - **只给 Chromium 能放的编码放行**：`h264` / `vp8` / `vp9` / `av1`。
 * - 代理落在 `<project>/proxies/<sha1(相对路径|字节数|mtime)>.mp4`：内容 origin 的路径守卫
 *   拒绝以 `.` 开头的段（`.film/**`），所以不能塞进 `.film`；`proxies/` 是普通目录。
 * - 只转画面（`-an`）：视频片段在舞台里本来就 `muted`，声音走独立的 `<audio>` 片段。
 * - 转不出来就**抛错**（`PROXY_FAILED`）：宁可在 plan 阶段失败，也不产黑片。
 *
 * ## 谁调用
 *
 * - `export-job.mjs`：plan 完成后、capture 之前 `warmVideoProxies()`（不受舞台 30s 启动预算限制）。
 * - `content-origin.mjs`：发 `doc.json` 时 `annotateVideoProxies()` —— 只做 `existsSync`，
 *   代理已存在就给片段挂 `proxy` 字段；不存在就不挂（预览仍按原样，导出会先 warm）。
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { isClipDisabled } from '../film-core/clip-state.mjs';

/** Chromium（Playwright 自带那份）能直接放的视频编码。 */
export const CHROMIUM_VIDEO_CODECS = Object.freeze(['h264', 'vp8', 'vp9', 'av1']);

/** 代理目录（相对工程根，不能以 `.` 开头 —— 内容 origin 会 403）。 */
export const PROXY_DIR = 'proxies';

/**
 * 代理编码参数版本。**改了下面 ffmpeg 的参数就必须改这里** —— 否则老的缓存文件会被
 * 当成「同一个代理」继续复用（cache key 只认源文件，不认编码参数）。
 *
 * `gop15-v1`：GOP 15 帧、无 B 帧。默认 `keyint=250` 时逐帧 seek 每次都要回退到上一个
 * 关键帧重解，实测 1080p 源只有 4.5 fps 取帧；短 GOP + 无 B 帧是逐帧取样的常规做法。
 */
export const PROXY_VERSION = 'gop15-v1';

/**
 * `assets/x.mp4#t=0,167.5` → `assets/x.mp4`。
 * @param {any} src
 * @returns {string}
 */
export const stripFragment = (src) => String(src ?? '').split('#')[0] ?? '';

/**
 * @param {string} text
 * @returns {string}
 */
const sha1 = (text) => createHash('sha1').update(text).digest('hex');

/**
 * 读视频编码名（ffprobe）。读不到返回 null（当作「未知」，让调用方决定）。
 * @param {string} file
 * @param {string} ffprobePath
 * @returns {Promise<string|null>}
 */
export function probeVideoCodec(file, ffprobePath = 'ffprobe') {
  return new Promise((done) => {
    execFile(ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'default=nw=1:nk=1', file], { timeout: 15000 }, (error, stdout) => {
      if (error) {
        done(null);
        return;
      }
      const codec = (String(stdout ?? '').trim().split('\n')[0] ?? '').trim();
      done(codec === '' ? null : codec);
    });
  });
}

/**
 * 一段视频在工程内的相对路径 → 代理相对路径（含 cache key：路径 + 字节数 + mtime）。
 * 源文件不存在时返回 null。
 * @param {string} projectDir
 * @param {string} rel
 * @returns {Promise<string|null>}
 */
export async function proxyRelPathFor(projectDir, rel) {
  const clean = stripFragment(rel);
  if (clean === '' || /^[a-z]+:\/\//i.test(clean) || clean.startsWith('/')) return null;
  try {
    const info = await stat(join(projectDir, clean));
    if (!info.isFile()) return null;
    return `${PROXY_DIR}/${sha1(`${PROXY_VERSION}|${clean}|${info.size}|${Math.round(info.mtimeMs)}`)}.mp4`;
  } catch {
    return null;
  }
}

/**
 * 确保一段源有代理；返回代理相对路径（已存在就直接复用）。
 * @param {string} projectDir
 * @param {string} rel
 * @param {{ ffmpegPath: string, ffprobePath?: string, log?: (line: string) => void }} options
 * @returns {Promise<{ rel: string, proxy: string|null, codec: string|null, built: boolean, reason: string }>}
 */
export async function ensureVideoProxy(projectDir, rel, options) {
  const codec = await probeVideoCodec(join(projectDir, stripFragment(rel)), options.ffprobePath ?? 'ffprobe');
  const proxy = await proxyRelPathFor(projectDir, rel);
  if (proxy === null) return { rel, proxy: null, codec, built: false, reason: 'SOURCE_MISSING' };
  if (codec !== null && CHROMIUM_VIDEO_CODECS.includes(codec)) {
    return { rel, proxy: null, codec, built: false, reason: 'SUPPORTED' };
  }
  const target = join(projectDir, proxy);
  if (existsSync(target)) return { rel, proxy, codec, built: false, reason: 'CACHED' };
  await mkdir(dirname(target), { recursive: true });
  await new Promise((done, fail) => {
    const args = [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', join(projectDir, stripFragment(rel)),
      '-map', '0:v:0',
      '-vf', 'scale=-2:1080:flags=bicubic',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      /* 短 GOP + 无 B 帧：取帧是**逐帧 seek**，不是顺序播放。 */
      '-g', '15', '-keyint_min', '15', '-sc_threshold', '0', '-bf', '0',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      '-an', '-sn', '-dn',
      target,
    ];
    execFile(options.ffmpegPath, args, { timeout: 30 * 60 * 1000, maxBuffer: 8 << 20 }, (error, _stdout, stderr) => {
      if (error) {
        const detail = String(stderr ?? '').trim().split('\n').slice(-3).join(' / ');
        fail(Object.assign(new Error(`视频代理转码失败：${stripFragment(rel)}（${detail || error.message}）`), { code: 'PROXY_FAILED' }));
        return;
      }
      options.log?.(`PROXY_BUILT ${stripFragment(rel)} codec=${codec ?? 'unknown'} → ${proxy}`);
      done(undefined);
    });
  });
  return { rel, proxy, codec, built: true, reason: 'BUILT' };
}

/**
 * 把 doc 中启用的 `kind: 'video'` 片段过一遍代理；返回统计。失败抛 `PROXY_FAILED`。
 * @param {string} projectDir
 * @param {any} doc
 * @param {{ ffmpegPath: string, ffprobePath?: string, log?: (line: string) => void }} options
 */
export async function warmVideoProxies(projectDir, doc, options) {
  /** @type {{ built: string[], cached: string[], supported: string[], failed: string[] }} */
  const summary = { built: [], cached: [], supported: [], failed: [] };
  const tracks = Array.isArray(doc?.tracks) ? doc.tracks : [];
  for (const track of tracks) {
    for (const clip of track?.clips ?? []) {
      if (clip?.kind !== 'video' || isClipDisabled(clip)) continue;
      const rel = stripFragment(clip.src);
      if (rel === '') continue;
      const result = await ensureVideoProxy(projectDir, rel, options);
      if (result.reason === 'BUILT') summary.built.push(rel);
      else if (result.reason === 'CACHED') summary.cached.push(rel);
      else if (result.reason === 'SUPPORTED') summary.supported.push(`${rel}:${result.codec ?? '?'}`);
      else if (result.reason === 'SOURCE_MISSING') summary.failed.push(`${rel}:SOURCE_MISSING`);
    }
  }
  return summary;
}

/**
 * 给 doc 的 video 片段挂 `proxy`（只认**已存在**的代理文件；不转码、不建目录）。
 * 返回新 doc，不动入参。一条 stat 换一个字段，doc.json 这条快路径扛得住。
 * @param {string} projectDir
 * @param {any} doc
 * @returns {Promise<any>}
 */
export async function annotateVideoProxies(projectDir, doc) {
  const tracks = Array.isArray(doc?.tracks) ? doc.tracks : null;
  if (tracks === null) return doc;
  /** @type {Map<string, string|null>} */
  const memo = new Map();
  let touched = false;
  const nextTracks = [];
  for (const track of tracks) {
    const clips = Array.isArray(track?.clips) ? track.clips : null;
    if (clips === null) {
      nextTracks.push(track);
      continue;
    }
    const nextClips = [];
    for (const clip of clips) {
      if (clip?.kind !== 'video' || typeof clip.src !== 'string') {
        nextClips.push(clip);
        continue;
      }
      if (!memo.has(clip.src)) memo.set(clip.src, await proxyRelPathFor(projectDir, clip.src));
      const candidate = memo.get(clip.src) ?? null;
      if (candidate !== null && existsSync(join(projectDir, candidate))) {
        touched = true;
        nextClips.push({ ...clip, proxy: candidate });
      } else {
        nextClips.push(clip);
      }
    }
    nextTracks.push({ ...track, clips: nextClips });
  }
  return touched ? { ...doc, tracks: nextTracks } : doc;
}
