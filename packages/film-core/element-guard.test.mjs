/**
 * R143 / SUB1 · M14-R2 · A —— 元素写入守卫（project / instance / element / epoch）。
 *
 * 六条用例（其中前四条必须拒绝、后两条必须放行）：
 * 1. 元素已删除 → `ELEMENT_GONE`；
 * 2. 元素被替换（同 ref 新节点）→ `ELEMENT_REPLACED`，并记下 epoch 不符；
 * 3. 父级卸载（元素仍在源码里）→ `ELEMENT_UNMOUNTED`；
 * 4. 跨工程 → `FOREIGN_PROJECT`（403）；
 * 5. 切换选中（目标仍有效，epoch 变大）→ **放行**；
 * 6. 重建中（页面实例变了、节点签名没变）→ **放行** + 重建标记 + 重试上限。
 *
 * 跑法：node --test packages/film-core/element-guard.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GUARD_CODES,
  GUARD_HTTP,
  GUARD_RETRY_MAX,
  checkElementIntent,
  checkElementWrites,
  createGuardState,
  elementKeyOf,
  elementWritesOf,
  parseElementKey,
  recordElementIntent,
  signatureOf,
} from './element-guard.mjs';
import { parse } from './film-doc.mjs';

const PROJECT = 'proj-a';
const INSTANCE = 'a'.repeat(64);
const KEY = elementKeyOf('card-a', '#title');

/**
 * @param {Partial<{ projectId: string, instanceId: string, signature: string, epoch: number, elementKey: string }>} [over]
 * @returns {any}
 */
const intentOf = (over = {}) => ({
  projectId: PROJECT,
  instanceId: INSTANCE,
  elementKey: KEY,
  signature: 'sig-1',
  epoch: 1,
  ...over,
});

/**
 * @param {{ present?: boolean, mounted?: boolean, signature?: string }} [entry]
 * @param {Partial<{ projectId: string, instanceId: string }>} [over]
 * @returns {any}
 */
const observationOf = (entry = {}, over = {}) => ({
  projectId: PROJECT,
  instanceId: INSTANCE,
  elements: {
    [KEY]: { present: true, mounted: true, signature: 'sig-1', ...entry },
  },
  ...over,
});

test('G1 元素已删除 → ELEMENT_GONE + 409，且台账不动', () => {
  const state = createGuardState();
  const verdict = checkElementIntent(intentOf(), observationOf({ present: false, signature: '' }), state);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, GUARD_CODES.ELEMENT_GONE);
  assert.equal(verdict.status, 409);
  assert.deepEqual(state, { epochs: {}, rebuilds: {} }, '失败不记账（否则一次失败会吃掉代数）');
});

test('G2 元素被替换（同 ref 新节点）→ ELEMENT_REPLACED，detail 带 epoch 不符', () => {
  const state = createGuardState();
  state.epochs[KEY] = 7;
  const verdict = checkElementIntent(intentOf({ signature: 'sig-new', epoch: 8 }), observationOf({ signature: 'sig-1' }), state);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, GUARD_CODES.ELEMENT_REPLACED);
  assert.equal(verdict.status, 409);
  assert.equal(verdict.detail.intentEpoch, 8);
  assert.equal(verdict.detail.currentEpoch, 7);
  assert.equal(verdict.detail.intentSignature, 'sig-new');
  assert.equal(verdict.detail.observedSignature, 'sig-1');
});

test('G3 父级卸载（元素仍在源码里）→ ELEMENT_UNMOUNTED + 409', () => {
  const verdict = checkElementIntent(intentOf(), observationOf({ mounted: false }), createGuardState());
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, GUARD_CODES.ELEMENT_UNMOUNTED);
  assert.equal(verdict.status, 409);
});

test('G4 跨工程引用 → FOREIGN_PROJECT + 403（不是 409）', () => {
  const verdict = checkElementIntent(intentOf({ projectId: 'proj-b' }), observationOf(), createGuardState());
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, GUARD_CODES.FOREIGN_PROJECT);
  assert.equal(verdict.status, 403);
  assert.equal(GUARD_HTTP.FOREIGN_PROJECT, 403);
});

test('G5 切换选中（目标仍有效、epoch 变大）→ 放行，台账跟到新代数', () => {
  const state = createGuardState();
  state.epochs[KEY] = 4;
  const verdict = checkElementIntent(intentOf({ epoch: 5 }), observationOf(), state);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.rebuilding, false);
  recordElementIntent(intentOf({ epoch: 5 }), state, /** @type {any} */ (verdict));
  assert.equal(state.epochs[KEY], 5);
});

