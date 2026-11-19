// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S31-MOTION-FRAME-T 验收 A1..A4
 *
 * 核心命题：**模板画面是 `--motion-t` 的唯一函数**。
 *
 * A1 静态闸门：`wall-clock-check.mjs` 扫 `packages/motion/templates/**` 必须 0 命中
 *    （并且给出「改之前能抓到 pulse.css:34」的对照，证明它不是永远绿的摆设）。
 * A2 三条模板各给三组数字：同 t 两跑 sha / t 与 t+period / 停留 2 秒不变；
 *    外加**负向对照**：R15 的墙钟写法在同一测法下必须红。
 * A3 30 帧 @ t=0,0.1,…,2.9 两次渲染（两个独立文档）逐帧 sha 全等。
 * A4 回归：面板仍能列 3 条、应用参数仍生效。
 *
 * 运行：node --test --test-concurrency=1 packages/motion/frame-t.test.mjs
 * （环境路径见 RUN_ROOT：OPENCUT_ENV_JSON 优先，否则自动建 .local-runs/layers/motion-frame-t/env.json）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { build as esbuild } from 'esbuild';
import { SceneHost, REPO_ROOT } from '../scene-runtime/host.mjs';
import { resolveLayerTestEnv } from '../layers/test-env.mjs';
import { installSeedLibrary } from './seed.mjs';
import { listEntries, readLibrary } from './library.mjs';
import { MOTION_TIME_VAR, renderInstanceAt } from './instance.mjs';
import { scanSource, scanTemplates, WALL_CLOCK_RULES } from './wall-clock-check.mjs';

/* S57：环境可移植（R37-C5）。OPENCUT_ENV_JSON 优先；否则现建 `.local-runs/layers/motion-frame-t/env.json`。 */
const TEST_ENV = await resolveLayerTestEnv({ suite: 'motion-frame-t' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');
const PROJECTS = path.join(RUN_ROOT, 'projects');
const BUNDLE_ABS = path.join(RUN_ROOT, 'tmp/s31/bundle.js');
const BUNDLE_URL = '/' + path.relative(REPO_ROOT, BUNDLE_ABS).split(path.sep).join('/');
const PANEL_FIXTURE = 'tests/fixtures/scenes/motion-panel-stage.html';
const CONTROL = 'tests/fixtures/scenes/wall-clock-control.html';
const TEMPLATES_DIR = 'packages/motion/templates';
const ROOT_SEL = '[data-role="root"]';
const BATCH = 'B-SUB1-R16-016';

/**
 * 三条模板的判据参数。
 * - `loop`：`t` 与 `t+period` 同相，`t=0` 与 `t=period` 同相；
 * - `one-shot`：入场只播一次（fill both），`t>=period` 全落终态，所以「周期性」等价于
 *   「settle 之后任意 t 全等」；`t=0` 与 `t=period` 本来就该不同（起点≠终点），如实标注。
 */
const TEMPLATES = [
  { slug: 'pulse', mode: 'loop', periodMs: 1200, probe: '.pulse-core', midA: 200, midB: 800 },
  { slug: 'badge', mode: 'one-shot', periodMs: 520, probe: '.badge-mark', midA: 130, midB: 390 },
  { slug: 'lower-third', mode: 'one-shot', periodMs: 520, probe: '.lt-bar', midA: 130, midB: 390 }
];

const evidence = {
  batch: BATCH,
  suite: 'frame-t.test.mjs',
  cases: {},
  determinism: {},
  screenshots: [],
  startedAt: new Date().toISOString()
};

/** @type {SceneHost} */
let host;

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha12 = (buf) => sha(buf).slice(0, 12);
const round2 = (n) => Math.round(n * 100) / 100;

async function buildBundle() {
  await fs.mkdir(path.dirname(BUNDLE_ABS), { recursive: true });
  await esbuild({
    stdin: {
      contents: ["export { mountMotionPanel } from './packages/motion/panel.mjs';"].join('\n'),
      resolveDir: REPO_ROOT,
      loader: 'js'
    },
    bundle: true,
    format: 'iife',
    globalName: 'R31',
    platform: 'browser',
    target: 'es2022',
    outfile: BUNDLE_ABS,
    logLevel: 'silent'
  });
}

async function save() {
  const names = ['s31-a4-panel.png', 's31-a2-pulse-t0.png', 's31-a2-pulse-t600.png'];
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
  await fs.writeFile(path.join(EVIDENCE_DIR, 's31-frame-t.json'), JSON.stringify(evidence, null, 2) + '\n');
}

before(async () => {
  const env = JSON.parse(await fs.readFile(path.join(RUN_ROOT, 'env.json'), 'utf8'));
  evidence.batch = env.batchId ?? evidence.batch;
  await buildBundle();
  host = await new SceneHost({ port: Number(env.sceneOrigin || env.studioPort), viewport: { width: 1280, height: 720 } }).start();
  evidence.browser = host.browserVersion;
});

after(async () => {
  await save();
  if (host) await host.stop();
});

/** 双 rAF：等样式重算 + 合成一帧（SceneHost 的 rAF 仍是真 rAF） */
async function settle(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined)))));
}

