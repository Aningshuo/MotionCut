/**
 * 覆盖应用（副线1 · S9 变换合成）
 *
 * 顺序固定：**先** `film.frame(t)`（场景自己的动画把画面画到 t），**再**应用覆盖。
 * 反过来做，动画的最后一笔会把覆盖擦掉——所以这里不提供「先覆盖再取帧」的开关。
 *
 * ## 变换所有权（S9 起，谁写哪个属性）
 *
 * | 属性 | 写入者 | 说明 |
 * |---|---|---|
 * | `transform` | **场景**（`frame(t)` 里写） | 本应用器**从不写** `transform`，也不读它做解析 |
 * | `scale` | **覆盖**（本应用器） | CSS 个体变换属性，`s` 写成 `scale(sx sy)` |
 * | `rotate` | **覆盖**（本应用器） | CSS 个体变换属性，`r` 写成 `rotate(r deg)` |
 * | `translate` | 场景 | 与本批无关；同时存在时按 CSS 规定参与合成 |
 *
 * 因为写的是两个**不同**的属性，场景动画与覆盖天然叠加，不需要每帧重算矩阵：
 * 浏览器合成顺序由 CSS Transforms Level 2 写死为
 * `translate → rotate → scale → transform`，即
 *
 *     M = T(scene) · R(覆盖 r) · S(覆盖 s) · M(scene transform)
 *
 * 本模块只用其中 `rotate`/`scale` 两段，场景的 `transform` 原样留在矩阵最右侧。
 * 注意：均匀缩放时 `R·S` 与旧的 `S·R`（`transform: scale() rotate()`）数值等价；
 * 非均匀 `s=[sx,sy]` 且 `r≠0` 时两者顺序不同，本模块固定为 `R·S`——顺序写死比"看起来一样"重要。
 *
 * ## 清除语义（幂等 + 回到场景值）
 *
 * - 同一组 entries 连续应用两次：写的是同样的属性值，computed 矩阵逐位不变（不累积）。
 * - 本应用器写过的元素带 `data-ov-transform`（值 = 自己占用的属性名，如 `scale rotate`）
 *   与 `data-ov-at`（自己的定位串）。传入的 entries 不再包含某个 `at` 的 s/r 时，
 *   扫描这些标记，把**只属于我们的**属性 removeProperty（占用前的内联值存在
 *   `data-ov-<prop>-prev`，非空则还原），于是该元素回到场景当帧的值，不残留 `scale(1)`。
 * - 标记与属性都只落在元素自身，不碰场景源文件。
 *
 * ## 合成不了就拒绝（NOT_SUPPORTED，不静默覆盖）
 *
 * - `display: inline`：CSS 规定行内元素不可变换，写了也没有视觉效果 → 拒绝 `INLINE_ELEMENT`。
 * - 场景自己已经占用了 `scale`/`rotate`（内联或样式表规则，且不是我们写的）：
 *   再写就会盖掉场景动画 → 拒绝 `SCENE_OWNS_SCALE` / `SCENE_OWNS_ROTATE`。
 * - 祖先链上有 2D 表达不了的变换（matrix3d 带 3D/透视、rotate 轴不是 Z、矩阵退化）→
 *   拒绝 `UNSUPPORTED_ANCESTOR_MATRIX`。S15 起**不再**因为「非中心 transform-origin」拒绝：
 *   个体属性本来就绕元素自己的 origin 生效，祖先只要是 2D 仿射就合得住。
 * 拒绝时把该元素上属于我们的旧值清掉，并保持 `transform` 不被触碰，结果里给出原因。
 *
 * ## 与场景自有 transform 的关系（S14 复核）
 *
 * 覆盖**从不写** `transform`：`s`/`r` 落在 `scale`/`rotate` 两个个体属性上，
 * 由 CSS 合成到 `transform` 左边，所以「场景动画 + 用户旋转」同时可见，且不需要每帧重算矩阵。
 * 元素**没有**自有 transform 时，输出与 R6（S9 版本）逐字节一致——本批没有改这条路径。
 */

export const OVERRIDE_APPLY_STAGE = 'after-frame';
/** `s`/`r` 的唯一写入者：元素自身的 CSS 个体属性 `scale`/`rotate`；`transform` 归场景。 */
export const TRANSFORM_OWNER = 'apply-overrides(individual scale/rotate) · scene(transform)';
/** 合成顺序（CSS Transforms L2）：translate → rotate → scale → transform。 */
export const TRANSFORM_ORDER = 'matrix = translate · rotate(r) · scale(s) · scene.transform';
export const TRANSFORM_APPLY_PROPS = Object.freeze(['scale', 'rotate']);

