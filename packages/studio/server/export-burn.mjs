/**
 * 导出烧字幕（M41 · B-MAIN-R21-021）
 *
 * Studio 的预览从 M40 起就能改字幕样式，导出却不会烧字幕（R25-C6）。这里补的就是
 * 把「工程样式文件 + 伴生字幕」接到 **render 已有的烧录入口** 上：
 *
 *     readSubtitles（studio 的伴生文件定位）
 *       → mapCuesToTimeline（render，源时间 → 成片时间）
 *       → buildAssDocument（render，样式由 S41 的 schema 统一换算）
 *       → renderFilmExport({ subtitles: { assPath, outPath } })（render，第二遍编码）
 *
 * ## 为什么 ASS 只从这几个函数出
 *
 * `buildAssDocument` 是**唯一**的「样式 → ASS」入口（它内部走 `layers/subtitle-style.mjs`
 * 的 `toAssStyle`）。studio 侧**不许**再算一遍字号/描边/边距：预览和成片各算一份，
 * 就是 R14-C1 那次双解析器的老路。所以这里只把 `readSubtitleStyle` 读到的工程样式
 * 原样传下去，一个 px 都不碰。
 *
 * ## 三件套（与 CLI `cli/ops.mjs:788-796` 同规则）
 *
 *     <base>-master.mp4   不烧
 *     <base>-subbed.mp4   烧
 *     <base>.vtt          成片时间的规范版
 *
 * `<base>` 来自输出路径去扩展名。**不烧录时一个字节都不改名**（A1/A8 的回归靠这个）。
 *
 * ## 多段区间
 *
 * P40 起 `mapCuesToTimeline` 就是按「计划层切好的窗口」映射的：跨拼接点的 cue 在每段
 * 各出一条**相邻、不重叠**的段，整条落在被删间隙里的 cue 一条都不出。Studio 这边只要
 * 把 `plan.visualClips` 原样递下去即可——所以 M44 删掉了原来那条
 * `SUBTITLE_BURN_MULTI_RANGE` 守卫（它挡住的是**已经能跑**的能力）。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { planFromFilm } from '../../render/film-plan.mjs';
import { planDelivery } from '../../render/delivery-size.mjs';
import { serializeSubtitles } from '../../film-core/subtitle.mjs';
import { buildAssDocument, mapCuesToTimeline, probeSubtitleBurnSupport } from '../../render/subtitles.mjs';
import { locateSubtitle, readSubtitles, resolveSrc } from './subtitle-store.mjs';
import { readSubtitleStyle } from './subtitle-style-store.mjs';

/** 三件套的扩展名（Studio 只出 mp4：quality 档表里没有 webm/vp9 入口）。 */
const VIDEO_EXT = '.mp4';

/**
 * 输出路径 → 三件套的 base（去扩展名）。
 *
 * 与 CLI 的 `/\.(mp4|webm|mov)$/i` 同一套写法，只是 Studio 只认 `.mp4`：
 * `film-20261108-131500.mp4` → `film-20261108-131500`。
 *
 * @param {string} target
 * @returns {string}
 */
export function burnBaseOf(target) {
  const value = String(target ?? '');
  return value.toLowerCase().endsWith(VIDEO_EXT) ? value.slice(0, value.length - VIDEO_EXT.length) : value;
}

/**
 * 三件套路径（**只算路径，不写盘**）。
 * @param {string} base 不含扩展名的绝对路径
 * @returns {{ base: string, master: string, subbed: string, vtt: string }}
 */
export function threePiecePaths(base) {
  return {
    base,
    master: `${base}-master${VIDEO_EXT}`,
    subbed: `${base}-subbed${VIDEO_EXT}`,
    vtt: `${base}.vtt`,
  };
}

