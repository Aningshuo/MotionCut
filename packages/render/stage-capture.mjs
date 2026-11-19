/**
 * 舞台取帧（P13）：把 film.html 里的网页片段**真正画出来**。
 *
 * 取帧源是主线的舞台运行时（`studio/server/content-origin.mjs`，本包**只读**）：
 * 起一个真 Studio + 内容 origin，打开工程，拿 `__stage__.html?studio=…&fit=none`，
 * 对每个时间点调 `window.film.frame(t)`，等它 resolve（内部已经等 media seeked +
 * 两帧 rAF + 页面 draw），再截图。摆放、透明度、层级、媒体 seek 全部由舞台自己做，
 * 这里**不重写**一套合成。
 *
 * 三个必须记住的坑：
 * 1. **场景的 `frame()` 可能是同步的**（官方样例就是，`frame(t){…}` 返回 undefined）。
 *    舞台内部的调用点是 `found.frame(local).then(...)`，同步返回会直接 TypeError。
 *    主线在修这个，但我们**不依赖**那个修复：拿到场景窗口后先把它包一层
 *    `Promise.resolve(...)`，让调用点永远看到 thenable。这一步只改内存里的函数，
 *    不动任何文件；被包过的窗口打 `__opencutFrameWrapped` 标记，不会重复包。
 * 2. 包之前的那次 boot 绘制（t=0）会因此报一条 `NO_FILM: …reading 'then'`。
 *    这是**已知的 boot 噪声**，不是场景真的缺 film：`bootErrors` 单独记下来，
 *    判定只看包完之后新增的 `errors`。
 * 3. 取帧失败一律是错误，不许跳过：缺 `window.film` → `NO_FILM`；场景抛错 →
 *    `FRAME_THREW`；超时 → `FRAME_TIMEOUT`。任何一条都让整次导出失败。
 *
 * 复用内容 origin 的舞台和素材读取边界。独立片段导出只替换取帧通道里的
 * 影片快照，仍然由原舞台渲染网页片段。
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { startStudio } from '../studio/server/studio-server.mjs';
import { startContentOrigin } from '../studio/server/content-origin.mjs';
import { compileKeyframes } from '../film-core/keyframes.mjs';
import { syncKeyframeFrame } from '../layers/apply-keyframes.mjs';
import { acquireBrowserSlot, gateEnabled } from '../scene-runtime/browser-slot.mjs';
import { planCaptureConcurrency } from './concurrency.mjs';
import { durationOfFrames, rateOfFps } from './fps.mjs';
import { frameTimeAt } from './timeline-range.mjs';

export const STAGE_CAPTURE_VERSION = '1.2.0';

/** @typedef {{ doc: any, text: string, hash: string }} FilmSnapshot */

/**
 * 本进程起过几个 Chromium（P51 证据用：`launchCount`，不是猜的）。
 *
 * 只统计**本模块**的 launch；测试要证明「一个作业只起一个浏览器」时，
 * 直接读这个计数器，而不是靠采样到的进程数去反推。
 */
let stageLaunches = 0;

/** 本进程累计 `chromium.launch()` 次数。 */
export function stageLaunchCount() {
  return stageLaunches;
}

/** 归零（验收脚本在同一进程里跑多个作业时用）。 */
export function resetStageLaunchCount() {
  stageLaunches = 0;
}

/**
 * 并行取帧的默认通道数。
 *
 * 实测（8 核 / 16GB / 1280×720 / 240 帧）：1 页 126.8s、4 页 40.9s、6 页 33.6s、8 页 29.8s。
 * 4→8 只有 1.37×，因为每帧 600ms 里约 90% 是页面内等视频 seek（content-origin 内部，
 * 本包不能改），多开页面只是在等不同的 seek，收益递减而内存线性涨。
 * 取 cores×0.75 封顶 6：留出余量给同机其它进程，也避免 4 核笔记本上开 8 页互相抢。
 * 用户显式给 --capture-concurrency 时以用户为准（1 = 退回串行）。
 */
function defaultConcurrency(/** @type {any} */ plan) {
  return planCaptureConcurrency(plan);
}

/**
 * 默认通道数规则**对外导出**（实现在 `concurrency.mjs`）：预估层必须和真实取帧用同一个数，
 * 否则「预估 3 通道、实际 6 通道」这种偏差会直接算到模型头上。
 */
export { planCaptureConcurrency };

const DEFAULT_FRAME_TIMEOUT_MS = 20000;
const DEFAULT_FILM_WAIT_MS = 5000;

/**
 * 取帧阶段的稳定错误码（CLI 会原样透出）。
 * @typedef {'NO_FILM' | 'FRAME_THREW' | 'FRAME_TIMEOUT' | 'NO_LAYER_RUNTIME' | 'STAGE_BOOT_FAILED' | 'PROJECT_NOT_OPEN' | 'CAPTURE_CANCELLED'} StageCaptureCode
 */

export class StageCaptureError extends Error {
  /**
   * @param {StageCaptureCode} code
   * @param {string} detail
   * @param {{ clipId?: string, t?: number, cause?: unknown }} [extra]
   */
  constructor(code, detail, extra = {}) {
    super(`${code}: ${detail}`);
    this.name = 'StageCaptureError';
    this.code = code;
    this.detail = detail;
    if (extra.clipId !== undefined) this.clipId = extra.clipId;
    if (extra.t !== undefined) this.t = extra.t;
    if (extra.cause !== undefined) this.cause = extra.cause;
  }
}

/**
 * 场景自己抛出来的错误没有 code：按 FRAME_THREW 归类。
 * 舞台的 `NO_FILM` / `NO_LAYER_RUNTIME` 原样保留。
 *
 * S83：`NO_LAYER_RUNTIME` 以前会被降级成 FRAME_THREW，导出侧只看到「帧抛了」，
 * 看不出是「覆盖运行时没装上」。它是可修复的配置问题，不是场景代码的锅，必须保留原码。
 * @param {any} raw
 * @param {string | null} [fallback]
 * @returns {StageCaptureCode}
 */
export function classifySceneError(raw, fallback = null) {
  const code = typeof raw?.code === 'string' ? raw.code : null;
  if (code === 'NO_FILM' || code === 'FRAME_THREW' || code === 'FRAME_TIMEOUT' || code === 'NO_LAYER_RUNTIME') return code;
  if (typeof fallback === 'string' && fallback !== '') return /** @type {StageCaptureCode} */ (fallback);
  return 'FRAME_THREW';
}

