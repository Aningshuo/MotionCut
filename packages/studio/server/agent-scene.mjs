/**
 * Agent 原创场景最小闭环（M71-WP21）。
 *
 * ## 一条链
 *
 * ```
 * POST /api/agent/scene                    草稿（不写盘）
 * POST /api/agent/scene/:id/apply          走现有 ops 执行器写盘（幂等）
 * POST /api/agent/scene/:id/rollback       用 M62 版本快照恢复 film.html
 * ```
 *
 * 草稿 = `{provider, ops[], files[], summary, warnings[], seed}`，全程**只在内存里**；写盘只有
 * `apply` 一处，而且必须经过 `registry.applyOps`（现有唯一写入口：CAS + 历史 + 事件）。
 *
 * `files[]`（M93）：本地场景生成器产出的素材（柱子 PNG、动画页 html）。草稿阶段只校验
 * 路径与内容，**不落盘**；`apply` 时先写 `assets/`，再执行 ops；ops 失败就把这次写进去的
 * 文件删掉。回滚只恢复 film.html，**不删素材**——它们可能已被别的片段引用。
 *
 * ## 四道硬门槛
 *
 * 1. **ops 必须过现有校验**：先用 `applyOpsDetailed` 在内存里跑一遍，任何 `EditError`
 *    都算 provider 产出了坏草稿（502 `AGENT_FAILED`，reason 带 `VALIDATION`），不落盘。
 * 2. **未知字段拒绝**：每种 Op 的允许键写死在 `OP_FIELDS`，多一个键就 502
 *    `AGENT_FAILED` + `reason:"UNKNOWN_FIELD:<path>"`；请求体的未知字段是 400
 *    `UNKNOWN_FIELD`（客户端的错，不是 provider 的错）。
 * 3. **单次 ≤ 40 条**：超过就是 `TOO_MANY_OPS`，不截断、不静默丢。
 * 4. **只改 prompt 指定片段及其子元素**：`prompt` 里点名（`#clip-id` 或长度 ≥3 的裸 id）
 *    就把范围钉死在这些片段上；没点名则以 provider 声明的 targets 为范围。任何 Op 碰到
 *    范围外的片段 → 409 `OUT_OF_SCOPE`（`insert` 新引入的 id 自动进范围）。
 *
 * 生成失败（provider 抛错、空 ops、无范围、坏校验）一律 502 `AGENT_FAILED` 带原因，
 * **不许**返回空 ops 假装成功。
 *
 * ## 幂等与回滚
 *
 * - `apply` 的 opId 固定为 `agent-scene:<draftId>`：并发两次 apply 里第二次会命中
 *   工程 opLog 的重放缓存（`replayed:true`），磁盘只写一次。
 * - 第一次 apply 之前用 `createVersion()` 拍一张 M62 快照（工作树干净时用 HEAD，
 *   不制造空提交）；`rollback` = `restoreFilm(..., {force:true})` + 关/开工程让会话
 *   重新载入。没有快照（没 apply 过，或这台机器没有 git）→ 409 `NO_SNAPSHOT`。
 */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { EditError, applyOpsDetailed } from '../../film-core/ops.mjs';
import { createVersion, listVersions, restoreFilm, VersionsError } from './versions.mjs';
import { MOCK_PROVIDER_ID, providerFromEnv } from '../../agents/provider-mock.mjs';
import { modelEndpoint, readModelKey } from './model-key.mjs';
import { SESSION_ID_RE } from './agent-sessions.mjs';
import { AgentRunError, PAGE_ID_RE, RUN_ID_RE, createAgentRuns } from './agent-runs.mjs';

/** 单次草稿最多 40 条 Op。 */
export const MAX_SCENE_OPS = 40;
/** prompt 上限：够写一段描述，又不至于把 provider 撑爆。 */
export const MAX_PROMPT_CHARS = 2000;
/** 请求体允许的字段（多一个就是 400）。
 *  R114（L3）：加 `session`（会话引用）与 `agent` / `model` / `options`（模型选择**真的进请求**）。
 *  R114-B2：`provider` / `thinking` / `speed` 三个顶层字段**收回** —— 契约（答复件 §3.2）只认
 *  这七个；provider 由 `model` 反查（一个 model 只属于一个 provider），思考/速度收进
 *  `options`。字段名故意与 `AgentContext` 的键对齐（`session` = `conversationId`）。 */
export const SCENE_REQUEST_FIELDS = Object.freeze([
  'project',
  'prompt',
  'seed',
  'session',
  'agent',
  'model',
  'options',
  /* R122（M8-A · D08）：这一次生成的客户端 run 身份 `{runId, generation}`。
     服务端靠它登记台账、接受取消 —— 取消是服务端语义，不再是「前端 abort 一下」。 */
  'run',
  /* R122（M8-B · D07）：引用与聊天附件真的进请求。字段名沿用 UI 里的 `kind/identity/label`。 */
  'refs',
  'attachments',
]);

/** `options` 里允许的键（闭集）：多一个就是 400 `OPTION_UNSUPPORTED`。 */
export const SCENE_OPTION_FIELDS = Object.freeze(['thinking', 'speed']);
/** 思考强度的闭集（答复件 §3.2 的四个值）。 */
export const THINKING_OPTIONS = Object.freeze(['off', 'low', 'medium', 'high']);
/** 速度的闭集。 */
export const SPEED_OPTIONS = Object.freeze(['normal', 'fast']);

/* ── R114 · L3：真实 roster + 选择校验 ────────────────────────────────
 *
 * 原则：**只报真的**。
 *   - provider 就是本进程实际用的那一个（`providerFromEnv`），不列配置里没有的；
 *   - mock provider 只有一个模型 —— 内置确定性生成器；**不编造型号**；
 *   - 思考强度/速度：mock 的模型声明为空数组 = 不支持。请求里带了不支持的维度
 *     一律 400 `CAPABILITY_UNSUPPORTED`，**不静默忽略、也不偷偷退回默认值**；
 *   - Agent：内置本地生成器是唯一 wired 的一项；探测到的 CLI Agent 只作为
 *     「已安装但未接场景生成」出现（UI 置灰），选中它 → 400 `AGENT_NOT_WIRED`。
 */
export const BUILTIN_AGENT_ID = 'local-scene';
export const BUILTIN_MODEL_ID = 'builtin-scene-v1';

/**
 * Skill 目录（只读）：与设置里「Skills」那一格是**同一处**
 * （`settings-store.mjs` 白名单里的 `~/.opencut/skills`，由外部安装器维护）。
 *
 * 为什么挂在名册上而不是新开一条路由：`studio-server.mjs` 归 MAIN，本批不为一个
 * 只读清单加路由；而名册本来就是「这个 Agent 现在能用什么」的清单，`@` 菜单从
 * 同一个响应里取 Skill 名，面板只发一次请求。
 *
 * `OPENCUT_SKILLS_DIR` 只为验收准备（探针要证明「有 Skill 时真的列出来」）；
 * 正常安装不设它，就是上面那个目录。
 * @param {Record<string, string | undefined>} [env]
 */
export function skillsDirOf(env = process.env) {
  const custom = typeof env.OPENCUT_SKILLS_DIR === 'string' ? env.OPENCUT_SKILLS_DIR.trim() : '';
  return custom !== '' ? custom : path.join(os.homedir(), '.opencut', 'skills');
}

/**
 * 读 Skill 目录：**只报目录名**，不读内容、不执行、不写。
 *
 * 目录不存在 = 没装（`available:false` + `reason:'NOT_INSTALLED'`），不是错误 ——
 * 新装的机器本来就没有。真读不动（权限）就把 errno 说出来，不编一个空清单。
 * @param {string} dir
 * @returns {Promise<{ available: boolean, reason: string, skills: { id: string, label: string }[] }>}
 */
