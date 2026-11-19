/**
 * 场景取帧宿主（副线1 · WP04）
 *
 * 严格实现 contracts/frame.ts v1.0.0 的六步就绪算法：
 *   1. 先给页面上所有 <video> 装 seeked/loadeddata/rVFC 观察器（arm）
 *   2. filmHost.time(t) → await film.frame(t)
 *   3. await filmHost.settle(t)（暂停/推进 Web Animations 到 t）
 *   4. 谓词：!seeking && readyState>=2 且已呈现 → 立即完成，不无条件等 seeked
 *   5. 双 rAF（滤镜/3D 图层光栅化）
 *   6. 所有 seek 超时且画面全黑 → VIDEO_NOT_SHOWN
 *
 * 错误码只有 7 个：NO_FILM / READY_TIMEOUT / RESOURCE_FAILED / FRAME_THREW /
 * FRAME_TIMEOUT / VIDEO_NOT_SHOWN / CANCELLED。
 *
 * 受控时钟：performance.now / Date.now / Math.random / rAF 时间戳 / 定时器
 * 都由 filmHost.time(t) 统一驱动；定时器只在虚拟时间前进时触发（0ms 定时器
 * 走真实宏任务，避免 await new Promise(r => setTimeout(r, 0)) 死锁）。
 * 没有用「等待固定毫秒」做兜底：所有等待都基于状态谓词或显式预算。
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { injectMotionTime } from './motion-time.mjs';
import { acquireBrowserSlot, gateEnabled } from './browser-slot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../..');

/** 唯一允许的 7 个错误码（与 contracts/frame.ts 一致）。 */
export const SCENE_ERROR_CODES = Object.freeze([
  'NO_FILM',
  'READY_TIMEOUT',
  'RESOURCE_FAILED',
  'FRAME_THREW',
  'FRAME_TIMEOUT',
  'VIDEO_NOT_SHOWN',
  'CANCELLED'
]);

export const DEFAULT_TIMEOUTS = Object.freeze({
  readyMs: 5000,
  frameMs: 5000,
  videoSettleMs: 3000,
  noFilmGraceMs: 800,
  abortReleaseMs: 200
});

export class SceneFrameError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{t?: number, failedResources?: string[], cause?: unknown}} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'SceneFrameError';
    this.code = code;
    if (extra.t !== undefined) this.t = extra.t;
    if (extra.failedResources && extra.failedResources.length) this.failedResources = extra.failedResources;
    if (extra.cause !== undefined) this.cause = extra.cause;
  }
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isSceneFrameError(err) {
  const code = /** @type {any} */ (err)?.code;
  return err instanceof SceneFrameError || (!!code && SCENE_ERROR_CODES.includes(code));
}

/** @type {Record<string, string>} */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8'
};

/**
 * 只监听 127.0.0.1 的静态服务。不缓存、不列目录、防路径穿越。
 * 支持 HTTP Range（视频 seek 必需）；没有 Range 时 <video> 的 seekable 为 0，
 * seeked 会“成功”但 currentTime 不动，这是 S7 里必须避免的假就绪。
 * @param {string} root
 * @param {number} [port] 0 = 临时端口
 */
export function startStaticServer(root = REPO_ROOT, port = 0) {
  /** @type {Array<{path: string, status: number, ms: number}>} */
  const requests = [];
  const server = http.createServer((req, res) => {
    const started = Date.now();
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname);
    } catch {
      res.writeHead(400).end('bad url');
      return;
    }
    if (pathname === '/__health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      return;
    }
    const abs = path.resolve(root, '.' + pathname);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.stat(abs, (err, st) => {
      if (err || !st.isFile()) {
        requests.push({ path: pathname, status: 404, ms: Date.now() - started });
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
        return;
      }
      const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
      const baseHeaders = {
        'content-type': type,
        'cache-control': 'no-store',
        'accept-ranges': 'bytes'
      };
      const range = req.headers.range;
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
        if (m) {
          let start;
          let end;
          if (m[1] === '' && m[2] !== '') {
            // bytes=-N：最后 N 字节
            start = Math.max(0, st.size - Number(m[2]));
            end = st.size - 1;
          } else {
            start = Number(m[1]);
            end = m[2] === '' ? st.size - 1 : Math.min(Number(m[2]), st.size - 1);
          }
          if (!Number.isFinite(start) || start > end || start >= st.size) {
            res.writeHead(416, { ...baseHeaders, 'content-range': `bytes */${st.size}` }).end();
            return;
          }
          requests.push({ path: pathname, status: 206, ms: Date.now() - started });
          res.writeHead(206, {
            ...baseHeaders,
            'content-range': `bytes ${start}-${end}/${st.size}`,
            'content-length': end - start + 1
          });
          fs.createReadStream(abs, { start, end }).pipe(res);
          return;
        }
      }
      requests.push({ path: pathname, status: 200, ms: Date.now() - started });
      res.writeHead(200, { ...baseHeaders, 'content-length': st.size });
      fs.createReadStream(abs).pipe(res);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        server,
        port: actual,
        origin: `http://127.0.0.1:${actual}`,
        requests,
        close: () => new Promise((r) => server.close(() => r(undefined)))
      });
    });
  });
}

