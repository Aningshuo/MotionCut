/**
 * 运行时 describe（副线1 · WP14）
 *
 * 按 LayerRef.at 读取当前层的真实度量与 computed 样式子集，供检查器显示。
 * 与 discover/locate 同一套定位串；0 命中 → LAYER_GONE，Canvas 内部 → NOT_EDITABLE。
 */
import type { LayerBox, LayerError, LayerRef } from '../../contracts/layers';

type Page = import('playwright').Page;

export interface Described {
  readonly box: LayerBox;
  readonly style: Readonly<Record<string, string>>;
  /**
   * 元素**自己写的内联声明**（`el.style.getPropertyValue(k)`，没有就是空串）。
   * 为 S16 加的：`computed` 会把 `line-height: 1.4` 解析成 `67.2px`，光看 computed 分不清
   * 作者写的是「倍数」还是「像素」，面板回写就会把 1.4 写成 67.2px。值优先顺序：
   * override → inline → computed。
   */
  readonly inline?: Readonly<Record<string, string>>;
  readonly locked: boolean;
  readonly text: string;
  readonly tag: string;
  /**
   * 页面自己的视口尺寸（页内文档的 `clientWidth/clientHeight`）。
   * 为 B02 加的（A25「超舞台钳制」）：面板要知道元素能走多远，不能靠猜 1280×720。
   * 与 `box` 同一个坐标系（iframe 视口 = 页面文档坐标）。
   */
  readonly viewport?: { readonly w: number; readonly h: number };
  /**
   * 元素当前 `font-family` 的第一个族名在本机是否有字（R113 · L2 · LI-A10）。
   * `available:false` 只表示「浏览器会用回退字体渲染」，面板据此提示；**不改**作者写的值。
   * 通用族（serif / system-ui 等）与读不到时是 `null`（不提示）。
   */
  readonly fontCheck?: { readonly family: string; readonly available: boolean | null };
  /**
   * 元素（或祖辈）当前有没有会裁掉外描边/外阴影的东西：自己的 `clip-path`，
   * 或祖辈（到 body 为止）的 `overflow` ≠ visible / `clip-path`。
   * R113 · L2：四角圆角要锁一致、外描边要给警示，都靠这一个布尔。
   */
  readonly clipped?: boolean;
  /**
   * R120 · M6（LI-A11/A12/A13）：**布局盒** —— 数值路径的唯一基准。
   *
   * `offsetLeft/offsetTop/offsetWidth/offsetHeight` 是布局坐标：
   * - 不受祖先 `transform: scale/rotate` 影响（这是 A12「父级 scale+rotate」的根）；
   * - 不受滚动影响（`getBoundingClientRect` 会，这是「容器 scroll」的根）；
   * - 不受舞台缩放/预览 fit 影响（那些在父文档，页内根本看不见）；
   * - 就是 `left/top/width/height` 那套坐标（relative 时 `offsetLeft = 静态位 + left`，
   *   正好与「输入 − 实测 + 当前 computed」那条写回公式同构）。
   *
   * `box` 仍是**视觉**矩形（含自身 transform、含滚动），画框/点选用它；两者不要混。
   */
  readonly layout?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  /**
   * 祖先链的 2×2 线性部分（`body → parent`，根先乘）与累计旋转。
   * `ok:false` = 链上有 2D 仿射表达不了的东西（matrix3d 透视 / rotate: x / scale(0)），
   * 这时几何**不许写**（会按错误倍率落盘），面板与手柄都拿这个码做拒绝理由。
   */
  readonly chain?:
    | { readonly ok: true; readonly a: number; readonly b: number; readonly c: number; readonly d: number; readonly rotationDeg: number; readonly nodes: readonly string[] }
    | { readonly ok: false; readonly code: string; readonly reason: string; readonly nodes: readonly string[] };
  /** 视口滚动（布局坐标 = 视觉坐标 + scroll）。 */
  readonly scroll?: { readonly x: number; readonly y: number };
  /** 自身旋转的三份读数：computed 总角度 / `rotate` 属性 / 作者 transform 里的角度。 */
  readonly rotate?: { readonly total: number; readonly property: number; readonly author: number };
  /**
   * 块级布局事实（LI-A13「flex/grid/auto/% 不能无损 → 明确固定化」的判据）：
   * 父级是不是 flex/grid 容器、自身 position 与宽高的来源。
   */
  /**
   * 文本就地的**安全判据**（LI-A05）：只有「子节点里全是文本节点」的元素才能写 `t`。
   * 写了 `t` 的实现是 `el.textContent = ...`（apply-overrides），带 `<em>/<i>/<svg>` 的
   * 元素一写就把子节点拍平。`pureText:false` 时前端必须拒绝并说清原因。
   */
  readonly textEdit?: { readonly childElements: number; readonly textNodes: number; readonly pureText: boolean };
  readonly block?: {
    readonly position: string;
    readonly display: string;
    readonly parentTag: string;
    readonly parentDisplay: string;
    readonly parentPosition: string;
    readonly isFlexItem: boolean;
    readonly isGridItem: boolean;
    readonly widthFrom: 'px' | 'percent' | 'auto' | 'keyword';
    readonly heightFrom: 'px' | 'percent' | 'auto' | 'keyword';
  };
}

