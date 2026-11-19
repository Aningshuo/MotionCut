/**
 * CLI / MCP 共用的一套动作（WP18）。
 *
 * 为什么单独一层：`opencut` CLI 和 MCP server 是同一批语义的两个入口——同一条
 * `film apply` 必须同样校验 Envelope、同样按 opId 幂等、同样在越界时 `E_PATH_ESCAPE`。
 * 如果两边各写一遍，迟早有一天一边偷偷放宽了写权限。所以：
 *
 *   ops.mjs      语义与安全边界（唯一实现）
 *   index.mjs    CLI 的参数/输出/退出码
 *   mcp/*        MCP 的 JSON-RPC/tool 声明
 *
 * 这一层仍然**没有 film 解析器**：读写全部走注入的 `film` 端口（本树默认
 * `WAIT_MAIN_FILM`，集成时由 main 接线）。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CliError } from './errors.mjs';
import { resolveInside } from './paths.mjs';
import { validate } from './jsonschema.mjs';
import * as S from './schema.mjs';
import { summarizeFilm } from './summary.mjs';
import { createOpIdLedger, digestOf } from './opid.mjs';

/**
 * 字节的 sha256。**不要用 `digestOf(Buffer)`**：那个函数是给 opId ledger 的 JSON 值用的，
 * 它内部走 `JSON.stringify`——传 Buffer 会hash `{"type":"Buffer","data":[…]} `的 JSON 文本，
 * 得到的不是文件摘要（R24 发现：VTT/fcpxml 的 `sha256` 一直是这么错的）。
 * @param {Buffer} body
 * @returns {string}
 */
export function bytesDigest(body) {
  return createHash('sha256').update(body).digest('hex');
}
import { validateAudioMixSpec } from '../render/audio-mix.mjs';
import { renderGif } from '../render/gif.mjs';
import { captureStills, cropPng, pngToJpg } from '../render/stills.mjs';
import { renderStems } from '../render/stems.mjs';
import {
  applyPixFmt,
  codecQuality,
  describeCodec,
  requiredEncoders,
  resolveCodec,
  resolvePixFmtMode,
} from '../render/codec-matrix.mjs';
import { durationOfFrames, rateOfFps } from '../render/fps.mjs';
import { resolveQuality } from '../render/quality.mjs';
import { checkEncoders } from '../render/ffmpeg.mjs';
import { planFromFilm } from '../render/film-plan.mjs';
import { requiresTransitionStage } from '../film-core/transition-presets.mjs';
import { requiresCreationStyleStage } from '../film-core/creation-style-stage.mjs';
import { assertSceneClipsReady, wrapSceneCaptureError } from '../render/scene-clips.mjs';
import { renderFilmExport, summarizeFilmExport } from '../render/film-export.mjs';
import { planDelivery, sizeFootprint } from '../render/delivery-size.mjs';
import { prepareSubtitleBurn, buildVttDocument, subtitleStyleAuditReport } from '../render/subtitles.mjs';
import { resolveSubtitleStyle } from '../render/subtitle-style-source.mjs';
import { startResourceMonitor } from '../render/budget-guard.mjs';
import { createExportJob } from '../render/export-job.mjs';
import { specFpsProblem } from '../render/job.mjs';
import { analyzeAlphaFrames, resolveAlphaFormat, resolvePngSeqPaths, writeAlphaOutput } from '../render/alpha-export.mjs';
import { resolveAlphaMode } from '../render/alpha-polarity.mjs';
import { resolveLoudnessPreset, summarizeLoudness } from '../render/loudness.mjs';

/**
 * 透明产物摘要（P31/P33）：CLI 输出与交接共用的那一层。
 * `audio` 永远是 null —— 透明导出只出画面（理由见 alpha-export.mjs 文件头）。
 * @param {any} written
 */
function summarizeAlpha(written) {
  return {
    format: written.kind,
    path: written.path,
    ...(written.dir ? { dir: written.dir } : {}),
    bytes: written.bytes,
    sha256: written.sha256,
    frames: written.frames,
    size: written.size,
    audio: null,
    ...(written.mode ? { mode: written.mode } : {}),
    ...(written.polarity ? { polarity: written.polarity } : {}),
    ...(written.dirKept !== undefined ? { dirKept: written.dirKept } : {}),
    ...(written.volumes ? { volumes: written.volumes, volumeCount: written.volumeCount, totalBytes: written.totalBytes } : {}),
    ...(written.budget ? { budget: written.budget } : {}),
    ...(written.pixFmt ? { pixFmt: written.pixFmt } : {}),
    ...(written.reportPath ? { reportPath: written.reportPath } : {}),
    ...(written.entries ? { entries: written.entries } : {}),
    encodedAlpha: written.encodedAlpha ?? [],
  };
}

const MAX_JSON_BYTES = 5 * 1024 * 1024;

/**
 * @typedef {Object} Context
 * @property {string} root
 * @property {string} cwd
 * @property {string} outputRoot
 * @property {Record<string, any>} env
 * @property {string} stateDir
 * @property {{ lookup: Function, record: Function, assertSamePayload: Function }} ledger
 * @property {(line: string) => void} log
 * @property {(name: 'film' | 'render' | 'projects') => any} port
 */

/**
 * @param {{
 *   projects?: any, film?: any, render?: any,
 *   env?: Record<string, any>, root?: string, cwd?: string, stateDir?: string,
 *   ledger?: any, log?: (line: string) => void, now?: () => number,
 * }} [deps]
 * @returns {Context}
 */
export function createContext(deps = /** @type {any} */ ({})) {
  const env = deps.env ?? {};
  const cwd = path.resolve(deps.cwd ?? process.cwd());
  const root = path.resolve(deps.root ?? env.projectsRoot ?? cwd);
  const outputRoot = env.outputRoot ? path.resolve(env.outputRoot) : path.join(root, 'output');
  const stateDir = path.resolve(
    deps.stateDir ?? (env.tmpRoot ? path.join(env.tmpRoot, 'cli-state') : path.join(os.tmpdir(), 'opencut-cli')),
  );
  const ledger = deps.ledger ?? createOpIdLedger({ dir: stateDir, ...(deps.now ? { now: deps.now } : {}) });
  const log = deps.log ?? ((line) => process.stderr.write(`${line}\n`));

  return {
    root,
    cwd,
    outputRoot,
    env,
    stateDir,
    ledger,
    log,
    /**
     * @param {'film' | 'render' | 'projects'} name
     */
    port(name) {
      const value = deps[name];
      if (!value) {
        throw new CliError(
          'WAIT_MAIN_FILM',
          `${name} port not wired: integration point (WAIT_MAIN_FILM); pass --${name}-module to bin.mjs`,
        );
      }
      return value;
    },
  };
}

/**
 * @param {unknown} err
 * @returns {CliError}
 */
export function normalizeError(err) {
  if (err instanceof CliError) return err;
  const raw = /** @type {any} */ (err);
  const code = typeof raw?.code === 'string' ? raw.code : null;
  const message = typeof raw?.message === 'string' ? raw.message : String(raw);
  const known = [
    'CONFLICT',
    'E_PATH_ESCAPE',
    'NOT_FOUND',
    'INVALID',
    'IO',
    'LOCKED',
    'QUEUE_TIMEOUT',
    'WAIT_MAIN_FILM',
    'INVALID_RANGE',
    'MEDIA_MISSING',
    'MEDIA_DURATION_UNKNOWN',
    'UNSUPPORTED_SCENE_CLIP',
    'UNSUPPORTED',
    'INVALID_FILM',
    'EMPTY_FILM',
    'OUTPUT_UNVERIFIED',
    'CANCELLED',
    // 舞台取帧的五种失败各自保留原码：吞成 JOB_FAILED 就分不清「场景没有 film」
    // 和「场景抛错」「超时」——P15 的验收正是按这几个码数着看的。
    'NO_FILM',
    'FRAME_THREW',
    'FRAME_TIMEOUT',
    'STAGE_BOOT_FAILED',
    'PROJECT_NOT_OPEN',
    // 字幕/预算：各自保留原码，别让它们退化成 JOB_FAILED——
    // 「vtt 坏了」「系统没字体覆盖这个字」「ffmpeg 没 libass」是三件完全不同的事。
    'SUBTITLE_PARSE_FAILED',
    'SUBTITLE_MISSING_GLYPH',
    'SUBTITLE_UNSUPPORTED',
    'SUBTITLE_BURN_UNAVAILABLE',
    'BUDGET_EXCEEDED',
    // 作业层（P28）：输出被占 / 已取消各自保留原码，脚本才能只靠 code 分支
    'EXPORT_OUTPUT_BUSY',
    'EXPORT_CANCELLED',
    // 场景取帧的统一失败码（P27）：底层 NO_FILM/FRAME_THREW/FRAME_TIMEOUT 收在 detail 里
    'SCENE_CAPTURE_FAILED',
    // 透明输出（P31）：目录不可写是 IO（exit 6），不是作业失败——
    // 「换个目录就能过」与「跑到一半挂了」必须能靠退出码分开。
    'EXPORT_OUTPUT_UNWRITABLE',
    'ALPHA_REQUIRES_STAGE',
    'ALPHA_ENCODE_LOST',
  ];
  // 取消只有一个出口：信号打断取帧与 ffmpeg 打断渲染是同一件事
  if (code === 'CAPTURE_CANCELLED') {
    return new CliError('CANCELLED', message);
  }
  // 档名写错是用法问题，不是作业失败
  if (code === 'INVALID_QUALITY') {
    return new CliError('INVALID', message);
  }
  /* P68：样式文件里写了非法值（字号 ≤0 / 颜色不可解析）是参数问题，归 2 而不是 8。 */
  if (code === 'INVALID_SUBTITLE_STYLE') {
    return new CliError('INVALID', message);
  }
  if (code && known.includes(code)) {
    // 结构化字段一并带出去：宿主靠 `reason`/`causeCode`/`clipId` 分支，
    // 而不是去 message 里正则匹配（P27 的失败分级就是要这几个字段）
    return new CliError(/** @type {any} */ (code), message, {
      ...(raw.currentHash ? { currentHash: raw.currentHash } : {}),
      ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
      ...(typeof raw.causeCode === 'string' ? { causeCode: raw.causeCode } : {}),
      ...(typeof raw.clipId === 'string' ? { clipId: raw.clipId } : {}),
      ...(typeof raw.t === 'number' ? { t: raw.t } : {}),
      ...(typeof raw.detail === 'string' && raw.detail !== '' ? { detail: raw.detail } : {}),
    });
  }
  return new CliError('JOB_FAILED', message);
}

/**
 * @param {unknown} value
 * @param {any} schema
 * @param {string} what
 * @returns {void}
 */
export function assertSchema(value, schema, what) {
  const checked = validate(schema, value);
  if (!checked.ok) {
    const first = checked.errors[0];
    throw new CliError('INVALID', `${what}: ${first?.path} ${first?.message}`, { errors: checked.errors.slice(0, 8) });
  }
}

/**
 * @param {string} cwd
 * @param {string} file
 * @param {string} what
 * @returns {Promise<any>}
 */