export async function listSkills(dir) {
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = String(/** @type {any} */ (error)?.code ?? 'READ_FAILED');
    return { available: false, reason: code === 'ENOENT' ? 'NOT_INSTALLED' : code, skills: [] };
  }
  const skills = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('.') !== true)
    .map((entry) => ({ id: entry.name, label: entry.name }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return { available: true, reason: '', skills };
}


/**
 * 把一个真实 provider 描述成 roster 里的一行。
 * @param {any} provider
 * @returns {{ id: string, agentId: string, label: string, mock: boolean, disabled: boolean, available: boolean, models: any[], note: string }}
 */
export function describeProvider(provider) {
  const id = typeof provider?.id === 'string' && provider.id !== '' ? provider.id : MOCK_PROVIDER_ID;
  const label = typeof provider?.label === 'string' && provider.label !== '' ? provider.label : id;
  const mock = provider?.mock === true;
  const disabled = provider?.disabled === true;
  /* CS2：provider 可以自己声明模型池（ACP 声明的是「Codex」）。声明了就按声明报，
     没声明才退回「provider 自己就是唯一模型」。 */
  const declared = !mock && Array.isArray(provider?.models)
    ? provider.models
        .filter((/** @type {any} */ row) => typeof row?.id === 'string' && row.id !== '')
        .map((/** @type {any} */ row) => ({
          id: row.id,
          label: typeof row.label === 'string' && row.label !== '' ? row.label : row.id,
          default: row.default === true,
          thinking: Array.isArray(row.thinking) ? row.thinking : [],
          speed: Array.isArray(row.speed) ? row.speed : [],
          images: row.images === true,
          note: typeof row.note === 'string' ? row.note : '',
        }))
    : [];
  const models = mock
    ? [
        {
          id: BUILTIN_MODEL_ID,
          label: '内置场景生成器（确定性）',
          default: true,
          /* 空数组 = 这个模型不支持该维度。UI 据此置灰，**不假装能选**。 */
          thinking: [],
          speed: [],
          /* 会产出 PNG / HTML 素材（M93）—— draft 响应的 capabilities.images 用它。 */
          images: true,
          note: '同一 prompt + seed 得到同一组 ops；不联网',
        },
      ]
    : declared.length > 0
      ? declared
      : [
          /* 外部 provider 没声明模型池时，**它自己**就是唯一可选的目标（id 即 model id）。
             这不是编造型号：`providerFromEnv` 配的就是一个端点，没有第二层模型概念；
             不这样处理会让所有自定义 provider 的请求都撞 MODEL_UNAVAILABLE。 */
          {
            id,
            label,
            default: true,
            thinking: [],
            speed: [],
            images: provider?.images === true,
            note: '该 provider 未声明模型池：模型 id 就是 provider id；思考/速度不支持',
          },
        ];
  return {
    id,
    label: mock ? '内置确定性生成器' : label,
    agentId: provider?.agentId ?? (id === 'acp-codex' ? 'codex' : BUILTIN_AGENT_ID),
    mock,
    disabled,
    available: disabled !== true,
    models,
    note: disabled
      ? '这个 provider 已关闭（OPENCUT_AGENT_PROVIDER）'
      : mock
        ? '本地确定性生成器，不调用远端模型'
        : declared.length ? '模型来自已连接的服务' : '服务端模型',
  };
}

/**
 * 只读的「真实 provider 可用性」状态（R170 · M21）。
 *
 * ## 为什么要有它
 *
 * SUB2 报的现象：GUI 上只看得见 `provider: mock` / `builtin-scene-v1`，看不出
 * 「这台机器上到底有没有装 Codex / 配没配 Key / 缺哪一步」。名册只回答「能选什么」，
 * 不回答「离真模型还差什么」——这里补的就是后者。
 *
 * ## 三条硬口径
 *
 * 1. **只读**：不读 key 原文、不写任何文件、不开关 provider。Key 只报
 *    `{configured, tail}`（`tail` 来自 `model-key.mjs#status()`，本来就是脱敏值）。
 * 2. **不吹**：`realModelReady` / `realModelVerified` 在没有**成功真实调用**之前恒为
 *    `false`；`state` 最多到 `CONFIGURED_UNVERIFIED`（配了但没验过）。
 * 3. **缺什么要具体**：`missing[]` 是给人看的下一步，不是「请配置」这种空话。
 *
 * @param {{
 *   provider: any,
 *   agents?: any[],
 *   env?: Record<string, string | undefined>,
 *   modelKey?: { configured?: boolean, tail?: string | null, backend?: string | null, issue?: string | null },
 *   acp?: any,
 *   wiredAgents?: string[],
 * }} input
 */
export function buildProviderStatus(input) {
  /* CS2：接了真 Codex 时，状态面不能再说「provider 还是 mock」——那是假话。
     State 只到 CONFIGURED_UNVERIFIED（UI 的文案表只有这几档），但 provider/model/
     agents.wired 都必须报真的。`realModelReady/Verified` 仍只在**真调用成功过**之后为 true。 */
  const acp = input.acp ?? null;
  const acpAvailable = acp !== null && acp.available === true;
  const agentId = acp?.agentId ?? 'codex';
  const agentName = acp?.agentName ?? 'Codex';
  const row = acpAvailable
    ? { id: 'acp-' + agentId, label: agentName + '（ACP 会话）', mock: false, available: true, models: acp.models ?? [] }
    : describeProvider(input.provider);
  const env = input.env ?? process.env;
  const sceneUrl = typeof env.OPENCUT_AGENT_SCENE_URL === 'string' ? env.OPENCUT_AGENT_SCENE_URL.trim() : '';
  const api = modelEndpoint(env);
  const apiConfigured = String(env.OPENCUT_MODEL_BASE_URL ?? '').trim() !== '';
  const key = input.modelKey ?? {};
  const keyConfigured = key.configured === true;
  const probed = Array.isArray(input.agents) ? input.agents : [];
  const detected = probed.filter((row) => row?.available === true);
  const codex = detected.find((row) => row?.id === 'codex') ?? null;
  const state = acpAvailable ? 'CONNECTED' : row.mock
    ? 'MOCK'
    : row.available !== true
      ? 'DISABLED'
      : acpAvailable || keyConfigured
        ? 'CONFIGURED_UNVERIFIED'
        : 'NOT_CONFIGURED';

  /** @type {string[]} */
  const missing = [];
  if (acpAvailable) {
    if (acp?.lastOk !== true) missing.push('ACP 会话可用，但本进程还没有一次成功的真实调用（成功一次后才置 realModelVerified）');
  } else if (row.mock) {
    missing.push('场景 provider 还是 mock：没配 OPENCUT_AGENT_SCENE_URL（或显式 OPENCUT_AGENT_PROVIDER=mock）');
  }
  if (!acpAvailable && !keyConfigured) {
    missing.push(
      key.issue === 'KEY_UNREADABLE'
        ? '模型 Key 存过但解不开（KEY_UNREADABLE）：本机 vault 主密钥或密文有问题'
        : '模型 Key 没配：设置 → 模型 Key 为空（本状态面只读，不会替你写）',
    );
  }
  if (!acpAvailable) {
    if (codex === null) {
      missing.push('本机没探测到 Codex CLI（PATH 里没有 codex，也没有常见安装位）');
    } else {
      missing.push(`Codex 连接不可用：${acp?.reason ?? '未建立会话'}`);
    }
  }
  if (apiConfigured && !acpAvailable) missing.push('OpenAI 兼容端点已配（OPENCUT_MODEL_BASE_URL），但场景 provider 不走它：两套端点没打通');
  if (acp?.lastOk !== true) missing.push('本版没有一次成功的真实模型调用记录：realModelVerified 恒为 false，直到真调用成功');

  return {
    state,
    provider: { id: row.id, label: row.label, mock: row.mock, available: row.available === true },
    model: row.models.find((/** @type {any} */ model) => model.default)?.id ?? row.models[0]?.id ?? null,
    connection: acp ? { agentId, agentName, auth: acp.auth, session: acp.session, adapterVersion: acp.adapterVersion, reason: acp.reason, editVerified: acp.editVerified === true } : null,
    /* 没有成功真实调用之前不许置 true —— 想改这两行，先拿出一次真调用证据。 */
    realModelReady: acpAvailable && acp?.lastOk === true,
    realModelVerified: acpAvailable && acp?.lastOk === true,
    endpoint: { configured: sceneUrl !== '', host: hostOf(sceneUrl) },
    modelApi: { configured: apiConfigured, host: hostOf(api.baseUrl), model: api.model, wire: api.wire },
    modelKey: { configured: keyConfigured, tail: typeof key.tail === 'string' ? key.tail : null, backend: typeof key.backend === 'string' ? key.backend : null },
    agents: {
      detected: detected.map((agent) => ({
        id: String(agent.id ?? ''),
        label: String(agent.label ?? agent.id ?? ''),
        version: typeof agent.version === 'string' ? agent.version : '',
        kind: typeof agent.kind === 'string' ? agent.kind : 'cli',
      })),
      wired: [...new Set([BUILTIN_AGENT_ID, ...(input.wiredAgents ?? (acpAvailable ? [agentId] : []))])],
    },
    missing,
  };
}

/**
 * `https://x/y` → `x`；解析不了就 null（不把整条 URL 抛给 UI）。
 * @param {string} url
 * @returns {string | null}
 */
function hostOf(url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return null;
  }
}

/**
 * 拼一份 roster：providers 来自真实 provider，agents 来自调用方给的真实探测结果，
 * skills 来自服务端真读到的目录（R118 · L5：`@` 菜单的 Skill 候选从这里取）。
 * @param {{ provider: any, providers?: any[], agents?: any[], wiredAgents?: string[], reasons?: Map<string,string>, skills?: { available: boolean, reason: string, skills: any[] }, env?: any, modelKey?: any, acp?: any, activeConnection?: any }} input
 */
export function buildSceneRoster(input) {
  const providerRow = describeProvider(input.provider);
  /* CS2（R30-125）：除内置 provider 外，还可以有一个 ACP provider（Codex）。
     它只在真探测到 CLI 时出现；没有就不列，不编造。 */
  const extraProviders = (Array.isArray(input.providers) ? input.providers : []).filter(Boolean).map(describeProvider);
  const wiredAgents = new Set([BUILTIN_AGENT_ID, ...(Array.isArray(input.wiredAgents) ? input.wiredAgents : [])]);
  const probed = Array.isArray(input.agents) ? input.agents : [];
  const skillBox = input.skills ?? { available: false, reason: 'NOT_INSTALLED', skills: [] };
  /** @type {any[]} */
  const agents = [
    {
      id: BUILTIN_AGENT_ID,
      label: '内置本地生成器',
      kind: 'builtin',
      available: true,
      wired: true,
      note: '随产品内置：确定性生成，不联网',
    },
    ...probed.map((row) => {
      const id = String(row?.id ?? '');
      const wired = wiredAgents.has(id) && row?.available === true;
      const reason = id === 'codex' ? input.acp?.reason : input.reasons?.get(id);
      return {
        id,
        label: String(row?.label ?? row?.id ?? ''),
        kind: String(row?.kind ?? 'cli'),
        available: row?.available === true,
        wired,
        reason: reason ?? null,
        version: typeof row?.version === 'string' ? row.version : '',
        note:
          wired
            ? '本机会话已连接，可提交剪辑提案'
            : row?.available === true
              ? (reason ? `连接组件：${reason}` : '已安装，当前没有可用的编辑适配器')
              : '未安装（本机找不到可执行文件）',
      };
    }),
  ].filter((row) => row.id !== '');
  const preferred = extraProviders.find((item) => item.available && item.models.length) ?? providerRow;
  const preferredModel = preferred.models.find((model) => model.default) ?? preferred.models[0];
  const models = [...providerRow.models, ...extraProviders.flatMap((row) => row.models)];
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    agents,
    /* R170：只读可用性状态。UI 的「真实模型」一行与详情面板都从这里取。 */
    providerStatus: buildProviderStatus({
      provider: input.provider,
      agents: probed,
      env: input.env,
      modelKey: input.modelKey,
      acp: input.activeConnection ?? input.acp, wiredAgents: input.wiredAgents,
    }),
    providers: [providerRow, ...extraProviders],
    /** 是否存在任何模型声明了该维度（UI 用它决定整块是「可选」还是「不支持」）。 */
    dimensions: {
      thinking: models.some((model) => Array.isArray(model.thinking) && model.thinking.length > 0),
      speed: models.some((model) => Array.isArray(model.speed) && model.speed.length > 0),
      providerCount: 1 + extraProviders.length,
      modelCount: models.length,
    },
    defaults: {
      agent: preferred.agentId,
      provider: preferred.id,
      model: preferredModel?.id ?? null,
      thinking: preferredModel?.thinking?.[0]?.id ?? null,
      speed: preferredModel?.speed?.[0]?.id ?? null,
    },
    /* R118 · L5：`@` 菜单的 Skill 候选。**只报目录名**（不读内容、不执行）；
       路径不出现在响应里 —— 面板要的是「能引用什么」，不是这台机器的目录结构。 */
    skills: {
      available: skillBox.available === true,
      reason: typeof skillBox.reason === 'string' ? skillBox.reason : '',
      count: Array.isArray(skillBox.skills) ? skillBox.skills.length : 0,
      items: Array.isArray(skillBox.skills)
        ? skillBox.skills
            .filter((row) => typeof row?.id === 'string' && row.id !== '')
            .map((row) => ({ id: row.id, label: typeof row.label === 'string' && row.label !== '' ? row.label : row.id }))
        : [],
    },
  };
}

/**
 * 校验一次请求里的选择。**不静默纠正**：给了不存在的模型 / 不支持的选项就 400。
 *
 * R114-B2 的两条硬口径（答复件 §3.2）：
 *   - `provider` 不是请求字段：用 `model` **反查**（一个 model 只属于一个 provider）；
 *     查不到就是 `MODEL_UNAVAILABLE`，**禁止静默降级到 mock**；
 *   - `options` 只收 `{thinking?, speed?}`，值不在闭集或该模型没声明 → `OPTION_UNSUPPORTED`。
 *
 * @param {any} input
 * @param {ReturnType<typeof buildSceneRoster>} roster
 */
