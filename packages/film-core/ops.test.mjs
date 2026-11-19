/**
 * M5-WP07 验收 A1–A5：Op 引擎（纯函数）+ 值→film.html 的局部写回。
 * 跑法：node --test packages/film-core/ops.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse, sha256 } from './film-doc.mjs';
import { EditError, applyOps, applyOpsDetailed, invertOps } from './ops.mjs';
import { writeValue } from './ops-write.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const fixtureText = readFileSync(join(repo, 'tests', 'fixtures', 'main', 'film-basic.html'), 'utf8');
const fixtureHash = sha256(fixtureText);

/** @returns {any} */
function fixtureDoc() {
  const parsed = parse(fixtureText, { path: 'film-basic.html' });
  assert.equal(parsed.doc === null, false, JSON.stringify(parsed.diagnostics));
  return parsed.doc;
}

/** @param {any} doc @returns {string[]} */
const idsOf = (doc) => doc.tracks.flatMap((/** @type {any} */ track) => track.clips.map((/** @type {any} */ clip) => clip.id));

/** @param {any} doc @param {string} id */
const clipOf = (doc, id) => {
  for (const track of doc.tracks) {
    const clip = track.clips.find((/** @type {any} */ item) => item.id === id);
    if (clip !== undefined) return clip;
  }
  return null;
};

test('A1 11 类 Op 各一组正例，且同输入两次结果一致', () => {
  /** @type {{ name: string, ops: any[], check: (doc: any) => void }[]} */
  const cases = [
    {
      name: 'set',
      ops: [{ op: 'set', clip: 'c1', field: 'volume', value: 0.4 }],
      check: (doc) => assert.equal(clipOf(doc, 'c1').volume, 0.4),
    },
    {
      name: 'move',
      ops: [{ op: 'move', clip: 'c2', at: 5.5 }],
      check: (doc) => assert.equal(clipOf(doc, 'c2').at, 5.5),
    },
    {
      name: 'insert',
      ops: [{ op: 'insert', clip: { src: 'assets/take-c.mp4', at: 8, time: [0, 2] }, track: 0 }],
      check: (doc) => assert.ok(idsOf(doc).includes('take-c'), idsOf(doc).join(',')),
    },
    {
      name: 'remove',
      ops: [{ op: 'remove', clip: 'c2' }],
      check: (doc) => assert.equal(idsOf(doc).includes('c2'), false),
    },
    {
      name: 'split',
      ops: [{ op: 'split', clip: 'c1', at: 2, left: { end: 2 }, right: { start: 2, at: 2 } }],
      check: (doc) => {
        assert.deepEqual(clipOf(doc, 'c1').time, [0, 2]);
        assert.deepEqual(clipOf(doc, 'c1-b').time, [2, 4]);
      },
    },
    {
      name: 'props',
      ops: [{ op: 'props', edits: [{ clip: 'c2', prop: 'volume', value: 0.25 }] }],
      check: (doc) => assert.equal(clipOf(doc, 'c2').volume, 0.25),
    },
    {
      name: 'stage',
      ops: [{ op: 'stage', w: 1920, h: 1080 }],
      check: (doc) => assert.deepEqual(doc.stage, { w: 1920, h: 1080 }),
    },
    {
      name: 'fields',
      ops: [{ op: 'fields', clip: 'c1', fields: { speed: 2, at: 1 } }],
      check: (doc) => {
        assert.equal(clipOf(doc, 'c1').speed, 2);
        assert.equal(clipOf(doc, 'c1').at, 1);
      },
    },
    {
      name: 'track',
      ops: [{ op: 'track', track: 1, field: 'muted', value: true }],
      check: (doc) => assert.equal(doc.tracks[1].muted, true),
    },
    {
      name: 'reorder',
      ops: [{ op: 'reorder', from: 0, to: 1 }],
      check: (doc) => assert.equal(doc.tracks[1].clips[0].id, 'c1'),
    },
    {
      name: 'overrides',
      ops: [{ op: 'overrides', clip: 'c1', entries: [{ at: 'div#card > h1', t: '改过的标题' }] }],
      check: (doc) => assert.equal(clipOf(doc, 'c1').overrides[0].t, '改过的标题'),
    },
  ];
  assert.equal(cases.length, 11);

  for (const item of cases) {
    const before = fixtureDoc();
    const once = applyOps(before, item.ops);
    const twice = applyOps(before, item.ops);
    assert.deepEqual(once, twice, `${item.name} 两次结果不一致`);
    item.check(once);
    // 入参不被修改
    assert.deepEqual(before, fixtureDoc(), `${item.name} 改了入参`);
  }
});