/**
 * Chromium 是**惰性加载**的：`playwright` 在 package.json 里是 devDependency，
 * 顶层静态 import 会让 `opencut project list` 这种跟浏览器毫无关系的命令在
 * 没装 devDeps 的环境里直接起不来。只有真要取帧时才 import。
 *
 * 打包契约（R30-129）：`scripts/package-desktop.mjs` 的 `APP_TREES` 必须带
 * `node_modules/playwright` + `playwright-core`，浏览器走包内
 * `Resources/app/playwright-browsers`（桌面壳设 `PLAYWRIGHT_BROWSERS_PATH`）。
 * 少任一项，**含 page 层的导出**就会走到下面的 catch，报
 * `STAGE_BOOT_FAILED: playwright is required … Cannot find package 'playwright' imported from
 * …/Resources/app/packages/render/stage-capture.mjs`。
 * 源码树里测不出来：`import('playwright')` 会沿目录往上走到仓库根的 node_modules；
 * 复现必须在仓库外（`scripts/m104-cs4-stage-boot.mjs` 就是这么做的）。
 * @returns {Promise<any>}
 */
async function loadChromium() {
  try {
    const playwright = await import('playwright');
    return playwright.chromium;
  } catch (err) {
    throw new StageCaptureError(
      'STAGE_BOOT_FAILED',
      `playwright is required to capture web page clips but could not be loaded: ${/** @type {any} */ (err)?.message ?? err}`,
      { cause: err },
    );
  }
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} what
 * @param {{ clipId?: string, t?: number }} [extra]
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, what, extra = {}) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new StageCaptureError('FRAME_TIMEOUT', `${what} did not finish within ${ms}ms`, extra));
    }, ms);
  });
  return /** @type {Promise<T>} */ (Promise.race([promise, timeout])).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * @param {any} doc
 * @returns {string[]} 网页片段的 id（顺序与 doc 一致）
 */
export function pageClipIds(doc) {
  /** @type {string[]} */
  const ids = [];
  for (const track of Array.isArray(doc?.tracks) ? doc.tracks : []) {
    for (const clip of Array.isArray(track?.clips) ? track.clips : []) {
      if ((clip.kind ?? 'video') === 'page') ids.push(String(clip.id));
    }
  }
  return ids;
}

/**
 * 起 Studio + 内容 origin + Chromium，打开工程并等舞台 ready。
 *
 * @param {{
 *   projectRoot: string,
 *   projectsRoot?: string,
 *   contentPort?: number,
 *   studioPort?: number,
 *   vitePort?: number,
 *   frameTimeoutMs?: number,
 *   filmWaitMs?: number,
 *   bootTimeoutMs?: number,
 *   headless?: boolean,
 *   extraArgs?: string[],
 *   logger?: (line: string) => void,
 *   size?: { w: number, h: number },
 *   stageFit?: 'none' | 'contain',
 *   alpha?: boolean,
 *   filmSnapshot?: FilmSnapshot,
 * }} opts `alpha`：截图的透明通道要保留（P31）。舞台页自己铺了底色，
 *   见 `applyAlphaBackground()` 的注释——底不是我们铺的，是 content origin 的 CSS。
 * @returns {Promise<{
 *   projectId: string,
 *   stage: { w: number, h: number },
 *   viewport: { w: number, h: number },
 *   duration: number,
 *   studioUrl: string,
 *   contentUrl: string,
 *   stageUrl: string,
 *   bootErrors: any[],
 *   pageErrors: string[],
 *   sceneClips: Array<{ id: string, state: string }>,
 *   captureAt: (t: number, timings?: { evalMs?: number, settleMs?: number, ipcMs?: number, shotMs?: number }) => Promise<Buffer>,
 *   measureRoundTrip: (rounds?: number) => Promise<{ medianMs: number, samples: number[] }>,
 *   openChannel: () => Promise<any>,
 *   setOmitScenes: (omit: boolean) => Promise<void>,
 *   probe: () => Promise<any>,
 *   close: () => Promise<void>,
 *   channelCount: number,
 *   omittedScenes: boolean,
 *   kf: { active: boolean, rules: number, plans: number, cssBytes: number, diagnostics: any[], entries: { at: string, hash: string }[] },
 * }>}
 */
