/**
 * Agent 顶部会话栏（R114 · L3 · 验收 LI-A29 / A30 / A40 / A41）。
 *
 * ## 它到底解决什么
 *
 * 之前面板顶部只有一颗「会话 (n) ▾」：能列、能建、能点开，但**没有「当前是哪条」的
 * 显示**，也没法改名/置顶/归档，更没有搜索 —— 一旦会话多了只能靠时间猜。
 * 这里把它做成真的会话栏：当前标题 + 下拉（新建 / 按标题搜索 / 切换 / 重命名 /
 * 置顶 / 归档可恢复）。
 *
 * ## 三条诚实口径
 *
 * 1. **搜索只搜标题**（不是全文）：输入框下面是范围说明，不写成「搜索会话」这种
 *    听起来像全文的说法；没有结果时说清是「标题里没有」，而不是「没有这条会话」。
 * 2. **归档不删**：只改 `sessions.json` 里的一个布尔，回合文件一个不动，随时可恢复。
 * 3. **运行中不许归档**：归档一个正在跑的会话，等于把「还在写回合的那条」藏起来。
 *    按下去没有反应最糟 —— 所以按钮是禁用的，并给出原因。
 *
 * `data-testid` 里 `agent-sessions` / `agent-sessions-menu` / `agent-session-new` /
 * `agent-session-row-<id>` / `agent-session-count` 是既有判据（s176）读的，名字不改。
 */

