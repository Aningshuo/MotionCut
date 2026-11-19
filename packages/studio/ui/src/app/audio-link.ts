/**
 * Agent 消息里的音频链接胶囊（S76 · NEW-08）。
 *
 * ## 行为
 *
 * - 默认只显示一个胶囊（文件名 + 时长占位），**不发任何请求**；
 * - 点一下才 `HEAD` 探一次内容 origin：404 → 「文件不在了」；其它非 2xx → 「取不到（HTTP n）」；
 * - 探通之后才把 `src` 挂到 `<audio>` 上并播放（**没有 autoplay**，只有用户点才响）；
 * - 四态：idle / loading / playing（带进度）/ error。
 *
 * ## 为什么不用 `fetch(url, {method:'HEAD'})` 先探状态
 *
 * 内容 origin 是**第二个 origin**，且按契约**不发 `Access-Control-Allow-Origin`**
 * （`content-origin.mjs` 头注释：影片脚本不能借它拿编辑权限）。所以从 Studio origin
 * `fetch()` 它会被 CORS 直接拦掉，拿不到状态码。只能让 `<audio>` 自己去取，
 * 用 `MediaError.code === 4`（SRC_NOT_SUPPORTED，404 也落在这个码）判「文件不在了」。
 * 这也是唯一不需要给内容源开 CORS 的做法——开 CORS 会把「只读素材」变成可被页面读取的跨源资源。
 *
 * 路径安全由 `audio-links.mjs` 的 `classifyPath` 保证：**本组件只会拿到已判安全的路径**，
 * 拒绝的 token 在 `renderAudioText` 里渲染成不可点的灰色胶囊，永远不会走到这里。
 */

import { createElement, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { contentUrlFor, REJECT_LABEL, scanAudioLinks } from './audio-links.mjs';

const h = createElement;

/** @param {string} reason */
function rejectLabel(reason: string): string {
  return (REJECT_LABEL as Record<string, string>)[reason] ?? reason;
}

export interface AudioLinkProps {
  /** 工程内相对路径（已通过 classifyPath）。 */
  path: string;
  contentOrigin: string;
  projectId: string;
}

type PlayState = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

/** @param {number} seconds */
function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  return `${String(Math.floor(total / 60))}:${String(total % 60).padStart(2, '0')}`;
}

