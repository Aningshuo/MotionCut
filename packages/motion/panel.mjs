/**
 * 动效库面板（副线1 · S27-MOTION-PANEL）
 *
 * 引擎（`library.mjs` / `params.mjs` / `instance.mjs`）早就有了，但一直**零消费者**。
 * 这个面板是第一个：列表 + 参数表单 + 应用，纯 UI + 校验，**不读盘、不写 `film.html`**。
 * 数据由宿主 `loadLibrary` 给，写盘也归宿主 `applyEntry`——面板自己不碰任何文件。
 *
 * ## 冻结接口（大脑定的，字段名一个都不许改）
 *
 * ```js
 * export const MOTION_PANEL_VERSION = 1;
 * mountMotionPanel(container, {loadLibrary, applyEntry, onApplied, onError, style})
 *   → {refresh, destroy, getState}
 * ```
 *
 * `MotionEntryView` / `MotionParamView` 的形状见本文件 typedef，与任务书 4.1 逐字段一致。
 *
 * ## 校验复用 `params.mjs`
 *
 * **不重写规则、不各写一套**：把 `MotionParamView[]` 折成 `ParamSchema`（`motionPanelSchema`），
 * 交给 `validateParams` 判。它返回 `ok:false` 时**不返回 values**，所以面板也不可能把半份参数
 * 递给宿主（A5 要求递过去的必须是**校验后**的完整对象，含补齐的默认值）。
 *
 * 可选且无默认值的参数留空时，该键**不进本次 schema**（而不是塞一个空串）：界面上一眼看得出
 * 它没填，参数对象里也就不该有它。必填（`required:true`）留空 → `MISSING_PARAM`，就地标红。
 *
 * ## 失败语义
 *
 * - 校验不过：`options`/`min,max`/未知键逐条写回**对应字段**（`[data-motion-error]`），
 *   表单底部给一句汇总；**不调 `applyEntry`**，也不发 `onError`（这是用户的输入问题，不是宿主故障）。
 * - `applyEntry` 返回 `ok:false` / 抛错：界面显示 `code`，`onError` 收到同一份 `{code,message}`，
 *   **不假装成功**（`data-ok="false"`）。
 * - 应用期间按钮 `disabled` + `data-busy="true"`，再次点击直接返回 `BUSY`，不会打两次请求。
 *
 * ## 三种异常态都要有出口
 *
 * 空库 / 加载失败 / 条目源缺失：都有可读文案 + 「重试」（`data-motion-retry`），点了会**再调一次**
 * `loadLibrary`（`getState().loads` 会加一，测试据此断言）。
 *
 * ## 不抢舞台指针
 *
 * 面板根带 `data-no-stage-gesture`：`canvas-gesture.mjs` 见到就整条忽略这次按下
 * （否则在面板里点输入框会被当成「舞台空白处按下」，进而起橡皮筋候选、抢指针捕获）。
 *
 * ## 隐藏测量节点
 *
 * 本组件**没有**隐藏测量节点（R12 的字幕组件踩过：`visibility:hidden` 的节点量完不清空，
 * 会把残字留在 `textContent` 里，读屏/复制/宿主断言全被污染）。将来若加，量完必须清空。
 *
 * ## `destroy()`
 *
 * 只挂自己的 DOM 事件（行/输入/按钮），不挂 `document`/`window`；`destroy()` 移除根节点即零残留，
 * 20 次挂卸不会留监听。
 */

import { validateParams, describeIssues } from './params.mjs';

/**
 * 面板接口版本（S34 起 1.1.0）。
 *
 * 1.1.0 相对 1.0.0 只做**加法**：
 * - `MotionEntryView` 多两个**可选**字段（`deterministic` / `expectedDurationMs`）；
 * - 详情区多一个**可关闭**的提示块（`deterministic === false` 时）；
 * - `getState()` 多 `interfaceVersion` / `selected` / `warnings`。
 *
 * 旧字段、旧回调、5 个 opts、三个返回方法一个没动——按 1.0 形状喂数据的调用方不改代码仍工作
 * （B4 有兼容用例）。
 */
export const MOTION_PANEL_VERSION = '1.1.0';

/** 主版本（数字）：宿主若只认「1 这一代」，用它判断，别去 parse 字符串。 */
export const MOTION_PANEL_MAJOR = 1;

/** 非确定性模板的提示语（面板与交接共用一份，不各写一句）。 */
export const MOTION_NONDETERMINISTIC_TEXT = '不受帧驱动：导出可能不可复现';

/** 条目类型（与 `library.mjs` 的 `ENTRY_KINDS` 一致）。 */
export const MOTION_PANEL_KINDS = Object.freeze(['animation', 'component', 'saved']);

/** 类型 → 中文标签（列表与筛选下拉共用）。 */
export const MOTION_PANEL_KIND_LABELS = Object.freeze({
  animation: '动画',
  component: '组件',
  saved: '已存'
});

/**
 * 样式默认值。`opts.style` 只覆盖**这里已有的键**；未知键忽略（不往 DOM 上乱写）。
 * 不引样式表：全部走内联，挂到任何宿主都不会被全局 CSS 打穿。
 */
export const MOTION_PANEL_STYLE_DEFAULTS = Object.freeze({
  width: '260px',
  background: '#0f1729',
  surface: '#151d2e',
  text: '#e5e7eb',
  muted: '#94a3b8',
  accent: '#3b82f6',
  danger: '#ef4444',
  warn: '#f59e0b',
  border: 'rgba(255,255,255,.14)',
  fontFamily: 'system-ui,-apple-system,"PingFang SC",Arial,sans-serif',
  fontSize: '12px'
});

/**
 * @typedef {object} MotionParamView
 * @property {string} name
 * @property {string} label
 * @property {'number'|'string'|'boolean'|'color'|'enum'} type
 * @property {unknown} [default]
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 * @property {string[]} [options]   enum 用
 * @property {boolean} [required]
 */

/**
 * @typedef {object} MotionEntryView
 * @property {string} id
 * @property {string} name
 * @property {'animation'|'component'|'saved'} kind
 * @property {boolean} sourceOk
 * @property {{path: string, reason: string}[]} assetIssues
 * @property {MotionParamView[]} params
 * @property {boolean} [deterministic] 缺省 = 未知（不提示）；false = 画面不受帧驱动，导出可能不可复现
 * @property {number} [expectedDurationMs] 预期时长（毫秒），仅用于显示
 */

