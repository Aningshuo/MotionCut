// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S33-MOTION-CAPTURE 验收 A1..A5
 *
 * 命题：**取帧这条路也会把 t 交给动效实例**，所以导出与预览是同一张画面。
 *
 * A1 三条模板各 30 帧 × 2 次独立运行：逐帧 sha 全等（并给出「帧确实在变」的下限，
 *    否则「全都一样」也可能是注入没生效、模板一直停在同一相位）。
 * A2 与预览同帧：5 帧做 dp 对比（p99 ≤ 8，ADR-R8-01）+ 叠加差图。
 * A3 多实例：一页两个 clip（at 差 400ms），同 t 画面不同、各自与单独渲染一致。
 * A4 负向：t 偏 33ms 必须报差异（证明判据灵敏）。
 * A5 回归：frame-t / discover / large-scene-500 仍全绿；SceneHost 错误码集合不变。
 *
 * 运行：node --test --test-concurrency=1 packages/scene-runtime/motion-capture.test.mjs
 * （环境路径见下方 RUN_ROOT：OPENCUT_ENV_JSON 优先，否则自动建 `.local-runs/scene-runtime/motion-capture/env.json`）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { SceneHost, REPO_ROOT, SCENE_ERROR_CODES } from './host.mjs';
import { renderInstanceAt } from '../motion/instance.mjs';
import { resolveLayerTestEnv } from '../layers/test-env.mjs';

const BATCH = 'B-SUB1-R17-017';

/* 测试环境（R36-C3）
 *
 * 以前这里写死 `<repo>/.local-runs/sub1/runs/R17/env.json`：那个目录是本地产物、不入库，
 * 集成树里 `before()` 读不到 env.json 直接 ENOENT —— 5 条 hookFailed，不是功能红，
 * 是测试**不可移植**。改成和 `packages/layers/*` 同一套（`test-env.mjs`）：
 *   OPENCUT_ENV_JSON 有值 → 沿用；否则 `<repo>/.local-runs/scene-runtime/motion-capture/env.json`
 *   不存在就按 listen(0) 取空闲端口建出来，跑完证据也落在同一处。
 */
const TEST_ENV = await resolveLayerTestEnv(
  { suite: 'motion-capture', batchId: BATCH },
  { runsRoot: path.join(REPO_ROOT, '.local-runs', 'scene-runtime') }
);
const RUN_ROOT = TEST_ENV.runRoot;

/* 等待预算（R50 · S60）：**不是判据**，只是「机器忙时别把慢当成坏」。
 *
 * A1 的第一帧要跑两遍六步（SceneHost 的预热 + 交付），独占时约 1.5s、7 个邻居并行时
 * 约 2.1s；8 个测试文件 + 跨线并发时实测越过 5s（host 的 frameMs 默认），红在 `frame(0)`
 * 上。诊断见 `evidence/rounds/R50-SUB1/s60-diagnosis.json`：不是死锁、不是产品渲染变慢。
 *
 * 两处都要抬，缺一不可：
 *   - 舞台运行时的内侧预算（服务端读 `OPENCUT_FRAME_TIMEOUT_MS`，默认仍 4000）；
 *   - SceneHost 自己的 frame/ready 预算（默认 5000）。
 * 产品默认值一个字没动；像素/帧数/并发判据也没动。
 */
const WAIT_BUDGET_MS = 12000;
process.env.OPENCUT_FRAME_TIMEOUT_MS = String(WAIT_BUDGET_MS);
const EVIDENCE_DIR = TEST_ENV.evidenceDir;
const LOGS = path.join(RUN_ROOT, 'logs');
const ENV = TEST_ENV.env;

const FILMS = {
  pulse: 'tests/fixtures/scenes/motion-film-pulse.html',
  badge: 'tests/fixtures/scenes/motion-film-badge.html',
  'lower-third': 'tests/fixtures/scenes/motion-film-lower-third.html'
};
const MULTI = 'tests/fixtures/scenes/motion-film-multi.html';
const TEMPLATE = (slug) => `packages/motion/templates/${slug}/${slug}.html`;
const ROOT_SEL = '[data-role="root"]';

const FRAMES = 30;
const STEP = 0.1;

const evidence = {
  batch: BATCH,
  suite: 'motion-capture.test.mjs',
  cases: {},
  determinism: {},
  screenshots: [],
  startedAt: new Date().toISOString()
};

