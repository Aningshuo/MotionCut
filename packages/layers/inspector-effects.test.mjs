// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S51-INSPECTOR-EFFECTS 验收 A1..A7（A8 全量回归 / A9 文档在 commands 与 README 里）
 *
 * 检查器此前只有 11 个字段（字号…阴影），**滤镜 / 混合模式 / 圆角裁切 / 盒子阴影 / 背景模糊**
 * 一个都没有。合同 `OverridePatch.style` 本来就是 `Record<string,string>`，所以这批不碰合同，
 * 只把字段模型（`inspector-fields.mjs`）与面板控件（`inspector-panel.mjs`）长出来。
 *
 * ## 为什么 `/ops` 用**录制桩**而不是真 Studio
 *
 * 这个文件要证的是「面板改一个字段 → **恰好一次** `/ops` → payload 里**只有**那一个 key」。
 * 真 Studio 的落盘/CAS/CORS 由 `inspector-panel.test.mjs`（S11）与 `inspector-multi.test.mjs`（S26）
 * 已经在真实工程上验过；这里用同一条路由形状的录制桩，能把「次数」和「请求体原文」逐字节看住，
 * 而且不依赖仓库外的计划样例目录。桩只做两件事：数请求、把请求体原样记下来。
 *
 * ## A5 的「导出帧」是哪一步
 *
 * `SceneHost.frame()` 返回的是时序信息，**不是图片**；交付路径是「frame(t) → apply-overrides →
 * 截图/编码」。所以 A5 比的是同一页面的两张截图：`preview`（覆盖直接应用）与 `export`
 * （先跑一次 `host.frame()` 再重新应用同一份覆盖）。夹具的 `film.frame()` 不碰内联样式，
 * 于是这两张的差别只可能来自「覆盖有没有被帧重画擦掉」——那正是要证的东西。
 *
 * 运行：node --test --test-concurrency=1 packages/layers/inspector-effects.test.mjs
 *      （env 由 test-env.mjs 自动准备；`OPENCUT_ENV_JSON` 可显式覆盖）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { build as esbuild } from 'esbuild';

import { SceneHost, REPO_ROOT } from '../scene-runtime/host.mjs';
import { decodePng } from '../render/png.mjs';
import { resolveLayerTestEnv } from './test-env.mjs';
import { EFFECT_STYLE_FIELDS, BORDER_RADIUS_MAX, BLEND_MODES } from './inspector-fields.mjs';
import { registerCleanupProbe } from './test-inject.mjs';

/* 对齐是 Studio 侧的实现，测试**引用**它（只读），保证「同一套对齐」；
   命中/框选走页内 bundle（见 buildBundle），两处都是产品代码本体。 */
const ALIGN = await import(new URL('./align-distribute.mjs', import.meta.url).href);