export async function startStageCapture(opts) {
  const log = opts.logger ?? (() => {});
  const projectRoot = path.resolve(opts.projectRoot);
  const frameTimeoutMs = opts.frameTimeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS;
  const filmWaitMs = opts.filmWaitMs ?? DEFAULT_FILM_WAIT_MS;

  const snapshot = opts.filmSnapshot;
  const studio = snapshot ? null : await startStudio({
    port: opts.studioPort ?? 0,
    vitePort: opts.vitePort ?? 0,
    contentPort: opts.contentPort ?? 0,
    projectsRoot: opts.projectsRoot ?? path.dirname(projectRoot),
    logger: () => {},
  });
  const isolatedId = snapshot ? `clip-${crypto.randomBytes(8).toString('hex')}` : '';
  const isolatedOrigin = snapshot ? await startContentOrigin({
    port: opts.contentPort ?? 0,
    registry: {
      get: (id) => id === isolatedId ? { dir: projectRoot } : null,
      docOf: (id) => id === isolatedId ? snapshot : null,
    },
  }) : null;
  const contentOrigin = isolatedOrigin ?? studio?.contentOrigin;
  const closeOrigin = async () => {
    await isolatedOrigin?.close().catch(() => {});
    await studio?.close().catch(() => {});
  };
  if (!contentOrigin) {
    await closeOrigin();
    throw new StageCaptureError('STAGE_BOOT_FAILED', 'content origin did not start (contentPort missing?)');
  }
  const studioUrl = studio?.url ?? contentOrigin.origin;

  /** @type {import('playwright').Browser | null} */
  let browser = null;
  /** 全局浏览器槽（P51 / ADR-R36-01）。闸门关着时是 null，产品运行时行为不变。
   *  @type {Awaited<ReturnType<typeof acquireBrowserSlot>>} */
  let slot = null;
  try {
    let projectId = isolatedId;
    let docBody = snapshot;
    if (studio) {
      const opened = await fetch(`${studio.url}/api/projects/open`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dir: projectRoot }),
      });
      const body = await opened.json();
      if (body?.ok !== true || !body?.project?.projectId) {
        throw new StageCaptureError(
          'PROJECT_NOT_OPEN',
          `could not open ${projectRoot}: ${body?.code ?? opened.status} ${body?.message ?? ''}`.trim(),
        );
      }
      projectId = String(body.project.projectId);
      const docResponse = await fetch(`${studio.url}/api/projects/${encodeURIComponent(projectId)}/doc`);
      docBody = await docResponse.json();
    }
    if (!docBody?.doc) {
      throw new StageCaptureError('PROJECT_NOT_OPEN', `project ${projectId} has no doc`);
    }
    const stage = { w: Number(docBody.doc.stage.w) || 1280, h: Number(docBody.doc.stage.h) || 720 };
    const ids = pageClipIds(docBody.doc);

    /* ── E05-P2：关键帧（kf）在导出侧的接线 ────────────────────────────────
     *
     * 编译一次（纯函数，输入是同一份 doc），产出 `{css, plans}`：
     * - `css` 是 `@keyframes` + `[data-kf="<hash>"]` 规则；
     * - `plans` 是「哪个选择器该拿哪个 hash」。
     *
     * **没有 kf 的工程 `css === ''`**：后面所有 kf 分支都短路，取帧路径与改前
     * 逐字节相同（这是 A4 的硬边界）。
     *
     * 时钟不另造：舞台（`content-origin.mjs` 的 STAGE_RUNTIME）每帧已经写
     * `--motion-t`，口径是 `local = max(0, t − clip.at) * 1000`。kf 的 CSS 也按这个
     * 局部口径编译（`animation-delay: calc(-1 * var(--motion-t) * 1ms)`），所以
     * **这一层不需要再写一遍全局时间**——但要把局部毫秒补到 kf 元素自己身上：
     * 舞台只在「有 data-instance 就只写实例根」时才不覆盖到 kf 元素，见 applyKfTick。
     */
    const kfPlan = compileKeyframes(docBody.doc);
    const kfActive = kfPlan.css !== '';
    /** @type {{clipId: string, at: string, hash: string}[]} */
    const kfPlans = kfPlan.plans.map((plan) => ({ clipId: plan.clipId, at: plan.at, hash: plan.hash }));

    // 画幅（P24）：`size` 是**截图的像素尺寸**，`stageFit='contain'` 让舞台按 min() 等比缩放居中，
    // 于是 1080×1920 得到「上下留边」的竖屏画面；留边区是页面背景，这里统一刷成纯黑，
    // 免得用户拿到 #0b0b0c 的灰边。
    const viewport = {
      w: Math.max(2, Math.round(Number(opts.size?.w) || stage.w)),
      h: Math.max(2, Math.round(Number(opts.size?.h) || stage.h)),
    };
    const stageFit = opts.stageFit === 'contain' ? 'contain' : 'none';
    // 透明输出（P31）：两件事缺一不可——页面自己的底色要透明，截图要 omitBackground。
    // 只做后者会得到「白底 + alpha=255」；只做前者会得到「透明像素被合成到黑底上」。
    const alpha = opts.alpha === true;

    const stageRoot = `${contentOrigin.origin}/p/${encodeURIComponent(projectId)}`;
    const stageUrl = `${stageRoot}/__stage__.html?studio=${encodeURIComponent(studioUrl)}&fit=${stageFit}`;

    const args = [
      '--force-color-profile=srgb',
      '--hide-scrollbars',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      // 多通道取帧时只有一个 page 是"前台"，Chromium 会把其余的判成**被遮挡窗口**：
      // 它们不再产出**独立合成层**的帧。`opacity < 1` 的 iframe（场景半透明叠在实拍上）
      // 正好是独立合成层——于是截图上只剩实拍，场景凭空消失。
      // R15 实测：overlay8 默认 6 通道导出的成片里没有场景；加这两个开关后与预览一致。
      // 注意：`--disable-renderer-backgrounding` 只关"渲染进程降级"，不管窗口遮挡，两个都要。
      '--disable-backgrounding-occluded-windows',
      '--disable-features=CalculateNativeWinOcclusion',
      ...(process.env.OPENCUT_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
      // 逃生口：调参/排障时临时加 Chromium 参数，不改代码（空格分隔）
      ...(process.env.OPENCUT_STAGE_ARGS ? process.env.OPENCUT_STAGE_ARGS.split(' ').filter(Boolean) : []),
      ...(opts.extraArgs ?? []),
    ];
    /* ── 全局浏览器名额（P51）──────────────────────────────────────────────
       取帧的 Chromium 与测试用的 Chromium 抢的是同一台机器。以前只有测试侧有闸门
       （SceneHost），渲染侧没有，于是一条 4K 导出 + 一条测试能同时开两个浏览器。
       这里在 **launch 之前**取槽：拿不到就排队等（`acquireBrowserSlot` 内部 250ms
       轮询 + 超时抛 GATE_TIMEOUT），等到了才起浏览器。

       `slot.marker` 作为一条 Chromium 参数塞进 argv：父进程被 SIGKILL 时，下一次取槽
       靠它精确回收（`pgrep -f --opencut-gate-token=`），不按进程名批量杀。

       闸门默认关（`OPENCUT_BROWSER_GATE !== '1'`）→ slot 为 null，args 与原来逐字节相同，
       产品行为零漂移。 */
    slot = gateEnabled() ? await acquireBrowserSlot(`stage:${path.basename(projectRoot)}`) : null;

    const chromium = await loadChromium();
    const launched = /** @type {any} */ (
      await chromium.launch({
        headless: opts.headless !== false,
        args: [...args, ...(slot ? [slot.marker] : [])],
        // playwright 默认接管 SIGINT/SIGTERM/SIGHUP：收到就关浏览器再 `process.exit(130)`。
        // 那会把调用方的协作式中止（AbortSignal → 清理 → 非 0 退出）整条短路掉，
        // 取消就变成「清理到一半直接退出」。信号归调用方，这里不抢。
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      })
    );
    // 只数**成功起来的**浏览器：launch 抛错不该被算成"起过一个"
    stageLaunches += 1;
    browser = launched;
    const newStagePage = () =>
      launched.newPage({
        viewport: { width: viewport.w, height: viewport.h },
        deviceScaleFactor: 1,
      });

    /**
     * 把每个网页片段的 `film.frame` 包成「永远返回 Promise」。
     * 只碰内存里的函数；返回每个片段的现状，缺 film 的照实写 `no-film`。
     * 并行后**每个 page 都要包一次**——包的是各自文档里的那份函数。
     * @param {any} target
     * @param {string[]} clipIds
     */
    const patchScenes = (target, clipIds) =>
      target.evaluate((/** @type {string[]} */ wanted) => {
        const filmIframe = /** @type {any} */ (document.getElementById('film'));
        const filmDoc = filmIframe ? filmIframe.contentDocument : null;
        if (!filmDoc) return wanted.map((id) => ({ id, state: 'no-document' }));
        return wanted.map((id) => {
          const el = filmDoc.getElementById(id);
          const win = el ? /** @type {any} */ (el.contentWindow) : null;
          if (!win) return { id, state: 'no-window' };
          const film = win.film;
          if (!film || typeof film.frame !== 'function') return { id, state: 'no-film' };
          if (!win.__opencutFrameWrapped) {
            const original = film.frame;
            const tag = (/** @type {any} */ raw) => {
              const err = raw instanceof Error ? raw : new Error(String(raw));
              if (!(/** @type {any} */ (err).code)) /** @type {any} */ (err).code = 'FRAME_THREW';
              return err;
            };
            film.frame = function frame(/** @type {number} */ t) {
              let out;
              try {
                out = original.call(film, t);
              } catch (err) {
                throw tag(err);
              }
              return Promise.resolve(out).catch((/** @type {any} */ err) => {
                throw tag(err);
              });
            };
            win.__opencutFrameWrapped = true;
          }
          return { id, state: 'ok' };
        });
      }, clipIds);

    /**
     * 取某一时刻的整帧（网页 + 视频 + 摆位 + 淡入淡出都是舞台合成好的）。
     *
     * `timings` 是可选的出参：给一个空对象就把这一帧拆成
     * eval（= settle + IPC 往返）/ screenshot 两段分别计时。
     * 默认不传，行为与不开计时完全一致（只多一次 performance.now()）。
     *
     * @param {any} page
     * @returns {(t: number, timings?: { evalMs?: number, settleMs?: number, ipcMs?: number, shotMs?: number }) => Promise<Buffer>}
     */
    function makeCaptureAt(page) {
      /**
       * @param {number} t
       * @param {{ evalMs?: number, settleMs?: number, ipcMs?: number, shotMs?: number }} [timings]
       */
      return async function captureAt(t, timings) {
        const target = Number(t);
        if (!Number.isFinite(target)) throw new StageCaptureError('FRAME_THREW', `frame(t) needs a number, got ${t}`);
        const evalStart = performance.now();
        const outcome = await withTimeout(
          page.evaluate(async (/** @type {number} */ tt) => {
            const w = /** @type {any} */ (window);
            const settleStart = performance.now();
            try {
              await w.film.frame(tt);
              return { ok: true, code: null, message: '', settleMs: performance.now() - settleStart };
            } catch (err) {
              const anyErr = /** @type {any} */ (err);
              return {
                ok: false,
                code: anyErr && anyErr.code ? String(anyErr.code) : null,
                message: String((anyErr && anyErr.message) || err),
                settleMs: performance.now() - settleStart,
              };
            }
          }, target),
          frameTimeoutMs,
          `stage frame(${target})`,
          { t: target },
        );
        const evalEnd = performance.now();
        if (!outcome || outcome.ok !== true) {
          throw new StageCaptureError(
            classifySceneError({ code: outcome?.code }, 'FRAME_THREW'),
            `frame(${target}) failed: ${outcome?.message ?? 'unknown'}`,
            { t: target },
          );
        }
        const shotStart = performance.now();
        /* ── E05-P2：关键帧的每帧定位（仅当工程里真有 kf 时执行）────────────
         *
         * 顺序必须是「frame(t) 已 resolve → 写相位 → 等两帧 rAF → 截图」：
         * - 写在 frame 之前会被场景自己的 frame(t) 冲掉（与 motion-time 的注释同因）；
         * - 写完之后不等帧，截到的是上一帧的合成结果。
         *
         * 这里**不碰** `animation-play-state`：kf 的动画从头到尾是 `paused`，
         * 写 `--motion-t` 就等于定位。一旦改成 `running` 就变成墙钟推进，
         * 同一条时间轴截两次会不一样（那是本批要消灭的那种不确定）。
         *
         * `animations: 'disabled'` 不会把 kf 动画快进到末帧：舞台的
         * `freezePausedAnimations()` 已经把 paused 动画的 `playbackRate` 钉成 0，
         * Playwright 对 `playbackRate === 0` 的动画直接跳过。
         */
        if (kfActive) {
          await page.evaluate(syncKeyframeFrame, { t: target, css: kfPlan.css, plans: kfPlans });
          await page.evaluate(settleTwoFrames);
          /* 等一帧之后再钉：第一次写时动画可能刚被创建，`getAnimations()` 还是空的。 */
          await page.evaluate(freezeKeyframeAnimations);
        }
        // fit=none 时页面就是 stage 尺寸，clip 与整屏等价（保持老行为逐字节不变）；
        // 指定画幅时舞台被等比缩放并居中，**必须截整个视口**，否则会把缩放后的画面裁掉一块。
        const shot = await page.screenshot({
          ...(stageFit === 'none' ? { clip: { x: 0, y: 0, width: stage.w, height: stage.h } } : {}),
          animations: 'disabled',
          caret: 'hide',
          // 只有透明导出才开：默认路径的 PNG 字节必须与 R15 完全一致（A4）
          ...(alpha ? { omitBackground: true } : {}),
        });
        const shotEnd = performance.now();
        if (timings) {
          timings.evalMs = evalEnd - evalStart;
          timings.settleMs = Number(outcome?.settleMs) || 0;
          // eval 减去页面内部 settle，剩下的就是 CDP 往返 + 序列化
          timings.ipcMs = Math.max(0, timings.evalMs - timings.settleMs);
          timings.shotMs = shotEnd - shotStart;
        }
        return shot;
      };
    }

    /**
     * @param {any} page
     * @returns {Promise<{ duration: number, errors: any[], sceneFrames: number, frames: number, t: number, visible: string[], pages: any[] }>}
     */
    function probeOf(page) {
      return page.evaluate(() => {
        const w = /** @type {any} */ (window);
        return {
          duration: Number(w.__stageProbe.duration) || 0,
          // 全量错误原样返回；调用方按 bootErrors 截掉 boot 那一段再判定
          errors: JSON.parse(JSON.stringify(w.__stageProbe.errors)),
          sceneFrames: Number(w.__stageProbe.sceneFrames) || 0,
          // 舞台自己提交了多少帧（含 boot 那次）：帧数对上才说明没有偷偷掉帧
          frames: Number(w.__stageProbe.frames) || 0,
          // 当前时刻哪些片段是可见的：视频切点这类"同一时刻该谁出场"的问题只能靠它回答
          t: Number(w.__stageProbe.t) || 0,
          visible: Array.isArray(w.__stageProbe.visible) ? [...w.__stageProbe.visible] : [],
          pages: JSON.parse(JSON.stringify(w.__stageProbe.pages())),
        };
      });
    }

    /**
     * 空求值的往返基线：用来把「IPC 固定开销」和「settle 之外的真实工作」分开。
     * @param {any} page
     * @param {number} [rounds]
     */
    async function roundTripOf(page, rounds = 5) {
      /** @type {number[]} */
      const samples = [];
      for (let i = 0; i < rounds; i += 1) {
        const start = performance.now();
        await page.evaluate(() => 1);
        samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      return { medianMs: samples[Math.floor(samples.length / 2)] ?? 0, samples };
    }

    /**
     * @typedef {{
     *   page: any,
     *   bootErrors: any[],
     *   pageErrors: string[],
     *   sceneClips: Array<{ id: string, state: string }>,
     *   duration: number,
     *   captureAt: (t: number, timings?: any) => Promise<Buffer>,
     *   probe: () => Promise<any>,
     *   measureRoundTrip: (rounds?: number) => Promise<{ medianMs: number, samples: number[] }>,
     *   close: () => Promise<void>,
     * }} StageChannel
     */
    /** @type {StageChannel[]} */
    const channels = [];

    /**
     * 起一个"取帧通道"：一个 page + 它的探针/截图方法。
     * 并行取帧就是同一个浏览器里开多个通道——它们共享同一个 Studio / 内容 origin，
     * 不重复起服务，也不共享任何帧状态（每个 page 自己有一套 iframe 和 video）。
     * @param {any} page
     * @returns {Promise<StageChannel>}
     */
    async function bootChannel(page) {
      /** @type {string[]} */
      const pageErrors = [];
      page.on('pageerror', (/** @type {any} */ err) => pageErrors.push(String(err?.message ?? err).slice(0, 400)));

      if (snapshot) {
        // The read-only origin supplies the pinned projection and keyframes. Intercept
        // only the matching film iframe so scene/asset requests retain the origin's path fence.
        await page.route(`${stageRoot}/film.html`, (/** @type {import('playwright').Route} */ route) => route.fulfill({
          status: 200, contentType: 'text/html; charset=utf-8', body: snapshot.text,
          headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
        }));
      }
      await page.goto(stageUrl, { waitUntil: 'load', timeout: Math.max(frameTimeoutMs, 30000) });
      // 等比缩放（P24）时，舞台之外的留边区取页面背景；统一刷成纯黑，
      // 免得产物里出现 #0b0b0c 的灰边。fit=none 时不动（回归路径一个字节都不碰）。
      // 透明模式（P31）反过来：四层底色全部改成 transparent，把舞台页自己的
      // `#0b0b0c` / `#000` 拆掉，只留内容真的画了的部分。
      // 注意这是**运行时注入**，`content-origin.mjs` 一行没动（那是 studio 的领地）。
      if (alpha) {
        await page.addStyleTag({
          content: [
            'html, body { background: transparent !important; }',
            // `#stage-frame` 那圈 1px 描边是给人看的边框，透明导出里会变成一圈脏边
            '#stage-frame { background: transparent !important; box-shadow: none !important; }',
            '#film { background: transparent !important; }',
          ].join('\n'),
        });
      } else if (stageFit !== 'none') {
        await page.evaluate(() => {
          document.documentElement.style.background = '#000';
          if (document.body) document.body.style.background = '#000';
        });
      }
      try {
        await page.waitForFunction(
          () => {
            const w = /** @type {any} */ (window);
            return Boolean(w.__stageProbe && w.__stageProbe.ready === true);
          },
          undefined,
          { timeout: Math.max(frameTimeoutMs, 30000) },
        );
      } catch (err) {
        const observed = await page
          .evaluate(() => {
            const w = /** @type {any} */ (window);
            return {
              errors: w.__stageProbe ? w.__stageProbe.errors.slice(0, 4) : [],
              ready: w.__stageProbe ? w.__stageProbe.ready : null,
            };
          })
          .catch(() => ({ errors: /** @type {any[]} */ ([]), ready: null }));
        const first = observed.errors[0];
        throw new StageCaptureError(
          first?.code ? classifySceneError(first) : 'STAGE_BOOT_FAILED',
          `stage did not become ready: ${first?.message ?? (observed.ready === false ? 'boot failed' : 'timeout')}`,
          { cause: err },
        );
      }

      const info = await page.evaluate(() => {
        const w = /** @type {any} */ (window);
        return {
          duration: Number(w.__stageProbe.duration) || 0,
          errors: JSON.parse(JSON.stringify(w.__stageProbe.errors)),
        };
      });
      // boot 那次绘制发生在包 frame() 之前：同步 frame 的场景会在这里留一条假 NO_FILM。
      // 每个通道各记各的，聚合时按总数切片。
      const bootErrors = info.errors;

      /** @type {Array<{ id: string, state: string }>} */
      let sceneClips = await patchScenes(page, ids);
      if (sceneClips.some((entry) => entry.state !== 'ok') && ids.length > 0) {
        // 模块脚本可能还没跑完（window.film 后到）：给一小段时间再包一次。
        const deadline = Date.now() + filmWaitMs;
        while (Date.now() < deadline && sceneClips.some((entry) => entry.state === 'no-film')) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          sceneClips = await patchScenes(page, ids);
        }
      }

      /** @type {StageChannel} */
      const channel = {
        page,
        bootErrors,
        pageErrors,
        sceneClips,
        duration: info.duration,
        captureAt: makeCaptureAt(page),
        probe: () => probeOf(page),
        measureRoundTrip: (rounds) => roundTripOf(page, rounds ?? 5),
        close: () => page.close().catch(() => {}),
      };
      channels.push(channel);
      return channel;
    }

    const primary = await bootChannel(await newStagePage());
    log(`STAGE_READY ${stage.w}x${stage.h} scenes=${primary.sceneClips.map((s) => `${s.id}:${s.state}`).join(',') || '-'}`);

    /**
     * 再开一个通道（并行取帧用）。默认一个都不多开：串行路径与 R9 完全一致。
     */
    const openChannel = async () => bootChannel(await newStagePage());

    /** @type {{ omitted: boolean }} */
    const uiState = { omitted: false };

    /**
     * 对照用：把网页片段的 iframe 在**合成后**隐藏（`!important` 压过舞台写的 inline）。
     * 只用于证据里的 A/B 对照，不参与交付；默认不开。并行时每个通道都要注入。
     * @param {boolean} omit
     */
    async function setOmitScenes(omit) {
      for (const channel of channels) {
        await channel.page.evaluate((/** @type {boolean} */ hide) => {
          // 必须注入到 film.html 文档里：CSS 不跨 iframe，写在舞台文档只会把 #film 自己也藏了
          const filmIframe = /** @type {any} */ (document.getElementById('film'));
          const filmDoc = filmIframe ? filmIframe.contentDocument : null;
          if (!filmDoc || !filmDoc.head) return;
          const id = '__opencut_omit_scenes';
          const existing = filmDoc.getElementById(id);
          if (!hide) {
            if (existing) existing.remove();
            return;
          }
          if (existing) return;
          const style = filmDoc.createElement('style');
          style.id = id;
          // `!important` 才能压过舞台每帧写的 inline visibility
          style.textContent = 'iframe{visibility:hidden !important}';
          filmDoc.head.appendChild(style);
        }, omit === true);
      }
      uiState.omitted = omit === true;
    }

    /**
     * 聚合所有通道的探针。
     * `errors` 按通道顺序拼起来；`bootErrors` 也是按同样顺序拼的，所以
     * `errors.slice(bootErrors.length)` 仍然只留下"包完之后"的真实错误。
     */
    async function probeAll() {
      const parts = await Promise.all(channels.map((channel) => channel.probe()));
      /** @type {Map<string, any>} */
      const merged = new Map();
      for (const part of parts) {
        for (const row of part.pages) {
          const prev = merged.get(row.id);
          if (prev) prev.sceneFrames += row.sceneFrames;
          else merged.set(row.id, { ...row });
        }
      }
      const last = parts[parts.length - 1];
      return {
        duration: parts[0]?.duration ?? 0,
        errors: parts.flatMap((part) => part.errors),
        sceneFrames: parts.reduce((acc, part) => acc + part.sceneFrames, 0),
        frames: parts.reduce((acc, part) => acc + part.frames, 0),
        t: last?.t ?? 0,
        visible: last?.visible ?? [],
        pages: [...merged.values()],
        channels: parts.length,
      };
    }

    const close = async () => {
      try {
        await Promise.all(channels.map((channel) => channel.close()));
        channels.length = 0;
        await browser?.close().catch(() => {});
        browser = null;
        await closeOrigin();
      } finally {
        /* 释放点必须在 `browser.close()` **之后**（P51 §3.1）：先还名额再关浏览器，
           下一个持有者会在旧 Chromium 还没退干净时启动，等于又开了一个。 */
        await slot?.release().catch(() => {});
        slot = null;
      }
    };

    return {
      projectId,
      stage,
      // 视口尺寸（= 截图像素尺寸）。`fit=contain` 时它比 stage 大/小；`fit=none` 时两者相等。
      // 静帧导出要靠它证明「预览与成片在同一个几何下」（P29-A4）。
      viewport,
      duration: primary.duration,
      studioUrl,
      contentUrl: contentOrigin.origin,
      stageUrl,
      // 通道会随并行增加：boot 噪声必须按"当前所有通道"算，不能用快照
      get bootErrors() {
        return channels.flatMap((channel) => channel.bootErrors);
      },
      get pageErrors() {
        return channels.flatMap((channel) => channel.pageErrors);
      },
      get sceneClips() {
        return primary.sceneClips;
      },
      captureAt: primary.captureAt,
      measureRoundTrip: primary.measureRoundTrip,
      openChannel,
      setOmitScenes,
      probe: probeAll,
      /* E05-P2：kf 编译结果的自省（验收与排障读这里，别猜）。 */
      kf: {
        active: kfActive,
        rules: kfPlan.stats.rules,
        plans: kfPlans.length,
        cssBytes: kfPlan.css.length,
        diagnostics: kfPlan.diagnostics,
        entries: kfPlans,
      },
      close,
      get channelCount() {
        return channels.length;
      },
      get omittedScenes() {
        return uiState.omitted;
      },
    };
  } catch (err) {
    await browser?.close().catch(() => {});
    await closeOrigin();
    // 早退/异常（PROJECT_NOT_OPEN / STAGE_BOOT_FAILED / 起浏览器失败）也必须还名额，
    // 否则一次失败的导出会把整台机器的测试全堵在队列里。
    await slot?.release().catch(() => {});
    slot = null;
    throw err;
  }
}

