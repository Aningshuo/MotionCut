#!/usr/bin/env node
// @ts-nocheck —— 打包脚本以真实文件系统/签名工具为准；产品模块仍由 tsc 严格检查。
/**
 * `pnpm build:desktop` → `build/MotionCut.app`（M48）。
 *
 * ## 为什么是手工组装
 *
 * 本轮零新增依赖：不装 electron-builder / @electron/asar。Electron 官方支持
 * `Contents/Resources/app` **目录**（不一定要 asar），所以「复制 Electron.app → 换 plist →
 * 塞 app 目录 → 塞 ffmpeg → ad-hoc 签名」就够了。这套流程的代价是要自己保证：
 *
 * 1. `CFBundleExecutable` 与 `Contents/MacOS/<名字>` 必须一致（否则双击打不开）；
 * 2. `Resources/app` 里的目录结构与仓库**同形**——`apps/desktop/src/main.mjs` 用
 *    `resolve(here,'..','..','..')` 找仓库根，`studio.mjs` 用相对路径找 Studio 服务；
 * 3. ffmpeg/ffprobe 必须**自带依赖**：Homebrew 的 ffmpeg 是动态链接（441KB，依赖
 *    `/opt/homebrew/Cellar/...`），直接拷进包在干净机器上必挂。这里按 `otool -L` 把
 *    非系统 dylib 一起收进 `bin/lib` 并用 `install_name_tool` 改成 `@loader_path/lib`；
 * 4. 找不到 ffmpeg 就**失败**，不静默产出一个「能开不能导」的包。
 *
 * ## 分层
 *
 * - `resolveTool`：找 ffmpeg/ffprobe（`OPENCUT_FFMPEG`/`OPENCUT_FFPROBE` → 同目录 → PATH）
 * - `bundleDylibs`：把动态依赖收进包（静态构建什么也不做）
 * - `copyAppTree`：仓库 → `Resources/app`（白名单，不拷 node_modules）
 * - `main`：构建 UI → 复制 Electron.app → 改 plist/可执行名 → 塞 app → 塞 bin → 签名 → 写报告
 *
 * 运行：
 *   OPENCUT_FFMPEG=<静态 ffmpeg> OPENCUT_FFPROBE=<ffprobe> node scripts/package-desktop.mjs
 * 或（本机，动态 ffprobe 会被自动收依赖）：
 *   node scripts/package-desktop.mjs
 *
 * ## M82 · `--mac-arm64` / `--mac-x64`：交付产物（app + dmg）
 *
 * macOS 发布包走同一条组装流水线，按架构分开：
 *   dist/mac-<arch>/MotionCut.app
 *   dist/MotionCut-<version>-<arch>.dmg   （hdiutil UDZO，挂载后里面是 .app + Applications 链接）
 *
 * 额外硬判据（普通 `build:desktop` 不受影响）：
 * - 选中的 ffmpeg **必须带 `subtitles` 滤镜**（libass），否则字幕烧录在包里直接不可用；
 *   本机 Homebrew 8.1.2 没有这个滤镜，所以会自动落到仓库 R21 那份（`repo:R21`，记 sha256）。
 * - Intel 发布包须用原生 x64 macOS，安装 x64 Electron 和 Playwright 浏览器，并通过
 *   OPENCUT_FFMPEG / OPENCUT_FFPROBE 指定自行构建的 x64 工具。
 * - 签名仍是 ad-hoc（`codesign --force --deep --sign -`），不申请证书、不公证。
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { diffWhitelist } from './lib/package-import-scan.mjs';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ensureDir } from './lib/resolve-ffmpeg.mjs';
import { fileURLToPath } from 'node:url';

import { APP_ID, APP_NAME, APP_PACKAGE_NAME } from '../apps/desktop/src/identity.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(REPO, 'build');
const DIST = join(REPO, 'dist');
const args = process.argv.slice(2);
const releaseArch = args.includes('--mac-x64') ? 'x64' : args.includes('--mac-arm64') ? 'arm64' : undefined;
/** 默认落 `build/MotionCut.app`，发布包落在 `dist/mac-<arch>/MotionCut.app`。 */
let APP = join(BUILD, `${APP_NAME}.app`);
const ELECTRON_APP = join(REPO, 'node_modules', 'electron', 'dist', 'Electron.app');
const ELECTRON_VERSION_FILE = join(REPO, 'node_modules', 'electron', 'dist', 'version');

/**
 * app 里要带的仓库目录（与 `Resources/app` 同形；顺序即报告里的顺序）。
 *
 * **加包必须同步这里**：M93 把 `packages/scene-gen` 加进产品，`provider-mock` 直接
 * `import '../scene-gen/index.mjs'`，白名单没跟着改 → 打出来的 App 一启动
 * `ERR_MODULE_NOT_FOUND`。现在 `main()` 会先跑 `diffWhitelist`（本目录 vs 真实 import），
 * 差集非空直接**构建失败**，不再靠人眼看。
 */
export const APP_TREES = [
  'apps/desktop/src',
  'packages/studio/server',
  'packages/studio/ui/dist',
  /* R30-057/M107A：`packages/studio/server/clock.mjs` 是**运行时 re-export**——
     `export { createPlaybackClock, … } from '../ui/src/player/clock.mjs'`。
     只打 `ui/dist` 的话，这一句在包里指向一个不存在的文件（`ERR_MODULE_NOT_FOUND`），
     而启动路径不 import 它，所以「能开」掩盖了「一用就炸」。整个目录 28KB，直接带上。 */
  'packages/studio/ui/src/player',
  'packages/film-core',
  'packages/layers',
  'packages/render',
  'packages/cli',
  'packages/scene-runtime',
  'packages/scene-gen',
  'packages/motion',
  'packages/agents',
  'packages/providers',
  'packages/mcp',
  'contracts',
  /* R30-057/M107A：`scripts/` 必须随包走。
     应用里的 `scripts/` 不是「测试脚本」——`apps/desktop` 与 `packages/cli` 会按相对路径
     调它（`main.mjs` 用 `resolve(here,'..','..','..')` 找仓库根，再从那里进 `scripts/…`）。
     之前白名单漏了它，打出来的 App 里 `Resources/app` 只有 apps/packages/contracts 三项，
     与注释里承诺的「同形」不符（279 个文件 / 6.1MB）。
     放在 `contracts` 之后：目录顺序只是可读性，打包按条目逐个 ditto。 */
  'scripts',
  /* R30-129：page 层取帧要走 `import('playwright')`（`render/stage-capture.mjs`）。
     以前 `node_modules` 一个都不带，源码树里能导、打出来的包里必然
     `Cannot find package 'playwright'` → 任何含 page 层的导出都 STAGE_BOOT_FAILED。
     只带这两个包：playwright-core 无运行时依赖，浏览器另走 `playwright-browsers/`。 */
  'node_modules/@agentclientprotocol/codex-acp',
  'node_modules/playwright',
  'node_modules/playwright-core',
];

