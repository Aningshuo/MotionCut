/**
 * 渲染层入口。
 *
 * 顺序很重要：先装 `window.opencut`（浏览器下是同形状的 HTTP 桥），再装探针，最后挂 React。
 * 不用 StrictMode：它会在开发态把 effect 跑两遍（两条 WS 订阅、两次打开工程），
 * 让「一个工程一条订阅」的验收变得不确定。
 */

import { createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { installBridge, installProbe } from './bridge';
import { ElectronShell } from './shell';
import { initializeStudioTheme } from './studio-theme';

initializeStudioTheme();
installBridge();
installProbe();

const container = document.getElementById('root');
if (container === null) throw new Error('index.html 缺少 #root');

// `?shell=1` 是 Electron 窗口本体（标签栏 + 空态）；工程内容在各工程的 WebContentsView 里。
const isShell = new URLSearchParams(location.search).get('shell') === '1';
createRoot(container).render(createElement(isShell ? ElectronShell : App));
