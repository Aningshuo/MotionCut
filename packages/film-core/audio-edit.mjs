/**
 * 音频编辑的纯函数（M31 · B-MAIN-R16-016）。
 *
 * 只做「算」：音量 ↔ dB、淡变的合法上限、多选时的混合判定、以及要写进
 * `/ops` 的那一批 `props`。不读盘、不碰 DOM、不认识 React。
 *
 * ## 为什么音量可以有上限 2（R16-C2 选 ①）
 *
 * `volume` 是合同属性（`contracts/film-doc.ts`），方言只拒负数；导出侧
 * `packages/render/audio-mix.mjs` 一直按 `gain = volume` 做增益、峰值 >1 时软限幅。
 * 以前预览把增益夹到 1（`HTMLMediaElement.volume` 的上限），于是 `volume=2` 的项目
 * 预览听 1.0、成片听 2.0。R16 把预览改成「元素音量到 1 为止 + GainNode 补剩下的」，
 * 两边口径一致。这里的 `VOLUME_MAX` 只是**界面滑块的刻度**，不是方言的约束：
 * 手写 `volume="3"` 依旧合法，预览与成片都按 3 播放（导出软限幅兜住削波）。
 *
 * ## 淡变上限里那个「源余量」
 *
 * 任务书写 `min(片段时长/2, 源余量/2)`。落在实现里，`fade` 是**包络**——它不消耗
 * 源素材，所以「源余量」不能理解成「源文件里没用到的尾巴」（那样 3s 素材用满 3s
 * 的片段就一个淡变都做不了，和 A2 直接冲突）。这里取片段**实际消耗的源区间长度**
 * （`#t=in,out` 的 out−in）：`speed=1` 时它与片段时长相等，`speed<1`（放慢）时它更短、
 * 于是上限也更紧——语义上仍是「源里能拿来渐变的那段有多长」，并且和
 * `film-core/ops.mjs` 的 `fitFades`（in+out ≤ 片段时长）不打架。
 */

/** 界面滑块的上限（不是方言约束）。 */
export const VOLUME_MAX = 2;
export const VOLUME_MIN = 0;
export const DEFAULT_VOLUME = 1;

/** 写进文件的精度：与 `film-core/ops.mjs` 的 `round` 一致（毫秒/千分位）。 */
const round = (/** @type {number} */ value) => Math.round(value * 1000) / 1000;

/**
 * 音量 → dB。0 返回 null（静音没有 dB 值，别显示 −Infinity）。
 * @param {unknown} volume
 * @returns {number|null}
 */
export function volumeToDb(volume) {
  const value = Number(volume);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(20 * Math.log10(value) * 100) / 100;
}

/**
 * dB → 音量。用来做「+6 dB = 2.0」这类换算显示，不参与写盘。
 * @param {number} db
 */
export function dbToVolume(db) {
  const value = Number(db);
  if (!Number.isFinite(value)) return DEFAULT_VOLUME;
  return 10 ** (value / 20);
}

/**
 * 给界面用的一句话：`静音` / `−6.0 dB` / `+6.0 dB`。
 * @param {unknown} volume
 * @param {{ suffix?: boolean }} [opts] suffix=false 时省略单位（窄控件）
 */
export function formatVolumeDb(volume, opts = {}) {
  const db = volumeToDb(volume);
  const unit = opts.suffix === false ? '' : ' dB';
  if (db === null) return '静音';
  const sign = db > 0 ? '+' : db < 0 ? '−' : '';
  return `${sign}${Math.abs(db).toFixed(1)}${unit}`;
}

/**
 * 夹到界面刻度。非数/NaN 退回默认 1（输入框清空时不该把片段静音）。
 * @param {unknown} value
 * @param {number} [max]
 */
export function clampVolume(value, max = VOLUME_MAX) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_VOLUME;
  const ceiling = Number.isFinite(max) && max > 0 ? max : VOLUME_MAX;
  return round(Math.max(VOLUME_MIN, Math.min(ceiling, number)));
}

/**
 * `volume` 的**有效值**：没写属性就是 1（合同默认）。显式 `volume="1"` 解析出来也是 1，
 * 写回时会删掉属性（`ops.mjs` 的 setField 这么定的），所以这里不区分「显式 1」。
 * @param {{ volume?: unknown }} clip
 */
