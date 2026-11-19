/**
 * 设置中心 · 智能体（CS1 · AC08 / AT14–15 · 图04 SET01–SET05）。
 *
 * ## 它回答什么
 *
 * 「本机到底有哪些 Agent、各自到哪一步、能不能用」——发现 / 桥接 / 登录 / 会话 / 编辑
 * 五层分开写，不合并成一颗绿灯（AG09、SET03）。数据来自 `GET /api/agent/roster` 的
 * **真探测**（服务端 60s 缓存），不是前端猜。
 *
 * ## 显示开关（SET04）
 *
 * `settings.agent.enabled`：`null` = 没配过（全部启用）；数组 = 白名单（`[]` = 全关）。
 * 写入口只有这里，消费者是聊天里的 Agent/模型菜单（过滤掉没启用的项）。
 * 关闭**不删**任何历史 / 安装（agent-panel 的会话与回合一条不动）。
 *
 * ## 三条诚实口径
 *
 * 1. 探测失败 ≠ 没有 Agent：`state=error` 单独一行，列表保留上次结果不冒充空。
 * 2. 「已安装」不等于「可剪辑」：`wired=false` 的行写「已装 · 未接」，不给绿色。
 * 3. 路径只读展示（来自设置卡的约定位置），本区不替用户装/登录/改全局配置。
 */

