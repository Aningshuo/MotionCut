/**
 * Electron 主进程（最小壳，单窗口）。
 *
 * 进程模型：Studio 用 `child_process.fork` 起独立 OS 进程。
 * 理由：utilityProcess 只能在 Electron 运行时里用，跑不了 `node studio.mjs` 的独立自测；
 * fork 出的子进程有真实 pid、可被 ps 观察、退出时只 kill 自己这一棵，满足「退出只清自己的进程」。
 *
 * 安全边界：contextIsolation + sandbox + 无 nodeIntegration；preload 只暴露具名方法。
 */

import { fork } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createViewManager, resolveProjectTab } from './views.mjs';
import { APP_ID, APP_NAME, APP_USER_DATA_DIRECTORY, LEGACY_APP_NAME, detectLegacyUserData } from './identity.mjs';

// Electron 主进程以 ESM 运行时，官方建议用 createRequire 取内置模块
// （直接 `import { BrowserWindow } from 'electron'` 在部分签名/会话下会解析到 npm 包而不是内置模块）。
const require = createRequire(import.meta.url);
/** @type {typeof import('electron')} */
const electronModule = require('electron');
const { BrowserWindow, WebContentsView, app, dialog, ipcMain, shell } = electronModule;

// 受限/未签名宿主里 Chromium 的 OS 沙箱起不来（sandbox initialization failed: Operation not permitted），
// 只允许显式开关降级；webPreferences.sandbox 仍然为 true，页面仍无 Node 权限。
if (process.env.OPENCUT_NO_SANDBOX === '1') {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu');
  process.stdout.write('MAIN_SANDBOX_DISABLED reason=OPENCUT_NO_SANDBOX 宿主会话限制\n');
}

// HEVC/H.265（手机与大法/佳能 4K 默认编码）在 Chromium 里没有软解，
// 只能走 macOS VideoToolbox 硬解；不显式打开这个特性，<video> 对 HEVC 就是纯黑。
// 注意：同时加 --disable-gpu 会把硬解一并关掉（截图用启动方式除外）。
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');

// 剪辑器的舞台必须在「打开工程 / 拖动播放头 / 切片段」时自动出帧；Chromium 默认的
// 自动播放策略会把带音轨的 <video>.play() 拦成 AbortError（舞台显示 AUTOPLAY_BLOCKED）。
// 这是本机桌面应用、素材由用户自己导入，不存在广告自动播放场景，故放开手势要求。
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (typeof app === 'undefined' || typeof BrowserWindow === 'undefined') {
  // 不假装可用：拿不到 Electron API 就直接失败退出。
  process.stderr.write(
    `MAIN_NO_ELECTRON_API ELECTRON_RUN_AS_NODE=${String(process.env.ELECTRON_RUN_AS_NODE)}\n`,
  );
  process.exit(1);
}

const isPackaged = app.isPackaged === true;

/**
 * 验收/便携开关：把 macOS `appData` 指到临时目录。
 *
 * 必须在 `setName` / `getPath('userData')` 之前；`app.setPath` 要求目录已存在。
 * 不设则完全是系统默认（正常用户路径）。自动化冒烟用它把「旧目录检测」也放进临时目录，
 * 不去读用户真实的 `~/Library/Application Support`。
 */
const appDataOverride = process.env.OPENCUT_APP_DATA;
if (typeof appDataOverride === 'string' && appDataOverride !== '') {
  mkdirSync(appDataOverride, { recursive: true });
  app.setPath('appData', appDataOverride);
  process.stdout.write(`MAIN_APP_DATA ${appDataOverride}\n`);
}

if (isPackaged) {
  app.setName(APP_NAME);
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    version: app.getVersion(),
    copyright: `© ${String(new Date().getFullYear())} ${APP_NAME}`,
  });
  // Windows 的 AppUserModelId 与 bundle id 同一口径；macOS 上是 no-op，调用无害。
  if (typeof app.setAppUserModelId === 'function') app.setAppUserModelId(APP_ID);
}
const packagedUserData = isPackaged ? join(app.getPath('appData'), APP_USER_DATA_DIRECTORY) : undefined;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const STUDIO_ENTRY = join(here, 'studio.mjs');
const PRELOAD = join(here, 'preload.cjs');

