/**
 * 转场（交叉溶解）——纯函数，不碰 DOM、不读盘。
 *
 * ## 本方言里「转场」的权威表达（M25 第一步的结论）
 *
 * 转场**没有独立实体**，它是一条**由现有字段完全决定的几何 + 包络关系**：
 *
 * 1. **重叠**：同一条轨道上、时间相邻的两个画面片段（`video`/`still`），
 *    后段 `at` **早于** 前段结束 → 重叠 `D = from.end - to.at > 0`。
 *    `at` 与 `#t=in,out` 一起决定窗口，窗口不重叠就没有转场。
 * 2. **包络**：交叉溶解由**上层**片段的 `fade` 承担——
 *    后段在文档顺序里靠后（同轨同 z-index 时，后出现的元素在上层：
 *    预览靠 DOM 顺序、导出靠 `film-export` 的 `ordered` 索引升序，两边一致），
 *    所以规范写法是 **后段 `fade[0] = D`（淡入）、前段不淡出**。
 * 3. **为什么不是「两侧 fade」**：预览是逐元素 CSS `opacity` 叠、导出是 ffmpeg
 *    `fade=alpha` + `overlay`，两条路都是 **alpha-over**：`out = B·aB + A·aA·(1−aB)`。
 *    两侧同时淡（aA = aB = 1−t → t）在重叠中点只剩 `0.25·A + 0.5·B`：
 *    实测红/蓝两段 `D=1s`，中点双边 `rgb(66,0,127)`、单边 `rgb(127,0,127)`——
 *    双边会把画面压暗 24%，肉眼就是「中间黑一下」。所以：
 *    **画面转场 = 单边（上层淡入）；声音转场 = 双边（加性混音，见下）**。
 * 4. **声音交叉淡化**：`<audio>` 片段（`kind === 'sound'`）在 `audio-mix` 里是
 *    **逐样本相加**，包络是**线性幅度**。所以声音交叉 = 前段 `fade[1] = D`、
 *    后段 `fade[0] = D`，两段在时间上重叠 `D`。这里不改声音模型，只在调长/移除时
 *    把「与画面片段镜像的伴生音轨」一起改（不镜像就不动，宁可少改也不猜）。
 *
 * 以上只用到 `at` / `#t=in,out` / `overrides[].fade` 三个既有字段，**不新增属性、不改合同**。
 *
 * ## 不变量
 *
 * - 调长受**源余量**限制：向左延长要后段「入点前」有素材，向右延长要前段「出点后」
 *   有素材（`native` 给不出时长就按 0 算，宁停不吞）。到边界停住并给出原因。
 * - 一批 Op = 一次 `/ops` = 一步撤销；只用 `props`（`at`/`start`/`end`/`fade`）。
 */

import { frameToSeconds, secondsToFrame } from './time.mjs';

/** 重叠判定的容差（秒）：小于它不算重叠（浮点噪声，不是转场）。 */
export const TRANSITION_EPS = 1e-6;

/** @param {number} value */
function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}

