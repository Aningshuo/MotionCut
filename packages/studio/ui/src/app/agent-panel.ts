/**
 * Agent 原创场景面板（S70 · WP21）。
 *
 * ## 三段状态机
 *
 * ```
 * idle ──生成──▶ draft（只出草稿，**不写盘**）──应用──▶ applied（给「撤销」）
 *                    │                                  │
 *                    └────── 重新生成 ◀── rolledback ◀──┘（rollback：回到 apply 前的快照）
 * ```
 *
 * 硬约束（任务书 §2.1）：
 * 1. **诚实**：接口返回 `providerIsMock` 时，草稿区固定显示 `provider: mock`，
 *    文案说清「项目内确定性 mock，不是真实模型」；任何地方都不写「AI 已生成真实场景」。
 * 2. **幂等**：服务端第二次 apply 回 `alreadyApplied:true`（命中 opLog 重放缓存），
 *    界面据此提示「没有重复写盘」，不把它说成一次新的写入。
 * 3. **回退**：rollback 用服务端快照恢复；界面显示恢复到的 sha，而不是假装成功。
 * 4. **不阻塞**：面板是侧边抽屉，没有遮罩；生成中预览/播放照常可操作。
 *
 * 四种错误态各有可读文案与「下一步」：无 provider、草稿过期、工程未打开、ops 校验失败。
 * 服务端原文（message）逐字显示，界面自己的引导写在另一行，不混在一起。
 */

