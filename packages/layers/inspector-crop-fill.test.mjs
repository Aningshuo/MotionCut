// @ts-nocheck —— 断言以 node --test 运行时为准；产品模块仍由 tsc 严格检查。
/**
 * S54-INSPECTOR-CROP-FILL · B-SUB1-R27-027
 *
 * 三个新字段：**裁切**（`clip-path: inset()`）、**背景图**（`background-image` + 尺寸/位置）、
 * **内阴影**（`box-shadow: inset …`）。A1（真 Studio）在 `scripts/s54-studio-probe.mjs`；
 * 这里覆盖 A2–A7。
 *
 * ## `/ops` 为什么用录制桩
 *
 * 要证的是「改一次裁切 → **恰好一次** `/ops` → payload 里**只有** `clip-path`」。
 * 真 Studio 的落盘/CAS 已由 `inspector-panel.test.mjs`（S11）验过；这里用同一条路由形状的桩，
 * 把「次数」与「请求体原文」逐字节看住，不依赖仓库外的样例工程。
 *
 * ## A5 的「导出帧」是哪一步
 *
 * `SceneHost.frame()` 只返回时序，**不产图片**；交付路径是 `frame(t) → apply-overrides → 截图`。
 * 所以比的是同一页面两张截图：预览（覆盖已应用）与「帧之后重新应用同一份覆盖」。
 * 夹具的 `film.frame()` 不碰内联样式，于是差别只可能来自「覆盖有没有被帧重画擦掉」。
 *
 * 运行：node --test --test-concurrency=1 packages/layers/inspector-crop-fill.test.mjs
 *      （env 由 test-env.mjs 自动准备；`OPENCUT_ENV_JSON` 可显式覆盖）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build as esbuild } from 'esbuild';

import { SceneHost, REPO_ROOT } from '../scene-runtime/host.mjs';
import { decodePng } from '../render/png.mjs';
import { resolveLayerTestEnv } from './test-env.mjs';
import { parseBackgroundImage, parseClipInset, patchForField, splitBoxShadow } from './inspector-fields.mjs';

const TEST_ENV = await resolveLayerTestEnv({ suite: 'inspector-crop-fill' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');
const TMP_DIR = path.join(RUN_ROOT, 'tmp/s54');
const BUNDLE_ABS = path.join(TMP_DIR, 'crop.mjs');
const BUNDLE_URL = '/' + path.relative(REPO_ROOT, BUNDLE_ABS).split(path.sep).join('/');
const FIXTURE = 'tests/fixtures/scenes/inspector-crop.html';
const STAGE = { w: 1280, h: 720 };
/** 夹具里 #card-a 的盒子（px）。 */
const CARD = { x: 240, y: 200, w: 600, h: 300 };

const evidence = {
  batch: 'B-SUB1-R27-027',
  task: 'S54-INSPECTOR-CROP-FILL',
  suite: 'inspector-crop-fill.test.mjs',
  fixture: FIXTURE,
  cases: {},
  screenshots: [],
  startedAt: new Date().toISOString()
};

/** @type {SceneHost} */
let host;
/** @type {any} */
let ops;
let opsBase = '';
const round = (n, d = 2) => Math.round(Number(n) * 10 ** d) / 10 ** d;

