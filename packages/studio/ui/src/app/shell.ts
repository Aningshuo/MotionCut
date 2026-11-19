import { createElement as h, useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import { ApiError, createStudioProject, getSettings, listProjectsWithRecent, openProject } from './api';
import { editorIcon } from './editor-icons';
import { motionCutMark } from './motioncut-mark';
import { rememberStudioTheme } from './studio-theme';
import { TabBar, tabsApi, useTabs } from './tabs';
import type { RecentProjectItem } from './types';
import './project-home.css';

type HomeSnapshot = Awaited<ReturnType<typeof listProjectsWithRecent>>;
type HistoryItem = Pick<RecentProjectItem, 'name' | 'path' | 'openedAt' | 'missing'> & { projectId?: string };

function historyItems(snapshot: HomeSnapshot): HistoryItem[] {
  const byPath = new Map<string, HistoryItem>();
  for (const recent of snapshot.recent) {
    byPath.set(recent.path, recent);
  }
  for (const item of snapshot.projects) {
    const recent = byPath.get(item.path);
    byPath.set(item.path, {
      name: item.name,
      path: item.path,
      openedAt: recent?.openedAt ?? '',
      projectId: item.projectId,
    });
  }
  return [...byPath.values()];
}

const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' });

function openedDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? dateFormat.format(date) : '';
}

function describe(error: unknown): string {
  if (error instanceof ApiError && error.code === 'PROJECT_EXISTS') return '该项目名称已存在，请换一个名称。';
  return error instanceof Error ? error.message : String(error);
}

async function showProject(path: string, expectedId?: string): Promise<void> {
  const { project } = await openProject(path);
  if (expectedId !== undefined && project.projectId !== expectedId) {
    throw new Error('项目位置已变更，请刷新历史项目后重试。');
  }
  const api = tabsApi();
  if (api === null) {
    location.assign(`/?project=${encodeURIComponent(project.projectId)}`);
    return;
  }
  const result = await api.open({ projectId: project.projectId });
  if (!result.ok) throw new Error(result.message ?? result.code ?? '项目窗口打开失败。');
}