import { createElement, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { ApiError, applyAgentScene, approveAgentScene, createAgentSession, getAgentSession, getDoc, listAssets, rollbackAgentScene } from './api';
import type { AgentSceneDraft, AgentSessionRow, AgentSessionTurn, AgentSessionTurnStep } from './api';
import {
  REF_KIND_LABEL,
  addRef,
  collectRefs,
  filesOfDoc,
  refOverflowOf,
  removeRef,
  selectionFromDebug,
} from './agent-refs';
import type { RefSourceAsset, RefTarget } from './agent-refs';
import {
  agentCapabilitiesOf,
  agentProviderIdOf,
  answerAcpPermission,
  cancelAgentRun,
  draftAgentSceneBound,
  fetchAcpPermissions,
  fetchAgentRoster,
  listAgentSessionsWithArchived,
  patchAgentSession,
} from './agent-api';
import type { AcpPermissionRow, AgentRoster, AgentSelection } from './agent-api';
import { AgentModelPicker, selectedModelOf } from './agent-model-picker';
import {
  SESSION_MODEL_EVENT,
  forgetSessionModel,
  notifyModelChange,
  readSessionModelStore,
  rememberSessionModel,
  resolveModelSelection,
} from './agent-session-model';
import type { ModelScope } from './agent-session-model';
import { AgentSessionBar, sessionErrorText } from './agent-session-bar';
import { viewServerError } from './server-error';
import type { ServerErrorView } from './server-error';
/* 消息里的相对路径音频 → 可点播放条（S76）；拒绝的路径连 URL 都不构造。 */
import { renderAudioText } from './audio-link';
/* 渲染端真正认的键：**import 常量，不抄一份**——抄一份就失去守卫意义（S71）。 */
import { OVERRIDE_APPLY_KEYS } from '../../../../layers/apply-overrides.mjs';

import './agent-chat.css';

const h = createElement;

/**
 * F08 相对时间（参照「2 分钟前」口径）：只做档位，不做本地化格式。
 * 解析不出来返回空串 —— 不编一个「刚刚」。
 */
export function relativeTimeOf(iso: string, now = Date.now()): string {
  const stamp = Date.parse(iso);
  if (!Number.isFinite(stamp)) return '';
  const delta = Math.max(0, now - stamp);
  if (delta < 60_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return `${Math.floor(delta / 86_400_000)} 天前`;
}

/* ── A06（R102）：面板开关不重置「会话」────────────────────────────────
 *
 * `App.tsx` 在 `agentOpen === false` 时**卸载**本组件（条件 `createElement`），
 * 所以「上次打开的是哪个会话」不能只放在 useState 里 —— 要留在组件外面。
 * 这里只记 `sessionId`、按工程分键；会话被删 / 换工程时静默放弃，不弹错。
 * 另三个（项目 / 播放头 / 选择）都在宿主状态里，本组件从不写（见交接 itemA）。
 */
const SESSION_STORE_KEY = 'opencut.agent.session.v1';

/**
 * 聊天附件的内容上限（与服务端 `MAX_ATTACHMENT_BYTES` 同值）。
 *
 * 超了就只发名字（`available:false`）—— 面板不假装模型看过一个读都没读的文件，
 * 也不把几十兆的视频塞进一条 JSON 请求。
 */
const MAX_ATTACHMENT_BYTES = 512 * 1024;

/**
 * 一条消息里最多几个附件、合计多少字节（与服务端 `MAX_ATTACHMENTS` /
 * `MAX_ATTACHMENTS_TOTAL` 同值）。
 *
 * R124 · M10：超过总量的那些**不是**静默丢弃，也不是让服务端回 400 —— 退化成
 * 「只有名字」（`reason:'BATCH_TOO_LARGE'`）并在提示里说清。超过个数上限的才丢，
 * 因为名字也会占一条数组位，全带上去必然 400。
 */
const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENTS_TOTAL = 2 * 1024 * 1024;

/** 存储接口只用到这两个方法：单测/量具可以喂一个假 store，不必真 localStorage。 */
export interface SessionStore {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/** 读「工程 → 上次会话」表。坏数据一律当空表（别让一条脏记录把面板打死）。 */
export function readSessionStore(store?: SessionStore | null): Record<string, string> {
  const box = store ?? (typeof localStorage === 'undefined' ? null : localStorage);
  if (box === null) return {};
  try {
    const raw = box.getItem(SESSION_STORE_KEY);
    if (raw === null || raw === '') return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value !== '') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** 记一个工程的上次会话。写不进去（隐私模式 / 配额满）就算了，不影响面板。 */
export function rememberSession(projectId: string, sessionId: string, store?: SessionStore | null): void {
  if (projectId === '' || sessionId === '') return;
  const box = store ?? (typeof localStorage === 'undefined' ? null : localStorage);
  if (box === null) return;
  try {
    const map = readSessionStore(box);
    map[projectId] = sessionId;
    box.setItem(SESSION_STORE_KEY, JSON.stringify(map));
  } catch {
    /* 记不住就记不住：下次开面板回到「没选会话」，不是错误。 */
  }
}

/* ── R141（M13 · LI-A41）：模型选择按**工程**记 ─────────────────────────────
 *
 * 为什么必须按工程分键：选择是「这个工程用哪个模型」，不是全局偏好。
 * 只存一个 `selection` 会让 A 工程切的模型串到 B 工程 —— 用户以为在用 X，
 * 实际请求里带的是 Y。面板关掉会卸载组件，所以也不能只放 React state：
 * 重新打开要能从存储里接回**上次真的选过**的那一项（不是 roster 默认值）。
 *
 * 存的是用户意图（agent/provider/model + thinking/speed），不做「名册里还有没有」
 * 的过滤：模型下线时服务端会回 `MODEL_UNAVAILABLE`，那比悄悄换回默认值诚实。
 */
export const MODEL_STORE_KEY = 'opencut.agent.model.v1';

/** 读「工程 → 上次模型选择」表。坏数据一律当空表。 */
export function readModelStore(store?: SessionStore | null): Record<string, AgentSelection> {
  const box = store ?? (typeof localStorage === 'undefined' ? null : localStorage);
  if (box === null) return {};
  try {
    const raw = box.getItem(MODEL_STORE_KEY);
    if (raw === null || raw === '') return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    /** @type {Record<string, AgentSelection>} */
    const out: Record<string, AgentSelection> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      const row = value as Record<string, unknown>;
      const provider = typeof row.provider === 'string' ? row.provider : '';
      if (provider === '') continue;
      out[key] = {
        agent: typeof row.agent === 'string' ? row.agent : '',
        provider,
        model: typeof row.model === 'string' ? row.model : null,
        thinking: typeof row.thinking === 'string' ? row.thinking : null,
        speed: typeof row.speed === 'string' ? row.speed : null,
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** 记一个工程的模型选择。写不进去就算了（下次回默认，不是错误）。 */
export function rememberModel(projectId: string, selection: AgentSelection, store?: SessionStore | null): void {
  if (projectId === '' || selection.provider === '') return;
  const box = store ?? (typeof localStorage === 'undefined' ? null : localStorage);
  if (box === null) return;
  try {
    const map = readModelStore(box);
    map[projectId] = selection;
    box.setItem(MODEL_STORE_KEY, JSON.stringify(map));
  } catch {
    /* 同上：记不住不阻断任何操作。 */
  }
}

function resolveChatModel(projectId: string, sessionId: string, roster: AgentRoster | null) {
  const resolved = resolveModelSelection({ projectId, sessionId, rosterDefaults: roster?.defaults ?? null });
  const selected = resolved.selection;
  if (selected?.agent === 'codex' && selected.model === 'codex' && roster?.defaults.agent === 'codex') {
    return { ...resolved, selection: roster.defaults };
  }
  return resolved;
}

export interface AgentPanelProps {
  enabledAgents?: string[] | null;
  /** 空串 = 没有打开的工程（面板仍可开，但只给「先打开工程」）。 */
  projectId: string;
  projectName: string;
  clipReferenceRequest?: { projectId: string; sequenceId: string; ids: string[] } | null;
  onClipReferencesAccepted?: () => void;
  /**
   * 当前序列 id（AgentContext 的 `sequenceId`）。不传 = 引擎默认 `main`。
   *
   * 为什么是可选：`App.tsx` 归 MAIN，本批不抢那一行；MAIN 把 `sequence` 传进来
   * 之前，这里的值只能是默认序列 —— 这是**已知缺口**，写在交接 `untested` 里，
   * 不假装「已经跟着用户切序列」。
   */
  sequenceId?: string;
  /** 内容 origin（S76）：消息里的相对路径音频走它取流，同一条素材路由，不新开文件服务。 */
  contentOrigin: string;
  onClose: () => void;
  /** 写盘/回滚之后让宿主刷新 doc 与预览（面板不直接碰舞台）。 */
  onApplied: () => void;
  /**
   * `+` 菜单里那条「上传素材」的落点（R35·E7）。
   *
   * 面板自己不碰文件系统：桌面版要走 Electron 的 `pickMedia`、浏览器版要走宿主的
   * `<input type=file>`，两条路都在 `App.tsx` 的 `pickMedia()` 里，最终都落到
   * `api.ts` 的 `importMedia`（`POST /api/projects/:id/media`）。这里只留一个回调，
   * 不复制第二套选文件逻辑 —— 复制一套就会有一半路径拿不到桌面桥。
   * 不传 = 没有宿主入口（菜单项置灰并写明原因，不做「点了没反应」）。
   */
  onPickMedia?: () => void;
}

type Phase = 'idle' | 'generating' | 'draft' | 'applying' | 'applied' | 'rolling' | 'rolledback';

/**
 * 一次 Agent run 的身份（**冻结形状**，答复件 ANSWER-SUB2-R114-DEPS §3.3）。
 *
 * 别自创第二套：`{projectId, sequenceId, conversationId, agentId, providerId, modelId,
 * runId, generation}`。上游由本面板组装 → `agent-api.ts` 发送；下游 `agent-scene.draft()`
 * 用 `session`（= conversationId）/ `agent` / `model` 三个字段，provider 由 model 反查。
 *
 * 迟到判据：`runId + generation` 任一不匹配 → 丢弃（切工程/切会话同样丢）。
 */
export interface AgentContext {
  projectId: string;
  sequenceId: string;
  /** 就是会话 id（旧名字叫 sessionId）。 */
  conversationId: string;
  agentId: string;
  providerId: string;
  modelId: string;
  runId: string;
  generation: number;
}

type Stage = 'generate' | 'apply' | 'rollback';

/** ops 的人话摘要（原始 JSON 在 `agent-raw` 里可展开）。 */
export function summarizeOp(op: unknown): string {
  const item = (op ?? {}) as Record<string, any>;
  const kind = typeof item.op === 'string' ? item.op : '未知';
  const clip = typeof item.clip === 'string' ? item.clip : (item.clip?.id ?? '');
  if (kind === 'overrides') {
    const entries = Array.isArray(item.entries) ? item.entries : [];
    const at = entries.map((entry: any) => String(entry?.at ?? '')).filter((value: string) => value !== '');
    return `覆盖 ${clip} 的 ${String(entries.length)} 处${at.length === 0 ? '' : `（${at.join(', ')}）`}`;
  }
  if (kind === 'set') return `设置 ${clip} 的 ${String(item.field ?? '?')}`;
  if (kind === 'insert') return `插入片段 ${String(clip)}`;
  if (kind === 'remove') return `删除片段 ${String(clip)}`;
  if (kind === 'move') return `移动 ${String(clip)} 到 ${String(item.track ?? '?')} 轨`;
  return `${kind} ${String(clip)}`.trim();
}

/**
 * 审一遍草稿里的 overrides：哪些键渲染端根本不会读。
 *
 * 背景（BLK-R36-1）：`film-core` 的 validateOverrides 放行 `text`/`n`，而
 * `apply-overrides.mjs` 只认 `t/style/lock/s/r`——写盘成功、画面不动、零提示。
 * 这个函数让面板在写盘前后都能给出「会被忽略的键」，而不是让用户以为场景变了。
 */
export interface OverrideAudit {
  /** 渲染端不会读的键（去重、稳定顺序）。 */
  ignoredKeys: string[];
  /** 真正会生效的条目数（键全部在白名单里、且 style 是记录）。 */
  renderableEntries: number;
  /** 检查过的 overrides 条目总数。 */
  checkedEntries: number;
}

export function auditOverrideOps(ops: unknown[]): OverrideAudit {
  const allowed = new Set<string>(OVERRIDE_APPLY_KEYS);
  const ignored: string[] = [];
  let renderable = 0;
  let checked = 0;
  for (const op of Array.isArray(ops) ? ops : []) {
    const item = (op ?? {}) as Record<string, any>;
    if (item.op !== 'overrides' || !Array.isArray(item.entries)) continue;
    for (const entry of item.entries) {
      if (entry === null || typeof entry !== 'object') continue;
      checked += 1;
      let bad = false;
      for (const key of Object.keys(entry)) {
        if (key === 'at') continue;
        if (!allowed.has(key)) {
          bad = true;
          if (!ignored.includes(key)) ignored.push(key);
          continue;
        }
        /* `style` 必须是记录：字符串会被渲染端按字符下标当属性名，同样等于无效。 */
        if (key === 'style') {
          const style = (entry as Record<string, any>).style;
          if (style === null || typeof style !== 'object' || Array.isArray(style)) {
            bad = true;
            if (!ignored.includes('style')) ignored.push('style');
          }
        }
      }
      if (!bad) renderable += 1;
    }
  }
  return { ignoredKeys: ignored, renderableEntries: renderable, checkedEntries: checked };
}

/** 错误分类：面板要给出与错误匹配的「下一步」，而不是一句「失败了」。 */
function hintFor(stage: Stage, view: ServerErrorView): string {
  const reason = view.reason;
  if (view.code === 'FILM_NOT_FOUND') return '先在左侧打开一个工程，再回来生成。';
  if (view.code === 'DRAFT_NOT_FOUND') return '草稿只在内存里、重启 Studio 会丢；点「重新生成」拿一份新草稿。';
  if (view.code === 'NO_SNAPSHOT') return '这次 apply 没有留下快照（工程不在 git 仓库里），无法回滚；可以手动改回或撤销。';
  /* R148（M15 · B2）：超时是**预算到点**，不是「没有 provider」。
     旧文案把两者混成一句，还会建议「切回内置 mock」—— 那既误导又像在推销降级。 */
  if (reason === 'PROVIDER_TIMEOUT') {
    /* 长变量名不塞进这句：232px 的 Agent 列放不下，会被右缘切掉。变量名单独渲染
       （可换行 + 可复制），这里只说人话。 */
    return 'provider 在超时预算内没有回包（这次已中止：不建草稿、不记回合）。可以调大超时预算（下面的变量名可复制）；不会自动换模型、也不会转 mock。';
  }
  /* provider 类要先判：它的 code 也是 AGENT_FAILED，别被下面那条吃掉。 */
  if (/PROVIDER/i.test(reason) || /PROVIDER/i.test(view.code)) {
    return '没有可用的 provider（或它不可达）；检查配置后重试；不会自动换成 mock。';
  }
  if (reason.startsWith('VALIDATION') || view.code === 'AGENT_FAILED') {
    return stage === 'generate' ? 'provider 产出的 ops 没过校验；换个说法或缩短描述再试。' : 'ops 没通过校验，磁盘未被改动。';
  }
  if (view.code === 'CONFLICT') return '工程在别处被改过；点「重新生成」拿基于最新内容的新草稿。';
  return stage === 'generate' ? '可以改一句话再试。' : '可以重试；失败不会改变当前工程内容。';
}

/**
 * 回合下方的步骤摘要（E09 · E2）。
 *
 * 参照形态：「已处理 28s · 3 个步骤 ›」——**默认一行、点开才列**。
 *
 * 两个实现细节（判据写的是 `aria-expanded` 翻转，不是 `open` 属性）：
 *   1. 原生 `<details>` 只翻自己的 `open`，`summary` 上**没有** `aria-expanded`。
 *      所以这里用 `onToggle` 把状态同步到 `summary` 的 `aria-expanded` 上；
 *   2. 不用受控 `open={...}`：受控 + `onToggle` 改状态会互相触发，点击可能闪一下才开。
 *      `<details>` 保持非受控，状态只用来写 aria。
 *
 * 数据从哪来：回合 JSON 的可选字段 `turn.steps`（服务端 `turnsOf` 透传）。
 * 老回合没有这个字段 → 不渲染这一行，不编一个「0 个步骤」。
 */
function TurnSteps(props: { steps: AgentSessionTurnStep[] }): ReactNode {
  const [open, setOpen] = useState(false);
  if (props.steps.length === 0) return null;
  return h(
    'details',
    {
      className: 'agent-turn-steps',
      'data-testid': 'agent-turn-steps',
      'data-steps': String(props.steps.length),
      onToggle: (event: { currentTarget: { open: boolean } }) => setOpen(event.currentTarget.open),
    },
    h(
      'summary',
      { className: 'agent-turn-steps-summary', 'aria-expanded': open ? 'true' : 'false' },
      ChatIcon('chevron', 14),
      h(
        'span',
        { className: 'agent-turn-steps-label' },
        `${String(props.steps.length)} 个步骤${props.steps[0]?.text ? ` · ${props.steps[0].text}` : ''}`,
      ),
    ),
    h(
      'ol',
      { className: 'agent-turn-ops', 'data-testid': 'agent-turn-ops' },
      ...props.steps.map((step, index) =>
        h(
          'li',
          { key: String(index), className: 'agent-turn-op', 'data-op': step.op, 'data-testid': 'agent-turn-op' },
          h('span', { className: 'agent-turn-op-kind' }, step.op === '' ? '—' : step.op),
          h('span', { className: 'agent-turn-op-text' }, step.text),
        ),
      ),
    ),
  );
}


/**
 * 1:1 对话面板的小图标（CS3 · MAIN-CS3-CHAT-PANEL-1TO1）。
 * 全部 `currentColor`、18×18 视觉盒、1.6 描边；颜色只由 CSS token 决定。
 * @param {'plus'|'search'|'chat'|'chevron'|'mic'|'send'|'stop'|'wrench'|'close'} name
 * @param {number} [size]
 */
function ChatIcon(name: 'plus' | 'search' | 'chat' | 'chevron' | 'mic' | 'send' | 'stop' | 'wrench' | 'close', size = 18) {
  const common = {
    viewBox: '0 0 18 18',
    width: size,
    height: size,
    'aria-hidden': 'true',
    focusable: 'false',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  };
  const paths: Record<string, string[]> = {
    plus: ['M9 4v10', 'M4 9h10'],
    search: ['M8 3.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Z', 'M11.4 11.4 15 15'],
    chat: ['M3.5 4.5h11v7.5h-6l-2.8 2.3V12H3.5Z'],
    chevron: ['M5.5 7.5 9 11l3.5-3.5'],
    mic: ['M9 3.5a1.8 1.8 0 0 1 1.8 1.8v3.4a1.8 1.8 0 0 1-3.6 0V5.3A1.8 1.8 0 0 1 9 3.5Z', 'M5.8 8.7a3.2 3.2 0 0 0 6.4 0', 'M9 12v2.5'],
    send: ['M9 14.5V4', 'M5 8l4-4 4 4'],
    stop: ['M6 6h6v6H6Z'],
    wrench: ['M10.8 3.6a3.2 3.2 0 0 0-4.3 4.1l-2.4 2.4a1.35 1.35 0 0 0 1.9 1.9L8.4 9.6a3.2 3.2 0 0 0 4.1-4.3l-1.7 1.7-1.6-1.6Z'],
    close: ['M5 5l8 8', 'M13 5l-8 8'],
  };
  return h('svg', common, ...(paths[name] ?? []).map((d, index) => h('path', { key: String(index), d })));
}

/** `3 分 48 秒` / `12 秒`；只报真实测到的耗时，没测到就空串（不编数）。 */
function formatElapsed(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes >= 60) return `${String(Math.floor(minutes / 60))} 小时 ${String(minutes % 60)} 分`;
  if (minutes > 0) return `${String(minutes)} 分 ${String(seconds)} 秒`;
  if (total <= 0) return '不到 1 秒';
  return `${String(seconds)} 秒`;
}

/**
 * 回合状态下的一句话（不把 `state` 原样丢给用户）。
 * @param {string} state
 */
function turnStateText(state: string) {
  if (state === 'draft') return '已生成草稿';
  if (state === 'applied') return '已应用';
  if (state === 'failed') return '失败';
  return state === '' ? '已处理' : state;
}

/**
 * `role="menu"` 的键盘约定（APG）：ArrowUp/ArrowDown 在菜单项之间走一圈。
 * 不接管 Tab（Tab 关闭菜单是浏览器默认行为，抢过来反而出不去）。
 */
function moveMenuFocus(event: { key: string; currentTarget: HTMLElement; preventDefault: () => void }): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  if (items.length === 0) return;
  event.preventDefault();
  const current = items.indexOf(document.activeElement as HTMLElement);
  const step = event.key === 'ArrowDown' ? 1 : -1;
  const next = current === -1 ? (step === 1 ? 0 : items.length - 1) : (current + step + items.length) % items.length;
  items[next]?.focus();
}

/** Explicit draft insertion only. Rejection preserves the entire existing draft and never sends a turn. */
export function prepareLibraryPromptInsertion(current: string, payload: unknown, projectId: string): { handled: boolean; ok: boolean; prompt: string; message: string; code?: string } {
  const detail = payload && typeof payload === 'object' ? payload as { projectId?: unknown; text?: unknown } : null;
  if (!projectId || detail?.projectId !== projectId) return { handled: false, ok: false, prompt: current, message: '' };
  if (typeof detail.text !== 'string' || !detail.text.trim()) return { handled: true, ok: false, prompt: current, code: 'PROMPT_INSERT_EMPTY', message: '技能内容为空，未加入输入框，也未发送' };
  const next = current ? `${current}\n${detail.text}` : detail.text;
  if (next.length > 16000) return { handled: true, ok: false, prompt: current, code: 'PROMPT_INSERT_TOO_LONG', message: detail.text.length > 16000 ? '技能内容超过对话输入上限（16,000 字符），请精简后再加入；未执行' : '技能与已有草稿合计超过 16,000 字符，请先精简草稿；内容未加入，也未发送' };
  return { handled: true, ok: true, prompt: next, message: '技能已放入输入框，请确认内容后再发送' };
}

export function AgentPanel(props: AgentPanelProps): ReactNode {  const [phase, setPhase] = useState<Phase>('idle');
  /* R166（UI-V3-C · AGENT-04）：初值留空，占位文案才看得见；原先预填了一句示例，
     用户不清空就会以为「已经写好了」，也看不到输入提示。用户开始输入后不清空。 */
  const [prompt, setPrompt] = useState('');
  const promptForInsert = useRef(prompt);
  promptForInsert.current = prompt;
  useEffect(() => {
    const insert = (event:Event):void => {
      const detail=(event as CustomEvent<{projectId?:string;text?:string}>).detail;
      const result = prepareLibraryPromptInsertion(promptForInsert.current, detail, props.projectId);
      if (!result.handled) return;
      if (result.ok) {
        promptForInsert.current = result.prompt;
        setPrompt(result.prompt);
        setError(previous => previous?.view.code.startsWith('PROMPT_INSERT_') ? null : previous);
      } else setError({ stage: 'generate', view: { status: 0, code: result.code ?? 'PROMPT_INSERT_FAILED', field: 'prompt', reason: 'INPUT_LIMIT', message: result.message, allowed: ['16000'] } });
      setNotice(result.message);
      window.dispatchEvent(new CustomEvent('opencut:agent-prompt-insert-result', { detail: { projectId: props.projectId, ok: result.ok, code: result.code, message: result.message } }));
    };
    window.addEventListener('opencut:agent-insert-prompt',insert);
    return () => window.removeEventListener('opencut:agent-insert-prompt',insert);
  },[props.projectId]);

  /** R122（M8-B · D01）：输入框跟着内容长高（1..5 行），不再盖在动作行下面。 */
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const [draft, setDraft] = useState<AgentSceneDraft | null>(null);
  const [error, setError] = useState<{ stage: Stage; view: ServerErrorView } | null>(null);
  const [notice, setNotice] = useState('');
  /* R152（M16 · B3）：超时提示里的长环境变量名 —— 只做「换行 + 可复制」，
     不改 handler、不改状态机；复制失败就不改文案（不报假成功）。 */
  const [tokenCopied, setTokenCopied] = useState(false);
  const [shaBefore, setShaBefore] = useState('');
  const [shaAfter, setShaAfter] = useState('');
  const [showRaw, setShowRaw] = useState(false);
  /** 1:1：技术细节默认收起（provider/原始 ops/sha），一键可展开 —— 不删节点。 */
  const [showTech, setShowTech] = useState(false);
  /** apply 后「画面到底会不会变」的判定（见 auditOverrideOps / BLK-R36-1）。 */
  const [visual, setVisual] = useState<'none' | 'unchanged' | 'renderable'>('none');
  const [ignoredKeys, setIgnoredKeys] = useState<string[]>([]);
  /** F08 Tier 1：在飞请求的中止器（取消入口）。 */
  const abortRef = useRef<AbortController | null>(null);
  /** F08 Tier 1：apply 前的权限提示（范围确认）。 */
  const [confirming, setConfirming] = useState(false);
  /* CS3 · MAIN-CS3-AUTHZ：**真实** ACP 工具权限卡（mock provider 永远不会有记录）。 */
  const [toolPermissions, setToolPermissions] = useState<AcpPermissionRow[]>([]);
  const [permissionBusy, setPermissionBusy] = useState('');
  const [permissionNotice, setPermissionNotice] = useState('');
  /** E09 · E7：`+` 的附件菜单（点外面 / Esc 都关）。 */
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const plusRef = useRef<HTMLButtonElement | null>(null);

  /* ── R114（L3）：会话管理 / 模型名册 / 引用 / run 隔离 ─────────────────── */
  const [archivedSessions, setArchivedSessions] = useState<AgentSessionRow[]>([]);
  const [fullRoster, setRoster] = useState<AgentRoster | null>(null);
  const enabled = props.enabledAgents;
  const roster = fullRoster && enabled ? {
    ...fullRoster,
    agents: fullRoster.agents.filter((row) => enabled.includes(row.id)),
    providers: fullRoster.providers.filter((row) => enabled.includes(row.agentId ?? fullRoster.defaults.agent)),
  } : fullRoster;
  const [rosterBusy, setRosterBusy] = useState(false);
  const [rosterError, setRosterError] = useState('');
  /** 最近一次成功拿到的名册：切工程时用它填「这个工程还没选过」的默认值。 */
  const rosterRef = useRef<AgentRoster | null>(null);
  /** 用户选的那一份（本地意图）。真正生效看 `selectionApplied`。 */
  const [selection, setSelection] = useState<AgentSelection | null>(null);
  /* R157（M18）：这份选择是从哪一级来的（会话 / 工程 / 全局 / 名册）——界面与量具都读它。 */
  const [selectionScope, setSelectionScope] = useState<ModelScope>('roster');
  /* 存储变了就 +1，让解析 effect 重算（设置页、chip、别的标签页都走这一条）。 */
  const [storeEpoch, setStoreEpoch] = useState(0);
  /** 服务端响应回读的选择 —— 用它证明「选的真的进了请求」。 */
  const [selectionApplied, setSelectionApplied] = useState<AgentSelection | null>(null);
  const [selectionRejected, setSelectionRejected] = useState('');
  /** 聊天引用（工程 / 会话 / 元素 / 片段 / 素材 / 文件 / Skill）。**只做提示，不导入轨道**。 */
  const [refs, setRefs] = useState<RefTarget[]>([]);
  useEffect(() => {
    const request = props.clipReferenceRequest;
    if (!request || request.projectId !== props.projectId || request.sequenceId !== (props.sequenceId || 'main')) return;
    setRefs(previous => request.ids.reduce((rows, id) => addRef(rows, {
      id: `clip:${id}`, kind: 'clip', identity: id, label: `片段 · ${id}`, title: '当前工程中的时间线片段',
    }), previous));
    props.onClipReferencesAccepted?.();
  }, [props.clipReferenceRequest, props.projectId, props.sequenceId, props.onClipReferencesAccepted]);
  /* R135（M11 · A）：**逐条**引用在服务端的解析结果（`ok / reason / sample / bytes / sha256`）。
     上一批只有「5/5」这个计数 —— 计数对不代表每一类都读到了真东西（H03）。
     键就是 `RefTarget.id`（`kind:identity`），与请求里发的完全同源。 */
  const [refStatus, setRefStatus] = useState<Record<string, { ok: boolean; reason: string; sample: string; bytes: number; sha256: string }>>({});
  const [atOpen, setAtOpen] = useState(false);
  const atRef = useRef<HTMLDivElement | null>(null);
  /* R118（L5）：`@` 候选的两类远端来源（素材库 / 工程文档里的文件）+ 读失败原因。
     只在这一类数据上「加载失败就说加载失败」：不拿空数组冒充「一条都没有」。 */
  const [atAssets, setAtAssets] = useState<RefSourceAsset[]>([]);
  const [atFiles, setAtFiles] = useState<string[]>([]);
  const [atBusy, setAtBusy] = useState(false);
  const [atError, setAtError] = useState('');
  /** 当前所选目标（读 App 的调试出口，工程不匹配就当没选 —— 见 agent-refs.ts）。 */
  const [selectionNow, setSelectionNow] = useState<{ clipId: string; elementKey: string } | null>(null);
  /* 聊天附件（R118 · A35 → R122 · D07）：**只进聊天**。不复制进 assets/、不插轨道。
     R122 起内容随请求走（`data` = base64、`sha256` 由浏览器算）：服务端核字节数与摘要后
     交给 provider —— 「受控引用」而不是只有名字。大文件读不动就 `available:false`，
     **不假装**模型看过。 */
  const [attachments, setAttachments] = useState<
    { name: string; bytes: number; kind: string; sha256: string; data: string; available: boolean; reason: string }[]
  >([]);
  /* R122（M8-A）：取消到底走到哪一步 —— 面板把它写成 data-cancel-*，文案据此选词。 */
  const [cancelRoute, setCancelRoute] = useState<'unknown' | 'wired' | 'absent' | 'error'>('unknown');
  const [cancelState, setCancelState] = useState('');
  /* R122（M8-B）：服务端解析到的引用/附件 + provider 自报收到的内容（回读用）。 */
  const [consumed, setConsumed] = useState<{ refs: number; okRefs: number; attachments: number } | null>(null);
  const [providerEcho, setProviderEcho] = useState<{ refs: number; attachments: number } | null>(null);
  /** 上一回真正发出去的请求里带了什么（探针不必抓包也能核「移除后不再出现」）。 */
  const [lastRequest, setLastRequest] = useState<{ run: string; refs: string[]; attachments: string[]; keys: string[] }>({
    run: '',
    refs: [],
    attachments: [],
    keys: [],
  });
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  /** 这一次 run 的身份（AgentContext 冻结形状，答复件 §3.3）。切会话时用它判「迟到回包」。 */
  const [run, setRun] = useState<AgentContext | null>(null);
  /** 最近一次 run 的上下文：run 结束后仍然保留，供审计/探针回读（不吃 `run` 的实时语义）。 */
  const [lastContext, setLastContext] = useState<AgentContext | null>(null);
  const [lateDropped, setLateDropped] = useState(0);
  /** runId 的序号（单调递增）。 */
  const runSeq = useRef(0);
  /** CS3：这一回合的耗时（真测；0 = 还没测到，不编「已处理 0 秒」）。 */
  const startedAtRef = useRef(0);
  const [lastDurationMs, setLastDurationMs] = useState(0);
  /** 这一次 run 的原话（draft 回包不重复带 prompt；气泡要显示真实输入）。 */
  const [lastPrompt, setLastPrompt] = useState('');
  /** generation：同一面板实例里每次 run +1；runId 重用/回绕时靠它兜底。 */
  const generationRef = useRef(0);
  const runRef = useRef<AgentContext | null>(null);
  const projectIdRef = useRef(props.projectId);
  const activeIdRef = useRef('');

  useEffect(() => {
    projectIdRef.current = props.projectId;
  }, [props.projectId]);

  /* 输入框自适应：先归零再按 scrollHeight 长，超过上限就内部滚。
     为什么不用 CSS `field-sizing`：Chromium 版本差一截，而这里要能被量具逐像素核。 */
  useEffect(() => {
    const el = promptRef.current;
    if (el === null) return;
    el.style.height = 'auto';
    const line = 22;
    const max = 158;
    /* 边框与留白归输入壳；textarea 自身无边框/内边距，按22px行高取真实内容高度。 */
    const next = Math.min(Math.max(el.scrollHeight, line), max);
    el.style.height = `${String(next)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [prompt]);

  const projectOpen = props.projectId !== '';
  const busy = phase === 'generating' || phase === 'applying' || phase === 'rolling';
  /* 1:1 composer 占位要用**真实** Agent 名（来自名册），不写死 Codex。 */

  /**
   * 取消生成（R122 · M8-A / D08）：**先让服务端停这一 run，再断前端接收**。
   *
   * 顺序很重要：先 `POST /api/agent/runs/:runId/cancel`（服务端登记过的才停得掉），
   * 再 abort 本地 fetch。上一批只做了后半段 —— 请求断了，服务端的生成还在跑，
   * 跑完照样记回合（D08：turns 1→2）。
   *
   * 文案（R124 · M10：A 组取消 E2E 已在产品树全绿）：
   *   - 接通且真的取消了 → 「已取消」（不再带「后台可能仍完成」——那句话是路由没落地时的实话）；
   *   - 路由没接通（404/405）或取消失败 → 仍给诚实兜底：本地停了，服务端没确认。
   * 不动的：别的 run 不受影响（台账按 runId 精确匹配）、不改会话数据（取消≠回滚）。
   */
  const stopGeneration = (): void => {
    const current = runRef.current;
    if (current === null) return;
    const controller = abortRef.current;
    abortRef.current = null;
    /* 先把 runRef 清掉：即使 abort 引发了 catch，迟到判断也只会看到「已经不是当前 run」。 */
    runRef.current = null;
    setRun(null);
    setPhase('idle');
    /* 中性进行态：此刻只停了本地接收，还没拿到服务端回执 —— 不提前宣称「已取消」。 */
    setNotice('正在取消…');
    if (controller !== null) controller.abort();
    void (async () => {
      try {
        const out = await cancelAgentRun({
          runId: current.runId,
          projectId: current.projectId,
          ...(current.conversationId === '' ? {} : { sessionId: current.conversationId }),
        });
        if (out.ok === true) {
          setCancelRoute('wired');
          setCancelState(out.state);
          setNotice(
            out.cancelled
              ? '已取消'
              : `这次生成已经结束（${out.state === '' ? '未知' : out.state}），没有可取消的`,
          );
          return;
        }
        setCancelRoute('absent');
        setCancelState('local-only');
        setNotice(`本地已停止接收，后台可能仍完成（服务端取消接口未接通：HTTP ${String(out.status)}）`);
      } catch (error) {
        setCancelRoute('error');
        setCancelState('local-only');
        setNotice(`本地已停止接收，后台可能仍完成（取消失败：${viewServerError(error).message}）`);
      }
    })();
  };

  const TIMEOUT_ENV_TOKEN = 'OPENCUT_AGENT_SCENE_TIMEOUT_MS';
  const copyTimeoutToken = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(TIMEOUT_ENV_TOKEN);
      setTokenCopied(true);
    } catch {
      try {
        const area = document.createElement('textarea');
        area.value = TIMEOUT_ENV_TOKEN;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(area);
        if (ok) setTokenCopied(true);
      } catch {
        /* 剪贴板不可用：保持原文案，用户仍可手动选中复制。 */
      }
    }
  };

  /* Esc 等同「停止」：只在生成中绑定，避免抢走输入框里的 Esc。 */
  useEffect(() => {
    if (phase !== 'generating') return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      stopGeneration();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [phase]);

  /* Esc 等同「不允许」：权限提示打开时优先关它。 */
  useEffect(() => {
    if (!confirming) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setConfirming(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [confirming]);

  /* `+` 菜单：点面板外或按 Esc 关掉，焦点还给 `+`（不把焦点丢在已卸载的菜单项上）。 */
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (menuRef.current?.contains(target) === true) return;
      if (plusRef.current?.contains(target) === true) return;
      setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setMenuOpen(false);
      plusRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const generate = async (): Promise<void> => {
    if (!projectOpen || busy || !roster || !selection || !roster.providers.some((row) => row.available && row.id === selection.provider && row.models.some((m) => m.id === selection.model))) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const boundProject = props.projectId;
    /* ── R152（M16 · B1）：历史会话**只读** ──────────────────────────────
       产品没有 ACP resume（B03 才做），所以「在历史会话里发消息」不能把回合追加到
       原会话上 —— 那等于把只读说成续接。这里先建一条新会话，把这一条记到新 id 上，
       原会话一个回合都不加（判据：S1 2→2，新会话 0→1）。 */
    let boundSession = activeSession?.session.id ?? '';
    let openedFresh = false;
    /* R157（M18）：这次请求**实际用的**选择。切到新会话时会重算（新会话不继承旧会话的会话级选择）。 */
    let requestSelection: AgentSelection | null = selection;
    if (boundSession !== '' && historyOnly) {
      try {
        const made = await createAgentSession(boundProject);
        boundSession = made.session.id;
        openedFresh = true;
        setActiveSession({ session: made.session, turns: [] });
        /* 不等 effect：这次请求的归属判定读的是 ref，必须马上指向新会话。 */
        activeIdRef.current = made.session.id;
        setPendingSession(made.created ? made.session : null);
        rememberSession(boundProject, made.session.id);
        setHistoryOnly(false);
        /* 新会话没有任何条目 → 按 工程 > 全局 > 名册 走，绝不把旧会话的模型偷偷带过去。 */
        requestSelection = resolveChatModel(boundProject, boundSession, roster).selection;
        await refreshSessions();
      } catch (caught) {
        setError({ stage: 'generate', view: viewServerError(caught) });
        setPhase('idle');
        return;
      }
      if (controller.signal.aborted) {
        setPhase('idle');
        return;
      }
    }
    if (!selectedModelOf(roster, requestSelection)?.model) {
      setSelectionRejected('请先选择可用模型');
      return;
    }
    /* AgentContext：一份形状贯穿「面板 → 请求 → 回包判定」；不再另存 projectId/sessionId。 */
    const context: AgentContext = {
      projectId: boundProject,
      sequenceId: props.sequenceId === undefined || props.sequenceId === '' ? 'main' : props.sequenceId,
      conversationId: boundSession,
      agentId: requestSelection?.agent ?? '',
      providerId: requestSelection?.provider ?? '',
      modelId: requestSelection?.model ?? '',
      runId: `run-${String(++runSeq.current)}`,
      generation: ++generationRef.current,
    };
    runRef.current = context;
    setRun(context);
    setLastContext(context);
    startedAtRef.current = Date.now();
    setLastPrompt(prompt.trim());
    setLastDurationMs(0);
    setPhase('generating');
    setError(null);
    setTokenCopied(false);
    setNotice('');
    setDraft(null);
    setShaBefore('');
    setShaAfter('');
    setVisual('none');
    setIgnoredKeys([]);
    /* R122（M8-B）：引用与附件真的进请求。字段名沿用面板里的 `kind/identity/label`；
       附件把内容（base64 + sha256）一起带上 —— 只有名字就等于没给模型任何东西。 */
    const requestRefs = refs.map((row) => ({ kind: row.kind, identity: row.identity, label: row.label }));
    const requestAttachments = attachments.map((row) => ({
      name: row.name,
      kind: row.kind,
      bytes: row.bytes,
      ...(row.available ? { sha256: row.sha256, data: row.data } : {}),
    }));
    setLastRequest({
      run: context.runId,
      refs: requestRefs.map((row) => `${row.kind}:${row.identity}`),
      attachments: requestAttachments.map((row) => row.name),
      keys: [
        'project',
        'prompt',
        ...(boundSession === '' ? [] : ['session']),
        'agent',
        ...(selection?.model === null || selection?.model === undefined ? [] : ['model']),
        'run',
        ...(requestRefs.length === 0 ? [] : ['refs']),
        ...(requestAttachments.length === 0 ? [] : ['attachments']),
      ],
    });
    try {
      const created = await draftAgentSceneBound({
        projectId: boundProject,
        prompt: prompt.trim(),
        ...(boundSession === '' ? {} : { sessionId: boundSession }),
        selection: requestSelection,
        run: { runId: context.runId, generation: context.generation },
        refs: requestRefs,
        attachments: requestAttachments,
        signal: controller.signal,
      });
      /* ── LI-A36/A37：迟到回包与越界回包一律丢弃 ─────────────────────
         判据三条：① 这次 run 还是不是当前 run；② 工程有没有换；③ 会话有没有换。
         任何一条不成立，就不能把草稿写进现在这块屏幕 —— 那是串台。 */
      const current = runRef.current;
      const projectChanged = projectIdRef.current !== context.projectId;
      if (
        current === null ||
        current.runId !== context.runId ||
        current.generation !== context.generation ||
        projectChanged
      ) {
        setLateDropped((previous) => previous + 1);
        setPhase('idle');
        return;
      }
      if (context.conversationId !== activeIdRef.current) {
        setLateDropped((previous) => previous + 1);
        setPhase('idle');
        setNotice('这次生成属于另一个会话：草稿不显示在这里；回合已经记到原会话');
        await refreshSessions();
        return;
      }
      setSelectionApplied(created.selection ?? null);
      if (created.providerIsMock === false) void loadRoster();
      setSelectionRejected('');
      setConsumed(
        created.consumed === undefined || created.consumed === null
          ? null
          : {
              refs: created.consumed.refs.length,
              okRefs: created.consumed.refs.filter((row) => row.ok).length,
              attachments: created.consumed.attachments.length,
            },
      );
      /* R135（M11 · A）：把逐条解析结果落到 pill 上 —— 每一条都能回答
         「服务端读到的是什么、为什么没读到」。计数只是汇总，不是证据。 */
      if (created.consumed !== undefined && created.consumed !== null) {
        /** @type {Record<string, { ok: boolean, reason: string, sample: string, bytes: number, sha256: string }>} */
        const byRef: Record<string, { ok: boolean; reason: string; sample: string; bytes: number; sha256: string }> = {};
        for (const row of created.consumed.refs) {
          byRef[`${row.kind}:${row.identity}`] = {
            ok: row.ok === true,
            reason: typeof row.reason === 'string' ? row.reason : '',
            sample: typeof row.sample === 'string' ? row.sample : '',
            bytes: typeof row.bytes === 'number' ? row.bytes : 0,
            sha256: typeof row.sha256 === 'string' ? row.sha256 : '',
          };
        }
        setRefStatus(byRef);
      }
      setProviderEcho(
        created.providerEcho === undefined || created.providerEcho === null
          ? null
          : { refs: created.providerEcho.refs.length, attachments: created.providerEcho.attachments.length },
      );
      setDraft(created);
      setPhase('draft');
      /* 新建会话的分支已经在句首写了「记到新会话 X」—— 这里不再重复一遍。 */
      const where = openedFresh || created.sessionId === undefined || created.sessionId === null ? '' : ` · 已记进会话 ${String(created.sessionId).slice(0, 8)}`;
      const turnWarn = typeof created.sessionWarning === 'string' && created.sessionWarning !== '' ? `（${created.sessionWarning}）` : '';
      const freshNote = openedFresh ? `历史只读 · 未续接：这条已记到新会话 ${boundSession.slice(0, 8)}（原会话一个回合没加） · ` : '';
      setNotice(`${freshNote}草稿已生成 · ${String(created.ops.length)} 条 ops · 还没有写盘${where}${turnWarn}`);
      /* 回合已经在服务端落盘：本地把这一条补进消息区，省一次往返；同时刷列表。 */
      if (boundSession !== '' && created.turn !== undefined && created.turn !== null) {
        const turn = created.turn;
        setActiveSession((previous) => {
          if (previous === null || previous.session.id !== boundSession) return previous;
          return {
            session: { ...previous.session, turns: previous.session.turns + 1, updatedAt: turn.at },
            turns: [
              ...previous.turns,
              { id: turn.id, prompt: turn.prompt, draftId: created.draftId, state: turn.state, at: turn.at, steps: [] },
            ],
          };
        });
        void refreshSessions();
      }
    } catch (caught) {
      /* 取消不是失败：不落到 agent-error。**文案归 stopGeneration 管** ——
         这里再写一句会把它刚给的「已取消 / 正在取消…」冲掉。 */
      if (controller.signal.aborted) {
        setPhase('idle');
        return;
      }
      /* 服务端把这次 run 判成取消（另一个窗口点的停止 / 取消先到一步）。 */
      if (caught instanceof ApiError && caught.code === 'RUN_CANCELLED') {
        setPhase('idle');
        setCancelRoute('wired');
        setCancelState('cancelled');
        setNotice('已取消');
        return;
      }
      /* LI-A32：模型/能力被拒 → 明说，并保留用户选的那一项（不偷偷换模型/转 mock）。
         码表以答复件 §3.2 为准：MODEL_UNAVAILABLE / OPTION_UNSUPPORTED。 */
      const code = caught instanceof ApiError ? caught.code : '';
      if (
        code === 'MODEL_UNAVAILABLE' ||
        code === 'OPTION_UNSUPPORTED' ||
        code === 'PROVIDER_UNAVAILABLE' ||
        code === 'AGENT_NOT_WIRED' ||
        code === 'AGENT_UNSUPPORTED'
      ) {
        setSelectionRejected(viewServerError(caught).message);
        setPhase('idle');
        return;
      }
      setError({ stage: 'generate', view: viewServerError(caught) });
      setPhase('idle');
    } finally {
      if (startedAtRef.current > 0) {
        setLastDurationMs(Date.now() - startedAtRef.current);
        startedAtRef.current = 0;
      }
      if (abortRef.current === controller) abortRef.current = null;
      const current = runRef.current;
      if (current !== null && current.runId === context.runId) {
        runRef.current = null;
        setRun(null);
      }
    }
  };

  /** 权限提示：apply 先问一句，不允许就什么也不做。 */
  const requestApply = (): void => {
    if (draft === null || phase !== 'draft') return;
    setConfirming(true);
  };

  const applyConfirmed = async (): Promise<void> => {
    if (draft === null || phase !== 'draft') return;
    setPhase('applying');
    setError(null);
    setNotice('');
    try {
      /* CS3：应用 = 人工授权。先在用户点「允许」这一刻换一次性批准票（2 分钟、单次），
         再拿它写盘。ACP 工具票在这条路上不认，反过来批准票也不能当工具票。 */
      const approval = await approveAgentScene(draft.draftId);
      const token = typeof approval.approvalToken === 'string' ? approval.approvalToken : '';
      if (token === '' && approval.alreadyApplied !== true) {
        throw new ApiError('这份草稿没有可应用的批准票（可能已经应用过）', 409, 'APPLY_APPROVAL_MISSING', {});
      }
      const result = token === ''
        ? await applyAgentScene(draft.draftId, '')
        : await applyAgentScene(draft.draftId, token);
      setShaBefore(result.sha256Before ?? '');
      setShaAfter(result.sha256After);
      setPhase('applied');
      /* 写盘前先审一遍：这些键渲染端会不会读（BLK-R36-1 的兜底）。 */
      const audit = auditOverrideOps(draft.ops);
      setIgnoredKeys(audit.ignoredKeys);
      setVisual(audit.ignoredKeys.length > 0 ? 'unchanged' : 'renderable');
      if (result.alreadyApplied) {
        setNotice('alreadyApplied：这份草稿之前已经应用过，本次没有重复写盘。');
      } else if (audit.ignoredKeys.length > 0) {
        setNotice('已写入 film.html，但预览画面未变化');
      } else {
        setNotice(`已写盘 · 覆盖已生效（${String(audit.renderableEntries)} 处）`);
      }
      props.onApplied();
    } catch (caught) {
      setError({ stage: 'apply', view: viewServerError(caught) });
      setPhase('draft');
    }
  };

  const rollback = async (): Promise<void> => {
    if (draft === null || phase !== 'applied') return;
    setPhase('rolling');
    setError(null);
    setNotice('');
    try {
      const result = await rollbackAgentScene(draft.draftId);
      setShaAfter(result.sha256);
      setPhase('rolledback');
      setVisual('none');
      setIgnoredKeys([]);
      setNotice(`已回滚 · film.html 恢复到 ${result.sha256.slice(0, 8)}`);
      props.onApplied();
    } catch (caught) {
      setError({ stage: 'rollback', view: viewServerError(caught) });
      setPhase('applied');
    }
  };

  /* ── F08 会话列表（只加列表，不改对话逻辑）───────────────────────────
     数据全部来自服务端三端点；这里只管「列、建、点开」三件事。
     列表口径 `turns>0` 是服务端的，前端不再筛（筛一遍就会与条数判据对不上）。 */
  const [sessions, setSessions] = useState<AgentSessionRow[]>([]);
  const [sessionsBusy, setSessionsBusy] = useState(false);
  const [sessionsError, setSessionsError] = useState('');
  /** 新建成、但还没有回合的会话：服务端列表筛掉它，只在本地置顶显示（`data-pending`）。 */
  const [pendingSession, setPendingSession] = useState<AgentSessionRow | null>(null);
  const [activeSession, setActiveSession] = useState<{ session: AgentSessionRow; turns: AgentSessionTurn[] } | null>(null);
  /* R152（M16 · B1）：这条会话是**这次打开面板新建的**（可继续追加），还是从磁盘接回来的
     历史（只读）。历史会话里发送 → 落一条新会话，原会话一个回合都不加（没有 ACP resume）。 */
  const [historyOnly, setHistoryOnly] = useState(false);

  /* run 归属判定要读「当前会话」，但它是在异步回调里读的 —— 用 ref 拿最新值，
     不能闭包捕获渲染时的 activeSession（那会让判据永远停在发起时的旧值）。 */
  useEffect(() => {
    activeIdRef.current = activeSession?.session.id ?? '';
  }, [activeSession]);

  /* ── R157（M18）：**会话 > 工程 > 全局 > 名册** ─────────────────────────
     一处解析、四处读者（chip / 发送 / 面板量具 / 菜单说明）。存储变化只 bump epoch，
     真正的优先级只在 `resolveModelSelection` 里写一遍 —— 不在每个调用点各猜一次。 */
  const activeSessionId = activeSession?.session.id ?? '';
  useEffect(() => {
    const resolved = resolveChatModel(props.projectId, activeSessionId, fullRoster);
    setSelection(resolved.selection);
    setSelectionScope(resolved.scope);
  }, [props.projectId, activeSessionId, storeEpoch, fullRoster]);

  useEffect(() => {
    setSelectionApplied(null);
    setSelectionRejected('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.projectId, activeSessionId, storeEpoch]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onChanged = (): void => setStoreEpoch((value) => value + 1);
    window.addEventListener(SESSION_MODEL_EVENT, onChanged);
    window.addEventListener('storage', onChanged);
    return () => {
      window.removeEventListener(SESSION_MODEL_EVENT, onChanged);
      window.removeEventListener('storage', onChanged);
    };
  }, []);

  const refreshSessions = async (): Promise<void> => {
    if (props.projectId === '') {
      setSessions([]);
      setArchivedSessions([]);
      return;
    }
    try {
      /* R114：一次请求把归档也拿回来（`?archived=1`），前端按 `archived` 分成两段。
         分两次请求会让「归档 → 列表少一条」与「归档列表多一条」中间出现闪烁。 */
      const listed = await listAgentSessionsWithArchived(props.projectId);
      setSessions(listed.sessions.filter((row) => row.archived !== true));
      setArchivedSessions(listed.sessions.filter((row) => row.archived === true));
      setSessionsError('');
      /* 本地待建会话若已出现在服务端列表里（有回合了），撤掉占位行。 */
      setPendingSession((previous) => (previous !== null && listed.sessions.some((row) => row.id === previous.id) ? null : previous));
    } catch (caught) {
      setSessionsError(sessionErrorText(caught));
    }
  };

  /** 名册：真实 provider + 真实 Agent 探测。失败不编默认列表，只报错并可重试。 */
  const loadRoster = async (): Promise<void> => {
    setRosterBusy(true);
    try {
      const loaded = await fetchAgentRoster();
      rosterRef.current = loaded;
      setRoster(loaded);
      setRosterError('');
    } catch (caught) {
      /* R141（M13 · LI-A41）：失败时**把旧名册丢掉**。
         留着旧的会渲染出一份看起来正常的模型列表 —— 用户以为自己能选，
         实际请求会撞 MODEL_UNAVAILABLE。宁可只剩「加载失败 + 重试」。 */
      rosterRef.current = null;
      setRoster(null);
      setRosterError(sessionErrorText(caught));
    } finally {
      setRosterBusy(false);
    }
  };

  useEffect(() => {
    void loadRoster();
    const refreshed = (): void => { void loadRoster(); };
    window.addEventListener('opencut:agent-roster-refreshed', refreshed);
    return () => window.removeEventListener('opencut:agent-roster-refreshed', refreshed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 改名 / 置顶 / 归档（`archived:false` = 恢复）。成功后刷列表并同步当前标题。 */
  const patchSession = async (sessionId: string, patch: { title?: string; pinned?: boolean; archived?: boolean }): Promise<void> => {
    if (props.projectId === '') return;
    try {
      const result = await patchAgentSession(props.projectId, sessionId, patch);
      setSessionsError('');
      setActiveSession((previous) =>
        previous !== null && previous.session.id === sessionId ? { ...previous, session: result.session } : previous,
      );
      if (patch.archived === true) {
        /* R157（M18）：归档即清掉这条会话的模型条目 —— 恢复回来时按工程/全局回落，
           不把「归档期间又改了工程默认」的旧选择借尸还魂。 */
        forgetSessionModel(sessionId);
        setNotice('已归档：回合一条没删（会话级模型选择已清，恢复后按工程/全局回落）');
      } else if (patch.archived === false) {
        setNotice('已恢复：会话回到列表');
      } else if (patch.pinned !== undefined) {
        setNotice(patch.pinned ? '已置顶' : '已取消置顶');
      } else if (patch.title !== undefined) {
        setNotice(`已重命名为「${result.session.title === '' ? '未命名会话' : result.session.title}」`);
      }
      await refreshSessions();
    } catch (caught) {
      /* 409 SESSION_RUNNING：不是坏，是「现在不能」。给提示，不硬失败、不自动重试。 */
      const code = caught instanceof ApiError ? caught.code : '';
      if (code === 'SESSION_RUNNING') {
        setSessionsError('');
        setNotice('这条会话还在生成：等它跑完再归档（没有强制中断）');
        return;
      }
      setSessionsError(sessionErrorText(caught));
    }
  };

  useEffect(() => {
    void refreshSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.projectId]);

  /* ── A06（R102）：把上次的会话接回来 ────────────────────────────────
     面板关掉时组件被卸载（见文件顶部 SESSION_STORE_KEY 的说明），所以每次重新
     挂载都问一句「这个工程上次停在哪个会话」。每个工程只试一次；会话被删就
     静默回到「没选会话」—— 开面板不该因为一条陈旧记录弹红。 */
  const restoredFor = useRef('');
  useEffect(() => {
    const projectId = props.projectId;
    if (projectId === '' || restoredFor.current === projectId) return undefined;
    restoredFor.current = projectId;
    const remembered = readSessionStore()[projectId] ?? '';
    if (remembered === '') return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const opened = await getAgentSession(projectId, remembered);
        if (cancelled) return;
        setActiveSession({ session: opened.session, turns: opened.turns });
        setHistoryOnly(true);
        const title = opened.session.title === '' ? '未命名会话' : opened.session.title;
        /* R166（UI-V3-C · AGENT-05）：健康态提示只留一行，详细边界在会话头的 title 里。 */
        setNotice(`已接回「${title}」· ${String(opened.turns.length)} 回合 · 历史只读（下一条新建会话）`);
      } catch {
        /* 会话被删 / 工程已换：安静地当没记过。 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.projectId]);

  const openSession = async (sid: string): Promise<void> => {
    if (props.projectId === '' || sessionsBusy || sid === '') return;
    setSessionsBusy(true);
    setSessionsError('');
    try {
      const opened = await getAgentSession(props.projectId, sid);
      setActiveSession({ session: opened.session, turns: opened.turns });
      /* 从磁盘读回来的就是历史：只读、未续接（发送会新建会话）。 */
      setHistoryOnly(true);
      /* LI-A36：切会话就清掉上一条会话的草稿与引用 —— 草稿/附件不串会话。 */
      setDraft(null);
      setPhase('idle');
      setRefs([]);
      setIgnoredKeys([]);
      setVisual('none');
      /* A06：选了哪个会话就记哪个 —— 面板关掉再开能接回来。 */
      rememberSession(props.projectId, opened.session.id);
      setNotice(
        `已接上「${opened.session.title === '' ? '未命名会话' : opened.session.title}」· ${String(opened.turns.length)} 回合 · 历史只读（下一条新建会话）`,
      );
    } catch (caught) {
      setSessionsError(sessionErrorText(caught));
    } finally {
      setSessionsBusy(false);
    }
  };

  const newSession = async (): Promise<void> => {
    if (props.projectId === '' || sessionsBusy) return;
    setSessionsBusy(true);
    setSessionsError('');
    try {
      const made = await createAgentSession(props.projectId);
      await refreshSessions();
      setPendingSession(made.created ? made.session : null);
      setActiveSession({ session: made.session, turns: [] });
      setHistoryOnly(false);
      /* 新会话 = 干净上下文：草稿、引用、回读的选择都清掉。 */
      setDraft(null);
      setPhase('idle');
      setRefs([]);
      setIgnoredKeys([]);
      setVisual('none');
      /* A06：新建也算「当前会话」，同样记住。 */
      rememberSession(props.projectId, made.session.id);
      setNotice(made.created ? '已新建会话（还没有回合：列表只显示 turns>0，它是置顶的待用行）' : '已经有一个空会话，直接用它');
    } catch (caught) {
      setSessionsError(sessionErrorText(caught));
    } finally {
      setSessionsBusy(false);
    }
  };

  /* R114-B2：draft 回包的 provider 可能是对象（新）或字符串（老服务端/apply 回包）。 */
  const draftProviderId = agentProviderIdOf(draft?.provider);
  const draftCapabilities = agentCapabilitiesOf(draft?.provider);
  const providerLabel = draftProviderId === '' ? '' : `provider: ${draftProviderId}`;
  /* 实时 run 优先；结束后回落到最近一次（审计/探针用）。 */
  const shownContext: AgentContext | null = run ?? lastContext;
  const isMock = draft?.providerIsMock === true;
  /* R114：底部「模型」状态按**真实选择**写（来自 /api/agent/roster），不再从草稿猜。
     还没拿到名册时退回 provider 本身 —— 宁可少说，也不编一个型号。 */
  const pickedModel = selectedModelOf(roster, selection);
  /* 名册说真话：mock provider 才写 mock；配了外部 provider 时写「外部」，
     副标题也不再写「不调用真实模型」（那是 mock 才成立的承诺）。 */
  const providerIsMock = pickedModel === null ? draft?.providerIsMock !== false : pickedModel.provider.mock === true;
  /* 真实工具权限卡的唯一数据源：ACP 台账里的待答复请求。
     只在**真 provider 正在跑**时轮询；mock 不轮询、也不渲染任何权限卡。 */
  useEffect(() => {
    if (phase !== 'generating' || !projectOpen || providerIsMock) {
      setToolPermissions([]);
      return undefined;
    }
    let stopped = false;
    const tick = async (): Promise<void> => {
      try {
        const out = await fetchAcpPermissions(props.projectId);
        if (!stopped) setToolPermissions(Array.isArray(out.permissions) ? out.permissions : []);
      } catch {
        /* 轮询失败不清空已有卡：下一轮再试（错误不放大成「没有权限请求」）。 */
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 1000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [phase, projectOpen, providerIsMock, props.projectId]);

  /** 允许本次 / 拒绝 / 取消。过期或重复答复由服务端 409，这里只把卡撤掉并说明。 */
  const answerToolPermission = async (permission: AcpPermissionRow, decision: 'allow' | 'deny' | 'cancel'): Promise<void> => {
    setPermissionBusy(`${permission.id}:${decision}`);
    setPermissionNotice('');
    try {
      await answerAcpPermission(permission.id, {
        projectId: props.projectId,
        sessionId: permission.sessionId,
        decision,
      });
      setToolPermissions((previous) => previous.filter((row) => row.id !== permission.id));
      setPermissionNotice(decision === 'allow' ? '已允许本次（只这一次）' : decision === 'cancel' ? '已取消这次调用' : '已拒绝这次调用');
    } catch (caught) {
      const code = caught instanceof ApiError ? caught.code : '';
      if (code === 'PERMISSION_EXPIRED' || code === 'PERMISSION_ANSWERED') {
        setToolPermissions((previous) => previous.filter((row) => row.id !== permission.id));
      }
      setPermissionNotice(viewServerError(caught).message);
    } finally {
      setPermissionBusy('');
    }
  };
  const modelCode = pickedModel === null ? (selection?.provider ?? 'mock') : (selection?.model ?? selection?.provider ?? 'mock');
  const modelText =
    pickedModel === null
      ? (selection?.provider ?? 'mock')
      : pickedModel.model === null
        ? `${selection?.provider ?? ''}（该 provider 未声明模型）`
        : `${selection?.provider ?? ''} · ${pickedModel.model.id}`;
  const modelHint =
    pickedModel === null
      ? '还没有拿到模型名册（点底部那颗 chip 可重试）'
      : `Agent：${selection?.agent ?? ''} · provider：${pickedModel.provider.label} · 模型：${pickedModel.model?.label ?? '未声明'}${pickedModel.provider.mock ? '（项目内确定性 mock，不联网）' : ''}`;
  /* ── R170（M21）· 真实模型只读状态 ────────────────────────────────
     名册多了一段 `providerStatus`（服务端真探测：provider 是不是 mock、Key 配没配、
     本机装了哪些 CLI、还缺哪几步）。这里只**展示**：没有一次成功的真实调用，就写「未接通」。
     老服务端不发这一段 → 「状态未知」，不编。 */
  const providerStatus = roster?.providerStatus ?? null;
  const realModelText =
    providerStatus === null
      ? '状态未知'
      : providerStatus.state === 'CONNECTED' ? (providerStatus.realModelVerified ? '已连接 · 真实调用已验证' : '已连接 · 待首次调用') : providerStatus.state === 'MOCK'
        ? '未接通（mock）'
        : providerStatus.state === 'CONFIGURED_UNVERIFIED'
          ? '已配置·未验证'
          : providerStatus.state === 'DISABLED'
            ? '已关闭'
            : '未配置';
  const detectedAgentsText =
    providerStatus === null
      ? '未知'
      : providerStatus.agents.detected.length === 0
        ? '无（PATH 与常见安装位都没找到）'
        : providerStatus.agents.detected
            .map((row) => `${row.label}${row.version === '' ? '' : ` ${row.version}`}（${providerStatus.agents.wired.includes(row.id) ? '已连接' : '已安装'}）`)
            .join('、');
  const providerStatusRows: [string, string][] =
    providerStatus === null
      ? [
          ['场景 provider', '未知'],
          ['当前模型', '未知'],
          ['场景端点', '未知'],
          ['模型 Key', '未知'],
          ['检测到的 CLI', '未知'],
        ]
      : [
          ['场景 provider', `${providerStatus.provider.label}（${providerStatus.provider.id}）${providerStatus.provider.mock ? ' · mock' : ''}`],
          ['当前模型', providerStatus.model ?? '未声明'],
          ['场景端点', providerStatus.endpoint.configured ? (providerStatus.endpoint.host ?? '已配置') : '未配置'],
          ['模型 Key', providerStatus.modelKey.configured ? `已配置（尾 ${providerStatus.modelKey.tail ?? '****'}）` : '未配置'],
          ['检测到的 CLI', detectedAgentsText],
        ];

  /* S76：消息里的相对路径音频 → 可点播放条；`.png`/`.txt` 仍是纯文本。 */
  const audioOpts = { contentOrigin: props.contentOrigin, projectId: props.projectId };

  /* ── R118（L5）· 引用清单（LI-A35 / A42）────────────────────────────
     引用只进「输入框上方那一排 chip」：可以看见、可以移除。**不导入轨道**
     （导入仍走 `+` → 上传素材）—— 两件事混在一起，用户会以为聊天附件已经上了时间线。
     引用也不会被塞进 prompt：本版 provider 不读附件内容，假装模型看过是假消息。

     候选的拼装规则在 `agent-refs.ts`（纯函数，单测钉着）：这里只负责取数。
     六类来源全部是**真的**：工程/会话=面板状态；元素/片段=App 的 `__selectedTarget`
     与草稿 scope；素材=素材库接口；文件=工程文档里片段引用到的相对路径；
     Skill=名册里服务端真读到的目录名。 */
  const atInputs = {
    projectId: props.projectId,
    projectName: props.projectName,
    session: activeSession === null ? null : { id: activeSession.session.id, title: activeSession.session.title },
    selection: selectionNow,
    scopeClips: draft?.scope ?? [],
    assets: atAssets,
    files: atFiles,
    skills: (roster?.skills?.items ?? []).map((row) => row.id),
  };
  const atCandidates = collectRefs(atInputs);
  const atOverflow = refOverflowOf(atInputs);
  const skillsKnown = roster !== null && roster.skills !== undefined;
  const skillCount = atInputs.skills.length;

  /** 读当前所选目标（App 的唯一写入点 `writeTarget()` 会同步到 `__selectedTarget`）。 */
  const readSelection = (): void => {
    const debug = globalThis as unknown as { __selectedTarget?: unknown };
    setSelectionNow(selectionFromDebug(debug.__selectedTarget, props.projectId));
  };

  /**
   * 拉 `@` 的两类远端候选：素材库 + 工程文档里的文件。
   *
   * 失败**不吞**：`atError` 会显示在菜单里，并保留上一次成功的结果 —— 一次网络抖动
   * 不该把用户刚看到的清单清空，也不该让「读取失败」看起来像「这个工程没有素材」。
   */
  const loadAtSources = async (): Promise<void> => {
    if (props.projectId === '') return;
    setAtBusy(true);
    try {
      const [assets, doc] = await Promise.all([listAssets(props.projectId), getDoc(props.projectId)]);
      setAtAssets(
        (Array.isArray(assets) ? assets : []).map((asset) => ({ name: asset.name, path: asset.path ?? `assets/${asset.name}`, kind: String(asset.kind ?? '') })),
      );
      setAtFiles(filesOfDoc(doc.doc));
      setAtError('');
    } catch (caught) {
      setAtError(sessionErrorText(caught));
    } finally {
      setAtBusy(false);
    }
  };

  /** 打开 `@` 菜单：顺手刷新「当前选中」与远端候选（每次打开都重新读，不吃旧值）。 */
  const toggleAt = (): void => {
    const next = !atOpen;
    setAtOpen(next);
    if (!next) return;
    readSelection();
    void loadAtSources();
  };

  /* 工程换了：引用与附件一起清 —— 跨工程引用比不引用坏得多（草稿、附件同理）。
     R118（L5 · A37）：**当前会话也要清**。不清的话切到另一个工程后面板还挂着上一个
     工程的会话（同名会话看起来「没变」，其实 `data-session` 是旧工程的 id），
     那一屏的回合、草稿、引用全是别人的。清完让 A06 的「接回上次会话」按新工程重来。 */
  useEffect(() => {
    setRefs([]);
    setAttachments([]);
    setSelectionNow(null);
    setAtAssets([]);
    setAtFiles([]);
    setAtError('');
    setActiveSession(null);
    setPendingSession(null);
    setDraft(null);
    setPhase('idle');
    setIgnoredKeys([]);
    setVisual('none');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.projectId]);

  /**
   * 聊天附件：名字 + （读得动就）内容。**不上传、不落盘、不插轨道**。
   *
   * R124 · M10 的边界（全部在发请求**之前**判，别让服务端拿 400 当提示）：
   *   - 单个 > 512 KiB → 只有名字（`TOO_LARGE`）；
   *   - 本条消息合计 > 2 MiB → 超出的那几个只有名字（`BATCH_TOO_LARGE`）；
   *   - 超过 8 个 → 多出来的**不加**（名字也占数组位，全带上去必然 400），提示里说清。
   */
  const takeAttachments = (files: File[]): void => {
    if (files.length === 0) return;
    void (async () => {
      const picked: { name: string; bytes: number; kind: string; sha256: string; data: string; available: boolean; reason: string }[] = [];
      /* 预算按「已在清单里的 + 这次新加的」累计；只有带内容的才算字节。 */
      let used = attachments.reduce((sum, row) => sum + (row.available ? row.bytes : 0), 0);
      let slots = attachments.length;
      let dropped = 0;
      for (const file of files) {
        const base = {
          name: file.name,
          bytes: file.size,
          kind: file.type === '' ? (file.name.split('.').pop() ?? '').toLowerCase() : file.type,
        };
        if (slots >= MAX_ATTACHMENTS) {
          dropped += 1;
          continue;
        }
        slots += 1;
        if (file.size > MAX_ATTACHMENT_BYTES) {
          /* 读不动就不读：标 TOO_LARGE，chip 上写明「只有名字」。 */
          picked.push({ ...base, sha256: '', data: '', available: false, reason: 'TOO_LARGE' });
          continue;
        }
        if (used + file.size > MAX_ATTACHMENTS_TOTAL) {
          picked.push({ ...base, sha256: '', data: '', available: false, reason: 'BATCH_TOO_LARGE' });
          continue;
        }
        try {
          const buffer = await file.arrayBuffer();
          const digest = await crypto.subtle.digest('SHA-256', buffer);
          const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
          const bytes = new Uint8Array(buffer);
          let binary = '';
          for (let index = 0; index < bytes.length; index += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
          }
          picked.push({ ...base, sha256, data: btoa(binary), available: true, reason: '' });
          used += file.size;
        } catch {
          picked.push({ ...base, sha256: '', data: '', available: false, reason: 'UNREADABLE' });
        }
      }
      if (picked.length === 0) {
        if (dropped > 0) setNotice(`一条消息最多 ${String(MAX_ATTACHMENTS)} 个附件：这次 ${String(dropped)} 个没有加`);
        return;
      }
      setAttachments((previous) => {
        const merged = [...previous];
        for (const item of picked) {
          if (!merged.some((row) => row.name === item.name && row.bytes === item.bytes)) merged.push(item);
        }
        return merged;
      });
      const onlyName = picked.filter((row) => row.available !== true).length;
      const tooLarge = picked.filter((row) => row.reason === 'TOO_LARGE').length;
      const batch = picked.filter((row) => row.reason === 'BATCH_TOO_LARGE').length;
      const why =
        tooLarge > 0 && batch > 0
          ? `单个超 ${String(Math.round(MAX_ATTACHMENT_BYTES / 1024))} KiB 或本条合计超 ${String(Math.round(MAX_ATTACHMENTS_TOTAL / 1024 / 1024))} MiB`
          : tooLarge > 0
            ? `单个超 ${String(Math.round(MAX_ATTACHMENT_BYTES / 1024))} KiB`
            : `本条合计超 ${String(Math.round(MAX_ATTACHMENTS_TOTAL / 1024 / 1024))} MiB`;
      const tail = dropped > 0 ? `；最多 ${String(MAX_ATTACHMENTS)} 个，多出的 ${String(dropped)} 个没加` : '';
      setNotice(
        onlyName === 0
          ? `已附加 ${String(picked.length)} 个文件到聊天（内容随请求发给模型；不上传、不进时间线）${tail}`
          : `已附加 ${String(picked.length)} 个文件：其中 ${String(onlyName)} 个只有名字（${why}，内容不发给模型；不进时间线）${tail}`,
      );
    })();
  };

  /* @ 菜单：点外面 / Esc 关掉（与 `+` 同一套做法，焦点还给按钮）。 */
  useEffect(() => {
    if (!atOpen) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (atRef.current?.contains(target) === true) return;
      setAtOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      /* 捕获阶段吃掉：App 的 Esc 关整个面板（R118 · A42：Esc 只关最上面一层）。 */
      event.stopPropagation();
      setAtOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [atOpen]);

  /* ── U07（R102）：底部三段状态（附件 / 模型 / 权限）───────────────────
     只报事实，不做开关：附件有没有真入口、模型是不是 mock、写盘要不要先确认。
     **脸上只放短词**（232px 列宽下三段超过两行就成了噪音），完整解释放 `title`。 */
  const attachWired = typeof props.onPickMedia === 'function';
  const attachCode = !attachWired ? 'unwired' : projectOpen ? 'ready' : 'no-project';
  const attachText = !attachWired ? '未接' : projectOpen ? '可用' : '先开工程';
  const attachHint = !attachWired
    ? '未接：宿主没有提供选文件入口，`+` 菜单里的「上传素材」会置灰'
    : projectOpen
      ? '可用：`+` 菜单里的「上传素材」（复制进 assets/ 并插到播放头）'
      : '先打开一个工程，才能上传素材';
  const permissionCode = toolPermissions.length > 0
    ? 'tool-ask'
    : confirming
    ? 'confirming'
    : phase === 'generating'
      ? 'generating'
      : phase === 'applied'
        ? 'applied'
        : phase === 'rolledback'
          ? 'rolledback'
          : 'needs-confirm';
  const permissionText = toolPermissions.length > 0
    ? `等待授权 ${String(toolPermissions.length)}`
    : confirming
    ? '确认中'
    : phase === 'generating'
      ? '生成中可停'
      : phase === 'applied'
        ? '已写盘'
        : phase === 'rolledback'
          ? '已撤销'
          : '待确认';
  const permissionHint = toolPermissions.length > 0
    ? '真实 ACP 工具权限：允许本次 / 拒绝 / 取消；超时自动拒绝，过期答复不生效'
    : confirming
    ? '权限提示开着：允许后才写 film.html，不允许则保持原样（Esc 等同不允许）'
    : phase === 'generating'
      ? '生成中：Esc 或那颗停止键可以中止，取消不会写盘'
      : phase === 'applied'
        ? '已确认范围并写盘；这一步之后只能撤销（回到应用前）'
        : phase === 'rolledback'
          ? '已回滚到应用前的快照，film.html 没有本次改动'
          : '应用（写 film.html）之前会先问你一次范围，不允许就什么也不做';

  /* 顶部标题：会话有名字用名字；没有就用第一句原话（真实输入），都没有才显示「会话」。 */
  const activeTitleForBar = (() => {
    const raw = activeSession === null ? '' : activeSession.session.title.trim();
    if (raw !== '') return raw;
    const first = activeSession === null ? '' : (activeSession.turns[0]?.prompt ?? activeSession.turns.at(-1)?.prompt ?? '');
    const fallback = first === '' ? lastPrompt : first;
    return fallback.replace(/\s+/g, ' ').trim().slice(0, 60);
  })();
  const agentDisplayName = (() => {
    const id = selection?.agent ?? '';
    const row = (roster?.agents ?? []).find((item) => item.id === id);
    const label = typeof row?.label === 'string' ? row.label : id;
    const trimmed = label.replace(/（.*?）/g, '').replace(/\(.*?\)/g, '').trim();
    if (trimmed === '') return 'Agent';
    /* 只做显示层的大小写（codex → Codex），不改模型名、不冒充别的模型。 */
    return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
  })();

  const connectionDetails = h(
      'div',
      {
        className: 'agent-status chat-connection',
        'data-testid': 'agent-status',
        'data-attach': attachCode,
        'data-model': modelCode,
        'data-permission': permissionCode,
        'data-mock': providerIsMock ? 'true' : 'false',
      },
      h('strong', { className: 'chat-connection-heading' }, providerIsMock ? '模拟模式与生成说明' : '连接与生成说明'),
      h('div', { className: 'chat-connection-pop' },
      h('p', { className: 'chat-connection-help' }, '发送后先生成草稿，确认应用后写入工程，可撤销。'),
      h('span', { 'data-testid': 'agent-status-attach', title: attachHint }, `附件：${attachText}`),
      h('span', { 'data-testid': 'agent-status-model', title: modelHint }, `模型：${modelText}`),
      /* R170：真实模型可用性 —— 折叠面板，默认收起；内容全部只读。 */
      h(
        'details',
        { className: 'agent-provider-details', 'data-testid': 'agent-provider-details' },
        h(
          'summary',
          {
            'data-testid': 'agent-provider-status',
            'data-state': providerStatus?.state ?? 'UNKNOWN',
            'data-real-ready': providerStatus?.realModelReady === true ? 'true' : 'false',
            title: providerStatus === null ? '还没拿到名册（点模型 chip 可重试）' : providerStatus.missing.join('\n'),
          },
          `真实模型：${realModelText}`,
        ),
        h(
          'div',
          {
            className: 'agent-provider-pop',
            'data-testid': 'agent-provider-panel',
            role: 'group',
            'aria-label': '真实模型状态（只读）',
          },
          h('strong', { className: 'agent-provider-pop-title' }, '真实模型状态（只读）'),
          ...providerStatusRows.map(([key, value]) =>
            h(
              'div',
              { key, className: 'agent-provider-row' },
              h('span', { className: 'agent-provider-key' }, key),
              h('span', { className: 'agent-provider-val' }, value),
            ),
          ),
          h('div', { className: 'agent-provider-rows-title' }, '还缺：'),
          h(
            'ul',
            { className: 'agent-provider-missing' },
            (providerStatus?.missing ?? ['还没拿到名册']).map((line, index) => h('li', { key: String(index) }, line)),
          ),
          h(
            'p',
            { className: 'agent-provider-foot' },
            '只读：不写 Key、不切 provider；没有成功的真实调用，这里就不会显示「可用」。',
          ),
        ),
      ),
      h('span', { 'data-testid': 'agent-status-permission', title: permissionHint }, `权限：${permissionText}`),
      ),
    );

  return h(
    'aside',
    {
      className: 'agent-panel',
      'data-testid': 'agent-panel',
      'data-chat-ui': 'reference',
      /* 对话视觉独立作用域，沿用当前主题；不改变工作台列宽和业务状态。 */
      /* LI-A41：面板自己**不滚** —— 滚的是消息区。`.agent-panel` 在 styles.css 里是
         `overflow-y:auto`（判据文件归 MAIN），这里用内联覆盖成 hidden，配合下面
         `.agent-scroll` 的 `flex:1 1 0`，输入区才真的钉在底部。 */
      style: { overflow: 'hidden' },
      'data-phase': phase,
      'data-busy': busy ? 'true' : 'false',
      'data-provider': draftProviderId,
      'data-draft-id': draft?.draftId ?? '',
      'data-visual': visual,
      /* LI-A36/A37 的量具位：这次 run 绑的是哪条会话、丢掉了几个迟到/越界回包。 */
      /* `data-run-*` 是**实时**语义（会话栏靠它禁归档）；`data-context-*` 保留最近一次，
         供审计/探针在生成结束后回读同一份 AgentContext。 */
      'data-run-session': run === null ? '' : run.conversationId,
      'data-run-id': run === null ? '' : run.runId,
      'data-run-generation': run === null ? '' : String(run.generation),
      'data-context-project': shownContext === null ? '' : shownContext.projectId,
      'data-context-sequence': shownContext === null ? '' : shownContext.sequenceId,
      'data-context-conversation': shownContext === null ? '' : shownContext.conversationId,
      'data-context-agent': shownContext === null ? '' : shownContext.agentId,
      'data-context-provider': shownContext === null ? '' : shownContext.providerId,
      'data-context-model': shownContext === null ? '' : shownContext.modelId,
      'data-context-run': shownContext === null ? '' : shownContext.runId,
      'data-context-generation': shownContext === null ? '' : String(shownContext.generation),
      'data-draft-capabilities': draftCapabilities === null ? '' : JSON.stringify(draftCapabilities),
      'data-late-dropped': String(lateDropped),
      /* R118（L5）：引用 / 附件 / `@` 候选的量具位（探针不读文案也能核）。 */
      'data-refs-count': String(refs.length),
      'data-ref-kinds': refs.map((ref) => ref.kind).join(','),
      /* R135（M11 · A）：逐条状态。`unknown` = 还没发过请求（不是「失败」）。 */
      'data-refs-status': refs
        .map((ref) => {
          const row = refStatus[ref.id];
          return `${ref.kind}:${row === undefined ? 'unknown' : row.ok ? 'ok' : row.reason === '' ? 'failed' : row.reason}`;
        })
        .join(','),
      'data-refs-identities': refs.map((ref) => `${ref.kind}=${ref.identity}`).join('|'),
      'data-refs-ok': String(refs.filter((ref) => refStatus[ref.id]?.ok === true).length),
      'data-attach-count': String(attachments.length),
      /* R122（M8-A/B）量具位：取消走到哪一步、上一回请求带了什么、服务端/provider 各自看到什么。 */
      'data-cancel-route': cancelRoute,
      'data-cancel-state': cancelState,
      'data-request-run': lastRequest.run,
      'data-request-refs': lastRequest.refs.join(','),
      'data-request-attachments': lastRequest.attachments.join(','),
      'data-request-keys': lastRequest.keys.join(','),
      'data-consumed-refs': consumed === null ? '' : `${String(consumed.okRefs)}/${String(consumed.refs)}`,
      'data-consumed-attachments': consumed === null ? '' : String(consumed.attachments),
      'data-provider-echo': providerEcho === null ? '' : `${String(providerEcho.refs)}/${String(providerEcho.attachments)}`,
      'data-at-candidates': String(atCandidates.length),
      'data-at-error': atError,
      'data-skill-count': String(skillCount),
      /* 服务端回读的选择（响应里的 selection）：菜单关着也能量「选的真的进了请求」。 */
      'data-model-echo': selectionApplied?.model ?? '',
      'data-selection-rejected': selectionRejected,
      /* R141（M13 · LI-A41）：名册三态（loading/error/empty/ready）+ 当前选择，
         让「加载失败 ≠ 没有模型」「失败后不显示旧列表」都能被机器判。 */
      'data-roster-state':
        rosterBusy
          ? 'loading'
          : rosterError !== ''
            ? 'error'
            : roster === null
              ? 'idle'
              : roster.providers.length === 0 && roster.agents.length === 0
                ? 'empty'
                : 'ready',
      'data-model-selection':
        selection === null ? '' : `${selection.agent}|${selection.provider}|${selection.model ?? ''}`,
      /* R157（M18）：生效的 scope 与三级选择各自的读数（探针不读文案也能核）。 */
      'data-model-scope': selectionScope,
      'data-session-model': activeSessionId === '' ? '' : (readSessionModelStore()[activeSessionId]?.model ?? ''),
      'data-project-model': readModelStore()[props.projectId]?.model ?? '',
      'aria-label': 'Agent 原创场景',
    },
    /* ── CS3 · 1:1 对话面板：顶部只留「会话标题 + 箭头」+ 关闭 ─────────
       标题/菜单逻辑仍归 AgentSessionBar（原有 handler 与 testid 不动），
       这里只换容器与图标；provider/mock 说明移到消息区「技术细节」里。 */
    h(
      'div',
      { className: 'chat-head' },
      h(AgentSessionBar, {
        projectOpen,
        sessions,
        archived: archivedSessions,
        pending: pendingSession,
        activeId: activeSession === null ? '' : activeSession.session.id,
        activeTitle: activeTitleForBar,
        runningId: run === null ? '' : run.conversationId,
        busy: sessionsBusy,
        error: sessionsError,
        onRefresh: () => void refreshSessions(),
        onOpen: (sid: string) => void openSession(sid),
        onCreate: () => void newSession(),
        onPatch: (sid: string, patch: { title?: string; pinned?: boolean; archived?: boolean }) => void patchSession(sid, patch),
      }),
      h(
        'button',
        {
          type: 'button',
          className: 'chat-head-close',
          'data-testid': 'agent-close',
          'aria-label': '关闭对话面板',
          title: '关闭',
          onClick: () => {
            if (phase === 'generating') stopGeneration();
            setConfirming(false);
            props.onClose();
          },
        },
        ChatIcon('close', 14),
      ),
    ),

    /* ── U07-R2（R102 补正书 §1）：消息区独立滚动 ─────────────────────
       面板整体不再滚（`overflow-y:auto` 在 .agent-panel 上，CSS 归 MAIN）：这里让
       消息区吃满剩余高度并自己滚，头部与输入区就**钉住不动** —— 长对话不会把
       输入框顶出视口（补正书要的就是「消息区独立滚动，输入区固定底部」）。
       `minHeight:0` 是 flex 子项能真正溢出的前提，少它等于没写。 */
    h(
      'div',
      {
        className: 'agent-scroll',
        'data-testid': 'agent-scroll',
        /* `1 1 0` 不是 `1 1 auto`：basis auto 会按内容长高，然后由**面板**滚（输入区被带走）。
           basis 0 + minHeight 0 才是「消息区吃满剩余高度并自己滚」。 */
        style: { flex: '1 1 0', minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' },
      },
      /* ── R114（L3）：顶部会话栏 ─────────────────────────────────────
         当前会话标题 + 下拉（新建 / 按标题搜索 / 切换 / 重命名 / 置顶 / 归档可恢复）。
         组件自己管开合与搜索；这里只喂数据与动作 —— 父组件不复制一份列表状态。 */
        activeSession === null
          ? null
          : h(
              'div',
              { className: 'agent-session-body', 'data-testid': 'agent-session-body', 'data-session': activeSession.session.id,
                'data-resumed': 'false',
                'data-history-only': historyOnly ? 'true' : 'false',
                /* R118（L5）· 键盘顺序：消息区是**可聚焦的滚动区**（`tabIndex 0` + `role=log`），
                   这样 Tab 序列是「会话栏 → 消息 → 输入 → 模型 → 加号」，长对话也能用键盘滚。
                   没有这一行时滚动区不在 Tab 序列里，键盘用户只能跳到输入框（A42）。 */
                tabIndex: 0, role: 'log', 'aria-label': `会话消息：${activeSession.session.title === '' ? '未命名会话' : activeSession.session.title}`,
              },
              h(
                'div',
                { className: 'agent-session-body-head' },
                /* R166（UI-V3-C · AGENT-01/02）：标题**只在顶部会话栏出现一次**。
                   会话体是消息，不是第二份标题；这里只留回合数与只读说明。 */
                h('span', { 'data-testid': 'agent-session-turn-count' }, `${activeSession.turns.length} 回合`),
                /* R135（M11 · B2）：历史会话**只读、未续接** —— B03 之前不装成「接着聊」。
                   有回合的会话才叫历史；新会话不摆这句话（它本来就是从头开始）。 */
                historyOnly
                  ? h(
                      'span',
                      {
                        'data-testid': 'agent-session-readonly-note',
                        'data-resumed': 'false',
                        'data-history-only': 'true',
                        title: '历史会话只读：原会话的模型上下文没有续接（B03 才做），在这里发送会新建一条会话',
                        style: { fontSize: '9px', color: 'var(--text-mute)' },
                      },
                      '历史只读 · 未续接',
                    )
                  : activeSession.turns.length === 0
                    ? null
                    : h(
                        'span',
                        {
                          'data-testid': 'agent-session-live-note',
                          'data-resumed': 'false',
                          'data-history-only': 'false',
                          title: '这条会话是本次打开面板时新建的：发送会继续记到它上面',
                          style: { fontSize: '9px', color: 'var(--text-mute)' },
                        },
                        '本次新建 · 可继续追加',
                      ),
              ),
              activeSession.turns.length === 0 && draft === null
                ? h('p', { className: 'agent-session-empty', 'data-testid': 'agent-session-turns-empty' }, '这个会话还没有回合')
                : h(
                    'ol',
                    { className: 'agent-session-turns', 'data-testid': 'agent-session-turns' },
                    activeSession.turns
                      .filter((turn) => draft === null || turn.draftId !== draft.draftId)
                      .map((turn) =>
                      h(
                        'li',
                        { key: turn.id, className: 'agent-session-turn', 'data-turn': turn.id },
                        h(
                          'div',
                          { className: 'agent-session-turn-line' },
                          h('span', { className: 'agent-session-turn-prompt' }, turn.prompt),
                          h(
                            'span',
                            { className: 'agent-session-turn-meta', 'data-state': turn.state ?? '' },
                            `${turnStateText(turn.state ?? '')}${turn.at === null ? '' : ` · ${relativeTimeOf(turn.at)}`}`,
                          ),
                        ),
                        /* E2：步骤折叠成一行（没有 steps 字段的老回合不渲染这一行） */
                        h(TurnSteps, { steps: turn.steps ?? [] }),
                      ),
                    ),
                  ),
            ),

      projectOpen
        ? null
        : h(
            'div',
            { className: 'agent-blocked', 'data-testid': 'agent-blocked', role: 'status' },
            h('strong', null, '工程未打开'),
            h('p', null, '这里生成的是「当前工程」的场景草稿；先在左侧打开一个工程。'),
          ),

      /* ── U07（R102）：消息区空态 ──────────────────────────────────────
         面板是「消息在上、输入在下」的形状，空白期会剩一大片空洞。这里给一句
         定位（谁、在哪、点了会发生什么），不写「开始你的创作之旅」那种话；
         有会话或有草稿就撤掉，不占地方。 */
      /* 运行中：先把这句话作为右侧气泡放上去（和参考图一致），别让消息区空着。 */
      draft === null && phase === 'generating' && lastPrompt !== ''
        ? h(
            'div',
            { className: 'chat-pending', 'data-testid': 'agent-pending-turn' },
            h('div', { className: 'chat-user-row' }, h('div', { className: 'chat-bubble' }, lastPrompt)),
            h('div', { className: 'chat-meta' }, '正在处理'),
          )
        : null,

      draft === null && activeSession === null && projectOpen && phase !== 'generating'
        ? h(
            'div',
            {
              'data-testid': 'agent-empty',
              className: 'chat-empty-state',
              style: { display: 'flex', flexDirection: 'column', gap: '6px' },
            },
            /* R166（UI-V3-C · AGENT-02/AGENT-04）：空态只留**一句**，先说清身份——
               现在没有接真实模型。写盘边界收进下面的折叠说明，不占常驻版面。 */
            h(
              'p',
              { className: 'agent-hint chat-sr-only', 'data-testid': 'agent-empty-hint', style: { margin: 0 } },
              providerIsMock
                ? '项目内模拟：写一句想生成的场景，先出草稿。'
                : '写一句想生成的场景；生成只出草稿，不写盘。',
            ),
            h(
              'details',
              {
                className: 'agent-empty-help',
                hidden: true,
                'data-testid': 'agent-empty-help',
                /* 原生 details 默认 closed：技术说明不再常驻，但键盘/读屏都能打开。 */
                style: { fontSize: '10px', color: 'var(--text-mute)' },
              },
              h(
                'summary',
                { style: { cursor: 'pointer', fontSize: '10px', color: 'var(--text-mute)' } },
                '生成与应用说明',
              ),
              h(
                'p',
                { style: { margin: '4px 0 0', lineHeight: 1.5 } },
                '「生成草稿」只出草稿，不写 film.html；点「应用到工程」才会写盘（可撤销）。',
              ),
            ),
          )
        : null,

      /* ── 草稿区（provider 标注始终可见，只要拿到过草稿）────────────── */
      draft === null
        ? null
        : h(
            'div',
            { className: 'agent-draft', 'data-testid': 'agent-draft', 'data-tech': showTech ? 'true' : 'false' },
            /* 1:1：用户那句话是右侧气泡；处理耗时是下面那行灰字（真测，不编）。 */
            h(
              'div',
              { className: 'chat-user-row' },
              h('div', { className: 'chat-bubble', 'data-testid': 'agent-draft-prompt' }, lastPrompt),
            ),
            h(
              'div',
              { className: 'chat-meta', 'data-testid': 'agent-draft-meta', 'data-ms': String(lastDurationMs) },
              lastDurationMs > 0 ? `已处理 ${formatElapsed(lastDurationMs)}` : '已处理',
            ),
            h(
              'div',
              { className: 'agent-provider', 'data-testid': 'agent-provider', 'data-mock': isMock ? 'true' : 'false' },
              h('code', { 'data-testid': 'agent-provider-id' }, providerLabel),
              isMock ? h('span', { className: 'agent-mock-badge', 'data-testid': 'agent-provider-badge' }, 'mock') : null,
            ),
            isMock
              ? h(
                  'p',
                  { className: 'agent-mock-note', 'data-testid': 'agent-mock-note' },
                  '项目内的确定性 mock provider：同一句话 + 同一 seed 得到同一组 ops。不是真实模型生成的场景，也不会联网。',
                )
              : h('p', { className: 'agent-mock-note' }, '外部 provider 返回的草稿；本界面只负责展示与执行。'),
            h(
              'p',
              {
                className: 'agent-summary',
                'data-testid': 'agent-summary',
                /* R124 · M10：摘要来自 provider，可能是契约外的长串（无空格）——
                   面板只有 232 宽，不给换行机会就会把右缘顶出去（实测 1332 > 1293）。 */
                style: { overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' },
              },
              draft.summary === '' ? '（provider 没有给摘要）' : renderAudioText(draft.summary, audioOpts),
            ),
            Array.isArray(draft.warnings) && draft.warnings.length > 0
              ? h(
                  'div',
                  { className: 'agent-warn', 'data-testid': 'agent-warnings' },
                  ...draft.warnings.map((warning, index) =>
                    h('p', { key: String(index), className: 'agent-warn-line', 'data-testid': 'agent-warning' }, renderAudioText(String(warning), audioOpts)),
                  ),
                )
              : null,
            /* E09（R18）：步骤默认折叠成一行（参照「已处理 28s · 3 个步骤 ›」）。
               原生 <details> 默认 closed，点 summary 展开；`agent-ops` / `agent-op` 的
               testid 与节点一个没动 —— 只是被 details 收起，不是 display:none 删控件。 */
            h(
              'details',
              { className: 'agent-steps', 'data-testid': 'agent-steps' },
              h(
                'summary',
                { className: 'agent-steps-summary' },
                ChatIcon('chevron', 14),
                h('span', null, `${String(draft.ops.length)} 个步骤${draft.ops.length > 0 ? ` · ${summarizeOp(draft.ops[0])}` : ''}`),
              ),
              h(
                'ol',
                { className: 'agent-ops', 'data-testid': 'agent-ops' },
                ...draft.ops.map((op, index) =>
                  h(
                    'li',
                    { key: String(index), className: 'agent-op', 'data-testid': 'agent-op', 'data-op': String((op as any)?.op ?? '') },
                    h('span', { className: 'agent-op-kind' }, String((op as any)?.op ?? '?')),
                    h('span', { className: 'agent-op-text' }, summarizeOp(op)),
                  ),
                ),
              ),
            ),
            h(
              'div',
              { className: 'agent-raw-wrap' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'btn tiny',
                  'data-testid': 'agent-raw-toggle',
                  'aria-expanded': showRaw ? 'true' : 'false',
                  onClick: () => setShowRaw((previous) => !previous),
                },
                showRaw ? '收起原始 ops' : '展开原始 ops',
              ),
              showRaw
                ? h('pre', { className: 'agent-raw', 'data-testid': 'agent-raw' }, JSON.stringify(draft.ops, null, 2))
                : null,
            ),
            h(
              'div',
              { className: 'agent-sha' },
              h('span', null, '草稿基线 ', h('code', { 'data-testid': 'agent-base-hash' }, String(draft.baseHash ?? '').slice(0, 8) || '—')),
              shaAfter === '' ? null : h('span', null, '最新 ', h('code', { 'data-testid': 'agent-sha-now' }, shaAfter.slice(0, 8))),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'chat-tech-toggle',
                'data-testid': 'agent-tech-toggle',
                'aria-expanded': showTech ? 'true' : 'false',
                onClick: () => setShowTech((previous) => !previous),
              },
              showTech ? '收起技术细节' : '技术细节',
            ),
          ),

      /* ── 动作区：按钮随状态启用/禁用，不出现「已应用还能再应用」────── */
      h(
        'div',
        { className: 'agent-actions' },
        phase === 'applied' || phase === 'rolling'
          ? h(
              'button',
              { type: 'button', className: 'btn tiny danger', 'data-testid': 'agent-rollback', disabled: busy, onClick: () => void rollback() },
              phase === 'rolling' ? '回滚中…' : '撤销（回到应用前）',
            )
          : null,
        phase === 'rolledback'
          ? h(
              'button',
              { type: 'button', className: 'btn tiny primary', 'data-testid': 'agent-regenerate', disabled: busy, onClick: () => void generate() },
              '重新生成',
            )
          : null,
        phase === 'draft' || phase === 'applying'
          ? h(
              'button',
              { type: 'button', className: 'btn tiny primary', 'data-testid': 'agent-apply', disabled: busy, onClick: requestApply },
              phase === 'applying' ? '应用中…' : '应用到工程',
            )
          : null,
        phase === 'draft'
          ? h(
              'button',
              { type: 'button', className: 'btn tiny', 'data-testid': 'agent-discard', disabled: busy, onClick: () => { setDraft(null); setPhase('idle'); setNotice('草稿已丢弃（没有写盘）'); } },
              '丢弃草稿',
            )
          : null,
        phase === 'applied'
          ? h(
              'span',
              { className: 'agent-hint', 'data-testid': 'agent-applied-lock', 'data-visual': visual },
              visual === 'unchanged'
                ? '已写盘 · 画面未变化（只能撤销或关闭）'
                : '已应用：只能撤销或关闭，不能再次应用',
            )
          : null,
      ),

      /* 兜底警告：写盘成功但渲染端不认这些键，必须明说，不许让用户以为场景变了。 */
      visual === 'unchanged' && phase === 'applied'
        ? h(
            'div',
            { className: 'agent-visual-warn', 'data-testid': 'agent-visual-warning', 'data-ignored': ignoredKeys.join(',') , role: 'alert' },
            h('strong', null, '已写入 film.html，但预览画面未变化'),
            h(
              'p',
              null,
              '被忽略的键：',
              h('code', { 'data-testid': 'agent-ignored-keys' }, ignoredKeys.join(', ')),
            ),
            h(
              'p',
              { className: 'agent-visual-warn-hint' },
              '渲染端只认 t / style（对象）/ lock / s / r；provider 输出与它不一致时，写盘成功但画面不会动。',
            ),
          )
        : null,
      visual === 'renderable' && phase === 'applied'
        ? h('span', { className: 'agent-visual-ok', 'data-testid': 'agent-visual-badge', 'data-state': 'renderable' }, '已写盘 · 覆盖已生效')
        : null,

      /* R141（M13 · LI-A41）：模型被拒要说在**看得见的地方**（不只菜单里）。
         用户点了发送却什么都没发生，必须能读到「选的模型不可用」以及「没有偷偷换」——
         否则看起来就像卡住了，或者像已经用别的模型跑过了。 */
      selectionRejected === ''
        ? null
        : h(
            'div',
            {
              className: 'agent-notice',
              'data-testid': 'agent-model-rejected-line',
              role: 'alert',
              style: { color: 'var(--danger)' },
            },
            `模型没用上：${selectionRejected}（没有自动换模型，也没有转 mock）`,
          ),

      notice === ''
        ? null
        : h('div', { className: 'agent-notice', 'data-testid': 'agent-notice', title: notice, 'data-already': notice.startsWith('alreadyApplied') ? 'true' : 'false' },
            historyOnly && notice.startsWith('已接回') ? '历史会话 · 发送将新建对话' : notice.startsWith('已新建会话') ? '新对话已就绪' : notice),

      error === null
        ? null
        : h(
            'div',
            { className: 'agent-error', 'data-testid': 'agent-error', 'data-code': error.view.code, 'data-reason': error.view.reason, role: 'alert' },
            h('div', { className: 'agent-error-head' }, `失败（${error.stage}）· ${error.view.code}`),
            h('p', { className: 'agent-error-message', 'data-testid': 'agent-error-message' }, error.view.message),
            h('p', { className: 'agent-error-hint', 'data-testid': 'agent-error-hint' }, hintFor(error.stage, error.view)),
            error.view.reason === 'PROVIDER_TIMEOUT'
              ? h(
                  'div',
                  {
                    'data-testid': 'agent-error-token',
                    'data-token': TIMEOUT_ENV_TOKEN,
                    style: { display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-start', marginBottom: '8px' },
                  },
                  h(
                    'code',
                    {
                      style: {
                        display: 'block',
                        maxWidth: '100%',
                        padding: '4px 6px',
                        border: '1px solid var(--line)',
                        borderRadius: '5px',
                        background: 'var(--bg)',
                        color: 'var(--text)',
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                        fontSize: '10px',
                        lineHeight: 1.35,
                        whiteSpace: 'pre-wrap',
                        overflowWrap: 'anywhere',
                        wordBreak: 'break-all',
                      },
                    },
                    TIMEOUT_ENV_TOKEN,
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'btn tiny', 'data-testid': 'agent-error-copy', onClick: () => void copyTimeoutToken() },
                    tokenCopied ? '已复制' : '复制变量名',
                  ),
                )
              : null,
            h(
              'button',
              {
                type: 'button',
                className: 'btn tiny',
                'data-testid': 'agent-retry',
                disabled: busy,
                onClick: () => {
                  if (error.stage === 'rollback') void rollback();
                  else if (error.stage === 'apply') void applyConfirmed();
                  else void generate();
                },
              },
              '重试',
            ),
          ),
    ),

    /* ── CS3 · MAIN-CS3-AUTHZ：真实工具权限卡 ─────────────────────────────
       只由 ACP 台账的待答复请求驱动（`data-source='acp'`）。三个动作：
       允许本次 / 拒绝 / 取消；超时服务端一律拒绝，**迟到的答复不生效**。
       mock provider 不会产生记录，所以这里永远不会出现「假权限卡」。 */
    toolPermissions.length > 0
      ? h(
          'div',
          {
            className: 'chat-permission',
            'data-testid': 'agent-tool-permission',
            'data-permission-kind': 'acp-tool',
            'data-source': 'acp',
            role: 'alertdialog',
            'aria-label': '工具权限请求',
          },
          h('div', { className: 'chat-permission-head' }, `Agent 想要调用 ${String(toolPermissions.length)} 个工具`),
          toolPermissions.map((permission) => {
            const seconds = Math.max(0, Math.ceil((Date.parse(permission.expiresAt) - Date.now()) / 1000));
            const subject = permission.subject === null ? '' : `${permission.subject.server ?? ''}${permission.subject.tool === null ? '' : `.${permission.subject.tool}`}`;
            return h(
              'div',
              {
                key: permission.id,
                className: 'chat-permission-row',
                'data-permission-id': permission.id,
                'data-session': permission.sessionId,
                'data-tool': permission.subject?.tool ?? '',
              },
              h('div', { className: 'chat-permission-detail' }, permission.detail || subject || permission.kind),
              h(
                'div',
                { className: 'chat-permission-meta', 'data-expires-at': permission.expiresAt },
                `${subject === '' ? permission.kind : subject} · ${String(seconds)} 秒后自动拒绝`,
              ),
              h(
                'div',
                { className: 'chat-permission-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'btn tiny primary',
                    'data-testid': 'agent-tool-permission-allow',
                    disabled: permissionBusy !== '',
                    onClick: () => void answerToolPermission(permission, 'allow'),
                  },
                  '允许本次',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'btn tiny',
                    'data-testid': 'agent-tool-permission-deny',
                    disabled: permissionBusy !== '',
                    onClick: () => void answerToolPermission(permission, 'deny'),
                  },
                  '拒绝',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'btn tiny',
                    'data-testid': 'agent-tool-permission-cancel',
                    disabled: permissionBusy !== '',
                    onClick: () => void answerToolPermission(permission, 'cancel'),
                  },
                  '取消',
                ),
              ),
            );
          }),
        )
      : null,
    permissionNotice === ''
      ? null
      : h('p', { className: 'chat-permission-notice', 'data-testid': 'agent-tool-permission-notice' }, permissionNotice),

    /* ── U07（R102）：输入区沉到面板底部（消息在上、输入在下）────────────
       DOM 顺序也一起移到末尾：只改 CSS `order` 会让**焦点顺序**与视觉相反
       （键盘 Tab 从底部的输入框跳回上方的草稿按钮），那是真缺陷，不是风格。
       `marginTop:'auto'` 让内容不满一屏时贴底；内容长了就是正常跟随滚动。 */
    h(
      'div',
      {
        className: 'agent-input chat-composer',
        /* R122（M8-B · D01）：文字区与动作行**上下分开**，零交集。
           改前：动作行 `position:absolute` 浮在 textarea 右下角，三行中文的最后一行
           正好压在 chip 上（`panel-1280.png` 实拍）。改后：容器是纵向 flex，
           textarea 先占自己的高度，动作行在它下面 —— 高度随内容长，最多 5 行。 */
        style: { flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: '4px' },
      },
      /* 引用清单（有才占位）：可移除；下面那句说明「引用 ≠ 导入轨道」。 */
      refs.length === 0
        ? null
        : h(
            'div',
            {
              'data-testid': 'agent-refs',
              'aria-label': '本条消息的引用',
              style: { display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center', marginBottom: '4px' },
            },
            ...refs.map((ref, index) => {
              const resolved = refStatus[ref.id];
              const state = resolved === undefined ? 'unknown' : resolved.ok ? 'ok' : 'failed';
              return h(
                'span',
                {
                  key: ref.id,
                  'data-testid': `agent-ref-${String(index)}`,
                  'data-kind': ref.kind,
                  'data-ref-id': ref.id,
                  'data-identity': ref.identity,
                  'data-ref-state': state,
                  'data-ref-ok': resolved === undefined ? '' : resolved.ok ? 'true' : 'false',
                  'data-ref-reason': resolved === undefined ? '' : resolved.reason,
                  'data-ref-sample': resolved === undefined ? '' : resolved.sample.slice(0, 140),
                  'data-ref-bytes': resolved === undefined ? '' : String(resolved.bytes),
                  'data-ref-sha': resolved === undefined ? '' : resolved.sha256.slice(0, 12),
                  title:
                    resolved === undefined
                      ? ref.title
                      : resolved.ok
                        ? `${ref.title} · 服务端已解析${resolved.bytes > 0 ? `（${String(resolved.bytes)} 字节）` : ''}`
                        : `${ref.title} · 没读到：${resolved.reason === '' ? 'UNKNOWN' : resolved.reason}`,
                  style: {
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '3px',
                    maxWidth: '100%',
                    padding: '1px 2px 1px 6px',
                    border: `1px solid ${resolved !== undefined && !resolved.ok ? 'var(--danger, #c2564d)' : 'var(--line-soft)'}`,
                    borderRadius: '999px',
                    background: 'var(--panel-2)',
                    color: 'var(--text)',
                    fontSize: '9.5px',
                  },
                },
                /* 逐条状态徽标：没发过请求 = 空心圈（不是「失败」），失败 = `!reason`。 */
                h(
                  'span',
                  {
                    'data-testid': `agent-ref-state-${String(index)}`,
                    'aria-hidden': 'true',
                    title: resolved === undefined ? '还没发请求：暂无解析结果' : resolved.ok ? '服务端已解析' : `没读到：${resolved.reason}`,
                    style: { flex: '0 0 auto', color: resolved === undefined ? 'var(--text-mute)' : resolved.ok ? 'var(--ok, #4d9a6a)' : 'var(--danger, #c2564d)', fontSize: '9px' },
                  },
                  resolved === undefined ? '○' : resolved.ok ? '●' : '!',
                ),
                /* 标签里已经含目标身份（元素带 `@ 片段`，素材/文件带路径），
                   不再另起一行 —— 面板宽度只有 232，多一段就被截成省略号。 */
                h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, ref.label),
                h(
                  'button',
                  {
                    type: 'button',
                    'data-testid': `agent-ref-remove-${String(index)}`,
                    'data-ref-id': ref.id,
                    'aria-label': `移除引用 ${ref.label}`,
                    title: '移除这条引用',
                    style: { border: 0, background: 'transparent', color: 'var(--text-mute)', cursor: 'pointer', padding: '0 3px', fontSize: '11px', lineHeight: 1 },
                    onClick: () => setRefs((previous) => removeRef(previous, ref.id)),
                  },
                  '×',
                ),
              );
            }),
            h(
              'span',
              { 'data-testid': 'agent-refs-note', style: { fontSize: '9px', color: 'var(--text-mute)' } },
              '引用随请求交给模型（服务端已解析）；不导入轨道',
            ),
          ),
      /* 聊天附件（R118 · A35）：与「引用」分开一栏 —— 附件是文件，引用是对象；
         两者都**不进时间线**，但只有「上传素材」会写 assets/ 并插片段。 */
      attachments.length === 0
        ? null
        : h(
            'div',
            {
              'data-testid': 'agent-attachments',
              'aria-label': '聊天附件',
              style: { display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center', marginBottom: '4px' },
            },
            ...attachments.map((file, index) =>
              h(
                'span',
                {
                  key: `${file.name}:${String(file.bytes)}`,
                  'data-testid': `agent-attachment-${String(index)}`,
                  'data-name': file.name,
                  'data-bytes': String(file.bytes),
                  'data-available': file.available === true ? 'true' : 'false',
                  'data-reason': file.reason,
                  title:
                    file.available === true
                      ? `${file.name} · ${String(file.bytes)} 字节 · 内容随请求发给模型（不上传、不插轨道）`
                      : `${file.name} · ${String(file.bytes)} 字节 · ${
                          file.reason === 'BATCH_TOO_LARGE' ? '本条合计超过 2 MiB' : '太大，读不到内容'
                        }（只发名字）`,
                  style: {
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '3px',
                    maxWidth: '100%',
                    padding: '1px 2px 1px 6px',
                    border: '1px dashed var(--line-soft)',
                    borderRadius: '999px',
                    background: 'transparent',
                    color: 'var(--text-dim)',
                    fontSize: '9.5px',
                  },
                },
                h(
                  'span',
                  { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  `附件 · ${file.name}${
                    file.available === true ? '' : file.reason === 'BATCH_TOO_LARGE' ? '（只有名字·超出总量）' : '（只有名字）'
                  }`,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    'data-testid': `agent-attachment-remove-${String(index)}`,
                    'aria-label': `移除附件 ${file.name}`,
                    title: '移除这个附件（只在本地清单里，没有上传过）',
                    style: { border: 0, background: 'transparent', color: 'var(--text-mute)', cursor: 'pointer', padding: '0 3px', fontSize: '11px', lineHeight: 1 },
                    onClick: () => setAttachments((previous) => previous.filter((row) => row.name !== file.name || row.bytes !== file.bytes)),
                  },
                  '×',
                ),
              ),
            ),
            h(
              'span',
              { 'data-testid': 'agent-attachments-note', style: { fontSize: '9px', color: 'var(--text-mute)' } },
              '只随这条消息走（不上传、不落盘）；进时间线要走「上传素材」',
            ),
          ),
      /* 附件选择器：面板自己的隐藏 input。**不经过宿主** —— 因为这条路径不写盘、
         不碰 assets/，不需要 App 的 pickMedia（那条是「导入」，两件事分开）。 */
      h('input', {
        ref: attachInputRef,
        type: 'file',
        multiple: true,
        'data-testid': 'agent-attach-input',
        style: { display: 'none' },
        onChange: (event: { target: HTMLInputElement }) => {
          /* 先把 FileList **拷成数组**再清 value：`value=''` 会同步清空 FileList，
             直接传 FileList 进去会拿到空列表（实测：chip 一个都不出）。 */
          const picked = event.target.files === null ? [] : [...event.target.files];
          event.target.value = '';
          takeAttachments(picked);
        },
      }),
      h('div', { className: 'chat-input-shell' },
      h('textarea', {
        'data-testid': 'agent-prompt',
        ref: promptRef,
        rows: 1,
        /* U07-R2（R102）：`textarea` 没有 `width` 时会用**默认 cols=20 的固有宽（318px）**，
           在 232/264 的列里直接顶出面板右缘（实测 1440 下 1507 > 1440）——
           「发送/停止/模型/附件不截断」里最容易漏的就是输入框本身。
           只看 CSS 是查不出来的（`.agent-input textarea` 根本没写 width）；这里补 100%，
           高度与内边距不动 → E09 E3 / s198 D11 的「≤56」一字未改。 */
        /* 右侧不再留 150px：动作行已经在下面一行，文字可以用满整宽。
           高度由上面的 effect 按 scrollHeight 写（1..5 行），这里只给上下限与行高。 */
        style: { minHeight: '22px', maxHeight: '158px', overflowY: 'hidden' },
        value: prompt,
        disabled: busy || !projectOpen,
        placeholder: '说出你的剪辑想法',
        'aria-label': `和 ${agentDisplayName} 一起工作`,
        onChange: (event: { target: { value: string } }) => setPrompt(event.target.value),
      }),
        phase === 'generating'
          ? h(
              'button',
              {
                type: 'button',
                className: 'chat-send chat-stop',
                'data-testid': 'agent-stop',
                'aria-label': '停止生成',
                title: '停止生成（Esc）',
                onClick: stopGeneration,
              },
              ChatIcon('stop', 14),
            )
          : h(
              'button',
              {
                type: 'button',
                className: 'chat-send',
                'data-testid': 'agent-generate',
                disabled: busy || !projectOpen || prompt.trim() === '' || !selectedModelOf(roster, selection)?.model,
                title: '发送（只出草稿，不写 film.html）',
                'aria-label': '发送',
                onClick: () => void generate(),
              },
              h('span', { className: 'chat-send-icon', 'aria-hidden': 'true' }),
            ),
      ),
      /* E09（R18）：输入区回到「一行」——控件全部浮在输入框右下角，整块高度只剩 textarea
         的 52px（判据 ≤56）。**不是 display:none 藏控件** —— 这行只剩控件本身，一个没少。
         R35：按参照补齐「模型 chip + `+`」（原先这一行只有生成键 + 一句说明；说明与按钮
         title 重复，去掉它才腾出 chip 与 `+` 的位置，见交接 itemA）。 */
      h(
        'div',
        {
          className: 'agent-input-actions',
          /* R118（L5 · A42 菜单边界）：动作行撑满输入框宽（菜单以它为包含块，
             写死 248/216 会伸出 Agent 列被时间线截走指针）。
             R122（M8-B · D01）：改成**在流里**的一行（不再 absolute 浮在文字上）——
             模型在左、`+`/`@`/发送在右，文字与按钮零交集。 */
          style: {
            position: 'relative',
            left: 'auto',
            right: 'auto',
            bottom: 'auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '4px',
          },
        },
        /* 模型选择（R114 · LI-A32）：真下拉，数据来自 `/api/agent/roster`。
           选完进请求、服务端回读；不支持的思考/速度在菜单里是禁用行，不做假可选。 */
        h(AgentModelPicker, {
          roster,
          details: connectionDetails,
          onOpenSettings: () => window.dispatchEvent(new CustomEvent('opencut:open-settings', { detail: { section: 'agents' } })),
          rosterError,
          rosterBusy,
          selection,
          applied: selectionApplied,
          rejected: selectionRejected,
          disabled: busy || !projectOpen,
          /* R157（M18）：chip 是**会话级**写入口 —— 有活动会话就写会话键（只影响这条会话），
             没有会话才落到工程键。设置页写的是工程/全局，两边不互相覆盖。 */
          onSelect: (next: AgentSelection) => {
            setSelection(next);
            if (activeSessionId !== '') {
              rememberSessionModel(activeSessionId, next);
              setSelectionScope('session');
            } else {
              rememberModel(props.projectId, next);
              notifyModelChange('project', props.projectId);
              setSelectionScope('project');
            }
            setSelectionRejected('');
          },
          scope: selectionScope,
          sessionModel: activeSessionId === '' ? '' : (readSessionModelStore()[activeSessionId]?.model ?? ''),
          projectModel: readModelStore()[props.projectId]?.model ?? '',
          onClearSession: () => {
            if (activeSessionId === '') return;
            forgetSessionModel(activeSessionId);
            setStoreEpoch((value) => value + 1);
            setSelectionApplied(null);
            setNotice('已清掉这条会话的模型选择：回到工程/全局默认');
          },
          onReload: () => void loadRoster(),
        }),
        /* 右侧一组（R122 · D01）：`+` / `@` / 发送（或停止）贴右缘；模型 chip 留在左侧。 */
        h(
          'div',
          { className: 'agent-input-right' },



        /* `+`（E7）：22×22 图标钮。**两条路分开写**（R118 · LI-A35）：
           ① 附件到聊天 —— 只记名字，不上传、不插轨道；
           ② 上传素材 —— 既有导入入口（复制进 assets/ 并插到播放头）。 */
        h(
          'button',
          {
            type: 'button',
            className: 'btn icon agent-plus',
            'data-testid': 'agent-plus',
            'aria-haspopup': 'menu',
            'aria-expanded': menuOpen ? 'true' : 'false',
            'aria-label': '添加：附件到聊天 / 上传素材',
            title: '添加（附件只进聊天；要进时间线用「上传素材」）',
            disabled: busy || !projectOpen,
            ref: plusRef,
            onClick: () => setMenuOpen((previous) => !previous),
          },
          h('span', { className: 'chat-tool-asset chat-tool-add', 'aria-hidden': 'true' }),
        ),
        menuOpen
          ? h(
              'div',
              {
                className: 'agent-plus-menu',
                'data-testid': 'agent-plus-menu',
                role: 'menu',
                'aria-label': '添加',
                ref: menuRef,
                onKeyDown: moveMenuFocus,
              },
              h(
                'button',
                {
                  type: 'button',
                  role: 'menuitem',
                  className: 'agent-plus-item',
                  'data-testid': 'agent-plus-attach',
                  disabled: !projectOpen,
                  title: projectOpen ? '只把文件挂在这条聊天消息上：不上传、不复制、不插轨道' : '先打开一个工程',
                  onClick: () => {
                    setMenuOpen(false);
                    attachInputRef.current?.click();
                  },
                },
                h('span', { className: 'agent-plus-item-label' }, '附件到聊天'),
                h('span', { className: 'agent-plus-item-note' }, '不进时间线'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  role: 'menuitem',
                  className: 'agent-plus-item',
                  'data-testid': 'agent-plus-import',
                  disabled: typeof props.onPickMedia !== 'function',
                  title:
                    typeof props.onPickMedia === 'function'
                      ? '选一个文件：复制进 assets/ 并在播放头插入片段'
                      : '宿主没有提供选文件入口（onPickMedia 未接）',
                  onClick: () => {
                    setMenuOpen(false);
                    props.onPickMedia?.();
                  },
                },
                h('span', { className: 'agent-plus-item-label' }, '上传素材（导入轨道）'),
                h('span', { className: 'agent-plus-item-note' }, '图片 / 音频 / 视频'),
              ),
        /* 参考图有麦克风；本版**没有**语音入口，所以它是 disabled + 说明，
           不放一个点了没反应的假按钮。 */
        h(
          'button',
          {
            type: 'button',
            className: 'agent-plus-item chat-mic-menu',
            'data-testid': 'agent-mic',
            disabled: true,
            'aria-label': '语音输入（未接线）',
            title: '语音输入还没接线',
          },
          '语音输入（尚未接通）',
        ),
              h('p', { className: 'agent-plus-hint' }, '「附件到聊天」只随这条消息走；「上传素材」才写 assets/ 并插到播放头'),
            )
          : null,
        /* `@`（LI-A35 / A42）：引用当前所选元素 / 片段 / 素材 / 文件 / Skill / 工程 / 会话。
           只列**现在真的存在**的对象；读失败的类别说读失败，空的说空（两者不混）。 */
        h(
          'button',
          {
            type: 'button',
            className: 'btn icon agent-plus',
            'data-testid': 'agent-at',
            'aria-haspopup': 'menu',
            'aria-expanded': atOpen ? 'true' : 'false',
            'aria-label': '添加上下文：图层、片段、素材、文件、Skill',
            title: '添加上下文（@）：引用图层、片段、素材、文件或 Skill',
            disabled: busy || !projectOpen,
            onClick: toggleAt,
          },
          h('span', { className: 'chat-tool-asset chat-tool-context', 'aria-hidden': 'true' }),
        ),
        atOpen
          ? h(
              'div',
              {
                className: 'agent-at-menu',
                'data-testid': 'agent-at-menu',
                role: 'menu',
                'aria-label': '引用',
                ref: atRef,
                style: {
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: 'calc(100% + 4px)',
                  zIndex: 30,
                  /* 宽度跟输入框一致，不再写死 216：写死就会伸出 Agent 列（见上）。 */
                  width: 'auto',
                  maxHeight: '260px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '2px',
                  padding: '6px',
                  border: '1px solid var(--border-strong)',
                  borderRadius: '8px',
                  background: 'var(--panel-2)',
                  boxShadow: '0 8px 20px rgba(0, 0, 0, 0.45)',
                },
              },
              h('span', { style: { fontSize: '9px', color: 'var(--text-mute)' } }, '引用到本条消息（可移除）'),
              atBusy
                ? h('span', { 'data-testid': 'agent-at-loading', style: { fontSize: '9.5px', color: 'var(--text-mute)' } }, '正在读素材与文件…')
                : null,
              atError === ''
                ? null
                : h(
                    'p',
                    { 'data-testid': 'agent-at-error', role: 'status', style: { margin: 0, fontSize: '9.5px', color: 'var(--danger)' } },
                    `素材/文件没读到：${atError}（其它候选仍可引用）`,
                  ),
              skillsKnown && skillCount === 0 && roster?.skills?.available !== true
                ? h(
                    'p',
                    { 'data-testid': 'agent-at-skills-empty', style: { margin: 0, fontSize: '9.5px', color: 'var(--text-mute)' } },
                    `Skill：本机没有已安装的 Skill（${roster?.skills?.reason === 'NOT_INSTALLED' ? '目录还不存在' : String(roster?.skills?.reason ?? '未安装')}）`,
                  )
                : null,
              /* 列表滚动：候选可能几十条（素材 + 文件），菜单本身不能长过面板。 */
              h(
                'div',
                {
                  'data-testid': 'agent-at-list',
                  style: { display: 'flex', flexDirection: 'column', gap: '2px', overflowY: 'auto', minHeight: 0 },
                },
                atCandidates.length === 0
                  ? h('p', { 'data-testid': 'agent-at-empty', style: { margin: 0, fontSize: '9.5px', color: 'var(--text-mute)' } }, '现在没有可引用的对象')
                  : null,
                ...atCandidates.map((row, index) =>
                  h(
                    'button',
                    {
                      key: row.id,
                      type: 'button',
                      role: 'menuitem',
                      className: 'agent-plus-item',
                      /* 每类第一行沿用旧 testid（`agent-at-item-project` 这类老量具还在读），
                         同类第二行起带序号，免得 testid 撞成重复。 */
                      'data-testid': atCandidates.findIndex((item) => item.kind === row.kind) === index ? `agent-at-item-${row.kind}` : `agent-at-item-${row.kind}-${String(index)}`,
                      'data-ref-id': row.id,
                      'data-kind': row.kind,
                      title: row.title,
                      onClick: () => {
                        setRefs((previous) => addRef(previous, row));
                        setAtOpen(false);
                      },
                    },
                    h('span', { className: 'agent-plus-item-label', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.label),
                    h('span', { className: 'agent-plus-item-note' }, REF_KIND_LABEL[row.kind]),
                  ),
                ),
              ),
              atOverflow > 0
                ? h(
                    'span',
                    { 'data-testid': 'agent-at-overflow', style: { fontSize: '9px', color: 'var(--text-mute)' } },
                    `还有 ${String(atOverflow)} 条没列（菜单有高度上限）`,
                  )
                : null,
            )
          : null,


        ),
      ),
    ),

    /* ── F08 Tier 1：权限提示（范围确认）──────────────────────────────
       不新增路由：把 draft.scope / ops 条数摆出来，让用户「不允许 / 允许」。
       语义边界：这是范围确认，不是 agent 工具权限（那要 provider 的权限事件；
       真模型段仍 REAL_MODEL_REQUIRED）。Esc 等同不允许。 */
    confirming && draft !== null
      ? h(
          'div',
          { className: 'agent-permission-backdrop', 'data-testid': 'agent-permission-backdrop' },
          h(
            'div',
            {
              className: 'agent-permission',
              'data-testid': 'agent-permission',
              /* 这是**草稿应用**的范围确认，不是工具权限卡：两者 testid/kind 分开，
                 mock 草稿也不会被误读成「真实权限」。 */
              'data-permission-kind': 'draft-apply',
              'data-source': providerIsMock ? 'mock' : 'provider',
              role: 'alertdialog',
              'aria-modal': 'true',
              'aria-label': '确认应用草稿',
            },
            h('h3', { className: 'agent-permission-title' }, '应用这份草稿？'),
            h(
              'p',
              { className: 'agent-permission-body' },
              `将执行 ${String(draft.ops.length)} 条操作，涉及 ${String(draft.scope.length)} 个片段：${draft.scope.slice(0, 6).join('、')}${draft.scope.length > 6 ? '…' : ''}`,
            ),
            h('p', { className: 'agent-permission-hint' }, '允许后会写入 film.html；不允许则保持原样（Esc 等同不允许）。这是范围确认，不是工具权限。'),
            h(
              'div',
              { className: 'agent-permission-actions' },
              h(
                'button',
                { type: 'button', className: 'btn tiny', 'data-testid': 'agent-permission-deny', onClick: () => setConfirming(false) },
                '不允许',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'btn tiny primary',
                  'data-testid': 'agent-permission-allow',
                  onClick: () => {
                    setConfirming(false);
                    void applyConfirmed();
                  },
                },
                '允许',
              ),
            ),
          ),
        )
      : null,
  );
}
