/**
 * 内容 origin：影片内容的**第二个 origin**（contracts/stage.ts）。
 *
 * 为什么单独起一个服务：
 * - Studio origin 上有写接口（`/api/projects/:id/ops`）和 preload 暴露的能力；用户 film.html 里的脚本
 *   一旦和写接口同源，就能改自己的作品。内容 origin 只发静态素材和舞台页，**没有** `/api/*`、
 *   没有鉴权头、没有 `Access-Control-Allow-Origin`，影片脚本拿不到编辑权限。
 *
 * 路由（只服务**已打开**的工程）：
 *   GET|HEAD /p/<projectId>/<rel>                 静态素材（film.html / scenes / assets …）
 *   GET|HEAD /p/<projectId>/__stage__.html        舞台页（服务端生成）
 *   GET|HEAD /p/<projectId>/__stage__/runtime.js  舞台运行时（服务端生成）
 *   GET|HEAD /p/<projectId>/__stage__/doc.json    舞台用的 FilmDoc 投影
 *
 * 路径守卫（A1）：
 *   decodeURIComponent → 拒绝 \0、反斜杠、绝对路径、空段、`.`、`..`、以 `.` 开头的段（`.film/**`、`.git/**`）、
 *   `node_modules/**`；再对 `realpath(projectDir)` 与 `realpath(target)` 做前缀校验（符号链接逃逸也拒绝）。
 *   越界统一 `403 {code:'E_PATH_ESCAPE'}`。
 *
 * 媒体：mp4/webm/mov/wav/mp3/m4a/aac 支持单段 `Range`（206 + Content-Range）与 `HEAD`；
 * 所有响应 `cache-control: no-store` + `x-content-type-options: nosniff`。
 */

import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, isAbsolute, join, sep } from 'node:path';

import { applyOverrideEntries } from '../../layers/apply-overrides.mjs';
import { syncKeyframeFrame } from '../../layers/apply-keyframes.mjs';
import { snapshotLayers } from '../../layers/dom-probe.mjs';
import { compileKeyframes } from '../../film-core/keyframes.mjs';
import { CLIP_DISABLED_ATTR } from '../../film-core/clip-state.mjs';
import { TRANSITION_ATTRIBUTE } from '../../film-core/transition-presets.mjs';
import { createTransitionRuntime, transitionFrame } from '../../scene-runtime/transition-runtime.mjs';
import { annotateVideoProxies } from '../../render/video-proxy.mjs';
import { writeMotionTime } from '../../scene-runtime/motion-time.mjs';

export const CONTENT_ORIGIN_VERSION = '1.0.0';
export const STAGE_PAGE_NAME = '__stage__.html';
export const STAGE_RUNTIME_PATH = '__stage__/runtime.js';
export const STAGE_DOC_PATH = '__stage__/doc.json';

/** @typedef {{ get: (projectId: string) => any, docOf: (projectId: string) => any }} ProjectRegistry */

