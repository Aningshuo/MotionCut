/**
 * 关键帧的运行时落位（E05-P1）
 *
 * `packages/film-core/keyframes.mjs` 只算 CSS 与计划；这里负责把它**贴到页面上**：
 *
 * 1. 往 `<head>` 塞（或更新）一段 `<style id="film-kf-styles">`；
 * 2. 给每个计划里的元素打 `data-kf="<hash>"`（CSS 规则就是按这个属性选的）；
 * 3. 本轮不再需要的元素把 `data-kf` 摘掉 —— 否则上一批的关键帧会留在画面上。
 *
 * ## 为什么不在编译里直接写行内 animation
 *
 * `@keyframes` 只能写在样式表里，行内 `style` 写不了。而且一条规则被多个同形元素复用时
 * （同 hash），写成规则比逐个元素写行内省得多。
 *
 * ## 标记名
 *
 * `data-kf` 是**契约**（CSS 选择器与验收都认它）；`data-ov-kf-at` 是本模块自己的簿记，
 * 只用来做「上一批 vs 这一批」的差集，跟 `apply-overrides.mjs` 的 `data-ov-at` 分开命名，
 * 两套清除逻辑不会互相踩。
 *
 * ## 页内函数必须自包含
 *
 * `applyKeyframeStyles` 会被 Playwright 序列化进页面执行（`page.evaluate(fn, arg)`），
 * 所以它**不能**引用模块常量（连 `KF_STYLE_ID` 都要在函数里内联字面量）。
 * 这条与 `motion/instance.mjs` 的 `applyInstanceProps` 是同一条约束。
 */

/** `<style>` 节点的 id（页内函数里也内联了同一个字面量，改这里要同步改那里）。 */
export const KF_STYLE_ID = 'film-kf-styles';

/**
 * 页内执行：注入样式表 + 打 `data-kf` + 清理上一轮的多余标记。
 *
 * @param {{css: string, plans: {at: string, hash: string}[]}} arg
 * @returns {{ok: true, applied: number, missed: string[], cleared: number, cssLength: number}}
 */
export function applyKeyframeStyles(arg) {
  const STYLE_ID = 'film-kf-styles';
  const css = typeof arg?.css === 'string' ? arg.css : '';
  const plans = Array.isArray(arg?.plans) ? arg.plans : [];

  /** @type {HTMLStyleElement|null} */
  let node = /** @type {HTMLStyleElement|null} */ (document.getElementById(STYLE_ID));
  if (css === '') {
    if (node !== null) node.remove();
  } else {
    if (node === null) {
      node = document.createElement('style');
      node.id = STYLE_ID;
      (document.head ?? document.documentElement).appendChild(node);
    }
    if (node.textContent !== css) node.textContent = css;
  }

  /** @param {string} at @returns {Element|null} */
  const resolve = (at) => {
    try {
      const nodes = document.querySelectorAll(at);
      return nodes.length === 1 ? (nodes[0] ?? null) : null;
    } catch {
      return null;
    }
  };

  /** @type {Set<string>} */
  const wanted = new Set();
  for (const plan of plans) {
    if (plan !== null && typeof plan === 'object' && typeof plan.at === 'string') wanted.add(plan.at);
  }

  /* 先清：上一轮打过、这一轮不要的（按 at 判，不按元素判）。 */
  let cleared = 0;
  for (const el of Array.from(document.querySelectorAll('[data-kf]'))) {
    const at = el.getAttribute('data-ov-kf-at') || '';
    if (wanted.has(at)) continue;
    el.removeAttribute('data-kf');
    el.removeAttribute('data-ov-kf-at');
    cleared += 1;
  }

  let applied = 0;
  /** @type {string[]} */
  const missed = [];
  for (const plan of plans) {
    if (plan === null || typeof plan !== 'object' || typeof plan.at !== 'string') continue;
    const el = resolve(plan.at);
    if (el === null) {
      missed.push(plan.at);
      continue;
    }
    const hash = String(plan.hash);
    if (el.getAttribute('data-kf') !== hash) el.setAttribute('data-kf', hash);
    el.setAttribute('data-ov-kf-at', plan.at);
    applied += 1;
  }

  return { ok: true, applied, missed, cleared, cssLength: css.length };
}

