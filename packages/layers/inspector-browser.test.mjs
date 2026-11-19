// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S3 验收 A3 / A5 / A9 / A10（真实浏览器 DOM + 真实落盘）
 *
 * 运行：node --test --test-concurrency=1 packages/layers/inspector-browser.test.mjs
 *
 * 说明：落盘的是「覆盖条目 JSON」而不是 film.html —— 真正的 film.html 写队列归主线；
 * 这里验的是客户端这一半：最小 patch、连续编辑合成、CAS 失败回滚、锁定拒写、度量随文本变化。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SceneHost, REPO_ROOT } from '../scene-runtime/host.mjs';
import { resolveLayerTestEnv } from './test-env.mjs';

const { discover } = await import(new URL('./discover.ts', import.meta.url).href);
const { describeLayer } = await import(new URL('./describe.ts', import.meta.url).href);
const { buildInspector } = await import(new URL('./inspector.ts', import.meta.url).href);
const { EditSession, patchFromField } = await import(new URL('./edit-session.ts', import.meta.url).href);
const { seedOverride, readOverride, writeOverrideCAS } = await import(new URL('./override-store.mjs', import.meta.url).href);

const PORT = Number(process.env.FILM_INSPECTOR_PORT || 59375);
const SCENE = 'tests/fixtures/scenes/inspector-layer.html';
const TEST_ENV = await resolveLayerTestEnv({ suite: 'inspector-browser' });
const EVIDENCE_DIR = TEST_ENV.evidenceDir;
const TMP_DIR = TEST_ENV.tmpRoot;
const evidence = { batch: 'B-SUB1-R2-002', suite: 'inspector-browser.test.mjs', cases: {} };

/** @type {SceneHost} */
let host;

async function save() {
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(path.join(EVIDENCE_DIR, 'inspector-browser.json'), JSON.stringify(evidence, null, 2) + '\n');
}

async function openScene() {
  return host.open(SCENE);
}

/** 取 #headline / #badge 的真实 LayerRef（来自 discover，不手写）。 */
async function refsOf(page) {
  const res = await discover(page, 'clip-inspector', 0);
  assert.ok(!('error' in res), `discover 失败：${res.error?.code}`);
  const headline = res.layers.find((l) => l.at === '#headline');
  const badge = res.layers.find((l) => l.at === '#badge');
  assert.ok(headline && badge, `缺层：${res.layers.map((l) => l.at).join(',')}`);
  return { headline, badge };
}

/** 记录基线，返回一个可重复调用的 painter：先恢复到基线，再应用 override。 */
async function makePainter(page, at) {
  const baseline = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const keys = [
      'font-size', 'color', '-webkit-text-stroke-width', '-webkit-text-stroke-color',
      'font-weight', 'background-color', 'opacity', 'text-shadow'
    ];
    const style = {};
    for (const k of keys) style[k] = el.style.getPropertyValue(k);
    return { style, text: el.textContent };
  }, at);
  assert.ok(baseline, `基线取不到：${at}`);

  return async (override) => {
    await page.evaluate(
      ({ sel, base, ov }) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error(`paint 找不到 ${sel}`);
        for (const [k, v] of Object.entries(base.style)) {
          if (v) el.style.setProperty(k, v);
          else el.style.removeProperty(k);
        }
        el.textContent = base.text;
        if (typeof ov.t === 'string') el.textContent = ov.t;
        for (const [k, v] of Object.entries(ov.style || {})) el.style.setProperty(k, v);
      },
      { sel: at, base: baseline, ov: override }
    );
  };
}

before(async () => {
  host = await new SceneHost({ port: PORT }).start();
  await fs.mkdir(TMP_DIR, { recursive: true });
  evidence.host = { port: host.http.port, browser: host.browserVersion };
});

after(async () => {
  evidence.finishedAt = new Date().toISOString();
  await save();
  if (host) await host.stop();
});

