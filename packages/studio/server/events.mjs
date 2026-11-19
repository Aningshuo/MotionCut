/**
 * Studio 事件中枢（合同 contracts/events.ts v1.1.0）。
 *
 * 职责边界：这里只管「分配 seq、保留最近历史、按 since 补发/判 gap」，
 * 不理解也不做 IO；传输层（WebSocket）在 ws.mjs，HTTP 在 studio-server.mjs。
 *
 * 事件不是权威数据：客户端补发失败时必须 resync 后重新 `film.read`，不能拿事件当状态。
 */

/** @typedef {import('../../../contracts/events.ts').StudioEvent} StudioEvent */
/** @typedef {import('../../../contracts/events.ts').EventEnvelope} EventEnvelope */

/**
 * 保留最近多少条用于 since 补发。太小会让正常重连频繁 gap，太大只是内存；
 * 512 条对「一个工作台几十个标签」足够，且 gap 有明确 resync 兜底。
 */
export const DEFAULT_HISTORY_LIMIT = 512;

/**
 * @param {{
 *   now?: () => string,
 *   historyLimit?: number,
 *   startSeq?: number,
 * }} [options]
 */
export function createEventHub(options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  const historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  let seq = options.startSeq ?? 0;
  /** @type {EventEnvelope[]} */
  const history = [];
  /** @type {Set<{ envelope: (envelope: EventEnvelope) => void }>} */
  const subscribers = new Set();
  let closed = false;

  /**
   * 广播一条事件；返回分配的 seq（单调递增）。
   * @param {StudioEvent} event
   * @returns {number}
   */
  function publish(event) {
    if (closed) throw new Error('event hub 已关闭');
    seq += 1;
    /** @type {EventEnvelope} */
    const envelope = { seq, at: now(), event };
    // A catch-up after reconnect must not replay an old request to switch tabs.
    if (event.type !== 'agent.projectOpen') {
      history.push(envelope);
      if (history.length > historyLimit) history.splice(0, history.length - historyLimit);
    }
    for (const subscriber of subscribers) {
      try {
        subscriber.envelope(envelope);
      } catch {
        // 单个订阅者异常不影响广播；连接层自己会感知 close。
      }
    }
    return seq;
  }

  /**
   * @param {{
   *   since?: number|null,
   *   send: (envelope: EventEnvelope) => void,
   *   onResync?: (reason: 'gap'|'restart') => void,
   * }} input
   * @returns {{ unsubscribe: () => void, replayed: number, resync: 'gap'|'restart'|null, seq: number }}
   */
  function subscribe(input) {
    const subscriber = {
      envelope: (/** @type {EventEnvelope} */ envelope) => {
        input.send(envelope);
      },
    };
    /** @type {'gap'|'restart'|null} */
    let resync = null;
    let replayed = 0;
    const since = typeof input.since === 'number' && Number.isFinite(input.since) ? input.since : null;

    if (since !== null) {
      if (since > seq) {
        // 服务端重启后 seq 归零：客户端拿着更大的 since，必须让它全量刷新。
        resync = 'restart';
      } else {
        const oldest = history[0]?.seq ?? seq + 1;
        if (history.length > 0 && since + 1 < oldest) {
          resync = 'gap';
        } else {
          for (const envelope of history) {
            if (envelope.seq > since) {
              input.send(envelope);
              replayed += 1;
            }
          }
        }
      }
      if (resync !== null) input.onResync?.(resync);
    }

    subscribers.add(subscriber);
    return {
      unsubscribe: () => {
        subscribers.delete(subscriber);
      },
      replayed,
      resync,
      seq,
    };
  }

  return {
    /** @returns {number} */
    get seq() {
      return seq;
    },
    publish,
    subscribe,
    /** 当前订阅者数量（测试/排障用）。 */
    subscriberCount: () => subscribers.size,
    /** 最近一条 envelope（排障用）。 */
    last: () => history[history.length - 1] ?? null,
    history: () => history.slice(),
    close() {
      closed = true;
      subscribers.clear();
    },
  };
}

/**
 * 服务端重启后 seq 归零的显式信号：作为第一条事件发出，重连客户端（since=0）能拿到它。
 * @param {ReturnType<typeof createEventHub>} hub
 * @returns {number}
 */
export function publishRestart(hub) {
  return hub.publish({ type: 'resync', reason: 'restart' });
}
