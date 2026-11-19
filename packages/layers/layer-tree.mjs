/**
 * 图层树（副线1 · S18 建，S20 扩展）
 *
 * 把扁平的图层列表（`snapshotLayers` 的形状：`{at, kind, name, depth, parentAt}`）变成
 * 有层级的树：缩进 + 展开/折叠 + 类型图标 + 名称 + 锁定/显隐按钮。**只读展示，不写盘**；
 * 选中通过 `onSelect(at)` 交回宿主。
 *
 * ## 会话内状态（不写 film.html）
 *
 * `contracts/layers.ts` 的 `LayerRef` 没有 `locked`/`hidden`，所以这两样**只活在前端内存里**：
 *
 * - **锁定**：行尾「锁」按钮切换；锁定行灰掉、不可选中（点击 / Enter / `select()` 都拒），
 *   宿主通过 `lockedAt(at)` 读（主线的 M19 用它禁舞台手柄）；
 * - **显隐**：行尾「眼」按钮切换；隐藏只影响**本树与舞台框**（宿主用 `hiddenAt(at)` 判断），
 *   不写 film.html、不影响导出。
 *
 * 这两个集合与展开状态、过滤词一起存在组件 state 里：`render()` 重建 DOM 不会丢，
 * `setLayers()` 换数据也不会丢（只有不存在的 at 会被清掉）。
 *
 * ## 父子关系怎么来（写死）
 *
 * 1. `parentAt` 能对上（且深度更小）→ 用它——这是 `snapshotLayers` 的 ground truth；
 * 2. 对不上（宿主只传了 `depth`，例如 App 的 `layerOptions` 映射会丢掉 `parentAt`）→
 *    按 `depth` 用栈还原：深度大于栈顶就挂栈顶，否则弹到最近的更浅层。
 *
 * 两条都失败（没有 depth 也没有 parentAt）→ 平铺到根。**不猜、不丢层**。
 *
 * ## 键盘（与 WAI-ARIA tree 一致的最小子集）
 *
 * | 键 | 行为 |
 * |---|---|
 * | ↑ / ↓ | 在**可见**行之间移动活动行（不选中） |
 * | → | 折叠 → 展开；已展开 → 进第一个子项 |
 * | ← | 展开 → 折叠；已折叠 → 回到父项 |
 * | Enter / 空格 | 选中活动行（锁定层被拒） |
 * | Home / End | 跳到第一个 / 最后一个可见行 |
 *
 * 活动行带 `data-active="true"`，树根获得焦点时带 `data-tree-focused="true"`——宿主用 CSS
 * 画焦点环（组件不写死主题）。
 *
 * ## 过滤
 *
 * 顶部输入框按 `name` / `kind` 子串匹配（不区分大小写）；命中项的**祖先链**与**子项**都保留
 * （不留孤儿行），过滤期间强制展开祖先。过滤词在重绘后保留。
 */

/** 树的持久化态：只读，不写盘。 */
export const LAYER_TREE_PERSISTENCE = 'read-only';

/** 每级缩进（px）。 */
export const TREE_INDENT_PX = 12;

/** 类型图标（纯文本字形，不引图标库）。 */
export const TREE_ICONS = Object.freeze({
  text: 'T',
  image: '▣',
  shape: '▤',
  container: '▢',
  unknown: '·'
});

/** @typedef {{at: string, kind: string, name: string, depth: number, locked: boolean, parentAt: string | null, children: TreeNode[]}} TreeNode */
/**
 * @typedef {object} LayerLike
 * @property {string} at
 * @property {string} [kind]
 * @property {string} [name]
 * @property {number} [depth]
 * @property {string | null} [parentAt]
 * @property {boolean} [locked]
 * @property {boolean} [hidden]
 */

/**
 * 扁平层列表 → 树。
 *
 * @param {readonly LayerLike[]} layers
 * @returns {{roots: TreeNode[], nodes: TreeNode[], byAt: Map<string, TreeNode>, duplicates: string[]}}
 */
