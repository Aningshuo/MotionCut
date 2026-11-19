import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SUBTITLE_LAYOUT_VERSION,
  estimateAdvanceEm,
  lineCapacityEm,
  measureTextEm,
  planSubtitleLines,
  subtitleLineStepPx,
  toAssText,
} from '../subtitle-layout.mjs';

const STYLE = { fontSizeRatio: 0.045, lineHeight: 1.25, maxLines: 2 };
const STAGE = { w: 1280, h: 720 };
const LONG_CJK =
  '这是一句会换行的长字幕，用来量断点是不是同一条——所以它必须真的超过一行，才能看出两边的断点落在同一个字上。';

test('L1 版本与单位：CJK 1.02em、空格 0.2856em', () => {
  assert.equal(SUBTITLE_LAYOUT_VERSION, '1.0.0');
  assert.ok(Math.abs(estimateAdvanceEm('中') - 1) < 1e-9);
  assert.ok(Math.abs(measureTextEm('中') - 1.02) < 1e-9);
  assert.ok(Math.abs(measureTextEm(' ') - 0.2856) < 1e-9);
});

test('L2 短句不拆行', () => {
  const plan = planSubtitleLines({ text: '这是一句短字幕', style: STYLE, stage: STAGE });
  assert.deepEqual(plan.lines, ['这是一句短字幕']);
  assert.equal(plan.truncated, false);
});

test('L3 纯中文长句排成多行，每行不超容量', () => {
  const plan = planSubtitleLines({ text: LONG_CJK, style: STYLE, stage: STAGE });
  assert.ok(plan.lines.length >= 2, `lines=${plan.lines.length}`);
  for (const [i, line] of plan.lines.entries()) {
    assert.ok(line.length > 0, `line ${i} 为空`);
    assert.ok((plan.widthsEm[i] ?? Infinity) <= plan.capacityEm + 1e-9, `line ${i} 超宽 ${plan.widthsEm[i]} > ${plan.capacityEm}`);
  }
  assert.equal(plan.lines.join('').replace(/…$/, ''), LONG_CJK.replace(/\s/g, ''));
});

test('L4 显式换行保留', () => {
  const plan = planSubtitleLines({ text: '第一行\n第二行', style: STYLE, stage: STAGE });
  assert.deepEqual(plan.lines, ['第一行', '第二行']);
});

test('L5 拉丁在空格处断，不把单词劈开', () => {
  const text = 'This is a long subtitle line that should break at word boundaries instead of mid-word.';
  const plan = planSubtitleLines({ text, style: { ...STYLE, maxLines: 4 }, stage: STAGE });
  assert.ok(plan.lines.length >= 2);
  for (const line of plan.lines.slice(0, -1)) {
    assert.ok(!/\s$/u.test(line), `行尾有空格：${JSON.stringify(line)}`);
    /* 断点在空格处：这一行必须是原文的一个前缀，且后面紧跟空格 */
    assert.ok(text.startsWith(`${line} `), `可能劈开单词：${JSON.stringify(line)}`);
  }
});

test('L6 maxLines 截断加省略号，宽度仍不超', () => {
  const plan = planSubtitleLines({ text: LONG_CJK, style: { ...STYLE, maxLines: 1 }, stage: STAGE });
  assert.equal(plan.lines.length, 1);
  assert.equal(plan.truncated, true);
  const first = plan.lines[0] ?? '';
  assert.ok(first.endsWith('…'));
  assert.ok((plan.widthsEm[0] ?? Infinity) <= plan.capacityEm + 1e-9);
  assert.ok(LONG_CJK.startsWith(first.replace(/…$/, '')));
});

test('L7 同画幅比例的行排一致（720p / 4K / 竖屏 letterbox 内舞台）', () => {
  const a = planSubtitleLines({ text: LONG_CJK, style: STYLE, stage: { w: 1280, h: 720 } });
  const b = planSubtitleLines({ text: LONG_CJK, style: STYLE, stage: { w: 3840, h: 2160 } });
  const c = planSubtitleLines({ text: LONG_CJK, style: STYLE, stage: { w: 1080, h: 607.5 } });
  assert.deepEqual(a.lines, b.lines);
  assert.deepEqual(a.lines, c.lines);
});

