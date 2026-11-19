// @ts-nocheck —— 以 node --test 的运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * M77-WRITEVALUE-COMPOSE（B-MAIN-R30-038）：
 * `writeValue` 在「舞台变了」时不能再独占 return —— 同一批里的轨道改动必须一起写进去，
 * 回读必须逐字段核对，任何不一致都 `ok:false` + `field`，不许再「ok 但丢一半」。
 *
 * 跑法：node --test packages/film-core/test/writevalue-compose.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { analyze, parse, sha256, verifyValue, writeValue } from '../film-doc.mjs';
import { applyOps } from '../ops.mjs';

/** 两条轨道：网页片段 + 视频/声音（覆盖 x/y/w/h/text/嵌套元素几种改法）。 */
const FIXTURE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=1280, height=720">
<title>M77 夹具</title>
</head>
<body>
<section id="pages">
  <iframe id="page-main" src="page.html#t=0,12" at="0" size="1280x720" style="left: 0px; top: 0px; width: 1280px; height: 720px; border: 0"></iframe>
</section>
<section id="media" muted>
  <video id="take-01" src="assets/take-01.mp4#t=0,5" at="0" volume="0.9"></video>
  <audio id="bgm" src="assets/bgm.mp3#t=0,5" at="0"></audio>
</section>
</body>
</html>
`;

const HASH = sha256(FIXTURE);

/** @returns {any} */
function docOf() {
  const parsed = parse(FIXTURE);
  assert.equal(parsed.doc === null, false, JSON.stringify(parsed.diagnostics));
  return /** @type {any} */ (structuredClone(parsed.doc));
}

/** @param {any} doc @param {string} id */
function clipOf(doc, id) {
  for (const track of doc.tracks) {
    const clip = track.clips.find((/** @type {any} */ item) => item.id === id);
    if (clip !== undefined) return clip;
  }
  return null;
}

/** @param {any} result */
const fieldsOf = (result) => (result.diagnostics ?? []).map((/** @type {any} */ diag) => diag.field).filter(Boolean);

/* ── 1. 舞台 + 轨道同批：x / y / w/h / text / 嵌套元素 各一条 ───────────── */

test('W1 舞台改 720×1280 + 片段 x=777：两项都必须写进去', () => {
  const doc = docOf();
  doc.stage = { w: 720, h: 1280 };
  doc.tracks[0].clips[0].x = 777; // 任务书 repro 的原样写法（x 是 box.x 的简写）
  const result = writeValue(FIXTURE, doc, HASH);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics ?? []));
  assert.equal(result.changed, true);
  const text = String(result.text);
  assert.match(text, /width=720, height=1280/);
  assert.match(text, /left: 777px/);
  const back = parse(text);
  assert.deepEqual(back.doc?.stage, { w: 720, h: 1280 });
  assert.equal(clipOf(back.doc, 'page-main').box.x, 777);
});

test('W2 舞台 + 片段 y=64：两项都写进去', () => {
  const doc = docOf();
  doc.stage = { w: 1080, h: 1920 };
  doc.tracks[1].clips[0].y = 64;
  const result = writeValue(FIXTURE, doc, HASH);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics ?? []));
  const back = parse(String(result.text));
  assert.deepEqual(back.doc?.stage, { w: 1080, h: 1920 });
  assert.equal(clipOf(back.doc, 'take-01').box.y, 64);
});

test('W3 舞台 + 片段宽高（w/h）同批：两项都写进去', () => {
  const doc = docOf();
  doc.stage = { w: 640, h: 360 };
  doc.tracks[0].clips[0].w = 320;
  doc.tracks[0].clips[0].h = 180;
  const result = writeValue(FIXTURE, doc, HASH);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics ?? []));
  const back = parse(String(result.text));
  assert.deepEqual(back.doc?.stage, { w: 640, h: 360 });
  assert.deepEqual(
    { w: clipOf(back.doc, 'page-main').box.w, h: clipOf(back.doc, 'page-main').box.h },
    { w: 320, h: 180 },
  );
});

test('W4 舞台 + 片段 at 同批：两项都写进去', () => {
  const doc = docOf();
  doc.stage = { w: 1440, h: 1080 };
  clipOf(doc, 'take-01').at = 2.5;
  const result = writeValue(FIXTURE, doc, HASH);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics ?? []));
  const back = parse(String(result.text));
  assert.deepEqual(back.doc?.stage, { w: 1440, h: 1080 });
  assert.equal(clipOf(back.doc, 'take-01').at, 2.5);
});

test('W5 舞台 + 层覆盖 text（overrides）同批：两项都写进去', () => {
  const doc = docOf();
  doc.stage = { w: 1080, h: 1080 };
  clipOf(doc, 'page-main').overrides = [{ at: '#headline', t: '改过的标题' }];
  const result = writeValue(FIXTURE, doc, HASH);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics ?? []));
  const back = parse(String(result.text));
  assert.deepEqual(back.doc?.stage, { w: 1080, h: 1080 });
  assert.deepEqual(clipOf(back.doc, 'page-main').overrides, [{ at: '#headline', t: '改过的标题' }]);
});

test('W6 舞台 + 「嵌套更深」的第二条轨道片段同批：两项都写进去', () => {
  const doc = docOf();
  doc.stage = { w: 960, h: 540 };
  clipOf(doc, 'bgm').volume = 0.4;
  const result = writeValue(FIXTURE, doc, HASH);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics ?? []));
  const back = parse(String(result.text));
  assert.deepEqual(back.doc?.stage, { w: 960, h: 540 });
  assert.equal(clipOf(back.doc, 'bgm').volume, 0.4);
  assert.equal(back.doc?.tracks.length, 2);
});

/* ── 2. 顺序无关 ───────────────────────────────────────────────────────── */

test('W7 先舞台后轨道 / 先轨道后舞台：两种顺序结果逐字节相同', () => {
  /** 最终目标值：舞台 720×1280 + 片段 x=777。 */
  const target = docOf();
  target.stage = { w: 720, h: 1280 };
  target.tracks[0].clips[0].box = { ...target.tracks[0].clips[0].box, x: 777 };

  /** 第一步只改舞台。 */
  const stageOnly = docOf();
  stageOnly.stage = { w: 720, h: 1280 };
  /** 第一步只改轨道。 */
  const tracksOnly = docOf();
  tracksOnly.tracks[0].clips[0].box = { ...tracksOnly.tracks[0].clips[0].box, x: 777 };

  const stageFirst = writeValue(FIXTURE, stageOnly, HASH);
  assert.equal(stageFirst.ok, true, JSON.stringify(stageFirst.diagnostics ?? []));
  const stageThenTracks = writeValue(String(stageFirst.text), target, sha256(String(stageFirst.text)));
  assert.equal(stageThenTracks.ok, true, JSON.stringify(stageThenTracks.diagnostics ?? []));

  const tracksFirst = writeValue(FIXTURE, tracksOnly, HASH);
  assert.equal(tracksFirst.ok, true, JSON.stringify(tracksFirst.diagnostics ?? []));
  const tracksThenStage = writeValue(String(tracksFirst.text), target, sha256(String(tracksFirst.text)));
  assert.equal(tracksThenStage.ok, true, JSON.stringify(tracksThenStage.diagnostics ?? []));

  assert.equal(String(stageThenTracks.text), String(tracksThenStage.text));
  assert.equal(String(stageThenTracks.sourceHash), String(tracksThenStage.sourceHash));
  // 一次到位的组合写回也必须落到同一份文本（三条路径同一终点）。
  const oneShot = writeValue(FIXTURE, target, HASH);
  assert.equal(oneShot.ok, true, JSON.stringify(oneShot.diagnostics ?? []));
  assert.equal(String(oneShot.text), String(stageThenTracks.text));
});

/* ── 3. 只改一侧 ───────────────────────────────────────────────────────── */

test('W8 只改舞台：viewport 那一行变，其余字节不变', () => {
  const doc = docOf();
  doc.stage = { w: 720, h: 1280 };
  const result = writeValue(FIXTURE, doc, HASH);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics ?? []));
  const lines = String(result.text).split('\n');
  const before = FIXTURE.split('\n');
  assert.equal(lines.length, before.length);
  const changedLines = lines.filter((line, index) => line !== before[index]);
  assert.deepEqual(changedLines, ['<meta name="viewport" content="width=720, height=1280">']);
});

test('W9 只改轨道：viewport 行一字不动，且只动那一个属性', () => {
  const doc = docOf();
  doc.tracks[0].clips[0].box = { ...doc.tracks[0].clips[0].box, x: 777 };
  const result = writeValue(FIXTURE, doc, HASH);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics ?? []));
  const text = String(result.text);
  assert.match(text, /<meta name="viewport" content="width=1280, height=720">/);
  assert.match(text, /style="left: 777px; top: 0px; width: 1280px; height: 720px; border: 0"/);
  assert.equal(text.replace('left: 777px', 'left: 0px'), FIXTURE);
});

/* ── 4. 无效舞台：INVALID + 指字段 + 文本不动 ──────────────────────────── */

test('W10 无效舞台（0/负/超 8192/非整数/缺 h）→ INVALID 指字段，且不产出文本', () => {
  const cases = [
    { stage: { w: 0, h: 720 }, field: 'stage.w' },
    { stage: { w: -2, h: 720 }, field: 'stage.w' },
    { stage: { w: 1280, h: 9000 }, field: 'stage.h' },
    { stage: { w: 1280.5, h: 720 }, field: 'stage.w' },
    { stage: { w: 1280 }, field: 'stage.h' },
  ];
  for (const item of cases) {
    const doc = docOf();
    doc.stage = item.stage;
    const result = writeValue(FIXTURE, doc, HASH);
    assert.equal(result.ok, false, `应拒绝：${JSON.stringify(item.stage)}`);
    assert.equal(result.code, 'INVALID');
    assert.equal(result.text, undefined, '拒绝时不能给出半份文本');
    assert.ok(fieldsOf(result).includes(item.field), `${JSON.stringify(item.stage)} → ${JSON.stringify(fieldsOf(result))}`);
  }
});

test('W10b 无效舞台 + 合法轨道改动：整批拒绝（不写舞台、也不写轨道）', () => {
  const doc = docOf();
  doc.stage = { w: 0, h: 0 };
  doc.tracks[0].clips[0].x = 777;
  const result = writeValue(FIXTURE, doc, HASH);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID');
  assert.equal(result.text, undefined);
  // 原文一个字节都没动：把结果交给调用方也没东西可写
  assert.equal(FIXTURE.includes('left: 777px'), false);
});

/* ── 5. 舞台 + 增删片段 ────────────────────────────────────────────────── */

test('W11 舞台 + 新增片段同批：舞台、原片段、新片段都在', () => {
  const doc = applyOps(docOf(), [{ op: 'insert', clip: { src: 'assets/take-b.mp4', time: [0, 2] }, at: 6, track: 1 }]);
  doc.stage = { w: 720, h: 1280 };
  const result = writeValue(FIXTURE, doc, HASH);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics ?? []));
  const back = parse(String(result.text));
  assert.deepEqual(back.doc?.stage, { w: 720, h: 1280 });
  assert.equal(back.doc?.tracks[1].clips.length, 3);
  assert.ok(clipOf(back.doc, 'take-b') !== null);
});

test('W12 舞台 + 删除片段同批：舞台生效、被删片段消失', () => {
  const doc = applyOps(docOf(), [{ op: 'remove', clip: 'take-01' }]);
  doc.stage = { w: 720, h: 1280 };
  const result = writeValue(FIXTURE, doc, HASH);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics ?? []));
  const text = String(result.text);
  assert.match(text, /width=720, height=1280/);
  assert.equal(text.includes('id="take-01"'), false);
  assert.equal(clipOf(parse(text).doc, 'bgm') !== null, true);
});

/* ── 6. 回读校验：注入篡改必须被拒 ─────────────────────────────────────── */

test('W13 回读校验失败注入：组合结果被篡改 → INVALID 并指到片段字段', () => {
  const doc = docOf();
  doc.stage = { w: 720, h: 1280 };
  doc.tracks[0].clips[0].x = 777;
  const result = writeValue(FIXTURE, doc, HASH, {
    rewrite: (text) => text.replace('left: 777px', 'left: 778px'),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID');
  assert.ok(fieldsOf(result).some((field) => field.startsWith('tracks[0].clips[0].box')), JSON.stringify(result.diagnostics));
});

test('W13b verifyValue：同一份目标值喂回被篡改的文本 → 指字段；喂回正确文本 → ok', () => {
  const doc = docOf();
  doc.stage = { w: 720, h: 1280 };
  doc.tracks[1].clips[0].at = 3;
  const good = writeValue(FIXTURE, doc, HASH);
  assert.equal(good.ok, true, JSON.stringify(good.diagnostics ?? []));

  const verified = verifyValue(String(good.text), doc);
  assert.equal(verified.ok, true, JSON.stringify(verified.diagnostics ?? []));

  const tampered = String(good.text).replace('at="3"', 'at="4"');
  assert.notEqual(tampered, String(good.text));
  const rejected = verifyValue(tampered, doc);
  assert.equal(rejected.ok, false);
  assert.ok(fieldsOf(rejected).some((field) => field === 'tracks[1].clips[0].at'), JSON.stringify(rejected.diagnostics));

  const stageTampered = String(good.text).replace('width=720', 'width=724');
  const stageRejected = verifyValue(stageTampered, doc);
  assert.equal(stageRejected.ok, false);
  assert.ok(fieldsOf(stageRejected).includes('stage.w'), JSON.stringify(stageRejected.diagnostics));
});

/* ── 7. 未知字段不再静默通过 ───────────────────────────────────────────── */

test('W14 片段上的未知字段 → INVALID 指字段（以前会被静默丢掉）', () => {
  const doc = docOf();
  doc.stage = { w: 720, h: 1280 };
  doc.tracks[0].clips[0].opacity = 0.5;
  const result = writeValue(FIXTURE, doc, HASH);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID');
  assert.ok(fieldsOf(result).includes('tracks[0].clips[0].opacity'), JSON.stringify(result.diagnostics));
});

test('W14b 轨道 / 文档 / box 上的未知字段同样指字段', () => {
  const trackDoc = docOf();
  trackDoc.tracks[0].colour = 'red';
  const trackResult = writeValue(FIXTURE, trackDoc, HASH);
  assert.equal(trackResult.ok, false);
  assert.ok(fieldsOf(trackResult).includes('tracks[0].colour'), JSON.stringify(trackResult.diagnostics));

  const docLevel = docOf();
  docLevel.title = 'x';
  const docResult = writeValue(FIXTURE, docLevel, HASH);
  assert.equal(docResult.ok, false);
  assert.ok(fieldsOf(docResult).includes('title'), JSON.stringify(docResult.diagnostics));

  const boxDoc = docOf();
  boxDoc.tracks[0].clips[0].box = { x: 0, y: 0, w: 1280, h: 720, z: 2 };
  const boxResult = writeValue(FIXTURE, boxDoc, HASH);
  assert.equal(boxResult.ok, false);
  assert.ok(fieldsOf(boxResult).includes('tracks[0].clips[0].box.z'), JSON.stringify(boxResult.diagnostics));
});

/* ── 8. 乐观锁与幂等 ───────────────────────────────────────────────────── */

test('W15 拿到新 hash 却还拿旧文本写：CONFLICT（乐观锁没被组合写回绕开）', () => {
  const doc = docOf();
  doc.stage = { w: 720, h: 1280 };
  doc.tracks[0].clips[0].x = 777;
  const first = writeValue(FIXTURE, doc, HASH);
  assert.equal(first.ok, true, JSON.stringify(first.diagnostics ?? []));

  // 第二个写者读到的还是旧文本，却拿第一次写后的 sha 当 expectedHash：必须 409/CONFLICT。
  const stale = writeValue(FIXTURE, doc, String(first.sourceHash));
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'CONFLICT');
  assert.equal(stale.sourceHash, HASH);

  // 重放同一份目标值（文本已经是新的）：changed=false，不再写第二遍。
  const replayed = writeValue(String(first.text), doc, String(first.sourceHash));
  assert.equal(replayed.ok, true, JSON.stringify(replayed.diagnostics ?? []));
  assert.equal(replayed.changed, false);
});

test('W16 目标值与当前一致 → changed=false，文本逐字节不变', () => {
  const result = writeValue(FIXTURE, docOf(), HASH);
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.text, FIXTURE);
});

test('W17 内联夹具本身 0 错误诊断（防止夹具自己先坏了）', () => {
  const parsed = analyze(FIXTURE, {});
  assert.equal(parsed.doc === null, false, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(parsed.doc?.stage, { w: 1280, h: 720 });
});
