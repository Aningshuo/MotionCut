// @ts-nocheck —— 测试以运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * P39-SUBTITLE-LINE-PLAN · 单测
 *
 * 这一批的判据只有两条，其余都是推论：
 * 1. **默认短句逐字节不变**（三画幅 sha 与 R22 相同）；
 * 2. **长句排成 2 行、写进 ASS 的是字面 `\N`**，且三画幅吃的是同一组行。
 *
 * 行排是 `packages/film-core/subtitle-layout.mjs` 的共享纯函数（ADR-R24-01，冻结）。
 * 这里不重算断点，只验「render 把计划层的 lines 原样写进 ASS」这条接线。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  buildAssDocument,
  planCueLines,
  parseAssDocument,
} from '../subtitles.mjs';
import { planSubtitleLines } from '../../film-core/subtitle-layout.mjs';
import { SUBTITLE_CANVAS_TABLE, toAssStyle } from '../../layers/subtitle-style.mjs';
import { SUBTITLE_PRESETS, listSubtitlePresets } from '../../layers/subtitle-presets.mjs';

const STAGE = { w: 1280, h: 720 };
const CANVASES = [
  { id: '720p', w: 1280, h: 720 },
  { id: 'portrait', w: 1080, h: 1920 },
  { id: '4k', w: 3840, h: 2160 },
];

/** R22 的三份默认 ASS（S43 任务书冻结值）。 */
/* R31 重冻：默认描边 0.12 → 0.055（参照 `widthEm`），三格 sha 全变。旧值见 `3fe64154`。
   R32 再重冻：字号 0.045 → 0.04 + 描边色 rgba(0,0,0,0.84)，三格 sha 全变、字节数不变
   （739/741/743 —— 32→29、62→61、&H00000000→&H29000000 都不换位数）。
   两轮独立生成逐位相同（可复现性 0）。 */
/* R32（BATCH-MAIN-R30-090）：MarginV 由 round 改 floor —— 非 720p 两格各掉 1
   （portrait 708→707、4k 184→183），720p 一个字节没动（61 = floor(61.2)）。
   字节数不变，只有 Style 行里的 MarginV 数字变，所以 sha 换、长度不换。 */
const DEFAULT_SHA = {
  '720p': 'a83c7b4e252602a323bb7a20edb4f46dfff18cc00173787d9435908e3a3d525b',
  portrait: '760351487eab367f1b5c30e4bc648f085266b8a71a106c5b6694cc99e42e0dc9',
  '4k': '3232bc056f63f9b091e8d7cbf51d2914ccf0fe16e8555d2761ed15c4b39a098e',
};

const SHORT_CUES = [
  { index: 1, startSec: 0.5, endSec: 2, text: '第一句 你好', id: null },
  { index: 2, startSec: 3, endSec: 4.2, text: 'second line', id: null },
];

/** S43 实测被裁的那类纯中文长句（25 字那条在 720p 一行放得下，这条才真的超过一行）。 */
const LONG_TEXT = '这是一句会换行的长字幕，用来量断点是不是同一条——所以它必须真的超过一行，才能看出两边的断点落在同一个字上。';

const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const layoutFor = (canvas) => (canvas.w === STAGE.w && canvas.h === STAGE.h
  ? null
  : { stage: STAGE, fit: 'letterbox' });

/** @param {string} ass */
function dialogueText(ass) {
  const line = ass.split('\n').find((row) => row.startsWith('Dialogue:'));
  assert.ok(line, 'ASS 里应该有 Dialogue 行');
  const marker = ',Default,,0,0,0,,';
  const at = line.indexOf(marker);
  assert.ok(at > 0, `Dialogue 行格式不对：${line}`);
  return line.slice(at + marker.length);
}

test('P39-A1：三画幅默认短句 ASS 与 R22 逐字节相同', () => {
  for (const canvas of CANVASES) {
    const layout = layoutFor(canvas);
    const ass = buildAssDocument({
      cues: SHORT_CUES,
      size: { w: canvas.w, h: canvas.h },
      ...(layout ? { layout } : {}),
    });
    assert.equal(sha(ass), DEFAULT_SHA[canvas.id], `${canvas.id} sha`);
    assert.equal(dialogueText(ass), '第一句 你好');
  }
});

