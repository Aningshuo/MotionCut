/**
 * Studio 本地服务。
 *
 * 硬约束：
 * - 只监听 127.0.0.1；端口由 env.json 决定，占用就报错退出，不静默漂移。
 * - 带 Origin 的请求只接受「自身两个 origin」：Studio 自己的端口 + 本线 vite 端口。
 * - **UI 事件通道是 WebSocket**（`ws://127.0.0.1:<port>/events`，contracts/events.ts v1.1.0），
 *   不是 SSE。旧的 `/api/events` 作为 UI 总线已移除，返回 410 并指向新地址。
 * - 对外 HTTP API 的 SSE（IF-HTTP-05）是另一个面，本文件不实现、也不与事件总线混用。
 */

import { createServer } from 'node:http';
import os from 'node:os';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';

import { createEventHub, publishRestart } from './events.mjs';
import { EXPORT_QUALITIES, EXPORT_REQUEST_FIELDS, createExportJobs } from './export-job.mjs';
import { prepareClipExport } from './clip-export-input.mjs';
import { planClipLoudness } from './clip-loudness.mjs';
import { planRangeInputs } from '../../film-core/export-range.mjs';
import { filmDuration } from '../../render/film-plan.mjs';
import { buildTimeline, normalizeRanges } from '../../render/timeline-range.mjs';
import {
  MAX_UPLOAD_BYTES,
  MEDIA_REQUEST_FIELDS,
  REIMPORT_REQUEST_FIELDS,
  fileExistsSync,
  importMedia,
  reimportSourceAsset,
} from './media-import.mjs';
import { insertExistingAsset, listAssets, thumbOf } from './assets-library.mjs';
import { frameOf } from './derived.mjs';
import { mediaStatusOf, planRelink, scanRelinkDir } from './media-relink.mjs';
import { checkRelPath, contentTypeOf, isInside } from './project-file.mjs';
import { clipPropsOf, libraryView, planMotionApply, planMotionArchive, planMotionRollback, planMotionSave, planMotionUpgrade } from './motion-wire.mjs';
import { readSubtitles, saveSubtitles } from './subtitle-store.mjs';
import { withProjectCaptionLock } from './creation-captions.mjs';
import { MAX_SUBTITLE_BYTES, exportSubtitleBytes, importSubtitleBytes } from './subtitle-import.mjs';
import { SESSION_ID_RE, createSessionsStore } from './agent-sessions.mjs';
import { planTimelineSnap, SnapError } from '../../film-core/snap-magnet.mjs';
import { applyCanvasGesture, boxToOps, readbackBox } from '../../film-core/canvas-persist.mjs';
import { createVersion, diffVersion, listVersions, restoreFilm, restoreVersion, VersionsError } from './versions.mjs';
import { readSubtitleStyle, saveSubtitleStyle } from './subtitle-style-store.mjs';
import {
  aiCards,
  applySettingsPatch,
  cleanCache,
  diagnostics as settingsDiagnostics,
  hiddenUsage,
  legacyMcpExists,
  projectStorage,
  readSettings,
  writeSettings,
} from './settings-store.mjs';
import { checkBurnFeasible, preflightBurn } from './export-burn.mjs';
import { createProjectRegistry } from './projects.mjs';
import { createGrantStore } from './grants.mjs';
import { createStudioAcpClients } from './agent-acp.mjs';
import {
  SEQUENCE_REQUEST_FIELDS,
  SequenceError,
  createSequence,
  createSequenceRegistry,
  listSequences,
  removeSequence,
  setCurrentSequence,
} from './sequences.mjs';
import { CREATE_REQUEST_FIELDS, ProjectCreateError, createProject, projectIdFor } from './project-create.mjs';
import { canonicalOutputPath, canonicalProjectDirectory } from './project-identity.mjs';
import { SCENE_REQUEST_FIELDS, SceneError, createAgentScene } from './agent-scene.mjs';
import { MoveError, createProjectMover, readStalePaths } from './project-move.mjs';
import { readProjectIndex, recordProjectOpen, removeProjectEntry, setProjectCover } from './project-index.mjs';
import { createRenderQueue } from './render-queue.mjs';
import { PageUnreachable, ReadApiError, createLayerReader } from './layers-read.mjs';
import { coverPath, ensureProjectCover, isCoverName } from './project-covers.mjs';
import { extractProjectArchive, readProjectArchive, writeProjectArchive } from './project-archive.mjs';
import { startContentOrigin } from './content-origin.mjs';
import { observePageFrom } from './element-world.mjs';
import { attachWebSocketServer } from './ws.mjs';
import { MODEL_KEY_ERRORS, ModelKeyError, modelEndpoint, modelKeyDir, modelKeyStore } from './model-key.mjs';
import { probeAgents } from '../../agents/probe.mjs';
import { createProvider } from '../../providers/client.mjs';
import { redactText } from '../../providers/redact.mjs';
import { createMediaServices } from './media-services.mjs';
import { createCreationLibraryHttp } from './creation-library-http.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PAGE_PATH = join(here, 'public', 'index.html');
/** 渲染层构建产物（`pnpm build:ui`）。不存在时回退到 public/index.html 的状态页。 */
const UI_DIST = join(here, '..', 'ui', 'dist');
const UI_ASSETS = join(UI_DIST, 'assets');
const UI_INDEX = join(UI_DIST, 'index.html');

/** 静态资源的 content-type：只列构建产物里会出现的类型。 */
const MIME_BY_EXT = new Map([
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2'],
  ['.html', 'text/html; charset=utf-8'],
]);

export const STUDIO_VERSION = '0.2.0';
export const LOOPBACK = '127.0.0.1';
export const EVENTS_PATH = '/events';
export const EVENTS_CONTRACT_VERSION = '1.1.0';
const MAX_BODY = 4 * 1024 * 1024;
/** 素材上传（浏览器兜底）的请求体上限：base64 会膨胀约 4/3。 */
const MEDIA_BODY_LIMIT = Math.ceil(MAX_UPLOAD_BYTES * 1.4) + 64 * 1024;

/**
 * @typedef {{
 *   port: number,
 *   vitePort: number,
 *   contentPort?: number,
 *   host?: string,
 *   version?: string,
 *   projectsRoot?: string,
 *   debugEvents?: boolean,
 *   thumbnailTimeoutMs?: number,
 *   history?: boolean,
 *   io?: any,
 *   ioFactory?: (context: any) => any,
 *   queueHooks?: any,
 *   watchImpl?: any,
 *   eventHistoryLimit?: number,
 *   logger?: (line: string) => void,
 *   home?: string,
 *   readApiPage?: (projectId: string, target: {kind: 'film'|'page', key: string, url: string}) => any,
 *   exportRunner?: Function,
 *   agentProvider?: { id: string, mock?: boolean, generate: (input: any) => Promise<any> },
 *   acpAdapterPath?: string,
 *   permissionTimeoutMs?: number,
 *   grantTtlMs?: number,
 *   applyApprovalTtlMs?: number,
 *   moveVerify?: (input: any) => Promise<{ ok: boolean, reason?: string }>,
 *   forceCopyMove?: boolean,
 * }} StudioOptions
 */

/**
 * @param {StudioOptions} options
 */