/**
 * 入队前的可行性判断（**不建作业**：400 时队列长度与 `exports/` 都不动）。
 *
 * 顺序刻意如此：
 * 1. `src` 越界 / 不存在 → `SUBTITLE_SRC_INVALID`；
 * 2. 没有伴生文件，或文件里一条 cue 都没有 → `SUBTITLE_EMPTY`（文案带找过的路径）；
 * 3. 本机 ffmpeg 不能烧 → `SUBTITLE_BURN_UNAVAILABLE`。
 *
 * 多段（M44）：**不再**在这里拒绝。P40 的计划层已经把每个片段按段切成窗口，
 * `mapCuesToTimeline` 跨切点会拆成相邻两条、落间隙的整条丢弃——这是 CLI 与 Studio
 * 共用的同一段代码，不需要 studio 再判一次。
 *
 * @param {{
 *   project: { projectId: string, dir: string },
 *   ranges?: Array<[number, number]>|null,
 *   subtitleSrc: string,
 * }} input
 *   `ranges` 只是**签名稳定**（调用方一直带着它）；多段不再需要额外判断（M44）。
 * @param {{ probe?: (ffmpegPath?: string) => Promise<{ok: boolean, detail: string, version: string|null}> }} [deps]
 *   `probe` 只给单测注入（本机 ffmpeg 有没有 libass 不该决定单测结果）；生产路径不传。
 * @returns {Promise<
 *   { ok: true, src: string, file: string, format: 'vtt'|'srt', cues: any[], skipped: number }
 *   | { ok: false, code: 'SUBTITLE_SRC_INVALID'|'SUBTITLE_EMPTY'|'SUBTITLE_BURN_UNAVAILABLE'|string, message: string }
 * >}
 */
export async function checkBurnFeasible(input, deps = {}) {
  const probe = typeof deps.probe === 'function' ? deps.probe : probeSubtitleBurnSupport;

  const src = String(input.subtitleSrc ?? '').trim();
  if (src === '') {
    return { ok: false, code: 'SUBTITLE_SRC_INVALID', message: '开启烧字幕时必须给 subtitleSrc（字幕挂在哪条素材上）' };
  }
  const resolved = resolveSrc(input.project, src);
  if ('error' in resolved) {
    return { ok: false, code: 'SUBTITLE_SRC_INVALID', message: resolved.error };
  }
  try {
    const info = await fs.stat(resolved.abs);
    if (!info.isFile()) {
      return { ok: false, code: 'SUBTITLE_SRC_INVALID', message: `subtitleSrc 不是文件：${resolved.rel}` };
    }
  } catch {
    return { ok: false, code: 'SUBTITLE_SRC_INVALID', message: `subtitleSrc 不存在：${resolved.rel}` };
  }

  const read = await readSubtitles({ project: input.project, src });
  if (read.ok !== true) {
    return { ok: false, code: read.code, message: read.message };
  }
  if (read.found !== true) {
    const located = await locateSubtitle({ project: input.project, src });
    const tried = located && 'tried' in located && Array.isArray(located.tried) ? located.tried : [];
    return {
      ok: false,
      code: 'SUBTITLE_EMPTY',
      message:
        tried.length > 0
          ? `这个工程没有伴生字幕：找过 ${tried.join('、')}`
          : `这个工程没有伴生字幕：${resolved.rel} 旁边既没有 .vtt 也没有 .srt`,
    };
  }
  if (!Array.isArray(read.cues) || read.cues.length === 0) {
    return {
      ok: false,
      code: 'SUBTITLE_EMPTY',
      message: `${read.file} 里没有任何可烧的字幕条目（cue 数为 0）`,
    };
  }

  /* 能力探测放在最后：文件层面的问题（没字幕 / src 不对）优先，用户可以先去修那些；
     「本机 ffmpeg 没编 libass」是环境问题，不该盖住「这个工程没字幕」。
     放在入队前是有意的：等渲染跑三分钟才报 FRAME_FAILED（No such filter），
     既看不清原因，又要白等一场。 */
  const support = await probe('ffmpeg');
  if (!support.ok) {
    return {
      ok: false,
      code: 'SUBTITLE_BURN_UNAVAILABLE',
      message: `本机 ffmpeg 不能烧字幕：${support.detail}（换成带 libass 的 ffmpeg，或把烧录关掉）`,
    };
  }

  return {
    ok: true,
    src,
    file: read.file ?? '',
    format: read.format,
    cues: read.cues,
    skipped: read.skipped,
  };
}

/**
 * 烧录包：把**源时间**的 cue 映射到**成片时间**，出 ASS 文本与 VTT 文本。
 *
 * 纯函数式的部分尽量多（map/build 都在这里），落盘交给调用方——这样单测不需要
 * 起 ffmpeg，也能逐字段比 ASS。
 *
 * @param {{
 *   projectDir: string,
 *   src: string,
 *   file?: string,
 *   cues: any[],
 *   plan: any,
 *   size: { w: number, h: number },
 *   layout?: any,
 * }} input
 * @returns {Promise<
 *   { ok: true, assText: string, vttText: string, cues: any[], style: any, styleSha256: string|null,
 *     styleExists: boolean, warnings: string[], dropped: number }
 *   | { ok: false, code: string, message: string }
 * >}
 */
