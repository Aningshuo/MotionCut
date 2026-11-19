// @ts-nocheck —— 以 node --test 的运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * 转场（重叠 + fade）的纯函数单测（M25 · B-MAIN-R13-013）。
 *
 * 这里只测「判据与算得对不对」：认哪两段、余量多少、Op 长什么样、夹到边界时给什么原因。
 * 真落盘 / 一次 `/ops` / 一步撤销 / 预览与导出一致 由 `scripts/m25-transition.mjs` 在真 Studio 上验。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { parse } from '../film-doc.mjs';
import { applyOps, invertOps } from '../ops.mjs';
import { bareSrc, detectCutPoints, detectTransitions, planTransitionCreate, planTransitionRemove, planTransitionResize, spanOf } from '../transition.mjs';

const FIXTURE = readFileSync(join(import.meta.dirname, '../../..', 'tests/fixtures/main/transition-film.html'), 'utf8');

/** @param {string} text */
function docOf(text) {
  const parsed = parse(text, { native: { 'assets/a-light.mp4': 3, 'assets/b-dark.mp4': 3 } });
  assert.equal(parsed.diagnostics.filter((item) => item.severity === 'error').length, 0, JSON.stringify(parsed.diagnostics));
  return parsed.doc;
}

const NATIVE = { 'assets/a-light.mp4': 3, 'assets/b-dark.mp4': 3 };

test('A1 识别：夹具里 2 处重叠+fade → 2 个转场，起止与磁盘一致', () => {
  const doc = docOf(FIXTURE);
  const { transitions, unresolved } = detectTransitions({ tracks: doc.tracks, stage: doc.stage, native: NATIVE });
  assert.equal(unresolved.length, 0, JSON.stringify(unresolved));
  assert.equal(transitions.length, 2);
  const [t1, t2] = transitions;
  assert.equal(t1.id, 't-a→t-b');
  assert.deepEqual([t1.start, t1.end, t1.duration], [1.5, 2, 0.5]);
  assert.equal(t1.top, 'to');
  assert.equal(t1.doubleSided, false);
  assert.deepEqual(t1.ramp, { clip: 't-b', side: 'in', seconds: 0.5 });
  assert.equal(t1.crossfadeOk, true);
  assert.equal(t1.fullFrame, true);
  assert.deepEqual([t2.start, t2.end, t2.duration], [7.5, 8.5, 1]);
  assert.equal(t2.doubleSided, true);
  assert.deepEqual([t2.from.id, t2.to.id], ['t-c', 't-d']);
});

test('A2 源余量：向左受后段入点限制、向右受前段出点限制', () => {
  const doc = docOf(FIXTURE);
  const { transitions } = detectTransitions({ tracks: doc.tracks, stage: doc.stage, native: NATIVE });
  const [t1, t2] = transitions;
  // t-b 入点 0.5 → 左 0.5；t-a 出点 2/原生 3 → 右 1
  assert.deepEqual(t1.headroom, { start: 0.5, end: 1 });
  // t-d 入点 0.5；t-c 出点 2.5/原生 3 → 0.5
  assert.deepEqual(t2.headroom, { start: 0.5, end: 0.5 });
});

test('原生时长未知 → 出点后余量按 0（宁停不吞）', () => {
  const doc = docOf(FIXTURE);
  const { transitions } = detectTransitions({ tracks: doc.tracks, stage: doc.stage, native: {} });
  assert.deepEqual(transitions[0].headroom, { start: 0.5, end: 0 });
});

