/**
 * FFmpeg 编码层（WP10）。
 *
 * 只做本批需要的一件事：PNG 序列 + 一条音轨 → H.264/AAC MP4，写 `.partial`，
 * 成功后原子提交为正式文件名。帧流的 stdin 管道本批不做（PNG 序列已满足交付）。
 *
 * 失败语义：
 * - CANCELLED      宿主 cancel / abort
 * - ENOSPC         磁盘满（含注入模拟）
 * - CODEC_UNAVAILABLE 本机 ffmpeg 没有 libx264 / aac
 * - FRAME_FAILED   其他编码失败
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** @typedef {import('../../contracts/render').RenderErrorCode} RenderErrorCode */

export class RenderFailure extends Error {
  /**
   * @param {RenderErrorCode | 'PROJECT_CHANGED'} code
   * @param {string} detail
   */
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'RenderFailure';
    this.code = code;
    this.detail = detail;
  }
}

/** @type {Map<string, Set<string>>} */
const encoderCache = new Map();

/** 本进程启动、尚未退出的编码子进程（pid → 用途）。只用于验收「没留悬挂进程」。 */
const activeEncoders = new Map();

/** @returns {number[]} */
export function activeEncoderPids() {
  return [...activeEncoders.keys()].map(Number);
}

/**
 * @param {string} ffmpegPath
 * @returns {Promise<Set<string>>}
 */
export async function listEncoders(ffmpegPath = 'ffmpeg') {
  const cached = encoderCache.get(ffmpegPath);
  if (cached) return cached;

  const stdout = await runCapture(ffmpegPath, ['-hide_banner', '-encoders']);
  const encoders = new Set();
  for (const line of stdout.split('\n')) {
    // 例： " V....D libx264              libx264 H.264 / AVC"
    const match = line.match(/^\s*[VAS][.A-Z]{5}\s+(\S+)/);
    if (match && match[1]) encoders.add(match[1]);
  }
  encoderCache.set(ffmpegPath, encoders);
  return encoders;
}

/**
 * @param {{ ffmpegPath?: string, required?: readonly string[] }} [opts]
 * @returns {Promise<{ ok: boolean, available: string[], missing: string[] }>}
 */
export async function checkEncoders(opts = {}) {
  const ffmpegPath = opts.ffmpegPath ?? 'ffmpeg';
  const required = opts.required ?? ['libx264', 'aac'];
  const encoders = await listEncoders(ffmpegPath);
  const missing = required.filter((name) => !encoders.has(name));
  return { ok: missing.length === 0, available: [...encoders].sort(), missing };
}

/* ── 滤镜探测（P70）：烧录字幕要 libass，而 Homebrew 的 8.1.2 没有 ───────── */

/** @type {Map<string, Set<string>>} */
const filterCache = new Map();
/** @type {Map<string, string | null>} */
const versionCache = new Map();
/** @type {Map<string, Promise<any>>} */
const describeCache = new Map();

/**
 * 列出 ffmpeg 支持的滤镜名。与 `listEncoders` 同形状、同缓存策略。
 *
 * 解析的是 `ffmpeg -filters` 的表体：`<flags> <name> <in->out> <description>`，
 * 例如 ` .. ass               V->V       Render ASS subtitles ...`。
 * 表头那几行（`T.. = Timeline support`）没有 `->`，正则自然不匹配。
 *
 * @param {string} ffmpegPath
 * @returns {Promise<Set<string>>}
 */
export async function listFilters(ffmpegPath = 'ffmpeg') {
  const cached = filterCache.get(ffmpegPath);
  if (cached) return cached;

  const stdout = await runCapture(ffmpegPath, ['-hide_banner', '-filters']);
  const filters = new Set();
  for (const line of stdout.split('\n')) {
    const match = line.match(/^\s*(?:[TSC.]{2,3}\s+)?([a-z0-9_]+)\s+[AVN|]+->[AVN|]+\s/);
    if (match && match[1]) filters.add(match[1]);
  }
  filterCache.set(ffmpegPath, filters);
  return filters;
}