export async function buildBurnBundle(input) {
  const styleRead = await readSubtitleStyle(input.projectDir);
  if (styleRead.ok !== true) {
    return { ok: false, code: styleRead.code, message: styleRead.message };
  }

  // `plan.visualClips[].src` 是**解析后的绝对 realpath**（`film-plan` 的 resolveMedia），
  // 而请求里的 `subtitleSrc` 是工程相对路径。`mapCuesToTimeline` 按 `src` 严格相等配对，
  // 所以这里先把同一条素材解析成同一个字符串——不这样做，字幕会被判成「没有对应片段」。
  let mediaSrc = input.src;
  try {
    mediaSrc = await fs.realpath(path.resolve(input.projectDir, input.src));
  } catch {
    /* 解析不了就退回相对路径：mapCuesToTimeline 会给出「不在计划里」的 warning */
  }

  const source = {
    src: mediaSrc,
    path: input.file ?? input.src,
    format: /** @type {'vtt'} */ ('vtt'),
    // Studio 只烧**一条**素材的伴生字幕（`subtitleSrc`），没有「按片段分源」的概念：
    // clipId 只用于 CLI 的 sources 去重/报错，这里留空字符串。
    clipId: '',
    cues: (Array.isArray(input.cues) ? input.cues : []).map((cue, index) => ({
      index: Number.isInteger(cue?.index) ? cue.index : index,
      id: typeof cue?.id === 'string' ? cue.id : null,
      startSec: Number(cue?.start ?? cue?.startSec ?? 0),
      endSec: Number(cue?.end ?? cue?.endSec ?? 0),
      text: String(cue?.text ?? ''),
    })),
  };

  const fps = Number(input.plan?.fps) > 0 ? Number(input.plan.fps) : 30;
  const durationSec = Number(input.plan?.outputDuration ?? input.plan?.duration) || 0;
  const mapped = mapCuesToTimeline({
    sources: [source],
    clips: Array.isArray(input.plan?.visualClips) ? input.plan.visualClips : [],
    durationSec,
    fps,
  });
  if (mapped.cues.length === 0) {
    // `mapCuesToTimeline` 的 warning 是英文的（render 那边给 CLI 用的原文），
    // 直接当 400 的 message 会让人摸不着头脑：中文一句在前，原文放括号里留证据。
    const detail = mapped.warnings.length > 0 ? `（${mapped.warnings.join('; ')}）` : '';
    return {
      ok: false,
      code: 'SUBTITLE_EMPTY',
      message: `字幕条目全部落在成片窗口之外，没有可烧的内容${detail}`,
    };
  }

  const size = {
    w: Math.max(2, Math.round(Number(input.size?.w) || 1280)),
    h: Math.max(2, Math.round(Number(input.size?.h) || 720)),
  };
  const assText = buildAssDocument({
    cues: mapped.cues,
    size,
    subtitleStyle: styleRead.style,
    ...(input.layout ? { layout: input.layout } : {}),
    generator: 'studio/export-burn.mjs',
  });

  // VTT 写成**成片时间**的规范版（与 CLI 同一件事）：源时间直接复制会在有入点/
  // 多段拼接时整体错位。cue 的形状换成 film-core 的 {start,end,text}。
  const vttText = serializeSubtitles(
    mapped.cues.map((cue) => ({ start: cue.startSec, end: cue.endSec, text: cue.text })),
    { format: 'vtt' },
  );

  return {
    ok: true,
    assText,
    vttText,
    cues: mapped.cues,
    style: styleRead.style,
    styleSha256: styleRead.sha256,
    styleExists: styleRead.exists,
    warnings: mapped.warnings,
    dropped: mapped.dropped,
  };
}

/**
 * 交付画幅 ≠ 舞台时的 ASS 几何（M42）。
 *
 * 原来只写在 `export-job.mjs` 的 run 里；M44 的**入队前预检**也要用它，所以抽到这里，
 * 两边调同一个函数——「预检算出来的 ASS」与「真烧的那份」必须是同一个公式。
 *
 * @param {any} delivery `planDelivery()` 的返回
 * @param {{w: number, h: number}} stage
 */
