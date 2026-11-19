/**
 * 页内几何探针（副线1 · S15）
 *
 * 只做一件事：把「从包含块局部坐标到屏幕」的线性部分读出来，顺带判断这条链能不能用 2D 仿射表达。
 * 必须是**自包含**函数（`page.evaluate` 只序列化函数体，模块级引用不会跟过去）。
 *
 * 读法（顺序与 CSS 一致）：
 * 每个祖先的线性部分 = `R(rotate) · S(scale) · L(transform)`；
 * `translate` 只影响平移、不影响增量，所以不进线性部分。
 * 整条链 = `L(root) · … · L(parent)`（根在左、父在右，与屏幕合成顺序一致）。
 *
 * 不可表达（统一 `UNSUPPORTED_ANCESTOR_MATRIX`）：
 * - `matrix3d` 带透视 / 3D 旋转 / 非 1 的 Z·W 归一化；
 * - `rotate: x …` / `rotate: y …`（绕 X/Y 轴，2D 投影会丢轴长）；
 * - 链上某个矩阵退化（行列式为 0，例如 `scale(0)`），逆矩阵不存在。
 */

/**
 * 页内执行：读某层的祖先坐标系。
 * @param {string} at
 * @returns {{
 *   ok: true,
 *   at: string,
 *   linear: {a: number, b: number, c: number, d: number},
 *   rotationDeg: number,
 *   scale: {sx: number, sy: number},
 *   chain: {node: string, transform: string, scale: string, rotate: string, linear: {a:number,b:number,c:number,d:number}}[]
 * } | {ok: false, code: string, at: string, reason: string, chain?: any[]}}
 */
export function readGeometrySpace(at) {
  /** @type {Element|null} */
  let el = null;
  try {
    const nodes = document.querySelectorAll(at);
    el = nodes.length === 1 ? (nodes[0] ?? null) : null;
  } catch {
    el = null;
  }
  if (!el) return { ok: false, code: 'LAYER_GONE', at, reason: `找不到层：${at}` };

  /** @param {{a:number,b:number,c:number,d:number}} m1 @param {{a:number,b:number,c:number,d:number}} m2 */
  const mul = (m1, m2) => ({
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d
  });
  const IDENTITY = { a: 1, b: 0, c: 0, d: 1 };

  /**
   * @param {CSSStyleDeclaration} cs
   * @returns {{ok: true, linear: {a:number,b:number,c:number,d:number}, note?: string} | {ok: false, reason: string}}
   */
  const linearOf = (cs) => {
    let m = IDENTITY;

    /* rotate：只支持绕 Z 轴 */
    const rot = (cs.rotate || 'none').trim();
    if (rot !== 'none') {
      const parts = rot.split(/\s+/);
      const angleText = parts[parts.length - 1] ?? '';
      const axis = parts.length >= 2 ? parts.slice(0, -1).join(' ') : 'z';
      if (axis !== 'z' || parts.length > 2) {
        return { ok: false, reason: `rotate 轴不是 Z（${rot}），2D 表达不了` };
      }
      const deg = parseFloat(angleText);
      if (!Number.isFinite(deg)) return { ok: false, reason: `rotate 读不出角度：${rot}` };
      const rad = (deg * Math.PI) / 180;
      m = mul(m, { a: Math.cos(rad), b: Math.sin(rad), c: -Math.sin(rad), d: Math.cos(rad) });
    }

    /* scale */
    const sc = (cs.scale || 'none').trim();
    if (sc !== 'none') {
      const parts = sc.split(/\s+/).map((v) => parseFloat(v));
      const sx = parts[0] ?? NaN;
      const sy = parts.length >= 2 ? (parts[1] ?? NaN) : sx;
      if (!Number.isFinite(sx) || !Number.isFinite(sy)) return { ok: false, reason: `scale 读不出数值：${sc}` };
      m = mul(m, { a: sx, b: 0, c: 0, d: sy });
    }

    /* transform */
    const tf = (cs.transform || 'none').trim();
    if (tf !== 'none') {
      let dm;
      try {
        dm = new DOMMatrix(tf);
      } catch {
        return { ok: false, reason: `transform 解析失败：${tf}` };
      }
      if (!dm.is2D) {
        const [m11 = 0, m12 = 0, m13 = 0, m14 = 0, m21 = 0, m22 = 0, m23 = 0, m24 = 0] = [dm.m11, dm.m12, dm.m13, dm.m14, dm.m21, dm.m22, dm.m23, dm.m24];
        const [, , , , , , , , m31 = 0, m32 = 0, m33 = 1, m34 = 0, m41 = 0, m42 = 0, m43 = 0, m44 = 1] = [
          dm.m11, dm.m12, dm.m13, dm.m14, dm.m21, dm.m22, dm.m23, dm.m24, dm.m31, dm.m32, dm.m33, dm.m34, dm.m41, dm.m42, dm.m43, dm.m44
        ];
        const eps = 1e-6;
        const bad =
          Math.abs(m13) > eps || Math.abs(m23) > eps || Math.abs(m31) > eps || Math.abs(m32) > eps ||
          Math.abs(m14) > eps || Math.abs(m24) > eps || Math.abs(m34) > eps || Math.abs(m43) > eps ||
          Math.abs(m33 - 1) > eps || Math.abs(m44 - 1) > eps || Math.abs(m41) > eps || Math.abs(m42) > eps;
        if (bad) {
          void m11;
          void m12;
          void m21;
          void m22;
          return { ok: false, reason: `matrix3d 含 3D/透视分量：${tf}` };
        }
      }
      m = mul(m, { a: dm.m11, b: dm.m12, c: dm.m21, d: dm.m22 });
    }

    return { ok: true, linear: m };
  };

  /* 从根到父元素的链（根先乘） */
  /** @type {Element[]} */
  const up = [];
  let p = el.parentElement;
  while (p) {
    up.push(p);
    p = p.parentElement;
  }
  up.reverse();

  let m = IDENTITY;
  /** @type {any[]} */
  const chain = [];
  for (const node of up) {
    const cs = getComputedStyle(node);
    const nodeLabel = `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}`;
    const part = linearOf(cs);
    chain.push({
      node: nodeLabel,
      transform: cs.transform,
      scale: cs.scale,
      rotate: cs.rotate,
      translate: cs.translate,
      linear: part.ok ? part.linear : null
    });
    if (!part.ok) {
      return { ok: false, code: 'UNSUPPORTED_ANCESTOR_MATRIX', at, reason: `${nodeLabel}：${part.reason}`, chain };
    }
    m = mul(m, part.linear);
  }

  const det = m.a * m.d - m.b * m.c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) {
    return { ok: false, code: 'UNSUPPORTED_ANCESTOR_MATRIX', at, reason: `祖先矩阵不可逆（det=${det}）`, chain };
  }

  return {
    ok: true,
    at,
    linear: m,
    rotationDeg: (Math.atan2(m.b, m.a) * 180) / Math.PI,
    scale: { sx: Math.hypot(m.a, m.b), sy: Math.hypot(m.c, m.d) },
    chain
  };
}

/**
 * 宿主侧：读某层的祖先坐标系（不在测试里另写一份）。
 * @param {import('playwright').Page} page
 * @param {string} at
 */
export async function geometrySpaceOf(page, at) {
  const fn = /** @type {(a: string) => ReturnType<typeof readGeometrySpace>} */ (readGeometrySpace);
  return page.evaluate(fn, at);
}
