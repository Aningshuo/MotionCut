/**
 * Electron 多标签的渲染层桥（M16）。
 *
 * 只在 `window.opencut.tabs` 存在时启用（preload 提供）；浏览器里没有标签栏，
 * 工作台保持 R7 的样子。标签栏由**每个 Studio 页面**各画一份：
 * 工程视图铺满窗口（main.mjs 的 TAB_BAR_HEIGHT = 0），谁在最上面谁的标签栏可见，
 * 于是截图（`page.screenshot()`）拿到的就是用户看到的那一屏。
 */
import { createElement, useEffect, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

export interface TabsSnapshot {
  active: string | null;
  open: number;
  created: number;
  destroyed: number;
  projects: Array<{ projectId: string; url: string; name?: string; path?: string }>;
}

export type TabOpenResult = { ok: true; created: boolean; projectId: string } | { ok: false; code?: string; message?: string };

export interface TabsApi {
  open(input: { projectId: string; url?: string }): Promise<TabOpenResult>;
  activate(projectId: string): Promise<unknown>;
  close(projectId: string): Promise<unknown>;
  home(): Promise<{ ok: true; active: null }>;
  list(): Promise<TabsSnapshot>;
  onChanged(callback: (snapshot: TabsSnapshot) => void): () => void;
}

/** preload 的 tabs 能力；浏览器里返回 null。 */
export function tabsApi(): TabsApi | null {
  const bridge = (globalThis as unknown as { opencut?: { tabs?: TabsApi } }).opencut;
  const tabs = bridge?.tabs;
  return tabs !== undefined && typeof tabs.list === 'function' ? tabs : null;
}

/** 订阅主进程的标签快照；没有 tabs 能力时一直返回 null（= 不画标签栏）。 */
export function useTabs(): TabsSnapshot | null {
  const [snapshot, setSnapshot] = useState<TabsSnapshot | null>(null);
  useEffect(() => {
    const api = tabsApi();
    if (api === null) return;
    let alive = true;
    let changed = false;
    const off = api.onChanged((value) => {
      changed = true;
      if (alive) setSnapshot(value);
    });
    void api
      .list()
      .then((value) => {
        if (alive && !changed) setSnapshot(value);
      })
      .catch(() => {});
    return () => {
      alive = false;
      off();
    };
  }, []);
  return snapshot;
}

export interface TabBarProps {
  snapshot: TabsSnapshot;
  /** projectId → 工程名（来自 GET /api/projects；拿不到就用 id）。 */
  names: Record<string, string>;
  /** 点标签：切过去。 */
  onSelect: (projectId: string) => void;
  /** 点 ×：关掉。 */
  onClose: (projectId: string) => void;
}

export function TabBar(props: TabBarProps): ReactNode {
  const tabs = props.snapshot.projects;
  return createElement(
    'div',
    { className: 'tabbar', 'data-testid': 'tabbar', 'data-open': String(tabs.length) },
    tabs.map((tab) => {
      const name = props.names[tab.projectId] ?? tab.name ?? tab.projectId;
      const path = tab.path;
      return createElement(
        'div',
        {
          key: tab.projectId,
          className: 'tab',
          'data-testid': 'tab',
          'data-project-id': tab.projectId,
          'data-active': String(tab.projectId === props.snapshot.active),
          'data-name': name,
          title: path,
          onClick: () => props.onSelect(tab.projectId),
          onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
            if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
            event.preventDefault();
            event.stopPropagation();
            props.onSelect(tab.projectId);
          },
          role: 'tab',
          'aria-selected': tab.projectId === props.snapshot.active,
          tabIndex: 0,
        },
        createElement('span', { className: 'tab-name' }, name),
        createElement(
          'button',
          {
            type: 'button',
            className: 'tab-close',
            'data-testid': 'tab-close',
            title: '关闭标签',
            onClick: (event: { stopPropagation: () => void }) => {
              event.stopPropagation();
              props.onClose(tab.projectId);
            },
          },
          '×',
        ),
      );
    }),
    tabs.length === 0 ? createElement('span', { className: 'tab-empty', 'data-testid': 'tabbar-empty' }, '没有打开的工程') : null,
  );
}