/** @type {SceneHost} */
let host;
/** @type {import('playwright').Page} */
let diffPage;

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const round3 = (n) => Math.round(n * 1000) / 1000;
const b64 = (u8) => Buffer.from(u8).toString('base64');
const dataUrl = (u8) => `data:image/png;base64,${b64(u8)}`;

async function save() {
  const names = ['s33-a2-diff-pulse.png', 's33-a3-multi.png', 's33-a4-bias.png'];
  const files = [];
  for (const name of names) {
    try {
      const buf = await fs.readFile(path.join(EVIDENCE_DIR, name));
      files.push({ name, bytes: buf.length, sha256: sha(buf) });
    } catch {
      files.push({ name, bytes: 0, sha256: null, missing: true });
    }
  }
  evidence.screenshots = files;
  evidence.finishedAt = new Date().toISOString();
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(path.join(EVIDENCE_DIR, 's33-motion-capture.json'), JSON.stringify(evidence, null, 2) + '\n');
}

before(async () => {
  const env = ENV;
  evidence.batch = env.batchId ?? evidence.batch;
  host = await new SceneHost({
    port: Number(env.sceneOrigin || 59375),
    viewport: { width: 1280, height: 720 },
    /* 压力预算，见文件头 WAIT_BUDGET_MS 的注释 */
    frameTimeoutMs: WAIT_BUDGET_MS,
    readyTimeoutMs: WAIT_BUDGET_MS
  }).start();
  evidence.browser = host.browserVersion;
  evidence.ports = { sceneOrigin: Number(env.sceneOrigin || 59375) };
  /* 只用来解码 PNG + 算像素差，不装受控时钟 */
  diffPage = await host.context.newPage();
  await diffPage.goto('about:blank');
});

after(async () => {
  await save();
  if (diffPage && !diffPage.isClosed()) await diffPage.close().catch(() => {});
  if (host) await host.stop();
});

/** 在页内把两张图（可各自裁剪一块）画进同尺寸画布，算 dp 差与放大差图 */
async function diffPng(a, b) {
  return diffPage.evaluate(async ({ a, b }) => {
    const load = (url) =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('decode failed'));
        img.src = url;
      });
    const [ia, ib] = await Promise.all([load(a.url), load(b.url)]);
    const ra = a.rect ?? { x: 0, y: 0, w: ia.width, h: ia.height };
    const rb = b.rect ?? { x: 0, y: 0, w: ib.width, h: ib.height };
    const w = Math.min(ra.w, rb.w);
    const h = Math.min(ra.h, rb.h);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(ia, ra.x, ra.y, w, h, 0, 0, w, h);
    const da = ctx.getImageData(0, 0, w, h).data;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(ib, rb.x, rb.y, w, h, 0, 0, w, h);
    const db = ctx.getImageData(0, 0, w, h).data;

    const diffs = new Uint8Array(w * h);
    let sum = 0;
    let max = 0;
    let changed = 0;
    for (let i = 0, p = 0; i < da.length; i += 4, p += 1) {
      const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
      diffs[p] = d;
      sum += d;
      if (d > max) max = d;
      if (d > 0) changed += 1;
    }
    const sorted = Array.from(diffs).sort((x, y) => x - y);
    const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];
    const out = ctx.createImageData(w, h);
    for (let p = 0, i = 0; p < diffs.length; p += 1, i += 4) {
      const v = Math.min(255, diffs[p] * 8);
      out.data[i] = v;
      out.data[i + 1] = v;
      out.data[i + 2] = v;
      out.data[i + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);
    return {
      width: w,
      height: h,
      mae: sum / diffs.length,
      max,
      p99,
      changed,
      total: diffs.length,
      diffUrl: canvas.toDataURL('image/png')
    };
  }, { a, b });
}

/** 差图 data url → 落盘 */
async function saveDiff(diffUrl, name) {
  const base64 = String(diffUrl).split(',')[1] ?? '';
  await fs.writeFile(path.join(EVIDENCE_DIR, name), Buffer.from(base64, 'base64'));
}

/* ── A1 30 帧 × 2 次独立运行 ─────────────────────────────────────── */

