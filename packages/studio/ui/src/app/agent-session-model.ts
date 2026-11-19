/**
 * R157（M18）：**会话级**模型选择 —— R2 的最后一条 scope（之前一直标 WAIT）。
 *
 * ## 四个 scope 与优先级
 *
 *   `会话`  >  `工程`  >  `全局默认`  >  `名册默认`
 *
 * | scope | 键 | 语义 | 谁写 |
 * |---|---|---|---|
 * | 会话 | `opencut.agent.session-model.v1`（按 sessionId 分表） | 这条会话里手选的模型，只影响它自己 | Agent chip |
 * | 工程 | `opencut.agent.model.v1`（按 projectId 分表） | 这个工程上次选的模型 | 设置页「设为该工程」 |
 * | 全局 | `opencut.agent.default.v1` | 这台 machine/profile 的默认（没自己选过的工程用它） | 设置页「设为全局默认」 |
 * | 名册 | `GET /api/agent/roster` 的 `defaults` | 谁都没选过时的兜底 | 服务端 |
 *
 * ## 三条诚实口径
 *
 * 1. **chip 写会话级、设置写工程级，互不覆盖**：chip 只在有活动会话时写会话键；
 *    设置页从不碰会话键（它的写入口是工程/全局）。
 * 2. **新会话回落**：新会话没有自己的条目 → 自然落到工程 → 全局 → 名册，不需要「复制一份」。
 * 3. **归档/删除不残留**：归档或删除一条会话时调 `forgetSessionModel`，把它的条目删掉；
 *    条目只按 sessionId 存，不按「上次用过的会话」缓存 —— 删掉的会话不会借尸还魂。
 *
 * 事件名与 M16 的 profile 合同**同一个字符串**（`opencut:agent-model-changed`）：设置页与
 * chip 是同一份存储的两个读者，谁写完都喊一声，另一处回读。常量名不同（`SESSION_MODEL_EVENT`）
 * 是为了不和 `agent-panel.ts` 里已有的同名常量在同一个模块里撞名。
 */

import type { AgentSelection } from './agent-api';

/**
 * 为什么不是派单建议的 `opencut.agent.session.v1`：
 * 那个键**已经被占了** —— `agent-panel.ts` 的 `SESSION_STORE_KEY` 用它存「工程 → 上次会话 id」
 * （一张字符串表）。往里写选择对象会把「接回上次会话」弄坏（R157 第 1 次跑就是这么红的：
 * 会话键里剩下 `{"<projectId>":"<sessionId>"}`）。所以会话级选择单独用 `session-model`。
 */
export const SESSION_MODEL_STORE_KEY = 'opencut.agent.session-model.v1';
export const DEFAULT_MODEL_STORE_KEY = 'opencut.agent.default.v1';
export const PROJECT_MODEL_STORE_KEY = 'opencut.agent.model.v1';
/** 与 M16 profile 合同共用的事件名（值一样，常量名不同以免撞名）。 */
export const SESSION_MODEL_EVENT = 'opencut:agent-model-changed';

export type ModelScope = 'session' | 'project' | 'global' | 'roster';

/** 只依赖 get/set（removeItem 可选）：探针可以塞一个内存实现进来。 */
export interface ModelStore {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem?: (key: string) => void;
}

function boxOf(store?: ModelStore | null): ModelStore | null {
  if (store !== undefined && store !== null) return store;
  return typeof localStorage === 'undefined' ? null : localStorage;
}

function selectionOf(value: unknown): AgentSelection | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const provider = typeof row.provider === 'string' ? row.provider : '';
  if (provider === '') return null;
  return {
    agent: typeof row.agent === 'string' ? row.agent : '',
    provider,
    model: typeof row.model === 'string' ? row.model : null,
    thinking: typeof row.thinking === 'string' ? row.thinking : null,
    speed: typeof row.speed === 'string' ? row.speed : null,
  };
}