/** 命令行开关（Electron 会把它们原样放进 argv）。 */
const ARGV = process.argv.slice(1);
const SELFTEST = ARGV.includes('--opencut-selftest');
/** 验收用的「只起 Studio、不建窗口」模式（A3/A4 要一个活着的端口；selftest 是打完就退）。 */
const SERVE_ONLY = ARGV.includes('--opencut-serve');

/**
 * 打包态冒烟/多实例：`--opencut-env-json <path>`（直起可传；`open --args` 实测不进入 app）。
 *
 * 为什么需要这个开关：LaunchServices（`open`）**不把调用方的环境变量传给 app**，
 * `open --env` 与 `open --args` 在本机实测都进不去，所以打包后想用独立端口/临时目录
 * 直起一次，只能走参数。显式环境变量 `OPENCUT_ENV_JSON` 优先（开发态/CI 仍然是它）。
 */
const envArgIndex = ARGV.indexOf('--opencut-env-json');
const envArgValue = envArgIndex >= 0 && typeof ARGV[envArgIndex + 1] === 'string' ? ARGV[envArgIndex + 1] : '';
// Electron 会把 `--key=value` 收进 Chromium 开关（不一定留在 argv 里），两种写法都认。
const envSwitchValue = typeof app.commandLine?.getSwitchValue === 'function'
  ? String(app.commandLine.getSwitchValue('opencut-env-json') ?? '')
  : '';
const envFromArgv = envSwitchValue !== '' ? envSwitchValue : envArgValue;
if (envFromArgv !== '' && process.env.OPENCUT_ENV_JSON === undefined) {
  process.env.OPENCUT_ENV_JSON = envFromArgv;
}
if (envArgIndex >= 0 && envArgValue === '' && envSwitchValue === '') {
  process.stderr.write('MAIN_ARG_INVALID --opencut-env-json 需要一个 env.json 路径\n');
  app.exit(1);
  throw new Error('--opencut-env-json 缺少路径');
}

/** @typedef {{ studioPort: number, vitePort: number, userData?: string, cdpPort?: number }} MainEnv */

/**
 * 打包态的 env.json：落在 `app.getPath('userData')/env.json`，**首次启动生成**。
 *
 * 打包后没有仓库的 `.local-runs`（也不该有）：端口/工程根/输出根都是这台机器上的
 * 用户数据。已存在就只读、不覆盖用户改过的值（缺字段补默认）。
 * @returns {string}
 */
function ensurePackagedEnvFile() {
  const dir = packagedUserData ?? app.getPath('userData');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'env.json');
  const defaults = {
    line: 'packaged',
    studioPort: 59369,
    vitePort: 59370,
    contentPort: 59378,
    projectsRoot: join(dir, 'projects'),
    outputRoot: join(dir, 'output'),
    note: `${APP_NAME} 打包态首次启动生成；端口与数据目录都在这台机器上`,
  };
  mkdirSync(defaults.projectsRoot, { recursive: true });
  mkdirSync(defaults.outputRoot, { recursive: true });
  /** @type {Record<string, any>} */
  let parsed = {};
  if (existsSync(file)) {
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      // 坏文件不静默吞掉：留个后缀，重写一份能用的（否则每次启动都起不来）。
      const backup = `${file}.bak-${Date.now()}`;
      writeFileSync(backup, readFileSync(file));
      process.stdout.write(`MAIN_ENV_CORRUPT ${file} → ${backup}: ${String(/** @type {Error} */ (error).message)}\n`);
      parsed = {};
    }
  }
  const merged = { ...defaults, ...parsed };
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return file;
}

/** @returns {{ path: string, env: MainEnv }} */
function loadEnv() {
  const envPath =
    process.env.OPENCUT_ENV_JSON ?? (isPackaged ? ensurePackagedEnvFile() : join(repoRoot, '.local-runs', 'main', 'env.json'));
  const raw = readFileSync(envPath, 'utf8');
  const parsed = JSON.parse(raw);
  const studioPort = Number(parsed?.studioPort);
  const vitePort = Number(parsed?.vitePort);
  if (!Number.isInteger(studioPort) || !Number.isInteger(vitePort)) {
    throw new Error(`env.json 缺少合法的 studioPort/vitePort：${envPath}`);
  }
  return {
    path: envPath,
    env: {
      studioPort,
      vitePort,
      userData: typeof parsed?.userData === 'string' ? parsed.userData : undefined,
      cdpPort: Number.isInteger(parsed?.cdpPort) ? Number(parsed.cdpPort) : undefined,
    },
  };
}

