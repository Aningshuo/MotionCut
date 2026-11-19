/**
 * 种子动效库安装（副线1 · S29-MOTION-LIBRARY）
 *
 * ## 为什么要有这个文件
 *
 * 引擎（`library.mjs` / `params.mjs` / `instance.mjs`）和面板（`panel.mjs`）都好了，
 * 但仓库里**一条模板都没有**——用户打开面板看到的是空库。这个文件就是「内容」的入口：
 * 把 `packages/motion/templates/**` 复制进工程的 `motion/assets/**`，登记进 `motion/library.json`。
 *
 * ## 幂等
 *
 * - 目标文件**已存在且字节相同** → 什么都不做（不重写、不动 mtime）；
 * - 目标文件存在但**内容不同** → 默认**不覆盖**（用户改过的模板不该被安装器擦掉），记进 `kept`；
 *   要覆盖显式传 `{overwrite:true}`；
 * - 库条目已存在 → 该条进 `skipped`，不重复登记（`entryId` 由「name + sourcePath」决定，天然幂等）。
 *
 * ## 装完自校验，不过就不写盘
 *
 * 先落文件 → 用 `validateLibrary` 校验**将要写入的那份库**（真实 root + 真实资产）→
 * 不通过就把这一轮复制进去的文件删掉、不写 `library.json`，返回错误码与逐条原因。
 * 写盘之后再读一次、再校验一次，`validation` 返回的是**落盘后**的结果（不是内存里的乐观值）。
 *
 * ## CLI
 *
 * ```sh
 * node packages/motion/seed.mjs <projectDir>
 * ```
 *
 * 打印人话摘要（装了几条、跳过几条、库路径、校验结果），退出码 0/1。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { discoverControls } from './discover.mjs';
import { scanSource } from './wall-clock-check.mjs';
import {
  LIBRARY_VERSION,
  entryId,
  findEntry,
  libraryPath,
  readLibrary,
  scanAssetRefs,
  sha256,
  validateLibrary,
  writeLibrary
} from './library.mjs';

export { validateLibrary };

/**
 * 种子内容版本：模板/参数变了就加一（宿主可用来判断要不要重装）。
 * 2 = S31 去墙钟（模板字节全变）+ S32 参数标注。
 */
export const SEED_VERSION = 2;

/**
 * @typedef {object} SeedTemplate
 * @property {string} slug        目录名（templates/<slug>/ 与 motion/assets/<slug>/）
 * @property {string} name        条目名（也是库里的显示名）
 * @property {'animation'|'component'|'saved'} kind
 * @property {string} title       人话摘要（CLI 打印用）
 * @property {string} source      入口 HTML 文件名
 * @property {string[]} assets    同目录下的资产文件名（CSS/SVG）
 * @property {import('./params.mjs').ParamSchema} params
 */

/**
 * 三条种子模板：animation / component / saved 各一条。
 *
 * 参数键名与模板 CSS 里的自定义属性一一对应（`duration` → `--duration`），
 * 文本参数用 `apply:{kind:'text'}` 指到具体节点——**没有一条依赖 JS 运行时**，
 * 所以 `instantiate()` 产出的覆盖直接落到 DOM 就能看见变化。
 *
 * @type {ReadonlyArray<SeedTemplate>}
 */
export const SEED_TEMPLATES = Object.freeze(/** @type {SeedTemplate[]} */ ([
  {
    slug: 'pulse',
    name: 'pulse',
    kind: 'animation',
    title: '脉冲圆点（周期/缓动/主色/文字/角标）',
    source: 'pulse.html',
    assets: ['pulse.css', 'dot.svg'],
    params: {
      duration: { type: 'number', min: 200, max: 4000, step: 100, default: 1200, label: '周期（ms）' },
      easing: { type: 'enum', options: ['ease-out', 'ease-in', 'linear'], default: 'ease-out', label: '缓动' },
      color: { type: 'color', default: '#3b82f6', label: '主色' },
      badge: { type: 'boolean', default: true, label: '显示角标' },
      label: { type: 'string', maxLength: 24, default: '脉冲', label: '文字', apply: { kind: 'text', selector: '.pulse-label' } }
    }
  },
  {
    slug: 'badge',
    name: 'badge',
    kind: 'component',
    title: '提示卡（标题/字号/主色/对齐）',
    source: 'badge.html',
    assets: ['badge.css', 'badge-mark.svg'],
    params: {
      title: { type: 'string', maxLength: 40, default: '新版本已就绪', label: '标题', apply: { kind: 'text', selector: '.badge-title' } },
      size: { type: 'number', min: 12, max: 28, step: 1, integer: true, default: 18, label: '标题字号' },
      accent: { type: 'color', default: '#22d3ee', label: '主色' },
      align: { type: 'enum', options: ['flex-start', 'center', 'flex-end'], default: 'flex-start', label: '对齐' }
    }
  },
  {
    slug: 'lower-third',
    name: 'lower-third',
    kind: 'saved',
    title: '人名条（标题/副标题/宽度/强调色/字重）',
    source: 'lower-third.html',
    assets: ['lower-third.css', 'stripe.svg'],
    params: {
      headline: { type: 'string', maxLength: 40, default: '今晚 8 点直播', label: '主标题', apply: { kind: 'text', selector: '.lt-headline' } },
      subline: { type: 'string', maxLength: 40, default: '阿宁说 · 第 12 期', label: '副标题', apply: { kind: 'text', selector: '.lt-subline' } },
      width: { type: 'number', min: 20, max: 90, step: 5, default: 55, label: '宽度（%）' },
      tint: { type: 'color', default: '#f59e0b', label: '强调色' },
      weight: { type: 'enum', options: ['400', '600', '700'], default: '700', label: '字重' }
    }
  }
]));