export async function readJsonFile(cwd, file, what) {
  const abs = path.resolve(cwd, file);
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw new CliError('NOT_FOUND', `${what}: ${abs} does not exist`, { file: abs });
  }
  if (!stat.isFile()) throw new CliError('INVALID', `${what}: ${abs} is not a file`, { file: abs });
  if (stat.size > MAX_JSON_BYTES) {
    throw new CliError('INVALID', `${what}: ${abs} is larger than ${MAX_JSON_BYTES} bytes`, { file: abs });
  }
  const text = await fs.readFile(abs, 'utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new CliError('INVALID', `${what}: invalid JSON in ${abs}: ${/** @type {Error} */ (err).message}`, { file: abs });
  }
}

/**
 * 解析工程路径（沙箱内），并确认它是已存在的目录。
 * @param {Context} ctx
 * @param {string | undefined} input
 * @returns {Promise<string>}
 */
export async function resolveProject(ctx, input) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new CliError('E_USAGE', 'a project path is required');
  }
  const abs = await resolveInside(ctx.root, input, { base: ctx.cwd, what: 'project' });
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw new CliError('NOT_FOUND', `project: ${abs} does not exist`, { project: abs });
  }
  if (!stat.isDirectory()) throw new CliError('INVALID', `project: ${abs} is not a directory`, { project: abs });
  return abs;
}

/**
 * 把 film 端口的读结果归一化。
 *
 * `options.requireDoc`（M88）：导出类命令**必须**有 doc。端口的 `read()` 允许
 * `doc:null` + `diagnostics`（`film read` 就是靠这个把 `TIME_PAST_END` 报给人看的），
 * 但下游 `planFromFilm(null)` 只会抛一句 `doc.tracks must be an array` —— 诊断被吞掉，
 * 用户看到的是句废话。这里把**诊断自己的 code / clipId / message** 原样透出来
 * （退出码仍是 2：越界出点是参数/工程组合不成立，判据不变）。
 *
 * @param {any} readResult
 * @param {string} project
 * @param {{ requireDoc?: boolean }} [options]
 */
export function normalizeRead(readResult, project, options = {}) {
  if (readResult && readResult.ok === false) {
    const error = readResult.error ?? {};
    throw normalizeError(Object.assign(new Error(error.message ?? 'film read failed'), error));
  }
  const sourceHash = readResult?.sourceHash;
  const doc = readResult?.doc ?? null;
  const diagnostics = Array.isArray(readResult?.diagnostics) ? readResult.diagnostics : [];
  if (options.requireDoc === true && (doc === null || doc === undefined)) {
    const first = diagnostics.find((/** @type {any} */ item) => item?.severity === 'error') ?? diagnostics[0] ?? null;
    throw new CliError(first?.code ?? 'INVALID_FILM', String(first?.message ?? 'film.html 解析不出 FilmDoc'), {
      ...(typeof first?.clipId === 'string' ? { clipId: first.clipId } : {}),
      ...(typeof first?.code === 'string' ? { reason: first.code } : {}),
    });
  }
  if (typeof sourceHash !== 'string' || !/^[0-9a-f]{64}$/.test(sourceHash)) {
    throw new CliError('E_OUTPUT_INVALID', 'film.read returned no sha256 sourceHash; refusing to print unknown state');
  }
  return { ok: true, project, sourceHash, doc, diagnostics };
}

/**
 * @param {Context} ctx
 * @returns {Promise<Array<{ id: string, name?: string, path: string }>>}
 */
export async function listProjects(ctx) {
  const port = ctx.port('projects');
  if (typeof port.list !== 'function') throw new CliError('WAIT_MAIN_FILM', 'projects port has no list()');
  const projects = await port.list();
  if (!Array.isArray(projects)) throw new CliError('E_OUTPUT_INVALID', 'projects.list() must return an array');
  const rows = projects.map((p) => ({
    id: String(p?.id ?? ''),
    ...(typeof p?.name === 'string' ? { name: p.name } : {}),
    path: String(p?.path ?? ''),
  }));
  assertSchema({ ok: true, projects: rows }, S.projectListOutput, 'project list');
  return rows;
}

/**
 * @param {Context} ctx
 * @param {string | undefined} input
 */
export async function readFilm(ctx, input) {
  const project = await resolveProject(ctx, input);
  const result = normalizeRead(await ctx.port('film').read(project), project);
  assertSchema(result, S.filmReadOutput, 'film read');
  return result;
}

/**
 * @param {Context} ctx
 * @param {string | undefined} input
 */
export async function projectInfo(ctx, input) {
  const project = await resolveProject(ctx, input);
  const read = normalizeRead(await ctx.port('film').read(project), project);
  const summary = summarizeFilm(read.doc, read.diagnostics);
  const result = { ok: true, project, sourceHash: read.sourceHash, ...summary };
  assertSchema(result, S.projectInfoOutput, 'project info');
  return result;
}

/**
 * 应用一批 Op。`payload` 是 `{envelope, ops}`（与 `--ops` 文件同形）。
 * @param {Context} ctx
 * @param {string | undefined} input
 * @param {any} payload
 * @param {{ dryRun?: boolean, studio?: { baseUrl: string, grantId: string, projectId?: string } }} [opts]
 * @returns {Promise<{ result: any, replayed: boolean }>}
 */
export async function applyOps(ctx, input, payload, opts = {}) {
  const project = await resolveProject(ctx, input);
  assertSchema(payload, S.opsFile, 'ops');

  const { envelope, ops } = payload;

  /* CS2：有 Studio 写入口时，**一切写入都走它** —— 这样这笔改动才进原撤销栈。
     本地 ledger 不再参与（Studio 的 opLog 按同一个 opId 幂等）。 */
  if (opts.studio !== undefined && opts.studio !== null) {
    return {
      replayed: false,
      result: await applyOpsThroughStudio(project, envelope, ops, opts.studio),
    };
  }
  if (envelope.projectId !== path.basename(project)) {
    ctx.log(`warn: envelope.projectId "${envelope.projectId}" != project directory "${path.basename(project)}"`);
  }

  if (opts.dryRun) {
    const current = normalizeRead(await ctx.port('film').read(project), project);
    if (current.sourceHash !== envelope.expectedHash) {
      throw new CliError('CONFLICT', 'expectedHash does not match current film.html', {
        currentHash: current.sourceHash,
      });
    }
    return {
      replayed: false,
      result: {
        ok: true,
        project,
        hash: current.sourceHash,
        opId: envelope.opId,
        dryRun: true,
        ops: ops.length,
      },
    };
  }

  const digest = digestOf({ ops, expectedHash: envelope.expectedHash, projectId: envelope.projectId });
  await ctx.ledger.assertSamePayload(project, envelope.opId, digest);
  const replayed = await ctx.ledger.lookup(project, envelope.opId);
  if (replayed) {
    ctx.log(`opId ${envelope.opId} replayed: returning first result, no write`);
    return {
      replayed: true,
      result: {
        ok: true,
        project,
        hash: replayed.hash,
        opId: envelope.opId,
        replayed: true,
        ops: ops.length,
      },
    };
  }

  const applied = await ctx.port('film').applyOps(project, envelope, ops);
  if (!applied || applied.ok !== true) {
    const error = applied?.error ?? { code: 'JOB_FAILED', message: 'film.applyOps returned no result' };
    throw normalizeError(Object.assign(new Error(error.message ?? error.code), error));
  }
  if (typeof applied.hash !== 'string' || !/^[0-9a-f]{64}$/.test(applied.hash)) {
    throw new CliError('E_OUTPUT_INVALID', 'film.applyOps returned no sha256 hash');
  }

  await ctx.ledger.record(project, envelope.opId, { hash: applied.hash, digest });
  return {
    replayed: false,
    result: {
      ok: true,
      project,
      hash: applied.hash,
      opId: envelope.opId,
      ops: ops.length,
      ...(Array.isArray(applied.touched) ? { touched: applied.touched } : {}),
    },
  };
}

/**
 * 只读提案（CS2 · R30-125）：校验 + 在内存里演算一批 Op，**不写盘**。
 *
 * 给 GUI 的 ACP agent 用：它先把要改的东西作为提案交给产品校验，用户在面板上点
 * 「应用」之后才真的走 `/ops`。返回值里带 `inverse`，便于调用方展示「这一步能撤回什么」。
 *
 * @param {Context} ctx
 * @param {string | undefined} input 工程（绝对路径或沙箱内相对名）
 * @param {{ envelope: any, ops: any[] }} payload
 */
export async function proposeOps(ctx, input, payload) {
  const project = await resolveProject(ctx, input);
  assertSchema(payload, S.opsFile, 'ops');
  const { envelope, ops } = payload;
  if (envelope.projectId !== path.basename(project)) {
    ctx.log(`warn: envelope.projectId "${envelope.projectId}" != project directory "${path.basename(project)}"`);
  }
  const proposed = await ctx.port('film').propose(project, envelope, ops);
  if (!proposed || proposed.ok !== true) {
    const error = proposed?.error ?? { code: 'JOB_FAILED', message: 'film.propose returned no result' };
    throw normalizeError(Object.assign(new Error(error.message ?? error.code), error));
  }
  return {
    ok: true,
    project,
    hash: proposed.sourceHash,
    opId: envelope.opId ?? null,
    ops: ops.length,
    changed: proposed.changed === true,
    touched: Array.isArray(proposed.touched) ? proposed.touched : [],
    inverse: Array.isArray(proposed.inverse) ? proposed.inverse : [],
    ...(typeof proposed.nextHash === 'string' ? { nextHash: proposed.nextHash } : {}),
    wrote: false,
  };
}

/**
 * 经 Studio 的 `/api/projects/:id/ops` 写盘（CS2 · R30-125）。
 *
 * 为什么必须走它：MCP 直写 `film.html` 不进 Studio 的撤销栈 —— 用户在 GUI 里点
 * 「撤销」会说「没有可撤销的编辑」（CS1 实测）。受控写要纳入**原历史栈**，就只能走
 * 这个唯一写入口。授权凭票（`x-opencut-agent-grant`），Studio 侧核票、核工程、核工具。
 *
 * @param {string} project 已解析的工程目录
 * @param {{ opId: string, expectedHash: string, batchId?: string, owner?: string }} envelope
 * @param {readonly any[]} ops
 * @param {{ baseUrl: string, grantId: string, projectId?: string }} studio
 */
