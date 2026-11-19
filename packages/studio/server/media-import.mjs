/**
 * 素材导入（M18 · B-MAIN-R9-009）+ 源升级后的覆盖重定位（M76 · B-MAIN-R30-037）。
 *
 * ## 导入
 *
 * 最小闭环：**复制进工程 `assets/`（不覆盖已有文件）→ 用 `insert` op 写 film.html**。
 * 写盘仍然只走 `registry.applyOps`（一条 Op、一份 CAS、一条历史），本模块不自己改文件。
 *
 * 两条入口共用同一段落盘逻辑：
 * - 桌面版：前端给**绝对源路径**，这里 `copyFile` 进 assets/；
 * - 浏览器兜底：前端读成 base64 传上来，这里写进 assets/（上限见 MAX_UPLOAD_BYTES）。
 *
 * v1.2.0 方言：片段用 `src="assets/…"`，源入出点写成 `src#t=in,out`（`time` 字段交给
 * film-core 的写入器展开），**不写任何 `data-*`**。
 *
 * ## reimport（M76 / WP16 的服务端入口）
 *
 * `revalidateOverrides`（`packages/layers/revalidate.mjs`）从副线1 交付起就有 4 个测试文件，
 * 但**服务端一次都没调过**——「源升级后人工覆盖还在」在产品里没有入口。`reimportSourceAsset`
 * 补的就是这条入口：读旧源（工程里现有的那份）+ 读新源（`sourceFile`）→ 逐条判
 * `KEPT/MOVED/GONE/AMBIGUOUS` → 只把结论写回 `film.html`。
 *
 * 四条边界（任务书 §2.1 逐条对应）：
 * - **单一真源**：`sourceFile` 与工程里的旧源都**只读**（前后 sha 必须一致），
 *   覆盖只写 `film.html` 的 `overrides` 属性，**不复制第二份源、不写旁挂覆盖库**；
 * - **不静默丢**：`GONE/AMBIGUOUS/DYNAMIC_LAYER` 全部进 `.film/conflicts/<assetId>-<ts>.json`，
 *   响应给条数与文件路径；
 * - **失败原子**：解析失败 / revalidate 抛错 / ops 失败 → `film.html` 一个字节不变、
 *   conflicts 不落盘（conflicts 只在上面的写成功之后才写）；
 * - **幂等**：算出来的建议与当前覆盖逐字节相同 → `alreadyUpToDate:true`，不写盘；
 *   并发两次靠确定性 opId（同一批 Op 只落一次）收敛到一次写。
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';

import { clipKindOf } from '../../film-core/ops.mjs';
import { STATUS, revalidateOverrides, stampOf } from '../../layers/revalidate.mjs';
import { parseScene, resolveAt } from '../../layers/scene-tree.mjs';
import { probeMedia } from '../../render/verify.mjs';
import { checkRelPath, isInside } from './project-file.mjs';

/** 允许导入的扩展名 → 片段 kind（与 film-core 的 `clipKindOf` 同一张表，不另立一套）。 */
export const MEDIA_EXTENSIONS = Object.freeze([
  'mp4',
  'm4v',
  'mov',
  'webm',
  'mkv',
  'avi',
  'mp3',
  'wav',
  'm4a',
  'aac',
  'flac',
  'ogg',
  'opus',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'avif',
  'bmp',
]);

/** `POST /api/projects/:id/media` 的合法字段（未知字段一律 400）。 */
export const MEDIA_REQUEST_FIELDS = Object.freeze(['source', 'name', 'data', 'at', 'track']);

/** 浏览器上传模式的文件体上限（base64 之前的字节数）。 */
export const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;

/** 静帧没有 native 时长：给一个可读的默认值（4 秒），用户可以再拖。 */
export const DEFAULT_STILL_SECONDS = 4;

/** 素材总量上限（单个工程 assets/ 的粗略预算，超了直接 400 MEDIA_BUDGET）。 */
export const MAX_ASSET_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;