export function createStudio(options) {
  const host = options.host ?? LOOPBACK;
  const vitePort = options.vitePort;
  const version = options.version ?? STUDIO_VERSION;
  const log = options.logger ?? ((line) => process.stdout.write(`${line}\n`));
  const debugEvents = options.debugEvents ?? process.env.OPENCUT_DEBUG_EVENTS === '1';
  const state = { port: options.port, boundPort: options.port };
  /**
   * 内容 origin 的现状（启动后由 startStudio 填）。UI 从 `/healthz` 读它，端口不在页面里写死。
   * @type {{ origin: string|null, port: number, error: string|null }}
   */
  const contentState = { origin: null, port: 0, error: null };
  /** 自身两个 origin：Studio 端口（窗口加载的页面）+ 本线 vite 端口（开发态 UI）。 */
  const allowedOrigins = new Set([`http://127.0.0.1:${options.port}`, `http://127.0.0.1:${vitePort}`]);
  /** @param {string} origin */
  const isOriginAllowed = (origin) => allowedOrigins.has(origin);

  const hub = createEventHub({ historyLimit: options.eventHistoryLimit });
  publishRestart(hub);

  const rawRegistry = createProjectRegistry({
    hub,
    io: options.io,
    ioFactory: options.ioFactory,
    queueHooks: options.queueHooks,
    watchImpl: options.watchImpl,
    thumbnailTimeoutMs: options.thumbnailTimeoutMs,
    history: options.history,
  });
  /* M78：对外仍是「一个工程一个 id」，内部按序列分条目（`P` = 当前序列，`P::<seq>` = 指定序列）。
     所有既有路由都通过这一层拿条目，因此导入/导出/图层/历史不需要各自认识「序列」。 */
  const registry = createSequenceRegistry({ registry: rawRegistry, home: options.home });
  const loudnessActive = new Set();

  /* CS2（R30-125）：受控写授权台账。ACP 会话签发，`/ops` 核票 —— 只有凭票的写入
     才标成 `by: 'agent'` 并进撤销栈。票不在这张表里就不认，agent 改自己进程参数也没用。 */
  const grants = createGrantStore();

  /* CS2：真实 Codex（ACP）场景 provider。**惰性**启动：没人选它就不起 codex 进程。
     它自己管每会话的票，签发/收回都在 `agent-acp.mjs` 里。 */
  const acpAgent = createStudioAcpClients({
    registry,
    grants,
    baseUrl: () => `http://${host}:${state.boundPort}`,
    stateDir: join(options.home ?? os.tmpdir(), '.opencut', 'agent-state'),
    log: (line) => log(line),
    /* 验收接缝：探针可指向 mock ACP 对端；产品不传 = 真实 codex-acp。 */
    ...(typeof options.acpAdapterPath === 'string' && options.acpAdapterPath !== ''
      ? { adapterPath: options.acpAdapterPath }
      : {}),
    /* 验收接缝：只给探针缩短票/权限卡寿命，**不改产品默认**（45min / 30s）。 */
    ...(Number.isFinite(options.permissionTimeoutMs) ? { permissionTimeoutMs: Number(options.permissionTimeoutMs) } : {}),
    ...(Number.isFinite(options.grantTtlMs) ? { grantTtlMs: Number(options.grantTtlMs) } : {}),
  });

  // 渲染调度（M67）：多工程排队/并发/取消/恢复；状态落 `<home>/.opencut/render-queue/`。
  // env 非法不拖垮 Studio：错误留在队列对象上，`GET /api/render/queue` 回 400。
  const renderQueue = createRenderQueue({ home: options.home, env: process.env, logger: (line) => log(line) });

  // 导出作业（M17）：状态机与真实渲染链。M70 起**开工时机由渲染队列决定**：
  // `start()` 只入队，队列按并发上限派发，`runScheduled` 才真正跑 ffmpeg。
  // 中间文件落在队列的 `partial/` 下，进程被 kill 时重启可统一清理并记账。
  const exportJobs = createExportJobs({
    logger: (line) => log(line),
    partialDir: renderQueue.partialDir,
    // 测试/宿主注入点：给了就用它跑导出（不跑 ffmpeg），状态机与队列接线仍然是真的。
    ...(typeof options.exportRunner === 'function' ? { runner: options.exportRunner } : {}),
  });
  exportJobs.attachScheduler(renderQueue);
  renderQueue.setRunner((/** @type {any} */ job, /** @type {any} */ ctx) => exportJobs.runScheduled(job, ctx));

  /**
   * 只读图层/检查器 API 的元素域（M66 v1 → M69 v2）。
   *
   * 页面宿主（默认 headless Chromium + 内容 origin）与「用哪个文档、id 怎么解析」
   * 都收在 `layers-read.mjs`：`clip` 缺省读 film.html，`clip=<page 片段>` 进页面文档；
   * `inspect` 接受 `<clipId>::<elementId>`。测试/宿主可用 `options.readApiPage` 注入 page。
   */
  const layerReader = createLayerReader({
    registry,
    pageProvider: typeof options.readApiPage === 'function' ? options.readApiPage : null,
    contentOrigin: () => contentState.origin,
    logger: (line) => log(line),
  });


  /**
   * R143：page 片段的元素观察标（实例 id + 每层签名）。
   *
   * 只读源码，不开浏览器：`/api/layers` 已经用宿主拿到了「有哪些层」，
   * 这里补的是「这些层在源码里长什么样」，供写请求回传 `envelope.target`。
   * 读不到就返回 null —— 宁可让 UI 只做片段级编辑，也不发一个假目标。
   * @param {string} projectId
   * @param {string} clipId
   * @param {any} body `/api/layers` 的响应
   * @returns {Promise<null | { instance: { id: string }, fingerprints: Record<string, string|null>, targets: Record<string, any> }>}
   */
  async function pageTargetMarks(projectId, clipId, body) {
    const project = registry.get(projectId);
    const doc = registry.docOf(projectId)?.doc ?? null;
    if (project === null || project === undefined || doc === null) return null;
    /** @type {any} */
    let clip = null;
    for (const track of Array.isArray(doc.tracks) ? doc.tracks : []) {
      for (const candidate of Array.isArray(track?.clips) ? track.clips : []) {
        if (candidate?.id === clipId) clip = candidate;
      }
    }
    if (clip === null || clip.kind !== 'page') return null;
    const layers = Array.isArray(body?.layers) ? body.layers : [];
    const keys = layers.map((/** @type {any} */ layer) => `${clipId}::${String(layer.id)}`);
    const observed = await observePageFrom({ projectId, projectDir: dirname(project.filmPath), src: clip.src, keys });
    if (observed.ok !== true) return null;
    /* 只**追加**两个新字段，不动既有 layer 条目的键（既有测试逐键比对响应形状）。 */
    /** @type {Record<string, string|null>} */
    const fingerprints = {};
    for (const layer of layers) {
      fingerprints[String(layer.id)] = observed.observation.elements[`${clipId}::${String(layer.id)}`]?.signature ?? null;
    }
    return {
      instance: { id: observed.observation.instanceId },
      fingerprints,
      targets: observed.observation.elements,
    };
  }

  /**
   * Agent 原创场景（M71）：草稿只放内存，写盘仍走 `registry.applyOps`。
   * provider 默认按 env 选（没配就是项目内 mock，响应里 `provider:"mock"`）。
   */
  /* R170（M21）：把**本机真实探测到的 CLI** 交给名册 —— 之前没传，名册永远只有内置一条，
     GUI 上就看不出「Codex 装了但没接」。只读展示：选中未接的 Agent 仍会被 AGENT_NOT_WIRED 拒。
     探测要跑若干 `--version`（每个上限 2s），所以缓存 60s；探测失败 = 当没装，不编。 */
  /** @type {{ at: number, rows: Array<{ id: string, label: string, kind: string, available: boolean, version: string, note: string }> }} */
  let agentsProbeCache = { at: 0, rows: [] };
  const probeAgentsCached = async (refresh = false) => {
    const now = Date.now();
    if (!refresh && agentsProbeCache.at !== 0 && now - agentsProbeCache.at < 60_000) return agentsProbeCache.rows;
    const probe = await probeAgents();
    const rows = (Array.isArray(probe?.descriptors) ? probe.descriptors : []).map((/** @type {any} */ row) => ({
      id: String(row.id ?? ''),
      label: String(row.displayName ?? row.id ?? ''),
      kind: typeof row.kind === 'string' ? row.kind : 'cli',
      available: typeof row.path === 'string',
      version: typeof row.version === 'string' ? row.version : '',
      note: String(row.note ?? row.state ?? ''),
    }));
    agentsProbeCache = { at: now, rows };
    return rows;
  };
  const agentScene = createAgentScene({
    registry,
    logger: (line) => log(line),
    acpProvider: acpAgent.provider,
    acpStatus: (refresh) => acpAgent.connection(refresh),
    localClients: acpAgent.local,
    agents: probeAgentsCached,
    /* 只读 Key **存在性**：只 stat `keys/model.enc`，既不读原文、也不开 vault
       （`modelKeyStore()` 会建目录/主密钥 —— 那算「碰密钥」，状态面不该有副作用）。 */
    modelKeyStatus: async () => {
      const file = join(modelKeyDir(), 'model.enc');
      const present = await fsp.stat(file).then(() => true).catch(() => false);
      return { configured: present, tail: null, backend: 'local-vault' };
    },
    ...(options.agentProvider !== undefined ? { provider: options.agentProvider } : {}),
    ...(Number.isFinite(options.applyApprovalTtlMs) ? { applyApprovalTtlMs: Number(options.applyApprovalTtlMs) } : {}),
  });

  /**
   * 工程目录移动（M72）：同盘 rename / 跨盘 copy→校验→切索引→回收。
   * `options.moveVerify` 只给测试注入「校验失败」场景（默认校验见 project-move.mjs）。
   */
  // LL1: one domain dispatcher for UI, CLI and MCP. No alternate film writer.
  const creationHome = options.home ?? os.homedir();
  const mediaServices = createMediaServices({
    ...(options.home ? { configFile: join(creationHome, '.opencut', 'media-services.json') } : {}),
    resolveKey: async () => (await modelKeyStore()).readKey(),
  });
  const creationHttp = createCreationLibraryHttp({
    registry, mediaServices,
    libraryRoot: join(creationHome, '.opencut', 'creation-library'),
    contentOrigin: () => contentState.origin,
    /** @param {import('node:http').IncomingMessage} req @param {string} projectId */
    authorize(req, projectId) {
      if (req.headers['x-opencut-apply-approval']) return { ok: false, code: 'APPLY_TICKET_NOT_FOR_OPS', message: '草稿批准票不能用作工程工具票' };
      const grantId = req.headers['x-opencut-agent-grant'];
      if (!grantId) return { ok: true, by: 'person' };
      if (typeof grantId !== 'string') return { ok: false, code: 'GRANT_INVALID' };
      const issued = grants.get(grantId);
      if (issued && acpAgent.sessionState(issued.sessionId)?.alive !== true) return { ok: false, code: 'SESSION_CLOSED', message: 'Agent 会话已关闭' };
      const verdict = grants.authorize(grantId, {
        projectId, projectPath: String(registry.get(projectId)?.dir ?? ''), tool: 'film_apply_ops',
        ...(issued ? { sessionId: issued.sessionId } : {}),
        requestId: issued ? acpAgent.turnOf(issued.sessionId) : null,
      });
      return verdict.ok ? { ok: true, by: 'agent' } : { ...verdict, message: '受控写授权不通过' };
    },
  });

  const projectMover = createProjectMover({
    registry,
    home: options.home,
    logger: (line) => log(line),
    ...(typeof options.moveVerify === 'function' ? { verify: options.moveVerify } : {}),
    ...(options.forceCopyMove === true ? { forceCopy: true } : {}),
  });



  /** 事件通道 HTTP 侧的观测计数（排障用，不作为验收口径）。 */
  /** @type {{ connections: number, rejected: number, messages: number, lastRejection: any }} */
  const wsStats = { connections: 0, rejected: 0, messages: 0, lastRejection: null };

  const server = createServer((req, res) => {
    const origin = req.headers.origin;
    const hasOrigin = typeof origin === 'string' && origin !== '';
    const originAllowed = !hasOrigin || allowedOrigins.has(String(origin));

    if (hasOrigin) {
      res.setHeader('Vary', 'Origin');
      if (originAllowed) {
        res.setHeader('Access-Control-Allow-Origin', String(origin));
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'content-type');
      }
    }

    if (!originAllowed) {
      sendJson(res, 403, {
        ok: false,
        code: 'ORIGIN_REJECTED',
        message: `origin not allowed: ${String(origin)}`,
        allowed: [...allowedOrigins],
      });
      return;
    }

    const method = req.method ?? 'GET';
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${host}:${state.boundPort}`);
    void handleRequest(req, res, method, url).catch((error) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, {
        ok: false,
        code: 'INTERNAL',
        message: String(/** @type {Error} */ (error)?.message ?? error),
      });
    });
  });

  // All project views share one profile. Serialize the read, merge and write together.
  let settingsWrites = Promise.resolve();
  /** @param {unknown} patch @param {import('node:http').ServerResponse} res */
  async function respondToSettingsPatch(patch, res) {
    const current = await readSettings();
    const applied = applySettingsPatch(patch, current.settings);
    if (applied.ok !== true) {
      /* M80：错误体固定五键 —— `reason` 是**机器可读**的固定枚举（见 settings-store 的
         SETTINGS_ERROR_REASONS），副线1 的设置面板按它给不同修复建议；`message` 一字未改，
         已经在显示它的地方不受影响。`allowed` 仍然保留（老调用方在用）。 */
      sendJson(res, 400, {
        ok: false,
        code: applied.code,
        field: applied.field ?? null,
        reason: applied.reason ?? 'VALUE_INVALID',
        allowed: applied.allowed ?? null,
        message: applied.message,
      });
      return;
    }
    const written = await writeSettings(applied.settings);
    if (written.ok !== true) {
      // 写盘失败不是校验失败：`field` 为 null，`reason` 统一 WRITE_FAILED（形状与 400 一致）。
      sendJson(res, 500, {
        ok: false,
        code: written.code,
        field: null,
        reason: written.reason ?? 'WRITE_FAILED',
        message: written.message,
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      settings: applied.settings,
      path: written.path,
      updatedAt: written.updatedAt,
      sha256: written.sha256,
      bytes: written.bytes,
      // M65：只对**新建会话**生效；已在跑的 ACP 会话不静默重启。
      appliesTo: 'new-session',
    });
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} method
   * @param {URL} url
   */
  async function handleRequest(req, res, method, url) {
    const path = url.pathname;
    if (await creationHttp(req, res, method, url)) return;

    if (path === '/healthz') {
      if (!requireMethod(method, res, ['GET', 'HEAD'])) return;
      sendJson(res, 200, {
        ok: true,
        version,
        pid: process.pid,
        studioVersion: STUDIO_VERSION,
        events: {
          transport: 'websocket',
          contract: EVENTS_CONTRACT_VERSION,
          url: eventsUrl(),
        },
        contentOrigin: contentState.origin === null ? null : { origin: contentState.origin, port: contentState.port },
        projects: registry.summaries().length,
      });
      return;
    }

    /* ── 设置中心（M49）：用户级设置，**不写 film.html / .film/** ───────── */
    if (path.startsWith('/api/covers/') && (method === 'GET' || method === 'HEAD')) {
      let name = '';
      try {
        name = decodeURIComponent(path.slice('/api/covers/'.length));
      } catch {
        sendJson(res, 400, { ok: false, code: 'COVER_NAME_INVALID', message: '封面名不是合法的 URL 编码' });
        return;
      }
      if (!isCoverName(name)) {
        sendJson(res, 400, { ok: false, code: 'COVER_NAME_INVALID', message: '封面名必须是 16 位十六进制 .png' });
        return;
      }
      let buffer;
      try {
        buffer = await fsp.readFile(coverPath(name, options.home));
      } catch {
        sendJson(res, 404, { ok: false, code: 'COVER_NOT_FOUND', message: `没有这张封面：${name}` });
        return;
      }
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': String(buffer.byteLength),
        // 同一个工程同一个文件名，重新生成会覆盖 → 短缓存，别用 immutable。
        'cache-control': 'public, max-age=60',
      });
      res.end(method === 'HEAD' ? undefined : buffer);
      return;
    }

    if (path === '/api/settings' && (method === 'GET' || method === 'HEAD')) {
      const current = await readSettings();
      // M65：旧的 `~/.opencut/mcp.json` **不读、不写**；只提示它被忽略，避免用户以为改了不生效。
      const issues = legacyMcpExists() ? [...current.issues, 'LEGACY_MCP_FILE_IGNORED'] : current.issues;
      sendJson(res, 200, { ...current, issues, ai: aiCards(), appliesTo: 'new-session' });
      return;
    }

    if (path === '/api/settings' && method === 'PUT') {
      const body = await readJson(req, res);
      if (body === INVALID) return;
      let patch = body?.settings;
      if (patch === undefined) {
        // 也接受扁平补丁（`{playback:{...}}`）：两种写法都要能过，别让调用方猜。
        patch = body;
      }
      const writing = settingsWrites.then(() => respondToSettingsPatch(patch, res));
      settingsWrites = writing.catch(() => {});
      await writing;
      return;
    }

    if (path === '/api/settings/model-key' && (method === 'GET' || method === 'HEAD')) {
      /* B-SUB1-R31-054：只回「配没配 + 尾 4 位」，**不回 key**（明文、密文都不回）。 */
      const status = await (await modelKeyStore()).status();
      sendJson(res, 200, { ok: true, ...status });
      return;
    }

    if (path === '/api/settings/model-key' && method === 'PUT') {
      const body = await readJson(req, res);
      if (body === INVALID) return;
      try {
        const status = await (await modelKeyStore()).save(body?.key);
        sendJson(res, 200, { ok: true, ...status });
      } catch (error) {
        const code = error instanceof ModelKeyError ? error.code : MODEL_KEY_ERRORS.WRITE_FAILED;
        /* 空串/太短/带换行是 400（客户端的错）；写盘失败是 500。消息里永远不会拼 key。 */
        sendJson(res, code === MODEL_KEY_ERRORS.WRITE_FAILED || code === MODEL_KEY_ERRORS.READ_FAILED ? 500 : 400, {
          ok: false,
          code,
          field: 'key',
          reason: code,
          message: error instanceof ModelKeyError ? error.message : 'Key 保存失败',
        });
      }
      return;
    }

    if (path === '/api/settings/model-key' && method === 'DELETE') {
      try {
        const status = await (await modelKeyStore()).clear();
        sendJson(res, 200, { ok: true, ...status });
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          code: MODEL_KEY_ERRORS.WRITE_FAILED,
          field: 'key',
          reason: MODEL_KEY_ERRORS.WRITE_FAILED,
          message: error instanceof ModelKeyError ? error.message : 'Key 清除失败',
        });
      }
      return;
    }

    /**
     * 「测试连接」：拿**已保存的** key 走一次 `packages/providers/client.mjs` 的真实请求链路。
     *
     * 这是 A4 的产品面：请求头由 wire 的 `authHeaders()` 生成，UI 只显示结果，
     * 不显示 key；失败消息过 redact + 二次原文替换，保证完整 key 不出现在响应里。
     * 端点由 `OPENCUT_MODEL_BASE_URL` / `OPENCUT_MODEL_NAME` 决定（缺省 OpenAI 兼容）；
     * 证据只许用本地 stub 的 200，**不许**写成「真实厂商已验证」。
     */
    if (path === '/api/settings/model-key/check' && method === 'POST') {
      const key = await (await modelKeyStore()).readKey();
      if (key === null) {
        sendJson(res, 400, {
          ok: false,
          code: 'KEY_MISSING',
          field: 'key',
          reason: 'KEY_MISSING',
          message: '还没有配置 Key（先保存再测试）',
        });
        return;
      }
      const endpoint = modelEndpoint(process.env);
      const startedAt = Date.now();
      try {
        const provider = createProvider({
          wire: /** @type {any} */ (endpoint.wire),
          baseUrl: endpoint.baseUrl,
          apiKey: key,
          model: endpoint.model,
          maxOutputTokens: 8,
          timeoutMs: endpoint.timeoutMs,
          maxConcurrent: 1,
        });
        const result = await provider.complete({ messages: [{ role: 'user', content: 'ping' }] }, { stream: false });
        sendJson(res, 200, {
          ok: true,
          status: 200,
          wire: endpoint.wire,
          model: endpoint.model,
          baseUrl: endpoint.baseUrl,
          textLength: String(result.text ?? '').length,
          latencyMs: Date.now() - startedAt,
        });
      } catch (error) {
        const code = typeof (/** @type {any} */ (error)?.code) === 'string' ? /** @type {any} */ (error).code : 'PROVIDER_HTTP_ERROR';
        const raw = String(/** @type {any} */ (error)?.message ?? error);
        /* 双保险：createProvider 已 registerSecret；这里再按原文替换一次。 */
        const message = redactText(raw).split(key).join(`sk-****${key.slice(-4)}`).slice(0, 300);
        sendJson(res, code === 'INVALID_REQUEST' ? 500 : 502, {
          ok: false,
          code,
          status: Number.isInteger(/** @type {any} */ (error)?.status) ? /** @type {any} */ (error).status : null,
          wire: endpoint.wire,
          model: endpoint.model,
          baseUrl: endpoint.baseUrl,
          message,
          latencyMs: Date.now() - startedAt,
        });
      }
      return;
    }

    if (path === '/api/settings/diagnostics' && (method === 'GET' || method === 'HEAD')) {
      const report = await settingsDiagnostics({
        ports: {
          studio: state.boundPort,
          vite: Number(vitePort),
          content: contentState.port,
        },
        projectRoot: typeof options.projectsRoot === 'string' ? options.projectsRoot : '',
        studioVersion: version,
        logsDir: typeof options.projectsRoot === 'string' ? join(options.projectsRoot, '..', 'logs') : '',
      });
      // M68：隐藏占用 = 已打开的工程 + projectsRoot 下能列出来的工程（按路径去重）。
      /** @type {{id: string, path: string}[]} */
      const known = [];
      if (typeof options.projectsRoot === 'string' && options.projectsRoot !== '') {
        const listed = await registry.list(options.projectsRoot);
        if (listed.ok === true) {
          for (const item of listed.projects ?? []) known.push({ id: item.projectId, path: item.path });
        }
      }
      for (const summary of registry.summaries()) {
        if (!known.some((item) => item.path === summary.path)) known.push({ id: summary.projectId, path: summary.path });
      }
      const hidden = await hiddenUsage({ projects: known });
      // M72：旧目录没回收掉的历史（`RECLAIM_FAILED`）在这里可见，不静默吞。
      const stale = await readStalePaths({ home: options.home });
      sendJson(res, 200, { ok: true, ...report, hidden, stalePaths: stale.entries, issues: hidden.issues });
      return;
    }

    if (path === '/api/settings/storage' && (method === 'GET' || method === 'HEAD')) {
      const projectId = url.searchParams.get('projectId') ?? '';
      const project = registry.get(projectId);
      if (project === null) {
        sendJson(res, 404, { ok: false, code: 'FILM_NOT_FOUND', message: '工程未打开：先 /api/projects/open' });
        return;
      }
      sendJson(res, 200, { ok: true, ...(await projectStorage(project.dir)), projectId });
      return;
    }

    if (path === '/api/settings/cache/clean' && method === 'POST') {
      const body = await readJson(req, res);
      if (body === INVALID) return;
      const project = registry.get(typeof body?.projectId === 'string' ? body.projectId : '');
      if (project === null) {
        sendJson(res, 404, { ok: false, code: 'FILM_NOT_FOUND', message: '工程未打开：先 /api/projects/open' });
        return;
      }
      // M68：这个路由**只清 `.film/cache/**`**（历史/日志/其它文件一律不动）。
      const cleaned = await cleanCache(project.dir, { confirm: body?.confirm === true });
      sendJson(res, cleaned.ok === true ? 200 : 400, cleaned);
      return;
    }

    // /api/render/queue（M67）：只读观测。返回固定五字段，不掺 `ok`，副线可以直接按字段对接。
    if (path === '/api/render/queue' && (method === 'GET' || method === 'HEAD')) {
      if (renderQueue.error !== null) {
        sendJson(res, 400, {
          ok: false,
          code: renderQueue.error.code,
          allowed: renderQueue.error.allowed ?? null,
          message: renderQueue.error.message,
        });
        return;
      }
      await renderQueue.ready;
      sendJson(res, 200, renderQueue.status());
      return;
    }

    /* ── 只读图层 / 检查器（M66 v1 → M69 v2）：副线1 面板的消费者；**不写** film.html ─── */
    if (path === '/api/layers' && (method === 'GET' || method === 'HEAD')) {
      const projectId = url.searchParams.get('project') ?? '';
      if (projectId.trim() === '') {
        sendJson(res, 400, { ok: false, code: 'BAD_REQUEST', message: '缺少 project 参数' });
        return;
      }
      const project = registry.get(projectId);
      if (project === null) {
        sendJson(res, 404, { ok: false, code: 'FILM_NOT_FOUND', message: `工程未打开：${projectId}` });
        return;
      }
      const clipId = url.searchParams.get('clip') ?? '';
      const tValue = Number(url.searchParams.get('t') ?? '0');
      try {
        const body = await layerReader.layers({
          projectId,
          clipId,
          t: Number.isFinite(tValue) ? tValue : 0,
        });
        /* R143：元素写守卫要的观察标（实例 + 每层签名）。只有 page 片段才有；
           拿不到就**不发**这两个字段（UI 侧据此只做片段级编辑，不伪造目标）。 */
        const targetMarks = clipId === '' ? null : await pageTargetMarks(projectId, clipId, body);
        sendJson(res, 200, targetMarks === null ? body : { ...body, ...targetMarks });
      } catch (error) {
        sendReadApiError(res, error);
      }
      return;
    }

    if (path === '/api/elements/inspect' && method === 'POST') {
      const body = await readJson(req, res);
      if (body === INVALID) return;
      const projectId = typeof body?.project === 'string' ? body.project : '';
      const elementId = typeof body?.elementId === 'string' ? body.elementId : '';
      if (projectId.trim() === '' || elementId.trim() === '') {
        sendJson(res, 400, {
          ok: false,
          code: 'BAD_REQUEST',
          message: 'project 与 elementId 都必须是非空字符串',
        });
        return;
      }
      const project = registry.get(projectId);
      if (project === null) {
        sendJson(res, 404, { ok: false, code: 'FILM_NOT_FOUND', message: `工程未打开：${projectId}` });
        return;
      }
      const tValue = Number(body?.t ?? 0);
      try {
        const inspected = await layerReader.inspect({
          projectId,
          elementId,
          ...(typeof body?.clipId === 'string' ? { clipId: body.clipId } : {}),
          t: Number.isFinite(tValue) ? tValue : 0,
        });
        sendJson(res, 200, inspected);
      } catch (error) {
        sendReadApiError(res, error);
      }
      return;
    }

    /* ── R114-B2：Agent 名册（真实 provider + 真实探测；只报真的）────────────
       面板底部的 Agent/模型选择从这里渲染：不在名册里的项 UI 不给选，选了也会被
       `pickSelection` 400 拒掉 —— 不出现「显示可选、请求里没有」的假下拉。 */
    if (path === '/api/agent/roster' && (method === 'GET' || method === 'HEAD')) {
      try {
        const roster = await agentScene.roster(url.searchParams.get('refresh') === '1');
        sendJson(res, 200, { ok: true, ...roster });
      } catch (error) {
        sendSceneError(res, error);
      }
      return;
    }

    /* ── M71：Agent 原创场景（草稿 → 校验 → 应用 → 可回滚）───────────────────
       草稿只在内存里；写盘走 `registry.applyOps`（现有唯一写入口）；
       回滚用 M62 版本快照。三个路由都是 POST/GET，不需要 UI 参与。 */
    const sceneRoute = /^\/api\/agent\/scene(?:\/([^/]+)(?:\/(apply|rollback|approval))?)?$/.exec(path);
    if (sceneRoute !== null) {
      const draftId = sceneRoute[1] === undefined ? '' : decodeURIComponent(/** @type {string} */ (sceneRoute[1]));
      const action = sceneRoute[2] ?? '';
      if (draftId === '') {
        if (!requireMethod(method, res, ['POST'])) return;
        const body = await readJson(req, res);
        if (body === INVALID) return;
        const plain = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : null;
        if (plain === null) {
          sendJson(res, 400, { ok: false, code: 'BAD_REQUEST', message: '请求体必须是 JSON 对象' });
          return;
        }
        const extra = Object.keys(plain).filter((key) => !SCENE_REQUEST_FIELDS.includes(key));
        if (extra.length > 0) {
          sendJson(res, 400, {
            ok: false,
            code: 'UNKNOWN_FIELD',
            field: extra[0],
            allowed: [...SCENE_REQUEST_FIELDS],
            message: `未知字段：${String(extra[0])}`,
          });
          return;
        }
        try {
          /* CS3（R30-126）：页面重载/关标签会把这条 fetch 断掉（浏览器 abort）。
             这里只把台账标成 detached —— **不关 run**：重载之后用户点 Stop，
             还要能停到同一回合。真正的关闭只走 cancel 或 provider 终态。 */
          const runHint = plain.run !== null && typeof plain.run === 'object' && !Array.isArray(plain.run) ? plain.run : null;
          if (runHint !== null) {
            const projectHint = typeof plain.project === 'string' ? plain.project : '';
            const sessionHint = typeof plain.session === 'string' ? plain.session : '';
            const pageHint = typeof runHint.pageId === 'string' ? runHint.pageId : '';
            res.once('close', () => {
              if (res.writableEnded) return;
              agentScene.detachRun({
                projectId: projectHint,
                ...(sessionHint === '' ? {} : { sessionId: sessionHint }),
                runId: typeof runHint.runId === 'string' ? runHint.runId : '',
                ...(pageHint === '' ? {} : { pageId: pageHint }),
              });
            });
          }
          /* 会话 store 在这里建（`agent-scene` 不碰工程目录结构）：`session` 只做
             上下文引用与记录，apply/rollback 语义不变。 */
          const projectForSession = registry.get(String(plain.project ?? ''));
          const sessionsStore = projectForSession === null ? null : createSessionsStore({ project: projectForSession });
          const created = await agentScene.draft({
            projectId: plain.project,
            prompt: plain.prompt,
            ...(plain.seed !== undefined ? { seed: plain.seed } : {}),
            ...(plain.session !== undefined ? { session: plain.session } : {}),
            ...(plain.agent !== undefined ? { agent: plain.agent } : {}),
            ...(plain.model !== undefined ? { model: plain.model } : {}),
            ...(plain.options !== undefined ? { options: plain.options } : {}),
            /* R122（M8）：run 身份 / 引用 / 聊天附件**原样透传** —— 路由不认识它们，
               由 `agent-scene` 校验（run 形状、refs 类别、附件字节数与摘要）。
               不透传的后果是「UI 发了、服务端看不到」，D07 那一类假消费就是这么来的。 */
            ...(plain.run !== undefined ? { run: plain.run } : {}),
            ...(plain.refs !== undefined ? { refs: plain.refs } : {}),
            ...(plain.attachments !== undefined ? { attachments: plain.attachments } : {}),
            sessions: sessionsStore,
          });
          sendJson(res, 200, { ok: true, ...created });
        } catch (error) {
          sendSceneError(res, error);
        }
        return;
      }
      if (action === '') {
        if (!requireMethod(method, res, ['GET'])) return;
        const found = agentScene.get(draftId);
        if (found === null) {
          sendJson(res, 404, { ok: false, code: 'DRAFT_NOT_FOUND', message: `草稿不存在或已过期：${draftId}` });
          return;
        }
        sendJson(res, 200, { ok: true, draft: found });
        return;
      }
      if (action === 'approval') {
        if (!requireMethod(method, res, ['POST'])) return;
        try {
          sendJson(res, 200, agentScene.approve(draftId));
        } catch (error) {
          sendSceneError(res, error);
        }
        return;
      }
      if (action === 'apply') {
        if (!requireMethod(method, res, ['POST'])) return;
        try {
          /* CS3：应用是**人工**授权 —— 批准票走独立头，ACP 工具票在这条路上不认。 */
          const approval = req.headers['x-opencut-apply-approval'];
          if (typeof req.headers['x-opencut-agent-grant'] === 'string' && req.headers['x-opencut-agent-grant'] !== '') {
            sendJson(res, 403, {
              ok: false,
              code: 'APPLY_AGENT_TICKET_FORBIDDEN',
              message: 'ACP 工具票不能用来应用草稿：应用必须由用户在面板上批准',
            });
            return;
          }
          sendJson(res, 200, await agentScene.apply(draftId, {
            approval: typeof approval === 'string' ? approval : '',
          }));
        } catch (error) {
          sendSceneError(res, error);
        }
        return;
      }
      if (action === 'rollback') {
        if (!requireMethod(method, res, ['POST'])) return;
        try {
          sendJson(res, 200, await agentScene.rollback(draftId));
        } catch (error) {
          sendSceneError(res, error);
        }
        return;
      }
      sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', allowed: ['GET', 'POST'] });
      return;
    }

    /* ── CS3（MAIN-CS3-AUTHZ）：真实工具权限卡的两条只读/答复路由 ──────────
       数据源**只有** ACP 会话的待答复请求；mock provider 根本没有会话，
       所以它不会在这里产生任何「权限卡」。 */
    if (path === '/api/agent/acp' && (method === 'GET' || method === 'HEAD')) {
      const projectFilter = url.searchParams.get('project') ?? '';
      const stats = acpAgent.stats();
      sendJson(res, 200, {
        ok: true,
        ...stats,
        permissions: acpAgent.permissions(projectFilter),
        project: projectFilter,
      });
      return;
    }
    const permissionRoute = /^\/api\/agent\/permissions\/([^/]+)$/.exec(path);
    if (permissionRoute !== null) {
      if (!requireMethod(method, res, ['POST'])) return;
      const body = await readJson(req, res);
      if (body === INVALID) return;
      const plain = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {};
      const permissionId = decodeURIComponent(/** @type {string} */ (permissionRoute[1]));
      const projectId = typeof plain.projectId === 'string' ? plain.projectId : '';
      const sessionHint = typeof plain.sessionId === 'string' ? plain.sessionId : '';
      const pending = acpAgent.permissions('');
      /** @param {any} answered */
      const sendAnswerError = (answered) => {
        const status =
          answered.code === 'PERMISSION_PROJECT_MISMATCH'
            ? 403
            : answered.code === 'PERMISSION_EXPIRED' || answered.code === 'PERMISSION_ANSWERED'
              ? 409
              : answered.code === 'PERMISSION_DECISION_INVALID'
                ? 400
                : 404;
        sendJson(res, status, {
          ok: false,
          code: answered.code,
          message:
            answered.code === 'PERMISSION_EXPIRED'
              ? '这条权限请求已超时（超时一律拒绝），答复不生效'
              : answered.code === 'PERMISSION_ANSWERED'
                ? '这条权限请求已经答复过（重复答复不生效）'
                : `权限答复没有生效：${answered.code}`,
        });
      };
      const target = pending.find((/** @type {any} */ row) => row.id === permissionId && (sessionHint === '' || row.sessionId === sessionHint));
      if (target === undefined) {
        const elsewhere = pending.find((/** @type {any} */ row) => row.id === permissionId);
        if (elsewhere !== undefined) {
          sendJson(res, 403, { ok: false, code: 'PERMISSION_PROJECT_MISMATCH', message: '这条权限请求属于别的工程' });
          return;
        }
        /* 已经不是待答复状态：说过期 / 重复答复要**准确**，不能一律 404。
           带 sessionId 时让 AgentSessions 查它的 permissionLog。 */
        if (sessionHint !== '') {
          const replayed = acpAgent.answerPermission(sessionHint, permissionId, plain.decision, { projectId });
          if (replayed.ok !== true) {
            sendAnswerError(replayed);
            return;
          }
        }
        sendJson(res, 404, { ok: false, code: 'PERMISSION_NOT_FOUND', message: `没有这条待答复的权限请求：${permissionId}` });
        return;
      }
      if (projectId !== '' && target.projectId !== projectId) {
        sendJson(res, 403, { ok: false, code: 'PERMISSION_PROJECT_MISMATCH', message: '这条权限请求属于别的工程' });
        return;
      }
      const answered = acpAgent.answerPermission(target.sessionId, permissionId, plain.decision, {
        projectId: target.projectId,
      });
      if (answered.ok !== true) {
        sendAnswerError(answered);
        return;
      }
      sendJson(res, 200, { ok: true, ...answered });
      return;
    }

    /* ── R122（M8-A · D08）：精确 run 取消 ─────────────────────────────
       取消是**服务端**语义：`agent-runs.mjs` 记着每一 run 的归属与终态，这里只做
       「解析路径 → 交台账 → 回状态码」。不存在 404；跨项目/跨会话 403 **且不取消**；
       重复取消 200 幂等；已完成的 run 再取消只回执、不改状态。 */
    const cancelRoute = /^\/api\/agent\/runs\/([^/]+)\/cancel$/.exec(path);
    if (cancelRoute !== null) {
      if (!requireMethod(method, res, ['POST'])) return;
      const body = await readJson(req, res);
      if (body === INVALID) return;
      const plain = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {};
      const cancelled = agentScene.runs.cancelHttp(decodeURIComponent(/** @type {string} */ (cancelRoute[1])), plain);
      sendJson(res, cancelled.status, cancelled.body);
      return;
    }

    if (path === '/api/events') {
      // 旧的 UI SSE 总线：明确下线，而不是留个会误导人的空流。
      sendJson(res, 410, {
        ok: false,
        code: 'UI_EVENTS_SSE_REMOVED',
        message: `UI 事件通道已改为 WebSocket：${eventsUrl()}`,
        websocket: eventsUrl(),
        contract: 'contracts/events.ts@1.1.0',
      });
      return;
    }

    if (path === '/api/events/publish') {
      if (!debugEvents) {
        sendJson(res, 404, { ok: false, code: 'NOT_FOUND', path });
        return;
      }
      if (!requireMethod(method, res, ['POST'])) return;
      const body = await readJson(req, res);
      if (body === INVALID) return;
      const events = Array.isArray(body) ? body : [body];
      /** @type {number[]} */
      const seqs = [];
      for (const event of events) {
        if (event === null || typeof event !== 'object' || typeof event.type !== 'string') {
          sendJson(res, 400, { ok: false, code: 'BAD_EVENT', message: '事件必须是带 type 的对象' });
          return;
        }
        try {
          seqs.push(hub.publish(/** @type {any} */ (event)));
        } catch (error) {
          sendJson(res, 400, { ok: false, code: 'BAD_EVENT', message: String(/** @type {Error} */ (error).message) });
          return;
        }
      }
      sendJson(res, 200, { ok: true, seq: seqs });
      return;
    }

    // 只读磁吸预览（M63）：像素容差在服务端换算成秒；返回候选/吸附结果/将要发的 op，**不写盘**。
    // 写盘仍只走 /ops（磁吸只负责算，落盘由调用方把那批 op 交给 /ops）。
    if (path === '/api/timeline/snap' && method === 'POST') {
      const body = await readJson(req, res);
      if (body === INVALID) return;
      const projectId = typeof body?.projectId === 'string' ? body.projectId : '';
      const current = registry.docOf(projectId);
      if (current === null) {
        sendJson(res, 404, { ok: false, code: 'FILM_NOT_FOUND', message: '工程未打开：先 /api/projects/open' });
        return;
      }
      /** @type {any} */
      const input = {
        lanes: current.doc.tracks,
        seconds: Number(body?.seconds),
        fps: current.doc.fps,
        tolerancePx: Number(body?.tolerancePx),
      };
      if (typeof body?.clipId === 'string') input.clipId = body.clipId;
      if (body?.mode === 'move' || body?.mode === 'trim') input.mode = body.mode;
      if (body?.edge === 'start' || body?.edge === 'end') input.edge = body.edge;
      if (body?.pxPerSecond !== undefined) input.pxPerSecond = Number(body.pxPerSecond);
      if (body?.viewportWidth !== undefined) input.viewportWidth = Number(body.viewportWidth);
      if (body?.durationSec !== undefined) input.durationSec = Number(body.durationSec);
      if (body?.playhead !== undefined) input.playhead = Number(body.playhead);
      try {
        const planned = planTimelineSnap(input);
        sendJson(res, 200, { ok: true, fps: current.doc.fps, sourceHash: current.hash, ...planned });
      } catch (error) {
        if (error instanceof SnapError) {
          sendJson(res, 400, { ok: false, code: error.code, message: error.message });
          return;
        }
        throw error;
      }
      return;
    }

    // 只读画布预览（M64）：手势 → 最终 box + 将要发的 /ops，不写盘。
    // 写盘仍只走 /ops；这里只回答「松手后应该是多少」。
    if (path === '/api/canvas/preview' && method === 'POST') {
      const body = await readJson(req, res);
      if (body === INVALID) return;
      const projectId = typeof body?.projectId === 'string' ? body.projectId : '';
      const current = registry.docOf(projectId);
      if (current === null) {
        sendJson(res, 404, { ok: false, code: 'FILM_NOT_FOUND', message: '工程未打开：先 /api/projects/open' });
        return;
      }
      const clipId = typeof body?.clipId === 'string' ? body.clipId : '';
      /** @type {any} */
      let clip = null;
      for (const track of current.doc.tracks) {
        for (const item of track.clips ?? []) {
          if (item?.id === clipId) {
            clip = item;
            break;
          }
        }
        if (clip !== null) break;
      }
      if (clip === null) {
        sendJson(res, 404, { ok: false, code: 'CANVAS_CLIP_NOT_FOUND', message: `片段不存在：${clipId}` });
        return;
      }
      const base = readbackBox(clip);
      if (base === null) {
        sendJson(res, 400, { ok: false, code: 'CANVAS_NO_BOX', message: `片段没有 box：${clipId}` });
        return;
      }
      const mapped = applyCanvasGesture({ stage: current.doc.stage, box: base, gesture: body?.gesture });
      if (mapped.ok !== true) {
        sendJson(res, 400, { ok: false, code: mapped.code, message: mapped.message });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        sourceHash: current.hash,
        base,
        box: mapped.box,
        overflow: mapped.overflow,
        overflowPx: mapped.overflowPx,
        minApplied: mapped.minApplied,
        ops: boxToOps({ clipId, box: mapped.box }),
      });
      return;
    }

    // 队列视图（M29）：全部作业按**入队顺序** + 摘要（谁在跑、几个在等）。
    // M37：`claims` 是作业句柄的进程内输出占用（诊断用：EXPORT_OUTPUT_BUSY 的持有者能对上）。
    if (path === '/api/export' && (method === 'GET' || method === 'HEAD')) {
      sendJson(res, 200, {
        ok: true,
        jobs: exportJobs.list(),
        summary: exportJobs.summary(),
        transitions: exportJobs.transitions,
        claims: exportJobs.claims(),
      });
      return;
    }

    if (path === '/api/export' && method === 'POST') {
      const body = await readJson(req, res);
      if (body === INVALID) return;
      const parsed = validateExportRequest(body);
      if (parsed.ok !== true) {
        sendJson(res, 400, { ok: false, code: parsed.code, message: parsed.message });
        return;
      }
      /* M78：可选 `sequence`。不传 = 当前打开序列；传了 = 那个序列（不需要先切 current）。 */
      const target = await registry.sequenceTarget(body.projectId, parsed.sequence);
      if (target.ok !== true) {
        sendJson(res, Number(target.status) || 404, {
          ok: false,
          code: target.code,
          message: target.message,
          ...(target.diagnostics === undefined ? {} : { diagnostics: target.diagnostics }),
        });
        return;
      }
      const project = target.project;
      const current = { doc: target.doc, hash: target.hash };
      /** @type {Extract<ReturnType<typeof prepareClipExport>, {ok: true}>|null} */
      let clipExport = null;
      if (parsed.clipId !== null && parsed.expectedHash !== null) {
        if (parsed.expectedHash !== current.hash) {
          sendJson(res, 409, { ok: false, code: 'CONFLICT', message: '工程已更新，请刷新后重新导出片段' });
          return;
        }
        let text;
        try {
          const [root, file] = await Promise.all([fsp.realpath(project.dir), fsp.realpath(project.filmPath)]);
          if (!isInside(root, file)) {
            sendJson(res, 400, { ok: false, code: 'E_PATH_ESCAPE', message: '无法读取工程目录以外的影片源文件' });
            return;
          }
          text = await fsp.readFile(file, 'utf8');
        } catch {
          sendJson(res, 404, { ok: false, code: 'FILM_NOT_FOUND', message: '无法读取当前序列的影片源文件' });
          return;
        }
        const prepared = prepareClipExport({ text, clipId: parsed.clipId, expectedHash: parsed.expectedHash });
        if (!prepared.ok) {
          const status = prepared.code === 'CONFLICT' ? 409 : prepared.code === 'CLIP_NOT_FOUND' ? 404 : 400;
          sendJson(res, status, prepared);
          return;
        }
        clipExport = prepared;
      }
      // 显式输出文件（M37）：必须是工程目录内的绝对路径。写盘落点只允许在工程里，
      // 与 GET /file 同一条边界；越界 400，不静默改到别处。
      /** @type {string|null} */
      let outPath = null;
      if (parsed.outPath !== null) {
        const root = canonicalProjectDirectory(project.dir);
        const target = await canonicalOutputPath(parsed.outPath).catch(() => null);
        if (target === null || !isInside(root, target) || target === root) {
          sendJson(res, 400, {
            ok: false,
            code: 'E_PATH_ESCAPE',
            message: `outPath 必须在工程目录内：${parsed.outPath}`,
          });
          return;
        }
        outPath = target;
      }
      // M39：多段末端越界在**入队前**判死（400、队列长度不变、exports/ 一行不写）。
      /** @type {any} */
      let planPreview = null;
      if (parsed.ranges !== null) {
        const bounded = await checkRangesWithinDuration(current.doc, project.dir, parsed.ranges);
        if (bounded.ok !== true) {
          sendJson(res, 400, { ok: false, code: bounded.code, message: bounded.message });
          return;
        }
        planPreview = summarizeRanges(parsed.ranges, bounded.duration, parsed.fps ?? 30);
      }
      // M41：烧字幕的两条拒绝也在**入队前**（SUBTITLE_EMPTY / SUBTITLE_SRC_INVALID）。
      // M44 起多段 + 烧录是正常请求（P40 的映射层已经会拆条/丢间隙），不再有第三条。
      // 文档快照与字幕条目在这里就固定：排队期间改 vtt 不影响本作业。
      /** @type {any} */
      let burnInput = {};
      if (parsed.subtitleBurn === true) {
        const feasible = await checkBurnFeasible({
          project,
          ranges: parsed.ranges,
          subtitleSrc: parsed.subtitleSrc,
        });
        if (feasible.ok !== true) {
          sendJson(res, 400, { ok: false, code: feasible.code, message: feasible.message });
          return;
        }
        // M44：多段放开之后，「这些 cue 全落在被删的间隙里」只有**按计划映射一遍**才知道
        // （`checkBurnFeasible` 只看文件）。入队前真算一次：全落间隙 → 400 SUBTITLE_EMPTY，
        // 队列长度与 exports/ 都和 M41 的另外两条拒绝一样一动不动。
        const preflight = await preflightBurn({
          doc: current.doc,
          projectDir: project.dir,
          src: feasible.src,
          file: feasible.file,
          cues: feasible.cues,
          ranges: parsed.ranges,
          range: parsed.range,
          size: parsed.size,
          fit: parsed.fit,
          fps: parsed.fps,
        });
        if (preflight.ok !== true) {
          sendJson(res, 400, { ok: false, code: preflight.code, message: preflight.message });
          return;
        }
        burnInput = {
          subtitleBurn: true,
          subtitleSrc: feasible.src,
          subtitleFile: feasible.file,
          subtitleCues: feasible.cues,
        };
      }
      const started = exportJobs.start({
        projectId: body.projectId,
        projectDir: project.dir,
        doc: clipExport?.snapshot.doc ?? current.doc,
        range: clipExport?.range ?? parsed.range,
        ranges: parsed.ranges,
        quality: parsed.quality,
        codec: parsed.codec,
        ...(parsed.outDir === null ? {} : { outDir: parsed.outDir }),
        ...(outPath === null ? {} : { outPath }),
        ...(parsed.size === null ? {} : { size: parsed.size }),
        ...(parsed.fit === null ? {} : { fit: parsed.fit }),
        ...(parsed.fps === null ? {} : { fps: parsed.fps }),
        ...burnInput,
        ...(clipExport === null ? {} : { clipId: parsed.clipId, filmSnapshot: clipExport.snapshot }),
        // M78：导出快照里记序列（spec.json 与作业快照都能对上）。
        sequence: target.sequence,
        docHash: target.hash,
      });
      if (started.ok !== true) {
        // 输出被占（M37）：作业句柄的跨进程锁给出 EXPORT_OUTPUT_BUSY，带持有者 pid/jobId。
        sendJson(res, 409, started);
        return;
      }
      // 202：已入队（state 可能是 queued 也可能是 running，看队里有没有人）。
      // `plan` 只在多段时出现（A1 的判据）：单段/整片的 202 形状与 R19 一字不差。
      sendJson(res, 202, {
        ok: true,
        job: started.job,
        queue: exportJobs.summary(),
        poll: `/api/export/${started.job.id}`,
        ...(planPreview === null ? {} : { plan: planPreview }),
      });
      return;
    }

    const exportRoute = /^\/api\/export\/([^/]+)$/.exec(path);
    if (exportRoute !== null) {
      const jobId = decodeURIComponent(/** @type {string} */ (exportRoute[1]));
      if (method === 'GET' || method === 'HEAD') {
        const job = exportJobs.status(jobId);
        if (job === null) {
          sendJson(res, 404, { ok: false, code: 'EXPORT_NOT_FOUND', message: `unknown export job: ${jobId}` });
          return;
        }
        sendJson(res, 200, { ok: true, job });
        return;
      }
      if (method === 'DELETE') {
        const job = exportJobs.cancel(jobId);
        if (job === null) {
          sendJson(res, 404, { ok: false, code: 'EXPORT_NOT_FOUND', message: `unknown export job: ${jobId}` });
          return;
        }
        sendJson(res, 200, { ok: true, job });
        return;
      }
      res.setHeader('Allow', 'GET, HEAD, DELETE, OPTIONS');
      sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', allowed: ['GET', 'HEAD', 'DELETE'] });
      return;
    }

    if (path === '/api/projects' && (method === 'GET' || method === 'HEAD')) {
      const root = url.searchParams.get('root') ?? options.projectsRoot;
      const listed = await registry.list(root ?? process.cwd());
      /* M56：`recent` 是跨会话的最近工程（`~/.opencut/projects.json`）。
         索引坏了不影响列表：corrupt 单独回一个字段，UI 可以提示但不阻断。
         `missing` 表示 film.html 不在了（目录被删/移动）——只标记，不自动移除。 */
      const recent = await readProjectIndex({ home: options.home }).catch(() => ({
        projects: /** @type {any[]} */ ([]),
        corrupt: true,
      }));
      const recentItems = await Promise.all(
        recent.projects.map(async (item) => ({
          ...item,
          missing: !existsSync(join(item.path, 'film.html')),
        })),
      );
      sendJson(res, listed.ok ? 200 : 404, {
        ...listed,
        recent: recentItems,
        recentCorrupt: recent.corrupt,
      });
      return;
    }

    /* M56-B：从「最近」里移除一条（只改索引，不删磁盘）。 */
    if (path === '/api/projects/recent/remove') {
      if (!requireMethod(method, res, ['POST'])) return;
      const body = await readJson(req, res);
      if (body === INVALID) return;
      const target = typeof body?.path === 'string' ? body.path : '';
      if (target.trim() === '') {
        sendJson(res, 400, { ok: false, code: 'PROJECT_INDEX_INVALID_ENTRY', message: 'path 不能为空' });
        return;
      }
      const removed = await removeProjectEntry(target, { home: options.home });
      sendJson(res, removed.ok ? 200 : 500, removed);
      return;
    }

    const navigationRoute = /^\/api\/projects\/([^/]+)\/agent\/project-navigation$/.exec(path);
    /** @type {ReturnType<typeof grants.get>} */
    let navigationGrant = null;
    /** @type {Array<{ projectId: string, name: string, path: string }>} */
    let navigationProjects = [];
    if (navigationRoute !== null) {
      if (!requireMethod(method, res, ['GET', 'POST'])) return;
      const sourceId = decodeURIComponent(navigationRoute[1] ?? '');
      const grantHeader = req.headers['x-opencut-agent-grant'];
      const grantId = typeof grantHeader === 'string' ? grantHeader : '';
      const issued = grants.get(grantId);
      const entry = registry.get(sourceId);
      if (issued !== null && (!entry || acpAgent.sessionState(issued.sessionId)?.alive !== true)) {
        sendJson(res, 403, { ok: false, code: 'SESSION_CLOSED', message: '项目导航需要仍在运行的 Agent 会话' });
        return;
      }
      const verdict = grants.authorize(grantId, {
        projectId: sourceId,
        projectPath: String(entry?.dir ?? ''),
        tool: method === 'POST' ? 'project_open' : 'project_navigation_list',
        requestId: issued === null ? null : acpAgent.turnOf(issued.sessionId),
      });
      if (!verdict.ok) {
        sendJson(res, 403, { ...verdict, message: '项目导航授权不通过' });
        return;
      }
      navigationGrant = verdict.grant;
      const incomingIndex = await readProjectIndex({ home: options.home }).catch(() => ({ projects: [] }));
      const listed = await registry.list(options.projectsRoot ?? process.cwd());
      const known = new Map();
      for (const item of [...incomingIndex.projects, ...registry.summaries(), ...(listed.ok ? listed.projects : [])]) {
        const projectDir = canonicalProjectDirectory(item.path);
        const projectId = projectIdFor(projectDir);
        if (known.has(projectId) || !existsSync(join(projectDir, 'film.html'))) continue;
        known.set(projectId, { projectId, name: item.name, path: projectDir });
      }
      navigationProjects = [...known.values()];
      if (method === 'GET') {
        sendJson(res, 200, { ok: true, projects: navigationProjects });
        return;
      }
    }

    if (path === '/api/projects/open' || navigationGrant !== null) {
      if (!requireMethod(method, res, ['POST'])) return;
      const body = await readJson(req, res);
      if (body === INVALID) return;
      // 合同里写的是 `{ dir }`；`path` 是旧调用方，两个都收，行为一致。
      let target =
        typeof body?.dir === 'string' ? body.dir : typeof body?.path === 'string' ? body.path : '';
      /* M78：可选 `sequence`。不传 = 索引里的 current（旧工程就是 main）；传了 = 打开该序列并把 current 更新。 */
      const sequenceArg = navigationGrant === null ? body?.sequence : undefined;
      if (navigationGrant !== null) {
        if (body?.confirm !== true) {
          sendJson(res, 400, { ok: false, code: 'E_CONFIRM_REQUIRED', message: '打开项目需要明确确认' });
          return;
        }
        const match = navigationProjects.find((project) => project.projectId === body?.projectId);
        if (match === undefined) {
          sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: '项目未在可打开目录中找到，请使用列表返回的项目 ID' });
          return;
        }
        target = match.path;
      }
      if (sequenceArg !== undefined && sequenceArg !== null && typeof sequenceArg !== 'string') {
        sendJson(res, 400, { ok: false, code: 'SEQUENCE_NAME_INVALID', message: 'sequence 必须是字符串', field: 'sequence' });
        return;
      }
      const opened = await registry.open(target, {
        ...(typeof sequenceArg === 'string' && sequenceArg !== '' ? { sequence: sequenceArg } : {}),
      });
      if (opened.ok !== true) {
        sendJson(res, Number(opened.status) || statusForCode(opened.code), opened);
        return;
      }
      const summary = registry.summary(opened.projectId ?? opened.project.projectId);
      if (navigationGrant !== null && (summary === null || summary.projectId !== body?.projectId)) {
        sendJson(res, 409, { ok: false, code: 'PROJECT_MISMATCH', message: '项目路径已变化，请刷新项目列表' });
        return;
      }
      /* M56：打开成功才写「最近工程」；写索引失败不能把打开本身弄失败。 */
      if (summary !== null) {
        await recordProjectOpen({ path: summary.path, name: summary.name }, { home: options.home }).catch(
          () => undefined,
        );
        /* M57 封面：抽帧要读素材、跑 ffmpeg，不能挡着打开响应。生成完再回写索引；
           任何一步失败就保持没有封面（列表画占位块），不冒泡成 500。 */
        void ensureProjectCover({
          project: opened.project,
          projectPath: summary.path,
          home: options.home,
        })
          .then((cover) => (cover === null ? null : setProjectCover(summary.path, cover, { home: options.home })))
          .catch(() => undefined);
      }
      if (navigationGrant !== null && summary !== null) {
        if (acpAgent.turnOf(navigationGrant.sessionId) !== navigationGrant.requestId) {
          sendJson(res, 403, { ok: false, code: 'REQUEST_MISMATCH', message: '请求已结束，未切换桌面标签' });
          return;
        }
        hub.publish({ type: 'agent.projectOpen', projectId: navigationGrant.projectId, targetProjectId: summary.projectId });
        sendJson(res, 200, { ok: true, project: summary, navigationRequested: true });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        existing: opened.existing,
        project: summary,
        thumbnails: summary === null ? null : registry.thumbnails(summary.projectId),
        // M78：序列信息与索引落盘情况（不传 sequence 时不写索引，`written:false`）。
        ...(summary?.sequence === undefined ? {} : { sequence: summary.sequence }),
        ...(opened.index === undefined ? {} : { index: opened.index }),
      });
      return;
    }

    if (path === '/api/projects/import') {
      if (!requireMethod(method, res, ['POST'])) return;
      const body = await readJson(req, res);
      if (body === INVALID) return;
      const zipPath = typeof body?.zipPath === 'string' ? resolve(body.zipPath) : '';
      if (zipPath === '') {
        sendJson(res, 400, { ok: false, code: 'IMPORT_INVALID', message: '需要 zipPath（工程包的绝对路径）' });
        return;
      }
      // 包里的工程名决定默认目录；重名不覆盖，追加 -2、-3……
      const peek = await readProjectArchive(zipPath).catch(() => null);
      const peekName = peek?.ok === true ? peek.manifest?.name : null;
      const baseName = typeof peekName === 'string' && peekName !== '' ? peekName : basename(zipPath, '.zip');
      const root = options.projectsRoot ?? dirname(zipPath);
      let target = typeof body?.dir === 'string' && body.dir !== '' ? resolve(body.dir) : join(root, baseName);
      if (typeof body?.dir !== 'string' || body.dir === '') {
        for (let i = 2; i < 100; i += 1) {
          if (!(await fsp.stat(target).then(() => true).catch(() => false))) break;
          target = join(root, `${baseName}-${String(i)}`);
        }
      }
      const extracted = await extractProjectArchive(zipPath, target);
      if (extracted.ok !== true) {
        sendJson(res, 400, extracted);
        return;
      }
      const opened = await registry.open(target);
      if (opened.ok !== true) {
        // 包解出来了但打不开：把原因连同目录一起回，别让人以为包是坏的。
        sendJson(res, 422, { ...opened, dir: target, files: extracted.files });
        return;
      }
      const summary = registry.summary(opened.project.projectId);
      sendJson(res, 200, {
        ok: true,
        dir: target,
        files: extracted.files,
        // 清单对不上照样解出来（数据比一致性重要），但必须逐条报出来。
        mismatch: extracted.mismatch,
        extra: extracted.extra,
        project: summary,
      });
      return;
    }

    if (path === '/api/projects/close') {
      if (!requireMethod(method, res, ['POST'])) return;
      const body = await readJson(req, res);
      if (body === INVALID) return;
      const projectId = typeof body?.projectId === 'string' ? body.projectId : '';
      const waitMs = Number.isFinite(body?.waitMs) ? Number(body.waitMs) : undefined;
      const closed = await registry.close(projectId, { waitMs });
      sendJson(res, closed.ok ? 200 : 404, closed);
      return;
    }

    // /api/motion/library?project=<id>[&includeArchived=1&clip=<clipId>]（M27/M30）：
    // 工程内 motion/library.json → 面板要的 MotionEntryView[] + 管理视图（版本号/旧版本数/归档）。
    // 没有库文件不是错误：{ok:true, entries:[], missing:true}，面板显示空库 + 重试。
    if (path === '/api/motion/library' && (method === 'GET' || method === 'HEAD')) {
      const projectId = url.searchParams.get('project') ?? '';
      const project = registry.get(projectId);
      if (project === null) {
        sendJson(res, 404, { ok: false, code: 'FILM_NOT_FOUND', message: `工程未打开：${projectId}` });
        return;
      }
      const includeArchived = url.searchParams.get('includeArchived') === '1';
      const clipId = url.searchParams.get('clip') ?? '';
      const current = registry.docOf(projectId);
      const clipProps = clipId === '' || current === null ? null : clipPropsOf(current.doc, clipId);
      const view = await libraryView(project.dir, { includeArchived, clipProps });
      sendJson(res, view.ok === true ? 200 : 500, {
        ok: view.ok,
        projectId,
        entries: view.entries,
        all: view.all,
        includeArchived,
        clipId,
        // 回填命中：这个片段当前挂的就是库里的某个模板（UI 用来说明「参数来自实例」）。
        current: clipProps === null ? null : { template: clipProps.template, values: clipProps.values },
        missing: view.exists !== true,
        corrupt: view.corrupt,
        ...(view.error ? { code: view.error.code, message: view.error.message } : {}),
      });
      return;
    }

    // 模板管理（M30）：另存 / 升级 / 回退 / 归档。写盘只有这一处（引擎的原子写），
    // 应用参数仍然走 /ops（一步撤销）——两条路不混。
    if (path.startsWith('/api/motion/') && method === 'POST') {
      const action = path.slice('/api/motion/'.length);
      if (action === 'save' || action === 'upgrade' || action === 'rollback' || action === 'archive') {
        const body = await readJson(req, res);
        if (body === INVALID) return;
        const projectId = typeof body?.projectId === 'string' ? body.projectId : (url.searchParams.get('project') ?? '');
        const project = registry.get(projectId);
        const current = registry.docOf(projectId);
        if (project === null || current === null) {
          sendJson(res, 404, { ok: false, code: 'FILM_NOT_FOUND', message: `工程未打开：${projectId}` });
          return;
        }
        const result =
          action === 'save'
            ? await planMotionSave({ project, doc: current.doc, clipId: body?.clipId, name: body?.name, kind: body?.kind })
            : action === 'upgrade'
              ? await planMotionUpgrade({ project, entryId: body?.entryId })
              : action === 'rollback'
                ? await planMotionRollback({ project, entryId: body?.entryId })
                : await planMotionArchive({ project, doc: current.doc, entryId: body?.entryId });
        // 400：校验/冲突（INVALID_NAME、NAME_TAKEN、TEMPLATE_IN_USE…）
        sendJson(res, result.ok === true ? 200 : 400, result);
        return;
      }
    }

    // /api/motion/apply（M27）：校验 + 规划成一批 props Op，**不写盘**（写盘只走宿主的 /ops）。
    if (path === '/api/motion/apply' && method === 'POST') {
      const body = await readJson(req, res);
      if (body === INVALID) return;
      const projectId = typeof body?.projectId === 'string' ? body.projectId : (url.searchParams.get('project') ?? '');
      const project = registry.get(projectId);
      const current = registry.docOf(projectId);
      if (project === null || current === null) {
        sendJson(res, 404, { ok: false, code: 'FILM_NOT_FOUND', message: `工程未打开：${projectId}` });
        return;
      }
      const planned = await planMotionApply({
        project,
        doc: current.doc,
        clipId: body?.clipId,
        entryId: body?.entryId,
        params: body?.params,
      });
      sendJson(res, planned.ok === true ? 200 : 400, planned);
      return;
    }

    if ((path === '/' || path === '/index.html') && (method === 'GET' || method === 'HEAD')) {
      serveIndex(res, method);
      return;
    }

    // 构建产物：/assets/<hash>.js|css…；只从 dist/assets 下取，路径逃逸一律 404。
    if (path.startsWith('/assets/') && (method === 'GET' || method === 'HEAD')) {
      serveAsset(res, method, path);
      return;
    }

    // /api/projects/:id/assets[...]（M20 素材库）
    const assetsRoute = /^\/api\/projects\/([^/]+)\/assets(?:\/(.+))?$/.exec(path);
    if (assetsRoute !== null) {
      const projectId = decodeURIComponent(/** @type {string} */ (assetsRoute[1]));
      const rest = assetsRoute[2] ?? '';
      const project = registry.get(projectId);
      if (project === null) {
        sendJson(res, 404, { ok: false, code: 'FILM_NOT_FOUND', message: '工程未打开：先 /api/projects/open' });
        return;
      }
      if (rest === '') {
        if (method !== 'GET' && method !== 'HEAD') {
          sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', allowed: ['GET', 'HEAD'] });
          return;
        }
        const assets = await listAssets({ project });
        sendJson(res, 200, { ok: true, assets });
        return;
      }
      const thumbMatch = /^(.+)\/thumb$/.exec(rest);
      if (thumbMatch !== null) {
        if (method !== 'GET' && method !== 'HEAD') {
          sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', allowed: ['GET', 'HEAD'] });
          return;
        }
        let name = '';
        try {
          name = decodeURIComponent(/** @type {string} */ (thumbMatch[1]));
        } catch {
          sendJson(res, 400, { ok: false, code: 'ASSET_NAME_INVALID', message: '素材名不是合法的 URL 编码' });
          return;
        }
        const thumb = await thumbOf({ project, name });
        if (thumb.ok !== true) {
          sendJson(res, thumb.status, { ok: false, code: thumb.code, message: thumb.message });
          return;
        }
        const buffer = await fsp.readFile(thumb.path);
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': String(buffer.byteLength),
          'cache-control': 'public, max-age=31536000, immutable',
          'x-opencut-thumb': thumb.cached ? 'hit' : 'miss',
        });
        res.end(method === 'HEAD' ? undefined : buffer);
        return;
      }
      const insertMatch = /^(.+)\/insert$/.exec(rest);
      if (insertMatch !== null && method === 'POST') {
        let name = '';
        try {
          name = decodeURIComponent(/** @type {string} */ (insertMatch[1]));
        } catch {
          sendJson(res, 400, { ok: false, code: 'ASSET_NAME_INVALID', message: '素材名不是合法的 URL 编码' });
          return;
        }
        const body = await readJson(req, res);
        if (body === INVALID) return;
        const current = registry.docOf(projectId);
        if (current === null) {
          sendJson(res, 404, { ok: false, code: 'FILM_NOT_FOUND', message: '工程未打开：先 /api/projects/open' });
          return;
        }
        const inserted = await insertExistingAsset({
          registry,
          project,
          doc: current.doc,
          name,
          at: body?.at,
          track: body?.track,
          ripple: body?.ripple === true,
        });
        if (inserted.ok !== true) {
          sendJson(res, inserted.status, { ok: false, code: inserted.code, message: inserted.message });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          hash: inserted.hash,
          clipId: inserted.clipId,
          assetPath: inserted.assetPath,
          kind: inserted.kind,
          bytes: inserted.bytes,
          at: inserted.at,
          shifted: inserted.shifted ?? 0,
        });
        return;
      }
      sendJson(res, 404, { ok: false, code: 'ASSET_ROUTE_UNKNOWN', message: `未知素材路由：${path}` });
      return;
    }

    // /api/projects/:id/versions[/:sha/(diff|restore|restore-film)]（M62）
    // 单独一条正则：sha 是十六进制，projectRoute 的后缀只收小写字母，接不住数字。
    const versionsRoute = /^\/api\/projects\/([^/]+)\/versions(?:\/([0-9a-f]{7,40})\/(diff|restore|restore-film))?$/.exec(
      path,
    );
    if (versionsRoute !== null) {
      const projectId = decodeURIComponent(/** @type {string} */ (versionsRoute[1]));
      const sha = versionsRoute[2] ?? null;
      const action = versionsRoute[3] ?? null;
      const project = registry.get(projectId);
      if (project === null) {
        sendJson(res, 404, { ok: false, code: 'FILM_NOT_FOUND', message: '工程未打开' });
        return;
      }
      try {
        if (sha === null && (method === 'GET' || method === 'HEAD')) {
          sendJson(res, 200, { ok: true, ...(await listVersions(project.dir)) });
          return;
        }
        if (sha === null && method === 'POST') {
          const body = await readJson(req, res);
          if (body === INVALID) return;
          sendJson(res, 201, await createVersion(project.dir, { name: body?.name, message: body?.message }));
          return;
        }
        if (sha !== null && action === 'diff' && (method === 'GET' || method === 'HEAD')) {
          sendJson(res, 200, await diffVersion(project.dir, sha));
          return;
        }
        if (sha !== null && action === 'restore' && method === 'POST') {
          const body = await readJson(req, res);
          if (body === INVALID) return;
          sendJson(
            res,
            200,
            await restoreVersion(project.dir, sha, {
              files: Array.isArray(body?.files) ? body.files : null,
              force: body?.force === true,
            }),
          );
          return;
        }
        if (sha !== null && action === 'restore-film' && method === 'POST') {
          const body = await readJson(req, res);
          if (body === INVALID) return;
          sendJson(res, 200, await restoreFilm(project.dir, sha, { force: body?.force === true }));
          return;
        }
        res.setHeader('Allow', 'GET, HEAD, POST');
        sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
        return;
      } catch (error) {
        if (error instanceof VersionsError) {
          sendJson(res, error.status, { ok: false, code: error.code, message: error.message, ...error.extra });
          return;
        }
        sendJson(res, 500, {
          ok: false,
          code: 'VERSIONS_FAILED',
          message: String(/** @type {any} */ (error)?.message ?? error),
        });
        return;
      }
    }

    /* ── 新建工程（M75 · WP01）：M73 脚本的「自己落盘」换成这一条 ─────────── */
    if (path === '/api/projects/create') {
      if (!requireMethod(method, res, ['POST'])) return;
      const body = await readJson(req, res);
      if (body === INVALID) return;
      const unknown = Object.keys(body ?? {}).filter((key) => !CREATE_REQUEST_FIELDS.includes(key));
      if (unknown.length > 0) {
        sendJson(res, 400, {
          ok: false,
          code: 'UNKNOWN_FIELD',
          message: `不认识的字段：${unknown.join(',')}（可用 ${CREATE_REQUEST_FIELDS.join('/')}）`,
          fields: unknown,
        });
        return;
      }
      try {
        const created = await createProject({
          name: body?.name,
          dir: body?.dir,
          template: body?.template,
          // 允许根：projectsRoot（与 GET /api/projects 的默认 root 同一处），没配就是 cwd。
          root: options.projectsRoot ?? process.cwd(),
          home: options.home,
        });
        sendJson(res, 201, created);
      } catch (error) {
        if (error instanceof ProjectCreateError) {
          sendJson(res, error.status, {
            ok: false,
            code: error.code,
            message: error.message,
            ...(error.field === null ? {} : { field: error.field }),
            ...error.extra,
          });
          return;
        }
        sendJson(res, 500, {
          ok: false,
          code: 'PROJECT_CREATE_FAILED',
          message: String(/** @type {any} */ (error)?.message ?? error),
        });
      }
      return;
    }

    /* ── 源升级后的覆盖重定位（M76 · WP16）：只写 film.html，不复制源 ────── */
    const reimportRoute = /^\/api\/projects\/([^/]+)\/media\/([^/]+)\/reimport$/.exec(path);
    if (reimportRoute !== null) {
      if (!requireMethod(method, res, ['POST'])) return;
      let projectId = '';
      let assetId = '';
      try {
        projectId = decodeURIComponent(/** @type {string} */ (reimportRoute[1]));
        assetId = decodeURIComponent(/** @type {string} */ (reimportRoute[2]));
      } catch {
        sendJson(res, 400, { ok: false, code: 'ASSET_ID_INVALID', message: '路径不是合法的 URL 编码' });
        return;
      }
      const body = await readJson(req, res);
      if (body === INVALID) return;
      const unknown = Object.keys(body ?? {}).filter((key) => !REIMPORT_REQUEST_FIELDS.includes(key));
      if (unknown.length > 0) {
        sendJson(res, 400, {
          ok: false,
          code: 'UNKNOWN_FIELD',
          message: `不认识的字段：${unknown.join(',')}（可用 ${REIMPORT_REQUEST_FIELDS.join('/')}）`,
          fields: unknown,
        });
        return;
      }
      const project = registry.get(projectId);
      const current = registry.docOf(projectId);
      if (project === null || current === null) {
        sendJson(res, 404, { ok: false, code: 'FILM_NOT_FOUND', message: '工程未打开：先 /api/projects/open' });
        return;
      }
      const result = await reimportSourceAsset({
        registry,
        project,
        doc: current.doc,
        assetId,
        sourceFile: body?.sourceFile,
        expectedHash: body?.expectedHash,
      });
      const { status: failureStatus, ...payload } = /** @type {any} */ (result);
      sendJson(res, result.ok === true ? 200 : Number(failureStatus) || 500, payload);
      return;
    }

    /* ── 多序列（M78 · WP26 第一阶段）───────────────────────────────────
     * GET    /api/projects/:id/sequences            列表（懒创建：旧工程不落盘）
     * POST   /api/projects/:id/sequences            新建（原子写，同名 409）
     * PUT    /api/projects/:id/sequences/current    切 current（**只写索引**）
     * DELETE /api/projects/:id/sequences/:sid       删除（非当前/非 main；目录移 .film/trash）
     */
    const sequencesRoute = /^\/api\/projects\/([^/]+)\/sequences(?:\/([^/]+))?$/.exec(path);
    if (sequencesRoute !== null) {
      const projectId = decodeURIComponent(/** @type {string} */ (sequencesRoute[1]));
      const sub = sequencesRoute[2] === undefined ? '' : decodeURIComponent(/** @type {string} */ (sequencesRoute[2]));
      const projectDir = await registry.projectDirOf(projectId);
      if (projectDir === null) {
        sendJson(res, 404, { ok: false, code: 'FILM_NOT_FOUND', message: `工程未知：${projectId}` });
        return;
      }
      /** @param {any} error */
      const fail = (error) => {
        if (error instanceof SequenceError) {
          sendJson(res, error.status, {
            ok: false,
            code: error.code,
            message: error.message,
            ...(error.field === null ? {} : { field: error.field }),
            ...error.extra,
          });
          return;
        }
        sendJson(res, 500, { ok: false, code: 'SEQUENCES_FAILED', message: String(/** @type {any} */ (error)?.message ?? error) });
      };

      if (sub === '' && (method === 'GET' || method === 'HEAD')) {
        try {
          sendJson(res, 200, await listSequences(projectDir));
        } catch (error) {
          fail(error);
        }
        return;
      }
      if (sub === '' && method === 'POST') {
        const body = await readJson(req, res);
        if (body === INVALID) return;
        const unknown = Object.keys(body ?? {}).filter((key) => !SEQUENCE_REQUEST_FIELDS.includes(key));
        if (unknown.length > 0) {
          sendJson(res, 400, {
            ok: false,
            code: 'UNKNOWN_FIELD',
            message: `未知字段：${unknown.join(',')}（只接受 ${SEQUENCE_REQUEST_FIELDS.join('/')}）`,
            fields: unknown,
          });
          return;
        }
        try {
          sendJson(res, 201, await createSequence({ projectDir, name: body?.name, stage: body?.stage }));
        } catch (error) {
          fail(error);
        }
        return;
      }
      if (sub === 'current' && (method === 'PUT' || method === 'POST')) {
        const body = await readJson(req, res);
        if (body === INVALID) return;
        try {
          const result = await setCurrentSequence(projectDir, body?.id);
          /* 工程开着才把 `P` 指到新 current：先把这个序列的条目打开（只读，不碰 film.html），
             否则 `GET /api/projects/:id` 会在切换后突然 404。没开过的工程只改索引。 */
          if (registry.entryIdsOf(projectId).length > 0) {
            await registry.getAsync(`${projectId}::${result.current}`);
          }
          registry.markActive(projectId, String(result.current));
          sendJson(res, 200, result);
        } catch (error) {
          fail(error);
        }
        return;
      }
      if (sub !== '' && sub !== 'current' && method === 'DELETE') {
        try {
          const result = await removeSequence(projectDir, sub);
          // 目录已经搬进 .film/trash：把这个序列的条目放掉（watcher/队列不留在空路径上）。
          await registry.close(`${projectId}::${sub}`).catch(() => undefined);
          sendJson(res, 200, result);
        } catch (error) {
          fail(error);
        }
        return;
      }
      sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: `${method} 不支持这个序列路由` });
      return;
    }

    /* F08 会话列表（R28 · R29-073）：`/api/projects/:id/agent/sessions[/:sid]`。
       sid 是 `s` + base36（含数字），所以不能用下面那条只允许小写字母的后缀正则，单独一条。
       不做 UI、不动 film-core：这里只碰 `.film/chat/`。 */
    const sessionsRoute = /^\/api\/projects\/([^/]+)\/agent\/sessions(?:\/([A-Za-z0-9_-]+))?$/.exec(path);
    if (sessionsRoute !== null) {
      const projectId = decodeURIComponent(/** @type {string} */ (sessionsRoute[1]));
      const sid = sessionsRoute[2] ?? '';
      const project = registry.get(projectId);
      if (project === null) {
        sendJson(res, 404, { ok: false, code: 'FILM_NOT_FOUND', message: '工程未打开：先 /api/projects/open' });
        return;
      }
      const store = createSessionsStore({ project });
      if (sid === '') {
        if (method === 'GET' || method === 'HEAD') {
          /* R114-B2：默认口径不变（归档不出现）；`?includeArchived=1` 连归档一起给。 */
          const listed = await store.list({ includeArchived: url.searchParams.get('includeArchived') === '1' });
          if (listed.ok === true) {
            sendJson(res, 200, listed);
            return;
          }
          sendJson(res, listed.code === 'CHAT_CORRUPT' || listed.code === 'CHAT_UNREADABLE' ? 500 : 400, listed);
          return;
        }
        if (method === 'POST') {
          const body = await readJson(req, res);
          if (body === INVALID) return;
          const unknown = Object.keys(body ?? {}).filter((key) => key !== 'title');
          if (unknown.length > 0) {
            sendJson(res, 400, { ok: false, code: 'UNKNOWN_FIELD', field: unknown[0], message: `未知字段：${unknown.join('/')}（请求体只接受 { title }）` });
            return;
          }
          if (body?.title !== undefined && typeof body.title !== 'string') {
            sendJson(res, 400, { ok: false, code: 'TITLE_INVALID', field: 'title', message: 'title 必须是字符串' });
            return;
          }
          const created = await store.create({ title: body?.title });
          if (created.ok !== true) {
            sendJson(res, created.code === 'CHAT_WRITE_FAILED' ? 500 : 400, created);
            return;
          }
          /* 201 = 真新建；200 = 已有空会话原样返回（参照「已是新对话就只聚焦」）。 */
          sendJson(res, created.created === true ? 201 : 200, { ok: true, created: created.created, session: created.session, last: created.doc.last });
          return;
        }
        sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: `${method} 不支持会话列表路由` });
        return;
      }
      /* R114-B2：改名 / 置顶 / 归档-恢复（契约见 ANSWER-SUB2-R114-DEPS §2.3）。
         只认 title|pinned|archived 三个键；归档不删回合文件，`archived:false` 就是恢复。
         运行中不许归档：`agentScene` 记着在途 draft 的会话，回 409 SESSION_RUNNING
         （UI 给提示，不硬失败 —— 也不替用户中断生成）。 */
      if (method === 'PATCH') {
        if (SESSION_ID_RE.test(sid) !== true) {
          sendJson(res, 400, { ok: false, code: 'SESSION_ID_INVALID', message: `会话 id 不合法：${sid}` });
          return;
        }
        const body = await readJson(req, res);
        if (body === INVALID) return;
        const plain = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : null;
        if (plain === null) {
          sendJson(res, 400, { ok: false, code: 'BAD_REQUEST', message: '请求体必须是 JSON 对象' });
          return;
        }
        const patchFields = ['title', 'pinned', 'archived'];
        const unknown = Object.keys(plain).filter((key) => !patchFields.includes(key));
        if (unknown.length > 0) {
          sendJson(res, 400, {
            ok: false,
            code: 'UNKNOWN_FIELD',
            field: unknown[0],
            allowed: patchFields,
            message: `未知字段：${unknown[0]}（只接受 ${patchFields.join(' / ')}）`,
          });
          return;
        }
        if (plain.archived === true && agentScene.isSessionRunning(sid)) {
          sendJson(res, 409, {
            ok: false,
            code: 'SESSION_RUNNING',
            message: '这条会话还在生成，先等它跑完再归档',
          });
          return;
        }
        const updated = await store.update(sid, plain);
        if (updated.ok === true) {
          sendJson(res, 200, { ok: true, session: updated.session, last: updated.last });
          return;
        }
        const status =
          updated.code === 'SESSION_NOT_FOUND'
            ? 404
            : updated.code === 'CHAT_WRITE_FAILED' || updated.code === 'CHAT_CORRUPT' || updated.code === 'CHAT_UNREADABLE'
              ? 500
              : 400;
        sendJson(res, status, updated);
        return;
      }
      if (method === 'GET' || method === 'HEAD') {
        if (SESSION_ID_RE.test(sid) !== true) {
          sendJson(res, 400, { ok: false, code: 'SESSION_ID_INVALID', message: `会话 id 不合法：${sid}` });
          return;
        }
        const opened = await store.get(sid);
        if (opened.ok === true) {
          sendJson(res, 200, opened);
          return;
        }
        sendJson(res, opened.code === 'SESSION_NOT_FOUND' ? 404 : 500, opened);
        return;
      }
      sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: `${method} 不支持单条会话路由` });
      return;
    }

    // /api/projects/:id[...]（后缀允许小写字母、`-` 与 `/`：media-status / relink/scan）
    const projectRoute = /^\/api\/projects\/([^/]+)(\/[a-z/-]*)?$/.exec(path);
    if (projectRoute !== null) {
      const projectId = decodeURIComponent(/** @type {string} */ (projectRoute[1]));
      const suffix = projectRoute[2] ?? '';
      if (suffix === '' && (method === 'GET' || method === 'HEAD')) {
        const summary = registry.summary(projectId);
        if (summary === null) {
          sendJson(res, 404, { ok: false, code: 'FILM_NOT_FOUND', message: '工程未打开' });
          return;
        }
        sendJson(res, 200, { ok: true, project: summary, thumbnails: registry.thumbnails(projectId) });
        return;
      }
      if (suffix === '/derived' && (method === 'GET' || method === 'HEAD')) {
        // R21：时间线胶片条的服务端抽帧（`?what=frame&rel=&ms=&w=`）。
        // 页片段 415（页帧由前端走无头浏览器画）；缓存 `.film/cache/frames/`，命中字节完全相同。
        const project = registry.get(projectId);
        if (project === null) {
          sendJson(res, 404, { ok: false, code: 'FILM_NOT_FOUND', message: '工程未打开：先 /api/projects/open' });
          return;
        }
        const derived = await frameOf({
          project,
          what: url.searchParams.get('what'),
          rel: url.searchParams.get('rel'),
          ms: url.searchParams.get('ms'),
          w: url.searchParams.get('w'),
        });
        if (derived.ok !== true) {
          sendJson(res, derived.status, { ok: false, code: derived.code, message: derived.message });
          return;
        }
        log(`DERIVED_FRAME rel=${derived.rel} ms=${String(derived.ms)} w=${String(derived.width)} cache=${derived.cached ? 'hit' : 'miss'}`);
        const buffer = await fsp.readFile(derived.path);
        res.writeHead(200, {
          'content-type': derived.contentType,
          'content-length': String(buffer.byteLength),
          // 缓存键里含源文件 mtime：源不动这张图就不动，可以按私有长缓存发。
          'cache-control': 'private, max-age=86400',
          'x-opencut-frame': derived.cached ? 'hit' : 'miss',
          // 实际切的时刻可能被末尾容差夹过（请求 2999ms → 实际 2960ms），回给调用方，别让它猜。
          'x-opencut-frame-ms': String(derived.ms),
          'x-opencut-frame-w': String(derived.width),
        });
        res.end(method === 'HEAD' ? undefined : buffer);
        return;
      }
      if (suffix === '/doc' && (method === 'GET' || method === 'HEAD')) {
        // M78：`P::<seq>` 还没打开时先开（序列作用域 id 不该要求调用方先 open 一次）。
        const current = await registry.docOfAsync(projectId);
        if (current === null) {
          sendJson(res, 404, { ok: false, code: 'FILM_NOT_FOUND', message: '工程未打开' });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          doc: current.doc,
          hash: current.hash,
          undoDepth: current.undoDepth,
          redoDepth: current.redoDepth,
        });
        return;
      }
      if (suffix === '/move' && method === 'POST') {
        const body = await readJson(req, res);
        if (body === INVALID) return;
        try {
          const result = await projectMover.move(projectId, body?.targetDir);
          sendJson(res, result.status === 'moved' ? 200 : 500, result);
        } catch (error) {
          sendMoveError(res, error);
        }
        return;
      }
      if (suffix === '/archive' && method === 'POST') {
        const body = await readJson(req, res);
        if (body === INVALID) return;
        const summary = registry.summary(projectId);
        if (summary === null) {
          sendJson(res, 404, { ok: false, code: 'FILM_NOT_FOUND', message: '工程未打开' });
          return;
        }
        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
        const outPath =
          typeof body?.outPath === 'string' && body.outPath !== ''
            ? resolve(body.outPath)
            : join(summary.path, 'exports', `${summary.name}-${stamp}.zip`);
        const archived = await writeProjectArchive(summary.path, outPath, { name: summary.name });
        if (archived.ok !== true) {
          sendJson(res, 500, { ok: false, code: 'ARCHIVE_FAILED', message: '打包失败' });
          return;
        }
        sendJson(res, 200, archived);
        return;
      }
      if (suffix === '/view' && (method === 'PUT' || method === 'POST')) {
        const body = await readJson(req, res);
        if (body === INVALID) return;
        const applied = registry.setView(projectId, {
          playhead: body?.playhead,
          selection: body?.selection,
        });
        sendJson(res, applied.ok ? 200 : 404, applied);
        return;
      }
      if (suffix === '/cwd' && (method === 'PUT' || method === 'POST')) {
        const body = await readJson(req, res);
        if (body === INVALID) return;
        const applied = registry.setCwd(projectId, typeof body?.cwd === 'string' ? body.cwd : '');
        sendJson(res, applied.ok ? 200 : 404, applied);
        return;
      }
      if (suffix === '/clip-loudness' && method === 'POST') {
        const body = await readJson(req, res);
        if (body === INVALID) return;
        const { clipId, expectedHash, preset = 'streaming' } = body ?? {};
        if (typeof clipId !== 'string' || !clipId || /\s/.test(clipId) ||
            typeof expectedHash !== 'string' || !/^[0-9a-f]{64}$/.test(expectedHash) ||
            (preset !== 'streaming' && preset !== 'broadcast')) {
          sendJson(res, 400, { ok: false, code: 'INVALID', message: '需要片段 ID、当前版本和有效响度预设' });
          return;
        }
        const project = registry.get(projectId);
        const current = registry.docOf(projectId);
        if (!project || !current) {
          sendJson(res, 404, { ok: false, code: 'FILM_NOT_FOUND', message: '工程未打开' });
          return;
        }
        if (current.hash !== expectedHash) {
          sendJson(res, 409, { ok: false, code: 'CONFLICT', message: '工程已更新，请刷新后重试', currentHash: current.hash });
          return;
        }
        const exactId = project.projectId;
        if (loudnessActive.has(exactId)) {
          sendJson(res, 409, { ok: false, code: 'LOUDNESS_BUSY', message: '此序列正在测量片段响度' });
          return;
        }
        const disconnected = new AbortController();
        const signal = AbortSignal.any([disconnected.signal, AbortSignal.timeout(120_000)]);
        const onClose = () => disconnected.abort();
        res.once('close', onClose);
        loudnessActive.add(exactId);
        try {
          const planned = await planClipLoudness({ doc: current.doc, projectDir: project.dir, clipId, preset, signal });
          if (disconnected.signal.aborted) return;
          if (!planned.ok) {
            sendJson(res, planned.status, { ok: false, code: planned.code, message: planned.message });
            return;
          }
          if (signal.aborted) {
            sendJson(res, 408, { ok: false, code: 'CANCELLED', message: '响度测量已超时' });
            return;
          }
          const latest = rawRegistry.docOf(exactId);
          if (registry.get(projectId) !== project || latest?.hash !== expectedHash) {
            sendJson(res, 409, { ok: false, code: 'CONFLICT', message: '工程已更新，请刷新后重试', currentHash: latest?.hash });
            return;
          }
          // The editor commits this plan through /ops with this exact hash.
          sendJson(res, 200, { ...planned, hash: expectedHash });
        } finally {
          loudnessActive.delete(exactId);
          res.removeListener('close', onClose);
        }
        return;
      }
      if (suffix === '/ops' && method === 'POST') {
        /* CS2：受控写凭票。头里有票就必须核过；核不过直接 403，磁盘一个字节不动。
           没票的请求维持老语义（UI 人工编辑，`by` 由 owner 推）。

           CS3（MAIN-CS3-AUTHZ）：票要同时对上 **工程 / 真实目录 / 会话 / 当前回合**。
           requestId 不是从请求体拿的（agent 能改），而是从服务端 ACP 台账读当前 turnId —
           回合没开、回合已结束、会话已死，票都不生效。 */
        const grantHeader = req.headers['x-opencut-agent-grant'];
        /* 应用批准票与 ACP 工具票是两条链：拿错票直接拒，不静默忽略。 */
        if (typeof req.headers['x-opencut-apply-approval'] === 'string' && req.headers['x-opencut-apply-approval'] !== '') {
          sendJson(res, 403, {
            ok: false,
            code: 'APPLY_TICKET_NOT_FOR_OPS',
            message: '草稿应用批准票不能当 ACP 工具票用（两条授权链互不认可）',
          });
          return;
        }
        /** @type {{ grantId: string, sessionId: string, runId: string } | null} */
        let agent = null;
        if (typeof grantHeader === 'string' && grantHeader !== '') {
          const issued = grants.get(grantHeader);
          if (issued !== null) {
            const sessionState = acpAgent.sessionState(issued.sessionId);
            if (sessionState === null || sessionState.alive !== true) {
              sendJson(res, 403, {
                ok: false,
                code: 'SESSION_CLOSED',
                message: '这张票对应的 ACP 会话已经不在（票随会话失效）',
                grantId: issued.grantId,
              });
              return;
            }
          }
          const projectEntry = registry.get(projectId);
          const verdict = grants.authorize(grantHeader, {
            projectId,
            projectPath: projectEntry === null || projectEntry === undefined ? '' : String(projectEntry.dir ?? ''),
            tool: 'film_apply_ops',
            ...(issued === null ? {} : { sessionId: issued.sessionId }),
            requestId: issued === null ? null : acpAgent.turnOf(issued.sessionId),
          });
          if (verdict.ok !== true) {
            sendJson(res, 403, {
              ok: false,
              code: verdict.code,
              message: `受控写授权不通过：${verdict.code}`,
              grantId: verdict.grantId,
            });
            return;
          }
          agent = { grantId: verdict.grant.grantId, sessionId: verdict.grant.sessionId, runId: verdict.grant.runId };
        }
        const body = await readJson(req, res);
        if (body === INVALID) return;
        const invalid = validateEnvelope(body?.envelope, projectId);
        if (invalid !== null) {
          sendJson(res, 400, { ok: false, code: 'INVALID', message: invalid });
          return;
        }
        const opsProblem = validateOps(body?.ops);
        if (opsProblem !== null) {
          sendJson(res, 400, { ok: false, code: 'INVALID', message: opsProblem });
          return;
        }
        const envelope = body.envelope;
        const targetProblem = validateTarget(envelope.target);
        if (targetProblem !== null) {
          sendJson(res, 400, { ok: false, code: 'TARGET_MISMATCH', message: targetProblem });
          return;
        }
        const result = await registry.applyOps(
          projectId,
          {
            opId: envelope.opId,
            expectedHash: envelope.expectedHash,
            by: agent !== null || envelope.owner === 'SUB1' || envelope.owner === 'SUB2' ? 'agent' : 'person',
            ...(envelope.target === undefined ? {} : { target: envelope.target }),
          },
          body.ops,
        );
        sendEditResult(res, result === null || typeof result !== 'object' || result.ok !== true
          ? result
          : {
              ...result,
              ...(agent === null ? {} : { agent }),
              ...(envelope.target === undefined || envelope.target === null
                /* 老客户端：没带目标 → 放行，但**明说**守卫没参与（禁称「无条件保护」）。 */
                ? { guard: 'skipped', warn: 'NO_TARGET: 本次写入没有 envelope.target，元素守卫未参与（老客户端或片段级编辑）' }
                : { guard: 'checked' }),
            });
        return;
      }
      if ((suffix === '/undo' || suffix === '/redo') && method === 'POST') {
        const body = await readJson(req, res);
        if (body === INVALID) return;
        const expectedHash = typeof body?.expectedHash === 'string' ? body.expectedHash : undefined;
        const result =
          suffix === '/undo'
            ? await registry.undo(projectId, { expectedHash })
            : await registry.redo(projectId, { expectedHash });
        sendEditResult(res, result);
        return;
      }
      if (suffix === '/write' && method === 'POST') {
        // 兼容保留：UI 不得再用（唯一写入口是 /ops）。调用方仍能观察到 deprecated 标记。
        res.setHeader('deprecation', 'true');
        res.setHeader('warning', '299 - "/api/projects/:id/write is deprecated; use /ops"');
        const body = await readJson(req, res);
        if (body === INVALID) return;
        const invalid = validateWrite(body);
        if (invalid !== null) {
          sendJson(res, 400, { ok: false, code: 'INVALID', message: invalid });
          return;
        }
        const result = await registry.write(projectId, {
          opId: body.opId,
          expectedHash: body.expectedHash,
          edits: body.edits,
          by: body.by === 'agent' ? 'agent' : 'person',
        });
        if (result.ok === true) {
          sendJson(res, 200, {
            ok: true,
            hash: result.hash,
            changed: result.changed,
            history: result.history ?? null,
          });
          return;
        }
        const code = result.error?.code ?? 'IO';
        sendJson(res, statusForCode(code), result);
        return;
      }
      if (suffix === '/media' && method === 'POST') {
        const body = await readJson(req, res, MEDIA_BODY_LIMIT);
        if (body === INVALID) return;
        // M78：序列作用域 id（`P::<seq>`）按需打开；工程 id 走当前序列。
        const project = await registry.getAsync(projectId);
        const current = project === null ? null : registry.docOf(project.projectId);
        if (project === null || current === null) {
          sendJson(res, 404, { ok: false, code: 'FILM_NOT_FOUND', message: '工程未打开：先 /api/projects/open' });
          return;
        }
        const parsed = validateMediaRequest(body);
        if (parsed.ok !== true) {
          sendJson(res, parsed.status, { ok: false, code: parsed.code, message: parsed.message });
          return;
        }
        /** @type {(dest: string) => Promise<void>} */
        let materialize;
        /** @type {string} */
        let name;
        if (parsed.mode === 'path') {
          if (!isAbsolute(parsed.source)) {
            sendJson(res, 400, { ok: false, code: 'MEDIA_PATH_NOT_ABSOLUTE', message: `source 必须是绝对路径：${parsed.source}` });
            return;
          }
          if (!fileExistsSync(parsed.source)) {
            sendJson(res, 400, { ok: false, code: 'MEDIA_NOT_FOUND', message: `源文件不存在：${parsed.source}` });
            return;
          }
          name = /** @type {string} */ (parsed.source.split(/[\\/]/).pop());
          materialize = async (dest) => {
            await fsp.copyFile(/** @type {string} */ (parsed.source), dest, fsp.constants.COPYFILE_EXCL);
          };
        } else {
          name = parsed.name;
          const buffer = Buffer.from(parsed.data, 'base64');
          if (buffer.length === 0) {
            sendJson(res, 400, { ok: false, code: 'MEDIA_UPLOAD_EMPTY', message: '上传内容为空' });
            return;
          }
          if (buffer.length > MAX_UPLOAD_BYTES) {
            sendJson(res, 400, {
              ok: false,
              code: 'MEDIA_TOO_LARGE',
              message: `上传内容 ${buffer.length} 字节，超过上限 ${MAX_UPLOAD_BYTES}`,
            });
            return;
          }
          materialize = async (dest) => {
            await fsp.writeFile(dest, buffer, { flag: 'wx' });
          };
        }

        const imported = await importMedia({
          registry,
          project,
          doc: current.doc,
          name,
          materialize,
          at: parsed.at,
          track: parsed.track,
          opIdPrefix: 'media',
        });
        if (imported.ok !== true) {
          sendJson(res, 400, { ok: false, code: imported.code, message: imported.message });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          hash: imported.hash,
          clipId: imported.clipId,
          assetPath: imported.assetPath,
          kind: imported.kind,
          bytes: imported.bytes,
          at: imported.at,
        });
        return;
      }
      if (suffix === '/file' && (method === 'GET' || method === 'HEAD')) {
        // M34：给时间线波形一条**同源**的只读通道（内容 origin 不发 CORS，Studio 页面 fetch 不到）。
        const project = registry.get(projectId);
        if (project === null) {
          sendJson(res, 404, { ok: false, code: 'FILM_NOT_FOUND', message: '工程未打开：先 /api/projects/open' });
          return;
        }
        const checked = checkRelPath(url.searchParams.get('path') ?? '');
        if (checked.ok !== true) {
          sendJson(res, 400, { ok: false, code: checked.code, message: checked.message });
          return;
        }
        const base = resolve(project.dir);
        const target = resolve(base, checked.rel);
        if (!isInside(base, target)) {
          sendJson(res, 403, { ok: false, code: 'E_PATH_ESCAPE', message: '越界路径' });
          return;
        }
        let realBase;
        let realTarget;
        let info;
        try {
          realBase = await fsp.realpath(base);
          realTarget = await fsp.realpath(target);
          info = await fsp.stat(realTarget);
        } catch {
          sendJson(res, 404, { ok: false, code: 'FILE_NOT_FOUND', message: `文件不存在：${checked.rel}` });
          return;
        }
        // 符号链接也可能逃出工程根：realpath 之后再判一次前缀。
        if (!isInside(realBase, realTarget) || !info.isFile()) {
          sendJson(res, info?.isFile() === false ? 400 : 403, {
            ok: false,
            code: info?.isFile() === false ? 'NOT_A_FILE' : 'E_PATH_ESCAPE',
            message: info?.isFile() === false ? '不是普通文件' : '越界路径（符号链接）',
          });
          return;
        }
        res.writeHead(200, {
          'content-type': contentTypeOf(checked.rel),
          'content-length': info.size,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        if (method === 'HEAD') {
          res.end();
          return;
        }
        const stream = createReadStream(realTarget);
        stream.on('error', () => res.destroy());
        stream.pipe(res);
        return;
      }
      if (suffix === '/media-status' && (method === 'GET' || method === 'HEAD')) {
        const project = registry.get(projectId);
        const current = registry.docOf(projectId);
        if (project === null || current === null) {
          sendJson(res, 404, { ok: false, code: 'FILM_NOT_FOUND', message: '工程未打开：先 /api/projects/open' });
          return;
        }
        // M26：逐条 bare src 判 ok / missing / unreadable（同一份探测结果也给 M25 算源余量）。
        const status = await mediaStatusOf({ project, doc: current.doc });
        sendJson(res, 200, { ok: true, ...status, scannedAt: new Date().toISOString() });
        return;
      }
      if (suffix === '/relink' && method === 'POST') {
        const body = await readJson(req, res);
        if (body === INVALID) return;
        const project = registry.get(projectId);
        const current = registry.docOf(projectId);
        if (project === null || current === null) {
          sendJson(res, 404, { ok: false, code: 'FILM_NOT_FOUND', message: '工程未打开：先 /api/projects/open' });
          return;
        }
        if (!Array.isArray(body?.targets) || body.targets.length === 0) {
          sendJson(res, 400, { ok: false, code: 'INVALID', message: 'targets 必须是非空数组（[{clip, src}]）' });
          return;
        }
        const plan = await planRelink({ project, doc: current.doc, targets: body.targets, dryRun: body?.dryRun === true });
        if (plan.ok !== true) {
          sendJson(res, 400, {
            ok: false,
            code: plan.code,
            message: plan.message,
            applied: plan.applied,
            rejected: plan.rejected,
            warnings: plan.warnings,
          });
          return;
        }
        if (body?.dryRun === true) {
          sendJson(res, 200, { ok: true, dryRun: true, applied: plan.applied, warnings: plan.warnings, ops: plan.ops.length });
          return;
        }
        const invalid = validateEnvelope(body?.envelope, projectId);
        if (invalid !== null) {
          sendJson(res, 400, { ok: false, code: 'INVALID', message: invalid });
          return;
        }
        const opsProblem = validateOps(plan.ops);
        if (opsProblem !== null) {
          sendJson(res, 400, { ok: false, code: 'INVALID', message: opsProblem });
          return;
        }
        const envelope = body.envelope;
        const result = await registry.applyOps(
          projectId,
          { opId: envelope.opId, expectedHash: envelope.expectedHash, by: envelope.owner === 'MAIN' ? 'person' : 'agent' },
          plan.ops,
        );
        if (result.ok === true) {
          sendJson(res, 200, {
            ok: true,
            hash: result.hash,
            changed: result.changed === true,
            undoDepth: result.undoDepth,
            redoDepth: result.redoDepth,
            applied: plan.applied,
            warnings: plan.warnings,
          });
          return;
        }
        sendEditResult(res, result);
        return;
      }
      if (suffix === '/relink/scan' && method === 'POST') {
        const body = await readJson(req, res);
        if (body === INVALID) return;
        const project = registry.get(projectId);
        const current = registry.docOf(projectId);
        if (project === null || current === null) {
          sendJson(res, 404, { ok: false, code: 'FILM_NOT_FOUND', message: '工程未打开：先 /api/projects/open' });
          return;
        }
        // M26 批量重链：只**列清单**，不写盘；确认后走 /relink 一次落盘。
        const scanned = await scanRelinkDir({ project, doc: current.doc, dir: body?.dir, clips: body?.clips });
        sendJson(res, scanned.ok === true ? 200 : 400, scanned);
        return;
      }
      if (suffix === '/subtitle-style' && (method === 'GET' || method === 'HEAD')) {
        // M40：样式是**工程设置**（`.film/subtitle-style.json`），不在 film.html 里，
        // 也不进 /ops。文件不存在 → 200 + exists:false + 默认值（新工程本来就没有）。
        const project = registry.get(projectId);
        if (project === null) {
          sendJson(res, 404, { ok: false, code: 'FILM_NOT_FOUND', message: '工程未打开' });
          return;
        }
        const style = await readSubtitleStyle(project.dir);
        sendJson(res, style.ok === true ? 200 : 500, style);
        return;
      }
      if (suffix === '/subtitle-style' && (method === 'PUT' || method === 'POST')) {
        const project = registry.get(projectId);
        if (project === null) {
          sendJson(res, 404, { ok: false, code: 'FILM_NOT_FOUND', message: '工程未打开' });
          return;
        }
        const body = await readJson(req, res);
        if (body === INVALID) return;
        const unknownTop = Object.keys(body ?? {}).filter((key) => key !== 'style');
        if (unknownTop.length > 0) {
          sendJson(res, 400, {
            ok: false,
            code: 'UNKNOWN_FIELD',
            field: unknownTop[0],
            message: `未知字段：${unknownTop.join('/')}（请求体只接受 { style }）`,
          });
          return;
        }
        const saved = await saveSubtitleStyle({ projectDir: project.dir, patch: body?.style });
        if (saved.ok === true) {
          sendJson(res, 200, saved);
          return;
        }
        const status = saved.code === 'UNKNOWN_FIELD' || saved.code === 'INVALID_STYLE' ? 400 : 500;
        sendJson(res, status, saved);
        return;
      }
      if (suffix === '/subtitles' && (method === 'GET' || method === 'HEAD')) {
        const project = registry.get(projectId);
        if (project === null) {
          sendJson(res, 404, { ok: false, code: 'FILM_NOT_FOUND', message: '工程未打开' });
          return;
        }
        const result = await readSubtitles({ project, src: url.searchParams.get('src') ?? '' });
        sendJson(res, result.ok === true ? 200 : 400, result);
        return;
      }
      if (suffix === '/subtitles' && (method === 'PUT' || method === 'POST')) {
        const project = registry.get(projectId);
        if (project === null) {
          sendJson(res, 404, { ok: false, code: 'FILM_NOT_FOUND', message: '工程未打开' });
          return;
        }
        const body = await readJson(req, res);
        if (body === INVALID) return;
        // Legacy clients send no subtitle hash. Capture their ingress baseline
        // so waiting behind a new caption/ASR transaction cannot overwrite it.
        const expectedFilm = body?.expectedHash ?? registry.docOf(projectId)?.hash;
        const initial = await readSubtitles({ project, src: body?.src });
        if (!initial.ok) { sendJson(res, 400, initial); return; }
        const expectedSubtitle = Object.hasOwn(body ?? {}, 'expectedSubtitleHash') ? body.expectedSubtitleHash : initial.hash;
        const saved = await withProjectCaptionLock(project, async () => {
          const check = async () => {
            if (!expectedFilm || registry.docOf(projectId)?.hash !== expectedFilm) return { ok: false, code: 'CONFLICT', message: '工程已变化，字幕未修改，请刷新后重试' };
            const latest = await readSubtitles({ project, src: body?.src });
            if (!latest.ok) return latest;
            return latest.hash === expectedSubtitle ? { ok: true } : { ok: false, code: 'SUBTITLE_CONFLICT', message: '等待保存时字幕已变化，未覆盖，请刷新后重试' };
          };
          const guard = await check(); if (!guard.ok) return guard;
          let conflict;
          const result = await saveSubtitles({ project, src: body?.src, cues: body?.cues, format: body?.format, hooks: { beforeRename: async () => {
            const latest = await check(); if (!latest.ok) { conflict = latest; throw new Error(latest.message); }
          } } });
          return conflict ?? result;
        });
        sendJson(res, saved.ok === true ? 200 : ['CONFLICT','SUBTITLE_CONFLICT'].includes(saved.code) ? 409 : 400, saved);
        return;
      }
      if (suffix === '/subtitles/import' && method === 'POST') {
        /* E12-P5 第 3 步：吃**真实文件**（请求体就是文件字节，不是 JSON 里的字符串）。
         *
         * 为什么不走 JSON + 字符串：`readJson` 会先把请求体按 UTF-8 解码，GBK 的文件
         * 在那一刻就已经被换成 U+FFFD 了 —— 端到端都拿不到原始字节，就永远判不出编码错误。
         *
         * 语义：**默认只解析、不落盘**（`?save=1` 才写）。落盘仍走 `saveSubtitles` 那一条路
         * （原子写 + 回读校验 + `.film/history`），这里不新开第二条写路径。
         *
         * 查询参数：`name`（文件名，用来定格式）、`format`（显式指定，压过扩展名）、
         * `src`（这条字幕挂在哪条素材上）、`save=1`（写回伴生文件）。 */
        const project = registry.get(projectId);
        if (project === null) {
          sendJson(res, 404, { ok: false, code: 'FILM_NOT_FOUND', message: '工程未打开' });
          return;
        }
        const src = url.searchParams.get('src') ?? '';
        const wantSave = url.searchParams.get('save') === '1';
        if (wantSave && src.trim() === '') {
          sendJson(res, 400, {
            ok: false,
            code: 'SUBTITLE_SRC_INVALID',
            message: 'save=1 时必须给 src（这条字幕挂在哪条素材上）',
          });
          return;
        }
        const raw = await readRaw(req, res, { maxBytes: MAX_SUBTITLE_BYTES, tooLargeCode: 'SUBTITLE_TOO_LARGE' });
        if (raw === INVALID) return;
        const explicitFormat = url.searchParams.get('format');
        const imported = importSubtitleBytes(raw, {
          name: url.searchParams.get('name') ?? '',
          ...(explicitFormat === 'vtt' || explicitFormat === 'srt' ? { format: explicitFormat } : {}),
        });
        if (imported.ok !== true) {
          sendJson(res, imported.code === 'SUBTITLE_TOO_LARGE' ? 413 : 400, imported);
          return;
        }
        /* 原文只在内存里用来算哈希与线索，不回给客户端（2 MiB 的文件没理由再传一遍）。 */
        const { text: _text, ...rest } = imported;
        if (!wantSave) {
          sendJson(res, 200, { ...rest, saved: null });
          return;
        }
        const expectedFilm = url.searchParams.get('expectedHash') ?? registry.docOf(projectId)?.hash;
        const initial = await readSubtitles({ project, src });
        if (!initial.ok) { sendJson(res, 400, { ...rest, saved: initial }); return; }
        const requestedSubtitle = url.searchParams.get('expectedSubtitleHash');
        const expectedSubtitle = requestedSubtitle === null ? initial.hash : requestedSubtitle === 'null' ? null : requestedSubtitle;
        const saved = await withProjectCaptionLock(project, async () => {
          const check = async () => {
            if (!expectedFilm || registry.docOf(projectId)?.hash !== expectedFilm) return { ok: false, code: 'CONFLICT', message: '工程已变化，字幕未导入，请刷新后重试' };
            const latest = await readSubtitles({ project, src });
            if (!latest.ok) return latest;
            return latest.hash === expectedSubtitle ? { ok: true } : { ok: false, code: 'SUBTITLE_CONFLICT', message: '等待导入时字幕已变化，未覆盖，请刷新后重试' };
          };
          const guard = await check(); if (!guard.ok) return guard;
          let conflict;
          const result = await saveSubtitles({ project, src, cues: imported.cues, format: imported.format, hooks: { beforeRename: async () => {
            const latest = await check(); if (!latest.ok) { conflict = latest; throw new Error(latest.message); }
          } } });
          return conflict ?? result;
        });
        sendJson(res, saved.ok === true ? 200 : ['CONFLICT','SUBTITLE_CONFLICT'].includes(saved.code) ? 409 : 400, { ...rest, saved });
        return;
      }
      if (suffix === '/subtitles/export' && method === 'POST') {
        /* 段列表 → 字幕文本。**纯函数，不需要工程目录**（只是借 projects 这条路径做命名空间）。
         * `roundTrip` 是当场自证：导出文本重解析一遍，线索逐条比、再序列化逐字节比。 */
        const body = await readJson(req, res);
        if (body === INVALID) return;
        const unknownTop = Object.keys(body ?? {}).filter((key) => key !== 'cues' && key !== 'format');
        if (unknownTop.length > 0) {
          sendJson(res, 400, {
            ok: false,
            code: 'UNKNOWN_FIELD',
            field: unknownTop[0],
            message: `未知字段：${unknownTop.join('/')}（请求体只接受 { cues, format }）`,
          });
          return;
        }
        const exported = exportSubtitleBytes(body?.cues, {
          ...(body?.format === 'srt' || body?.format === 'vtt' ? { format: body.format } : {}),
        });
        sendJson(res, exported.ok === true ? 200 : 400, exported);
        return;
      }
      if (suffix === '/thumbnails' && (method === 'GET' || method === 'HEAD')) {
        const summary = registry.thumbnails(projectId);
        if (summary === null) {
          sendJson(res, 404, { ok: false, code: 'FILM_NOT_FOUND', message: '工程未打开' });
          return;
        }
        sendJson(res, 200, { ok: true, ...summary });
        return;
      }
      if (suffix === '/thumbnails/request' && method === 'POST') {
        const body = await readJson(req, res);
        if (body === INVALID) return;
        const summary = registry.requestThumbnails(projectId, body?.clips);
        if (summary === null) {
          sendJson(res, 404, { ok: false, code: 'FILM_NOT_FOUND', message: '工程未打开' });
          return;
        }
        sendJson(res, 200, { ok: true, ...summary });
        return;
      }
    }

    if (path === '/api/debug/ws-stats' && method === 'GET') {
      sendJson(res, 200, { ok: true, ...wsStats, seq: hub.seq, subscribers: hub.subscriberCount() });
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD, POST, PUT, OPTIONS');
      sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
      return;
    }
    sendJson(res, 404, { ok: false, code: 'NOT_FOUND', path });
  }

  /**
   * 每条连接：等客户端 `subscribe`（可带 since，也可用 URL 的 `?since=`）后补发；
   * `ping` → `pong`。
   * @param {any} connection
   * @param {import('node:http').IncomingMessage} request
   */
  function onSocket(connection, request) {
    wsStats.connections += 1;
    let querySince = null;
    try {
      const query = new URL(request.url ?? '/', `http://${host}`).searchParams.get('since');
      if (query !== null && query !== '' && Number.isFinite(Number(query))) querySince = Number(query);
    } catch {
      querySince = null;
    }
    /** @type {{ unsubscribe: () => void } | null} */
    let subscription = null;
    const closeSubscription = () => {
      subscription?.unsubscribe();
      subscription = null;
    };
    connection.on('message', (/** @type {string} */ raw) => {
      wsStats.messages += 1;
      /** @type {any} */
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        connection.send({ type: 'error', code: 'BAD_MESSAGE', message: '消息必须是 JSON' });
        return;
      }
      if (message?.type === 'ping') {
        connection.send({ type: 'pong', at: new Date().toISOString() });
        return;
      }
      if (message?.type === 'subscribe') {
        closeSubscription();
        const since = Number.isFinite(message.since) ? Number(message.since) : querySince;
        const result = hub.subscribe({
          since,
          send: (envelope) => connection.send(envelope),
          onResync: (reason) => connection.send({ type: 'resync', reason }),
        });
        subscription = result;
        connection.send({
          type: 'subscribed',
          seq: result.seq,
          since,
          replayed: result.replayed,
          resync: result.resync,
        });
        return;
      }
      connection.send({ type: 'error', code: 'BAD_MESSAGE', message: '只支持 subscribe / ping' });
    });
    connection.on('close', closeSubscription);
  }

  const ws = attachWebSocketServer(server, {
    path: EVENTS_PATH,
    isOriginAllowed,
    onConnection: onSocket,
    onReject: (info) => {
      wsStats.rejected += 1;
      wsStats.lastRejection = { ...info, at: new Date().toISOString() };
      log(`WS_REJECTED reason=${info.reason} origin=${String(info.origin ?? '')} remote=${String(info.remote ?? '')}`);
    },
    logger: log,
  });

  /**
   * 返回本次 Studio 实际使用的 WebSocket URL（端口不漂移）。
   * @returns {string}
   */
  function eventsUrl() {
    return `ws://${host}:${state.boundPort}${EVENTS_PATH}`;
  }

  server.on('close', () => {
    mediaServices.close();
    ws.detach();
    hub.close();
  });

  return {
    server,
    allowedOrigins,
    host,
    port: options.port,
    vitePort,
    version,
    hub,
    registry,
    grants,
    acpAgent,
    /* 验收/排障：台账就在这上面（只读看 `agentScene.runs.list()`）。 */
    agentScene,
    exportJobs,
    renderQueue,
    wsStats,
    log,
    contentState,
    eventsUrl,
    /** 关闭事件通道的所有长连接（server.close 不会关 Upgrade 后的 socket）。 */
    detachEvents: () => ws.detach(),
    /** 关闭只读 API 的页面宿主（M66；startStudio 的 close 会调）。 */
    closeLayerPage: () => layerReader.close(),
    /** 关闭渲染调度器（M67；会 abort 运行中的任务）。 */
    closeRenderQueue: () => renderQueue.close(),
    /** @param {number} port */
    setBoundPort(port) {
      state.boundPort = port;
      allowedOrigins.add(`http://127.0.0.1:${port}`);
    },
  };
}