test('A2 调长 +0.5s（拖左边缘）：后段 at 与两侧 fade 同步改，一批 1 条 op', () => {
  const doc = docOf(FIXTURE);
  const { transitions } = detectTransitions({ tracks: doc.tracks, stage: doc.stage, native: NATIVE });
  const plan = planTransitionResize({ transition: transitions[1], edge: 'start', deltaSec: -0.5, fps: doc.fps });
  assert.equal(plan.ok, true);
  assert.equal(plan.ops.length, 1);
  assert.equal(plan.ops[0].op, 'props');
  const edits = plan.ops[0].edits;
  assert.deepEqual(
    edits.filter((edit) => edit.clip === 't-d').map((edit) => [edit.prop, edit.value]),
    [
      ['at', 7],
      ['start', 0],
      ['fade', [1.5, 0]],
    ],
  );
  assert.deepEqual(
    edits.filter((edit) => edit.clip === 't-c').map((edit) => [edit.prop, edit.value]),
    [['fade', [0, 1.5]]],
  );
  assert.deepEqual(plan.next, { start: 7, end: 8.5, duration: 1.5 });
  assert.equal(plan.limited, null);
  // 落盘后重新识别：重叠 1.5、两侧 fade 都是 1.5、总时长不变（10s 仍是 10s）
  const next = applyOps(doc, plan.ops);
  const again = detectTransitions({ tracks: next.tracks, stage: next.stage, native: NATIVE }).transitions;
  assert.deepEqual([again[1].start, again[1].end, again[1].duration], [7, 8.5, 1.5]);
  assert.deepEqual(again[1].from.fade, [0, 1.5]);
  assert.deepEqual(again[1].to.fade, [1.5, 0]);
  assert.equal(spanOf(next.tracks[0].clips.find((clip) => clip.id === 't-d')).end, 10);
});

test('A3 拖到超出源余量 → 停在边界 + 原因，0 个 Op', () => {
  const doc = docOf(FIXTURE);
  const { transitions } = detectTransitions({ tracks: doc.tracks, stage: doc.stage, native: NATIVE });
  // 左边缘已经用满 0.5 的工程：从「已调到边界」的 doc 再往左拖
  const pushed = applyOps(doc, planTransitionResize({ transition: transitions[1], edge: 'start', deltaSec: -0.5, fps: doc.fps }).ops);
  const atEdge = detectTransitions({ tracks: pushed.tracks, stage: pushed.stage, native: NATIVE }).transitions[1];
  assert.deepEqual(atEdge.headroom, { start: 0, end: 0.5 });
  const blocked = planTransitionResize({ transition: atEdge, edge: 'start', deltaSec: -0.4, fps: doc.fps });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.ops.length, 0);
  assert.equal(blocked.limited, 'source-head');
  assert.match(blocked.message, /没有多余素材/);
});

test('向右延长被前段出点卡住：夹到 0.5 并报 source-tail', () => {
  const doc = docOf(FIXTURE);
  const { transitions } = detectTransitions({ tracks: doc.tracks, stage: doc.stage, native: NATIVE });
  const plan = planTransitionResize({ transition: transitions[1], edge: 'end', deltaSec: 1, fps: doc.fps });
  assert.equal(plan.ok, true);
  assert.equal(plan.limited, 'source-tail');
  assert.deepEqual(plan.next, { start: 7.5, end: 9, duration: 1.5 });
  assert.deepEqual(plan.ops[0].edits[0], { clip: 't-c', prop: 'end', value: 3 });
  assert.match(plan.message, /前段出点后素材用尽/);
});

test('A4 移除：后段 at 推到前段结束 + 清转场 fade，一批 1 条 op；复原后重新识别为 0', () => {
  const doc = docOf(FIXTURE);
  const { transitions } = detectTransitions({ tracks: doc.tracks, stage: doc.stage, native: NATIVE });
  const plan = planTransitionRemove({ transition: transitions[0] });
  assert.equal(plan.ok, true);
  assert.equal(plan.ops.length, 1);
  assert.equal(plan.shiftsNext, 0.5);
  const next = applyOps(doc, plan.ops);
  const after = detectTransitions({ tracks: next.tracks, stage: next.stage, native: NATIVE });
  assert.deepEqual(after.transitions.map((item) => item.id), ['t-c→t-d']);
  const b = next.tracks[0].clips.find((clip) => clip.id === 't-b');
  assert.equal(b.at, 2);
  assert.equal(b.fade, undefined);
  assert.deepEqual(b.time, [0.5, 3]);
  // t-c/t-d 的转场不受影响；t-a 本来就没有 fade
  const a = next.tracks[0].clips.find((clip) => clip.id === 't-a');
  assert.equal(a.fade, undefined);
});