/** @param {string} name */
export function extensionOf(name) {
  const bare = String(name).split(/[?#]/)[0] ?? '';
  const index = bare.lastIndexOf('.');
  return index < 0 ? '' : bare.slice(index + 1).toLowerCase();
}

/**
 * 扩展名 → 片段 kind；不认识就 null（调用方给 `MEDIA_UNSUPPORTED`）。
 * @param {string} name
 * @returns {'video'|'sound'|'still'|null}
 */
export function mediaKindOf(name) {
  const ext = extensionOf(name);
  if (ext === '') return null;
  if (!MEDIA_EXTENSIONS.includes(ext)) return null;
  const kind = clipKindOf({ src: `assets/x.${ext}` });
  if (kind === 'video' || kind === 'sound' || kind === 'still') return kind;
  return null;
}

/** 文件名消毒：只留 basename，去掉控制字符与路径分隔符。 @param {string} name */
export function safeBaseName(name) {
  const base = path.basename(String(name).replace(/\\/g, '/'));
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim();
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'asset' : cleaned;
}

/**
 * `assets/` 里的不冲突文件名：`a.mp4` → `a-1.mp4` → `a-2.mp4`…
 * 绝不覆盖已有文件（同一个素材导入两次必须留下两份）。
 * @param {string} assetsDir
 * @param {string} baseName
 */
export async function uniqueAssetName(assetsDir, baseName) {
  const ext = path.extname(baseName);
  const stem = baseName.slice(0, baseName.length - ext.length);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const name = attempt === 0 ? baseName : `${stem}-${attempt}${ext}`;
    try {
      await fs.stat(path.join(assetsDir, name));
    } catch {
      return name;
    }
  }
  throw Object.assign(new Error(`assets 里同名文件过多：${baseName}`), { code: 'MEDIA_NAME_EXHAUSTED' });
}

/** 影片末尾（没有 at 时的默认落点）。 @param {any} doc */
export function filmEnd(doc) {
  let end = 0;
  for (const track of doc?.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      const at = Number(clip.at) || 0;
      const time = Array.isArray(clip.time) ? clip.time : null;
      const span = time === null ? 0 : Math.max(0, Number(time[1]) - Number(time[0]));
      end = Math.max(end, at + span);
    }
  }
  return Math.round(end * 1000) / 1000;
}

/** doc 里已经用掉的片段 id。 @param {any} doc */
function usedClipIds(doc) {
  const used = new Set();
  for (const track of doc?.tracks ?? []) for (const clip of track.clips ?? []) used.add(clip.id);
  return used;
}

/** @param {string} stem @param {Set<string>} used */
function freeClipId(stem, used) {
  const base = stem.replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'clip';
  if (!used.has(base)) return base;
  for (let attempt = 1; attempt < 500; attempt += 1) {
    const next = `${base}-${attempt}`;
    if (!used.has(next)) return next;
  }
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}

/** 素材目录当前占用（预算检查用）。 @param {string} assetsDir */
async function assetsBytes(assetsDir) {
  let total = 0;
  let names = [];
  try {
    names = await fs.readdir(assetsDir);
  } catch {
    return 0;
  }
  for (const name of names) {
    try {
      const stat = await fs.stat(path.join(assetsDir, name));
      if (stat.isFile()) total += stat.size;
    } catch {
      // 读不到就跳过：预算只是上限提示，不是权威统计。
    }
  }
  return total;
}

/**
 * 探一次就够：时长 + 有没有音轨（ffprobe 走一次，别为两件事各起一个进程）。
 * @param {string} file
 * @param {'video'|'sound'|'still'} kind
 * @returns {Promise<{ duration: number, hasAudio: boolean }>}
 */
async function describeMedia(file, kind) {
  if (kind === 'still') return { duration: DEFAULT_STILL_SECONDS, hasAudio: false };
  const probe = await probeMedia(file);
  const value = Number(probe?.format?.durationSec ?? probe?.video?.durationSec ?? probe?.audio?.durationSec);
  if (!Number.isFinite(value) || value <= 0) {
    throw Object.assign(new Error(`无法读出 ${path.basename(file)} 的时长`), { code: 'MEDIA_DURATION_UNKNOWN' });
  }
  return { duration: Math.round(value * 1000) / 1000, hasAudio: probe?.audio !== null && probe?.audio !== undefined };
}

