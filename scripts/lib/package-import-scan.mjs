/**
 * 「打包白名单 vs 真实 import」的静态求差集（M95）。
 *
 * ## 为什么要有这个
 *
 * `scripts/package-desktop.mjs` 里 `APP_TREES` 是**手工维护**的白名单。M93 把
 * `packages/scene-gen` 加进产品，`provider-mock.mjs` 直接 `import '../scene-gen/index.mjs'`，
 * 但白名单没跟着改 —— 打出来的 App 一启动就是
 * `ERR_MODULE_NOT_FOUND: Resources/app/packages/scene-gen/index.mjs`。
 *
 * 这类漏项**在源码树里永远测不出来**（源码树里文件都在）。所以判据只能是：
 * 从 `packages/**` 里所有相对 import 反解出「被引用的 `packages/<dir>`」，与白名单求差集，
 * 差集必须为空。加新包时忘了改白名单 → 这一条立刻红。
 *
 * ## 口径
 *
 * - 只认**相对**说明符（`./` `../`）。仓库里没有裸包名 import（workspace 包没有互相声明依赖），
 *   真出现裸名会被记进 `bare`，由调用方决定是否要人看。
 * - 解析从**文件所在目录**出发，`../scene-gen/index.mjs` 与 `../../layers/element-lock.mjs`
 *   都按路径归一化，**不猜扩展名**（写错了本来就会炸）。
 * - 落在 `packages/<dir>/...` 的算一个引用；落在 `packages/` 之外（apps / contracts / resources）不算。
 * - 引用方自己也算：`packages/film-core` 内部互相 import 不产生新目录。
 * - `test/` 与 `*.test.mjs` **单独统计**：它们不随包运行，但白名单里本来也都覆盖了；
 *   为了让「差集为空」这条判据更硬，**默认一并计入**（多算不会漏，少算才会漏）。
 *
 * @module scripts/lib/package-import-scan
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/** 会被扫描的源码扩展名。 */
const SOURCE_EXT = new Set(['.mjs', '.js', '.cjs', '.mts', '.cts', '.ts', '.tsx']);

/** 不扫的目录（构建产物 / 依赖）。 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git']);

/**
 * 从一段源码里抽相对说明符。
 *
 * 覆盖：`from '...'`、`import '...'`、`import('...')`、`require('...')`、`export ... from '...'`。
 * 不做完整词法分析（注释里的 import 也会被算到）——**宁可多算**：多算只会让差集偏小，
 * 而这条判据要防的是「少了」，不是「多了」。
 *
 * @param {string} source
 * @returns {string[]}
 */
export function extractSpecifiers(source) {
  /** @type {string[]} */
  const found = [];
  const patterns = [
    /\bfrom\s*['"]([^'"\n]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    /^\s*import\s+['"]([^'"\n]+)['"]/gm,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const spec = match[1];
      if (typeof spec === 'string' && spec !== '') found.push(spec);
    }
  }
  return found;
}

/**
 * 把 `packages/<dir>/...` 里的 `<dir>` 取出来；不在 `packages/` 下返回 null。
 * @param {string} repoRoot
 * @param {string} absolute
 * @returns {string|null}
 */
function packageDirOf(repoRoot, absolute) {
  const rel = path.relative(repoRoot, absolute);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts[0] !== 'packages') return null;
  if (parts.length < 2) return null;
  return `packages/${parts[1]}`;
}

/**
 * 递归列出 `packages/` 下的源码文件。
 * @param {string} dir
 * @param {string[]} [out]
 * @returns {string[]}
 */
