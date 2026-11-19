// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S5-WP15 库面板（最小面板）：视图模型 + DOM 字符串的可断言点
 *
 * 运行：node --test --test-concurrency=1 packages/studio/ui/src/components/library/panel.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../../../..');
const EVIDENCE_DIR = path.join(REPO_ROOT, '.local-runs/sub1/runs/R3.1/evidence');

const { buildLibraryPanelView, renderLibraryPanel } = await import(new URL('./panel.ts', import.meta.url).href);

const READY = {
  entry: {
    id: 'motion_aaa',
    name: 'badge',
    kind: 'component',
    sourcePath: 'scenes/badge.html',
    sourceHash: 'a'.repeat(64),
    version: 2,
    historyDepth: 1,
    params: { title: { type: 'string', default: '默认标题' }, tone: { type: 'color', default: '#25304a' } }
  },
  status: 'ready',
  missingAssets: []
};

const BROKEN = {
  entry: {
    id: 'motion_bbb',
    name: 'broken',
    kind: 'component',
    sourcePath: 'scenes/broken.html',
    sourceHash: 'b'.repeat(64),
    version: 1,
    historyDepth: 0,
    params: {}
  },
  status: 'missing-asset',
  missingAssets: [{ ref: 'assets/missing.png' }]
};

const INSTANCES = [
  { clipId: 'clip-b', templateId: 'motion_aaa', values: { title: '实例 B', tone: '#27c7a8' } },
  { clipId: 'clip-a', templateId: 'motion_aaa', values: { title: '实例 A', tone: '#ff2d55' } }
];

test('S5-UI 面板：不可用条目照样列出，动作带 data-enabled/data-reason', async () => {
  const view = buildLibraryPanelView([READY, BROKEN], INSTANCES);
  const html = renderLibraryPanel(view);

  assert.equal(view.total, 2);
  assert.equal(view.shown, 2);

  assert.match(html, /data-entry="motion_bbb"/);
  assert.match(html, /data-status="missing-asset"/);
  assert.match(html, /data-missing="1"/);
  assert.match(html, /assets\/missing\.png/);

  // broken 的插入被禁用，并给出原因；badge 的插入可用
  const brokenBlock = html.slice(html.indexOf('data-entry="motion_bbb"'));
  assert.match(brokenBlock, /data-action="insert" data-enabled="false" data-reason="MISSING_ASSET"[^>]*disabled/);
  const readyBlock = html.slice(html.indexOf('data-entry="motion_aaa"'), html.indexOf('data-entry="motion_bbb"'));
  assert.match(readyBlock, /data-action="insert" data-enabled="true"/);

  // 两个实例各带各的参数，按 clipId 排序
  assert.match(readyBlock, /data-instance="clip-a"[\s\S]*#ff2d55/);
  assert.match(readyBlock, /data-instance="clip-b"[\s\S]*#27c7a8/);
  const aIdx = readyBlock.indexOf('data-instance="clip-a"');
  const bIdx = readyBlock.indexOf('data-instance="clip-b"');
  assert.ok(aIdx < bIdx);

  const ev = { ok: true, html, view };
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(path.join(EVIDENCE_DIR, 's5-library-panel.json'), JSON.stringify(ev, null, 2) + '\n');
});

test('S5-UI 面板：空库与筛选为空是两种状态；筛选/搜索真的过滤', async () => {
  const empty = renderLibraryPanel(buildLibraryPanelView([]));
  assert.match(empty, /data-empty="library"/);
  assert.doesNotMatch(empty, /data-empty="filter"/);

  const filtered = buildLibraryPanelView([READY, BROKEN], INSTANCES, { filter: 'ready' });
  assert.equal(filtered.shown, 1);
  const html = renderLibraryPanel(filtered);
  assert.match(html, /data-entry="motion_aaa"/);
  assert.doesNotMatch(html, /data-entry="motion_bbb"/);

  const none = renderLibraryPanel(buildLibraryPanelView([READY], [], { query: '不存在的名字' }));
  assert.match(none, /data-empty="filter"/);

  // 归档动作在有人用时禁用
  const inUse = buildLibraryPanelView([READY], INSTANCES);
  const archive = inUse.items[0].actions.find((a) => a.action === 'archive');
  assert.equal(archive.enabled, false);
  assert.equal(archive.reason, 'TEMPLATE_IN_USE');
  // 没有历史时回退禁用
  const brokenView = buildLibraryPanelView([BROKEN], []);
  const rollback = brokenView.items[0].actions.find((a) => a.action === 'rollback');
  assert.equal(rollback.enabled, false);
  assert.equal(rollback.reason, 'NO_HISTORY');
});
