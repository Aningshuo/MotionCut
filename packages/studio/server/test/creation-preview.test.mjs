// @ts-nocheck -- Owned deterministic iframe VM; no browser, Studio, home or provider access.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { creationPreviewScript } from '../creation-preview.mjs';

async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function iframe({ motion = false, meta = {}, ready = 'promise', viewport = 'width=1280,height=720', width = 640, height = 360 } = {}) {
  const frames = [], listeners = new Map(), queued = [], forbidden = [], css = [], animations = [{ currentTime: 0, pauses: 0, pause() { this.pauses++; } }];
  const media = [{ duration: 0.5, currentTime: 0, pauses: 0, pause() { this.pauses++; } }, { duration: Number.NaN, currentTime: 0, pauses: 0, pause() { this.pauses++; } }];
  let now = 0, onResize, release, readyCalls = 0;
  const readyGate = new Promise(resolve => { release = resolve; });
  const film = { meta, frame: async time => { frames.push(time); } };
  film.ready = ready === 'function' ? function () { assert.equal(this, film, 'ready must retain the film receiver'); readyCalls++; return readyGate; } : readyGate;
  const style = {}, element = { style: { setProperty: (...args) => css.push(args) } };
  const parent = Object.freeze({ identity: 'only-parent' });
  const document = {
    documentElement: element, body: { style },
    querySelector: selector => { assert.equal(selector, 'meta[name="viewport"]'); return { getAttribute: name => { assert.equal(name, 'content'); return viewport; } }; },
    querySelectorAll: selector => { assert.equal(selector, 'video,audio'); return media; },
    getAnimations: () => animations,
  };
  const sandbox = { parent, document, innerWidth: width, innerHeight: height, performance: { now: () => now },
    addEventListener: (name, fn) => listeners.set(name, fn),
    requestAnimationFrame: fn => { queued.push(fn); return queued.length; },
    ResizeObserver: class { constructor(fn) { onResize = fn; } observe(target) { assert.equal(target, element); } }, film,
  };
  for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'localStorage', 'sessionStorage', 'opener', 'process', 'require']) Object.defineProperty(sandbox, name, { get() { forbidden.push(name); throw new Error(`preview must not access ${name}`); } });
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  const html = creationPreviewScript(motion); assert.ok(html.startsWith('<script>') && html.endsWith('</script>'));
  vm.runInContext(html.slice(8, -9), context, { timeout: 1000 });
  return { frames, queued, forbidden, media, animations, style, css, film, parent, release, get readyCalls() { return readyCalls; },
    message: async (data, source = parent) => { listeners.get('message')({ source, data }); await flush(); },
    tick: async milliseconds => { now = milliseconds; const fn = queued.shift(); assert.equal(typeof fn, 'function'); fn(milliseconds); await flush(); },
    resize: (w, h) => { sandbox.innerWidth = w; sandbox.innerHeight = h; onResize(); },
  };
}

for (const ready of ['promise', 'function']) test(`thumbnail executes ${ready} ready, draws one second and freezes animations/media without scheduling playback`, async () => {
  const f = iframe({ ready }); await flush(); assert.deepEqual(f.frames, []);
  assert.equal(f.readyCalls, ready === 'function' ? 1 : 0);
  f.release(); await flush(); assert.deepEqual(f.frames, [1]); assert.equal(f.queued.length, 0);
  assert.equal(f.animations[0].pauses, 1); assert.equal(f.animations[0].currentTime, 1000);
  assert.equal(f.media[0].pauses, 1); assert.equal(f.media[0].currentTime, 0.49, 'seek is capped just before short media end');
  assert.equal(f.media[1].pauses, 1); assert.equal(f.media[1].currentTime, 0, 'unknown media duration is never assigned an invalid time');
  await f.message({ type: 'opencut:resource-preview-control', time: 4, duration: 6, playing: true });
  assert.deepEqual(f.frames, [1], 'thumbnail ignores even parent playback commands'); assert.deepEqual(f.forbidden, []);
});

test('timeline thumbnails keep the latest requested source frame through load and zoom', async () => {
  const f = iframe({ meta: { duration: 8, previewTime: 3 } });
  const sample = ms => ({ type: 'opencut:thumbnail-time', ms });
  await f.message(sample(0));
  assert.deepEqual(f.frames, []);
  f.release();
  await flush();
  assert.deepEqual(f.frames, [0]);

  let finishFirst;
  f.film.frame = async time => {
    f.frames.push(time);
    if (time === 1) await new Promise(resolve => { finishFirst = resolve; });
  };
  await f.message(sample(1000));
  await f.message(sample(2500));
  await f.message(sample(5000), {});
  await f.message(sample(-10));
  finishFirst();
  await flush();
  assert.deepEqual(f.frames, [0, 1, 2.5]);
  assert.equal(f.animations[0].currentTime, 2500);
  assert.equal(f.queued.length, 0);
});

