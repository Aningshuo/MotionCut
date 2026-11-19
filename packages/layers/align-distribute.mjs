/**
 * 对齐 / 分布 / 精确数值输入（S24 · B-SUB1-R12-012）
 *
 * 多选之后缺的那一步：把若干层对齐到同一个边/中线、按等距铺开、或者直接敲数字。
 * **只产 `set field:'box'` 的 op**，不新增 op、不碰磁盘、不改合同；提交走宿主的
 * `onCommitMany(ops)`（和 canvas-gesture 同一条批量通路：一次 `/ops`、一步撤销）。
 *
 * ## 三条几何约定
 *
 * 1. **基准 = 选区并集 AABB**：对齐用的是每层在舞台上的**轴对齐外接框**。
 * 2. **旋转层按 AABB**：45° 的层参与对齐时，对齐的是它的外接框，不是未旋转的 box。
 *    外接框由 `aabbOf()` 算（复用 S15 的祖先线性 `L`：先按自身角度转四个角，再过 `L` 取极值）；
 *    宿主给了实测 `rect` 就直接用实测（更准，也包含祖先的平移）。
 * 3. **位移回声明空间**：舞台上的位移 `Δstage` 要换成声明位移 `Δdecl = L⁻¹ · Δstage`，
 *    和 `canvas-gesture` 用同一套 `geometry-space` 函数——不然有祖先缩放的层会对不齐。
 *
 * ## 用法
 *
 * ```js
 * const bar = mountAlignBar(hostEl, {
 *   getSelection: () => selectedLayers,     // [{ at, box:{x,y,w,h,r?}, rect?, geometry?, clip? }]
 *   onCommitMany: (ops) => postOps(ops),    // 一批，一次 /ops
 *   onError: (info) => toast(info)
 * });
 * bar.refresh();   // 手势提交 / undo 之后调一次，输入框跟着走
 * ```
 */

import { applyLinear, invertLinear } from './geometry-space.mjs';
import { patchForBoxValue } from './inspector-fields.mjs';

/** 六个对齐动作（顺序即工具条顺序）。 */
export const ALIGN_ACTIONS = Object.freeze(['left', 'hcenter', 'right', 'top', 'vcenter', 'bottom']);

/** 两个分布方向。 */
export const DISTRIBUTE_AXES = Object.freeze(['h', 'v']);

/** 数值框的字段（X/Y/W/H/角度）。 */
export const BOX_INPUT_FIELDS = Object.freeze(['x', 'y', 'w', 'h', 'rotation']);

const ALIGN_LABELS = Object.freeze({
  left: '左对齐',
  hcenter: '水平居中',
  right: '右对齐',
  top: '上对齐',
  vcenter: '垂直居中',
  bottom: '下对齐'
});

const AXIS_OF_ACTION = Object.freeze({ left: 'x', hcenter: 'x', right: 'x', top: 'y', vcenter: 'y', bottom: 'y' });

/** @param {number} n @param {number} [digits] */
function round(n, digits = 3) {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

/** @param {any} item @returns {{a:number,b:number,c:number,d:number} | null} */
function linearOf(item) {
  const lin = item && item.geometry && item.geometry.linear ? item.geometry.linear : null;
  if (!lin) return null;
  const values = [lin.a, lin.b, lin.c, lin.d];
  return values.every((n) => typeof n === 'number' && Number.isFinite(n)) ? lin : null;
}

/**
 * 一个（可能旋转过的）声明 box 在舞台上的**轴对齐外接框**。
 * 只算线性（缩放/旋转）；祖先的平移不影响宽高，宿主有实测 `rect` 时以实测为准。
 * @param {{x:number,y:number,w:number,h:number,r?:number}} box
 * @param {{linear?: {a:number,b:number,c:number,d:number} | null} | null} [geometry]
 * @returns {{x:number, y:number, w:number, h:number}}
 */
export function aabbOf(box, geometry) {
  const w = Number(box.w);
  const h = Number(box.h);
  const r = ((Number(box.r ?? 0) % 360) * Math.PI) / 180;
  const cx = Number(box.x) + w / 2;
  const cy = Number(box.y) + h / 2;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const lin = geometry && geometry.linear ? geometry.linear : null;
  const halfW = w / 2;
  const halfH = h / 2;
  /** @param {number} sx @param {number} sy */
  const corner = (sx, sy) => {
    const dx = sx * halfW;
    const dy = sy * halfH;
    const px = cx + dx * cos - dy * sin;
    const py = cy + dx * sin + dy * cos;
    return lin ? applyLinear(lin, px, py) : { x: px, y: py };
  };
  const pts = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: round(minX), y: round(minY), w: round(Math.max(...xs) - minX), h: round(Math.max(...ys) - minY) };
}