/**
 * @param {{ ffmpegPath?: string, required?: readonly string[] }} [opts]
 * @returns {Promise<{ ok: boolean, available: string[], missing: string[] }>}
 */
export async function checkFilters(opts = {}) {
  const ffmpegPath = opts.ffmpegPath ?? 'ffmpeg';
  /* 烧字幕只用到这两个；`subtitles` 是入口，`ass` 是同一套 libass 的另一条路。 */
  const required = opts.required ?? ['subtitles', 'ass'];
  const filters = await listFilters(ffmpegPath);
  const missing = required.filter((name) => !filters.has(name));
  return { ok: missing.length === 0, available: [...filters].sort(), missing };
}

/**
 * `ffmpeg -version` 的首行（写进 spec.json，排查时一眼看出是哪个构建）。
 * @param {string} ffmpegPath
 * @returns {Promise<string | null>}
 */
export async function ffmpegVersionLine(ffmpegPath = 'ffmpeg') {
  if (versionCache.has(ffmpegPath)) return versionCache.get(ffmpegPath) ?? null;
  const stdout = await runCapture(ffmpegPath, ['-hide_banner', '-version']);
  const first = String(stdout).split('\n').map((line) => line.trim()).find((line) => line !== '') ?? null;
  versionCache.set(ffmpegPath, first);
  return first;
}

/**
 * 清缓存（测试用：同一个 shim 路径改内容后要重新探）。
 * @param {string} [ffmpegPath] 不给就清空
 */
export function clearFfmpegCaches(ffmpegPath) {
  if (ffmpegPath === undefined) {
    filterCache.clear();
    versionCache.clear();
    describeCache.clear();
    encoderCache.clear();
    return;
  }
  filterCache.delete(ffmpegPath);
  versionCache.delete(ffmpegPath);
  describeCache.delete(ffmpegPath);
  encoderCache.delete(ffmpegPath);
}

/**
 * ffmpeg 解析顺序（固定，不许改）：`OPENCUT_FFMPEG` → 工程内 `bin/ffmpeg`（打包位）→ `PATH`。
 *
 * `explicit`（`--ffmpeg-path` / env.json 的 `ffmpegPath`）排在最前：调用方明确指定的，
 * 就是它。**指定了但不存在**时不静默回退——那会把「路径写错」变成「用的是别的 ffmpeg」，
 * 比报错难查得多。
 *
 * @param {{ projectRoot?: string, env?: Record<string, string | undefined>, explicit?: string }} [opts]
 * @returns {Promise<{ path: string, source: 'explicit'|'env'|'project'|'path', found: boolean,
 *   candidates: Array<{ source: string, path: string, exists: boolean }> }>}
 */
export async function resolveFfmpegPath(opts = {}) {
  const env = opts.env ?? process.env;
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  /** @type {Array<{source: 'explicit'|'env'|'project'|'path', path: string, strict: boolean}>} */
  const candidates = [];
  if (typeof opts.explicit === 'string' && opts.explicit.trim() !== '') {
    candidates.push({ source: 'explicit', path: opts.explicit.trim(), strict: true });
  }
  const fromEnv = env?.OPENCUT_FFMPEG;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    candidates.push({ source: 'env', path: fromEnv.trim(), strict: true });
  }
  if (typeof opts.projectRoot === 'string' && opts.projectRoot !== '') {
    candidates.push({ source: 'project', path: path.join(opts.projectRoot, 'bin', exe), strict: false });
  }
  const pathVar = typeof env?.PATH === 'string' ? env.PATH : '';
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    candidates.push({ source: 'path', path: path.join(dir, exe), strict: false });
  }

  /** @type {Array<{ source: string, path: string, exists: boolean }>} */
  const seen = [];
  for (const candidate of candidates) {
    const exists = await fs.access(candidate.path, fs.constants.X_OK).then(() => true).catch(() => false);
    seen.push({ source: candidate.source, path: candidate.path, exists });
    if (exists) return { path: candidate.path, source: candidate.source, found: true, candidates: seen };
    /* 显式/环境变量指定的路径不存在：就此收手，别悄悄换一个 */
    if (candidate.strict) {
      return { path: candidate.path, source: candidate.source, found: false, candidates: seen };
    }
    if (seen.length > 20) break;
  }
  return { path: exe, source: 'path', found: false, candidates: seen };
}

