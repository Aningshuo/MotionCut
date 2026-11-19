/**
 * 工程摘要（WP18 `project info`）。
 *
 * **不是解析器**：输入必须是 main 的解析器已经产出的 `FilmDoc`。这里只做计数
 * 与归一，字段缺失就如实留空，绝不猜时间、不补默认值——猜出来的摘要在
 * 验收里就是假证据。
 */

/**
 * 片段的"种类"不在 `Clip` 里（合同没有 kind 字段），只能按轨道角色 + 源扩展名推断。
 * 这是**展示用**的粗略分类，写进输出时标 `heuristic`，不参与任何编辑判断。
 * @param {Record<string, any>} clip
 * @param {string} role
 * @returns {'video' | 'sound' | 'page' | 'still'}
 */
function inferKind(clip, role) {
  if (role === 'audio') return 'sound';
  if (role === 'page') return 'page';
  const src = typeof clip?.src === 'string' ? clip.src.toLowerCase() : '';
  if (/\.(png|jpe?g|webp|avif|gif|bmp|svg)(\?|#|$)/.test(src)) return 'still';
  return 'video';
}

/**
 * @param {any} doc FilmDoc | null
 * @param {ReadonlyArray<any>} diagnostics
 * @returns {{
 *   stage: { w: number, h: number } | null,
 *   fps: { num: number, den: number, value: number | null } | null,
 *   tracks: { total: number, byRole: Record<string, number>, locked: number, hidden: number, muted: number },
 *   clips: { total: number, byKind: Record<string, number> },
 *   diagnostics: { total: number, errors: number, warnings: number },
 * }}
 */
export function summarizeFilm(doc, diagnostics) {
  const tracks = Array.isArray(doc?.tracks) ? /** @type {any[]} */ (doc.tracks).filter((t) => t && typeof t === 'object') : [];
  const byRole = { picture: 0, audio: 0, subtitle: 0, page: 0 };
  const byKind = { video: 0, sound: 0, page: 0, still: 0 };

  let total = 0;
  let locked = 0;
  let hidden = 0;
  let muted = 0;

  for (const track of tracks) {
    const role = typeof track.role === 'string' ? track.role : 'picture';
    if (role in byRole) byRole[/** @type {keyof typeof byRole} */ (role)] += 1;
    if (track.locked === true) locked += 1;
    if (track.hidden === true) hidden += 1;
    if (track.muted === true) muted += 1;

    const clips = Array.isArray(track.clips) ? track.clips : [];
    for (const clip of clips) {
      if (!clip || typeof clip !== 'object') continue;
      total += 1;
      byKind[inferKind(clip, role)] += 1;
    }
  }

  const stage =
    doc?.stage && Number.isFinite(doc.stage.w) && Number.isFinite(doc.stage.h)
      ? { w: doc.stage.w, h: doc.stage.h }
      : null;

  const fpsRaw = doc?.fps;
  const fps =
    fpsRaw && Number.isFinite(fpsRaw.num) && Number.isFinite(fpsRaw.den) && fpsRaw.den !== 0
      ? { num: fpsRaw.num, den: fpsRaw.den, value: Math.round((fpsRaw.num / fpsRaw.den) * 1e6) / 1e6 }
      : null;

  const list = Array.isArray(diagnostics) ? diagnostics : [];
  const errors = list.filter((d) => d?.severity === 'error').length;

  return {
    stage,
    fps,
    tracks: { total: tracks.length, byRole, locked, hidden, muted },
    clips: { total, byKind },
    diagnostics: { total: list.length, errors, warnings: list.length - errors },
  };
}