/**
 * 层的舞台 AABB：宿主实测 `rect` 优先（含祖先平移、更准），否则按 box + 角度 + `L` 推。
 * @param {any} item
 */
export function stageAabb(item) {
  if (item && item.rect && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(Number(item.rect[k])))) {
    return { x: Number(item.rect.x), y: Number(item.rect.y), w: Number(item.rect.w), h: Number(item.rect.h) };
  }
  return aabbOf(item.box, item.geometry);
}

/**
 * 选区并集 AABB（对齐的基准）。
 * @param {readonly any[]} items
 */
export function unionAabb(items) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (list.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const item of list) {
    const r = stageAabb(item);
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { x: round(minX), y: round(minY), w: round(maxX - minX), h: round(maxY - minY) };
}

/**
 * 把一条 op 的 value 从基准框 + 声明位移拼出来（`r=0` 不落，和面板/手势同一条规则）。
 * @param {any} item @param {number} dxDecl @param {number} dyDecl
 */
function movedValue(item, dxDecl, dyDecl) {
  const box = item.box;
  /** @type {{x:number,y:number,w:number,h:number,r?:number}} */
  const next = {
    x: round(Number(box.x) + dxDecl),
    y: round(Number(box.y) + dyDecl),
    w: round(Number(box.w)),
    h: round(Number(box.h))
  };
  if (Number.isFinite(Number(box.r)) && Number(box.r) !== 0) next.r = round(Number(box.r));
  return next;
}

/** @param {any} item @param {{x:number,y:number,w:number,h:number}} value */
function opFor(item, value) {
  const built = patchForBoxValue(value);
  if ('error' in built) return null;
  return item.clip ? { ...built.op, clip: item.clip } : built.op;
}

/**
 * 舞台位移 → 声明位移（有祖先变换时按 `L⁻¹` 折回去）。
 * @param {any} item @param {number} dxStage @param {number} dyStage
 */
function toDeclared(item, dxStage, dyStage) {
  const lin = linearOf(item);
  if (!lin) return { x: dxStage, y: dyStage };
  const inv = invertLinear(lin);
  if (!inv) return { x: dxStage, y: dyStage };
  return applyLinear(inv, dxStage, dyStage);
}

/**
 * 对齐：所有层的外接框对齐到选区并集的某条边/中线。≥2 层才有意义。
 * @param {readonly any[]} items
 * @param {'left'|'hcenter'|'right'|'top'|'vcenter'|'bottom'} action
 * @returns {{ops: any[], union: {x:number,y:number,w:number,h:number} | null, moved: number, changed: number}}
 */
export function planAlign(items, action) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const union = unionAabb(list);
  if (!union || list.length < 2 || !ALIGN_ACTIONS.includes(action)) return { ops: [], union, moved: 0, changed: 0 };

  const ops = [];
  let changed = 0;
  for (const item of list) {
    const aabb = stageAabb(item);
    let dxStage = 0;
    let dyStage = 0;
    if (action === 'left') dxStage = union.x - aabb.x;
    else if (action === 'hcenter') dxStage = union.x + union.w / 2 - (aabb.x + aabb.w / 2);
    else if (action === 'right') dxStage = union.x + union.w - (aabb.x + aabb.w);
    else if (action === 'top') dyStage = union.y - aabb.y;
    else if (action === 'vcenter') dyStage = union.y + union.h / 2 - (aabb.y + aabb.h / 2);
    else if (action === 'bottom') dyStage = union.y + union.h - (aabb.y + aabb.h);

    /* 每层都进同一批（哪怕这一层恰好已经对齐）：一次 /ops、一步撤销，撤销后全部回到原值 */
    const d = toDeclared(item, dxStage, dyStage);
    const op = opFor(item, movedValue(item, d.x, d.y));
    if (op) {
      ops.push(op);
      if (Math.abs(dxStage) > 1e-6 || Math.abs(dyStage) > 1e-6) changed += 1;
    }
  }
  return { ops, union, moved: ops.length, changed };
}

/**
 * 分布：首尾不动，中间的按「相邻间隙相等」重排。≥3 层才有意义。
 * @param {readonly any[]} items
 * @param {'h'|'v'} axis
 * @returns {{ops: any[], gap: number | null, order: string[], moved: number}}
 */
