/**
 * 场景源码的轻量结构树（副线1 · S7-TREE-ROBUST）
 *
 * 重定位要在**没有浏览器**的情况下判断「这个 `at` 在新源码里还在不在、挪到哪了」。
 * 上批如实留了三个边界：转义只是子集、不做隐式闭合、坏 HTML 会建出怪树。这一批把它们
 * 要么补齐、要么变成明确拒绝：
 *
 * 1. `cssEscape` 按 CSSOM 规范实现，与浏览器 `CSS.escape` 逐字符等价（前导数字、
 *    `-` 后数字、控制字符、非 ASCII、标点）。
 * 2. 解析器做 HTML 的隐式闭合：`<li>`、`<p>`、`<dt>/<dd>`、`<option>`、`<tr>/<td>/<th>`，
 *    以及浏览器一定会插的 `<tbody>`。目标是与浏览器 `innerHTML` 出来的树**同构**，
 *    这样离线 `pathOf` 与运行时 `dom-probe` 的 `at` 才能逐条对上。
 * 3. malformed 输入返回诊断而不是抛异常：`issues[]` + `complete`。截断类问题
 *    （EOF 还有元素没闭合、属性引号没闭合）→ `complete=false`，调用方必须拒绝使用，
 *    免得拿半棵树去改覆盖；可恢复的问题（多余结束标签、错配、重复 id）只报诊断。
 *
 * 已知边界（如实写，不假装）：
 * - 不实现完整的 HTML5 插入模式（`<table>` 里的 foster parenting、`<select>` 的子集、
 *   `<template>` 内容文档等）；本批的 10 个隐式闭合样例与真实场景夹具已覆盖常见路径。
 * - 只处理十六进制/常见命名实体；其它实体原样保留。
 *
 * @typedef {object} SceneNode
 * @property {string} tag
 * @property {string|null} id
 * @property {string[]} classes
 * @property {Record<string, string>} attrs
 * @property {SceneNode|null} parent
 * @property {SceneNode[]} children
 * @property {number} index 同标签兄弟中的序号（1 起）
 * @property {string} text  直接文本子节点（压缩空白后）
 * @property {boolean} implicit 解析器补出来的节点（如 tbody）
 * @property {string[]} textParts 解析期暂存
 */

/**
 * @typedef {object} SceneTree
 * @property {SceneNode|null} body
 * @property {SceneNode[]} nodes 先序，含 body
 * @property {Map<string, SceneNode[]>} byId
 * @property {SceneIssue[]} issues
 * @property {boolean} complete 结构是否可安全用于重定位
 */

/**
 * @typedef {object} SceneIssue
 * @property {string} code
 * @property {string} message
 * @property {string} [tag]
 */

const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
]);
const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes']);

/** 与 dom-probe.mjs 的 SKIP 保持一致：这些元素永远不是层。 */
export const SKIP_TAGS = new Set([
  'HTML', 'HEAD', 'SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'BASE',
  'NOSCRIPT', 'TEMPLATE', 'BR', 'SOURCE', 'TRACK'
]);

/** 这些开始标签会把还开着的 `<p>` 关掉（HTML5 的 p 关闭集合的常见子集）。 */
const CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section',
  'table', 'ul'
]);
const TABLE_SECTIONS = new Set(['thead', 'tbody', 'tfoot']);
const CELLS = new Set(['td', 'th']);
/** p 的「作用域」边界：跨过这些元素就不再往外找 p。 */
const P_SCOPE = new Set(['body', 'html', 'table', 'td', 'th', 'caption', 'ul', 'ol', 'div', 'section', 'article']);

const ID_RE = /^[A-Za-z_][\w-]*$/;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

/** @param {string} value */
function decodeEntities(value) {
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : all;
    }
    return ENTITIES[/** @type {keyof typeof ENTITIES} */ (e.toLowerCase())] ?? all;
  });
}

/**
 * CSSOM 规范的 `CSS.escape()`。与浏览器逐字符等价：这是 `at` 能当选择器用的前提。
 * @param {string} value
 * @returns {string}
 */