/* `syncKeyframeFrame` 从 R15 起住在 `packages/layers/apply-keyframes.mjs`：预览的舞台运行时
 * 要把同一份源码 `toString()` 进去，所以它不能再只属于导出侧。这里保留 re-export，
 * 老调用点（`page.evaluate(syncKeyframeFrame, ...)`、副线2 的 `uir-r24-kfsem.mjs`）不变。 */
export { syncKeyframeFrame };

/**
 * 页内：等两帧 rAF，让刚写进去的相位真的被合成出去。
 *
 * 用**两帧**不是一帧：`--motion-t` 改了之后第 1 个 rAF 才提交样式、第 2 个 rAF
 * 才是"画好了"的那一帧。仓库里所有 settle 都是这个口径（`SceneHost._frameSteps`
 * 步骤 5、`content-origin` 的 `frames(2)`），这里不发明第三套。
 */
export function settleTwoFrames() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined)));
  });
}

/**
 * 页内：把 `[data-kf]` 元素上「已暂停」的动画的 `playbackRate` 钉成 0。
 *
 * ## 为什么非要再来一次（P2 实测踩到的）
 *
 * 舞台自己有一手同样的冻结（`content-origin.mjs` 的 `freezePausedAnimations`），
 * 但它在 `film.frame(t)` 内部执行 —— 那时 `data-kf` 还没打上（kf 的落位是本批在
 * 取帧侧新加的），`getAnimations()` 返回空，于是**一个都没冻住**。
 *
 * 之后 CSS 规则让动画被创建、`data-kf` 也打上了，而截图时 Playwright 的
 * `animations: 'disabled'` 会把「有限动画」直接 `finish()` 到末帧：
 * 实测 `currentTime = endTime`、`progress = 1`、`opacity` 永远是末帧值 ——
 * 30 帧截图全一样，而且不是"没接上时钟"那种一样，是"每帧都被按到底"。
 *
 * Playwright 那段逻辑的第一步是「`playbackRate === 0` 就跳过」，所以把 rate 钉成 0
 * 即可。kf 的动画本来就地 `paused`（相位只由 `animation-delay` 决定），
 * 钉 rate **不改变任何一帧的画面**。
 *
 * **必须自包含**（会被 Playwright 序列化）。
 *
 * @returns {{frozen: number, documents: number}}
 */