async function openDoc(rel) {
  const handle = await host.open(rel);
  const pageErrors = [];
  handle.page.on('pageerror', (error) => pageErrors.push(String(error)));
  return { handle, page: handle.page, pageErrors };
}

/** 定格到 t 并截一张，返回 sha */
async function frameAt(page, tMs) {
  await renderInstanceAt(page, { selector: ROOT_SEL, tMs });
  await settle(page);
  return sha12(await page.screenshot());
}

/* ── A1 静态闸门：0 命中 + 反向对照 ──────────────────────────────── */

test('A1 墙钟静态检查：templates 0 命中；同一检查器能抓到 R15 的墙钟写法', async () => {
  const scan = await scanTemplates(path.join(REPO_ROOT, TEMPLATES_DIR));
  assert.deepEqual(scan.hits, [], `模板里仍有墙钟：${JSON.stringify(scan.hits, null, 1)}`);
  assert.equal(scan.ok, true);
  assert.equal(scan.files.length, 9, `模板文件数应为 9（3 html + 3 css + 3 svg），实际 ${scan.files.length}`);

  /* 每条模板都读 --motion-t（跟着 link 的样式表一起看） */
  const perTemplate = {};
  for (const info of scan.infos) {
    const slug = info.file.split('/')[1];
    perTemplate[slug] = info;
    assert.equal(info.timeVar, true, `${info.file} 没读 ${MOTION_TIME_VAR}`);
    assert.ok(info.animations > 0, `${info.file} 一条动画都没有，可能改漏了`);
  }
  assert.deepEqual(Object.keys(perTemplate).sort(), ['badge', 'lower-third', 'pulse']);

  /* 负向对照：把 R15 的写法喂给同一个检查器，必须命中 INFINITE_LOOP */
  const control = await fs.readFile(path.join(REPO_ROOT, CONTROL), 'utf8');
  const controlHits = scanSource(control, { file: 'wall-clock-control.html' });
  assert.equal(controlHits.some((hit) => hit.rule === WALL_CLOCK_RULES.INFINITE_LOOP), true, '检查器抓不到对照组里的墙钟循环');

  /* CLI 原文（交接里贴的就是这一段） */
  const cli = await new Promise((resolve) => {
    execFile(process.execPath, ['packages/motion/wall-clock-check.mjs'], { cwd: REPO_ROOT }, (error, stdout, stderr) =>
      resolve({ code: error ? Number(error.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) })
    );
  });
  assert.equal(cli.code, 0, `CLI 退出码 ${cli.code}\n${cli.stderr}`);
  assert.match(cli.stdout, /命中 0 条/);

  evidence.cases.A1 = {
    files: scan.files,
    hits: scan.hits,
    infos: scan.infos,
    controlHits: controlHits.map(({ rule, file, line, detail }) => ({ rule, file, line, detail })),
    cli: { code: cli.code, lines: cli.stdout.trim().split('\n') }
  };
});