export function planDistribute(items, axis) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (list.length < 3 || !DISTRIBUTE_AXES.includes(axis)) return { ops: [], gap: null, order: [], moved: 0 };

  const horizontal = axis === 'h';
  const entries = list.map((item) => ({ item, aabb: stageAabb(item) }));
  entries.sort((a, b) => {
    const d = horizontal ? a.aabb.x - b.aabb.x : a.aabb.y - b.aabb.y;
    if (Math.abs(d) > 1e-6) return d;
    const e = horizontal ? a.aabb.y - b.aabb.y : a.aabb.x - b.aabb.x;
    if (Math.abs(e) > 1e-6) return e;
    return String(a.item.at ?? '').localeCompare(String(b.item.at ?? ''));
  });

  const first = /** @type {{item: any, aabb: {x:number,y:number,w:number,h:number}}} */ (entries[0]);
  const last = /** @type {{item: any, aabb: {x:number,y:number,w:number,h:number}}} */ (entries[entries.length - 1]);
  const startEdge = horizontal ? first.aabb.x : first.aabb.y;
  const endEdge = horizontal ? last.aabb.x + last.aabb.w : last.aabb.y + last.aabb.h;
  const sumSize = entries.reduce((acc, e) => acc + (horizontal ? e.aabb.w : e.aabb.h), 0);
  const gap = round((endEdge - startEdge - sumSize) / (entries.length - 1));

  const ops = [];
  let moved = 0;
  let cursor = startEdge;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = /** @type {{item: any, aabb: {x:number,y:number,w:number,h:number}}} */ (entries[i]);
    const size = horizontal ? entry.aabb.w : entry.aabb.h;
    if (i > 0 && i < entries.length - 1) {
      const target = cursor;
      const deltaStage = target - (horizontal ? entry.aabb.x : entry.aabb.y);
      if (Math.abs(deltaStage) > 1e-6) {
        const d = toDeclared(entry.item, horizontal ? deltaStage : 0, horizontal ? 0 : deltaStage);
        const op = opFor(entry.item, movedValue(entry.item, d.x, d.y));
        if (op) {
          ops.push(op);
          moved += 1;
        }
      }
    }
    cursor = round(cursor + size + gap);
  }

  return { ops, gap, order: entries.map((e) => String(e.item.at ?? '')), moved };
}

/**
 * 解析数值框：允许 `px` 后缀（声明空间）；角度允许 `deg` / `°`。
 * 非法（空 / NaN / 负宽高）返回 error，**调用方不许提交**。
 * @param {string|number} raw
 * @param {'x'|'y'|'w'|'h'|'rotation'} field
 * @returns {{value: number} | {error: {code: string, message: string}}}
 */
export function parseBoxInput(raw, field) {
  if (!BOX_INPUT_FIELDS.includes(field)) {
    return { error: { code: 'INVALID_FIELD', message: `不认识的字段：${String(field)}` } };
  }
  const text = String(raw ?? '').trim();
  if (text === '') {
    return { error: { code: 'INVALID_VALUE', message: `${labelOf(field)} 不能为空` } };
  }
  const stripped = field === 'rotation'
    ? text.replace(/\s*(deg|°)$/iu, '')
    : text.replace(/\s*px$/iu, '');
  if (!/^[-+]?\d*\.?\d+(?:e[-+]?\d+)?$/iu.test(stripped)) {
    return { error: { code: 'INVALID_VALUE', message: `${labelOf(field)} 必须是数值（可带 px）：${text}` } };
  }
  const value = Number(stripped);
  if (!Number.isFinite(value)) {
    return { error: { code: 'INVALID_VALUE', message: `${labelOf(field)} 必须是有限数：${text}` } };
  }
  if ((field === 'w' || field === 'h') && value <= 0) {
    return { error: { code: 'INVALID_VALUE', message: `${labelOf(field)} 必须大于 0：${text}` } };
  }
  if (field === 'rotation') {
    let deg = value % 360;
    if (deg > 180) deg -= 360;
    if (deg <= -180) deg += 360;
    return { value: round(deg) };
  }
  return { value: round(value) };
}

/** @param {string} field */
const FIELD_LABELS = Object.freeze({ x: 'X', y: 'Y', w: '宽', h: '高', rotation: '角度' });

/** @param {string} field */
function labelOf(field) {
  return /** @type {Record<string, string>} */ (FIELD_LABELS)[field] ?? field;
}

