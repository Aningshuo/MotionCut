/**
 * 时间线手势（S46 · B-SUB1-R23-023）
 *
 * 把 S44 在画布上验过的那条状态机搬到时间线：**Pointer Events 一套、`pointerType` 只改手感参数**。
 * 这一个文件只做「指针 → 意图 → op」的翻译，不画轨道、不存片段、不写盘：
 *
 * | 手势 | 判定 | 结果 |
 * |---|---|---|
 * | 点选 | 位移 ≤8px（触摸/笔）或 ≤0.5px（鼠标）且 ≤300ms | 选中该片段，**0 op** |
 * | 移动片段 | 片段上起手 + 超过阈值 | 一次手势 = 一次提交（`props` 改 `at`），磁吸仍生效 |
 * | 裁剪 | 边缘 44×44 热区上起手 | `props` 改 `start`+`at`（左手柄）或 `end`（右手柄） |
 * | 滚动 | 空白处单指横拖 | 只改 `scrollLeft`，**不移动片段、0 op** |
 * | 捏合 | 第二根手指按下 | 以两指中点为锚缩放 `pxPerSecond`，**0 op** |
 * | 取消 | `pointercancel` / 触摸的 `lostpointercapture` | 回滚预览与视图，**不写盘** |
 *
 * ## 为什么热区由本模块画，而不是宿主
 *
 * 44×44 是「手指点得中」的保证。放在宿主里就等于让每个宿主各写一遍，迟早有一个写回 10×10。
 * 所以本模块在片段两侧各挂一个**透明热区**（`data-tl-hit`），视觉手柄仍由宿主画：
 * 热区只吃指针，不产生像素，也不参与命中测（`pointer-events` 只开在热区自己身上）。
 *
 * ## 片段几何是**算**出来的，不是量的
 *
 * `left = at × pxPerSecond − scrollLeft`、`width = (sourceEnd − sourceStart) ÷ speed × pxPerSecond`。
 * 不读 DOM：读 DOM 会把「宿主画错了」和「手势算错了」混在一起，而且滚动时 rect 会滞后一帧。
 *
 * ## 与 studio `timeline/plan.mjs` 的关系
 *
 * op 的形状与它逐字相同（`{op:'props', edits:[{clip, prop, value}]}`），落地值也一致
 * （毫秒取整、磁吸阈值按像素换算）。S46 的验收脚本会把同一组输入喂给 `planMove`/`planTrim`
 * 对比 ops —— 两边一旦分叉，脚本会红。真正接线时（studio 侧，另批）应当让宿主直接用
 * `plan.mjs` 产 op，本模块只负责「手势 → 输入」。
 */

/** 裁剪手柄的命中区边长（屏幕 px）：Apple HIG 的最小可点尺寸。 */
export const TIMELINE_HANDLE_HIT_PX = 44;
/** 裁剪手柄的视觉宽度（屏幕 px）—— 只用于「热区在哪里」，本模块不画视觉。 */
export const TIMELINE_HANDLE_VISUAL_PX = 10;
/** 触摸/笔的点选容差：位移 ≤8px 且时长 ≤300ms。 */
export const TIMELINE_TAP_MAX_MOVE = 8;
export const TIMELINE_TAP_MAX_MS = 300;
/** 鼠标的起拖阈值（精确设备，沿用画布手势的老口径）。 */
export const TIMELINE_MOUSE_SLOP = 0.5;
/** 磁吸阈值（屏幕 px）——换算成秒时除以 pxPerSecond。 */
export const TIMELINE_SNAP_PX = 6;
/** 缩放范围（px/秒）。 */
export const TIMELINE_MIN_PX_PER_SEC = 4;
export const TIMELINE_MAX_PX_PER_SEC = 800;
/** 片段最短长度（秒）：与 studio 的「至少一帧」同量级，取 1ms 以免和帧率耦合。 */
export const TIMELINE_MIN_DURATION_SEC = 0.001;

/** @param {number} n @param {number} [digits] */
function round(n, digits = 3) {
  const p = 10 ** digits;
  return Math.round(Number(n) * p) / p;
}