/**
 * 页内受控时钟 + filmHost.time/settle 注入。在导航前调用。
 * @param {import('playwright').Page} page
 * @param {{t0?: number, seed?: number}} [opts]
 */
async function installClock(page, { t0 = 0, seed = 0x2f6e2b1 } = {}) {
  await page.addInitScript(
    (/** @type {{t0: number, seed: number}} */ { t0, seed }) => {
      /** @type {any} */
      const W = window;
      const RealDate = Date;
      const realRAF = window.requestAnimationFrame.bind(window);
      const realCAF = window.cancelAnimationFrame.bind(window);
      const realSetTimeout = window.setTimeout.bind(window);
      const realClearTimeout = window.clearTimeout.bind(window);
      const realSetInterval = window.setInterval.bind(window);
      const realClearInterval = window.clearInterval.bind(window);

      let virtualNow = t0 * 1000; // 虚拟毫秒
      let seq = 1;
      /** @type {Map<number, any>} */
      const timers = new Map();

      /** @param {any} rec */
      function fire(rec) {
        try {
          rec.fn(...rec.args);
        } catch (err) {
          realSetTimeout(() => {
            throw err;
          }, 0);
        }
      }

      function flushDue() {
        let guard = 0;
        for (const rec of Array.from(timers.values())) {
          if (rec.done) continue;
          if (rec.due > virtualNow) continue;
          if (++guard > 1000) break;
          if (rec.kind === 'interval') {
            rec.due += Math.max(1, rec.ms);
            fire(rec);
          } else {
            rec.done = true;
            if (rec.handle) realClearTimeout(rec.handle);
            timers.delete(rec.id);
            fire(rec);
          }
        }
      }

      // 1) performance.now / Date
      Object.defineProperty(window.performance, 'now', {
        configurable: true,
        writable: true,
        value: () => virtualNow
      });

      /**
       * 无参构造读虚拟时钟；带参构造保持原生语义。
       * 用函数而非 Date 子类，避免 rest 参数在 TS 里的 tuple 约束。
       * @param {...any} args
       * @returns {Date}
       */
      function VirtualDate(...args) {
        return args.length === 0
          ? new RealDate(virtualNow)
          : /** @type {Date} */ (Reflect.construct(RealDate, args));
      }
      VirtualDate.prototype = RealDate.prototype;
      VirtualDate.now = () => virtualNow;
      VirtualDate.parse = RealDate.parse;
      VirtualDate.UTC = RealDate.UTC;
      W.Date = VirtualDate;

      // 2) Math.random 可复现
      let s = seed >>> 0;
      Math.random = () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
      };

      // 3) rAF 时间戳用虚拟时钟（仍由真实合成器调度，保证画面会前进）
      window.requestAnimationFrame = (cb) =>
        realRAF(() => cb(/** @type {number} */ (virtualNow)));
      window.cancelAnimationFrame = (id) => realCAF(id);

      // 4) 定时器：虚拟时间驱动；0ms 走真实宏任务，避免 next-tick 死锁
      /** @type {(...args: any[]) => any} */
      const patchedSetTimeout = (fn, delay = 0, ...args) => {
        const ms = Number(delay) || 0;
        const id = seq++;
        /** @type {any} */
        const rec = { id, kind: 'timeout', fn, args, ms, due: virtualNow + ms, done: false, handle: 0 };
        timers.set(id, rec);
        if (ms <= 0) {
          rec.handle = realSetTimeout(() => {
            if (rec.done) return;
            rec.done = true;
            timers.delete(id);
            fire(rec);
          }, 0);
        }
        return id;
      };
      W.setTimeout = patchedSetTimeout;
      W.clearTimeout = (/** @type {any} */ id) => {
        const rec = timers.get(Number(id));
        if (rec) {
          rec.done = true;
          if (rec.handle) realClearTimeout(rec.handle);
          timers.delete(rec.id);
        }
        realClearTimeout(Number(id));
      };
      /** @type {(...args: any[]) => any} */
      const patchedSetInterval = (fn, delay = 0, ...args) => {
        const ms = Math.max(1, Number(delay) || 0);
        const id = seq++;
        const rec = { id, kind: 'interval', fn, args, ms, due: virtualNow + ms, done: false, handle: 0 };
        timers.set(id, rec);
        return id;
      };
      W.setInterval = patchedSetInterval;
      W.clearInterval = (/** @type {any} */ id) => {
        const rec = timers.get(Number(id));
        if (rec) {
          rec.done = true;
          if (rec.handle) realClearInterval(rec.handle);
          timers.delete(rec.id);
        }
        realClearInterval(Number(id));
      };

      const clock = {
        now: () => virtualNow,
        /** @param {number} ms */
        set(ms) {
          virtualNow = Number(ms) || 0;
          flushDue();
        },
        pending: () => timers.size
      };

      const H = /** @type {any} */ (W.__filmHost = W.__filmHost || {});
      H.clock = clock;
      H.version = 1;
      H.time = (/** @type {number} */ t) => {
        clock.set(Number(t) * 1000);
        return virtualNow;
      };
      H.settle = async (/** @type {number} */ t) => {
        clock.set(Number(t) * 1000);
        // 暂停并把所有 Web Animations（含 CSS 动画）对齐到 t
        for (const anim of document.getAnimations()) {
          try {
            anim.pause();
            anim.currentTime = Number(t) * 1000;
          } catch {
            /* 忽略不可寻址的动画（如滚动驱动） */
          }
        }
        await new Promise((resolve) => realRAF(() => resolve(undefined)));
        return { animations: document.getAnimations().length, virtualNow };
      };
      H.state = () => ({
        t: virtualNow / 1000,
        animations: document.getAnimations().length,
        timers: timers.size,
        videos: Array.from(document.querySelectorAll('video')).length
      });
    },
    { t0, seed }
  );
}