test('双边写法的 fade 在调整时保持形状（两侧都等于新时长）', () => {
  const doc = docOf(FIXTURE);
  const { transitions } = detectTransitions({ tracks: doc.tracks, stage: doc.stage, native: NATIVE });
  const plan = planTransitionResize({ transition: transitions[1], edge: 'start', deltaSec: -0.2, fps: doc.fps });
  const next = applyOps(doc, plan.ops);
  const t2 = detectTransitions({ tracks: next.tracks, stage: next.stage, native: NATIVE }).transitions[1];
  assert.deepEqual(t2.from.fade, [0, 1.2]);
  assert.deepEqual(t2.to.fade, [1.2, 0]);
});

test('只有重叠没有 fade → 不算转场（unresolved，不画块）', () => {
  const text = FIXTURE.replace(`overrides='[{"fade":[0.5,0]}]'`, '');
  const doc = docOf(text);
  const { transitions, unresolved } = detectTransitions({ tracks: doc.tracks, stage: doc.stage, native: NATIVE });
  assert.deepEqual(transitions.map((item) => item.id), ['t-c→t-d']);
  assert.deepEqual(unresolved.map((item) => item.reason), ['OVERLAP_WITHOUT_FADE']);
});

test('上层没 fade、只有下层有 → crossfadeOk=false（视觉是断的，要说出来）', () => {
  // t-b 是上层却没有 fade；把 fade 挪到前段（下层）
  const text = FIXTURE.replace(`at="1.5" muted overrides='[{"fade":[0.5,0]}]'`, 'at="1.5" muted')
    .replace('at="0" muted style', `at="0" muted overrides='[{"fade":[0,0.5]}]' style`);
  const doc = docOf(text);
  const t1 = detectTransitions({ tracks: doc.tracks, stage: doc.stage, native: NATIVE }).transitions[0];
  assert.equal(t1.crossfadeOk, false);
  assert.equal(t1.fadeOnLower, true);
  assert.equal(t1.top, 'to');
});

test('bareSrc 去掉 #t= / 查询串', () => {
  assert.equal(bareSrc('assets/a.mp4#t=0,2'), 'assets/a.mp4');
  assert.equal(bareSrc('assets/a.mp4'), 'assets/a.mp4');
  assert.equal(bareSrc('assets/a.mp4?x=1#t=0,2'), 'assets/a.mp4');
});

test('不是画面轨、或没有显式 #t= 的相邻段，不硬认成转场', () => {
  const tracks = [
    { index: 0, role: 'audio', clips: [{ id: 's1', kind: 'sound', src: 'assets/x.wav', at: 0, time: [0, 2] }] },
    { index: 1, role: 'picture', clips: [{ id: 'p1', kind: 'video', src: 'assets/x.mp4', at: 0, time: [2, 4] }] },
  ];
  assert.equal(detectTransitions({ tracks, native: NATIVE }).transitions.length, 0);
  const noSpan = [
    { index: 0, role: 'picture', clips: [{ id: 'q1', kind: 'video', src: 'assets/x.mp4', at: 0 }, { id: 'q2', kind: 'video', src: 'assets/y.mp4', at: 0.5 }] },
  ];
  assert.equal(detectTransitions({ tracks: noSpan, native: NATIVE }).transitions.length, 0);
});

/* ── 创建（M28）────────────────────────────────────────────────────── */

const CREATE_FIXTURE = readFileSync(join(import.meta.dirname, '../../..', 'tests/fixtures/main/transition-create.html'), 'utf8');
const CLAMP_FIXTURE = readFileSync(join(import.meta.dirname, '../../..', 'tests/fixtures/main/transition-clamp.html'), 'utf8');
const AUDIO_FIXTURE = readFileSync(join(import.meta.dirname, '../../..', 'tests/fixtures/main/transition-audio.html'), 'utf8');

