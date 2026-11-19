/**
 * 素材缺失检测 + 重链（M26 · B-MAIN-R13-013）。
 *
 * ## 为什么需要
 *
 * film.html 里的 `src` 是**相对工程目录的路径**。用户把 `assets/` 里的文件改名/移动，
 * 片段还在、画面没了，工程等于废掉。这里只做三件事：
 *
 * 1. **检测**：逐条 bare src 判 `ok` / `missing` / `unreadable`（能 stat 到但 ffprobe 读不出）。
 * 2. **重链**：把 `src` 指到新文件，**保留原 `#t=in,out` 与 `at`**；类型/时长不匹配就报码。
 * 3. **批量**：给一个目录，按**文件名**（basename，忽略 `#t=`）匹配，先列「将重链 N / 跳过 M」。
 *
 * ## 边界（写进交接，别让后线猜）
 *
 * - 只改 `src`，不碰 `at`/`#t=`/`fade`——重链不是重新剪辑。
 * - 路径必须落在工程目录内（`assets/` 或任意子目录），`.film/` 与目录外一律拒绝。
 * - 尺寸校验只在**两侧都能拿到尺寸**时做：旧文件还在（比如指错文件）或片段自带 `size`。
 *   旧文件已经没了的时候，新文件的尺寸无从比较——如实标 `sizeUnverified`，不假装校验过。
 * - 写盘仍走 `registry.applyOps`：一批 Op = 一次 CAS = 一步撤销。本模块不自己写文件。
 */

import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

import { clipKindOf } from '../../film-core/ops.mjs';
import { bareSrc } from '../../film-core/transition.mjs';
import { probeMedia } from '../../render/verify.mjs';
import { extensionOf, mediaKindOf } from './media-import.mjs';

/** 探过的元数据：绝对路径 + mtime + size → 结果（与素材库同一套思路，各自缓存互不依赖）。 */
const probeCache = new Map();

/** @param {string} file @param {string} kind */
async function probeOf(file, kind) {
  const stat = await fs.stat(file);
  const key = `${file}\u0000${stat.mtimeMs}\u0000${stat.size}\u0000${kind}`;
  const hit = probeCache.get(key);
  if (hit !== undefined) return hit;
  /** @type {{ ok: boolean, error?: string, durationSec: number|null, width: number|null, height: number|null, hasAudio: boolean, hasVideo: boolean }} */
  let value = { ok: false, durationSec: null, width: null, height: null, hasAudio: false, hasVideo: false };
  try {
    const probe = await probeMedia(file);
    const duration = Number(probe?.format?.durationSec ?? probe?.video?.durationSec ?? probe?.audio?.durationSec);
    const width = Number(probe?.video?.width);
    const height = Number(probe?.video?.height);
    value = {
      ok: true,
      // 静帧没有「时长」这回事：null，不拿默认值冒充。
      durationSec: kind === 'still' ? null : Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) / 1000 : null,
      width: Number.isFinite(width) && width > 0 ? width : null,
      height: Number.isFinite(height) && height > 0 ? height : null,
      hasAudio: probe?.audio !== null && probe?.audio !== undefined,
      hasVideo: probe?.video !== null && probe?.video !== undefined,
    };
  } catch (error) {
    const failure = /** @type {any} */ (error);
    value = { ...value, ok: false, error: String(failure && failure.message ? failure.message : failure).slice(0, 300) };
  }
  probeCache.set(key, value);
  if (probeCache.size > 500) {
    let drop = 250;
    for (const cacheKey of probeCache.keys()) {
      probeCache.delete(cacheKey);
      if (--drop <= 0) break;
    }
  }
  return value;
}

/** 工程内路径 → 绝对路径。 @param {{ dir: string }} project @param {string} src */
export function absoluteOf(project, src) {
  const bare = bareSrc(src);
  return path.isAbsolute(bare) ? path.resolve(bare) : path.resolve(project.dir, bare);
}

/**
 * 绝对路径 → 工程内相对路径（`/` 分隔）；越界/内部目录 → null。
 * @param {{ dir: string }} project @param {string} abs
 */
