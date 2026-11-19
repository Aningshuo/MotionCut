// @ts-nocheck —— 以 node --test 的运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * 导出动效相位（M33 · B-MAIN-R17-017）的单测。
 *
 * 这里锁三件事：
 *
 * 1. **口径只有一份**：舞台运行时里那行注入的，就是 `scene-runtime/motion-time.mjs`
 *    的 `writeMotionTime` 源码原文（`Function.prototype.toString`），不是手抄的副本。
 * 2. **源码能塞进那段模板串**：函数体里不能有反引号或 `${`（有就会把 STAGE_RUNTIME
 *    撕成两半——这个错在浏览器里表现为整页白屏，光看 diff 看不出来）。
 * 3. **行为对**：`t < at` 给 0；`t - at` 换成毫秒；有 `[data-instance]` 写实例根、
 *    没有写 documentElement；跨源 iframe 跳过并计数、不抛。
 *
 * 真导出的三帧/两次 sha/面板警示由 `scripts/m33-motion-export.mjs` 在浏览器里验。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { localMsOf, writeMotionTime } from '../../../scene-runtime/motion-time.mjs';
import { MOTION_TIME_SOURCE, startContentOrigin } from '../content-origin.mjs';

const BACKTICK = String.fromCharCode(96);
const DOLLAR_BRACE = `$${'{'}`;

/**
 * 极小的假 DOM：只实现 writeMotionTime 用到的那几个口子。
 * @param {{roots?: any[], frames?: any[]}} shape
 */
function fakeDocument(shape) {
  const doc = {
    documentElement: {
      style: { values: {}, setProperty(name, value) { this.values[name] = value; } },
      attrs: {},
      setAttribute(name, value) { this.attrs[name] = value; },
    },
    roots: shape.roots ?? [],
    frames: shape.frames ?? [],
    querySelectorAll(selector) {
      if (selector === '[data-instance]') return doc.roots;
      if (selector === 'iframe,frame') return doc.frames;
      return [];
    },
  };
  return doc;
}

/** @param {string} instanceId @param {string} at */
function fakeRoot(instanceId, at) {
  return {
    style: { values: {}, setProperty(name, value) { this.values[name] = value; } },
    attrs: { 'data-instance': instanceId },
    setAttribute(name, value) { this.attrs[name] = value; },
    getAttribute(name) { return this.attrs[name] ?? null; },
    closest(selector) {
      if (selector !== '[at]') return null;
      return { getAttribute: () => at };
    },
  };
}

/** @param {any} doc @param {string|null} at */
function fakeFrame(doc, at) {
  return {
    contentDocument: doc,
    getAttribute() {
      return at;
    },
  };
}

/** 把注入的那段源码单独编译成一个函数（不跑整个舞台运行时）。 */
function injected() {
  // eslint-disable-next-line no-new-func
  return new Function(`return (${MOTION_TIME_SOURCE});`)();
}

test('M33-1 注入的是 motion-time.mjs 的源码原文（不是第二份实现）', () => {
  assert.equal(MOTION_TIME_SOURCE, writeMotionTime.toString(), '必须是同一个函数对象的 toString');
  assert.equal(MOTION_TIME_SOURCE.includes('function writeMotionTime'), true);
  // 口径字符串就在源码里，抄错一个字都能看出来
  assert.equal(MOTION_TIME_SOURCE.includes("'--motion-t'"), true);
  assert.equal(MOTION_TIME_SOURCE.includes("'data-instance'"), true);
  assert.equal(MOTION_TIME_SOURCE.includes('crossOrigin'), true);
});

test('M33-2 源码里不能有反引号或 ${（会撕裂 STAGE_RUNTIME 模板串）', () => {
  assert.equal(MOTION_TIME_SOURCE.includes(BACKTICK), false, '函数体里出现了反引号');
  assert.equal(MOTION_TIME_SOURCE.includes(DOLLAR_BRACE), false, '函数体里出现了 ${');
});