/** @param {string} line */
function log(line) {
  process.stdout.write(`${line}\n`);
}

/**
 * env.json 读不到/不是 JSON：**立刻退出并说明**。
 *
 * 以前这里是模块顶层直接 `readFileSync`，文件不存在时抛异常发生在 `app.whenReady()`
 * 注册之前——Electron 不打印任何东西，进程就那样挂着（M48 验收里踩过一次：打包版带了一个
 * 指向不存在文件的 `OPENCUT_ENV_JSON`，A2 白白等了 60s）。失败要能看见。
 */
/** @type {{ path: string, env: MainEnv }} */
let loaded;
try {
  loaded = loadEnv();
} catch (error) {
  process.stderr.write(
    `MAIN_ENV_UNUSABLE ${process.env.OPENCUT_ENV_JSON ?? '(default)'}: ${String(/** @type {Error} */ (error)?.message ?? error)}\n`,
  );
  app.exit(1);
  // app.exit 之后不再往下跑；这行让静态检查也满意。
  throw error;
}
if (loaded.env.userData !== undefined) {
  app.setPath('userData', loaded.env.userData);
} else if (packagedUserData !== undefined) {
  mkdirSync(packagedUserData, { recursive: true });
  app.setPath('userData', packagedUserData);
}

/**
 * B08：旧 userData 目录**只读检测**。
 *
 * 只做一次 `existsSync`：不迁移、不删除、不写入旧目录（也不读里面的文件）。
 * 打包态才提示；开发态没有「旧身份」这回事。
 * @type {{ detected: boolean, path: string, sameAsCurrent: boolean }}
 */
const legacyUserData = isPackaged
  ? detectLegacyUserData({
      appData: app.getPath('appData'),
      userData: app.getPath('userData'),
      exists: existsSync,
    })
  : { detected: false, path: '', sameAsCurrent: false };
if (legacyUserData.detected) {
  log(`MAIN_LEGACY_USERDATA_DETECTED path=${legacyUserData.path} action=read-only migration=none`);
}

// A7 验收要走 CDP 读真窗口：端口取 env.json 的 cdpPort（或 OPENCUT_CDP_PORT），只在显式配置时开。
const cdpPort = Number(process.env.OPENCUT_CDP_PORT ?? loaded.env.cdpPort ?? 0);
if (Number.isInteger(cdpPort) && cdpPort > 0) {
  app.commandLine.appendSwitch('remote-debugging-port', String(cdpPort));
  log(`MAIN_CDP_PORT ${cdpPort}`);
}

const studioOrigin = `http://127.0.0.1:${loaded.env.studioPort}`;

/** @type {import('node:child_process').ChildProcess | null} */
let studioChild = null;
/** @type {import('electron').BrowserWindow | null} */
let mainWindow = null;
/** @type {ReturnType<typeof createViewManager> | null} */
let viewManager = null;
let quitting = false;
let studioHealthy = false;
let childExited = false;

/**
 * 工程视图的顶部留白（M16 起为 0）。
 *
 * 标签栏由**每个 Studio 页面自己画**（渲染层 `tabs.ts`）：视图铺满窗口，谁在最上面谁的
 * 标签栏可见。这样 `page.screenshot()` 拿到的就是用户看到的那一屏，而不是「一条 36px 的栏」。 
 */
const TAB_BAR_HEIGHT = 0;

/**
 * 每工程一个 WebContentsView（M4-A4）：切标签只切可见性，实例不重建。
 * 安全设置与主窗口一致：contextIsolation + sandbox + 无 nodeIntegration。
 * @param {string} projectId
 * @param {string} url
 */