export function freezeKeyframeAnimations() {
  /** @type {Document[]} */
  const seen = [];
  let frozen = 0;

  /** @param {Document} doc */
  function visit(doc) {
    if (!doc || seen.indexOf(doc) >= 0) return;
    seen.push(doc);
    const els = doc.querySelectorAll('[data-kf]');
    for (let i = 0; i < els.length; i += 1) {
      const el = /** @type {Element} */ (els[i]);
      /** @type {Animation[]} */
      let list = [];
      try {
        list = el.getAnimations ? el.getAnimations() : [];
      } catch (error) {
        list = [];
      }
      for (let a = 0; a < list.length; a += 1) {
        const animation = /** @type {Animation} */ (list[a]);
        try {
          if (animation.playState === 'paused' && animation.playbackRate !== 0) {
            animation.playbackRate = 0;
            frozen += 1;
          }
        } catch (error) {
          /* 冻结失败不打断取帧 */
        }
      }
    }
    const frames = doc.querySelectorAll('iframe,frame');
    for (let i = 0; i < frames.length; i += 1) {
      /** @type {Document|null} */
      let child = null;
      try {
        child = /** @type {HTMLIFrameElement} */ (frames[i]).contentDocument;
      } catch (error) {
        child = null;
      }
      if (child) visit(child);
    }
  }

  visit(document);
  return { frozen, documents: seen.length };
}