test('S3-A3 三次连续编辑（字号→颜色→描边）三项齐全：DOM 度量 + 落盘文本', async () => {
  const h = await openScene();
  try {
    const { headline } = await refsOf(h.page);
    const file = path.join(TMP_DIR, 'override-a3.json');
    const seeded = await seedOverride(file, { style: {} });
    let diskHash = seeded.hash;

    const paint = await makePainter(h.page, '#headline');
    const session = new EditSession({
      initialHash: diskHash,
      initialOverride: {},
      paint,
      commit: async (next, expected) => {
        const out = await writeOverrideCAS(file, JSON.stringify(next, null, 2) + '\n', expected);
        if (!out.ok) return { ok: false, code: out.code, ...(out.actualHash ? { actualHash: out.actualHash } : {}) };
        diskHash = out.hash;
        return { ok: true, hash: out.hash };
      }
    });

    /* 三次连续编辑：字号 → 颜色 → 描边（描边是一个逻辑字段，落两个 longhand 键） */
    const steps = [
      { key: 'font-size', patch: { style: { 'font-size': '48px' } } },
      { key: 'color', patch: { style: { color: '#ff2d55' } } },
      { key: 'stroke', patch: { style: { '-webkit-text-stroke-width': '2px', '-webkit-text-stroke-color': '#ffcc00' } } }
    ];
    for (const step of steps) {
      const r = await session.edit(step.patch, session.snapshot());
      assert.equal(r.status, 'applied', `${step.key} 状态=${r.status}`);
    }

    const dom = await h.page.evaluate(() => {
      const el = document.querySelector('#headline');
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        fontSize: cs.fontSize,
        color: cs.color,
        strokeWidth: cs.getPropertyValue('-webkit-text-stroke-width').trim(),
        strokeColor: cs.getPropertyValue('-webkit-text-stroke-color').trim(),
        box: { x: r.x, y: r.y, w: r.width, h: r.height }
      };
    });
    assert.equal(dom.fontSize, '48px');
    assert.equal(dom.color, 'rgb(255, 45, 85)');
    assert.equal(dom.strokeWidth, '2px');
    assert.equal(dom.strokeColor, 'rgb(255, 204, 0)');

    const disk = await readOverride(file);
    const parsed = JSON.parse(disk.text);
    assert.deepEqual(
      Object.keys(parsed.style).sort(),
      ['-webkit-text-stroke-color', '-webkit-text-stroke-width', 'color', 'font-size'],
      `落盘键=${Object.keys(parsed.style).join(',')}`
    );
    assert.equal(disk.hash, session.hash, '磁盘哈希与会话哈希不一致');
    assert.equal(diskHash, session.hash);

    evidence.cases['S3-A3'] = {
      status: 'PASS',
      steps: steps.map((s) => s.key),
      dom,
      diskKeys: Object.keys(parsed.style),
      diskHash: disk.hash,
      hashMatches: disk.hash === session.hash
    };
  } finally {
    await h.dispose();
  }
  await save();
});

test('S3-A5 写失败（并发改动 → CAS 冲突）→ 画面回滚，磁盘哈希未变', async () => {
  const h = await openScene();
  try {
    await refsOf(h.page);
    const file = path.join(TMP_DIR, 'override-a5.json');
    const seeded = await seedOverride(file, { style: { 'font-size': '34px' } });
    const paint = await makePainter(h.page, '#headline');

    const session = new EditSession({
      initialHash: seeded.hash,
      initialOverride: { style: { 'font-size': '34px' } },
      paint,
      commit: async (next, expected) => {
        const out = await writeOverrideCAS(file, JSON.stringify(next, null, 2) + '\n', expected);
        return out.ok ? { ok: true, hash: out.hash } : { ok: false, code: out.code, actualHash: out.actualHash };
      }
    });

    // 外部写者先改了文件（模拟别的编辑器/Agent）
    const external = await seedOverride(file, { style: { 'font-size': '34px' }, t: '外部改动' });
    const before = await readOverride(file);
    assert.equal(before.hash, external.hash);

    const domBefore = await h.page.evaluate(() => getComputedStyle(document.querySelector('#headline')).color);

    const result = await session.edit({ style: { color: '#00ff00' } }, session.snapshot());
    assert.equal(result.status, 'rolledback', `状态=${result.status}`);
    assert.match(result.error.message, /写入冲突/);
    assert.equal(session.hash, seeded.hash, '失败后会话哈希被推进');
    assert.equal(session.override.style.color, undefined, '失败后会话覆盖残留颜色');

    const domAfter = await h.page.evaluate(() => getComputedStyle(document.querySelector('#headline')).color);
    assert.equal(domAfter, domBefore, `画面未回滚：${domBefore} -> ${domAfter}`);

    const after = await readOverride(file);
    assert.equal(after.hash, before.hash, '写失败却改了磁盘哈希');
    assert.match(after.text, /外部改动/, '磁盘的外部改动被覆盖');

    assert.deepEqual(result.trace.slice(0, 3), ['paint:next', `commit:${seeded.hash}`, 'paint:rollback'], `轨迹=${result.trace.join('|')}`);

    evidence.cases['S3-A5'] = {
      status: 'PASS',
      trace: result.trace,
      error: result.error.message,
      domColor: { before: domBefore, after: domAfter },
      diskHash: { before: before.hash, after: after.hash, same: before.hash === after.hash }
    };
  } finally {
    await h.dispose();
  }
  await save();
});