/* ── A2 三条模板的确定性数字 + 负向对照 ──────────────────────────── */

test('A2 三条模板：同 t 两跑 / t 与 t+period / 停留 2 秒 —— 逐像素相同', async () => {
  /** @type {Record<string, any>} */
  const perTemplate = {};

  for (const tpl of TEMPLATES) {
    const { handle, page, pageErrors } = await openDoc(`${TEMPLATES_DIR}/${tpl.slug}/${tpl.slug}.html`);

    /* 机制自检：动画确实停在 paused，且 delay 跟着 --motion-t 走 */
    const base = tpl.mode === 'loop' ? 500 : tpl.midA;
    await renderInstanceAt(page, { selector: ROOT_SEL, tMs: base });
    await settle(page);
    const mechanism = await page.evaluate((probe) => {
      const el = document.querySelector(probe);
      const root = document.querySelector('[data-role="root"]');
      const cs = getComputedStyle(el);
      return {
        playState: cs.animationPlayState,
        animationDelay: cs.animationDelay,
        timeVar: root.style.getPropertyValue('--motion-t'),
        dataT: root.getAttribute('data-motion-t')
      };
    }, tpl.probe);
    assert.equal(mechanism.playState, 'paused', `${tpl.slug} 的动画没暂停`);
    assert.match(mechanism.animationDelay, /^-?[\d.]+s$/, `${tpl.slug} 的 animation-delay 不是时间值：${mechanism.animationDelay}`);
    assert.equal(mechanism.timeVar, String(base), `${tpl.slug} 的 ${MOTION_TIME_VAR} 没写进去`);
    assert.equal(mechanism.dataT, String(base));

    /* ① 同一 t 连续截两次（中间不重置页面、不重新加载） */
    const firstShot = await frameAt(page, base);
    const secondShot = await frameAt(page, base);
    assert.equal(secondShot, firstShot, `${tpl.slug} 同一 t 两次截图不同：${firstShot} vs ${secondShot}`);

    /* ② 停 2 秒再截（墙钟写法会在这里跑掉相位） */
    await page.waitForTimeout(2000);
    const afterHold = sha12(await page.screenshot());
    assert.equal(afterHold, firstShot, `${tpl.slug} 画面在 2 秒里自己动了（墙钟推进），${firstShot} → ${afterHold}`);

    /** @type {Record<string, any>} */
    const row = { mode: tpl.mode, periodMs: tpl.periodMs, baseMs: base, sameT: { a: firstShot, b: secondShot }, hold2s: { before: firstShot, after: afterHold } };

    if (tpl.mode === 'loop') {
      /* ③ t 与 t+period 同相；t=0 与 t=period 同相 */
      const plus = await frameAt(page, base + tpl.periodMs);
      assert.equal(plus, firstShot, `${tpl.slug} t=${base} 与 t=${base + tpl.periodMs} 不同相：${firstShot} vs ${plus}`);
      const zero = await frameAt(page, 0);
      const period = await frameAt(page, tpl.periodMs);
      assert.equal(period, zero, `${tpl.slug} t=0 与 t=${tpl.periodMs} 不同：${zero} vs ${period}`);
      row.tPlusPeriod = { t: base, tPlusPeriod: base + tpl.periodMs, sha: firstShot, match: true };
      row.zeroVsPeriod = { t0: zero, tPeriod: period, match: true };
      /* ④ 相位真的在变（否则「全都一样」也能通过上面三条） */
      const midA = await frameAt(page, tpl.midA);
      const midB = await frameAt(page, tpl.midB);
      assert.notEqual(midA, midB, `${tpl.slug} 不同 t 画面完全相同，动画没生效`);
      row.midFrames = { [tpl.midA]: midA, [tpl.midB]: midB, distinct: true };
      if (tpl.slug === 'pulse') {
        await renderInstanceAt(page, { selector: ROOT_SEL, tMs: 0 });
        await settle(page);
        await page.screenshot({ path: path.join(EVIDENCE_DIR, 's31-a2-pulse-t0.png') });
        await renderInstanceAt(page, { selector: ROOT_SEL, tMs: 600 });
        await settle(page);
        await page.screenshot({ path: path.join(EVIDENCE_DIR, 's31-a2-pulse-t600.png') });
      }
    } else {
      /* 入场类：settle 之后任意 t 全等；起点与终态必须不同 */
      const settled = await frameAt(page, tpl.periodMs);
      const settledMore = await frameAt(page, tpl.periodMs * 2);
      const settledMuch = await frameAt(page, tpl.periodMs + 5000);
      assert.equal(settledMore, settled, `${tpl.slug} settle 后 t=${tpl.periodMs * 2} 与 t=${tpl.periodMs} 不同`);
      assert.equal(settledMuch, settled, `${tpl.slug} settle 后 t=${tpl.periodMs + 5000} 不稳定`);
      const start = await frameAt(page, 0);
      assert.notEqual(start, settled, `${tpl.slug} 入场起点与终态相同，动画没生效`);
      row.tPlusPeriod = {
        applicable: false,
        reason: '入场类只播一次（1 次迭代 + fill both），没有周期；等价判据是 settle 之后任意 t 全等',
        settledAt: [tpl.periodMs, tpl.periodMs * 2, tpl.periodMs + 5000],
        sha: settled,
        match: true
      };
      const midA = await frameAt(page, tpl.midA);
      const midB = await frameAt(page, tpl.midB);
      assert.notEqual(midA, midB, `${tpl.slug} 动画中段两个 t 画面相同`);
      row.zeroVsPeriod = { notApplicable: true, reason: '入场类起点≠终点（这正是入场该有的样子）', start, settled, differ: true };
      row.midFrames = { [tpl.midA]: midA, [tpl.midB]: midB, distinct: true };
    }

    assert.deepEqual(pageErrors, [], `${tpl.slug} 页面报错：${pageErrors.join(' | ')}`);
    await handle.dispose();
    perTemplate[tpl.slug] = { ...row, mechanism };
  }

  /* 负向对照：同一测法用在墙钟写法上必须红 */
  const control = await openDoc(CONTROL);
  const controlA = sha12(await control.page.screenshot());
  await control.page.waitForTimeout(700);
  const controlB = sha12(await control.page.screenshot());
  assert.notEqual(controlA, controlB, '对照组（未暂停的 infinite 动画）在 0.7 秒里竟然没变——判据测不到墙钟');
  await control.handle.dispose();
  evidence.cases.A2 = {
    templates: perTemplate,
    negativeControl: { file: CONTROL, first: controlA, after700ms: controlB, drifted: true }
  };
  evidence.determinism.byTemplate = perTemplate;
});

