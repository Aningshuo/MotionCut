/**
 * 最小 preload 桥。
 *
 * 只见名方法，不透传 ipcRenderer / invoke 原参数，也不暴露 fs / path / child_process。
 * 每个通道都是固定字符串，参数由主进程侧再校验。
 */

const { contextBridge, ipcRenderer } = require('electron');

if (process.platform === 'darwin') {
  const markDesktopTitleBar = () => {
    document.documentElement.classList.add('motioncut-mac-shell');
  };
  if (document.documentElement) markDesktopTitleBar();
  else window.addEventListener('DOMContentLoaded', markDesktopTitleBar, { once: true });
}

const CHANNELS = Object.freeze({
  health: 'opencut:studio-health',
  events: 'opencut:event',
  openProjectDialog: 'opencut:open-project-dialog',
  pickMedia: 'opencut:pick-media',
  pickRelinkFile: 'opencut:pick-relink-file',
  pickRelinkDir: 'opencut:pick-relink-dir',
  pickArchiveSave: 'opencut:pick-archive-save',
  pickArchiveOpen: 'opencut:pick-archive-open',
  showItemInFolder: 'opencut:show-item-in-folder',
  tabsOpen: 'opencut:tabs-open',
  tabsActivate: 'opencut:tabs-activate',
  tabsClose: 'opencut:tabs-close',
  tabsHome: 'opencut:tabs-home',
  tabsList: 'opencut:tabs-list',
  tabsChanged: 'opencut:tabs-changed',
});

/** @param {unknown} value */
function assertFunction(value) {
  if (typeof value !== 'function') {
    throw new TypeError('onEvent(cb) 需要一个函数');
  }
}

const api = Object.freeze({
  /** 宿主类型：渲染层用它显示 transport（不猜、不探）。 */
  transport: 'electron',
  /** @returns {Promise<{ ok: boolean, version?: string, pid?: number, code?: string }>} */
  health() {
    return ipcRenderer.invoke(CHANNELS.health);
  },

  /**
   * 订阅 Studio 事件；返回取消订阅函数。
   * @param {(event: unknown) => void} callback
   * @returns {() => void}
   */
  onEvent(callback) {
    assertFunction(callback);
    /** @param {unknown} _event @param {unknown} payload */
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(CHANNELS.events, listener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.events, listener);
    };
  },

  /** @returns {Promise<{ canceled: boolean, path?: string }>} */
  openProjectDialog() {
    return ipcRenderer.invoke(CHANNELS.openProjectDialog);
  },

  /**
   * 选一个素材文件（M18）：返回**绝对路径**，由渲染层发给 Studio 的 /media。
   * 浏览器里没有这个能力（拿不到绝对路径），走 <input type=file> 兜底。
   * @returns {Promise<{ canceled: boolean, path?: string }>}
   */
  pickMedia() {
    return ipcRenderer.invoke(CHANNELS.pickMedia);
  },

  /**
   * 选一个「用来重链」的素材文件（M26）：同样是绝对路径，由渲染层发给 `/relink`。
   * @returns {Promise<{ canceled: boolean, path?: string }>}
   */
  pickRelinkFile() {
    return ipcRenderer.invoke(CHANNELS.pickRelinkFile);
  },

  /**
   * 选一个目录做批量重链（M26，按文件名匹配）：返回绝对路径，扫描由 `/relink/scan` 做。
   * @returns {Promise<{ canceled: boolean, path?: string }>}
   */
  pickRelinkDir() {
    return ipcRenderer.invoke(CHANNELS.pickRelinkDir);
  },

  /**
   * 在 Finder / 资源管理器里选中这个文件（M29 导出的「在文件夹中显示」）。
   *
   * 只接受**绝对路径**：主进程会再校验一遍（存在 + 是绝对路径），渲染层拿不到任意
   * shell 能力。浏览器宿主没有这个方法，UI 退化为「复制路径」。
   * @param {string} target
   * @returns {Promise<{ ok: boolean, code?: string, message?: string, path?: string }>}
   */
  showItemInFolder(target) {
    return ipcRenderer.invoke(CHANNELS.showItemInFolder, { path: target });
  },

  /**
   * 多标签：每工程一个视图实例；打开/激活/关闭/列表都是具名方法。
   * 返回的计数（created/destroyed/subscriptions）用于验证「切标签不重建、关标签释放订阅」。
   */
  tabs: Object.freeze({
    /** @param {{ projectId: string, url?: string }} input */
    open(input) {
      return ipcRenderer.invoke(CHANNELS.tabsOpen, input);
    },
    /** @param {string} projectId */
    activate(projectId) {
      return ipcRenderer.invoke(CHANNELS.tabsActivate, projectId);
    },
    /** @param {string} projectId */
    close(projectId) {
      return ipcRenderer.invoke(CHANNELS.tabsClose, projectId);
    },
    home() {
      return ipcRenderer.invoke(CHANNELS.tabsHome);
    },
    /** @returns {Promise<import('./views.mjs').ViewSnapshot>} */
    list() {
      return ipcRenderer.invoke(CHANNELS.tabsList);
    },
    /** @param {(snapshot: unknown) => void} callback @returns {() => void} */
    onChanged(callback) {
      assertFunction(callback);
      /** @param {unknown} _event @param {unknown} payload */
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on(CHANNELS.tabsChanged, listener);
      return () => {
        ipcRenderer.removeListener(CHANNELS.tabsChanged, listener);
      };
    },
  }),

  /**
   * 选一个「打包工程」的保存位置（M59）：默认文件名由渲染层给，主进程只补目录与后缀。
   *
   * 为什么不让服务端直接决定落点：服务端只会落在 `<工程>/exports/`，而「导出到桌面」
   * 是最常见的诉求；只有主进程的保存框能拿到用户真正想去的地方。
   * @param {string} [defaultName]
   * @returns {Promise<{ canceled: boolean, path?: string, code?: string }>}
   */
  pickArchiveSave(defaultName) {
    return ipcRenderer.invoke(CHANNELS.pickArchiveSave, { name: typeof defaultName === 'string' ? defaultName : '' });
  },

  /**
   * 选一个要导入的工程包（M59）：只回绝对路径，解包与校验都由 `/api/projects/import` 做。
   * @returns {Promise<{ canceled: boolean, path?: string, code?: string }>}
   */
  pickArchiveOpen() {
    return ipcRenderer.invoke(CHANNELS.pickArchiveOpen);
  },
});

contextBridge.exposeInMainWorld('opencut', api);
