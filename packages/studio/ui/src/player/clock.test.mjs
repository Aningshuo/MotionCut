/**
 * M6-WP08 验收 A1–A9：播放时钟、状态机、seek 合并、代际令牌、逐帧/JKL、音画偏差。
 * 跑法：node --test packages/studio/ui/src/player/clock.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STATES,
  PENDING_FRAME,
  ClockError,
  canTransition,
  createPlaybackClock,
  createPlayer,
  measureAvDrift,
} from './clock.mjs';

const FPS_2997 = { num: 30000, den: 1001 };
const FPS_30 = { num: 30, den: 1 };

/** 可推进的假时钟（秒）。 */
/** @param {number} [start] */
function fakeClock(start = 0) {
  let value = start;
  return {
    now: () => value,
    /** @param {number} seconds */
    advance(seconds) {
      value += seconds;
    },
    /** @param {number} seconds */
    set(seconds) {
      value = seconds;
    },
  };
}

/** 立即 resolve 的帧 provider。 */
function immediateProvider() {
  /** @type {{ t: number, gen: number }[]} */
  const calls = [];
  return {
    calls,
    /** @param {{ t: number, gen: number }} input */
    async request({ t, gen }) {
      calls.push({ t, gen });
      return { t, gen, png: new Uint8Array([1]) };
    },
  };
}

test('A1 五个状态齐全；非法迁移被拒并报 STATE', async () => {
  assert.deepEqual([...STATES], ['idle', 'playing', 'paused', 'seeking', 'ended']);

  const clock = fakeClock();
  const provider = immediateProvider();
  const player = createPlaybackClock({ fps: FPS_30, now: clock.now, frameProvider: provider });
  assert.equal(player.state, 'idle');

  // 合法：idle → seeking → paused → playing → seeking → playing
  const first = player.seek(1);
  assert.equal(player.state, 'seeking');
  await first;
  assert.equal(player.state, 'paused');
  player.play();
  assert.equal(player.state, 'playing');
  const second = player.seek(2);
  assert.equal(player.state, 'seeking');
  await second;
  assert.equal(player.state, 'playing', '播放中跳转后应回到播放');
  player.pause();
  assert.equal(player.state, 'paused');

  // 非法：idle 不能直接 paused；ended 不能直接 paused
  assert.equal(canTransition('idle', 'paused'), false);
  assert.equal(canTransition('ended', 'paused'), false);
  // paused 不能直接跳到 ended（片尾只从播放推出）
  assert.equal(canTransition('paused', 'ended'), false);
  assert.throws(() => player.transitionTo('ended'), (/** @type {any} */ error) => error instanceof ClockError && error.code === 'STATE');
  assert.throws(() => player.transitionTo('nope'), (/** @type {any} */ error) => error.code === 'INVALID');

  // ended 只能从播放到片尾产生
  const shortClock = fakeClock(0);
  const short = createPlaybackClock({ fps: FPS_30, duration: 2, now: shortClock.now });
  short.play();
  shortClock.advance(2);
  assert.equal(short.tick().state, 'ended');
  assert.equal(canTransition('ended', 'playing'), true);
});

test('A2 连续 20 次 seek 只落 1 次最终帧（合并生效）', async () => {
  const provider = immediateProvider();
  const player = createPlaybackClock({ fps: FPS_30, duration: 100, now: () => 0, frameProvider: provider });

  const promises = [];
  for (let index = 1; index <= 20; index += 1) promises.push(player.seek(index * 0.5));
  await Promise.all(promises);

  const stats = player.stats();
  assert.equal(stats.rendered, 1, `落帧次数 ${stats.rendered}`);
  assert.equal(/** @type {any} */ (player.lastFrame).t, 10, '最后一次 seek 的位置');
  assert.equal(player.position(), 10);
  assert.ok(stats.coalesced >= 18, `合并次数 ${stats.coalesced}`);
});