/**
 * 包内自检：**模板自己说的参数**与**手写 schema** 必须逐字段相等，且不许有墙钟。
 *
 * 这是「标注不是摆设」的反向保证：任何一边改了忘了另一边，安装就会红，而不是等到
 * 用户打开面板发现控件对不上。返回 `SEED_SCHEMA_DRIFT` / `SEED_DISCOVERY_FAILED` /
 * `SEED_NOT_DETERMINISTIC` / `SEED_SOURCE_MISSING` 之一。
 *
 * @param {string} [templatesRoot]
 * @returns {Promise<{ok: boolean, code: string|null, issues: {code: string, slug: string, path: string, key: string, detail: string}[], templates: {slug: string, params: string[], deterministic: boolean|null}[]}>}
 */
export async function verifySeedTemplates(templatesRoot) {
  const root = templatesRoot ? path.resolve(templatesRoot) : path.join(path.dirname(fileURLToPath(import.meta.url)), 'templates');
  /** @type {{code: string, slug: string, path: string, key: string, detail: string}[]} */
  const issues = [];
  /** @type {{slug: string, params: string[], deterministic: boolean|null}[]} */
  const templates = [];

  for (const tpl of SEED_TEMPLATES) {
    const dir = path.join(root, tpl.slug);
    /** @type {Record<string, string>} */
    const texts = {};
    let missing = false;
    for (const file of [tpl.source, ...tpl.assets]) {
      try {
        texts[file] = await fs.readFile(path.join(dir, file), 'utf8');
      } catch {
        issues.push({ code: 'SEED_SOURCE_MISSING', slug: tpl.slug, path: file, key: '', detail: `包内模板缺文件：${tpl.slug}/${file}` });
        missing = true;
      }
    }
    if (missing) continue;

    /* ① 墙钟：种子模板必须 deterministic（任务书：默认模板必须是 deterministic） */
    /** @type {string[]} */
    const clockFiles = [];
    for (const [file, text] of Object.entries(texts)) {
      const hits = scanSource(text, { file });
      for (const hit of hits) {
        clockFiles.push(`${file}:${hit.line} [${hit.rule}]`);
      }
    }
    if (clockFiles.length > 0) {
      issues.push({ code: 'SEED_NOT_DETERMINISTIC', slug: tpl.slug, path: '', key: '', detail: clockFiles.join('; ') });
    }

    /* ② 标注能不能重放出同一份 params */
    const found = discoverControls(texts[tpl.source] ?? '', { file: tpl.source });
    if (!found.ok) {
      issues.push({
        code: 'SEED_DISCOVERY_FAILED',
        slug: tpl.slug,
        path: tpl.source,
        key: '',
        detail: found.issues.map((issue) => `${issue.line}:${issue.code}${issue.key ? ` ${issue.key}` : ''}`).join('; ')
      });
      continue;
    }
    if (!isDeepStrictEqual(found.params, tpl.params)) {
      const hand = tpl.params;
      const auto = found.params;
      const keys = [...new Set([...Object.keys(hand), ...Object.keys(auto)])].filter((key) => !isDeepStrictEqual(hand[key], auto[key]));
      issues.push({
        code: 'SEED_SCHEMA_DRIFT',
        slug: tpl.slug,
        path: tpl.source,
        key: keys.join(','),
        detail: `手写与标注不一致：${keys.map((key) => `${key}（手写 ${JSON.stringify(hand[key])} / 标注 ${JSON.stringify(auto[key])}）`).join('；')}`
      });
    }
    /* 种子模板的全部文件都在 texts 里（读不到会走 SEED_SOURCE_MISSING 提前返回），
       所以这里扫得到就是定论：有命中 false、没命中 true。扫不到的模板不会走到这行。 */
    templates.push({ slug: tpl.slug, params: Object.keys(found.params), deterministic: clockFiles.length === 0 });
  }

  return { ok: issues.length === 0, code: issues[0]?.code ?? null, issues, templates };
}