/**
 * 页内执行：**把关键帧落到这一帧**——注入样式表、打 `data-kf`、写局部毫秒。
 *
 * 三件事合成一次往返，因为它们都必须发生在同一帧的 DOM 上：
 *
 * 1. **打标记**：`[data-kf="<hash>"]` 是 CSS 规则的唯一入口。只在该文档里
 *    选择器**唯一命中**时才认（`querySelectorAll(at).length === 1`）——多命中说明
 *    这个 `at` 在这份文档里不唯一，打上去会让两条规则抢同一个元素。
 * 2. **注入样式表**：只在真有目标的文档里注入（CSS 不跨 iframe，每份文档各一份）。
 *    `<style id>` 固定，重复调用只改内容，不叠加节点。
 * 3. **写局部毫秒**：与 `scene-runtime/motion-time.mjs` 的 `localMsOf` 同口径
 *    （`max(0, t − at) * 1000`），`at` 按整条 frame 链累加。舞台的 `writeMotionTime`
 *    在「文档里有 `[data-instance]`」时只写实例根，kf 元素若在实例外就继承不到；
 *    这里直接写元素自身，等于把那一档补齐。值相同时重复写不改字节（幂等）。
 *
 * ## 为什么它在 `packages/layers`（R15 起）
 *
 * 以前它住在 `render/stage-capture.mjs`，只有**导出**用得上；R15 要让**预览**也有 kf，
 * 而预览的舞台运行时（`studio/server/content-origin.mjs` 里那段字符串）没有模块系统。
 * 于是把它搬到这里，导出侧 `import` 真函数、预览侧 `toString()` 注入同一份源码——
 * 两条路只有一个实现。`stage-capture.mjs` 继续 re-export（老调用点与副线2 的
 * `uir-r24-kfsem.mjs` 都按那个路径取）。
 *
 * **必须自包含**：会被 Playwright 序列化进页面，也会被 `toString()` 塞进舞台运行时，
 * 所以不能引用模块常量、函数体里不能出现反引号或 `$` 花括号。
 *
 * @param {{t: number, css: string, plans: {clipId?: string, at: string, hash: string}[]}} arg
 * @returns {{documents: number, styled: number, marked: number, timed: number}}
 */
