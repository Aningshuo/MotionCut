// @ts-nocheck —— 验收以 node --test 的断言为准；产品模块仍由 tsc 严格检查。
/**
 * S39-SUBTITLE-MEASURE 回归（B-SUB1-R20-020）
 *
 * **S45 之后这条不变量的机制变了**：高度不再由隐藏节点量出来（`getBoundingClientRect().height`
 * 在祖先 `transform: scale(N)` 下会被放大 N 倍，那正是 S39 修过一次的坑），而是
 * `lines.length × lineHeightPx`，行本身由 `planSubtitleLines()` 纯计算得出 —— 与 DOM、与
 * 祖先变换**没有关系**。所以这个文件现在守的是「同一个输入在任何缩放下都得到同一组行」，
 * 顺带证明 S39 的病不会再复发。断言一字未改，只补了 `state.plan` 与 DOM 文本的对照。
 *
 * 一句话：**覆盖层量文字高度不能受祖先 transform 影响**。
 *
 * 夹具 `tests/fixtures/scenes/subtitle-scaled.html` 把 1280×720 的 `#stage` 放进
 * `transform: scale(N)` 的容器里，覆盖层挂在 `#stage` 上。同一句 12 字的字幕在 N=1/2/3
 * 下必须量出同样的行数与字号；超长文本在 N=3 下仍必须判 overflow（修不能修成「永不溢出」）。
 *
 * 运行：node --test --test-concurrency=1 packages/layers/subtitle-measure.test.mjs（env 由 test-env.mjs 自动准备；`OPENCUT_ENV_JSON` 可显式覆盖）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveLayerTestEnv } from './test-env.mjs';

import { build as esbuild } from 'esbuild';

import { SceneHost, REPO_ROOT } from '../scene-runtime/host.mjs';

const TEST_ENV = await resolveLayerTestEnv({ suite: 'subtitle-measure' });
const RUN_ROOT = TEST_ENV.runRoot;
const BUNDLE_ABS = path.join(RUN_ROOT, 'tmp/s39-test/subtitle.mjs');
const BUNDLE_URL = '/' + path.relative(REPO_ROOT, BUNDLE_ABS).split(path.sep).join('/');
const FIXTURE = 'tests/fixtures/scenes/subtitle-scaled.html';

const SHORT = '这是一句用于验收的字幕';
const LONG =
  '这一句是故意写超长的字幕文本，用来确认修完量法之后溢出判定没有被弄哑，' +
  '在缩放容器里仍然要把超过两行的内容截断并加上省略号，' +
  '否则用户会以为整段话都能显示出来，实际导出时才发现被裁掉了，' +
  '那种问题在成片里几乎无法补救，只能在编辑期就明确提示。';

/** @type {SceneHost} */
let host;
let handle;
/** @type {any} */
let page;

before(async () => {
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
  const env = JSON.parse(await fs.readFile(path.join(RUN_ROOT, 'env.json'), 'utf8'));
  host = await new SceneHost({ port: Number(env.sceneOrigin ?? 59375), viewport: { width: 1440, height: 900 } }).start();
  handle = await host.open(FIXTURE);
  page = handle.page;
});

after(async () => {
  if (handle) await handle.dispose();
  if (host) await host.stop();
});

/**
 * 页内：设 `#wrap` 的缩放、在 `#stage` 上挂覆盖层。
 * `getStage()` 给**舞台坐标**（1280×720）——覆盖层的几何口径，与祖先缩放无关。
 * 注意不能在这里 `await setTimeout`：SceneHost 装了受控时钟，页内定时器只由 settle() 推进。
 */
async function mountAt(deps) {
  const wrap = document.getElementById('wrap');
  wrap.style.transform = `scale(${deps.scale})`;
  const mod = await import(deps.bundle);
  if (window.__sub) {
    window.__sub.destroy();
    window.__sub = null;
  }
  const stage = document.getElementById('stage');
  window.__errors = [];
  window.__sub = mod.mountSubtitleOverlay(stage, {
    getCues: () => [{ start: 1, end: 9, text: deps.text }],
    getTime: () => 1,
    getStage: () => ({ x: 0, y: 0, w: 1280, h: 720 }),
    onError: (info) => window.__errors.push(info)
  });
  window.__sub.render();
  return { state: window.__sub.getState(), errors: window.__errors };
}

test('S39-A3 同一句话在 scale(1/2/3) 下量出同样的行数与字号', async () => {
  const rows = [];
  for (const scale of [1, 2, 3]) {
    const { state } = await page.evaluate(mountAt, { bundle: BUNDLE_URL, scale, text: SHORT });
    rows.push({ scale, text: state.text, lines: state.lines, fontSize: state.fontSize, overflow: state.overflow, plan: state.plan });
  }
  assert.deepEqual(
    rows.map((r) => r.text),
    [SHORT, SHORT, SHORT],
    `三档都必须显示完整句（旧量法在 scale(3) 下会截成「…」）：${JSON.stringify(rows)}`
  );
  assert.deepEqual(rows.map((r) => r.lines), [1, 1, 1], `行数必须一致：${JSON.stringify(rows)}`);
  /* S47 起取整到 ASS 的整数口径；不变量本身没变：**只由舞台高决定**，与祖先 transform 无关 */
  /* R32：0.045 → 0.04 之后 720p 是 29（原 32）；不变量不变。 */
  assert.deepEqual(rows.map((r) => r.fontSize), [29, 29, 29], '字号只由舞台高决定，不该随缩放变');
  assert.deepEqual(rows.map((r) => r.overflow), [false, false, false]);
  /* S45：行来自计划层（不是量出来的）——三档都必须报同一组行，且 DOM 文本 = lines.join('\n') */
  assert.deepEqual(rows.map((r) => r.plan?.lines), [[SHORT], [SHORT], [SHORT]]);
});

test('S39-A4 超长文本在 scale(3) 下仍判 overflow，且截断结果与 scale(1) 相同', async () => {
  const at1 = (await page.evaluate(mountAt, { bundle: BUNDLE_URL, scale: 1, text: LONG })).state;
  const at3 = (await page.evaluate(mountAt, { bundle: BUNDLE_URL, scale: 3, text: LONG })).state;
  assert.equal(at3.overflow, true, '修完不能变成「永不溢出」');
  assert.equal(at3.lines, 2, `maxLines=2：${JSON.stringify({ lines: at3.lines, text: at3.text })}`);
  assert.ok(at3.text.endsWith('…'), `截断要带省略号：${at3.text.slice(-8)}`);
  assert.equal(at3.text, at1.text, '计划层是纯函数 → 两档截断结果必须逐字相同');
  assert.equal(at3.lines, at1.lines);
  assert.deepEqual(at3.plan.lines, at1.plan.lines, '两档的计划行必须完全一致');
  assert.equal(at3.text, at3.plan.lines.join('\n'), 'DOM 文本就是计划行（\n 连接）');
});

test('S39-A5 挂载与三档切换过程中没有 pageerror，也没有报错事件', async () => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  const seen = [];
  for (const scale of [1, 2, 3, 2, 1]) {
    const { state, errors } = await page.evaluate(mountAt, { bundle: BUNDLE_URL, scale, text: SHORT });
    seen.push(...errors);
    assert.equal(state.text, SHORT);
  }
  assert.deepEqual(seen, [], 'onError 不应被触发（cue 合法）');
  assert.deepEqual(pageErrors, []);
  await page.evaluate(() => window.__sub?.destroy());
});
