// @ts-nocheck —— 单测以运行时断言为准；被测模块 inspector-groups.ts 仍由 tsc 严格检查。
/**
 * S78 · 检查器分组的单测（B-SUB1-R31-040）。
 *
 * 四条必须钉住的东西：
 * 1. 每组元素类型的组顺序是**快照**，不是「长度对了就行」；
 * 2. 未知字段进「未归属」而不是消失；认识的字段放错元素类型要标 `not-for-kind`；
 * 3. 同一字段不许出现在两个组里；
 * 4. 与 `film-core/ops.mjs` 的 `fieldsAllowedFor(kind)` 交叉校验：白名单允许的字段必须都能归组，差集为空。
 *
 * 跑法：`node --test packages/studio/ui/src/app/inspector-groups.test.mjs`
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fieldsAllowedFor } from '../../../../film-core/ops.mjs';
import {
  INSPECTOR_GROUPS,
  elementLocked,
  fieldGroupId,
  groupFieldsFor,
  partitionFields,
} from './inspector-groups.ts';

const KINDS = ['video', 'still', 'page', 'sound', 'subtitle'];

/** 期望的组顺序（快照）：改顺序 = 改面板，必须在这里显式改一笔。 */
const ORDER = {
  video: ['geometry', 'transform', 'clip', 'typography', 'appearance', 'audio', 'timing', 'source'],
  still: ['geometry', 'transform', 'clip', 'typography', 'appearance', 'audio', 'timing', 'source'],
  page: ['geometry', 'transform', 'clip', 'typography', 'appearance', 'audio', 'timing', 'source'],
  sound: ['appearance', 'audio', 'timing', 'source'],
  subtitle: ['text', 'typography', 'appearance', 'timing', 'source'],
};

test('组定义完整：id 唯一、字段不跨组重复、每组都有中文名与适用类型', () => {
  const ids = INSPECTOR_GROUPS.map((group) => group.id);
  assert.equal(new Set(ids).size, ids.length, `组 id 有重复：${ids.join(',')}`);

  const seen = new Map();
  for (const group of INSPECTOR_GROUPS) {
    assert.equal(typeof group.label, 'string');
    assert.ok(group.label.length > 0, `${group.id} 没有中文名`);
    assert.ok(group.fields.length > 0, `${group.id} 没有字段`);
    assert.ok(group.kinds.length > 0, `${group.id} 没有适用类型`);
    for (const kind of group.kinds) assert.ok(KINDS.includes(kind), `${group.id} 有未知类型 ${kind}`);
    for (const field of group.fields) {
      assert.equal(seen.has(field), false, `字段 ${field} 同时出现在 ${seen.get(field)} 与 ${group.id}`);
      seen.set(field, group.id);
    }
  }
});

test('每种元素类型的组顺序固定（快照）', () => {
  for (const kind of KINDS) {
    assert.deepEqual(
      groupFieldsFor(kind).map((group) => group.id),
      ORDER[kind],
      `${kind} 的组顺序变了`,
    );
  }
});

test('未知 kind 按 video 兜底（与 fieldsAllowedFor 同口径）', () => {
  assert.deepEqual(
    groupFieldsFor('gif').map((group) => group.id),
    ORDER.video,
  );
});

test('未知字段显式进「未归属」，不静默丢', () => {
  const result = partitionFields('video', ['id', 'src', 'nope']);
  const source = result.groups.find((group) => group.id === 'source');
  assert.deepEqual(source?.fields, ['src']);
  assert.deepEqual(result.ungrouped, [
    { field: 'id', reason: 'unknown' },
    { field: 'nope', reason: 'unknown' },
  ]);
});

test('认识但不适用于该元素类型的字段标 not-for-kind', () => {
  const result = partitionFields('sound', ['x', 'volume']);
  assert.deepEqual(result.groups.map((group) => group.id), ['audio']);
  assert.deepEqual(result.groups[0].fields, ['volume']);
  assert.deepEqual(result.ungrouped, [{ field: 'x', reason: 'not-for-kind' }]);
});

test('输入字段一个不丢：分组内 + 未归属 = 输入条数', () => {
  const fields = ['src', 'volume', 'x', 'clipPath', 'rotation', 'style', 'at', 'who-knows'];
  const result = partitionFields('video', fields);
  const grouped = result.groups.reduce((sum, group) => sum + group.fields.length, 0);
  assert.equal(grouped + result.ungrouped.length, fields.length);
  assert.equal(result.ungrouped.length, 1);
});

test('组内保持输入顺序，空组不返回', () => {
  const result = partitionFields('video', ['w', 'box', 'volume']);
  assert.deepEqual(result.groups.map((group) => group.id), ['geometry', 'audio']);
  assert.deepEqual(result.groups[0].fields, ['w', 'box']);
  assert.equal(result.groups.some((group) => group.fields.length === 0), false);
});

test('裁剪与变换有组可归（本批要修的那两类）', () => {
  assert.equal(fieldGroupId('clipPath'), 'clip');
  assert.equal(fieldGroupId('rotation'), 'transform');
  assert.equal(fieldGroupId('scale'), 'transform');
  assert.equal(fieldGroupId('r'), 'transform');
});

test('空输入返回空结果，不报错', () => {
  assert.deepEqual(partitionFields('subtitle', []), { groups: [], ungrouped: [] });
});

test('交叉校验：fieldsAllowedFor(kind) 的每个字段都能归组，差集为空', () => {
  let allowedTotal = 0;
  for (const kind of KINDS) {
    const allowed = fieldsAllowedFor(kind);
    assert.ok(allowed.length > 0, `${kind} 白名单是空的，交叉校验没有意义`);
    allowedTotal += allowed.length;
    const grouped = new Set(groupFieldsFor(kind).flatMap((group) => group.fields));
    const diff = allowed.filter((field) => !grouped.has(field));
    assert.deepEqual(diff, [], `${kind} 有白名单字段归不了组：${diff.join(', ')}`);
  }
  /* 20 + 20 + 20 + 11 + 11：白名单按 kind 展开后的总数（画面类多一个 r），变了就说明 film-core 动了。 */
  assert.equal(allowedTotal, 82);
});

test('白名单字段里没有跨组重复（同时校验 GROUP_BY_FIELD 的唯一性）', () => {
  const all = KINDS.flatMap((kind) => fieldsAllowedFor(kind));
  const unique = [...new Set(all)];
  for (const field of unique) {
    assert.notEqual(fieldGroupId(field), null, `白名单字段 ${field} 没有归组`);
  }
});

test('S87 元素级锁：只有 lock:true 的那一条把面板变只读', () => {
  const clip = {
    overrides: [
      { at: '#footer', lock: true },
      { at: '#card', style: { 'clip-path': 'inset(1px)' } },
      { at: '#title', lock: false },
    ],
  };
  assert.equal(elementLocked(clip, '#footer'), true);
  assert.equal(elementLocked(clip, '#card'), false, '没写 lock 的图层不受影响');
  assert.equal(elementLocked(clip, '#title'), false, 'lock:false 不算锁');
  assert.equal(elementLocked(clip, ''), false, '没选图层 → 不需要只读');
  assert.equal(elementLocked(null, '#footer'), false);
  assert.equal(elementLocked({}, '#footer'), false);
});