test('P39-A2：纯中文长句在 720p 排成 2 行，写进 ASS 的是字面 \\N', () => {
  const ass = buildAssDocument({
    cues: [{ index: 1, startSec: 0, endSec: 2, text: LONG_TEXT, id: null }],
    size: { w: 1280, h: 720 },
  });
  const text = dialogueText(ass);
  const lines = text.split('\\N');
  assert.equal(lines.length, 2, `应该是 2 行，实际 ${lines.length}`);
  assert.equal(lines.join(''), LONG_TEXT, '拼回去必须等于原句（不吞字、不加字）');
  assert.ok(!text.includes('\\\\N'), '不能是转义过的 \\\\N（那会显示成字面反斜杠）');

  // 计划层：每行估算宽度 ≤ 容量
  const plan = planSubtitleLines({ text: LONG_TEXT, style: toAssStyle(undefined, { stage: STAGE }).style, stage: STAGE });
  assert.equal(plan.lines.length, 2);
  for (const [i, width] of plan.widthsEm.entries()) {
    assert.ok(width <= plan.capacityEm + 1e-9, `第 ${i + 1} 行 ${width}em 超过容量 ${plan.capacityEm}em`);
  }
  assert.deepEqual(lines, plan.lines);
});

test('P39-A2b：720p / 竖屏 / 4K 吃同一组行（断点由设计舞台决定，不随画布变）', () => {
  const texts = CANVASES.map((canvas) => {
    const layout = layoutFor(canvas);
    const ass = buildAssDocument({
      cues: [{ index: 1, startSec: 0, endSec: 2, text: LONG_TEXT, id: null }],
      size: { w: canvas.w, h: canvas.h },
      ...(layout ? { layout } : {}),
    });
    return dialogueText(ass);
  });
  assert.equal(new Set(texts).size, 1, '三画幅的 Dialogue 文本必须完全相同');
  assert.equal(texts[0].split('\\N').length, 2);
});

test('P39-A3：maxLines:1 截断以 … 结尾，可见前缀等于计划层的 lines[0]', () => {
  const cue = { index: 1, startSec: 0, endSec: 2, text: LONG_TEXT, id: null };
  const ass = buildAssDocument({
    cues: [cue],
    size: { w: 1280, h: 720 },
    subtitleStyle: { maxLines: 1 },
  });
  const text = dialogueText(ass);
  assert.ok(text.endsWith('…'), `应以省略号结尾：${text}`);
  assert.ok(!text.includes('\\N'), 'maxLines:1 不该有换行');

  const plan = planSubtitleLines({
    text: LONG_TEXT,
    style: toAssStyle({ maxLines: 1 }, { stage: STAGE }).style,
    stage: STAGE,
  });
  assert.equal(plan.truncated, true);
  assert.equal(text, plan.lines[0]);
  assert.equal(text.slice(0, -1), plan.lines[0].slice(0, -1));
  assert.equal(plan.lines.length, 1);
});

test('P39-A4：3 画幅 × 3 预设的行数与计划层表逐格相同', () => {
  const text = LONG_TEXT;
  /** @type {Array<{canvas: string, preset: string, ass: number, plan: number}>} */
  const rows = [];
  for (const canvas of CANVASES) {
    for (const presetId of listSubtitlePresets()) {
      const style = { ...SUBTITLE_PRESETS[presetId].style };
      const layout = layoutFor(canvas);
      const ass = buildAssDocument({
        cues: [{ index: 1, startSec: 0, endSec: 2, text, id: null }],
        size: { w: canvas.w, h: canvas.h },
        subtitleStyle: style,
        ...(layout ? { layout } : {}),
      });
      /* R30：双语预设会在第 2 行起加 `{\fs…}` 内联字号。比「行」的时候要把覆盖块剥掉，
         否则比的是「带标签的文本」和「纯文本」，永远不相等（不是断点变了）。 */
      const assLines = dialogueText(ass).split('\\N').map((line) => line.replace(/^\{\\[^}]*\}/, ''));
      const plan = planSubtitleLines({
        text,
        style: toAssStyle(style, { stage: STAGE, canvas: { w: canvas.w, h: canvas.h } }).style,
        stage: STAGE,
      });
      rows.push({ canvas: canvas.id, preset: presetId, ass: assLines.length, plan: plan.lines.length });
      assert.deepEqual(assLines, plan.lines, `${canvas.id}/${presetId}`);
      for (const width of plan.widthsEm) {
        assert.ok(width <= plan.capacityEm + 1e-9, `${canvas.id}/${presetId} 行宽 ${width}em > ${plan.capacityEm}em`);
      }
    }
  }
  // 断点只看设计舞台：9 格里同一预设的行数必须一致
  for (const presetId of listSubtitlePresets()) {
    const counts = new Set(rows.filter((row) => row.preset === presetId).map((row) => row.plan));
    assert.equal(counts.size, 1, `${presetId} 在不同画幅下行数不一致`);
  }
});

