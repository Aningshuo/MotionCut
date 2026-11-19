/**
 * 最小 WebSocket 服务端（RFC 6455），只做 Studio 事件通道需要的部分。
 *
 * 为什么自己写：本仓锁里没有 `ws`，而主线不允许改依赖段/锁。事件通道只需要
 * 「握手 + 文本帧 + ping/pong + close」，实现面很窄；换成引入三方包会把锁定变更
 * 带进主线，代价更大。
 *
 * 明确不支持（遇到即拒绝，不假装支持）：二进制帧、扩展（permessage-deflate）、
 * 子协议协商。文本帧支持分片（continuation）。
 */

import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 4 * 1024 * 1024;

/** @typedef {{ send: (value: unknown) => void, close: (code?: number, reason?: string) => void, origin: string|null, remoteAddress: string|null, isOpen: () => boolean, on: (event: 'message'|'close', handler: (payload?: any) => void) => void, off: (event: 'message'|'close', handler: (payload?: any) => void) => void }} WsConnection */

/**
 * @param {import('node:http').Server} server
 * @param {{
 *   path?: string,
 *   isOriginAllowed?: (origin: string) => boolean,
 *   onConnection?: (connection: WsConnection, request: import('node:http').IncomingMessage) => void,
 *   onReject?: (info: { reason: string, origin?: string|null, remote?: string|null }) => void,
 *   heartbeatMs?: number,
 *   logger?: (line: string) => void,
 * }} [options]
 */
export function attachWebSocketServer(server, options = {}) {
  const path = options.path ?? '/events';
  const isOriginAllowed = options.isOriginAllowed ?? (() => false);
  const onConnection = options.onConnection ?? (() => undefined);
  const onReject = options.onReject ?? (() => undefined);
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const logger = options.logger ?? (() => undefined);

  /** @type {Set<ReturnType<typeof createConnection>>} */
  const sockets = new Set();

  /** @param {import('node:http').IncomingMessage} request @param {import('node:net').Socket} socket */
  /** @param {import('node:http').IncomingMessage} request @param {import('node:net').Socket} socket @param {Buffer} head */
  function handleUpgrade(request, socket, head) {
    const remote = socket.remoteAddress ?? null;
    let pathname = '';
    try {
      pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      pathname = '';
    }
    if (pathname !== path) {
      onReject({ reason: 'PATH_NOT_FOUND', remote });
      reject(socket, 404, 'Not Found', `events 通道在 ${path}`);
      return;
    }

    const originHeader = request.headers.origin;
    const origin = typeof originHeader === 'string' && originHeader !== '' ? originHeader : null;
    if (origin !== null && !isOriginAllowed(origin)) {
      onReject({ reason: 'ORIGIN_REJECTED', origin, remote });
      logger(`WS_ORIGIN_REJECTED origin=${origin} remote=${String(remote)}`);
      reject(socket, 403, 'Forbidden', `origin not allowed: ${origin}`);
      return;
    }

    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string' || key.trim() === '') {
      onReject({ reason: 'MISSING_KEY', origin, remote });
      reject(socket, 400, 'Bad Request', 'missing Sec-WebSocket-Key');
      return;
    }
    const version = request.headers['sec-websocket-version'];
    if (version !== undefined && version !== '13') {
      onReject({ reason: 'BAD_VERSION', origin, remote });
      reject(socket, 400, 'Bad Request', `unsupported Sec-WebSocket-Version: ${String(version)}`);
      return;
    }
    const upgrade = String(request.headers.upgrade ?? '').toLowerCase();
    if (upgrade !== 'websocket') {
      onReject({ reason: 'NOT_UPGRADE', origin, remote });
      reject(socket, 400, 'Bad Request', 'not a websocket upgrade');
      return;
    }

    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        '\r\n',
    );
    socket.setNoDelay?.(true);

    const connection = createConnection(socket, origin, remote);
    sockets.add(connection);
    connection.on('close', () => {
      sockets.delete(connection);
    });
    try {
      onConnection(connection, request);
    } catch (error) {
      logger(`WS_CONNECTION_HANDLER_FAILED ${String(/** @type {Error} */ (error).message)}`);
      connection.close(1011, 'handler failed');
    }
    if (head !== undefined && head.length > 0) connection.push(head);
  }

  server.on('upgrade', handleUpgrade);

  const heartbeat = setInterval(() => {
    for (const connection of sockets) connection.ping();
  }, heartbeatMs);
  heartbeat.unref();

  server.on('close', () => {
    clearInterval(heartbeat);
    for (const connection of sockets) connection.terminate();
    sockets.clear();
    server.off('upgrade', handleUpgrade);
  });

  return {
    connections: () => sockets.size,
    detach() {
      clearInterval(heartbeat);
      server.off('upgrade', handleUpgrade);
      for (const connection of sockets) connection.terminate();
      sockets.clear();
    },
  };
}

/**
 * @param {import('node:net').Socket} socket
 * @param {number} status
 * @param {string} statusText
 * @param {string} message
 */