export function subtitleLayoutOf(delivery, stage) {
  if (delivery.fit === 'none') return null;
  return {
    stage,
    fit: delivery.fit,
    scale: delivery.scale,
    offset:
      delivery.fit === 'cover'
        ? { x: -(delivery.cropped?.x ?? 0), y: -(delivery.cropped?.y ?? 0) }
        : {
            x: (delivery.output.w - stage.w * delivery.scale) / 2,
            y: (delivery.output.h - stage.h * delivery.scale) / 2,
          },
  };
}

/**
 * 入队前**真算一遍**计划 + 烧录包（M44）。
 *
 * 为什么非要在入队前：`checkBurnFeasible` 只看文件，看不出「这些 cue 落在被删的间隙里」
 * ——那是 `mapCuesToTimeline` 拿计划窗口算出来的。多段放开之后（`BURN_MAX_RANGES` 已删），
 * 「全落间隙」如果留到作业里才发现，就变成「排队 → 跑一遍 → failed」，与 M41 定下的
 * 「入队前判死、队列长度与 exports/ 都不动」不是同一条纪律。
 *
 * 代价：计划算两遍（这里一次、`run()` 里一次）。计划是纯计算（不取帧、不编码），
 * 8s 工程 ~20ms；换来的是 400 能说清「为什么一条都不剩」。
 *
 * 计划本身失败（媒体缺失之类）在这里**不拦**：只把 `buildBurnBundle` 明确给出的 code
 * 变成 400，其余交给作业自己报——预检不该变成新的失败来源。
 *
 * @param {{ doc: any, projectDir: string, src: string, file?: string, cues: any[],
 *   range?: [number, number]|null, ranges?: Array<[number, number]>|null,
 *   size?: {w: number, h: number}|null, fit?: 'letterbox'|'cover'|null, fps?: number|null }} input
 * @returns {Promise<{ok: true, cues?: number, dropped?: number, plan?: any, skipped?: string, message?: string}
 *   | {ok: false, code: string, message: string, plan?: any}>}
 */
export async function preflightBurn(input) {
  /** @type {any} */
  let plan;
  try {
    plan = await planFromFilm(input.doc, {
      projectRoot: input.projectDir,
      ...(Number.isFinite(input.fps) && Number(input.fps) > 0 ? { fps: Number(input.fps) } : {}),
      ...(Array.isArray(input.ranges) && input.ranges.length > 0
        ? { ranges: input.ranges }
        : input.range
          ? { range: input.range }
          : {}),
    });
  } catch (error) {
    return { ok: true, skipped: 'plan-failed', message: String(/** @type {any} */ (error)?.message ?? error) };
  }
  const delivery = planDelivery({ stage: plan.stage, size: input.size ?? null, fit: input.fit ?? null });
  const layout = subtitleLayoutOf(delivery, plan.stage);
  const bundle = await buildBurnBundle({
    projectDir: input.projectDir,
    src: input.src,
    file: input.file,
    cues: input.cues,
    plan,
    size: delivery.output,
    ...(layout === null ? {} : { layout }),
  });
  if (bundle.ok !== true) return { ok: false, code: bundle.code, message: bundle.message, plan };
  return { ok: true, cues: bundle.cues.length, dropped: bundle.dropped, plan };
}

/**
 * 把烧录包落成磁盘上的两个文件（ASS 给 render 的 `subtitles.assPath`，VTT 是交付物之一）。
 * @param {{ assPath: string, vttPath: string, assText: string, vttText: string }} input
 * @returns {Promise<{ok: true}|{ok: false, code: 'SUBTITLE_WRITE_FAILED', message: string}>}
 */
export async function writeBurnFiles(input) {
  try {
    await fs.mkdir(path.dirname(input.assPath), { recursive: true });
    await fs.writeFile(input.assPath, input.assText, 'utf8');
    await fs.mkdir(path.dirname(input.vttPath), { recursive: true });
    await fs.writeFile(input.vttPath, input.vttText, 'utf8');
    return { ok: true };
  } catch (error) {
    return { ok: false, code: 'SUBTITLE_WRITE_FAILED', message: String(/** @type {Error} */ (error).message) };
  }
}