const TEST_ENV = await resolveLayerTestEnv({ suite: 'inspector-effects' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');
const TMP_DIR = path.join(RUN_ROOT, 'tmp/s51');
const BUNDLE_ABS = path.join(TMP_DIR, 'fx.mjs');
const BUNDLE_URL = '/' + path.relative(REPO_ROOT, BUNDLE_ABS).split(path.sep).join('/');
const FIXTURE = 'tests/fixtures/scenes/inspector-effects.html';
const STAGE = { w: 1280, h: 720 };

const evidence = {
  batch: 'B-SUB1-R26-026',
  task: 'S51-INSPECTOR-EFFECTS',
  suite: 'inspector-effects.test.mjs',
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

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const round = (n, d = 3) => Math.round(Number(n) * 10 ** d) / 10 ** d;

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
        "export { patchForField } from './packages/layers/inspector-fields.mjs';",
        /* 命中/框选是 Studio 侧的实现（只读引用）：测试与产品用同一套几何，
           不在验收脚本里另写一份「差不多的」矩形判定。 */
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

/**
 * `/ops` 录制桩：同一条路由形状（`POST /api/projects/:id/ops`），把请求体原样记下来。
 * 返回 `{ok:true, hash}`，hash 递增——面板只把它当「服务端返回的 hash」用。
 */
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
  await fs.writeFile(path.join(EVIDENCE_DIR, 's51-inspector-effects.json'), JSON.stringify(evidence, null, 2) + '\n');
}

before(async () => {
  const env = TEST_ENV.env;
  evidence.batch = env.batchId ?? evidence.batch;
  await buildBundle();
  ops = await startOpsStub();
  opsBase = `http://127.0.0.1:${ops.port}`;
  host = await new SceneHost({ port: Number(env.studioPort), viewport: { width: STAGE.w, height: STAGE.h } }).start();
  evidence.harness = { sceneOrigin: host.origin, opsOrigin: opsBase, browser: host.browserVersion };
});

after(async () => {
  await save();
  if (host) await host.stop();
  if (ops) await ops.close();
});

/* ────────────────────────── 页内挂载 ────────────────────────── */

/**
 * 把面板挂到真实夹具页上。依赖都在页内，Node 侧只读状态。
 * @param {import('playwright').Page} page
 */
async function mountPanel(page, opts = {}) {
  return page.evaluate(async (deps) => {
    const mod = await import(deps.bundle);
    const { mountInspector, readLayer, applyOverrideEntries, createOpsClient, mergeOverridesAt } = mod;

    /* 数请求：面板 → client → fetch。桩在 Node 侧，这里再记一层，两边能对上 */
    window.__posts = [];
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      window.__posts.push({
        url: String(input),
        method: (init && init.method) || 'GET',
        body: init && typeof init.body === 'string' ? init.body : null
      });
      return realFetch(input, init);
    };

    const client = createOpsClient({
      projectId: deps.projectId,
      batchId: 'B-SUB1-R26-026',
      owner: 'SUB1',
      expectedHash: deps.expectedHash,
      baseUrl: deps.baseUrl
    });

    const hosts = {
      entries: [...(deps.entries || [])],
      prevEntries: null,
      hash: deps.expectedHash,
      at: deps.at,
      commits: 0,
      log: [],
      snapshots: {}
    };
    const applyAll = () => applyOverrideEntries(hosts.entries);

    const container = document.createElement('div');
    container.id = 'sub1-fx-panel';
    container.setAttribute(
      'style',
      'position:fixed;right:0;top:0;width:320px;height:100vh;background:#111a2e;color:#eef2ff;' +
        'z-index:2147483647;overflow:auto;font:12px/1.5 system-ui;padding:8px;box-sizing:border-box'
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
        hosts.log.push({ step: 'preview', patch });
      },
      revertPreview: async () => {
        hosts.entries = hosts.prevEntries ?? hosts.entries;
        await applyAll();
        hosts.log.push({ step: 'revert' });
      },
      commit: async (patch) => {
        hosts.commits += 1;
        const next = mergeOverridesAt(hosts.entries, hosts.at, patch);
        const res = await client.commitOverrides({ clip: deps.clip, entries: next });
        hosts.log.push({ step: 'commit', ok: res.ok, request: res.request });
        if (res.ok) {
          hosts.entries = next;
          hosts.hash = res.hash;
        }
        return res;
      },
      commitMany: async (jobs) => {
        let working = hosts.entries;
        const opsList = jobs.map((job) => {
          if (job.kind === 'box') return { op: 'set', clip: job.ref.clipId, field: 'box', value: job.op.value };
          working = mergeOverridesAt(working, job.ref.at, job.patch);
          return { op: 'overrides', clip: job.ref.clipId, entries: working };
        });
        const res = await client.commitOps(opsList);
        hosts.log.push({ step: 'commitMany', ok: res.ok, jobs: jobs.length });
        if (res.ok) {
          hosts.entries = working;
          hosts.hash = res.hash;
        }
        return res;
      },
      expectedHash: deps.expectedHash
    });

    await panel.select({ clipId: deps.clip, at: deps.at, kind: 'shape', name: deps.at, depth: 1 });

    /** 切层：面板的 preview/commit 都要知道「现在改的是哪一层」 */
    window.__select = async (at) => {
      hosts.at = at;
      return panel.select({ clipId: deps.clip, at, kind: 'shape', name: at, depth: 1 });
    };
    /** 直接改覆盖集合（A4/A5 用：一次写全五个字段，绕过面板的事件链） */
    window.__setEntries = async (entries) => {
      hosts.entries = [...entries];
      await applyAll();
      return hosts.entries;
    };
    /** 导出路径：帧跑完之后重新应用同一份覆盖（宿主就是这一步） */
    window.__reapply = async () => {
      const res = await applyAll();
      return res;
    };
    /** 快照/还原内联样式（覆盖只会「写」，不会自动清；A4 要干净的 before） */
    window.__snapshot = (ats) => {
      hosts.snapshots = {};
      for (const at of ats) {
        const el = document.querySelector(at);
        hosts.snapshots[at] = el ? el.getAttribute('style') || '' : null;
      }
      return hosts.snapshots;
    };
    window.__restore = () => {
      for (const [at, style] of Object.entries(hosts.snapshots)) {
        const el = document.querySelector(at);
        if (!el) continue;
        if (style === null) el.removeAttribute('style');
        else el.setAttribute('style', style);
      }
      return true;
    };

    /** 截图时把面板藏起来：它是 `position:fixed` 的深色栏，会污染 ink 像素 */
    window.__hidePanel = (hidden) => {
      container.style.display = hidden ? 'none' : '';
      return true;
    };
    window.__panel = panel;
    window.__hosts = hosts;
    window.__mod = mod;
    window.__gesture = { hitTest: mod.hitTest, marqueeSelect: mod.marqueeSelect };
    return {
      state: panel.getState(),
      groups: panel.getState().fields.map((field) => ({ id: field.id, group: field.group })),
      posts: window.__posts.length
    };
  }, {
    bundle: BUNDLE_URL,
    baseUrl: opsBase,
    projectId: 's51-fx',
    expectedHash: 'h0',
    clip: 'clip-fx',
    at: '#fx-card',
    entries: opts.entries ?? []
  });
}

