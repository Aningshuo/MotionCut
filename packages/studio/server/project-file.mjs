/**
 * 工程内文件的只读出口（M34 · B-MAIN-R17-017）
 *
 * ## 为什么需要它
 *
 * 时间线要在 Studio 页面里 `fetch` 音频字节再 `decodeAudioData`（副线1 的冻结波形接口
 * `loadPeaks()` 就是这么做的）。素材只由**内容 origin**（另一个端口）提供，而内容 origin
 * 有意**不发** CORS 头（`contracts/stage.ts` 的隔离要求，R13 起就是这么定的）——从 Studio
 * 页面直接 fetch 会被浏览器挡在 CORS 上。
 *
 * 所以这里补一条**同源**的只读通道：只按工程相对路径取字节，不写盘、不列目录、不越界。
 * 它不替代内容 origin（舞台仍旧只从内容 origin 取素材），只是给编辑器自己看一眼波形。
 *
 * ## 守卫
 *
 * 与内容 origin 同源的一套规则（`content-origin.mjs` 的路径守卫）：
 * 拒绝 `\0`、反斜杠、绝对路径、空段、`.` / `..`、以 `.` 开头的段（`.film/**`、`.git/**`）、
 * `node_modules/**`；解析后再对 `realpath(工程根)` 与 `realpath(目标)` 做前缀校验，
 * 符号链接逃逸同样拒绝。越界统一 `E_PATH_ESCAPE`。
 */

export const PROJECT_FILE_VERSION = '1.0.0';

/** 只服务「看一眼」的类型：音频/视频/图片/文本。别的类型照样能取，只是 content-type 退成 octet-stream。 */
const MIME_BY_EXT = new Map([
  ['.wav', 'audio/wav'],
  ['.wave', 'audio/wav'],
  ['.mp3', 'audio/mpeg'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.ogg', 'audio/ogg'],
  ['.oga', 'audio/ogg'],
  ['.opus', 'audio/ogg'],
  ['.flac', 'audio/flac'],
  ['.weba', 'audio/webm'],
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.mov', 'video/quicktime'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.svg', 'image/svg+xml'],
  ['.vtt', 'text/vtt; charset=utf-8'],
  ['.srt', 'text/plain; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

/**
 * 扩展名 → content-type。认得就按类型给，不认得就 octet-stream（不做内容嗅探）。
 * @param {string} rel
 */
export function contentTypeOf(rel) {
  const name = String(rel ?? '');
  const dot = name.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return MIME_BY_EXT.get(name.slice(dot).toLowerCase()) ?? 'application/octet-stream';
}

/**
 * 工程相对路径的**纯**守卫（不碰文件系统，便于单测）。
 *
 * @param {unknown} raw
 * @returns {{ ok: true, rel: string } | { ok: false, code: string, message: string }}
 */
export function checkRelPath(raw) {
  if (typeof raw !== 'string' || raw === '') {
    return { ok: false, code: 'INVALID_PATH', message: 'path 不能为空' };
  }
  const rel = raw;
  if (rel.includes('\u0000')) return { ok: false, code: 'INVALID_PATH', message: 'path 里不能有 NUL' };
  if (rel.includes('\\')) return { ok: false, code: 'INVALID_PATH', message: 'path 必须用 /（不接受反斜杠）' };
  if (rel.startsWith('/')) return { ok: false, code: 'INVALID_PATH', message: 'path 必须是工程相对路径' };
  const segments = rel.split('/');
  for (const segment of segments) {
    if (segment === '') return { ok: false, code: 'INVALID_PATH', message: 'path 里不能有空段' };
    if (segment === '.' || segment === '..') {
      return { ok: false, code: 'E_PATH_ESCAPE', message: 'path 里不能有 . 或 ..' };
    }
    if (segment.startsWith('.')) {
      return { ok: false, code: 'E_PATH_ESCAPE', message: `不允许访问以 . 开头的路径：${segment}` };
    }
    if (segment === 'node_modules') {
      return { ok: false, code: 'E_PATH_ESCAPE', message: '不允许访问 node_modules' };
    }
  }
  return { ok: true, rel };
}

/**
 * 目标是否在根内（都是绝对路径；纯字符串判定，调用方负责先 realpath）。
 * @param {string} root
 * @param {string} target
 */
export function isInside(root, target) {
  if (root === target) return true;
  const base = root.endsWith('/') ? root : `${root}/`;
  return target.startsWith(base);
}