test('A1 三条模板各 30 帧 × 2 次独立取帧：逐帧 sha 全等，且帧确实在变', async () => {
  /** @type {Record<string, any>} */
  const perTemplate = {};

  for (const [slug, film] of Object.entries(FILMS)) {
    /** @type {string[][]} */
    const runs = [];
    /** @type {any[]} */
    const motionSamples = [];

    for (let run = 0; run < 2; run += 1) {
      const handle = await host.open(film);
      /** @type {string[]} */
      const shas = [];
      for (let i = 0; i < FRAMES; i += 1) {
        const frame = await host.frame(handle, { t: round3(i * STEP) });
        shas.push(frame.sha256);
        if (run === 0) motionSamples.push({ t: frame.t, motion: frame.motion });
      }
      assert.deepEqual(handle.pageErrors, [], `${slug} 帧内页面报错：${JSON.stringify(handle.pageErrors)}`);
      await handle.dispose();
      runs.push(shas);
    }

    const [run1, run2] = runs;
    const mismatches = run1.map((value, index) => (value === run2[index] ? null : index)).filter((index) => index !== null);
    assert.deepEqual(mismatches, [], `${slug} 两次独立取帧有 ${mismatches.length} 帧不同（帧号 ${mismatches.slice(0, 8).join(',')}）`);

    /* 「全等」不能是恒绿：注入没生效时模板会停在默认相位，30 帧全都一样也能通过上面那条 */
    const distinct = new Set(run1).size;
    assert.ok(distinct > 1, `${slug} 30 帧只有 1 张不同画面——注入没生效（模板停在同一相位）`);
    if (slug === 'pulse') {
      /* 1200ms 周期、100ms 步进 = 12 个相位；ease-out 在两端平台期还会把相邻帧压成同一张，
         所以「30 帧里有 8 张以上不同」就足以证明相位在跟着 t 走（恒绿时只有 1 张）。 */
      assert.ok(distinct >= 8, `pulse 30 帧只有 ${distinct} 张不同画面，注入可能没跟着 t 走`);
    } else {
      /* 入场类模板 520ms 后就是终态：前 6 帧在动、之后该稳定 */
      assert.ok(distinct >= 5, `${slug} 只有 ${distinct} 张不同画面，入场动画没被驱动`);
      const settled = run1.slice(6);
      assert.equal(new Set(settled).size, 1, `${slug} 入场结束后画面仍在变（fill 没生效或被墙钟推动）`);
    }

    /* 每帧都真的写到了实例根上 */
    for (const sample of motionSamples) {
      assert.equal(sample.motion.roots >= 1, true, `${slug} t=${sample.t} 没找到实例根`);
      assert.equal(sample.motion.written >= 1, true, `${slug} t=${sample.t} 没写入相位`);
      assert.equal(sample.motion.crossOrigin, 0, `${slug} 出现了进不去的跨源 iframe`);
      const instance = sample.motion.entries.find((entry) => entry.scope === 'instance');
      assert.ok(instance, `${slug} t=${sample.t} 没有实例根条目`);
      assert.equal(instance.ms, Math.round(sample.t * 1000), `${slug} t=${sample.t} 写进去的是 ${instance.ms}ms`);
      assert.equal(instance.at, 0);
    }

    perTemplate[slug] = { distinct, shas: run1, runs: 2, frames: FRAMES, sampleMotion: motionSamples[12] };
  }

  evidence.cases.A1 = perTemplate;
  evidence.determinism.thirtyFrames = Object.fromEntries(
    Object.entries(perTemplate).map(([slug, value]) => [slug, { distinct: value.distinct, shas: value.shas }])
  );
});

/* ── A2 与预览同帧（dp 对比） ────────────────────────────────────── */

test('A2 与预览同帧：5 帧 dp 对比 p99 ≤ 8（ADR-R8-01）+ 叠加差图', async () => {
  const SLUG = 'pulse';
  const TIMES = [0, 0.7, 1.4, 2.1, 2.9];

  /** @type {any[]} */
  const rows = [];
  let worstP99 = 0;

  const filmHandle = await host.open(FILMS[SLUG]);
  const previewHandle = await host.open(TEMPLATE(SLUG));
  const previewPage = previewHandle.page;

  for (const t of TIMES) {
    const captured = await host.frame(filmHandle, { t });
    await renderInstanceAt(previewPage, { selector: ROOT_SEL, tMs: Math.round(t * 1000) });
    await previewPage.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined))))
    );
    const previewPng = await previewPage.screenshot({ type: 'png' });

    const diff = await diffPng({ url: dataUrl(captured.png) }, { url: dataUrl(previewPng) });
    rows.push({
      t,
      captureSha: captured.sha256.slice(0, 16),
      previewSha: sha(previewPng).slice(0, 16),
      identical: captured.sha256 === sha(previewPng),
      mae: round3(diff.mae),
      max: diff.max,
      p99: diff.p99,
      changedPixels: diff.changed,
      size: [diff.width, diff.height]
    });
    worstP99 = Math.max(worstP99, diff.p99);
    assert.equal(diff.width, 1280);
    assert.equal(diff.height, 720);
    assert.ok(diff.p99 <= 8, `t=${t} 与预览差 p99=${diff.p99} > 8（MAE ${round3(diff.mae)}、max ${diff.max}）`);

    if (t === 1.4) {
      await saveDiff(diff.diffUrl, 's33-a2-diff-pulse.png');
      await fs.writeFile(path.join(EVIDENCE_DIR, 's33-a2-capture-t1400.png'), Buffer.from(captured.png));
      await fs.writeFile(path.join(EVIDENCE_DIR, 's33-a2-preview-t1400.png'), previewPng);
    }
  }

  await filmHandle.dispose();
  await previewHandle.dispose();

  const exact = rows.every((row) => row.identical);
  evidence.cases.A2 = { slug: SLUG, times: TIMES, rows, worstP99, byteIdentical: exact };
});

