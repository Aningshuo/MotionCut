// @ts-nocheck —— 以 node --test 的运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * 预览侧接关键帧（R15 · R30-073 · A）
 *
 * 这里锁四件事：
 *
 * 1. **只有一份实现**：舞台运行时里注入的，就是 `layers/apply-keyframes.mjs` 的
 *    `syncKeyframeFrame` 源码原文（`Function.prototype.toString`）；导出侧
 *    （`render/stage-capture.mjs`）`import` 的是同一个函数对象。
 * 2. **源码能塞进模板串**：函数体里不能有反引号或 `${`（有就会把 STAGE_RUNTIME 撕成两半，
 *    浏览器里表现为整页白屏，光看 diff 看不出来）——这一条 R15 现场踩过。
 * 3. **真服务器下发的页面带着编译产物**：`compileKeyframes(doc)` 的 css/plans 进
 *    `__STAGE_CONFIG__.keyframes`；没有 kf 的工程是 `{css:'',plans:[]}`。
 * 4. **`</script>` 不会撕页面**：css 里的 `<` 被转义。
 *
 * 真浏览器里的「播放 / 暂停 / seek 都写时钟」由 `scripts/m120-e05-preview-kf.mjs` 取证。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { syncKeyframeFrame } from '../../../layers/apply-keyframes.mjs';
import { compileKeyframes } from '../../../film-core/keyframes.mjs';
import { KEYFRAME_FRAME_SOURCE, renderStagePage, startContentOrigin } from '../content-origin.mjs';

const BACKTICK = String.fromCharCode(96);
const DOLLAR_BRACE = `$${'{'}`;

/** 一份带 kf 的 doc（两段不同起点，覆盖「同选择器不同 at」）。 */
const DOC = {
  stage: { w: 1280, h: 720 },
  tracks: [
    {
      clips: [
        {
          id: 'a',
          at: 0,
          time: [0, 4],
          overrides: [
            {
              at: '#title',
              kf: [
                { t: 0, style: { opacity: '0' } },
                { t: 1, style: { opacity: '1' } },
              ],
            },
          ],
        },
        {
          id: 'b',
          at: 2,
          time: [0, 4],
          overrides: [
            {
              at: '#sub',
              kf: [
                { t: 0, style: { opacity: '0.2' } },
                { t: 1, style: { opacity: '0.9' } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

test('A0 注入的是同一个函数（不是手抄副本）', () => {
  assert.equal(KEYFRAME_FRAME_SOURCE, syncKeyframeFrame.toString());
  assert.equal(KEYFRAME_FRAME_SOURCE.slice(0, 33), 'function syncKeyframeFrame(arg) {');
});

test('A1 源码里没有反引号 / ${（否则会把 STAGE_RUNTIME 撕开）', () => {
  assert.equal(KEYFRAME_FRAME_SOURCE.includes(BACKTICK), false, '函数体（含注释）里不许出现反引号');
  assert.equal(KEYFRAME_FRAME_SOURCE.includes(DOLLAR_BRACE), false, '函数体里不许出现 ${');
});

test('A2 没有 kf 的工程：配置是空壳（页内一个节点都不建）', () => {
  const page = renderStagePage({ projectId: 'p1', studioOrigin: 'http://127.0.0.1:1', fit: 'contain' });
  assert.match(page, /"keyframes":\{"css":"","plans":\[\]\}/);
});

test('A3 有 kf 的工程：配置里是 compileKeyframes 的产物（与导出同源）', async () => {
  const compiled = compileKeyframes(DOC);
  assert.notEqual(compiled.css, '', '夹具本身要能编译出 CSS');
  assert.equal(compiled.plans.length, 2, '两段不同起点 → 两条计划');

  const projectId = 'p1';
  const registry = {
    get: () => ({ dir: '/tmp/definitely-not-read', projectId }),
    docOf: () => ({ hash: 'h', doc: DOC }),
  };
  const origin = await startContentOrigin({ registry, port: 0, host: '127.0.0.1' });
  try {
    const response = await fetch(`${origin.origin}/p/${projectId}/__stage__.html`);
    assert.equal(response.status, 200);
    const html = await response.text();

    const config = JSON.parse(html.match(/window\.__STAGE_CONFIG__ = (\{.*?\});<\/script>/s)[1]);
    assert.equal(config.keyframes.css, compiled.css, '下发的 css 必须与 compileKeyframes 逐字节相同');
    assert.deepEqual(
      config.keyframes.plans,
      compiled.plans.map((plan) => ({ clipId: plan.clipId, at: plan.at, hash: plan.hash })),
    );
    /* 两段都叫 `#box`：计划必须各自带上自己的 clipId，否则会互相串规则。 */
    assert.deepEqual(
      config.keyframes.plans.map((plan) => plan.clipId).sort(),
      ['a', 'b'],
    );

    /* 运行时脚本里必须真的有那段源码。 */
    const runtime = await fetch(`${origin.origin}/p/${projectId}/__stage__/runtime.js`).then((r) => r.text());
    assert.ok(runtime.includes('data-ov-kf-at'), '运行时里没有打标记的代码');
    assert.ok(runtime.includes('var syncKeyframeFrame = function syncKeyframeFrame'), '运行时里没有注入 syncKeyframeFrame');
  } finally {
    await origin.close();
  }
});

test('A4 css 里的 `</script>` 不会撕开页面（< 全部转义）', () => {
  const page = renderStagePage({
    projectId: 'p1',
    studioOrigin: '',
    fit: 'contain',
    keyframes: { css: '@keyframes x{}</script><script>alert(1)</script>', plans: [] },
  });
  assert.equal(page.includes('</script><script>alert(1)'), false);
  assert.ok(page.includes('\\u003c/script'), '写成 \\u003c 才安全');
});
