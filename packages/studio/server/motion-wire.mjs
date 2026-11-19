/**
 * 动效面板的宿主适配（M27 · B-MAIN-R14-014）
 *
 * 副线1 的 `packages/motion/panel.mjs` 是**冻结接口**：`mountMotionPanel(container, {loadLibrary,
 * applyEntry, onApplied, onError, style})`。它不读盘、不写 `film.html`——数据由宿主给，写盘也由宿主做。
 * 这里就是那半边：
 *
 * 1. `libraryView()`：`readLibrary` → `listEntries` → 拍平成 `MotionEntryView[]`（面板只认这个形状）。
 * 2. `planMotionApply()`：校验模板/参数/片段 → 把参数折成 `overrides` 条目 → 产出**一批 props Op**。
 *    真正的落盘由宿主的 `/ops` 执行（一处写盘、一步撤销），本模块不发请求、不写文件。
 *
 * ## 参数落到哪里（只用 film.html 已有的表达）
 *
 * `overrides` 是 `film.html` 早就有的层覆盖数组（`{at, style, text, …}`），条目的 `at` 在**场景文档**
 * 里解析（预览 content-origin 的 `applyOverridesNow` 在 `frame(t)` 之后跑）。所以：
 *
 * - 实例根节点在场景里有 `data-instance="<clipId>"` → `at` 就用它；
 * - 否则退到 `body`（CSS 自定义属性会继承给所有后代，`--speed` 这类参数照样生效）。
 *   用的是哪一档会写进返回值（`rootAt` / `scope`），不静默。
 *
 * 参数名 → CSS 自定义属性的映射完全走 `motion/params.mjs` 的 `overridesOf`（**不各写一套**）。
 * `data-props` 一并写回（template/version/sourceHash/values）：那是 Reopen 时读回实例的方式，
 * 属于 `film-doc` 允许原样保留的 `data-*`。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  checkAssets,
  scanAssetRefs,
  checkSource,
  deleteTemplate,
  findEntry,
  listEntries,
  readLibrary,
  rollbackTemplate,
  saveAsTemplate,
  stableJson,
  upgradeTemplate,
} from '../../motion/library.mjs';
import { propsOf } from '../../motion/library.mjs';
import { describeIssues, overridesOf, validateParams } from '../../motion/params.mjs';

/** 面板能显示的三种条目类型（与 `library.mjs` 的 ENTRY_KINDS 一致）。 */
const KINDS = new Set(['animation', 'component', 'saved']);

/** 参数类型白名单（`normalizeParams` 同口径；未知类型按 string 显示，校验会另报 INVALID_SCHEMA）。 */
const PARAM_TYPES = new Set(['number', 'string', 'boolean', 'color', 'enum']);

/**
 * `ParamSpec` → `MotionParamView`（`label ?? key`、type、default、min/max/step、options）。
 * @param {string} key
 * @param {any} spec
 */
function paramView(key, spec) {
  const record = spec !== null && typeof spec === 'object' ? spec : {};
  const type = PARAM_TYPES.has(String(record.type)) ? String(record.type) : 'string';
  /** @type {any} */
  const view = { name: key, label: typeof record.label === 'string' && record.label ? record.label : key, type };
  if (record.default !== undefined) view.default = record.default;
  if (typeof record.min === 'number') view.min = record.min;
  if (typeof record.max === 'number') view.max = record.max;
  if (typeof record.step === 'number') view.step = record.step;
  if (type === 'enum') view.options = Array.isArray(record.options) ? record.options.filter((/** @type {any} */ item) => typeof item === 'string') : [];
  return view;
}

/**
 * `LibraryStatus` → `MotionEntryView`（照副线1 的 hostWiring 五条）。
 *
 * `current`（可选）= 当前片段 `data-props` 里的值：**只给同 id 的条目**把 `default` 换成当前值。
 * 这是「重开回填」的落点——面板的 `seedDraft` 用 `view.default` 填表单，接口一个字段都不用加。
 *
 * @param {{entry: any, status: string, missingAssets: any[]}} status
 * @param {{template: string, values: Record<string, unknown>}|null} [current]
 */
