/**
 * 应用身份（B08 / R109）：**唯一的真值源**。
 *
 * 为什么单独一个文件：打包脚本（`.app` 名 / Info.plist / `Resources/app/package.json`）与
 * 主进程（`app.setName` / 窗口标题 / About）以前各写一份；改名时必然漏一处。
 * 这里只放常量，**不 import electron**，打包脚本（普通 Node）也能安全读。
 */

/** 打包后的产品名（Finder / 窗口标题 / About）。 */
export const APP_NAME = 'MotionCut';

/** Keep the installed profile location independent of display name changes. */
export const APP_USER_DATA_DIRECTORY = 'Opencut Studio';

/** macOS bundle id（Info.plist `CFBundleIdentifier`）。 */
export const APP_ID = 'com.opencut.studio';

/** Stable package identifier in the bundled `Resources/app/package.json`. */
export const APP_PACKAGE_NAME = 'opencut-studio';