/**
 * 导入一个素材：复制/落盘 → 探时长 → `insert` op → 返回新 hash 与片段 id。
 *
 * `materialize(destPath)` 由调用方给：路径模式 `copyFile`，上传模式 `writeFile`。
 *
 * @param {{
 *   registry: any,
 *   project: { projectId: string, dir: string },
 *   doc: any,
 *   name: string,
 *   materialize: (destPath: string) => Promise<void>,
 *   at?: number|null,
 *   track?: number|null,
 *   opIdPrefix?: string,
 * }} input
 * @returns {Promise<{ ok: true, hash: string, clipId: string, assetPath: string, kind: string, bytes: number, at: number }
 *   | { ok: false, code: string, message: string }>}
 */
export async function importMedia(input) {
  const kind = mediaKindOf(input.name);
  if (kind === null) {
    return {
      ok: false,
      code: 'MEDIA_UNSUPPORTED',
      message: `不支持的素材类型：${path.basename(input.name)}（允许 ${MEDIA_EXTENSIONS.join('/')}）`,
    };
  }

  const assetsDir = path.join(input.project.dir, 'assets');
  await fs.mkdir(assetsDir, { recursive: true });
  const baseName = safeBaseName(input.name);
  const assetName = await uniqueAssetName(assetsDir, baseName);
  const destPath = path.join(assetsDir, assetName);

  // 预算：先看现有 assets 大小，超上限就不落盘。
  const existing = await assetsBytes(assetsDir);
  if (existing > MAX_ASSET_BUDGET_BYTES) {
    return { ok: false, code: 'MEDIA_BUDGET', message: `工程 assets/ 已超过预算 ${MAX_ASSET_BUDGET_BYTES} 字节` };
  }

  try {
    await input.materialize(destPath);
  } catch (error) {
    const code = typeof /** @type {any} */ (error)?.code === 'string' ? /** @type {any} */ (error).code : 'MEDIA_COPY_FAILED';
    return { ok: false, code, message: `写入 assets 失败：${String(/** @type {any} */ (error)?.message ?? error)}` };
  }

  let stat;
  try {
    stat = await fs.stat(destPath);
  } catch (error) {
    return { ok: false, code: 'MEDIA_COPY_FAILED', message: String(/** @type {any} */ (error)?.message ?? error) };
  }
  /** @type {{ duration: number, hasAudio: boolean }} */
  let info;
  try {
    info = await describeMedia(destPath, kind);
  } catch (error) {
    await fs.unlink(destPath).catch(() => {});
    const code = typeof /** @type {any} */ (error)?.code === 'string' ? /** @type {any} */ (error).code : 'MEDIA_DURATION_UNKNOWN';
    return { ok: false, code, message: String(/** @type {any} */ (error)?.message ?? error) };
  }
  const duration = info.duration;

  const built = buildInsertOp({
    doc: input.doc,
    assetName,
    kind,
    duration,
    hasAudio: info.hasAudio,
    at: input.at,
    track: input.track,
  });
  const { clipId, at, op } = built;
  const current = input.registry.docOf(input.project.projectId);
  if (current === null) {
    await fs.unlink(destPath).catch(() => {});
    return { ok: false, code: 'FILM_NOT_FOUND', message: '工程未打开' };
  }

  const result = await input.registry.applyOps(
    input.project.projectId,
    {
      opId: `${input.opIdPrefix ?? 'media'}:${crypto.randomBytes(4).toString('hex')}`,
      expectedHash: current.hash,
      by: 'person',
    },
    [op],
  );
  if (result?.ok !== true) {
    // Op 失败就把刚复制进来的文件撤掉：磁盘上不留一个没人引用的素材。
    await fs.unlink(destPath).catch(() => {});
    return {
      ok: false,
      code: typeof result?.code === 'string' ? result.code : 'MEDIA_OP_FAILED',
      message: typeof result?.message === 'string' ? result.message : '写入 film.html 失败',
    };
  }

  return {
    ok: true,
    hash: String(result.hash ?? ''),
    clipId,
    assetPath: `assets/${assetName}`,
    kind,
    bytes: stat.size,
    at,
  };
}

/**
 * 构造一条「把 assets/ 里已有文件插进时间线」的 insert op。
 *
 * 素材库（M20）与导入（M18）共用这一份：id 分配、`#t=0,duration` 的整段、无音轨视频静音。
 * 不复制文件——调用方保证 `assetName` 已经在 assets/ 里。
 *
 * @param {{
 *   doc: any,
 *   assetName: string,
 *   kind: 'video'|'sound'|'still',
 *   duration: number,
 *   hasAudio?: boolean,
 *   at?: number|null,
 *   track?: number|null,
 * }} input
 * @returns {{ clipId: string, at: number, op: any }}
 */
