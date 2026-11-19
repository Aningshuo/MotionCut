/**
 * M69：页面域 v2（B-MAIN-R30-034）。
 *
 * 这里用**注入的 page**（`options.readApiPage(projectId, target)`）验证
 * 「路由 + 元素域解析 + 契约投影 + 错误码」，不启动浏览器；真实浏览器路径由
 * `scripts/m69-page-domain.mjs` 的 e2e 覆盖。
 *
 * 固定语义：
 *   - 裸 id = v1（film.html 文档，`scope:"clip"`）；
 *   - `<clipId>::<elementId>` = 页面片段自己的文档（`scope:"page"`）；
 *   - 非 page 片段传 `clip` / 统一 id 前缀 → 409 `CLIP_NOT_PAGE`。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { startStudio } from '../studio-server.mjs';

const FILM = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>M69 单测夹具</title></head>
<body>
  <section id="pages">
    <iframe id="page-main" src="page.html#t=0,12" at="1" size="1280x720"
            overrides='[{"at":"#footer","lock":true}]'
            style="left:0px;top:0px;width:1280px;height:720px"></iframe>
  </section>
  <section id="v1">
    <video id="clip-video" src="assets/bars.webm#t=0,2" at="0" style="left:0px;top:0px;width:64px;height:36px"></video>
  </section>
</body>
</html>
`;

const PAGE_IDS = ['#title', '#subtitle', '#card', '#badge', '#photo', '#caption', '#footer'];

/** @param {any} buffer */
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');

/**
 * 页内实测值（tag/text/box）。
 * @param {string[]} ids
 */
function measuredOf(ids) {
  /** @type {Record<string, any>} */
  const map = {};
  ids.forEach((/** @type {string} */ id, /** @type {number} */ index) => {
    map[id] = {
      at: id,
      tag: id === '#photo' ? 'img' : id === '#card' || id === '#badge' ? 'div' : 'p',
      text: `文本 ${index}`,
      box: { x: 10 + index * 5, y: 20 + index * 3, w: 100, h: 30 },
    };
  });
  return map;
}

/** buildInspector 需要的 describe 结果。 */
function describedValue(overrides = {}) {
  return {
    ok: true,
    value: {
      box: { x: 96, y: 600, w: 640, h: 28, rotation: 0 },
      style: {
        'font-size': '14px',
        'font-weight': '400',
        'line-height': '20px',
        'letter-spacing': 'normal',
        'text-align': 'left',
        color: '#48576b',
        'background-color': 'rgba(0, 0, 0, 0)',
        opacity: '1',
        'text-shadow': 'none',
        '-webkit-text-stroke-width': '0px',
        '-webkit-text-stroke-color': 'rgb(0, 0, 0)',
        filter: 'none',
        'mix-blend-mode': 'normal',
        'border-radius': '0px',
        'box-shadow': 'none',
        'backdrop-filter': 'none',
        'clip-path': 'none',
      },
      inline: {},
      locked: false,
      text: '锁定层：用来验证 editable:false',
      tag: 'p',
      ...overrides,
    },
  };
}

/**
 * 假 page：discover/describe/locate/frame 只用到这几个方法。
 * @param {{snapshot?: any, measured?: any, located?: any, described?: any, frame?: string}} [state]
 */
function fakePage(state = {}) {
  /** @type {Array<(error: any) => void>} */
  const errorHandlers = [];
  /** @type {{frames: number[], unknown: number}} */
  const calls = { frames: [], unknown: 0 };
  const page = {
    calls,
    isClosed: () => false,
    url: () => 'http://127.0.0.1:0/p/fake/page.html',
    /** @param {string} event @param {any} handler */
    on(event, handler) {
      if (event === 'pageerror') errorHandlers.push(handler);
    },
    /** @param {string} message */
    emitError(message) {
      for (const handler of errorHandlers) handler(new Error(message));
    },
    /** @param {any} fn @param {any} arg */
    async evaluate(fn, arg) {
      const name = typeof fn === 'function' ? fn.name : '';
      if (name === 'snapshotLayers') return state.snapshot ?? { layers: [], unsupported: [], pixelOnly: [] };
      if (name === 'measureLayersInPage') {
        const measured = state.measured ?? {};
        if (typeof measured === 'function') return measured(arg);
        return arg.map((/** @type {string} */ at) => measured[at]).filter((/** @type {any} */ item) => item !== undefined);
      }
      if (name === 'locateByAt') {
        const located = state.located ?? {};
        return located[arg] ?? { matches: 0 };
      }
      if (name === 'readLayer') return state.described ?? { ok: false, error: { code: 'LAYER_GONE', message: 'no' } };
      if (name === '' && String(fn).includes('film.frame')) {
        calls.frames.push(arg);
        return state.frame ?? 'OK';
      }
      calls.unknown += 1;
      return 3;
    },
  };
  return page;
}

