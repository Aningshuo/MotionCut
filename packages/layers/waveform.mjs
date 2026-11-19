/**
 * 波形：峰值提取与绘制（副线1 · S35-WAVEFORM，接口由大脑冻结）
 *
 * 目标：给时间线一条**按真实采样算出来的**波形，不是等宽竖条装饰。
 *
 * 三个设计口径，写在这里免得后面被改坏：
 *
 * 1. **不夹紧**。峰值是素材的客观属性：原始素材已经削波（或在有损编码里产生
 *    跨采样过冲）时，min/max 会超过 ±1，这里如实保留。要不要染色是**绘制**的事
 *    （`drawWaveform` 的 `overflowColor`），不是提取的事。夹紧会让「这段已经爆了」
 *    这个信息永久丢失。
 * 2. **立体声按通道合并**（min 取各通道最小、max 取各通道最大），不是只取第一声道。
 *    冻结接口只给了一对 min/max，合并是唯一不丢信息的做法：两声道反相时也能看见
 *    真实摆幅。通道数如实写进 `peaks.channels`。
 * 3. **缓存按 (src, samplesPerSecond) 分条目**，只缓存峰值、不缓存 `AudioBuffer`。
 *    1 小时 48k 立体声的 AudioBuffer 是 1.38GB 浮点，缓存它等于把内存吃干；
 *    峰值只要 2.9MB。换 `samplesPerSecond` 会重新解码一次——这是有意的取舍，
 *    见 `getWaveformCacheStats().decodes`。
 *
 * 错误不抛裸异常：`loadPeaks` 返回 `{ok:false, code, message, ...}`，
 * 调用方可以把返回值**直接**喂给 `drawWaveform`，它会画出「波形不可用」占位。
 */

/** 模块接口版本（加法式演进，字段名不改）。 */
export const WAVEFORM_VERSION = 1;

/** 错误码（稳定，不随文案变）。 */
export const WAVEFORM_ERROR_CODES = Object.freeze({
  INVALID_SRC: 'INVALID_SRC',
  LOAD_FAILED: 'LOAD_FAILED',
  UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
  DECODE_FAILED: 'DECODE_FAILED',
  ABORTED: 'ABORTED',
  NO_AUDIO_CONTEXT: 'NO_AUDIO_CONTEXT',
  BAD_PEAKS: 'BAD_PEAKS'
});

/**
 * 浏览器侧能解的容器/编码。列表外的扩展名**不下载就拒**——
 * 拖一个 .mov 进来时不该先下 2GB 再报错。
 */
