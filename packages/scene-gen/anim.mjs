/**
 * animSpec · 关键帧表 → 生成那个带 `frame(t)` 的页面（M87-WP21，M93 搬进产品包）
 *
 * **页面由规格生成**，`window.film.frame(t)` 里的关键帧表就是调用方给的那张表。
 *
 * 口径（和 M86 复核结论一致，别糊过去）：
 * - **位移**由生成的页面自己按 `frame(t)` 算（分段线性 / easeOutCubic）；
 *   产品侧 `packages/film-core`、`packages/render` 里**没有 keyframe 概念**，grep 0 命中。
 *   所以「关键帧」在本产品里的落地方式就是**页面内的逐帧位移**，不是时间线上的关键帧轨道。
 * - **淡入**走产品通道：`op:'props'` 写 `fade:[in,out]`；
 * - 片段时长 = 关键帧表的最后一个 `t` —— 改一个关键帧时间点，片段时长跟着变，
 *   这一点在 `meta.durationSec` 与 `ops[0].clip.time` 里都能读到。
 *
 * 生成的是**纯文本**（一个自包含 html），调用方写到 `assets/`，ops 里只引相对路径。
 */

import { SCENE_GEN_CODES, sceneError } from './errors.mjs';

export const ANIM_STAGE = Object.freeze({ w: 1280, h: 720 });

/** 与产品侧 `deterministicRandom` 无关的独立小工具：生成器不依赖产品模块。 */
/** @param {unknown} value @param {number} [length] */
function stableHex(value, length = 8) {
  const text = String(value);
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.codePointAt(index) ?? 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').slice(0, length);
}

/**
 * @typedef {{ t: number, x: number }} Keyframe
 * @typedef {{
 *   kind: 'animation',
 *   id: string,
 *   html: string,
 *   files: Array<{ path: string, text: string }>,
 *   ops: any[],
 *   meta: {
 *     keyframes: Keyframe[],
 *     count: number,
 *     curve: 'linear' | 'ease',
 *     fade: [number, number],
 *     size: { w: number, h: number },
 *     stage: { w: number, h: number },
 *     durationSec: number,
 *     displacementSec: number,
 *     path: { x: number, y: number, w: number, h: number },
 *   },
 * }} AnimSpecResult
 */

/**
 * @param {{
 *   keyframes: Keyframe[],
 *   fade?: [number, number],
 *   size?: { w: number, h: number },
 *   curve?: 'linear' | 'ease',
 *   stage?: { w: number, h: number },
 *   color?: string,
 * }} input
 * @returns {AnimSpecResult}
 */
export function animSpec(input) {
  const keys = Array.isArray(input?.keyframes) ? input.keyframes : [];
  if (keys.length < 2) throw sceneError(SCENE_GEN_CODES.BAD_KEYFRAMES, 'animSpec 需要至少两个关键帧');
  let previous = -Infinity;
  const keyframes = keys.map((key, index) => {
    const t = Number(key?.t);
    const x = Number(key?.x);
    if (!Number.isFinite(t) || !Number.isFinite(x)) {
      throw sceneError(SCENE_GEN_CODES.BAD_KEYFRAMES, `animSpec keyframes[${String(index)}] 的 t/x 不是有限数`);
    }
    if (t <= previous) {
      throw sceneError(
        SCENE_GEN_CODES.BAD_KEYFRAME_ORDER,
        `animSpec keyframes 的 t 必须严格递增（第 ${String(index)} 个是 ${String(t)}）`,
      );
    }
    previous = t;
    return { t, x };
  });

  const stage = input?.stage ?? ANIM_STAGE;
  const size = input?.size ?? { w: 160, h: 160 };
  const curve = input?.curve === 'ease' ? 'ease' : 'linear';
  const color = typeof input?.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.color) ? input.color : '#ffd166';
  const first = keyframes[0] ?? { t: 0, x: 0 };
  const last = keyframes[keyframes.length - 1] ?? first;
  const durationSec = last.t;
  const displacementSec = Number((last.t - first.t).toFixed(6));
  const fade = Array.isArray(input?.fade) && input.fade.length === 2 && input.fade.every((item) => Number.isFinite(Number(item)))
    ? /** @type {[number, number]} */ ([Number(input.fade[0]), Number(input.fade[1])])
    : /** @type {[number, number]} */ ([durationSec, 0]);
  const top = Math.round((stage.h - size.h) / 2);
  const id = `anim-${stableHex(JSON.stringify({ keyframes, curve, size }))}`;

  const html = renderAnimPage({ keyframes, curve, size, stage, top, color, durationSec });

  /** @type {any[]} */
  const ops = [
    {
      op: 'insert',
      clip: {
        id: 'anim',
        src: `assets/${id}.html`,
        kind: 'page',
        time: [0, durationSec],
        box: { x: 0, y: 0, w: stage.w, h: stage.h },
      },
      track: { insert: 0 },
    },
    { op: 'props', edits: [{ clip: 'anim', prop: 'fade', value: fade }] },
  ];

  return {
    kind: 'animation',
    id,
    html,
    files: [{ path: `assets/${id}.html`, text: html }],
    ops,
    meta: {
      keyframes,
      count: keyframes.length,
      curve,
      fade,
      size,
      stage,
      durationSec,
      displacementSec,
      path: { x: first.x, y: top, w: last.x + size.w - first.x, h: size.h },
    },
  };
}

/**
 * 页面是**生成**的：关键帧表、尺寸、时长、颜色全部来自规格。
 * @param {{
 *   keyframes: Keyframe[],
 *   curve: 'linear' | 'ease',
 *   size: { w: number, h: number },
 *   stage: { w: number, h: number },
 *   top: number,
 *   color: string,
 *   durationSec: number,
 * }} input
 */
function renderAnimPage(input) {
  const { keyframes, curve, size, stage, top, color, durationSec } = input;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
  html, body { margin: 0; width: ${String(stage.w)}px; height: ${String(stage.h)}px; background: #000; overflow: hidden; }
  #mover { position: absolute; left: 0; top: ${String(top)}px; width: ${String(size.w)}px; height: ${String(size.h)}px; background: ${color}; }
</style></head>
<body><div id="mover"></div>
<script>
  var el = document.getElementById('mover');
  var K = ${JSON.stringify(keyframes)};
  var CURVE = '${curve}';
  function lerp(a, b, k) { return a + (b - a) * k; }
  function easeOutCubic(k) { return 1 - Math.pow(1 - k, 3); }
  function posAt(t) {
    if (t <= K[0].t) return K[0].x;
    if (t >= K[K.length - 1].t) return K[K.length - 1].x;
    for (var i = 1; i < K.length; i += 1) {
      if (t <= K[i].t) {
        var k = (t - K[i - 1].t) / (K[i].t - K[i - 1].t);
        var e = CURVE === 'ease' ? easeOutCubic(k) : k;
        return lerp(K[i - 1].x, K[i].x, e);
      }
    }
    return K[K.length - 1].x;
  }
  window.film = {
    duration: ${String(durationSec)},
    frame: async function (t) {
      el.style.transform = 'translateX(' + posAt(t) + 'px)';
      return true;
    },
  };
</script></body></html>`;
}
