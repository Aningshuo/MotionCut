/**
 * 设置中心 · MCP 分区（S69 · WP20）。
 *
 * ## 为什么是「可写」的
 *
 * 服务端（M65）早就接受 `PUT /api/settings` 的 `mcp.servers` 分区补丁，并能把校验错误
 * 指到具体路径（`mcp.servers[0].name`）；缺的一直是界面这条腿。这里补上：
 * 列表 / 新增 / 编辑 / 删除 / 启停，保存只走 `{ mcp: { servers } }` 一个分区。
 *
 * ## 三条硬约束
 *
 * 1. **错误原样显示**：`field` / `reason` / `code` / `message` / `allowed` 全部来自
 *    服务端响应，本文件不拼文案（见 `server-error.ts`）。服务端 `PUT` 目前不转发
 *    `reason`（DEV-R36-1），缺省显示 `—`，不编一个。
 * 2. **env 不回显明文**：列表只显示 `KEY · 长度 N`；编辑框里**预置为空**，
 *    留空 = 保留原值（patch 语义），写 `KEY=新值` 才覆盖。任何渲染路径都不把
 *    真实值放进 DOM（包括 title / placeholder / value）。
 * 3. **生效口径**：保存成功只说「对新建会话生效」——已经在跑的 ACP 会话不会被重启。
 *
 * 状态：加载（骨架）→ 就绪 / 空 / 错误（可重试）；保存中禁用整块表单；
 * 保存失败保留用户输入，不把表单清空。
 */

import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { getSettings, putSettings } from './api';
import type { McpServerEntry } from './api';
import { viewServerError } from './server-error';
import type { ServerErrorView } from './server-error';

const h = createElement;

/** 与服务端 `MCP_MAX_SERVERS` 同值：这里只用于提示，**不拦截**（口径以服务端为准）。 */
const MAX_HINT = 32;

export interface McpEditorProps {
  /** 保存成功后把服务端回读的那份列表交给宿主（设置面板其他分区共用同一份 settings）。 */
  onSaved: (servers: McpServerEntry[]) => void;
}

interface Draft {
  /** null = 新增；数字 = 替换该下标的条目。 */
  index: number | null;
  name: string;
  command: string;
  argsText: string;
  /** 空的：留空即保留 `envBase`；只写要覆盖的键。 */
  envText: string;
  /** 编辑现有条目时带上的原 env（**只在内存里**，不渲染）。 */
  envBase: Record<string, string>;
  enabled: boolean;
}

/** 把 `KEY=value` 逐行合并到基线上；没有 `=` 的行忽略（不静默改成空值）。 */
export function mergeEnvText(base: Record<string, string>, text: string): Record<string, string> {
  const next: Record<string, string> = { ...base };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const at = line.indexOf('=');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    if (key === '') continue;
    next[key] = line.slice(at + 1);
  }
  return next;
}