/**
 * 一次解析 + 探能力的结果，直接写进导出 `spec.json`：
 * `{path, source, version, hasSubtitles, filters:{subtitles,ass}, ok}`。
 *
 * **不抛错**：没有字幕的导出不该因为「这台机器 ffmpeg 信息探不到」而失败。
 * 需要烧字幕的地方用 `assertBurnCapable()`。
 *
 * @param {{ projectRoot?: string, env?: Record<string, string | undefined>, explicit?: string }} [opts]
 * @returns {Promise<{ path: string, source: string, found: boolean, ok: boolean, version: string | null,
 *   hasSubtitles: boolean, filters: { subtitles: boolean, ass: boolean }, missing?: string[], error?: string }>}
 */
export async function describeFfmpeg(opts = {}) {
  const key = JSON.stringify({ p: opts.projectRoot ?? null, e: opts.env?.OPENCUT_FFMPEG ?? null, x: opts.explicit ?? null, path: opts.env?.PATH ?? null });
  const cached = describeCache.get(key);
  if (cached) return cached;

  const task = (async () => {
    const resolved = await resolveFfmpegPath(opts);
    const base = {
      path: resolved.path,
      source: resolved.source,
      found: resolved.found,
      candidates: resolved.candidates.slice(0, 8),
    };
    if (!resolved.found) {
      return {
        ...base,
        ok: false,
        version: null,
        hasSubtitles: false,
        filters: { subtitles: false, ass: false },
        error: 'ffmpeg not found (OPENCUT_FFMPEG / <project>/bin/ffmpeg / PATH)',
      };
    }
    try {
      const version = await ffmpegVersionLine(resolved.path);
      const check = await checkFilters({ ffmpegPath: resolved.path, required: ['subtitles', 'ass'] });
      return {
        ...base,
        ok: true,
        version,
        hasSubtitles: !check.missing.includes('subtitles'),
        filters: { subtitles: !check.missing.includes('subtitles'), ass: !check.missing.includes('ass') },
        ...(check.missing.length ? { missing: check.missing } : {}),
      };
    } catch (err) {
      return {
        ...base,
        ok: false,
        version: null,
        hasSubtitles: false,
        filters: { subtitles: false, ass: false },
        error: String(/** @type {any} */ (err)?.message ?? err),
      };
    }
  })();
  describeCache.set(key, task);
  const value = await task;
  describeCache.set(key, Promise.resolve(value));
  return value;
}

/** 烧字幕不可用。`code` 就是产品面上的 `BURN_UNAVAILABLE`。 */
export class BurnUnavailableError extends Error {
  /**
   * @param {string} detail
   * @param {string[]} suggestions
   */
  constructor(detail, suggestions) {
    super(`BURN_UNAVAILABLE: ${detail}`);
    this.name = 'BurnUnavailableError';
    this.code = 'BURN_UNAVAILABLE';
    this.detail = detail;
    this.suggestions = suggestions;
  }
}

/** 三条建议：设变量 / 换构建 / 别烧。 */
export const BURN_SUGGESTIONS = Object.freeze([
  'set OPENCUT_FFMPEG=/path/to/ffmpeg (a build compiled with libass) and export again',
  'install a libass-enabled build (e.g. `brew install ffmpeg`; some static builds omit libass)',
  'drop subtitle burning and ship the sidecar .ass/.vtt instead (`--subtitle-burn` off)',
]);

