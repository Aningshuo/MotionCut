/**
 * FCPXML 1.9 导出（P22）。
 *
 * 目的：时间线能拿到别的 NLE 里继续剪——"作品不锁死在这个工具里"。
 * 这里只做**结构转换**：不做媒体转码、不内嵌素材、不猜。
 *
 * 口径：
 * - 版本固定 1.9（兼容面最广）。`<fcpxml><resources><library><event><project><sequence><spine>`。
 * - 时间一律 rational：30fps 下 1 秒 = `30/30s`，8 秒 = `240/30s`，7.5 秒 = `225/30s`。
 *   分子是帧数、分母是帧率，**不做约分**（`8/1s` 虽然等价，但不是 FCP 的写法）。
 * - 每个视觉片段一个 `<asset-clip>`，`name` 用片段 id，`offset` 是时间线位置，
 *   `start` 是素材内入点，`duration` 是时间线长度。
 * - 素材进 `<resources>` 的 `<asset>`，`src` 用 `file://` 绝对路径。
 * - **网页片段（sceneClips）没有对应媒体文件**：降级成 `<gap>` + `note`，
 *   并在 `unsupported[]` 里逐条记账。不假装能导。
 * - 音频片段也是 `<asset-clip>`，带 `audioRole`，挂在连接道上。
 * - 轨道分配用贪心装箱：同一 lane 上的片段不重叠；主故事线（lane 0）用 `<gap>` 填空，
 *   保证它是连续的（FCPXML 对主故事线的要求）。
 *
 * **没有验证过的东西**：本机没有 FCP / DaVinci，所以"能不能真的打开"是 NOT_RUN，
 * 不许在这里写"已验证"。能验的只有：well-formed（xmllint）、回读结构与本 plan 一致。
 */

import { pathToFileURL } from 'node:url';

export const FCPXML_MODULE_VERSION = '1.0.0';
export const FCPXML_DTD_VERSION = '1.9';

/**
 * @typedef {Object} FrameRate
 * @property {number} num 帧时长的分子
 * @property {number} den 帧时长的分母
 * @property {number} fps 用于换算的帧率（整数或 29.97 这类）
 * @property {string} frameDuration FCPXML 的 frameDuration 字面量
 */

/**
 * 帧率 → FCPXML 的帧时长。
 *
 * 整数帧率最简单（1/30s）；29.97 / 23.976 / 59.94 这类 NTSC 帧率必须写成 1001/30000。
 * 不认识的帧率直接抛错：宁可不导，也不要写一个 "29.97/1s" 这种 NLE 读不了的怪东西。
 * @param {unknown} fps
 * @returns {FrameRate}
 */
export function frameRateOf(fps) {
  const value = Number(fps);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`fcpxml: invalid fps ${String(fps)}`);
  if (Number.isInteger(value)) return { num: 1, den: value, fps: value, frameDuration: `1/${value}s` };
  const ntsc = [
    { exact: 24000 / 1001, num: 1001, den: 24000 },
    { exact: 30000 / 1001, num: 1001, den: 30000 },
    { exact: 60000 / 1001, num: 1001, den: 60000 },
  ];
  for (const rate of ntsc) {
    if (Math.abs(value - rate.exact) < 0.01) {
      return { num: rate.num, den: rate.den, fps: rate.exact, frameDuration: `${rate.num}/${rate.den}s` };
    }
  }
  throw new Error(`fcpxml: unsupported fps ${value} (integer, 23.976, 29.97, 59.94 only)`);
}

/**
 * 秒 → 帧数。四舍五入到整帧：FCPXML 不接受小数帧。
 * @param {number} seconds
 * @param {number} fps
 * @returns {number}
 */
export function framesOf(seconds, fps) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * fps);
}

/**
 * 秒 → rational time 字面量。30fps 下 1 秒 = `30/30s`。
 * @param {number} seconds
 * @param {FrameRate} rate
 * @returns {string}
 */
export function rationalTime(seconds, rate) {
  const frames = framesOf(seconds, rate.fps);
  return `${frames * rate.num}/${rate.den}s`;
}

/**
 * @param {string} text
 * @returns {string}
 */
function xmlEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

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
 * FCPXML 的 `FFVideoFormat<w>x<h>p<fps>` 名字。按 Apple 的命名习惯给一个；
 * 名字只是给人看的，真正的约束是 frameDuration/width/height。
 * @param {{ w: number, h: number }} stage
 * @param {number} fps
 * @returns {string}
 */
function formatName(stage, fps) {
  const rate = Number.isInteger(fps) ? String(fps) : String(Math.round(fps * 100) / 100);
  return `FFVideoFormat${stage.w}x${stage.h}p${rate}`;
}

/**
 * 把一个片段的 [start, end) 区间放到某条 lane 上（同 lane 不重叠）。
 * @param {Array<Array<{ start: number, end: number }>>} lanes
 * @param {number} start
 * @param {number} end
 * @param {number} fromIndex 从第几条 lane 开始试（0 = 主故事线）
 * @returns {number} lane 下标（0 表示主故事线）
 */
function allocLane(lanes, start, end, fromIndex) {
  for (let i = fromIndex; i < lanes.length; i += 1) {
    const lane = lanes[i] ?? [];
    const clash = lane.some((span) => start < span.end - 1e-9 && end > span.start + 1e-9);
    if (!clash) {
      lane.push({ start, end });
      lanes[i] = lane;
      return i;
    }
  }
  lanes.push([{ start, end }]);
  return lanes.length - 1;
}

/**
 * plan → FCPXML 1.9 字符串。
 *
 * @param {any} plan `planFromFilm` 的输出
 * @param {{
 *   projectName?: string,
 *   eventName?: string,
 *   libraryName?: string,
 *   assets?: Array<{ src: string, durationSec?: number | null, hasAudio?: boolean, hasVideo?: boolean, name?: string }>,
 * }} [opts]
 * @returns {string}
 */
