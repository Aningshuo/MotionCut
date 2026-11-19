// @ts-nocheck —— 以 node --test 的运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * 音频编辑的纯函数单测（M31 · B-MAIN-R16-016）。
 *
 * 只测「算得对不对」：dB 换算、夹边界、多选混合、以及写进 `/ops` 的那批 props。
 * 真落盘 / 一步撤销 / 预览与成片一致 由 `scripts/m31-audio-edit.mjs` 在真 Studio 上验。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  VOLUME_MAX,
  audioSelection,
  clampFadeEdge,
  clampFadePair,
  clampVolume,
  clipLength,
  dbToVolume,
  effectiveFade,
  effectiveVolume,
  fadeLimit,
  formatVolumeDb,
  muteStateOf,
  planFadeOps,
  planMuteOps,
  planResetOps,
  planVolumeOps,
  sourceSpan,
  volumeToDb,
} from '../audio-edit.mjs';
import { parse, writeValue } from '../film-doc.mjs';
import { applyOps, invertOps } from '../ops.mjs';

/** 3s 片段，未变速。 */
const clip3 = { id: 'a', kind: 'sound', time: [0, 3] };
/** 3s 片段，从源 2s 处起（源区间仍是 3s）。 */
const clipTrim = { id: 'b', kind: 'sound', time: [2, 5] };
/** 放慢 0.5×：源区间 2s，时间线 4s。 */
const clipSlow = { id: 'c', kind: 'sound', time: [0, 2], speed: 0.5 };
/** 画面片段（fade 是画面淡变，volume 不参与混音）。 */
const clipVideo = { id: 'v', kind: 'video', time: [0, 4] };

test('A0 音量 ↔ dB：0 是静音（null），2.0 是 +6.02 dB，0.5 是 −6.02 dB', () => {
  assert.equal(volumeToDb(0), null);
  assert.equal(volumeToDb(-1), null);
  assert.equal(volumeToDb('x'), null);
  assert.equal(volumeToDb(1), 0);
  assert.equal(volumeToDb(0.5), -6.02);
  assert.equal(volumeToDb(2), 6.02);
  assert.ok(Math.abs(dbToVolume(-6.0206) - 0.5) < 1e-4);
  assert.equal(formatVolumeDb(0), '静音');
  assert.equal(formatVolumeDb(1), '0.0 dB');
  assert.equal(formatVolumeDb(0.5), '−6.0 dB');
  assert.equal(formatVolumeDb(2), '+6.0 dB');
  assert.equal(formatVolumeDb(2, { suffix: false }), '+6.0');
});

test('A1 夹音量：负数到 0、超过刻度到 2、NaN 回默认 1（不静音）', () => {
  assert.equal(clampVolume(-0.4), 0);
  assert.equal(clampVolume(9), VOLUME_MAX);
  assert.equal(clampVolume('0.35'), 0.35);
  assert.equal(clampVolume(undefined), 1);
  assert.equal(clampVolume(Number.NaN), 1);
  // 1.23456 → 千分位（和 ops.mjs 的 round 一致）
  assert.equal(clampVolume(1.23456), 1.235);
  // 显式给更小的刻度（界面按源峰值收窄时用得上）
  assert.equal(clampVolume(1.5, 1), 1);
});

test('A2 有效值：没写属性 = 1 / [0,0]；垃圾值不冒充', () => {
  assert.equal(effectiveVolume({}), 1);
  assert.equal(effectiveVolume({ volume: '0.4' }), 0.4);
  assert.equal(effectiveVolume({ volume: -2 }), 1);
  assert.deepEqual(effectiveFade({}), [0, 0]);
  assert.deepEqual(effectiveFade({ fade: [0.5, 0.25] }), [0.5, 0.25]);
  assert.deepEqual(effectiveFade({ fade: [Number.NaN, -3] }), [0, 0]);
  assert.deepEqual(effectiveFade({ fade: [1] }), [0, 0]);
});

test('A3 时长/源区间：变速影响时间线长度，不影响源区间', () => {
  assert.equal(clipLength(clip3), 3);
  assert.equal(sourceSpan(clip3), 3);
  assert.equal(clipLength(clipSlow), 4);
  assert.equal(sourceSpan(clipSlow), 2);
  // 只给入口（#t=2）没有出点 → 时长未知
  assert.equal(clipLength({ time: [2] }), 0);
  assert.equal(clipLength({}), 0);
});

