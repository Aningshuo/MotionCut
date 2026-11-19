import { spawnSync } from 'node:child_process';
import {
  closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP_NAME, APP_PACKAGE_NAME } from '../../apps/desktop/src/identity.mjs';
import { APP_TREES } from '../package-desktop.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dist = join(root, 'dist');
const require = createRequire(import.meta.url);
/** @param {string} file */
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** @param {string} path */
function requireFile(path) {
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) {
    throw new Error('Missing required file: ' + path);
  }
  return path;
}

/** @param {string} name */
function explicitPath(name) {
  const path = process.env[name];
  if (!path || !isAbsolute(path)) throw new Error(name + ' must be set to an absolute path.');
  return path;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {Omit<import('node:child_process').SpawnSyncOptionsWithStringEncoding, 'encoding'>} [options]
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 180_000, ...options });
  if (result.error || result.status !== 0) {
    throw new Error([basename(command) + ' failed', result.error?.message, result.stderr, result.stdout]
      .filter(Boolean).join('\n'));
  }
  return result.stdout + result.stderr;
}

/** @param {string} path */
function requireX64Pe(path) {
  requireFile(path);
  const fd = openSync(path, 'r');
  try {
    const dos = Buffer.alloc(64);
    const pe = Buffer.alloc(6);
    const valid = readSync(fd, dos, 0, dos.length, 0) === dos.length && dos.readUInt16LE(0) === 0x5a4d
      && readSync(fd, pe, 0, pe.length, dos.readUInt32LE(0x3c)) === pe.length
      && pe.readUInt32LE(0) === 0x4550 && pe.readUInt16LE(4) === 0x8664;
    if (!valid) throw new Error('Expected an x64 Windows executable: ' + path);
  } finally {
    closeSync(fd);
  }
}

/** @param {string} source @param {string} dest */
function copyRuntime(source, dest) {
  cpSync(source, dest, {
    recursive: true,
    filter: (path) => {
      const entry = relative(source, path);
      return entry === '' || !entry.split(sep).some((part) => (
        ['test', 'tests', 'fixtures', '.git', '.local-runs', '.secrets', '.npmrc', '.DS_Store'].includes(part)
        || /^\.env(?:\.|$)/.test(part)
        || /\.(?:test|spec)\.[mc]?[jt]sx?$/.test(part)
        || /\.(?:key|p12|pfx)$/.test(part)
      ));
    },
  });
}

/** @param {string} bin @param {string} app */
function bundleMedia(bin, app) {
  mkdirSync(bin, { recursive: true });
  const inputs = { OPENCUT_FFMPEG: 'ffmpeg.exe', OPENCUT_FFPROBE: 'ffprobe.exe' };
  for (const [key, name] of Object.entries(inputs)) {
    const source = explicitPath(key);
    requireX64Pe(source);
    cpSync(source, join(bin, name));
  }

  // Test the copied tools without MSYS2, a compiler, or a system media installation on PATH.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error('SystemRoot is unavailable.');
  env.Path = join(systemRoot, 'System32');
  const options = { cwd: bin, env };
  const ffmpeg = join(bin, 'ffmpeg.exe');
  const ffprobe = join(bin, 'ffprobe.exe');
  /** @param {string} output */
  const version = (output) => /^(?:ffmpeg|ffprobe) version (\S+)/m.exec(output)?.[1];
  const ffmpegVersion = version(run(ffmpeg, ['-version'], options));
  if (!ffmpegVersion || ffmpegVersion !== version(run(ffprobe, ['-version'], options))) {
    throw new Error('FFmpeg and ffprobe must come from the same build.');
  }

  const build = run(ffmpeg, ['-buildconf'], options);
  if (!build.includes('--enable-gpl') || build.includes('--enable-nonfree')) {
    throw new Error('Expected a redistributable GPL FFmpeg build.');
  }
  const expectedCapabilities = {
    '-filters': ['subtitles'],
    '-decoders': ['png'],
    '-encoders': ['libx264', 'libx265', 'libvpx-vp9', 'libopus', 'prores_ks', 'aac'],
  };
  for (const [list, capabilities] of Object.entries(expectedCapabilities)) {
    const names = new Set(run(ffmpeg, ['-hide_banner', list], options)
      .split('\n').map((line) => line.trim().split(/\s+/)[1]));
    const missing = capabilities.filter((name) => !names.has(name));
    if (missing.length > 0) throw new Error('FFmpeg is missing capabilities: ' + missing.join(', '));
  }

  const mediaNotices = explicitPath('MOTIONCUT_MEDIA_NOTICES');
  requireFile(join(mediaNotices, 'MEDIA-NOTICE.md'));
  requireFile(join(mediaNotices, 'COPYING.GPLv2'));
  copyRuntime(mediaNotices, join(app, 'third-party-media-licenses'));

  const noticePath = join(app, 'THIRD_PARTY_NOTICES.md');
  const notices = readFileSync(noticePath, 'utf8').split('\n')
    .filter((line) => !line.startsWith('- 运行时使用独立安装的 FFmpeg 和 ffprobe'))
    .join('\n').trimEnd();
  writeFileSync(noticePath, notices + '\n- Windows 安装包包含独立运行的 FFmpeg 和 ffprobe。授权声明、版权说明和对应源码见 [第三方媒体工具](third-party-media-licenses/MEDIA-NOTICE.md)。\n');
}

