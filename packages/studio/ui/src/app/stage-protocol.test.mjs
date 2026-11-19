import assert from 'node:assert/strict';
import test from 'node:test';

import {
  STAGE_OPS,
  STAGE_PROTOCOL_VERSION,
  classifyStageMessage,
  formatTimecode,
  isStageOp,
  isStaleSeq,
  makeStageCommand,
} from './stage-protocol.mjs';

test('stage protocol version matches contracts/stage.ts', () => {
  assert.equal(STAGE_PROTOCOL_VERSION, '1.0.0');
  assert.deepEqual([...STAGE_OPS], ['ping', 'setTime', 'setPlaying', 'setRate', 'setVolume', 'requestFrame']);
});

test('makeStageCommand stamps version/seq and refuses unknown ops', () => {
  const command = makeStageCommand(3, 'setTime', { t: 2.5 });
  assert.deepEqual(command, { v: '1.0.0', seq: 3, op: 'setTime', t: 2.5 });
  assert.throws(() => makeStageCommand(1, 'seek'), /unknown stage op/);
  assert.throws(() => makeStageCommand(0, 'ping'), /seq/);
  assert.throws(() => makeStageCommand(1.5, 'ping'), /seq/);
  assert.equal(isStageOp('setPlaying'), true);
  assert.equal(isStageOp('nope'), false);
});

test('classifyStageMessage: version mismatch is unsupported, unknown types ignored', () => {
  assert.deepEqual(classifyStageMessage({ v: '9.9.9', type: 'state' }), { kind: 'unsupported', version: '9.9.9' });
  assert.deepEqual(classifyStageMessage({ v: '1.0.0', type: 'telemetry' }), { kind: 'ignore' });
  assert.deepEqual(classifyStageMessage({ type: 'state' }), { kind: 'ignore' });
  assert.deepEqual(classifyStageMessage(null), { kind: 'ignore' });
  const state = { v: '1.0.0', seq: 2, type: 'state', state: { ready: true, t: 1, duration: 8, playing: false, rate: 1, volume: 1 } };
  assert.equal(classifyStageMessage(state).kind, 'state');
  const error = { v: '1.0.0', seq: 2, type: 'error', code: 'NO_FILM', message: 'x' };
  assert.equal(classifyStageMessage(error).kind, 'error');
});

test('isStaleSeq only drops numbers below the last seen', () => {
  assert.equal(isStaleSeq(4, 5), true);
  assert.equal(isStaleSeq(5, 5), false);
  assert.equal(isStaleSeq(6, 5), false);
  assert.equal(isStaleSeq('6', 5), false);
});

test('formatTimecode renders mm:ss.ff', () => {
  assert.equal(formatTimecode(0, { num: 30, den: 1 }), '00:00.00');
  assert.equal(formatTimecode(1 / 30, { num: 30, den: 1 }), '00:00.01');
  assert.equal(formatTimecode(75.5, { num: 30, den: 1 }), '01:15.15');
  assert.equal(formatTimecode(-3, { num: 30, den: 1 }), '00:00.00');
});