function entryView(status, current = null) {
  const entry = status.entry;
  const inject = current !== null && current.template === entry.id ? current.values : null;
  /** @type {any} */
  const view = {
    id: entry.id,
    name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id,
    kind: KINDS.has(entry.kind) ? entry.kind : 'component',
    sourceOk: status.status !== 'source-missing' && entry.archived !== true,
    assetIssues: status.missingAssets.map((item) => ({ path: String(item.path ?? item.ref ?? ''), reason: 'missing' })),
    params: Object.entries(entry.params ?? {}).map(([key, spec]) => {
      const param = paramView(key, spec);
      if (inject !== null && Object.prototype.hasOwnProperty.call(inject, key)) param.default = inject[key];
      return param;
    }),
  };
  /* 副线1 1.1.0 的两个**可选**字段（面板据此显示「不受帧驱动」警示与预期时长）：
     三态（true / false / 未知）要原样透传——未知不能默认成 true，那等于替作者撒谎。 */
  if (typeof entry.deterministic === 'boolean') view.deterministic = entry.deterministic;
  if (typeof entry.expectedDurationMs === 'number' && Number.isFinite(entry.expectedDurationMs)) {
    view.expectedDurationMs = entry.expectedDurationMs;
  }
  return view;
}

/**
 * 管理视图（宿主自己的列表，不经过冻结的面板接口）：
 * 版本号、旧版本数、归档态、状态、源路径、参数个数。
 * @param {{entry: any, status: string, missingAssets: any[]}} status
 */
function manageView(status) {
  const entry = status.entry;
  const history = Array.isArray(entry.history) ? entry.history : [];
  return {
    id: entry.id,
    name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id,
    kind: KINDS.has(entry.kind) ? entry.kind : 'component',
    version: Number(entry.version) || 1,
    historyCount: Math.max(0, history.length - 1),
    archived: entry.archived === true,
    status: status.status,
    sourcePath: entry.sourcePath,
    paramCount: Object.keys(entry.params ?? {}).length,
    sourceHash: entry.sourceHash,
  };
}

/**
 * 读工程内的动效库并拍平成面板要的形状。
 *
 * 文件不存在不是错误（空库 + `missing:true`，面板显示「库里还没有动效模板」+ 重试）；
 * 损坏要单独标出来（`corrupt:true`），不能静默重建。
 *
 * @param {string} root 工程目录
 * @param {{includeArchived?: boolean, clipProps?: {template: string, values: Record<string, unknown>}|null}} [opts]
 * @returns {Promise<{ ok: boolean, entries: any[], all: any[], exists: boolean, corrupt: boolean, error?: {code: string, message: string} }>}
 */
export async function libraryView(root, opts = {}) {
  try {
    const read = await readLibrary(root);
    const includeArchived = opts.includeArchived === true;
    // 面板默认不显示已归档（任务书：归档后默认不显示，可切换查看）；管理列表两头都要。
    const statuses = await listEntries(root, read.library, { includeArchived: true });
    const current = opts.clipProps ?? null;
    const panelStatuses = includeArchived ? statuses : statuses.filter((/** @type {any} */ item) => item.entry.archived !== true);
    return {
      ok: true,
      entries: panelStatuses.map((/** @type {any} */ item) => entryView(item, current)),
      all: statuses.map(manageView),
      exists: read.exists === true,
      corrupt: read.corrupt === true,
    };
  } catch (error) {
    return {
      ok: false,
      entries: [],
      all: [],
      exists: false,
      corrupt: false,
      error: { code: 'MOTION_LIBRARY_UNREADABLE', message: String(/** @type {any} */ (error)?.message ?? error).slice(0, 300) },
    };
  }
}

/** 工程相对路径 → 绝对路径；越界返回 null。 @param {string} root @param {string} rel */
function insideRoot(root, rel) {
  const abs = path.resolve(root, rel);
  const base = path.resolve(root);
  return abs === base || abs.startsWith(`${base}${path.sep}`) ? abs : null;
}

