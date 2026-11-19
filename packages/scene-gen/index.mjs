/**
 * `packages/scene-gen` 入口（M93：从 `scripts/lib/scene-gen` 搬进产品包）。
 *
 * 三个生成器各管一类，都是**纯函数**：给规格，出 `ops` + `files`（要落盘的字节/文本）。
 * 它们不碰网络、不碰磁盘、不起 ffmpeg：
 *
 *   图表 `chart.mjs`   数 → 轴 + 柱（8×8 纯色 PNG，靠 box 拉伸）
 *   动画 `anim.mjs`    关键帧表 → 生成带 `frame(t)` 的页面 + `fade`
 *   素材 `asset.mjs`   颜色/尺寸/时长 → 渐变 PNG（`still`）/ 渐变 PNG + ffmpeg 参数（`video`）
 *
 * 一句话到规格的解析在 `parse.mjs`（小语法，见文件头）。
 *
 * `generateScene()` 是产品侧唯一入口：`provider-mock` 调它，`agent-scene` 负责把
 * `files` 写进工程、把 `ops` 交给现有 ops 执行器。**两端都不许说自己生成了真实 AI 场景。**
 */

import { animSpec } from './anim.mjs';
import { assetSpec } from './asset.mjs';
import { chartSpec } from './chart.mjs';
import { SCENE_GEN_CODES, sceneError } from './errors.mjs';
import { specFor } from './parse.mjs';

export { chartSpec, CHART_COLORS, CHART_MAX_VALUES, CHART_PLOT, CHART_STAGE } from './chart.mjs';
export { animSpec, ANIM_STAGE } from './anim.mjs';
export { assetSpec, gradientPng, parseHexColor } from './asset.mjs';
export { extractColors, extractKeyframes, extractSeconds, extractSeries, extractSize, specFor } from './parse.mjs';
export { SCENE_GEN_CODES, sceneError } from './errors.mjs';

/** 一句短哈希，用在素材子目录与 id 后缀上（同 prompt + seed 恒同）。 */
/** @param {unknown} value @param {number} [length] */
function shortHash(value, length = 6) {
  const text = String(value);
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.codePointAt(index) ?? 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').slice(0, length);
}

/**
 * 文档里已经用过的片段 id。
 * @param {any} doc
 * @returns {Set<string>}
 */
function usedIds(doc) {
  /** @type {Set<string>} */
  const used = new Set();
  for (const track of doc?.tracks ?? []) {
    for (const clip of track?.clips ?? []) {
      if (typeof clip?.id === 'string' && clip.id !== '') used.add(clip.id);
    }
  }
  return used;
}

/**
 * 把生成器里写死的 id（`axis-x`/`bar-0`/`anim`/`gen`）改成本工程里没人用过的 id。
 *
 * 为什么必须做：同一工程里画第二张图时，`axis-x` 已被占用，`insert` 会自己 mint 新 id，
 * 但后面引用旧 id 的 `props` 就会指到**上一张图**的片段上——写盘成功、画面错位。
 *
 * @param {any} doc
 * @param {any[]} ops
 * @returns {{ ops: any[], targets: string[], renamed: Array<{ from: string, to: string }> }}
 */
export function uniquifyClipIds(doc, ops) {
  const used = usedIds(doc);
  /** @type {Map<string, string>} */
  const map = new Map();
  /** @type {Array<{ from: string, to: string }>} */
  const renamed = [];
  /** @param {string} wanted */
  const mint = (wanted) => {
    if (map.has(wanted)) return map.get(wanted) ?? wanted;
    let next = wanted;
    if (used.has(next)) {
      let suffix = 2;
      while (used.has(`${wanted}-${String(suffix)}`)) suffix += 1;
      next = `${wanted}-${String(suffix)}`;
    }
    used.add(next);
    map.set(wanted, next);
    if (next !== wanted) renamed.push({ from: wanted, to: next });
    return next;
  };

  for (const op of ops) {
    if (op?.op === 'insert' && op.clip !== null && typeof op.clip === 'object' && typeof op.clip.id === 'string' && op.clip.id !== '') {
      mint(op.clip.id);
    }
  }

  /** @type {any[]} */
  const out = [];
  for (const op of ops) {
    const copy = { ...op };
    if (copy.op === 'insert' && copy.clip !== null && typeof copy.clip === 'object') {
      const clip = { ...copy.clip };
      if (typeof clip.id === 'string' && map.has(clip.id)) clip.id = map.get(clip.id);
      copy.clip = clip;
    } else if (typeof copy.clip === 'string' && map.has(copy.clip)) {
      copy.clip = map.get(copy.clip);
    } else if (copy.clip !== null && typeof copy.clip === 'object' && typeof copy.clip.id === 'string' && map.has(copy.clip.id)) {
      copy.clip = { ...copy.clip, id: map.get(copy.clip.id) };
    }
    if (Array.isArray(copy.edits)) {
      copy.edits = copy.edits.map((/** @type {any} */ edit) => {
        if (edit !== null && typeof edit === 'object' && typeof edit.clip === 'string' && map.has(edit.clip)) {
          return { ...edit, clip: map.get(edit.clip) };
        }
        return edit;
      });
    }
    out.push(copy);
  }

  return { ops: out, targets: [...map.values()], renamed };
}

