// @ts-nocheck —— 以 node --test 的运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S83 · 舞台覆盖运行时由服务端下发（解 BLK-R42-1）。
 *
 * 这里锁四件事：
 *
 * 1. `renderStagePage()` 产出的页面里，`__STAGE_CONFIG__.layers` **有三段源码**，
 *    每一段 `new Function('return (' + src + ')')` 都能拿回函数；
 * 2. 按舞台 `runnerFor()` 的同一句构造出的 runner，能真的把 `clip-path` 写进 DOM
 *    （最小 DOM 桩，不开浏览器）；
 * 3. 拿不到运行时不再静默：`frameOutcome()` 会把 `NO_LAYER_RUNTIME` 变成帧级错误，
 *    同时保留场景自己的错误码；
 * 4. 内联进舞台模板串的那份源码不自带反引号 / `${`（否则会把模板串撕成两半，
 *    浏览器里表现为整页白屏，看 diff 看不出来）。
 *
 * 真导出（成片里真的能看到裁剪、CSP 页面真的失败）由 `scripts/s81-clip-pixel.mjs`
 * 与 `scripts/s83-export-errors.mjs` 在浏览器里验。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FRAME_OUTCOME_SOURCE,
  LAYER_SOURCES,
  frameOutcome,
  renderStagePage,
} from '../content-origin.mjs';

const BACKTICK = String.fromCharCode(96);
const DOLLAR_BRACE = `$${'{'}`;

/** 从页面里把 `window.__STAGE_CONFIG__` 那段 JSON 抠出来。 */
function stageConfigOf(html) {
  const match = /window\.__STAGE_CONFIG__ = (.*?);<\/script>/s.exec(html);
  assert.ok(match, '页面里找不到 __STAGE_CONFIG__');
  return JSON.parse(/** @type {string} */ (match[1]));
}

/** 最小 DOM 桩：只实现 applyOverrideEntries 用到的那几个口子。 */
function fakeDom(ids) {
  const elements = new Map();
  for (const id of ids) {
    const style = {
      values: /** @type {Record<string, string>} */ ({}),
      setProperty(name, value) {
        this.values[name] = value;
      },
      removeProperty(name) {
        delete this.values[name];
      },
      getPropertyValue(name) {
        return this.values[name] ?? '';
      },
    };
    elements.set(id, {
      tagName: 'DIV',
      style,
      attrs: /** @type {Record<string, string>} */ ({ id }),
      textContent: '',
      getAttribute(name) {
        return this.attrs[name] ?? null;
      },
      setAttribute(name, value) {
        this.attrs[name] = value;
      },
      removeAttribute(name) {
        delete this.attrs[name];
      },
    });
  }
  return {
    documentElement: { style: { setProperty() {}, removeProperty() {} }, setAttribute() {} },
    querySelectorAll(selector) {
      const direct = /^#([\w-]+)$/.exec(selector);
      if (direct) {
        const el = elements.get(direct[1]);
        return el === undefined ? [] : [el];
      }
      /* `[data-ov-transform]` 之类的清除查询：桩里没有历史元素，返回空。 */
      return [];
    },
    elements,
  };
}

test('S83-1 renderStagePage 下发的三段源码都非空且能 eval', () => {
  const html = renderStagePage({ projectId: 'p-s83', studioOrigin: 'http://127.0.0.1:9', fit: 'contain' });
  const config = stageConfigOf(html);

  assert.deepEqual(Object.keys(config.layers).sort(), ['applyOverrideEntries', 'readLayer', 'snapshotLayers']);
  for (const [name, source] of Object.entries(config.layers)) {
    assert.equal(typeof source, 'string', `${name} 必须是字符串`);
    assert.ok(source.length > 200, `${name} 源码太短，像是空壳`);
    const fn = new Function(`return (${source})`)();
    assert.equal(typeof fn, 'function', `${name} eval 回来不是函数`);
  }

  /* 这段 JSON 自己不许带 `</script>`：带上就会把标签提前闭合。 */
  const raw = /window\.__STAGE_CONFIG__ = (.*?);<\/script>/s.exec(html)?.[1] ?? '';
  assert.equal(raw.includes('</script>'), false, 'config 里出现 </script> 会截断页面');
  /* `<` 一律转义成 \u003c，源码里的比较运算符也不会被浏览器当成标签。 */
  assert.equal(raw.includes(String.fromCharCode(92) + 'u003c'), true, 'config 里的 < 应当被转义');
  /* 与导出给 UI 的是同一份（同一个函数对象）。 */
  assert.equal(config.layers.applyOverrideEntries, LAYER_SOURCES.applyOverrideEntries);
});

