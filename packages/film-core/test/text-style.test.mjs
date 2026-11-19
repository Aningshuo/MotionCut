// @ts-nocheck —— 以 node --test 的运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * 文本样式契约的四项（R15 · R30-073 · E05-P3 前置）
 *
 * 判据（派单 §3.3）：
 * 1. `parse → write → parse` 往返后新字段仍在（值逐位相同）；
 * 2. **无改动写盘逐字节相同**（`writeValue` 的 `hasText:false` 路径）；
 * 3. 两个白名单的键集合**逐字相等**（`film-doc.OVERRIDE_KEYS` vs `ops.OPS_OVERRIDE_KEYS`）。
 *
 * 外加：每键一个负向用例，命中自己的拒绝码（不串码）。
 *
 * 跑法：node --test packages/film-core/test/text-style.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { OVERRIDE_KEYS, parse, writeValue } from '../film-doc.mjs';
import { OPS_OVERRIDE_KEYS, applyOps } from '../ops.mjs';
import { TEXT_ALIGNS, TEXT_STYLE_KEYS, isCssColor, validateTextStyle } from '../text-style.mjs';

const FIXTURE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=1280, height=720">
<title>文本样式夹具</title>
</head>
<body>
<section id="pages">
  <iframe id="page-main" src="page.html#t=0,4" at="0" size="1280x720"></iframe>