/**
 * 要烧字幕前的硬门禁：没有 `subtitles` 滤镜就明确失败，**绝不静默跳过字幕出片**。
 *
 * @param {{ projectRoot?: string, env?: Record<string, string | undefined>, explicit?: string }} [opts]
 * @returns {Promise<ReturnType<typeof describeFfmpeg> extends Promise<infer T> ? T : never>}
 */
export async function assertBurnCapable(opts = {}) {
  const info = await describeFfmpeg(opts);
  if (info.found && info.ok && info.hasSubtitles) return info;
  const where = `${info.path} (source=${info.source})`;
  const why = info.found
    ? `${info.version ?? 'unknown version'}; no 'subtitles' filter — built without libass${info.missing?.length ? `; missing: ${info.missing.join(', ')}` : ''}`
    : 'ffmpeg not found';
  throw new BurnUnavailableError(`${where} cannot burn subtitles: ${why}`, [...BURN_SUGGESTIONS]);
}

/**
 * @typedef {Object} EncodeOptions
 * @property {string} framesDir
 * @property {string} framePattern       例如 frame-%05d.png
 * @property {string} [audioPath]
 * @property {number} width
 * @property {number} height
 * @property {number} fps
 * @property {string} [fpsArg]           送 ffmpeg 的帧率写法；分数帧率必须是 "30000/1001"（P44）
 * @property {number} durationSec
 * @property {number} [startNumber]        PNG 序列起始编号（对应 range 起点）
 * @property {number} [frameCount]         本段编码帧数
 * @property {number} [audioStartSec]      音轨裁剪起点
 * @property {string} partialPath
 * @property {string} [ffmpegPath]
 * @property {string} [preset]
 * @property {number} [crf]
 * @property {number} [threads]           编码线程数（= 本次实际并行度）
 * @property {AbortSignal} [signal]
 * @property {(p: { framesDone: number, outTimeMs: number, speed: string | null }) => void} [onProgress]
 * @property {'ENOSPC' | null} [injectFault]
 */

/**
 * 编码到 partial 文件；调用方负责 commit。
 * @param {EncodeOptions} opts
 * @returns {Promise<{ partialPath: string, framesEncoded: number }>}
 */