export function cssEscape(value) {
  const s = String(value);
  const points = Array.from(s);
  let out = '';
  for (let i = 0; i < points.length; i++) {
    const ch = points[i] ?? '';
    const cp = ch.codePointAt(0) ?? 0;
    const isDigit = cp >= 0x30 && cp <= 0x39;
    const isAlpha = (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
    if (cp === 0) {
      out += '\uFFFD';
      continue;
    }
    if ((cp >= 0x01 && cp <= 0x1f) || cp === 0x7f) {
      out += `\\${cp.toString(16)} `;
      continue;
    }
    if (i === 0 && isDigit) {
      out += `\\${cp.toString(16)} `;
      continue;
    }
    if (i === 1 && isDigit && (points[0] ?? '') === '-') {
      out += `\\${cp.toString(16)} `;
      continue;
    }
    if (i === 0 && cp === 0x2d && points.length === 1) {
      out += '\\-';
      continue;
    }
    if (cp >= 0x80 || cp === 0x2d || cp === 0x5f || isDigit || isAlpha) {
      out += ch;
      continue;
    }
    out += `\\${ch}`;
  }
  return out;
}

/** @param {string} value */
function unescapeCss(value) {
  return String(value).replace(/\\([0-9a-fA-F]{1,6}\s?|.)/g, (_m, g1) => {
    const isHex = /^[0-9a-fA-F]/.test(g1);
    if (!isHex) return g1;
    const cp = parseInt(g1.trim(), 16);
    return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : g1;
  });
}

/**
 * @param {string} html
 * @returns {SceneTree}
 */
export function parseScene(html) {
  const text = String(html ?? '');
  /** @type {SceneNode[]} */
  const roots = [];
  /** @type {SceneNode[]} */
  const stack = [];
  /** @type {SceneIssue[]} */
  const issues = [];
  let complete = true;
  let body = null;
  let i = 0;

  /** @param {string} code @param {string} message @param {string} [tag] */
  const issue = (code, message, tag) => {
    issues.push({ code, message, ...(tag ? { tag } : {}) });
  };

  /** @param {string} tag 从栈顶往下找 */
  const lastIndexOfTag = (tag) => {
    for (let s = stack.length - 1; s >= 0; s--) if (stack[s]?.tag === tag) return s;
    return -1;
  };

  /** @param {Set<string>} set */
  const lastIndexOfAny = (set) => {
    for (let s = stack.length - 1; s >= 0; s--) {
      const t = stack[s]?.tag;
      if (t && set.has(t)) return s;
    }
    return -1;
  };

  /** 关掉还开着的 `<p>`（受作用域限制）。 */
  const closeP = () => {
    const pi = lastIndexOfTag('p');
    if (pi < 0) return;
    for (let s = stack.length - 1; s > pi; s--) {
      const t = stack[s]?.tag;
      if (t && P_SCOPE.has(t)) return;
    }
    stack.length = pi;
  };

  /** @param {string} tag */
  const closeIfOpen = (tag) => {
    const idx = lastIndexOfTag(tag);
    if (idx >= 0) stack.length = idx;
  };

  /**
   * 补一个解析器节点（浏览器也会补，例如 tbody）。
   * @param {string} tag
   * @returns {SceneNode}
   */
  const insertImplicit = (tag) => {
    const parent = stack.length ? stack[stack.length - 1] ?? null : null;
    /** @type {SceneNode} */
    const node = {
      tag,
      id: null,
      classes: [],
      attrs: {},
      parent,
      children: [],
      index: 0,
      text: '',
      implicit: true,
      textParts: []
    };
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
    return node;
  };

  /**
   * 表格里的隐式结构：table > tbody > tr > td。
   * @param {string} tag
   */
  const tableFixups = (tag) => {
    if (lastIndexOfTag('table') < 0) return;
    if (CELLS.has(tag)) {
      const cellIdx = lastIndexOfAny(CELLS);
      if (cellIdx >= 0) stack.length = cellIdx;
      if (lastIndexOfTag('tr') < 0) {
        if (lastIndexOfAny(TABLE_SECTIONS) < 0) insertImplicit('tbody');
        insertImplicit('tr');
      }
      return;
    }
    if (tag === 'tr') {
      const cellIdx = lastIndexOfAny(CELLS);
      if (cellIdx >= 0) stack.length = cellIdx;
      const rowIdx = lastIndexOfTag('tr');
      if (rowIdx >= 0) stack.length = rowIdx;
      if (lastIndexOfAny(TABLE_SECTIONS) < 0) insertImplicit('tbody');
      return;
    }
    if (TABLE_SECTIONS.has(tag)) {
      const cellIdx = lastIndexOfAny(CELLS);
      if (cellIdx >= 0) stack.length = cellIdx;
      const rowIdx = lastIndexOfTag('tr');
      if (rowIdx >= 0) stack.length = rowIdx;
      const sectionIdx = lastIndexOfAny(TABLE_SECTIONS);
      if (sectionIdx >= 0) stack.length = sectionIdx;
    }
  };

  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      const tail = text.slice(i);
      const cur = stack.length ? stack[stack.length - 1] : null;
      if (cur) cur.textParts.push(tail);
      break;
    }
    if (lt > i) {
      const chunk = text.slice(i, lt);
      const cur = stack.length ? stack[stack.length - 1] : null;
      if (cur) cur.textParts.push(chunk);
    }

    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<!', lt)) {
      const end = text.indexOf('>', lt + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (text.startsWith('</', lt)) {
      const end = text.indexOf('>', lt + 2);
      const name = text.slice(lt + 2, end < 0 ? text.length : end).trim().toLowerCase();
      i = end < 0 ? text.length : end + 1;
      const at = lastIndexOfTag(name);
      if (at < 0) {
        issue('STRAY_END_TAG', `多余的结束标签 </${name}>：没有对应开始标签`, name);
      } else {
        let closedAbove = 0;
        for (let s = stack.length - 1; s > at; s--) if (stack[s]) closedAbove++;
        if (closedAbove > 0) {
          issue('MISNESTED_END_TAG', `</${name}> 之前还有 ${closedAbove} 个元素未闭合，按浏览器行为一并关闭`, name);
        }
        stack.length = at;
      }
      continue;
    }

    // 开始标签
    let j = lt + 1;
    while (j < text.length && /[^\s/>]/.test(text[j] ?? '')) j++;
    const tag = text.slice(lt + 1, j).toLowerCase();
    if (!tag) {
      i = lt + 1;
      continue;
    }
    /** @type {Record<string, string>} */
    const attrs = {};
    let selfClosing = false;
    while (j < text.length) {
      while (j < text.length && /\s/.test(text[j] ?? '')) j++;
      if (text[j] === '>') {
        j++;
        break;
      }
      if (text[j] === '/' && text[j + 1] === '>') {
        selfClosing = true;
        j += 2;
        break;
      }
      const start = j;
      while (j < text.length && !/[\s=/>]/.test(text[j] ?? '')) j++;
      const name = text.slice(start, j).toLowerCase();
      while (j < text.length && /\s/.test(text[j] ?? '')) j++;
      let value = '';
      if (text[j] === '=') {
        j++;
        while (j < text.length && /\s/.test(text[j] ?? '')) j++;
        const q = text[j];
        if (q === '"' || q === "'") {
          const end = text.indexOf(q, j + 1);
          if (end < 0) {
            complete = false;
            issue('UNTERMINATED_ATTRIBUTE', `属性 ${name} 的引号没有闭合（文件在这里被截断？）`, tag);
            value = text.slice(j + 1);
            j = text.length;
          } else {
            value = text.slice(j + 1, end);
            j = end + 1;
          }
        } else {
          const s0 = j;
          while (j < text.length && !/[\s>]/.test(text[j] ?? '')) j++;
          value = text.slice(s0, j);
        }
        if (name) attrs[name] = decodeEntities(value);
      } else if (name) {
        attrs[name] = '';
      }
    }
    i = j;

    /* 隐式闭合：先关该关的，再建节点 */
    if (CLOSES_P.has(tag)) closeP();
    if (tag === 'li') closeIfOpen('li');
    if (tag === 'dt' || tag === 'dd') {
      const d = Math.max(lastIndexOfTag('dt'), lastIndexOfTag('dd'));
      if (d >= 0) stack.length = d;
    }
    if (tag === 'option') closeIfOpen('option');
    if (tag === 'optgroup') {
      closeIfOpen('option');
      closeIfOpen('optgroup');
    }
    if (lastIndexOfTag('table') >= 0 && (CELLS.has(tag) || tag === 'tr' || TABLE_SECTIONS.has(tag))) {
      tableFixups(tag);
    }

    const parent = stack.length ? stack[stack.length - 1] ?? null : null;
    /** @type {SceneNode} */
    const node = {
      tag,
      id: attrs.id ? attrs.id : null,
      classes: attrs.class ? attrs.class.split(/\s+/).filter(Boolean) : [],
      attrs,
      parent,
      children: [],
      index: 0,
      text: '',
      implicit: false,
      textParts: []
    };
    if (parent) parent.children.push(node);
    else roots.push(node);
    if (tag === 'body' && !body) body = node;

    if (RAW.has(tag) && !selfClosing) {
      const close = text.toLowerCase().indexOf(`</${tag}`, i);
      if (close < 0) {
        issue('UNCLOSED_TAG', `<${tag}> 没有闭合到文件结尾`, tag);
        complete = false;
        i = text.length;
      } else {
        const gt = text.indexOf('>', close);
        i = gt < 0 ? text.length : gt + 1;
      }
      continue;
    }
    if (!VOID.has(tag) && !selfClosing) stack.push(node);
  }

  for (const open of stack) {
    if (open && open.tag !== 'html' && open.tag !== 'head' && open.tag !== 'body') {
      issue('UNCLOSED_TAG', `<${open.tag}> 一直到文件结尾都没有闭合`, open.tag);
      complete = false;
    }
  }

  if (!body) {
    issue('NO_BODY', '没有 <body>：场景源应是完整 HTML 文档，而不是片段');
    complete = false;
    body = roots.find((r) => r.tag === 'html')?.children.find((c) => c.tag === 'body') ?? roots[0] ?? null;
  }

  /** @type {SceneNode[]} */
  const nodes = [];
  /** @type {Map<string, SceneNode[]>} */
  const byId = new Map();
  /** @param {SceneNode} node */
  const walk = (node) => {
    nodes.push(node);
    if (node.id) {
      const list = byId.get(node.id) ?? [];
      list.push(node);
      byId.set(node.id, list);
    }
    /** @type {Map<string, number>} */
    const counters = new Map();
    for (const child of node.children) {
      const n = (counters.get(child.tag) ?? 0) + 1;
      counters.set(child.tag, n);
      child.index = n;
    }
    node.text = node.textParts.join('').replace(/\s+/g, ' ').trim();
    node.textParts = [];
    for (const child of node.children) walk(child);
  };
  for (const root of roots) walk(root);

  for (const [id, list] of byId) {
    if (list.length > 1) {
      issue('DUPLICATE_ID', `id="${id}" 出现 ${list.length} 次：不能用 #id 唯一定位`, id);
    }
  }

  return { body, nodes, byId, issues, complete };
}

