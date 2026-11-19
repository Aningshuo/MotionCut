// @ts-nocheck —— 以真浏览器的 computed style 为准；产品模块仍由 tsc 严格检查。
/**
 * E05-P1 落位验收：编译出的 CSS 真的能「拖到哪一帧就是哪一帧」
 *
 * 判据（派单 R30-070 第 4 步之 3）：渲染出的元素上 `data-kf` 存在、
 * `animation-delay` 里含 `var(--motion-t)`。这里不止查字符串 —— 真起 Chromium，
 * 写不同的 `--motion-t` 读 computed `opacity`，证明画面**确实**由那个变量决定：
 *
 * - 局部 0 → 0%（首帧）
 * - 局部 1000ms → 40%（第二帧，`1 / 2.5`）
 * - 局部 2500ms → 100%（末帧）
 * - 同一个局部时刻连读两次 → 一模一样（确定性）
 *
 * 口径：`--motion-t` 是**片段内局部毫秒**（与舞台 `writeMotionTime` 同口径），
 * 所以这里直接写局部值，不写全局影片时间（E05-P2 起）。
 *
 * 帧点取值刻意选在**关键帧位置上**，避开段内缓动插值：断言的是「相位对不对」，
 * 不是「Chrome 的 cubic-bezier 算得准不准」。
 *
 * 跑法：node --test --test-concurrency=1 packages/layers/keyframes-apply.test.mjs
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { chromium } from 'playwright';

import { compileKeyframes } from '../film-core/keyframes.mjs';
import { parse } from '../film-core/film-doc.mjs';
import { KF_STYLE_ID, applyKeyframes, readKeyframe } from './apply-keyframes.mjs';

/** 片段 `at="1.5"`（起点 1.5s），`#t=0,4` → 4s 长；关键帧跨 2.5s。 */
const FIXTURE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=1280, height=720">
<title>E05-P1 落位夹具</title>
</head>
<body>
<section id="pages">
  <iframe id="page-main" src="page.html#t=0,4" at="1.5" size="1280x720"
    overrides='[{"at":"#title","kf":[{"t":0,"style":{"opacity":"0","translate":"0 12px"},"ease":"ease-out"},{"t":1,"style":{"opacity":"0.4","translate":"0 4px"},"ease":"linear"},{"t":2.5,"style":{"opacity":"1","translate":"0 0"}}]}]'></iframe>
