/**
 * 蒙版（R125 · M11-A / LI-A20 · A21）—— 六类形状的参数化与序列化。
 *
 * 为什么六类**共用一套 SVG 蒙版**而不是各写一条 CSS：
 *
 * | 方案 | 位置 | 尺寸 | 羽化 | 圆角 | 旋转 | 反转 |
 * |---|---|---|---|---|---|---|
 * | `clip-path: inset()/polygon()` | ✅ | ✅ | ❌ clip-path 没有羽化 | 仅 inset 有 | 只能把旋转烤进顶点 | ❌ |
 * | `mask-image: linear-gradient()` 四边 | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ 反 stops |
 * | **`mask-image: url(svg)`（本文件）** | ✅ | ✅ | ✅ `feGaussianBlur` | ✅ `rx/ry` | ✅ `transform` | ✅ `evenodd` |
 *
 * 前两种要么做不出羽化、要么做不出旋转/反转，最后会变成「同一个按钮在不同形状下
 * 静默失效」——那正是要避免的**假成功**。所以统一走 SVG：一条 `mask-image` 声明，
 * 参数全在 `<svg>` 里，预览与导出是同一个 Chromium（`pageframes` 走同一份 CSS），
 * 因此两边逐像素同源。
 *
 * 状态编码（**唯一真值**）：`overrides.style['--oc-mask']` 里的一行
 * `v1;shape=star;x=50;y=50;w=60;h=60;feather=6;radius=0;rot=15;invert=0`。
 * 为什么不从 `mask-image` 反推：SVG 的顶点是**算完**的，反推既丢精度又分不清
 * 「用户要的是星还是心」。自定义属性原样存、原样读，重开/undo 都逐字一致。
 *
 * 兼容：`--oc-mask` 缺失而 `mask-image` 里有别人的蒙版 → `state:'custom'`，
 * 面板只显示「这个元素本来就有蒙版」+「新建会覆盖，先确认」，绝不静默清空。
 */

/** 六类形状（顺序 = 面板里的顺序）。 */
export const MASK_SHAPES = Object.freeze([
  Object.freeze({ id: 'rect', label: '矩形' }),
  Object.freeze({ id: 'circle', label: '圆' }),
  Object.freeze({ id: 'star', label: '星' }),
  Object.freeze({ id: 'heart', label: '心' }),
  Object.freeze({ id: 'line', label: '线' }),
  Object.freeze({ id: 'gradient', label: '渐变' })
]);

/** 序列化用的属性名（顺序固定，读回来逐字比较）。 */
export const MASK_PROP = '--oc-mask';

