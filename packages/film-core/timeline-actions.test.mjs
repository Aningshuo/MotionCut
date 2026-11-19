import assert from 'node:assert/strict';
import test from 'node:test';
import { applyOpsDetailed } from './ops.mjs';
import { copyTimelineClips, planTimelineAction } from './timeline-actions.mjs';

/** @param {string} id @param {number} at @param {number} length @param {Record<string, unknown>} [extra] */
const media = (id, at, length, extra = {}) => ({ id, src: `assets/${id}.mp4`, at, time: [0, length], kind: 'video', ...extra });

/** @param {any[]} lanes */
const film = (lanes) => ({
  stage: { w: 1920, h: 1080 },
  fps: { num: 30, den: 1 },
  tracks: lanes.map((lane, index) => ({ role: 'picture', ...lane, index })),
});

/** @param {any} doc @param {string} id */
const clip = (doc, id) => doc.tracks.flatMap((/** @type {any} */ track) => track.clips).find((/** @type {any} */ row) => row.id === id);

/** @param {Parameters<typeof planTimelineAction>[0]} input */
function run(input) {
  const planned = planTimelineAction(input);
  assert.equal(planned.ok, true, planned.message);
  return { planned, ...applyOpsDetailed(input.doc, planned.ops) };
}

test('split snaps to project FPS and creates separately linked right halves', () => {
  const doc = film([
    { clips: [media('video', 0, 8, { speed: 2, link: 'pair' }), media('video-b', 10, 1)] },
    { role: 'audio', clips: [media('sound', 0, 4, { kind: 'sound', link: 'pair' })] },
  ]);
  doc.fps = { num: 30000, den: 1001 };
  const { value, planned } = run({ doc, action: 'split', ids: ['video'], at: 2 });
  assert.deepEqual(planned.ids, ['video-b-2', 'sound-b']);
  assert.deepEqual(clip(value, 'video').time, [0, 4.004]);
  assert.deepEqual(clip(value, 'video-b-2').time, [4.004, 8]);
  assert.deepEqual(clip(value, 'sound-b').time, [2.002, 4]);
  assert.equal(clip(value, 'video').link, 'pair');
  assert.equal(clip(value, 'sound').link, 'pair');
  assert.equal(clip(value, 'video-b-2').link, clip(value, 'sound-b').link);
  assert.notEqual(clip(value, 'video-b-2').link, 'pair');
  assert.deepEqual(clip(doc, 'video').time, [0, 8]);
  assert.equal(planTimelineAction({ doc, action: 'split', ids: ['video'], at: .0001 }).ok, false);
});

test('split ignores selected clips outside the playhead, including a selected 0–7s page at 27s', () => {
  const doc = film([
    { role: 'page', clips: [media('mg', 0, 7, { kind: 'page' })] },
    { clips: [media('main', 0, 167)] },
  ]);
  const { value, planned } = run({ doc, action: 'split', ids: ['mg', 'main'], at: 27 });
  assert.deepEqual(planned.ids, ['main-b']);
  assert.deepEqual(clip(value, 'mg').time, [0, 7]);
  assert.deepEqual(clip(value, 'main').time, [0, 27]);
  assert.deepEqual(clip(value, 'main-b').time, [27, 167]);
});

test('split skips a locked linked group and leaves an independent eligible clip editable', () => {
  const doc = film([
    { clips: [media('video', 0, 8, { link: 'pair' }), media('independent', 0, 8)] },
    { role: 'audio', locked: true, clips: [media('sound', 0, 4, { kind: 'sound', link: 'pair' })] },
  ]);
  assert.equal(planTimelineAction({ doc, action: 'split', ids: ['video'], at: 2 }).code, 'LOCKED');
  const { planned, value } = run({ doc, action: 'split', ids: ['video', 'independent'], at: 2 });
  assert.deepEqual(planned.ids, ['independent-b']);
  assert.deepEqual(clip(value, 'video').time, [0, 8]);
  assert.deepEqual(clip(value, 'sound').time, [0, 4]);
});

