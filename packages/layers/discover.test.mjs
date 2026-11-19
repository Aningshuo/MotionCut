/**
 * WP12 验收（L1–L8）
 *
 * 运行：node --test packages/layers/discover.test.mjs
 * 页面用 WP04 的 SceneHost（受控时钟 + 127.0.0.1 静态服务），层逻辑用真实浏览器 DOM。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SceneHost, startStaticServer, REPO_ROOT } from '../scene-runtime/host.mjs';
import { resolveLayerTestEnv } from './test-env.mjs';
import { judgeAgainstBaseline, summarize } from './perf-budget.mjs';

const { discover } = await import(new URL('./discover.ts', import.meta.url).href);
const { locate } = await import(new URL('./locate.ts', import.meta.url).href);
const { LAYER_CAPABILITY } = await import(new URL('../../contracts/layers.ts', import.meta.url).href);

const TEST_ENV = await resolveLayerTestEnv({ suite: 'discover' });
const EVIDENCE_DIR = TEST_ENV.evidenceDir;
const EVIDENCE_FILE = path.join(EVIDENCE_DIR, 'layers-test.json');
const PORT = Number(process.env.FILM_LAYER_PORT || 59374);

/** @type {Record<string, any>} */
const evidence = {
  batch: 'B-SUB1-R2-001',
  suite: 'discover.test.mjs',
  startedAt: new Date().toISOString(),
  cases: {}
};
/** @type {SceneHost} */
let host;
/** @type {Awaited<ReturnType<typeof startStaticServer>>} */
let cross;

