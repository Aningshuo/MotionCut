// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S9-STAGE-COMPOSE 验收 A1..A7（A8 是回归 + tsc，在批次日志里）
 *
 * 夹具 `tests/fixtures/scenes/stage-compose.html` 的场景自己在 frame(t) 里写
 * `transform: translateX(…px) scale(…)`；覆盖写 `scale`/`rotate` 个体属性。
 * 两者必须同时出现在合成矩阵里，且清除后回到场景当帧的值。
 *
 * 运行：node --test --test-concurrency=1 packages/layers/stage-compose.test.mjs（env 由 test-env.mjs 自动准备；`OPENCUT_ENV_JSON` 可显式覆盖）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SceneHost, REPO_ROOT } from '../scene-runtime/host.mjs';
import { resolveLayerTestEnv } from './test-env.mjs';

/* 跟随本批 env：复跑时不覆写已冻结的 R5 证据（S9 的证据留在 runs/R5）。 */
const TEST_ENV = await resolveLayerTestEnv({ suite: 'stage-compose' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');

const { applyOverrides, readTransform, OVERRIDE_APPLY_STAGE, TRANSFORM_OWNER, TRANSFORM_ORDER } = await import(
  new URL('./apply-overrides.mjs', import.meta.url).href
);
const { discover } = await import(new URL('./discover.ts', import.meta.url).href);

const evidence = { batch: 'B-SUB1-R5-005', suite: 'stage-compose.test.mjs', cases: {}, startedAt: new Date().toISOString() };
const SCENE = 'tests/fixtures/scenes/stage-compose.html';
const SCENE_1000 = 'tests/fixtures/scenes/stage-1000.html';

/** @type {SceneHost} */
let host;

async function save() {
  evidence.finishedAt = new Date().toISOString();
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(path.join(EVIDENCE_DIR, 's9-stage-compose.json'), JSON.stringify(evidence, null, 2) + '\n');
}

before(async () => {
  const envPath = process.env.OPENCUT_ENV_JSON ?? path.join(RUN_ROOT, 'env.json');
  const env = JSON.parse(await fs.readFile(envPath, 'utf8'));
  evidence.batch = env.batchId ?? evidence.batch;
  evidence.rerunOf = 'B-SUB1-R5-005';
  host = await new SceneHost({ port: Number(env.studioPort) }).start();
});

after(async () => {
  await save();
  if (host) await host.stop();
});

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

function assertMatrix(m, expect, label) {
  for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) {
    assert.ok(
      near(m[k], expect[k], 1e-4),
      `${label}: m.${k}=${m[k]}，应为 ${expect[k]}（矩阵 ${JSON.stringify(m)}）`
    );
  }
}

test('S9-A1 场景 transform 与覆盖 s/r 同时生效（t=1 与 t=1.6 两次 frame）', async () => {
  const handle = await host.open(SCENE);
  const page = handle.page;
  const entries = [{ at: '#card', s: 1.5, r: 30 }];

  /* --- t = 1：场景 translateX(50px) scale(1.2) --- */
  await host.frame(handle, { t: 1 });
  const before1 = await readTransform(page, '#card');
  assert.equal(before1.transform, 'matrix(1.2, 0, 0, 1.2, 50, 0)');
  assert.equal(before1.scale, 'none');
  const apply1 = await applyOverrides(page, entries);
  assert.deepEqual(apply1.missed, [], JSON.stringify(apply1));
  assert.deepEqual(apply1.unsupported, [], JSON.stringify(apply1));
  const t1 = await readTransform(page, '#card');

  // 场景的 transform 一字未改；覆盖落在个体属性上
  assert.equal(t1.transform, before1.transform, '场景 transform 被改写了');
  assert.equal(t1.scale, '1.5');
  assert.equal(t1.rotate, '30deg');
  assert.equal(t1.owned, 'scale rotate');

  // M = R(30) · S(1.5) · [translateX(50) scale(1.2)]
  const k1 = 1.2 * 1.5;
  assertMatrix(
    t1.matrix,
    {
      a: k1 * Math.cos(Math.PI / 6),
      b: k1 * Math.sin(Math.PI / 6),
      c: -k1 * Math.sin(Math.PI / 6),
      d: k1 * Math.cos(Math.PI / 6),
      e: 1.5 * Math.cos(Math.PI / 6) * 50,
      f: 1.5 * Math.sin(Math.PI / 6) * 50
    },
    't=1'
  );
  assert.ok(near(t1.rotationDeg, 30, 1e-6), `t=1 合成角 ${t1.rotationDeg}`);
  assert.ok(near(t1.scaleAbs, 1.8, 1e-6), `t=1 合成缩放 ${t1.scaleAbs}`);
  assert.ok(near(t1.rect.w, 180 * (Math.cos(Math.PI / 6) + Math.sin(Math.PI / 6)), 1e-3), `t=1 包围盒宽 ${t1.rect.w}`);

  /* --- t = 1.6：场景 translateX(68px) scale(1.32)，覆盖仍是 s=1.5 r=30 --- */
  await host.frame(handle, { t: 1.6 });
  const before2 = await readTransform(page, '#card');
  assert.equal(before2.transform, 'matrix(1.32, 0, 0, 1.32, 68, 0)', '场景动画应在 t=1.6 改变自己的 transform');
  assert.notEqual(before2.transform, before1.transform);
  const apply2 = await applyOverrides(page, entries);
  assert.deepEqual(apply2.unsupported, [], JSON.stringify(apply2));
  const t2 = await readTransform(page, '#card');

  assert.equal(t2.transform, before2.transform);
  const k2 = 1.32 * 1.5;
  assertMatrix(
    t2.matrix,
    {
      a: k2 * Math.cos(Math.PI / 6),
      b: k2 * Math.sin(Math.PI / 6),
      c: -k2 * Math.sin(Math.PI / 6),
      d: k2 * Math.cos(Math.PI / 6),
      e: 1.5 * Math.cos(Math.PI / 6) * 68,
      f: 1.5 * Math.sin(Math.PI / 6) * 68
    },
    't=1.6'
  );
  assert.ok(near(t2.rotationDeg, 30, 1e-6), `t=1.6 合成角 ${t2.rotationDeg}`);
  assert.ok(near(t2.scaleAbs, 1.98, 1e-6), `t=1.6 合成缩放 ${t2.scaleAbs}`);
  assert.ok(near(t2.rect.w, 198 * (Math.cos(Math.PI / 6) + Math.sin(Math.PI / 6)), 1e-3), `t=1.6 包围盒宽 ${t2.rect.w}`);

  await handle.dispose();

  evidence.cases['S9-A1'] = {
    ok: true,
    stage: OVERRIDE_APPLY_STAGE,
    owner: TRANSFORM_OWNER,
    order: TRANSFORM_ORDER,
    t1: { scene: before1.transform, scale: t1.scale, rotate: t1.rotate, matrix: t1.matrix, rectW: t1.rect.w },
    t16: { scene: before2.transform, scale: t2.scale, rotate: t2.rotate, matrix: t2.matrix, rectW: t2.rect.w },
    note: '场景 transform 两次完全不同（1.2/50 → 1.32/68），说明覆盖没有盖掉场景动画；合成矩阵同时含两段'
  };
});

test('S9-A2 同一 t 连续应用两次同一 entries：矩阵逐位不变（幂等）', async () => {
  const handle = await host.open(SCENE);
  const page = handle.page;
  const entries = [
    { at: '#card', s: [1.5, 1.5], r: 30 },
    { at: '#plain', s: 2, r: -15 }
  ];

  await host.frame(handle, { t: 1 });
  const first = await applyOverrides(page, entries);
  const a = { card: await readTransform(page, '#card'), plain: await readTransform(page, '#plain') };
  const second = await applyOverrides(page, entries);
  const b = { card: await readTransform(page, '#card'), plain: await readTransform(page, '#plain') };

  assert.deepEqual(first.unsupported, []);
  assert.deepEqual(second.unsupported, []);
  assert.deepEqual(second.cleared, [], '第二次应用不该触发清除');
  for (const key of ['a', 'b', 'c', 'd', 'e', 'f']) {
    assert.ok(near(a.card.matrix[key], b.card.matrix[key], 1e-9), `card.${key} 累积了：${a.card.matrix[key]} → ${b.card.matrix[key]}`);
    assert.ok(near(a.plain.matrix[key], b.plain.matrix[key], 1e-9), `plain.${key} 累积了`);
  }
  assert.equal(a.card.scale, b.card.scale);
  assert.equal(a.card.owned, 'scale rotate');

  await handle.dispose();

  evidence.cases['S9-A2'] = {
    ok: true,
    first: a.card.matrix,
    second: b.card.matrix,
    clearedOnSecond: second.cleared.length,
    note: '两次写入同样的 scale/rotate 值，computed 矩阵逐位相同，标记没有重复'
  };
});

test('S9-A3 清除：应用空 entries（或只含他层）后回到该帧场景值', async () => {
  const handle = await host.open(SCENE);
  const page = handle.page;

  await host.frame(handle, { t: 1 });
  const baseline = await readTransform(page, '#card');
  assert.equal(baseline.scale, 'none');
  assert.equal(baseline.rotate, 'none');

  await applyOverrides(page, [{ at: '#card', s: 1.5, r: 30 }]);
  const applied = await readTransform(page, '#card');
  assert.equal(applied.scale, '1.5');

  /* (a) 空 entries */
  const cleared = await applyOverrides(page, []);
  const afterEmpty = await readTransform(page, '#card');
  assert.deepEqual(cleared.cleared, ['#card']);
  assert.equal(afterEmpty.scale, 'none', `清除后残留 scale：${afterEmpty.scale}`);
  assert.equal(afterEmpty.rotate, 'none');
  assert.equal(afterEmpty.transform, baseline.transform);
  assert.ok(near(afterEmpty.rect.w, baseline.rect.w, 1e-6), `包围盒未复原：${afterEmpty.rect.w} vs ${baseline.rect.w}`);
  assert.ok(near(afterEmpty.rect.x, baseline.rect.x, 1e-6));

  /* (b) 只含别的层的 entries（该层不在本批里，也要清） */
  await applyOverrides(page, [{ at: '#card', s: 1.5, r: 30 }]);
  const cleared2 = await applyOverrides(page, [{ at: '#label', t: '只改文字' }]);
  const afterOther = await readTransform(page, '#card');
  assert.deepEqual(cleared2.cleared, ['#card']);
  assert.equal(afterOther.scale, 'none');
  assert.ok(near(afterOther.rect.w, baseline.rect.w, 1e-6));

  await handle.dispose();

  evidence.cases['S9-A3'] = {
    ok: true,
    baseline: { transform: baseline.transform, rectW: baseline.rect.w },
    applied: { scale: applied.scale, rectW: applied.rect.w },
    afterEmpty: { scale: afterEmpty.scale, rectW: afterEmpty.rect.w, transform: afterEmpty.transform },
    afterOtherLayer: { scale: afterOther.scale, rectW: afterOther.rect.w },
    note: '清除只 removeProperty 自己占用的 scale/rotate，transform 从始至终没被写过'
  };
});

test('S9-A4 场景无 transform：s=1.5 r=30 得到与旧写法一致的矩阵', async () => {
  const handle = await host.open(SCENE);
  const page = handle.page;
  await host.frame(handle, { t: 1 });
  const before = await readTransform(page, '#plain');
  assert.equal(before.transform, 'none');

  const applied = await applyOverrides(page, [{ at: '#plain', s: 1.5, r: 30 }]);
  assert.deepEqual(applied.unsupported, []);
  const after = await readTransform(page, '#plain');

  const k = 1.5;
  assertMatrix(
    after.matrix,
    {
      a: k * Math.cos(Math.PI / 6),
      b: k * Math.sin(Math.PI / 6),
      c: -k * Math.sin(Math.PI / 6),
      d: k * Math.cos(Math.PI / 6),
      e: 0,
      f: 0
    },
    'plain'
  );
  assert.ok(near(after.rect.w, 100 * 1.5 * (Math.cos(Math.PI / 6) + Math.sin(Math.PI / 6)), 1e-3));
  assert.equal(after.owned, 'scale rotate');

  await handle.dispose();

  evidence.cases['S9-A4'] = {
    ok: true,
    matrix: after.matrix,
    legacyEquivalent: { a: 1.5 * Math.cos(Math.PI / 6), b: 1.5 * Math.sin(Math.PI / 6) },
    rectW: after.rect.w,
    note: '均匀缩放下 rotate·scale 与旧的 transform: scale() rotate() 数值等价（R 与 S 可交换）'
  };
});

test('S9-A5 合成不了 → NOT_SUPPORTED + 原因，元素保持场景值', async () => {
  const handle = await host.open(SCENE);
  const page = handle.page;
  await host.frame(handle, { t: 1 });

  const inlineBefore = await page.evaluate(() => {
    const el = document.getElementById('inline-word');
    return { display: getComputedStyle(el).display, scale: el.style.scale };
  });
  const sceneScaleBefore = await page.evaluate(() => {
    const el = document.getElementById('scene-scale');
    return { inline: el.style.scale, computed: getComputedStyle(el).scale };
  });
  const cardBefore = await readTransform(page, '#card');

  const res = await applyOverrides(page, [
    { at: '#inline-word', s: 2, r: 10 },
    { at: '#scene-scale', s: 1.5, r: 20 }
  ]);

  const inlineAfter = await page.evaluate(() => {
    const el = document.getElementById('inline-word');
    return { display: getComputedStyle(el).display, scale: el.style.scale, rotate: el.style.rotate, mark: el.getAttribute('data-ov-transform') };
  });
  const sceneScaleAfter = await page.evaluate(() => {
    const el = document.getElementById('scene-scale');
    return { inline: el.style.scale, computed: getComputedStyle(el).scale, rotate: el.style.rotate };
  });
  const cardAfter = await readTransform(page, '#card');

  assert.equal(res.unsupported.length, 2, JSON.stringify(res));
  const byAt = Object.fromEntries(res.unsupported.map((u) => [u.at, u]));
  assert.equal(byAt['#inline-word'].code, 'NOT_SUPPORTED');
  assert.equal(byAt['#inline-word'].reason, 'INLINE_ELEMENT');
  assert.equal(byAt['#scene-scale'].code, 'NOT_SUPPORTED');
  assert.equal(byAt['#scene-scale'].reason, 'SCENE_OWNS_SCALE');
  assert.equal(byAt['#scene-scale'].detail, '1.1');

  assert.equal(inlineBefore.display, 'inline');
  assert.equal(inlineAfter.scale, '', '行内元素不该被写入 scale');
  assert.equal(inlineAfter.mark, null);
  assert.equal(sceneScaleAfter.inline, '1.1', '场景自己的 scale 被改了');
  assert.equal(sceneScaleAfter.computed, '1.1');
  assert.equal(sceneScaleAfter.rotate, '', '冲突时不该留下我们的 rotate');
  assert.equal(cardAfter.transform, cardBefore.transform);

  await handle.dispose();

  evidence.cases['S9-A5'] = {
    ok: true,
    unsupported: res.unsupported,
    inline: { before: inlineBefore, after: inlineAfter },
    sceneOwned: { before: sceneScaleBefore, after: sceneScaleAfter },
    note: '拒绝的两条都没有写属性；场景自己的 scale:1.1 原样保留，transform 未被触碰'
  };
});

test('S9-A6 t/style/lock 回归：改字、改色、锁层仍生效', async () => {
  const handle = await host.open(SCENE);
  const page = handle.page;
  await host.frame(handle, { t: 0 });

  const res = await applyOverrides(page, [
    { at: '#label', t: '改过的标题', style: { color: 'rgb(255, 45, 85)' } },
    { at: '#tag', lock: true }
  ]);
  assert.equal(res.applied, 2);
  assert.deepEqual(res.missed, []);

  const read = await page.evaluate(() => {
    const label = document.getElementById('label');
    const tag = document.getElementById('tag');
    return {
      text: label.textContent,
      color: getComputedStyle(label).color,
      locked: tag.getAttribute('data-locked'),
      pointerEvents: getComputedStyle(tag).pointerEvents,
      labelScale: getComputedStyle(label).scale,
      tagTransformMark: tag.getAttribute('data-ov-transform')
    };
  });
  assert.equal(read.text, '改过的标题');
  assert.equal(read.color, 'rgb(255, 45, 85)');
  assert.equal(read.locked, '1');
  assert.equal(read.pointerEvents, 'none');
  assert.equal(read.labelScale, 'none', '纯文本/样式条目不该顺手写 scale');
  assert.equal(read.tagTransformMark, null);

  await handle.dispose();
  evidence.cases['S9-A6'] = { ok: true, read };
});

test('S9-A7 1000 节点场景：应用 20 条含 s/r 的 entries < 50ms', async () => {
  const handle = await host.open(SCENE_1000);
  const page = handle.page;
  await host.frame(handle, { t: 1.5 });

  const found = await discover(page, 'clip-1000', 1.5);
  assert.ok(!('error' in found), JSON.stringify(found));
  const cells = found.layers.filter((l) => l.at.includes('div.cell')).slice(0, 20);
  assert.equal(cells.length, 20, `可定位的 cell 不足 20：${found.layers.length}`);

  const entries = cells.map((l, i) => ({ at: l.at, s: 1 + i / 20, r: i * 3 }));

  const t0 = performance.now();
  const res = await applyOverrides(page, entries);
  const elapsed = performance.now() - t0;

  assert.deepEqual(res.missed, [], `未命中：${res.missed.slice(0, 3).join(',')}`);
  assert.deepEqual(res.unsupported, []);
  assert.equal(res.transformed.length, 20);
  assert.ok(elapsed < 50, `应用 20 条耗时 ${elapsed.toFixed(2)}ms 超 50ms`);

  const spot = await readTransform(page, entries[19].at);
  assert.ok(near(spot.rotationDeg, 57, 1e-6), `第 20 条旋转 ${spot.rotationDeg}`);

  await handle.dispose();
  evidence.cases['S9-A7'] = {
    ok: true,
    nodes: found.layers.length,
    applied: res.transformed.length,
    ms: Math.round(elapsed * 1000) / 1000,
    sampleAt: entries[19].at,
    sampleRotation: spot.rotationDeg
  };
});