function createProjectView(projectId, url) {
  const window = mainWindow;
  if (window === null) throw new Error('窗口未就绪，无法创建工程视图');
  if (typeof WebContentsView !== 'function') throw new Error('当前 Electron 不支持 WebContentsView');

  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      preload: PRELOAD,
    },
  });
  window.contentView.addChildView(view);

  const syncBounds = () => {
    if (mainWindow === null || mainWindow.isDestroyed()) return;
    const size = mainWindow.getContentSize();
    const width = size[0] ?? 0;
    const height = size[1] ?? 0;
    view.setBounds({ x: 0, y: TAB_BAR_HEIGHT, width, height: Math.max(0, height - TAB_BAR_HEIGHT) });
  };
  syncBounds();
  window.on('resize', syncBounds);

  view.webContents.on('will-navigate', (event, target) => {
    const destination = resolveProjectTab(studioOrigin, { projectId, url: target });
    if (!destination.ok || destination.inert) {
      event.preventDefault();
      log(`VIEW_NAVIGATION_BLOCKED project=${projectId} url=${target}`);
    }
  });
  view.webContents.setWindowOpenHandler(({ url: target }) => {
    log(`VIEW_WINDOW_OPEN_DENIED project=${projectId} url=${target}`);
    return { action: 'deny' };
  });
  void view.webContents.loadURL(url).catch((error) => {
    log(`VIEW_LOAD_FAILED project=${projectId} url=${url} error=${String(/** @type {Error} */ (error).message)}`);
  });

  return {
    show() {
      try {
        view.setVisible(true);
        if (!view.webContents.isDestroyed()) view.webContents.focus();
      } catch {
        // 个别平台没有 setVisible：保持可见即等价于激活。
      }
    },
    hide() {
      try {
        view.setVisible(false);
      } catch {
        // 同上
      }
    },
    destroy() {
      window.removeListener('resize', syncBounds);
      try {
        window.contentView.removeChildView(view);
      } catch {
        // 窗口已销毁
      }
      try {
        view.webContents.close();
      } catch {
        // 已关闭
      }
    },
    /** @param {string} channel @param {unknown} payload */
    send(channel, payload) {
      if (!view.webContents.isDestroyed()) view.webContents.send(channel, payload);
    },
  };
}

function ensureViewManager() {
  if (viewManager !== null) return viewManager;
  viewManager = createViewManager({
    createView: ({ projectId, url }) => createProjectView(projectId, url),
    eventsUrlFor: () => `ws://127.0.0.1:${loaded.env.studioPort}/events`,
    /** @param {any} snapshot */
    onChange: (snapshot) => {
      log(`TABS_STATE ${JSON.stringify(snapshot)}`);
      // 关窗时 closeAll 也会发一次：窗口已经没了就别再往里发（否则主进程未捕获异常）。
      if (mainWindow !== null && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('opencut:tabs-changed', snapshot);
        if (snapshot.active === null) mainWindow.webContents.focus();
      }
      // 标签栏每个页面各画一份：工程视图也要收到同一份快照（M16）。
      viewManager?.broadcastTabs(snapshot);
    },
  });
  return viewManager;
}

/**
 * 传给 Studio 子进程的额外环境（M48）。
 *
 * - `OPENCUT_FFMPEG`：随包 ffmpeg 的**绝对路径**（`Resources/bin/ffmpeg`）。Studio 侧
 *   （`apps/desktop/src/studio.mjs`）会把它所在目录前置到 PATH —— render/cli 都是按
 *   `'ffmpeg'`/`'ffprobe'` 调 PATH 的，不改 packages 就能让导出用随包二进制。
 * - `OPENCUT_SETTINGS`：用户级设置落在 userData 里（M49），不写进工程目录。
 * @returns {Record<string, string>}
 */
function studioExtraEnv() {
  /** @type {Record<string, string>} */
  const extra = {};
  if (isPackaged) {
    const bundledFfmpeg = join(process.resourcesPath, 'bin', 'ffmpeg');
    if (existsSync(bundledFfmpeg)) extra.OPENCUT_FFMPEG = bundledFfmpeg;
    extra.OPENCUT_SETTINGS = join(app.getPath('userData'), 'settings.json');
    /* R30-129：page 层取帧要 playwright 的 Chromium。包内自带的浏览器放在
       `Resources/app/playwright-browsers`，由 studio 子进程的 launch 直接读这个变量；
       不设的话干净机器上会去 ~/Library/Caches 找，找不到就取不了帧。 */
    const bundledBrowsers = join(process.resourcesPath, 'app', 'playwright-browsers');
    if (existsSync(bundledBrowsers)) extra.PLAYWRIGHT_BROWSERS_PATH = bundledBrowsers;
  }
  return extra;
}