/**
 * @typedef {{
 *   kind: 'chart' | 'animation' | 'asset',
 *   ops: any[],
 *   files: Array<{ path: string, data?: Buffer, text?: string }>,
 *   targets: string[],
 *   summary: string,
 *   warnings: string[],
 *   sources: Record<string, string>,
 *   renamed: Array<{ from: string, to: string }>,
 *   meta: any,
 * }} GeneratedScene
 */

/**
 * 产品侧唯一入口：一句话 + 工程 → 真场景（ops + 要落盘的素材）。
 *
 * @param {{ kind: 'chart' | 'animation' | 'asset', prompt: string, doc?: any, seed?: string }} input
 * @returns {GeneratedScene}
 */
export function generateScene(input) {
  const kind = input?.kind;
  const prompt = String(input?.prompt ?? '');
  const seed = String(input?.seed ?? '0');
  const doc = input?.doc ?? null;
  const { spec, sources } = specFor(kind, prompt, { stage: doc?.stage });

  /** @type {any} */
  let generated;
  /** @type {string[]} */
  const warnings = [];
  if (kind === 'chart') {
    const prefix = `gen-${shortHash(`${seed}|${prompt}`)}/`;
    /* 用工程自己的画幅（`doc.stage`）：产品里默认模板是 1920×1080，写死 1280×720
       会把柱子挤在左上角，导出后面积也对不上。 */
    generated = chartSpec({ ...spec, ...(doc?.stage !== undefined ? { stage: doc.stage } : {}), prefix });
  } else if (kind === 'animation') {
    generated = animSpec({ ...spec, ...(doc?.stage !== undefined ? { stage: doc.stage } : {}) });
  } else if (kind === 'asset') {
    generated = assetSpec({ ...spec, mode: 'still' });
    warnings.push('ASSET_AS_STILL');
  } else {
    throw sceneError(SCENE_GEN_CODES.UNKNOWN_INTENT, `不认识的场景类型：${String(kind)}`);
  }

  if (sources.values === 'default' && kind === 'chart') {
    warnings.push('VALUES_DEFAULT');
  }
  if (sources.keyframes === 'default' && kind === 'animation') {
    warnings.push('KEYFRAMES_DEFAULT');
  }
  if (kind === 'asset' && sources.colors === 'default') {
    warnings.push('COLORS_DEFAULT');
  }

  const renamedResult = uniquifyClipIds(doc, generated.ops);
  const count = generated.meta?.count ?? generated.meta?.keyframes?.length ?? 0;

  /** @type {Record<string, string>} */
  const summaryByKind = {
    chart: `画了一张柱状图：${String(count)} 根柱，柱高按最大值归一（本地生成器产出，不是远端模型）`,
    animation: `生成了一个位移动画页面：${String(count)} 个关键帧、${String(generated.meta?.durationSec ?? 0)}s（页面内逐帧位移，产品无关键帧轨道）`,
    asset: `生成了一张 ${String(generated.meta?.w ?? 0)}×${String(generated.meta?.h ?? 0)} 的渐变素材，插入为 ${String(generated.meta?.seconds ?? 0)}s 静帧（本地生成器产出，不经 ffmpeg）`,
  };

  return {
    kind: /** @type {any} */ (kind),
    ops: renamedResult.ops,
    files: generated.files,
    targets: renamedResult.targets,
    summary: summaryByKind[kind] ?? '',
    warnings,
    sources: /** @type {any} */ (sources),
    renamed: renamedResult.renamed,
    meta: generated.meta,
  };
}
