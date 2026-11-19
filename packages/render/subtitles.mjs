/**
 * 字幕烧录（P23）：旁挂 .vtt/.srt → 时间线对齐 → ASS → 交给 ffmpeg `subtitles`（libass）。
 *
 * 为什么不是"把 vtt 原样丢给 ffmpeg"：
 * 成片的时间轴和素材的时间轴不是一回事。片段有源入点（`src#t=in,out` → `clip.time`）、
 * 时间线起点（`clip.at`）、变速（`clip.speed`），一条在素材 2.0s 的 cue 可能出现在成片
 * 0.0s，也可能因为 speed=2 被压到一半。`subtitles` 滤镜只认"成片时间"，所以必须先
 * 把每条 cue 映射到成片时间再交给它——**直接拿原始 vtt 时间等于悄悄错位**。
 *
 * 四段职责：
 * 1. `parseSubtitleText` / `findSidecar`：读旁挂字幕（同目录同名，`.vtt` 优先）。
 * 2. `mapCuesToTimeline`：源时间 → 成片时间；落在片段窗口外的 cue 被裁掉并记账。
 *    多段拼接（P40）沿用同一张映射表：计划层已经把每个片段按段切成窗口
 *    （`at = segment.outStartSec + (takeStart - segment.start)`），所以跨切点的 cue
 *    在这里自然被切成**相邻、不重叠**的多条，不会整条重复。
 *    落帧格后还要过一次 `clampCueOverlaps`（P43）：向外取整（floor 起点 / ceil 终点）
 *    在分数帧率下会把前后两条各推一帧，同一轨上原本首尾相接的两条就叠出 33ms。
 * 3. `planCueLines`：每条 cue 的行排**只走** `packages/film-core/subtitle-layout.mjs`
 *    的 `planSubtitleLines()`（ADR-R24-01 的共享纯函数，冻结）。
 * 4. `buildAssDocument`：样式换算**只走** `packages/layers/subtitle-style.mjs` 的
 *    `toAssStyle()`（S41 的单一来源），本文件不再自己算字号/描边/安全区。
 *
 * 明确不做：不做 cue 编辑（主线 M24 的时间线字幕轨负责）；不改 `film-core`；
 * 不猜字体——字形覆盖查不到就 `NOT_RUN`，不假装检过。
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { planSubtitleLines, subtitleLineStep, toAssText } from '../film-core/subtitle-layout.mjs';
import {
  SUBTITLE_STYLE_DEFAULTS as CANONICAL_SUBTITLE_STYLE,
  toAssStyle,
} from '../layers/subtitle-style.mjs';
import { rateOfFps, snapSecondsToFrame } from './fps.mjs';
import { assertBurnCapable, BURN_SUGGESTIONS } from './ffmpeg.mjs';
import { STYLE_FIELDS, SUBTITLE_STYLE_FILE } from './subtitle-style-source.mjs';

const execFileAsync = promisify(execFile);

/** @typedef {(file: string, args?: readonly string[]) => Promise<{ stdout: string, stderr: string }>} Runner */
const DEFAULT_RUNNER = /** @type {Runner} */ (/** @type {unknown} */ (execFileAsync));

export const SUBTITLE_MODULE_VERSION = '1.0.0';

/**
 * 旧 `style` 入参的默认值 —— **派生视图**，不是第二套默认值。
 *
 * P37 起样式的唯一真相是 `packages/layers/subtitle-style.mjs` 的
 * `SUBTITLE_STYLE_DEFAULTS`（S41）。这里逐字段从它派生，只为兼容
 * `buildAssDocument({ style })` 这个旧入口与既有调用方（同一个对象还被
 * `packages/layers/subtitle-style.test.mjs` 拿去逐字段比）。
 *
 * 两套字段名不同、语义相同：
 * - `strokeWidthRatio` ≡ `outlineRatio`（都相对**字号**，0.055 = 字号的 5.5%，参照 `widthEm`）
 * - `fontFamily`      ≡ `assFontName`（ASS 的 `Fontname` 是单值，写不了族列表）
 *
 * `outlineRatio` 仍然保留为 `null`：它是**旧口径**（相对画面高），只有显式给值时才生效，
 * 与 S41 的同名字段（相对字号）同名不同义。见 README「两个 outlineRatio」。
 *
 * @typedef {{ fontSizeRatio: number, bottomSafeRatio: number, strokeWidthRatio: number,
 *   outlineRatio: number | null, shadowRatio: number, fontFamily: string, lineHeight: number,
 *   fontScale: number, bold: boolean, cpsWarn: number }} SubtitleStyle
 */
export const SUBTITLE_STYLE_DEFAULTS = Object.freeze({
  fontSizeRatio: CANONICAL_SUBTITLE_STYLE.fontSizeRatio,
  bottomSafeRatio: CANONICAL_SUBTITLE_STYLE.bottomSafeRatio,
  strokeWidthRatio: CANONICAL_SUBTITLE_STYLE.outlineRatio,
  /** @deprecated 相对画面高的旧口径；显式给值时才生效，优先于 `strokeWidthRatio`。 */
  outlineRatio: /** @type {number | null} */ (null),
  shadowRatio: CANONICAL_SUBTITLE_STYLE.shadowRatio,
  fontFamily: CANONICAL_SUBTITLE_STYLE.assFontName,
  lineHeight: CANONICAL_SUBTITLE_STYLE.lineHeight,
  fontScale: CANONICAL_SUBTITLE_STYLE.fontScale,
  // 舞台层不设 font-weight（走宿主默认 400）。ASS 的 Bold=-1 是**合成加粗**，
  // 比真粗体更胖，两边字重会差一眼可见的一档——所以默认跟舞台一样不加粗。
  bold: CANONICAL_SUBTITLE_STYLE.bold,
  cpsWarn: CANONICAL_SUBTITLE_STYLE.cpsWarn,
});

/**
 * 字幕相关错误码。CLI 原样透出，脚本可以只靠 code 分支。
 * @typedef {'SUBTITLE_PARSE_FAILED' | 'SUBTITLE_MISSING_GLYPH' | 'SUBTITLE_UNSUPPORTED' |
 *   'SUBTITLE_BURN_UNAVAILABLE' | 'SUBTITLE_EMPTY' | 'E_USAGE'} SubtitleCode
 */
export class SubtitleError extends Error {
  /**
   * @param {SubtitleCode} code
   * @param {string} detail
   * @param {{ path?: string, line?: number, chars?: string[] }} [extra]
   */
  constructor(code, detail, extra = {}) {
    super(`${code}: ${detail}`);
    this.name = 'SubtitleError';
    this.code = code;
    this.detail = detail;
    if (extra.path !== undefined) this.path = extra.path;
    if (extra.line !== undefined) this.line = extra.line;
    if (extra.chars !== undefined) this.chars = extra.chars;
  }
}

/**
 * @typedef {{ index: number, startSec: number, endSec: number, text: string, id: string | null }} Cue
 * @typedef {{ path: string, format: 'vtt' | 'srt', clipId: string, src: string, cues: Cue[] }} SubtitleSource
 */

/**
 * 字幕文件格式：只认扩展名，不猜内容（猜错会把 `.srt` 当 vtt 解析出一堆垃圾）。
 * @param {string} filePath
 * @returns {'vtt' | 'srt' | null}
 */
export function detectSubtitleFormat(filePath) {
  const ext = path.extname(String(filePath ?? '')).toLowerCase();
  if (ext === '.vtt') return 'vtt';
  if (ext === '.srt') return 'srt';
  return null;
}

/**
 * `hh:mm:ss.mmm` / `mm:ss.mmm` / `hh:mm:ss,mmm`（SRT 用逗号）→ 秒。
 * 解析不了就抛，别退化成 0——0 会让整条 cue 跑到片头。
 * @param {string} raw
 * @param {string} source
 * @param {number} line
 * @returns {number}
 */