async function applyOpsThroughStudio(project, envelope, ops, studio) {
  /* 工程 id 由调用方给（序列作用域 id 形如 `P::seq`，不是目录名）。缺省才回落到目录名。 */
  const projectId = typeof studio.projectId === 'string' && studio.projectId !== '' ? studio.projectId : path.basename(project);
  const url = `${studio.baseUrl.replace(/\/+$/, '')}/api/projects/${encodeURIComponent(projectId)}/ops`;
  /** @type {any} */
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-opencut-agent-grant': studio.grantId,
      },
      body: JSON.stringify({ envelope, ops }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new CliError('STUDIO_UNREACHABLE', `写入口不可达：${url}（${String(/** @type {any} */ (error)?.message ?? error)}）`, {
      baseUrl: studio.baseUrl,
    });
  }
  /** @type {any} */
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.ok !== true || body?.ok !== true) {
    const code = typeof body?.code === 'string' && body.code !== '' ? body.code : `HTTP_${String(response.status)}`;
    throw new CliError(code, String(body?.message ?? `Studio 拒绝写入（HTTP ${String(response.status)}）`), {
      ...(typeof body?.currentHash === 'string' ? { currentHash: body.currentHash } : {}),
      ...(body?.detail !== undefined ? { detail: body.detail } : {}),
    });
  }
  return {
    ok: true,
    hash: String(body.hash),
    touched: Array.isArray(body.touched) ? body.touched : [],
    changed: body.changed !== false,
    undoDepth: Number(body.undoDepth ?? 0),
    redoDepth: Number(body.redoDepth ?? 0),
    ...(body.agent !== undefined && body.agent !== null ? { agent: body.agent } : {}),
    via: 'studio',
  };
}

/**
 * The library shares Studio's actual per-project domain, jobs and history. A detached
 * CLI cannot start a second registry against a project already open in the editor.
 * @param {Context} ctx
 * @param {unknown} projectArg
 * @param {{ studio?: { baseUrl: string, grantId?: string, projectId?: string }, request?: any }} [opts]
 */
async function creationLibraryThroughStudio(ctx, projectArg, opts = {}) {
  const project = await resolveInside(ctx.root, String(projectArg ?? ''), { base: ctx.cwd, what: 'project' });
  const studio = opts.studio;
  if (!studio?.baseUrl) throw new CliError('NEEDS_STUDIO', '素材库操作需要正在运行的 Studio；请提供 --studio-url 与准确 --project-id，媒体任务使用原服务');
  const base = new URL(studio.baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) || base.username || base.password) throw new CliError('E_USAGE', 'Studio 地址必须是本机 HTTP(S) 服务');
  const projectId = studio.projectId || path.basename(project);
  if (opts.request && !studio.grantId) throw new CliError('E_WRITE_DENIED', '素材库动作需要原 Studio 工程写授权票，不能绕过权限入口');
  const url = `${studio.baseUrl.replace(/\/+$/, '')}/api/projects/${encodeURIComponent(projectId)}/creation-library${opts.request ? '/actions' : ''}`;
  let response;
  try {
    response = await fetch(url, { method: opts.request ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(studio.grantId ? { 'x-opencut-agent-grant': studio.grantId } : {}) }, ...(opts.request ? { body: JSON.stringify(opts.request) } : {}), signal: AbortSignal.timeout(30_000) });
  } catch (error) { throw new CliError('STUDIO_UNREACHABLE', `素材库服务不可达：${String(/** @type {any} */ (error)?.message ?? error)}`); }
  const body = /** @type {any} */ (await response.json().catch(() => null));
  if (!response.ok || body?.ok === false || body === null) throw new CliError(body?.code ?? `HTTP_${response.status}`, String(body?.message ?? 'Studio 拒绝素材库操作'));
  return body;
}
/** @param {Context} ctx @param {unknown} project @param {{ studio?: {baseUrl:string,grantId?:string,projectId?:string} }} [opts] */
export async function readCreationLibrary(ctx, project, opts = {}) { return creationLibraryThroughStudio(ctx, project, opts); }
/** @param {Context} ctx @param {unknown} project @param {any} request @param {{ studio?: {baseUrl:string,grantId?:string,projectId?:string} }} [opts] */
export async function applyCreationLibrary(ctx, project, request, opts = {}) {
  if (!request || typeof request.action !== 'string' || !request.action) throw new CliError('E_USAGE', 'library-action 需要包含 action 的JSON文件');
  if (typeof request.opId !== 'string' || !request.opId.trim()) throw new CliError('E_USAGE', 'library-action 必须提供稳定 opId，重试时原样使用');
  return creationLibraryThroughStudio(ctx, project, { ...opts, request });
}

/**
 * @param {Context} ctx
 * @param {string | undefined} input
 * @param {any} draft 未补全的 RenderJobSpec
 * @param {{ dryRun?: boolean, audioMix?: any, studio?: { baseUrl: string, grantId: string, projectId?: string } }} [opts]
 */
export async function startExport(ctx, input, draft, opts = {}) {
  const project = await resolveProject(ctx, input);
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    throw new CliError('INVALID', 'spec: must be a JSON object');
  }
  const spec = { ...draft };
  if (typeof spec.jobId !== 'string' || spec.jobId.length === 0) throw new CliError('INVALID', 'spec.jobId is required');
  if (typeof spec.projectId !== 'string' || spec.projectId.length === 0) {
    throw new CliError('INVALID', 'spec.projectId is required');
  }
  if (typeof spec.kind !== 'string' || spec.kind.length === 0) throw new CliError('INVALID', 'spec.kind is required');
  if (typeof spec.expectedHash !== 'string' || !/^[0-9a-f]{64}$/.test(spec.expectedHash)) {
    throw new CliError('INVALID', 'spec.expectedHash must be a sha256 hex string');
  }
  /* 帧率（P44）：与 `export film` 同一个码 INVALID_FPS（退出码 2）。在**建作业之前**
     拦下来——非法帧率不该占用一个 jobId，更不该落任何文件；`--dry-run` 也走这条。 */
  const fpsProblem = specFpsProblem(spec.fps);
  if (fpsProblem) throw new CliError('INVALID_FPS', fpsProblem);

  // 输出目录必须落在沙箱内；这是唯一会给 CLI 带来"写文件"后果的参数。
  const outputDir =
    typeof spec.outputDir === 'string' && spec.outputDir.length > 0 ? spec.outputDir : path.join(ctx.outputRoot, spec.jobId);
  // 产物目录本来就可能在工程根之外（env.outputRoot），所以额外放行这一个根
  spec.outputDir = await resolveInside(ctx.root, outputDir, { base: ctx.root, what: 'outputDir', also: [ctx.outputRoot] });

  // 音频时间线（可选）：先本地校验结构，再把整块透传给 render 端口；
  // 素材是否存在只能在渲染阶段知道（失败会以 AUDIO_DECODE_FAILED 回来）。
  const audioMix = opts.audioMix;
  if (audioMix !== undefined) {
    const bad = validateAudioMixSpec(audioMix);
    if (bad) throw new CliError('INVALID', `audioMix: ${bad}`);
  }
  const audioSummary =
    audioMix !== undefined ? { clips: audioMix.clips.length, durationSec: audioMix.duration } : undefined;

  /* P68：样式审计写进 spec.json（作业产物可查）；文件坏在这里失败，不静默用默认值出片。 */
  const styleSource = await resolveSubtitleStyle({
    projectRoot: project,
    ...(spec.subtitleStyle !== undefined ? { explicit: spec.subtitleStyle } : {}),
  }).catch((error) => { throw new CliError('INVALID', String(/** @type {any} */ (error)?.message ?? error)); });
  spec.subtitleStyleAudit = await subtitleStyleAuditReport(styleSource, { projectRoot: project });

  if (opts.dryRun) {
    return {
      result: { ok: true, jobId: spec.jobId, dryRun: true, spec, ...(audioSummary ? { audio: audioSummary } : {}) },
      spec,
      project,
      ...(audioMix !== undefined ? { audioMix } : {}),
    };
  }

  const started = await ctx.port('render').start(spec, audioMix !== undefined ? { audioMix } : {});
  if (!started || typeof started.jobId !== 'string') {
    /* 端口拒绝作业时**原样透出它的码**：这些码各自有含义与退出码，
       包成 JOB_FAILED 会让「编码器没编进来」（CODEC_UNAVAILABLE）和
       「工程没有可保留的透明度」（ALPHA_REQUIRES_STAGE）都变成同一条 8。
       P44 只给 INVALID_FPS 开了这个口子；P47 把同一规则扩到整组。 */
    const code = typeof started?.error === 'string' ? started.error : 'JOB_FAILED';
    const passthrough = new Set([
      'CODEC_UNAVAILABLE',
      'ALPHA_REQUIRES_STAGE',
      'INVALID_RANGE',
      'INVALID_FPS',
      'INVALID',
      'NOT_FOUND',
      'CANCELLED',
      // P50：同一个 outputDir 已被活着的作业占着。归 CONFLICT（3）——
      // 换个目录就能成功，与「参数写错」（2）不是一类。
      'EXPORT_OUTPUT_BUSY',
      'CONFLICT',
      // P52：内存压力下不放新作业。归 CONFLICT（3）——「现在不行，等会儿再来」，
      // 与「参数写错」（2）不是一类；detail 里带实测值/阈值/记录路径。
      'RESOURCE_PRESSURE',
    ]);
    if (passthrough.has(code)) {
      throw new CliError(/** @type {any} */ (code), String(started?.detail ?? `render.start refused the job: ${code}`), {
        ...(started?.detail ? { detail: started.detail } : {}),
      });
    }
    throw new CliError('JOB_FAILED', `render.start refused the job: ${started?.error ?? 'JOB_FAILED'}`, {
      detail: started?.detail,
    });
  }
  return {
    result: {
      ok: true,
      jobId: started.jobId,
      state: 'waiting',
      // P47：端口是 detached worker 时把 pid 带出来，调用方/验收能直接看作业是否还活着
      ...(Number.isInteger(started.pid) && started.pid > 0 ? { pid: started.pid } : {}),
      ...(audioSummary ? { audio: audioSummary } : {}),
    },
    spec,
    project,
  };
}

/**
 * `export film --estimate`：只估算，不导出、不写盘。
 *
 * 与 `exportFilm` 共用同一份计划（`planFromFilm`），差别只在末尾：
 * 这里做一次素材体检（ffprobe 只读）然后把账算出来。**全程不写任何文件**——
 * 不写占位帧、不写日志、不建临时目录，所以可以放心在正式导出前反复跑。
 *
 * @param {Context} ctx
 * @param {string | undefined} input
 * @param {{ range?: [number, number], ranges?: Array<readonly [number, number]>, fps?: number,
 *   fpsRational?: { num: number, den: number }, quality?: string, concurrency?: number,
 *   settleMsPerFrame?: number, maxScanMs?: number }} [opts]
 * @returns {Promise<{ result: any, plan: any }>}
 */