/**
 * 按计划把整段画面抓成 PNG 序列（`frame-%06d.png`）。
 *
 * 帧 i 对应**绝对影片时间**：单段是 `range[0] + i/fps`（R21 语义，逐位不变），
 * 多段（P36）由 `plan.segments` 定位到段，再取段内偏移（`timeline-range.mjs`）。
 * 舞台只认整片时间，计划里的 `at` 是相对成片的，转换只在这一处做。
 *
 * @param {{
 *   plan: any,
 *   projectRoot: string,
 *   framesDir: string,
 *   contentPort?: number,
 *   projectsRoot?: string,
 *   omitScenes?: boolean,
 *   frameTimeoutMs?: number,
 *   filmWaitMs?: number,
 *   signal?: AbortSignal,
 *   concurrency?: number,
 *   shard?: 'contiguous' | 'round-robin',
 *   profile?: boolean,
 *   size?: { w: number, h: number },
 *   stageFit?: 'none' | 'contain',
 *   alpha?: boolean,
 *   filmSnapshot?: FilmSnapshot,
 *   onFrame?: (info: { index: number, t: number, sha256: string, bytes: number }) => void,
 *   logger?: (line: string) => void,
 * }} opts
 * @returns {Promise<{ dir: string, pattern: string, frames: number, stage: { w: number, h: number }, projectId: string, range: [number, number], fps: number, concurrency: number, shard: string, sha256: string[], bootErrors: any[], pageErrors: string[], sceneClips: any[], profile?: any, capture: any }>}
 */