/** @param {number} value @param {number} lo @param {number} hi */
function clamp(value, lo, hi) {
  if (!Number.isFinite(value)) return lo;
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

/** @param {any} fade @returns {[number, number]} */
function fadeOf(fade) {
  if (!Array.isArray(fade)) return [0, 0];
  const fadeIn = Number(fade[0]);
  const fadeOut = Number(fade[1]);
  return [Number.isFinite(fadeIn) && fadeIn > 0 ? fadeIn : 0, Number.isFinite(fadeOut) && fadeOut > 0 ? fadeOut : 0];
}

/** 片段 src 去掉 `#t=`（存在性/伴生匹配都按文件算）。 @param {string} src */
export function bareSrc(src) {
  const value = String(src ?? '');
  const cut = value.search(/[?#]/);
  return cut < 0 ? value : value.slice(0, cut);
}

/** 片段在时间线上的占用区间（与 ripple.mjs 的 spanOf / UI 的 clipSpan 同口径）。
 * @param {{ at?: number, time?: number[], speed?: number }} clip
 * @returns {{ start: number, end: number, length: number }}
 */
export function spanOf(clip) {
  const start = Number(clip?.at ?? 0);
  const time = Array.isArray(clip?.time) ? clip.time : null;
  const speed = typeof clip?.speed === 'number' && clip.speed > 0 ? clip.speed : 1;
  const length = time === null ? 0 : (Number(time[1]) - Number(time[0])) / speed;
  return { start: roundMs(start), end: roundMs(start + length), length: roundMs(length) };
}

/** @param {any} clip */
function isPicture(clip) {
  const kind = clip?.kind ?? 'video';
  return kind === 'video' || kind === 'still' || kind === 'img';
}

/** @param {Record<string, number|null>|Map<string, number|null>|undefined} native @param {string} src */
function nativeOf(native, src) {
  const key = bareSrc(src);
  if (native === undefined || native === null) return null;
  const value = native instanceof Map ? native.get(key) : native[key];
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** @param {any} clip @param {{ w: number, h: number }} stage */
function isFullFrame(clip, stage) {
  const box = clip?.box;
  if (box === undefined || box === null) return true;
  const w = Number(box.w);
  const h = Number(box.h);
  const x = Number(box.x ?? 0);
  const y = Number(box.y ?? 0);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return true;
  return x <= 1 && y <= 1 && w >= stage.w - 1 && h >= stage.h - 1;
}

/**
 * 找出同一轨上「与画面片段镜像」的伴生声音片段：src 同文件、`at` 与 `#t=in` 都和画面一致。
 * @param {any[]} soundClips
 * @param {any} picture
 * @returns {any|null}
 */
function companionAudioOf(soundClips, picture) {
  if (!Array.isArray(picture?.time)) return null;
  const file = bareSrc(picture.src);
  const at = Number(picture.at ?? 0);
  const inPoint = Number(picture.time[0]);
  for (const sound of soundClips) {
    if (bareSrc(sound.src) !== file) continue;
    if (!Array.isArray(sound.time)) continue;
    if (Math.abs(Number(sound.at ?? 0) - at) > 1e-3) continue;
    if (Math.abs(Number(sound.time[0]) - inPoint) > 1e-3) continue;
    return sound;
  }
  return null;
}

/**
 * 扫描整份 doc，生成转场列表。
 *
 * @param {{
 *   tracks: readonly any[],
 *   stage?: { w: number, h: number },
 *   native?: Record<string, number|null>|Map<string, number|null>,
 *   fps?: { num: number, den: number },
 * }} input `native`：裸 src → 该文件原生时长（秒）；不知道就缺省（源余量按 0 算）。
 * @returns {{ transitions: any[], unresolved: any[] }} `unresolved` 是「看起来重叠但表达不完整」的位置（给人看，不画块）。
 */
export function detectTransitions(input) {
  const tracks = Array.isArray(input?.tracks) ? input.tracks : [];
  const stage = input?.stage ?? { w: 1920, h: 1080 };
  const fps = input?.fps ?? { num: 30, den: 1 };
  const minLength = (fps.den || 1) / (fps.num || 30);
  /** @type {any[]} */
  const transitions = [];
  /** @type {any[]} */
  const unresolved = [];
  // 伴生音轨按「同文件 + 同 at + 同 #t=in」认，**不限轨**：真实工程里声音通常在自己的轨上（M28 起）。
  const allSounds = tracks.flatMap((/** @type {any} */ track) =>
    (Array.isArray(track?.clips) ? track.clips : []).filter((/** @type {any} */ clip) => (clip?.kind ?? '') === 'sound'),
  );

  for (const track of tracks) {
    const clips = Array.isArray(track?.clips) ? track.clips : [];
    const pictures = clips
      .map((/** @type {any} */ clip, /** @type {number} */ order) => ({ clip, order }))
      .filter((/** @type {{ clip: any, order: number }} */ entry) => isPicture(entry.clip))
      // 时间顺序为准；同一 at 保持文档顺序（stable）
      .sort((/** @type {any} */ a, /** @type {any} */ b) => Number(a.clip.at ?? 0) - Number(b.clip.at ?? 0) || a.order - b.order);

    for (let i = 0; i + 1 < pictures.length; i += 1) {
      const from = pictures[i];
      const to = pictures[i + 1];
      const fromSpan = spanOf(from.clip);
      const toSpan = spanOf(to.clip);
      const overlap = roundMs(fromSpan.end - toSpan.start);
      if (overlap <= TRANSITION_EPS) continue;

      const label = `${from.clip.id}→${to.clip.id}`;
      if (!Array.isArray(from.clip.time) || !Array.isArray(to.clip.time)) {
        unresolved.push({ id: label, trackIndex: track.index, reason: 'NO_EXPLICIT_SPAN', overlap });
        continue;
      }
      const [fromIn, fromOut] = fadeOf(from.clip.fade);
      const [toIn, toOut] = fadeOf(to.clip.fade);
      if (fromOut <= 0 && toIn <= 0) {
        unresolved.push({ id: label, trackIndex: track.index, reason: 'OVERLAP_WITHOUT_FADE', overlap });
        continue;
      }

      // 同轨同 z-index：文档顺序靠后的在上层（预览 DOM 顺序 / 导出 ordered 索引升序，一致）。
      const top = to.order > from.order ? 'to' : 'from';
      const topFade = top === 'to' ? toIn : fromOut;
      const otherFade = top === 'to' ? fromOut : toIn;
      const doubleSided = fromOut > 0 && toIn > 0;

      const fromSourceOut = Number(from.clip.time[1]);
      const toSourceIn = Number(to.clip.time[0]);
      const fromNative = nativeOf(input?.native, from.clip.src);
      // 源余量：向左吃后段「入点前」、向右吃前段「出点后」。静帧没有内在时长，按不限处理。
      const headroomStart = roundMs(
        Math.max(
          0,
          Math.min(
            from.clip.kind === 'still' ? Number.POSITIVE_INFINITY : toSourceIn,
            toSpan.start - fromSpan.start - minLength,
            toSpan.length - minLength,
          ),
        ),
      );
      const tailRoom =
        from.clip.kind === 'still'
          ? Number.POSITIVE_INFINITY
          : fromNative === null
            ? 0
            : Math.max(0, fromNative - fromSourceOut);
      const headroomEnd = roundMs(
        Math.max(0, Math.min(tailRoom, toSpan.end - fromSpan.end, Number.POSITIVE_INFINITY)),
      );

      const audioFrom = companionAudioOf(allSounds, from.clip);
      const audioTo = companionAudioOf(allSounds, to.clip);

      transitions.push({
        id: label,
        trackIndex: track.index,
        start: toSpan.start,
        end: fromSpan.end,
        duration: overlap,
        top,
        doubleSided,
        ramp: {
          clip: top === 'to' ? to.clip.id : from.clip.id,
          side: top === 'to' ? 'in' : 'out',
          seconds: roundMs(Math.min(topFade, overlap)),
        },
        /** 只有「上层承载 fade」才真的能溶；上层没 fade、下层有 → 视觉是断的。 */
        crossfadeOk: topFade > 0,
        fadeOnLower: otherFade > 0 && topFade <= 0,
        fullFrame: isFullFrame(from.clip, stage) && isFullFrame(to.clip, stage),
        headroom: { start: headroomStart, end: headroomEnd },
        from: {
          id: from.clip.id,
          src: from.clip.src,
          kind: from.clip.kind,
          at: fromSpan.start,
          sourceIn: Number(from.clip.time[0]),
          sourceOut: fromSourceOut,
          end: fromSpan.end,
          length: fromSpan.length,
          fade: [fromIn, fromOut],
          sourceNative: fromNative,
          order: from.order,
          audioId: audioFrom === null ? null : audioFrom.id,
        },
        to: {
          id: to.clip.id,
          src: to.clip.src,
          kind: to.clip.kind,
          at: toSpan.start,
          sourceIn: toSourceIn,
          sourceOut: Number(to.clip.time[1]),
          end: toSpan.end,
          length: toSpan.length,
          fade: [toIn, toOut],
          sourceNative: nativeOf(input?.native, to.clip.src),
          order: to.order,
          audioId: audioTo === null ? null : audioTo.id,
        },
      });
    }
  }

  transitions.sort((a, b) => a.trackIndex - b.trackIndex || a.start - b.start);
  return { transitions, unresolved };
}

/** 把要移动的边吸到整帧（落盘只写整帧，29.97 也一样）。
 * @param {number} seconds @param {{ num: number, den: number }|undefined} fps
 */
function snapEdge(seconds, fps) {
  if (!fps || !Number.isFinite(seconds)) return roundMs(seconds);
  return frameToSeconds(secondsToFrame(seconds, fps), fps);
}

/**
 * 转场包络要写的 props（一条 edit 列表）。
 * @param {any} transition
 * @param {number} duration 新的重叠时长
 * @param {number} minLength 最小一帧
 * @returns {any[]}
 */
function envelopeEdits(transition, duration, minLength) {
  const d = roundMs(Math.max(minLength, duration));
  /** @type {any[]} */
  const edits = [];
  const fromFade = transition.from.fade;
  const toFade = transition.to.fade;
  if (transition.doubleSided) {
    // 老写法（两侧淡）：保持形状，两边一起改，别偷偷改叙事手感。
    edits.push({ clip: transition.from.id, prop: 'fade', value: [roundMs(fromFade[0]), d] });
    edits.push({ clip: transition.to.id, prop: 'fade', value: [d, roundMs(toFade[1])] });
  } else if (transition.top === 'to') {
    edits.push({ clip: transition.to.id, prop: 'fade', value: [d, roundMs(toFade[1])] });
  } else {
    edits.push({ clip: transition.from.id, prop: 'fade', value: [roundMs(fromFade[0]), d] });
  }
  return edits;
}

/**
 * 调长 / 缩短转场。
 *
 * - `edge:'start'` 拖的是转场左边缘（= 后段 `at`）：改后段 `at` 与 `#t=in`，
 *   后段末尾不动（素材窗口整体前移/后移），重叠随之变化。
 * - `edge:'end'` 拖的是右边缘（= 前段结束）：改前段 `#t=out`，前段起点不动。
 *
 * @param {{ transition: any, edge: 'start'|'end', deltaSec: number, fps?: { num: number, den: number } }} input
 * @returns {{ ok: boolean, ops: any[], next: any, limited: string|null, message: string, audioLinked?: boolean }}
 */
export function planTransitionResize(input) {
  const transition = input?.transition;
  if (!transition || (input.edge !== 'start' && input.edge !== 'end')) {
    return { ok: false, ops: [], next: null, limited: 'invalid', message: '转场或拖拽边不合法' };
  }
  const fps = input.fps;
  const minLength = (fps?.den || 1) / (fps?.num || 30);
  const delta = Number(input.deltaSec);
  if (!Number.isFinite(delta) || delta === 0) {
    return { ok: false, ops: [], next: { start: transition.start, end: transition.end, duration: transition.duration }, limited: null, message: '没有位移' };
  }

  if (input.edge === 'start') {
    const lo = roundMs(transition.start - transition.headroom.start);
    const hi = roundMs(transition.end - minLength);
    const desired = snapEdge(transition.start + delta, fps);
    const start = clamp(desired, lo, hi);
    const shift = roundMs(transition.start - start); // >0：向左延长
    if (shift === 0) {
      const limited = delta < 0 ? 'source-head' : 'min-length';
      return {
        ok: false,
        ops: [],
        next: { start: transition.start, end: transition.end, duration: transition.duration },
        limited,
        message: delta < 0 ? '后段入点前没有多余素材，转场不能再长' : '转场已到最短（至少一帧）',
      };
    }
    const nextToAt = roundMs(transition.to.at - shift);
    const nextToIn = roundMs(transition.to.sourceIn - shift);
    if (nextToIn < 0) {
      return { ok: false, ops: [], next: null, limited: 'source-head', message: '后段入点前没有多余素材' };
    }
    const duration = roundMs(transition.end - start);
    /** @type {any[]} */
    const edits = [
      { clip: transition.to.id, prop: 'at', value: nextToAt },
      { clip: transition.to.id, prop: 'start', value: nextToIn },
      ...envelopeEdits(transition, duration, minLength),
    ];
    const audio = audioEditsResize(transition, 'start', { at: nextToAt, sourceIn: nextToIn }, duration, minLength);
    edits.push(...audio.edits);
    const limited = shift !== 0 && clamp(desired, lo, hi) !== desired ? (delta < 0 ? 'source-head' : 'min-length') : null;
    return {
      ok: true,
      ops: [{ op: 'props', edits }],
      next: { start, end: transition.end, duration },
      limited,
      audioLinked: audio.linked,
      message: limited === 'source-head' ? '后段入点前素材用尽：停在边界，没有吞素材' : '',
    };
  }

  const lo = roundMs(transition.start + minLength);
  const hi = roundMs(transition.end + transition.headroom.end);
  const desired = snapEdge(transition.end + delta, fps);
  const end = clamp(desired, lo, hi);
  const grow = roundMs(end - transition.end);
  if (grow === 0) {
    const limited = delta > 0 ? 'source-tail' : 'min-length';
    return {
      ok: false,
      ops: [],
      next: { start: transition.start, end: transition.end, duration: transition.duration },
      limited,
      message: delta > 0 ? '前段出点后没有多余素材，转场不能再长' : '转场已到最短（至少一帧）',
    };
  }
  const nextFromOut = roundMs(transition.from.sourceOut + grow);
  const duration = roundMs(end - transition.start);
  /** @type {any[]} */
  const edits = [
    { clip: transition.from.id, prop: 'end', value: nextFromOut },
    ...envelopeEdits(transition, duration, minLength),
  ];
  const audio = audioEditsResize(transition, 'end', { sourceOut: nextFromOut }, duration, minLength);
  edits.push(...audio.edits);
  const limited = clamp(desired, lo, hi) !== desired ? (delta > 0 ? 'source-tail' : 'min-length') : null;
  return {
    ok: true,
    ops: [{ op: 'props', edits }],
    next: { start: transition.start, end, duration },
    limited,
    audioLinked: audio.linked,
    message: limited === 'source-tail' ? '前段出点后素材用尽：停在边界，没有吞素材' : '',
  };
}

/**
 * 伴生音轨跟着画面一起改（只在「本来就镜像」时动手）。
 * @param {any} transition
 * @param {'start'|'end'} edge
 * @param {{ at?: number, sourceIn?: number, sourceOut?: number }} next
 * @param {number} duration
 * @param {number} minLength
 */
function audioEditsResize(transition, edge, next, duration, minLength) {
  const fromAudio = transition.from.audioId;
  const toAudio = transition.to.audioId;
  // 只有两侧都有镜像伴生音轨时才动：单边交叉淡化闭合不了，宁可不改也不猜。
  if (!fromAudio || !toAudio) return { edits: [], linked: false };
  const d = roundMs(Math.max(minLength, duration));
  if (edge === 'start') {
    return {
      edits: [
        { clip: toAudio, prop: 'at', value: roundMs(Number(next.at)) },
        { clip: toAudio, prop: 'start', value: roundMs(Number(next.sourceIn)) },
        { clip: toAudio, prop: 'fade', value: [d, 0] },
        { clip: fromAudio, prop: 'fade', value: [0, d] },
      ],
      linked: true,
    };
  }
  return {
    edits: [
      { clip: fromAudio, prop: 'end', value: roundMs(Number(next.sourceOut)) },
      { clip: fromAudio, prop: 'fade', value: [0, d] },
      { clip: toAudio, prop: 'fade', value: [d, 0] },
    ],
    linked: true,
  };
}

/* ── 创建（M28）：把硬切变成交叉溶解 ──────────────────────────────────── */

/** 新建转场的默认时长（秒）。 */
export const DEFAULT_TRANSITION_SECONDS = 0.5;

/**
 * 找出「可以加转场」的硬切点。
 *
 * 判据（任务书 §3.1）：同轨相邻的 `video`/`still`，后段 `at` **等于**前段结束（容差 1 帧）、
 * 且没有已有重叠。已经在重叠里的位置不出现——那是调长的事，不能抢。
 *
 * 返回的 `headroom` 与 M25 的 `detectTransitions` 同口径：**创建之后**还能往左/往右
 * 拉多少，用来给「加完立刻拖长」留余地。`room` 是**创建本身**能吃下的最大重叠：
 *
 *     room = min(后段 at − 前段 at − 1 帧,  后段时长 − 1 帧)
 *
 * ## 为什么创建不吃素材余量（与 M25 调长不同）
 *
 * 创建的写盘形状是「后段 `at` 前移 D，`#t=in` 不动」（任务书 §3.3）。后段窗口整体
 * 前移，**内容一帧不少**，前段末尾与后段开头在时间线上共享 D 秒——所以两边都不需要
 * 「出点之后 / 入点之前」的额外素材。真正会卡住的是几何：后段不能跑到前段起点之前，
 * 两端也都得各留至少一帧。调长（`planTransitionResize`）才吃素材，那一步的余量由
 * `headroom` 给出。
 *
 * @param {{
 *   tracks: readonly any[],
 *   stage?: { w: number, h: number },
 *   native?: Record<string, number|null>|Map<string, number|null>,
 *   fps?: { num: number, den: number },
 * }} input
 * @returns {{ cuts: any[] }} `cuts[].canCreate === false` 的也返回（带 `reason`），便于界面解释。
 */
export function detectCutPoints(input) {
  const tracks = Array.isArray(input?.tracks) ? input.tracks : [];
  const fps = input?.fps ?? { num: 30, den: 1 };
  const frame = (fps.den || 1) / (fps.num || 30);
  const tolerance = frame + 1e-6;
  /** @type {any[]} */
  const cuts = [];
  const allSounds = tracks.flatMap((/** @type {any} */ track) =>
    (Array.isArray(track?.clips) ? track.clips : []).filter((/** @type {any} */ clip) => (clip?.kind ?? '') === 'sound'),
  );

  for (const track of tracks) {
    const clips = Array.isArray(track?.clips) ? track.clips : [];
    const pictures = clips
      .map((/** @type {any} */ clip, /** @type {number} */ order) => ({ clip, order }))
      .filter((/** @type {{ clip: any, order: number }} */ entry) => isPicture(entry.clip))
      .sort((/** @type {any} */ a, /** @type {any} */ b) => Number(a.clip.at ?? 0) - Number(b.clip.at ?? 0) || a.order - b.order);

    for (let i = 0; i + 1 < pictures.length; i += 1) {
      const from = pictures[i];
      const to = pictures[i + 1];
      const fromSpan = spanOf(from.clip);
      const toSpan = spanOf(to.clip);
      const overlap = roundMs(fromSpan.end - toSpan.start);
      if (overlap > TRANSITION_EPS) continue; // 已有重叠：转场块在那儿，别抢
      const gap = roundMs(toSpan.start - fromSpan.end);
      if (gap > tolerance) continue; // 中间有空隙：不是切点

      const id = `${from.clip.id}→${to.clip.id}`;
      const base = {
        id,
        trackIndex: track.index,
        at: roundMs(toSpan.start),
        from: {
          id: from.clip.id,
          src: from.clip.src,
          kind: from.clip.kind,
          at: fromSpan.start,
          end: fromSpan.end,
          length: fromSpan.length,
          sourceIn: Array.isArray(from.clip.time) ? Number(from.clip.time[0]) : null,
          sourceOut: Array.isArray(from.clip.time) ? Number(from.clip.time[1]) : null,
          sourceNative: nativeOf(input?.native, from.clip.src),
          fade: fadeOf(from.clip.fade),
        },
        to: {
          id: to.clip.id,
          src: to.clip.src,
          kind: to.clip.kind,
          at: toSpan.start,
          end: toSpan.end,
          length: toSpan.length,
          sourceIn: Array.isArray(to.clip.time) ? Number(to.clip.time[0]) : null,
          sourceOut: Array.isArray(to.clip.time) ? Number(to.clip.time[1]) : null,
          sourceNative: nativeOf(input?.native, to.clip.src),
          fade: fadeOf(to.clip.fade),
          fadeIn: fadeOf(to.clip.fade)[0],
        },
      };

      if (!Array.isArray(from.clip.time) || !Array.isArray(to.clip.time)) {
        cuts.push({ ...base, room: 0, headroom: { start: 0, end: 0 }, canCreate: false, reason: 'NO_EXPLICIT_SPAN' });
        continue;
      }

      const roomBefore = roundMs(toSpan.start - fromSpan.start - frame);
      const roomClip = roundMs(toSpan.length - frame);
      const room = roundMs(Math.max(0, Math.min(roomBefore, roomClip)));
      const canCreate = room >= frame - 1e-6;

      // 创建之后还能拖多远（M25 口径）：左边吃后段入点前素材，右边吃前段出点后素材。
      const sourceHead = to.clip.kind === 'still' ? Number.POSITIVE_INFINITY : Number(to.clip.time[0]);
      const tailRoom =
        from.clip.kind === 'still'
          ? Number.POSITIVE_INFINITY
          : base.from.sourceNative === null
            ? 0
            : Math.max(0, base.from.sourceNative - Number(from.clip.time[1]));
      const headroomStart = roundMs(Math.max(0, Math.min(sourceHead, roomBefore, roomClip)));
      const headroomEnd = roundMs(Math.max(0, Math.min(tailRoom, roomClip)));

      cuts.push({
        ...base,
        room,
        headroom: { start: headroomStart, end: headroomEnd },
        canCreate,
        reason: canCreate ? null : roomClip <= 0 ? 'TOO_SHORT' : 'NO_ROOM',
        audioFromId: (() => {
          const audio = companionAudioOf(allSounds, from.clip);
          return audio === null ? null : audio.id;
        })(),
        audioToId: (() => {
          const audio = companionAudioOf(allSounds, to.clip);
          return audio === null ? null : audio.id;
        })(),
      });
    }
  }

  cuts.sort((a, b) => a.trackIndex - b.trackIndex || a.at - b.at);
  return { cuts };
}

/**
 * 在硬切点上创建交叉溶解。
 *
 * 写盘形状（任务书 §3.3，与 M25 的结论一致）：
 * - 后段 `at` 前移 D（`#t=in/out` 不动 → 内容一帧不少）；
 * - 后段 `fade[0] = D`（上层淡入），**前段不淡出**（alpha-over 下单边才是线性交叉）；
 * - 总时长 −D（后段整体左移，末尾随之左移）；
 * - 伴生音轨**两侧都镜像**时才动：前段 `fade[1]=D`、后段 `at` 前移 + `fade[0]=D`。
 *
 * D = min(请求时长, `cut.room`)，向下吸到整帧；吸不住（`room` 不够一帧）→
 * `TRANSITION_NO_HEADROOM`，**0 个 op、磁盘不动**。
 *
 * @param {{ cut: any, durationSec?: number, fps?: { num: number, den: number } }} input
 * @returns {{ ok: boolean, code: string|null, ops: any[], next: any, applied: number, requested: number, message: string, audioLinked?: boolean, replacedFadeIn?: number }}
 */
export function planTransitionCreate(input) {
  const cut = input?.cut;
  const fps = input?.fps ?? { num: 30, den: 1 };
  const frame = (fps.den || 1) / (fps.num || 30);
  const requestedRaw = Number(input?.durationSec);
  const requested = Number.isFinite(requestedRaw) && requestedRaw > 0 ? requestedRaw : DEFAULT_TRANSITION_SECONDS;

  if (!cut || typeof cut !== 'object') {
    return { ok: false, code: 'TRANSITION_CUT_INVALID', ops: [], next: null, applied: 0, requested, message: '没有可加转场的切点' };
  }
  if (cut.canCreate !== true) {
    return {
      ok: false,
      code: 'TRANSITION_NO_HEADROOM',
      ops: [],
      next: null,
      applied: 0,
      requested,
      message:
        cut.reason === 'NO_EXPLICIT_SPAN'
          ? '这两个片段没有 #t=in,out：时长不确定，不能加转场'
          : '后段太短（或紧贴前段起点）：连一帧的重叠都放不下',
    };
  }

  const target = Math.min(requested, Number(cut.room));
  // 向下吸帧：宁可短一帧，也绝不越过余量。
  const frames = Math.floor((target * fps.num) / fps.den + 1e-6);
  const d = roundMs(Math.max(1, frames) * frame);
  if (!(d > 0)) {
    return { ok: false, code: 'TRANSITION_NO_HEADROOM', ops: [], next: null, applied: 0, requested, message: '连一帧的重叠都放不下' };
  }

  const toFade = fadeOf(cut.to?.fade);
  const newAt = roundMs(Number(cut.to.at) - d);
  if (!(newAt >= 0)) {
    return { ok: false, code: 'TRANSITION_NO_HEADROOM', ops: [], next: null, applied: 0, requested, message: '后段会跑到时间线之前' };
  }

  /** @type {any[]} */
  const edits = [
    { clip: cut.to.id, prop: 'at', value: newAt },
    { clip: cut.to.id, prop: 'fade', value: [d, roundMs(toFade[1])] },
  ];

  // 伴生音轨：两侧都镜像才动（加性混音下声音交叉必须两侧都淡）。
  const audioFrom = cut.audioFromId ?? null;
  const audioTo = cut.audioToId ?? null;
  const audioLinked = audioFrom !== null && audioTo !== null;
  if (audioLinked) {
    edits.push({ clip: audioFrom, prop: 'fade', value: [0, d] });
    edits.push({ clip: audioTo, prop: 'at', value: newAt });
    edits.push({ clip: audioTo, prop: 'fade', value: [d, 0] });
  }

  const clamped = target < requested - 1e-6;
  const existingFadeIn = cut.to?.fadeIn ?? 0;
  return {
    ok: true,
    code: clamped ? 'TRANSITION_HEADROOM_CLAMPED' : null,
    ops: [{ op: 'props', edits }],
    next: { at: newAt, fade: [d, roundMs(toFade[1])], duration: d, overlap: d, totalDelta: -d },
    applied: d,
    requested,
    audioLinked,
    ...(existingFadeIn > d ? { replacedFadeIn: existingFadeIn } : {}),
    message: clamped
      ? `源余量不够 ${roundMs(requested)}s：停在 ${d}s（没有吞素材）`
      : `已加 ${d}s 交叉溶解（总时长 −${d}s${audioLinked ? '，声音同步交叉' : ''}）`,
  };
}

/**
 * 移除转场：后段 `at` 推到前段结束（取消重叠），清掉转场用的 fade，恢复硬切。
 * 前段的淡入、后段的淡出**保留**（它们不是转场的一部分）。
 *
 * @param {{ transition: any, fps?: { num: number, den: number } }} input
 * @returns {{ ok: boolean, ops: any[], next: any, message: string, shiftsNext: number, audioLinked?: boolean }}
 */
export function planTransitionRemove(input) {
  const transition = input?.transition;
  if (!transition) return { ok: false, ops: [], next: null, message: '没有可移除的转场', shiftsNext: 0 };
  const fromFade = transition.from.fade;
  const toFade = transition.to.fade;
  /** @type {any[]} */
  const edits = [
    { clip: transition.to.id, prop: 'at', value: roundMs(transition.end) },
    { clip: transition.from.id, prop: 'fade', value: fromFade[0] > 0 ? [roundMs(fromFade[0]), 0] : null },
    { clip: transition.to.id, prop: 'fade', value: toFade[1] > 0 ? [0, roundMs(toFade[1])] : null },
  ];
  let audio = false;
  if (transition.from.audioId) {
    edits.push({ clip: transition.from.audioId, prop: 'fade', value: null });
    audio = true;
  }
  if (transition.to.audioId) {
    edits.push({ clip: transition.to.audioId, prop: 'at', value: roundMs(transition.end) });
    edits.push({ clip: transition.to.audioId, prop: 'fade', value: null });
    audio = true;
  }
  const shift = roundMs(transition.end - transition.start);
  return {
    ok: true,
    ops: [{ op: 'props', edits }],
    next: { start: roundMs(transition.end), end: roundMs(transition.end), duration: 0, removed: true },
    shiftsNext: shift,
    audioLinked: audio,
    message: `已恢复硬切（后段右移 ${shift}s，总时长 +${shift}s）`,
  };
}
