/**
 * 最小导出 HTTP 接口（WP10 / P10 / P14）。
 *
 * POST   /exports        body 三种形态（全部向后兼容）：
 *   1) 旧：直接是 contracts/render.ts 的 `RenderJobSpec`；
 *   2) P10：`{ spec, audioMix: { duration, sampleRate?, channels?, clips: [...] } }`
 *      —— 作业先按显式时间线混出 mix.wav（阶段 `audio`），再渲染画面、单独封装（阶段 `mux`）；
 *   3) P14：`{ spec, projectId }` —— **工程从 film.html 推导音轨**：注册表里打开着的工程
 *      按 `spec.range` 出计划，取计划的 `audioMix` 入队，`audio.source` 写作 `film`。
 *      调用方不用再单独给一份 audio-spec；工程里带网页片段就明确拒绝
 *      （`E_SCENE_RENDER_REQUIRED`），不悄悄产出少了网页的片子。
 * GET    /exports/:id    返回 RenderProgress；失败时额外带 `error`/`detail`（如 AUDIO_DECODE_FAILED）
 * DELETE /exports/:id    取消（waiting 立即，running 触发 abort；audio 阶段同样可取消）
 *
 * 只绑 127.0.0.1；不做鉴权以外的事情也不敢做鉴权之外的事情——本批仅本机，
 * 不暴露公网。未知字段一律 400，不静默忽略（合同硬规矩 3）。
 */

import http from 'node:http';

import { validateAudioMixSpec } from '../../render/audio-mix.mjs';
import { planFromFilm } from '../../render/film-plan.mjs';

/** RenderJobSpec 允许的字段；多一个都拒绝。 */
const SPEC_FIELDS = new Set([
  'jobId',
  'projectId',
  'owner',
  'kind',
  'range',
  'ranges',
  'codec',
  'frame',
  'fill',
  'shortEdge',
  'fps',
  'quality',
  'audio',
  'loudness',
  'outputDir',
  'expectedHash',
  'budget',
]);

/** 带 `spec` 的 body 只允许这三个键。 */
const BODY_FIELDS = new Set(['spec', 'audioMix', 'projectId']);

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * @param {{
 *   queue: import('../../render/job.mjs').RenderQueue,
 *   registry?: { get: (projectId: string) => any },
 *   host?: string,
 *   port?: number,
 * }} opts
 * @returns {{ handler: (req: http.IncomingMessage, res: http.ServerResponse) => void, listen: (opts?: { port?: number, host?: string }) => Promise<{ port: number, host: string }>, close: () => Promise<void>, server: http.Server }}
 */