export const OVERRIDE_APPLY_KEYS = Object.freeze(['t', 'style', 'lock', 's', 'r', 'stroke', 'bg', 'align', 'tracking']);

/** 合成不了时的原因码（`unsupported[].reason`）。拒绝 = 不写任何属性，调用方须当失败处理。 */
export const TRANSFORM_REJECT_CODES = Object.freeze([
  'INLINE_ELEMENT',
  'SCENE_OWNS_SCALE',
  'SCENE_OWNS_ROTATE',
  'UNSUPPORTED_ANCESTOR_MATRIX'
]);

/**
 * @typedef {object} ApplyEntry
 * @property {string} at
 * @property {string} [t]
 * @property {Record<string, string>} [style]
 * @property {boolean} [lock]
 * @property {number | [number, number]} [s]
 * @property {number} [r]
 * @property {{color: string, width?: number}} [stroke]
 * @property {{color: string, padX?: number, padY?: number, radius?: number}} [bg]
 * @property {'left'|'center'|'right'|'justify'} [align]
 * @property {number} [tracking]
 */

/**
 * 页内执行：把覆盖条目应用到当前 DOM。
 *
 * 返回值里 `unsupported` 是「本来看起来能改、但合成不安全」的条目；
 * 它们**没有**被写入，调用方必须当失败处理，不得当成已应用。
 * @param {ApplyEntry[]} entries
 */