async function buildBundle() {
  await fs.mkdir(TMP_DIR, { recursive: true });
  await esbuild({
    stdin: {
      contents: [
        "export { mountInspector } from './packages/layers/inspector-panel.mjs';",
        "export { readLayer } from './packages/layers/describe.ts';",
        "export { applyOverrideEntries } from './packages/layers/apply-overrides.mjs';",
        "export { createOpsClient } from './packages/layers/ops-client.mjs';",
        "export { mergeOverridesAt } from './packages/layers/override-merge.mjs';",
        "export { buildMultiInspector } from './packages/layers/inspector-fields.mjs';",
        "export { hitTest, marqueeSelect } from './packages/studio/ui/src/lib/stage-gesture.ts';"
      ].join('\n'),
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

async function startOpsStub() {
  const state = { requests: [], hashSeq: 0 };
  const server = http.createServer((req, res) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST,OPTIONS',
      'access-control-allow-headers': 'content-type'
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      state.requests.push({ method: req.method, url: req.url, body });
      state.hashSeq += 1;
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, hash: `stub-${state.hashSeq}`, changed: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    state,
    port: typeof address === 'object' && address ? address.port : 0,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function save() {
  evidence.finishedAt = new Date().toISOString();
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(path.join(EVIDENCE_DIR, 's54-inspector-crop-fill.json'), JSON.stringify(evidence, null, 2) + '\n');
}

before(async () => {
  const env = TEST_ENV.env;
  evidence.batch = env.batchId ?? evidence.batch;
  await buildBundle();
  ops = await startOpsStub();
  opsBase = `http://127.0.0.1:${ops.port}`;
  host = await new SceneHost({ port: Number(env.studioPort), viewport: { width: STAGE.w, height: STAGE.h } }).start();
});

after(async () => {
  await save();
  if (host) await host.stop();
  if (ops) await ops.close();
});

/* ────────────────────────── 1. 纯函数（A4 的解析层） ─────────────────── */

test('S54-U1 裁切解析：1–4 个值按 CSS 简写展开，负值/非 inset/超盒一律拒', () => {
  const box = { w: 1000, h: 500 };
  assert.equal(parseClipInset('inset(10px)', { box }).value, 'inset(10px 10px 10px 10px)');
  assert.equal(parseClipInset('inset(10px 20px)', { box }).value, 'inset(10px 20px 10px 20px)');
  assert.equal(parseClipInset('inset(10px 20px 30px)', { box }).value, 'inset(10px 20px 30px 20px)');
  assert.equal(parseClipInset('inset(10px 20px 10px 20px)', { box }).value, 'inset(10px 20px 10px 20px)');
  assert.equal(parseClipInset('inset(10%)', { box }).value, 'inset(10% 10% 10% 10%)');
  for (const bad of ['inset(-1px)', 'circle(5px)', 'inset()', 'inset(10px) solid', 'inset(600px)', 'inset(0 600px 0 600px)']) {
    const result = parseClipInset(bad, { box });
    assert.equal(result.ok, false, `应拒绝：${bad}`);
    assert.equal(result.error.code, 'INVALID_VALUE');
  }
  evidence.cases.U1 = { ok: true };
});

test('S54-U2 背景图白名单：工程内相对路径与 data URL 通过，外链/绝对/跳出全拒', () => {
  for (const good of ['assets/bg.png', 'media/a b.jpg', 'url("assets/x.png")', 'data:image/png;base64,AAA', 'none']) {
    const result = parseBackgroundImage(good);
    assert.equal(result.ok, true, `应通过：${good}`);
  }
  assert.equal(parseBackgroundImage('assets/bg.png').value, 'url("assets/bg.png")');
  for (const bad of ['../secret.png', '/etc/passwd', 'http://x/y.png', 'https://x/y.png', 'file:///etc/passwd', 'javascript:alert(1)', '//host/x.png', 'assets/../../x.png', 'data:text/html;base64,AAA']) {
    const result = parseBackgroundImage(bad);
    assert.equal(result.ok, false, `应拒绝：${bad}`);
    assert.equal(result.error.code, 'INVALID_VALUE');
  }
  evidence.cases.U2 = { ok: true };
});

test('S54-U3 内阴影：必须 inset 开头；与外阴影合并成一条 box-shadow，谁也冲不掉谁', () => {
  assert.deepEqual(splitBoxShadow('inset 0 0 24px #000, 0 2px 4px rgba(0,0,0,0.5)'), {
    inset: ['inset 0 0 24px #000'],
    outer: ['0 2px 4px rgba(0,0,0,0.5)']
  });
  const inset = patchForField('boxShadowInset', 'inset 0 0 24px #000', { other: '0 2px 4px rgba(0,0,0,0.5)' });
  assert.deepEqual(inset.patch, { style: { 'box-shadow': 'inset 0 0 24px #000, 0 2px 4px rgba(0,0,0,0.5)' } });
  const outer = patchForField('boxShadow', '0 1px 2px #111', { other: 'inset 0 0 24px #000' });
  assert.deepEqual(outer.patch, { style: { 'box-shadow': '0 1px 2px #111, inset 0 0 24px #000' } });
  assert.equal(patchForField('boxShadowInset', '0 0 24px #000').error.code, 'INVALID_VALUE');
  assert.equal(patchForField('boxShadow', 'inset 0 0 24px #000').error.code, 'INVALID_VALUE');
  evidence.cases.U3 = { ok: true };
});

/* ────────────────────────── 2. 面板（真 Chromium + /ops 桩） ─────────── */

async function mountPanel(page) {
  return page.evaluate(async (deps) => {
    const mod = await import(deps.bundle);
    const { mountInspector, readLayer, applyOverrideEntries, createOpsClient, mergeOverridesAt } = mod;

    window.__posts = [];
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      window.__posts.push({ url: String(input), method: (init && init.method) || 'GET', body: init && typeof init.body === 'string' ? init.body : null });
      return realFetch(input, init);
    };

    const client = createOpsClient({
      projectId: deps.projectId,
      batchId: 'B-SUB1-R27-027',
      owner: 'SUB1',
      expectedHash: deps.expectedHash,
      baseUrl: deps.baseUrl
    });

    const hosts = { entries: [...(deps.entries || [])], prevEntries: null, hash: deps.expectedHash, at: deps.at, commits: 0 };
    const applyAll = () => applyOverrideEntries(hosts.entries);

    const container = document.createElement('div');
    container.id = 'sub1-crop-panel';
    container.setAttribute(
      'style',
      'position:fixed;right:0;top:0;width:320px;height:100vh;background:#111a2e;color:#eef2ff;z-index:2147483647;overflow:auto;font:12px/1.5 system-ui;padding:8px;box-sizing:border-box'
    );
    document.body.appendChild(container);

    const panel = mountInspector(container, {
      describe: async (ref) => {
        const res = readLayer(ref.at);
        return res && res.ok ? res.value : res;
      },
      overrideOf: (at) => hosts.entries.find((entry) => entry && entry.at === at) ?? null,
      preview: async (patch) => {
        hosts.prevEntries = hosts.entries;
        hosts.entries = mergeOverridesAt(hosts.entries, hosts.at, patch);
        await applyAll();
      },
      revertPreview: async () => {
        hosts.entries = hosts.prevEntries ?? hosts.entries;
        await applyAll();
      },
      commit: async (patch) => {
        hosts.commits += 1;
        const next = mergeOverridesAt(hosts.entries, hosts.at, patch);
        const res = await client.commitOverrides({ clip: deps.clip, entries: next });
        if (res.ok) {
          hosts.entries = next;
          hosts.hash = res.hash;
        }
        return res;
      },
      expectedHash: deps.expectedHash
    });
    await panel.select({ clipId: deps.clip, at: deps.at, kind: 'shape', name: deps.at, depth: 1 });

    window.__panel = panel;
    window.__hosts = hosts;
    window.__mod = mod;
    window.__hidePanel = (hidden) => {
      container.style.display = hidden ? 'none' : '';
      return true;
    };
    window.__gesture = { hitTest: mod.hitTest, marqueeSelect: mod.marqueeSelect };
    window.__apply = (entries) => {
      hosts.entries = [...entries];
      return applyAll();
    };
    window.__reapply = () => applyAll();
    return { state: panel.getState(), posts: window.__posts.length };
  }, {
    bundle: BUNDLE_URL,
    baseUrl: opsBase,
    projectId: 's54-crop',
    expectedHash: 'h0',
    clip: 'clip-crop',
    at: '#card-a',
    entries: []
  });
}

/** 改裁切：四个数值框（走真实 change 事件链）。 */
async function editInset(page, sides) {
  await page.evaluate((values) => {
    const row = document.querySelector('.film-inspector [data-field="clipPath"]');
    if (!row) throw new Error('没有裁切行');
    for (const [part, value] of Object.entries(values)) {
      const input = row.querySelector(`[data-part="${part}"]`);
      if (!input) throw new Error(`没有 ${part} 输入框`);
      input.value = String(value);
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, sides);
  return page.evaluate(() => window.__panel.idle());
}

async function editField(page, fieldId, value) {
  await page.evaluate(
    ([id, v]) => {
      const row = document.querySelector(`.film-inspector [data-field="${id}"]`);
      if (!row) throw new Error(`没有字段行：${id}`);
      const node = row.querySelector('select') ?? row.querySelector('input:not([data-custom])');
      node.value = v;
      node.dispatchEvent(new Event('change', { bubbles: true }));
    },
    [fieldId, value]
  );
  return page.evaluate(() => window.__panel.idle());
}

test('S54-A2 改裁切：/ops 恰好 1 次，payload 只有 clip-path', async () => {
  const handle = await host.open(FIXTURE);
  const page = handle.page;
  try {
    await mountPanel(page);
    const base = ops.state.requests.length;
    await editInset(page, { top: 10, right: 20, bottom: 10, left: 20 });
    const posts = ops.state.requests.slice(base);
    assert.equal(posts.length, 1, `应恰好一次 /ops，实际 ${posts.length}`);
    const body = JSON.parse(posts[0].body);
    evidence.cases.A2 = { posts: posts.length, body };
    const styleKeys = collectStyleKeys(body);
    assert.deepEqual(styleKeys, ['clip-path'], `payload 只应有 clip-path：${JSON.stringify(styleKeys)}`);
    assert.equal(styleKeys.value, undefined);
    const value = firstStyleValue(body, 'clip-path');
    assert.equal(value, 'inset(10px 20px 10px 20px)');
  } finally {
    await handle.dispose();
  }
});

/** 把 op body 里的 `style` 键全部收集出来（不同 envelope 形状都能用）。 */
function collectStyleKeys(body) {
  const keys = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.style && typeof node.style === 'object' && !Array.isArray(node.style)) {
      keys.push(...Object.keys(node.style));
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else walk(value);
    }
  };
  walk(body);
  return [...new Set(keys)];
}
function firstStyleValue(body, key) {
  let found;
  const walk = (node) => {
    if (found !== undefined || !node || typeof node !== 'object') return;
    if (node.style && typeof node.style === 'object' && typeof node.style[key] === 'string') {
      found = node.style[key];
      return;
    }
    for (const value of Object.values(node)) {
      if (found !== undefined) return;
      if (Array.isArray(value)) value.forEach(walk);
      else walk(value);
    }
  };
  walk(body);
  return found;
}

test('S54-A3 裁切只影响绘制：getBoundingClientRect 四数逐值相同、hitTest 同一层', async () => {
  const handle = await host.open(FIXTURE);
  const page = handle.page;
  try {
    await mountPanel(page);
    const before = await page.evaluate(() => {
      const el = document.querySelector('#card-a');
      const rect = el.getBoundingClientRect();
      const layers = [{ id: '#card-a', x: 240, y: 200, w: 600, h: 300, rotation: 0 }];
      return {
        rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        hit: window.__gesture.hitTest(layers, { x: 540, y: 350 }),
        inside: window.__gesture.hitTest(layers, { x: 250, y: 210 })
      };
    });
    await editInset(page, { top: 10, right: 10, bottom: 10, left: 10 });
    const after = await page.evaluate(() => {
      const el = document.querySelector('#card-a');
      const rect = el.getBoundingClientRect();
      const layers = [{ id: '#card-a', x: 240, y: 200, w: 600, h: 300, rotation: 0 }];
      return {
        rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        hit: window.__gesture.hitTest(layers, { x: 540, y: 350 }),
        inside: window.__gesture.hitTest(layers, { x: 250, y: 210 }),
        clip: getComputedStyle(el).clipPath
      };
    });
    assert.deepEqual(after.rect, before.rect, `裁切不该改盒：${JSON.stringify(before.rect)} vs ${JSON.stringify(after.rect)}`);
    assert.equal(after.hit, before.hit);
    assert.equal(after.inside, before.inside, '裁切后命中的仍是同一层（命中按盒）');
    assert.equal(after.clip, 'inset(10px)');
    evidence.cases.A3 = { before, after };
  } finally {
    await handle.dispose();
  }
});

test('S54-A4 路径安全：外链/绝对/跳出全拒、0 请求；assets 与 data URL 通过', async () => {
  const handle = await host.open(FIXTURE);
  const page = handle.page;
  try {
    await mountPanel(page);
    const base = ops.state.requests.length;
    const rejected = [];
    for (const value of ['../secret.png', '/etc/passwd', 'http://x/y.png', 'file:///etc/passwd']) {
      await editField(page, 'backgroundImage', value);
      const state = await page.evaluate(() => window.__panel.getState());
      rejected.push({ value, code: state.error?.code ?? null });
    }
    assert.equal(ops.state.requests.length, base, `非法值不该发请求：多了 ${ops.state.requests.length - base} 次`);
    for (const item of rejected) assert.equal(item.code, 'INVALID_VALUE', `${item.value} 应报 INVALID_VALUE`);

    await editField(page, 'backgroundImage', 'assets/bg.png');
    const accepted = await page.evaluate(() => {
      const el = document.querySelector('#card-a');
      return { inline: el.style.getPropertyValue('background-image'), stored: window.__hosts.entries.find((entry) => entry.at === '#card-a')?.style?.['background-image'] };
    });
    assert.equal(accepted.inline, 'url("assets/bg.png")');
    assert.equal(accepted.stored, 'url("assets/bg.png")');
    evidence.cases.A4 = { rejected, accepted, requestsDuringReject: 0 };
  } finally {
    await handle.dispose();
  }
});

/** 纯绿底上量非绿像素的 bbox（只扫 clip 区域）。 */
function inkStats(image) {
  const { width: w, height: h, channels: c, data } = image;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = -1;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * c;
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      if (!(Math.abs(g - 255) > 40 || r > 40 || b > 40)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/* 截图窗口：卡片外 40px（够看外阴影的扩边），下边界不过 540 —— 别把第二张卡扫进来 */
const CARD_CLIP = { x: CARD.x - 40, y: CARD.y - 40, width: CARD.w + 80, height: CARD.h + 80 };

test('S54-A5 裁切像素：inset(40px) 四边各缩 40±2px，中心像素不变（预览 vs 帧后重应用）', async () => {
  const handle = await host.open(FIXTURE);
  const page = handle.page;
  try {
    await mountPanel(page);
    await page.evaluate(() => window.__hidePanel(true));
    await page.evaluate(() => window.__apply([{ at: '#card-a', style: { 'clip-path': 'inset(40px)' } }]));
    await page.waitForTimeout(50);
    const shots = {};
    for (const kind of ['preview', 'export']) {
      if (kind === 'export') {
        await host.frame(handle, { t: 1 });
        await page.evaluate(() => window.__reapply());
        await page.waitForTimeout(30);
      }
      const file = path.join(EVIDENCE_DIR, `s54-a5-${kind}.png`);
      await page.screenshot({ path: file, clip: CARD_CLIP });
      const image = decodePng(await fs.readFile(file));
      shots[kind] = { bbox: inkStats(image), file };
    }
    const toStage = (bbox) => ({ x: bbox.x + CARD_CLIP.x, y: bbox.y + CARD_CLIP.y, w: bbox.w, h: bbox.h });
    const preview = toStage(shots.preview.bbox);
    const exported = toStage(shots.export.bbox);
    const deltas = {
      left: preview.x - (CARD.x + 40),
      top: preview.y - (CARD.y + 40),
      right: CARD.x + CARD.w - 40 - (preview.x + preview.w),
      bottom: CARD.y + CARD.h - 40 - (preview.y + preview.h)
    };
    assert.ok(Object.values(deltas).every((value) => Math.abs(value) <= 2), `四边应各缩 40±2px：${JSON.stringify(deltas)}`);
    assert.deepEqual({ x: exported.x - preview.x, y: exported.y - preview.y, w: exported.w - preview.w, h: exported.h - preview.h }, { x: 0, y: 0, w: 0, h: 0 }, '预览与帧后重应用应逐像素同框');
    /* 中心像素：卡片还是卡片色（裁切只裁边） */
    const center = await page.evaluate(() => {
      const el = document.querySelector('#card-a');
      const rect = el.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    assert.ok(center.x > CARD.x + 40 && center.x < CARD.x + CARD.w - 40, '中心点应在裁切后仍在盒内');
    evidence.cases.A5 = { preview, exported, deltas, shots: Object.keys(shots) };
  } finally {
    await handle.dispose();
  }
});

test('S54-A6 内阴影只画在盒内：外轮廓 bbox 不变（外阴影才会扩）', async () => {
  const handle = await host.open(FIXTURE);
  const page = handle.page;
  try {
    await mountPanel(page);
    await page.evaluate(() => window.__hidePanel(true));
    const shoot = async (name) => {
      await page.waitForTimeout(40);
      const file = path.join(EVIDENCE_DIR, name);
      await page.screenshot({ path: file, clip: CARD_CLIP });
      return inkStats(decodePng(await fs.readFile(file)));
    };
    await page.evaluate(() => window.__apply([]));
    const plain = await shoot('s54-a6-plain.png');
    await page.evaluate(() => window.__apply([{ at: '#card-a', style: { 'box-shadow': 'inset 0 0 24px #000' } }]));
    const inset = await shoot('s54-a6-inset.png');
    await page.evaluate(() => window.__apply([{ at: '#card-a', style: { 'box-shadow': '0 0 24px #000' } }]));
    const outer = await shoot('s54-a6-outer.png');
    assert.deepEqual(inset, plain, `内阴影不该改外轮廓：${JSON.stringify(plain)} vs ${JSON.stringify(inset)}`);
    /* 对照：外阴影**会**扩（证明这条判据不是永远相等） */
    assert.ok(outer && plain && (outer.w > plain.w + 4 || outer.h > plain.h + 4), `外阴影应扩轮廓：${JSON.stringify(plain)} vs ${JSON.stringify(outer)}`);
    evidence.cases.A6 = { plain, inset, outer };
  } finally {
    await handle.dispose();
  }
});

test('S54-A7 多选 mixed 显示 —；锁定层三字段 disabled + LOCKED、0 请求', async () => {
  const handle = await host.open(FIXTURE);
  const page = handle.page;
  try {
    await mountPanel(page);
    const multi = await page.evaluate(() => {
      const { buildMultiInspector } = window.__mod;
      const base = {
        style: { 'clip-path': 'inset(10px)', 'background-image': 'url("assets/a.png")', 'box-shadow': 'inset 0 0 24px #000' },
        box: { x: 0, y: 0, w: 600, h: 300 }
      };
      const model = buildMultiInspector([
        { ref: { at: '#card-a', clipId: 'c' }, override: null, described: { ...base, box: { ...base.box } } },
        { ref: { at: '#card-b', clipId: 'c' }, override: null, described: { ...base, style: { ...base.style, 'clip-path': 'inset(24px)' }, box: { ...base.box } } }
      ]);
      const field = model.fields.find((item) => item.id === 'clipPath');
      return { mixed: field?.mixed, current: field?.current, parts: field?.parts?.map((part) => part.value), count: model.count };
    });
    assert.equal(multi.mixed, true, '两层裁切不同应 mixed');
    assert.equal(multi.current, '');
    assert.ok(multi.parts.every((value) => value === ''), `mixed 时四格应留空：${JSON.stringify(multi.parts)}`);

    /* 锁定层：三字段 disabled、逐个提交都 0 请求 */
    const lockedPanel = await page.evaluate(() => {
      const container = document.createElement('div');
      container.id = 'sub1-crop-locked';
      container.setAttribute('style', 'position:fixed;right:0;top:0;width:320px;height:100vh;z-index:2147483646;overflow:auto');
      document.body.appendChild(container);
      const panel = window.__mod.mountInspector(container, {
        describe: async () => {
          const res = window.__mod.readLayer('#card-a');
          return res && res.ok ? res.value : res;
        },
        overrideOf: () => ({ lock: true }),
        preview: async () => {},
        commit: async () => ({ ok: false, code: 'LOCKED', message: '锁定层不可编辑' }),
        expectedHash: 'h0'
      });
      return panel.select({ clipId: 'c', at: '#card-a', kind: 'shape', name: '#card-a', depth: 1 }).then(() => ({
        fields: [...container.querySelectorAll('.film-inspector .inspector-field')]
          .filter((row) => ['clipPath', 'backgroundImage', 'boxShadowInset'].includes(row.getAttribute('data-field')))
          .map((row) => ({
            id: row.getAttribute('data-field'),
            disabled: [...row.querySelectorAll('input, select')].every((node) => node.disabled),
            reason: row.querySelector('input')?.getAttribute('data-disabled-reason') ?? ''
          }))
      }));
    });
    for (const item of lockedPanel.fields) {
      assert.equal(item.disabled, true, `${item.id} 在锁定层应 disabled`);
      /* 行上的原因是 `LAYER_LOCKED`（字段模型的口径），提交侧的错误码是 `LOCKED`（edit-session）；
         两个都叫「锁定」，这里按包含匹配，别把两套码混成一个。 */
      assert.match(item.reason, /LOCKED/, `${item.id} 的 disabled 原因：${item.reason}`);
    }
    evidence.cases.A7 = { multi, locked: lockedPanel.fields };
  } finally {
    await handle.dispose();
  }
});
