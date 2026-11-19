// @ts-nocheck —— 验收以 node --test 的运行断言为准；产品模块仍由 tsc 严格检查。
/**
 * S45-SUBTITLE-LAYOUT-WIRE（A1/A2/A6）· B-SUB1-R23-023
 *
 * 一句话：**预览的行由共享计划层定，CSS 不再自己折行**。
 *
 * 这批修的是 S43 找到的 P1（R24-C1/C2）：libass 只在空格处断行，而预览的
 * `overflow-wrap:anywhere` 能在任意字间断 —— 同一条纯中文长句，预览两行、成片一行且
 * 左右被裁。修法不是让哪一边学会对方的折行，而是**两边吃同一组 lines**
 * （`planSubtitleLines` → 预览 `\n` / 成片 `toAssText()` 的 `\N`）。
 *
 * 所以这里验的是「预览确实用了计划层、且没有被 CSS 二次折行」：
 * - A1 长句 → 2 行、`textContent` 含 `\n`、computed `white-space:pre`、最宽行 ≤ 可用宽
 * - A2 `maxLines:1` → 以 `…` 结尾、前缀 = `plan.lines[0]` 去掉 `…`
 * - A3 720p / 竖屏 letterbox / 4K 同一句 → 同一组行（计划在舞台上做，与画布无关）
 * - A6 10 字短句 → `lines=[原句]`、DOM 文本逐字节等于原句（零漂移）
 *
 * 运行：node --test --test-concurrency=1 packages/layers/subtitle-layout-wire.test.mjs（env 由 test-env.mjs 自动准备；`OPENCUT_ENV_JSON` 可显式覆盖）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveLayerTestEnv } from './test-env.mjs';

import { build as esbuild } from 'esbuild';

import { SceneHost, REPO_ROOT } from '../scene-runtime/host.mjs';

const TEST_ENV = await resolveLayerTestEnv({ suite: 'subtitle-layout-wire' });
const ENV_PATH = TEST_ENV.envPath;
const RUN_ROOT = path.dirname(ENV_PATH);
const BUNDLE_ABS = path.join(RUN_ROOT, 'tmp/s45-wire/subtitle.mjs');
const BUNDLE_URL = '/' + path.relative(REPO_ROOT, BUNDLE_ABS).split(path.sep).join('/');
const FIXTURE = 'tests/fixtures/scenes/subtitle-style.html';

const STAGE = { w: 1280, h: 720 };

/** 50 字纯中文（没有空格）：libass 不会在中间断，CSS 以前会 —— 正是 R24-C1 的形状。 */
const LONG = '这是一句没有空格的纯中文字幕用来验证预览是不是也在同一处断行而不是自己乱断然后成片就裁掉了真的被裁掉';
/** 10 字短句：一行放得下，DOM 必须逐字节等于原句。 */
const SHORT = '这是一句十字字幕';

/** @type {SceneHost} */
let host;
/** @type {any} */
let handle;
/** @type {any} */
let page;
/** @type {string[]} */
const pageErrors = [];

