/**
 * PNG 序列的体积预算与分卷（P33-A4）。
 *
 * 现实问题：4K（3840×2160）240 帧的 RGBA PNG 序列约 **2.6GB**。这带来两个麻烦：
 *
 * 1. **用户不知道要占多少盘**。导出前没有数字，跑到一半才发现盘满了；
 * 2. **单个 zip 超过 2GB 会踩到一堆工具的边角**：老 `unzip`、FAT32 U 盘、
 *    某些云盘客户端的单文件上限。分卷是唯一不解释就能用的答案。
 *
 * 口径：
 * - 单卷上限 `PNG_SEQ_VOLUME_LIMIT = 2_000_000_000`（十进制 2GB）。
 *   用十进制而不是 2GiB，是为了在「2GB = 2×1024³」和「2GB = 2×10⁹」两种读法下
 *   都 **≤ 2GB** —— 只有一个方向是安全的，就选那个方向。
 * - 分卷按**整帧**切（一张 PNG 不跨卷）。4K 单帧 ~10MB，粒度够细。
 * - 只有一卷时**不分卷**：产物仍是 `<stem>.zip`（R16 行为一字不改）。
 * - 多卷时命名 `<stem>.part001.zip`、`<stem>.part002.zip` …（3 位定宽、1 基、
 *   卷序 = 帧序）。定宽是为了让 `ls` 与 shell 通配符的字典序等于时间序。
 *
 * 为什么不在导出前就精确知道体积：PNG 的大小取决于内容（纯色卡片 4K 一帧 60KB，
 * 带噪点的画面 10MB，差两个数量级）。所以预算**先估后核**：
 * 取均匀分布的若干张已捕获帧的字节数外推，再把实际值写回报告与误差。
 */

/** 单卷字节上限（十进制 2GB，两种读法下都 ≤2GB）。 */
export const PNG_SEQ_VOLUME_LIMIT = 2_000_000_000;

/** 预估时默认抽多少张（均匀分布，覆盖全片而不是只看开头）。 */
export const ESTIMATE_SAMPLE_FRAMES = 12;

/**
 * 均匀分布取样的下标（含首尾）。
 * @param {number} frames
 * @param {number} count
 * @returns {number[]}
 */
export function sampleFrameIndices(frames, count = ESTIMATE_SAMPLE_FRAMES) {
  const total = Math.floor(Number(frames));
  if (!Number.isFinite(total) || total <= 0) return [];
  const want = Math.max(1, Math.min(Math.floor(count) || 1, total));
  if (want === 1) return [0];
  /** @type {number[]} */
  const out = [];
  for (let i = 0; i < want; i += 1) {
    const index = Math.round((i * (total - 1)) / (want - 1));
    if (out[out.length - 1] !== index) out.push(index);
  }
  return out;
}

/**
 * 体积预算：由若干张真实帧的字节数外推全序列。
 *
 * `overheadBytes` 是 `sequence.json` / `alpha-report.json` 与 zip 目录项的固定开销，
 * 在 2.6GB 面前可以忽略，但写进报告才能对得上账。
 *
 * @param {{ frames: number, sampleBytes: number[], overheadBytes?: number }} opts
 * @returns {{ estimatedBytes: number, perFrameMean: number, samples: number, method: 'sampled-frames', minSampleBytes: number, maxSampleBytes: number }}
 */
export function estimatePngSequenceBytes(opts) {
  const frames = Math.floor(Number(opts.frames));
  if (!Number.isFinite(frames) || frames <= 0) {
    const error = new Error(`estimatePngSequenceBytes needs a positive frame count, got ${String(opts.frames)}`);
    error.name = 'PngSeqError';
    /** @type {any} */ (error).code = 'INVALID';
    throw error;
  }
  const samples = (opts.sampleBytes ?? []).filter((value) => Number.isFinite(value) && value >= 0);
  if (samples.length === 0) {
    const error = new Error('estimatePngSequenceBytes needs at least one real frame size');
    error.name = 'PngSeqError';
    /** @type {any} */ (error).code = 'INVALID';
    throw error;
  }
  const sum = samples.reduce((acc, value) => acc + value, 0);
  const perFrameMean = sum / samples.length;
  const overheadBytes = Number.isFinite(opts.overheadBytes) ? Number(opts.overheadBytes) : 0;
  return {
    estimatedBytes: Math.round(perFrameMean * frames + overheadBytes),
    perFrameMean: Number(perFrameMean.toFixed(3)),
    samples: samples.length,
    method: 'sampled-frames',
    minSampleBytes: Math.min(...samples),
    maxSampleBytes: Math.max(...samples),
  };
}

