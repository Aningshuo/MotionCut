/**
 * 编辑操作引擎（合同 contracts/edit-ops.ts v1.0.0 的 11 类 Op）。
 *
 * 纯函数：只由 `(value, ops)` 决定结果，不读盘、不读时钟、不写文件。
 * `value` 是 `parse()` 得到的 `FilmDoc` 投影（`{stage, fps, tracks}`）；`tracks` 的**数组顺序**
 * 即层叠顺序，`index` 只是写回用的编号（整批结束后按顺序重排）。
 *
 * 三条不变量：
 * 1. 整批成功或整批不动：先在副本上做，任一 Op 抛 `EditError` 就不存在半个结果。
 * 2. 归一化只在 `props`/`fields` 里发生：`start`/`end`→`time`、`gainDb`→`volume`、
 *    `fade`→`fade`、`link`→`data-link`、`props`→`attrs['data-props']`；
 *    `set` 只接受 `SETTABLE` 白名单（其余字段只能走 `fields`/`props`）。
 * 3. 整批结束后统一 `dropEmptyTracks` + `fitFades` + 同轨按 `at` 排序，所以批内每条 Op
 *    看到的都是前一条留下的轨道/片段，不会互相踩。
 */

import { hasClipKeyframes } from './clip-state.mjs';
import { validateTextStyle } from './text-style.mjs';

/** 操作失败：`code` 取合同 `EditErrorCode` 的判定子集（CONFLICT 由 CAS 层给，不在这里）。 */
export class EditError extends Error {
  /**
   * @param {string} message
   * @param {'INVALID'|'NOT_FOUND'|'LOCKED'|'CONFLICT'} [code]
   * @param {{ field?: string, allowed?: string[] }} [details]
   *   M80：能指到字段的错误把 `field` / `allowed` 也带上。消息里同时写明允许值，
   *   这样即使上层只转发 `message`（HTTP 的 `/ops` 就是这样），调用方也能看到 allowed。
   */
  constructor(message, code = 'INVALID', details = undefined) {
    super(message);
    this.name = 'EditError';
    this.code = code;
    if (details !== undefined) {
      if (typeof details.field === 'string') this.field = details.field;
      if (Array.isArray(details.allowed)) this.allowed = details.allowed;
    }
  }
}

/** Studio 可以直接 `set` 的字段（其余只能由 fields/props 走）。 */
export const SETTABLE = Object.freeze(new Set(['at', 'time', 'box', 'size', 'volume', 'speed', 'overrides', 'src']));

/* ── `fields` op 的键白名单（M80 · B-MAIN-R30-039） ──────────────────────
 *
 * 以前 `fields` 能把**任意键**写进片段值：`{opacity: 0.5}` 一路通过 ops，到写回层才被
 * M77 的键闸门拒掉。结果是「op 层放行、写盘层才失败」——CLI / Agent 先以为成功。
 *
 * 现在按「元素类型 × 字段组」在 ops 层就判：
 * - geometry   几何：box/size（以及 M77 的 x/y/w/h/r 简写）；
 * - typography 排印：style/overrides；
 * - appearance 外观：attrs/fade/link；
 * - timing     时间：at/time/speed；
 * - audio      音轨：volume/muted；
 * - source     来源：src/kind/sound（重链、改类型）。
 *
 * 画面类（video/still/page）全都有；纯音频没有几何与排印；字幕有排印没有几何。
 * **已经在该片段上的键永远允许**：撤销/重做（`props` 的反向 Op 也走 fields）必须能把原样
 * 写回去，白名单只约束「新增键」。
 */
export const FIELD_GROUPS = Object.freeze({
  geometry: Object.freeze(['box', 'size', 'x', 'y', 'w', 'h', 'r']),
  typography: Object.freeze(['style', 'overrides']),
  appearance: Object.freeze(['attrs', 'fade', 'link']),
  timing: Object.freeze(['at', 'time', 'speed']),
  audio: Object.freeze(['volume', 'muted']),
  source: Object.freeze(['src', 'kind', 'sound']),
  /** E12-P3：文本片段的内容（`<div>…</div>` 里的字）。只有 text 有这一组。 */
  content: Object.freeze(['text']),
});

/** 每种元素类型允许的字段组。 @type {Record<string, readonly string[]>} */
export const ELEMENT_FIELD_GROUPS = Object.freeze({
  video: Object.freeze(['geometry', 'typography', 'appearance', 'timing', 'audio', 'source']),
  still: Object.freeze(['geometry', 'typography', 'appearance', 'timing', 'audio', 'source']),
  page: Object.freeze(['geometry', 'typography', 'appearance', 'timing', 'audio', 'source']),
  sound: Object.freeze(['appearance', 'timing', 'audio', 'source']),
  subtitle: Object.freeze(['typography', 'appearance', 'timing', 'source']),
  text: Object.freeze(['geometry', 'typography', 'appearance', 'timing', 'source', 'content']),
});

/**
 * 某类元素允许 `fields` 写的键（顺序稳定：错误里的 `allowed` 要能直接显示）。
 * @param {string} kind
 * @returns {string[]}
 */
export function fieldsAllowedFor(kind) {
  const byKind = /** @type {Record<string, readonly string[]>} */ (ELEMENT_FIELD_GROUPS);
  const byGroup = /** @type {Record<string, readonly string[]>} */ (FIELD_GROUPS);
  const groups = byKind[kind] ?? byKind.video ?? [];
  /** @type {string[]} */
  const keys = [];
  for (const group of groups) keys.push(...(byGroup[group] ?? []));
  return keys;
}

/** `props` 认识的 prop：片段字段、轨道旗标、轨道位置、轨道顺序。 */
export const PROP_NAMES = Object.freeze(
  new Set([
    'at',
    'start',
    'end',
    'time',
    'box',
    'size',
    'volume',
    'gainDb',
    'speed',
    'overrides',
    'src',
    'text',
    'fade',
    'link',
    'props',
    'track',
    'trackOrder',
    'locked',
    'hidden',
    'muted',
  ]),
);

const TRACK_FLAGS = new Set(['locked', 'hidden', 'muted']);
const TIME_PROPS = new Set(['at', 'start', 'end']);