/**
 * 一个打开的场景页。
 */
export class SceneHandle {
  /**
   * @param {SceneHost} host
   * @param {import('playwright').Page} page
   * @param {{rel: string, url: string, projectId?: string}} meta
   */
  constructor(host, page, meta) {
    this.host = host;
    this.page = page;
    this.rel = meta.rel;
    this.url = meta.url;
    this.projectId = meta.projectId || 'default';
    /** @type {{path: string, status?: number, error?: string}[]} */
    this.failures = [];
    /** @type {{message: string, stack?: string}[]} */
    this.pageErrors = [];
    this.closed = false;
    this.frameCount = 0;
    /** 每页第一帧需要一次完整「绘制-提交」预热，见 frame() 注释。 */
    this.warmed = false;
    /** @type {Array<() => void>} */
    this._disposers = [];
    this._bindDiagnostics();
  }

  _bindDiagnostics() {
    const page = this.page;
    /** @param {{path: string, status?: number, error?: string}} entry */
    const add = (entry) => {
      const key = entry.path + '|' + (entry.status ?? entry.error ?? '');
      if (!this.failures.some((f) => f.path + '|' + (f.status ?? f.error ?? '') === key)) {
        this.failures.push(entry);
      }
    };
    /** @param {string} url */
    const relOf = (url) => {
      try {
        const u = new URL(url);
        return u.pathname.replace(/^\//, '');
      } catch {
        return String(url);
      }
    };
    /** @param {import('playwright').Response} res */
    const onResponse = (res) => {
      if (res.status() >= 400) add({ path: relOf(res.url()), status: res.status() });
    };
    /** @param {import('playwright').Request} req */
    const onFailed = (req) => {
      const failure = req.failure();
      add({ path: relOf(req.url()), error: failure ? failure.errorText : 'requestfailed' });
    };
    /** @param {Error} err */
    const onPageError = (err) => {
      this.pageErrors.push({ message: err.message, stack: err.stack });
    };
    page.on('response', onResponse);
    page.on('requestfailed', onFailed);
    page.on('pageerror', onPageError);
    this._disposers.push(() => {
      page.off('response', onResponse);
      page.off('requestfailed', onFailed);
      page.off('pageerror', onPageError);
    });
  }

  /** 便于诊断：失败资源的相对路径列表。 */
  failedResources() {
    return this.failures.map((f) => f.path);
  }

  async dispose() {
    if (this.closed) return;
    this.closed = true;
    for (const fn of this._disposers) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    this._disposers.length = 0;
    this.host._forget(this);
    if (!this.page.isClosed()) {
      await this.page.close({ runBeforeUnload: false }).catch(() => {});
    }
  }
}

/**
 * @typedef {object} FrameOptions
 * @property {number} t
 * @property {number} [timeoutMs]
 * @property {AbortSignal} [signal]
 * @property {boolean} [keepOnTimeout]
 */

export class SceneHost {
  /**
   * @param {{root?: string, port?: number, headless?: boolean, viewport?: {width:number,height:number}, frameTimeoutMs?: number, readyTimeoutMs?: number, gate?: boolean, pool?: 'test'|'render'}} [opts]
   */
  constructor(opts = {}) {
    this.root = opts.root || REPO_ROOT;
    this.preferredPort = opts.port ?? 59372;
    this.headless = opts.headless !== false;
    this.viewport = opts.viewport || { width: 640, height: 360 };
    this.frameTimeoutMs = opts.frameTimeoutMs ?? DEFAULT_TIMEOUTS.frameMs;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_TIMEOUTS.readyMs;
    /** @type {SceneHandle[]} */
    this.handles = [];
    this.http = null;
    this.browser = null;
    this.context = null;
    this.origin = '';
    this.browserVersion = '';
    /**
     * 全局浏览器槽（ADR-R36-01）。`opts.gate` 显式指定；否则看 `OPENCUT_BROWSER_GATE`。
     * 关闭时 start/stop 的行为与以前逐字节一致 —— 产品运行不受影响。
     */
    this.gate = opts.gate ?? gateEnabled();
    /** @type {'test' | 'render'} 浏览器池：测试用 test（默认），导出/渲染用 render（互不挤占）。 */
    this.pool = opts.pool === 'render' ? 'render' : 'test';
    /** @type {null | {marker: string, release: () => Promise<void>}} */
    this.slot = null;
    /** @type {string} 本实例独有的命令行标记（回收时按它精确匹配）。 */
    this.ownerMarker = '';
  }

