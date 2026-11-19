/**
 * 渲染层用的最小类型：只描述 `GET /api/projects/:id/doc` 真正返回的字段。
 * 权威定义在 `contracts/film-doc.ts`（大脑所有）；这里不复制业务规则，只做边界标注。
 */

export interface Rational {
  num: number;
  den: number;
}

export interface ClipSize {
  w: number;
  h: number;
}

export interface OverrideEntry {
  at?: string;
  [key: string]: unknown;
}

export interface Clip {
  id: string;
  src: string;
  /** page / video / still / sound，由解析器按标签给出。 */
  kind?: string;
  sound?: boolean;
  at?: number;
  /** 源内区间 [in, out]（秒）。文件里写在 src 的 `#t=` 上。 */
  time?: number[];
  speed?: number;
  volume?: number;
  muted?: boolean;
  size?: ClipSize;
  /** film-core 解析 style 得到的声明框（`left/top/width/height/rotate`）；`r` 是角度。 */
  box?: { x?: number; y?: number; w?: number; h?: number; r?: number };
  style?: string;
  class?: string;
  overrides?: OverrideEntry[];
  link?: string;
  fade?: number[];
  attrs?: Record<string, string>;
}

export interface Track {
  index: number;
  role: string;
  name?: string;
  locked?: boolean;
  hidden?: boolean;
  muted?: boolean;
  clips: Clip[];
}

export interface FilmDoc {
  stage: ClipSize;
  fps: Rational;
  tracks: Track[];
}

export interface ProjectListItem {
  projectId: string;
  name: string;
  path: string;
  opened: boolean;
  label?: string;
}

/** `GET /api/projects` 的 `recent` 条目（M56）：跨会话的最近工程。 */
export interface RecentProjectItem {
  path: string;
  name: string;
  openedAt: string;
  cover?: string;
  /** film.html 不在了（目录被删/移动）。只标记，不自动移除。 */
  missing?: boolean;
}

export interface ProjectSummary {
  projectId: string;
  name?: string;
  path?: string;
  filmPath?: string;
  sourceHash?: string;
  trackCount?: number;
  clipCount?: number;
  durationSec?: number;
  stage?: ClipSize;
  fps?: Rational;
}

/** 素材状态（M26）：逐条 bare src 的探测结果。 */
export interface MediaStatusItem {
  /** 工程相对路径，已去掉 `#t=`。 */
  src: string;
  kind: 'video' | 'sound' | 'still';
  /** 引用这个文件的片段 id。 */
  clips: string[];
  status: 'ok' | 'missing' | 'unreadable';
  code?: string;
  message?: string;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  hasAudio?: boolean;
}

export interface MediaStatus {
  items: MediaStatusItem[];
  summary: { total: number; ok: number; missing: number; unreadable: number };
  scannedAt: string;
}

/** 转场（M25）：同轨两段重叠 + fade 的识别结果（字段见 film-core/transition.mjs）。 */
export interface TransitionView {
  presetId?: string;
  name?: string;
  id: string;
  trackIndex: number;
  start: number;
  end: number;
  duration: number;
  top: 'from' | 'to';
  doubleSided: boolean;
  crossfadeOk: boolean;
  fadeOnLower: boolean;
  fullFrame: boolean;
  headroom: { start: number; end: number };
  ramp: { clip: string; side: 'in' | 'out'; seconds: number };
  from: { id: string; src: string; kind?: string; at: number; sourceIn: number; sourceOut: number; end: number; length: number; fade: number[]; audioId: string | null };
  to: { id: string; src: string; kind?: string; at: number; sourceIn: number; sourceOut: number; end: number; length: number; fade: number[]; audioId: string | null };
}


/** 素材库条目（GET /api/projects/:id/assets）。 */
export interface AssetItem {
  name: string;
  path: string;
  bytes: number;
  mtime: string;
  kind: 'video' | 'sound' | 'still';
  /** 静帧没有时长：null（不是 4 秒默认值）。 */
  durationSec: number | null;
  width: number | null;
  height: number | null;
  /** 视频容器里有没有音轨（M35）：素材卡片标「含音频」、检查器提示分离。 */
  hasAudio?: boolean;
}

/** 字幕一条 cue（film-core/subtitle.mjs 的统一形状：秒、纯文本、保留换行）。 */
export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

export interface Envelope {
  projectId: string;
  batchId: string;
  owner: 'MAIN' | 'SUB1' | 'SUB2' | 'BRAIN';
  expectedHash: string;
  opId: string;
}

/** 契约 `contracts/edit-ops.ts` 的 Op 子集（本批 UI 只用这四种手势）。 */
export interface EditOp {
  op: string;
  [key: string]: unknown;
}

export interface EditOk {
  ok: true;
  hash: string;
  changed: boolean;
  touched?: string[];
  undoDepth?: number;
  replayed?: boolean;
}

export interface EditFail {
  ok: false;
  code: string;
  message: string;
  currentHash?: string;
}

export interface DocResponse {
  ok: true;
  doc: FilmDoc;
  hash: string;
  undoDepth?: number;
  redoDepth?: number;
}

