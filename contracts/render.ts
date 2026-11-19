/**
 * 渲染作业合同 v1.0.0
 *
 * 一帧画面 = 场景 frame(t) + 合成 + 音轨。渲染必须消费与预览同一份 frame 合同与同一份时间映射，
 * 否则「预览对、导出错」。
 */

export type RenderErrorCode =
  | 'INVALID_RANGE'
  | 'CODEC_UNAVAILABLE'
  | 'ENOSPC'
  | 'CANCELLED'
  | 'WORKER_DIED'
  | 'FRAME_FAILED'
  | 'OUTPUT_UNVERIFIED'
  | 'AUDIO_MISSING'
  /** 音频解码/混音失败（素材坏了、滤镜链失败）：与画面 FRAME_FAILED 分开，方便用户换素材而不是查渲染器。 */
  | 'AUDIO_DECODE_FAILED'
  /** 工程在渲染开始后被改过（哈希不符）：拒绝或从头重来，不得拿半新半旧的帧拼一条片。 */
  | 'PROJECT_CHANGED';

/**
 * 单作业内的并行预算（**自动**，不是「只有手填才并行」）。
 *
 * 自动值 = min(CPU 可用核数 - 1, floor(可用内存 / 2 GiB), ceil(总帧数 / 120), 4)，下限 1。
 * `4` 只是参考自动默认上限；用户在设置里调大/调小时以用户值为准（`source` 记录来源）。
 * 同一 Studio 的**多作业**仍按队列一次一个；这里说的是一个作业内部的帧并行度，两者不是一回事。
 */
export interface RenderBudget {
  readonly source: 'auto' | 'user';
  readonly workers: number;
  /** 自动决策时看到的输入，便于诊断「为什么只给了 2 个 worker」。 */
  readonly basis?: {
    readonly cpu: number;
    readonly freeMemBytes: number;
    readonly frames: number;
  };
}

export interface RenderJobSpec {
  readonly jobId: string;
  readonly projectId: string;
  readonly owner: 'MAIN' | 'SUB1' | 'SUB2' | 'BRAIN';
  readonly kind: 'video' | 'gif' | 'audio' | 'stills' | 'project';
  /** 范围：`range` 与 `ranges` 二选一，1–100 段。 */
  readonly range?: readonly [number, number];
  readonly ranges?: readonly (readonly [number, number])[];
  readonly codec?: 'h264' | 'hevc' | 'vp9' | 'prores422hq' | 'prores4444' | 'hevc_alpha' | 'png';
  readonly frame?: string;         // native 或 W:H（1:4..4:1）
  readonly fill?: 'contain' | 'cover';
  readonly shortEdge?: number;     // 最大边 4096/8192 视出口而定，偶数
  readonly fps?: number;           // 有理换算，29.97 = 30000/1001
  readonly quality?: 'standard' | 'high' | 'master';
  readonly audio?: boolean;
  readonly loudness?: number;      // -70..-5 LUFS，true peak < -1 dBTP
  readonly outputDir: string;
  readonly expectedHash: string;   // 渲染开始时的工程哈希，变了就拒绝
  /** 缺省 = 自动预算（见 RenderBudget）；给了就是用户值，且要如实回显。 */
  readonly budget?: Readonly<{ workers?: number }>;
}

export interface RenderProgress {
  readonly jobId: string;
  readonly state: 'waiting' | 'running' | 'done' | 'failed' | 'cancelled';
  readonly stage?: string;
  readonly framesDone?: number;
  readonly framesTotal?: number;
  readonly fps?: number;
  readonly etaSec?: number;
  /** 这次实际用的并行度与来源，UI 要能显示「自动 3 / 手设 8」。 */
  readonly budget?: RenderBudget;
}

export interface RenderOutput {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  /** 由 ffprobe 读回：codec/尺寸/帧率/时长/音轨。不是「文件存在」就算成功。 */
  readonly probe: {
    readonly videoCodec?: string;
    readonly width?: number;
    readonly height?: number;
    readonly fps?: string;
    readonly durationSec?: number;
    readonly audioCodec?: string;
    readonly channels?: number;
    readonly sampleRate?: number;
  };
}

export interface RenderApi {
  enqueue(spec: RenderJobSpec): Promise<{ jobId: string } | { error: RenderErrorCode }>;
  progress(jobId: string): RenderProgress;
  cancel(jobId: string): Promise<void>;
  /** 只有 probe 通过、且完整 decode 无错，才返回 output。 */
  result(jobId: string): Promise<RenderOutput | { error: RenderErrorCode }>;
}

/** 输出不得覆盖旧文件；写隐藏 partial，完成后 rename。 */
export interface OutputPolicy {
  readonly noOverwrite: true;
  readonly partialSuffix: '.partial';
  readonly verify: 'ffprobe+decode';
}