export function buildInsertOp(input) {
  const used = usedClipIds(input.doc);
  const stem = path.basename(input.assetName, path.extname(input.assetName));
  const clipId = freeClipId(stem, used);
  /**
   * 没给 at（`null` / `undefined`）= 接在影片末尾。
   *
   * **这里曾经有个坑**：`Number(null) === 0` 且 `Number.isFinite(0) === true`，
   * 于是「不指定 at」被当成「at = 0」，连着导入两个素材会**全部堆在 0 秒重叠**
   * （实测：两个 video 都没有 at 属性，后一个把前一个整个盖住，时间线上点不中）。
   * 现在先显式挡掉 null/undefined，再判数值。
   */
  const at =
    input.at !== null && input.at !== undefined && Number.isFinite(Number(input.at)) && Number(input.at) >= 0
      ? Math.round(Number(input.at) * 1000) / 1000
      : filmEnd(input.doc);

  /** @type {any} */
  const clip = {
    id: clipId,
    src: `assets/${input.assetName}`,
    // 源入出点整段给足：没有 #t= 的话时间线里长度是 0，用户看不到它。
    time: [0, input.duration],
  };
  if (at !== 0) clip.at = at;
  // 没有音轨的视频静音（避免一堆空音轨参与混音）；纯音频片段的 muted 无意义，不写。
  if (input.kind === 'video' && input.hasAudio !== true) clip.muted = true;

  const op = {
    op: 'insert',
    clip,
    ...(Number.isInteger(input.track) && Number(input.track) >= 0 ? { track: Number(input.track) } : {}),
  };
  return { clipId, at, op };
}

/** 目录是否存在（上传/路径两种模式共用的小工具）。 @param {string} file */
export function fileExistsSync(file) {
  try {
    return fssync.statSync(file).isFile();
  } catch {
    return false;
  }
}

/* ────────────────────────── M76：源升级后的覆盖重定位 ────────────────────────── */

/** `POST /api/projects/:id/media/:assetId/reimport` 的合法字段。 */
export const REIMPORT_REQUEST_FIELDS = Object.freeze(['sourceFile', 'expectedHash']);

/** 冲突留档目录（与 `layers/revalidate.mjs` 的 `CONFLICT_DIR` 同一个值，这里显式写死便于断言）。 */
export const REIMPORT_CONFLICT_DIR = '.film/conflicts';

/** 冲突留档的批次名（写进文件内容，便于回溯是哪一批产出的）。 */
export const REIMPORT_BATCH = 'B-MAIN-R30-037';

/**
 * @typedef {{ ok: false, status: number, code: string, message: string }} ReimportFailure
 * @typedef {{ ok: true, rel: string, abs: string, html: string, sha256: string, bytes: number }} SourceRead
 */

/**
 * 失败时统一形状（路由直接按 status 回）。
 * @param {number} status @param {string} code @param {string} message
 * @param {Record<string, unknown>} [extra]
 * @returns {ReimportFailure & Record<string, unknown>}
 */
function failed(status, code, message, extra = {}) {
  return { ok: false, status, code, message, ...extra };
}

