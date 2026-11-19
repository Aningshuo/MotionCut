// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S12-PERSON-MERGE 验收 A1..A9（A10 是 tsc + 全量回归 + 无 fs/网络，前两项在批次日志里）
 *
 * 纯函数验收 + 一条真实文档链路：计划样例作 base，人改字作 ours，Agent 加层作 theirs，
 * 合并结果再经 film-core 的 writeValue/parse 回写成文本并重解析（0 诊断）。
 *
 * 运行：node --test --test-concurrency=1 packages/layers/person-merge.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { REPO_ROOT } from '../scene-runtime/host.mjs';
import { resolveLayerTestEnv } from './test-env.mjs';

const TEST_ENV = await resolveLayerTestEnv({ suite: 'person-merge' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');
const SAMPLE_PATH =
  '/tmp/motioncut-optional-scene-fixture/film.html';

const { mergePersonOverrides, entryKey, stableStringify, MERGE_SCOPE } = await import(
  new URL('./person-merge.mjs', import.meta.url).href
);
const { parse, writeValue } = await import(new URL('../film-core/film-doc.mjs', import.meta.url).href);

const evidence = { batch: 'B-SUB1-R6-006', suite: 'person-merge.test.mjs', cases: {}, startedAt: new Date().toISOString() };
const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** 造一个最小文档：clips 直接给（本文件接受 FilmDoc 或 {clips} 投影）。 */
const doc = (clips) => ({ clips });

test('S12-A1 只有一边改：ours 改取 ours，theirs 改取 theirs，都没改取 base', async () => {
  const base = doc([{ id: 'c1', overrides: [{ at: '#t', t: '原文' }] }]);
  const ours = doc([{ id: 'c1', overrides: [{ at: '#t', t: '人工改' }] }]);
  const theirs = doc([{ id: 'c1', overrides: [{ at: '#t', t: '原文' }] }]);
  const onlyOurs = mergePersonOverrides({ base, ours, theirs });
  assert.deepEqual(onlyOurs.clips[0].overrides, [{ at: '#t', t: '人工改' }]);
  assert.deepEqual(onlyOurs.report.keptPerson, ['c1##t']);
  assert.deepEqual(onlyOurs.report.tookWriter, []);
  assert.deepEqual(onlyOurs.report.conflicts, []);

  const onlyTheirs = mergePersonOverrides({ base, ours: base, theirs });
  assert.deepEqual(onlyTheirs.clips[0].overrides, [{ at: '#t', t: '原文' }]);
  assert.deepEqual(onlyTheirs.report.tookWriter, []);

  const theirsChanged = mergePersonOverrides({
    base,
    ours: base,
    theirs: doc([{ id: 'c1', overrides: [{ at: '#t', t: 'Agent 改' }] }])
  });
  assert.deepEqual(theirsChanged.clips[0].overrides, [{ at: '#t', t: 'Agent 改' }]);
  assert.deepEqual(theirsChanged.report.tookWriter, ['c1##t']);
  assert.deepEqual(theirsChanged.report.keptPerson, []);

  evidence.cases['S12-A1'] = {
    ok: true,
    onlyOurs: onlyOurs.report,
    onlyTheirs: onlyTheirs.report,
    theirsChanged: { report: theirsChanged.report, entries: theirsChanged.clips[0].overrides }
  };
});

test('S12-A2 两边改成同一个值：取该值，不报冲突', async () => {
  const base = doc([{ id: 'c1', overrides: [{ at: '#t', t: '原文' }] }]);
  const sameVal = doc([{ id: 'c1', overrides: [{ at: '#t', t: '同一个新值' }] }]);
  const merged = mergePersonOverrides({ base, ours: sameVal, theirs: sameVal });
  assert.deepEqual(merged.clips[0].overrides, [{ at: '#t', t: '同一个新值' }]);
  assert.deepEqual(merged.report.conflicts, []);
  assert.deepEqual(merged.report.keptPerson, []);
  assert.deepEqual(merged.report.tookWriter, []);
  evidence.cases['S12-A2'] = { ok: true, entries: merged.clips[0].overrides, report: merged.report };
});

test('S12-A3 两边不同：ours 获胜，冲突 unit/person/writer 可读', async () => {
  const base = doc([{ id: 'c1', overrides: [{ at: '#t', t: '原文' }] }]);
  const ours = doc([{ id: 'c1', overrides: [{ at: '#t', t: '人工改' }] }]);
  const theirs = doc([{ id: 'c1', overrides: [{ at: '#t', t: 'Agent 改' }] }]);

  const merged = mergePersonOverrides({ base, ours, theirs });
  assert.deepEqual(merged.clips[0].overrides, [{ at: '#t', t: '人工改' }]);
  assert.deepEqual(merged.report.keptPerson, ['c1##t']);
  assert.deepEqual(merged.report.tookWriter, []);
  assert.equal(merged.report.conflicts.length, 1);
  const conflict = merged.report.conflicts[0];
  assert.equal(conflict.unit, 'c1##t');
  assert.equal(JSON.parse(conflict.person).t, '人工改');
  assert.equal(JSON.parse(conflict.writer).t, 'Agent 改');

  evidence.cases['S12-A3'] = { ok: true, entries: merged.clips[0].overrides, report: merged.report };
});

test('S12-A4 theirs 新增层条目取 theirs；ours 新增保留', async () => {
  const base = doc([{ id: 'c1', overrides: [] }]);
  const ours = doc([{ id: 'c1', overrides: [{ at: '#mine', t: '人工新增' }] }]);
  const theirs = doc([{ id: 'c1', overrides: [{ at: '#agent', t: 'Agent 新增' }] }]);

  const merged = mergePersonOverrides({ base, ours, theirs });
  const list = merged.clips[0].overrides;
  assert.equal(list.length, 2, JSON.stringify(list));
  assert.deepEqual(list.find((e) => e.at === '#mine'), { at: '#mine', t: '人工新增' });
  assert.deepEqual(list.find((e) => e.at === '#agent'), { at: '#agent', t: 'Agent 新增' });
  assert.deepEqual(merged.report.tookWriter, ['c1##agent']);
  assert.deepEqual(merged.report.keptPerson, ['c1##mine']);
  assert.deepEqual(merged.report.conflicts, []);

  evidence.cases['S12-A4'] = { ok: true, entries: list, report: merged.report };
});

test('S12-A5 theirs 删除：ours 未改则删；ours 改过则保留并报冲突', async () => {
  const base = doc([
    { id: 'c1', overrides: [{ at: '#a', t: '甲' }, { at: '#b', t: '乙' }] }
  ]);
  const ours = doc([{ id: 'c1', overrides: [{ at: '#a', t: '甲' }, { at: '#b', t: '乙（人工改）' }] }]);
  const theirs = doc([{ id: 'c1', overrides: [] }]);

  const merged = mergePersonOverrides({ base, ours, theirs });
  const list = merged.clips[0].overrides;
  assert.equal(list.length, 1, JSON.stringify(list));
  assert.equal(list[0].at, '#b');
  assert.equal(list[0].t, '乙（人工改）');
  assert.deepEqual(merged.report.tookWriter, ['c1##a'], '#a 两边都没改，theirs 删除 → 删');
  assert.deepEqual(merged.report.keptPerson, ['c1##b']);
  assert.equal(merged.report.conflicts.length, 1);
  assert.equal(merged.report.conflicts[0].unit, 'c1##b');
  assert.equal(JSON.parse(merged.report.conflicts[0].writer), null, 'theirs 删除时 writer 侧写成 null');
  assert.equal(JSON.parse(merged.report.conflicts[0].person).t, '乙（人工改）');

  evidence.cases['S12-A5'] = { ok: true, entries: list, report: merged.report };
});

test('S12-A6 片段自有 fade 单列为 @own，不被层条目污染', async () => {
  const base = doc([{ id: 'c1', overrides: [{ fade: [0.2, 0.5] }, { at: '#t', t: '原文' }] }]);
  const ours = doc([{ id: 'c1', overrides: [{ fade: [0.3, 0.5] }, { at: '#t', t: '原文' }] }]);
  const theirs = doc([
    { id: 'c1', overrides: [{ fade: [0.2, 0.5] }, { at: '#t', t: '原文' }, { at: '#new', t: 'Agent 层' }] }
  ]);

  const merged = mergePersonOverrides({ base, ours, theirs });
  const list = merged.clips[0].overrides;
  assert.deepEqual(list[0], { fade: [0.3, 0.5] }, '@own 必须排第一且取人工版');
  assert.equal(list.filter((e) => e.at === undefined).length, 1, '自有条目只能有一条');
  assert.ok(list.every((e) => e.at !== undefined || e.fade !== undefined));
  assert.deepEqual(merged.report.keptPerson, ['c1#@own']);
  assert.equal(entryKey({ fade: [0, 1] }), '@own');

  /* @own 冲突单独记，不与层条目混在一起 */
  const clash = mergePersonOverrides({
    base,
    ours: doc([{ id: 'c1', overrides: [{ fade: [0.3, 0.5] }, { at: '#t', t: '原文' }] }]),
    theirs: doc([{ id: 'c1', overrides: [{ fade: [0.4, 0.6] }, { at: '#t', t: '原文' }] }])
  });
  assert.equal(clash.report.conflicts.length, 1);
  assert.equal(clash.report.conflicts[0].unit, 'c1#@own');
  assert.deepEqual(clash.clips[0].overrides[0], { fade: [0.3, 0.5] });

  evidence.cases['S12-A6'] = { ok: true, entries: list, report: merged.report, ownConflict: clash.report.conflicts[0] };
});

test('S12-A7 writerKept 含被丢弃的 theirs 版本，值与 theirs 一致', async () => {
  const base = doc([{ id: 'c1', overrides: [{ at: '#t', t: '原文' }] }]);
  const ours = doc([{ id: 'c1', overrides: [{ at: '#t', t: '人工改' }] }]);
  const theirs = doc([{ id: 'c1', overrides: [{ at: '#t', t: 'Agent 改' }] }]);

  const merged = mergePersonOverrides({ base, ours, theirs });
  assert.equal(merged.writerKept.units.length, 1);
  const kept = merged.writerKept.units[0];
  assert.equal(kept.unit, 'c1##t');
  assert.equal(kept.clip, 'c1');
  assert.equal(kept.key, '#t');
  assert.equal(stableStringify(kept.entry), stableStringify({ at: '#t', t: 'Agent 改' }));
  assert.deepEqual(merged.writerKept.clips, [{ clip: 'c1', overrides: [{ at: '#t', t: 'Agent 改' }] }]);

  /* 没有冲突时 writerKept 为空，调用方据此不写 .film/conflicts/ */
  const clean = mergePersonOverrides({ base, ours: base, theirs: base });
  assert.deepEqual(clean.writerKept, { units: [], clips: [] });

  evidence.cases['S12-A7'] = { ok: true, writerKept: merged.writerKept, cleanWriterKept: clean.writerKept };
});

test('S12-A8 确定性：同一输入两次结果逐字节相同，clip/key 顺序稳定', async () => {
  const base = doc([
    { id: 'c2', overrides: [{ at: '#z', t: 'z0' }] },
    { id: 'c1', overrides: [{ fade: [0, 0.2] }, { at: '#b', t: 'b0' }, { at: '#a', t: 'a0' }] }
  ]);
  const ours = doc([
    { id: 'c1', overrides: [{ fade: [0, 0.2] }, { at: '#b', t: 'b1' }, { at: '#a', t: 'a0' }] },
    { id: 'c2', overrides: [{ at: '#z', t: 'z0' }] }
  ]);
  const theirs = doc([
    { id: 'c1', overrides: [{ fade: [0, 0.2] }, { at: '#b', t: 'b0' }, { at: '#a', t: 'a1' }] },
    { id: 'c2', overrides: [{ at: '#z', t: 'z0' }] }
  ]);

  const one = mergePersonOverrides({ base, ours, theirs });
  const two = mergePersonOverrides({ base, ours, theirs });
  assert.equal(JSON.stringify(one), JSON.stringify(two), '两次结果不一致');
  assert.equal(stableStringify(one), stableStringify(two));

  /* clip 顺序按 ours；clip 内 @own 第一，其余按 key 字典序 */
  assert.deepEqual(one.clips.map((c) => c.clip), ['c1', 'c2']);
  assert.deepEqual(one.clips[0].overrides.map((e) => e.at ?? '@own'), ['@own', '#a', '#b']);

  evidence.cases['S12-A8'] = { ok: true, clipOrder: one.clips.map((c) => c.clip), keyOrder: one.clips[0].overrides.map((e) => e.at ?? '@own'), report: one.report };
});

test('S12-A9 真实文档：人工改字 + Agent 加层，合并后重解析 0 诊断', async () => {
  const sample = await fs.readFile(SAMPLE_PATH, 'utf8');
  const withOverrides = (json) =>
    sample.replace(
      '<iframe id="card-a" src="scene-a.html#t=0,4" at="0"></iframe>',
      `<iframe id="card-a" src="scene-a.html#t=0,4" at="0" overrides='${json}'></iframe>`
    );

  const oursText = withOverrides('[{"at":"#subtitle","t":"人工改的副标题"}]');
  const theirsText = withOverrides('[{"at":"#badge","t":"AI 改的徽标"},{"at":"#subtitle","t":"AI 也想改副标题"}]');
  assert.notEqual(oursText, sample);
  assert.notEqual(theirsText, sample);

  const baseDoc = parse(sample, { path: SAMPLE_PATH });
  const oursDoc = parse(oursText, { path: SAMPLE_PATH });
  const theirsDoc = parse(theirsText, { path: SAMPLE_PATH });
  assert.equal(baseDoc.doc === null, false);
  assert.equal(oursDoc.doc === null, false);
  assert.equal(theirsDoc.doc === null, false);

  const merged = mergePersonOverrides({ base: baseDoc.doc, ours: oursDoc.doc, theirs: theirsDoc.doc });
  const cardA = merged.clips.find((c) => c.clip === 'card-a');
  assert.ok(cardA, '合并结果里没有 card-a');

  const subtitle = cardA.overrides.find((e) => e.at === '#subtitle');
  assert.equal(subtitle.t, '人工改的副标题', '人工文字被冲掉了');
  const badge = cardA.overrides.find((e) => e.at === '#badge');
  assert.equal(badge.t, 'AI 改的徽标', 'Agent 新增层丢了');
  assert.equal(merged.report.conflicts.length, 1);
  assert.equal(merged.report.conflicts[0].unit, 'card-a##subtitle');
  assert.ok(merged.report.conflicts[0].writer.includes('AI 也想改副标题'));
  assert.ok(merged.report.conflicts[0].person.includes('人工改的副标题'));

  /* 把合并结果写回 theirs 的文档，验证真能落成合法 film.html 且 0 诊断 */
  const value = JSON.parse(JSON.stringify(theirsDoc.doc));
  const track = value.tracks.find((t) => t.clips.some((c) => c.id === 'card-a'));
  const clip = track.clips.find((c) => c.id === 'card-a');
  clip.overrides = cardA.overrides;

  const written = writeValue(theirsText, value, sha(theirsText));
  assert.equal(written.ok, true, JSON.stringify(written.diagnostics));
  const reparsed = parse(written.text, { path: SAMPLE_PATH });
  const errors = reparsed.diagnostics.filter((d) => d.severity === 'error');
  assert.deepEqual(errors, [], `重解析出现错误：${JSON.stringify(errors)}`);
  assert.ok(written.text.includes('人工改的副标题'));
  assert.ok(written.text.includes('AI 改的徽标'));
  assert.equal(reparsed.doc.tracks.flatMap((t) => t.clips).find((c) => c.id === 'card-a').overrides.length, 2);

  evidence.cases['S12-A9'] = {
    ok: true,
    scope: MERGE_SCOPE,
    mergedCardA: cardA.overrides,
    report: merged.report,
    diagnostics: reparsed.diagnostics.length,
    writtenBytes: written.bytes,
    wroteHash: written.sourceHash
  };
});

test('S12-A10 无 fs/网络：person-merge 不读盘不联网；导出稳定', async () => {
  const text = await fs.readFile(path.join(REPO_ROOT, 'packages/layers/person-merge.mjs'), 'utf8');
  const banned = [/from\s+['"]node:fs/, /from\s+['"]fs['"]/, /writeFile/, /readFile/, /fetch\s*\(/, /process\.env/];
  const hits = banned.filter((re) => re.test(text)).map((re) => String(re));
  assert.deepEqual(hits, [], `person-merge 命中副作用：${hits.join(',')}`);
  assert.equal(typeof mergePersonOverrides, 'function');
  assert.equal(MERGE_SCOPE, 'overrides');

  evidence.cases['S12-A10'] = { ok: true, hits, exports: { mergePersonOverrides: typeof mergePersonOverrides, MERGE_SCOPE } };
});

after(async () => {
  evidence.finishedAt = new Date().toISOString();
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(path.join(EVIDENCE_DIR, 's12-person-merge.json'), JSON.stringify(evidence, null, 2) + '\n');
});
