// @ts-nocheck -- HTTP JSON boundary. Domain modules validate semantic inputs.
import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { readCreationLibrary, applyCreationLibraryAction, resolveCreationLibraryFile } from './creation-library.mjs';
import { importCreationMedia, streamCreationMedia, creationServiceItems, startCreationMediaTask } from './creation-services.mjs';
import { createCreationCaptions } from './creation-captions.mjs';
import { creationPreviewScript } from './creation-preview.mjs';

const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value)); };
async function bodyOf(req, limit = 4 * 1024 * 1024) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error('请求内容过大'), { status: 413, code: 'BODY_TOO_LARGE' }); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw Object.assign(new Error('需要 JSON 对象'), { status: 400, code: 'INVALID_JSON' }); }
}
const envProblem = request => typeof request.expectedHash !== 'string' || !/^[a-f\d]{64}$/i.test(request.expectedHash) || typeof request.opId !== 'string' || !/^[\w:./-]{1,140}$/.test(request.opId);
export function createCreationLibraryHttp({ registry, mediaServices, libraryRoot, contentOrigin, authorize }) {
  function servicesFor(by) {
    const captions = createCreationCaptions({ registry, mediaServices, by });
    const services = { by, contentOrigin: contentOrigin(),
      captionSnapshot: captions.snapshot,
      caption: captions.action,
      jobs: project => mediaServices.listForProject(project),
      items: input => creationServiceItems(input, mediaServices),
      importMedia: (request, ctx) => importCreationMedia({project:ctx.project,name:request.params?.fileName,data:request.params?.data}),
      media: (request, ctx) => startCreationMediaTask({ project: ctx.project, registry, request, libraryRoot, services, mediaServices }),
    };
    return services;
  }
  return async function handleCreation(req, res, method, url) {
    const settings = url.pathname === '/api/settings/media-services';
    const route = /^\/api\/projects\/([^/]+)\/creation-library(?:\/(.*))?$/.exec(url.pathname);
    if (!settings && !route) return false;
    try {
      if (settings) {
        if (req.headers['x-opencut-agent-grant']) { json(res, 403, { ok: false, code: 'SETTINGS_NOT_GRANTED', message: '工程工具票不能修改全局媒体配置' }); return true; }
        if (method === 'GET') json(res, 200, await mediaServices.settings());
        else if (method === 'PUT') { const body = await bodyOf(req); if (Object.keys(body).some(k => k !== 'config')) throw Object.assign(new Error('未知设置字段'), { code: 'INVALID', status: 400 }); json(res, 200, await mediaServices.saveConfig(body.config)); }
        else json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
        return true;
      }
      const projectId = decodeURIComponent(route[1]), suffix = route[2] ?? '';
      const project = registry.get(projectId);
      if (!project) { json(res, 404, { ok: false, code: 'PROJECT_NOT_OPEN', message: '请先打开工程' }); return true; }
      if (method === 'GET' && suffix === '') {
        const services = servicesFor('person');
        const capabilities = await mediaServices.capabilities();
        const snapshot = await readCreationLibrary({ registry, project, libraryRoot, services, capabilities: { ...capabilities, 'media.tts': capabilities.voice, 'caption.recognize': capabilities.subtitle, 'caption.translate': capabilities.translate } });
        json(res, 200, { ok: true, ...snapshot }); return true;
      }
      if ((method === 'GET' || method === 'HEAD') && (suffix.startsWith('files/') || suffix === 'file')) {
        const parts = suffix.split('/');
        const itemId = suffix === 'file' ? url.searchParams.get('itemId') : decodeURIComponent(parts[1]);
        const asset = suffix === 'file' ? url.searchParams.get('asset') : parts.slice(2).map(decodeURIComponent).join('/');
        const file = await resolveCreationLibraryFile({ registry, project, libraryRoot, itemId, asset });
        const html = /html|svg/.test(file.mime), range = req.headers.range;
        if(/text\/html/.test(file.mime) && ['thumbnail','motion'].includes(url.searchParams.get('preview'))) {
          const source=await fs.readFile(file.path,'utf8');
          const previewScript=creationPreviewScript(url.searchParams.get('preview')==='motion');
          const bytes=Buffer.from(source+previewScript);
          res.writeHead(200,{'content-type':file.mime,'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"sandbox allow-scripts; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'",'content-length':bytes.length});res.end(method==='HEAD'?undefined:bytes);return true;
        }

        const headers = { 'content-type': file.mime, 'cache-control': 'private, max-age=60', 'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes',
          ...(html ? { 'content-security-policy': "sandbox allow-scripts; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: data:; font-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'", 'referrer-policy': 'no-referrer' } : {}) };
        let start = 0, end = file.bytes - 1, status = 200;
        if (range) {
          const m = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!m || (!m[1] && !m[2])) { json(res, 416, { ok: false, code: 'RANGE_INVALID' }); return true; }
          if (!m[1]) start = Math.max(0, file.bytes - Number(m[2]));
          else { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])); }
          if (start > end || start >= file.bytes) { res.writeHead(416, { 'content-range': `bytes */${file.bytes}` }); res.end(); return true; }
          status = 206; headers['content-range'] = `bytes ${start}-${end}/${file.bytes}`;
        }
        res.writeHead(status, { ...headers, 'content-length': Math.max(0, end - start + 1) });
        if (method === 'HEAD' || file.bytes === 0) res.end();
        else { const stream = createReadStream(file.path, { start, end }); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res); }
        return true;
      }
      if (method === 'POST' && ['actions', 'import', 'upload'].includes(suffix)) {
        const auth = authorize(req, projectId);
        if (auth.ok !== true) { json(res, 403, auth); return true; }
        if(suffix==='upload'){
          if(auth.by==='agent'){json(res,403,{ok:false,code:'UPLOAD_NOT_GRANTED',message:'Agent请通过受控base64资源接口导入'});return true;}
          json(res,200,await streamCreationMedia({project,name:url.searchParams.get('name'),stream:req}));return true;
        }
        const request = await bodyOf(req, 35 * 1024 * 1024);
        if (suffix === 'import') {
          if (Object.keys(request).some(k => !['name', 'data', 'source'].includes(k))) throw Object.assign(new Error('未知导入字段'), { code: 'INVALID', status: 400 });
          if(auth.by==='agent'&&request.source){json(res,403,{ok:false,code:'SOURCE_NOT_GRANTED',message:'工程工具票不能读取任意本机源路径'});return true;}
          json(res, 200, await importCreationMedia({ project, ...request })); return true;
        }
        if (typeof request.action !== 'string' || request.action.length > 80) { json(res, 400, { ok: false, code: 'ACTION_REQUIRED', message: '需要明确动作' }); return true; }
        if (envProblem(request)) { json(res, 400, { ok: false, code: 'ENVELOPE_REQUIRED', message: '动作需要 expectedHash 与稳定 opId' }); return true; }
        const services = servicesFor(auth.by);
        let result;
        if (request.action === 'job.cancel') result = mediaServices.cancel(projectId, request.params?.jobId ?? request.itemId);
        else result = await applyCreationLibraryAction({ registry, project, libraryRoot, services, request });
        json(res, result.ok ? 200 : result.status ?? (result.code === 'CONFLICT' ? 409 : 400), result); return true;
      }
      json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '不支持此素材库操作' }); return true;
    } catch (error) {
      json(res, error.status ?? 400, { ok: false, code: error.code ?? 'LIBRARY_FAILED', message: error.message ?? '素材库操作失败' }); return true;
    }
  };
}