export function relativeOf(project, abs) {
  const rel = path.relative(project.dir, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const normalized = rel.split(path.sep).join('/');
  if (normalized === '.film' || normalized.startsWith('.film/')) return null;
  return normalized;
}

/**
 * 扫描整份 doc 的素材状态。
 *
 * @param {{ project: { dir: string }, doc: any }} input
 * @returns {Promise<{ items: any[], summary: { total: number, ok: number, missing: number, unreadable: number } }>}
 */
export async function mediaStatusOf(input) {
  const { project, doc } = input;
  /** @type {Map<string, any>} */
  const byFile = new Map();
  for (const track of Array.isArray(doc?.tracks) ? doc.tracks : []) {
    for (const clip of Array.isArray(track?.clips) ? track.clips : []) {
      const kind = clipKindOf(clip);
      if (kind === 'page') continue; // 网页片段不是素材文件，不参与缺失检测
      const file = bareSrc(clip.src);
      if (file === '') continue;
      const entry = byFile.get(file) ?? { src: file, kind, clips: [], status: 'ok', durationSec: null, width: null, height: null, hasAudio: false };
      entry.clips.push(clip.id);
      byFile.set(file, entry);
    }
  }

  const items = [];
  for (const entry of byFile.values()) {
    const abs = absoluteOf(project, entry.src);
    let stat = null;
    try {
      stat = await fs.stat(abs);
    } catch {
      stat = null;
    }
    if (stat === null || stat.isDirectory()) {
      items.push({ ...entry, status: 'missing', code: 'MEDIA_MISSING', message: `文件不存在：${entry.src}` });
      continue;
    }
    const probe = await probeOf(abs, entry.kind);
    if (probe.ok !== true) {
      items.push({ ...entry, status: 'unreadable', code: 'MEDIA_UNREADABLE', message: `读不出媒体信息：${entry.src}`, probeError: probe.error ?? '' });
      continue;
    }
    items.push({
      ...entry,
      status: 'ok',
      durationSec: probe.durationSec,
      width: probe.width,
      height: probe.height,
      hasAudio: probe.hasAudio,
    });
  }

  items.sort((a, b) => a.src.localeCompare(b.src));
  const summary = {
    total: items.length,
    ok: items.filter((item) => item.status === 'ok').length,
    missing: items.filter((item) => item.status === 'missing').length,
    unreadable: items.filter((item) => item.status === 'unreadable').length,
  };
  return { items, summary };
}

/** 期望的片段 kind 与文件是否相容；返回错误码或 null。
 * @param {string} expected @param {string} file
 * @returns {string|null}
 */
function kindProblem(expected, file) {
  const ext = extensionOf(file);
  const html = ext === 'html' || ext === 'htm';
  if (expected === 'page') return html ? null : 'RELINK_KIND_MISMATCH';
  if (html) return 'RELINK_KIND_MISMATCH';
  const fileKind = mediaKindOf(file);
  if (fileKind === null) return 'RELINK_UNSUPPORTED';
  if (expected === 'still') return fileKind === 'still' ? null : 'RELINK_KIND_MISMATCH';
  // <audio src="x.mp4"> 是该视频的声音：声音片段接受「音频文件」或「带音轨的视频」，由 probe 再判一次。
  if (expected === 'sound') return fileKind === 'still' ? 'RELINK_KIND_MISMATCH' : null;
  return fileKind === 'video' ? null : 'RELINK_KIND_MISMATCH';
}

/**
 * 重链计划：校验 + 生成 Op（不落盘）。
 *
 * @param {{ project: { dir: string }, doc: any, targets: Array<{ clip: string, src: string, copy?: boolean }>, dryRun?: boolean }} input
 * @returns {Promise<{
 *   ok: boolean, code?: string, message?: string,
 *   ops: any[], applied: any[], rejected: any[], warnings: any[], copied?: any[],
 * }>}
 */
export async function planRelink(input) {
  const { project, doc } = input;
  const targets = Array.isArray(input.targets) ? input.targets : [];
  /** @type {Map<string, any>} */
  const clips = new Map();
  for (const track of Array.isArray(doc?.tracks) ? doc.tracks : []) {
    for (const clip of Array.isArray(track?.clips) ? track.clips : []) clips.set(clip.id, clip);
  }

  /** @type {any[]} */
  const edits = [];
  const applied = [];
  const rejected = [];
  const warnings = [];
  /** 工程外文件复制进 assets/ 的记录（undo 只回 film.html，不删这些文件——写进交接）。 */
  const copied = [];

  for (const rawTarget of targets) {
    const target = /** @type {any} */ (rawTarget);
    const clip = clips.get(target?.clip);
    const requested = typeof target?.src === 'string' ? target.src.trim() : '';
    if (clip === undefined) {
      rejected.push({ clip: target?.clip ?? '', code: 'RELINK_CLIP_UNKNOWN', message: `工程里没有片段 ${String(target?.clip)}` });
      continue;
    }
    if (requested === '') {
      rejected.push({ clip: clip.id, code: 'RELINK_SOURCE_EMPTY', message: '没有给新文件' });
      continue;
    }
    const abs = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(project.dir, requested);
    let rel = relativeOf(project, abs);
    if (rel === null) {
      if (target?.copy !== true) {
        rejected.push({
          clip: clip.id,
          code: 'RELINK_OUTSIDE_PROJECT',
          message: `新文件在工程外：${requested}（传 copy:true 会先复制进 assets/ 再指过去）`,
          canCopy: true,
        });
        continue;
      }
      // 方言只认「相对工程目录」的 src，工程外的文件必须先落进 assets/——这一步是显式的。
      // 落到 assets/relinked/：和原 assets/<name> 不是同一个路径，src 真的变了（undo 才有东西可回）。
      const name = path.basename(abs);
      const dest = path.join(project.dir, 'assets', 'relinked', name);
      rel = `assets/relinked/${name}`;
      if (input.dryRun === true) {
        // 预检不落文件：只说「会复制到哪」，确认时才真复制。
        copied.push({ clip: clip.id, from: abs, to: rel, dryRun: true });
      } else {
      let exists = true;
      try {
        await fs.stat(dest);
      } catch {
        exists = false;
      }
      if (!exists) {
        try {
          await fs.mkdir(path.join(project.dir, 'assets', 'relinked'), { recursive: true });
          await fs.copyFile(abs, dest, fsConstants.COPYFILE_EXCL);
        } catch (error) {
          rejected.push({
            clip: clip.id,
            code: 'RELINK_COPY_FAILED',
            message: `复制进 assets/ 失败：${String(/** @type {any} */ (error)?.message ?? error)}`,
          });
          continue;
        }
      }
      copied.push({ clip: clip.id, from: abs, to: rel });
      }
    }
    let stat = null;
    try {
      stat = await fs.stat(abs);
    } catch {
      stat = null;
    }
    if (stat === null || !stat.isFile()) {
      rejected.push({ clip: clip.id, code: 'RELINK_SOURCE_MISSING', message: `新文件不存在：${rel}` });
      continue;
    }

    const expected = clipKindOf(clip);
    const problem = kindProblem(expected, rel);
    if (problem !== null) {
      rejected.push({
        clip: clip.id,
        code: problem,
        message:
          problem === 'RELINK_UNSUPPORTED'
            ? `不支持的文件类型：${rel}`
            : `类型不匹配：片段是 ${expected}，新文件是 ${mediaKindOf(rel) ?? '页面'}`,
      });
      continue;
    }
    const probe = await probeOf(abs, expected);
    if (probe.ok !== true) {
      rejected.push({ clip: clip.id, code: 'RELINK_UNREADABLE', message: `读不出新文件：${rel}`, probeError: probe.error ?? '' });
      continue;
    }
    if (expected === 'sound' && probe.hasAudio !== true) {
      rejected.push({ clip: clip.id, code: 'RELINK_KIND_MISMATCH', message: `声音片段需要一个有音轨的文件：${rel}` });
      continue;
    }
    if (expected === 'video' && probe.hasVideo !== true) {
      rejected.push({ clip: clip.id, code: 'RELINK_KIND_MISMATCH', message: `视频片段需要一个有画面流的文件：${rel}` });
      continue;
    }

    // 时长：只守「越界」——新素材更短、原出点已经超出 → 报码 + 建议区间，绝不硬塞。
    if (Array.isArray(clip.time) && probe.durationSec !== null) {
      const outPoint = Number(clip.time[1]);
      if (Number.isFinite(outPoint) && outPoint > probe.durationSec + 1e-3) {
        rejected.push({
          clip: clip.id,
          code: 'RELINK_DURATION_SHORT',
          message: `新素材只有 ${probe.durationSec}s，片段的出点是 ${outPoint}s`,
          suggest: { trim: [Number(clip.time[0]), Math.floor(probe.durationSec * 1000) / 1000], availableSec: probe.durationSec },
        });
        continue;
      }
    }

    // 尺寸：两边都拿得到才比；旧文件已经没了就如实标 unverified。
    let sizeUnverified = true;
    const oldAbs = absoluteOf(project, clip.src);
    try {
      await fs.stat(oldAbs);
      const oldProbe = await probeOf(oldAbs, expected);
      if (oldProbe.ok === true && probe.width !== null && oldProbe.width !== null) {
        sizeUnverified = false;
        if (probe.width !== oldProbe.width || probe.height !== oldProbe.height) {
          rejected.push({
            clip: clip.id,
            code: 'RELINK_SIZE_MISMATCH',
            message: `尺寸不匹配：原 ${oldProbe.width}×${oldProbe.height}，新 ${probe.width}×${probe.height}`,
            old: { width: oldProbe.width, height: oldProbe.height },
            next: { width: probe.width, height: probe.height },
          });
          continue;
        }
      }
    } catch {
      // 旧文件不在了：没得比，保留 unverified。
    }
    if (sizeUnverified) warnings.push({ clip: clip.id, code: 'RELINK_SIZE_UNVERIFIED', message: `旧文件已不在，尺寸无法比对（新文件 ${probe.width ?? '?'}×${probe.height ?? '?'}）` });

    // 只换文件：`#t=in,out` 原样跟在后面，`at` 一个字节都不动。
    const suffix = String(clip.src).includes('#') ? String(clip.src).slice(String(clip.src).indexOf('#')) : '';
    const nextSrc = `${rel}${suffix}`;
    edits.push({ clip: clip.id, prop: 'src', value: nextSrc });
    applied.push({
      clip: clip.id,
      from: clip.src,
      to: nextSrc,
      kind: expected,
      durationSec: probe.durationSec,
      width: probe.width,
      height: probe.height,
      sizeUnverified,
    });
  }

  if (applied.length === 0) {
    const first = rejected[0];
    return {
      ok: false,
      code: first?.code ?? 'RELINK_NOTHING_TO_DO',
      message: first?.message ?? '没有可重链的片段',
      ops: [],
      applied: [],
      rejected,
      warnings,
      copied,
    };
  }
  if (rejected.length > 0) {
    // 一部分不合法：整批拒绝，避免「改了一半」让人以为全好了。
    return {
      ok: false,
      code: 'RELINK_PARTIAL',
      message: `${applied.length} 个可重链、${rejected.length} 个被拒：整批未执行`,
      ops: [],
      applied,
      rejected,
      warnings,
      copied,
    };
  }
  return { ok: true, ops: [{ op: 'props', edits }], applied, rejected, warnings, copied };
}

/**
 * 批量重链：给一个目录，按文件名（basename）匹配缺失片段。
 *
 * @param {{ project: { dir: string }, doc: any, dir: string, clips?: string[] }} input
 * @returns {Promise<{ ok: boolean, code?: string, message?: string, dir?: string, matched: any[], skipped: any[], summary: { relink: number, skip: number } }>}
 */
export async function scanRelinkDir(input) {
  const { project, doc } = input;
  const dir = typeof input.dir === 'string' && input.dir.trim() !== '' ? path.resolve(input.dir.trim()) : '';
  if (dir === '') return { ok: false, code: 'RELINK_DIR_EMPTY', message: '没有给目录', matched: [], skipped: [], summary: { relink: 0, skip: 0 } };
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    return {
      ok: false,
      code: 'RELINK_DIR_UNREADABLE',
      message: `目录读不了：${String(/** @type {any} */ (error)?.message ?? error)}`,
      matched: [],
      skipped: [],
      summary: { relink: 0, skip: 0 },
    };
  }
  /** @type {Map<string, string>} basename → 绝对路径 */
  const files = new Map();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (mediaKindOf(entry.name) === null) continue;
    files.set(entry.name, path.join(dir, entry.name));
  }

  const only = Array.isArray(input.clips) && input.clips.length > 0 ? new Set(input.clips) : null;
  const status = await mediaStatusOf({ project, doc });
  const matched = [];
  const skipped = [];
  for (const item of status.items) {
    for (const clipId of item.clips) {
      if (only !== null && !only.has(clipId)) continue;
      const clip = findClip(doc, clipId);
      // 只把「缺失且没同名」算进跳过：文件还在的片段不是候选，不该让「跳过 N」虚高。
      if (item.status !== 'missing') continue;
      const base = path.basename(bareSrc(item.src));
      const candidate = files.get(base);
      if (candidate === undefined) {
        skipped.push({ clip: clipId, oldSrc: item.src, reason: 'NO_SAME_NAME', name: base });
        continue;
      }
      let rel = relativeOf(project, candidate);
      let copy = false;
      if (rel === null) {
        // 工程外：同名文件先复制进 assets/relinked/（确认后执行），src 仍然只写工程内相对路径。
        rel = `assets/relinked/${base}`;
        copy = true;
      }
      const suffix = String(clip?.src ?? '').includes('#') ? String(clip.src).slice(String(clip.src).indexOf('#')) : '';
      matched.push({ clip: clipId, oldSrc: item.src, newSrc: `${rel}${suffix}`, name: base, path: candidate, copy });
    }
  }
  matched.sort((a, b) => a.clip.localeCompare(b.clip));
  skipped.sort((a, b) => a.clip.localeCompare(b.clip));
  return {
    ok: true,
    dir,
    matched,
    skipped,
    summary: { relink: matched.length, skip: skipped.length },
  };
}

/** @param {any} doc @param {string} id */
function findClip(doc, id) {
  for (const track of Array.isArray(doc?.tracks) ? doc.tracks : []) {
    for (const clip of Array.isArray(track?.clips) ? track.clips : []) if (clip.id === id) return clip;
  }
  return null;
}