/**
 * 启动并等到真正 listen；端口被占直接 reject（不换端口）。
 * @param {StudioOptions} options
 */
export async function startStudio(options) {
  const studio = createStudio(options);
  await new Promise((resolve, reject) => {
    const onError = (/** @type {Error & { code?: string }} */ error) => {
      studio.server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      studio.server.removeListener('error', onError);
      resolve(undefined);
    };
    studio.server.once('error', onError);
    studio.server.once('listening', onListening);
    studio.server.listen(options.port, options.host ?? LOOPBACK);
  });

  const address = studio.server.address();
  const boundPort = address !== null && typeof address === 'object' ? address.port : studio.port;
  studio.setBoundPort(boundPort);

  /** @type {{ origin: string, port: number, close: () => Promise<void> } | null} */
  let content = null;
  if (Number.isInteger(options.contentPort)) {
    try {
      content = await startContentOrigin({
        registry: studio.registry,
        port: Number(options.contentPort),
        host: studio.host,
        logger: studio.log,
      });
      studio.contentState.origin = content.origin;
      studio.contentState.port = content.port;
    } catch (error) {
      // 内容 origin 起不来就把刚监听的主服务也关掉：不留下半个 Studio。
      studio.contentState.error = String(/** @type {Error} */ (error)?.message ?? error);
      studio.detachEvents();
      await new Promise((resolve) => {
        studio.server.close(() => resolve(undefined));
        studio.server.closeAllConnections?.();
      });
      throw error;
    }
  }

  return {
    ...studio,
    port: boundPort,
    url: `http://${studio.host}:${boundPort}`,
    eventsUrl: `ws://${studio.host}:${boundPort}${EVENTS_PATH}`,
    contentOrigin: content === null ? null : { origin: content.origin, port: content.port },
    close: async () => {
      if (content !== null) await content.close();
      await studio.closeLayerPage();
      await studio.closeRenderQueue();
      await studio.acpAgent.dispose();
      await studio.registry.closeAll();
      studio.detachEvents();
      await new Promise((resolve) => {
        studio.server.close(() => resolve(undefined));
        studio.server.closeAllConnections?.();
      });
    },
  };
}