/** @param {string} text */
function shaOfText(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** 递归排键序列化：比较两份覆盖集合时不能因为键序不同就判「变了」。 @param {unknown} value */
function canonical(value) {
  /** @param {unknown} v @returns {unknown} */
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === 'object') {
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const key of Object.keys(/** @type {Record<string, unknown>} */ (v)).sort()) {
        out[key] = sort(/** @type {Record<string, unknown>} */ (v)[key]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/** @param {any} doc @returns {{clip: any, track: number}[]} */
function clipsOf(doc) {
  /** @type {{clip: any, track: number}[]} */
  const out = [];
  for (const track of doc?.tracks ?? []) {
    for (const clip of track.clips ?? []) out.push({ clip, track: Number(track.index) || 0 });
  }
  return out;
}

/** 片段 src 去掉 `#t=…` / `?query` 的部分。 @param {any} clip */
export function sourcePathOf(clip) {
  const raw = typeof clip?.src === 'string' ? clip.src : '';
  return (raw.split('#')[0] ?? '').split('?')[0] ?? '';
}

/** 路径最后一段（`pages/scene.html` → `scene.html`）。 @param {string} value */
function baseNameOf(value) {
  const parts = String(value).split('/');
  return parts[parts.length - 1] ?? '';
}

/**
 * `:assetId` 的解析规则（明确写死，两种读法都收）：
 * 1. 与某个片段 **id 完全相同** → 只处理那个片段；
 * 2. 否则与片段 `src` 的**文件名**相同（`assets/scene.html` / `pages/scene.html` 都算）
 *    → 处理所有引用这份源的片段（同一模板实例化两次时两条都要重定位）。
 *
 * @param {any} doc @param {string} assetId
 * @returns {{clip: any, track: number}[]}
 */
export function resolveAssetClips(doc, assetId) {
  const all = clipsOf(doc);
  const byId = all.filter((item) => item.clip?.id === assetId);
  if (byId.length > 0) return byId;
  return all.filter((item) => baseNameOf(sourcePathOf(item.clip)) === assetId);
}

/**
 * 读工程里**现有**的源文档（只读）：相对路径守卫 → realpath 前缀校验 → 文本 + sha。
 * @param {string} projectDir @param {any} clip
 * @returns {Promise<SourceRead|ReimportFailure>}
 */
async function readProjectSource(projectDir, clip) {
  const rel = sourcePathOf(clip);
  if (rel === '') {
    return failed(400, 'SOURCE_NOT_HTML', `片段 ${clip?.id} 没有 src，无法定位源文档`);
  }
  const checked = checkRelPath(rel);
  if (checked.ok !== true) {
    return failed(400, checked.code, `${clip?.id} 的 src 不是合法工程相对路径：${rel}`);
  }
  if (!/\.html?$/i.test(checked.rel)) {
    return failed(400, 'SOURCE_NOT_HTML', `片段 ${clip?.id} 的源不是 HTML 文档：${checked.rel}`);
  }
  const root = path.resolve(projectDir);
  const target = path.resolve(root, checked.rel);
  if (!isInside(root, target)) {
    return failed(400, 'E_PATH_ESCAPE', `源文档越界：${checked.rel}`);
  }
  try {
    const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
    if (!isInside(realRoot, realTarget)) {
      return failed(400, 'E_PATH_ESCAPE', `源文档真实路径在工程外（符号链接）：${checked.rel}`);
    }
    const html = await fs.readFile(realTarget, 'utf8');
    return { ok: true, rel: checked.rel, abs: realTarget, html, sha256: shaOfText(html), bytes: Buffer.byteLength(html, 'utf8') };
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error)?.code;
    return failed(code === 'ENOENT' ? 404 : 400, code === 'ENOENT' ? 'SOURCE_NOT_FOUND' : 'SOURCE_UNREADABLE', `源文档读不到：${checked.rel}`);
  }
}

/**
 * 把「一批覆盖条目」摊平成响应/证据要的逐条表。
 * @param {string} clipId @param {any[]} entries
 */
function entryRowsOf(clipId, entries) {
  return (Array.isArray(entries) ? entries : []).map((entry) => ({
    clipId,
    at: entry.at,
    status: entry.status,
    reason: entry.reason,
    newAt: entry.newAt ?? null,
    ...(Array.isArray(entry.candidates) && entry.candidates.length > 0 ? { candidates: entry.candidates } : {}),
  }));
}

/**
 * 预写冲突留档：内容先落到 `.film/` 里的**隐藏临时文件**（fsync），
 * 等 `film.html` 写成功之后才 rename 进 `.film/conflicts/`。
 *
 * 这样两条判据同时成立：失败时 `.film/conflicts/` 根本不存在；成功时数据已经在盘上，
 * 不会出现「film.html 写成了，冲突记录却丢了」的半截状态。
 *
 * @param {string} projectDir @param {string} assetId @param {object} content
 */
async function stageConflictFile(projectDir, assetId, content) {
  const filmDir = path.join(projectDir, '.film');
  const text = `${JSON.stringify(content, null, 2)}\n`;
  const tempPath = path.join(filmDir, `.conflicts-tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`);
  try {
    await fs.mkdir(filmDir, { recursive: true });
    const handle = await fs.open(tempPath, 'wx');
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { ok: true, tempPath, text, bytes: Buffer.byteLength(text, 'utf8'), safeName: safeFileStem(assetId) };
  } catch (error) {
    return failed(500, 'CONFLICT_WRITE_FAILED', `冲突留档临时文件写不了：${String(/** @type {Error} */ (error)?.message ?? error)}`);
  }
}

/** 文件名里的 assetId：只留字母数字与 `._-`，其余换成 `_`。 @param {string} value */
function safeFileStem(value) {
  const cleaned = String(value).replace(/[^\w.-]+/g, '_').replace(/^[.-]+/, '').slice(0, 80);
  return cleaned === '' ? 'asset' : cleaned;
}

/**
 * 把临时冲突文件落成正式名字：`.film/conflicts/<assetId>-<ts>.json`（同名加 `-2`、`-3`…）。
 * @param {string} projectDir @param {string} tempPath @param {string} safeName @param {Date} now
 * @returns {Promise<{ ok: true, file: string, name: string }|ReimportFailure>}
 */
async function commitConflictFile(projectDir, tempPath, safeName, now) {
  const dir = path.join(projectDir, REIMPORT_CONFLICT_DIR);
  const stamp = stampOf(now);
  try {
    await fs.mkdir(dir, { recursive: true });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const name = attempt === 0 ? `${safeName}-${stamp}.json` : `${safeName}-${stamp}-${attempt}.json`;
      const finalPath = path.join(dir, name);
      try {
        await fs.rename(tempPath, finalPath);
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error)?.code === 'EEXIST') continue;
        throw error;
      }
      try {
        const handle = await fs.open(dir, 'r');
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch {
        // 目录 fsync 失败不改结论：文件已经 rename 进去了。
      }
      return { ok: true, file: `${REIMPORT_CONFLICT_DIR}/${name}`, name };
    }
    return failed(500, 'CONFLICT_WRITE_FAILED', '同名冲突文件过多');
  } catch (error) {
    return failed(500, 'CONFLICT_WRITE_FAILED', `冲突留档 rename 失败：${String(/** @type {Error} */ (error)?.message ?? error)}`);
  }
}

