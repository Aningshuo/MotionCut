/**
 * 嵌套变换下的几何坐标系（副线1 · S15）
 *
 * ## 为什么需要它
 *
 * 片段的 `left/top/width/height` 是**声明值**，活在「包含块的局部坐标」里。祖先一旦有
 * `transform: scale/rotate`，同样的声明增量在屏幕上就不是同样多的像素。面板要给用户
 * 「拖多少就是屏幕上动多少」的手感，就必须在两套坐标之间换算：
 *
 *     屏幕（舞台）像素  ←→  声明空间
 *
 * ## 坐标定义（写死，别自己发明）
 *
 * - 设 `L` 为「从包含块局部坐标到屏幕」的**线性部分**（累积祖先 transform 的 2×2 部分；
 *   平移分量是常量偏移，对增量没有影响，所以不参与）。
 * - 面板显示的「屏幕值」= `L · (声明值)`，即
 *   `x_screen = a·x + c·y`，`y_screen = b·x + d·y`；
 *   宽高按轴长缩放：`w_screen = w·hypot(a,b)`、`h_screen = h·hypot(c,d)`；
 *   旋转按角度差：`r_screen = r_declared − 祖先旋转角`。
 * - 提交时反过来解：给定用户输入的屏幕值，先解出声明值，再交给 `set field:'box'`。
 *   因为 `L` 一般不可对角化（有旋转时），改 `x` 可能同时改 `left` 和 `top`——这是正确的，
 *   不然屏幕上会走斜线。
 *
 * 本模块是纯函数（不碰 DOM、不读时钟），页内/Node 都能跑。
 */

/** 2×2 单位矩阵。 */
export const IDENTITY_LINEAR = Object.freeze({ a: 1, b: 0, c: 0, d: 1 });

/** 变换矩阵乘法 `m1 · m2`（先应用 m2，再应用 m1）。 @param {{a:number,b:number,c:number,d:number}} m1 @param {{a:number,b:number,c:number,d:number}} m2 */
export function multiplyLinear(m1, m2) {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d
  };
}

/**
 * 按「从根到叶」的顺序合成：`composeLinear([root, …, parent])` = `root · … · parent`。
 * @param {readonly {a:number,b:number,c:number,d:number}[]} list
 */
export function composeLinear(list) {
  /** @type {{a:number,b:number,c:number,d:number}} */
  let m = { ...IDENTITY_LINEAR };
  for (const next of list) m = multiplyLinear(m, next);
  return m;
}

/** @param {{a:number,b:number,c:number,d:number}} m */
export function determinant(m) {
  return m.a * m.d - m.b * m.c;
}

/** 逆矩阵；不可逆（缩放为 0 / 退化）返回 null。 @param {{a:number,b:number,c:number,d:number}} m */
export function invertLinear(m) {
  const det = determinant(m);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null;
  return { a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det };
}

/** @param {{a:number,b:number,c:number,d:number}} m @param {number} x @param {number} y */
export function applyLinear(m, x, y) {
  return { x: m.a * x + m.c * y, y: m.b * x + m.d * y };
}

/** 两轴的长度比例（列向量长度）。 @param {{a:number,b:number,c:number,d:number}} m */
export function axisScale(m) {
  return { sx: Math.hypot(m.a, m.b), sy: Math.hypot(m.c, m.d) };
}

/** 合成矩阵里的 Z 旋转角（度）。 @param {{a:number,b:number,c:number,d:number}} m */
export function rotationDegrees(m) {
  return (Math.atan2(m.b, m.a) * 180) / Math.PI;
}

/** @param {number} n */
const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * 判断一个 4×4（matrix3d 展开的 16 个数）是不是「2D 仿射」。
 * 透视项（m14/m24/m34/m43 之类）非零、或 Z 轴分量不为 1，就表达不了。
 * @param {readonly number[]} v 列主序，与 DOMMatrix 的 m11…m44 一致
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function checkAffine16(v) {
  if (!Array.isArray(v) || v.length !== 16 || v.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    return { ok: false, reason: 'matrix3d 数值不完整' };
  }
  const eps = 1e-6;
  const [m11, m12, m13, m14, m21, m22, m23, m24, m31, m32, m33, m34, m41, m42, m43, m44] = v;
  if (Math.abs(m13) > eps || Math.abs(m23) > eps || Math.abs(m31) > eps || Math.abs(m32) > eps) {
    return { ok: false, reason: `含 3D 旋转/斜切分量（m13=${m13.toFixed(6)}, m23=${m23.toFixed(6)}）` };
  }
  if (Math.abs(m14) > eps || Math.abs(m24) > eps || Math.abs(m34) > eps || Math.abs(m43) > eps) {
    return { ok: false, reason: `含透视分量（m14=${m14}, m24=${m24}, m34=${m34}, m43=${m43}）` };
  }
  if (Math.abs(m33 - 1) > eps || Math.abs(m44 - 1) > eps) {
    return { ok: false, reason: `Z/W 归一化不是 1（m33=${m33}, m44=${m44}）` };
  }
  if (Math.abs(m41) > eps || Math.abs(m42) > eps) {
    return { ok: false, reason: '含 Z 方向平移分量' };
  }
  return { ok: true };
}

/**
 * 声明 box → 面板显示的屏幕值。
 * @param {{x:number,y:number,w:number,h:number,r?:number}} box
 * @param {{linear:{a:number,b:number,c:number,d:number}, rotationDeg:number}} geometry
 */
