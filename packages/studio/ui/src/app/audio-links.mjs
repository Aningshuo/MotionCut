/**
 * Agent 消息里的相对路径音频链接（S76 · NEW-08）。
 *
 * ## 为什么要单独一层「分类」
 *
 * 消息文本来自 provider，是不可信输入。用户点一下就要发网络请求，所以在**构造 URL 之前**
 * 必须把路径判死：`../`、绝对路径、`file://`、百分号编码绕过、隐藏目录、控制字符一律拒绝，
 * 连请求都不发（验收里按 request 数断言）。这里只做纯字符串判断，不碰 DOM、不碰网络，
 * 所以能被 Node 直接单测（`scripts/s76-audio-link.mjs` 也 import 它）。
 *
 * 分类顺序很关键：**先安全、后扩展名**。否则 `/etc/passwd`（没有音频扩展名）会被当成
 * 「不是音频」而绕过安全检查——它必须被认成「不安全的路径」。
 *
 * ## 渲染策略（与 `classifyPath` 对应）
 *
 * | classifyPath 结果 | 界面 |
 * |---|---|
 * | `{ok:true, path}` | 可点的音频胶囊：点一下才开始加载（不自动播放） |
 * | `{ok:false, reason}` | 灰色「拒绝」胶囊：写明原因，**不可点**、不发请求 |
 * | `{ok:false, reason:'NOT_AUDIO'}` | 纯文本（`.png` / `.txt` 不该变播放条） |
 *
 * ## R137：HTML 标签不是路径（`</title>` 被切成 `/title` 的老 bug）
 *
 * provider 摘要里常带页面源码片段。粗分词按 `<`/`>` 切开，`</title>` 于是留下一个
 * `/title` token —— 形状与绝对路径**完全一样**，`classifyPath` 只能判 `ABSOLUTE_PATH`，
 * 界面上就出现一条「🔇 /title（绝对路径不取）」红胶囊。这是**输入分类错**，不是规则错。
 *
 * 判据（不是「多打一个 if」，是这条线以后都按它走）：
 *
 * 1. **算不算路径，看 token 的来源，不看它的形状。** 紧贴 `<` 或 `>` 的标签名
 *    （`</title>`、`<br/>`、`<div`）是标记语法，一律当文本；
 * 2. **`/title` 单独出现（前面不是 `<`）仍然拒，reason 仍是 `ABSOLUTE_PATH`。**
 *    理由：消费侧 `contentUrlFor` 把路径拼成 `<origin>/p/<projectId>/<rel>`，
 *    前导 `/` 会多出一个空段，内容源不可能命中工程文件；而「把前导 `/` 抹掉再当相对路径」
 *    等于把 `/etc/passwd` 悄悄改写成工程内 `etc/passwd` —— 现在它是 404，
 *    将来内容源若支持绝对路径就会变成真读盘。工程里写路径的只有 doc（`clip.src`，
 *    本来就是相对路径），所以合法的生产者不会产出前导 `/`：它只能是笔误或攻击，
 *    拒掉并把原因写清楚，比猜一个「大概想去工程根」诚实；
 * 3. **标签外面的路径照旧分类**：`<audio src="assets/a.wav">` 里的 `assets/a.wav`
 *    不是标签名（含 `/`、`.`），仍然会变成可点的胶囊；`<a href="/etc/passwd">` 里的
 *    `/etc/passwd` 前面不是 `<`，仍然判 `ABSOLUTE_PATH`。
 *
 * 换句话说：**标签语法被剥掉，路径规则一条没松。**
 */

/** 认的音频扩展名（任务书 §2.2.1）。 */
export const AUDIO_EXTENSIONS = Object.freeze(['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.flac', '.webm']);