export function pickSelection(input, roster) {
  const requestedModel = typeof input?.model === 'string' ? input.model : '';
  const requestedAgent = typeof input?.agent === 'string' ? input.agent : '';
  const agentId = requestedAgent || roster.providers.find((provider) => provider.models.some((model) => model.id === requestedModel))?.agentId || roster.defaults.agent;
  const agentRow = roster.agents.find((row) => row.id === agentId);
  if (agentRow === undefined) {
    throw new SceneError('AGENT_UNSUPPORTED', `没有这个 Agent：${agentId}`, 400, {
      allowed: roster.agents.filter((row) => row.wired === true).map((row) => row.id),
    });
  }
  if (agentRow.wired !== true) {
    throw new SceneError('AGENT_NOT_WIRED', `智能体 ${agentId} 尚未连接`, 400, {
      reason: 'NOT_WIRED',
      allowed: roster.agents.filter((row) => row.wired === true).map((row) => row.id),
    });
  }

  /* model → provider 反查。请求里没有 provider 字段，避免「provider=A、model 属于 B」的歧义。 */
  const allModels = roster.providers.flatMap((provider) => provider.models.map((model) => ({ provider, model })));
  const agentProvider = roster.providers.find((provider) => provider.agentId === agentId);
  const alias = agentId === 'codex' && requestedModel === 'codex';
  const modelId = requestedModel && !alias ? requestedModel : agentProvider?.models.find((model) => model.default)?.id ?? agentProvider?.models[0]?.id ?? null;
  const hit = modelId === null ? null : (allModels.find((row) => row.model.id === modelId && row.provider.agentId === agentId) ?? null);
  if (hit === null) {
    throw new SceneError('MODEL_UNAVAILABLE', `没有可用模型：${String(modelId)}`, 400, {
      model: modelId,
      allowed: allModels.map((row) => row.model.id),
    });
  }
  const providerRow = hit.provider;
  const modelRow = hit.model;
  if (providerRow.available !== true) {
    throw new SceneError('PROVIDER_UNAVAILABLE', `provider ${providerRow.id} 当前不可用`, 400, { reason: 'DISABLED' });
  }

  /* options：对象、键闭集、值闭集、且该模型真的声明了这个值。 */
  const rawOptions = input?.options;
  if (rawOptions !== undefined && (rawOptions === null || typeof rawOptions !== 'object' || Array.isArray(rawOptions))) {
    throw new SceneError('OPTION_UNSUPPORTED', 'options 必须是对象：{ thinking?, speed? }', 400, {
      allowed: SCENE_OPTION_FIELDS,
    });
  }
  /** @type {Record<string, any>} */
  const options = rawOptions ?? {};
  const unknownOption = Object.keys(options).find((key) => SCENE_OPTION_FIELDS.includes(key) !== true);
  if (unknownOption !== undefined) {
    throw new SceneError('OPTION_UNSUPPORTED', `options 不认识 ${unknownOption}（只接受 thinking / speed）`, 400, {
      option: unknownOption,
      allowed: SCENE_OPTION_FIELDS,
    });
  }
  /**
   * @param {'thinking'|'speed'} dimension
   * @returns {string|null}
   */
  const capability = (dimension) => {
    const supported = Array.isArray(modelRow?.[dimension]) ? modelRow[dimension] : [];
    const raw = options[dimension];
    if (raw === undefined || raw === null || raw === '') {
      return supported.length > 0 ? (supported[0].id ?? null) : null;
    }
    if (typeof raw !== 'string') {
      throw new SceneError('OPTION_UNSUPPORTED', `${dimension} 必须是字符串`, 400, { dimension, value: raw });
    }
    if (supported.some((row) => row.id === raw) !== true) {
      throw new SceneError('OPTION_UNSUPPORTED', `当前模型不支持 ${dimension}=${raw}`, 400, {
        dimension,
        value: raw,
        allowed: supported.map((row) => row.id),
        supported: false,
      });
    }
    return raw;
  };
  const thinking = capability('thinking');
  const speed = capability('speed');
  return {
    agent: agentId,
    provider: providerRow.id,
    model: modelRow.id,
    thinking,
    speed,
    /** 这个模型的三项能力（draft 响应的 `provider.capabilities` 用同一份）。 */
    capabilities: {
      thinking: Array.isArray(modelRow.thinking) && modelRow.thinking.length > 0,
      speed: Array.isArray(modelRow.speed) && modelRow.speed.length > 0,
      /* 内置生成器会产出 PNG/HTML 素材；外部 provider 没声明就当不支持（不替它吹）。 */
      images: modelRow.images === true,
    },
  };
}

/**
 * 每种 Op 的允许键。**故意写死**：provider 多塞一个字段就拒绝，而不是「忽略多余字段」。
 * @type {Map<string, readonly string[]>}
 */
const OP_FIELDS = new Map([
  ['set', ['op', 'clip', 'field', 'value']],
  ['move', ['op', 'clip', 'at', 'track']],
  ['insert', ['op', 'clip', 'at', 'track']],
  ['remove', ['op', 'clip']],
  ['split', ['op', 'clip', 'at', 'rightId', 'left', 'right']],
  ['props', ['op', 'edits']],
  ['stage', ['op', 'w', 'h']],
  ['fields', ['op', 'clip', 'fields']],
  ['track', ['op', 'track', 'field', 'value']],
  ['reorder', ['op', 'from', 'to']],
  ['overrides', ['op', 'clip', 'entries']],
]);

/** `insert` 里片段对象的允许键。`kind` 是 M93 加的：生成的动画页是 `.html`，
 *  `film-core` 的 `clipKindOf` 只按扩展名推不出 `page`（html 不在映射表里），
 *  必须由 provider 显式声明，否则会被当成 `video` 塞进画面轨、预览一片黑。 */
const INSERT_CLIP_FIELDS = Object.freeze([
  'id',
  'src',
  'kind',
  'at',
  'time',
  'size',
  'box',
  'volume',
  'speed',
  'overrides',
  'text',
]);

/** 生成器产出的素材只允许落在这一个相对目录下（M93）。 */
const ALLOWED_ASSET_PREFIX = 'assets/';
/** 一次草稿的素材总预算（M93）：柱子 PNG 是几十字节，动画页几十 KB；32MB 足够挡住胡来。 */
export const MAX_ASSET_BYTES = 32 * 1024 * 1024;