export function buildLayerTree(layers) {
  /** @type {TreeNode[]} */
  const roots = [];
  /** @type {TreeNode[]} */
  const nodes = [];
  /** @type {Map<string, TreeNode>} */
  const byAt = new Map();
  /** @type {string[]} */
  const duplicates = [];
  /** 当前路径（depth 严格递增），按 depth 还原父子时用。 @type {TreeNode[]} */
  const stack = [];

  for (const raw of Array.isArray(layers) ? layers : []) {
    if (!raw || typeof raw !== 'object') continue;
    const at = typeof raw.at === 'string' ? raw.at : '';
    if (!at) continue;
    if (byAt.has(at)) {
      duplicates.push(at);
      continue;
    }
    const rawDepth = typeof raw.depth === 'number' && Number.isFinite(raw.depth) ? Math.max(1, Math.trunc(raw.depth)) : null;

    /** @type {TreeNode | null} */
    let parent = null;
    if (typeof raw.parentAt === 'string' && raw.parentAt !== '' && raw.parentAt !== at) {
      const candidate = byAt.get(raw.parentAt);
      if (candidate && (rawDepth === null || candidate.depth < rawDepth)) parent = candidate;
    }
    if (!parent && rawDepth !== null) {
      /* 按 depth 还原：弹到最近的更浅层 */
      while (stack.length > 0 && /** @type {TreeNode} */ (stack[stack.length - 1]).depth >= rawDepth) stack.pop();
      parent = stack.length > 0 ? /** @type {TreeNode} */ (stack[stack.length - 1]) : null;
    }

    /** @type {TreeNode} */
    const node = {
      at,
      kind: typeof raw.kind === 'string' && raw.kind ? raw.kind : 'unknown',
      name: typeof raw.name === 'string' && raw.name ? raw.name : at,
      depth: parent ? parent.depth + 1 : 1,
      locked: raw.locked === true,
      parentAt: parent ? parent.at : null,
      children: []
    };
    if (parent) parent.children.push(node);
    else roots.push(node);
    byAt.set(at, node);
    nodes.push(node);

    /* 栈 = 该节点的祖先链（parentAt 与 depth 两条路径都收敛到同一份真相） */
    /** @type {TreeNode[]} */
    const path = [];
    /** @type {TreeNode | null} */
    let cursor = parent;
    while (cursor) {
      path.unshift(cursor);
      cursor = cursor.parentAt ? byAt.get(cursor.parentAt) ?? null : null;
    }
    stack.length = 0;
    stack.push(...path, node);
  }

  return { roots, nodes, byAt, duplicates };
}

/**
 * 挂载图层树。
 *
 * @param {HTMLElement} container
 * @param {object} [opts]
 * @param {readonly LayerLike[]} [opts.layers]     初始层列表
 * @param {() => readonly LayerLike[]} [opts.getLayers] 每次渲染时取层（优先于 layers）
 * @param {string} [opts.selectedAt]               初始选中
 * @param {(at: string) => void} [opts.onSelect]   选中回调（锁定层不会触发）
 * @param {(at: string | null) => void} [opts.onHover] 悬停回调（移开 = null）
 * @param {(ats: string[]) => void} [opts.onLockChange]   锁定集合变化
 * @param {(ats: string[]) => void} [opts.onHiddenChange] 显隐集合变化
 * @param {(at: string) => boolean} [opts.lockedAt] 额外锁判定（与 `layer.locked` 取或）
 * @param {(at: string) => boolean} [opts.hiddenAt] 额外显隐判定
 * @param {readonly string[]} [opts.collapsed]     初始折叠的 at
 * @param {string} [opts.filter]                   初始过滤词
 * @param {string} [opts.idPrefix]
 * @param {string} [opts.emptyText]
 * @param {string} [opts.filterPlaceholder]
 * @param {boolean} [opts.filterable]              是否渲染过滤框，默认 true
 */
