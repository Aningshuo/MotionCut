/**
 * 字幕样式的工程级存储（M40 · B-MAIN-R20-020）
 *
 * 落在 `<project>/.film/subtitle-style.json`，形状：
 *
 * ```json
 * { "version": "1.0.0", "style": { ...只写与默认值不同的字段... }, "updatedAt": "2026-11-08T…Z" }
 * ```
 *
 * R34 起 `style` 是**差异**而不是整包：点一下预设，盘上只有 `{"preset":"outline"}`。
 * 读侧一直走 `normalizeSubtitleStyle` 补默认值，所以少写等值字段不改变语义（见 `compactStyle`）。
 *
 * ## 为什么是 `.film/` 而不是 `film.html`
 *
 * 样式是**工程设置**，不是时间线内容：它不参与 `film.html` 的方言（`<section>` /
 * `<video>` 那套），也不进 `/ops` 的撤销栈。写进 film.html 会带来两个坏结果：
 * 每次调字号都变成一次可撤销的编辑动作（撤销栈被样式淹没），而且导出侧要重新解析
 * 一个它现在并不认识的属性。任务书 §7 也把「只能写 film.html 才能被导出读到」列为停止条件。
 *
 * 放在 `.film/` 下与既有的 `history/` 同一个私有目录：不进工程哈希、不进 git。
 *
 * ## 写盘规格
 *
 * 与 `subtitle-store.mjs` / `film-io.mjs` 同一套：同目录临时文件 → `fsync` →
 * `rename` → **回读校验**；任何一步失败都清掉临时文件，绝不留下半份样式。
 * 成功后把回读内容的 sha256 一起返回（UI/验收能对上「写进去的就是读回来的」）。
 *
 * ## 校验口径
 *
 * **只读 import** `layers/subtitle-style.mjs`（副线1 的 S41 产物），不在 studio 侧
 * 复制一份默认值或范围表——那样就会变成第二个真相源（R14-C1 的教训）。
 *
 * - 未知字段：**不静默丢弃**，`{code:'UNKNOWN_FIELD', field}`（字段名要能指出来）；
 * - 非法值：`normalizeSubtitleStyle` 的 issues 原样返回，`{code:'INVALID_STYLE', issues}`。
 *
 * 补丁语义：PUT 的 `style` 是**覆盖在现有样式之上**的补丁（面板只改那 8 个控件，
 * 不该把 `fontFamily` / `assFontName` / `bold` 这些没露出的字段顺手打回默认）。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  SUBTITLE_STYLE_DEFAULTS,
  SUBTITLE_STYLE_VERSION,
  normalizeSubtitleStyle,
} from '../../layers/subtitle-style.mjs';

/** 工程内相对路径（交接与报错里用它，不暴露绝对路径）。 */
export const SUBTITLE_STYLE_FILE = '.film/subtitle-style.json';

/** `layers` 接受的老字段名（别名）。它们**不是**未知字段。 */
const ALIASES = Object.freeze(['strokeColor', 'strokeWidthRatio']);

/** 可写字段集合（默认值的键 + 别名）。 */
const STYLE_FIELDS = new Set([...Object.keys(SUBTITLE_STYLE_DEFAULTS), ...ALIASES]);

/**
 * @param {string} projectDir
 * @returns {string}
 */
export function stylePathOf(projectDir) {
  return path.join(projectDir, '.film', 'subtitle-style.json');
}

/** @param {string} text */
function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * 读样式。文件不存在 = `exists:false` + 默认值（**不是错误**：新工程本来就没有）。
 *
 * @param {string} projectDir
 * @returns {Promise<
 *   { ok: true, exists: boolean, version: string, style: any, updatedAt: string|null, sha256: string|null }
 *   | { ok: false, code: 'STYLE_INVALID_FILE'|'STYLE_UNREADABLE', message: string }
 * >}
 */
