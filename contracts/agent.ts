/**
 * Agent 会话合同 v1.0.0
 *
 * ACP 是一个协议，不是所有 Agent 的别名。每种 Agent 单独探测、单独验收。
 * 会话绑定工程 cwd；不同工程绝不共用会话或凭据。
 */

export type AgentId = string;

export type AgentState =
  | 'NOT_INSTALLED'
  | 'INSTALLED_NOT_LOGGED_IN'
  | 'PROBING'
  | 'READY'
  | 'BUSY'
  | 'DISCONNECTED'
  | 'INCOMPATIBLE'
  | 'UNVERIFIED';

export interface AgentDescriptor {
  readonly id: AgentId;
  readonly displayName: string;
  readonly version?: string;
  readonly state: AgentState;
  /** 认证状态只能由该 Agent 自己的探测得出；未知就是 UNVERIFIED，不许猜。 */
  readonly auth: 'UNKNOWN' | 'LOGGED_IN' | 'LOGGED_OUT';
  readonly capabilities: {
    readonly images: boolean;
    readonly resume: boolean;
    readonly steering: boolean;
    readonly permissions: boolean;
    readonly models: boolean;
  };
}

export type SessionEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thinking'; readonly text: string }
  | { readonly type: 'tool_start'; readonly id: string; readonly name: string; readonly input?: unknown }
  | { readonly type: 'tool_progress'; readonly id: string; readonly note?: string }
  | { readonly type: 'tool_end'; readonly id: string; readonly ok: boolean; readonly output?: unknown }
  | { readonly type: 'permission'; readonly id: string; readonly request: PermissionRequest }
  | { readonly type: 'turn_end'; readonly reason: 'done' | 'cancelled' | 'error'; readonly error?: string }
  | { readonly type: 'usage'; readonly inputTokens?: number; readonly outputTokens?: number; readonly cost?: number };

export interface PermissionRequest {
  readonly kind: 'fs_write' | 'fs_read' | 'shell' | 'network' | 'other';
  readonly detail: string;
  /** 默认拒绝；只有用户明确允许才放行。不得复制参考实现的 --allow-all/yolo。 */
  readonly default: 'deny';
}

export type AgentErrorCode =
  | 'ACP_HANDSHAKE_FAILED'
  | 'SESSION_BIND_FAILED'
  | 'AGENT_NOT_LOGGED_IN'
  | 'AGENT_INCOMPATIBLE'
  | 'TURN_TIMEOUT'
  | 'TURN_CANCELLED'
  | 'PERMISSION_DENIED'
  | 'PROCESS_DIED'
  | 'UNVERIFIED';

export interface AgentSessionApi {
  /** 只启动绑定了 projectId 的会话；复用已有会话前必须核对 cwd。 */
  open(projectId: string, agentId: AgentId, opts?: { readonly resume?: string }): Promise<{ sessionId: string } | { error: AgentErrorCode }>;
  send(sessionId: string, input: string, attachments?: readonly string[]): Promise<{ turnId: string } | { error: AgentErrorCode }>;
  cancel(sessionId: string, turnId: string): Promise<void>;
  /** 事件流；同一 turn 的事件必须有序，重载后可认领正在跑的轮次。 */
  events(sessionId: string): AsyncIterable<SessionEvent>;
  close(sessionId: string): Promise<void>;
  /** 只回收本线启动的进程；不得 kill 用户其他 Agent/Chrome。 */
  reap(projectId?: string): Promise<void>;
}

/** 安全边界：Agent 只能改工程目录内的文件；越界写入必须拒绝并留证据。 */
export interface AgentSandboxPolicy {
  readonly cwd: string;
  readonly allowWriteUnder: readonly string[];
  readonly denyWrite: readonly string[];   // 至少包含 .git、系统目录、其他工程
}
