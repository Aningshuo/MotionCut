/**
 * 设置中心 · 聊天模型（CS1 · AC09/AC10 · 图03 CHAT07、图05 SET07）。
 *
 * ## 一件事：把「设置默认」接到真实的四级 scope 上
 *
 * 面板已经有一套既有合同（`agent-session-model.ts`）：
 *
 *   会话 > 工程 > 全局默认 > 名册默认
 *
 * 本区写的是**全局默认**（`opencut.agent.default.v1`）——与聊天气泡里那颗 chip 写
 * 工程/会话是**同一份存储的两个写入口**，谁写完都发 `opencut:agent-model-changed`，
 * 聊天面板据此回读。设置不复制一份「自己的默认」，否则同一件事会有两个真相。
 *
 * ## 三条诚实口径
 *
 * 1. 模型目录来自 `/api/agent/roster`（真实会话名册），空/失败分得开；不硬编码型号。
 * 2. 推理档/速度**按模型支持显示**（`thinking`/`speed` 为空就不出现），不伪造「思考中」。
 * 3. 「已设为默认」只是写进本机存储；真正生效要等请求回读（chip 的 `data-model-echo`）。
 */

import { createElement, useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { fetchAgentRoster } from './agent-api';
import type { AgentRoster, AgentRosterModel, AgentSelection } from './agent-api';
import { DEFAULT_MODEL_STORE_KEY, notifyModelChange, readGlobalDefault, readSessionModelStore } from './agent-session-model';
import { PROJECT_MODEL_STORE_KEY, readSelectionMap } from './agent-session-model';
import type { SettingsFields } from './api';

const h = createElement;

export interface SettingsModelsProps {
  settings: SettingsFields;
  onChange: (patch: Partial<SettingsFields>) => void;
}

function selectionOf(agent: string, provider: string, model: AgentRosterModel): AgentSelection {
  return {
    agent,
    provider,
    model: model.id,
    thinking: model.thinking[0]?.id ?? null,
    speed: model.speed[0]?.id ?? null,
  };
}

/** 把一条 selection 写成一行人话（探针/截图都能对）。 */
export function describeSelection(selection: AgentSelection | null): string {
  if (selection === null) return '未设置';
  return `${selection.agent} / ${selection.provider} / ${selection.model ?? '未声明模型'}${
    selection.thinking === null ? '' : ` · 推理 ${selection.thinking}`
  }${selection.speed === null ? '' : ` · 速度 ${selection.speed}`}`;
}

export function SettingsModels(props: SettingsModelsProps): ReactNode {
  const [roster, setRoster] = useState<AgentRoster | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  const load = useCallback((): void => {
    setState('loading');
    setError('');
    void fetchAgentRoster()
      .then((next) => {
        setRoster(next);
        setState('ready');
      })
      .catch((caught: unknown) => {
        setState('error');
        setError(caught instanceof Error ? caught.message : String(caught));
      });
  }, []);

  useEffect(load, [load]);

  const globalDefault = readGlobalDefault();
  const sessionCount = Object.keys(readSessionModelStore()).length;
  const projectCount = Object.keys(readSelectionMap(PROJECT_MODEL_STORE_KEY)).length;
  /* 目录**不按显示开关过滤**：设置是配置面，关掉的 Agent 仍要能在这里被审视/设默认；
     「菜单里隐藏」是聊天侧的消费者（agent-panel 用 agent.enabled 过滤名册）。 */
  const providers = roster?.providers ?? [];

  const setDefault = (row: { agent: string; provider: string; model: AgentRosterModel }): void => {
    const selection = selectionOf(row.agent, row.provider, row.model);
    try {
      localStorage.setItem(DEFAULT_MODEL_STORE_KEY, JSON.stringify(selection));
      notifyModelChange('global', '');
      setSaved(`已设为全局默认：${describeSelection(selection)}（新会话与没覆盖过的工程用它）`);
    } catch {
      setSaved('写不进去（浏览器存储被禁用）：默认没有改变');
    }
  };

  return h(
    'div',
    { className: 'settings-group', 'data-testid': 'settings-group-chat-models', 'data-wired': 'true' },
    h(
      'details',
      {
        className: 'settings-card settings-scopes',
        'data-testid': 'settings-models-scopes',
        'data-scope-global': globalDefault === null ? '' : `${globalDefault.agent}|${globalDefault.provider}|${globalDefault.model ?? ''}`,
        'data-scope-project-count': String(projectCount),
        'data-scope-session-count': String(sessionCount),
        'data-roster-state': state,
        'data-default-open': 'false',
      },
      /* CS2（C04/U06）：四层 scope 是**解释**，不是每次都要看的表单 —— 默认折叠，
         摘要只写「现在实际用哪一个」，展开才看到 ①②③④ 与术语。 */
      h(
        'summary',
        { className: 'settings-scopes-summary' },
        h('strong', null, '生效范围'),
        h('span', { className: 'settings-badge', 'data-testid': 'settings-models-effective' }, describeSelection(globalDefault)),
      ),
      h('p', { className: 'settings-note' }, `① 全局默认（设置写这里）：${describeSelection(globalDefault)}`),
      h('p', { className: 'settings-note', 'data-testid': 'settings-models-scope-project' }, `② 工程覆盖：${String(projectCount)} 条（聊天气泡的模型 chip 写；设置不覆盖它）`),
      h('p', { className: 'settings-note', 'data-testid': 'settings-models-scope-session' }, `③ 会话覆盖：${String(sessionCount)} 条（同上，只影响那条会话）`),
      h('p', { className: 'settings-note' }, `④ 名册默认：${describeSelection(roster?.defaults ?? null)}`),
      h(
        'p',
        { className: 'settings-note' },
        '优先级：会话 > 工程 > 全局（本页写这里）> 名册默认。这里改的是「以后用哪个」，不改进在跑的 turn。',
      ),
      saved === '' ? null : h('p', { className: 'settings-note', 'data-testid': 'settings-models-saved' }, saved),
      state === 'error' ? h('p', { className: 'settings-note', 'data-testid': 'settings-models-error' }, `名册加载失败：${error}`) : null,
      state === 'loading' ? h('p', { className: 'settings-note' }, '正在读真实会话名册…') : null,
      h(
        'div',
        { style: { display: 'flex', justifyContent: 'flex-start' } },
        h('button', { type: 'button', className: 'btn tiny', 'data-testid': 'settings-models-refresh', onClick: load }, '重新读名册'),
      ),
    ),

    h(
      'div',
      { className: 'settings-group', 'data-testid': 'settings-models-list', 'data-providers': String(providers.length) },
      h('div', { className: 'settings-card-head' }, h('strong', null, '模型目录（来自真实名册）')),
      providers.length === 0 && state === 'ready'
        ? h('p', { className: 'settings-note', 'data-testid': 'settings-models-empty' }, '名册里没有任何 provider：这台机器上还没有可用的模型宿主。')
        : null,
      ...providers.flatMap((provider) =>
        provider.models.length === 0
          ? [
              h(
                'p',
                { key: `${provider.id}-none`, className: 'settings-note', 'data-testid': `settings-model-empty-${provider.id}` },
                `${provider.label}：没有返回模型目录（未就绪；不填占位型号）`,
              ),
            ]
          : provider.models.map((model) =>
              h(
                'div',
                {
                  key: `${provider.id}-${model.id}`,
                  className: 'settings-row',
                  'data-testid': `settings-model-${provider.id}-${model.id}`,
                  'data-thinking': model.thinking.map((item) => item.id).join(','),
                  'data-speed': model.speed.map((item) => item.id).join(','),
                },
                h(
                  'div',
                  { className: 'settings-row-label' },
                  h('span', null, `${model.label}（${model.id}）`),
                  h(
                    'small',
                    null,
                    `${provider.label}${model.note === undefined || model.note === '' ? '' : ` · ${model.note}`}${
                      model.thinking.length === 0 ? ' · 不支持推理档' : ` · 推理：${model.thinking.map((item) => item.label).join(' / ')}`
                    }${model.speed.length === 0 ? '' : ` · 速度：${model.speed.map((item) => item.label).join(' / ')}`}`,
                  ),
                ),
                h(
                  'div',
                  { className: 'settings-row-control' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'btn tiny',
                      'data-testid': `settings-model-default-${provider.id}-${model.id}`,
                      title: '写成全局默认：新会话与没覆盖过的工程用它（不改变在跑的 turn）',
                      onClick: () =>
                        setDefault({
                          /* Agent 取自名册：默认 → 第一个已接线的 → 第一个存在的；没有就空着（服务端会回拒绝，不编 id）。 */
                          agent:
                            provider.agentId ?? roster?.defaults.agent ??
                            roster?.agents.find((row) => row.wired)?.id ??
                            roster?.agents[0]?.id ??
                            '',
                          provider: provider.id,
                          model,
                        }),
                    },
                    '设为全局默认',
                  ),
                ),
              ),
            ),
      ),
      h(
        'p',
        { className: 'settings-note' },
        '设置默认不修改正在执行的 turn（AT19）；会话/工程覆盖在聊天气泡的 chip 里改，两处是同一份存储。',
      ),
    ),
  );
}
