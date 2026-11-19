/**
 * 最近工程的封面（M57）。
 *
 * 「最近工程」原来只有名字和相对时间，一排看下去分不清谁是谁。封面解决的是这件事：
 * 拿工程里**第一个视频片段**所在的素材抽一帧 320px 缩略图，存到
 * `<home>/.opencut/covers/<sha1(工程路径)前16位>.png`，索引里只记文件名。
 *
 * ## 为什么不直接复用 `/assets/:name/thumb`
 *
 * 那条路由要一个**当前打开着**的 `projectId`。最近工程列表里有已经关掉的工程，
 * 拿不到 projectId；而且列表一屏十几个，逐个去开工程只为了缩略图太重。
 * 所以封面在**打开工程时**生成一次、落到用户目录，之后列表只读文件。
 *
 * ## 失败一律静默
 *
 * 封面是装饰：素材缺失、ffmpeg 抽帧失败、磁盘写不进去——都不该让「打开工程」失败。
 * 这条链上每一步都返回 `null`，调用方拿到 null 就保持 `cover` 字段不存在，UI 画占位块。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { thumbOf } from './assets-library.mjs';

/** 允许的封面文件名：16 位十六进制 + `.png`。别的形状一律拒（防目录穿越）。 */
const COVER_NAME_RE = /^[a-f0-9]{16}\.png$/;

/** 能抽帧的扩展名。音频/图片不作为封面来源。 */
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v']);

/**
 * 封面目录：`<home>/.opencut/covers`。测试注入临时 home。
 * @param {string} [home]
 * @returns {string}
 */
export function coversDir(home) {
  return path.join(home === undefined || home === '' ? os.homedir() : home, '.opencut', 'covers');
}

/**
 * 工程路径 → 封面文件名。同一个工程永远同一个名字，重新打开只覆盖不新增。
 * @param {string} projectPath
 * @returns {string}
 */
export function coverNameFor(projectPath) {
  return `${createHash('sha1').update(path.resolve(projectPath)).digest('hex').slice(0, 16)}.png`;
}

/**
 * 封面文件的绝对路径。**调用方必须先用 `isCoverName` 校验**——这里不做二次检查，
 * 免得出现「两处各判一遍、判得还不一样」。
 * @param {string} name
 * @param {string} [home]
 */
export function coverPath(name, home) {
  return path.join(coversDir(home), name);
}

/** @param {string} name */
export function isCoverName(name) {
  return COVER_NAME_RE.test(name);
}

/**
 * 从文档里找第一个能当封面的视频素材（工程相对路径 `assets/xxx.mp4`）。
 *
 * `src` 可能带时间片段（`assets/a.mp4#t=0,3`），也可能指到外面（http/data）——
 * 只要工程内的本地视频。`a/b.mp4` 这种嵌套也认，但必须落在 `assets/` 下。
 *
 * @param {any} doc
 * @returns {string | null} 形如 `take-a.mp4`
 */
export function firstVideoAsset(doc) {
  const tracks = doc?.tracks;
  if (!Array.isArray(tracks)) return null;
  for (const track of tracks) {
    const clips = track?.clips;
    if (!Array.isArray(clips)) continue;
    for (const clip of clips) {
      const raw = typeof clip?.src === 'string' ? clip.src : '';
      if (raw === '') continue;
      const withoutFragment = raw.split('#')[0];
      if (!withoutFragment.startsWith('assets/')) continue;
      if (!VIDEO_EXT.has(path.extname(withoutFragment).toLowerCase())) continue;
      const name = withoutFragment.slice('assets/'.length);
      // 素材名里不许出现上层跳转：`assets/../x.mp4` 不是封面来源。
      if (name === '' || name.split('/').includes('..')) continue;
      return name;
    }
  }
  return null;
}

/**
 * 生成（或复用）封面，返回文件名；任何一步失败返回 `null`。
 *
 * @param {{ project: any, projectPath: string, home?: string }} input
 * @returns {Promise<string | null>}
 */
export async function ensureProjectCover(input) {
  const asset = firstVideoAsset(input.project?.doc);
  if (asset === null) return null;
  let thumb;
  try {
    thumb = await thumbOf({ project: input.project, name: asset });
  } catch {
    return null;
  }
  if (thumb === null || thumb.ok !== true) return null;

  let buffer;
  try {
    buffer = await fs.readFile(thumb.path);
  } catch {
    return null;
  }
  const dir = coversDir(input.home);
  const name = coverNameFor(input.projectPath);
  const target = path.join(dir, name);
  const tmp = `${target}.tmp-${String(process.pid)}`;
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmp, buffer);
    await fs.rename(tmp, target);
  } catch {
    await fs.unlink(tmp).catch(() => undefined);
    return null;
  }
  return name;
}
