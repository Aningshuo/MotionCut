/**
 * 渲染闸门共用的 ffmpeg / ffprobe 解析 + 运行目录自举（P73 · B-SUB2-R29-038）。
 *
 * ## 为什么要这个文件
 *
 * p57–p72 的十六个验收脚本以前各自写死 `<repo>/.local-runs/sub2/runs/R12/bin/ffmpeg`。
 * `.local-runs/**` 一行都没进 git，所以那十六条闸门的「绿」只在**一个** worktree 目录里成立：
 * 换目录、上 CI、换机器全是 `spawn … ENOENT`。M83 只修了**打包**那一半，验收这一半一直没动。
 *
 * 这里把两件事收成一处：
 *
 * 1. **ffmpeg 从哪来**：与 `scripts/package-desktop.mjs` 的 `resolveTools()` **同一顺序** ——
 *    `OPENCUT_FFMPEG`/`OPENCUT_FFPROBE` → 仓库内 `resources/bin/{ffmpeg,ffprobe}` → `PATH`
 *    （**必须** `-filters` 里同时有 `subtitles` 与 `ass`）→ 抛错。报错文案指向
 *    `resources/bin/README.md`。与打包同序的意义：验收用的就是交付用的那个二进制，
 *    不是开发机上碰巧装的那一个。
 * 2. **跑在哪个目录**：`--root` 显式给就用它；不给就在系统临时目录里**自建**一个带时间戳的
 *    目录（并补一个空 `env.json`）——默认值**不再**指向 `.local-runs/…`。
 *
 * ## 一条纪律（写在这里，别在脚本里再分叉）
 *
 * 解析顺序、滤镜判据、报错文案只此一份。谁要「临时换个 ffmpeg」，用 `OPENCUT_FFMPEG`，
 * 不许在脚本里写死路径——那正是这条 P0 要消灭的东西。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（本文件在 `<repo>/scripts/lib/`）。 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 烧字幕必须同时具备的两个滤镜（`subtitles` 是入口，`ass` 是它的内核）。 */
export const REQUIRED_FILTERS = Object.freeze(['subtitles', 'ass']);

/** 找不到时给的下一步，不写「请安装 ffmpeg」这种废话。 */
export const FFMPEG_HINT =
  '见 resources/bin/README.md（或设 OPENCUT_FFMPEG=<绝对路径> 指到一个带 libass 的 ffmpeg）';