/** 错误：带 HTTP 状态与错误码，路由层直接映射。 */
export class SceneError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} status
   * @param {Record<string, any>} [detail]
   */
  constructor(code, message, status, detail = {}) {
    super(message);
    this.name = 'SceneError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/**
 * 校验一条 provider 要落盘的素材。返回第一条问题描述或 null。
 *
 * 只允许 `assets/` 下的**相对**路径：`..`、绝对路径、盘符一律拒绝——
 * provider 是外部输入，不能让它决定往哪儿写。
 *
 * @param {any} file
 * @param {number} index
 * @returns {string|null}
 */
function assetFileProblem(file, index) {
  const at = `files[${String(index)}]`;
  if (file === null || typeof file !== 'object') return at;
  const filePath = file.path;
  if (typeof filePath !== 'string' || filePath === '') return `${at}.path`;
  if (path.isAbsolute(filePath)) return `${at}.path-is-absolute`;
  if (filePath.split('/').includes('..')) return `${at}.path-has-parent`;
  if (!filePath.startsWith(ALLOWED_ASSET_PREFIX)) return `${at}.path-not-in-assets`;
  const hasBytes = Buffer.isBuffer(file.data) || file.data instanceof Uint8Array;
  const hasText = typeof file.text === 'string';
  if (!hasBytes && !hasText) return `${at}.content`;
  return null;
}

/**
 * 把素材写进工程。**只在 apply 里调用**（draft 一定不碰磁盘）。
 *
 * @param {string} dir 工程根目录
 * @param {Array<{ path: string, data?: Buffer|Uint8Array, text?: string }>} files
 * @returns {Promise<Array<{ path: string, bytes: number }>>}
 */
async function writeSceneAssets(dir, files) {
  const written = [];
  for (const file of files) {
    const target = path.join(dir, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const payload = file.data !== undefined ? file.data : String(file.text ?? '');
    await fs.writeFile(target, payload);
    const stat = await fs.stat(target);
    written.push({ path: file.path, bytes: stat.size });
  }
  return written;
}

/**
 * 写盘失败时把**这次刚写进去的**文件删掉（尽力而为）。不删目录、不碰别的文件。
 * @param {string} dir
 * @param {Array<{ path: string }>} written
 */
async function removeSceneAssets(dir, written) {
  for (const file of written) {
    await fs.rm(path.join(dir, file.path), { force: true }).catch(() => undefined);
  }
}

/** @param {any} value */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {string} text */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从 prompt 里找出被点名的片段 id。
 *
 * 两种写法：`#clip-id`（推荐，无歧义）与长度 ≥3 的裸 id（`page-main` 这种）。
 * 单字母 id（夹具里常见的 `a`/`b`）不做裸匹配——否则中文文案里的「a」会把范围带歪。
 *
 * @param {string} prompt
 * @param {any} doc
 * @returns {string[]}
 */
export function mentionedClipIds(prompt, doc) {
  /** @type {string[]} */
  const all = [];
  for (const track of doc?.tracks ?? []) {
    for (const clip of track?.clips ?? []) {
      if (typeof clip?.id === 'string' && clip.id !== '') all.push(clip.id);
    }
  }
  const text = String(prompt ?? '');
  /** @type {Set<string>} */
  const found = new Set();
  for (const match of text.matchAll(/#([A-Za-z][\w-]*)/g)) {
    const id = match[1];
    if (id !== undefined && all.includes(id)) found.add(id);
  }
  for (const id of all) {
    if (id.length < 3) continue;
    const pattern = new RegExp(`(^|[^\\w-])${escapeRegExp(id)}([^\\w-]|$)`);
    if (pattern.test(text)) found.add(id);
  }
  return [...found];
}

/**
 * 严格检查一条 Op 的键集合；返回第一条越界路径或 null。
 * @param {any} op
 * @param {number} index
 * @returns {string|null}
 */
function unknownFieldOf(op, index) {
  if (!isPlainObject(op)) return `ops[${String(index)}]`;
  const allowed = OP_FIELDS.get(String(op.op));
  if (allowed === undefined) return `ops[${String(index)}].op`;
  for (const key of Object.keys(op)) {
    if (!allowed.includes(key)) return `ops[${String(index)}].${key}`;
  }
  if (op.op === 'insert' && isPlainObject(op.clip)) {
    for (const key of Object.keys(op.clip)) {
      if (!INSERT_CLIP_FIELDS.includes(key)) return `ops[${String(index)}].clip.${key}`;
    }
  }
  if (op.op === 'props' && Array.isArray(op.edits)) {
    for (const [editIndex, edit] of op.edits.entries()) {
      if (!isPlainObject(edit)) return `ops[${String(index)}].edits[${String(editIndex)}]`;
      for (const key of Object.keys(edit)) {
        if (!['clip', 'prop', 'value'].includes(key)) {
          return `ops[${String(index)}].edits[${String(editIndex)}].${key}`;
        }
      }
    }
  }
  return null;
}

/**
 * 一条 Op 引用到的片段 id（`insert` 的新 id 也算：调用方按顺序把它加进允许集合）。
 * @param {any} op
 * @returns {string[]}
 */
function referencedClipIds(op) {
  /** @type {string[]} */
  const ids = [];
  if (typeof op?.clip === 'string') ids.push(op.clip);
  else if (isPlainObject(op?.clip) && typeof op.clip.id === 'string') ids.push(op.clip.id);
  if (Array.isArray(op?.edits)) {
    for (const edit of op.edits) {
      if (typeof edit?.clip === 'string') ids.push(edit.clip);
    }
  }
  return ids;
}

/**
 * 草稿的完整校验：条数 → 未知字段 → 范围 → 现有 ops 校验。
 *
 * @param {any} doc
 * @param {any[]} ops
 * @param {{allowed: Set<string>, scope: string[]}} input
 */
function validateDraftOps(doc, ops, input) {
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new SceneError('AGENT_FAILED', 'provider 返回了空 ops', 502, { reason: 'EMPTY_OPS' });
  }
  if (ops.length > MAX_SCENE_OPS) {
    throw new SceneError('AGENT_FAILED', `一次最多 ${String(MAX_SCENE_OPS)} 条 Op，收到 ${String(ops.length)} 条`, 502, {
      reason: 'TOO_MANY_OPS',
      count: ops.length,
      max: MAX_SCENE_OPS,
    });
  }
  for (const [index, op] of ops.entries()) {
    const bad = unknownFieldOf(op, index);
    if (bad !== null) {
      throw new SceneError('AGENT_FAILED', `生成的 Op 含未知字段：${bad}`, 502, {
        reason: `UNKNOWN_FIELD:${bad}`,
        field: bad,
      });
    }
  }

  /** @type {Set<string>} */
  const allowed = new Set(input.allowed);
  for (const [index, op] of ops.entries()) {
    if (op.op === 'insert') {
      const introduced = isPlainObject(op.clip) && typeof op.clip.id === 'string' ? op.clip.id : '';
      const outside = referencedClipIds(op).filter((id) => !allowed.has(id) && id !== introduced);
      if (outside.length > 0) {
        throw new SceneError('OUT_OF_SCOPE', `Op ${String(index)} 超出 prompt 指定的片段范围`, 409, {
          clip: outside[0],
          allowed: [...allowed],
        });
      }
      if (introduced !== '') allowed.add(introduced);
      continue;
    }
    const outside = referencedClipIds(op).filter((id) => !allowed.has(id));
    if (outside.length > 0) {
      throw new SceneError('OUT_OF_SCOPE', `Op ${String(index)} 超出 prompt 指定的片段范围`, 409, {
        clip: outside[0],
        allowed: [...allowed],
      });
    }
  }

  try {
    applyOpsDetailed(doc, ops);
  } catch (error) {
    if (error instanceof EditError) {
      throw new SceneError('AGENT_FAILED', `生成的 Op 没通过现有校验：${error.message}`, 502, {
        reason: `VALIDATION:${error.code}`,
        detail: error.message,
      });
    }
    throw error;
  }
}

/* ── R122 · M8-A：run 身份 / 取消 ─────────────────────────────────────
 *
 * 请求里的 `run` 是**客户端**发起的这一趟生成的身份：`{runId, generation}`。
 * 服务端只认它做两件事：登记台账（谁在跑）、接受取消（停哪一趟）。
 * 形状不对一律 400 `RUN_INVALID` —— 宁可让客户端改，也不猜。
 */

/** `run` 字段的合法形状说明（错误回包里原样带给客户端）。 */
export const RUN_FIELD_SHAPE = Object.freeze({ runId: 'string', generation: 'integer >= 0', pageId: 'string?（8–64 位，页面实例）' });

/**
 * CS3：`pageId` 是**这一次文档加载**的实例 id（重载就换）。它不参与权限，
 * 只回答一件事：这条取消/这次顶替是不是同一个页面发的。没带 = 旧客户端，
 * 按工程+会话判定（与 R122 行为一致）。
 *
 * @param {any} input
 * @returns {{ runId: string, generation: number, pageId: string | null } | null}
 */
export function pickRun(input) {
  const raw = input?.run;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SceneError('RUN_INVALID', 'run 必须是 {runId, generation, pageId?} 对象', 400, { allowed: RUN_FIELD_SHAPE });
  }
  const runId = typeof raw.runId === 'string' ? raw.runId : '';
  if (!RUN_ID_RE.test(runId)) {
    throw new SceneError('RUN_INVALID', `run.runId 不合法：${runId === '' ? '(空)' : runId}`, 400, { allowed: RUN_FIELD_SHAPE });
  }
  const generation = raw.generation === undefined ? 0 : raw.generation;
  if (!Number.isInteger(generation) || Number(generation) < 0) {
    throw new SceneError('RUN_INVALID', 'run.generation 必须是 >= 0 的整数', 400, { allowed: RUN_FIELD_SHAPE });
  }
  const pageId = raw.pageId === undefined || raw.pageId === null ? '' : raw.pageId;
  if (typeof pageId !== 'string' || (pageId !== '' && PAGE_ID_RE.test(pageId) !== true)) {
    throw new SceneError('RUN_INVALID', 'run.pageId 形状不对（8–64 位，字母数字/._:-）', 400, { allowed: RUN_FIELD_SHAPE });
  }
  return { runId, generation: Number(generation), pageId: pageId === '' ? null : pageId };
}

/* ── R122 · M8-B：引用与聊天附件（D07）────────────────────────────────
 *
 * 上一批（R118）的 `@` 只画了 pill，请求里没有；这一批让它们**真的到消费者手上**：
 *   - `refs` 由服务端**解析**（片段在 doc 里、元素文本从页面源码里读、素材/文件从
 *     工程目录读、Skill 从名册里查），解析结果再交给 provider；
 *   - `attachments` 带内容（base64，客户端读的文件字节）：服务端校验长度与摘要，
 *     provider 拿到 `data` + `head`（前 120 字节）。
 *
 * 两条边界不变：**引用不是导入**（不写 assets/、不插轨道），**附件不是上传**
 * （不落盘，只在这次请求里活着）。移除之后下一次请求里就没有它 —— 这是「受控引用」。
 */

/** 一条请求最多带几条引用。 */
export const MAX_REFS = 24;
/** 一条请求最多带几个附件。 */
export const MAX_ATTACHMENTS = 8;
/** 单个附件上限（客户端读不动的就别塞进来）。 */
export const MAX_ATTACHMENT_BYTES = 512 * 1024;
/** 全部附件合计上限。 */
export const MAX_ATTACHMENTS_TOTAL = 2 * 1024 * 1024;
/** 一条引用解析出来的「样本」上限：够证明读到了，不把整份文件搬进响应。 */
export const MAX_REF_SAMPLE = 160;

/** 引用类别（与服务端能解析的一致；不在这张表里的就是 400）。 */
export const REF_KINDS = Object.freeze(['project', 'session', 'element', 'clip', 'asset', 'file', 'skill']);

/**
 * @param {unknown} value
 * @param {number} max
 */
function shortString(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/**
 * 校验 `refs`：形状不对是**客户端的错**（400），不是「悄悄丢掉」。
 * @param {any} input
 * @returns {{ kind: string, identity: string, label: string }[]}
 */
export function pickRefs(input) {
  const raw = input?.refs;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new SceneError('REFS_INVALID', 'refs 必须是数组', 400);
  }
  if (raw.length > MAX_REFS) {
    throw new SceneError('REFS_INVALID', `refs 最多 ${String(MAX_REFS)} 条`, 400, { max: MAX_REFS });
  }
  /** @type {{ kind: string, identity: string, label: string }[]} */
  const out = [];
  const seen = new Set();
  for (const [index, item] of raw.entries()) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new SceneError('REFS_INVALID', `refs[${String(index)}] 必须是对象`, 400);
    }
    const kind = typeof item.kind === 'string' ? item.kind : '';
    if (!REF_KINDS.includes(kind)) {
      throw new SceneError('REFS_INVALID', `refs[${String(index)}].kind 不认识：${kind}`, 400, { allowed: [...REF_KINDS] });
    }
    const identity = typeof item.identity === 'string' ? item.identity.trim() : '';
    if (identity === '' || identity.length > 240) {
      throw new SceneError('REFS_INVALID', `refs[${String(index)}].identity 必须是非空字符串（≤240）`, 400);
    }
    const key = `${kind}:${identity}`;
    if (seen.has(key)) continue; // 同一条重复出现只算一次（UI 侧也是这么去重的）
    seen.add(key);
    out.push({ kind, identity, label: shortString(item.label, 120) });
  }
  return out;
}

/**
 * 校验 `attachments`：内容（base64）在请求里，服务端解出来核对字节数与摘要。
 *
 * `data` 缺失 = 只有元数据（大文件读不动时客户端会这么发）：这类附件**标注**
 * `available:false`，不假装模型看过它。
 * @param {any} input
 * @returns {{ name: string, kind: string, bytes: number, sha256: string, data: Buffer | null, head: string, available: boolean, reason: string }[]}
 */
export function pickAttachments(input) {
  const raw = input?.attachments;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new SceneError('ATTACHMENTS_INVALID', 'attachments 必须是数组', 400);
  }
  if (raw.length > MAX_ATTACHMENTS) {
    throw new SceneError('ATTACHMENTS_INVALID', `attachments 最多 ${String(MAX_ATTACHMENTS)} 个`, 400, { max: MAX_ATTACHMENTS });
  }
  /** @type {any[]} */
  const out = [];
  let total = 0;
  for (const [index, item] of raw.entries()) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new SceneError('ATTACHMENTS_INVALID', `attachments[${String(index)}] 必须是对象`, 400);
    }
    /* 名字只留最后一段：客户端不能借一个 `../` 决定任何路径（本批也不落盘）。 */
    const name = (String(item.name ?? '').split(/[/\\]/).pop() ?? '').slice(0, 200);
    if (name === '') {
      throw new SceneError('ATTACHMENTS_INVALID', `attachments[${String(index)}].name 不能为空`, 400);
    }
    const bytes = Number(item.bytes);
    if (!Number.isInteger(bytes) || bytes < 0) {
      throw new SceneError('ATTACHMENTS_INVALID', `attachments[${String(index)}].bytes 必须是非负整数`, 400);
    }
    const kind = shortString(item.kind, 80);
    const encoded = typeof item.data === 'string' ? item.data : '';
    if (encoded === '') {
      /* 没有内容：大文件客户端读不动就是这么发的。**不假装**模型看过它 ——
         过大的给出 `TOO_LARGE`，其余 `NO_CONTENT`。 */
      out.push({
        name,
        kind,
        bytes,
        sha256: '',
        data: null,
        head: '',
        available: false,
        reason: bytes > MAX_ATTACHMENT_BYTES ? 'TOO_LARGE' : 'NO_CONTENT',
      });
      continue;
    }
    if (bytes > MAX_ATTACHMENT_BYTES) {
      throw new SceneError('ATTACHMENTS_INVALID', `attachments[${String(index)}] 单个上限 ${String(MAX_ATTACHMENT_BYTES)} 字节`, 400, {
        max: MAX_ATTACHMENT_BYTES,
      });
    }
    /** @type {Buffer} */
    let data;
    try {
      data = Buffer.from(encoded, 'base64');
    } catch {
      throw new SceneError('ATTACHMENTS_INVALID', `attachments[${String(index)}].data 不是合法 base64`, 400);
    }
    if (data.length !== bytes) {
      throw new SceneError('ATTACHMENTS_INVALID', `attachments[${String(index)}] 字节数不符：声明 ${String(bytes)}，实际 ${String(data.length)}`, 400, {
        declared: bytes,
        actual: data.length,
      });
    }
    const sha256 = createHash('sha256').update(data).digest('hex');
    if (typeof item.sha256 === 'string' && item.sha256 !== '' && item.sha256 !== sha256) {
      throw new SceneError('ATTACHMENTS_INVALID', `attachments[${String(index)}] 摘要不符：声明的文件内容与 data 不是同一份`, 400, {
        declared: item.sha256,
        actual: sha256,
      });
    }
    total += data.length;
    if (total > MAX_ATTACHMENTS_TOTAL) {
      throw new SceneError('ATTACHMENTS_INVALID', `附件总量超上限：${String(total)} > ${String(MAX_ATTACHMENTS_TOTAL)}`, 400, {
        max: MAX_ATTACHMENTS_TOTAL,
      });
    }
    out.push({
      name,
      kind,
      bytes,
      sha256,
      data,
      head: data.subarray(0, 120).toString('utf8'),
      available: true,
      reason: '',
    });
  }
  return out;
}

