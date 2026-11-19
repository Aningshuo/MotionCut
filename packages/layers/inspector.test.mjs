// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S3 验收 A1/A2/A4（纯函数部分）
 *
 * 运行：node --test --test-concurrency=1 packages/layers/inspector.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLayerTestEnv } from './test-env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = (rel) => import(new URL(rel, import.meta.url).href);

const { buildInspector, buildMultiInspector, patchForField } = await load('./inspector.ts');
const { EditSession } = await load('./edit-session.ts');
const { mergeOverride } = await load('./override-merge.mjs');

const TEST_ENV = await resolveLayerTestEnv({ suite: 'inspector' });
const EVIDENCE_DIR = TEST_ENV.evidenceDir;
const evidence = { batch: 'B-SUB1-R2-002', suite: 'inspector.test.mjs', cases: {} };

const ref = {
  clipId: 'clip-inspector',
  at: '#headline',
  kind: 'text',
  name: '标题',
  selector: '#headline',
  depth: 2
};

const described = {
  box: { x: 40, y: 48, w: 96.5, h: 40.8, rotation: 0 },
  style: {
    'font-size': '34px',
    'font-weight': '700',
    'line-height': '40.8px',
    'letter-spacing': 'normal',
    'text-align': 'start',
    color: 'rgb(238, 242, 255)',
    'background-color': 'rgba(0, 0, 0, 0)',
    opacity: '1',
    'text-shadow': 'none',
    '-webkit-text-stroke-width': '0px',
    '-webkit-text-stroke-color': 'rgb(238, 242, 255)'
  },
  locked: false,
  text: '6.5s',
  tag: 'h1'
};

async function save() {
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(path.join(EVIDENCE_DIR, 'inspector-pure.json'), JSON.stringify(evidence, null, 2) + '\n');
}

test('S3-A1 字段含 current/source/editable/unit，来源标注正确', async () => {
  const override = { style: { color: 'rgb(255, 45, 85)' } };
  const model = buildInspector(ref, override, described);

  assert.equal(model.mode, 'single');
  const groupIds = model.groups.map((g) => g.id);
  assert.deepEqual(groupIds, ['text', 'geometry', 'typography', 'appearance'], `字段组=${groupIds}`);

  for (const f of model.fields) {
    assert.ok(f.current !== undefined, `${f.id} 缺 current`);
    assert.ok(f.source === 'override' || f.source === 'computed', `${f.id} source=${f.source}`);
    assert.equal(typeof f.editable, 'boolean');
    assert.ok(['px', 'em', 'deg', '%', '秒', '色值', '无'].includes(f.unit), `${f.id} unit=${f.unit}`);
  }
  assert.equal(model.fields.find((field) => field.id === 'cropCorners')?.unit, '%');

  const color = model.fields.find((f) => f.id === 'color');
  const fontSize = model.fields.find((f) => f.id === 'fontSize');
  const rotation = model.fields.find((f) => f.id === 'rotation');
  assert.equal(color.source, 'override');
  assert.equal(color.current, 'rgb(255, 45, 85)');
  assert.equal(color.unit, '色值');
  assert.equal(fontSize.source, 'computed');
  assert.equal(fontSize.current, '34px');
  assert.equal(fontSize.unit, 'px');
  assert.equal(rotation.source, 'computed');
  assert.equal(rotation.current, 0);
  assert.equal(rotation.unit, 'deg');

  // 锁定层：所有字段 editable=false，且给出原因
  const locked = buildInspector(ref, override, { ...described, locked: true });
  assert.equal(locked.locked, true);
  assert.ok(locked.fields.every((f) => f.editable === false));
  assert.ok(locked.fields.every((f) => f.lockedReason === 'LAYER_LOCKED'));

  // 多选：明确不支持编辑
  const multi = buildMultiInspector([ref, { ...ref, at: '#badge' }]);
  assert.equal(multi.mode, 'multi');
  assert.equal(multi.count, 2);
  assert.equal(multi.note, '不支持多选编辑');
  assert.equal(multi.fields.length, 0);

  evidence.cases['S3-A1'] = {
    status: 'PASS',
    groups: groupIds,
    fields: model.fields.length,
    color: { current: color.current, source: color.source, unit: color.unit },
    fontSize: { current: fontSize.current, source: fontSize.source, unit: fontSize.unit },
    lockedEditable: locked.fields.every((f) => f.editable === false),
    multi: multi.note
  };
  await save();
});

