/**
 * 实例参数落到 DOM（副线1 · S5-WP15）
 *
 * 参数是**实例自己的**：写在实例根的 `data-props` 上，由这段页内代码变成
 * CSS 自定义属性 / 文本 / 布尔属性。模板源不参与，所以同一模板的另一个实例
 * 不可能被带着一起改——隔离是结构性的，不靠调用方自觉。
 *
 * `applyInstanceProps` 会被 Playwright 序列化进页面，必须完全自包含。
 */

/**
 * 模板动画的时间入口（S31-MOTION-FRAME-T）。
 *
 * 约定：模板里所有动画都是 `animation-play-state: paused` + `animation-delay: -t`，
 * 于是画面只由这个自定义属性决定。宿主每帧写一次就走带 `film.frame(t)` 的 t。
 *
 * **单位是毫秒**（和 `duration` 参数一致）。字段名 `tMs` 就是为了不猜单位：
 * 宿主若拿到秒，自己乘 1000。
 */
export const MOTION_TIME_VAR = '--motion-t';

/** 模板 `<meta name="motion-clock">` 里的声明，宿主可据此自检（`--motion-t;unit=ms`）。 */
export const MOTION_CLOCK_META = 'motion-clock';

/**
 * @typedef {{type: string, apply?: {kind: string, name?: string, selector?: string}}} PropSpec
 */

/**
 * 页内执行：把一组参数写到实例根上。
 * @param {{selector: string, schema: Record<string, PropSpec>, values: Record<string, unknown>}} arg
 */
export function applyInstanceProps(arg) {
  const root = /** @type {HTMLElement|null} */ (document.querySelector(arg.selector));
  if (!root) return { ok: false, reason: 'ROOT_MISSING' };
  let touched = 0;
  for (const key of Object.keys(arg.schema)) {
    const spec = arg.schema[key];
    if (!spec) continue;
    const value = arg.values[key];
    if (value === undefined) continue;
    const apply = spec.apply || { kind: 'css-var', name: '--' + key };
    if (apply.kind === 'text') {
      const sel = apply.selector || '';
      if (!sel) continue;
      const el = root.querySelector(sel);
      if (el) {
        el.textContent = String(value);
        touched++;
      }
    } else if (apply.kind === 'attr') {
      if (value === true) root.setAttribute(apply.name || key, '');
      else root.removeAttribute(apply.name || key);
      touched++;
    } else {
      root.style.setProperty(apply.name || '--' + key, String(value));
      touched++;
    }
  }
  return { ok: true, touched };
}

/**
 * 从实例根的 `data-props` 读回参数（重开时；不从内存缓存猜）。
 * @param {Element} root
 * @returns {{template: string, version: number, sourceHash: string, values: Record<string, unknown>} | null}
 */
export function readInstanceProps(root) {
  const raw = root.getAttribute('data-props');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 宿主侧：在页面上应用实例参数。
 * @param {import('playwright').Page} page
 * @param {{selector: string, schema: Record<string, PropSpec>, values: Record<string, unknown>}} arg
 */
export async function applyInstance(page, arg) {
  const fn = /** @type {(a: typeof arg) => {ok: boolean, reason?: string, touched?: number}} */ (applyInstanceProps);
  const result = await page.evaluate(fn, arg);
  if (!result.ok) throw new Error(`实例根不存在：${arg.selector}`);
  return result;
}

/**
 * 页内执行：把实例的动画相位设到 `tMs`（毫秒）——这就是「renderAt(t)」。
 *
 * 只写一个自定义属性 + 一个自省属性；模板的 `animation-delay: -t` 随之把暂停中的
 * 动画定格到 t 那一帧。不读时钟、不存状态，所以**同一个 t 永远是同一帧**。
 *
 * 注意：本函数会被 Playwright 序列化进页面，变量名必须内联（不能引用模块常量）。
 * @param {{selector: string, tMs: number}} arg
 * @returns {{ok: true, tMs: number} | {ok: false, reason: string}}
 */
export function applyInstanceTime(arg) {
  const root = /** @type {HTMLElement|null} */ (document.querySelector(arg.selector));
  if (!root) return { ok: false, reason: 'ROOT_MISSING' };
  const tMs = Number(arg.tMs);
  if (!Number.isFinite(tMs)) return { ok: false, reason: 'BAD_T' };
  const value = Math.max(0, tMs);
  root.style.setProperty('--motion-t', String(value));
  root.setAttribute('data-motion-t', String(value));
  return { ok: true, tMs: value };
}

/**
 * 宿主侧：把实例定格到 t（毫秒）。宿主/舞台把 `film.frame(t)` 的 t 传进来即可。
 * @param {import('playwright').Page} page
 * @param {{selector: string, tMs: number}} arg
 */
export async function renderInstanceAt(page, arg) {
  const fn = /** @type {(a: typeof arg) => {ok: boolean, reason?: string, tMs?: number}} */ (applyInstanceTime);
  const result = await page.evaluate(fn, arg);
  if (!result.ok) throw new Error(`实例定格失败：${arg.selector} → ${result.reason ?? 'UNKNOWN'}`);
  return result;
}