export async function estimateFilmExport(ctx, input, opts = {}) {
  const project = await resolveProject(ctx, input);
  const read = normalizeRead(await ctx.port('film').read(project), project, { requireDoc: true });
  const plan = await planFromFilm(read.doc, {
    projectRoot: project,
    ...(opts.fps !== undefined ? { fps: opts.fps } : {}),
    ...(opts.fpsRational !== undefined ? { fpsRational: opts.fpsRational } : {}),
    ...(opts.range !== undefined ? { range: opts.range } : {}),
    ...(opts.ranges !== undefined ? { ranges: opts.ranges } : {}),
  });

  const { probeVideoProfile } = await import('../render/media-probe.mjs');
  const { estimateExport } = await import('../render/export-estimate.mjs');

  // 只有需要 seek 的视频源才要体检；静帧/音频不进 GOP 模型
  const sources = Array.from(
    new Set(
      plan.visualClips
        .filter((/** @type {any} */ clip) => (clip.kind ?? 'video') === 'video')
        .map((/** @type {any} */ clip) => String(clip.src)),
    ),
  );
  /** @type {any[]} */
  const profiles = [];
  for (const src of sources) {
    if (opts?.maxScanMs !== undefined) {
      profiles.push(await probeVideoProfile(src, { maxScanMs: opts.maxScanMs }));
    } else {
      profiles.push(await probeVideoProfile(src));
    }
    ctx.log(`probe ${path.basename(src)}: gop=${profiles[profiles.length - 1].avgGopSec}s kf=${profiles[profiles.length - 1].keyframeCount}`);
  }

  const result = estimateExport({
    plan,
    profiles,
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    ...(opts.settleMsPerFrame !== undefined ? { settleMsPerFrame: opts.settleMsPerFrame } : {}),
    ...(opts.quality !== undefined ? { quality: opts.quality } : {}),
  });
  return { result: { ok: true, project, estimate: result, profiles }, plan };
}

/**
 * `export fcpxml`：把时间线导成 FCPXML 1.9（给别的 NLE 继续剪）。
 *
 * 只做结构转换：不转码、不内嵌媒体。素材时长用 `probeMedia` 读真实值，
 * 读不到就退回 plan 的入出点（宁可短一点，也不要写一个超过素材长度的 duration）。
 *
 * 写完必须**回读对账**（片段数/offset/duration/总时长）。对不上就 `OUTPUT_UNVERIFIED`：
 * 文件留在盘上供排查，但退出码非 0——一份"看起来生成了"的坏 XML 比没有更糟。
 *
 * @param {Context} ctx
 * @param {string | undefined} input
 * @param {{ out?: string, fps?: number, range?: [number, number] }} [opts]
 * @returns {Promise<{ result: any, plan: any }>}
 */
export async function exportFcpxml(ctx, input, opts = {}) {
  const project = await resolveProject(ctx, input);
  if (!opts.out) throw new CliError('E_USAGE', 'export fcpxml needs --out <file.fcpxml>');
  const read = normalizeRead(await ctx.port('film').read(project), project, { requireDoc: true });
  const plan = await planFromFilm(read.doc, {
    projectRoot: project,
    ...(opts.fps !== undefined ? { fps: opts.fps } : {}),
    ...(opts.range !== undefined ? { range: opts.range } : {}),
  });

  const { buildFcpxml, verifyFcpxml } = await import('../render/fcpxml.mjs');
  const { probeMedia } = await import('../render/verify.mjs');

  const srcs = Array.from(
    new Set([
      ...plan.visualClips.map((/** @type {any} */ clip) => String(clip.src)),
      ...(plan.audioMix ? plan.audioMix.clips.map((/** @type {any} */ clip) => String(clip.src)) : []),
    ]),
  );
  /** @type {any[]} */
  const assets = [];
  for (const src of srcs) {
    try {
      const probe = await probeMedia(src);
      assets.push({
        src,
        durationSec: probe.format.durationSec ?? probe.video?.durationSec ?? probe.audio?.durationSec ?? null,
        hasVideo: Boolean(probe.video),
        hasAudio: Boolean(probe.audio),
        name: path.basename(src),
      });
    } catch {
      // 读不到就交给 buildFcpxml 用 plan 的入出点兜底：不猜、不编
      assets.push({ src, name: path.basename(src) });
    }
  }

  const xml = buildFcpxml(plan, { projectName: path.basename(project), assets });
  const outPath = await resolveInside(ctx.root, opts.out, { base: ctx.cwd, what: 'out', also: [ctx.outputRoot] });
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, xml, 'utf8');
  const body = Buffer.from(xml, 'utf8');
  const check = verifyFcpxml(xml, plan);

  if (!check.ok) {
    throw new CliError('OUTPUT_UNVERIFIED', `fcpxml readback mismatch: ${check.problems.join('; ')}`);
  }

  return {
    result: {
      ok: true,
      project,
      path: outPath,
      bytes: body.length,
      sha256: bytesDigest(body),
      version: check.version,
      clips: check.visualClipsInXml,
      gaps: check.gaps.length,
      durationSec: plan.outputDuration,
      frames: plan.frames,
      check: {
        clipCount: check.clipCount,
        expectedClips: check.expectedClips,
        durationFrames: check.durationFrames,
        expectedFrames: check.expectedFrames,
        problems: check.problems,
      },
    },
    plan,
  };
}

/**
 * `export film`：film 端口 → 计划 → 真实渲染（无声画面 + 混音 + 封装 + 校验）。
 *
 * 三个可选增强，默认全关（回归：不传就是老行为，逐字节一致）：
 * - `--size` / `--fit`（P24）：舞台按目标视口真渲染，不是把 720p 放大。
 * - `--subtitle-burn`（P23）：三件套 `<name>-master.mp4` / `<name>-subbed.mp4` / `<name>.vtt`。
 * - `--budget-mem-mb` / `--budget-sec`（P24-A5）：超限报 `BUDGET_EXCEEDED` 并停，不留半成品。
 * - `--alpha` / `--alpha-format`（P31）：透明输出（ProRes 4444 / PNG 序列 + zip），
 *   **只出画面、不出音轨**；报告里如实写有没有 alpha。
 * - `--alpha-mode`（P33）：alpha 极性（预乘/非预乘），默认随格式走。
 * - `--loudness off|streaming|broadcast`（P34）：两遍 loudnorm 把成片响度标准化，
 *   `off` 时不走任何新分支（产物逐字节不变）。
 *
 * film 解析不在本树实现：`ctx.port('film')` 未接线时抛 `WAIT_MAIN_FILM`。
 * 工程只读：不写 film.html，产物只写 `--out` / outputRoot。
 *
 * @param {Context} ctx
 * @param {string | undefined} input
 * @param {{
 *   range?: [number, number], ranges?: Array<readonly [number, number]>, fps?: number,
 *   fpsRational?: { num: number, den: number }, pixFmt?: 'auto' | '420' | '444',
 *   out?: string, dryRun?: boolean, signal?: AbortSignal,
 *   planOut?: string, framesOut?: string, quality?: string, contentPort?: number, filmWaitMs?: number,
 *   frameTimeoutMs?: number, profile?: boolean, profileOut?: string, concurrency?: number,
 *   alsoCompat?: boolean, ffmpegPath?: string, size?: { w: number, h: number }, fit?: string,
 *   subtitleBurn?: boolean, subtitleStyle?: any, codec?: string, budgetMemMb?: number, budgetSec?: number,
 *   job?: any, jobId?: string, onEvent?: (event: any) => void,
 *   alpha?: boolean, alphaFormat?: string, alphaMode?: string, loudness?: string,
 * }} [opts] `job` 由调用方持有（要提前 cancel 时用）；`onEvent` 是只读订阅（CLI 的 --progress）
 * @returns {Promise<{ result: any, plan: any }>}
 */