/**
 * 场景里有没有 `data-instance="<clipId>"` 这个挂载点；有就用它，没有就落到 `body`。
 * @param {string} root
 * @param {any} clip
 * @returns {Promise<{ ok: true, rootAt: string, scope: 'instance'|'body', scene: string } | { ok: false, code: string, message: string }>}
 */
async function resolveRootAt(root, clip) {
  const bare = String(clip?.src ?? '').split(/[?#]/)[0] ?? '';
  const abs = insideRoot(root, bare);
  if (abs === null || !/\.html?$/i.test(bare)) {
    return { ok: false, code: 'MOTION_SCENE_UNSUPPORTED', message: `片段 ${String(clip?.id ?? '')} 的 src 不是工程内的场景文件：${String(clip?.src ?? '')}` };
  }
  let html;
  try {
    html = await fs.readFile(abs, 'utf8');
  } catch (error) {
    return {
      ok: false,
      code: 'MOTION_SCENE_MISSING',
      message: `场景文件读不了：${bare}（${String(/** @type {any} */ (error)?.message ?? error).slice(0, 120)}）`,
    };
  }
  const id = String(clip?.id ?? '');
  const selector = `[data-instance="${id}"]`;
  const needle = new RegExp(`data-instance\\s*=\\s*("|')${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`);
  return needle.test(html)
    ? { ok: true, rootAt: selector, scope: 'instance', scene: bare }
    : { ok: true, rootAt: 'body', scope: 'body', scene: bare };
}

/**
 * 规划一次「应用动效」：校验 → 参数折成层覆盖 → 一批 props Op。
 *
 * **不写盘**：返回的 `ops` 交给宿主的 `/ops`（一次提交 = 一步撤销）。
 *
 * @param {{ project: { dir: string }, doc: any, clipId: string, entryId: string, params?: unknown }} input
 * @returns {Promise<{ ok: true, ops: any[], values: Record<string, unknown>, overrides: any[], rootAt: string, scope: string, scene: string, template: {id: string, version: number}, changed: boolean }
 *   | { ok: false, code: string, message: string, issues?: any[], missing?: any[] }>}
 */
export async function planMotionApply(input) {
  const root = input?.project?.dir;
  const clipId = String(input?.clipId ?? '');
  const entryId = String(input?.entryId ?? '');
  if (!root) return { ok: false, code: 'MOTION_NO_PROJECT', message: '工程未打开' };
  if (!clipId) return { ok: false, code: 'MOTION_CLIP_NOT_FOUND', message: 'clipId 不能为空' };
  if (!entryId) return { ok: false, code: 'MOTION_TEMPLATE_MISSING', message: 'entryId 不能为空' };

  const read = await readLibrary(root);
  const entry = findEntry(read.library, entryId);
  if (entry === null) return { ok: false, code: 'MOTION_TEMPLATE_MISSING', message: `模板不存在：${entryId}` };
  if (entry.archived === true) return { ok: false, code: 'MOTION_TEMPLATE_ARCHIVED', message: `模板已归档：${entry.name}` };

  const source = await checkSource(root, entry);
  if (source.status === 'missing') {
    return { ok: false, code: 'MOTION_SOURCE_MISSING', message: `模板源不在了：${entry.sourcePath}` };
  }
  const assets = await checkAssets(root, entry);
  const missing = assets.filter((/** @type {any} */ item) => !item.exists).map((/** @type {any} */ item) => ({ ref: item.ref, path: item.path }));
  if (missing.length > 0) {
    return { ok: false, code: 'MOTION_ASSET_MISSING', message: `模板依赖缺失：${missing.map((/** @type {any} */ item) => item.ref).join(', ')}`, missing };
  }

  const clips = (Array.isArray(input?.doc?.tracks) ? input.doc.tracks : []).flatMap((/** @type {any} */ track) => track.clips ?? []);
  const clip = clips.find((/** @type {any} */ item) => item.id === clipId) ?? null;
  if (clip === null) return { ok: false, code: 'MOTION_CLIP_NOT_FOUND', message: `片段不存在：${clipId}` };
  if ((clip.kind ?? '') !== 'page') {
    return {
      ok: false,
      code: 'MOTION_CLIP_UNSUPPORTED',
      message: `动效参数只能落在网页/场景片段（page）上，${clipId} 是 ${clip.kind ?? 'video'}`,
    };
  }

  const checked = validateParams(entry.params ?? {}, input?.params ?? {});
  if (!checked.ok) {
    return { ok: false, code: 'MOTION_INVALID_PARAM', message: describeIssues(checked.errors), issues: checked.errors };
  }

  const rootAt = await resolveRootAt(root, clip);
  if (rootAt.ok !== true) return { ok: false, code: rootAt.code, message: rootAt.message };

  // `overridesOf` 现在直接给 `{at, style}` / `{at, t}`（S29 把 `text` → `t` 的接缝在
  // packages/motion 侧修掉了），宿主**不再需要归一字段名**——R14 那个 text→t 的适配层已删。
  const fresh = overridesOf(entry.params ?? {}, checked.values, rootAt.rootAt);
  const keep = (Array.isArray(clip.overrides) ? clip.overrides : []).filter((/** @type {any} */ item) => {
    if (item === null || typeof item !== 'object') return false;
    if (item.at === undefined) return true; // 片段自有的 fade：不归动效管
    const at = String(item.at);
    return at !== rootAt.rootAt && !at.startsWith(`${rootAt.rootAt} `);
  });
  const merged = [...keep, ...fresh];

  /** @type {any[]} */
  const edits = [
    { clip: clipId, prop: 'overrides', value: merged.length === 0 ? null : merged },
    {
      clip: clipId,
      prop: 'props',
      value: stableJson({ template: entry.id, version: entry.version, sourceHash: entry.sourceHash, values: checked.values }),
    },
  ];

  return {
    ok: true,
    ops: [{ op: 'props', edits }],
    values: checked.values,
    overrides: fresh,
    rootAt: rootAt.rootAt,
    scope: rootAt.scope,
    scene: rootAt.scene,
    template: { id: entry.id, version: entry.version },
    changed: fresh.length > 0,
  };
}

/* ── 模板管理（M30）──────────────────────────────────────────────────
 * 能力全在 `packages/motion/library.mjs`（saveAsTemplate / upgradeTemplate /
 * rollbackTemplate / deleteTemplate）。宿主只做三件事：
 *   1. 把「当前片段」翻译成引擎要的参数（源路径、参数 schema）；
 *   2. 另存后把**被引用的资产**复制到新源旁边（引擎只复制 html，不搬资产；
 *      源从 `scenes/x.html` 换到 `scenes/y.html` 时，相对引用会解析不到）；
 *   3. 把引擎的返回值整理成 UI 能直接显示的形状。错误码一个都不新造。
 */

/**
 * 片段当前挂的模板与参数（`data-props`）；没有就是 null。
 * 面板的「重开回填」用它把当前值塞进 `default`。
 * @param {any} doc @param {string} clipId
 * @returns {{template: string, values: Record<string, unknown>}|null}
 */
export function clipPropsOf(doc, clipId) {
  const clip = allClipsOf(doc).find((/** @type {any} */ item) => item?.id === clipId) ?? null;
  if (clip === null) return null;
  const props = propsOf(clip.attrs);
  if (props === null) return null;
  return { template: props.template, values: props.values };
}

/** 文档里的全部片段（拍平）。 @param {any} doc */
function allClipsOf(doc) {
  return (Array.isArray(doc?.tracks) ? doc.tracks : []).flatMap((/** @type {any} */ track) => (Array.isArray(track?.clips) ? track.clips : []));
}

/**
 * 片段 → 场景源（工程内相对路径）。
 * @param {string} root @param {any} doc @param {string} clipId
 * @returns {{ok: true, clip: any, src: string, abs: string} | {ok: false, code: string, message: string}}
 */
function sceneOf(root, doc, clipId) {
  const clip = allClipsOf(doc).find((/** @type {any} */ item) => item?.id === clipId) ?? null;
  if (clip === null) return { ok: false, code: 'MOTION_CLIP_NOT_FOUND', message: `片段不存在：${clipId}` };
  if ((clip.kind ?? '') !== 'page') {
    return { ok: false, code: 'MOTION_SCENE_UNSUPPORTED', message: `只有网页/场景片段能存成模板（${clipId} 是 ${clip.kind ?? 'video'}）` };
  }
  const src = String(clip.src ?? '').split(/[?#]/)[0] ?? '';
  const abs = insideRoot(root, src);
  if (abs === null || !/\.html?$/i.test(src)) {
    return { ok: false, code: 'MOTION_SCENE_UNSUPPORTED', message: `片段 ${clipId} 的 src 不是工程内的场景文件：${clip.src}` };
  }
  return { ok: true, clip, src, abs };
}

/** @param {string} abs */
async function fileExists(abs) {
  try {
    await fs.stat(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把被引用的资产复制到新源旁边（保持相对路径不变）。
 *
 * 为什么必须做：`saveAsTemplate` 只复制 html；如果源里有 `pulse.css`、`art/x.svg`，
 * 新模板落到 `scenes/` 之后这些相对引用会指向 `scenes/pulse.css`（不存在）。
 * 引擎的 `checkAssets` 会如实报 MISSING_ASSET，但那时模板已经不能用了。
 *
 * @param {string} root @param {string} fromAbs @param {string} destAbs
 * @returns {Promise<{copied: string[], missing: string[]}>}
 */
async function mirrorAssets(root, fromAbs, destAbs) {
  const html = await fs.readFile(destAbs, 'utf8');
  const refs = scanAssetRefs(html);
  const fromDir = path.dirname(fromAbs);
  const destDir = path.dirname(destAbs);
  const copied = [];
  const missing = [];
  for (const ref of refs) {
    const src = path.resolve(fromDir, ref);
    const rootCandidate = path.resolve(root, ref.replace(/^\.?\//, ''));
    /** @type {string|null} */
    let found = null;
    for (const candidate of [src, rootCandidate]) {
      if (await fileExists(candidate)) {
        found = candidate;
        break;
      }
    }
    if (found === null) {
      missing.push(ref);
      continue;
    }
    const dest = path.resolve(destDir, ref);
    if (dest === found || (await fileExists(dest))) continue;
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(found, dest);
    copied.push(path.relative(root, dest).split(path.sep).join('/'));
  }
  return { copied, missing };
}

/**
 * 另存为模板：以当前 page 片段的场景为源，复制成 `scenes/<name>.html`（引擎决定的落点），
 * 参数 schema 沿用它当前挂的模板（`data-props.template`）。
 *
 * @param {{ project: { dir: string }, doc: any, clipId: string, name: string, kind?: string }} input
 */
export async function planMotionSave(input) {
  const root = input?.project?.dir;
  if (!root) return { ok: false, code: 'MOTION_NO_PROJECT', message: '工程未打开' };
  const name = String(input?.name ?? '').trim();
  if (name === '') return { ok: false, code: 'INVALID_NAME', message: '模板名不能为空' };
  const scene = sceneOf(root, input?.doc, String(input?.clipId ?? ''));
  if (scene.ok !== true) return scene;

  const read = await readLibrary(root);
  if (read.corrupt === true) {
    return { ok: false, code: 'MOTION_LIBRARY_CORRUPT', message: 'motion/library.json 损坏：先修库再存模板（不静默重建）' };
  }
  const current = propsOf(scene.clip.attrs);
  const base = current === null ? null : findEntry(read.library, current.template);
  const params = base === null ? {} : (base.params ?? {});

  const saved = await saveAsTemplate(root, {
    name,
    kind: /** @type {'saved'} */ (input?.kind ?? 'saved'),
    from: scene.src,
    params,
    onConflict: 'reject',
  });
  if (saved.ok !== true) return saved;

  const mirrored = saved.reused === true ? { copied: [], missing: [] } : await mirrorAssets(root, scene.abs, saved.dest);
  const after = await readLibrary(root);
  const entry = findEntry(after.library, saved.entry.id);
  const assets = entry === null ? [] : await checkAssets(root, entry);
  const assetIssues = assets.filter((/** @type {any} */ item) => !item.exists).map((/** @type {any} */ item) => ({ ref: item.ref, path: item.path }));

  return {
    ok: true,
    entry: {
      id: saved.entry.id,
      name: saved.entry.name,
      kind: saved.entry.kind,
      version: saved.entry.version,
      sourcePath: saved.entry.sourcePath,
      paramCount: Object.keys(saved.entry.params ?? {}).length,
      historyCount: Math.max(0, (saved.entry.history ?? []).length - 1),
    },
    dest: path.relative(root, saved.dest).split(path.sep).join('/'),
    reused: saved.reused === true,
    paramsSource: base === null ? 'empty' : base.id,
    copiedAssets: mirrored.copied,
    missingAssets: mirrored.missing,
    assetIssues,
    libraryHash: saved.hash,
  };
}

/**
 * 升级：源被外部改过之后存一个新版本（引擎按 sourceHash 判断有没有变化）。
 * @param {{ project: { dir: string }, entryId: string }} input
 */
export async function planMotionUpgrade(input) {
  const root = input?.project?.dir;
  if (!root) return { ok: false, code: 'MOTION_NO_PROJECT', message: '工程未打开' };
  const read = await readLibrary(root);
  if (read.corrupt === true) return { ok: false, code: 'MOTION_LIBRARY_CORRUPT', message: 'motion/library.json 损坏' };
  const result = await upgradeTemplate(root, read.library, String(input?.entryId ?? ''));
  if (result.ok !== true) return result;
  const entry = findEntry(result.library, String(input?.entryId ?? ''));
  return {
    ok: true,
    entryId: String(input?.entryId ?? ''),
    from: result.from,
    to: result.to,
    version: result.version,
    historyCount: Math.max(0, (entry?.history ?? []).length - 1),
  };
}

/**
 * 回退：把上一版快照写回源文件（源字节与旧版一致，舞台重载后表现可复现）。
 * @param {{ project: { dir: string }, entryId: string }} input
 */
export async function planMotionRollback(input) {
  const root = input?.project?.dir;
  if (!root) return { ok: false, code: 'MOTION_NO_PROJECT', message: '工程未打开' };
  const read = await readLibrary(root);
  if (read.corrupt === true) return { ok: false, code: 'MOTION_LIBRARY_CORRUPT', message: 'motion/library.json 损坏' };
  const result = await rollbackTemplate(root, read.library, String(input?.entryId ?? ''));
  if (result.ok !== true) return result;
  const entry = findEntry(result.library, String(input?.entryId ?? ''));
  return {
    ok: true,
    entryId: String(input?.entryId ?? ''),
    restoredHash: result.restoredHash,
    version: result.version,
    historyCount: Math.max(0, (entry?.history ?? []).length - 1),
  };
}

/**
 * 归档：不物理删。仍被实例引用时**拒绝**并给出引用者（引擎的 TEMPLATE_IN_USE）。
 * @param {{ project: { dir: string }, doc: any, entryId: string }} input
 */
export async function planMotionArchive(input) {
  const root = input?.project?.dir;
  if (!root) return { ok: false, code: 'MOTION_NO_PROJECT', message: '工程未打开' };
  const entryId = String(input?.entryId ?? '');
  const read = await readLibrary(root);
  if (read.corrupt === true) return { ok: false, code: 'MOTION_LIBRARY_CORRUPT', message: 'motion/library.json 损坏' };
  const referencedBy = allClipsOf(input?.doc)
    .map((/** @type {any} */ clip) => ({ clipId: String(clip?.id ?? ''), props: propsOf(clip?.attrs) }))
    .filter((/** @type {any} */ item) => item.props !== null && item.props.template === entryId)
    .map((/** @type {any} */ item) => item.clipId)
    .sort();
  const result = await deleteTemplate(root, read.library, entryId, { referencedBy });
  if (result.ok !== true) return result;
  return {
    ok: true,
    entryId,
    archived: true,
    referencedBy,
    version: Number(findEntry(result.library, entryId)?.version) || 1,
  };
}
