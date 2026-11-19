/**
 * 功能区边界的拖拽手柄。
 *
 * ## 形态
 *
 * 4px 的窄条，绝对定位在 `.layout` 的接缝上：
 *
 *   `[data-zone-handle="left"]`      左列右缘 / 舞台左缘（竖，col-resize）
 *   `[data-zone-handle="right"]`     舞台右缘 / 检查器左缘（竖，col-resize）
 *   `[data-zone-handle="agent"]`     对话框左缘（竖，col-resize，面板打开时显示）
 *   `[data-zone-handle="timeline"]`  上区下缘 / 时间线顶缘（横，row-resize）
 *
 * 它们**不占布局**（absolute），所以：
 *   - 时间线仍整宽、首轨 y 不动（拖列宽不改时间线高度 = 硬约束）；
 *   - 任何子面板的内部布局一个像素都不动。
 *
 * ## 状态只在一个地方
 *
 * 尺寸表在模块级 store 里：`ZoneHandles` 只是它的视图，顶栏「布局 → 复位」
 * （`resetAllZones()`）与双击手柄（`resetZone(id)`）改的是同一份。
 * 拖动**每帧**只改内联变量（不落盘），**松手**才写 localStorage —— 一次拖动几十次
 * `setItem` 对 SSD 与隐私模式都不友好。
 */