export function effectiveVolume(clip) {
  const value = Number(/** @type {any} */ (clip)?.volume);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_VOLUME;
  return value;
}

/**
 * `fade` 的有效值：`[in, out]`，缺省 `[0, 0]`。
 * @param {{ fade?: unknown }} clip
 * @returns {[number, number]}
 */
export function effectiveFade(clip) {
  const raw = /** @type {any} */ (clip)?.fade;
  if (!Array.isArray(raw) || raw.length < 2) return [0, 0];
  const fadeIn = Number(raw[0]);
  const fadeOut = Number(raw[1]);
  return [
    Number.isFinite(fadeIn) && fadeIn > 0 ? fadeIn : 0,
    Number.isFinite(fadeOut) && fadeOut > 0 ? fadeOut : 0,
  ];
}

/**
 * 片段在时间线上的时长（秒）。`#t=in`（只给入口）没有确定出点 → 0。
 * @param {{ time?: unknown, speed?: unknown }} clip
 */
export function clipLength(clip) {
  const time = /** @type {any} */ (clip)?.time;
  const speed = Number(/** @type {any} */ (clip)?.speed);
  if (!Array.isArray(time) || time.length < 2) return 0;
  const from = Number(time[0]);
  const to = Number(time[1]);
  if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from)) return 0;
  const rate = Number.isFinite(speed) && speed > 0 ? speed : 1;
  return round((to - from) / rate);
}

/**
 * 片段消耗的源区间长度（秒）。没有 `#t=` 时只能给 0（不知道源多长）。
 * @param {{ time?: unknown }} clip
 */
export function sourceSpan(clip) {
  const time = /** @type {any} */ (clip)?.time;
  if (!Array.isArray(time) || time.length < 2) return 0;
  const from = Number(time[0]);
  const to = Number(time[1]);
  if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from)) return 0;
  return round(to - from);
}

/**
 * 单侧淡变的上限（秒）：`min(片段时长/2, 源区间/2)`，再让「两侧相加 ≤ 片段时长」。
 * @param {{ time?: unknown, speed?: unknown, fade?: unknown }} clip
 * @param {'in'|'out'} [edge] 给了就扣掉另一侧已占用的长度
 * @param {[number, number]} [fade] 另一侧取值（缺省读 clip.fade）
 */
export function fadeLimit(clip, edge, fade) {
  const length = clipLength(clip);
  if (!(length > 0)) return 0;
  const span = sourceSpan(clip);
  const half = Math.min(length / 2, span > 0 ? span / 2 : length / 2);
  if (edge !== 'in' && edge !== 'out') return round(half);
  const [fadeIn, fadeOut] = fade ?? effectiveFade(clip);
  const other = edge === 'in' ? fadeOut : fadeIn;
  return round(Math.max(0, Math.min(half, length - other)));
}

/**
 * 夹一对淡变值（按 `fitFades` 的比例缩放，不改两侧的相对关系）。
 * @param {{ time?: unknown, speed?: unknown }} clip
 * @param {[number, number]} fade
 * @returns {{ fade: [number, number], clamped: boolean, limit: number }}
 */
export function clampFadePair(clip, fade) {
  const length = clipLength(clip);
  const limit = fadeLimit(clip);
  let [fadeIn, fadeOut] = fade;
  let clamped = false;
  if (!(fadeIn >= 0) || fadeIn > limit) {
    fadeIn = Math.max(0, Math.min(limit, Number(fadeIn) || 0));
    clamped = true;
  }
  if (!(fadeOut >= 0) || fadeOut > limit) {
    fadeOut = Math.max(0, Math.min(limit, Number(fadeOut) || 0));
    clamped = true;
  }
  if (length > 0 && fadeIn + fadeOut > length) {
    const k = length / (fadeIn + fadeOut);
    fadeIn *= k;
    fadeOut *= k;
    clamped = true;
  }
  return { fade: [round(fadeIn), round(fadeOut)], clamped, limit };
}

/**
 * 拖一侧：另一侧保持不动，只夹这一侧。
 * @param {{ time?: unknown, speed?: unknown, fade?: unknown }} clip
 * @param {'in'|'out'} edge
 * @param {number} seconds
 * @returns {{ fade: [number, number], clamped: boolean, limit: number, requested: number }}
 */