/** 视频/音频/页面/字幕：按 src 后缀判定，插入时决定元素类型与轨道角色。 */
const KIND_BY_EXT = new Map([
  ['mp4', 'video'],
  ['m4v', 'video'],
  ['mov', 'video'],
  ['webm', 'video'],
  ['mkv', 'video'],
  ['avi', 'video'],
  ['mp3', 'sound'],
  ['wav', 'sound'],
  ['m4a', 'sound'],
  ['aac', 'sound'],
  ['flac', 'sound'],
  ['ogg', 'sound'],
  ['opus', 'sound'],
  ['html', 'page'],
  ['htm', 'page'],
  ['vtt', 'subtitle'],
  ['srt', 'subtitle'],
  ['ass', 'subtitle'],
]);

/** 图片：`<img>`（静帧）。 */
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'svg']);

/**
 * 片段类型：解析器给的 `kind` 优先（它由标签 + 扩展名共同决定），其次按 src 后缀推。
 * `text`（E12-P3）没有媒体文件，只能由 `kind` 声明 —— 按后缀永远推不出来。
 * @param {{ src?: unknown, kind?: unknown, sound?: unknown }} clip
 * @returns {'video'|'sound'|'page'|'still'|'text'}
 */
export function clipKindOf(clip) {
  const declared = clip?.kind;
  if (declared === 'video' || declared === 'sound' || declared === 'page' || declared === 'still' || declared === 'text') return declared;
  const src = typeof clip?.src === 'string' ? clip.src : '';
  const bare = src.split(/[?#]/)[0] ?? '';
  const ext = bare.slice(bare.lastIndexOf('.') + 1).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'still';
  return /** @type {any} */ (KIND_BY_EXT.get(ext) ?? 'video');
}

/** 轨道角色：由片段类型派生（与解析器同一张表，不各自维护第二套）。 */
const ROLE_BY_KIND = { video: 'picture', sound: 'audio', page: 'page', still: 'picture', subtitle: 'subtitle', text: 'picture' };

/**
 * @param {any} track
 * @returns {'picture'|'audio'|'page'|'subtitle'}
 */
function derivedRole(track) {
  if (track.clips.length === 0) return 'picture';
  const kinds = track.clips.map((/** @type {any} */ clip) => clipKindOf(clip));
  if (kinds.every((/** @type {string} */ kind) => kind === 'sound')) return 'audio';
  if (kinds.every((/** @type {string} */ kind) => kind === 'page' || kind === 'sound') && kinds.some((/** @type {string} */ kind) => kind === 'page')) {
    return 'page';
  }
  return 'picture';
}

/* ── 小工具 ── */

/** 毫秒精度：拖动带浮点噪声，写进文件的是人能读的数。 */
const round = (/** @type {number} */ value) => Math.round(value * 1000) / 1000;

const isPlainObject = (/** @type {unknown} */ value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** @param {string} src */
function stemOf(src) {
  const bare = src.split(/[?#]/)[0] ?? '';
  const name = bare.slice(bare.lastIndexOf('/') + 1);
  const stem = name.slice(0, name.lastIndexOf('.') > 0 ? name.lastIndexOf('.') : undefined);
  const cleaned = stem.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '');
  return /^[A-Za-z]/.test(cleaned) ? cleaned : 'clip';
}

/** @param {Set<string>} used @param {string} base */
function mintId(used, base) {
  const stem = /^[A-Za-z][\w-]*$/.test(base) ? base : 'clip';
  if (!used.has(stem)) return stem;
  let index = 2;
  while (used.has(`${stem}-${index}`)) index += 1;
  return `${stem}-${index}`;
}

/** @param {any} value */
function usedIds(value) {
  /** @type {Set<string>} */
  const used = new Set();
  for (const track of value.tracks) for (const clip of track.clips) used.add(clip.id);
  return used;
}

/** @param {any} value @param {string} id */
function find(value, id) {
  for (let t = 0; t < value.tracks.length; t += 1) {
    const clips = value.tracks[t].clips;
    for (let c = 0; c < clips.length; c += 1) {
      if (clips[c].id === id) return { t, c, clip: clips[c], track: value.tracks[t] };
    }
  }
  throw new EditError(`片段不存在：${id}`, 'NOT_FOUND');
}

/** 锁轨上的片段不许被改（锁轨本身仍可解锁）。 */
function assertEditable(/** @type {any} */ track, /** @type {string} */ id) {
  if (track.locked === true) throw new EditError(`轨道已锁定，不能改片段 ${id}`, 'LOCKED');
}

/** @param {any} value */
function cloneValue(value) {
  return {
    stage: { ...value.stage },
    fps: { ...value.fps },
    tracks: value.tracks.map((/** @type {any} */ track) => ({
      ...track,
      clips: track.clips.map((/** @type {any} */ clip) => structuredClone(clip)),
    })),
  };
}

/** @param {any} track */
function sortTrack(track) {
  track.clips.sort((/** @type {any} */ a, /** @type {any} */ b) => Number(a.at ?? 0) - Number(b.at ?? 0));
}

/**
 * 轨道定位：`number` 是现有轨道的位置，`{insert:n}` 是在 n 处新建一条。
 * @param {any} value @param {number|{insert:number}|undefined} target @param {number|undefined} [newTrack]
 */
function targetTrack(value, target, newTrack) {
  const insertAt = newTrack !== undefined ? newTrack : isPlainObject(target) ? Number(/** @type {any} */ (target).insert) : null;
  if (insertAt !== null) {
    if (!Number.isInteger(insertAt) || insertAt < 0 || insertAt > value.tracks.length) {
      throw new EditError(`不能在位置 ${insertAt} 新建轨道`, 'INVALID');
    }
    value.tracks.splice(insertAt, 0, { index: insertAt, role: 'picture', clips: [] });
    return insertAt;
  }
  if (target === undefined) {
    if (value.tracks.length === 0) {
      value.tracks.push({ index: 0, role: 'picture', clips: [] });
      return 0;
    }
    return 0;
  }
  const index = Number(target);
  if (!Number.isInteger(index) || value.tracks[index] === undefined) {
    throw new EditError(`轨道不存在：${String(target)}`, 'NOT_FOUND');
  }
  return index;
}

/* ── 字段归一化 ── */

/**
 * 一个字段写进片段（默认值不写，`null` 删除）。
 * @param {any} clip
 * @param {string} prop
 * @param {any} value
 */
function setField(clip, prop, value) {
  if (prop === 'id' || prop === 'track' || prop === 'trackOrder' || TRACK_FLAGS.has(prop)) return;
  if (!PROP_NAMES.has(prop)) throw new EditError(`不认识的属性：${prop}`, 'INVALID');

  switch (prop) {
    case 'start':
    case 'end': {
      const current = Array.isArray(clip.time) ? clip.time : [];
      const from = prop === 'start' ? (value === null ? 0 : Number(value)) : Number(current[0] ?? 0);
      const to = prop === 'end' ? (value === null ? undefined : Number(value)) : current[1];
      if (!Number.isFinite(from) || from < 0) throw new EditError(`${prop} 不是有效时间：${String(value)}`, 'INVALID');
      if (to === undefined || to === null) {
        // 我们的 film.html 把区间写在 src 的 #t= 里且两端齐全；只给 start 又没有末端时无法推断长度。
        throw new EditError(`${prop} 需要片段有明确的另一端（time 两端齐全）`, 'INVALID');
      }
      if (!Number.isFinite(Number(to)) || Number(to) < from) {
        throw new EditError(`裁剪区间倒置：${from} > ${String(to)}`, 'INVALID');
      }
      clip.time = [round(from), round(Number(to))];
      return;
    }
    case 'time': {
      const range = asRange(value);
      if (range === null) throw new EditError(`time 非法：${JSON.stringify(value)}`, 'INVALID');
      clip.time = range;
      return;
    }
    case 'at': {
      if (value === null || value === undefined) {
        delete clip.at;
        return;
      }
      const at = Number(value);
      if (!Number.isFinite(at) || at < 0) throw new EditError(`at 非法：${String(value)}`, 'INVALID');
      if (at === 0) delete clip.at;
      else clip.at = round(at);
      return;
    }
    case 'volume': {
      if (value === null || value === undefined) {
        delete clip.volume;
        return;
      }
      const volume = Number(value);
      if (!Number.isFinite(volume) || volume < 0) throw new EditError(`volume 非法：${String(value)}`, 'INVALID');
      if (volume === 1) delete clip.volume;
      else clip.volume = volume;
      return;
    }
    case 'gainDb': {
      if (value === null || value === undefined) {
        delete clip.volume;
        return;
      }
      const db = Number(value);
      if (!Number.isFinite(db)) throw new EditError(`gainDb 非法：${String(value)}`, 'INVALID');
      const volume = round(10 ** (db / 20));
      if (volume === 1) delete clip.volume;
      else clip.volume = volume;
      return;
    }
    case 'speed': {
      if (value === null || value === undefined) {
        delete clip.speed;
        return;
      }
      const speed = Number(value);
      if (!Number.isFinite(speed) || speed <= 0) throw new EditError(`speed 非法：${String(value)}`, 'INVALID');
      if (speed === 1) delete clip.speed;
      else clip.speed = speed;
      return;
    }
    case 'fade': {
      if (value === null || value === undefined) {
        delete clip.fade;
        syncOwnOverride(clip);
        return;
      }
      if (!Array.isArray(value) || value.length !== 2) throw new EditError('fade 必须是 [in, out]', 'INVALID');
      const fadeIn = Number(value[0]);
      const fadeOut = Number(value[1]);
      if (!Number.isFinite(fadeIn) || !Number.isFinite(fadeOut) || fadeIn < 0 || fadeOut < 0) {
        throw new EditError('fade 必须是两个非负秒数', 'INVALID');
      }
      if (fadeIn === 0 && fadeOut === 0) delete clip.fade;
      else clip.fade = [round(fadeIn), round(fadeOut)];
      syncOwnOverride(clip);
      return;
    }
    case 'text': {
      /* E12-P3：文本片段的内容。空串 = 空段落（保留 text 键，写盘是 `<div></div>`）。 */
      if (value === null || value === undefined) {
        delete clip.text;
        return;
      }
      if (typeof value !== 'string') throw new EditError('text 必须是字符串', 'INVALID');
      if (value.length > 4000) throw new EditError('text 最长 4000 字', 'INVALID');
      clip.text = value;
      return;
    }
    case 'link': {
      if (value === null || value === undefined || value === '') {
        delete clip.link;
        return;
      }
      if (typeof value !== 'string') throw new EditError('link 必须是字符串', 'INVALID');
      clip.link = value;
      return;
    }
    case 'props': {
      if (value === null || value === undefined) {
        deleteAttr(clip, 'data-props');
        return;
      }
      setAttr(clip, 'data-props', typeof value === 'string' ? value : JSON.stringify(value));
      return;
    }
    case 'box': {
      if (value === null || value === undefined) {
        delete clip.box;
        return;
      }
      if (!isPlainObject(value)) throw new EditError('box 必须是对象', 'INVALID');
      const box = /** @type {any} */ (value);
      /** @type {{ x: number, y: number, w: number, h: number, r?: number }} */
      const next = { x: Number(box.x ?? 0), y: Number(box.y ?? 0), w: Number(box.w), h: Number(box.h) };
      if (![next.x, next.y, next.w, next.h].every((item) => Number.isFinite(item))) {
        throw new EditError('box 的 x/y/w/h 必须是数值', 'INVALID');
      }
      if (next.w <= 0 || next.h <= 0) throw new EditError('box 的宽高必须大于 0', 'INVALID');
      if (box.r !== undefined && box.r !== null) next.r = Number(box.r);
      clip.box = next;
      return;
    }
    case 'size': {
      if (value === null || value === undefined) {
        delete clip.size;
        return;
      }
      const size = /** @type {any} */ (value);
      const w = Number(size.w);
      const h = Number(size.h);
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
        throw new EditError('size 必须是 {w,h} 且大于 0', 'INVALID');
      }
      clip.size = { w: Math.round(w), h: Math.round(h) };
      return;
    }
    case 'overrides': {
      if (value === null || value === undefined) {
        delete clip.overrides;
        return;
      }
      clip.overrides = validateOverrides(value);
      return;
    }
    case 'src': {
      if (typeof value !== 'string' || value.trim() === '') throw new EditError('src 必须是非空字符串', 'INVALID');
      clip.src = value;
      return;
    }
    default:
      throw new EditError(`不认识的属性：${prop}`, 'INVALID');
  }
}

/** @param {any} clip @param {string} name @param {string} value */
function setAttr(clip, name, value) {
  clip.attrs = { ...(clip.attrs ?? {}), [name]: value };
}

/** @param {any} clip @param {string} name */
function deleteAttr(clip, name) {
  if (clip.attrs === undefined) return;
  const next = { ...clip.attrs };
  delete next[name];
  if (Object.keys(next).length === 0) delete clip.attrs;
  else clip.attrs = next;
}

/**
 * `fade` 是 `overrides` 里自有条目（没有 `at` 的那条）的投影：改 fade 时同步那一条，层覆盖不动。
 * @param {any} clip
 */
function syncOwnOverride(clip) {
  const layers = Array.isArray(clip.overrides)
    ? clip.overrides.filter((/** @type {any} */ entry) => entry !== null && typeof entry === 'object' && entry.at !== undefined)
    : [];
  const own = Array.isArray(clip.fade) ? [{ fade: [Number(clip.fade[0]), Number(clip.fade[1])] }] : [];
  const list = [...own, ...layers];
  if (list.length === 0) delete clip.overrides;
  else clip.overrides = list;
}

/** @param {unknown} value @returns {number[]|null} */
function asRange(value) {
  if (!Array.isArray(value) || (value.length !== 1 && value.length !== 2)) return null;
  const from = Number(value[0]);
  if (!Number.isFinite(from) || from < 0) return null;
  if (value.length === 1) return [round(from)];
  const to = Number(value[1]);
  if (!Number.isFinite(to) || to < from) return null;
  return [round(from), round(to)];
}

/**
 * `/ops` 这条写盘路上的层覆盖白名单。
 *
 * **与 `film-doc.mjs` 的 `OVERRIDE_KEYS` 同源**（一处给 parse、一处给 `/ops`；两处白名单
 * 并存是既有形态，加字段必须同时加）。键集合由 `test/override-keys-parity.test.mjs`
 * 逐字比对；取值规则两边都走 `text-style.mjs` 的 `validateTextStyle`，不分叉。
 */
export const OPS_OVERRIDE_KEYS = new Set([
  'at', 'n', 't', 's', 'r', 'style', 'lock', 'text', 'kf',
  'stroke', 'bg', 'align', 'tracking',
]);

/** @param {unknown} value */
function validateOverrides(value) {
  if (!Array.isArray(value)) throw new EditError('overrides 必须是数组', 'INVALID');
  const allowed = OPS_OVERRIDE_KEYS;
  let own = 0;
  for (const entry of value) {
    if (!isPlainObject(entry)) throw new EditError('overrides 条目必须是对象', 'INVALID');
    const record = /** @type {any} */ (entry);
    const keys = Object.keys(record);
    if (record.at === undefined) {
      own += 1;
      if (own > 1) throw new EditError('overrides 里最多一条没有 at 的条目（片段自有）', 'INVALID');
      const bad = keys.filter((key) => key !== 'fade');
      if (bad.length > 0) throw new EditError(`片段自有覆盖只放 fade：${bad.join(',')}`, 'INVALID');
      continue;
    }
    if (typeof record.at !== 'string' || record.at === '') {
      throw new EditError('overrides 的层覆盖条目缺少 at', 'INVALID');
    }
    const bad = keys.filter((key) => !allowed.has(key));
    if (bad.length > 0) throw new EditError(`overrides 条目含未知字段：${bad.join(',')}`, 'INVALID');
    /* 文本样式四键的取值在这里也要拦：`/ops` 绕过了 parse，只查键名会把
       `stroke:{color:'red'}` 这种写进文件，下次 parse 才红。码写进消息里便于定位。 */
    const textStyle = validateTextStyle(record);
    if (!textStyle.ok) throw new EditError(`[${textStyle.code}] ${textStyle.message}`, 'INVALID');
  }
  return structuredClone(value);
}

/** 切分时淡入留给左半、淡出留给右半。 @param {any} left @param {any} right */
function splitFades(left, right) {
  const fade = left.fade;
  if (!Array.isArray(fade)) return;
  setField(left, 'fade', [Number(fade[0]) || 0, 0]);
  setField(right, 'fade', [0, Number(fade[1]) || 0]);
}

/** 淡入淡出加起来超过片段长度时按比例缩到装得下（否则文件读不回来）。 @param {any} value */
function fitFades(value) {
  for (const track of value.tracks) {
    for (const clip of track.clips) {
      if (!Array.isArray(clip.fade) || !Array.isArray(clip.time)) continue;
      const speed = typeof clip.speed === 'number' && clip.speed > 0 ? clip.speed : 1;
      const length = Math.max(0, (Number(clip.time[1]) - Number(clip.time[0])) / speed);
      const [fadeIn, fadeOut] = clip.fade.map(Number);
      if (!(fadeIn + fadeOut > length + 1e-9)) continue;
      const k = length / (fadeIn + fadeOut);
      clip.fade = [Math.floor(fadeIn * k * 1000) / 1000, Math.floor(fadeOut * k * 1000) / 1000];
    }
  }
}

/** @param {any} value */
function dropEmptyTracks(value) {
  value.tracks = value.tracks.filter((/** @type {any} */ track) => track.clips.length > 0);
}

/* ── props 批 ── */

/**
 * 一批属性，按固定顺序：先片段字段，再轨道旗标，再换轨，最后轨道顺序。
 * 换轨先统一「移出」再统一「放入」，所以同一批里两条片子互换轨道不会互相踩。
 * @param {any} value @param {any[]} edits @param {(id: string) => void} [touch]
 */
function applyProps(value, edits, touch) {
  if (!Array.isArray(edits) || edits.length === 0) throw new EditError('props 需要 edits', 'INVALID');

  for (const edit of edits) {
    if (!isPlainObject(edit) || typeof edit.clip !== 'string' || typeof edit.prop !== 'string') {
      throw new EditError('props 的每条 edit 必须是 {clip, prop, value}', 'INVALID');
    }
    if (!PROP_NAMES.has(edit.prop)) throw new EditError(`不认识的属性：${edit.prop}`, 'INVALID');
  }

  const fields = edits.filter((edit) => edit.prop !== 'track' && edit.prop !== 'trackOrder' && !TRACK_FLAGS.has(edit.prop));
  const flags = edits.filter((edit) => TRACK_FLAGS.has(edit.prop));
  const moves = edits.filter((edit) => edit.prop === 'track');
  const orders = edits.filter((edit) => edit.prop === 'trackOrder');

  /** @type {Set<any>} */
  const resort = new Set();

  for (const edit of fields) {
    const at = find(value, edit.clip);
    assertEditable(at.track, edit.clip);
    const raw = TIME_PROPS.has(edit.prop) && typeof edit.value === 'number' ? round(edit.value) : edit.value;
    setField(at.clip, edit.prop, raw);
    if (edit.prop === 'at') resort.add(at.track);
    touch?.(edit.clip);
  }

  for (const edit of flags) {
    const at = find(value, edit.clip);
    // 锁轨只允许解锁（否则锁上就再也解不开）。
    if (at.track.locked === true && edit.value === true) throw new EditError(`轨道已锁定：${edit.clip}`, 'LOCKED');
    if (edit.value === true) at.track[edit.prop] = true;
    else delete at.track[edit.prop];
    touch?.(edit.clip);
  }

  if (moves.length > 0) {
    /** @type {{ clip: any, from: any, to?: any, before?: any, insert: boolean }[]} */
    const plan = [];
    for (const edit of moves) {
      const at = find(value, edit.clip);
      assertEditable(at.track, edit.clip);
      const dest = edit.value;
      const insertAt =
        isPlainObject(dest) && typeof (/** @type {any} */ (dest).insert) === 'number' ? Number(/** @type {any} */ (dest).insert) : null;
      const destIndex = typeof dest === 'number' ? dest : null;
      if (insertAt === null && destIndex === null) {
        throw new EditError('track 必须是轨道位置，或 {insert:n} 表示新轨道', 'INVALID');
      }
      if (insertAt === null) {
        if (destIndex === at.t) continue;
        const to = value.tracks[/** @type {number} */ (destIndex)];
        if (to === undefined) throw new EditError(`轨道不存在：${destIndex}`, 'NOT_FOUND');
        assertEditable(to, edit.clip);
        plan.push({ clip: at.clip, from: at.track, to, insert: false });
      } else {
        plan.push({
          clip: at.clip,
          from: at.track,
          insert: true,
          ...(value.tracks[insertAt] !== undefined ? { before: value.tracks[insertAt] } : {}),
        });
      }
      touch?.(edit.clip);
    }
    for (const step of plan) {
      const index = step.from.clips.indexOf(step.clip);
      if (index >= 0) step.from.clips.splice(index, 1);
    }
    for (const step of plan) {
      if (step.to !== undefined) {
        step.to.clips.push(step.clip);
        resort.add(step.to);
      }
    }
    for (const step of plan) {
      if (!step.insert) continue;
      const before = step.before !== undefined ? value.tracks.indexOf(step.before) : -1;
      const role = ROLE_BY_KIND[clipKindOf(step.clip)] ?? 'picture';
      value.tracks.splice(before >= 0 ? before : value.tracks.length, 0, { index: 0, role, clips: [step.clip] });
    }
  }

  for (const edit of orders) {
    const dest = isPlainObject(edit.value) ? /** @type {any} */ (edit.value) : null;
    const from = Number(dest?.from);
    const to = Number(dest?.to);
    if (!Number.isInteger(from) || !Number.isInteger(to)) throw new EditError('trackOrder 必须是 {from,to}', 'INVALID');
    if (value.tracks[from] === undefined) throw new EditError(`轨道不存在：${from}`, 'NOT_FOUND');
    if (from === to) continue;
    const [taken] = value.tracks.splice(from, 1);
    value.tracks.splice(Math.max(0, Math.min(value.tracks.length, to)), 0, taken);
  }

  for (const track of resort) sortTrack(track);
}

/* ── 主入口 ── */

/**
 * 应用一批 Op，返回新值；入参不被修改，失败抛 `EditError`。
 * @param {any} value
 * @param {readonly any[]} ops
 * @param {{ seed?: string }} [options]
 */
export function applyOps(value, ops, options = {}) {
  return applyOpsDetailed(value, ops, options).value;
}

/**
 * 同 `applyOps`，另外给出：反向 Op（撤销用）、被改到的片段、是否动过轨道结构。
 * @param {any} value
 * @param {readonly any[]} ops
 * @param {{ seed?: string }} [options]
 * @returns {{ value: any, inverse: any[], touched: string[], structureChanged: boolean }}
 */
export function applyOpsDetailed(value, ops, options = {}) {
  if (!Array.isArray(ops) || ops.length === 0) throw new EditError('一批编辑至少要有一条 Op', 'INVALID');
  if (value === null || typeof value !== 'object' || !Array.isArray(value.tracks)) {
    throw new EditError('applyOps 需要一个解析后的 FilmDoc 值', 'INVALID');
  }

  const next = cloneValue(value);
  /** @type {Set<string>} */
  const touched = new Set();
  /** @type {any[][]} */
  const inverses = [];
  let structureChanged = false;

  const touch = (/** @type {string} */ id) => {
    if (typeof id === 'string') touched.add(id);
  };

  for (const op of ops) {
    if (op === null || typeof op !== 'object' || typeof op.op !== 'string') {
      throw new EditError('每条 Op 必须是带 op 字段的对象', 'INVALID');
    }
    switch (op.op) {
      case 'set': {
        if (!SETTABLE.has(op.field)) {
          throw new EditError(`Studio 不能直接 set "${op.field}"（只能走 fields/props）`, 'INVALID');
        }
        const at = find(next, op.clip);
        assertEditable(at.track, op.clip);
        const before = at.clip[op.field] === undefined ? null : structuredClone(at.clip[op.field]);
        if (op.value === undefined || op.value === null) delete at.clip[op.field];
        else setField(at.clip, op.field, op.value);
        // 反向用 fields：`set volume:1` 会按默认值删属性，只有 fields 能原样写回「显式 1」。
        inverses.push([{ op: 'fields', clip: op.clip, fields: { [op.field]: before } }]);
        touch(op.clip);
        break;
      }
      case 'move': {
        const at = find(next, op.clip);
        assertEditable(at.track, op.clip);
        if (!(typeof op.at === 'number' && Number.isFinite(op.at) && op.at >= 0)) {
          throw new EditError('move 需要 at：从 0 起的秒数', 'INVALID');
        }
        const beforeAt = at.clip.at ?? null;
        const beforeTrack = next.tracks.indexOf(at.track);
        at.track.clips.splice(at.c, 1);
        const dest =
          op.track === undefined || op.track === null ? beforeTrack : targetTrack(next, op.track, undefined);
        assertEditable(next.tracks[dest], op.clip);
        if (dest !== beforeTrack) structureChanged = true;
        const moved = at.clip;
        if (round(op.at) === 0) delete moved.at;
        else moved.at = round(op.at);
        next.tracks[dest].clips.push(moved);
        sortTrack(next.tracks[dest]);
        inverses.push([{ op: 'move', clip: op.clip, at: beforeAt ?? 0, ...(beforeTrack !== dest ? { track: beforeTrack } : {}) }]);
        touch(op.clip);
        break;
      }
      case 'insert': {
        const source = op.clip;
        const hasSrc = isPlainObject(source) && typeof (/** @type {any} */ (source).src) === 'string' && (/** @type {any} */ (source).src) !== '';
        /* E12-P3：文本片段没有媒体文件 —— `kind:'text'` + `text` 就够，src 可省。 */
        const declaredKind = isPlainObject(source) ? clipKindOf(source) : null;
        if (!isPlainObject(source) || (!hasSrc && declaredKind !== 'text')) {
          throw new EditError('insert 需要一个带 src 的片段（文本片段 kind:"text" 可只给 text/at/time）', 'INVALID');
        }
        const used = usedIds(next);
        const wanted = /** @type {any} */ (source).id;
        const id =
          typeof wanted === 'string' && wanted !== '' && !used.has(wanted) ? wanted : mintId(used, hasSrc ? stemOf(/** @type {any} */ (source).src) : 'text');
        const clip = structuredClone(source);
        clip.id = id;
        /* 文本片段可以完全没有 src：补成空串，与 parse 出来的形状一致（否则写回会印出 undefined）。 */
        if (typeof clip.src !== 'string') clip.src = '';
        /* `src` 里的 `#t=in,out` 与 `time` 是同一件事：拆开，src 只留路径（与 parse 出来的形状一致）。
           不拆的话写回会变成 `src="a.mp4#t=0,8"` + `#t=0,3` 两套区间，或值里有片段、文件里没有。 */
        if (typeof clip.src === 'string' && clip.src.indexOf('#') >= 0) {
          const hash = clip.src.indexOf('#');
          const fragment = clip.src.slice(hash + 1);
          clip.src = clip.src.slice(0, hash);
          const match = /^t=([^,]*)(?:,(.*))?$/.exec(fragment);
          if (match !== null && !Array.isArray(clip.time) && String(match[1]).trim() !== '') {
            const from = Number(match[1]);
            const to = match[2] === undefined || String(match[2]).trim() === '' ? null : Number(match[2]);
            const toOk = to === null ? match[2] === undefined : Number.isFinite(to) && to >= from;
            if (Number.isFinite(from) && from >= 0 && toOk) {
              clip.time = to === null ? [round(from)] : [round(from), round(to)];
            }
          }
        }
        if (op.at !== undefined && op.at !== null) {
          if (!(typeof op.at === 'number' && Number.isFinite(op.at) && op.at >= 0)) {
            throw new EditError('insert 的 at 必须是秒数', 'INVALID');
          }
          if (round(op.at) === 0) delete clip.at;
          else clip.at = round(op.at);
        }
        const kind = clipKindOf(clip);
        let dest;
        if (op.track === undefined || op.track === null) {
          // 没指定轨道：放到最后一条同类型轨道，没有就新建一条
          let found = -1;
          for (let t = next.tracks.length - 1; t >= 0; t -= 1) {
            const track = next.tracks[t];
            if (track.clips.length === 0) continue;
            const role = ROLE_BY_KIND[clipKindOf(track.clips[0])] ?? 'picture';
            if (role === ROLE_BY_KIND[kind]) {
              found = t;
              break;
            }
          }
          if (found >= 0) dest = found;
          else {
            /* R189：**叠层（page / subtitle）新建轨道落在最上层**。
               section 顺序就是 z 序（第一个在最上层），而这里以前一律 `push` 到末尾 = 最底层：
               用户在画面轨之后加的网页/字幕轨会被画面整条盖住 —— 时间线里看得见、导出里看不见，
               和 R180 那次"画面压住网页"的事故同一个方向。画面轨/音轨保持原样（新增画面轨仍在
               底部），只有叠层改默认落点；要换位置仍可用 `track` op 显式改序。 */
            const role = ROLE_BY_KIND[kind] ?? 'picture';
            /* 文本片段的 role 是 picture（历史映射，动它会连带改图层树分组），但它是**叠层**：
               落到底部同样会被画面压住，所以这里按语句种类判，不按 role 判。 */
            if (role === 'page' || role === 'subtitle' || kind === 'text') {
              next.tracks.unshift({ index: 0, role, clips: [] });
              dest = 0;
            } else {
              next.tracks.push({ index: 0, role, clips: [] });
              dest = next.tracks.length - 1;
            }
            structureChanged = true;
          }
        } else {
          dest = targetTrack(next, op.track, undefined);
          if (isPlainObject(op.track)) structureChanged = true;
        }
        assertEditable(next.tracks[dest], id);
        next.tracks[dest].clips.push(clip);
        sortTrack(next.tracks[dest]);
        inverses.push([{ op: 'remove', clip: id }]);
        touch(id);
        break;
      }
      case 'remove': {
        const at = find(next, op.clip);
        assertEditable(at.track, op.clip);
        const snapshot = structuredClone(at.clip);
        at.track.clips.splice(at.c, 1);
        inverses.push([{ op: 'insert', clip: snapshot, track: next.tracks.indexOf(at.track) }]);
        structureChanged = true;
        touch(op.clip);
        break;
      }
      case 'split': {
        const at = find(next, op.clip);
        assertEditable(at.track, op.clip);
        if (!(typeof op.at === 'number' && Number.isFinite(op.at) && op.at > 0)) {
          throw new EditError('split 需要 at（时间线秒数）', 'INVALID');
        }
        const original = structuredClone(at.clip);
        if (hasClipKeyframes(original) && !(Array.isArray(op.left?.overrides) && Array.isArray(op.right?.overrides))) {
          throw new EditError('分割含关键帧的片段需要为两侧明确重排关键帧', 'INVALID');
        }
        const left = structuredClone(at.clip);
        const right = structuredClone(at.clip);
        const used = usedIds(next);
        const asked =
          typeof op.rightId === 'string' && /^[A-Za-z][\w-]*$/.test(op.rightId) && !used.has(op.rightId) ? op.rightId : null;
        right.id = asked ?? mintId(used, `${at.clip.id}-b`);
        const time = at.clip.time;
        const speed = typeof at.clip.speed === 'number' && at.clip.speed > 0 ? at.clip.speed : 1;
        const cut = round(op.at);
        const sourceCut = Array.isArray(time) && time.length === 2
          ? round(Number(time[0]) + (cut - Number(at.clip.at ?? 0)) * speed)
          : NaN;
        if (!(sourceCut > Number(time?.[0]) && sourceCut < Number(time?.[1]))) {
          throw new EditError('分割点必须落在片段的可剪区间内', 'INVALID');
        }
        left.time = [Number(time[0]), sourceCut];
        right.time = [sourceCut, Number(time[1])];
        right.at = cut;
        splitFades(left, right);
        for (const [prop, propValue] of Object.entries(op.left ?? {})) setField(left, prop, propValue);
        for (const [prop, propValue] of Object.entries(op.right ?? {})) setField(right, prop, propValue);
        if (left.id !== original.id) throw new EditError('split 的左半必须保留原 id', 'INVALID');
        at.track.clips.splice(at.c, 1, left, right);
        sortTrack(at.track);
        inverses.push([{ op: 'fields', clip: original.id, fields: original }, { op: 'remove', clip: right.id }]);
        structureChanged = true;
        touch(original.id);
        touch(right.id);
        break;
      }
      case 'props': {
        /** @type {Map<string, any>} */
        const oldClips = new Map();
        /** @type {{ clip: string, track: number, flags: Record<string, boolean> }[]} */
        const oldTracks = [];
        /** @type {{ from: number, to: number }[]} */
        const orderBefore = [];
        for (const edit of op.edits ?? []) {
          if (!isPlainObject(edit) || typeof edit.clip !== 'string') continue;
          if (edit.prop === 'trackOrder') {
            const dest = isPlainObject(edit.value) ? /** @type {any} */ (edit.value) : null;
            if (dest !== null) orderBefore.push({ from: Number(dest.from), to: Number(dest.to) });
            continue;
          }
          let found;
          try {
            found = find(next, edit.clip);
          } catch {
            continue;
          }
          if (!oldClips.has(edit.clip)) oldClips.set(edit.clip, structuredClone(found.clip));
          if (TRACK_FLAGS.has(edit.prop) && !oldTracks.some((item) => item.track === next.tracks.indexOf(found.track))) {
            oldTracks.push({
              clip: edit.clip,
              track: next.tracks.indexOf(found.track),
              flags: {
                locked: found.track.locked === true,
                hidden: found.track.hidden === true,
                muted: found.track.muted === true,
              },
            });
          }
        }
        applyProps(next, op.edits, touch);

        /** @type {any[]} */
        const undoOps = [];
        // 1. 字段：用 fields 还原到批前的原样（保留显式默认值、删掉新增键）。
        for (const [clipId, oldClip] of oldClips) {
          let nowClip;
          try {
            nowClip = find(next, clipId).clip;
          } catch {
            continue;
          }
          /** @type {Record<string, any>} */
          const fields = {};
          for (const key of new Set([...Object.keys(oldClip), ...Object.keys(nowClip)])) {
            if (key === 'id') continue;
            if (JSON.stringify(oldClip[key]) !== JSON.stringify(nowClip[key])) {
              fields[key] = oldClip[key] === undefined ? null : oldClip[key];
            }
          }
          if (Object.keys(fields).length > 0) undoOps.push({ op: 'fields', clip: clipId, fields });
        }
        // 2. 轨道旗标。
        for (const item of oldTracks) {
          for (const [field, value] of Object.entries(item.flags)) {
            const current = next.tracks[item.track];
            if (current === undefined) continue;
            if ((current[field] === true) !== value) {
              undoOps.push({ op: 'track', track: item.track, field, value });
            }
          }
        }
        // 3. 换轨：放回批前的位置。
        for (const [clipId, oldClip] of oldClips) {
          let found;
          try {
            found = find(next, clipId);
          } catch {
            continue;
          }
          const nowTrack = next.tracks.indexOf(found.track);
          const wanted = /** @type {any} */ (op.edits ?? []).find((/** @type {any} */ edit) => edit.clip === clipId && edit.prop === 'track');
          if (wanted === undefined) continue;
          const beforeIndex = beforeTrackIndex(value, clipId);
          if (beforeIndex !== null && beforeIndex !== nowTrack) {
            undoOps.push({ op: 'props', edits: [{ clip: clipId, prop: 'track', value: beforeIndex }] });
          }
          void oldClip;
        }
        // 4. 轨道顺序。
        for (let index = orderBefore.length - 1; index >= 0; index -= 1) {
          const order = orderBefore[index];
          if (order === undefined) continue;
          undoOps.push({ op: 'reorder', from: order.to, to: order.from });
        }
        inverses.push(undoOps);
        structureChanged = true;
        break;
      }
      case 'stage': {
        if (!(Number.isInteger(op.w) && Number.isInteger(op.h) && op.w >= 16 && op.w <= 8192 && op.h >= 16 && op.h <= 8192 && op.w % 2 === 0 && op.h % 2 === 0)) {
          throw new EditError('舞台必须是偶数像素，16..8192', 'INVALID');
        }
        const old = { ...next.stage };
        next.stage = { w: op.w, h: op.h };
        inverses.push([{ op: 'stage', w: old.w, h: old.h }]);
        break;
      }
      case 'fields': {
        const at = find(next, op.clip);
        assertEditable(at.track, op.clip);
        if (!isPlainObject(op.fields)) throw new EditError('fields 需要一个「字段→值」的对象', 'INVALID');
        const kind = clipKindOf(at.clip);
        const allowed = fieldsAllowedFor(kind);
        /** @type {Record<string, any>} */
        const old = {};
        for (const [key, fieldValue] of Object.entries(op.fields)) {
          if (key === 'id') continue;
          // 白名单只约束新增键；已存在的键（撤销/重做要原样写回）一律放行。
          if (!allowed.includes(key) && !Object.hasOwn(at.clip, key)) {
            const field = `tracks[${next.tracks.indexOf(at.track)}].clips[${at.c}].${key}`;
            // 消息里同时写 field 路径与 allowed：HTTP 的 `/ops` 只转发 message，
            // 不带 field/allowed 的话调用方（CLI/Agent）就看不到该改哪个键。
            throw new EditError(
              `片段 ${String(op.clip)}（${kind}）不能写字段 "${key}"（${field}）；允许：${allowed.join(', ')}`,
              'INVALID',
              { field, allowed },
            );
          }
          old[key] = at.clip[key] === undefined ? null : structuredClone(at.clip[key]);
          if (fieldValue === null || fieldValue === undefined) delete at.clip[key];
          else at.clip[key] = structuredClone(fieldValue);
        }
        inverses.push([{ op: 'fields', clip: op.clip, fields: old }]);
        touch(op.clip);
        break;
      }
      case 'track': {
        if (!TRACK_FLAGS.has(op.field)) throw new EditError(`轨道没有 "${op.field}"`, 'INVALID');
        const track = next.tracks[Number(op.track)];
        if (track === undefined) throw new EditError(`轨道不存在：${String(op.track)}`, 'NOT_FOUND');
        const old = track[op.field] === true;
        if (op.value === true) track[op.field] = true;
        else delete track[op.field];
        inverses.push([{ op: 'track', track: Number(op.track), field: op.field, value: old }]);
        break;
      }
      case 'reorder': {
        const from = Number(op.from);
        const to = Number(op.to);
        if (next.tracks[from] === undefined) throw new EditError(`轨道不存在：${String(op.from)}`, 'NOT_FOUND');
        if (!Number.isInteger(to) || to < 0 || to >= next.tracks.length) {
          throw new EditError(`没有目标轨道：${String(op.to)}`, 'NOT_FOUND');
        }
        if (from !== to) {
          const [taken] = next.tracks.splice(from, 1);
          next.tracks.splice(to, 0, taken);
          structureChanged = true;
        }
        inverses.push([{ op: 'reorder', from: to, to: from }]);
        break;
      }
      case 'overrides': {
        const at = find(next, op.clip);
        assertEditable(at.track, op.clip);
        const before = Array.isArray(at.clip.overrides) ? structuredClone(at.clip.overrides) : null;
        const entries = validateOverrides(op.entries ?? []);
        const current = Array.isArray(at.clip.overrides) ? at.clip.overrides : [];
        // 片段自有条目（没有 at，放 fade）不动；层覆盖按 at 合并。
        const own = current.filter((/** @type {any} */ entry) => entry.at === undefined).map((/** @type {any} */ entry) => ({ ...entry }));
        const layers = current.filter((/** @type {any} */ entry) => entry.at !== undefined).map((/** @type {any} */ entry) => ({ ...entry }));
        for (const entry of entries) {
          const index = layers.findIndex((/** @type {any} */ item) => item.at === entry.at);
          if (index >= 0) layers[index] = { ...layers[index], ...entry };
          else layers.push(entry);
        }
        at.clip.overrides = [...own, ...layers];
        // 反向用整份旧数组（overrides 的条目只增不减，靠 set 才能回到原样）。
        inverses.push([{ op: 'set', clip: op.clip, field: 'overrides', value: before }]);
        touch(op.clip);
        break;
      }
      default:
        throw new EditError(`不认识的 Op：${String(op.op)}`, 'INVALID');
    }
  }

  // 整批结束后统一收尾：空轨消失、淡入淡出装得下、同轨按 at 排序。
  if (structureChanged) {
    dropEmptyTracks(next);
    next.tracks.forEach((/** @type {any} */ track, /** @type {number} */ index) => {
      track.index = index;
    });
  }
  fitFades(next);
  // 角色是派生的：换轨/删片段之后按新内容重算（与解析器一致，否则写回回读会对不上）。
  for (const track of next.tracks) track.role = derivedRole(track);
  // 只排被改到的轨道（未动的轨道保持原顺序，写回时才有字节稳定性）。
  for (const track of next.tracks) {
    if (track === undefined) continue;
    if (touched.size > 0 && track.clips.some((/** @type {any} */ clip) => touched.has(clip.id))) sortTrack(track);
  }

  /** @type {any[]} */
  const inverse = [];
  for (let index = inverses.length - 1; index >= 0; index -= 1) {
    const batch = inverses[index];
    if (batch !== undefined) inverse.push(...batch);
  }

  return { value: next, inverse, touched: [...touched], structureChanged };
}

/**
 * 批前某片段所在的轨道位置（反向 Op 用）。
 * @param {any} value @param {string} clipId
 */
function beforeTrackIndex(value, clipId) {
  for (let index = 0; index < value.tracks.length; index += 1) {
    if (value.tracks[index].clips.some((/** @type {any} */ clip) => clip.id === clipId)) return index;
  }
  return null;
}

/**
 * 反向 Op：`applyOps(applyOps(v, ops), invert(v, ops))` 回到 v（同值，不保证字节）。
 * 落盘级撤销仍以历史原文为准（见 studio/server/edit-session.mjs），反向 Op 用于模型与审计。
 * @param {any} value @param {readonly any[]} ops
 * @returns {any[]}
 */
export function invertOps(value, ops) {
  return applyOpsDetailed(value, ops).inverse;
}

/**
 * 值 → 片段索引（写回与调试用）：`Map<id, {track, index, clip}>`。
 * @param {any} value
 */
export function indexClips(value) {
  /** @type {Map<string, { track: any, trackIndex: number, clip: any }>} */
  const map = new Map();
  value.tracks.forEach((/** @type {any} */ track, /** @type {number} */ trackIndex) => {
    for (const clip of track.clips) map.set(clip.id, { track, trackIndex, clip });
  });
  return map;
}
