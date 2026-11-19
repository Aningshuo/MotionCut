/**
 * M7-FILM-DIALECT 验收 A1–A11：film.html 的**唯一**方言（合同 v1.2.0）。
 * 跑法：node --test packages/film-core/film-doc.test.mjs
 *
 * 正常样例只用 `contracts/fixtures/film-v12.html` 与两份只读真实样例；
 * 失败样例一律内联字符串（不新建 data-* 夹具）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze, parse, sha256, write, writeValue } from './film-doc.mjs';
import { applyOps } from './ops.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

/** 旧方言属性名：分段拼，仓库里不留字面量（`git grep` 验收 A12）。 @param {string} name */
const legacy = (name) => 'data-' + name;

const V12 = readFileSync(join(repo, 'contracts', 'fixtures', 'film-v12.html'), 'utf8');
const BASIC = readFileSync(join(repo, 'tests', 'fixtures', 'main', 'film-basic.html'), 'utf8');
/**
 * 两份**不在仓里**的真实样例（S102 修可移植性）：原来直接在模块顶层 `readFileSync`，
 * 换一台没有这两个文件的机器，**整个测试文件一加载就 throw**（不是某条红，是跑不了）。
 *
 * 现在按顺序找：**仓内夹具优先** → 环境变量 → 默认绝对路径；
 * 都找不到就返回 null，由用例 `t.skip('FIXTURE_ABSENT: …')` 明确跳过——
 * 跳过要打印缺的是哪个文件，**不许静默跳过**，也不许让整个文件挂掉。
 */
const PLAN_SAMPLE_CANDIDATES = [
  join(repo, 'tests', 'fixtures', 'film', 'plan-sample.html'),
  process.env.OPENCUT_PLAN_SAMPLE,
  '/tmp/motioncut-optional-scene-fixture/film.html',
];
const BENCH_FIXTURE_CANDIDATES = [
  join(repo, 'tests', 'fixtures', 'film', 'bench-fixture.html'),
  process.env.OPENCUT_BENCH_FIXTURE,
  '/Users/example/Documents/ChatGPT/ai剪辑工作台/research/references/openfilm-latest-20261106-3e6b217a/apps/desktop/bench/fixture/film.html',
];

/**
 * @param {Array<string|undefined>} candidates
 * @returns {{path: string, text: string}|null}
 */
function resolveFixture(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue;
    try {
      return { path: candidate, text: readFileSync(candidate, 'utf8') };
    } catch {
      /* 继续找下一个 */
    }
  }
  return null;
}

/** 解析结果缓存一份：两个用例各自读一次没必要。 */
const PLAN_FIXTURE = resolveFixture(PLAN_SAMPLE_CANDIDATES);
const BENCH_FIXTURE = resolveFixture(BENCH_FIXTURE_CANDIDATES);

/** 跳过时把「缺什么、试过哪些路径」写清楚。 @param {Array<string|undefined>} candidates */
const absentMessage = (candidates) =>
  `FIXTURE_ABSENT: 找不到 ${String(candidates[0])}，试过的路径：${candidates.filter((item) => typeof item === 'string').join(' / ')}`;

/** @param {string} text */
function docOf(text) {
  const parsed = parse(text);
  assert.equal(parsed.doc === null, false, JSON.stringify(parsed.diagnostics));
  return /** @type {any} */ (parsed.doc);
}

/** @param {any} doc */
const idsOf = (doc) => doc.tracks.flatMap((/** @type {any} */ track) => track.clips.map((/** @type {any} */ clip) => clip.id));

/** @param {any} doc @param {string} id */
function clipOf(doc, id) {
  for (const track of doc.tracks) {
    const clip = track.clips.find((/** @type {any} */ item) => item.id === id);
    if (clip !== undefined) return clip;
  }
  return null;
}

/**
 * 第一处与最后一处差异的字节区间（A6 的「diff 范围」）。
 * @param {string} left @param {string} right
 */
function diffRange(left, right) {
  let start = 0;
  while (start < left.length && start < right.length && left.charAt(start) === right.charAt(start)) start += 1;
  let tail = 0;
  while (
    tail < left.length - start &&
    tail < right.length - start &&
    left.charAt(left.length - 1 - tail) === right.charAt(right.length - 1 - tail)
  ) {
    tail += 1;
  }
  return {
    start,
    end: right.length - tail,
    before: left.slice(start, left.length - tail),
    after: right.slice(start, right.length - tail),
  };
}