import { createElement, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { AgentSessionRow } from './api';
import type { ApiError } from './api';

const h = createElement;


/**
 * 1:1 会话菜单的小图标（只画形状；颜色由 token 决定）。
 * @param {'plus'|'search'|'chat'|'chevron'} name
 * @param {number} [size]
 */
function barIcon(name: 'plus' | 'search' | 'chat' | 'chevron', size = 18) {
  const common = {
    viewBox: '0 0 18 18',
    width: size,
    height: size,
    'aria-hidden': 'true',
    focusable: 'false',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  };
  const paths: Record<string, string[]> = {
    plus: ['M9 4v10', 'M4 9h10'],
    search: ['M8 3.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Z', 'M11.4 11.4 15 15'],
    chat: ['M3.5 4.5h11v7.5h-6l-2.8 2.3V12H3.5Z'],
    chevron: ['M5.5 7.5 9 11l3.5-3.5'],
  };
  return h('svg', common, ...(paths[name] ?? []).map((d, index) => h('path', { key: String(index), d })));
}

/** 相对时间（与 `agent-panel.ts` 的 `relativeTimeOf` 同口径；这里自带一份免得循环 import）。 */
function ago(iso: string, now = Date.now()): string {
  const stamp = Date.parse(iso);
  if (!Number.isFinite(stamp)) return '';
  const delta = Math.max(0, now - stamp);
  if (delta < 60_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return `${Math.floor(delta / 86_400_000)} 天前`;
}

export interface AgentSessionBarProps {
  projectOpen: boolean;
  /** 未归档的会话（服务端口径：turns>0，pinned 优先）。 */
  sessions: AgentSessionRow[];
  /** 已归档的会话（同一个请求带 `?archived=1` 拿回来的）。 */
  archived: AgentSessionRow[];
  /** 新建但还没有回合的会话（服务端列表筛掉它，本地置顶显示）。 */
  pending: AgentSessionRow | null;
  activeId: string;
  activeTitle: string;
  /** 正在跑生成的会话 id；空串 = 没有在跑。 */
  runningId: string;
  busy: boolean;
  error: string;
  onRefresh: () => void;
  onOpen: (sessionId: string) => void;
  onCreate: () => void;
  onPatch: (sessionId: string, patch: { title?: string; pinned?: boolean; archived?: boolean }) => void;
  /**
   * CS1（§3.1 第一层）：会话栏就是面板**顶部那一行**，不再是消息区里的第一条。
   * `bare` 去掉组件自带的 6px/10px 内边距（styles.css 归 MAIN，不能改），让标题按钮
   * 与右侧的模拟徽章/关闭键同高对齐；菜单仍锚在 `.agent-sessions` 上（position:relative）。
   */
  bare?: boolean;
}

export function AgentSessionBar(props: AgentSessionBarProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [moreId, setMoreId] = useState('');
  const [renameId, setRenameId] = useState('');
  const [renameText, setRenameText] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  /* 点面板外 / Esc 关掉下拉。会话菜单是 300px 高的浮层，不关会盖住消息区。 */
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (boxRef.current?.contains(target) === true) return;
      setOpen(false);
      setMoreId('');
      setRenameId('');
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      /* 捕获阶段吃掉这一下：App 的 Esc 会关整个面板（R118 · A42：Esc 只关最上面一层）。 */
      event.stopPropagation();
      setOpen(false);
      setMoreId('');
      setRenameId('');
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  const term = query.trim().toLowerCase();
  const matches = (row: AgentSessionRow): boolean =>
    term === '' || (row.title === '' ? '未命名会话' : row.title).toLowerCase().includes(term);
  const visible = props.sessions.filter(matches);
  const visibleArchived = props.archived.filter(matches);
  const totalShown = visible.length + visibleArchived.length;
  const searching = term !== '';
  /* R135（M11 · B1）：三态必须分得开 —— 「没加载出来」不能写成「没有结果」。
     加载失败时列表可能是空的，但那是**不知道**，不是**没有**。 */
  const loadState = props.error !== '' ? 'error' : props.busy ? 'loading' : 'ready';
  const known = loadState === 'ready';

  const rowOf = (row: AgentSessionRow, archived: boolean): ReactNode => {
    const title = row.title === '' ? '未命名会话' : row.title;
    const isActive = props.activeId === row.id;
    const isRunning = props.runningId === row.id;
    const isMore = moreId === row.id;
    const isRename = renameId === row.id;
    return h(
      'div',
      {
        key: row.id,
        className: 'agent-session-item',
        'data-testid': `agent-session-item-${row.id}`,
        'data-archived': archived ? 'true' : 'false',
        style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px' },
      },
      h(
        'button',
        {
          type: 'button',
          className: `agent-session-row chat-history-row${isActive ? ' is-active' : ''}`,
          'data-testid': `agent-session-row-${row.id}`,
          'data-pending': 'false',
          'data-session': row.id,
          'data-pinned': row.pinned === true ? 'true' : 'false',
          'data-archived': archived ? 'true' : 'false',
          'data-running': isRunning ? 'true' : 'false',
          'data-active': isActive ? 'true' : 'false',
          style: { flex: '1 1 auto', minWidth: 0 },
          title: archived ? `${title}（已归档）` : title,
          onClick: () => {
            if (archived) return;
            props.onOpen(row.id);
            setOpen(false);
            setMoreId('');
          },
        },
        h('span', {
          className: 'agent-session-dot',
          'data-status': isRunning ? 'running' : row.pinned === true ? 'pinned' : 'idle',
          'aria-hidden': 'true',
        }),
        h('span', { className: 'chat-history-icon', 'aria-hidden': 'true' }, barIcon('chat', 16)),
        h('span', { className: 'agent-session-title' }, archived ? `${title} · 已归档` : title),
        h('span', { className: 'agent-session-time' }, isRunning ? '运行中' : ago(row.updatedAt)),
      ),
      archived
        ? h(
            'button',
            {
              type: 'button',
              className: 'btn tiny',
              'data-testid': `agent-session-restore-${row.id}`,
              disabled: props.busy,
              title: '恢复这条会话（回到列表，回合一条不动）',
              onClick: () => props.onPatch(row.id, { archived: false }),
            },
            '恢复',
          )
        : h(
            'button',
            {
              type: 'button',
              className: 'btn tiny',
              'data-testid': `agent-session-more-${row.id}`,
              'aria-expanded': isMore ? 'true' : 'false',
              'aria-label': `会话操作：${title}`,
              title: '重命名 / 置顶 / 归档',
              onClick: () => {
                setMoreId(isMore ? '' : row.id);
                setRenameId('');
              },
            },
            '⋯',
          ),
      isMore && !archived
        ? h(
            'div',
            {
              'data-testid': `agent-session-actions-${row.id}`,
              style: { flex: '1 0 100%', display: 'flex', flexWrap: 'wrap', gap: '4px', padding: '2px 0 4px 2px' },
            },
            h(
              'button',
              {
                type: 'button',
                className: 'btn tiny',
                'data-testid': `agent-session-rename-${row.id}`,
                onClick: () => {
                  setRenameId(row.id);
                  setRenameText(row.title);
                },
              },
              '重命名',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'btn tiny',
                'data-testid': `agent-session-pin-${row.id}`,
                'data-pinned': row.pinned === true ? 'true' : 'false',
                onClick: () => props.onPatch(row.id, { pinned: row.pinned !== true }),
              },
              row.pinned === true ? '取消置顶' : '置顶',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'btn tiny',
                'data-testid': `agent-session-archive-${row.id}`,
                /* 运行中 → 禁用 + 说原因；不做「点了没反应」。 */
                disabled: props.busy || isRunning,
                'data-blocked': isRunning ? 'running' : 'false',
                title: isRunning
                  ? '这个会话正在生成：先停止或等它结束再归档'
                  : '归档（不删回合，随时可恢复）',
                onClick: () => props.onPatch(row.id, { archived: true }),
              },
              '归档',
            ),
          )
        : null,
      isRename && !archived
        ? h(
            'div',
            {
              'data-testid': `agent-session-rename-row-${row.id}`,
              style: { flex: '1 0 100%', display: 'flex', gap: '4px', alignItems: 'center', padding: '0 0 4px 2px' },
            },
            h('input', {
              'data-testid': `agent-session-rename-input-${row.id}`,
              type: 'text',
              value: renameText,
              maxLength: 80,
              placeholder: '会话标题（可留空）',
              style: {
                flex: '1 1 auto',
                minWidth: 0,
                height: '28px',
                padding: '0 8px',
                border: '1px solid var(--line)',
                borderRadius: '6px',
                background: 'var(--bg)',
                color: 'var(--text)',
                font: 'inherit',
                fontSize: '13px',
              },
              onChange: (event: { target: { value: string } }) => setRenameText(event.target.value),
              onKeyDown: (event: { key: string; preventDefault: () => void }) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  props.onPatch(row.id, { title: renameText });
                  setRenameId('');
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setRenameId('');
                }
              },
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'btn tiny primary',
                'data-testid': `agent-session-rename-save-${row.id}`,
                onClick: () => {
                  props.onPatch(row.id, { title: renameText });
                  setRenameId('');
                },
              },
              '保存',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'btn tiny',
                'data-testid': `agent-session-rename-cancel-${row.id}`,
                onClick: () => setRenameId(''),
              },
              '取消',
            ),
          )
        : null,
    );
  };

  return h(
    'div',
    {
      className: 'agent-sessions',
      'data-testid': 'agent-sessions-bar',
      /* B03 之前没有真续接：把口径挂在容器上，探针/判据不用读文案。 */
      'data-resumed': 'false',
      /* CS1：`data-layer="top"` = 常显四层里的第一层（顶部会话标题菜单）。 */
      'data-layer': 'top',
      /* `position:static` 把菜单的定位锚交给顶栏（.agent-head 是 relative）：
         菜单就能占满面板宽，而不是被挤在标题按钮那半行里。 */
      style: props.bare === true ? { padding: 0, flex: '1 1 auto', minWidth: 0, position: 'static' } : undefined,
      ref: boxRef,
    },
    h(
      'button',
      {
        type: 'button',
        className: 'agent-sessions-toggle chat-title',
        'data-testid': 'agent-sessions',
        'aria-expanded': open ? 'true' : 'false',
        'aria-haspopup': 'menu',
        disabled: !props.projectOpen,
        title: props.activeTitle === '' ? '当前没有选中的会话' : `当前会话：${props.activeTitle}`,
        onClick: () => {
          setOpen((previous) => !previous);
          if (!open) props.onRefresh();
        },
      },
      h(
        'span',
        {
          className: 'agent-sessions-label',
          'data-testid': 'agent-session-current',
          'data-full-title': props.activeTitle,
          'data-truncated': 'css',
          title: props.activeTitle,
        },
        h(
          'span',
          {
            'data-testid': 'agent-session-title',
            'data-full-title': props.activeTitle,
            title: props.activeTitle,
          },
          /* CS1（§3.1）：没有标题时说「新对话」，不说「会话」——后者听起来像列表入口。 */
          props.activeTitle === '' ? '新对话' : props.activeTitle,
        ),
      ),
      /* 计数与状态仍在 DOM 里（老量具还读它），视觉上收进菜单里 ——
         参考图的标题行只有标题与箭头。 */
      h(
        'span',
        {
          className: 'agent-sessions-count',
          'data-testid': 'agent-session-count',
          'data-count': String(props.sessions.length),
          'data-empty': props.sessions.length === 0 ? 'true' : 'false',
          'data-state': loadState,
          title: `${String(props.sessions.length)} 个会话`,
        },
        String(props.sessions.length),
      ),
      h('span', { className: 'agent-sessions-caret', 'aria-hidden': 'true' }, barIcon('chevron', 12)),
    ),
    open
      ? h(
          'div',
          {
            className: 'agent-sessions-menu chat-menu',
            'data-testid': 'agent-sessions-menu',
            role: 'menu',
            'aria-label': '会话',
            'data-state': loadState,
            'data-query': term,
            'data-hits': String(totalShown),
            'data-total': String(props.sessions.length + props.archived.length),
            'data-scope': 'title',
            /* CS1：菜单的包含块是顶栏（bare 把 .agent-sessions 设成 static）——
               左右贴齐面板，标题/搜索/动作不再被压成一列；`top:34` 仍从会话栏顶算。 */
            style: props.bare === true ? { left: 0, right: 0, width: 'auto' } : { left: 0, right: 'auto', width: 'min(300px, calc(100vw - 24px))' },
          },
          /* ① 新建对话（整行高亮） */
          h(
            'button',
            {
              type: 'button',
              role: 'menuitem',
              className: 'chat-menu-new',
              'data-testid': 'agent-session-new',
              disabled: props.busy,
              onClick: () => {
                props.onCreate();
                setOpen(false);
                setQuery('');
                setMoreId('');
                setRenameId('');
              },
            },
            barIcon('plus', 16),
            h('span', null, '新建对话'),
          ),
          /* ② 搜索对话…（放大镜 + 输入；清空用行内 ×） */
          h(
            'div',
            { className: 'chat-menu-search' },
            barIcon('search', 16),
            h('input', {
              'data-testid': 'agent-session-search',
              type: 'search',
              value: query,
              placeholder: '搜索对话…',
              'aria-label': '按标题搜索会话',
              onChange: (event: { target: { value: string } }) => setQuery(event.target.value),
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'chat-menu-clear',
                'data-testid': 'agent-session-search-clear',
                disabled: query === '',
                title: '清空搜索',
                'aria-label': '清空搜索',
                onClick: () => setQuery(''),
              },
              '×',
            ),
          ),
          /* ③ 分隔线（CSS）*/
          h(
            'div',
            { className: 'chat-menu-list', 'data-testid': 'agent-sessions-list' },
            props.pending === null
              ? null
              : h(
                  'button',
                  {
                    key: props.pending.id,
                    type: 'button',
                    className: 'agent-session-row is-pending chat-history-row',
                    'data-testid': `agent-session-row-${props.pending.id}`,
                    'data-pending': 'true',
                    'data-session': props.pending.id,
                    onClick: () => {
                      props.onOpen(props.pending?.id ?? '');
                      setOpen(false);
                    },
                  },
                  h('span', { className: 'chat-history-icon', 'aria-hidden': 'true' }, barIcon('chat', 16)),
                  h('span', { className: 'agent-session-title' }, props.pending.title === '' ? '新会话' : props.pending.title),
                ),
            visible.length === 0 && !searching && known && props.sessions.length === 0 && props.pending === null
              ? h('p', { className: 'agent-sessions-empty', 'data-testid': 'agent-sessions-empty' }, '还没有会话：点「新建对话」开始')
              : null,
            /* 加载失败/加载中时列表为空**不等于**没有会话：这里明确说「不知道」。 */
            known ? null : h(
              'p',
              { className: 'agent-sessions-empty', 'data-testid': 'agent-sessions-unknown', 'data-state': loadState },
              loadState === 'error' ? '会话列表没加载出来（不等于没有会话）' : '会话列表加载中…',
            ),
            visible.map((row) => rowOf(row, false)),
            searching && totalShown === 0 && known
              ? h(
                  'p',
                  { className: 'agent-sessions-empty', 'data-testid': 'agent-session-search-empty' },
                  `标题里没有「${query.trim()}」的会话（只搜标题，不搜消息内容）`,
                )
              : null,
            props.archived.length === 0
              ? null
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'chat-menu-archived-toggle',
                    'data-testid': 'agent-session-show-archived',
                    'aria-expanded': showArchived ? 'true' : 'false',
                    onClick: () => setShowArchived((previous) => !previous),
                  },
                  showArchived ? `收起已归档（${String(props.archived.length)}）` : `已归档 ${String(props.archived.length)} 条`,
                ),
            showArchived ? h('div', { 'data-testid': 'agent-session-archived-list' }, visibleArchived.map((row) => rowOf(row, true))) : null,
            showArchived && visibleArchived.length === 0 && searching && known
              ? h('p', { className: 'agent-sessions-empty', 'data-testid': 'agent-session-archived-empty' }, '已归档里没有标题命中的会话')
              : null,
          ),
          props.error === ''
            ? null
            : h('p', { className: 'agent-sessions-error', 'data-testid': 'agent-sessions-error' }, `加载失败：${props.error}`),
          props.busy
            ? h('p', { 'data-testid': 'agent-sessions-loading', className: 'chat-menu-foot' }, '加载中…')
            : null,
          /* ④ 菜单脚注：搜索范围 + 归档口径（仍在 DOM，探针照读） */
          h(
            'p',
            {
              'data-testid': 'agent-session-search-scope',
              'data-scope': 'title',
              className: 'chat-menu-foot',
            },
            `只搜标题${known ? ` · 已加载 ${String(props.sessions.length + props.archived.length)} 条${searching ? `，命中 ${String(totalShown)} 条` : ''}` : ''}`,
          ),
        )
      : null,
  );
}

/** 给父组件用：把 `ApiError` 翻成一句人话（别的错误就 String）。 */
export function sessionErrorText(error: unknown): string {
  const api = error as ApiError | null;
  if (api !== null && typeof api === 'object' && typeof api.message === 'string' && api.message !== '') return api.message;
  return error instanceof Error ? error.message : String(error);
}