/** @param {number} value @param {number} min @param {number} max */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 片段占用区间（秒）。与 studio `geometry.mjs` 的 `clipSpan` 同一条公式。
 * @param {{at?: number, time?: number[], speed?: number}} clip
 */
export function clipSpan(clip) {
  const start = Number(clip?.at ?? 0);
  const time = Array.isArray(clip?.time) ? clip.time : null;
  const speed = typeof clip?.speed === 'number' && clip.speed > 0 ? clip.speed : 1;
  const length = time === null ? 0 : (Number(time[1]) - Number(time[0])) / speed;
  return { start, end: round(start + length), length: round(length) };
}

/**
 * 片段的像素矩形（相对时间线视口左上角）。
 * @param {{at?: number, time?: number[], speed?: number, track?: number}} clip
 * @param {{pxPerSecond: number, scrollLeft: number, trackHeight: number}} view
 */
export function clipRect(clip, view) {
  const span = clipSpan(clip);
  const pps = Number(view.pxPerSecond) > 0 ? Number(view.pxPerSecond) : 1;
  const scroll = Number(view.scrollLeft) || 0;
  const trackHeight = Number(view.trackHeight) > 0 ? Number(view.trackHeight) : 0;
  const track = Number(clip?.track ?? 0);
  return {
    left: round(span.start * pps - scroll, 2),
    width: round(Math.max(1, span.length * pps), 2),
    top: round(track * trackHeight, 2),
    height: round(trackHeight, 2),
    span
  };
}

/**
 * 磁吸：把 `value` 吸到最近的 target（阈值内）。返回 `{value, target, distance}`。
 * @param {number} value @param {number[]} targets @param {number} tolerance
 */
export function snapToTargets(value, targets, tolerance) {
  let best = { value, target: /** @type {number|null} */ (null), distance: Number.POSITIVE_INFINITY };
  if (!Array.isArray(targets) || !(tolerance > 0)) return best;
  for (const target of targets) {
    if (!Number.isFinite(target)) continue;
    const distance = Math.abs(target - value);
    if (distance <= tolerance && distance < best.distance) best = { value: target, target, distance };
  }
  return best;
}

/**
 * 捏合后的视图：**两指中点下的那个时刻必须还压在同一个位置**。
 *
 *     tAnchor = (mid0 − rectLeft + scroll0) / pps0
 *     scroll1 = tAnchor × pps1 − (mid1 − rectLeft)
 *
 * 中点本身也会移动（两指平移），所以用 `mid1` —— 平移与缩放一次算完。
 * @param {{pxPerSecond: number, scrollLeft: number}} view0
 * @param {{mid0: number, mid1: number, ratio: number}} input
 */
export function pinchView(view0, input) {
  const pps0 = Number(view0.pxPerSecond) > 0 ? Number(view0.pxPerSecond) : 1;
  const scroll0 = Number(view0.scrollLeft) || 0;
  const ratio = Number(input.ratio) > 0 ? Number(input.ratio) : 1;
  const pps1 = clamp(pps0 * ratio, TIMELINE_MIN_PX_PER_SEC, TIMELINE_MAX_PX_PER_SEC);
  const anchorTime = (Number(input.mid0) + scroll0) / pps0;
  const scroll1 = anchorTime * pps1 - Number(input.mid1);
  return {
    pxPerSecond: round(pps1, 4),
    /* ADR-R29-01：同样不夹 0。滚动为 S 的宿主在内容坐标系下拿到的值要再加 S×ratio
       （宿主补偿见 M47 的接缝说明），夹在引擎里会把这段补偿的量吃掉。 */
    scrollLeft: round(scroll1, 3),
    anchorTime: round(anchorTime, 4),
    ratio: round(pps1 / pps0, 6)
  };
}