test('S3-A9 锁定层 editable=false，提交被拒且报 LOCKED', async () => {
  const h = await openScene();
  try {
    const { badge } = await refsOf(h.page);
    const desc = await describeLayer(h.page, badge);
    assert.ok(desc.ok);
    assert.equal(desc.value.locked, true, '夹具的 data-lock 没被 describe 识别');

    const model = buildInspector(badge, null, desc.value);
    assert.equal(model.locked, true);
    assert.ok(model.fields.every((f) => f.editable === false));
    assert.ok(model.fields.every((f) => patchFromField(f, 'x') === null), '锁定层仍能构造 patch');

    const file = path.join(TMP_DIR, 'override-a9.json');
    const seeded = await seedOverride(file, { style: {} });
    const before = await readOverride(file);
    const session = new EditSession({
      initialHash: seeded.hash,
      initialOverride: {},
      locked: true,
      paint: async () => assert.fail('锁定层不应 paint'),
      commit: async () => assert.fail('锁定层不应 commit')
    });
    const result = await session.edit({ style: { color: '#ff0000' } }, session.snapshot());
    assert.equal(result.status, 'rejected');
    assert.equal(result.error.code, 'LOCKED');
    assert.deepEqual(result.trace, ['reject:LOCKED']);

    const after = await readOverride(file);
    assert.equal(after.hash, before.hash, '锁定层居然写了盘');

    evidence.cases['S3-A9'] = {
      status: 'PASS',
      model: { locked: model.locked, editableFalse: model.fields.every((f) => !f.editable) },
      error: result.error.code,
      diskUnchanged: after.hash === before.hash,
      trace: result.trace
    };
  } finally {
    await h.dispose();
  }
  await save();
});

test('S3-A10 文本变化后度量框随之变化（给出实测数值）', async () => {
  const h = await openScene();
  try {
    const { headline } = await refsOf(h.page);
    const before = await describeLayer(h.page, headline);
    assert.ok(before.ok);

    const file = path.join(TMP_DIR, 'override-a10.json');
    const seeded = await seedOverride(file, { style: {} });
    const paint = await makePainter(h.page, '#headline');
    const session = new EditSession({
      initialHash: seeded.hash,
      initialOverride: {},
      paint,
      commit: async (next, expected) => {
        const out = await writeOverrideCAS(file, JSON.stringify(next, null, 2) + '\n', expected);
        return out.ok ? { ok: true, hash: out.hash } : { ok: false, code: out.code };
      }
    });

    const r1 = await session.edit({ t: '7.0s' }, session.snapshot());
    assert.equal(r1.status, 'applied');
    const mid = await describeLayer(h.page, headline);
    assert.ok(mid.ok);

    const r2 = await session.edit({ t: '7.0s（加长文本）' }, session.snapshot());
    assert.equal(r2.status, 'applied');
    const after = await describeLayer(h.page, headline);
    assert.ok(after.ok);

    const w0 = before.value.box.w;
    const w1 = mid.value.box.w;
    const w2 = after.value.box.w;
    assert.ok(Math.abs(w1 - w0) > 0.5, `文本 6.5s -> 7.0s 后宽度没变化：${w0} -> ${w1}`);
    assert.ok(w2 > w1 + 10, `文本加长后宽度没变：${w1} -> ${w2}`);

    const disk = JSON.parse((await readOverride(file)).text);
    assert.equal(disk.t, '7.0s（加长文本）', '落盘文本不是最后一次输入');

    evidence.cases['S3-A10'] = {
      status: 'PASS',
      widths: { '6.5s': w0, '7.0s': w1, '7.0s（加长文本）': w2 },
      delta: { first: Math.round((w1 - w0) * 10) / 10, second: Math.round((w2 - w1) * 10) / 10 },
      diskText: disk.t
    };
  } finally {
    await h.dispose();
  }
  await save();
});