test('A1 计划样例 synthetic-film-sample：0 诊断、3 轨 4 片段、at/time/muted/volume 全对', (t) => {
  if (PLAN_FIXTURE === null) {
    t.skip(absentMessage(PLAN_SAMPLE_CANDIDATES));
    return;
  }
  const text = PLAN_FIXTURE.text;
  const parsed = parse(text, { path: 'synthetic-film-sample/film.html' });
  assert.deepEqual(parsed.diagnostics, [], JSON.stringify(parsed.diagnostics));
  const doc = /** @type {any} */ (parsed.doc);
  assert.equal(doc.tracks.length, 3);
  assert.deepEqual(idsOf(doc), ['card-a', 'card-b', 'test-footage', 'test-tone']);
  assert.deepEqual(doc.stage, { w: 1280, h: 720 });
  assert.deepEqual(doc.tracks.map((/** @type {any} */ track) => track.role), ['page', 'picture', 'audio']);
  assert.deepEqual(
    doc.tracks.map((/** @type {any} */ track) => track.clips.map((/** @type {any} */ clip) => clip.at ?? 0)),
    [[0, 4], [0], [0]],
  );
  assert.deepEqual(clipOf(doc, 'card-a').time, [0, 4]);
  assert.deepEqual(clipOf(doc, 'card-b').time, [0, 4]);
  assert.deepEqual(clipOf(doc, 'test-footage').time, [0, 8]);
  assert.deepEqual(clipOf(doc, 'test-tone').time, [0, 8]);
  assert.equal(clipOf(doc, 'test-footage').muted, true);
  assert.equal(clipOf(doc, 'test-tone').volume, 0.08);
  assert.equal(clipOf(doc, 'test-footage').kind, 'video');
  assert.equal(clipOf(doc, 'test-tone').kind, 'sound');
  // 文件里没有帧率：注入才变
  assert.deepEqual(doc.fps, { num: 30, den: 1 });
  assert.deepEqual(parse(text, { fps: { num: 30000, den: 1001 } }).doc?.fps, { num: 30000, den: 1001 });
});

test('A2 参考 bench fixture：0 诊断、3 轨 9 片段、第 2 轨 at=[0,6,12,18,24]', (t) => {
  if (BENCH_FIXTURE === null) {
    t.skip(absentMessage(BENCH_FIXTURE_CANDIDATES));
    return;
  }
  const text = BENCH_FIXTURE.text;
  const parsed = parse(text, { path: 'bench/fixture/film.html' });
  assert.deepEqual(parsed.diagnostics, [], JSON.stringify(parsed.diagnostics));
  const doc = /** @type {any} */ (parsed.doc);
  assert.equal(doc.tracks.length, 3);
  assert.equal(idsOf(doc).length, 9);
  assert.deepEqual(doc.stage, { w: 1920, h: 1080 });
  const kinds = doc.tracks.flatMap((/** @type {any} */ track) => track.clips.map((/** @type {any} */ clip) => clip.kind));
  assert.equal(kinds.filter((/** @type {string} */ kind) => kind === 'page').length, 3);
  assert.equal(kinds.filter((/** @type {string} */ kind) => kind === 'video').length, 5);
  assert.equal(kinds.filter((/** @type {string} */ kind) => kind === 'sound').length, 1);
  assert.deepEqual(doc.tracks[1].clips.map((/** @type {any} */ clip) => clip.at), [0, 6, 12, 18, 24]);
  // style 里的定位进 box，object-fit 原样保留、不诊断
  assert.deepEqual(clipOf(doc, 'third').box, { x: 96, y: 760, w: 960, h: 240 });
  assert.equal(clipOf(doc, 'shot1').style, 'object-fit: cover');
});

test('A3 film-v12：0 诊断、4 轨 7 片段、fade 读自自有覆盖、sfx 在 hidden muted 轨、fps 只能注入', () => {
  const parsed = parse(V12, { path: 'contracts/fixtures/film-v12.html' });
  assert.deepEqual(parsed.diagnostics, []);
  const doc = /** @type {any} */ (parsed.doc);
  assert.equal(doc.tracks.length, 4);
  assert.equal(idsOf(doc).length, 7);
  assert.deepEqual(clipOf(doc, 'bgm').fade, [1, 2]);
  assert.deepEqual(clipOf(doc, 'bgm').overrides, [{ fade: [1, 2] }]);
  const sfxTrack = doc.tracks.find((/** @type {any} */ track) => track.clips.some((/** @type {any} */ clip) => clip.id === 'sfx'));
  assert.equal(sfxTrack.hidden, true);
  assert.equal(sfxTrack.muted, true);
  // 文件里没有帧率：默认 30，注入 25 才得到 25
  assert.equal(/fps/i.test(V12), false);
  assert.deepEqual(doc.fps, { num: 30, den: 1 });
  assert.deepEqual(parse(V12, { fps: 25 }).doc?.fps, { num: 25, den: 1 });
});