test('S3-A2 改一个字 → 只写一个 override 字段，不写整包 computed', async () => {
  const r = patchForField('fontSize', 48);
  assert.ok('patch' in r, `patchForField 返回错误：${r.error?.code}`);
  const patch = r.patch;
  assert.deepEqual(Object.keys(patch), ['style']);
  assert.deepEqual(Object.keys(patch.style), ['font-size']);
  assert.equal(patch.style['font-size'], '48px');

  const merged = mergeOverride({}, patch);
  assert.deepEqual(Object.keys(merged.style), ['font-size'], `合并后多出键：${Object.keys(merged.style).join(',')}`);
  assert.equal(merged.t, undefined, '仅改字号却写入了文本');
  // 绝不能把 computed 整包写进去
  for (const k of Object.keys(described.style)) {
    if (k === 'font-size') continue;
    assert.equal(merged.style[k], undefined, `computed 键 ${k} 被烘进 override`);
  }

  const textPatch = patchForField('text', '7.0s');
  assert.ok('patch' in textPatch);
  assert.deepEqual(textPatch.patch, { t: '7.0s' });

  evidence.cases['S3-A2'] = {
    status: 'PASS',
    patchKeys: Object.keys(patch.style),
    mergedKeys: Object.keys(merged.style),
    computedKeysLeaked: 0,
    textPatch: textPatch.patch
  };
  await save();
});

test('S3-A4 旧快照提交：字段不重叠自动 rebase（保留字号），重叠报 CONFLICT', async () => {
  /** 简单“磁盘”：哈希 = 内容 JSON 的递增版本，便于断言 CAS。 */
  let disk = 0;
  const commits = [];
  const session = new EditSession({
    initialHash: 'h0',
    commit: async (next, expectedHash) => {
      commits.push({ next, expectedHash });
      disk += 1;
      return { ok: true, hash: `h${disk}` };
    }
  });

  const snap0 = session.snapshot();
  const r1 = await session.edit({ style: { 'font-size': '48px' } }, snap0);
  assert.equal(r1.status, 'applied');
  assert.equal(session.hash, 'h1');

  // 故意用旧快照（h0）改颜色：字段不重叠 → rebase，字号不能丢
  const r2 = await session.edit({ style: { color: 'rgb(255, 45, 85)' } }, snap0);
  assert.equal(r2.status, 'rebased', `状态=${r2.status}`);
  assert.deepEqual(r2.keptKeys, ['style:font-size']);
  assert.equal(r2.override.style['font-size'], '48px');
  assert.equal(r2.override.style.color, 'rgb(255, 45, 85)');
  assert.equal(Object.keys(r2.override.style).length, 2);
  assert.equal(r2.hash, 'h2');

  // 再基于更旧的快照改同一个字段：会话里字号已被改成 60，旧快照仍是 48
  // → 必须报冲突，不能静默覆盖
  const r3 = await session.edit({ style: { 'font-size': '60px' } }, session.snapshot());
  assert.equal(r3.status, 'applied');
  const stale = { override: { style: { 'font-size': '48px', color: 'rgb(255, 45, 85)' } }, hash: 'h1' };
  const r4 = await session.edit({ style: { 'font-size': '64px' } }, stale);
  assert.equal(r4.status, 'conflict');
  assert.deepEqual(r4.conflicts, ['style:font-size']);
  assert.equal(r4.override.style['font-size'], '60px', '冲突时当前字号被改掉了');
  assert.equal(session.hash, 'h3', '冲突不得推进哈希');
  assert.equal(commits.length, 3, '冲突不应发起写入');

  // 顺序：每次成功写入都先 paint 后 commit
  assert.ok(r2.trace.includes('paint:next'));
  assert.ok(r2.trace.indexOf('paint:next') < r2.trace.findIndex((t) => t.startsWith('commit:')));

  evidence.cases['S3-A4'] = {
    status: 'PASS',
    first: r1.status,
    staleDisjoint: { status: r2.status, keptKeys: r2.keptKeys, styleKeys: Object.keys(r2.override.style) },
    sameField: { status: r3.status, fontSize: r3.override.style['font-size'] },
    staleOverlap: { status: r4.status, conflicts: r4.conflicts, hash: session.hash },
    commits: commits.length,
    trace: r2.trace
  };
  await save();
});
