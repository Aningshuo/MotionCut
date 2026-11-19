// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S3 验收 A6 / A7 / A8：切片段刷新 + 迟到回包（真实浏览器）
 *
 * 运行：node --test --test-concurrency=1 packages/layers/switch.test.mjs
 *
 * 夹具 switch-ab.html 有两个真实场景片段 A/B；切换用页面内 showScene() 改 DOM。
 * 迟到回包：A 的 discover 结果延迟 300ms 才被 controller 收到。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SceneHost, REPO_ROOT } from '../scene-runtime/host.mjs';
import { resolveLayerTestEnv } from './test-env.mjs';

const { discover } = await import(new URL('./discover.ts', import.meta.url).href);
const { ClipSwitchController } = await import(new URL('./clip-switch.ts', import.meta.url).href);

const PORT = Number(process.env.FILM_SWITCH_PORT || 59376);
const SCENE = 'tests/fixtures/scenes/switch-ab.html';
const TEST_ENV = await resolveLayerTestEnv({ suite: 'switch' });
const EVIDENCE_DIR = TEST_ENV.evidenceDir;
const evidence = { batch: 'B-SUB1-R2-002', suite: 'switch.test.mjs', cases: {} };

let host;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function save() {
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(path.join(EVIDENCE_DIR, 'switch.json'), JSON.stringify(evidence, null, 2) + '\n');
}

/** 建两个不可见（opacity:0，discover 会跳过）的状态显示节点，把 controller 状态写进真实 DOM。 */
async function makeRenderer(page) {
  await page.evaluate(() => {
    for (const id of ['ui-layer-list', 'ui-inspector-target']) {
      let el = document.getElementById(id);
      if (!el) {
        el = document.createElement('div');
        el.id = id;
        el.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none';
        document.body.appendChild(el);
      }
    }
  });
  return async (state) => {
    await page.evaluate((s) => {
      const list = document.getElementById('ui-layer-list');
      const target = document.getElementById('ui-inspector-target');
      list.textContent = s.layers.map((l) => `${l.clipId}:${l.name}`).join('|');
      target.textContent = `${s.inspector.clipId}:${s.inspector.at ?? ''}`;
    }, state);
  };
}

before(async () => {
  host = await new SceneHost({ port: PORT }).start();
  evidence.host = { port: host.http.port, browser: host.browserVersion };
});

after(async () => {
  evidence.finishedAt = new Date().toISOString();
  await save();
  if (host) await host.stop();
});

const namesOf = (state) => state.layers.map((l) => l.name);

test('S3-A6 切 A→B：层列表与检查器目标都变成 B（真实 DOM 切换）', async () => {
  const h = await host.open(SCENE);
  try {
    const render = await makeRenderer(h.page);
    const ctrl = new ClipSwitchController({ discover: (clipId) => discover(h.page, clipId, 0) });

    await h.page.evaluate(() => window.showScene('a'));
    const a = await ctrl.switchTo('a');
    assert.ok(a.applied);
    assert.equal(ctrl.state.status, 'ready');
    const aNames = namesOf(ctrl.state);
    assert.ok(aNames.includes('A标题'), `A 层=${aNames.join(',')}`);
    assert.ok(!aNames.includes('B标题'));

    await h.page.evaluate(() => window.showScene('b'));
    const b = await ctrl.switchTo('b');
    assert.ok(b.applied);
    assert.equal(ctrl.state.clipId, 'b');
    assert.equal(ctrl.state.inspector.clipId, 'b');

    const bNames = namesOf(ctrl.state);
    assert.ok(bNames.includes('B标题'), `B 层=${bNames.join(',')}`);
    assert.ok(!bNames.includes('A标题'), `B 状态残留 A 层：${bNames.join(',')}`);
    assert.ok(ctrl.state.layers.every((l) => l.clipId === 'b'));

    // 选中 B 的一个层，检查器目标必须跟到 B
    const bTitle = ctrl.state.layers.find((l) => l.name === 'B标题');
    ctrl.select(bTitle.at);
    assert.equal(ctrl.state.inspector.clipId, 'b');
    assert.equal(ctrl.state.inspector.at, bTitle.at);

    await render(ctrl.state);
    const dom = await h.page.evaluate(() => ({
      list: document.getElementById('ui-layer-list').textContent,
      target: document.getElementById('ui-inspector-target').textContent,
      scene: window.currentScene()
    }));
    assert.ok(dom.list.includes('B标题') && !dom.list.includes('A标题'), `DOM 层列表=${dom.list}`);
    assert.ok(dom.target.startsWith('b:'), `DOM 检查器目标=${dom.target}`);
    assert.equal(dom.scene, 'b');

    evidence.cases['S3-A6'] = {
      status: 'PASS',
      aLayers: aNames,
      bLayers: bNames,
      inspector: ctrl.state.inspector,
      dom
    };
  } finally {
    await h.dispose();
  }
  await save();
});