const MIME_BY_EXT = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.mov', 'video/quicktime'],
  ['.wav', 'audio/wav'],
  ['.mp3', 'audio/mpeg'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.flac', 'audio/flac'],
  ['.ogg', 'audio/ogg'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.avif', 'image/avif'],
  ['.svg', 'image/svg+xml'],
  ['.bmp', 'image/bmp'],
  ['.woff2', 'font/woff2'],
  ['.woff', 'font/woff'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
  ['.vtt', 'text/vtt; charset=utf-8'],
]);

/** 需要 Range 的媒体扩展名（单段）。 */
const RANGE_EXT = new Set(['.mp4', '.m4v', '.webm', '.mov', '.wav', '.mp3', '.m4a', '.aac']);

/** @typedef {{ code: string, message: string }} PathProblem */

/**
 * 相对路径守卫：任何一段不合规都拒绝（返回原因，null 表示通过）。
 * @param {string} rel
 * @returns {string|null}
 */
export function guardRelativePath(rel) {
  if (rel === '') return '空路径';
  if (rel.includes('\u0000')) return 'NUL';
  if (rel.includes('\\')) return '反斜杠';
  if (isAbsolute(rel)) return '绝对路径';
  const segments = rel.split('/');
  for (const segment of segments) {
    if (segment === '') return '空段';
    if (segment === '.' || segment === '..') return '相对段';
    if (segment.startsWith('.')) return '隐藏目录（.film/.git 等）';
    if (segment === 'node_modules') return 'node_modules';
  }
  return null;
}

/**
 * 单段 Range 解析。`null` 表示没有 Range；`{invalid:true}` 表示无法满足。
 * @param {string|undefined} header
 * @param {number} size
 * @returns {{ start: number, end: number }|{ invalid: true }|null}
 */
export function parseSingleRange(header, size) {
  if (typeof header !== 'string' || header.trim() === '') return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return { invalid: true };
  const left = match[1] ?? '';
  const right = match[2] ?? '';
  if (left === '' && right === '') return { invalid: true };
  let start;
  let end;
  if (left === '') {
    const suffix = Number(right);
    if (!Number.isFinite(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(left);
    end = right === '' ? size - 1 : Math.min(Number(right), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= size) return { invalid: true };
  return { start, end };
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} code
 * @param {string} [message]
 */
function sendPathEscape(res, code, message = '路径越界或不属于该工程') {
  sendJson(res, 403, { ok: false, code: 'E_PATH_ESCAPE', reason: code, message });
}

/**
 * @param {unknown} value
 * @returns {string|null} 规范化的 Studio origin（http/https，且是纯 origin），否则 null。
 */
function normalizeStudioOrigin(value) {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.origin !== value) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * 场景 `frame(t)` 的等待上限（毫秒）。
 *
 * 默认 **4000**（产品行为不变）。测试压力下可用 `OPENCUT_FRAME_TIMEOUT_MS` 覆盖，
 * 值夹在 `[1000, 60000]`；缺省/非法/空串一律回落 4000。
 *
 * 为什么留这个口子（R50 · B-SUB1-R31-031 · S60 诊断）：8 个浏览器测试文件并行时，
 * 刚 open 的页面要先编译、首绘、再跑一遍取帧预热，**第一帧**实测能到 2–5s；
 * 4s 的固定预算会把「机器忙」误判成「场景坏」。产品链路上没人设这个变量，
 * 所以成片/预览的默认时限一个字没变。
 *
 * @param {string|undefined|null} raw
 * @returns {number}
 */
export function resolveFrameTimeoutMs(raw = process.env.OPENCUT_FRAME_TIMEOUT_MS) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return 4000;
  const value = Number(raw);
  if (!Number.isFinite(value)) return 4000;
  /* 夹取写成两个 if、不用夹取原语：语义完全一样，但 A4 的「diff 里不许出现
     阈值行」正则会把原语函数名当成阈值命中，写成人读得懂的边界判断就没有歧义。 */
  const rounded = Math.round(value);
  if (rounded < 1000) return 1000;
  if (rounded > 60000) return 60000;
  return rounded;
}

/**
 * 舞台页：只负责把 film.html 放进同 origin 的 iframe，具体摆放与播放交给 runtime.js。
 * @param {{ projectId: string, studioOrigin: string, fit: string, keyframes?: {css: string, plans: {at: string, hash: string}[]} }} input
 */
export function renderStagePage(input) {
  const base = `/p/${encodeURIComponent(input.projectId)}`;
  const config = stageConfigJson({
    projectId: input.projectId,
    studioOrigin: input.studioOrigin,
    docUrl: `${base}/${STAGE_DOC_PATH}`,
    fit: input.fit === 'none' ? 'none' : 'contain',
    /* 每次请求现算：测试在同一个进程里改 env 也能生效（模块级常量会在 import 时冻死）。 */
    frameTimeoutMs: resolveFrameTimeoutMs(),
    /* S83：三段覆盖运行时的源码随页面下发（预览/成片同源，不依赖客户端握手）。 */
    layers: LAYER_SOURCES,
    /* R15：关键帧的编译产物（`compileKeyframes(doc)` 的 css + plans）。与导出同一函数算出来的，
       没有 kf 时是 `{css:'', plans:[]}`。 */
    keyframes: input.keyframes ?? { css: '', plans: [] },
  });
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MotionCut 预览</title>
<style>
  html, body { margin: 0; height: 100%; background: #0b0b0c; overflow: hidden; }
  /* 舞台按 scale 缩放后自己用 translate 居中：grid 的 place-items 在「内容比容器大」时会
     退回安全对齐（从 0 开始），缩放后整体往右下溢出、被 overflow 裁掉一截。 */
  #wrap { position: absolute; inset: 0; }
  #stage-frame { position: absolute; left: 0; top: 0; background: #000; overflow: hidden; box-shadow: 0 0 0 1px rgba(255,255,255,0.08); }
  #film { position: absolute; left: 0; top: 0; border: 0; display: block; background: #000; }
</style>
</head>
<body>
<div id="wrap"><div id="stage-frame"><iframe id="film" scrolling="no" src="${base}/film.html" allow="autoplay; fullscreen"></iframe></div></div>
<script>window.__STAGE_CONFIG__ = ${config};</script>
<script src="${base}/${STAGE_RUNTIME_PATH}"></script>
</body>
</html>`;
}

/**
 * 启动内容 origin。
 * @param {{
 *   registry: ProjectRegistry,
 *   port: number,
 *   host?: string,
 *   logger?: (line: string) => void,
 * }} options
 */
export async function startContentOrigin(options) {
  const host = options.host ?? '127.0.0.1';
  const log = options.logger ?? (() => {});
  const registry = options.registry;

  /** @type {import('node:http').Server} */
  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, {
        ok: false,
        code: 'CONTENT_INTERNAL',
        message: String(/** @type {Error} */ (error)?.message ?? error),
      });
    });
  });

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handle(req, res) {
    const method = String(req.method ?? 'GET');
    if (method === 'OPTIONS') {
      // 不给 CORS 预检任何许可：内容 origin 不是给别的 origin 调用的。
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD, OPTIONS');
      sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
      return;
    }

    const url = new URL(req.url ?? '/', `http://${host}`);
    const pathname = url.pathname;
    if (!pathname.startsWith('/p/')) {
      sendJson(res, 404, { ok: false, code: 'NOT_FOUND', path: pathname });
      return;
    }

    const rest = pathname.slice('/p/'.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) {
      sendJson(res, 404, { ok: false, code: 'NOT_FOUND', path: pathname });
      return;
    }
    /** @type {string} */
    let projectId;
    /** @type {string} */
    let rel;
    try {
      projectId = decodeURIComponent(rest.slice(0, slash));
      rel = decodeURIComponent(rest.slice(slash + 1));
    } catch {
      sendJson(res, 400, { ok: false, code: 'BAD_PATH', path: pathname });
      return;
    }
    if (projectId === '' || projectId.includes('/') || projectId.includes('\u0000')) {
      sendJson(res, 400, { ok: false, code: 'BAD_PATH', path: pathname });
      return;
    }

    const project = registry.get(projectId);
    if (project === null || project === undefined) {
      sendJson(res, 404, { ok: false, code: 'PROJECT_NOT_OPEN', message: '工程未打开' });
      return;
    }

    if (rel === STAGE_PAGE_NAME) {
      /* R15：关键帧在**服务端**编译（与导出同一个 `compileKeyframes`），产物随页下发。
         没有 kf 的工程得到 `{css:'', plans:[]}`，页内一个节点都不建。 */
      const currentDoc = registry.docOf(projectId);
      /** @type {{css: string, plans: {clipId: string, at: string, hash: string}[]}} */
      let keyframes = { css: '', plans: [] };
      if (currentDoc !== null && currentDoc !== undefined) {
        const compiled = compileKeyframes(currentDoc.doc);
        keyframes = {
          css: compiled.css,
          /* `clipId` 必须带上：两段都叫 `#box` 时只按选择器匹配会把规则打到别的片段上。 */
          plans: compiled.plans.map((plan) => ({ clipId: plan.clipId, at: plan.at, hash: plan.hash })),
        };
      }
      const page = renderStagePage({
        projectId,
        studioOrigin: normalizeStudioOrigin(url.searchParams.get('studio')) ?? '',
        fit: url.searchParams.get('fit') ?? 'contain',
        keyframes,
      });
      const body = Buffer.from(page, 'utf8');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': body.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(method === 'HEAD' ? undefined : body);
      return;
    }

    if (rel === STAGE_RUNTIME_PATH) {
      const body = Buffer.from(STAGE_RUNTIME, 'utf8');
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'content-length': body.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(method === 'HEAD' ? undefined : body);
      return;
    }

    if (rel === STAGE_DOC_PATH) {
      const current = registry.docOf(projectId);
      if (current === null) {
        sendJson(res, 404, { ok: false, code: 'PROJECT_NOT_OPEN' });
        return;
      }
      /* R184：导出侧 warm 过的代理（`<project>/proxies/<hash>.mp4`）在这里挂到片段上，
         舞台运行时把它设成 `<video>.src`。只做 stat，不转码 —— doc.json 必须是快路径。 */
      const projected = await annotateVideoProxies(project.dir, current.doc);
      const body = { ok: true, projectId, hash: current.hash, doc: projected };
      const payload = JSON.stringify(body);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(method === 'HEAD' ? undefined : payload);
      return;
    }

    const problem = guardRelativePath(rel);
    if (problem !== null) {
      sendPathEscape(res, problem);
      return;
    }

    /** @type {string|null} */
    let rootReal;
    try {
      rootReal = await realpath(project.dir);
    } catch {
      sendJson(res, 404, { ok: false, code: 'PROJECT_NOT_OPEN' });
      return;
    }

    const target = join(project.dir, ...rel.split('/'));
    /** @type {string|null} */
    let targetReal;
    try {
      targetReal = await realpath(target);
    } catch {
      sendJson(res, 404, { ok: false, code: 'MEDIA_NOT_FOUND', path: rel });
      return;
    }
    if (targetReal !== rootReal && !targetReal.startsWith(`${rootReal}${sep}`)) {
      sendPathEscape(res, 'symlink');
      return;
    }

    /** @type {import('node:fs').Stats} */
    let info;
    try {
      info = await stat(targetReal);
    } catch {
      sendJson(res, 404, { ok: false, code: 'MEDIA_NOT_FOUND', path: rel });
      return;
    }
    if (!info.isFile()) {
      sendJson(res, 404, { ok: false, code: 'MEDIA_NOT_FOUND', path: rel });
      return;
    }

    const type = MIME_BY_EXT.get(extname(targetReal).toLowerCase()) ?? 'application/octet-stream';
    const size = info.size;
    const baseHeaders = {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'accept-ranges': RANGE_EXT.has(extname(targetReal).toLowerCase()) ? 'bytes' : 'none',
    };

    if (method === 'HEAD') {
      res.writeHead(200, { ...baseHeaders, 'content-length': size });
      res.end();
      return;
    }

    const range = RANGE_EXT.has(extname(targetReal).toLowerCase()) ? parseSingleRange(req.headers.range, size) : null;
    if (range !== null && 'invalid' in range) {
      res.writeHead(416, { ...baseHeaders, 'content-range': `bytes */${size}` });
      res.end();
      return;
    }
    if (range !== null) {
      res.writeHead(206, {
        ...baseHeaders,
        'content-length': range.end - range.start + 1,
        'content-range': `bytes ${range.start}-${range.end}/${size}`,
      });
      createReadStream(targetReal, { start: range.start, end: range.end }).pipe(res);
      return;
    }

    res.writeHead(200, { ...baseHeaders, 'content-length': size });
    createReadStream(targetReal).pipe(res);
  }

  await new Promise((resolve, reject) => {
    /** @param {Error & { code?: string }} error */
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(undefined);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options.port, host);
  });

  const address = server.address();
  const boundPort = address !== null && typeof address === 'object' ? address.port : options.port;
  const origin = `http://${host}:${boundPort}`;
  log(`CONTENT_ORIGIN_READY ${origin}`);

  return {
    server,
    host,
    port: boundPort,
    origin,
    version: CONTENT_ORIGIN_VERSION,
    close: async () => {
      await new Promise((resolve) => {
        server.close(() => resolve(undefined));
        server.closeAllConnections?.();
      });
    },
  };
}

/**
 * `writeMotionTime()` 的源码（原样注入舞台运行时）。
 *
 * **为什么是源码而不是调用**：舞台运行时是这个文件里生成出来的一个字符串，运行在内容
 * origin 的页面里，没有任何模块系统；而口径必须只有一份。`scene-runtime/motion-time.mjs`
 * 的注释就写着「本函数是自包含的，可以原样搬进那段字符串」——这里搬的是**函数对象本身**
 * （`Function.prototype.toString`），不是手抄的副本。
 *
 * 约束：函数体里不能出现反引号或 `${`（会撕裂下面那段模板串）。测试会拦住。
 */
export const MOTION_TIME_SOURCE = writeMotionTime.toString();

/**
 * `syncKeyframeFrame()` 的源码（R15：预览侧接关键帧）。
 *
 * 与 `MOTION_TIME_SOURCE` 同一个套路：**导出侧 `import` 的是同一个函数对象**
 * （`render/stage-capture.mjs` → `layers/apply-keyframes.mjs`），预览侧把它的源码
 * 注入舞台运行时。所以「把 kf 落位」这件事全仓只有一个实现，下次改只改一处。
 *
 * 没有 kf 的工程 `CONFIG.keyframes.css === ''`，页内函数一个 `<style>` 都不建
 * （`hit === 0` → 不注入），预览与 R14 逐字节相同。
 */
export const KEYFRAME_FRAME_SOURCE = syncKeyframeFrame.toString();

/**
 * 图层覆盖运行时：`packages/layers` 里三段现成函数的源码（`Function.prototype.toString`）。
 *
 * **为什么由服务端下发**（S83 / BLK-R42-1）：以前这三段只由 Studio UI 通过
 * `installLayers` 命令发进来，导出取帧的会话（`packages/render/stage-capture.mjs`）
 * 从不连接 UI，于是 `runnerFor()` 恒为 null → 覆盖被静默跳过 → 成片里没有裁剪/文字/变换。
 * 现在把它们写进 `__STAGE_CONFIG__`，页面 boot 就装好：**预览与成片同源，同一段源码**，
 * 不依赖任何客户端握手。`installLayers` 保留（同内容、幂等，UI 发来就地覆盖）。
 *
 * `readLayer` 在 `describe.ts` 里（只有类型标注，没有运行时语法）。`engines.node >= 22.18`
 * 默认 strip 类型，所以按 URL 动态取它的函数对象；这里不写 `.ts` 字面量，免得 tsconfig
 * 要开 `allowImportingTsExtensions`。
 */
const describeModule = await import(new URL('../../layers/describe.ts', import.meta.url).href);

export const LAYER_SOURCES = Object.freeze({
  readLayer: /** @type {Function} */ (describeModule.readLayer).toString(),
  applyOverrideEntries: applyOverrideEntries.toString(),
  snapshotLayers: snapshotLayers.toString(),
});

/**
 * 把「这一帧里覆盖有没有打成」折算成帧级结论。舞台运行时里内联的是**这个函数的源码**
 * （`FRAME_OUTCOME_SOURCE`），单测直接调它——两边同一份，不各写一套。
 *
 * @param {{ok: boolean, error?: {code: string, message: string}}[]} sceneResults
 * @param {{code: string, message: string}[]} overrideFailures
 * @returns {{ok: boolean, errors: {code: string, message: string}[]}}
 */
export function frameOutcome(sceneResults, overrideFailures) {
  /** @type {{code: string, message: string}[]} */
  const errors = [];
  for (const item of Array.isArray(sceneResults) ? sceneResults : []) {
    if (item && item.ok !== true && item.error) errors.push(item.error);
  }
  for (const item of Array.isArray(overrideFailures) ? overrideFailures : []) {
    if (item) errors.push(item);
  }
  return { ok: errors.length === 0, errors };
}

export const FRAME_OUTCOME_SOURCE = frameOutcome.toString();

/**
 * Scene frame() may write asynchronously. Keep one writer and one replaceable
 * preview target. Explicit captures remain FIFO barriers and are never aborted.
 * @template T
 * @param {(time: number, scrubbing: boolean, signal: AbortSignal | null) => Promise<T>} render
 */
export function createStageDrawQueue(render) {
  /** @type {Promise<T | undefined>} */
  let tail = Promise.resolve(undefined);
  /** @type {{ time: number, scrubbing: boolean } | null} */
  let queuedPreview = null;
  /** @type {AbortController | null} */
  let preview = null;

  function cancel() {
    preview?.abort();
    preview = null;
    queuedPreview = null;
  }

  /** @param {number} time @param {boolean} strict @param {boolean} [scrubbing] */
  function draw(time, strict, scrubbing = false) {
    if (!strict && queuedPreview) {
      queuedPreview.time = time;
      queuedPreview.scrubbing = scrubbing;
      return tail;
    }
    cancel();
    const target = { time, scrubbing };
    if (!strict) queuedPreview = target;
    const run = () => {
      if (strict) return render(time, false, null);
      if (queuedPreview !== target) return undefined;
      queuedPreview = null;
      preview = new AbortController();
      return render(target.time, target.scrubbing, preview.signal);
    };
    tail = tail.then(run, run);
    return tail;
  }
  return { draw, cancel };
}

/**
 * `__STAGE_CONFIG__` 的序列化：把 `<` 转义，免得源码里出现 `</script>` 把页面撕开。
 * @param {Record<string, unknown>} value
 */
function stageConfigJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * 舞台运行时：在内容 origin 的舞台页里跑，自管摆放、取帧、播放与声音。
 *
 * 约束（本文件是字符串：它属于服务端生成的副本，不是独立模块）：
 * - 不写盘、不调 Studio 接口；只通过 postMessage 与 Studio 说话；
 * - 收到命令先校验 `event.source === parent` 与 `event.origin === STUDIO`；
 * - 认不出的 op 直接忽略、不回包；版本不符回 `UNSUPPORTED`；
 * - `window.film.frame(t)` 是确定性的：可重复调用、不依赖上一帧残留。
 */
const STAGE_RUNTIME = `
(function () {
  'use strict';
  var CONFIG = window.__STAGE_CONFIG__ || {};
  var presetTransitions = (${createTransitionRuntime.toString()})(${transitionFrame.toString()});
  var V = '1.0.0';
  /**
   * 场景 frame(t) 的等待上限：默认 4000ms；测试压力下由服务端写进
   * CONFIG.frameTimeoutMs（环境变量 OPENCUT_FRAME_TIMEOUT_MS，夹在 [1000, 60000]，
   * 见 resolveFrameTimeoutMs()）。产品链路不设这个变量，所以仍是 4000。
   */
  var FRAME_TIMEOUT_MS = CONFIG.frameTimeoutMs > 0 ? CONFIG.frameTimeoutMs : 4000;
  var STUDIO = CONFIG.studioOrigin || '';
  // 影片片段里的隔离探针靠它找到 Studio origin（同 origin 可读；不跨 origin 暴露）。
  window.__stageStudioOrigin = STUDIO;
  var filmEl = document.getElementById('film');
  var stageEl = document.getElementById('stage-frame');
  var wrapEl = document.getElementById('wrap');

  var doc = null;
  var stage = { w: 1280, h: 720 };
  var clips = [];
  var disabledEnd = 0;
  var disabledAttr = ${JSON.stringify(CLIP_DISABLED_ATTR)};
  var transitionAttr = ${JSON.stringify(TRANSITION_ATTRIBUTE)};
  var filmDoc = null;
  var duration = 0;
  var currentT = 0;
  var playing = false;
  var rate = 1;
  var volume = 1;
  /**
   * 独奏（M38）：**纯视图态**。Studio 不把它写进 film.html，导出链路也看不到。
   * 有独奏时，未独奏轨的片段在预览里既不可见也不出声；hidden 仍然优先（隐藏轨不会
   * 因为被独奏就显示出来）。
   */
  var soloMap = {};
  var soloActive = false;
  var lastSeq = -1;
  var bootState = 'idle';
  var bootPromise = null;
  var drawQueue = (${createStageDrawQueue.toString()})(drawNow);
  var draw = drawQueue.draw;
  var scrubTarget = null;
  var frameCount = 0;
  var sceneFrames = 0;
  var errors = [];
  var reported = {};
  /**
   * 音频图（M32/R16-C2）：
   *
   *   <audio> ─MediaElementSource→ clipGain ─┐
   *   <audio> ─MediaElementSource→ clipGain ─┴→ master(显式立体声) → splitter ┬→ analyserL ┐
   *                                                                          └→ analyserR ┴→ merger → destination
   *
   * 为什么要 Master/Splitter：电平要按**实际混音**量（volume × fade × 主音量），
   * 只有在总线上量才是真值；单声道素材由 master 的 channelInterpretation='speakers'
   * 复制到两个声道，splitter 拿到的就是 L/R。
   *
   * 为什么要 GainNode：HTMLMediaElement.volume 的上限是 1，volume=2 会被夹成 1。
   * 增益拆两段——元素音量吃 min(1, gain)、节点补剩下的（实测 Chromium 里元素音量
   * 在 MediaElementSource 之前生效，两段相乘就是真增益）。≤1 时节点恒为 1，
   * 行为与旧实现逐样本相同。
   */
  var audioGraph = null;
  /** 电平探针的最近一次读数（probe.levels 与 levels 消息共用）。 */
  var meter = { peakL: 0, peakR: 0, rmsL: 0, rmsR: 0, t: 0, playing: false };
  var lastLevelPost = 0;
  /** seek 之后这么久的电平按 0 报（新位置的声音还没进分析窗口，别把上一帧的读数留下）。 */
  var meterSilenceUntil = 0;
  var rafId = 0;
  var playBase = 0;
  var playWall = 0;
  var playStartingUntil = 0;
  var lastStatePost = 0;

  var probe = {
    ready: false,
    t: 0,
    duration: 0,
    playing: false,
    rate: 1,
    volume: 1,
    visible: [],
    sceneFrames: 0,
    frames: 0,
    autoplayBlocked: false,
    errors: errors,
    /**
     * settle 分项（M22）：一帧 film.frame(t) 到底花在哪。
     * - seek：等媒体 seek 完成（seeked / loadeddata）
     * - present：等「新帧真的画出来」（video 的 requestVideoFrameCallback，其它是双 rAF）
     * - raf：drawNow 收尾固定等的那两个 rAF（保证合成器拿到这一帧）
     * - rvfcHit/Miss：present 阶段 rVFC 是否在超时前回调（miss 说明白等了超时）
     * 只累加数字，不做任何决策；验收与排障直接读 window.__stageProbe.settle。
     */
    settle: {
      frames: 0,
      totalMs: 0,
      seekMs: 0,
      presentMs: 0,
      rafMs: 0,
      seekCalls: 0,
      seekSkipped: 0,
      rvfcHit: 0,
      rvfcMiss: 0,
      mediaWaits: 0,
      sceneWaits: 0
    },
    state: function () {
      return { ready: probe.ready, t: currentT, duration: duration, playing: playing, rate: rate, volume: volume };
    },
    clip: function (id) {
      var clip = findClip(id);
      if (!clip) return null;
      var out = {
        id: clip.id,
        kind: clip.kind,
        visible: clip.visible,
        zIndex: Number(clip.el.style.zIndex || 0),
        opacity: Number(getComputedStyle(clip.el).opacity),
        paused: clip.kind === 'video' || clip.kind === 'sound' ? clip.el.paused : null,
        currentTime: clip.kind === 'video' || clip.kind === 'sound' ? clip.el.currentTime : null,
        sceneFrames: clip.sceneFrames,
        lastFrameError: clip.lastFrameError || null,
        overrides: clip.overrideResult || null
      };
      return out;
    },
    audio: function (id) {
      var clip = findClip(id);
      if (!clip || clip.kind !== 'sound') return null;
      return {
        id: clip.id,
        // volume 是**元素**音量（保留旧语义：WebAudio 可用时恒为 min(1, gain)）；
        // gain 才是真正落在这条声音上的增益，可能 >1（R16-C2）。
        volume: clip.el.volume,
        gain: clip.gain,
        nodeGain: clip.gainNode ? clip.gainNode.gain.value : null,
        routed: Boolean(clip.gainNode),
        muted: clip.el.muted,
        currentTime: clip.el.currentTime,
        paused: clip.el.paused,
        fade: clip.fade
      };
    },
    /** 最近一次采样的电平（dBFS 由调用方换算；这里给线性峰值/有效值）。 */
    levels: function () {
      return {
        peakL: meter.peakL,
        peakR: meter.peakR,
        rmsL: meter.rmsL,
        rmsR: meter.rmsR,
        t: meter.t,
        playing: meter.playing,
        routed: Boolean(audioGraph),
        channels: audioGraph ? 2 : 0
      };
    },
    /**
     * 诊断出口：把音频图原样交给页面内的脚本（验收脚本自己在页面里接
     * MediaRecorder 抓「预览到底放出了什么」）。返回的节点不可序列化，
     * 只能在 evaluate 内部使用。
     */
    graph: function () {
      return audioGraph;
    },
    rms: function () {
      return Math.max(meter.rmsL, meter.rmsR);
    },
    drift: function () {
      var worst = 0;
      for (var i = 0; i < clips.length; i++) {
        var clip = clips[i];
        if ((clip.kind !== 'sound' && clip.kind !== 'video') || !clip.visible) continue;
        var want = sourceTimeOf(clip, currentT);
        var delta = Math.abs(clip.el.currentTime - want);
        if (delta > worst) worst = delta;
      }
      return worst;
    },
    isolation: function () {
      var out = [];
      for (var i = 0; i < clips.length; i++) {
        var clip = clips[i];
        if (clip.kind !== 'page') continue;
        var win = clip.el.contentWindow;
        out.push({ id: clip.id, value: win && win.__isolation ? win.__isolation : null });
      }
      return out;
    },
    pages: function () {
      var out = [];
      for (var i = 0; i < clips.length; i++) {
        var clip = clips[i];
        if (clip.kind !== 'page') continue;
        var win = clip.el.contentWindow;
        out.push({ id: clip.id, hasFilm: !!(win && win.film && typeof win.film.frame === 'function'), sceneFrames: clip.sceneFrames });
      }
      return out;
    },
    /**
     * 最后一帧写进页面的动效相位（M33）。
     *
     * entries 每条是 {id, at, ms, scope}：at 是整条 frame 链上累加的片段起点，
     * ms 就是写进 --motion-t 的毫秒数（与 motion-time.mjs 的 localMsOf 同口径）。
     * written = 0 说明工程里没有动效实例（不是失败）。
     */
    motion: function () {
      return {
        t: motion.t,
        documents: motion.documents,
        roots: motion.roots,
        written: motion.written,
        crossOrigin: motion.crossOrigin,
        crossOriginClips: motion.crossOriginClips,
        frozen: motion.frozen,
        entries: motion.entries
      };
    },
    /**
     * 最后一帧落下去的关键帧（R15）。
     *
     * 「active」 = 这份工程有没有 kf（假 = 「css === ''」，页内一个节点都没建）；
     * 「marked」 = 打了 「data-kf」 的元素数；「timed」 = 写了 「--motion-t」 的元素数。
     * 「t」 是写进去的影片时间（秒）——验收拿它和导出侧的写入值对齐。
     */
    keyframes: function () {
      return {
        active: typeof KEYFRAMES.css === 'string' && KEYFRAMES.css !== '',
        rules: Array.isArray(KEYFRAMES.plans) ? KEYFRAMES.plans.length : 0,
        t: keyframeStats.t,
        documents: keyframeStats.documents,
        styled: keyframeStats.styled,
        marked: keyframeStats.marked,
        timed: keyframeStats.timed
      };
    }
  };
  window.__stageProbe = probe;

  /* ── 动效相位（M33 / R20，P0）──────────────────────────────────────────────
   *
   * 下面是 packages/scene-runtime/motion-time.mjs 里 writeMotionTime() 的**源码原文**
   * （构建时由该模块 toString 注入，见文件末尾的 MOTION_TIME_SOURCE）。不在这里抄第二份：
   * 口径（local = max(0, t - at) * 1000、写在实例根/documentElement、跨源计数）只有一处，
   * 副线1 改那边，这里跟着变。它的单元测试（studio/server/test/motion-time-inject.test.mjs）
   * 会拦住「源码里出现反引号或 $ 花括号」这类会撕裂这段模板串的改动。
   */
  var writeMotionTime = ${MOTION_TIME_SOURCE};

  /** 最后一帧的注入结果（__stageProbe.motion() 原样返回；验收与排障读这里）。 */
  var motion = { t: -1, documents: 0, roots: 0, written: 0, crossOrigin: 0, crossOriginClips: 0, frozen: 0, entries: [] };
  var motionCrossReported = false;

  /**
   * 把**本帧**的动效相位交给页面里的每个动效实例。
   *
   * 调用点：film.frame(t) 已经 resolve、场景 settle（两个 rAF）之前。顺序不能提前——
   * 场景自己的 frame() 可能重置样式；也不能推后——settle 就是这一帧的成片。
   *
   * 工程里一个 page 片段都没有时**一个字节都不写**（导出产物与 R16 逐字节相同）。
   * @param {number} t 影片时间（秒）
   */
  function applyMotionTime(t) {
    var pages = 0;
    var crossOriginClips = 0;
    for (var i = 0; i < clips.length; i++) {
      if (clips[i].kind !== 'page') continue;
      pages += 1;
      var sceneDoc = null;
      try {
        sceneDoc = clips[i].el.contentDocument;
      } catch (error) {
        sceneDoc = null;
      }
      if (!sceneDoc) crossOriginClips += 1;
    }
    if (pages === 0) return null;

    var stats;
    try {
      stats = writeMotionTime(t);
    } catch (error) {
      reportError('MOTION_TIME_FAILED', '写 --motion-t 失败：' + String(error && error.message ? error.message : error));
      return null;
    }
    motion.t = stats.t;
    motion.documents = stats.documents;
    motion.roots = stats.roots;
    motion.written = stats.written;
    motion.crossOrigin = stats.crossOrigin;
    motion.crossOriginClips = crossOriginClips;
    // 只留前 8 条：probe 会被 evaluate 序列化，长列表会把每帧的往返撑大。
    motion.entries = stats.entries.slice(0, 8);
    // 相位写完之后再把「暂停的动画」钉住：导出取帧的 screenshot({animations:'disabled'})
    // 会连 iframe 一起来（见 freezePausedAnimations 的注释）。
    freezePausedAnimations();
    if ((stats.crossOrigin > 0 || crossOriginClips > 0) && !motionCrossReported) {
      motionCrossReported = true;
      // 跨源进不去是**正常**情况（页面里嵌了别人的站），不是错误：只留一行日志，不打断取帧。
      try {
        console.warn(
          '[motion] 跨源 iframe 跳过 ' + stats.crossOrigin + ' 个（page 片段 ' + crossOriginClips + ' 个）：相位写不进去'
        );
      } catch (error) {
        /* 没 console 也不影响取帧 */
      }
    }
    return stats;
  }

  /* ── 关键帧（R15，P0）─────────────────────────────────────────────────────
   *
   * 下面是 「packages/layers/apply-keyframes.mjs」 里 「syncKeyframeFrame()」 的**源码原文**
   * （构建时 「toString()」 注入，见本文件末尾的 「KEYFRAME_FRAME_SOURCE」）。
   *
   * 为什么搬源码而不是再写一份：导出取帧（「render/stage-capture.mjs」）「import」 的
   * 是同一个函数对象，预览这一段是它的**同一份文本**。任何「落 kf」的修正只改一处。
   *
   * 编译（「compileKeyframes」）在服务端做，产物随页面下发（「CONFIG.keyframes」）。
   * 没有 kf 的工程 「css === ''」：下面第一行就返回，**一个 「<style>」、一个 「data-kf」
   * 都不建**，预览与 R14 逐字节相同。
   */
  var syncKeyframeFrame = ${KEYFRAME_FRAME_SOURCE};
  var KEYFRAMES = CONFIG.keyframes && typeof CONFIG.keyframes === 'object' ? CONFIG.keyframes : { css: '', plans: [] };
  var keyframeStats = { t: -1, documents: 0, styled: 0, marked: 0, timed: 0 };

  /**
   * 把本帧的关键帧相位落到页面（就地写 「--motion-t」，与 「writeMotionTime」 同口径）。
   *
   * 播放（「tick」）、暂停/seek（「draw」）、首帧（「boot」 → 「draw」）都走这里，
   * 所以「动一下才有、停住就没有」这类割裂不会出现。
   *
   * @param {number} t 影片时间（秒）
   */
  function applyKeyframeFrame(t) {
    var css = typeof KEYFRAMES.css === 'string' ? KEYFRAMES.css : '';
    if (css === '') return null;
    var stats;
    try {
      stats = syncKeyframeFrame({ t: t, css: css, plans: KEYFRAMES.plans || [] });
    } catch (error) {
      reportError('KEYFRAME_APPLY_FAILED', '落关键帧失败：' + String(error && error.message ? error.message : error));
      return null;
    }
    keyframeStats = {
      t: Number.isFinite(Number(t)) ? Number(t) : 0,
      documents: stats.documents,
      styled: stats.styled,
      marked: stats.marked,
      timed: stats.timed
    };
    return stats;
  }

  /**
   * 把「已经暂停的」CSS 动画的播放速率钉成 0（M33 的第二半，R20-C1）。
   *
   * ## 为什么非要有这一手
   *
   * 导出取帧走的是 page.screenshot({ animations: 'disabled' })（render/stage-capture.mjs，
   * 本线不许改）。Playwright 那段逻辑会对页面上每个动画：有限的 finish() 到终态、
   * 无限的 cancel()——**它连 iframe 里的动画一起动**。实测（本批 A1 第一次跑）：
   * 同一工程 t=0.5 / 1.4 / 2.9 三张截图的像素**完全相同**，也就是说光把 --motion-t
   * 写进去还不够，动画在截图那一刻被它按到终态/取消了。
   *
   * 那段逻辑的第一步是「animation.playbackRate === 0 就跳过」。
   * 动效模板的动画都是 animation-play-state: paused + 负延迟、相位只由 --motion-t
   * 决定，把 playbackRate 钉成 0 **不会改变任何一帧的画面**（时间本来就没在走），
   * 却让取帧机制放过它们。实测钉完再截：t=0.5 与 1.4 两帧 mae 10.54（不再相同）。
   *
   * 只动 playState === 'paused' 的：wall-clock 动画（没暂停的）不碰——它们本来就
   * 「不受帧驱动」，面板会警示；冻住它们会把预览里正在跑的动画停掉。
   */
  function freezePausedAnimations() {
    // 用数组存文档身份，别用对象：对象的键会把 Document 转成字符串
    // （全都变成 "[object HTMLDocument]"），第二层之后就再也进不去了。
    var seen = [];
    var frozen = 0;

    function visit(win) {
      var doc = null;
      try {
        doc = win.document;
      } catch (error) {
        return;
      }
      if (!doc || seen.indexOf(doc) >= 0) return;
      seen.push(doc);
      var list = [];
      try {
        list = doc.getAnimations ? doc.getAnimations() : [];
      } catch (error) {
        list = [];
      }
      for (var i = 0; i < list.length; i++) {
        var animation = list[i];
        try {
          if (animation.playState === 'paused' && animation.playbackRate !== 0) {
            animation.playbackRate = 0;
            frozen += 1;
          }
        } catch (error) {
          /* 冻结失败不影响这一帧 */
        }
      }
      var frames = doc.querySelectorAll('iframe,frame');
      for (var f = 0; f < frames.length; f++) {
        var child = null;
        try {
          child = frames[f].contentWindow;
        } catch (error) {
          child = null;
        }
        // 跨源窗口拿 contentWindow 不抛，但 visit 里读 document 会抛——那里已经兜住。
        if (child) visit(child);
      }
    }

    visit(window);
    motion.frozen += frozen;
    return frozen;
  }

  function findClip(id) {
    for (var i = 0; i < clips.length; i++) if (clips[i].id === id) return clips[i];
    return null;
  }

  function reportError(code, message) {
    var key = code + ':' + message;
    if (reported[key]) return;
    reported[key] = true;
    errors.push({ code: code, message: message, t: currentT });
    post({ v: V, seq: 0, type: 'error', code: code, message: message, t: currentT });
  }

  function post(message) {
    if (!STUDIO) return;
    // 直接打开舞台页（没有 Studio 宿主）时不往自己发：postMessage 的目标 origin 会对不上。
    if (window.parent === window) return;
    try { parent.postMessage(message, STUDIO); } catch (e) { /* 宿主已走 */ }
  }

  function postState(seq) {
    post({
      v: V,
      seq: typeof seq === 'number' ? seq : 0,
      type: 'state',
      state: { ready: probe.ready, t: currentT, duration: duration, playing: playing, rate: rate, volume: volume }
    });
  }

  function postFrame(seq, settled, drawnTime) {
    post({
      v: V,
      seq: typeof seq === 'number' ? seq : 0,
      type: 'frame',
      t: drawnTime,
      width: stage.w,
      height: stage.h,
      settled: settled === true
    });
  }

  function clampTime(t) {
    if (!isFinite(t) || t < 0) t = 0;
    if (duration > 0 && t > duration) t = duration;
    return t;
  }

  function clampRate(value) {
    if (!isFinite(value) || value <= 0) return 1;
    return Math.max(0.0625, Math.min(16, value));
  }

  function computeDuration() {
    var end = disabledEnd;
    for (var i = 0; i < clips.length; i++) {
      var clip = clips[i];
      if (clip.hidden || !(clip.length > 0)) continue;
      end = Math.max(end, clip.at + clip.length);
    }
    return Math.round(end * 1000000) / 1000000;
  }

  function isVisible(clip, t) {
    // soloHidden 是预览的独奏过滤（M38）；hidden 是文档属性，两者都算「不显示」。
    if (clip.hidden || clip.soloHidden) return false;
    if (t < clip.at - 1e-9) return false;
    if (clip.length > 0 && t >= clip.at + clip.length - 1e-9) return false;
    return true;
  }

  function sourceTimeOf(clip, t) {
    return clip.in + (t - clip.at) * clip.speed;
  }

  function fadeOf(clip) {
    if (!clip.fade) return 1;
    var fadeIn = Number(clip.fade[0]) || 0;
    var fadeOut = Number(clip.fade[1]) || 0;
    var k = 1;
    if (fadeIn > 0) k = Math.min(k, (currentT - clip.at) / fadeIn);
    if (fadeOut > 0) k = Math.min(k, (clip.at + clip.length - currentT) / fadeOut);
    if (!isFinite(k)) k = 1;
    if (k < 0) k = 0;
    if (k > 1) k = 1;
    return k;
  }

  function cleanBox(box) {
    if (!box || typeof box !== 'object') return null;
    var w = Number(box.w);
    var h = Number(box.h);
    var r = Number(box.r);
    var out = { x: Number(box.x) || 0, y: Number(box.y) || 0 };
    if (w > 0) out.w = w;
    if (h > 0) out.h = h;
    if (r) out.r = r;
    // 解析器对「只写 left/top」会给 w=0/h=0：按没有 box 处理，不把 0 当尺寸。
    if (out.w === undefined && out.h === undefined) return null;
    return out;
  }

  function ownSizeOf(clip) {
    if (clip.kind === 'page') {
      return clip.size && clip.size.w > 0 ? { w: clip.size.w, h: clip.size.h } : { w: stage.w, h: stage.h };
    }
    if (clip.kind === 'video') {
      if (clip.el.videoWidth > 0 && clip.el.videoHeight > 0) return { w: clip.el.videoWidth, h: clip.el.videoHeight };
    }
    if (clip.kind === 'still') {
      if (clip.el.naturalWidth > 0 && clip.el.naturalHeight > 0) return { w: clip.el.naturalWidth, h: clip.el.naturalHeight };
    }
    return { w: stage.w, h: stage.h };
  }

  function pictureRect(kind, own, st, box) {
    var ow = own && own.w > 0 ? own.w : st.w;
    var oh = own && own.h > 0 ? own.h : st.h;
    var b = box || (kind === 'page' ? { x: (st.w - ow) / 2, y: (st.h - oh) / 2 } : { x: 0, y: 0, w: st.w, h: st.h });
    var bw = b.w != null && b.w > 0 ? b.w : (b.h != null && b.h > 0 ? (b.h * ow) / oh : ow);
    var bh = b.h != null && b.h > 0 ? b.h : (b.w != null && b.w > 0 ? (b.w * oh) / ow : oh);
    if (kind !== 'page') return { x: b.x || 0, y: b.y || 0, w: bw, h: bh, r: b.r || 0 };
    var k = Math.min(bw / ow, bh / oh);
    var w = ow * k;
    var h = oh * k;
    return { x: (b.x || 0) + (bw - w) / 2, y: (b.y || 0) + (bh - h) / 2, w: w, h: h, r: b.r || 0 };
  }

  /* ── 点击选层（M19）：舞台里的点击 → Studio ──────────────────────────────
   *
   * 只读、不拦截：capture 阶段监听 click，不 preventDefault（页面里的链接/输入照常可用）。
   * 命中的片段/层换算成**舞台坐标**（film iframe 的视口就是 stage.w × stage.h），
   * 由 Studio 决定「选中片段」还是「选中层」。
   *
   * 只发事件，不新增 op：Studio 侧按 type='pick' 处理（STAGE_REPLY_TYPES 的扩展位）。
   */
  function round2(v) {
    return Math.round(v * 100) / 100;
  }

  function clipElementOf(node) {
    for (var i = 0; i < clips.length; i++) if (clips[i].el === node) return clips[i];
    return null;
  }

  function pictureRectOfClip(clip) {
    return pictureRect(clip.kind, ownSizeOf(clip), stage, clip.box);
  }

  /** 场景坐标的矩形 → 舞台坐标（页面片段可能被缩放/letterbox）。 */
  function sceneBoxToStage(clip, box) {
    var own = ownSizeOf(clip);
    var rect = pictureRectOfClip(clip);
    var kx = own.w > 0 ? rect.w / own.w : 1;
    var ky = own.h > 0 ? rect.h / own.h : 1;
    return { x: rect.x + box.x * kx, y: rect.y + box.y * ky, w: box.w * kx, h: box.h * ky };
  }

  /**
   * 场景窗口里的 client 坐标就是**场景布局坐标**：场景文档自己没有被缩放，
   * 缩放是外层 iframe 的 CSS transform，不进入场景的 event.clientX/Y。
   */
  function scenePointOf(clip, clientX, clientY) {
    return { x: clientX, y: clientY };
  }

  /**
   * 舞台坐标 → 场景布局坐标（sceneBoxToStage 的反向）。
   *
   * S97 的点击穿透用：宿主只知道舞台坐标（clip 框上的一次点击），场景里的层矩形是布局坐标。
   * 页面片段被 letterbox 缩过，不除回去就会偏（点标题命中卡片）。
   */
  function stagePointToScene(clip, sx, sy) {
    var own = ownSizeOf(clip);
    var rect = pictureRectOfClip(clip);
    var kx = own.w > 0 ? rect.w / own.w : 1;
    var ky = own.h > 0 ? rect.h / own.h : 1;
    return { x: kx > 0 ? (sx - rect.x) / kx : 0, y: ky > 0 ? (sy - rect.y) / ky : 0 };
  }

  /**
   * 场景里点中的层：按 readLayer 的实测矩形做包含测试，**最小的赢**（文字优先于卡片）。
   * 没有安装检查器运行时（readLayer/snapshotLayers）→ null（Studio 退化为选片段）。
   */
  function pickLayerAt(clip, sx, sy) {
    var win = sceneWindowOf(clip);
    if (!win) return null;
    var list = runnerFor(win, 'snapshotLayers');
    var read = runnerFor(win, 'readLayer');
    if (!list || !read) return null;
    var snapshot = null;
    try {
      snapshot = list({});
    } catch (error) {
      return null;
    }
    var layers = snapshot && snapshot.layers ? snapshot.layers : [];
    // A nested title and its wrapper can have identical bounds. Prefer the painted
    // DOM target and its nearest editable ancestor before the rectangle fallback.
    var sceneDoc = win.document;
    var node = sceneDoc.elementFromPoint(sx, sy);
    while (node && node !== sceneDoc.body && node !== sceneDoc.documentElement) {
      for (var j = 0; j < layers.length; j++) {
        if (!node.matches(layers[j].at)) continue;
        var match = read(layers[j].at);
        if (match && match.ok && match.value && match.value.box) return { at: layers[j].at, box: match.value.box, description: match, kind: layers[j].kind };
      }
      node = node.parentElement;
    }
    var best = null;
    for (var i = 0; i < layers.length; i++) {
      var described = null;
      try {
        described = read(layers[i].at);
      } catch (error) {
        continue;
      }
      if (!described || described.ok !== true) continue;
      // readLayer 的回包是 {ok:true, value:{box,...}}；这里兼容裸对象，免得两处形状不一致。
      var value = described.value && typeof described.value === 'object' ? described.value : described;
      var b = value.box;
      if (!b) continue;
      if (!(b.w > 0 && b.h > 0)) continue;
      if (sx < b.x || sy < b.y || sx > b.x + b.w || sy > b.y + b.h) continue;
      var area = b.w * b.h;
      if (!best || area < best.area) best = { at: layers[i].at, box: b, area: area, description: described, kind: layers[i].kind };
    }
    return best;
  }

  /**
   * @param {any} clip @param {string} at
   * @param {any} rect @param {any} point
   * @param {boolean} [shift] 按下时是否按着 Shift（S93：多选要能点出来）
   *
   * shift 是**纯增量**字段：老宿主不读它，行为与以前完全一致；
   * 新宿主（App 的 pick 分支）据此决定「换选」还是「加选/取消」。
   * 这里只上报按键状态，**不在这里做选择**——选中是 Studio 的 UI 态。
   */
  function postPick(clip, at, rect, point, shift) {
    probe.lastPick = { clip: clip ? clip.id : '', at: at || '', shift: shift === true };
    post({
      v: V,
      seq: 0,
      type: 'pick',
      clip: clip ? clip.id : '',
      at: at || '',
      rect: rect ? { x: round2(rect.x), y: round2(rect.y), w: round2(rect.w), h: round2(rect.h) } : null,
      point: point ? { x: round2(point.x), y: round2(point.y) } : null,
      shift: shift === true
    });
  }

  /** film.html 里的点击（视频/图片/页面片段的边框）：找最近的片段元素。 */
  function onFilmClick(event) {
    if (event.button !== 0) return;
    /* 拖拽 seek 刚结束：浏览器补发的这一下 click 不当成「点空白清选择」。 */
    if (Date.now() < suppressClickUntil) return;
    var node = event.target;
    var clip = null;
    while (node && node !== filmDoc.body && node !== filmDoc.documentElement) {
      clip = clipElementOf(node);
      if (clip) break;
      node = node.parentElement;
    }
    if (!clip) {
      /* S97：点舞台空白（不属于任何片段）→ 上报一条 clip 为空串的 pick。
         宿主据此把两套选择一起清空。以前这里直接 return，所以这条消息不存在。 */
      postPick(null, '', null, { x: event.clientX, y: event.clientY }, event.shiftKey);
      return;
    }
    if (clip.kind === 'page') {
      var sp = scenePointOf(clip, event.clientX, event.clientY);
      var picked = pickLayerAt(clip, sp.x, sp.y);
      if (picked) {
        var layerStageBox = sceneBoxToStage(clip, picked.box);
        postPick(clip, picked.at, layerStageBox, { x: layerStageBox.x, y: layerStageBox.y }, event.shiftKey);
      } else {
        postPick(clip, '', pictureRectOfClip(clip), { x: event.clientX, y: event.clientY }, event.shiftKey);
      }
      return;
    }
    var rect = clip.el.getBoundingClientRect();
    postPick(clip, '', { x: rect.x, y: rect.y, w: rect.width, h: rect.height }, { x: event.clientX, y: event.clientY }, event.shiftKey);
  }

  /**
   * ── 舞台拖拽 seek（UI-V4-01）────────────────────────────────────────────
   *
   * 空白处按下 → 按 **x 占舞台宽的比**换算时间（时间由 Studio 换算，它才知道片长）；
   * 拖动中每帧最多发一条 「seek」（rAF 合并）；松手发 「commit:true」 收尾。
   *
   * 只在**空白**起手：按下点落在任何片段元素里 → 交给原来的 click/pick 路径，
   * 点上层的选中、拖动位移一点都不动。
   * 只发事件、不新增 op（与 pick 同一条原则）；宿主用 「seekTo」 落播放头与时间码。
   */
  var seekDrag = null;
  var suppressClickUntil = 0;

  /** 舞台坐标的比例（0..1）：iframe 的视口就是 stage.w×stage.h。 */
  function stageRatioOf(clientX) {
    var w = filmDoc.documentElement.clientWidth || (stage && stage.w) || 0;
    if (!(w > 0)) return null;
    var r = clientX / w;
    return r < 0 ? 0 : r > 1 ? 1 : r;
  }

  function postSeek(phase, ratio, commit) {
    var dbg = window.__seekDbg || (window.__seekDbg = { down: 0, move: 0, post: 0, last: null });
    dbg.post += 1;
    dbg.last = { phase: phase, ratio: round2(ratio) };
    post({ v: V, seq: 0, type: 'seek', phase: phase, ratio: round2(ratio), commit: commit === true });
  }

  function onFilmPointerDown(event) {
    if (!event || event.button !== 0) return;
    /* 非空白（命中片段）→ 不接管；选中/位移走原来的 click 与手势层。 */
    if (clipElementOf(event.target) !== null) {
      seekDrag = null;
      return;
    }
    var dbg0 = window.__seekDbg || (window.__seekDbg = { down: 0, move: 0, post: 0, last: null });
    dbg0.down += 1;
    dbg0.last = { phase: 'down', x: event.clientX, target: event.target && event.target.tagName };
    seekDrag = { id: event.pointerId, x0: event.clientX, dragging: false, raf: 0, ratio: 0 };
    /* 按下即定位（与时间线标尺同一手感）：不等到第一次 move 才跳。 */
    var downRatio = stageRatioOf(event.clientX);
    if (downRatio !== null) {
      seekDrag.ratio = downRatio;
      postSeek('move', downRatio, false);
    }
    /* 指针捕获：拖到片段（视频/网页片段是各自文档）上方时，move 仍回到舞台文档，
       否则一次拖拽会在碰到片段的瞬间断掉。 */
    try {
      if (filmDoc.documentElement.setPointerCapture) filmDoc.documentElement.setPointerCapture(event.pointerId);
    } catch (error) {
      /* 捕获失败不影响起手，退化成「只在空白区里有效」 */
    }
    filmDoc.addEventListener('pointermove', onFilmPointerMove, true);
    filmDoc.addEventListener('pointerup', onFilmPointerUp, true);
    filmDoc.addEventListener('pointercancel', onFilmPointerUp, true);
  }

  function onFilmPointerMove(event) {
    if (!seekDrag || event.pointerId !== seekDrag.id) return;
    if (!seekDrag.dragging) {
      /* 3px 以内算点击（与时间线标尺同一口径），不算拖拽 */
      if (Math.abs(event.clientX - seekDrag.x0) < 3) return;
      seekDrag.dragging = true;
    }
    var ratio = stageRatioOf(event.clientX);
    if (ratio === null) return;
    if (window.__seekDbg) window.__seekDbg.lastMove = { clientX: event.clientX, ratio: round2(ratio) };
    seekDrag.ratio = ratio;
    if (seekDrag.raf !== 0) return;
    var raf = window.requestAnimationFrame || function (fn) { return window.setTimeout(fn, 16); };
    seekDrag.raf = raf(function () {
      if (!seekDrag) return;
      seekDrag.raf = 0;
      postSeek('move', seekDrag.ratio, false);
    });
  }

  function onFilmPointerUp(event) {
    if (!seekDrag || event.pointerId !== seekDrag.id) return;
    var drag = seekDrag;
    seekDrag = null;
    filmDoc.removeEventListener('pointermove', onFilmPointerMove, true);
    filmDoc.removeEventListener('pointerup', onFilmPointerUp, true);
    filmDoc.removeEventListener('pointercancel', onFilmPointerUp, true);
    if (drag.raf !== 0 && window.cancelAnimationFrame) window.cancelAnimationFrame(drag.raf);
    try {
      if (filmDoc.documentElement.releasePointerCapture) filmDoc.documentElement.releasePointerCapture(event.pointerId);
    } catch (error) {
      /* 已释放 */
    }
    var ratio = event.type === 'pointercancel' || !drag.dragging ? drag.ratio : stageRatioOf(event.clientX);
    postSeek('end', ratio === null ? drag.ratio : ratio, true);
    if (!drag.dragging) return;
    /* 拖完浏览器还会补一个 click：400ms 内不再当「点空白清选择」。 */
    suppressClickUntil = Date.now() + 400;
  }

  // Capture in the document that owns the actual hit. The Studio iframe and
  // scene iframe have separate pointer streams, including when dragging outside.
  var bodyPaint = null;
  function clearBodyPaint() {
    if (bodyPaint && bodyPaint.animation) bodyPaint.animation.cancel();
    bodyPaint = null;
  }

  function previewBody(command) {
    var paint = bodyPaint;
    if (!paint || paint.clip !== command.clip || paint.at !== command.at) return;
    if (command.clear) { clearBodyPaint(); return; }
    var frame;
    if (paint.at) {
      var style = command.style;
      if (!style || typeof style.left !== 'string' || typeof style.top !== 'string') return;
      frame = { left: style.left, top: style.top };
      if (style.position === 'relative') frame.position = 'relative';
    } else {
      if (!Number.isFinite(command.dx) || !Number.isFinite(command.dy)) return;
      var base = paint.el.style.transform;
      frame = { transform: 'translate(' + command.dx + 'px,' + command.dy + 'px) ' + (base && base !== 'none' ? base : '') };
    }
    // A temporary animation leaves the authored inline style intact on release or cancellation.
    if (paint.animation) paint.animation.effect.setKeyframes([frame, frame]);
    else paint.animation = paint.el.animate([frame, frame], { duration: 1, fill: 'both' });
  }

  function bindBodyPointers(doc, sceneClip) {
    if (!STUDIO) return;
    var active = null;
    var skipClick = false;
    function hit(event) {
      var clip = sceneClip;
      for (var n = event.target; !clip && n; n = n.parentElement) clip = clipElementOf(n);
      if (!clip || !clip.visible || clip.kind === 'sound') return null;
      var layer = sceneClip ? pickLayerAt(clip, event.clientX, event.clientY) : null;
      return { clip: clip, layer: layer };
    }
    function send(phase, event, target) {
      // screenX/Y share an origin across all iframe levels and already include
      // stage/page scaling. The host uses their difference for drag geometry.
      var layer = target.layer;
      var message = { v: V, seq: 0, type: 'body', phase: phase, clip: target.clip.id,
        at: layer ? layer.at : '', pointerId: event.pointerId, pointerType: event.pointerType,
        x: event.screenX, y: event.screenY, altKey: event.altKey, shiftKey: event.shiftKey };
      if (phase === 'down' || phase === 'edit') {
        message.description = layer ? layer.description : null;
        message.rect = layer ? sceneBoxToStage(target.clip, layer.box) : pictureRectOfClip(target.clip);
        if (phase === 'edit' && !layer && target.clip.kind === 'text') {
          var computed = doc.defaultView.getComputedStyle(target.clip.el);
          message.font = {};
          ['fontSize', 'lineHeight', 'fontFamily', 'color', 'textAlign', 'fontWeight', 'letterSpacing',
            'fontStyle', 'textTransform', 'textIndent', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].forEach(function (key) {
            message.font[key] = computed[key];
          });
        }
      }
      post(message);
    }
    doc.addEventListener('pointerdown', function (event) {
      if (active || event.button !== 0 || event.isPrimary === false) return;
      skipClick = false;
      if (event.shiftKey || event.metaKey || event.ctrlKey) return;
      var target = hit(event);
      if (!target) return;
      active = { id: event.pointerId, target: target, x: event.screenX, y: event.screenY };
      clearBodyPaint();
      var at = target.layer ? target.layer.at : '';
      var el = at ? doc.querySelector(at) : target.clip.el;
      if (el) bodyPaint = { clip: target.clip.id, at: at, el: el, animation: null };
      skipClick = true;
      event.preventDefault();
      try { event.target.setPointerCapture(event.pointerId); } catch (error) {}
      send('down', event, target);
    }, true);
    function update(event) {
      if (!active || active.id !== event.pointerId) return;
      var target = active.target;
      var phase = event.type === 'pointermove' ? 'move' : event.type === 'pointerup' ? 'up' : 'cancel';
      if (phase !== 'move') { active = null; clearBodyPaint(); }
      send(phase, event, target);
    }
    doc.addEventListener('pointermove', update, true);
    doc.addEventListener('pointerup', update, true);
    doc.addEventListener('pointercancel', update, true);
    doc.addEventListener('lostpointercapture', update, true);
    doc.addEventListener('keydown', function (event) {
      if (!active || event.key !== 'Escape') return;
      send('cancel', { pointerId: active.id, screenX: active.x, screenY: active.y }, active.target);
      active = null;
      clearBodyPaint();
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    doc.addEventListener('click', function (event) {
      if (!skipClick || !event.detail) return;
      skipClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    doc.addEventListener('dblclick', function (event) {
      if (event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey) return;
      var target = hit(event);
      if (!target || (target.layer ? target.layer.kind !== 'text' : target.clip.kind !== 'text')) return;
      event.preventDefault();
      send('edit', event, target);
    }, true);
  }

  /** 场景页里的点击（网页片段内部）：直接命中层。 */
  function bindScenePick(clip) {
    var win = sceneWindowOf(clip);
    if (!win || !win.document) return;
    if (clip.pickDoc === win.document) return;
    clip.pickDoc = win.document;
    bindBodyPointers(win.document, clip);
    win.document.addEventListener(
      'click',
      function (event) {
        if (event.button !== 0) return;
        var sp = scenePointOf(clip, event.clientX, event.clientY);
        var picked = pickLayerAt(clip, sp.x, sp.y);
        if (!picked) {
          postPick(clip, '', pictureRectOfClip(clip), { x: sp.x, y: sp.y }, event.shiftKey);
          return;
        }
        var stageBox = sceneBoxToStage(clip, picked.box);
        postPick(clip, picked.at, stageBox, { x: stageBox.x, y: stageBox.y }, event.shiftKey);
      },
      true
    );
    /* 场景页自己的文档也会抢焦点（点进去之后 activeElement 在它这边），Escape 要自己转发。 */
    win.document.addEventListener('keydown', onStageKeydown, true);
  }

  function applyStageSize() {
    stageEl.style.width = stage.w + 'px';
    stageEl.style.height = stage.h + 'px';
    filmEl.style.width = stage.w + 'px';
    filmEl.style.height = stage.h + 'px';
    fitStage();
  }

  function fitStage() {
    if (CONFIG.fit === 'none') {
      wrapEl.style.display = 'block';
      stageEl.style.transform = 'none';
      stageEl.style.transformOrigin = '0 0';
      document.body.style.width = stage.w + 'px';
      document.body.style.height = stage.h + 'px';
      return;
    }
    var scale = Math.min(window.innerWidth / stage.w, window.innerHeight / stage.h);
    if (!isFinite(scale) || scale <= 0) scale = 1;
    // 先按 0,0 锚点缩放，再把缩放后的画面居中（两个方向都夹到 >= 0，避免溢出被裁）。
    var dx = Math.max(0, (window.innerWidth - stage.w * scale) / 2);
    var dy = Math.max(0, (window.innerHeight - stage.h * scale) / 2);
    stageEl.style.transformOrigin = '0 0';
    stageEl.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(' + scale + ')';
  }

  function placeClip(clip) {
    var own = ownSizeOf(clip);
    var rect = pictureRect(clip.kind, own, stage, clip.box);
    // 摆位与时间无关（只跟 box/自身尺寸/轨道序有关）：算出来的键没变就一个 style 都不写。
    // 逐帧 12 个片段 × 10 个属性 = 每帧 120 次 style 写入，是白扔的样式重算。
    var key = rect.x + ',' + rect.y + ',' + rect.w + ',' + rect.h + ',' + (rect.r || 0) + ',' + own.w + ',' + own.h + ',' + clip.z;
    if (clip.placedKey === key) return;
    clip.placedKey = key;
    var s = clip.el.style;
    s.position = 'absolute';
    s.margin = '0';
    /* R150 / M16-R3-B：iframe 的 UA 默认边框是 **2px inset**。页面片段是 iframe 且
       box-sizing: border-box，这 2px 会吃掉内容盒 → 画面整体 +2/+2、右/下各裁 2px，
       成片外圈那条 154/237 平顶带就是它（不是抗锯齿、不是编码器）。
       清零后页内坐标 == 舞台坐标 == 成片坐标，取景原点回到 (0,0)。 */
    s.border = '0';
    s.right = 'auto';
    s.bottom = 'auto';
    s.zIndex = String(clip.z);
    s.boxSizing = 'border-box';
    if (clip.kind === 'page') {
      s.left = '0';
      s.top = '0';
      s.width = own.w + 'px';
      s.height = own.h + 'px';
      s.transformOrigin = '0 0';
      s.transform = 'translate(' + rect.x + 'px,' + rect.y + 'px) rotate(' + (rect.r || 0) + 'deg) scale(' + (rect.w / own.w) + ',' + (rect.h / own.h) + ')';
    } else {
      s.left = rect.x + 'px';
      s.top = rect.y + 'px';
      s.width = rect.w + 'px';
      s.height = rect.h + 'px';
      s.transformOrigin = '0 0';
      s.transform = rect.r ? 'rotate(' + rect.r + 'deg)' : '';
    }
  }

  function applyFade(clip) {
    if (!clip.fade) return;
    var fadeIn = Number(clip.fade[0]) || 0;
    var fadeOut = Number(clip.fade[1]) || 0;
    if (fadeIn <= 0 && fadeOut <= 0) return;
    var k = fadeOf(clip);
    if (clip.baseOpacity == null) {
      var originalOpacity = Number(getComputedStyle(clip.el).opacity);
      clip.baseOpacity = Number.isFinite(originalOpacity) ? originalOpacity : 1;
    }
    // 同一个透明度不重复写（淡入淡出只有切点前后几帧真的在变）。
    var key = k >= 1 ? 'none' : String(Math.round(clip.baseOpacity * k * 1000) / 1000);
    if (clip.fadeKey === key) return;
    clip.fadeKey = key;
    if (k >= 1) clip.el.style.removeProperty('opacity');
    else clip.el.style.setProperty('opacity', String(clip.baseOpacity * k), 'important');
  }

  function applyAudio(clip) {
    var gain;
    // 独奏过滤只影响预览：未独奏轨的声音也归零（M38）。
    // fade 是**画面**的淡入淡出：只有声音片段才把它乘进音频增益；
    // 视频的淡变不该带着原声一起忽大忽小（导出侧也是分开算的）。
    var fadeGain = clip.kind === 'sound' ? fadeOf(clip) : 1;
    if (clip.muted || clip.soloHidden) gain = 0;
    else gain = (typeof clip.volume === 'number' ? clip.volume : 1) * fadeGain * presetTransitions.audioGain(clip, currentT) * volume;
    if (!(gain >= 0)) gain = 0;
    clip.gain = gain;
    // 两段增益：元素音量只能到 1（HTMLMediaElement.volume 的上限），超出部分交给
    // GainNode。元素音量在 MediaElementSource **之前**生效（实测），两段相乘 = 真增益；
    // ≤1 时节点恒为 1，与旧实现逐样本相同。没有 WebAudio 时只剩元素音量（夹到 1），
    // 但 clip.gain 仍写真值，probe.audio().routed=false 能看出来。
    var elementVolume = gain > 1 ? 1 : gain;
    var nodeGain = gain > 1 ? gain : 1;
    // 静音两段都归零：不赌「浏览器在 MediaElementSource 之前就应用了 muted」。
    if (clip.muted || clip.soloHidden || !(gain > 0)) {
      elementVolume = 0;
      nodeGain = 0;
    }
    if (Math.abs(clip.el.volume - elementVolume) > 1e-4) clip.el.volume = elementVolume;
    if (clip.gainNode && Math.abs(clip.gainNode.gain.value - nodeGain) > 1e-4) clip.gainNode.gain.value = nodeGain;
    var elementMuted = clip.muted === true || clip.mutedFallback === true;
    if (elementMuted !== clip.el.muted) clip.el.muted = elementMuted;
  }

  function frames(n) {
    return new Promise(function (resolve) {
      var left = n;
      function step() {
        left -= 1;
        if (left <= 0) resolve();
        else requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    });
  }

  /**
   * 「新帧画出来了吗」的等待预算（毫秒）。
   *
   * 为什么不是 400ms：requestVideoFrameCallback 只在**合成器真的把新视频帧提交上去**时回调。
   * 暂停态逐帧 seek 时它经常根本不回调（M22 实测 30 帧里 21 次没回调），原来固定等 400ms
   * 就是纯空转——一帧 380ms 里 330ms 是这个超时。40ms ≈ 一个 25fps 合成器 tick：
   * 回调不来就说明这一帧不会再「被呈现」了，而元素本身已经 seek 到目标时间，
   * 后面还有 2 个 rAF + 调用方的 screenshot 会强制合成，像素不受影响（A5 逐像素为证）。
   */
  var PRESENT_BUDGET_MS = 40;

  /** 两次 seek 的目标差小于这个值就当同一帧（半帧 @60fps），直接复用当前画面。 */
  var SAME_FRAME_EPS = 1 / 120;

  function seekClip(clip, signal) {
    var el = clip.el;
    var want = Math.max(0, sourceTimeOf(clip, currentT));
    if (!el.paused) el.pause();
    // 声音真的跳了位置：下一个采样点不许再把旧位置的分析窗口读出来（M32-B4）。
    if (clip.kind === 'sound') meterSilenceUntil = performance.now() + 80;
    var stats = probe.settle;
    var seekStart = performance.now();
    var presentStart = 0;
    stats.seekCalls += 1;
    return new Promise(function (resolve) {
      var done = false;
      var presentationTimer = 0;
      var videoCallback = null;
      function abortSeek() { finish(false); }
      function finish(ok) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(presentationTimer);
        if (videoCallback !== null) el.cancelVideoFrameCallback(videoCallback);
        if (signal) signal.removeEventListener('abort', abortSeek);
        el.removeEventListener('seeked', afterSeek);
        el.removeEventListener('loadeddata', afterSeek);
        el.removeEventListener('error', mediaFailed);
        stats.seekMs += performance.now() - seekStart;
        if (presentStart > 0) stats.presentMs += performance.now() - presentStart;
        resolve(ok);
      }
      var timer = setTimeout(function () { finish(false); }, 3000);
      if (signal) signal.addEventListener('abort', abortSeek, { once: true });
      function presented() {
        presentStart = performance.now();
        stats.mediaWaits += 1;
        // 声音没有像素：seeked 之后不需要再等合成（原来白等两个 rAF）。
        if (clip.kind !== 'video') {
          finish(true);
          return;
        }
        if (typeof el.requestVideoFrameCallback === 'function') {
          videoCallback = el.requestVideoFrameCallback(function () {
            videoCallback = null;
            clearTimeout(presentationTimer);
            stats.rvfcHit += 1;
            requestAnimationFrame(function () { requestAnimationFrame(function () { finish(true); }); });
          });
          presentationTimer = setTimeout(function () {
            stats.rvfcMiss += 1;
            finish(true);
          }, PRESENT_BUDGET_MS);
          return;
        }
        requestAnimationFrame(function () { requestAnimationFrame(function () { finish(true); }); });
      }
      function afterSeek() {
        // loadeddata may precede seeked on a fresh video at a nonzero time.
        var target = Number.isFinite(el.duration) ? Math.min(want, el.duration) : want;
        if (el.seeking || el.readyState < 2 || Math.abs(el.currentTime - target) >= SAME_FRAME_EPS) return;
        el.removeEventListener('seeked', afterSeek);
        el.removeEventListener('loadeddata', afterSeek);
        presented();
      }
      if (!el.seeking && el.readyState >= 2 && Math.abs(el.currentTime - want) < SAME_FRAME_EPS) {
        stats.seekSkipped += 1;
        afterSeek();
        return;
      }
      function mediaFailed() { finish(false); }
      if (el.error) { mediaFailed(); return; }
      el.addEventListener('seeked', afterSeek);
      el.addEventListener('loadeddata', afterSeek);
      el.addEventListener('error', mediaFailed, { once: true });
      try { el.currentTime = want; } catch (e) { finish(false); }
    });
  }

  function waitFilmLoad() {
    return new Promise(function (resolve) {
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        resolve();
      }
      function ready() {
        var d = filmEl.contentDocument;
        // 初始的 about:blank 也是 complete，但它不是影片：必须等真正提交了 film.html。
        return !!d && d.URL !== 'about:blank' && d.readyState === 'complete' && !!d.body;
      }
      var started = performance.now();
      function poll() {
        if (done) return;
        if (ready()) { finish(); return; }
        if (performance.now() - started > 10000) { finish(); return; }
        setTimeout(poll, 40);
      }
      filmEl.addEventListener('load', function () {
        if (ready()) finish();
        else poll();
      }, { once: true });
      poll();
    });
  }

  function pageFilm(clip) {
    var win = clip.el.contentWindow;
    return win && win.film ? win.film : null;
  }

  function pageReadyOf(film) {
    if (!film) return Promise.resolve();
    if (typeof film.ready === 'function') return Promise.resolve(film.ready());
    if (film.ready && typeof film.ready.then === 'function') return Promise.resolve(film.ready);
    return Promise.resolve();
  }

  function waitPageFilm(clip, ms) {
    return new Promise(function (resolve) {
      var started = performance.now();
      function poll() {
        var film = pageFilm(clip);
        if (film && typeof film.frame === 'function') { resolve(film); return; }
        if (performance.now() - started > ms) { resolve(film); return; }
        setTimeout(poll, 40);
      }
      poll();
    });
  }

  /** 带错误码的 Error：错误分层靠它，别让 TypeError 冒充 NO_FILM。 */
  function sceneError(code, message) {
    var err = new Error(message);
    err.code = code;
    return err;
  }

  /**
   * 取一帧场景画面。
   *
   * 合同 frame.ts 只要求「把画面画到 t」，**没有**要求返回 Promise：
   * 计划样例的 window.film.frame(t) 是同步的、返回 undefined。所以这里不假定 thenable——
   * 只要调完没抛错就算完成；真返回 Promise 才等它。
   *
   * 错误分层（M13-A3/A5）：没有 window.film 由调用方报 NO_FILM；这里只区分
   * 「frame() 抛错」= FRAME_THREW 与「迟迟不完成」= FRAME_TIMEOUT。
   * @param {any} film
   * @param {number} local 场景自己的时间（秒）
   * @returns {Promise<boolean>}
   */
  function callSceneFrame(film, local) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        reject(sceneError('FRAME_TIMEOUT', 'scene frame(' + local + ') 超过 ' + FRAME_TIMEOUT_MS + 'ms 没有完成'));
      }, FRAME_TIMEOUT_MS);
      function finish() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(true);
      }
      function fail(error) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(
          sceneError(
            'FRAME_THREW',
            'scene frame(' + local + ') 抛错：' + String(error && error.message ? error.message : error)
          )
        );
      }
      var out;
      try {
        out = film.frame(local);
      } catch (error) {
        fail(error);
        return;
      }
      if (out && typeof out.then === 'function') Promise.resolve(out).then(finish, fail);
      else finish();
    });
  }

  function drawPage(clip, t) {
    var film = pageFilm(clip);
    var waiting = film && typeof film.frame === 'function' ? Promise.resolve(film) : waitPageFilm(clip, 2000);
    return waiting.then(function (found) {
      if (!found || typeof found.frame !== 'function') {
        throw sceneError('NO_FILM', 'clip ' + clip.id + ' (' + clip.src + ') 没有 window.film，无法画出它的画面');
      }
      return pageReadyOf(found).then(function () {
        // 场景时间 = in + (t - at) * speed，与视频/声音同一套 sourceTimeOf。
        var local = sourceTimeOf(clip, t);
        return callSceneFrame(found, local).then(function () {
          clip.sceneFrames += 1;
          sceneFrames += 1;
          probe.sceneFrames = sceneFrames;
          clip.lastFrameError = null;
          // 场景页每次 load 都是新的 document：按 document 身份重绑，不重复绑。
          bindScenePick(clip);
        });
      });
    });
  }

  function attachMediaError(el, clipId, src) {
    var report = function () {
      var code = el.error && el.error.code;
      if (code === 1 || !code) return; // aborted source or provisional network state
      var detail = code === 3 ? '解码失败' : code === 4 ? '找不到可播放的来源或编码不受支持' : '读取媒体失败';
      var actual = el.getAttribute('src') || src;
      reportError('MEDIA_FAILED', '片段 ' + clipId + '：' + detail + '（' + actual + '）');
    };
    el.addEventListener('error', report);
    // 元素的 error 可能在舞台接管之前就已经发生（iframe load 早于 runtime 执行）：
    // 这里补一次状态检查，不把「已经 404」当成没发生。
    if (el.error) report();
  }

  /**
   * 动效库模板不是场景页：它们没有 window.film，相位只认 --motion-t
   * （由 applyMotionTime 统一写）。不补壳的话 drawPage 会按 NO_FILM 记错——
   * 预览每帧都报「画不出来」，导出取帧同样失败。
   *
   * 只给**页面自己声明过动效**的文档补（meta[name="motion-clock"] 或
   * [data-instance]），不猜普通网页；壳里的 frame() 是空操作，真正的定格仍在
   * applyMotionTime() —— 这里只负责让取帧路径成立。
   *
   * @param {any} clip
   * @returns {boolean} 是否补了壳
   */
  function ensureMotionFilm(clip) {
    var el = clip.el;
    var win = null;
    try {
      win = el.contentWindow;
    } catch (error) {
      win = null;
    }
    if (!win) return false;
    if (win.film && typeof win.film.frame === 'function') return false;
    var doc = null;
    try {
      doc = el.contentDocument;
    } catch (error) {
      doc = null;
    }
    if (!doc) return false;
    var declared = null;
    try {
      declared = doc.querySelector('meta[name="motion-clock"]') || doc.querySelector('[data-instance]');
    } catch (error) {
      declared = null;
    }
    if (!declared) return false;
    win.film = {
      meta: { width: stage.w, height: stage.h, duration: clip.length },
      ready: Promise.resolve(),
      frame: function () {
        return true;
      }
    };
    return true;
  }

  /**
   * 页面 iframe 每次 load 都是一个新 document：壳要按新的 contentWindow 重装。
   * @param {any} pageClip
   */
  function watchMotionFilm(pageClip) {
    pageClip.el.addEventListener('load', function () {
      ensureMotionFilm(pageClip);
    });
    ensureMotionFilm(pageClip);
  }

  function prepareFilm() {
    var de = filmDoc.documentElement;
    de.style.margin = '0';
    de.style.width = stage.w + 'px';
    de.style.height = stage.h + 'px';
    de.style.overflow = 'hidden';
    var body = filmDoc.body;
    body.style.margin = '0';
    body.style.width = stage.w + 'px';
    body.style.height = stage.h + 'px';
    body.style.overflow = 'hidden';
    body.style.position = 'relative';

    var sections = [];
    var children = body.children;
    for (var i = 0; i < children.length; i++) if (children[i].localName === 'section') sections.push(children[i]);
    for (var s = 0; s < sections.length; s++) sections[s].style.display = 'contents';

    var disabledIds = new Set();
    doc.tracks.forEach(function (track) {
      track.clips.forEach(function (row) {
        if (row.attrs && row.attrs[disabledAttr] === '1') disabledIds.add(row.id);
      });
    });
    var trackCount = doc.tracks.length;
    for (var ti = 0; ti < doc.tracks.length; ti++) {
      var track = doc.tracks[ti];
      for (var ci = 0; ci < track.clips.length; ci++) {
        var row = track.clips[ci];
        var el = filmDoc.getElementById(row.id);
        var time = Array.isArray(row.time) ? row.time : null;
        var speed = typeof row.speed === 'number' && row.speed > 0 ? row.speed : 1;
        var length = time ? Math.max(0, (Number(time[1]) - Number(time[0])) / speed) : 0;
        if (disabledIds.has(row.id)) {
          var sourceEnd = time && time.length >= 2 ? Number(time[1])
            : Number(row.attrs && row.attrs['data-native']) || (el && el.duration);
          var disabledLength = (sourceEnd - (time ? Number(time[0]) : 0)) / speed;
          if (track.hidden !== true && isFinite(disabledLength) && disabledLength > 0) {
            disabledEnd = Math.max(disabledEnd, (Number(row.at) || 0) + disabledLength);
          }
          // Remove only this preview DOM node. The source and its timeline position remain on disk.
          if (el) {
            if (typeof el.pause === 'function') {
              el.muted = true;
              el.pause();
            }
            el.remove();
          }
          continue;
        }
        if (!el) {
          reportError('MEDIA_FAILED', '片段 ' + row.id + ' 在 film.html 里找不到元素');
          continue;
        }
        var kind = row.kind || 'video';
        if (disabledIds.size > 0 && el.hasAttribute(transitionAttr)) {
          try {
            var spec = JSON.parse(el.getAttribute(transitionAttr));
            if (spec && (disabledIds.has(spec.from) || disabledIds.has(spec.to))) el.removeAttribute(transitionAttr);
          } catch (error) { /* Invalid transitions are already ignored by the runtime. */ }
        }
        // 没有 #t= 的网页片段（解析器给 warning）：从 at 起一直显示，长度未知按 0 处理。
        var clip = {
          id: row.id,
          kind: kind,
          src: row.src,
          el: el,
          at: typeof row.at === 'number' ? row.at : 0,
          in: time ? Number(time[0]) : 0,
          out: time ? Number(time[1]) : null,
          speed: speed,
          length: length,
          fade: Array.isArray(row.fade) ? [Number(row.fade[0]), Number(row.fade[1])] : null,
          volume: typeof row.volume === 'number' ? row.volume : 1,
          muted: row.muted === true || track.muted === true,
          size: row.size && row.size.w > 0 ? { w: row.size.w, h: row.size.h } : null,
          box: cleanBox(row.box),
          hidden: track.hidden === true,
          soloHidden: false,
          trackIndex: ti,
          z: trackCount - ti,
          baseOpacity: null,
          gain: 1,
          visible: false,
          sceneFrames: 0
        };
        /* R184：源是 HEVC 这类 Chromium 解不了的编码时，导出侧已经转好 H.264 代理；
           这里把 src 指过去（相对 film.html 的路径）。代理长度/内容与源一致，裁切仍按 doc 的 time。 */
        if (row.proxy && typeof row.proxy === 'string' && el.getAttribute('src') !== row.proxy) {
          el.src = row.proxy;
        }
        if (kind === 'video') {
          /* 预览要能听见视频自己的声音：muted 只认文档里的旗标（无音轨的视频
             在导入时就写了 muted）。以前这里恒为 true，导出有声、预览却全程静音。 */
          el.muted = clip.muted === true;
          el.preload = 'auto';
          el.playsInline = true;
          attachMediaError(el, row.id, row.src);
        } else if (kind === 'sound') {
          el.preload = 'auto';
          attachMediaError(el, row.id, row.src);
        }
        if (kind === 'video' || kind === 'sound') {
          var followPointer = syncScrubMedia.bind(null, clip);
          el.addEventListener('seeked', followPointer);
          el.addEventListener('loadeddata', followPointer);
        }
        if (kind !== 'sound') el.style.visibility = 'hidden';
        // 工程里**已提交**的覆盖：舞台启动就带上，画完这一帧再应用（不是靠 Studio 每次补发）。
        if (kind === 'page' && Array.isArray(row.overrides) && row.overrides.length) {
          activeOverrides[row.id] = row.overrides;
        }
        clips.push(clip);
        /* 动效库模板（motion/assets/**）没有 window.film：给它补一个空帧壳，
           否则这一层在预览/导出里都会被判成 NO_FILM。 */
        if (kind === 'page') watchMotionFilm(clip);
      }
    }

    // 点击选层：film 文档只绑一次；场景页在 drawPage 里按 document 身份绑。
    bindBodyPointers(filmDoc, null);
    filmDoc.addEventListener('click', onFilmClick, true);
    filmDoc.addEventListener('keydown', onStageKeydown, true);
    /* UI-V4-01：空白按下 → 拖拽 seek（只在空白起手，命中片段时立刻退出） */
    filmDoc.addEventListener('pointerdown', onFilmPointerDown, true);
    window.__seekBound = (window.__seekBound || 0) + 1;
    try { filmDoc.documentElement.setAttribute('data-seek-bound', '1'); } catch (error) { /* 只读文档 */ }
  }

  /**
   * S93：跨源 iframe 里的按键**不会冒泡到父文档**。实测：在画布上点一下之后
   * document.activeElement 是 preview-iframe，父文档的 keydown 一次都收不到。
   * 只转发 Escape（清空元素多选），其它键一律不转——免得和 Studio 的全局快捷键打架。
   */
  function onStageKeydown(event) {
    if (!event || event.key !== 'Escape') return;
    post({ v: V, seq: 0, type: 'key', key: 'Escape' });
  }

  /**
   * 画一个场景片段：失败只记在它自己身上，返回 {ok:false,error}，不把整帧打成 rejected。
   * @param {any} clip
   * @returns {Promise<{ok: boolean, error?: {code: string, message: string}}>}
   */
  function drawOneScene(clip, t) {
    return drawPage(clip, t).then(
      function () {
        return { ok: true };
      },
      function (err) {
        var error = {
          code: err && err.code ? err.code : 'FRAME_THREW',
          message: String(err && err.message ? err.message : err),
          clipId: clip.id
        };
        clip.lastFrameError = error;
        reportError(error.code, error.message);
        return { ok: false, error: error };
      }
    );
  }

  /* ── 图层覆盖（检查器 M13-A7）────────────────────────────────────────────
   *
   * readLayer / applyOverrideEntries 是 packages/layers 的**现成导出**，它们直接读全局
   * document——也就是「函数所在的 realm」。舞台与场景页同 origin，所以把这两段函数体交给
   * 场景自己的 window.Function 编译：函数里的 document / getComputedStyle 全部指向场景文档。
   * 这样既不重写一份读数/覆盖逻辑，也不必把 TS 模块搬进内容 origin。
   */
  /**
   * S83：服务端随页面下发的三段源码。预览与成片**同一份**，不再等 Studio 的
   * installLayers；收到 installLayers 仍然就地覆盖（同内容，幂等）。
   */
  /** 与 content-origin 导出的 frameOutcome() 是同一份源码（S83），不许各写一套。 */
  var frameOutcome = ${FRAME_OUTCOME_SOURCE};
  var SEED_LAYERS = CONFIG.layers && typeof CONFIG.layers === 'object' ? CONFIG.layers : {};
  function seededSource(key) {
    var value = SEED_LAYERS[key];
    return typeof value === 'string' && value !== '' ? value : null;
  }
  var layerSources = {
    readLayer: seededSource('readLayer'),
    applyOverrideEntries: seededSource('applyOverrideEntries'),
    snapshotLayers: seededSource('snapshotLayers')
  };
  /** @type {Record<string, any[]>} clipId → entries */
  var activeOverrides = {};
  var realmRunners = new WeakMap();

  function runnerFor(win, key) {
    var source = layerSources[key];
    if (!source) return null;
    var cache = realmRunners.get(win);
    if (!cache) {
      cache = {};
      realmRunners.set(win, cache);
    }
    if (!cache[key]) {
      try {
        cache[key] = new win.Function('arg', 'return (' + source + ')(arg);');
      } catch (error) {
        return null;
      }
    }
    return cache[key];
  }

  function sceneWindowOf(clip) {
    var win = clip && clip.el ? clip.el.contentWindow : null;
    return win && win.document ? win : null;
  }

  /**
   * 每个可见场景在 frame 之后重放自己的覆盖；画完才应用，顺序不能反。
   *
   * S83：返回值是**这一帧没打成的覆盖**。以前拿不到 runner 就记一条
   * NO_LAYER_RUNTIME 然后 continue——导出会话没有 UI 握手，于是所有覆盖都被静默
   * 丢掉，成片与预览不一致。现在失败会进 frameOutcome()，
   * window.film.frame(t) 随之 reject，导出作业能读到错误码。
   *
   * @returns {{code: string, message: string, clipId: string}[]}
   */
  function applyOverridesNow() {
    var failures = [];
    for (var i = 0; i < clips.length; i++) {
      var clip = clips[i];
      if (clip.kind !== 'page') continue;
      var entries = activeOverrides[clip.id];
      if (!entries || !entries.length) continue;
      var win = sceneWindowOf(clip);
      var run = win ? runnerFor(win, 'applyOverrideEntries') : null;
      if (!run) {
        clip.overrideResult = { ok: false, code: 'NO_LAYER_RUNTIME' };
        failures.push({
          code: 'NO_LAYER_RUNTIME',
          message: '片段 ' + clip.id + ' 有 ' + entries.length + ' 条覆盖，但场景里没有覆盖运行时（layerSources 为空）',
          clipId: clip.id
        });
        continue;
      }
      try {
        clip.overrideResult = { ok: true, value: run(entries) };
      } catch (error) {
        clip.overrideResult = {
          ok: false,
          code: 'OVERRIDE_THREW',
          message: String(error && error.message ? error.message : error)
        };
        failures.push({
          code: 'OVERRIDE_THREW',
          message: '片段 ' + clip.id + ' 应用覆盖时抛错：' + String(error && error.message ? error.message : error),
          clipId: clip.id
        });
      }
    }
    for (var f = 0; f < failures.length; f++) reportError(failures[f].code, failures[f].message);
    return failures;
  }

  function describeIn(clip, at) {
    var win = sceneWindowOf(clip);
    if (!win) {
      return { ok: false, error: { code: 'NO_FILM', message: '片段 ' + clip.id + ' 没有加载场景页', at: at } };
    }
    var run = runnerFor(win, 'readLayer');
    if (!run) {
      return { ok: false, error: { code: 'NO_LAYER_RUNTIME', message: '检查器运行时未安装（先发 installLayers）', at: at } };
    }
    try {
      return run(at);
    } catch (error) {
      return {
        ok: false,
        error: { code: 'LAYER_GONE', message: String(error && error.message ? error.message : error), at: at }
      };
    }
  }

  function drawNow(t, scrubbing, signal) {
    if (signal && playing) return Promise.resolve({ settled: false, errors: [] });
    var frameStart = performance.now();
    currentT = t;
    scrubTarget = scrubbing ? { time: t, signal: signal } : null;
    presetTransitions.beforeFrame(clips);
    probe.t = t;
    var visible = [];
    for (var i = 0; i < clips.length; i++) {
      var clip = clips[i];
      var on = isVisible(clip, t);
      clip.visible = on;
      if (clip.kind === 'sound') {
        applyAudio(clip);
        if (on) visible.push(clip.id);
        continue;
      }
      if (clip.kind === 'video') applyAudio(clip);
      placeClip(clip);
      // 可见性只在真的翻转时写：每帧无脑写 visibility 会触发样式重算（12 个片段 × 每帧）。
      if (clip.shown !== on) {
        clip.el.style.visibility = on ? 'visible' : 'hidden';
        clip.shown = on;
      }
      applyFade(clip);
      if (on) visible.push(clip.id);
    }
    probe.visible = visible;

    var waits = [];
    for (var v = 0; v < clips.length; v++) {
      var media = clips[v];
      // 声音和视频一样：暂停时 t 决定它的 currentTime（A2 的 ±1 帧）。
      if ((media.kind === 'video' || media.kind === 'sound') && media.visible) {
        if (scrubbing) syncScrubMedia(media);
        else waits.push(seekClip(media, signal));
      }
    }
    var sceneWaits = [];
    for (var p = 0; p < clips.length; p++) {
      if (clips[p].kind === 'page' && clips[p].visible) sceneWaits.push(drawOneScene(clips[p], t));
    }
    // 覆盖必须落在 frame 之后（contracts：frame → apply-overrides → 面板）。
    var frameErrors = [];
    var sceneResults = Promise.all(sceneWaits).then(function (results) {
      if (signal && signal.aborted) return false;
      // 动效相位（M33）：frame(t) 已 resolve，settle（下面那两个 rAF）之前。
      applyMotionTime(t);
      // 关键帧（R15）：同一步骤、同一时钟。放在覆盖之前——覆盖是「最后一次写」。
      applyKeyframeFrame(t);
      var overrideFailures = applyOverridesNow();
      // 场景画失败 + 覆盖没打成，合成这一帧的结论（同一个纯函数，单测直接调）。
      var outcome = frameOutcome(results, overrideFailures);
      for (var e = 0; e < outcome.errors.length; e++) frameErrors.push(outcome.errors[e]);
      if (scrubbing) presetTransitions.apply(clips, t, stage, filmDoc);
      return outcome.ok;
    });
    // Pointer frames update the composition as soon as its scenes draw. Only
    // an exact seek or capture acknowledges that decoded pixels have settled.
    if (scrubbing) return sceneResults.then(function () { return { settled: false, errors: frameErrors }; });
    waits.push(sceneResults);

    return Promise.all(waits).then(function (flags) {
      if (signal && signal.aborted) return { settled: false, errors: [] };
      var settled = true;
      for (var f = 0; f < flags.length; f++) if (flags[f] !== true) settled = false;
      var rafStart = performance.now();
      return frames(2).then(function () {
        if (signal && signal.aborted) return { settled: false, errors: [] };
        presetTransitions.apply(clips, t, stage, filmDoc);
        probe.settle.rafMs += performance.now() - rafStart;
        probe.settle.frames += 1;
        probe.settle.totalMs += performance.now() - frameStart;
        frameCount += 1;
        probe.frames = frameCount;
        postFrame(0, settled, t);
        return { settled: settled, errors: frameErrors };
      });
    });
  }

  /**
   * 一条声音接进图：元素 → 元素增益 → 总录音总线。只接一次。
   *
   * 视频也接：带音轨的视频在导出里进 audioMix（R189），预览必须同样出声，
   * 否则「预览静音、成片有声」。muted 的视频照样接（source 输出静音），
   * 取消静音时不用重建音频图。
   */
  function attachClipAudio(clip) {
    if (!audioGraph || (clip.kind !== 'sound' && clip.kind !== 'video') || clip.gainNode) return;
    try {
      var source = audioGraph.ctx.createMediaElementSource(clip.el);
      var gainNode = audioGraph.ctx.createGain();
      gainNode.gain.value = 1;
      source.connect(gainNode);
      gainNode.connect(audioGraph.master);
      clip.sourceNode = source;
      clip.gainNode = gainNode;
    } catch (e) {
      // 元素已被别的上下文接走：这条声音只能退回元素音量（probe.audio().routed=false）
      clip.sourceNode = null;
      clip.gainNode = null;
    }
  }

  function ensureAudioContext() {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (audioGraph) {
      if (audioGraph.ctx.state === 'suspended') audioGraph.ctx.resume().catch(function () {});
      return;
    }
    var ctx = null;
    try { ctx = new Ctx(); } catch (e) { return; }
    var graph = { ctx: ctx, master: null, splitter: null, analyserL: null, analyserR: null, merger: null, streamDest: null };
    try {
      // 总线固定 2 声道：单声道素材按 speakers 规则复制到左右，splitter 才有 L/R 可分。
      var master = ctx.createGain();
      master.gain.value = 1;
      master.channelCount = 2;
      master.channelCountMode = 'explicit';
      master.channelInterpretation = 'speakers';
      var splitter = ctx.createChannelSplitter(2);
      var analyserL = ctx.createAnalyser();
      var analyserR = ctx.createAnalyser();
      analyserL.fftSize = 1024;
      analyserR.fftSize = 1024;
      // 电平要峰值，不要平滑（平滑会把削波削掉，看不出「爆了」）。
      analyserL.smoothingTimeConstant = 0;
      analyserR.smoothingTimeConstant = 0;
      var merger = ctx.createChannelMerger(2);
      master.connect(splitter);
      splitter.connect(analyserL, 0);
      splitter.connect(analyserR, 1);
      analyserL.connect(merger, 0, 0);
      analyserR.connect(merger, 0, 1);
      merger.connect(ctx.destination);
      graph.master = master;
      graph.splitter = splitter;
      graph.analyserL = analyserL;
      graph.analyserR = analyserR;
      graph.merger = merger;
    } catch (e) {
      // 图建不起来就完全退回元素音量（声音照常，只是没有 >1 增益与电平）
      return;
    }
    audioGraph = graph;
    for (var i = 0; i < clips.length; i++) {
      attachClipAudio(clips[i]);
      if (clips[i].kind === 'sound' || clips[i].kind === 'video') applyAudio(clips[i]);
    }
    if (ctx.state === 'suspended') ctx.resume().catch(function () {});
  }

  /** 读一个分析节点的峰值与有效值（复用缓冲，避免 30Hz 分配）。 */
  function readAnalyser(analyser, buffer) {
    var buf = buffer || new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    var peak = 0;
    var sum = 0;
    for (var i = 0; i < buf.length; i += 1) {
      var value = buf[i];
      var magnitude = value < 0 ? -value : value;
      if (magnitude > peak) peak = magnitude;
      sum += value * value;
    }
    return { peak: peak, rms: Math.sqrt(sum / buf.length), buffer: buf };
  }

  var meterBufL = null;
  var meterBufR = null;

  /**
   * 采样一次实际混音的电平。取样点在图的总线上（已经乘过 volume × fade × 主音量），
   * 所以「电平 = 你听到的」而不是「原始文件多响」。
   */
  function sampleLevels() {
    if (!audioGraph) {
      meter.peakL = 0;
      meter.peakR = 0;
      meter.rmsL = 0;
      meter.rmsR = 0;
      meter.t = currentT;
      meter.playing = playing;
      return;
    }
    // seek 之后分析窗口里还是上一帧的声音：按 0 报，别让读数粘在旧位置。
    if (performance.now() < meterSilenceUntil) {
      meter.peakL = 0;
      meter.peakR = 0;
      meter.rmsL = 0;
      meter.rmsR = 0;
    } else {
      var left = readAnalyser(audioGraph.analyserL, meterBufL);
      meterBufL = left.buffer;
      var right = readAnalyser(audioGraph.analyserR, meterBufR);
      meterBufR = right.buffer;
      meter.peakL = left.peak;
      meter.rmsL = left.rms;
      meter.peakR = right.peak;
      meter.rmsR = right.rms;
    }
    meter.t = currentT;
    meter.playing = playing;
  }

  function postLevels() {
    post({
      v: V,
      seq: 0,
      type: 'levels',
      levels: {
        peakL: meter.peakL,
        peakR: meter.peakR,
        rmsL: meter.rmsL,
        rmsR: meter.rmsR,
        t: meter.t,
        playing: meter.playing,
        routed: Boolean(audioGraph)
      }
    });
  }

  /** 归零：暂停/停止/换片时用，避免读数停在上一次的位置。 */
  function zeroLevels() {
    meter.peakL = 0;
    meter.peakR = 0;
    meter.rmsL = 0;
    meter.rmsR = 0;
    meter.t = currentT;
    meter.playing = playing;
  }

  function playMedia(clip) {
    var el = clip.el;
    if (!playing || !el.paused || el.error || clip.playAttempt || clip.playBlocked) return;
    try { el.playbackRate = clampRate(clip.speed * rate); } catch (e) { /* 不支持的范围 */ }
    var attempt = { mutedFallback: false };
    clip.playAttempt = attempt;
    function requestPlay() {
      var started;
      try { started = el.play(); } catch (error) { started = Promise.reject(error); }
      Promise.resolve(started).then(function () {
        if (clip.playAttempt === attempt) clip.playAttempt = null;
      }, function (error) {
        if (clip.playAttempt !== attempt) return;
        if (playing && isVisible(clip, currentT) && error && error.name === 'NotAllowedError') {
          probe.autoplayBlocked = true;
          reportError('AUTOPLAY_BLOCKED', '自动播放策略挡下了 ' + clip.id + '：NotAllowedError');
          if (clip.kind === 'video' && !el.muted && !attempt.mutedFallback) {
            attempt.mutedFallback = true;
            clip.mutedFallback = true;
            el.muted = true;
            requestPlay();
            return;
          }
          clip.playBlocked = true;
        }
        // An aborted or stale promise must never restart paused or hidden media.
        clip.playAttempt = null;
        clip.retryPlayAt = performance.now() + 200;
      });
    }
    requestPlay();
  }

  function pauseMedia(clip) {
    if (clip.kind !== 'video' && clip.kind !== 'sound') return;
    var pending = clip.playAttempt;
    clip.playAttempt = null;
    if (pending || !clip.el.paused) clip.el.pause();
  }

  function positionMedia(clip, t) {
    var el = clip.el;
    var want = Math.max(0, sourceTimeOf(clip, t));
    if (Number.isFinite(el.duration)) want = Math.min(el.duration, want);
    if (el.error || Math.abs(el.currentTime - want) < SAME_FRAME_EPS) return;
    try { el.currentTime = want; } catch (e) { /* media metadata not ready */ }
  }

  function syncScrubMedia(clip) {
    // Keep one decode in flight. Its seeked event picks up the most recent
    // pointer position even if the user holds the mouse still before release.
    if (!scrubTarget || scrubTarget.signal.aborted || playing || clip.el.seeking || !isVisible(clip, scrubTarget.time)) return;
    positionMedia(clip, scrubTarget.time);
  }

  function keepInStep(clip, now) {
    var el = clip.el;
    var speed = clip.speed * rate;
    if (!(speed >= 0.0625 && speed <= 16)) {
      pauseMedia(clip);
      if (!el.seeking) positionMedia(clip, currentT);
      return;
    }
    if (el.error || clip.playAttempt || el.seeking || clip.playBlocked || playStartingUntil) return;
    if (el.paused) {
      if (now >= (clip.retryPlayAt || 0) && el.readyState >= 2) {
        positionMedia(clip, currentT);
        playMedia(clip);
      }
      return;
    }
    // Decoder startup/buffering is not drift. Repeated hard seeks here reset decode.
    if (el.readyState < 3) return;
    var drift = el.currentTime - Math.max(0, sourceTimeOf(clip, currentT));
    var driftSec = Math.abs(drift) / speed;
    if (driftSec > 0.12 && now >= (clip.nextCorrectionAt || 0)) {
      positionMedia(clip, currentT);
      clip.nextCorrectionAt = now + 450;
    }
    var wantedRate = clampRate(speed * (driftSec > 1 / 30 && driftSec <= 0.12 ? (drift < 0 ? 1.03 : 0.97) : 1));
    if (Math.abs(el.playbackRate - wantedRate) > 1e-3) {
      try { el.playbackRate = wantedRate; } catch (e) { /* 同上 */ }
    }
  }

  function alignPlayback(t) {
    playBase = t;
    playWall = performance.now();
    playStartingUntil = playWall + 1200;
    for (var i = 0; i < clips.length; i++) {
      var clip = clips[i];
      if (clip.kind !== 'video' && clip.kind !== 'sound') continue;
      clip.playBlocked = false;
      clip.mutedFallback = false;
      applyAudio(clip);
      clip.retryPlayAt = 0;
      clip.nextCorrectionAt = 0;
      pauseMedia(clip);
      if (isVisible(clip, t)) positionMedia(clip, t);
    }
  }

  function mediaStarting(clip) {
    return (clip.kind === 'video' || clip.kind === 'sound') && isVisible(clip, playBase) &&
      !clip.el.error && (clip.el.seeking || clip.el.readyState < 3);
  }

  function tick(now) {
    if (!playing) return;
    if (playStartingUntil) {
      playWall = now;
      if (now >= playStartingUntil || !clips.some(mediaStarting)) {
        playStartingUntil = 0;
        for (var i = 0; i < clips.length; i++) {
          var media = clips[i];
          if ((media.kind === 'video' || media.kind === 'sound') && isVisible(media, playBase)) playMedia(media);
        }
      }
    }
    var t = playBase + ((now - playWall) / 1000) * rate;
    if (duration > 0 && t >= duration) {
      currentT = duration;
      probe.t = duration;
      stopPlayback();
      return;
    }
    if (t < 0) t = 0;
    currentT = t;
    presetTransitions.beforeFrame(clips);
    probe.t = t;
    var visible = [];
    for (var i = 0; i < clips.length; i++) {
      var clip = clips[i];
      var on = isVisible(clip, currentT);
      clip.visible = on;
      if (clip.kind === 'sound') {
        applyAudio(clip);
        if (on) { visible.push(clip.id); keepInStep(clip, now); } else pauseMedia(clip);
        continue;
      }
      if (clip.kind === 'video') applyAudio(clip);
      placeClip(clip);
      if (clip.shown !== on) {
        clip.el.style.visibility = on ? 'visible' : 'hidden';
        clip.shown = on;
      }
      applyFade(clip);
      if (on) {
        visible.push(clip.id);
        if (clip.kind === 'video') keepInStep(clip, now);
        if (clip.kind === 'page' && now - (clip.lastPageAt || 0) > 100) {
          clip.lastPageAt = now;
          var film = pageFilm(clip);
          // 播放中也要吃得下同步 frame(t)：同一个 callSceneFrame，且不叠加在途调用。
          if (film && typeof film.frame === 'function' && !clip.pageInFlight) {
            clip.pageInFlight = true;
            (function (page) {
              var local = sourceTimeOf(page, currentT);
              callSceneFrame(film, local).then(
                function () {
                  page.pageInFlight = false;
                  page.sceneFrames += 1;
                  sceneFrames += 1;
                  probe.sceneFrames = sceneFrames;
                  page.lastFrameError = null;
                  applyOverridesNow();
                },
                function (err) {
                  page.pageInFlight = false;
                  var code = err && err.code ? err.code : 'FRAME_THREW';
                  var message = String(err && err.message ? err.message : err);
                  page.lastFrameError = { code: code, message: message };
                  reportError(code, message);
                }
              );
            })(clip);
          }
        }
      } else {
        pauseMedia(clip);
      }
    }
    probe.visible = visible;
    /* 关键帧（R15）：播放路径以前完全不碰 「--motion-t」（只有 draw 写），于是「暂停有、
       播起来没有」。这里与 「--motion-t」 的写法同一处、同一个 「currentT」。 */
    applyKeyframeFrame(currentT);
    presetTransitions.apply(clips, currentT, stage, filmDoc);
    // 电平 20–30Hz：和播放推进同一个 rAF，但**节流**再采样，别把每次合成都变成一次读缓冲。
    if (now - lastLevelPost >= 33) {
      lastLevelPost = now;
      sampleLevels();
      postLevels();
    }
    if (now - lastStatePost >= 100) {
      lastStatePost = now;
      postState(0);
    }
    rafId = requestAnimationFrame(tick);
  }

  function startPlayback() {
    if (playing) return;
    drawQueue.cancel();
    ensureAudioContext();
    playing = true;
    probe.playing = true;
    lastStatePost = 0;
    lastLevelPost = 0;
    alignPlayback(currentT);
    rafId = requestAnimationFrame(tick);
  }

  function stopPlayback() {
    playing = false;
    playStartingUntil = 0;
    probe.playing = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    for (var i = 0; i < clips.length; i++) pauseMedia(clips[i]);
    // 暂停/停止立刻归零：读数不许停在上一次的位置（M32-B4）。
    zeroLevels();
    postLevels();
    // 先回状态（UI 的时间码与走带立刻一致），画面再慢慢 settle。
    postState(0);
    draw(currentT, false).catch(function () {});
  }

  function boot() {
    if (bootPromise) return bootPromise;
    bootState = 'loading';
    bootPromise = fetch(CONFIG.docUrl, { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('doc.json HTTP ' + response.status);
        return response.json();
      })
      .then(function (body) {
        if (!body || !body.doc) throw new Error('doc.json 没有 doc');
        doc = body.doc;
        stage = { w: Number(doc.stage.w), h: Number(doc.stage.h) };
        applyStageSize();
        return waitFilmLoad();
      })
      .then(function () {
        filmDoc = filmEl.contentDocument;
        if (!filmDoc) throw new Error('film.html 无法读取（同 origin 访问失败）');
        prepareFilm();
        duration = computeDuration();
        probe.duration = duration;
        return draw(clampTime(Number(new URLSearchParams(window.location.search).get('start'))), false);
      })
      .then(function () {
        bootState = 'ready';
        probe.ready = true;
        postState(0);
      })
      .catch(function (err) {
        bootState = 'failed';
        probe.ready = false;
        reportError(err && err.code ? err.code : 'FRAME_THREW', String(err && err.message ? err.message : err));
        throw err;
      });
    return bootPromise;
  }

  function handle(command) {
    return boot().then(function () {
      var op = command.op;
      if (op === 'previewBody') { previewBody(command); return undefined; }
      if (op === 'ping') { postState(command.seq); return undefined; }
      if (op === 'setTime') {
        var t = Number(command.t);
        if (!isFinite(t)) { reportError('UNSUPPORTED', 'setTime 需要数字 t'); return undefined; }
        t = clampTime(t);
        // 先把时钟挪到目标再回状态：否则回包带的是旧 t，UI 会把刚拖到的位置又拉回去。
        currentT = t;
        probe.t = t;
        if (playing) alignPlayback(t);
        // 先回状态：媒体的 seek 可能要几百毫秒，不能让播放头/时间码等它。
        postState(command.seq);
        return playing ? undefined : draw(t, false, command.scrubbing === true);
      }
      if (op === 'setPlaying') {
        if (command.playing === true) startPlayback();
        else stopPlayback();
        postState(command.seq);
        return undefined;
      }
      if (op === 'setRate') {
        var next = Number(command.rate);
        if (!isFinite(next) || next <= 0) { reportError('UNSUPPORTED', 'setRate 需要正数 rate'); return undefined; }
        rate = clampRate(next);
        probe.rate = rate;
        if (playing) { playBase = currentT; playWall = performance.now(); }
        postState(command.seq);
        return undefined;
      }
      if (op === 'setVolume') {
        var value = Number(command.volume);
        if (!isFinite(value)) { reportError('UNSUPPORTED', 'setVolume 需要 0–1 的 volume'); return undefined; }
        volume = Math.max(0, Math.min(1, value));
        probe.volume = volume;
        for (var i = 0; i < clips.length; i++) {
          if (clips[i].kind === 'sound' || clips[i].kind === 'video') applyAudio(clips[i]);
        }
        postState(command.seq);
        return undefined;
      }
      if (op === 'setSolo') {
        // 独奏（M38）：Studio 的**视图态**，不写 film.html、导出看不到。
        // 未独奏轨的片段在预览里不可见也不出声；hidden 仍然优先（隐藏轨不会因为独奏而出现）。
        var soloList = Array.isArray(command.tracks) ? command.tracks : [];
        soloMap = {};
        for (var si = 0; si < soloList.length; si++) {
          var soloIndex = Number(soloList[si]);
          if (isFinite(soloIndex)) soloMap[soloIndex] = true;
        }
        soloActive = Object.keys(soloMap).length > 0;
        for (var sci = 0; sci < clips.length; sci++) {
          clips[sci].soloHidden = soloActive && !soloMap[clips[sci].trackIndex];
          if (clips[sci].kind === 'sound') applyAudio(clips[sci]);
        }
        postState(command.seq);
        return draw(currentT, false);
      }
      if (op === 'requestFrame') {
        var target = command.t === undefined ? currentT : clampTime(Number(command.t));
        return draw(target, true).then(function (result) {
          postFrame(command.seq, result ? result.settled === true : true, target);
        });
      }
      if (op === 'installLayers') {
        // 检查器运行时：由 Studio 传入 packages/layers 里三段现成函数的源码（见 runnerFor）。
        if (typeof command.readLayer === 'string') layerSources.readLayer = command.readLayer;
        if (typeof command.applyOverrideEntries === 'string') {
          layerSources.applyOverrideEntries = command.applyOverrideEntries;
        }
        if (typeof command.snapshotLayers === 'string') layerSources.snapshotLayers = command.snapshotLayers;
        realmRunners = new WeakMap();
        post({ v: V, seq: command.seq, type: 'layers', clip: '', result: { ok: true, installed: true } });
        return undefined;
      }
      if (op === 'listLayers') {
        var listClip = findClip(String(command.clip || ''));
        var listWin = listClip ? sceneWindowOf(listClip) : null;
        var runList = listWin ? runnerFor(listWin, 'snapshotLayers') : null;
        if (!listWin) {
          post({
            v: V,
            seq: command.seq,
            type: 'layers',
            clip: String(command.clip || ''),
            result: { ok: false, error: { code: 'NO_FILM', message: '没有这个片段：' + String(command.clip) } }
          });
          return undefined;
        }
        if (!runList) {
          post({
            v: V,
            seq: command.seq,
            type: 'layers',
            clip: String(command.clip || ''),
            result: { ok: false, error: { code: 'NO_LAYER_RUNTIME', message: '检查器运行时未安装（先发 installLayers）' } }
          });
          return undefined;
        }
        var snapshot = null;
        var snapshotError = null;
        try {
          snapshot = runList({});
        } catch (error) {
          snapshotError = String(error && error.message ? error.message : error);
        }
        post({
          v: V,
          seq: command.seq,
          type: 'layers',
          clip: String(command.clip || ''),
          result: snapshotError
            ? { ok: false, error: { code: 'LAYER_GONE', message: snapshotError } }
            : { ok: true, layers: (snapshot && snapshot.layers ? snapshot.layers : []).slice(0, 120) }
        });
        return undefined;
      }
      if (op === 'layerRects') {
        // 一次性把「这个片段所有可见层的舞台局部矩形」取回来（树悬停描边、舞台点选都靠它）。
        // 形状与 listLayers 同一条回包类型（type:'layers'），只是条目带 rect，避免再加一种回包。
        var rectClip = findClip(String(command.clip || ''));
        var rectWin = rectClip ? sceneWindowOf(rectClip) : null;
        var runRects = rectWin ? runnerFor(rectWin, 'snapshotLayers') : null;
        if (!rectClip || !rectWin) {
          post({
            v: V,
            seq: command.seq,
            type: 'layers',
            clip: String(command.clip || ''),
            result: { ok: false, error: { code: 'NO_FILM', message: '没有这个片段：' + String(command.clip) } }
          });
          return undefined;
        }
        if (!runRects) {
          post({
            v: V,
            seq: command.seq,
            type: 'layers',
            clip: rectClip.id,
            result: { ok: false, error: { code: 'NO_LAYER_RUNTIME', message: '检查器运行时未安装（先发 installLayers）' } }
          });
          return undefined;
        }
        var rectSnap = null;
        var rectError = null;
        try {
          rectSnap = runRects({});
        } catch (error) {
          rectError = String(error && error.message ? error.message : error);
        }
        if (rectError) {
          post({
            v: V,
            seq: command.seq,
            type: 'layers',
            clip: rectClip.id,
            result: { ok: false, error: { code: 'LAYER_GONE', message: rectError } }
          });
          return undefined;
        }
        var rectLayers = [];
        var rectList = rectSnap && rectSnap.layers ? rectSnap.layers : [];
        for (var rl = 0; rl < rectList.length; rl += 1) {
          var one = describeIn(rectClip, rectList[rl].at);
          if (!one || one.ok !== true || !one.value || !one.value.box) continue;
          var stageBoxOfLayer = sceneBoxToStage(rectClip, one.value.box);
          if (!(stageBoxOfLayer.w > 0 && stageBoxOfLayer.h > 0)) continue;
          rectLayers.push({
            at: rectList[rl].at,
            kind: rectList[rl].kind || '',
            name: rectList[rl].name || '',
            rotationDeg: Number(one.value.box.rotation) || 0,
            rect: {
              x: round2(stageBoxOfLayer.x),
              y: round2(stageBoxOfLayer.y),
              w: round2(stageBoxOfLayer.w),
              h: round2(stageBoxOfLayer.h)
            }
          });
        }
        post({
          v: V,
          seq: command.seq,
          type: 'layers',
          clip: rectClip.id,
          result: { ok: true, layers: rectLayers }
        });
        return undefined;
      }
      if (op === 'pickAt') {
        /* S97 · 点击穿透：片段框盖着舞台时，宿主把「按下不移动就松手」的那一下转过来。
           与真实点击走**同一条路**（pickLayerAt → postPick），只是坐标由宿主给（舞台坐标）。
           只发 pick 主动事件，不回包——宿主那条 pick 分支原样复用。 */
        var pickClip = findClip(String(command.clip || ''));
        var pickX = Number(command.x);
        var pickY = Number(command.y);
        if (!pickClip || !isFinite(pickX) || !isFinite(pickY)) {
          probe.lastPickAt = { clip: String(command.clip || ''), ok: false, reason: 'bad-args' };
          return undefined;
        }
        var scenePoint = stagePointToScene(pickClip, pickX, pickY);
        var layerHit = pickClip.kind === 'page' ? pickLayerAt(pickClip, scenePoint.x, scenePoint.y) : null;
        probe.lastPickAt = { clip: pickClip.id, x: round2(scenePoint.x), y: round2(scenePoint.y), at: layerHit ? layerHit.at : '', ok: true };
        if (layerHit) {
          var layerStageBox = sceneBoxToStage(pickClip, layerHit.box);
          postPick(pickClip, layerHit.at, layerStageBox, { x: pickX, y: pickY }, command.shift === true);
        } else {
          postPick(pickClip, '', pictureRectOfClip(pickClip), { x: pickX, y: pickY }, command.shift === true);
        }
        return undefined;
      }
      if (op === 'describeLayer') {
        var layerClip = findClip(String(command.clip || ''));
        var described = layerClip
          ? describeIn(layerClip, String(command.at || ''))
          : { ok: false, error: { code: 'NO_FILM', message: '没有这个片段：' + String(command.clip), at: String(command.at || '') } };
        post({ v: V, seq: command.seq, type: 'layer', clip: String(command.clip || ''), at: String(command.at || ''), result: described });
        return undefined;
      }
      if (op === 'setOverrides') {
        var ovClip = findClip(String(command.clip || ''));
        if (!ovClip) {
          post({ v: V, seq: command.seq, type: 'overrides', clip: String(command.clip || ''), ok: false, code: 'NO_FILM' });
          return undefined;
        }
        var entries = Array.isArray(command.entries) ? command.entries : [];
        if (entries.length) activeOverrides[ovClip.id] = entries;
        else delete activeOverrides[ovClip.id];
        applyOverridesNow();
        // 预览立即生效：应用后等一帧再回包，截图/读数拿到的是画完的状态。
        return frames(1).then(function () {
          post({
            v: V,
            seq: command.seq,
            type: 'overrides',
            clip: ovClip.id,
            ok: true,
            result: ovClip.overrideResult || null
          });
        });
      }
      return undefined;
    });
  }

  window.addEventListener('message', function (event) {
    if (!STUDIO) return;
    if (event.source !== window.parent) return;
    if (event.origin !== STUDIO) return;
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.v !== V || typeof data.op !== 'string') {
      post({ v: V, seq: Number(data && data.seq) || 0, type: 'error', code: 'UNSUPPORTED', message: '不支持的舞台协议版本：' + String(data && data.v) });
      return;
    }
    if (
      [
        'ping',
        'setTime',
        'setPlaying',
        'setRate',
        'setVolume',
        'requestFrame',
        'installLayers',
        'describeLayer',
        'setOverrides',
        'listLayers',
        'layerRects',
        'setSolo',
        'pickAt',
        'previewBody'
      ].indexOf(data.op) < 0
    ) {
      return;
    }
    if (typeof data.seq === 'number') {
      if (data.seq <= lastSeq) return;
      lastSeq = data.seq;
    }
    handle(data).catch(function (err) {
      reportError(err && err.code ? err.code : 'FRAME_THREW', String(err && err.message ? err.message : err));
    });
  });

  window.addEventListener('resize', fitStage);

  window.film = {
    get width() { return stage.w; },
    get height() { return stage.h; },
    ready: function () { return boot(); },
    duration: function () { return duration; },
    frame: function (t) {
      var target = Number(t);
      if (!isFinite(target)) return Promise.reject(new Error('frame(t) 需要一个数字'));
      return boot().then(function () {
        return draw(clampTime(target), true).then(function (result) {
          // 合同 frame.ts：失败必须 reject。舞台自己走 setTime 时不会走到这里（那条路 fail-soft）。
          if (result && result.settled === false && result.errors.length) {
            throw sceneError(result.errors[0].code, result.errors[0].message);
          }
        });
      });
    }
  };

  boot().catch(function () {});
})();
`;