function reject(socket, status, statusText, message) {
  const body = JSON.stringify({ ok: false, code: 'WS_REJECTED', message });
  try {
    socket.write(
      `HTTP/1.1 ${status} ${statusText}\r\n` +
        'Connection: close\r\n' +
        'content-type: application/json; charset=utf-8\r\n' +
        `content-length: ${Buffer.byteLength(body)}\r\n` +
        '\r\n' +
        body,
    );
  } catch {
    // 对端已断开：无需处理。
  }
  socket.destroy();
}

/**
 * @param {import('node:net').Socket} socket
 * @param {string|null} origin
 * @param {string|null} remote
 */
function createConnection(socket, origin, remote) {
  const listeners = { message: new Set(), close: new Set() };
  /** @type {Buffer} */
  let buffer = Buffer.alloc(0);
  /** @type {Buffer[]} */
  let fragments = [];
  let fragmentOpcode = 0;
  let open = true;
  let closed = false;

  const emit = (/** @type {'message'|'close'} */ event, /** @type {any} */ payload = undefined) => {
    for (const handler of listeners[event]) {
      try {
        handler(payload);
      } catch {
        // 处理器异常不影响其它订阅者。
      }
    }
  };

  const finish = () => {
    if (closed) return;
    closed = true;
    open = false;
    emit('close');
    try {
      socket.end();
    } catch {
      socket.destroy();
    }
  };

  /** @param {number} opcode @param {boolean} fin @param {Buffer} payload */
  function handleFrame(opcode, fin, payload) {
    if (opcode === 0x8) {
      // close：回一个 close 再断开。
      sendRaw(0x8, payload.subarray(0, Math.min(payload.length, 2)));
      finish();
      return;
    }
    if (opcode === 0x9) {
      sendRaw(0xa, payload);
      return;
    }
    if (opcode === 0xa) {
      lastSeen = Date.now();
      return;
    }
    if (opcode === 0x2) {
      close(1003, 'binary frames unsupported');
      return;
    }
    if (opcode === 0x1) {
      if (!fin) {
        fragments = [payload];
        fragmentOpcode = opcode;
        return;
      }
      emit('message', payload.toString('utf8'));
      return;
    }
    if (opcode === 0x0) {
      if (fragmentOpcode !== 0x1) {
        close(1002, 'unexpected continuation');
        return;
      }
      fragments.push(payload);
      if (!fin) return;
      const joined = Buffer.concat(fragments);
      fragments = [];
      fragmentOpcode = 0;
      emit('message', joined.toString('utf8'));
      return;
    }
    close(1002, `unsupported opcode ${opcode}`);
  }

  function drain() {
    while (open) {
      if (buffer.length < 2) return;
      const first = /** @type {number} */ (buffer[0]);
      const second = /** @type {number} */ (buffer[1]);
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_PAYLOAD)) {
          close(1009, 'payload too large');
          return;
        }
        length = Number(big);
        offset = 10;
      }
      if (length > MAX_PAYLOAD) {
        close(1009, 'payload too large');
        return;
      }
      if (!masked) {
        // RFC 6455 §5.1：客户端 → 服务端必须带掩码。
        close(1002, 'client frames must be masked');
        return;
      }
      if (buffer.length < offset + 4 + length) return;
      const mask = buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] = /** @type {number} */ (payload[index]) ^ (/** @type {number} */ (mask[index % 4]));
      }
      buffer = buffer.subarray(offset + length);
      handleFrame(opcode, fin, payload);
    }
  }

  /** @param {number} opcode @param {Buffer} payload */
  function sendRaw(opcode, payload) {
    if (!open) return;
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    try {
      socket.write(Buffer.concat([header, payload]));
    } catch {
      finish();
    }
  }

  let lastSeen = Date.now();

  socket.on('data', (chunk) => {
    lastSeen = Date.now();
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    drain();
  });
  socket.on('error', () => {
    finish();
  });
  socket.on('close', () => {
    finish();
  });
  socket.on('end', () => {
    finish();
  });

  /** @param {number} [code] @param {string} [reason] */
  function close(code = 1000, reason = '') {
    if (!open) return;
    const reasonBytes = Buffer.from(reason, 'utf8').subarray(0, 123);
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    sendRaw(0x8, payload);
    open = false;
    setTimeout(() => {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      finish();
    }, 10).unref?.();
  }

  return {
    origin,
    remoteAddress: remote,
    isOpen: () => open,
    /** @param {Buffer} chunk */
    push: (chunk) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      drain();
    },
    /** @param {unknown} value */
    send(value) {
      if (!open) return false;
      sendRaw(0x1, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8'));
      return true;
    },
    ping() {
      if (!open) return;
      sendRaw(0x9, Buffer.alloc(0));
    },
    close,
    terminate() {
      open = false;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      finish();
    },
    /** @param {'message'|'close'} event @param {(payload?: any) => void} handler */
    on(event, handler) {
      listeners[event].add(handler);
      return this;
    },
    /** @param {'message'|'close'} event @param {(payload?: any) => void} handler */
    off(event, handler) {
      listeners[event].delete(handler);
      return this;
    },
    lastSeen: () => lastSeen,
  };
}
