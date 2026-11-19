/**
 * 主线 M3/M4 测试公用工具：临时工程、WebSocket 客户端、Studio 起停。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, '..', '..', '..', '..');
export const fixturePath = join(repoRoot, 'tests', 'fixtures', 'main', 'film-basic.html');

/**
 * 造一个真实工程目录（复制夹具）。
 * @param {string} [label]
 */
export async function makeProject(label = 'proj') {
  const root = await mkdtemp(join(tmpdir(), `opencut-${label}-`));
  const dir = join(root, label);
  await mkdir(dir, { recursive: true });
  const text = await readFile(fixturePath, 'utf8');
  await writeFile(join(dir, 'film.html'), text, 'utf8');
  return {
    root,
    dir,
    filmPath: join(dir, 'film.html'),
    text,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** @param {number} ms */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 等一个条件成立（轮询），超时返回 false。
 * @param {() => boolean|Promise<boolean>} predicate
 * @param {number} timeoutMs
 * @param {number} stepMs
 */
export async function waitFor(predicate, timeoutMs = 3000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(stepMs);
  }
  return false;
}

/**
 * WebSocket 测试客户端：收到的消息按需取用（取过的不会重复返回）。
 * @param {string} url
 */
export function connectEvents(url) {
  const ws = new WebSocket(url);
  /** @type {any[]} */
  const messages = [];
  /** @type {{ predicate: (msg: any) => boolean, resolve: (msg: any) => void, reject: (err: Error) => void }[]} */
  const waiters = [];

  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(undefined), { once: true });
    ws.addEventListener('error', () => reject(new Error(`WebSocket 连接失败：${url}`)), { once: true });
  });

  ws.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      waiter?.resolve(message);
      return;
    }
    messages.push(message);
  });

  return {
    ws,
    messages,
    opened,
    /** @param {unknown} message */
    send(message) {
      ws.send(JSON.stringify(message));
    },
    /**
     * @param {(msg: any) => boolean} predicate
     * @param {number} [timeoutMs]
     */
    next(predicate, timeoutMs = 3000) {
      const index = messages.findIndex(predicate);
      if (index >= 0) {
        const [message] = messages.splice(index, 1);
        return Promise.resolve(message);
      }
      return new Promise((resolve, reject) => {
        /** @param {any} msg */
        const onResolve = (msg) => {
          clearTimeout(timer);
          resolve(msg);
        };
        const timer = setTimeout(() => {
          const position = waiters.findIndex((waiter) => waiter.resolve === onResolve);
          if (position >= 0) waiters.splice(position, 1);
          reject(new Error(`等待事件超时（${timeoutMs}ms）；已收消息：${JSON.stringify(messages).slice(0, 600)}`));
        }, timeoutMs);
        waiters.push({ predicate, resolve: onResolve, reject });
      });
    },
    close() {
      try {
        ws.close();
      } catch {
        // 已关闭
      }
    },
  };
}

/**
 * 订阅并等 `subscribed` 控制帧（补发帧在它之前到达，已被 next() 队列保留）。
 * @param {ReturnType<typeof connectEvents>} client
 * @param {number|null} since
 */
export async function subscribe(client, since = null) {
  client.send(since === null ? { type: 'subscribe' } : { type: 'subscribe', since });
  return client.next((msg) => msg.type === 'subscribed');
}

/**
 * POST JSON 到本地 Studio。
 * @param {string} url
 * @param {unknown} body
 * @param {string} [method]
 */
export async function postJson(url, body, method = 'POST') {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, body: payload };
}

/** @param {string} url */
export async function getJson(url) {
  const response = await fetch(url);
  const payload = await response.json().catch(() => null);
  return { status: response.status, body: payload };
}
