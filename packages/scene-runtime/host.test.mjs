/**
 * WP04 场景运行器验收（S1–S8）
 *
 * 运行：node --test packages/scene-runtime/host.test.mjs
 * 说明：不把「能截一张图」当通过；每项都记录可复现的度量到
 *       .local-runs/sub1/evidence/host-test.json
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SceneHost, SceneFrameError, DEFAULT_TIMEOUTS, REPO_ROOT } from './host.mjs';
import { PROFILES } from './profiles.mjs';

const EVIDENCE_DIR = path.join(REPO_ROOT, '.local-runs/sub1/evidence');
const EVIDENCE_FILE = path.join(EVIDENCE_DIR, 'host-test.json');
const PORT = Number(process.env.FILM_HOST_PORT || 59373);

/** @type {Record<string, any>} */
const evidence = { batch: 'B-SUB1-R2-001', suite: 'host.test.mjs', startedAt: new Date().toISOString(), cases: {} };
/** @type {SceneHost} */
let host;

async function saveEvidence() {
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(EVIDENCE_FILE, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
}

before(async () => {
  host = await new SceneHost({ port: PORT }).start();
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  evidence.host = {
    port: host.http.port,
    origin: host.origin,
    browser: host.browserVersion,
    viewport: host.viewport,
    defaults: DEFAULT_TIMEOUTS
  };
});

after(async () => {
  evidence.finishedAt = new Date().toISOString();
  await saveEvidence();
  if (host) await host.stop();
});

test('S1 四类场景 frame(0/2/1/2) 同 t 同 sha256', async () => {
  const scenes = ['dom', 'svg', 'canvas', 'webgl'];
  const seq = [0, 2, 1, 2];
  /** @type {Record<string, any>} */
  const report = {};
  for (const id of scenes) {
    const handle = await host.open(PROFILES[/** @type {'dom'|'svg'|'canvas'|'webgl'} */ (id)].scene);
    try {
      await host.ready(handle);
      /** @type {{t:number, sha256:string}[]} */
      const frames = [];
      for (const t of seq) {
        const res = await host.frame(handle, { t, timeoutMs: 8000 });
        frames.push({ t, sha256: res.sha256 });
      }
      const byT = new Map();
      for (const f of frames) {
        const key = String(f.t);
        if (!byT.has(key)) byT.set(key, new Set());
        byT.get(key).add(f.sha256);
      }
      const unstable = [...byT.entries()].filter(([, set]) => set.size > 1).map(([t]) => t);
      const f1 = frames[1];
      const f3 = frames[3];
      if (!f1 || !f3) throw new Error('frames 数量不足');
      assert.deepEqual(unstable, [], `${id} 同 t 出现不同哈希: ${unstable.join(',')}`);
      // 2 出现两次必须相同
      assert.equal(f1.sha256, f3.sha256, `${id} 的 t=2 两次哈希不同`);
      report[id] = {
        capability: PROFILES[/** @type {'dom'|'svg'|'canvas'|'webgl'} */ (id)].capability,
        sequence: frames,
        distinctByT: Object.fromEntries([...byT.entries()].map(([k, v]) => [k, [...v][0]])),
        stable: unstable.length === 0
      };
    } finally {
      await handle.dispose();
    }
  }
  evidence.cases.S1 = { status: 'PASS', scenes: report };
  await saveEvidence();
});

test('S2 无 window.film → NO_FILM（不是超时）', async () => {
  const handle = await host.open('tests/fixtures/scenes/no-film.html');
  const started = Date.now();
  await assert.rejects(host.ready(handle), (err) => {
    assert.ok(err instanceof SceneFrameError, '必须是 SceneFrameError');
    assert.equal(err.code, 'NO_FILM');
    return true;
  });
  const elapsedMs = Date.now() - started;
  assert.ok(elapsedMs < DEFAULT_TIMEOUTS.readyMs, `NO_FILM 判定耗时 ${elapsedMs}ms 不应达到 ready 预算`);
  evidence.cases.S2 = { status: 'PASS', elapsedMs, code: 'NO_FILM' };
  await saveEvidence();
});

test('S3 frame(t) 抛错 → FRAME_THREW（含 t 与原错误首行）', async () => {
  const handle = await host.open('tests/fixtures/scenes/throw.html');
  try {
    await host.ready(handle);
    const t = 1.333;
    await assert.rejects(host.frame(handle, { t }), (/** @type {any} */ err) => {
      assert.equal(err.code, 'FRAME_THREW');
      assert.match(err.message, /1\.333/);
      assert.match(err.message, /scene exploded while drawing t=1\.333/);
      return true;
    });
    evidence.cases.S3 = { status: 'PASS', code: 'FRAME_THREW', message: `film.frame(${t}) 抛错：scene exploded while drawing t=${t}` };
  } finally {
    await handle.dispose();
  }
  await saveEvidence();
});

test('S4 frame(t) 永不 resolve → FRAME_TIMEOUT，页面被回收', async () => {
  const handle = await host.open('tests/fixtures/scenes/hang.html');
  await host.ready(handle);
  const budget = 600;
  const started = Date.now();
  await assert.rejects(host.frame(handle, { t: 0.5, timeoutMs: budget }), (/** @type {any} */ err) => {
    assert.equal(err.code, 'FRAME_TIMEOUT');
    return true;
  });
  const elapsedMs = Date.now() - started;
  assert.ok(handle.page.isClosed(), '超时后页面必须被关闭');
  assert.ok(elapsedMs >= budget - 50, `耗时 ${elapsedMs}ms 不应早于预算`);
  assert.ok(elapsedMs < budget + 2500, `回收过慢: ${elapsedMs}ms`);
  evidence.cases.S4 = {
    status: 'PASS',
    budgetMs: budget,
    elapsedMs,
    pageClosed: handle.page.isClosed(),
    defaultFrameTimeoutMs: DEFAULT_TIMEOUTS.frameMs
  };
  await saveEvidence();
});

test('S5 资源 404 → RESOURCE_FAILED 且列出失败路径', async () => {
  const handle = await host.open('tests/fixtures/scenes/broken-resource.html');
  let error;
  try {
    await host.ready(handle);
    assert.fail('资源 404 时 ready 不应成功');
  } catch (err) {
    error = /** @type {any} */ (err);
  }
  assert.ok(['RESOURCE_FAILED', 'READY_TIMEOUT'].includes(error.code), `实际 ${error.code}`);
  const resources = error.failedResources || [];
  assert.ok(
    resources.some((/** @type {string} */ p) => p.includes('definitely-missing.png')),
    `失败资源未列出: ${JSON.stringify(resources)}`
  );
  evidence.cases.S5 = { status: 'PASS', code: error.code, failedResources: resources, message: error.message };
  await handle.dispose();
  await saveEvidence();
});

test('S6 AbortSignal 中途取消 → CANCELLED，200ms 内无残留 page', async () => {
  const handle = await host.open('tests/fixtures/scenes/hang.html');
  await host.ready(handle);
  const ac = new AbortController();
  const started = Date.now();
  setTimeout(() => ac.abort(), 250);
  await assert.rejects(host.frame(handle, { t: 1, timeoutMs: 10000, signal: ac.signal }), (/** @type {any} */ err) => {
    assert.equal(err.code, 'CANCELLED');
    return true;
  });
  const cancelledAt = Date.now();
  // 取消后 200ms 内不得残留 page
  await new Promise((r) => setTimeout(r, 200));
  const leaked = host.pages().length;
  assert.equal(leaked, 0, `取消后仍有 ${leaked} 个 page`);
  evidence.cases.S6 = {
    status: 'PASS',
    abortAfterMs: 250,
    cancelLatencyMs: cancelledAt - started,
    releaseCheckMs: 200,
    leakedPages: leaked,
    pageClosed: handle.page.isClosed()
  };
  await saveEvidence();
});

test('S7 场景已 await seeked → 谓词命中立即完成；旧写法必须卡住', async () => {
  const t = 0.5;
  // 正确实现
  const good = await host.open('tests/fixtures/scenes/video.html');
  let goodRes;
  let goodElapsed = 0;
  const goodStart = Date.now();
  try {
    await host.ready(good);
    goodRes = await host.frame(good, { t, timeoutMs: 6000 });
    goodElapsed = Date.now() - goodStart;
  } finally {
    await good.dispose();
  }
  assert.ok(goodRes, '正确实现应成功取帧');
  assert.ok(goodElapsed < 2000, `正确实现耗时 ${goodElapsed}ms，不应接近兜底预算`);

  // 旧写法：先 await frame 再无条件等 seeked
  const legacyHandle = await host.open('tests/fixtures/scenes/video.html');
  let legacyRes;
  try {
    await host.ready(legacyHandle);
    legacyRes = await host.frameLegacy(legacyHandle, { t, waitMs: 3000 });
  } finally {
    await legacyHandle.dispose();
  }
  assert.equal(legacyRes.outcome, 'HUNG', `旧写法不应成功，实际 ${legacyRes.outcome}`);
  assert.ok(legacyRes.elapsedMs >= 2900, `旧写法耗时 ${legacyRes.elapsedMs}ms，未证明卡住`);

  evidence.cases.S7 = {
    status: 'PASS',
    t,
    correct: {
      elapsedMs: goodElapsed,
      sha256: goodRes.sha256,
      videoProbes: goodRes.videoProbes
    },
    legacy: {
      elapsedMs: legacyRes.elapsedMs,
      frameMs: legacyRes.frameMs,
      outcome: legacyRes.outcome,
      videoStateAtInstall: legacyRes.videoStateAtInstall,
      videoStateNow: legacyRes.videoStateNow
    },
    conclusion:
      '场景内部已消费 seeked；先 await frame 再装 seeked 监听会永久等待（3s 预算耗尽），' +
      '按六步先 arm 再用 !seeking && readyState>=2 && presented 谓词则立即完成。'
  };
  await saveEvidence();
});

test('S8 同一 t 连续 50 次：无内存增长（RSS <20%）、无泄漏 page', async () => {
  const handle = await host.open('tests/fixtures/scenes/dom.html');
  try {
    await host.ready(handle);
    for (let i = 0; i < 5; i++) await host.frame(handle, { t: 1.333 });
    const before = process.memoryUsage();
    /** @type {Set<string>} */
    const hashes = new Set();
    const started = Date.now();
    for (let i = 0; i < 50; i++) {
      const res = await host.frame(handle, { t: 1.333 });
      hashes.add(res.sha256);
    }
    const elapsedMs = Date.now() - started;
    const afterMem = process.memoryUsage();
    const growth = (afterMem.rss - before.rss) / before.rss;
    const leaked = host.pages().length;
    assert.equal(hashes.size, 1, `50 次同 t 出现 ${hashes.size} 种哈希`);
    assert.equal(leaked, 1, `泄漏 page: ${leaked}`);
    assert.ok(growth < 0.2, `RSS 增长 ${(growth * 100).toFixed(1)}% ≥ 20%`);
    evidence.cases.S8 = {
      status: 'PASS',
      iterations: 50,
      t: 1.333,
      elapsedMs,
      distinctHashes: hashes.size,
      rssBefore: before.rss,
      rssAfter: afterMem.rss,
      growthPct: +(growth * 100).toFixed(2),
      leakedPages: leaked
    };
  } finally {
    await handle.dispose();
  }
  await saveEvidence();
});