/** @param {Date|number|string|undefined} now */
function toIso(now) {
  if (now === undefined) return new Date().toISOString();
  const d = now instanceof Date ? now : new Date(now);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

/** @param {string} file */
async function readTextOrNull(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 源里引用的本地资产 → 已存在的相对路径（找不到的跳过，交给 `validateLibrary` 报 MISSING_ASSET）。
 * @param {string} root
 * @param {string} sourceRel
 * @param {string} html
 * @returns {Promise<{ref: string, path: string}[]>}
 */
async function resolveAssets(root, sourceRel, html) {
  const baseDir = path.dirname(path.join(root, sourceRel));
  /** @type {{ref: string, path: string}[]} */
  const out = [];
  for (const ref of scanAssetRefs(html)) {
    const candidates = [path.resolve(baseDir, ref), path.resolve(root, ref.replace(/^\.?\//, ''))];
    /** @type {string|null} */
    let found = null;
    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        found = candidate;
        break;
      } catch {
        /* 下一个候选 */
      }
    }
    if (!found) continue;
    out.push({ ref, path: path.relative(root, found).split(path.sep).join('/') });
  }
  return out;
}

/**
 * 把种子模板装进一个工程。
 *
 * @param {string} projectDir 工程根（`film.html` 所在目录）
 * @param {{templatesRoot?: string, now?: Date|number|string, overwrite?: boolean}} [opts]
 * @returns {Promise<
 *   {ok: true, installed: string[], skipped: string[], libraryPath: string, libraryFile: string, hash: string, copied: string[], kept: string[], validation: Awaited<ReturnType<typeof validateLibrary>>, library: import('./library.mjs').Library}
 *   | {ok: false, code: string, installed: string[], skipped: string[], copied: string[], kept: string[], errors: {code: string, entryId: string, key: string, path: string, reason: string, detail: string}[], libraryPath: string}
 * >}
 */
export async function installSeedLibrary(projectDir, opts = {}) {
  const root = path.resolve(String(projectDir ?? ''));
  if (!root || root === path.parse(root).root) {
    return {
      ok: false,
      code: 'BAD_PROJECT_DIR',
      installed: [],
      skipped: [],
      copied: [],
      kept: [],
      errors: [],
      libraryPath: libraryPath(root)
    };
  }
  const templatesRoot = opts.templatesRoot
    ? path.resolve(opts.templatesRoot)
    : path.join(path.dirname(fileURLToPath(import.meta.url)), 'templates');

  /* 装之前先自检包内模板：标注与手写 schema 漂移、或模板有墙钟，就别往下写盘 */
  const selfCheck = await verifySeedTemplates(templatesRoot);
  if (!selfCheck.ok) {
    return {
      ok: false,
      code: selfCheck.code ?? 'SEED_SELF_CHECK_FAILED',
      installed: [],
      skipped: [],
      copied: [],
      kept: [],
      errors: selfCheck.issues.map((issue) => ({ code: issue.code, entryId: '', key: issue.key, path: issue.path, reason: issue.slug, detail: issue.detail })),
      libraryPath: libraryPath(root)
    };
  }

  /** slug → 扫描结论（true/false），用来给条目填 deterministic */
  const determinism = new Map();
  for (const item of selfCheck.templates) determinism.set(item.slug, item.deterministic);

  const { library } = await readLibrary(root);
  /** @type {string[]} */
  const installed = [];
  /** @type {string[]} */
  const skipped = [];
  /** @type {string[]} */
  const copied = [];
  /** @type {string[]} */
  const kept = [];
  /** @type {import('./library.mjs').LibraryEntry[]} */
  const nextEntries = [...library.entries];

  for (const tpl of SEED_TEMPLATES) {
    const sourceRel = `motion/assets/${tpl.slug}/${tpl.source}`;

    /* ① 先落文件（已存在同字节 / 内容不同但非 overwrite 都不动） */
    for (const file of [tpl.source, ...tpl.assets]) {
      const from = path.join(templatesRoot, tpl.slug, file);
      const to = path.join(root, 'motion/assets', tpl.slug, file);
      const rel = path.relative(root, to).split(path.sep).join('/');
      /** @type {string} */
      let text;
      try {
        text = await fs.readFile(from, 'utf8');
      } catch {
        return {
          ok: false,
          code: 'SEED_SOURCE_MISSING',
          installed,
          skipped,
          copied,
          kept,
          errors: [{ code: 'SEED_SOURCE_MISSING', entryId: '', key: '', path: from, reason: '', detail: `包内模板缺失：${from}` }],
          libraryPath: libraryPath(root)
        };
      }
      const current = await readTextOrNull(to);
      if (current === text) continue;
      if (current !== null && opts.overwrite !== true) {
        kept.push(rel);
        continue;
      }
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.writeFile(to, text, 'utf8');
      copied.push(rel);
    }

    const id = entryId(tpl.name, sourceRel);
    if (findEntry(library, id)) {
      skipped.push(tpl.name);
      continue;
    }

    /* ② 登记条目（hash / 资产 / 版本快照都按真实文件算） */
    const sourceText = await readTextOrNull(path.join(root, sourceRel));
    if (sourceText === null) {
      return {
        ok: false,
        code: 'SEED_SOURCE_MISSING',
        installed,
        skipped,
        copied,
        kept,
        errors: [{ code: 'SEED_SOURCE_MISSING', entryId: id, key: '', path: sourceRel, reason: '', detail: '复制后仍读不到模板源' }],
        libraryPath: libraryPath(root)
      };
    }
    const hash = sha256(sourceText);
    const snapshot = `motion/versions/${id}/${hash.slice(0, 12)}.html`;
    const snapshotAbs = path.join(root, snapshot);
    if ((await readTextOrNull(snapshotAbs)) === null) {
      await fs.mkdir(path.dirname(snapshotAbs), { recursive: true });
      await fs.writeFile(snapshotAbs, sourceText, 'utf8');
      copied.push(snapshot);
    }

    /** @type {import('./library.mjs').LibraryEntry} */
    const entry = {
      id,
      name: tpl.name,
      kind: tpl.kind,
      sourcePath: sourceRel,
      sourceHash: hash,
      assets: await resolveAssets(root, sourceRel, sourceText),
      params: tpl.params,
      /* 由 verifySeedTemplates 的实际扫描结果决定，不再写死 true：
         扫得到才有值，扫不到就留空（unknown），宿主据此决定要不要提示 */
      ...(typeof determinism.get(tpl.slug) === 'boolean' ? { deterministic: determinism.get(tpl.slug) } : {}),
      version: 1,
      createdAt: toIso(opts.now),
      history: [{ sourceHash: hash, version: 1, snapshot }]
    };
    const index = nextEntries.findIndex((item) => item.id === id);
    if (index >= 0) nextEntries[index] = entry;
    else nextEntries.push(entry);
    installed.push(tpl.name);
  }

  /* ③ 装完自校验：不通过就回滚这一轮复制的文件，不写库 */
  const next = { version: LIBRARY_VERSION, entries: nextEntries };
  const preCheck = await validateLibrary(root, next);
  if (!preCheck.ok) {
    for (const rel of copied) await fs.rm(path.join(root, rel), { force: true });
    return {
      ok: false,
      code: preCheck.code ?? 'SEED_INVALID',
      installed: [],
      skipped,
      copied: [],
      kept,
      errors: preCheck.errors,
      libraryPath: libraryPath(root)
    };
  }

  const written = await writeLibrary(root, next);

  /* ④ 写盘后再读一次再校验（返回的是落盘后的真相，不是内存里的乐观值） */
  const reread = await readLibrary(root);
  const validation = await validateLibrary(root, reread.library);
  return {
    ok: true,
    installed,
    skipped,
    libraryPath: libraryPath(root),
    libraryFile: written.file,
    hash: written.hash,
    copied,
    kept,
    validation,
    library: reread.library
  };
}

/**
 * CLI：`node packages/motion/seed.mjs <projectDir>`
 * @param {string[]} argv
 * @returns {Promise<number>} 退出码
 */
export async function seedCli(argv) {
  const projectDir = argv[0];
  if (!projectDir) {
    console.error('用法：node packages/motion/seed.mjs <projectDir>');
    return 1;
  }
  const result = await installSeedLibrary(projectDir);
  if (!result.ok) {
    console.error(`安装失败：${result.code}`);
    for (const issue of result.errors) {
      console.error(`  - ${issue.code}${issue.entryId ? ` [${issue.entryId}]` : ''}${issue.path ? ` ${issue.path}` : ''}${issue.detail ? `：${issue.detail}` : ''}`);
    }
    return 1;
  }
  console.log(`动效库：${result.libraryPath}`);
  console.log(`安装 ${result.installed.length} 条：${result.installed.join(' / ') || '（无）'}`);
  console.log(`跳过 ${result.skipped.length} 条：${result.skipped.join(' / ') || '（无）'}`);
  if (result.kept.length) console.log(`保留本地改动 ${result.kept.length} 个文件（不覆盖）：${result.kept.join(' / ')}`);
  console.log(`校验：${result.validation.ok ? '通过' : `失败（${result.validation.code}）`}，${result.validation.errors.length} 个问题`);
  return result.validation.ok ? 0 : 1;
}

const isMain = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isMain) {
  const code = await seedCli(process.argv.slice(2));
  process.exitCode = code;
}
