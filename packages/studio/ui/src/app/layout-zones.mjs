/**
 * 分栏 / 分区的可拖边界（R37 · B 批 · 批注 1）—— **只改视图尺寸，不碰影片内容**。
 *
 * ## 是什么
 *
 * 界面被分成四个功能区：左列（素材 + 图层 / 元素）、舞台、检查器、时间线。
 * 它们之间的边界可以拖：
 *
 *   `left`      左列（`.stage-dock`）↔ 舞台（`.main`）        竖边，col-resize
 *   `right`     舞台（`.main`）↔ 检查器（`.inspector`）       竖边，col-resize
 *   `agent`     编辑区 ↔ 对话框（`.agent-panel`）             竖边，col-resize
 *   `timeline`  上区（舞台 / 左列 / 检查器）↔ 时间线           横边，row-resize
 *
 * 拖的是**容器尺寸**：四条边的拖法（往左 / 往右 / 往上 / 往下）都覆盖到，
 * 但一个子面板内部的布局（轨头、字段栅格、走带…）一个字节都不动。
 *
 * ## 为什么存 localStorage 而不是 film.html
 *
 * 与轨道高度（`track-height.ts`）同一条理由：这是「我现在怎么看」，不是影片内容。
 * 写进 `film.html` 会让同一份工程在不同显示器上互相覆盖，也会让「只改视图」变成一次
 * `/ops`、一步撤销、一个 hash 变化。**全局**存（与 projectId 无关）—— 分栏是窗口形状，
 * 不是某个工程的味道。
 *
 * ## 存储形状
 *
 * `{"left": 260, "right": 300, "timeline": 280}`：**只存拖过的**那几条。
 * 双击复位移除该边的偏好，由 CSS 恢复当前布局的默认尺寸。
 */

/** @typedef {'left'|'right'|'agent'|'timeline'} ZoneId */
/** @typedef {{left?: number, right?: number, agent?: number, timeline?: number}} ZoneSizes */
/** @typedef {{w: number, h: number, left?: number, right?: number, agent?: number}} ZoneBox */
/** @typedef {{getItem(key: string): string|null, setItem(key: string, value: string): void, removeItem(key: string): void}} ZoneStore */

/** @type {readonly ZoneId[]} */
export const ZONE_IDS = Object.freeze(/** @type {ZoneId[]} */ (['left', 'right', 'agent', 'timeline']));

/** zone → CSS 变量名。三处消费点（grid / 手柄定位 / 复位）都读这一份。 */
/** @type {Readonly<Record<ZoneId, string>>} */
export const ZONE_VAR = Object.freeze({
  left: '--col-left',
  right: '--col-inspector',
  agent: '--col-agent',
  timeline: '--row-timeline',
});

/** zone → 轴（`col` = 竖边拖 x，`row` = 横边拖 y）。 */
/** @type {Readonly<Record<ZoneId, 'col'|'row'>>} */
export const ZONE_AXIS = Object.freeze({ left: 'col', right: 'col', agent: 'col', timeline: 'row' });

/**
 * 下限（px）。创作库最窄 220，检查器低于 220 时字段的「前缀格 + 值格」放不下；时间线低于 160 时
 * 一条轨 + 标尺都不够高。
 */
/** @type {Readonly<Record<ZoneId, number>>} */
export const ZONE_MIN = Object.freeze({ left: 220, right: 220, agent: 220, timeline: 160 });

/**
 * 相邻区的最小值。
 *
 * 舞台宽取 **420** —— 与 V05 在 ≤1359 视口的下限同值（480 是 ≥1360 的默认态门槛）。
 * 拖窄到 420 就是产品自己认过的"还能用"的底线，再小等于让判据形同虚设。
 * 上区高 240（= 时间线默认行高）：再小预览 + 走带都放不下。
 */
export const ZONE_STAGE_MIN = 420;
export const ZONE_TOP_MIN = 240;

/** 键盘调宽一步（px）。 */
export const ZONE_KEY_STEP = 8;

/** The side library stores a preference in this range. Actual room can be smaller. */
export const LIBRARY_MAX = 800;

/** The chat retains room for its composer and occupies at most 640px. */
export const AGENT_MAX = 640;

/** localStorage 键：全局一份，不按工程分。 */
export const ZONE_STORAGE_KEY = 'opencut.zones.v1';

/**
 * 把一条边的目标值夹到合法区间。
 *
 * `box` 包含 `.layout` 的完整宽度和各栏的实测宽度。对话框变宽时，
 * 创作库可以暂时缩到最小宽度，保留已保存的创作库偏好。
 *
 * @param {ZoneId} id
 * @param {unknown} value
 * @param {ZoneBox} box
 * @returns {number}
 */
export function clampZone(id, value, box) {
  const raw = Number(value);
  const min = ZONE_MIN[id];
  if (!Number.isFinite(raw)) return min;
  const limit = (() => {
    if (id === 'timeline') return Math.round(box.h - ZONE_TOP_MIN);
    if (id === 'agent') return box.w - (box.right ?? ZONE_MIN.right) - ZONE_MIN.left - ZONE_STAGE_MIN;
    const other = id === 'left' ? box.right : box.left;
    if (typeof other !== 'number' || !Number.isFinite(other)) return Number.POSITIVE_INFINITY;
    return box.w - (box.agent ?? 0) - other - ZONE_STAGE_MIN;
  })();
  const preferenceMax = id === 'left' ? LIBRARY_MAX : id === 'agent' ? AGENT_MAX : Number.POSITIVE_INFINITY;
  const max = Math.max(min, Math.min(limit, preferenceMax));
  return Math.round(Math.min(max, Math.max(min, raw)));
}