  async start() {
    // 先拿名额，再起浏览器：等槽的时候不应该已经占着端口和 Chromium。
    if (this.gate && !this.slot) {
      // 排队上限默认 15 分钟（OPENCUT_GATE_TIMEOUT_MS 可调）；单条线内部不会排队，
      // 只有多条线同时复核才会等 —— 那种情况本来就该等，而不是一起开浏览器。
      this.slot = await acquireBrowserSlot(`SceneHost:${path.basename(this.root)}`, { pool: this.pool });
    }
    try {
      // 端口被占时回落到临时端口，但仍只绑 127.0.0.1。
      this.http = await startStaticServer(this.root, this.preferredPort).catch(() =>
        startStaticServer(this.root, 0)
      );
      this.origin = this.http.origin;
      // 归属标记：**不管有没有开闸门都带**。测试跑完若浏览器没关干净，可以按这个
      // 唯一前缀精确回收（只杀自己起的，不碰用户日常浏览器）。
      const ownerTag = process.env.OPENCUT_OWNER_TAG || `pid${process.pid}`;
      this.ownerMarker = `--opencut-owner=${ownerTag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      this.browser = await chromium.launch({
        headless: this.headless,
        args: [
          '--force-color-profile=srgb',
          '--force-device-scale-factor=1',
          '--hide-scrollbars',
          '--disable-gpu-vsync',
          '--use-angle=swiftshader',
          '--enable-unsafe-swiftshader',
          '--font-render-hinting=none',
          '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding',
          '--disable-backgrounding-occluded-windows',
          // 唯一归属标记：回收只按它匹配，不按 Chrome 名字。
          this.ownerMarker,
          ...(this.slot ? [this.slot.marker] : [])
        ]
      });
      this.browserVersion = this.browser.version();
      this.context = await this.browser.newContext({
        viewport: this.viewport,
        deviceScaleFactor: 1,
        locale: 'zh-CN',
        timezoneId: 'UTC',
        colorScheme: 'light',
        reducedMotion: 'no-preference',
        ignoreHTTPSErrors: true
      });
      return this;
    } catch (err) {
      // 起不来也要把名额还回去，否则整条流水线会被一个失败的 Host 卡死。
      await this.stop().catch(() => {});
      throw err;
    }
  }

  /** @param {string} rel */
  urlFor(rel) {
    return this.origin + '/' + String(rel).replace(/^\/+/, '');
  }

  /**
   * @param {string} rel 相对仓库根，如 tests/fixtures/scenes/dom.html
   * @param {{projectId?: string, timeoutMs?: number}} [opts]
   * @returns {Promise<SceneHandle>}
   */
  async open(rel, opts = {}) {
    if (!this.context) throw new Error('SceneHost.start() 未调用');
    const page = await this.context.newPage();
    await installClock(page, { t0: 0 });
    const url = this.urlFor(rel);
    const handle = new SceneHandle(this, page, { rel, url, projectId: opts.projectId });
    this.handles.push(handle);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs ?? 15000 });
      // 等 load 事件以收集资源失败；失败不抛，交给 ready 判定。
      await page.waitForLoadState('load', { timeout: 3000 }).catch(() => {});
    } catch (err) {
      await handle.dispose();
      throw new SceneFrameError('RESOURCE_FAILED', `无法打开场景 ${rel}: ${/** @type {any} */ (err).message}`, {
        failedResources: [rel],
        cause: err
      });
    }
    return handle;
  }

  /** @param {SceneHandle} handle */
  _forget(handle) {
    const i = this.handles.indexOf(handle);
    if (i >= 0) this.handles.splice(i, 1);
  }

  /**
   * 页面是否声明了 window.film.frame。
   * @param {SceneHandle} handle
   */
  async hasFilm(handle) {
    return handle.page
      .evaluate(() => !!(window.film && typeof window.film.frame === 'function'))
      .catch(() => false);
  }

  /**
   * 等待 film.ready()。失败时按资源失败优先映射错误码。
   * @param {SceneHandle} handle
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [opts]
   */
  async ready(handle, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? this.readyTimeoutMs;
    if (handle.closed) throw new SceneFrameError('CANCELLED', '页面已释放', {});
    if (!(await this.hasFilm(handle))) {
      // 给内联脚本一点执行机会，但绝不等到 ready 预算耗尽。
      const appeared = await handle.page
        .waitForFunction(() => !!(window.film && typeof window.film.frame === 'function'), null, {
          timeout: Math.min(DEFAULT_TIMEOUTS.noFilmGraceMs, timeoutMs)
        })
        .then(() => true)
        .catch(() => false);
      if (!appeared) {
        await handle.dispose();
        throw new SceneFrameError('NO_FILM', `页面缺少 window.film.frame：${handle.rel}`, {
          failedResources: handle.failedResources()
        });
      }
    }

    const work = (async () => {
      await handle.page.evaluate(async () => {
        await window.film.ready();
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      });
    })();
    // 防止 race 抛出后 work 的 rejection 变成 unhandledRejection
    work.catch(() => {});

    try {
      await this._guard(work, {
        timeoutMs,
        signal: opts.signal,
        handle,
        code: 'READY_TIMEOUT',
        message: `film.ready() 超过 ${timeoutMs}ms：${handle.rel}`
      });
    } catch (/** @type {any} */ err) {
      const failures = handle.failedResources();
      if (failures.length && err.code !== 'CANCELLED') {
        throw new SceneFrameError(
          'RESOURCE_FAILED',
          `场景资源加载失败（${failures.length}）：${failures.join(', ')}`,
          { failedResources: failures, cause: err }
        );
      }
      if (err instanceof SceneFrameError) {
        if (err.code === 'READY_TIMEOUT' && handle.pageErrors.length) {
          err.message += `；页面异常：${handle.pageErrors[0]?.message ?? ''}`;
        }
        throw err;
      }
      throw new SceneFrameError('READY_TIMEOUT', `film.ready() 失败：${err.message}`, {
        failedResources: failures,
        cause: err
      });
    }
  }

  /**
   * 取 t 时刻的一帧。严格按 contracts/frame.ts 六步。
   * @param {SceneHandle} handle
   * @param {FrameOptions} opts
   */
  async frame(handle, opts) {
    const t = Number(opts.t);
    if (!Number.isFinite(t)) throw new SceneFrameError('FRAME_THREW', 't 必须是有限数值', { t });
    const timeoutMs = opts.timeoutMs ?? this.frameTimeoutMs;
    const signal = opts.signal;
    if (handle.closed) throw new SceneFrameError('CANCELLED', '页面已释放', { t });

    const work = (async () => {
      // 首帧预热：Chromium 对页面生命周期内第一次提交的 SVG/圆角图层会用另一条
      // 抗锯齿光栅路径（实测同 t 首帧与次帧在 21 个圆角像素上差 ≤13/255）。
      // 这不是时序问题（多等 rAF 无效），只有「再提交一次绘制」才稳定；因此每页
      // 第一帧完整跑一遍六步并丢弃结果，交付出去的第一帧即与后续同 t 逐像素一致。
      // 不是 sleep 兜底：预热本身就是一次真实取帧，预算与取消语义完全相同。
      if (!handle.warmed) {
        await this._frameSteps(handle, t);
        handle.warmed = true;
      }
      return await this._frameSteps(handle, t);
    })();
    work.catch(() => {});
    try {
      return await this._guard(work, {
        timeoutMs,
        signal,
        handle,
        code: 'FRAME_TIMEOUT',
        message: `film.frame(${t}) 超过 ${timeoutMs}ms 未完成：${handle.rel}`,
        t
      });
    } catch (/** @type {any} */ err) {
      if (err.code === 'FRAME_TIMEOUT' || err.code === 'CANCELLED') {
        // S4/S6：超时/取消都必须回收页面，不留僵尸。
        await handle.dispose();
      }
      throw err;
    }
  }

  /**
   * 旧写法对照（仅用于 S7 证据）：先 await film.frame(t)，再无条件等 seeked。
   * @param {SceneHandle} handle
   * @param {{t:number, waitMs?:number}} opts
   */
  async frameLegacy(handle, opts) {
    const t = Number(opts.t);
    const waitMs = opts.waitMs ?? 3000;
    const started = Date.now();
    await handle.page.evaluate((tt) => window.__filmHost.time(tt), t);
    await handle.page.evaluate((tt) => window.film.frame(tt), t);
    const afterFrame = Date.now();
    // 无条件等 seeked：如果事件已在 frame() 内发生过，这里永远等不到。
    const waited = handle.page
      .evaluate(
        () =>
          new Promise((resolve) => {
            const v = document.querySelector('video');
            if (!v) return resolve('no-video');
            const state = { seeking: v.seeking, readyState: v.readyState, currentTime: v.currentTime };
            v.addEventListener('seeked', () => resolve({ event: 'seeked', state }), { once: true });
            return 'armed';
          })
      )
      .catch((err) => ({ error: String(err && err.message) }));
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve('__legacy_timeout__'), waitMs);
    });
    const outcome = await Promise.race([waited, timeout]);
    clearTimeout(timer);
    const elapsed = Date.now() - started;
    const state = await handle.page
      .evaluate(() => {
        const v = document.querySelector('video');
        return v
          ? { seeking: v.seeking, readyState: v.readyState, currentTime: v.currentTime }
          : null;
      })
      .catch(() => null);
    return {
      mode: 'legacy',
      t,
      elapsedMs: elapsed,
      frameMs: afterFrame - started,
      outcome: outcome === '__legacy_timeout__' ? 'HUNG' : 'RESOLVED',
      soughtAfterFrame: typeof outcome === 'object' && outcome ? outcome.event || null : outcome,
      videoStateAtInstall: typeof outcome === 'object' && outcome ? outcome.state || null : null,
      videoStateNow: state
    };
  }

  /**
   * 六步实现。
   * @param {SceneHandle} handle
   * @param {number} t
   */
  async _frameSteps(handle, t) {
    const page = handle.page;
    if (page.isClosed()) throw new SceneFrameError('CANCELLED', '页面已关闭', { t });

    // 步骤 1：先装 video 观察器（在 frame(t) 改变 currentTime 之前）
    await this._armVideos(page);

    // 步骤 2：受控时钟 → film.frame(t)
    await page.evaluate((/** @type {number} */ tt) => window.__filmHost.time(tt), t);
    try {
      await page.evaluate((/** @type {number} */ tt) => window.film.frame(tt), t);
    } catch (err) {
      const e = /** @type {any} */ (err);
      const raw = String(e && e.message ? e.message : e);
      const firstLine = raw.split('\n')[0];
      throw new SceneFrameError('FRAME_THREW', `film.frame(${t}) 抛错：${firstLine}`, {
        t,
        cause: err
      });
    }

    // frame 期间新插入的 video 也要纳入观察（幂等）
    await this._armVideos(page);

    // 步骤 2.5：动效实例时间注入（S33）
    // 必须在 film.frame(t) 之后、settle(t) 之前：模板是「暂停 + 负延迟」，
    // 写 `--motion-t` 就等于把动画定格到本帧的相位；settle 之后的双 rAF 会把它提交出去。
    // 放在 frame 之前的话，场景自己的 frame(t) 可能重设覆盖，写进去的相位会被冲掉。
    let motion;
    try {
      motion = await injectMotionTime(page, t);
    } catch (err) {
      const e = /** @type {any} */ (err);
      const raw = String(e && e.message ? e.message : e);
      throw new SceneFrameError('FRAME_THREW', `动效时间注入失败（t=${t}）：${raw.split('\n')[0]}`, {
        t,
        cause: err
      });
    }

    // 步骤 3：settle(t)
    await page.evaluate((/** @type {number} */ tt) => window.__filmHost.settle(tt), t);

    // 步骤 4：谓词 —— 已就绪立即完成，绝不无条件等 seeked
    const probes = await this._waitVideoPredicate(page, handle, t);

    // 步骤 5：双 rAF
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined)));
        })
    );

    // 步骤 6：全部 seek 超时且画面全黑 → VIDEO_NOT_SHOWN
    if (probes.length && probes.every((/** @type {any} */ p) => p.required && !p.ok)) {
      const black = await this._looksBlack(page);
      if (black) {
        throw new SceneFrameError(
          'VIDEO_NOT_SHOWN',
          `video seek 超时且画面全黑：${handle.rel}`,
          { t }
        );
      }
    }

    const png = await page.screenshot({ type: 'png', timeout: 10000 });
    handle.frameCount += 1;
    return {
      t,
      png: new Uint8Array(png),
      width: this.viewport.width,
      height: this.viewport.height,
      cached: false,
      sha256: crypto.createHash('sha256').update(png).digest('hex'),
      videoProbes: probes,
      /** 本帧写到页面里的动效相位（S33）：{documents, roots, written, crossOrigin, entries} */
      motion
    };
  }

  /** @param {import('playwright').Page} page */
  async _armVideos(page) {
    return page.evaluate(() => {
      const H = window.__filmHost;
      const all = Array.from(document.querySelectorAll('video'));
      const probes = H.videoProbes || (H.videoProbes = []);
      let armed = 0;
      for (const v of all) {
        if (v.__filmProbe) continue;
        /** @type {any} */
        const rec = {
          el: v,
          baseTime: v.currentTime,
          seeked: false,
          loaded: false,
          presented: null,
          moved: false,
          rvfc: 0
        };
        v.__filmProbe = rec;
        probes.push(rec);
        v.addEventListener('seeked', () => {
          rec.seeked = true;
          rec.moved = true;
        });
        v.addEventListener('loadeddata', () => {
          rec.loaded = true;
        });
        if (typeof v.requestVideoFrameCallback === 'function') {
          rec.presented = false;
          const onFrame = () => {
            rec.presented = true;
            // 继续等下一次呈现，确保覆盖后续 seek
            rec.rvfc = v.requestVideoFrameCallback(onFrame);
          };
          rec.rvfc = v.requestVideoFrameCallback(onFrame);
        } else {
          rec.presented = null; // 无 rVFC：按合同视为已呈现
        }
        armed += 1;
      }
      return { total: all.length, armed, probes: probes.length };
    });
  }

  /**
   * 页面内谓词：!seeking && readyState>=2 且已呈现。
   * @param {import('playwright').Page} page
   */
  async _probeVideos(page) {
    return page.evaluate(() => {
      const H = window.__filmHost;
      const probes = H.videoProbes || [];
      return probes.map((/** @type {any} */ p) => {
        const v = p.el;
        const rects = v.getClientRects();
        const visible = rects.length > 0 && v.offsetWidth > 0 && v.offsetHeight > 0;
        const netEmpty = v.networkState === 0;
        const moved =
          p.moved || p.seeked || Math.abs(Number(v.currentTime) - Number(p.baseTime)) > 1e-6;
        const required = visible && !netEmpty && moved;
        const presentedOk = p.presented === null ? true : p.presented === true;
        const ok = !v.seeking && v.readyState >= 2 && presentedOk;
        return {
          required,
          ok,
          seeking: v.seeking,
          readyState: v.readyState,
          networkState: v.networkState,
          currentTime: v.currentTime,
          visible,
          presented: p.presented,
          moved
        };
      });
    });
  }

  /**
   * @param {import('playwright').Page} page
   * @param {SceneHandle} handle
   * @param {number} t
   */
  async _waitVideoPredicate(page, handle, t) {
    const deadline = Date.now() + DEFAULT_TIMEOUTS.videoSettleMs;
    for (;;) {
      const probes = await this._probeVideos(page);
      const pending = probes.filter((/** @type {any} */ p) => p.required && !p.ok);
      if (pending.length === 0) return probes;
      if (Date.now() > deadline) return probes;
      // 帧推进（真实 rAF，不受虚拟时钟影响）
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            const raf = window.requestAnimationFrame;
            raf(() => resolve(undefined));
          })
      );
    }
  }

  /** @param {import('playwright').Page} page */
  async _looksBlack(page) {
    return page
      .evaluate(() => {
        const v = document.querySelector('video');
        if (!v) return true;
        try {
          const c = document.createElement('canvas');
          c.width = 32;
          c.height = 18;
          const g = c.getContext('2d');
          if (!g) return false;
          g.drawImage(v, 0, 0, 32, 18);
          const data = g.getImageData(0, 0, 32, 18).data;
          let sum = 0;
          for (let i = 0; i < data.length; i += 4) sum += (data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0);
          return sum / (data.length / 4) / 3 / 255 < 0.02;
        } catch {
          return false; // 跨源污染：无法判定为黑
        }
      })
      .catch(() => false);
  }

  /**
   * 统一预算/取消护栏。超时或取消都立即释放页面。
   * @param {Promise<any>} work
   * @param {{timeoutMs:number, signal?:AbortSignal, handle:SceneHandle, code:string, message:string, t?:number}} o
   */
  async _guard(work, o) {
    const { timeoutMs, signal, handle, code, message } = o;
    /** @type {NodeJS.Timeout|undefined} */
    let timer;
    /** @type {(() => void)|undefined} */
    let onAbort;
    const timeoutP = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new SceneFrameError(code, message, { t: o.t }));
      }, timeoutMs);
    });

    let cancelP;
    if (signal) {
      cancelP = new Promise((_, reject) => {
        onAbort = () => {
          // 立刻开始释放，保证 200ms 内无残留 page。
          handle.dispose().catch(() => {});
          reject(new SceneFrameError('CANCELLED', `取帧被取消：${handle.rel}`, { t: o.t }));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
      cancelP.catch(() => {});
    }

    try {
      return await Promise.race([work, timeoutP, cancelP].filter(Boolean));
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * 取消某工程所有在途页面（contracts/frame.ts FrameHostApi.cancel）。
   * @param {string} projectId
   */
  cancel(projectId) {
    for (const h of Array.from(this.handles)) {
      if (h.projectId === projectId) h.dispose().catch(() => {});
    }
  }

  pages() {
    return this.context ? this.context.pages().filter((p) => !p.isClosed()) : [];
  }

  async stop() {
    try {
      for (const h of Array.from(this.handles)) {
        await h.dispose().catch(() => {});
      }
      if (this.context) await this.context.close().catch(() => {});
      if (this.browser) {
        // close() 正常几百毫秒；卡住时不能把名额一起卡死 —— 超时后仍释放，
        // 残留进程由下一个取槽者按 marker 精确收掉。
        await Promise.race([
          this.browser.close().catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 15_000)),
        ]);
      }
      if (this.http) await this.http.close().catch(() => {});
      this.context = null;
      this.browser = null;
      this.http = null;
    } finally {
      const slot = this.slot;
      this.slot = null;
      // 一定在浏览器关掉之后释放名额：下一个 Host 启动时不应看到上一轮的进程。
      if (slot) await slot.release().catch(() => {});
    }
  }
}

/**
 * 便捷函数：起宿主 → 打开 → ready → 取帧 → 关闭。
 * @param {string} rel
 * @param {number} t
 * @param {{host?: any, projectId?: string, timeoutMs?: number, signal?: AbortSignal}} [opts]
 */
export async function captureOnce(rel, t, opts = {}) {
  const host = await new SceneHost({ port: 0, ...opts.host }).start();
  const handle = await host.open(rel, opts);
  try {
    await host.ready(handle, opts);
    return await host.frame(handle, { ...opts, t });
  } finally {
    await host.stop();
  }
}

/** @param {Buffer|Uint8Array|string} buf */
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export { installClock };
export default SceneHost;