/** @param {any} doc @param {string} clipId */
function clipById(doc, clipId) {
  for (const track of doc?.tracks ?? []) {
    for (const clip of track?.clips ?? []) {
      if (clip?.id === clipId) return clip;
    }
  }
  return null;
}

/**
 * 工程目录内的相对路径 → 绝对路径（越界一律 null）。
 * @param {string} dir
 * @param {string} rel
 */
function insideProject(dir, rel) {
  const clean = String(rel ?? '').replace(/^\/+/, '');
  if (clean === '' || clean.includes('\u0000') || /^[a-zA-Z]+:\/\//.test(clean)) return null;
  const abs = path.resolve(dir, clean);
  const base = path.resolve(dir);
  return abs === base || abs.startsWith(`${base}${path.sep}`) ? abs : null;
}

/**
 * 读工程内文件的前若干字节 + 摘要（**只读**，不改任何东西）。
 * @param {string} dir
 * @param {string} rel
 * @param {number} [maxBytes]
 */
async function readProjectFile(dir, rel, maxBytes = 256 * 1024) {
  const abs = insideProject(dir, rel);
  if (abs === null) return { ok: false, reason: 'OUTSIDE_PROJECT' };
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    return { ok: false, reason: 'NOT_FOUND' };
  }
  if (!stat.isFile()) return { ok: false, reason: 'NOT_A_FILE' };
  if (stat.size > maxBytes) {
    return { ok: true, bytes: stat.size, sha256: '', head: '', text: '', truncated: true };
  }
  try {
    const data = await fs.readFile(abs);
    return {
      ok: true,
      bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      /* `head` 是给响应看的样本；`text` 是**整份**内容（≤ maxBytes），
         解析页面元素要它 —— 拿 160 字节的 head 去找 `#tag` 会永远找不到（预演实测）。 */
      head: data.subarray(0, MAX_REF_SAMPLE).toString('utf8'),
      text: data.toString('utf8'),
      truncated: false,
    };
  } catch {
    return { ok: false, reason: 'UNREADABLE' };
  }
}

/**
 * 从页面源码里取某个元素的文本（够证明「这个元素真的在这份页面里」）。
 *
 * 只认 `#id` 与 `.class` 两种选择器（UI 的 elementKey 就是这两种）：
 * 找不到就返回 null —— 不模糊匹配、不拿父节点的字来充数。
 * @param {string} html
 * @param {string} selector
 */
export function elementTextOf(html, selector) {
  const source = String(html ?? '');
  const sel = String(selector ?? '').trim();
  if (source === '' || sel === '') return null;
  let pattern;
  if (sel.startsWith('#')) {
    const id = sel.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pattern = new RegExp(`<([a-zA-Z][a-zA-Z0-9-]*)\\b[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]{0,600}?)</\\1>`);
  } else if (sel.startsWith('.')) {
    const cls = sel.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pattern = new RegExp(`<([a-zA-Z][a-zA-Z0-9-]*)\\b[^>]*\\bclass=["'][^"']*\\b${cls}\\b[^"']*["'][^>]*>([\\s\\S]{0,600}?)</\\1>`);
  } else {
    return null;
  }
  const hit = pattern.exec(source);
  if (hit === null) return null;
  const text = String(hit[2] ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, MAX_REF_SAMPLE);
}

/**
 * 解析引用：**读真的东西**（doc / 页面源码 / 工程文件 / 名册），每一条给出
 * `{ok, reason}` 与一段 `sample`（就是「消费者能拿到什么」的凭据）。
 *
 * 解析失败不抛错：一条引用读不到，不该让整次生成失败 —— 但也不能装作读到了，
 * 所以 `ok:false` + `reason` 原样进响应。
 *
 * @param {{ dir: string, id: string }} project
 * @param {any} doc
 * @param {{ kind: string, identity: string, label: string }[]} refs
 * @param {{ rosterNow: any, sessionsStore: any }} context
 */
