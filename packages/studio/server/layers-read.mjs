/**
 * 只读图层 / 检查器 API 的元素域（M66 v1 → M69 v2 · WP12/WP14）。
 *
 * ## 为什么单独一层
 *
 * M66 的两个路由把「页面宿主 + 元素域 + 契约投影」全塞在 `studio-server.mjs` 里，
 * 于是元素域只有一个：**film.html 自己的 DOM**。真实工程里画面元素大多在 page 片段
 * （`<iframe src="page.html">`）里面，点 `#photo` 只能命中最外层的 `#page-main`——
 * 两套元素域不相交（S66 实测）。这里把「用哪个文档、id 怎么解析」收成一处：
 *
 * - `scope:"clip"`：film.html 文档，id 就是元素定位串（v1 语义，**一字不改**）；
 * - `scope:"page"`：page 片段自己的文档，id 是 `page.html` 里的定位串；
 *   对外统一 id 写成 `<clipId>::<elementId>`。
 *
 * ## 页面宿主
 *
 * 默认路径：懒启动一个 headless Chromium，按 **工程 + 目标 URL** 复用同一个 page
 * （同一工程里 film.html ↔ page.html 之间切换要重新导航，切回去会再导航一次；
 * 热态同目标 <200ms）。测试/宿主可用 `options.pageProvider` 注入现成 page——
 * 单测就是这么做的（不起浏览器）。
 *
 * 页面不可达一律抛 `PageUnreachable`（路由映射 502 + `reason`）；域错误抛
 * `ReadApiError`（400/404/409）。**不拿空列表冒充「没有层」**。
 *
 * ## 只读
 *
 * 这里没有任何写盘/写 DOM 的调用：`discover` / `describeLayer` / `buildInspector`
 * 都只读；`window.film.frame(t)` 只让页面画到某一帧（与预览同一条路径）。
 */

/**
 * @typedef {{ kind: 'film'|'page', key: string, url: string }} PageTarget
 */

/** 片段级元素域（v1）。 */
export const CLIP_SCOPE = 'clip';
/** 页面片段内部元素域（v2）。 */
export const PAGE_SCOPE = 'page';

export class PageUnreachable extends Error {
  /**
   * @param {string} reason 契约 v2 里列出的原因码
   * @param {string} [detail]
   */
  constructor(reason, detail) {
    super(detail === undefined ? reason : `${reason}: ${detail}`);
    this.reason = reason;
  }
}

export class ReadApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   */
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * 主轨第一个片段 id（`/api/layers` 与 inspect 的默认 clip）。
 * @param {any} doc
 * @returns {string}
 */
export function firstClipId(doc) {
  for (const track of doc?.tracks ?? []) {
    for (const clip of track?.clips ?? []) {
      if (clip?.id !== undefined) return String(clip.id);
    }
  }
  return '';
}

/**
 * 按 id 找片段（时间轴里的任何一个）。
 * @param {any} doc
 * @param {string} clipId
 * @returns {any|null}
 */
export function findClip(doc, clipId) {
  if (clipId === '') return null;
  for (const track of doc?.tracks ?? []) {
    for (const clip of track?.clips ?? []) {
      if (clip !== null && typeof clip === 'object' && String(clip.id) === clipId) return clip;
    }
  }
  return null;
}

/**
 * 找该元素的 override（只读）：优先指定 clip；否则取第一条 `at` 命中的层覆盖。
 *
 * page 片段的 overrides 挂在 **iframe 片段**上（`<iframe overrides='[{"at":"#footer"}]'>`），
 * 所以页面元素的 override 也要用页面片段的 clipId 来查——元素域换了，覆盖域没换。
 * @param {any} doc
 * @param {string} elementId
 * @param {string} clipId
 * @returns {any|null}
 */
export function findLayerOverride(doc, elementId, clipId) {
  for (const track of doc?.tracks ?? []) {
    for (const clip of track?.clips ?? []) {
      if (clipId !== '' && String(clip?.id) !== clipId) continue;
      const list = Array.isArray(clip?.overrides) ? clip.overrides : [];
      const hit = list.find((/** @type {any} */ entry) => entry !== null && typeof entry === 'object' && entry.at === elementId);
      if (hit !== undefined) return hit;
    }
  }
  return null;
}