test('S3-A7 A 的迟到响应（300ms）不覆盖 B', async () => {
  const h = await host.open(SCENE);
  try {
    const render = await makeRenderer(h.page);
    const resolved = [];
    const ctrl = new ClipSwitchController({
      discover: async (clipId) => {
        const p = discover(h.page, clipId, 0);
        if (clipId === 'a') await sleep(300);
        const res = await p;
        resolved.push({ clipId, names: 'error' in res ? [] : res.layers.map((l) => l.name) });
        return res;
      }
    });

    await h.page.evaluate(() => window.showScene('a'));
    const pa = ctrl.switchTo('a'); // A 的响应会迟到 300ms
    await sleep(30);
    await h.page.evaluate(() => window.showScene('b'));
    const pb = ctrl.switchTo('b');
    const [, rb] = await Promise.all([pa, pb]);
    assert.ok(rb.applied);

    // 等过了 A 的延迟，确认它真的迟到且被丢弃
    await sleep(350);
    assert.equal(ctrl.state.clipId, 'b');
    assert.equal(ctrl.state.status, 'ready');
    const names = namesOf(ctrl.state);
    assert.ok(names.includes('B标题'), `最终层=${names.join(',')}`);
    assert.ok(!names.includes('A标题'), `A 的迟到响应覆盖了 B：${names.join(',')}`);
    assert.equal(ctrl.state.inspector.clipId, 'b');
    assert.ok(ctrl.state.droppedResponses >= 1, `dropped=${ctrl.state.droppedResponses}`);

    const aResolved = resolved.find((r) => r.clipId === 'a');
    assert.ok(aResolved.names.includes('A标题'), `A 的响应本身不含 A 层：${JSON.stringify(aResolved)}`);

    await render(ctrl.state);
    const dom = await h.page.evaluate(() => ({
      list: document.getElementById('ui-layer-list').textContent,
      target: document.getElementById('ui-inspector-target').textContent
    }));
    assert.ok(!dom.list.includes('A标题'), `迟到回包污染 DOM：${dom.list}`);
    assert.ok(dom.target.startsWith('b:'));

    /*
     * 因果对照（07 图）：同样的 A 迟到 300ms，但换成**没有代际令牌**的朴素写法。
     * 预期：目标已经切到 B，层列表却是 A 的 —— 正是 07 图「左树与右检查器目标不一致」。
     */
    const naive = { clipId: '', layers: [] };
    const naiveDiscover = async (clipId) => {
      const p = discover(h.page, clipId, 0);
      if (clipId === 'a') await sleep(300);
      return p;
    };
    const naiveSwitch = async (clipId) => {
      naive.clipId = clipId; // 目标立即切换
      const res = await naiveDiscover(clipId);
      naive.layers = 'error' in res ? [] : res.layers.map((l) => ({ clipId, name: l.name }));
    };
    await h.page.evaluate(() => window.showScene('a'));
    const na = naiveSwitch('a');
    await sleep(30);
    await h.page.evaluate(() => window.showScene('b'));
    const nb = naiveSwitch('b');
    await Promise.all([na, nb]);
    const naiveNames = naive.layers.map((l) => l.name);
    const naiveMismatch = naive.clipId === 'b' && naiveNames.some((n) => n === 'A标题');
    assert.ok(naiveMismatch, `朴素写法未复现风险：target=${naive.clipId} layers=${naiveNames.join(',')}`);

    evidence.cases['S3-A7'] = {
      status: 'PASS',
      delayMs: 300,
      resolved,
      finalLayers: names,
      droppedResponses: ctrl.state.droppedResponses,
      inspector: ctrl.state.inspector,
      dom,
      causalContrast: {
        naive: { target: naive.clipId, layers: naiveNames, mismatch: naiveMismatch },
        generationToken: { target: ctrl.state.clipId, layers: names, mismatch: false }
      }
    };
  } finally {
    await h.dispose();
  }
  await save();
});

test('S3-A8 快速 A→B→A：最终回到 A，无 B 残留', async () => {
  const h = await host.open(SCENE);
  try {
    const render = await makeRenderer(h.page);
    const delays = [300, 120, 0];
    let i = 0;
    const resolved = [];
    const ctrl = new ClipSwitchController({
      discover: async (clipId) => {
        const delay = delays[i++] ?? 0;
        const p = discover(h.page, clipId, 0);
        if (delay) await sleep(delay);
        const res = await p;
        resolved.push({ clipId, delay, names: 'error' in res ? [] : res.layers.map((l) => l.name) });
        return res;
      }
    });

    await h.page.evaluate(() => window.showScene('a'));
    const p1 = ctrl.switchTo('a');
    await sleep(20);
    await h.page.evaluate(() => window.showScene('b'));
    const p2 = ctrl.switchTo('b');
    await sleep(20);
    await h.page.evaluate(() => window.showScene('a'));
    const p3 = ctrl.switchTo('a');
    const outcomes = await Promise.all([p1, p2, p3]);

    assert.equal(outcomes[2].applied, true, '最后一次 A 没生效');
    assert.equal(ctrl.state.clipId, 'a');
    assert.equal(ctrl.state.generation, 3);
    const names = namesOf(ctrl.state);
    assert.ok(names.includes('A标题'), `最终层=${names.join(',')}`);
    assert.ok(!names.includes('B标题'), `B 残留：${names.join(',')}`);
    assert.ok(ctrl.state.layers.every((l) => l.clipId === 'a'), '有非 a 片段的层');
    assert.equal(ctrl.state.inspector.clipId, 'a');
    assert.ok(ctrl.state.droppedResponses >= 2, `dropped=${ctrl.state.droppedResponses}`);

    // B 的迟到响应确实存在过，只是被丢弃
    assert.ok(resolved.some((r) => r.clipId === 'b' && r.names.includes('B标题')), 'B 响应没拿到 B 层');

    await render(ctrl.state);
    const dom = await h.page.evaluate(() => ({
      list: document.getElementById('ui-layer-list').textContent,
      target: document.getElementById('ui-inspector-target').textContent
    }));
    assert.ok(!dom.list.includes('B标题'), `B 残留进 DOM：${dom.list}`);
    assert.ok(dom.target.startsWith('a:'));

    evidence.cases['S3-A8'] = {
      status: 'PASS',
      delays,
      resolved,
      finalLayers: names,
      generation: ctrl.state.generation,
      droppedResponses: ctrl.state.droppedResponses,
      dom
    };
  } finally {
    await h.dispose();
  }
  await save();
});