test('A4 淡变上限 = min(时长/2, 源区间/2)；另一侧已占用的要扣掉', () => {
  assert.equal(fadeLimit(clip3), 1.5);
  // 放慢 0.5×：源只有 2s → 上限 1s（比时长/2=2s 更紧）
  assert.equal(fadeLimit(clipSlow), 1);
  // 已经淡入 1s，再拖淡出最多 2s（3−1），且不超过 1.5
  assert.equal(fadeLimit(clip3, 'out', [1, 0]), 1.5);
  const long = { time: [0, 8] };
  assert.equal(fadeLimit(long, 'out', [7, 0]), 1);
  // 没有确定时长 → 0（不许写一个撑不住的淡变）
  assert.equal(fadeLimit({ time: [1] }), 0);
});

test('A5 单侧夹：负数到 0、超上限到上限、正常值原样', () => {
  const neg = clampFadeEdge(clip3, 'in', -0.8);
  assert.deepEqual(neg.fade, [0, 0]);
  assert.equal(neg.clamped, true);
  const over = clampFadeEdge(clip3, 'in', 2.4);
  assert.deepEqual(over.fade, [1.5, 0]);
  assert.equal(over.clamped, true);
  assert.equal(over.limit, 1.5);
  assert.equal(over.requested, 2.4);
  const ok = clampFadeEdge(clip3, 'in', 1.2);
  assert.deepEqual(ok.fade, [1.2, 0]);
  assert.equal(ok.clamped, false);
  // 拖淡出不动淡入
  assert.deepEqual(clampFadeEdge({ time: [0, 3], fade: [0.5, 0] }, 'out', 0.75).fade, [0.5, 0.75]);
});

test('A6 一对夹：按 fitFades 比例缩，两侧相对关系不变', () => {
  const pair = clampFadePair({ time: [0, 2] }, [2, 2]);
  assert.deepEqual(pair.fade, [1, 1]);
  assert.equal(pair.clamped, true);
  assert.equal(pair.limit, 1);
  const clean = clampFadePair({ time: [0, 4] }, [0.5, 1]);
  assert.deepEqual(clean.fade, [0.5, 1]);
  assert.equal(clean.clamped, false);
});

test('A7 多选混合：全一致给数值、不一致给 null；上限取最紧的那个', () => {
  const same = audioSelection([
    { id: 'a', clip: { kind: 'sound', volume: 0.4, time: [0, 3] } },
    { id: 'b', clip: { kind: 'sound', volume: 0.4, time: [0, 3] } },
  ]);
  assert.equal(same.volume, 0.4);
  assert.equal(same.volumeMixed, false);
  assert.deepEqual(same.fade, [0, 0]);

  const mixed = audioSelection([
    { id: 'a', clip: { kind: 'sound', volume: 0.4, time: [0, 3] } },
    { id: 'b', clip: { kind: 'sound', volume: 0.8, time: [0, 3] } },
  ]);
  assert.equal(mixed.volume, null);
  assert.equal(mixed.volumeMixed, true);
  assert.equal(mixed.soundCount, 2);

  // 混合选择（1 个声音 + 1 个画面）：volume 只看声音片段；fade 看全部
  const withVideo = audioSelection([
    { id: 'a', clip: { kind: 'sound', volume: 0.4, time: [0, 3], fade: [0.5, 0] } },
    { id: 'v', clip: { kind: 'video', time: [0, 8], fade: [0, 0.25] } },
  ]);
  assert.equal(withVideo.soundCount, 1);
  assert.equal(withVideo.volume, 0.4);
  assert.equal(withVideo.fadeMixedIn, true);
  assert.equal(withVideo.fade[1], null);
  assert.equal(withVideo.fadeLimit, 1.5, '取交集里最紧的：声音 3s → 1.5，画面 8s → 4 → 1.5');

  const tight = audioSelection([
    { id: 'a', clip: { kind: 'sound', time: [0, 3] } },
    { id: 'c', clip: { kind: 'sound', time: [0, 2], speed: 0.5 } },
  ]);
  assert.equal(tight.fadeLimit, 1);
  assert.equal(tight.fadeLimitedBy, 'c');
});

test('A8 一批音量 Op：只对声音片段、跳过没变化的、一步撤销的形状', () => {
  const planned = planVolumeOps(
    [
      { id: 'a', clip: { kind: 'sound', volume: 0.4, time: [0, 3] } },
      { id: 'b', clip: { kind: 'sound', volume: 0.8, time: [0, 3] } },
      { id: 'v', clip: { kind: 'video', time: [0, 3] } },
    ],
    1,
  );
  assert.equal(planned.ops.length, 1, '一批 = 一条 props');
  assert.equal(planned.ops[0].op, 'props');
  assert.deepEqual(planned.ops[0].edits, [
    { clip: 'a', prop: 'volume', value: 1 },
    { clip: 'b', prop: 'volume', value: 1 },
  ]);
  assert.deepEqual(planned.skipped, ['v']);
  assert.equal(planned.clamped, false);

  // 没变化 → 一个 Op 都不发
  assert.deepEqual(planVolumeOps([{ id: 'a', clip: { kind: 'sound', volume: 1 } }], 1).ops, []);

  // 超刻度：值被夹到 2，并如实报 clamped
  const over = planVolumeOps([{ id: 'a', clip: { kind: 'sound', time: [0, 3] } }], 3.5);
  assert.equal(over.value, 2);
  assert.equal(over.clamped, true);
  assert.deepEqual(over.ops[0].edits, [{ clip: 'a', prop: 'volume', value: 2 }]);

  // 负数夹到 0（0 是**静音**，不是「没写」）
  const neg = planVolumeOps([{ id: 'a', clip: { kind: 'sound', time: [0, 3] } }], -1);
  assert.deepEqual(neg.ops[0].edits, [{ clip: 'a', prop: 'volume', value: 0 }]);
});