test('L8 竖屏全画布更窄 → 行数更多', () => {
  const wide = planSubtitleLines({ text: LONG_CJK, style: { ...STYLE, maxLines: 10 }, stage: { w: 1280, h: 720 } });
  const tall = planSubtitleLines({ text: LONG_CJK, style: { ...STYLE, maxLines: 10 }, stage: { w: 1080, h: 1920 } });
  assert.ok(tall.lines.length > wide.lines.length, `wide=${wide.lines.length} tall=${tall.lines.length}`);
});

test('L9 行首不出现收尾标点、行尾不留下开引号', () => {
  const samples = [
    '这是一句刚好在标点前面被断开的字幕，看看句号会不会跑到下一行开头。',
    '他说「这句话很长很长很长很长很长很长很长很长很长很长」然后停住了。',
    '（括号里的内容也很长很长很长很长很长很长很长很长很长很长很长）结束。',
  ];
  for (const text of samples) {
    const plan = planSubtitleLines({ text, style: { ...STYLE, maxLines: 4 }, stage: STAGE });
    for (const line of plan.lines) {
      assert.ok(!/^[。，、；：！？）】」』》〉…]/u.test(line), `行首标点：${JSON.stringify(line)}`);
      assert.ok(!/[（【「『《〈([{]$/u.test(line), `行尾开括号：${JSON.stringify(line)}`);
    }
  }
});

test('L10 toAssText 用字面 \\N 连接，过滤空行', () => {
  assert.equal(toAssText(['第一行', '', '第二行']), '第一行\\N第二行');
  assert.equal(toAssText([]), '');
});

test('L11 空文本返回空行数组', () => {
  const plan = planSubtitleLines({ text: '   ', style: STYLE, stage: STAGE });
  assert.deepEqual(plan.lines, []);
  assert.equal(plan.truncated, false);
});

test('L12 容量与字号比例成反比', () => {
  const normal = lineCapacityEm(STAGE, { fontSizeRatio: 0.045 });
  const big = lineCapacityEm(STAGE, { fontSizeRatio: 0.09 });
  assert.ok(Math.abs(normal / big - 2) < 1e-9);
});

/* ── P67：可见宽（cover 下舞台横向被裁） ────────────────────────────────── */

test('P67-L13 不传 view 时容量与旧版逐位相同', () => {
  const a = lineCapacityEm(STAGE, { fontSizeRatio: 0.045 });
  const b = lineCapacityEm({ w: 1280, h: 720 }, { fontSizeRatio: 0.045 }, undefined);
  const c = lineCapacityEm({ w: 1280, h: 720 }, { fontSizeRatio: 0.045 }, {});
  assert.equal(a, b);
  assert.equal(a, c);
  /* 手算：(1280 × 0.92 × 0.98) / (720 × 0.045) */
  assert.ok(Math.abs(a - (1280 * 0.92 * 0.98) / (720 * 0.045)) < 1e-12);
});

test('P67-L14 visibleWidth 只许把容量变小：取 min(stage.w, visibleWidth)', () => {
  const full = lineCapacityEm(STAGE, { fontSizeRatio: 0.045 });
  const narrow = lineCapacityEm(STAGE, { fontSizeRatio: 0.045 }, { visibleWidth: 405 });
  assert.ok(narrow < full);
  assert.ok(Math.abs(narrow / full - 405 / 1280) < 1e-12);
  /* letterbox 的可见宽可能 ≥ 舞台宽：那时一个字都不多放 */
  assert.equal(lineCapacityEm(STAGE, { fontSizeRatio: 0.045 }, { visibleWidth: 1920 }), full);
  /* 非法值当作没传 */
  assert.equal(lineCapacityEm(STAGE, { fontSizeRatio: 0.045 }, { visibleWidth: 0 }), full);
  assert.equal(lineCapacityEm(STAGE, { fontSizeRatio: 0.045 }, { visibleWidth: Number.NaN }), full);
});

test('P67-L15 9:16 cover 的长句按可见宽折行：行更短、行数更多', () => {
  const style = { fontSizeRatio: 0.045, maxLines: 12 };
  const wide = planSubtitleLines({ text: LONG_CJK, style, stage: STAGE });
  const narrow = planSubtitleLines({ text: LONG_CJK, style, stage: STAGE, view: { visibleWidth: 405 } });
  assert.ok(narrow.lines.length > wide.lines.length, `wide=${wide.lines.length} narrow=${narrow.lines.length}`);
  assert.equal(narrow.visibleWidth, 405);
  assert.equal(wide.visibleWidth, 1280);
  for (const [i, line] of narrow.lines.entries()) {
    assert.ok((narrow.widthsEm[i] ?? Infinity) <= narrow.capacityEm + 1e-9, `line ${i} 超宽`);
  }
});

test('P67-L16 超 maxLines 时记 LAYOUT_TRUNCATED（不再只有 …）', () => {
  const plan = planSubtitleLines({ text: LONG_CJK, style: { ...STYLE, maxLines: 1 }, stage: STAGE });
  assert.equal(plan.truncated, true);
  const issue = plan.issues.find((row) => row.code === 'LAYOUT_TRUNCATED');
  assert.ok(issue, `应有 LAYOUT_TRUNCATED：${JSON.stringify(plan.issues)}`);
  assert.equal(issue.field, 'maxLines');
  assert.equal(issue.value, 1);
  /* 没截断时不许凭空多一条 */
  const ok = planSubtitleLines({ text: '短句', style: STYLE, stage: STAGE });
  assert.deepEqual(ok.issues, []);
});

test('P67-L17 visibleWidth 不影响显式换行与空文本', () => {
  const a = planSubtitleLines({ text: '第一行\n第二行', style: STYLE, stage: STAGE, view: { visibleWidth: 405 } });
  assert.deepEqual(a.lines, ['第一行', '第二行']);
  const empty = planSubtitleLines({ text: '  ', style: STYLE, stage: STAGE, view: { visibleWidth: 405 } });
  assert.deepEqual(empty.lines, []);
  assert.equal(empty.visibleWidth, 405);
});

/* ── P74：行距的整数像素（唯一取整点） ───────────────────────────────── */

test('L18 subtitleLineStepPx：默认行距下整数像素 = 字号（= ASS Fontsize）', () => {
  const step = subtitleLineStepPx({ style: { lineHeight: 1.25 }, fontSizePx: 86 });
  assert.equal(step.em, 1);
  assert.equal(step.isDefault, true);
  assert.equal(step.px, 86);
  assert.equal(step.roundedPx, 86);
});

test('L19 subtitleLineStepPx：非默认行距按 em 连续取值、整数只是它的四舍五入', () => {
  const tall = subtitleLineStepPx({ style: { lineHeight: 1.8 }, fontSizePx: 86 });
  assert.ok(Math.abs(Number(tall.px) - 123.84) < 1e-9);
  assert.equal(tall.roundedPx, 124);
  const tight = subtitleLineStepPx({ style: { lineHeight: 1.0 }, fontSizePx: 86 });
  assert.ok(Math.abs(Number(tight.px) - 68.8) < 1e-9);
  assert.equal(tight.roundedPx, 69);
});

test('L20 计划层把行距带出来：给字号就有整数，没给就只有 em', () => {
  const withFont = planSubtitleLines({ text: '第一行\n第二行', style: STYLE, stage: STAGE, view: { fontSizePx: 86 } });
  assert.equal(withFont.lineHeightPx, 86);
  assert.equal(withFont.lineStepEm, 1);
  const withoutFont = planSubtitleLines({ text: '第一行\n第二行', style: STYLE, stage: STAGE });
  assert.equal(withoutFont.lineHeightPx, null);
  assert.equal(withoutFont.lineStepEm, 1);
  /* 行排结果两组必须一致：加这一列不许改行数 */
  assert.deepEqual(withFont.lines, withoutFont.lines);
});
