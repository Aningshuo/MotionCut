// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S14-STAGE-COMPOSE 验收 A1..A4（A5 = tsc + 全量回归，在批次日志里）
 *
 * 要证的三件事：
 * 1. 场景自己在 `frame(t)` 里写的 `transform` 与覆盖的 `s`/`r` **同时生效**，且能分别读数；
 * 2. 场景**没有** transform 时，输出与 R6（S9 版本）**逐字节一致**——用同一份夹具、同一组
 *    entries，把 R6 的模块和当前模块各跑一遍，比对 DOM 快照哈希；
 * 3. 合成不了（祖先有 transform + 自身 transform-origin 不在中心）→ `NOT_SUPPORTED`，
 *    DOM 一个字节都不动。
 *
 * 运行：node --test --test-concurrency=1 packages/layers/stage-compose-r7.test.mjs（env 由 test-env.mjs 自动准备；`OPENCUT_ENV_JSON` 可显式覆盖）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build as esbuild } from 'esbuild';
import { SceneHost, REPO_ROOT } from '../scene-runtime/host.mjs';
import { resolveLayerTestEnv } from './test-env.mjs';

const run = promisify(execFile);

const TEST_ENV = await resolveLayerTestEnv({ suite: 'stage-compose-r7' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');
const TMP = path.join(RUN_ROOT, 'tmp/s14');
const BUNDLE_ABS = path.join(TMP, 'apply.mjs');
const R6_SRC = path.join(TMP, 'r6/apply-overrides.mjs');
const R6_BUNDLE = path.join(TMP, 'apply-r6.mjs');
const R6_COMMIT = '15497b49e9415162b921c9253ce1dab28340366b';

const url = (abs) => '/' + path.relative(REPO_ROOT, abs).split(path.sep).join('/');

const SCENE = 'tests/fixtures/scenes/stage-compose.html';
const CONFLICT = 'tests/fixtures/scenes/compose-conflict.html';

const evidence = { batch: 'B-SUB1-R7-007', suite: 'stage-compose-r7.test.mjs', cases: {}, startedAt: new Date().toISOString() };

/** @type {SceneHost} */
let host;

const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

async function save() {
  evidence.finishedAt = new Date().toISOString();
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(path.join(EVIDENCE_DIR, 's14-stage-compose.json'), JSON.stringify(evidence, null, 2) + '\n');
}

before(async () => {
  const env = JSON.parse(await fs.readFile(path.join(RUN_ROOT, 'env.json'), 'utf8'));
  evidence.batch = env.batchId ?? evidence.batch;

  await fs.mkdir(path.dirname(R6_SRC), { recursive: true });
  const { stdout } = await run('git', ['show', `${R6_COMMIT}:packages/layers/apply-overrides.mjs`], {
    cwd: REPO_ROOT,
    maxBuffer: 8 * 1024 * 1024
  });
  await fs.writeFile(R6_SRC, stdout);
  evidence.baseline = {
    commit: R6_COMMIT,
    path: 'packages/layers/apply-overrides.mjs',
    sha256: sha(stdout),
    bytes: Buffer.byteLength(stdout)
  };

  await esbuild({
    stdin: {
      contents: "export * from './packages/layers/apply-overrides.mjs';",
      resolveDir: REPO_ROOT,
      loader: 'js'
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile: BUNDLE_ABS,
    logLevel: 'silent'
  });
  await esbuild({
    entryPoints: [R6_SRC],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile: R6_BUNDLE,
    logLevel: 'silent'
  });
  evidence.bundles = { current: sha(await fs.readFile(BUNDLE_ABS, 'utf8')), r6: sha(await fs.readFile(R6_BUNDLE, 'utf8')) };

  host = await new SceneHost({ port: Number(env.studioPort) }).start();
});

after(async () => {
  await save();
  if (host) await host.stop();
});

/* ── A1 ─────────────────────────────────────────────────────────────────── */

test('S14-A1 场景自带 translateX(20px) 时，覆盖 1.2/15° 同时可见且可区分', async () => {
  const handle = await host.open(SCENE);
  const page = handle.page;

  const read = await page.evaluate(async (cur) => {
    const mod = await import(cur);
    await window.film.frame(0); // 场景写 transform: translateX(20px) scale(1)
    const el = document.querySelector('#card');
    const before = {
      transform: getComputedStyle(el).transform,
      rotate: getComputedStyle(el).rotate,
      scale: getComputedStyle(el).scale
    };
    const result = mod.applyOverrideEntries([{ at: '#card', s: 1.2, r: 15 }]);
    const after = mod.readTransformState('#card');
    return {
      before,
      result,
      after: {
        transform: after.transform,
        rotate: after.rotate,
        scale: after.scale,
        matrix: after.matrix,
        rotationDeg: after.rotationDeg,
        scaleAbs: after.scaleAbs,
        rect: after.rect
      }
    };
  }, url(BUNDLE_ABS));

  assert.match(read.before.transform, /matrix\(1, 0, 0, 1, 20, 0\)/, `场景 transform 不对：${read.before.transform}`);
  assert.equal(read.after.transform, read.before.transform, '覆盖把场景 transform 顶掉了');
  assert.equal(read.after.rotate, '15deg', `覆盖 rotate 没生效：${read.after.rotate}`);
  assert.equal(read.after.scale, '1.2', `覆盖 scale 没生效：${read.after.scale}`);
  assert.equal(read.after.transform.includes('15'), false, 'transform 不归覆盖写');
  assert.ok(Math.abs(read.after.rotationDeg - 15) < 1e-6, `合成角 ${read.after.rotationDeg}`);
  assert.ok(Math.abs(read.after.scaleAbs - 1.2) < 1e-6, `合成缩放 ${read.after.scaleAbs}`);

  /* 合成矩阵按规范顺序算：M = R(15°) · S(1.2) · T(20, 0)。
     场景那 20px 平移会被覆盖的旋转与缩放带着走，所以 e = 1.2·20·cos15°，不是 20。 */
  const rad = (15 * Math.PI) / 180;
  const expect = {
    a: 1.2 * Math.cos(rad),
    b: 1.2 * Math.sin(rad),
    c: -1.2 * Math.sin(rad),
    d: 1.2 * Math.cos(rad),
    e: 1.2 * 20 * Math.cos(rad),
    f: 1.2 * 20 * Math.sin(rad)
  };
  for (const key of ['a', 'b', 'c', 'd', 'e', 'f']) {
    assert.ok(Math.abs(read.after.matrix[key] - expect[key]) < 1e-3, `矩阵 ${key}=${read.after.matrix[key]}，应为 ${expect[key]}`);
  }
  assert.equal(read.result.unsupported.length, 0, JSON.stringify(read.result.unsupported));
  assert.equal(read.result.transformed.length, 1);

  await handle.dispose();
  evidence.cases['S14-A1'] = { ok: true, ...read };
});

/* ── A2 ─────────────────────────────────────────────────────────────────── */

test('S14-A2 场景无 transform：输出与 R6 逐字节一致（哈希给证）', async () => {
  const handle = await host.open(SCENE);
  const page = handle.page;

  const rows = await page.evaluate(async ([cur, r6]) => {
    const now = await import(cur);
    const old = await import(r6);
    const CASES = [
      { at: '#plain', s: 1.5 },
      { at: '#plain', r: 30 },
      { at: '#plain', s: [1.4, 0.8], r: 12 },
      { at: '#plain', s: 2, r: 45 },
      { at: '#label', s: 1.1 }
    ];

    const reset = (el) => {
      el.removeAttribute('style');
      for (const a of [...el.attributes]) if (a.name.startsWith('data-ov-')) el.removeAttribute(a.name);
    };
    const snap = (el) =>
      JSON.stringify({
        style: el.getAttribute('style') ?? '',
        attrs: [...el.attributes]
          .filter((a) => a.name.startsWith('data-ov-'))
          .map((a) => [a.name, a.value])
          .sort()
      });

    const out = [];
    for (const entry of CASES) {
      const el = document.querySelector(entry.at);
      reset(el);
      await window.film.frame(0);
      const resOld = old.applyOverrideEntries([entry]);
      const snapOld = snap(el);

      reset(el);
      await window.film.frame(0);
      const resNew = now.applyOverrideEntries([entry]);
      const snapNew = snap(el);

      out.push({
        entry,
        old: { snap: snapOld, transformed: [...resOld.transformed], unsupported: resOld.unsupported },
        now: { snap: snapNew, transformed: [...resNew.transformed], unsupported: resNew.unsupported },
        equal: snapOld === snapNew
      });
    }
    reset(document.querySelector('#plain'));
    return out;
  }, [url(BUNDLE_ABS), url(R6_BUNDLE)]);

  for (const row of rows) {
    assert.equal(row.equal, true, `${JSON.stringify(row.entry)} 输出与 R6 不一致：\nR6=${row.old.snap}\n现在=${row.now.snap}`);
    assert.equal(sha(row.now.snap), sha(row.old.snap), '快照哈希不同');
    assert.deepEqual(row.now.transformed, row.old.transformed);
    assert.deepEqual(row.now.unsupported, row.old.unsupported);
    row.hash = sha(row.now.snap);
  }

  await handle.dispose();
  evidence.cases['S14-A2'] = { ok: true, baseline: evidence.baseline, rows };
});

/* ── A3 ─────────────────────────────────────────────────────────────────── */

test('S14-A3（R8 改判）非中心 origin 可表达就合成；祖先 matrix3d 才拒绝', async () => {
  /* R8 的 S15 明确改判：不再因为「非中心 transform-origin」拒绝——个体属性本来就绕自身
     origin 生效，祖先只要是 2D 仿射就合得住。真正表达不了的是 3D/透视（matrix3d）。 */
  const handle = await host.open(CONFLICT);
  const page = handle.page;

  const read = await page.evaluate(async (cur) => {
    const mod = await import(cur);
    await window.film.frame(0);

    const snap = (el) => el.outerHTML;

    /* (a) 非中心 origin + 仿射祖先：允许 */
    const parent = document.querySelector('#parent');
    const parentBefore = getComputedStyle(parent).transform;
    const corner = document.querySelector('#corner');
    const resCorner = mod.applyOverrideEntries([{ at: '#corner', s: 1.2, r: 15 }]);
    const parentAfter = getComputedStyle(parent).transform;
    const stateCorner = mod.readTransformState('#corner');

    /* (b) 中心 origin 对照组 */
    const resCenter = mod.applyOverrideEntries([{ at: '#center', s: 1.2, r: 15 }]);
    const stateCenter = mod.readTransformState('#center');

    /* (c) 透视祖先：拒绝且 DOM 不变 */
    const deep = document.querySelector('#deep');
    const beforeDeep = snap(deep);
    const resDeep = mod.applyOverrideEntries([{ at: '#deep', s: 1.2, r: 15 }]);
    const afterDeep = snap(deep);

    return {
      corner: {
        result: resCorner,
        parentBefore,
        parentAfter,
        parentUnchanged: parentBefore === parentAfter,
        rotate: stateCorner.rotate,
        scale: stateCorner.scale,
        rotationDeg: stateCorner.rotationDeg,
        origin: getComputedStyle(corner).transformOrigin
      },
      center: { result: resCenter, rotationDeg: stateCenter.rotationDeg, scaleAbs: stateCenter.scaleAbs },
      deep: {
        before: beforeDeep,
        after: afterDeep,
        unchanged: beforeDeep === afterDeep,
        result: resDeep,
        computed: { rotate: getComputedStyle(deep).rotate, scale: getComputedStyle(deep).scale }
      }
    };
  }, url(BUNDLE_ABS));

  /* (a) 非中心 origin 现在能合成，祖先 transform 一个字符都没变 */
  assert.equal(read.corner.result.unsupported.length, 0, JSON.stringify(read.corner.result.unsupported));
  assert.equal(read.corner.result.transformed.length, 1, JSON.stringify(read.corner.result));
  assert.equal(read.corner.parentUnchanged, true, `祖先 transform 被改了：${read.corner.parentBefore} → ${read.corner.parentAfter}`);
  assert.equal(read.corner.rotate, '15deg', `覆盖 rotate 没生效：${read.corner.rotate}`);
  assert.equal(read.corner.scale, '1.2');
  assert.notEqual(read.corner.origin, '45px 45px', '这个用例的 origin 本来就该是非中心的');

  /* (b) 中心 origin 对照组一样能合成 */
  assert.equal(read.center.result.unsupported.length, 0, JSON.stringify(read.center.result.unsupported));
  assert.ok(Math.abs(read.center.rotationDeg - 15) < 1e-6, `对照组旋转 ${read.center.rotationDeg}`);

  /* (c) 透视祖先：拒绝 + DOM 逐字节不变 */
  assert.equal(read.deep.result.unsupported.length, 1, JSON.stringify(read.deep.result));
  assert.equal(read.deep.result.unsupported[0].reason, 'UNSUPPORTED_ANCESTOR_MATRIX');
  assert.match(read.deep.result.unsupported[0].detail, /3D|透视/, read.deep.result.unsupported[0].detail);
  assert.equal(read.deep.unchanged, true, '拒绝时 DOM 被改了');
  assert.equal(read.deep.computed.rotate, 'none', `拒绝却写了 rotate：${read.deep.computed.rotate}`);
  assert.equal(read.deep.computed.scale, 'none', `拒绝却写了 scale：${read.deep.computed.scale}`);
  assert.equal(read.deep.result.transformed.length, 0);

  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, 's14-a3-conflict.png') }).catch(() => {});
  await handle.dispose();
  evidence.cases['S14-A3'] = {
    ok: true,
    corner: { ...read.corner, beforeSha: sha(read.corner.parentBefore), afterSha: sha(read.corner.parentAfter) },
    center: read.center,
    deep: { ...read.deep, beforeSha: sha(read.deep.before), afterSha: sha(read.deep.after) }
  };
});