/** 读「id → 选择」表。坏数据一律当空表（一条脏记录不该把面板打死）。 */
export function readSelectionMap(key: string, store?: ModelStore | null): Record<string, AgentSelection> {
  const box = boxOf(store);
  if (box === null) return {};
  try {
    const raw = box.getItem(key);
    if (raw === null || raw === '') return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, AgentSelection> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const picked = selectionOf(value);
      if (picked !== null) out[id] = picked;
    }
    return out;
  } catch {
    return {};
  }
}

export function readSessionModelStore(store?: ModelStore | null): Record<string, AgentSelection> {
  return readSelectionMap(SESSION_MODEL_STORE_KEY, store);
}

/** 全局默认（单条）。没有/坏数据 → null。 */
export function readGlobalDefault(store?: ModelStore | null): AgentSelection | null {
  const box = boxOf(store);
  if (box === null) return null;
  try {
    const raw = box.getItem(DEFAULT_MODEL_STORE_KEY);
    if (raw === null || raw === '') return null;
    return selectionOf(JSON.parse(raw));
  } catch {
    return null;
  }
}

function notify(scope: ModelScope, id: string): void {
  try {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    window.dispatchEvent(new CustomEvent(SESSION_MODEL_EVENT, { detail: { scope, projectId: id, sessionId: id } }));
  } catch {
    /* 广播失败不影响已写进去的值：下次打开面板照样从存储读。 */
  }
}

/** 记一条会话的选择。写不进去（隐私模式/配额满）就算了，不阻断发送。 */
export function rememberSessionModel(sessionId: string, selection: AgentSelection, store?: ModelStore | null): void {
  if (sessionId === '' || selection.provider === '') return;
  const box = boxOf(store);
  if (box === null) return;
  try {
    const map = readSessionModelStore(box);
    map[sessionId] = selection;
    box.setItem(SESSION_MODEL_STORE_KEY, JSON.stringify(map));
    notify('session', sessionId);
  } catch {
    /* 同上。 */
  }
}

/** 删一条会话的条目（归档/删除时调）。没有条目也算成功 —— 目标是「不残留」。 */
export function forgetSessionModel(sessionId: string, store?: ModelStore | null): void {
  if (sessionId === '') return;
  const box = boxOf(store);
  if (box === null) return;
  try {
    const map = readSessionModelStore(box);
    if (map[sessionId] === undefined) return;
    delete map[sessionId];
    if (typeof box.removeItem === 'function' && Object.keys(map).length === 0) box.removeItem(SESSION_MODEL_STORE_KEY);
    else box.setItem(SESSION_MODEL_STORE_KEY, JSON.stringify(map));
    notify('session', sessionId);
  } catch {
    /* 删不掉就删不掉：下次归档再试，不影响当前会话。 */
  }
}

/** 工程/全局这类「不是会话」的写入口也喊一声，让所有读者回读（lane 里的 rememberModel 不发事件）。 */
export function notifyModelChange(scope: Exclude<ModelScope, 'roster'>, id: string): void {
  notify(scope, id);
}

export interface ResolvedModel {
  selection: AgentSelection | null;
  scope: ModelScope;
  session: AgentSelection | null;
  project: AgentSelection | null;
  global: AgentSelection | null;
}

/**
 * 按 **会话 > 工程 > 全局 > 名册** 解析出一份「现在真的会进请求」的选择，
 * 并把每一级都带回来（界面要能说清「为什么是这个」）。
 */
export function resolveModelSelection(input: {
  sessionId: string;
  projectId: string;
  rosterDefaults: AgentSelection | null;
  store?: ModelStore | null;
}): ResolvedModel {
  const box = boxOf(input.store);
  const session = input.sessionId === '' ? null : (readSessionModelStore(box)[input.sessionId] ?? null);
  const project = input.projectId === '' ? null : (readSelectionMap(PROJECT_MODEL_STORE_KEY, box)[input.projectId] ?? null);
  const global = readGlobalDefault(box);
  if (session !== null) return { selection: session, scope: 'session', session, project, global };
  if (project !== null) return { selection: project, scope: 'project', session, project, global };
  if (global !== null) return { selection: global, scope: 'global', session, project, global };
  return { selection: input.rosterDefaults, scope: 'roster', session, project, global };
}
