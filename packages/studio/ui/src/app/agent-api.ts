/**
 * Agent 面板的**新**接口（R114 · L3 / R114-B2）。
 *
 * 为什么不塞回 `api.ts`：那份是三个泳道共用的入口文件，本批只加「会话管理 + 名册 +
 * 带选择/会话引用的草稿」三件事，独立成文件可以把冲突面压到零；口径与 `api.ts` 的
 * `call()` 完全一致（同样的 `ApiError`、同样的 `ok:false` 判定）。
 *
 * R114-B2 的两处协议修正（答复件 ANSWER-SUB2-R114-DEPS §2 / §3）：
 *   - 会话 PATCH 的规范函数放进 `api.ts`（`patchAgentSession`），这里 re-export，
 *     不让同一个请求写两份；列表参数用 `?includeArchived=1`。
 *   - 草稿请求字段收成 `project/prompt/seed/session/agent/model/options`；
 *     `thinking` / `speed` 收进 `options`，`provider` 不再上送（由 model 反查）。
 */

import { ApiError, patchAgentSession } from './api';
import type { AgentSceneDraft, AgentSceneProviderInfo, AgentSessionRow } from './api';

export { patchAgentSession };

/** 一个维度上的可选项（思考强度 / 速度）。空数组 = 该模型不支持这个维度。 */
export interface AgentCapability {
  id: string;
  label: string;
}

export interface AgentRosterModel {
  id: string;
  label: string;
  default?: boolean;
  thinking: AgentCapability[];
  speed: AgentCapability[];
  /** 会不会产出图片/网页素材（draft 响应的 `provider.capabilities.images` 同源）。 */
  images?: boolean;
  note?: string;
}

export interface AgentRosterAgent {
  id: string;
  label: string;
  kind: string;
  /** 本机装没装（真探测结果）。 */
  available: boolean;
  /** 有没有接上场景生成。目前只有内置生成器是 `true`。 */
  wired: boolean;
  version?: string;
  note?: string;
}

export interface AgentRosterProvider {
  agentId?: string;
  id: string;
  label: string;
  mock: boolean;
  disabled: boolean;
  available: boolean;
  models: AgentRosterModel[];
  note: string;
}

/** 一次「Agent / provider / 模型 / 思考 / 速度」选择。 */
export interface AgentSelection {
  agent: string;
  provider: string;
  model: string | null;
  thinking: string | null;
  speed: string | null;
}

/**
 * R170（M21）：只读「真实 provider 可用性」。
 *
 * 名册回答「能选什么」，这一段回答「离真模型还差什么」：
 * `state` 最多到 `CONFIGURED_UNVERIFIED`；`realModelReady/Verified` 在没有**成功的
 * 真实调用**之前恒为 false。Key 只有 `{configured, tail}`，没有原文。
 */
export interface AgentProviderStatus {
  state: 'MOCK' | 'CONFIGURED_UNVERIFIED' | 'NOT_CONFIGURED' | 'DISABLED' | 'CONNECTED';
  provider: { id: string; label: string; mock: boolean; available: boolean };
  model: string | null;
  connection?: { agentId?: string; agentName?: string; auth: string; session: boolean; editVerified: boolean; adapterVersion: string | null; reason: string | null } | null;
  realModelReady: boolean;
  realModelVerified: boolean;
  /** 场景 provider 端点（`OPENCUT_AGENT_SCENE_URL`），只给 host。 */
  endpoint: { configured: boolean; host: string | null };
  /** OpenAI 兼容端点（`OPENCUT_MODEL_BASE_URL`，缺省 api.openai.com），只给 host。 */
  modelApi: { configured: boolean; host: string | null; model: string | null; wire: string | null };
  modelKey: { configured: boolean; tail: string | null; backend: string | null };
  agents: { detected: { id: string; label: string; version: string; kind: string }[]; wired: string[] };
  /** 接通真实模型还缺什么（给人看的下一步）。 */
  missing: string[];
}

export interface AgentRoster {
  ok: true;
  version: number;
  generatedAt: string;
  agents: AgentRosterAgent[];
  providers: AgentRosterProvider[];
  /** R170：可选（老服务端不发这一段时 UI 显示「状态未知」，不报错）。 */
  providerStatus?: AgentProviderStatus;
  dimensions: {
    thinking: boolean;
    speed: boolean;
    providerCount: number;
    modelCount: number;
  };
  defaults: AgentSelection;
  /**
   * R118（L5）：`@` 菜单的 Skill 候选（服务端只读目录，只报目录名）。
   *
   * `available:false` 有两种：`reason:'NOT_INSTALLED'` = 这台机器还没装过（空是正常的）；
   * 其它 errno = 读不动（面板要说清楚是读失败，不能装成「没有 Skill」）。
   * 字段可选：老 Studio 不发这一段时 UI 退回「不支持/没有」，不报错。
   */
  skills?: {
    available: boolean;
    reason: string;
    count: number;
    items: { id: string; label: string }[];
  };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
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
    const code = typeof body?.code === 'string' ? body.code : `HTTP_${String(response.status)}`;
    const message = typeof body?.message === 'string' ? body.message : `请求失败（${String(response.status)}）`;
    throw new ApiError(message, response.status, code, body ?? {});
  }
  return body as unknown as T;
}