/**
 * 由「一个字段的新值」建一条 box op。锁比时按原比例改另一边，锚点保持左上角不动。
 * @param {any} item
 * @param {'x'|'y'|'w'|'h'|'rotation'} field
 * @param {number} value
 * @param {{ratioLock?: boolean}} [opts]
 * @returns {{op: any} | {error: {code: string, message: string}}}
 */
export function planBoxInput(item, field, value, opts = {}) {
  const box = item && item.box;
  if (!box) return { error: { code: 'NO_BASE_BOX', message: '缺少基准框' } };
  /** @type {{x:number,y:number,w:number,h:number,r?:number}} */
  const next = {
    x: Number(box.x),
    y: Number(box.y),
    w: Number(box.w),
    h: Number(box.h)
  };
  if (Number.isFinite(Number(box.r)) && Number(box.r) !== 0) next.r = Number(box.r);

  if (field === 'x' || field === 'y') {
    next[field] = value;
  } else if (field === 'rotation') {
    if (value === 0) delete next.r;
    else next.r = value;
  } else if (field === 'w' || field === 'h') {
    if (value <= 0) return { error: { code: 'INVALID_VALUE', message: '宽高必须大于 0' } };
    next[field] = value;
    if (opts.ratioLock && Number(box.w) > 0 && Number(box.h) > 0) {
      /* 锁比：按原比例改另一边；x/y 不动 = 左上角锚点 */
      if (field === 'w') next.h = round((Number(box.h) * value) / Number(box.w));
      else next.w = round((Number(box.w) * value) / Number(box.h));
    }
  }
  const op = opFor(item, next);
  if (!op) return { error: { code: 'NO_BASE_BOX', message: '生成的 box 不合法' } };
  return { op };
}

/**
 * 挂一条对齐/分布/精确输入工具条。
 *
 * @param {HTMLElement} container
 * @param {{
 *   getSelection: () => any[],
 *   onCommitMany: (ops: any[]) => void,
 *   onError?: (info: {code: string, message: string}) => void,
 *   idPrefix?: string
 * }} opts
 */
