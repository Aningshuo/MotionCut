/**
 * 元素世界：把「页面源码」变成守卫要的观察值（project / instance / element）。
 *
 * 守卫（`film-core/element-guard.mjs`）是纯函数，它只认事实。事实从哪来是这一层的事：
 * 页面源码 → `scene-tree` 离线解析 → 按 `<clipId>::<at>` 复算节点 → 签名 / 是否挂载。
 *
 * 为什么用源码而不是浏览器 DOM：
 * - 写入口是**同步**的（`applyOps → writeValue → io.commit`），不能在里面开浏览器；
 * - 源码才是被写回去的那份真相；DOM 是它的一次渲染，且会被脚本改（`data-film-*`、动画）。
 *   拿 DOM 判「元素还在不在」，一个运行期脚本把节点删了就会把可写的元素判死；
 * - 离线解析在单测里可复现，不需要 Chromium。
 *
 * `instanceId` = 页面源码的 sha256。它一变，说明页面文件被换过（重建/重新生成/作者改了）；
 * 元素签名没变 = 同一节点还在 → 那是**重建中**，不是失效。
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import { parseElementKey, signatureOf } from '../../film-core/element-guard.mjs';
import { parseScene, pathOf, resolveAt } from '../../layers/scene-tree.mjs';

/** 页面源码上限：超过就不判（不让守卫去吃一个 200MB 的畸形文件）。 */
export const PAGE_SOURCE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 把一个 page 片段的 `src` 解析成工程目录里的真实路径。
 * 规则与内容 origin 的路径守卫同口径：拒绝协议、绝对路径、`..`、`.`、以 `.` 开头的段。
 * @param {string} projectDir
 * @param {unknown} src
 * @returns {{ ok: true, path: string } | { ok: false, code: string, message: string }}
 */
export function pagePathOf(projectDir, src) {
  const raw = typeof src === 'string' ? src.trim() : '';
  if (raw === '') return { ok: false, code: 'PAGE_UNREADABLE', message: 'page 片段没有 src' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) {
    return { ok: false, code: 'PAGE_UNREADABLE', message: `不支持的 page src：${raw}` };
  }
  const pathOnly = (raw.split('#')[0] ?? '').split('?')[0] ?? '';
  const trimmed = pathOnly.replace(/^\.\//, '');
  const segments = trimmed.split('/');
  if (trimmed === '' || segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment.startsWith('.'))) {
    return { ok: false, code: 'PAGE_UNREADABLE', message: `page src 越界：${raw}` };
  }
  const base = resolve(projectDir);
  const full = resolve(join(base, ...segments));
  if (full !== base && !full.startsWith(`${base}${sep}`)) {
    return { ok: false, code: 'PAGE_UNREADABLE', message: `page src 越界：${raw}` };
  }
  return { ok: true, path: full };
}

/**
 * 自包含的观察：只吃字符串，不读盘（单测与预演都走它）。
 * @param {{ projectId: string, source: string, keys: readonly string[] }} input
 * @returns {{ ok: true, observation: { projectId: string, instanceId: string, elements: Record<string, { present: boolean, mounted: boolean, signature: string }> } }
 *   | { ok: false, code: string, message: string }}
 */
export function observationFromSource(input) {
  const source = String(input.source ?? '');
  const tree = parseScene(source);
  if (tree.complete !== true) {
    return { ok: false, code: 'PAGE_UNREADABLE', message: '页面源码不完整（截断/引号没闭合），拒绝在半个树上判目标' };
  }
  /** @type {Record<string, { present: boolean, mounted: boolean, signature: string }>} */
  const elements = {};
  for (const key of input.keys) {
    const parsed = parseElementKey(key);
    if (parsed === null) {
      elements[key] = { present: false, mounted: false, signature: '' };
      continue;
    }
    const node = resolveAt(tree, parsed.at);
    if (node === null) {
      elements[key] = { present: false, mounted: false, signature: '' };
      continue;
    }
    const parent = node.parent;
    elements[key] = {
      present: true,
      mounted: isMounted(tree, node),
      signature: signatureOf({
        tag: node.tag,
        id: node.id ?? '',
        classes: node.classes,
        text: node.text,
        childCount: node.children.length,
        parentKey: parent === null ? '' : pathOf(tree, parent),
        attrs: node.attrs,
      }),
    };
  }
  return {
    ok: true,
    observation: {
      projectId: input.projectId,
      instanceId: createHash('sha256').update(source).digest('hex'),
      elements,
    },
  };
}

