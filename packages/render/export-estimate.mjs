/**
 * 导出耗时预估（P21-GOP-ADVISOR）。
 *
 * 目的不是「猜一个数字」，而是把「这条片子大概要等多久、为什么」讲清楚。
 * 模型只有三项，每一项都能指到一次实测：
 *
 *   totalSec = captureSec + encodeSec + finishSec
 *
 *   captureSec = bootSec + frames × (settleMsPerFrame + perFrameOverheadMs) / (concurrency × efficiency) / 1000
 *   encodeSec  = frames × encodeMsPerFrame[quality] / 1000
 *   finishSec  = baseSec + perAudioClipSec × audioClips
 *
 * 常数来源（**都不是拍脑袋**）：
 * - `settleMsPerFrame` 是**入参**，不写死。没给时用下面 `settleForGop()` 按素材关键帧间隔推。
 *   锚点 454.79ms = R10 实测（8s/720p30/整段 1 个关键帧/单通道/240 帧的均值）。
 *   本轮 R11 又用 3fps 采样独立测了一次同样的素材，得 455.96ms（差 0.3%）。
 * - 斜率 11.11ms / 23.3ms（每 1 秒关键帧间隔）分别来自 c=1 的 4 点标定和 R10 的
 *   端到端 GOP 对照（189.33s ↔ 134.21s）。两条都在 `SETTLE_MODEL` 的注释里写明。
 * - `perFrameOverheadMs` 64.68ms = R10 film30 profile 实测 shot 40.30 + write 20.85 + hash 0.07 + ipc 3.46。
 * - `parallelEfficiency` 0.87 = R10 两次实测的并行效率均值（film30 0.890 / film8 0.848）。
 * - `encodeMsPerFrame` = R9 同一批 900 帧同参数重编实测：draft 6.36s / standard 9.12s / high 11.31s。
 *
 * 这一层**纯函数、不碰 IO**：探针（`media-probe.mjs`）负责读素材，这里只算账。
 * 这样预估可以在测试里复现，也不会因为「预估了一下」就动了工程里的文件。
 */

import { planCaptureConcurrency } from './concurrency.mjs';

export const ESTIMATE_VERSION = '1.0.0';

/**
 * 模型常数。改这里必须同时改注释里的出处，否则下一个人没法判断该不该信。
 */
export const SETTLE_MODEL = {
  /**
   * R10 实测锚点：`projects/film8`，8s/720p30，整段 1 个关键帧，单通道 240 帧，
   * `avgMs.settleMs = 454.79`。R11 用 3fps 采样复测同一素材得 455.96（差 0.3%），
   * 说明这个数不是某一次运行的偶然值。
   */
  anchorGopSec: 8,
  anchorSettleMs: 454.79,
  /**
   * 斜率（每 1 秒关键帧间隔带来的额外 settle）随通道数上升——多开的页面在抢同一块 CPU 解码。
   * - c=1：11.11ms/s，来自 `scripts/gop-settle-probe.mjs` 的 4 点标定（0.5/1/2.67/8s，r²=0.975）。
   * - c=3：23.3ms/s，由 R10 端到端对照反推（同工程 189.33s ↔ 134.21s，差值扣掉编码/收尾后
   *   折成每帧，再按 eff=0.87 还原到串行口径）。
   * 只在 c=1 与 c=3 测过：中间线性插值，**>3 不外推**（按 c=3 取值，宁可保守）。
   */
  slopeSerialMsPerGopSec: 11.11,
  slopeConcurrentMsPerGopSec: 23.3,
  concurrentAt: 3,
  /** 没有任何素材信息时的兜底：等于锚点，并在结果里标 confidence=low。 */
  fallbackSettleMs: 454.79,
};