/** @param {string} file */
function executable(file) {
  try {
    return fs.existsSync(file) && fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * `ffmpeg -filters` 里有没有那几个滤镜。
 *
 * 表体形状是 `.. ass  V->V  …`（两列 flag + 名字），所以按「整词」匹配，不用 includes
 * ——`subtitles` 会被 `ass` 的行提到，但 `subtitles` 自己也可能出现在别的滤镜描述里。
 *
 * @param {string} file
 * @param {readonly string[]} required
 * @returns {{ok: boolean, version: string, subtitles: boolean, filterLine: string, missing: string[]}}
 */
function inspectFfmpeg(file, required = REQUIRED_FILTERS) {
  const versionRun = spawnSync(file, ['-hide_banner', '-version'], { encoding: 'utf8' });
  if (versionRun.status !== 0) {
    return { ok: false, version: '', subtitles: false, filterLine: '', missing: [...required] };
  }
  const version = String(versionRun.stdout ?? '').split('\n')[0]?.trim() ?? '';
  const filtersRun = spawnSync(file, ['-hide_banner', '-filters'], { encoding: 'utf8' });
  const lines = String(filtersRun.stdout ?? '').split('\n');
  /** @type {string[]} */
  const missing = [];
  let filterLine = '';
  for (const name of required) {
    const hit = lines.find((line) => new RegExp(`^\\s*\\S{0,3}\\s+${name}\\s+\\S`).test(line)) ?? '';
    if (hit === '') missing.push(name);
    else if (name === 'subtitles' || filterLine === '') filterLine = hit.trim();
  }
  return {
    ok: true,
    version,
    subtitles: missing.length === 0,
    filterLine,
    missing,
  };
}

/**
 * 找 ffmpeg / ffprobe。顺序与 `scripts/package-desktop.mjs` 的 `resolveTools()` 完全一致。
 *
 * @param {{
 *   requireLibass?: boolean,
 *   env?: NodeJS.ProcessEnv,
 *   repoRoot?: string,
 *   required?: readonly string[],
 * }} [options]
 * @returns {{ffmpeg: string, ffprobe: string, binDir: string, path: string, probePath: string,
 *   source: string, version: string, subtitles: boolean, filterLine: string, rejected: string[]}}
 */
export function resolveFfmpeg(options = {}) {
  const requireLibass = options.requireLibass !== false;
  const env = options.env ?? process.env;
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const required = options.required ?? REQUIRED_FILTERS;

  /** @type {Array<{path: string, source: string}>} */
  const candidates = [];
  const envFfmpeg = String(env.OPENCUT_FFMPEG ?? '');
  if (envFfmpeg !== '' && executable(envFfmpeg)) candidates.push({ path: path.resolve(envFfmpeg), source: 'OPENCUT_FFMPEG' });
  const bundled = path.join(repoRoot, 'resources', 'bin', 'ffmpeg');
  if (executable(bundled)) candidates.push({ path: bundled, source: 'resources/bin' });
  const found = spawnSync('which', ['ffmpeg'], { encoding: 'utf8' });
  if (found.status === 0 && String(found.stdout ?? '').trim() !== '') {
    candidates.push({ path: String(found.stdout).trim(), source: 'PATH' });
  }

  /** @type {{path: string, source: string, info: ReturnType<typeof inspectFfmpeg>} | null} */
  let picked = null;
  /** @type {string[]} */
  const rejected = [];
  for (const candidate of candidates) {
    const info = inspectFfmpeg(candidate.path, required);
    if (!info.ok) {
      rejected.push(`${candidate.source}(不可执行)`);
      continue;
    }
    if (requireLibass && !info.subtitles) {
      rejected.push(`${candidate.source}(缺 ${info.missing.join('/')})`);
      continue;
    }
    picked = { ...candidate, info };
    break;
  }
  if (picked === null) {
    throw new Error(
      `找不到${requireLibass ? '带 subtitles 滤镜（libass）的' : ''} ffmpeg：` +
        `${rejected.length === 0 ? '候选一个都没有；' : `已排除 ${rejected.join('、')}；`}${FFMPEG_HINT}`,
    );
  }

  const ffmpegPath = picked.path;
  let ffprobePath = String(env.OPENCUT_FFPROBE ?? '');
  if (ffprobePath === '' || !executable(ffprobePath)) {
    const sibling = path.join(path.dirname(ffmpegPath), 'ffprobe');
    if (executable(sibling)) ffprobePath = sibling;
  }
  if (ffprobePath === '' || !executable(ffprobePath)) {
    const bundledProbe = path.join(repoRoot, 'resources', 'bin', 'ffprobe');
    if (executable(bundledProbe)) ffprobePath = bundledProbe;
  }
  if (ffprobePath === '' || !executable(ffprobePath)) {
    const probe = spawnSync('which', ['ffprobe'], { encoding: 'utf8' });
    if (probe.status === 0) ffprobePath = String(probe.stdout ?? '').trim();
  }
  if (ffprobePath === '') {
    throw new Error(`找不到 ffprobe：设 OPENCUT_FFPROBE=<绝对路径>，或把 ffprobe 放进 PATH / resources/bin（不许静默跳过）`);
  }

  const resolvedProbe = path.resolve(ffprobePath);
  return {
    ffmpeg: ffmpegPath,
    ffprobe: resolvedProbe,
    /* 兼容 M85 一侧的消费者（m41/m73/m74/m86/m87 用的是 `tools.binDir`）：
       两条线各自写了一份同功能模块（P73 与 M85 撞车），合并时保留这份更完整的实现，
       但必须同时满足对面的字段契约，否则对面五个脚本会拿到 undefined。 */
    binDir: path.dirname(ffmpegPath),
    path: ffmpegPath,
    probePath: resolvedProbe,
    source: picked.source,
    version: picked.info.version,
    subtitles: picked.info.subtitles,
    filterLine: picked.info.filterLine,
    rejected,
  };
}

/**
 * `resolveFfmpeg()` 的「诊断用」薄壳：失败时返回 `{ok:false,error}`，不抛。
 * 闸门要记录「为什么没有 ffmpeg」，而不是直接崩栈。
 *
 * @param {{requireLibass?: boolean, repoRoot?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {{ok: true, tools: ReturnType<typeof resolveFfmpeg>} | {ok: false, error: string}}
 */
export function tryResolveFfmpeg(options = {}) {
  try {
    return { ok: true, tools: resolveFfmpeg(options) };
  } catch (error) {
    const message = /** @type {{message?: unknown}} */ (error)?.message;
    return { ok: false, error: String(message ?? error) };
  }
}

/**
 * 进程内缓存一份：同一脚本里十几个 `resolveFfmpeg()` 不该 spawn 十几遍 `-filters`。
 * @param {{repoRoot?: string}} [options]
 */
/** @type {ReturnType<typeof resolveFfmpeg>|null} */
let cached = null;

/**
 * @param {{repoRoot?: string}} [options]
 * @returns {ReturnType<typeof resolveFfmpeg>}
 */
export function ffmpegTools(options = {}) {
  if (cached === null) cached = resolveFfmpeg(options);
  return cached;
}

/**
 * 把解析结果压成一行，写进证据用（不写整条绝对路径：那正是不可移植的那部分）。
 * @param {ReturnType<typeof resolveFfmpeg>} tools
 * @returns {string}
 */
export function describeFfmpegTools(tools) {
  return `${tools.version}（${tools.source}）`;
}

/** @returns {string} */
function stamp() {
  const now = new Date();
  /** @param {number} n @param {number} [w] */
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * 运行目录：`--root` 显式给就用它；否则在系统临时目录里自建一个带时间戳的。
 *
 * **默认值不再指向 `.local-runs/…`**：那份目录一行都没进 git，任何「只在那一个 worktree
 * 里成立」的绿都不算绿。临时目录里的产物同样不进 git，但它**可再生**——脚本自己在里面
 * 建夹具、跑导出。
 *
 * ## 存在即复用（P82 · B-SUB2-R29-042）
 *
 * P81 之前这里无条件 `fs.mkdirSync(dir, {recursive:true})`，于是「我先手动把目录建好再重跑」
 * 这个最自然的降级手段**永远用不上**：目录明明在，脚本还是去调 mkdir，而 mkdir 正是宿主
 * broker 拒的那一步（`CODEBUDDY_BROKER_DENY`，见 docs/HOST-DENY.md）。
 *
 * 现在的口径：
 *
 * - **目录已存在**：直接复用，**一次 mkdir 都不调**（`lastRunDirState().mkdirCalls === 0`）；
 * - **目录不存在、没给 `--root`**：建；失败就抛 `RUN_DIR_UNAVAILABLE`，文案里给出手动命令；
 * - **给了 `--root` 但目录不存在**：**不建**，抛 `RUN_DIR_MISSING`。`--root` 的语义是
 *   「用这个目录」，创建由调用者负责 —— 这一条让「预建 + `--root`」真的能绕开 mkdir。
 *
 * 顺手补一个空 `env.json`：CLI 的 `--env` 会直接读这个文件（读不到就抛），而验收脚本
 * 只是拿它当「运行根」的标记，不需要任何键。
 *
 * @typedef {{dir: string, mode: 'reused'|'created', explicit: boolean, mkdirCalls: number}} RunDirState
 */

/** 最近一次 `resolveRunDir` 的现场。排障与 p82 自检读这里。 */
/** @type {RunDirState|null} */
let LAST_RUN_DIR = null;

/** @returns {RunDirState|null} */
export function lastRunDirState() {
  return LAST_RUN_DIR === null ? null : { ...LAST_RUN_DIR };
}

/** @param {string} dir */
function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** @param {string} dir */
function isWritableDirectory(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把「建目录失败」翻成能照着做的话。宿主 broker 拒绝与权限错误给的下一步不一样。
 *
 * @param {unknown} err
 * @param {string} dir
 * @returns {Error & {code: string, dir: string, causeCode: string|null}}
 */
function runDirError(err, dir) {
  const causeCode = /** @type {any} */ (err)?.code ?? null;
  const message = String(/** @type {any} */ (err)?.message ?? err);
  const brokered = causeCode === 'CODEBUDDY_BROKER_DENY' || /Brokered|runtime file rule/i.test(message);
  const hint = brokered
    ? `宿主拒绝了这次 mkdir（不是产品问题，见 docs/HOST-DENY.md）。降级顺序：先 \`mkdir -p ${dir}\` 预建目录，`
      + ` 再带 \`--root ${dir}\` 重跑 —— 目录已存在时本函数不会再调 mkdir。`
    : `可先手动 \`mkdir -p ${dir}\` 预建目录再重跑（或把 --root 指到一个已存在的目录）。`;
  const out = /** @type {Error & {code: string, dir: string, causeCode: string|null}} */ (new Error(
    `RUN_DIR_UNAVAILABLE: 建不出验收运行目录 ${dir}（${causeCode ?? 'UNKNOWN'}）。${hint}`,
  ));
  out.code = 'RUN_DIR_UNAVAILABLE';
  out.dir = dir;
  out.causeCode = causeCode;
  return out;
}

/**
 * 目录在、但不可写：这跟「建不出来」是两件事，给的下一步也不同。
 *
 * @param {string} dir
 * @param {string} [label]
 */
function unwritableError(dir, label = 'run dir') {
  const out = /** @type {Error & {code: string, dir: string}} */ (new Error(
    `RUN_DIR_UNWRITABLE: ${dir} 已存在但不可写（${label}）；换一个目录，或修正权限后重跑。`,
  ));
  out.code = 'RUN_DIR_UNWRITABLE';
  out.dir = dir;
  return out;
}

/**
 * 「存在即复用」的 mkdir：目录已在就不调 `mkdirSync`（这正是 P82 要修的那一步）。
 *
 * `mkdir` 可注入，`scripts/p82-run-dir.mjs` 用计数打桩**证明**复用路径一次都没调。
 *
 * @param {string} dir
 * @param {{label?: string, mkdir?: (dir: string, opts: {recursive: true}) => unknown}} [options]
 * @returns {{dir: string, created: boolean, reused: boolean}}
 */
export function ensureDir(dir, options = {}) {
  const target = path.resolve(dir);
  const mkdir = options.mkdir ?? fs.mkdirSync;
  if (isDirectory(target)) {
    if (!isWritableDirectory(target)) throw unwritableError(target, options.label);
    return { dir: target, created: false, reused: true };
  }
  try {
    mkdir(target, { recursive: true });
  } catch (err) {
    throw runDirError(err, target);
  }
  return { dir: target, created: true, reused: false };
}

/**
 * @param {{tag: string, root?: string|null, baseDir?: string, mkdir?: (dir: string, opts: {recursive: true}) => unknown}} options
 * @returns {string} 绝对路径
 */
export function resolveRunDir(options) {
  const tag = String(options.tag ?? 'run').replace(/[^a-zA-Z0-9_-]/g, '');
  const explicit = options.root === undefined || options.root === null ? '' : String(options.root);
  const hasRoot = explicit !== '' && explicit !== 'true';
  const dir = hasRoot
    ? path.resolve(explicit)
    : path.join(options.baseDir ?? path.join(os.tmpdir(), 'opencut-r50'), `${tag}-${stamp()}`);

  /** @type {RunDirState} */
  let state;
  if (isDirectory(dir)) {
    /* 复用：**不调 mkdir**。这是 P82 的核心，改回无条件 mkdir 会让「预建目录」降级失效。 */
    if (!isWritableDirectory(dir)) throw unwritableError(dir, `${tag} run dir`);
    state = { dir, mode: 'reused', explicit: hasRoot, mkdirCalls: 0 };
  } else if (hasRoot) {
    const out = /** @type {Error & {code: string, dir: string}} */ (new Error(
      `RUN_DIR_MISSING: --root 指的目录不存在：${dir}。--root 的语义是「用这个目录」，`
      + `本函数不会替你创建；先 \`mkdir -p ${dir}\` 预建目录再重跑。`,
    ));
    out.code = 'RUN_DIR_MISSING';
    out.dir = dir;
    throw out;
  } else {
    const made = ensureDir(dir, { label: `${tag} run dir`, mkdir: options.mkdir });
    state = { dir, mode: 'created', explicit: false, mkdirCalls: made.created ? 1 : 0 };
  }

  const envFile = path.join(dir, 'env.json');
  if (!fs.existsSync(envFile)) fs.writeFileSync(envFile, '{}\n', 'utf8');
  LAST_RUN_DIR = state;
  return dir;
}