before(async () => {
  await fs.mkdir(path.dirname(BUNDLE_ABS), { recursive: true });
  await esbuild({
    stdin: {
      contents: "export * from './packages/layers/subtitle-overlay.mjs';\nexport * from './packages/layers/subtitle-style.mjs';",
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
  const env = JSON.parse(await fs.readFile(ENV_PATH, 'utf8'));
  host = await new SceneHost({ port: Number(env.sceneOrigin) || 59381, viewport: { width: 1280, height: 720 } }).start();
  handle = await host.open(FIXTURE);
  page = handle.page;
  page.on('pageerror', (error) => pageErrors.push(String(error)));
});

after(async () => {
  if (handle) await handle.dispose();
  if (host) await host.stop();
});

/**
 * 页内挂载：画布大小的根 + 画布内的舞台矩形（= P32 的 letterbox）。
 *
 * `getStage()` 给的是**画布坐标里的舞台矩形**（w/h 都已乘过 scale）——覆盖层按它算字号，
 * 与 `toAssStyle` 的 `stage.h × ratio × scale` 是同一次变换。计划层的容量是 em，
 * 分子分母同时乘 scale 会约掉，所以三画幅排出来的行必须一样。
 */
async function mountInPage(deps) {
  const mod = await import(deps.bundle);
  if (window.__sub) {
    window.__sub.destroy();
    window.__sub = null;
  }
  document.getElementById('__wire_root')?.remove();
  const root = document.createElement('div');
  root.id = '__wire_root';
  root.style.cssText = `position:fixed;left:0;top:0;width:${deps.canvas.w}px;height:${deps.canvas.h}px;background:#101010;z-index:2147483647`;
  const stageEl = document.createElement('div');
  stageEl.id = '__wire_stage';
  stageEl.style.cssText = `position:absolute;left:${deps.rect.x}px;top:${deps.rect.y}px;width:${deps.rect.w}px;height:${deps.rect.h}px;background:#1b1b1b`;
  root.appendChild(stageEl);
  document.body.appendChild(root);
  window.__errors = [];
  window.__sub = mod.mountSubtitleOverlay(stageEl, {
    getCues: () => [{ start: 0, end: 10, text: deps.text }],
    getTime: () => deps.time ?? 1,
    getStage: () => ({ x: deps.rect.x, y: deps.rect.y, w: deps.rect.w, h: deps.rect.h }),
    ...(deps.style === undefined ? {} : { style: deps.style }),
    onError: (info) => window.__errors.push(info)
  });
  window.__sub.render();
  return window.__sub.getState();
}

/** 页内读 DOM：computed 的 white-space / 字体族 + 每行的 Range 行盒。 */
function readDomInPage() {
  const textEl = document.querySelector('[data-subtitle-text]');
  const cs = getComputedStyle(textEl);
  const node = textEl.firstChild;
  const text = node ? node.data : '';
  /* 每个「视觉行」一条 Range 行盒：`white-space:pre` 下它必然等于计划层的行数 */
  const lines = [];
  let start = 0;
  for (let i = 0; i <= text.length; i += 1) {
    if (text[i] === '\n' || i === text.length) {
      if (i > start) {
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, i);
        const rect = range.getBoundingClientRect();
        lines.push({ text: text.slice(start, i), width: Math.round(rect.width * 100) / 100, top: Math.round(rect.top * 100) / 100 });
      }
      start = i + 1;
    }
  }
  return {
    text,
    whiteSpace: cs.whiteSpace,
    fontFamily: cs.fontFamily,
    fontSize: Number.parseFloat(cs.fontSize),
    lineHeight: cs.lineHeight,
    textAlign: cs.textAlign,
    attributeLines: textEl.getAttribute('data-subtitle-lines'),
    attributeTruncated: textEl.getAttribute('data-subtitle-truncated'),
    lineBoxes: lines
  };
}

const stageRectIn = (canvas) => {
  const scale = Math.min(canvas.w / STAGE.w, canvas.h / STAGE.h);
  const offsetX = (canvas.w - STAGE.w * scale) / 2;
  const offsetY = (canvas.h - STAGE.h * scale) / 2;
  return { scale, x: offsetX, y: offsetY, w: STAGE.w * scale, h: STAGE.h * scale };
};

test('S45-A1 50 字纯中文（无空格）：2 行、textContent 含 \\n、white-space:pre、最宽行 ≤ 可用宽', async () => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const state = await page.evaluate(mountInPage, {
    bundle: BUNDLE_URL,
    canvas: { w: 1280, h: 720 },
    rect: stageRectIn({ w: 1280, h: 720 }),
    text: LONG
  });
  const dom = await page.evaluate(readDomInPage);

  assert.equal([...LONG].length, 50, `夹具应是 50 字：${[...LONG].length}`);
  assert.equal(state.lines, 2, `50 字在 720p 应排 2 行：${JSON.stringify(state.plan)}`);
  assert.equal(state.plan.lines.length, 2);
  assert.equal(dom.text, state.plan.lines.join('\n'), 'DOM 文本必须是计划层的行（\\n 连接）');
  assert.ok(dom.text.includes('\n'), `textContent 必须含换行符：${JSON.stringify(dom.text)}`);
  assert.equal(dom.whiteSpace, 'pre', `文本节点必须是 white-space:pre（不许 CSS 自动折行）：${dom.whiteSpace}`);
  assert.equal(dom.attributeLines, '2');
  assert.equal(state.overflow, false, '50 字排得下 2 行，不该截断');

  /* 没有 CSS 二次折行：Range 行盒数 == 计划行数，且每行文本与计划逐字相同 */
  assert.equal(dom.lineBoxes.length, 2, `视觉行数应等于计划行数：${JSON.stringify(dom.lineBoxes)}`);
  assert.deepEqual(dom.lineBoxes.map((line) => line.text), state.plan.lines);

  /* 最宽的一行不许超出可用宽（可用宽 = 舞台宽 × (1 − 2×4%)） */
  assert.ok(state.availableWidthPx > 0);
  assert.ok(
    state.maxLineWidthPx <= state.availableWidthPx,
    `最宽行 ${state.maxLineWidthPx}px 超过可用宽 ${state.availableWidthPx}px（行宽：${JSON.stringify(state.lineWidthsPx)}）`
  );
  /* 逐行宽与 Range 行盒宽一致（±1px）：量宽走的不是另一条路 */
  for (const [index, width] of state.lineWidthsPx.entries()) {
    assert.ok(Math.abs(width - dom.lineBoxes[index].width) <= 1, `第 ${index + 1} 行宽度不一致：${width} vs ${dom.lineBoxes[index].width}`);
  }
});

test('S45-A2 maxLines:1：以 … 结尾，前缀 = 计划层第一行去掉 …', async () => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const state = await page.evaluate(mountInPage, {
    bundle: BUNDLE_URL,
    canvas: { w: 1280, h: 720 },
    rect: stageRectIn({ w: 1280, h: 720 }),
    text: LONG,
    style: { maxLines: 1 }
  });
  const dom = await page.evaluate(readDomInPage);

  assert.equal(state.plan.maxLines, 1);
  assert.equal(state.lines, 1, `maxLines:1 只许一行：${JSON.stringify(state.plan)}`);
  assert.equal(state.overflow, true, '截断必须标记 overflow');
  assert.ok(dom.text.endsWith('…'), `截断要带省略号：${JSON.stringify(dom.text.slice(-6))}`);
  assert.equal(dom.attributeTruncated, 'true');
  /* 前缀 = 计划行去掉末尾的 …（不再有第二个「…」） */
  const prefix = state.plan.lines[0].slice(0, -1);
  assert.equal(dom.text, `${prefix}…`);
  assert.ok(!prefix.includes('…'), '前缀里不该再出现省略号');
  assert.ok([...prefix].length < [...LONG].length, '截断后必须比原文短');
  assert.ok(state.maxLineWidthPx <= state.availableWidthPx, `截断后仍超宽：${state.maxLineWidthPx} > ${state.availableWidthPx}`);
});