export const ESTIMATE_DEFAULTS = {
  /** R10 film30 profile 实测：shot 40.30 + write 20.85 + hash 0.07 + ipc 3.46 */
  perFrameOverheadMs: 64.68,
  /** 起 Studio + 内容 origin + Chromium，并行开通道。R10 实测 2~3s。 */
  bootSec: 2.5,
  /** R10 两次实测的并行效率均值。 */
  parallelEfficiency: 0.87,
  /** R9 用同一批 900 张 PNG 同参数重编实测（秒 / 900 帧）。 */
  encodeMsPerFrame: { draft: 7.07, standard: 10.13, high: 12.57 },
  /** 混音 + 封装 + 校验：R10 film30 收尾约 2.5s（4 条音频）。 */
  finishBaseSec: 1.5,
  finishPerAudioClipSec: 0.25,
};

/**
 * @typedef {Object} EstimateContribution
 * @property {'capture' | 'encode' | 'finish' | 'boot'} key
 * @property {string} label
 * @property {number} sec
 * @property {number} sharePercent
 */

/**
 * @typedef {Object} ExportEstimate
 * @property {number} frames
 * @property {number} durationSec
 * @property {number} fps
 * @property {'stage' | 'ffmpeg'} mode 走舞台取帧还是纯 ffmpeg 合成
 * @property {number} concurrency
 * @property {number} settleMsPerFrame 本次估算用的每帧 settle
 * @property {'input' | 'model' | 'fallback'} settleSource
 * @property {number} captureSec 取帧（含启动）
 * @property {number} encodeSec 编码
 * @property {number} finishSec 混音/封装/校验
 * @property {number} totalSec
 * @property {'high' | 'medium' | 'low'} confidence
 * @property {string[]} reasons 人话理由（第一条是最主要的开销）
 * @property {EstimateContribution[]} contributions
 * @property {number | null} gopPenaltySec 因关键帧稀疏而多等的时间（相对 1s GOP 重编）
 * @property {any} assumptions 本次用到的全部常数与素材事实（便于对方复算）
 */

/**
 * @param {number} value
 * @param {number} digits
 * @returns {number}
 */
function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * 按通道数取斜率：c=1 用串行标定值，c≥3 用端到端反推值，中间线性。
 * @param {number} concurrency
 * @returns {number}
 */
export function gopSlopeMsPerGopSec(concurrency) {
  const c = Number.isFinite(concurrency) ? Number(concurrency) : 1;
  const { slopeSerialMsPerGopSec: lo, slopeConcurrentMsPerGopSec: hi, concurrentAt } = SETTLE_MODEL;
  if (c <= 1) return lo;
  if (c >= concurrentAt) return hi;
  return lo + ((c - 1) / (concurrentAt - 1)) * (hi - lo);
}

/**
 * settle 的默认值：按「最稀关键帧的那条素材」推。
 *
 * 为什么取最稀的：一帧要等**所有**在场的视频都就位，最慢的那条决定这一帧什么时候返回。
 * 取全局最大比逐帧判断「此刻有哪些片段在场」简单，且方向偏保守（只会高估）。
 *
 * @param {number | null} avgGopSec
 * @param {number} [concurrency]
 * @returns {number}
 */
export function settleForGop(avgGopSec, concurrency = 1) {
  if (typeof avgGopSec !== 'number' || !Number.isFinite(avgGopSec) || avgGopSec <= 0) {
    return SETTLE_MODEL.fallbackSettleMs;
  }
  const slope = gopSlopeMsPerGopSec(concurrency);
  const delta = (Math.max(0, avgGopSec) - SETTLE_MODEL.anchorGopSec) * slope;
  // 下界：固定开销（rVFC + 2×rAF）不会低于锚点减去整个 GOP 的那一段
  return Math.max(60, round(SETTLE_MODEL.anchorSettleMs + delta, 2));
}

/**
 * 把 profiles 归一成「源路径 → profile」。
 * @param {any} profiles
 * @returns {Map<string, any>}
 */
function indexProfiles(profiles) {
  /** @type {Map<string, any>} */
  const map = new Map();
  if (!profiles) return map;
  const rows = profiles instanceof Map ? Array.from(profiles.values()) : Array.isArray(profiles) ? profiles : [profiles];
  for (const row of rows) {
    if (row && typeof row === 'object' && typeof row.path === 'string') map.set(row.path, row);
  }
  return map;
}