export async function captureFilmFrames(opts) {
  const { plan, framesDir } = opts;
  /* P42：帧位置一律走有理数。整数帧率下 `durationOfFrames` 就是 `index/30`，
     与 R21 的 `range[0] + index/fps` 逐位相同。 */
  const rate = rateOfFps(plan.fpsRational ?? plan.fps ?? 30);
  const fps = rate.value;
  const frames = Number(plan.frames);
  const range = /** @type {[number, number]} */ (plan.range ?? [0, plan.outputDuration ?? plan.duration]);
  if (!Number.isFinite(frames) || frames <= 0) {
    throw new StageCaptureError('STAGE_BOOT_FAILED', `plan has no frames (${plan.frames})`);
  }

  // 并行度：显式给就照办，不给用默认；再按帧数收敛，别为 6 帧开 4 个通道
  const concurrency = clampConcurrency(opts.concurrency, defaultConcurrency(plan), frames);

  const session = await startStageCapture({
    projectRoot: opts.projectRoot,
    ...(opts.contentPort !== undefined ? { contentPort: opts.contentPort } : {}),
    ...(opts.projectsRoot ? { projectsRoot: opts.projectsRoot } : {}),
    ...(opts.frameTimeoutMs !== undefined ? { frameTimeoutMs: opts.frameTimeoutMs } : {}),
    ...(opts.filmWaitMs !== undefined ? { filmWaitMs: opts.filmWaitMs } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(opts.size ? { size: opts.size } : {}),
    ...(opts.stageFit ? { stageFit: opts.stageFit } : {}),
    ...(opts.alpha === true ? { alpha: true } : {}),
    ...(opts.filmSnapshot ? { filmSnapshot: opts.filmSnapshot } : {}),
  });

  await fs.mkdir(framesDir, { recursive: true });
  /** @type {string[]} */
  const hashes = new Array(frames);
  const profileOn = opts.profile === true;
  /** @type {any[]} */
  const frameProfile = new Array(frames);
  let roundTrip = null;
  /** 任何一个通道失败就掐掉其余通道；否则它们会继续跑完剩下的帧白烧 CPU */
  const stop = new AbortController();

  try {
    /**
     * 通道 0 就是 startStageCapture 建的那个 page；其余按需开。
     * 每帧都是 t 的纯函数，所以"哪个通道算哪一帧"只影响速度，不影响结果：
     * 文件名按 index 写死，合并顺序由 index 决定，不靠完成顺序。
     * @type {Array<{ captureAt: (t: number, timings?: any) => Promise<Buffer> }>}
     */
    const workers = [{ captureAt: session.captureAt }];
    if (concurrency > 1) {
      if (opts.signal?.aborted) throw new StageCaptureError('CAPTURE_CANCELLED', 'frame capture cancelled');
      // 通道**并行**启动：串行起 5 个 page 光 boot 就要 5~6s，抵掉小工程的全部收益
      const extras = await Promise.all(
        Array.from({ length: concurrency - 1 }, () => session.openChannel()),
      );
      for (const channel of extras) workers.push({ captureAt: channel.captureAt });
    }
    if (profileOn) roundTrip = await session.measureRoundTrip(7);
    if (opts.omitScenes === true) await session.setOmitScenes(true);

    /**
     * 取一帧并落盘。
     * @param {number} index
     * @param {(t: number, timings?: any) => Promise<Buffer>} captureAt
     */
    const captureOne = async (index, captureAt) => {
      // 多段拼接：帧号先落段、再换算成原片时间（单段时与 range[0] + i/fps 逐位相同）
      const t = Array.isArray(plan.segments) && plan.segments.length > 0
        ? frameTimeAt(plan.segments, rate, index)
        : Number((Number(range[0]) + durationOfFrames(rate, index)).toFixed(6));
      /** @type {any} */
      const timings = {};
      const png = await captureAt(t, profileOn ? timings : undefined);
      const file = path.join(framesDir, `frame-${String(index).padStart(6, '0')}.png`);
      const writeStart = performance.now();
      await fs.writeFile(file, png);
      const writeMs = performance.now() - writeStart;
      const hashStart = performance.now();
      const sha = crypto.createHash('sha256').update(png).digest('hex');
      const hashMs = performance.now() - hashStart;
      hashes[index] = sha;
      if (profileOn) {
        frameProfile[index] = {
          index,
          t,
          channel: shard === 'round-robin' ? index % workers.length : Math.min(workers.length - 1, Math.floor((index * workers.length) / frames)),
          bytes: png.length,
          evalMs: round(timings.evalMs),
          settleMs: round(timings.settleMs),
          ipcMs: round(timings.ipcMs),
          shotMs: round(timings.shotMs),
          writeMs: round(writeMs),
          hashMs: round(hashMs),
        };
      }
      opts.onFrame?.({ index, t, sha256: sha, bytes: png.length });
    };

    /**
     * 分片方式。默认**连续分片**：每个通道拿一段连续区间。
     *
     * 这不是为了均衡，是解码器特性：舞台每条视频都是"暂停 + 每次 seek"，
     * 而样例素材整段只有 1 个关键帧（8s/240 帧），seek 到 t 必须从 0 解到 t。
     * 连续分片让每个通道的 seek 单调递增，解码器/文件缓存能复用刚读过的数据；
     * 轮转分片会把 3 个通道的读放大成 3 段互不重叠的"从头解码"。
     * 两者**输出完全相同**（文件名按 index 写死），只是耗时不同。
     */
    const shard = opts.shard === 'round-robin' ? 'round-robin' : 'contiguous';
    const plans = shardPlan(frames, workers.length, shard);

    /** @type {any} */
    let failure = null;
    await Promise.all(
      workers.map(async (worker, workerIndex) => {
        try {
          for (const index of /** @type {number[]} */ (plans[workerIndex])) {
            if (opts.signal?.aborted) throw new StageCaptureError('CAPTURE_CANCELLED', 'frame capture cancelled');
            if (stop.signal.aborted) throw new StageCaptureError('CAPTURE_CANCELLED', 'another channel failed');
            await captureOne(index, worker.captureAt);
          }
        } catch (err) {
          if (!failure) failure = err;
          stop.abort(err);
        }
      }),
    );
    if (failure) throw failure;
    const hole = hashes.findIndex((sha) => typeof sha !== 'string');
    if (hole >= 0) {
      throw new StageCaptureError('STAGE_BOOT_FAILED', `capture finished but frame ${hole} is missing`);
    }

    const after = await session.probe();
    // 包 frame() 之前的那几条是 boot 噪声（同步 frame 的已知表现）：
    // 数组只追加，所以从 bootErrors.length 起才是「包完之后」新增的错误。
    const real = after.errors.slice(session.bootErrors.length);
    if (real.length > 0) {
      const first = real[0];
      throw new StageCaptureError(classifySceneError(first), `stage reported ${first.code}: ${first.message}`, {
        t: first.t,
      });
    }
    return {
      dir: framesDir,
      pattern: 'frame-%06d.png',
      frames,
      stage: session.stage,
      projectId: session.projectId,
      range,
      fps,
      concurrency,
      shard,
      sha256: hashes,
      bootErrors: session.bootErrors,
      pageErrors: session.pageErrors,
      sceneClips: session.sceneClips,
      ...(profileOn ? { profile: { ...summarizeProfile(frameProfile, roundTrip), concurrency, channels: session.channelCount } } : {}),
      capture: {
        version: STAGE_CAPTURE_VERSION,
        studioUrl: session.studioUrl,
        contentUrl: session.contentUrl,
        stageUrl: session.stageUrl,
        omittedScenes: session.omittedScenes,
        concurrency,
        channels: session.channelCount,
        kf: session.kf,
        probe: after,
      },
    };
  } finally {
    await session.close().catch(() => {});
  }
}

/** 保留两位小数，别让 JSON 里出现 1e-7 级别的噪声 */
function round(/** @type {any} */ value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/**
 * 把逐帧分项汇总成一张表能用的摘要。
 *
 * 分项定义（每帧）：
 *   eval      从发起 evaluate 到拿到回包，**包含**页面内的 settle
 *   settle    页面内 `await film.frame(t)` 的耗时（等 seeked + rAF + draw）
 *   ipc       eval - settle，CDP 往返 + 参数/返回值序列化
 *   shot      page.screenshot()，Chromium 编码 PNG + base64 传输
 *   write     fs.writeFile
 *   hash      sha256（取证用，不在关键路径的必要部分里）
 *
 * settle 是 eval 的**子集**，所以一帧的总时间 = eval + shot + write + hash。
 *
 * @param {any[]} frames
 * @param {{ medianMs: number, samples: number[] } | null} roundTrip
 */
export function summarizeProfile(frames, roundTrip) {
  const list = frames.filter((f) => f && typeof f === 'object');
  const n = list.length || 1;
  /** @param {string} key */
  const sumOf = (key) => list.reduce((acc, f) => acc + (Number(f[key]) || 0), 0);
  /** @param {string} key */
  const avgOf = (key) => Math.round((sumOf(key) / n) * 100) / 100;
  const avg = {
    evalMs: avgOf('evalMs'),
    settleMs: avgOf('settleMs'),
    ipcMs: avgOf('ipcMs'),
    shotMs: avgOf('shotMs'),
    writeMs: avgOf('writeMs'),
    hashMs: avgOf('hashMs'),
  };
  const perFrameTotal = avg.evalMs + avg.shotMs + avg.writeMs + avg.hashMs;
  const core = perFrameTotal || 1;
  /** @param {number} part */
  const pct = (part) => Math.round((part / core) * 1000) / 10;
  return {
    frames: list.length,
    roundTripBaselineMs: roundTrip ? Math.round(roundTrip.medianMs * 100) / 100 : null,
    roundTripSamples: roundTrip ? roundTrip.samples.map((v) => Math.round(v * 100) / 100) : [],
    sumMs: {
      evalMs: Math.round(sumOf('evalMs')),
      settleMs: Math.round(sumOf('settleMs')),
      ipcMs: Math.round(sumOf('ipcMs')),
      shotMs: Math.round(sumOf('shotMs')),
      writeMs: Math.round(sumOf('writeMs')),
      hashMs: Math.round(sumOf('hashMs')),
    },
    avgMs: avg,
    avgFrameTotalMs: Math.round(perFrameTotal * 100) / 100,
    sharePercent: {
      settle: pct(avg.settleMs),
      ipc: pct(avg.ipcMs),
      screenshot: pct(avg.shotMs),
      write: pct(avg.writeMs),
      hash: pct(avg.hashMs),
    },
    perFrame: list,
  };
}

/**
 * 帧索引分片：把 `frames` 个帧号分给 `workers` 个通道。
 *
 * 两种模式**输出完全相同**（帧号决定文件名，跟谁算、什么时候算无关），
 * 区别只在耗时：
 *   contiguous  每页一段连续区间，每页的 seek 单调递增
 *   round-robin 第 w 页拿 w, w+N, w+2N…
 * 默认连续：舞台每条视频都是"暂停 + 每次 seek"，而样例素材只有 1 个关键帧，
 * seek 到 t 要从 0 解到 t；单调递增能让解码器复用刚读过的数据。
 *
 * @param {number} frames
 * @param {number} workers
 * @param {'contiguous' | 'round-robin'} [mode]
 * @returns {number[][]}
 */
export function shardPlan(frames, workers, mode = 'contiguous') {
  const total = Math.max(1, Math.trunc(workers) || 1);
  const count = Math.max(0, Math.trunc(frames) || 0);
  /** @type {number[][]} */
  const out = Array.from({ length: total }, () => []);
  for (let index = 0; index < count; index += 1) {
    const owner = mode === 'round-robin' ? index % total : Math.min(total - 1, Math.floor((index * total) / count));
    /** @type {number[]} */ (out[owner]).push(index);
  }
  return out;
}

/**
 * 并发数收敛：显式值优先，其次缺口值，最后按帧数压——别为 6 帧开 4 个 page。
 * @param {number | undefined} requested
 * @param {number} fallback
 * @param {number} frames
 */
export function clampConcurrency(requested, fallback, frames) {
  const want = requested === undefined ? fallback : Math.trunc(Number(requested));
  const safe = Number.isFinite(want) ? want : fallback;
  return Math.max(1, Math.min(16, safe, Math.max(1, Math.ceil(frames / 4))));
}