function spawnStudio() {
  const child = fork(STUDIO_ENTRY, [], {
    env: { ...process.env, ...studioExtraEnv(), OPENCUT_ENV_JSON: loaded.path },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  studioChild = child;
  log(`STUDIO_SPAWNED pid=${child.pid ?? -1}`);

  child.stdout?.on('data', (chunk) => process.stdout.write(`[studio] ${String(chunk)}`));
  child.stderr?.on('data', (chunk) => process.stderr.write(`[studio] ${String(chunk)}`));

  child.on('exit', (code, signal) => {
    childExited = true;
    studioHealthy = false;
    studioChild = null;
    log(`STUDIO_EXITED code=${String(code)} signal=${String(signal)}`);
    if (quitting) return;
    // 不无限重启：记录并退出非 0（端口被占也走这条路）。
    log(`MAIN_EXIT_ON_STUDIO_LOSS code=${String(code ?? 1)}`);
    app.exit(code === null || code === 0 ? 1 : code);
  });

  return child;
}

/** @param {string} url @param {number} timeoutMs @returns {Promise<{ok: boolean, version?: string, pid?: number}>} */
async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = 'unreachable';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(800) });
      if (response.ok) {
        const body = await response.json();
        if (body?.ok === true) return { ok: true, version: body.version, pid: body.pid };
      }
      last = `http ${response.status}`;
    } catch (error) {
      last = String(/** @type {Error} */ (error).message);
    }
    if (childExited) return { ok: false };
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 100));
  }
  log(`STUDIO_HEALTH_TIMEOUT ${last}`);
  return { ok: false };
}

/** @param {string} target */
function isStudioOrigin(target) {
  try {
    return new URL(target).origin === studioOrigin;
  } catch {
    return false;
  }
}

