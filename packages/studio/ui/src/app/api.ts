/**
 * Studio HTTP 客户端。
 *
 * 只有两类数据源：`fetch` 走 `/api/...` 与 `/healthz`；事件走 WebSocket `/events`。
 * 渲染层不碰文件系统，也不知道工程的绝对路径规则——路径由 Studio 返回。
 */

import type {
  AssetItem,
  SubtitleCue,
  SubtitleStyleFields,
  SubtitleStyleResponse,
  DocResponse,
  EditOp,
  EditOk,
  Envelope,
  ExportJobView,
  HealthResponse,
  MediaStatus,
  MotionManageEntry,
  ProjectListItem,
  ProjectSummary,
  RecentProjectItem,
  StageLayersResponse,
  InspectResponse,
} from './types';

export class ApiError extends Error {
  status: number;
  code: string;
  body: Record<string, unknown>;

  /**
   * @param {string} message
   * @param {number} status
   * @param {string} code
   * @param {Record<string, unknown>} body
   */
  constructor(message: string, status: number, code: string, body: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }

  /** 409 时服务端给出的当前哈希（没有就是 null）。 */
  get currentHash(): string | null {
    const value = this.body.currentHash;
    return typeof value === 'string' ? value : null;
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const hasBody = init.body !== undefined && init.body !== null;
  const response = await fetch(path, {
    cache: 'no-store',
    ...init,
    headers: {
      accept: 'application/json',
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  let body: Record<string, unknown> | null = null;
  try {
    body = /** @type {Record<string, unknown>} */ (await response.json());
  } catch {
    body = null;
  }
  if (!response.ok || body === null || body.ok === false) {
    const code = typeof body?.code === 'string' ? body.code : `HTTP_${response.status}`;
    const message = typeof body?.message === 'string' ? body.message : `Studio 返回 ${response.status}`;
    throw new ApiError(message, response.status, code, body ?? {});
  }
  return body as T;
}

export interface OpenResult {
  ok: true;
  existing?: boolean;
  project: ProjectSummary;
}

/** Studio 的健康检查（HTTP 自身的能力，不依赖 preload）。 */
export async function health(): Promise<HealthResponse> {
  try {
    const response = await fetch('/healthz', { cache: 'no-store' });
    if (!response.ok) return { ok: false };
    return /** @type {HealthResponse} */ (await response.json());
  } catch {
    return { ok: false };
  }
}

/** @param {string} [root] */
export async function listProjects(root?: string): Promise<ProjectListItem[]> {
  const body = await listProjectsWithRecent(root);
  return body.projects;
}

/**
 * `GET /api/projects` 的完整响应（M56）。
 *
 * `recent` 来自服务端的 `~/.opencut/projects.json`；`recentCorrupt` 为真表示索引坏了
 * （服务端已备份原文件），UI 只提示、不阻断列表。
 * @param {string} [root]
 */
export async function listProjectsWithRecent(
  root?: string,
): Promise<{ projects: ProjectListItem[]; recent: RecentProjectItem[]; recentCorrupt: boolean }> {
  const suffix = root === undefined || root === '' ? '' : `?root=${encodeURIComponent(root)}`;
  const body = await call<{
    ok: true;
    projects: ProjectListItem[];
    recent?: RecentProjectItem[];
    recentCorrupt?: boolean;
  }>(`/api/projects${suffix}`);
  return {
    projects: body.projects,
    recent: body.recent ?? [],
    recentCorrupt: body.recentCorrupt === true,
  };
}

/** @param {string} dir */
export async function openProject(dir: string): Promise<OpenResult> {
  return call<OpenResult>('/api/projects/open', { method: 'POST', body: JSON.stringify({ dir }) });
}

export async function createStudioProject(name: string): Promise<{ ok: true; dir: string; projectId: string }> {
  return call('/api/projects/create', { method: 'POST', body: JSON.stringify({ name }) });
}

/**
 * 从「最近工程」里移除一条（M56-B）。只改索引，不删磁盘。
 * @param {string} projectPath
 */
export async function removeRecentProject(
  projectPath: string,
): Promise<{ ok: boolean; removed: boolean; projects?: RecentProjectItem[] }> {
  return call('/api/projects/recent/remove', { method: 'POST', body: JSON.stringify({ path: projectPath }) });
}

/**
 * 导出工程包（M59）：服务端负责打包，落点由这里给。
 *
 * `outPath` 省略时服务端落在 `<工程>/exports/<工程名>-<时间戳>.zip`——浏览器宿主（没有
 * 保存框）和「一键导出」都走这条；Electron 选了位置才带 `outPath`。
 * @param {string} projectId
 * @param {string} [outPath]
 */
export async function archiveProject(
  projectId: string,
  outPath?: string,
): Promise<{ ok: true; path: string; bytes: number; files: number; manifest: unknown }> {
  return call(`/api/projects/${encodeURIComponent(projectId)}/archive`, {
    method: 'POST',
    body: JSON.stringify(outPath === undefined || outPath === '' ? {} : { outPath }),
  });
}

/**
 * 导入工程包（M59）：解到 `<projectsRoot>/<包里的工程名>`，重名自动追加 `-2`。
 * 清单对不上照样解出来（数据比一致性重要），`mismatch` / `extra` 原样回给调用方展示。
 * @param {string} zipPath
 * @param {string} [dir]
 */
export async function importProject(
  zipPath: string,
  dir?: string,
): Promise<{
  ok: true;
  dir: string;
  files: number;
  mismatch: Array<{ path: string; reason: string }>;
  extra: string[];
  project: ProjectSummary;
}> {
  return call('/api/projects/import', {
    method: 'POST',
    body: JSON.stringify(dir === undefined || dir === '' ? { zipPath } : { zipPath, dir }),
  });
}

/** @param {string} projectId */
export async function getProject(projectId: string): Promise<ProjectSummary | null> {
  try {
    const body = await call<{ ok: true; project: ProjectSummary }>(`/api/projects/${encodeURIComponent(projectId)}`);
    return body.project;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** @param {string} projectId */
export async function getDoc(projectId: string): Promise<DocResponse> {
  return call<DocResponse>(`/api/projects/${encodeURIComponent(projectId)}/doc`);
}

/**
 * 只读图层列表（M66）。`GET /api/layers`。
 *
 * 契约见 `coordination/openfilm-complete-r2/API-CONTRACT-R50.json` v1：
 * 返回 `layers[]`（id/tag/box/text?/source）与 `pageErrors[]`。
 * 失败时抛 `ApiError`（code 为 FILM_NOT_FOUND / BAD_REQUEST / PAGE_UNREACHABLE）。
 */
export async function getStageLayers(
  projectId: string,
  opts: { clip?: string; t?: number } = {},
): Promise<StageLayersResponse> {
  const query = new URLSearchParams({ project: projectId });
  if (typeof opts.clip === 'string' && opts.clip !== '') query.set('clip', opts.clip);
  if (typeof opts.t === 'number' && Number.isFinite(opts.t)) query.set('t', String(opts.t));
  return call<StageLayersResponse>(`/api/layers?${query.toString()}`);
}

/**
 * 只读元素检查（M66）。`POST /api/elements/inspect`。
 *
 * `elementId` 就是 `/api/layers` 返回的 `id`（定位串）；
 * 返回 `groups[].fields[]`，字段的 `editable` 由服务端按锁定状态给。
 */
export async function inspectElement(
  projectId: string,
  elementId: string,
  clipId = '',
): Promise<InspectResponse> {
  const body: Record<string, string> = { project: projectId, elementId };
  if (clipId !== '') body.clipId = clipId;
  return call<InspectResponse>('/api/elements/inspect', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * 一批 Op 一次写（唯一写入口）。
 * @param {string} projectId
 * @param {Envelope} envelope
 * @param {readonly EditOp[]} ops
 */
export async function postOps(projectId: string, envelope: Envelope, ops: readonly EditOp[]): Promise<EditOk> {
  return call<EditOk>(`/api/projects/${encodeURIComponent(projectId)}/ops`, {
    method: 'POST',
    body: JSON.stringify({ envelope, ops }),
  });
}

/**
 * @param {string} projectId
 * @param {'undo'|'redo'} kind
 * @param {string} [expectedHash]
 */
export async function history(projectId: string, kind: 'undo' | 'redo', expectedHash?: string): Promise<EditOk> {
  return call<EditOk>(`/api/projects/${encodeURIComponent(projectId)}/${kind}`, {
    method: 'POST',
    body: JSON.stringify(expectedHash === undefined ? {} : { expectedHash }),
  });
}


// —— 素材库（M20）——

/** `GET /api/projects/:id/assets`：assets/ 里的文件清单（含 probe 出来的时长/尺寸）。 */
export async function listAssets(projectId: string): Promise<AssetItem[]> {
  const body = await call<{ ok: true; assets: AssetItem[] }>(`/api/projects/${encodeURIComponent(projectId)}/assets`, {
    cache: 'no-store',
  });
  return body.assets;
}

/** 缩略图 URL（直接给 <img src>；音频没有缩略图，UI 用字形占位）。 */
export function assetThumbUrl(projectId: string, name: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(name)}/thumb`;
}

export interface InsertAssetResult {
  ok: true;
  hash: string;
  clipId: string;
  assetPath: string;
  kind: 'video' | 'sound' | 'still';
  bytes: number;
  at: number;
  /** 波纹插入时被右移的片段数（0 = 没开波纹 / 插入点后面没东西）。 */
  shifted?: number;
}

/**
 * 把已有素材插回时间线（不复制文件，src 仍指向同一个 assets/ 路径）。
 *
 * `ripple: true` + `track`：服务端在**同一个 Op 批**里把该轨插入点之后的片段右移，
 * 所以调用方只会看到一次写入、一步撤销（M23-A3）。
 */
export async function insertAsset(
  projectId: string,
  name: string,
  at?: number,
  options?: { ripple?: boolean; track?: number },
): Promise<InsertAssetResult> {
  const body: Record<string, unknown> = {};
  if (at !== undefined) body.at = at;
  if (options?.ripple === true) body.ripple = true;
  if (options?.track !== undefined) body.track = options.track;
  return call<InsertAssetResult>(`/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(name)}/insert`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}


// —— 字幕（M24）——

export interface SubtitleFile {
  ok: true;
  found: boolean;
  file: string | null;
  format: 'vtt' | 'srt';
  cues: SubtitleCue[];
  skipped: number;
  bytes: number;
  hash: string | null;
}

/** 读某个片段 src 的伴生字幕（`a.mp4` → `a.vtt` 优先）。找不到 = found:false，不是错误。 */
export async function getSubtitles(projectId: string, src: string): Promise<SubtitleFile> {
  return call<SubtitleFile>(`/api/projects/${encodeURIComponent(projectId)}/subtitles?src=${encodeURIComponent(src)}`);
}

export interface SaveSubtitleResult {
  ok: true;
  file: string;
  format: 'vtt' | 'srt';
  bytes: number;
  hash: string;
  history: { ok?: boolean; commit?: string; code?: string } | null;
}

/**
 * 写回字幕：格式跟随原文件（vtt→vtt、srt→srt），原子写 + 回读校验 + .film/history。
 *
 * `format` 只在**新建**伴生文件时用得上（导入 `.srt` 到还没有字幕的片段上时应落 `.srt`）；
 * 已有文件时仍然跟随已有那份。不给就是 `vtt`（与这条参数加进来之前逐字节相同）。
 */
export async function saveSubtitles(
  projectId: string,
  src: string,
  cues: SubtitleCue[],
  format?: 'vtt' | 'srt',
): Promise<SaveSubtitleResult> {
  return call<SaveSubtitleResult>(`/api/projects/${encodeURIComponent(projectId)}/subtitles`, {
    method: 'PUT',
    body: JSON.stringify({ src, cues, ...(format === undefined ? {} : { format }) }),
  });
}

/** 导入端点的时间码坏行（最多 5 条，行号从 1 起）。 */
export interface BadTimingLine {
  line: number;
  text: string;
}

export interface ImportSubtitleResult {
  ok: true;
  format: 'vtt' | 'srt';
  /** 格式是看扩展名（`name`）还是看内容嗅探出来的。 */
  formatSource: 'name' | 'content';
  encoding: 'utf-8';
  bom: boolean;
  bytes: number;
  name: string | null;
  cueCount: number;
  cues: SubtitleCue[];
  /** 看着像 cue 但读不出来的块数（不阻断导入）。 */
  skipped: number;
  badLines: BadTimingLine[];
  /** `skipped > 0` 且 `badLines` 为空时的一句人话（跳过原因不是时间码格式）。 */
  skippedNote?: string;
  sha256: string;
  /** `save` 时的落盘结果；只解析时是 null。 */
  saved: SaveSubtitleResult | null;
}

/**
 * `POST /api/projects/:id/subtitles/import` —— 吃**真实文件**，产出段列表。
 *
 * 请求体是文件字节本身（不是 JSON 里的字符串）：服务端要拿到原始字节才判得出
 * 「这不是 UTF-8」。默认**只解析不落盘**，`save: true` 才写回伴生文件
 * （写仍走 `PUT /subtitles` 同一条路：原子写 + 回读校验 + `.film/history`）。
 *
 * 错误码（`ApiError.code`，可按码给文案，**不要只弹「导入失败」**）：
 * `SUBTITLE_EMPTY` 空文件 / `SUBTITLE_NOT_UTF8` 不是 UTF-8（GBK、UTF-16）/
 * `SUBTITLE_BAD_TIMECODE` 时间码不合法（`body.badLines` 里有行号）/
 * `SUBTITLE_NO_CUES` 不像字幕文件 / `SUBTITLE_FORMAT_UNKNOWN` 扩展名与内容都判不出 /
 * `SUBTITLE_TOO_LARGE` 超过 2 MiB。
 */
export async function importSubtitles(
  projectId: string,
  file: Blob & { name?: string },
  options: { src?: string; save?: boolean; format?: 'vtt' | 'srt'; name?: string } = {},
): Promise<ImportSubtitleResult> {
  const query = new URLSearchParams();
  query.set('name', options.name ?? file.name ?? '');
  if (options.src !== undefined && options.src !== '') query.set('src', options.src);
  if (options.save === true) query.set('save', '1');
  if (options.format !== undefined) query.set('format', options.format);
  return call<ImportSubtitleResult>(
    `/api/projects/${encodeURIComponent(projectId)}/subtitles/import?${query.toString()}`,
    {
      method: 'POST',
      body: file,
      headers: { 'content-type': file.type === '' ? 'application/octet-stream' : file.type },
    },
  );
}

export interface ExportSubtitleResult {
  ok: true;
  format: 'vtt' | 'srt';
  text: string;
  bytes: number;
  sha256: string;
  cueCount: number;
  cues: SubtitleCue[];
  /** 当场自证：导出文本重解析后线索等价、再序列化逐字节相同。 */
  roundTrip: { cueEqual: boolean; byteIdentical: boolean; reparsedCueCount: number; reparsedSha256: string };
}

/**
 * `POST /api/projects/:id/subtitles/export` —— 段列表 → 字幕文本（纯函数，不读盘）。
 * 要文件就让调用方把 `text` 包成 `Blob`：服务端不该替 UI 决定文件名。
 */
export async function exportSubtitles(
  projectId: string,
  cues: SubtitleCue[],
  format: 'vtt' | 'srt' = 'vtt',
): Promise<ExportSubtitleResult> {
  return call<ExportSubtitleResult>(`/api/projects/${encodeURIComponent(projectId)}/subtitles/export`, {
    method: 'POST',
    body: JSON.stringify({ cues, format }),
  });
}

/** Analyse the exact saved clip source range. Edits still go through postOps. */
export async function measureClipLoudness(
  projectId: string, clipId: string, expectedHash: string, preset: 'streaming' | 'broadcast',
): Promise<{ ok: true; hash: string; ops: EditOp[]; loudness: { estimatedLufs: number; limitedBy: 'peak' | 'volume' | null } }> {
  return call(`/api/projects/${encodeURIComponent(projectId)}/clip-loudness`, {
    method: 'POST', body: JSON.stringify({ clipId, expectedHash, preset }),
  });
}

// —— 导出（M17）——

export interface ExportStartInput {
  projectId: string;
  clipId?: string;
  expectedHash?: string;
  /** 'all' 或 { start, end }（秒）。 */
  range?: 'all' | { start: number; end: number };
  /**
   * 多段区间（M39）：1–100 段，顺序即拼接顺序。与 `range` **互斥**
   * （同时给服务端 400 `INVALID_RANGE`）。
   */
  ranges?: Array<[number, number]>;
  quality?: 'draft' | 'standard' | 'high';
  /**
   * 视频编码（M50）。**h264 不发字段**——服务端缺省就是 h264，不选时的请求体
   * 与 R24 逐字节相同；hevc 才带 `codec:'hevc'`。
   *
   * 2026-11-09 修：这个字段以前只写在 `ExportForm` 里，`startExport` 从未把它放进
   * 请求体，于是 UI 里选 HEVC 实际导出 h264（M54 的 A2 抓请求体时发现）。tsc 没报
   * 是因为 App 用条件展开传参，绕过了对象字面量的多余属性检查。
   */
  codec?: 'h264' | 'hevc';
  /** 空 = 工程内 exports/。 */
  outDir?: string;
  /** 显式输出文件（绝对路径，必须在工程目录内）；与 outDir 互斥。 */
  outPath?: string;
  /** 烧字幕（M41）：true 时出 master/subbed/vtt 三件套。 */
  subtitleBurn?: boolean;
  /** 字幕挂在哪条素材（工程相对路径，通常是第一个视频片段）；burn=false 时不发。 */
  subtitleSrc?: string;
  /** 交付画幅（M42）：null/不给 = 跟随工程。 */
  size?: { w: number; h: number } | null;
  /** 适配（M42）：只在给了 size 时有意义。 */
  fit?: 'letterbox' | 'cover' | null;
  /** 输出帧率（M42）：缺省 30。 */
  fps?: number | null;
  /**
   * 目标序列（M78 / S73）：不传 = 当前打开的序列。
   *
   * **`main` 一律不发这个字段**——服务端缺省就是 main，旧工程的请求体因此与本批
   * 之前逐字节相同（S73 的 A6 就是拿请求体比对这条）。
   */
  sequence?: string | null;
}

/** `POST /api/export` → 202 入队（state 可能是 queued；队列串行，不再 409）。 */
export async function startExport(input: ExportStartInput): Promise<ExportJobView> {
  const body = await call<{ ok: true; job: ExportJobView }>('/api/export', {
    method: 'POST',
    body: JSON.stringify({
      projectId: input.projectId,
      ...(input.clipId === undefined ? {} : { clipId: input.clipId, expectedHash: input.expectedHash }),
      // 多段与 `range` **只发一个**：服务端把「同时给」当错误（INVALID_RANGE），
      // 所以这里不学「发出去让服务端挑」——那会让每次多段导出都白跑一趟 400。
      ...(input.ranges !== undefined && input.ranges.length > 0
        ? { ranges: input.ranges }
        : input.range === undefined
          ? {}
          : { range: input.range }),
      ...(input.quality === undefined ? {} : { quality: input.quality }),
      ...(input.codec === undefined || input.codec === 'h264' ? {} : { codec: input.codec }),
      ...(input.outDir === undefined || input.outDir === '' ? {} : { outDir: input.outDir }),
      ...(input.outPath === undefined || input.outPath === '' ? {} : { outPath: input.outPath }),
      // 画幅（M42）：**只有给了 size 才发 fit**——服务端把「没有 size 却给 fit」当错误。
      ...(input.size === undefined || input.size === null
        ? {}
        : { size: input.size, ...(input.fit === undefined || input.fit === null ? {} : { fit: input.fit }) }),
      ...(input.fps === undefined || input.fps === null ? {} : { fps: input.fps }),
      // 烧字幕：**只在真开时发两个字段**。关掉时不发 → 请求体与 R20 逐字节相同（A1 的回归）。
      ...(input.subtitleBurn === true && input.subtitleSrc !== undefined && input.subtitleSrc !== ''
        ? { subtitleBurn: true, subtitleSrc: input.subtitleSrc }
        : {}),
      // 序列（S73）：main / 空 都不发——旧工程的请求体一个字节都不变。
      ...(input.sequence === undefined || input.sequence === null || input.sequence === '' || input.sequence === 'main'
        ? {}
        : { sequence: input.sequence }),
    }),
  });
  return body.job;
}

export interface ExportQueueView {
  jobs: ExportJobView[];
  summary: { running: string | null; queued: number; next: string | null; total: number };
}

// —— 字幕样式（M40）——

/** `GET /api/projects/:id/subtitle-style`：没有样式文件时 `exists:false` + 默认值。 */
export async function getSubtitleStyle(projectId: string): Promise<SubtitleStyleResponse> {
  return call<SubtitleStyleResponse>(`/api/projects/${encodeURIComponent(projectId)}/subtitle-style`);
}

/**
 * `PUT /api/projects/:id/subtitle-style`：**补丁语义**（覆盖在已存样式之上）。
 *
 * 400 有两种，都会抛 `ApiError`（UI 直接把 message 显示出来）：
 * `UNKNOWN_FIELD`（带 field）/ `INVALID_STYLE`（带 issues）。
 *
 * `keepalive` 只给 `beforeunload` 用（M45）：`sendBeacon` 只发 POST，而这里是 PUT，
 * 所以只能让 fetch 自己活过页面卸载。普通保存不传，行为与 M40 逐字节相同。
 */
export async function putSubtitleStyle(
  projectId: string,
  style: Partial<SubtitleStyleFields>,
  options: { keepalive?: boolean } = {},
): Promise<SubtitleStyleResponse> {
  return call<SubtitleStyleResponse>(`/api/projects/${encodeURIComponent(projectId)}/subtitle-style`, {
    method: 'PUT',
    body: JSON.stringify({ style }),
    ...(options.keepalive === true ? { keepalive: true } : {}),
  });
}

/* ── 设置中心（M49）：用户级设置，与工程无关 ────────────────────────── */

/** 六个真分区里**会持久化**的字段（其余只读/占位）。 */
/**
 * `export.last`（M54）：上次导出成功后记住的参数，重开 Studio 时表单初值就用它。
 * `fps` 是 `number` 不是枚举——29.97 / 23.976 这类工程帧率必须原样还回去。
 */
export interface ExportLastFields {
  codec?: 'h264' | 'hevc';
  quality?: 'draft' | 'standard' | 'high';
  fps?: number;
  /** `''` = 跟随工程。 */
  size?: string;
  fit?: 'letterbox' | 'cover';
  loudness?: number;
  subtitleBurn?: boolean;
}

/**
 * 一条外部 MCP server（M65）。字段与服务端 `checkMcpServerEntry` 一一对应：
 * `name` 小写字母/数字开头、2–32 位、只允许 `-` `_`；`args` 字符串数组；`env` 字符串→字符串。
 */
export interface McpServerEntry {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
}

export interface SettingsFields {
  appearance?: { theme: 'dark' | 'light' };
  playback: { volume: number; loop: boolean; hideCursorWhilePlaying: boolean };
  export: {
    fps: 24 | 25 | 30 | 60;
    codec: 'h264' | 'hevc';
    quality: 'draft' | 'standard' | 'high';
    last?: ExportLastFields | null;
  };
  /** MCP 外部 server（M65）：`PUT` 是**整段替换** `mcp.servers`，所以界面必须带全量。 */
  mcp?: { servers: McpServerEntry[] };
  /**
   * CS1（AC08/SET04）：Agent 显示开关。`null` = 没配过（全部启用）；
   * 数组 = 白名单（`[]` 就是全关）。
   */
  agent?: { enabled: string[] | null };
  /**
   * CS1（AC11/SET06–08）：自有模型的路由参数。Key 不在这里（`keys/model.enc`）。
   * `format` 对应 `packages/providers` 的三条 wire：换 URL 不等于换协议。
   */
  byok?: {
    name: string;
    format: 'openai-chat' | 'openai-responses' | 'anthropic-messages';
    baseUrl: string;
    model: string;
    reasoning: 'auto' | 'off' | 'low' | 'medium' | 'high';
    contextTokens: number;
  };
}

/** `PUT /api/settings` 是**分区级补丁**：分区里只传改动的字段。 */
export type SettingsPatch = { [K in keyof SettingsFields]?: Partial<SettingsFields[K]> };

/** 五个 AI 分区只读卡片：路径 + 是否检测到 + 只读原因（没有内容、没有密钥）。 */
export interface SettingsAiCard {
  id: string;
  label: string;
  path: string;
  exists: boolean;
  reason: string;
}

export interface SettingsResponse {
  ok: boolean;
  settings: SettingsFields;
  defaults: SettingsFields;
  issues: string[];
  path: string;
  exists: boolean;
  updatedAt: string | null;
  version: number;
  ai: SettingsAiCard[];
}

export interface SettingsSaveResponse {
  ok: boolean;
  settings: SettingsFields;
  path: string;
  updatedAt: string;
  sha256: string;
  bytes: number;
}

export interface SettingsDiagnostics {
  ok: boolean;
  studioVersion: string;
  settingsPath: string;
  ffmpeg: { path: string; ok: boolean; line: string };
  ports: Record<string, number>;
  projectRoot: string;
  logsDir: string;
  node: string;
  platform: string;
}

export interface StorageReport {
  ok: boolean;
  projectId: string;
  projectDir: string;
  history: { files: number; bytes: number; exists: boolean; snapshots: number };
  exports: { files: number; bytes: number; exists: boolean };
  snapshotDir: string;
}

/** `GET /api/settings`：读用户级设置（不改任何磁盘状态）。 */
export async function getSettings(): Promise<SettingsResponse> {
  return call<SettingsResponse>('/api/settings', { cache: 'no-store' });
}

/**
 * 「我的模型 Key」的状态（B-SUB1-R31-054）。
 *
 * **没有 key 字段**：服务端只回 `configured + 尾 4 位`，明文/密文都不下发给渲染层。
 * `issue === 'KEY_UNREADABLE'` 表示文件在但解不开（不是未配置）。
 */
export interface ModelKeyStatus {
  ok: boolean;
  configured: boolean;
  tail: string | null;
  updatedAt: string | null;
  backend?: string;
  issue?: string | null;
}

/** 「测试连接」的结果：成功只有 200/模型信息，失败带机器可读 code。 */
export interface ModelKeyCheck {
  ok: boolean;
  status?: number | null;
  wire?: string;
  model?: string;
  baseUrl?: string;
  textLength?: number;
  latencyMs?: number;
  code?: string;
  message?: string;
}

export async function getModelKey(): Promise<ModelKeyStatus> {
  return call<ModelKeyStatus>('/api/settings/model-key', { cache: 'no-store' });
}

/** 保存/覆盖。空串/太短由服务端拒（`KEY_EMPTY` / `KEY_TOO_SHORT`），界面不先拦。 */
export async function putModelKey(key: string): Promise<ModelKeyStatus> {
  return call<ModelKeyStatus>('/api/settings/model-key', {
    method: 'PUT',
    body: JSON.stringify({ key }),
  });
}

export async function deleteModelKey(): Promise<ModelKeyStatus> {
  return call<ModelKeyStatus>('/api/settings/model-key', { method: 'DELETE' });
}

/** 用已保存的 Key 发一次最小请求（`providers/client.mjs` 那条路）。 */
export async function checkModelKey(): Promise<ModelKeyCheck> {
  return call<ModelKeyCheck>('/api/settings/model-key/check', { method: 'POST' });
}

/** `PUT /api/settings`：**补丁语义**（只传改动的分区/字段）。 */
export async function putSettings(patch: SettingsPatch): Promise<SettingsSaveResponse> {
  return call<SettingsSaveResponse>('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ settings: patch }),
  });
}

export async function getSettingsDiagnostics(): Promise<SettingsDiagnostics> {
  return call<SettingsDiagnostics>('/api/settings/diagnostics', { cache: 'no-store' });
}

export async function getSettingsStorage(projectId: string): Promise<StorageReport> {
  return call<StorageReport>(`/api/settings/storage?projectId=${encodeURIComponent(projectId)}`, { cache: 'no-store' });
}

/** `POST /api/settings/cache/clean`：只清 `.film/history/snapshots` 的旧文件。 */
export async function cleanSettingsCache(
  projectId: string,
  options: { keep?: number; confirm: boolean },
): Promise<{ ok: boolean; before?: number; deleted?: number; kept?: number; bytes?: number; code?: string; message?: string }> {
  return call('/api/settings/cache/clean', {
    method: 'POST',
    body: JSON.stringify({ projectId, keep: options.keep, confirm: options.confirm }),
  });
}

/* ── Agent 原创场景（M71 · WP21）─────────────────────────────────────────
 * 三段：草稿（不写盘）→ apply（写盘，幂等）→ rollback（用快照恢复）。
 * 界面**不许**把 mock provider 说成真实生成：响应里 `providerIsMock` 为真时
 * 草稿区固定显示 `provider: mock`。
 */

export interface AgentSceneProviderInfo {
  id: string;
  model: string | null;
  capabilities: { thinking: boolean; speed: boolean; images: boolean };
}

export interface AgentSceneDraft {
  draftId: string;
  /**
   * R114-B2：草稿回包是**对象**（`{id, model, capabilities}`）。
   * 老服务端（以及 apply 回包）仍是字符串，所以两种都认 —— 读的时候用
   * `agentProviderIdOf()` 归一，不要直接拼进字符串。
   */
  provider: string | AgentSceneProviderInfo;
  providerIsMock: boolean;
  seed: string;
  ops: unknown[];
  summary: string;
  warnings: string[];
  scope: string[];
  baseHash: string;
}

export interface AgentSceneApplyResult {
  ok: true;
  alreadyApplied: boolean;
  applied: number;
  sha256Before: string | null;
  sha256After: string;
  touched: string[];
  snapshotSha: string | null;
  seed: string;
  provider: string;
}

export interface AgentSceneRollbackResult {
  ok: true;
  sha256: string;
  restoredFrom: string;
  restored: string[];
  reopened: boolean;
}

/** `POST /api/agent/scene`：只出草稿，**不写盘**。 */
export async function draftAgentScene(projectId: string, prompt: string, seed?: string): Promise<AgentSceneDraft> {
  return call<AgentSceneDraft>('/api/agent/scene', {
    method: 'POST',
    body: JSON.stringify({ project: projectId, prompt, ...(seed === undefined ? {} : { seed }) }),
  });
}

/**
 * `POST /api/agent/scene/:id/approval`：用户点「允许」那一刻换一张一次性批准票。
 * 它与 ACP 工具票是两条链 —— 应用草稿必须走这张票。
 */
export interface AgentSceneApproval {
  ok: boolean;
  draftId: string;
  textOnly: boolean;
  alreadyApplied: boolean;
  approvalToken: string | null;
  expiresAt: string | null;
  projectId: string;
  baseHash: string;
  ttlMs?: number;
}

export async function approveAgentScene(draftId: string): Promise<AgentSceneApproval> {
  return call<AgentSceneApproval>(`/api/agent/scene/${encodeURIComponent(draftId)}/approval`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/** `POST /api/agent/scene/:id/apply`：幂等（第二次返回 `alreadyApplied`）。写盘那一次必须带批准票。 */
export async function applyAgentScene(draftId: string, approvalToken: string): Promise<AgentSceneApplyResult> {
  return call<AgentSceneApplyResult>(`/api/agent/scene/${encodeURIComponent(draftId)}/apply`, {
    method: 'POST',
    body: JSON.stringify({}),
    headers: { 'x-opencut-apply-approval': approvalToken },
  });
}

/** `POST /api/agent/scene/:id/rollback`：回到 apply 前的快照。 */
export async function rollbackAgentScene(draftId: string): Promise<AgentSceneRollbackResult> {
  return call<AgentSceneRollbackResult>(`/api/agent/scene/${encodeURIComponent(draftId)}/rollback`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/** F08 会话列表（R27 · E12/F08 UI）：服务端三端点见 `server/agent-sessions.mjs`。 */
export interface AgentSessionRow {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
  pinned?: boolean;
  archived?: boolean;
}

/**
 * 回合里的一个步骤（E09 · E2）。`op` 是 ops 的 kind（`overrides` / `set` / …），
 * `text` 是人话摘要。两者都可能为空串（服务端只保证字段在）。
 */
export interface AgentSessionTurnStep {
  op: string;
  text: string;
}

/** 一个回合（`turns/<turn>.json` 里的 `turn`，服务端已裁剪成这几个字段）。 */
export interface AgentSessionTurn {
  id: string;
  prompt: string;
  draftId: string | null;
  state: string | null;
  at: string | null;
  /** R35：可选。老回合没有这个字段 → UI 不渲染步骤行（不编「0 个步骤」）。 */
  steps?: AgentSessionTurnStep[];
}

/** `GET /api/projects/:id/agent/sessions`：只回 `turns>0`，pinned 优先 → updatedAt 倒序。 */
export async function listAgentSessions(projectId: string): Promise<{
  ok: true;
  version: number;
  last: string | null;
  sessions: AgentSessionRow[];
  total: number;
  hidden: number;
}> {
  return call(`/api/projects/${encodeURIComponent(projectId)}/agent/sessions`, { cache: 'no-store' });
}

/** `POST /api/projects/:id/agent/sessions`：已有空会话就返回它（`created:false`）。 */
export async function createAgentSession(projectId: string): Promise<{
  ok: true;
  created: boolean;
  session: AgentSessionRow;
  last: string | null;
}> {
  return call(`/api/projects/${encodeURIComponent(projectId)}/agent/sessions`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/** `GET /api/projects/:id/agent/sessions/:sid`：点开一条会话（含 turns）。 */
export async function getAgentSession(
  projectId: string,
  sessionId: string,
): Promise<{ ok: true; session: AgentSessionRow; turns: AgentSessionTurn[]; lastDraft: unknown }> {
  return call(`/api/projects/${encodeURIComponent(projectId)}/agent/sessions/${encodeURIComponent(sessionId)}`, { cache: 'no-store' });
}

/** `GET /api/agent/scene/:id`：查草稿当前状态（applied / rolledBack）。 */
export async function getAgentScene(draftId: string): Promise<{ ok: true; draft: AgentSceneDraft & { applied: boolean; rolledBack: boolean } }> {
  return call(`/api/agent/scene/${encodeURIComponent(draftId)}`, { cache: 'no-store' });
}

/**
 * `PATCH /api/projects/:id/agent/sessions/:sid`：改会话元数据（R114-B2 追加，签名不动老的）。
 *
 * 只接受 `title` / `pinned` / `archived` 三个键；`archived:false` = 恢复。
 * 服务端错误码：`EMPTY_PATCH`（空 patch）/ `TITLE_INVALID` / `UNKNOWN_FIELD` /
 * `SESSION_NOT_FOUND` / `SESSION_RUNNING`（409，运行中不许归档）/ `CHAT_WRITE_FAILED`。
 */
export async function patchAgentSession(
  projectId: string,
  sessionId: string,
  patch: { title?: string; pinned?: boolean; archived?: boolean },
): Promise<{ ok: true; session: AgentSessionRow; last: string | null }> {
  return call(`/api/projects/${encodeURIComponent(projectId)}/agent/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

// —— 多序列（M78 后端 / S73 界面）——

/** 一条序列的现状：`stage`/`filmHtmlSha256` 都是**现读现算**，不是缓存。 */
export interface SequenceInfo {
  id: string;
  name: string;
  dir: string;
  stage: { w: number; h: number } | null;
  filmHtmlSha256: string | null;
  bytes: number;
  /** film.html 不在了（目录被删/改名）——界面要能说出这句，而不是画一个空序列。 */
  missing: boolean;
  createdAt: string | null;
}

export interface SequencesListResponse {
  ok: true;
  current: string;
  sequences: SequenceInfo[];
  /** false = 还是「懒索引」：只有 main，磁盘上连 .film/sequences.json 都没有。 */
  materialized: boolean;
  indexPath: string;
  indexSha256: string | null;
}

/** `GET /api/projects/:id/sequences`：**不缓存**——面板每次展开都重新取一次。 */
export async function listSequences(projectId: string): Promise<SequencesListResponse> {
  return call<SequencesListResponse>(`/api/projects/${encodeURIComponent(projectId)}/sequences`, { cache: 'no-store' });
}

export interface CreateSequenceResult {
  ok: true;
  sequence: SequenceInfo & { bytes: number; createdAt: string };
  current: string;
  index: { path: string; sha256: string };
  template: string;
}

/** `POST /api/projects/:id/sequences`：同名 409（`SEQUENCE_EXISTS`）、名字非法 400（`field:"name"`）。 */
export async function createSequence(
  projectId: string,
  input: { name: string; stage?: { w: number; h: number } },
): Promise<CreateSequenceResult> {
  return call<CreateSequenceResult>(`/api/projects/${encodeURIComponent(projectId)}/sequences`, {
    method: 'POST',
    body: JSON.stringify({ name: input.name, ...(input.stage === undefined ? {} : { stage: input.stage }) }),
  });
}

export interface SwitchSequenceResult {
  ok: true;
  current: string;
  changed: boolean;
  materialized: boolean;
  /** 切换前后所有序列的 sha：用来证明「切换只写索引，film.html 一个字节没动」。 */
  shas: { before: Record<string, string | null>; after: Record<string, string | null> };
  index: { path: string; sha256: string | null; beforeSha256?: string | null };
}

/** `PUT /api/projects/:id/sequences/current`：**只改索引**，之后的 doc/layers 都得重取。 */
export async function switchSequence(projectId: string, id: string): Promise<SwitchSequenceResult> {
  return call<SwitchSequenceResult>(`/api/projects/${encodeURIComponent(projectId)}/sequences/current`, {
    method: 'PUT',
    body: JSON.stringify({ id }),
  });
}

export interface DeleteSequenceResult {
  ok: true;
  removed: string;
  /** 目录进了 `.film/trash/`，从不真删。 */
  trash: string;
  current: string;
}

/** `DELETE /api/projects/:id/sequences/:sid`：三条 409 见 `sequence-errors.ts`。 */
export async function deleteSequence(projectId: string, id: string): Promise<DeleteSequenceResult> {
  return call<DeleteSequenceResult>(
    `/api/projects/${encodeURIComponent(projectId)}/sequences/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
}

/** `GET /api/export` → 全量队列（入队顺序）+ 摘要。UI 轮询它。 */
export async function listExports(): Promise<ExportQueueView> {
  const body = await call<{ ok: true; jobs: ExportJobView[]; summary: ExportQueueView['summary'] }>('/api/export', {
    cache: 'no-store',
  });
  return {
    jobs: Array.isArray(body.jobs) ? body.jobs : [],
    summary: {
      running: body.summary?.running ?? null,
      queued: Number(body.summary?.queued) || 0,
      next: body.summary?.next ?? null,
      total: Number(body.summary?.total) || 0,
    },
  };
}

/** `GET /api/export/:id` → 进度快照（UI 轮询它）。 */
export async function exportStatus(id: string): Promise<ExportJobView> {
  const body = await call<{ ok: true; job: ExportJobView }>(`/api/export/${encodeURIComponent(id)}`, {
    cache: 'no-store',
  });
  return body.job;
}

/** `DELETE /api/export/:id` → 取消（幂等：已结束的作业原样返回）。 */
export async function cancelExport(id: string): Promise<ExportJobView> {
  const body = await call<{ ok: true; job: ExportJobView }>(`/api/export/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  return body.job;
}


// —— 素材导入（M18）——

export interface MediaImportInput {
  projectId: string;
  /** 桌面版：绝对源路径（与 name+data 二选一）。 */
  source?: string;
  /** 浏览器兜底：文件名 + base64（不带 data: 前缀）。 */
  name?: string;
  data?: string;
  /** 秒；不传 = 影片末尾。 */
  at?: number;
  /** 目标轨道序号；不传 = 同类型最后一条轨。 */
  track?: number;
}

export interface MediaImportResult {
  ok: true;
  hash: string;
  clipId: string;
  assetPath: string;
  kind: 'video' | 'sound' | 'still';
  bytes: number;
  at: number;
}

/** `POST /api/projects/:id/media`：复制进 assets/ 并用 insert op 写 film.html。 */
export async function importMedia(input: MediaImportInput): Promise<MediaImportResult> {
  return call<MediaImportResult>(`/api/projects/${encodeURIComponent(input.projectId)}/media`, {
    method: 'POST',
    body: JSON.stringify({
      ...(input.source === undefined ? {} : { source: input.source }),
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.data === undefined ? {} : { data: input.data }),
      ...(input.at === undefined ? {} : { at: input.at }),
      ...(input.track === undefined ? {} : { track: input.track }),
    }),
  });
}

// —— 素材状态 / 重链（M26）——

/** `GET /api/projects/:id/media-status`：逐条 bare src 判 ok / missing / unreadable。 */
export async function getMediaStatus(projectId: string): Promise<MediaStatus> {
  return call<MediaStatus>(`/api/projects/${encodeURIComponent(projectId)}/media-status`);
}

export interface RelinkTarget {
  clip: string;
  src: string;
  /** 文件在工程外时先复制进 assets/ 再指过去（服务端执行，只写工程内相对路径）。 */
  copy?: boolean;
}

export interface RelinkApplied {
  clip: string;
  from: string;
  to: string;
  kind: string;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  sizeUnverified: boolean;
}

export interface RelinkRejected {
  clip: string;
  code: string;
  message: string;
  suggest?: { trim: [number, number]; availableSec: number };
  old?: { width: number; height: number };
  next?: { width: number; height: number };
}

export interface RelinkResult {
  ok: boolean;
  code?: string;
  message?: string;
  hash?: string;
  undoDepth?: number;
  redoDepth?: number;
  dryRun?: boolean;
  applied: RelinkApplied[];
  rejected: RelinkRejected[];
  warnings: Array<{ clip: string; code: string; message: string }>;
}

/**
 * `POST /api/projects/:id/relink`：把片段 `src` 指到新文件，**保留 `#t=` 与 `at`**。
 * 校验失败时服务端回 400 + `rejected[]`；这里**不抛**，把 body 原样交给调用方显示报码。
 */
export async function relinkMedia(
  projectId: string,
  envelope: Envelope | null,
  targets: RelinkTarget[],
  opts: { dryRun?: boolean } = {},
): Promise<RelinkResult> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/relink`, {
    method: 'POST',
    cache: 'no-store',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      ...(envelope === null ? {} : { envelope }),
      targets,
      ...(opts.dryRun === true ? { dryRun: true } : {}),
    }),
  });
  /** @type {any} */
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return {
    ok: body?.ok === true,
    code: typeof body?.code === 'string' ? body.code : response.ok ? undefined : `HTTP_${response.status}`,
    message: typeof body?.message === 'string' ? body.message : undefined,
    hash: typeof body?.hash === 'string' ? body.hash : undefined,
    undoDepth: typeof body?.undoDepth === 'number' ? body.undoDepth : undefined,
    redoDepth: typeof body?.redoDepth === 'number' ? body.redoDepth : undefined,
    dryRun: body?.dryRun === true,
    applied: Array.isArray(body?.applied) ? body.applied : [],
    rejected: Array.isArray(body?.rejected) ? body.rejected : [],
    warnings: Array.isArray(body?.warnings) ? body.warnings : [],
  };
}

export interface RelinkScan {
  ok: boolean;
  code?: string;
  message?: string;
  dir?: string;
  matched: Array<{ clip: string; oldSrc: string; newSrc: string; name: string; path: string; copy?: boolean }>;
  skipped: Array<{ clip: string; oldSrc: string; reason: string; name?: string }>;
  summary: { relink: number; skip: number };
}

/** `POST /api/projects/:id/relink/scan`：给目录，按文件名匹配缺失片段（只列清单，不写盘）。 */
export async function scanRelink(projectId: string, dir: string, clips?: string[]): Promise<RelinkScan> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/relink/scan`, {
    method: 'POST',
    cache: 'no-store',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ dir, ...(clips === undefined ? {} : { clips }) }),
  });
  /** @type {any} */
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return {
    ok: body?.ok === true,
    code: typeof body?.code === 'string' ? body.code : undefined,
    message: typeof body?.message === 'string' ? body.message : undefined,
    dir: typeof body?.dir === 'string' ? body.dir : dir,
    matched: Array.isArray(body?.matched) ? body.matched : [],
    skipped: Array.isArray(body?.skipped) ? body.skipped : [],
    summary: {
      relink: Number(body?.summary?.relink) || 0,
      skip: Number(body?.summary?.skip) || 0,
    },
  };
}

// —— 动效库 / 应用（M27）——

/** 面板要的条目形状（与 packages/motion/panel.mjs 的 MotionEntryView 逐字段一致）。 */
export interface MotionParamView {
  name: string;
  label: string;
  type: 'number' | 'string' | 'boolean' | 'color' | 'enum';
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
}

export interface MotionEntryView {
  id: string;
  name: string;
  kind: 'animation' | 'component' | 'saved';
  sourceOk: boolean;
  assetIssues: Array<{ path: string; reason: string }>;
  params: MotionParamView[];
}

export interface MotionLibraryView {
  ok: boolean;
  code?: string;
  message?: string;
  projectId?: string;
  entries: MotionEntryView[];
  /** 管理列表：含已归档（面板列表默认不含）。 */
  all: MotionManageEntry[];
  /** 这个片段当前挂的模板与参数（回填命中）。 */
  current: { template: string; values: Record<string, unknown> } | null;
  /** 工程里还没有 motion/library.json。 */
  missing: boolean;
  corrupt: boolean;
}

/**
 * `GET /api/motion/library?project=<id>[&includeArchived=1&clip=<clipId>]`
 *
 * - `includeArchived`：面板列表是否含已归档（默认不含）。
 * - `clip`：传了就按这个片段的 `data-props` **回填参数默认值**（重开工程后表单显示当前值）。
 */
export async function getMotionLibrary(
  projectId: string,
  opts: { includeArchived?: boolean; clipId?: string } = {},
): Promise<MotionLibraryView> {
  const query = new URLSearchParams({ project: projectId });
  if (opts.includeArchived === true) query.set('includeArchived', '1');
  if (opts.clipId !== undefined && opts.clipId !== '') query.set('clip', opts.clipId);
  const response = await fetch(`/api/motion/library?${query.toString()}`, {
    cache: 'no-store',
    headers: { accept: 'application/json' },
  });
  /** @type {any} */
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return {
    ok: body?.ok === true,
    code: typeof body?.code === 'string' ? body.code : response.ok ? undefined : `HTTP_${response.status}`,
    message: typeof body?.message === 'string' ? body.message : undefined,
    projectId: typeof body?.projectId === 'string' ? body.projectId : projectId,
    entries: Array.isArray(body?.entries) ? body.entries : [],
    all: Array.isArray(body?.all) ? body.all : [],
    current: body?.current && typeof body.current.template === 'string' ? body.current : null,
    missing: body?.missing === true,
    corrupt: body?.corrupt === true,
  };
}

/** 模板管理（M30）的统一返回形状：成功带具体字段，失败带引擎错误码 + 人话。 */
export interface MotionManageResult {
  ok: boolean;
  code?: string;
  message?: string;
  entry?: { id: string; name: string; kind: string; version: number; sourcePath: string; paramCount: number; historyCount: number };
  dest?: string;
  reused?: boolean;
  paramsSource?: string;
  copiedAssets?: string[];
  missingAssets?: string[];
  assetIssues?: Array<{ ref: string; path: string }>;
  entryId?: string;
  version?: number;
  historyCount?: number;
  from?: string;
  to?: string;
  restoredHash?: string;
  archived?: boolean;
  referencedBy?: string[];
}

async function motionPost(action: 'save' | 'upgrade' | 'rollback' | 'archive', body: Record<string, unknown>): Promise<MotionManageResult> {
  const response = await fetch(`/api/motion/${action}`, {
    method: 'POST',
    cache: 'no-store',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  /** @type {any} */
  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return {
    ok: payload?.ok === true,
    code: typeof payload?.code === 'string' ? payload.code : payload?.ok === true ? undefined : `HTTP_${response.status}`,
    ...payload,
  };
}

/** `POST /api/motion/save`：以当前 page 片段的场景为源另存为模板（id 冲突 → NAME_TAKEN）。 */
export function saveMotionTemplate(projectId: string, clipId: string, name: string): Promise<MotionManageResult> {
  return motionPost('save', { projectId, clipId, name });
}

/** `POST /api/motion/upgrade`：源改过之后存新版本（无变化 → NO_CHANGE）。 */
export function upgradeMotionTemplate(projectId: string, entryId: string): Promise<MotionManageResult> {
  return motionPost('upgrade', { projectId, entryId });
}

/** `POST /api/motion/rollback`：回到上一版（源文件字节也回退，舞台重载后表现可复现）。 */
export function rollbackMotionTemplate(projectId: string, entryId: string): Promise<MotionManageResult> {
  return motionPost('rollback', { projectId, entryId });
}

/** `POST /api/motion/archive`：归档（不物理删）；被实例引用时 → TEMPLATE_IN_USE。 */
export function archiveMotionTemplate(projectId: string, entryId: string): Promise<MotionManageResult> {
  return motionPost('archive', { projectId, entryId });
}

export interface MotionApplyPlan {
  ok: boolean;
  code?: string;
  message?: string;
  /** 一批 props Op（宿主拿去走 /ops；服务端不写盘）。 */
  ops: EditOp[];
  values?: Record<string, unknown>;
  overrides?: Array<Record<string, unknown>>;
  rootAt?: string;
  scope?: 'instance' | 'body';
  scene?: string;
  template?: { id: string; version: number };
  issues?: Array<{ key: string; reason: string }>;
}

// —— 命名版本（M62 后端 / S75 界面 · WP09）——
//
// 服务端五个接口都在 `studio-server.mjs` 的 `versionsRoute` 上：
//   GET    /api/projects/:id/versions                    列表（git log，默认最多 50 条）
//   POST   /api/projects/:id/versions                    创建（name 必填、≤60 字符）
//   GET    /api/projects/:id/versions/:sha/diff          相对父提交的 numstat
//   POST   /api/projects/:id/versions/:sha/restore       恢复全部文本文件
//   POST   /api/projects/:id/versions/:sha/restore-film  只恢复 film.html（S75 用这个）
//
// 列表**没有字节数字段**（只有 files / mediaCount）——服务端 `listVersions` 就返回这些，
// 本批禁改 server，界面不编一个「大小」出来（交接记 DEV-R39-1）。

/** 一条版本（`git log` 的一行 + 文件/媒体计数）。 */
export interface VersionInfo {
  sha: string;
  /** 7 位短号，服务端算好的。 */
  short: string;
  /** commit subject；空串 = 没有名字（界面显示「自动」）。 */
  name: string;
  /** ISO 时间（服务端用 commit 的 `%ct`，UTC）。 */
  at: string;
  /** 这个版本里的文本文件数。 */
  files: number;
  /** 这个版本记录到的媒体数。 */
  mediaCount: number;
}

export interface VersionsListResponse {
  ok: true;
  /** false = 这台机器没有 git，命名版本不可用。 */
  gitAvailable: boolean;
  /** 新 → 旧。 */
  versions: VersionInfo[];
  /** 工作树相对 HEAD 的未提交改动。非空时「当前」标记要降级成「HEAD · 有未提交改动」。 */
  dirty: { added: string[]; modified: string[]; deleted: string[] };
  /** false = 连 `.film/versions.git` 都还没建（空工程）。 */
  initialized?: boolean;
}

/** `GET /api/projects/:id/versions`：**不缓存**——版本列表会被别的窗口/命令行改。 */
export async function listVersions(projectId: string): Promise<VersionsListResponse> {
  return call<VersionsListResponse>(`/api/projects/${encodeURIComponent(projectId)}/versions`, { cache: 'no-store' });
}

export interface CreateVersionResult {
  ok: true;
  version: VersionInfo;
  /** true = 这是仓库的第一个提交。 */
  firstCommit: boolean;
}

/**
 * `POST /api/projects/:id/versions`。
 *
 * `name` 必须是**非空字符串**（服务端 `normalizeName`）：空名 400 `name 不能为空`，
 * 超 60 字符 400 `name 最长 60 个字符`。界面把这两句原样显示，不自己编规则文案。
 */
export async function createVersion(projectId: string, name: string): Promise<CreateVersionResult> {
  return call<CreateVersionResult>(`/api/projects/${encodeURIComponent(projectId)}/versions`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export interface VersionDiffFile {
  path: string;
  status: 'added' | 'deleted' | 'modified';
  additions: number;
  deletions: number;
}

export interface VersionDiffResponse {
  ok: true;
  sha: string;
  files: VersionDiffFile[];
  /** 这个版本记录过、但现在磁盘上大小对不上的媒体。 */
  mediaChanged: string[];
  missingMedia: number;
}

/** `GET /api/projects/:id/versions/:sha/diff`：相对**父提交**的差异（不是两个任意版本对比）。 */
export async function diffVersion(projectId: string, sha: string): Promise<VersionDiffResponse> {
  return call<VersionDiffResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(sha)}/diff`,
    { cache: 'no-store' },
  );
}

export interface RestoreFilmResult {
  ok: true;
  sha: string;
  restored: string[];
  /** 恢复前的备份目录（相对工程根）。 */
  backup: string;
  mediaChanged: string[];
  missingMedia: number;
  /** 恢复后磁盘上 film.html 的 sha256（服务端现读现算）。 */
  filmSha: string;
}

/**
 * `POST /api/projects/:id/versions/:sha/restore-film`：**只**恢复 film.html。
 *
 * 不传 `restore` 的全量版本：任务书 §1.2.5 要的是「覆盖当前 film.html」，
 * 全量恢复会把 assets 等白名单文本也一起改回去，超出用户点的那一下。
 */
export async function restoreVersionFilm(projectId: string, sha: string): Promise<RestoreFilmResult> {
  return call<RestoreFilmResult>(
    `/api/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(sha)}/restore-film`,
    { method: 'POST', body: JSON.stringify({}) },
  );
}

/** `POST /api/motion/apply`：校验 + 规划成一批 props Op（**不写盘**）。 */
export async function planMotionApply(
  projectId: string,
  input: { clipId: string; entryId: string; params: Record<string, unknown> },
): Promise<MotionApplyPlan> {
  const response = await fetch('/api/motion/apply', {
    method: 'POST',
    cache: 'no-store',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, ...input }),
  });
  /** @type {any} */
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return {
    ok: body?.ok === true,
    code: typeof body?.code === 'string' ? body.code : response.ok ? undefined : `HTTP_${response.status}`,
    message: typeof body?.message === 'string' ? body.message : undefined,
    ops: Array.isArray(body?.ops) ? body.ops : [],
    values: body?.values,
    overrides: Array.isArray(body?.overrides) ? body.overrides : [],
    rootAt: typeof body?.rootAt === 'string' ? body.rootAt : undefined,
    scope: body?.scope === 'instance' || body?.scope === 'body' ? body.scope : undefined,
    scene: typeof body?.scene === 'string' ? body.scene : undefined,
    template: body?.template,
    issues: Array.isArray(body?.issues) ? body.issues : [],
  };
}