function walkSources(dir, out = []) {
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkSources(full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (SOURCE_EXT.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

/**
 * 扫全仓 `packages/**` 的相对 import，统计「被引用的 packages 子目录」。
 *
 * @param {string} repoRoot
 * @returns {{
 *   targets: string[],
 *   bare: {spec: string, from: string}[],
 *   refs: {from: string, spec: string, dir: string, isTest: boolean}[],
 *   scannedFiles: number,
 * }}
 */
export function scanPackageImports(repoRoot) {
  const root = path.resolve(repoRoot);
  const packagesRoot = path.join(root, 'packages');
  const files = walkSources(packagesRoot);
  /** @type {Map<string, {from: string, spec: string, dir: string, isTest: boolean}[]>} */
  const byDir = new Map();
  /** @type {{spec: string, from: string}[]} */
  const bare = [];

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const relFrom = path.relative(root, file);
    const isTest = /(^|[\\/])test[\\/]/.test(relFrom) || /\.test\.[cm]?[jt]sx?$/.test(relFrom);
    for (const spec of extractSpecifiers(source)) {
      /* 模板串里的假 import（`from '${source}'`）与拼接片段（`' | '`）不是说明符。 */
      if (spec.includes('${') || /[\s,]/.test(spec)) continue;
      if (!spec.startsWith('.')) {
        /* 裸包名：仓库里不该有（package.json 的 workspaces 没有互相 link）。记下来让人看。 */
        if (!spec.startsWith('node:') && !spec.startsWith('#') && !spec.startsWith('http')) {
          bare.push({ spec, from: relFrom });
        }
        continue;
      }
      const absolute = path.resolve(path.dirname(file), spec);
      const dir = packageDirOf(root, absolute);
      if (dir === null) continue;
      const list = byDir.get(dir) ?? [];
      list.push({ from: relFrom, spec, dir, isTest });
      byDir.set(dir, list);
    }
  }

  const targets = [...byDir.keys()].sort();
  /** @type {{from: string, spec: string, dir: string, isTest: boolean}[]} */
  const refs = [];
  for (const dir of targets) refs.push(.../** @type {any} */ (byDir.get(dir)));

  return { targets, bare, refs, scannedFiles: files.length };
}

/**
 * 差集：被 import 但不在白名单里的 `packages/<dir>`。
 *
 * @param {string} repoRoot
 * @param {readonly string[]} whitelist `APP_TREES` 那种「仓库相对路径」列表
 * @returns {{
 *   imported: string[], shipped: string[], missing: string[], unused: string[],
 *   bare: {spec: string, from: string}[], scannedFiles: number, refs: number,
 * }}
 */
export function diffWhitelist(repoRoot, whitelist) {
  const scan = scanPackageImports(repoRoot);
  const shipped = whitelist
    .filter((entry) => entry.startsWith('packages/'))
    .map((entry) => entry.replace(/\/+$/, ''))
    .sort();
  const shippedSet = new Set(shipped);
  const importedSet = new Set(scan.targets);

  /* 白名单可以更细：`packages/studio/server` 覆盖 `packages/studio` 这个引用目标。 */
  const covered = (/** @type {string} */ dir) =>
    shippedSet.has(dir) || shipped.some((/** @type {string} */ entry) => entry.startsWith(`${dir}/`));
  const missing = scan.targets.filter((/** @type {string} */ dir) => !covered(dir));
  /* 白名单里有、但没人 import 的包：不算错（可能被 CLI 动态加载），只记下来。 */
  const unused = shipped.filter((dir) => !importedSet.has(dir));

  return {
    imported: scan.targets,
    shipped,
    missing,
    unused,
    bare: scan.bare,
    scannedFiles: scan.scannedFiles,
    refs: scan.refs.length,
  };
}

/**
 * 给人看的一行摘要。
 * @param {ReturnType<typeof diffWhitelist>} diff
 */
export function describeDiff(diff) {
  return (
    `imported=${String(diff.imported.length)} shipped=${String(diff.shipped.length)} ` +
    `missing=${String(diff.missing.length)} unused=${String(diff.unused.length)} refs=${String(diff.refs)}`
  );
}

/**
 * 判断一个路径是不是文件（给调用方做存在性检查用）。
 * @param {string} target
 */
export function isFile(target) {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}
