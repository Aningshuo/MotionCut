/**
 * 设置中心 ·「自有密钥」（BYOK）。CS1（AC11 / AT20–22 · 图05 SET06–SET08）。
 *
 * ## 两半，分开存
 *
 * | 存什么 | 存在哪 | 谁写 |
 * |---|---|---|
 * | 显示名称 / API 格式 / Base URL / 模型 ID / 推理档 / 上下文 | `settings.json` 的 `byok` 分区 | 本组件 `onChange`（宿主防抖） |
 * | Key 原文 | `<settings 目录>/keys/model.enc`（AES-256-GCM） | `/api/settings/model-key`（一次性提交） |
 *
 * Key 永远不进 `settings.json`：那是一份用户会打开、会贴进工单的文本文件。设置里只显示
 * 尾 4 位。
 *
 * ## 三种协议不是换 URL
 *
 * `format` 对应 `packages/providers/client.mjs#WIRES` 的三条 wire，端点/认证头/流事件/
 * 工具调用各不相同（见下面的对照表）。`modelEndpoint()` 读这里的 `format/baseUrl/model`，
 * `/api/settings/model-key/check` 用它真的发一次请求 —— 这就是「设置 → 请求」的消费者。
 *
 * ## 三条硬约束（沿用 S104）
 *
 * 1. Key 不进 DOM 的第二处：输入框是唯一草稿，保存成功立刻清空，只显示尾 4 位。
 * 2. 不在前端拦空串：拒绝必须来自服务端（`KEY_EMPTY`），否则负向测不到。
 * 3. 「测试连接」只证明「填了 key → 请求头带上 → 服务端回 200」；不写「真实厂商已验证」。
 */