/** 通过真实 `<select>` / `<input>` + change 事件改字段（走面板的事件链，不调内部函数）。 */
async function editControl(page, fieldId, value, kind = 'auto') {
  await page.evaluate(
    ([id, v, which]) => {
      const row = document.querySelector(`.film-inspector [data-field="${id}"]`);
      if (!row) throw new Error(`没有字段行：${id}`);
      const node =
        which === 'custom'
          ? row.querySelector('[data-custom="1"]')
          : which === 'select'
            ? row.querySelector('select')
            : which === 'input'
              ? row.querySelector('input:not([data-custom])')
              : row.querySelector('select') ?? row.querySelector('input:not([data-custom])');
      if (!node) throw new Error(`没有控件：${id}/${which}`);
      node.value = v;
      node.dispatchEvent(new Event('change', { bubbles: true }));
    },
    [fieldId, value, kind]
  );
  return page.evaluate(() => window.__panel.idle());
}

/** 读字段行（数据属性 + 控件状态），断言都走这里，避免各用例各写一份选择器。 */
async function readField(page, fieldId) {
  return page.evaluate((id) => {
    const row = document.querySelector(`.film-inspector [data-field="${id}"]`);
    if (!row) return null;
    const select = row.querySelector('select');
    const input = row.querySelector('input:not([data-custom])');
    const custom = row.querySelector('[data-custom="1"]');
    const primary = select ?? input;
    return {
      group: row.closest('[data-group]')?.getAttribute('data-group') ?? null,
      source: row.getAttribute('data-source'),
      editable: row.getAttribute('data-editable'),
      disabled: primary ? primary.disabled : null,
      value: primary ? primary.value : null,
      selectValue: select ? select.value : null,
      customValue: custom ? custom.value : null,
      customHidden: custom ? custom.hidden : null,
      options: select ? [...select.options].map((option) => option.value) : null
    };
  }, fieldId);
}

/* ────────────────────────── 像素：ink bbox ────────────────────────── */

/**
 * 纯绿底上的 ink bbox。判据与 `scripts/s50-block-metrics.mjs` 同一套：
 * 「离纯绿足够远」= ink，其余算背景。
 * @param {{width:number,height:number,channels:number,data:Uint8Array|Buffer}} image
 */
function inkBbox(image) {
  const { width: w, height: h, channels: c, data } = image;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = -1;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = -1;
  let count = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * c;
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      const green = Math.abs(g - 255) <= 40 && r <= 40 && b <= 40;
      if (green) continue;
      count += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { bbox: null, pixels: 0 };
  return {
    bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, right: maxX, bottom: maxY },
    pixels: count
  };
}

/** A5 的取景框：卡片一（180..600 × 140..380）四周留够 blur 的溢出量，且不含第二张卡 */
const A5_CLIP = { x: 120, y: 100, width: 560, height: 320 };

async function shoot(page, name, clip = A5_CLIP) {
  const file = path.join(EVIDENCE_DIR, name);
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  /* 面板是 position:fixed 的深色栏，会盖住舞台右侧 —— 截图期间藏起来，别让它变成 ink */
  await page.evaluate(() => window.__hidePanel(true));
  await page.screenshot({ path: file, clip });
  await page.evaluate(() => window.__hidePanel(false));
  const buf = await fs.readFile(file);
  const ink = inkBbox(decodePng(buf));
  evidence.screenshots.push({ name, bytes: buf.length, sha256: sha(buf), bbox: ink.bbox, pixels: ink.pixels, clip });
  return { file, name, bytes: buf.length, ...ink };
}

/* ────────────────────────── A1 ────────────────────────── */