test('A1b 同一批 Op 写回两次：字节一致（insert 的 id 也可复现）', () => {
  const ops = [
    { op: 'insert', clip: { src: 'assets/take-c.mp4', time: [0, 2] }, at: 8, track: 0 },
    { op: 'props', edits: [{ clip: 'c1', prop: 'fade', value: [0.5, 0.5] }] },
    { op: 'split', clip: 'c2', at: 5, left: { end: 1 }, right: { start: 1, at: 5 } },
  ];
  const first = /** @type {any} */ (writeValue(fixtureText, applyOps(fixtureDoc(), ops), fixtureHash));
  const second = /** @type {any} */ (writeValue(fixtureText, applyOps(fixtureDoc(), ops), fixtureHash));
  assert.equal(first.ok, true, `${first.code}: ${JSON.stringify(first.diagnostics ?? [])}`);
  assert.equal(second.ok, true);
  assert.equal(first.text, second.text);
  assert.equal(first.sourceHash, second.sourceHash);
  assert.match(first.text, /id="c2-b"/);
});

test('A2 set 非法字段被拒（INVALID），文档未被修改', () => {
  const doc = fixtureDoc();
  const snapshot = JSON.stringify(doc);
  for (const field of ['src-x', 'id', 'link', 'fade', 'props', 'track']) {
    assert.throws(
      () => applyOps(doc, [{ op: 'set', clip: 'c1', field, value: 'x' }]),
      (/** @type {any} */ error) => error instanceof EditError && error.code === 'INVALID',
      `set ${field} 应被拒`,
    );
    assert.equal(JSON.stringify(doc), snapshot, `set ${field} 改了文档`);
  }
  // 合同里的白名单仍然可用
  assert.doesNotThrow(() => applyOps(doc, [{ op: 'set', clip: 'c1', field: 'at', value: 1 }]));
});

test('A2b 未知 Op / 未知片段 / 锁轨分别给出稳定错误码', () => {
  const doc = fixtureDoc();
  assert.throws(() => applyOps(doc, [{ op: 'nope' }]), (/** @type {any} */ error) => error.code === 'INVALID');
  assert.throws(() => applyOps(doc, [{ op: 'remove', clip: 'ghost' }]), (/** @type {any} */ error) => error.code === 'NOT_FOUND');
  const locked = applyOps(doc, [{ op: 'track', track: 0, field: 'locked', value: true }]);
  assert.throws(() => applyOps(locked, [{ op: 'props', edits: [{ clip: 'c1', prop: 'volume', value: 0.1 }] }]), (/** @type {any} */ error) => error.code === 'LOCKED');
  // 锁上仍然能解锁
  assert.equal(applyOps(locked, [{ op: 'track', track: 0, field: 'locked', value: false }]).tracks[0].locked, undefined);
});