const INVALID = Symbol('invalid-body');

/**
 * M71 的统一错误出口：`SceneError` 自带状态码；其余一律 500（不吞）。
 * @param {import('node:http').ServerResponse} res
 * @param {unknown} error
 */
function sendSceneError(res, error) {
  if (error instanceof SceneError) {
    sendJson(res, error.status, {
      ok: false,
      code: error.code,
      message: error.message,
      ...(error.detail ?? {}),
    });
    return;
  }
  sendJson(res, 500, {
    ok: false,
    code: 'AGENT_INTERNAL',
    message: String(/** @type {any} */ (error)?.message ?? error),
  });
}

/**
 * M72 的统一错误出口：`MoveError` 自带状态码；其余 500。
 * @param {import('node:http').ServerResponse} res
 * @param {unknown} error
 */
function sendMoveError(res, error) {
  if (error instanceof MoveError) {
    sendJson(res, error.status, {
      ok: false,
      code: error.code,
      message: error.message,
      ...(error.detail ?? {}),
    });
    return;
  }
  sendJson(res, 500, {
    ok: false,
    code: 'MOVE_INTERNAL',
    message: String(/** @type {any} */ (error)?.message ?? error),
  });
}

/**
 * 只读图层/检查器 API 的错误出口（M66 v1 → M69 v2）。
 *
 * 域错误（400/404/409）由 `layers-read.mjs` 的 `ReadApiError` 带着状态码抛上来；
 * 页面不可达是 502 + `reason`；其余一律 502 `UNEXPECTED`（**不吞**，也不伪装成空列表）。
 * @param {import('node:http').ServerResponse} res
 * @param {unknown} error
 */