test('M33-3 t < at 给 0；t > at 给 (t-at)*1000 毫秒', () => {
  const fn = injected();
  const root = fakeRoot('badge', '0.4');
  const doc = fakeDocument({ roots: [root] });

  // writeMotionTime 读的是**全局** document（自包含函数的约定），Node 里用一个最小 shim 顶上。
  const previous = globalThis.document;
  globalThis.document = doc;
  try {
    const early = fn(0.1);
    assert.equal(early.entries[0].ms, 0, 't < at 必须是 0（不给负值）');
    assert.equal(root.style.values['--motion-t'], '0');
    assert.equal(root.attrs['data-motion-t'], '0');

    const mid = fn(1);
    assert.equal(mid.entries[0].ms, 600, '(1.0 - 0.4) * 1000 = 600');
    assert.equal(root.style.values['--motion-t'], '600');
    assert.equal(mid.entries[0].scope, 'instance');
    assert.equal(mid.entries[0].at, 0.4);

    // 与模块自己的纯函数同口径（同一 t / 同一 at）
    assert.equal(mid.entries[0].ms, localMsOf(1, 0.4));
    assert.equal(localMsOf(0.1, 0.4), 0);
  } finally {
    globalThis.document = previous;
  }
});

test('M33-4 没有 data-instance 时写 documentElement；跨源 iframe 跳过并计数', () => {
  const fn = injected();
  const inner = fakeDocument({ roots: [] });
  const scene = fakeDocument({ roots: [], frames: [fakeFrame(inner, '0')] });
  const crossOrigin = fakeFrame(null, '0');
  const film = fakeDocument({ roots: [], frames: [fakeFrame(scene, '0.4'), crossOrigin] });

  const previous = globalThis.document;
  globalThis.document = film;
  try {
    const stats = fn(2);
    assert.equal(stats.crossOrigin, 1, '跨源 iframe 必须计数');
    assert.equal(stats.written, 3, 'film / scene / template 三层各写一次 documentElement');
    // 三层都走 document 兜底：at 由 frame 链累加（0 + 0.4 + 0）
    assert.equal(film.documentElement.style.values['--motion-t'], '2000');
    assert.equal(scene.documentElement.style.values['--motion-t'], '1600');
    assert.equal(inner.documentElement.style.values['--motion-t'], '1600');
    assert.deepEqual(
      stats.entries.map((item) => [item.scope, item.ms]),
      [
        ['document', 2000],
        ['document', 1600],
        ['document', 1600],
      ],
    );
  } finally {
    globalThis.document = previous;
  }
});

test('M33-5 两个实例 at 差 0.4s：同一 t 下 ms 差 400', () => {
  const fn = injected();
  const a = fakeRoot('a', '0');
  const b = fakeRoot('b', '0.4');
  const scene = fakeDocument({ roots: [a, b] });

  const previous = globalThis.document;
  globalThis.document = scene;
  try {
    fn(1);
    assert.equal(a.style.values['--motion-t'], '1000');
    assert.equal(b.style.values['--motion-t'], '600');
    assert.equal(Number(a.attrs['data-motion-t']) - Number(b.attrs['data-motion-t']), 400);
  } finally {
    globalThis.document = previous;
  }
});

test('M33-6 服务端生成的 runtime.js 能编译（模板串没被源码撕开）', async () => {
  const origin = await startContentOrigin({
    // runtime.js 只要求工程「已打开」，不读盘：一个空壳登记就够。
    registry: { get: () => ({ dir: '/tmp' }), docOf: () => null },
    port: 0,
    host: '127.0.0.1',
  });
  try {
    const response = await fetch(`${origin.origin}/p/whatever/__stage__/runtime.js`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.equal(body.includes(MOTION_TIME_SOURCE), true, '运行时里必须是同一段源码');
    assert.equal(body.includes('applyMotionTime(t)'), true, 'drawNow 里要有调用点');
    assert.doesNotThrow(() => new Function(body), 'runtime.js 语法必须通过（否则整页白屏）');
  } finally {
    await origin.close();
  }
});