export async function encodeVideo(opts) {
  const ffmpegPath = opts.ffmpegPath ?? 'ffmpeg';
  const { width, height, fps, durationSec, framesDir, framePattern, audioPath, partialPath } = opts;
  /* 帧率有两种写法：`fps` 是数字投影（给报告/校验用），`fpsArg` 是真正送 ffmpeg 的
     字符串。整数帧率两者都是 "30"，分数帧率必须是 "30000/1001"——写 "29.97"
     会被 ffmpeg 解释成 2997/100，一小时差 3.6 秒（P42/P44）。 */
  const fpsArg = opts.fpsArg ?? String(fps);

  if (opts.signal?.aborted) {
    throw new RenderFailure('CANCELLED', 'aborted before encode');
  }

  if (opts.injectFault === 'ENOSPC') {
    await fs.mkdir(path.dirname(partialPath), { recursive: true });
    await fs.writeFile(partialPath, Buffer.alloc(4096));
    await fs.unlink(partialPath).catch(() => {});
    throw new RenderFailure('ENOSPC', 'No space left on device (injected for R6)');
  }

  const encoders = await checkEncoders({ ffmpegPath });
  if (!encoders.ok) {
    throw new RenderFailure(
      'CODEC_UNAVAILABLE',
      `missing encoders: ${encoders.missing.join(', ')}; available: ${encoders.available.join(', ')}`,
    );
  }

  await fs.mkdir(path.dirname(partialPath), { recursive: true });

  /** @type {string[]} */
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-framerate',
    fpsArg,
    ...(opts.startNumber !== undefined ? ['-start_number', String(opts.startNumber)] : []),
    '-i',
    path.join(framesDir, framePattern),
  ];
  if (audioPath) {
    if (opts.audioStartSec && opts.audioStartSec > 0) args.push('-ss', String(opts.audioStartSec));
    args.push('-i', audioPath);
  }

  args.push('-map', '0:v:0');
  if (audioPath) args.push('-map', '1:a:0');

  args.push(
    '-c:v',
    'libx264',
    '-preset',
    opts.preset ?? 'medium',
    '-crf',
    String(opts.crf ?? 20),
    '-pix_fmt',
    'yuv420p',
    '-r',
    fpsArg,
  );
  if (opts.threads !== undefined) args.push('-threads', String(Math.max(1, Math.floor(opts.threads))));

  if (opts.frameCount !== undefined) args.push('-frames:v', String(opts.frameCount));
  if (audioPath) {
    args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
  }
  // 用 -t 卡住段长，避免音轨比画面长导致容器时长漂移。
  args.push('-t', String(durationSec));

  args.push('-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', partialPath);

  return new Promise((resolve, reject) => {
    /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */
    let child;
    try {
      child = /** @type {any} */ (
        spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
      );
    } catch (err) {
      reject(new RenderFailure('CODEC_UNAVAILABLE', `cannot spawn ffmpeg: ${String(err)}`));
      return;
    }

    let stderr = '';
    let stdoutBuffer = '';
    let framesEncoded = 0;
    let aborted = false;
    let settled = false;
    if (typeof child.pid === 'number') activeEncoders.set(String(child.pid), `encode:${partialPath}`);

    /** @param {string} line */
    const onProgressLine = (line) => {
      const [key, rawValue] = line.split('=');
      if (!key || rawValue === undefined) return;
      const value = rawValue.trim();
      if (key === 'frame') {
        const n = Number(value);
        if (Number.isFinite(n)) framesEncoded = n;
      } else if (key === 'progress') {
        opts.onProgress?.({
          framesDone: framesEncoded,
          outTimeMs: lastOutTimeMs,
          speed: lastSpeed,
        });
      }
      if (key === 'out_time_us') {
        const n = Number(value);
        if (Number.isFinite(n)) lastOutTimeMs = Math.round(n / 1000);
      } else if (key === 'speed') {
        lastSpeed = value;
      }
    };

    let lastOutTimeMs = 0;
    /** @type {string | null} */ let lastSpeed = null;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      let index = stdoutBuffer.indexOf('\n');
      while (index >= 0) {
        const line = stdoutBuffer.slice(0, index).trim();
        stdoutBuffer = stdoutBuffer.slice(index + 1);
        if (line) onProgressLine(line);
        index = stdoutBuffer.indexOf('\n');
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });

    /** @param {NodeJS.Signals} signal */
    const killGroup = (signal) => {
      const pid = child.pid;
      if (typeof pid !== 'number') return;
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* gone */
        }
      }
    };

    /** @param {RenderErrorCode} code @param {string} detail */
    const fail = async (code, detail) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener('abort', onAbort);
      if (child.exitCode === null && child.signalCode === null) {
        killGroup('SIGKILL');
      }
      await fs.unlink(partialPath).catch(() => {});
      reject(new RenderFailure(code, detail));
    };

    const onAbort = () => {
      aborted = true;
      killGroup('SIGTERM');
      // 300ms 后仍未退出则强杀；close 处理器负责清理 partial。
      const timer = setTimeout(() => killGroup('SIGKILL'), 300);
      timer.unref?.();
    };

    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', () => {
      if (typeof child.pid === 'number') activeEncoders.delete(String(child.pid));
      void fail('CODEC_UNAVAILABLE', 'ffmpeg process failed to start');
    });

    child.on('close', (code) => {
      if (typeof child.pid === 'number') activeEncoders.delete(String(child.pid));
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener('abort', onAbort);

      const finish = async () => {
        if (aborted || opts.signal?.aborted) {
          await fs.unlink(partialPath).catch(() => {});
          throw new RenderFailure('CANCELLED', 'encode cancelled');
        }
        if (code === 0) {
          const stat = await fs.stat(partialPath).catch(() => null);
          if (!stat || stat.size === 0) {
            await fs.unlink(partialPath).catch(() => {});
            throw new RenderFailure('FRAME_FAILED', 'no output produced');
          }
          opts.onProgress?.({
            framesDone: framesEncoded,
            outTimeMs: Math.max(lastOutTimeMs, Math.round(durationSec * 1000)),
            speed: lastSpeed,
          });
          resolve({ partialPath, framesEncoded });
          return;
        }
        if (/no space left on device|enospc/i.test(stderr)) {
          await fs.unlink(partialPath).catch(() => {});
          throw new RenderFailure('ENOSPC', 'ffmpeg reported no space left on device');
        }
        if (/unknown encoder|encoder .* not found/i.test(stderr)) {
          await fs.unlink(partialPath).catch(() => {});
          throw new RenderFailure('CODEC_UNAVAILABLE', truncate(stderr));
        }
        await fs.unlink(partialPath).catch(() => {});
        throw new RenderFailure('FRAME_FAILED', truncate(stderr) || `ffmpeg exit ${code}`);
      };

      finish().then(
        () => {},
        (err) => reject(err instanceof RenderFailure ? err : new RenderFailure('FRAME_FAILED', String(err))),
      );
    });
  });
}