</section>
</body>
</html>
`;

/** 一条覆盖的长相（返回整份 film.html）。 @param {any} entry */
function filmWith(entry) {
  return FIXTURE.replace('<iframe id="page-main"', `<iframe id="page-main" overrides='${JSON.stringify([entry])}'`);
}

const FULL = {
  at: '#title',
  stroke: { color: '#ffcc00', width: 2 },
  bg: { color: '#000000cc', padX: 12, padY: 6, radius: 4 },
  align: 'center',
  tracking: 1.5,
};

/** @param {string} text */
function parseOrThrow(text) {
  const result = parse(text);
  assert.equal(result.doc === null, false, `本该解析成功，却报：${JSON.stringify(result.diagnostics)}`);
  return result.doc;
}

/** @param {string} text */
function codesOf(text) {
  return parse(text).diagnostics.map((d) => d.code);
}

/* ── 一、白名单：两个集合逐字相等 ─────────────────────────────────────── */

test('B0 两份白名单的键集合逐字相等（加字段漏一处就会红）', () => {
  const a = [...OVERRIDE_KEYS].sort();
  const b = [...OPS_OVERRIDE_KEYS].sort();
  assert.deepEqual(a, b, `parse 白名单 ${a.join(',')} ≠ /ops 白名单 ${b.join(',')}`);

  /* 四个新键必须真的在里面（不是「两边都漏，于是相等」）。 */
  for (const key of TEXT_STYLE_KEYS) {
    assert.equal(OVERRIDE_KEYS.has(key), true, `OVERRIDE_KEYS 缺 ${key}`);
    assert.equal(OPS_OVERRIDE_KEYS.has(key), true, `OPS_OVERRIDE_KEYS 缺 ${key}`);
  }
  assert.deepEqual([...TEXT_STYLE_KEYS].sort(), ['align', 'bg', 'stroke', 'tracking']);
});

/* ── 二、往返 ─────────────────────────────────────────────────────────── */

test('B1 parse → write → parse：四个键逐位回来（含子字段）', () => {
  const source = filmWith(FULL);
  const doc = parseOrThrow(source);
  const entry = doc.tracks[0].clips[0].overrides[0];
  assert.deepEqual(entry.stroke, FULL.stroke);
  assert.deepEqual(entry.bg, FULL.bg);
  assert.equal(entry.align, 'center');
  assert.equal(entry.tracking, 1.5);

  /* ① 不动 doc → 写回就是原文（changed:false，字节相同）。 */
  const same = writeValue(source, doc, doc.sourceHash);
  assert.equal(same.ok, true, JSON.stringify(same));
  assert.equal(same.changed, false);
  assert.equal(same.text, source);

  /* ② 真的改一处（clip 的 at），强制走重写路径 → 新键必须原样带着。 */
  doc.tracks[0].clips[0].at = 2;
  const rewritten = writeValue(source, doc, doc.sourceHash);
  assert.equal(rewritten.ok, true, JSON.stringify(rewritten));
  assert.equal(rewritten.changed, true);
  assert.notEqual(rewritten.text, source, '改了 at 就该有新文本');

  const again = parseOrThrow(rewritten.text);
  const back = again.tracks[0].clips[0].overrides[0];
  assert.equal(again.tracks[0].clips[0].at, 2);
  assert.deepEqual(back.stroke, FULL.stroke);
  assert.deepEqual(back.bg, FULL.bg);
  assert.equal(back.align, 'center');
  assert.equal(back.tracking, 1.5);
});

test('B2 无改动写盘逐字节相同（新键不进写回路径的字节）', () => {
  /* 老文档（一个键都没有）：写回 = 原文，长度与哈希都不变。 */
  const plain = filmWith({ at: '#title', style: { opacity: '0.5' } });
  const doc = parseOrThrow(plain);
  const written = writeValue(plain, doc, doc.sourceHash);
  assert.equal(written.ok, true);
  assert.equal(written.changed, false, '无改动不该产出新文本');
  assert.equal(written.text, plain);
  assert.equal(written.bytes, Buffer.byteLength(plain, 'utf8'));

  /* 有改动时，写出来的属性里键顺序 = 解析时的顺序（新增键不重排）。 */
  const withAll = filmWith(FULL);
  const doc2 = parseOrThrow(withAll);
  doc2.tracks[0].clips[0].at = 1;
  const out2 = writeValue(withAll, doc2, doc2.sourceHash);
  const raw = out2.text.match(/overrides='([^']*)'/);
  assert.notEqual(raw, null);
  const parsed = JSON.parse(raw[1]);
  assert.deepEqual(Object.keys(parsed[0]), ['at', 'stroke', 'bg', 'align', 'tracking']);
});

/* ── 三、四个拒绝码各命中自己 ─────────────────────────────────────────── */

test('B3 ALIGN_INVALID：对齐只认四个值', () => {
  for (const bad of ['middle', 'LEFT', '', 3, null]) {
    const codes = codesOf(filmWith({ at: '#title', align: bad }));
    assert.ok(codes.includes('ALIGN_INVALID'), `align=${JSON.stringify(bad)} 应报 ALIGN_INVALID，实际 ${JSON.stringify(codes)}`);
    assert.equal(codes.includes('TRACKING_INVALID'), false, '不该串到别的码');
  }
  for (const good of TEXT_ALIGNS) {
    assert.equal(codesOf(filmWith({ at: '#title', align: good })).length, 0, `align=${good} 应该通过`);
  }
});

test('B4 TRACKING_INVALID：字距 −50…400，非数字/越界都拒', () => {
  for (const bad of [-51, 401, '2', null, Number.NaN, Number.POSITIVE_INFINITY]) {
    const codes = codesOf(filmWith({ at: '#title', tracking: bad }));
    assert.ok(codes.includes('TRACKING_INVALID'), `tracking=${String(bad)} 应报 TRACKING_INVALID，实际 ${JSON.stringify(codes)}`);
  }
  for (const good of [-50, 0, 1.5, 400]) {
    assert.equal(codesOf(filmWith({ at: '#title', tracking: good })).length, 0, `tracking=${good} 应该通过`);
  }
});

test('B5 STROKE_INVALID：颜色只收可判定的写法、宽度 0–64、不许未知子键', () => {
  const bads = [
    { color: 'red' },
    { color: '#ff' },
    { color: 'var(--x)' },
    { color: 'url(x)' },
    { color: '#fff;color:red' },
    { color: '#fff', width: -1 },
    { color: '#fff', width: 65 },
    { color: '#fff', width: '2' },
    { color: '#fff', shadow: 1 },
    'not-an-object',
  ];
  for (const bad of bads) {
    const codes = codesOf(filmWith({ at: '#title', stroke: bad }));
    assert.ok(codes.includes('STROKE_INVALID'), `stroke=${JSON.stringify(bad)} 应报 STROKE_INVALID，实际 ${JSON.stringify(codes)}`);
  }
  for (const good of ['#fff', '#ffff', '#ffcc00', '#ffcc00aa', 'rgb(255, 0, 0)', 'rgba(0,0,0,0.5)', 'hsl(200 50% 40%)']) {
    assert.equal(codesOf(filmWith({ at: '#title', stroke: { color: good } })).length, 0, `color=${good} 应该通过`);
  }
  /* 宽度缺省合法（应用时按 1px）。 */
  assert.equal(codesOf(filmWith({ at: '#title', stroke: { color: '#fff' } })).length, 0);
});

test('B6 BG_INVALID：颜色必填、padX/padY/radius 0–200、不许未知子键', () => {
  const bads = [
    { color: 'red' },
    { padX: 4 },
    { color: '#000', padX: -1 },
    { color: '#000', padY: 201 },
    { color: '#000', radius: 300 },
    { color: '#000', shadow: true },
    ['#000'],
  ];
  for (const bad of bads) {
    const codes = codesOf(filmWith({ at: '#title', bg: bad }));
    assert.ok(codes.includes('BG_INVALID'), `bg=${JSON.stringify(bad)} 应报 BG_INVALID，实际 ${JSON.stringify(codes)}`);
  }
  assert.equal(codesOf(filmWith({ at: '#title', bg: { color: '#000000cc' } })).length, 0);
});

/* ── 四、四键同时与 kf 共存；`/ops` 同规则 ─────────────────────────────── */

test('B7 四键与 kf 共存不冲突（文本样式不是关键帧属性）', () => {
  const entry = {
    at: '#title',
    stroke: { color: '#fff' },
    align: 'left',
    kf: [
      { t: 0, style: { opacity: '0' } },
      { t: 1, style: { opacity: '1' } },
    ],
  };
  const codes = codesOf(filmWith(entry));
  assert.deepEqual(codes, [], `不该报 KF_STATIC_CONFLICT 或别的：${JSON.stringify(codes)}`);
});

test('B8 /ops 与 parse 同一套取值规则（走 applyOps 的 set 路径）', () => {
  /* 非法值：/ops 必须拒（EditError INVALID，消息里带稳定码）。 */
  const doc = parseOrThrow(filmWith({ at: '#title' }));
  let threw = null;
  try {
    applyOps(doc, [{ op: 'set', clip: 'page-main', field: 'overrides', value: [{ at: '#title', align: 'middle' }] }]);
  } catch (error) {
    threw = error;
  }
  assert.notEqual(threw, null, '/ops 应该拒掉 align=middle');
  assert.equal(threw.code, 'INVALID');
  assert.match(threw.message, /ALIGN_INVALID/);

  /* 合法值：/ops 要收，并且写回后 parse 仍然认。 */
  const ok = applyOps(doc, [
    { op: 'set', clip: 'page-main', field: 'overrides', value: [{ at: '#title', tracking: 2, align: 'right' }] },
  ]);
  const entry = ok.tracks[0].clips[0].overrides[0];
  assert.equal(entry.align, 'right');
  assert.equal(entry.tracking, 2);
});

test('B9 validateTextStyle 对「没给这四键」零成本放行（不影响既有文档）', () => {
  assert.deepEqual(validateTextStyle({ at: '#x' }), { ok: true });
  assert.deepEqual(validateTextStyle({ at: '#x', style: { opacity: '0.5' }, s: [1, 1], r: 3 }), { ok: true });
  assert.equal(isCssColor('#abc'), true);
  assert.equal(isCssColor('red'), false);
});