export function applyOverrideEntries(entries) {
  /** @type {{applied: number, missed: string[], transformed: string[], locked: string[], cleared: string[], unsupported: {at: string, code: string, reason: string, detail?: string}[]}} */
  const result = { applied: 0, missed: [], transformed: [], locked: [], cleared: [], unsupported: [] };
  const list = Array.isArray(entries) ? entries : [];

  /** @type {Map<string, Element|null>} */
  const resolved = new Map();
  /** @param {string} at @returns {Element|null} */
  const resolve = (at) => {
    if (resolved.has(at)) return resolved.get(at) ?? null;
    /** @type {Element|null} */
    let el = null;
    try {
      const nodes = document.querySelectorAll(at);
      el = nodes.length === 1 ? (nodes[0] ?? null) : null;
    } catch {
      el = null;
    }
    resolved.set(at, el);
    return el;
  };

  /** @param {unknown} v @returns {boolean} */
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);
  /** @param {unknown} s @returns {string|null} */
  const scaleValue = (s) => {
    if (finite(s)) return String(s);
    if (Array.isArray(s) && s.length === 2 && s.every((v) => finite(v))) return `${s[0]} ${s[1]}`;
    return null;
  };

  /* ── 一、先算本批「想要」的变换，供清除阶段比对 ───────────────────────── */
  /** @type {Map<string, {el: Element, s: string|null, r: number|null}>} */
  const desired = new Map();
  for (const entry of list) {
    if (!entry || typeof entry.at !== 'string') continue;
    const sv = entry.s === undefined ? null : scaleValue(entry.s);
    const rv = finite(entry.r) ? /** @type {number} */ (entry.r) : null;
    if (sv === null && rv === null) continue;
    const el = resolve(entry.at);
    if (!el) continue;
    desired.set(entry.at, { el, s: sv, r: rv });
  }

  /** @param {Element} el */
  const ownedProps = (el) =>
    (el.getAttribute('data-ov-transform') || '').split(/\s+/).filter((v) => v === 'scale' || v === 'rotate');

  /** 清掉某个元素上属于我们的变换属性（还原占用前的内联值）。 @param {Element} el */
  const clearOwned = (el) => {
    const elStyle = /** @type {HTMLElement} */ (el).style;
    for (const prop of ownedProps(el)) {
      const prev = el.getAttribute(`data-ov-${prop}-prev`);
      if (prev) elStyle.setProperty(prop, prev);
      else elStyle.removeProperty(prop);
      el.removeAttribute(`data-ov-${prop}-prev`);
    }
    el.removeAttribute('data-ov-transform');
    el.removeAttribute('data-ov-at');
  };

  /* ── 二、清除：上一批写过、本批不再需要的元素 ─────────────────────────── */
  for (const el of Array.from(document.querySelectorAll('[data-ov-transform]'))) {
    const at = el.getAttribute('data-ov-at') || '';
    if (desired.has(at)) continue;
    clearOwned(el);
    result.cleared.push(at);
  }

  /* ── 三、逐条应用 ─────────────────────────────────────────────────────── */
  for (const entry of list) {
    if (!entry || typeof entry.at !== 'string') continue;
    const el = /** @type {HTMLElement|null} */ (resolve(entry.at));
    if (!el) {
      result.missed.push(entry.at);
      continue;
    }

    if (typeof entry.t === 'string') el.textContent = entry.t;
    for (const key of Object.keys(entry.style || {})) {
      const value = (entry.style || {})[key];
      if (typeof value === 'string') el.style.setProperty(key, value);
    }
    /* 文本样式四键（R15 / E05-P3 前置）：描边、底框、对齐、字距。
       取值域在 parse 与 `/ops` 两处都由 `film-core/text-style.mjs` 校验过，
       这里只负责**写**，不再二次判域（页内函数不能 import，判两份必然分叉）。
       顺序固定、只 setProperty → 重复应用幂等。 */
    const stroke = entry.stroke;
    if (stroke && typeof stroke === 'object' && typeof stroke.color === 'string') {
      const width = typeof stroke.width === 'number' && Number.isFinite(stroke.width) ? stroke.width : 1;
      el.style.setProperty('-webkit-text-stroke', width + 'px ' + stroke.color);
      /* 描边默认画在字形中线上；paint-order 让它落在外面，不啃字。 */
      el.style.setProperty('paint-order', 'stroke fill');
    }
    const boxBg = entry.bg;
    if (boxBg && typeof boxBg === 'object' && typeof boxBg.color === 'string') {
      el.style.setProperty('background-color', boxBg.color);
      const padX = typeof boxBg.padX === 'number' && Number.isFinite(boxBg.padX) ? boxBg.padX : 0;
      const padY = typeof boxBg.padY === 'number' && Number.isFinite(boxBg.padY) ? boxBg.padY : 0;
      if (padX > 0 || padY > 0) el.style.setProperty('padding', padY + 'px ' + padX + 'px');
      if (typeof boxBg.radius === 'number' && Number.isFinite(boxBg.radius)) {
        el.style.setProperty('border-radius', boxBg.radius + 'px');
      }
    }
    if (typeof entry.align === 'string') el.style.setProperty('text-align', entry.align);
    if (typeof entry.tracking === 'number' && Number.isFinite(entry.tracking)) {
      el.style.setProperty('letter-spacing', entry.tracking + 'px');
    }
    if (entry.lock === true) {
      el.setAttribute('data-locked', '1');
      el.style.setProperty('pointer-events', 'none');
      result.locked.push(entry.at);
    }

    const want = desired.get(entry.at);
    if (want && want.el === el) {
      const verdict = applyOwnedTransform(el, entry.at, want.s, want.r);
      if (verdict.ok) {
        result.transformed.push(`${entry.at} -> ${verdict.wrote}`);
      } else {
        result.unsupported.push({ at: entry.at, code: 'NOT_SUPPORTED', ...verdict });
      }
    }
    result.applied++;
  }

  /**
   * 祖先链上有没有「2D 表达不了」的变换。有就返回描述串，没有返回 null。
   * 判据（与 `geometry-probe.mjs` 同一套）：
   * - `transform` 是 matrix3d 且带 3D 旋转 / 透视 / 非 1 的 Z·W 归一化；
   * - `rotate` 的轴不是 Z（绕 X/Y 轴投影到 2D 会丢轴长）；
   * - 矩阵退化（行列式为 0，例如 scale(0)），表达不了逆。
   * @param {HTMLElement} el
   * @returns {string|null}
   */
  function findNonAffineAncestor(el) {
    let p = el.parentElement;
    while (p) {
      const cs = getComputedStyle(p);
      const label = `${p.tagName.toLowerCase()}${p.id ? `#${p.id}` : ''}`;
      const tf = (cs.transform || 'none').trim();
      if (tf !== 'none') {
        /** @type {any} */
        let dm = null;
        try {
          dm = new DOMMatrix(tf);
        } catch {
          return `${label} 的 transform 解析失败：${tf}`;
        }
        if (!dm.is2D) {
          const eps = 1e-6;
          const bad =
            Math.abs(dm.m13) > eps || Math.abs(dm.m23) > eps || Math.abs(dm.m31) > eps || Math.abs(dm.m32) > eps ||
            Math.abs(dm.m14) > eps || Math.abs(dm.m24) > eps || Math.abs(dm.m34) > eps || Math.abs(dm.m43) > eps ||
            Math.abs(dm.m33 - 1) > eps || Math.abs(dm.m44 - 1) > eps ||
            Math.abs(dm.m41) > eps || Math.abs(dm.m42) > eps;
          if (bad) return `${label} 的 transform 含 3D/透视分量：${tf}`;
        }
        const det = dm.m11 * dm.m22 - dm.m12 * dm.m21;
        if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return `${label} 的 transform 退化（det=${det}）`;
      }
      const rot = (cs.rotate || 'none').trim();
      if (rot !== 'none') {
        const parts = rot.split(/\s+/);
        const axis = parts.length >= 2 ? parts.slice(0, -1).join(' ') : 'z';
        if (axis !== 'z') return `${label} 的 rotate 轴不是 Z：${rot}`;
      }
      p = p.parentElement;
    }
    return null;
  }

  /**
   * @param {HTMLElement} el
   * @param {string} at
   * @param {string|null} s
   * @param {number|null} r
   * @returns {{ok: true, wrote: string} | {ok: false, reason: string, detail?: string}}
   */
  function applyOwnedTransform(el, at, s, r) {
    const cs = getComputedStyle(el);
    if (cs.display === 'inline') {
      clearOwned(el);
      return { ok: false, reason: 'INLINE_ELEMENT', detail: 'display:inline 的元素不可变换' };
    }
    /* S15：不再因为「非中心 transform-origin」拒绝——个体属性本来就绕自身 origin 生效，
       只要祖先链能用 2D 仿射表达就合得住。只有祖先真的 3D/透视/退化时才拒绝。 */
    const ancestorProblem = findNonAffineAncestor(el);
    if (ancestorProblem) {
      clearOwned(el);
      return { ok: false, reason: 'UNSUPPORTED_ANCESTOR_MATRIX', detail: ancestorProblem };
    }
    const owned = ownedProps(el);
    if (!owned.includes('scale') && cs.scale && cs.scale !== 'none') {
      clearOwned(el);
      return { ok: false, reason: 'SCENE_OWNS_SCALE', detail: cs.scale };
    }
    if (!owned.includes('rotate') && cs.rotate && cs.rotate !== 'none') {
      clearOwned(el);
      return { ok: false, reason: 'SCENE_OWNS_ROTATE', detail: cs.rotate };
    }

    /** @type {string[]} */
    const next = [];
    if (s !== null) {
      if (!owned.includes('scale')) el.setAttribute('data-ov-scale-prev', el.style.scale || '');
      el.style.setProperty('scale', s);
      next.push('scale');
    } else if (owned.includes('scale')) {
      clearProp(el, 'scale');
    }
    if (r !== null) {
      if (!owned.includes('rotate')) el.setAttribute('data-ov-rotate-prev', el.style.rotate || '');
      el.style.setProperty('rotate', `${r}deg`);
      next.push('rotate');
    } else if (owned.includes('rotate')) {
      clearProp(el, 'rotate');
    }

    if (next.length) {
      el.setAttribute('data-ov-transform', next.join(' '));
      el.setAttribute('data-ov-at', at);
    } else {
      el.removeAttribute('data-ov-transform');
      el.removeAttribute('data-ov-at');
    }
    const bits = [r !== null ? `rotate(${r}deg)` : '', s !== null ? `scale(${s})` : ''].filter(Boolean);
    return { ok: true, wrote: bits.join(' ') || '（已清除）' };
  }

  /**
   * @param {HTMLElement} el
   * @param {'scale'|'rotate'} prop
   */
  function clearProp(el, prop) {
    const prev = el.getAttribute(`data-ov-${prop}-prev`);
    if (prev) el.style.setProperty(prop, prev);
    else el.style.removeProperty(prop);
    el.removeAttribute(`data-ov-${prop}-prev`);
  }

  return result;
}