export function createExportsApi(opts) {
  const queue = opts.queue;

  /** @type {http.Server} */
  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      sendJson(res, 500, { error: 'INTERNAL', detail: String(err instanceof Error ? err.message : err) });
    });
  });

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';

    if (url.pathname === '/health' && method === 'GET') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === '/exports' && method === 'POST') {
      const raw = await readBody(req);
      if (raw.error) {
        sendJson(res, 413, { error: 'BODY_TOO_LARGE' });
        return;
      }
      /** @type {any} */
      let body;
      try {
        body = JSON.parse(raw.text);
      } catch {
        sendJson(res, 400, { error: 'INVALID_JSON' });
        return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 400, { error: 'INVALID_SPEC' });
        return;
      }

      /** @type {any} */
      let spec;
      /** @type {any} */
      let audioMix;
      /** @type {any} */
      let projectId = null;
      /** @type {'film' | 'spec' | null} */
      let audioSource = null;

      if (Object.prototype.hasOwnProperty.call(body, 'spec')) {
        // 新 body：{ spec, audioMix? }
        const unknown = Object.keys(body).filter((key) => !BODY_FIELDS.has(key));
        if (unknown.length > 0) {
          sendJson(res, 400, { error: 'UNKNOWN_FIELD', fields: unknown });
          return;
        }
        if (!body.spec || typeof body.spec !== 'object' || Array.isArray(body.spec)) {
          sendJson(res, 400, { error: 'INVALID_SPEC' });
          return;
        }
        const specUnknown = Object.keys(body.spec).filter((key) => !SPEC_FIELDS.has(key));
        if (specUnknown.length > 0) {
          sendJson(res, 400, { error: 'UNKNOWN_FIELD', fields: specUnknown });
          return;
        }
        spec = body.spec;
        audioMix = body.audioMix;
        projectId = typeof body.projectId === 'string' && body.projectId !== '' ? body.projectId : null;
        if (audioMix !== undefined) {
          const bad = validateAudioMixSpec(audioMix);
          if (bad) {
            sendJson(res, 400, { error: 'INVALID_AUDIO_MIX', detail: bad });
            return;
          }
          // 显式 audioMix 的 payload 保持 P10 原样（不塞 source）：多出来的字段
          // 对老调用方是噪声；`source` 只在「服务端自己从 film 推导」时出现。
        }
      } else {
        // 旧 body：纯 RenderJobSpec（回归路径）
        const unknown = Object.keys(body).filter((key) => !SPEC_FIELDS.has(key));
        if (unknown.length > 0) {
          sendJson(res, 400, { error: 'UNKNOWN_FIELD', fields: unknown });
          return;
        }
        spec = body;
      }

      // P14：带工程 → 从 film.html 推导音轨（不再要求调用方另给 audio-spec）
      /** @type {any} */
      let planSummary;
      if (projectId !== null) {
        if (audioMix !== undefined) {
          sendJson(res, 400, { error: 'CONFLICTING_AUDIO_SOURCE', detail: 'pass either projectId or audioMix, not both' });
          return;
        }
        if (!opts.registry || typeof opts.registry.get !== 'function') {
          sendJson(res, 503, { error: 'E_PROJECT_REGISTRY_UNAVAILABLE' });
          return;
        }
        const project = opts.registry.get(projectId);
        if (!project || !project.doc || !project.dir) {
          sendJson(res, 404, { error: 'E_PROJECT_NOT_OPEN', projectId });
          return;
        }
        /** @type {any} */
        let plan;
        try {
          plan = await planFromFilm(project.doc, {
            projectRoot: project.dir,
            // M39：`ranges` 与 `range` 都收（`planFromFilm` 里 `ranges` 优先）。
            // 这条路径的 `queue.enqueue` 仍受 `render/job.mjs` 的「多段不支持」限制，
            // 会明确报 CODEC_UNAVAILABLE——那是渲染队列的既有边界，不在本批越权改。
            ...(spec.ranges !== undefined ? { ranges: spec.ranges } : {}),
            ...(spec.range !== undefined ? { range: spec.range } : {}),
            ...(spec.fps !== undefined ? { fps: spec.fps } : {}),
          });
        } catch (err) {
          const raw = /** @type {any} */ (err);
          sendJson(res, 400, { error: raw?.code ?? 'INVALID_FILM', detail: String(raw?.message ?? raw) });
          return;
        }
        if (plan.sceneClips.length > 0) {
          // 不静默降级：队列这条路径画不了网页片段，要整片请走 `opencut export film`
          sendJson(res, 409, {
            error: 'E_SCENE_RENDER_REQUIRED',
            detail: `${plan.sceneClips.length} web page clip(s); use the film export path that renders scenes`,
            scenes: plan.sceneClips.map((/** @type {any} */ clip) => clip.id),
          });
          return;
        }
        planSummary = {
          durationSec: plan.outputDuration,
          frames: plan.frames,
          fps: plan.fps,
          range: plan.range,
          /** 多段：完整区间与段数（M39）；单段时是 `[range]` / 1，形状不变。 */
          ranges: plan.ranges,
          segments: Array.isArray(plan.segments) ? plan.segments.length : 1,
          sceneClips: plan.sceneClips.length,
        };
        if (spec.audio === false) {
          // 调用方明确要无声：不塞音轨，也不假装有
          planSummary.audio = null;
        } else if (plan.audioMix === null) {
          sendJson(res, 409, {
            error: 'E_FILM_HAS_NO_AUDIO',
            detail: 'film has no audible clips; pass spec.audio=false for a silent export',
          });
          return;
        } else {
          audioMix = plan.audioMix;
          audioSource = 'film';
        }
      }

      const accepted = queue.enqueue(
        spec,
        audioMix === undefined ? {} : { audioMix, ...(audioSource ? { audioSource } : {}) },
      );
      if ('error' in accepted) {
        const status = accepted.error === 'INVALID_RANGE' ? 400 : accepted.error === 'CODEC_UNAVAILABLE' ? 422 : 400;
        sendJson(res, status, accepted);
        return;
      }
      sendJson(res, 202, {
        jobId: accepted.jobId,
        state: 'waiting',
        ...(audioMix !== undefined
          ? {
              audio: {
                ...(audioSource ? { source: audioSource } : {}),
                clips: audioMix.clips.length,
                durationSec: audioMix.duration,
              },
            }
          : {}),
        ...(planSummary ? { plan: planSummary } : {}),
      });
      return;
    }

    const match = url.pathname.match(/^\/exports\/([^/]+)$/);
    if (match && match[1]) {
      const jobId = decodeURIComponent(match[1]);
      if (!queue.has(jobId)) {
        sendJson(res, 404, { error: 'NOT_FOUND' });
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, queue.progress(jobId));
        return;
      }
      if (method === 'DELETE') {
        await queue.cancel(jobId);
        sendJson(res, 200, queue.progress(jobId));
        return;
      }
      sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      return;
    }

    sendJson(res, 404, { error: 'NOT_FOUND' });
  }

  return {
    server,
    handler: (req, res) => {
      void handle(req, res).catch((err) => {
        sendJson(res, 500, { error: 'INTERNAL', detail: String(err instanceof Error ? err.message : err) });
      });
    },
    /**
     * @param {{ port?: number, host?: string }} [listenOpts]
     * @returns {Promise<{ port: number, host: string }>}
     */
    listen(listenOpts = {}) {
      const port = listenOpts.port ?? opts.port ?? 59375;
      const host = listenOpts.host ?? opts.host ?? '127.0.0.1';
      return new Promise((resolve, reject) => {
        const onError = (/** @type {Error} */ err) => reject(err);
        server.once('error', onError);
        server.listen(port, host, () => {
          server.off('error', onError);
          const address = server.address();
          resolve({
            port: typeof address === 'object' && address ? address.port : port,
            host,
          });
        });
      });
    },
    /** @returns {Promise<void>} */
    close() {
      return new Promise((resolve, reject) => {
        server.close((/** @type {Error | undefined} */ err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/**
 * @param {http.IncomingMessage} req
 * @returns {Promise<{ text: string, error?: boolean }>}
 */
function readBody(req) {
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) resolve({ text: '', error: true });
      else resolve({ text: Buffer.concat(chunks).toString('utf8') });
    });
    req.on('error', () => resolve({ text: '', error: true }));
  });
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}
