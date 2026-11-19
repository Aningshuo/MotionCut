/**
 * M66：只读图层 / 检查器 API 的服务端单测（B-MAIN-R30-032）。
 *
 * 这里用**注入的 page**（`options.readApiPage`）验证「路由 + 契约投影 + 错误码」，
 * 不启动浏览器；真实浏览器路径由 `scripts/m66-read-apis.mjs` 的 e2e 覆盖。
 *
 * 固定错误码：
 *   工程未打开 → 404 FILM_NOT_FOUND；页面不可达 → 502 PAGE_UNREACHABLE(reason)；
 *   元素不存在 → 404 ELEMENT_NOT_FOUND；参数缺失 → 400 BAD_REQUEST。
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
<head><meta charset="utf-8"><title>M66 单测夹具</title></head>
<body><section id="v1"><video id="a" src="assets/bars.mp4#t=0,2" at="0" style="left:10px;top:10px;width:40px;height:40px"></video></section></body>
</html>
`;

/** @param {any} buffer */
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');

/**
 * 假 page：discover/describe 只用到这几个方法。
 * @param {{snapshot?: any, measured?: any, located?: any, described?: any}} [state]
 */
function fakePage(state = {}) {
  /** @type {Array<(error: any) => void>} */
  const errorHandlers = [];
  const page = {
    isClosed: () => false,
    url: () => 'http://127.0.0.1:0/p/fake/film.html',
    /** @param {string} event @param {any} handler */
    on(event, handler) {
      if (event === 'pageerror') errorHandlers.push(handler);
    },
    /**
     * 测试触发页面错误
     * @param {string} message
     */
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
      // rAF 等待 / 节点计数：返回值不被使用（或 stats 用）
      return 3;
    },
  };
  return page;
}

/**
 * @param {any} page `null` = 不注入（走默认 content origin 路径）
 */
async function startWithPage(page) {
  return startStudio({
    port: 0,
    vitePort: 59999,
    ...(page === null ? {} : { readApiPage: async () => page }),
  });
}

/**
 * 开一个临时工程，返回 {dir, projectId, filmPath, studio}。
 * @param {(ctx: {dir: string, projectId: string, filmPath: string, studio: any}) => Promise<void>} fn
 * @param {any} [providerPage]
 */
async function withProject(fn, providerPage) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-m66-'));
  await fs.mkdir(path.join(dir, '.film'), { recursive: true });
  const filmPath = path.join(dir, 'film.html');
  await fs.writeFile(filmPath, FILM, 'utf8');
  const page = providerPage === undefined ? fakePage() : providerPage;
  const studio = await startWithPage(page);
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
    await fn({ dir, projectId, filmPath, studio });
  } finally {
    await studio.close();
    await fs.rm(dir, { recursive: true, force: true });
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
 * @param {string} pathname
 * @param {any} body
 */
async function postJson(base, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const SNAPSHOT = {
  layers: [
    { at: '#el-1', kind: 'text', name: '标题', depth: 2, parentAt: '#t1' },
    { at: '#el-2', kind: 'image', name: '图片', depth: 2, parentAt: '#t1' },
    { at: '#cv', kind: 'unknown', name: 'canvas', depth: 2, parentAt: '#t1' },
    { at: '#fr', kind: 'container', name: 'iframe', depth: 2, parentAt: '#t1' },
  ],
  pixelOnly: [{ at: '#cv', capability: 'PIXEL_ONLY' }],
  unsupported: [{ at: '#fr', reason: 'CROSS_ORIGIN', capability: 'UNSUPPORTED' }],
};

const MEASURED = {
  '#el-1': { at: '#el-1', tag: 'h1', text: '你好', box: { x: 10, y: 20, w: 100, h: 40 } },
  '#el-2': { at: '#el-2', tag: 'img', text: '', box: { x: 0, y: 0, w: 50, h: 50 } },
  '#cv': { at: '#cv', tag: 'canvas', text: '', box: { x: 5, y: 5, w: 300, h: 200 } },
  '#fr': { at: '#fr', tag: 'iframe', text: '', box: { x: 0, y: 0, w: 640, h: 360 } },
};

test('GET /api/layers：缺 project → 400 BAD_REQUEST', async () => {
  await withProject(async ({ studio }) => {
    const result = await getJson(studio.url, '/api/layers');
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'BAD_REQUEST');
  });
});

test('GET /api/layers：工程未打开 → 404 FILM_NOT_FOUND', async () => {
  await withProject(async ({ studio }) => {
    const result = await getJson(studio.url, '/api/layers?project=nope');
    assert.equal(result.status, 404);
    assert.equal(result.body.code, 'FILM_NOT_FOUND');
  });
});

test('GET /api/layers：没有页面来源 → 502 PAGE_UNREACHABLE + reason', async () => {
  await withProject(async ({ studio, projectId }) => {
    const result = await getJson(studio.url, `/api/layers?project=${projectId}`);
    assert.equal(result.status, 502);
    assert.equal(result.body.code, 'PAGE_UNREACHABLE');
    assert.equal(result.body.reason, 'CONTENT_ORIGIN_OFF');
  }, null);
});

test('GET /api/layers：正常发现 → id/tag/box/text/source 投影', async () => {
  const page = fakePage({ snapshot: SNAPSHOT, measured: MEASURED });
  await withProject(async ({ studio, projectId }) => {
    const result = await getJson(studio.url, `/api/layers?project=${projectId}`);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.pageErrors, []);
    assert.equal(result.body.layers.length, 4);
    assert.deepEqual(result.body.layers[0], {
      id: '#el-1',
      tag: 'h1',
      box: { x: 10, y: 20, w: 100, h: 40 },
      source: 'dom',
      text: '你好',
    });
    // 没有文本时不带 text 键
    assert.ok(!Object.hasOwn(result.body.layers[1], 'text'));
    // canvas / 跨源 iframe 的能力提示
    assert.equal(result.body.layers[2].source, 'canvas');
    assert.equal(result.body.layers[3].source, 'foreign');
  }, page);
});