test('A3 归一化：start/end→time、gainDb→volume、fade→fade、link→data-link、props→data-props', () => {
  const doc = fixtureDoc();

  const trimmed = applyOps(doc, [{ op: 'props', edits: [{ clip: 'c1', prop: 'end', value: 3 }] }]);
  assert.deepEqual(clipOf(trimmed, 'c1').time, [0, 3]);

  const movedStart = applyOps(doc, [{ op: 'props', edits: [{ clip: 'c1', prop: 'start', value: 1 }] }]);
  assert.deepEqual(clipOf(movedStart, 'c1').time, [1, 4]);

  // -6dB ≈ 0.501
  const gained = applyOps(doc, [{ op: 'props', edits: [{ clip: 'c1', prop: 'gainDb', value: -6 }] }]);
  assert.equal(clipOf(gained, 'c1').volume, 0.501);
  assert.equal(applyOps(doc, [{ op: 'props', edits: [{ clip: 'c1', prop: 'gainDb', value: 0 }] }]).tracks[0].clips[0].volume, undefined);

  const faded = applyOps(doc, [{ op: 'props', edits: [{ clip: 'c1', prop: 'fade', value: [0.4, 0.6] }] }]);
  assert.deepEqual(clipOf(faded, 'c1').fade, [0.4, 0.6]);

  const linked = applyOps(doc, [{ op: 'props', edits: [{ clip: 'c1', prop: 'link', value: 'g1' }] }]);
  assert.equal(clipOf(linked, 'c1').link, 'g1');
  const unlinked = applyOps(linked, [{ op: 'props', edits: [{ clip: 'c1', prop: 'link', value: null }] }]);
  assert.equal(clipOf(unlinked, 'c1').link, undefined);

  const withProps = applyOps(doc, [{ op: 'props', edits: [{ clip: 'c1', prop: 'props', value: '{"theme":"dark"}' }] }]);
  assert.equal(clipOf(withProps, 'c1').attrs['data-props'], '{"theme":"dark"}');

  // 归一化后的值必须能写回并读回来
  const value = applyOps(doc, [
    { op: 'props', edits: [
      { clip: 'c1', prop: 'start', value: 1 },
      { clip: 'c1', prop: 'fade', value: [0.3, 0.2] },
      { clip: 'c1', prop: 'link', value: 'g1' },
      { clip: 'c2', prop: 'gainDb', value: -6 },
    ] },
  ]);
  const written = /** @type {any} */ (writeValue(fixtureText, value, fixtureHash));
  assert.equal(written.ok, true, `${written.code}: ${JSON.stringify(written.diagnostics ?? [])}`);
  const reparsed = parse(/** @type {any} */ (written.text)).doc;
  assert.equal(reparsed === null, false);
  assert.deepEqual(clipOf(reparsed, 'c1').time, [1, 4]);
  assert.deepEqual(clipOf(reparsed, 'c1').fade, [0.3, 0.2]);
  assert.equal(clipOf(reparsed, 'c1').link, 'g1');
  assert.equal(clipOf(reparsed, 'c2').volume, 0.501);
});

test('A4 split：淡入留左、淡出留右；rightId 冲突回退 -b，再冲突 -b-2', () => {
  const doc = applyOps(fixtureDoc(), [{ op: 'props', edits: [{ clip: 'c1', prop: 'fade', value: [0.5, 0.4] }] }]);
  const split = applyOps(doc, [{ op: 'split', clip: 'c1', at: 2, left: { end: 2 }, right: { start: 2, at: 2 } }]);
  assert.deepEqual(clipOf(split, 'c1').fade, [0.5, 0]);
  assert.deepEqual(clipOf(split, 'c1-b').fade, [0, 0.4]);

  // 指定 rightId：空闲时用它
  const named = applyOps(fixtureDoc(), [
    { op: 'split', clip: 'c1', at: 2, left: { end: 2 }, right: { start: 2, at: 2 }, rightId: 'c1-right' },
  ]);
  assert.ok(idsOf(named).includes('c1-right'));

  // 冲突时回退 <id>-b
  const conflict = applyOps(fixtureDoc(), [
    { op: 'split', clip: 'c1', at: 2, left: { end: 2 }, right: { start: 2, at: 2 }, rightId: 'c2' },
  ]);
  assert.ok(idsOf(conflict).includes('c1-b'));
  assert.equal(idsOf(conflict).includes('c2-b'), false);

  // -b 也被占：-b-2（先切出 c1-b，再切一次 c1）
  const twice = applyOps(fixtureDoc(), [
    { op: 'split', clip: 'c1', at: 1, left: { end: 1 }, right: { start: 1, at: 1 } },
    { op: 'split', clip: 'c1', at: 0.5, left: { end: 0.5 }, right: { start: 0.5, at: 0.5 } },
  ]);
  assert.ok(idsOf(twice).includes('c1-b'));
  assert.ok(idsOf(twice).includes('c1-b-2'), idsOf(twice).join(','));
});

