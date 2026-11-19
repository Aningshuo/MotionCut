/**
 * 动效/组件库面板（副线1 · S5-WP15）
 *
 * 与检查器同一路子：先算出可断言的视图模型，再渲染成 DOM 字符串；真正的样式由主线的
 * UI 骨架接。这里保证三件事在 DOM 上**看得见**，而不只在内存里：
 * - 条目不可用（缺资源/源缺失/已归档）时仍然列出来，并带原因；
 * - 每个动作是否可用、为什么不可用，写在 `data-enabled` / `data-reason` 上；
 * - 同一模板的多个实例各带各的参数，逐个标出（隔离不是口号）。
 */

export type LibraryItemStatus = 'ready' | 'changed' | 'missing-asset' | 'archived' | 'source-missing';
export type LibraryActionName = 'insert' | 'save-as' | 'upgrade' | 'rollback' | 'archive';

export interface LibraryEntryLike {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly sourcePath: string;
  readonly sourceHash: string;
  readonly version: number;
  readonly params?: Readonly<Record<string, { readonly type: string; readonly default?: unknown }>>;
  readonly archived?: boolean;
  /** 可回退的历史层数（0 = 没有上一版）。 */
  readonly historyDepth?: number;
}

export interface LibraryStatusLike {
  readonly entry: LibraryEntryLike;
  readonly status: LibraryItemStatus;
  readonly missingAssets?: readonly { readonly ref: string }[];
}

export interface LibraryInstanceLike {
  readonly clipId: string;
  readonly templateId: string;
  readonly values?: Readonly<Record<string, string | number | boolean>>;
}

export interface LibraryActionView {
  readonly action: LibraryActionName;
  readonly label: string;
  readonly enabled: boolean;
  readonly reason?: string;
}

export interface LibraryParamView {
  readonly key: string;
  readonly type: string;
  readonly value: string;
}

export interface LibraryInstanceView {
  readonly clipId: string;
  readonly params: readonly LibraryParamView[];
}

export interface LibraryItemView {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly status: LibraryItemStatus;
  readonly sourcePath: string;
  readonly shortHash: string;
  readonly version: number;
  readonly params: readonly LibraryParamView[];
  readonly instances: readonly LibraryInstanceView[];
  readonly missingAssets: readonly string[];
  readonly actions: readonly LibraryActionView[];
}

export interface LibraryPanelView {
  readonly filter: string;
  readonly query: string;
  readonly total: number;
  readonly shown: number;
  readonly items: readonly LibraryItemView[];
}

const ACTION_LABELS: Record<LibraryActionName, string> = {
  insert: '插入实例',
  'save-as': '另存为模板',
  upgrade: '升级到当前源',
  rollback: '回退到上一版',
  archive: '归档'
};

const STATUS_LABELS: Record<LibraryItemStatus, string> = {
  ready: '可用',
  changed: '源已变·待升级',
  'missing-asset': '依赖缺失·不可用',
  archived: '已归档',
  'source-missing': '源缺失·不可用'
};

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESC[ch] ?? ch);
}

function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

function paramViews(
  entry: LibraryEntryLike,
  values: Readonly<Record<string, string | number | boolean>> | undefined
): LibraryParamView[] {
  const schema = entry.params ?? {};
  return Object.keys(schema)
    .sort()
    .map((key) => {
      const spec = schema[key];
      const given = values ? values[key] : undefined;
      const value = given !== undefined ? given : spec?.default;
      return { key, type: spec?.type ?? 'unknown', value: value === undefined ? '—' : String(value) };
    });
}

function actionsOf(item: {
  status: LibraryItemStatus;
  instances: readonly LibraryInstanceView[];
  historyDepth: number;
}): LibraryActionView[] {
  const blocked = item.status !== 'ready';
  const out: LibraryActionView[] = [];
  out.push({
    action: 'insert',
    label: ACTION_LABELS.insert,
    enabled: !blocked,
    ...(blocked ? { reason: item.status.toUpperCase().replace(/-/g, '_') } : {})
  });
  out.push({ action: 'save-as', label: ACTION_LABELS['save-as'], enabled: true });
  out.push({
    action: 'upgrade',
    label: ACTION_LABELS.upgrade,
    enabled: item.status === 'changed',
    ...(item.status === 'changed' ? {} : { reason: 'NO_CHANGE' })
  });
  out.push({
    action: 'rollback',
    label: ACTION_LABELS.rollback,
    enabled: item.historyDepth > 0,
    ...(item.historyDepth > 0 ? {} : { reason: 'NO_HISTORY' })
  });
  out.push({
    action: 'archive',
    label: ACTION_LABELS.archive,
    enabled: item.instances.length === 0,
    ...(item.instances.length === 0 ? {} : { reason: 'TEMPLATE_IN_USE' })
  });
  return out;
}

/**
 * 把库里读出来的状态 + 当前实例表 → 面板视图（纯函数，便于断言）。
 */
