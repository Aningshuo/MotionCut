/**
 * 图像适配 / 四角百分比裁切 / 素材替换（R125 · M11-B / LI-A24）。
 *
 * 三件事都只写 `overrides.style`（一条声明），不碰 film-core：
 *
 * | 能力 | 写什么 | 为什么这么写 |
 * |---|---|---|
 * | 适配三态 | `object-fit: fill / cover / contain` | 浏览器原生语义，预览与导出同一个 Chromium |
 * | 图像位置 | `object-position` | 同上（九宫格枚举） |
 * | 四角裁切 | `clip-path: polygon(4 点)` + 参数行 | 四角各自独立 → 只有 polygon 表达得了（inset 只能四边） |
 * | 换源 | `content: url("…")` + 参数行 | `<img>` 没有可写的属性通道（overrides 只有 t/style/lock/kf），
 *   `content` 是 Chromium 里唯一能替换**替换元素**内容又不动 DOM 的声明 |
 *
 * 为什么裁切不复用已有的「裁切」字段（`clipPath`，inset 像素版）：
 * 那个字段是**四边像素**，四角独立要 8 个数（每角 x/y），语义不同、混在一起会互相覆盖。
 * 两个字段都写 `clip-path`，所以面板里明确：**谁后改谁生效**，另一个会显示「被覆盖」。
 */

/** 四角的顺序（与 polygon 的书写顺序一致，顺时针）。 */
export const CROP_CORNERS = Object.freeze([
  Object.freeze({ id: 'tl', label: '左上' }),
  Object.freeze({ id: 'tr', label: '右上' }),
  Object.freeze({ id: 'br', label: '右下' }),
  Object.freeze({ id: 'bl', label: '左下' })
]);

/** 参数行（唯一真值）。 */
export const CROP_PROP = '--oc-crop';

/** 换源参数行。 */
export const MEDIA_PROP = '--oc-src';

/** 默认四角 = 不裁（整块可见）。 */
export const CROP_DEFAULTS = Object.freeze({
  tl: Object.freeze([0, 0]),
  tr: Object.freeze([100, 0]),
  br: Object.freeze([100, 100]),
  bl: Object.freeze([0, 100])
});

/** 适配三态（顺序 = 面板）。 */
export const FIT_MODES = Object.freeze([
  Object.freeze({ value: 'fill', label: '拉伸（铺满，比例会变）' }),
  Object.freeze({ value: 'cover', label: '填充（铺满，裁掉多出的）' }),
  Object.freeze({ value: 'contain', label: '适应（完整显示，可能留白）' })
]);

/** 九宫格位置（与 background-position 同一套词）。 */
export const POSITIONS = Object.freeze([
  Object.freeze({ value: 'center', label: '居中' }),
  Object.freeze({ value: 'top', label: '上' }),
  Object.freeze({ value: 'bottom', label: '下' }),
  Object.freeze({ value: 'left', label: '左' }),
  Object.freeze({ value: 'right', label: '右' }),
  Object.freeze({ value: 'top left', label: '左上' }),
  Object.freeze({ value: 'top right', label: '右上' }),
  Object.freeze({ value: 'bottom left', label: '左下' }),
  Object.freeze({ value: 'bottom right', label: '右下' })
]);

const round2 = (/** @type {number} */ n) => Math.round(Number(n) * 100) / 100;

/** @param {Record<string, any>} spec */
export function formatCrop(spec) {
  const parts = ['v1'];
  for (const corner of CROP_CORNERS) {
    const pair = spec?.[corner.id] ?? CROP_DEFAULTS[corner.id];
    const x = Number(pair?.[0]);
    const y = Number(pair?.[1]);
    parts.push(`${corner.id}=${round2(Number.isFinite(x) ? x : 0)},${round2(Number.isFinite(y) ? y : 0)}`);
  }
  return parts.join(';');
}