export function buildFcpxml(plan, opts = {}) {
  if (!plan || typeof plan !== 'object') throw new TypeError('buildFcpxml: plan is required');
  const fpsRaw = Number(plan.fps) || 30;
  const rate = frameRateOf(fpsRaw);
  const stage = {
    w: Number(plan.stage?.w) > 0 ? Number(plan.stage.w) : 1920,
    h: Number(plan.stage?.h) > 0 ? Number(plan.stage.h) : 1080,
  };
  const totalSec = Number(plan.outputDuration ?? plan.duration) || 0;
  const totalFrames = framesOf(totalSec, rate.fps);

  const visualClips = Array.isArray(plan.visualClips) ? plan.visualClips : [];
  const sceneClips = Array.isArray(plan.sceneClips) ? plan.sceneClips : [];
  const audioClips = Array.isArray(plan.audioMix?.clips) ? plan.audioMix.clips : [];

  /** @type {Array<{ src: string, durationSec: number, hasAudio: boolean, hasVideo: boolean, name: string }>} */
  const assets = [];
  const assetBySrc = new Map();
  const given = Array.isArray(opts.assets) ? opts.assets : [];

  /**
   * @param {string} src
   * @param {number} requiredSec 片段至少要用到这么长
   * @param {{ hasAudio: boolean, hasVideo: boolean }} hint 这条素材是**怎么被用到的**
   * @returns {string} asset id
   */
  const ensureAsset = (src, requiredSec, hint) => {
    const known = assetBySrc.get(src);
    if (known) {
      const asset = assets[known.index];
      if (asset) {
        if (requiredSec > asset.durationSec) asset.durationSec = round(requiredSec, 6);
        // 同一条素材被画面和音频同时用到时，两个标志都要立起来
        if (hint.hasAudio) asset.hasAudio = true;
        if (hint.hasVideo) asset.hasVideo = true;
      }
      return known.id;
    }
    const probe = given.find((a) => a && a.src === src);
    const probedDuration = Number(probe?.durationSec);
    const durationSec = Math.max(requiredSec, Number.isFinite(probedDuration) && probedDuration > 0 ? probedDuration : requiredSec);
    const index = assets.length;
    const id = `r${index + 2}`; // r1 留给 format
    assets.push({
      src,
      durationSec: round(durationSec, 6),
      // 探测结论优先；没有探测就按"被什么片段用到"判。
      // 纯音频素材绝不能带 hasVideo/format——那会让 NLE 把它当视频轨去解。
      hasAudio: probe?.hasAudio === true || hint.hasAudio,
      hasVideo: probe?.hasVideo === true || hint.hasVideo,
      name: probe?.name ?? src.split('/').pop() ?? 'asset',
    });
    assetBySrc.set(src, { id, index });
    return id;
  };

  /**
   * @typedef {{ tag: 'asset-clip' | 'gap', kind: 'video' | 'still' | 'scene' | 'audio', id: string,
   *   start: number, end: number, srcStart: number, ref?: string, name: string, note?: string, audioRole?: string }} Item
   */
  /** @type {Item[]} */
  const items = [];
  /** @type {Array<{ id: string, reason: string }>} */
  const unsupported = [];

  for (const clip of visualClips) {
    const start = Number(clip.at) || 0;
    const duration = Number(clip.duration);
    const span = Number.isFinite(duration) && duration > 0 ? duration : (Number(clip.time?.[1]) || 0) - (Number(clip.time?.[0]) || 0);
    if (!(span > 0)) {
      unsupported.push({ id: String(clip.id), reason: 'clip has no positive duration; skipped' });
      continue;
    }
    const src = String(clip.src);
    const srcStart = Number(clip.time?.[0]) || 0;
    const ref = ensureAsset(src, srcStart + span, { hasVideo: true, hasAudio: false });
    items.push({
      tag: 'asset-clip',
      kind: (clip.kind ?? 'video') === 'still' ? 'still' : 'video',
      id: String(clip.id),
      start,
      end: start + span,
      srcStart,
      ref,
      name: String(clip.id),
      ...(Number(clip.speed) && Number(clip.speed) !== 1
        ? { note: `speed ${clip.speed}x is not represented in this fcpxml (needs a timeMap); timeline duration follows the plan` }
        : {}),
    });
  }

  for (const scene of sceneClips) {
    const start = Number(scene.at) || 0;
    const time = Array.isArray(scene.time) ? scene.time : null;
    const span = time ? (Number(time[1]) || 0) - (Number(time[0]) || 0) : 0;
    if (!(span > 0)) {
      unsupported.push({
        id: String(scene.id),
        reason: 'web scene has no #t=in,out so its duration is unknown; a gap without duration would be a lie',
      });
      continue;
    }
    items.push({
      tag: 'gap',
      kind: 'scene',
      id: String(scene.id),
      start,
      end: start + span,
      srcStart: Number(time?.[0]) || 0,
      name: `${scene.id} (web scene not exported: no media file)`,
      note:
        `web scene ${scene.id} (${String(scene.src)}) is rendered by the stage at export time and has no media file. ` +
        `It is kept as a placeholder gap so the rest of the timeline keeps its timing. Re-create it in the NLE.`,
    });
  }

  for (const [index, clip] of audioClips.entries()) {
    const start = Number(clip.at) || 0;
    const span = (Number(clip.time?.[1]) || 0) - (Number(clip.time?.[0]) || 0);
    if (!(span > 0)) {
      unsupported.push({ id: `audio-${index + 1}`, reason: 'audio clip has no positive duration; skipped' });
      continue;
    }
    const src = String(clip.src);
    const srcStart = Number(clip.time?.[0]) || 0;
    const ref = ensureAsset(src, srcStart + span, { hasAudio: true, hasVideo: false });
    items.push({
      tag: 'asset-clip',
      kind: 'audio',
      id: `audio-${index + 1}`,
      start,
      end: start + span,
      srcStart,
      ref,
      name: `audio-${index + 1}`,
      audioRole: 'dialogue',
    });
  }

  // ---- 轨道分配 ----
  // 视觉片段优先挤主故事线（lane 0）；gap 与音频一律挂连接道（lane -1 起），
  // 因为主故事线只该放"这一段画面是什么"，把占位 gap 塞进去会让 NLE 里出现无意义的空段。
  items.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  /** @type {Array<Array<{ start: number, end: number }>>} */
  const lanes = [[]];
  /** @type {Map<Item, number>} */
  const laneOf = new Map();
  for (const item of items) {
    const preferPrimary = item.kind === 'video' || item.kind === 'still';
    const laneIndex = allocLane(lanes, item.start, item.end, preferPrimary ? 0 : 1);
    laneOf.set(item, laneIndex);
  }

  // 主故事线必须连续：补齐空隙（含片尾），否则 NLE 会把它当成"到最后一个片段就结束"
  /** @type {Array<{ tag: 'gap' | 'asset-clip' | 'audio-clip', start: number, end: number, item?: Item }>} */
  const primary = [];
  const laneZero = items.filter((item) => laneOf.get(item) === 0).sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (const item of laneZero) {
    if (item.start > cursor + 1e-9) primary.push({ tag: 'gap', start: cursor, end: item.start });
    primary.push({ tag: 'asset-clip', start: item.start, end: item.end, item });
    cursor = item.end;
  }
  const timelineEnd = Math.max(cursor, totalSec);
  if (timelineEnd > cursor + 1e-9) primary.push({ tag: 'gap', start: cursor, end: timelineEnd });

  // ---- 输出 ----
  /** @type {string[]} */
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(`<!DOCTYPE fcpxml>`);
  lines.push(`<fcpxml version="${FCPXML_DTD_VERSION}">`);
  lines.push('  <resources>');
  lines.push(
    `    <format id="r1" name="${xmlEscape(formatName(stage, rate.fps))}" ` +
      `frameDuration="${rate.frameDuration}" width="${stage.w}" height="${stage.h}"/>`,
  );
  for (const [index, asset] of assets.entries()) {
    const id = `r${index + 2}`;
    const href = pathToFileURL(asset.src).href;
    const attrs = [
      `id="${id}"`,
      `name="${xmlEscape(asset.name)}"`,
      `src="${xmlEscape(href)}"`,
      'start="0s"',
      `duration="${rationalTime(asset.durationSec, rate)}"`,
      `hasVideo="${asset.hasVideo ? 1 : 0}"`,
      `hasAudio="${asset.hasAudio ? 1 : 0}"`,
    ];
    if (asset.hasVideo) attrs.push('format="r1"');
    lines.push(`    <asset ${attrs.join(' ')}/>`);
  }
  lines.push('  </resources>');
  const projectName = opts.projectName ?? 'opencut film';
  lines.push(`  <library>`);
  lines.push(`    <event name="${xmlEscape(opts.eventName ?? projectName)}">`);
  lines.push(`      <project name="${xmlEscape(projectName)}">`);
  lines.push(
    `        <sequence format="r1" duration="${rationalTime(totalSec, rate)}" tcStart="0s" tcFormat="NDF">`,
  );
  lines.push('          <spine>');

  /**
   * @param {Item} item
   * @param {number} laneIndex
   * @returns {string[]}
   */
  const renderConnected = (item, laneIndex) => {
    const laneAttr = ` lane="${-laneIndex}"`;
    const offset = `offset="${rationalTime(item.start, rate)}"`;
    const duration = `duration="${rationalTime(item.end - item.start, rate)}"`;
    if (item.tag === 'gap') {
      const note = item.note ?? '';
      // gap 没有"素材内入点"这回事：`start` 恒为 0，别把 scene 的 #t= 抄进来（那是源内偏移）
      return [
        `            <gap name="${xmlEscape(item.name)}"${laneAttr} ${offset} start="${rationalTime(0, rate)}" ${duration} note="${xmlEscape(note)}"/>`,
      ];
    }
    const role = item.audioRole ? ` audioRole="${item.audioRole}"` : '';
    const note = item.note ? ` note="${xmlEscape(item.note)}"` : '';
    return [
      `            <asset-clip ref="${item.ref}" name="${xmlEscape(item.name)}"${laneAttr} ${offset} start="${rationalTime(item.srcStart, rate)}" ${duration}${role}${note}/>`,
    ];
  };

  for (const entry of primary) {
    const offset = `offset="${rationalTime(entry.start, rate)}"`;
    const duration = `duration="${rationalTime(entry.end - entry.start, rate)}"`;
    if (entry.tag === 'gap') {
      lines.push(`            <gap name="gap" ${offset} ${duration}/>`);
    } else if (entry.item) {
      const item = entry.item;
      const role = item.audioRole ? ` audioRole="${item.audioRole}"` : '';
      const note = item.note ? ` note="${xmlEscape(item.note)}"` : '';
      lines.push(
        `            <asset-clip ref="${item.ref}" name="${xmlEscape(item.name)}" ${offset} ` +
          `start="${rationalTime(item.srcStart, rate)}" ${duration}${role}${note}/>`,
      );
    }
    // 连接道：挂在这个主片段覆盖范围内（起点落在其中）的片段，紧跟其后——FCP 自己就是这么导的
    const children = items
      .filter((item) => (laneOf.get(item) ?? 0) > 0 && item.start >= entry.start - 1e-9 && item.start < entry.end - 1e-9)
      .sort((a, b) => a.start - b.start || (laneOf.get(b) ?? 0) - (laneOf.get(a) ?? 0));
    for (const child of children) lines.push(...renderConnected(child, laneOf.get(child) ?? 1));
  }
  // 起点落在时间线之外的连接片段（理论上不该有）也必须出现，丢片段比顺序难看严重得多
  const emitted = new Set(
    primary.map((entry) => entry.item).filter(Boolean),
  );
  for (const child of items) {
    const laneIndex = laneOf.get(child) ?? 0;
    if (laneIndex === 0) continue;
    if (emitted.has(child)) continue;
    const covered = primary.some((entry) => child.start >= entry.start - 1e-9 && child.start < entry.end - 1e-9);
    if (!covered) lines.push(...renderConnected(child, laneIndex));
  }

  lines.push('          </spine>');
  lines.push('        </sequence>');
  lines.push('      </project>');
  lines.push('    </event>');
  lines.push('  </library>');
  lines.push('</fcpxml>');
  lines.push('');

  return lines.join('\n');
}