/** @param {string} message @returns {string} */
function errorPage(message) {
  const html = `<!doctype html><meta charset="utf-8"><title>Studio 不可用</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#0b0b0c;color:#e8e8ea;font:14px -apple-system,system-ui">
<div style="max-width:560px;padding:24px;border:1px solid #7a2f2a;border-radius:12px;background:#150c0b">
<h1 style="font-size:16px;margin:0 0 10px;color:#f07a6a">Studio 未就绪</h1>
<p style="color:#a0a0a6;margin:0">${message.replace(/[<>&]/g, '')}</p>
<p style="color:#6b6b72;margin:12px 0 0">此页面不代表可用状态；请查看主进程日志后重启。</p>
</div></body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    backgroundColor: '#0b0b0c',
    title: APP_NAME,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      preload: PRELOAD,
    },
  });
  mainWindow = window;

  window.once('ready-to-show', () => {
    window.show();
    log('WINDOW_VISIBLE');
  });

  if (isPackaged) {
    // 壳页自己的 <title> 会把窗口标题顶掉（Electron 跟随页面标题），打包态改回来。
    window.webContents.on('did-finish-load', () => {
      void window.webContents.executeJavaScript(`document.title = ${JSON.stringify(APP_NAME)}`).catch(() => {});
    });
  }

  window.on('closed', () => {
    viewManager?.closeAll();
    viewManager = null;
    mainWindow = null;
  });

  // 只允许留在 Studio 自己的 origin；其它一律拒绝（不交给系统浏览器，避免静默离开工程）。
  window.webContents.on('will-navigate', (event, target) => {
    if (!isStudioOrigin(target)) {
      event.preventDefault();
      log(`NAVIGATION_BLOCKED url=${target}`);
    }
  });

  // 新窗口一律 deny；https/http 交给系统浏览器打开。
  window.webContents.setWindowOpenHandler(({ url }) => {
    log(`WINDOW_OPEN_DENIED url=${url}`);
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  if (studioHealthy) {
    // 窗口本体是壳页（标签栏 + 空态）；工程内容在各自的 WebContentsView 里。
    void window.loadURL(`${studioOrigin}/?shell=1`);
  } else {
    void window.loadURL(errorPage('Studio 进程没有通过 /healthz 检查。'));
  }

  return window;
}

ipcMain.handle('opencut:studio-health', async () => {
  try {
    const response = await fetch(`${studioOrigin}/healthz`, {
      signal: AbortSignal.timeout(1500),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return { ok: false, code: 'STUDIO_HTTP', status: response.status };
    const body = await response.json();
    return { ok: body?.ok === true, version: body?.version, pid: body?.pid };
  } catch (error) {
    return { ok: false, code: 'STUDIO_UNREACHABLE', message: String(/** @type {Error} */ (error).message) };
  }
});

ipcMain.handle('opencut:open-project-dialog', async () => {
  /** @type {import('electron').OpenDialogOptions} */
  const options = { title: '打开工程目录', properties: ['openDirectory', 'createDirectory'] };
  const result = mainWindow === null
    ? await dialog.showOpenDialog(options)
    : await dialog.showOpenDialog(mainWindow, options);
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  const [selected] = result.filePaths;
  return { canceled: false, path: selected };
});

// 素材导入（M18）：渲染层要的是**绝对路径**，只有主进程的对话框能可靠地给出。
ipcMain.handle('opencut:pick-media', async () => {
  /** @type {import('electron').OpenDialogOptions} */
  const options = {
    title: '导入素材',
    properties: ['openFile'],
    filters: [
      { name: '媒体', extensions: ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  };
  const result = mainWindow === null || mainWindow.isDestroyed()
    ? await dialog.showOpenDialog(options)
    : await dialog.showOpenDialog(mainWindow, options);
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  return { canceled: false, path: result.filePaths[0] };
});

// 素材重链（M26）：和导入一样，只有主进程的对话框能可靠地给出**绝对路径**。
ipcMain.handle('opencut:pick-relink-file', async () => {
  /** @type {import('electron').OpenDialogOptions} */
  const options = {
    title: '选择用来重链的素材',
    properties: ['openFile'],
    filters: [
      { name: '媒体', extensions: ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  };
  const result = mainWindow === null || mainWindow.isDestroyed()
    ? await dialog.showOpenDialog(options)
    : await dialog.showOpenDialog(mainWindow, options);
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  return { canceled: false, path: result.filePaths[0] };
});

ipcMain.handle('opencut:pick-relink-dir', async () => {
  /** @type {import('electron').OpenDialogOptions} */
  const options = { title: '选择素材目录（批量重链按同名匹配）', properties: ['openDirectory'] };
  const result = mainWindow === null || mainWindow.isDestroyed()
    ? await dialog.showOpenDialog(options)
    : await dialog.showOpenDialog(mainWindow, options);
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  return { canceled: false, path: result.filePaths[0] };
});

// 打包工程（M59）：保存框。默认文件名由渲染层给（工程名-时间戳.zip），这里只补目录与后缀。
ipcMain.handle('opencut:pick-archive-save', async (_event, input) => {
  const raw = typeof input?.name === 'string' ? input.name.trim() : '';
  // 只取文件名部分：渲染层若传了带目录的名字，不能让对话框默认落到意料之外的位置。
  const name = basename(raw === '' ? 'project.zip' : raw);
  /** @type {import('electron').SaveDialogOptions} */
  const options = {
    title: '导出工程包',
    buttonLabel: '导出',
    defaultPath: name.endsWith('.zip') ? name : `${name}.zip`,
    filters: [{ name: `${APP_NAME} 工程包`, extensions: ['zip'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  };
  const result = mainWindow === null || mainWindow.isDestroyed()
    ? await dialog.showSaveDialog(options)
    : await dialog.showSaveDialog(mainWindow, options);
  if (result.canceled || typeof result.filePath !== 'string' || result.filePath === '') return { canceled: true };
  return { canceled: false, path: result.filePath };
});

// 导入工程包（M59）：打开框，只要绝对路径；解包与清单校验都在 Studio 侧做。
ipcMain.handle('opencut:pick-archive-open', async () => {
  /** @type {import('electron').OpenDialogOptions} */
  const options = {
    title: '导入工程包',
    properties: ['openFile'],
    filters: [
      { name: `${APP_NAME} 工程包`, extensions: ['zip'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  };
  const result = mainWindow === null || mainWindow.isDestroyed()
    ? await dialog.showOpenDialog(options)
    : await dialog.showOpenDialog(mainWindow, options);
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  return { canceled: false, path: result.filePaths[0] };
});

// 导出完成后「在文件夹中显示」（M29）：渲染层只给绝对路径，这里校验存在性再交给 shell。
ipcMain.handle('opencut:show-item-in-folder', (_event, input) => {
  const target = typeof input?.path === 'string' ? input.path : '';
  if (target === '' || !isAbsolute(target)) {
    return { ok: false, code: 'INVALID_PATH', message: `需要绝对路径：${target}` };
  }
  const abs = resolve(target);
  if (!existsSync(abs)) {
    // 文件被删/被移走：明确说，不要假装定位成功（也别去 reveal 一个不存在的路径）。
    return { ok: false, code: 'NOT_FOUND', message: `产物不存在了：${abs}` };
  }
  shell.showItemInFolder(abs);
  return { ok: true, path: abs };
});

// —— 多标签（每工程一个视图 + 一条事件订阅；M4） ——

/** @type {Promise<unknown>} */
let tabActions = Promise.resolve();
/**
 * Execute tab actions in request order, even when project lookup takes longer for an earlier request.
 * @template T
 * @param {() => T | Promise<T>} action
 */
function enqueueTabAction(action) {
  const result = tabActions.then(action);
  tabActions = result.catch(() => undefined);
  return result;
}

ipcMain.handle('opencut:tabs-open', (_event, input) => {
  const target = resolveProjectTab(studioOrigin, input);
  if (!target.ok) return target;
  const window = mainWindow;
  return enqueueTabAction(async () => {
    try {
      let project;
      if (!target.inert) {
        const response = await fetch(`${studioOrigin}/api/projects/${encodeURIComponent(target.projectId)}`, {
          signal: AbortSignal.timeout(4000),
        });
        if (response.status === 404) return { ok: false, code: 'FILM_NOT_FOUND', message: '工程未打开' };
        if (!response.ok) return { ok: false, code: 'VIEW_FAILED', message: '无法读取工程信息' };
        const result = await response.json();
        if (result?.ok !== true || result.project?.projectId !== target.projectId) {
          return { ok: false, code: 'VIEW_FAILED', message: '工程信息与工程标识不一致' };
        }
        project = result.project;
      }
      if (window === null || window !== mainWindow || window.isDestroyed()) {
        return { ok: false, code: 'VIEW_FAILED', message: '窗口未就绪' };
      }
      return ensureViewManager().open({
        projectId: target.projectId,
        url: target.url,
        name: typeof project?.name === 'string' ? project.name : undefined,
        path: typeof project?.path === 'string' ? project.path : undefined,
      });
    } catch (error) {
      return { ok: false, code: 'VIEW_FAILED', message: String(/** @type {Error} */ (error).message) };
    }
  });
});

ipcMain.handle('opencut:tabs-activate', (_event, projectId) => {
  if (typeof projectId !== 'string' || projectId === '') return { ok: false, code: 'INVALID' };
  return enqueueTabAction(() => ensureViewManager().activate(projectId));
});

ipcMain.handle('opencut:tabs-close', (_event, projectId) => {
  if (typeof projectId !== 'string' || projectId === '') return { ok: false, code: 'INVALID' };
  return enqueueTabAction(() => ensureViewManager().close(projectId));
});

ipcMain.handle('opencut:tabs-home', () => enqueueTabAction(() => ensureViewManager().home()));
ipcMain.handle('opencut:tabs-list', () => ensureViewManager().snapshot());

// 验收/脚本会 SIGTERM 主进程（`open` 与 `--opencut-serve` 都靠它收尾）：走正常 quit，
// 这样 `will-quit` 一定会杀掉 Studio 子进程，不留孤儿。
process.on('SIGTERM', () => {
  log('MAIN_SIGTERM');
  app.quit();
});
process.on('SIGINT', () => {
  log('MAIN_SIGINT');
  app.quit();
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', () => {
  quitting = true;
  const child = studioChild;
  if (child === null || child.pid === undefined) return;
  log(`STUDIO_KILL pid=${child.pid}`);
  child.kill('SIGTERM');
  const force = setTimeout(() => {
    if (!childExited) {
      log(`STUDIO_KILL_FORCE pid=${child.pid}`);
      child.kill('SIGKILL');
    }
  }, 2000);
  force.unref();
});

/**
 * 无窗口模式：`--opencut-selftest`（打完就退）与 `--opencut-serve`（保持运行，验收用）。
 *
 * selftest 的输出是**一行 JSON**（任务书 3.3 A2 要的就是它）：`{"ok":true,"port":…,
 * "ui":"dist","ffmpeg":"…"}`；失败打 `{"ok":false,"reason":…}` 并 exit 1。
 * `ui` 取自 `GET /` 的 `x-opencut-ui` 响应头（`dist` = 打进了构建产物；`fallback` = 只有
 * 状态页，说明 UI 没构建）。
 */
async function runHeadless() {
  const startedAt = Date.now();
  spawnStudio();
  const health = await waitForHealth(studioOrigin, SELFTEST ? 15000 : 8000);
  /** @type {{ok: true, port: number, ui: string, ffmpeg: string, env: string, userData: string, packaged: boolean, elapsedMs: number}} */
  const line = {
    ok: true,
    port: loaded.env.studioPort,
    // 自检自己的「多久起来」（不含进程启动/签名校验）：A2 的 15s 判的是这个数。
    elapsedMs: Date.now() - startedAt,
    ui: 'unknown',
    ffmpeg: process.env.OPENCUT_FFMPEG ?? (isPackaged ? join(process.resourcesPath, 'bin', 'ffmpeg') : ''),
    env: loaded.path,
    userData: app.getPath('userData'),
    packaged: isPackaged,
  };
  if (!health.ok) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: 'studio health timeout', port: line.port })}\n`);
    app.exit(1);
    return;
  }
  try {
    const response = await fetch(`${studioOrigin}/`, { signal: AbortSignal.timeout(2000) });
    line.ui = response.headers.get('x-opencut-ui') ?? 'unknown';
  } catch (error) {
    line.ui = `unreachable:${String(/** @type {Error} */ (error)?.message ?? error)}`;
  }
  studioHealthy = true;
  log(`STUDIO_HEALTH_OK pid=${String(health.pid)}`);
  process.stdout.write(`${JSON.stringify(line)}\n`);
  if (SERVE_ONLY) {
    log('MAIN_SERVE_ONLY 保持运行（不建窗口）');
    return;
  }
  const child = studioChild;
  if (child !== null && child.pid !== undefined) {
    child.kill('SIGTERM');
    await new Promise((done) => {
      const timer = setTimeout(done, 2500);
      child.once('exit', () => {
        clearTimeout(timer);
        done(undefined);
      });
    });
  }
  app.exit(0);
}