/**
 * 读存储。
 *
 * 只认已知键 + 有限数字；读坏了当没存过（视图偏好丢了不是错误，不值得弹框）。
 *
 * @param {ZoneStore|undefined} [storage]
 * @returns {ZoneSizes}
 */
export function loadZones(storage) {
  const store = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
  if (store === null) return {};
  /** @type {ZoneSizes} */
  const out = {};
  try {
    const raw = store.getItem(ZONE_STORAGE_KEY);
    if (raw === null || raw === '') return out;
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
    for (const id of ZONE_IDS) {
      const value = /** @type {Record<string, unknown>} */ (parsed)[id];
      const px = Number(value);
      if (Number.isFinite(px)) out[id] = Math.round(px);
    }
  } catch {
    return {};
  }
  return out;
}

/**
 * 写一条边（先夹再存），返回**新的整表**给调用方 setState。
 *
 * @param {ZoneId} id
 * @param {unknown} value
 * @param {ZoneBox} box
 * @param {ZoneStore|undefined} [storage]
 * @returns {ZoneSizes}
 */
export function saveZone(id, value, box, storage) {
  const next = { ...loadZones(storage), [id]: clampZone(id, value, box) };
  const store = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
  if (store !== null) {
    try {
      store.setItem(ZONE_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* 隐私模式 / 配额满：存不下就算了，本次会话仍然生效（与轨道高度同一处理）。 */
    }
  }
  return next;
}

/**
 * 删掉一条（`id` 省略 = 全删），返回删完的整表。
 *
 * @param {ZoneId|undefined} [id]
 * @param {ZoneStore|undefined} [storage]
 * @returns {ZoneSizes}
 */
export function clearZones(id, storage) {
  const store = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
  const rest = loadZones(store === null ? undefined : store);
  if (id === undefined) {
    if (store !== null) {
      try {
        store.removeItem(ZONE_STORAGE_KEY);
      } catch {
        /* 同上 */
      }
    }
    return {};
  }
  delete rest[id];
  if (store !== null) {
    try {
      if (Object.keys(rest).length === 0) store.removeItem(ZONE_STORAGE_KEY);
      else store.setItem(ZONE_STORAGE_KEY, JSON.stringify(rest));
    } catch {
      /* 同上 */
    }
  }
  return rest;
}

/**
 * 把整表原样落盘（值必须已经夹过；拖拽结束与「复位后重写」走这一条）。
 *
 * 与 `saveZone` 的分工：`saveZone` 是「拖出来一条」，这里一次写整表。
 * 全部为空时**连键一起删** —— 否则复位后留下一个 `{}`，下次 `loadZones` 读到
 * 空对象虽然等价，但证据里会看着像「还存着什么」。
 *
 * @param {ZoneSizes} sizes
 * @param {ZoneStore|undefined} [storage]
 * @returns {ZoneSizes} 真正落盘的整表（只有有限数字；给调用方接着 publish）
 */
export function persistZones(sizes, storage) {
  const store = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
  if (store === null) return {};
  /** @type {ZoneSizes} */
  const keep = {};
  for (const id of ZONE_IDS) {
    const px = sizes[id];
    if (typeof px === 'number' && Number.isFinite(px)) keep[id] = Math.round(px);
  }
  try {
    if (Object.keys(keep).length === 0) store.removeItem(ZONE_STORAGE_KEY);
    else store.setItem(ZONE_STORAGE_KEY, JSON.stringify(keep));
  } catch {
    /* 隐私模式 / 配额满：存不下就算了，本次会话仍然生效。 */
  }
  return keep;
}

/** Apply preferences to the app. CSS also accounts for occupied panels on every reflow.
 * @param {ZoneSizes} sizes
 * @param {HTMLElement|null} [host]
 * @returns {HTMLElement|null} 真正写入的宿主（拿不到就 null）
 */
export function applyZones(sizes, host) {
  const target = host ?? (typeof document === 'undefined' ? null : document.querySelector('.layout')?.parentElement ?? null);
  /* 鸭子类型而不是 `instanceof HTMLElement`：单测里给的是替身，浏览器里给的是真元素，
     两边都只用到 `style.setProperty / removeProperty` 这两个方法。 */
  if (target === null || target === undefined || typeof target.style?.setProperty !== 'function') return null;
  for (const id of ZONE_IDS) {
    const saved = sizes[id];
    const px = id === 'left' && typeof saved === 'number' ? Math.max(ZONE_MIN.left, Math.min(LIBRARY_MAX, saved)) : saved;
    if (typeof px === 'number' && Number.isFinite(px)) target.style.setProperty(ZONE_VAR[id], `${Math.round(px)}px`);
    else target.style.removeProperty(ZONE_VAR[id]);
  }
  return target;
}

/**
 * 从实测量到的 rect 里读出某条边的当前值。
 *
 * @param {ZoneId} id
 * @param {{stageDock?: DOMRect, inspector?: DOMRect, agentPanel?: DOMRect, timelineRow?: DOMRect}|null} rects
 * @returns {number|null}
 */
export function measureZone(id, rects) {
  if (rects === null || rects === undefined) return null;
  const pick = { left: rects.stageDock, right: rects.inspector, agent: rects.agentPanel, timeline: rects.timelineRow }[id];
  if (pick === undefined) return null;
  const px = id === 'timeline' ? pick.height : pick.width;
  return Number.isFinite(px) ? Math.round(px) : null;
}