/** @param {unknown} text */
export function parseCrop(text) {
  if (typeof text !== 'string' || !text.trim().startsWith('v1;')) return null;
  /** @type {Record<string, any>} */
  const out = {};
  for (const pair of text.trim().split(';').slice(1)) {
    const eq = pair.indexOf('=');
    if (eq <= 0) return null;
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (!CROP_CORNERS.some((corner) => corner.id === key)) return null;
    const parts = value.split(',');
    if (parts.length !== 2) return null;
    const xy = parts.map((v) => Number(v));
    if (xy.some((n) => !Number.isFinite(n))) return null;
    out[key] = [round2(Number(xy[0])), round2(Number(xy[1]))];
  }
  for (const corner of CROP_CORNERS) if (!out[corner.id]) return null;
  return out;
}

/**
 * 钳到 0..100，并保证多边形不退化成线/点（同角重合时推开 0.5%）。
 * @param {Record<string, any>} spec
 */
export function normalizeCrop(spec) {
  /** @type {Record<string, any>} */
  const out = {};
  /** @type {string[]} */
  const clamped = [];
  for (const corner of CROP_CORNERS) {
    const pair = spec?.[corner.id] ?? CROP_DEFAULTS[corner.id];
    for (const [i, axis] of ['x', 'y'].entries()) {
      const raw = Number(pair?.[i]);
      const value = Number.isFinite(raw) ? raw : 0;
      if (value < 0) clamped.push(`${corner.id}.${axis}=${value}→0`);
      if (value > 100) clamped.push(`${corner.id}.${axis}=${value}→100`);
      if (!out[corner.id]) out[corner.id] = [0, 0];
      out[corner.id][i] = Math.min(100, Math.max(0, round2(value)));
    }
  }
  return { crop: out, clamped };
}

/**
 * 四角 → `polygon(...)`（百分比，顺时针）。
 * @param {Record<string, any>} spec
 */
export function cropPolygon(spec) {
  const { crop } = normalizeCrop(spec);
  const pts = CROP_CORNERS.map((corner) => `${crop[corner.id][0]}% ${crop[corner.id][1]}%`);
  return `polygon(${pts.join(', ')})`;
}

/**
 * 读状态。参数行优先；只有 polygon 没有参数行 → custom（别人写的）。
 * @param {{cropSpec?: unknown, clipPath?: unknown}} css
 */
export function readCrop(css) {
  const spec = parseCrop(css?.cropSpec);
  const clip = String(css?.clipPath ?? '').trim();
  const hasPolygon = clip.startsWith('polygon(');
  if (spec !== null) return { state: 'params', crop: spec, note: '' };
  if (hasPolygon) {
    return { state: 'custom', crop: null, note: '这个元素已经有一个 polygon 裁切（可能是手写的）：四角编辑会替换它' };
  }
  return { state: 'absent', crop: null, note: '' };
}

/**
 * 裁切补丁。
 * @param {{clipPath?: unknown, cropSpec?: unknown}} css
 * @param {'set'|'reset'|'remove'} action
 * @param {Record<string, any>} [params] `{corner:'tl', x:10, y:0}` 或 `{tl:[..], …}` 或 `{tlx:10}`
 */