export function mountLayerTree(container, opts = {}) {
  if (!container || typeof container.appendChild !== 'function') throw new Error('mountLayerTree 需要一个容器元素');

  const doc = container.ownerDocument ?? /** @type {Document} */ (globalThis.document);
  const idPrefix = typeof opts.idPrefix === 'string' && opts.idPrefix ? opts.idPrefix : 'layer-tree';
  const emptyText = typeof opts.emptyText === 'string' ? opts.emptyText : '没有可编辑图层';
  const filterable = opts.filterable !== false;

  /* 外壳：过滤框 + 树。树根每次 render 会清空，过滤框在外面，输入焦点不会被重绘打断。 */
  const panel = doc.createElement('div');
  panel.className = 'layer-tree-panel';
  panel.setAttribute('data-layer-tree-panel', '');

  /** @type {HTMLInputElement | null} */
  let filterInput = null;
  if (filterable) {
    filterInput = /** @type {HTMLInputElement} */ (doc.createElement('input'));
    filterInput.className = 'layer-tree-filter';
    filterInput.setAttribute('data-tree-filter', '');
    filterInput.setAttribute('type', 'search');
    filterInput.setAttribute('aria-label', '过滤图层');
    filterInput.placeholder = typeof opts.filterPlaceholder === 'string' ? opts.filterPlaceholder : '过滤图层（名称/类型）';
    filterInput.style.cssText = [
      'width:100%',
      'box-sizing:border-box',
      'margin:0 0 6px',
      'padding:4px 6px',
      'font:12px/1.4 inherit',
      'color:inherit',
      'background:rgba(255,255,255,.06)',
      'border:1px solid rgba(255,255,255,.18)',
      'border-radius:4px'
    ].join(';');
    panel.appendChild(filterInput);
  }

  const root = doc.createElement('div');
  root.className = 'layer-tree';
  root.setAttribute('role', 'tree');
  root.setAttribute('data-layer-tree', '');
  root.setAttribute('data-persist', LAYER_TREE_PERSISTENCE);
  root.setAttribute('tabindex', '0');
  panel.appendChild(root);
  container.appendChild(panel);

  const state = {
    /** @type {TreeNode[]} */
    nodes: [],
    /** @type {Map<string, TreeNode>} */
    byAt: new Map(),
    /** @type {TreeNode[]} */
    roots: [],
    /** @type {string[]} */
    duplicates: [],
    selectedAt: typeof opts.selectedAt === 'string' ? opts.selectedAt : '',
    activeAt: '',
    /** @type {Set<string>} */
    collapsed: new Set(Array.isArray(opts.collapsed) ? opts.collapsed : []),
    /** 会话内锁定（不写盘） @type {Set<string>} */
    locked: new Set(),
    /** 会话内隐藏（不写盘） @type {Set<string>} */
    hidden: new Set(),
    filter: typeof opts.filter === 'string' ? opts.filter : '',
    hoverAt: '',
    /** 'IDLE' | 'SELECTED' | 'LOCKED' */
    status: 'IDLE',
    /** @type {TreeNode[]} */
    visible: [],
    /** @type {Map<string, HTMLElement>} */
    rows: new Map()
  };

  /** @param {TreeNode} node */
  function isLocked(node) {
    if (node.locked || state.locked.has(node.at)) return true;
    if (typeof opts.lockedAt === 'function') {
      try {
        return opts.lockedAt(node.at) === true;
      } catch {
        return false;
      }
    }
    return false;
  }

  /** @param {TreeNode} node */
  function isHidden(node) {
    if (state.hidden.has(node.at)) return true;
    if (typeof opts.hiddenAt === 'function') {
      try {
        return opts.hiddenAt(node.at) === true;
      } catch {
        return false;
      }
    }
    return false;
  }

  /** @param {string} at */
  function nodeOf(at) {
    return state.byAt.get(at) ?? null;
  }

  function readLayers() {
    if (typeof opts.getLayers === 'function') {
      try {
        const list = opts.getLayers();
        if (Array.isArray(list)) return list;
      } catch {
        return [];
      }
    }
    return Array.isArray(opts.layers) ? opts.layers : [];
  }

  function rebuild() {
    const built = buildLayerTree(readLayers());
    state.nodes = built.nodes;
    state.byAt = built.byAt;
    state.roots = built.roots;
    state.duplicates = built.duplicates;
    /* 选中/活动/锁定/隐藏里已经不存在的 at 就地清掉，避免指向幽灵行 */
    if (state.selectedAt && !state.byAt.has(state.selectedAt)) state.selectedAt = '';
    if (state.activeAt && !state.byAt.has(state.activeAt)) state.activeAt = '';
    if (!state.activeAt) state.activeAt = state.selectedAt;
    for (const at of [...state.locked]) if (!state.byAt.has(at)) state.locked.delete(at);
    for (const at of [...state.hidden]) if (!state.byAt.has(at)) state.hidden.delete(at);
    for (const at of [...state.collapsed]) if (!state.byAt.has(at)) state.collapsed.delete(at);
  }

  /**
   * 过滤：命中 name/kind 的节点 + 其祖先 + 其子孙。
   * @returns {Set<string> | null} null = 没在过滤
   */
  function filterKeep() {
    const q = state.filter.trim().toLowerCase();
    if (!q) return null;
    /** @type {Set<string>} */
    const keep = new Set();
    /** @type {TreeNode[]} */
    const matched = [];
    for (const node of state.nodes) {
      if (node.name.toLowerCase().includes(q) || node.kind.toLowerCase().includes(q)) {
        matched.push(node);
        keep.add(node.at);
      }
    }
    for (const node of matched) {
      /* 祖先链 */
      /** @type {TreeNode | null} */
      let p = node.parentAt ? nodeOf(node.parentAt) : null;
      while (p) {
        keep.add(p.at);
        p = p.parentAt ? nodeOf(p.parentAt) : null;
      }
      /* 子项（命中项自己的层级要能看见） */
      /** @param {TreeNode} n */
      const walk = (n) => {
        for (const c of n.children) {
          keep.add(c.at);
          walk(c);
        }
      };
      walk(node);
    }
    return keep;
  }

  /** 当前可见行（跳过折叠节点的后代；过滤时忽略折叠）。 @param {Set<string> | null} keep */
  function computeVisible(keep) {
    /** @type {TreeNode[]} */
    const out = [];
    /** @param {TreeNode} node */
    const walk = (node) => {
      if (keep && !keep.has(node.at)) return;
      out.push(node);
      if (!keep && state.collapsed.has(node.at)) return;
      for (const child of node.children) walk(child);
    };
    for (const node of state.roots) walk(node);
    state.visible = out;
    return out;
  }

  function render() {
    root.textContent = '';
    state.rows = new Map();
    const keep = filterKeep();
    computeVisible(keep);

    root.setAttribute('data-tree-count', String(state.nodes.length));
    root.setAttribute('data-tree-visible', String(state.visible.length));
    root.setAttribute('data-tree-selected', state.selectedAt);
    root.setAttribute('data-tree-status', state.status);
    root.setAttribute('data-tree-filtering', String(keep !== null));
    if (filterInput && filterInput.value !== state.filter) filterInput.value = state.filter;

    if (state.nodes.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'layer-tree-empty';
      empty.setAttribute('data-tree-empty', '');
      empty.textContent = emptyText;
      root.appendChild(empty);
      root.removeAttribute('aria-activedescendant');
      return;
    }
    if (state.visible.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'layer-tree-empty';
      empty.setAttribute('data-tree-empty', '');
      empty.setAttribute('data-tree-filter-empty', '');
      empty.textContent = `没有匹配「${state.filter}」的图层`;
      root.appendChild(empty);
      root.removeAttribute('aria-activedescendant');
      return;
    }

    for (const node of state.visible) {
      const locked = isLocked(node);
      const hidden = isHidden(node);
      const row = doc.createElement('div');
      row.className = 'layer-tree-row';
      row.setAttribute('role', 'treeitem');
      row.setAttribute('data-layer-row', '');
      row.setAttribute('data-at', node.at);
      row.setAttribute('data-depth', String(node.depth));
      row.setAttribute('data-kind', node.kind);
      row.setAttribute('data-locked', String(locked));
      row.setAttribute('data-hidden', String(hidden));
      row.setAttribute('data-active', String(node.at === (state.activeAt || state.selectedAt)));
      row.setAttribute('data-hover', String(node.at === state.hoverAt));
      row.setAttribute('aria-level', String(node.depth));
      row.setAttribute('aria-selected', String(node.at === state.selectedAt));
      row.setAttribute('id', `${idPrefix}-${state.rows.size}`);
      row.style.paddingLeft = `${4 + (node.depth - 1) * TREE_INDENT_PX}px`;
      if (node.children.length > 0) {
        row.setAttribute('aria-expanded', String(keep !== null ? true : !state.collapsed.has(node.at)));
      }
      if (locked) row.setAttribute('aria-disabled', 'true');
      if (hidden) row.style.opacity = '0.45';

      const twisty = doc.createElement('span');
      twisty.className = 'layer-tree-twisty';
      twisty.setAttribute('data-twisty', '1');
      twisty.setAttribute('aria-hidden', 'true');
      const open = keep !== null ? true : !state.collapsed.has(node.at);
      twisty.textContent = node.children.length === 0 ? '' : open ? '▾' : '▸';
      twisty.style.visibility = node.children.length === 0 ? 'hidden' : 'visible';
      row.appendChild(twisty);

      const icon = doc.createElement('span');
      icon.className = 'layer-tree-icon';
      icon.setAttribute('data-icon', node.kind);
      icon.textContent = TREE_ICONS[/** @type {keyof typeof TREE_ICONS} */ (node.kind)] ?? TREE_ICONS.unknown;
      row.appendChild(icon);

      const name = doc.createElement('span');
      name.className = 'layer-tree-name';
      name.setAttribute('data-layer-name', '');
      name.textContent = node.name;
      if (hidden) name.style.textDecoration = 'line-through';
      row.appendChild(name);

      /* 锁定按钮：锁定时文字是「锁定」（S18 的 [data-lock] 契约保留），未锁是「锁」 */
      const lockBtn = doc.createElement('button');
      lockBtn.setAttribute('type', 'button');
      lockBtn.setAttribute('data-lock-toggle', '1');
      lockBtn.setAttribute('aria-pressed', String(locked));
      lockBtn.setAttribute('aria-label', locked ? '解锁图层' : '锁定图层');
      lockBtn.textContent = locked ? '锁定' : '锁';
      if (locked) lockBtn.setAttribute('data-lock', '1');
      /* ST12（ST1 样式批）：锁/眼字形 10 → 12，按钮 20×20。role/title/testid/handler 一个不动。 */
      lockBtn.style.cssText = 'margin-left:auto;height:20px;min-width:20px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;line-height:1;font-family:inherit;padding:0 3px;border-radius:3px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer;opacity:.75';
      row.appendChild(lockBtn);

      /* 显隐按钮：aria-pressed = 可见 */
      const eyeBtn = doc.createElement('button');
      eyeBtn.setAttribute('type', 'button');
      eyeBtn.setAttribute('data-eye-toggle', '1');
      eyeBtn.setAttribute('aria-pressed', String(!hidden));
      eyeBtn.setAttribute('aria-label', hidden ? '显示图层' : '隐藏图层');
      eyeBtn.textContent = hidden ? '隐' : '眼';
      eyeBtn.style.cssText = 'margin-left:2px;height:20px;min-width:20px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;line-height:1;font-family:inherit;padding:0 3px;border-radius:3px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer;opacity:.75';
      row.appendChild(eyeBtn);

      root.appendChild(row);
      state.rows.set(node.at, row);
    }

    const active = state.activeAt || state.selectedAt;
    const activeRow = active ? state.rows.get(active) : null;
    if (activeRow) root.setAttribute('aria-activedescendant', activeRow.id);
    else root.removeAttribute('aria-activedescendant');
  }

  /**
   * 只同步「选中/活动」相关的属性，**不重建行**（S28）。
   *
   * 200 行时 `render()` 要新建 1600 个节点（实测 7.2ms/次），而选中一行只改了 2 个属性。
   * 结构没变就不该重建：`render()` 留给换数据/折叠/过滤/锁定/显隐这些真会改行集合的操作。
   */
  function syncSelection() {
    const active = state.activeAt || state.selectedAt;
    root.setAttribute('data-tree-selected', state.selectedAt);
    root.setAttribute('data-tree-status', state.status);
    for (const [at, row] of state.rows) {
      const isActive = at === active;
      if (row.getAttribute('data-active') !== String(isActive)) row.setAttribute('data-active', String(isActive));
      const isSelected = at === state.selectedAt;
      if (row.getAttribute('aria-selected') !== String(isSelected)) row.setAttribute('aria-selected', String(isSelected));
    }
    const activeRow = active ? state.rows.get(active) : null;
    if (activeRow) root.setAttribute('aria-activedescendant', activeRow.id);
    else root.removeAttribute('aria-activedescendant');
  }

  /**
   * 选中一层。锁定层被拒（记 `LOCKED`，不发 `onSelect`）。
   * @param {string} at
   * @returns {{ok: true, at: string} | {ok: false, code: string, at: string}}
   */
  function select(at) {
    const node = nodeOf(at);
    if (!node) return { ok: false, code: 'NOT_FOUND', at };
    if (isLocked(node)) {
      state.status = 'LOCKED';
      state.activeAt = at;
      syncSelection();
      return { ok: false, code: 'LOCKED', at };
    }
    state.selectedAt = at;
    state.activeAt = at;
    state.status = 'SELECTED';
    syncSelection();
    if (typeof opts.onSelect === 'function') opts.onSelect(at);
    return { ok: true, at };
  }

  /** @param {number} delta */
  function moveActive(delta) {
    if (state.visible.length === 0) return null;
    const current = state.activeAt || state.selectedAt;
    const index = state.visible.findIndex((node) => node.at === current);
    const nextIndex = index < 0 ? (delta > 0 ? 0 : state.visible.length - 1) : Math.min(Math.max(index + delta, 0), state.visible.length - 1);
    const next = state.visible[nextIndex];
    if (!next) return null;
    state.activeAt = next.at;
    syncSelection();
    return next.at;
  }

  /** @param {string} at @param {boolean} collapsed */
  function setCollapsed(at, collapsed) {
    if (collapsed) state.collapsed.add(at);
    else state.collapsed.delete(at);
    render();
  }

  /** @param {string} at */
  function toggle(at) {
    const node = nodeOf(at);
    if (!node || node.children.length === 0) return false;
    if (state.filter.trim()) return false; /* 过滤时强制展开，折叠按钮不生效 */
    setCollapsed(at, !state.collapsed.has(at));
    return true;
  }

  /** @param {string} at @param {boolean} locked */
  function setLocked(at, locked) {
    if (!nodeOf(at)) return false;
    if (locked) state.locked.add(at);
    else state.locked.delete(at);
    render();
    if (typeof opts.onLockChange === 'function') opts.onLockChange([...state.locked]);
    return true;
  }

  /** @param {string} at @param {boolean} hidden */
  function setHidden(at, hidden) {
    if (!nodeOf(at)) return false;
    if (hidden) state.hidden.add(at);
    else state.hidden.delete(at);
    render();
    if (typeof opts.onHiddenChange === 'function') opts.onHiddenChange([...state.hidden]);
    return true;
  }

  /** @param {string} at */
  function setHover(at) {
    state.hoverAt = typeof at === 'string' ? at : '';
    for (const [key, row] of state.rows) row.setAttribute('data-hover', String(key === state.hoverAt));
    if (typeof opts.onHover === 'function') opts.onHover(state.hoverAt || null);
  }

  /** @param {string} text */
  function setFilter(text) {
    state.filter = typeof text === 'string' ? text : '';
    render();
    return state.filter;
  }

  root.addEventListener('mousedown', () => {
    /* 点行也要能接键盘：焦点放在树上（行本身不可聚焦，用 aria-activedescendant 指过去） */
    root.focus();
  });

  root.addEventListener('focus', () => root.setAttribute('data-tree-focused', 'true'));
  root.addEventListener('blur', () => root.setAttribute('data-tree-focused', 'false'));

  root.addEventListener('mouseover', (event) => {
    const target = /** @type {any} */ (event.target);
    if (!target || typeof target.closest !== 'function') return;
    const row = /** @type {HTMLElement | null} */ (target.closest('[data-layer-row]'));
    if (!row) return;
    const related = /** @type {any} */ (event.relatedTarget);
    if (related && row.contains(related)) return;
    const at = row.getAttribute('data-at') ?? '';
    if (at) setHover(at);
  });
  root.addEventListener('mouseout', (event) => {
    const target = /** @type {any} */ (event.target);
    if (!target || typeof target.closest !== 'function') return;
    const row = /** @type {HTMLElement | null} */ (target.closest('[data-layer-row]'));
    if (!row) return;
    const related = /** @type {any} */ (event.relatedTarget);
    if (related && row.contains(related)) return;
    setHover('');
  });

  root.addEventListener('click', (event) => {
    const target = /** @type {any} */ (event.target);
    if (!target || typeof target.closest !== 'function') return;
    const row = /** @type {HTMLElement | null} */ (target.closest('[data-layer-row]'));
    if (!row) return;
    const at = row.getAttribute('data-at') ?? '';
    const node = at ? nodeOf(at) : null;
    if (!node) return;

    if (target.closest('[data-lock-toggle]')) {
      event.stopPropagation();
      setLocked(at, !isLocked(node));
      return;
    }
    if (target.closest('[data-eye-toggle]')) {
      event.stopPropagation();
      setHidden(at, !isHidden(node));
      return;
    }
    if (target.closest('[data-twisty]')) {
      toggle(at);
      return;
    }
    select(at);
  });

  if (filterInput) {
    filterInput.addEventListener('input', () => setFilter(filterInput ? filterInput.value : ''));
    filterInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setFilter('');
      }
    });
  }

  root.addEventListener('keydown', (event) => {
    const key = event.key;
    const active = state.activeAt || state.selectedAt;
    const node = active ? nodeOf(active) : null;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      moveActive(key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (key === 'Home' || key === 'End') {
      if (state.visible.length === 0) return;
      event.preventDefault();
      const target = key === 'Home' ? state.visible[0] : state.visible[state.visible.length - 1];
      if (target) {
        state.activeAt = target.at;
        syncSelection();
      }
      return;
    }
    if (key === 'ArrowRight') {
      if (!node) return;
      event.preventDefault();
      if (node.children.length === 0) return;
      if (state.collapsed.has(node.at) && !state.filter.trim()) {
        setCollapsed(node.at, false);
        return;
      }
      const first = node.children[0];
      if (first) {
        state.activeAt = first.at;
        syncSelection();
      }
      return;
    }
    if (key === 'ArrowLeft') {
      if (!node) return;
      event.preventDefault();
      if (node.children.length > 0 && !state.collapsed.has(node.at) && !state.filter.trim()) {
        setCollapsed(node.at, true);
        return;
      }
      if (node.parentAt) {
        state.activeAt = node.parentAt;
        syncSelection();
      }
      return;
    }
    if (key === 'Enter' || key === ' ') {
      if (!node) return;
      event.preventDefault();
      select(node.at);
    }
  });

  rebuild();
  render();

  const api = {
    /** 换一批层（宿主重新 listLayers 后调用）。展开/锁定/显隐/过滤/选中都保持。 @param {readonly LayerLike[]} next */
    setLayers(next) {
      opts.layers = Array.isArray(next) ? next : [];
      rebuild();
      render();
      return api.getState();
    },
    /** 外部改选中（面板 `select()` 时同步高亮）；不折叠、不发 onSelect。 @param {string} at */
    setSelected(at) {
      state.selectedAt = typeof at === 'string' ? at : '';
      if (!state.activeAt || !state.byAt.has(state.activeAt)) state.activeAt = state.selectedAt;
      syncSelection();
    },
    select,
    /** @param {string} at */
    expand(at) {
      setCollapsed(at, false);
      return true;
    },
    /** @param {string} at */
    collapse(at) {
      setCollapsed(at, true);
      return true;
    },
    toggle,
    /** 键盘移动活动行（也供测试/宿主调用）。 @param {number} delta */
    moveActive,
    /** @param {string} at @param {boolean} locked */
    setLocked,
    /** @param {string} at @param {boolean} hidden */
    setHidden,
    /** @param {string} text */
    setFilter,
    getFilter() {
      return state.filter;
    },
    setHover,
    /** 锁定判定（宿主用它禁舞台手柄）。 @param {string} at */
    lockedAt(at) {
      const node = nodeOf(at);
      return node ? isLocked(node) : state.locked.has(at);
    },
    /** 显隐判定（宿主用它隐藏舞台框）。 @param {string} at */
    hiddenAt(at) {
      const node = nodeOf(at);
      return node ? isHidden(node) : state.hidden.has(at);
    },
    getLocked() {
      return [...state.locked];
    },
    getHidden() {
      return [...state.hidden];
    },
    /** @param {string} at */
    nodeOf,
    /** @param {string} at */
    rowOf(at) {
      return state.rows.get(at) ?? null;
    },
    /** 只读快照。 */
    getState() {
      return {
        selectedAt: state.selectedAt,
        activeAt: state.activeAt,
        collapsed: [...state.collapsed],
        locked: [...state.locked],
        hidden: [...state.hidden],
        filter: state.filter,
        hoverAt: state.hoverAt,
        visible: state.visible.map((node) => node.at),
        status: state.status,
        persistence: LAYER_TREE_PERSISTENCE,
        nodes: state.nodes.map((node) => ({
          at: node.at,
          depth: node.depth,
          parentAt: node.parentAt,
          kind: node.kind,
          name: node.name,
          locked: isLocked(node),
          hidden: isHidden(node)
        })),
        roots: state.roots.map((node) => node.at),
        duplicates: state.duplicates
      };
    },
    destroy() {
      panel.remove();
    },
    root,
    panel
  };

  return api;
}