export function syncKeyframeFrame(arg) {
  const STYLE_ID = 'film-kf-styles';
  const VAR = '--motion-t';
  const TIME_ATTR = 'data-motion-t';
  const css = typeof arg?.css === 'string' ? arg.css : '';
  const plans = Array.isArray(arg?.plans) ? arg.plans : [];
  const now = Number.isFinite(Number(arg?.t)) ? Number(arg.t) : 0;

  /** @type {Document[]} */
  const seen = [];
  let styled = 0;
  let marked = 0;
  let timed = 0;

  /** @param {string|null} raw */
  const num = (raw) => {
    const value = Number(raw);
    return Number.isFinite(value) ? value : 0;
  };

  /**
   * @param {Document} doc
   * @param {number} offset 整条 frame 链上的 at 之和
   * @param {string} clipId 这份文档属于哪个片段（根文档 / 认不出时为空串）
   */
  function visit(doc, offset, clipId) {
    if (!doc || seen.indexOf(doc) >= 0) return;
    seen.push(doc);

    let hit = 0;
    for (let i = 0; i < plans.length; i += 1) {
      const plan = plans[i];
      if (!plan || typeof plan.at !== 'string') continue;
      /* 计划属于哪个片段（R15）：两段都叫同一个 id 选择器时，只按选择器匹配会把 B 段的
         规则打到 A 段的元素上（实测 A 读到 B 的末帧 0.9 而不是 1）。有 clipId 就必须
         是本片段；没有 clipId 的老计划保持「任意文档」的旧行为。 */
      const owner = typeof plan.clipId === 'string' ? plan.clipId : '';
      if (owner !== '' && owner !== clipId) continue;
      /** @type {NodeListOf<Element>|never[]} */
      let nodes = [];
      try {
        nodes = doc.querySelectorAll(plan.at);
      } catch (error) {
        nodes = [];
      }
      if (nodes.length !== 1) continue;
      const el = /** @type {Element} */ (nodes[0]);
      const hash = String(plan.hash);
      if (el.getAttribute('data-kf') !== hash) el.setAttribute('data-kf', hash);
      el.setAttribute('data-ov-kf-at', plan.at);
      hit += 1;
      marked += 1;
    }

    if (hit > 0 && css !== '') {
      /** @type {HTMLElement|null} */
      let node = doc.getElementById(STYLE_ID);
      if (node === null) {
        node = doc.createElement('style');
        node.id = STYLE_ID;
        (doc.head ?? doc.documentElement).appendChild(node);
      }
      if (node.textContent !== css) node.textContent = css;
      styled += 1;
    }

    const els = doc.querySelectorAll('[data-kf]');
    for (let i = 0; i < els.length; i += 1) {
      const el = /** @type {HTMLElement} */ (els[i]);
      let at = offset;
      if (typeof el.closest === 'function') {
        const owner = el.closest('[at]');
        if (owner) at += num(owner.getAttribute('at'));
      }
      const ms = now > at ? (now - at) * 1000 : 0;
      el.style.setProperty(VAR, String(ms));
      el.setAttribute(TIME_ATTR, String(ms));
      timed += 1;
    }

    const frames = doc.querySelectorAll('iframe,frame');
    for (let i = 0; i < frames.length; i += 1) {
      /** @type {Document|null} */
      let child = null;
      const frameEl = /** @type {HTMLIFrameElement} */ (frames[i]);
      try {
        child = frameEl.contentDocument;
      } catch (error) {
        child = null;
      }
      /* 片段的 iframe 用片段 id 当元素 id（filmDoc.getElementById(id) 是全仓约定）。 */
      if (child) visit(child, offset + num(frameEl.getAttribute('at')), frameEl.getAttribute('id') || '');
    }
  }

  visit(document, 0, '');
  return { documents: seen.length, styled, marked, timed };
}

/**
 * 宿主侧：把编译结果落到页面上（与产品同一份实现，不在测试里另写一套）。
 * @param {import('playwright').Page} page
 * @param {{css: string, plans: {at: string, hash: string}[]}} arg
 */
export async function applyKeyframes(page, arg) {
  const fn = /** @type {(a: typeof arg) => ReturnType<typeof applyKeyframeStyles>} */ (applyKeyframeStyles);
  return page.evaluate(fn, arg);
}

/**
 * 页内执行：读某个元素的动画实测态（验收用：`data-kf` 在不在、动画是不是暂停、
 * 当前 `animation-delay` 是多少）。
 * @param {string} at
 */
export function readKeyframeState(at) {
  /** @type {Element|null} */
  let el = null;
  try {
    const nodes = document.querySelectorAll(at);
    el = nodes.length === 1 ? (nodes[0] ?? null) : null;
  } catch {
    el = null;
  }
  if (el === null) return { ok: false, reason: 'LAYER_GONE' };
  const cs = getComputedStyle(el);
  const styleNode = document.getElementById('film-kf-styles');
  return {
    ok: true,
    at,
    kf: el.getAttribute('data-kf'),
    playState: cs.animationPlayState,
    animationName: cs.animationName,
    animationDuration: cs.animationDuration,
    delay: cs.animationDelay,
    opacity: cs.opacity,
    translate: cs.translate,
    hasStyleNode: styleNode !== null,
    css: styleNode === null ? '' : styleNode.textContent || '',
  };
}

/**
 * 宿主侧：读动画实测态。
 * @param {import('playwright').Page} page
 * @param {string} at
 */
export async function readKeyframe(page, at) {
  const fn = /** @type {(a: string) => ReturnType<typeof readKeyframeState>} */ (readKeyframeState);
  return page.evaluate(fn, at);
}
