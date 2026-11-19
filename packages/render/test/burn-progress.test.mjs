// @ts-nocheck —— 纯函数测试，断言的是事件形状与单调性
/**
 * P45：烧录第二遍的进度归并器。
 *
 * ffmpeg 的 `-progress` 是定时上报（默认 0.5s 一条），宿主拿到的是「已经编到第 N 帧」。
 * 这一组钉的是**归并规则**，不是 ffmpeg 的上报节奏：
 * 1. gap 补成逐帧、从 1 开始、严格 +1；
 * 2. 重复/回退的上报不倒退；
 * 3. 超过总帧数被夹住；
 * 4. 成功后的 `finish()` 只补尾部，不重复发；
 * 5. total 为 0 / 非法上报不发事件。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBurnProgress } from '../film-export.mjs';

/** @param {number} total */
function collect(total) {
  /** @type {any[]} */
  const events = [];
  const burn = createBurnProgress(total, (event) => events.push(event));
  return { burn, events };
}

/** @param {any[]} events */
function frames(events) {
  return events.map((event) => event.frame);
}

test('P45 归并：一次上报补成逐帧，finish 补齐尾部', () => {
  const { burn, events } = collect(10);
  burn.update({ frame: 3 });
  assert.deepEqual(frames(events), [1, 2, 3]);
  burn.update({ frame: 7 });
  assert.deepEqual(frames(events), [1, 2, 3, 4, 5, 6, 7]);
  burn.finish();
  assert.deepEqual(frames(events), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(burn.frame, 10);
});

test('P45 归并：事件形状固定为 burn/encode/totalFrames', () => {
  const { burn, events } = collect(3);
  burn.update({ frame: 1 });
  assert.deepEqual(events, [{ phase: 'burn', stage: 'encode', frame: 1, totalFrames: 3 }]);
});

test('P45 归并：重复与回退的上报不倒退', () => {
  const { burn, events } = collect(20);
  burn.update({ frame: 8 });
  burn.update({ frame: 8 });
  burn.update({ frame: 5 });
  assert.deepEqual(frames(events), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(burn.frame, 8);
});

test('P45 归并：超过总帧数被夹住', () => {
  const { burn, events } = collect(5);
  burn.update({ frame: 99 });
  burn.finish();
  assert.deepEqual(frames(events), [1, 2, 3, 4, 5]);
});

test('P45 归并：最后一报正好等于总帧数时 finish 不重复发', () => {
  const { burn, events } = collect(4);
  burn.update({ frame: 4 });
  burn.finish();
  assert.deepEqual(frames(events), [1, 2, 3, 4]);
});

test('P45 归并：总帧数为 0 或上报非法时不发事件', () => {
  const zero = collect(0);
  zero.burn.update({ frame: 3 });
  zero.burn.finish();
  assert.deepEqual(zero.events, []);

  const broken = collect(6);
  // @ts-expect-error 故意传坏值：回调的 bug 不该把编码带崩
  broken.burn.update({ frame: Number.NaN });
  // @ts-expect-error 同上
  broken.burn.update({});
  assert.deepEqual(broken.events, []);
  broken.burn.finish();
  assert.deepEqual(frames(broken.events), [1, 2, 3, 4, 5, 6]);
});
