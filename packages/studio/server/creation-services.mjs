// @ts-nocheck -- Dynamic validated HTTP/domain boundary; covered by integration tests.
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { safePath, writeSceneBundle } from './creation-library-store.mjs';
import { mediaKindOf, safeBaseName, MAX_UPLOAD_BYTES } from './media-import.mjs';
import { probeMedia } from '../../render/verify.mjs';
import { applyCreationLibraryAction } from './creation-library.mjs';
import { synthesizeLibraryAudio } from './media-services.mjs';

const digest = b => createHash('sha256').update(b).digest('hex');
const fault = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
/** Import to the asset pool, without implicitly changing the timeline. Content
 * addressed names make upload retries stable and never overwrite an old source. */
export async function importCreationMedia({ project, name, data, source }) {
  const kind = mediaKindOf(name);
  if (!kind) throw fault('MEDIA_UNSUPPORTED', '请选择视频、音频或图片；网页请使用 HTML 导入');
  let bytes;
  if (source) {
    if (typeof source !== 'string' || !path.isAbsolute(source)) throw fault('SOURCE_INVALID', '导入源必须来自系统文件选择器');
    const info = await fs.stat(source);
    if (!info.isFile() || info.size > 2 * 1024 ** 3) throw fault('MEDIA_TOO_LARGE', '素材不是普通文件或超过 2GB');
    return streamCreationMedia({project, name, stream:createReadStream(source)});
  } else {
    if (typeof data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length > Math.ceil(MAX_UPLOAD_BYTES * 1.4)) throw fault('UPLOAD_INVALID', '素材上传数据无效或过大');
    bytes = Buffer.from(data, 'base64');
    if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) throw fault('MEDIA_TOO_LARGE', '单次上传需要 1 字节至 24MB');
  }
  const safeName = safeBaseName(name), hash = digest(bytes), rel = `assets/${hash.slice(0, 12)}-${safeName}`;
  await fs.mkdir(path.join(project.dir, 'assets'), { recursive: true });
  const file = await safePath(project.dir, rel, { missing: true });
  let created = false;
  try { await fs.writeFile(file, bytes, { flag: 'wx' }); created = true; }
  catch (e) { if (e.code !== 'EEXIST') throw e; if (digest(await fs.readFile(file)) !== hash) throw fault('IMPORT_COLLISION', '同名资源内容不同，未覆盖'); }
  try {
    const info = await probeMedia(file);
    if ((kind === 'video' && !info.video) || (kind === 'sound' && !info.audio)) throw fault('MEDIA_INVALID', '文件内容与媒体类型不匹配');
    return { ok: true, itemId: `project:${rel}`, src: rel, kind, bytes: bytes.length, durationSec: info.format?.durationSec ?? info.video?.durationSec ?? info.audio?.durationSec ?? null };
  } catch (e) { if (created) await fs.unlink(file).catch(() => {}); throw fault('MEDIA_INVALID', '无法读取此素材，请检查文件格式'); }
}

/** Large browser files are streamed into a private pending file, not converted
 * to a multi-gigabyte base64 JSON string. Failed uploads never appear in pool. */
export async function streamCreationMedia({project,name,stream}) {
  const kind=mediaKindOf(name);
  if(!kind) throw fault('MEDIA_UNSUPPORTED','请选择视频、音频或图片');
  const dir=path.join(project.dir,'assets'); await fs.mkdir(dir,{recursive:true});
  await safePath(project.dir,'assets',{directory:true});
  const pending=path.join(dir,`.pending-upload-${process.pid}-${randomUUID()}`);
  const hash=createHash('sha256'); let size=0;
  try {
    await pipeline(stream,new Transform({transform(chunk,encoding,callback){size+=chunk.length;if(size>2*1024**3){callback(fault('MEDIA_TOO_LARGE','单个素材超过2GB'));return;}hash.update(chunk);callback(null,chunk);}}),createWriteStream(pending,{flags:'wx',mode:0o600}));
    if(!size) throw fault('UPLOAD_INVALID','文件为空');
    const info=await probeMedia(pending);
    if((kind==='video'&&!info.video)||(kind==='sound'&&!info.audio)) throw fault('MEDIA_INVALID','文件内容与类型不符');
    const fullHash=hash.digest('hex');
    const rel=`assets/${fullHash.slice(0,12)}-${safeBaseName(name)}`;
    const file=await safePath(project.dir,rel,{missing:true});
    try { await fs.copyFile(pending,file,1); } catch(e) {
      if(e.code!=='EEXIST') throw e;
      const existing=await fs.stat(file);
      if(!existing.isFile()||existing.size!==size) throw fault('IMPORT_COLLISION','同名资源内容已变化，未覆盖');
      const existingHash=createHash('sha256');
      for await(const chunk of createReadStream(file)) existingHash.update(chunk);
      if(existingHash.digest('hex')!==fullHash) throw fault('IMPORT_COLLISION','同名资源内容已变化，未覆盖');
    }
    return {ok:true,itemId:`project:${rel}`,src:rel,kind,bytes:size,durationSec:info.format?.durationSec??info.video?.durationSec??info.audio?.durationSec??null};
  } finally { await fs.rm(pending,{force:true}).catch(()=>{}); }
}