/**
 * 一个工程的两种文档：film.html 与 page.html。
 * @param {{pageIds?: string[], frame?: string}} [options]
 */
function dualPages(options = {}) {
  /** @type {{film: number, page: number}} */
  const calls = { film: 0, page: 0 };
  const filmPage = fakePage({
    snapshot: {
      layers: [{ at: '#page-main', kind: 'container', name: 'page-main', depth: 1, parentAt: null }],
      unsupported: [],
      pixelOnly: [],
    },
    measured: {
      '#page-main': { at: '#page-main', tag: 'iframe', text: '', box: { x: 0, y: 0, w: 1280, h: 720 } },
      '#clip-video': { at: '#clip-video', tag: 'video', text: '', box: { x: 0, y: 0, w: 64, h: 36 } },
    },
    located: {
      '#page-main': { matches: 1, kind: 'container', name: 'page-main' },
      '#footer': { matches: 1, kind: 'text', name: 'footer' },
    },
    described: describedValue(),
  });
  const ids = options.pageIds ?? PAGE_IDS;
  const snapshotLayers = ids.map((/** @type {string} */ id, /** @type {number} */ index) => ({
    at: id,
    kind: index === 4 ? 'image' : 'text',
    name: id.slice(1),
    depth: 1,
    parentAt: null,
  }));
  const pagePage = fakePage({
    snapshot: { layers: snapshotLayers, unsupported: [], pixelOnly: [] },
    measured: measuredOf(ids),
    located: Object.fromEntries(ids.map((/** @type {string} */ id) => [id, { matches: 1, kind: 'text', name: id.slice(1) }])),
    described: describedValue(),
    frame: options.frame ?? 'OK',
  });
  return {
    filmPage,
    pagePage,
    calls,
    provider: async (/** @type {string} */ projectId, /** @type {any} */ target) => {
      if (target.kind === 'page') {
        calls.page += 1;
        return pagePage;
      }
      calls.film += 1;
      return filmPage;
    },
  };
}

/**
 * 起 Studio + 临时工程。
 * @param {(ctx: {dir: string, projectId: string, studio: any, pages: any}) => Promise<void>} fn
 * @param {{pageIds?: string[], frame?: string}} [options]
 */
