// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S6-WP16 验收 A1/A2/A3/A4/A5/A7/A9（离线判决；不写盘）
 *
 * 运行：node --test --test-concurrency=1 packages/layers/revalidate.test.mjs（env 由 test-env.mjs 自动准备；`OPENCUT_ENV_JSON` 可显式覆盖）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLayerTestEnv } from './test-env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const TEST_ENV = await resolveLayerTestEnv({ suite: 'revalidate' });
const EVIDENCE_DIR = TEST_ENV.evidenceDir;

const { revalidateOverrides, STATUS, PERSISTENCE } = await import(new URL('./revalidate.mjs', import.meta.url).href);
const { parseScene, resolveAt, pathOf } = await import(new URL('./scene-tree.mjs', import.meta.url).href);

const evidence = { batch: 'B-SUB1-R3-003R1', suite: 'revalidate.test.mjs', cases: {}, startedAt: new Date().toISOString() };

async function save() {
  evidence.finishedAt = new Date().toISOString();
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(path.join(EVIDENCE_DIR, 's6-revalidate.json'), JSON.stringify(evidence, null, 2) + '\n');
}

after(async () => {
  await save();
});

const HERO_OLD = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>t</title>
<style>.title{font-size:34px}</style></head>
<body><main class="page"><section class="hero">
<h1 class="title" data-name="headline">山间清晨</h1>
<p class="sub" data-name="sub">说明文字</p>
</section></main></body></html>
`;
const HERO_PATH = 'body > main.page:nth-of-type(1) > section.hero:nth-of-type(1) > h1.title:nth-of-type(1)';

test('S6-A1 加节点：原覆盖按内容身份 KEPT（选择器路径未变）', async () => {
  const added = HERO_OLD.replace('<p class="sub"', '<p class="note" data-name="note">新加的一行</p><p class="sub"');
  assert.notEqual(added, HERO_OLD);

  /* 路径串必须能被离线树解析出来，否则下面的 KEPT 是假通过 */
  const oldTree = parseScene(HERO_OLD);
  const hit = resolveAt(oldTree, HERO_PATH);
  assert.ok(hit, '夹具路径必须能解析');
  assert.equal(hit.tag, 'h1');

  const r = revalidateOverrides({
    oldHtml: HERO_OLD,
    newHtml: added,
    overrides: [{ at: HERO_PATH, t: '标题（改过）', style: { color: 'rgb(255, 45, 85)' } }],
    now: '2026-11-07T01:30:00.000Z'
  });
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].status, STATUS.KEPT);
  assert.equal(r.entries[0].newAt, null);
  assert.deepEqual(r.suggestedOverrides[0], { at: HERO_PATH, t: '标题（改过）', style: { color: 'rgb(255, 45, 85)' } });
  assert.equal(r.orphanedOverrides.length, 0);
  assert.equal(r.conflict, null);

  evidence.cases['S6-A1'] = { ok: true, status: r.entries[0].status, reason: r.entries[0].reason };
});

test('S6-A2 调换同级顺序：MOVED，at 更新，值不变', async () => {
  const old = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<ul class="rows"><li class="row" data-name="one">一</li><li class="row" data-name="two">二</li></ul>
</body></html>`;
  const swapped = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<ul class="rows"><li class="row" data-name="two">二</li><li class="row" data-name="one">一</li></ul>