/** 拒绝原因 → 人话（界面与证据共用一份，避免两处措辞漂移）。 */
export const REJECT_LABEL = Object.freeze({
  ABSOLUTE_PATH: '绝对路径不取',
  SCHEME: '带协议的地址不取',
  TRAVERSAL: '路径里有 ..，不取',
  ENCODED: '百分号编码解不开（可能是绕过），不取',
  HIDDEN: '隐藏目录不取',
  CONTROL: '路径里有控制字符，不取',
  TOO_LONG: '路径太长，不取',
  EMPTY: '空路径',
  QUERY: '带查询串或锚点，不取',
  NOT_AUDIO: '不是音频',
});

const MAX_LEN = 300;
/** 最多解 4 层编码：`%252e` → `%2e` → `.`；再套下去一律当绕过。 */
const MAX_DECODE = 4;

/**
 * 反复解码，直到稳定。解不开（非法百分号序列）返回 null。
 * @param {string} raw
 * @returns {string|null}
 */
export function decodeDeep(raw) {
  let current = raw;
  for (let i = 0; i < MAX_DECODE; i += 1) {
    let next;
    try {
      next = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (next === current) return current;
    current = next;
  }
  // 还能再解说明套了太多层：不冒险。
  try {
    if (decodeURIComponent(current) !== current) return null;
  } catch {
    return null;
  }
  return current;
}

/**
 * 安全判断（不看扩展名）。
 * @param {string} raw
 * @returns {{ok: true, path: string} | {ok: false, reason: string}}
 */
export function classifyPath(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return { ok: false, reason: 'EMPTY' };
  if (text.length > MAX_LEN) return { ok: false, reason: 'TOO_LONG' };
  // 控制字符 / 空字节 / 反斜杠：Windows 风格分隔符与 NUL 截断都拒绝。
  if (/[\u0000-\u001f\u007f]/.test(text) || text.includes('\\')) return { ok: false, reason: 'CONTROL' };
  // 先看原始串：`file://`、`http://`、`data:` 这类带协议的，一律拒绝。
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) return { ok: false, reason: 'SCHEME' };
  if (text.startsWith('/') || text.startsWith('~')) return { ok: false, reason: 'ABSOLUTE_PATH' };
  if (text.includes('?') || text.includes('#')) return { ok: false, reason: 'QUERY' };

  const decoded = decodeDeep(text);
  if (decoded === null) return { ok: false, reason: 'ENCODED' };
  // 解码之后再过一遍同样的检查（`%2f` 解出 `/`、`%3a` 解出 `:` 都在这里被抓）。
  if (/[\u0000-\u001f\u007f]/.test(decoded) || decoded.includes('\\')) return { ok: false, reason: 'CONTROL' };
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(decoded)) return { ok: false, reason: 'SCHEME' };
  if (decoded.startsWith('/') || decoded.startsWith('~')) return { ok: false, reason: 'ABSOLUTE_PATH' };
  if (decoded.includes('?') || decoded.includes('#')) return { ok: false, reason: 'QUERY' };

  const segments = decoded.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return { ok: false, reason: 'TRAVERSAL' };
    if (segment.startsWith('.')) return { ok: false, reason: 'HIDDEN' };
  }
  return { ok: true, path: decoded };
}

/**
 * 分类一个 token：安全 → 看扩展名；不安全 → 直接拒绝（**先安全后扩展名**）。
 * @param {string} raw
 * @returns {{ok: true, path: string} | {ok: false, reason: string}}
 */
export function classifyAudioPath(raw) {
  const safe = classifyPath(raw);
  if (safe.ok !== true) return safe;
  const lower = safe.path.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot === -1 ? '' : lower.slice(dot);
  if (!AUDIO_EXTENSIONS.includes(ext)) return { ok: false, reason: 'NOT_AUDIO' };
  return safe;
}

/**
 * 标签名（可带一个紧贴边界的斜杠）：`title`、`/title`、`br/`。
 * 刻意**不含** `/`、`.`、`%` —— 路径与文件名的形状不在这个集合里。
 */
const TAG_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;

