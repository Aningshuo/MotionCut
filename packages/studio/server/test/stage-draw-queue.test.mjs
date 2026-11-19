import assert from 'node:assert/strict';
import test from 'node:test';
import { createStageDrawQueue } from '../content-origin.mjs';

function barrier() {
  let release = () => {};
  const promise = new Promise(resolve => { release = () => resolve(undefined); });
  return { promise, release };
}

test('a busy scene skips obsolete pointer positions and draws the release position exactly once', async () => {
  const gate = barrier();
  let aborted = false;
  /** @type {Array<[number, boolean]>} */
  const calls = [];
  const queue = createStageDrawQueue(async (time, scrubbing, signal) => {
    calls.push([time, scrubbing]);
    if (time === 4) {
      signal?.addEventListener('abort', () => { aborted = true; });
      await gate.promise;
    }
  });
  const first = queue.draw(4, false, true);
  await Promise.resolve();
  const pending = queue.draw(8, false, true);
  for (const t of [7, 2, 6, 1]) assert.equal(queue.draw(t, false, true), pending);
  assert.equal(queue.draw(3, false), pending);
  assert.equal(aborted, true);
  gate.release();
  await Promise.all([first, pending]);
  assert.deepEqual(calls, [[4, true], [3, false]]);
});

test('captures keep their order and survive a transport change and superseded seeks', async () => {
  const gate = barrier();
  /** @type {Array<[number, boolean]>} */
  const calls = [];
  const queue = createStageDrawQueue(async (time, scrub, signal) => {
    calls.push([time, signal === null]);
    if (time === 1) await gate.promise;
    return time;
  });
  const first = queue.draw(1, true);
  await Promise.resolve();
  const obsolete = queue.draw(2, false, true);
  const second = queue.draw(3, true);
  const cancelled = queue.draw(4, false, true);
  queue.cancel();
  const last = queue.draw(5, false);
  gate.release();
  assert.deepEqual(await Promise.all([first, obsolete, second, cancelled, last]), [1, undefined, 3, undefined, 5]);
  assert.deepEqual(calls, [[1, true], [3, true], [5, false]]);
});