test('G6 重建中（实例变了、签名没变）→ 放行 + 标记，连续超过上限才 BLOCKED', () => {
  const state = createGuardState();
  const rebuilt = observationOf({}, { instanceId: 'b'.repeat(64) });
  /** @type {any[]} */
  const rounds = [];
  for (let round = 1; round <= GUARD_RETRY_MAX; round += 1) {
    const verdict = checkElementIntent(intentOf({ epoch: round }), rebuilt, state);
    assert.equal(verdict.ok, true, `第 ${round} 次重建写应放行`);
    assert.equal(verdict.rebuilding, true);
    assert.equal(verdict.attempts, round);
    recordElementIntent(intentOf({ epoch: round }), state, verdict);
    rounds.push(verdict.attempts);
  }
  assert.deepEqual(rounds, [1, 2, 3]);
  const blocked = checkElementIntent(intentOf({ epoch: 9 }), rebuilt, state);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, GUARD_CODES.REBUILD_EXHAUSTED);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.detail.limit, GUARD_RETRY_MAX);
  /* 重新观察（实例对齐）之后计数清零：重建结束就该恢复正常写入 */
  const fresh = checkElementIntent(intentOf({ epoch: 10 }), observationOf(), state);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.rebuilding, false);
});

test('G7 迟到的旧 epoch → STALE_EPOCH（切换选中放行不等于旧回包放行）', () => {
  const state = createGuardState();
  state.epochs[KEY] = 6;
  const verdict = checkElementIntent(intentOf({ epoch: 3 }), observationOf(), state);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, GUARD_CODES.STALE_EPOCH);
  assert.equal(verdict.detail.intentEpoch, 3);
  assert.equal(verdict.detail.currentEpoch, 6);
});

test('G8 批里的元素写必须落在声明目标上（不能守卫 A、写 B）', () => {
  const value = { tracks: [{ clips: [{ id: 'card-a', overrides: [{ at: '#lead', style: { color: 'red' } }] }] }] };
  const ops = [{ op: 'overrides', clip: 'card-a', entries: [{ at: '#lead', style: { color: 'blue' } }, { at: '#title', style: { color: 'green' } }] }];
  const writes = elementWritesOf(value, ops);
  assert.deepEqual(writes.map((write) => [write.elementKey, write.isNew]), [
    ['card-a::#lead', false],
    ['card-a::#title', true],
  ]);
  const mismatch = checkElementWrites(intentOf({ elementKey: 'card-a::#foot' }), writes, observationOf());
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, GUARD_CODES.TARGET_MISMATCH);
  assert.equal(mismatch.status, 400);
  const hit = checkElementWrites(
    intentOf({ elementKey: 'card-a::#title' }),
    writes,
    observationOf({ present: false, signature: '' }),
  );
  assert.equal(hit.ok, false);
  assert.equal(hit.code, GUARD_CODES.ELEMENT_GONE);
});

test('G9 历史条目不算「这次要新写一个元素」（删掉的元素不挡别的元素）', () => {
  const value = { tracks: [{ clips: [{ id: 'card-a', overrides: [{ at: '#gone' }, { at: '#title' }] }] }] };
  const ops = [{ op: 'overrides', clip: 'card-a', entries: [{ at: '#gone', style: { color: 'red' } }, { at: '#title', style: { color: 'blue' } }] }];
  const writes = elementWritesOf(value, ops);
  assert.equal(writes.every((write) => write.isNew === false), true);
  const ok = checkElementWrites(intentOf(), writes, {
    projectId: PROJECT,
    instanceId: INSTANCE,
    elements: { [KEY]: { present: true, mounted: true, signature: 'sig-1' } },
  });
  assert.equal(ok.ok, true, '历史条目不再判存在性；只有目标本身要过 checkElementIntent');
});

test('G10 签名只认内容身份：属性顺序/空白不敏感，节点内容变了才变', () => {
  const base = { tag: 'h1', id: 'title', classes: ['b', 'a'], text: ' 季度 复盘 ', childCount: 0, parentKey: '#page', attrs: { 'data-name': '标题' } };
  const same = { ...base, classes: ['a', 'b'], text: '季度 复盘', attrs: { 'data-name': '标题', style: 'color:red' } };
  const other = { ...base, text: '季度复盘 2' };
  assert.equal(signatureOf(base), signatureOf(same), '同一节点换属性顺序/空白不该判替换');
  assert.notEqual(signatureOf(base), signatureOf(other), '文本变了就是新节点');
  assert.match(signatureOf(base), /^[0-9a-f]{8}$/);
});

test('G11 元素 key 的拼/拆与统一 id 同口径', () => {
  assert.equal(elementKeyOf('card-a', '#title'), 'card-a::#title');
  assert.deepEqual(parseElementKey('card-a::#title'), { clipId: 'card-a', at: '#title' });
  assert.equal(parseElementKey('#title'), null, '没有片段前缀就不是元素级目标');
  assert.equal(parseElementKey('::#title'), null);
  assert.equal(elementKeyOf('', '#title'), '');
});

test('G12 真值：applyOps 的 overrides 条目形状与本守卫的读取口径一致', () => {
  const parsed = parse('<html><body><section><iframe id="card-a" src="scenes/card-a.html#t=0,4" at="0"></iframe></section></body></html>');
  assert.notEqual(parsed.doc, null);
  const writes = elementWritesOf(parsed.doc, [
    { op: 'overrides', clip: 'card-a', entries: [{ at: '#title', style: { fontSize: '40px' } }] },
  ]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.elementKey, 'card-a::#title');
  assert.equal(writes[0]?.isNew, true);
});