export function ElectronShell(): ReactNode {
  const tabs = useTabs();
  const [snapshot, setSnapshot] = useState<HomeSnapshot | null>(null);
  const [listError, setListError] = useState('');
  const [actionError, setActionError] = useState('');
  const [pending, setPending] = useState('');
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [created, setCreated] = useState<{ dir: string; projectId: string } | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pendingRef = useRef(false);
  const listRevision = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const revision = ++listRevision.current;
    setListError('');
    try {
      const loaded = await listProjectsWithRecent();
      if (revision === listRevision.current) setSnapshot(loaded);
    } catch (error) {
      if (revision === listRevision.current) setListError(describe(error));
    }
  }, []);
  const activeProject = tabs?.active ?? null;

  useEffect(() => {
    if (activeProject === null) void refresh();
    return () => { ++listRevision.current; };
  }, [activeProject, refresh]);

  useEffect(() => {
    let mounted = true;
    void getSettings().then(({ settings }) => {
      if (mounted) rememberStudioTheme(settings.appearance?.theme ?? 'dark');
    }).catch(() => {});
    return () => { mounted = false; };
  }, []);

  async function perform(id: string, task: () => Promise<void>): Promise<void> {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(id);
    setActionError('');
    try {
      await task();
    } catch (error) {
      setActionError(describe(error));
    } finally {
      pendingRef.current = false;
      setPending('');
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void perform('create', async () => {
      const project = created ?? await createStudioProject(name.trim());
      setCreated(project);
      try {
        await showProject(project.dir, project.projectId);
        dialogRef.current?.close();
      } finally {
        void refresh();
      }
    });
  }

  function startCreation(): void {
    setName('');
    setCreated(null);
    setActionError('');
    dialogRef.current?.showModal();
  }

  const names = Object.fromEntries((snapshot?.projects ?? []).map((item) => [item.projectId, item.name]));
  const tabBar = tabs !== null && tabs.projects.length > 0 ? h(TabBar, {
    snapshot: tabs,
    names,
    onSelect: (projectId: string) => void tabsApi()?.activate(projectId),
    onClose: (projectId: string) => void tabsApi()?.close(projectId),
  }) : null;
  if (activeProject !== null) {
    return h('div', { className: 'app shell-app' },
      tabBar,
      h('div', { 'data-testid': 'shell-body' }));
  }

  const history = snapshot === null ? [] : historyItems(snapshot);
  const filter = query.trim().toLocaleLowerCase();
  const visible = history.filter((item) => item.name.toLocaleLowerCase().includes(filter) || item.path.toLocaleLowerCase().includes(filter));

  return h('div', { className: 'app shell-app project-home' },
    h('header', { className: 'project-home-masthead' },
      motionCutMark('project-home-logo'),
      h('span', null, 'MotionCut'),
      tabBar,
      h('div', { className: 'window-drag-region', 'data-testid': 'window-drag-region', 'aria-hidden': true })),
    h('main', { className: 'project-home-body', 'data-testid': 'shell-body' },
      h('div', { className: 'project-home-content', 'data-testid': 'shell-empty' },
        h('div', { className: 'project-home-banner' },
          h('h1', null, '项目'),
          h('button', { type: 'button', className: 'project-home-primary', 'data-testid': 'home-new-project',
            disabled: pending !== '', onClick: startCreation }, h('span', { className: 'project-home-plus', 'aria-hidden': true }, '+'), '新建项目')),
        h('section', { className: 'project-home-history', 'aria-labelledby': 'project-history-heading' },
          h('div', { className: 'project-home-section-head' },
            h('h2', { id: 'project-history-heading' }, '历史项目'),
            history.length > 0 ? h('label', { className: 'project-home-search' },
              editorIcon('search', 15),
              h('input', { type: 'search', value: query, placeholder: '搜索项目', 'aria-label': '搜索项目',
                onChange: (event: { currentTarget: HTMLInputElement }) => setQuery(event.currentTarget.value) })) : null),
          listError === '' ? null : h('div', { className: 'project-home-feedback', role: 'alert' },
            h('span', null, `历史项目读取失败。${listError}`),
            h('button', { type: 'button', className: 'project-home-secondary', onClick: () => void refresh() }, '重试')),
          actionError === '' || dialogRef.current?.open === true ? null
            : h('p', { className: 'project-home-feedback', role: 'alert' }, actionError),
          snapshot === null ? (listError === '' ? h('p', { className: 'project-home-empty', role: 'status' }, '正在读取项目…') : null)
            : visible.length === 0 ? h('p', { className: 'project-home-empty' }, filter ? '没有符合搜索条件的项目' : '暂无历史项目')
            : h('ul', { className: 'project-home-list', 'data-testid': 'shell-projects' }, visible.map((item) => {
              const date = openedDate(item.openedAt);
              return h('li', { key: item.path },
                h('button', { type: 'button', className: 'project-home-row', 'data-testid': 'shell-project',
                  'data-project-id': item.projectId, title: item.path, disabled: pending !== '' || item.missing === true,
                  onClick: () => void perform(item.path, () => showProject(item.path, item.projectId)) },
                  h('span', { className: 'project-home-project-icon', 'aria-hidden': true }, editorIcon('media-library', 19)),
                  h('span', { className: 'project-home-project-copy' },
                    h('strong', null, item.name),
                    h('span', { className: 'project-home-project-path' }, h('bdi', { dir: 'ltr' }, item.path))),
                  h('span', { className: 'project-home-row-detail' },
                    item.missing ? '找不到项目' : pending === item.path ? '打开中…' : date ? h('time', { dateTime: item.openedAt }, date) : null),
                  item.missing ? null : h('span', { className: 'project-home-arrow', 'aria-hidden': true }, '›')));
            }))))),
    h('dialog', { ref: dialogRef, className: 'project-home-dialog', 'aria-labelledby': 'new-project-heading',
      onCancel: (event: { preventDefault(): void }) => { if (pendingRef.current) event.preventDefault(); },
      onClose: () => setActionError('') },
      h('form', { onSubmit: submit },
        h('h2', { id: 'new-project-heading' }, '新建项目'),
        h('label', { className: 'project-home-name' }, '项目名称',
          h('input', { value: name, maxLength: 64, required: true, autoFocus: true, placeholder: '输入项目名称',
            disabled: created !== null || pending !== '', onChange: (event: { currentTarget: HTMLInputElement }) => setName(event.currentTarget.value) })),
        actionError === '' ? null : h('p', { className: 'project-home-dialog-error', role: 'alert' },
          created === null ? actionError : `项目已创建，打开失败。${actionError}`),
        h('div', { className: 'project-home-dialog-actions' },
          h('button', { className: 'project-home-secondary', type: 'button', disabled: pending !== '', onClick: () => dialogRef.current?.close() }, '取消'),
          h('button', { className: 'project-home-primary', type: 'submit', disabled: name.trim() === '' || pending !== '' },
            pending !== '' ? '处理中…' : created === null ? '创建项目' : '重试打开')))));
}
