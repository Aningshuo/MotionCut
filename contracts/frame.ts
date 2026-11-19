/**
 * 场景取帧合同 v1.0.0
 *
 * 目标：任意时刻 t 的完整画面由 t 唯一决定；顺序/倒序/重复/小数采样都成立。
 * 就绪判定必须「先看状态、再决定等不等」，且监听要在触发之前装好——否则 seeked 可能已经发生过。
 */

export type FrameErrorCode =
  | 'NO_FILM'            // 页面没有 window.film / film.frame
  | 'READY_TIMEOUT'      // film.ready 超时
  | 'RESOURCE_FAILED'    // 字体/图片/数据加载失败
  | 'FRAME_THREW'        // frame(t) 抛错
  | 'FRAME_TIMEOUT'      // frame(t) 未在预算内完成
  | 'VIDEO_NOT_SHOWN'    // 视频 seek 完成但画面始终没呈现（已知平台缺陷）
  | 'CANCELLED';         // 宿主主动取消

export interface FrameError {
  readonly code: FrameErrorCode;
  readonly message: string;
  readonly t?: number;
  /** 失败资源（相对工程根），用于诊断。 */
  readonly failedResources?: readonly string[];
}

export interface FrameRequest {
  readonly t: number;
  readonly timeoutMs?: number;      // 默认 60000
  readonly signal?: AbortSignal;    // 取消
}

export interface FrameResult {
  readonly t: number;
  /** PNG 字节；预览可要求缩略尺寸。 */
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** 本次是否为缓存命中（缓存键含源哈希 + t + 尺寸）。 */
  readonly cached: boolean;
}

/** 作者侧契约（写进我方场景模板与文档）。 */
export interface SceneContract {
  /** 资源全部就绪后 resolve；失败必须 reject，不允许永远 pending。 */
  ready(): Promise<void>;
  /** 画出 t 时刻的完整画面；可重复调用，不依赖上一次的残留状态。 */
  frame(t: number): Promise<void>;
  meta?: { readonly width: number; readonly height: number; readonly duration?: number };
}

/**
 * 宿主侧就绪算法（必须按此顺序）：
 * 1. 在调用 frame(t) 之前，先给页面上所有 <video> 装 seeked/loadeddata/rVFC 观察器并标记 `armed`。
 * 2. 调 filmHost.time(t)（受控时钟）→ await film.frame(t)。
 * 3. await filmHost.settle(t)（暂停/推进 Web Animations 到 t）。
 * 4. 对每个「页面确实移动过、且可见、且不是 NETWORK_EMPTY」的 video 判断：
 *    - 若 !seeking && readyState >= 2 且（无 rVFC 或已呈现）→ 立即完成，不等待任何事件；
 *    - 否则等 armed 观察器里的「已呈现」信号，或 3s 兜底。
 * 5. 双 rAF，等滤镜/3D 图层完成光栅化。
 * 6. 若所有 seek 都超时且画面全黑，抛 VIDEO_NOT_SHOWN，由上层换浏览器/兼容副本重试。
 *
 * 禁止：先 await frame(t) 再无条件等 seeked（事件可能已发生，或同 t 根本不发生 seek）。
 */
export interface FrameHostApi {
  ready(timeoutMs: number): Promise<void>;
  frame(req: FrameRequest): Promise<FrameResult>;
  /** 取消所有在途取帧，只影响本工程。 */
  cancel(projectId: string): void;
}