test('split without selection prefers the visible main picture, then a covering visible clip', () => {
  const doc = film([
    { clips: [media('disabled', 0, 8, { attrs: { 'data-opencut-disabled': '1' } })] },
    { role: 'page', hidden: true, clips: [media('hidden', 0, 8, { kind: 'page' })] },
    { role: 'page', clips: [media('overlay', 0, 8, { kind: 'page' })] },
    { clips: [media('main', 0, 4)] },
  ]);
  assert.deepEqual(run({ doc, action: 'split', at: 2 }).planned.ids, ['main-b']);
  assert.deepEqual(run({ doc, action: 'split', at: 6 }).planned.ids, ['overlay-b']);
  assert.equal(planTimelineAction({ doc, action: 'split', at: 8 }).code, 'PLAYHEAD_OUTSIDE_CLIP');
  assert.equal(planTimelineAction({ doc, action: 'split', at: 4, ids: ['main'] }).ok, false);
  assert.equal(planTimelineAction({ doc, action: 'split', at: 1 / 30, ids: ['main'] }).ok, true);
});

test('explicit ripple delete works on the addressed overlay track and removes only newly vacated spans', () => {
  const doc = film([
    { role: 'page', clips: [
      media('gone', 2, 4, { kind: 'page' }),
      media('retain', 4, 1, { kind: 'page' }),
      media('next', 6, 1, { kind: 'page' }),
    ] },
    { clips: [media('main', 0, 12)] },
  ]);
  const { value } = run({ doc, ids: ['gone'], action: 'ripple-delete' });
  assert.equal(clip(value, 'gone'), undefined);
  assert.equal(clip(value, 'retain').at, 2);
  assert.equal(clip(value, 'next').at, 3);
  assert.equal(clip(value, 'main').at, 0);
  const ordinary = run({ doc, ids: ['gone'], action: 'delete' }).value;
  assert.equal(clip(ordinary, 'retain').at, 4);
  assert.equal(clip(ordinary, 'next').at, 6);
});

test('ripple start and end trim both account for nonzero source-in and speed', () => {
  const doc = film([{ clips: [
    media('head', 2, 8, { time: [10, 18], speed: 2 }),
    media('tail', 7, 2),
  ] }]);
  const head = run({ doc, ids: ['head'], action: 'ripple-trim-start', at: 4 });
  assert.deepEqual(clip(head.value, 'head').time, [14, 18]);
  assert.equal(clip(head.value, 'head').at, 2);
  assert.equal(clip(head.value, 'tail').at, 5);
  const tail = run({ doc, ids: ['head'], action: 'ripple-trim-end', at: 4 });
  assert.deepEqual(clip(tail.value, 'head').time, [10, 14]);
  assert.equal(clip(tail.value, 'tail').at, 5);
  assert.deepEqual(applyOpsDetailed(tail.value, tail.inverse).value, doc);
  assert.equal(planTimelineAction({ doc, ids: ['head'], action: 'ripple-trim-start', at: 6 }).ok, false);
});

test('gap commands preserve overlaps and do not close other tracks', () => {
  const doc = film([
    { clips: [media('a', 1, 2), media('b', 2, 2), media('c', 6, 1)] },
    { clips: [media('other', 8, 1)] },
  ]);
  const one = run({ doc, action: 'close-gap', track: 0, at: 5 }).value;
  assert.equal(clip(one, 'a').at, 1);
  assert.equal(clip(one, 'c').at, 4);
  const all = run({ doc, action: 'close-all-gaps', track: 0 }).value;
  assert.equal(clip(all, 'a').at ?? 0, 0);
  assert.equal(clip(all, 'b').at, 1);
  assert.equal(clip(all, 'c').at, 3);
  assert.equal(clip(all, 'other').at, 8);
  assert.equal(planTimelineAction({ doc, action: 'close-gap', track: 0, at: 6.5 }).ok, false);
});