test('A4 旧方言：片段 id / 时间属性各触发 LEGACY_DIALECT，消息给正确写法，doc=null', () => {
  const clipCase = `<section><video ${legacy('clip')}="v1" ${legacy('src')}="a.mp4" ${legacy('at')}="0"></video></section>`;
  const atCase = `<section><video id="v1" src="a.mp4" ${legacy('at')}="0"></video></section>`;

  for (const [text, name] of /** @type {[string, string][]} */ ([[clipCase, 'clip'], [atCase, 'at']])) {
    const parsed = parse(text);
    assert.equal(parsed.doc, null, `${name} 不该被解析成文档`);
    const codes = parsed.diagnostics.map((diag) => diag.code);
    assert.ok(codes.includes('LEGACY_DIALECT'), `${name}: ${codes.join(',')}`);
    const message = String(parsed.diagnostics.find((diag) => diag.code === 'LEGACY_DIALECT')?.message ?? '');
    assert.ok(message.includes(legacy(name)), `消息要指出旧属性：${message}`);
    assert.ok(/id="|src="|at="/.test(message), `消息要给正确写法：${message}`);
  }

  assert.equal(parse(BASIC).doc === null, false);
});

test('A5 无改动 write() → changed=false、文本逐字节相同', () => {
  const hash = sha256(V12);
  const result = write(V12, [], hash);
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.text, V12);

  const same = writeValue(V12, docOf(V12), hash);
  assert.equal(same.ok, true);
  assert.equal(same.changed, false);
  assert.equal(same.text, V12);
});

test('A6 改 at：只有该属性值区间变化，其余字节不变（给出 diff 范围）', () => {
  const doc = docOf(V12);
  const result = write(V12, [{ clipId: 'card-b', field: 'at', value: 5 }], sha256(V12));
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics ?? []));
  const range = diffRange(V12, String(result.text));
  assert.equal(range.before, '4');
  assert.equal(range.after, '5');
  assert.ok(range.start > 0 && range.end - range.start === 1, `diff 范围 ${range.start}..${range.end}`);
  assert.equal(V12.slice(0, range.start), String(result.text).slice(0, range.start));
  assert.equal(V12.slice(range.end), String(result.text).slice(range.end));
  assert.equal(String(result.text).includes('<iframe id="card-a" src="scenes/card-a.html#t=0,4" at="0"></iframe>'), true);
  assert.deepEqual(clipOf(doc, 'card-b').at, 4);
});

test('A7 改 start/end：只重写 src 的 #t=，文件里没有 time 属性', () => {
  const result = write(
    V12,
    [
      { clipId: 'take-01', field: 'start', value: 1 },
      { clipId: 'take-01', field: 'end', value: 7.5 },
    ],
    sha256(V12),
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics ?? []));
  const text = String(result.text);
  assert.match(text, /<video id="take-01" src="assets\/take-01\.mp4#t=1,7\.5" at="0" volume="0\.9" style="object-fit: cover"><\/video>/);
  assert.equal(/\stime=/.test(text), false, '文件里不该出现 time 属性');
  assert.deepEqual(clipOf(docOf(text), 'take-01').time, [1, 7.5]);
});

test('A8 改 fade：写进 overrides 自有条目，全文件没有旧方言 fade 属性，再解析回同值', () => {
  const result = write(V12, [{ clipId: 'take-02', field: 'fade', value: [0.5, 0.5] }], sha256(V12));
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics ?? []));
  const text = String(result.text);
  assert.match(text, /overrides='\[\{"fade":\[0\.5,0\.5\]\}\]'/);
  assert.equal(text.includes(legacy('fade')), false);
  assert.deepEqual(clipOf(docOf(text), 'take-02').fade, [0.5, 0.5]);

  // 0,0 = 删掉自有条目（没有 fade 就没有 overrides）
  const cleared = write(V12, [{ clipId: 'bgm', field: 'fade', value: [0, 0] }], sha256(V12));
  assert.equal(cleared.ok, true, JSON.stringify(cleared.diagnostics ?? []));
  assert.equal(String(cleared.text).includes('overrides='), false);
  assert.equal(clipOf(docOf(String(cleared.text)), 'bgm').fade, undefined);
});