export interface HealthResponse {
  ok: boolean;
  version?: string;
  pid?: number;
  studioVersion?: string;
  events?: { transport: string; contract: string; url: string };
  /** 影片内容 origin（Studio 启动时配了 contentPort 才有）。 */
  contentOrigin?: { origin: string; port: number } | null;
}

/**
 * 字幕样式的 16 个字段（M40）。字段含义与默认值见 `packages/layers/subtitle-style.mjs`
 * ——UI 不复制默认值，粗体那几项只是为了类型完整。
 */
export interface SubtitleStyleFields {
  fontFamily: string;
  assFontName: string;
  fontSizeRatio: number;
  color: string;
  outlineColor: string;
  outlineRatio: number;
  shadowColor: string;
  shadowRatio: number;
  background: string;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
  maxLines: number;
  bottomSafeRatio: number;
  fontScale: number;
  bold: boolean;
  cpsWarn: number;
  /** R30：六种样式预设的 id（`packages/layers/subtitle-presets.mjs`）。 */
  preset: 'default' | 'outline' | 'box' | 'large' | 'highlight' | 'bilingual';
  /** R30：双语第 2 行起的字号倍率（1 = 不分档）。 */
  secondaryScale: number;
}

/** `GET/PUT /api/projects/:id/subtitle-style` 的回包（`exists:false` = 还没有样式文件）。 */
export interface SubtitleStyleResponse {
  ok: true;
  exists: boolean;
  version: string;
  style: SubtitleStyleFields;
  updatedAt: string | null;
  sha256: string | null;
  /** 只有 PUT 有：内容与写盘前相同（补丁没改动任何字段）。 */
  changed?: boolean;
}

/**
 * 导出作业快照（GET /api/export/:id 的 job；字段与 export-job.mjs 的 snapshot 对齐）。
 *
 * 状态机（M29）：`queued → running → done | failed | cancelled`，没有别的迁移。
 */
export interface ExportJobView {
  id: string;
  projectId: string;
  clipId?: string;
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  stage: string;
  percent: number;
  frames: number;
  framesTotal: number;
  /**
   * M37：与 CLI `--progress jsonl` **同名同义**的进度字段。
   * 队列不再自己按文件大小猜阶段，这四个就是作业句柄发出的事件。
   */
  phase?: 'planning' | 'rendering' | 'muxing' | 'done' | null;
  frame?: number;
  totalFrames?: number;
  /** 失败/取消的错误码（运行时为 null）。 */
  code?: string | null;
  /** 最后一条进度事件（字段同 CLI 的 JSON 行）。 */
  progress?: Record<string, unknown> | null;
  /** 句柄事件流水（progress/cancel/done/error）。 */
  events?: Array<Record<string, unknown>>;
  /** 入队时占住的输出文件与锁（诊断 / 并发取证用）。 */
  targetPath?: string;
  lockPath?: string;
  /** 取消落在工作完成之后：产物完整。 */
  cancelTooLate?: boolean;
  outDir: string;
  /** 入队时的预设（历史里要记）。 */
  quality?: 'draft' | 'standard' | 'high';
  /** 视频编码（M50）：老作业没有这个字段 → undefined 按 h264 显示。 */
  codec?: 'h264' | 'hevc';
  /** 入出点（秒）；服务端存的是元组。 */
  range?: [number, number] | null;
  /** 多段区间（M39）：只有多段作业才有；单段/整片是 null。 */
  ranges?: Array<[number, number]> | null;
  /** 入队时的画面尺寸（历史里记「尺寸」）。 */
  stageSize?: { w: number; h: number } | null;
  /** 交付画幅与帧率（M42）：null = 跟随工程。 */
  size?: { w: number; h: number } | null;
  fit?: 'letterbox' | 'cover' | null;
  fps?: number;
  /** delivery 算出来的实际输出尺寸与缩放倍率（排障用）。 */
  outputSize?: { w: number; h: number } | null;
  deliveryScale?: { scale: number; footprint: { pixels: number; vs720p: number } } | null;
  /** 烧字幕（M41）：是否烧、字幕源与找到的伴生文件。 */
  subtitleBurn?: boolean;
  subtitleSrc?: string;
  subtitleFile?: string;
  /** 烧录摘要（ASS/VTT 的 sha、样式来源、条数、warnings）。 */
  subtitle?: {
    src?: string;
    file?: string;
    cues?: number;
    styleExists?: boolean;
    styleSha256?: string | null;
    assSha256?: string;
    vttSha256?: string;
    subbedSha256?: string;
    subbedBytes?: number;
    vttPath?: string;
    warnings?: string[];
    dropped?: number;
  } | null;
  /** 产物清单（M41）：不烧录只有 master 一条；烧录是 master → subbed → vtt。 */
  artifacts?: Array<{ kind: 'master' | 'subbed' | 'vtt' | string; path: string; bytes: number; sha256: string }>;
  output: {
    path: string;
    bytes: number;
    sha256: string;
    frames?: number;
    durationSec?: number;
    picture?: string | null;
    audio?: unknown;
  } | null;
  error: { code: string; message: string } | null;
  queuedAt?: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** 排队位置：1 = 下一个开工，0 = 不在排队。 */
  position?: number;
  cancelRequested?: boolean;
}