/** args 一行一个（不用逗号切：路径与正则里逗号很常见）。 */
export function parseArgsText(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function argsTextOf(entry: McpServerEntry): string {
  return Array.isArray(entry.args) ? entry.args.join('\n') : '';
}

/** 服务端错误的逐字呈现（field 路径 + reason + code + message + allowed）。 */
function ErrorDetail(props: { view: ServerErrorView; testid: string; title: string }): ReactNode {
  const view = props.view;
  return h(
    'div',
    {
      className: 'mcp-error',
      'data-testid': props.testid,
      'data-code': view.code,
      'data-field': view.field,
      'data-reason': view.reason,
      'data-status': String(view.status),
      role: 'alert',
    },
    h('div', { className: 'mcp-error-head' }, props.title),
    h(
      'dl',
      { className: 'mcp-error-grid' },
      h('dt', null, 'field'),
      h('dd', null, h('code', { 'data-testid': `${props.testid}-field` }, view.field === '' ? '—' : view.field)),
      h('dt', null, 'reason'),
      h(
        'dd',
        null,
        h('code', { 'data-testid': `${props.testid}-reason` }, view.reason === '' ? '—' : view.reason),
      ),
      h('dt', null, 'code'),
      h('dd', null, h('code', { 'data-testid': `${props.testid}-code` }, view.code)),
      h('dt', null, 'message'),
      h('dd', { 'data-testid': `${props.testid}-message` }, view.message),
      view.allowed.length === 0
        ? null
        : h('dt', null, 'allowed'),
      view.allowed.length === 0
        ? null
        : h('dd', null, h('code', { 'data-testid': `${props.testid}-allowed` }, view.allowed.join(' / '))),
    ),
  );
}

export function McpSettingsEditor(props: McpEditorProps): ReactNode {
  /** @type {'loading'|'ready'|'empty'|'error'} */
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [servers, setServers] = useState<McpServerEntry[]>([]);
  const [loadError, setLoadError] = useState<ServerErrorView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<ServerErrorView | null>(null);
  const [notice, setNotice] = useState('');
  const [savedAt, setSavedAt] = useState('');
  /** 卸载后不再 setState（切分区/关面板时请求可能还在飞）。 */
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setStatus('loading');
    setLoadError(null);
    try {
      const res = await getSettings();
      if (!aliveRef.current) return;
      const list = Array.isArray(res.settings.mcp?.servers) ? (res.settings.mcp?.servers ?? []) : [];
      setServers(list);
      setStatus(list.length === 0 ? 'empty' : 'ready');
      setSavedAt(res.updatedAt ?? '');
    } catch (error) {
      if (!aliveRef.current) return;
      setLoadError(viewServerError(error));
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 提交整段列表：`{ mcp: { servers } }` —— 一个分区补丁，不碰其他分区。 */
  const persist = useCallback(
    async (next: McpServerEntry[], done: (readback: McpServerEntry[]) => void): Promise<void> => {
      setBusy(true);
      setSaveError(null);
      setNotice('');
      try {
        const saved = await putSettings({ mcp: { servers: next } });
        if (!aliveRef.current) return;
        /* 回读：以服务端那份为准（也顺手证明「写进去的就是读回来的」）。 */
        const after = await getSettings();
        if (!aliveRef.current) return;
        const list = Array.isArray(after.settings.mcp?.servers) ? (after.settings.mcp?.servers ?? []) : [];
        setServers(list);
        setStatus(list.length === 0 ? 'empty' : 'ready');
        setSavedAt(saved.updatedAt ?? after.updatedAt ?? '');
        setNotice(`已保存 · 对新建会话生效 · ${String(saved.updatedAt ?? '').slice(0, 19)}`);
        props.onSaved(list);
        done(list);
      } catch (error) {
        if (!aliveRef.current) return;
        /* 保留用户输入：只把错误摆出来，不动表单。 */
        setSaveError(viewServerError(error));
      } finally {
        if (aliveRef.current) setBusy(false);
      }
    },
    [props],
  );

  const startAdd = (): void => {
    setSaveError(null);
    setNotice('');
    setDraft({ index: null, name: '', command: '', argsText: '', envText: '', envBase: {}, enabled: true });
  };

  const startEdit = (entry: McpServerEntry, index: number): void => {
    setSaveError(null);
    setNotice('');
    setDraft({
      index,
      name: entry.name,
      command: entry.command,
      argsText: argsTextOf(entry),
      envText: '',
      envBase: { ...(entry.env ?? {}) },
      enabled: entry.enabled !== false,
    });
  };

  const submitDraft = (): void => {
    if (draft === null || busy) return;
    const entry: McpServerEntry = {
      name: draft.name.trim(),
      command: draft.command.trim(),
      args: parseArgsText(draft.argsText),
      env: mergeEnvText(draft.envBase, draft.envText),
      enabled: draft.enabled,
    };
    const next = [...servers];
    if (draft.index === null) next.push(entry);
    else next[draft.index] = entry;
    void persist(next, () => setDraft(null));
  };

  const removeAt = (index: number): void => {
    if (busy) return;
    const next = servers.filter((_, at) => at !== index);
    void persist(next, () => setDraft(null));
  };

  const toggleAt = (index: number, enabled: boolean): void => {
    if (busy) return;
    const current = servers[index];
    if (current === undefined) return;
    const next = [...servers];
    next[index] = { ...current, enabled };
    void persist(next, () => undefined);
  };

  /* ── 加载 / 错误 / 空 ────────────────────────────────────────────── */
  if (status === 'loading') {
    return h(
      'div',
      { className: 'mcp-editor', 'data-testid': 'mcp-editor', 'data-status': 'loading', 'data-busy': 'false' },
      h(
        'div',
        { className: 'mcp-skeleton', 'data-testid': 'mcp-skeleton', 'aria-busy': 'true' },
        h('div', { className: 'sk-row' }),
        h('div', { className: 'sk-row' }),
        h('div', { className: 'sk-row' }),
      ),
      h('p', { className: 'settings-note' }, '正在读取外部 MCP 配置…'),
    );
  }

  if (status === 'error') {
    return h(
      'div',
      { className: 'mcp-editor', 'data-testid': 'mcp-editor', 'data-status': 'error', 'data-busy': 'false' },
      loadError === null ? null : ErrorDetail({ view: loadError, testid: 'mcp-load-error', title: '读取设置失败' }),
      h(
        'div',
        { className: 'mcp-actions' },
        h(
          'button',
          { type: 'button', className: 'btn tiny', 'data-testid': 'mcp-retry', onClick: () => void load() },
          '重试',
        ),
      ),
      h('p', { className: 'settings-note' }, '读取失败不改变磁盘上的设置；重试会重新 GET /api/settings。'),
    );
  }

  const editing = draft !== null;
  return h(
    'div',
    {
      className: 'mcp-editor',
      'data-testid': 'mcp-editor',
      'data-status': status,
      'data-busy': busy ? 'true' : 'false',
      'data-count': String(servers.length),
    },
    h(
      'div',
      { className: 'mcp-head' },
      h('div', { className: 'mcp-head-text' }, h('strong', null, '外部 MCP server'), h('small', null, `最多 ${MAX_HINT} 条 · 保存对新建会话生效，运行中的会话不会重启`)),
      h(
        'button',
        {
          type: 'button',
          className: 'btn tiny',
          'data-testid': 'mcp-add',
          onClick: startAdd,
          disabled: busy || editing,
        },
        '新增',
      ),
    ),

    status === 'empty' && !editing
      ? h(
          'div',
          { className: 'mcp-empty', 'data-testid': 'mcp-empty' },
          h('p', null, '还没有外部 MCP server。'),
          h('small', null, '新增一条后会出现在这里；未配置时 ACP 会话不带任何外部 server。'),
        )
      : null,

    servers.length === 0
      ? null
      : h(
          'ul',
          { className: 'mcp-list', 'data-testid': 'mcp-list' },
          ...servers.map((entry, index) =>
            h(
              'li',
              {
                key: `${entry.name}-${String(index)}`,
                className: 'mcp-row',
                'data-testid': 'mcp-row',
                'data-name': entry.name,
                'data-enabled': entry.enabled === false ? 'false' : 'true',
                'data-index': String(index),
              },
              h(
                'div',
                { className: 'mcp-row-main' },
                h('strong', { className: 'mcp-name' }, entry.name),
                h('code', { className: 'mcp-command' }, [entry.command, ...(entry.args ?? [])].join(' ')),
                h(
                  'div',
                  { className: 'mcp-env' },
                  ...Object.keys(entry.env ?? {}).map((key) =>
                    h(
                      'span',
                      { className: 'mcp-env-chip', 'data-testid': 'mcp-env-chip', 'data-key': key, key },
                      `${key} · 长度 ${String(String((entry.env ?? {})[key] ?? '').length)}`,
                    ),
                  ),
                ),
              ),
              h(
                'div',
                { className: 'mcp-row-actions' },
                h(
                  'label',
                  { className: 'mcp-toggle' },
                  h('input', {
                    type: 'checkbox',
                    checked: entry.enabled !== false,
                    'data-testid': 'mcp-toggle',
                    disabled: busy,
                    onChange: (event: { target: { checked: boolean } }) => toggleAt(index, event.target.checked),
                  }),
                  entry.enabled === false ? '停用' : '启用',
                ),
                h(
                  'button',
                  { type: 'button', className: 'btn tiny', 'data-testid': 'mcp-edit', disabled: busy, onClick: () => startEdit(entry, index) },
                  '编辑',
                ),
                h(
                  'button',
                  { type: 'button', className: 'btn tiny danger', 'data-testid': 'mcp-delete', disabled: busy, onClick: () => removeAt(index) },
                  '删除',
                ),
              ),
            ),
          ),
        ),

    editing && draft !== null
      ? h(
          'div',
          { className: 'mcp-form', 'data-testid': 'mcp-form', 'data-mode': draft.index === null ? 'add' : 'edit' },
          h('h4', null, draft.index === null ? '新增 MCP server' : `编辑 ${servers[draft.index]?.name ?? ''}`),
          h(
            'label',
            { className: 'mcp-field' },
            h('span', null, 'name'),
            h('input', {
              type: 'text',
              'data-testid': 'mcp-name',
              value: draft.name,
              disabled: busy,
              placeholder: '小写字母/数字开头，2–32 位，可用 - _',
              onChange: (event: { target: { value: string } }) => setDraft({ ...draft, name: event.target.value }),
            }),
          ),
          h(
            'label',
            { className: 'mcp-field' },
            h('span', null, 'command'),
            h('input', {
              type: 'text',
              'data-testid': 'mcp-command',
              value: draft.command,
              disabled: busy,
              placeholder: 'npx',
              onChange: (event: { target: { value: string } }) => setDraft({ ...draft, command: event.target.value }),
            }),
          ),
          h(
            'label',
            { className: 'mcp-field' },
            h('span', null, 'args（一行一个）'),
            h('textarea', {
              'data-testid': 'mcp-args',
              rows: 3,
              value: draft.argsText,
              disabled: busy,
              placeholder: '-y\n@modelcontextprotocol/server-filesystem',
              onChange: (event: { target: { value: string } }) => setDraft({ ...draft, argsText: event.target.value }),
            }),
          ),
          h(
            'label',
            { className: 'mcp-field' },
            h('span', null, draft.index === null ? 'env（KEY=value，一行一个）' : 'env（留空 = 保留原值；只写要改的键）'),
            h('textarea', {
              'data-testid': 'mcp-env',
              rows: 2,
              value: draft.envText,
              disabled: busy,
              placeholder: 'TOKEN=...',
              onChange: (event: { target: { value: string } }) => setDraft({ ...draft, envText: event.target.value }),
            }),
          ),
          Object.keys(draft.envBase).length === 0
            ? null
            : h(
                'div',
                { className: 'mcp-env-now', 'data-testid': 'mcp-env-now' },
                h('span', null, '现有 env：'),
                ...Object.keys(draft.envBase).map((key) =>
                  h(
                    'span',
                    { className: 'mcp-env-chip', 'data-testid': 'mcp-env-chip-current', 'data-key': key, key },
                    `${key} · 长度 ${String(String(draft.envBase[key] ?? '').length)}`,
                  ),
                ),
              ),
          h(
            'label',
            { className: 'mcp-toggle' },
            h('input', {
              type: 'checkbox',
              'data-testid': 'mcp-enabled',
              checked: draft.enabled,
              disabled: busy,
              onChange: (event: { target: { checked: boolean } }) => setDraft({ ...draft, enabled: event.target.checked }),
            }),
            '启用',
          ),
          h(
            'div',
            { className: 'mcp-actions' },
            h(
              'button',
              { type: 'button', className: 'btn tiny primary', 'data-testid': 'mcp-save', disabled: busy, onClick: submitDraft },
              busy ? '保存中…' : '保存',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'btn tiny',
                'data-testid': 'mcp-cancel',
                disabled: busy,
                onClick: () => {
                  setDraft(null);
                  setSaveError(null);
                },
              },
              '取消',
            ),
            h('span', { className: 'settings-note' }, '保存只提交 mcp 分区，不动播放/导出设置'),
          ),
        )
      : null,

    saveError === null ? null : ErrorDetail({ view: saveError, testid: 'mcp-save-error', title: '保存被服务端拒绝（输入已保留）' }),
    notice === ''
      ? null
      : h('div', { className: 'settings-notice', 'data-testid': 'mcp-notice', 'data-saved-at': savedAt }, notice),
    h(
      'p',
      { className: 'settings-note', 'data-testid': 'mcp-honesty' },
      '数据来源：GET /api/settings 的 mcp.servers（用户级设置文件）。env 值不回显，只显示键名与长度。',
    ),
  );
}
