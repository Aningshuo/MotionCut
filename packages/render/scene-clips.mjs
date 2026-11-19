/**
 * 场景片段（`kind: 'page'`）在导出侧的表达与前置检查（P27）。
 *
 * ## 场景片段在计划里长什么样（**不发明新属性**）
 *
 * `film.html` 侧只允许合同里已有的东西：
 *
 * ```html
 * <section>
 *   <iframe id="scene-a" src="scene.html#t=0,8" at="0" size="1280x720"
 *           style="left: 0px; top: 0px; width: 1280px; height: 720px; opacity: 0.5"></iframe>
 * </section>
 * ```
 *
 * `film-plan.mjs` 把它翻成 `plan.sceneClips[]`，字段逐个对应：
 *
 * | 计划字段 | 来自 | 语义 |
 * |---|---|---|
 * | `id` | `id` | 片段 id，也是场景文档里 `frame()` 的寻址键 |
 * | `src` | `src`（含 `#t=`） | 相对工程根的页面路径；`#t=in,out` 是**源时间**窗口 |
 * | `at` | `at` | 片段在成片时间线上的起点（已减去 `--range` 起点） |
 * | `time` | `src` 的 `#t=` | `[inSec, outSec]`；没有 `#t=` 时是 `null`（整段时间线都在） |
 * | `trackIndex` | 所在 `<section>` 的序号 | 层序，0 是最上层（与 `visualClips` 同规则） |
 * | `requiresStage` | 计算得出 | 这一段**必须**由舞台逐帧画，ffmpeg 合成路径画不了 |
 *
 * 位置/尺寸/透明度/淡入淡出**不在这里**：它们由 `style` + `overrides.fade` 表达，
 * 由舞台（`content-origin` 的 `frame(t)`）自己应用。本包只负责「按帧把舞台截下来」，
 * 不重算一套摆放——重算就会和预览分叉。
 *
 * **iframe 内的时间映射**：舞台在 `t` 时刻调场景文档自己的 `window.film.frame(t')`，
 * `t'` 是**片段内时间**（`t - at + time[0]`）。这是舞台的职责，本包不碰；
 * 本包只等外层 `window.film.frame(t)` resolve（内部已经等 media seeked + 两帧 rAF）
 * 再截图——这就是 R11「暂停态 seek 不一定回调」那条教训的落点。
 *
 * ## 前置检查为什么在**开浏览器之前**
 *
 * 缺文件/跨源这类问题，等舞台跑起来才发现的话，用户要等 3 分钟才知道少了一个 html，
 * 而且报出来的是 `NO_FILM`（"场景没有 film"），跟真正的原因差着两层。所以先把
 * `src` 解析成本地路径并 `stat` 一遍，失败就直接 `SCENE_CAPTURE_FAILED`。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export const SCENE_CLIPS_VERSION = '1.0.0';

/** 场景取帧失败的统一错误码（默认**中止**，绝不静默出黑帧）。 */
export const SCENE_CAPTURE_FAILED = 'SCENE_CAPTURE_FAILED';

/**
 * 失败原因分级。写进错误的 `reason`，宿主可以按它决定要不要提示用户去补文件。
 * @typedef {'missing-src' | 'missing-file' | 'not-a-file' | 'outside-project' | 'cross-origin' | 'unsupported-src' | 'capture-failed'} SceneFailureReason
 */

export class SceneClipError extends Error {
  /** @type {SceneFailureReason | undefined} */
  reason;
  /** @type {string | undefined} */
  causeCode;
  /** @type {string | undefined} */
  clipId;
  /** @type {string | undefined} */
  src;
  /** @type {string | undefined} */
  path;
  /** @type {number | undefined} */
  t;

  /**
   * @param {string} detail
   * @param {{ clipId?: string, src?: string, reason?: SceneFailureReason, path?: string, causeCode?: string, t?: number }} [extra]
   */
  constructor(detail, extra = {}) {
    super(`${SCENE_CAPTURE_FAILED}: ${detail}`);
    this.name = 'SceneClipError';
    this.code = SCENE_CAPTURE_FAILED;
    this.detail = detail;
    Object.assign(this, extra);
  }
}

/**
 * 把 `src` 拆成「路径 + #t= 窗口」，不猜任何别的东西。
 * @param {string} src
 * @returns {{ pathname: string, hash: string }}
 */
export function splitSceneSrc(src) {
  const text = String(src ?? '');
  const cut = text.indexOf('#');
  if (cut < 0) return { pathname: text, hash: '' };
  return { pathname: text.slice(0, cut), hash: text.slice(cut + 1) };
}

/**
 * 判断这个 src 指到哪里。
 * @param {string} src
 * @returns {'empty' | 'cross-origin' | 'file' | 'absolute-file'}
 */
export function classifySceneSrc(src) {
  const { pathname } = splitSceneSrc(src);
  const value = pathname.trim();
  if (value === '') return 'empty';
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return 'cross-origin';
  if (value.startsWith('//')) return 'cross-origin';
  if (path.isAbsolute(value)) return 'absolute-file';
  return 'file';
}

