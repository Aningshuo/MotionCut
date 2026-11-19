// @ts-nocheck —— 以 node --test 的运行时断言为准；产品模块仍由 tsc 严格检查。
import assert from 'node:assert/strict';
import test from 'node:test';

import { createHash } from 'node:crypto';

import { applyOps } from '../ops.mjs';
import { parse, writeValue } from '../film-doc.mjs';
import {
  audioSplitOf,
  audioTwinOf,
  bareSrcOf,
  findClipOf,
  isVideoSrc,
  planSplitAudioOps,
  splitAudioIdOf,
} from '../track-audio.mjs';

const FILM = `<!doctype html>
<html><head><meta name="viewport" content="width=1280, height=720"></head>
<body>
<section id="picture">
  <video id="v1" src="assets/phone.mp4#t=0,3" at="0" muted></video>
  <video id="v2" src="assets/phone.mp4#t=1,4" at="5" muted></video>
</section>
<section id="sound">
  <audio id="bgm" src="assets/bgm.wav#t=0,2" at="0"></audio>
</section>
</body></html>
`;

/** @param {string} text */
function docOf(text) {
  const parsed = parse(text, { native: { 'assets/phone.mp4': 10, 'assets/bgm.wav': 2 } });
  assert.deepEqual(parsed.diagnostics ?? [], []);
  return parsed.doc;
}

/** @param {string} text @param {any} doc */
function writeDoc(text, doc) {
  const out = writeValue(text, doc, createHash('sha256').update(text).digest('hex'));
  assert.equal(out.ok, true, JSON.stringify(out.diagnostics ?? []));
  return /** @type {string} */ (out.text);
}

test('A1 只有视频容器算「可能有音轨」；音频/图片/网页不参与', () => {
  assert.equal(isVideoSrc('assets/a.mp4'), true);
  assert.equal(isVideoSrc('assets/a.mp4#t=0,3'), true);
  assert.equal(isVideoSrc('assets/a.MOV'), true);
  assert.equal(isVideoSrc('assets/a.wav'), false);
  assert.equal(isVideoSrc('assets/a.html'), false);
  assert.equal(isVideoSrc('assets/a.png'), false);
  assert.equal(bareSrcOf('assets/a.mp4?x=1#t=0,3'), 'assets/a.mp4');

  const doc = docOf(FILM);
  assert.equal(audioSplitOf(doc, findClipOf(doc, 'v1').clip).status, 'pending');
  assert.equal(audioSplitOf(doc, findClipOf(doc, 'bgm').clip).status, 'not-video');
});

test('A2 计划：一条 insert Op，指向同一个 mp4、at/time 与视频一致、volume=1', () => {
  const doc = docOf(FILM);
  const planned = planSplitAudioOps(doc, 'v2');
  assert.equal(planned.ok, true);
  assert.equal(planned.ops.length, 1, '一次分离只发一条 Op');
  const op = planned.ops[0];

  assert.equal(op.op, 'insert');
  assert.equal(op.at, 5, '和视频的 at 一致');
  assert.equal(op.clip.kind, 'sound');
  assert.equal(op.clip.sound, true, 'sound 标记必须给：否则写回后的重解析与目标不一致');
  assert.equal(op.clip.src, 'assets/phone.mp4', '不带 #t=（区间走 time）');
  assert.deepEqual(op.clip.time, [1, 4], '和视频的 time 一致');
  assert.equal(op.clip.volume, 1);
  assert.equal(op.clip.muted, undefined, '声音片段不带 muted');
  assert.equal(planned.clipId, 'v2-audio');
  assert.equal(planned.videoId, 'v2');
});

test('A3 落盘：<audio> 指向同一个 mp4，写回后重解析 sound:true 且不再提示', () => {
  const doc = docOf(FILM);
  const planned = planSplitAudioOps(doc, 'v1');
  const next = applyOps(doc, planned.ops);
  const text = writeDoc(FILM, next);

  // at=0 时省略属性（方言里 0 就是默认值），与视频的 at="0" 语义相同
  assert.match(text, /<audio id="v1-audio" src="assets\/phone\.mp4#t=0,3" volume="1"><\/audio>/);
  assert.match(text, /<video id="v1" src="assets\/phone\.mp4#t=0,3" at="0" muted><\/video>/, '视频一字未改');
  // 不许出现复制出来的媒体：只有一个源文件路径
  assert.equal((text.match(/assets\/phone\.mp4/g) ?? []).length, 3, '视频 ×2 + 分离出的音频 ×1，没有第二个文件');

  const reparsed = docOf(text);
  const twin = audioTwinOf(reparsed, findClipOf(reparsed, 'v1').clip);
  assert.notEqual(twin, null);
  assert.equal(twin.kind, 'sound');
  assert.equal(twin.sound, true, '方言里的既有写法：<audio> 装 mp4 → sound=true');
  assert.equal(audioSplitOf(reparsed, findClipOf(reparsed, 'v1').clip).status, 'split');
  // v2 是同一文件的另一段：它还没分离
  assert.equal(audioSplitOf(reparsed, findClipOf(reparsed, 'v2').clip).status, 'pending');
});

