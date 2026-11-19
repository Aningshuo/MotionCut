/**
 * 舞台协议合同 v1.0.0
 *
 * **画面与编辑器分 origin。** Studio 的写 API（`/api/projects/:id/ops` 等）在 Studio origin；
 * 影片内容（film.html + 场景页 + 素材）由 Studio 进程另起的内容 origin 提供。影片里的脚本
 * 因此拿不到编辑权限、preload、系统凭据，也不能用 `fetch` 调写接口（写接口还会校验 Origin）。
 *
 * Studio 界面（编辑 origin）与舞台页（内容 origin）只通过 `postMessage` 说话：
 *
 *   Studio → 舞台：StageCommand（`v` + `seq` + `op`）
 *   舞台 → Studio：StageUpdate（`v` + `seq` + `type`）
 *
 * 双方的硬要求：
 * - 收到消息先校验 `event.source` 是对方窗口、`event.origin` 是对方 origin（端口在运行时算，不写死）；
 * - 协议版本不匹配只报 `UNSUPPORTED`，不猜字段、不降级执行；
 * - 不认识的 `op` / `type` 忽略，且不回包；
 * - `seq` 由发起方单调递增；迟到的回包按 `seq` 丢弃，不覆盖新状态。
 *
 * 舞台页还必须实现 `frame.ts` 的 `SceneContract`（`window.film.ready()` / `window.film.frame(t)`），
 * 这样副线1 的取帧宿主与副线2 的渲染 worker 可以直接对同一张舞台页截图，不必再写第二套渲染内核。
 */

export const STAGE_PROTOCOL_VERSION = '1.0.0';

/** Studio → 舞台。`setTime` 只定位不改变播放状态；`setPlaying` 才起停。 */
export type StageOp = 'ping' | 'setTime' | 'setPlaying' | 'setRate' | 'setVolume' | 'requestFrame';

export interface StageCommand {
  readonly v: typeof STAGE_PROTOCOL_VERSION;
  readonly seq: number;
  readonly op: StageOp;
  /** `setTime` / `requestFrame` 的目标时间（秒，时间线坐标）。 */
  readonly t?: number;
  /** 仅用于 setTime 拖动中间帧。手势结束时发送普通 setTime 精确定位。 */
  readonly scrubbing?: boolean;
  /** `setPlaying`：true 播放，false 暂停。 */
  readonly playing?: boolean;
  /** `setRate`：播放倍率，1 为正常；0 非法。 */
  readonly rate?: number;
  /** `setVolume`：0–1，只影响预览，不写工程。 */
  readonly volume?: number;
}

export type StageErrorCode =
  | 'NO_FILM' // 舞台页没有实现 window.film
  | 'READY_TIMEOUT'
  | 'FRAME_TIMEOUT'
  | 'FRAME_THREW'
  | 'VIDEO_NOT_SHOWN' // seek 完成但画面始终没呈现（与 frame.ts 同码）
  | 'MEDIA_FAILED' // 素材 404 / 解码失败
  | 'UNSUPPORTED'; // 协议版本或 op 不认识

export interface StageState {
  readonly ready: boolean;
  /** 当前时间线时间（秒）。 */
  readonly t: number;
  /** 全片时长（秒）；未知时给 0，不编造。 */
  readonly duration: number;
  readonly playing: boolean;
  readonly rate: number;
  readonly volume: number;
}

export type StageUpdate =
  | {
      readonly v: typeof STAGE_PROTOCOL_VERSION;
      readonly seq: number;
      readonly type: 'state';
      readonly state: StageState;
    }
  | {
      readonly v: typeof STAGE_PROTOCOL_VERSION;
      readonly seq: number;
      readonly type: 'frame';
      /** 这一帧实际画出来的时间（可能被帧率对齐）。 */
      readonly t: number;
      readonly width: number;
      readonly height: number;
      /** 本帧是否所有素材都已就绪（false 时 Studio 必须显示「尚未就绪」，不能拿旧帧冒充）。 */
      readonly settled: boolean;
    }
  | {
      readonly v: typeof STAGE_PROTOCOL_VERSION;
      readonly seq: number;
      readonly type: 'error';
      readonly code: StageErrorCode;
      readonly message: string;
      readonly t?: number;
    };

/**
 * 舞台页的实现接口。`frame(t)` 必须可重复调用、不依赖上一次的残留状态；
 * `ready()` 在字体/图片/首帧素材就绪后 resolve，失败必须 reject。
 */
export interface StageHostApi {
  ready(timeoutMs?: number): Promise<void>;
  frame(t: number): Promise<void>;
  /** 全片时长；未知返回 0。 */
  duration(): number;
}