/**
 * 源升级后重定位覆盖（M76 · WP16 的服务端入口）。
 *
 * @param {{
 *   registry: any,
 *   project: { projectId: string, dir: string },
 *   doc: any,
 *   assetId: string,
 *   sourceFile: string,
 *   expectedHash?: string,
 *   now?: Date|number,
 * }} input
 * @returns {Promise<any>}
 */
export async function reimportSourceAsset(input) {
  const assetId = typeof input.assetId === 'string' ? input.assetId : '';
  if (assetId === '' || assetId.includes('/') || assetId.includes('\\')) {
    return failed(400, 'ASSET_ID_INVALID', 'assetId 不能为空，也不能包含路径分隔符');
  }
  const current = input.registry.docOf(input.project.projectId);
  if (current === null) return failed(404, 'FILM_NOT_FOUND', '工程未打开');

  const targets = resolveAssetClips(input.doc ?? current.doc, assetId);
  if (targets.length === 0) {
    return failed(404, 'ASSET_NOT_FOUND', `没有片段引用这个素材：${assetId}`);
  }

  /* ── 新源（只读；可以是工程外的路径，绝不复制进工程） ───────────────── */
  const sourceFile = typeof input.sourceFile === 'string' ? input.sourceFile : '';
  if (sourceFile === '') {
    return failed(400, 'SOURCE_PATH_REQUIRED', 'sourceFile 必填');
  }
  if (!path.isAbsolute(sourceFile)) {
    return failed(400, 'SOURCE_PATH_NOT_ABSOLUTE', `sourceFile 必须是绝对路径：${sourceFile}`);
  }
  if (!/\.html?$/i.test(sourceFile)) {
    return failed(400, 'SOURCE_NOT_HTML', `sourceFile 不是 HTML 文档：${sourceFile}`);
  }
  /** @type {string} */
  let newHtml;
  /** @type {{ sha256: string, bytes: number }} */
  let newSource;
  try {
    const realNew = await fs.realpath(sourceFile);
    newHtml = await fs.readFile(realNew, 'utf8');
    newSource = { sha256: shaOfText(newHtml), bytes: Buffer.byteLength(newHtml, 'utf8') };
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error)?.code;
    return failed(code === 'ENOENT' ? 404 : 400, code === 'ENOENT' ? 'SOURCE_NOT_FOUND' : 'SOURCE_UNREADABLE', `sourceFile 读不到：${sourceFile}`);
  }

  /* CAS：给了 expectedHash 就先比一次（真正的互斥仍在 ops 里）。 */
  if (typeof input.expectedHash === 'string' && input.expectedHash !== '' && input.expectedHash !== current.hash) {
    return failed(409, 'CONFLICT', 'expectedHash 与当前不符，未写入', { currentHash: current.hash });
  }

  /* ── 逐片段判：旧源 = 工程里现有的那份 ──────────────────────────────── */
  const newTree = parseScene(newHtml);
  /** @type {any[]} */
  const clips = [];
  /** @type {any[]} */
  const sources = [];
  /** @type {any[]} */
  const ops = [];
  /** @type {any[]} */
  const conflictEntries = [];
  const counts = { kept: 0, moved: 0, dropped: 0, ambiguous: 0, dynamic: 0, total: 0, own: 0 };
  /** @type {string[]} */
  const notes = [];

  for (const target of targets) {
    const clip = target.clip;
    const source = await readProjectSource(input.project.dir, clip);
    if (source.ok !== true) return source;
    sources.push({ clipId: clip.id, file: source.rel, sha256Before: source.sha256, sha256After: source.sha256, bytes: source.bytes });

    const before = Array.isArray(clip.overrides) ? clip.overrides : [];
    const report = revalidateOverrides({
      oldHtml: source.html,
      newHtml,
      overrides: before,
      now: input.now,
      conflictDir: REIMPORT_CONFLICT_DIR,
      batch: REIMPORT_BATCH,
    });
    if (report.treeError === 'TREE_INCOMPLETE') {
      return failed(422, 'TREE_INCOMPLETE', `源结构不完整（截断/坏标签），拒绝重定位：${source.rel}`, {
        clipId: clip.id,
        notes: report.notes,
      });
    }

    const next = report.suggestedOverrides;
    const entryRows = entryRowsOf(clip.id, report.entries);

    /*
     * 「`at` 在新源里能解析、在旧源里没有」= 这条覆盖本来就是按新源写的
     * （典型场景：上一次 reimport 已经把 at 改成了新路径，而工程里的旧源还没换）。
     * revalidate 按「旧源里找不到 → DYNAMIC_LAYER」会把它当冲突——那会在幂等重跑时
     * 反复报假冲突。这里逐条改判 KEPT（ALREADY_IN_NEW_SOURCE）：不动它、不报冲突。
     */
    /** @type {Set<string>} */
    const alreadyNew = new Set();
    for (const row of entryRows) {
      if (row.status !== STATUS.DYNAMIC_LAYER) continue;
      if (resolveAt(newTree, row.at) === null) continue;
      row.status = STATUS.KEPT;
      row.reason = 'ALREADY_IN_NEW_SOURCE';
      row.newAt = null;
      alreadyNew.add(row.at);
    }
    const reclassified = alreadyNew.size;
    const clipConflicts =
      report.conflict === null
        ? []
        : /** @type {any[]} */ (/** @type {any} */ (report.conflict).content.entries ?? [])
            .filter((entry) => !alreadyNew.has(entry.at))
            .map((entry) => ({ clipId: clip.id, ...entry }));

    counts.kept += report.stats.kept + reclassified;
    counts.moved += report.stats.moved;
    counts.dropped += report.stats.gone;
    counts.ambiguous += report.stats.ambiguous;
    counts.dynamic += report.stats.dynamic - reclassified;
    counts.total += report.stats.total;
    counts.own += report.stats.own;
    if (report.notes.length > 0) notes.push(...report.notes.map((note) => `${clip.id}:${note}`));
    conflictEntries.push(...clipConflicts);

    const same = canonical(before) === canonical(next);
    if (!same) ops.push({ op: 'set', clip: clip.id, field: 'overrides', value: next });

    clips.push({
      clipId: clip.id,
      track: target.track,
      source: source.rel,
      sourceSha256: source.sha256,
      kept: report.stats.kept + reclassified,
      moved: report.stats.moved,
      dropped: report.stats.gone,
      ambiguous: report.stats.ambiguous,
      dynamic: report.stats.dynamic - reclassified,
      alreadyInNewSource: reclassified,
      changed: !same,
      entries: entryRows,
      next,
    });
  }

  const base = {
    ok: true,
    assetId,
    source: { file: sourceFile, sha256: newSource.sha256, bytes: newSource.bytes },
    kept: counts.kept,
    moved: counts.moved,
    dropped: counts.dropped,
    conflicts: conflictEntries.length,
    conflictFile: /** @type {string|null} */ (null),
    filmHtmlSha256: current.hash,
    clips,
    sources,
    notes,
  };

  /* ── 没有任何变化：不写盘（幂等判据） ───────────────────────────────── */
  if (ops.length === 0) {
    return {
      ...base,
      changed: false,
      alreadyUpToDate: true,
      replayed: false,
      ops: 0,
      ...(conflictEntries.length > 0 ? { pendingConflicts: conflictEntries.length } : {}),
    };
  }

  /* ── 冲突留档先落临时文件（成功后才 rename 进 .film/conflicts/） ────── */
  const now = input.now === undefined ? new Date() : new Date(/** @type {any} */ (input.now));
  /** @type {{ok: true, tempPath: string, text: string, bytes: number, safeName: string}|null} */
  let staged = null;
  if (conflictEntries.length > 0) {
    const content = {
      kind: 'overrides',
      batch: REIMPORT_BATCH,
      assetId,
      clips: targets.map((item) => item.clip.id),
      oldSourceHash: sources.length === 1 ? sources[0]?.sha256Before : undefined,
      newSourceHash: newSource.sha256,
      counts: { ...counts, gone: counts.dropped },
      entries: conflictEntries,
    };
    const result = await stageConflictFile(input.project.dir, assetId, content);
    if (result.ok !== true) return result;
    staged = /** @type {any} */ (result);
  }

  /* ── 唯一写入口：一批 Op，一份 CAS，一条历史 ────────────────────────── */
  // opId 由**这批 Op 的内容**决定：并发两次同一个源算出来的 opId 相同 →
  // 第二次进 registry 的 opLog 直接回放（`replayed:true`），磁盘只写一次。
  const opId = `reimport:${assetId}:${shaOfText(JSON.stringify(ops))}`;
  const result = await input.registry.applyOps(
    input.project.projectId,
    {
      opId,
      // 调用方给了 expectedHash 才做 CAS；没给就不传（并发收敛靠上面的 opId，不靠猜旧 hash）。
      ...(typeof input.expectedHash === 'string' && input.expectedHash !== '' ? { expectedHash: input.expectedHash } : {}),
      by: 'person',
    },
    ops,
  );

  if (result?.ok !== true) {
    if (staged !== null) await fs.unlink(staged.tempPath).catch(() => undefined);
    const code = typeof result?.code === 'string' ? result.code : 'REIMPORT_FAILED';
    return failed(code === 'CONFLICT' ? 409 : 400, code, String(result?.message ?? '写回 film.html 失败'), {
      currentHash: result?.currentHash ?? current.hash,
      kept: counts.kept,
      moved: counts.moved,
      dropped: counts.dropped,
      conflicts: conflictEntries.length,
    });
  }

  /* ── 写成功了才把冲突留档放到位 ─────────────────────────────────────── */
  /** @type {string|null} */
  let conflictFile = null;
  if (staged !== null) {
    const committed = await commitConflictFile(input.project.dir, staged.tempPath, staged.safeName, now);
    if (committed.ok === true) conflictFile = committed.file;
    else {
      // 覆盖已经写进 film.html，但留档没落成：如实报错，不回滚 film.html（那会丢掉刚保住的东西）。
      notes.push(`CONFLICT_FILE_FAILED:${committed.code}`);
    }
  }

  /* ── 原素材 sha 复算：只读承诺必须可验 ──────────────────────────────── */
  for (const item of sources) {
    try {
      const text = await fs.readFile(path.join(input.project.dir, item.file), 'utf8');
      item.sha256After = shaOfText(text);
    } catch {
      item.sha256After = 'UNREADABLE';
    }
  }

  return {
    ...base,
    changed: result.changed === true,
    alreadyUpToDate: result.changed !== true,
    replayed: result.replayed === true,
    ops: ops.length,
    conflictFile,
    filmHtmlSha256: String(result.hash ?? current.hash),
    sources,
    notes,
  };
}
