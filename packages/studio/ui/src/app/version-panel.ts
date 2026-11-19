/**
 * 命名版本面板（S75 · WP09 的界面入口）。
 *
 * 背景：M62 的五个接口（列表/创建/diff/restore/restore-film）早就在服务端了，
 * 但 `api.ts` 里一次都没出现——功能在、用户点不到。这个面板把它们接出来。
 *
 * ## 三条硬约束（验收会抓）
 *
 * 1. **恢复必须真的换掉 film.html**：走 `restore-film`，成功后调宿主给的 `onReload()`
 *    （S73 的 `reloadAll`，不再写第二套刷新）；验收读盘算 sha256，与版本 blob 逐字节比。
 * 2. **服务端原文不改写**：创建失败的 `field`/`message` 逐字显示（`server-error.ts`）。
 * 3. **五态齐全**：加载骨架 / 空 / GET 失败可重试 / 恢复中整块禁用 / 错误块常驻。
 *
 * ## 列表的「大小」为什么不是字节数
 *
 * `listVersions` 只返回 `files`（文本文件数）与 `mediaCount`（媒体数），**没有字节数**；
 * 本批禁改 server，所以这里显示「N 文件 · M 媒体」，不编一个假的「大小」。
 * 要真字节数得主线给 `listVersions` 加字段（交接 DEV-R39-1）。
 *
 * ## 分页为什么用「显示更多」而不是滚动加载
 *
 * 列表是纯文本行、没有虚拟滚动，30 条一页的按钮式展开**可断言、可复跑**（脚本点一次
 * 就多 30 行）；滚动加载要模拟滚动位置，在无头环境里容易假绿。100 条时 DOM 规模仍然很小。
 */

import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { createVersion, diffVersion, listVersions, restoreVersionFilm } from './api';
import type { VersionDiffResponse, VersionInfo, VersionsListResponse } from './api';
import { viewServerError } from './server-error';
import type { ServerErrorView } from './server-error';
import { summarizeDiff } from './version-diff.mjs';

const h = createElement;

/** 一页多少条；100 条版本 → 4 页。 */
export const VERSION_PAGE = 30;

export interface VersionPanelProps {
  projectId: string;
  onClose: () => void;
  /** 恢复成功后的**整页重取**（复用 S73 的 `reloadAll`：doc / 素材 / 媒体 / 导出队列 / 图层树）。 */
  onReload: () => Promise<void>;
  onNotify: (kind: 'info' | 'error', text: string) => void;
}

type Status = 'loading' | 'ready' | 'error';

/** `GET /versions/:sha/diff` 的界面状态：每条只保留一份（换选中就重取）。 */
type DiffState =
  | { kind: 'idle' }
  | { kind: 'loading'; sha: string }
  | { kind: 'ready'; sha: string; data: VersionDiffResponse }
  | { kind: 'error'; sha: string; view: ServerErrorView };