/* ── A3 30 帧两次渲染 ────────────────────────────────────────────── */

test('A3 30 帧 @0,0.1,…,2.9：两次独立渲染逐帧 sha 全等', async () => {
  const FRAMES = 30;
  const STEP_MS = 100;
  /** @type {Record<string, {run1: string[], run2: string[], identical: boolean, aggregate: string, aggregateRun1: string}>} */
  const perTemplate = {};

  for (const tpl of TEMPLATES) {
    /** @type {string[][]} */
    const runs = [];
    for (let run = 0; run < 2; run += 1) {
      const { handle, page, pageErrors } = await openDoc(`${TEMPLATES_DIR}/${tpl.slug}/${tpl.slug}.html`);
      /** @type {string[]} */
      const shas = [];
      for (let i = 0; i < FRAMES; i += 1) {
        shas.push(await frameAt(page, i * STEP_MS));
      }
      assert.deepEqual(pageErrors, []);
      await handle.dispose();
      runs.push(shas);
    }
    const [run1, run2] = runs;
    const identical = run1.every((value, index) => value === run2[index]);
    const mismatches = run1.map((value, index) => (value === run2[index] ? null : index)).filter((index) => index !== null);
    assert.equal(identical, true, `${tpl.slug} 两次渲染有 ${mismatches.length} 帧不同（帧号 ${mismatches.slice(0, 8).join(',')}）`);
    const aggregate = sha(Buffer.from(run1.join(''), 'utf8'));
    perTemplate[tpl.slug] = { run1, run2, identical, aggregate, aggregateRun1: sha(Buffer.from(run2.join(''), 'utf8')) };
    assert.equal(perTemplate[tpl.slug].aggregateRun1, aggregate);
  }

  evidence.cases.A3 = { frames: FRAMES, stepMs: STEP_MS, templates: perTemplate };
  evidence.determinism.thirtyFrames = perTemplate;
});