export function mountAlignBar(container, opts) {
  if (!container || typeof container.appendChild !== 'function') throw new Error('mountAlignBar 需要一个容器元素');
  if (!opts || typeof opts.getSelection !== 'function') throw new Error('mountAlignBar 需要 opts.getSelection');
  if (typeof opts.onCommitMany !== 'function') throw new Error('mountAlignBar 需要 opts.onCommitMany（一批 op）');

  const doc = container.ownerDocument ?? /** @type {Document} */ (globalThis.document);
  const win = doc.defaultView ?? globalThis;
  const prefix = typeof opts.idPrefix === 'string' && opts.idPrefix ? opts.idPrefix : 'align';

  const state = {
    count: 0,
    ratioLock: false,
    values: { x: '', y: '', w: '', h: '', rotation: '' },
    hint: '',
    invalidField: '',
    commits: 0,
    lastOps: /** @type {any[]} */ ([]),
    destroyed: false
  };

  const root = doc.createElement('div');
  root.setAttribute('data-align-bar', '');
  root.setAttribute('data-align-count', '0');
  root.style.cssText = [
    'display:flex',
    'flex-wrap:wrap',
    'align-items:center',
    'gap:6px',
    'padding:6px 8px',
    'border:1px solid rgba(120,140,180,0.35)',
    'border-radius:8px',
    'background:rgba(18,26,40,0.92)',
    'color:#dbe7ff',
    'font:12px/1.4 system-ui,-apple-system,"PingFang SC",Arial,sans-serif'
  ].join(';');

  /** @param {string} tag @param {string} [cls] @param {string} [text] */
  function el(tag, cls, text) {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const btnStyle = [
    'appearance:none',
    'border:1px solid rgba(120,140,180,0.45)',
    'background:rgba(38,52,76,0.9)',
    'color:#dbe7ff',
    'border-radius:5px',
    'padding:3px 7px',
    'font:inherit',
    'cursor:pointer'
  ].join(';');

  /** @type {Map<string, HTMLButtonElement>} */
  const alignButtons = new Map();
  const alignGroup = el('div');
  alignGroup.setAttribute('data-align-group', '');
  alignGroup.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap';
  for (const action of ALIGN_ACTIONS) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.setAttribute('data-align', action);
    button.setAttribute('title', ALIGN_LABELS[/** @type {keyof typeof ALIGN_LABELS} */ (action)]);
    button.textContent = ALIGN_LABELS[/** @type {keyof typeof ALIGN_LABELS} */ (action)];
    button.style.cssText = btnStyle;
    button.addEventListener('click', () => applyAlign(/** @type {any} */ (action)));
    alignGroup.appendChild(button);
    alignButtons.set(action, button);
  }

  const distributeGroup = el('div');
  distributeGroup.setAttribute('data-distribute-group', '');
  distributeGroup.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap';
  /** @type {Map<string, HTMLButtonElement>} */
  const distributeButtons = new Map();
  for (const axis of DISTRIBUTE_AXES) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.setAttribute('data-distribute', axis);
    button.textContent = axis === 'h' ? '水平等距' : '垂直等距';
    button.style.cssText = btnStyle;
    button.addEventListener('click', () => applyDistribute(/** @type {any} */ (axis)));
    distributeGroup.appendChild(button);
    distributeButtons.set(axis, button);
  }

  const geoGroup = el('div');
  geoGroup.setAttribute('data-geo-group', '');
  geoGroup.style.cssText = 'display:flex;gap:4px;align-items:center;flex-wrap:wrap';

  /** @type {Map<string, HTMLInputElement>} */
  const inputs = new Map();
  for (const field of BOX_INPUT_FIELDS) {
    const wrap = el('label');
    wrap.style.cssText = 'display:inline-flex;align-items:center;gap:3px';
    const name = el('span', '', field === 'rotation' ? '角度' : field.toUpperCase());
    name.style.cssText = 'opacity:0.75';
    const input = doc.createElement('input');
    input.type = 'text';
    input.setAttribute('data-geo', field);
    input.setAttribute('inputmode', 'decimal');
    input.setAttribute('aria-label', field);
    input.style.cssText = [
      'width:58px',
      'padding:2px 4px',
      'border:1px solid rgba(120,140,180,0.45)',
      'border-radius:4px',
      'background:rgba(12,18,30,0.9)',
      'color:#eaf2ff',
      'font:12px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace'
    ].join(';');
    input.addEventListener('change', () => applyInput(field));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        applyInput(field);
      }
    });
    wrap.appendChild(name);
    wrap.appendChild(input);
    geoGroup.appendChild(wrap);
    inputs.set(field, input);
  }

  const ratioWrap = el('label');
  ratioWrap.style.cssText = 'display:inline-flex;align-items:center;gap:3px;margin-left:2px';
  const ratio = doc.createElement('input');
  ratio.type = 'checkbox';
  ratio.setAttribute('data-ratio-lock', '');
  ratio.addEventListener('change', () => {
    state.ratioLock = ratio.checked === true;
    root.setAttribute('data-ratio-locked', state.ratioLock ? 'true' : 'false');
  });
  const ratioText = el('span', '', '锁比');
  ratioText.style.cssText = 'opacity:0.8';
  ratioWrap.appendChild(ratio);
  ratioWrap.appendChild(ratioText);

  const hint = el('div');
  hint.setAttribute('data-align-hint', '');
  hint.setAttribute('role', 'status');
  hint.style.cssText = 'min-height:14px;color:#ffd166;flex-basis:100%';

  root.appendChild(alignGroup);
  root.appendChild(distributeGroup);
  root.appendChild(geoGroup);
  root.appendChild(ratioWrap);
  root.appendChild(hint);
  container.appendChild(root);

  /* ── 提交 ────────────────────────────────────────────────────────────── */

  /** @param {any[]} ops @param {string} what */
  function commit(ops, what) {
    if (ops.length === 0) {
      setHint(`${what}：没有需要移动的层`);
      return false;
    }
    state.commits += 1;
    state.lastOps = ops;
    setHint(`${what}：${ops.length} 层 → 一批提交`);
    opts.onCommitMany(ops);
    return true;
  }

  /** @param {string} text */
  function setHint(text) {
    state.hint = text;
    hint.textContent = text;
    root.setAttribute('data-align-hint-text', text);
  }

  /** @param {string} code @param {string} message */
  function fail(code, message) {
    state.invalidField = code;
    setHint(`${message}`);
    root.setAttribute('data-align-error', code);
    if (typeof opts.onError === 'function') opts.onError({ code, message });
    return false;
  }

  function clearError() {
    state.invalidField = '';
    root.removeAttribute('data-align-error');
  }

  /** @param {string} action */
  function applyAlign(action) {
    clearError();
    const items = read();
    if (items.length < 2) return fail('NEED_TWO_LAYERS', '对齐至少要选 2 层');
    const plan = planAlign(items, /** @type {any} */ (action));
    return commit(plan.ops, ALIGN_LABELS[/** @type {keyof typeof ALIGN_LABELS} */ (action)]);
  }

  /** @param {string} axis */
  function applyDistribute(axis) {
    clearError();
    const items = read();
    if (items.length < 3) return fail('NEED_THREE_LAYERS', '分布至少要选 3 层');
    const plan = planDistribute(items, /** @type {any} */ (axis));
    return commit(plan.ops, axis === 'h' ? '水平等距' : '垂直等距');
  }

  /** @param {string} field */
  function applyInput(field) {
    clearError();
    const items = read();
    const input = inputs.get(field);
    if (!input) return false;
    if (items.length !== 1) {
      /* 多选时输入框只读：写回并提示 */
      paint();
      return fail('MULTI_SELECTION_READONLY', '多选时数值框只读，请用对齐/分布');
    }
    const parsed = parseBoxInput(input.value, /** @type {any} */ (field));
    if ('error' in parsed) {
      input.setAttribute('data-invalid', 'true');
      input.style.borderColor = '#ff7a7a';
      return fail(parsed.error.code, parsed.error.message);
    }
    input.removeAttribute('data-invalid');
    input.style.borderColor = 'rgba(120,140,180,0.45)';
    const built = planBoxInput(items[0], /** @type {any} */ (field), parsed.value, { ratioLock: state.ratioLock });
    if ('error' in built) return fail(built.error.code, built.error.message);
    const ok = commit([built.op], `${labelOf(field)} → ${parsed.value}`);
    paint();
    return ok;
  }

  /* ── 读/画 ───────────────────────────────────────────────────────────── */

  function read() {
    let list = [];
    try {
      list = opts.getSelection();
    } catch {
      list = [];
    }
    return (Array.isArray(list) ? list : []).filter((item) => item && item.box);
  }

  function paint() {
    const items = read();
    state.count = items.length;
    root.setAttribute('data-align-count', String(items.length));
    alignGroup.querySelectorAll('button').forEach((b) => {
      b.disabled = items.length < 2;
      b.style.opacity = items.length < 2 ? '0.45' : '1';
    });
    distributeGroup.querySelectorAll('button').forEach((b) => {
      b.disabled = items.length < 3;
      b.style.opacity = items.length < 3 ? '0.45' : '1';
    });

    const single = items.length === 1 ? items[0] : null;
    const union = unionAabb(items);
    const base = single ? single.box : union;
    const values = base
      ? {
          x: String(round(Number(base.x), 2)),
          y: String(round(Number(base.y), 2)),
          w: String(round(Number(base.w), 2)),
          h: String(round(Number(base.h), 2)),
          rotation: String(round(Number(single && single.box && single.box.r ? single.box.r : 0), 2))
        }
      : { x: '', y: '', w: '', h: '', rotation: '' };
    state.values = values;
    for (const [field, input] of inputs) {
      if (doc.activeElement !== input) input.value = values[/** @type {keyof typeof values} */ (field)];
      input.disabled = items.length !== 1;
      input.style.opacity = items.length !== 1 ? '0.55' : '1';
    }
    root.setAttribute('data-inputs-enabled', items.length === 1 ? 'true' : 'false');
    return { values, count: items.length };
  }

  /* 手势/undo 之后自动跟一下：监听真实 pointerup，**冒泡到 window** 才刷新。
     不能用 queueMicrotask —— 浏览器在每个监听回调之间都会跑微任务，那时手势（capture 阶段）
     还没提交，刷新会读到旧值。冒泡到 window 是事件流的最后一站，手势一定已经提交完了。
     也不起时钟：没有 rAF / interval。 */
  let syncBound = false;
  const onPointerUp = () => {
    if (!state.destroyed) paint();
  };
  win.addEventListener('pointerup', onPointerUp, false);
  syncBound = true;

  paint();

  return {
    refresh() {
      return paint();
    },
    applyAlign,
    applyDistribute,
    getState() {
      return {
        count: state.count,
        ratioLock: state.ratioLock,
        values: { ...state.values },
        hint: state.hint,
        invalidField: state.invalidField,
        commits: state.commits,
        lastOps: state.lastOps.map((op) => ({ ...op })),
        destroyed: state.destroyed,
        listeners: syncBound ? 1 : 0,
        persistence: 'via-onCommitMany'
      };
    },
    destroy() {
      if (state.destroyed) return;
      state.destroyed = true;
      win.removeEventListener('pointerup', onPointerUp, false);
      syncBound = false;
      root.remove();
    },
    root
  };
}