/**
 * @param {HTMLElement} viewport 时间线视口（片段与轨道都在里面）
 * @param {{
 *   getClips: () => any[],
 *   getView: () => {pxPerSecond: number, scrollLeft: number, trackHeight: number},
 *   getSnapTargets?: () => number[],
 *   onSelect?: (id: string|null) => void,
 *   onPreview?: (placed: Record<string, {start:number,end:number,track:number}>) => void,
 *   onCommit?: (ops: any[]) => void,
 *   onCancel?: () => void,
 *   onScroll?: (scrollLeft: number) => void,
 *   onZoom?: (view: {pxPerSecond:number, scrollLeft:number}) => void,
 *   shouldHandle?: (event: PointerEvent) => boolean,
 * }} opts
 *
 * `shouldHandle` 是**宿主决定「哪些指针走引擎」的唯一接缝**（ADR-R27-01）。引擎本身不
 * 内建「鼠标走 React、触摸走引擎」这种策略：一块时间线可能同时有两套实现，谁接管哪类
 * 指针是产品决定，不是引擎决定。缺省（不传）行为与 S46 完全一致：所有指针都处理。
 * 只拦 **pointerdown**：down 被拒时状态机不会进入任何 mode，后续 move/up/cancel 自然无效。
 *
 * `onScroll` / `onZoom` 的 `scrollLeft` 都是**内容坐标下的数学值**，引擎**不夹紧**到 0
 * （ADR-R29-01）：夹在引擎里会让「内容坐标系视口恒为 0」的宿主永远回拖不动
 * （`max(0, 0 − dx)` 恒 0）。边界（`0..scrollWidth − clientWidth`）只有宿主知道。
 */