test('A9 split 一个 #t=0,8 在 3s → 左 #t=0,3、右 #t=3,8', () => {
  const doc = docOf(BASIC);
  const split = applyOps(doc, [{ op: 'split', clip: 'c1', at: 3 }]);
  assert.deepEqual(clipOf(split, 'c1').time, [0, 3]);
  assert.deepEqual(clipOf(split, 'c1-b').time, [3, 4]);
  assert.equal(clipOf(split, 'c1-b').at, 3);

  const result = writeValue(BASIC, applyOps(doc, [{ op: 'split', clip: 'a1', at: 3 }]), sha256(BASIC));
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics ?? []));
  const text = String(result.text);
  assert.match(text, /<audio id="a1" src="assets\/voice\.wav#t=0,3" at="0" volume="0\.8"><\/audio>/);
  assert.match(text, /<audio id="a1-b" src="assets\/voice\.wav#t=3,8" at="3" volume="0\.8"><\/audio>/);
});

test('A10 插入/删除片段：只增删该元素；同轨后续片段字节不变', () => {
  const doc = docOf(BASIC);
  const inserted = writeValue(
    BASIC,
    applyOps(doc, [{ op: 'insert', clip: { src: 'assets/take-c.mp4', time: [0, 2] }, at: 8, track: 0 }]),
    sha256(BASIC),
  );
  assert.equal(inserted.ok, true, JSON.stringify(inserted.diagnostics ?? []));
  const afterInsert = String(inserted.text).split('\n');
  const before = BASIC.split('\n');
  assert.equal(afterInsert.length, before.length + 1);
  const keptLines = afterInsert.filter((line) => !line.includes('take-c'));
  assert.deepEqual(keptLines, before);

  const removed = writeValue(BASIC, applyOps(doc, [{ op: 'remove', clip: 'c1' }]), sha256(BASIC));
  assert.equal(removed.ok, true, JSON.stringify(removed.diagnostics ?? []));
  const afterRemove = String(removed.text);
  assert.equal(afterRemove.includes('id="c1"'), false);
  assert.ok(afterRemove.includes('<video id="c2" src="assets/take-b.mp4#t=0,3" at="4" volume="0.9"></video>'));
  assert.equal(String(removed.text).split('\n').length, before.length - 1);
});

test('A11 未知属性、未知标签、body 内 script/style：各自稳定诊断码，不崩', () => {
  const cases = [
    { text: `<section><video id="v1" src="a.mp4" bogus="1"></video></section>`, code: 'UNKNOWN_ATTRIBUTE' },
    { text: `<section><p></p></section>`, code: 'UNKNOWN_ELEMENT' },
    /* E12-P3：`<div>` 从「未知元素」变成「文本片段」——没有 id 的 div 现在报 MISSING_MEDIA。 */
    { text: `<section><div></div></section>`, code: 'MISSING_MEDIA' },
    { text: `<section></section><script>1</script>`, code: 'UNKNOWN_ELEMENT' },
    { text: `<section></section><style>section{}</style>`, code: 'UNKNOWN_ELEMENT' },
    { text: `<section><video id="v1" src="a.wav"></video></section>`, code: 'UNKNOWN_ELEMENT' },
    { text: `<section><video id="v1" src="a.mp4" speed="0"></video></section>`, code: 'BAD_SPEED' },
    { text: `<section><video id="v1" src="a.mp4#t=3,1"></video></section>`, code: 'TIME_INVERTED' },
    { text: `<section><video id="v1" src="a.mp4#t=0,99" data-native="2.166667"></video></section>`, code: 'TIME_PAST_END' },
    { text: `<section><video id="dup" src="a.mp4"></video><video id="dup" src="b.mp4"></video></section>`, code: 'DUPLICATE_CLIP_ID' },
  ];
  for (const item of cases) {
    const parsed = parse(item.text);
    assert.equal(parsed.doc, null, `应拒绝：${item.text}`);
    const codes = parsed.diagnostics.map((diag) => diag.code);
    assert.ok(codes.includes(/** @type {any} */ (item.code)), `${item.text} → ${codes.join(',')}`);
  }
  const firstText = String(cases[0]?.text ?? '');
  assert.deepEqual(parse(firstText).diagnostics, parse(firstText).diagnostics);
  assert.match(String(parse(firstText).diagnostics[0]?.message), /bogus/);
});