async function resolveRefs(project, doc, refs, context) {
  /** @type {any[]} */
  const out = [];
  for (const ref of refs) {
    const base = { kind: ref.kind, identity: ref.identity, label: ref.label };
    if (ref.kind === 'project') {
      /* 工程身份：registry 里叫 `id`，测试桩有时只给 `projectId` —— 两个都认，别为形状打架。 */
      const projectKey = String(/** @type {any} */ (project).id ?? /** @type {any} */ (project).projectId ?? '');
      const ok = projectKey !== '' && ref.identity === projectKey;
      out.push({ ...base, ok, reason: ok ? '' : 'PROJECT_MISMATCH', sample: ok ? projectKey : '' });
      continue;
    }
    if (ref.kind === 'session') {
      const store = context.sessionsStore;
      if (store === null || typeof store.get !== 'function') {
        out.push({ ...base, ok: false, reason: 'SESSIONS_UNAVAILABLE', sample: '' });
        continue;
      }
      const opened = await store.get(ref.identity);
      out.push({
        ...base,
        ok: opened?.ok === true,
        reason: opened?.ok === true ? '' : 'SESSION_NOT_FOUND',
        sample: opened?.ok === true ? shortString(opened.session?.title, MAX_REF_SAMPLE) : '',
      });
      continue;
    }
    if (ref.kind === 'clip') {
      const clip = clipById(doc, ref.identity);
      out.push({
        ...base,
        ok: clip !== null,
        reason: clip === null ? 'CLIP_NOT_FOUND' : '',
        sample: clip === null ? '' : `${String(clip.kind ?? '')} ${String(clip.src ?? '')} @${String(clip.at ?? 0)}s`,
      });
      continue;
    }
    if (ref.kind === 'element') {
      const at = ref.identity.indexOf('::');
      const clipId = at < 0 ? '' : ref.identity.slice(0, at);
      const selector = at < 0 ? ref.identity : ref.identity.slice(at + 2);
      const clip = clipId === '' ? null : clipById(doc, clipId);
      if (clip === null) {
        out.push({ ...base, ok: false, reason: 'CLIP_NOT_FOUND', sample: '' });
        continue;
      }
      const rel = (String(clip.src ?? '').split('#')[0] ?? '').replace(/^\.\//, '');
      if (!/\.x?html?$/i.test(rel)) {
        out.push({ ...base, ok: false, reason: 'NOT_A_PAGE_CLIP', sample: '' });
        continue;
      }
      const read = await readProjectFile(project.dir, rel);
      if (read.ok !== true) {
        out.push({ ...base, ok: false, reason: read.reason, sample: '' });
        continue;
      }
      const text = elementTextOf(String(read.text ?? ''), selector);
      out.push({
        ...base,
        ok: text !== null,
        reason: text === null ? 'ELEMENT_NOT_FOUND' : '',
        sample: text ?? '',
        selector,
        clipId,
      });
      continue;
    }
    if (ref.kind === 'skill') {
      /* Skill 只认名册里真读到的目录名（不执行、不读内容）—— 名册没有就是没装。 */
      const items = Array.isArray(context.rosterNow?.skills?.items) ? context.rosterNow.skills.items : [];
      const hit = items.find((/** @type {any} */ item) => item?.id === ref.identity);
      out.push({
        ...base,
        ok: hit !== undefined,
        reason: hit === undefined ? (context.rosterNow?.skills?.available === true ? 'SKILL_NOT_INSTALLED' : 'SKILLS_UNAVAILABLE') : '',
        sample: hit === undefined ? '' : String(hit.id),
      });
      continue;
    }
    /* asset / file：都是「工程目录里的一个相对路径」，区别只在 UI 从哪一栏列出来。 */
    const read = await readProjectFile(project.dir, ref.identity);
    out.push({
      ...base,
      ok: read.ok === true,
      reason: read.ok === true ? '' : read.reason,
      sample: read.ok === true ? shortString(read.head, MAX_REF_SAMPLE) : '',
      ...(read.ok === true ? { bytes: read.bytes, sha256: read.sha256 } : {}),
    });
  }
  return out;
}

/**
 * @param {{
 *   registry: any,
 *   provider?: any,
 *   acpProvider?: any,
 *   acpStatus?: (refresh?: boolean) => any,
 *   localClients?: ReturnType<typeof import('./agent-acp.mjs').createStudioAcpAgent>[],
 *   agents?: (refresh?: boolean) => Promise<any[]>,
 *   env?: Record<string, string | undefined>,
 *   modelKeyStatus?: () => Promise<{ configured?: boolean, tail?: string | null, backend?: string | null, issue?: string | null }>,
 *   logger?: (line: string) => void,
 *   maxDrafts?: number,
 *   maxRuns?: number,
 *   skillsDir?: string,
 *   applyApprovalTtlMs?: number,
 * }} options
 */
export function createAgentScene(options) {
  const registry = options.registry;
  const log = options.logger ?? (() => {});
  const provider = options.provider ?? providerFromEnv(process.env);
  /* CS2：可选的真实 ACP provider（Codex）。没接就保持单 provider 的老行为。 */
  const acpProvider = options.acpProvider ?? null;
  const localClients = options.localClients ?? [];
  const acpStatus = typeof options.acpStatus === 'function' ? options.acpStatus : () => null;
  const agentsProbe = typeof options.agents === 'function' ? options.agents : async () => [];
  const env = options.env ?? process.env;
  /* 只读 Key 状态（不读原文）：给 roster 的 providerStatus 用。失败就当「未配置」。 */
  const modelKeyStatus =
    typeof options.modelKeyStatus === 'function'
      ? options.modelKeyStatus
      : async () => ({ configured: false, tail: null, backend: null, issue: null });
  /* R118（L5）：Skill 目录只读清单。默认 ~/.opencut/skills；可注入（单测/验收）。 */
  const skillsDir = typeof options.skillsDir === 'string' && options.skillsDir !== '' ? options.skillsDir : skillsDirOf(process.env);
  /* B-SUB1-R31-054：设置里「我的模型 Key」要真的跟着请求走。
     只对支持 `setApiKeySource` 的 provider（HTTP 那条）注入；mock/disabled 不受影响。
     每次请求现读，改 key 立即生效，不用重启 Studio。 */
  if (typeof provider?.setApiKeySource === 'function') provider.setApiKeySource(readModelKey);
  const maxDrafts = Number.isInteger(options.maxDrafts) ? Number(options.maxDrafts) : 200;

  /* R122（M8-A）：run 台账。路由通过 `agentScene.runs` 拿到同一个实例 —— 不需要
     在 `studio-server.mjs` 里多建一份（patch 因此只有「解析路径 → 调用」四行）。 */
  const runs = createAgentRuns({ maxRuns: Number.isInteger(options.maxRuns) ? Number(options.maxRuns) : undefined });

  /** 真实 roster：provider 是本进程实配的，agents 是真实探测结果（探测失败就当没装）。 */
  async function roster(refresh = false, includeAcp = true) {
    let probed = [];
    try {
      probed = await agentsProbe(refresh);
    } catch {
      probed = [];
    }
    const skills = await listSkills(skillsDir);
    /** @type {{ configured: boolean, tail: string | null, backend: string | null, issue: string | null }} */
    let modelKey = { configured: false, tail: null, backend: null, issue: null };
    try {
      const read = await modelKeyStatus();
      modelKey = {
        configured: read?.configured === true,
        tail: typeof read?.tail === 'string' ? read.tail : null,
        backend: typeof read?.backend === 'string' ? read.backend : null,
        issue: typeof read?.issue === 'string' ? read.issue : null,
      };
    } catch {
      modelKey = { configured: false, tail: null, backend: null, issue: 'STATUS_UNREADABLE' };
    }
    /* ACP provider 只在**真探测到 codex** 时进名册：没装还列出来，就是「可选但一定会失败」。 */
    const codexDetected = probed.some((row) => row.id === 'codex' && row.available);
    const acp = includeAcp && codexDetected && acpProvider ? await acpStatus(refresh) : null;
    const acpReady = acp?.available === true && acpProvider.models?.length > 0;
    const providers = acpReady ? [acpProvider] : [];
    const wiredAgents = acpReady ? ['codex'] : [];
    let activeConnection = acpReady ? acp : null;
    const reasons = new Map();
    for (const client of localClients) {
      const id = client.provider.agentId;
      if (!includeAcp || !probed.some((row) => row.id === id && row.available)) continue;
      const status = await client.connection(refresh);
      if (status.available && client.provider.models.length) {
        providers.push(client.provider);
        wiredAgents.push(id);
        if (!activeConnection || (status.lastOk && (!activeConnection.lastOk || (status.lastAt ?? 0) > (activeConnection.lastAt ?? 0)))) {
          activeConnection = status;
        }
      } else if (status.reason) reasons.set(id, status.reason);
    }
    return buildSceneRoster({
      provider,
      providers, wiredAgents, reasons, activeConnection,
      agents: Array.isArray(probed) ? probed : [],
      skills,
      env,
      modelKey,
      acp,
    });
  }

  /** @type {Map<string, any>} */
  const drafts = new Map();

  /* ── 草稿应用批准（CS3 · MAIN-CS3-AUTHZ）─────────────────────────────
     草稿 apply 是**人工意图**，与 ACP 工具票是两条独立的授权链：
       - 这里签的批准票只对「这一个 draftId + 这一个工程 + 这一份基线 sha」有效，
         一次性、2 分钟过期；拿 ACP 的 grant 来 apply 一律不认（反过来也一样）。
       - 旧探针没带批准票 → 403 APPLY_APPROVAL_REQUIRED；已经应用过的草稿仍按
         幂等回 alreadyApplied（不写盘，不需要新票）。 */
  const applyApprovals = new Map();
  const applyApprovalTtlMs = Number.isFinite(options.applyApprovalTtlMs)
    ? Math.max(1_000, Number(options.applyApprovalTtlMs))
    : 2 * 60_000;

  /* ── 在途 run（R114-B2）──────────────────────────────────────────────
     会话归档要能判「这条会话正在跑」。服务端不认识前端的 run，但**认识自己手上
     这一次 draft 请求**：draft 进来时按 session 计数 +1，结束（成功/失败/取消）
     -1。同一会话并发两次也不会提前清零，所以用计数而不是布尔。 */
  /** @type {Map<string, number>} */
  const runningSessions = new Map();

  /** @param {string} sid */
  function beginSessionRun(sid) {
    runningSessions.set(sid, (runningSessions.get(sid) ?? 0) + 1);
  }

  /** @param {string} sid */
  function endSessionRun(sid) {
    const next = (runningSessions.get(sid) ?? 0) - 1;
    if (next <= 0) runningSessions.delete(sid);
    else runningSessions.set(sid, next);
  }

  /**
   * 这条会话有没有在途的 draft 请求（路由用它回 409 SESSION_RUNNING）。
   * @param {string} sid
   */
  function isSessionRunning(sid) {
    return (runningSessions.get(sid) ?? 0) > 0;
  }

  /** @param {string} projectId */
  function projectOrThrow(projectId) {
    const project = registry.get(projectId);
    if (project === null) {
      throw new SceneError('FILM_NOT_FOUND', `工程未打开：${projectId}`, 404);
    }
    return project;
  }

  /**
   * 拍「apply 之前」的快照。
   *
   * 工作树干净时 `createVersion` 会 409 `VERSIONS_NOTHING_TO_COMMIT`——那就用 HEAD
   * 作为快照（内容是一样的），不制造空提交。没有 git 就返回 null，apply 照样写，
   * 只是回滚会 409 `NO_SNAPSHOT`（这是真实的降级，不假装可回滚）。
   *
   * @param {any} project
   * @param {string} draftId
   * @returns {Promise<string|null>}
   */
  async function snapshotBefore(project, draftId) {
    try {
      const created = await createVersion(project.dir, { name: `ai-scene-before-${draftId.slice(0, 8)}` });
      return created.version.sha;
    } catch (error) {
      if (error instanceof VersionsError && error.code === 'VERSIONS_NOTHING_TO_COMMIT') {
        try {
          const listed = await listVersions(project.dir);
          const head = listed.versions?.[0]?.sha;
          return typeof head === 'string' && head !== '' ? head : null;
        } catch {
          return null;
        }
      }
      log(`AGENT_SCENE_SNAPSHOT_FAILED ${String(/** @type {any} */ (error)?.code ?? error)}`);
      return null;
    }
  }

  /**
   * 只生成草稿，**不写盘**。
   *
   * 外层只负责「在途 run」的记账：带 `session` 的请求在生成期间算 running，
   * 归档那条会话会被路由拒成 409。真正的实现是 `draftInner`。
   *
   * @param {{projectId: string, prompt: string, seed?: string|number, session?: string, sessions?: any, agent?: string, model?: string, options?: {thinking?: string, speed?: string}, run?: {runId: string, generation?: number}, refs?: any[], attachments?: any[]}} input
   */
  async function draft(input) {
    const sid = typeof input?.session === 'string' && input.session !== '' ? input.session : null;
    /* R122（M8-A）：先把这一趟 run 登记进台账，再开始干活 —— 取消只认登记过的 run。
       CS3（R30-126）：runId 可以在 reload 后被重用；台账按「实例」记，
       所以这里拿到的是**这一次**的行，后面 finish/bind 都认行不认 id。 */
    const run = pickRun(input);
    const refs = pickRefs(input);
    const attachments = pickAttachments(input);
    const projectId = typeof input?.projectId === 'string' ? input.projectId : '';
    /** @type {any} */
    let row = null;
    if (run !== null) {
      if (projectId.trim() === '') {
        throw new SceneError('BAD_REQUEST', 'project 必须是非空字符串', 400);
      }
      try {
        row = runs.register({
          runId: run.runId,
          projectId,
          sessionId: sid,
          generation: run.generation,
          pageId: run.pageId,
        });
      } catch (error) {
        /* 台账的错误码/状态码原样上桌（RUN_CONFLICT 409 之类），不折成 500。 */
        if (error instanceof AgentRunError) {
          throw new SceneError(error.code, error.message, error.status, error.detail);
        }
        throw error;
      }
    }
    const controller = row === null ? null : new AbortController();
    if (row !== null && controller !== null) runs.bindAbort(row, controller);
    if (sid !== null) beginSessionRun(sid);
    try {
      const out = await draftInner(input, {
        row,
        runId: run === null ? null : run.runId,
        signal: controller === null ? null : controller.signal,
        refs,
        attachments,
      });
      if (row !== null) runs.finish(row, 'done');
      return out;
    } catch (error) {
      const code = error instanceof SceneError ? error.code : '';
      const cancelled = code === 'RUN_CANCELLED';
      /* 断线（页面重载）与顶替都不许把这一行收成 failed：
         - detached 要留在 running 上，重载后的 Stop 才找得到它；
         - superseded 已经是终态，finish 本来也不会覆盖。 */
      const keepOpen = code === 'RUN_DETACHED' || code === 'RUN_SUPERSEDED';
      if (row !== null && !keepOpen) runs.finish(row, cancelled ? 'cancelled' : 'failed');
      throw error;
    } finally {
      if (row !== null) runs.unbindAbort(row);
      if (sid !== null) endSessionRun(sid);
    }
  }

  /**
   * @param {any} input
   * @param {{ row?: any, runId?: string | null, signal?: AbortSignal | null, refs?: any[], attachments?: any[] }} [context]
   */
  async function draftInner(input, context = {}) {
    const row = context.row ?? null;
    const runId = typeof context.runId === 'string' && context.runId !== '' ? context.runId : null;
    const signal = context.signal ?? null;
    const refs = Array.isArray(context.refs) ? context.refs : [];
    const attachments = Array.isArray(context.attachments) ? context.attachments : [];
    const projectId = typeof input?.projectId === 'string' ? input.projectId : '';
    if (projectId.trim() === '') {
      throw new SceneError('BAD_REQUEST', 'project 必须是非空字符串', 400);
    }
    const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : '';
    if (prompt === '') {
      throw new SceneError('BAD_REQUEST', 'prompt 必须是非空字符串', 400);
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new SceneError('BAD_REQUEST', `prompt 最长 ${String(MAX_PROMPT_CHARS)} 字`, 400, {
        max: MAX_PROMPT_CHARS,
      });
    }

    /* R114 · L3：选择真的进请求 —— 不在 roster 里的一律 400，**不静默换成默认值**。 */
    // Existing callers that omit an agent and model request the built-in scene generator.
    // Interactive callers send the explicit model chosen from the connected roster.
    const includeAcp = input.agent !== BUILTIN_AGENT_ID && input.model !== BUILTIN_MODEL_ID && Boolean(input.agent || input.model);
    const rosterNow = await roster(false, includeAcp);
    const selection = pickSelection(input, rosterNow);

    /* R114 · L3：续接的会话必须先存在；回合等草稿成功后再落盘（失败不留半条）。 */
    const sessionId = typeof input?.session === 'string' && input.session !== '' ? input.session : null;
    /** @type {any} */
    let sessionsStore = null;
    if (sessionId !== null) {
      if (SESSION_ID_RE.test(sessionId) !== true) {
        throw new SceneError('SESSION_ID_INVALID', `会话 id 不合法：${sessionId}`, 400);
      }
      sessionsStore = input?.sessions ?? null;
      if (sessionsStore === null || typeof sessionsStore.appendTurn !== 'function') {
        throw new SceneError('SESSIONS_UNAVAILABLE', '这个 Studio 没有会话存储，无法续接会话', 500);
      }
      const opened = await sessionsStore.get(sessionId);
      if (opened.ok !== true) {
        throw new SceneError('SESSION_NOT_FOUND', `没有这条会话：${sessionId}`, 404);
      }
    }
    const project = projectOrThrow(projectId);
    const doc = project.doc;
    if (doc === null || doc === undefined) {
      throw new SceneError('AGENT_FAILED', '工程没有可用的 FilmDoc 投影', 502, { reason: 'NO_DOC' });
    }

    const seed =
      typeof input?.seed === 'string' && input.seed !== ''
        ? input.seed
        : typeof input?.seed === 'number' && Number.isFinite(input.seed)
          ? String(input.seed)
          : randomUUID().slice(0, 12);

    /* R122（M8-B）：引用在**生成之前**解析 —— 消费者（provider）拿到的是解析结果，
       不是一串 UI 上的标签。解析失败不拦生成，但 `ok:false` 会原样回给客户端。 */
    const resolvedRefs = refs.length === 0 ? [] : await resolveRefs(project, doc, refs, { rosterNow, sessionsStore });
    /* 附件只把「这次请求里的内容」交给 provider：不落盘、不留存。 */
    const attachmentsForProvider = attachments.map((/** @type {any} */ file) => ({
      name: file.name,
      kind: file.kind,
      bytes: file.bytes,
      sha256: file.sha256,
      available: file.available,
      head: file.head,
      ...(file.data === null ? {} : { data: file.data }),
    }));

    /* 取消可能在生成前就到了（登记与取消挨得很近；探针就是这么打的）。 */
    if (row !== null && runs.isRowCancelled(row)) {
      log(`AGENT_RUN_CANCELLED run=${String(runId)} project=${projectId} session=${String(sessionId)} stage=before-generate`);
      throw new SceneError('RUN_CANCELLED', '这次生成已被取消（生成前）：草稿不提交、回合不记', 409, { runId });
    }

    const scope = mentionedClipIds(prompt, doc);
    /* CS2：按选中项挑引擎。ACP provider 拿到 projectId/projectDir/runId —— 它要按
       工程开真实会话、按 run 取票，而不是从 prompt 里猜。 */
    const engine = [provider, acpProvider, ...localClients.map((client) => client.provider)].find((candidate) => candidate?.id === selection.provider);
    if (!engine) throw new SceneError('PROVIDER_UNAVAILABLE', '选定的智能体已断开', 400);
    /** @type {any} */
    let generated;
    try {
      generated = await engine.generate({
        selection,
        doc,
        prompt,
        seed,
        scopeIds: scope,
        refs: resolvedRefs,
        attachments: attachmentsForProvider,
        projectId,
        projectDir: project.dir,
        ...(sessionId === null ? {} : { sessionId }),
        ...(runId === null ? {} : { runId }),
        ...(signal === null ? {} : { signal }),
      });
    } catch (error) {
      if (error instanceof SceneError) throw error;
      /* 取消导致的失败：不是 provider 的错，回 RUN_CANCELLED 而不是 502。 */
      if (row !== null && runs.isRowCancelled(row)) {
        log(`AGENT_RUN_CANCELLED run=${String(runId)} project=${projectId} session=${String(sessionId)} stage=provider-aborted`);
        throw new SceneError('RUN_CANCELLED', '这次生成已被取消：草稿不提交、回合不记', 409, { runId });
      }
      throw new SceneError('AGENT_FAILED', `provider 生成失败：${String(/** @type {any} */ (error)?.message ?? error)}`, 502, {
        reason: String(/** @type {any} */ (error)?.code ?? 'PROVIDER_ERROR'),
      });
    }

    /* 生成回来之后、**任何写操作之前**再判一次：
       - 自己这一行被取消 → 迟到结果整份丢掉（D08 缺的那一步）；
       - 自己这一行被新页面顶替 → 也丢（不许把旧页面的结果写进新 run 的账）；
       - 页面已经重载（detached）→ 也丢（没人能看见这份结果）。 */
    if (row !== null && runs.isRowCancelled(row)) {
      log(`AGENT_RUN_CANCELLED run=${String(runId)} project=${projectId} session=${String(sessionId)} stage=after-generate ops=${String(Array.isArray(generated?.ops) ? generated.ops.length : 0)}`);
      throw new SceneError('RUN_CANCELLED', '这次生成已被取消：迟到结果不提交（草稿不建、回合不记）', 409, { runId });
    }
    if (row !== null && !runs.isCurrent(row)) {
      log(`AGENT_RUN_SUPERSEDED run=${String(runId)} instance=${String(row?.instance)} project=${projectId} stage=after-generate`);
      throw new SceneError('RUN_SUPERSEDED', '这次 run 已被同一工程/会话的更新一代顶替：迟到结果不提交', 409, { runId });
    }
    if (row !== null && runs.isRowDetached(row)) {
      log(`AGENT_RUN_DETACHED run=${String(runId)} instance=${String(row?.instance)} project=${projectId} stage=after-generate`);
      throw new SceneError('RUN_DETACHED', '发起这一 run 的页面已经重载：结果不提交（可由 Stop 关掉它）', 409, { runId });
    }

    const ops = Array.isArray(generated?.ops) ? generated.ops : [];
    const files = Array.isArray(generated?.files) ? generated.files : [];
    const targets = Array.isArray(generated?.targets)
      ? generated.targets.filter((/** @type {any} */ id) => typeof id === 'string')
      : [];
    /* CS2：纯问答草稿（ACP provider 明确声明 textOnly、没有 ops/files）不要求范围 ——
       「这个问题不需要改工程」本身是合法结果。判据是：必须有一句人话，且**真的**没 ops。 */
    const textOnly =
      ops.length === 0 &&
      files.length === 0 &&
      engine.allowTextOnly === true &&
      typeof generated?.summary === 'string' &&
      generated.summary.trim() !== '';
    if (!textOnly && scope.length === 0 && targets.length === 0) {
      throw new SceneError('AGENT_FAILED', 'provider 没有声明任何目标片段，无法界定改动范围', 502, {
        reason: 'NO_SCOPE',
      });
    }
    const allowed = new Set(scope.length > 0 ? scope : targets);
    if (!textOnly) validateDraftOps(doc, ops, { allowed, scope });
    /* 素材路径与内容在**草稿阶段**就校验：坏路径不许等到 apply 写盘时才炸。 */
    let assetBytes = 0;
    for (const [index, file] of files.entries()) {
      const problem = assetFileProblem(file, index);
      if (problem !== null) {
        throw new SceneError('AGENT_FAILED', `provider 返回的素材不合法：${problem}`, 502, {
          reason: `BAD_ASSET:${problem}`,
        });
      }
      assetBytes += file.data !== undefined ? file.data.length : Buffer.byteLength(String(file.text ?? ''));
    }
    if (assetBytes > MAX_ASSET_BYTES) {
      throw new SceneError('AGENT_FAILED', `provider 返回的素材总量超预算：${String(assetBytes)} 字节 > ${String(MAX_ASSET_BYTES)}`, 502, {
        reason: 'ASSETS_TOO_LARGE',
        bytes: assetBytes,
      });
    }

    const draftId = `draft-${randomUUID()}`;
    const record = {
      draftId,
      projectId,
      projectDir: project.dir,
      prompt,
      seed,
      provider: typeof generated?.provider === 'string' && generated.provider !== '' ? generated.provider : provider.id,
      providerIsMock: engine.mock === true,
      /* 本地生成器（M93）会明说自己是谁；远端 provider 没这个字段就是空串。 */
      generatedBy: typeof generated?.generatedBy === 'string' ? generated.generatedBy : '',
      ops,
      files: files.map((/** @type {any} */ file) => ({
        path: file.path,
        ...(file.data !== undefined ? { data: file.data } : { text: file.text }),
      })),
      summary: typeof generated?.summary === 'string' ? generated.summary : '',
      textOnly,
      warnings: Array.isArray(generated?.warnings) ? generated.warnings.map(String) : [],
      scope: [...allowed],
      baseHash: project.sourceHash ?? '',
      /* R114：选择与会话一起记进草稿记录 —— apply / 回读时能说明「这份草稿是哪次选择产的」。 */
      selection,
      sessionId,
      /* 答复件 §3.2：`session` 只做上下文引用与记录（审计用），**不改 apply/rollback 语义**。
         `resumed:false` 是明说的：真续接（ACP resume/load）属 B03，这条还没接。 */
      context: { sessionId, resumed: false },
      /* R122（M8-B）：这次请求里引用/附件的**服务端视角**（解析结果 + 摘要）。
         回读草稿时能说明「模型那一侧到底拿到了什么」。 */
      consumed: {
        refs: resolvedRefs,
        attachments: attachments.map((/** @type {any} */ file) => ({
          name: file.name,
          kind: file.kind,
          bytes: file.bytes,
          sha256: file.sha256,
          available: file.available,
          ...(file.available === true ? {} : { reason: file.reason }),
        })),
      },
      runId,
      snapshotSha: null,
      applied: false,
      appliedSha: null,
      appliedAt: null,
      rolledBack: false,
      createdAt: new Date().toISOString(),
    };
    drafts.set(draftId, record);
    if (record.ops.length) engine.confirmedProposal?.();
    while (drafts.size > maxDrafts) {
      const oldest = drafts.keys().next();
      if (oldest.done === true) break;
      drafts.delete(oldest.value);
    }
    /* R114 · L3：续接会话 —— 草稿成功后把这一回合真的写进 `turns/<id>.json`。
       写失败不丢掉草稿（那是用户已经拿到的结果），但**必须**在响应里说出来。 */
    let turn = null;
    let sessionWarning = '';
    if (sessionId !== null && sessionsStore !== null) {
      const appended = await sessionsStore.appendTurn(sessionId, {
        prompt,
        draftId,
        state: 'draft',
        at: record.createdAt,
        steps: ops.slice(0, 50).map((/** @type {any} */ op) => ({
          op: typeof op?.op === 'string' ? op.op : '',
          text: typeof op?.clip === 'string' ? op.clip : '',
        })),
      });
      if (appended.ok === true) {
        turn = appended.turn;
      } else {
        sessionWarning = `草稿已生成，但回合没能写进会话：${appended.code}`;
        log(`AGENT_SCENE_SESSION_WRITE_FAILED draft=${draftId} session=${String(sessionId)} code=${appended.code}`);
      }
    }
    log(`AGENT_SCENE_DRAFT ${draftId} project=${projectId} provider=${record.provider} ops=${String(ops.length)} session=${String(sessionId)} model=${String(selection.model)}`);
    return {
      draftId,
      /* 答复件 §3.2：draft 响应的 provider 是**对象**（id + 实际模型 + 能力），
         不再是裸字符串 —— UI 按 capabilities 置灰，而不是自己猜。apply/rollback
         的响应仍是字符串（那条契约没变）。 */
      provider: {
        id: record.provider,
        model: selection.model,
        capabilities: selection.capabilities,
      },
      providerIsMock: record.providerIsMock,
      generatedBy: record.generatedBy,
      seed,
      ops: record.ops,
      /* 素材只回**路径与大小**：字节留在服务端内存，apply 时才落盘。 */
      files: record.files.map((/** @type {any} */ file) => ({
        path: file.path,
        bytes: file.data !== undefined ? file.data.length : Buffer.byteLength(String(file.text ?? '')),
      })),
      summary: record.summary,
      warnings: record.warnings,
      scope: record.scope,
      baseHash: record.baseHash,
      /* 选择回读：UI 拿它证明「我选的真的进了请求」，而不是本地自说自话。 */
      selection,
      selectionApplied: true,
      sessionId,
      /* 会话引用的口径：`resumed:false` = 历史只读、没续接原会话（B03 才做真续接）。 */
      context: record.context,
      /* R122（M8-B）：引用/附件真的进请求了 —— 这里是服务端解析到的结果；
         `providerEcho` 是 provider 自报「我收到了什么」（没有就是 null，不编）。 */
      consumed: record.consumed,
      providerEcho: generated?.echo ?? null,
      runId: record.runId,
      turn,
      sessionWarning,
    };
  }

  /** @param {string} draftId */
  function draftOrThrow(draftId) {
    const record = drafts.get(draftId);
    if (record === undefined) {
      throw new SceneError('DRAFT_NOT_FOUND', `草稿不存在或已过期：${draftId}`, 404);
    }
    return record;
  }

  /**
   * 用户对「应用这份草稿」的显式批准（CS3）。
   *
   * 这是 UI 点「允许」那一刻才调用的接口 —— 批准票绑定 draftId + projectId + 基线 sha，
   * 一次性、短期有效。它**不是** ACP 工具票：两者互不认可（见 `apply()` 与 `/ops`）。
   *
   * @param {string} draftId
   */
  function approve(draftId) {
    const record = draftOrThrow(draftId);
    const project = projectOrThrow(record.projectId);
    /* 没有可应用的东西：批准没有意义，直接说清楚（别签一张空票）。 */
    if (record.textOnly === true || record.applied === true || record.ops.length === 0) {
      return {
        ok: true,
        draftId,
        textOnly: record.textOnly === true,
        alreadyApplied: record.applied === true,
        approvalToken: null,
        expiresAt: null,
        projectId: record.projectId,
        baseHash: project.sourceHash ?? '',
      };
    }
    const token = `ap-${randomUUID()}`;
    const expiresAt = Date.now() + applyApprovalTtlMs;
    applyApprovals.set(token, {
      token,
      draftId,
      projectId: record.projectId,
      baseHash: project.sourceHash ?? '',
      expiresAt,
      usedAt: null,
    });
    /* 只留最近 200 张，避免长跑进程里越攒越多。 */
    while (applyApprovals.size > 200) {
      const oldest = applyApprovals.keys().next();
      if (oldest.done === true) break;
      applyApprovals.delete(oldest.value);
    }
    return {
      ok: true,
      draftId,
      textOnly: false,
      alreadyApplied: false,
      approvalToken: token,
      expiresAt: new Date(expiresAt).toISOString(),
      projectId: record.projectId,
      baseHash: project.sourceHash ?? '',
      ttlMs: applyApprovalTtlMs,
    };
  }

  /**
   * 校验一张应用批准票。**在写盘之前**调用；一次性用完即作废。
   * @param {string} draftId
   * @param {string} token
   */
  function checkApplyApproval(draftId, token) {
    if (typeof token !== 'string' || token === '') {
      throw new SceneError('APPLY_APPROVAL_REQUIRED', '应用草稿需要用户批准（POST /api/agent/scene/:id/approval 后带 x-opencut-apply-approval）', 403);
    }
    const approval = applyApprovals.get(token);
    if (approval === undefined || approval.draftId !== draftId) {
      throw new SceneError('APPLY_APPROVAL_UNKNOWN', '这张批准票不认这份草稿', 403);
    }
    if (approval.usedAt !== null) {
      throw new SceneError('APPLY_APPROVAL_USED', '这张批准票已经用过一次（一次批准只应用一次）', 409);
    }
    if (Date.now() > approval.expiresAt) {
      applyApprovals.delete(token);
      throw new SceneError('APPLY_APPROVAL_EXPIRED', '这张批准票已过期，请重新点「允许」', 403);
    }
    const record = draftOrThrow(draftId);
    if (approval.projectId !== record.projectId) {
      throw new SceneError('APPLY_APPROVAL_PROJECT_MISMATCH', '批准票绑的是别的工程', 403);
    }
    const project = projectOrThrow(record.projectId);
    if ((project.sourceHash ?? '') !== approval.baseHash) {
      throw new SceneError('APPLY_BASE_DRIFT', '草稿生成后工程已被改动，请重新生成或撤销后再应用', 409, {
        expected: approval.baseHash,
        actual: project.sourceHash ?? '',
      });
    }
    approval.usedAt = new Date().toISOString();
    return approval;
  }

  /**
   * 应用草稿（幂等）。
   * @param {string} draftId
   * @param {{ approval?: string | null }} [opts]
   */
  async function apply(draftId, opts = {}) {
    const record = draftOrThrow(draftId);
    const project = projectOrThrow(record.projectId);

    /* CS2：纯问答草稿没有可应用的东西。回 `applied: 0` 而不是报错 —— 用户问了一句话，
       面板不该弹一个「应用失败」。也不落快照、不动撤销栈。 */
    if (record.textOnly === true) {
      return {
        ok: true,
        textOnly: true,
        applied: 0,
        alreadyApplied: false,
        sha256Before: project.sourceHash ?? '',
        sha256After: project.sourceHash ?? '',
        touched: [],
        snapshotSha: null,
        seed: record.seed,
        provider: record.provider,
        note: 'TEXT_ONLY: 这条没有要应用的编辑，工程未被写盘',
      };
    }

    if (record.applied) {
      return {
        ok: true,
        alreadyApplied: true,
        applied: 0,
        sha256Before: record.appliedSha,
        sha256After: record.appliedSha,
        touched: [],
        snapshotSha: record.snapshotSha,
        seed: record.seed,
        provider: record.provider,
      };
    }

    /* CS3：真正要写盘了 —— 先核**用户批准**（与 ACP 工具票完全分开的一条链）。
       幂等回包（上面两条）不写盘，所以不需要新票；到这里就一定要。 */
    checkApplyApproval(draftId, typeof opts?.approval === 'string' ? opts.approval : '');

    if (record.snapshotSha === null) {
      record.snapshotSha = await snapshotBefore(project, draftId);
    }

    /* 素材先落盘（M93）：生成的柱子/动画页在 ops 之前就要存在，否则第一帧渲染读不到。
       ops 失败时把**这次刚写进去的**文件删掉，不留半套素材。 */
    /** @type {Array<{ path: string, bytes: number }>} */
    let writtenFiles = [];
    if (record.files.length > 0) {
      try {
        writtenFiles = await writeSceneAssets(record.projectDir, record.files);
        log(`AGENT_SCENE_ASSETS ${draftId} files=${String(writtenFiles.length)}`);
      } catch (error) {
        await removeSceneAssets(record.projectDir, writtenFiles);
        throw new SceneError('AGENT_FAILED', `写入生成素材失败：${String(/** @type {any} */ (error)?.message ?? error)}`, 502, {
          reason: 'ASSET_WRITE_FAILED',
        });
      }
    }

    const before = project.sourceHash ?? '';
    const result = await registry.applyOps(
      record.projectId,
      { opId: `agent-scene:${draftId}`, by: 'agent' },
      record.ops,
    );
    if (result.ok !== true) {
      await removeSceneAssets(record.projectDir, writtenFiles);
      const status = result.code === 'CONFLICT' ? 409 : result.code === 'NOT_FOUND' ? 404 : 400;
      throw new SceneError(
        typeof result.code === 'string' ? result.code : 'APPLY_FAILED',
        String(result.message ?? '应用草稿失败'),
        status,
        typeof result.currentHash === 'string' ? { currentHash: result.currentHash } : {},
      );
    }

    const replayed = result.replayed === true;
    record.applied = true;
    record.appliedSha = result.hash;
    record.appliedAt = new Date().toISOString();
    log(
      `AGENT_SCENE_APPLY ${draftId} project=${record.projectId} ops=${String(record.ops.length)} ` +
        `changed=${String(result.changed === true)} replayed=${String(replayed)}`,
    );
    return {
      ok: true,
      alreadyApplied: replayed,
      applied: replayed ? 0 : record.ops.length,
      sha256Before: replayed ? result.hash : before,
      sha256After: result.hash,
      touched: Array.isArray(result.touched) ? result.touched : [],
      snapshotSha: record.snapshotSha,
      seed: record.seed,
      provider: record.provider,
      generatedBy: record.generatedBy,
      assets: replayed ? [] : writtenFiles,
    };
  }

  /**
   * 用 apply 前的 M62 快照恢复 film.html。
   * @param {string} draftId
   */
  async function rollback(draftId) {
    const record = draftOrThrow(draftId);
    if (typeof record.snapshotSha !== 'string' || record.snapshotSha === '') {
      throw new SceneError('NO_SNAPSHOT', '这个草稿没有可恢复的版本快照', 409, {
        draftId,
        applied: record.applied,
      });
    }
    const project = projectOrThrow(record.projectId);
    /** @type {any} */
    let restored;
    try {
      restored = await restoreFilm(project.dir, record.snapshotSha, { force: true });
    } catch (error) {
      if (error instanceof VersionsError) {
        throw new SceneError(error.code, error.message, error.status ?? 500);
      }
      throw error;
    }
    // 文件被换掉了：关掉再打开，让会话/投影/opLog 全部从磁盘重来。
    await registry.close(record.projectId, { waitMs: 2000 });
    const reopened = await registry.open(project.dir);
    record.applied = false;
    record.rolledBack = true;
    record.appliedSha = null;
    log(`AGENT_SCENE_ROLLBACK ${draftId} project=${record.projectId} sha=${String(restored.filmSha).slice(0, 8)}`);
    return {
      ok: true,
      sha256: restored.filmSha,
      restoredFrom: record.snapshotSha,
      restored: Array.isArray(restored.restored) ? restored.restored : [],
      reopened: reopened.ok === true,
      ...(reopened.ok === true ? {} : { reopenCode: String(reopened.code ?? '') }),
    };
  }

  /** @param {string} draftId */
  function get(draftId) {
    const record = drafts.get(draftId);
    if (record === undefined) return null;
    return {
      draftId: record.draftId,
      projectId: record.projectId,
      provider: record.provider,
      providerIsMock: record.providerIsMock,
      generatedBy: record.generatedBy,
      seed: record.seed,
      prompt: record.prompt,
      ops: record.ops,
      files: record.files.map((/** @type {any} */ file) => ({ path: file.path })),
      summary: record.summary,
      warnings: record.warnings,
      scope: record.scope,
      baseHash: record.baseHash,
      snapshotSha: record.snapshotSha,
      applied: record.applied,
      appliedSha: record.appliedSha,
      appliedAt: record.appliedAt,
      rolledBack: record.rolledBack,
    };
  }

  return {
    draft,
    approve,
    apply,
    rollback,
    get,
    roster,
    /** R122（M8-A）：同一个台账实例 —— 路由 `POST /api/agent/runs/:runId/cancel` 用它。 */
    runs,
    /**
     * CS3：请求方断线（页面重载/关标签）。只记 `detachedAt`，不关 run ——
     * 重载之后用户点 Stop 还要能停到这一回合。返回受影响的视图或 null。
     * @param {{ projectId?: string, sessionId?: string, runId?: string, pageId?: string }} input
     */
    detachRun(input = {}) {
      if (typeof input.runId !== 'string' || input.runId === '') return null;
      const row = runs.detach(input.runId, {
        projectId: input.projectId,
        sessionId: input.sessionId,
        pageId: input.pageId,
      });
      if (row === null || row === undefined) return null;
      log(`AGENT_RUN_DETACHED run=${row.runId} instance=${String(row.instance)} project=${row.projectId} session=${String(row.sessionId)}`);
      return runs.view(row);
    },
    providerId: () => provider.id,
    isMock: () => provider.mock === true,
    /** 有没有在途 draft（会话 PATCH 用它回 409 SESSION_RUNNING）。 */
    isSessionRunning,
    /** @visibleForTesting */
    count: () => drafts.size,
  };
}

/** mock provider 的 id（交接/证据里要能一眼看出没接真实模型）。 */
export { MOCK_PROVIDER_ID };
