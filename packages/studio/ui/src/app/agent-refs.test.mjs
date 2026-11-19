// @ts-nocheck —— 单测按运行时断言；被测模块 agent-refs.ts 仍由 tsc 严格检查。
/**
 * R118 · L5：`@` 引用清单的纯函数自证（LI-A35）。
 *
 * 每条都给「该留」和「该丢/该去重」两侧 —— 只证「列出来了」等于没证：
 * 上一批的教训是量具写死 pass 能把假绿做实。
 *
 * 跑法：`node --test packages/studio/ui/src/app/agent-refs.test.mjs`
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  REF_LIMITS,
  addRef,
  collectRefs,
  filesOfDoc,
  refIdOf,
  refOverflowOf,
  removeRef,
  selectionFromDebug,
} from './agent-refs.ts';

const BASE = {
  projectId: 'p1',
  projectName: '季度复盘',
  session: { id: 'sabc123', title: '开场' },
  selection: null,
  scopeClips: [],
  assets: [],
  files: [],
  skills: [],
};

test('工程与会话：有 id 才列，未命名会话给可读名', () => {
  const rows = collectRefs(BASE);
  assert.deepEqual(
    rows.map((row) => row.kind),
    ['project', 'session'],
  );
  assert.equal(rows[0].label, '工程 · 季度复盘');
  assert.equal(
    collectRefs({ ...BASE, session: { id: 's1', title: '' } }).find((row) => row.kind === 'session').label,
    '会话 · 未命名会话',
  );
  /* 没工程 → 连工程行都没有（不造一个空工程）。 */
  assert.equal(collectRefs({ ...BASE, projectId: '', projectName: '' }).length, 1);
});

test('元素：身份带片段，标签同时给出元素与片段', () => {
  const rows = collectRefs({ ...BASE, selection: { clipId: 'c1', elementKey: '#card-a' } });
  const element = rows.find((row) => row.kind === 'element');
  assert.equal(element.id, 'element:c1::#card-a');
  assert.equal(element.identity, 'c1::#card-a');
  assert.ok(element.label.includes('#card-a') && element.label.includes('c1'), element.label);
  /* 同一片段也在 clips 里：元素 + 片段各一条，不是两条重复。 */
  assert.deepEqual(
    rows.filter((row) => row.kind === 'clip').map((row) => row.identity),
    ['c1'],
  );
});

test('片段：所选片段排第一，scope 重复项不重复出现', () => {
  const rows = collectRefs({ ...BASE, selection: { clipId: 'c2', elementKey: '' }, scopeClips: ['c1', 'c2', 'c3'] });
  assert.deepEqual(
    rows.filter((row) => row.kind === 'clip').map((row) => row.identity),
    ['c2', 'c1', 'c3'],
  );
});

test('素材/文件/Skill：路径作身份，名字进标签', () => {
  const rows = collectRefs({
    ...BASE,
    assets: [{ name: 'test-video.mp4', path: 'assets/test-video.mp4', kind: 'video' }],
    files: ['scene.html'],
    skills: ['cut-tight'],
  });
  const asset = rows.find((row) => row.kind === 'asset');
  assert.equal(asset.id, 'asset:assets/test-video.mp4');
  assert.ok(asset.label.includes('test-video.mp4') && asset.label.includes('video'), asset.label);
  assert.equal(rows.find((row) => row.kind === 'file').id, 'file:scene.html');
  assert.equal(rows.find((row) => row.kind === 'skill').id, 'skill:cut-tight');
});

test('上限：截断有条数，不静默少一半', () => {
  const many = Array.from({ length: REF_LIMITS.asset + 3 }, (_, index) => ({
    name: `a${String(index)}.png`,
    path: `assets/a${String(index)}.png`,
    kind: 'image',
  }));
  const rows = collectRefs({ ...BASE, assets: many });
  assert.equal(rows.filter((row) => row.kind === 'asset').length, REF_LIMITS.asset);
  assert.equal(refOverflowOf({ ...BASE, assets: many }), 3);
});

test('加/移除：幂等，移除后清单里不留这一条', () => {
  const rows = collectRefs(BASE);
  const target = rows[0];
  assert.equal(addRef(rows, target).length, rows.length);
  const removed = removeRef(rows, target.id);
  assert.equal(removed.length, rows.length - 1);
  assert.equal(
    removed.some((row) => row.id === target.id),
    false,
  );
  /* 空 identity 不造 id —— 否则会拼出 `clip:` 这种半条，移除键也对不上。 */
  assert.equal(refIdOf('clip', ''), '');
});

test('selectionFromDebug：工程不匹配就当没选中', () => {
  const raw = { projectId: 'p1', clipId: 'c1', elementKey: '#a', selectionEpoch: 3 };
  assert.deepEqual(selectionFromDebug(raw, 'p1'), { clipId: 'c1', elementKey: '#a' });
  assert.equal(selectionFromDebug(raw, 'p2'), null);
  assert.equal(selectionFromDebug(raw, ''), null);
  assert.equal(selectionFromDebug({ projectId: 'p1', clipId: '', elementKey: '' }, 'p1'), null);
  assert.equal(selectionFromDebug(null, 'p1'), null);
});

test('filesOfDoc：相对路径去重保序；外部 URL 与绝对路径不列', () => {
  const doc = {
    tracks: [
      {
        clips: [
          { src: './scene.html#t=0,2' },
          { src: 'assets/test-video.mp4' },
          { src: 'scene.html' },
          { src: 'https://example.com/a.png' },
          { src: '/etc/passwd' },
          { src: '' },
        ],
      },
      { clips: [{ src: 'assets/test-video.mp4' }] },
      { clips: 'not-an-array' },
    ],
  };
  assert.deepEqual(filesOfDoc(doc), ['scene.html', 'assets/test-video.mp4']);
  assert.deepEqual(filesOfDoc(null), []);
});