export async function readSubtitleStyle(projectDir) {
  const file = stylePathOf(projectDir);
  /** @type {string} */
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (/** @type {any} */ (error)?.code === 'ENOENT') {
      return {
        ok: true,
        exists: false,
        version: SUBTITLE_STYLE_VERSION,
        style: { ...SUBTITLE_STYLE_DEFAULTS },
        updatedAt: null,
        sha256: null,
      };
    }
    return { ok: false, code: 'STYLE_UNREADABLE', message: `${SUBTITLE_STYLE_FILE}: ${String(/** @type {Error} */ (error).message)}` };
  }

  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, code: 'STYLE_INVALID_FILE', message: `${SUBTITLE_STYLE_FILE} 不是合法 JSON：${String(/** @type {Error} */ (error).message)}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: 'STYLE_INVALID_FILE', message: `${SUBTITLE_STYLE_FILE} 的顶层必须是对象` };
  }
  /* 版本不同不猜：样式表加字段会升次版本，但**读**旧文件仍然按当前 schema 归一；
     主版本不同（1.x → 2.x）才拒绝，因为那时字段语义可能已经变了。 */
  const version = typeof parsed.version === 'string' ? parsed.version : '';
  if (version !== '' && version.split('.')[0] !== SUBTITLE_STYLE_VERSION.split('.')[0]) {
    return {
      ok: false,
      code: 'STYLE_INVALID_FILE',
      message: `${SUBTITLE_STYLE_FILE} 的版本 ${version} 与本机支持的 ${SUBTITLE_STYLE_VERSION} 主版本不同`,
    };
  }
  const normalized = normalizeSubtitleStyle(parsed.style);
  return {
    ok: true,
    exists: true,
    version: SUBTITLE_STYLE_VERSION,
    style: normalized.style,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    sha256: sha256(text),
  };
}

/**
 * 写样式（补丁语义：覆盖在**当前**样式之上）。
 *
 * @param {{ projectDir: string, patch: unknown }} input
 * @returns {Promise<
 *   { ok: true, exists: true, version: string, style: any, updatedAt: string, sha256: string, changed: boolean }
 *   | { ok: false, code: 'UNKNOWN_FIELD', field: string, message: string }
 *   | { ok: false, code: 'INVALID_STYLE', issues: any[], message: string }
 *   | { ok: false, code: 'STYLE_INVALID_FILE'|'STYLE_UNREADABLE', message: string }
 *   | { ok: false, code: 'STYLE_WRITE_FAILED', message: string }
 * >}
 */
export async function saveSubtitleStyle(input) {
  const patch = input.patch;
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, code: 'INVALID_STYLE', issues: [], message: 'style 必须是普通对象（字段 → 值）' };
  }

  /* 未知字段先判：这是「用户以为改了、实际被丢掉」的唯一防线。
     别名（strokeColor / strokeWidthRatio）算已知——layers 会映射成新名字。 */
  for (const key of Object.keys(patch)) {
    if (!STYLE_FIELDS.has(key)) {
      return {
        ok: false,
        code: 'UNKNOWN_FIELD',
        field: key,
        message: `未知的字幕样式字段「${key}」（可用字段见 packages/layers/README.md 的字幕样式表）`,
      };
    }
  }

  const current = await readSubtitleStyle(input.projectDir);
  if (current.ok !== true) return current;

  const merged = normalizeSubtitleStyle({ ...current.style, ...patch });
  if (merged.issues.length > 0) {
    return {
      ok: false,
      code: 'INVALID_STYLE',
      issues: merged.issues,
      message: `${merged.issues.length} 个字段不合法：${merged.issues.map((issue) => issue.message).join('；')}`,
    };
  }

  const updatedAt = new Date().toISOString();
  const payload = { version: SUBTITLE_STYLE_VERSION, style: compactStyle(merged.style), updatedAt };
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  const written = await writeAtomic(stylePathOf(input.projectDir), text);
  if (written.ok !== true) return written;

  return {
    ok: true,
    exists: true,
    version: SUBTITLE_STYLE_VERSION,
    style: merged.style,
    updatedAt,
    sha256: written.hash,
    changed: current.sha256 !== written.hash,
  };
}

/**
 * 落盘只写「与默认值不同」的字段，`preset` 永远写（R34 · E12-P5 的 C5）。
 *
 * 为什么要改：这个文件是**设置**，不是快照。以前每次保存都把归一后的 18 个字段整包写下去，
 * 于是「点一下预设」在盘上留下 18 行 —— 看起来像用户逐项调过，实际只有 `preset` 是他选的。
 * 验收口径要的是「落盘只写 preset」（预设有派生值就算两套真相），而读侧一直是
 * `normalizeSubtitleStyle` 补默认值，所以**少写等值字段不改变读回来的语义**：
 * 读一次仍然是完整的 18 字段，预览与成片照旧读同一份。
 *
 * `preset` 例外：它与默认值相同时也必须写 —— 它是「用户选了哪一支」的身份，
 * 丢了就会在「默认」上写出空对象，读回来虽然等价，但盘上看不出他点过。
 *
 * @param {Record<string, unknown>} style 归一后的完整样式
 * @returns {Record<string, unknown>}
 */
function compactStyle(style) {
  /* 默认值对象是 `Object.freeze` 的字面量类型（`as const` 那种），按字符串下标取会报 TS7053；
     这里要的就是「按字段名逐个比」，所以显式当成字典用。 */
  const defaults = /** @type {Record<string, unknown>} */ (SUBTITLE_STYLE_DEFAULTS);
  /** @type {Record<string, unknown>} */
  const diff = { preset: style.preset ?? defaults.preset };
  for (const key of Object.keys(defaults)) {
    if (key === 'preset') continue;
    /* 逐值比较用 JSON 串：这些字段只有字符串/数字/布尔，且归一化后形状稳定。
       不做深比较是因为没有嵌套对象（真出现了也宁可报差异，不要悄悄丢）。 */
    if (JSON.stringify(style[key]) !== JSON.stringify(defaults[key])) diff[key] = style[key];
  }
  return diff;
}

/**
 * 原子写：临时文件 → fsync → rename → 回读逐字节比对。
 * @param {string} file @param {string} text
 * @returns {Promise<{ok: true, hash: string}|{ok: false, code: 'STYLE_WRITE_FAILED', message: string}>}
 */
async function writeAtomic(file, text) {
  const dir = path.dirname(file);
  const tempPath = path.join(
    dir,
    `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
  );
  /** @type {import('node:fs/promises').FileHandle|null} */
  let handle = null;
  try {
    await fs.mkdir(dir, { recursive: true });
    handle = await fs.open(tempPath, 'wx');
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tempPath, file);
  } catch (error) {
    if (handle !== null) await handle.close().catch(() => undefined);
    await fs.unlink(tempPath).catch(() => undefined);
    return { ok: false, code: 'STYLE_WRITE_FAILED', message: String(/** @type {Error} */ (error).message) };
  }
  /** @type {string} */
  let back;
  try {
    back = await fs.readFile(file, 'utf8');
  } catch (error) {
    return { ok: false, code: 'STYLE_WRITE_FAILED', message: `回读失败：${String(/** @type {Error} */ (error).message)}` };
  }
  if (back !== text) {
    return { ok: false, code: 'STYLE_WRITE_FAILED', message: '回读校验失败：写入内容与内存不一致' };
  }
  return { ok: true, hash: sha256(back) };
}
