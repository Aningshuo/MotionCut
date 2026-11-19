/**
 * Studio ↔ 舞台（内容 origin）的 postMessage 连接。
 *
 * 硬要求（contracts/stage.ts）：
 * - 收到消息先校验 `event.source === iframe.contentWindow`、`event.origin === contentOrigin`；
 * - 版本不符只报 `UNSUPPORTED`；不认识的 type 忽略；
 * - `seq` 由 Studio 单调递增，迟到的回包（seq 小于已见最大值）丢弃；
 * - 舞台自己发的 `seq:0` 状态/帧/错误是常态（播放推进），不能当成迟到回包。
 */

import { STAGE_PROTOCOL_VERSION, classifyStageMessage, isStaleSeq, makeStageCommand } from './stage-protocol.mjs';

export interface StageStateView {
  ready: boolean;
  t: number;
  duration: number;
  playing: boolean;
  rate: number;
  volume: number;
}

export type StageUpdate =
  | { type: 'state'; seq: number; state: StageStateView }
  | { type: 'frame'; seq: number; t: number; width: number; height: number; settled: boolean }
  | { type: 'error'; seq: number; code: string; message: string; t?: number }
  | { type: 'layer'; seq: number; clip: string; at: string; result: LayerReply }
  | { type: 'overrides'; seq: number; clip: string; ok: boolean; result: unknown }
  | { type: 'layers'; seq: number; clip: string; result: LayersReply }
  /** M32 实时电平（舞台主动事件，seq 0）：总线上量到的 L/R 峰值与有效值。 */
  | {
      type: 'levels';
      seq: number;
      levels: {
        peakL: number;
        peakR: number;
        rmsL: number;
        rmsR: number;
        t: number;
        playing: boolean;
        routed: boolean;
      };
    }
  | { type: 'body'; seq: number; phase: 'down' | 'move' | 'up' | 'cancel' | 'edit';
      clip: string; at: string; pointerId: number; pointerType: string; x: number; y: number;
      altKey: boolean; shiftKey: boolean; description: LayerReply | null; font: Record<string, string>;
      rect: { x: number; y: number; w: number; h: number } | null }
  /** M19 点击选层（舞台主动事件，seq 0）：舞台坐标下的命中结果。 */
  | {
      type: 'pick';
      seq: number;
      clip: string;
      at: string;
      rect: { x: number; y: number; w: number; h: number } | null;
      point: { x: number; y: number } | null;
      /**
       * S93：按下时是否按着 Shift。舞台（content origin）只上报按键状态，
       * 「换选还是加选」由宿主决定——选中是 UI 态，不是文档态。
       */
      shift: boolean;
    }
  /**
   * S93 按键转发（舞台主动事件，seq 0）：跨源 iframe 里的按键不冒泡到父文档，
   * 舞台只转 **Escape**（清空元素多选）——其它键不转，免得和全局快捷键打架。
   */
  | { type: 'key'; seq: number; key: string }
  /**
   * UI-V4-01 拖拽 seek（舞台主动事件，seq 0）：**只报比例**（0..1）。
   * 时长归宿主 —— 舞台不知道片长；宿主拿 `ratio × duration` 落播放头与时间码。
   * `phase:'move'` 由舞台按 rAF 合并（每帧最多一条），`'end'` 表示松手提交。
   */
  | { type: 'seek'; seq: number; ratio: number; phase: 'move' | 'end'; commit: boolean };

/** describe 的回答：与 packages/layers/describe.ts 的 describe 返回同形。 */
export interface LayerReply {
  ok: boolean;
  value?: unknown;
  error?: { code: string; message: string; at?: string };
}

export interface LayersReply {
  ok: boolean;
  layers?: Array<{ at: string; kind: string; name: string; depth?: number }>;
  error?: { code: string; message: string };
}