test('S45-A3 720p / 竖屏 letterbox / 4K：同一句排同一组行（计划在舞台上做）', async () => {
  const canvases = [
    { id: '720p', w: 1280, h: 720 },
    { id: 'portrait', w: 1080, h: 1920 },
    { id: '4k', w: 3840, h: 2160 }
  ];
  const rows = [];
  for (const canvas of canvases) {
    await page.setViewportSize({ width: canvas.w, height: canvas.h });
    const rect = stageRectIn(canvas);
    const state = await page.evaluate(mountInPage, { bundle: BUNDLE_URL, canvas, rect, text: LONG });
    const dom = await page.evaluate(readDomInPage);
    rows.push({
      canvas: canvas.id,
      scale: Math.round(rect.scale * 10000) / 10000,
      lines: state.plan.lines,
      linesCount: state.lines,
      capacityEm: state.plan.capacityEm,
      fontSize: dom.fontSize,
      whiteSpace: dom.whiteSpace,
      text: dom.text
    });
  }
  const base = rows[0];
  for (const row of rows.slice(1)) {
    assert.deepEqual(row.lines, base.lines, `画幅 ${row.canvas} 的行排与 720p 不一致：${JSON.stringify(row.lines)} vs ${JSON.stringify(base.lines)}`);
    assert.equal(row.linesCount, base.linesCount);
    assert.equal(row.text, base.text, `画幅 ${row.canvas} 的 DOM 文本与 720p 不一致`);
    assert.equal(row.whiteSpace, 'pre');
    assert.ok(Math.abs(row.capacityEm - base.capacityEm) <= 0.05, `容量随画幅变了：${row.capacityEm} vs ${base.capacityEm}`);
  }
  /* 字号确实按画幅缩放了（不是三个画幅都画成同一个数）：证明 stage.h 走的是 letterbox 后的矩形。
     S47 起预览字号**取整**到与 ASS `Fontsize` 同一个整数；
     R32（0.045→0.04）之后三格是 29 / 24 / 86（原来是 32 / 27 / 97）。 */
  assert.equal(rows[0].fontSize, 29, `720p 字号应与 ASS Fontsize 相等：${rows[0].fontSize}`);
  assert.equal(rows[1].fontSize, 24, `竖屏字号应与 ASS Fontsize 相等：${rows[1].fontSize}`);
  assert.equal(rows[2].fontSize, 86, `4K 字号应与 ASS Fontsize 相等：${rows[2].fontSize}`);
});