/* ── A4 回归：面板 3 条 + 参数仍生效 ─────────────────────────────── */

test('A4 回归：面板仍列 3 条、应用参数仍生效（截图 1 张）', async () => {
  const root = path.join(PROJECTS, `frame-t-a4-${process.pid}`);
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  const seeded = await installSeedLibrary(root);
  assert.equal(seeded.ok, true, JSON.stringify(seeded));

  const { library } = await readLibrary(root);
  const statuses = await listEntries(root, library);
  const views = statuses.map(({ entry, status, missingAssets }) => ({
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    sourceOk: status !== 'source-missing',
    assetIssues: missingAssets.map((asset) => ({ path: asset.path, reason: '资源不存在' })),
    params: Object.entries(entry.params ?? {}).map(([name, spec]) => {
      const view = { name, label: spec.label ?? name, type: spec.type };
      if (spec.default !== undefined) view.default = spec.default;
      if (typeof spec.min === 'number') view.min = spec.min;
      if (typeof spec.max === 'number') view.max = spec.max;
      if (typeof spec.step === 'number') view.step = spec.step;
      if (Array.isArray(spec.options)) view.options = [...spec.options];
      return view;
    })
  }));
  assert.equal(views.length, 3);

  const { handle, page, pageErrors } = await openDoc(PANEL_FIXTURE);
  await page.addScriptTag({ url: BUNDLE_URL });
  await page.evaluate(async (arg) => {
    const rail = document.getElementById('rail');
    rail.textContent = '';
    window.__applied = [];
    window.__panel = window.R31.mountMotionPanel(rail, {
      loadLibrary: async () => ({ ok: true, entries: arg.views }),
      applyEntry: async (id, params) => {
        window.__applied.push({ id, params });
        return { ok: true };
      }
    });
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  }, { views });
  await page.waitForFunction(() => {
    const state = window.__panel?.getState();
    return !!state && state.phase !== 'loading';
  });

  const listed = await page.evaluate(() => window.__panel.getState());
  assert.equal(listed.counts.entries, 3, `面板只列了 ${listed.counts?.entries} 条`);
  assert.equal(listed.counts.visible, 3);
  assert.equal(listed.phase, 'ready');

  /* 选 pulse，改周期到 2400，应用 → 宿主收到的必须是校验后的完整参数 */
  const pulse = views.find((view) => view.name === 'pulse');
  await page.click(`[data-motion-entry][data-id="${pulse.id}"]`);
  await page.waitForSelector('[data-motion-input][data-param="duration"]');
  await page.fill('[data-motion-input][data-param="duration"]', '2400');
  await page.click('[data-motion-apply]');
  await page.waitForFunction(() => window.__applied.length > 0);

  const applied = await page.evaluate(() => window.__applied);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].id, pulse.id);
  assert.equal(applied[0].params.duration, 2400, `参数没生效：${JSON.stringify(applied[0].params)}`);
  assert.equal(applied[0].params.easing, 'ease-out', '未填的参数应带默认值');

  await page.screenshot({ path: path.join(EVIDENCE_DIR, 's31-a4-panel.png') });
  assert.deepEqual(pageErrors, []);
  await handle.dispose();

  evidence.cases.A4 = { listed, applied, screenshot: 's31-a4-panel.png', panelStillFrozen: true };
});