/**
 * @typedef {object} MotionPanelOpts
 * @property {() => Promise<{ok: boolean, entries?: MotionEntryView[], error?: {code: string, message: string}}>} loadLibrary
 * @property {(id: string, params: Record<string, unknown>) => Promise<{ok: boolean, error?: {code: string, message: string}}>} applyEntry
 * @property {(result: {id: string, params: Record<string, unknown>}) => void} [onApplied]
 * @property {(info: {code: string, message: string}) => void} [onError]
 * @property {object} [style]
 */

/**
 * @typedef {{code: string, message: string}} PanelFailure
 * @typedef {{key: string, reason: string, detail?: string}} PanelIssue
 */

/** @typedef {import('./params.mjs').ParamSpec} ParamSpec */
/** @typedef {import('./params.mjs').ParamSchema} ParamSchema */

const PARAM_TYPES = Object.freeze(['number', 'string', 'boolean', 'color', 'enum']);

/**
 * 把 `MotionParamView[]` 折成 `params.mjs` 认的 `ParamSchema`（**只搬字段，不改规则**）。
 *
 * 非法视图不在这里拦：`type:'nope'` / `enum 没有 options` 会被 `validateSchema` 判为
 * `INVALID_SCHEMA`，面板显示「参数声明有问题」——这是模板作者的 bug，不该假装能编。
 *
 * @param {readonly MotionParamView[]} views
 * @returns {ParamSchema}
 */
export function motionPanelSchema(views) {
  /** @type {Record<string, ParamSpec>} */
  const schema = {};
  for (const view of Array.isArray(views) ? views : []) {
    if (!view || typeof view !== 'object') continue;
    const name = typeof view.name === 'string' ? view.name : '';
    if (!name) continue;
    const type = String(view.type ?? '');
    /** @type {Record<string, unknown>} */
    const spec = { type };
    if (view.default !== undefined) spec.default = view.default;
    if (typeof view.min === 'number') spec.min = view.min;
    if (typeof view.max === 'number') spec.max = view.max;
    if (typeof view.step === 'number') spec.step = view.step;
    if (typeof view.label === 'string' && view.label) spec.label = view.label;
    if (type === 'enum') spec.options = Array.isArray(view.options) ? [...view.options] : undefined;
    schema[name] = /** @type {ParamSpec} */ (/** @type {unknown} */ (spec));
  }
  return schema;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {MotionParamView[]} params */
function normalizeParams(params) {
  /** @type {MotionParamView[]} */
  const out = [];
  for (const raw of Array.isArray(params) ? params : []) {
    if (!isObject(raw)) continue;
    const name = typeof raw.name === 'string' ? raw.name : '';
    if (!name) continue;
    const type = PARAM_TYPES.includes(String(raw.type)) ? /** @type {MotionParamView['type']} */ (String(raw.type)) : 'string';
    /** @type {MotionParamView} */
    const view = { name, label: typeof raw.label === 'string' && raw.label ? raw.label : name, type };
    if (raw.default !== undefined) view.default = raw.default;
    if (typeof raw.min === 'number') view.min = raw.min;
    if (typeof raw.max === 'number') view.max = raw.max;
    if (typeof raw.step === 'number') view.step = raw.step;
    if (raw.required === true) view.required = true;
    if (type === 'enum') view.options = Array.isArray(raw.options) ? raw.options.filter((o) => typeof o === 'string') : [];
    out.push(view);
  }
  return out;
}

/**
 * @param {unknown} entries
 * @returns {MotionEntryView[]}
 */
function normalizeEntries(entries) {
  /** @type {MotionEntryView[]} */
  const out = [];
  for (const raw of Array.isArray(entries) ? entries : []) {
    if (!isObject(raw)) continue;
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!id) continue;
    const kind = MOTION_PANEL_KINDS.includes(String(raw.kind)) ? /** @type {MotionEntryView['kind']} */ (String(raw.kind)) : 'component';
    /** @type {{path: string, reason: string}[]} */
    const issues = [];
    for (const issue of Array.isArray(raw.assetIssues) ? raw.assetIssues : []) {
      if (!isObject(issue)) continue;
      issues.push({ path: String(issue.path ?? ''), reason: String(issue.reason ?? '') });
    }
    /** @type {MotionEntryView} */
    const entry = {
      id,
      name: typeof raw.name === 'string' && raw.name ? raw.name : id,
      kind,
      /* 缺省算可用：宿主没给 sourceOk 时不该把整库标红 */
      sourceOk: raw.sourceOk !== false,
      assetIssues: issues,
      params: normalizeParams(/** @type {MotionParamView[]} */ (raw.params))
    };
    /* 1.1.0 的可选字段：类型不对就当没给（不猜）。缺省 = 未知，不提示。 */
    if (typeof raw.deterministic === 'boolean') entry.deterministic = raw.deterministic;
    if (typeof raw.expectedDurationMs === 'number' && Number.isFinite(raw.expectedDurationMs)) {
      entry.expectedDurationMs = raw.expectedDurationMs;
    }
    out.push(entry);
  }
  return out;
}

/**
 * 挂载动效库面板。
 *
 * @param {HTMLElement} container
 * @param {MotionPanelOpts} opts
 * @returns {{refresh: () => void, destroy: () => void, getState: () => object}}
 */
