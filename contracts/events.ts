/**
 * Studio 事件通道合同 v1.1.0
 *
 * **UI 与 Studio 之间的唯一事件通道是 WebSocket**（`ws://127.0.0.1:<port>/events`）。
 * 理由不是偏好：一个工作台要开多个工程标签，每个标签一条长连接；SSE 在 HTTP/1.1 下会占满
 * 每域 6 条连接，标签一多就排队、断线重连还会互相顶掉。参考实现同样用 WebSocket。
 *
 * 与之无关的另一个面：**对外 HTTP API**（IF-HTTP-05）把核心事件映射成 SSE，是给外部调用方的，
 * 不是 UI 的事件总线，两者不要混为一谈，也不要拿「二选一」当理由把 UI 换成 SSE。
 *
 * 传输约束：
 * - 只绑 127.0.0.1，校验 Origin；
 * - 每条消息一个 envelope，`seq` 单调递增，断线可用 `since=seq` 补发（补不齐则发 `resync`）；
 * - 事件只是「发生了什么」的通知，**不是**权威数据：重连后一律以 `film.read` 的结果为准。
 */

export const EVENTS_CONTRACT_VERSION = '1.2.0';

export const EVENTS_PATH = '/events';

export type EventSource = 'person' | 'agent' | 'external' | 'system';

export type StudioEvent =
  /** 工程文件被替换（人工保存、Agent 写入、外部编辑器）。`sourceHash` 是新的修订号。 */
  | { readonly type: 'film.changed'; readonly projectId: string; readonly sourceHash: string; readonly by: EventSource }
  /**
   * 一批 Op（含撤销/重做）已经成功落盘。`hash` 是写入后的内容哈希；`changed=false` 表示同一
   * `opId` 重放、这次没有写盘。事件只是「该重取了」的通知：客户端仍以 `GET …/doc` 为准。
   */
  | {
      readonly type: 'doc.changed';
      readonly projectId: string;
      readonly hash: string;
      readonly changed: boolean;
      readonly by: EventSource;
      readonly opId: string;
    }
  /** 合并出现冲突：人工版与 Agent 版都在，需要人看。 */
  | {
      readonly type: 'film.conflict';
      readonly projectId: string;
      readonly sourceHash: string;
      readonly keptAside: string;   // 冲突副本路径（.film/conflicts/…）
      readonly keys: readonly string[];
    }
  /** 写被拒绝（CAS 不符 / 非法编辑）。 */
  | {
      readonly type: 'film.writeRejected';
      readonly projectId: string;
      readonly code: 'CONFLICT' | 'INVALID' | 'IO';
      readonly expectedHash?: string;
      readonly actualHash?: string;
    }
  /** 历史前进/回退。 */
  | { readonly type: 'history.moved'; readonly projectId: string; readonly version: string; readonly kind: 'commit' | 'restore' }
  /** 渲染作业进度（节流后推送，不是每帧一条）。 */
  | {
      readonly type: 'render.progress';
      readonly jobId: string;
      readonly state: 'waiting' | 'running' | 'done' | 'failed' | 'cancelled';
      readonly framesDone?: number;
      readonly framesTotal?: number;
      readonly workers?: number;
    }
  /** Agent 会话状态（授权、消息、结束）。 */
  | {
      readonly type: 'agent.update';
      readonly projectId: string;
      readonly agentId: string;
      readonly state: 'starting' | 'ready' | 'prompting' | 'permission' | 'idle' | 'ended' | 'failed';
      readonly detail?: string;
    }
  /** One-shot request from a live Agent turn to open another project's desktop tab. */
  | { readonly type: 'agent.projectOpen'; readonly projectId: string; readonly targetProjectId: string }
  /** 要求客户端全量刷新（补发不齐、或服务端重启）。 */
  | { readonly type: 'resync'; readonly reason: 'gap' | 'restart' };

export interface EventEnvelope {
  /** 单调递增；客户端用 `?since=<seq>` 续传。 */
  readonly seq: number;
  /** ISO-8601，带时区。 */
  readonly at: string;
  readonly event: StudioEvent;
}

/** 客户端 → 服务端：只允许订阅与心跳，不允许借事件通道发编辑（编辑走 HTTP，带 CAS）。 */
export type ClientMessage =
  | { readonly type: 'subscribe'; readonly since?: number }
  | { readonly type: 'ping' };

export interface EventsApi {
  /** 返回本次连接实际绑定的 URL（端口由 env.json 决定，不漂移）。 */
  url(): string;
  /** 广播一条事件；返回分配的 seq。 */
  publish(event: StudioEvent): number;
  close(): Promise<void>;
}