test('A9 一批淡变 Op：写 [in,out]、夹住报 clamped、另一侧保持', () => {
  const planned = planFadeOps([{ id: 'd', clip: { kind: 'sound', time: [0, 3] } }], 'in', 1.2);
  assert.deepEqual(planned.ops, [{ op: 'props', edits: [{ clip: 'd', prop: 'fade', value: [1.2, 0] }] }]);
  assert.equal(planned.clamped, false);

  const over = planFadeOps([{ id: 'd', clip: { kind: 'sound', time: [0, 3] } }], 'in', 2.4);
  assert.deepEqual(over.ops[0].edits[0].value, [1.5, 0]);
  assert.equal(over.clamped, true);
  assert.equal(over.limit, 1.5);

  const keep = planFadeOps([{ id: 'd', clip: { kind: 'sound', time: [0, 3], fade: [1.2, 0.3] } }], 'in', 0.4);
  assert.deepEqual(keep.ops[0].edits[0].value, [0.4, 0.3]);

  // 没有变化 → 不发 Op
  assert.deepEqual(planFadeOps([{ id: 'd', clip: { time: [0, 3], fade: [0.5, 0] } }], 'in', 0.5).ops, []);
  // 非法边
  assert.throws(() => planFadeOps([{ id: 'd', clip: clip3 }], 'mid', 1), /in\/out/);
});

test('A10 双击回默认：fade 归 0、声音片段 volume 归 1（画面片段不写 volume）', () => {
  const reset = planResetOps([
    { id: 'a', clip: { kind: 'sound', volume: 0.4, fade: [1.2, 0], time: [0, 3] } },
    { id: 'v', clip: { kind: 'video', volume: 0.4, fade: [0, 0.5], time: [0, 4] } },
  ]);
  assert.deepEqual(reset.ops[0].edits, [
    { clip: 'a', prop: 'fade', value: [0, 0] },
    { clip: 'a', prop: 'volume', value: 1 },
    { clip: 'v', prop: 'fade', value: [0, 0] },
  ]);
  // 已经是默认值 → 不发
  assert.deepEqual(planResetOps([{ id: 'v', clip: { kind: 'video', time: [0, 4] } }]).ops, []);
});

test('A11 契约：写音量/淡变只用 props（不是 set），字段名是合同里的 volume/fade', () => {
  const volume = planVolumeOps([{ id: 'a', clip: { kind: 'sound', time: [0, 3] } }], 0.5);
  const fade = planFadeOps([{ id: 'a', clip: { kind: 'sound', time: [0, 3] } }], 'out', 0.5);
  for (const op of [...volume.ops, ...fade.ops]) {
    assert.equal(op.op, 'props');
    for (const edit of op.edits) {
      assert.ok(['volume', 'fade'].includes(edit.prop), `未知 prop ${edit.prop}`);
      assert.equal(typeof edit.clip, 'string');
    }
  }
  // 淡变必须是 [in, out] 两个数（合同 overrides 的片段自有条目只认这个形状）
  assert.deepEqual(fade.ops[0].edits[0].value, [0, 0.5]);
  assert.equal(clipTrim.speed, undefined);
});

/* ── 和方言对接：plan 出来的 Op 真的能落成合同要求的字节形状 ───────────────── */

const FILM = `<!doctype html>
<html><head><meta name="viewport" content="width=1280, height=720"></head>
<body>
<section id="picture">
  <video id="v1" src="assets/a.mp4#t=0,3" at="0" muted></video>
</section>
<section id="sound">
  <audio id="s1" src="assets/t.wav#t=0,3" at="0" volume="0.8"></audio>
  <audio id="s2" src="assets/t.wav#t=0,3" at="3"></audio>
</section>
</body></html>
`;

/** @param {string} text */
function docOf(text) {
  const parsed = parse(text, { native: { 'assets/a.mp4': 3, 'assets/t.wav': 3 } });
  assert.equal(parsed.diagnostics.filter((item) => item.severity === 'error').length, 0, JSON.stringify(parsed.diagnostics));
  return parsed.doc;
}