/**
 * 旧 userData 提示（B08）。
 *
 * 只说明「检测到 + 没动它」，**不提供一键迁移**：迁移要读旧目录、写新目录，
 * 那是另一批的事（任务书明确：不迁移、不删除、不写入）。
 * 自动化冒烟用 `OPENCUT_NO_LEGACY_NOTICE=1` 抑制弹窗（日志仍然会打）。
 * @param {string} legacyPath
 */
function showLegacyUserDataNotice(legacyPath) {
  if (process.env.OPENCUT_NO_LEGACY_NOTICE === '1') {
    log('MAIN_LEGACY_NOTICE_SUPPRESSED reason=OPENCUT_NO_LEGACY_NOTICE');
    return;
  }
  /** @type {import('electron').MessageBoxOptions} */
  const options = {
    type: 'info',
    title: `${APP_NAME}：检测到旧版用户数据`,
    message: `检测到旧版 ${LEGACY_APP_NAME} 的用户数据目录。`,
    detail:
      `旧目录：${legacyPath}\n` +
      `本次使用：${app.getPath('userData')}\n\n` +
      '本次只做了存在性检测：没有迁移、没有删除、没有写入旧目录。\n' +
      '如需继续使用旧工程，请手动把工程复制到新目录；本应用不会代做。',
    buttons: ['知道了'],
    defaultId: 0,
    noLink: true,
  };
  const shown = mainWindow === null ? dialog.showMessageBox(options) : dialog.showMessageBox(mainWindow, options);
  void shown.catch((error) => log(`MAIN_LEGACY_NOTICE_FAILED ${String(/** @type {any} */ (error)?.message ?? error)}`));
}

app.whenReady().then(async () => {
  log('MAIN_READY');
  if (SELFTEST || SERVE_ONLY) {
    await runHeadless();
    return;
  }
  spawnStudio();
  const health = await waitForHealth(studioOrigin, 8000);
  studioHealthy = health.ok;
  log(studioHealthy ? `STUDIO_HEALTH_OK pid=${String(health.pid)}` : 'STUDIO_HEALTH_FAILED');
  createWindow();
  if (legacyUserData.detected) showLegacyUserDataNotice(legacyUserData.path);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

process.on('uncaughtException', (error) => {
  log(`MAIN_UNCAUGHT ${String(error && error.stack ? error.stack : error)}`);
  app.exit(1);
});