/** 报告里「至少几个文件」的期望（A1 的硬数字）。 */
/** @type {Record<string, number>} */
const MIN_FILES = {
  'packages/studio/ui/dist': 3,
  'packages/render': 20,
};

function log(line) {
  process.stdout.write(`[package] ${line}\n`);
}

/** @param {string} file */
function sha256Of(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * 递归统计文件数与字节数。
 * 符号链接按「链接本身」算 0 字节，但**不跟随**（Electron Framework 里有大量指向
 * Versions/Current 的链接，跟随会重复计数）。
 * @param {string} dir
 * @returns {{files: number, bytes: number}}
 */
function countTree(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        files += 1;
        continue;
      }
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      files += 1;
      try {
        bytes += statSync(full).size;
      } catch {
        // 统计失败不改变文件数；报告里宁可少算也不炸
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

/** `plutil -replace k -string v`；失败就把 plutil 原文打出来。 */
function plistSet(plist, key, value) {
  const result = spawnSync('plutil', ['-replace', key, '-string', value, plist], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`plutil -replace ${key} 失败：${result.stderr || result.stdout}`);
  }
}

/**
 * 读一次 ffmpeg 的身份：版本首行 + 有没有 `subtitles` 滤镜（libass）。
 * @param {string} file
 * @returns {{ok: boolean, version: string, subtitles: boolean, filterLine: string}}
 */
function inspectFfmpeg(file) {
  const version = spawnSync(file, ['-hide_banner', '-version'], { encoding: 'utf8' });
  const filters = spawnSync(file, ['-hide_banner', '-filters'], { encoding: 'utf8' });
  const text = String(filters.stdout ?? '');
  const line = /^\s*\S+\s+subtitles\s+\S+\s+.*$/m.exec(text)?.[0] ?? '';
  return {
    ok: version.status === 0 && filters.status === 0,
    version: String(version.stdout ?? '').split('\n')[0] ?? '',
    subtitles: line !== '' && /libass/i.test(line),
    filterLine: line.trim(),
  };
}

/**
 * 找 ffmpeg/ffprobe。
 *
 * 顺序：显式环境变量 → **仓库内 `resources/bin/ffmpeg`（M83 起）** → PATH。
 * 三者都必须带 `subtitles` 滤镜（libass），一个都没有就抛错——不许静默产出一个
 * 「能剪不能烧字幕」的包，也不许回落到任何开发机的 `.local-runs`。
 *
 * @param {{requireLibass?: boolean, requireExplicit?: boolean}} [options]
 * @returns {{ffmpeg: string, ffprobe: string, source: string, version: string, subtitles: boolean, filterLine: string}}
 */
function resolveTools(options = {}) {
  const requireLibass = options.requireLibass !== false;
  /** @param {string} file */
  const executable = (file) => existsSync(file) && statSync(file).isFile();

  /** @type {Array<{path: string, source: string}>} */
  const candidates = [];
  const envFfmpeg = process.env.OPENCUT_FFMPEG ?? '';
  if (envFfmpeg !== '' && executable(envFfmpeg)) candidates.push({ path: resolve(envFfmpeg), source: 'OPENCUT_FFMPEG' });
  const envFfprobe = process.env.OPENCUT_FFPROBE ?? '';
  if (options.requireExplicit === true) {
    if (!isAbsolute(envFfmpeg) || !executable(envFfmpeg) || !isAbsolute(envFfprobe) || !executable(envFfprobe)) {
      throw new Error('Intel 发布包要求 OPENCUT_FFMPEG 和 OPENCUT_FFPROBE 指向自行构建的 x64 绝对路径。');
    }
  } else {
    const bundled = join(REPO, 'resources', 'bin', 'ffmpeg');
    if (executable(bundled)) candidates.push({ path: bundled, source: 'resources/bin' });
    const found = spawnSync('which', ['ffmpeg'], { encoding: 'utf8' });
    if (found.status === 0 && found.stdout.trim() !== '') candidates.push({ path: found.stdout.trim(), source: 'PATH' });
  }

  /** @type {{path: string, source: string, info: ReturnType<typeof inspectFfmpeg>} | null} */
  let picked = null;
  /** @type {string[]} */
  const rejected = [];
  for (const candidate of candidates) {
    const info = inspectFfmpeg(candidate.path);
    if (!info.ok) {
      rejected.push(`${candidate.source}(不可执行)`);
      continue;
    }
    if (requireLibass && !info.subtitles) {
      rejected.push(`${candidate.source}(无 subtitles)`);
      continue;
    }
    picked = { ...candidate, info };
    break;
  }
  if (picked === null) {
    throw new Error(
      `找不到${requireLibass ? '带 subtitles 滤镜（libass）的' : ''} ffmpeg：${rejected.length === 0 ? '' : `已排除 ${rejected.join('、')}；`}` +
        '缺 libass ffmpeg，见 resources/bin/README.md（或设 OPENCUT_FFMPEG=<绝对路径>）',
    );
  }

  const ffmpegPath = picked.path;
  let ffprobePath = envFfprobe;
  if (ffprobePath === '' || !executable(ffprobePath)) {
    const sibling = join(dirname(ffmpegPath), 'ffprobe');
    if (executable(sibling)) ffprobePath = sibling;
  }
  if (ffprobePath === '' || !executable(ffprobePath)) {
    // resources/bin 是一对：ffmpeg 走了环境变量时，ffprobe 仍可从仓库里取。
    const bundledProbe = join(REPO, 'resources', 'bin', 'ffprobe');
    if (executable(bundledProbe)) ffprobePath = bundledProbe;
  }
  if (ffprobePath === '' || !executable(ffprobePath)) {
    const probe = spawnSync('which', ['ffprobe'], { encoding: 'utf8' });
    if (probe.status === 0) ffprobePath = probe.stdout.trim();
  }
  if (ffprobePath === '' || !executable(ffprobePath)) {
    throw new Error('找不到 ffprobe：设 OPENCUT_FFPROBE=<绝对路径> 或把它放进 PATH（不许静默跳过）');
  }
  return {
    ffmpeg: ffmpegPath,
    ffprobe: resolve(ffprobePath),
    source: picked.source,
    version: picked.info.version,
    subtitles: picked.info.subtitles,
    filterLine: picked.info.filterLine,
  };
}

/**
 * `otool -L <file>` 的非系统依赖。
 *
 * 只保留 `/opt/...`、`/usr/local/...` 这类第三方路径；`/usr/lib`、`/System` 是系统库，
 * 干净机器上一定有。
 * @param {string} file
 * @returns {string[]}
 */
function thirdPartyDeps(file) {
  const result = spawnSync('otool', ['-L', file], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  return result.stdout
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(' (')[0])
    .filter((dep) => dep.startsWith('/') && !dep.startsWith('/usr/lib/') && !dep.startsWith('/System/'));
}

/**
 * 把二进制 + 它的第三方 dylib 依赖一起装进 `bin/`（**就地自包含**）。
 *
 * 为什么必须做：本机的 `ffprobe` 是 Homebrew 动态链接（依赖 `/opt/homebrew/Cellar/ffmpeg`），
 * 拷进 .app 在这台机器能跑、换一台干净机器就 `dyld: Library not loaded`。收依赖 +
 * `install_name_tool` 改 `@loader_path/lib/...` 之后，包才真的自带。
 *
 * @param {{src: string, name: string, binDir: string}} input
 * @returns {{path: string, bytes: number, sha256: string, bundledLibs: string[], standalone: boolean}}
 */
function bundleBinary(input) {
  const libDir = join(input.binDir, 'lib');
  const dest = join(input.binDir, input.name);
  cpSync(input.src, dest);
  chmodSync(dest, 0o755);

  /** 已经收过的 dylib（按**原始路径**去重，符号链接跟随一次）。 */
  const seen = new Map();
  /** @type {string[]} */
  const bundled = [];

  const collect = (/** @type {string} */ binary, /** @type {boolean} */ isRoot) => {
    const deps = thirdPartyDeps(binary);
    /** @type {string[]} */
    const rewrites = [];
    for (const dep of deps) {
      if (!existsSync(dep)) continue;
      // 依赖路径可能是符号链接（Homebrew 的 `libssl.3.dylib -> ...`），也可能就是文件：
      // 只有 lstat 说它是链接时才 readlink（否则 readlink 直接 EINVAL）。
      let target = dep;
      try {
        if (lstatSync(dep).isSymbolicLink()) {
          const link = readlinkSync(dep);
          const real = link.startsWith('/') ? link : resolve(dirname(dep), link);
          if (existsSync(real)) target = real;
        }
      } catch {
        target = dep;
      }
      const name = basename(dep);
      if (!seen.has(dep)) {
        seen.set(dep, name);
        ensureDir(libDir, { label: 'package lib' });
        cpSync(target, join(libDir, name));
        chmodSync(join(libDir, name), 0o755);
        bundled.push(name);
        // dylib 自己的依赖也要改写（它们通常同目录互相引用）。
        collect(join(libDir, name), false);
        spawnSync('install_name_tool', ['-id', `@loader_path/${name}`, join(libDir, name)]);
      }
      rewrites.push([dep, `@loader_path/${isRoot ? 'lib/' : ''}${name}`]);
    }
    for (const [from, to] of rewrites) {
      const fix = spawnSync('install_name_tool', ['-change', from, to, binary], { encoding: 'utf8' });
      if (fix.status !== 0) {
        throw new Error(`install_name_tool 失败（${basename(binary)} ← ${from}）：${fix.stderr || fix.stdout}`);
      }
    }
  };

  collect(dest, true);
  return {
    path: dest,
    bytes: statSync(dest).size,
    sha256: sha256Of(dest),
    bundledLibs: bundled,
    standalone: bundled.length === 0,
  };
}

/** 递归复制（保留符号链接；`ditto` 是 macOS 自带，不引入依赖）。 */
function ditto(from, to) {
  const result = spawnSync('ditto', [from, to], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ditto 失败 ${from} → ${to}: ${result.stderr}`);
}


function requireIntelMachO(filename, label) {
  const result = spawnSync('lipo', [filename, '-verify_arch', 'x86_64'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${label} 缺少 x86_64 架构：${filename}。请在 Intel 环境安装对应的依赖。`);
  }
}