test('M28-A1 切点：夹具里 3 个候选位置只有 1 个可加（重叠/跨轨都不算）', () => {
  const doc = docOf(CREATE_FIXTURE);
  const { cuts } = detectCutPoints({ tracks: doc.tracks, stage: doc.stage, native: NATIVE });
  assert.equal(cuts.length, 1, JSON.stringify(cuts));
  assert.equal(cuts[0].id, 'c-a→c-b');
  assert.equal(cuts[0].trackIndex, 0);
  assert.equal(cuts[0].at, 8);
  assert.equal(cuts[0].canCreate, true);
  // 后段 2s、前段 2s → 最多能重叠到「后段剩 1 帧」与「不越过前段起点」
  assert.equal(cuts[0].room, 1.967);
  // 已重叠的那一对不会出现在 cuts 里（识别成转场，不是切点）
  assert.equal(cuts.some((cut) => cut.id === 'c-c→c-d'), false);
  // 跨轨（V2 c-e 与 V1 的边界重合）根本不参与：V2 只有一段
  assert.equal(cuts.some((cut) => cut.id.includes('c-e')), false);
});

test('M28-A2 创建写盘形状：后段 at 前移 D、fade[0]=D、前段不动、总时长 −D', () => {
  const doc = docOf(CREATE_FIXTURE);
  const cut = detectCutPoints({ tracks: doc.tracks, stage: doc.stage, native: NATIVE }).cuts[0];
  const plan = planTransitionCreate({ cut, durationSec: 0.5, fps: { num: 30, den: 1 } });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.applied, 0.5);
  assert.equal(plan.code, null);
  assert.equal(plan.audioLinked, false);
  assert.deepEqual(plan.ops, [
    {
      op: 'props',
      edits: [
        { clip: 'c-b', prop: 'at', value: 7.5 },
        { clip: 'c-b', prop: 'fade', value: [0.5, 0] },
      ],
    },
  ]);
  const after = applyOps(doc, plan.ops);
  const b = after.tracks[0].clips.find((clip) => clip.id === 'c-b');
  const a = after.tracks[0].clips.find((clip) => clip.id === 'c-a');
  assert.equal(b.at, 7.5);
  assert.deepEqual(b.time, [0, 2]); // 内容窗口一帧不动
  assert.deepEqual(b.fade, [0.5, 0]);
  assert.equal(a.at, 6);
  assert.equal(a.fade, undefined); // 前段不淡出
  // 硬切在片尾：整片 10s → 9.5s
  const filmEnd = (d) => Math.max(...d.tracks.flatMap((track) => track.clips.map((clip) => spanOf(clip).end)));
  assert.equal(filmEnd(doc), 10);
  assert.equal(filmEnd(after), 9.5);
  // 建完立刻能被识别成转场（同一个纯函数闭环）
  const found = detectTransitions({ tracks: after.tracks, stage: after.stage, native: NATIVE }).transitions;
  const created = found.find((item) => item.id === 'c-a→c-b');
  assert.notEqual(created, undefined, JSON.stringify(found.map((item) => item.id)));
  assert.deepEqual([created.start, created.end, created.duration], [7.5, 8, 0.5]);
  assert.equal(created.crossfadeOk, true);
  assert.equal(found.length, 2); // 夹具里本来就有一处（c-c→c-d）
});

test('M28-A3 余量夹紧：0.5s 放不下 → 停在后段能给的 5 帧，并给原因码', () => {
  const doc = docOf(CLAMP_FIXTURE);
  const { cuts } = detectCutPoints({ tracks: doc.tracks, stage: doc.stage, native: NATIVE });
  const clamped = cuts.find((cut) => cut.id === 'k-a→k-b');
  assert.equal(clamped.canCreate, true);
  assert.equal(clamped.room, 0.167); // 0.2s 后段 − 1 帧
  const plan = planTransitionCreate({ cut: clamped, durationSec: 0.5, fps: { num: 30, den: 1 } });
  assert.equal(plan.ok, true);
  assert.equal(plan.code, 'TRANSITION_HEADROOM_CLAMPED');
  assert.equal(plan.applied, 0.167); // 5 帧 = 0.1667，落盘按毫秒
  assert.equal(plan.requested, 0.5);
  assert.match(plan.message, /源余量不够/);
  assert.deepEqual(plan.ops[0].edits, [
    { clip: 'k-b', prop: 'at', value: 0.833 },
    { clip: 'k-b', prop: 'fade', value: [0.167, 0] },
  ]);
});