</body></html>`;
  const at = 'body > ul.rows:nth-of-type(1) > li.row:nth-of-type(2)';
  assert.ok(resolveAt(parseScene(old), at), '夹具路径必须能解析');
  assert.equal(resolveAt(parseScene(old), at).attrs['data-name'], 'two');

  const override = { at, t: '第二行（已改）', style: { color: 'rgb(39, 199, 168)' } };
  const r = revalidateOverrides({ oldHtml: old, newHtml: swapped, overrides: [override], now: 0 });

  assert.equal(r.entries[0].status, STATUS.MOVED);
  assert.equal(r.entries[0].newAt, 'body > ul.rows:nth-of-type(1) > li.row:nth-of-type(1)');
  assert.equal(r.suggestedOverrides[0].at, r.entries[0].newAt);
  assert.equal(r.suggestedOverrides[0].t, override.t, '值必须原样保留');
  assert.deepEqual(r.suggestedOverrides[0].style, override.style);

  // 新 at 真的指向 data-name=two
  assert.equal(resolveAt(parseScene(swapped), r.suggestedOverrides[0].at).attrs['data-name'], 'two');

  evidence.cases['S6-A2'] = { ok: true, from: at, to: r.entries[0].newAt, value: r.suggestedOverrides[0] };
});

test('S6-A3 删节点：GONE，条目移到旁挂区，不删除', async () => {
  const old = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<ul class="rows"><li class="row" data-name="one">一</li><li class="row" data-name="two">二</li><li class="row" data-name="three">三</li></ul>
</body></html>`;
  const removed = old.replace('<li class="row" data-name="two">二</li>', '');
  const at = 'body > ul.rows:nth-of-type(1) > li.row:nth-of-type(2)';
  const override = { at, t: '第二行（已改）' };

  const r = revalidateOverrides({ oldHtml: old, newHtml: removed, overrides: [override], now: 0 });

  assert.equal(r.entries[0].status, STATUS.GONE);
  assert.equal(r.entries[0].reason, 'LAYER_GONE');
  assert.equal(r.suggestedOverrides.length, 0, 'GONE 不得留在主集合');
  assert.deepEqual(r.orphanedOverrides, [override], '旁挂区必须保留原条目');
  assert.equal(r.conflict.content.entries[0].reason, 'LAYER_GONE');
  assert.equal(r.conflict.content.entries[0].at, at);

  evidence.cases['S6-A3'] = {
    ok: true,
    status: r.entries[0].status,
    orphaned: r.orphanedOverrides,
    conflict: r.conflict.content.entries[0]
  };
});

test('S6-A4 同名多节点：AMBIGUOUS，不自动改，报冲突', async () => {
  const old = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div class="card" data-name="main">卡片</div>
</body></html>`;
  const dup = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div class="card" data-name="main">卡片</div>
<div class="card" data-name="main">卡片</div>
</body></html>`;
  const at = 'body > div.card:nth-of-type(1)';
  const override = { at, style: { 'background-color': 'rgb(26, 35, 54)' } };

  const r = revalidateOverrides({ oldHtml: old, newHtml: dup, overrides: [override], now: 0 });
  assert.equal(r.entries[0].status, STATUS.AMBIGUOUS);
  assert.ok(r.entries[0].candidates.length >= 2, JSON.stringify(r.entries[0].candidates));
  assert.equal(r.suggestedOverrides[0].at, at, 'AMBIGUOUS 不得自动改 at');
  assert.equal(r.conflict.content.entries[0].status, STATUS.AMBIGUOUS);

  evidence.cases['S6-A4'] = { ok: true, candidates: r.entries[0].candidates, conflict: r.conflict.path };
});

test('S6-A5 幂等：同一新旧源跑两次，指纹与冲突内容字节一致', async () => {
  const old = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<ul class="rows"><li class="row" data-name="one">一</li><li class="row" data-name="two">二</li></ul>
</body></html>`;
  const next = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<ul class="rows"><li class="row" data-name="two">二</li></ul>
</body></html>`;
  const overrides = [
    { at: 'body > ul.rows:nth-of-type(1) > li.row:nth-of-type(1)', t: '一' },
    { at: 'body > ul.rows:nth-of-type(1) > li.row:nth-of-type(2)', t: '二' }
  ];

  const a = revalidateOverrides({ oldHtml: old, newHtml: next, overrides, now: '2026-11-07T01:30:00.000Z' });
  const b = revalidateOverrides({ oldHtml: old, newHtml: next, overrides, now: '2026-11-07T01:30:00.000Z' });

  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(JSON.stringify(a.suggestedOverrides), JSON.stringify(b.suggestedOverrides));
  assert.equal(JSON.stringify(a.orphanedOverrides), JSON.stringify(b.orphanedOverrides));
  assert.equal(a.conflict.text, b.conflict.text);
  assert.equal(a.conflict.path, b.conflict.path);

  /* 两个时间戳只影响建议路径，不影响内容 */
  const c = revalidateOverrides({ oldHtml: old, newHtml: next, overrides, now: '2026-12-01T00:00:00.000Z' });
  assert.notEqual(c.conflict.path, a.conflict.path);
  assert.equal(c.conflict.text, a.conflict.text);

  evidence.cases['S6-A5'] = {
    ok: true,
    fingerprint: a.fingerprint,
    statuses: a.entries.map((e) => e.status),
    conflictPath: a.conflict.path,
    bytes: Buffer.byteLength(a.conflict.text, 'utf8')
  };
});