/** `GET /api/agent/roster`：真实 provider + 真实 Agent 探测（服务端 60s 缓存）。 */
export async function fetchAgentRoster(signal?: AbortSignal, refresh = false): Promise<AgentRoster> {
  return request<AgentRoster>(refresh ? '/api/agent/roster?refresh=1' : '/api/agent/roster', { signal });
}

/** 一条**真实**的 ACP 工具权限请求（CS3）。mock provider 不会产生这种记录。 */
export interface AcpPermissionRow {
  id: string;
  sessionId: string;
  projectId: string;
  toolCallId: string;
  detail: string;
  kind: string;
  subject: { server: string | null; tool: string } | null;
  authzReason: string;
  options: { optionId: string; kind: string; name: string }[];
  requestedAt: string;
  expiresAt: string;
  remainingMs: number;
  state: string;
}

/** `GET /api/agent/acp?project=`：ACP 状态 + 这个工程待答复的权限卡。 */
export async function fetchAcpPermissions(projectId: string, signal?: AbortSignal): Promise<{
  ok: boolean;
  ready: boolean;
  failure: string | null;
  permissions: AcpPermissionRow[];
}> {
  return request(`/api/agent/acp?project=${encodeURIComponent(projectId)}`, { signal });
}

/** `POST /api/agent/permissions/:id`：允许本次 / 拒绝 / 取消。 */
export async function answerAcpPermission(
  permissionId: string,
  input: { projectId: string; sessionId: string; decision: 'allow' | 'deny' | 'cancel' },
): Promise<{ ok: boolean; permissionId: string; decision: 'allow' | 'deny'; state: string }> {
  return request(`/api/agent/permissions/${encodeURIComponent(permissionId)}`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** 会话列表（连归档一起要）。服务端参数是 `includeArchived=1`（答复件 §2.3）。 */
export async function listAgentSessionsWithArchived(projectId: string): Promise<{
  ok: true;
  version: number;
  last: string | null;
  sessions: AgentSessionRow[];
  total: number;
  hidden: number;
  archived: number;
}> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/agent/sessions?includeArchived=1`);
}

/** 草稿响应里多出来的「绑定证据」。老服务端不会有这些字段，所以都可选。 */
export interface AgentSceneBoundDraft extends AgentSceneDraft {
  selection?: AgentSelection;
  selectionApplied?: boolean;
  sessionId?: string | null;
  /** R122：这次请求里引用/附件的服务端视角（解析结果与摘要）。 */
  consumed?: {
    /* R135（M11 · A）：`bytes/sha256` 只在 asset/file 解析成功时有；`selector/clipId` 只在 element 上有。
       都是**追加**字段，老服务端不回就不出现（读数按「缺省 = 不知道」处理，不补 0）。 */
    refs: { kind: string; identity: string; label: string; ok: boolean; reason: string; sample: string; bytes?: number; sha256?: string; selector?: string; clipId?: string }[];
    attachments: { name: string; kind: string; bytes: number; sha256: string; available: boolean; reason?: string }[];
  } | null;
  /** R122：provider 自报「我收到了什么」（没有就是 null）。 */
  providerEcho?: { refs: { kind: string; identity: string; ok: boolean; sample: string }[]; attachments: { name: string; bytes: number; sha256: string; available: boolean; head: string }[] } | null;
  /** R122：这一趟的 runId（服务端回读）。 */
  runId?: string | null;
  /** 会话引用口径：`resumed:false` = 历史只读、未续接（B03 才做真续接）。 */
  context?: { sessionId: string | null; resumed: boolean };
  turn?: { id: string; sessionId: string; prompt: string; state: string | null; at: string } | null;
  sessionWarning?: string;
}

/** 从草稿回包里取 provider id：新服务端是对象，老服务端/apply 回包是字符串。 */
export function agentProviderIdOf(provider: AgentSceneDraft['provider'] | null | undefined): string {
  if (provider === null || provider === undefined) return '';
  if (typeof provider === 'string') return provider;
  return typeof provider.id === 'string' ? provider.id : '';
}

/** 从草稿回包里取能力表（老服务端没有 → null，UI 不说「支持」也不说「不支持」）。 */
export function agentCapabilitiesOf(provider: AgentSceneDraft['provider'] | null | undefined): AgentSceneProviderInfo['capabilities'] | null {
  if (provider === null || provider === undefined || typeof provider === 'string') return null;
  const caps = provider.capabilities;
  if (caps === null || typeof caps !== 'object') return null;
  return { thinking: caps.thinking === true, speed: caps.speed === true, images: caps.images === true };
}

/**
 * R122（M8-A）：服务端 run 取消。
 *
 * 返回 `{state, cancelled, idempotent}`。路由没落地时服务端回 404/405 ——
 * 调用方**必须**据 `implemented:false` 给诚实兜底（本地停接收、服务端未确认），
 * 不许把「前端 abort 了」说成「已取消」。R124 起路由已在产品树，成功路径文案是「已取消」。
 */
export async function cancelAgentRun(input: {
  runId: string;
  projectId: string;
  sessionId?: string;
  signal?: AbortSignal;
}): Promise<{ ok: true; runId: string; state: string; cancelled: boolean; idempotent: boolean } | { ok: false; implemented: false; status: number }> {
  const body: Record<string, unknown> = { project: input.projectId, pageId: PAGE_INSTANCE_ID };
  if (typeof input.sessionId === 'string' && input.sessionId !== '') body.session = input.sessionId;
  let response: Response;
  try {
    response = await fetch(`/api/agent/runs/${encodeURIComponent(input.runId)}/cancel`, {
      method: 'POST',
      cache: 'no-store',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch {
    /* 网络层失败（服务重启/断线）：同样不能宣称取消成功。 */
    return { ok: false, implemented: false, status: 0 };
  }
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  /* 404/405 = 这条路由还没接上（studio-server 的 patch 未落地）。 */
  if (response.status === 404 || response.status === 405) {
    return { ok: false, implemented: false, status: response.status };
  }
  if (!response.ok || payload === null || payload.ok === false) {
    const code = typeof payload?.code === 'string' ? payload.code : `HTTP_${String(response.status)}`;
    const message = typeof payload?.message === 'string' ? payload.message : `取消失败（${String(response.status)}）`;
    throw new ApiError(message, response.status, code, payload ?? {});
  }
  return {
    ok: true,
    runId: String(payload.runId ?? input.runId),
    state: String(payload.state ?? ''),
    cancelled: payload.cancelled === true,
    idempotent: payload.idempotent === true,
  };
}

/**
 * CS3（R30-126）：**这一次文档加载**的实例 id（重载就换一个）。
 *
 * 为什么需要它：面板的 `runSeq` 在 reload 后归零，第一句话又叫 `run-1`；
 * 服务端光看 runId 分不清「HTTP 重试」和「重载后的新一代」。
 * 这个 id 只回答一件事：这条取消/这一代 run 是不是同一个页面发的 ——
 * 旧页面的取消因此不会落到新页面的 run 上（服务端回 409 `RUN_STALE`）。
 * 它不是身份、不是权限，也不进凭据。
 */
const PAGE_INSTANCE_ID = (() => {
  try {
    const webCrypto = globalThis.crypto;
    if (webCrypto !== undefined && typeof webCrypto.randomUUID === 'function') return `pg-${webCrypto.randomUUID()}`;
  } catch {
    /* 老浏览器没有 randomUUID：走下面的时间戳兜底 */
  }
  return `pg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
})();