/**
 * 提交：不覆盖旧文件，重名时追加 " 2"、" 3"。先复制（EXCL）再删 partial，
 * 避免 rename 在 POSIX 上静默覆盖。
 * @param {string} partialPath
 * @param {string} desiredPath
 * @returns {Promise<string>} 最终路径
 */
export async function commitOutput(partialPath, desiredPath) {
  const dir = path.dirname(desiredPath);
  const ext = path.extname(desiredPath);
  const base = path.basename(desiredPath, ext);

  let attempt = 1;
  for (;;) {
    const target = attempt === 1 ? desiredPath : path.join(dir, `${base} ${attempt}${ext}`);
    try {
      await fs.copyFile(partialPath, target, fs.constants.COPYFILE_EXCL);
      await fs.unlink(partialPath);
      return target;
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code === 'EEXIST') {
        attempt += 1;
        continue;
      }
      /* P81：`ENOENT` 有两种完全不同的意思 —— 「中间件没了」还是「输出目录没了」。
         以前一律写 `commit failed: ENOENT`，现场只能靠猜（s74 抖了三轮）。
         所以先探活、再清理，把两侧的事实写进错误里。 */
      const sourcePresent = await fs.stat(partialPath).then(() => true).catch(() => false);
      const dirPresent = await fs.stat(dir).then(() => true).catch(() => false);
      await fs.unlink(partialPath).catch(() => {});
      if (code === 'ENOSPC') throw new RenderFailure('ENOSPC', 'no space left while committing output');
      throw new RenderFailure(
        'FRAME_FAILED',
        `commit failed: ${code ?? String(err)} (partial=${sourcePresent ? 'present' : 'missing'} outDir=${dirPresent ? 'present' : 'missing'} target=${path.basename(target)})`,
      );
    }
  }
}

/**
 * @param {string} file
 * @returns {Promise<string>}
 */
export async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(file, 'r');
  try {
    const stream = handle.createReadStream();
    for await (const chunk of stream) hash.update(/** @type {Buffer} */ (chunk));
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<string>}
 */
function runCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      err += chunk;
    });
    child.on('error', () => reject(new RenderFailure('CODEC_UNAVAILABLE', `cannot run ${command}`)));
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new RenderFailure('CODEC_UNAVAILABLE', truncate(err) || `${command} exit ${code}`));
    });
  });
}

/**
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
function truncate(text, max = 600) {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}
