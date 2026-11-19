/**
 * 每工程视图 + 事件订阅管理（WP05，M4-A4）。
 *
 * 设计要点：
 * - 一个工程 = 一个视图实例 + 一条事件订阅。切标签只改可见性，**不销毁不重建**。
 * - 关标签：先退订（关闭该工程的 WebSocket），再销毁视图；订阅计数归零。
 * - 视图与订阅都由工厂注入，Electron 之外的测试可以用假实现验证「创建/复用/释放」的真实计数。
 */

/**
 * 最小 WebSocket 事件流：断线重连并用 `since` 续传；服务端说 resync 就交给上层全量刷新。
 * @param {{
 *   url: string,
 *   since?: number|null,
 *   WebSocketImpl?: any,
 *   onEnvelope?: (envelope: { seq: number, at: string, event: any }) => void,
 *   onResync?: (reason: 'gap'|'restart') => void,
 *   onStatus?: (status: { connected: boolean, lastSeq: number|null, reconnects: number, error?: string }) => void,
 *   reconnectDelayMs?: number,
 * }} options
 */
export function createEventStream(options) {
  const Impl = options.WebSocketImpl ?? globalThis.WebSocket;
  if (typeof Impl !== 'function') {
    throw new Error('当前运行时不支持 WebSocket：无法建立事件流');
  }
  const reconnectDelayMs = options.reconnectDelayMs ?? 600;
  /** @type {any} */
  let socket = null;
  let closed = false;
  let lastSeq = typeof options.since === 'number' ? options.since : null;
  let reconnects = 0;
  let attempts = 0;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  /** @type {{ connected: boolean, lastSeq: number|null, reconnects: number, error?: string }} */
  let status = { connected: false, lastSeq, reconnects, error: undefined };

  /** @param {{ connected?: boolean, error?: string }} [patch] */
  const notify = (patch = {}) => {
    status = { ...status, lastSeq, reconnects, ...patch };
    options.onStatus?.(status);
  };

  function connect() {
    if (closed) return;
    let ws;
    try {
      ws = new Impl(options.url);
    } catch (error) {
      notify({ connected: false, error: String(/** @type {Error} */ (error).message) });
      scheduleReconnect();
      return;
    }
    socket = ws;
    ws.addEventListener('open', () => {
      attempts = 0;
      notify({ connected: true, error: undefined });
      ws.send(JSON.stringify({ type: 'subscribe', ...(lastSeq === null ? {} : { since: lastSeq }) }));
    });
    ws.addEventListener('message', (/** @type {any} */ event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message?.type === 'resync') {
        lastSeq = null;
        options.onResync?.(message.reason === 'restart' ? 'restart' : 'gap');
        notify();
        return;
      }
      if (message?.type === 'subscribed' || message?.type === 'pong' || message?.type === 'error') return;
      if (typeof message?.seq === 'number') {
        if (lastSeq !== null && message.seq <= lastSeq) return;
        lastSeq = message.seq;
        options.onEnvelope?.(message);
        notify();
      }
    });
    const onGone = (/** @type {string} */ label, /** @type {unknown} */ error = undefined) => {
      if (socket !== ws) return;
      socket = null;
      notify({ connected: false, error: label });
      if (!closed) scheduleReconnect();
      void error;
    };
    ws.addEventListener('close', () => onGone('closed'));
    ws.addEventListener('error', (/** @type {unknown} */ error) => onGone('error', error));
  }

  function scheduleReconnect() {
    if (closed || timer !== null) return;
    attempts += 1;
    const delay = Math.min(reconnectDelayMs * attempts, 5000);
    timer = setTimeout(() => {
      timer = null;
      reconnects += 1;
      connect();
    }, delay);
    timer.unref?.();
  }

  connect();

  return {
    close() {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const ws = socket;
      socket = null;
      notify({ connected: false });
      try {
        ws?.close();
      } catch {
        // 已断开
      }
    },
    status: () => ({ ...status }),
    isClosed: () => closed,
    lastSeq: () => lastSeq,
  };
}