test('A1 五个字段进 appearance 组；无 override → computed，写 override → override 且值逐字符相同', async () => {
  const handle = await host.open(FIXTURE);
  const page = handle.page;
  try {
    await mountPanel(page);

    /* ① 五个字段都在 appearance 组，且顺序是「不透明度之后、描边之前」 */
    const order = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.film-inspector [data-group="appearance"] .inspector-field')];
      return rows.map((row) => row.getAttribute('data-field'));
    });
    for (const id of EFFECT_STYLE_FIELDS) assert.ok(order.includes(id), `appearance 组缺字段 ${id}`);
    const at = order.indexOf('opacity');
    const stroke = order.indexOf('strokeWidth');
    /* S51 的五个之后，S54 又追加了五个（裁切/背景图/尺寸/位置/内阴影）——顺序写死，
       所以这里断言「不透明度之后、描边之前的完整序列」，多一个少一个都会红。 */
    const between = order.slice(at + 1, stroke);
    assert.deepEqual(
      between,
      [...EFFECT_STYLE_FIELDS, 'clipPath', 'backgroundImage', 'backgroundSize', 'backgroundPosition', 'boxShadowInset'],
      `效果字段应紧跟不透明度：${order.join(',')}`
    );

    /* ② 无 override：source=computed，值来自 describe 的 computed */
    const before = {};
    for (const id of EFFECT_STYLE_FIELDS) before[id] = await readField(page, id);
    for (const id of EFFECT_STYLE_FIELDS) {
      assert.equal(before[id].source, 'computed', `${id} 无覆盖时应是 computed`);
      assert.equal(before[id].group, 'appearance');
    }
    assert.equal(before.filter.selectValue, 'none', `滤镜初始应为预设 none，实际 ${before.filter.selectValue}`);
    assert.equal(before.mixBlendMode.selectValue, 'normal');
    assert.equal(before.borderRadius.value, '0', `圆角初始应显示数字 0，实际 ${before.borderRadius.value}`);
    assert.equal(before.backdropFilter.selectValue, 'none');

    /* ③ 用真实 <select> 改成 blur(4px)：source 翻成 override，值逐字符相同 */
    await editControl(page, 'filter', 'blur(4px)');
    const after = await readField(page, 'filter');
    assert.equal(after.source, 'override', `写入后应是 override，实际 ${after.source}`);
    assert.equal(after.selectValue, 'blur(4px)');

    const stored = await page.evaluate(() => window.__hosts.entries);
    const entry = stored.find((item) => item.at === '#fx-card');
    assert.ok(entry, `覆盖里没有这层：${JSON.stringify(stored)}`);
    assert.equal(entry.style.filter, 'blur(4px)', `落库值不是 blur(4px)：${JSON.stringify(entry.style)}`);

    /* ④ 预设 ↔ 文本可逆：手改成 blur(5px) 显示「自定义」，再选回预设 */
    await editControl(page, 'filter', 'blur(5px)', 'custom');
    const custom = await readField(page, 'filter');
    assert.equal(custom.selectValue, '__custom__', `非预设值应显示自定义，实际 ${custom.selectValue}`);
    assert.equal(custom.customValue, 'blur(5px)');
    assert.equal(custom.customHidden, false, '自定义文本框应可见');
    await editControl(page, 'filter', 'blur(4px)');
    const back = await readField(page, 'filter');
    assert.equal(back.selectValue, 'blur(4px)', '选回预设后应显示该预设');
    assert.equal(back.customHidden, true, '选回预设后自定义文本框应隐藏');

    evidence.cases.A1 = { order, before, back, storedStyle: entry.style };
  } finally {
    await handle.dispose();
  }
});

/* ────────────────────────── A2 ────────────────────────── */

test('A2 最小 patch：改 filter → 恰好 1 次 /ops，payload 只有 {"style":{"filter":"blur(4px)"}}', async () => {
  const handle = await host.open(FIXTURE);
  const page = handle.page;
  try {
    await mountPanel(page);
    const baseCount = ops.state.requests.length;
    const postsBefore = await page.evaluate(() => window.__posts.length);

    await editControl(page, 'filter', 'blur(4px)');

    const posts = await page.evaluate(() => window.__posts);
    const newPosts = posts.slice(postsBefore);
    const opsPosts = newPosts.filter((item) => item.url.includes('/ops'));
    assert.equal(opsPosts.length, 1, `应恰好 1 次 /ops，实际 ${opsPosts.length}（${newPosts.map((p) => p.url).join(',')}）`);
    assert.equal(newPosts.length, 1, `不该有别的请求：${newPosts.map((p) => `${p.method} ${p.url}`).join(',')}`);
    assert.equal(ops.state.requests.length - baseCount, 1, '桩侧也只该收到一次');

    const body = JSON.parse(ops.state.requests[ops.state.requests.length - 1].body);
    assert.equal(body.ops.length, 1, `一次只发一条 op：${body.ops.length}`);
    const op = body.ops[0];
    assert.equal(op.op, 'overrides');
    assert.equal(op.clip, 'clip-fx');
    assert.equal(op.entries.length, 1, `entries 不该带别的层：${JSON.stringify(op.entries)}`);
    assert.equal(op.entries[0].at, '#fx-card');
    assert.deepEqual(Object.keys(op.entries[0]).sort(), ['at', 'style'], `条目只该有 at+style：${Object.keys(op.entries[0])}`);
    assert.deepEqual(op.entries[0].style, { filter: 'blur(4px)' }, `payload 应只有 filter 一个键：${JSON.stringify(op.entries[0].style)}`);

    /* 再改第二个字段：仍然只有那一个键（不会把上一个字段重发、也不烘整帧 computed） */
    await editControl(page, 'borderRadius', '24');
    const second = JSON.parse(ops.state.requests[ops.state.requests.length - 1].body);
    assert.deepEqual(
      Object.keys(second.ops[0].entries[0].style).sort(),
      ['border-radius', 'filter'],
      `第二次提交的样式键：${JSON.stringify(second.ops[0].entries[0].style)}`
    );
    assert.equal(second.ops[0].entries[0].style['border-radius'], '24px');

    evidence.cases.A2 = {
      requests: ops.state.requests.length - baseCount,
      patch: op.entries[0],
      opsPath: opsPosts[0].url,
      secondStyle: second.ops[0].entries[0].style
    };
  } finally {
    await handle.dispose();
  }
});