test('A3 迟到 300ms 的帧不覆盖新位置（代际令牌）', async () => {
  /** @type {{ t: number, gen: number }[]} */
  const calls = [];
  const provider = {
    /** @param {{ t: number, gen: number }} input */
    async request({ t, gen }) {
      calls.push({ t, gen });
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { t, gen };
    },
  };
  const player = createPlaybackClock({ fps: FPS_30, duration: 100, now: () => 0, frameProvider: provider });

  const first = player.seek(1);
  const second = player.seek(2);
  await Promise.all([first, second]);
  await new Promise((resolve) => setTimeout(resolve, 700));

  assert.equal(player.position(), 2);
  assert.equal(/** @type {any} */ (player.lastFrame).t, 2, '最终落帧位置');
  const gens = calls.map((/** @type {any} */ call) => call.gen);
  assert.ok(gens[0] < gens[gens.length - 1], `代际应递增：${gens.join(',')}`);
  assert.equal(player.stats().rendered, 1);
});

test('A4 29.97 播 60s 累计漂移 < 1 帧（不逐帧累加）', () => {
  const clock = fakeClock(0);
  const player = createPlaybackClock({ fps: FPS_2997, duration: 120, now: clock.now });
  player.play();

  const tick = 1 / 60;
  let minFrame = 0;
  for (let index = 0; index < 3600; index += 1) {
    clock.advance(tick);
    const frame = player.frame();
    assert.ok(frame >= minFrame, '帧号回跳了');
    minFrame = frame;
  }

  const seconds = player.position();
  const exactFrames = (seconds * FPS_2997.num) / FPS_2997.den;
  const drift = Math.abs(exactFrames - Math.round(exactFrames));
  assert.ok(Math.abs(seconds - 60) < 1e-6, `60s 后位置 ${seconds}`);
  assert.ok(drift < 1, `漂移 ${drift} 帧`);
  // 60s 处 29.97 的整数帧应为 1798
  assert.equal(player.frame(), 1798);
});

test('A5 逐帧 ±1 精确停在相邻帧；JKL 速率 1x/2x/4x/-1x/-2x', async () => {
  const provider = immediateProvider();
  const player = createPlaybackClock({ fps: FPS_2997, duration: 100, now: () => 0, frameProvider: provider });
  const frameSeconds = FPS_2997.den / FPS_2997.num;

  const at100 = 100 * frameSeconds;
  await player.seek(at100);
  assert.equal(player.frame(), 100);

  const forward = player.step(1);
  await forward.done;
  assert.equal(forward.frame, 101);
  assert.equal(player.frame(), 101);
  assert.ok(Math.abs(forward.t - 101 * frameSeconds) < 1e-9);

  const back = player.step(-1);
  await back.done;
  assert.equal(back.frame, 100);
  assert.equal(player.frame(), 100);
  assert.ok(Math.abs(back.t - at100) < 1e-9);

  // 0 处不能退到负帧
  await player.seek(0);
  player.step(-1);
  assert.equal(player.frame(), 0);

  // JKL：停 → L=1x，再 L=2x，再 L=4x；K 停；J=-1x，再 J=-2x
  const jkl = createPlaybackClock({ fps: FPS_30, duration: 100, now: () => 0 });
  assert.equal(jkl.press('l').rate, 1);
  assert.equal(jkl.state, 'playing');
  assert.equal(jkl.press('l').rate, 2);
  assert.equal(jkl.press('l').rate, 4);
  assert.equal(jkl.press('l').rate, 4);
  assert.equal(jkl.press('k').state, 'paused');
  assert.equal(jkl.press('j').rate, -1);
  assert.equal(jkl.press('j').rate, -2);
  assert.equal(jkl.press('j').rate, -2);
  assert.throws(() => jkl.press(/** @type {any} */ ('x')), (/** @type {any} */ error) => error.code === 'INVALID');
  assert.throws(() => jkl.setRate(0), (/** @type {any} */ error) => error.code === 'INVALID');
  assert.throws(() => jkl.setRate(8), (/** @type {any} */ error) => error.code === 'INVALID');
});