function sendReadApiError(res, error) {
  if (error instanceof ReadApiError) {
    sendJson(res, error.status, { ok: false, code: error.code, message: error.message });
    return;
  }
  if (error instanceof PageUnreachable) {
    sendJson(res, 502, { ok: false, code: 'PAGE_UNREACHABLE', reason: error.reason, message: error.message });
    return;
  }
  sendJson(res, 502, {
    ok: false,
    code: 'PAGE_UNREACHABLE',
    reason: 'UNEXPECTED',
    message: String(/** @type {Error} */ (error)?.message ?? error),
  });
}


/**
 * 读**原始字节**（字幕导入用）：不按 UTF-8 解码，解码交给调用方。
 *
 * 为什么不能复用 `readJson`：它 `toString('utf8')` 那一步会把非法字节换成 U+FFFD，
 * 「这份文件不是 UTF-8」就永远判不出来了 —— 而那是导入必须报的一个错。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ maxBytes?: number, tooLargeCode?: string }} [options]
 * @returns {Promise<Buffer|typeof INVALID>}
 */
function readRaw(req, res, options = {}) {
  const limit = Number.isFinite(options.maxBytes) ? Number(options.maxBytes) : MAX_BODY;
  const tooLargeCode = options.tooLargeCode ?? 'BODY_TOOLARGE';
  return new Promise((resolveBody) => {
    let size = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        sendJson(res, 413, { ok: false, code: tooLargeCode, message: `请求体超过 ${limit} 字节` });
        req.destroy();
        resolveBody(INVALID);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', () => resolveBody(INVALID));
  });
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {number} [maxBytes] 少数路由（素材上传）需要更大的上限
 * @returns {Promise<any|typeof INVALID>}
 */
function readJson(req, res, maxBytes = MAX_BODY) {
  const limit = Number.isFinite(maxBytes) ? Number(maxBytes) : MAX_BODY;
  return new Promise((resolveBody) => {
    let size = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        sendJson(res, 413, { ok: false, code: 'BODY_TOOLARGE', message: `请求体超过 ${limit} 字节` });
        req.destroy();
        resolveBody(INVALID);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(raw));
      } catch (error) {
        sendJson(res, 400, { ok: false, code: 'BAD_JSON', message: String(/** @type {Error} */ (error).message) });
        resolveBody(INVALID);
      }
    });
    req.on('error', () => resolveBody(INVALID));
  });
}