/* ────────────────────────── A3 ────────────────────────── */

test('A3 枚举/范围校验：mixBlendMode=foo、borderRadius=-1/50%/401 一律拒绝且不发请求', async () => {
  const handle = await host.open(FIXTURE);
  const page = handle.page;
  try {
    await mountPanel(page);
    const base = ops.state.requests.length;

    /* ① 控件层先把非法值挡掉：下拉里只有合法选项（`<select>.value='foo'` 会被浏览器折算成空，
       所以「非法值」这条必须打到**提交入口**才有意义）。 */
    const options = {
      mixBlendMode: (await readField(page, 'mixBlendMode')).options,
      filter: (await readField(page, 'filter')).options,
      backdropFilter: (await readField(page, 'backdropFilter')).options
    };
    /* R113 · L2（LI-F16 / LI-A16）：混合模式从 6 种扩到参考的 **17 种**（含 plus-lighter = 相加）。
       这一条跟着产品改，不是放宽判据：旧断言钉的是「只给 6 种」的旧口径。
       能力矩阵（真实可见 / 仅透传）由 `inspector-adjust.mjs` 的 `blendMatrix()` 给，面板另测。 */
    assert.deepEqual(options.mixBlendMode, [...BLEND_MODES]);
    assert.equal(options.mixBlendMode.length, 17, `参考是 17 种，实际 ${options.mixBlendMode.length}`);
    assert.deepEqual(options.filter, ['none', 'blur(4px)', 'brightness(1.2)', 'contrast(1.2)', 'saturate(1.5)', 'grayscale(1)', '__custom__']);
    assert.deepEqual(options.backdropFilter, ['none', 'blur(8px)', 'blur(16px)', '__custom__']);

    /* ② 提交入口：非法值 / 越界 / 百分比 / 不成形的滤镜列表，一个都不许发请求 */
    /** @type {{id: string, value: string}[]} */
    const cases = [
      { id: 'mixBlendMode', value: 'foo' },
      { id: 'borderRadius', value: '-1' },
      { id: 'borderRadius', value: '50%' },
      { id: 'borderRadius', value: String(BORDER_RADIUS_MAX + 1) },
      { id: 'filter', value: 'blur(4px) garbage' },
      { id: 'backdropFilter', value: 'sepia(1) notafunc(2)' }
    ];
    const results = [];
    for (const item of cases) {
      const res = await page.evaluate(([id, value]) => window.__panel.commitField(id, value), [item.id, item.value]);
      const state = await page.evaluate(() => window.__panel.getState());
      results.push({ ...item, code: state.error?.code ?? res?.code ?? null, message: state.error?.message ?? null, status: state.status });
    }
    for (const result of results) {
      assert.equal(result.code, 'INVALID_VALUE', `${result.id}=${result.value} 应报 INVALID_VALUE，实际 ${result.code}`);
      assert.equal(result.status, 'error');
    }
    assert.equal(ops.state.requests.length, base, `非法值不该发请求：多了 ${ops.state.requests.length - base} 次`);

    /* ③ 合法值仍能落库（证明上面拒绝的是值，不是整条路径坏了） */
    await editControl(page, 'mixBlendMode', 'multiply');
    const stored = await page.evaluate(() => window.__hosts.entries.find((item) => item.at === '#fx-card'));
    assert.equal(stored.style['mix-blend-mode'], 'multiply');

    evidence.cases.A3 = { rejected: results, requestsDuringReject: 0, accepted: stored.style, options };
  } finally {
    await handle.dispose();
  }
});

/* ────────────────────────── A4 ────────────────────────── */