/**
 * 与 dom-probe 相同的定位串：`#id`（唯一时）或 `body > tag.cls:nth-of-type(n)` 路径。
 * @param {SceneTree} tree
 * @param {SceneNode} node
 * @returns {string}
 */
export function pathOf(tree, node) {
  if (node.tag === 'body') return 'body';
  if (node.id && ID_RE.test(node.id) && (tree.byId.get(node.id)?.length ?? 0) === 1) {
    return `#${cssEscape(node.id)}`;
  }
  /** @type {string[]} */
  const segs = [];
  /** @type {SceneNode|null} */
  let cur = node;
  let guard = 0;
  while (cur && guard++ < 200) {
    if (cur.tag === 'body') {
      segs.unshift('body');
      break;
    }
    const cls = cur.classes.length ? `.${cssEscape(cur.classes[0] ?? '')}` : '';
    segs.unshift(`${cur.tag}${cls}:nth-of-type(${cur.index})`);
    cur = cur.parent;
  }
  return segs.join(' > ');
}

/**
 * 按 `at` 在新树里复算目标；解析不了/不唯一 → null（绝不返回「差不多」的节点）。
 * @param {SceneTree} tree
 * @param {string} at
 * @returns {SceneNode|null}
 */
export function resolveAt(tree, at) {
  if (!at || typeof at !== 'string') return null;
  if (at === 'body') return tree.body;
  if (at.startsWith('#')) {
    const id = unescapeCss(at.slice(1));
    const list = tree.byId.get(id);
    return list && list.length === 1 ? list[0] ?? null : null;
  }
  const segs = at.split(' > ');
  if (segs[0] !== 'body') return null;
  /** @type {SceneNode|null} */
  let cur = tree.body;
  if (!cur) return null;
  for (const seg of segs.slice(1)) {
    const m = /^([a-zA-Z0-9-]+)(?:\.([^:]+))?:nth-of-type\((\d+)\)$/.exec(seg);
    if (!m) return null;
    const tag = (m[1] ?? '').toLowerCase();
    const cls = m[2] ?? '';
    const nth = Number(m[3]);
    let count = 0;
    /** @type {SceneNode|null} */
    let next = null;
    /** @type {SceneNode[]} */
    const children = cur.children;
    for (const child of children) {
      if (child.tag !== tag) continue;
      count++;
      if (count === nth) {
        next = child;
        break;
      }
    }
    if (!next) return null;
    if (cls) {
      const first = next.classes[0] ? cssEscape(next.classes[0]) : '';
      if (first !== cls) return null;
    }
    cur = next;
  }
  return cur;
}

