/**
 * 画布手势层（副线1 · S17 建，S19 扩展）
 *
 * 在舞台画面上盖一层**透明操作层**：选中框 + 8 个缩放手柄 + 框上方的旋转手柄。
 * 拖动框体移动，拉手柄缩放，拖旋转手柄转；松手才提交（单选一条 op，多选一批 op）。
 * 不碰磁盘：提交由宿主注入的 `onCommit` / `onCommitMany` 完成（宿主发 `/ops`）。
 *
 * ## 分工（写死）
 *
 * | 谁 | 负责 |
 * |---|---|
 * | 宿主 | 舞台 rect + 缩放（`getStageRect`）、选中层的声明 box（`getSelection`/`getSelectionSet`）、可点层与吸附目标（`getLayerRects`/`getSnapTargets`）、发请求 |
 * | 本模块 | 画框/手柄/参考线/橡皮筋、把指针位移换成**声明空间**增量、手势状态、Esc/右键取消 |
 *
 * ## 坐标（复用 `geometry-space.mjs`）
 *
 * - 「屏幕」= 宿主文档视口像素；「舞台局部」= (屏幕 − 舞台原点) ÷ `stageRect.scale`；
 * - 移动：`Δ声明 = L⁻¹ · Δ舞台局部`（`L` = 祖先链 2×2 线性部分）。平移/枢轴只影响绝对位置，不影响增量。
 * - 缩放：`Δ声明 = R(−r) · L⁻¹ · Δ舞台局部`。**先** `L⁻¹` 再按自身角度 `r` 投影回未旋转的 box 轴
 *   （S17 写成了先转再逆，两者只在祖先带旋转时不同；S19 按推导改正）。
 * - 绝对位置：优先用宿主实测的 `rect`（舞台局部）；没有才按 `box` + `L` 推（只对无变换祖先精确）。
 *
 * ## 手势语义（S19）
 *
 * | 操作 | 结果 |
 * |---|---|
 * | 拖框体 | 移动（多选时整组同 Δ）；至少 `GESTURE_MIN_VISIBLE`(32px) 留在舞台里，夹住时给一句可读提示 |
 * | 8 手柄 | 缩放；角手柄 + Shift = 保比例；片段最小 16×16（`GESTURE_MIN_CLIP_SIZE`），场景内图层 8×8 |
 * | 尺寸标签 | **只在手势期出现**，跟随指针（键盘微调贴框）；静止时收起，把画面让给宿主的只读标签（S40） |
 * | 数字去重 | 手势层显示数字时临时接管宿主那份只读标签（`opts.hostSizeLabel`，默认 `#clip-hud`），松手原样还回去 |
 * | 旋转手柄（框外上方 24px） | 改 `box.r`；默认吸附 1°，Shift 吸附 15°；**中心不动**（只改 r，x/y/w/h 不变） |
 * | 拖动吸附 | 舞台左/中/右、上/中/下 + 目标的**声明框**边与中线（画面矩形只兜底）+ 可选网格；阈值 **6 逻辑 px**；命中画 1px 参考线 |
 * | 缩放吸附 | 只吸**正在动的那条边**；`r≠0` 时吸 **AABB 边**并把补偿量投影回局部轴（S42） |
 * | `Alt` | 按住时**整套吸附关闭**（含网格与间距吸附），参考线/标签一并收起（松手后恢复） |
 * | 间距标签 | 拖动期在两对象之间显示净空 `Npx`（每轴最近的一条），松手即消失（ED-079） |
 * | 等距分布 | 同轴 **≥3 段**间距相等（容差 1px）时显示 `= Npx =` 与整组虚线（S42）；有 run 就不再画单段 |
 * | Shift + 点 | 加选/减选（在层上或框体上） |
 * | 空白处拖 | 橡皮筋框选（坐标裁到舞台内） |
 * | 多选 | 只画一个外接框 + 8 手柄；缩放只做**等比**（每层都无祖先变换时才允许，否则只移动） |
 * | 松手 | 单选 `onCommit(op)`；多选 `onCommitMany([op, …])`（一批，一步撤销） |
 * | Esc / 右键 | 取消：不提交、`onCancel`、框回原位 |
 * | 触摸 / 触控笔 | 与鼠标同一条状态机（Pointer Events，`pointerType` 只影响手感参数）：位移 ≤8px 且 ≤300ms = 点选（0 op）；>8px 才进拖拽；手柄热区 44×44；HUD 相对手指 12px 且翻到上方；`pointercancel` 走取消（回滚、不写盘） |
 *
 * ## 极小目标（S19）
 *
 * 手柄放在一个至少 `GESTURE_RING_MIN`(28px) 的**外扩环**上（环不画线、只放手柄），
 * 框线仍是真实尺寸——8×8 的层也能逐个抓住 8 个手柄，不会互相压住。
 *
 * 不新增 op、不改 `set field:'box'` 语义；op 由 `patchForBoxValue` 生成（`r=0` 不落）。
 *
 * ## 吸附与间距（S38 / ED-079）
 *
 * 实现只有一份：`snap.mjs`。本模块是它的两处调用点之一（另一处见该文件头）：
 *
 * | 手势 | 调用 | 吸哪些线 |
 * |---|---|---|
 * | 移动 | `snapRect` | 整组外接框的左/中/右、上/中/下 ↔ 舞台 + 每个目标 + 网格 |
 * | 缩放 | `snapEdges` | **只有正在动的那条边**（锚定边不动，否则 A2 的对侧锚点会被拽走） |
 *
 * 间距读数 `measureGaps` 每帧算；间距吸附 `snapGap` 用「手势开始时的净空」做参照，
 * 让 24px 这种整值吸得住。`Alt` 一按全关。
 *
 * ## 框的几何取谁（S37 / R20-C4）
 *
 * 没有祖先线性变换时，框画在**声明的 `box`** 上，不用宿主实测的 `rect`：片段的 `rect` 可能带
 * 显示策略（网页片段按自有尺寸 contain 进声明框），拿它画框会出现「框 ≠ 你要写的 style」。
 * 有祖先变换（场景嵌套层）时仍用实测 `rect`——那时声明 px 与舞台 px 不是一个尺度。
 *
 * ## 键盘（S25）
 *
 * | 键 | 结果 |
 * |---|---|
 * | `←→↑↓` | 微移 1（默认**屏幕** px；`opts.keyboard.stepUnit='declared'` 时是声明 px） |
 * | `Shift + 方向` | 10；`Alt/Option + 方向` | 0.1 |
 * | `Tab` / `Shift+Tab` | 在可选层里循环（跳过锁定/隐藏），顺序取 `getLayerOrder()`（缺省用 `getLayerRects` 顺序） |
 * | `Esc` | 输入态里不动（先退输入）；有未提交的微移则丢弃（0 提交）；手势中取消 |
 *
 * 微移的「一批」语义：keydown 期间只在覆盖层上预览（框与 HUD 立即跟随），
 * **keyup 或 `idleMs`(300ms) 无按键**才提交一次（单选 `onCommit`，多选 `onCommitMany`）。
 * 单位换算复用 S15：屏幕增量 ÷ `stage.scale` = 舞台局部，再乘祖先线性部分的逆 = 声明增量。
 * 焦点在 `input/textarea/select/contenteditable` 时**一律不接管**方向键与 Tab。
 *
 * ## 接宿主前先自检（S22）
 *
 * ```js
 * import { checkHost } from './host-contract.mjs';
 * if (!checkHost(opts).ok) throw new Error(JSON.stringify(checkHost(opts).missing));
 * ```
 */

import { applyLinear, axisScale, invertLinear } from './geometry-space.mjs';
import { patchForBoxValue } from './inspector-fields.mjs';
import { snapRect, snapEdges, measureGaps, snapGap, measureGapRuns, snapEdgesRotated, aabbOfBox } from './snap.mjs';

export { HOST_CONTRACT, HOST_REQUIREMENTS, HOST_CONTRACT_VERSION, CAPABILITY_CODES, checkHost, createMinimalHost, createFullHost } from './host-contract.mjs';