/** Keep test fixtures and workstation configuration out of the Intel release. */
function copyIntelRuntimeTree(source, dest, tree) {
  cpSync(source, dest, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (filename) => {
      const entry = relative(source, filename);
      if (entry === '') return true;
      const parts = entry.split(sep);
      if (tree === 'scripts') {
        return entry === 'lib' || entry === join('lib', 'resolve-ffmpeg.mjs');
      }
      return !parts.some((part) =>
        ['test', 'tests', 'fixtures', '.git', '.local-runs', '.secrets', '.npmrc', '.DS_Store'].includes(part)
        || /^\.env(?:\.|$)/.test(part)
        || /\.(?:test|spec)\.[mc]?[jt]sx?$/.test(part)
        || /\.(?:key|p12|pfx)$/.test(part),
      );
    },
  });
}

/**
 * M82：把已签名的 .app 压成 dmg（UDZO）。挂载后里面是 `MotionCut.app` + `Applications` 链接。
 * 用系统自带 `hdiutil`，不引第三方 dmg 工具。
 *
 * 直接用发布目录作为源，避免复制和清理整份 Electron 应用。
 * @param {string} sourceDir @param {string} outFile @param {string} version
 */
function makeDmg(sourceDir, outFile, version) {
  const link = join(sourceDir, 'Applications');
  if (!existsSync(link)) {
    try {
      symlinkSync('/Applications', link);
    } catch {
      // 链接只是拖拽便利：建不了不影响 dmg 里有没有 .app
    }
  }
  rmSync(outFile, { force: true });
  const result = spawnSync(
    'hdiutil',
    ['create', '-volname', `${APP_NAME} ${version}`, '-srcfolder', sourceDir, '-ov', '-format', 'UDZO', outFile],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`hdiutil create 失败：${result.stderr || result.stdout}`);
  return { path: outFile, bytes: statSync(outFile).size, sha256: sha256Of(outFile) };
}