test('A5 同一批 props：先字段后换轨，两条片段互换轨道不互相踩', () => {
  const doc = fixtureDoc();
  const swapped = applyOps(doc, [
    {
      op: 'props',
      edits: [
        { clip: 'c1', prop: 'track', value: 1 },
        { clip: 'a1', prop: 'track', value: 0 },
        { clip: 'c1', prop: 'at', value: 2 },
        { clip: 'a1', prop: 'volume', value: 0.5 },
      ],
    },
  ]);
  const trackOf = (/** @type {any} */ value, /** @type {string} */ id) =>
    value.tracks.findIndex((/** @type {any} */ track) => track.clips.some((/** @type {any} */ clip) => clip.id === id));
  assert.equal(trackOf(swapped, 'c1'), 1);
  assert.equal(trackOf(swapped, 'a1'), 0);
  assert.equal(clipOf(swapped, 'c1').at, 2);
  assert.equal(clipOf(swapped, 'a1').volume, 0.5);
  // 轨道顺序没有凭空改变，空轨被清掉
  assert.equal(swapped.tracks.length, 3);
});

test('A5b 反向 Op 能把值撤销回起点（10 步）', () => {
  /** @type {any[]} */
  const steps = [
    [{ op: 'props', edits: [{ clip: 'c1', prop: 'volume', value: 0.3 }] }],
    [{ op: 'props', edits: [{ clip: 'c2', prop: 'at', value: 6 }] }],
    [{ op: 'insert', clip: { src: 'assets/take-c.mp4', time: [0, 2] }, at: 9, track: 0 }],
    [{ op: 'split', clip: 'c1', at: 2, left: { end: 2 }, right: { start: 2, at: 2 } }],
    [{ op: 'props', edits: [{ clip: 'a1', prop: 'fade', value: [0.5, 0.5] }] }],
    [{ op: 'track', track: 2, field: 'hidden', value: true }],
    [{ op: 'props', edits: [{ clip: 'c2', prop: 'track', value: 1 }] }],
    [{ op: 'overrides', clip: 'c2', entries: [{ at: 'div#x', t: '改' }] }],
    [{ op: 'props', edits: [{ clip: 'a1', prop: 'link', value: 'g9' }] }],
    [{ op: 'stage', w: 1920, h: 1080 }],
  ];

  const start = fixtureDoc();
  delete start.sourceHash;
  let value = start;
  const history = [];
  for (const ops of steps) {
    history.push({ before: value, ops, inverse: invertOps(value, ops) });
    value = applyOps(value, ops);
  }
  assert.equal(history.length, 10);

  // 逆序应用反向 Op，逐步回到上一步
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = /** @type {any} */ (history[index]);
    value = applyOps(value, entry.inverse);
    assert.deepEqual(value, entry.before, `第 ${index + 1} 步反向 Op 没有回到上一步`);
  }
});

test('写回保真：未改动的行逐字节不变，只替换被改的属性', () => {
  const doc = fixtureDoc();
  const value = applyOps(doc, [{ op: 'props', edits: [{ clip: 'c2', prop: 'volume', value: 0.5 }] }]);
  const written = /** @type {any} */ (writeValue(fixtureText, value, fixtureHash));
  assert.equal(written.ok, true);
  const before = fixtureText.split('\n');
  const after = /** @type {string} */ (written.text).split('\n');
  assert.equal(before.length, after.length, '行数不该变');
  const changedLines = before.map((line, index) => (line === after[index] ? null : index)).filter((index) => index !== null);
  assert.equal(changedLines.length, 1, `只应有 1 行变化，实际：${changedLines.join(',')}`);
  assert.match(String(after[/** @type {number} */ (changedLines[0])]), /volume="0.5"/);

  // 值没变 = 不写（c2 本来就是 0.9）
  const noop = /** @type {any} */ (writeValue(fixtureText, applyOps(doc, [{ op: 'props', edits: [{ clip: 'c2', prop: 'volume', value: 0.9 }] }]), fixtureHash));
  assert.equal(noop.ok, true);
  assert.equal(/** @type {any} */ (noop).changed, false);

  // expectedHash 不符 = CONFLICT
  const conflict = /** @type {any} */ (writeValue(fixtureText, value, '0'.repeat(64)));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'CONFLICT');
});