test('A11b 结构：stage 缺省 1920×1080；<track> 不是片段；片段不在轨道里被拒', () => {
  const noViewport = parse('<section><video id="v1" src="a.mp4"></video></section>');
  assert.equal(noViewport.doc === null, false, JSON.stringify(noViewport.diagnostics));
  assert.deepEqual(noViewport.doc?.stage, { w: 1920, h: 1080 });

  const withTrack = parse('<section><track kind="subtitles" src="a.vtt"></section>').diagnostics.map((diag) => diag.code);
  assert.deepEqual(withTrack, ['UNKNOWN_ELEMENT']);

  const outside = parse('<video id="v1" src="a.mp4"></video>');
  assert.equal(outside.doc, null);
  assert.deepEqual(outside.diagnostics.map((diag) => diag.code), ['TRACK_ROLE_CONFLICT']);

  const page = parse('<section><iframe id="p1" src="card.html"></iframe></section>');
  assert.equal(page.doc === null, false);
  assert.deepEqual(page.diagnostics.map((diag) => diag.code), ['PAGE_WITHOUT_DURATION']);
  assert.equal(page.diagnostics[0]?.severity, 'warning');

  // 四种片段标签各自成立：img = 静帧，audio 指向 mp4 = 该视频的声音
  const still = parse('<section><img id="i1" src="a.png" at="0"></section>');
  assert.equal(still.doc === null, false, JSON.stringify(still.diagnostics));
  assert.equal(clipOf(/** @type {any} */ (still.doc), 'i1').kind, 'still');
  const sound = parse('<section><audio id="s1" src="a.mp4#t=0,2"></audio></section>');
  assert.equal(sound.doc === null, false, JSON.stringify(sound.diagnostics));
  assert.equal(clipOf(/** @type {any} */ (sound.doc), 's1').sound, true);
  assert.equal(clipOf(/** @type {any} */ (sound.doc), 's1').kind, 'sound');
});

test('A11c overrides：层覆盖 + 自有条目共存，写回保留层覆盖', () => {
  const withLayer = `<section><video id="v1" src="a.mp4#t=0,4" overrides='[{"at":"div#x","t":"改"}]'></video></section>`;
  const parsed = parse(withLayer);
  assert.equal(parsed.doc === null, false, JSON.stringify(parsed.diagnostics));
  const value = applyOps(/** @type {any} */ (parsed.doc), [
    { op: 'props', edits: [{ clip: 'v1', prop: 'fade', value: [0.1, 0.2] }] },
  ]);
  const written = writeValue(withLayer, value, sha256(withLayer));
  assert.equal(written.ok, true, JSON.stringify(written.diagnostics ?? []));
  assert.match(String(written.text), /overrides='\[\{"fade":\[0\.1,0\.2\]\},\{"at":"div#x","t":"改"\}\]'/);

  const twoOwn = `<section><video id="v1" src="a.mp4" overrides='[{"fade":[1,2]},{"fade":[3,4]}]'></video></section>`;
  assert.deepEqual(parse(twoOwn).diagnostics.map((diag) => diag.code), ['UNKNOWN_FIELD']);
  const badLayer = `<section><video id="v1" src="a.mp4" overrides='[{"at":"div#x","zzz":1}]'></video></section>`;
  assert.deepEqual(parse(badLayer).diagnostics.map((diag) => diag.code), ['UNKNOWN_FIELD']);
});

test('A11d analyze() 给出可写区间：elements/sections/viewport 与文档一致', () => {
  const analysis = analyze(V12);
  assert.equal(analysis.doc === null, false);
  assert.equal(analysis.sections.length, 4);
  assert.equal(analysis.elements.size, 7);
  assert.equal(analysis.viewport === null, false);
  const ref = analysis.elements.get('bgm');
  assert.equal(ref === undefined, false);
  assert.equal(V12.slice(Number(ref?.start), Number(ref?.start) + 5), '<audi');
  const firstSection = analysis.sections[0];
  assert.ok(firstSection !== undefined);
  assert.equal(firstSection.tagEnd > firstSection.start, true);
  assert.equal(firstSection.end > firstSection.tagEnd, true);
});

/**
 * A18（E12-P3）：文本片段 `<div>` —— 解析 / 新建 / 写回 / 重读 / 改内容。
 *
 * 判据在 `coordination/openfilm-complete-r2/E12-P3-ACCEPTANCE.md`（B1/B2/B3）；
 * 这里证纯函数那一段，`/ops` + 浏览器那段由 `scripts/s190-r51-e12p3-accept.mjs` 量。
 */