/** `Resources/app` 的 package.json：Electron 靠它找主进程入口。 */
function writeAppPackageJson(appDir, version) {
  const pkg = {
    name: APP_PACKAGE_NAME,
    productName: APP_NAME,
    version,
    private: true,
    type: 'module',
    main: 'apps/desktop/src/main.mjs',
  };
  writeFileSync(join(appDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}

/**
 * 拿一个空闲端口（绑 0 再关，交给 Electron/Studio 用）。
 * @returns {Promise<number>}
 */
function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.unref();
    server.on('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => done(port));
    });
  });
}

/** 等子进程自己退出（毫秒上限），返回是否已退出。 */
async function waitExit(child, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    await new Promise((done) => globalThis.setTimeout(done, 100));
  }
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * 打包冒烟（R180）：用**刚打出来的这个包**起一次临时 Studio，导 3 秒**含 page 层**的工程。
 *
 * ## 为什么必须在包里导
 *
 * 仓库树能导不代表包里能导：`Resources/app` 只带 `APP_TREES` 里的目录，`node_modules` 一个都不带。
 * page 片段要靠 playwright 取帧（`stage-capture.mjs` 里惰性 `import('playwright')`），
 * 编码要靠 `Contents/Resources/bin/ffmpeg`。这两件事只有真包才验得到 —— 源码树永远是绿的。
 *
 * ## 怎么起
 *
 * 走产品自己的开关：`--opencut-serve`（只起 Studio、不建窗口）+ `--opencut-env-json <path>`
 * （LaunchServices 不传环境变量，端口/临时目录只能走参数）。userData / projectsRoot / 工程
 * 全落 `os.tmpdir()` 下的临时目录，不碰真实 `~/Library/Application Support`。
 *
 * 失败就抛错（顶层 catch → `process.exit(1)`），异常上挂的 `smoke` 会写进 package-report.json。
 *
 * @param {string} appPath 打出来的 .app
 * @param {boolean} cleanPath 在系统 PATH 下验证自带的工具
 * @returns {Promise<any>}
 */
