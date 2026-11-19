/**
 * 应用身份（B08 / R109）：**唯一的真值源**。
 *
 * 为什么单独一个文件：打包脚本（`.app` 名 / Info.plist / `Resources/app/package.json`）与
 * 主进程（`app.setName` / 窗口标题 / About）以前各写一份；改名时必然漏一处。
 * 这里只放常量与纯函数，**不 import electron**，打包脚本（普通 Node）也能安全读。
 */

import { join, resolve } from 'node:path';

/** 打包后的产品名（Finder / 窗口标题 / About）。 */
export const APP_NAME = 'MotionCut';

/** Keep the installed profile location independent of display name changes. */
export const APP_USER_DATA_DIRECTORY = 'Opencut Studio';

/** macOS bundle id（Info.plist `CFBundleIdentifier`）。 */
export const APP_ID = 'com.opencut.studio';

/** Stable package identifier in the bundled `Resources/app/package.json`. */
export const APP_PACKAGE_NAME = 'opencut-studio';

/**
 * 旧身份：**只用于只读检测旧 userData 目录**，不是产品身份。
 *
 * 迁移提示可以出现这个词；窗口标题 / About / plist / 包名不得使用。
 */
export const LEGACY_APP_NAME = 'OpenFilm';

/**
 * 旧版 userData 目录的路径。
 *
 * 只拼路径：不 `stat`、不 `mkdir`。要不要检测由调用方决定。
 * @param {string} appData
 * @returns {string}
 */
export function legacyUserDataPath(appData) {
  return join(appData, LEGACY_APP_NAME);
}

/**
 * 只读检测旧目录：存在且**不是当前 userData** 才算命中。
 *
 * `exists` 注入是为了单测能证明「只调用一次，没有 mkdir / write」；产品调用传 `existsSync`。
 * @param {{ appData: string, userData: string, exists: (path: string) => boolean }} input
 * @returns {{ detected: boolean, path: string, sameAsCurrent: boolean }}
 */
export function detectLegacyUserData(input) {
  const path = legacyUserDataPath(input.appData);
  const sameAsCurrent = resolve(path) === resolve(input.userData);
  const detected = !sameAsCurrent && input.exists(path) === true;
  return { detected, path, sameAsCurrent };
}
