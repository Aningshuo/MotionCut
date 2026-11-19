/**
 * 页内 DOM 探测（在浏览器 realm 执行）
 *
 * 这两个函数会被 Playwright 序列化后注入页面，因此**必须完全自包含**：
 * 不引用模块作用域的任何变量/函数。
 *
 * 快照一致性：discover 先在宿主侧等一帧 rAF，再执行一次同步遍历，
 * 遍历期间不 await 任何 Promise，因此不会返回「半新半旧」的层列表。
 */

/**
 * 递归收集可编辑层。
 * @param {{includeInvisible?: boolean}} [opts]
 */
export function snapshotLayers(opts = {}) {
  const SKIP = new Set([
    'HTML', 'HEAD', 'SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'BASE',
    'NOSCRIPT', 'TEMPLATE', 'BR', 'SOURCE', 'TRACK'
  ]);
  const INLINE_TEXT = new Set([
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'SPAN', 'A', 'LI', 'BUTTON',
    'LABEL', 'STRONG', 'EM', 'B', 'I', 'SMALL', 'BLOCKQUOTE', 'FIGCAPTION',
    'TD', 'TH', 'DT', 'DD', 'CODE', 'PRE'
  ]);

  /** @type {any[]} */
  const unsupported = [];
  /** @type {any[]} */
  const pixelOnly = [];
  const seenAt = new Set();
  /** @type {any[]} */
  const layers = [];

  /** @param {any} v */
  const esc = (v) =>
    typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(String(v)) : String(v).replace(/[^\w-]/g, '\\$&');

  /** @param {Element} el */
  const isVisible = (el) => {
    if (!el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    if (Number(cs.opacity) === 0) return false;
    return true;
  };

  /** @param {Element} el */
  const ownText = (el) => {
    let s = '';
    for (const n of el.childNodes) if (n.nodeType === 3) s += n.nodeValue || '';
    return s.replace(/\s+/g, ' ').trim();
  };

  /** @param {Element} el */
  const hasElementChildren = (el) => {
    for (const c of el.children) if (!SKIP.has(c.tagName)) return true;
    return false;
  };

  /** @param {Element} el */
  const bgUrl = (el) => {
    const bi = getComputedStyle(el).backgroundImage;
    if (!bi || bi === 'none') return null;
    const m = /^url\(["']?(.+?)["']?\)$/.exec(bi);
    return m ? m[1] : null; // 多图/渐变视为不可单图编辑
  };

  /**
   * @param {Element} el
   * @param {string} text
   */
  const kindOf = (el, text) => {
    const tag = el.tagName;
    if (tag === 'IMG' || tag === 'PICTURE') return 'image';
    if (tag === 'IFRAME') return 'container';
    if (tag === 'CANVAS') return 'unknown';
    if (text) return 'text';
    if (!hasElementChildren(el)) {
      const cs = getComputedStyle(el);
      if (bgUrl(el)) return 'image';
      const bg = cs.backgroundColor;
      const hasBg = !!bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)';
      const hasBorder = parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderLeftWidth) > 0;
      const hasRadius = parseFloat(cs.borderTopLeftRadius) > 0;
      if (hasBg || hasBorder || hasRadius) return 'shape';
      return 'unknown';
    }
    return 'container';
  };

  /** @param {Element} el */
  const pathOf = (el) => {
    if (el === document.body) return 'body';
    const segs = [];
    /** @type {Element|null} */
    let cur = el;
    let guard = 0;
    while (cur && cur !== document.documentElement && guard++ < 200) {
      if (cur === document.body) {
        segs.unshift('body');
        break;
      }
      const tag = cur.tagName.toLowerCase();
      const cls = cur.classList.length ? '.' + esc(cur.classList[0]) : '';
      let i = 1;
      /** @type {Element|null} */
      let sib = cur;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === cur.tagName) i += 1;
      segs.unshift(tag + cls + ':nth-of-type(' + i + ')');
      cur = cur.parentElement;
    }
    return segs.join(' > ');
  };

  /** @param {Element} el */
  const atOf = (el) => {
    const id = el.getAttribute('id');
    if (id && /^[A-Za-z_][\w-]*$/.test(id)) {
      const sel = '#' + esc(id);
      if (document.querySelectorAll(sel).length === 1) return sel;
    }
    return pathOf(el);
  };

  /**
   * @param {Element} el
   * @param {string} text
   */
  const nameOf = (el, text) => {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim().slice(0, 40);
    const dn = el.getAttribute('data-name');
    if (dn && dn.trim()) return dn.trim().slice(0, 40);
    if (text) return text.slice(0, 32);
    if (el.id) return el.id;
    return el.tagName.toLowerCase();
  };

  /**
   * @param {Element} parent
   * @param {number} depth
   * @param {string|null} parentAt
   */
  const walk = (parent, depth, parentAt) => {
    for (const el of parent.children) {
      if (SKIP.has(el.tagName)) continue;
      if (!opts.includeInvisible && !isVisible(el)) continue;
      const text = ownText(el) || (INLINE_TEXT.has(el.tagName) ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');
      const at = atOf(el);
      if (seenAt.has(at)) continue; // 路径/nth-of-type 已保证唯一；重复说明快照异常
      seenAt.add(at);
      const kind = kindOf(el, text);
      layers.push({
        at,
        kind,
        name: nameOf(el, text),
        depth,
        parentAt: parentAt === null ? null : parentAt,
        tag: el.tagName.toLowerCase(),
        text: text ? text.slice(0, 120) : '',
        id: el.id || '',
        classes: Array.prototype.slice.call(el.classList).slice(0, 4)
      });

      if (el.tagName === 'CANVAS') pixelOnly.push({ at, capability: 'PIXEL_ONLY' });
      if (el.tagName === 'IFRAME') {
        let cross = false;
        try {
          cross = !(/** @type {HTMLIFrameElement} */ (el)).contentDocument;
        } catch {
          cross = true;
        }
        if (cross) {
          unsupported.push({
            at,
            reason: 'CROSS_ORIGIN',
            capability: 'UNSUPPORTED',
            src: el.getAttribute('src') || ''
          });
        }
      }
      walk(el, depth + 1, at);
    }
  };

  walk(document.body, 1, null);
  return { layers, unsupported, pixelOnly };
}

/**
 * 按 at 复算目标。
 * @param {string} at
 */
export function locateByAt(at) {
  /** @type {any} */
  const result = {
    matches: 0,
    tag: '',
    kind: 'unknown',
    name: '',
    text: '',
    id: '',
    classes: [],
    box: null,
    inCanvas: false,
    isCanvas: false,
    crossOriginFrame: false
  };
  if (!at || typeof at !== 'string') return result;

  // at 本身是合法 CSS 选择器（#id 或 body > tag.class:nth-of-type(n) 路径）。
  let nodes;
  try {
    nodes = document.querySelectorAll(at);
  } catch {
    return result;
  }
  result.matches = nodes.length;
  if (nodes.length !== 1) return result;

  const el = nodes[0];
  if (!el) return result;
  result.tag = el.tagName.toLowerCase();
  result.id = el.id || '';
  result.classes = Array.prototype.slice.call(el.classList).slice(0, 4);
  result.isCanvas = el.tagName === 'CANVAS';

  /** @type {Element|null} */
  let p = el;
  while (p && p !== document.documentElement) {
    if (p.tagName === 'CANVAS') result.inCanvas = true;
    p = p.parentElement;
  }
  if (el.tagName === 'IFRAME') {
    try {
      result.crossOriginFrame = !(/** @type {HTMLIFrameElement} */ (el)).contentDocument;
    } catch {
      result.crossOriginFrame = true;
    }
  }

  // 与 discover 相同的分类规则（保持单一行为）
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);
  const INLINE_TEXT = new Set([
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'SPAN', 'A', 'LI', 'BUTTON',
    'LABEL', 'STRONG', 'EM', 'B', 'I', 'SMALL', 'BLOCKQUOTE', 'FIGCAPTION',
    'TD', 'TH', 'DT', 'DD', 'CODE', 'PRE'
  ]);
  let own = '';
  for (const n of el.childNodes) if (n.nodeType === 3) own += n.nodeValue || '';
  own = own.replace(/\s+/g, ' ').trim();
  const text = own || (INLINE_TEXT.has(el.tagName) ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  result.text = text.slice(0, 120);

  let hasChild = false;
  for (const c of el.children) if (!SKIP.has(c.tagName)) hasChild = true;

  if (el.tagName === 'IMG' || el.tagName === 'PICTURE') result.kind = 'image';
  else if (el.tagName === 'IFRAME') result.kind = 'container';
  else if (el.tagName === 'CANVAS') result.kind = 'unknown';
  else if (text) result.kind = 'text';
  else if (!hasChild) {
    const cs = getComputedStyle(el);
    const bg = cs.backgroundColor;
    const hasBg = !!bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)';
    const hasBorder = parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderLeftWidth) > 0;
    const hasRadius = parseFloat(cs.borderTopLeftRadius) > 0;
    const bi = cs.backgroundImage;
    if (bi && bi !== 'none') result.kind = 'image';
    else if (hasBg || hasBorder || hasRadius) result.kind = 'shape';
    else result.kind = 'unknown';
  } else result.kind = 'container';

  const aria = el.getAttribute('aria-label');
  const dn = el.getAttribute('data-name');
  result.name = (aria && aria.trim()) || (dn && dn.trim()) || (text ? text.slice(0, 32) : el.id || el.tagName.toLowerCase());

  const r = el.getBoundingClientRect();
  let rotation = 0;
  const tr = getComputedStyle(el).transform;
  if (tr && tr !== 'none') {
    try {
      const m = new DOMMatrixReadOnly(tr);
      rotation = (Math.atan2(m.b, m.a) * 180) / Math.PI;
    } catch {
      rotation = 0;
    }
  }
  result.box = { x: r.x, y: r.y, w: r.width, h: r.height, rotation };
  return result;
}

/**
 * 性能/一致性辅助：在页面内数一次节点数，供 L8 断言。
 */
export function countNodes() {
  return document.querySelectorAll('*').length;
}