/**
 * 按整帧分卷。
 *
 * 边界写法要交代清楚：**单帧就超过上限**时（理论上 2GB 一张 PNG）仍然单独成卷——
 * 不切成半张图，因为切了就不是 PNG 了。这种情况在 `oversizedFrames` 里显式列出，
 * 让上层能把它写进报告而不是悄悄产出一个超限的卷。
 *
 * @param {{ frameBytes: Array<{ index: number, bytes: number }>, overheadBytes?: number, limitBytes?: number, stem: string }} opts
 * @returns {{
 *   split: boolean,
 *   limitBytes: number,
 *   totalBytes: number,
 *   volumes: Array<{ name: string, index: number, frames: number, firstIndex: number, lastIndex: number, bytes: number }>,
 *   oversizedFrames: number[],
 * }}
 */
export function planPngSeqVolumes(opts) {
  const limitBytes = Number.isFinite(opts.limitBytes) ? Number(opts.limitBytes) : PNG_SEQ_VOLUME_LIMIT;
  const overheadBytes = Number.isFinite(opts.overheadBytes) ? Number(opts.overheadBytes) : 0;
  const frames = [...(opts.frameBytes ?? [])].sort((a, b) => a.index - b.index);
  const totalBytes = frames.reduce((acc, frame) => acc + frame.bytes, 0) + overheadBytes;
  const head = frames[0];
  const tail = frames[frames.length - 1];

  // 单卷放得下：沿用 R16 的命名（`<stem>.zip`），不制造「part001」这种只有一个的卷
  if (totalBytes <= limitBytes) {
    return {
      split: false,
      limitBytes,
      totalBytes,
      volumes: [
        {
          name: `${opts.stem}.zip`,
          index: 1,
          frames: frames.length,
          firstIndex: head ? head.index : 0,
          lastIndex: tail ? tail.index : 0,
          bytes: totalBytes,
        },
      ],
      oversizedFrames: [],
    };
  }

  /** @type {Array<{ name: string, index: number, frames: number, firstIndex: number, lastIndex: number, bytes: number }>} */
  const volumes = [];
  /** @type {number[]} */
  const oversizedFrames = [];
  /** @type {{ bytes: number, count: number, first: number, last: number } | null} */
  let current = null;
  const flush = () => {
    if (current === null) return;
    volumes.push({
      name: `${opts.stem}.part${String(volumes.length + 1).padStart(3, '0')}.zip`,
      index: volumes.length + 1,
      frames: current.count,
      firstIndex: current.first,
      lastIndex: current.last,
      bytes: current.bytes,
    });
    current = null;
  };

  for (const frame of frames) {
    if (frame.bytes > limitBytes) oversizedFrames.push(frame.index);
    if (current !== null && current.bytes + frame.bytes > limitBytes) flush();
    if (current === null) current = { bytes: 0, count: 0, first: frame.index, last: frame.index };
    current.bytes += frame.bytes;
    current.count += 1;
    current.last = frame.index;
  }
  flush();

  // 清单（sequence.json + alpha-report.json）放在**卷 1**：拿到 part001 的人不需要
  // 别的卷就知道总共有几卷。所以固定开销记到第 1 卷，它不改变「每卷 ≤ 上限」的结论
  // —— 调用方会在切卷时预留 256KB 给这份清单（见 alpha-export.mjs）。
  const head0 = volumes[0];
  if (head0 && overheadBytes > 0) {
    head0.bytes += overheadBytes;
  }

  return { split: true, limitBytes, totalBytes, volumes, oversizedFrames };
}