test('A6 音画偏差 ≤ 1 帧（给出测量方法与数值）', () => {
  const frameSeconds = FPS_2997.den / FPS_2997.num;
  // 方法：取音频脉冲的采样时刻与「该脉冲首次出现在画面上」的那一帧的时间线时刻，
  // 差值为秒，乘 fps 得帧；|drift| ≤ 1 帧即合格。
  const perfect = measureAvDrift({ audioAt: 5.0, videoAt: 5.0, fps: FPS_2997 });
  assert.equal(perfect.driftFrames, 0);

  const halfFrame = measureAvDrift({ audioAt: 5.0, videoAt: 5 + frameSeconds / 2, fps: FPS_2997 });
  assert.ok(Math.abs(halfFrame.driftFrames - 0.5) < 1e-9);
  assert.ok(Math.abs(halfFrame.driftFrames) <= 1);

  // 时钟推导：音频时钟推进 5s，视频帧号应正好是 5s 对应的帧（不额外滞后）
  const audio = { currentTime: 0 };
  const player = createPlaybackClock({ fps: FPS_2997, duration: 100, audioClock: audio });
  player.play();
  audio.currentTime = 5;
  const videoAt = player.position();
  const drift = measureAvDrift({ audioAt: 5, videoAt, fps: FPS_2997 });
  assert.ok(Math.abs(drift.driftFrames) <= 1, `偏差 ${drift.driftFrames} 帧`);
  assert.equal(player.frame(), Math.floor((5 * FPS_2997.num) / FPS_2997.den));
});

test('A7 无音频时退化时钟仍单调，暂停不回跳', () => {
  const clock = fakeClock(0);
  const player = createPlaybackClock({ fps: FPS_30, duration: 30, now: clock.now });
  assert.equal(player.state, 'idle');
  player.play();

  let previous = -1;
  for (let index = 0; index < 600; index += 1) {
    clock.advance(1 / 60);
    const t = player.position();
    assert.ok(t >= previous, `回跳：${previous} → ${t}`);
    previous = t;
  }
  player.pause();
  const pausedAt = player.position();
  clock.advance(1);
  assert.equal(player.position(), pausedAt, '暂停后位置不该继续走');
  player.play();
  clock.advance(0.5);
  assert.ok(player.position() >= pausedAt, '恢复播放应从暂停处继续');
});

test('A8 没有 provider 时明确 PENDING_FRAME，不显示假画面', async () => {
  const player = createPlaybackClock({ fps: FPS_30, duration: 10, now: () => 0 });
  const result = await player.seek(2);
  assert.equal(result.ok, false);
  assert.equal(result.code, PENDING_FRAME);
  assert.equal(player.status, PENDING_FRAME);
  assert.equal(player.lastFrame, null);
  assert.equal(player.stats().rendered, 0);
  assert.equal(player.position(), 2, '播放头仍然移到目标位置（只是没有画面）');
});

test('A9 退出重开后播放头与状态回到确定初值', async () => {
  const provider = immediateProvider();
  const player = createPlaybackClock({ fps: FPS_30, duration: 20, now: () => 0, frameProvider: provider });
  await player.seek(7);
  player.play();
  assert.equal(player.state, 'playing');

  const reopened = createPlayer({ fps: FPS_30, duration: 20, now: () => 100, frameProvider: provider });
  assert.equal(reopened.state, 'idle');
  assert.equal(reopened.position(), 0);
  assert.equal(reopened.frame(), 0);

  const afterOpen = reopened.open();
  assert.deepEqual({ state: afterOpen.state, t: afterOpen.t, frame: afterOpen.frame }, { state: 'idle', t: 0, frame: 0 });

  // 新实例不会继承旧实例的播放状态
  await player.seek(9);
  const fresh = createPlayer({ fps: FPS_30, duration: 20, now: () => 200, frameProvider: provider });
  assert.equal(fresh.state, 'idle');
  assert.equal(fresh.position(), 0);
});