export function parseTimestamp(raw, source = '', line = 0) {
  const text = String(raw).trim();
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(text);
  if (!match) {
    throw new SubtitleError('SUBTITLE_PARSE_FAILED', `bad timestamp "${text}" in ${source || 'subtitle'}`, {
      ...(source ? { path: source } : {}),
      line,
    });
  }
  const hours = match[1] === undefined ? 0 : Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const fracRaw = match[4] ?? '0';
  const millis = Number(`${fracRaw}000`.slice(0, 3));
  if (minutes > 59 || seconds > 59) {
    throw new SubtitleError('SUBTITLE_PARSE_FAILED', `timestamp out of range "${text}" in ${source || 'subtitle'}`, {
      ...(source ? { path: source } : {}),
      line,
    });
  }
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

/**
 * @param {string} raw
 * @param {string} source
 * @param {number} line
 * @returns {{ startSec: number, endSec: number, settings: string }}
 */
function parseCueTiming(raw, source, line) {
  const text = String(raw).trim();
  const arrow = text.indexOf('-->');
  if (arrow < 0) {
    throw new SubtitleError('SUBTITLE_PARSE_FAILED', `cue line has no "-->" in ${source || 'subtitle'}`, {
      ...(source ? { path: source } : {}),
      line,
    });
  }
  const left = text.slice(0, arrow).trim();
  const rightRaw = text.slice(arrow + 3).trim();
  const [right] = rightRaw.split(/\s+/, 1);
  const startSec = parseTimestamp(left, source, line);
  const endSec = parseTimestamp(right ?? '', source, line);
  if (!(endSec > startSec)) {
    throw new SubtitleError(
      'SUBTITLE_PARSE_FAILED',
      `cue end ${endSec}s is not after start ${startSec}s in ${source || 'subtitle'}`,
      { ...(source ? { path: source } : {}), line },
    );
  }
  return { startSec, endSec, settings: rightRaw.slice((right ?? '').length).trim() };
}

/**
 * 解析 WEBVTT / SRT。**严格**：格式错就抛 `SUBTITLE_PARSE_FAILED`，不"尽力而为"。
 * 空文件不是错误（返回空 cues），由调用方决定是警告还是失败。
 *
 * @param {string} text
 * @param {{ format?: 'vtt' | 'srt', source?: string }} [opts]
 * @returns {{ format: 'vtt' | 'srt', cues: Cue[], empty: boolean }}
 */
export function parseSubtitleText(text, opts = {}) {
  const source = opts.source ?? '';
  const body = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const format = opts.format ?? (body.trimStart().startsWith('WEBVTT') ? 'vtt' : 'srt');
  const lines = body.split('\n');

  /** @type {Cue[]} */
  const cues = [];
  let i = 0;
  if (format === 'vtt') {
    const firstIdx = lines.findIndex((line) => line.trim() !== '');
    if (firstIdx < 0 || !(lines[firstIdx] ?? '').trimStart().startsWith('WEBVTT')) {
      throw new SubtitleError('SUBTITLE_PARSE_FAILED', `missing WEBVTT header in ${source || 'vtt'}`, {
        ...(source ? { path: source } : {}),
        line: firstIdx + 1,
      });
    }
    // 头部不只一行：`WEBVTT - 标题` 之后还可能有 `Kind:` / `Language:` 之类的元数据，
    // 一直跳到第一个空行为止。**与 film-core 同口径**——不跳的话这些行会被当成
    // cue 标识，紧接着的下一行又不像时间行，于是一份合法 vtt 被我们判成坏文件。
    i = firstIdx + 1;
    while (i < lines.length && (lines[i] ?? '').trim() !== '') i += 1;
  }
  let index = 0;

  while (i < lines.length) {
    // 跳空行
    while (i < lines.length && (lines[i] ?? '').trim() === '') i += 1;
    if (i >= lines.length) break;

    // VTT 的 NOTE/STYLE/REGION 块：整块跳过（到空行为止）
    if (format === 'vtt' && /^(NOTE|STYLE|REGION)\b/.test((lines[i] ?? '').trim())) {
      while (i < lines.length && (lines[i] ?? '').trim() !== '') i += 1;
      continue;
    }

    let id = null;
    let timingLine = lines[i] ?? '';
    let timingIdx = i;
    if (!timingLine.includes('-->')) {
      id = timingLine.trim();
      i += 1;
      if (i >= lines.length) {
        throw new SubtitleError('SUBTITLE_PARSE_FAILED', `cue "${id}" has no timing line in ${source || format}`, {
          ...(source ? { path: source } : {}),
          line: timingIdx + 1,
        });
      }
      timingLine = lines[i] ?? '';
      timingIdx = i;
    }
    if (!timingLine.includes('-->')) {
      throw new SubtitleError(
        'SUBTITLE_PARSE_FAILED',
        `expected a timing line, got "${timingLine.trim().slice(0, 60)}" in ${source || format}`,
        { ...(source ? { path: source } : {}), line: timingIdx + 1 },
      );
    }
    const { startSec, endSec } = parseCueTiming(timingLine, source || format, timingIdx + 1);
    i += 1;

    /** @type {string[]} */
    const textLines = [];
    while (i < lines.length && (lines[i] ?? '').trim() !== '') {
      textLines.push(lines[i] ?? '');
      i += 1;
    }
    index += 1;
    const cueText = plainText(textLines);
    // 空文本 cue：film-core 那边是丢掉的（时间线不会画一个空字幕），烧录也必须丢，
    // 否则导出比预览多一条「空白字幕」，ASS 里还会多一个 Dialogue 行。
    if (cueText === '') continue;
    cues.push({ index, startSec, endSec, text: cueText, id });
  }

  return { format, cues, empty: cues.length === 0 };
}

/**
 * 去掉行内标记，只留纯文本（保留换行）。
 *
 * **必须与 `packages/film-core/subtitle.mjs` 的 `plainText()` 同口径**：舞台时间是主线那条
 * 解析器喂的，烧录是这条解析器喂的，两边对同一份 vtt 的文本必须一模一样。
 * 不清洗的后果是实测过的（R14-C1）：`<v 阿宁><i>第一句</i> &amp; 你好` 会原样烧进画面，
 * 而预览里显示的是「第一句 & 你好」——用户看到的是两行不同的字。
 *
 * @param {string[]} lines
 */
function plainText(lines) {
  const text = lines
    .join('\n')
    .replace(/<[^>]*>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ');
  return text
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

/**
 * 同目录同名旁挂字幕：`a.mp4` → `a.vtt`（优先）/ `a.srt`。
 * @param {string} srcPath
 * @returns {Promise<{ path: string, format: 'vtt' | 'srt' } | null>}
 */
export async function findSidecar(srcPath) {
  const base = String(srcPath).replace(/\.[^./\\]+$/, '');
  for (const format of /** @type {const} */ (['vtt', 'srt'])) {
    const candidate = `${base}.${format}`;
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return { path: candidate, format };
    } catch {
      // 不存在就试下一个
    }
  }
  return null;
}

/**
 * 计划里每个**视频**片段的旁挂字幕。静帧/图片没有源时间轴，不参与。
 * @param {any} plan
 * @returns {Promise<{ sources: Array<{ clipId: string, src: string, path: string, format: 'vtt' | 'srt' }>,
 *   videosWithoutSubtitle: string[] }>}
 */
export async function discoverSubtitles(plan) {
  const clips = Array.isArray(plan?.visualClips) ? plan.visualClips : [];
  /** @type {Array<{ clipId: string, src: string, path: string, format: 'vtt' | 'srt' }>} */
  const sources = [];
  /** @type {string[]} */
  const videosWithoutSubtitle = [];
  /** @type {Set<string>} */
  const seen = new Set();

  for (const clip of clips) {
    if (clip?.kind !== 'video' || typeof clip?.src !== 'string') continue;
    const src = clip.src;
    if (seen.has(src)) continue;
    const sidecar = await findSidecar(src);
    if (!sidecar) {
      videosWithoutSubtitle.push(String(clip.id));
      continue;
    }
    seen.add(src);
    sources.push({ clipId: String(clip.id), src, path: sidecar.path, format: sidecar.format });
  }
  return { sources, videosWithoutSubtitle };
}

/**
 * 读并解析所有旁挂字幕。空文件只警告；语法坏直接抛。
 * @param {Array<{ clipId: string, src: string, path: string, format: 'vtt' | 'srt' }>} sources
 * @returns {Promise<{ sources: SubtitleSource[], warnings: string[] }>}
 */
export async function loadSubtitleSources(sources) {
  /** @type {SubtitleSource[]} */
  const loaded = [];
  /** @type {string[]} */
  const warnings = [];
  for (const source of sources) {
    const text = await fs.readFile(source.path, 'utf8');
    const parsed = parseSubtitleText(text, { format: source.format, source: source.path });
    if (parsed.empty) {
      warnings.push(`${path.basename(source.path)} is empty: no cue will be burned for clip ${source.clipId}`);
      continue;
    }
    loaded.push({ ...source, cues: parsed.cues });
  }
  return { sources: loaded, warnings };
}

/**
 * 同一轨上的单调约束（P43）：把「落帧格后与上一条重叠」的 cue 推回去，保证首尾相接。
 *
 * 为什么需要它：`snapSecondsToFrame` 是**向外取整**（起点 floor、终点 ceil），
 * 宁可多显示半帧也不吞句首句尾。整数帧率下 cue 边界通常正好在格点上，前后两条
 * 各自取整后仍然相等；分数帧率下格是 33.37ms，前一条 ceil 到第 k+1 帧、后一条
 * floor 到第 k 帧，就叠出一帧（29.97 实测 34ms）——一帧里两条字幕同时在画面上。
 *
 * 约束只加在**原本不重叠**的相邻 cue 上（`prev.sourceEndSec <= next.sourceStartSec`）：
 * 双语双行、卡拉 OK 这种原始就重叠的 cue 保持原样，不许被拆开。
 *
 * 压没了（clamp 后 `end <= start`）就把终点补到 `start + 1 帧`，但不超过 `durationSec`；
 * 连一帧都放不下（已经贴到片尾）就丢掉这条，计入 `dropped`——宁可少一条，
 * 也不输出 `start >= end` 的非法 cue（VTT 规范不允许零长 cue）。
 *
 * 纯函数：不读盘、不看全局，`cues` 必须是**同一轨**（同一 clipId / 同一段窗口）
 * 且已按 `startSec, endSec` 排序。
 *
 * @template {Cue & { clipId?: string, sourceStartSec?: number, sourceEndSec?: number }} T
 * @param {T[]} cues
 * @param {{ rate?: number | { num: number, den: number }, durationSec?: number }} [opts]
 * @returns {{ cues: T[], clamped: number, dropped: number }}
 */
export function clampCueOverlaps(cues, opts = {}) {
  /* 整数帧率走 `1/fps`，与 snapSecondsToFrame 的老表达式同口径（30fps 的格是 0.0333…，
     不是 0.03333333333333333 之外的另一个数）。 */
  const rate = rateOfFps(opts.rate ?? 30);
  const limitRaw = Number(opts.durationSec);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : Number.POSITIVE_INFINITY;
  const oneFrame = rate.den === 1 ? 1 / rate.num : rate.den / rate.num;

  /** @type {T[]} */
  const out = [];
  let clamped = 0;
  let dropped = 0;

  for (const cue of cues) {
    let startSec = Number(cue.startSec);
    let endSec = Number(cue.endSec);
    const prev = out.length > 0 ? out[out.length - 1] : null;
    if (prev) {
      const prevSourceEnd = Number(prev.sourceEndSec);
      const sourceStart = Number(cue.sourceStartSec);
      // 有源时间就按源时间判「原本是否重叠」；没有（纯 cue 数组，单测/外部调用）按独立处理。
      const originallySeparate =
        Number.isFinite(prevSourceEnd) && Number.isFinite(sourceStart)
          ? prevSourceEnd <= sourceStart + 1e-6
          : true;
      if (originallySeparate && startSec < prev.endSec) {
        startSec = prev.endSec;
        clamped += 1;
        if (!(endSec > startSec)) {
          const extended = Math.min(limit, startSec + oneFrame);
          if (extended > startSec) endSec = extended;
          else {
            dropped += 1;
            continue;
          }
        }
      }
    }
    out.push({ ...cue, startSec, endSec });
  }

  return { cues: out, clamped, dropped };
}

/**
 * 源时间 → 成片时间。
 *
 * 片段窗口：`[clip.time[0], clip.time[1]]`（源时间轴），映射
 * `t = clip.at + (sourceT - clip.time[0]) / speed`，并夹到 `clip.duration`。
 * 一个 cue 可以跨多个用到同一条素材的片段：每个片段各算一份，重叠部分自然合并
 * （ASS 允许多条 Dialogue 同时出现）。
 *
 * @param {{ sources: SubtitleSource[], clips: any[], durationSec: number,
 *   fps: number | { num: number, den: number } }} input
 * @returns {{ cues: Array<Cue & { clipId: string, sourceStartSec: number, sourceEndSec: number }>,
 *   dropped: number, splitCount: number, skippedCount: number, overlapClamped: number,
 *   overlapDropped: number, warnings: string[] }}
 */
export function mapCuesToTimeline(input) {
  /* P42：cue 落帧格必须用**同一个**有理帧率。整数帧率走 `sec/(1/fps)` 的老表达式
     （`snapSecondsToFrame` 里按 den===1 分派），否则 30fps 的 VTT 会差 1 微秒。 */
  const rate = rateOfFps(input.fps ?? 30);
  const clips = (Array.isArray(input.clips) ? input.clips : []).filter(
    (clip) => clip?.kind === 'video' && Array.isArray(clip?.time) && clip.time.length >= 2,
  );
  /** @type {Map<string, any[]>} */
  const bySrc = new Map();
  for (const clip of clips) {
    const list = bySrc.get(clip.src) ?? [];
    list.push(clip);
    bySrc.set(clip.src, list);
  }

  /** @type {Array<Cue & { clipId: string, sourceStartSec: number, sourceEndSec: number }>} */
  const mapped = [];
  /** @type {string[]} */
  const warnings = [];
  let dropped = 0;
  /* 多段拼接的记账（P40）：
     - `splitCount`：一条 cue 在**同一个片段**的两个窗口里各出一段（= 跨拼接点被切开），
       说明它是"按段裁切"而不是"整条保留"；
     - `skippedCount`：素材在片子里用到了，但这条 cue 一段都没落上（落在被删的间隙里）。
     两者都按**输入 cue** 计数，不按输出条数——输出条数会被拆分放大，看着像 bug。 */
  let splitCount = 0;
  let skippedCount = 0;

  for (const source of input.sources) {
    const usingClips = bySrc.get(source.src) ?? [];
    let mappedForSource = 0;
    /** 每条输入 cue 的输出统计：总段数 + 每个片段各出几段。 */
    const stats = new Map(
      source.cues.map((cue) => [cue, { total: 0, perClip: /** @type {Map<string, number>} */ (new Map()) }]),
    );
    for (const clip of usingClips) {
      const inSec = Number(clip.time[0]);
      const outSec = Number(clip.time[1]);
      const speed = Number(clip.speed) > 0 ? Number(clip.speed) : 1;
      const at = Number(clip.at) || 0;
      const clipEnd = at + Number(clip.duration ?? (outSec - inSec) / speed);
      const clipKey = String(clip.id);
      for (const cue of source.cues) {
        const from = Math.max(cue.startSec, inSec);
        const to = Math.min(cue.endSec, outSec);
        if (!(to > from)) continue;
        const start = at + (from - inSec) / speed;
        const end = Math.min(at + (to - inSec) / speed, clipEnd);
        if (!(end > start + 1e-6)) continue;
        // 对齐到帧边界，且**向外取整**（起点 floor、终点 ceil）：
        // 宁可多显示半帧，也不能因为四舍五入把句首/句尾吞掉。
        const snappedStart = Math.max(0, snapSecondsToFrame(rate, start, 'floor'));
        const snappedEnd = Math.min(input.durationSec, snapSecondsToFrame(rate, end, 'ceil'));
        if (!(snappedEnd > snappedStart)) continue;
        mapped.push({
          index: cue.index,
          startSec: snappedStart,
          endSec: snappedEnd,
          text: cue.text,
          id: cue.id,
          clipId: String(clip.id),
          sourceStartSec: from,
          sourceEndSec: to,
        });
        const bucket = stats.get(cue);
        if (bucket) {
          bucket.total += 1;
          bucket.perClip.set(clipKey, (bucket.perClip.get(clipKey) ?? 0) + 1);
        }
        mappedForSource += 1;
      }
    }
    for (const bucket of stats.values()) {
      if (usingClips.length > 0 && bucket.total === 0) skippedCount += 1;
      for (const count of bucket.perClip.values()) {
        if (count > 1) {
          splitCount += 1;
          break;
        }
      }
    }
    if (usingClips.length === 0) dropped += source.cues.length;
    else if (mappedForSource === 0) {
      warnings.push(
        `${input.sources.length > 1 ? `${source.path.split('/').pop()}: ` : ''}all ${source.cues.length} cue(s) fall outside the clip window (source ${source.cues[0]?.startSec}s-${source.cues[source.cues.length - 1]?.endSec}s): nothing burned`,
      );
    }
  }

  mapped.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);

  /* 同轨单调（P43）：按 clipId 分组。多段拼接是**同一个片段**的多个窗口（计划层给同一个
     clip.id），合成一条轨按时间顺序排，段与段之间也要首尾相接；不同片段各自成组——
     两条互不相干的轨，没有理由因为对方的结尾把自己推迟。 */
  /** @type {Map<string, any[]>} */
  const byClip = new Map();
  for (const cue of mapped) {
    const key = String(cue.clipId ?? '');
    const list = byClip.get(key) ?? [];
    list.push(cue);
    byClip.set(key, list);
  }
  /** @type {Array<Cue & { clipId: string, sourceStartSec: number, sourceEndSec: number }>} */
  const cues = [];
  let overlapClamped = 0;
  let overlapDropped = 0;
  for (const group of byClip.values()) {
    const clampedGroup = clampCueOverlaps(group, { rate, durationSec: input.durationSec });
    overlapClamped += clampedGroup.clamped;
    overlapDropped += clampedGroup.dropped;
    cues.push(...clampedGroup.cues);
  }
  cues.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);

  const totalCues = input.sources.reduce((sum, source) => sum + source.cues.length, 0);
  if (totalCues > 0 && cues.length === 0 && warnings.length === 0) {
    warnings.push(
      `all ${totalCues} subtitle cues fall outside the film window (0-${input.durationSec}s): nothing will be burned`,
    );
  } else if (dropped > 0) {
    warnings.push(`${dropped} subtitle cues belong to clips that are not in the film plan and were skipped`);
  }
  if (splitCount > 0) {
    warnings.push(`${splitCount} subtitle cue(s) crossed a cut and were split per segment (each part burned once)`);
  }
  if (skippedCount > 0) {
    warnings.push(`${skippedCount} subtitle cue(s) fell in a removed range and were skipped`);
  }
  if (overlapClamped > 0) {
    warnings.push(
      `${overlapClamped} subtitle cue(s) were clamped to the previous cue's end on the same track (fractional fps grid)`,
    );
  }
  if (overlapDropped > 0) {
    warnings.push(`${overlapDropped} subtitle cue(s) collapsed to zero length after clamping and were dropped`);
  }
  return { cues, dropped, splitCount, skippedCount, overlapClamped, overlapDropped, warnings };
}