test('S83-2 用舞台同一句构造出的 runner 能把 clip-path 写进 DOM', () => {
  const config = stageConfigOf(renderStagePage({ projectId: 'p-s83', studioOrigin: 'http://127.0.0.1:9', fit: 'contain' }));
  /* 舞台 runnerFor() 的原句：new win.Function('arg', 'return (' + source + ')(arg);') */
  const runner = new Function('arg', `return (${config.layers.applyOverrideEntries})(arg);`);
  const dom = fakeDom(['card', 'badge']);
  const previous = /** @type {any} */ (globalThis).document;
  /** @type {any} */ (globalThis).document = dom;
  try {
    const result = runner([{ at: '#card', style: { 'clip-path': 'inset(16px 24px 8px 40px)' } }]);
    assert.equal(result.applied, 1);
    assert.deepEqual(result.missed, []);
    assert.equal(dom.elements.get('card').style.values['clip-path'], 'inset(16px 24px 8px 40px)');
    /* 没点到的东西不许被顺手改掉。 */
    assert.deepEqual(dom.elements.get('badge').style.values, {});
  } finally {
    /** @type {any} */ (globalThis).document = previous;
  }
});

test('S83-3 拿不到运行时不再静默：frameOutcome 把它变成帧级错误', () => {
  const failure = { code: 'NO_LAYER_RUNTIME', message: '片段 page-main 有 2 条覆盖，但场景里没有覆盖运行时（layerSources 为空）', clipId: 'page-main' };

  const withRuntime = frameOutcome([{ ok: true }], []);
  assert.equal(withRuntime.ok, true);
  assert.deepEqual(withRuntime.errors, []);

  const withoutRuntime = frameOutcome([{ ok: true }], [failure]);
  assert.equal(withoutRuntime.ok, false, '没有运行时必须 ok:false');
  assert.equal(withoutRuntime.errors.length, 1);
  assert.equal(withoutRuntime.errors[0].code, 'NO_LAYER_RUNTIME');

  /* 场景自己失败 + 覆盖失败：两个都要在，不许互相覆盖。 */
  const both = frameOutcome([{ ok: false, error: { code: 'FRAME_THREW', message: '场景炸了' } }], [failure]);
  assert.equal(both.ok, false);
  assert.deepEqual(
    both.errors.map((item) => item.code),
    ['FRAME_THREW', 'NO_LAYER_RUNTIME'],
  );

  /* 运行时里内联的就是这份源码：同一份逻辑，不许各写一套。 */
  const inline = new Function(`return (${FRAME_OUTCOME_SOURCE})`)();
  assert.deepEqual(inline([{ ok: true }], [failure]).errors.map((item) => item.code), ['NO_LAYER_RUNTIME']);
});

test('S83-4 内联源码能安全塞进舞台模板串', () => {
  /* 只有 frameOutcome 是内联进 STAGE_RUNTIME 那段模板串的；三段图层源码走 JSON 配置，
     反引号在那里无害（JSON 字符串不参与模板解析）。 */
  for (const [name, source] of [['FRAME_OUTCOME_SOURCE', FRAME_OUTCOME_SOURCE]]) {
    assert.equal(source.includes(BACKTICK), false, `${name} 里不能有反引号`);
    assert.equal(source.includes(DOLLAR_BRACE), false, `${name} 里不能有 \${`);
  }
});