/** 8 个缩放手柄（顺序即渲染顺序）。 */
export const GESTURE_HANDLES = Object.freeze(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']);

/** 旋转手势判定「动过」的角度阈值（度）：按角度而不是像素，短弧也算动过。 */
export const GESTURE_ROTATE_SLOP_DEG = 0.5;

/** 最小尺寸（声明空间 px）。场景内的图层用它；片段用 `GESTURE_MIN_CLIP_SIZE`。 */
export const GESTURE_MIN_SIZE = 8;

/**
 * 片段（`film.html` 里的 `<iframe>/<video>/<img>`）的最小尺寸（声明空间 px）。
 *
 * 为什么和图层分开：片段是**交付物**，16×16 以下在 1080p/4K 成片里等于看不见，
 * 而场景内的图层可以是 8×8 的装饰点。判定见 `isClipLayer`（`clip === at`）。
 */
export const GESTURE_MIN_CLIP_SIZE = 16;

/**
 * 拖动后片段至少留在舞台里的可见边长（声明空间 px）。
 *
 * 8px 的规则来自 S19「别拖到完全看不见」，但 8px 在缩放到 60% 的预览里只剩 4.8 屏幕 px，
 * 手感上就是「拖丢了」。片段按 32px 算：够得着、看得见，又不至于把画布边缘变成硬墙。
 */
export const GESTURE_MIN_VISIBLE = 32;

/** 手柄环的最小边长（屏幕 px）：框比它小时，手柄外扩到这个尺寸，互不重叠。 */
export const GESTURE_RING_MIN = 28;

/** 手柄命中方块边长（屏幕 px）。 */
export const GESTURE_HANDLE_PX = 12;

/** 旋转手柄离环顶的距离（屏幕 px）。 */
export const GESTURE_ROTATE_OFFSET = 24;

/** 吸附阈值（屏幕 px）。 */
export const GESTURE_SNAP_PX = 6;

/** 旋转默认吸附步长（度）；按住 Shift 用 15°。 */
export const GESTURE_ROTATE_STEP = 1;
export const GESTURE_ROTATE_STEP_SHIFT = 15;

/** 手势层不写盘：提交交给宿主（`onCommit`/`onCommitMany`）。 */
export const GESTURE_PERSISTENCE = 'host-callback';

/**
 * 鼠标：按下后位移不超过这个值（屏幕 px）视为点击，不产生手势。
 * 鼠标是精确设备，0.5px 的抖动都不该被当成拖动（S17 起的老口径，别改）。
 */
export const GESTURE_CLICK_SLOP = 0.5;

/**
 * 触摸/触控笔的 tap 判定（S44）：位移 **≤8px 且时长 ≤300ms** 只算点选，不进 `/ops`。
 *
 * 为什么不能沿用 0.5px：手指按下时的接触面有 8~12px 的抖动，0.5px 的阈值会让「点一下」
 * 变成「移动 2px」——一次点选就多出一条 op，还进撤销栈。8px 是触摸圈常用的容差
 * （Material/Ant 的手势库都用这个量级），再大就会把「轻微拖一下」也吃掉。
 */
export const GESTURE_TAP_MAX_MOVE = 8;
export const GESTURE_TAP_MAX_MS = 300;

/**
 * 点击穿透（S97）：片段框盖着舞台时，**按下不移动地松手**要当成一次点击转给场景页。
 *
 * 判据是两个数：位移 **< 4px** 且时长 **< 300ms**。为什么是 4 而不是 0.5：
 * 0.5 是「鼠标抖没抖」的阈值，这里要判的是「用户想不想拖」——手按下去再抬起来，
 * 3px 以内的抖动是常态（触控板更明显），拿 0.5 判会把点击全变成 3px 微移。
 * 为什么不是 8：8 是触摸 tap 的上限（`GESTURE_TAP_MAX_MOVE`），鼠标不需要那么松；
 * 4px 让「8px 的拖动」明确落在拖动侧（S97 的 S3/S4 就是量这两侧）。
 *
 * 300ms 是「点击」与「按住」的分界（与触摸 tap 同一口径），按住不放再松手不算点击。
 * 这两个值进证据，不许写成「看情况」。
 */
export const GESTURE_CLICK_THROUGH_SLOP_PX = 4;
export const GESTURE_CLICK_THROUGH_MS = 300;

/**
 * 触摸/触控笔的手柄命中区边长（屏幕 px）。
 *
 * 视觉上仍是 12px 的小方块（`GESTURE_HANDLE_PX`）：热区放大不改变画面，只是让手指点得中。
 * 44px 是 Apple HIG 的最小可点尺寸；只有在**粗指针**设备上才打开（`(pointer: coarse)` 或
 * `maxTouchPoints > 0`），鼠标路径一个字节都不变。
 */
export const GESTURE_TOUCH_HANDLE_HIT_PX = 44;

/**
 * 触摸/触控笔时 HUD 相对手指的偏移（屏幕 px）。
 *
 * 鼠标是 +14/+18（右下方，不挡框）；手指的接触点会被指头本身盖住，所以触屏改成
 * **右上方 12px**（`x+12`、`y-hudH-12`）：既不离触点太远，又不会被指腹压住。
 */
export const GESTURE_TOUCH_HUD_OFFSET = 12;

/**
 * 宿主自己画的那份**只读**尺寸标签（Studio 的 `clip-hud`）。
 *
 * 手势层显示数字时会把它临时藏起来，松手原样还回去——否则画布上同时有两组数字，而宿主
 * 那份是 React state 派生的，拖动期还是旧值（实测框已到 257,180，它还写着 100,120）。
 * 传 `null` 可以关掉这个接管，或传自己的选择器。
 */
export const GESTURE_HOST_SIZE_LABEL = '[data-testid="clip-hud"]';

/**
 * 方向键微移步长（默认按**屏幕** px 解释，再换算成声明增量）。
 *
 * 为什么默认是屏幕 px：S15 起面板的几何输入就是「用户看到多少就输多少」，
 * 微移沿用同一套语义——祖先 `scale(2)` 时按一下屏幕走 1px、声明只走 0.5px。
 * 要「按声明值走」的宿主传 `keyboard.stepUnit: 'declared'`（此时多选只看第一层的线性部分）。
 */
export const GESTURE_NUDGE_STEPS = Object.freeze({ plain: 1, shift: 10, alt: 0.1 });

/** 连按微移的合并窗口（ms）：keyup 或这么久没有新按键就提交成一批。 */
export const GESTURE_NUDGE_IDLE_MS = 300;

/** 方向键 → 单位向量（屏幕坐标 y 向下）。 */
const ARROW_VECTORS = Object.freeze({
  ArrowLeft: Object.freeze({ x: -1, y: 0 }),
  ArrowRight: Object.freeze({ x: 1, y: 0 }),
  ArrowUp: Object.freeze({ x: 0, y: -1 }),
  ArrowDown: Object.freeze({ x: 0, y: 1 })
});

/** 这些标签里的方向键属于输入，不属于画布。 */
const EDITABLE_TAGS = Object.freeze(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION']);

/** 手柄光标（旋转层的方向不完全对应，视觉上仍比默认光标好）。 */
const HANDLE_CURSOR = Object.freeze({
  nw: 'nwse-resize',
  n: 'ns-resize',
  ne: 'nesw-resize',
  e: 'ew-resize',
  se: 'nwse-resize',
  s: 'ns-resize',
  sw: 'nesw-resize',
  w: 'ew-resize',
  rotate: 'grab'
});

/** @typedef {{x: number, y: number, w: number, h: number, r?: number}} Box4 */
/** @typedef {{a: number, b: number, c: number, d: number}} Linear */
/** @typedef {{x: number, y: number, w: number, h: number}} Rect4 */
/** @typedef {{x: number, y: number, w: number, h: number, scale: number}} StageRect */
/** @typedef {{linear?: Linear | null, rotationDeg?: number, ok?: boolean}} SelectionGeometry */
/**
 * 一层（选中项或可点项）。`box` 是声明值，`rect` 是舞台局部实测（优先用于画框）。
 * @typedef {object} Layer
 * @property {string} at
 * @property {Box4} box
 * @property {Rect4} [rect]
 * @property {SelectionGeometry} [geometry]
 * @property {string} [clip]
 * @property {boolean} [locked]
 */

const round3 = (/** @type {number} */ n) => Math.round(n * 1000) / 1000;

/** @param {unknown} v */
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

/** 角度归一到 (−180, 180]。 @param {number} deg */
export function normalizeDegrees(deg) {
  let d = ((deg % 360) + 360) % 360;
  if (d > 180) d -= 360;
  return d === 180 ? 180 : round3(d);
}

/** 按步长吸附角度。 @param {number} deg @param {number} step */
export function snapDegrees(deg, step) {
  const s = Number.isFinite(step) && step > 0 ? step : GESTURE_ROTATE_STEP;
  return normalizeDegrees(Math.round(deg / s) * s);
}

/**
 * 纯函数：把一次拖动/缩放应用到 box 上。
 *
 * `dx/dy` 是**声明空间**的增量（调用方已从屏幕换算）。带 `rotationDeg` 时按
 * 「对侧锚点在声明空间里不动」解算 x/y——这是 S19 对 S17「旋转层缩放漂移」的修法：
 * 元素绕自身中心转 r，所以中心随宽高变化时 x/y 必须反向补偿，视觉上对侧才钉住。
 *
 * @param {object} input
 * @param {'move'|'resize'} input.mode
 * @param {string} [input.handle]                 `nw|n|ne|e|se|s|sw|w`
 * @param {Box4} input.box                        起始声明 box
 * @param {number} [input.dx]                      声明空间 X 增量
 * @param {number} [input.dy]                      声明空间 Y 增量
 * @param {boolean} [input.shift]                  角手柄保比例
 * @param {number} [input.minSize]
 * @param {{w: number, h: number} | null} [input.stageSize] 舞台逻辑尺寸（夹范围用）
 * @param {number} [input.rotationDeg]             该层自身的 `r`（度）
 * @returns {Box4}
 */
export function dragBox(input) {
  const start = {
    x: finite(input.box?.x),
    y: finite(input.box?.y),
    w: finite(input.box?.w),
    h: finite(input.box?.h)
  };
  const dx = finite(input.dx ?? 0) || 0;
  const dy = finite(input.dy ?? 0) || 0;
  const minSize = Number.isFinite(input.minSize) && /** @type {number} */ (input.minSize) > 0 ? /** @type {number} */ (input.minSize) : GESTURE_MIN_SIZE;
  const stage = input.stageSize && Number.isFinite(input.stageSize.w) && Number.isFinite(input.stageSize.h) ? input.stageSize : null;

  if (input.mode === 'move') {
    let x = start.x + dx;
    let y = start.y + dy;
    if (stage && start.w > 0 && start.h > 0) {
      /* 至少 minSize 留在舞台里（避免把层拖到完全看不见） */
      const stay = Math.min(minSize, stage.w, stage.h);
      x = Math.min(Math.max(x, stay - start.w), stage.w - stay);
      y = Math.min(Math.max(y, stay - start.h), stage.h - stay);
    }
    return { x: round3(x), y: round3(y), w: round3(start.w), h: round3(start.h) };
  }

  const handle = typeof input.handle === 'string' ? input.handle : '';
  if (!GESTURE_HANDLES.includes(handle)) return { ...start };
  if (!(start.w > 0) || !(start.h > 0)) return { ...start };

  let w = start.w + (handle.includes('e') ? dx : 0) - (handle.includes('w') ? dx : 0);
  let h = start.h + (handle.includes('s') ? dy : 0) - (handle.includes('n') ? dy : 0);

  /* 角手柄 + Shift：按较大的一轴缩放，锚点（对角）不动 → 宽高比误差只来自一次取整 */
  if (input.shift === true && handle.length === 2) {
    const factor = Math.max(w / start.w, h / start.h);
    w = start.w * factor;
    h = start.h * factor;
  }

  /* 夹尺寸：最小 8×8；不超过舞台逻辑尺寸 */
  const maxW = stage ? Math.max(minSize, stage.w) : Number.POSITIVE_INFINITY;
  const maxH = stage ? Math.max(minSize, stage.h) : Number.POSITIVE_INFINITY;
  w = Math.min(Math.max(w, minSize), maxW);
  h = Math.min(Math.max(h, minSize), maxH);

  /* 对侧锚点（声明空间）：x/y 由「锚点不动」反解——r=0 时与直接加减等价 */
  const r = finite(input.rotationDeg ?? 0) || 0;
  const ax = handle.includes('w') ? 1 : handle.includes('e') ? -1 : 0;
  const ay = handle.includes('n') ? 1 : handle.includes('s') ? -1 : 0;
  const c0 = { x: start.x + start.w / 2, y: start.y + start.h / 2 };
  const anchor = anchorPointOf({ x: c0.x - start.w / 2, y: c0.y - start.h / 2, w: start.w, h: start.h }, handle, r);
  const rad = (r * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const offX = ax * (w / 2);
  const offY = ay * (h / 2);
  const c1 = {
    x: anchor.x - (offX * cos - offY * sin),
    y: anchor.y - (offX * sin + offY * cos)
  };
  return { x: round3(c1.x - w / 2), y: round3(c1.y - h / 2), w: round3(w), h: round3(h) };
}

/**
 * 对侧锚点（声明空间）。缩放时这个点不动——A7 的漂移量就是它的前后距离。
 * @param {Box4} box
 * @param {string} handle
 * @param {number} [rotationDeg]
 * @returns {{x: number, y: number}}
 */
export function anchorPointOf(box, handle, rotationDeg = 0) {
  const ax = handle.includes('w') ? 1 : handle.includes('e') ? -1 : 0;
  const ay = handle.includes('n') ? 1 : handle.includes('s') ? -1 : 0;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const rad = ((finite(rotationDeg) || 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const ox = ax * (box.w / 2);
  const oy = ay * (box.h / 2);
  return { x: round3(cx + ox * cos - oy * sin), y: round3(cy + ox * sin + oy * cos) };
}

/**
 * 这个「层」是不是 `film.html` 里的片段（而不是场景内的一层）。
 *
 * 判定只看宿主给的形状：片段宿主把 `at` 和 `clip` 都填成片段 id（App.tsx 的
 * `clipPickables`/`gestureSelection` 就是这样）；场景内的层 `at` 是 CSS 路径、`clip` 才是片段。
 * 两者**恰好相等且非空**才算片段——不用额外能力位，也不猜元素类型。
 *
 * @param {{at?: string, clip?: string}} layer
 * @returns {boolean}
 */
export function isClipLayer(layer) {
  return Boolean(layer) && typeof layer.clip === 'string' && layer.clip !== '' && layer.clip === layer.at;
}

/**
 * 纯函数：这个目标的最小声明尺寸。
 *
 * 宿主显式给了 `opts.minSize` 就用它的（一个数管到底，向后兼容）；没给则按目标分档：
 * 片段 16×16、场景内图层 8×8。
 *
 * @param {{at?: string, clip?: string}} layer
 * @param {number | null} [hostMin]
 * @returns {number}
 */
export function minSizeOf(layer, hostMin = null) {
  if (typeof hostMin === 'number' && Number.isFinite(hostMin) && hostMin > 0) return hostMin;
  return isClipLayer(layer) ? GESTURE_MIN_CLIP_SIZE : GESTURE_MIN_SIZE;
}

/**
 * 纯函数：把 box 夹到「至少 `minVisible` 留在舞台里」。
 *
 * 与 `dragBox` 里的 8px 规则分开：那条给场景内的图层（不该被拖出场景），
 * 这条给片段（`GESTURE_MIN_VISIBLE`）。宽高本来就小于 `minVisible` 时，
 * 夹的是「可见量」而不是把片段放大——`min(x, w)` 保证小片段也能贴边。
 *
 * @param {Box4} box
 * @param {{w: number, h: number} | null} stage
 * @param {number} [minVisible]
 * @returns {{box: Box4, clampedX: boolean, clampedY: boolean}}
 */
export function clampVisible(box, stage, minVisible = GESTURE_MIN_VISIBLE) {
  const w = finite(box.w);
  const h = finite(box.h);
  if (!stage || !(stage.w > 0) || !(stage.h > 0) || !(w > 0) || !(h > 0)) {
    return { box: { ...box }, clampedX: false, clampedY: false };
  }
  const keepX = Math.min(Math.max(0, Number(minVisible) || 0), stage.w, w);
  const keepY = Math.min(Math.max(0, Number(minVisible) || 0), stage.h, h);
  const minX = keepX - w;
  const maxX = stage.w - keepX;
  const minY = keepY - h;
  const maxY = stage.h - keepY;
  const x = Math.min(Math.max(finite(box.x), minX), maxX);
  const y = Math.min(Math.max(finite(box.y), minY), maxY);
  return {
    box: { ...box, x: round3(x), y: round3(y) },
    clampedX: Math.abs(x - finite(box.x)) > 1e-9,
    clampedY: Math.abs(y - finite(box.y)) > 1e-9
  };
}

/**
 * 纯函数：多选整体移动时，把**同一个**位移夹到「并集框至少 `minVisible` 可见」。
 *
 * 多选必须保持刚性（各层同 Δ），所以不能逐层夹——那会把整组挤变形。
 * 这里只在并集框要出界时把 Δ 收回，返回收多少。
 *
 * @param {Rect4} union 移动前的并集框（舞台局部）
 * @param {{x: number, y: number}} delta 期望位移
 * @param {{w: number, h: number} | null} stage
 * @param {number} [minVisible]
 * @returns {{dx: number, dy: number, clampedX: boolean, clampedY: boolean}}
 */
export function clampGroupDelta(union, delta, stage, minVisible = GESTURE_MIN_VISIBLE) {
  if (!stage || !(stage.w > 0) || !(stage.h > 0)) {
    return { dx: delta.x, dy: delta.y, clampedX: false, clampedY: false };
  }
  const keepX = Math.min(Math.max(0, Number(minVisible) || 0), stage.w, Math.max(0, union.w));
  const keepY = Math.min(Math.max(0, Number(minVisible) || 0), stage.h, Math.max(0, union.h));
  const loX = keepX - union.w - union.x;
  const hiX = stage.w - keepX - union.x;
  const loY = keepY - union.h - union.y;
  const hiY = stage.h - keepY - union.y;
  const dx = Math.min(Math.max(delta.x, loX), hiX);
  const dy = Math.min(Math.max(delta.y, loY), hiY);
  return {
    dx,
    dy,
    clampedX: Math.abs(dx - delta.x) > 1e-9,
    clampedY: Math.abs(dy - delta.y) > 1e-9
  };
}

/**
 * 把屏幕位移换算成**声明空间**增量。
 *
 * 顺序（S19 修正）：`Δ/scale` → `L⁻¹` → `R(−r)`。旋转缩放时把手柄位移投影回未旋转的 box 轴。
 *
 * @param {object} input
 * @param {number} input.dx 屏幕 px
 * @param {number} input.dy 屏幕 px
 * @param {number} [input.stageScale]
 * @param {Linear | null} [input.linear]
 * @param {number} [input.rotationDeg] 该层自身的 `r`
 * @param {boolean} [input.unrotate]
 * @returns {{x: number, y: number}}
 */
export function screenDeltaToDeclared(input) {
  const scale = Number.isFinite(input.stageScale) && /** @type {number} */ (input.stageScale) > 0 ? /** @type {number} */ (input.stageScale) : 1;
  let vx = (finite(input.dx) || 0) / scale;
  let vy = (finite(input.dy) || 0) / scale;
  const inv = input.linear ? invertLinear(input.linear) : null;
  if (inv) {
    const d = applyLinear(inv, vx, vy);
    vx = d.x;
    vy = d.y;
  }
  const theta = finite(input.rotationDeg ?? 0);
  if (input.unrotate === true && Number.isFinite(theta) && Math.abs(theta) > 1e-9) {
    const rad = (theta * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    const nx = vx * c + vy * s;
    const ny = -vx * s + vy * c;
    vx = nx;
    vy = ny;
  }
  return { x: round3(vx), y: round3(vy) };
}

/** 吸附实现只有一份：`snap.mjs`（S38）。这里 re-export，旧调用方（测试/宿主）不用改。 */
export { snapRect, snapEdges, measureGaps, snapGap, SNAP_THRESHOLD_PX, SNAP_GRID_MIN } from './snap.mjs';

/**
 * 指针绕中心转过的角度（度，−180…180）。
 * @param {{x:number, y:number}} center
 * @param {{x:number, y:number}} start
 * @param {{x:number, y:number}} current
 */
export function rotationDeltaOf(center, start, current) {
  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  const a1 = Math.atan2(current.y - center.y, current.x - center.x);
  return normalizeDegrees(((a1 - a0) * 180) / Math.PI);
}

/**
 * 挂载画布手势层。
 *
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {() => ({x?: number, y?: number, w?: number, h?: number, left?: number, top?: number, width?: number, height?: number, scale?: number} | null)} opts.getStageRect
 * @param {() => (Layer | null)} opts.getSelection                 单选（R9 兼容）
 * @param {() => readonly Layer[]} [opts.getSelectionSet]          多选（优先于 getSelection）
 * @param {() => readonly Layer[]} [opts.getLayerRects]            舞台可点层（点选/橡皮筋/Shift 加选）
 * @param {() => readonly Rect4[]} [opts.getSnapTargets]           吸附目标（舞台局部；选中层由本模块排除）
 * @param {(at: string) => boolean} [opts.isHidden]                会话内隐藏：不画框、不可点
 * @param {(at: string) => (Rect4 | null)} [opts.getHighlightRect] 悬停描边的舞台局部矩形（只读）
 * @param {(at: string) => boolean} [opts.isLocked]                锁定层：方向键微移直接拒绝（NUDGE_LOCKED）、Tab 跳过
 * @param {() => readonly string[]} [opts.getLayerOrder]           图层树的视觉顺序（Tab 用）；缺省用 getLayerRects 顺序
 * @param {{enabled?: boolean, stepUnit?: 'screen'|'declared', idleMs?: number, shouldHandle?: (event: KeyboardEvent) => boolean}} [opts.keyboard] 键盘路由配置
 * @param {(op: any) => void} [opts.onPreview]                     每次位移一次
 * @param {(op: any) => void} [opts.onCommit]                      单选：松手一次
 * @param {(ops: any[]) => void} [opts.onCommitMany]               多选：松手一次，一批 op
 * @param {boolean} [opts.stageBodyInput] Whether the embedded stage forwards body gestures.
 * @param {(ats: string[]) => void} [opts.onSelectionChange]       点选/框选/Shift 加选后回调
 * @param {(info: {clientX: number, clientY: number, at: string, shiftKey: boolean, distancePx: number, durationMs: number}) => void} [opts.onClickThrough]
 *        片段框上「按下→不移动→松手」（位移 < `GESTURE_CLICK_THROUGH_SLOP_PX` 且时长 < `GESTURE_CLICK_THROUGH_MS`）的回调：
 *        宿主据此把这一下转发给场景页的 pick（S97）。不给 = 点击穿透关闭，行为与以前一致。
 * @param {(info: {code: string, message: string}) => void} [opts.onError]
 * @param {() => void} [opts.onCancel]
 * @param {{w: number, h: number}} [opts.stageSize]
 * @param {number} [opts.minSize]                                  覆盖最小尺寸（不给则片段 16 / 图层 8）
 * @param {number} [opts.minVisible]                               拖动后至少留多少声明 px 可见（默认 32）
 * @param {number | null} [opts.grid]                              网格吸附步长（声明 px；null/0 = 关）
 * @param {string | null} [opts.hostSizeLabel]                     宿主自己的只读尺寸标签选择器（手势期临时接管；默认 `#clip-hud`，null = 不接管）
 * @param {string} [opts.accent]
 * @param {string} [opts.guideColor]
 */
export function mountCanvasGesture(container, opts) {
  if (!container || typeof container.appendChild !== 'function') throw new Error('mountCanvasGesture 需要一个容器元素');
  if (!opts || typeof opts.getStageRect !== 'function') throw new Error('mountCanvasGesture 需要 opts.getStageRect');
  if (typeof opts.getSelection !== 'function' && typeof opts.getSelectionSet !== 'function') {
    throw new Error('mountCanvasGesture 需要 opts.getSelection 或 opts.getSelectionSet');
  }
  if (typeof opts.onCommit !== 'function' && typeof opts.onCommitMany !== 'function') {
    throw new Error('mountCanvasGesture 需要 opts.onCommit（或 onCommitMany）');
  }

  const doc = container.ownerDocument ?? /** @type {Document} */ (globalThis.document);
  const win = doc.defaultView ?? globalThis;
  const accent = typeof opts.accent === 'string' && opts.accent ? opts.accent : '#3b82f6';
  const guideColor = typeof opts.guideColor === 'string' && opts.guideColor ? opts.guideColor : '#f43f5e';
  const optMin = opts.minSize;
  /** 宿主显式给的最小尺寸（给了就全用它的；不给则按「片段 16 / 图层 8」分）。 */
  const hostMinSize = typeof optMin === 'number' && Number.isFinite(optMin) && optMin > 0 ? optMin : null;
  const optVisible = opts.minVisible;
  const minVisible =
    typeof optVisible === 'number' && Number.isFinite(optVisible) && optVisible >= 0 ? optVisible : GESTURE_MIN_VISIBLE;
  /** @param {{at?: string, clip?: string}} layer */
  const minSizeFor = (layer) => minSizeOf(layer, hostMinSize);

  /* ── DOM ─────────────────────────────────────────────────────────────── */

  const overlay = doc.createElement('div');
  overlay.setAttribute('data-canvas-gesture', '');
  overlay.setAttribute('data-gesture-active', 'false');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.cssText = [
    'position:fixed',
    'left:0',
    'top:0',
    'width:0',
    'height:0',
    'pointer-events:none',
    /* 手势期间改成 auto（拖拽盾）；不给 touch-action:none 的话，手指一滑浏览器就开始滚页面 */
    'touch-action:none',
    'z-index:40',
    'contain:layout style',
    /* 覆盖层 = 舞台画面本身：框/手柄/HUD 一律裁在画面内（S37）。
       不裁的话，拖到画布边缘的片段会把框画到时间线上，挡住点击（A6 实测踩到）。 */
    'overflow:hidden'
  ].join(';');

  const frame = doc.createElement('div');
  frame.setAttribute('data-gesture-part', 'body');
  frame.setAttribute('data-gesture-frame', '');
  frame.style.cssText = [
    'position:absolute',
    'pointer-events:auto',
    'cursor:move',
    'background:transparent',
    /* 用 box-shadow 画 1px 线：不占布局、不改 rect（对齐 ≤1px 靠这个） */
    `box-shadow:0 0 0 1px ${accent}`,
    'outline:none',
    'touch-action:none'
  ].join(';');

  /* 手柄环：至少 28px，框更小时外扩；环自己不画线、不吃事件，只有手柄吃 */
  const ring = doc.createElement('div');
  ring.setAttribute('data-gesture-ring', '');
  ring.style.cssText = [
    'position:absolute',
    'pointer-events:none',
    'transform-origin:50% 50%',
    'touch-action:none'
  ].join(';');

  /* 极小目标的拖动垫：环大小，只在框比环小时出现（否则会挡住框外点击） */
  const pad = doc.createElement('div');
  pad.setAttribute('data-gesture-part', 'body');
  pad.setAttribute('data-gesture-pad', '');
  pad.style.cssText = ['position:absolute', 'left:0', 'top:0', 'width:100%', 'height:100%', 'pointer-events:auto', 'cursor:move', 'display:none'].join(';');

  /** @type {Map<string, HTMLElement>} */
  const handleNodes = new Map();
  /** @type {Map<string, HTMLElement>} 触摸热区（44×44；粗指针设备才吃事件） */
  const handleHits = new Map();
  for (const name of GESTURE_HANDLES) {
    const dot = doc.createElement('div');
    dot.setAttribute('data-handle', name);
    dot.style.cssText = [
      'position:absolute',
      `width:${GESTURE_HANDLE_PX}px`,
      `height:${GESTURE_HANDLE_PX}px`,
      'margin:0',
      'background:#fff',
      `border:1px solid ${accent}`,
      'border-radius:2px',
      'box-sizing:border-box',
      `cursor:${HANDLE_CURSOR[/** @type {keyof typeof HANDLE_CURSOR} */ (name)]}`,
      'pointer-events:auto',
      'touch-action:none',
      'transform:translate(-50%,-50%)'
    ].join(';');
    const pos = handleOffset(name);
    dot.style.left = pos.left;
    dot.style.top = pos.top;
    /* 热区：与视觉方块同心、44×44、透明。视觉大小不变（S37 的截图不会被这一步改动），
       只是把「手指点得中」和「框画多大」解耦。子元素也带 data-handle，按下时同一套解析。 */
    const hit = doc.createElement('div');
    hit.setAttribute('data-handle', name);
    hit.setAttribute('data-handle-hit', '');
    hit.style.cssText = [
      'position:absolute',
      'left:50%',
      'top:50%',
      `width:${GESTURE_TOUCH_HANDLE_HIT_PX}px`,
      `height:${GESTURE_TOUCH_HANDLE_HIT_PX}px`,
      'margin:0',
      'background:transparent',
      'border:0',
      'transform:translate(-50%,-50%)',
      'pointer-events:none',
      `cursor:${HANDLE_CURSOR[/** @type {keyof typeof HANDLE_CURSOR} */ (name)]}`
    ].join(';');
    dot.appendChild(hit);
    handleHits.set(name, hit);
    ring.appendChild(dot);
    handleNodes.set(name, dot);
  }

  /* 旋转手柄：环顶再往外 24px；跟着环一起转 */
  const rotateHandle = doc.createElement('div');
  rotateHandle.setAttribute('data-handle', 'rotate');
  rotateHandle.style.cssText = [
    'position:absolute',
    `left:50%`,
    `top:${-GESTURE_ROTATE_OFFSET}px`,
    'width:14px',
    'height:14px',
    'border-radius:50%',
    'background:#fff',
    `border:2px solid ${accent}`,
    'box-sizing:border-box',
    'pointer-events:auto',
    'cursor:grab',
    'touch-action:none',
    'transform:translate(-50%,-50%)',
    'display:none'
  ].join(';');
  /**
   * 旋转手柄的触摸热区：44×44，但**只向上长**（`translate(-50%,-100%)`）。
   *
   * 为什么不像 8 个缩放手柄那样居中：旋转手柄的中心只比环顶高 24px（`GESTURE_ROTATE_OFFSET`），
   * 两个 44×44 的居中热区必然重叠 20px —— 实测 `n` 手柄的上半截会被旋转手柄抢走，只剩 24px
   * 高（A4 的 24 就是它）。旋转手柄在环顶之外、上方没有别的东西，所以把热区整体上移：
   * 它自己仍有 44px 可点（加上 14px 的视觉圆本身），`n` 手柄拿回完整的 44×44。
   */
  const rotateHit = doc.createElement('div');
  rotateHit.setAttribute('data-handle', 'rotate');
  rotateHit.setAttribute('data-handle-hit', '');
  rotateHit.style.cssText = [
    'position:absolute',
    'left:50%',
    'top:50%',
    `width:${GESTURE_TOUCH_HANDLE_HIT_PX}px`,
    `height:${GESTURE_TOUCH_HANDLE_HIT_PX}px`,
    'background:transparent',
    'border:0',
    'transform:translate(-50%,-100%)',
    'pointer-events:none',
    'cursor:grab'
  ].join(';');
  rotateHandle.appendChild(rotateHit);
  ring.appendChild(rotateHandle);

  /**
   * 粗指针判定：`(pointer: coarse)` 或 `maxTouchPoints > 0`。
   *
   * 只看媒体查询不够：触屏笔记本外接鼠标时它会报 fine，但用户仍可能用手指点。
   * 反过来只看 maxTouchPoints 也不会误伤纯鼠标机器（那里是 0）。
   */
  function isCoarsePointer() {
    try {
      if (typeof win.matchMedia === 'function' && win.matchMedia('(pointer: coarse)').matches) return true;
    } catch {
      /* matchMedia 不可用就退回 maxTouchPoints */
    }
    const nav = /** @type {any} */ (win.navigator);
    return Number(nav?.maxTouchPoints ?? 0) > 0;
  }

  const pointerMode = { coarse: isCoarsePointer() };
  /** 粗指针：热区吃事件；鼠标：热区透明不拦（回归零风险）。 */
  function applyPointerMode() {
    const pe = pointerMode.coarse ? 'auto' : 'none';
    for (const hit of handleHits.values()) hit.style.pointerEvents = pe;
    rotateHit.style.pointerEvents = pe;
  }
  applyPointerMode();

  /** 单调时钟（SceneHost 会虚拟化 performance.now，仍然单调；取不到就退回 Date.now）。 */
  function nowMs() {
    try {
      return Number(win.performance.now());
    } catch {
      return Date.now();
    }
  }

  /** 本次手势是不是「手指/笔」：只影响手感参数，不影响状态机。 */
  function isTouchLike() {
    return state.pointerType === 'touch' || state.pointerType === 'pen';
  }

  /** @type {Record<'x'|'y', HTMLElement>} */
  const guides = {
    x: doc.createElement('div'),
    y: doc.createElement('div')
  };
  for (const axis of /** @type {const} */ (['x', 'y'])) {
    const line = guides[axis];
    line.setAttribute('data-gesture-guide', axis);
    line.style.cssText = [
      'position:absolute',
      'pointer-events:none',
      `background:${guideColor}`,
      'display:none',
      'box-shadow:none',
      axis === 'x' ? 'width:1px;top:0;height:100%' : 'height:1px;left:0;width:100%'
    ].join(';');
    overlay.appendChild(line);
  }

  const band = doc.createElement('div');
  band.setAttribute('data-gesture-band', '');
  band.style.cssText = [
    'position:absolute',
    'pointer-events:none',
    'display:none',
    `border:1px dashed ${accent}`,
    'background:rgba(59,130,246,0.10)',
    'box-sizing:border-box'
  ].join(';');

  const hud = doc.createElement('div');
  hud.setAttribute('data-gesture-hud', '');
  hud.style.cssText = [
    'position:absolute',
    'pointer-events:none',
    'padding:2px 6px',
    'border-radius:4px',
    `background:${accent}`,
    'color:#fff',
    'font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace',
    'white-space:nowrap',
    'display:none'
  ].join(';');

  /**
   * 间距标签（S38 / ED-079）：拖动期显示「两个对象之间的净空」，松手即消失。
   * 标签 + 一条虚线，各自沿轴；数值取整数 px，单位写进 `data-gap-unit`。
   */
  /** @type {Record<'x'|'y', HTMLElement>} */
  const gapLabels = { x: doc.createElement('div'), y: doc.createElement('div') };
  /** @type {Record<'x'|'y', HTMLElement>} */
  const gapLines = { x: doc.createElement('div'), y: doc.createElement('div') };
  for (const axis of /** @type {const} */ (['x', 'y'])) {
    const label = gapLabels[axis];
    label.setAttribute('data-gesture-gap', axis);
    label.setAttribute('data-gap-unit', 'px');
    label.style.cssText = [
      'position:absolute',
      'pointer-events:none',
      'padding:1px 5px',
      'border-radius:999px',
      'background:#fff',
      'color:#111827',
      `box-shadow:0 0 0 1px ${guideColor}`,
      'font:10px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace',
      'white-space:nowrap',
      'display:none',
      'transform:translate(-50%,-50%)'
    ].join(';');
    const line = gapLines[axis];
    line.setAttribute('data-gesture-gapline', axis);
    line.style.cssText = [
      'position:absolute',
      'pointer-events:none',
      `border${axis === 'x' ? '-top' : '-left'}:1px dashed ${guideColor}`,
      'display:none',
      axis === 'x' ? 'height:0' : 'width:0'
    ].join(';');
    overlay.appendChild(line);
    overlay.appendChild(label);
  }

  /**
   * 等距分布的标签与线（S42）。
   *
   * 与「单个净空」那套**分开的 DOM**：老的 `[data-gesture-gap]` / `[data-gesture-gapline]`
   * 语义一点没变（S38 的断言还在用），新的只在这两条属性上出现：
   * - 标签 `[data-gesture-gap-run]`：文本 `= 24px =`（两边的等号是「这是一组等距」的记号）
   * - 线 `[data-gesture-gapline-run]`：一组虚线，每段间距一条
   *
   * 一组 run 只画**一个数字**（挂在离被拖对象最近的那段上）：三段 24px 挨着排，
   * 三个 `= 24px =` 会互相压住，反而看不清。段数写进 `data-gap-count`。
   */
  /** @type {Record<'x'|'y', HTMLElement>} */
  const runLabels = { x: doc.createElement('div'), y: doc.createElement('div') };
  /** @type {Record<'x'|'y', HTMLElement>} */
  const runWraps = { x: doc.createElement('div'), y: doc.createElement('div') };
  for (const axis of /** @type {const} */ (['x', 'y'])) {
    const label = runLabels[axis];
    label.setAttribute('data-gesture-gap-run', axis);
    label.setAttribute('data-gap-unit', 'px');
    label.style.cssText = [
      'position:absolute',
      'pointer-events:none',
      'padding:1px 6px',
      'border-radius:999px',
      'background:#111827',
      'color:#fff',
      `box-shadow:0 0 0 1px ${guideColor}`,
      'font:10px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace',
      'white-space:nowrap',
      'display:none',
      'transform:translate(-50%,-50%)'
    ].join(';');
    const wrap = runWraps[axis];
    wrap.setAttribute('data-gesture-gapline-run', axis);
    wrap.style.cssText = ['position:absolute', 'left:0', 'top:0', 'right:0', 'bottom:0', 'pointer-events:none', 'display:none'].join(';');
    overlay.appendChild(wrap);
    overlay.appendChild(label);
  }

  /**
   * 宿主那份只读尺寸标签（`clip-hud`）的接管状态。
   *
   * 只在**手势层正在显示数字**的这段窗口里藏它，其余时刻一律不管——它才是静止时的权威值。
   * 记下原来的行内 `display` 原样还回去（不假设它是空串）。
   */
  const hostLabel = {
    el: /** @type {HTMLElement | null} */ (null),
    prevDisplay: '',
    active: false
  };

  function hostLabelSelector() {
    const raw = opts.hostSizeLabel;
    if (raw === null) return '';
    return typeof raw === 'string' && raw !== '' ? raw : GESTURE_HOST_SIZE_LABEL;
  }

  /** 手势期接管：宿主那份是 React state 派生的，拖动期间还是旧值，露着就是骗人。 */
  function suppressHostSizeLabel() {
    const selector = hostLabelSelector();
    if (selector === '') return;
    /* 已经被宿主自己隐藏/移除就不管 */
    if (hostLabel.active && hostLabel.el && hostLabel.el.isConnected) return;
    let el = null;
    try {
      el = /** @type {HTMLElement | null} */ (doc.querySelector(selector));
    } catch {
      el = null;
    }
    if (!el) return;
    hostLabel.el = el;
    hostLabel.prevDisplay = el.style.display;
    el.style.display = 'none';
    hostLabel.active = true;
  }

  /** 手势结束/销毁：原样还回去（宿主中途换了节点就跳过，不写别人的 DOM）。 */
  function restoreHostSizeLabel() {
    if (!hostLabel.active) return;
    const el = hostLabel.el;
    if (el && el.isConnected) el.style.display = hostLabel.prevDisplay;
    hostLabel.el = null;
    hostLabel.active = false;
  }

  /* 悬停描边（S20 hover 联动）：只读、不吃事件 */
  const highlight = doc.createElement('div');
  highlight.setAttribute('data-gesture-highlight', '');
  highlight.style.cssText = [
    'position:absolute',
    'pointer-events:none',
    'display:none',
    `box-shadow:0 0 0 1px ${accent}b3`,
    'border-radius:1px'
  ].join(';');

  ring.insertBefore(pad, ring.firstChild);
  overlay.appendChild(frame);
  overlay.appendChild(ring);
  overlay.appendChild(highlight);
  overlay.appendChild(band);
  overlay.appendChild(hud);
  container.appendChild(overlay);

  /** @param {string} name */
  function handleOffset(name) {
    const x = name.includes('w') ? '0%' : name.includes('e') ? '100%' : '50%';
    const y = name.includes('n') ? '0%' : name.includes('s') ? '100%' : '50%';
    return { left: x, top: y };
  }

  /* ── 状态 ────────────────────────────────────────────────────────────── */

  const state = /** @type {{
    stage: StageRect | null,
    layers: Layer[],
    frameRect: any,
    handleBox: any,
    mode: 'move' | 'resize' | 'rotate' | 'band' | 'nudge' | null,
    handle: string,
    start: any,
    moved: boolean,
    shift: boolean,
    bandRect: {x: number, y: number, w: number, h: number} | null,
    guides: {axis: 'x' | 'y', at: number}[],
    guideDetails: {axis: 'x' | 'y', at: number, kind: string, source: string, delta: number}[],
    lastOp: any,
    lastOps: any[],
    previewOp: any,
    commits: number,
    cancels: number,
    previews: number,
    frames: number,
    lastResizeDrift: number | null,
    error: {code: string, message: string} | null,
    fallbackWarned: string,
    highlightAt: string,
    capture: {el: any, pointerId: number} | null,
    lastPoint: {clientX: number, clientY: number} | null,
    previewFrameOverride: any,
    holdPreview: boolean,
    holdSelection: boolean,
    nudge: any,
    nudgeReason: string,
    keyboardFrames: number,
    clampAxis: string,
    clampReported: boolean,
    altKey: boolean,
    targets: any[] | null,
    gaps: {axis: 'x'|'y', side: 'left'|'right'|'top'|'bottom', gap: number, from: number, to: number, at: number}[],
    gapRuns: any[],
    gapSnapped: {axis: 'x'|'y', side: string, gap: number} | null,
    pointerType: string,
    pointerId: number | null,
    gestureStartedAt: number,
    taps: number,
    lastGesture: any,
    cancelReason: string
  }} */ ({
    stage: null,
    /** @type {Layer[]} */
    layers: [],
    /** @type {any} */ frameRect: null,
    /** @type {any} */ handleBox: null,
    /** 'move'|'resize'|'rotate'|'band'|null */ mode: null,
    handle: '',
    /** @type {any} */ start: null,
    moved: false,
    shift: false,
    /** @type {any} */ bandRect: null,
    /** @type {{axis:'x'|'y', at:number}[]} */ guides: [],
    /** @type {{axis:'x'|'y', at:number, kind:string, source:string, delta:number}[]} */ guideDetails: [],
    /** @type {any} */ lastOp: null,
    /** @type {any[]} */ lastOps: [],
    /** @type {any} */ previewOp: null,
    commits: 0,
    cancels: 0,
    previews: 0,
    frames: 0,
    lastResizeDrift: null,
    error: null,
    fallbackWarned: '',
    highlightAt: '',
    capture: null,
    lastPoint: null,
    previewFrameOverride: null,
    /* 提交后保持预览，直到宿主 refresh（否则会在落盘回读之间闪回原位） */
    holdPreview: false,
    /* 刚由本模块改过选择：这一段里 render 不重读宿主（宿主可能是异步 setState，
       立刻重读会把选择弹回旧值——S25 Tab 循环踩到过） */
    holdSelection: false,
    /** @type {any} */ nudge: null,
    nudgeReason: '',
    keyboardFrames: 0,
    /* 最近一次手势里被「至少 32px 可见」夹住的轴（'' / 'x' / 'y' / 'xy'） */
    clampAxis: '',
    /* 一次手势只提示一次（pointermove 每帧都夹，不能每帧都弹） */
    clampReported: false,
    /* Alt 按住 = 临时关闭吸附（S38）：每次 pointermove / keydown 都刷新 */
    altKey: false,
    targets: null,
    /** @type {any[]} 拖动期的间距读数（≤4 条：左右上下各一条） */
    gaps: [],
    /** @type {any[]} 拖动期的等距分布（S42：≥3 段间距相等，每轴每侧最多一条） */
    gapRuns: [],
    /** @type {any} 间距吸附命中的那一条（没有就是 null） */
    gapSnapped: null,
    /* 当前/上一次手势的指针类型（'mouse' | 'touch' | 'pen'；松手后保留在 lastGesture 里） */
    pointerType: '',
    pointerId: null,
    gestureStartedAt: 0,
    /* 触摸点选的次数（只有 touch/pen 且未移动的松手才 +1） */
    taps: 0,
    /** @type {any} 最近一次手势的可读账本（类型/是否移动/时长/位移/结果） */
    lastGesture: null,
    /* 本次取消的原因（endGesture 把它写进账本后清掉，避免粘到下一次手势上） */
    cancelReason: ''
  });

  /* ── 读宿主状态 ──────────────────────────────────────────────────────── */

  function readStage() {
    let raw = null;
    try {
      raw = opts.getStageRect();
    } catch {
      raw = null;
    }
    if (!raw || typeof raw !== 'object') return null;
    const x = finite(raw.x ?? raw.left);
    const y = finite(raw.y ?? raw.top);
    const w = finite(raw.w ?? raw.width);
    const h = finite(raw.h ?? raw.height);
    if (![x, y, w, h].every(Number.isFinite)) return null;
    const scale = Number.isFinite(raw.scale) && /** @type {number} */ (raw.scale) > 0 ? /** @type {number} */ (raw.scale) : 1;
    return { x, y, w, h, scale };
  }

  /** @param {any} raw @returns {Layer | null} */
  function normalizeLayer(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const at = typeof raw.at === 'string' ? raw.at : '';
    const box = raw.box && typeof raw.box === 'object' ? raw.box : null;
    if (!at || !box) return null;
    const x = finite(box.x);
    const y = finite(box.y);
    const w = finite(box.w ?? box.width);
    const h = finite(box.h ?? box.height);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
    /** @type {Layer} */
    const layer = { at, box: { x, y, w, h } };
    const r = finite(box.r ?? box.rotation);
    if (Number.isFinite(r) && r !== 0) layer.box.r = r;
    const geom = raw.geometry && typeof raw.geometry === 'object' && raw.geometry.ok !== false ? raw.geometry : null;
    if (geom) layer.geometry = geom;
    const rect = raw.rect && typeof raw.rect === 'object' ? raw.rect : null;
    if (rect) {
      const rx = finite(rect.x);
      const ry = finite(rect.y);
      const rw = finite(rect.w ?? rect.width);
      const rh = finite(rect.h ?? rect.height);
      if ([rx, ry, rw, rh].every(Number.isFinite) && rw >= 0 && rh >= 0) layer.rect = { x: rx, y: ry, w: rw, h: rh };
    }
    if (typeof raw.clip === 'string' && raw.clip) layer.clip = raw.clip;
    if (raw.locked === true) layer.locked = true;
    return layer;
  }

  function readSelectionSet() {
    /** @type {any} */
    let raw = null;
    try {
      if (typeof opts.getSelectionSet === 'function') raw = opts.getSelectionSet();
      else {
        const one = typeof opts.getSelection === 'function' ? opts.getSelection() : null;
        raw = one ? [one] : [];
      }
    } catch {
      raw = [];
    }
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return /** @type {Layer[]} */ (list.map(normalizeLayer).filter(Boolean));
  }

  function readPickables() {
    if (typeof opts.getLayerRects !== 'function') return [];
    try {
      const list = opts.getLayerRects();
      if (!Array.isArray(list)) return [];
      /** @type {Layer[]} */
      const out = [];
      for (const item of list) {
        const layer = normalizeLayer(item);
        if (layer && layer.rect) out.push(layer);
      }
      return out;
    } catch {
      return [];
    }
  }

  /** @param {string} at */
  function isHidden(at) {
    if (typeof opts.isHidden !== 'function') return false;
    try {
      return opts.isHidden(at) === true;
    } catch {
      return false;
    }
  }

  /** @param {string} at */
  function isLocked(at) {
    const layer = state.layers.find((item) => item.at === at) ?? null;
    if (layer && layer.locked === true) return true;
    if (typeof opts.isLocked !== 'function') return false;
    try {
      return opts.isLocked(at) === true;
    } catch {
      return false;
    }
  }

  /** 键盘配置（`opts.keyboard` 缺省时给一份默认值，不共享引用）。 */
  function keyboardConfig() {
    const raw = opts.keyboard && typeof opts.keyboard === 'object' ? opts.keyboard : {};
    const idle = finite(raw.idleMs);
    return {
      enabled: raw.enabled !== false,
      stepUnit: raw.stepUnit === 'declared' ? 'declared' : 'screen',
      idleMs: Number.isFinite(idle) && idle > 0 ? idle : GESTURE_NUDGE_IDLE_MS,
      shouldHandle: typeof raw.shouldHandle === 'function' ? raw.shouldHandle : null
    };
  }

  /** 这个元素是不是「输入态」（方向键属于它，不属于画布）。 @param {any} node */
  function isEditable(node) {
    if (!node || typeof node !== 'object') return false;
    const tag = typeof node.tagName === 'string' ? node.tagName.toUpperCase() : '';
    if (EDITABLE_TAGS.includes(tag)) return true;
    return node.isContentEditable === true;
  }

  /**
   * 这次按键归不归画布管。
   *
   * 默认策略（保守）：只有焦点在 `body` / 本容器 / 覆盖层 / `[data-gesture-keys]` 上才接管。
   * 焦点在任何输入控件、图层树行、工具条按钮上时**不接管**——那些控件有自己的键盘语义
   * （S20 的树用 ↑↓←→，S26 的字段用方向键移光标），抢过来就是 bug。
   * 宿主想让别的元素也归画布，传 `keyboard.shouldHandle(event)` 自己裁决。
   * @param {KeyboardEvent} event
   */
  function keyboardOwns(event) {
    const cfg = keyboardConfig();
    if (!cfg.enabled) return false;
    const target = /** @type {any} */ (event.target);
    const active = /** @type {any} */ (doc.activeElement);
    if (isEditable(target) || isEditable(active)) return false;
    if (cfg.shouldHandle) {
      try {
        return cfg.shouldHandle(event) === true;
      } catch {
        return false;
      }
    }
    if (!active || active === doc.body || active === doc.documentElement) return true;
    if (typeof container.contains === 'function' && container.contains(active)) return true;
    if (typeof overlay.contains === 'function' && overlay.contains(active)) return true;
    if (typeof active.closest === 'function' && active.closest('[data-gesture-keys]')) return true;
    return false;
  }

  /** 这一下按了多少（屏幕 px；stepUnit='declared' 时是声明 px）。 @param {KeyboardEvent} event */
  function nudgeStepOf(event) {
    const cfg = keyboardConfig();
    const amount = event.altKey ? GESTURE_NUDGE_STEPS.alt : event.shiftKey ? GESTURE_NUDGE_STEPS.shift : GESTURE_NUDGE_STEPS.plain;
    return { amount, unit: cfg.stepUnit };
  }

  /** 累积量 → 舞台局部增量（渲染框用）。 @param {any} n */
  function nudgeStageDelta(n) {
    const stage = state.stage;
    const scale = stage && Number.isFinite(stage.scale) && stage.scale > 0 ? stage.scale : 1;
    if (n.unit === 'declared') {
      /* 声明 → 舞台：用第一层的线性部分（多选且各层祖先不同时不精确，已在交接 unverified 写明） */
      const lin = n.base.length ? linearOf(n.base[0].layer) : null;
      const p = lin ? applyLinear(lin, n.acc.x, n.acc.y) : { x: n.acc.x, y: n.acc.y };
      return { x: p.x, y: p.y };
    }
    return { x: n.acc.x / scale, y: n.acc.y / scale };
  }

  /** 累积量 → 某一层的声明增量。 @param {any} n @param {Layer} layer */
  function nudgeDeclaredDelta(n, layer) {
    if (n.unit === 'declared') return { x: n.acc.x, y: n.acc.y };
    const stageDelta = nudgeStageDelta(n);
    const lin = linearOf(layer);
    const inv = lin ? invertLinear(lin) : null;
    return inv ? applyLinear(inv, stageDelta.x, stageDelta.y) : stageDelta;
  }

  /** 按当前累积量重算 op 并只预览（不提交）。 @param {any} n */
  function previewNudge(n) {
    /** @type {any[]} */
    const ops = [];
    for (const item of n.base) {
      const d = nudgeDeclaredDelta(n, item.layer);
      /** @type {Box4} */
      const next = {
        x: round3(item.box.x + d.x),
        y: round3(item.box.y + d.y),
        w: item.box.w,
        h: item.box.h
      };
      if (typeof item.box.r === 'number' && item.box.r !== 0) next.r = item.box.r;
      const built = patchForBoxValue(next);
      if ('error' in built) continue;
      ops.push(withClip(built.op, item.layer));
    }
    n.ops = ops;
    const stageDelta = nudgeStageDelta(n);
    state.mode = 'nudge';
    state.previewOp = { ...(ops[0] ?? {}), __dxStage: stageDelta.x, __dyStage: stageDelta.y };
    state.keyboardFrames += 1;
    render();
    if (typeof opts.onPreview === 'function') {
      for (const op of ops) opts.onPreview(op);
    }
    return ops;
  }

  /**
   * 提交这一批微移（keyup / idle / blur 都走这里）。
   * @param {'keyup'|'idle'|'blur'} reason
   */
  function commitNudge(reason) {
    const n = state.nudge;
    if (!n) return false;
    if (n.timer) {
      try {
        win.clearTimeout(n.timer);
      } catch {
        /* 忽略 */
      }
    }
    state.nudge = null;
    const ops = Array.isArray(n.ops) ? n.ops : [];
    state.mode = null;
    state.lastPoint = null;
    if (ops.length === 0) {
      state.previewOp = null;
      state.holdPreview = false;
      reportError({ code: 'GESTURE_NO_OPS', message: '微移没有产出任何 op（补丁被拒 / 层缺失）' });
      render();
      return false;
    }
    state.commits += 1;
    state.lastOps = ops;
    state.lastOp = ops.length === 1 ? ops[0] : null;
    if (ops.length === 1 && typeof opts.onCommit === 'function') opts.onCommit(ops[0]);
    else if (typeof opts.onCommitMany === 'function') opts.onCommitMany(ops);
    else reportError({ code: 'NO_BATCH_COMMITTER', message: '多选微移需要宿主提供 onCommitMany（一批 op，一步撤销）' });
    /* 保持预览，等宿主 refresh；宿主不调也不会闪回原位 */
    state.holdPreview = true;
    state.nudgeReason = reason;
    render();
    return true;
  }

  /** 丢弃未提交的微移（Esc）。 */
  function cancelNudge() {
    const n = state.nudge;
    if (!n) return false;
    if (n.timer) {
      try {
        win.clearTimeout(n.timer);
      } catch {
        /* 忽略 */
      }
    }
    state.nudge = null;
    state.mode = null;
    state.previewOp = null;
    state.holdPreview = false;
    state.cancels += 1;
    if (typeof opts.onCancel === 'function') opts.onCancel();
    render();
    return true;
  }

  /** @param {any} n */
  function scheduleNudgeCommit(n) {
    const cfg = keyboardConfig();
    if (n.timer) {
      try {
        win.clearTimeout(n.timer);
      } catch {
        /* 忽略 */
      }
    }
    n.timer = win.setTimeout(() => {
      if (state.nudge === n) commitNudge('idle');
    }, cfg.idleMs);
  }

  /** 可选层（Tab 顺序）：跳过隐藏与锁定。 */
  function selectableAts() {
    /** @type {string[]} */
    let order = [];
    if (typeof opts.getLayerOrder === 'function') {
      try {
        const list = opts.getLayerOrder();
        if (Array.isArray(list)) order = list.filter((at) => typeof at === 'string' && at);
      } catch {
        order = [];
      }
    }
    if (order.length === 0) order = readPickables().map((layer) => layer.at);
    /** @type {string[]} */
    const out = [];
    for (const at of order) {
      if (out.includes(at)) continue;
      if (isHidden(at) || isLocked(at)) continue;
      out.push(at);
    }
    return out;
  }

  /**
   * Tab / Shift+Tab：在可选层里循环。
   * @param {1|-1} dir
   */
  function cycleSelection(dir) {
    const order = selectableAts();
    if (order.length === 0) {
      reportError({ code: 'NO_SELECTABLE_LAYER', message: '没有可选层（都被锁定/隐藏，或宿主没给 getLayerRects）' });
      return { ok: false, at: null, order };
    }
    const only = state.layers.length === 1 ? state.layers[0] : null;
    const current = only ? only.at : '';
    const index = current ? order.indexOf(current) : -1;
    const fallbackAt = dir > 0 ? order[0] : order[order.length - 1];
    const nextAt =
      index === -1 ? fallbackAt : order[(index + dir + order.length) % order.length];
    if (!nextAt) return { ok: false, at: null, order };
    const layer = readPickables().find((item) => item.at === nextAt) ?? (state.layers.find((item) => item.at === nextAt) || null);
    if (!layer) {
      /* 顺序表里有、可点表里没有：跳过它继续找（最多一圈） */
      return { ok: false, at: null, order };
    }
    state.layers = [layer];
    state.start = null;
    state.holdPreview = false;
    state.holdSelection = true;
    state.previewOp = null;
    emitSelection();
    render();
    return { ok: true, at: nextAt, order, index: order.indexOf(nextAt) };
  }

  /**
   * 方向键微移：keydown 累积 + 预览；keyup/idle 提交一次。
   * @param {KeyboardEvent} event
   */
  function nudgeKeyDown(event) {
    const vector = /** @type {Record<string, {x:number,y:number}>} */ (ARROW_VECTORS)[event.key];
    if (!vector) return false;
    if (state.mode && state.mode !== 'nudge') return false;
    if (!keyboardOwns(event)) return false;
    if (state.layers.length === 0) return false;

    const locked = state.layers.filter((layer) => isLocked(layer.at));
    if (locked.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      reportError({
        code: 'NUDGE_LOCKED',
        message: `微移被拒绝：${locked.map((layer) => layer.at).join('、')} 已锁定（一个字节都没写）`
      });
      return true;
    }

    /* 真在跑拖动/缩放/旋转时别抢键盘 */
    if (state.start && state.mode && state.mode !== 'nudge') return false;

    const step = nudgeStepOf(event);
    if (!state.nudge) {
      state.nudge = {
        base: state.layers.map((layer) => ({ layer, box: { ...layer.box } })),
        acc: { x: 0, y: 0 },
        unit: step.unit,
        keys: new Set(),
        ops: [],
        timer: null
      };
      state.previewOp = null;
      state.holdPreview = false;
      state.error = null;
      state.lastOps = [];
      state.lastOp = null;
    }
    const n = state.nudge;
    n.acc = { x: round3(n.acc.x + vector.x * step.amount), y: round3(n.acc.y + vector.y * step.amount) };
    n.keys.add(event.key);
    event.preventDefault();
    event.stopPropagation();
    previewNudge(n);
    scheduleNudgeCommit(n);
    return true;
  }

  /** @param {KeyboardEvent} event */
  function nudgeKeyUp(event) {
    const n = state.nudge;
    if (!n) return;
    if (!ARROW_VECTORS[/** @type {keyof typeof ARROW_VECTORS} */ (event.key)]) return;
    n.keys.delete(event.key);
    if (n.keys.size === 0) commitNudge('keyup');
  }

  /** @param {Layer} layer */
  function linearOf(layer) {
    const lin = layer.geometry && layer.geometry.linear ? layer.geometry.linear : null;
    if (!lin) return null;
    const values = [lin.a, lin.b, lin.c, lin.d];
    return values.every((n) => typeof n === 'number' && Number.isFinite(n)) ? lin : null;
  }

  /**
   * 舞台局部矩形。
   *
   * 优先级（S37 起）：
   * 1. **没有祖先线性变换**时用声明的 `box`——这就是用户正在编辑的 `left/top/width/height`。
   *    宿主的 `rect` 可能带显示策略（网页片段的 letterbox 等比居中、竖屏场景装进横框等），
   *    拿它画框会出现「框比画面窄 18px、拖右边却像拖到空气」的错位（R20-C4 的根因之一）。
   * 2. 有祖先变换（场景嵌套）时用实测 `rect`：那时 box 的 px 不是舞台 px。
   * 3. 都没有才按 box + 线性推。
   * @param {Layer} layer
   */
  function stageRectOf(layer) {
    const lin = linearOf(layer);
    const box = layer.box;
    const declared = box && finite(box.w) > 0 && finite(box.h) > 0;
    if (lin === null && declared) {
      return { x: finite(box.x), y: finite(box.y), w: finite(box.w), h: finite(box.h), source: 'declared' };
    }
    if (layer.rect) return { ...layer.rect, source: 'measured' };
    return stageRectOfBox(layer.box, layer);
  }

  /** @param {Box4} box @param {Layer} layer */
  function stageRectOfBox(box, layer) {
    const lin = linearOf(layer);
    if (!lin) return { x: box.x, y: box.y, w: box.w, h: box.h, source: 'linear' };
    const p = applyLinear(lin, box.x, box.y);
    const { sx, sy } = axisScale(lin);
    return { x: p.x, y: p.y, w: box.w * sx, h: box.h * sy, source: 'linear' };
  }

  /** @param {Layer} layer */
  function rotationOf(layer) {
    const g = layer.geometry && Number.isFinite(layer.geometry.rotationDeg) ? Number(layer.geometry.rotationDeg) : 0;
    return (layer.box.r ?? 0) + g;
  }

  /* ── 框与手柄几何 ────────────────────────────────────────────────────── */

  /** 选中层的可见集合（隐藏的不画框、不可拖）。 */
  function visibleSelection() {
    return state.layers.filter((/** @type {Layer} */ layer) => !isHidden(layer.at));
  }

  function computeFrame() {
    const layers = visibleSelection();
    if (layers.length === 0) return null;
    if (layers.length === 1) {
      const layer = /** @type {Layer} */ (layers[0]);
      const local = stageRectOf(layer);
      return {
        x: local.x,
        y: local.y,
        w: local.w,
        h: local.h,
        rotationDeg: round3(rotationOf(layer)),
        multiple: false,
        source: local.source
      };
    }
    /* 多选：各层矩形（未旋转）的并集；旋转层的外接框不参与（约束见文件头） */
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const layer of layers) {
      const r = stageRectOf(layer);
      minX = Math.min(minX, r.x);
      minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.w);
      maxY = Math.max(maxY, r.y + r.h);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY, rotationDeg: 0, multiple: true, source: 'union' };
  }

  /* ── 渲染 ────────────────────────────────────────────────────────────── */

  function render() {
    state.frames += 1;
    state.stage = readStage();
    /* 微移提交后到宿主 refresh 之间保持预览（holdPreview）：这段窗口里不重读选择，否则会闪回原位 */
    if (!state.mode && !state.holdPreview && !state.holdSelection) {
      state.layers = readSelectionSet();
      state.guides = [];
      state.guideDetails = [];
    }
    const stage = state.stage;
    const base = computeFrame();
    const previewBox = state.mode && state.previewOp ? state.previewOp.value : null;

    overlay.setAttribute('data-gesture-active', String(state.mode !== null));
    overlay.setAttribute('data-gesture-mode', state.mode ?? '');
    overlay.setAttribute('data-gesture-count', String(state.layers.length));
    overlay.setAttribute('data-gesture-at', state.layers[0]?.at ?? '');

    if (!stage) {
      overlay.style.width = '0px';
      overlay.style.height = '0px';
      frame.style.display = 'none';
      ring.style.display = 'none';
      hud.style.display = 'none';
      state.frameRect = null;
      state.handleBox = null;
      hideGuides();
      hideGaps();
      restoreHostSizeLabel();
      return;
    }

    overlay.style.left = `${round3(stage.x)}px`;
    overlay.style.top = `${round3(stage.y)}px`;
    overlay.style.width = `${round3(stage.w)}px`;
    overlay.style.height = `${round3(stage.h)}px`;

    if (!base) {
      frame.style.display = 'none';
      ring.style.display = 'none';
      hud.style.display = 'none';
      state.frameRect = null;
      state.handleBox = null;
      hideGuides();
      hideGaps();
      restoreHostSizeLabel();
      renderBand();
      return;
    }

    /* 手势中：单击/框选改变了选择也要按预览值画（多选预览是整个并集移动后的框） */
    let rect = base;
    const movePreview = state.previewOp && (state.mode === 'move' || state.mode === 'nudge' || state.holdPreview);
    if (movePreview) {
      const dxs = finite(state.previewOp.__dxStage ?? 0) || 0;
      const dys = finite(state.previewOp.__dyStage ?? 0) || 0;
      rect = { ...base, x: base.x + dxs, y: base.y + dys };
    } else if (state.mode === 'rotate' && state.previewOp) {
      rect = { ...base, rotationDeg: finite(state.previewOp.__rotation) || 0 };
    } else if (state.mode === 'resize' && state.handleBox && state.previewFrameOverride) {
      rect = { ...base, ...state.previewFrameOverride };
    }

    const screen = {
      x: rect.x * stage.scale,
      y: rect.y * stage.scale,
      w: rect.w * stage.scale,
      h: rect.h * stage.scale,
      rotationDeg: round3(rect.rotationDeg)
    };
    state.frameRect = screen;

    const ringW = Math.max(screen.w, GESTURE_RING_MIN);
    const ringH = Math.max(screen.h, GESTURE_RING_MIN);
    const handleBox = { x: screen.x + (screen.w - ringW) / 2, y: screen.y + (screen.h - ringH) / 2, w: ringW, h: ringH };
    state.handleBox = handleBox;

    frame.style.display = 'block';
    const bodyEvents = opts.stageBodyInput && !base.multiple ? 'none' : 'auto';
    frame.style.pointerEvents = bodyEvents;
    pad.style.pointerEvents = bodyEvents;
    frame.setAttribute('data-frame-space', base.source);
    frame.style.left = `${round3(screen.x)}px`;
    frame.style.top = `${round3(screen.y)}px`;
    frame.style.width = `${round3(screen.w)}px`;
    frame.style.height = `${round3(screen.h)}px`;
    frame.style.transform = screen.rotationDeg ? `rotate(${screen.rotationDeg}deg)` : 'none';

    ring.style.display = 'block';
    ring.style.left = `${round3(handleBox.x)}px`;
    ring.style.top = `${round3(handleBox.y)}px`;
    ring.style.width = `${round3(handleBox.w)}px`;
    ring.style.height = `${round3(handleBox.h)}px`;
    ring.style.transform = screen.rotationDeg ? `rotate(${screen.rotationDeg}deg)` : 'none';
    ring.setAttribute('data-ring-size', `${Math.round(handleBox.w)}x${Math.round(handleBox.h)}`);

    /* 极小目标：框比环小时给一个拖动垫（环大，好抓；框线仍是真实尺寸） */
    const needsPad = screen.w < GESTURE_RING_MIN - 0.5 || screen.h < GESTURE_RING_MIN - 0.5;
    pad.style.display = needsPad ? 'block' : 'none';

    /* 旋转手柄只在单选可见层时出现 */
    rotateHandle.style.display = base.multiple ? 'none' : 'block';

    /* 尺寸标签（S40）：**数字只在变化的时候由手势层显示**。
       - 手势 / 键盘微调进行中：手势层画，跟随指针（键盘没有指针就贴框），并临时接管宿主
         那份只读标签（`suppressHostSizeLabel`）——它是 React state 派生的，拖动期还是旧值。
       - 静止：手势层不画，画面留给宿主那份（权威值，且带自己的说明）。
       取舍理由写在 README「画布上的数字只出现一次」：反过来的两种排法都会让用户同时看到
       两个数字，其中一个必然是错的。 */
    const hudVisible = Boolean(state.mode) || state.holdPreview;
    hud.style.display = hudVisible ? 'block' : 'none';
    if (hudVisible) {
      suppressHostSizeLabel();
      /* 数值取「正在动的那块」：单选是它的 box，多选是**整组外接框**（`rect` 已含预览位移）。
         取 `state.layers[0].box` 会让多选时显示首个片段的数字，用户在拖一整组却只看到一个。 */
      const shown = rect;
      const text =
        state.mode === 'rotate'
          ? `${Math.round(Number(state.previewOp?.__rotation ?? state.layers[0]?.box?.r ?? 0))}°`
          : `${Math.round(shown.x)},${Math.round(shown.y)} · ${Math.round(shown.w)}×${Math.round(shown.h)}`;
      hud.textContent = text;
      const hudW = hud.offsetWidth || 96;
      const hudH = hud.offsetHeight || 20;
      const stageW = stage ? stage.w : 0;
      const stageH = stage ? stage.h : 0;
      /* 跟随指针：`lastPoint` 是 client 坐标，覆盖层的 (0,0) 就是舞台左上角 */
      const pointer =
        state.lastPoint && (state.mode === 'move' || state.mode === 'resize' || state.mode === 'rotate')
          ? { x: state.lastPoint.clientX - stage.x, y: state.lastPoint.clientY - stage.y }
          : null;
      if (pointer) {
        /* 鼠标：右下偏移 14/18；触摸/笔：**右上方 12px** —— 指腹会盖住触点，标签得躲开。
           四边都夹在舞台内（覆盖层 overflow:hidden，越界就被裁掉）。 */
        const touch = isTouchLike();
        const offset = touch ? GESTURE_TOUCH_HUD_OFFSET : 14;
        const rawLeft = pointer.x + offset;
        const rawTop = touch ? pointer.y - hudH - GESTURE_TOUCH_HUD_OFFSET : pointer.y + 18;
        const left = Math.min(Math.max(rawLeft, 4), Math.max(4, stageW - hudW - 4));
        const top = Math.min(Math.max(rawTop, 4), Math.max(4, stageH - hudH - 4));
        hud.style.left = `${round3(left)}px`;
        hud.style.top = `${round3(top)}px`;
        hud.setAttribute('data-hud-anchor', 'pointer');
        hud.setAttribute('data-hud-pointer', touch ? 'touch' : 'mouse');
        hud.setAttribute('data-hud-offset', String(offset));
      } else {
        /* 键盘微调 / 没有指针坐标：贴框下方，放不下就翻到框内顶端 */
        hud.style.left = `${round3(screen.x)}px`;
        const below = round3(Math.max(screen.y + screen.h, handleBox.y + handleBox.h) + 8);
        hud.style.top = `${round3(below + hudH > stageH && screen.y > hudH + 4 ? screen.y + 4 : below)}px`;
        hud.setAttribute('data-hud-anchor', 'frame');
      }
    } else {
      restoreHostSizeLabel();
    }

    renderGuides();
    renderGaps();
    renderHighlight();
    renderBand();
  }

  function hideGuides() {
    guides.x.style.display = 'none';
    guides.y.style.display = 'none';
  }

  function hideGaps() {
    gapLabels.x.style.display = 'none';
    gapLabels.y.style.display = 'none';
    gapLines.x.style.display = 'none';
    gapLines.y.style.display = 'none';
  }

  function renderGuides() {
    const stage = state.stage;
    if (!stage || state.guides.length === 0) {
      hideGuides();
      return;
    }
    for (const g of state.guides) {
      const el = guides[g.axis];
      if (g.axis === 'x') {
        el.style.display = 'block';
        el.style.left = `${round3(g.at * stage.scale)}px`;
      } else {
        el.style.display = 'block';
        el.style.top = `${round3(g.at * stage.scale)}px`;
      }
    }
  }

  /**
   * 间距标签与等距分布（S38 / S42）。坐标：overlay 内部就是舞台屏幕坐标，所以 × scale。
   *
   * 每轴二选一：
   * - 有 run（≥3 段等距）→ 画 `= 24px =` 与整组虚线，**不画**单个净空（否则同一段两个数字）；
   * - 没有 run → 还是 S38 的老样子：`24px` + 一条虚线。
   */
  function renderGaps() {
    const stage = state.stage;
    const frame = state.frameRect;
    const dragging = state.mode === 'move' || state.mode === 'resize';
    const hasAny = state.gaps.length > 0 || state.gapRuns.length > 0;
    if (!stage || !frame || !dragging || !hasAny) {
      for (const axis of /** @type {const} */ (['x', 'y'])) {
        gapLabels[axis].style.display = 'none';
        gapLines[axis].style.display = 'none';
        runLabels[axis].style.display = 'none';
        runWraps[axis].style.display = 'none';
      }
      return;
    }
    for (const axis of /** @type {const} */ (['x', 'y'])) {
      const run = /** @type {any} */ (state.gapRuns.find((item) => item.axis === axis));
      if (run && run.gap > 0 && run.segments.length > 0) {
        gapLabels[axis].style.display = 'none';
        gapLines[axis].style.display = 'none';
        renderGapRun(axis, run, frame);
        continue;
      }
      runLabels[axis].style.display = 'none';
      runWraps[axis].style.display = 'none';

      const near = state.gaps
        .filter((/** @type {any} */ g) => g.axis === axis)
        .sort((/** @type {any} */ a, /** @type {any} */ b) => a.gap - b.gap)[0];
      const label = gapLabels[axis];
      const line = gapLines[axis];
      if (!near || !(near.gap > 0)) {
        label.style.display = 'none';
        line.style.display = 'none';
        continue;
      }
      const a = near.from * stage.scale;
      const b = near.to * stage.scale;
      const lo = Math.min(a, b);
      const span = Math.abs(b - a);
      if (axis === 'x') {
        const y = (frame.y + frame.h / 2) * stage.scale;
        line.style.display = 'block';
        line.style.left = `${round3(lo)}px`;
        line.style.top = `${round3(y)}px`;
        line.style.width = `${round3(span)}px`;
        label.textContent = `${near.gap}px`;
        label.style.display = 'block';
        label.style.left = `${round3(lo + span / 2)}px`;
        label.style.top = `${round3(y)}px`;
      } else {
        const x = (frame.x + frame.w / 2) * stage.scale;
        line.style.display = 'block';
        line.style.left = `${round3(x)}px`;
        line.style.top = `${round3(lo)}px`;
        line.style.height = `${round3(span)}px`;
        label.textContent = `${near.gap}px`;
        label.style.display = 'block';
        label.style.left = `${round3(x)}px`;
        label.style.top = `${round3(lo + span / 2)}px`;
      }
      label.setAttribute('data-gap-kind', 'single');
      label.setAttribute('data-gap-side', near.side);
      label.setAttribute('data-gap-value', String(near.gap));
    }
  }

  /** 等距分布的虚线池（每轴一组，避免每帧 createElement）。 */
  const runLinePool = { x: /** @type {HTMLElement[]} */ ([]), y: /** @type {HTMLElement[]} */ ([]) };

  /**
   * 画一组等距：每段一条虚线，**只在离被拖对象最近的那段**上挂 `= Npx =`。
   * 挂一个而不是每段一个：三段 24px 挨着排，三个药丸会互相压住（S38 的 `24px` 也是每轴一个）。
   *
   * @param {'x'|'y'} axis
   * @param {any} run
   * @param {{x: number, y: number, w: number, h: number}} frame 舞台局部
   */
  function renderGapRun(axis, run, frame) {
    const stage = /** @type {any} */ (state.stage);
    const wrap = runWraps[axis];
    const label = runLabels[axis];
    wrap.style.display = 'block';
    const pool = runLinePool[axis];
    /**
     * 标签挂**第一段**（离被拖对象最近的那段）。
     *
     * 不按「cross 离框中心最近」挑：一排对齐的片段 cross 全都一样，「最近」会退化成「数组里
     * 碰巧第一个」，标签就跑到中间那段去了（S42 实测：`d-a` 的 24px 标签画在了 d-b/d-c 之间）。
     * 链式是**从被拖对象向外**走的，所以第 0 段永远贴着它。
     */
    /** @type {any} */
    let nearest = null;
    run.segments.forEach((/** @type {any} */ seg, /** @type {number} */ index) => {
      let el = pool[index];
      if (!el) {
        el = doc.createElement('div');
        el.setAttribute('data-gap-seg', String(index));
        el.style.cssText = [
          'position:absolute',
          'pointer-events:none',
          `border${axis === 'x' ? '-top' : '-left'}:1px dashed ${guideColor}`,
          axis === 'x' ? 'height:0' : 'width:0'
        ].join(';');
        wrap.appendChild(el);
        pool[index] = el;
      }
      el.style.display = 'block';
      const a = seg.from * stage.scale;
      const b = seg.to * stage.scale;
      const lo = Math.min(a, b);
      const span = Math.abs(b - a);
      const cross = seg.cross * stage.scale;
      if (axis === 'x') {
        el.style.left = `${round3(lo)}px`;
        el.style.top = `${round3(cross)}px`;
        el.style.width = `${round3(span)}px`;
      } else {
        el.style.left = `${round3(cross)}px`;
        el.style.top = `${round3(lo)}px`;
        el.style.height = `${round3(span)}px`;
      }
      if (index === 0) nearest = { seg, lo, span, cross };
    });
    for (let i = run.segments.length; i < pool.length; i += 1) {
      const hidden = pool[i];
      if (hidden) hidden.style.display = 'none';
    }
    if (!nearest) {
      label.style.display = 'none';
      return;
    }
    label.textContent = `= ${run.gap}px =`;
    label.style.display = 'block';
    /*
     * 标签沿**垂直方向**让开 14px（x 轴画在测量线上方、y 轴画在右侧）：
     * 尺寸 HUD 跟着指针、就在框里，两者同高时会叠在一起（S42 截图上 `= 24px =` 被
     * `40,90 · 200×120` 盖住了一半）。让开之后读数线和数字互不遮挡。
     */
    if (axis === 'x') {
      label.style.left = `${round3(nearest.lo + nearest.span / 2)}px`;
      label.style.top = `${round3(nearest.cross - 14)}px`;
    } else {
      label.style.left = `${round3(nearest.cross + 14)}px`;
      label.style.top = `${round3(nearest.lo + nearest.span / 2)}px`;
    }
    label.setAttribute('data-gap-kind', 'run');
    label.setAttribute('data-gap-side', run.side);
    label.setAttribute('data-gap-value', String(run.gap));
    label.setAttribute('data-gap-count', String(run.count));
    label.setAttribute('data-gap-run-kind', run.kind);
  }

  function renderHighlight() {
    const stage = state.stage;
    const at = state.highlightAt;
    if (!stage || !at || isHidden(at)) {
      highlight.style.display = 'none';
      return;
    }
    let rect = null;
    try {
      rect = opts.getHighlightRect ? opts.getHighlightRect(at) : null;
    } catch {
      rect = null;
    }
    if (!rect) {
      highlight.style.display = 'none';
      return;
    }
    const x = finite(rect.x);
    const y = finite(rect.y);
    const rawRect = /** @type {any} */ (rect);
    const w = finite(rawRect.w ?? rawRect.width);
    const h = finite(rawRect.h ?? rawRect.height);
    if (![x, y, w, h].every(Number.isFinite)) {
      highlight.style.display = 'none';
      return;
    }
    highlight.style.display = 'block';
    highlight.style.left = `${round3(x * stage.scale)}px`;
    highlight.style.top = `${round3(y * stage.scale)}px`;
    highlight.style.width = `${round3(w * stage.scale)}px`;
    highlight.style.height = `${round3(h * stage.scale)}px`;
  }

  function renderBand() {
    const stage = state.stage;
    const r = state.bandRect;
    if (!stage || !r) {
      band.style.display = 'none';
      return;
    }
    band.style.display = 'block';
    band.style.left = `${round3(r.x - stage.x)}px`;
    band.style.top = `${round3(r.y - stage.y)}px`;
    band.style.width = `${round3(r.w)}px`;
    band.style.height = `${round3(r.h)}px`;
  }

  /* ── 手势 ────────────────────────────────────────────────────────────── */

  /**
   * 统一报错口：**任何**「有手势但没提交」的路径都必须走这里，不许静默。
   * 宿主给了 `onError` 就回调；没给也要写 `state.error` 并 `console.warn` 一次带码。
   * @param {{code: string, message: string}} info
   */
  function reportError(info) {
    const duplicate = state.error && state.error.code === info.code;
    state.error = info;
    if (duplicate) return;
    if (typeof opts.onError === 'function') {
      opts.onError(info);
      return;
    }
    if (state.fallbackWarned !== info.code) {
      state.fallbackWarned = info.code;
      if (typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn(`[canvas-gesture] ${info.code}: ${info.message}`);
      }
    }
  }

  /**
   * 把指针捕获到**真正被按下的元素**上。overlay 是 `pointer-events:none`，
   * 在它上面捕获拿不到事件；手柄/框体是 `pointer-events:auto`，捕获才有效。
   * 另外把 overlay 临时改成吃事件（拖拽盾），舞台若是 iframe 也不会漏进子文档。
   * @param {PointerEvent} event
   */
  function beginPointerCapture(event) {
    const pointerId = typeof event.pointerId === 'number' ? event.pointerId : null;
    const target = /** @type {any} */ (event.target);
    if (pointerId !== null && target && typeof target.setPointerCapture === 'function') {
      try {
        target.setPointerCapture(pointerId);
        state.capture = { el: target, pointerId };
      } catch {
        state.capture = null;
      }
    }
    /* 拖拽盾：手势期间覆盖层吃事件（pointerup 就不会被舞台 iframe 抢走） */
    overlay.style.pointerEvents = 'auto';
  }

  function releasePointerCapture() {
    const capture = state.capture;
    state.capture = null;
    if (capture) {
      try {
        capture.el.releasePointerCapture(capture.pointerId);
      } catch {
        /* 已经释放/元素没了：忽略 */
      }
    }
    overlay.style.pointerEvents = 'none';
  }

  /**
   * 这次手势算不算「动过」。
   *
   * - **鼠标**：曼哈顿位移 > `GESTURE_CLICK_SLOP`(0.5px) 就算动过（S17 的老口径，逐值不变）；
   *   旋转另按角度 `GESTURE_ROTATE_SLOP_DEG` 判（短弧也算动过）。
   * - **触摸/笔**：先看**欧氏距离** ≤ `GESTURE_TAP_MAX_MOVE`(8px) —— 在 8px 里怎么抖都不算动过，
   *   松手就是一次点选（0 op）。超过 8px 才进入拖拽；一旦进入，后面的增量按**按下点**算
   *   （不扣掉这 8px），所以落点与手指移动量一致，不会「少走一截」。
   *
   * 旋转在触摸下也先过 8px 这道门：手指按在旋转手柄上时的抖动不该让角度乱跳。
   * @param {number} clientX @param {number} clientY
   */
  function movedFor(clientX, clientY) {
    if (state.moved) return true;
    const start = state.start;
    if (!start) return false;
    const dx = clientX - start.clientX;
    const dy = clientY - start.clientY;
    if (isTouchLike()) {
      return Math.hypot(dx, dy) > GESTURE_TAP_MAX_MOVE;
    }
    if (Math.abs(dx) + Math.abs(dy) > GESTURE_CLICK_SLOP) return true;
    const rs = start.rotateStart;
    if (state.mode === 'rotate' && rs && rs.startPoint) {
      const deg = rotationDeltaOf(rs.center, rs.startPoint, { x: clientX, y: clientY });
      return Math.abs(deg) > GESTURE_ROTATE_SLOP_DEG;
    }
    return false;
  }

  /** @param {PointerEvent} event */
  function onPointerDown(event) {
    if (event.button !== 0) return;
    /* 多指：第二根手指不接管已有手势（否则两根手指会互相把对方的 start 覆盖掉） */
    if (state.start && state.pointerId !== null && typeof event.pointerId === 'number' && event.pointerId !== state.pointerId) {
      return;
    }
    /* 指针来源：touch/pen 走同一套状态机，只有手感参数（阈值/热区/HUD 偏移）按类型分叉。
       空串（合成事件/老浏览器）按鼠标处理，保持既有行为。 */
    state.pointerType =
      typeof event.pointerType === 'string' && event.pointerType !== '' ? event.pointerType : 'mouse';
    state.pointerId = typeof event.pointerId === 'number' ? event.pointerId : null;
    /* 真来了触摸/笔就打开粗指针热区：媒体查询可能因为外接鼠标报 fine，但手指已经按下来了 */
    if (state.pointerType !== 'mouse' && !pointerMode.coarse) {
      pointerMode.coarse = true;
      applyPointerMode();
    }
    const target = /** @type {any} */ (event.target);
    /* 侧栏/面板（S27 的动效面板）显式声明「别当舞台」：否则在面板里点输入框会被当成
       舞台空白处的按下，起橡皮筋候选并抢指针捕获。这是**加法**：没有元素带这个属性时行为不变。 */
    if (target && typeof target.closest === 'function' && target.closest('[data-no-stage-gesture]')) return;
    state.holdPreview = false;
    const inOverlay = !!(target && typeof target.closest === 'function' && target.closest('[data-canvas-gesture]'));
    const handle = (target && typeof target.getAttribute === 'function' ? target.getAttribute('data-handle') : '') || '';
    const onBody = !!(target && typeof target.getAttribute === 'function' && target.getAttribute('data-gesture-part') === 'body');

    if (inOverlay && (handle || onBody)) {
      if (!state.stage) return;
      if (state.layers.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (onBody && !handle && event.shiftKey) {
        const hit = pickAt(event.clientX, event.clientY);
        if (hit) toggleAt(hit.at, hit);
        return;
      }
      if (handle === 'rotate' && state.layers.length > 1) return;
      startGesture(handle === 'rotate' ? 'rotate' : handle ? 'resize' : 'move', handle, event);
      return;
    }

    const stage = state.stage;
    if (inOverlay || !stage) return;
    // The listener is document-wide so handles can extend past the canvas.
    // A regular press must begin inside the canvas before it can start a selection.
    if (event.clientX < stage.x || event.clientX >= stage.x + stage.w ||
        event.clientY < stage.y || event.clientY >= stage.y + stage.h) return;
    if (typeof opts.getLayerRects !== 'function') return;

    const hit = pickAt(event.clientX, event.clientY);
    if (hit) {
      event.preventDefault();
      /* 按在**尚未选中**的层上：选中在按下这一瞬就完成，不进入手势（没有 start，也就没有 op）。
         账本记成 `select` 而不是 `tap`：它确实是一次点选，但没走手势状态机，
         用手指还是笔按都一样（A1 的判据就是「选中 + 0 op」）。 */
      state.lastGesture = {
        pointerType: state.pointerType,
        kind: 'select',
        mode: null,
        moved: false,
        durationMs: 0,
        distancePx: 0,
        at: hit.at,
        ops: 0,
        multi: Boolean(event.shiftKey)
      };
      state.cancelReason = '';
      /* 命中的层对象直接复用：一次按下只读一遍宿主（200 层时就是少一次全量 rect 扫描） */
      if (event.shiftKey) toggleAt(hit.at, hit);
      else selectOnly(hit.at, hit);
      return;
    }
    /* 空白：橡皮筋候选（不 preventDefault，普通点击仍穿透到舞台） */
    state.gestureStartedAt = nowMs();
    state.start = { clientX: event.clientX, clientY: event.clientY, bandMode: true, startedAt: state.gestureStartedAt };
    state.lastPoint = { clientX: event.clientX, clientY: event.clientY };
    state.mode = null;
    beginPointerCapture(event);
    attachDragListeners();
  }

  /**
   * 舞台局部命中最上层的可见层。
   * @param {number} clientX @param {number} clientY
   */
  function pickAt(clientX, clientY) {
    const stage = state.stage;
    if (!stage) return null;
    const x = (clientX - stage.x) / stage.scale;
    const y = (clientY - stage.y) / stage.scale;
    const list = readPickables().filter((layer) => !isHidden(layer.at));
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const layer = /** @type {Layer} */ (list[i]);
      const r = /** @type {Rect4} */ (layer.rect);
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return layer;
    }
    return null;
  }

  /** @param {string} at @param {Layer} [known] 已经拿到的层对象（省掉第二次全量读宿主） */
  function selectOnly(at, known) {
    const layer = known ?? readPickables().find((item) => item.at === at);
    if (!layer) return;
    state.layers = [layer];
    state.start = null;
    state.holdSelection = true;
    emitSelection();
    render();
  }

  /** @param {string} at @param {Layer} [known] */
  function toggleAt(at, known) {
    const has = state.layers.some((layer) => layer.at === at);
    if (has) {
      state.layers = state.layers.filter((layer) => layer.at !== at);
    } else {
      const layer = known ?? readPickables().find((item) => item.at === at);
      if (layer) state.layers = [...state.layers, layer];
    }
    state.start = null;
    state.holdSelection = true;
    emitSelection();
    render();
  }

  function emitSelection() {
    if (typeof opts.onSelectionChange === 'function') opts.onSelectionChange(state.layers.map((layer) => layer.at));
  }

  /**
   * @param {'move'|'resize'|'rotate'} mode
   * @param {string} handle
   * @param {PointerEvent} event
   */
  function startGesture(mode, handle, event, fromStage = false) {
    const base = computeFrame();
    if (!base) return;
    state.gestureStartedAt = nowMs();
    state.cancelReason = '';
    state.mode = mode;
    state.handle = handle;
    state.moved = false;
    state.shift = event.shiftKey === true;
    state.previewOp = null;
    state.lastOp = null;
    state.lastOps = [];
    state.error = null;
    state.lastResizeDrift = null;
    state.previewFrameOverride = null;
    state.clampAxis = '';
    state.clampReported = false;
    state.altKey = event.altKey === true;
    state.gaps = [];
    state.gapRuns = [];
    state.gapSnapped = null;
    /* 吸附目标：每个手势算一次（声明框优先），拖动期不再回宿主拉 500 层 */
    refreshTargets();
    /* 手势开始时的间距（ED-079）：拖动期用「保持这个间距」做间距吸附 */
    const startGaps = (() => {
      try {
        return measureGaps({
          rect: { x: base.x, y: base.y, w: base.w, h: base.h },
          targets: /** @type {any} */ (snapTargets(new Set(state.layers.map((/** @type {any} */ layer) => layer.at))))
        });
      } catch {
        return [];
      }
    })();
    state.gaps = [];
    state.gapSnapped = null;
    state.start = {
      clientX: event.clientX,
      clientY: event.clientY,
      startedAt: state.gestureStartedAt,
      gaps: startGaps,
      fromStage,
      frame: { x: base.x, y: base.y, w: base.w, h: base.h, rotationDeg: base.rotationDeg, multiple: base.multiple },
      layers: state.layers.map((layer) => ({ layer, box: { ...layer.box } })),
      stageScale: state.stage ? state.stage.scale : 1,
      rotateStart: mode === 'rotate' ? { r: state.layers[0]?.box?.r ?? 0, center: { x: 0, y: 0 }, startPoint: { x: event.clientX, y: event.clientY } } : null
    };
    state.lastPoint = { clientX: event.clientX, clientY: event.clientY };
    if (mode === 'rotate' && state.stage) {
      const stage = state.stage;
      const center = {
        x: stage.x + (base.x + base.w / 2) * stage.scale,
        y: stage.y + (base.y + base.h / 2) * stage.scale
      };
      state.start.rotateStart.center = center;
      state.start.rotateStart.angle0 = Math.atan2(event.clientY - center.y, event.clientX - center.x);
    }
    overlay.style.cursor = mode === 'rotate' ? 'grabbing' : handle ? HANDLE_CURSOR[/** @type {keyof typeof HANDLE_CURSOR} */ (handle)] : 'move';
    if (!fromStage) {
      beginPointerCapture(event);
      attachDragListeners();
    }
    render();
  }

  function attachDragListeners() {
    doc.addEventListener('pointermove', onPointerMove, true);
    doc.addEventListener('pointerup', onPointerUp, true);
    doc.addEventListener('pointercancel', onPointerCancel, true);
    doc.addEventListener('lostpointercapture', onLostPointerCapture, true);
    doc.addEventListener('keydown', onKeyDown, true);
    doc.addEventListener('contextmenu', onContextMenu, true);
  }

  function removeDragListeners() {
    doc.removeEventListener('pointermove', onPointerMove, true);
    doc.removeEventListener('pointerup', onPointerUp, true);
    doc.removeEventListener('pointercancel', onPointerCancel, true);
    doc.removeEventListener('lostpointercapture', onLostPointerCapture, true);
    doc.removeEventListener('keydown', onKeyDown, true);
    doc.removeEventListener('contextmenu', onContextMenu, true);
  }

  /**
   * 舞台局部吸附目标（排除选中层自己）。
   *
   * **以声明框为准**（S40）：方言里 `box` 才是真相，画面矩形只是 letterbox/画幅适配的产物。
   * 拿画面矩形当目标，同一个框在不同画幅下会吸到不同位置——竖屏场景 300×480 的画面只有
   * 270 宽（左右各让出 15px），于是框的右缘永远吸不到邻居的框缘（R19 交接里那条 +8.5px）。
   * 框本身画在声明 box 上（S37），目标也必须是声明 box，否则「框贴框」永远差那 15px。
   *
   * 声明框从 `getLayerRects()` 一次性取（宿主给的 `{at, clip, box, rect}`），**每个手势算一次**：
   * 拖动期别的片段 box 不会变，每次 pointermove 再拉 500 层纯属白烧预算。
   * 宿主只在 `getSnapTargets()` 里带 `box` 时也认；都没有才退回画面矩形。
   *
   * @param {Set<string>} excludeAts
   */
  function snapTargets(excludeAts) {
    const cached = state.targets;
    if (cached !== null) {
      return cached.filter((item) => !excludeAts.has(/** @type {any} */ (item).at));
    }
    return liveTargets().filter((item) => !excludeAts.has(/** @type {any} */ (item).at));
  }

  /** 未缓存的原始目标（只在没有手势上下文时用，例如 `render()` 之外的探针）。 */
  function liveTargets() {
    if (typeof opts.getSnapTargets !== 'function') return [];
    try {
      const list = opts.getSnapTargets();
      return Array.isArray(list) ? list.filter((item) => item && typeof item === 'object') : [];
    } catch {
      return [];
    }
  }

  /**
   * 手势开始时把「at → 声明框（舞台局部）」算一遍，并拼出本手势的目标列表。
   * 声明框优先，拿不到退回宿主给的画面矩形——两条都记 `rectSource`，验收脚本据此判口径。
   */
  function refreshTargets() {
    /** @type {Map<string, {x:number,y:number,w:number,h:number}>} */
    const declared = new Map();
    if (typeof opts.getLayerRects === 'function') {
      try {
        const list = opts.getLayerRects();
        if (Array.isArray(list)) {
          for (const item of list) {
            const box = item && /** @type {any} */ (item).box;
            if (!box) continue;
            const x = finite(box.x);
            const y = finite(box.y);
            const w = finite(box.w);
            const h = finite(box.h);
            if (!(w > 0) || !(h > 0)) continue;
            declared.set(String(/** @type {any} */ (item).at), { x, y, w, h });
          }
        }
      } catch {
        /* 拿不到就全退回画面矩形，不抛 */
      }
    }
    /** @type {any[]} */
    const out = [];
    for (const item of liveTargets()) {
      const own = /** @type {any} */ (item).box;
      const box = declared.get(String(/** @type {any} */ (item).at)) ?? (own ? { x: finite(own.x), y: finite(own.y), w: finite(own.w), h: finite(own.h) } : null);
      if (box && box.w > 0 && box.h > 0) {
        out.push({ ...item, x: box.x, y: box.y, w: box.w, h: box.h, rectSource: 'declared' });
      } else {
        out.push({ ...item, rectSource: 'picture' });
      }
    }
    state.targets = out;
  }

  /**
   * 计算当前指针下的操作。单选返回一条 op，多选返回一组。
   * @param {number} clientX @param {number} clientY
   */
  function buildOps(clientX, clientY) {
    const start = state.start;
    const stage = state.stage;
    if (!start || !stage) return { ops: [], previews: [], guides: [], deltaStage: { x: 0, y: 0 } };
    const dxScreen = clientX - start.clientX;
    const dyScreen = clientY - start.clientY;
    const exclude = new Set(start.layers.map((/** @type {any} */ item) => item.layer.at));

    if (state.mode === 'move') {
      let deltaStage = { x: dxScreen / stage.scale, y: dyScreen / stage.scale };
      const targets = /** @type {any} */ (snapTargets(exclude));
      const threshold = GESTURE_SNAP_PX / stage.scale;
      const snapEnabled = state.altKey !== true;
      /* 吸附：整组外接框的边/中线贴舞台与其它层（阈值 6 屏幕 px = 6 逻辑 px） */
      const movedFrame = {
        x: start.frame.x + deltaStage.x,
        y: start.frame.y + deltaStage.y,
        w: start.frame.w,
        h: start.frame.h
      };
      const snap = snapRect({
        rect: movedFrame,
        targets,
        stage: opts.stageSize ?? null,
        threshold,
        grid: typeof opts.grid === 'number' && Number.isFinite(opts.grid) ? opts.grid : null,
        enabled: snapEnabled
      });
      deltaStage = { x: deltaStage.x + snap.dx, y: deltaStage.y + snap.dy };
      state.guides = snap.guides;
      state.guideDetails = snap.guideDetails;

      /* 间距吸附（ED-079）：手势开始时量到的「这一侧的净空」在 6px 内就吸回去，
         让标签读数停在 24px 这种整值上，而不是 18/29 的抖动。边吸附优先，只在同轴没吸住时补。 */
      if (snapEnabled && start.gaps && start.gaps.length > 0) {
        const gapSnap = snapGap({
          rect: { x: start.frame.x + deltaStage.x, y: start.frame.y + deltaStage.y, w: start.frame.w, h: start.frame.h },
          pairs: start.gaps.map((/** @type {any} */ g) => ({ axis: g.axis, side: g.side, gap: g.gap })),
          targets,
          stage: opts.stageSize ?? null,
          threshold,
          enabled: snapEnabled
        });
        if (gapSnap.snapped) {
          if (gapSnap.snapped.axis === 'x' && !snap.snappedX) deltaStage.x += gapSnap.dx;
          if (gapSnap.snapped.axis === 'y' && !snap.snappedY) deltaStage.y += gapSnap.dy;
          state.gapSnapped = gapSnap.snapped;
        } else {
          state.gapSnapped = null;
        }
      }

      /* 间距标签：拖动期**只在这里**算（松手即清空，不留幽灵线） */
      const gapFrame = {
        x: start.frame.x + deltaStage.x,
        y: start.frame.y + deltaStage.y,
        w: start.frame.w,
        h: start.frame.h
      };
      if (snapEnabled) {
        state.gaps = measureGaps({ rect: gapFrame, targets });
        /* 等距分布（S42）：同一份 rect/targets，只是要求「≥3 段相等」而不是「最近的一条」 */
        state.gapRuns = measureGapRuns({ rect: gapFrame, targets });
      } else {
        state.gaps = [];
        state.gapRuns = [];
      }

      /* 至少 minVisible 留在舞台里（A4）。只对「box 空间 == 舞台空间」的目标做：
         有祖先变换的层，声明 px 与舞台 px 不是一个尺度，夹了会是错的。 */
      const identity = start.layers.every((/** @type {any} */ item) => linearOf(item.layer) === null);
      if (identity && opts.stageSize) {
        let clamped = null;
        if (start.layers.length === 1) {
          const only = /** @type {any} */ (start.layers[0]);
          const raw = { x: only.box.x + deltaStage.x, y: only.box.y + deltaStage.y, w: only.box.w, h: only.box.h };
          const result = clampVisible(raw, opts.stageSize, minVisible);
          if (result.clampedX || result.clampedY) {
            deltaStage = { x: result.box.x - only.box.x, y: result.box.y - only.box.y };
            clamped = result;
          }
        } else {
          const union = { x: start.frame.x, y: start.frame.y, w: start.frame.w, h: start.frame.h };
          const result = clampGroupDelta(union, deltaStage, opts.stageSize, minVisible);
          if (result.clampedX || result.clampedY) {
            deltaStage = { x: result.dx, y: result.dy };
            clamped = result;
          }
        }
        if (clamped) {
          /* 被夹住就没有「吸附命中」可言：留着参考线会指向一个到不了的位置 */
          state.guides = [];
          state.guideDetails = [];
          state.clampAxis = clamped.clampedX && clamped.clampedY ? 'xy' : clamped.clampedX ? 'x' : 'y';
          if (!state.clampReported) {
            state.clampReported = true;
            reportError({
              code: 'FRAME_CLAMPED',
              message:
                clamped.clampedX && clamped.clampedY
                  ? `已贴住画布边界：片段至少要留 ${minVisible}×${minVisible}px 可见`
                  : `已贴住画布${clamped.clampedX ? '左右' : '上下'}边界：片段至少要留 ${minVisible}px 可见`
            });
          }
        } else {
          state.clampAxis = '';
        }
      }

      /** @type {any[]} */
      const ops = [];
      /** @type {any[]} */
      const previews = [];
      for (const item of start.layers) {
        const layer = /** @type {Layer} */ (item.layer);
        const lin = linearOf(layer);
        const inv = lin ? invertLinear(lin) : null;
        const d = inv ? applyLinear(inv, deltaStage.x, deltaStage.y) : deltaStage;
        /** @type {Box4} */
        const next = {
          x: round3(item.box.x + d.x),
          y: round3(item.box.y + d.y),
          w: item.box.w,
          h: item.box.h
        };
        if (typeof item.box.r === 'number' && item.box.r !== 0) next.r = item.box.r;
        const built = patchForBoxValue(next);
        if ('error' in built) continue;
        ops.push(withClip(built.op, layer));
        previews.push({ ...built.op, __dxStage: deltaStage.x, __dyStage: deltaStage.y });
      }
      return { ops, previews, guides: snap.guides, deltaStage };
    }

    if (state.mode === 'rotate') {
      const layer = start.layers[0]?.layer;
      if (!layer) return { ops: [], previews: [], guides: [], deltaStage: { x: 0, y: 0 } };
      const rs = start.rotateStart;
      const angle1 = Math.atan2(clientY - rs.center.y, clientX - rs.center.x);
      let deg = ((angle1 - rs.angle0) * 180) / Math.PI;
      const raw = (rs.r ?? 0) + deg;
      const stepped = snapDegrees(raw, state.shift ? GESTURE_ROTATE_STEP_SHIFT : GESTURE_ROTATE_STEP);
      const box = { ...start.layers[0].box };
      if (stepped === 0) delete box.r;
      else box.r = stepped;
      const built = patchForBoxValue(box);
      if ('error' in built) return { ops: [], previews: [], guides: [], deltaStage: { x: 0, y: 0 } };
      const op = withClip(built.op, layer);
      return { ops: [op], previews: [{ ...op, __rotation: stepped }], guides: [], deltaStage: { x: 0, y: 0 } };
    }

    /* resize */
    state.gaps = [];
    state.gapSnapped = null;
    const handleName = state.handle;
    const multi = start.layers.length > 1;
    const frame = start.frame;
    /** @type {any[]} */
    const ops = [];
    /** @type {any[]} */
    const previews = [];

    if (!multi) {
      const item = start.layers[0];
      const layer = /** @type {Layer} */ (item.layer);
      const lin = linearOf(layer);
      const r0 = item.box.r ?? 0;
      const d = screenDeltaToDeclared({ dx: dxScreen, dy: dyScreen, stageScale: stage.scale, linear: lin, rotationDeg: r0, unrotate: true });
      const next = dragBox({
        mode: 'resize',
        handle: handleName,
        box: item.box,
        dx: d.x,
        dy: d.y,
        shift: state.shift,
        minSize: minSizeFor(layer),
        stageSize: opts.stageSize ?? null,
        rotationDeg: r0
      });

      /**
       * 缩放吸附（S38 / S42）：只吸**正在动的那条边**，锚定边一根线都不碰。
       *
       * - `r=0`：`snapEdges` 直接给局部增量（S38 的老路径，结果逐值回放）；
       * - `r≠0`：`snapEdgesRotated` 吸 **AABB**，再把补偿量按 `cosθ` 投影回局部轴
       *   （推导与数值导数都在 snap.mjs；锚点由下面重新跑 `dragBox` 保证不动）。
       *
       * 三种情况不吸：有祖先变换（`lin≠null`，box 空间与舞台空间不是一个尺度）、
       * Alt 按住、Shift+角手柄（等比是硬约束，吸一下就把比例破坏了）。
       */
      let snapped = next;
      /** @type {{axis: 'x'|'y', at: number}[]} */
      let guides = [];
      /** @type {{axis: 'x'|'y', at: number, kind: string, source: string, delta: number}[]} */
      let guideDetails = [];
      const keepRatio = state.shift === true && handleName.length === 2;
      if (lin === null && state.altKey !== true && !keepRatio) {
        const rotated = snapEdgesRotated({
          box: { x: next.x, y: next.y, w: next.w, h: next.h },
          handle: handleName,
          rotationDeg: r0,
          targets: /** @type {any} */ (snapTargets(exclude)),
          stage: opts.stageSize ?? null,
          threshold: GESTURE_SNAP_PX / stage.scale,
          grid: typeof opts.grid === 'number' && Number.isFinite(opts.grid) ? opts.grid : null
        });
        guides = rotated.guides;
        guideDetails = rotated.guideDetails;
        if (rotated.dw !== 0 || rotated.dh !== 0) {
          /* 用「指针位移 + 补偿」重跑一次 dragBox：锚点由它反解，所以在构造上不动 */
          const pulled = dragBox({
            mode: 'resize',
            handle: handleName,
            box: item.box,
            dx: d.x + rotated.dw,
            dy: d.y + rotated.dh,
            shift: false,
            minSize: minSizeFor(layer),
            stageSize: opts.stageSize ?? null,
            rotationDeg: r0
          });
          /*
           * 到位校验：最小尺寸 / 舞台上限会把它夹回来。夹住了就别留参考线——
           * 画着线却没吸到目标，就是在骗用户（S40 定的规矩）。
           */
          const gotAabb = aabbOfBox(pulled, r0);
          const wantAabb = rotated.snappedAabb;
          const off = Math.max(
            Math.abs(gotAabb.x - wantAabb.x),
            Math.abs(gotAabb.y - wantAabb.y),
            Math.abs(gotAabb.x + gotAabb.w - (wantAabb.x + wantAabb.w)),
            Math.abs(gotAabb.y + gotAabb.h - (wantAabb.y + wantAabb.h))
          );
          if (off <= 0.6) snapped = pulled;
          else {
            guides = [];
            guideDetails = [];
          }
        }
      }
      state.guides = guides;
      state.guideDetails = guideDetails;
      /* A7：量化锚点漂移（声明空间；r≠0 时才可能非 0） */
      if (r0 !== 0) {
        const a0 = anchorPointOf(item.box, handleName, r0);
        const a1 = anchorPointOf(snapped, handleName, r0);
        state.lastResizeDrift = round3(Math.hypot(a1.x - a0.x, a1.y - a0.y));
      } else {
        state.lastResizeDrift = 0;
      }
      /** @type {Box4} */
      const value = { x: snapped.x, y: snapped.y, w: snapped.w, h: snapped.h };
      if (typeof item.box.r === 'number' && item.box.r !== 0) value.r = item.box.r;
      const built = patchForBoxValue(value);
      if (!('error' in built)) {
        ops.push(withClip(built.op, layer));
        previews.push(built.op);
        const nr = stageRectOfBox(snapped, layer);
        state.previewFrameOverride = { x: nr.x, y: nr.y, w: nr.w, h: nr.h };
      }
      return { ops, previews, guides: [], deltaStage: { x: 0, y: 0 } };
    }

    /* 多选缩放：只做等比；要求每层都没有祖先变换（否则拒绝，只允许移动） */
    const allIdentity = start.layers.every((/** @type {any} */ item) => linearOf(item.layer) === null);
    if (!allIdentity) {
      reportError({ code: 'MULTI_RESIZE_UNSUPPORTED', message: '多选里有带祖先变换的层：本批只支持等比缩放（需要各层无祖先变换）' });
      return { ops: [], previews: [], guides: [], deltaStage: { x: 0, y: 0 } };
    }
    const signX = handleName.includes('e') ? 1 : handleName.includes('w') ? -1 : 0;
    const signY = handleName.includes('s') ? 1 : handleName.includes('n') ? -1 : 0;
    const dStage = { x: dxScreen / stage.scale, y: dyScreen / stage.scale };
    const factorX = frame.w > 0 && signX !== 0 ? (frame.w + signX * dStage.x) / frame.w : 1;
    const factorY = frame.h > 0 && signY !== 0 ? (frame.h + signY * dStage.y) / frame.h : 1;
    const factor = Math.max(0.05, Math.max(factorX, factorY));
    const anchorX = signX > 0 ? frame.x : signX < 0 ? frame.x + frame.w : frame.x + frame.w / 2;
    const anchorY = signY > 0 ? frame.y : signY < 0 ? frame.y + frame.h : frame.y + frame.h / 2;
    for (const item of start.layers) {
      const layer = /** @type {Layer} */ (item.layer);
      const rect = stageRectOfBox(item.box, layer);
      const nx = anchorX + (rect.x - anchorX) * factor;
      const ny = anchorY + (rect.y - anchorY) * factor;
      const nw = Math.max(minSizeFor(layer), rect.w * factor);
      const nh = Math.max(minSizeFor(layer), rect.h * factor);
      /** @type {Box4} */
      const value = { x: round3(nx), y: round3(ny), w: round3(nw), h: round3(nh) };
      if (typeof item.box.r === 'number' && item.box.r !== 0) value.r = item.box.r;
      const built = patchForBoxValue(value);
      if ('error' in built) continue;
      ops.push(withClip(built.op, layer));
      previews.push(built.op);
    }
    return { ops, previews, guides: [], deltaStage: { x: 0, y: 0 } };
  }

  /** @param {any} op @param {Layer} layer */
  function withClip(op, layer) {
    if (!layer.clip) return op;
    return { ...op, clip: layer.clip };
  }

  /** @param {PointerEvent} event */
  function onPointerMove(event) {
    if (!state.start) return;
    if (state.pointerId !== null && typeof event.pointerId === 'number' && event.pointerId !== state.pointerId) return;
    const start = state.start;
    state.lastPoint = { clientX: event.clientX, clientY: event.clientY };
    if (!state.moved) state.moved = movedFor(event.clientX, event.clientY);

    /* 橡皮筋：位移过阈值才开始画 */
    if (start.bandMode) {
      if (!state.moved) return;
      state.mode = 'band';
      const stage = state.stage;
      if (!stage) return;
      const x0 = Math.min(Math.max(start.clientX, stage.x), stage.x + stage.w);
      const y0 = Math.min(Math.max(start.clientY, stage.y), stage.y + stage.h);
      const x1 = Math.min(Math.max(event.clientX, stage.x), stage.x + stage.w);
      const y1 = Math.min(Math.max(event.clientY, stage.y), stage.y + stage.h);
      state.bandRect = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
      render();
      return;
    }

    if (!state.mode) return;
    if (!state.moved) return;
    state.shift = event.shiftKey === true;
    /* Alt 临时关闭吸附（S38）：按住/松开都要立刻生效，不能等下一次按下 */
    state.altKey = event.altKey === true;
    const built = buildOps(event.clientX, event.clientY);
    if (built.previews.length === 0) return;
    state.previewOp = built.previews[0];
    state.previews += 1;
    render();
    for (const op of built.previews) {
      if (typeof opts.onPreview === 'function') opts.onPreview(op);
    }
  }

  /**
   * S97 探针开关：`__s97IgnoreClickThrough === true` 时**整段穿透分支不执行**，
   * 松手回到老路（有位移就提交）。只服务一件事——证明 S97-S1 的绿确实来自这条分支。
   * 产品默认不设这个键；用 kill switch 而不是注掉源码重构建，理由同 S93/S95。
   */
  function clickThroughIgnored() {
    return /** @type {{__s97IgnoreClickThrough?: boolean}} */ (globalThis).__s97IgnoreClickThrough === true;
  }

  /** @param {PointerEvent} event */
  function onPointerUp(event) {
    if (state.pointerId !== null && typeof event.pointerId === 'number' && event.pointerId !== state.pointerId) return;
    finishGesture(event);
  }

  /**
   * 捕获被系统收回（元素被移除 / 触摸取消 / 跨文档异常）：按最后已知位置收尾。
   * 不这么做的话，手势会永久停在 mode 里，下一次 pointerdown 才能解脱。
   * @param {PointerEvent} event
   */
  function onLostPointerCapture(event) {
    if (!state.start || (!state.mode && !state.start.bandMode)) return;
    if (!state.capture || event.pointerId !== state.capture.pointerId) return;
    state.capture = null;
    /* 丢失捕获即取消框选和触摸/笔手势；鼠标拖动与缩放仍按最后位置收尾。 */
    if (state.start.bandMode || isTouchLike()) {
      endGesture('cancel', [], false);
      return;
    }
    const point = state.lastPoint ?? { clientX: state.start.clientX, clientY: state.start.clientY };
    finishGesture({ clientX: point.clientX, clientY: point.clientY, shiftKey: false });
  }

  /** @param {{clientX: number, clientY: number, shiftKey?: boolean}} event */
  function finishGesture(event) {
    const start = state.start;
    if (!start) return;
    /* 注意：这里**不能**先清 `altKey`——提交要用「用户最后看到的那一帧」的 ops
       （`buildOps` 会读 `state.altKey`）。Alt 拖完松手如果再跑一遍吸附，
       落盘值会和屏幕上不一致（B3 实测：屏幕上 106、落盘 100）。
       间距读数在下面 buildOps 之后再清（渲染用，提交不用）。 */

    /* ── 点击穿透（S97）───────────────────────────────────────────────────
       片段框（`data-gesture-frame`）盖在舞台上：clip 模式下点在片段内部，事件永远到不了场景页。
       这里判「按下 → 不移动 → 松手」：位移 < `GESTURE_CLICK_THROUGH_SLOP_PX` 且时长
       < `GESTURE_CLICK_THROUGH_MS` 才算一次点击，转给宿主（它再交给场景页的 pick）。
       命中手柄（`state.handle !== ''`）不算：缩放手柄上的轻点不是「点片段里的层」。
       否则原样走下面的拖动路径 —— 旧行为一个字节不改。 */
    if (
      !start.bandMode &&
      !start.fromStage &&
      state.mode === 'move' &&
      state.handle === '' &&
      state.layers.length === 1 &&
      !clickThroughIgnored() &&
      typeof opts.onClickThrough === 'function'
    ) {
      const distancePx = Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY);
      const durationMs = Math.max(0, Math.round(nowMs() - Number(start.startedAt ?? state.gestureStartedAt ?? 0)));
      if (distancePx < GESTURE_CLICK_THROUGH_SLOP_PX && durationMs < GESTURE_CLICK_THROUGH_MS) {
        const at = state.layers[0]?.at ?? '';
        /* 3px 的抖动在 pointermove 里已经按「动过」算过（鼠标老阈值 0.5px）：把 moved 归零，
           后面走 `click` 那条路——不提交、不报 GESTURE_NO_OPS；账本里仍记真实位移与时长。 */
        state.moved = false;
        endGesture('commit', [], false);
        opts.onClickThrough({
          clientX: event.clientX,
          clientY: event.clientY,
          at,
          shiftKey: event.shiftKey === true,
          distancePx: round3(distancePx),
          durationMs
        });
        return;
      }
    }

    if (state.mode === 'band') {
      const bandRect = state.bandRect;
      const stage = state.stage;
      const ats = new Set();
      if (bandRect && stage) {
        const bx0 = bandRect.x - stage.x;
        const by0 = bandRect.y - stage.y;
        const bx1 = bx0 + bandRect.w;
        const by1 = by0 + bandRect.h;
        const rects = readPickables().filter((layer) => !isHidden(layer.at));
        for (const layer of rects) {
          const r = /** @type {Rect4} */ (layer.rect);
          const hit = r.x < bx1 && r.x + r.w > bx0 && r.y < by1 && r.y + r.h > by0;
          if (hit) ats.add(layer.at);
        }
      }
      const keep = event.shiftKey === true ? new Set(state.layers.map((layer) => layer.at)) : new Set();
      state.layers = readPickables().filter((layer) => ats.has(layer.at) || keep.has(layer.at));
      state.mode = null;
      state.bandRect = null;
      state.start = null;
      state.moved = false;
      state.targets = null;
      removeDragListeners();
      releasePointerCapture();
      state.lastPoint = null;
      emitSelection();
      render();
      return;
    }

    if (!state.mode) {
      state.start = null;
      state.moved = false;
      removeDragListeners();
      releasePointerCapture();
      state.lastPoint = null;
      render();
      return;
    }

    state.moved = movedFor(event.clientX, event.clientY);
    const moved = state.moved;
    const built = moved ? buildOps(event.clientX, event.clientY) : { ops: [], previews: [], guides: [], deltaStage: { x: 0, y: 0 } };
    /* 松手即消失：间距标签/参考线只在拖动期存在（ED-079），提交之后再清 */
    state.gaps = [];
    state.gapSnapped = null;
    state.altKey = false;
    const ops = built.ops;
    const wasMulti = start.layers.length > 1;
    endGesture('commit', ops, wasMulti);
  }

  /**
   * 系统取消（来电、系统手势、浏览器抢走指针）。
   *
   * 语义只有一条：**回滚到手势前，绝不半途写盘**。具体做法是 `endGesture('cancel')` ——
   * 它不发 `onCommit`/`onCommitMany`，只调 `onCancel`（宿主据此把预览撤掉）。
   * 预览本来就是宿主按 `onPreview` 画的，没有进入过 op 队列，所以「回滚」= 丢掉预览。
   */
  /** @param {PointerEvent} [event] */
  function onPointerCancel(event) {
    if (!state.start) return;
    if (state.pointerId !== null && typeof event?.pointerId === 'number' && event.pointerId !== state.pointerId) return;
    state.cancelReason = 'pointercancel';
    endGesture('cancel', [], false);
  }

  /** @param {KeyboardEvent} event */
  function onKeyDown(event) {
    if (!state.start) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      endGesture('cancel', [], false);
    }
  }

  /**
   * 常驻键盘入口（S25）：方向键微移、Tab 切层、Esc 收尾。
   * 与拖动期间的 `onKeyDown` 是两套：那个只管手势中的 Esc，这个管没有指针手势时的键盘编辑。
   * @param {KeyboardEvent} event
   */
  function onGlobalKeyDown(event) {
    if (state.start && state.mode && state.mode !== 'nudge') return; /* 拖动中：交给 onKeyDown */
    if (event.key === 'Escape') {
      /* 输入态里 Esc 先退输入（由输入控件自己处理），不许在这里取消别的东西 */
      if (isEditable(/** @type {any} */ (event.target)) || isEditable(/** @type {any} */ (doc.activeElement))) return;
      if (state.nudge) {
        event.preventDefault();
        event.stopPropagation();
        cancelNudge();
      }
      return;
    }
    if (event.key === 'Tab') {
      if (!keyboardOwns(event)) return;
      if (state.layers.length === 0 && selectableAts().length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      cycleSelection(event.shiftKey ? -1 : 1);
      return;
    }
    if (ARROW_VECTORS[/** @type {keyof typeof ARROW_VECTORS} */ (event.key)]) nudgeKeyDown(event);
  }

  /** @param {KeyboardEvent} event */
  function onGlobalKeyUp(event) {
    nudgeKeyUp(event);
  }

  /** 窗口失焦：提交微移并取消框选。 */
  function onWindowBlur() {
    if (state.nudge) commitNudge('blur');
    if (state.start?.bandMode) endGesture('cancel', [], false);
  }

  /** @param {MouseEvent} event */
  function onContextMenu(event) {
    if (!state.start) return;
    event.preventDefault();
    event.stopPropagation();
    endGesture('cancel', [], false);
  }

  /** 触摸/笔收尾：把「hover 才有」的视觉状态清干净（高亮描边 + 光标）。 */
  function clearHoverForTouch() {
    if (state.highlightAt !== '') {
      state.highlightAt = '';
      renderHighlight();
    }
    overlay.style.cursor = '';
  }

  /**
   * @param {'commit'|'cancel'} action
   * @param {any[]} ops
   * @param {boolean} multi
   */
  function endGesture(action, ops, multi) {
    removeDragListeners();
    const wasMoved = state.moved;
    const endedMode = state.mode;
    /* 手势账本：指针来源 / 是否移动 / 时长 / 位移 / 结果。验收与排障都读这一份，
       不靠「看截图猜」。 */
    const startedAt = Number(state.start?.startedAt ?? state.gestureStartedAt ?? 0);
    const durationMs = Math.max(0, Math.round(nowMs() - startedAt));
    const endPoint = state.lastPoint ?? state.start ?? null;
    const distancePx = state.start && endPoint
      ? round3(Math.hypot(endPoint.clientX - state.start.clientX, endPoint.clientY - state.start.clientY))
      : 0;
    const touchLike = isTouchLike();
    const kind =
      action === 'cancel'
        ? 'cancel'
        : wasMoved
          ? (endedMode ?? 'gesture')
          : touchLike
            ? durationMs <= GESTURE_TAP_MAX_MS
              ? 'tap'
              : 'press'
            : 'click';
    state.lastGesture = {
      pointerType: state.pointerType,
      kind,
      mode: endedMode,
      moved: wasMoved,
      durationMs,
      distancePx,
      ops: ops.length,
      multi,
      ...(action === 'cancel' ? { cancelReason: state.cancelReason || 'cancel' } : {})
    };
    state.cancelReason = '';
    if (kind === 'tap') state.taps += 1;
    state.mode = null;
    state.handle = '';
    state.start = null;
    state.moved = false;
    state.shift = false;
    state.bandRect = null;
    state.previewFrameOverride = null;
    releasePointerCapture();
    state.lastPoint = null;
    state.targets = null;
    /* 数字交还给宿主那份只读标签（render 里也会兜一次，这里显式做，别指望下一次 render） */
    restoreHostSizeLabel();
    overlay.style.cursor = '';
    /* 触摸没有 hover：浏览器不会补 mouseleave，宿主上一帧设的高亮会一直挂到下次鼠标移动。
       收尾时清掉（下一次真的鼠标 hover 时宿主会重新 setHighlight）。 */
    if (touchLike) clearHoverForTouch();
    state.guides = [];
    state.previewOp = null;

    if (action === 'cancel') {
      state.cancels += 1;
      state.lastOp = null;
      state.lastOps = [];
      if (typeof opts.onCancel === 'function') opts.onCancel();
    } else if (wasMoved && ops.length > 0) {
      if (ops.length === 1) {
        state.commits += 1;
        state.lastOp = ops[0];
        state.lastOps = ops;
        if (typeof opts.onCommit === 'function') opts.onCommit(ops[0]);
      } else if (typeof opts.onCommitMany === 'function') {
        state.commits += 1;
        state.lastOp = null;
        state.lastOps = ops;
        opts.onCommitMany(ops);
      } else {
        /* 没有批量提交口：不假装成功，也不分批提交（分批 = 分步撤销） */
        reportError({ code: 'NO_BATCH_COMMITTER', message: '多选需要宿主提供 onCommitMany（一批 op，一步撤销）' });
      }
    } else if (wasMoved) {
      /* 动了却一条 op 都没有：绝不静默（R10 的旋转「拖了不提交」就是从这条路漏掉的） */
      reportError({ code: 'GESTURE_NO_OPS', message: `${endedMode ?? '手势'}有位移但没产出任何 op（补丁被拒 / 层缺失 / 缩放被拒）` });
    }
    render();
  }

  const onViewportChange = () => render();
  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('keydown', onGlobalKeyDown, true);
  doc.addEventListener('keyup', onGlobalKeyUp, true);
  win.addEventListener('blur', onWindowBlur);
  win.addEventListener('resize', onViewportChange);
  win.addEventListener('scroll', onViewportChange, true);

  render();

  return {
    /** 重读舞台/选择并重绘（宿主提交完必须调一次：同时解除 holdPreview）。 */
    refresh() {
      state.holdPreview = false;
      state.holdSelection = false;
      state.previewOp = null;
      render();
    },
    /**
     * 舞台内部（iframe）转发过来的按下：宿主在舞台文档里监听 `pointerdown`，把坐标换算成
     * **父文档视口坐标**后调这里（`{clientX, clientY, shiftKey, button}`）。
     * 返回 `{handled, at?}`；没命中层就返回 handled:false，宿主可继续当空白处理。
     * @param {{clientX: number, clientY: number, shiftKey?: boolean, button?: number}} info
     */
    stagePointerDown(info) {
      if (!state.stage || !info || (info.button ?? 0) !== 0) return { handled: false };
      if (typeof opts.getLayerRects !== 'function') return { handled: false };
      const cx = finite(info.clientX);
      const cy = finite(info.clientY);
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) return { handled: false };
      const hit = pickAt(cx, cy);
      if (!hit) return { handled: false };
      if (info.shiftKey === true) toggleAt(hit.at, hit);
      else selectOnly(hit.at, hit);
      return { handled: true, at: hit.at };
    },
    /** Use the clip identified by the painted iframe. Its document owns pointer capture.
     * @param {'down'|'move'|'up'|'cancel'} phase
     * @param {string} at
     * @param {PointerEvent} event
     */
    stageBodyPointer(phase, at, event) {
      if (phase === 'down') {
        const layer = readPickables().find((item) => item.at === at);
        if (!layer || !state.stage || state.start) return;
        state.layers = [layer];
        state.pointerId = event.pointerId;
        state.pointerType = event.pointerType;
        startGesture('move', '', event, true);
      } else if (state.start && state.pointerId === event.pointerId) {
        if (phase === 'move') onPointerMove(event);
        else if (phase === 'cancel') onPointerCancel(event);
        else onPointerUp(event);
      }
    },
    /** 悬停联动：给某层画淡描边（`null` 清除）。只读，不发 op。 */
    /** @param {string | null} at */
    setHighlight(at) {
      state.highlightAt = typeof at === 'string' ? at : '';
      renderHighlight();
    },
    /** 程序化改选中（宿主同步自己的选择后用）。 */
    /** @param {readonly Layer[]} layers */
    setSelection(layers) {
      const list = Array.isArray(layers) ? layers : [];
      state.layers = /** @type {Layer[]} */ (list.map(normalizeLayer).filter(Boolean));
      state.holdPreview = false;
      state.previewOp = null;
      render();
      return state.layers.map((layer) => layer.at);
    },
    getState() {
      return {
        at: state.layers[0]?.at ?? null,
        ats: state.layers.map((layer) => layer.at),
        box: state.layers[0]?.box ?? null,
        count: state.layers.length,
        stage: state.stage,
        mode: state.mode,
        handle: state.handle,
        frame: state.frameRect,
        ring: state.handleBox,
        guides: state.guides,
        /** 参考线的来源（舞台边/兄弟/网格）与补偿量；`guides` 保持老形状 */
        guideDetails: state.guideDetails.map((/** @type {any} */ g) => ({ ...g })),
        band: state.bandRect,
        commits: state.commits,
        cancels: state.cancels,
        previews: state.previews,
        lastOp: state.lastOp,
        lastOps: state.lastOps,
        lastResizeDrift: state.lastResizeDrift,
        error: state.error,
        highlightAt: state.highlightAt,
        /** 键盘微移：未提交时是累积量，提交后清空（`nudgeReason` 记录是 keyup / idle / blur） */
        nudge: state.nudge
          ? { acc: { ...state.nudge.acc }, unit: state.nudge.unit, keys: [...state.nudge.keys], ops: state.nudge.ops.length }
          : null,
        nudgeReason: state.nudgeReason ?? null,
        holdPreview: state.holdPreview,
        holdSelection: state.holdSelection,
        /** 'x' | 'y' | 'xy' | ''：本手势是否被「至少 minVisible 可见」夹住（A4 的可读判据） */
        clampAxis: state.clampAxis,
        /** 拖动期的间距读数（S38）：≤4 条，松手即空 */
        gaps: state.gaps.map((/** @type {any} */ g) => ({ ...g })),
        /** 拖动期的等距分布（S42）：≥3 段间距相等才有，`= Npx =` 的数据源 */
        gapRuns: state.gapRuns.map((/** @type {any} */ run) => ({
          ...run,
          segments: run.segments.map((/** @type {any} */ seg) => ({ ...seg })),
          partners: [...run.partners]
        })),
        /** 间距吸附命中的那一条（没有就是 null） */
        gapSnapped: state.gapSnapped,
        /** Alt 按住时吸附整体关闭（S38） */
        snapEnabled: state.altKey !== true,
        /**
         * 指针来源与手感参数（S44）。touch/pen 与 mouse 走**同一条**状态机，
         * 分叉的只有这几个数：tap 阈值、热区、HUD 偏移。
         */
        pointer: {
          type: state.pointerType,
          id: state.pointerId,
          touchLike: isTouchLike(),
          tapMaxMove: GESTURE_TAP_MAX_MOVE,
          tapMaxMs: GESTURE_TAP_MAX_MS,
          clickSlop: GESTURE_CLICK_SLOP,
          hudOffset: isTouchLike() ? GESTURE_TOUCH_HUD_OFFSET : 14,
          hudAnchor: hud.getAttribute('data-hud-anchor') ?? '',
          hudPointer: hud.getAttribute('data-hud-pointer') ?? ''
        },
        /** 触摸点选的累计次数（只有 touch/pen 且未移动的松手才 +1） */
        taps: state.taps,
        /** 最近一次手势的账本：`kind` 是 tap / press / move / resize / rotate / band / cancel */
        lastGesture: state.lastGesture ? { ...state.lastGesture } : null,
        /** 手柄命中区（粗指针 44，鼠标 12 —— 视觉尺寸始终是 GESTURE_HANDLE_PX） */
        hitArea: {
          handlePx: pointerMode.coarse ? GESTURE_TOUCH_HANDLE_HIT_PX : GESTURE_HANDLE_PX,
          visualPx: GESTURE_HANDLE_PX,
          coarse: pointerMode.coarse
        },
        /** 手势结束后应当为空的三样「hover 才有」的东西（A5 的判据） */
        hover: {
          highlight: highlight.style.display !== 'none',
          hud: hud.style.display !== 'none',
          gaps: gapLabels.x.style.display !== 'none' || gapLabels.y.style.display !== 'none'
        },
        /** 尺寸标签（S40）：同一时刻画布上只留一组数字——手势层显示时宿主的被接管 */
        sizeLabel: {
          visible: hud.style.display !== 'none',
          text: hud.style.display === 'none' ? '' : hud.textContent,
          anchor: hud.getAttribute('data-hud-anchor') ?? '',
          hostShadowed: hostLabel.active
        },
        /** 本手势的吸附目标口径（S40）：声明框优先，拿不到才退回画面矩形 */
        targets: {
          count: state.targets === null ? 0 : state.targets.length,
          declared: state.targets === null ? 0 : state.targets.filter((/** @type {any} */ item) => item.rectSource === 'declared').length,
          picture: state.targets === null ? 0 : state.targets.filter((/** @type {any} */ item) => item.rectSource === 'picture').length
        },
        keyboardFrames: state.keyboardFrames,
        selectable: selectableAts(),
        /** @type {{enabled: boolean, stepUnit: string, idleMs: number, steps: typeof GESTURE_NUDGE_STEPS}} */
        keyboard: {
          enabled: keyboardConfig().enabled,
          stepUnit: keyboardConfig().stepUnit,
          idleMs: keyboardConfig().idleMs,
          steps: GESTURE_NUDGE_STEPS
        },
        persistence: GESTURE_PERSISTENCE,
        handles: [...GESTURE_HANDLES]
      };
    },
    /** 屏幕上框的实际 rect（client 坐标）。 */
    getFrameClientRect() {
      const r = frame.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    },
    destroy() {
      restoreHostSizeLabel();
      state.targets = null;
      removeDragListeners();
      releasePointerCapture();
      if (state.nudge?.timer) {
        try {
          win.clearTimeout(state.nudge.timer);
        } catch {
          /* 忽略 */
        }
      }
      state.nudge = null;
      doc.removeEventListener('pointerdown', onPointerDown, true);
      doc.removeEventListener('keydown', onGlobalKeyDown, true);
      doc.removeEventListener('keyup', onGlobalKeyUp, true);
      win.removeEventListener('blur', onWindowBlur);
      win.removeEventListener('resize', onViewportChange);
      win.removeEventListener('scroll', onViewportChange, true);
      overlay.remove();
    },
    overlay
  };
}
