// @ts-nocheck -- Validated JSON boundary and owned subprocesses; tested with real and stub adapters.
/** Local-first media tasks. Config contains references, never credentials. All
 * generated media is staged before a caller explicitly inserts it through ops. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { parseSubtitles, normalizeCues } from '../../film-core/subtitle.mjs';
import { settingsPath } from './settings-store.mjs';
import { probeMedia } from '../../render/verify.mjs';

const storeQueues = new Map();
// Shared only inside this process: a second service object must not "recover" another live owner's job.
const liveJobs = new Map();
const MAX_JOB_RECEIPTS = 10000;
const STORE_BYTES = Symbol('original-media-receipt-bytes');
async function serialStore(file, fn) {
  const previous = storeQueues.get(file) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(fn); storeQueues.set(file, next);
  try { return await next; } finally { if (storeQueues.get(file) === next) storeQueues.delete(file); }
}
const stable = value => Array.isArray(value) ? value.map(stable) : plain(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const receiptKey = (projectId, opId) => `${projectId}:${opId}`;
const resultKeys = ['ok', 'hash', 'clipId', 'src', 'itemId', 'file', 'format', 'mediaSrc', 'clock', 'mapping'];
function durableResult(result) {
  if (!plain(result)) return undefined;
  const value = Object.fromEntries(resultKeys.filter(key => typeof result[key] === 'string' && result[key].length <= 4096 || key === 'ok' && typeof result[key] === 'boolean').map(key => [key, result[key]]));
  const mapping = result.mapping;
  if (plain(mapping) && typeof mapping.clipId === 'string' && mapping.clipId.length <= 512 && ['at', 'sourceIn', 'sourceOut', 'speed'].every(key => Number.isFinite(mapping[key]))) value.mapping = { clipId: mapping.clipId, at: mapping.at, sourceIn: mapping.sourceIn, sourceOut: mapping.sourceOut, speed: mapping.speed };
  return value;
}

const sha = value => createHash('sha256').update(value).digest('hex');
const defaults = () => ({
  tts: { mode: process.platform === 'darwin' ? 'system' : 'http', endpoint: '', model: '', voice: '', keyRef: null },
  asr: { mode: 'disabled', endpoint: '', model: '', binary: '', modelPath: '', keyRef: null },
  translate: { mode: 'disabled', endpoint: '', model: '', keyRef: null },
});
const fail = (code, message) => Object.assign(new Error(message), { code });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function endpoint(value) {
  if (!value) return '';
  let u; try { u = new URL(value); } catch { throw fail('CONFIG_INVALID', '服务地址必须是完整 URL'); }
  if (u.username || u.password || u.search || u.hash) throw fail('CONFIG_INVALID', '服务地址不能包含账号、密钥、查询参数或片段');
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw fail('CONFIG_INVALID', '远程服务必须使用 HTTPS');
  return u.href.replace(/\/$/, '');
}
export function normalizeMediaConfig(input) {
  if (!plain(input) || Object.keys(input).some(k => !['tts', 'asr', 'translate'].includes(k))) throw fail('CONFIG_INVALID', '未知媒体设置');
  const out = defaults();
  for (const [kind, initial] of Object.entries(out)) {
    const item = input[kind] ?? initial;
    if (!plain(item) || Object.keys(item).some(k => !Object.keys(initial).includes(k))) throw fail('CONFIG_INVALID', '配置只接受端点、模型、声音、路径与密钥引用');
    const modes = kind === 'tts' ? ['system', 'http'] : kind === 'asr' ? ['disabled', 'whisper-cli', 'http'] : ['disabled', 'http'];
    const row = { ...initial, ...item };
    if (!modes.includes(row.mode) || (row.keyRef !== null && row.keyRef !== 'model')) throw fail('CONFIG_INVALID', '不支持的服务类型或密钥引用');
    for (const [key, value] of Object.entries(row)) if (key !== 'keyRef' && (typeof value !== 'string' || value.length > 2048 || /[\x00-\x08\x0e-\x1f]/.test(value))) throw fail('CONFIG_INVALID', '配置字段无效');
    row.endpoint = endpoint(row.endpoint);
    out[kind] = row;
  }
  return out;
}

export function runMediaProcess(binary, args, { signal, timeoutMs = 120000, maxBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let out = '', err = '', size = 0, settled = false;
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], signal, windowsHide: true });
    let killTimer;
    const terminate = () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 500); killTimer.unref?.(); } };
    const timer = setTimeout(() => { terminate(); finish(fail('TIMEOUT', '媒体任务超时')); }, timeoutMs);
    signal?.addEventListener('abort', terminate, { once: true });
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    child.stdout.on('data', b => { size += b.length; if (size > maxBytes) { terminate(); finish(fail('OUTPUT_LIMIT', '媒体任务输出过大')); } else out += b; });
    child.stderr.on('data', b => { if (err.length < 4096) err += b; });
    child.on('error', e => finish(e));
    child.on('close', code => { clearTimeout(killTimer); signal?.removeEventListener('abort', terminate); finish(code === 0 ? null : fail('PROCESS_FAILED', `媒体工具退出（${code ?? 'signal'}）`), { stdout: out, stderr: err }); });
  });
}

export function createMediaServices(options = {}) {
  const configFile = options.configFile ?? path.join(path.dirname(settingsPath()), 'media-services.json');
  const run = options.run ?? runMediaProcess;
  const fetcher = options.fetch ?? fetch;
  const jobs = new Map(), receipts = new Map();
  const owner = Symbol('media-services-owner');
  const projectLoads = new Map(), pendingPersistence = new Set();
  let queue = Promise.resolve();
  async function storeFile(project) {
    if (!project?.projectId || typeof project.dir !== 'string') throw fail('JOB_PROJECT_INVALID', '媒体任务需要准确的工程目录');
    const root = await fs.realpath(project.dir), dir = path.join(root, '.film');
    await fs.mkdir(dir, { recursive: true });
    const info = await fs.lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) throw fail('JOB_STORE_PATH', '媒体任务目录不能经过符号链接');
    const file = path.join(dir, 'creation-media-jobs.json');
    try { const stat = await fs.lstat(file); if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw fail('JOB_STORE_PATH', '媒体回执必须是工程内的独立普通文件'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return file;
  }
  async function readStore(project, file) {
    let bytes;
    try { const stat = await fs.stat(file); if (stat.size > 16 * 1024 * 1024) throw fail('JOB_STORE_FULL', '媒体任务回执过大，请保留文件并人工检查'); bytes = await fs.readFile(file); }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, projectId: project.projectId, entries: [] }; throw error; }
    let data; try { data = JSON.parse(bytes.toString('utf8')); } catch { throw fail('JOB_STORE_INVALID', '媒体任务回执损坏，请保留文件检查，未启动新任务'); }
    if (data?.version !== 1 || typeof data.projectId !== 'string' || !data.projectId || data.projectId.length > 512 || !Array.isArray(data.entries) || data.entries.length > MAX_JOB_RECEIPTS || Object.keys(data).some(key => !['version', 'projectId', 'entries'].includes(key))) throw fail('JOB_STORE_INVALID', '媒体任务回执格式或工程身份无效');
    const seen = new Set();
    for (const entry of data.entries) {
      const job = entry?.job;
      if (!plain(entry) || Object.keys(entry).some(key => !['opId', 'fingerprint', 'job'].includes(key)) || !/^[A-Za-z0-9._:-]{1,180}$/.test(String(entry?.opId ?? '')) || !/^[a-f0-9]{64}$/i.test(String(entry?.fingerprint ?? '')) || seen.has(entry.opId)
        || !plain(job) || !/^[a-zA-Z0-9-]{1,100}$/.test(String(job.id ?? '')) || job.projectId !== data.projectId || !['tts', 'asr', 'translate'].includes(job.kind)
        || Object.keys(job).some(key => !['id', 'projectId', 'kind', 'state', 'progress', 'code', 'error', 'result'].includes(key))
        || !['queued', 'running', 'completed', 'cancelled', 'failed'].includes(job.state)
        || job.result !== undefined && (!plain(job.result) || Object.keys(job.result).some(key => !resultKeys.includes(key)))) throw fail('JOB_STORE_INVALID', '媒体任务回执条目无效，未丢弃旧证据');
      seen.add(entry.opId);
    }
    Object.defineProperty(data, STORE_BYTES, { value: bytes });
    return data;
  }
  /** A copied project keeps its old receipts as evidence, not as authority for
   * this project. Only an explicit new task may archive and replace the store. */
  async function archiveForeignStore(project, file, data) {
    if (data.projectId === project.projectId) return undefined;
    const bytes = data[STORE_BYTES];
    if (!Buffer.isBuffer(bytes)) throw fail('JOB_STORE_INVALID', '无法完整保全旧媒体回执，未启动新任务');
    await storeFile(project);
    const dir = path.join(path.dirname(file), 'creation-media-jobs.archive');
    try { await fs.mkdir(dir); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await fs.lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) throw fail('JOB_STORE_PATH', '旧媒体回执归档目录必须是工程内普通目录');
    const archive = path.join(dir, `${sha(bytes)}.json`);
    async function verifyArchive() {
      const stat = await fs.lstat(archive);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw fail('JOB_STORE_PATH', '旧媒体回执归档必须是独立普通文件');
      if (stat.size !== bytes.length || !(await fs.readFile(archive)).equals(bytes)) throw fail('JOB_STORE_ARCHIVE_COLLISION', '同名旧回执归档内容不同，未覆盖或启动新任务');
    }
    try { await verifyArchive(); return bytes; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const tmp = path.join(dir, `${sha(bytes)}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(tmp, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
      // link publishes a fully written file atomically without replacing an
      // existing archive. The private temporary link is then removed.
      try { await fs.link(tmp, archive); } catch (error) { if (error.code !== 'EEXIST') throw error; await verifyArchive(); }
    } finally { await handle?.close().catch(() => {}); await fs.unlink(tmp).catch(() => {}); }
    await verifyArchive();
    return bytes;
  }
  function durableEntry(job) {
    return { opId: job.opId, fingerprint: job.fingerprint, job: { id: job.id, projectId: job.projectId, kind: job.kind, state: job.state, progress: job.progress,
      ...(job.code ? { code: String(job.code).slice(0, 100) } : {}),
      // Never persist arbitrary adapter errors, prompts, model output or authorization headers.
      ...(job.error ? { error: job.state === 'cancelled' ? '已取消' : job.code === 'JOB_INTERRUPTED' ? '上次任务已中断，请先核对工程与素材，未自动重启' : '任务未完成，请查看工程后决定下一步' } : {}),
      ...(job.result ? { result: durableResult(job.result) } : {}) } };
  }
  async function writeStore(project, file, data, expectedSource) {
    if (await storeFile(project) !== file) throw fail('JOB_STORE_PATH', '工程任务目录已变化');
    const tmp = `${file}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fs.open(tmp, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(data) + '\n'); await handle.sync(); await handle.close(); handle = null;
      await storeFile(project);
      if (expectedSource && !(await fs.readFile(file)).equals(expectedSource)) throw fail('JOB_STORE_CONFLICT', '旧媒体回执在保全过程中已变化，未替换或启动新任务');
      await fs.rename(tmp, file);
    } finally { await handle?.close().catch(() => {}); await fs.unlink(tmp).catch(() => {}); }
  }
  function adopt(project, file, data) {
    if (data.projectId !== project.projectId) return false;
    let recovered = false;
    for (const entry of data.entries) {
      const key = receiptKey(project.projectId, entry.opId);
      if (receipts.has(key)) continue;
      let job = liveJobs.get(`${file}:${entry.job.id}`);
      if (!job) {
        job = { ...entry.job, project, opId: entry.opId, fingerprint: entry.fingerprint, controller: new AbortController(), store: file };
        if (['queued', 'running'].includes(job.state)) { job.state = 'failed'; job.code = 'JOB_INTERRUPTED'; job.error = '上次任务已中断，请先核对工程与素材，未自动重启'; job.progress = 0; recovered = true; }
      }
      jobs.set(job.id, job); receipts.set(key, { id: job.id, fingerprint: entry.fingerprint });
    }
    return recovered;
  }
  function mergeStore(project, data) {
    if (data.projectId !== project.projectId) throw fail('JOB_STORE_PROJECT_MISMATCH', '媒体回执属于其他工程，未合并旧任务');
    const entries = new Map(data.entries.map(entry => [entry.opId, entry]));
    for (const job of jobs.values()) if (job.projectId === project.projectId) entries.set(job.opId, durableEntry(job));
    if (entries.size > MAX_JOB_RECEIPTS) throw fail('JOB_STORE_FULL', '媒体任务回执已满，未删除旧回执或启动新任务');
    return { version: 1, projectId: project.projectId, entries: [...entries.values()] };
  }
  async function loadProject(project) {
    const file = await storeFile(project);
    const identity = `${file}:${project.projectId}`;
    if (!projectLoads.has(identity)) {
      const task = serialStore(file, async () => { const data = await readStore(project, file); const recovered = adopt(project, file, data); if (recovered) await writeStore(project, file, mergeStore(project, data)); return file; });
      projectLoads.set(identity, task); task.catch(() => { if (projectLoads.get(identity) === task) projectLoads.delete(identity); });
    }
    await projectLoads.get(identity); return file;
  }
  async function persist(project) {
    const file = await storeFile(project);
    await serialStore(file, async () => { const data = await readStore(project, file); await writeStore(project, file, mergeStore(project, data)); });
  }
  function persistLater(job) {
    const task = persist(job.project).catch(() => { job.persistenceIssue = 'JOB_STATE_WRITE_FAILED'; });
    pendingPersistence.add(task); task.finally(() => pendingPersistence.delete(task));
  }
  async function readConfig() {
    try { return normalizeMediaConfig(JSON.parse(await fs.readFile(configFile, 'utf8'))); }
    catch (e) { if (e.code === 'ENOENT') return defaults(); throw e; }
  }
  let voiceCache = null;
  async function voices() {
    if (voiceCache) return voiceCache;
    if (process.platform !== 'darwin' && !options.run) return [];
    try {
      const result = await run('/usr/bin/say', ['-v', '?'], { timeoutMs: 5000 });
      voiceCache = result.stdout.split('\n').map(line => /^(.+?)\s+([a-z]{2}[_-][A-Z]{2})\s+#/.exec(line)).filter(Boolean).map(m => ({ id: m[1].trim(), name: m[1].trim(), language: m[2] }));
      return voiceCache;
    } catch { return []; }
  }
  async function capabilities(config = null) {
    const c = config ?? await readConfig();
    const canExec = async p => !!p && await fs.access(p, 1).then(() => true).catch(() => false);
    const remote = row => row.mode === 'http' && !!row.endpoint && !!row.model;
    const system = c.tts.mode === 'system' && (process.platform === 'darwin' || !!options.run);
    const whisper = c.asr.mode === 'whisper-cli' && await canExec(c.asr.binary) && await fs.stat(c.asr.modelPath).then(s => s.isFile()).catch(() => false);
    return {
      voice: { ready: system || remote(c.tts), provider: system ? 'system-say' : 'http', reason: system || remote(c.tts) ? '' : '请配置语音服务' },
      subtitle: { ready: whisper || remote(c.asr), provider: whisper ? 'whisper-cli' : 'http', reason: whisper || remote(c.asr) ? '' : '请配置本地识别工具和模型，或识别服务' },
      translate: { ready: remote(c.translate), provider: 'http', reason: remote(c.translate) ? '' : '请配置翻译服务' },
      sound: { ready: true, provider: 'original-local' }, music: { ready: true, provider: 'original-local' },
    };
  }
  async function settings() { const config = await readConfig(); return { ok: true, config, capabilities: await capabilities(config), voices: await voices() }; }
  async function saveConfig(input) {
    const config = normalizeMediaConfig(input);
    await fs.mkdir(path.dirname(configFile), { recursive: true });
    const tmp = `${configFile}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await fs.rename(tmp, configFile);
    return settings();
  }
  const view = j => ({ id: j.id, projectId: j.projectId, kind: j.kind, state: j.state, progress: j.progress, ...(j.error ? { error: j.error, code: j.code } : {}), ...(j.result ? { result: j.result } : {}) });
  const list = projectId => [...jobs.values()].filter(j => j.projectId === projectId).map(view);
  async function listForProject(project) { await loadProject(project); return list(project.projectId); }
  function cancel(projectId, id) {
    const j = jobs.get(id);
    if (!j || j.projectId !== projectId) return { ok: false, code: 'JOB_NOT_FOUND', message: '任务不存在' };
    if(j.committing) return {ok:false,code:'JOB_FINALIZING',message:'正在写入工程，请稍候'};
    if (['queued', 'running'].includes(j.state)) { j.state = 'cancelled'; j.controller.abort(); persistLater(j); }
    return { ok: true, job: view(j) };
  }
  async function authHeaders(c) {
    if (c.keyRef !== 'model') return {};
    const key = await options.resolveKey?.('model');
    if (!key) throw fail('KEY_NOT_CONFIGURED', '请在模型设置中配置密钥');
    return { Authorization: `Bearer ${key}` };
  }
  async function remote(c, suffix, body, signal, json = true) {
    const url = endpoint(c.endpoint);
    if (!url || !c.model) throw fail('PROVIDER_NOT_CONFIGURED', '请先配置媒体服务和模型');
    const res = await fetcher(url + suffix, { method: 'POST', signal, redirect: 'error', headers: { ...await authHeaders(c), ...(json ? { 'content-type': 'application/json' } : {}) }, body: json ? JSON.stringify(body) : body });
    if (!res.ok) throw fail('PROVIDER_FAILED', `媒体服务返回 HTTP ${res.status}`);
    return res;
  }
  async function start({ project, request, complete, validate }) {
    const kind = request.action === 'media.tts' ? 'tts' : request.action === 'caption.recognize' ? 'asr' : request.action === 'caption.translate' ? 'translate' : null;
    if (!kind) return { ok: false, code: 'UNKNOWN_ACTION', message: '未知媒体任务' };
    if (!/^[A-Za-z0-9._:-]{1,180}$/.test(String(request.opId ?? ''))) return { ok: false, code: 'OP_ID_REQUIRED', message: '任务需要稳定的 opId' };
    const params = request.params ?? {};
    const text = String(request.text ?? params.text ?? '');
    if (kind === 'tts' && (!text.trim() || text.length > 12000)) return { ok: false, code: 'TEXT_INVALID', message: '请输入 1–12000 字的配音文本' };
    const file = await loadProject(project);
    const fingerprint = sha(JSON.stringify(stable({ project: project.projectId, request })));
    const receipt = `${project.projectId}:${request.opId}`;
    if (receipts.has(receipt)) {
      const prev = receipts.get(receipt);
      return prev.fingerprint === fingerprint ? { ok: true, job: view(jobs.get(prev.id)), replay: true } : { ok: false, code: 'OP_ID_REUSED', message: '同一 opId 的内容不同' };
    }
    const initial = await validate?.();
    if (initial?.ok === false) return initial;
    const c = await readConfig();
    const cap = await capabilities(c);
    if (!cap[kind === 'tts' ? 'voice' : kind === 'asr' ? 'subtitle' : kind].ready) return { ok: false, code: 'PROVIDER_NOT_CONFIGURED', message: '请先在设置中配置对应媒体服务' };
    let j, replay;
    await serialStore(file, async () => {
      const data = await readStore(project, file); adopt(project, file, data);
      if (receipts.has(receipt)) { const prev = receipts.get(receipt); replay = prev.fingerprint === fingerprint ? { ok: true, job: view(jobs.get(prev.id)), replay: true } : { ok: false, code: 'OP_ID_REUSED', message: '同一opId的内容不同' }; return; }
      j = { id: randomUUID(), projectId: project.projectId, project, owner, opId: request.opId, fingerprint, store: file, kind, state: 'queued', progress: 0, controller: new AbortController() };
      jobs.set(j.id, j); receipts.set(receipt, { id: j.id, fingerprint }); liveJobs.set(`${file}:${j.id}`, j);
      try {
        const original = await archiveForeignStore(project, file, data);
        const current = original ? { version: 1, projectId: project.projectId, entries: [] } : data;
        await writeStore(project, file, mergeStore(project, current), original);
      }
      catch (error) { jobs.delete(j.id); receipts.delete(receipt); liveJobs.delete(`${file}:${j.id}`); throw error; }
    });
    if (replay) return replay;
    queue = queue.then(async () => {
      if (j.state === 'cancelled') { liveJobs.delete(`${file}:${j.id}`); await persist(project).catch(() => { j.persistenceIssue = 'JOB_STATE_WRITE_FAILED'; }); return; }
      const dir = path.join(project.dir, '.film', 'media-jobs', j.id);
      const signal = AbortSignal.any([j.controller.signal, AbortSignal.timeout(10 * 60 * 1000)]);
      let ownedStage = false;
      try {
        await storeFile(project);
        const parent = path.dirname(dir); await fs.mkdir(parent, { recursive: true });
        if ((await fs.lstat(parent)).isSymbolicLink()) throw fail('JOB_STORE_PATH', '任务暂存目录不能经过符号链接');
        await fs.mkdir(dir, { recursive: false }); ownedStage = true;
        j.state = 'running'; j.progress = 0.1;
        await persist(project); signal.throwIfAborted();
        let result;
        if (kind === 'tts') {
          const output = path.join(dir, 'speech.wav');
          if (c.tts.mode === 'system') {
            const available = await voices();
            const voice = String(params.voice ?? c.tts.voice ?? '');
            if (voice && !available.some(v => v.id === voice)) throw fail('VOICE_NOT_FOUND', '所选系统声音不可用');
            const input = path.join(dir, 'speech.txt'); await fs.writeFile(input, text);
            const aiff = path.join(dir, 'speech.aiff');
            await run('/usr/bin/say', [...(voice ? ['-v', voice] : []), '-f', input, '-o', aiff], { signal });
            await run(options.ffmpeg ?? process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-y', '-i', aiff, '-ac', '1', '-ar', '48000', output], { signal });
          } else {
            const res = await remote(c.tts, '/audio/speech', { model: c.tts.model, voice: params.voice || c.tts.voice || 'alloy', input: text, response_format: 'wav' }, signal);
            const bytes = Buffer.from(await res.arrayBuffer());
            if (!bytes.length || bytes.length > 100 * 1024 * 1024) throw fail('AUDIO_INVALID', '配音结果大小无效');
            await fs.writeFile(output, bytes);
          }
          let verified;
          try { verified = await probeMedia(output); } catch { throw fail('AUDIO_INVALID', '语音服务没有返回有效音频'); }
          if (!verified.audio || !(verified.audio.durationSec > 0 || verified.format.durationSec > 0)) throw fail('AUDIO_INVALID', '语音服务没有返回有效音频');
          result = { file: output, name: `配音-${sha(text).slice(0, 8)}.wav` };
        } else if (kind === 'asr') {
          const rel = String(request.src ?? params.src ?? '');
          if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw fail('SOURCE_INVALID', '请选择当前工程音频');
          const root = await fs.realpath(project.dir), source = await fs.realpath(path.resolve(project.dir, rel));
          if (!source.startsWith(root + path.sep)) throw fail('SOURCE_INVALID', '音频越出工程目录');
          const audio = path.join(dir, 'audio.wav');
          const sourceStart = Number(params.sourceStart ?? 0), sourceEnd = params.sourceEnd == null ? null : Number(params.sourceEnd);
          if (!Number.isFinite(sourceStart) || sourceStart < 0 || (sourceEnd !== null && (!Number.isFinite(sourceEnd) || sourceEnd <= sourceStart))) throw fail('SOURCE_RANGE_INVALID', '识别源区间无效');
          await run(options.ffmpeg ?? process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-y', ...(sourceStart ? ['-ss', String(sourceStart)] : []), '-i', source, ...(sourceEnd !== null ? ['-t', String(sourceEnd - sourceStart)] : []), '-vn', '-ar', '16000', '-ac', '1', audio], { signal });
          let cues;
          if (c.asr.mode === 'whisper-cli') {
            const stem = path.join(dir, 'recognized');
            await run(c.asr.binary, ['-m', c.asr.modelPath, '-f', audio, '-osrt', '-of', stem, '-l', String(params.language || 'auto')], { signal, timeoutMs: 9 * 60 * 1000 });
            cues = parseSubtitles(await fs.readFile(stem + '.srt', 'utf8'), { format: 'srt' }).cues;
          } else {
            const bytes = await fs.readFile(audio);
            if (bytes.length > 24 * 1024 * 1024) throw fail('AUDIO_TOO_LARGE', '识别音频超过单次 24MB 限制，请先裁短');
            const form = new FormData(); form.set('file', new Blob([bytes], { type: 'audio/wav' }), 'audio.wav'); form.set('model', c.asr.model); form.set('response_format', 'srt');
            if (params.language && params.language !== 'auto') form.set('language', String(params.language));
            const res = await remote(c.asr, '/audio/transcriptions', form, signal, false);
            cues = parseSubtitles(await res.text(), { format: 'srt' }).cues;
          }
          if (!cues.length) throw fail('TRANSCRIPT_EMPTY', '识别服务没有返回带时间的字幕');
          result = { cues, src: rel, format: 'vtt', timeBase: 'clip', sourceStart };
        } else {
          const cues = normalizeCues(params.cues);
          const language = String(params.language || '英语');
          if (!cues.length || cues.length > 2000) throw fail('CUES_INVALID', '没有可翻译的字幕或条数过多');
          const res = await remote(c.translate, '/chat/completions', { model: c.translate.model, messages: [{ role: 'system', content: `Translate subtitle texts into ${language}. Return only a JSON array of strings with exactly ${cues.length} entries, in the same order. Preserve meaning and no extra commentary.` }, { role: 'user', content: JSON.stringify(cues.map(c => c.text)) }] }, signal);
          const body = await res.json(); const content = body.choices?.[0]?.message?.content ?? '';
          let texts; try { texts = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { throw fail('TRANSLATION_INVALID', '翻译结果格式无效，原字幕未更改'); }
          if (!Array.isArray(texts) || texts.length !== cues.length || texts.some(t => typeof t !== 'string' || t.length > 20000)) throw fail('TRANSLATION_INVALID', '翻译条数不匹配，原字幕未更改');
          result = { cues: cues.map((cue, i) => ({ ...cue, text: texts[i] })), language, src: request.src ?? params.src };
        }
        signal.throwIfAborted(); j.progress = 0.9;
        j.committing = true;
        await persist(project);
        const applied = await complete(result, signal);
        if (applied?.ok === false) throw fail(applied.code ?? 'APPLY_FAILED', applied.message ?? '生成成功但工程有变化，请重新加入');
        j.result = applied; j.state = 'completed'; j.progress = 1;
      } catch (error) {
        j.state = j.state === 'cancelled' || j.controller.signal.aborted ? 'cancelled' : 'failed';
        j.code = error.code ?? 'MEDIA_FAILED';
        j.error = j.state === 'cancelled' ? '已取消' : String(error.message ?? '媒体任务失败').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
      } finally {
        j.committing = false;
        try { await persist(project); } catch { j.persistenceIssue = 'JOB_STATE_WRITE_FAILED'; }
        liveJobs.delete(`${file}:${j.id}`);
        if (ownedStage) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }).catch(() => undefined);
    return { ok: true, job: view(j) };
  }
  return { settings, readConfig, saveConfig, capabilities, voices, list, listForProject, start, cancel,
    settled: async () => { await queue; while (pendingPersistence.size) await Promise.all([...pendingPersistence]); },
    close: () => { for (const j of jobs.values()) if (j.owner === owner && ['queued', 'running'].includes(j.state)) cancel(j.projectId, j.id); } };
}

/** Deterministic original PCM assets; no network catalog or copyrighted sample. */
export function synthesizeLibraryAudio(id, duration = 2) {
  const rate = 24000, n = Math.floor(rate * Math.max(0.2, Math.min(30, duration))), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF'); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  const seed = parseInt(sha(id).slice(0, 8), 16), music = /music|bed|pulse|ambient/.test(id);
  const chords = [130.81, 164.81, 196, 261.63];
  for (let i = 0; i < n; i++) {
    const t = i / rate, p = i / n, env = Math.min(1, p * 24, (1 - p) * 12);
    const tone = music ? chords.reduce((v, f, j) => v + Math.sin(2 * Math.PI * f * (1 + seed % 3 * 0.12) * t + j) * 0.12, 0) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 1.5 * t)) : Math.sin(2 * Math.PI * (220 + seed % 500) * t * (1 + (1 - p) * 2)) * Math.exp(-p * 6) * 0.55;
    b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, tone * env)) * 24000), 44 + i * 2);
  }
  return b;
}