test('motion accepts only the parent control message, seeks and pauses, resumes and loops with a bounded frame step', async () => {
  const f = iframe({ motion: true, meta: { duration: 4 } }); f.release(); await flush(); assert.deepEqual(f.frames, [0]);
  await f.message({ type: 'opencut:resource-preview-control', time: 3, playing: false }, {});
  await f.message({ type: 'some-other-message', time: 3, playing: false }); assert.deepEqual(f.frames, [0]);
  await f.tick(50); assert.equal(f.frames.at(-1), 0.05, 'foreign messages did not pause the player');
  await f.message({ type: 'opencut:resource-preview-control', time: 2, playing: false }); assert.equal(f.frames.at(-1), 2);
  const pausedFrames = f.frames.length; await f.tick(5000); assert.equal(f.frames.length, pausedFrames);
  await f.message({ type: 'opencut:resource-preview-control', time: 3.95, duration: 4, playing: true });
  await f.tick(10000); assert.ok(Math.abs(f.frames.at(-1) - 0.05) < 1e-10, 'long stalls advance at most 100ms and loop at duration');
  assert.ok(f.media.every(node => node.pauses > 0)); assert.deepEqual(f.forbidden, []);
});

test('motion clamps finite time and duration, ignores invalid values, and reclamps when only duration shrinks', async () => {
  const f = iframe({ motion: true, meta: { duration: 2 } }); f.release(); await flush();
  await f.message({ type: 'opencut:resource-preview-control', time: -3, playing: false }); assert.equal(f.frames.at(-1), 0);
  await f.message({ type: 'opencut:resource-preview-control', duration: Number.POSITIVE_INFINITY, time: 20 }); assert.equal(f.frames.at(-1), 2);
  await f.message({ type: 'opencut:resource-preview-control', duration: -1, time: 3 }); assert.equal(f.frames.at(-1), 2);
  await f.message({ type: 'opencut:resource-preview-control', duration: 1e9, time: 1e9 }); assert.equal(f.frames.at(-1), 86400);
  await f.message({ type: 'opencut:resource-preview-control', duration: 2 }); assert.equal(f.frames.at(-1), 2, 'duration-only update cannot draw an out-of-range old time');
  await f.message({ type: 'opencut:resource-preview-control', time: Number.NaN, duration: '100', playing: 'true' }); assert.equal(f.frames.at(-1), 2);
  const pausedFrames = f.frames.length; await f.tick(100); assert.equal(f.frames.length, pausedFrames); assert.deepEqual(f.forbidden, []);
});

test('thumbnail previewTime respects actual duration and invalid duration falls back to a finite six seconds', async () => {
  const capped = iframe({ meta: { duration: 2, previewTime: 100 } }); capped.release(); await flush(); assert.deepEqual(capped.frames, [2]);
  const negative = iframe({ meta: { duration: 2, previewTime: -1 } }); negative.release(); await flush(); assert.deepEqual(negative.frames, [0]);
  const fallback = iframe({ motion: true, meta: { duration: Number.POSITIVE_INFINITY } }); fallback.release(); await flush();
  await fallback.message({ type: 'opencut:resource-preview-control', time: 10, playing: false }); assert.equal(fallback.frames.at(-1), 6);
  assert.deepEqual([...capped.forbidden, ...negative.forbidden, ...fallback.forbidden], []);
});

test('valid parent duration wins across delayed Promise/function readiness, while invalid control does not suppress metadata', async () => {
  for (const ready of ['promise', 'function']) {
    const f = iframe({ motion: true, ready, meta: { duration: 10 } });
    await f.message({ type: 'opencut:resource-preview-control', duration: 2, time: 1.9, playing: false });
    f.release(); await flush();
    await f.message({ type: 'opencut:resource-preview-control', time: 100 });
    assert.equal(f.frames.at(-1), 2, `${ready}: ready metadata cannot replace the parent's two-second range`);
    await f.message({ type: 'opencut:resource-preview-control', time: 1.95, playing: true }); await f.tick(100);
    assert.ok(Math.abs(f.frames.at(-1) - 0.05) < 1e-10, `${ready}: playback and the parent range loop together`);
    assert.deepEqual(f.forbidden, []);
  }
  const invalid = iframe({ motion: true, meta: { duration: 3 } });
  await invalid.message({ type: 'opencut:resource-preview-control', duration: Number.POSITIVE_INFINITY, playing: false });
  invalid.release(); await flush(); await invalid.message({ type: 'opencut:resource-preview-control', time: 100 });
  assert.equal(invalid.frames.at(-1), 3, 'invalid duration did not claim priority over valid scene metadata');
  assert.deepEqual(invalid.forbidden, []);
});

test('fit uses source viewport, contains and centers without crop, and responds to iframe resizing', async () => {
  const f = iframe({ viewport: 'width=1920,height=1080', width: 400, height: 400 });
  assert.equal(f.style.width, '1920px'); assert.equal(f.style.height, '1080px'); assert.equal(f.style.transformOrigin, '0 0');
  assert.equal(f.style.transform, 'translate(0px,87.5px) scale(0.20833333333333334)');
  f.resize(960, 270); assert.equal(f.style.transform, 'translate(240px,0px) scale(0.25)');
  const property = name => f.css.filter(([key]) => key === name).at(-1);
  assert.deepEqual(property('width'), ['width', '100%', 'important']);
  assert.deepEqual(property('height'), ['height', '100%', 'important']);
  assert.match(property('background')?.[1] ?? '', /repeating-conic-gradient/, 'transparent source gets a checkerboard without changing its fit');
  assert.equal(property('background')?.[2], 'important');
  assert.equal(f.style.transform, 'translate(240px,0px) scale(0.25)', 'checkerboard does not alter the body fit');
  assert.deepEqual(f.forbidden, []);
  f.release(); await flush();
});
