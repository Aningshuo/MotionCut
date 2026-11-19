// @ts-nocheck -- Dynamic FilmDoc/Op JSON boundary, covered by persistence and inverse-operation tests.
/**
 * Original transition plans, stored in film.html's preserved data attributes.
 * No assets, database or second editor state: one plan is one existing Op batch.
 * The metadata records only fields we actually changed. Removal refuses a stale
 * snapshot, and unrelated manual styles/attributes are deliberately preserved.
 */
import { applyOpsDetailed } from './ops.mjs';
import { createTransitionRuntime, transitionFrame } from '../scene-runtime/transition-runtime.mjs';

export const TRANSITION_ATTRIBUTE = 'data-opencut-transition';
export const TRANSITION_PRESET_VERSION = 1;

const row = (slug, name, group, effect, mechanism = 'motion', extra = {}) => Object.freeze({
  id: `transition/${slug}`, name, group, kind: 'transition', category: 'transition',
  mechanism, effect, duration: 0.6, ...extra,
  capabilities: Object.freeze({ preview: true, export: true, seek: true, remove: true, editable: true }),
  parameters: Object.freeze({ duration: { min: 0.05, max: 3, default: 0.6, unit: 'seconds' } }),
});

/** Every advertised entry has a deterministic, distinct renderer. No placeholder cards. */
const PRESETS = Object.freeze([
  row('dissolve', '柔和叠接', '基础', 'dissolve', 'fade'),
  row('dip-black', '黑场换镜', '基础', 'dip-black', 'overlay'),
  row('dip-white', '亮场换镜', '基础', 'dip-white', 'overlay'),
  row('fade-in', '画面渐显', '基础', 'fade-in', 'fade', { single: true }),
  row('fade-out', '画面渐隐', '基础', 'fade-out', 'fade', { single: true }),
  ...['left', 'right', 'up', 'down'].map((direction, i) => row(`push-${direction}`, ['向左推进', '向右推进', '向上推进', '向下推进'][i], '位移', 'push', 'motion', { direction })),
  ...['left', 'right', 'up', 'down'].map((direction, i) => row(`slide-${direction}`, ['左侧滑入', '右侧滑入', '上方滑入', '下方滑入'][i], '位移', 'slide', 'motion', { direction })),
  ...['left', 'right', 'up', 'down'].map((direction, i) => row(`wipe-${direction}`, ['向左揭幕', '向右揭幕', '向上揭幕', '向下揭幕'][i], '遮罩', 'wipe', 'motion', { direction })),
  row('soft-wipe', '柔边揭幕', '遮罩', 'soft-wipe'),
  row('iris', '圆心展开', '遮罩', 'iris'),
  row('diamond', '菱心展开', '遮罩', 'diamond'),
  row('split-horizontal', '横向对开', '遮罩', 'split', 'motion', { direction: 'horizontal' }),
  row('split-vertical', '纵向对开', '遮罩', 'split', 'motion', { direction: 'vertical' }),
  row('zoom-in', '聚焦换镜', '镜头', 'zoom-in'),
  row('zoom-out', '退焦换镜', '镜头', 'zoom-out'),
  row('spin-cw', '顺旋换镜', '镜头', 'spin', 'motion', { direction: 'cw' }),
  row('spin-ccw', '逆旋换镜', '镜头', 'spin', 'motion', { direction: 'ccw' }),
  row('blur-dissolve', '虚化融接', '镜头', 'blur'),
  row('light-sweep', '斜光掠过', '光影', 'light-sweep', 'overlay'),
  row('flare', '暖光绽放', '光影', 'flare', 'overlay'),
  row('film-burn', '暖焰换幕', '光影', 'film-burn', 'overlay'),
  row('shutter', '快门合开', '图形', 'shutter', 'overlay'),
  row('blinds', '百叶换幕', '图形', 'blinds', 'overlay'),
  row('checker', '棋格翻幕', '图形', 'checker', 'overlay'),
  row('stripes', '斜纹换幕', '图形', 'stripes', 'overlay'),
  row('heart', '心形绽开', '图形', 'heart', 'overlay'),
  row('star', '星形绽开', '图形', 'star', 'overlay'),
  row('glitch', '错位闪切', '质感', 'glitch', 'overlay'),
  row('noise', '颗粒闪切', '质感', 'noise', 'overlay'),
  row('confetti', '彩片飞散', '图形', 'confetti', 'overlay'),
  row('pixels', '像素换幕', '图形', 'pixels', 'overlay'),
  row('ink', '墨团换幕', '质感', 'ink', 'overlay'),
]);
const BY_ID = new Map(PRESETS.map((p) => [p.id, p]));
const copy = (x) => structuredClone(x);
const round = (n) => Math.round(n * 1e6) / 1e6;
const failure = (code, message) => ({ ok: false, code, message, ops: [] });
const clipId = (x) => typeof x === 'string' ? x : x?.id;
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const snapshot = (clip) => Object.fromEntries(['at', 'fade', 'src', 'time', 'speed', 'link'].map((key) => [key, clip[key] === undefined ? null : copy(clip[key])]));
function all(doc) { return (doc?.tracks ?? []).flatMap((track) => (track.clips ?? []).map((clip) => ({ clip, track }))); }
function span(clip) {
  const at = Number(clip?.at ?? 0), speed = Number(clip?.speed ?? 1);
  const length = (Number(clip?.time?.[1]) - Number(clip?.time?.[0])) / speed;
  return Number.isFinite(at) && speed > 0 && length > 0 ? { at, end: at + length, length } : null;
}
function picture(clip) { return ['video', 'still', 'img', 'page', 'text'].includes(clip?.kind ?? 'video'); }
function fieldOps(records) {
  const ops = [], fades = [];
  for (const { id, fields } of records) {
    const kept = { ...fields };
    if (Object.hasOwn(kept, 'fade')) { fades.push({ clip: id, prop: 'fade', value: kept.fade }); delete kept.fade; }
    if (Object.keys(kept).length) ops.push({ op: 'fields', clip: id, fields: kept });
  }
  // props' existing setter keeps the fade projection and own override in sync.
  if (fades.length) ops.push({ op: 'props', edits: fades });
  return ops;
}