/**
 * 内容身份：能跨位置认出一个节点的最小证据，按强度排序。
 * `at` 的路径/index 是**位置**，不是身份——位置恰恰是会被改掉的东西。
 * @param {SceneNode} node
 * @returns {{kind: 'id'|'data-name'|'src'|'text'|'none', value: string}}
 */
export function identityOf(node) {
  if (node.id) return { kind: 'id', value: node.id };
  const dn = node.attrs['data-name'];
  if (dn && dn.trim()) return { kind: 'data-name', value: dn.trim() };
  for (const key of ['data-testid', 'data-key', 'data-id', 'name', 'alt', 'aria-label']) {
    const v = node.attrs[key];
    if (v && v.trim()) return { kind: 'src', value: `${key}=${v.trim()}` };
  }
  for (const key of ['src', 'href', 'poster']) {
    const v = node.attrs[key];
    if (v && v.trim()) return { kind: 'src', value: `${key}=${v.trim()}` };
  }
  const t = node.text;
  if (t && t.length <= 80) return { kind: 'text', value: t };
  return { kind: 'none', value: '' };
}

/**
 * 形状兼容：同标签、同首类、id 不冲突（两边都有 id 时必须相同）。
 * @param {SceneNode} a
 * @param {SceneNode} b
 */
export function shapeCompatible(a, b) {
  if (a.tag !== b.tag) return false;
  if ((a.classes[0] ?? '') !== (b.classes[0] ?? '')) return false;
  if (a.id && b.id && a.id !== b.id) return false;
  return true;
}

/** @param {SceneTree} tree */
export function indexByShape(tree) {
  /** @type {Map<string, SceneNode[]>} */
  const map = new Map();
  for (const node of tree.nodes) {
    const key = `${node.tag}|${node.classes[0] ?? ''}`;
    const list = map.get(key) ?? [];
    list.push(node);
    map.set(key, list);
  }
  return map;
}

/**
 * 层列表（与 dom-probe 的遍历顺序/跳过规则一致），供离线与浏览器逐条比对。
 * @param {SceneTree} tree
 * @returns {{at: string, tag: string, node: SceneNode}[]}
 */
export function layerList(tree) {
  /** @type {{at: string, tag: string, node: SceneNode}[]} */
  const out = [];
  /** @param {SceneNode} node */
  const walk = (node) => {
    for (const child of node.children) {
      if (SKIP_TAGS.has(child.tag.toUpperCase())) continue;
      out.push({ at: pathOf(tree, child), tag: child.tag, node: child });
      walk(child);
    }
  };
  if (tree.body) walk(tree.body);
  return out;
}