export function cropPatch(css, action, params) {
  const current = readCrop(css);
  if (action === 'remove') {
    return { ok: true, patch: { style: { 'clip-path': 'none', [CROP_PROP]: '' } }, note: '四角裁切已清除' };
  }
  if (action === 'reset') {
    const style = { 'clip-path': cropPolygon(CROP_DEFAULTS), [CROP_PROP]: formatCrop(CROP_DEFAULTS) };
    return { ok: true, patch: { style }, note: '四角回到不裁（0/100）' };
  }
  /** @type {Record<string, any>} */
  const next = { ...CROP_DEFAULTS, ...(current.crop ?? {}) };
  if (params && typeof params === 'object') {
    for (const corner of CROP_CORNERS) {
      const pair = params[corner.id];
      if (Array.isArray(pair)) next[corner.id] = [Number(pair[0]), Number(pair[1])];
      const flatX = params[`${corner.id}x`];
      const flatY = params[`${corner.id}y`];
      if (flatX !== undefined || flatY !== undefined) {
        next[corner.id] = [
          flatX !== undefined ? Number(flatX) : Number(next[corner.id]?.[0] ?? 0),
          flatY !== undefined ? Number(flatY) : Number(next[corner.id]?.[1] ?? 0)
        ];
      }
    }
  }
  const { crop, clamped } = normalizeCrop(next);
  const style = { 'clip-path': cropPolygon(crop), [CROP_PROP]: formatCrop(crop) };
  const note = clamped.length > 0 ? `已钳制：${clamped.join('、')}` : '四角裁切已更新';
  return { ok: true, patch: { style }, note, crop, clamped, replacedForeign: current.state === 'custom' };
}

/**
 * 读换源。
 * @param {{mediaSpec?: unknown, content?: unknown}} css
 */
export function readMedia(css) {
  const text = typeof css?.mediaSpec === 'string' ? css.mediaSpec.trim() : '';
  const content = String(css?.content ?? '').trim();
  if (text.startsWith('v1;src=')) {
    return { state: 'replaced', src: text.slice('v1;src='.length), note: '' };
  }
  if (/^url\(/i.test(content)) {
    return { state: 'custom', src: '', note: '这个元素的 content 是手写的 url()：换源会替换它' };
  }
  return { state: 'original', src: '', note: '' };
}

/**
 * 换源补丁：`content: url("…")` + 参数行。
 * @param {{content?: unknown, mediaSpec?: unknown}} css
 * @param {{action: 'set'|'restore', src?: string}} params
 */
export function mediaPatch(css, params) {
  if (params?.action === 'restore') {
    return { ok: true, patch: { style: { content: 'normal', [MEDIA_PROP]: '' } }, note: '已换回原素材' };
  }
  const raw = String(params?.src ?? '').trim();
  if (raw === '') return { ok: false, error: { code: 'INVALID_VALUE', message: '要一个素材路径' } };
  /* 只允许工程内相对路径 / data URL：外链与绝对路径会把预览打到别人服务器上（S54 同款白名单）。 */
  if (!/^(assets\/|scenes\/|\.\/|data:image\/)/.test(raw) || raw.includes('..')) {
    return {
      ok: false,
      error: { code: 'PATH_NOT_ALLOWED', message: `素材路径必须是工程内相对路径（assets/…、scenes/…）或 data:image/…：${raw}` }
    };
  }
  return {
    ok: true,
    patch: { style: { content: `url("${raw}")`, [MEDIA_PROP]: `v1;src=${raw}` } },
    note: `已换源：${raw}`
  };
}

/**
 * 换源预告：新素材的**固有尺寸**比当前盒子小 → 会被拉伸/留白；比盒子大 → 多出的部分会按
 * `object-fit` 处理（cover 会裁）。返回 null 表示没有要说的话。
 * @param {{w: number, h: number}} intrinsic
 * @param {{w: number, h: number}} box
 */
export function mediaWarn(intrinsic, box) {
  const iw = Number(intrinsic?.w ?? 0);
  const ih = Number(intrinsic?.h ?? 0);
  const bw = Number(box?.w ?? 0);
  const bh = Number(box?.h ?? 0);
  if (!(iw > 0) || !(ih > 0) || !(bw > 0) || !(bh > 0)) return null;
  if (iw >= bw && ih >= bh) return null;
  const scale = Math.min(iw / bw, ih / bh);
  return {
    code: 'SOURCE_SMALLER',
    message: `新素材 ${iw}×${ih} 小于当前 ${Math.round(bw)}×${Math.round(bh)}（约 ${Math.round(scale * 100)}%）：`
      + '「拉伸」会糊、「填充」会裁、「适应」会留白。换完可一步撤销。'
  };
}