/* ── A3 多实例：at 差 400ms ──────────────────────────────────────── */

test('A3 一页两个实例（at 差 400ms）：同 t 画面不同，各自与单独渲染一致', async () => {
  const T = 1.0;
  const multi = await host.open(MULTI);
  const frame = await host.frame(multi, { t: T });

  const a = frame.motion.entries.find((entry) => entry.id === 'clip-pulse-a');
  const b = frame.motion.entries.find((entry) => entry.id === 'clip-pulse-b');
  assert.ok(a && b, `多实例条目缺失：${JSON.stringify(frame.motion.entries)}`);
  assert.equal(a.at, 0);
  assert.equal(b.at, 0.4);
  assert.equal(a.ms, 1000, `左实例相位应为 1000ms，实际 ${a.ms}`);
  assert.equal(b.ms, 600, `右实例相位应为 600ms，实际 ${b.ms}`);

  /* 同一张图里左右两块必须不同（差 400ms 相位） */
  const lr = await diffPng(
    { url: dataUrl(frame.png), rect: { x: 0, y: 0, w: 640, h: 720 } },
    { url: dataUrl(frame.png), rect: { x: 640, y: 0, w: 640, h: 720 } }
  );
  assert.ok(lr.changed > 0, '左右两个实例画面完全相同——at 没生效');

  /* 各自与「单独渲染」一致：把模板放进 640×720 的视口，按本地相位截图 */
  const preview = await host.open(TEMPLATE('pulse'));
  await preview.page.setViewportSize({ width: 640, height: 720 });
  const shotAt = async (ms) => {
    await renderInstanceAt(preview.page, { selector: ROOT_SEL, tMs: ms });
    await preview.page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined))))
    );
    return preview.page.screenshot({ type: 'png' });
  };
  const leftRef = await shotAt(1000);
  const rightRef = await shotAt(600);

  const leftDiff = await diffPng({ url: dataUrl(frame.png), rect: { x: 0, y: 0, w: 640, h: 720 } }, { url: dataUrl(leftRef) });
  const rightDiff = await diffPng({ url: dataUrl(frame.png), rect: { x: 640, y: 0, w: 640, h: 720 } }, { url: dataUrl(rightRef) });

  assert.ok(leftDiff.p99 <= 8, `左实例与单独渲染差 p99=${leftDiff.p99}`);
  assert.ok(rightDiff.p99 <= 8, `右实例与单独渲染差 p99=${rightDiff.p99}`);
  assert.equal(leftDiff.width, 640);

  await fs.writeFile(path.join(EVIDENCE_DIR, 's33-a3-multi.png'), Buffer.from(frame.png));
  await multi.dispose();
  await preview.dispose();

  evidence.cases.A3 = {
    t: T,
    entries: frame.motion.entries,
    leftRightDiff: { p99: lr.p99, max: lr.max, changed: lr.changed },
    leftVsSolo: { p99: leftDiff.p99, max: leftDiff.max, mae: round3(leftDiff.mae) },
    rightVsSolo: { p99: rightDiff.p99, max: rightDiff.max, mae: round3(rightDiff.mae) }
  };
});

/* ── A4 负向：偏 33ms 必须报差异 ────────────────────────────────── */