/** @param {string} app */
function bundleBrowser(app) {
  const core = dirname(require.resolve('playwright-core/package.json'));
  /** @type {{browsers: Array<{name: string, revision: string}>}} */
  const registry = readJson(join(core, 'browsers.json'));
  const revision = registry.browsers.find((item) => item.name === 'chromium-headless-shell')?.revision;
  if (!revision) throw new Error('Playwright does not specify a Chromium headless shell revision.');
  const fallback = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ms-playwright');
  const name = 'chromium_headless_shell-' + revision;
  const source = join(process.env.PLAYWRIGHT_BROWSERS_PATH || fallback, name);
  requireX64Pe(join(source, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
  copyRuntime(source, join(app, 'playwright-browsers', name));
}

/** @param {string} payload @param {string} version */
function bundleApp(payload, version) {
  const electron = join(dirname(require.resolve('electron/package.json')), 'dist');
  requireX64Pe(join(electron, 'electron.exe'));
  copyRuntime(electron, payload);
  renameSync(join(payload, 'electron.exe'), join(payload, APP_NAME + '.exe'));
  const wer = join(payload, 'electron_wer.dll');
  if (existsSync(wer)) renameSync(wer, join(payload, APP_NAME + '_wer.dll'));

  const resources = join(payload, 'resources');
  rmSync(join(resources, 'default_app.asar'), { force: true });
  const app = join(resources, 'app');
  requireFile(join(root, 'packages/studio/ui/dist/index.html'));
  for (const path of APP_TREES) {
    if (path !== 'scripts') copyRuntime(join(root, path), join(app, path));
  }
  const helper = 'scripts/lib/resolve-ffmpeg.mjs';
  cpSync(requireFile(join(root, helper)), join(app, helper));
  writeFileSync(join(app, 'package.json'), JSON.stringify({
    name: APP_PACKAGE_NAME, productName: APP_NAME, version, private: true,
    type: 'module', main: 'apps/desktop/src/main.mjs',
  }, null, 2) + '\n');

  for (const notice of [
    'LICENSE', 'TRADEMARKS.md', 'THIRD_PARTY_NOTICES.md',
    'packages/studio/ui/src/assets/INTER-OFL-1.1.txt',
    'packages/studio/ui/src/assets/LUCIDE-LICENSE.txt',
    'packages/studio/ui/src/assets/SIMPLE-ICONS-LICENSE.md',
    'packages/studio/ui/src/assets/editor-icons/LICENSE.txt',
    'packages/studio/ui/src/assets/creation-icons/LICENSE.txt',
  ]) {
    cpSync(requireFile(join(root, notice)), join(app, notice));
  }

  bundleBrowser(app);
  bundleMedia(join(resources, 'bin'), app);
}

/** @param {string} payload @param {string} manifest */
function writeUninstallManifest(payload, manifest) {
  /** @type {string[]} */
  const commands = [];
  /** @param {string} folder */
  function traverse(folder) {
    const names = readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of names) {
      const path = join(folder, entry.name);
      const file = relative(payload, path).replaceAll('$', '$$$$');
      if (entry.isDirectory()) {
        traverse(path);
        commands.push('RMDir "$INSTDIR\\' + file + '"');
      } else {
        commands.push('Delete "$INSTDIR\\' + file + '"');
      }
    }
  }
  // Only remove files shipped in this installer. The chosen folder can also contain personal files.
  traverse(payload);
  writeFileSync(manifest, commands.join('\n') + '\n', 'utf8');
}

function installerCompiler() {
  if (process.env.MOTIONCUT_MAKENSIS) return explicitPath('MOTIONCUT_MAKENSIS');
  const programFiles = process.env['ProgramFiles(x86)'] ?? process.env.ProgramFiles;
  const installed = programFiles && join(programFiles, 'NSIS', 'makensis.exe');
  return installed && existsSync(installed) ? installed : 'makensis.exe';
}

function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('Run Windows packaging with native Windows x64 Node.');
  }
  const { version } = readJson(join(root, 'package.json'));
  const fields = /^(\d+)\.(\d+)\.(\d+)(?:-r(\d+))?$/.exec(version);
  if (!fields || fields.slice(1).filter(Boolean).some((field) => Number(field) > 65535)) {
    throw new Error('MotionCut version cannot be represented in a Windows installer: ' + version);
  }
  const windowsVersion = fields.slice(1).map((field) => Number(field ?? 0)).join('.');
  mkdirSync(dist, { recursive: true });
  const staging = mkdtempSync(join(dist, '.windows-x64-'));
  try {
    const payload = join(staging, 'payload');
    const manifest = join(staging, 'uninstall-files.nsh');
    const installer = join(staging, APP_NAME + '-' + version + '-windows-x64-setup.exe');
    bundleApp(payload, version);
    writeUninstallManifest(payload, manifest);
    const compiler = installerCompiler();
    process.stdout.write(run(compiler, [
      '/V3', '/INPUTCHARSET', 'UTF8', '/DVERSION=' + version, '/DWINDOWS_VERSION=' + windowsVersion,
      '/DPAYLOAD=' + payload, '/DMANIFEST=' + manifest, '/DOUTPUT=' + installer,
      join(root, 'scripts/windows/installer.nsi'),
    ], { timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024 }));
    requireFile(installer);
    const publishedInstaller = join(dist, basename(installer));
    const publishedLayout = join(dist, 'windows-x64');
    rmSync(publishedLayout, { recursive: true, force: true });
    renameSync(payload, publishedLayout);
    renameSync(installer, publishedInstaller);
    console.log('Windows x64 installer: ' + publishedInstaller);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
