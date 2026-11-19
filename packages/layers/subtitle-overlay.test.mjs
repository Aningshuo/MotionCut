// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S23-SUBTITLE-OVERLAY 验收 A1..A9
 *
 * 真 Chromium（SceneHost）+ 真画面（tests/fixtures/scenes/subtitle-stage.html：渐变 + 图形 + 文字）。
 * 组件只画：宿主喂 cue 数组与当前秒，测试逐条验「命中哪条 / 怎么换行 / 安全区 / CPS / 穿透 / 清理」。
 *
 * 运行：node --test --test-concurrency=1 packages/layers/subtitle-overlay.test.mjs（env 由 test-env.mjs 自动准备；`OPENCUT_ENV_JSON` 可显式覆盖）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { build as esbuild } from 'esbuild';
import { SceneHost, REPO_ROOT } from '../scene-runtime/host.mjs';
import { resolveLayerTestEnv } from './test-env.mjs';

const TEST_ENV = await resolveLayerTestEnv({ suite: 'subtitle-overlay' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');
const BUNDLE_ABS = path.join(RUN_ROOT, 'tmp/s23/subtitle.mjs');
const BUNDLE_URL = '/' + path.relative(REPO_ROOT, BUNDLE_ABS).split(path.sep).join('/');
const FIXTURE = 'tests/fixtures/scenes/subtitle-stage.html';

const STAGE_W = 1280;
const STAGE_H = 720;

const evidence = {
  batch: 'B-SUB1-R12-012',
  suite: 'subtitle-overlay.test.mjs',
  cases: {},
  screenshots: [],
  startedAt: new Date().toISOString()
};

/** @type {SceneHost} */
let host;

async function buildBundle() {
  await fs.mkdir(path.dirname(BUNDLE_ABS), { recursive: true });
  await esbuild({
    stdin: {
      contents: "export * from './packages/layers/subtitle-overlay.mjs';",
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
}

async function save() {
  const files = [];
  for (const name of ['s23-a1-basic.png', 's23-a3-long.png', 's23-a5-cps.png']) {
    try {
      const buf = await fs.readFile(path.join(EVIDENCE_DIR, name));
      files.push({ name, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
    } catch {
      files.push({ name, bytes: 0, sha256: null, missing: true });
    }
  }
  evidence.screenshots = files;
  evidence.finishedAt = new Date().toISOString();
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(path.join(EVIDENCE_DIR, 's23-subtitle-overlay.json'), JSON.stringify(evidence, null, 2) + '\n');
}

before(async () => {
  const env = JSON.parse(await fs.readFile(path.join(RUN_ROOT, 'env.json'), 'utf8'));
  evidence.batch = env.batchId ?? evidence.batch;
  await buildBundle();
  host = await new SceneHost({ port: Number(env.studioPort), viewport: { width: 1440, height: 900 } }).start();
  evidence.browser = host.browserVersion;
});

after(async () => {
  await save();
  if (host) await host.stop();
});

/** 页内挂载：getStage 用舞台元素的真实 rect（数组/尺寸都由页面自己决定，宿主怎么给都行） */
async function mountSub(deps) {
  const mod = await import(deps.bundle);
  const stage = document.getElementById('stage');
  window.__cues = deps.cues;
  window.__time = deps.time ?? 0;
  window.__errors = [];
  window.__sub = mod.mountSubtitleOverlay(stage, {
    getCues: () => window.__cues,
    getTime: () => window.__time,
    getStage: () => {
      const r = stage.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    },
    style: deps.style ?? undefined,
    onError: deps.omitOnError === true ? undefined : (info) => window.__errors.push(info)
  });
  return { state: window.__sub.getState() };
}

/** 页内快照：状态 + 文本元素实测 + 穿透命中的元素 */
function snapshot(page) {
  return page.evaluate(() => {
    const overlay = document.querySelector('[data-subtitle-overlay]');
    const text = document.querySelector('[data-subtitle-text]');
    const badge = document.querySelector('[data-subtitle-cps-badge]');
    const box = document.querySelector('[data-subtitle-layer]');
    const el = text;
    const r = el ? el.getBoundingClientRect() : null;
    const cs = el ? getComputedStyle(el) : null;
    const hit = r ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null;
    return {
      state: window.__sub.getState(),
      errors: window.__errors,
      dom: {
        overlay: overlay ? { display: getComputedStyle(overlay).display, pointerEvents: getComputedStyle(overlay).pointerEvents } : null,
        text: text
          ? {
              textContent: text.textContent,
              cpsWarn: text.getAttribute('data-cps-warn'),
              pointerEvents: getComputedStyle(text).pointerEvents,
              rect: { x: r.x, y: r.y, w: r.width, h: r.height },
              fontSize: cs.fontSize,
              lineHeight: cs.lineHeight,
              strokeColor: cs.webkitTextStrokeColor
            }
          : null,
        badge: badge ? { display: getComputedStyle(badge).display, text: badge.textContent, pointerEvents: getComputedStyle(badge).pointerEvents } : null,
        boxBottom: box ? getComputedStyle(box).bottom : null,
        hit: hit ? { tag: hit.tagName, id: hit.id, isSubtitle: !!(hit.closest && hit.closest('[data-subtitle-overlay]')) } : null
      }
    };
  });
}

async function openStage() {
  const handle = await host.open(FIXTURE);
  const page = handle.page;
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  return { handle, page, pageErrors };
}

async function shot(page, name) {
  const box = await page.evaluate(() => {
    const r = document.getElementById('stage').getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const file = path.join(EVIDENCE_DIR, name);
  await page.screenshot({ path: file, clip: box });
  const stat = await fs.stat(file);
  return { name, bytes: stat.size };
}

/* ── A1 单条 cue ────────────────────────────────────────────────────────── */

test('S23-A1 单条 cue：t=1.0 显示、t=3.0/3.1（end 不含）不显示', async () => {
  const { handle, page, pageErrors } = await openStage();
  await page.evaluate(mountSub, {
    bundle: BUNDLE_URL,
    cues: [{ start: 1, end: 3, text: '第一句字幕' }],
    time: 1
  });

  await page.evaluate(() => window.__sub.render());
  const at1 = await snapshot(page);
  assert.equal(at1.dom.text.textContent, '第一句字幕');
  assert.equal(at1.state.cue.start, 1);
  assert.equal(at1.dom.overlay.display, 'block');

  await page.evaluate(() => {
    window.__time = 3;
    window.__sub.render();
  });
  const at3 = await snapshot(page);
  assert.equal(at3.dom.text.textContent, '', 'end 是开区间：t=3.0 不该显示');
  assert.equal(at3.state.cue, null);

  await page.evaluate(() => {
    window.__time = 3.1;
    window.__sub.render();
  });
  const at31 = await snapshot(page);
  assert.equal(at31.dom.text.textContent, '');

  await page.evaluate(() => {
    window.__time = 1;
    window.__sub.render();
  });
  const basic = await shot(page, 's23-a1-basic.png');
  assert.ok(basic.bytes > 10240, `截图应 >10KB（真实画面）：${basic.bytes}`);
  assert.deepEqual(pageErrors, []);

  evidence.cases['S23-A1'] = {
    ok: true,
    at1: { text: at1.dom.text.textContent, cue: at1.state.cue, fontSize: at1.dom.text.fontSize },
    at3: { text: at3.dom.text.textContent, cue: at3.state.cue },
    at31: { text: at31.dom.text.textContent },
    screenshot: basic,
    pageErrors
  };
  await handle.dispose();
});

/* ── A2 重叠取 start 最大 ───────────────────────────────────────────────── */

test('S23-A2 两条重叠（1–4 / 2–5）：t=3 显示后者、t=1.5 显示前者', async () => {
  const { handle, page, pageErrors } = await openStage();
  await page.evaluate(mountSub, {
    bundle: BUNDLE_URL,
    cues: [
      { start: 1, end: 4, text: '先来的' },
      { start: 2, end: 5, text: '后来的' }
    ],
    time: 1.5
  });

  await page.evaluate(() => window.__sub.render());
  const first = await snapshot(page);
  assert.equal(first.dom.text.textContent, '先来的');

  await page.evaluate(() => {
    window.__time = 3;
    window.__sub.render();
  });
  const later = await snapshot(page);
  assert.equal(later.dom.text.textContent, '后来的', '重叠时应取 start 最大的一条，不拼接');
  assert.equal(later.state.cue.start, 2);
  assert.ok(!later.dom.text.textContent.includes('先来的'), '不许拼接两条');

  assert.deepEqual(pageErrors, []);
  evidence.cases['S23-A2'] = { ok: true, t15: first.dom.text.textContent, t3: later.dom.text.textContent, cue: later.state.cue };
  await handle.dispose();
});

/* ── A3 60 字长文本：换行到 2 行后省略 ─────────────────────────────────── */

/**
 * S23-A3 60 字长文本：2 行后省略，overflow=true，高度不超 2 行。
 *
 * S45 后「2 行后省略」由计划层做（`planSubtitleLines` 按容量截断并加 `…`），
 * 不再是「量高度 → 二分找前缀」。判据不变：`overflow` 为真、以 `…` 结尾、高度 ≤ 2 行。
 */
test('S23-A3 60 字长文本：2 行后省略，overflow=true，高度不超 2 行', async () => {
  const { handle, page, pageErrors } = await openStage();
  const long = '这是一段很长的字幕啊'.repeat(6); // 10 字 × 6 = 60 字
  await page.evaluate(mountSub, {
    bundle: BUNDLE_URL,
    cues: [{ start: 0, end: 10, text: long }],
    time: 1,
    /* 大字号：让 60 字在 1280 宽下确实超过 2 行 */
    style: { fontSizeRatio: 0.09 }
  });

  await page.evaluate(() => window.__sub.render());
  const snap = await snapshot(page);
  const chars = [...long].length;

  assert.equal(chars, 60, `测试文本应是 60 字：${chars}`);
  assert.equal(snap.state.overflow, true, `state.overflow 应为 true：${JSON.stringify(snap.state)}`);
  assert.ok(snap.dom.text.textContent.endsWith('…'), `截断应加省略号：${snap.dom.text.textContent.slice(-6)}`);
  assert.ok(snap.dom.text.textContent.length < long.length, '截断后应比原文短');
  assert.ok(snap.state.lines <= 2, `行数应 ≤ 2：${snap.state.lines}`);
  assert.ok(
    snap.dom.text.rect.h <= snap.state.lineHeightPx * 2 + 1.5,
    `元素高度 ${snap.dom.text.rect.h} 不应超过 2 行 ${snap.state.lineHeightPx * 2}`
  );

  const longShot = await shot(page, 's23-a3-long.png');
  assert.ok(longShot.bytes > 10240, `截图应 >10KB：${longShot.bytes}`);
  assert.deepEqual(pageErrors, []);

  evidence.cases['S23-A3'] = {
    ok: true,
    inputChars: chars,
    shown: snap.dom.text.textContent,
    shownChars: [...snap.dom.text.textContent].length,
    overflow: snap.state.overflow,
    lines: snap.state.lines,
    fontSize: snap.dom.text.fontSize,
    lineHeightPx: snap.state.lineHeightPx,
    elementHeight: snap.dom.text.rect.h,
    maxHeight: snap.state.lineHeightPx * 2,
    screenshot: longShot
  };
  await handle.dispose();
});

/* ── A4 180p / 720p 比例 ────────────────────────────────────────────────── */

test('S23-A4 舞台 320×180 与 1280×720：字号/底边距按比例（误差 ≤2%）', async () => {
  const { handle, page, pageErrors } = await openStage();
  await page.evaluate(mountSub, {
    bundle: BUNDLE_URL,
    cues: [{ start: 0, end: 10, text: '比例验收' }],
    time: 1
  });

  const measure = async (w, h) => {
    await page.evaluate(
      ([width, height]) => {
        const stage = document.getElementById('stage');
        stage.style.width = `${width}px`;
        stage.style.height = `${height}px`;
        window.__sub.render();
      },
      [w, h]
    );
    const snap = await snapshot(page);
    return {
      stage: snap.state.stage,
      fontSize: Number.parseFloat(snap.dom.text.fontSize),
      lineHeight: Number.parseFloat(snap.dom.text.lineHeight),
      bottom: Number.parseFloat(snap.dom.boxBottom)
    };
  };

  const small = await measure(320, 180);
  const large = await measure(STAGE_W, STAGE_H);

  const fontRatioSmall = small.fontSize / small.stage.h;
  const fontRatioLarge = large.fontSize / large.stage.h;
  const bottomRatioSmall = small.bottom / small.stage.h;
  const bottomRatioLarge = large.bottom / large.stage.h;

  assert.ok(Math.abs(small.stage.w - 320) < 1 && Math.abs(small.stage.h - 180) < 1, `180p 舞台：${JSON.stringify(small.stage)}`);
  assert.ok(Math.abs(large.stage.w - 1280) < 1 && Math.abs(large.stage.h - 720) < 1, `720p 舞台：${JSON.stringify(large.stage)}`);
  const err = (a, b) => Math.abs(a - b) / b;
  /* 字号比例改成**按 px 的取整容差**比，不再用 2%：
     字号是取整到整数的（S47），180p 的 7.2 → 7（−2.8%）、720p 的 28.8 → 29（+0.7%），
     两个误差方向相反、叠加就有 3.4% —— 那是取整，不是比例算错。
     判据改成「两档的取整误差都不超过 0.5px」，比原来那个 2% 更硬（绝对值可查）。
     （R32 之前 180p 是 8.1→8、720p 是 32.4→32，凑巧都在 2% 内，所以这条一直没暴露。） */
  assert.ok(Math.abs(small.fontSize - small.stage.h * 0.04) <= 0.5,
    `180p 字号取整误差应 ≤0.5px：${small.fontSize} vs ${small.stage.h * 0.04}`);
  assert.ok(Math.abs(large.fontSize - large.stage.h * 0.04) <= 0.5,
    `720p 字号取整误差应 ≤0.5px：${large.fontSize} vs ${large.stage.h * 0.04}`);
  assert.ok(err(bottomRatioSmall, bottomRatioLarge) <= 0.02, `底边距比例误差应 ≤2%：${bottomRatioSmall} vs ${bottomRatioLarge}`);
  /* S47 起字号取整到 ASS 的整数口径（R32：720 × 0.04 = 28.8 → 29），所以「4%」这条判据
     要按 **±0.5px 的取整容差** 比，而不是比 0.04 这个比值本身（29/720 = 4.028%）。 */
  assert.ok(Math.abs(large.fontSize - 0.04 * large.stage.h) <= 0.5, `字应占舞台高 4%（±0.5px 取整）：${large.fontSize} vs ${0.04 * large.stage.h}`);
  assert.ok(Math.abs(small.fontSize - 0.04 * small.stage.h) <= 0.5, `180p 字号同样 ±0.5px：${small.fontSize} vs ${0.04 * small.stage.h}`);
  assert.ok(Math.abs(bottomRatioLarge - 0.08) <= 0.0005, `安全区应占舞台高 8%：${bottomRatioLarge}`);

  assert.deepEqual(pageErrors, []);
  evidence.cases['S23-A4'] = {
    ok: true,
    small: { ...small, fontRatio: fontRatioSmall, bottomRatio: bottomRatioSmall },
    large: { ...large, fontRatio: fontRatioLarge, bottomRatio: bottomRatioLarge },
    fontRatioError: err(fontRatioSmall, fontRatioLarge),
    /* 3.4% 是两档取整方向相反造成的（7/180 vs 29/720），不是比例算错 —— 判据已改成 ±0.5px。 */
    fontPxError: { small: small.fontSize - small.stage.h * 0.04, large: large.fontSize - large.stage.h * 0.04 },
    bottomRatioError: err(bottomRatioSmall, bottomRatioLarge)
  };
  await handle.dispose();
});

/* ── A5 CPS 提示 ────────────────────────────────────────────────────────── */

test('S23-A5 13 字 / 0.5s = 26cps → data-cps-warn=true；正常 cue 为 false', async () => {
  const { handle, page, pageErrors } = await openStage();
  const fast = '字幕速率提示测试用例一二三'; // 13 字
  await page.evaluate(mountSub, {
    bundle: BUNDLE_URL,
    cues: [
      { start: 0, end: 0.5, text: fast },
      { start: 5, end: 9, text: '正常语速的一句话' }
    ],
    time: 0.1
  });

  await page.evaluate(() => window.__sub.render());
  const warn = await snapshot(page);
  assert.equal(warn.dom.text.cpsWarn, 'true', `应标 cps-warn：${JSON.stringify(warn.state)}`);
  assert.equal(warn.state.warn, true);
  assert.equal(warn.state.cps, 26, `13 字 / 0.5s 应 = 26cps：${warn.state.cps}`);
  assert.equal(warn.dom.badge.display, 'block', '应有可见的 CPS 角标');
  assert.notEqual(warn.dom.text.strokeColor, 'rgba(0, 0, 0, 0.85)', '描边应转成提示色');
  /* 只提示：文本不被改、不被拦 */
  assert.equal(warn.dom.text.textContent, fast, '提示不许改文本');

  const cpsShot = await shot(page, 's23-a5-cps.png');
  assert.ok(cpsShot.bytes > 10240, `截图应 >10KB：${cpsShot.bytes}`);

  await page.evaluate(() => {
    window.__time = 6;
    window.__sub.render();
  });
  const normal = await snapshot(page);
  assert.equal(normal.dom.text.cpsWarn, 'false');
  assert.equal(normal.state.warn, false);
  assert.equal(normal.dom.badge.display, 'none');

  assert.deepEqual(pageErrors, []);
  evidence.cases['S23-A5'] = {
    ok: true,
    fast: { text: warn.dom.text.textContent, cps: warn.state.cps, attr: warn.dom.text.cpsWarn, badge: warn.dom.badge.text, stroke: warn.dom.text.strokeColor },
    normal: { cps: normal.state.cps, attr: normal.dom.text.cpsWarn, badge: normal.dom.badge.display },
    screenshot: cpsShot
  };
  await handle.dispose();
});

/* ── A6 事件穿透 ────────────────────────────────────────────────────────── */

test('S23-A6 字幕正中 elementFromPoint 不是字幕节点（穿透成立）', async () => {
  const { handle, page, pageErrors } = await openStage();
  await page.evaluate(mountSub, {
    bundle: BUNDLE_URL,
    cues: [{ start: 0, end: 10, text: '穿透验收字幕' }],
    time: 1
  });
  await page.evaluate(() => window.__sub.render());
  const snap = await snapshot(page);

  assert.ok(snap.dom.hit, '应命中某个元素');
  assert.equal(snap.dom.hit.isSubtitle, false, `命中的不该是字幕节点：${JSON.stringify(snap.dom.hit)}`);
  assert.equal(snap.dom.hit.id, 'probe', `应命中舞台探针：${JSON.stringify(snap.dom.hit)}`);
  assert.equal(snap.dom.overlay.pointerEvents, 'none');
  assert.equal(snap.dom.text.pointerEvents, 'none');

  assert.deepEqual(pageErrors, []);
  evidence.cases['S23-A6'] = { ok: true, hit: snap.dom.hit, overlayPointerEvents: snap.dom.overlay.pointerEvents, textPointerEvents: snap.dom.text.pointerEvents };
  await handle.dispose();
});

/* ── A7 20 次挂卸 ───────────────────────────────────────────────────────── */

test('S23-A7 连续 mount/destroy 20 次：DOM 无残留、监听器无增长', async () => {
  const { handle, page, pageErrors } = await openStage();

  const result = await page.evaluate(async (bundle) => {
    const mod = await import(bundle);
    const stage = document.getElementById('stage');
    /* 自己数（window.addEventListener/removeEventListener 包一层，只数 resize） */
    const counts = { add: 0, remove: 0 };
    const origAdd = window.addEventListener.bind(window);
    const origRemove = window.removeEventListener.bind(window);
    window.addEventListener = function (type, fn, opt) {
      if (type === 'resize') counts.add += 1;
      return origAdd(type, fn, opt);
    };
    window.removeEventListener = function (type, fn, opt) {
      if (type === 'resize') counts.remove += 1;
      return origRemove(type, fn, opt);
    };

    const before = { body: document.body.children.length, stage: stage.children.length };
    for (let i = 0; i < 20; i += 1) {
      const sub = mod.mountSubtitleOverlay(stage, {
        getCues: () => [{ start: 0, end: 10, text: `第 ${i} 次` }],
        getTime: () => 1
      });
      sub.render();
      sub.destroy();
    }
    const after = { body: document.body.children.length, stage: stage.children.length };
    window.addEventListener = origAdd;
    window.removeEventListener = origRemove;
    return {
      before,
      after,
      counts,
      overlaysLeft: document.querySelectorAll('[data-subtitle-overlay]').length,
      lastState: (() => {
        const probe = mod.mountSubtitleOverlay(stage, { getCues: () => [], getTime: () => 0 });
        const s = probe.getState();
        probe.destroy();
        return s;
      })()
    };
  }, BUNDLE_URL);

  assert.deepEqual(result.after, result.before, `body/stage 子节点数应回到初始：${JSON.stringify(result)}`);
  assert.equal(result.overlaysLeft, 0, 'destroy 后不该有覆盖层残留');
  assert.equal(result.counts.add, 20, `应有 20 次 resize 绑定：${result.counts.add}`);
  assert.equal(result.counts.remove, 20, `应有 20 次 resize 解绑：${result.counts.remove}`);
  assert.equal(result.lastState.listeners, 1, '挂载期间应恰好 1 个监听');
  assert.deepEqual(pageErrors, []);

  evidence.cases['S23-A7'] = { ok: true, ...result };
  await handle.dispose();
});

/* ── A8 非法 cue ────────────────────────────────────────────────────────── */

test('S23-A8 非法 cue 被跳过，onError 收到一次 SUBTITLE_BAD_CUE，组件不抛', async () => {
  const { handle, page, pageErrors } = await openStage();
  await page.evaluate(mountSub, {
    bundle: BUNDLE_URL,
    cues: [
      { start: 5, end: 2, text: 'end 小于 start' },
      { start: 1, end: 2, text: null },
      { start: 0, end: 10, text: '合法的一条' },
      { start: Number.NaN, end: 3, text: 'start 是 NaN' }
    ],
    time: 1
  });
  await page.evaluate(() => window.__sub.render());
  const snap = await snapshot(page);

  assert.equal(snap.state.skipped, 3, `应跳过 3 条非法 cue：${snap.state.skipped}`);
  assert.equal(snap.dom.text.textContent, '合法的一条', '合法的一条仍应显示');
  assert.equal(snap.errors.length, 1, `同码只报一次：${JSON.stringify(snap.errors)}`);
  assert.equal(snap.errors[0].code, 'SUBTITLE_BAD_CUE');
  assert.ok(snap.errors[0].message.length > 0);
  assert.deepEqual(pageErrors, [], '不该抛异常');

  /* 再 render 几次也不重复报 */
  await page.evaluate(() => {
    window.__sub.render();
    window.__sub.render();
  });
  const again = await snapshot(page);
  assert.equal(again.errors.length, 1, '重复 render 不该重复报同一个码');

  /* 宿主没给 onError：同一个码走 console.warn，仍然不抛 */
  const warnings = [];
  page.on('console', (msg) => {
    if (msg.type() === 'warning') warnings.push(msg.text());
  });
  await page.evaluate(() => window.__sub.destroy());
  await page.evaluate(mountSub, {
    bundle: BUNDLE_URL,
    cues: [{ start: 9, end: 1, text: '坏 cue' }],
    time: 5,
    omitOnError: true
  });
  await page.evaluate(() => window.__sub.render());
  const noHook = await snapshot(page);
  assert.equal(noHook.state.skipped, 1);
  assert.ok(
    warnings.some((text) => text.includes('SUBTITLE_BAD_CUE')),
    `没给 onError 时应 console.warn 带码：${JSON.stringify(warnings)}`
  );

  evidence.cases['S23-A8'] = {
    ok: true,
    skipped: snap.state.skipped,
    shown: snap.dom.text.textContent,
    errors: snap.errors,
    reportsAfter3Renders: again.errors.length,
    noOnError: { skipped: noHook.state.skipped, warnings }
  };
  await handle.dispose();
});

/* ── A9 全场景无 pageerror ──────────────────────────────────────────────── */

test('S23-A9 一整串操作（挂载/渲染/改尺寸/改样式/隐藏/销毁）pageErrors 为空', async () => {
  const { handle, page, pageErrors } = await openStage();
  await page.evaluate(mountSub, {
    bundle: BUNDLE_URL,
    cues: [
      { start: 0, end: 2, text: '短句' },
      { start: 2, end: 6, text: '这是一段用来压行的字幕文本'.repeat(3) },
      { start: 6, end: 9, text: '最后一句' }
    ],
    time: 0
  });

  await page.evaluate(() => {
    for (const t of [0, 1.9, 2, 4, 6, 8.5, 9, 12]) {
      window.__time = t;
      window.__sub.render();
    }
    window.__sub.updateStyle({ fontSizeRatio: 0.06, maxLines: 1 });
    window.__sub.render();
    window.__sub.setVisible(false);
    window.__sub.render();
    window.__sub.setVisible(true);
    const stage = document.getElementById('stage');
    stage.style.width = '640px';
    stage.style.height = '360px';
    window.__sub.render();
    window.__sub.destroy();
  });

  const after = await page.evaluate(() => ({
    overlays: document.querySelectorAll('[data-subtitle-overlay]').length,
    errors: window.__errors
  }));

  assert.deepEqual(pageErrors, [], `不该有 pageerror：${pageErrors}`);
  assert.deepEqual(after.errors, [], `不该有组件报错：${JSON.stringify(after.errors)}`);
  assert.equal(after.overlays, 0, 'destroy 后不该残留覆盖层');

  evidence.cases['S23-A9'] = { ok: true, pageErrors, componentErrors: after.errors, overlaysAfterDestroy: after.overlays };
  await handle.dispose();
});