const SUPPORTED_EXT = /\.(wav|wave|mp3|m4a|mp4|aac|ogg|oga|opus|flac|webm|weba)(?:[?#].*)?$/i;

/**
 * 桶边界用「时间 × 采样率」算，浮点会把 0.29s 算成 0.28999999999999998，直接 floor 就落到
 * 前一个桶。1e-6 个桶远小于一个采样点（48k / 100Hz = 480 点/桶），加它只为吃掉这点舍入噪声，
 * 不会把真实边界挪走。提取与绘制用**同一个** epsilon，两边才会落在同一个桶上。
 */
const BUCKET_EPSILON = 1e-6;

/** @type {Map<string, any>} */
const peakCache = new Map();
/** @type {Map<string, Promise<any>>} */
const inflight = new Map();
/** @type {{entries: number, hits: number, misses: number, coalesced: number, decodes: number, aborts: number, errors: number}} */
const stats = { entries: 0, hits: 0, misses: 0, coalesced: 0, decodes: 0, aborts: 0, errors: 0 };

/** @type {AudioContext | null} */
let audioCtx = null;

/**
 * 真实墙钟。`SceneHost` 会把 `performance.now` 定义成实例自有属性（虚拟时间恒 0），
 * 所以这里取原型上的那个；取不到再退回 `Date.now`。
 * @returns {number}
 */
function nowMs() {
  const proto = globalThis.Performance && globalThis.Performance.prototype;
  if (proto && typeof proto.now === 'function' && typeof performance !== 'undefined') {
    return proto.now.call(performance);
  }
  return Date.now();
}

/**
 * 懒建一个 AudioContext。只用来 `decodeAudioData`，不播放，所以不关心 suspended。
 * @returns {AudioContext}
 */
function context() {
  if (audioCtx) return audioCtx;
  const Ctor = globalThis.AudioContext ?? /** @type {any} */ (globalThis).webkitAudioContext;
  if (!Ctor) throw coded(WAVEFORM_ERROR_CODES.NO_AUDIO_CONTEXT, '当前环境没有 AudioContext');
  audioCtx = new Ctor();
  return audioCtx;
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {Error & {code: string}}
 */
function coded(code, message) {
  const err = /** @type {Error & {code: string}} */ (new Error(message));
  err.code = code;
  return err;
}

/**
 * @param {string} src
 * @param {string} code
 * @param {string} message
 * @param {number} [samplesPerSecond]
 */
function failure(src, code, message, samplesPerSecond) {
  return { ok: false, code, message, source: src, samplesPerSecond: samplesPerSecond ?? 0 };
}

/**
 * @param {number} value
 * @returns {number}
 */
function round1(value) {
  return Math.round(value * 10) / 10;
}

/** @param {any} value */
export function isWaveformError(value) {
  return !!value && typeof value === 'object' && value.ok === false && typeof value.code === 'string';
}

/**
 * 缓存统计。
 * @returns {{entries: number, hits: number, misses: number, bytes: number, decodes: number, coalesced: number, aborts: number, errors: number}}
 */
export function getWaveformCacheStats() {
  let bytes = 0;
  for (const peaks of peakCache.values()) bytes += peaks.min.byteLength + peaks.max.byteLength;
  return {
    entries: peakCache.size,
    hits: stats.hits,
    misses: stats.misses,
    bytes,
    /* 以下四个是加法字段：entries/hits/misses/bytes 四个冻结字段不动 */
    decodes: stats.decodes,
    coalesced: stats.coalesced,
    aborts: stats.aborts,
    errors: stats.errors
  };
}

/** 清空峰值缓存并重置计数（不动 AudioContext）。 */
export function clearWaveformCache() {
  peakCache.clear();
  inflight.clear();
  stats.entries = 0;
  stats.hits = 0;
  stats.misses = 0;
  stats.coalesced = 0;
  stats.decodes = 0;
  stats.aborts = 0;
  stats.errors = 0;
}

/**
 * 取峰值。同一 `src` + 同一 `samplesPerSecond` 第二次调用命中缓存且不重新解码。
 *
 * @param {string} src
 * @param {{signal?: AbortSignal, samplesPerSecond?: number}} [options]
 * @returns {Promise<any>}
 */
export async function loadPeaks(src, options = {}) {
  const samplesPerSecond = Number(options.samplesPerSecond ?? 100);
  const signal = options.signal;

  if (typeof src !== 'string' || src.trim() === '') {
    stats.errors += 1;
    return failure(String(src ?? ''), WAVEFORM_ERROR_CODES.INVALID_SRC, 'src 为空');
  }
  if (!Number.isFinite(samplesPerSecond) || samplesPerSecond <= 0) {
    stats.errors += 1;
    return failure(src, WAVEFORM_ERROR_CODES.INVALID_SRC, `samplesPerSecond 非法：${options.samplesPerSecond}`);
  }
  /* 只对「带扩展名且扩展名不认识」的 src 提前拒；无扩展名的 URL（服务端按 content-type 给）
     仍然尝试解码，失败再报 DECODE_FAILED。 */
  const pathPart = (src.split('?')[0] ?? '').split('#')[0] ?? '';
  const extMatch = /\.([A-Za-z0-9]+)$/.exec(pathPart);
  const ext = extMatch?.[1] ?? '';
  if (ext && !SUPPORTED_EXT.test(pathPart)) {
    stats.errors += 1;
    return failure(src, WAVEFORM_ERROR_CODES.UNSUPPORTED_FORMAT, `浏览器侧解不了 .${ext}（支持 wav/mp3/m4a/mp4/aac/ogg/opus/flac/webm）`, samplesPerSecond);
  }
  if (signal?.aborted) {
    stats.aborts += 1;
    return failure(src, WAVEFORM_ERROR_CODES.ABORTED, '在开始前已取消', samplesPerSecond);
  }

  const key = `${samplesPerSecond}|${src}`;
  const cached = peakCache.get(key);
  if (cached) {
    stats.hits += 1;
    return { ...cached, ok: true, cached: true };
  }

  const running = inflight.get(key);
  if (running) {
    stats.coalesced += 1;
    return running;
  }

  stats.misses += 1;
  const task = (async () => {
    const startedAt = nowMs();
    try {
      const buffer = await decode(src, signal);
      const decodedAt = nowMs();
      const peaks = computePeaks(buffer, samplesPerSecond, src);
      const finishedAt = nowMs();
      /* 分段耗时是**加法**字段（冻结形状里没有，但不影响任何已有字段）：
         1 小时素材上「解码」与「降采样」是两笔完全不同的账，不分开就只能看一个总数。 */
      const result = {
        ...peaks,
        ok: true,
        cached: false,
        timing: {
          loadMs: round1(finishedAt - startedAt),
          decodeMs: round1(decodedAt - startedAt),
          peaksMs: round1(finishedAt - decodedAt)
        }
      };
      peakCache.set(key, result);
      stats.entries = peakCache.size;
      return result;
    } catch (error) {
      stats.errors += 1;
      const err = /** @type {Error & {code?: string}} */ (error);
      if (err && err.name === 'AbortError') {
        stats.aborts += 1;
        return failure(src, WAVEFORM_ERROR_CODES.ABORTED, '已取消', samplesPerSecond);
      }
      const code = typeof err?.code === 'string' ? err.code : WAVEFORM_ERROR_CODES.DECODE_FAILED;
      return failure(src, code, String(err?.message ?? err), samplesPerSecond);
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}

/**
 * 下载 + 解码。返回的 `AudioBuffer` 只在本次调用里活着（不进缓存）。
 * @param {string} src
 * @param {AbortSignal} [signal]
 * @returns {Promise<AudioBuffer>}
 */
async function decode(src, signal) {
  let response;
  try {
    response = await fetch(src, signal ? { signal } : undefined);
  } catch (error) {
    const err = /** @type {any} */ (error);
    if (err && err.name === 'AbortError') throw err;
    throw coded(WAVEFORM_ERROR_CODES.LOAD_FAILED, `取不到素材：${String(err?.message ?? err)}`);
  }
  if (!response.ok) {
    throw coded(WAVEFORM_ERROR_CODES.LOAD_FAILED, `HTTP ${response.status} ${response.statusText || ''}`.trim());
  }
  const buf = await response.arrayBuffer();
  const ctx = context();
  stats.decodes += 1;
  try {
    /* decodeAudioData 会「拿走」这段 ArrayBuffer（detach），所以不能指望之后还能读它 */
    return await ctx.decodeAudioData(buf);
  } catch (error) {
    const err = /** @type {any} */ (error);
    const name = String(err?.name ?? '');
    const message = String(err?.message ?? err);
    /* Chromium 对「容器能打开但编码不认识」和「根本不是音频」给了不同名字，
       但对调用方来说都是「这份素材解不出波形」，统一 DECODE_FAILED，
       原因写在 message 里，不臆造更多码。 */
    throw coded(WAVEFORM_ERROR_CODES.DECODE_FAILED, name ? `${name}: ${message}` : message);
  }
}

/**
 * 分桶取 min/max（通道合并）。**不夹紧**。
 *
 * @param {AudioBuffer} buffer
 * @param {number} samplesPerSecond
 * @param {string} source
 */
export function computePeaks(buffer, samplesPerSecond, source) {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const sampleRate = buffer.sampleRate;
  const duration = buffer.duration;
  const length = Math.max(1, Math.round(duration * samplesPerSecond));

  const min = new Float32Array(length);
  const max = new Float32Array(length);
  /* 先填 ±Infinity 再收尾：空桶（理论上只在浮点四舍五入时出现）会变成 0，
     而不是留下一个 Infinity 把绘制搞崩。 */
  min.fill(Infinity);
  max.fill(-Infinity);

  const step = samplesPerSecond / sampleRate;
  for (let channel = 0; channel < channels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < frames; i += 1) {
      let bucket = Math.floor(i * step + BUCKET_EPSILON);
      if (bucket >= length) bucket = length - 1;
      const value = data[i] ?? 0;
      if (value < (min[bucket] ?? Infinity)) min[bucket] = value;
      if (value > (max[bucket] ?? -Infinity)) max[bucket] = value;
    }
  }
  for (let i = 0; i < length; i += 1) {
    if (min[i] === Infinity) min[i] = 0;
    if (max[i] === -Infinity) max[i] = 0;
  }
  /* ↑ 这两行只是兜底：`noUncheckedIndexedAccess` 下 Float32Array 的下标是 number|undefined，
     上面拿到的值一定存在（i < length），断言掉类型噪音。 */

  return { min, max, length, samplesPerSecond, duration, sampleRate, channels, source };
}

/**
 * 取一段子区间的峰值（时间单位秒），用于裁剪/变速后只画可见部分。
 *
 * 与 `drawWaveform` 内部用的是同一套分桶口径，所以「先切再画」与「画时切」一致。
 *
 * @param {any} peaks
 * @param {number} clipStart
 * @param {number} clipEnd
 */
export function slicePeaks(peaks, clipStart, clipEnd) {
  if (!peaks || !peaks.min || !peaks.max) return { min: new Float32Array(0), max: new Float32Array(0), length: 0 };
  const sps = peaks.samplesPerSecond;
  const first = Math.max(0, Math.min(peaks.length, Math.round(clipStart * sps)));
  const last = Math.max(first, Math.min(peaks.length, Math.round(clipEnd * sps)));
  return {
    min: peaks.min.subarray(first, last),
    max: peaks.max.subarray(first, last),
    length: last - first,
    startIndex: first,
    samplesPerSecond: sps
  };
}

/**
 * 画波形。
 *
 * `ctx` 假定对应 `width × dpr` 与 `height × dpr` 的画布，且**没有**预先设过 transform
 * （本函数自己 `setTransform(dpr, 0, 0, dpr, 0, 0)` 后按 CSS 像素作画）。
 *
 * 三种音量语义：
 * - `muted` 或 `volume === 0` → 居中平线（不是空白：用户要看见「这条轨还在」）；
 * - `0 < volume < 1` → 波形按比例内缩；
 * - `volume > 1` → 超出 ±1 的部分在画布上下边缘用 `overflowColor` 画一条帽带。
 *   1.0 永远映射到半高，所以超满幅不会被「画到画布外」而看不见。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {any} peaks `loadPeaks` 的返回值，或 `{ok:false, code}`（画占位）
 * @param {object} [options]
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {number} [options.dpr]
 * @param {number} [options.volume]
 * @param {boolean} [options.muted]
 * @param {string} [options.color]
 * @param {string} [options.overflowColor]
 * @param {number} [options.clipStart]
 * @param {number} [options.clipEnd]
 * @param {number|null} [options.playhead]
 * @param {string|null} [options.background]
 * @param {string} [options.playheadColor]
 * @returns {{columns: number, peakAbs: number, overflowColumns: number, silent: boolean, placeholder: boolean}}
 */
export function drawWaveform(ctx, peaks, options = {}) {
  const canvas = ctx.canvas;
  const dpr = Number(options.dpr ?? 1) || 1;
  const width = Number(options.width ?? (canvas ? canvas.width / dpr : 0));
  const height = Number(options.height ?? (canvas ? canvas.height / dpr : 0));
  const color = options.color ?? '#7dd3fc';
  const overflowColor = options.overflowColor ?? '#ef4444';
  const playheadColor = options.playheadColor ?? color;
  const volume = Number(options.volume ?? 1);
  const muted = options.muted === true || volume === 0;

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (typeof options.background === 'string') {
    ctx.fillStyle = options.background;
    ctx.fillRect(0, 0, width, height);
  }

  const mid = height / 2;
  const summary = { columns: Math.max(0, Math.floor(width)), peakAbs: 0, overflowColumns: 0, silent: muted, placeholder: false };

  /* 失败占位：调用方可以把 loadPeaks 的返回值直接传进来，不必先判 ok */
  if (isWaveformError(peaks) || !peaks || !peaks.min || !peaks.max || !peaks.length) {
    summary.placeholder = true;
    drawPlaceholder(ctx, { width, height, color: options.color ?? '#94a3b8', code: isWaveformError(peaks) ? peaks.code : WAVEFORM_ERROR_CODES.BAD_PEAKS });
    ctx.restore();
    return summary;
  }

  const duration = Number(peaks.duration) || 0;
  const sps = Number(peaks.samplesPerSecond) || 1;
  let clipStart = Number(options.clipStart ?? 0);
  let clipEnd = Number(options.clipEnd ?? duration);
  if (!Number.isFinite(clipStart)) clipStart = 0;
  if (!Number.isFinite(clipEnd)) clipEnd = duration;
  clipStart = Math.max(0, Math.min(duration, clipStart));
  clipEnd = Math.max(clipStart, Math.min(duration, clipEnd));

  /* 静音：一条居中的平线（1px 在 dpr=2 下会显得太虚，用 1.5） */
  if (muted) {
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(0, mid - 0.75, width, 1.5);
    ctx.globalAlpha = 1;
    if (typeof options.playhead === 'number') drawPlayhead(ctx, options.playhead, { width, height, clipStart, clipEnd, color: playheadColor });
    ctx.restore();
    return summary;
  }

  const span = clipEnd - clipStart;
  const columns = Math.max(1, Math.floor(width));
  const half = height / 2;
  /** @type {{x: number, top: number, bottom: number}[]} */
  const bars = [];
  /** @type {{x: number, top: boolean}[]} */
  const overflow = [];

  for (let x = 0; x < columns; x += 1) {
    const t0 = span <= 0 ? clipStart : clipStart + (x / columns) * span;
    /* 同一个 epsilon 也用在这里：否则「整幅 + clip」与「裁剪文件」在桶边界上会差一个桶，
       像素上就是一条 1px 宽的高度差（A2 的像素对比就是被这个卡住的）。 */
    let bucket = Math.floor(t0 * sps + BUCKET_EPSILON);
    if (bucket < 0) bucket = 0;
    if (bucket >= peaks.length) bucket = peaks.length - 1;
    const lo = Number(peaks.min[bucket] ?? 0) * volume;
    const hi = Number(peaks.max[bucket] ?? 0) * volume;
    const absMax = Math.max(Math.abs(lo), Math.abs(hi));
    if (absMax > summary.peakAbs) summary.peakAbs = absMax;

    const top = mid - Math.min(1, hi) * half;
    const bottom = mid - Math.max(-1, lo) * half;
    bars.push({ x, top: Math.min(top, bottom), bottom: Math.max(top, bottom) });

    /* 超满幅：只在边缘画帽带，波形本身仍按 ±1 画，不把画布撑破 */
    if (absMax > 1) {
      summary.overflowColumns += 1;
      if (hi > 1) overflow.push({ x, top: true });
      if (lo < -1) overflow.push({ x, top: false });
    }
  }

  ctx.fillStyle = color;
  ctx.beginPath();
  for (const bar of bars) {
    const h = Math.max(1, bar.bottom - bar.top);
    ctx.rect(bar.x, bar.top, 1, h);
  }
  ctx.fill();

  if (overflow.length > 0) {
    const cap = Math.max(2, Math.round(height * 0.06));
    ctx.fillStyle = overflowColor;
    ctx.beginPath();
    for (const item of overflow) {
      ctx.rect(item.x, item.top ? 0 : height - cap, 1, cap);
    }
    ctx.fill();
  }

  if (typeof options.playhead === 'number') drawPlayhead(ctx, options.playhead, { width, height, clipStart, clipEnd, color: playheadColor });
  ctx.restore();
  return summary;
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} playhead 秒（与 `clipStart/clipEnd` 同一时间轴）
 * @param {{width: number, height: number, clipStart: number, clipEnd: number, color: string}} arg
 */
function drawPlayhead(ctx, playhead, arg) {
  const span = arg.clipEnd - arg.clipStart;
  if (span <= 0) return;
  if (playhead < arg.clipStart || playhead > arg.clipEnd) return;
  const x = ((playhead - arg.clipStart) / span) * arg.width;
  ctx.fillStyle = arg.color;
  ctx.globalAlpha = 1;
  ctx.fillRect(Math.min(Math.max(0, x), arg.width - 1), 0, 1.5, arg.height);
}

/**
 * 「波形不可用」占位：虚线中轴 + 居中码值。信息量足够让用户知道去找素材，
 * 也足够让 e2e 断言（`data-waveform-placeholder` 是 DOM 侧的事，这里只管画）。
 * @param {CanvasRenderingContext2D} ctx
 * @param {{width: number, height: number, color: string, code: string}} arg
 */
function drawPlaceholder(ctx, arg) {
  const mid = arg.height / 2;
  ctx.save();
  ctx.strokeStyle = arg.color;
  ctx.globalAlpha = 0.5;
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, mid + 0.5);
  ctx.lineTo(arg.width, mid + 0.5);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.setLineDash([]);
  ctx.fillStyle = arg.color;
  ctx.globalAlpha = 0.95;
  const size = Math.max(10, Math.min(14, Math.round(arg.height / 3)));
  ctx.font = `${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`波形不可用 · ${arg.code}`, arg.width / 2, mid);
  ctx.restore();
}