async function saveEvidence() {
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(EVIDENCE_FILE, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
}

/**
 * @param {any} res
 * @param {string} label
 * @returns {import('./discover').DiscoverResult}
 */
function assertNoError(res, label) {
  if ('error' in res) {
    assert.fail(`${label} 返回错误 ${res.error.code}: ${res.error.message}`);
  }
  return res;
}

before(async () => {
  host = await new SceneHost({ port: PORT }).start();
  // 第二个 origin（不同端口）用于跨源 iframe。
  cross = await startStaticServer(REPO_ROOT);
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  evidence.host = { port: host.http.port, crossOrigin: cross.origin, browser: host.browserVersion };
});

after(async () => {
  evidence.finishedAt = new Date().toISOString();
  await saveEvidence();
  if (host) await host.stop();
  if (cross) await cross.close();
});

const CN = 'tests/fixtures/scenes/cn-nested.html';

test('L1 中文标题页：找到 text 层，连续两次 discover 的 at 完全一致', async () => {
  const h = await host.open(CN);
  try {
    const a = assertNoError(await discover(h.page, 'clip-cn', 1), 'discover#1');
    const b = assertNoError(await discover(h.page, 'clip-cn', 1), 'discover#2');

    const title = a.layers.find((l) => l.kind === 'text' && l.name.includes('中文标题'));
    assert.ok(title, `未找到中文标题 text 层，层名=${a.layers.map((l) => l.name).join('|')}`);
    assert.ok(title.at.length > 0);

    assert.deepEqual(
      a.layers.map((l) => l.at),
      b.layers.map((l) => l.at),
      '两次 discover 的 at 序列不同'
    );
    assert.deepEqual(a.layers, b.layers, '两次 discover 的层对象不同');

    evidence.cases.L1 = { status: 'PASS', titleAt: title.at, titleName: title.name, layers: a.layers.length };
  } finally {
    await h.dispose();
  }
  await saveEvidence();
});

test('L2 嵌套 4 层：父子关系正确（parentAt 指得上），不重复计数', async () => {
  const h = await host.open(CN);
  try {
    const res = assertNoError(await discover(h.page, 'clip-cn', 1), 'discover');
    const ats = res.layers.map((l) => l.at);
    assert.equal(new Set(ats).size, ats.length, '存在重复 at（重复计数）');

    const byAt = new Map(res.layers.map((l) => [l.at, l]));
    const depths = [...new Set(res.layers.map((l) => l.depth))].sort((x, y) => x - y);
    assert.ok(depths.length >= 4, `可见层深度不足：${depths.join(',')}`);

    // 取最深的一条（h1/p 之一），沿 parentAt 走到根，至少 4 层
    const first = res.layers[0];
    assert.ok(first, 'empty layers');
    const deepest = res.layers.reduce((acc, l) => (l.depth > acc.depth ? l : acc), first);
    let cur = deepest;
    let hops = 0;
    while (cur && cur.parentAt) {
      const parent = byAt.get(cur.parentAt);
      assert.ok(parent, `parentAt 指不到层：${cur.parentAt}`);
      assert.ok(parent.depth === cur.depth - 1, `depth 不连续：${parent.depth} -> ${cur.depth}`);
      cur = parent;
      hops += 1;
    }
    assert.ok(hops >= 3, `父链只有 ${hops} 跳，未覆盖 4 层嵌套`);

    evidence.cases.L2 = {
      status: 'PASS',
      layers: res.layers.length,
      maxDepth: deepest.depth,
      chainHops: hops,
      chain: res.layers.filter((l) => l.depth <= deepest.depth).slice(0, 8).map((l) => ({ at: l.at, depth: l.depth, parentAt: l.parentAt }))
    };
  } finally {
    await h.dispose();
  }
  await saveEvidence();
});

test('L3 页面重载后按 at 重新定位：同一条目、名称/文本一致', async () => {
  const h = await host.open(CN);
  try {
    const first = assertNoError(await discover(h.page, 'clip-cn', 1), 'discover');
    const title = first.layers.find((l) => l.kind === 'text' && l.name.includes('中文标题'));
    assert.ok(title);

    await h.page.reload({ waitUntil: 'load' });
    const located = await locate(h.page, 'clip-cn', title.at);
    assert.ok(!('error' in located), `重载后定位失败：${located.error?.code}`);

    const h1 = await h.page.evaluate((at) => {
      const el = document.querySelector(at);
      return el ? (el.textContent || '').trim() : null;
    }, title.at);

    assert.equal(located.ref.at, title.at);
    assert.equal(located.ref.kind, 'text');
    assert.equal(located.ref.name, title.name);
    assert.ok(h1 && h1.includes('中文标题'), `重载后文本不一致：${h1}`);

    evidence.cases.L3 = { status: 'PASS', at: title.at, name: located.ref.name, text: h1 };
  } finally {
    await h.dispose();
  }
  await saveEvidence();
});

test('L4 删除目标元素后定位 → LAYER_GONE，不返回幽灵层', async () => {
  const h = await host.open(CN);
  try {
    const first = assertNoError(await discover(h.page, 'clip-cn', 1), 'discover');
    const title = first.layers.find((l) => l.kind === 'text' && l.name.includes('中文标题'));
    assert.ok(title);

    const removed = await h.page.evaluate((at) => {
      const el = document.querySelector(at);
      if (!el) return false;
      el.remove();
      return true;
    }, title.at);
    assert.ok(removed, '删除失败');

    const res = await locate(h.page, 'clip-cn', title.at);
    assert.ok('error' in res, '删除后不应定位成功');
    assert.equal(res.error.code, 'LAYER_GONE');

    const after = assertNoError(await discover(h.page, 'clip-cn', 1), 'discover after remove');
    assert.ok(!after.layers.some((l) => l.at === title.at), 'discover 仍返回幽灵层');

    evidence.cases.L4 = { status: 'PASS', at: title.at, code: res.error.code };
  } finally {
    await h.dispose();
  }
  await saveEvidence();
});

test('L5 两个同名同结构兄弟：at 用序号消歧，不出现 AMBIGUOUS', async () => {
  const h = await host.open('tests/fixtures/scenes/layers-siblings.html');
  try {
    const res = assertNoError(await discover(h.page, 'clip-sib', 0), 'discover');
    const spans = res.layers.filter((l) => l.kind === 'text' && l.name === '卡片');
    assert.equal(spans.length, 2, `同名 text 层数量 ${spans.length}`);
    const [s1, s2] = spans;
    assert.ok(s1 && s2);
    assert.notEqual(s1.at, s2.at, '同名兄弟的 at 未消歧');
    assert.match(s1.at, /nth-of-type\(1\)/);
    assert.match(s2.at, /nth-of-type\(2\)/);

    const l1 = await locate(h.page, 'clip-sib', s1.at);
    const l2 = await locate(h.page, 'clip-sib', s2.at);
    assert.ok(!('error' in l1), `第一张卡片定位失败 ${l1.error?.code}`);
    assert.ok(!('error' in l2), `第二张卡片定位失败 ${l2.error?.code}`);
    assert.equal(l1.ref.name, '卡片');
    assert.equal(l2.ref.name, '卡片');
    assert.ok(!('error' in l1 && l1.error.code === 'AMBIGUOUS'));

    evidence.cases.L5 = { status: 'PASS', at1: s1.at, at2: s2.at, code: 'none' };
  } finally {
    await h.dispose();
  }
  await saveEvidence();
});

test('L6 Canvas 内部 → NOT_EDITABLE + PIXEL_ONLY', async () => {
  const h = await host.open('tests/fixtures/scenes/canvas.html');
  try {
    const res = assertNoError(await discover(h.page, 'clip-canvas', 0), 'discover');
    const canvasLayer = res.layers.find((l) => l.at === '#cv');
    assert.ok(canvasLayer, '未返回 canvas 层');
    assert.equal(canvasLayer.kind, 'unknown');
    assert.ok(res.pixelOnly.some((p) => p.at === '#cv' && p.capability === 'PIXEL_ONLY'));
    assert.equal(LAYER_CAPABILITY.canvas, 'PIXEL_ONLY');

    const loc = await locate(h.page, 'clip-canvas', '#cv');
    assert.ok('error' in loc, 'canvas 不应被当成可编辑层');
    assert.equal(loc.error.code, 'NOT_EDITABLE');

    evidence.cases.L6 = {
      status: 'PASS',
      at: '#cv',
      pixelOnly: res.pixelOnly,
      code: loc.error.code,
      capability: LAYER_CAPABILITY.canvas
    };
  } finally {
    await h.dispose();
  }
  await saveEvidence();
});

test('L7 跨源 iframe → UNSUPPORTED，不尝试注入', async () => {
  const h = await host.open('tests/fixtures/scenes/layers-iframe.html');
  try {
    // 同源先确认可读，再切到第二个 origin（不同端口 = 跨源）。
    const childSrc = cross.origin + '/tests/fixtures/scenes/cn-nested.html';
    await h.page.evaluate((src) => {
      const f = /** @type {HTMLIFrameElement|null} */ (document.querySelector('#frame'));
      if (f) f.src = src;
    }, childSrc);
    // 等跨源文档真正开始加载（宿主侧真实等待，不用页面虚拟定时器）
    await h.page.waitForFunction(
      (src) => {
        const f = /** @type {HTMLIFrameElement|null} */ (document.querySelector('#frame'));
        return !!f && f.src === src && !!f.contentWindow;
      },
      childSrc,
      { timeout: 5000 }
    );
    await new Promise((r) => setTimeout(r, 400));

    const res = assertNoError(await discover(h.page, 'clip-frame', 0), 'discover');
    const unsupported = res.unsupported.find((u) => u.at === '#frame');
    assert.ok(unsupported, `未标记跨源 iframe：${JSON.stringify(res.unsupported)}`);
    assert.equal(unsupported.reason, 'CROSS_ORIGIN');
    assert.equal(unsupported.capability, 'UNSUPPORTED');

    // 不尝试注入：从外层读不到 contentDocument（null 或抛错）。
    const noAccess = await h.page.evaluate(() => {
      const f = /** @type {HTMLIFrameElement|null} */ (document.querySelector('#frame'));
      if (!f) return false;
      try {
        return !f.contentDocument;
      } catch {
        return true;
      }
    });
    assert.ok(noAccess, '跨源 iframe 竟可访问 contentDocument');

    evidence.cases.L7 = {
      status: 'PASS',
      at: '#frame',
      reason: unsupported.reason,
      capability: unsupported.capability,
      src: unsupported.src,
      contentDocumentAccessible: false
    };
  } finally {
    await h.dispose();
  }
  await saveEvidence();
});

test('L8 1,000 节点页面：discover 的 p95 对同页基线（floor 300ms），不冻结页面', async () => {
  const h = await host.open('tests/fixtures/scenes/layers-1000.html');
  /** @type {any} */
  let small = null;
  try {
    await h.page.waitForFunction(
      () => Number(document.body.dataset.nodeCount || 0) >= 1000,
      null,
      { timeout: 5000 }
    );

    /* S52：原来量的是**单次** `Date.now()` 差，一条 CDP 抖动就能顶到 400ms。
       现在 40 次取 p95，并配一个同操作、1/5 数据量（large-200.html）的基线。 */
    const SAMPLES = 40;
    const BASE_SAMPLES = 20;
    /** @param {import('playwright').Page} page @param {string} clip @param {number} n */
    const timeDiscover = async (page, clip, n) => {
      const out = [];
      for (let i = 0; i < n; i += 1) {
        const t0 = Date.now();
        assertNoError(await discover(page, clip, 0), 'discover');
        out.push(Date.now() - t0);
      }
      return out;
    };

    const times = await timeDiscover(h.page, 'clip-big', SAMPLES);
    const stats = summarize(times);
    const res = assertNoError(await discover(h.page, 'clip-big', 0), 'discover');

    small = await host.open('tests/fixtures/scenes/large-200.html');
    await small.page.waitForFunction(() => document.querySelectorAll('[data-at]').length >= 100, null, { timeout: 5000 });
    const baseStats = summarize(await timeDiscover(small.page, 'clip-small', BASE_SAMPLES));

    /* factor 8 而不是 4：基线与量测是 **5 倍**节点差（1000 vs 200），因子要跟数据量走
       （两条大场景用例是 2 倍数据、factor 4）。floor 仍是原来的 300ms，没动。 */
    const judge = judgeAgainstBaseline({
      measuredP95: stats.p95,
      baselineP95: baseStats.p95,
      floor: 300,
      factor: 8,
      slack: 2
    });
    process.stdout.write(`JUDGE discover ${judge.formula}\n`);

    assert.ok(judge.pass, `discover p95 超判据：${judge.formula}`);
    assert.ok(res.stats.nodes >= 1000, `节点数 ${res.stats.nodes} < 1000`);
    assert.ok(res.layers.length >= 1000, `层数 ${res.layers.length} < 1000`);

    // 页面仍可响应：rAF 内返回并执行表达式
    const responsive = await h.page.evaluate(
      () =>
        new Promise((resolve) => {
          const t = Date.now();
          requestAnimationFrame(() => resolve({ ms: Date.now() - t, sum: 1 + 1 }));
        })
    );
    assert.equal(responsive.sum, 2);
    assert.ok(responsive.ms < 1000, `页面疑似冻结：rAF ${responsive.ms}ms`);

    evidence.cases.L8 = {
      status: 'PASS',
      measured: stats,
      baseline: baseStats,
      judge,
      nodes: res.stats.nodes,
      layers: res.layers.length,
      rafMs: responsive.ms
    };
  } finally {
    await h.dispose();
  }
  await saveEvidence();
});