/**
 * 合同 `Envelope` 的边界检查（不合法的请求不进写队列）。
 * @param {any} envelope
 * @param {string} projectId
 * @returns {string|null}
 */
function validateEnvelope(envelope, projectId) {
  if (envelope === null || typeof envelope !== 'object') return '请求体缺少 envelope';
  if (envelope.projectId !== projectId) {
    return `envelope.projectId（${String(envelope.projectId)}）与路由（${projectId}）不一致`;
  }
  if (typeof envelope.batchId !== 'string' || envelope.batchId === '') return 'envelope.batchId 必填';
  if (!['MAIN', 'SUB1', 'SUB2', 'BRAIN'].includes(envelope.owner)) {
    return 'envelope.owner 必须是 MAIN/SUB1/SUB2/BRAIN';
  }
  if (typeof envelope.expectedHash !== 'string' || !/^[0-9a-f]{64}$/.test(envelope.expectedHash)) {
    return 'envelope.expectedHash 必须是 64 位十六进制 sha256';
  }
  if (typeof envelope.opId !== 'string' || envelope.opId === '') return 'envelope.opId 必填';
  return null;
}

/**
 * `envelope.target` 的形状校验（R143）。**不**在这里判工程是否一致 ——
 * 跨工程要由守卫给 403 `FOREIGN_PROJECT`，而不是被表单校验变成 400。
 * @param {any} target
 * @returns {string|null}
 */