test('P39-A4b：预设 large（R30 前的 big-caption）字号更大 → 容量更小、行数不会更少', () => {
  const big = toAssStyle(SUBTITLE_PRESETS.large.style, { stage: STAGE }).style;
  const base = toAssStyle(undefined, { stage: STAGE }).style;
  const bigPlan = planSubtitleLines({ text: LONG_TEXT, style: big, stage: STAGE });
  const basePlan = planSubtitleLines({ text: LONG_TEXT, style: base, stage: STAGE });
  assert.ok(bigPlan.capacityEm < basePlan.capacityEm, '字号变大，一行能放的字更少');
  assert.ok(bigPlan.lines.length >= basePlan.lines.length);
});

test('P39：显式换行保留，且与自动断行用同一个 \\N', () => {
  const ass = buildAssDocument({
    cues: [{ index: 1, startSec: 0, endSec: 2, text: '第二行\n手动换行', id: null }],
    size: { w: 1280, h: 720 },
  });
  assert.equal(dialogueText(ass), '第二行\\N手动换行');
});

test('P39：行排只排显示层，不改 VTT 源文本（buildVttDocument 拿的是原文）', async () => {
  const { buildVttDocument } = await import('../subtitles.mjs');
  const vtt = buildVttDocument({
    cues: [{ startSec: 0, endSec: 1, text: LONG_TEXT }],
  });
  assert.ok(vtt.includes(LONG_TEXT), 'VTT 必须是全文，不能被 ASS 的截断污染');
  assert.ok(!vtt.includes('…'));
});

test('P39：planCueLines 与 buildAssDocument 用同一套参数（舞台 + 归一化样式）', () => {
  const style = { ...SUBTITLE_PRESETS.outline.style };
  const cues = [{ index: 1, startSec: 0, endSec: 2, text: LONG_TEXT, id: null }];
  const fields = toAssStyle(style, { stage: STAGE });
  const plans = planCueLines(cues, fields);
  assert.deepEqual(plans[0].lines, planSubtitleLines({ text: LONG_TEXT, style: fields.style, stage: STAGE }).lines);
  assert.deepEqual(plans[0].widthsEm.map((n) => Math.round(n * 1000) / 1000), planSubtitleLines({ text: LONG_TEXT, style: fields.style, stage: STAGE }).widthsEm);
});

test('P39：ASS 回读的行数与计划层一致（Dialogue 条数不因换行变化）', () => {
  const cues = [
    { index: 1, startSec: 0, endSec: 1, text: LONG_TEXT, id: null },
    { index: 2, startSec: 1, endSec: 2, text: '短句', id: null },
  ];
  const ass = buildAssDocument({ cues, size: { w: 1280, h: 720 } });
  const back = parseAssDocument(ass);
  assert.equal(back.cues.length, 2);
  assert.equal(back.cues[0].text.split('\\N').length, 2);
  assert.equal(back.cues[1].text, '短句');
});

test('P39：三画幅的字号/描边/边距仍按 P32 的三画幅表（行排不碰几何）', () => {
  for (const row of SUBTITLE_CANVAS_TABLE) {
    const ass = buildAssDocument({
      cues: [],
      size: { w: row.canvas.w, h: row.canvas.h },
      layout: { stage: STAGE, fit: 'letterbox' },
    });
    const back = parseAssDocument(ass);
    assert.equal(back.fontSize, row.fontSizePx, `${row.canvas.w}x${row.canvas.h} fontSize`);
  }
});
