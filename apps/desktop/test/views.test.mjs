// @ts-nocheck
// 运行时测试：类型由源文件（tsc --checkJs）保证；测试里大量断言会让联合类型收窄成本高于收益。
/**
 * M4-A4：每工程独立视图实例；切标签不重建；关标签释放订阅。
 * 跑法：node --test apps/desktop/test/views.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { startStudio } from '../../../packages/studio/server/studio-server.mjs';
import { createEventStream, createViewManager, resolveProjectTab } from '../src/views.mjs';

/** 假视图：记录 show/hide/destroy/send，验证「切标签不重建」。 */
function createFakeViewFactory() {
  /** @type {any[]} */
  const instances = [];
  let sequence = 0;
  return {
    instances,
    /** @param {{ projectId: string, url: string }} input */
    createView({ projectId, url }) {
      sequence += 1;
      const view = {
        id: sequence,
        projectId,
        url,
        shown: false,
        destroyed: false,
        /** @type {any[]} */
        sent: [],
        show() {
          this.shown = true;
        },
        hide() {
          this.shown = false;
        },
        destroy() {
          this.destroyed = true;
        },
        /** @param {string} channel @param {unknown} payload */
        send(channel, payload) {
          this.sent.push({ channel, payload });
        },
      };
      instances.push(view);
      return view;
    },
  };
}

/** 假事件流：记录开关次数，用来验证关标签会退订。 */
function createFakeStreamFactory() {
  /** @type {any[]} */
  const streams = [];
  return {
    streams,
    /** @param {any} options */
    factory(options) {
      const stream = {
        url: options.url,
        closed: false,
        close() {
          this.closed = true;
        },
        status: () => ({ connected: true }),
      };
      streams.push(stream);
      return stream;
    },
  };
}

test('M4-A4 每工程独立视图：切标签不重建，关标签释放订阅', () => {
  const views = createFakeViewFactory();
  const streams = createFakeStreamFactory();
  const manager = createViewManager({
    createView: views.createView,
    eventsUrlFor: (projectId) => `ws://127.0.0.1:1/events?project=${projectId}`,
    streamFactory: streams.factory,
  });

  const openA = manager.open({ projectId: 'alpha', url: 'about:blank#alpha' });
  const openB = manager.open({ projectId: 'beta', url: 'about:blank#beta' });
  assert.equal(openA.created, true);
  assert.equal(openB.created, true);
  assert.equal(views.instances.length, 2, '两个工程必须有两个独立视图实例');
  assert.equal(streams.streams.length, 2, '两个工程必须各有一条事件订阅');

  manager.activate('alpha');
  manager.activate('beta');
  manager.activate('alpha');
  assert.equal(views.instances.length, 2, '切换标签不得重建视图');
  assert.equal(manager.creationCount('alpha'), 1);
  assert.equal(manager.creationCount('beta'), 1);
  assert.equal(views.instances[0].destroyed, false);

  const reopened = manager.open({ projectId: 'alpha', url: 'about:blank#other' });
  assert.equal(reopened.created, false, '重复打开只聚焦，不建第二个实例');
  assert.equal(views.instances.length, 2);
  assert.equal(manager.snapshot().subscriptions, 2);

  const closed = manager.close('alpha');
  assert.equal(closed.ok, true);
  assert.equal(views.instances[0].destroyed, true);
  assert.equal(streams.streams[0].closed, true, '关标签必须先退订');
  assert.equal(manager.subscriptionCount('alpha'), 0);
  assert.equal(manager.subscriptionCount('beta'), 1);
  assert.equal(manager.snapshot().subscriptions, 1);
  assert.equal(manager.snapshot().destroyed, 1);
  assert.equal(manager.snapshot().active, 'beta');

  manager.closeAll();
  assert.equal(manager.snapshot().open, 0);
  assert.equal(manager.snapshot().subscriptions, 0);
  assert.ok(streams.streams.every((stream) => stream.closed === true));
});

