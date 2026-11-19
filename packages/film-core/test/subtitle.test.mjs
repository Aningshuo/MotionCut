// @ts-nocheck —— 以 node --test 的运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * 字幕解析/序列化单测（M24 · B-MAIN-R12-012）。
 *
 * A1 vtt（NOTE 块 / 无标识行 / `<i>` 标签）、A2 srt（逗号毫秒）与同内容 vtt 逐条相等、
 * A3 非法 cue 跳过并计数不抛。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  companionCandidates,
  detectFormat,
  formatCueTime,
  formatOf,
  normalizeCues,
  parseCueTime,
  parseSubtitles,
  serializeSubtitles,
} from '../subtitle.mjs';

const VTT = `WEBVTT - M24 夹具

NOTE 这一段是注释，解析时要整块跳过
它还占两行

STYLE
::cue { color: white }

00:00:01.000 --> 00:00:02.500
<i>第一句</i>

cue-3
00:00:03.000 --> 00:00:04.000
第二句
换行也要保留

00:00:05.000 --> 00:00:06.250
<c.yellow>第三句</c>
`;

const SRT = `1
00:00:01,000 --> 00:00:02,500
<i>第一句</i>

2
00:00:03,000 --> 00:00:04,000
第二句
换行也要保留

3
00:00:05,000 --> 00:00:06,250
<c.yellow>第三句</c>
`;

test('A1 解析 vtt：NOTE/STYLE 跳过、无标识行、去 <i>、保留换行', () => {
  const parsed = parseSubtitles(VTT);
  assert.equal(parsed.format, 'vtt');
  assert.equal(parsed.skipped, 0);
  assert.equal(parsed.cues.length, 3);
  assert.deepEqual(parsed.cues[0], { start: 1, end: 2.5, text: '第一句' });
  assert.deepEqual(parsed.cues[1], { start: 3, end: 4, text: '第二句\n换行也要保留' });
  assert.deepEqual(parsed.cues[2], { start: 5, end: 6.25, text: '第三句' });
});

test('A2 srt（逗号毫秒）与同内容 vtt 逐条相等', () => {
  const vtt = parseSubtitles(VTT);
  const srt = parseSubtitles(SRT);
  assert.equal(srt.format, 'srt');
  assert.equal(srt.skipped, 0);
  assert.deepEqual(srt.cues, vtt.cues);
});

test('A3 非法 cue：end<start / 时间格式坏 / 只有时间没文字 → 跳过并计数，不抛', () => {
  const broken = `WEBVTT

00:00:02.000 --> 00:00:01.000
倒置

00:00:0x.000 --> 00:00:04.000
坏格式

00:00:05.000 --> 00:00:06.000

00:00:07.000 --> 00:00:08.000
好的一条
`;
  const parsed = parseSubtitles(broken);
  assert.equal(parsed.skipped, 3);
  assert.equal(parsed.cues.length, 1);
  assert.deepEqual(parsed.cues[0], { start: 7, end: 8, text: '好的一条' });
});

test('时间戳：解析与格式化互为反函数', () => {
  assert.equal(parseCueTime('00:00:01.500'), 1.5);
  assert.equal(parseCueTime('00:01:02,250'), 62.25);
  assert.equal(parseCueTime('01:02:03.004'), 3723.004);
  assert.equal(parseCueTime('01:30.500'), 90.5); // MM:SS.mmm
  assert.equal(parseCueTime('00:99:00.000'), null);
  assert.equal(parseCueTime('坏'), null);
  assert.equal(formatCueTime(1.5), '00:00:01.500');
  assert.equal(formatCueTime(62.25, { comma: true }), '00:01:02,250');
  assert.equal(formatCueTime(3723.004), '01:02:03.004');
  for (const seconds of [0, 0.001, 12.345, 3599.999, 3600, 7261.5]) {
    assert.equal(parseCueTime(formatCueTime(seconds)), seconds);
  }
});

test('序列化：vtt 头是 WEBVTT、按 start 升序、SRT 带序号与逗号', () => {
  const cues = [
    { start: 5, end: 6.25, text: '后面' },
    { start: 1, end: 2.5, text: '第一句\n第二行' },
  ];
  const vtt = serializeSubtitles(cues);
  assert.match(vtt, /^WEBVTT\n\n/);
  assert.ok(vtt.indexOf('第一句') < vtt.indexOf('后面'));
  const back = parseSubtitles(vtt);
  assert.equal(back.cues.length, 2);
  assert.deepEqual(back.cues[0], { start: 1, end: 2.5, text: '第一句\n第二行' });

  const srt = serializeSubtitles(cues, { format: 'srt' });
  assert.match(srt, /^1\n00:00:01,000 --> 00:00:02,500\n/);
  assert.deepEqual(parseSubtitles(srt).cues, back.cues);
});

test('伴生定位：a.mp4 → a.vtt / a.srt（vtt 优先），带子目录与 #t= 也对', () => {
  assert.deepEqual(companionCandidates('assets/a.mp4'), ['assets/a.vtt', 'assets/a.srt']);
  assert.deepEqual(companionCandidates('a.mp4'), ['a.vtt', 'a.srt']);
  assert.deepEqual(companionCandidates('assets/take.final.mp4#t=0,8'), ['assets/take.final.vtt', 'assets/take.final.srt']);
  assert.deepEqual(companionCandidates('assets/noext'), ['assets/noext.vtt', 'assets/noext.srt']);
  assert.deepEqual(companionCandidates(''), []);
  assert.equal(formatOf('a.VTT'), 'vtt');
  assert.equal(formatOf('a.srt'), 'srt');
  assert.equal(formatOf('a.ass'), null);
});

test('detectFormat：WEBVTT 头优先，其次逗号毫秒', () => {
  assert.equal(detectFormat(VTT), 'vtt');
  assert.equal(detectFormat(SRT), 'srt');
  assert.equal(detectFormat('\uFEFFWEBVTT\n\n'), 'vtt');
});

test('normalizeCues：非法（倒置/空文本/非数字）抛人话', () => {
  assert.throws(() => normalizeCues([{ start: 2, end: 1, text: 'x' }]), /结束时间必须大于开始时间/);
  assert.throws(() => normalizeCues([{ start: 0, end: 1, text: '  ' }]), /没有文本/);
  assert.throws(() => normalizeCues([{ start: 'x', end: 1, text: 'a' }]), /不是有效秒数/);
  assert.throws(() => normalizeCues('nope'), /必须是数组/);
  assert.deepEqual(normalizeCues([{ start: 3.0004, end: 4, text: 'b' }, { start: 1, end: 2, text: 'a' }]), [
    { start: 1, end: 2, text: 'a' },
    { start: 3, end: 4, text: 'b' },
  ]);
});
