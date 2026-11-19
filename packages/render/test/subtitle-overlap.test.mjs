// @ts-nocheck —— 测试以运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * P43：分数帧率下同一轨 cue 的单调约束。
 *
 * 根因是「起点 floor、终点 ceil」——向外取整本身是对的（不能吞句首句尾），但相邻两条
 * 各自向外扩，在 33.37ms 的格上就叠出一帧：前一条 ceil 到第 k+1 帧、后一条 floor 到
 * 第 k 帧。`clampCueOverlaps` 只对**原本不重叠**的相邻 cue 把后一条的起点推到前一条
 * 的终点；原本就重叠的（双语双行/卡拉 OK）保持原样。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clampCueOverlaps, mapCuesToTimeline } from '../subtitles.mjs';
import { rateOfFps } from '../fps.mjs';

const NTSC = { num: 30000, den: 1001 };
const FRAME = 1001 / 30000;

/**
 * @param {number} startSec
 * @param {number} endSec
 * @param {string} text
 * @param {{ sourceStartSec?: number, sourceEndSec?: number }} [extra]
 */
function cue(startSec, endSec, text, extra = {}) {
  return {
    index: 1,
    startSec,
    endSec,
    text,
    id: null,
    ...(extra.sourceStartSec !== undefined ? { sourceStartSec: extra.sourceStartSec } : {}),
    ...(extra.sourceEndSec !== undefined ? { sourceEndSec: extra.sourceEndSec } : {}),
  };
}

/** 任意两个相邻 cue 都不重叠，且原本连续的确实首尾相接。 */
function assertMonotonic(cues) {
  for (let i = 1; i < cues.length; i += 1) {
    const prev = cues[i - 1];
    const next = cues[i];
    assert.ok(
      next.startSec >= prev.endSec - 1e-9,
      `cue ${i} starts at ${next.startSec} before previous ends at ${prev.endSec}`,
    );
  }
  for (const c of cues) assert.ok(c.endSec > c.startSec, `cue has non-positive length: ${c.startSec}-${c.endSec}`);
}

test('P43：连续三条（原本首尾相接）在 29.97 下落格后不再叠帧', () => {
  // 源时间 0-1 / 1-2 / 2-3；未 clamp 时 floor/ceil 会得到 0-1.001 / 0.968-2.002 / 1.968-3.003
  const raw = [
    cue(0, 30 * FRAME, '一', { sourceStartSec: 0, sourceEndSec: 1 }),
    cue(29 * FRAME, 60 * FRAME, '二', { sourceStartSec: 1, sourceEndSec: 2 }),
    cue(59 * FRAME, 90 * FRAME, '三', { sourceStartSec: 2, sourceEndSec: 3 }),
  ];
  const before = raw.map((c) => [Number(c.startSec.toFixed(4)), Number(c.endSec.toFixed(4))]);
  // 前置条件：不 clamp 的话确实重叠（否则这条用例什么都没测）
  assert.ok(raw[1].startSec < raw[0].endSec);
  assert.ok(raw[2].startSec < raw[1].endSec);

  const out = clampCueOverlaps(raw, { rate: NTSC, durationSec: 3.5 });
  assert.equal(out.clamped, 2);
  assert.equal(out.dropped, 0);
  assertMonotonic(out.cues);
  assert.deepEqual(
    out.cues.map((c) => [Number(c.startSec.toFixed(6)), Number(c.endSec.toFixed(6))]),
    [
      [0, Number((30 * FRAME).toFixed(6))],
      [Number((30 * FRAME).toFixed(6)), Number((60 * FRAME).toFixed(6))],
      [Number((60 * FRAME).toFixed(6)), Number((90 * FRAME).toFixed(6))],
    ],
    `raw=${JSON.stringify(before)}`,
  );
});

test('P43：三条之间都有间隙时不改任何东西', () => {
  const raw = [
    cue(0, 30 * FRAME, '一', { sourceStartSec: 0, sourceEndSec: 1 }),
    cue(2, 2 + 30 * FRAME, '二', { sourceStartSec: 2, sourceEndSec: 3 }),
    cue(4, 4 + 30 * FRAME, '三', { sourceStartSec: 4, sourceEndSec: 5 }),
  ];
  const out = clampCueOverlaps(raw, { rate: NTSC, durationSec: 10 });
  assert.equal(out.clamped, 0);
  assert.equal(out.dropped, 0);
  assert.deepEqual(
    out.cues.map((c) => [c.startSec, c.endSec]),
    raw.map((c) => [c.startSec, c.endSec]),
  );
});