export function listTransitionPresets() { return PRESETS.map(copy); }
export function getTransitionPreset(id) { const p = BY_ID.get(id) ?? BY_ID.get(`transition/${id}`); return p ? copy(p) : null; }

/** Actual DOM/runtime sample, not a painted stand-in thumbnail. Caller may seek it. */
export function transitionPreviewHtml(presetId) {
  const demo = { stage: { w: 640, h: 360 }, fps: { num: 30, den: 1 }, tracks: [{ index: 0, role: 'picture', clips: [
    { id: 'preview-a', kind: 'still', src: 'preview-a.png', at: 0, time: [0, 1] },
    { id: 'preview-b', kind: 'still', src: 'preview-b.png', at: 1, time: [0, 1] },
  ] }] };
  const planned = planTransitionPreset({ doc: demo, presetId, from: 'preview-a', to: 'preview-b', duration: 0.6 });
  if (!planned.ok) return null;
  const changed = applyOpsDetailed(demo, planned.ops).value;
  const clips = all(changed).map(({ clip }) => ({ id: clip.id, at: clip.at ?? 0, length: 1 }));
  const data = JSON.stringify({ spec: planned.transition, clips, duration: Math.max(...clips.map(c => c.at + c.length)) }).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=640,height=360"><style>
html,body{margin:0;width:640px;height:360px;overflow:hidden;background:#11151a}body{position:relative;font-family:system-ui,sans-serif}.shot{position:absolute;inset:0;display:grid;place-items:center;overflow:hidden}.shot span{font-size:96px;font-weight:700;letter-spacing:-5px}.shot small{position:absolute;bottom:35px;left:38px;font-size:15px;letter-spacing:4px}.shot:before{content:'';position:absolute;width:260px;height:260px;border:32px solid #ffffff22;border-radius:50%;right:-65px;top:-70px}#preview-a{background:linear-gradient(130deg,#28685e,#112c3d);color:#e1e8d7}#preview-b{background:linear-gradient(130deg,#b2704d,#5d3147);color:#f4e9d3}#preview-b:before{border-radius:22px;transform:rotate(20deg)}</style></head><body>
<div id="preview-a" class="shot"><span>01</span><small>第一个画面</small></div><div id="preview-b" class="shot"><span>02</span><small>下一个画面</small></div>
<script>const data=${data};const runtime=(${createTransitionRuntime.toString()})(${transitionFrame.toString()});const clips=data.clips.map(c=>({...c,el:document.getElementById(c.id),kind:'still',baseOpacity:1,z:1}));document.getElementById('preview-b').setAttribute('data-opencut-transition',JSON.stringify(data.spec));window.film={meta:{width:640,height:360,duration:data.duration},ready:Promise.resolve(),frame(t){runtime.beforeFrame(clips);for(const c of clips)c.el.style.visibility=t>=c.at&&t<c.at+c.length?'visible':'hidden';runtime.apply(clips,t,{w:640,h:360},document);return true;}};window.film.frame(data.spec.start+data.spec.duration/2);</script></body></html>`;
}

export function transitionSpecOf(clip) {
  const raw = clip?.attrs?.[TRANSITION_ATTRIBUTE];
  if (typeof raw !== 'string' || raw.length > 32_768) return null;
  try {
    const spec = JSON.parse(raw);
    if (spec?.version !== TRANSITION_PRESET_VERSION || !BY_ID.has(spec.presetId) || typeof spec.id !== 'string' || !Array.isArray(spec.edits)) return null;
    if (!(Number.isFinite(spec.start) && Number.isFinite(spec.end) && spec.end > spec.start && spec.start >= 0)) return null;
    return spec;
  } catch { return null; }
}

/** A shared export decision, including pure-media projects with no page clips. */
export function requiresTransitionStage(value) {
  if (value?.requiresStage === true) return true;
  return all(value).some(({ clip, track }) => track.hidden !== true && transitionSpecOf(clip) !== null);
}

export function listAppliedTransitions(doc) {
  return all(doc).flatMap(({ clip }) => {
    const spec = transitionSpecOf(clip);
    return spec ? [{ id: spec.id, presetId: spec.presetId, name: BY_ID.get(spec.presetId).name,
      from: spec.from, to: spec.to, start: spec.start, end: spec.end, duration: spec.end - spec.start,
      mechanism: spec.mechanism, requiresStage: true }] : [];
  });
}

/** Resizing replaces the original plan in one batch, retaining its base snapshot. */
export function planResizeTransitionPreset({ doc, transitionId, to, duration } = {}) {
  const holder = all(doc).find(({ clip }) => {
    const s = transitionSpecOf(clip);
    return s && (transitionId ? s.id === transitionId : s.to === clipId(to));
  });
  const spec = holder && transitionSpecOf(holder.clip);
  return spec ? planTransitionPreset({ doc, presetId: spec.presetId, from: spec.from, to: spec.to, duration })
    : failure('TRANSITION_NOT_FOUND', '找不到要调节的转场');
}

/** Restore only our own fields; never overwrite edits made since the transition. */
export function planRemoveTransitionPreset({ doc, transitionId, to, presetId } = {}) {
  const entries = all(doc);
  const holder = entries.find(({ clip }) => {
    const s = transitionSpecOf(clip);
    return s && (transitionId ? s.id === transitionId : to ? s.to === clipId(to) : presetId ? s.presetId === presetId : false);
  });
  if (!holder) return failure('TRANSITION_NOT_FOUND', '找不到要移除的转场，请重新选中接缝');
  const spec = transitionSpecOf(holder.clip);
  const restoreFields = [];
  for (const edit of spec.edits) {
    const found = entries.find(({ clip }) => clip.id === edit.id);
    if (!found) return failure('TRANSITION_STALE', '转场片段已移除，请先重新读取工程');
    if (found.track.locked === true) return failure('LOCKED', `轨道已锁定：${edit.id}`);
    if (!same(snapshot(found.clip), edit.after)) return failure('TRANSITION_BASE_CONFLICT', `片段 ${edit.id} 已在转场后修改；保留人工修改，请先撤销该修改或重新建接缝`);
    restoreFields.push({ id: edit.id, fields: copy(edit.beforeFields) });
  }
  const attrs = { ...(holder.clip.attrs ?? {}) };
  delete attrs[TRANSITION_ATTRIBUTE];
  const existing = restoreFields.find((entry) => entry.id === holder.clip.id);
  existing.fields.attrs = Object.keys(attrs).length ? attrs : null;
  const ops = fieldOps(restoreFields);
  return { ok: true, ops, transition: { id: spec.id, removed: true, presetId: spec.presetId, totalDelta: -Number(spec.totalDelta ?? 0) } };
}

/**
 * duration is timeline seconds. `from`/`to` are clip IDs, never filesystem paths.
 * The caller owns expectedHash/opId/CAS and sends this entire batch exactly once.
 */
export function planTransitionPreset(input = {}) {
  const { doc } = input;
  const preset = getTransitionPreset(input.presetId);
  if (!preset) return failure('TRANSITION_UNSUPPORTED', '这个转场还没有可用的执行器');
  const entries = all(doc);
  let to = entries.find(({ clip }) => clip.id === clipId(input.to));
  let from = entries.find(({ clip }) => clip.id === clipId(input.from));
  if (preset.single && !to) to = from;
  if (!to && Number.isFinite(input.at)) {
    const candidates = entries.filter(({ clip, track }) => picture(clip) && !track.locked && span(clip));
    to = candidates.filter(({ clip }) => Math.abs(span(clip).at - input.at) < 0.1).sort((a, b) => Math.abs(span(a.clip).at - input.at) - Math.abs(span(b.clip).at - input.at))[0];
    if (to && !from) from = candidates.find(({ clip, track }) => track === to.track && clip.id !== to.clip.id && Math.abs(span(clip).end - span(to.clip).at) < 0.01);
  }
  if (!to || (!preset.single && !from)) return failure('NO_CUT', '请在相邻的两个画面片段之间选择接缝');
  if (to.track.locked || (!preset.single && from.track.locked)) return failure('LOCKED', '转场涉及已锁定轨道，请先解锁');
  if (!picture(to.clip) || (!preset.single && !picture(from.clip))) return failure('TRANSITION_TARGET_KIND', '这个转场需要画面或网页片段');
  const currentSpec = transitionSpecOf(to.clip);
  if (currentSpec) {
    const removed = planRemoveTransitionPreset({ doc, transitionId: currentSpec.id });
    if (!removed.ok) return removed;
    const cleared = applyOpsDetailed(doc, removed.ops).value;
    const next = planTransitionPreset({ ...input, doc: cleared });
    return next.ok ? { ...next, ops: [...removed.ops, ...next.ops], replaced: currentSpec.id } : next;
  }
  if (!preset.single && (from.clip.id === to.clip.id || transitionSpecOf(from.clip))) return failure('TRANSITION_TARGET_BUSY', '片段已参与另一转场，请先移除该转场');
  const a = preset.single ? null : span(from.clip), b = span(to.clip);
  if (!b || (!preset.single && !a)) return failure('TRANSITION_NO_SPAN', '片段需要明确、有效的源起止时间');
  const fps = input.fps ?? doc?.fps ?? { num: 30, den: 1 };
  if (!(fps.num > 0 && fps.den > 0)) return failure('TRANSITION_FPS_INVALID', '工程帧率无效');
  const frame = fps.den / fps.num;
  if (!preset.single && Math.abs(a.end - b.at) > Math.max(0.0011, frame / 2)) return failure('NO_CUT', '所选片段没有连续接缝；请先将两段首尾相接');
  const requested = input.duration === undefined ? preset.duration : Number(input.duration);
  if (!(Number.isFinite(requested) && requested >= 0.05 && requested <= 3)) return failure('TRANSITION_DURATION_INVALID', '时长应在 0.05–3 秒之间');
  const overlap = preset.mechanism !== 'overlay' && !preset.single;
  const available = preset.single ? b.length : overlap ? Math.min(a.length, b.length) : Math.min(a.length, b.length) * 2;
  const duration = round(Math.floor((Math.min(requested, available) + 1e-8) / frame) * frame);
  if (duration < frame - 1e-6) return failure('TRANSITION_NO_HEADROOM', '片段长度不足一帧转场');
  const cut = preset.single ? (preset.effect === 'fade-out' ? b.end : b.at) : b.at;
  const start = preset.single ? (preset.effect === 'fade-out' ? b.end - duration : b.at) : overlap ? cut - duration : cut - duration / 2;
  const end = preset.single ? start + duration : overlap ? cut : cut + duration / 2;
  if (start < -1e-6) return failure('TRANSITION_NO_HEADROOM', '转场将超出影片起点');
  const changes = new Map();
  const change = (entry, fields) => {
    if (entry.track.locked) return false;
    const prior = changes.get(entry.clip.id);
    const beforeFields = prior?.beforeFields ?? {};
    for (const key of Object.keys(fields)) if (!Object.hasOwn(beforeFields, key)) beforeFields[key] = entry.clip[key] === undefined ? null : copy(entry.clip[key]);
    changes.set(entry.clip.id, { entry, beforeFields, fields: { ...prior?.fields, ...fields } });
    return true;
  };
  const oldFade = (entry) => Array.isArray(entry.clip.fade) ? entry.clip.fade.map(Number) : [0, 0];
  if (preset.single) {
    const fade = oldFade(to);
    change(to, { fade: preset.effect === 'fade-in' ? [duration, fade[1]] : [fade[0], duration] });
  } else if (overlap) {
    change(from, { fade: [oldFade(from)[0], duration] });
    change(to, { at: round(start), fade: [duration, oldFade(to)[1]] });
    // Existing detached sound follows only exact mirrored, explicitly linked clips.
    for (const [entry, edge] of [[from, 'out'], [to, 'in']]) {
      if (!entry.clip.link) continue;
      for (const sound of entries.filter(({ clip }) => clip.kind === 'sound' && clip.link === entry.clip.link && same(clip.time, entry.clip.time) && Number(clip.at ?? 0) === Number(entry.clip.at ?? 0))) {
        if (sound.track.locked) return failure('LOCKED', `关联音轨已锁定：${sound.clip.id}`);
        const fade = oldFade(sound);
        change(sound, edge === 'out' ? { fade: [fade[0], duration] } : { at: round(start), fade: [duration, fade[1]] });
      }
    }
  }
  // A metadata-only overlay still uses a real fields Op and one undo step.
  if (!changes.has(to.clip.id)) change(to, {});
  // fitFades and any future core normalization must be reflected in the guard.
  // Otherwise an existing opposite-edge fade could make removal falsely stale.
  let normalized;
  try {
    const initialOps = fieldOps([...changes].map(([id, { fields }]) => ({ id, fields })));
    normalized = all(initialOps.length ? applyOpsDetailed(doc, initialOps).value : doc);
  } catch (error) { return failure(error.code ?? 'TRANSITION_INVALID', error.message); }
  const spec = {
    version: TRANSITION_PRESET_VERSION, id: `transition:${preset.single ? '' : from.clip.id}:${to.clip.id}`,
    presetId: preset.id, effect: preset.effect, mechanism: preset.mechanism,
    direction: preset.direction ?? null, from: preset.single ? null : from.clip.id, to: to.clip.id,
    start: round(start), end: round(end), cut: round(cut), duration,
    totalDelta: overlap ? -duration : 0, overlap, requiresStage: true,
    edits: [...changes.values()].map(({ entry, beforeFields }) => ({ id: entry.clip.id, beforeFields, after: snapshot(normalized.find(({ clip }) => clip.id === entry.clip.id).clip) })),
  };
  changes.get(to.clip.id).fields.attrs = { ...(to.clip.attrs ?? {}), [TRANSITION_ATTRIBUTE]: JSON.stringify(spec) };
  const ops = fieldOps([...changes].map(([id, { fields }]) => ({ id, fields })));
  return { ok: true, ops, transition: { ...spec, name: preset.name },
    warnings: duration < requested - frame / 2 ? ['TRANSITION_DURATION_CLAMPED'] : [] };
}