function validateTarget(target) {
  if (target === undefined || target === null) return null;
  if (typeof target !== 'object' || Array.isArray(target)) return 'envelope.target 必须是对象';
  if (typeof target.projectId !== 'string' || target.projectId === '') return 'envelope.target.projectId 必须是非空字符串';
  if (typeof target.elementKey !== 'string' || !target.elementKey.includes('::')) {
    return 'envelope.target.elementKey 必须形如 <clipId>::<元素定位串>';
  }
  if (typeof target.instanceId !== 'string' || target.instanceId === '') return 'envelope.target.instanceId 必须是非空字符串';
  if (typeof target.signature !== 'string' || target.signature === '') return 'envelope.target.signature 必须是非空字符串';
  if (!Number.isFinite(Number(target.epoch))) return 'envelope.target.epoch 必须是数字';
  return null;
}

/**
 * @param {any} ops
 * @returns {string|null}
 */
function validateOps(ops) {
  if (!Array.isArray(ops) || ops.length === 0) return 'ops 必须是非空数组';
  for (let index = 0; index < ops.length; index += 1) {
    const op = ops[index];
    if (op === null || typeof op !== 'object' || typeof op.op !== 'string' || op.op === '') {
      return `ops[${index}] 必须带 op 名称`;
    }
  }
  return null;
}

/**
 * `/ops`、`/undo`、`/redo` 的统一返回形状（合同）：200 / 409 / 400。
 * @param {import('node:http').ServerResponse} res
 * @param {any} result
 */
function sendEditResult(res, result) {
  if (result.ok === true) {
    sendJson(res, 200, {
      ok: true,
      hash: result.hash,
      changed: result.changed === true,
      touched: Array.isArray(result.touched) ? result.touched : [],
      undoDepth: Number.isInteger(result.undoDepth) ? result.undoDepth : 0,
      redoDepth: Number.isInteger(result.redoDepth) ? result.redoDepth : 0,
      ...(result.replayed === true ? { replayed: true } : {}),
      ...(result.element === undefined ? {} : { element: result.element }),
      /* R150 · M16-R3：把「这次是在旧实例上重试」**提到顶层**。`element` 里也有，
         但客户端拿的是 response.rebuilding（一处口径），不该逼每个消费者去翻嵌套。 */
      ...(result.element?.rebuilding === true
        ? { rebuilding: true, attempts: Number(result.element.attempts ?? 0), retryLimit: Number(result.element.limit ?? 0) }
        : {}),
      /* R146：守卫这次到底参没参与。老客户端（无 target）写片段/图层照旧成功，
         但响应体必须**明说**没校验 —— 不能让它看起来像「已经保护过」。 */
      ...(result.guard === undefined ? {} : { guard: result.guard }),
      ...(result.warn === undefined ? {} : { warn: result.warn }),
      /* CS2：凭票写入时把「哪张票、哪次会话/run」带回给调用方（agent 侧要能记账）。 */
      ...(result.agent === undefined ? {} : { agent: result.agent }),
    });
    return;
  }
  const code = typeof result.code === 'string' ? result.code : 'IO';
  /* S87：`ELEMENT_LOCKED` 与轨道锁的 `LOCKED` 都是 400，但码不同 —— 前端要能分开讲。
     R143：守卫自己带着精确状态（跨工程 403 / 失效 409 / 目标不符 400），优先用它。 */
  const fallback =
    code === 'CONFLICT' || code === 'STALE_EPOCH' || code === 'ELEMENT_GONE' || code === 'ELEMENT_REPLACED'
      || code === 'ELEMENT_UNMOUNTED' || code === 'REBUILD_EXHAUSTED' || code === 'PAGE_UNREADABLE'
      ? 409
      : code === 'INVALID' || code === 'NOT_FOUND' || code === 'LOCKED' || code === 'ELEMENT_LOCKED' || code === 'TARGET_MISMATCH'
        ? 400
        : 500;
  const status = typeof result.status === 'number' ? result.status : fallback;
  sendJson(res, status, {
    ok: false,
    code,
    message: typeof result.message === 'string' ? result.message : '写入失败',
    ...(typeof result.currentHash === 'string' ? { currentHash: result.currentHash } : {}),
    ...(Array.isArray(result.violations) ? { violations: result.violations } : {}),
    ...(result.detail === undefined ? {} : { detail: result.detail }),
  });
}