test('M4-A4 真实事件流：订阅后收到 envelope，close() 后服务端订阅数归零', async () => {
  const studio = await startStudio({ port: 0, vitePort: 59370, debugEvents: true, logger: () => undefined });
  try {
    /** @type {any[]} */
    const received = [];
    const stream = createEventStream({
      url: studio.eventsUrl,
      onEnvelope: (envelope) => received.push(envelope),
    });

    // 等连接建立后发布一条事件。
    const deadline = Date.now() + 3000;
    while (studio.hub.subscriberCount() === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(studio.hub.subscriberCount(), 1, '事件流应已订阅');

    studio.hub.publish({ type: 'agent.update', projectId: 'alpha', agentId: 'codex', state: 'ready' });
    while (received.length === 0 && Date.now() < deadline + 2000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(received.length, 1);
    assert.equal(received[0].event.type, 'agent.update');
    assert.equal(typeof received[0].seq, 'number');

    stream.close();
    const gone = Date.now() + 3000;
    while (studio.hub.subscriberCount() !== 0 && Date.now() < gone) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(studio.hub.subscriberCount(), 0, 'close() 后必须退订');
  } finally {
    await studio.close();
  }
});

test('工程标签校验地址与同一个工程 ID，防止串用另一个剪辑台入口', () => {
  const studio = 'http://127.0.0.1:57009';
  const projectId = '0123456789abcdef';
  const other = '123456789abcdef0';
  assert.deepEqual(resolveProjectTab(studio, { projectId }), {
    ok: true,
    projectId,
    url: `${studio}/?project=${projectId}`,
    inert: false,
  });
  assert.equal(resolveProjectTab(studio, { projectId, url: `${studio}/?project=${projectId}&diag=1` }).ok, true);
  for (const url of [
    `${studio}/?project=${other}`,
    `${studio}/?project=${projectId}&project=${other}`,
    `${studio}/?shell=1&project=${projectId}`,
    `${studio}/`,
    `${studio}/other?project=${projectId}`,
    `http://example.com/?project=${projectId}`,
    'about:blank#a',
  ]) {
    assert.equal(resolveProjectTab(studio, { projectId, url }).code, 'URL_REJECTED', url);
  }
  assert.equal(resolveProjectTab(studio, { projectId: 'smoke-a', url: 'about:blank#a' }).inert, true);
});

test('主页隐藏工程视图，同名工程保留各自路径、事件、选中状态和实例', () => {
  const fake = createFakeViewFactory();
  const hooks = [];
  const manager = createViewManager({
    createView: fake.createView,
    eventsUrlFor: () => 'ws://local/events',
    streamFactory: (options) => {
      hooks.push(options);
      return { close() {}, status: () => ({}) };
    },
  });
  const alpha = { projectId: 'alpha', name: '演示', path: '/first/演示', url: 'editor-alpha' };
  const beta = { projectId: 'beta', name: '演示', path: '/second/演示', url: 'editor-beta' };
  manager.open(alpha);
  manager.open(beta);
  hooks[0].onEnvelope({ event: { type: 'doc.changed', projectId: 'beta' } });
  hooks[0].onEnvelope({ event: { type: 'doc.changed', projectId: 'alpha' } });
  assert.deepEqual(fake.instances[0].sent.map((item) => item.payload.event.projectId), ['alpha']);
  assert.deepEqual(manager.snapshot().projects.map((tab) => [tab.projectId, tab.name, tab.path]), [
    ['alpha', '演示', '/first/演示'],
    ['beta', '演示', '/second/演示'],
  ]);
  assert.deepEqual(manager.home(), { ok: true, active: null });
  assert.equal(manager.snapshot().open, 2);
  assert.ok(fake.instances.every((view) => !view.shown && !view.destroyed));
  assert.equal(manager.open(beta).created, false);
  assert.equal(manager.snapshot().active, 'beta');
  assert.equal(manager.snapshot().created, 2);
  manager.home();
  manager.close('beta');
  assert.equal(manager.snapshot().active, null);
  assert.equal(fake.instances[0].shown, false);
  manager.activate('alpha');
  assert.equal(fake.instances[0].shown, true);
  manager.close('alpha');
  assert.equal(manager.snapshot().active, null);
  assert.equal(manager.snapshot().subscriptions, 0);
});
