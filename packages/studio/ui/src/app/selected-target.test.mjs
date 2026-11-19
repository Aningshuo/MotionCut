// @ts-nocheck —— 单测按运行时断言；被测模块 selected-target.ts 仍由 tsc 严格检查。
/**
 * R112 · L1：统一选中目标的纯函数自证（LI-A03 / A04 / A06）。
 *
 * 这里钉的是**判据本身**（不是 DOM）：上一批的教训是「量具写死 pass」能把假绿做实，
 * 所以每条都同时给「该绿」和「该丢」两侧，且丢弃原因码逐个点名 —— 探针报
 * `STALE_EPOCH` 时不是「返回了非空」就算过，而是必须是**这一个**码。
 *
 * 跑法：`node --test packages/studio/ui/src/app/selected-target.test.mjs`
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_TARGET,
  bareAt,
  emptyStateOf,
  framePathOf,
  isElementTarget,
  makeTarget,
  sameTarget,
  staleReason,
  targetSignature,
  unifiedAt,
} from './selected-target.ts';

const BASE = {
  projectId: 'proj-1',
  sequenceId: 'main',
  clipId: 'card-a',
  framePath: 'scene.html',
  elementKey: '#title',
  sourceRevision: 'hash-1',
};

const target = makeTarget(BASE, 7);

test('目标九字段齐、缺省 sequenceId 落 main', () => {
  assert.deepEqual(Object.keys(target).sort(), [
    'clipId',
    'elementKey',
    'framePath',
    'projectId',
    'selectionEpoch',
    'sequenceId',
    'sourceRevision',
  ]);
  assert.equal(target.selectionEpoch, 7);
  assert.equal(makeTarget({ ...BASE, sequenceId: '' }, 1).sequenceId, 'main');
  assert.equal(EMPTY_TARGET.selectionEpoch, 0);
});

test('新鲜回包放行：四维全对 → null', () => {
  assert.equal(
    staleReason(target, {
      projectId: 'proj-1',
      sequenceId: 'main',
      selectionEpoch: 7,
      sourceRevision: 'hash-1',
    }),
    null,
  );
});

test('旧回包四种丢弃原因逐个点名（顺序：工程 → 序列 → epoch → hash）', () => {
  const scope = { projectId: 'proj-1', sequenceId: 'main', selectionEpoch: 7, sourceRevision: 'hash-1' };
  /* 换工程：epoch 通常也变了，但要报 FOREIGN_PROJECT（排障时「换工程」和「连点两下」不是一回事）。 */
  assert.equal(staleReason(target, { ...scope, projectId: 'proj-2', selectionEpoch: 9 }), 'FOREIGN_PROJECT');
  assert.equal(staleReason(target, { ...scope, sequenceId: 'b-roll', selectionEpoch: 9 }), 'FOREIGN_SEQUENCE');
  /* 同一目标、连点两次：epoch 不同 → 前一次的 describe 不许落地。 */
  assert.equal(staleReason(target, { ...scope, selectionEpoch: 8 }), 'STALE_EPOCH');
  /* epoch 相同但盘上 hash 变了（别人写了/撤销了）→ 旧读也不许当基线。 */
  assert.equal(staleReason(target, { ...scope, sourceRevision: 'hash-2' }), 'STALE_REVISION');
  assert.equal(staleReason(null, scope), 'NO_TARGET');
  assert.equal(staleReason(EMPTY_TARGET, scope), 'NO_TARGET');
});

test('身份比较不看 epoch：同对象两次写入 signature 相同、sameTarget 为真', () => {
  const again = makeTarget(BASE, 8);
  assert.notEqual(again.selectionEpoch, target.selectionEpoch);
  assert.equal(targetSignature(again), targetSignature(target));
  assert.equal(sameTarget(again, target), true);
  /* 换片段 / 换元素 / 换帧 各差一个字，都必须判不同。 */
  assert.equal(sameTarget(makeTarget({ ...BASE, clipId: 'card-b' }, 9), target), false);
  assert.equal(sameTarget(makeTarget({ ...BASE, elementKey: '#sub' }, 9), target), false);
  assert.equal(sameTarget(makeTarget({ ...BASE, framePath: 'other.html' }, 9), target), false);
  assert.equal(sameTarget(null, target), false);
  assert.equal(sameTarget(null, null), true);
});

test('统一 id 进出：只剥当前片段的前缀，跨片段不误伤', () => {
  assert.equal(unifiedAt('card-a', '#title'), 'card-a::#title');
  assert.equal(unifiedAt('card-a', ''), '');
  /* 已经带前缀的不重复加。 */
  assert.equal(unifiedAt('card-a', 'card-a::#title'), 'card-a::#title');
  assert.equal(bareAt('card-a', 'card-a::#title'), '#title');
  /* 别的片段的前缀保持原样 —— 这是「A 的回包不许套到 B 上」的前提。 */
  assert.equal(bareAt('card-b', 'card-a::#title'), 'card-a::#title');
  assert.equal(bareAt('', 'card-a::#title'), 'card-a::#title');
});

test('帧路径：去 #t=、去 ./，与片段 id 解耦', () => {
  assert.equal(framePathOf('scene.html'), 'scene.html');
  assert.equal(framePathOf('scene.html#t=2.5'), 'scene.html');
  assert.equal(framePathOf('./pages/a.html#t=0'), 'pages/a.html');
  assert.equal(framePathOf(''), '');
});

test('元素级判定：没有 elementKey 就是片段级', () => {
  assert.equal(isElementTarget(target), true);
  assert.equal(isElementTarget(makeTarget({ ...BASE, elementKey: '' }, 1)), false);
  assert.equal(isElementTarget(EMPTY_TARGET), false);
  assert.equal(isElementTarget(null), false);
});

test('空态四种原因 + 「不知道就别判消失」', () => {
  assert.equal(emptyStateOf(null, []).code, 'NO_TARGET');
  assert.equal(emptyStateOf(EMPTY_TARGET, []).code, 'NO_TARGET');
  /* 只选了工程/序列、没有片段 → NO_CLIP（不是「未选中」也不是「先选片段才能编辑」）。 */
  assert.equal(emptyStateOf(makeTarget({ ...BASE, clipId: '', elementKey: '' }, 1), null).code, 'NO_CLIP');
  /* 有片段、没选元素：这是合法中间态（面板显示片段检查器），不是空态。 */
  const clipOnly = makeTarget({ ...BASE, elementKey: '' }, 1);
  assert.equal(emptyStateOf(clipOnly, null), null);
  /* 已知清单里有 → 正常，没有空态。 */
  assert.equal(emptyStateOf(target, ['#title', '#sub']), null);
  /* 清单里没有 → ELEMENT_GONE，且文案要阻止「旧 selector 套新页同名元素」。 */
  const gone = emptyStateOf(target, ['#sub']);
  assert.equal(gone.code, 'ELEMENT_GONE');
  assert.match(gone.message, /不会套到同名元素/);
  /* known === null（还没 list 回来）→ 不许判消失（R28 · A 的假消失）。 */
  assert.equal(emptyStateOf(target, null), null);
  /* 清单是空数组 = 这一帧真的没有层。 */
  assert.equal(emptyStateOf(clipOnly, []).code, 'NO_LAYERS');
});