/**
 * 这个 token 是不是 HTML 标签语法的一部分（R137）。
 *
 * 只认两种情况，且都必须**紧贴**边界字符：
 * - 前面是 `<` 且以 `/` 开头 → 闭合标签名（`</title>` → `/title`）；
 * - 后面是 `>` 且以 `/` 结尾 → 自闭合标签名（`<br/>` → `br/`）。
 *
 * 两边的 `<`/`>` 都可能被分词器吃掉，所以由调用方把邻接字符传进来。
 * **不做「以 `/` 开头就一定是标签」这种猜测**：那会把 `/etc/passwd` 也放过。
 *
 * @param {string} raw token 原文
 * @param {string} [before] token 前一个字符（无则空串）
 * @param {string} [after] token 后一个字符（无则空串）
 * @returns {boolean}
 */
export function isMarkupFragment(raw, before = '', after = '') {
  let name = String(raw ?? '');
  let touched = false;
  if (before === '<' && name.startsWith('/')) {
    name = name.slice(1);
    touched = true;
  }
  if (after === '>' && name.endsWith('/')) {
    name = name.slice(0, -1);
    touched = true;
  }
  return touched && TAG_NAME.test(name);
}

/**
 * 粗分词：按空白与中英文标点切开，保留含 `/` 的 token。
 * 只做「够用」的切分——消息文本不是 Markdown 解析器，宁可少切也不吞掉路径。
 * @param {string} text
 * @returns {Array<{kind: 'text', text: string} | {kind: 'link', raw: string, path: string} | {kind: 'rejected', raw: string, reason: string}>}
 */
export function scanAudioLinks(text) {
  const source = String(text ?? '');
  /** @type {Array<any>} */
  const out = [];
  const splitter = /([^\s，。；、！？：（）()《》「」【】"'`<>]+)/gu;
  let cursor = 0;
  /** @param {string} value */
  const pushText = (value) => {
    if (value === '') return;
    const last = out[out.length - 1];
    if (last !== undefined && last.kind === 'text') last.text += value;
    else out.push({ kind: 'text', text: value });
  };
  for (const match of source.matchAll(splitter)) {
    const token = match[0];
    const index = match.index ?? 0;
    pushText(source.slice(cursor, index));
    cursor = index + token.length;
    if (!token.includes('/')) {
      pushText(token);
      continue;
    }
    /* 去掉句末标点（`assets/a.wav.` 这种）。 */
    const raw = token.replace(/[.,;:!?]+$/u, '');
    const tail = token.slice(raw.length);
    /* R137：标签语法先剥掉再分类 —— `</title>` 的 `/title` 不是路径，不该出拒绝胶囊。
       邻接字符按 raw 的边界取（`</title>.` 里 after 是 `.`，靠 before 的 `<` 认）。 */
    if (isMarkupFragment(raw, source[index - 1] ?? '', source[index + raw.length] ?? '')) {
      pushText(token);
      continue;
    }
    const verdict = classifyAudioPath(raw);
    if (verdict.ok === true) out.push({ kind: 'link', raw, path: verdict.path });
    else if (verdict.reason === 'NOT_AUDIO') pushText(raw);
    else out.push({ kind: 'rejected', raw, reason: verdict.reason });
    pushText(tail);
  }
  pushText(source.slice(cursor));
  return out;
}

/**
 * 内容 origin 的素材地址：`<origin>/p/<projectId>/<rel>`（与舞台/素材缩略图同一条路由）。
 * 每个路径段单独编码，但**保留 `/` 作为分隔**；调用前必须已经过 `classifyPath`。
 * @param {string} origin
 * @param {string} projectId
 * @param {string} path
 */
export function contentUrlFor(origin, projectId, path) {
  const base = String(origin ?? '').replace(/\/+$/u, '');
  if (base === '' || projectId === '') return '';
  const encoded = String(path)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${base}/p/${encodeURIComponent(projectId)}/${encoded}`;
}