test('写回结构性改动：新增/删除片段只动那一行，轨道顺序变化才整段重写', () => {
  const doc = fixtureDoc();
  const inserted = applyOps(doc, [{ op: 'insert', clip: { src: 'assets/take-c.mp4', time: [0, 2] }, at: 7, track: 0 }]);
  const written = /** @type {any} */ (writeValue(fixtureText, inserted, fixtureHash));
  assert.equal(written.ok, true, `${written.code}`);
  const lines = /** @type {string} */ (written.text).split('\n');
  assert.equal(lines.length, fixtureText.split('\n').length + 1);
  assert.ok(lines.some((line) => line.includes('id="take-c"')));

  const removed = applyOps(doc, [{ op: 'remove', clip: 'c2' }]);
  const removedText = /** @type {any} */ (writeValue(fixtureText, removed, fixtureHash));
  assert.equal(removedText.ok, true);
  assert.equal(/** @type {string} */ (removedText.text).includes('id="c2"'), false);

  const reordered = applyOps(doc, [{ op: 'reorder', from: 0, to: 2 }]);
  const reorderedText = /** @type {any} */ (writeValue(fixtureText, reordered, fixtureHash));
  assert.equal(reorderedText.ok, true, `${reorderedText.code}: ${JSON.stringify(reorderedText.diagnostics ?? [])}`);
  const reparsed = parse(/** @type {string} */ (reorderedText.text)).doc;
  assert.equal(reparsed === null, false);
  assert.deepEqual(
    /** @type {any} */ (reparsed).tracks.map((/** @type {any} */ track) => track.clips.map((/** @type {any} */ clip) => clip.id)),
    [['a1'], ['a2'], ['c1', 'c2']],
  );
});

/**
 * R189：新建叠层轨的**默认落点**。
 *
 * section 顺序 = z 序（第一个在最上层）。以前 `insert` 不指定 track 时一律 `push` 到末尾，
 * 于是「画面轨已经存在，再加一条网页/字幕轨」必然落到最底层 → 时间线里看得见、导出里被画面
 * 整条盖住（R180 的黑片事故就是这个方向）。现在叠层落最上层，画面/音轨保持原样。
 */
test('R189 叠层（page/subtitle）新建轨道落在最上层；画面/音轨仍落最下层', () => {
  const base = fixtureDoc();
  const before = base.tracks.length;

  const withPage = applyOps(base, [{ op: 'insert', clip: { src: 'scene.html#t=0,2', kind: 'page', at: 0 } }]);
  assert.equal(withPage.tracks.length, before + 1);
  assert.equal(withPage.tracks[0].role, 'page');
  assert.deepEqual(
    withPage.tracks[0].clips.map((/** @type {any} */ clip) => clip.id),
    ['scene'],
    '新建的叠层轨必须在第 0 条，否则会被下面的画面压住',
  );
  assert.equal(withPage.tracks[0].index, 0, 'index 必须重新编号（0 是最上层）');
  assert.deepEqual(
    withPage.tracks.slice(1).map((/** @type {any} */ track) => track.clips.map((/** @type {any} */ clip) => clip.id)),
    base.tracks.map((/** @type {any} */ track) => track.clips.map((/** @type {any} */ clip) => clip.id)),
    '原有轨道顺序不能被新轨打乱',
  );

  /* 文本片段仍并进已有画面轨（同 role 合并，历史行为不变） */
  const withText = applyOps(base, [{ op: 'insert', clip: { kind: 'text', text: '字幕', at: 0, time: [0, 2] } }]);
  assert.equal(withText.tracks.length, before, '有同 role 轨道时不新建轨');

  /* 画面片段并进已有画面轨（同 role 合并；不新建轨、不抢 z 序） */
  const withVideo = applyOps(base, [{ op: 'insert', clip: { src: 'assets/take-d.mp4', at: 0, time: [0, 2] } }]);
  const videoTrack = withVideo.tracks.find((/** @type {any} */ track) => track.clips.some((/** @type {any} */ clip) => clip.id === 'take-d'));
  assert.ok(videoTrack, 'take-d 必须进某条轨');
  assert.equal(videoTrack.role, 'picture');
});