async function runExportSmoke(appPath, cleanPath) {
  const { buildUi1Project } = await import('./lib/ui3-fixture.mjs');
  const sleep = (ms) => new Promise((done) => globalThis.setTimeout(done, ms));
  const work = mkdtempSync(join(tmpdir(), 'opencut-pkg-smoke-'));
  const fixtureFfmpeg = cleanPath ? join(appPath, 'Contents', 'Resources', 'bin', 'ffmpeg') : undefined;
  const fixture = await buildUi1Project(work, fixtureFfmpeg);
  const userData = join(work, 'userData');
  mkdirSync(userData, { recursive: true });
  const studioPort = await freePort();
  const vitePort = await freePort();
  const envPath = join(work, 'env.json');
  writeFileSync(
    envPath,
    `${JSON.stringify({ studioPort, vitePort, userData, projectsRoot: fixture.projectsRoot, studioHome: join(work, 'studioHome') }, null, 2)}\n`,
    'utf8',
  );

  /* 关键：**把 .app 复制到仓库外**再启动。
     原地（`build/MotionCut.app` 在仓库里）时 `import('playwright')` 会沿目录往上走到
     仓库根的 `node_modules`，于是「源树里能导」被误当成「包里能导」——实测原地 PASS、
     搬到仓库外立刻 `STAGE_BOOT_FAILED: Cannot find package 'playwright'`。
     安装位置是 `/Applications`，那里面没有仓库，所以冒烟也必须离开仓库。
     APFS 克隆复制 390MiB 实测 0.6s，成本可以忽略。 */
  const smokeRoot = join(work, 'Applications');
  mkdirSync(smokeRoot, { recursive: true });
  const smokeApp = join(smokeRoot, basename(appPath));
  cpSync(appPath, smokeApp, { recursive: true, verbatimSymlinks: true });
  const bin = join(smokeApp, 'Contents', 'MacOS', APP_NAME);
  const base = `http://127.0.0.1:${studioPort}`;
  /** @type {Record<string, any>} */
  const facts = {
    status: 'FAIL',
    appPath,
    appRelocated: smokeApp,
    bin,
    workDir: work,
    ports: { studioPort, vitePort },
    project: fixture.dir,
    request: { projectId: null, range: { start: 0, end: 3 }, outPath: join(fixture.dir, 'smoke-3s.mp4') },
    fiveTuple: null,
    stage: null,
    error: null,
    series: [],
    logTail: [],
    elapsedMs: 0,
  };
  const fail = (reason, extra = {}) => {
    const error = new Error(`打包冒烟失败：${reason}`);
    Object.assign(error, { smoke: { ...facts, ...extra, reason } });
    return error;
  };
  if (!existsSync(bin)) {
    throw fail('APP_BIN_MISSING');
  }

  /* 冒烟必须自带**干净环境**：宿主若是 Electron 应用（WorkBuddy / VS Code / 任何
     `ELECTRON_RUN_AS_NODE=1` 的终端），这个变量会被继承下去，包里的 Electron 会以
     「node 模式」启动 —— Chromium 的参数直接被 node 拒掉（`bad option: --opencut-serve`，
     exit 9），冒烟变成假红。`NODE_OPTIONS` 同理（宿主注入的 preload 会在包进程里加载）。 */
  const childEnv = { ...process.env, OPENCUT_APP_DATA: join(work, 'appData'), OPENCUT_NO_SANDBOX: '1' };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.NODE_OPTIONS;
  if (cleanPath) {
    childEnv.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    delete childEnv.OPENCUT_FFMPEG;
    delete childEnv.OPENCUT_FFPROBE;
    delete childEnv.PLAYWRIGHT_BROWSERS_PATH;
  }
  const child = spawn(bin, ['--opencut-serve', '--opencut-env-json', envPath], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logText = '';
  const collect = (chunk) => {
    logText += String(chunk);
    if (logText.length > 64 * 1024) logText = logText.slice(-32 * 1024);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      if (!(await waitExit(child, 5000))) child.kill('SIGKILL');
    }
  };

  try {
    /* 1. 等 Studio 起来（app 会 fork 子进程；healthz 才算活） */
    const startedAt = Date.now();
    let healthy = false;
    const deadline = startedAt + 90_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      try {
        const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(800) });
        if (response.ok) {
          healthy = true;
          break;
        }
      } catch {
        /* 还没起来 */
      }
      await sleep(300);
    }
    if (!healthy) {
      facts.elapsedMs = Date.now() - startedAt;
      throw fail(child.exitCode === null ? 'STUDIO_NOT_HEALTHY_90S' : `APP_EXITED code=${String(child.exitCode)}`, {
        logTail: logText.trim().split('\n').slice(-25),
      });
    }

    const post = async (url, body) => {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json().catch(() => null) };
    };

    /* 2. 打开夹具工程（页在 0s 的 card-a 是 page 层） */
    const opened = await post(`${base}/api/projects/open`, { path: fixture.dir });
    const projectId = opened.body?.project?.projectId ?? null;
    if (projectId === null) {
      throw fail('PROJECT_OPEN_FAILED', { httpStatus: opened.status, response: opened.body, logTail: logText.trim().split('\n').slice(-25) });
    }
    facts.request.projectId = projectId;

    /* 3. 导 3 秒：page 层必须走 playwright 取帧 → 包里缺 playwright 会在这里现形 */
    const start = await post(`${base}/api/export`, facts.request);
    if (start.status !== 202) {
      throw fail('EXPORT_REJECTED', { httpStatus: start.status, response: start.body, logTail: logText.trim().split('\n').slice(-25) });
    }
    const id = start.body.job.id;
    let job = start.body.job;
    const exportStarted = Date.now();
    for (let index = 0; index < 600; index += 1) {
      const status = await (await fetch(`${base}/api/export/${id}`)).json();
      job = status?.job ?? job;
      const last = facts.series[facts.series.length - 1];
      if (last === undefined || last.state !== job.state || last.percent !== job.percent) {
        facts.series.push({ ms: Date.now() - exportStarted, state: job.state, percent: job.percent, stage: job.stage ?? null, frames: job.frames ?? null });
      }
      if (['done', 'failed', 'cancelled'].includes(job.state)) break;
      await sleep(200);
    }
    const outPath = facts.request.outPath;
    const bytes = existsSync(outPath) ? statSync(outPath).size : 0;
    facts.fiveTuple = {
      state: job.state,
      /* `percent` 是 0..1（UI 用 ×1000/10 显示）—— 判满用 >=1，别写 >=100。 */
      percent: job.percent,
      bytes,
      frames: job.frames ?? null,
      'error.code': job.error?.code ?? null,
    };
    facts.stage = job.stage ?? null;
    facts.error = job.error ?? null;
    facts.elapsedMs = Date.now() - startedAt;
    facts.logTail = logText.trim().split('\n').slice(-25);
    if (!(job.state === 'done' && job.percent >= 1 && bytes > 0)) {
      throw fail(job.error?.code === undefined || job.error?.code === null ? `EXPORT_${String(job.state).toUpperCase()}` : String(job.error.code));
    }
    if (cleanPath) {
      const bundledBin = join(smokeApp, 'Contents', 'Resources', 'bin');
      const probe = spawnSync(join(bundledBin, 'ffprobe'), [
        '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name', '-of', 'json', outPath,
      ], { encoding: 'utf8', env: childEnv, timeout: 20_000 });
      if (probe.status !== 0) throw fail('PACKAGED_FFPROBE_FAILED', { stderr: probe.stderr });
      const metadata = JSON.parse(probe.stdout);
      const duration = Number(metadata.format?.duration);
      if (!metadata.streams?.some((stream) => stream.codec_type === 'video' && stream.codec_name === 'h264')
        || !metadata.streams?.some((stream) => stream.codec_type === 'audio')
        || !Number.isFinite(duration) || Math.abs(duration - 3) > 0.15) {
        throw fail('EXPORT_PROBE_MISMATCH', { metadata });
      }
      const decode = spawnSync(join(bundledBin, 'ffmpeg'), [
        '-nostdin', '-v', 'error', '-xerror', '-i', outPath, '-f', 'null', '-',
      ], { encoding: 'utf8', env: childEnv, timeout: 20_000 });
      if (decode.status !== 0) throw fail('EXPORT_DECODE_FAILED', { stderr: decode.stderr });
    }
    facts.status = 'PASS';
    rmSync(work, { recursive: true, force: true });
    facts.workDir = '(cleaned)';
    return facts;
  } finally {
    await stop();
  }
}