/**
 * 解析统一 id：`<clipId>::<elementId>` 或裸 id（v1 兼容）。
 *
 * 用**第一个** `::` 切分：元素定位串（`#id` / `body > p:nth-of-type(2)`）里不会出现它，
 * 而片段 id 也不允许冒号（film-core 的 id 直接来自 HTML 属性，但时间轴 id 里带 `::`
 * 会让统一 id 不可逆，所以这里只认第一段）。
 *
 * @param {unknown} raw
 * @returns {{ok: true, scope: string, clipId: string, elementId: string, local: string}
 *   | {ok: false, status: number, code: string, message: string}}
 */
export function parseElementId(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') {
    return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'elementId 必须是非空字符串' };
  }
  const at = text.indexOf('::');
  if (at < 0) return { ok: true, scope: CLIP_SCOPE, clipId: '', elementId: text, local: text };
  const clipId = text.slice(0, at);
  const local = text.slice(at + 2);
  if (clipId === '' || local === '') {
    return {
      ok: false,
      status: 400,
      code: 'BAD_REQUEST',
      message: `统一 id 必须形如 <clipId>::<elementId>（收到 ${text}）`,
    };
  }
  return { ok: true, scope: PAGE_SCOPE, clipId, elementId: text, local };
}

/**
 * page 片段里某一帧对应的**页面自己的时间**（秒）。
 *
 * 与舞台运行时同一条公式（`sourceTimeOf`：`in + (t - at) * speed`）——面板读到的
 * 几何必须和导出取到的那一帧一致，不能各算一套。
 * @param {any} clip
 * @param {number} t
 * @returns {number}
 */
export function pageLocalTimeOf(clip, t) {
  const at = Number.isFinite(clip?.at) ? Number(clip.at) : 0;
  const time = Array.isArray(clip?.time) ? clip.time : null;
  const start = time !== null && Number.isFinite(Number(time[0])) ? Number(time[0]) : 0;
  const speed = Number.isFinite(clip?.speed) && Number(clip.speed) > 0 ? Number(clip.speed) : 1;
  const local = start + (t - at) * speed;
  return Number.isFinite(local) && local > 0 ? local : 0;
}

/**
 * page 片段的页面 URL（内容 origin 上的相对路径 → 绝对 URL）。
 *
 * `src` 来自解析器（`page.html`），可能带 `#t=...` 片段（那是时间轴语义，不是导航目标）。
 * 越界/协议不支持一律 `CLIP_SRC_INVALID`：不拿 `file://` 或 `..` 去导航。
 * @param {string|null} origin
 * @param {string} projectId
 * @param {unknown} src
 * @returns {{ok: true, url: string, external: boolean}|{ok: false, reason: string, message: string}}
 */
