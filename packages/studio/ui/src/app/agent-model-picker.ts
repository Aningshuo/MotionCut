/**
 * Agent 底部模型选择（R114 · L3 · 验收 LI-A32 / LI-F38）。
 *
 * ## 为什么它必须是下拉而不是 chip
 *
 * 之前那颗 chip 是**只读 span**：写死 `mock`，点了没反应。用户看不到「我现在用的是
 * 哪个 Agent / provider / 模型」，也没法换。这里把它做成真的选择器，数据来自
 * `GET /api/agent/roster`（真实 provider + 真实 CLI 探测）。
 *
 * ## 三条诚实口径
 *
 * 1. **不在名册里的不显示成可用**：选择器的每一项都来自 roster；`wired:false` 的
 *    Agent（探测到但没接场景生成）与不支持的思考/速度是**禁用行**，并写明原因。
 * 2. **选完真的进请求**：`onSelect` 只改本地状态，真正生效以服务端 `selection`
 *    回读为准 —— 菜单底部显示「已生效：…」，那是响应里的值，不是本地自说自话。
 * 3. **失败不偷偷换模型**：请求被拒（`MODEL_UNAVAILABLE` / `OPTION_UNSUPPORTED`）
 *    时保留用户选的那一项并标红，**不回退到 mock**，也不转 mock 假装成功。
 * 4. **按 capabilities 禁用**：思考/速度这两行看的是**当前选中模型**声明的能力
 *    （`model.thinking` / `model.speed` 空数组 = 不支持），不是全局开关。
 */