/**
 * `POST /api/agent/scene`，带 `AbortSignal` + 会话引用 + 模型选择 + run 身份 + 引用/附件。
 *
 * 为什么不用 `api.ts` 的 `draftAgentScene`：它没有 `signal`（取消要它），
 * 也不传 session/选择（会话引用与模型绑定要它）。契约仍是同一条路由。
 */
export async function draftAgentSceneBound(input: {
  projectId: string;
  prompt: string;
  sessionId?: string;
  selection?: AgentSelection | null;
  seed?: string;
  /** R122：这一趟 run 的身份（服务端登记台账、接受取消）；CS3 起带页面实例 id。 */
  run?: { runId: string; generation: number; pageId?: string } | null;
  /** R122：引用（服务端解析后才交给 provider）。字段名沿用面板里的 `kind/identity/label`。 */
  refs?: { kind: string; identity: string; label: string }[];
  /** R122：聊天附件（内容随请求走；不落盘、不上传、不插轨道）。 */
  attachments?: { name: string; kind: string; bytes: number; sha256?: string; data?: string }[];
  signal: AbortSignal;
}): Promise<AgentSceneBoundDraft> {
  const body: Record<string, unknown> = { project: input.projectId, prompt: input.prompt };
  if (input.seed !== undefined) body.seed = input.seed;
  if (typeof input.sessionId === 'string' && input.sessionId !== '') body.session = input.sessionId;
  if (input.run !== undefined && input.run !== null) body.run = { ...input.run, pageId: PAGE_INSTANCE_ID };
  if (Array.isArray(input.refs) && input.refs.length > 0) body.refs = input.refs;
  if (Array.isArray(input.attachments) && input.attachments.length > 0) body.attachments = input.attachments;
  const selection = input.selection ?? null;
  if (selection !== null) {
    body.agent = selection.agent;
    if (selection.model !== null) body.model = selection.model;
    /* 只有真的选了才上送：`null` 表示「该模型没这个维度」，服务端按默认/null 处理。 */
    const options: Record<string, string> = {};
    if (selection.thinking !== null) options.thinking = selection.thinking;
    if (selection.speed !== null) options.speed = selection.speed;
    if (Object.keys(options).length > 0) body.options = options;
  }
  return request<AgentSceneBoundDraft>('/api/agent/scene', {
    method: 'POST',
    body: JSON.stringify(body),
    signal: input.signal,
  });
}