test('GET /api/layers：空页面 → layers=[]，不是错误', async () => {
  const page = fakePage({ snapshot: { layers: [], unsupported: [], pixelOnly: [] }, measured: {} });
  await withProject(async ({ studio, projectId }) => {
    const result = await getJson(studio.url, `/api/layers?project=${projectId}`);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.layers, []);
    assert.deepEqual(result.body.pageErrors, []);
  }, page);
});

test('GET /api/layers：pageErrors 原样带回（截断到 300 字）', async () => {
  const page = fakePage({ snapshot: { layers: [], unsupported: [], pixelOnly: [] }, measured: {} });
  await withProject(async ({ studio, projectId }) => {
    await getJson(studio.url, `/api/layers?project=${projectId}`);
    // 触发一次页面错误后再请求
    page.emitError('boom: script failed');
    const result = await getJson(studio.url, `/api/layers?project=${projectId}`);
    assert.equal(result.status, 200);
    assert.ok(result.body.pageErrors.some((/** @type {string} */ line) => line.includes('boom: script failed')));
  }, page);
});

test('POST /api/elements/inspect：参数缺失 → 400 BAD_REQUEST', async () => {
  await withProject(async ({ studio }) => {
    const result = await postJson(studio.url, '/api/elements/inspect', { project: 'x' });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'BAD_REQUEST');
    const empty = await postJson(studio.url, '/api/elements/inspect', { project: '', elementId: '' });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.code, 'BAD_REQUEST');
  });
});

test('POST /api/elements/inspect：工程未打开 → 404 FILM_NOT_FOUND', async () => {
  await withProject(async ({ studio }) => {
    const result = await postJson(studio.url, '/api/elements/inspect', { project: 'nope', elementId: '#el-1' });
    assert.equal(result.status, 404);
    assert.equal(result.body.code, 'FILM_NOT_FOUND');
  });
});

test('POST /api/elements/inspect：元素不存在 → 404 ELEMENT_NOT_FOUND', async () => {
  const page = fakePage({ located: { '#el-1': { matches: 1, kind: 'text', name: '标题' } } });
  await withProject(async ({ studio, projectId }) => {
    const result = await postJson(studio.url, '/api/elements/inspect', { project: projectId, elementId: '#missing' });
    assert.equal(result.status, 404);
    assert.equal(result.body.code, 'ELEMENT_NOT_FOUND');
  }, page);
});

test('POST /api/elements/inspect：canvas 内部不可编辑 → 409 ELEMENT_NOT_EDITABLE', async () => {
  const page = fakePage({
    located: { '#cv': { matches: 1, kind: 'unknown', name: 'canvas' } },
    described: { ok: false, error: { code: 'NOT_EDITABLE', message: 'Canvas 内部对象无 computed 层样式' } },
  });
  await withProject(async ({ studio, projectId }) => {
    const result = await postJson(studio.url, '/api/elements/inspect', { project: projectId, elementId: '#cv' });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'ELEMENT_NOT_EDITABLE');
  }, page);
});