export async function exportFilm(ctx, input, opts = {}) {
  /* 帧率（P42）：有理数是唯一真值。CLI 已经把 `--fps` 归一过；这里是程序化调用的兜底，
     非法值一律 INVALID_FPS（退出码 2），不产任何文件。 */
  /** @type {ReturnType<typeof rateOfFps>} */
  let rate;
  try {
    rate = rateOfFps(opts.fpsRational ?? opts.fps ?? 30);
  } catch (err) {
    throw new CliError('INVALID_FPS', /** @type {any} */ (err)?.detail ?? String(err));
  }
  // 编码矩阵（P38）：名字 → 容器/编码器/音频。未知名字在这里就拒，别等渲染。
  /** @type {ReturnType<typeof resolveCodec>} */
  let codec;
  try {
    codec = resolveCodec(opts.codec);
  } catch (err) {
    throw new CliError('INVALID', /** @type {any} */ (err)?.message ?? String(err));
  }
  // 透明导出自己决定编码（prores4444 / png-seq），与 --codec 是两套语义：
  // 同时给等于让用户以为能拿到 hevc 的透明件——直接拒，别猜。
  if (opts.alpha === true && opts.codec !== undefined) {
    throw new CliError(
      'E_USAGE',
      `--codec ${codec.name} cannot be combined with --alpha: alpha exports are ProRes 4444 or PNG sequence, never ${codec.name} (drop --codec)`,
    );
  }
  // 兼容副本按定义是 H.264 4:2:0；换成 hevc/vp9/prores 再产一份 "compat" 只会误导
  if (opts.alsoCompat === true && codec.name !== 'h264') {
    throw new CliError(
      'E_USAGE',
      `--also-compat always writes an H.264 4:2:0 copy; drop --codec ${codec.name} or drop --also-compat`,
    );
  }

  /* 像素格式（P41）：`--pix-fmt` 只改主产物的编码像素格式，不动档位表。
     在这里就把「prores 不吃 / alpha 组合」判掉——等渲染完再报等于让人白等一场。 */
  /** @type {'auto' | '420' | '444'} */
  let pixFmtMode;
  try {
    pixFmtMode = resolvePixFmtMode(opts.pixFmt);
  } catch (err) {
    throw new CliError('INVALID', /** @type {any} */ (err)?.detail ?? String(err));
  }
  if (opts.alpha === true && pixFmtMode !== 'auto') {
    throw new CliError(
      'E_USAGE',
      `--pix-fmt ${pixFmtMode} cannot be combined with --alpha: alpha exports are ProRes 4444 (yuva444p10le) or PNG sequence and choose their own pixel format`,
    );
  }
  /* 档位 + 像素格式的最终结果：dry-run 的 plan、结果里的 pixelFormat、真实编码三方共用
     同一份计算（renderFilmExport 里再算一次，输入相同 → 结果相同）。 */
  const pixFmtPlan = (() => {
    const settings = codecQuality(codec, resolveQuality(opts.quality));
    try {
      return applyPixFmt(codec, pixFmtMode, settings);
    } catch (err) {
      const code = /** @type {any} */ (err)?.code === 'E_USAGE' ? 'E_USAGE' : 'INVALID';
      throw new CliError(code, /** @type {any} */ (err)?.detail ?? String(err));
    }
  })();

  /* 多段 + 烧录（P40）：不再拒绝。
     字幕的源时间 → 拼接时钟由计划层的**逐段窗口**完成（`film-plan.mjs` 把每个片段按段切成
     `at = segment.outStartSec + (takeStart - segment.start)` 的窗口），`mapCuesToTimeline`
     按这些窗口映射，于是：
     - 跨切点的 cue 被切成相邻、不重叠的多条（每条只烧一次，不整条重复）；
     - 落在被删间隙里的 cue 一条都不出；
     - 单段时窗口只有一张，映射与 R22 逐字相同。
     记账（splitCount / skippedCount）进结果与报告，见 subtitles.mjs。 */
  const project = await resolveProject(ctx, input);
  const read = normalizeRead(await ctx.port('film').read(project), project, { requireDoc: true });
  const plan = await planFromFilm(read.doc, {
    projectRoot: project,
    fps: rate.value,
    fpsRational: { num: rate.num, den: rate.den },
    ...(opts.range !== undefined ? { range: opts.range } : {}),
    ...(opts.ranges !== undefined ? { ranges: opts.ranges } : {}),
  });

  // 画幅（P24）：不传 --size 就是「跟随舞台」，一行都不多走。
  const delivery = planDelivery({ stage: plan.stage, size: opts.size ?? null, fit: opts.fit ?? null });

  // 字幕几何（P32）：交付画幅 ≠ 舞台时的缩放比与留边偏移。
  // 与舞台页把 1280×720 transform 到视口是**同一次变换**：
  // letterbox 是「等比缩小 + 居中留边」，cover 是「等比放大 + 居中裁切」。
  // 字幕的 ASS 只要用同一个 scale/offset 算，预览与成片就只差抗锯齿。
  const subtitleLayout = delivery.fit === 'none'
    ? null
    : {
        stage: plan.stage,
        fit: delivery.fit,
        scale: delivery.scale,
        offset: delivery.fit === 'cover'
          ? { x: -(delivery.cropped?.x ?? 0), y: -(delivery.cropped?.y ?? 0) }
          : {
              x: (delivery.output.w - plan.stage.w * delivery.scale) / 2,
              y: (delivery.output.h - plan.stage.h * delivery.scale) / 2,
            },
      };

  // 响度（P34）：缺省 off —— 一个字节都不多走，老产物 sha 才守得住。
  /** @type {'off' | 'streaming' | 'broadcast'} */
  let loudnessPreset = 'off';
  try {
    loudnessPreset = resolveLoudnessPreset(opts.loudness);
  } catch (err) {
    throw new CliError('E_USAGE', /** @type {any} */ (err)?.message ?? String(err));
  }

  // 透明输出（P31）。三条组合限制不是"懒得支持"，是**语义上不成立**：
  // - 跟字幕烧录一起：烧进去的字幕会变成不透明的一块，用户拿到的"透明素材"里
  //   混着一条白字，到了剪辑软件里既删不掉也改不了。
  // - 跟兼容副本一起：兼容副本按定义是 H.264 4:2:0（没有 alpha），两份产物语义冲突。
  const alphaFormat = opts.alpha === true ? resolveAlphaFormat(opts.alphaFormat) : null;
  // 极性（P33）：默认**随格式走**（prores4444 → 预乘、png-seq → 非预乘），
  // `--alpha-mode` 只做显式覆盖。默认值写死成一种，两个格式里必然有一个是错的。
  /** @type {'premultiplied' | 'straight' | null} */
  let alphaMode = null;
  if (alphaFormat !== null) {
    try {
      alphaMode = resolveAlphaMode(opts.alphaMode, alphaFormat);
    } catch (err) {
      throw new CliError('E_USAGE', /** @type {any} */ (err)?.message ?? String(err));
    }
  }
  if (alphaFormat !== null) {
    if (opts.subtitleBurn === true) {
      throw new CliError('E_USAGE', '--alpha cannot be combined with --subtitle-burn (burned text is opaque; subtitle belongs to the compositing layer)');
    }
    if (opts.alsoCompat === true) {
      throw new CliError('E_USAGE', '--alpha cannot be combined with --also-compat (a compat copy is H.264 4:2:0 and has no alpha)');
    }
    // PNG 规范是非预乘：写出预乘 PNG 等于给下游一张没有标记的假数据（alpha-polarity.mjs 文件头）。
    if (alphaFormat === 'png-seq' && alphaMode === 'premultiplied') {
      throw new CliError(
        'E_USAGE',
        'png-seq cannot be premultiplied (PNG is non-premultiplied by specification): use --alpha-format prores4444 for a premultiplied deliverable',
      );
    }
    // 透明导出只出画面、不出音轨，没有声音可以标准化；静默忽略会让人以为响度生效了。
    if (loudnessPreset !== 'off') {
      throw new CliError('E_USAGE', '--alpha exports picture only (no audio track): --loudness does not apply');
    }
  }

  for (const warning of Array.isArray(plan.warnings) ? plan.warnings : []) {
    ctx.log(`warning: ${warning}`);
  }

  const planSummary = {
    durationSec: plan.duration,
    frames: plan.frames,
    fps: plan.fps,
    // P42：帧率的精确形态（29.97 → {num:30000, den:1001}）；ffmpeg 的 -r 就是 "num/den"
    fpsRational: plan.fpsRational,
    fpsArg: rate.arg,
    range: plan.range,
    ...(Array.isArray(plan.ranges) && plan.ranges.length > 1
      ? { ranges: plan.ranges, frameAligned: plan.frameAligned === true, segments: plan.segments.length }
      : {}),
    visualClips: plan.visualClips.length,
    sceneClips: plan.sceneClips.length,
    audioClips: plan.audioMix ? plan.audioMix.clips.length : 0,
    output: delivery.output,
    fit: delivery.fit,
    // A6：`--dry-run --json` 的 plan 里必须能读到编码矩阵的选择
    codec: describeCodec(codec),
    // P41-A6：像素格式与 profile（auto 时是档位解析后的值，与 ffprobe 实际一致）
    pixFmt: pixFmtPlan.pixFmt,
    pixFmtMode,
    profile: pixFmtPlan.profile,
    // 计划层的 warning（隐藏轨跳过 / 片段落在区间外 / 无可听音频…）必须能被调用方看到：
    // 只写进日志等于"静默"——机器接口的读者是 JSON。
    ...(Array.isArray(plan.warnings) && plan.warnings.length > 0 ? { warnings: plan.warnings } : {}),
    ...(loudnessPreset !== 'off' ? { loudness: loudnessPreset } : {}),
    ...(delivery.fit !== 'none'
      ? { scale: Number(delivery.scale.toFixed(4)), footprint: sizeFootprint(delivery.output) }
      : {}),
  };

  // 输出路径先算出来：作业要拿它当锁（并发保护），`--plan-out` 也不该在锁之外写盘
  let outPath = opts.out
    ? await resolveInside(ctx.root, opts.out, { base: ctx.cwd, what: 'out', also: [ctx.outputRoot] })
    : path.join(ctx.outputRoot, `${path.basename(project)}-film.mp4`);

  // `--out` 的扩展名必须与 codec 的容器一致：**不自动改路径**，否则用户会拿到一个
  // 后缀说谎的文件（.mp4 里装 vp9，播放器/上传端都认不出）。
  // 这一步在 `--subtitle-burn` 改名**之前**：`--out film.mp4 --codec vp9 --subtitle-burn`
  // 也要被拒，不能靠"反正后面会改成 -master.webm"混过去。
  if (opts.alpha !== true) {
    const outExt = path.extname(outPath).toLowerCase();
    if (outExt !== codec.extension) {
      throw new CliError(
        'E_USAGE',
        `--codec ${codec.name} writes ${codec.extension} files, but --out is "${outPath}" (${outExt || 'no extension'}): change the extension or the codec — --out is never rewritten silently`,
      );
    }
  }

  // 三件套（P23）：`<name>-master.mp4` + `<name>-subbed.mp4` + `<name>.vtt`。
  // 只在显式 `--subtitle-burn` 时改名；不传时路径一个字都不动（A6 回归）。
  let subbedPath = '';
  let vttPath = '';
  if (opts.subtitleBurn === true) {
    if (opts.alsoCompat === true) {
      throw new CliError(
        'E_USAGE',
        '--also-compat and --subtitle-burn cannot be combined: compat is encoded from the same frames without subtitles, which would be ambiguous',
      );
    }
    // 三件套的扩展名跟着 codec 走：vp9 的 master 必须是 .webm，写成 .mp4 会被 ffmpeg 拒
    const base = /\.(mp4|webm|mov)$/i.test(outPath) ? outPath.replace(/\.(mp4|webm|mov)$/i, '') : outPath;
    outPath = `${base}-master${codec.extension}`;
    subbedPath = `${base}-subbed${codec.extension}`;
    vttPath = `${base}.vtt`;
  }

  // 透明输出的落盘目标（P31）：`--out take.mp4` → `take.mov` 或 `take/` + `take.zip`。
  // 这一步只算路径，不写盘；锁也要等目标定了才拿得准。
  /** @type {{ kind: 'prores4444' | 'png-seq', path: string, dir?: string } | null} */
  const alphaTarget = alphaFormat === null
    ? null
    : alphaFormat === 'png-seq'
      ? (() => {
          const paths = resolvePngSeqPaths(outPath);
          return { kind: 'png-seq', path: paths.zip, dir: paths.dir };
        })()
      : {
          kind: 'prores4444',
          path: /\.mov$/i.test(outPath) ? outPath : `${outPath.replace(/\.(mp4|mov|m4v)$/i, '')}.mov`,
        };
  // 透明来自舞台图层：纯实拍工程的画面铺满整幅、alpha 恒为 255，导成"透明素材"
  // 只会让用户在剪辑软件里发现它压不住底。这类工程直接拒绝，并说清该怎么办。
  if (alphaTarget && plan.sceneClips.length === 0 && !requiresTransitionStage(plan) && !requiresCreationStyleStage(plan)) {
    throw new CliError(
      'ALPHA_REQUIRES_STAGE',
      '--alpha needs at least one page clip: a video-only project has no transparency to preserve (compose it with a still/PNG instead)',
    );
  }

  // `--plan-out`：把**完整计划**按稳定键序落盘，供可复现性比对（两次导出字节相同）
  if (opts.planOut) {
    const planPath = await resolveInside(ctx.root, opts.planOut, {
      base: ctx.cwd,
      what: 'plan-out',
      also: [ctx.outputRoot],
    });
    await fs.mkdir(path.dirname(planPath), { recursive: true });
    await fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  }

  if (opts.dryRun) {
    return { result: { ok: true, dryRun: true, project, plan: planSummary }, plan };
  }

  // 作业句柄（P28）：占住输出路径（跨进程锁，冲突即 EXPORT_OUTPUT_BUSY），
  // 之后所有进度都往它身上发，取消也只从它走。
  // 调用方可以自己传一个 job（宿主要提前 cancel 时就该这么做），否则这里造。
  // 要占住的输出（P28 锁 / P31 透明目标）：显式攒成 string[]，
  // 别用 `[...].filter(Boolean)`——那在 tsc 眼里仍是 (string|undefined)[]。
  /** @type {string[]} */
  const lockPaths = [outPath];
  if (subbedPath) lockPaths.push(subbedPath);
  if (alphaTarget) {
    lockPaths.push(alphaTarget.path);
    if (alphaTarget.dir) lockPaths.push(alphaTarget.dir);
  }
  const job = opts.job ?? createExportJob({
    ...(opts.jobId !== undefined ? { id: String(opts.jobId) } : {}),
    outputPath: lockPaths,
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
  });
  if (job.signal.aborted) {
    job.release();
    throw new CliError('EXPORT_CANCELLED', 'export cancelled before it started');
  }
  if (opts.signal) {
    if (opts.signal.aborted) job.cancel('signal');
    else opts.signal.addEventListener('abort', () => job.cancel('signal'), { once: true });
  }

  // 预算守卫（P24-A5）：超限直接中止，让下面所有在跑的子进程一起收摊。
  // 用户自己的 Ctrl-C（job.signal）与预算共用一条 AbortSignal，但错误码分得开
  // （EXPORT_CANCELLED vs BUDGET_EXCEEDED）。
  const budgetMemMb = Number(opts.budgetMemMb);
  const budgetSec = Number(opts.budgetSec);
  const hasMemBudget = Number.isFinite(budgetMemMb) && budgetMemMb > 0;
  const hasTimeBudget = Number.isFinite(budgetSec) && budgetSec > 0;
  /** @type {AbortController | null} */
  const budgetController = hasMemBudget || hasTimeBudget ? new AbortController() : null;
  if (budgetController) {
    if (job.signal.aborted) budgetController.abort();
    else job.signal.addEventListener('abort', () => budgetController.abort(), { once: true });
  }
  const signal = budgetController ? budgetController.signal : job.signal;
  const monitor = budgetController
    ? startResourceMonitor({
        ...(hasMemBudget ? { maxRssMb: budgetMemMb } : {}),
        ...(hasTimeBudget ? { maxSec: budgetSec } : {}),
        onExceed: () => budgetController.abort(),
      })
    : null;

  // 计划已经算完（时长/帧数/条目数都在手上了），第一拍先报 `planning`
  job.progress({ phase: 'planning', frame: 0, totalFrames: Number(plan.frames) || 0 });

  const subtitleWork = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-subs-'));

  // 有网页片段就先把整段画面从舞台抓成 PNG；没有就走原来的 ffmpeg 合成。
  /** @type {any} */
  let capture = null;
  /** @type {string} */
  let framesDir = '';
  /** 给了 `--frames-out` 就把帧序列留下：它是「编码前」的无损对照物，删了就没法做一致性比对。 */
  let keepFrames = false;
  const needsStage = plan.sceneClips.length > 0 || requiresTransitionStage(plan) || requiresCreationStyleStage(plan);

  const run = async () => {
    // 编码器探测（P38）：缺 libx265 / libvpx-vp9 / prores_ks / opus / pcm_s16le 时
    // 在**开渲之前**报 CODEC_UNAVAILABLE，别让用户等一场取帧才发现编不出来。
    // 透明导出走自己的 prores_ks / PNG 链，不该被 h264 的编码器缺失挡住。
    if (alphaTarget === null) {
      const encoders = await checkEncoders({
        ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}),
        required: requiredEncoders(codec),
      });
      if (!encoders.ok) {
        throw new CliError(
          'CODEC_UNAVAILABLE',
          `codec ${codec.name} needs ${encoders.missing.join(', ')}, but this ffmpeg build does not provide it (run \`ffmpeg -encoders\` to check)`,
        );
      }
    }

    // 场景片段的前置检查（P27）：缺 html / 跨源 / 越界都在**开浏览器之前**失败。
    // 理由写在 scene-clips.mjs：等舞台跑起来才发现，用户要等 3 分钟而且报的是 NO_FILM。
    if (needsStage) {
      await assertSceneClipsReady(plan, { projectRoot: project });
    }
    // 字幕准备放在取帧之前：坏 vtt / 缺字要在**开渲之前**失败，别让人等三分钟才看到错。
    /** @type {any} */
    let subtitleBundle = null;
    /** @type {any} */
    let styleSource = null;
    if (opts.subtitleBurn === true) {
      // P48：显式 --subtitle-style > 工程 .film/subtitle-style.json > 默认。
      // 读不到文件不是错误；坏 JSON 在这里就抛 INVALID（退出码 2），不会白烧一遍。
      styleSource = await resolveSubtitleStyle({ projectRoot: project, explicit: opts.subtitleStyle });
      subtitleBundle = await prepareSubtitleBurn({
        plan,
        // P37：CLI 的 `--subtitle-style` 走 S41 的新 schema（相对字号）。
        // P48：`style` 为 undefined 表示用默认——保持默认 ASS 逐字节不变。
        ...(styleSource.style !== undefined ? { subtitleStyle: styleSource.style } : {}),
        size: delivery.output,
        ...(subtitleLayout ? { layout: subtitleLayout } : {}),
        assPath: path.join(subtitleWork, 'subtitles.ass'),
        ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}),
        /* P68：形状不对的警告靠它进 bundle.warnings → stderr 的 `warning: subtitle style: …`。 */
        styleAudit: styleSource.audit,
      });
    }

    // 字幕样式回退、空 vtt、cue 落在窗口外……这些 warning 之前只进了结果 JSON，
    // stderr 一个字都没有。P37 起统一补一行 `warning: …`，人盯着终端也能看见。
    if (subtitleBundle) {
      for (const warning of subtitleBundle.warnings) ctx.log(`warning: ${warning}`);
      // 多段拼接的记账也给一行人读的：`cues=4 split=1 skipped=1`
      if ((subtitleBundle.splitCount ?? 0) > 0 || (subtitleBundle.skippedCount ?? 0) > 0) {
        ctx.log(
          `subtitles: ${subtitleBundle.cues.length} cue(s) on the spliced timeline ` +
            `(split ${subtitleBundle.splitCount ?? 0}, skipped ${subtitleBundle.skippedCount ?? 0})`,
        );
      }
    }

    try {
      if (needsStage) {
        if (opts.framesOut) {
          framesDir = await resolveInside(ctx.root, opts.framesOut, {
            base: ctx.cwd,
            what: 'frames-out',
            also: [ctx.outputRoot],
          });
          await fs.mkdir(framesDir, { recursive: true });
          keepFrames = true;
        } else {
          framesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-stage-frames-'));
        }
        // 惰性加载：舞台取帧会拉起 Studio + Chromium，只有真要画网页片段时才付这个代价
        const { captureFilmFrames } = await import('../render/stage-capture.mjs');
        /** @type {any} */
        let rawCapture;
        try {
          rawCapture = await captureFilmFrames({
            plan,
            projectRoot: project,
            framesDir,
            ...(opts.contentPort !== undefined ? { contentPort: opts.contentPort } : {}),
            ...(opts.filmWaitMs !== undefined ? { filmWaitMs: opts.filmWaitMs } : {}),
            ...(opts.frameTimeoutMs !== undefined ? { frameTimeoutMs: opts.frameTimeoutMs } : {}),
            ...(opts.profile ? { profile: true } : {}),
            ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
            // 画幅只改「视口 + 舞台 fit」，舞台内部坐标仍是 1280×720，合成逻辑一行不动
            ...(delivery.fit !== 'none' ? { size: delivery.viewport, stageFit: delivery.stageFit } : {}),
            // 透明输出（P31）：截图要 omitBackground，页面底色也要拆掉（都在 stage-capture 里）
            ...(alphaTarget ? { alpha: true } : {}),
            ...(signal ? { signal } : {}),
            // 逐帧进度：`onFrame` 的 index 是 0 基，对外报 1 基（读到 N/M 时人不用换算）
            onFrame: (/** @type {{ index: number }} */ frame) => {
              job.progress({
                phase: 'rendering',
                stage: 'capture',
                frame: frame.index + 1,
                totalFrames: Number(plan.frames) || 0,
              });
            },
            logger: ctx.log,
          });
        } catch (err) {
          // 舞台那一层的 NO_FILM / FRAME_THREW / FRAME_TIMEOUT / STAGE_BOOT_FAILED /
          // PROJECT_NOT_OPEN 收口成 SCENE_CAPTURE_FAILED（原码留在 causeCode 里）。
          // 取消不在这里翻：它是用户的意图，不是场景画不出来。
          if (job.signal.aborted) throw err;
          throw wrapSceneCaptureError(err, { clipIds: plan.sceneClips.map((/** @type {any} */ clip) => String(clip.id)) });
        }
        capture = rawCapture;
        // 分项耗时是排查"为什么导出慢"的唯一入口：落到文件，别只留在内存里
        if (opts.profileOut && capture.profile) {
          const profilePath = await resolveInside(ctx.root, opts.profileOut, {
            base: ctx.cwd,
            what: 'profile-out',
            also: [ctx.outputRoot],
          });
          await fs.mkdir(path.dirname(profilePath), { recursive: true });
          await fs.writeFile(profilePath, `${JSON.stringify(capture.profile, null, 2)}\n`);
        }
      }

      // 透明输出（P31）：到这一步画面已经是带 alpha 的 PNG 序列，接下来只有
      // 「编码成 ProRes」或「交付 PNG 序列 + zip」两件事，**不再走 h264/混音/封装**。
      if (alphaTarget) {
        const frameCount = Number(/** @type {any} */ (capture).frames);
        if (frameCount !== Number(plan.frames)) {
          throw new CliError(
            'OUTPUT_UNVERIFIED',
            `capture produced ${frameCount} frames, plan expects ${plan.frames}`,
          );
        }
        const framesDir = /** @type {any} */ (capture).dir;
        const pattern = /** @type {any} */ (capture).pattern;
        // 逐帧判透明要解 240~900 张 PNG：这是**编码前**真实的工作量，按 encode 阶段报
        const report = await analyzeAlphaFrames({
          framesDir,
          ...(pattern ? { pattern } : {}),
          frames: frameCount,
          onProgress: (/** @type {{ index: number }} */ info) => {
            job.progress({
              phase: 'rendering',
              stage: 'encode',
              frame: info.index + 1,
              totalFrames: frameCount,
            });
          },
        });
        job.progress({ phase: 'muxing', totalFrames: frameCount });
        const verifyFrames = [...new Set([
          0,
          Math.floor(frameCount / 2),
          Math.max(0, frameCount - 1),
        ])];
        const written = await writeAlphaOutput({
          outPath,
          format: /** @type {'prores4444' | 'png-seq'} */ (alphaFormat),
          ...(alphaMode ? { mode: alphaMode } : {}),
          framesDir,
          ...(pattern ? { pattern } : {}),
          frames: frameCount,
          fps: rate.value,
          fpsArg: rate.arg,
          durationSec: Number(durationOfFrames(rate, frameCount).toFixed(6)),
          size: delivery.output,
          report,
          ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}),
          ...(signal ? { signal } : {}),
          verifyFrames,
          onProgress: (/** @type {any} */ info) => {
            job.progress({
              phase: 'rendering',
              stage: 'encode',
              ...(Number.isFinite(info.frame) ? { frame: info.frame } : {}),
              totalFrames: frameCount,
            });
          },
        });
        // 逐帧报告可以有几百条：留在文件里 + 结果里都给，但结果里的是**同一份**
        // （不截断——截断了「perFrame」就名不副实）。
        return {
          result: {
            ok: true,
            project,
            durationSec: Number(durationOfFrames(rate, frameCount).toFixed(6)),
            alpha: {
              ...summarizeAlpha(written),
              hasAlpha: report.hasAlpha,
              framesWithAlpha: report.framesWithAlpha,
              firstFrame: report.firstFrame,
              lastFrame: report.lastFrame,
              maxTransparentRatio: report.maxTransparentRatio,
              minAlphaOverall: report.minAlphaOverall,
              threshold: report.threshold,
              fullyTransparentFrames: report.fullyTransparentFrames,
              perFrame: report.perFrame,
              advice: report.hasAlpha
                ? null
                : 'this project is fully opaque: the alpha channel is all 255 — keep H.264 if you do not need a compositing layer',
            },
            plan: planSummary,
            scenes: {
              rendered: plan.sceneClips.length,
              clips: capture.sceneClips,
              bootErrors: capture.bootErrors.length,
              sceneFrames: capture.capture?.probe?.sceneFrames ?? null,
              stageFrames: capture.capture?.probe?.frames ?? null,
              pageErrors: capture.pageErrors,
            },
            ...(keepFrames ? { framesDir } : {}),
          },
          plan,
          capture,
        };
      }

      // 舞台路径：画面已经是目标尺寸，cover 才需要再裁；
      // ffmpeg 合成路径：画布还是 stage 尺寸，缩放/留边必须由滤镜补。
      const postVf = needsStage ? delivery.vf : delivery.ffmpegVf;
      const rendered = await renderFilmExport({
        plan,
        projectRoot: project,
        outPath,
        ...(capture ? { capture } : {}),
        ...(opts.quality !== undefined ? { quality: opts.quality } : {}),
        codec: codec.name,
        pixFmtMode,
        ...(delivery.fit !== 'none' ? { outputSize: delivery.output } : {}),
        ...(postVf ? { vf: postVf } : {}),
        ...(subtitleBundle ? { subtitles: { assPath: subtitleBundle.assPath, outPath: subbedPath } } : {}),
        ...(loudnessPreset !== 'off' ? { loudness: loudnessPreset } : {}),
        ...(opts.ffmpegPath ? { ffmpegPath: opts.ffmpegPath } : {}),
        ...(signal ? { signal } : {}),
        onProgress: (/** @type {any} */ info) => {
          job.progress({
            phase: info.phase,
            ...(info.stage ? { stage: info.stage } : {}),
            ...(Number.isFinite(info.frame) ? { frame: info.frame } : {}),
            ...(Number.isFinite(info.totalFrames) ? { totalFrames: info.totalFrames } : {}),
          });
        },
      });

      // 旁挂 vtt：写成**成片时间**的规范版（源时间直接复制会在有入点/变速时整体错位）
      /** @type {{ path: string, bytes: number, sha256: string } | null} */
      let vttFile = null;
      if (subtitleBundle) {
        const vtt = buildVttDocument({ cues: subtitleBundle.cues });
        await fs.mkdir(path.dirname(vttPath), { recursive: true });
        await fs.writeFile(vttPath, vtt, 'utf8');
        const body = Buffer.from(vtt, 'utf8');
        vttFile = { path: vttPath, bytes: body.length, sha256: bytesDigest(body) };
      }

      // 兼容副本：**不重新取帧**，拿同一批 PNG 换 420/veryfast/crf20 再编一次。
      // 只在显式 --also-compat 时产出；默认路径完全不经过这里（行为与 R9 一致）。
      /** @type {any} */
      let compat = null;
      if (opts.alsoCompat === true) {
        const compatPath = /\.mp4$/i.test(outPath) ? outPath.replace(/\.mp4$/i, '.compat.mp4') : `${outPath}.compat.mp4`;
        const { renderCompatCopy } = await import('../render/film-export.mjs');
        compat = await renderCompatCopy({
          plan,
          outPath: compatPath,
          ...(capture ? { framesDir: capture.dir ?? capture.framesDir, pattern: capture.pattern, frames: capture.frames } : {}),
          ...(loudnessPreset !== 'off' ? { loudness: loudnessPreset } : {}),
          ...(signal ? { signal } : {}),
        });
      }

      return {
        result: {
          ok: true,
          project,
          ...summarizeFilmExport(rendered),
          plan: planSummary,
          ...(subtitleBundle
            ? {
                subtitles: {
                  ...(rendered.subtitles ?? {}),
                  master: { path: rendered.path, bytes: rendered.bytes, sha256: rendered.sha256 },
                  subbed: rendered.subtitles
                    ? { path: rendered.subtitles.path, bytes: rendered.subtitles.bytes, sha256: rendered.subtitles.sha256 }
                    : null,
                  vtt: vttFile,
                  cues: subtitleBundle.cues.length,
                  // P40：多段拼接的字幕记账（按输入 cue 计，不按输出条数）
                  splitCount: subtitleBundle.splitCount,
                  skippedCount: subtitleBundle.skippedCount,
                  // P43：落帧格后因同轨单调被推回去的 cue 数（分数帧率下防重叠）
                  overlapClamped: subtitleBundle.overlapClamped,
                  overlapDropped: subtitleBundle.overlapDropped,
                  style: subtitleBundle.style,
                  ...(styleSource ? { subtitleStyleAudit: await subtitleStyleAuditReport(styleSource, { projectRoot: project }) } : {}),
                  // P48：这次样式从哪来（explicit / project / default）与归一化 issues。
                  // 文件存在但字段不合法时 issues 非空——**不阻断**，但审计里要看得见。
                  ...(styleSource ? { styleSource: styleSource.audit } : {}),
                  // P37：实际写进 ASS 的字段（A2/A4 的机器可读对照面）与归一后的 S41 样式
                  subtitleStyle: subtitleBundle.subtitleStyle,
                  assStyle: subtitleBundle.assStyle,
                  sources: subtitleBundle.sources.map((/** @type {any} */ source) => ({
                    clipId: source.clipId,
                    path: source.path,
                    format: source.format,
                    cues: source.cues.length,
                  })),
                  warnings: subtitleBundle.warnings,
                  glyph: subtitleBundle.glyph,
                  support: subtitleBundle.support,
                  ass: { path: subtitleBundle.assPath, sha256: subtitleBundle.assSha256 },
                  layout: subtitleLayout,
                  report: subtitleBundle.report,
                },
              }
            : {}),
          ...(capture
            ? {
                scenes: {
                  rendered: plan.sceneClips.length,
                  clips: capture.sceneClips,
                  bootErrors: capture.bootErrors.length,
                  // P15-A5：整段取帧的**证据面**——每个场景自己画了多少帧、舞台总共提交了几帧
                  sceneFrames: capture.capture?.probe?.sceneFrames ?? null,
                  pages: capture.capture?.probe?.pages ?? [],
                  stageFrames: capture.capture?.probe?.frames ?? null,
                  pageErrors: capture.pageErrors,
                },
              }
            : {}),
          ...(keepFrames ? { framesDir } : {}),
          ...(compat
            ? {
                compat: {
                  path: compat.path,
                  bytes: compat.bytes,
                  sha256: compat.sha256,
                  frames: compat.frames,
                  durationSec: compat.durationSec,
                  quality: compat.quality,
                  decode: compat.decode,
                },
              }
            : {}),
          ...(capture?.profile
            ? {
                profile: {
                  avgMs: capture.profile.avgMs,
                  sharePercent: capture.profile.sharePercent,
                  roundTripBaselineMs: capture.profile.roundTripBaselineMs,
                },
              }
            : {}),
        },
        plan,
        ...(capture ? { capture } : {}),
      };
    } catch (err) {
      // 中止只有一个出口：不管当时卡在 page.evaluate 还是 ffmpeg，只要信号已置位，
      // 对外就是 CANCELLED。让 playwright 的 "Target page ... has been closed"
      // 或 ffmpeg 的 "exit 255" 冒充真实故障，会把「用户按了 Ctrl-C」记成产品缺陷。
      if (job.signal.aborted) {
        const why = /** @type {any} */ (err)?.code ?? /** @type {any} */ (err)?.message ?? 'aborted';
        throw new CliError('EXPORT_CANCELLED', `export cancelled (${String(why)})`);
      }
      throw err;
    } finally {
      if (framesDir && !keepFrames) await fs.rm(framesDir, { recursive: true, force: true }).catch(() => {});
    }
  };

  /** @type {{ result: any, plan: any } | null} */
  let outcome = null;
  /** @type {any} */
  let failure = null;
  try {
    outcome = await run();
  } catch (err) {
    failure = err;
  }
  /** @type {any} */
  let stats = null;
  try {
    stats = monitor ? await monitor.stop() : null;
  } finally {
    // 临时目录一定要清：它和作业状态无关，是「过程垃圾」。
    // 放在 finally 里是因为 monitor.stop() 抛错也不该把 opencut-subs-* 留给用户。
    await fs.rm(subtitleWork, { recursive: true, force: true }).catch(() => {});
  }

  // 从这里往下是**收尾**：无论走哪条分支，输出占用都必须放掉（P30）。
  // 以前三条分支各自 `job.release()`，漏一条就留锁（取消来晚那条就是这么漏的）。
  // 现在由 finally 兜底，`finish/fail` 里那次释放只是让「作业结束」与「锁释放」在同一拍。
  try {
    // 峰值内存/耗时是 P24 的验收数字之一：成功路径也要带出来，不能只在超限时才可见。
    if (stats && outcome?.result) {
      outcome.result.resources = {
        peakRssMb: stats.peakMb,
        source: stats.source,
        // 口径写清楚：tree = 本次导出的进程树 RSS；system = 整机可用内存下降（ps 被权限挡住时的降级）
        measure: stats.source === 'tree' ? 'process-tree RSS' : 'system free-memory drop',
        samples: stats.samples,
        elapsedSec: stats.elapsedSec,
        limitMb: hasMemBudget ? budgetMemMb : null,
        limitSec: hasTimeBudget ? budgetSec : null,
      };
    }

    if (stats?.exceeded) {
      // 预算超了：不留半成品。run() 的 finally 已经删了帧目录，这里补删可能的产物。
      if (outcome?.result?.path) await fs.unlink(outcome.result.path).catch(() => {});
      if (subbedPath) await fs.unlink(subbedPath).catch(() => {});
      if (vttPath) await fs.unlink(vttPath).catch(() => {});
      const exceeded = new CliError(
        'BUDGET_EXCEEDED',
        `${stats.exceeded.detail} (peak ${stats.peakMb}MB, ${stats.samples} samples, ${stats.elapsedSec}s)`,
        { peakMb: stats.peakMb, limitMb: hasMemBudget ? budgetMemMb : undefined, limitSec: hasTimeBudget ? budgetSec : undefined },
      );
      job.fail(exceeded);
      throw exceeded;
    }
    if (failure) {
      job.fail(failure);
      throw failure;
    }
    // 成功：`finish` 会发 `done`（带成片帧数）并释放输出占用。
    // 若此刻 job 已被 cancel（取消落在 muxing 之后），`finish` 会把它记成
    // `cancelTooLate` 并**照常**发 done / resolve / 放锁——产物是完整的，不能报成失败。
    job.finish(/** @type {any} */ (outcome).result);
    return /** @type {{ result: any, plan: any }} */ (outcome);
  } finally {
    job.release();
  }
}

