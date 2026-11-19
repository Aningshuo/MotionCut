/**
 * M3-A1 ~ M3-A4：事件总线（WebSocket）。
 * 跑法：node --test packages/studio/server/test/events.test.mjs
 */

import assert from 'node:assert/strict';
import { connect } from 'node:net';
import test, { after, before } from 'node:test';

import { startStudio } from '../studio-server.mjs';
import { connectEvents, getJson, postJson, sleep, subscribe } from './helpers.mjs';

const quietLogger = () => undefined;

/** @type {Awaited<ReturnType<typeof startStudio>>} */
let studio;

before(async () => {
  studio = await startStudio({ port: 0, vitePort: 59370, debugEvents: true, logger: quietLogger });
});

after(async () => {
  await studio.close();
});

  test('M3-A1 连接 /events、subscribe 后收到递增 seq 的 envelope', async () => {
  const client = connectEvents(studio.eventsUrl);
  await client.opened;
  const subscribed = await subscribe(client, 0);
  assert.equal(subscribed.type, 'subscribed');

  const first = await postJson(`${studio.url}/api/events/publish`, {
    type: 'agent.update',
    projectId: 'p1',
    agentId: 'codex',
    state: 'ready',
  });
  assert.equal(first.status, 200);
  assert.ok(Number.isInteger(first.body.seq[0]));

  const envelope1 = await client.next((msg) => msg.event?.type === 'agent.update');
  assert.deepEqual(Object.keys(envelope1).sort(), ['at', 'event', 'seq']);
  assert.equal(envelope1.event.type, 'agent.update');
  assert.equal(typeof envelope1.at, 'string');
  assert.ok(envelope1.seq > 0);

  await postJson(`${studio.url}/api/events/publish`, {
    type: 'render.progress',
    jobId: 'job-1',
    state: 'running',
    framesDone: 1,
    framesTotal: 10,
  });
  const envelope2 = await client.next((msg) => msg.event?.type === 'render.progress');
  assert.ok(envelope2.seq > envelope1.seq, `seq 必须单调：${envelope1.seq} → ${envelope2.seq}`);
  assert.equal(envelope2.event.type, 'render.progress');
  client.close();
  });

  test('M3-A2 重连 since 补发；制造 gap 收到 resync', async () => {
  const port = studio.port;
  // 关闭 A1 用的 hub 断言值：直接对现有 hub 发事件，记录 seq。
  const published = [];
  for (let index = 0; index < 3; index += 1) {
    studio.hub.publish({
      type: 'render.progress',
      jobId: `replay-${index}`,
      state: 'waiting',
    });
    published.push(studio.hub.seq);
  }

  const replayer = connectEvents(`ws://127.0.0.1:${port}/events`);
  await replayer.opened;
  await subscribe(replayer, published[0]);
  const replayed = [];
  for (let index = 0; index < 2; index += 1) {
    replayed.push(await replayer.next((msg) => typeof msg.seq === 'number'));
  }
  assert.deepEqual(
    replayed.map((envelope) => envelope.seq),
    [published[1], published[2]],
    'since 之后的事件必须按序补发',
  );
  assert.ok(replayed.every((envelope) => envelope.event.type === 'render.progress'));
  replayer.close();

  // gap：历史上限小的独立 Studio，把老事件挤出去。
  const small = await startStudio({
    port: 0,
    vitePort: 59370,
    debugEvents: true,
    logger: quietLogger,
    eventHistoryLimit: 3,
  });
  try {
    for (let index = 0; index < 10; index += 1) {
      small.hub.publish({ type: 'render.progress', jobId: `gap-${index}`, state: 'running' });
    }
    const gapped = connectEvents(small.eventsUrl);
    await gapped.opened;
    await subscribe(gapped, 1);
    const resync = await gapped.next((msg) => msg.type === 'resync');
    assert.equal(resync.reason, 'gap');
    gapped.close();

    // 重启（seq 归零）：since 比当前 seq 大 → resync restart。
    const restarted = connectEvents(small.eventsUrl);
    await restarted.opened;
    await subscribe(restarted, 9999);
    const restart = await restarted.next((msg) => msg.type === 'resync');
    assert.equal(restart.reason, 'restart');
    restarted.close();
  } finally {
    await small.close();
  }
  });

  test('M3-A3 非白名单 Origin 被拒（403，且记录原因）', async () => {
  const response = await rawUpgrade(studio.port, '/events', 'http://evil.example');
  assert.match(response.statusLine, /HTTP\/1\.1 403/, `应拒绝非白名单 Origin，实际：${response.statusLine}`);

  const stats = await getJson(`${studio.url}/api/debug/ws-stats`);
  assert.equal(stats.status, 200);
  assert.ok(stats.body.rejected >= 1, '拒绝计数应至少为 1');
  assert.equal(stats.body.lastRejection.reason, 'ORIGIN_REJECTED');
  assert.equal(stats.body.lastRejection.origin, 'http://evil.example');

  // 自己的 origin 正常 101
  const allowed = await rawUpgrade(studio.port, '/events', `http://127.0.0.1:${studio.port}`);
  assert.match(allowed.statusLine, /HTTP\/1\.1 101/, `自身 origin 应建立连接，实际：${allowed.statusLine}`);
  allowed.socket.destroy();
  });

  test('M3-A4 /api/events 不再作为 UI 总线（410 + 指向 WebSocket）', async () => {
  const response = await getJson(`${studio.url}/api/events`);
  assert.equal(response.status, 410);
  assert.equal(response.body.code, 'UI_EVENTS_SSE_REMOVED');
  assert.equal(response.body.websocket, studio.eventsUrl);
  assert.match(response.body.message, /WebSocket/);
  assert.equal(response.body.transport, undefined);
  });

  test('subscribed 之后仍能拿到 ping → pong', async () => {
  const client = connectEvents(studio.eventsUrl);
  await client.opened;
  await subscribe(client, 0);
  client.send({ type: 'ping' });
  const pong = await client.next((msg) => msg.type === 'pong');
  assert.equal(typeof pong.at, 'string');
  client.close();
  await sleep(20);
  });

/**
 * 原始 HTTP Upgrade 请求（Node 的 WebSocket 客户端不能自定义 Origin）。
 * @param {number} port
 * @param {string} path
 * @param {string} origin
 */
function rawUpgrade(port, path, origin) {
return new Promise((resolve, reject) => {
  const socket = connect(port, '127.0.0.1');
  let buffer = '';
  const timer = setTimeout(() => {
    socket.destroy();
    reject(new Error('upgrade 响应超时'));
  }, 3000);
  socket.on('connect', () => {
    socket.write(
      `GET ${path} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
        'Sec-WebSocket-Version: 13\r\n' +
        `Origin: ${origin}\r\n` +
        '\r\n',
    );
  });
  socket.on('data', (chunk) => {
    buffer += chunk.toString('latin1');
    if (buffer.includes('\r\n')) {
      clearTimeout(timer);
      const statusLine = buffer.split('\r\n')[0] ?? '';
      // 403 会被服务端立即 destroy；101 保持连接，交给调用方处理。
      if (statusLine.includes('101')) {
        resolve({ statusLine, headers: buffer, socket });
      } else {
        socket.destroy();
        resolve({ statusLine, headers: buffer, socket });
      }
    }
  });
  socket.on('error', (error) => {
    clearTimeout(timer);
    reject(error);
  });
  });
}