export function buildLibraryPanelView(
  statuses: readonly LibraryStatusLike[],
  instances: readonly LibraryInstanceLike[] = [],
  opts: { readonly filter?: string; readonly query?: string } = {}
): LibraryPanelView {
  const filter = opts.filter ?? 'all';
  const query = (opts.query ?? '').trim().toLowerCase();

  const items: LibraryItemView[] = statuses.map((s) => {
    const mine = instances.filter((i) => i.templateId === s.entry.id);
    const instanceViews: LibraryInstanceView[] = mine
      .map((i) => ({ clipId: i.clipId, params: paramViews(s.entry, i.values) }))
      .sort((a, b) => a.clipId.localeCompare(b.clipId));
    const historyDepth = s.entry.historyDepth ?? Math.max(0, s.entry.version - 1);
    const item = {
      id: s.entry.id,
      name: s.entry.name,
      kind: s.entry.kind,
      status: s.status,
      sourcePath: s.entry.sourcePath,
      shortHash: shortHash(s.entry.sourceHash),
      version: s.entry.version,
      params: paramViews(s.entry, undefined),
      instances: instanceViews,
      missingAssets: (s.missingAssets ?? []).map((a) => a.ref),
      historyDepth
    };
    return { ...item, actions: actionsOf(item) };
  });

  const matched = items.filter((item) => {
    if (filter !== 'all' && item.status !== filter) return false;
    if (!query) return true;
    return (
      item.name.toLowerCase().includes(query) ||
      item.id.toLowerCase().includes(query) ||
      item.sourcePath.toLowerCase().includes(query)
    );
  });

  return {
    filter,
    query,
    total: items.length,
    shown: matched.length,
    items: matched.sort((a, b) => a.name.localeCompare(b.name))
  };
}

/**
 * 渲染面板。空库与「筛选后为空」是两种不同的空状态，不合并成一句话。
 */
export function renderLibraryPanel(view: LibraryPanelView): string {
  const head =
    `<div class="library" data-count="${view.total}" data-shown="${view.shown}" ` +
    `data-filter="${escapeHtml(view.filter)}" data-query="${escapeHtml(view.query)}">` +
    `<header class="library-head"><h2>动效库</h2>` +
    `<span class="library-count">${view.shown}/${view.total}</span></header>`;

  if (view.total === 0) {
    return `${head}<p class="library-empty" data-empty="library">还没有模板：把当前片段另存为模板后才会出现在这里。</p></div>`;
  }
  if (view.shown === 0) {
    return `${head}<p class="library-empty" data-empty="filter">没有符合筛选的模板。</p></div>`;
  }

  const items = view.items
    .map((item) => {
      const actions = item.actions
        .map(
          (a) =>
            `<button class="library-action" data-action="${a.action}" data-enabled="${a.enabled}" ` +
            `data-reason="${escapeHtml(a.reason ?? '')}"${a.enabled ? '' : ' disabled'}>${escapeHtml(a.label)}</button>`
        )
        .join('');
      const params = item.params.length
        ? `<ul class="library-params">` +
          item.params
            .map(
              (p) =>
                `<li data-param="${escapeHtml(p.key)}" data-type="${escapeHtml(p.type)}">` +
                `${escapeHtml(p.key)}<span class="type">${escapeHtml(p.type)}</span>` +
                `<span class="default">${escapeHtml(p.value)}</span></li>`
            )
            .join('') +
          `</ul>`
        : `<p class="library-noparams">无参数</p>`;
      const instances = item.instances.length
        ? `<ul class="library-instances">` +
          item.instances
            .map(
              (i) =>
                `<li data-instance="${escapeHtml(i.clipId)}">` +
                `<span class="clip">${escapeHtml(i.clipId)}</span>` +
                i.params.map((p) => `<span data-param="${escapeHtml(p.key)}">${escapeHtml(p.value)}</span>`).join('') +
                `</li>`
            )
            .join('') +
          `</ul>`
        : `<p class="library-noinstance" data-instances="0">还没有实例</p>`;
      const missing = item.missingAssets.length
        ? `<p class="library-missing" data-missing="${item.missingAssets.length}">` +
          `缺资源：${item.missingAssets.map((r) => escapeHtml(r)).join('、')}</p>`
        : '';
      return (
        `<section class="library-item" data-entry="${escapeHtml(item.id)}" data-status="${item.status}" ` +
        `data-kind="${escapeHtml(item.kind)}" data-version="${item.version}" data-hash="${escapeHtml(item.shortHash)}" ` +
        `data-source="${escapeHtml(item.sourcePath)}" data-instances="${item.instances.length}">` +
        `<h3>${escapeHtml(item.name)}<span class="library-status" data-status="${item.status}">` +
        `${escapeHtml(STATUS_LABELS[item.status])}</span></h3>` +
        `<p class="library-path">${escapeHtml(item.sourcePath)} · v${item.version} · ${escapeHtml(item.shortHash)}</p>` +
        missing +
        params +
        instances +
        `<div class="library-actions">${actions}</div>` +
        `</section>`
      );
    })
    .join('');

  return `${head}<div class="library-list">${items}</div></div>`;
}

export default renderLibraryPanel;