test('A4 负向对照：t 偏 33ms 判据必须报差异', async () => {
  const handle = await host.open(FILMS.pulse);
  const base = await host.frame(handle, { t: 1.0 });
  const biased = await host.frame(handle, { t: 1.033 });
  const repeat = await host.frame(handle, { t: 1.0 });

  assert.equal(repeat.sha256, base.sha256, '同 t 重复取帧不稳定，后面的比较都不成立');
  assert.notEqual(biased.sha256, base.sha256, 't 偏 33ms 取帧结果完全相同——注入没跟着 t 走');

  const diff = await diffPng({ url: dataUrl(base.png) }, { url: dataUrl(biased.png) });
  assert.ok(diff.changed > 0, `偏 33ms 后一个像素都没变（max ${diff.max}）`);
  await saveDiff(diff.diffUrl, 's33-a4-bias.png');

  /* 与预览侧同口径：预览 1000ms 对预览 1033ms 也必须差 */
  const preview = await host.open(TEMPLATE('pulse'));
  const shot = async (ms) => {
    await renderInstanceAt(preview.page, { selector: ROOT_SEL, tMs: ms });
    await preview.page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined))))
    );
    return preview.page.screenshot({ type: 'png' });
  };
  const p1000 = await shot(1000);
  const p1033 = await shot(1033);
  const previewDiff = await diffPng({ url: dataUrl(p1000) }, { url: dataUrl(p1033) });
  assert.ok(previewDiff.changed > 0, '预览侧偏 33ms 也测不出差异，判据不可用');

  await handle.dispose();
  await preview.dispose();

  evidence.cases.A4 = {
    baseSha: base.sha256.slice(0, 16),
    biasedSha: biased.sha256.slice(0, 16),
    repeatedSha: repeat.sha256.slice(0, 16),
    diff: { p99: diff.p99, max: diff.max, changed: diff.changed, total: diff.total },
    previewDiff: { p99: previewDiff.p99, max: previewDiff.max, changed: previewDiff.changed }
  };
});

/* ── A5 回归 + 错误码集合 ───────────────────────────────────────── */

test('A5 回归：frame-t / discover / large-scene-500 全绿；错误码集合不变', async () => {
  assert.deepEqual(
    [...SCENE_ERROR_CODES],
    ['NO_FILM', 'READY_TIMEOUT', 'RESOURCE_FAILED', 'FRAME_THREW', 'FRAME_TIMEOUT', 'VIDEO_NOT_SHOWN', 'CANCELLED'],
    '错误码集合变了'
  );

  const files = [
    'packages/motion/frame-t.test.mjs',
    'packages/motion/discover.test.mjs',
    'packages/layers/large-scene-500.test.mjs'
  ];
  const logPath = path.join(LOGS, 's33-a5-regress.txt');
  const childEnv = { ...process.env, OPENCUT_ENV_JSON: process.env.OPENCUT_ENV_JSON ?? path.join(RUN_ROOT, 'env.json') };
  delete childEnv.NODE_TEST_CONTEXT;

  /* 取帧结果里带着 motion 统计，且没有多出错误码 */
  const handle = await host.open(FILMS.pulse);
  const frame = await host.frame(handle, { t: 0.4 });
  assert.equal(typeof frame.motion, 'object');
  assert.equal(SCENE_ERROR_CODES.includes('MOTION'), false);
  await handle.dispose();

  /* 全局浏览器槽（ADR-R36-01）一次只放一个浏览器：下面要起子进程跑三个测试文件，
     它们各自在**自己的进程里**申请同一个槽。父进程的 Host 不先停掉，子进程会一直排队，
     直到 15 分钟取槽超时（runner 的 per-file 超时也会到点）。先停再跑，峰值始终 1 个 Chromium。 */
  await host.stop();

  const result = await new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--test', '--test-concurrency=1', ...files],
      { cwd: REPO_ROOT, env: childEnv, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) })
    );
  });
  await fs.mkdir(LOGS, { recursive: true });
  await fs.writeFile(logPath, result.stdout + result.stderr);
  const pass = (result.stdout.match(/^# pass (\d+)$/m) ?? [])[1] ?? '0';
  const fail = (result.stdout.match(/^# fail (\d+)$/m) ?? [])[1] ?? '?';

  evidence.cases.A5 = { code: result.code, pass: Number(pass), fail: Number(fail), files, log: 's33-a5-regress.txt', errorCodes: [...SCENE_ERROR_CODES] };
  assert.equal(result.code, 0, `回归失败（见 ${logPath}）\n${result.stdout.slice(-3000)}`);
  assert.equal(Number(fail), 0);
});