test('P43：跨段拼接 —— 同一条 cue 被切点切成两段，边界相接且不重叠', () => {
  const source = {
    src: '/tmp/long.mp4',
    path: '/tmp/long.vtt',
    format: /** @type {'vtt'} */ ('vtt'),
    clipId: 'clip-1',
    cues: [
      { index: 1, id: null, startSec: 0.5, endSec: 3.5, text: '第一条' },
      { index: 2, id: null, startSec: 3.5, endSec: 6.5, text: '跨两个切点' },
      { index: 3, id: null, startSec: 6.5, endSec: 7.5, text: '第四条' },
    ],
  };
  // 两段窗口 [0,4] 与 [6,8]；计划层给**同一个** clip.id（多段是同一轨道的两个窗口），
  // 第二段紧接第一段（at=4.004 是 29.97 下的段起点）。
  const clips = [
    { id: 'clip-1', kind: 'video', src: '/tmp/long.mp4', time: [0, 4], at: 0, duration: 4, speed: 1 },
    { id: 'clip-1', kind: 'video', src: '/tmp/long.mp4', time: [6, 8], at: 4.004, duration: 2, speed: 1 },
  ];
  const out = mapCuesToTimeline({ sources: [source], clips, durationSec: 6.006, fps: NTSC });
  assert.equal(out.splitCount, 1);
  assertMonotonic(out.cues);
  // 跨切点的那条在两个窗口里各出一段：[3.5,4] 与 [6,6.5]
  assert.equal(out.cues.length, 4);
  const crossing = out.cues.filter((c) => c.text === '跨两个切点');
  assert.equal(crossing.length, 2);
  assert.ok(crossing[0].endSec <= crossing[1].startSec + 1e-9, '段与段之间也必须首尾相接');
});

test('P43：原本就重叠的 cue（双语双行/卡拉 OK）不被拆开', () => {
  const raw = [
    cue(0, 30 * FRAME, '中文', { sourceStartSec: 0, sourceEndSec: 1 }),
    // 源时间 0.5-1.5 与上一条重叠 → 允许成片里也重叠
    cue(15 * FRAME, 45 * FRAME, 'English', { sourceStartSec: 0.5, sourceEndSec: 1.5 }),
  ];
  const out = clampCueOverlaps(raw, { rate: NTSC, durationSec: 3 });
  assert.equal(out.clamped, 0);
  assert.equal(out.cues[1].startSec, raw[1].startSec);
  assert.ok(out.cues[1].startSec < out.cues[0].endSec, '原本重叠的两条应该仍然重叠');
});

test('P43：被压没 —— 补到 start+1 帧；贴到片尾放不下就丢掉（不输出零长 cue）', () => {
  // 第二条只剩不到一帧：clamp 后 end <= start → 补一帧
  const squeezed = [
    cue(0, 30 * FRAME, '长', { sourceStartSec: 0, sourceEndSec: 1 }),
    cue(29 * FRAME, 30 * FRAME, '极短', { sourceStartSec: 1, sourceEndSec: 1.02 }),
  ];
  const fixed = clampCueOverlaps(squeezed, { rate: NTSC, durationSec: 3 });
  assert.equal(fixed.clamped, 1);
  assert.equal(fixed.dropped, 0);
  assert.equal(fixed.cues.length, 2);
  assert.ok(Math.abs(fixed.cues[1].endSec - (fixed.cues[1].startSec + FRAME)) < 1e-9);
  assertMonotonic(fixed.cues);

  // 片尾：clamp 后起点正好等于 duration，补一帧会越界 → 丢弃
  const atTail = [
    cue(0, 60 * FRAME, '长', { sourceStartSec: 0, sourceEndSec: 2 }),
    cue(59 * FRAME, 60 * FRAME, '片尾', { sourceStartSec: 2, sourceEndSec: 2.01 }),
  ];
  const dropped = clampCueOverlaps(atTail, { rate: NTSC, durationSec: 60 * FRAME });
  assert.equal(dropped.clamped, 1);
  assert.equal(dropped.dropped, 1);
  assert.equal(dropped.cues.length, 1);
  assertMonotonic(dropped.cues);
});

test('P43：整数帧率且 cue 在格点上时完全不动（30fps 字节锁的前提）', () => {
  const rate = rateOfFps(30);
  const raw = [
    cue(0, 1, '一', { sourceStartSec: 0, sourceEndSec: 1 }),
    cue(1, 2, '二', { sourceStartSec: 1, sourceEndSec: 2 }),
    cue(2, 3, '三', { sourceStartSec: 2, sourceEndSec: 3 }),
  ];
  const out = clampCueOverlaps(raw, { rate, durationSec: 3, ...{} });
  assert.equal(out.clamped, 0);
  assert.deepEqual(
    out.cues.map((c) => [c.startSec, c.endSec]),
    raw.map((c) => [c.startSec, c.endSec]),
  );
});
