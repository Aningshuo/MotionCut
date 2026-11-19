// @ts-nocheck —— 用例里直接用手写的 cue 字面量（只要 startSec/endSec/text），
// 类型层的 `Cue` 还要求 index/id，那是映射层的产物，与本文件要验的「行距 → ASS」无关。
/**
 * P53：行距落进 ASS（`subtitleLineStep` → 逐行 `\pos`）。
 *
 * 三条不变量，任何一条破了都意味着「预览改了、成片没改」又回来了：
 * 1. 默认行距（1.25）**一个 `\pos` 都不许出现**，字节与 R22 相同（`\N` 路径）；
 * 2. 非默认行距的多行 cue：每行一个事件，行步进 = `fontSizePx × em`，**底边锚定**；
 * 3. 单行 cue 在两种行距下都不加 `\pos`（一行没有「行距」）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { subtitleLineStep } from '../../film-core/subtitle-layout.mjs';
import { buildAssDocument, parseAssDocument, planAssEvents } from '../subtitles.mjs';

const SIZE = { w: 1280, h: 720 };
const TWO_LINES = '行距基准测试一\n行距基准测试一';

/** @param {string} text */
function dialogues(text) {
  return text.split('\n').filter((line) => line.startsWith('Dialogue:'));
}

/** @param {string} text */
function styleLine(text) {
  return text.split('\n').find((line) => line.startsWith('Style: Default,')) ?? '';
}

test('P53 默认行距：多行仍走 `\\N`，不出现 `\\pos`，与 R22 的 738 字节一致', () => {
  const ass = buildAssDocument({
    cues: [
      { startSec: 0.4, endSec: 1.6, text: '第一句字幕' },
      { startSec: 1.8, endSec: 2.6, text: '第二句字幕' },
    ],
    size: SIZE,
    generator: 'audit/r29',
  });
  assert.equal(Buffer.byteLength(ass, 'utf8'), 738);
  assert.equal(ass.includes('\\pos('), false);
  assert.equal(dialogues(ass).length, 2);
  assert.equal(subtitleLineStep({ lineHeight: 1.25 }).isDefault, true);
});

test('P53 非默认行距：多行 cue 拆成每行一个事件，行步进 = fontSizePx × em', () => {
  const ass = buildAssDocument({ cues: [{ startSec: 0.4, endSec: 1.6, text: TWO_LINES }], size: SIZE, subtitleStyle: { lineHeight: 1.8 } });
  const rows = dialogues(ass);
  assert.equal(rows.length, 2, '两条 Dialogue：`\\pos` 是事件级标签，一行一个');
  const positions = rows.map((row) => {
    const match = /\\pos\((\d+),([\d.]+)\)/.exec(row);
    assert.ok(match, `missing \\pos in ${row}`);
    return { x: Number(match[1]), y: Number(match[2]) };
  });
  assert.deepEqual(positions.map((p) => p.x), [640, 640], 'an=2 居中：x 就是画布中线');

  const fontSizePx = Number(/Style: Default,[^,]+,(\d+),/.exec(styleLine(ass))[1]);
  const marginV = Number(styleLine(ass).split(',')[21]);
  const step = subtitleLineStep({ lineHeight: 1.8 });
  const expected = fontSizePx * step.em;
  assert.ok(Math.abs((positions[1].y - positions[0].y) - expected) < 0.01, `step ${positions[1].y - positions[0].y} != ${expected}`);
  assert.equal(positions[1].y, 720 - marginV, '底边锚定：最后一行落在画布高 − MarginV');
});

test('P53 行距 1.0：步进比默认更小，底边仍钉在同一个位置', () => {
  const ass = buildAssDocument({ cues: [{ startSec: 0.4, endSec: 1.6, text: TWO_LINES }], size: SIZE, subtitleStyle: { lineHeight: 1.0 } });
  const rows = dialogues(ass).map((row) => Number(/\\pos\(\d+,([\d.]+)\)/.exec(row)[1]));
  assert.equal(rows.length, 2);
  const fontSizePx = Number(/Style: Default,[^,]+,(\d+),/.exec(styleLine(ass))[1]);
  const marginV = Number(styleLine(ass).split(',')[21]);
  assert.ok(Math.abs((rows[1] - rows[0]) - fontSizePx * 0.8) < 0.01);
  assert.equal(rows[1], 720 - marginV);
});

test('P53 单行 cue：非默认行距下也不加 `\\pos`（差分必须为 0）', () => {
  const single = { cues: [{ startSec: 0.2, endSec: 1.8, text: '单行字幕不该动' }], size: SIZE };
  const atDefault = buildAssDocument({ ...single, subtitleStyle: { lineHeight: 1.25 } });
  const atWide = buildAssDocument({ ...single, subtitleStyle: { lineHeight: 1.8 } });
  assert.equal(atWide.includes('\\pos('), false);
  assert.equal(dialogues(atWide).length, 1);
  // Style 行的 MarginV 会随 lineHeight 的 halfLeading 变（S41 的既有口径），但事件本身不变
  const body = (/** @type {string} */ text) => text.split('\n').filter((line) => !line.startsWith('Style:') && !line.startsWith(';'));
  assert.deepEqual(body(atWide), body(atDefault));
});

test('P53 planAssEvents：默认行距下事件数 == cue 数，非默认下 == 行数', () => {
  const cues = [
    { startSec: 0, endSec: 1, text: TWO_LINES },
    { startSec: 1, endSec: 2, text: '单行' },
  ];
  const def = buildAssDocument({ cues, size: SIZE, subtitleStyle: { lineHeight: 1.25 } });
  assert.equal(dialogues(def).length, 2);
  const wide = buildAssDocument({ cues, size: SIZE, subtitleStyle: { lineHeight: 1.8 } });
  assert.equal(dialogues(wide).length, 3);
  // 直调：`planAssEvents` 必须与 `buildAssDocument` 用同一套切分（回读对账就靠它）
  const fields = { fontSizePx: 32, marginV: 71, style: { lineHeight: 1.8 }, stage: SIZE };
  const events = planAssEvents(cues, /** @type {any} */ (fields), SIZE);
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((row) => row.lineIndex), [0, 1, 0]);
  assert.equal(events[2].pos, null, '单行 cue 不定位');
  assert.deepEqual(events[1].pos, { x: 640, y: 720 - 71 });
});

test('P53 回读：逐行事件的时间与 cue 一致（prepareSubtitleBurn 的对账基准）', () => {
  const ass = buildAssDocument({ cues: [{ startSec: 0.4, endSec: 1.6, text: TWO_LINES }], size: SIZE, subtitleStyle: { lineHeight: 1.8 } });
  const back = parseAssDocument(ass);
  assert.equal(back.cues.length, 2);
  for (const cue of back.cues) {
    assert.ok(Math.abs(cue.startSec - 0.4) <= 0.01);
    assert.ok(Math.abs(cue.endSec - 1.6) <= 0.01);
  }
});