/** 我们自己的蒙版层长什么样：`url("data:image/svg+xml,…")`。 */
const OWN_LAYER_RE = /^url\(["']?data:image\/svg\+xml,/i;

/**
 * 每类形状支持的参数（**能力矩阵，写死在这里**，面板按它开关控件）。
 *
 * - `circle`：圆的旋转等于没旋转 → 不给旋转（不是忘了做）；
 * - `radius`：只有矩形/线有圆角（`rect` 的 `rx/ry`）；
 * - `feather`：六类都有（走 `feGaussianBlur`，见文件头表格）；
 * - `invert`：六类都有（`evenodd` 挖洞 / 渐变反 stops）。
 */
export const MASK_CAPS = Object.freeze({
  rect: Object.freeze({ position: true, size: true, feather: true, radius: true, rotation: true, invert: true }),
  circle: Object.freeze({ position: true, size: true, feather: true, radius: false, rotation: false, invert: true }),
  star: Object.freeze({ position: true, size: true, feather: true, radius: false, rotation: true, invert: true }),
  heart: Object.freeze({ position: true, size: true, feather: true, radius: false, rotation: true, invert: true }),
  line: Object.freeze({ position: true, size: true, feather: true, radius: true, rotation: true, invert: true }),
  gradient: Object.freeze({ position: true, size: true, feather: true, radius: false, rotation: true, invert: true })
});

/** 不支持时的**人话理由**（面板 tooltip 直接用，别让用户猜）。 */
export const MASK_CAP_REASON = Object.freeze({
  radius: '只有矩形和线有圆角（其它形状的边不是直的）',
  rotation: '圆旋转后还是圆，转它没有意义'
});

/** 默认参数（新建蒙版时）。 */
/** @type {Record<string, any>} */
export const MASK_DEFAULTS = Object.freeze({
  shape: 'rect',
  x: 50,
  y: 50,
  w: 60,
  h: 60,
  feather: 0,
  radius: 0,
  rot: 0,
  invert: 0
});

const NUM_KEYS = Object.freeze(['x', 'y', 'w', 'h', 'feather', 'radius', 'rot', 'invert']);

/** 形状 id 合法？ */
export function isMaskShape(/** @type {unknown} */ shape) {
  return MASK_SHAPES.some((item) => item.id === shape);
}

/** 形状的中文名（未知 → 原样）。 */
export function maskShapeLabel(/** @type {unknown} */ shape) {
  return MASK_SHAPES.find((item) => item.id === shape)?.label ?? String(shape ?? '');
}

/**
 * 塞进 CSS 的那一行。**属性顺序固定**：`shape` 在前，其余按 NUM_KEYS。
 * 值做四舍五入到 2 位，保证 `0.1+0.2` 这类浮点噪声不会让「重开」变成不等。
 * @param {Record<string, any>} spec
 */
export function formatMaskSpec(spec) {
  const shape = isMaskShape(spec?.shape) ? String(spec.shape) : 'rect';
  const parts = [`v1`, `shape=${shape}`];
  for (const key of NUM_KEYS) {
    const raw = Number(spec?.[key] ?? MASK_DEFAULTS[key]);
    const value = Number.isFinite(raw) ? Math.round(raw * 100) / 100 : MASK_DEFAULTS[key];
    parts.push(`${key}=${value}`);
  }
  return parts.join(';');
}

/**
 * 读回 `--oc-mask`。**只认自己写的版本头**（`v1`）；别的写法一律 null，
 * 让调用方走 `custom`（宁可说「看不懂」，也不猜）。
 * @param {unknown} text
 */
export function parseMaskSpec(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed === '' || !trimmed.startsWith('v1;')) return null;
  /** @type {Record<string, any>} */
  const out = { ...MASK_DEFAULTS };
  for (const pair of trimmed.split(';').slice(1)) {
    const eq = pair.indexOf('=');
    if (eq <= 0) return null;
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (key === 'shape') {
      if (!isMaskShape(value)) return null;
      out.shape = value;
      continue;
    }
    if (!NUM_KEYS.includes(key)) return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    out[key] = n;
  }
  return out;
}

/** 各参数的可用区间（面板的输入框与画布共用一份，别在两处写死）。 */
/** @type {Record<string, any>} */
export const MASK_RANGES = Object.freeze({
  x: Object.freeze([0, 100]),
  y: Object.freeze([0, 100]),
  w: Object.freeze([1, 100]),
  h: Object.freeze([1, 100]),
  feather: Object.freeze([0, 40]),
  radius: Object.freeze([0, 50]),
  rot: Object.freeze([-180, 180]),
  invert: Object.freeze([0, 1])
});

/**
 * 把用户输入钳到合法范围（并说清钳到哪了）。
 * 宽度/高度最小 1%，位置 0..100；羽化 0..40%（相对元素短边）；圆角 0..50%；旋转 ±180。
 * @param {Record<string, any>} spec
 * @param {{w?: number, h?: number}|null} [box] 元素像素尺寸（羽化按 px 存，这里只做百分比换算时用）
 */
export function normalizeMaskSpec(spec, box) {
  /** @type {Record<string, any>} */
  const out = { ...MASK_DEFAULTS, ...(spec ?? {}) };
  if (!isMaskShape(out.shape)) out.shape = 'rect';
  /** @type {string[]} */
  const clamped = [];
  for (const key of NUM_KEYS) {
    const [min, max] = MASK_RANGES[key];
    const raw = Number(out[key]);
    const value = Number.isFinite(raw) ? raw : MASK_DEFAULTS[key];
    if (value < min) clamped.push(`${key}=${value}→${min}`);
    if (value > max) clamped.push(`${key}=${value}→${max}`);
    out[key] = Math.min(max, Math.max(min, Math.round(value * 100) / 100));
  }
  out.invert = out.invert >= 0.5 ? 1 : 0;
  if (box && Number(box.w) > 0 && Number(box.h) > 0) out._box = { w: Number(box.w), h: Number(box.h) };
  return { spec: out, clamped };
}

/**
 * 把 `mask-image` 拆成层（顶层逗号）。
 * @param {string} text
 * @returns {string[]}
 */
export function splitMaskLayers(text) {
  const s = String(text ?? '').trim();
  if (s === '' || s === 'none') return [];
  /** @type {string[]} */
  const out = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote !== '') {
      if (ch === quote && s[i - 1] !== '\\') quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(s.slice(start).trim());
  return out.filter((layer) => layer !== '');
}

/** 这一层是不是我们的 SVG 蒙版。 */
export function isOwnMaskLayer(/** @type {string} */ layer) {
  return OWN_LAYER_RE.test(String(layer ?? '').trim());
}

/**
 * 从 CSS 侧读状态。
 * @param {{maskSpec?: unknown, maskImage?: unknown}} css
 * @returns {{state: 'absent'|'params'|'custom', spec: Record<string, any>|null, foreign: number, own: number, note: string}}
 */
export function readMask(css) {
  const spec = parseMaskSpec(css?.maskSpec);
  const layers = splitMaskLayers(String(css?.maskImage ?? ''));
  const own = layers.filter((layer) => isOwnMaskLayer(layer)).length;
  const foreign = layers.length - own;
  if (spec !== null) {
    return { state: 'params', spec, foreign, own, note: own > 0 ? '' : '参数在，但样式里没有蒙版层（可能被别的工具改过）' };
  }
  if (layers.length > 0) {
    return {
      state: 'custom',
      spec: null,
      foreign,
      own,
      note: own > 0 ? '有一层是本工具写的，但参数行丢了：只能删掉重建' : '这个元素本来就有蒙版（作者写的）：新建会替换它'
    };
  }
  return { state: 'absent', spec: null, foreign: 0, own: 0, note: '' };
}

/** 数值格式化：整数不带小数点，其余保留 2 位。 */
function fmt(/** @type {number} */ n) {
  const v = Math.round(Number(n) * 100) / 100;
  return Number.isInteger(v) ? String(v) : String(v);
}

/**
 * 五角星顶点（比例来自正五角星：外接半径 1、内接半径 sin(18°)/sin(54°)）。
 * @param {number} cx 中心 X（viewBox 单位）
 * @param {number} cy 中心 Y
 * @param {number} rx 横向半径
 * @param {number} ry 纵向半径
 * @param {number} rotDeg 旋转角（度）
 * @returns {Array<[number, number]>} 10 个顶点（外/内交替）
 */
function starPoints(cx, cy, rx, ry, rotDeg) {
  const inner = 0.382;
  /** @type {Array<[number, number]>} */
  const pts = [];
  for (let i = 0; i < 10; i += 1) {
    const r = i % 2 === 0 ? 1 : inner;
    const angle = (-90 + i * 36 + rotDeg) * Math.PI / 180;
    pts.push([cx + Math.cos(angle) * rx * r, cy + Math.sin(angle) * ry * r]);
  }
  return pts;
}

/**
 * 心形路径（两条三次贝塞尔，坐标系 0..1 再缩放到 w/h）。
 * @param {number} cx 中心 X
 * @param {number} cy 中心 Y
 * @param {number} rx 横向半径
 * @param {number} ry 纵向半径
 * @param {number} rotDeg 旋转角（度）
 * @returns {string} path 的 d 属性
 */
function heartPath(cx, cy, rx, ry, rotDeg) {
  /* 控制点取自常见心形参数曲线，落回 0..1 盒子后按 rx/ry 缩放、绕中心旋转。 */
  /** @type {Array<[number, number]>} */
  const raw = [
    [0.5, 0.92],
    [0.06, 0.55], [0.10, 0.12], [0.5, 0.28],
    [0.90, 0.12], [0.94, 0.55], [0.5, 0.92]
  ];
  const rad = rotDeg * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  /**
   * @param {[number, number]} pt
   * @returns {[number, number]}
   */
  const map = ([px, py]) => {
    const dx = (px - 0.5) * 2 * rx;
    const dy = (py - 0.5) * 2 * ry;
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
  };
  const p = raw.map(map);
  /* `noUncheckedIndexedAccess` 下 `p[i]` 是「可能 undefined」；这里是固定 7 个点，取一次并断言。 */
  const at = (/** @type {number} */ i) => /** @type {[number, number]} */ (p[i]);
  const [p0, p1, p2, p3, p4, p5, p6] = [at(0), at(1), at(2), at(3), at(4), at(5), at(6)];
  return `M${fmt(p0[0])} ${fmt(p0[1])} `
    + `C${fmt(p1[0])} ${fmt(p1[1])} ${fmt(p2[0])} ${fmt(p2[1])} ${fmt(p3[0])} ${fmt(p3[1])} `
    + `C${fmt(p4[0])} ${fmt(p4[1])} ${fmt(p5[0])} ${fmt(p5[1])} ${fmt(p6[0])} ${fmt(p6[1])} Z`;
}

/**
 * 生成形状的 SVG 片段（viewBox 固定 0 0 100 100，`preserveAspectRatio="none"`
 * 让它按元素盒子拉伸 —— 因此这里的单位都是**百分比**）。
 *
 * @param {Record<string, any>} spec 已 normalize 的参数
 * @returns {{body: string}}
 */
function shapeBody(spec) {
  const { x, y, w, h, radius, rot, invert } = spec;
  const rx = w / 2;
  const ry = h / 2;
  const hole = invert === 1 ? 'M0 0H100V100H0Z ' : '';
  const rule = invert === 1 ? ' fill-rule="evenodd"' : '';
  switch (spec.shape) {
    case 'circle':
      return { body: `<path${rule} fill="#fff" d="${hole}M${fmt(x - rx)} ${fmt(y)}a${fmt(rx)} ${fmt(ry)} 0 1 0 ${fmt(w)} 0a${fmt(rx)} ${fmt(ry)} 0 1 0 ${fmt(-w)} 0Z"/>` };
    case 'star': {
      const pts = starPoints(x, y, rx, ry, rot).map(([px, py]) => `${fmt(px)} ${fmt(py)}`).join('L');
      return { body: `<path${rule} fill="#fff" d="${hole}M${pts}Z"/>` };
    }
    case 'heart':
      return { body: `<path${rule} fill="#fff" d="${hole}${heartPath(x, y, rx, ry, rot)}"/>` };
    case 'line': {
      /* 线 = 很扁的矩形，圆角沿短边（高度的一半）。 */
      const r = Math.min(radius, h / 2);
      const g = rot === 0 ? '' : `<g transform="rotate(${fmt(rot)} ${fmt(x)} ${fmt(y)})">`;
      const inner = `<rect x="${fmt(x - rx)}" y="${fmt(y - ry)}" width="${fmt(w)}" height="${fmt(h)}" rx="${fmt(r)}" ry="${fmt(r)}" fill="#fff"${rule}/>`;
      if (hole === '') return { body: g === '' ? inner : `${g}${inner}</g>` };
      return { body: `<path${rule} fill="#fff" d="${hole}"/><g transform="rotate(${fmt(rot)} ${fmt(x)} ${fmt(y)})">${inner}</g>` };
    }
    case 'gradient':
      /* 渐变：沿旋转角从全透明到全白（feather = 过渡带宽度占尺寸的比例）。 */
      return {
        body: `<defs><linearGradient id="g" gradientTransform="rotate(${fmt(rot)} 0.5 0.5)">`
          + `<stop offset="0" stop-color="#fff" stop-opacity="${invert === 1 ? 1 : 0}"/>`
          + `<stop offset="${fmt(Math.max(0, Math.min(100, 100 - Math.max(1, spec.feather) * 2)))}%" stop-color="#fff" stop-opacity="${invert === 1 ? 1 : 0}"/>`
          + `<stop offset="100%" stop-color="#fff" stop-opacity="1"/>`
          + '</linearGradient></defs>'
          + `<rect x="0" y="0" width="100" height="100" fill="url(#g)"/>`
      };
    case 'rect':
    default: {
      const r = Math.min(radius, Math.min(w, h) / 2);
      const g = rot === 0 ? '' : `<g transform="rotate(${fmt(rot)} ${fmt(x)} ${fmt(y)})">`;
      const inner = `<rect x="${fmt(x - rx)}" y="${fmt(y - ry)}" width="${fmt(w)}" height="${fmt(h)}" rx="${fmt(r)}" ry="${fmt(r)}" fill="#fff"/>`;
      if (hole === '') return { body: g === '' ? inner : `${g}${inner}</g>` };
      return { body: `<path${rule} fill="#fff" d="${hole}"/><g transform="rotate(${fmt(rot)} ${fmt(x)} ${fmt(y)})">${inner}</g>` };
    }
  }
}

/**
 * 生成 `url("data:image/svg+xml,…")`。
 *
 * 羽化换算：`stdDeviation` 在 viewBox 单位里，1 单位 = 元素宽/高的 1%。
 * 所以 px 羽化 → `feather / boxW * 100`（x）与 `feather / boxH * 100`（y）；
 * 没有盒子尺寸时退回「羽化百分比」直接当单位（视觉一致，只是不是精确 px）。
 *
 * @param {Record<string, any>} spec
 * @param {{w?: number, h?: number}|null} [box]
 */
export function maskDataUrl(spec, box) {
  const s = { ...MASK_DEFAULTS, ...(spec ?? {}) };
  const { body } = shapeBody(s);
  const boxW = Number(box?.w ?? s?._box?.w ?? 0);
  const boxH = Number(box?.h ?? s?._box?.h ?? 0);
  /* 羽化：stdDeviation 在 viewBox 单位（= 元素宽/高的 1%）。
     有盒子尺寸 → 按 px 精确换算；没有 → 把羽化值当百分比用（视觉一致，只是不保证 px）。 */
  let content = body;
  if (Number(s.feather) > 0) {
    const sx = boxW > 0 ? (Number(s.feather) / boxW) * 100 : Number(s.feather);
    const sy = boxH > 0 ? (Number(s.feather) / boxH) * 100 : Number(s.feather);
    const filter = '<filter id="f" x="-40%" y="-40%" width="180%" height="180%">'
      + `<feGaussianBlur stdDeviation="${fmt(sx)} ${fmt(sy)}"/></filter>`;
    /* 只模糊**图形**：挖洞用的整块矩形留在 `<g>` 外面，否则整块会被模糊成灰边。 */
    if (s.invert === 1) {
      const cut = body.indexOf('/>');
      const holeRect = body.slice(0, cut + 2);
      const rest = body.slice(cut + 2);
      content = `${holeRect}<g filter="url(#f)">${rest}</g>`;
    } else {
      content = `<g filter="url(#f)">${body}</g>`;
    }
    content = filter + content;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="none">${content}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/**
 * 把「我们的层」替换进 `mask-image` 的层数组，并给出配套的 size/repeat/composite。
 *
 * 与四边渐隐共存的关键：**别人的层原样保留、顺序不动**，我们只把自己那一层放最前面；
 * `mask-composite` 用 `add, intersect…`（交集 = 每条蒙版都要允许）。
 * @param {string} maskImage 当前 `mask-image` 原文
 * @param {string|null} ourLayer 新的一层；null = 删掉我们的层
 */
export function composeMaskLayers(maskImage, ourLayer) {
  const layers = splitMaskLayers(maskImage).filter((layer) => !isOwnMaskLayer(layer));
  const all = ourLayer === null ? layers : [ourLayer, ...layers];
  /** @type {Record<string, string>} */
  const style = {};
  if (all.length === 0) {
    style['mask-image'] = 'none';
    return style;
  }
  style['mask-image'] = all.join(', ');
  style['mask-size'] = all.map((_, i) => (ourLayer !== null && i === 0 ? '100% 100%' : 'auto')).join(', ');
  style['mask-repeat'] = all.map((_, i) => (ourLayer !== null && i === 0 ? 'no-repeat' : 'repeat')).join(', ');
  if (all.length > 1) {
    style['mask-composite'] = ['add', ...all.slice(1).map(() => 'intersect')].join(', ');
  }
  return style;
}

/**
 * 一个动作 → 一条 `overrides.style` 补丁。
 *
 * 动作语义（面板按钮/画布共用一个入口）：
 * - `add`：没有就按默认建；有就**原样返回**（`unchanged`，不写盘）；
 * - `set`：更新参数（可只给一部分）；
 * - `remove`：删掉我们的层 + 删掉 `--oc-mask`（别人的层留着）；
 * - `reset`：参数回默认（形状保留）；
 * - `invert`：翻转反转位。
 *
 * @param {{maskImage?: unknown, maskSpec?: unknown}} css
 * @param {'add'|'set'|'remove'|'reset'|'invert'} action
 * @param {Record<string, any>} [params]
 * @param {{w?: number, h?: number}|null} [box]
 */
export function maskPatch(css, action, params, box) {
  const current = readMask(css);
  if (action === 'remove') {
    const style = composeMaskLayers(String(css?.maskImage ?? ''), null);
    style[MASK_PROP] = '';
    return { ok: true, patch: { style }, note: '蒙版已删除' };
  }
  if (action === 'add' && current.state === 'params') {
    return { ok: true, patch: { style: {} }, unchanged: true, note: '蒙版已经在了' };
  }
  if (current.state === 'custom' && action !== 'add') {
    return {
      ok: false,
      error: { code: 'MASK_CUSTOM', message: '这个元素的蒙版不是本工具写的（认不出参数）：只能重新新建一层，或到「高级」里改原文' }
    };
  }
  /** @type {Record<string, any>} */
  let next;
  if (action === 'reset') next = { ...MASK_DEFAULTS, shape: current.spec?.shape ?? 'rect' };
  else if (action === 'invert') next = { ...(current.spec ?? MASK_DEFAULTS), invert: (current.spec?.invert === 1 ? 0 : 1) };
  else next = { ...MASK_DEFAULTS, ...(current.spec ?? {}), ...(params ?? {}) };

  const { spec, clamped } = normalizeMaskSpec(next, box);
  delete spec._box;
  const layer = maskDataUrl(spec, box);
  const style = composeMaskLayers(String(css?.maskImage ?? ''), layer);
  style[MASK_PROP] = formatMaskSpec(spec);
  const note = clamped.length > 0
    ? `已钳制：${clamped.join('、')}`
    : `${maskShapeLabel(spec.shape)}蒙版已${current.state === 'params' ? '更新' : '添加'}`;
  return { ok: true, patch: { style }, note, spec, clamped };
}

/**
 * 面板/画布要的字段清单（每个参数一行，带范围、单位、可用性）。
 * @param {string} shape
 */
export function maskParamRows(shape) {
  const caps = MASK_CAPS[/** @type {keyof typeof MASK_CAPS} */ (shape)] ?? MASK_CAPS.rect;
  /** @type {Array<{id: string, label: string, unit: string, min: number, max: number, step: number, enabled: boolean, reason: string}>} */
  const rows = [
    { id: 'x', label: '中心 X', unit: '%', min: 0, max: 100, step: 0.5, enabled: caps.position, reason: '' },
    { id: 'y', label: '中心 Y', unit: '%', min: 0, max: 100, step: 0.5, enabled: caps.position, reason: '' },
    { id: 'w', label: '宽', unit: '%', min: 1, max: 100, step: 0.5, enabled: caps.size, reason: '' },
    { id: 'h', label: '高', unit: '%', min: 1, max: 100, step: 0.5, enabled: caps.size, reason: '' },
    { id: 'feather', label: '羽化', unit: 'px', min: 0, max: 40, step: 1, enabled: caps.feather, reason: '' },
    { id: 'radius', label: '圆角', unit: '%', min: 0, max: 50, step: 1, enabled: caps.radius, reason: caps.radius ? '' : MASK_CAP_REASON.radius },
    { id: 'rot', label: '旋转', unit: '°', min: -180, max: 180, step: 1, enabled: caps.rotation, reason: caps.rotation ? '' : MASK_CAP_REASON.rotation }
  ];
  return rows;
}

/**
 * 画布拖拽的**纯函数**入口：给一个手势（移动/缩放/旋转），算出新参数。
 * 面板的指针事件只负责把像素位移换算成百分比，算法全在这里（可单测）。
 *
 * @param {Record<string, any>} spec
 * @param {{kind: 'move'|'resize'|'rotate', dxPct?: number, dyPct?: number, dwPct?: number, dhPct?: number, dRot?: number, corner?: 'nw'|'ne'|'se'|'sw'}} gesture
 * @returns {{spec: Record<string, any>}}
 */
export function applyMaskGesture(spec, gesture) {
  const base = { ...MASK_DEFAULTS, ...(spec ?? {}) };
  const kind = gesture?.kind;
  if (kind === 'move') {
    base.x = Number(base.x) + Number(gesture.dxPct ?? 0);
    base.y = Number(base.y) + Number(gesture.dyPct ?? 0);
  } else if (kind === 'resize') {
    /* 缩放以**中心**为锚点，宽高各自 ±2×位移（对称拉）。 */
    base.w = Number(base.w) + Number(gesture.dwPct ?? 0) * 2;
    base.h = Number(base.h) + Number(gesture.dhPct ?? 0) * 2;
  } else if (kind === 'rotate') {
    /* 旋转是**环形**的：拖过 180 回绕到 -180，而不是硬钳在 180（钳住会让手柄「粘」在边上）。 */
    const raw = Number(base.rot) + Number(gesture.dRot ?? 0);
    base.rot = ((raw + 180) % 360 + 360) % 360 - 180;
  }
  const { spec: out } = normalizeMaskSpec(base);
  delete out._box;
  return { spec: out };
}

/** 形状能力表（给交接与面板共用；形状未知 → 按矩形）。 */
export function maskCapability(/** @type {string} */ shape) {
  return MASK_CAPS[/** @type {keyof typeof MASK_CAPS} */ (shape)] ?? MASK_CAPS.rect;
}