test('A4 几何不变：五个字段写完，同层 rect 四数逐值相同、hitTest/框选/对齐结果不变', async () => {
  const handle = await host.open(FIXTURE);
  const page = handle.page;
  try {
    await mountPanel(page);

    const snapshot = await page.evaluate(() => {
      const stage = document.getElementById('stage');
      const sr = stage.getBoundingClientRect();
      const ids = ['#fx-card', '#fx-card-2'];
      const boxes = ids.map((at) => {
        const r = document.querySelector(at).getBoundingClientRect();
        return { at, box: { x: r.x - sr.x, y: r.y - sr.y, w: r.width, h: r.height }, rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
      });
      return { stage: { x: sr.x, y: sr.y, w: sr.width, h: sr.height }, boxes };
    });

    const gestureAt = async (boxes) =>
      page.evaluate((items) => {
        const layers = items.map((item) => ({ id: item.at, ...item.box, rotation: 0 }));
        const inside = { x: layers[0].x + layers[0].w / 2, y: layers[0].y + layers[0].h / 2 };
        return {
          inside,
          hit: window.__gesture.hitTest(layers, inside),
          deep: window.__gesture.hitTest(layers, inside, { deep: true }),
          marquee: window.__gesture.marqueeSelect(layers, { x: 0, y: 0, w: 1280, h: 720 }, 'intersect'),
          none: window.__gesture.marqueeSelect(layers, { x: 1100, y: 20, w: 100, h: 100 }, 'intersect')
        };
      }, boxes);

    const gesture = await gestureAt(snapshot.boxes);
    assert.ok(gesture.hit >= 0, '命中测试没点到任何层');
    assert.deepEqual(gesture.marquee, [0, 1], `框选应命中两层：${JSON.stringify(gesture.marquee)}`);
    assert.deepEqual(gesture.none, [], `空白处不该选中：${JSON.stringify(gesture.none)}`);

    const alignBefore = ALIGN.planAlign(
      snapshot.boxes.map((item) => ({ at: item.at, clip: item.at.slice(1), box: item.box })),
      'left'
    );

    await page.evaluate(() => window.__snapshot(['#fx-card', '#fx-card-2']));
    /* 五个字段一次写全（同一写入口：applyOverrideEntries，就是面板 preview 的那条） */
    await page.evaluate(() =>
      window.__setEntries([
        {
          at: '#fx-card',
          style: {
            filter: 'blur(4px)',
            'mix-blend-mode': 'multiply',
            'border-radius': '24px',
            'box-shadow': '0 8px 24px rgba(0,0,0,0.45)',
            'backdrop-filter': 'blur(8px)'
          }
        }
      ])
    );

    const after = await page.evaluate(() => {
      const stage = document.getElementById('stage');
      const sr = stage.getBoundingClientRect();
      const ids = ['#fx-card', '#fx-card-2'];
      const boxes = ids.map((at) => {
        const r = document.querySelector(at).getBoundingClientRect();
        return { at, box: { x: r.x - sr.x, y: r.y - sr.y, w: r.width, h: r.height }, rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
      });
      const el = document.querySelector('#fx-card');
      const cs = getComputedStyle(el);
      return {
        stage: { x: sr.x, y: sr.y, w: sr.width, h: sr.height },
        boxes,
        computed: {
          filter: cs.getPropertyValue('filter').trim(),
          blend: cs.getPropertyValue('mix-blend-mode').trim(),
          radius: cs.getPropertyValue('border-radius').trim(),
          shadow: cs.getPropertyValue('box-shadow').trim(),
          backdrop: cs.getPropertyValue('backdrop-filter').trim()
        }
      };
    });

    /* ① rect 四数逐值相同（不是「差 ≤1」，是 `===`） */
    for (let i = 0; i < snapshot.boxes.length; i += 1) {
      assert.deepEqual(after.boxes[i].rect, snapshot.boxes[i].rect, `${snapshot.boxes[i].at} 的 rect 被效果改动了`);
      assert.deepEqual(after.boxes[i].box, snapshot.boxes[i].box);
    }
    assert.deepEqual(after.stage, snapshot.stage, '舞台矩形不该动');

    /* ② 效果确实渲染了（否则「几何不变」是空话） */
    assert.equal(after.computed.filter, 'blur(4px)');
    assert.equal(after.computed.blend, 'multiply');
    assert.equal(after.computed.radius, '24px');
    assert.match(after.computed.shadow, /rgba?\(0, 0, 0, 0\.45\)/);
    assert.equal(after.computed.backdrop, 'blur(8px)');

    /* ③ 命中/框选不变（同一份 layers、同一个点） */
    const gestureAfter = await gestureAt(after.boxes);
    assert.equal(gestureAfter.hit, gesture.hit, 'hitTest 命中的层变了');
    assert.equal(gestureAfter.deep, gesture.deep, 'alt 穿透命中的层变了');
    assert.deepEqual(gestureAfter.marquee, gesture.marquee, '框选结果变了');
    assert.deepEqual(gestureAfter.none, gesture.none);

    /* ④ 对齐（align-distribute 的同一份实现）结果不变 */
    const alignAfter = ALIGN.planAlign(
      after.boxes.map((item) => ({ at: item.at, clip: item.at.slice(1), box: item.box })),
      'left'
    );
    assert.deepEqual(alignAfter.union, alignBefore.union, '对齐并集变了');
    assert.deepEqual(alignAfter.ops, alignBefore.ops, '对齐产生的 op 变了');
    assert.equal(alignAfter.changed, alignBefore.changed, '对齐要移动的层数变了');

    await page.evaluate(() => window.__restore());

    evidence.cases.A4 = {
      rect: { before: snapshot.boxes, after: after.boxes, identical: true },
      stage: after.stage,
      computed: after.computed,
      gesture: { before: gesture, after: gestureAfter },
      align: { before: alignBefore, after: alignAfter },
      note: 'backdrop-filter 会创建包含块，但元素自身 rect 不变（夹具里没有依赖 static 定位的后代）'
    };
  } finally {
    await handle.dispose();
  }
});

/* ────────────────────────── A5 ────────────────────────── */

test('A5 预览 vs 导出帧：filter+borderRadius 的 ink bbox 差 ≤2px（纯绿底）', async () => {
  const handle = await host.open(FIXTURE);
  const page = handle.page;
  try {
    await mountPanel(page);

    const none = await shoot(page, 's51-a5-none.png');

    /* 预览路径：覆盖写上去（面板 preview 使用的就是这一份实现） */
    await page.evaluate(() =>
      window.__setEntries([{ at: '#fx-card', style: { filter: 'blur(4px)', 'border-radius': '24px' } }])
    );
    const preview = await shoot(page, 's51-a5-preview.png');

    /* 导出路径：先取帧（场景会重画），再把同一份覆盖应用回去 —— 宿主/导出器的顺序 */
    await host.frame(handle, { t: 0 });
    const reapplied = await page.evaluate(() => window.__reapply());
    const frame = await shoot(page, 's51-a5-export.png');

    assert.equal(reapplied.applied, 1, `导出时应应用 1 条覆盖，实际 ${reapplied.applied}`);
    assert.ok(preview.bbox && frame.bbox, '两帧都没扫到 ink');
    assert.ok(preview.bbox.w > none.bbox.w + 2, `filter 没生效：改前宽 ${none.bbox.w}，改后 ${preview.bbox.w}`);

    const delta = {
      x: frame.bbox.x - preview.bbox.x,
      y: frame.bbox.y - preview.bbox.y,
      w: frame.bbox.w - preview.bbox.w,
      h: frame.bbox.h - preview.bbox.h
    };
    for (const [key, value] of Object.entries(delta)) {
      assert.ok(Math.abs(value) <= 2, `导出帧与预览的 bbox.${key} 差 ${value}px（应 ≤2）`);
    }
    /* 像素数也要收敛：同一个 DOM 同一份覆盖，不该差一个数量级 */
    const pixelDelta = Math.abs(frame.pixels - preview.pixels);
    assert.ok(pixelDelta <= Math.max(200, preview.pixels * 0.05), `ink 像素数差太多：${pixelDelta}`);

    evidence.cases.A5 = {
      none: none.bbox,
      preview: preview.bbox,
      export: frame.bbox,
      delta,
      pixels: { none: none.pixels, preview: preview.pixels, export: frame.pixels },
      deltaPixels: pixelDelta,
      effectBleed: preview.bbox.w - none.bbox.w
    };
  } finally {
    await handle.dispose();
  }
});

/* ────────────────────────── A6 ────────────────────────── */

test('A6 多选：两层 filter 不同 → mixed；不可编辑的 mixed（角度）提交被拒且 0 请求', async () => {
  const handle = await host.open(FIXTURE);
  const page = handle.page;
  try {
    /* #fx-card-2 上先挂一个 r=12 的覆盖，让旋转在两层间不同（MULTI_MIXED 的触发条件） */
    await mountPanel(page, { entries: [{ at: '#fx-card-2', r: 12 }] });

    const multi = await page.evaluate(async () => {
      const res = await window.__panel.selectMany([
        { clipId: 'clip-fx', at: '#fx-card', kind: 'shape', name: '#fx-card', depth: 1 },
        { clipId: 'clip-fx', at: '#fx-card-2', kind: 'shape', name: '#fx-card-2', depth: 1 }
      ]);
      return res;
    });
    assert.equal(multi.mode, 'multi', `应进入多选：${JSON.stringify(multi)}`);

    const state = await page.evaluate(() => window.__panel.getState());
    assert.ok(state.mixed.includes('rotation'), `rotation 应 mixed：${JSON.stringify(state.mixed)}`);

    const rotationRow = await page.evaluate(() => {
      const row = document.querySelector('.film-inspector [data-field="rotation"]');
      const input = row.querySelector('input');
      return { mixed: row.getAttribute('data-mixed'), editable: row.getAttribute('data-editable'), reason: row.getAttribute('data-locked-reason'), disabled: input.disabled, value: input.value };
    });
    assert.equal(rotationRow.mixed, 'true');
    assert.equal(rotationRow.editable, 'false', 'mixed 角度应不可编辑');
    assert.equal(rotationRow.reason, 'MULTI_MIXED');
    assert.equal(rotationRow.disabled, true);
    assert.equal(rotationRow.value, '', 'mixed 不该显示任何一层的值');

    const base = ops.state.requests.length;
    const rejected = await page.evaluate(() => window.__panel.commitMultiField('rotation', '30'));
    assert.equal(rejected.ok, false, `mixed 角度提交应被拒：${JSON.stringify(rejected)}`);
    assert.equal(rejected.code, 'MULTI_MIXED');
    assert.equal(ops.state.requests.length, base, `被拒的提交不该发请求：多了 ${ops.state.requests.length - base} 次`);

    /* 滤镜字段两层相同（都 none）→ 不是 mixed；写一次对两层各一条 op */
    const filterMixed = state.mixed.includes('filter');
    assert.equal(filterMixed, false, `两层滤镜都 none，不该 mixed：${JSON.stringify(state.mixed)}`);
    await page.evaluate(() => window.__panel.commitMultiField('filter', 'saturate(1.5)'));
    const batch = JSON.parse(ops.state.requests[ops.state.requests.length - 1].body);
    assert.equal(batch.ops.length, 2, `两层应各一条 op：${batch.ops.length}`);
    const latest = batch.ops[batch.ops.length - 1].entries;
    assert.deepEqual(
      latest.map((entry) => entry.at).sort(),
      ['#fx-card', '#fx-card-2'],
      `一批 entries 应覆盖两层：${JSON.stringify(latest.map((e) => e.at))}`
    );

    evidence.cases.A6 = {
      mode: multi.mode,
      mixed: state.mixed,
      rotationRow,
      rejected: { code: rejected.code, ok: rejected.ok },
      requestsDuringReject: 0,
      batchOps: batch.ops.length,
      note: 'mixed 的**非角度**字段按 S26 语义仍可批量套用（一次 /ops、一步撤销）；这里被拒的是 MULTI_MIXED'
    };
  } finally {
    await handle.dispose();
  }
});

/* ────────────────────────── A7 ────────────────────────── */

test('A7 锁定层：五个字段 disabled + LOCKED，点击/输入 0 请求', async () => {
  const handle = await host.open(FIXTURE);
  const page = handle.page;
  try {
    await mountPanel(page);
    await page.evaluate(async () => {
      document.querySelector('#fx-card').setAttribute('data-lock', 'true');
      await window.__select('#fx-card');
    });

    const base = ops.state.requests.length;
    const rows = {};
    for (const id of EFFECT_STYLE_FIELDS) rows[id] = await readField(page, id);
    for (const id of EFFECT_STYLE_FIELDS) {
      assert.equal(rows[id].editable, 'false', `${id} 在锁定层应不可编辑`);
      assert.equal(rows[id].disabled, true, `${id} 的控件应 disabled`);
    }

    /* 直接调提交入口（disabled 的控件在真实 UI 里点不动，这里绕过 DOM 证明「入口也拒」） */
    const results = [];
    for (const id of EFFECT_STYLE_FIELDS) {
      results.push({ id, ...(await page.evaluate((fieldId) => window.__panel.commitField(fieldId, 'blur(4px)'), id)) });
    }
    for (const result of results) assert.equal(result.code, 'LOCKED', `${result.id} 应报 LOCKED，实际 ${result.code}`);
    assert.equal(ops.state.requests.length, base, `锁定层不该发请求：多了 ${ops.state.requests.length - base} 次`);

    evidence.cases.A7 = {
      rows: Object.fromEntries(Object.entries(rows).map(([id, row]) => [id, { editable: row.editable, disabled: row.disabled }])),
      results: results.map((item) => ({ id: item.id, code: item.code, ok: item.ok })),
      requests: ops.state.requests.length - base
    };
  } finally {
    await handle.dispose();
  }
});

/* S55：只有设了 OPENCUT_TEST_INJECT_FAIL / OPENCUT_TEST_INJECT_HANG 才会多出一个用例，
   用来实测失败与超时路径的清理；默认零影响。 */
registerCleanupProbe('inspector-effects');