export function clampFadeEdge(clip, edge, seconds) {
  const [fadeIn, fadeOut] = effectiveFade(clip);
  const limit = fadeLimit(clip, edge, [fadeIn, fadeOut]);
  const requested = Number(seconds);
  const wanted = Number.isFinite(requested) ? requested : 0;
  const value = round(Math.max(0, Math.min(limit, wanted)));
  const clamped = Math.abs(value - wanted) > 1e-9;
  const next = /** @type {[number, number]} */ (edge === 'in' ? [value, fadeOut] : [fadeIn, value]);
  return { fade: next, clamped, limit, requested: wanted };
}

/**
 * 多选时的音频控件状态。
 *
 * - `volume` / `fade`：全部一致时给数值，不一致给 null（界面显示「混合」）；
 * - `soundCount`：能改音量的片段数（只有 `<audio>` 片段进混音，画面片段的 volume 没人读）；
 * - `fadeCount`：能改淡变的片段数（画面/图片/网页片段的 fade 是**画面**淡变，也算）。
 * @param {Array<{ id: string, clip: any }>} targets
 */
export function audioSelection(targets) {
  const list = Array.isArray(targets) ? targets.filter((item) => item && item.clip) : [];
  const sound = list.filter((item) => item.clip.kind === 'sound');
  /** @type {number|null} */
  let volume = null;
  const firstSound = sound[0];
  if (firstSound !== undefined) {
    const first = effectiveVolume(firstSound.clip);
    volume = sound.every((item) => Math.abs(effectiveVolume(item.clip) - first) < 1e-9) ? first : null;
  }
  /** @type {[number|null, number|null]} */
  const fade = [null, null];
  const firstAny = list[0];
  if (firstAny !== undefined) {
    const first = effectiveFade(firstAny.clip);
    const sameIn = list.every((item) => Math.abs(effectiveFade(item.clip)[0] - first[0]) < 1e-9);
    const sameOut = list.every((item) => Math.abs(effectiveFade(item.clip)[1] - first[1]) < 1e-9);
    fade[0] = sameIn ? first[0] : null;
    fade[1] = sameOut ? first[1] : null;
  }
  // 上限取交集里最紧的那个：多选时拖到某个片段撑不住的长度，就得停。
  let limit = Number.POSITIVE_INFINITY;
  let limitedBy = '';
  for (const item of list) {
    const own = fadeLimit(item.clip);
    if (own < limit) {
      limit = own;
      limitedBy = String(item.id);
    }
  }
  return {
    soundCount: sound.length,
    fadeCount: list.length,
    volume,
    fade,
    volumeMixed: sound.length > 0 && volume === null,
    fadeMixedIn: list.length > 0 && fade[0] === null,
    fadeMixedOut: list.length > 0 && fade[1] === null,
    fadeLimit: Number.isFinite(limit) ? limit : 0,
    fadeLimitedBy: limitedBy,
  };
}

/**
 * 一条 `props` Op 打包一批编辑（一次请求 = 一步撤销）。
 * @param {Array<{ clip: string, prop: string, value: any }>} edits
 */
function propsOp(edits) {
  return { op: 'props', edits };
}

/**
 * 一批「改音量」的 Op。跳过没有变化的片段（避免拖动末尾的一点点抖动写盘）。
 * @param {Array<{ id: string, clip: any }>} targets
 * @param {unknown} volume
 * @param {{ max?: number }} [opts]
 */
export function planVolumeOps(targets, volume, opts = {}) {
  const max = opts.max ?? VOLUME_MAX;
  const wanted = Number(volume);
  const value = clampVolume(wanted, max);
  const requestsOutOfRange = Number.isFinite(wanted) && (wanted > max + 1e-9 || wanted < VOLUME_MIN - 1e-9);
  const edits = [];
  for (const item of targets) {
    if (!item || !item.clip || item.clip.kind !== 'sound') continue;
    if (Math.abs(effectiveVolume(item.clip) - value) < 1e-6) continue;
    edits.push({ clip: String(item.id), prop: 'volume', value });
  }
  return {
    ops: edits.length > 0 ? [propsOp(edits)] : [],
    value,
    clamped: requestsOutOfRange,
    edits: edits.length,
    skipped: targets.filter((item) => item?.clip?.kind !== 'sound').map((item) => String(item?.id ?? '')),
  };
}