async function withProject(fn, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-m69-'));
  await fs.mkdir(path.join(dir, '.film'), { recursive: true });
  await fs.writeFile(path.join(dir, 'film.html'), FILM, 'utf8');
  await fs.writeFile(path.join(dir, 'page.html'), '<!doctype html><html><body><h1 id="title">t</h1></body></html>', 'utf8');
  const pages = dualPages(options);
  const studio = await startStudio({ port: 0, vitePort: 59999, readApiPage: pages.provider });
  try {
    const response = await fetch(`${studio.url}/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    const projectId = body?.project?.projectId;
    assert.equal(typeof projectId, 'string');
    await fn({ dir, projectId, studio, pages });
  } finally {
    await studio.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/**
 * @param {string} base
 * @param {string} pathname
 */
async function getJson(base, pathname) {
  const response = await fetch(`${base}${pathname}`);
  return { status: response.status, body: await response.json() };
}

/**
 * @param {string} base
 * @param {any} body
 */
async function inspect(base, body) {
  const response = await fetch(`${base}/api/elements/inspect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

/* ── A. layers：page 片段导航 ──────────────────────────────────────────── */

test('A1 clip=<page 片段>：返回页面内部元素，scope/clipId 回显', async () => {
  await withProject(async ({ studio, projectId }) => {
    const result = await getJson(studio.url, `/api/layers?project=${encodeURIComponent(projectId)}&clip=page-main`);
    assert.equal(result.status, 200);
    assert.equal(result.body.scope, 'page');
    assert.equal(result.body.clipId, 'page-main');
    assert.deepEqual(
      result.body.layers.map((/** @type {any} */ layer) => layer.id),
      PAGE_IDS,
    );
    assert.deepEqual(Object.keys(result.body.layers[0]).sort(), ['box', 'id', 'source', 'tag', 'text']);
    assert.deepEqual(result.body.pageErrors, []);
  });
});

test('A2 page 片段的 frame(t) 用片段自己的 local 时间（in + (t-at)*speed）', async () => {
  await withProject(async ({ studio, projectId, pages }) => {
    // 夹具：at=1、time=[0,12]、speed=1；t=5 → local = 0 + (5-1) = 4
    const result = await getJson(studio.url, `/api/layers?project=${encodeURIComponent(projectId)}&clip=page-main&t=5`);
    assert.equal(result.status, 200);
    assert.equal(result.body.pageTime, 4);
    assert.equal(result.body.frameStatus, 'OK');
    assert.deepEqual(pages.pagePage.calls.frames, [4]);
  });
});

test('A3 无 clip：v1 语义（film.html 文档），响应没有 scope 字段', async () => {
  await withProject(async ({ studio, projectId }) => {
    const result = await getJson(studio.url, `/api/layers?project=${encodeURIComponent(projectId)}`);
    assert.equal(result.status, 200);
    assert.equal(Object.hasOwn(result.body, 'scope'), false);
    assert.deepEqual(
      result.body.layers.map((/** @type {any} */ layer) => layer.id),
      ['#page-main'],
    );
  });
});

test('A4 clip=<非 page 片段> → 409 CLIP_NOT_PAGE', async () => {
  await withProject(async ({ studio, projectId }) => {
    const result = await getJson(studio.url, `/api/layers?project=${encodeURIComponent(projectId)}&clip=clip-video`);
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'CLIP_NOT_PAGE');
    assert.match(result.body.message, /clip-video/);
  });
});

test('A5 clip=<不存在的片段> → 404 ELEMENT_NOT_FOUND', async () => {
  await withProject(async ({ studio, projectId }) => {
    const result = await getJson(studio.url, `/api/layers?project=${encodeURIComponent(projectId)}&clip=nope`);
    assert.equal(result.status, 404);
    assert.equal(result.body.code, 'ELEMENT_NOT_FOUND');
  });
});

test('A6 页面 discover 失败 → 502 PAGE_UNREACHABLE(DISCOVER_FAILED)', async () => {
  await withProject(async ({ studio, projectId, pages }) => {
    pages.pagePage.evaluate = async (/** @type {any} */ fn) => {
      if (typeof fn === 'function' && fn.name === 'snapshotLayers') {
        throw new Error('renderer crashed');
      }
      return 3;
    };
    const result = await getJson(studio.url, `/api/layers?project=${encodeURIComponent(projectId)}&clip=page-main`);
    assert.equal(result.status, 502);
    assert.equal(result.body.code, 'PAGE_UNREACHABLE');
    assert.equal(result.body.reason, 'DISCOVER_FAILED');
    assert.match(result.body.message, /renderer crashed/);
  });
});

/* ── B. inspect：统一 id ──────────────────────────────────────────────── */

test('B1 裸 id：scope=clip、elementId 原样回显、clipId 取主轨第一个', async () => {
  await withProject(async ({ studio, projectId }) => {
    const result = await inspect(studio.url, { project: projectId, elementId: '#page-main' });
    assert.equal(result.status, 200);
    assert.equal(result.body.scope, 'clip');
    assert.equal(result.body.elementId, '#page-main');
    assert.equal(result.body.clipId, 'page-main');
    assert.ok(result.body.groups.length >= 2);
    assert.deepEqual(Object.keys(result.body.groups[0].fields[0]).sort(), ['editable', 'key', 'label', 'unit', 'value']);
  });
});

test('B2 <clip>::<element>：进页面文档，scope=page、elementId 原样回显', async () => {
  await withProject(async ({ studio, projectId, pages }) => {
    const result = await inspect(studio.url, { project: projectId, elementId: 'page-main::#title' });
    assert.equal(result.status, 200);
    assert.equal(result.body.scope, 'page');
    assert.equal(result.body.elementId, 'page-main::#title');
    assert.equal(result.body.clipId, 'page-main');
    assert.equal(result.body.frameStatus, 'OK');
    assert.equal(pages.calls.page, 1);
    // 文字组的 current 来自 describe（不是 override）
    const text = result.body.groups.find((/** @type {any} */ group) => group.id === 'text');
    assert.equal(text.fields[0].value, '锁定层：用来验证 editable:false');
  });
});

test('B3 页面元素的 override 从片段的 overrides 读（#footer lock → 全部 editable:false）', async () => {
  await withProject(async ({ studio, projectId }) => {
    const result = await inspect(studio.url, { project: projectId, elementId: 'page-main::#footer' });
    assert.equal(result.status, 200);
    /** @type {any[]} */
    const fields = result.body.groups.flatMap((/** @type {any} */ group) => group.fields);
    assert.ok(fields.length > 0);
    assert.equal(
      fields.every((/** @type {any} */ field) => field.editable === false),
      true,
      '锁定的层所有字段都不可编辑',
    );
  });
});

test('B4 <clip>::<missing> → 404 ELEMENT_NOT_FOUND', async () => {
  await withProject(async ({ studio, projectId }) => {
    const result = await inspect(studio.url, { project: projectId, elementId: 'page-main::#nope' });
    assert.equal(result.status, 404);
    assert.equal(result.body.code, 'ELEMENT_NOT_FOUND');
    assert.match(result.body.message, /#nope/);
  });
});

test('B5 <非 page 片段>::<element> → 409 CLIP_NOT_PAGE', async () => {
  await withProject(async ({ studio, projectId }) => {
    const result = await inspect(studio.url, { project: projectId, elementId: 'clip-video::#title' });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'CLIP_NOT_PAGE');
  });
});

test('B6 <不存在的片段>::<element> → 404 ELEMENT_NOT_FOUND', async () => {
  await withProject(async ({ studio, projectId }) => {
    const result = await inspect(studio.url, { project: projectId, elementId: 'ghost::#title' });
    assert.equal(result.status, 404);
    assert.equal(result.body.code, 'ELEMENT_NOT_FOUND');
    assert.match(result.body.message, /ghost/);
  });
});

test('B7 非法统一 id（空片段 / 空元素）→ 400 BAD_REQUEST', async () => {
  await withProject(async ({ studio, projectId }) => {
    for (const elementId of ['::#title', 'page-main::']) {
      const result = await inspect(studio.url, { project: projectId, elementId });
      assert.equal(result.status, 400, elementId);
      assert.equal(result.body.code, 'BAD_REQUEST');
    }
  });
});

test('B8 工程未打开 / 参数缺失：404 FILM_NOT_FOUND、400 BAD_REQUEST', async () => {
  await withProject(async ({ studio, projectId }) => {
    const missing = await inspect(studio.url, { project: 'no-such-project', elementId: '#title' });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'FILM_NOT_FOUND');
    const blank = await inspect(studio.url, { project: projectId, elementId: '   ' });
    assert.equal(blank.status, 400);
    assert.equal(blank.body.code, 'BAD_REQUEST');
  });
});

/* ── C. 并发 / 性能 / 只读 ────────────────────────────────────────────── */

test('C1 并发 4 个 page 请求：结果一致、互不串页', async () => {
  await withProject(async ({ studio, projectId, pages }) => {
    const url = `${studio.url}/api/layers?project=${encodeURIComponent(projectId)}&clip=page-main`;
    const responses = await Promise.all([fetch(url), fetch(url), fetch(url), fetch(url)]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    for (const body of bodies) {
      assert.deepEqual(body.layers, bodies[0].layers);
      assert.equal(body.scope, 'page');
    }
    assert.equal(pages.calls.page, 4, '每次请求都要取页面（注入的 provider 每次都返回同一个 page）');
    assert.equal(pages.calls.film, 0, 'page 请求不能落到 film.html');
    assert.equal(pages.pagePage.calls.frames.length, 4, '每个请求都要把页面画到 t');
  });
});

test('C2 100 元素页面：热态投影 ≤300ms', async () => {
  const ids = Array.from({ length: 100 }, (_, index) => `#e${index}`);
  await withProject(async ({ studio, projectId }) => {
    const url = `${studio.url}/api/layers?project=${encodeURIComponent(projectId)}&clip=page-main`;
    // 预热两次（首次含模块加载）
    await getJson(studio.url, `/api/layers?project=${encodeURIComponent(projectId)}&clip=page-main`);
    await getJson(studio.url, `/api/layers?project=${encodeURIComponent(projectId)}&clip=page-main`);
    /** @type {number[]} */
    const timings = [];
    for (let round = 0; round < 5; round += 1) {
      const started = process.hrtime.bigint();
      const result = await getJson(studio.url, `/api/layers?project=${encodeURIComponent(projectId)}&clip=page-main`);
      timings.push(Number(process.hrtime.bigint() - started) / 1e6);
      assert.equal(result.status, 200);
      assert.equal(result.body.layers.length, 100);
    }
    const best = Math.min(...timings);
    assert.ok(best <= 300, `100 元素 layers 最快 ${best.toFixed(1)}ms > 300ms（${timings.map((n) => n.toFixed(1)).join('/')}）`);
    process.stdout.write(`# perf 100-elements layers=${timings.map((n) => n.toFixed(1)).join('/')}ms url=${url.length}\n`);
  }, { pageIds: ids });
});

test('C3 只读：多次 page 域 layers/inspect 后 film.html 与 page.html 的 sha 不变', async () => {
  await withProject(async ({ dir, studio, projectId }) => {
    const filmPath = path.join(dir, 'film.html');
    const pagePath = path.join(dir, 'page.html');
    const before = { film: sha(await fs.readFile(filmPath)), page: sha(await fs.readFile(pagePath)) };
    for (let round = 0; round < 3; round += 1) {
      await getJson(studio.url, `/api/layers?project=${encodeURIComponent(projectId)}&clip=page-main&t=${round}`);
      await inspect(studio.url, { project: projectId, elementId: 'page-main::#title', t: round });
    }
    const after = { film: sha(await fs.readFile(filmPath)), page: sha(await fs.readFile(pagePath)) };
    assert.deepEqual(after, before);
  });
});