test('S45-A6 10 字短句：lines=[原句]，DOM 文本逐字节等于原句（零漂移）', async () => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const state = await page.evaluate(mountInPage, {
    bundle: BUNDLE_URL,
    canvas: { w: 1280, h: 720 },
    rect: stageRectIn({ w: 1280, h: 720 }),
    text: SHORT
  });
  const dom = await page.evaluate(readDomInPage);

  assert.equal([...SHORT].length, 8, `夹具是 8 字（含「十字」）：${[...SHORT].length}`);
  assert.deepEqual(state.plan.lines, [SHORT], `短句必须原样一行：${JSON.stringify(state.plan.lines)}`);
  assert.equal(state.lines, 1);
  assert.equal(dom.text, SHORT, `DOM 文本必须逐字节等于原句：${JSON.stringify(dom.text)}`);
  assert.equal(dom.attributeLines, '1');
  assert.equal(state.overflow, false);
  assert.equal(dom.whiteSpace, 'pre');
});

test('S45-A6b 显式 \\n 保留：两条计划行、DOM 里仍是那个换行', async () => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const text = '第一行\n第二行';
  const state = await page.evaluate(mountInPage, {
    bundle: BUNDLE_URL,
    canvas: { w: 1280, h: 720 },
    rect: stageRectIn({ w: 1280, h: 720 }),
    text
  });
  const dom = await page.evaluate(readDomInPage);
  assert.deepEqual(state.plan.lines, ['第一行', '第二行']);
  assert.equal(dom.text, text);
  assert.equal(dom.lineBoxes.length, 2);
});

test('S45-A6c 空文本不渲染：lines=[]、textContent 为空、不报错', async () => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const state = await page.evaluate(mountInPage, {
    bundle: BUNDLE_URL,
    canvas: { w: 1280, h: 720 },
    rect: stageRectIn({ w: 1280, h: 720 }),
    text: '   '
  });
  const dom = await page.evaluate(readDomInPage);
  assert.equal(state.lines, 0);
  assert.deepEqual(state.plan?.lines ?? [], []);
  assert.equal(dom.text, '');
  const errors = await page.evaluate(() => window.__errors);
  assert.deepEqual(errors, []);
});

test('S45-A3b 字体链首选 Heiti SC（与 ASS Fontname 同族），且页面无 pageerror', async () => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(mountInPage, {
    bundle: BUNDLE_URL,
    canvas: { w: 1280, h: 720 },
    rect: stageRectIn({ w: 1280, h: 720 }),
    text: LONG
  });
  const dom = await page.evaluate(readDomInPage);
  assert.match(dom.fontFamily, /^"?Heiti SC"?/, `预览族表首位必须是 Heiti SC：${dom.fontFamily}`);
  const check = await page.evaluate(() => ({
    heiti: document.fonts.check('32px "Heiti SC"', '中英混排 Subtitle 2026'),
    style: getComputedStyle(document.querySelector('[data-subtitle-text]')).fontFamily
  }));
  assert.equal(check.heiti, true, '"Heiti SC" 在本机必须可用（否则回退链会改字宽）');
  assert.deepEqual(pageErrors, [], `不该有 pageerror：${JSON.stringify(pageErrors)}`);
});
