// @ts-nocheck —— 这是 detached 子进程的入口：没有宿主、没有 CLI，只认作业目录里的 spec.json。
/**
 * 作业 worker（P47 · B-SUB2-R24-024）。
 *
 * 由 `port.mjs` 用 `fork(..., { detached: true, stdio: 'ignore' })` 拉起，
 * 在**独立进程**里跑完整条渲染，所以 CLI 退出后作业继续。
 *
 * 输入：`<jobDir>/spec.json`（port 写好的 spec + 解析后的 projectPath / ffmpeg 路径）
 * 输出（都在同一个目录）：
 * - `job.json`：状态机 `running → done | failed | cancelled`，逐段原子写
 * - `events.jsonl`：每行一条进度事件，**只追加**（worker 崩了也能看到跑到哪）
 * - `worker.pid`：由 port 写；worker 退出时删
 * - `job.lock`：同上
 *
 * 取消：SIGTERM（或 `cancel.requested` 出现）→ abort → `renderFilmExport` 的
 * `runFfmpeg` 走 SIGTERM→SIGKILL，`finally` 清掉两份 `.video.partial*`；
 * worker 再把 `.partial`/`.lock`/`.pid` 扫一遍，写 `state:'cancelled'`。
 *
 * 舞台取帧（P49）：plan 里有 `page` 片段时才**动态 import** `stage-capture.mjs`，
 * 复用 `export film` 那一份 `captureFilmFrames`（不复制、不另写循环），帧落
 * `<jobDir>/frames/`，取完把 `{ framesDir, pattern, frames }` 交给 `renderFilmExport`，
 * 成片/失败/取消后连同中间件一起清掉。没有网页片段的工程一行都不会加载 Playwright。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { parse } from '../film-core/film-doc.mjs';
import { buildVttDocument, prepareSubtitleBurn } from './subtitles.mjs';
import { planFromFilm } from './film-plan.mjs';
import { renderFilmExport } from './film-export.mjs';
import { resolveCodec } from './codec-matrix.mjs';
import { hashProject } from './job.mjs';
import { rateOfFps } from './fps.mjs';
import { resolveSubtitleStyle } from './subtitle-style-source.mjs';

const jobDir = path.resolve(/** @type {string} */ (process.argv[2] ?? ''));
if (!jobDir || jobDir === '/') {
  process.stderr.write('port-worker: a job directory is required\n');
  process.exit(2);
}

const startedAt = Date.now();
/** @type {AbortController} */
const controller = new AbortController();
let cancelled = false;
/** 舞台取帧的帧序列目录（`<jobDir>/frames`）；没有网页片段时保持 null。
 *  @type {string | null} */
let framesDir = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let progressFlush = null;
/** @type {{ phase?: string, frame?: number, totalFrames?: number, stage?: string } | null} */
let lastProgress = null;
/** 终态已落盘：进度节流不再写 job.json，免得把 failed/cancelled 覆盖回 running。 */
let finalized = false;

/** @param {string} file */
async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

/**
 * 原子写 job.json：先写临时文件再 rename，宿主永远读不到半份状态。
 *
 * 写入必须**串行**：进度节流（250ms）与终态落盘可能同时发生，而两者用的是同一个
 * 临时文件名——实测会互相截断，留下 `} "stage": "capture" }` 这种半截 JSON，
 * 宿主 `readJob` 直接解析失败（status 退回 waiting，看起来像作业丢了）。
 * 这里把每次写排进一条链，临时名带序号，rename 顺序 = 调用顺序。
 */
let writeSeq = 0;
let writeChain = Promise.resolve();

/** @param {any} state */
function writeState(state) {
  const snapshot = `${JSON.stringify(state, null, 2)}\n`;
  writeChain = writeChain.then(async () => {
    const target = path.join(jobDir, 'job.json');
    const temp = `${target}.tmp-${process.pid}-${(writeSeq += 1)}`;
    await fs.writeFile(temp, snapshot, 'utf8').catch(() => {});
    await fs.rename(temp, target).catch(() => {});
  });
  return writeChain;
}