/**
 * 页内执行：读某层的变换全貌（场景分量 / 覆盖分量 / 合成矩阵 / 实测包围盒）。
 * 刻意不解析 `transform` 字符串，直接用 DOMMatrix 按规范顺序乘：
 * `translate · rotate · scale · transform`。
 * @param {string} at
 */
export function readTransformState(at) {
  let el = null;
  try {
    const nodes = document.querySelectorAll(at);
    el = nodes.length === 1 ? nodes[0] : null;
  } catch {
    el = null;
  }
  if (!el) return { ok: false, reason: 'LAYER_GONE' };
  const cs = getComputedStyle(el);

  /** @param {string|undefined} v @param {number} fallback */
  const px = (v, fallback = 0) => {
    const n = parseFloat(v ?? '');
    return Number.isFinite(n) ? n : fallback;
  };

  let m = new DOMMatrix();
  if (cs.translate && cs.translate !== 'none') {
    const p = cs.translate.trim().split(/\s+/);
    m = m.translate(px(p[0]), px(p[1] ?? '0'), px(p[2] ?? '0'));
  }
  if (cs.rotate && cs.rotate !== 'none') {
    const p = cs.rotate.trim().split(/\s+/);
    if (p.length === 1) m = m.rotate(px(p[0]));
    else if (p.length === 2) {
      const axis = p[0];
      const angle = px(p[1]);
      if (axis === 'x') m = m.rotateAxisAngle(1, 0, 0, angle);
      else if (axis === 'y') m = m.rotateAxisAngle(0, 1, 0, angle);
      else m = m.rotateAxisAngle(0, 0, 1, angle);
    } else {
      m = m.rotateAxisAngle(px(p[0]), px(p[1]), px(p[2]), px(p[3]));
    }
  }
  if (cs.scale && cs.scale !== 'none') {
    const p = cs.scale.trim().split(/\s+/);
    m = m.scale(px(p[0], 1), px(p[1] ?? String(px(p[0], 1)), 1), px(p[2] ?? '1', 1));
  }
  let scene = null;
  if (cs.transform && cs.transform !== 'none') {
    try {
      scene = new DOMMatrix(cs.transform);
      m = m.multiply(scene);
    } catch {
      scene = null;
    }
  }
  const r = el.getBoundingClientRect();
  return {
    ok: true,
    transform: cs.transform,
    scale: cs.scale,
    rotate: cs.rotate,
    translate: cs.translate,
    display: cs.display,
    matrix: { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f },
    rotationDeg: (Math.atan2(m.b, m.a) * 180) / Math.PI,
    scaleAbs: Math.hypot(m.a, m.b),
    rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    owned: el.getAttribute('data-ov-transform') || ''
  };
}