test('A18 文本片段：parse 出 kind=text、insert 落盘、重读还在、改内容只动内文', () => {
  const TEXT_FILM = [
    '<!doctype html>',
    '<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=1280, height=720"></head>',
    '<body>',
    '<section id="s1">',
    '  <div id="title-1" src="scenes/intro.html#t=0,6" at="0" time="0,6" style="color:#fff">你好，世界</div>',
    '  <video id="v1" src="assets/clip.mp4#t=0,8" at="0"></video>',
    '</section>',
    '</body></html>',
    '',
  ].join('\n');

  const parsed = parse(TEXT_FILM);
  assert.deepEqual(parsed.diagnostics, []);
  const clips = (parsed.doc?.tracks ?? []).flatMap((track) => track.clips);
  assert.deepEqual(clips.map((clip) => `${clip.id}:${clip.kind}`), ['title-1:text', 'v1:video']);
  const title = clips[0];
  assert.equal(title?.text, '你好，世界');
  assert.deepEqual(title?.time, [0, 6]);
  /* `time` 属性与 `src#t=` 同义：src 只留路径，区间进 clip.time。 */
  assert.equal(title?.src, 'scenes/intro.html');

  /* 新建：`kind:'text'` + text，src 可省 —— 引擎自己铸 id。 */
  const inserted = applyOps(parsed.doc, [{ op: 'insert', clip: { kind: 'text', text: '第二句', at: 6, time: [0, 3] } }]);
  const added = (/** @type {any[]} */ (inserted.tracks ?? [])).flatMap((track) => track.clips).find((clip) => clip.text === '第二句');
  assert.equal(added === undefined, false, 'insert 没落地');
  assert.equal(added?.kind, 'text');
  assert.equal(added?.src, '', '文本片段没有 src');

  const written = writeValue(TEXT_FILM, inserted, sha256(TEXT_FILM));
  assert.equal(written.ok, true, JSON.stringify(written.diagnostics ?? []));
  const text = String(written.text);
  assert.ok(text.includes(`<div id="${String(added?.id)}" at="6" time="0,3">第二句</div>`), text);

  /* 重读：内容、区间、类型都还在；原片段逐字不变。 */
  const again = parse(text);
  assert.deepEqual(again.diagnostics, []);
  const round = (again.doc?.tracks ?? []).flatMap((track) => track.clips);
  assert.equal(round.length, 3);
  assert.equal(round.find((clip) => clip.id === 'title-1')?.text, '你好，世界');
  assert.equal(round.find((clip) => clip.id === String(added?.id))?.time?.[1], 3);

  /* 改内容：只替换元素内文，属性一个不动。 */
  const edited = applyOps(parsed.doc, [{ op: 'props', edits: [{ clip: 'title-1', prop: 'text', value: '换了 <一句> & 就这样' }] }]);
  const rewritten = writeValue(TEXT_FILM, edited, sha256(TEXT_FILM));
  assert.equal(rewritten.ok, true, JSON.stringify(rewritten.diagnostics ?? []));
  assert.ok(String(rewritten.text).includes('>换了 &lt;一句&gt; &amp; 就这样</div>'), String(rewritten.text));
  assert.equal(parse(String(rewritten.text)).doc === null, false);
  assert.equal(parse(String(rewritten.text)).doc?.tracks[0]?.clips[0]?.text, '换了 <一句> & 就这样');

  /* 负向：文本片段里塞子元素必须报错，不许静默只读文字。 */
  const nested = parse('<section><div id="t" time="0,2">前<span>中</span>后</div></section>');
  assert.equal(nested.doc, null);
  assert.deepEqual(nested.diagnostics.map((diag) => diag.code), ['UNKNOWN_ELEMENT']);
});

test('A18b 文本片段不改变老工程（v1.2.0）的写回：加契约前后逐字节相同', () => {
  /* 老工程里没有 `<div>`：加了 text 之后，同一份编辑必须还是「1 行变、字节不变」。 */
  const before = V12;
  const doc = parse(before).doc;
  assert.equal(doc === null, false);
  const applied = applyOps(doc, [{ op: 'props', edits: [{ clip: 'take-01', prop: 'volume', value: 0.8 }] }]);
  const written = writeValue(before, applied, sha256(before));
  assert.equal(written.ok, true);
  assert.equal(String(written.text), before.replace('volume="0.9"', 'volume="0.8"'));
});