/**
 * Bind a native tab to the exact project the renderer will load.
 * @param {string} studioOrigin
 * @param {{ projectId?: unknown, url?: unknown } | null | undefined} input
 * @returns {{ ok: true, projectId: string, url: string, inert: boolean } | { ok: false, code: string, message: string }}
 */
export function resolveProjectTab(studioOrigin, input) {
  const projectId = typeof input?.projectId === 'string' ? input.projectId : '';
  if (projectId === '') return { ok: false, code: 'INVALID', message: 'projectId 必填' };
  const defaultUrl = `${studioOrigin}/?project=${encodeURIComponent(projectId)}`;
  const href = typeof input?.url === 'string' && input.url !== '' ? input.url : defaultUrl;
  let url;
  try {
    url = new URL(href);
  } catch {
    return { ok: false, code: 'URL_REJECTED', message: '工程视图地址无效' };
  }
  const validId = /^[a-f0-9]{16}$/.test(projectId);
  // The desktop smoke harness uses an inert view and non-project keys.
  if (url.protocol === 'about:' && url.pathname === 'blank' && url.search === '') {
    if (validId) return { ok: false, code: 'URL_REJECTED', message: '工程标签必须加载剪辑器' };
    return { ok: true, projectId, url: url.href, inert: true };
  }
  const ids = url.searchParams.getAll('project');
  if (url.origin !== studioOrigin || url.pathname !== '/' || url.username || url.password
    || url.searchParams.has('shell') || ids.length !== 1 || ids[0] !== projectId) {
    return { ok: false, code: 'URL_REJECTED', message: '工程视图地址与工程标识不一致' };
  }
  if (!validId) {
    return { ok: false, code: 'INVALID', message: '工程标识无效' };
  }
  return { ok: true, projectId, url: url.href, inert: false };
}

/**
 * @param {{
 *   createView: (input: { projectId: string, url: string }) => {
 *     show: () => void, hide: () => void, destroy: () => void,
 *     send: (channel: string, payload: unknown) => void,
 *   },
 *   eventsUrlFor?: (projectId: string) => string|null,
 *   streamFactory?: (options: any) => { close: () => void, status: () => any },
 *   onEventChannel?: string,
 *   tabsChannel?: string,
 *   onChange?: (snapshot: any) => void,
 * }} options
 */