export function mountTimelineGesture(viewport, opts) {
  if (!viewport || typeof viewport.appendChild !== 'function') throw new Error('mountTimelineGesture 需要一个视口元素');
  if (!opts || typeof opts.getClips !== 'function') throw new Error('mountTimelineGesture 需要 opts.getClips');
  if (typeof opts.getView !== 'function') throw new Error('mountTimelineGesture 需要 opts.getView');

  const doc = viewport.ownerDocument ?? /** @type {Document} */ (globalThis.document);
  const win = doc.defaultView ?? globalThis;

  const state = {
    pointerType: /** @type {string} */ (''),
    pointerId: /** @type {number|null} */ (null),
    mode: /** @type {'move'|'trim-start'|'trim-end'|'scroll'|'pinch'|null} */ (null),
    selected: /** @type {string|null} */ (null),
    moved: false,
    start: /** @type {any} */ (null),
    lastPoint: /** @type {{x:number,y:number}|null} */ (null),
    lastGesture: /** @type {any} */ (null),
    taps: 0,
    commits: 0,
    cancels: 0,
    scrolls: 0,
    zooms: 0,
    gestureStartedAt: 0,
    /* 手势开始时的视图（取消要原样还回去） */
    view0: /** @type {any} */ (null),
    /* 捏合的第二根手指 */
    pinch: /** @type {any} */ (null),
    hitArea: TIMELINE_HANDLE_HIT_PX,
    cancelReason: ''
  };

  /* ── 热区层 ─────────────────────────────────────────────────────────── */

  const layer = doc.createElement('div');
  layer.setAttribute('data-tl-hit-layer', '');
  layer.style.cssText = ['position:absolute', 'left:0', 'top:0', 'width:100%', 'height:100%', 'pointer-events:none', 'z-index:5'].join(';');
  viewport.appendChild(layer);

  /** @type {Map<string, {start: HTMLElement, end: HTMLElement}>} */
  const hits = new Map();

  /** @param {string} clipId */
  function ensureHit(clipId) {
    let pair = hits.get(clipId);
    if (pair) return pair;
    /** @param {'start'|'end'} edge */
    const make = (edge) => {
      const el = doc.createElement('div');
      el.setAttribute('data-tl-hit', edge);
      el.setAttribute('data-tl-clip', clipId);
      el.style.cssText = [
        'position:absolute',
        `width:${TIMELINE_HANDLE_HIT_PX}px`,
        'margin:0',
        'background:transparent',
        'border:0',
        'pointer-events:auto',
        'touch-action:none'
      ].join(';');
      layer.appendChild(el);
      return el;
    };
    pair = { start: make('start'), end: make('end') };
    hits.set(clipId, pair);
    return pair;
  }

  /** 按当前视图把热区摆到片段两侧（44×44，居中压在边上）。 */
  function layoutHits() {
    const view = readView();
    const clips = readClips();
    const seen = new Set();
    for (const clip of clips) {
      const id = String(clip?.id ?? '');
      if (id === '') continue;
      seen.add(id);
      const rect = clipRect(clip, view);
      const pair = ensureHit(id);
      const height = Math.max(TIMELINE_HANDLE_HIT_PX, rect.height);
      const edges = [
        { edge: /** @type {'start'} */ ('start'), el: pair.start, center: rect.left },
        { edge: /** @type {'end'} */ ('end'), el: pair.end, center: rect.left + rect.width }
      ];
      for (const item of edges) {
        item.el.style.left = `${round(item.center - TIMELINE_HANDLE_HIT_PX / 2, 2)}px`;
        item.el.style.top = `${round(rect.top + (rect.height - height) / 2, 2)}px`;
        item.el.style.height = `${round(height, 2)}px`;
      }
    }
    for (const [id, pair] of hits.entries()) {
      if (seen.has(id)) continue;
      pair.start.remove();
      pair.end.remove();
      hits.delete(id);
    }
  }

  /* ── 读宿主 ─────────────────────────────────────────────────────────── */

  function readView() {
    const raw = opts.getView() ?? {};
    return {
      pxPerSecond: Number(raw.pxPerSecond) > 0 ? Number(raw.pxPerSecond) : 1,
      scrollLeft: Number(raw.scrollLeft) || 0,
      trackHeight: Number(raw.trackHeight) > 0 ? Number(raw.trackHeight) : 0
    };
  }

  function readClips() {
    const list = opts.getClips();
    return Array.isArray(list) ? list : [];
  }

  /** @param {string} id */
  function findClip(id) {
    return readClips().find((clip) => String(clip?.id ?? '') === id) ?? null;
  }

  function snapTargets() {
    if (typeof opts.getSnapTargets !== 'function') return [];
    try {
      const list = opts.getSnapTargets();
      return Array.isArray(list) ? list.filter((value) => Number.isFinite(value)) : [];
    } catch {
      return [];
    }
  }

  function nowMs() {
    try {
      return Number(win.performance.now());
    } catch {
      return Date.now();
    }
  }

  /** 触摸/笔：只影响阈值与「取消要不要回滚视图」。 */
  function isTouchLike() {
    return state.pointerType === 'touch' || state.pointerType === 'pen';
  }

  /** 视口坐标（clientX 已减去 rect.left）。 @param {number} clientX */
  function localX(clientX) {
    return Number(clientX) - viewport.getBoundingClientRect().left;
  }

  /* ── 手势 ───────────────────────────────────────────────────────────── */

  /** @param {'move'|'trim-start'|'trim-end'|'scroll'} mode @param {PointerEvent} event @param {any} [extra] */
  function beginGesture(mode, event, extra) {
    state.mode = mode;
    state.moved = false;
    state.gestureStartedAt = nowMs();
    state.view0 = readView();
    state.start = {
      clientX: event.clientX,
      clientY: event.clientY,
      startedAt: state.gestureStartedAt,
      ...extra
    };
    state.lastPoint = { x: event.clientX, y: event.clientY };
  }

  /** @param {PointerEvent} event */
  function onPointerDown(event) {
    if (event.button !== 0) return;
    /* 宿主策略闸门（ADR-R27-01）：返回 false 就完全当我们不存在。 */
    if (typeof opts.shouldHandle === 'function' && opts.shouldHandle(event) !== true) return;
    /* 第二根手指：进捏合（先回滚当前手势的预览，避免两套变换打架） */
    if (state.mode && state.pointerId !== null && event.pointerId !== state.pointerId) {
      if (state.mode === 'pinch') {
        state.pinch = null;
        return;
      }
      const view = readView();
      const rollbackMode = state.mode;
      if (rollbackMode === 'move' || rollbackMode === 'trim-start' || rollbackMode === 'trim-end') {
        if (typeof opts.onCancel === 'function') opts.onCancel();
      }
      if (rollbackMode === 'scroll' && state.view0) {
        if (typeof opts.onScroll === 'function') opts.onScroll(state.view0.scrollLeft);
      }
      const first = state.lastPoint ?? { x: state.start?.clientX ?? event.clientX, y: state.start?.clientY ?? event.clientY };
      state.pointerType = typeof event.pointerType === 'string' && event.pointerType !== '' ? event.pointerType : state.pointerType;
      state.mode = 'pinch';
      state.moved = true;
      state.pinch = {
        id0: state.pointerId,
        id1: event.pointerId,
        p0: { x: Number(first.x), y: Number(first.y) },
        p1: { x: event.clientX, y: event.clientY },
        d0: Math.hypot(event.clientX - Number(first.x), event.clientY - Number(first.y)),
        mid0: (localX(Number(first.x)) + localX(event.clientX)) / 2,
        view0: { ...view }
      };
      event.preventDefault();
      return;
    }
    if (state.mode) return;

    state.pointerType = typeof event.pointerType === 'string' && event.pointerType !== '' ? event.pointerType : 'mouse';
    state.pointerId = typeof event.pointerId === 'number' ? event.pointerId : null;
    state.lastGesture = null;
    /* 捕获打在**视口**上：拖出视口边界还要继续收事件（手指移出去就断流是移动端的经典 bug）。
       捕获失败（合成事件/老浏览器）不影响状态机本身。 */
    try {
      viewport.setPointerCapture(event.pointerId);
    } catch {
      /* 不支持的实现就退回「靠 pointermove 冒泡」 */
    }

    const target = /** @type {any} */ (event.target);
    const hitEl = typeof target?.closest === 'function' ? target.closest('[data-tl-hit]') : null;
    const clipEl = typeof target?.closest === 'function' ? target.closest('[data-clip-id]') : null;
    const hitId = hitEl ? hitEl.getAttribute('data-tl-clip') : null;
    const clipId = clipEl ? clipEl.getAttribute('data-clip-id') : null;

    if (hitEl && hitId && findClip(hitId)) {
      event.preventDefault();
      const edge = hitEl.getAttribute('data-tl-hit') === 'end' ? 'end' : 'start';
      beginGesture(edge === 'end' ? 'trim-end' : 'trim-start', event, { clipId: hitId, edge });
      select(hitId);
      return;
    }

    if (clipEl && clipId && findClip(clipId)) {
      event.preventDefault();
      select(clipId);
      beginGesture('move', event, { clipId });
      return;
    }

    /* 空白处：横向拖动 = 滚动（不选、不动片段） */
    event.preventDefault();
    beginGesture('scroll', event, {});
  }

  /** @param {string|null} id */
  function select(id) {
    state.selected = id;
    if (typeof opts.onSelect === 'function') opts.onSelect(id);
  }

  /**
   * 这次手势算不算「动过」。
   *
   * 触摸/笔：欧氏距离 >8px 才算（手指接触面有抖动，0.5px 会把点选变成移动 op）；
   * 鼠标：曼哈顿 >0.5px（S17 起的老口径）。
   */
  /** @param {number} clientX @param {number} clientY */
  function movedFor(clientX, clientY) {
    if (state.moved) return true;
    const start = state.start;
    if (!start) return false;
    const dx = Number(clientX) - Number(start.clientX);
    const dy = Number(clientY) - Number(start.clientY);
    if (isTouchLike()) return Math.hypot(dx, dy) > TIMELINE_TAP_MAX_MOVE;
    return Math.abs(dx) + Math.abs(dy) > TIMELINE_MOUSE_SLOP;
  }

  /** 移动/裁剪的落点（秒），带磁吸与钳制。 */
  /** @param {'move'|'trim-start'|'trim-end'} mode @param {number} deltaPx */
  function planDelta(mode, deltaPx) {
    const view = state.view0 ?? readView();
    const pps = view.pxPerSecond;
    const delta = deltaPx / pps;
    const clip = findClip(String(state.start?.clipId ?? ''));
    if (!clip) return null;
    const span = clipSpan(clip);
    const tolerance = TIMELINE_SNAP_PX / pps;
    const targets = snapTargets();

    if (mode === 'move') {
      const rawAt = Math.max(0, round(span.start + delta));
      const startSnap = snapToTargets(rawAt, targets, tolerance);
      const endSnap = snapToTargets(rawAt + span.length, targets, tolerance);
      let at = rawAt;
      let guide = null;
      if (startSnap.target !== null && (endSnap.target === null || startSnap.distance <= endSnap.distance)) {
        at = startSnap.value;
        guide = { time: startSnap.target, edge: 'start' };
      } else if (endSnap.target !== null) {
        at = Math.max(0, endSnap.value - span.length);
        guide = { time: endSnap.target, edge: 'end' };
      }
      at = round(Math.max(0, at));
      return {
        ops: [{ op: 'props', edits: [{ clip: clip.id, prop: 'at', value: at }] }],
        placed: { [clip.id]: { start: at, end: round(at + span.length), track: Number(clip.track ?? 0) } },
        guide
      };
    }

    const speed = typeof clip.speed === 'number' && clip.speed > 0 ? clip.speed : 1;
    const from = Array.isArray(clip.time) ? Number(clip.time[0]) : 0;
    const to = Array.isArray(clip.time) ? Number(clip.time[1]) : 0;

    if (mode === 'trim-start') {
      const desired = span.start + delta;
      const snapped = snapToTargets(desired, targets, tolerance);
      const at = round(Math.max(0, snapped.value));
      const shift = round(at - span.start);
      const nextFrom = round(clamp(from + shift * speed, 0, Math.max(0, to - TIMELINE_MIN_DURATION_SEC * speed)));
      const realShift = round((nextFrom - from) / speed);
      const finalAt = round(Math.max(0, span.start + realShift));
      return {
        ops: [{ op: 'props', edits: [{ clip: clip.id, prop: 'start', value: nextFrom }, { clip: clip.id, prop: 'at', value: finalAt }] }],
        placed: { [clip.id]: { start: finalAt, end: round(finalAt + (to - nextFrom) / speed), track: Number(clip.track ?? 0) } },
        guide: nextFrom === from ? null : snapped.target === null ? null : { time: snapped.target, edge: 'start' }
      };
    }

    /* trim-end */
    const desiredEnd = span.end + delta;
    const snappedEnd = snapToTargets(desiredEnd, targets, tolerance);
    const wantEnd = round(Math.max(0, snappedEnd.value));
    const minTo = round(from + TIMELINE_MIN_DURATION_SEC * speed);
    const nextTo = round(Math.max(minTo, from + (wantEnd - span.start) * speed));
    return {
      ops: [{ op: 'props', edits: [{ clip: clip.id, prop: 'end', value: nextTo }] }],
      placed: { [clip.id]: { start: span.start, end: round(span.start + (nextTo - from) / speed), track: Number(clip.track ?? 0) } },
      guide: snappedEnd.target === null ? null : { time: snappedEnd.target, edge: 'end' }
    };
  }

  /** @param {PointerEvent} event */
  function onPointerMove(event) {
    if (!state.mode) return;
    if (state.pointerId !== null && typeof event.pointerId === 'number' && event.pointerId !== state.pointerId && state.mode !== 'pinch') return;
    if (state.mode === 'pinch') return onPinchMove(event);
    state.lastPoint = { x: event.clientX, y: event.clientY };

    if (state.mode === 'scroll') {
      if (!movedFor(event.clientX, event.clientY)) return;
      state.moved = true;
      const dx = Number(event.clientX) - Number(state.start.clientX);
      /* ADR-R29-01：给**未夹紧**的目标值。夹在这里会让「内容坐标视口恒 0」的宿主
         永远回拖不动（`max(0, 0 − dx)` 恒 0）；最左/最右由宿主按内容宽度决定。 */
      const next = round(Number(state.view0?.scrollLeft ?? 0) - dx, 3);
      if (typeof opts.onScroll === 'function') opts.onScroll(next);
      state.scrolls += 1;
      layoutHits();
      return;
    }

    if (!movedFor(event.clientX, event.clientY)) return;
    state.moved = true;
    const dx = Number(event.clientX) - Number(state.start.clientX);
    const plan = planDelta(state.mode, dx);
    if (!plan) return;
    state.lastGesture = { ...(state.lastGesture ?? {}), ...plan, mode: state.mode };
    if (typeof opts.onPreview === 'function') opts.onPreview(plan.placed);
  }

  /** @param {PointerEvent} event */
  function onPinchMove(event) {
    const pinch = state.pinch;
    if (!pinch) return;
    if (event.pointerId === pinch.id0) pinch.p0 = { x: event.clientX, y: event.clientY };
    else pinch.p1 = { x: event.clientX, y: event.clientY };
    const distance = Math.hypot(pinch.p1.x - pinch.p0.x, pinch.p1.y - pinch.p0.y);
    if (!(pinch.d0 > 0) || !(distance > 0)) return;
    const mid1 = (localX(pinch.p0.x) + localX(pinch.p1.x)) / 2;
    const next = pinchView(
      { pxPerSecond: pinch.view0.pxPerSecond, scrollLeft: pinch.view0.scrollLeft },
      { mid0: pinch.mid0, mid1, ratio: distance / pinch.d0 }
    );
    state.zooms += 1;
    state.lastGesture = {
      ...(state.lastGesture ?? {}),
      mode: 'pinch',
      ...next,
      distance0: round(pinch.d0, 2),
      distance: round(distance, 2)
    };
    if (typeof opts.onZoom === 'function') opts.onZoom({ pxPerSecond: next.pxPerSecond, scrollLeft: next.scrollLeft });
    layoutHits();
  }

  /**
   * 回滚：把预览与视图都还原成手势前，然后回调 `onCancel`。
   * **不产生任何 op** —— 取消的语义是「当没发生过」。
   */
  /** @param {string} reason */
  function rollback(reason) {
    if (!state.mode) return;
    if (state.mode === 'scroll' && state.view0) {
      if (typeof opts.onScroll === 'function') opts.onScroll(state.view0.scrollLeft);
    }
    if (state.mode === 'pinch' && state.pinch?.view0) {
      if (typeof opts.onZoom === 'function') opts.onZoom({ pxPerSecond: state.pinch.view0.pxPerSecond, scrollLeft: state.pinch.view0.scrollLeft });
    }
    if (state.mode === 'move' || state.mode === 'trim-start' || state.mode === 'trim-end') {
      if (typeof opts.onCancel === 'function') opts.onCancel();
    }
    state.cancelReason = reason;
  }

  /** @param {'commit'|'cancel'} action @param {PointerEvent} [event] */
  function endGesture(action, event) {
    if (!state.mode) return;
    const mode = state.mode;
    const moved = state.moved;
    const startedAt = Number(state.start?.startedAt ?? state.gestureStartedAt ?? 0);
    const durationMs = Math.max(0, Math.round(nowMs() - startedAt));
    const point = state.lastPoint ?? { x: state.start?.clientX ?? 0, y: state.start?.clientY ?? 0 };
    const distancePx = state.start
      ? round(Math.hypot(Number(point.x) - Number(state.start.clientX), Number(point.y) - Number(state.start.clientY)), 2)
      : 0;

    let kind = 'cancel';
    if (action === 'commit') {
      if (mode === 'pinch') kind = 'pinch';
      else if (mode === 'scroll') kind = moved ? 'scroll' : 'tap';
      else if (!moved) kind = isTouchLike() && durationMs <= TIMELINE_TAP_MAX_MS ? 'tap' : isTouchLike() ? 'press' : 'click';
      else kind = mode;
    }

    if (action === 'commit' && moved && (mode === 'move' || mode === 'trim-start' || mode === 'trim-end')) {
      const dx = Number(point.x) - Number(state.start.clientX);
      const plan = planDelta(mode, dx);
      if (plan) {
        if (typeof opts.onCommit === 'function') opts.onCommit(plan.ops);
        state.commits += plan.ops.length;
      }
    }
    if (action === 'cancel') {
      rollback('pointercancel');
      state.cancels += 1;
    }
    if (kind === 'tap') state.taps += 1;

    state.lastGesture = {
      ...(state.lastGesture ?? {}),
      mode,
      kind,
      moved,
      durationMs,
      distancePx,
      pointerType: state.pointerType,
      ...(action === 'cancel' ? { cancelReason: state.cancelReason ?? 'pointercancel' } : {})
    };
    try {
      if (state.pointerId !== null) viewport.releasePointerCapture(state.pointerId);
    } catch {
      /* 已经释放/没捕获：忽略 */
    }
    state.mode = null;
    state.pinch = null;
    state.view0 = null;
    state.start = null;
    state.pointerId = null;
    state.cancelReason = '';
    void event;
    layoutHits();
  }

  /** @param {PointerEvent} event */
  function onPointerUp(event) {
    if (!state.mode) return;
    if (state.mode === 'pinch') {
      /* 捏合结束：不提交 op，视图保留 */
      state.lastGesture = { ...(state.lastGesture ?? {}), kind: 'pinch', mode: 'pinch', pointerType: state.pointerType };
      try {
        if (state.pointerId !== null) viewport.releasePointerCapture(state.pointerId);
      } catch {
        /* 忽略 */
      }
      state.mode = null;
      state.pinch = null;
      state.start = null;
      state.pointerId = null;
      state.view0 = null;
      layoutHits();
      return;
    }
    if (state.pointerId !== null && typeof event.pointerId === 'number' && event.pointerId !== state.pointerId) return;
    endGesture('commit', event);
  }

  /** @param {PointerEvent} [event] */
  function onPointerCancel(event) {
    if (!state.mode) return;
    if (state.pointerId !== null && typeof event?.pointerId === 'number' && event.pointerId !== state.pointerId) return;
    endGesture('cancel', event);
  }

  /** @param {PointerEvent} event */
  function onLostPointerCapture(event) {
    if (!state.mode) return;
    if (state.mode === 'pinch') return;
    /* 触摸/笔的捕获被系统收回 = 取消；鼠标维持老行为（按最后位置收尾） */
    if (isTouchLike()) endGesture('cancel', event);
    else endGesture('commit', event);
  }

  viewport.addEventListener('pointerdown', onPointerDown);
  viewport.addEventListener('pointermove', onPointerMove);
  viewport.addEventListener('pointerup', onPointerUp);
  viewport.addEventListener('pointercancel', onPointerCancel);
  viewport.addEventListener('lostpointercapture', onLostPointerCapture);
  viewport.style.touchAction = 'none';

  layoutHits();

  return {
    refresh: layoutHits,
    getState() {
      return {
        pointerType: state.pointerType,
        pointerId: state.pointerId,
        mode: state.mode,
        selected: state.selected,
        moved: state.moved,
        taps: state.taps,
        commits: state.commits,
        cancels: state.cancels,
        scrolls: state.scrolls,
        zooms: state.zooms,
        lastGesture: state.lastGesture ? { ...state.lastGesture } : null,
        hitArea: { px: state.hitArea, hitCount: hits.size * 2 },
        view: readView(),
        clips: readClips().map((clip) => ({ id: clip.id, ...clipSpan(clip), track: Number(clip.track ?? 0) }))
      };
    },
    /** @param {string|null} id */
    select(id) {
      select(id);
      layoutHits();
      return state.selected;
    },
    destroy() {
      viewport.removeEventListener('pointerdown', onPointerDown);
      viewport.removeEventListener('pointermove', onPointerMove);
      viewport.removeEventListener('pointerup', onPointerUp);
      viewport.removeEventListener('pointercancel', onPointerCancel);
      viewport.removeEventListener('lostpointercapture', onLostPointerCapture);
      viewport.style.removeProperty('touch-action');
      layer.remove();
      hits.clear();
      state.mode = null;
    }
  };
}