const audioRows = [
  ['sound', 'tap', '轻触提示', 0.5], ['sound', 'rise', '上扬提示', 1], ['sound', 'mark', '重点强调', 0.8],
  ['sound', 'done', '完成提示', 1.2], ['sound', 'soft', '轻柔过门', 1.5], ['sound', 'pop', '卡片出现', 0.4],
  ['music', 'ambient', '平静铺底', 16], ['music', 'pulse', '科技脉冲', 16], ['music', 'bed', '轻快解说', 16],
];
const originalAudio = new Map(audioRows.map(([category, key, name, duration]) => [`builtin-audio:${category}-${key}`, { category, key, name, duration }]));
const originalAudioBytes = new Map();
/** Only these nine original assets may be served from the shared library. The
 * caller cannot turn a catalog identity or asset name into an arbitrary path. */
export async function resolveCreationAudio({ libraryRoot, itemId, asset = 'audio.wav' }) {
  const row = originalAudio.get(itemId);
  if (!row) throw fault('ITEM_NOT_FOUND', '原创声音条目不存在', 404);
  if (asset !== 'audio.wav') throw fault('PATH_ESCAPE', '此条目只提供自身的声音素材');
  if (!originalAudioBytes.has(itemId)) originalAudioBytes.set(itemId, synthesizeLibraryAudio(`${row.category}-${row.key}`, row.duration));
  const bytes = originalAudioBytes.get(itemId), sha = digest(bytes);
  const folder = `builtin/audio/${row.category}-${row.key}/${sha}`;
  // This cache write is independent of the project. Existing differing bytes
  // are rejected, never overwritten; the project receives a copy only on Apply.
  await writeSceneBundle(libraryRoot, folder, { 'audio.wav': bytes });
  const file = await safePath(libraryRoot, `${folder}/audio.wav`);
  return { root: path.dirname(file), source: 'audio.wav', file, bytes: bytes.length, durationSec: row.duration };
}
export async function creationServiceItems({ project }, mediaServices) {
  const items = [];
  for (const [id, { category, name, duration }] of originalAudio) {
    items.push({ id, name, category, group: '原创本地', source: 'builtin', kind: 'sound', mediaKind: 'sound', durationSec: duration, availability: 'ready', previewUrl: `/api/projects/${encodeURIComponent(project.projectId)}/creation-library/files/${encodeURIComponent(id)}/audio.wav`, tags: ['原创', '离线', category] });
  }
  const state = await mediaServices.settings();
  const voices=state.config.tts.mode==='system'?state.voices:(state.config.tts.voice?[{id:state.config.tts.voice,name:state.config.tts.voice,language:'服务配置'}]:[]);
  for (const voice of voices) items.push({ id: `voice:${voice.id}`, name: voice.name, category: 'voice', group: voice.language.startsWith('zh') ? '中文' : '其他语言', source: 'builtin', kind: 'voice', availability: state.capabilities.voice.ready ? 'ready' : 'needs-provider', params: { voice: voice.id, language: voice.language }, tags: [voice.language, '系统声音'] });
  return items;
}

export async function startCreationMediaTask({ project, registry, request, libraryRoot, services, mediaServices }) {
  if (request.action === 'job.cancel') return mediaServices.cancel(project.projectId, request.params?.jobId ?? request.itemId);
  if (request.action !== 'media.tts') return { ok: false, code: 'UNKNOWN_ACTION', message: '未知媒体动作' };
  const itemVoice = String(request.itemId ?? '').startsWith('voice:') ? request.itemId.slice(6) : undefined;
  return mediaServices.start({ project, validate: () => {const before=registry.docOf(project.projectId);return before&&request.expectedHash===before.hash?{ok:true}:{ok:false,code:'CONFLICT',status:409,message:'工程已变化，请刷新后重试'};}, request: { ...request, params: { ...request.params, ...(itemVoice ? { voice: itemVoice } : {}) } }, complete: async (result, signal) => {
    signal.throwIfAborted();
    const current = registry.docOf(project.projectId);
    if (!current || current.hash !== request.expectedHash) return { ok: false, code: 'CONFLICT', message: '配音已生成但工程已变化，未插入；请刷新后重新生成' };
    const imported = await importCreationMedia({ project, name: result.name, source: result.file });
    signal.throwIfAborted();
    if (request.params?.previewOnly === true) return { ok: true, itemId: imported.itemId, src: imported.src };
    return applyCreationLibraryAction({ registry, project, libraryRoot, services, request: { action: 'resource.apply', itemId: imported.itemId, expectedHash: request.expectedHash, opId: `${request.opId}:apply`, target: { ...request.target, mode: request.target?.track == null ? 'new-track' : 'reject-overlap' } } });
  } });
}