/**
 * `events.jsonl` 只追加。**必须串行**：烧录进度是逐帧连发的（一帧一条 `appendFile`），
 * 并发 append 的完成顺序由 libuv 决定，实测 30 帧里能乱成 `1,2,4,3,5,6,8,7,11,10,9…`——
 * 文件里就再也看不出「跑到第几帧」了（P54-A5）。这里与 `writeState` 一样用一条 Promise 链，
 * 保持**调用顺序**；仍然是 fire-and-forget，不拖慢编码。
 */
let eventChain = Promise.resolve();

/**
 * @param {any} event
 */
function appendEvent(event) {
  const line = `${JSON.stringify(event)}\n`;
  eventChain = eventChain.then(() => fs.appendFile(path.join(jobDir, 'events.jsonl'), line, 'utf8').catch(() => {}));
  return eventChain;
}

/** @param {string} dir */
async function cleanupIntermediates(dir) {
  /** @type {string[]} */
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.includes('.partial') || name.endsWith('.opencut-lock') || name === 'worker.pid' || name === 'job.lock') {
      await fs.rm(path.join(dir, name), { force: true }).catch(() => {});
    }
  }
}

/**
 * 删掉取帧目录（P49）。PNG 序列是**中间物**：成片、取消、失败三种收尾都不留。
 * 只删自己刚建的那一个 `<jobDir>/frames`，别的一律不碰。
 */
async function cleanupFrames() {
  if (!framesDir) return;
  const target = framesDir;
  framesDir = null;
  await fs.rm(target, { recursive: true, force: true }).catch(() => {});
}