export interface StageHandle {
  readonly iframe: HTMLIFrameElement;
  readonly contentOrigin: string;
  /** 发一条 StageCommand；返回本次 seq（iframe 还没就绪时返回 null，不排队）。 */
  send(op: string, args?: Record<string, unknown>): number | null;
  /** 发一条命令并等它自己的回包（seq 相同的那条）。超时 reject。 */
  request(op: string, args: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  dispose(): void;
}

export interface AttachStageOptions {
  iframe: HTMLIFrameElement;
  contentOrigin: string;
  studioOrigin: string;
  onUpdate: (update: StageUpdate) => void;
}

/** @param {unknown} value */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/**
 * 把一条已通过 origin/source 校验的消息投影成渲染层用的 StageUpdate。
 * @param {Record<string, unknown>} message
 * @returns {StageUpdate|null}
 */
function toUpdate(message: Record<string, unknown>): StageUpdate | null {
  const seq = typeof message.seq === 'number' ? message.seq : 0;
  if (message.type === 'state') {
    const state = message.state;
    if (!isRecord(state)) return null;
    return {
      type: 'state',
      seq,
      state: {
        ready: state.ready === true,
        t: typeof state.t === 'number' ? state.t : 0,
        duration: typeof state.duration === 'number' ? state.duration : 0,
        playing: state.playing === true,
        rate: typeof state.rate === 'number' ? state.rate : 1,
        volume: typeof state.volume === 'number' ? state.volume : 1,
      },
    };
  }
  if (message.type === 'frame') {
    return {
      type: 'frame',
      seq,
      t: typeof message.t === 'number' ? message.t : 0,
      width: typeof message.width === 'number' ? message.width : 0,
      height: typeof message.height === 'number' ? message.height : 0,
      settled: message.settled === true,
    };
  }
  if (message.type === 'error') {
    return {
      type: 'error',
      seq,
      code: typeof message.code === 'string' ? message.code : 'UNSUPPORTED',
      message: typeof message.message === 'string' ? message.message : '',
      ...(typeof message.t === 'number' ? { t: message.t } : {}),
    };
  }
  if (message.type === 'layer') {
    const result = isRecord(message.result) ? message.result : { ok: false, error: { code: 'IO', message: '空回答' } };
    return {
      type: 'layer',
      seq,
      clip: typeof message.clip === 'string' ? message.clip : '',
      at: typeof message.at === 'string' ? message.at : '',
      result: result as unknown as LayerReply,
    };
  }
  if (message.type === 'overrides') {
    return {
      type: 'overrides',
      seq,
      clip: typeof message.clip === 'string' ? message.clip : '',
      ok: message.ok === true,
      result: message.result ?? null,
    };
  }
  if (message.type === 'layers') {
    const result = isRecord(message.result) ? message.result : { ok: false };
    return {
      type: 'layers',
      seq,
      clip: typeof message.clip === 'string' ? message.clip : '',
      result: result as unknown as LayersReply,
    };
  }
  if (message.type === 'levels') {
    const raw = isRecord(message.levels) ? message.levels : null;
    if (raw === null) return null;
    const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
    return {
      type: 'levels',
      seq,
      levels: {
        peakL: number(raw.peakL),
        peakR: number(raw.peakR),
        rmsL: number(raw.rmsL),
        rmsR: number(raw.rmsR),
        t: number(raw.t),
        playing: raw.playing === true,
        routed: raw.routed !== false,
      },
    };
  }
  if (message.type === 'pick' || message.type === 'body') {
    const rawRect = isRecord(message.rect) ? message.rect : null;
    const rect =
      rawRect !== null &&
      [rawRect.x, rawRect.y, rawRect.w, rawRect.h].every((value) => typeof value === 'number' && Number.isFinite(value))
        ? { x: rawRect.x as number, y: rawRect.y as number, w: rawRect.w as number, h: rawRect.h as number }
        : null;
    if (message.type === 'body') {
      const phase = message.phase;
      if (phase !== 'down' && phase !== 'move' && phase !== 'up' && phase !== 'cancel' && phase !== 'edit') return null;
      if (typeof message.clip !== 'string' || typeof message.at !== 'string' || typeof message.x !== 'number' || typeof message.y !== 'number' || !Number.isFinite(message.x) || !Number.isFinite(message.y)) return null;
      return { type: 'body', seq, phase, clip: message.clip, at: message.at, x: message.x, y: message.y,
        pointerId: typeof message.pointerId === 'number' ? message.pointerId : 0, pointerType: String(message.pointerType || 'mouse'),
        altKey: message.altKey === true, shiftKey: message.shiftKey === true, rect,
        font: isRecord(message.font) ? Object.fromEntries(Object.entries(message.font).filter((pair): pair is [string, string] => typeof pair[1] === 'string')) : {},
        description: isRecord(message.description) && message.description.ok === true ? { ok: true, value: message.description.value } : null };
    }
    const rawPoint = isRecord(message.point) ? message.point : null;
    const point =
      rawPoint !== null && typeof rawPoint.x === 'number' && typeof rawPoint.y === 'number'
        ? { x: rawPoint.x, y: rawPoint.y }
        : null;
    return {
      type: 'pick',
      seq,
      clip: typeof message.clip === 'string' ? message.clip : '',
      at: typeof message.at === 'string' ? message.at : '',
      rect,
      point,
      shift: message.shift === true,
    };
  }
  if (message.type === 'key') {
    return { type: 'key', seq, key: typeof message.key === 'string' ? message.key : '' };
  }
  if (message.type === 'seek') {
    const raw = typeof message.ratio === 'number' && Number.isFinite(message.ratio) ? message.ratio : 0;
    const ratio = raw < 0 ? 0 : raw > 1 ? 1 : raw;
    return {
      type: 'seek',
      seq,
      ratio,
      phase: message.phase === 'end' ? 'end' : 'move',
      commit: message.commit === true,
    };
  }
  return null;
}

/**
 * 命令序号**跨连接单调**：iframe 因 doc 变化重建时，新桥从 1 重来会被舞台当成迟到的旧命令丢弃。
 * 合同只要求发起方单调递增，全局计数满足这一点。
 */
let commandSeq = 0;

/**
 * 建立连接。调用方负责在 iframe 卸载时 `dispose()`。
 * @param {AttachStageOptions} options
 * @returns {StageHandle}
 */
export function attachStage(options: AttachStageOptions): StageHandle {
  const { iframe, contentOrigin, studioOrigin, onUpdate } = options;
  let lastSeen = 0;
  /** 一问一答的回包：seq → 等待者。舞台回包的 seq 就是我们发出去的那个。 */
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: number }>();