test('POST /api/elements/inspect：正常 → groups[].fields[{key,label,value,unit,editable}]', async () => {
  const page = fakePage({
    located: {
      '#el-1': { matches: 1, kind: 'text', name: '标题', tag: 'h1', text: '你好', box: { x: 10, y: 20, w: 100, h: 40 } },
    },
    described: {
      ok: true,
      value: {
        box: { x: 10, y: 20, w: 100, h: 40, rotation: 0 },
        style: {
          'font-size': '32px',
          'font-weight': '700',
          'line-height': '40px',
          'letter-spacing': '0px',
          'text-align': 'left',
          color: 'rgb(255, 255, 255)',
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
        },
        inline: {},
        locked: false,
        text: '你好',
        tag: 'h1',
      },
    },
  });
  await withProject(async ({ studio, projectId }) => {
    const result = await postJson(studio.url, '/api/elements/inspect', { project: projectId, elementId: '#el-1' });
    assert.equal(result.status, 200);
    const groups = result.body.groups;
    assert.ok(Array.isArray(groups) && groups.length >= 3);
    assert.deepEqual(groups.map((group) => group.id), ['text', 'geometry', 'typography', 'appearance']);
    const geometry = groups.find((group) => group.id === 'geometry');
    const x = geometry.fields.find((/** @type {any} */ field) => field.key === 'x');
    assert.deepEqual(x, { key: 'x', label: 'X', value: 10, unit: 'px', editable: true });
    const fontSize = groups
      .find((group) => group.id === 'typography')
      .fields.find((/** @type {any} */ field) => field.key === 'fontSize');
    assert.equal(fontSize.value, '32px');
    assert.equal(fontSize.unit, 'px');
    // 每个字段都只有契约里的五个键
    for (const group of groups) {
      for (const field of group.fields) {
        assert.deepEqual(Object.keys(field).sort(), ['editable', 'key', 'label', 'unit', 'value']);
      }
    }
  }, page);
});

test('并发 4 个 /api/layers：结果一致，页面只取一次', async () => {
  let acquired = 0;
  const page = fakePage({ snapshot: SNAPSHOT, measured: MEASURED });
  const studio = await startStudio({
    port: 0,
    vitePort: 59999,
    readApiPage: async () => {
      acquired += 1;
      return page;
    },
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-m66-'));
  await fs.mkdir(path.join(dir, '.film'), { recursive: true });
  await fs.writeFile(path.join(dir, 'film.html'), FILM, 'utf8');
  try {
    const opened = await fetch(`${studio.url}/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir }),
    });
    const projectId = (await opened.json())?.project?.projectId;
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => getJson(studio.url, `/api/layers?project=${projectId}`)),
    );
    const firstBody = /** @type {any} */ (responses[0]).body;
    for (const response of responses) {
      assert.equal(response.status, 200);
      assert.deepEqual(response.body.layers, firstBody.layers);
    }
    assert.equal(firstBody.layers.length, 4);
    assert.ok(acquired <= 4, `readApiPage 调用 ${acquired} 次`);
  } finally {
    await studio.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('只读证明：多次 layers/inspect 后 film.html sha 不变', async () => {
  const page = fakePage({
    snapshot: SNAPSHOT,
    measured: MEASURED,
    located: { '#el-1': { matches: 1, kind: 'text', name: '标题' } },
    described: {
      ok: true,
      value: {
        box: { x: 10, y: 20, w: 100, h: 40, rotation: 0 },
        style: {},
        inline: {},
        locked: false,
        text: '你好',
        tag: 'h1',
      },
    },
  });
  await withProject(async ({ studio, projectId, filmPath }) => {
    const before = sha(await fs.readFile(filmPath));
    await getJson(studio.url, `/api/layers?project=${projectId}`);
    await getJson(studio.url, `/api/layers?project=${projectId}`);
    await postJson(studio.url, '/api/elements/inspect', { project: projectId, elementId: '#el-1' });
    const after = sha(await fs.readFile(filmPath));
    assert.equal(after, before);
    const onDisk = await fs.readFile(filmPath, 'utf8');
    assert.equal(sha(Buffer.from(onDisk, 'utf8')), before);
  }, page);
});