/**
 * 导出历史（M29）：**只存在浏览器侧**（localStorage），工程目录一个文件都不加。
 * 字段按任务书：开始/结束时间、预设、尺寸、帧数、耗时、产物路径、状态、错误码。
 */
export interface ExportHistoryItem {
  id: string;
  projectId: string;
  projectName: string;
  startedAt: string;
  finishedAt: string;
  quality: string;
  /** 视频编码（M50）：老历史没有这个字段（按 h264 显示）。 */
  codec?: string;
  /** `all` 或 `start-end`（秒）。 */
  range: string;
  frames: number;
  framesTotal: number;
  durationSec: number | null;
  /** 产物路径（失败/取消为 null）。 */
  path: string | null;
  bytes: number | null;
  /** 画面尺寸（`1280x720`），记不到就是空串。 */
  size: string;
  elapsedMs: number;
  state: 'done' | 'failed' | 'cancelled';
  errorCode: string | null;
  errorMessage: string | null;
}

/** 可加转场的硬切点（M28）：`detectCutPoints` 的输出，UI 只画按钮。 */
export interface CutPointView {
  id: string;
  trackIndex: number;
  /** 切点时间（= 后段 at = 前段结束）。 */
  at: number;
  /** 创建本身能吃下的最大重叠（秒，已扣掉两端各一帧）。 */
  room: number;
  /** 创建之后还能往左/往右拖多少（M25 口径，供提示与后续调长）。 */
  headroom: { start: number; end: number };
  canCreate: boolean;
  reason: string | null;
  audioFromId: string | null;
  audioToId: string | null;
  from: { id: string; kind?: string; at: number; end: number; length: number; sourceIn: number | null; sourceOut: number | null; sourceNative: number | null };
  to: { id: string; kind?: string; at: number; end: number; length: number; sourceIn: number | null; sourceOut: number | null; sourceNative: number | null; fade: number[] };
}

/** 动效模板管理视图（M30）：宿主自己的列表，带版本号/旧版本数/归档态。 */
export interface MotionManageEntry {
  id: string;
  name: string;
  kind: string;
  version: number;
  /** 旧版本个数（history.length - 1）。 */
  historyCount: number;
  archived: boolean;
  status: 'ready' | 'changed' | 'source-missing' | 'missing-asset' | 'archived';
  sourcePath: string;
  paramCount: number;
  sourceHash: string;
}

/* ── M66 只读图层 / 检查器（API-CONTRACT-R50.json v1）──────────────────────
 *
 * 这两个接口**只读**：不写 film.html、不进撤销栈。UI 侧只是消费者，
 * 字段与错误码一律以契约为准，不在前端另造同义结构。
 */

/** `GET /api/layers` 的一行。`id` 是稳定定位串（`#id` 或 `body > tag:nth-of-type(n)` 路径）。 */
export interface StageLayer {
  id: string;
  tag: string;
  box: { x: number; y: number; w: number; h: number };
  /** 仅当元素自有文本非空时出现（≤120 字）。 */
  text?: string;
  /** dom = 普通 DOM；canvas = 只能像素级处理；foreign = 跨源 iframe（不注入）。 */
  source: 'dom' | 'canvas' | 'foreign';
}

/**
 * `GET /api/layers` 的响应（契约 v2）。
 *
 * 不带 `clip` 时是 v1 语义（film.html 的 DOM，`scope` 缺省）；带 page 片段 id 时是
 * **页面域**：`layers[].id` 是页面文档里的裸定位串，另带 `scope`/`clipId`/`pageTime`/`frameStatus`。
 */
export interface StageLayersResponse {
  layers: StageLayer[];
  pageErrors: string[];
  scope?: 'page';
  clipId?: string;
  pageTime?: number;
  frameStatus?: 'OK' | 'NO_FILM' | 'THREW' | 'TIMEOUT' | 'NO_FRAME';
  /** R143/R146：页面实例 id（源码级的「这一份页面」）。读不到页面时缺省。 */
  instance?: { id: string };
  /** R143/R146：每层节点签名（`at → 8 位十六进制`）。写入时随 `envelope.target` 回传。 */
  fingerprints?: Record<string, string | null>;
}

/** `POST /api/elements/inspect` 的一个字段。 */
export interface InspectField {
  key: string;
  label: string;
  value: string | number;
  unit: string;
  editable: boolean;
}

export interface InspectGroup {
  id: string;
  fields: InspectField[];
}

export interface InspectResponse {
  groups: InspectGroup[];
  /** `clip` = film.html 的层（v1）；`page` = 页面片段内部元素（v2）。 */
  scope?: 'clip' | 'page';
  /** 原样回显请求的统一 id。 */
  elementId?: string;
  clipId?: string;
  pageTime?: number;
  frameStatus?: 'OK' | 'NO_FILM' | 'THREW' | 'TIMEOUT' | 'NO_FRAME';
}