  /** @param {MessageEvent} event */
  const onMessage = (event: MessageEvent): void => {
    if (event.source !== iframe.contentWindow) return;
    if (event.origin !== contentOrigin) return;
    const classified = classifyStageMessage(event.data);
    if (classified.kind === 'ignore') return;
    if (classified.kind === 'unsupported') {
      onUpdate({
        type: 'error',
        seq: 0,
        code: 'UNSUPPORTED',
        message: `舞台协议版本不符：舞台 ${String(classified.version)}，Studio ${STAGE_PROTOCOL_VERSION}`,
      });
      return;
    }
    const message = /** @type {Record<string, unknown>} */ (classified.message);
    const replySeq = typeof message.seq === 'number' ? message.seq : 0;
    // 一问一答优先：它自带 seq，不能被下面的迟到判断吞掉。
    const waiting = replySeq > 0 ? pending.get(replySeq) : undefined;
    if (waiting !== undefined) {
      pending.delete(replySeq);
      globalThis.clearTimeout(waiting.timer);
      waiting.resolve(message);
      if (replySeq > lastSeen) lastSeen = replySeq;
      return;
    }
    if (replySeq > 0 && isStaleSeq(replySeq, lastSeen)) return;
    if (replySeq > lastSeen) lastSeen = replySeq;
    const update = toUpdate(message);
    if (update !== null) onUpdate(update);
  };

  const onLoad = (): void => {
    send('ping');
  };

  /** @param {string} op @param {Record<string, unknown>} [args] */
  function send(op: string, args: Record<string, unknown> = {}): number | null {
    const target = iframe.contentWindow;
    if (target === null) return null;
    commandSeq += 1;
    const seq = commandSeq;
    try {
      target.postMessage(makeStageCommand(seq, op, args), contentOrigin);
    } catch {
      return null;
    }
    return seq;
  }

  window.addEventListener('message', onMessage);
  iframe.addEventListener('load', onLoad);

  return {
    iframe,
    contentOrigin,
    send,
    request(op, args, timeoutMs = 6000) {
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const seq = send(op, args);
        if (seq === null) {
          reject(new Error(`舞台未就绪，发不出 ${op}`));
          return;
        }
        const timer = globalThis.setTimeout(() => {
          pending.delete(seq);
          reject(new Error(`舞台 ${op} 超时（${timeoutMs}ms）`));
        }, timeoutMs) as unknown as number;
        pending.set(seq, { resolve, reject, timer });
      });
    },
    dispose: () => {
      window.removeEventListener('message', onMessage);
      iframe.removeEventListener('load', onLoad);
      /* S92：**必须 reject**，不能只清定时器。iframe 因 hash 重建时，在途的 `describeLayer`
         如果只是被丢掉，它的 Promise 永远不 settle —— 调用方（面板提交后的 refreshMulti）
         会一直挂着，面板停在 idle、输入框不回填。实测：一次多选提交后 45s 都没返回。 */
      for (const [, waiting] of pending) {
        globalThis.clearTimeout(waiting.timer);
        waiting.reject(new Error('舞台已重建，在途请求作废'));
      }
      pending.clear();
    },
  };
}

/** @param {string} contentOrigin @param {string} projectId @param {string} studioOrigin @param {string} hash */
export function stageUrl(contentOrigin: string, projectId: string, studioOrigin: string, hash: string, initialTime = 0): string {
  const base = new URL(`/p/${encodeURIComponent(projectId)}/__stage__.html`, contentOrigin);
  base.searchParams.set('studio', studioOrigin);
  if (hash !== '') base.searchParams.set('v', hash.slice(0, 8));
  if (Number.isFinite(initialTime) && initialTime > 0) base.searchParams.set('start', String(initialTime));
  return base.toString();
}