/**
 * 宿主侧：取帧之后再应用覆盖。
 * @param {import('playwright').Page} page
 * @param {ApplyEntry[]} entries
 */
export async function applyOverrides(page, entries) {
  const fn = /** @type {(e: ApplyEntry[]) => {applied: number, missed: string[], transformed: string[], locked: string[], cleared: string[], unsupported: {at: string, code: string, reason: string}[]}} */ (
    applyOverrideEntries
  );
  return page.evaluate(fn, entries);
}

/**
 * 宿主侧：读某层的变换全貌（与产品同一套读数，不在测试里另写一份）。
 * @param {import('playwright').Page} page
 * @param {string} at
 */
export async function readTransform(page, at) {
  const fn = /** @type {(a: string) => ReturnType<typeof readTransformState>} */ (readTransformState);
  return page.evaluate(fn, at);
}

/* ── 几何（`set` op 的 box）预览：只改 DOM 副本，不写盘 ─────────────────────
 *
 * 与上面的 `s`/`r` 覆盖是**两件事**：
 * - `s`/`r` 写 CSS 个体属性 `scale`/`rotate`（渲染期变换，不改片段声明）；
 * - box 写元素自身的 `left/top/width/height/rotate` 声明（和 `set` op 落盘的那四个同义）。
 * 预览时把 box 直接写到元素内联样式上，并把改动前的内联值记在 `data-ov-box-prev`
 * 以便回滚；`left/top` 只有在元素**非 static** 定位时才真的挪得动——这点在返回值里如实给出
 * （`positioned`），不假装移动成功。舞台运行时会把自己的片段设成 `position:absolute`
 * （见 `packages/studio/server/content-origin.mjs` 里 `clip.el.style.position = 'absolute'`）。
 */

export const BOX_APPLY_PROPS = Object.freeze(['left', 'top', 'width', 'height', 'rotate']);

/**
 * 页内执行：把 box 预览写到元素自身内联声明上。重复调用幂等（不会累积）。
 * @param {{at: string, box: {x: number, y: number, w: number, h: number, r?: number}}} arg
 */
