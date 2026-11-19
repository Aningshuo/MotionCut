import { createHash } from 'node:crypto';
import { analyze } from '../../film-core/film-doc.mjs';
import { findClipOf } from '../../film-core/track-audio.mjs';
import { isClipDisabled } from '../../film-core/clip-state.mjs';
import { listAppliedTransitions } from '../../film-core/transition-presets.mjs';

/** @param {string} code @param {string} message */
const rejected = (code, message) => /** @type {const} */ ({ ok: false, code, message });

/**
 * Isolate a page clip without modifying its source, stage size, layer overrides, or relative asset paths.
 * The same snapshot feeds both the render plan and every capture channel.
 * @param {{ text: string, clipId: string, expectedHash: string }} input
 */
export function prepareClipExport({ text, clipId, expectedHash }) {
  const source = analyze(text);
  if (source.sourceHash !== expectedHash) return rejected('CONFLICT', '工程已更新，请刷新后重新导出片段');
  if (source.doc === null) return rejected('FILM_INVALID', '工程存在无法导出的源文件错误');
  const target = findClipOf(source.doc, clipId);
  if (target === null) return rejected('CLIP_NOT_FOUND', '找不到待导出的片段');
  const { clip, track } = target;
  if (clip.kind !== 'page') return rejected('CLIP_EXPORT_UNSUPPORTED', '当前仅支持独立导出网页动效片段');
  if (track.hidden || isClipDisabled(clip)) return rejected('CLIP_NOT_VISIBLE', '请先启用该片段和所在轨道');
  const transitions = /** @type {{from: string, to: string}[]} */ (listAppliedTransitions(source.doc));
  if (transitions.some(({ from, to }) => from === clipId || to === clipId)) {
    return rejected('CLIP_TRANSITION_ACTIVE', '该片段的转场依赖相邻素材，请移除转场或导出工程区间');
  }
  const at = clip.at ?? 0;
  const sourceIn = Number(clip.time?.[0]), sourceOut = Number(clip.time?.[1]);
  const end = at + (sourceOut - sourceIn) / (clip.speed ?? 1);
  if (!(Number.isFinite(end) && end > at)) return rejected('CLIP_DURATION_UNKNOWN', '请先为网页动效设置有效的起止时间');

  // Delete only other managed media nodes. Keep the selected element byte-for-byte and
  // preserve the authored head, wrapper sections, and source URLs.
  let cursor = 0;
  const removed = [...source.elements.values()]
    .filter((entry) => entry.clipId !== clipId)
    .sort((a, b) => a.start - b.start);
  const parts = removed.map(({ start, end }) => {
    const part = text.slice(cursor, start);
    cursor = end;
    return part;
  });
  const isolated = [...parts, text.slice(cursor)].join('');
  const hash = createHash('sha256').update(isolated).digest('hex');
  const doc = {
    ...source.doc,
    sourceHash: hash,
    tracks: source.doc.tracks.map((lane) => ({ ...lane, clips: lane.clips.filter(({ id }) => id === clipId) })),
  };
  return {
    ok: /** @type {const} */ (true),
    range: /** @type {[number, number]} */ ([at, end]),
    snapshot: { doc, text: isolated, hash },
  };
}