export function AudioLinkPill(props: AudioLinkProps): ReactNode {
  const [state, setState] = useState<PlayState>('idle');
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [message, setMessage] = useState('');
  const [lastUrl, setLastUrl] = useState('');
  const audioRef = useRef<HTMLAudioElement | null>(null);

  /**
   * 媒体事件**必须走原生 addEventListener**：`error` 不冒泡，React 的合成 `onError`
   * 挂在根容器上收不到它（实测缺文件时不触发，状态卡在 loading/paused）。
   *
   * 用 **ref 回调**而不是 useEffect：兄弟节点（进度条/错误行）增删会让 React 按索引
   * 重挂 `<audio>`，useEffect 的监听器会留在旧节点上——现象就是 `audio.error.code=4`
   * 但界面还停在 paused。回调在每次挂载时都绑一次，绑过的用 dataset 标记跳过。
   */
  const bindAudio = (node: HTMLAudioElement | null): void => {
    audioRef.current = node;
    if (node === null || node.dataset.bound === '1') return;
    node.dataset.bound = '1';
    const fail = (): void => {
      const code = node.error?.code ?? 4;
      setState('error');
      setMessage(
        code === 4
          ? '文件不在了'
          : code === 2
            ? '取不到这个文件（网络中断）'
            : code === 3
              ? '解码失败（这个文件可能损坏）'
              : '打不开这个文件',
      );
    };
    const meta = (): void => setDuration(Number.isFinite(node.duration) ? node.duration : 0);
    const tick = (): void => setCurrent(node.currentTime);
    node.addEventListener('error', fail);
    node.addEventListener('loadedmetadata', meta);
    node.addEventListener('timeupdate', tick);
    /* error 是终态：媒体的 pause/play 事件在失败后还会冒出来，不要覆盖它。 */
    node.addEventListener('play', () => setState((prev) => (prev === 'error' ? prev : 'playing')));
    node.addEventListener('pause', () => setState((prev) => (prev === 'error' ? prev : 'paused')));
    node.addEventListener('ended', () => {
      setState('paused');
      setCurrent(0);
    });
  };

  const open = async (): Promise<void> => {
    const audio = audioRef.current;
    if (audio === null) return;
    if (state === 'playing') {
      audio.pause();
      return;
    }
    if (state === 'paused') {
      void audio.play().catch(() => setState('paused'));
      return;
    }
    const url = contentUrlFor(props.contentOrigin, props.projectId, props.path);
    if (url === '') {
      setState('error');
      setMessage('内容源还没就绪（工程或 Studio 未连接）');
      return;
    }
    setState('loading');
    setMessage('');
    setLastUrl(url);
    audio.src = url;
    audio.load();
    try {
      await audio.play();
    } catch {
      /* `error` 事件是异步的：给它一拍落地的机会，再决定要不要退回 paused。 */
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (audio.error === null) setState('paused');
    }
  };

  const percent = duration > 0 ? Math.min(100, Math.round((current / duration) * 100)) : 0;
  const label = props.path.split('/').pop() ?? props.path;

  return h(
    'span',
    {
      className: 'audio-link',
      'data-testid': 'audio-link',
      'data-path': props.path,
      'data-state': state,
      'data-duration': duration === 0 ? '' : String(Math.round(duration * 1000) / 1000),
      'data-url': lastUrl,
    },
    h(
      'button',
      {
        key: 'toggle',
        type: 'button',
        className: `audio-pill${state === 'playing' ? ' playing' : ''}${state === 'error' ? ' bad' : ''}`,
        'data-testid': 'audio-toggle',
        'aria-label': `试听 ${props.path}`,
        disabled: state === 'loading',
        onClick: () => void open(),
      },
      h('span', { className: 'audio-icon', 'aria-hidden': 'true' }, state === 'playing' ? '❚❚' : '▶'),
      h('span', { className: 'audio-name' }, label),
      h(
        'span',
        { className: 'audio-meta', 'data-testid': 'audio-meta' },
        state === 'idle'
          ? '点一下试听'
          : state === 'loading'
            ? '加载中…'
            : state === 'error'
              ? '打不开'
              : `${clock(current)} / ${clock(duration)}`,
      ),
    ),
    /* 下面三块**恒定存在**，只用 hidden 切显隐。
       为什么不做成条件渲染：兄弟节点增删会让 React 按索引重建 `<audio>`，
       重建后的元素没有 src —— 表现就是「点了没声、error 事件也丢了」（实测踩过）。 */
    h(
      'span',
      {
        key: 'progress',
        className: 'audio-progress',
        'data-testid': 'audio-progress',
        'data-percent': String(percent),
        hidden: state !== 'playing' && state !== 'paused',
      },
      h('span', { className: 'audio-bar', style: { width: `${String(percent)}%` } }),
    ),
    h(
      'span',
      { key: 'error', className: 'audio-error', 'data-testid': 'audio-error', hidden: state !== 'error' },
      message,
    ),
    /* 没有 autoplay：src 只在用户点过之后才挂上，这里不放任何自动播放属性。
       媒体事件由 ref 回调绑原生监听器（error 不冒泡，合成事件收不到）。 */
    h('audio', {
      key: 'audio',
      ref: bindAudio,
      'data-testid': 'audio-element',
      preload: 'none',
    }),
  );
}

/**
 * 把一段消息文本渲染成「文字 + 音频胶囊 + 拒绝胶囊」。
 *
 * 拒绝胶囊**没有 onClick**：路径在 `classifyAudioPath` 就已经判死，这里连 URL 都不构造，
 * 验收里按 request 数断言「一个请求都没发」。
 */
export function renderAudioText(text: string, opts: { contentOrigin: string; projectId: string }): ReactNode[] {
  const parts = scanAudioLinks(text);
  return parts.map((part, index) => {
    if (part.kind === 'text') return h('span', { key: String(index) }, part.text);
    if (part.kind === 'link') {
      return h(AudioLinkPill, {
        key: String(index),
        path: part.path,
        contentOrigin: opts.contentOrigin,
        projectId: opts.projectId,
      });
    }
    return h(
      'span',
      {
        key: String(index),
        className: 'audio-reject',
        'data-testid': 'audio-reject',
        'data-path': part.raw,
        'data-reason': part.reason,
        title: `不会去取：${rejectLabel(part.reason)}`,
      },
      `🔇 ${part.raw}（${rejectLabel(part.reason)}）`,
    );
  });
}