export function applyBoxValue(arg) {
  /** @type {HTMLElement|null} */
  let el = null;
  try {
    const nodes = document.querySelectorAll(arg.at);
    el = nodes.length === 1 ? /** @type {HTMLElement} */ (nodes[0]) : null;
  } catch {
    el = null;
  }
  if (!el) return { ok: false, code: 'LAYER_GONE', at: arg.at };

  const style = el.style;
  if (!el.hasAttribute('data-ov-box')) {
    /** @type {Record<string, string>} */
    const prev = {};
    for (const prop of BOX_APPLY_PROPS) prev[prop] = style.getPropertyValue(prop);
    el.setAttribute('data-ov-box-prev', JSON.stringify(prev));
    el.setAttribute('data-ov-box', '1');
    el.setAttribute('data-ov-box-at', arg.at);
  }

  const box = arg.box;
  const px = (/** @type {number} */ n) => `${n}px`;
  style.setProperty('left', px(box.x));
  style.setProperty('top', px(box.y));
  if (Number.isFinite(box.w) && box.w > 0) style.setProperty('width', px(box.w));
  if (Number.isFinite(box.h) && box.h > 0) style.setProperty('height', px(box.h));
  if (box.r !== undefined && box.r !== null && Number.isFinite(box.r)) style.setProperty('rotate', `${box.r}deg`);
  else style.removeProperty('rotate');

  const cs = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  /** @type {Record<string, string>} */
  const declarations = {};
  for (const prop of BOX_APPLY_PROPS) declarations[prop] = style.getPropertyValue(prop);

  return {
    ok: true,
    at: arg.at,
    positioned: cs.position !== 'static',
    position: cs.position,
    declarations,
    rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
  };
}

/**
 * 页内执行：撤回 box 预览，把内联声明还原成我们动手之前的样子。
 * @param {string} at
 */
export function clearBoxValue(at) {
  /** @type {HTMLElement|null} */
  let el = null;
  try {
    const nodes = document.querySelectorAll(at);
    el = nodes.length === 1 ? /** @type {HTMLElement} */ (nodes[0]) : null;
  } catch {
    el = null;
  }
  if (!el) return { ok: false, code: 'LAYER_GONE', at };
  if (!el.hasAttribute('data-ov-box')) return { ok: true, at, cleared: false };

  /** @type {Record<string, string>} */
  let prev = {};
  try {
    prev = JSON.parse(el.getAttribute('data-ov-box-prev') || '{}');
  } catch {
    prev = {};
  }
  for (const prop of BOX_APPLY_PROPS) {
    const value = prev[prop] ?? '';
    if (value) el.style.setProperty(prop, value);
    else el.style.removeProperty(prop);
  }
  el.removeAttribute('data-ov-box');
  el.removeAttribute('data-ov-box-prev');
  el.removeAttribute('data-ov-box-at');
  return { ok: true, at, cleared: true };
}

/**
 * 宿主侧：应用一次 box 预览（与产品同一份实现）。
 * @param {import('playwright').Page} page
 * @param {{at: string, box: {x: number, y: number, w: number, h: number, r?: number}}} arg
 */
export async function applyBox(page, arg) {
  const fn = /** @type {(a: typeof arg) => any} */ (applyBoxValue);
  return page.evaluate(fn, arg);
}

/**
 * 宿主侧：撤回 box 预览。
 * @param {import('playwright').Page} page
 * @param {string} at
 */
export async function clearBox(page, at) {
  const fn = /** @type {(a: string) => any} */ (clearBoxValue);
  return page.evaluate(fn, at);
}

/**
 * 页内执行：读某层当前的 box 声明与实测矩形（预览前后对比用）。
 * @param {string} at
 */
export function readBoxState(at) {
  /** @type {HTMLElement|null} */
  let el = null;
  try {
    const nodes = document.querySelectorAll(at);
    el = nodes.length === 1 ? /** @type {HTMLElement} */ (nodes[0]) : null;
  } catch {
    el = null;
  }
  if (!el) return { ok: false, code: 'LAYER_GONE', at };
  /** @type {Record<string, string>} */
  const declarations = {};
  for (const prop of BOX_APPLY_PROPS) declarations[prop] = el.style.getPropertyValue(prop);
  const cs = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return {
    ok: true,
    at,
    declarations,
    position: cs.position,
    inline: el.getAttribute('style') || '',
    rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
  };
}
