/**
 * 多选批量分离音频（S72 · NEW-01）。
 *
 * 单条分离已经存在（检查器里的 `splitAudio` → `planSplitAudioOps` → 一条 `insert`）。
 * 这里补的是「多选 ≥2」：每个**确认有音轨**的视频各规划一条 `insert`，**合并成一个 ops 数组**，
 * 由调用方一次 `/ops` 提交——一次请求 = 一个批次 = 一步撤销回原。
 *
 * ## 为什么先筛再合并
 *
 * `insert` 的合法性依赖当时的 doc（id 撞车、区间、孪生判定）。批量里前一条 `insert` 会改变
 * 后一条的可用 id，所以这里维护一份 **working doc**（`applyOps` 渐进应用），逐条规划。
 * 不这么做的话，两个片段派生出同一个 `<id>-audio` 时会整批 400。
 *
 * ## 跳过必须写原因（不许静默少做）
 *
 * 四类：已分离 / 无音轨 / 读不出区间 / 非视频。每条都带 `clipId + code + reason`，
 * 上层把整张表展示出来。`hasAudio` 看不到时按「无音轨（素材未确认）」处理，不猜。
 */

import { applyOps } from '../../../../film-core/ops.mjs';
import { audioSplitOf, bareSrcOf, findClipOf, planSplitAudioOps } from '../../../../film-core/track-audio.mjs';

/**
 * 跳过原因的人话标签（UI 与证据共用，避免两处措辞漂移）。
 * `planSplitAudioOps` 失败时可能给出这四个之外的 code，取不到就原样用 code。
 */
export const DETACH_SKIP_LABEL = Object.freeze({
  ALREADY_SPLIT: '已分离',
  NO_AUDIO: '无音轨',
  NO_TIME_SPAN: '读不出区间',
  NOT_VIDEO: '非视频',
  CLIP_NOT_FOUND: '找不到片段',
});

/** @param {string} code @returns {string} */
function labelOf(code) {
  return /** @type {Record<string, string>} */ (DETACH_SKIP_LABEL)[code] ?? code;
}

/**
 * 素材是否确认有音轨：`true` / `false` / `null`（列表里没有这个素材，不猜）。
 * @param {Array<{name?: string, hasAudio?: boolean}>} assets
 * @param {unknown} src
 * @returns {boolean|null}
 */
export function assetHasAudio(assets, src) {
  const bare = bareSrcOf(src);
  const asset = (Array.isArray(assets) ? assets : []).find((item) => `assets/${String(item?.name ?? '')}` === bare);
  if (asset === undefined) return null;
  return asset.hasAudio === true;
}

/**
 * @param {any} doc
 * @param {string[]} clipIds
 * @param {{assets?: Array<{name?: string, hasAudio?: boolean}>}} [options]
 * @returns {{
 *   ops: any[],
 *   items: Array<{clipId: string, status: 'done'|'skipped', code: string, label: string, reason: string, audioId?: string}>,
 *   done: number, skipped: number, opCount: number
 * }}
 */
export function planBatchDetach(doc, clipIds, options = {}) {
  const assets = Array.isArray(options?.assets) ? options.assets : [];
  /** @type {any} */
  let working = doc;
  /** @type {any[]} */
  const ops = [];
  /** @type {any[]} */
  const items = [];
  const seen = new Set();
  const ids = (Array.isArray(clipIds) ? clipIds : []).map((id) => String(id ?? '')).filter((id) => id !== '');

  for (const clipId of ids) {
    if (seen.has(clipId)) continue;
    seen.add(clipId);
    const found = findClipOf(working, clipId);
    if (found === null) {
      items.push({ clipId, status: 'skipped', code: 'CLIP_NOT_FOUND', label: DETACH_SKIP_LABEL.CLIP_NOT_FOUND, reason: '工程里没有这个片段' });
      continue;
    }
    const clip = found.clip;
    const state = audioSplitOf(working, clip);
    if (state.status === 'not-video') {
      items.push({ clipId, status: 'skipped', code: 'NOT_VIDEO', label: DETACH_SKIP_LABEL.NOT_VIDEO, reason: state.reason });
      continue;
    }
    if (state.status === 'split') {
      items.push({
        clipId,
        status: 'skipped',
        code: 'ALREADY_SPLIT',
        label: DETACH_SKIP_LABEL.ALREADY_SPLIT,
        reason: `已分离到 ${String(state.twin?.id ?? '')}`,
      });
      continue;
    }
    if (state.status === 'no-span') {
      items.push({ clipId, status: 'skipped', code: 'NO_TIME_SPAN', label: DETACH_SKIP_LABEL.NO_TIME_SPAN, reason: state.reason });
      continue;
    }
    if (assetHasAudio(assets, clip.src) !== true) {
      items.push({
        clipId,
        status: 'skipped',
        code: 'NO_AUDIO',
        label: DETACH_SKIP_LABEL.NO_AUDIO,
        reason: '素材未确认有音轨（探测不到音轨或素材不在列表里）',
      });
      continue;
    }
    const planned = planSplitAudioOps(working, clipId);
    if (!planned.ok) {
      items.push({ clipId, status: 'skipped', code: planned.code, label: labelOf(planned.code), reason: planned.message });
      continue;
    }
    ops.push(...planned.ops);
    /* 渐进应用：后一条的 id 分配要看到前一条插入的音频片段。 */
    working = applyOps(working, planned.ops);
    items.push({
      clipId,
      status: 'done',
      code: 'OK',
      label: '已分离',
      reason: `新增音频片段 ${planned.clipId}`,
      audioId: planned.clipId,
    });
  }

  const done = items.filter((item) => item.status === 'done').length;
  return { ops, items, done, skipped: items.length - done, opCount: ops.length };
}
