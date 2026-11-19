// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S7-TREE-ROBUST 验收 A1 / A2 / A3 / A4
 *
 * A1 40 个类名：离线 cssEscape 与浏览器 CSS.escape 逐条相同；能进 class 的还要能用离线 pathOf
 *    在真实 DOM 里选中同一元素。
 * A2 10 个隐式闭合样例：离线 layerList 的 at 序列 == 浏览器 snapshotLayers 的 at 序列。
 * A3 5 个 malformed：有诊断、不抛异常；截断类 → complete=false，revalidate 拒绝（TREE_INCOMPLETE）。
 * A4 重复 id：DUPLICATE_ID 诊断；离线不能唯一定位；浏览器 locate 报 AMBIGUOUS。
 *
 * 运行：node --test --test-concurrency=1 packages/layers/tree-robust.test.mjs（env 由 test-env.mjs 自动准备；`OPENCUT_ENV_JSON` 可显式覆盖）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SceneHost, REPO_ROOT } from '../scene-runtime/host.mjs';
import { resolveLayerTestEnv } from './test-env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEST_ENV = await resolveLayerTestEnv({ suite: 'tree-robust' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');

const { parseScene, cssEscape, pathOf, resolveAt, layerList, SKIP_TAGS } = await import(
  new URL('./scene-tree.mjs', import.meta.url).href
);
const { revalidateOverrides } = await import(new URL('./revalidate.mjs', import.meta.url).href);
const { locate } = await import(new URL('./locate.ts', import.meta.url).href);
const { snapshotLayers } = await import(new URL('./dom-probe.mjs', import.meta.url).href);
const { discover } = await import(new URL('./discover.ts', import.meta.url).href);

const evidence = { batch: 'B-SUB1-R4-004R1', suite: 'tree-robust.test.mjs', cases: {}, startedAt: new Date().toISOString() };

/** @type {SceneHost} */
let host;

async function save() {
  evidence.finishedAt = new Date().toISOString();
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(path.join(EVIDENCE_DIR, 's7-tree-robust.json'), JSON.stringify(evidence, null, 2) + '\n');
}

before(async () => {
  const env = JSON.parse(await fs.readFile(process.env.OPENCUT_ENV_JSON ?? path.join(RUN_ROOT, 'env.json'), 'utf8'));
  host = await new SceneHost({ port: Number(env.studioPort) }).start();
});

after(async () => {
  await save();
  if (host) await host.stop();
});

