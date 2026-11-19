// @ts-nocheck —— 测试以运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * P40-MULTI-RANGE-SUBTITLE · 单测
 *
 * 多段拼接的字幕映射**不在本文件重算**：`film-plan.mjs` 已把每个片段按段切成窗口
 * （`at = segment.outStartSec + (takeStart - segment.start)`），
 * `mapCuesToTimeline` 按这些窗口把「源时间 → 拼接时钟」。
 *
 * 所以夹具直接给**计划层的窗口形状**（同一片段 id 的两张窗口，at=0 / at=2），
 * 验三件事：
 * 1. 跨切点的 cue 被切成**相邻、不重叠**的两条（不是整条出现两次）；
 * 2. 落在被删间隙里的 cue 一条都不出；
 * 3. 记账 splitCount / skippedCount 按**输入 cue** 数，不按输出条数。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildVttDocument, mapCuesToTimeline } from '../subtitles.mjs';

/** `--range 2:4,6:8` 的计划层窗口：同一片段两段，输出时钟 0-2 / 2-4。 */
const WINDOWS = [
  { kind: 'video', id: 'pic', src: '/media/motion.mp4', at: 0, time: [2, 4], speed: 1, duration: 2 },
  { kind: 'video', id: 'pic', src: '/media/motion.mp4', at: 2, time: [6, 8], speed: 1, duration: 2 },
];

const CUES = [
  { index: 1, startSec: 2.5, endSec: 3.5, text: '第一条', id: 'c1' },
  { index: 2, startSec: 3.5, endSec: 6.5, text: '跨两个切点', id: 'c2' },
  { index: 3, startSec: 4.5, endSec: 5.5, text: '全在间隙', id: 'c3' },
  { index: 4, startSec: 6.5, endSec: 7.5, text: '最后一条', id: 'c4' },
];

function map(cues, clips = WINDOWS, durationSec = 4) {
  return mapCuesToTimeline({
    sources: [{ clipId: 'pic', src: '/media/motion.mp4', path: '/media/motion.vtt', format: 'vtt', cues }],
    clips,
    durationSec,
    fps: 30,
  });
}

test('P40-A2：ranges 2:4,6:8 的映射表与任务书逐格相同', () => {
  const out = map(CUES);
  const rows = out.cues.map((cue) => ({
    id: cue.id,
    start: Number(cue.startSec.toFixed(3)),
    end: Number(cue.endSec.toFixed(3)),
  }));
  assert.deepEqual(rows, [
    { id: 'c1', start: 0.5, end: 1.5 },
    { id: 'c2', start: 1.5, end: 2 },
    { id: 'c2', start: 2, end: 2.5 },
    { id: 'c4', start: 2.5, end: 3.5 },
  ]);
  assert.equal(out.splitCount, 1, '跨切点的 c2 记一次 split');
  assert.equal(out.skippedCount, 1, '间隙里的 c3 记一次 skipped');
});

test('P40-A2b：跨切点拆出的两条相邻且不重叠（不整条重复）', () => {
  const pieces = map(CUES).cues.filter((cue) => cue.id === 'c2');
  assert.equal(pieces.length, 2);
  assert.equal(pieces[0].endSec, pieces[1].startSec, '两条必须首尾相接');
  // 任何两条同文本的 cue 都不允许时间重叠（重叠 = 同一句烧两遍）
  const all = map(CUES).cues;
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      if (all[i].text !== all[j].text) continue;
      assert.ok(
        all[i].endSec <= all[j].startSec || all[j].endSec <= all[i].startSec,
        `同文本 cue 时间重叠：${JSON.stringify([all[i], all[j]])}`,
      );
    }
  }
});

test('P40-A4：VTT 用同一张映射表（时间与 ASS 完全一致）', () => {
  const out = map(CUES);
  const vtt = buildVttDocument({ cues: out.cues });
  assert.equal(
    vtt,
    [
      'WEBVTT',
      '',
      '1',
      '00:00:00.500 --> 00:00:01.500',
      '第一条',
      '',
      '2',
      '00:00:01.500 --> 00:00:02.000',
      '跨两个切点',
      '',
      '3',
      '00:00:02.000 --> 00:00:02.500',
      '跨两个切点',
      '',
      '4',
      '00:00:02.500 --> 00:00:03.500',
      '最后一条',
      '',
      '',
    ].join('\n'),
  );
});

test('P40：cue 正好压在切点上（overlapEnd === overlapStart）不输出第二段', () => {
  const out = map([{ index: 1, startSec: 2.5, endSec: 4, text: '压线', id: 'edge' }]);
  assert.equal(out.cues.length, 1);
  assert.equal(Number(out.cues[0].startSec.toFixed(3)), 0.5);
  assert.equal(Number(out.cues[0].endSec.toFixed(3)), 2);
  assert.equal(out.splitCount, 0);
  assert.equal(out.skippedCount, 0);
});

test('P40：零长度 cue 丢弃并计入 skippedCount', () => {
  const out = map([{ index: 1, startSec: 3, endSec: 3, text: '零长', id: 'zero' }]);
  assert.equal(out.cues.length, 0);
  assert.equal(out.skippedCount, 1);
  assert.equal(out.splitCount, 0);
});

test('P40：单段窗口与 R22 同一条映射（0.5-1.5，不拆不跳）', () => {
  const single = [{ kind: 'video', id: 'pic', src: '/media/motion.mp4', at: 0, time: [2, 4], speed: 1, duration: 2 }];
  const out = map(CUES.slice(0, 1), single, 2);
  assert.deepEqual(
    out.cues.map((cue) => [Number(cue.startSec.toFixed(3)), Number(cue.endSec.toFixed(3))]),
    [[0.5, 1.5]],
  );
  assert.equal(out.splitCount, 0);
  assert.equal(out.skippedCount, 0);
});

test('P40：多段 warning 说明「按段切开」「落在被删区间」两件事', () => {
  const out = map(CUES);
  assert.ok(out.warnings.some((warning) => warning.includes('crossed a cut')), out.warnings.join(' | '));
  assert.ok(out.warnings.some((warning) => warning.includes('removed range')), out.warnings.join(' | '));
});

test('P40：片段不在计划里（素材没用到）仍走 dropped，不算 skipped', () => {
  const out = mapCuesToTimeline({
    sources: [{ clipId: 'ghost', src: '/media/ghost.mp4', path: '/media/ghost.vtt', format: 'vtt', cues: [{ index: 1, startSec: 0, endSec: 1, text: '孤儿', id: null }] }],
    clips: WINDOWS,
    durationSec: 4,
    fps: 30,
  });
  assert.equal(out.dropped, 1);
  assert.equal(out.skippedCount, 0);
  assert.equal(out.cues.length, 0);
});