import { createElement, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { AgentCapability, AgentRoster, AgentSelection } from './agent-api';
import type { ModelScope } from './agent-session-model';

const h = createElement;

export interface AgentModelPickerProps {
  roster: AgentRoster | null;
  rosterError: string;
  rosterBusy: boolean;
  selection: AgentSelection | null;
  /** 服务端回读的选择（响应里的 `selection`）。null = 还没成功过一次。 */
  applied: AgentSelection | null;
  /** 上一次请求被拒的原因（'' = 没有）。 */
  rejected: string;
  disabled: boolean;
  onSelect: (next: AgentSelection) => void;
  onReload: () => void;
  /** R157（M18）：这份选择来自哪一级（会话 > 工程 > 全局 > 名册）。 */
  scope: ModelScope;
  /** 这条会话自己的选择（空串 = 没选过）。菜单里要能说清「会话 vs 工程」。 */
  sessionModel: string;
  projectModel: string;
  /** 清掉本会话的选择（回落工程/全局）。 */
  onClearSession: () => void;
  /** 宿主已有的连接状态披露；只迁移展示位置，不复制状态。 */
  details?: ReactNode;
  /** 仅在宿主提供真实设置入口时显示齿轮。 */
  onOpenSettings?: () => void;
}

/** 选中的模型（找不到就 null）——chip 与状态行都按它显示。 */
export function selectedModelOf(roster: AgentRoster | null, selection: AgentSelection | null) {
  if (roster === null || selection === null) return null;
  const provider = roster.providers.find((row) => row.id === selection.provider) ?? null;
  if (provider === null) return null;
  const model = provider.models.find((row) => row.id === selection.model) ?? null;
  return { provider, model };
}

export function AgentModelPicker(props: AgentModelPickerProps): ReactNode {
  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState<'model' | 'thinking' | 'speed' | null>(null);
  const boxRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target === null || boxRef.current?.contains(target) === true) return;
      setOpen(false);
      setSubmenu(null);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      // 宿主披露区可先消费 Esc；这里仅关闭当前最上层。
      if (event.defaultPrevented || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (submenu !== null) setSubmenu(null);
      else setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, submenu]);

  const picked = selectedModelOf(props.roster, props.selection);
  const chipText = props.selection !== null && props.roster && !picked?.model ? '选择可用模型' : props.selection === null ? (props.rosterBusy ? '正在连接…' : '选择智能体') : picked !== null && picked.provider.mock !== true
    ? (picked.model?.label?.trim() || picked.model?.id || props.selection?.provider || 'mock')
    : (props.selection?.provider ?? 'mock');
  const thinkingLabel = picked?.model?.thinking?.find((item) => item.id === props.selection?.thinking)?.label ?? '';
  const chipReasoning = thinkingLabel !== '' && !chipText.endsWith(thinkingLabel) ? thinkingLabel : '';
  const chipTitle = props.roster === null
    ? '还没有拿到名册（点开可重试）'
    : picked === null
      ? `provider：${props.selection?.provider ?? 'mock'}`
      : `Agent：${props.selection?.agent ?? ''} · provider：${picked.provider.label} · 模型：${picked.model?.label ?? '未声明'}`;
  const baseSelection = (): AgentSelection => props.selection ?? {
    agent: props.roster?.defaults.agent ?? 'local-scene',
    provider: props.roster?.defaults.provider ?? 'mock',
    model: props.roster?.defaults.model ?? null,
    thinking: props.roster?.defaults.thinking ?? null,
    speed: props.roster?.defaults.speed ?? null,
  };
  const apply = (patch: Partial<AgentSelection>, close = true): void => {
    props.onSelect({ ...baseSelection(), ...patch });
    if (close) {
      setOpen(false);
      setSubmenu(null);
    }
  };
  const choose = (patch: Partial<AgentSelection>): void => apply(patch);
  const roster = props.roster;
  // 原有名册的默认展示规则不变；请求及持久化仍由 selection 负责。
  const provider = roster === null ? null : (roster.providers.find((row) => row.id === props.selection?.provider) ?? roster.providers[0] ?? null);
  const model = provider === null ? null : (provider.models.find((row) => row.id === props.selection?.model) ?? provider.models[0] ?? null);
  const modelCount = roster === null ? 0 : roster.providers.reduce((sum, row) => sum + row.models.length, 0);
  const rosterEmpty = roster !== null && modelCount === 0;
  const thinkingSupported = (model?.thinking?.length ?? 0) > 0;
  const speedSupported = (model?.speed?.length ?? 0) > 0;
  const rowStyle = (active: boolean, disabled: boolean): Record<string, string | number> => ({
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
    width: '100%', minHeight: '28px', padding: '4px 8px',
    border: '1px solid transparent', borderRadius: '6px',
    background: active ? 'var(--accent-soft)' : 'transparent',
    color: disabled ? 'var(--text-mute)' : 'var(--text)', font: 'inherit',
    fontSize: '13px', fontWeight: 400, lineHeight: 1.5, letterSpacing: 0,
    textAlign: 'left', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1,
  });
  const toggle = (next: 'model' | 'thinking' | 'speed'): void => setSubmenu((previous) => previous === next ? null : next);
  const capabilityLabel = (values: AgentCapability[], current: string | null): string => {
    const chosen = values.find((value) => value.id === current);
    return chosen === undefined ? (current ?? '默认') : (chosen.label || chosen.id);
  };
  const dimension = (id: 'thinking' | 'speed', label: string, values: AgentCapability[], current: string | null): ReactNode => {
    if (values.length === 0) return null;
    return h('div', { className: 'agent-model-subgroup' },
      h('button', {
        type: 'button', className: 'agent-model-option', role: 'menuitem',
        'data-testid': `agent-model-${id}`, 'data-supported': 'true',
        'aria-expanded': submenu === id ? 'true' : 'false', 'aria-controls': `agent-model-${id}-options`,
        style: rowStyle(false, false), onClick: () => toggle(id),
      }, h('span', null, label), h('span', { className: 'agent-model-option-value' }, h('span', { className: 'agent-model-current-label' }, capabilityLabel(values, current)), h('span', { className: 'agent-model-chevron chat-model-caret', 'aria-hidden': 'true' }))),
      submenu === id ? h('div', { className: 'agent-model-submenu', id: `agent-model-${id}-options`, role: 'group', 'aria-label': label },
        ...values.map((value) => h('button', {
          key: value.id, type: 'button', className: 'agent-model-suboption',
          'data-testid': `agent-model-${id}-${value.id}`,
          'data-active': current === value.id ? 'true' : 'false',
          'aria-pressed': current === value.id ? 'true' : 'false',
          title: `设成 ${value.label || value.id}`, style: rowStyle(current === value.id, false),
          onClick: () => apply(id === 'thinking' ? { thinking: value.id } : { speed: value.id }, false),
        }, value.label || value.id))) : null,
    );
  };

  // 未安装的选项仍保留原有禁用状态与说明，只移入详情，避免撑满常用菜单。
  const primaryAgents = roster?.agents.filter((agent) => agent.available || agent.wired || props.selection?.agent === agent.id) ?? [];
  const otherAgents = roster?.agents.filter((agent) => !primaryAgents.includes(agent)) ?? [];
  const agentRow = (agent: AgentRoster['agents'][number]): ReactNode => h('button', {
        key: `agent-${agent.id}`, type: 'button', role: 'menuitem', className: 'agent-model-agent-row',
        'data-testid': `agent-model-agent-${agent.id}`, 'data-available': agent.available ? 'true' : 'false',
        'data-wired': agent.wired ? 'true' : 'false', disabled: agent.wired !== true, title: agent.note ?? '',
        style: rowStyle(props.selection?.agent === agent.id, agent.wired !== true),
        onClick: () => {
          const target = roster?.providers.find((item) => item.available && (item.agentId ?? roster.defaults.agent) === agent.id);
          if (!agent.wired || !target) return;
          const first = target.models.find((item) => item.default) ?? target.models[0];
          if (first) choose({ agent: agent.id, provider: target.id, model: first.id, thinking: first.thinking[0]?.id ?? null, speed: first.speed[0]?.id ?? null });
        },
      }, h('span', { className: 'agent-model-agent-name' }, agent.id.toLowerCase() === 'codex' ? h('span', { className: 'chat-agent-brand', 'aria-hidden': 'true' }) : null, agent.label.replace(/\s+CLI$/i, '')),
        h('span', { className: 'agent-model-agent-state' }, agent.wired ? (props.selection?.agent === agent.id ? '✓' : '') : agent.available ? '未接入' : '未安装'));

  return h('span', { ref: boxRef, className: 'agent-model-picker', style: { position: 'static', display: 'inline-flex', minWidth: 0 } },
    h('button', {
      type: 'button', className: 'agent-model-chip', 'data-testid': 'agent-model-chip',
      'data-provider': props.selection?.provider ?? 'mock', 'data-model': props.selection?.model ?? '',
      'data-selection-state': props.rejected !== '' ? 'rejected' : props.applied === null ? 'pending' : 'applied',
      'aria-haspopup': 'menu', 'aria-expanded': open ? 'true' : 'false', title: chipTitle, disabled: props.disabled,
      style: { fontFamily: 'inherit', fontSize: '12.5px', fontWeight: 500, cursor: props.disabled ? 'not-allowed' : 'pointer', borderStyle: 'solid' },
      onClick: () => {
        setOpen((previous) => !previous);
        setSubmenu(null);
        if (!open && roster === null) props.onReload();
      },
    }, props.selection?.agent.toLowerCase() === 'codex' ? h('span', { className: 'chat-agent-brand', 'aria-hidden': 'true' }) : null, h('span', { className: 'agent-model-label' }, chipText, chipReasoning === '' ? null : h('span', { className: 'agent-model-reasoning' }, ` ${chipReasoning}`))),
    open ? h('div', {
      className: 'agent-model-menu', 'data-testid': 'agent-model-menu', role: 'menu', 'aria-label': '模型与思考强度',
      'data-roster-state': props.rosterBusy ? 'loading' : props.rosterError !== '' ? 'error' : roster === null ? 'idle' : rosterEmpty ? 'empty' : 'ready',
      'data-roster-models': String(modelCount),
      style: {
        position: 'absolute', left: 0, right: 'auto', bottom: 'calc(100% + 4px)', zIndex: 30,
        width: '236px', maxWidth: '100%', maxHeight: 'min(480px, 70vh)', overflowY: 'auto', overflowX: 'hidden',
        display: 'flex', flexDirection: 'column', gap: '2px', padding: '8px',
        border: '1px solid var(--border-strong)', borderRadius: '16px', background: 'var(--panel-2)',
        boxShadow: '0 16px 40px -8px rgba(0, 0, 0, 0.4), 0 4px 12px rgba(0, 0, 0, 0.18)',
      },
    },
      h('div', { className: 'agent-model-menu-head' },
        h('span', { className: 'agent-model-menu-heading' }, '智能体'),
        typeof props.onOpenSettings === 'function' ? h('button', {
          type: 'button', className: 'agent-model-settings', 'aria-label': '打开智能体设置', title: '智能体设置',
          onClick: () => { setOpen(false); setSubmenu(null); props.onOpenSettings?.(); },
        }, h('span', { className: 'agent-model-settings-icon chat-model-settings-icon', 'aria-hidden': 'true' })) : null,
      ),
      props.rosterBusy ? h('p', { 'data-testid': 'agent-model-loading', className: 'agent-model-note' }, '读取名册…') : null,
      props.rosterError === '' ? null : h('div', { 'data-testid': 'agent-model-error', className: 'agent-model-error' },
        h('span', null, `名册加载失败：${props.rosterError}`),
        h('button', { type: 'button', className: 'btn tiny', 'data-testid': 'agent-model-reload', onClick: () => props.onReload() }, '重试')),
      rosterEmpty ? h('div', { 'data-testid': 'agent-model-empty', className: 'agent-model-note' },
        h('p', null, '名册里没有可用模型'),
        h('button', { type: 'button', className: 'btn tiny', 'data-testid': 'agent-model-reload', onClick: () => props.onReload() }, '重新读取')) : null,
      roster === null || rosterEmpty ? null : h('div', { className: 'agent-model-agents' }, ...primaryAgents.map(agentRow)),
      roster === null || rosterEmpty ? null : h('div', { className: 'agent-model-controls' },
        provider === null || provider.models.length === 0
          ? h('p', { 'data-testid': 'agent-model-none', className: 'agent-model-note' }, provider?.note ?? '这个连接没有声明模型')
          : h('div', { className: 'agent-model-subgroup' },
              h('button', { type: 'button', role: 'menuitem', className: 'agent-model-option', 'data-testid': 'agent-model-options-toggle',
                'aria-expanded': submenu === 'model' ? 'true' : 'false', 'aria-controls': 'agent-model-options',
                style: rowStyle(false, false), onClick: () => toggle('model'),
              }, h('span', null, '模型'), h('span', { className: 'agent-model-option-value' }, h('span', { className: 'agent-model-current-label' }, model?.label || model?.id || '未选择'), h('span', { className: 'agent-model-chevron chat-model-caret', 'aria-hidden': 'true' }))),
              submenu === 'model' ? h('div', { id: 'agent-model-options', className: 'agent-model-submenu', role: 'group', 'aria-label': '模型' },
                ...provider.models.map((row) => h('button', {
                  key: `model-${row.id}`, type: 'button', role: 'menuitem', className: 'agent-model-suboption',
                  'data-testid': `agent-model-model-${row.id}`, title: row.id, style: rowStyle(props.selection?.model === row.id, false),
                  onClick: () => choose({ model: row.id, thinking: row.thinking[0]?.id ?? null, speed: row.speed[0]?.id ?? null }),
                }, row.label || row.id))) : null,
            ),
        h('div', { 'data-testid': 'agent-model-dimensions', className: 'agent-model-dimensions' },
          dimension('thinking', '思考强度', model?.thinking ?? [], props.selection?.thinking ?? null),
          dimension('speed', '速度', model?.speed ?? [], props.selection?.speed ?? null)),
      ),
      h('details', { className: 'agent-model-connection', 'data-testid': 'agent-model-connection' },
        h('summary', null, '连接详情'),
        props.details ?? null,
        rosterEmpty || otherAgents.length === 0 ? null : h('div', { className: 'agent-model-other-agents' },
          h('p', { className: 'agent-model-note' }, `未安装的智能体（${otherAgents.length}）`),
          ...otherAgents.map(agentRow)),
        roster === null ? null : h('div', { className: 'agent-model-provider-list', 'aria-label': '连接服务' }, ...roster.providers.map((row) => h('button', {
          key: `provider-${row.id}`, type: 'button', role: 'menuitem', className: 'agent-model-provider-row',
          'data-testid': `agent-model-provider-${row.id}`, 'data-available': row.available ? 'true' : 'false',
          disabled: row.available !== true, title: row.note, style: rowStyle(props.selection?.provider === row.id, row.available !== true),
          onClick: () => {
            if (row.available !== true) return;
            const first = row.models.find((item) => item.default) ?? row.models[0];
            if (first) choose({ agent: row.agentId ?? roster.defaults.agent, provider: row.id, model: first.id,
              thinking: first.thinking[0]?.id ?? null, speed: first.speed[0]?.id ?? null });
          },
        }, h('span', null, row.label), h('span', { className: 'agent-model-detail-meta' }, row.mock ? 'mock' : row.available ? '就绪' : '不可用')))),
        roster === null || rosterEmpty ? null : h('div', { className: 'agent-model-capability-notes' },
          thinkingSupported ? null : h('p', { 'data-testid': 'agent-model-thinking', 'data-supported': 'false' }, '当前模型未声明思考强度选项'),
          speedSupported ? null : h('p', { 'data-testid': 'agent-model-speed', 'data-supported': 'false' }, '当前模型未声明速度选项')),
        roster === null ? null : h('div', { 'data-testid': 'agent-model-scope', 'data-scope': props.scope,
          'data-session-model': props.sessionModel, 'data-project-model': props.projectModel, className: 'agent-model-scope' },
          h('span', null, `本次生效：${props.scope === 'session' ? `会话级（${props.sessionModel || '—'}）` : props.scope === 'project' ? '工程选择' : props.scope === 'global' ? '全局默认' : '名册默认'}`),
          h('span', null, `本会话 ${props.sessionModel || '—'} · 工程 ${props.projectModel || '—'}（会话 > 工程 > 全局 > 名册）`),
          props.scope === 'session' ? h('button', { type: 'button', className: 'btn tiny', 'data-testid': 'agent-model-session-reset', onClick: () => props.onClearSession() }, '用工程默认（清掉本会话）') : null),
        roster === null ? null : h('p', { 'data-testid': 'agent-model-echo', 'data-applied': props.applied === null ? 'false' : 'true', className: 'agent-model-note' },
          props.applied === null ? '还没发过请求：选完会在下一次生成时进入请求并回读' : `已生效：${props.applied.provider} / ${props.applied.model ?? '未声明模型'}`),
      ),
      props.rejected === '' ? null : h('p', { 'data-testid': 'agent-model-rejected', role: 'alert', className: 'agent-model-error' }, `上一次请求被拒：${props.rejected}（没有自动换模型，也没有转 mock）`),
    ) : null,
  );
}