export function pageUrlFor(origin, projectId, src) {
  const raw = typeof src === 'string' ? src.trim() : '';
  if (raw === '') return { ok: false, reason: 'CLIP_SRC_INVALID', message: 'page 片段没有 src' };
  if (/^https?:\/\//i.test(raw)) {
    try {
      return { ok: true, url: new URL(raw).href, external: true };
    } catch {
      return { ok: false, reason: 'CLIP_SRC_INVALID', message: `page src 不是合法 URL：${raw}` };
    }
  }
  // file:// / data: / javascript: 一律拒绝：内容 origin 只服务工程目录里的文件。
  if (raw.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    return { ok: false, reason: 'CLIP_SRC_INVALID', message: `不支持的 page src 协议：${raw}` };
  }
  if (typeof origin !== 'string' || origin === '') {
    return { ok: false, reason: 'CONTENT_ORIGIN_OFF', message: '内容 origin 未启动' };
  }
  const pathOnly = (raw.split('#')[0] ?? '').split('?')[0] ?? '';
  const trimmed = pathOnly.replace(/^\.\//, '');
  const segments = trimmed.split('/');
  if (trimmed === '' || segments.some((segment) => segment === '' || segment === '.' || segment.startsWith('.'))) {
    return { ok: false, reason: 'CLIP_SRC_INVALID', message: `page src 越界：${raw}` };
  }
  const encoded = segments.map((segment) => encodeURIComponent(segment)).join('/');
  return { ok: true, url: `${origin}/p/${encodeURIComponent(projectId)}/${encoded}`, external: false };
}

/**
 * 页内量一次所有层的 tag/text/box（**必须自包含**：会被序列化进页面）。
 * 与 `discover` 的遍历解耦：discover 负责「有哪些层」，这里只补几何与文本。
 * @param {string[]} ats
 * @returns {{at: string, tag?: string, text?: string, box?: {x: number, y: number, w: number, h: number}, missing?: boolean}[]}
 */
export function measureLayersInPage(ats) {
  /** @type {any[]} */
  const out = [];
  for (const at of ats) {
    /** @type {Element|null} */
    let el = null;
    try {
      el = document.querySelector(at);
    } catch {
      el = null;
    }
    if (el === null) {
      out.push({ at, missing: true });
      continue;
    }
    const rect = el.getBoundingClientRect();
    let text = '';
    for (const node of el.childNodes) if (node.nodeType === 3) text += node.nodeValue || '';
    text = text.replace(/\s+/g, ' ').trim().slice(0, 120);
    out.push({
      at,
      tag: el.tagName.toLowerCase(),
      text,
      box: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
    });
  }
  return out;
}

/**
 * 图层模块只加载一次。
 *
 * `discover.ts` / `inspector.ts` / `describe.ts` 是**类型可擦除**的 TS（只有 interface/type），
 * Node 24（Electron 44）的类型剥离可直接 import；用 URL 动态导入是为了不让 tsc 把
 * `.ts` 扩展名当成需要 `allowImportingTsExtensions` 的静态依赖。
 * @returns {Promise<{discover: Function, buildInspector: Function, describeLayer: Function, locateByAt: Function}>}
 */
/** @type {Promise<any>|null} */
let layerModulesPromise = null;
export function loadLayerModules() {
  if (layerModulesPromise === null) {
    layerModulesPromise = Promise.all([
      import(new URL('../../layers/discover.ts', import.meta.url).href),
      import(new URL('../../layers/inspector.ts', import.meta.url).href),
      import(new URL('../../layers/describe.ts', import.meta.url).href),
      import(new URL('../../layers/dom-probe.mjs', import.meta.url).href),
    ])
      .then(([discoverMod, inspectorMod, describeMod, probeMod]) => ({
        discover: discoverMod.discover ?? discoverMod.default,
        buildInspector: inspectorMod.buildInspector,
        describeLayer: describeMod.describeLayer ?? describeMod.default,
        locateByAt: probeMod.locateByAt,
      }))
      .catch((error) => {
        layerModulesPromise = null;
        throw error;
      });
  }
  return layerModulesPromise;
}

/**
 * 元素域读取器（页面宿主 + 两个只读接口）。
 *
 * @param {{
 *   registry: { docOf: (projectId: string) => any },
 *   pageProvider?: ((projectId: string, target: PageTarget) => any) | null,
 *   contentOrigin?: () => string|null,
 *   logger?: (line: string) => void,
 * }} options
 */
export function createLayerReader(options) {
  const registry = options.registry;
  const pageProvider = typeof options.pageProvider === 'function' ? options.pageProvider : null;
  const originOf = typeof options.contentOrigin === 'function' ? options.contentOrigin : () => null;
  const log = typeof options.logger === 'function' ? options.logger : () => {};

  /** 单页宿主：一个浏览器、一个 context、一个 page（串行复用）。 */
  const host = {
    /** @type {any} */ browser: null,
    /** @type {any} */ context: null,
    /** @type {any} */ page: null,
    /** @type {string} */ key: '',
    /** @type {Promise<any>} */ chain: Promise.resolve(),
  };
  /** page → pageErrors（同一个 page 只挂一次监听）。 */
  const pageErrorsByPage = new WeakMap();

  /** @param {any} page */
  function pageErrorsOf(page) {
    let list = pageErrorsByPage.get(page);
    if (list === undefined) {
      list = [];
      pageErrorsByPage.set(page, list);
      if (typeof page.on === 'function') {
        page.on('pageerror', (/** @type {any} */ error) => {
          list.push(String(error?.message ?? error).slice(0, 300));
          if (list.length > 50) list.shift();
        });
      }
    }
    return list;
  }

  /**
   * 目标：film.html（v1 元素域）。
   * @param {string} projectId
   * @param {string} filmHash
   */
  function filmTarget(projectId, filmHash) {
    const key = `film:${filmHash}`;
    if (pageProvider !== null) return { ok: true, kind: 'film', key, url: '' };
    const origin = originOf();
    if (typeof origin !== 'string' || origin === '') {
      return { ok: false, reason: 'CONTENT_ORIGIN_OFF', message: '内容 origin 未启动' };
    }
    return { ok: true, kind: 'film', key, url: `${origin}/p/${encodeURIComponent(projectId)}/film.html` };
  }

  /**
   * 目标：page 片段自己的页面（v2 元素域）。
   * @param {string} projectId
   * @param {any} clip
   */
  function pageTarget(projectId, clip) {
    if (pageProvider !== null) {
      const key = `page:${String(clip?.id ?? '')}:${String(clip?.src ?? '')}`;
      return { ok: true, kind: 'page', key, url: '' };
    }
    const resolved = pageUrlFor(originOf(), projectId, clip?.src);
    if (resolved.ok !== true) return resolved;
    return { ok: true, kind: 'page', key: `page:${resolved.url}`, url: resolved.url };
  }

  /**
   * 默认页面来源：headless Chromium + 内容 origin。
   * 同一个 page 按 `key` 复用；key 变了就重新导航。
   * @param {string} key
   * @param {string} url
   */
  async function defaultPage(key, url) {
    if (host.browser === null) {
      /** @type {any} */
      let chromium;
      try {
        ({ chromium } = await import('playwright'));
      } catch {
        throw new PageUnreachable('PLAYWRIGHT_UNAVAILABLE');
      }
      try {
        host.browser = await chromium.launch({
          headless: true,
          args: [
            '--force-color-profile=srgb',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
            ...(process.env.OPENCUT_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
          ],
        });
      } catch (error) {
        throw new PageUnreachable('LAUNCH_FAILED', String(/** @type {Error} */ (error)?.message ?? error));
      }
      host.context = await host.browser.newContext({
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
        locale: 'zh-CN',
      });
      host.page = await host.context.newPage();
    }
    const page = host.page;
    if (host.key !== key) {
      pageErrorsOf(page).length = 0;
      /** @type {any} */
      let response;
      try {
        response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 5000 });
      } catch (error) {
        throw new PageUnreachable('NAV_FAILED', String(/** @type {Error} */ (error)?.message ?? error));
      }
      const status = typeof response?.status === 'function' ? response.status() : 0;
      if (status >= 400) throw new PageUnreachable(`HTTP_${status}`);
      await page.waitForFunction(() => document.body !== null, undefined, { timeout: 3000 }).catch(() => {});
      host.key = key;
    }
    return page;
  }

  /**
   * 取页面（串行）：并发 4 个请求不会各开一个浏览器。
   * @param {string} projectId
   * @param {any} target
   */
  function pageFor(projectId, target) {
    const key = `${projectId}|${target.key}`;
    const next = host.chain.then(async () => {
      if (pageProvider !== null) {
        const provided = await pageProvider(projectId, target);
        const page = provided?.page ?? provided;
        if (!page || typeof page.evaluate !== 'function') throw new PageUnreachable('NO_PAGE_PROVIDER');
        pageErrorsOf(page);
        if (typeof page.isClosed === 'function' && page.isClosed()) throw new PageUnreachable('PAGE_CLOSED');
        return page;
      }
      return defaultPage(key, target.url);
    });
    host.chain = next.catch(() => {});
    return next;
  }

  /**
   * 让页面画到这一帧（`window.film.frame(t)`，与舞台同一条路径）。
   * 页面没有 film / frame 也不报错（静态页面照样能读 DOM），只把状态记进响应。
   * @param {any} page
   * @param {any} clip
   * @param {number} t
   * @returns {Promise<{time: number, status: string}>}
   */
  async function seekPage(page, clip, t) {
    const time = pageLocalTimeOf(clip, t);
    /** @type {any} */
    let status = 'NO_FILM';
    try {
      status = await page.evaluate((/** @type {number} */ frameTime) => {
        const film = /** @type {any} */ (window).film;
        if (!film || typeof film.frame !== 'function') return 'NO_FILM';
        return Promise.race([
          Promise.resolve(film.frame(frameTime)).then(
            () => 'OK',
            () => 'THREW',
          ),
          new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 2000)),
        ]);
      }, time);
    } catch (error) {
      throw new PageUnreachable('FRAME_FAILED', String(/** @type {Error} */ (error)?.message ?? error));
    }
    return { time, status: typeof status === 'string' ? status : 'NO_FRAME' };
  }

  /**
   * 把一个目标上的层投影成 v1 形状（字段一字不改）。
   * @param {any} page
   * @param {any} modules
   * @param {string} clipId LayerRef.clipId
   * @param {number} t
   */
  async function projectLayers(page, modules, clipId, t) {
    const discovered = await modules.discover(page, clipId, t, {});
    if (discovered?.error) throw new PageUnreachable('DISCOVER_FAILED', discovered.error.message);
    const refs = Array.isArray(discovered.layers) ? discovered.layers : [];
    const ats = refs.map((/** @type {any} */ ref) => ref.at);
    /** @type {any[]} */
    const measured = ats.length === 0 ? [] : await page.evaluate(measureLayersInPage, ats);
    /** @type {Map<string, any>} */
    const byAt = new Map((measured ?? []).map((/** @type {any} */ item) => [item.at, item]));
    const pixel = new Set((discovered.pixelOnly ?? []).map((/** @type {any} */ item) => item.at));
    const foreign = new Set((discovered.unsupported ?? []).map((/** @type {any} */ item) => item.at));
    /** @type {any[]} */
    const layers = [];
    for (const ref of refs) {
      const hit = byAt.get(ref.at);
      if (hit === undefined || hit.missing === true) continue;
      /** @type {any} */
      const entry = {
        id: ref.at,
        tag: hit.tag || 'unknown',
        box: hit.box ?? { x: 0, y: 0, w: 0, h: 0 },
        // 能力提示：canvas=只能像素级处理；foreign=跨源 iframe（不注入）；其余为普通 DOM。
        source: pixel.has(ref.at) ? 'canvas' : foreign.has(ref.at) ? 'foreign' : 'dom',
      };
      if (typeof hit.text === 'string' && hit.text !== '') entry.text = hit.text;
      layers.push(entry);
    }
    return { layers, pageErrors: [...pageErrorsOf(page)] };
  }

  /**
   * `GET /api/layers`。
   *
   * `clip` 缺省 = v1（film.html 文档，响应只有 `layers/pageErrors`）；
   * `clip=<page 片段>` = 进页面文档，响应多 `scope/clipId/pageTime/frameStatus`；
   * `clip=<非 page 片段>` = 409 `CLIP_NOT_PAGE`（v1 里这个参数不影响遍历，去掉即可）。
   *
   * @param {{projectId: string, clipId?: string, t?: number}} input
   */
  async function layers(input) {
    const projectId = input.projectId;
    const current = registry.docOf(projectId);
    const doc = current?.doc ?? null;
    const clipId = typeof input.clipId === 'string' ? input.clipId : '';
    const t = Number.isFinite(input.t) ? Number(input.t) : 0;
    /** @type {any} */
    let clip = null;
    let scope = CLIP_SCOPE;
    /** @type {any} */
    let target;
    if (clipId !== '') {
      clip = findClip(doc, clipId);
      if (clip === null) throw new ReadApiError(404, 'ELEMENT_NOT_FOUND', `找不到片段：${clipId}`);
      if (clip.kind !== 'page') {
        throw new ReadApiError(409, 'CLIP_NOT_PAGE', `片段 ${clipId} 不是 page 片段（kind=${String(clip.kind)}）`);
      }
      scope = PAGE_SCOPE;
      target = pageTarget(projectId, clip);
    } else {
      target = filmTarget(projectId, String(current?.hash ?? ''));
    }
    if (target.ok !== true) throw new PageUnreachable(target.reason, target.message);
    const page = await pageFor(projectId, target);
    /** @type {{time: number, status: string}|null} */
    let seek = null;
    if (scope === PAGE_SCOPE) seek = await seekPage(page, clip, t);
    const modules = await loadLayerModules();
    const projected = await projectLayers(page, modules, scope === PAGE_SCOPE ? clipId : firstClipId(doc), t);
    if (scope !== PAGE_SCOPE) return projected;
    return {
      ...projected,
      scope: PAGE_SCOPE,
      clipId,
      pageTime: seek === null ? 0 : seek.time,
      frameStatus: seek === null ? 'NO_FILM' : seek.status,
    };
  }

  /**
   * `POST /api/elements/inspect`。
   *
   * - 裸 id：v1 语义（film.html 文档，`scope:"clip"`）；
   * - `<clipId>::<elementId>`：页面文档（`scope:"page"`），override 仍从该片段的
   *   `overrides` 里按 `elementId` 取。
   *
   * 返回体在 v1 的 `groups` 之外增加 `scope` / `elementId`（**原样回显请求值**）/ `clipId`。
   *
   * @param {{projectId: string, elementId: string, clipId?: string, t?: number}} input
   */
  async function inspect(input) {
    const projectId = input.projectId;
    const parsed = parseElementId(input.elementId);
    if (parsed.ok !== true) throw new ReadApiError(parsed.status, parsed.code, parsed.message);
    const current = registry.docOf(projectId);
    const doc = current?.doc ?? null;
    const t = Number.isFinite(input.t) ? Number(input.t) : 0;
    const scope = parsed.scope;
    let clipId = parsed.clipId;
    /** @type {any} */
    let clip = null;
    /** @type {any} */
    let target;
    if (scope === PAGE_SCOPE) {
      clip = findClip(doc, clipId);
      if (clip === null) throw new ReadApiError(404, 'ELEMENT_NOT_FOUND', `找不到片段：${clipId}`);
      if (clip.kind !== 'page') {
        throw new ReadApiError(409, 'CLIP_NOT_PAGE', `片段 ${clipId} 不是 page 片段（kind=${String(clip.kind)}）`);
      }
      target = pageTarget(projectId, clip);
    } else {
      clipId = typeof input.clipId === 'string' && input.clipId !== '' ? input.clipId : firstClipId(doc);
      target = filmTarget(projectId, String(current?.hash ?? ''));
    }
    if (target.ok !== true) throw new PageUnreachable(target.reason, target.message);
    const page = await pageFor(projectId, target);
    /** @type {{time: number, status: string}|null} */
    let seek = null;
    if (scope === PAGE_SCOPE) seek = await seekPage(page, clip, t);
    const modules = await loadLayerModules();
    const located = await page.evaluate(modules.locateByAt, parsed.local);
    if (!located || located.matches !== 1) {
      throw new ReadApiError(
        404,
        'ELEMENT_NOT_FOUND',
        `找不到元素：${parsed.local}（命中 ${String(located?.matches ?? 0)} 个）`,
      );
    }
    const ref = {
      clipId,
      at: parsed.local,
      kind: located.kind ?? 'unknown',
      name: located.name || parsed.local,
      selector: parsed.local,
      depth: 1,
    };
    const described = await modules.describeLayer(page, ref);
    if (described?.ok !== true) {
      const code = described?.error?.code;
      if (code === 'NOT_EDITABLE') {
        throw new ReadApiError(409, 'ELEMENT_NOT_EDITABLE', described?.error?.message ?? '该层只能像素级处理（canvas）');
      }
      if (code === 'LAYER_GONE') throw new ReadApiError(404, 'ELEMENT_NOT_FOUND', `找不到元素：${parsed.local}`);
      throw new PageUnreachable('DESCRIBE_FAILED', described?.error?.message);
    }
    const override = findLayerOverride(doc, parsed.local, clipId);
    const model = modules.buildInspector(ref, override, described.value, { boxEditable: true });
    const groups = (model?.groups ?? []).map((/** @type {any} */ group) => ({
      id: group.id,
      fields: (group.fields ?? []).map((/** @type {any} */ field) => ({
        key: field.id,
        label: field.label,
        value: field.current,
        unit: field.unit,
        editable: field.editable === true,
      })),
    }));
    return {
      groups,
      scope,
      elementId: parsed.elementId,
      clipId,
      ...(scope === PAGE_SCOPE ? { pageTime: seek === null ? 0 : seek.time, frameStatus: seek === null ? 'NO_FILM' : seek.status } : {}),
    };
  }

  /** 关掉只读 API 的浏览器（服务关闭时调用；重复调用安全）。 */
  async function close() {
    const browser = host.browser;
    host.browser = null;
    host.context = null;
    host.page = null;
    host.key = '';
    if (browser !== null) {
      await browser.close().catch((/** @type {any} */ error) => {
        log(`LAYER_PAGE_CLOSE_FAILED ${String(/** @type {Error} */ (error)?.message ?? error)}`);
      });
    }
  }

  return { layers, inspect, close };
}