import { createElement, useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { ApiError, checkModelKey, deleteModelKey, getModelKey, putModelKey } from './api';
import type { ModelKeyStatus, SettingsFields } from './api';

const h = createElement;

/** 三条 wire 的**可核对差异**（每条来自 packages/providers/wire-*.mjs 的实际代码）。 */
export const BYOK_ADAPTERS = Object.freeze([
  {
    id: 'openai-chat',
    label: 'OpenAI Chat Completions',
    path: 'POST {base}/chat/completions',
    auth: 'Authorization: Bearer',
    stream: 'data: {choices[].delta} + [DONE]',
    tools: 'tools / tool_calls（流式增量）',
    control: '取消：AbortSignal 关连接 · 429/5xx：Retry-After 重试（≤3 次）',
    note: '兼容面最广',
  },
  {
    id: 'openai-responses',
    label: 'OpenAI Responses',
    path: 'POST {base}/responses',
    auth: 'Authorization: Bearer',
    stream: 'response.output_text.delta 等事件',
    tools: 'function_call / function_call_output',
    control: '取消：AbortSignal 关连接 · 429/5xx：Retry-After 重试（≤3 次）',
    note: '与 Chat Completions 是两条端点、两种事件形状',
  },
  {
    id: 'anthropic-messages',
    label: 'Anthropic Messages',
    path: 'POST {base}/messages',
    auth: 'x-api-key + anthropic-version',
    stream: 'message_start / content_block_delta',
    tools: 'tool_use / tool_result block',
    control: '取消：AbortSignal 关连接 · 429/5xx：Retry-After 重试（≤3 次）',
    note: '鉴权头与工具块形状都与 OpenAI 不同',
  },
]);

/** 一行：左标签 + 右控件 + 可选说明（与设置中心其它分区的排版一致）。 */
function row(label: string, control: ReactNode, hint?: string): ReactNode {
  return h(
    'div',
    { className: 'settings-row', key: label },
    h('div', { className: 'settings-row-label' }, h('span', null, label), hint === undefined ? null : h('small', null, hint)),
    h('div', { className: 'settings-row-control' }, control),
  );
}

/** 服务端错误 → 机器可读的原因（优先 code，其次 message/HTTP 状态）。 */
function reasonOf(error: unknown): string {
  if (error instanceof ApiError) return error.code;
  const raw = error instanceof Error ? error.message : String(error);
  return raw.slice(0, 80);
}

/** 三态文案（导出让单测/验收能对照同一份规则）。 */
export function modelKeyStatusText(status: ModelKeyStatus | null, failure: string): string {
  if (failure !== '') return `保存失败（${failure}）`;
  if (status === null) return '…';
  if (typeof status.issue === 'string' && status.issue !== '') return `读取失败（${status.issue}）`;
  if (status.configured === true) return `已配置 sk-****${String(status.tail ?? '')}`;
  return '未配置';
}

type ByokFields = NonNullable<SettingsFields['byok']>;

/** 缺省 = 服务端 `byok` 分区的初值（UI 只做展示与补丁，不另立一套默认）。 */
const BYOK_DEFAULTS: ByokFields = {
  name: '',
  format: 'openai-chat',
  baseUrl: '',
  model: '',
  reasoning: 'auto',
  contextTokens: 0,
};

export interface ModelKeyPanelProps {
  settings?: SettingsFields;
  onChange?: (patch: Partial<SettingsFields>) => void;
  /** 测试连接成功后把「成功」交给宿主显示（可选；本分区自己也会显示一行）。 */
  onChecked?: (ok: boolean) => void;
}

export function ModelKeyPanel(props: ModelKeyPanelProps): ReactNode {
  const [status, setStatus] = useState<ModelKeyStatus | null>(null);
  const [draft, setDraft] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 保存/清除失败的原因；非空时状态行显示「保存失败（…）」。 */
  const [failure, setFailure] = useState('');
  /** 测试连接的结果（成功/失败都显示）。 */
  const [check, setCheck] = useState('');
  const [checkOk, setCheckOk] = useState(false);

  const refresh = useCallback((): void => {
    void getModelKey()
      .then((next) => setStatus(next))
      .catch((error: unknown) => setFailure(reasonOf(error)));
  }, []);

  /* 每次进这个分区都重新读一次：`重开设置` 必须看得到上次保存的结果。 */
  useEffect(() => refresh(), [refresh]);

  const onSave = useCallback((): void => {
    setBusy(true);
    setFailure('');
    setCheck('');
    void putModelKey(draft)
      .then((next) => {
        setStatus(next);
        setDraft('');
        setShow(false);
      })
      .catch((error: unknown) => setFailure(reasonOf(error)))
      .finally(() => setBusy(false));
  }, [draft]);

  const onClear = useCallback((): void => {
    setBusy(true);
    setFailure('');
    setCheck('');
    void deleteModelKey()
      .then((next) => {
        setStatus(next);
        setDraft('');
        setShow(false);
      })
      .catch((error: unknown) => setFailure(reasonOf(error)))
      .finally(() => setBusy(false));
  }, []);

  const onCheck = useCallback((): void => {
    setBusy(true);
    setCheck('');
    setFailure('');
    void checkModelKey()
      .then((result) => {
        setCheckOk(true);
        setCheck(
          `连接成功（${String(result.status ?? 200)} · ${String(result.wire ?? '—')} · ${String(result.model ?? '—')} · ${String(result.baseUrl ?? '')}）`,
        );
        props.onChecked?.(true);
      })
      .catch((error: unknown) => {
        setCheckOk(false);
        const message = error instanceof ApiError ? `${error.code}：${error.message}` : reasonOf(error);
        setCheck(`连接失败（${message.slice(0, 120)}）`);
        props.onChecked?.(false);
      })
      .finally(() => setBusy(false));
  }, [props]);

  const byok = props.settings?.byok ?? BYOK_DEFAULTS;
  const patch = (next: Partial<ByokFields>): void => {
    props.onChange?.({ byok: { ...BYOK_DEFAULTS, ...byok, ...next } });
  };
  const statusText = modelKeyStatusText(status, failure);

  return h(
    'div',
    {
      className: 'settings-group',
      'data-testid': 'settings-group-model-key',
      /* 量具位：格式与地址一眼可见，不用去嗅输入框。 */
      'data-format': byok.format,
      'data-base-url': byok.baseUrl,
      'data-model': byok.model,
    },
    h('div', { className: 'settings-card-head' }, h('strong', null, '连接参数'), h('span', { className: 'settings-badge' }, 'byok 分区 · Key 单独存')),
    row(
      '显示名称',
      h('input', {
        type: 'text',
        value: byok.name,
        maxLength: 60,
        placeholder: '例如：本机 OpenAI 代理',
        'data-testid': 'settings-byok-name',
        onChange: (event: { target: { value: string } }) => patch({ name: event.target.value }),
        style: { width: '100%' },
      }),
      '只用于在本机区分多份配置；不进请求',
    ),
    row(
      'API 格式',
      h(
        'select',
        {
          'data-testid': 'settings-byok-format',
          'data-value': byok.format,
          value: byok.format,
          onChange: (event: { target: { value: string } }) =>
            patch({ format: event.target.value as ByokFields['format'] }),
        },
        ...BYOK_ADAPTERS.map((adapter) => h('option', { value: adapter.id, key: adapter.id }, adapter.label)),
      ),
      '三条 wire 的端点/认证/事件都不同：选错不会「降级成兼容」，只会按错误协议发',
    ),
    row(
      'Base URL',
      h('input', {
        type: 'text',
        value: byok.baseUrl,
        maxLength: 300,
        placeholder: 'https://api.openai.com/v1（留空 = 用缺省/环境变量）',
        'data-testid': 'settings-byok-base-url',
        onChange: (event: { target: { value: string } }) => patch({ baseUrl: event.target.value }),
        style: { width: '100%' },
      }),
      '环境变量 OPENCUT_MODEL_BASE_URL 一配就优先于这里（运维钉死端点）',
    ),
    row(
      '模型 ID',
      h('input', {
        type: 'text',
        value: byok.model,
        maxLength: 120,
        placeholder: '例如：gpt-4o-mini / claude-3-5-sonnet',
        'data-testid': 'settings-byok-model',
        onChange: (event: { target: { value: string } }) => patch({ model: event.target.value }),
        style: { width: '100%' },
      }),
      '原样进请求体；不猜「同族型号」',
    ),
    row(
      '推理档',
      h(
        'select',
        {
          'data-testid': 'settings-byok-reasoning',
          value: byok.reasoning,
          onChange: (event: { target: { value: string } }) => patch({ reasoning: event.target.value as ByokFields['reasoning'] }),
        },
        h('option', { value: 'auto' }, 'auto（按协议行为）'),
        h('option', { value: 'off' }, 'off'),
        h('option', { value: 'low' }, 'low'),
        h('option', { value: 'medium' }, 'medium'),
        h('option', { value: 'high' }, 'high'),
      ),
      '只保存；是否被接受由所选协议决定（聊天里只显示当前模型支持的档位）',
    ),
    row(
      '上下文 tokens',
      h('input', {
        type: 'number',
        min: 0,
        max: 2000000,
        step: 1000,
        value: byok.contextTokens,
        'data-testid': 'settings-byok-context',
        onChange: (event: { target: { value: string } }) => {
          const next = Number(event.target.value);
          patch({ contextTokens: Number.isFinite(next) ? Math.max(0, Math.min(2_000_000, Math.trunc(next))) : 0 });
        },
        style: { width: '120px' },
      }),
      '0 = 未配置；写进去的是上限，不替模型猜默认',
    ),

    h('div', { className: 'settings-card-head' }, h('strong', null, 'Key（密文，单独存）')),
    row(
      '我的模型 Key',
      h(
        'div',
        { className: 'settings-model-key' },
        h('input', {
          type: show ? 'text' : 'password',
          value: draft,
          placeholder: 'sk-…',
          autoComplete: 'off',
          spellCheck: false,
          'data-testid': 'settings-model-key-input',
          'data-masked': String(!show),
          onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
        }),
        h(
          'label',
          { className: 'settings-model-key-show' },
          h('input', {
            type: 'checkbox',
            checked: show,
            'data-testid': 'settings-model-key-show',
            onChange: (event: { target: { checked: boolean } }) => setShow(event.target.checked),
          }),
          '显示',
        ),
      ),
      '默认密文；「显示」只是把输入框切成明文看一眼，不改保存格式',
    ),
    row(
      '状态',
      h(
        'span',
        {
          className: 'settings-path',
          'data-testid': 'settings-model-key-status',
          'data-configured': String(status?.configured === true && failure === ''),
          'data-issue': status?.issue ?? '',
        },
        statusText,
      ),
      '任何日志/证据只出现尾 4 位',
    ),
    row(
      '保存 / 清除',
      h(
        'div',
        { className: 'settings-model-key-actions' },
        h(
          'button',
          { type: 'button', className: 'btn tiny', 'data-testid': 'settings-model-key-save', disabled: busy, onClick: onSave },
          '保存',
        ),
        h(
          'button',
          { type: 'button', className: 'btn tiny', 'data-testid': 'settings-model-key-clear', disabled: busy, onClick: onClear },
          '清除',
        ),
      ),
      '编辑时留空 = 保留原 Key；只有「清除」才会删掉（AT21）',
    ),
    row(
      '测试连接',
      h(
        'div',
        { className: 'settings-model-key-actions' },
        h(
          'button',
          { type: 'button', className: 'btn tiny', 'data-testid': 'settings-model-key-check', disabled: busy, onClick: onCheck },
          '按当前格式发一次最小请求',
        ),
        check === ''
          ? null
          : h(
              'span',
              { className: 'settings-note', 'data-testid': 'settings-model-key-check-result', 'data-ok': String(checkOk) },
              check,
            ),
      ),
      '请求真的按上面选的 format/baseUrl/model 发出；失败时 wire/baseUrl 会回显在错误里',
    ),

    h('div', { className: 'settings-card-head' }, h('strong', null, '三种协议的实际差异（只读）')),
    h(
      'div',
      { className: 'settings-adapter-table', 'data-testid': 'settings-byok-adapters' },
      ...BYOK_ADAPTERS.map((adapter) =>
        h(
          'div',
          {
            key: adapter.id,
            className: 'settings-adapter-row',
            'data-testid': `settings-byok-adapter-${adapter.id}`,
            'data-active': String(adapter.id === byok.format),
            /* CS2（AC11）：能力位是机器可读的 —— 不是只有一句「已实现」。 */
            'data-capabilities': 'stream,tools,cancel,retry',
          },
          h('code', null, adapter.id),
          h('span', null, adapter.path),
          h('span', null, adapter.auth),
          h('span', null, adapter.stream),
          h('span', null, adapter.tools),
          h('span', null, adapter.control),
        ),
      ),
    ),
    h(
      'p',
      { className: 'settings-note', 'data-testid': 'settings-byok-capabilities' },
      '适配器层已接：流事件（text_delta / tool_call_start / tool_call_delta / usage / done）、工具循环（按各协议形状回灌 tool_result）、取消（abort 关连接）、限流（尊重 Retry-After，最多 3 次）。单测 7 条在 packages/providers/test/cs2-protocol.test.mjs。',
    ),
    h(
      'p',
      { className: 'settings-note', 'data-testid': 'settings-model-key-note' },
      '「测试连接」只做一次非流式 ping（验鉴权/端点/模型 id），不跑工具循环；完整协议能力由上面那组单测验。Key 只保存在本机（密文），界面/日志/证据只显示尾 4 位。',
    ),
  );
}