/**
 * ASS 时间戳：`h:mm:ss.cc`（百分秒，libass 的精度）。
 * @param {number} sec
 * @returns {string}
 */
export function formatAssTime(sec) {
  const clamped = Math.max(0, Number(sec) || 0);
  const totalCs = Math.round(clamped * 100);
  const cs = totalCs % 100;
  const totalSec = (totalCs - cs) / 100;
  const s = totalSec % 60;
  const totalMin = (totalSec - s) / 60;
  const m = totalMin % 60;
  const h = (totalMin - m) / 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/**
 * ASS 文本转义：`{`/`}` 是覆盖块标记，必须转义；换行用 `\N`。
 * @param {string} text
 */
function escapeAssText(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .split(/\r?\n/)
    .join('\\N');
}

/**
 * 样式入参归一：未知键直接报错（静默忽略会让人以为生效了）。
 * @param {any} input
 * @returns {SubtitleStyle}
 */
export function resolveSubtitleStyle(input) {
  /** @type {SubtitleStyle} */
  const style = { ...SUBTITLE_STYLE_DEFAULTS };
  if (input === undefined || input === null) return style;
  if (typeof input !== 'object') {
    throw new SubtitleError('SUBTITLE_UNSUPPORTED', 'subtitle style must be an object');
  }
  const numeric = /** @type {const} */ (['fontSizeRatio', 'bottomSafeRatio', 'strokeWidthRatio', 'shadowRatio', 'lineHeight', 'fontScale', 'cpsWarn']);
  for (const key of numeric) {
    if (input[key] === undefined) continue;
    const value = Number(input[key]);
    if (!Number.isFinite(value) || value < 0) {
      throw new SubtitleError('SUBTITLE_UNSUPPORTED', `subtitle style ${key} must be a non-negative number`);
    }
    style[key] = value;
  }
  // 旧口径：只有显式给了才覆盖（`null`/`undefined` 都表示"走 strokeWidthRatio"）。
  if (input.outlineRatio !== undefined && input.outlineRatio !== null) {
    const legacy = Number(input.outlineRatio);
    if (!Number.isFinite(legacy) || legacy < 0) {
      throw new SubtitleError('SUBTITLE_UNSUPPORTED', 'subtitle style outlineRatio must be a non-negative number');
    }
    style.outlineRatio = legacy;
  }
  if (input.fontFamily !== undefined) {
    const family = String(input.fontFamily).trim();
    if (family === '') throw new SubtitleError('SUBTITLE_UNSUPPORTED', 'subtitle style fontFamily is empty');
    style.fontFamily = family;
  }
  if (input.bold !== undefined) style.bold = Boolean(input.bold);
  return style;
}

/**
 * `--subtitle-style` 的内联写法：一段 JSON，或 `k=v,k=v`（`@file` 由 CLI 先读盘再传进来）。
 *
 * 值是**弱类型**的：`bold` 认 `1/0/true/false`，其余能转成有限数就转，转不了保留字符串
 * （颜色、字体名、align 都是字符串）。这里不校验字段语义——那一步归
 * `normalizeSubtitleStyle`，它给出的 issues 会变成带字段名的 warning。
 *
 * @param {string | undefined} raw
 * @returns {any}
 */
export function parseStyleArg(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
  const text = String(raw).trim();
  if (text.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new SubtitleError('SUBTITLE_UNSUPPORTED', `--subtitle-style is not valid JSON: ${/** @type {any} */ (err)?.message ?? err}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SubtitleError('SUBTITLE_UNSUPPORTED', '--subtitle-style JSON must be an object of style fields');
    }
    return parsed;
  }
  /** @type {Record<string, any>} */
  const out = {};
  for (const part of text.split(',')) {
    const item = part.trim();
    if (item === '') continue;
    const eq = item.indexOf('=');
    if (eq <= 0) throw new SubtitleError('SUBTITLE_UNSUPPORTED', `--subtitle-style item "${item}" is not key=value`);
    const key = item.slice(0, eq).trim();
    const value = item.slice(eq + 1).trim();
    if (key === 'bold') {
      out[key] = value === '1' || value.toLowerCase() === 'true';
      continue;
    }
    const numeric = Number(value);
    out[key] = value !== '' && Number.isFinite(numeric) ? numeric : value;
  }
  return out;
}

/**
 * 旧 `style`（P23 口径）→ S41 的新 schema。
 *
 * 只映射**用户能调的那几个旋钮**，其余（颜色、对齐、maxLines、cpsWarn…）直接用 S41 的默认值：
 * 旧入口从来没有颜色/对齐旋钮，它们一直是 buildAssDocument 里写死的，现在改成读单一来源。
 *
 * `outlineRatio` 是唯一需要特别对待的：旧字段相对**画面高**，新字段相对**字号**，
 * 不能直接透传。默认走 `strokeWidthRatio`（≡ 新 `outlineRatio`）；旧字段显式给值时，
 * 在 `resolveAssStyleFields` 里按老公式覆盖 `outlinePx`，并保留"相对画面高"的语义。
 *
 * @param {SubtitleStyle} style
 * @returns {any} 可直接交给 `toAssStyle` 的 S41 样式
 */
function legacyStyleToCanonical(style) {
  return {
    ...CANONICAL_SUBTITLE_STYLE,
    assFontName: style.fontFamily,
    fontSizeRatio: style.fontSizeRatio,
    outlineRatio: style.strokeWidthRatio,
    shadowRatio: style.shadowRatio,
    lineHeight: style.lineHeight,
    bottomSafeRatio: style.bottomSafeRatio,
    fontScale: style.fontScale,
    bold: style.bold,
  };
}

/**
 * 样式 + 几何 → ASS 字段。**唯一换算入口**（S41 的 `toAssStyle`）。
 *
 * 两种入口二选一，同时给就报 `E_USAGE`（不许猜用户想要哪一种）：
 * - `subtitleStyle`：S41 的新 schema（CLI `--subtitle-style` 走这条）；
 * - `style`：P23 的旧 schema（程序化调用，保留兼容）。
 *
 * `layout.stage` / `size` / `layout.fit` 决定几何；`toAssStyle` 按 P32 的
 * letterbox/cover 公式算 `scale` 与 `offsetY`。不传 `layout` 时舞台 = 画布（历史行为）。
 *
 * `layout.scale` / `layout.offset` 是 P32 的老参数：给了就按它把舞台映射到画布
 * （用合成画布交给 toAssStyle，保证 scale/offsetY 与传入值一致），不给就按
 * `stage` + `size` + `layout.fit` 自己算。两条路都只调一次 toAssStyle。
 *
 * @param {{
 *   size: { w: number, h: number },
 *   style?: any,
 *   subtitleStyle?: any,
 *   layout?: { stage?: { w: number, h: number }, fit?: string,
 *     scale?: number, offset?: { x?: number, y?: number } } | null,
 * }} input
 * @returns {{
 *   fields: ReturnType<typeof toAssStyle>,
 *   issues: Array<{code: string, field: string, value: unknown, fallback: unknown, message: string}>,
 *   legacy: SubtitleStyle,
 * }}
 */
export function resolveAssStyleFields(input) {
  const hasLegacy = input.style !== undefined && input.style !== null;
  const hasCanonical = input.subtitleStyle !== undefined && input.subtitleStyle !== null;
  if (hasLegacy && hasCanonical) {
    throw new SubtitleError(
      'E_USAGE',
      'subtitle style: pass either `style` (legacy, outlineRatio is relative to picture height) or `subtitleStyle` (S41, relative to font size), not both',
    );
  }

  const size = {
    w: Math.max(2, Math.round(Number(input.size?.w) || 1280)),
    h: Math.max(2, Math.round(Number(input.size?.h) || 720)),
  };
  const layout = input.layout ?? null;
  const stage = layout?.stage
    ? {
        w: Math.max(2, Math.round(Number(layout.stage.w) || size.w)),
        h: Math.max(2, Math.round(Number(layout.stage.h) || size.h)),
      }
    : { ...size };
  /* 显式 scale/offset（P32 老参数）优先：合成一张画布，让 toAssStyle 算出来的
     scale / offsetY 与调用方给的逐位相同。offsetY 为负意味着画面被裁（cover）。 */
  const explicitScale = Number(layout?.scale);
  const explicitOffsetY = Number.isFinite(Number(layout?.offset?.y)) ? Number(layout?.offset?.y) : 0;
  const useExplicit = Number.isFinite(explicitScale) && explicitScale > 0;
  const geometry = useExplicit
    ? {
        stage,
        canvas: { w: stage.w * explicitScale, h: stage.h * explicitScale + 2 * explicitOffsetY },
        fit: explicitOffsetY < 0 ? 'cover' : 'letterbox',
      }
    : { stage, canvas: size, fit: layout?.fit === 'cover' ? 'cover' : 'letterbox' };
  const legacy = resolveSubtitleStyle(hasLegacy ? input.style : undefined);
  const styleInput = hasCanonical ? input.subtitleStyle : legacyStyleToCanonical(legacy);
  const fields = toAssStyle(styleInput, geometry);

  /* 旧口径（相对画面高）显式覆盖：只有 `style.outlineRatio` 给了值才走这里。
     新 schema 没有这条路——它的 `outlineRatio` 由 toAssStyle 按字号换算。 */
  if (hasLegacy && legacy.outlineRatio !== null) {
    fields.outlinePx = Math.max(0, Math.round(stage.h * legacy.outlineRatio * fields.scale));
  }
  return { fields, issues: fields.styleIssues, legacy };
}

/**
 * 舞台的**可见宽**（P67）：`cover` 下舞台放大后左右被裁，能看见的只有 `画布宽 / scale`；
 * `letterbox` 下这个值 ≥ 舞台宽，按舞台宽算（一个字都不多放）。
 *
 * 为什么不能从 `fields.playRes` 反推：P32 的「显式 scale」路径（`export film` 走的就是这条）
 * 里 `playRes` 是**合成画布** `stage.w × scale`，除掉 scale 永远是舞台宽 —— 它描述的是
 * 「舞台按 scale 铺开后多大」，不知道真实交付画布把左右裁掉了多少。
 * 真实画布宽只有调用方手里有（`input.size`），所以由 `subtitleViewFor()` 从
 * `size` + `layout.scale` 算，再显式传进 `planCueLines()`。
 *
 * @param {{ w?: number, h?: number } | null} size 交付画布
 * @param {{ scale?: number, stage?: { w?: number, h?: number } } | null} [layout]
 * @param {{ stage?: { w?: number, h?: number } } | null} [fields]
 * @returns {{ visibleWidth: number } | null} 舞台像素单位；null = 没有缩放信息（旧路径）
 */
export function subtitleViewFor(size, layout, fields) {
  const fromFields = Number(fields?.stage?.w);
  const fromLayout = Number(layout?.stage?.w);
  const stageW = fromFields > 0 ? fromFields : fromLayout > 0 ? fromLayout : 1280;
  const canvasW = Number(size?.w);
  const scale = Number(layout?.scale);
  if (!(canvasW > 0) || !(scale > 0)) return null;
  const visible = canvasW / scale;
  if (!Number.isFinite(visible) || visible <= 0) return null;
  return { visibleWidth: Math.min(stageW, visible) };
}

/**
 * 手搓 fields 的调用方（验收脚本）没有 `size`，只能退一步用 `fields.playRes / scale`。
 * 只在**非显式 scale** 路径下可信（那时 playRes 就是真实画布）。
 *
 * @param {{ stage?: { w?: number, h?: number }, playRes?: { w?: number, h?: number }, scale?: number } | null} fields
 * @returns {number | null}
 */
export function subtitleVisibleWidth(fields) {
  const stageW = Number(fields?.stage?.w) > 0 ? Number(fields?.stage?.w) : 1280;
  const canvasW = Number(fields?.playRes?.w);
  const scale = Number(fields?.scale);
  if (!(canvasW > 0) || !(scale > 0)) return null;
  const visible = canvasW / scale;
  if (!Number.isFinite(visible) || visible <= 0) return null;
  return Math.min(stageW, visible);
}

/**
 * 每条 cue 的行排（P39）。**`planSubtitleLines` 在本文件的唯一调用点**。
 *
 * 为什么必须在烧录前定行：libass **只在空格处断行**（WrapStyle 0/1/2/3 都一样），
 * 纯中文长句在成片里是一行、左右被画布裁掉；而预览的 `overflow-wrap:anywhere` 断成两行。
 * `maxLines` 的 `…` 也没有 ASS 等价物。所以行排是**共享纯函数**
 * `packages/film-core/subtitle-layout.mjs`（ADR-R24-01，冻结），预览与成片吃同一组 `lines`，
 * 预览用 `\n`、ASS 用 `\N`。本文件不写第二套换行/截断——那会立刻变成「预览一套、成片一套」。
 *
 * 舞台用**设计舞台**（`fields.stage`，不传 layout 时就是输出画布），不是交付画布：
 * 行宽是「舞台上的字数」，与 P32 的字号/边距同一次缩放，所以 720p / 竖屏 / 4K 排出来是同一组行。
 *
 * **P67**：`cover` 下舞台横向被裁，行宽必须按**可见宽**排（`subtitleVisibleWidth()`），
 * 否则 1280 排出来的行在 9:16 里只剩中间 405 stage-px，两边被画面切掉（真 bug）。
 * 只改「一行能放多少」，字号/行距一个都不动。
 *
 * @param {Cue[]} cues
 * @param {ReturnType<typeof toAssStyle>} fields `resolveAssStyleFields` 的产出
 * @param {{ visibleWidth?: number } | null} [view] 渲染侧算好的可见宽（`subtitleViewFor()`）
 * @returns {Array<{ index: number, text: string, lines: string[], truncated: boolean,
 *   widthsEm: number[], capacityEm: number, visibleWidth: number | null, maxLines: number,
 *   lineHeightPx: number | null, lineStepPx: number | null, lineStepEm: number,
 *   issues: Array<{code: string, field: string, value: unknown, message: string}> }>}
 */
export function planCueLines(cues, fields, view = null) {
  const stage = fields.stage ?? { w: 1280, h: 720 };
  const explicit = Number(view?.visibleWidth);
  const fallback = subtitleVisibleWidth(fields);
  const visibleWidth = Number.isFinite(explicit) && explicit > 0 ? Math.min(stage.w, explicit) : fallback;
  const viewArg = {
    ...(visibleWidth === null ? {} : { visibleWidth }),
    /* P74：把**成片画布字号**交给计划层，行距的整数像素由 `subtitleLineStepPx()` 一处算出。
       预览侧传折算到预览坐标的同一个字号，两边因此读的是同一条规则、同一个整数。 */
    fontSizePx: Number(fields.fontSizePx),
  };
  return cues.map((cue) => {
    const plan = planSubtitleLines({ text: cue.text, style: fields.style, stage, view: viewArg });
    return {
      index: cue.index,
      text: cue.text,
      lines: plan.lines,
      truncated: plan.truncated,
      widthsEm: plan.widthsEm,
      capacityEm: plan.capacityEm,
      visibleWidth: plan.visibleWidth ?? null,
      maxLines: plan.maxLines,
      lineHeightPx: plan.lineHeightPx ?? null,
      lineStepPx: plan.lineStepPx ?? null,
      lineStepEm: plan.lineStepEm ?? 1,
      issues: plan.issues,
    };
  });
}

/**
 * 把「每条 cue 的行」摊成 ASS 事件列表（P53）。**行距的唯一落点。**
 *
 * ASS 没有行距字段，libass 逐行按 ascender+descender 堆（Heiti SC 恰好 1em，S50 标定），
 * 所以「用户把 lineHeight 调到 1.8，预览变了成片没变」在 `\N` 这条路上**不可能**修好：
 * `\pos` 是**事件级**标签——同一个事件里的多行只会整体平移，不会各自落位。
 *
 * 于是分两条路（判据只认 `film-core/subtitle-layout.mjs` 的 `subtitleLineStep()`，ADR-R37-03）：
 *
 * - `isDefault`（lineHeight 1.25 → em 1）：**原样**走一个事件 + 字面 `\N`，一个字节都不改；
 * - 非默认且多行：**每行一个事件**，`{\pos(x,y)}` 逐行定位。
 *   行距 = `fontSizePx × em`，底边锚定（最后一行 y = 画布高 − MarginV，与今天 libass
 *   自己摆出来的底边逐像素相同），多的行距一律向上扩——字幕长高不该压进底部安全区。
 * - 单行 cue 在两种行距下都不加 `\pos`：一行没有「行距」，加了只会平白改字节。
 *
 * `an=2`（居中）是默认对齐，`\pos` 的锚点就是**行盒底边中点**，所以 x 直接取画布中线，
 * 不需要自己算字宽。
 *
 * @param {Cue[]} cues
 * @param {ReturnType<typeof toAssStyle>} fields
 * @param {{ w: number, h: number }} canvas 交付画布（= PlayRes）
 * @param {{ visibleWidth?: number } | null} [view] 可见宽（`subtitleViewFor()`；P67）
 * @returns {Array<{ cueIndex: number, startSec: number, endSec: number, text: string,
 *   lineIndex: number, lineCount: number, pos: { x: number, y: number } | null }>}
 */
export function planAssEvents(cues, fields, canvas, view = null) {
  const step = subtitleLineStep(fields.style);
  const plans = planCueLines(cues, fields, view);
  const h = Math.max(2, Math.round(Number(canvas?.h) || 720));
  const w = Math.max(2, Math.round(Number(canvas?.w) || 1280));
  /** @type {Array<{ cueIndex: number, startSec: number, endSec: number, text: string, lineIndex: number, lineCount: number, pos: { x: number, y: number } | null }>} */
  const events = [];
  /* 双语（R30）：第 2 行起用 `{\fs<小字号>}` 内联覆盖。ASS 的 Fontsize 只有 Style 一个值，
     逐行不同只能靠内联标签；`\fs` 是**事件级且向后生效**的，所以只在「这一行自己的文本开头」
     写一次。默认样式（secondaryScale=1）→ 0，一个字节都不加。 */
  const secondaryFontSizePx = Number(fields.secondaryFontSizePx) > 0 ? Number(fields.secondaryFontSizePx) : 0;
  /** @param {string} line @param {number} index */
  const decorate = (line, index) =>
    secondaryFontSizePx > 0 && index > 0
      ? `{\\fs${String(secondaryFontSizePx)}}${escapeAssText(line)}`
      : escapeAssText(line);

  for (const [i, cue] of cues.entries()) {
    const lines = (plans[i]?.lines ?? []).filter((line) => line !== '');
    const single = {
      cueIndex: i,
      startSec: cue.startSec,
      endSec: cue.endSec,
      text: toAssText(lines.map(decorate)),
      lineIndex: 0,
      lineCount: lines.length,
      pos: null,
    };
    if (step.isDefault || lines.length <= 1) {
      events.push(single);
      continue;
    }
    /* 行步进按**画布**字号算：fontSizePx 已经是「舞台字号 × scale」，量的是成片像素。
       P74：值由计划层给（`subtitleLineStepPx()` 是唯一取整点），**本函数不再自己乘一次**。
       默认行距下它等于 `fields.fontSizePx`（整数，= libass 自己的行距）。 */
    const plannedStep = Number(plans[i]?.lineStepPx);
    const lineStepPx = plannedStep > 0 ? plannedStep : fields.fontSizePx * step.em;
    const bottomY = h - fields.marginV;
    const centreX = Math.round(w / 2);
    for (const [j, line] of lines.entries()) {
      const y = Math.round((bottomY - (lines.length - 1 - j) * lineStepPx) * 100) / 100;
      events.push({
        cueIndex: i,
        startSec: cue.startSec,
        endSec: cue.endSec,
        text: `{\\pos(${centreX},${y})}${decorate(line, j)}`,
        lineIndex: j,
        lineCount: lines.length,
        pos: { x: centreX, y },
      });
    }
  }
  return events;
}

/**
 * 出 ASS 文档。**样式换算全部由 `resolveAssStyleFields` → S41 的 `toAssStyle` 完成**，
 * 行排由 `planCueLines` → film-core 的 `planSubtitleLines` 完成，
 * 行距由 `planAssEvents` → film-core 的 `subtitleLineStep` 决定；
 * 这里只负责拼文本与时间行；字号/描边/阴影/边距/颜色/对齐/字重/断行一个都不手算。
 *
 * `layout`（P32）：交付画幅和舞台不是同一个尺寸时，字幕的**几何必须按舞台算、
 * 再整体缩放到画面里的位置** —— 与舞台页把 1280×720 的舞台 transform 到输出视口是同一次变换：
 *
 *   PlayRes        = 输出画布（libass 的坐标系就是最终画面）
 *   字号 / 描边 / 阴影 = 舞台尺寸 × 设计比例 × scale
 *   MarginV        = 舞台安全区 × scale + 舞台底边到画布底边的留边 offsetY
 *   MarginH        = 舞台水平安全区 × scale（居中排版时用不到，但别留一个不缩的值）
 *
 * `layout.fit` 只认 `letterbox`（缺省）/`cover`，与 `--fit` 同一个词；不传 `layout` 时
 * 舞台 = 画布（scale=1、offset=0），720p 的 ASS 与 R22 逐字节相同。
 *
 * 样式入口二选一：`style`（旧，outlineRatio 相对画面高）或 `subtitleStyle`（S41，
 * outlineRatio 相对字号）。两个都给 → `E_USAGE`，不许猜。
 *
 * @param {{
 *   cues: Cue[],
 *   size: { w: number, h: number },
 *   style?: any,
 *   subtitleStyle?: any,
 *   generator?: string,
 *   layout?: { stage?: { w: number, h: number }, fit?: string,
 *     scale?: number, offset?: { x?: number, y?: number } } | null,
 * }} input
 * @returns {string}
 */
export function buildAssDocument(input) {
  const { fields } = resolveAssStyleFields(input);
  const w = Math.max(2, Math.round(Number(input.size?.w) || 1280));
  const h = Math.max(2, Math.round(Number(input.size?.h) || 720));

  /** @type {string[]} */
  const lines = [
    '[Script Info]',
    `; generated by opencut ${input.generator ?? 'subtitles.mjs'}`,
    'ScriptType: v4.00+',
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: None',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // SecondaryColour 是卡拉OK 的次色，libass 在无 \k 标签时不用它；ASS 规范要求这一列存在，保留历史值。
    /* BorderStyle：1 = 描边+阴影（历史行为，逐字节不变）；3 = 不透明底框（R30 的「底框 / 高亮词」）。
       3 的时候 `OutlineColour` 就是框色、`Outline` 是框的内边距 —— 由 `toAssStyle` 换好再传下来，
       本文件不自己判颜色（样式 → ASS 的唯一入口仍是 layers 的 `toAssStyle`）。 */
    `Style: Default,${fields.fontName},${fields.fontSizePx},${fields.primaryColour},&H000000FF,${fields.outlineColour},${fields.backColour},${fields.weight},0,0,0,100,100,0,0,${fields.borderStyle ?? 1},${fields.outlinePx},${fields.shadowPx},${fields.alignment},${fields.marginH},${fields.marginH},${fields.marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  /* 行排：先按设计舞台把每条 cue 排成 lines，再**逐行 escape 后**用字面 `\N` 拼。
     顺序不能反——`escapeAssText` 会把反斜杠转义，先拼 `\N` 再 escape 会让换行失效。
     非默认行距走 `planAssEvents` 的逐行 `\pos`（P53）：`\pos` 是事件级标签，
     一个事件里的 `\N` 只会整体平移，所以那里必须一行一个事件。 */
  /* P67：可见宽必须由**真实交付画布**算（`fields.playRes` 在显式 scale 路径下是合成画布）。 */
  const view = subtitleViewFor({ w, h }, input.layout ?? null, fields);
  const events = planAssEvents(input.cues, fields, { w, h }, view);
  for (const event of events) {
    lines.push(
      `Dialogue: 0,${formatAssTime(event.startSec)},${formatAssTime(event.endSec)},Default,,0,0,0,,${event.text}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 回读 ASS（自校验用）：只认我们自己写出来的形状，够用来对账时间与条数。
 * @param {string} text
 * @returns {{ playRes: { w: number, h: number }, fontName: string, fontSize: number, marginV: number,
 *   cues: Array<{ startSec: number, endSec: number, text: string }> }}
 */
export function parseAssDocument(text) {
  const lines = String(text).split(/\r?\n/);
  let playW = 0;
  let playH = 0;
  let fontName = '';
  let fontSize = 0;
  let marginV = 0;
  /** @type {Array<{ startSec: number, endSec: number, text: string }>} */
  const cues = [];
  for (const line of lines) {
    if (line.startsWith('PlayResX:')) playW = Number(line.slice(9).trim());
    else if (line.startsWith('PlayResY:')) playH = Number(line.slice(9).trim());
    else if (line.startsWith('Style: Default,')) {
      const fields = line.slice('Style: Default,'.length).split(',');
      fontName = fields[0] ?? '';
      fontSize = Number(fields[1]);
      marginV = Number(fields[20]);
    } else if (line.startsWith('Dialogue:')) {
      const body = line.slice('Dialogue:'.length);
      const parts = body.split(',');
      // Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
      const startSec = parseAssTime(parts[1] ?? '');
      const endSec = parseAssTime(parts[2] ?? '');
      const textPart = parts.slice(9).join(',');
      cues.push({ startSec, endSec, text: textPart });
    }
  }
  return { playRes: { w: playW, h: playH }, fontName, fontSize, marginV, cues };
}

/**
 * @param {string} raw `h:mm:ss.cc`
 * @returns {number}
 */
function parseAssTime(raw) {
  const match = /^(\d+):(\d{1,2}):(\d{1,2})\.(\d{1,2})$/.exec(String(raw).trim());
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 100;
}

/**
 * 字形覆盖检查：`fc-list :charset=<codepoint>` 有输出 = 系统里有字体覆盖这个字符。
 *
 * **必须排除 `.LastResort`**：macOS 自带一个兜底字体，声称覆盖所有码点，实际画出来
 * 就是豆腐块（hex box）。不排它的话，`fc-list :charset=` 永远返回一行，
 * 缺字检测就变成"永远通过"——这正是最坏的一种假阳性。
 *
 * 语义边界（写进证据，别当成"渲染一定不缺字"）：
 * - 这是**全系统字体**的覆盖，不是 libass 实际选中的那一个；libass 0.17 有 fontconfig
 *   fallback，所以"有字体覆盖"≈"能画出来"。
 * - 机器上没有 `fc-list` 时返回 `NOT_RUN` + 原因，**不假装检过**。
 *
 * @param {{ texts: string[], execFileImpl?: Runner }} input
 * @returns {Promise<{ status: 'ok' | 'missing' | 'NOT_RUN', checked: number,
 *   missing: Array<{ char: string, codePoint: string }>, reason: string | null }>}
 */
export async function checkGlyphCoverage(input) {
  const run = input.execFileImpl ?? DEFAULT_RUNNER;
  /** @type {Set<string>} */
  const chars = new Set();
  for (const text of input.texts) {
    for (const ch of String(text)) {
      if (/\s/.test(ch)) continue;
      chars.add(ch);
    }
  }
  if (chars.size === 0) return { status: 'ok', checked: 0, missing: [], reason: null };

  try {
    await run('fc-list', ['--version']);
  } catch (err) {
    return {
      status: 'NOT_RUN',
      checked: 0,
      missing: [],
      reason: `fontconfig's fc-list is not available: ${/** @type {any} */ (err)?.message ?? err}`,
    };
  }

  /** @type {Array<{ char: string, codePoint: string }>} */
  const missing = [];
  let checked = 0;
  for (const ch of chars) {
    const codePoint = `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;
    // fontconfig 的 charset 语法只吃码点，不吃 "U+" 前缀
    const hex = (ch.codePointAt(0) ?? 0).toString(16);
    try {
      const { stdout } = await run('fc-list', [`:charset=${hex}`, 'family']);
      checked += 1;
      const families = String(stdout)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.includes('.LastResort'));
      if (families.length === 0) missing.push({ char: ch, codePoint });
    } catch (err) {
      return {
        status: 'NOT_RUN',
        checked,
        missing: [],
        reason: `fc-list failed on ${codePoint}: ${/** @type {any} */ (err)?.message ?? err}`,
      };
    }
  }
  return {
    status: missing.length > 0 ? 'missing' : 'ok',
    checked,
    missing,
    reason: null,
  };
}

/**
 * ffmpeg 有没有 `subtitles` 滤镜。
 *
 * 坑：`ffmpeg -h filter=subtitles` 在**没有**这个滤镜时也会 exit 0，
 * 只在输出里写 `Unknown filter 'subtitles'`。所以只能看输出，不能看退出码。
 *
 * @param {string} ffmpegPath
 * @param {Runner} [run] 可注入（测试用；默认真跑 ffmpeg）
 * @returns {Promise<{ ok: boolean, detail: string, version: string | null }>}
 */
export async function probeSubtitleBurnSupport(ffmpegPath = 'ffmpeg', run = DEFAULT_RUNNER) {
  let version = null;
  try {
    const { stdout } = await run(ffmpegPath, ['-hide_banner', '-version']);
    version = String(stdout).split('\n')[0]?.trim() ?? null;
  } catch (err) {
    return {
      ok: false,
      detail: `ffmpeg could not be started (${ffmpegPath}): ${/** @type {any} */ (err)?.message ?? err}`,
      version,
    };
  }
  try {
    const { stdout, stderr } = await run(ffmpegPath, ['-hide_banner', '-h', 'filter=subtitles']);
    const text = `${stdout}\n${stderr}`;
    if (/Unknown filter/i.test(text)) {
      return { ok: false, detail: "ffmpeg has no 'subtitles' filter (built without libass)", version };
    }
    if (!/Render text subtitles/i.test(text)) {
      return { ok: false, detail: "unexpected output from `-h filter=subtitles`", version };
    }
    return { ok: true, detail: "ffmpeg has the 'subtitles' filter (libass)", version };
  } catch (err) {
    return { ok: false, detail: `ffmpeg filter probe failed: ${/** @type {any} */ (err)?.message ?? err}`, version };
  }
}

/**
 * `subtitles` 滤镜参数。路径用单引号包住，避免 `:` 被当成选项分隔符。
 * @param {string} assPath
 * @returns {string}
 */
export function subtitleFilterArg(assPath) {
  const escaped = String(assPath).replace(/\\/g, '/').replace(/'/g, "\\'");
  return `subtitles=filename='${escaped}'`;
}

/**
 * 把映射后的 cue 与统计折成一份可落盘的报告（证据/CLI 共用）。
 * @param {{ cues: any[], sources: SubtitleSource[], warnings: string[], glyph: any, style: SubtitleStyle,
 *   subtitleStyle?: any, assStyle?: any, linePlan?: any, split?: { count: number, skipped: number },
 *   overlap?: { clamped: number, dropped: number },
 *   size: { w: number, h: number } }} input
 */
export function summarizeSubtitles(input) {
  return {
    style: input.style,
    ...(input.subtitleStyle !== undefined ? { subtitleStyle: input.subtitleStyle } : {}),
    ...(input.assStyle !== undefined
      ? {
          assStyle: {
            fontName: input.assStyle.fontName,
            fontSizePx: input.assStyle.fontSizePx,
            outlinePx: input.assStyle.outlinePx,
            shadowPx: input.assStyle.shadowPx,
            marginV: input.assStyle.marginV,
            marginH: input.assStyle.marginH,
            primaryColour: input.assStyle.primaryColour,
            outlineColour: input.assStyle.outlineColour,
            backColour: input.assStyle.backColour,
            alignment: input.assStyle.alignment,
            weight: input.assStyle.weight,
            scale: input.assStyle.scale,
            offsetY: input.assStyle.offsetY,
            fit: input.assStyle.fit,
          },
        }
      : {}),
    ...(input.linePlan !== undefined ? { linePlan: input.linePlan } : {}),
    /* P53：行距的权威换算结果（`film-core/subtitle-layout.mjs` 的 `subtitleLineStep`）。
       证据要「em × Fontsize」，如果让验收脚本自己再算一遍 `lineHeight / 1.25`，
       那就又分叉了——这里直接把它报出来。 */
    ...(input.subtitleStyle !== undefined
      ? { lineStep: subtitleLineStep(input.subtitleStyle) }
      : {}),
    ...(input.split !== undefined ? { splitCount: input.split.count, skippedCount: input.split.skipped } : {}),
    // P43：落帧格后因同轨单调被推回去的 cue 数（0 时也写出来，便于对照）
    ...(input.overlap !== undefined
      ? { overlapClamped: input.overlap.clamped, overlapDropped: input.overlap.dropped }
      : {}),
    size: input.size,
    sources: input.sources.map((source) => ({
      clipId: source.clipId,
      path: source.path,
      format: source.format,
      cues: source.cues.length,
    })),
    cueCount: input.cues.length,
    firstCueSec: input.cues.length > 0 ? input.cues[0].startSec : null,
    lastCueSec: input.cues.length > 0 ? input.cues[input.cues.length - 1].endSec : null,
    warnings: input.warnings,
    glyph: input.glyph,
  };
}

/**
 * 成片时间轴的旁挂 VTT（三件套里的 `.vtt`）。
 *
 * 为什么不是"原样复制素材的 vtt"：素材 vtt 的时间是**源时间**，成片有时间线起点、
 * 入点和变速。原样复制会让播放器按成片时间读源时间，字幕整体错位。这里输出的是
 * 已经映射到成片时间的规范版；`sourceStartSec/sourceEndSec` 留在报告里可回溯。
 *
 * @param {{ cues: Array<{ startSec: number, endSec: number, text: string }> }} input
 * @returns {string}
 */
export function buildVttDocument(input) {
  /** @type {string[]} */
  const lines = ['WEBVTT', ''];
  let index = 0;
  for (const cue of input.cues) {
    index += 1;
    lines.push(String(index));
    lines.push(`${formatVttTime(cue.startSec)} --> ${formatVttTime(cue.endSec)}`);
    lines.push(String(cue.text).replace(/\r\n?/g, '\n'));
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * `hh:mm:ss.mmm`
 * @param {number} sec
 */
export function formatVttTime(sec) {
  const clamped = Math.max(0, Number(sec) || 0);
  const totalMs = Math.round(clamped * 1000);
  const ms = totalMs % 1000;
  const totalSec = (totalMs - ms) / 1000;
  const s = totalSec % 60;
  const totalMin = (totalSec - s) / 60;
  const m = totalMin % 60;
  const h = (totalMin - m) / 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/**
 * 工程样式文件里**顶层**写了哪些样式字段（P68）。
 *
 * `readProjectSubtitleStyle()` 对 `both` 只报 `TOP_LEVEL_SHADOWED`，不列被遮蔽的字段名
 * （它的返回里没有这个数组，而它不在本批 owner），审计要精确到字段，所以这里只读一次文件。
 *
 * @param {string} projectRoot
 * @returns {Promise<string[]>}
 */
async function topLevelStyleFields(projectRoot) {
  if (typeof projectRoot !== 'string' || projectRoot === '') return [];
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(projectRoot, SUBTITLE_STYLE_FILE), 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return STYLE_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(parsed, field)).sort();
  } catch {
    return [];
  }
}

/**
 * P68：把「样式为什么没生效」压成**写进产物**的审计对象。
 *
 * 输出形状固定为 `{shape, ignoredFields, shadowedFields, warnings}`，四个字段永远都在
 * （正常时也要写 `{shape:'normal', ignoredFields:[], shadowedFields:[], warnings:[]}`）——
 * 只有出错时才写的字段，等于让下游先判空再猜。
 *
 * `shape` 是**给用户看**的归一化词：
 * - `normal`：文件正确包裹在 `{style:{…}}`（或只有 version / 空文件）；
 * - `top-level`：字段直接写在顶层、没有 `style` 键 → 被忽略，用默认样式；
 * - `shadowed`：`style` 与顶层字段并存 → 用 `style`，顶层被遮蔽；
 * - `absent`：没有样式文件；
 * - `explicit`：命令行/请求里显式给了样式（文件不参与）。
 *
 * @param {{ audit?: any, warnings?: string[] } | null} styleSource `resolveSubtitleStyle()` 的返回
 * @param {{ projectRoot?: string }} [opts]
 */
export async function subtitleStyleAuditReport(styleSource, opts = {}) {
  const audit = styleSource?.audit ?? {};
  const origin = String(audit.origin ?? 'default');
  const raw = String(audit.shape ?? 'missing');
  const shape = origin === 'explicit'
    ? 'explicit'
    : raw === 'wrapped' || raw === 'empty'
      ? 'normal'
      : raw === 'top-level'
        ? 'top-level'
        : raw === 'both'
          ? 'shadowed'
          : 'absent';
  const ignoredFields = shape === 'top-level' && Array.isArray(audit.ignoredFields)
    ? [...audit.ignoredFields].sort()
    : [];
  const shadowedFields = shape === 'shadowed' ? await topLevelStyleFields(opts.projectRoot ?? '') : [];
  const warnings = Array.isArray(styleSource?.warnings) ? [...styleSource.warnings] : [];
  return { shape, ignoredFields, shadowedFields, warnings };
}

/**
 * 工程样式文件的形状警告 → 人读的一句话（P65）。
 *
 * 只在**采用工程文件**时才有意义：显式 `--subtitle-style` 优先，文件里写错什么都不该
 * 干扰这次导出。所以调用方只在 style 来自文件（或默认）时把 audit 传进来。
 *
 * @param {any} audit `resolveSubtitleStyle()` 返回的 audit
 * @returns {string[]}
 */
export function auditWarningsOf(audit) {
  const codes = Array.isArray(audit?.warnings) ? audit.warnings : [];
  const fields = Array.isArray(audit?.ignoredFields) ? audit.ignoredFields : [];
  const list = fields.length > 0 ? fields.join(', ') : '(none)';
  return /** @type {string[]} */ (codes).map((code) => {
    if (code === 'TOP_LEVEL_STYLE_IGNORED') {
      return `subtitle style: ${SUBTITLE_STYLE_HINT} top-level field(s) ignored: ${list}; using default style`;
    }
    if (code === 'TOP_LEVEL_SHADOWED') {
      return `subtitle style: ${SUBTITLE_STYLE_HINT} top-level field(s) shadowed by "style": ${list}`;
    }
    return `subtitle style: ${code}`;
  });
}

/** 警告里重复出现的提示语，只写一次。 */
export const SUBTITLE_STYLE_HINT = '.film/subtitle-style.json must wrap fields in {"style":{...}};';

/**
 * 烧录前的完整准备：能力探测 → 找旁挂 → 解析 → 时间映射 → 字形检查 → 写 ASS。
 *
 * 任何一步的失败都用**稳定错误码**报出来（`SUBTITLE_*`），绝不"跳过字幕继续导"——
 * 用户要的是带字幕的片子，悄悄给一份没字幕的等于骗人。
 *
 * @param {{
 *   plan: any,
 *   style?: any,
 *   subtitleStyle?: any,
 *   size: { w: number, h: number },
 *   layout?: { stage?: { w: number, h: number }, fit?: string },
 *   assPath: string,
 *   ffmpegPath?: string,
 *   projectRoot?: string,
 *   execFileImpl?: typeof execFileAsync,
 *   styleAudit?: any,
 * }} input `style` 是 P23 旧 schema；`subtitleStyle` 是 S41 新 schema（CLI 走这条）。
 * @returns {Promise<{
 *   assPath: string,
 *   assSha256: string,
 *   cues: any[],
 *   sources: SubtitleSource[],
 *   warnings: string[],
 *   glyph: any,
 *   support: { ok: boolean, detail: string, version: string | null },
 *   style: SubtitleStyle,
 *   subtitleStyle: any,
 *   assStyle: any,
 *   splitCount: number,
 *   skippedCount: number,
 *   overlapClamped: number,
 *   overlapDropped: number,
 *   linePlan: any[],
 *   report: any,
 * }>}
 */
export async function prepareSubtitleBurn(input) {
  /* P70：解析顺序 OPENCUT_FFMPEG → <project>/bin/ffmpeg → PATH（显式 --ffmpeg-path 优先），
     然后用 `-filters` 的硬门禁判 libass。没有就抛 BURN_UNAVAILABLE —— 绝不跳过字幕出片。 */
  let burnInfo;
  try {
    burnInfo = await assertBurnCapable({
      ...(input.ffmpegPath ? { explicit: input.ffmpegPath } : {}),
      ...(typeof input.projectRoot === 'string' && input.projectRoot !== '' ? { projectRoot: input.projectRoot } : {}),
    });
  } catch (error) {
    const err = /** @type {any} */ (error);
    const suggestions = Array.isArray(err?.suggestions) && err.suggestions.length ? err.suggestions : [...BURN_SUGGESTIONS];
    const wrapped = new SubtitleError(
      'SUBTITLE_BURN_UNAVAILABLE',
      `${String(err?.message ?? err)} | fix: ${suggestions.join(' OR ')}`,
    );
    /* 产品面的码是 BURN_UNAVAILABLE；`SUBTITLE_*` 是 contracts/cli 里已经登记的那个码，
       本批 cli 与 contracts 都在禁区，不能把新码塞进白名单 —— 两个都给出来。 */
    /** @type {any} */ (wrapped).burnCode = 'BURN_UNAVAILABLE';
    /** @type {any} */ (wrapped).suggestions = suggestions;
    throw wrapped;
  }
  const support = {
    ok: true,
    detail: `ffmpeg has the 'subtitles' filter (libass); ${burnInfo.version ?? 'unknown version'}; source=${burnInfo.source}`,
    version: burnInfo.version,
  };

  const found = await discoverSubtitles(input.plan);
  if (found.sources.length === 0) {
    throw new SubtitleError(
      'SUBTITLE_UNSUPPORTED',
      `no sidecar subtitle next to any video clip (looked for .vtt then .srt); clips: ${
        found.videosWithoutSubtitle.join(', ') || '(none)'
      }`,
    );
  }

  const loaded = await loadSubtitleSources(found.sources);
  // P42：帧率的有理数形态优先（29.97 → 30000/1001），字幕网格与成片同一张网格
  const fps = input.plan?.fpsRational ?? input.plan?.fps ?? 30;
  const durationSec = Number(input.plan?.outputDuration ?? input.plan?.duration) || 0;
  const mapped = mapCuesToTimeline({
    sources: loaded.sources,
    clips: Array.isArray(input.plan?.visualClips) ? input.plan.visualClips : [],
    durationSec,
    fps,
  });
  /* 样式在写 ASS 之前先归一：非法值走 S41 的 issues → 回退默认 + warning。
     只写日志不算数，warning 必须进结果的 warnings 数组（调用方/证据都读 JSON）。 */
  const resolvedStyle = resolveAssStyleFields({
    size: input.size,
    ...(input.style !== undefined ? { style: input.style } : {}),
    ...(input.subtitleStyle !== undefined ? { subtitleStyle: input.subtitleStyle } : {}),
    ...(input.layout ? { layout: input.layout } : {}),
  });
  const styleWarnings = resolvedStyle.issues.map((issue) =>
    issue.field
      ? `subtitle style ${issue.field}: ${issue.message}; using default`
      : `subtitle style: ${issue.message}; using default`,
  );
  const style = resolvedStyle.legacy;
  /* 行排（P39）：与 buildAssDocument 同一套参数（设计舞台 + 归一后的 style），
     这里再算一次只为把「排了几行 / 有没有截断」写进报告；ass 里的 `\N` 由同一函数产出。 */
  /* P67：同一份可见宽喂给「行排」与「回读对账」——两处必须走同一组行，否则事件条数会对不上。 */
  const view = subtitleViewFor(input.size, input.layout ?? null, resolvedStyle.fields);
  const cuePlans = planCueLines(mapped.cues, resolvedStyle.fields, view);
  /** @type {string[]} */
  const layoutWarnings = [];
  for (const [i, plan] of cuePlans.entries()) {
    for (const issue of plan.issues) {
      const message = `subtitle layout cue ${i + 1}: ${issue.message}`;
      if (!layoutWarnings.includes(message)) layoutWarnings.push(message);
    }
  }
  const glyph = await checkGlyphCoverage({
    texts: mapped.cues.map((cue) => cue.text),
    ...(input.execFileImpl ? { execFileImpl: input.execFileImpl } : {}),
  });
  if (glyph.status === 'missing') {
    const chars = glyph.missing.map((entry) => `${entry.char}(${entry.codePoint})`);
    throw new SubtitleError(
      'SUBTITLE_MISSING_GLYPH',
      `no installed font covers ${chars.length} character(s): ${chars.slice(0, 20).join(' ')}`,
      { chars: glyph.missing.map((entry) => entry.char) },
    );
  }

  const ass = buildAssDocument({
    cues: mapped.cues,
    size: input.size,
    ...(input.subtitleStyle !== undefined ? { subtitleStyle: input.subtitleStyle } : { style }),
    ...(input.layout ? { layout: input.layout } : {}),
  });
  await fs.mkdir(path.dirname(input.assPath), { recursive: true });
  await fs.writeFile(input.assPath, ass, 'utf8');

  /* 回读对账：写出去的 ASS 与内存里的 cue 必须一一对上（时间 ±10ms，条数严格相等）。
     P53 起「一条 cue」在非默认行距下会摊成**每行一个事件**（`\pos` 是事件级标签），
     所以对账的基准是 `planAssEvents` 的事件表，不是 cue 条数——拿 cue 条数当基准会把
     正常的逐行定位误判成「ASS 少写了几条」。 */
  const readback = parseAssDocument(ass);
  const expectedEvents = planAssEvents(mapped.cues, resolvedStyle.fields, input.size, view);
  if (readback.cues.length !== expectedEvents.length) {
    throw new SubtitleError(
      'SUBTITLE_PARSE_FAILED',
      `ASS readback has ${readback.cues.length} events, expected ${expectedEvents.length} (from ${mapped.cues.length} cues)`,
    );
  }
  for (const [i, event] of expectedEvents.entries()) {
    const back = readback.cues[i];
    if (back === undefined) continue;
    if (Math.abs(back.startSec - event.startSec) > 0.01 || Math.abs(back.endSec - event.endSec) > 0.01) {
      throw new SubtitleError(
        'SUBTITLE_PARSE_FAILED',
        `ASS readback event ${i + 1} is ${back.startSec}-${back.endSec}s, expected ${event.startSec}-${event.endSec}s`,
      );
    }
  }

  /* P65：工程样式文件「形状不对」的警告（顶层写了字段 / 顶层被 style 遮蔽）。
     它不属于「归一化 issues」——归一化根本没看到那些字段；必须由读取端一路带到这里，
     再进 result.warnings（CLI 会打 `warning: …`，证据读 JSON）。 */
  const styleAuditWarnings = auditWarningsOf(input.styleAudit);
  const warnings = [...loaded.warnings, ...mapped.warnings, ...styleWarnings, ...styleAuditWarnings, ...layoutWarnings];
  const report = summarizeSubtitles({
    cues: mapped.cues,
    sources: loaded.sources,
    warnings,
    glyph,
    style,
    subtitleStyle: resolvedStyle.fields.style,
    assStyle: resolvedStyle.fields,
    linePlan: {
      module: 'film-core/subtitle-layout',
      stage: resolvedStyle.fields.stage,
      maxLines: resolvedStyle.fields.style.maxLines,
      visibleWidth: view === null ? null : Number(view.visibleWidth.toFixed(4)),
      truncatedCues: cuePlans.filter((plan) => plan.truncated).length,
      multiLineCues: cuePlans.filter((plan) => plan.lines.length > 1).length,
      cues: cuePlans.map((plan) => ({
        index: plan.index,
        lines: plan.lines,
        truncated: plan.truncated,
        widthsEm: plan.widthsEm,
        capacityEm: Number(plan.capacityEm.toFixed(3)),
        visibleWidth: plan.visibleWidth ?? null,
        issues: plan.issues.map((issue) => issue.code),
      })),
    },
    split: { count: mapped.splitCount, skipped: mapped.skippedCount },
    overlap: { clamped: mapped.overlapClamped, dropped: mapped.overlapDropped },
    size: input.size,
  });
  const digest = await import('node:crypto').then((mod) => mod.createHash('sha256').update(ass, 'utf8').digest('hex'));
  return {
    assPath: input.assPath,
    assSha256: digest,
    cues: mapped.cues,
    sources: loaded.sources,
    warnings,
    glyph,
    support,
    style,
    subtitleStyle: resolvedStyle.fields.style,
    assStyle: resolvedStyle.fields,
    splitCount: mapped.splitCount,
    skippedCount: mapped.skippedCount,
    overlapClamped: mapped.overlapClamped,
    overlapDropped: mapped.overlapDropped,
    linePlan: cuePlans,
    report: {
      ...report,
      ...(input.styleAudit !== undefined ? { styleAudit: input.styleAudit } : {}),
      ass: { path: input.assPath, sha256: digest, bytes: Buffer.byteLength(ass, 'utf8') },
    },
    ...(input.styleAudit !== undefined ? { styleAudit: input.styleAudit } : {}),
  };
}
