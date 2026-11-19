/** Browser-only clip styles must never disappear through a media-only export. */
/** @param {any} clip @returns {string} */
export function creationClipStyle(clip) {
  const value = typeof clip?.style === 'string' ? clip.style : clip?.attrs?.style;
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Accept either the source FilmDoc or a serialized render plan. Keep the CSS
 * itself with the plan so a caller cannot lose this requirement by serializing.
 * Geometry already represented as box/fade stays on its existing fast path;
 * arbitrary inline CSS (including filter/backdrop-filter) uses the real stage.
 * @param {any} value @returns {boolean}
 */
export function requiresCreationStyleStage(value) {
  if (Array.isArray(value?.tracks)) return value.tracks.some((/** @type {any} */ track) => track.hidden !== true && (track.clips ?? []).some((/** @type {any} */ clip) => clip.kind !== 'sound' && clip.hidden !== true && creationClipStyle(clip) !== ''));
  return [...(value?.visualClips ?? []), ...(value?.sceneClips ?? [])].some((clip) => clip.kind !== 'sound' && clip.hidden !== true && creationClipStyle(clip) !== '');
}