test('S6-A7 冲突内容可读：旧 at、新候选、原因齐全；且不落盘', async () => {
  const old = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div class="card" data-name="main">卡片</div>
</body></html>`;
  const dup = old.replace('</body>', '<div class="card" data-name="main">卡片</div></body>');
  const at = 'body > div.card:nth-of-type(1)';

  const r = revalidateOverrides({ oldHtml: old, newHtml: dup, overrides: [{ at, t: '卡片' }], now: '2026-11-07T01:30:00.000Z' });
  assert.equal(r.persistence, PERSISTENCE);
  assert.equal(r.persistence, 'WAIT_MAIN_IO');

  const parsed = JSON.parse(r.conflict.text);
  assert.equal(parsed.kind, 'overrides');
  assert.equal(parsed.entries[0].at, at, '必须写清旧的 at');
  assert.ok(parsed.entries[0].reason);
  assert.ok(Array.isArray(parsed.entries[0].candidates) && parsed.entries[0].candidates.length >= 1, '必须给新候选');
  assert.ok(parsed.entries[0].candidates.every((c) => typeof c.at === 'string' && typeof c.score === 'number'));
  assert.match(r.conflict.path, /^\.film\/conflicts\/20261107T013000-[0-9a-f]{8}-overrides\.json$/);
  assert.ok(parsed.oldSourceHash && parsed.newSourceHash);

  /* 只产建议：函数跑完磁盘上没有 .film 目录 */
  const filmDir = path.join(REPO_ROOT, '.film');
  const exists = await fs.access(filmDir).then(() => true).catch(() => false);
  assert.equal(exists, false, '本批不允许写 .film/conflicts');

  evidence.cases['S6-A7'] = { ok: true, path: r.conflict.path, entry: parsed.entries[0] };
});

test('S6-A9 1000 层重定位 < 500ms（含位移与删除）', async () => {
  const cells = (n, withName) =>
    Array.from({ length: n }, (_, i) => `<div class="cell"${withName ? ` data-name="c${i}"` : ''}>${withName ? i : ''}</div>`).join('');

  const oldA = `<html><body><section class="grid">${cells(1000, true)}</section></body></html>`;
  // 去掉第 500 个、并把前 20 个顺序倒过来 → 20 个 MOVED、1 个 GONE、979 个 KEPT
  const list = Array.from({ length: 1000 }, (_, i) => i).filter((i) => i !== 500);
  const head = list.slice(0, 20).reverse();
  const tail = list.slice(20);
  const newA = `<html><body><section class="grid">${[...head, ...tail]
    .map((i) => `<div class="cell" data-name="c${i}">${i}</div>`)
    .join('')}</section></body></html>`;

  const overrides = Array.from({ length: 1000 }, (_, i) => ({
    at: `body > section.grid:nth-of-type(1) > div.cell:nth-of-type(${i + 1})`,
    style: { color: `rgb(${i % 255}, 0, 0)` }
  }));

  const t0 = performance.now();
  const r = revalidateOverrides({ oldHtml: oldA, newHtml: newA, overrides, now: 0 });
  const elapsed = performance.now() - t0;

  assert.ok(elapsed < 500, `1000 层重定位耗时 ${elapsed.toFixed(1)}ms，超 500ms`);
  assert.equal(r.stats.total, 1000);
  assert.equal(r.stats.gone, 1);
  assert.ok(r.stats.moved >= 19, `moved=${r.stats.moved}`);
  assert.equal(r.stats.kept + r.stats.moved + r.stats.gone + r.stats.ambiguous, 1000);

  // 无内容身份的 1000 层：只靠原位形状，不能误判成 GONE
  const oldB = `<html><body><section class="grid">${cells(1000, false)}</section></body></html>`;
  const t1 = performance.now();
  const rB = revalidateOverrides({ oldHtml: oldB, newHtml: oldB, overrides, now: 0 });
  const elapsedB = performance.now() - t1;
  assert.equal(rB.stats.kept, 1000);
  assert.ok(elapsedB < 500, `无身份 1000 层耗时 ${elapsedB.toFixed(1)}ms`);

  evidence.cases['S6-A9'] = {
    ok: true,
    withIdentity: { ms: Math.round(elapsed * 1000) / 1000, stats: r.stats },
    shapeOnly: { ms: Math.round(elapsedB * 1000) / 1000, stats: rB.stats }
  };
});