export function boxToScreen(box, geometry) {
  const p = applyLinear(geometry.linear, box.x, box.y);
  const { sx, sy } = axisScale(geometry.linear);
  return {
    x: round3(p.x),
    y: round3(p.y),
    w: round3(box.w * sx),
    h: round3(box.h * sy),
    r: round3((box.r ?? 0) - geometry.rotationDeg)
  };
}

/**
 * 实测矩形（屏幕像素）→ 声明空间的 box。用于「片段还没声明尺寸」时的基准框：
 * `getBoundingClientRect()` 给的是屏幕尺寸，祖先有 scale 时必须除回去，否则一编辑就把
 * 放大后的尺寸写进声明。旋转会把矩形变成外接框（不可逆），所以只有声明缺失又带旋转时才不准；
 * 这种情况下调用方最好自己提供声明 box。
 * @param {{x:number,y:number,w:number,h:number,r?:number}} screenBox
 * @param {{linear:{a:number,b:number,c:number,d:number}, rotationDeg:number}} geometry
 * @returns {{x:number,y:number,w:number,h:number,r?:number} | null}
 */
export function screenBoxToDeclared(screenBox, geometry) {
  const inv = invertLinear(geometry.linear);
  if (!inv) return null;
  const { sx, sy } = axisScale(geometry.linear);
  const p = applyLinear(inv, screenBox.x, screenBox.y);
  /** @type {{x:number,y:number,w:number,h:number,r?:number}} */
  const box = {
    x: round3(p.x),
    y: round3(p.y),
    w: sx > 1e-9 ? round3(screenBox.w / sx) : round3(screenBox.w),
    h: sy > 1e-9 ? round3(screenBox.h / sy) : round3(screenBox.h)
  };
  const r = (screenBox.r ?? 0) + geometry.rotationDeg;
  if (Number.isFinite(r) && Math.abs(r) > 1e-9) box.r = round3(r);
  return box;
}

/**
 * 面板输入（屏幕值）→ 声明值的增量换算。
 *
 * null 表示「换算不了」的稳定错误码集合：`UNSUPPORTED_ANCESTOR_MATRIX`。
 * @param {string} fieldId `x` | `y` | `w` | `h` | `rotation`
 * @param {number} screenValue
 * @param {{x:number,y:number,w:number,h:number,r?:number}} box 当前声明 box
 * @param {{linear:{a:number,b:number,c:number,d:number}, rotationDeg:number}} geometry
 * @returns {{box: {x:number,y:number,w:number,h:number,r?:number}} | {error: {code: string, message: string}}}
 */
export function screenEditToBox(fieldId, screenValue, box, geometry) {
  if (!Number.isFinite(screenValue)) {
    return { error: { code: 'INVALID_VALUE', message: `需要数值：${screenValue}` } };
  }
  const inv = invertLinear(geometry.linear);
  if (!inv) {
    return { error: { code: 'UNSUPPORTED_ANCESTOR_MATRIX', message: '祖先变换矩阵不可逆（缩放为 0？），无法把屏幕像素换成声明值' } };
  }
  const current = boxToScreen(box, geometry);
  const { sx, sy } = axisScale(geometry.linear);

  if (fieldId === 'x' || fieldId === 'y') {
    /* 另一轴保持用户看到的屏幕值不变，解一个 2×2 线性方程组 */
    const target = { x: current.x, y: current.y };
    target[fieldId === 'x' ? 'x' : 'y'] = screenValue;
    const decl = applyLinear(inv, target.x, target.y);
    return { box: { ...box, x: round3(decl.x), y: round3(decl.y) } };
  }
  if (fieldId === 'w') {
    if (sx < 1e-9) return { error: { code: 'UNSUPPORTED_ANCESTOR_MATRIX', message: 'X 轴缩放为 0，宽度的屏幕换算无解' } };
    return { box: { ...box, w: round3(screenValue / sx) } };
  }
  if (fieldId === 'h') {
    if (sy < 1e-9) return { error: { code: 'UNSUPPORTED_ANCESTOR_MATRIX', message: 'Y 轴缩放为 0，高度的屏幕换算无解' } };
    return { box: { ...box, h: round3(screenValue / sy) } };
  }
  if (fieldId === 'rotation') {
    return { box: { ...box, r: round3(screenValue + geometry.rotationDeg) } };
  }
  return { error: { code: 'NOT_EDITABLE', message: `不是几何字段：${fieldId}` } };
}

/**
 * 面板要显示的「来源」说明：`declared` = 片段自己写了这个声明；`measured` = 只有实测。
 * @param {boolean} declared
 */
export function sourceLabel(declared) {
  return declared ? 'declared' : 'measured';
}

/**
 * 首次编辑实测来源时要给的提示（不许静默把实测宽高固定下来）。
 * @param {{w?: number, h?: number}} box
 */
export function measuredPinHint(box) {
  const w = Number.isFinite(box?.w) ? Math.round(Number(box.w) * 100) / 100 : 0;
  const h = Number.isFinite(box?.h) ? Math.round(Number(box.h) * 100) / 100 : 0;
  return `该片段还没声明尺寸：这次编辑会把实测 ${w}×${h}px 写进 style（之后宽高就不再随内容变化）`;
}
