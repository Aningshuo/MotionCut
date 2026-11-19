// @ts-nocheck -- Validated caption action boundary, integration tested with the real subtitle store.
/** Existing companion subtitles and history remain the only caption store.
 * Jobs never write film.html, and a late recognizer/translator cannot replace a
 * file edited while it was running. Receipts contain no model credentials. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readSubtitles, saveSubtitles, writeAtomic, locateSubtitle } from './subtitle-store.mjs';
import { importSubtitleBytes, exportSubtitleBytes } from './subtitle-import.mjs';
import { normalizeCues } from '../../film-core/subtitle.mjs';
import { safePath, sourcePart } from './creation-library-store.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const failure = (code, message, status = 400) => ({ ok: false, code, message, status });
const fault = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const stable = x => Array.isArray(x) ? x.map(stable) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, stable(x[k])])) : x;
const all = doc => (doc?.tracks ?? []).flatMap(track => (track.clips ?? []).map(clip => ({ clip, track })));
const mappingOf = clip => clip ? { clipId: clip.id, at: Number(clip.at ?? 0), sourceIn: Number(clip.time?.[0] ?? 0), sourceOut: Number.isFinite(Number(clip.time?.[1])) ? Number(clip.time[1]) : null, speed: Number(clip.speed ?? 1) } : null;
// HTTP creates a factory for every request. Keep the transaction gate outside
// factories and key it by the real project directory, never caller identity or
// project aliases. The project-wide gate also protects the shared receipt file
// while a source's hash check, atomic rename and receipt commit are in flight.
const captionQueues = new Map();
export async function withProjectCaptionLock(project, fn) {
  const key = await fs.realpath(project.dir);
  const before = captionQueues.get(key) ?? Promise.resolve(), next = before.catch(() => {}).then(fn);
  captionQueues.set(key, next);
  try { return await next; } finally { if (captionQueues.get(key) === next) captionQueues.delete(key); }
}
function subtitleBelongsTo(clip, src) {
  if (!clip?.src || !/\.(srt|vtt)$/i.test(src)) return false;
  const media = sourcePart(clip.src).replace(/\.[^/.]+$/, ''), subtitle = src.replace(/\.(srt|vtt)$/i, '');
  return subtitle === media || subtitle.startsWith(`${media}.translated-`);
}
function timelineCues(cues, mapping) {
  if (!mapping) return cues;
  return cues.flatMap((cue, sourceIndex) => {
    const start = Math.max(cue.start, mapping.sourceIn), end = Math.min(cue.end, mapping.sourceOut ?? Infinity);
    return end > start ? [{ ...cue, start: mapping.at + (start - mapping.sourceIn) / mapping.speed, end: mapping.at + (end - mapping.sourceIn) / mapping.speed, sourceIndex, clipId: mapping.clipId }] : [];
  });
}
function sourceCues(cues, request, mapping) {
  const normalized = normalizeCues(cues);
  if (request.params?.timeBase !== 'timeline') return normalized;
  if (!mapping) throw fault('CAPTION_MAPPING_REQUIRED', '时间线时间需要明确选中一个媒体片段');
  return normalizeCues(normalized.map(cue => ({ ...cue, start: mapping.sourceIn + (cue.start - mapping.at) * mapping.speed, end: mapping.sourceIn + (cue.end - mapping.at) * mapping.speed })));
}

export function createCreationCaptions({ registry, mediaServices, by = 'person', io } = {}) {
  function current(project) {
    const value = registry.docOf(project.projectId);
    if (!value?.doc) throw fault('PROJECT_NOT_OPEN', '工程已关闭', 404);
    return value;
  }
  function filmGuard(project, expectedHash) {
    if (!/^[a-f0-9]{64}$/i.test(String(expectedHash ?? ''))) throw fault('EXPECTED_HASH_REQUIRED', '字幕操作需要准确的工程版本', 409);
    if (current(project).hash !== expectedHash) throw fault('CONFLICT', '工程已变化，字幕未修改，请刷新后重试', 409);
  }
  async function select(project, doc, request = {}) {
    const params = request.params ?? {}, entries = all(doc);
    const selected = request.selectedClipIds ?? request.target?.selectedClipIds ?? params.selectedClipIds;
    if (selected !== undefined && !Array.isArray(selected)) throw fault('CAPTION_SELECTION_INVALID', '选中片段必须是ID数组');
    const audioIds = params.audioIds;
    if (audioIds !== undefined && !Array.isArray(audioIds)) throw fault('CAPTION_SELECTION_INVALID', '音频来源必须是资源ID数组');
    if ((Array.isArray(request.sources) && request.sources.length > 1) || (Array.isArray(params.sources) && params.sources.length > 1) || (Array.isArray(selected) && selected.length > 1) || (Array.isArray(audioIds) && audioIds.length > 1)) throw fault('MULTI_SOURCE_UNSUPPORTED', '目前一次处理一个选中媒体来源；多个音轨请分别识别，不会静默漏掉其他轨');
    let audioSource;
    if (audioIds?.length) {
      if (typeof audioIds[0] !== 'string' || !audioIds[0].startsWith('project:')) throw fault('CAPTION_SOURCE_INVALID', '请选择当前工程的真实音频或视频资源');
      audioSource = sourcePart(audioIds[0].slice('project:'.length));
    }
    const selectedId = request.target?.clipId ?? params.clipId ?? selected?.[0];
    const picked = selectedId ? entries.find(({ clip }) => clip.id === selectedId) : null;
    if (selectedId && !picked) throw fault('CLIP_NOT_FOUND', '所选媒体片段已不存在', 404);
    let src = request.src ?? params.src ?? audioSource ?? picked?.clip.src;
    let entry = picked;
    if (!src) {
      const pictures = (doc?.tracks ?? []).filter(t => t.role === 'picture');
      const main = [...pictures].reverse().find(t => t.clips.some(c => c.kind === 'video'));
      let candidates = (main?.clips ?? []).filter(c => c.kind === 'video');
      if (!candidates.length) candidates = entries.filter(({ clip }) => ['video', 'sound'].includes(clip.kind)).map(({ clip }) => clip);
      const sources = [...new Set(candidates.map(c => sourcePart(c.src)))];
      if (sources.length > 1) throw fault('MULTI_SOURCE_UNSUPPORTED', '工程有多个媒体来源，请先选择一个视频或音轨再处理字幕');
      src = candidates[0]?.src;
      entry = entries.find(({ clip }) => clip.id === candidates[0]?.id);
    }
    if (!src) return null;
    src = sourcePart(src);
    if (!entry) entry = entries.find(({ clip }) => clip.src && (sourcePart(clip.src) === src || subtitleBelongsTo(clip, src)));
    if (picked && sourcePart(picked.clip.src) !== src && !subtitleBelongsTo(picked.clip, src)) throw fault('CAPTION_SOURCE_MISMATCH', '所选片段与字幕来源不一致');
    await safePath(project.dir, src);
    const found = await locateSubtitle({ project, src });
    if (found.error) throw fault('SUBTITLE_SRC_INVALID', found.error);
    if (found.found) await safePath(project.dir, found.file);
    const subtitles = await readSubtitles({ project, src });
    if (!subtitles.ok) throw fault(subtitles.code, subtitles.message);
    return { src, entry, selected: !!selectedId, mapping: mappingOf(entry?.clip), subtitles };
  }
  async function receipts(project) {
    const dir = path.join(project.dir, '.film');
    await fs.mkdir(dir, { recursive: true });
    if ((await fs.lstat(dir)).isSymbolicLink()) throw fault('PATH_ESCAPE', '字幕回执目录不能是符号链接');
    const file = path.join(dir, 'creation-caption-receipts.json');
    try {
      if ((await fs.lstat(file)).isSymbolicLink()) throw fault('PATH_ESCAPE', '字幕回执文件不能是符号链接');
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      if (value.version !== 1 || !value.entries || typeof value.entries !== 'object') throw fault('CAPTION_RECEIPTS_INVALID', '字幕回执格式无效，请保留文件检查');
      return { file, value };
    } catch (e) { if (e.code === 'ENOENT') return { file, value: { version: 1, entries: {} } }; throw e; }
  }
  async function record(project, opId, entry) {
    const store = await receipts(project);store.value.entries[opId] = entry;
    const keys = Object.keys(store.value.entries);
    while (keys.length > 250) { const key = keys.shift(); if (store.value.entries[key].state === 'pending' || store.value.entries[key].state === 'job') continue; delete store.value.entries[key]; }
    const result = await writeAtomic({ path: store.file, text: JSON.stringify(store.value) });
    if (!result.ok) throw fault(result.code, result.message, 500);
  }
  async function sidecarGuard(project, src, expectedHash) {
    const located = await locateSubtitle({ project, src });
    if (located.error) throw fault('SUBTITLE_SRC_INVALID', located.error);
    if (located.found) await safePath(project.dir, located.file);
    const value = await readSubtitles({ project, src });
    if (!value.ok) throw fault(value.code, value.message);
    if (value.hash !== expectedHash) throw fault('SUBTITLE_CONFLICT', '字幕在任务期间被人工修改，结果未覆盖，请重新读取后决定', 409);
  }
  async function save(project, src, cues, format, expectedFilmHash, expectedSubtitleHash, signal) {
    const output = await locateSubtitle({ project, src });
    if (output.found) await safePath(project.dir, output.file);
    else {
      const rel = src.replace(/\.[^/.]+$/, '') + (format === 'srt' ? '.srt' : '.vtt');
      await safePath(project.dir, rel, { missing: true });
    }
    signal?.throwIfAborted();filmGuard(project, expectedFilmHash);await sidecarGuard(project, src, expectedSubtitleHash);
    let guardError;
    const saved = await saveSubtitles({ project, src, cues, format, ...(io ? { io } : {}), hooks: { beforeRename: async () => {
      try { signal?.throwIfAborted();filmGuard(project, expectedFilmHash);await sidecarGuard(project, src, expectedSubtitleHash); }
      catch (e) { guardError = e;throw e; }
    } } });
    return guardError ? failure(guardError.name === 'AbortError' ? 'CANCELLED' : guardError.code ?? 'ABORTED', guardError.message, guardError.status ?? 409) : saved;
  }
  function resultOf(saved, source) { return { ...saved, src: source.src, clock: 'source', mapping: source.mapping, ...(by ? { by } : {}) }; }
  async function snapshot({ project, doc }) {
    const audio = { sources: all(doc).filter(({ clip }) => ['video', 'sound'].includes(clip.kind)).map(({ clip, track }) => ({ clipId: clip.id, src: clip.src, kind: clip.kind, muted: clip.muted === true || track.muted === true, mapping: mappingOf(clip) })) };
    try {
      const source = await select(project, doc, {});
      return { captions: source ? { src: source.src, file: source.subtitles.file, cues: source.subtitles.cues, format: source.subtitles.format, hash: source.subtitles.hash, clock: 'source', mapping: source.mapping, timelineCues: timelineCues(source.subtitles.cues, source.mapping) } : { file: null, cues: [], format: 'vtt', hash: null },
        audio };
    } catch (e) { return { captions: { file: null, cues: [], format: 'vtt', error: { code: e.code ?? 'CAPTION_READ_FAILED', message: e.message } }, audio }; }
  }
  async function perform(request, { project }) {
    const action = String(request.action ?? '').replace(/^captions\./, 'caption.');
    const state = current(project), source = await select(project, state.doc, request);
    if (!source) return failure('CAPTION_SOURCE_REQUIRED', '请先选择一个视频或音轨');
    const params = request.params ?? {};
    if (action === 'caption.read') return { ok: true, captions: { src: source.src, file: source.subtitles.file, cues: source.subtitles.cues, format: source.subtitles.format, hash: source.subtitles.hash, clock: 'source', mapping: source.mapping, timelineCues: timelineCues(source.subtitles.cues, source.mapping) } };
    if (action === 'caption.export') {
      const exported = exportSubtitleBytes(source.subtitles.cues, { format: params.format ?? source.subtitles.format });
      return { ...exported, src: source.src, fileName: path.basename(source.src).replace(/\.[^.]+$/, '') + (exported.format === 'srt' ? '.srt' : '.vtt') };
    }
    filmGuard(project, request.expectedHash);
    const opId = String(request.opId ?? '');
    if (!/^[A-Za-z0-9._:/-]{1,180}$/.test(opId)) return failure('OP_ID_REQUIRED', '字幕写入需要稳定的opId');
    const fingerprint = sha(JSON.stringify(stable(request))), prior = (await receipts(project)).value.entries[opId];
    if (prior) {
      if (prior.fingerprint !== fingerprint) return failure('OP_ID_REUSED', '同一opId不能用于不同字幕操作', 409);
      if (prior.state === 'pending') return failure('CAPTION_RESULT_UNKNOWN', '上次操作结果不明，请先核对当前字幕，禁止直接重试', 409);
      if (prior.state === 'job' && mediaServices?.list) {
        const job = mediaServices.list(project.projectId).find(j => j.id === prior.result?.job?.id);
        if (!job) return failure('CAPTION_JOB_RECOVERY_REQUIRED', '后台任务已不在本进程中，请先检查字幕与任务结果再新建操作', 409);
        return { ...prior.result, job, replayed: true };
      }
      return { ...prior.result, replayed: true };
    }
    const requestedSubtitleHash = Object.hasOwn(request, 'expectedSubtitleHash') ? request.expectedSubtitleHash : params.expectedSubtitleHash;
    if (requestedSubtitleHash !== undefined && requestedSubtitleHash !== source.subtitles.hash) return failure('SUBTITLE_CONFLICT', '字幕已变化，请刷新后重试', 409);
    if (['caption.recognize', 'caption.translate'].includes(action)) {
      if (!mediaServices?.start) return failure('CAPABILITY_UNAVAILABLE', '尚未配置真实字幕服务', 409);
      if (action === 'caption.translate' && !source.subtitles.cues.length) return failure('SUBTITLE_EMPTY', '没有可翻译的字幕');
      if (action === 'caption.recognize' && !/\.(mp4|m4v|mov|webm|mkv|avi|wav|mp3|m4a|aac|flac|ogg)$/i.test(source.src)) return failure('CAPTION_SOURCE_INVALID', '识别需要真实视频或音轨');
      let targetSource = source.src, targetHash = source.subtitles.hash;
      if (action === 'caption.translate' && params.replace !== true) {
        const language = String(params.language ?? 'translated').normalize('NFKC').replace(/[^\p{L}\p{N}-]+/gu, '-').slice(0, 32) || 'translated';
        targetSource = source.src.replace(/\.[^/.]+$/, '') + `.translated-${language}.mp4`;
        const target = await readSubtitles({ project, src: targetSource });
        if (!target.ok) return target;targetHash = target.hash;
      }
      await record(project, opId, { fingerprint, state: 'pending' });
      const taskRequest = { ...request, action, src: source.src, params: { ...params,
        ...(action === 'caption.translate' ? { cues: source.subtitles.cues } : {}),
        ...(source.mapping && source.selected ? { sourceStart: source.mapping.sourceIn, sourceEnd: Number.isFinite(source.mapping.sourceOut) ? source.mapping.sourceOut : undefined, clipId: source.mapping.clipId } : {}) } };
      const started = await mediaServices.start({ project, request: taskRequest, complete: (result, signal) => withProjectCaptionLock(project, async () => {
        try {
          signal?.throwIfAborted();filmGuard(project, request.expectedHash);await sidecarGuard(project, source.src, source.subtitles.hash);
          let cues = normalizeCues(result.cues);
          if (action === 'caption.translate') {
            if (cues.length !== source.subtitles.cues.length || cues.some((c,i) => c.start !== source.subtitles.cues[i].start || c.end !== source.subtitles.cues[i].end)) throw fault('TRANSLATION_INVALID', '翻译结果时间或条数变化，原字幕未修改');
          } else if (source.mapping && source.selected) {
            if (result.timeBase === 'clip') cues = cues.map(c => ({ ...c, start: c.start + Number(result.sourceStart ?? source.mapping.sourceIn), end: c.end + Number(result.sourceStart ?? source.mapping.sourceIn) }));
            const lo = source.mapping.sourceIn, hi = source.mapping.sourceOut ?? Infinity;
            cues = cues.map(c => ({ ...c, start: Math.max(c.start, lo), end: Math.min(c.end, hi) })).filter(c => c.end > c.start);
            if (!cues.length) throw fault('TRANSCRIPT_EMPTY', '选中片段范围内没有识别字幕，原文未修改');
            const outside = source.subtitles.cues.flatMap(c => [
              ...(c.start < lo ? [{ ...c, end: Math.min(c.end, lo) }] : []),
              ...(c.end > hi ? [{ ...c, start: Math.max(c.start, hi) }] : []),
            ]).filter(c => c.end > c.start);
            cues = [...outside, ...cues];
          }
          if (action === 'caption.translate' && params.replace === true && source.subtitles.found) {
            const located = await locateSubtitle({ project, src: source.src });
            const original = await fs.readFile(await safePath(project.dir, located.file), 'utf8');
            const dir = path.join(project.dir, '.film', 'caption-originals');await fs.mkdir(dir, { recursive: true });
            if ((await fs.lstat(dir)).isSymbolicLink()) throw fault('PATH_ESCAPE', '字幕原文备份不能经过符号链接');
            const file = path.join(dir, `${sha(original)}.${source.subtitles.format}`);
            try { await fs.writeFile(file, original, { flag: 'wx', mode: 0o600 }); }
            catch (e) { if (e.code !== 'EEXIST' || (await fs.lstat(file)).isSymbolicLink() || sha(await fs.readFile(file)) !== sha(original)) throw e; }
          }
          const saved = await save(project, targetSource, cues, source.subtitles.format, request.expectedHash, targetHash, signal);
          const completed = resultOf(saved, { ...source, src: targetSource });
          if (saved.ok && targetSource !== source.src) { completed.mediaSrc = source.src;completed.src = saved.file; }
          await record(project, opId, { fingerprint, state: 'done', result: completed });return completed;
        } catch (e) { const result = failure(signal?.aborted || e.name === 'AbortError' ? 'CANCELLED' : e.code ?? 'CAPTION_JOB_FAILED', e.message, e.status ?? 400);await record(project, opId, { fingerprint, state: 'done', result });return result; }
      }) });
      await record(project, opId, { fingerprint, state: started.ok ? 'job' : 'done', result: started });
      return started;
    }
    let cues = source.subtitles.cues, format = source.subtitles.format;
    if (action === 'caption.import') {
      let bytes;
      const base64 = params.dataBase64 ?? params.data ?? request.data;
      if (base64 !== undefined) {
        if (typeof base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length > 3 * 1024 * 1024) return failure('SUBTITLE_IMPORT_INVALID', '字幕上传数据无效或过大');
        bytes = Buffer.from(base64, 'base64');
      } else bytes = Buffer.from(String(params.content ?? request.text ?? ''), 'utf8');
      const imported = importSubtitleBytes(bytes, { name: params.fileName ?? request.name, format: params.format });
      if (!imported.ok) return imported;
      cues = sourceCues(imported.cues, request, source.mapping);format = imported.format;
    } else if (action === 'caption.add') cues = [...cues, ...sourceCues([params.cue ?? { start: params.start ?? request.target?.at, end: params.end, text: params.text ?? request.text }], request, source.mapping)];
    else if (action === 'caption.update' || action === 'caption.remove') {
      const index = Number(params.index ?? request.index);
      if (!Number.isInteger(index) || index < 0 || index >= cues.length) return failure('SUBTITLE_INDEX_INVALID', '请先选择有效的字幕段');
      if (action === 'caption.remove') cues = cues.filter((_,i) => i !== index);
      else {
        const patch = params.cue ?? { ...(params.start === undefined ? {} : { start: params.start }), ...(params.end === undefined ? {} : { end: params.end }), ...(params.text === undefined && request.text === undefined ? {} : { text: params.text ?? request.text }) };
        let next = { ...cues[index], ...patch };
        if (params.timeBase === 'timeline') {
          if (!source.mapping) throw fault('CAPTION_MAPPING_REQUIRED', '时间线时间需要明确媒体片段');
          const m = source.mapping;
          next = { ...next, start: patch.start === undefined ? cues[index].start : m.sourceIn + (Number(patch.start) - m.at) * m.speed, end: patch.end === undefined ? cues[index].end : m.sourceIn + (Number(patch.end) - m.at) * m.speed };
        }
        cues = cues.map((c,i) => i === index ? next : c);
      }
    } else return failure('UNKNOWN_ACTION', '未知字幕操作');
    cues = normalizeCues(cues);
    await record(project, opId, { fingerprint, state: 'pending' });
    const saved = await save(project, source.src, cues, format, request.expectedHash, source.subtitles.hash);
    const result = resultOf(saved, source);await record(project, opId, { fingerprint, state: 'done', result });return result;
  }
  async function action(request, context) {
    try { return await withProjectCaptionLock(context.project, () => perform(request, context)); }
    catch (e) { return failure(e.code ?? 'CAPTION_ACTION_FAILED', e.message ?? '字幕操作失败', e.status ?? 400); }
  }
  return { snapshot, action };
}

