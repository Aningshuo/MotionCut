// @ts-nocheck -- Dynamic JSON boundary; runtime invariants are exercised against the real registry.
/** Shared creation-library domain: GUI, CLI, MCP and Agent use this same dispatcher. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { ORIGINAL_CATALOG, catalogItem, catalogAssetFolder } from './creation-library-catalog.mjs';
import { renderOriginalScene, sceneParams } from './creation-library-scenes.mjs';
import { LibraryError, digest, relativeSource, sourcePart, safePath, ensureRoot, readState, updateState, copySourceBundle, writeSceneBundle } from './creation-library-store.mjs';
import { skillsDirOf } from './agent-scene.mjs';
import { spanOf, planRippleInsert } from '../../film-core/ripple.mjs';
import { applyOpsDetailed } from '../../film-core/ops.mjs';
import { clipAttributes } from '../../film-core/film-doc.mjs';
import { listTransitionPresets, planTransitionPreset, planRemoveTransitionPreset, planResizeTransitionPreset, listAppliedTransitions, transitionPreviewHtml } from '../../film-core/transition-presets.mjs';
import { probeMedia } from '../../render/verify.mjs';

const projects = new Map();
const mediaProbes = new Map();
const serial = async (key, fn) => { const last = projects.get(key) ?? Promise.resolve(); const next = last.catch(() => {}).then(fn); projects.set(key, next); try { return await next; } finally { if (projects.get(key) === next) projects.delete(key); } };
const identify = (project) => typeof project === 'string' ? project : project?.projectId;
function context(registry, project) {
  const id = identify(project), found = typeof project === 'object' ? project : registry.get?.(id);
  const value = registry.docOf(id);
  if (!id || !found?.dir || !value?.doc) throw new LibraryError('PROJECT_NOT_OPEN', '请先打开工程', 404);
  return { id, project: found, dir: found.dir, ...value };
}
const mediaKind = (src) => /\.(?:html?|xhtml)$/i.test(src) ? 'page' : /\.(?:wav|mp3|m4a|aac|flac|ogg)$/i.test(src) ? 'sound' : /\.(?:png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(src) ? 'still' : /\.(?:mp4|m4v|mov|webm|mkv|avi)$/i.test(src) ? 'video' : null;
const fileUrl = (id, itemId, asset) => `/api/projects/${encodeURIComponent(id)}/creation-library/files/${encodeURIComponent(itemId)}/${asset.split('/').map(encodeURIComponent).join('/')}`;
const builtinFolder = (item) => `${catalogAssetFolder(item)}/${digest(JSON.stringify(renderOriginalScene(item))).slice(0, 16)}`;
const cleanName = (value, fallback = '未命名素材') => { const text = String(value ?? '').trim(); if (text.length > 160 || /[\0\r\n]/.test(text)) throw new LibraryError('INVALID_NAME', '名称过长或包含无效字符'); return text || fallback; };
function envelope(request, services) {
  if (typeof request.expectedHash !== 'string' || !/^[a-f0-9]{64}$/i.test(request.expectedHash)) throw new LibraryError('EXPECTED_HASH_REQUIRED', '写入前需要准确的工程版本', 409);
  if (typeof request.opId !== 'string' || request.opId.length > 160 || !/^[\w:./-]+$/.test(request.opId)) throw new LibraryError('OP_ID_REQUIRED', '写入必须带稳定的opId');
  return { expectedHash: request.expectedHash, opId: request.opId, by: services.by === 'agent' ? 'agent' : 'person' };
}
const stable = (x) => Array.isArray(x) ? x.map(stable) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, stable(x[k])])) : x;
async function wavDuration(file) {
  const handle = await fs.open(file, 'r');
  try { const header = Buffer.alloc(44); await handle.read(header, 0, 44, 0); if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') return null; const rate = header.readUInt32LE(28); const size = (await handle.stat()).size; return rate > 0 ? Math.max(0, size - 44) / rate : null; } finally { await handle.close(); }
}
async function projectItems(ctx, state, services) {
  const paths = new Set(), folders = new Map(), refs = new Map();
  for (const track of ctx.doc.tracks) for (const clip of track.clips) {
    if (!clip.src) continue;
    let src; try { src = sourcePart(clip.src); } catch { continue; }
    refs.set(src, [...(refs.get(src) ?? []), clip]); paths.add(src);
  }
  async function walk(rel) {
    let folder; try { folder = await safePath(ctx.dir, rel, { directory: true }); } catch (e) { if (e.code === 'SOURCE_MISSING') return; throw e; }
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name.includes('-pending-')) continue;
      if (paths.size > 5000) throw new LibraryError('LIST_LIMIT', '素材超过5000项，请使用更小的工程目录');
      const src = `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        // Instance storage remains discoverable as editable scene cards, but
        // implementation tokens are not user-created navigation folders.
        if (!/^assets\/creation-library(?:\/|$)/.test(src)) folders.set(`project-folder:${src}`, { id: `project-folder:${src}`, name: entry.name, parentId: `project-folder:${rel}` });
        await walk(src);
      }
      else if (entry.isFile() && !/(?:props|bundle-manifest)\.json$/.test(entry.name)) paths.add(src);
    }
  }
  await walk('assets'); await walk('scenes');
  const items = [];
  for (const src of [...paths].sort()) {
    const id = `project:${src}`, referenced = refs.get(src) ?? [], kind = mediaKind(src);
    // Sidecars and dependency files are not standalone timeline resources. A
    // real film reference still gets an explicit diagnostic instead of vanishing.
    if (!kind && referenced.length === 0) continue;
    let file, stat;
    try { file = await safePath(ctx.dir, src); stat = await fs.stat(file); } catch (error) { if (referenced.length) items.push({ id, name: path.posix.basename(src), category: 'media', group: '项目素材', source: 'project', kind: kind ?? 'other', src, mediaKind: kind ?? undefined, refs: referenced.length, availability: 'missing', reason: error.message }); continue; }
    if (!stat.isFile()) { if (referenced.length) items.push({ id, name: path.posix.basename(src), category: 'media', group: '项目素材', source: 'project', kind: kind ?? 'other', src, refs: referenced.length, availability: 'failed', reason: '工程引用的素材路径不是普通文件' }); continue; }
    let durationSec = kind === 'page' ? referenced.map((c) => spanOf(c).length).find((n) => n > 0) ?? null : null;
    let hasAudio = kind === 'sound', mediaInfo;
    if (kind === 'video' || kind === 'sound') {
      const key = `${file}:${stat.size}:${stat.mtimeMs}`;
      if (!mediaProbes.has(key)) { if (mediaProbes.size >= 1024) mediaProbes.delete(mediaProbes.keys().next().value); mediaProbes.set(key, Promise.resolve(typeof services.describeMedia === 'function' ? services.describeMedia(file, kind) : probeMedia(file)).catch(() => null)); }
      mediaInfo = await mediaProbes.get(key);
      durationSec = Number(mediaInfo?.durationSec ?? mediaInfo?.format?.durationSec ?? mediaInfo?.video?.durationSec ?? mediaInfo?.audio?.durationSec) || null;
      hasAudio = kind === 'sound' || !!mediaInfo?.audio || mediaInfo?.hasAudio === true;
    }
    if (/\.wav$/i.test(src) && durationSec === null) durationSec = await wavDuration(file).catch(() => durationSec);
    const title = path.posix.basename(src), folder = path.posix.dirname(src);
    const previewUrl = fileUrl(ctx.id, id, src);
    items.push({ id, name: referenced.find(c => c.attrs?.['data-creation-name'])?.attrs?.['data-creation-name'] || title, category: /(?:^|\/)music\//i.test(src) ? 'music' : /(?:^|\/)(?:sound|sfx)\//i.test(src) ? 'sound' : 'media', group: '项目素材', source: 'project', kind: kind ?? 'other', src,
      ...(kind ? { mediaKind: kind } : {}), durationSec, hasAudio, bytes: stat.size, modifiedAt: stat.mtime.toISOString(), folderId: `project-folder:${folder}`, refs: referenced.length,
      ...(kind ? { previewUrl } : {}), ...(kind === 'still' ? { thumbUrl: previewUrl } : kind === 'video' && /^assets\/[^/]+$/.test(src) ? { thumbUrl: `/api/projects/${encodeURIComponent(ctx.id)}/assets/${encodeURIComponent(title)}/thumb` } : {}),
      availability: kind ? 'ready' : 'failed', ...(!kind ? { reason: '工程仍引用此文件；当前素材库不支持此格式，请检查原文件' } : {}), tags: [kind ?? 'other', folder],
    });
  }
  return { items, folders: [...folders.values()] };
}
async function skillItems(libraryRoot, state, services) {
  const result = [], roots = [services.skillsRoot ?? skillsDirOf(), path.join(libraryRoot, 'skills')];
  const used = new Set();
  for (const root of roots) {
    let entries; try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || used.has(entry.name)) continue;
      let file; try { file = await safePath(root, `${entry.name}/SKILL.md`); } catch { continue; }
      const body = await fs.readFile(file, 'utf8'); if (body.length > 256 * 1024) continue;
      const description = /^description:\s*["']?(.+?)\s*["']?$/m.exec(body)?.[1] ?? body.split('\n').find((s) => s.trim() && !s.startsWith('---')) ?? entry.name;
      const id = `skill:${entry.name}`; used.add(entry.name);
      result.push({ id, name: entry.name, category: 'skill', group: '已安装', source: root === roots[1] ? 'saved' : 'project', kind: 'skill', availability: 'ready', enabled: state.skills.find((x) => x.id === id)?.enabled !== false, params: { description }, tags: ['本地', '不自动执行'], _skillRoot: root });
    }
  }
  return result;
}
async function snapshot(ctx, libraryRoot, capabilities = {}, services = {}) {
  const state = await readState(libraryRoot), local = await projectItems(ctx, state, services), items = [...local.items];
  // Listing descriptors is read-only. Preview/apply materialize only the requested resource.
  for (const item of ORIGINAL_CATALOG) {
    items.push({ ...item, availability: 'ready', previewUrl: fileUrl(ctx.id, item.id, 'scene.html') });
  }
  for (const preset of listTransitionPresets()) items.push({ id: preset.id, name: preset.name, category: 'transition', group: preset.group, source: 'builtin', kind: 'transition', availability: 'ready', params: { duration: preset.duration }, previewUrl: fileUrl(ctx.id, preset.id, 'scene.html'), tags: [preset.group, preset.mechanism, '原创'] });
  const cuts = ctx.doc.tracks.flatMap((track) => {
    if (track.locked) return [];
    const picture = track.clips.filter((clip) => ['page', 'still', 'video', 'text'].includes(clip.kind)).sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    return picture.slice(1).flatMap((clip, index) => {
      const previous = picture[index], a = spanOf(previous), b = spanOf(clip);
      return Math.abs(a.end - b.start) < 1e-5 ? [{ id: `${previous.id}:${clip.id}`, from: previous.id, to: clip.id, at: b.start, maxDuration: Math.min(3, a.length / 2, b.length / 2) }] : [];
    });
  });
  for (const applied of listAppliedTransitions(ctx.doc)) if (!cuts.some((x) => x.from === applied.from && x.to === applied.to)) cuts.push({ id: `${applied.from}:${applied.to}`, from: applied.from, to: applied.to, at: applied.start, maxDuration: 3 });
  for (const saved of state.saved) {
    let availability = 'ready', reason;
    try { await safePath(libraryRoot, `${saved.bundle}/${saved.source}`); } catch (e) { availability = 'missing'; reason = e.message; }
    items.push({ ...saved.item, id: saved.id, source: 'saved', availability, reason, previewUrl: fileUrl(ctx.id, saved.id, saved.source) });
  }
  items.push(...await skillItems(libraryRoot, state, services));
  if (typeof services.items === 'function') {
    const extra = await services.items({ project: ctx.project, doc: ctx.doc, libraryRoot });
    for (const item of Array.isArray(extra) ? extra : []) {
      if (!item?.id) continue;
      const existing = items.find((x) => x.id === item.id);
      if (existing) { for (const key of ['name', 'category', 'group', 'source', 'tags', 'reason', 'paramSchema', 'params']) if (item[key] !== undefined) existing[key] = item[key]; continue; }
      if (item.src) { try { await safePath(ctx.dir, sourcePart(item.src)); } catch { items.push({ ...item, availability: 'missing', reason: '源文件尚未生成' }); continue; } }
      items.push(item);
    }
  }
  const excluded = state.excluded[ctx.id] ?? [];
  const visible = items.filter((x) => !excluded.includes(x.id)).map(({ _skillRoot, ...item }) => ({ ...item, ...state.metadata[item.id], favorite: state.favorites.includes(item.id) }));
  const captionData = typeof services.captionSnapshot === 'function' ? await services.captionSnapshot({ project: ctx.project, doc: ctx.doc }) : {};
  const { audio: captionAudio, ...captionFields } = captionData;
  return { projectId: ctx.id, sourceHash: ctx.hash, items: visible, folders: [...local.folders, ...state.folders], capabilities, cuts, appliedTransitions: listAppliedTransitions(ctx.doc),
    ...captionFields, ...(captionAudio ? { captionSources: captionAudio } : {}),
    audio: visible.filter((x) => (x.mediaKind === 'sound' || x.hasAudio) && x.src && x.availability === 'ready').map((x) => ({ id: x.id, name: x.name, src: x.src, durationSec: x.durationSec ?? 0 })),
    ...(typeof services.jobs === 'function' ? { jobs: await services.jobs(ctx.project) } : {}),
  };
}
export async function readCreationLibrary({ registry, project, libraryRoot, capabilities = {}, services = {} }) {
  return snapshot(context(registry, project), libraryRoot, capabilities, services);
}

function cssProperty(style, property, value) {
  const parts = []; let current = '', quote = '', depth = 0;
  for (const char of String(style ?? '')) { if (quote) { current += char; if (char === quote) quote = ''; } else if (char === '"' || char === "'") { quote = char; current += char; } else if (char === '(') { depth++; current += char; } else if (char === ')') { depth--; current += char; } else if (char === ';' && depth === 0) { parts.push(current); current = ''; } else current += char; }
  parts.push(current);
  return [...parts.filter((s) => s.trim() && s.split(':')[0].trim().toLowerCase() !== property), `${property}: ${value}`].join('; ');
}
function filterValue(item, params = {}) {
  const strength = Math.max(0, Math.min(1, Number(params.intensity ?? 1)));
  if (!Number.isFinite(strength)) throw new LibraryError('INVALID_PARAMETER', '滤镜强度必须是数字');
  return item.filter.replace(/([\w-]+)\(([-.\d]+)(deg)?\)/g, (_, key, raw, unit = '') => {
    const neutral = ['brightness', 'contrast', 'saturate', 'opacity'].includes(key) ? 1 : 0;
    return `${key}(${Number((neutral + (Number(raw) - neutral) * strength).toFixed(6))}${unit})`;
  });
}
function insertionPlan(ctx, request, clip, duration) {
  const target = request.target ?? {}, mode = target.mode ?? 'new-track';
  if (!['new-track', 'overlay', 'ripple', 'reject-overlap'].includes(mode)) throw new LibraryError('INVALID_TARGET', '请选择明确的轨道放置方式');
  const fps = Number(ctx.doc.fps?.num ?? 30) / Number(ctx.doc.fps?.den ?? 1);
  if (!Number.isFinite(fps) || fps <= 0) throw new LibraryError('INVALID_FPS', '工程帧率无效');
  const atRaw = target.at ?? 0;
  if (typeof atRaw !== 'number' || !Number.isFinite(atRaw) || atRaw < 0) throw new LibraryError('INVALID_TIME', '放置时间必须是非负秒数');
  const at = Math.round(atRaw * fps) / fps;
  const length = Math.max(1 / fps, Math.round(duration * fps) / fps);
  const index = target.track;
  if (index !== undefined && index !== null && (!Number.isInteger(index) || index < 0 || index > ctx.doc.tracks.length)) throw new LibraryError('INVALID_TRACK', '目标轨道不存在');
  let track = index, ops = [];
  if (mode === 'new-track' || mode === 'overlay' || index == null || index === ctx.doc.tracks.length) track = { insert: index ?? 0 };
  else {
    const existing = ctx.doc.tracks[index];
    if (existing?.locked) throw new LibraryError('LOCKED', '目标轨道已锁定', 409);
    const audioTrack = existing?.role === 'audio' || (existing?.clips?.length > 0 && existing.clips.every((c) => c.kind === 'sound'));
    if ((clip.kind === 'sound') !== audioTrack) throw new LibraryError('TRACK_KIND_MISMATCH', clip.kind === 'sound' ? '声音素材请放入音轨或新建音轨' : '画面素材请放入画面轨道或新建轨道', 409);
    const spans = (ctx.doc.tracks[index]?.clips ?? []).map((c) => ({ clip: c, ...spanOf(c) }));
    if (mode === 'ripple') {
      const affected = spans.filter((s) => s.end > at + 1e-6), ids = new Set(affected.map((s) => s.clip.id));
      // Existing ripple plans operate on one track. Refuse linked groups instead
      // of silently moving picture independently from its detached sound.
      if (affected.some((s) => s.clip.link || s.clip.attrs?.['data-link'])) throw new LibraryError('RIPPLE_LINKED_CLIPS', '受影响片段有音画关联，请先使用完整关联组操作或选择新轨道，不会单独移动其中一端', 409);
      if (listAppliedTransitions(ctx.doc).some((t) => ids.has(t.from) || ids.has(t.to))) throw new LibraryError('RIPPLE_TRANSITION_BOUNDARY', '受影响接缝已有转场，请先移除该转场或选择新轨道', 409);
      const crossing = spans.filter((s) => s.start < at - 1e-6 && s.end > at + 1e-6);
      if (crossing.length > 1) throw new LibraryError('RIPPLE_OVERLAP', '插入点存在多个重叠片段，请先明确拆分对象或选择新轨道', 409);
      let afterSplit = ctx.doc;
      if (crossing.length === 1) {
        const source = crossing[0].clip, rightId = `creation-split-${digest(`${ctx.id}:${request.opId}:${source.id}`).slice(0, 24)}`;
        if (ctx.doc.tracks.some((t) => t.clips.some((c) => c.id === rightId))) throw new LibraryError('OP_ID_REUSED', '本次分割标识已存在，请先核对上次操作结果', 409);
        ops.push({ op: 'split', clip: source.id, at, rightId });
        afterSplit = applyOpsDetailed(ctx.doc, ops).value;
      }
      ops.push(...planRippleInsert({ tracks: afterSplit.tracks, track: index, at, length }).ops);
    } else if (spans.some((s) => s.start < at + length - 1e-6 && s.end > at + 1e-6)) throw new LibraryError('OVERLAP', '目标位置已有片段，请选择新建轨道或波纹插入', 409);
  }
  const sourceStart = Number(clip.time?.[0] ?? 0), speed = Number(clip.speed ?? 1);
  if (!Number.isFinite(sourceStart) || sourceStart < 0 || !Number.isFinite(speed) || speed <= 0) throw new LibraryError('INVALID_TIME', '素材源时间或速度无效');
  return [...ops, { op: 'insert', clip: { ...clip, time: [sourceStart, sourceStart + length * speed] }, at, track }];
}
async function commit(ctx, registry, request, services, ops) {
  const env = envelope(request, services);
  if (env.expectedHash !== ctx.hash) throw new LibraryError('CONFLICT', '工程已变化，请刷新后再操作', 409);
  // Preflight the exact original ops implementation before writing a byte of film.html.
  applyOpsDetailed(ctx.doc, ops);
  return registry.applyOps(ctx.id, env, ops);
}
async function delegate(services, key, request, ctx) {
  if (typeof services[key] !== 'function') return { ok: false, code: 'CAPABILITY_UNAVAILABLE', status: 409, message: `此功能尚未配置真实${({ caption: '字幕服务', media: '媒体服务', importMedia: '媒体导入服务', transition: '转场服务' })[key] ?? '处理服务'}` };
  return services[key](request, { project: ctx.project, doc: ctx.doc, hash: ctx.hash });
}
async function transitionAction(ctx, registry, request, services) {
  envelope(request, services);
  if (typeof services.transition === 'function') return delegate(services, 'transition', request, ctx);
  const target = request.target ?? {};
  const planned = request.action === 'transition.remove'
    ? planRemoveTransitionPreset({ doc: ctx.doc, to: target.to ?? target.clipId, transitionId: request.params?.transitionId, presetId: request.itemId })
    : request.action === 'transition.resize' ? planResizeTransitionPreset({ doc: ctx.doc, to: target.to ?? target.clipId, transitionId: request.params?.transitionId, duration: target.durationSec ?? request.params?.duration })
    : planTransitionPreset({ doc: ctx.doc, presetId: request.itemId, from: target.from, to: target.to, duration: target.durationSec ?? request.params?.duration ?? 0.6 });
  if (!planned.ok) return { ...planned, status: 409 };
  const result = await commit(ctx, registry, request, services, planned.ops);
  return { ...result, transition: planned.transition, warnings: planned.warnings };
}
async function applyResource(ctx, registry, libraryRoot, request, services) {
  const env = envelope(request, services);
  if (env.expectedHash !== ctx.hash) throw new LibraryError('CONFLICT', '工程已变化，未创建新实例', 409);
  const state = await readState(libraryRoot), snap = await snapshot(ctx, libraryRoot, {}, services);
  const item = snap.items.find((x) => x.id === request.itemId);
  if (!item) throw new LibraryError('ITEM_NOT_FOUND', '此素材不存在或已被移出库', 404);
  if (item.category === 'transition') return transitionAction(ctx, registry, request, services);
  if (item.category === 'skill') throw new LibraryError('INVALID_ACTION', '技能应使用“放入对话”');
  if (item.availability !== 'ready') throw new LibraryError('SOURCE_NOT_READY', item.reason ?? '素材还未就绪', 409);
  if (item.category === 'filter' && request.target?.mode === 'clip') {
    const targetId = request.target.clipId ?? request.target.selectedClipIds?.[0];
    const track = ctx.doc.tracks.find((t) => t.clips.some((c) => c.id === targetId));
    const target = track?.clips.find((c) => c.id === targetId);
    if (!target || target.kind === 'sound') throw new LibraryError('TARGET_REQUIRED', '请选择一个画面片段');
    if (track.locked) throw new LibraryError('LOCKED', '片段所在轨道已锁定', 409);
    const base = catalogItem(item.id);
    if (!base?.filter) throw new LibraryError('FILTER_UNAVAILABLE', '滤镜定义不可用');
    const result = await commit(ctx, registry, request, services, [{ op: 'fields', clip: target.id, fields: { style: cssProperty(target.style, 'filter', filterValue(base, request.params)) } }]);
    return { ...result, clipId: target.id };
  }
  if (request.target?.mode === 'clip') throw new LibraryError('INVALID_TARGET', '此素材请拖到轨道空位；片段定向应用只用于滤镜');
  const duration = Number(request.target?.durationSec ?? request.params?.duration ?? item.durationSec ?? (item.mediaKind === 'page' ? 6 : item.mediaKind === 'still' ? 4 : 0));
  if (!(duration > 0 && duration <= 86400)) throw new LibraryError('DURATION_REQUIRED', '请先读取素材真实时长，或明确指定片段长度');
  if (['video', 'sound'].includes(item.mediaKind) && item.durationSec > 0 && duration > item.durationSec + 1e-6) throw new LibraryError('DURATION_PAST_SOURCE', '片段长度超过真实素材范围，请缩短长度', 409);
  const token = digest(`${ctx.id}:${request.opId}`).slice(0, 24), clipId = `creation-${token}`;
  const destination = `assets/creation-library/${token}`;
  let clip = { id: clipId, src: item.src, kind: item.mediaKind, time: [0, duration] };
  // Validate placement before creating recoverable source files.
  insertionPlan(ctx, request, { ...clip, src: clip.src ?? 'scene.html' }, duration);
  const base = catalogItem(item.id);
  if (base) {
    const params = sceneParams(base, { ...base.params, ...request.params, ...(request.text === undefined ? {} : { title: request.text }) });
    clip.src = await writeSceneBundle(ctx.dir, destination, renderOriginalScene(base, params));
    clip.kind = 'page'; clip.size = { w: 1280, h: 720 };
    // Retain the editable design viewport while fitting this new original
    // instance inside the actual film stage. Existing/Saved layouts stay intact.
    clip.box = { x: 0, y: 0, w: ctx.doc.stage.w, h: ctx.doc.stage.h };
    if (base.category === 'filter') clip.style = `backdrop-filter: ${filterValue(base, request.params)}`;
  } else if (item.source === 'saved') {
    const saved = state.saved.find((x) => x.id === item.id);
    if (!saved) throw new LibraryError('ITEM_NOT_FOUND', '收藏条目不存在', 404);
    if (saved.nativeText === true && saved.clip?.kind === 'text') clip = { ...structuredClone(saved.clip), id: clipId, src: '' };
    else {
      const copied = await copySourceBundle(path.join(libraryRoot, saved.bundle), saved.source, ctx.dir, destination);
      clip = { ...(saved.clip ?? {}), ...clip, src: copied.src, ...(saved.clip?.time ? { time: [...saved.clip.time] } : {}), ...(saved.clip?.speed ? { speed: saved.clip.speed } : {}) };
    }
  } else if (item.id.startsWith('builtin-audio:')) {
    const cached = await import('./creation-services.mjs').then((m) => m.resolveCreationAudio({ libraryRoot, itemId: item.id }));
    const copied = await copySourceBundle(cached.root, cached.source, ctx.dir, destination);
    clip.src = copied.src;
  } else if (item.mediaKind === 'page') {
    const copied = await copySourceBundle(ctx.dir, sourcePart(item.src), ctx.dir, destination);
    clip.src = copied.src;
  } else if (!['video', 'sound', 'still'].includes(item.mediaKind)) throw new LibraryError('NOT_EDITABLE_MEDIA', '这种文件可以保存，但不能加入时间线');
  if (!clip.src && clip.kind !== 'text') throw new LibraryError('SOURCE_MISSING', '素材没有可用源文件');
  if (clip.src) await safePath(ctx.dir, sourcePart(clip.src));
  clip.attrs = { ...clip.attrs, 'data-creation-name': item.name };
  const ops = insertionPlan(ctx, request, clip, duration);
  const result = await commit(ctx, registry, request, services, ops);
  return { ...result, clipId, ...(result.ok === true ? { src: clip.src } : {}) };
}

async function dispatch(ctx, registry, libraryRoot, request, services) {
  const action = request.action;
  if (action === 'resource.apply') return applyResource(ctx, registry, libraryRoot, request, services);
  if (action === 'resource.import-media') {
    const result = await delegate(services, 'importMedia', request, ctx);
    if (result.ok && result.itemId) await updateState(libraryRoot, state => { state.metadata[result.itemId] = { ...state.metadata[result.itemId], name: cleanName(request.params?.fileName) }; });
    return result;
  }
  if (action.startsWith('media.') || action === 'job.cancel') return delegate(services, 'media', request, ctx);
  if (action.startsWith('caption.') || action.startsWith('captions.')) { if (!['caption.read', 'captions.read', 'caption.export', 'captions.export'].includes(action)) envelope(request, services); return delegate(services, 'caption', request, ctx); }
  if (action.startsWith('transition.')) return transitionAction(ctx, registry, request, services);
  if (action === 'resource.import-page') {
    const content = request.params?.content ?? request.text;
    const fileName = cleanName(request.params?.fileName ?? request.name, '导入网页');
    if (typeof content !== 'string' || content.length > 2 * 1024 * 1024 || !/<(?:html|body|main|div|svg|section)\b/i.test(content)) throw new LibraryError('INVALID_HTML', '需要完整的HTML场景内容');
    const token = digest(content).slice(0, 24), destination = `assets/creation-library/imported-${token}`;
    const compatibility = '<script>if(!window.film||typeof window.film.frame!=="function"){window.film={frame(t){for(const a of document.getAnimations()){a.pause();a.currentTime=Math.max(0,Number(t)||0)*1000;}}};}</script>';
    const scene = /<\/body\s*>/i.test(content) ? content.replace(/<\/body\s*>/i, `${compatibility}</body>`) : `${content}${compatibility}`;
    const src = await writeSceneBundle(ctx.dir, destination, { 'scene.html': scene, 'props.json': JSON.stringify({ source: 'user', name: fileName, staticFrameAdapter: true }) });
    const id = `project:${src}`;
    await updateState(libraryRoot, (state) => { state.metadata[id] = { name: fileName.replace(/\.html?$/i, ''), folderId: request.folderId }; state.excluded[ctx.id] = (state.excluded[ctx.id] ?? []).filter((x) => x !== id); });
    return { ok: true, itemId: id, src, hash: ctx.hash, message: '网页已导入，源码保留；加入轨道后可编辑' };
  }
  if (action === 'folder.create') return updateState(libraryRoot, (state) => {
    const name = cleanName(request.name), parentId = request.folderId;
    if (parentId && !state.folders.some((x) => x.id === parentId)) throw new LibraryError('FOLDER_NOT_FOUND', '上级文件夹不存在');
    const id = `folder:${digest(`${parentId ?? ''}/${name}`).slice(0, 20)}`;
    if (!state.folders.some((x) => x.id === id)) state.folders.push({ id, name, ...(parentId ? { parentId } : {}) });
    return { ok: true, folderId: id, message: '文件夹已创建' };
  });
  if (action === 'skill.import') {
    const content = request.params?.content ?? request.text;
    const fileName = request.params?.fileName ?? request.name ?? 'SKILL.md';
    if (typeof content !== 'string' || !content.trim() || content.length > 256 * 1024 || !/\.md$/i.test(fileName)) throw new LibraryError('INVALID_SKILL', '请导入Markdown技能文件');
    const name = cleanName(request.name ?? /^name:\s*["']?([^\n"']+)/m.exec(content)?.[1] ?? path.basename(fileName, '.md'), '自有技能');
    const slug = `${name.replace(/[^\p{L}\p{N}_-]/gu, '-').slice(0, 50)}-${digest(content).slice(0, 10)}`;
    await writeSceneBundle(libraryRoot, `skills/${slug}`, { 'SKILL.md': content });
    return { ok: true, itemId: `skill:${slug}`, message: '技能已导入；使用时会放入对话，不自动执行' };
  }
  if (action === 'skill.toggle' || action === 'skill.use') {
    const state = await readState(libraryRoot), items = await skillItems(libraryRoot, state, services), item = items.find((x) => x.id === request.itemId);
    if (!item) throw new LibraryError('ITEM_NOT_FOUND', '技能不存在', 404);
    if (action === 'skill.toggle') return updateState(libraryRoot, (s) => { const row = s.skills.find((x) => x.id === item.id); if (row) row.enabled = request.value === true; else s.skills.push({ id: item.id, enabled: request.value === true }); return { ok: true }; });
    if (item.enabled === false) throw new LibraryError('SKILL_DISABLED', '请先启用此技能', 409);
    const file = await safePath(item._skillRoot, `${item.name}/SKILL.md`), body = await fs.readFile(file, 'utf8');
    return { ok: true, agentPrompt: `请在当前工程按以下用户选定技能工作，遵守工作台权限和正式写入口。\n\n${body}`, message: '技能已准备为对话引用，尚未执行' };
  }
  const snap = await snapshot(ctx, libraryRoot, {}, services);
  // Saving the current instance is distinct from saving a catalog card. Resolve
  // its source only from the authoritative doc, never a caller-provided path.
  if (action === 'resource.save' && !request.itemId && !request.itemIds?.length && request.target?.clipId) {
    const env = envelope(request, services);
    if (env.expectedHash !== ctx.hash) throw new LibraryError('CONFLICT', '工程已变化，请重新选择当前文字再保存', 409);
    const selected = ctx.doc.tracks.flatMap((track) => track.clips).find((clip) => clip.id === request.target.clipId);
    if (!selected) throw new LibraryError('CLIP_NOT_FOUND', '当前选中片段已不存在', 404);
    if (request.params?.category === 'text' && !['page', 'text'].includes(selected.kind)) throw new LibraryError('NOT_TEXT_RESOURCE', '请选择网页文字场景或文字片段', 409);
    if (selected.kind === 'text' && !selected.src) {
      const escape = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
      const attrs = clipAttributes(selected).filter(([, value]) => value !== null).map(([key, value]) => ` ${key}="${escape(value)}"`).join('');
      const preview = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=${ctx.doc.stage.w},height=${ctx.doc.stage.h}"><style>html,body{margin:0;width:${ctx.doc.stage.w}px;height:${ctx.doc.stage.h}px;overflow:hidden;background:transparent;font-family:system-ui;color:white}body>div{white-space:pre-wrap}</style></head><body><div${attrs}>${escape(selected.text)}</div><script>window.film={frame(){}};</script></body></html>`;
      const id = `saved:${digest(`${ctx.id}:${selected.id}:${request.opId}`).slice(0, 24)}`, bundle = `entries/${id.slice(6)}/files`;
      await writeSceneBundle(libraryRoot, bundle, { 'scene.html': preview });
      const record = { id, bundle, source: 'scene.html', nativeText: true, version: digest(JSON.stringify(selected)), clip: structuredClone(selected), item: { id, name: cleanName(request.name, '我的文字样式'), category: 'text', group: '我的样式', kind: 'text', source: 'saved', durationSec: spanOf(selected).length, folderId: request.folderId } };
      await updateState(libraryRoot, (state) => { state.saved = [...state.saved.filter((entry) => entry.id !== id), record]; });
      return { ok: true, itemId: id, message: '当前文字内容、样式与覆盖已保存，原工程未修改' };
    }
    const src = sourcePart(selected.src), id = `project:${src}`;
    await safePath(ctx.dir, src);
    if (!snap.items.some((item) => item.id === id)) snap.items.push({ id, src, name: path.posix.basename(src), category: 'media', group: '项目素材', kind: selected.kind, mediaKind: selected.kind, source: 'project', availability: 'ready', durationSec: spanOf(selected).length });
    request = { ...request, itemId: id, itemIds: undefined };
  }
  const ids = request.itemIds ?? (request.itemId ? [request.itemId] : []);
  if (!ids.length || ids.some((id) => !snap.items.some((x) => x.id === id))) throw new LibraryError('ITEM_NOT_FOUND', '请选择实际存在的素材', 404);
  if (action === 'resource.save') {
    const item = snap.items.find((x) => x.id === ids[0]);
    const selected = ctx.doc.tracks.flatMap((x) => x.clips).find((x) => x.id === request.target?.clipId);
    if (request.target?.clipId && (!selected || sourcePart(selected.src) !== sourcePart(item.src))) throw new LibraryError('TARGET_MISMATCH', '选中片段与收藏素材不一致');
    let root = ctx.dir, src = item.src;
    const builtin = catalogItem(item.id), oldSaved = (await readState(libraryRoot)).saved.find((x) => x.id === item.id);
    if (builtin) {
      const folder = builtinFolder(builtin);
      await writeSceneBundle(libraryRoot, folder, renderOriginalScene(builtin));
      root = path.join(libraryRoot, folder);
      src = 'scene.html';
    }
    else if (oldSaved) { root = path.join(libraryRoot, oldSaved.bundle); src = oldSaved.source; }
    else if (item.id.startsWith('builtin-audio:')) { const cached = await import('./creation-services.mjs').then((m) => m.resolveCreationAudio({ libraryRoot, itemId: item.id })); root = cached.root; src = cached.source; }
    if (!src) throw new LibraryError('INVALID_SOURCE', '此条目不是可收藏的源文件');
    const id = `saved:${digest(`${ctx.id}:${src}:${request.opId ?? ctx.hash}`).slice(0, 24)}`, bundle = `entries/${id.slice(6)}/files`;
    const copied = await copySourceBundle(root, sourcePart(src), libraryRoot, bundle);
    const record = { id, bundle, source: sourcePart(src), version: copied.version, item: { ...item, ...(selected ? { durationSec: spanOf(selected).length } : {}), ...(request.params?.category === 'text' ? { category: 'text', group: '我的样式' } : {}), name: cleanName(request.name, item.name), folderId: request.folderId, source: 'saved' }, ...(selected ? { clip: structuredClone(selected) } : {}) };
    await updateState(libraryRoot, (state) => { state.saved = [...state.saved.filter((x) => x.id !== id), record]; });
    return { ok: true, itemId: id, message: '已收藏源文件和本地依赖，实例独立' };
  }
  if (!['resource.favorite', 'resource.rename', 'resource.move', 'resource.remove'].includes(action)) throw new LibraryError('ACTION_UNSUPPORTED', `未实现的库动作：${action}`);
  return updateState(libraryRoot, (state) => {
    if (action === 'resource.move' && request.folderId && !state.folders.some((x) => x.id === request.folderId) && !snap.folders.some((x) => x.id === request.folderId)) throw new LibraryError('FOLDER_NOT_FOUND', '目标文件夹不存在');
    for (const id of ids) {
      if (action === 'resource.favorite') { state.favorites = state.favorites.filter((x) => x !== id); if (request.value === true) state.favorites.push(id); }
      if (action === 'resource.rename') state.metadata[id] = { ...state.metadata[id], name: cleanName(request.name) };
      if (action === 'resource.move') state.metadata[id] = { ...state.metadata[id], folderId: request.folderId ?? '' };
      if (action === 'resource.remove') { if (id.startsWith('saved:')) state.saved = state.saved.filter((x) => x.id !== id); else state.excluded[ctx.id] = [...new Set([...(state.excluded[ctx.id] ?? []), id])]; }
    }
    return { ok: true, hash: ctx.hash, message: action === 'resource.remove' ? '已移出素材库；原文件和时间线引用保留' : '素材库信息已更新，源路径未改变' };
  });
}
export async function applyCreationLibraryAction({ registry, project, libraryRoot, request, services = {} }) {
  try {
    const initial = context(registry, project);
    if (!request || typeof request.action !== 'string') throw new LibraryError('INVALID_ACTION', '需要明确的素材库动作');
    return await serial(initial.id, async () => {
      const ctx = context(registry, project), fp = digest(JSON.stringify(stable(request)));
      const readOnly = ['caption.read', 'captions.read', 'caption.export', 'captions.export'].includes(request.action);
      const key = !readOnly && request.opId ? `${ctx.id}:${request.opId}` : null;
      if (key) { const old = (await readState(libraryRoot)).receipts[key]; if (old) { if (old.fingerprint !== fp) throw new LibraryError('OP_ID_REUSED', 'opId已用于不同请求', 409); return { ...old.result, replayed: true }; } }
      const result = await dispatch(ctx, registry, libraryRoot, request, services);
      if (key && result.ok) await updateState(libraryRoot, (state) => { state.receipts[key] = { fingerprint: fp, result }; const keys = Object.keys(state.receipts); for (const k of keys.slice(0, Math.max(0, keys.length - 512))) delete state.receipts[k]; });
      return result;
    });
  } catch (error) { return { ok: false, status: error.status ?? 400, code: error.code ?? 'LIBRARY_FAILED', message: error.message ?? String(error) }; }
}
/** Only a caller-supplied item identity and whitelisted bundle-relative asset; never arbitrary absolute paths. */
export async function resolveCreationLibraryFile({ registry, project, libraryRoot, itemId, asset }) {
  const ctx = registry ? context(registry, project) : { id: identify(project), dir: project.dir };
  relativeSource(asset);
  let root, relative;
  const builtin = catalogItem(itemId);
  const transition = listTransitionPresets().find((x) => x.id === itemId);
  if (String(itemId).startsWith('builtin-audio:')) { const cached = await import('./creation-services.mjs').then((m) => m.resolveCreationAudio({ libraryRoot, itemId, asset })); root = cached.root; relative = cached.source; }
  else if (transition) { const html = transitionPreviewHtml(itemId), folder = `builtin/${itemId}/${digest(html).slice(0, 16)}`; await writeSceneBundle(libraryRoot, folder, { 'scene.html': html }); root = path.join(libraryRoot, folder); relative = asset; }
  else if (builtin) { const folder = builtinFolder(builtin); await writeSceneBundle(libraryRoot, folder, renderOriginalScene(builtin)); root = path.join(libraryRoot, folder); relative = asset; }
  else if (String(itemId).startsWith('project:')) {
    const src = sourcePart(itemId.slice(8));
    const referenced = ctx.doc?.tracks?.some((track) => track.clips.some((clip) => { try { return sourcePart(clip.src) === src; } catch { return false; } }));
    if (!/^(assets|scenes)\//.test(src) && !referenced) throw new LibraryError('PATH_ESCAPE', '此文件不是工程素材或已引用场景');
    if (asset !== src) { const closure = await import('./creation-library-store.mjs').then((x) => x.sourceClosure(ctx.dir, src)); if (!closure.some((x) => x.rel === asset)) throw new LibraryError('PATH_ESCAPE', '此文件不是素材的依赖'); } root = ctx.dir; relative = asset;
  }
  else { const saved = (await readState(libraryRoot)).saved.find((x) => x.id === itemId); if (!saved) throw new LibraryError('ITEM_NOT_FOUND', '素材不存在', 404); root = path.join(libraryRoot, saved.bundle); relative = asset; const closure = await import('./creation-library-store.mjs').then((x) => x.sourceClosure(root, saved.source)); if (!closure.some((x) => x.rel === asset)) throw new LibraryError('PATH_ESCAPE', '此文件不是收藏素材的依赖'); }
  const file = await safePath(root, relative), st = await fs.stat(file);
  if (!st.isFile()) throw new LibraryError('SOURCE_MISSING', '资源不是文件', 404);
  const ext = path.extname(file).toLowerCase(), types = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.xhtml': 'application/xhtml+xml; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.bmp': 'image/bmp', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.vtt': 'text/vtt; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf' };
  if (!types[ext]) throw new LibraryError('UNSUPPORTED_PREVIEW', '此类型只保留在工程中，不在库预览执行');
  return { path: file, mime: types[ext], root, relative, bytes: st.size };
}