/**
 * 是否挂载：自己或任一祖先处于 `hidden` / `display:none` / `<template>` 里都算没挂载。
 * 这几种的共同点：源码里还在，帧里画不出来 —— 对着它写覆盖等于写进空气。
 * @param {any} tree
 * @param {any} node
 * @returns {boolean}
 */
export function isMounted(tree, node) {
  let cur = node;
  let guard = 0;
  while (cur !== null && cur !== undefined && guard++ < 200) {
    const tag = String(cur.tag ?? '').toLowerCase();
    if (tag === 'template') return false;
    if (cur.attrs !== undefined && cur.attrs !== null && Object.prototype.hasOwnProperty.call(cur.attrs, 'hidden')) return false;
    const style = typeof cur.attrs?.style === 'string' ? cur.attrs.style.replace(/\s+/g, '').toLowerCase() : '';
    if (style.includes('display:none')) return false;
    cur = cur.parent;
  }
  return true;
}

/**
 * 服务端唯一的读盘入口：按工程目录读 page 源码 → 观察值。
 * @param {{ projectId: string, projectDir: string, src: unknown, keys: readonly string[] }} input
 * @returns {Promise<{ ok: true, observation: { projectId: string, instanceId: string, elements: Record<string, { present: boolean, mounted: boolean, signature: string }> } }
 *   | { ok: false, code: string, message: string }>}
 */
export async function observePageFrom(input) {
  const resolved = pagePathOf(input.projectDir, input.src);
  if (resolved.ok !== true) return resolved;
  /** @type {string} */
  let source;
  try {
    source = await readFile(resolved.path, 'utf8');
  } catch (error) {
    return { ok: false, code: 'PAGE_UNREADABLE', message: `页面读不到：${String(/** @type {Error} */ (error).message)}` };
  }
  if (source.length > PAGE_SOURCE_MAX_BYTES) {
    return { ok: false, code: 'PAGE_UNREADABLE', message: `页面超过 ${PAGE_SOURCE_MAX_BYTES} 字节，不在写入口做解析` };
  }
  return observationFromSource({ projectId: input.projectId, source, keys: input.keys });
}

/**
 * 服务端的观察器：按工程读页面源码（读盘只在这里发生）。
 * @param {{ projectDirOf: (projectId: string) => string | null, pageSourceMaxBytes?: number }} options
 */
export function createElementWorld(options) {
  const projectDirOf = options.projectDirOf;
  const maxBytes = options.pageSourceMaxBytes ?? PAGE_SOURCE_MAX_BYTES;

  /**
   * @param {{ projectId: string, src: unknown, keys: readonly string[] }} input
   * @returns {Promise<{ ok: true, observation: { projectId: string, instanceId: string, elements: Record<string, { present: boolean, mounted: boolean, signature: string }> } }
   *   | { ok: false, code: string, message: string }>}
   */
  async function observe(input) {
    const dir = projectDirOf(input.projectId);
    if (typeof dir !== 'string' || dir === '') {
      return { ok: false, code: 'PAGE_UNREADABLE', message: `工程未打开：${input.projectId}` };
    }
    const resolved = pagePathOf(dir, input.src);
    if (resolved.ok !== true) return resolved;
    /** @type {string} */
    let source;
    try {
      source = await readFile(resolved.path, 'utf8');
    } catch (error) {
      return { ok: false, code: 'PAGE_UNREADABLE', message: `页面读不到：${String(/** @type {Error} */ (error).message)}` };
    }
    if (source.length > maxBytes) {
      return { ok: false, code: 'PAGE_UNREADABLE', message: `页面超过 ${maxBytes} 字节，不在写入口做解析` };
    }
    return observationFromSource({ projectId: input.projectId, source, keys: input.keys });
  }

  return { observe };
}

export default createElementWorld;