test('A4 幂等：第二次给 ALREADY_SPLIT、零 Op', () => {
  const doc = docOf(FILM);
  const once = applyOps(doc, planSplitAudioOps(doc, 'v1').ops);
  const again = planSplitAudioOps(once, 'v1');
  assert.equal(again.ok, false);
  assert.equal(again.code, 'ALREADY_SPLIT');
  assert.equal(again.ops, undefined, '不许再产出 Op');
});

test('A5 手写 <audio src="x.mp4"> 也算已分离；另一段区间不算', () => {
  const manual = `<!doctype html>
<html><head><meta name="viewport" content="width=1280, height=720"></head>
<body>
<section id="picture"><video id="v1" src="assets/phone.mp4#t=0,3" at="0" muted></video></section>
<section id="sound"><audio id="mine" src="assets/phone.mp4#t=0,3" at="0" volume="0.5"></audio></section>
</body></html>
`;
  const doc = docOf(manual);
  const state = audioSplitOf(doc, findClipOf(doc, 'v1').clip);
  assert.equal(state.status, 'split');
  assert.equal(state.twin.id, 'mine', '认用户自己手写的那条');

  // 同一文件、区间不同的另一条声音：不是孪生，仍然提示（那是他自己要的第二条声）
  const other = `<!doctype html>
<html><head><meta name="viewport" content="width=1280, height=720"></head>
<body>
<section id="picture"><video id="v1" src="assets/phone.mp4#t=0,3" at="0" muted></video></section>
<section id="sound"><audio id="lead" src="assets/phone.mp4#t=5,7" at="9" volume="0.5"></audio></section>
</body></html>
`;
  const doc2 = docOf(other);
  assert.equal(audioSplitOf(doc2, findClipOf(doc2, 'v1').clip).status, 'pending');
  assert.equal(audioTwinOf(doc2, findClipOf(doc2, 'v1').clip), null);
});

test('A6 变速视频：声音跟着写 speed（否则时间线长度对不上）', () => {
  const film = `<!doctype html>
<html><head><meta name="viewport" content="width=1280, height=720"></head>
<body><section id="picture"><video id="v1" src="assets/phone.mp4#t=0,4" at="0" speed="2" muted></video></section></body></html>
`;
  const doc = docOf(film);
  const planned = planSplitAudioOps(doc, 'v1');
  assert.equal(planned.ok, true);
  assert.equal(planned.ops[0].clip.speed, 2);
  // 片段在时间线上占 4/2 = 2s，声音也占 2s
  const next = applyOps(doc, planned.ops);
  const twin = audioTwinOf(next, findClipOf(next, 'v1').clip);
  assert.notEqual(twin, null);
  assert.equal(twin.speed, 2);
});

test('A7 边界：at=0 不写 at 属性、id 撞了加序号、没有区间的拒绝', () => {
  const doc = docOf(FILM);
  const op = planSplitAudioOps(doc, 'v1').ops[0];
  assert.equal('at' in op.clip, false, 'at=0 时省略（与 insert 的既有写法一致）');

  assert.equal(splitAudioIdOf(doc, 'v1'), 'v1-audio');
  const busy = `<!doctype html>
<html><head><meta name="viewport" content="width=1280, height=720"></head>
<body>
<section id="picture"><video id="v1" src="assets/phone.mp4#t=0,3" at="0" muted></video></section>
<section id="sound"><audio id="v1-audio" src="assets/bgm.wav#t=0,2" at="9"></audio></section>
</body></html>
`;
  assert.equal(splitAudioIdOf(docOf(busy), 'v1'), 'v1-audio-2', '撞 id 时加序号');

  // 没有 #t= 又读不出源时长：不知道要分离哪一段 → 明确拒绝，别猜
  const noSpan = `<!doctype html>
<html><head><meta name="viewport" content="width=1280, height=720"></head>
<body><section id="picture"><video id="v1" src="assets/phone.mp4" at="0" muted></video></section></body></html>
`;
  const parsed = parse(noSpan, { native: {} });
  const planned = planSplitAudioOps(parsed.doc, 'v1');
  assert.equal(planned.ok, false);
  assert.equal(planned.code, 'NO_TIME_SPAN');

  // 不存在的片段 / 非视频
  assert.equal(planSplitAudioOps(doc, 'nope').code, 'CLIP_NOT_FOUND');
  assert.equal(planSplitAudioOps(doc, 'bgm').code, 'NOT_VIDEO');
});

test('A8 撤销一步回到原样：去掉 insert 后文本逐字节相同', () => {
  const doc = docOf(FILM);
  const planned = planSplitAudioOps(doc, 'v1');
  const added = applyOps(doc, planned.ops);
  const withAudio = writeDoc(FILM, added);

  // 撤销 = 反向 Op（宿主的历史是快照式的，这里用「删掉那条片段」验证可逆）
  const reverted = applyOps(added, [{ op: 'remove', clip: planned.clipId }]);
  const back = writeDoc(withAudio, reverted);
  assert.equal(
    createHash('sha256').update(back).digest('hex'),
    createHash('sha256').update(FILM).digest('hex'),
    '撤销后必须逐字节回到操作前的 film.html',
  );
});