/** @param {string} text @param {any} value */
function writeDoc(text, value) {
  const expected = createHash('sha256').update(text).digest('hex');
  const written = writeValue(text, value, expected);
  assert.equal(written.ok, true, JSON.stringify(written.diagnostics ?? []));
  return written.text;
}

test('A12 落盘：音量写 volume 属性、淡变写进「没有 at 的那条」overrides', () => {
  const doc = docOf(FILM);
  const targets = doc.tracks.flatMap((track) => track.clips.map((clip) => ({ id: clip.id, clip })));
  const sound = targets.filter((item) => item.clip.kind === 'sound');
  const volume = planVolumeOps(targets, 0.5);
  const faded = planFadeOps(sound, 'in', 1.2);
  const next = applyOps(doc, [...volume.ops, ...faded.ops]);
  const text = writeDoc(FILM, next);

  assert.match(text, /id="s1"[^>]*volume="0\.5"/, '音量落成 volume="0.5"');
  assert.match(text, /id="s1"[^>]*overrides='\[\{"fade":\[1\.2,0\]\}\]'/, '淡变落成片段自有覆盖');
  assert.match(text, /id="s2"[^>]*volume="0\.5"/);
  // 画面片段一个字节都不动（没有拖它，就不该被写 fade）
  assert.ok(text.includes('<video id="v1" src="assets/a.mp4#t=0,3" at="0" muted></video>'), '未改的片段保持原样');
  // 不许出现旧方言
  assert.ok(!/data-fade|data-volume/.test(text), '不得退回 data-* 方言');
});

test('A13 一步撤销：反向 Op 写回后与改前逐字节相同', () => {
  const doc = docOf(FILM);
  const targets = doc.tracks.flatMap((track) => track.clips.map((clip) => ({ id: clip.id, clip })));
  const planned = planFadeOps(targets, 'out', 0.6);
  const after = applyOps(doc, planned.ops);
  const inverse = invertOps(doc, planned.ops);
  const back = applyOps(after, inverse);
  assert.equal(writeDoc(FILM, after) === FILM, false, '改完必须真的变了');
  assert.equal(writeDoc(FILM, back), FILM, '撤销后必须逐字节相同');
});

test('A14 静音开关：写片段级 muted（fields），不动 volume；多选混合给 mixed', () => {
  const targets = [
    { id: 'a', clip: { kind: 'sound', volume: 0.6, time: [0, 3] } },
    { id: 'b', clip: { kind: 'sound', volume: 0.6, time: [0, 3], muted: true } },
    { id: 'v', clip: { kind: 'video', time: [0, 3] } },
  ];
  const state = muteStateOf(targets);
  assert.equal(state.count, 2, '只看声音片段');
  assert.equal(state.mixed, true);
  assert.equal(state.muted, false);

  // 全部静音：只对「还没静音的声音片段」发 fields
  const on = planMuteOps(targets, true);
  assert.deepEqual(on.ops, [{ op: 'fields', clip: 'a', fields: { muted: true } }]);
  assert.deepEqual(on.skipped, ['v']);

  // 取消静音：fields muted:false（方言会删掉属性），volume 原样
  const off = planMuteOps([{ id: 'b', clip: { kind: 'sound', volume: 0.6, muted: true, time: [0, 3] } }], false);
  assert.deepEqual(off.ops, [{ op: 'fields', clip: 'b', fields: { muted: false } }]);
  assert.ok(!('volume' in off.ops[0].fields), '取消静音不许碰 volume');

  // 已经是目标状态 → 不发
  assert.deepEqual(planMuteOps([{ id: 'a', clip: { kind: 'sound' } }], false).ops, []);
});

test('A15 静音落盘：muted 属性加/减，volume 一字不改', () => {
  const text = `<!doctype html>
<html><head><meta name="viewport" content="width=1280, height=720"></head>
<body><section id="sound"><audio id="s1" src="assets/t.wav#t=0,3" volume="0.6"></audio></section></body></html>
`;
  const doc = docOf(text);
  const on = applyOps(doc, planMuteOps([{ id: 's1', clip: doc.tracks[0].clips[0] }], true).ops);
  const withMute = writeDoc(text, on);
  assert.match(withMute, /<audio id="s1" src="assets\/t\.wav#t=0,3" volume="0.6" muted><\/audio>/);

  const back = applyOps(on, planMuteOps([{ id: 's1', clip: on.tracks[0].clips[0] }], false).ops);
  const unmuted = writeDoc(text, back);
  assert.match(unmuted, /volume="0\.6"><\/audio>/, '取消静音后 volume 仍是 0.6');
  assert.ok(!/ muted/.test(unmuted), 'muted 属性被删掉');
});