/** @param {string} iso */
function localTime(iso: string): string {
  if (iso === '') return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 名称缺省显示「自动」——不编一个「未命名」出来假装是用户起的名字。 */
function displayName(name: string): string {
  return name.trim() === '' ? '自动' : name;
}

/** 摘要函数在 `version-diff.mjs`（验收脚本要直接 import 这个纯函数）；这里只是转出。 */
export { summarizeDiff };

export function VersionPanel(props: VersionPanelProps): ReactNode {
  const [status, setStatus] = useState<Status>('loading');
  const [body, setBody] = useState<VersionsListResponse | null>(null);
  const [error, setError] = useState<ServerErrorView | null>(null);
  const [visible, setVisible] = useState(VERSION_PAGE);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<ServerErrorView | null>(null);
  const [newSha, setNewSha] = useState('');
  const [diff, setDiff] = useState<DiffState>({ kind: 'idle' });
  const [confirm, setConfirm] = useState<VersionInfo | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<ServerErrorView | null>(null);
  const [listMs, setListMs] = useState(-1);
  /** 取数完成的时间戳：和 body/status 在同一次 setState 里落地，重挂载也不会丢。 */
  const [loadedAt, setLoadedAt] = useState(0);
  const [fetchMs, setFetchMs] = useState(-1);

  const renderStartRef = useRef(0);
  const projectRef = useRef(props.projectId);
  projectRef.current = props.projectId;

  const load = useCallback(async (): Promise<void> => {
    const id = projectRef.current;
    if (id === '') {
      setStatus('error');
      setError({ status: 0, code: 'NO_PROJECT', field: '', reason: '', message: '还没有打开工程。', allowed: [] });
      return;
    }
    setStatus('loading');
    setError(null);
    const startedAt = performance.now();
    try {
      const response = await listVersions(id);
      const finishedAt = performance.now();
      setFetchMs(Math.round((finishedAt - startedAt) * 10) / 10);
      renderStartRef.current = finishedAt;
      setLoadedAt(finishedAt);
      setBody(response);
      setVisible(VERSION_PAGE);
      setStatus('ready');
    } catch (caught) {
      setStatus('error');
      setError(viewServerError(caught));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, props.projectId]);

  /* 列表真正提交到 DOM 之后再量一次（渲染耗时，不含网络）。
     loadedAt 是 state，不是 ref：面板被父级重挂载时 ref 会归零，state 会随新一次 load 一起重建。 */
  useEffect(() => {
    if (status !== 'ready' || loadedAt === 0) return;
    setListMs(Math.round((performance.now() - loadedAt) * 10) / 10);
  }, [status, loadedAt]);

  const versions = body?.versions ?? [];
  const dirtyCount =
    (body?.dirty.added.length ?? 0) + (body?.dirty.modified.length ?? 0) + (body?.dirty.deleted.length ?? 0);
  const headSha = versions.length === 0 ? '' : (versions[0]?.sha ?? '');
  const shown = useMemo(() => versions.slice(0, visible), [versions, visible]);

  const submitCreate = async (): Promise<void> => {
    const id = projectRef.current;
    if (id === '' || creating) return;
    setCreating(true);
    setCreateError(null);
    setNewSha('');
    try {
      const result = await createVersion(id, name.trim());
      setName('');
      setNewSha(result.version.sha);
      await load();
      props.onNotify('info', `已创建版本 ${result.version.short}（${displayName(result.version.name)}）`);
    } catch (caught) {
      setCreateError(viewServerError(caught));
    } finally {
      setCreating(false);
    }
  };

  const openDiff = async (version: VersionInfo): Promise<void> => {
    const id = projectRef.current;
    if (id === '') return;
    setDiff({ kind: 'loading', sha: version.sha });
    try {
      const data = await diffVersion(id, version.sha);
      setDiff({ kind: 'ready', sha: version.sha, data });
    } catch (caught) {
      setDiff({ kind: 'error', sha: version.sha, view: viewServerError(caught) });
    }
  };

  const doRestore = async (): Promise<void> => {
    const id = projectRef.current;
    const target = confirm;
    if (id === '' || target === null || restoring) return;
    setRestoring(true);
    setRestoreError(null);
    try {
      const result = await restoreVersionFilm(id, target.sha);
      setConfirm(null);
      setNewSha('');
      /* 整页重取（S73 的 reloadAll）：doc / 素材 / 媒体 / 导出队列 / 图层树。
         不重取的话舞台还在画旧 film.html，用户会以为恢复没生效。 */
      await props.onReload();
      await load();
      props.onNotify('info', `已恢复到 ${target.short} · film.html ${result.filmSha.slice(0, 8)}`);
    } catch (caught) {
      setRestoreError(viewServerError(caught));
    } finally {
      setRestoring(false);
    }
  };

  const busy = restoring || creating;

  const errorBlock = (view: ServerErrorView, where: string): ReactNode =>
    h(
      'div',
      { className: 'ver-error', 'data-testid': `version-${where}-error`, 'data-code': view.code, role: 'alert' },
      h('div', { className: 'ver-error-head' }, h('strong', null, view.code), h('code', null, view.status === 0 ? '无 HTTP 状态' : `HTTP ${String(view.status)}`)),
      h('p', { className: 'ver-error-msg', 'data-testid': `version-${where}-message` }, view.message === '' ? '（服务端没有给 message）' : view.message),
      view.field === '' ? null : h('p', { className: 'ver-error-field' }, 'field: ', h('code', null, view.field)),
      view.allowed.length === 0 ? null : h('p', { className: 'ver-error-field' }, '允许：', h('code', null, view.allowed.join(' / '))),
      h(
        'p',
        { className: 'ver-error-next' },
        view.code === 'CLIENT'
          ? '请求没发出去或被中断（Studio 可能刚重启）。点重试。'
          : view.code === 'FILM_NOT_FOUND'
            ? '工程在服务端已经不在了：先在左侧重新打开这个工程。'
            : '这是服务端原样返回的错误；改完上面的问题再试一次。',
      ),
    );

  const row = (version: VersionInfo): ReactNode => {
    const isHead = version.sha === headSha;
    const isNew = version.sha === newSha;
    const diffHere = diff.kind !== 'idle' && diff.sha === version.sha;
    return h(
      'li',
      {
        key: version.sha,
        className: 'ver-row',
        'data-testid': 'version-row',
        'data-sha': version.sha,
        'data-short': version.short,
        'data-current': isHead && dirtyCount === 0 ? 'true' : 'false',
        'data-new': isNew ? 'true' : 'false',
      },
      h(
        'div',
        { className: 'ver-row-main' },
        h('code', { className: 'ver-sha', 'data-testid': 'version-row-sha' }, version.short),
        h('span', { className: 'ver-time' }, localTime(version.at)),
        h('strong', { className: 'ver-name', 'data-testid': 'version-row-name' }, displayName(version.name)),
        h(
          'span',
          { className: 'ver-size', 'data-testid': 'version-row-size', title: '服务端只给文件数与媒体数，不给字节数（DEV-R39-1）' },
          `${String(version.files)} 文件改动 · ${String(version.mediaCount)} 媒体`,
        ),
        isHead
          ? h(
              'span',
              { className: 'ver-flag', 'data-testid': 'version-row-current', 'data-dirty': dirtyCount > 0 ? 'true' : 'false' },
              dirtyCount > 0 ? `HEAD · ${String(dirtyCount)} 处未提交` : '当前',
            )
          : null,
        isNew ? h('span', { className: 'ver-flag new', 'data-testid': 'version-row-new' }, '刚创建') : null,
      ),
      h(
        'div',
        { className: 'ver-row-actions' },
        h(
          'button',
          {
            type: 'button',
            className: 'btn tiny',
            'data-testid': 'version-diff-toggle',
            'data-sha': version.sha,
            disabled: busy,
            'aria-expanded': diffHere ? 'true' : 'false',
            onClick: () => {
              if (diffHere) setDiff({ kind: 'idle' });
              else void openDiff(version);
            },
          },
          diffHere ? '收起' : '对比',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'btn tiny',
            'data-testid': 'version-restore',
            'data-sha': version.sha,
            disabled: busy,
            onClick: () => {
              setRestoreError(null);
              setConfirm(version);
            },
          },
          '恢复',
        ),
      ),
      diffHere && diff.kind === 'loading'
        ? h('p', { className: 'ver-diff-loading', 'data-testid': 'version-diff-loading' }, '取差异中…')
        : null,
      diffHere && diff.kind === 'error' ? errorBlock(diff.view, 'diff') : null,
      diffHere && diff.kind === 'ready'
        ? h(
            'div',
            { className: 'ver-diff', 'data-testid': 'version-diff', 'data-sha': diff.sha, 'data-files': String(diff.data.files.length) },
            ...summarizeDiff(diff.data).map((line, index) =>
              h(
                'p',
                { key: String(index), className: index === 0 ? 'ver-diff-head' : 'ver-diff-line', 'data-testid': index === 0 ? 'version-diff-summary' : 'version-diff-line' },
                line,
              ),
            ),
          )
        : null,
    );
  };

  return h(
    'div',
    { className: 'modal-backdrop', 'data-testid': 'version-backdrop' },
    h(
      'div',
      {
        className: 'modal ver-modal',
        'data-testid': 'version-panel',
        'data-status': status,
        'data-busy': restoring ? 'restore' : creating ? 'create' : 'false',
        'data-list-ms': String(listMs),
        'data-fetch-ms': String(fetchMs),
        'data-versions': String(versions.length),
        role: 'dialog',
        'aria-label': '版本历史',
      },
      h(
        'div',
        { className: 'modal-head' },
        h('div', { className: 'ver-head-text' }, h('strong', null, '版本历史'), h('small', null, '命名版本存在 .film/versions.git，不碰工程自己的 .git')),
        h('button', { type: 'button', className: 'btn tiny', 'data-testid': 'version-close', disabled: restoring, onClick: props.onClose }, '关闭'),
      ),

      /* ── 创建 ─────────────────────────────────────────────────────── */
      h(
        'div',
        { className: 'ver-create' },
        h('input', {
          type: 'text',
          className: 'ver-input',
          'data-testid': 'version-name',
          placeholder: '给这个版本起个名字（必填，≤60 字）',
          value: name,
          maxLength: 80,
          disabled: busy,
          onChange: (event: { target: { value: string } }) => setName(event.target.value),
          onKeyDown: (event: { key: string }) => {
            if (event.key === 'Enter') void submitCreate();
          },
        }),
        h(
          'button',
          {
            type: 'button',
            className: 'btn tiny primary',
            'data-testid': 'version-create',
            disabled: busy,
            onClick: () => void submitCreate(),
          },
          creating ? '创建中…' : '创建版本',
        ),
        h('span', { className: 'modal-hint ver-create-hint' }, '把当前 film.html 等文本文件提交成一个命名版本'),
      ),
      createError === null ? null : errorBlock(createError, 'create'),

      /* ── 列表五态 ─────────────────────────────────────────────────── */
      status === 'loading'
        ? h(
            'div',
            { className: 'ver-skeleton', 'data-testid': 'version-loading', 'aria-busy': 'true' },
            h('span', null),
            h('span', null),
            h('span', null),
            h('span', null),
          )
        : null,

      status === 'error' && error !== null
        ? h(
            'div',
            { className: 'ver-error-wrap' },
            errorBlock(error, 'load'),
            h(
              'button',
              { type: 'button', className: 'btn tiny', 'data-testid': 'version-retry', onClick: () => void load() },
              '重试',
            ),
          )
        : null,

      status === 'ready' && body !== null && body.gitAvailable === false
        ? h(
            'div',
            { className: 'ver-empty', 'data-testid': 'version-no-git' },
            h('strong', null, '这台机器没有 git'),
            h('p', null, '命名版本依赖 git；装好 git 后重开这个面板。'),
          )
        : null,

      status === 'ready' && body !== null && body.gitAvailable !== false && versions.length === 0
        ? h(
            'div',
            { className: 'ver-empty', 'data-testid': 'version-empty' },
            h('strong', null, '还没有版本，创建第一个'),
            h('p', null, '上面输入名字 → 创建版本。之后随时可以从这里对比或恢复。'),
          )
        : null,

      status === 'ready' && versions.length > 0
        ? h(
            'div',
            { className: 'ver-list-wrap' },
            h(
              'div',
              { className: 'ver-list-head' },
              h('span', null, `共 ${String(versions.length)} 个版本`),
              h('span', { className: 'ver-list-meta', 'data-testid': 'version-list-meta' }, `渲染 ${String(listMs)}ms · 取数 ${String(fetchMs)}ms`),
            ),
            h('ul', { className: 'ver-list', 'data-testid': 'version-list' }, ...shown.map(row)),
            versions.length > shown.length
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'btn tiny',
                    'data-testid': 'version-more',
                    disabled: busy,
                    onClick: () => setVisible((previous) => previous + VERSION_PAGE),
                  },
                  `显示更多（还有 ${String(versions.length - shown.length)} 条）`,
                )
              : null,
          )
        : null,

      /* ── 恢复确认（二次确认：写清会覆盖什么）──────────────────────── */
      confirm === null
        ? null
        : h(
            'div',
            { className: 'ver-confirm', 'data-testid': 'version-confirm', 'data-sha': confirm.sha, role: 'alertdialog' },
            h('strong', null, `恢复到 ${confirm.short}？`),
            h(
              'p',
              null,
              '会用这个版本里的 ',
              h('code', null, 'film.html'),
              ' 覆盖当前 film.html。当前内容会先备份到 ',
              h('code', null, '.film/versions-backup/'),
              '，但恢复之后编辑器里的改动就看不见了。',
            ),
            h('p', { className: 'ver-confirm-meta' }, `${displayName(confirm.name)} · ${localTime(confirm.at)} · ${String(confirm.files)} 文件`),
            restoreError === null ? null : errorBlock(restoreError, 'restore'),
            h(
              'div',
              { className: 'ver-confirm-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'btn tiny',
                  'data-testid': 'version-confirm-cancel',
                  disabled: restoring,
                  onClick: () => setConfirm(null),
                },
                '取消',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'btn tiny danger',
                  'data-testid': 'version-confirm-ok',
                  disabled: restoring,
                  onClick: () => void doRestore(),
                },
                restoring ? '恢复中…' : '确认恢复',
              ),
            ),
          ),

      /* 恢复中整块禁用：这里再加一层「进度说明」，避免用户以为界面卡死。 */
      restoring
        ? h('p', { className: 'ver-busy', 'data-testid': 'version-busy' }, '正在恢复：写 film.html → 整页重取（doc / 素材 / 字幕 / 图层）。期间所有版本操作禁用。')
        : null,
    ),
  );
}