/**
 * 解析一个场景片段，返回它指向的本地文件。
 * 只做解析，不碰磁盘（测试里好断言）。
 * @param {{ id?: string, src?: string }} clip
 * @param {{ projectRoot: string }} opts
 * @returns {{ clipId: string, src: string, path: string, relative: string }}
 */
export function resolveSceneClip(clip, opts) {
  const clipId = String(clip?.id ?? '?');
  const src = String(clip?.src ?? '');
  const kind = classifySceneSrc(src);
  if (kind === 'empty') {
    throw new SceneClipError(`scene clip ${clipId} has no src`, { clipId, src, reason: 'missing-src' });
  }
  if (kind === 'cross-origin') {
    throw new SceneClipError(
      `scene clip ${clipId} points at ${src}, which is not inside the project: ` +
        'a remote page cannot be time-driven by frame(t), so exporting it would silently produce wrong frames',
      { clipId, src, reason: 'cross-origin' },
    );
  }
  const projectRoot = path.resolve(opts.projectRoot);
  const relative = splitSceneSrc(src).pathname;
  const resolved = path.resolve(projectRoot, relative);
  const inside = resolved === projectRoot || resolved.startsWith(`${projectRoot}${path.sep}`);
  if (!inside) {
    throw new SceneClipError(`scene clip ${clipId} escapes the project root: ${relative}`, {
      clipId,
      src,
      reason: 'outside-project',
      path: resolved,
    });
  }
  return { clipId, src, path: resolved, relative };
}

/**
 * 前置检查：所有场景片段的 `src` 都必须是工程内**真实存在的文件**。
 *
 * 失败即抛 `SCENE_CAPTURE_FAILED`（默认中止）。理由：缺一个场景文件时，
 * 唯一"能出片"的做法是拿黑帧顶替，而成片里没人看得出少了一段——这比失败更糟。
 *
 * @param {any} plan
 * @param {{ projectRoot: string }} opts
 * @returns {Promise<{ clips: Array<{ clipId: string, src: string, path: string, relative: string, time: number[] | null, requiresStage: boolean }> }>}
 */
export async function assertSceneClipsReady(plan, opts) {
  const clips = Array.isArray(plan?.sceneClips) ? plan.sceneClips : [];
  /** @type {Array<{ clipId: string, src: string, path: string, relative: string, time: number[] | null, requiresStage: boolean }>} */
  const ready = [];
  for (const clip of clips) {
    const resolved = resolveSceneClip(clip, opts);
    /** @type {import('node:fs').Stats | null} */
    let stat = null;
    try {
      stat = await fs.stat(resolved.path);
    } catch {
      throw new SceneClipError(
        `scene clip ${resolved.clipId} is missing: ${resolved.relative} does not exist under the project`,
        { clipId: resolved.clipId, src: resolved.src, reason: 'missing-file', path: resolved.path },
      );
    }
    if (!stat.isFile()) {
      throw new SceneClipError(`scene clip ${resolved.clipId}: ${resolved.relative} is not a file`, {
        clipId: resolved.clipId,
        src: resolved.src,
        reason: 'not-a-file',
        path: resolved.path,
      });
    }
    ready.push({
      clipId: resolved.clipId,
      src: resolved.src,
      path: resolved.path,
      relative: resolved.relative,
      time: Array.isArray(clip?.time) ? [Number(clip.time[0]), Number(clip.time[1])] : null,
      requiresStage: clip?.requiresStage === true,
    });
  }
  return { clips: ready };
}

/**
 * 舞台取帧抛出来的错误 → 统一的 `SCENE_CAPTURE_FAILED`。
 *
 * 为什么要收口：`NO_FILM` / `FRAME_THREW` / `FRAME_TIMEOUT` / `STAGE_BOOT_FAILED` /
 * `PROJECT_NOT_OPEN` 都是"这一层"的实现细节，对用户是同一件事——场景没画出来。
 * 但**不能丢**：原码与原文案写进 `causeCode` / message，排障时仍然看得到到底是哪一类。
 *
 * @param {any} err
 * @param {{ clipIds?: string[] }} [context]
 * @returns {SceneClipError | any} 不是取帧错误就原样返回
 */
export function wrapSceneCaptureError(err, context = {}) {
  const code = typeof err?.code === 'string' ? err.code : null;
  const stageCodes = new Set([
    'NO_FILM',
    'FRAME_THREW',
    'FRAME_TIMEOUT',
    'STAGE_BOOT_FAILED',
    'PROJECT_NOT_OPEN',
  ]);
  if (code === null || !stageCodes.has(code)) return err;
  const clips = Array.isArray(context.clipIds) && context.clipIds.length > 0 ? context.clipIds.join(', ') : '(unknown)';
  const where = err?.clipId ? ` clip ${err.clipId}` : '';
  const detail = String(err?.detail ?? err?.message ?? err);
  return new SceneClipError(`scene capture failed for ${clips}${where}: ${detail}`, {
    reason: 'capture-failed',
    causeCode: code,
    ...(err?.clipId ? { clipId: String(err.clipId) } : {}),
    ...(Number.isFinite(err?.t) ? { t: err.t } : {}),
  });
}