import { createElement, useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { fetchAgentRoster } from './agent-api';
import type { AgentRoster } from './agent-api';
import type { SettingsAiCard, SettingsFields } from './api';

const h = createElement;

export interface SettingsAgentsProps {
  settings: SettingsFields;
  ai: SettingsAiCard[];
  onChange: (patch: Partial<SettingsFields>) => void;
  onOpenSection: (id: string) => void;
}

/** 白名单语义：null → 全部启用；数组 → 只有里面的。 */
export function isAgentEnabled(enabled: string[] | null | undefined, id: string): boolean {
  if (enabled === null || enabled === undefined) return true;
  return enabled.includes(id);
}

/** 勾/取消后要写回的白名单（从「全部启用」切到白名单时按当前可见项展开）。 */
export function nextEnabled(enabled: string[] | null | undefined, all: string[], id: string, on: boolean): string[] {
  const base = enabled === null || enabled === undefined ? [...all] : [...enabled];
  const set = new Set(base);
  if (on) set.add(id);
  else set.delete(id);
  return all.filter((item) => set.has(item));
}

export function SettingsAgents(props: SettingsAgentsProps): ReactNode {
  const [roster, setRoster] = useState<AgentRoster | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback((refresh = false): void => {
    setBusy(true);
    setError('');
    void fetchAgentRoster(undefined, refresh)
      .then((next) => {
        setRoster(next);
        if (refresh) window.dispatchEvent(new Event('opencut:agent-roster-refreshed'));
        setState('ready');
      })
      .catch((caught: unknown) => {
        setState('error');
        setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => setBusy(false));
  }, []);

  useEffect(load, [load]);

  const enabled = props.settings.agent?.enabled ?? null;
  const agents = roster?.agents ?? [];
  const allIds = agents.map((row) => row.id);
  const enabledCount = enabled === null ? allIds.length : allIds.filter((id) => enabled.includes(id)).length;
  const status = roster?.providerStatus ?? null;
  const connectionName = status?.connection?.agentName ?? 'Codex';
  const agentsCard = props.ai.find((card) => card.id === 'agents') ?? null;

  const toggle = (id: string, on: boolean): void => {
    props.onChange({ agent: { enabled: nextEnabled(enabled, allIds, id, on) } });
    /* 设置与聊天同源：写完喊一声，聊天面板据此回读（它不轮询设置）。 */
    try {
      window.dispatchEvent(new CustomEvent('opencut:agent-settings-changed'));
    } catch {
      /* 广播失败不影响已写进去的值。 */
    }
  };

  return h(
    'div',
    { className: 'settings-group', 'data-testid': 'settings-group-agents', 'data-wired': 'true' },
    h(
      'div',
      {
        className: 'settings-card',
        'data-testid': 'settings-agents-status',
        'data-state': state,
        'data-enabled': String(enabledCount),
        'data-total': String(allIds.length),
        'data-provider-state': status?.state ?? 'UNKNOWN',
      },
      h(
        'div',
        { className: 'settings-card-head' },
        h('strong', null, '本机连接'),
        h(
          'span',
          { className: 'settings-badge', 'data-testid': 'settings-agents-real-ready', 'data-real-ready': String(status?.realModelReady === true) },
          state === 'loading' ? '正在检查…' : status?.connection?.editVerified ? '剪辑提案已验证' : status?.realModelReady ? '真实调用已验证' : status?.connection?.session ? '会话已连接' : '尚未连接',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'btn tiny',
            'data-testid': 'settings-agents-refresh',
            disabled: busy,
            onClick: () => load(true),
          },
          busy ? '正在检查…' : '刷新检查',
        ),
      ),
      // 五层分开：发现 / 桥 / 登录 / 会话 / 编辑。缺哪层写哪层，不合并。
      h(
        'details',
        { className: 'agent-connection-details', 'data-testid': 'settings-agents-layers' },
        h('summary', null, '连接详情'),
        h('span', { 'data-layer-name': 'discover' }, `本机已安装 ${agents.filter((row) => row.available && row.kind !== 'builtin').length} 个智能体程序`),
        h('span', { 'data-layer-name': 'bridge' }, `${connectionName} ACP 适配器 · ${status?.connection?.adapterVersion ?? '未连接'}`),
        h('span', { 'data-layer-name': 'login' }, `${connectionName} 登录 · ${status?.connection?.auth === 'LOGGED_IN' ? '已登录' : status?.connection?.auth === 'LOGGED_OUT' ? '需要登录' : '未知'}`),
        h('span', { 'data-layer-name': 'session' }, status?.connection?.session ? '已建立本机会话' : `尚未建立会话${status?.connection?.reason ? ' · ' + status.connection.reason : ''}`),
        h('span', { 'data-layer-name': 'edit' }, status?.connection?.editVerified ? '已收到通过校验的剪辑提案' : '尚无已验证的剪辑提案'),
      ),
      state === 'error'
        ? h('p', { className: 'settings-note', 'data-testid': 'settings-agents-error', 'data-state': 'error' }, `探测失败：${error}`)
        : null,
    ),

    h(
      'div',
      { className: 'settings-group', 'data-testid': 'settings-agent-list' },
      h(
        'div',
        { className: 'settings-card-head' },
        h('strong', null, '你的智能体'),
        h(
          'button',
          {
            type: 'button',
            className: 'btn tiny',
            'data-testid': 'settings-agents-enable-all',
            disabled: enabled === null,
            title: '清除白名单：全部启用（新装 Agent 也默认可见）',
            onClick: () => {
              props.onChange({ agent: { enabled: null } });
              try {
                window.dispatchEvent(new CustomEvent('opencut:agent-settings-changed'));
              } catch {
                /* 同上。 */
              }
            },
          },
          '全部启用',
        ),
      ),
      agents.length === 0 && state !== 'ready'
        ? h('p', { className: 'settings-note' }, state === 'error' ? '列表没加载出来（不等于没有 Agent）' : '正在探测…')
        : null,
      ...[...agents].sort((a, b) => Number(b.wired) - Number(a.wired) || Number(b.available) - Number(a.available) || Number(b.id === 'codex') - Number(a.id === 'codex')).map((row) => {
        /* CS2（C03/U04）：每个 Agent 行只有一个**互斥**主状态：
             未安装（探测不到） / 已装·未接（装着但没有场景生成桥） / 已接入。
           旧文案把「未发现」和「已装·未接」拼在同一行（未发现 · 已装·未接），
           两句话互相打脸；这里按 available/wired 二轴选出**一条**，不再叠加。 */
        const primary = !row.available
          ? ({ id: 'missing', text: '未发现', hint: '本机没有找到可执行文件（未安装，或不在标准位置）' } as const)
          : row.wired
            ? ({ id: 'wired', text: '已接入', hint: '能接场景生成；能不能编辑仍要真实调用验证' } as const)
            : ({ id: 'installed', text: '已装·未接', hint: '安装存在，但本版没有场景生成/会话桥' } as const);
        return h(
          'div',
          {
            key: row.id,
            className: 'settings-row settings-agent-row',
            'data-testid': `settings-agent-row-${row.id}`,
            'data-enabled': String(isAgentEnabled(enabled, row.id)),
            'data-available': String(row.available),
            'data-wired': String(row.wired),
            'data-primary-state': primary.id,
          },
          h(
            'div',
            { className: 'settings-row-label' },
            h('span', { title: row.id }, row.id === 'codex' ? 'Codex' : row.label),
            h(
              'small',
              { title: `${primary.hint}${row.version === undefined || row.version === '' ? '' : ` · 版本 ${row.version}`}` },
              row.available && !row.wired ? row.note : primary.text,
            ),
          ),
          h(
            'div',
            { className: 'settings-row-control' },
            h('label', { className: 'agent-visibility', title: '在对话中显示' }, [
              h('input', {
                key: 'toggle',
                type: 'checkbox',
                'aria-label': `在对话中显示 ${row.label}`,
                'data-testid': `settings-agent-enabled-${row.id}`,
                checked: isAgentEnabled(enabled, row.id),
                onChange: (event: { target: { checked: boolean } }) => toggle(row.id, event.target.checked),
              }),
            ]),
          ),
        );
      }),
      h(
        'p',
        { className: 'settings-note', 'data-testid': 'settings-agents-note' },
        `已启用 ${String(enabledCount)} / ${String(allIds.length)} 个智能体。可在对话框下方选择已连接的模型。`,
      ),
    ),

    h(
      'div',
      { className: 'settings-group', 'data-testid': 'settings-agents-paths' },
      h('div', { className: 'settings-card-head' }, h('strong', null, '程序与诊断')),
      /* CS3（R-F04 / AT14）：**绝对路径不再常驻这一页**。
         截图 SET01–SET05 里这一屏只回答「连没连上」；路径属于「诊断」那种要复制给别人的信息。
         这一页只留结论 + 一个入口，路径本体与复制位在「诊断」里（`settings-agents-path` 搬过去了）。 */
      h(
        'p',
        { className: 'settings-note', 'data-testid': 'settings-agents-pathnote' },
        agentsCard?.exists === true ? '在诊断中查看程序路径和连接版本。' : '诊断中可查看程序搜索路径。',
      ),
      h(
        'button',
        { type: 'button', className: 'btn tiny', 'data-testid': 'settings-agents-open-diagnostics', onClick: () => props.onOpenSection('diagnostics') },
        '打开诊断（路径与复制）',
      ),
    ),
  );
}