async function main() {
  /** @type {any} */
  let state = {
    jobId: process.env.OPENCUT_JOB_ID ?? null,
    state: 'running',
    phase: 'planning',
    framesDone: 0,
    framesTotal: 0,
    pid: process.pid,
    startedAt,
  };

  /** @param {any} patch */
  const flush = async (patch = {}) => {
    state = { ...state, ...patch };
    if (patch.state === 'done' || patch.state === 'failed' || patch.state === 'cancelled') finalized = true;
    /* 记账：本 worker 进程的峰值 RSS（KB，Node 在 darwin 上也是 KB）。
       本机沙箱里 `ps`/`top` 被禁，宿主只能从 job.json 读到这个数——它**不含**
       Chromium 子进程的内存（那些是取帧期间的临时开销，不进作业账本）。 */
    const peakRssKB = Number(process.resourceUsage().maxRSS);
    if (Number.isFinite(peakRssKB) && peakRssKB > 0) state.peakRssKB = peakRssKB;
    await writeState(state);
  };

  const onAbort = () => {
    if (cancelled) return;
    cancelled = true;
    appendEvent({ type: 'cancel', at: Date.now() - startedAt });
    controller.abort();
  };
  process.on('SIGTERM', onAbort);
  process.on('SIGINT', onAbort);
  // SIGTERM 之外的兜底：cancel 写了 cancel.requested 但信号没送到（例如 pid 变了）
  const cancelPoll = setInterval(() => {
    fs.stat(path.join(jobDir, 'cancel.requested')).then(
      () => onAbort(),
      () => {},
    );
  }, 200);
  if (typeof cancelPoll.unref === 'function') cancelPoll.unref();

  try {
    const spec = await readJson(path.join(jobDir, 'spec.json'));
    state.jobId = spec.jobId ?? state.jobId;
    await flush();

    const projectRoot = path.resolve(String(spec.projectPath ?? ''));
    if (!projectRoot) throw Object.assign(new Error('spec.projectPath is missing'), { code: 'INVALID_FILM' });

    // 工程哈希：渲染前后各看一次太贵（这条路径没有增量帧源），开工前对齐一次就够
    const actualHash = await hashProject(projectRoot);
    if (typeof spec.expectedHash === 'string' && spec.expectedHash !== actualHash) {
      throw Object.assign(new Error(`project hash changed (${actualHash} != ${spec.expectedHash})`), {
        code: 'PROJECT_CHANGED',
      });
    }

    const filmFile = path.join(projectRoot, 'film.html');
    const parsed = parse(await fs.readFile(filmFile, 'utf8'), { path: 'film.html' });
    if (!parsed.doc) {
      throw Object.assign(new Error('film.html could not be parsed'), { code: 'INVALID_FILM' });
    }

    // 帧率（P42/P44）：与 export film 同一套有理数
    const rate = rateOfFps(spec.fps ?? 30);
    const plan = await planFromFilm(parsed.doc, {
      projectRoot,
      fps: rate.value,
      fpsRational: { num: rate.num, den: rate.den },
      ...(spec.range !== undefined ? { range: spec.range } : {}),
      ...(spec.ranges !== undefined ? { ranges: spec.ranges } : {}),
      ...(spec.ffprobePath ? { ffprobePath: spec.ffprobePath } : {}),
    });
    state.framesTotal = Number(plan.frames) || 0;
    await flush({ phase: 'rendering', framesDone: 0 });

    /** 进度落盘节流：每帧都写一次 job.json 会把磁盘打满，250ms 或阶段变化时写。 */
    const pushProgress = (/** @type {any} */ info) => {
      lastProgress = { ...info };
      appendEvent({
        type: 'progress',
        phase: info.phase,
        ...(info.stage ? { stage: info.stage } : {}),
        ...(Number.isFinite(info.frame) ? { frame: info.frame } : {}),
        ...(Number.isFinite(info.totalFrames) ? { totalFrames: info.totalFrames } : {}),
        at: Date.now() - startedAt,
      });
      if (progressFlush !== null) return;
      progressFlush = setTimeout(() => {
        progressFlush = null;
        if (!lastProgress) return;
        if (cancelled || finalized) return;
        state.phase = lastProgress.phase;
        // P49：`stage` 也要落到 job.json——`export status` 靠它区分「在取帧」和「在编码」，
        // 长工程看起来卡在 0% 时至少能看出是哪一段在跑。
        if (lastProgress.stage) state.stage = lastProgress.stage;
        if (Number.isFinite(lastProgress.frame)) {
          /* 多通道并行取帧的完成顺序是乱的（先报 214 再报 114 很正常），
             所以 capture 阶段只往前走；encode 是单进程顺序上报，照原样写。 */
          state.framesDone =
            lastProgress.stage === 'capture'
              ? Math.max(Number(state.framesDone) || 0, lastProgress.frame)
              : lastProgress.frame;
        }
        if (Number.isFinite(lastProgress.totalFrames)) state.framesTotal = lastProgress.totalFrames;
        writeState(state).catch(() => {});
      }, 250);
      if (typeof progressFlush.unref === 'function') progressFlush.unref();
    };

    /* ── 舞台取帧（P49）──────────────────────────────────────────────────────
       `export film` 早就支持网页片段：ops.mjs 调 `captureFilmFrames` 把舞台逐帧截成
       PNG，再把 `capture` 交给 renderFilmExport。作业管线以前完全没有这一步，于是
       带 page 片段的工程在 `assertRenderable` 里直接 UNSUPPORTED_SCENE_CLIP。

       这里的参数与 ops.mjs 那处**逐项对齐**（同一个函数、同一组语义）：
       `plan` / `projectRoot` / `framesDir` / `signal` / 逐帧 `onFrame`。
       差别只有两处，都是作业场景自己的事：
       - 帧目录在作业目录内（`<jobDir>/frames`），不留 /tmp、成片后清；
       - 进度走 `phase:'rendering' + stage:'capture'`，与后面编码的 `stage:'encode'` 分开。

       惰性 import：没有网页片段的工程**不加载** stage-capture（它顶层 import 了
       studio-server），启动时间与 P47 一致，也不会白起浏览器。 */
    /** @type {any} */
    let capture = null;
    const sceneClips = Array.isArray(plan.sceneClips) ? plan.sceneClips : [];
    if (sceneClips.length > 0) {
      const { assertSceneClipsReady, wrapSceneCaptureError } = await import('./scene-clips.mjs');
      // 前置检查与 export film 同一时点：缺文件/跨源/越界在**开浏览器之前**失败。
      // 这类是工程文档本身的问题（引用了不存在的东西），不是"舞台画不出来"——
      // 所以映射成 INVALID_FILM（退出码 2），把 SCENE_CAPTURE_FAILED 留给真正的取帧失败。
      try {
        await assertSceneClipsReady(plan, { projectRoot });
      } catch (err) {
        const detail = String(/** @type {any} */ (err)?.detail ?? /** @type {any} */ (err)?.message ?? err);
        throw Object.assign(new Error(`scene clip ${/** @type {any} */ (err)?.clipId ?? '?'}: ${detail}`), {
          code: 'INVALID_FILM',
        });
      }

      framesDir = path.join(jobDir, 'frames');
      await fs.mkdir(/** @type {string} */ (framesDir), { recursive: true });
      const stageModule = await import('./stage-capture.mjs');
      const { captureFilmFrames } = stageModule;
      try {
        capture = await captureFilmFrames({
          plan,
          projectRoot,
          framesDir: /** @type {string} */ (framesDir),
          ...(spec.contentPort !== undefined ? { contentPort: spec.contentPort } : {}),
          ...(spec.filmWaitMs !== undefined ? { filmWaitMs: spec.filmWaitMs } : {}),
          ...(spec.frameTimeoutMs !== undefined ? { frameTimeoutMs: spec.frameTimeoutMs } : {}),
          ...(spec.captureConcurrency !== undefined ? { concurrency: spec.captureConcurrency } : {}),
          signal: controller.signal,
          // 逐帧进度：`index` 是 0 基，对外报 1 基（与 ops.mjs 的 export film 一致）
          onFrame: (/** @type {{ index: number }} */ frame) => {
            pushProgress({
              phase: 'rendering',
              stage: 'capture',
              frame: frame.index + 1,
              totalFrames: Number(plan.frames) || 0,
            });
          },
        });
      } catch (err) {
        // 取消是用户的意图，不是场景画不出来：原样抛，让外层写 cancelled
        if (controller.signal.aborted) throw err;
        throw wrapSceneCaptureError(err, { clipIds: sceneClips.map((/** @type {any} */ clip) => String(clip.id)) });
      }
      // 取帧完 → 编码开始：stage 翻面，帧号从编码自己的 1 重新数。
      // `stageLaunches`（P51）：本次作业到底起了几个 Chromium——计数器说的，不是猜的。
      // 「一个作业只允许一次 startStageCapture」如果被将来的重构打破，这个数字会先跳出来。
      await flush({
        phase: 'rendering',
        stage: 'encode',
        framesDone: 0,
        stageLaunches: Number(stageModule.stageLaunchCount?.() ?? 0),
      });
    }

    const codec = resolveCodec(spec.codec);
    const ext = codec.extension;
    const outPath = path.join(jobDir, `${spec.jobId}${ext}`);
    /** @type {{ assPath: string, outPath: string } | null} */
    let subtitleRequest = null;
    /** @type {any} */
    let subtitleBundle = null;
    /** @type {any} */
    let styleAudit = null;
    if (spec.subtitleBurn === true) {
      // P48：显式 spec.subtitleStyle > 工程 .film/subtitle-style.json > 默认
      const resolved = await resolveSubtitleStyle({ projectRoot, explicit: spec.subtitleStyle });
      styleAudit = resolved.audit;
      subtitleBundle = await prepareSubtitleBurn({
        plan,
        ...(resolved.style !== undefined ? { subtitleStyle: resolved.style } : {}),
        size: { w: Number(plan.stage.w), h: Number(plan.stage.h) },
        assPath: path.join(jobDir, 'subtitles.ass'),
        /* P70：工程根要进来，才能按 OPENCUT_FFMPEG → <project>/bin/ffmpeg → PATH 的顺序解析。 */
        projectRoot,
        ...(spec.ffmpegPath ? { ffmpegPath: spec.ffmpegPath } : {}),
      });
      subtitleRequest = { assPath: subtitleBundle.assPath, outPath: path.join(jobDir, `${spec.jobId}-subbed${ext}`) };
    }

    const result = await renderFilmExport({
      plan,
      projectRoot,
      outPath,
      // P49：有网页片段时把舞台取好的帧序列交给它（`capture` 是它已有的入口，
      // 这里只传，不改渲染语义）。没有网页片段时这一段完全是 null，走原来的 ffmpeg 合成。
      ...(capture
        ? { capture: { framesDir: capture.dir, pattern: capture.pattern, frames: capture.frames } }
        : {}),
      ...(subtitleRequest ? { subtitles: subtitleRequest } : {}),
      ...(spec.quality !== undefined ? { quality: spec.quality } : {}),
      codec: codec.name,
      ...(spec.loudness !== undefined ? { loudness: spec.loudness } : {}),
      ...(spec.ffmpegPath ? { ffmpegPath: spec.ffmpegPath } : {}),
      ...(spec.ffprobePath ? { ffprobePath: spec.ffprobePath } : {}),
      signal: controller.signal,
      onProgress: pushProgress,
    });

    // 旁挂 vtt：与 export film 同一条生成路径（成片时间的规范版）
    /** @type {{ path: string, bytes: number, sha256: string, cues: number } | null} */
    let vtt = null;
    if (subtitleBundle) {
      const text = buildVttDocument({ cues: subtitleBundle.cues });
      const vttPath = path.join(jobDir, `${spec.jobId}.vtt`);
      await fs.writeFile(vttPath, text, 'utf8');
      const { createHash } = await import('node:crypto');
      const body = Buffer.from(text, 'utf8');
      vtt = {
        path: vttPath,
        bytes: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
        cues: subtitleBundle.cues.length,
      };
    }

    const artifacts = {
      master: {
        path: result.path,
        bytes: result.bytes,
        sha256: result.sha256,
        frames: result.frames,
        durationSec: result.durationSec,
        ...(result.pixelFormat ? { pixelFormat: result.pixelFormat } : {}),
      },
      ...(result.subtitles
        ? {
            subbed: {
              path: result.subtitles.path,
              bytes: result.subtitles.bytes,
              sha256: result.subtitles.sha256,
              frames: result.subtitles.frames,
              durationSec: result.subtitles.durationSec,
            },
          }
        : {}),
      ...(vtt ? { vtt } : {}),
      ...(styleAudit ? { subtitleStyle: styleAudit } : {}),
    };
    await flush({ state: 'done', phase: 'done', framesDone: state.framesTotal, artifacts, finishedAt: Date.now() });
    await appendEvent({ type: 'done', at: Date.now() - startedAt, sha256: result.sha256 });
  } catch (err) {
    const code = /** @type {any} */ (err)?.code ?? 'FRAME_FAILED';
    const message = String(/** @type {any} */ (err)?.message ?? err);
    const finalState = cancelled || code === 'CANCELLED' ? 'cancelled' : 'failed';
    await cleanupIntermediates(jobDir);
    await flush({
      state: finalState,
      ...(finalState === 'failed' ? { error: code, errorDetail: message } : {}),
      finishedAt: Date.now(),
    });
    await appendEvent({ type: finalState === 'cancelled' ? 'cancel' : 'error', at: Date.now() - startedAt, code, message });
    process.exitCode = finalState === 'cancelled' ? 0 : 1;
  } finally {
    clearInterval(cancelPoll);
    if (progressFlush !== null) clearTimeout(progressFlush);
    // 取消/失败时把中间件扫干净；成功路径 renderFilmExport 的 finally 已经删过
    await cleanupIntermediates(jobDir);
    // 取帧的 PNG 序列是中间物：三种收尾（done / cancelled / failed）都不留
    await cleanupFrames();
  }
}

await main();