test('M28-A3b 连一帧都放不下 → TRANSITION_NO_HEADROOM，0 个 op', () => {
  const doc = docOf(CLAMP_FIXTURE);
  const cut = detectCutPoints({ tracks: doc.tracks, stage: doc.stage, native: NATIVE }).cuts.find((item) => item.id === 'k-c→k-d');
  assert.equal(cut.canCreate, false);
  assert.equal(cut.room, 0);
  const plan = planTransitionCreate({ cut, durationSec: 0.5, fps: { num: 30, den: 1 } });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'TRANSITION_NO_HEADROOM');
  assert.deepEqual(plan.ops, []);
  assert.equal(plan.next, null);
});

test('M28-A5 两侧都有镜像伴生音轨 → 声音双边淡；只有一侧就不动', () => {
  const doc = docOf(AUDIO_FIXTURE);
  const cut = detectCutPoints({ tracks: doc.tracks, stage: doc.stage, native: { 'assets/tone440.mp4': 3, 'assets/tone880.mp4': 3 } }).cuts[0];
  assert.equal(cut.id, 's-a→s-b');
  assert.equal(cut.audioFromId, 's-a-snd');
  assert.equal(cut.audioToId, 's-b-snd');
  const plan = planTransitionCreate({ cut, durationSec: 0.5, fps: { num: 30, den: 1 } });
  assert.equal(plan.audioLinked, true);
  assert.deepEqual(plan.ops[0].edits, [
    { clip: 's-b', prop: 'at', value: 2.5 },
    { clip: 's-b', prop: 'fade', value: [0.5, 0] },
    { clip: 's-a-snd', prop: 'fade', value: [0, 0.5] },
    { clip: 's-b-snd', prop: 'at', value: 2.5 },
    { clip: 's-b-snd', prop: 'fade', value: [0.5, 0] },
  ]);

  // 只留一条伴生音轨：声音那边一行都不改（交叉闭合不了，宁可不猜）
  const onlyOne = AUDIO_FIXTURE.replace('  <audio id="s-b-snd" src="assets/tone880.mp4#t=0,3" at="3"></audio>\n', '');
  const doc2 = docOf(onlyOne);
  const cut2 = detectCutPoints({ tracks: doc2.tracks, stage: doc2.stage, native: { 'assets/tone440.mp4': 3, 'assets/tone880.mp4': 3 } }).cuts[0];
  assert.equal(cut2.audioFromId, 's-a-snd');
  assert.equal(cut2.audioToId, null);
  const plan2 = planTransitionCreate({ cut: cut2, durationSec: 0.5, fps: { num: 30, den: 1 } });
  assert.equal(plan2.audioLinked, false);
  assert.equal(plan2.ops[0].edits.length, 2);
});

test('创建后 undo 逐字段回原（invertOps 反演整批）', () => {
  const doc = docOf(CREATE_FIXTURE);
  const cut = detectCutPoints({ tracks: doc.tracks, stage: doc.stage, native: NATIVE }).cuts[0];
  const plan = planTransitionCreate({ cut, durationSec: 0.5, fps: { num: 30, den: 1 } });
  const after = applyOps(doc, plan.ops);
  const back = applyOps(after, invertOps(doc, plan.ops));
  const b = back.tracks[0].clips.find((clip) => clip.id === 'c-b');
  assert.equal(b.at, 8);
  assert.equal(b.fade, undefined);
});

test('创建：切点不合法 / 没有切点 → 明确报码，不产出 op', () => {
  assert.equal(planTransitionCreate({}).code, 'TRANSITION_CUT_INVALID');
  const doc = docOf(CREATE_FIXTURE);
  const cut = detectCutPoints({ tracks: doc.tracks, stage: doc.stage, native: NATIVE }).cuts[0];
  assert.equal(cut.room, 1.967);
  // 请求超过余量 → 夹到余量（不是报错）
  const big = planTransitionCreate({ cut, durationSec: 5, fps: { num: 30, den: 1 } });
  assert.equal(big.ok, true);
  assert.equal(big.code, 'TRANSITION_HEADROOM_CLAMPED');
  assert.equal(big.applied, 1.967); // 59 帧
});