/**
 * 最小 XML 解析器（只够回读我们自己产出的 FCPXML）。
 *
 * 刻意不引第三方库：本树装不了依赖，而且"用生成器的库去验生成器"意义有限。
 * 支持：声明/DOCTYPE 跳过、自闭合标签、属性双引号、实体解码。不支持：命名空间前缀语义、
 * CDATA、DTD 校验——这些不在我们的产出里，真出现了应该由 xmllint 或 NLE 报错。
 *
 * @param {string} xml
 * @returns {{
 *   version: string | null,
 *   elements: Array<{ name: string, attrs: Record<string, string>, parent: string | null }>,
 * }}
 */
export function parseFcpxml(xml) {
  const text = String(xml);
  /** @type {Array<{ name: string, attrs: Record<string, string>, parent: string | null }>} */
  const elements = [];
  /** @type {string[]} */
  const stack = [];
  let version = null;

  /** @param {string} raw */
  const decode = (raw) =>
    raw
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');

  const tagPattern = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*"[^"]*")*)\s*(\/?)>/g;
  let match;
  while ((match = tagPattern.exec(text)) !== null) {
    const closing = match[1] === '/';
    const name = match[2] ?? '';
    if (name === '') continue;
    if (closing) {
      const at = stack.lastIndexOf(name);
      if (at !== -1) stack.length = at;
      continue;
    }
    /** @type {Record<string, string>} */
    const attrs = {};
    const attrPattern = /([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/g;
    let attr;
    while ((attr = attrPattern.exec(match[3] ?? '')) !== null) {
      attrs[attr[1] ?? ''] = decode(attr[2] ?? '');
    }
    const parent = stack.length > 0 ? (stack[stack.length - 1] ?? null) : null;
    elements.push({ name, attrs, parent });
    if (name === 'fcpxml' && typeof attrs.version === 'string') version = attrs.version;
    if (match[4] !== '/') stack.push(name);
  }

  return { version, elements };
}

/**
 * `240/30s` → 秒。解析不了返回 null（不猜）。
 * @param {string | undefined} raw
 * @returns {number | null}
 */
export function parseRationalTime(raw) {
  if (typeof raw !== 'string') return null;
  const match = /^(-?\d+)\/(\d+)s$/.exec(raw.trim());
  if (!match) return null;
  const num = Number(match[1]);
  const den = Number(match[2]);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  return num / den;
}

/**
 * 回读校验：把生成的 XML 读回来，跟 plan 对账。
 *
 * 查四件事（都是"写错了就一定会被 NLE 打回来"的那种）：
 * 1. version 是 1.9；
 * 2. `<asset-clip>` 个数 == plan.visualClips 个数（音频不算在内）；
 * 3. 每个视觉片段的 offset/duration 与 plan 一致（±1 帧）；
 * 4. 总时长与 plan.outputDuration 一致（±1 帧）。
 *
 * @param {string} xml
 * @param {any} plan
 * @returns {{ ok: boolean, version: string | null, clipCount: number, visualClipsInXml: number, expectedClips: number,
 *   durationFrames: number, expectedFrames: number, problems: string[], clips: any[], gaps: any[] }}
 */
export function verifyFcpxml(xml, plan) {
  const parsed = parseFcpxml(xml);
  const fps = Number(plan?.fps) || 30;
  const problems = [];

  const of = (/** @type {string} */ name) => parsed.elements.filter((el) => el.name === name);
  const sequence = of('sequence')[0];
  const durationFrames = sequence ? framesOf(parseRationalTime(sequence.attrs.duration) ?? 0, fps) : 0;
  const expectedFrames = framesOf(Number(plan?.outputDuration ?? plan?.duration ?? 0), fps);
  if (!sequence) problems.push('no <sequence> element');
  if (Math.abs(durationFrames - expectedFrames) > 1) {
    problems.push(`sequence duration ${durationFrames}f != plan ${expectedFrames}f`);
  }
  if (parsed.version !== FCPXML_DTD_VERSION) {
    problems.push(`fcpxml version ${String(parsed.version)} != ${FCPXML_DTD_VERSION}`);
  }

  // 视觉片段：ref + name 能对上 plan.visualClips
  const assetClips = of('asset-clip');
  const visual = Array.isArray(plan?.visualClips) ? plan.visualClips : [];
  /** @type {any[]} */
  const clips = [];
  /** @type {string[]} */
  const problemsPerClip = [];
  for (const el of assetClips) {
    const name = el.attrs.name ?? '';
    const planClip = visual.find((/** @type {any} */ c) => String(c.id) === name);
    const offset = parseRationalTime(el.attrs.offset);
    const duration = parseRationalTime(el.attrs.duration);
    const start = parseRationalTime(el.attrs.start);
    clips.push({
      name,
      ref: el.attrs.ref ?? null,
      lane: el.attrs.lane ?? null,
      offsetRaw: el.attrs.offset ?? null,
      startRaw: el.attrs.start ?? null,
      durationRaw: el.attrs.duration ?? null,
      offsetSec: offset,
      durationSec: duration,
      startSec: start,
      isPlanClip: Boolean(planClip),
    });
    if (!planClip) continue;
    const wantOffset = Number(planClip.at) || 0;
    const wantDuration = Number(planClip.duration) || 0;
    const wantStart = Number(planClip.time?.[0]) || 0;
    if (offset === null || Math.abs(framesOf(offset, fps) - framesOf(wantOffset, fps)) > 1) {
      problemsPerClip.push(`${name}: offset ${String(el.attrs.offset)} != ${wantOffset}s`);
    }
    if (duration === null || Math.abs(framesOf(duration, fps) - framesOf(wantDuration, fps)) > 1) {
      problemsPerClip.push(`${name}: duration ${String(el.attrs.duration)} != ${wantDuration}s`);
    }
    if (start === null || Math.abs(framesOf(start, fps) - framesOf(wantStart, fps)) > 1) {
      problemsPerClip.push(`${name}: start ${String(el.attrs.start)} != ${wantStart}s`);
    }
  }
  problems.push(...problemsPerClip);
  const visualClipsInXml = clips.filter((c) => c.isPlanClip).length;
  if (visualClipsInXml !== visual.length) {
    problems.push(`visual clips ${visualClipsInXml} != plan.visualClips ${visual.length}`);
  }

  /** @type {any[]} */
  const gaps = of('gap')
    .filter((el) => (el.attrs.note ?? '') !== '')
    .map((el) => ({
      name: el.attrs.name ?? '',
      lane: el.attrs.lane ?? null,
      offsetRaw: el.attrs.offset ?? null,
      durationRaw: el.attrs.duration ?? null,
      note: el.attrs.note ?? '',
    }));

  return {
    ok: problems.length === 0,
    version: parsed.version,
    clipCount: clips.length,
    visualClipsInXml,
    expectedClips: visual.length,
    durationFrames,
    expectedFrames,
    problems,
    clips,
    gaps,
  };
}