/* ── A4 ─────────────────────────────────────────────────────────────────── */

test('S14-A4 同一 t 来回取值稳定；清除后回到场景当帧值', async () => {
  const handle = await host.open(SCENE);
  const page = handle.page;

  const read = await page.evaluate(async (cur) => {
    const mod = await import(cur);
    const entry = [{ at: '#card', s: 1.2, r: 15 }];
    const at = (t) => {
      const s = mod.readTransformState('#card');
      return { t, matrix: s.matrix, rotationDeg: s.rotationDeg, scaleAbs: s.scaleAbs, transform: s.transform, rotate: s.rotate, scale: s.scale };
    };

    await window.film.frame(1);
    mod.applyOverrideEntries(entry);
    const first = at(1);

    /* 播到别处、再倒回来（滚动/暂停/重播的等价动作） */
    await window.film.frame(2);
    mod.applyOverrideEntries([]);
    const cleared = at(2);
    await window.film.frame(1);
    mod.applyOverrideEntries(entry);
    const second = at(1);

    return { first, second, cleared, stable: JSON.stringify(first) === JSON.stringify(second) };
  }, url(BUNDLE_ABS));

  assert.equal(read.stable, true, `同一 t 两次读数不同：\n${JSON.stringify(read.first)}\n${JSON.stringify(read.second)}`);
  assert.equal(read.cleared.rotate, 'none', `清除后残留 rotate：${read.cleared.rotate}`);
  assert.equal(read.cleared.scale, 'none', `清除后残留 scale：${read.cleared.scale}`);
  /* t=2 场景值：translateX(80px) scale(1.4) */
  assert.match(read.cleared.transform, /matrix\(1\.4, 0, 0, 1\.4, 80, 0\)/, `清除后应回到 t=2 场景值：${read.cleared.transform}`);

  await handle.dispose();
  evidence.cases['S14-A4'] = { ok: true, ...read };
});