type DescribeReturn = { ok: true; value: Described } | { ok: false; error: LayerError };

/** 注入页面执行；必须自包含。导出是为了让「面板在页内」的场景（S10）复用同一份读数。 */
export function readLayer(at: string) {
  /** @type {any} */
  const out = { ok: false, error: { code: 'LAYER_GONE', message: `找不到层：${at}`, at } };
  let el;
  try {
    el = document.querySelector(at);
  } catch {
    out.error = { code: 'LAYER_GONE', message: `非法定位串：${at}`, at };
    return out;
  }
  if (!el) return out;

  let p: Element | null = el;
  while (p && p !== document.documentElement) {
    if (p.tagName === 'CANVAS') {
      return { ok: false, error: { code: 'NOT_EDITABLE', message: 'Canvas 内部对象无 computed 层样式', at } };
    }
    p = p.parentElement;
  }

  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  let rotation = 0;
  if (cs.transform && cs.transform !== 'none') {
    try {
      const m = new DOMMatrixReadOnly(cs.transform);
      rotation = (Math.atan2(m.b, m.a) * 180) / Math.PI;
    } catch {
      rotation = 0;
    }
  }
  /* ── R120 · M6：几何事实（全部只读，不改任何写入口） ─────────────────────
   *
   * 为什么读 `offset*` 而不只读 `getBoundingClientRect`：见 `layout` 的注释。
   * 内联元素没有 offsetWidth（=0），那时退回四舍五入的视觉矩形，并在 `display` 里
   * 留真值，调用方自己知道「这层是 inline，几何不可靠」。
   */
  const ole = el as HTMLElement;
  const rectW = Math.round(r.width);
  const rectH = Math.round(r.height);
  /**
   * 页坐标（布局空间）= 沿 `offsetParent` 链累加 `offsetLeft/Top`。
   *
   * 只取自身的 `offsetLeft` 是**相对包含块**的：包含块自己在页里 x=56 时，
   * 元素实测视觉 92、而 offsetLeft 只有 36（s207 的 `left-is-offset` 就是这么抓到的）。
   * 累加链之后得到的是「不含任何 transform 的页坐标」——与 `left/top` 同一套帧，
   * 也与用户输入的数字同一套（参考图 02 的 X/Y 就是设计坐标）。
   */
  let pageX = 0;
  let pageY = 0;
  for (let op: HTMLElement | null = ole; op !== null; op = op.offsetParent as HTMLElement | null) {
    pageX += Number(op.offsetLeft) || 0;
    pageY += Number(op.offsetTop) || 0;
  }
  const layout = {
    x: pageX,
    y: pageY,
    w: Number(ole.offsetWidth) > 0 ? Number(ole.offsetWidth) : rectW,
    h: Number(ole.offsetHeight) > 0 ? Number(ole.offsetHeight) : rectH,
  };

  /* 祖先链线性部分：每个祖先 = R(rotate)·S(scale)·L(transform)，整条 = 根…父。 */
  const ident = { a: 1, b: 0, c: 0, d: 1 };
  const mul = (m1: { a: number; b: number; c: number; d: number }, m2: { a: number; b: number; c: number; d: number }) => ({
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
  });
  const linearOf = (cs2: CSSStyleDeclaration): { ok: true; linear: { a: number; b: number; c: number; d: number } } | { ok: false; reason: string } => {
    let m = ident;
    const rot = (cs2.rotate || 'none').trim();
    if (rot !== 'none') {
      const parts = rot.split(/\s+/);
      const angleText = parts[parts.length - 1] ?? '';
      const axis = parts.length >= 2 ? parts.slice(0, -1).join(' ') : 'z';
      if (axis !== 'z' || parts.length > 2) return { ok: false, reason: `rotate 轴不是 Z（${rot}）` };
      const deg = parseFloat(angleText);
      if (!Number.isFinite(deg)) return { ok: false, reason: `rotate 读不出角度（${rot}）` };
      const rad = (deg * Math.PI) / 180;
      m = mul(m, { a: Math.cos(rad), b: Math.sin(rad), c: -Math.sin(rad), d: Math.cos(rad) });
    }
    const sc = (cs2.scale || 'none').trim();
    if (sc !== 'none') {
      const nums = sc.split(/\s+/).map((v) => parseFloat(v));
      const sx = nums[0] ?? NaN;
      const sy = nums.length >= 2 ? nums[1] ?? NaN : sx;
      if (!Number.isFinite(sx) || !Number.isFinite(sy)) return { ok: false, reason: `scale 读不出数值（${sc}）` };
      m = mul(m, { a: sx, b: 0, c: 0, d: sy });
    }
    const tf = (cs2.transform || 'none').trim();
    if (tf !== 'none') {
      let dm: DOMMatrix;
      try {
        dm = new DOMMatrix(tf);
      } catch {
        return { ok: false, reason: `transform 解析失败（${tf}）` };
      }
      /* 只认 2D 仿射：m13/m23/m14/m24/m34/m43/m33/m44 这些分量非零就表达不了。 */
      if (!dm.is2D) {
        const eps = 1e-6;
        const bad =
          Math.abs(dm.m13) > eps || Math.abs(dm.m23) > eps || Math.abs(dm.m14) > eps || Math.abs(dm.m24) > eps ||
          Math.abs(dm.m34) > eps || Math.abs(dm.m43) > eps || Math.abs(dm.m33 - 1) > eps || Math.abs(dm.m44 - 1) > eps;
        if (bad) return { ok: false, reason: 'matrix3d 含 3D/透视分量' };
      }
      m = mul(m, { a: dm.m11, b: dm.m12, c: dm.m21, d: dm.m22 });
    }
    return { ok: true, linear: m };
  };
  const up: Element[] = [];
  for (let pp = el.parentElement; pp !== null; pp = pp.parentElement) up.push(pp);
  up.reverse();
  let acc = ident;
  const chainNodes: string[] = [];
  let chainBad = '';
  for (const node of up) {
    if (node === document.documentElement) continue;
    const nodeCs = getComputedStyle(node);
    const label = `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}`;
    const part = linearOf(nodeCs);
    if (part.ok !== true) {
      chainBad = `${label}：${part.reason}`;
      break;
    }
    chainNodes.push(label);
    acc = mul(acc, part.linear);
  }
  const chainDet = acc.a * acc.d - acc.b * acc.c;
  if (chainBad === '') {
    if (!Number.isFinite(chainDet) || Math.abs(chainDet) < 1e-9) chainBad = `祖先矩阵不可逆（det=${chainDet}）`;
  }
  const chain = chainBad === ''
    ? {
        ok: true as const,
        a: Math.round(acc.a * 1e6) / 1e6,
        b: Math.round(acc.b * 1e6) / 1e6,
        c: Math.round(acc.c * 1e6) / 1e6,
        d: Math.round(acc.d * 1e6) / 1e6,
        rotationDeg: Math.round(((Math.atan2(acc.b, acc.a) * 180) / Math.PI) * 1e3) / 1e3,
        nodes: chainNodes,
      }
    : { ok: false as const, code: 'UNSUPPORTED_ANCESTOR_MATRIX', reason: chainBad, nodes: chainNodes };

  /* `rotate` 属性与作者 transform 里的角度拆开：手柄写 `rotate` 时不能把作者那份吃掉。 */
  const rotateRaw = parseFloat(String(cs.rotate || 'none'));
  const rotateProp = Number.isFinite(rotateRaw) ? rotateRaw : 0;
  /* CSS 独立变换属性 `rotate` 不在 `getComputedStyle().transform` 里（后者只回 transform）。
     总角 = rotate 属性 + transform 里的角度 —— 少算这一项时，写了 `rotate:30deg` 的元素
     在面板/手柄里仍显示 0°（R120 实测）。 */
  const totalRotation = rotation + rotateProp;
  const rotateFacts = {
    total: Math.round(totalRotation * 1e3) / 1e3,
    property: Math.round(rotateProp * 1e3) / 1e3,
    author: Math.round(rotation * 1e3) / 1e3,
  };

  /* 宽高来源：作者写了 % → percent；写了 auto / 没写且 computed 是 auto → auto。 */
  const fromOf = (v: string, computed: string): 'px' | 'percent' | 'auto' | 'keyword' => {
    const text = String(v || '').trim();
    if (text !== '') {
      if (text.includes('%')) return 'percent';
      if (/^-?[\d.]+px$/.test(text)) return 'px';
      if (text === 'auto' || text === 'inherit' || text === 'initial') return 'auto';
      return 'keyword';
    }
    return String(computed || '').trim() === 'auto' ? 'auto' : 'px';
  };
  const textEdit = {
    childElements: el.children.length,
    textNodes: Array.prototype.filter.call(el.childNodes, (n: Node) => n.nodeType === 3).length,
    pureText: el.children.length === 0,
  };
  const parentEl = el.parentElement;
  const parentCs = parentEl === null ? null : getComputedStyle(parentEl);
  const parentDisplay = String(parentCs?.display ?? '');
  const block = {
    position: String(cs.position || ''),
    display: String(cs.display || ''),
    parentTag: parentEl === null ? '' : parentEl.tagName.toLowerCase(),
    parentDisplay,
    parentPosition: String(parentCs?.position ?? ''),
    isFlexItem: parentDisplay.includes('flex'),
    isGridItem: parentDisplay.includes('grid'),
    /* 内联声明从 `el.style` 读（此时 `styled` 还没声明，直接用同一个元素）。 */
    widthFrom: fromOf(String(ole.style?.width ?? ''), String(cs.width || '')),
    heightFrom: fromOf(String(ole.style?.height ?? ''), String(cs.height || '')),
  };

  const lockEl = el.closest('[data-lock="true"],[data-locked="true"]');
  let text = '';
  for (const n of el.childNodes) if (n.nodeType === 3) text += n.nodeValue || '';
  if (!text && el.children.length === 0) text = (el.textContent || '').trim();
  text = text.replace(/\s+/g, ' ').trim();

  const pick = [
    'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align',
    'color', 'background-color', 'opacity', 'text-shadow',
    '-webkit-text-stroke-width', '-webkit-text-stroke-color',
    /* S51：效果五个键。`describe` 只读这些键的 computed 值，**不改**任何写入口；
       合同 `OverridePatch.style` 本来就是任意字符串映射，所以这里加键不动合同。 */
    'filter', 'mix-blend-mode', 'border-radius', 'box-shadow', 'backdrop-filter',
    /* B02（R108 / A25、A26、A27）：`position` 只读不写。面板要靠它区分「left/top 直接生效」
       （absolute/relative/fixed）与「静态定位、left/top 是死键」——后者第一次写几何时
       顺带补一条 `position: relative`（relative 不脱离文档流，原布局不塌）。
       **不在这里改任何布局**：`pick` 只决定 describe 回哪几个 computed 值。 */
    'position',
    /* B02：几何写回的**换算基准**。`left/top/width/height` 的 computed 值 +
       实测矩形，才能把「用户输入的坐标」折成 CSS 该写的偏移/尺寸：
       relative 的 `left` 是相对原位的偏移，直接写输入会跑到「原位 + 输入」；
       有 padding/border 的盒子直接写输入宽会胖一圈。四个键都只读。 */
    'left', 'top', 'width', 'height',
    /* R113 · L2（LI-A10 / LI-A16）：文本排版补链与描边/渐隐的只读读数。
       全是 computed 值，面板只拿来显示与反推（写盘仍只写 overrides.style 的声明）。 */
    'font-family', 'font-style', 'text-transform', 'text-decoration-line', 'text-decoration-style',
    /* R123 · M9（LI-A05 收口）：**内容盒**的四个边界量。就地文本编辑要把 textarea 的
       内容盒对齐到元素的内容盒（= 边框盒 − border − padding），否则文字整体偏
       `border + padding` 那么多，换行位置也跟着变。全是 computed 只读值。 */
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
    'text-indent',
    'outline-width', 'outline-style', 'outline-color', 'outline-offset',
    'mask-image', 'mask-composite'
  ];
  const style: Record<string, string> = {};
  const inline: Record<string, string> = {};
  const styled = el as HTMLElement;
  for (const k of pick) {
    style[k] = cs.getPropertyValue(k);
    inline[k] = styled.style?.getPropertyValue(k) || '';
  }

  /* 字体可用性（只读）：只看第一个族名；通用族/读不到 → null（不提示）。
  
     为什么不用 `document.fonts.check()`：Chromium 对**不存在的系统字体**也返回 true
     （它只回答「字体集是否已加载」，不回答「这个族在本机有没有字」）。用文本量宽——
     同一个样本文本在「候选族 + 兜底」与「只用兜底」下的宽度不同，才说明候选族真的存在。
     两条兜底（monospace / serif）都量，任一条不同即存在：能避开「候选族恰好与某条兜底同宽」。 */
  const familyList = String(cs.getPropertyValue('font-family') || '');
  const firstFamily = (familyList.split(',')[0] || '').trim().replace(/^["']|["']$/g, '');
  const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+|inherit|initial|unset)$/i;
  let available: boolean | null = null;
  if (firstFamily !== '' && !GENERIC.test(firstFamily)) {
    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const sample = 'mmmmmmmmmmlli 中文字形';
        const widthOf = (font: string) => {
          ctx.font = font;
          return ctx.measureText(sample).width;
        };
        const quote = firstFamily.replace(/"/g, '');
        let differs = false;
        for (const fallback of ['monospace', 'serif']) {
          const base = widthOf(`72px ${fallback}`);
          const withCandidate = widthOf(`72px "${quote}", ${fallback}`);
          if (Math.abs(withCandidate - base) > 0.5) differs = true;
        }
        available = differs;
      }
    } catch {
      available = null;
    }
  }

  /* 裁切（只读）：自己 clip-path，或祖辈（到 body 为止）的 overflow / clip-path。 */
  let clipped = String(cs.getPropertyValue('clip-path') || 'none') !== 'none';
  for (let p = el.parentElement; !clipped && p !== null && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const pcs = getComputedStyle(p);
    if (String(pcs.getPropertyValue('clip-path') || 'none') !== 'none') clipped = true;
    else if (String(pcs.overflow || 'visible') !== 'visible') clipped = true;
    else if (String(pcs.overflowX || 'visible') !== 'visible' || String(pcs.overflowY || 'visible') !== 'visible') clipped = true;
  }

  return {
    ok: true,
    value: {
      /* 视觉盒 + **总**旋转（含独立属性 `rotate`；面板的「旋转」显示读这一项）。 */
      box: { x: r.x, y: r.y, w: r.width, h: r.height, rotation: Math.round((rotation + rotateProp) * 1e3) / 1e3 },
      style,
      inline,
      locked: !!lockEl,
      text,
      tag: el.tagName.toLowerCase(),
      viewport: { w: document.documentElement.clientWidth, h: document.documentElement.clientHeight },
      fontCheck: { family: firstFamily, available },
      clipped,
      layout,
      chain,
      scroll: { x: Number(window.scrollX) || 0, y: Number(window.scrollY) || 0 },
      rotate: rotateFacts,
      textEdit,
      block
    }
  };
}

export async function describeLayer(page: Page, ref: LayerRef): Promise<DescribeReturn> {
  if (!page || page.isClosed()) {
    return { ok: false, error: { code: 'LAYER_GONE', message: '页面已关闭', clipId: ref.clipId, at: ref.at } };
  }
  try {
    const res = (await page.evaluate(
      readLayer as unknown as (at: string) => { ok: boolean; value?: Described; error?: LayerError },
      ref.at
    )) as { ok: boolean; value?: Described; error?: LayerError };
    if (!res || !res.ok || !res.value) {
      return {
        ok: false,
        error: res?.error ?? { code: 'LAYER_GONE', message: `describe 失败：${ref.at}`, clipId: ref.clipId, at: ref.at }
      };
    }
    return { ok: true, value: res.value };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'LAYER_GONE',
        message: `describe 抛错：${err instanceof Error ? err.message : String(err)}`,
        clipId: ref.clipId,
        at: ref.at
      }
    };
  }
}

export default describeLayer;