</section>
</body>
</html>
`;

/** 舞台页：`#title` 就是被覆盖的那一层（真实舞台里它是 iframe 内的 DOM，这里直连替身）。 */
const STAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>stage</title></head>
<body><div id="title" style="width:100px;height:40px">标题</div></body></html>
`;

/** @type {import('playwright').Browser} */
let browser;
/** @type {import('playwright').Page} */
let page;

before(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});

after(async () => {
  await page?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
});

/** 让画面落位，并等两帧确保动画的相位已按新 delay 重算。 */
async function settle() {
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

/** 写时间轴（毫秒），与 `motion/instance.mjs` 的 `renderInstanceAt` 同一个变量。 */
async function seek(tMs) {
  await page.evaluate((value) => {
    document.documentElement.style.setProperty('--motion-t', String(value));
  }, tMs);
  await settle();
}

/** @returns {{css: string, plans: any[]}} */
function compiled() {
  const result = parse(FIXTURE);
  assert.equal(result.doc === null, false, JSON.stringify(result.diagnostics));
  const out = compileKeyframes(result.doc);
  assert.deepEqual(out.diagnostics, []);
  return out;
}

test('A1 落位：元素拿到 data-kf，<style> 里就是编译出的那段 CSS', async () => {
  const { css, plans } = compiled();
  await page.setContent(STAGE);
  const applied = await applyKeyframes(page, { css, plans });
  assert.deepEqual(applied, { ok: true, applied: 1, missed: [], cleared: 0, cssLength: css.length });

  const state = await readKeyframe(page, '#title');
  assert.equal(state.ok, true);
  assert.equal(state.kf, plans[0].hash);
  assert.equal(state.hasStyleNode, true);
  assert.equal(state.css, css);
  assert.equal(state.playState, 'paused');
  assert.equal(state.animationName, `kf-${plans[0].hash}`);
  /* 契约：delay 里必须有 motion 的时钟变量（否则就是「暂停在第 0 帧」）。
     注意**不能**拿 computed 值查这个子串：`var()` 在 computed 阶段已经被解析掉了
     （`--motion-t` 缺省 0 → `calc(1.5s - 0ms)` 就是 `1.5s`）。所以查 CSS 源码。 */
  assert.match(state.css, /animation-delay: calc\([^)]*var\(--motion-t/);
  assert.match(state.css, /animation-play-state: paused/);
});

test('A1b 时钟真的接在 delay 上：写 0 → delay 0s；写 2500ms → delay −2.5s', async () => {
  const { css, plans } = compiled();
  await page.setContent(STAGE);
  await applyKeyframes(page, { css, plans });

  await seek(0);
  assert.equal((await readKeyframe(page, '#title')).delay, '0s', '局部 0 → delay 0');

  await seek(2500);
  assert.equal((await readKeyframe(page, '#title')).delay, '-2.5s', '局部 2500ms → 已播 2.5s');
});

test('A2 跟手：局部 0 → 首帧，局部 1000ms → 40%，局部 2500ms → 末帧', async () => {
  const { css, plans } = compiled();
  await page.setContent(STAGE);
  await applyKeyframes(page, { css, plans });

  await seek(0); // 局部 0
  assert.equal(Number((await readKeyframe(page, '#title')).opacity), 0);

  await seek(1000); // 局部 1s / 2.5s = 40% → 第二帧
  assert.ok(Math.abs(Number((await readKeyframe(page, '#title')).opacity) - 0.4) < 0.02);

  await seek(2500); // 局部 2.5s = 100% → 末帧
  assert.equal(Number((await readKeyframe(page, '#title')).opacity), 1);
});

test('A3 时钟为 0 时不动：停在首帧（fill both 的 backwards）', async () => {
  const { css, plans } = compiled();
  await page.setContent(STAGE);
  await applyKeyframes(page, { css, plans });
  await seek(0);
  assert.equal(Number((await readKeyframe(page, '#title')).opacity), 0);
});

test('A4 确定性：同一个局部时刻连读两次逐位相同', async () => {
  const { css, plans } = compiled();
  await page.setContent(STAGE);
  await applyKeyframes(page, { css, plans });

  await seek(1000);
  const first = await readKeyframe(page, '#title');
  const second = await readKeyframe(page, '#title');
  assert.equal(first.opacity, second.opacity);

  /* 折返一次再回来，值必须回到原处（不是「只往前走」）。 */
  await seek(2500);
  await seek(1000);
  const third = await readKeyframe(page, '#title');
  assert.equal(third.opacity, first.opacity, `第一次 ${first.opacity}，回来 ${third.opacity}`);
});

test('A5 清理：新一批不再包含该 at → data-kf 被摘掉，旧动画不留', async () => {
  const { css, plans } = compiled();
  await page.setContent(STAGE);
  await applyKeyframes(page, { css, plans });
  assert.equal((await readKeyframe(page, '#title')).kf, plans[0].hash);

  const second = await applyKeyframes(page, { css: '', plans: [] });
  assert.equal(second.cleared, 1);
  const state = await readKeyframe(page, '#title');
  assert.equal(state.kf, null);
  assert.equal(state.hasStyleNode, false, '空 CSS 时 <style> 节点要移除，不留空壳');
});

test('A6 missed：计划指向不存在的选择器 → 报出来，不静默', async () => {
  const { css, plans } = compiled();
  await page.setContent(STAGE);
  const applied = await applyKeyframes(page, {
    css,
    plans: [...plans, { at: '#nope', hash: 'ffffffffff' }],
  });
  assert.equal(applied.applied, 1);
  assert.deepEqual(applied.missed, ['#nope']);
});

test('A7 两条片段共用同一段 CSS：同 hash 只写一次规则（统计口径）', async () => {
  const { stats } = compiled();
  assert.equal(stats.rules, 1);
  assert.equal(stats.plans, 1);
  assert.equal(KF_STYLE_ID, 'film-kf-styles');
});

test('A8 两段都叫 `#box`：计划按 clipId 落到各自文档，不互相串规则（R15）', async () => {
  /* 真实现场：`syncKeyframeFrame` 跨文档走，只按选择器匹配时 B 段的 hash 会盖到 A 段
     （实测 A 读到 B 的末帧 0.9 而不是 1）。计划带上 clipId 后必须各归各。 */
  const { syncKeyframeFrame } = await import('./apply-keyframes.mjs');
  await page.setContent(`<!doctype html><html><body>
    <iframe id="clip-a" srcdoc="&lt;div id=&quot;box&quot; style=&quot;width:80px;height:40px&quot;&gt;A&lt;/div&gt;"></iframe>
    <iframe id="clip-b" srcdoc="&lt;div id=&quot;box&quot; style=&quot;width:80px;height:40px&quot;&gt;B&lt;/div&gt;"></iframe>
  </body></html>`);

  const read = () =>
    page.evaluate(() => {
      const out = {};
      for (const el of document.querySelectorAll('iframe')) {
        const doc = el.contentDocument;
        const box = doc ? doc.querySelector('#box') : null;
        out[el.id] = box ? { kf: box.getAttribute('data-kf'), motion: box.style.getPropertyValue('--motion-t') } : null;
      }
      return out;
    });

  const deadline = Date.now() + 5000;
  // 等 srcdoc 文档就绪
  while (Date.now() < deadline) {
    const ready = await page.evaluate(() =>
      Array.from(document.querySelectorAll('iframe')).every((el) => el.contentDocument && el.contentDocument.querySelector('#box')),
    );
    if (ready) break;
    await page.waitForTimeout(50);
  }

  const stats = await page.evaluate(syncKeyframeFrame, {
    t: 3,
    css: '',
    plans: [
      { clipId: 'clip-a', at: '#box', hash: 'aaaaaaaaaa' },
      { clipId: 'clip-b', at: '#box', hash: 'bbbbbbbbbb' },
    ],
  });
  assert.equal(stats.marked, 2, '两段各打一次');

  const got = await read();
  assert.equal(got['clip-a'].kf, 'aaaaaaaaaa', `A 段拿到了 ${got['clip-a'].kf}`);
  assert.equal(got['clip-b'].kf, 'bbbbbbbbbb', `B 段拿到了 ${got['clip-b'].kf}`);

  /* 没有 clipId 的老计划仍按旧行为（任意文档命中就打）。 */
  await page.evaluate(syncKeyframeFrame, {
    t: 3,
    css: '',
    plans: [{ at: '#box', hash: 'cccccccccc' }],
  });
  const legacy = await read();
  assert.equal(legacy['clip-a'].kf, 'cccccccccc');
  assert.equal(legacy['clip-b'].kf, 'cccccccccc');
});