/**
 * @param {number} seconds
 * @returns {string}
 */
function humanDuration(seconds) {
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m${String(s).padStart(2, '0')}s`;
}

/**
 * 预估导出耗时。
 *
 * @param {{
 *   plan: any,
 *   profiles?: any,
 *   concurrency?: number,
 *   settleMsPerFrame?: number,
 *   quality?: string,
 *   model?: Partial<typeof ESTIMATE_DEFAULTS>,
 * }} input
 * @returns {ExportEstimate}
 */
export function estimateExport(input) {
  const plan = input?.plan;
  if (!plan || typeof plan !== 'object') throw new TypeError('estimateExport: plan is required');
  const frames = Number(plan.frames);
  if (!Number.isFinite(frames) || frames <= 0) throw new TypeError('estimateExport: plan.frames must be a positive number');

  const model = { ...ESTIMATE_DEFAULTS, ...(input.model ?? {}) };
  /** @type {Record<string, number>} */
  const encodeTable = model.encodeMsPerFrame;
  const quality = typeof input.quality === 'string' && encodeTable[input.quality] !== undefined ? input.quality : 'standard';
  const encodeMsPerFrame = encodeTable[quality] ?? ESTIMATE_DEFAULTS.encodeMsPerFrame.standard;
  const visualClips = Array.isArray(plan.visualClips) ? plan.visualClips : [];
  const sceneClips = Array.isArray(plan.sceneClips) ? plan.sceneClips : [];
  const audioClips = Array.isArray(plan.audioMix?.clips) ? plan.audioMix.clips : [];
  // 与 ops.exportFilm 的判据保持一致：有网页片段才走舞台取帧
  const mode = sceneClips.length > 0 ? 'stage' : 'ffmpeg';
  const concurrency = Number.isFinite(input.concurrency)
    ? Math.max(1, Math.trunc(Number(input.concurrency)))
    : planCaptureConcurrency(plan);

  // 只有视频片段需要 seek；静帧是一次解码，代价可以忽略
  const videoClips = visualClips.filter((/** @type {any} */ c) => (c?.kind ?? 'video') === 'video');
  const byPath = indexProfiles(input.profiles);

  /** @type {Map<string, { path: string, clips: string[], profile: any }>} */
  const sources = new Map();
  for (const clip of videoClips) {
    const src = typeof clip?.src === 'string' ? clip.src : '';
    if (src === '') continue;
    /** @type {{ path: string, clips: string[], profile: any }} */
    const fresh = { path: src, clips: [], profile: byPath.get(src) ?? null };
    const entry = sources.get(src) ?? fresh;
    entry.clips.push(String(clip.id));
    sources.set(src, entry);
  }

  /** @type {any} */
  let worst = null;
  for (const entry of sources.values()) {
    if (!entry.profile) continue;
    const gop = Number(entry.profile.avgGopSec);
    if (!Number.isFinite(gop)) continue;
    if (!worst || gop > Number(worst.profile.avgGopSec)) worst = entry;
  }

  /** @type {number} */
  let settleMsPerFrame;
  /** @type {'input' | 'model' | 'fallback'} */
  let settleSource;
  if (Number.isFinite(input.settleMsPerFrame) && Number(input.settleMsPerFrame) > 0) {
    settleMsPerFrame = round(Number(input.settleMsPerFrame), 2);
    settleSource = 'input';
  } else if (worst) {
    settleMsPerFrame = settleForGop(Number(worst.profile.avgGopSec), concurrency);
    settleSource = 'model';
  } else {
    settleMsPerFrame = SETTLE_MODEL.fallbackSettleMs;
    settleSource = 'fallback';
  }

  const perFrameMs = settleMsPerFrame + model.perFrameOverheadMs;
  const bootSec = mode === 'stage' ? model.bootSec : 0;
  const loopSec = mode === 'stage' ? (frames * perFrameMs) / (concurrency * model.parallelEfficiency) / 1000 : 0;
  const captureSec = round(bootSec + loopSec, 2);
  const encodeSec = round((frames * encodeMsPerFrame) / 1000, 2);
  const finishSec = round(model.finishBaseSec + model.finishPerAudioClipSec * audioClips.length, 2);
  const totalSec = round(captureSec + encodeSec + finishSec, 2);

  // 关键帧稀疏带来的额外等待：换成 1s GOP 的话每帧能少等多少
  /** @type {number | null} */
  let gopPenaltySec = null;
  const worstGop = worst ? Number(worst.profile.avgGopSec) : null;
  if (mode === 'stage' && worstGop !== null && Number.isFinite(worstGop) && worstGop > 1) {
    const idealSettle = settleForGop(1, concurrency);
    const deltaMs = Math.max(0, settleMsPerFrame - idealSettle);
    if (deltaMs > 0) gopPenaltySec = round((frames * deltaMs) / (concurrency * model.parallelEfficiency) / 1000, 2);
  }

  const share = (/** @type {number} */ part) => (totalSec > 0 ? round((part / totalSec) * 100, 1) : 0);
  /** @type {EstimateContribution[]} */
  const contributions = [
    { key: 'capture', label: `取帧（${mode === 'stage' ? '舞台合成' : 'ffmpeg 直通'}）`, sec: captureSec, sharePercent: share(captureSec) },
    { key: 'encode', label: `H.264 编码（${quality}）`, sec: encodeSec, sharePercent: share(encodeSec) },
    { key: 'finish', label: '混音 + 封装 + 校验', sec: finishSec, sharePercent: share(finishSec) },
  ];

  /** @type {string[]} */
  const reasons = [];
  if (mode !== 'stage') {
    reasons.push(
      `工程没有网页片段：画面走 ffmpeg 直接合成，不启动浏览器，取帧为 0。耗时几乎全是编码（${round(
        (encodeSec / Math.max(totalSec, 0.001)) * 100,
        0,
      )}%）。`,
    );
  } else if (videoClips.length === 0) {
    reasons.push('没有视频片段：舞台每帧只需要合成网页/静帧，settle 只来自 iframe 等就位。');
  } else if (worst && worstGop !== null) {
    const kf = Number(worst.profile.keyframeCount);
    const name = worst.path.split('/').pop() ?? worst.path;
    const clipText = worst.clips.length === videoClips.length
      ? `${videoClips.length} 条视频片段全部用 ${name}`
      : `${videoClips.length} 条视频片段里有 ${worst.clips.length} 条用 ${name}`;
    const gopText = Number.isFinite(kf) && kf <= 1
      ? `整片只有 ${kf === 1 ? '1 个' : '0 个'}关键帧，关键帧间隔 ${worstGop}s 等于整片时长`
      : `关键帧间隔 ${worstGop}s（${kf} 个关键帧）`;
    const sampled = worst.profile.sampled === true ? '，该数字来自抽样扫描' : '';
    // 5s 是 R10 的经验分界线：间隔在 5s 以内，seek 的解码距离已经不影响体感，别再赖素材
    const sparse = worstGop > 5;
    reasons.push(
      `${clipText}：${gopText}${sampled}。${
        sparse
          ? '每次 seek 都要从最近的关键帧解到目标点，这是取帧慢的主因。'
          : '关键帧间隔正常，素材不是瓶颈——剩下的时间基本是固定的 seek 等待（等 seeked + 一帧渲染 + 2×rAF）。'
      }`,
    );
  } else {
    reasons.push('没有拿到素材关键帧信息（未提供 profiles）：settle 用的是 R10 的兜底实测值，可能偏离。');
  }

  if (mode === 'stage') {
    const settleShare = round((settleMsPerFrame / perFrameMs) * 100, 0);
    reasons.push(
      `每帧 ${round(perFrameMs, 1)}ms 里 settle 占 ${settleMsPerFrame}ms（${settleShare}%），截图/写盘/IPC 合计只有 ${model.perFrameOverheadMs}ms——` +
        `继续优化取帧实现的天花板就在这里，要再快只能动 settle 或素材。`,
    );
    reasons.push(
      `${concurrency} 个通道并行（按 CPU 核数与视频条数取小；内存上限 1.5GB 下 4 条视频最多 3 通道），` +
        `并行效率按 R10 实测取 ${model.parallelEfficiency}。`,
    );
  }
  if (gopPenaltySec !== null && gopPenaltySec > 0.5) {
    const pct = round((gopPenaltySec / Math.max(totalSec, 0.001)) * 100, 0);
    reasons.push(
      `如果把这批视频按 1s GOP 重编一遍再导出，预计能少等约 ${gopPenaltySec}s（占总耗时 ${pct}%）——` +
        `这是一次性成本，换的是每次导出都省。`,
    );
  }
  if (settleSource === 'input') {
    reasons.push(`settle 用的是调用方给的值 ${settleMsPerFrame}ms（不跟着模型走），适合主线调整 settle 后对比。`);
  }
  if (settleSource === 'fallback') {
    reasons.push('没有素材信息也没有给 settle：只能按 R10 的 454.79ms 兜底，误差可能超过 25%。');
  }

  /** @type {'high' | 'medium' | 'low'} */
  let confidence = 'high';
  if (settleSource !== 'input') confidence = 'medium';
  if (settleSource === 'fallback') confidence = 'low';
  if (worst?.profile?.sampled === true && confidence === 'high') confidence = 'medium';

  return {
    frames,
    durationSec: round(Number(plan.outputDuration ?? plan.duration ?? frames / (Number(plan.fps) || 30)), 3),
    fps: Number(plan.fps) || 30,
    mode,
    concurrency,
    settleMsPerFrame,
    settleSource,
    captureSec,
    encodeSec,
    finishSec,
    totalSec,
    confidence,
    reasons,
    contributions,
    gopPenaltySec,
    assumptions: {
      model: { ...model, version: ESTIMATE_VERSION },
      settleModel: { ...SETTLE_MODEL, appliedSlopeMsPerGopSec: round(gopSlopeMsPerGopSec(concurrency), 3) },
      quality,
      videoClips: videoClips.length,
      sceneClips: sceneClips.length,
      audioClips: audioClips.length,
      sources: Array.from(sources.values()).map((s) => ({
        path: s.path,
        clips: s.clips,
        avgGopSec: s.profile?.avgGopSec ?? null,
        maxGopSec: s.profile?.maxGopSec ?? null,
        keyframeCount: s.profile?.keyframeCount ?? null,
        sampled: s.profile?.sampled ?? null,
      })),
    },
  };
}

/**
 * 给人看的一段话（CLI 默认输出）。`--json` 走 `JSON.stringify(estimate)`。
 * @param {ExportEstimate} estimate
 * @returns {string}
 */
export function formatEstimate(estimate) {
  const lines = [];
  lines.push(
    `ESTIMATE ${estimate.durationSec}s / ${estimate.frames} 帧 / ${estimate.mode} / ` +
      `${estimate.concurrency} 通道 / 置信度 ${estimate.confidence}`,
  );
  const pad = (/** @type {string} */ s) => s.padEnd(6, ' ');
  lines.push(`  ${pad('取帧')}${estimate.captureSec.toFixed(1)}s`);
  lines.push(`  ${pad('编码')}${estimate.encodeSec.toFixed(1)}s`);
  lines.push(`  ${pad('收尾')}${estimate.finishSec.toFixed(1)}s`);
  lines.push(`  ${pad('合计')}${estimate.totalSec.toFixed(1)}s  ≈ ${humanDuration(estimate.totalSec)}`);
  lines.push('为什么：');
  for (const reason of estimate.reasons) lines.push(`  - ${reason}`);
  return lines.join('\n');
}