/**
 * 一批「改单侧淡变」的 Op。另一侧保持原值。
 * @param {Array<{ id: string, clip: any }>} targets
 * @param {'in'|'out'} edge
 * @param {number} seconds
 */
export function planFadeOps(targets, edge, seconds) {
  if (edge !== 'in' && edge !== 'out') throw new Error(`淡变只能是 in/out，收到 ${String(edge)}`);
  const edits = [];
  let clamped = false;
  let last = /** @type {[number, number]} */ ([0, 0]);
  let limit = 0;
  for (const item of targets) {
    if (!item || !item.clip) continue;
    const planned = clampFadeEdge(item.clip, edge, seconds);
    if (planned.clamped) clamped = true;
    limit = planned.limit;
    last = planned.fade;
    const [nowIn, nowOut] = effectiveFade(item.clip);
    if (Math.abs(planned.fade[0] - nowIn) < 1e-9 && Math.abs(planned.fade[1] - nowOut) < 1e-9) continue;
    edits.push({ clip: String(item.id), prop: 'fade', value: planned.fade });
  }
  return { ops: edits.length > 0 ? [propsOp(edits)] : [], clamped, edits: edits.length, fade: last, limit };
}

/**
 * 回到默认值（音量 1.0、淡变 0）。`scope` 只清一项时用 'fade' / 'volume'。
 * @param {Array<{ id: string, clip: any }>} targets
 * @param {'all'|'fade'|'volume'} [scope]
 */
export function planResetOps(targets, scope = 'all') {
  const edits = [];
  for (const item of targets) {
    if (!item || !item.clip) continue;
    const [fadeIn, fadeOut] = effectiveFade(item.clip);
    const isSound = item.clip.kind === 'sound';
    const volume = effectiveVolume(item.clip);
    if (scope !== 'volume' && (fadeIn > 0 || fadeOut > 0)) {
      edits.push({ clip: String(item.id), prop: 'fade', value: [0, 0] });
    }
    if (scope !== 'fade' && isSound && Math.abs(volume - DEFAULT_VOLUME) > 1e-9) {
      edits.push({ clip: String(item.id), prop: 'volume', value: DEFAULT_VOLUME });
    }
  }
  return { ops: edits.length > 0 ? [propsOp(edits)] : [], edits: edits.length };
}

/**
 * 静音开关的目标状态（多选混合时 `muted` 为 null）。
 *
 * 只看声音片段：画面片段的 `muted` 是浏览器里的元素行为，跟混音无关（预览里视频本来就静音）。
 * @param {Array<{ id: string, clip: any }>} targets
 */
export function muteStateOf(targets) {
  const sound = (Array.isArray(targets) ? targets : []).filter((item) => item && item.clip && item.clip.kind === 'sound');
  const head = sound[0];
  if (head === undefined) return { muted: false, mixed: false, count: 0 };
  const first = head.clip.muted === true;
  const mixed = sound.some((item) => (item.clip.muted === true) !== first);
  return { muted: mixed ? false : first, mixed, count: sound.length };
}

/**
 * 静音/取消静音。
 *
 * 写的是**片段级** `muted`，只能用 `fields`：`props` 里的 `muted` 是轨道旗标
 * （applyProps 会把它落到 track 上），`set` 又不在 SETTABLE 里。
 * **不动 `volume`**——取消静音要回到原来的音量，这是 `muted != volume=0` 的落点。
 * @param {Array<{ id: string, clip: any }>} targets
 * @param {boolean} muted
 */
export function planMuteOps(targets, muted) {
  const value = muted === true;
  const ops = [];
  const skipped = [];
  for (const item of targets || []) {
    if (!item || !item.clip) continue;
    if (item.clip.kind !== 'sound') {
      skipped.push(String(item.id));
      continue;
    }
    if ((item.clip.muted === true) === value) continue;
    ops.push({ op: 'fields', clip: String(item.id), fields: { muted: value } });
  }
  return { ops, value, edits: ops.length, skipped };
}