async function withPage(html, fn) {
  const page = await host.context.newPage();
  try {
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

const doc = (body) =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>`;

/** 40 个类名 token：前导数字、`-` 后数字、标点、引号、非 ASCII、emoji 都在里面。 */
const TOKENS = [
  '1abc', '0start', '-1neg', '--1x', '-',
  'a:b', 'a.b', 'a b', 'a"b', "a'b",
  '中文', '标题-2', '🎬', 'a🎬', '#hash',
  '.dot', '[br]', '(paren)', '%pct', '+plus',
  '*star', '~tilde', '>gt', ',comma', '=eq',
  '@at', '!bang', '$dollar', '^caret', '&amp',
  '|pipe', '?q', '/slash', '\\back', '_under',
  '-a', 'a-b', 'A1', '--', '9'
];

/** @param {string} raw */
function attrValue(raw) {
  return raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

test('S7-A1 40 个类名：离线转义与浏览器 CSS.escape 逐条相同，路径能选中同一元素', async () => {
  const offline = TOKENS.map((t) => ({ token: t, escaped: cssEscape(t) }));
  const browser = await withPage(doc(''), (page) => page.evaluate((list) => list.map((t) => CSS.escape(t)), TOKENS));

  const rows = offline.map((row, i) => ({
    token: row.token,
    offline: row.escaped,
    browser: browser[i],
    equal: row.escaped === browser[i]
  }));
  const bad = rows.filter((r) => !r.equal);
  assert.deepEqual(bad, [], `转义不一致：${JSON.stringify(bad)}`);

  // 能进 class 的 token（不含空白）：离线 pathOf 必须能在真实 DOM 里选中同一个元素
  const usable = TOKENS.filter((t) => !/\s/.test(t));
  const html = doc(usable.map((t) => `<div class="${attrValue(t)}"></div>`).join(''));
  const tree = parseScene(html);
  assert.equal(tree.complete, true, JSON.stringify(tree.issues));
  const paths = layerList(tree).map((l) => l.at);
  assert.equal(paths.length, usable.length);

  const hits = await withPage(html, (page) =>
    page.evaluate((list) => {
      return list.map((p) => {
        const nodes = document.querySelectorAll(p);
        return { path: p, matches: nodes.length, cls: nodes.length === 1 ? nodes[0].getAttribute('class') : null };
      });
    }, paths)
  );

  const misses = usable
    .map((token, i) => ({ token, hit: hits[i] }))
    .filter((r) => !r.hit || r.hit.matches !== 1 || r.hit.cls !== r.token);
  assert.deepEqual(misses, [], `离线路径选不中：${JSON.stringify(misses)}`);

  evidence.cases['S7-A1'] = {
    ok: true,
    count: rows.length,
    rows,
    selectorCheck: { count: usable.length, sample: hits.slice(0, 4) }
  };
});

const IMPLICIT = [
  ['li 未闭合', '<ul><li>一<li>二<li>三</ul>'],
  ['p 未闭合', '<p>段一<p>段二'],
  ['块级关 p', '<div><p>文字<div>块</div></div>'],
  ['表格 tr/td 补 tbody', '<table><tr><td>1<td>2<tr><td>3</table>'],
  ['thead/tbody 混写', '<table><thead><tr><th>H</thead><tbody><tr><td>D</table>'],
  ['dt/dd 未闭合', '<dl><dt>术语<dd>解释<dt>第二个<dd>第二个解释</dl>'],
  ['option 未闭合', '<select><option>a<option>b</select>'],
  ['li 里的 p', '<ul><li><p>段落<li>第二项</ul>'],
  ['显式 tbody 缺闭合', '<table><tbody><tr><td>x</td></tr><tr><td>y</table>'],
  ['div 收尾关 h1/p', '<div><h1>标题<p>说明</div>']
];

test('S7-A2 10 个隐式闭合样例：离线树与浏览器 DOM 的 at 序列全等', async () => {
  const results = [];
  for (const [name, body] of IMPLICIT) {
    const html = doc(body);
    const tree = parseScene(html);
    const offline = layerList(tree).map((l) => l.at);

    const browser = await withPage(html, async (page) => {
      const snap = await page.evaluate(
        /** @type {(o: {includeInvisible: boolean}) => {layers: {at: string}[]}} */ (snapshotLayers),
        { includeInvisible: true }
      );
      return snap.layers.map((l) => l.at);
    });

    assert.equal(offline.length, browser.length, `${name}: 层数 ${offline.length} != ${browser.length}\n${offline}\n${browser}`);
    const diff = offline.map((at, i) => (at === browser[i] ? null : { i, offline: at, browser: browser[i] })).filter(Boolean);
    assert.deepEqual(diff, [], `${name}: 路径不一致 ${JSON.stringify(diff)}`);
    results.push({ name, layers: offline.length, equal: true });
  }
  evidence.cases['S7-A2'] = { ok: true, results };
});

const MALFORMED = [
  {
    name: 'unclosed',
    // 文件真的在这里断了：没有 </div></body></html>
    html: '<!doctype html><html><head><meta charset="utf-8"></head><body><div><span>x',
    expect: 'UNCLOSED_TAG',
    complete: false
  },
  { name: 'unterminated-attr', html: doc('<div class="a>x</div>'), expect: 'UNTERMINATED_ATTRIBUTE', complete: false },
  { name: 'stray-end', html: doc('<div></div></section>'), expect: 'STRAY_END_TAG', complete: true },
  { name: 'misnested', html: doc('<b><i>x</b></i>'), expect: 'MISNESTED_END_TAG', complete: true },
  { name: 'duplicate-id', html: doc('<div id="dup">a</div><div id="dup">b</div>'), expect: 'DUPLICATE_ID', complete: true }
];

test('S7-A3 5 个 malformed：有诊断、不抛异常；截断类拒绝重定位、不产半棵树', async () => {
  const rows = [];
  for (const sample of MALFORMED) {
    let tree;
    assert.doesNotThrow(() => {
      tree = parseScene(sample.html);
    }, `${sample.name} 抛异常了`);
    const codes = tree.issues.map((i) => i.code);
    assert.ok(codes.includes(sample.expect), `${sample.name}: ${JSON.stringify(tree.issues)}`);
    assert.equal(tree.complete, sample.complete, `${sample.name}: complete 应为 ${sample.complete}`);

    // 截断类：重定位必须拒绝，而不是拿半棵树去改覆盖
    const report = revalidateOverrides({
      oldHtml: sample.html,
      newHtml: sample.html,
      overrides: [{ at: 'body > div:nth-of-type(1)', style: { color: 'red' } }],
      now: 0
    });
    if (sample.complete) {
      assert.equal(report.treeError, null, sample.name);
    } else {
      assert.equal(report.treeError, 'TREE_INCOMPLETE', sample.name);
      assert.equal(report.entries.length, 0);
      assert.equal(report.suggestedOverrides.length, 1, '条目必须原样退回');
    }

    // 浏览器侧：坏 HTML 由浏览器修好，discover 不该失败，也不该给出空 at。
    // 截断样例浏览器可能整段丢弃（0 层），这不是「半棵树」——记录实际数量即可。
    const layers = await withPage(sample.html, async (page) => {
      const res = await discover(page, 'clip-robust', 0);
      return 'error' in res ? { error: res.error.code } : { at: res.layers.map((l) => l.at) };
    });
    assert.equal(layers.error, undefined, `${sample.name}: discover 报错 ${layers.error}`);
    if (layers.at) {
      assert.ok(layers.at.every((at) => typeof at === 'string' && at.length > 0), `${sample.name}: 出现空 at`);
    }
    rows.push({ name: sample.name, codes, complete: tree.complete, treeError: report.treeError, discover: layers.at ? layers.at.length : 0 });
  }
  evidence.cases['S7-A3'] = { ok: true, rows };
});

test('S7-A4 重复 id：DUPLICATE_ID，离线不唯一，浏览器 locate 报 AMBIGUOUS', async () => {
  const html = doc('<div class="card"><p id="dup">a</p></div><div class="card"><p id="dup">b</p></div>');
  const tree = parseScene(html);
  assert.ok(tree.issues.some((i) => i.code === 'DUPLICATE_ID' && i.tag === 'dup'), JSON.stringify(tree.issues));
  assert.equal(resolveAt(tree, '#dup'), null, '重复 id 不得被当成唯一定位');
  assert.ok(resolveAt(tree, 'body > div.card:nth-of-type(2) > p:nth-of-type(1)'), '路径仍应可解析');

  const located = await withPage(html, async (page) => {
    const res = await locate(page, 'clip-dup', '#dup');
    return 'error' in res ? res.error.code : 'OK';
  });
  assert.equal(located, 'AMBIGUOUS');

  evidence.cases['S7-A4'] = { ok: true, issues: tree.issues, locate: located };
});