export function mountMotionPanel(container, opts) {
  if (!container || typeof container.appendChild !== 'function') {
    throw new Error('mountMotionPanel 需要一个容器元素');
  }
  if (!opts || typeof opts.loadLibrary !== 'function') {
    throw new Error('mountMotionPanel 需要 opts.loadLibrary（返回 Promise<{ok, entries?, error?}>）');
  }
  if (typeof opts.applyEntry !== 'function') {
    throw new Error('mountMotionPanel 需要 opts.applyEntry（返回 Promise<{ok, error?}>）');
  }

  const doc = container.ownerDocument ?? /** @type {Document} */ (globalThis.document);
  /** @type {{[K in keyof typeof MOTION_PANEL_STYLE_DEFAULTS]: string}} */
  const theme = { ...MOTION_PANEL_STYLE_DEFAULTS };
  if (isObject(opts.style)) {
    for (const [key, value] of Object.entries(opts.style)) {
      if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(MOTION_PANEL_STYLE_DEFAULTS, key)) {
        /** @type {Record<string, string>} */ (theme)[key] = value;
      }
    }
  }

  const state = {
    /** @type {'idle'|'loading'|'ready'|'empty'|'error'} */
    phase: /** @type {'idle'|'loading'|'ready'|'empty'|'error'} */ ('idle'),
    /** @type {MotionEntryView[]} */
    entries: [],
    /** @type {PanelFailure|null} */
    error: null,
    /** @type {PanelFailure|null} */
    lastError: null,
    /** @type {{ok: boolean, id?: string, code?: string, message?: string}|null} */
    lastResult: null,
    /** @type {PanelIssue[]} */
    issues: [],
    /** @type {string[]} */
    defaultsApplied: [],
    query: '',
    kind: '',
    selectedId: '',
    applying: false,
    loads: 0,
    applies: 0,
    /** @type {Set<string>} 用户点过「知道了」的条目（每次挂载重置，不写盘） */
    dismissedWarnings: new Set(),
    loadSeq: 0,
    destroyed: false,
    /** @type {Map<string, {view: MotionParamView, input: HTMLElement, errorEl: HTMLElement, fieldEl: HTMLElement}>} */
    controls: new Map(),
    /** @type {Record<string, unknown>} */
    draft: {}
  };

  /* ── 静态外壳（只建一次；列表与详情各自重建，输入焦点不被重绘打断） ────── */

  const root = doc.createElement('div');
  root.className = 'motion-panel';
  root.setAttribute('data-motion-panel', '');
  /* 舞台手势见到这个属性就整条忽略（见 canvas-gesture.mjs 的 onPointerDown） */
  root.setAttribute('data-no-stage-gesture', '');
  root.setAttribute('data-motion-version', String(MOTION_PANEL_VERSION));
  root.style.cssText = [
    'box-sizing:border-box',
    `width:${theme.width}`,
    'display:flex',
    'flex-direction:column',
    'gap:8px',
    'padding:10px',
    `background:${theme.background}`,
    `color:${theme.text}`,
    `font:${theme.fontSize}/1.5 ${theme.fontFamily}`,
    `border:1px solid ${theme.border}`,
    'border-radius:6px',
    'overflow:hidden'
  ].join(';');

  const header = doc.createElement('div');
  header.setAttribute('data-motion-head', '');
  header.style.cssText = 'display:flex;flex-direction:column;gap:6px';
  root.appendChild(header);

  const searchInput = /** @type {HTMLInputElement} */ (doc.createElement('input'));
  searchInput.setAttribute('data-motion-search', '');
  searchInput.setAttribute('type', 'search');
  searchInput.setAttribute('aria-label', '搜索动效模板');
  searchInput.placeholder = '搜索名称…';
  searchInput.style.cssText = inputCss();
  header.appendChild(searchInput);

  const kindSelect = /** @type {HTMLSelectElement} */ (doc.createElement('select'));
  kindSelect.setAttribute('data-motion-kind', '');
  kindSelect.setAttribute('aria-label', '按类型筛选');
  kindSelect.style.cssText = inputCss();
  {
    const all = doc.createElement('option');
    all.value = '';
    all.textContent = '全部类型';
    kindSelect.appendChild(all);
    for (const kind of MOTION_PANEL_KINDS) {
      const option = doc.createElement('option');
      option.value = kind;
      option.textContent = MOTION_PANEL_KIND_LABELS[/** @type {keyof typeof MOTION_PANEL_KIND_LABELS} */ (kind)] ?? kind;
      kindSelect.appendChild(option);
    }
  }
  header.appendChild(kindSelect);

  const statusRow = doc.createElement('div');
  statusRow.setAttribute('data-motion-status-row', '');
  statusRow.style.cssText = 'display:flex;align-items:center;gap:6px;min-height:18px';
  const statusText = doc.createElement('p');
  statusText.setAttribute('data-motion-status', '');
  statusText.style.cssText = `margin:0;flex:1 1 auto;color:${theme.muted};font-size:inherit`;
  const retryBtn = doc.createElement('button');
  retryBtn.setAttribute('data-motion-retry', '');
  retryBtn.setAttribute('type', 'button');
  retryBtn.textContent = '重试';
  retryBtn.style.cssText = buttonCss('ghost');
  statusRow.appendChild(statusText);
  statusRow.appendChild(retryBtn);
  root.appendChild(statusRow);

  const list = doc.createElement('ul');
  list.setAttribute('data-motion-list', '');
  list.setAttribute('role', 'list');
  list.style.cssText = 'margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px;max-height:220px;overflow:auto';
  root.appendChild(list);

  const detail = doc.createElement('div');
  detail.setAttribute('data-motion-detail', '');
  detail.style.cssText = `border-top:1px solid ${theme.border};padding-top:8px;display:flex;flex-direction:column;gap:6px`;
  root.appendChild(detail);

  container.appendChild(root);

  /* ── 小工具 ─────────────────────────────────────────────────────────── */

  function inputCss() {
    return [
      'box-sizing:border-box',
      'width:100%',
      'padding:4px 6px',
      `font:${theme.fontSize}/1.4 ${theme.fontFamily}`,
      `color:${theme.text}`,
      'background:rgba(255,255,255,.06)',
      `border:1px solid ${theme.border}`,
      'border-radius:4px'
    ].join(';');
  }

  /** @param {'primary'|'ghost'} tone */
  function buttonCss(tone) {
    if (tone === 'primary') {
      return [
        'box-sizing:border-box',
        'padding:5px 10px',
        `font:${theme.fontSize}/1.4 ${theme.fontFamily}`,
        'color:#fff',
        `background:${theme.accent}`,
        'border:1px solid transparent',
        'border-radius:4px',
        'cursor:pointer',
        'width:100%'
      ].join(';');
    }
    return [
      'padding:2px 8px',
      `font:${theme.fontSize}/1.4 ${theme.fontFamily}`,
      `color:${theme.text}`,
      'background:transparent',
      `border:1px solid ${theme.border}`,
      'border-radius:4px',
      'cursor:pointer',
      'flex:0 0 auto'
    ].join(';');
  }

  /**
   * @param {Record<string, string>} attrs
   * @param {string} css
   * @param {string} text
   */
  function textEl(attrs, css, text) {
    const el = doc.createElement('span');
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    el.style.cssText = css;
    el.textContent = text;
    return el;
  }

  /** @param {MotionEntryView} entry */
  function seedDraft(entry) {
    /** @type {Record<string, unknown>} */
    const draft = {};
    for (const view of entry.params) {
      if (view.type === 'boolean') draft[view.name] = view.default === true;
      else if (view.default !== undefined && view.default !== null) draft[view.name] = String(view.default);
      else draft[view.name] = '';
    }
    state.draft = draft;
  }

  /** @param {string} id */
  function entryOf(id) {
    return state.entries.find((entry) => entry.id === id) ?? null;
  }

  function selectedEntry() {
    return state.selectedId ? entryOf(state.selectedId) : null;
  }

  /**
   * 当前该显示的条目（搜索 + 类型筛选）。
   * @returns {MotionEntryView[]}
   */
  function visibleEntries() {
    const query = state.query.trim().toLowerCase();
    return state.entries.filter((entry) => {
      if (state.kind && entry.kind !== state.kind) return false;
      if (query && !entry.name.toLowerCase().includes(query)) return false;
      return true;
    });
  }

  /* ── 状态行 ─────────────────────────────────────────────────────────── */

  function renderStatus() {
    const shown = visibleEntries().length;
    /** @type {string} */
    let text = '';
    if (state.phase === 'loading') text = '正在加载动效库…';
    else if (state.phase === 'error') {
      text = `库加载失败：${state.error ? state.error.code : 'UNKNOWN'}${state.error && state.error.message ? ` · ${state.error.message}` : ''}`;
    } else if (state.phase === 'empty') text = '库里还没有动效模板（先另存一个模板再回来）';
    else if (state.phase === 'idle') text = '';
    else text = `共 ${state.entries.length} 个模板，当前显示 ${shown} 个`;
    statusText.textContent = text;
    statusText.setAttribute('data-state', state.phase);
    statusText.style.color = state.phase === 'error' ? theme.danger : theme.muted;
    /* 空库 / 加载失败 / 源缺失都留一个出口 */
    const needsRetry = state.phase === 'empty' || state.phase === 'error';
    retryBtn.style.display = needsRetry ? 'block' : 'none';
    retryBtn.disabled = state.phase === 'loading';
  }

  /* ── 列表 ───────────────────────────────────────────────────────────── */

  function renderList() {
    list.textContent = '';
    const entries = visibleEntries();
    list.setAttribute('data-motion-count', String(entries.length));
    list.setAttribute('data-motion-total', String(state.entries.length));

    if (state.phase === 'ready' && entries.length === 0 && state.entries.length > 0) {
      const empty = doc.createElement('li');
      empty.setAttribute('data-motion-filter-empty', '');
      empty.style.cssText = `padding:6px;color:${theme.muted}`;
      empty.textContent = `没有匹配「${state.query || MOTION_PANEL_KIND_LABELS[/** @type {keyof typeof MOTION_PANEL_KIND_LABELS} */ (state.kind)] || state.kind}」的模板`;
      list.appendChild(empty);
    }

    /* R104 / U06（A23）：**只改展示与分组** —— 公共模板（animation/component）与
       项目模板（saved，本项目另存出来的）分成两组，组头各一行；组内相对顺序不变
       （与宿主给的 entries 顺序一致，测试里断言的顺序因此不受影响）。
       空组不出头。 */
    const groups = [
      { id: 'public', label: '公共模板', items: entries.filter((entry) => entry.kind !== 'saved') },
      { id: 'project', label: '项目模板（本项目另存）', items: entries.filter((entry) => entry.kind === 'saved') },
    ];

    for (const group of groups) {
      if (group.items.length === 0) continue;
      const head = doc.createElement('li');
      head.setAttribute('data-motion-group', group.id);
      head.style.cssText = `padding:4px 6px 2px;font-size:10px;letter-spacing:.02em;color:${theme.muted}`;
      head.textContent = `${group.label} · ${group.items.length}`;
      list.appendChild(head);

      for (const entry of group.items) {
        const row = doc.createElement('li');
        row.setAttribute('data-motion-entry', '');
        row.setAttribute('data-id', entry.id);
        row.setAttribute('data-kind', entry.kind);
        row.setAttribute('data-source-ok', String(entry.sourceOk));
        /* R104 / U06：可编辑标识 —— 模板有没有可改参数，选择前就看得见（不是固定封面式的死卡）。 */
        row.setAttribute('data-motion-editable', String(entry.params.length > 0));
        row.setAttribute('data-selected', String(entry.id === state.selectedId));
        row.setAttribute('data-asset-issues', String(entry.assetIssues.length));
        row.setAttribute('data-nondeterministic', String(entry.deterministic === false));
        row.style.cssText = [
          'box-sizing:border-box',
          'display:flex',
          'flex-direction:column',
          'gap:2px',
          'padding:5px 6px',
          'border-radius:4px',
          'border:1px solid ' + (entry.id === state.selectedId ? theme.accent : 'transparent'),
          `background:${entry.id === state.selectedId ? 'rgba(59,130,246,.14)' : 'rgba(255,255,255,.03)'}`,
          'cursor:pointer'
        ].join(';');

        const top = doc.createElement('div');
        top.style.cssText = 'display:flex;align-items:center;gap:6px';

        const name = textEl({ 'data-motion-name': '' }, 'flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', entry.name);
        top.appendChild(name);

        const kindLabel = textEl(
          { 'data-motion-kind-label': '' },
          `flex:0 0 auto;padding:0 4px;border-radius:3px;border:1px solid ${theme.border};color:${theme.muted};font-size:10px`,
          MOTION_PANEL_KIND_LABELS[entry.kind] ?? entry.kind
        );
        top.appendChild(kindLabel);
        /* U06：可编辑标识（有参数 = 「可编辑」；没有参数 = 「固定样式」，不让人白点一场）。 */
        top.appendChild(
          textEl(
            { 'data-motion-editable': String(entry.params.length > 0) },
            `flex:0 0 auto;padding:0 4px;border-radius:3px;border:1px solid ${entry.params.length > 0 ? theme.border : theme.warn};color:${entry.params.length > 0 ? theme.muted : theme.warn};font-size:10px`,
            entry.params.length > 0 ? '可编辑' : '固定样式'
          )
        );
        if (entry.deterministic === false) {
          /* 选择前就能看见：这条模板的画面不受帧驱动 */
          top.appendChild(
            textEl(
              { 'data-motion-row-nondeterministic': '' },
              `flex:0 0 auto;padding:0 4px;border-radius:3px;border:1px solid ${theme.warn};color:${theme.warn};font-size:10px`,
              '⚠ 非帧驱动'
            )
          );
        }
        row.appendChild(top);

        const meta = doc.createElement('div');
        meta.style.cssText = 'display:flex;align-items:center;gap:6px;min-height:14px';

        if (!entry.sourceOk) {
          const warn = textEl(
            { 'data-motion-source-warn': '' },
            `color:${theme.danger};font-size:10px;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`,
            '源缺失：模板 file 已不在工程里'
          );
          meta.appendChild(warn);
        } else {
          const ok = textEl({ 'data-motion-source-ok': '' }, `color:${theme.muted};font-size:10px;flex:1 1 auto`, '源可用');
          meta.appendChild(ok);
        }

        /* 「资产问题条数」始终可见（0 也显示），不是只在坏的时候才出现 */
        const assets = textEl(
          { 'data-motion-asset-count': '' },
          `flex:0 0 auto;font-size:10px;color:${entry.assetIssues.length ? theme.danger : theme.muted}`,
          `资产问题 ${entry.assetIssues.length}`
        );
        meta.appendChild(assets);
        row.appendChild(meta);

        /* 源缺失或资产缺失都标红：两种都意味着「这条现在不能用」 */
        if (!entry.sourceOk || entry.assetIssues.length > 0) row.style.borderColor = theme.danger;

        row.addEventListener('click', () => {
          selectEntry(entry.id);
        });
        list.appendChild(row);
      }
    }
  }

  /* ── 详情 / 参数表单 ─────────────────────────────────────────────────── */

  /**
   * @param {string} id
   */
  function selectEntry(id) {
    if (state.selectedId !== id) {
      state.selectedId = id;
      const entry = entryOf(id);
      if (entry) seedDraft(entry);
      state.issues = [];
      state.defaultsApplied = [];
      state.lastResult = null;
    }
    renderList();
    renderDetail();
  }

  function renderDetail() {
    detail.textContent = '';
    state.controls.clear();
    const entry = selectedEntry();
    detail.setAttribute('data-motion-detail-id', entry ? entry.id : '');
    if (!entry) {
      const hint = doc.createElement('p');
      hint.setAttribute('data-motion-detail-empty', '');
      hint.style.cssText = `margin:0;color:${theme.muted}`;
      hint.textContent = '选一个模板看参数';
      detail.appendChild(hint);
      return;
    }

    const head = doc.createElement('div');
    head.style.cssText = 'display:flex;align-items:baseline;gap:6px';
    head.appendChild(textEl({ 'data-motion-detail-name': '' }, 'font-weight:600', entry.name));
    head.appendChild(textEl({ 'data-motion-detail-kind': '' }, `color:${theme.muted};font-size:10px`, MOTION_PANEL_KIND_LABELS[entry.kind] ?? entry.kind));
    if (typeof entry.expectedDurationMs === 'number' && Number.isFinite(entry.expectedDurationMs)) {
      const seconds = entry.expectedDurationMs / 1000;
      head.appendChild(
        textEl(
          { 'data-motion-duration': String(entry.expectedDurationMs) },
          `color:${theme.muted};font-size:10px`,
          `时长 ${seconds.toFixed(2)}s`
        )
      );
    }
    detail.appendChild(head);

    if (!entry.sourceOk) {
      const block = doc.createElement('div');
      block.setAttribute('data-motion-source-missing', '');
      block.style.cssText = `padding:5px 6px;border-radius:4px;border:1px solid ${theme.danger};color:${theme.danger};font-size:11px;display:flex;flex-direction:column;gap:4px`;
      block.appendChild(textEl({ 'data-motion-source-missing-text': '' }, '', '模板源不在了：先修好源文件或重新登记，再重试'));
      const retry = doc.createElement('button');
      retry.setAttribute('data-motion-retry-source', '');
      retry.setAttribute('type', 'button');
      retry.textContent = '重试（重新读库）';
      retry.style.cssText = buttonCss('ghost');
      retry.addEventListener('click', () => {
        void load();
      });
      block.appendChild(retry);
      detail.appendChild(block);
    }

    if (entry.assetIssues.length > 0) {
      const issues = doc.createElement('ul');
      issues.setAttribute('data-motion-asset-issues', '');
      issues.style.cssText = `margin:0;padding-left:14px;color:${theme.danger};font-size:10px`;
      for (const issue of entry.assetIssues) {
        const item = doc.createElement('li');
        item.setAttribute('data-motion-asset-issue', '');
        item.textContent = `${issue.path || '(未知路径)'}：${issue.reason || '不可用'}`;
        issues.appendChild(item);
      }
      detail.appendChild(issues);
      const note = textEl(
        { 'data-motion-asset-blocked': '' },
        `padding:4px 6px;border-radius:4px;border:1px solid ${theme.danger};color:${theme.danger};font-size:11px`,
        `资产缺失 ${entry.assetIssues.length} 个：应用会得到缺资源的实例，已禁用「应用」`
      );
      detail.appendChild(note);
    }

    /* 非确定性模板：显式说「导出可能不可复现」，但**不拦应用**——用户仍然能装，
       只是他知道导出可能对不上。提示可关（只关当前条目、当前这次挂载）。 */
    if (entry.deterministic === false && !state.dismissedWarnings.has(entry.id)) {
      const warn = doc.createElement('div');
      warn.setAttribute('data-motion-nondeterministic', '');
      warn.style.cssText = `padding:5px 6px;border-radius:4px;border:1px solid ${theme.warn};color:${theme.warn};font-size:11px;display:flex;flex-direction:column;gap:4px`;
      warn.appendChild(textEl({ 'data-motion-nondeterministic-text': '' }, 'line-height:1.35', MOTION_NONDETERMINISTIC_TEXT));
      const close = doc.createElement('button');
      close.setAttribute('data-motion-dismiss-warning', '');
      close.setAttribute('type', 'button');
      close.style.cssText = `align-self:flex-start;padding:1px 6px;border-radius:3px;border:1px solid ${theme.warn};background:transparent;color:${theme.warn};font-size:10px;cursor:pointer`;
      close.textContent = '知道了';
      close.addEventListener('click', () => {
        state.dismissedWarnings.add(entry.id);
        renderDetail();
      });
      warn.appendChild(close);
      detail.appendChild(warn);
    }

    const form = doc.createElement('div');
    form.setAttribute('data-motion-form', '');
    form.style.cssText = 'display:flex;flex-direction:column;gap:6px';
    detail.appendChild(form);

    if (entry.params.length === 0) {
      form.appendChild(textEl({ 'data-motion-no-params': '' }, `color:${theme.muted}`, '这个模板没有参数'));
    }

    for (const view of entry.params) {
      form.appendChild(buildField(entry, view));
    }

    const summary = doc.createElement('p');
    summary.setAttribute('data-motion-form-error', '');
    summary.style.cssText = `margin:0;color:${theme.danger};font-size:11px;white-space:pre-wrap`;
    detail.appendChild(summary);

    const actions = doc.createElement('div');
    actions.style.cssText = 'display:flex;align-items:center;gap:6px';
    const apply = /** @type {HTMLButtonElement} */ (doc.createElement('button'));
    apply.setAttribute('data-motion-apply', '');
    apply.setAttribute('type', 'button');
    apply.textContent = '应用';
    apply.style.cssText = buttonCss('primary');
    apply.addEventListener('click', () => {
      void commit();
    });
    actions.appendChild(apply);
    detail.appendChild(actions);

    const result = doc.createElement('p');
    result.setAttribute('data-motion-result', '');
    result.style.cssText = `margin:0;font-size:11px;color:${theme.muted}`;
    detail.appendChild(result);

    renderApplyButton();
    renderIssues();
  }

  /**
   * @param {MotionEntryView} entry
   * @param {MotionParamView} view
   */
  function buildField(entry, view) {
    const field = doc.createElement('div');
    field.setAttribute('data-motion-field', '');
    field.setAttribute('data-param', view.name);
    field.setAttribute('data-type', view.type);
    field.style.cssText = 'display:flex;flex-direction:column;gap:2px';

    const label = doc.createElement('label');
    label.setAttribute('data-motion-label', '');
    label.style.cssText = `display:flex;align-items:center;gap:4px;color:${theme.text};font-size:11px`;
    label.appendChild(textEl({ 'data-motion-label-text': '' }, '', view.label || view.name));
    if (view.required === true) {
      label.appendChild(textEl({ 'data-motion-required': '' }, `color:${theme.danger}`, '*'));
    }
    field.appendChild(label);

    const draft = state.draft[view.name];
    /** @type {HTMLElement} */
    let input;
    if (view.type === 'boolean') {
      const box = /** @type {HTMLInputElement} */ (doc.createElement('input'));
      box.type = 'checkbox';
      box.checked = draft === true || draft === 'true';
      box.style.cssText = 'width:14px;height:14px;accent-color:' + theme.accent;
      input = box;
      label.prepend(box);
    } else if (view.type === 'enum') {
      const select = /** @type {HTMLSelectElement} */ (doc.createElement('select'));
      select.style.cssText = inputCss();
      const options = Array.isArray(view.options) ? view.options : [];
      for (const option of options) {
        const opt = doc.createElement('option');
        opt.value = option;
        opt.textContent = option;
        select.appendChild(opt);
      }
      const value = typeof draft === 'string' ? draft : '';
      select.value = value && options.includes(value) ? value : (options[0] ?? '');
      input = select;
    } else if (view.type === 'color') {
      const row = doc.createElement('div');
      row.style.cssText = 'display:flex;gap:4px;align-items:center';
      const picker = /** @type {HTMLInputElement} */ (doc.createElement('input'));
      picker.type = 'color';
      picker.setAttribute('data-motion-color-picker', '');
      picker.style.cssText = 'width:28px;height:22px;padding:0;border:1px solid ' + theme.border + ';background:transparent';
      const text = /** @type {HTMLInputElement} */ (doc.createElement('input'));
      text.type = 'text';
      text.value = typeof draft === 'string' ? draft : '';
      text.style.cssText = inputCss();
      /* 取色器只做「帮选」，文本才是真值：rgba()/hsl() 也是合法颜色，不能被控件改写 */
      const syncPicker = () => {
        const hex = /^#[0-9a-f]{6}$/i.test(text.value.trim()) ? text.value.trim() : '#000000';
        picker.value = hex;
      };
      syncPicker();
      picker.addEventListener('input', () => {
        text.value = picker.value;
      });
      text.addEventListener('input', syncPicker);
      row.appendChild(picker);
      row.appendChild(text);
      field.appendChild(row);
      input = text;
      /* 需要把两个控件的引用都留住：读值时以文本为准 */
      state.controls.set(view.name, { view, input, errorEl: doc.createElement('p'), fieldEl: field });
    } else if (view.type === 'number') {
      const number = /** @type {HTMLInputElement} */ (doc.createElement('input'));
      number.type = 'number';
      if (typeof view.min === 'number') number.min = String(view.min);
      if (typeof view.max === 'number') number.max = String(view.max);
      if (typeof view.step === 'number') number.step = String(view.step);
      number.step = typeof view.step === 'number' ? String(view.step) : 'any';
      number.value = typeof draft === 'string' ? draft : '';
      number.style.cssText = inputCss();
      input = number;
    } else {
      const text = /** @type {HTMLInputElement} */ (doc.createElement('input'));
      text.type = 'text';
      text.value = typeof draft === 'string' ? draft : '';
      text.style.cssText = inputCss();
      input = text;
    }

    input.setAttribute('data-motion-input', '');
    input.setAttribute('data-param', view.name);
    input.setAttribute('data-param-type', view.type);
    if (!field.contains(input)) field.appendChild(input);

    if (view.type === 'number') {
      const hint = document.createElement('span');
      const bits = [];
      if (typeof view.min === 'number') bits.push(`最小 ${view.min}`);
      if (typeof view.max === 'number') bits.push(`最大 ${view.max}`);
      if (typeof view.step === 'number') bits.push(`步长 ${view.step}`);
      hint.setAttribute('data-motion-range', '');
      hint.style.cssText = `color:${theme.muted};font-size:10px`;
      hint.textContent = bits.join(' · ');
      if (bits.length) field.appendChild(hint);
    }

    const error = doc.createElement('p');
    error.setAttribute('data-motion-error', '');
    error.style.cssText = `margin:0;color:${theme.danger};font-size:10px;display:none`;
    field.appendChild(error);

    const existing = state.controls.get(view.name);
    if (existing) {
      existing.errorEl = error;
      existing.fieldEl = field;
    } else {
      state.controls.set(view.name, { view, input, errorEl: error, fieldEl: field });
    }

    void entry;
    return field;
  }

  /* ── 读值 / 校验 / 应用 ─────────────────────────────────────────────── */

  /**
   * 读**表单里真实存在的**控件 → `{values, omitted}`。
   *
   * 读 DOM 而不是内部 Map：屏幕上有什么就校验什么。宿主若塞进一行过期参数（schema 里已经没有这个键），
   * 它会被 `validateParams` 判成 `UNKNOWN_PARAM` 整批拒绝——这正是「看起来改了其实没改」要防的那类事。
   * 留空的可选参数进 `omitted`，不静默塞空串。
   * @param {MotionEntryView} entry
   * @returns {{values: Record<string, unknown>, omitted: Set<string>}}
   */
  function readValues(entry) {
    /** @type {Record<string, unknown>} */
    const values = {};
    /** @type {Set<string>} */
    const omitted = new Set();
    for (const node of detail.querySelectorAll('[data-motion-input]')) {
      const input = /** @type {any} */ (node);
      const name = String(input.getAttribute('data-param') ?? '');
      if (!name) continue;
      const view = entry.params.find((item) => item.name === name) ?? null;
      const type = view ? view.type : String(input.getAttribute('data-param-type') ?? 'string');
      if (type === 'boolean') {
        values[name] = input.checked === true;
        continue;
      }
      const raw = String(input.value ?? '');
      if (raw.trim() === '') {
        omitted.add(name);
        continue;
      }
      values[name] = type === 'number' ? Number(raw) : raw;
    }
    return { values, omitted };
  }

  /**
   * 本次要校验的 schema：留空的可选无默认参数**不进** schema（见文件头）。
   * @param {MotionEntryView} entry
   * @param {Set<string>} omitted
   * @returns {ParamSchema}
   */
  function schemaFor(entry, omitted) {
    const full = motionPanelSchema(entry.params);
    /** @type {ParamSchema} */
    const subset = {};
    for (const [key, spec] of Object.entries(full)) {
      if (!omitted.has(key)) {
        subset[key] = spec;
        continue;
      }
      const view = entry.params.find((item) => item.name === key);
      const required = view?.required === true;
      const hasDefault = spec.type === 'enum' ? spec.default !== undefined : /** @type {any} */ (spec).default !== undefined;
      if (required || hasDefault) subset[key] = spec;
    }
    return subset;
  }

  async function commit() {
    if (state.applying) return { ok: false, code: 'BUSY' };
    const entry = selectedEntry();
    if (!entry) return { ok: false, code: 'NO_ENTRY' };
    if (!entry.sourceOk) {
      state.lastResult = { ok: false, code: 'SOURCE_MISSING', message: '模板源缺失：不能应用（先修源再重试）' };
      renderResult();
      return { ok: false, code: 'SOURCE_MISSING' };
    }
    /* 资产缺失时应用会得到「缺图/缺样式」的实例：宁可不给点，也不给半成品 */
    if (entry.assetIssues.length > 0) {
      state.lastResult = {
        ok: false,
        code: 'MISSING_ASSET',
        message: `资产缺失 ${entry.assetIssues.length} 个：${entry.assetIssues.map((issue) => issue.path).join('、')}`
      };
      renderResult();
      return { ok: false, code: 'MISSING_ASSET' };
    }

    const { values, omitted } = readValues(entry);
    const schema = schemaFor(entry, omitted);
    const checked = validateParams(schema, values);
    if (!checked.ok) {
      state.issues = checked.errors.map((issue) => ({ ...issue }));
      state.defaultsApplied = [];
      renderIssues();
      state.lastResult = { ok: false, code: checked.code, message: describeIssues(checked.errors) };
      renderResult();
      return { ok: false, code: checked.code };
    }

    state.issues = [];
    state.defaultsApplied = [...checked.defaultsApplied];
    renderIssues();

    state.applying = true;
    state.applies += 1;
    renderApplyButton();
    let applied;
    try {
      applied = await opts.applyEntry(entry.id, checked.values);
    } catch (err) {
      applied = { ok: false, error: { code: 'APPLY_THREW', message: String(/** @type {any} */ (err)?.message ?? err) } };
    } finally {
      state.applying = false;
    }
    if (state.destroyed) return { ok: false, code: 'DESTROYED' };

    if (!applied || applied.ok !== true) {
      const failure = applied && applied.error ? applied.error : { code: 'APPLY_FAILED', message: '宿主返回失败但没有给 error' };
      const failureCode = String(failure.code || 'APPLY_FAILED');
      const failureMessage = String(failure.message || '');
      state.lastResult = { ok: false, code: failureCode, message: failureMessage };
      state.lastError = { code: failureCode, message: failureMessage };
      renderApplyButton();
      renderResult();
      reportError(failureCode, failureMessage);
      return { ok: false, code: failureCode };
    }

    state.lastResult = { ok: true, id: entry.id };
    renderApplyButton();
    renderResult();
    if (typeof opts.onApplied === 'function') {
      try {
        opts.onApplied({ id: entry.id, params: checked.values });
      } catch (err) {
        reportError('ON_APPLIED_THREW', String(/** @type {any} */ (err)?.message ?? err));
      }
    }
    return { ok: true, id: entry.id, params: checked.values };
  }

  /** @param {string} code @param {string} message */
  function reportError(code, message) {
    if (typeof opts.onError !== 'function') return;
    try {
      opts.onError({ code, message });
    } catch {
      /* 宿主的 onError 自己炸了不该连带面板 */
    }
  }

  function renderApplyButton() {
    const apply = /** @type {HTMLButtonElement | null} */ (detail.querySelector('[data-motion-apply]'));
    if (!apply) return;
    const entry = selectedEntry();
    /* 三种「不给点」的原因分开记，界面与测试都能读到具体是哪一个 */
    const blockedReason = !entry ? 'NO_ENTRY' : !entry.sourceOk ? 'SOURCE_MISSING' : entry.assetIssues.length > 0 ? 'MISSING_ASSET' : '';
    const blocked = blockedReason !== '';
    apply.disabled = state.applying || blocked;
    apply.setAttribute('data-busy', String(state.applying));
    apply.setAttribute('data-blocked', String(blocked));
    apply.setAttribute('data-blocked-reason', blockedReason);
    apply.textContent = state.applying ? '应用中…' : '应用';
    apply.style.opacity = blocked ? '0.6' : state.applying ? '0.7' : '1';
    apply.style.cursor = blocked ? 'not-allowed' : 'pointer';
    /* 不可点的按钮不该还是那身主色：灰掉才一眼看得出「现在点不了」 */
    apply.style.background = blocked || state.applying ? theme.muted : theme.accent;
  }

  function renderIssues() {
    /** @type {Map<string, string[]>} */
    const byKey = new Map();
    /** @type {string[]} */
    const loose = [];
    for (const issue of state.issues) {
      const text = issue.detail ? `${issue.reason}（${issue.detail}）` : issue.reason;
      if (issue.key && state.controls.has(issue.key)) {
        const bucket = byKey.get(issue.key) ?? [];
        bucket.push(text);
        byKey.set(issue.key, bucket);
      } else {
        loose.push(issue.key ? `${issue.key}: ${text}` : text);
      }
    }
    for (const [name, ctl] of state.controls) {
      const messages = byKey.get(name) ?? [];
      const has = messages.length > 0;
      ctl.errorEl.textContent = messages.join('；');
      ctl.errorEl.style.display = has ? 'block' : 'none';
      ctl.errorEl.setAttribute('data-error', String(has));
      ctl.fieldEl.setAttribute('data-invalid', String(has));
      ctl.input.setAttribute('aria-invalid', String(has));
      ctl.fieldEl.style.borderLeft = has ? `2px solid ${theme.danger}` : 'none';
      ctl.fieldEl.style.paddingLeft = has ? '4px' : '0';
    }
    const summary = /** @type {HTMLElement | null} */ (detail.querySelector('[data-motion-form-error]'));
    if (summary) {
      const text = state.issues.length ? describeIssues(state.issues) : '';
      summary.textContent = text;
      summary.setAttribute('data-count', String(state.issues.length));
      summary.style.display = text ? 'block' : 'none';
    }
  }

  function renderResult() {
    const result = /** @type {HTMLElement | null} */ (detail.querySelector('[data-motion-result]'));
    if (!result) return;
    const last = state.lastResult;
    if (!last) {
      result.textContent = '';
      result.setAttribute('data-ok', '');
      return;
    }
    if (last.ok) {
      const entry = selectedEntry();
      result.textContent = entry && entry.deterministic === false ? `已应用 · ${MOTION_NONDETERMINISTIC_TEXT}` : '已应用';
      result.setAttribute('data-ok', 'true');
      result.style.color = theme.muted;
      return;
    }
    result.textContent = `应用失败：${last.code}${last.message ? ` · ${last.message}` : ''}`;
    result.setAttribute('data-ok', 'false');
    result.setAttribute('data-code', String(last.code ?? ''));
    result.style.color = theme.danger;
  }

  /* ── 加载 ───────────────────────────────────────────────────────────── */

  async function load() {
    const seq = (state.loadSeq += 1);
    state.phase = 'loading';
    state.error = null;
    renderStatus();
    let res;
    try {
      res = await opts.loadLibrary();
    } catch (err) {
      res = { ok: false, error: { code: 'LOAD_THREW', message: String(/** @type {any} */ (err)?.message ?? err) } };
    }
    if (state.destroyed || seq !== state.loadSeq) return;
    state.loads += 1;

    if (!res || res.ok !== true) {
      const failure = res && res.error ? res.error : { code: 'LOAD_FAILED', message: '宿主返回失败但没有给 error' };
      state.phase = 'error';
      state.error = { code: String(failure.code || 'LOAD_FAILED'), message: String(failure.message || '') };
      state.entries = [];
      state.selectedId = '';
      state.controls.clear();
      state.issues = [];
      state.lastResult = null;
      renderAll();
      reportError(state.error.code, state.error.message);
      return;
    }

    state.entries = normalizeEntries(res.entries);
    state.phase = state.entries.length ? 'ready' : 'empty';
    if (state.selectedId && !entryOf(state.selectedId)) {
      state.selectedId = '';
      state.controls.clear();
    }
    const keep = selectedEntry();
    if (keep) seedDraft(keep);
    renderAll();
  }

  function renderAll() {
    renderStatus();
    renderList();
    renderDetail();
  }

  /* ── 事件 ───────────────────────────────────────────────────────────── */

  const onSearch = () => {
    state.query = searchInput.value;
    renderStatus();
    renderList();
  };
  const onKind = () => {
    state.kind = kindSelect.value;
    renderStatus();
    renderList();
  };
  const onRetry = () => {
    void load();
  };
  searchInput.addEventListener('input', onSearch);
  kindSelect.addEventListener('change', onKind);
  retryBtn.addEventListener('click', onRetry);

  /* 首次渲染 + 加载 */
  renderAll();
  void load();

  return {
    refresh() {
      void load();
    },
    destroy() {
      state.destroyed = true;
      /* 让在飞的 loadLibrary/applyEntry 结果回来时自己作废 */
      state.loadSeq += 1;
      searchInput.removeEventListener('input', onSearch);
      kindSelect.removeEventListener('change', onKind);
      retryBtn.removeEventListener('click', onRetry);
      state.controls.clear();
      list.textContent = '';
      detail.textContent = '';
      root.remove();
    },
    getState() {
      const entry = selectedEntry();
      const shown = visibleEntries();
      return {
        version: MOTION_PANEL_VERSION,
        phase: state.phase,
        loading: state.phase === 'loading',
        error: state.error ? { ...state.error } : null,
        lastError: state.lastError ? { ...state.lastError } : null,
        entries: state.entries.map((item) => ({
          id: item.id,
          name: item.name,
          kind: item.kind,
          sourceOk: item.sourceOk,
          assetIssueCount: item.assetIssues.length,
          paramCount: item.params.length,
          /* 1.1.0 新增（可选）：缺省 undefined = 未知，不提示 */
          deterministic: item.deterministic,
          expectedDurationMs: item.expectedDurationMs ?? null
        })),
        counts: { entries: state.entries.length, visible: shown.length },
        visibleIds: shown.map((item) => item.id),
        query: state.query,
        kind: state.kind,
        selectedId: state.selectedId,
        /** 当前表单的控件对照（A3：控件数 == params 数） */
        fields: [...state.controls].map(([name, ctl]) => ({
          name,
          type: ctl.view.type,
          label: ctl.view.label,
          control: ctl.input.tagName.toLowerCase(),
          value: ctl.view.type === 'boolean' ? /** @type {any} */ (ctl.input).checked === true : String(/** @type {any} */ (ctl.input).value ?? '')
        })),
        issues: state.issues.map((issue) => ({ ...issue })),
        defaultsApplied: [...state.defaultsApplied],
        applying: state.applying,
        applies: state.applies,
        loads: state.loads,
        lastResult: state.lastResult ? { ...state.lastResult } : null,
        style: { ...theme },
        persistence: 'host-callback',
        entryParams: entry ? entry.params.map((view) => view.name) : [],
        /* 1.1.0：接口版本与「这条模板受不受帧驱动」 */
        interfaceVersion: MOTION_PANEL_VERSION,
        major: MOTION_PANEL_MAJOR,
        selected: entry
          ? {
              id: entry.id,
              deterministic: entry.deterministic,
              expectedDurationMs: entry.expectedDurationMs ?? null,
              warningVisible: entry.deterministic === false && !state.dismissedWarnings.has(entry.id)
            }
          : null,
        warnings: entry && entry.deterministic === false ? [MOTION_NONDETERMINISTIC_TEXT] : []
      };
    }
  };
}