async function main() {
  const isIntelRelease = releaseArch === 'x64';
  const isRelease = releaseArch !== undefined;
  const target = isRelease ? `mac-${releaseArch}` : 'dev-build';
  if (isIntelRelease) {
    if (args.includes('--mac-arm64')) throw new Error('一次只能选择一个 macOS 发布架构。');
    const translated = process.platform === 'darwin' && process.arch === 'x64'
      ? spawnSync('/usr/sbin/sysctl', ['-in', 'sysctl.proc_translated'], { encoding: 'utf8' }).stdout?.trim()
      : undefined;
    if (process.platform !== 'darwin' || process.arch !== 'x64' || translated === '1') {
      throw new Error('macOS Intel 发布包须在原生 Intel Mac 上使用 x64 Node 构建和验证。');
    }
  }
  /* 0. 先验白名单（M95）：`packages/` 里被 import 的目录，必须都在 APP_TREES 里。
     漏一个 → 打出来的 App 一启动就 ERR_MODULE_NOT_FOUND，而源码树测试永远是绿的。
     这一步放在最前面：**别等 UI 构建完、骨架删完才发现**。 */
  const whitelist = diffWhitelist(REPO, APP_TREES);
  log(
    `白名单自检：imported=${String(whitelist.imported.length)} shipped=${String(whitelist.shipped.length)} ` +
      `missing=${String(whitelist.missing.length)} unused=${String(whitelist.unused.length)} refs=${String(whitelist.refs)}`,
  );
  if (whitelist.missing.length > 0) {
    throw new Error(
      `APP_TREES 漏了被 import 的包：${whitelist.missing.join(', ')}（加到 scripts/package-desktop.mjs 的 APP_TREES）`,
    );
  }

  const rootPkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  const version = typeof rootPkg.version === 'string' && rootPkg.version !== '' ? rootPkg.version : '0.0.0';
  const electronVersion = existsSync(ELECTRON_VERSION_FILE)
    ? readFileSync(ELECTRON_VERSION_FILE, 'utf8').trim()
    : 'unknown';
  const outRoot = isRelease ? join(DIST, target) : BUILD;
  APP = join(outRoot, `${APP_NAME}.app`);

  if (!existsSync(ELECTRON_APP)) {
    throw new Error(`没有 Electron 运行时：${ELECTRON_APP}（先 pnpm install）`);
  }

  const intelTools = isIntelRelease ? resolveTools({ requireExplicit: true }) : null;
  if (intelTools !== null) {
    requireIntelMachO(join(ELECTRON_APP, 'Contents', 'MacOS', 'Electron'), 'Electron');
    requireIntelMachO(intelTools.ffmpeg, 'FFmpeg');
    requireIntelMachO(intelTools.ffprobe, 'ffprobe');
  }
  log('构建 UI（vite build）');
  const ui = spawnSync(
    process.execPath,
    ['node_modules/vite/bin/vite.js', 'build', '--config', 'packages/studio/ui/vite.config.mjs'],
    { cwd: REPO, stdio: 'inherit' },
  );
  if (ui.status !== 0) throw new Error(`UI 构建失败 exit=${String(ui.status)}`);

  ensureDir(outRoot, { label: 'package out' });
  if (isRelease) ensureDir(DIST, { label: 'package dist' });

  /* 复用已有 app 骨架：Electron 那 6000 多个文件不重拷、也不整树删除——
     宿主对「一次删上千个文件」有安全闸（safe-delete），整树删会被直接拒。
     只换会变的叶子：Resources/app（约 280 个文件）、Resources/bin（约 30 个）。 */
  const stamp = join(APP, 'Contents', 'Resources', '.opencut-electron-version');
  const versionStamp = isIntelRelease ? `${electronVersion}-${releaseArch}` : electronVersion;
  const reusable = existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === versionStamp;
  if (reusable) {
    log(`复用已有 app 骨架（Electron ${electronVersion}）：只换 Resources/app、Resources/bin`);
    rmSync(join(APP, 'Contents', 'Resources', 'app'), { recursive: true, force: true });
    rmSync(join(APP, 'Contents', 'Resources', 'bin'), { recursive: true, force: true });
  } else {
    if (existsSync(APP)) {
      // 不删：改名留证据（升级 Electron 属于停止条件，正常不会走到这里）。
      const aside = join(isRelease ? DIST : outRoot, `${basename(APP)}.old-${Date.now()}`);
      renameSync(APP, aside);
      log(`旧 app 改名：${aside}（未删除，人工清理）`);
    }
    log(`复制 Electron.app（${electronVersion}）→ ${APP}`);
    ditto(ELECTRON_APP, APP);
  }

  const plist = join(APP, 'Contents', 'Info.plist');
  plistSet(plist, 'CFBundleName', APP_NAME);
  plistSet(plist, 'CFBundleDisplayName', APP_NAME);
  plistSet(plist, 'CFBundleIdentifier', APP_ID);
  plistSet(plist, 'CFBundleExecutable', APP_NAME);
  plistSet(plist, 'CFBundleShortVersionString', version);
  plistSet(plist, 'CFBundleVersion', version);

  const macosDir = join(APP, 'Contents', 'MacOS');
  const fromExe = join(macosDir, 'Electron');
  const toExe = join(macosDir, APP_NAME);
  if (existsSync(fromExe)) {
    rmSync(toExe, { force: true });
    cpSync(fromExe, toExe);
    chmodSync(toExe, 0o755);
    rmSync(fromExe, { force: true });
  } else if (!existsSync(toExe)) {
    throw new Error(`Electron 可执行文件不存在：${fromExe}（app 骨架不完整）`);
  }
  // 记下骨架版本：下次同版本只换叶子，整树不重拷。
  writeFileSync(stamp, `${versionStamp}\n`, 'utf8');
  log(`可执行文件：Contents/MacOS/${APP_NAME}`);

  const resources = join(APP, 'Contents', 'Resources');
  const appDir = join(resources, 'app');
  ensureDir(appDir, { label: 'package app' });
  writeAppPackageJson(appDir, version);

  /** @type {Record<string, {files: number, bytes: number}>} */
  const files = {};
  for (const relative of APP_TREES) {
    const source = join(REPO, relative);
    if (!existsSync(source)) {
      throw new Error(`缺少要打包的目录：${relative}`);
    }
    const dest = join(appDir, relative);
    ensureDir(dirname(dest), { label: 'package copy' });
    if (isIntelRelease) copyIntelRuntimeTree(realpathSync(source), dest, relative);
    else ditto(realpathSync(source), dest);
    const counted = countTree(dest);
    files[relative] = counted;
    const min = MIN_FILES[relative] ?? 1;
    if (counted.files < min) {
      throw new Error(`${relative} 只有 ${counted.files} 个文件（至少要 ${min}）：UI 没构建或目录不对`);
    }
  }

  if (isIntelRelease) {
    for (const notice of [
      'LICENSE',
      'TRADEMARKS.md',
      'THIRD_PARTY_NOTICES.md',
      'packages/studio/ui/src/assets/INTER-OFL-1.1.txt',
      'packages/studio/ui/src/assets/LUCIDE-LICENSE.txt',
      'packages/studio/ui/src/assets/SIMPLE-ICONS-LICENSE.md',
      'packages/studio/ui/src/assets/editor-icons/LICENSE.txt',
      'packages/studio/ui/src/assets/creation-icons/LICENSE.txt',
    ]) {
      const dest = join(appDir, notice);
      ensureDir(dirname(dest), { label: 'package notices' });
      cpSync(join(REPO, notice), dest);
    }
  }

  /* Playwright 的 npm 包只带协议，不带浏览器。安装到干净机器上时
     `~/Library/Caches/ms-playwright` 是空的 → `chromium.launch()` 仍会失败。
     这里按 playwright-core 自己声明的 revision 把 headless shell 收进包内
     （导出取帧只走 headless；有头模式不属于产品路径），运行时由桌面壳把
     `PLAYWRIGHT_BROWSERS_PATH` 指到 `Resources/app/playwright-browsers`。 */
  const browsersJson = JSON.parse(readFileSync(join(REPO, 'node_modules', 'playwright-core', 'browsers.json'), 'utf8'));
  const shellEntry = (browsersJson.browsers ?? []).find((item) => item?.name === 'chromium-headless-shell');
  if (shellEntry === undefined || shellEntry.revision === undefined) {
    throw new Error('playwright-core/browsers.json 里没有 chromium-headless-shell：无法决定要收哪个浏览器');
  }
  const cacheRoot =
    typeof process.env.PLAYWRIGHT_BROWSERS_PATH === 'string' && process.env.PLAYWRIGHT_BROWSERS_PATH !== ''
      ? process.env.PLAYWRIGHT_BROWSERS_PATH
      : join(homedir(), 'Library', 'Caches', 'ms-playwright');
  const shellName = `chromium_headless_shell-${String(shellEntry.revision)}`;
  const shellSource = join(cacheRoot, shellName);
  if (!existsSync(shellSource)) {
    throw new Error(
      `没有可随包的 ${shellName}：${shellSource}（先跑 npx playwright install chromium-headless-shell）`,
    );
  }
  if (isIntelRelease) {
    requireIntelMachO(join(shellSource, 'chrome-headless-shell-mac-x64', 'chrome-headless-shell'), 'Playwright headless Chromium');
  }
  const browsersDir = join(appDir, 'playwright-browsers');
  ensureDir(browsersDir, { label: 'package playwright browsers' });
  ditto(shellSource, join(browsersDir, shellName));
  const shellTree = countTree(join(browsersDir, shellName));
  files[`playwright-browsers/${shellName}`] = shellTree;
  log(`随包浏览器：${shellName}（${shellTree.files} 个文件，${(shellTree.bytes / 1024 / 1024).toFixed(0)}MiB）`);

  const tools = intelTools ?? resolveTools({ requireLibass: isRelease });
  log(`ffmpeg 源（${tools.source}）：${tools.ffmpeg}`);
  log(`ffmpeg 身份：${tools.version}`);
  log(`subtitles 滤镜（libass）：${tools.subtitles ? '有' : '无'}`);
  log(`ffprobe 源：${tools.ffprobe}`);
  const binDir = join(resources, 'bin');
  ensureDir(binDir, { label: 'package bin' });
  const ffmpeg = bundleBinary({ src: tools.ffmpeg, name: 'ffmpeg', binDir });
  const ffprobe = bundleBinary({ src: tools.ffprobe, name: 'ffprobe', binDir });

  /* M83：`resources/bin` 里可能带一套已经改写好的 dylib（ffprobe 自包含）。
     `bundleBinary` 只收「绝对路径的第三方依赖」，`@loader_path` 的不会自动带——这里补一份。
     已收过的同名文件不覆盖（bundleBinary 的改写结果优先）。 */
  const vendoredLib = join(dirname(tools.ffprobe), 'lib');
  /** @type {string[]} */
  let vendoredLibNames = [];
  if (existsSync(vendoredLib)) {
    vendoredLibNames = readdirSync(vendoredLib);
    ensureDir(join(binDir, 'lib'), { label: 'package bin lib' });
    for (const name of vendoredLibNames) {
      const dest = join(binDir, 'lib', name);
      if (!existsSync(dest)) cpSync(join(vendoredLib, name), dest);
    }
  }
  log(
    `随包二进制：ffmpeg ${(ffmpeg.bytes / 1024 / 1024).toFixed(1)}MB（${ffmpeg.standalone ? '静态' : `收 ${ffmpeg.bundledLibs.length} 个 dylib`}）、` +
      `ffprobe ${(ffprobe.bytes / 1024).toFixed(0)}KB（${
        vendoredLibNames.length > 0 ? `随包 ${vendoredLibNames.length} 个 dylib` : ffprobe.standalone ? '静态' : `收 ${ffprobe.bundledLibs.length} 个 dylib`
      }）`,
  );

  /* `codesign --deep` **不会**下到 `Contents/Resources/bin`（它不是 Frameworks/PlugIns 这类
     标准位置）。Apple Silicon 上未签名的 arm64 二进制会被内核直接 SIGKILL（exit 137），
     所以随包二进制与收进来的 dylib 必须**逐个**签，再整体签 app。 */
  log('ad-hoc 签名（随包二进制逐个 + app）');
  const signTargets = [ffmpeg.path, ffprobe.path];
  for (const name of new Set([...ffmpeg.bundledLibs, ...ffprobe.bundledLibs])) {
    const libFile = join(binDir, 'lib', name);
    if (existsSync(libFile)) signTargets.push(libFile);
  }
  // 入库的那套 dylib 不在 bundledLibs 里（依赖是 @loader_path），但一样要逐个签。
  if (existsSync(join(binDir, 'lib'))) {
    for (const name of readdirSync(join(binDir, 'lib'))) signTargets.push(join(binDir, 'lib', name));
  }
  for (const target of new Set(signTargets)) {
    const one = spawnSync('codesign', ['--force', '--sign', '-', target], { encoding: 'utf8' });
    if (one.status !== 0) {
      throw new Error(`codesign 失败（${target}）：\n${one.stdout}\n${one.stderr}`);
    }
  }

  const signed = spawnSync('codesign', ['--force', '--deep', '--sign', '-', APP], { encoding: 'utf8' });
  if (signed.status !== 0) {
    throw new Error(`codesign 失败：\n${signed.stdout}\n${signed.stderr}`);
  }

  if (isIntelRelease) {
    const verified = spawnSync('codesign', ['--verify', '--deep', '--strict', APP], { encoding: 'utf8' });
    if (verified.status !== 0) throw new Error(`安装包签名验证失败：${verified.stderr || verified.error}`);
  }

  /* M82：交付形态多一个 dmg（同一份已签名 .app 压进去，不重新签名）。 */
  const priorRelease = join(outRoot, 'Opencut Studio.app');
  if (isRelease && existsSync(priorRelease)) {
    const aside = join(DIST, `${basename(priorRelease)}.old-${Date.now()}`);
    renameSync(priorRelease, aside);
    log(`旧品牌发布包保留在：${aside}`);
  }
  const dmgPath = isRelease ? join(DIST, `${APP_NAME}-${version}-${releaseArch}.dmg`) : null;
  const dmg = dmgPath !== null && !isIntelRelease ? makeDmg(outRoot, dmgPath, version) : null;
  if (dmg !== null) log(`dmg：${dmg.path}（${(dmg.bytes / 1024 / 1024).toFixed(1)}MiB）`);

  const binTree = countTree(binDir);
  files['bin/ffmpeg'] = { files: 1, bytes: ffmpeg.bytes };
  files['bin/ffprobe'] = { files: 1, bytes: ffprobe.bytes };
  if (binTree.files > 2) {
    files['bin/lib'] = { files: binTree.files - 2, bytes: binTree.bytes - ffmpeg.bytes - ffprobe.bytes };
  }

  const whole = countTree(APP);
  const report = {
    product: APP_NAME,
    version,
    electron: electronVersion,
    target,
    arch: releaseArch ?? process.arch,
    appPath: APP,
    files,
    /* M95：这次打包用的白名单，以及「被 import 的 packages 目录 vs 白名单」的差集。
       差集非空时根本走不到这里（main() 开头就失败），所以 missing 恒为 []——写进报告
       是为了让闸门能拿产物自证，而不是信脚本的沉默。 */
    whitelist: {
      appTrees: [...APP_TREES],
      imported: whitelist.imported,
      shipped: whitelist.shipped,
      missing: whitelist.missing,
      unused: whitelist.unused,
      refs: whitelist.refs,
      scannedFiles: whitelist.scannedFiles,
    },
    totalFiles: whole.files,
    totalBytes: whole.bytes,
    totalMiB: Number((whole.bytes / 1024 / 1024).toFixed(1)),
    playwright: {
      package: 'playwright + playwright-core',
      browser: shellName,
      browserPath: `Resources/app/playwright-browsers/${shellName}`,
      browserFiles: shellTree.files,
      browserMiB: Number((shellTree.bytes / 1024 / 1024).toFixed(1)),
    },
    ffmpeg: {
      source: tools.source,
      sourcePath: tools.ffmpeg,
      sourceSha256: sha256Of(tools.ffmpeg),
      version: tools.version,
      subtitles: tools.subtitles,
      filterLine: tools.filterLine,
      ...ffmpeg,
    },
    ffprobe: { ...ffprobe, vendoredLibs: vendoredLibNames.length },
    signed: true,
    signature: 'adhoc',
    notarized: false,
    dmg,
    asar: false,
    builtAt: new Date().toISOString(),
  };
  /** 按架构分别记录报告，发布卷只保留 .app 和 Applications 链接。 */
  const reportPath = isRelease
    ? join(DIST, isIntelRelease ? 'package-report-x64.json' : 'package-report.json')
    : join(BUILD, 'package-report.json');
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  /* 2026-R180：打包的最后一步是**冒烟** —— 用这个包起一次临时 Studio，导 3 秒含 page 层。
     导不出来就 exit 1：宁可不产包，也不产一个「能开不能导」的包。 */
  log(`冒烟：用 ${APP} 起临时 Studio 导 3 秒含 page 层…`);
  try {
    report.smoke = await runExportSmoke(APP, isIntelRelease);
    if (isIntelRelease) {
      report.dmg = makeDmg(outRoot, dmgPath, version);
      log(`dmg：${report.dmg.path}（${(report.dmg.bytes / 1024 / 1024).toFixed(1)}MiB）`);
    }
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    log(
      `冒烟 PASS：state=${String(report.smoke.fiveTuple.state)} percent=${String(report.smoke.fiveTuple.percent)} ` +
        `bytes=${String(report.smoke.fiveTuple.bytes)} frames=${String(report.smoke.fiveTuple.frames)}`,
    );
  } catch (error) {
    report.smoke = /** @type {any} */ (error)?.smoke ?? { status: 'FAIL', message: String(/** @type {Error} */ (error)?.message ?? error) };
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    log(`冒烟 FAILED：${String(/** @type {Error} */ (error)?.message ?? error)}`);
    throw error;
  }

  log(`完成：${APP}`);
  log(`报告：${reportPath}（${report.totalFiles} 个文件，${report.totalMiB}MiB）`);
  if (report.totalBytes > 400 * 1024 * 1024) {
    log(`WARN app 体积 ${report.totalMiB}MiB 超过 400MiB 预算`);
  }
}

/* 只有被直接执行时才跑；作为模块 import（闸门要读 `APP_TREES` 求差集）时什么都不做。 */
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`[package] FAILED ${String(/** @type {Error} */ (error)?.message ?? error)}\n`);
    process.exit(1);
  }
}