export function createViewManager(options) {
  const eventsUrlFor = options.eventsUrlFor ?? (() => null);
  const streamFactory = options.streamFactory ?? createEventStream;
  const channel = options.onEventChannel ?? 'opencut:event';
  const tabsChannel = options.tabsChannel ?? 'opencut:tabs-changed';
  /** @type {Map<string, any>} */
  const views = new Map();
  /** @type {Map<string, { creations: number, subscriptions: number, lastStatus: any }>} */
  const counters = new Map();
  const totals = { created: 0, destroyed: 0, subscriptionsOpened: 0, subscriptionsClosed: 0 };
  /** @type {string|null} */
  let activeId = null;

  /** @param {string} projectId */
  function counterFor(projectId) {
    let entry = counters.get(projectId);
    if (entry === undefined) {
      entry = { creations: 0, subscriptions: 0, lastStatus: null };
      counters.set(projectId, entry);
    }
    return entry;
  }

  /**
   * @param {{ projectId: string, url: string, name?: string, path?: string, eventsUrl?: string }} input
   */
  function open(input) {
    const existing = views.get(input.projectId);
    if (existing !== undefined) {
      if (input.name !== undefined) existing.name = input.name;
      if (input.path !== undefined) existing.path = input.path;
      activate(input.projectId);
      return { ok: true, created: false, projectId: input.projectId };
    }
    const view = options.createView({ projectId: input.projectId, url: input.url });
    const counter = counterFor(input.projectId);
    counter.creations += 1;
    totals.created += 1;

    let stream = null;
    const eventsUrl = input.eventsUrl ?? eventsUrlFor(input.projectId);
    if (typeof eventsUrl === 'string' && eventsUrl !== '') {
      stream = streamFactory({
        url: eventsUrl,
        onEnvelope: (envelope) => {
          if (envelope?.event?.projectId === undefined || envelope.event.projectId === input.projectId) {
            view.send(channel, envelope);
          }
        },
        onResync: (reason) => view.send(channel, { type: 'resync', reason }),
        onStatus: (status) => {
          counter.lastStatus = status;
        },
      });
      counter.subscriptions = 1;
      totals.subscriptionsOpened += 1;
    }

    views.set(input.projectId, { projectId: input.projectId, name: input.name, path: input.path, url: input.url, view, stream });
    activate(input.projectId);
    return { ok: true, created: true, projectId: input.projectId };
  }

  /** @param {string} projectId */
  function activate(projectId) {
    const entry = views.get(projectId);
    if (entry === undefined) return { ok: false, code: 'FILM_NOT_FOUND' };
    for (const [id, other] of views) {
      if (id === projectId) other.view.show();
      else other.view.hide();
    }
    activeId = projectId;
    emit();
    return { ok: true, active: activeId };
  }

  function home() {
    if (activeId !== null) views.get(activeId)?.view.hide();
    activeId = null;
    emit();
    return { ok: true, active: activeId };
  }

  /** @param {string} projectId */
  function close(projectId) {
    const entry = views.get(projectId);
    if (entry === undefined) return { ok: false, code: 'FILM_NOT_FOUND' };
    // 先退订再销毁：关闭标签后不再有该工程的事件流入。
    try {
      entry.stream?.close?.();
    } catch {
      // 已关闭
    }
    const counter = counterFor(projectId);
    if (entry.stream !== null) {
      totals.subscriptionsClosed += 1;
      counter.subscriptions = 0;
    }
    try {
      entry.view.destroy();
    } finally {
      views.delete(projectId);
      totals.destroyed += 1;
    }
    if (activeId === projectId) {
      activeId = views.size > 0 ? [...views.keys()][views.size - 1] ?? null : null;
      if (activeId !== null) views.get(activeId)?.view.show();
    }
    emit();
    return { ok: true, closed: projectId, active: activeId };
  }

  /** 广播（只发给各视图的 webContents，不经过事件总线）。 */
  /** @param {unknown} payload */
  function broadcast(payload) {
    for (const entry of views.values()) entry.view.send(channel, payload);
    return views.size;
  }

  /**
   * 把标签快照推给**每个视图**（M16）。
   *
   * 标签栏由每个 Studio 页面各画一份，所以快照不能只发给窗口本体——否则后开的视图
   * 拿到的是自己挂载那一刻的旧快照，标签数会停在 1。
   * @param {unknown} snapshot
   */
  function broadcastTabs(snapshot) {
    for (const entry of views.values()) entry.view.send(tabsChannel, snapshot);
    return views.size;
  }

  function snapshot() {
    return {
      active: activeId,
      open: views.size,
      created: totals.created,
      destroyed: totals.destroyed,
      subscriptions: [...views.values()].filter((entry) => entry.stream !== null).length,
      subscriptionsOpened: totals.subscriptionsOpened,
      subscriptionsClosed: totals.subscriptionsClosed,
      projects: [...views.values()].map((entry) => ({
        projectId: entry.projectId,
        name: entry.name,
        path: entry.path,
        url: entry.url,
        subscribed: entry.stream !== null,
        creations: counterFor(entry.projectId).creations,
        lastStatus: counterFor(entry.projectId).lastStatus,
      })),
    };
  }

  function emit() {
    options.onChange?.(snapshot());
  }

  return {
    open,
    activate,
    home,
    close,
    broadcast,
    broadcastTabs,
    snapshot,
    /** @param {string} projectId */
    creationCount: (projectId) => counterFor(projectId).creations,
    /** @param {string} projectId */
    subscriptionCount: (projectId) => {
      const entry = views.get(projectId);
      return entry !== undefined && entry.stream !== null ? 1 : 0;
    },
    closeAll() {
      for (const id of [...views.keys()]) close(id);
    },
  };
}