/**
 * `export still`：取出指定时刻的**整帧**（网页合成在内）。
 *
 * 画面来源与 `export film` 同一条路（`stage-capture.mjs` 的 `captureAt`），
 * 所以「这张静帧」和「视频里那一帧」在像素上是同一个东西。
 * PNG 直接落盘（无损，不再编码）；JPG 走 ffmpeg `-q:v`。
 *
 * @param {Context} ctx
 * @param {string | undefined} input
 * @param {{ at?: string, format?: string, out?: string, jpgQuality?: number, contentPort?: number, signal?: AbortSignal,
 *   size?: { w: number, h: number }, fit?: string }} [opts]
 *   `size`/`fit` 与 `export film` 同一套语义（`planDelivery`）：静帧要和成片在同一个几何下，
 *   否则「预览 vs 成片」的比对里混进了缩放差异。
 */
export async function exportStill(ctx, input, opts = {}) {
  const project = await resolveProject(ctx, input);
  const read = normalizeRead(await ctx.port('film').read(project), project, { requireDoc: true });
  const plan = await planFromFilm(read.doc, { projectRoot: project });
  const format = opts.format ?? 'png';
  if (format !== 'png' && format !== 'jpg') throw new CliError('INVALID', `--format must be png or jpg, got "${format}"`);
  const times = parseTimes(opts.at, plan.duration);
  if (!opts.out) throw new CliError('E_USAGE', 'export still needs --out <dir>');
  const dir = await resolveInside(ctx.root, opts.out, { base: ctx.cwd, what: 'out', also: [ctx.outputRoot] });
  await fs.mkdir(dir, { recursive: true });

  // 画幅（P29）：静帧支持与 `export film` 同一套 `--size/--fit`。
  // 为什么必须支持：要比「预览 vs 成片」，两边必须在**同一个几何**下取帧；
  // 拿 1280×720 的静帧去比 1080×1920 的成片，量到的是缩放算法，不是画面一致性。
  const delivery = planDelivery({ stage: plan.stage, size: opts.size ?? null, fit: opts.fit ?? null });

  const captured = await captureStills({
    projectRoot: project,
    times,
    ...(delivery.fit !== 'none' ? { size: delivery.viewport, stageFit: delivery.stageFit } : {}),
    ...(opts.contentPort !== undefined ? { contentPort: opts.contentPort } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    logger: ctx.log,
  });

  /** @type {Array<{ t: number, file: string, bytes: number, sha256: string }>} */
  const files = [];
  for (const shot of captured.shots) {
    const name = `still-${shot.t.toFixed(3)}s.${format}`;
    const file = path.join(dir, name);
    // cover 的裁切与成片同一刀：成片走 ffmpeg `crop=w:h:x:y`，静帧也走同一个滤镜，
    // 这样「预览裁在哪」与「成片裁在哪」不可能各说一套。
    const cropped = delivery.fit === 'cover' && delivery.cropped
      ? await cropPng(shot.png, { w: delivery.output.w, h: delivery.output.h, x: delivery.cropped.x, y: delivery.cropped.y })
      : shot.png;
    const body = format === 'png' ? cropped : await pngToJpg(cropped, {
      ...(opts.jpgQuality !== undefined ? { quality: opts.jpgQuality } : {}),
    });
    await fs.writeFile(file, body);
    files.push({
      t: shot.t,
      file,
      bytes: body.length,
      sha256: cryptoHash(body),
    });
  }
  return {
    result: {
      ok: true,
      project,
      dir,
      format,
      stage: captured.stage,
      // 画幅口径写在结果里：`output` 是成片尺寸，`viewport` 是取帧尺寸（cover 时更大）
      output: delivery.output,
      fit: delivery.fit,
      viewport: delivery.viewport,
      ...(delivery.fit === 'cover' && delivery.cropped ? { cropped: delivery.cropped } : {}),
      files,
    },
    stage: captured.stage,
  };
}

/**
 * `export stems`：每条音频片段一个 wav + mix.wav。
 *
 * 片段 id 取自 doc（与 plan.audioMix.clips 同序），对不上直接报错——
 * 把名字贴错比不导出更糟。
 *
 * @param {Context} ctx
 * @param {string | undefined} input
 * @param {{ out?: string, signal?: AbortSignal }} [opts]
 */
export async function exportStems(ctx, input, opts = {}) {
  const project = await resolveProject(ctx, input);
  const read = normalizeRead(await ctx.port('film').read(project), project, { requireDoc: true });
  const plan = await planFromFilm(read.doc, { projectRoot: project });
  if (!plan.audioMix) throw new CliError('INVALID_FILM', 'film has no audible clips: nothing to stem out');
  if (!opts.out) throw new CliError('E_USAGE', 'export stems needs --out <dir>');
  const dir = await resolveInside(ctx.root, opts.out, { base: ctx.cwd, what: 'out', also: [ctx.outputRoot] });
  await fs.mkdir(dir, { recursive: true });

  // doc 里音频片段的顺序 = plan.audioMix.clips 的顺序（同一套遍历 + 同一套 muted 过滤）
  /** @type {string[]} */
  const ids = [];
  for (const track of Array.isArray(read.doc.tracks) ? read.doc.tracks : []) {
    if (track.muted === true) continue;
    for (const clip of Array.isArray(track.clips) ? track.clips : []) {
      if ((clip.kind ?? 'video') !== 'sound') continue;
      if (clip.muted === true) continue;
      ids.push(String(clip.id));
    }
  }

  const out = await renderStems({
    audioMix: plan.audioMix,
    clipIds: ids,
    outDir: dir,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return {
    result: {
      ok: true,
      project,
      dir,
      sampleRate: plan.audioMix.sampleRate,
      channels: plan.audioMix.channels,
      durationSec: plan.audioMix.duration,
      stems: out.stems,
      mix: out.mix,
    },
  };
}

/**
 * `export gif`：区间 → 调色板 GIF。
 *
 * 帧仍然从舞台抓（不拿 mp4 转，避免二次编码损失），fps/区间直接进计划，
 * 所以帧数 = round((b-a)*fps)，不接受"大概这么多帧"。
 *
 * @param {Context} ctx
 * @param {string | undefined} input
 * @param {{ range?: [number, number], fps?: number, width?: number, out?: string, contentPort?: number, signal?: AbortSignal }} [opts]
 */
export async function exportGif(ctx, input, opts = {}) {
  const project = await resolveProject(ctx, input);
  const read = normalizeRead(await ctx.port('film').read(project), project, { requireDoc: true });
  const fps = opts.fps ?? 12;
  if (!Number.isFinite(fps) || fps <= 0 || fps > 50) throw new CliError('INVALID', '--fps must be 1..50 for gif');
  const width = opts.width ?? 640;
  if (!Number.isFinite(width) || width < 16 || width > 4096) throw new CliError('INVALID', '--width must be 16..4096');
  if (!opts.out) throw new CliError('E_USAGE', 'export gif needs --out <file.gif>');
  if (!opts.range) throw new CliError('E_USAGE', 'export gif needs --range <a..b>');

  const plan = await planFromFilm(read.doc, { projectRoot: project, fps, range: opts.range });  const outPath = await resolveInside(ctx.root, opts.out, { base: ctx.cwd, what: 'out', also: [ctx.outputRoot] });

  const framesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-gif-frames-'));
  try {
    const { captureFilmFrames } = await import('../render/stage-capture.mjs');
    const capture = await captureFilmFrames({
      plan,
      projectRoot: project,
      framesDir,
      ...(opts.contentPort !== undefined ? { contentPort: opts.contentPort } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      logger: ctx.log,
    });
    const gif = await renderGif({
      framesDir,
      pattern: capture.pattern,
      frames: capture.frames,
      fps,
      width,
      outPath,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return {
      result: {
        ok: true,
        project,
        path: gif.path,
        bytes: gif.bytes,
        frames: gif.frames,
        fps: gif.fps,
        width: gif.width,
        range: plan.range,
        stage: capture.stage,
        filter: gif.filter,
      },
    };
  } finally {
    await fs.rm(framesDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * `--at 0.5` / `--at 0.3,4,15.5` → 时间数组（秒）。越界直接报错，不静默夹取。
 * @param {string | undefined} raw
 * @param {number} duration
 * @returns {number[]}
 */
function parseTimes(raw, duration) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new CliError('E_USAGE', 'export still needs --at <t|t1,t2,...> in seconds');
  }
  const parts = raw.split(',').map((piece) => piece.trim()).filter((piece) => piece !== '');
  if (parts.length === 0) throw new CliError('INVALID', '--at has no time in it');
  /** @type {number[]} */
  const out = [];
  for (const part of parts) {
    const t = Number(part);
    if (!Number.isFinite(t)) throw new CliError('INVALID', `--at "${part}" is not a number`);
    if (t < 0 || t >= duration) {
      throw new CliError('INVALID_RANGE', `--at ${t} is outside the film (0 <= t < ${duration})`);
    }
    out.push(Number(t.toFixed(6)));
  }
  return out;
}

/**
 * @param {Buffer} body
 * @returns {string}
 */
function cryptoHash(body) {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * `RenderQueue.progress()` 对未知 jobId 也返回 `{state:'failed'}`；CLI/MCP 不能把
 * "没这个作业"当成"渲染失败"，所以用 framesTotal 是否出现过区分。
 * @param {any} progress
 * @returns {boolean}
 */
function looksUnknown(progress) {
  return !progress || (progress.state === 'failed' && typeof progress.framesTotal !== 'number');
}

/**
 * @param {Context} ctx
 * @param {string | undefined} jobId
 */
export async function exportStatus(ctx, jobId) {
  if (typeof jobId !== 'string' || jobId.length === 0) throw new CliError('E_USAGE', 'a jobId is required');
  const progress = await ctx.port('render').status(jobId);
  if (looksUnknown(progress)) throw new CliError('NOT_FOUND', `no such export job: ${jobId}`, { jobId });
  const result = { ok: true, ...progress };
  assertSchema(result, S.exportStatusOutput, 'export status');
  return result;
}

/**
 * @param {Context} ctx
 * @param {string | undefined} jobId
 */
export async function exportCancel(ctx, jobId) {
  if (typeof jobId !== 'string' || jobId.length === 0) throw new CliError('E_USAGE', 'a jobId is required');
  const render = ctx.port('render');
  const before = await render.status(jobId);
  if (looksUnknown(before)) throw new CliError('NOT_FOUND', `no such export job: ${jobId}`, { jobId });
  const cancelled = await render.cancel(jobId);
  /* P50：目录里的 job.json 已属于别的作业（或被人改坏）→ 端口拒绝发信号。
     这是 CONFLICT（3）：不是「找不到」，也不是「跑挂了」，而是「你指的这个作业
     已经不是那个目录的主人了」。 */
  if (cancelled?.error === 'CONFLICT') {
    throw new CliError('CONFLICT', String(cancelled.detail ?? `job ${jobId} does not own its output directory`), {
      ...(cancelled.detail ? { detail: cancelled.detail } : {}),
      jobId,
    });
  }
  const after = await render.status(jobId);
  const result = { ok: true, jobId, state: after?.state ?? 'cancelled' };
  assertSchema(result, S.exportCancelOutput, 'export cancel');
  return result;
}