test('locked and collision-prone linked peers cannot be silently left out of an edit', () => {
  const doc = film([
    { clips: [media('first', 0, 2), media('linked', 2, 2, {link: 'av'})] },
    { role: 'audio', locked: true, clips: [media('linked-audio', 2, 2, {kind: 'sound', link: 'av'})] },
  ]);
  assert.equal(planTimelineAction({ doc, ids: ['linked'], action: 'delete' }).code, 'LOCKED');
  assert.equal(planTimelineAction({ doc, ids: ['first'], action: 'ripple-delete' }).code, 'LOCKED');
  const audio = doc.tracks[1];
  assert.ok(audio);
  audio.locked = false;
  audio.clips.unshift(media('bed', 0, 2, {kind: 'sound'}));
  assert.equal(planTimelineAction({ doc, ids: ['first'], action: 'ripple-delete' }).code, 'OVERLAP');
  audio.clips.shift();
  const moved = run({ doc, ids: ['first'], action: 'ripple-delete' }).value;
  assert.equal(clip(moved, 'linked').at ?? 0, 0);
  assert.equal(clip(moved, 'linked-audio').at ?? 0, 0);
});

test('duplicate inserts after the selection and shifts existing lane tails while paste stays exact', () => {
  const doc = film([
    { clips: [media('video', 1, 2, {link: 'av'}), media('busy', 3, 2)] },
    { role: 'audio', clips: [media('audio', 1, 2, {kind: 'sound', link: 'av'})] },
  ]);
  const copied = copyTimelineClips({ doc, ids: ['video'] });
  assert.equal(copied.ok, true);
  if (!copied.ok) return;
  assert.deepEqual(copied.clipboard.map((row) => row.trackIndex), [0, 1]);
  const duplicated = run({ doc, ids: ['video'], action: 'duplicate' });
  assert.equal(clip(duplicated.value, 'video-copy').at, 3);
  assert.equal(clip(duplicated.value, 'audio-copy').at, 3);
  assert.equal(clip(duplicated.value, 'busy').at, 5);
  assert.equal(clip(duplicated.value, 'audio-copy').link, clip(duplicated.value, 'video-copy').link);
  assert.notEqual(clip(duplicated.value, 'video-copy').link, 'av');
  assert.equal(planTimelineAction({doc, action:'paste', at:3, clipboard:copied.clipboard}).code, 'OVERLAP');
  const pasted = run({doc, action:'paste', at:8, clipboard:copied.clipboard});
  assert.equal(clip(pasted.value, 'video-copy').at, 8);
  assert.equal(clip(doc, 'video-copy'), undefined);
});

test('duplicate splits a clip crossing the insertion seam and moves only its right half', () => {
  const doc = film([
    { clips: [
      media('first', 1, 2),
      media('cross', 2, 6, { time: [6, 12], speed: 2 }),
      media('tail', 7, 2),
    ] },
    { role: 'audio', clips: [media('unrelated', 3, 2, { kind: 'sound' })] },
  ]);
  const { value, planned, inverse } = run({ doc, ids: ['first'], action: 'duplicate' });
  assert.deepEqual(planned.ops.map((op) => op.op), ['split', 'props', 'insert']);
  assert.deepEqual(clip(value, 'cross').time, [6, 8]);
  assert.deepEqual(clip(value, 'cross-b').time, [8, 12]);
  assert.equal(clip(value, 'cross-b').at, 5);
  assert.equal(clip(value, 'tail').at, 9);
  assert.equal(clip(value, 'first-copy').at, 3);
  assert.equal(clip(value, 'unrelated').at, 3);
  assert.deepEqual(applyOpsDetailed(value, inverse).value, doc);
});


test('cuts with clip-local keyframes fail before altering the source animation', () => {
  const doc = film([{
    clips: [media('keyed', 0, 5, { overrides: [{ at: '#headline', kf: [
      { t: 0, style: 'opacity:0' }, { t: 2, style: 'opacity:1' },
    ] }] })],
  }]);
  const before = structuredClone(doc);
  assert.equal(planTimelineAction({ doc, action: 'split', ids: ['keyed'], at: 1 }).code, 'KEYFRAMES_ACTIVE');
  assert.equal(planTimelineAction({ doc, action: 'ripple-trim-end', ids: ['keyed'], at: 1 }).code, 'KEYFRAMES_ACTIVE');
  assert.throws(() => applyOpsDetailed(doc, [{ op: 'split', clip: 'keyed', at: 1 }]), /关键帧/);
  assert.deepEqual(doc, before);
});