/**
 * `POST /api/export` 的边界检查：未知字段直接 400（不做「忽略多余字段」的宽容）。
 *
 * M39：`ranges`（1–100 段）与 `range` **互斥**（同时给就 400，不赌谁的优先级）。
 * 这里只做**形状**校验（段数、正负、先后）；「末端超出片长」要等拿到文档时长，
 * 由调用方在入队前用 `checkRangesWithinDuration` 补一刀。
 *
 * @param {any} body
 * @returns {{ ok: false, code: string, message: string }|{ ok: true, range: [number, number]|null, ranges: Array<[number, number]>|null, quality: string, codec: 'h264'|'hevc', outDir: string|null, outPath: string|null, subtitleBurn: boolean, subtitleSrc: string, size: {w: number, h: number}|null, fit: 'letterbox'|'cover'|null, fps: number|null, sequence: string|null, clipId: string|null, expectedHash: string|null }}
 */
function validateExportRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, code: 'INVALID', message: '请求体必须是对象' };
  }
  for (const key of Object.keys(body)) {
    if (!EXPORT_REQUEST_FIELDS.includes(key)) {
      return { ok: false, code: 'UNKNOWN_FIELD', message: `未知字段：${key}（只接受 ${EXPORT_REQUEST_FIELDS.join('/')}）` };
    }
  }
  if (typeof body.projectId !== 'string' || body.projectId === '') {
    return { ok: false, code: 'INVALID', message: 'projectId 必填' };
  }

  /** @type {[number, number]|null} */
  let range = null;
  const hasRange = body.range !== undefined && body.range !== null && body.range !== 'all';
  if (hasRange) {
    const raw = body.range;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, code: 'INVALID', message: 'range 只接受 "all" 或 { start, end }' };
    }
    const start = Number(raw.start);
    const end = Number(raw.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      return { ok: false, code: 'INVALID', message: 'range 需要 0 <= start < end 的数值' };
    }
    range = [start, end];
  }

  /** @type {Array<[number, number]>|null} */
  let ranges = null;
  if (body.ranges !== undefined && body.ranges !== null) {
    if (hasRange) {
      return { ok: false, code: 'INVALID_RANGE', message: 'range 与 ranges 只能给一个（ranges 是多段的写法）' };
    }
    if (!Array.isArray(body.ranges)) {
      return { ok: false, code: 'INVALID_RANGE', message: 'ranges 必须是数组（[[start, end], ...]）' };
    }
    // 段数与逐段正负：与 `film-core/export-range.mjs` 的 `planRangeInputs` 同一套判据，
    // 只是这里不认字符串（接口层只收数字，UI 已经在前端把 12.5 / 00:12.500 解析成秒）。
    const planned = planRangeInputs(body.ranges);
    if (planned.ok !== true) {
      // `planRangeInputs` 的 message 已经含「第 N 段」；不要再前缀一次（会变成「第 2 段：第 2 段…」）。
      return { ok: false, code: 'INVALID_RANGE', message: planned.message };
    }
    ranges = planned.ranges;
  }

  const quality = body.quality === undefined ? 'standard' : body.quality;
  if (typeof quality !== 'string' || !EXPORT_QUALITIES.includes(quality)) {
    return { ok: false, code: 'INVALID', message: `quality 只接受 ${EXPORT_QUALITIES.join('/')}` };
  }

  /* 编码（M50）：只认 h264 / hevc。别的值**入队前**就 400——不落文件、不占 jobId、
     不排进队列（「随便传，渲不出来再说」是 M50 明令不许的做法）。 */
  /** @type {'h264'|'hevc'} */
  let codec = 'h264';
  if (body.codec !== undefined && body.codec !== null) {
    if (body.codec !== 'h264' && body.codec !== 'hevc') {
      return { ok: false, code: 'UNSUPPORTED_CODEC', message: `codec 只接受 h264/hevc（收到 ${String(body.codec)}）` };
    }
    codec = body.codec;
  }

  /** @type {string|null} */
  let outDir = null;
  if (body.outDir !== undefined && body.outDir !== null) {
    if (typeof body.outDir !== 'string' || body.outDir.trim() === '') {
      return { ok: false, code: 'INVALID', message: 'outDir 必须是非空字符串' };
    }
    outDir = body.outDir.trim();
  }

  /** @type {string|null} */
  let outPath = null;
  if (body.outPath !== undefined && body.outPath !== null) {
    if (typeof body.outPath !== 'string' || body.outPath.trim() === '') {
      return { ok: false, code: 'INVALID', message: 'outPath 必须是非空字符串（绝对路径）' };
    }
    if (!isAbsolute(body.outPath.trim())) {
      return { ok: false, code: 'INVALID', message: 'outPath 必须是绝对路径（相对路径会落哪儿由谁负责说不清）' };
    }
    outPath = body.outPath.trim();
  }
  if (outDir !== null && outPath !== null) {
    return { ok: false, code: 'INVALID', message: 'outDir 与 outPath 只能给一个' };
  }

  /* 烧字幕（M41）：形状只判到这里；「字幕文件在不在、有没有 cue、是不是多段」
     要读盘才知道，交给路由层在**入队前**用 `checkBurnFeasible` 判（400、队列不变）。 */
  const subtitleBurn = body.subtitleBurn === undefined ? false : body.subtitleBurn;
  if (typeof subtitleBurn !== 'boolean') {
    return { ok: false, code: 'INVALID', message: 'subtitleBurn 只接受 true/false' };
  }
  /** @type {string} */
  let subtitleSrc = '';
  if (body.subtitleSrc !== undefined && body.subtitleSrc !== null) {
    if (typeof body.subtitleSrc !== 'string' || body.subtitleSrc.trim() === '') {
      return { ok: false, code: 'INVALID', message: 'subtitleSrc 必须是非空字符串（工程内相对路径）' };
    }
    subtitleSrc = body.subtitleSrc.trim();
  }
  if (subtitleBurn === false && subtitleSrc !== '') {
    return { ok: false, code: 'INVALID', message: 'subtitleSrc 只在 subtitleBurn:true 时有意义（不给开关却给字幕源，会被静默忽略）' };
  }

  /* 交付画幅与帧率（M42）：三个都可缺省；缺省 = 跟随工程 + 30fps。
     `size` 向上取偶（编码器要偶数边长），范围 2..7680 与 `parseSizeArg` 的预设同一量级。 */
  /** @type {{w: number, h: number}|null} */
  let size = null;
  if (body.size !== undefined && body.size !== null) {
    const raw = body.size;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, code: 'INVALID_SIZE', message: 'size 只接受 { w, h } 或 null（跟随工程）' };
    }
    const w = Number(raw.w);
    const h = Number(raw.h);
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 2 || h < 2 || w > 7680 || h > 7680) {
      return { ok: false, code: 'INVALID_SIZE', message: `size 需要 2..7680 的整数宽高（收到 ${String(raw.w)}×${String(raw.h)}）` };
    }
    size = { w: w % 2 === 0 ? w : w + 1, h: h % 2 === 0 ? h : h + 1 };
  }
  /** @type {'letterbox'|'cover'|null} */
  let fit = null;
  if (body.fit !== undefined && body.fit !== null) {
    if (body.fit !== 'letterbox' && body.fit !== 'cover') {
      return { ok: false, code: 'INVALID_FIT', message: `fit 只接受 letterbox/cover（收到 ${String(body.fit)}）` };
    }
    fit = body.fit;
  }
  if (fit !== null && size === null) {
    // 没有 size 时 fit 无处施加（planDelivery 会返回 fit:'none'）——不静默忽略。
    return { ok: false, code: 'INVALID_FIT', message: 'fit 只在给了 size 时有意义：跟随工程尺寸时不要传 fit' };
  }
  /** @type {number|null} */
  let fps = null;
  if (body.fps !== undefined && body.fps !== null) {
    const value = Number(body.fps);
    if (!Number.isInteger(value) || value < 1 || value > 120) {
      return { ok: false, code: 'INVALID_FPS', message: `fps 需要 1..120 的整数（收到 ${String(body.fps)}）` };
    }
    fps = value;
  }
  /* M78：序列。形状只判到这里；「这个序列存不存在」由路由用索引判（404 SEQUENCE_NOT_FOUND）。 */
  /** @type {string|null} */
  let sequence = null;
  if (body.sequence !== undefined && body.sequence !== null) {
    if (typeof body.sequence !== 'string' || body.sequence.trim() === '') {
      return { ok: false, code: 'INVALID', message: 'sequence 必须是非空字符串（序列 id）' };
    }
    sequence = body.sequence.trim();
  }
  /** @type {string|null} */
  let clipId = null;
  /** @type {string|null} */
  let expectedHash = null;
  if (body.clipId !== undefined) {
    if (typeof body.clipId !== 'string' || body.clipId.length === 0 || /\s/.test(body.clipId)) {
      return { ok: false, code: 'INVALID', message: 'clipId 必须是有效的片段 ID' };
    }
    if (hasRange || ranges !== null || subtitleBurn) {
      return { ok: false, code: 'INVALID', message: '独立片段导出不接受其他区间或工程字幕' };
    }
    if (typeof body.expectedHash !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedHash)) {
      return { ok: false, code: 'INVALID', message: '独立片段导出需要当前影片的 expectedHash' };
    }
    clipId = body.clipId;
    expectedHash = body.expectedHash;
  } else if (body.expectedHash !== undefined) {
    return { ok: false, code: 'INVALID', message: 'expectedHash 仅用于独立片段导出' };
  }
  return { ok: true, range, ranges, quality, codec, outDir, outPath, subtitleBurn, subtitleSrc, size, fit, fps, sequence, clipId, expectedHash };
}

/**
 * 多段末端越界：入队**之前**判，越界直接 400，队列长度与 `exports/` 都不动。
 *
 * 为什么不用 `planFromFilm` 顺手判：那是作业**开工后**才跑的，异常会落成 `failed`
 * 作业（用户看到的是「失败」而不是「这段不合法」，队列里还多出一条）。这里用
 * `filmDuration`（同一份时长口径）先量一次，只读、不入队。
 *
 * @param {any} doc
 * @param {string} projectDir
 * @param {Array<[number, number]>} ranges
 * @returns {Promise<{ok: true, duration: number}|{ok: false, code: 'INVALID_RANGE', message: string}>}
 */
async function checkRangesWithinDuration(doc, projectDir, ranges) {
  /** @type {number} */
  let duration;
  try {
    duration = await filmDuration(doc, { projectRoot: projectDir });
  } catch (error) {
    // 量不出时长（空片 / 缺 #t= 又探不到源）不在这里拦：交给计划层报它自己的码，
    // 否则「没有片段」会被伪装成「区间不合法」，那是两条完全不同的错。
    return { ok: true, duration: 0 };
  }
  for (const [index, item] of ranges.entries()) {
    const end = Number(item[1]);
    if (end > duration + 1e-6) {
      return {
        ok: false,
        code: 'INVALID_RANGE',
        message: `第 ${index + 1} 段终点 ${end}s 超出影片时长 ${duration}s`,
      };
    }
  }
  return { ok: true, duration };
}

/**
 * 多段的 202 预览（A1）：帧数与时长跟 `planFromFilm` **同一套算术**。
 *
 * 直接调 `render/timeline-range.mjs` 的 `normalizeRanges` / `buildTimeline`（只读 import），
 * 不在这里重算一遍帧对齐——多段最容易错的就是「面板算 120 帧、作业出 119 帧」。
 *
 * fps 缺省 30：`export-job.mjs` 不传 fps 时计划层就取 30。这里跟着调用方给的 fps 才与
 * 真实作业同口径（M42 之后可以显式给 24/25/50/60）。
 *
 * @param {Array<[number, number]>} ranges
 * @param {number} duration
 * @param {number} [fps]
 * @returns {{frames: number, durationSec: number, fps: number, segments: number, ranges: Array<[number, number]>}}
 */
function summarizeRanges(ranges, duration, fps = 30) {
  try {
    const normalized = normalizeRanges(ranges, duration);
    const timeline = buildTimeline(normalized, fps);
    return {
      frames: timeline.frames,
      durationSec: timeline.outputDuration,
      fps,
      segments: timeline.segments.length,
      ranges: normalized.map((item) => [item[0], item[1]]),
    };
  } catch (error) {
    // 走不到这里：形状与越界刚刚在 validate / checkRangesWithinDuration 判过。
    // 真到了说明判据之间出现了缝隙——宁可把计划当作「不可预估」也不编一个数。
    return {
      frames: 0,
      durationSec: 0,
      fps,
      segments: ranges.length,
      ranges: ranges.map((item) => [Number(item[0]), Number(item[1])]),
      ...(/** @type {any} */ ({ warning: String(/** @type {Error} */ (error).message) })),
    };
  }
}

/**
 * `POST /api/projects/:id/media` 的边界检查。
 * 两条入口二选一：`source`（桌面版绝对路径）或 `name` + `data`（浏览器上传的 base64）。
 * @param {any} body
 * @returns {{ ok: false, code: string, message: string, status: number }
 *   | { ok: true, mode: 'path', source: string, at: number|null, track: number|null }
 *   | { ok: true, mode: 'upload', name: string, data: string, at: number|null, track: number|null }}
 */
function validateMediaRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, code: 'INVALID', message: '请求体必须是对象', status: 400 };
  }
  for (const key of Object.keys(body)) {
    if (!MEDIA_REQUEST_FIELDS.includes(key)) {
      return { ok: false, code: 'UNKNOWN_FIELD', message: `未知字段：${key}（只接受 ${MEDIA_REQUEST_FIELDS.join('/')}）`, status: 400 };
    }
  }
  const hasSource = typeof body.source === 'string' && body.source.trim() !== '';
  const hasName = typeof body.name === 'string' && body.name.trim() !== '';
  const hasData = typeof body.data === 'string' && body.data !== '';
  if (hasSource && (hasName || hasData)) {
    return { ok: false, code: 'INVALID', message: 'source 与 name/data 只能给一个', status: 400 };
  }
  if (!hasSource && !(hasName && hasData)) {
    return { ok: false, code: 'INVALID', message: '需要 source（绝对路径）或 name + data（base64 上传）', status: 400 };
  }
  /** @type {number|null} */
  let at = null;
  if (body.at !== undefined && body.at !== null) {
    const value = Number(body.at);
    if (!Number.isFinite(value) || value < 0) {
      return { ok: false, code: 'INVALID', message: 'at 必须是非负秒数', status: 400 };
    }
    at = value;
  }
  /** @type {number|null} */
  let track = null;
  if (body.track !== undefined && body.track !== null) {
    const value = Number(body.track);
    if (!Number.isInteger(value) || value < 0) {
      return { ok: false, code: 'INVALID', message: 'track 必须是非负整数', status: 400 };
    }
    track = value;
  }
  if (hasSource) return { ok: true, mode: 'path', source: body.source.trim(), at, track };
  return { ok: true, mode: 'upload', name: body.name.trim(), data: body.data, at, track };
}

/**
 * @param {any} body
 * @returns {string|null}
 */
function validateWrite(body) {
  if (body === null || typeof body !== 'object') return '请求体必须是对象';
  if (typeof body.opId !== 'string' || body.opId === '') return 'opId 必须是非空字符串';
  if (typeof body.expectedHash !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedHash)) {
    return 'expectedHash 必须是 64 位十六进制 sha256';
  }
  if (!Array.isArray(body.edits) || body.edits.length === 0) return 'edits 必须是非空数组';
  for (const edit of body.edits) {
    if (edit === null || typeof edit !== 'object' || typeof edit.clipId !== 'string' || typeof edit.field !== 'string') {
      return 'edits 每项必须包含 clipId / field';
    }
  }
  return null;
}

/** @param {string} code */
function statusForCode(code) {
  switch (code) {
    case 'CONFLICT':
      return 409;
    case 'INVALID':
      return 400;
    case 'FILM_NOT_FOUND':
      return 404;
    case 'FILM_UNREADABLE':
      return 403;
    case 'FILM_INVALID':
      return 422;
    case 'QUEUE_TIMEOUT':
      return 409;
    default:
      return 500;
  }
}

/**
 * @param {string} method
 * @param {import('node:http').ServerResponse} res
 * @param {string[]} allowed
 * @returns {boolean}
 */
function requireMethod(method, res, allowed) {
  if (allowed.includes(method)) return true;
  res.setHeader('Allow', [...allowed, 'OPTIONS'].join(', '));
  sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', allowed });
  return false;
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
  });
  res.end(payload);
}

/**
 * `/`：有构建产物就发真 UI，没有就回退状态页（页面上写明「UI 未构建」，不白屏）。
 * @param {import('node:http').ServerResponse} res
 * @param {string} method
 */
function serveIndex(res, method) {
  const file = existsSync(UI_INDEX) ? UI_INDEX : PAGE_PATH;
  try {
    const body = readFileSync(file);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store',
      'x-opencut-ui': file === UI_INDEX ? 'dist' : 'fallback',
    });
    res.end(method === 'HEAD' ? undefined : body);
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      code: 'PAGE_MISSING',
      message: `${file}: ${String(/** @type {Error} */ (error)?.message ?? error)}`,
    });
  }
}

/**
 * `/assets/<file>`：只允许 dist/assets 内的文件；MIME 按扩展名给，全部 no-store。
 * @param {import('node:http').ServerResponse} res
 * @param {string} method
 * @param {string} pathname
 */
function serveAsset(res, method, pathname) {
  /** @type {string} */
  let rel;
  try {
    rel = decodeURIComponent(pathname.slice('/assets/'.length));
  } catch {
    sendJson(res, 400, { ok: false, code: 'BAD_PATH', path: pathname });
    return;
  }
  if (rel === '' || rel.includes('\u0000')) {
    sendJson(res, 404, { ok: false, code: 'ASSET_NOT_FOUND', path: pathname });
    return;
  }
  const file = join(UI_ASSETS, rel);
  if (!file.startsWith(`${UI_ASSETS}${sep}`) || !existsSync(file)) {
    sendJson(res, 404, { ok: false, code: 'ASSET_NOT_FOUND', path: pathname });
    return;
  }
  try {
    const body = readFileSync(file);
    res.writeHead(200, {
      'content-type': MIME_BY_EXT.get(extname(file).toLowerCase()) ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    res.end(method === 'HEAD' ? undefined : body);
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      code: 'ASSET_UNREADABLE',
      message: String(/** @type {Error} */ (error)?.message ?? error),
    });
  }
}