import { Fragment, createElement, useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';

import {
  ZONE_AXIS,
  ZONE_IDS,
  ZONE_KEY_STEP,
  applyZones,
  clampZone,
  clearZones,
  loadZones,
  measureZone,
  persistZones,
  saveZone,
} from './layout-zones.mjs';

type ZoneId = (typeof ZONE_IDS)[number];
/** 尺寸表：只含拖过的边。 */
type ZoneSizes = Partial<Record<ZoneId, number>>;
/** 夹取用到的容器尺寸。 */
type ZoneBox = Parameters<typeof clampZone>[2];

/** 手柄上写字用的名字（`aria-label`）。 */
const ZONE_LABEL: Readonly<Record<ZoneId, string>> = Object.freeze({
  left: '左列与舞台的边界',
  right: '舞台与检查器的边界',
  agent: '对话框宽度',
  timeline: '上区与时间线的边界',
});

const ZONE_TITLE: Readonly<Record<ZoneId, string>> = Object.freeze({
  left: '拖动调整创作库宽度 · 双击恢复 320 像素',
  right: '拖动调整检查器宽度 · 双击复位（回到默认断点）',
  agent: '拖动调整对话框宽度 · 双击复位',
  timeline: '拖动调整时间线高度 · 双击复位（回到默认 240）',
});

/* ── 模块级 store：一处状态，三个消费者（手柄 / 顶栏复位 / 首帧应用） ───────── */

let currentSizes: ZoneSizes = loadZones();
const listeners = new Set<() => void>();

/** 换状态 → 立刻写到内联变量 → 通知视图。落盘由调用方先做（拖动松手才写）。 */
function publish(next: ZoneSizes): void {
  currentSizes = next;
  applyZones(currentSizes);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): ZoneSizes {
  return currentSizes;
}

/**
 * 顶栏「布局 → 复位」清除所有边界的尺寸偏好。
 * 不依赖组件是否挂着 —— 先清状态与内联变量，视图下一拍自己跟上。
 */
export function resetAllZones(): void {
  publish(clearZones());
}

/** 只复位一条（双击手柄）。 */
export function resetZone(id: ZoneId): void {
  publish(clearZones(id));
}

/** 当前边界尺寸的偏好（量具/调试用；与 DOM 上的内联变量同源）。 */
export function currentZoneSizes(): ZoneSizes {
  return currentSizes;
}

/* ── DOM 读数 ─────────────────────────────────────────────────────────── */

/** 获取可调整区域的实际尺寸。 */
function rectsOf(layout: Element): Record<string, DOMRect> {
  const bag: Record<string, DOMRect> = {};
  for (const [key, selector] of [
    ['stageDock', '.stage-dock'],
    ['inspector', '.inspector'],
    ['timelineRow', '.timeline-row'],
  ] as const) {
    const el = layout.querySelector(selector);
    if (el !== null) bag[key] = el.getBoundingClientRect();
  }
  const agent = layout.parentElement?.querySelector(':scope > .agent-panel');
  if (agent != null) bag.agentPanel = agent.getBoundingClientRect();
  return bag;
}

/** `.layout` 的完整尺寸和各栏当前宽度。 */
function boxOf(layout: Element): ZoneBox {
  const rect = layout.getBoundingClientRect();
  const rects = rectsOf(layout);
  const box: ZoneBox = { w: rect.width, h: rect.height };
  if (rects.stageDock !== undefined) box.left = rects.stageDock.width;
  if (rects.inspector !== undefined) box.right = rects.inspector.width;
  if (rects.agentPanel !== undefined) box.agent = rects.agentPanel.width;
  return box;
}

/**
 * 某条边的现值。**从 DOM 读**而不是从 `currentSizes` 读：没拖过时 state 里没有这一项，
 * 显示宽度还取决于布局中实际剩余的空间，拖动必须从显示值起步。
 * 算术在 `layout-zones.mjs:measureZone`（纯函数，单测覆盖），这里只管取 rect。
 */
function sizeOf(layout: Element, id: ZoneId): number {
  return measureZone(id, rectsOf(layout)) ?? 0;
}

interface DragState {
  id: ZoneId;
  axis: 'col' | 'row';
  startPos: number;
  startSize: number;
  box: ZoneBox;
  moved: boolean;
}

/* ── 组件 ─────────────────────────────────────────────────────────────── */

export function ZoneHandles({ agentOpen }: { agentOpen: boolean }): ReactNode {
  const sizes = useSyncExternalStore(subscribe, snapshot);
  const drag = useRef<DragState | null>(null);
  /* 双击复位的第二条判据（见 `beginDrag`）：同一手柄 450ms 内、同一点上第二次按下。 */
  const lastTap = useRef<{ id: ZoneId; at: number; x: number; y: number } | null>(null);
  /* 拖完的那一下 click 要吃掉（见 `endDrag`）：时间戳到期前，捕获阶段的 click 一律拦掉。 */
  const swallowUntil = useRef(0);

  /* 首帧就把存过的宽度写上去（`useLayoutEffect` 在 paint 前跑）：
     effect 也行，但那样刷新会先闪一帧默认宽度。 */
  useLayoutEffect(() => {
    applyZones(currentSizes);
  }, []);

  /* 卸载时把拖动中的光标类清掉（拖到一半切工程/关面板，别把 col-resize 留在 body 上）。 */
  useEffect(() => {
    const body = document.body;
    return () => {
      body.classList.remove('zone-resizing', 'zone-resizing-col', 'zone-resizing-row');
    };
  }, []);

  // Escape can dismiss the panel while its divider still owns the pointer.
  useEffect(() => {
    if (agentOpen || drag.current?.id !== 'agent') return;
    const { moved } = drag.current;
    drag.current = null;
    document.body.classList.remove('zone-resizing', 'zone-resizing-col');
    if (moved) publish(persistZones(currentSizes));
  }, [agentOpen]);

  /* 拖完那一下的 click 在**捕获阶段**就拿掉，别让它落到舞台/检查器上（见 `endDrag`）。 */
  useEffect(() => {
    const onClick = (event: MouseEvent): void => {
      if (Date.now() >= swallowUntil.current) return;
      swallowUntil.current = 0;
      event.stopPropagation();
      event.preventDefault();
    };
    window.addEventListener('click', onClick, true);
    return () => window.removeEventListener('click', onClick, true);
  }, []);

  const beginDrag = useCallback((id: ZoneId) => {
    return (event: ReactPointerEvent<HTMLElement>): void => {
      if (event.button !== 0) return;
      // Electron can start a native drag as the pointer crosses a preview. Keep this gesture on the divider.
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      /* 双击复位**不依赖原生 `dblclick`**。
         R37 实测：pointer capture 之下，Chromium 对「同一节点两次 pointerdown」的
         dblclick 派发不可靠（1280 三条都收得到、1440 左列那条收不到），
         而且 `releasePointerCapture` 排队的 `lostpointercapture` 会把第二次的 `drag.current`
         清掉（race）。所以这里在 **pointerdown** 上判「同一手柄 450ms 内第二次按下、
         且没挪动过」—— 按下即复位，第二次不再进入拖拽。原生 `onDoubleClick` 只作第二条
         通路（重复调用幂等），两条都不通才算真坏。 */
      const now = Date.now();
      const last = lastTap.current;
      const sameSpot = last !== null && Math.abs(event.clientX - last.x) < 6 && Math.abs(event.clientY - last.y) < 6;
      lastTap.current = { id, at: now, x: event.clientX, y: event.clientY };
      if (last !== null && last.id === id && sameSpot && now - last.at < 450) {
        lastTap.current = null;
        resetZone(id);
        return;
      }
      const layout = event.currentTarget.closest('.layout');
      if (layout === null) return;
      drag.current = {
        id,
        axis: ZONE_AXIS[id],
        startPos: ZONE_AXIS[id] === 'col' ? event.clientX : event.clientY,
        startSize: sizeOf(layout, id),
        box: boxOf(layout),
        moved: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.classList.add('zone-resizing', `zone-resizing-${ZONE_AXIS[id]}`);
    };
  }, []);

  const moveDrag = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    const state = drag.current;
    if (state === null) return;
    const delta = (state.axis === 'col' ? event.clientX : event.clientY) - state.startPos;
    if (!state.moved && Math.abs(delta) < 1) return;
    state.moved = true;
    /* 检查器和对话框从左边调整，时间线从上边调整。所以除 `left` 外都要取反。
       这一处与下面 `keyDown` 里的 `delta` 是同一个约定，两处必须同号。 */
    const sizeDelta = state.id === 'left' ? delta : -delta;
    const next = clampZone(state.id, state.startSize + sizeDelta, state.box);
    if (next === currentSizes[state.id]) return;
    publish({ ...currentSizes, [state.id]: next });
  }, []);

  const endDrag = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    const state = drag.current;
    drag.current = null;
    document.body.classList.remove('zone-resizing', 'zone-resizing-col', 'zone-resizing-row');
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (state === null || !state.moved) return;
    /* 松手这一刻才落盘：整表一次写（值已经夹过），返回值就是落盘的那一份。 */
    publish(persistZones(currentSizes));
    /* 拖完那一下的 `click` 要吃掉：指针落在舞台里时，浏览器会按**落点**派发 click，
       舞台的画布手势层随即把命中元素选中（R37 截图里那条白框就是这么来的）。
       拖边界不是"点选画布"，这一下 click 不能漏给产品层。 */
    swallowUntil.current = Date.now() + 500;
  }, []);

  const keyDown = useCallback((id: ZoneId) => {
    return (event: ReactKeyboardEvent<HTMLElement>): void => {
      if (event.key === 'Home' || event.key === 'Enter') {
        event.preventDefault();
        resetZone(id);
        return;
      }
      const isRowKey = event.key === 'ArrowUp' || event.key === 'ArrowDown';
      const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
      const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
      if (!forward && !backward) return;
      /* 检查器和对话框的手柄往右走时面板变窄，时间线的手柄往下走时轨道区变矮。 */
      if (isRowKey !== (ZONE_AXIS[id] === 'row')) return;
      const layout = event.currentTarget.closest('.layout');
      if (layout === null) return;
      event.preventDefault();
      const step = event.shiftKey ? ZONE_KEY_STEP * 4 : ZONE_KEY_STEP;
      const move = forward ? step : -step;
      const delta = id === 'left' ? move : -move;
      publish(saveZone(id, sizeOf(layout, id) + delta, boxOf(layout)));
    };
  }, []);

  return createElement(
    Fragment,
    null,
    ZONE_IDS.map((id) => {
      if (id === 'agent' && !agentOpen) return null;
      const value = sizes[id];
      return createElement('div', {
        key: id,
        className: `zone-handle zone-handle-${id}`,
        'data-zone-handle': id,
        'data-axis': ZONE_AXIS[id],
        'data-zone-size': typeof value === 'number' ? String(value) : '',
        /* `canvas-gesture.mjs` 的既有契约：带这个属性的元素按「不是舞台」处理，
           不启橡皮筋、不抢指针。横边那条本来就压在上区最下 4px（视觉上必须骑在缝上），
           没有这个属性时，按下会被当成「在舞台空白处起框选」—— 实测一次拖横边会
           顺手选中 4 个视觉片段（card-a/card-b/take-01/take-02）。 */
        'data-no-stage-gesture': '',
        role: 'separator',
        tabIndex: 0,
        'aria-orientation': ZONE_AXIS[id] === 'col' ? 'vertical' : 'horizontal',
        'aria-label': ZONE_LABEL[id],
        title: ZONE_TITLE[id],
        onPointerDown: beginDrag(id),
        onPointerMove: moveDrag,
        onPointerUp: endDrag,
        onPointerCancel: endDrag,
        onDoubleClick: () => {
          resetZone(id);
        },
        onKeyDown: keyDown(id),
      });
    }),
  );
}
