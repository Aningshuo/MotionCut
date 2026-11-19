/**
 * 四类场景 profile 与能力标注（副线1 · WP04）
 *
 * 能力值直接取自 contracts/layers.ts 的 LAYER_CAPABILITY，避免各线各写一套。
 * UI 只需读 CAPABILITY 字段决定是否允许几何/样式/文本编辑，不得把像素内部
 * 对象说成可编辑层。
 */
// 运行时读公共合同（Node 22 原生类型剥离）；不用静态 import 是为了避免
// tsconfig 的 allowImportingTsExtensions 限制，同时保持能力值只有一处定义。
const { LAYER_CAPABILITY } = await import(
  new URL('../../contracts/layers.ts', import.meta.url).href
);

export { LAYER_CAPABILITY };

/** @typedef {'FULL'|'PARTIAL'|'PIXEL_ONLY'|'UNSUPPORTED'} Capability */

/**
 * @typedef {object} SceneProfile
 * @property {'dom'|'svg'|'canvas'|'webgl'} id
 * @property {string} scene 相对仓库根的夹具路径
 * @property {Capability} capability
 * @property {string} layerModel 层来源
 * @property {boolean} editable 是否允许写 override
 * @property {string[]} editableProps 允许覆盖的属性（几何/样式/文本）
 * @property {{meanAbsDiff:number, maxChannelDiff:number}|null} pixelTolerance
 *          非逐像素一致时的容差；FULL 为 null（要求逐像素一致）
 * @property {string} notes
 */

/** @type {Record<'dom'|'svg'|'canvas'|'webgl', SceneProfile>} */
export const PROFILES = {
  dom: {
    id: 'dom',
    scene: 'tests/fixtures/scenes/dom.html',
    capability: LAYER_CAPABILITY.dom,
    layerModel: '运行 DOM 元素（含 CSS 动画与 WAAPI，settle 到 t）',
    editable: true,
    editableProps: ['x', 'y', 'w', 'h', 'rotation', 'opacity', 'color', 'background', 'font-size', 'text'],
    pixelTolerance: null,
    notes: '逐像素一致；同一 t 必须同 sha256，不做容差。'
  },
  svg: {
    id: 'svg',
    scene: 'tests/fixtures/scenes/svg.html',
    capability: LAYER_CAPABILITY.svg,
    layerModel: 'SVG 元素（图元可作为层，但部分属性不可逆写回源）',
    editable: true,
    editableProps: ['x', 'y', 'w', 'h', 'rotation', 'opacity', 'fill', 'stroke'],
    pixelTolerance: null,
    notes: 'PARTIAL：几何可改，滤镜/遮罩/marker 不保证可逆；像素仍要求同 t 同哈希。'
  },
  canvas: {
    id: 'canvas',
    scene: 'tests/fixtures/scenes/canvas.html',
    capability: LAYER_CAPABILITY.canvas,
    layerModel: '单个 <canvas> 位图，内部无 DOM 对象',
    editable: false,
    editableProps: [],
    pixelTolerance: null,
    notes: 'PIXEL_ONLY：只能整体当图片处理，canvas 内部不可定位/不可编辑（NOT_EDITABLE）。'
  },
  webgl: {
    id: 'webgl',
    scene: 'tests/fixtures/scenes/webgl.html',
    capability: LAYER_CAPABILITY.webgl,
    layerModel: '单个 WebGL <canvas> 像素输出',
    editable: false,
    editableProps: [],
    pixelTolerance: { meanAbsDiff: 2, maxChannelDiff: 12 },
    notes:
      'PIXEL_ONLY：无 GPU 时走 SwiftShader，允许每通道平均差 ≤2、单通道最大差 ≤12，' +
      '不得宣称逐像素一致；同 t 同哈希仍由本机基线单独记录。'
  }
};

/** 其它能力边界（跨源/封闭 ShadowDOM 等，不在四类 profile 内）。 */
export const EXTRA_CAPABILITIES = {
  shadowDomClosed: LAYER_CAPABILITY.shadowDomClosed,
  crossOriginFrame: LAYER_CAPABILITY.crossOriginFrame
};

/**
 * @param {string} id
 * @returns {SceneProfile}
 */
export function profileFor(id) {
  const p = PROFILES[/** @type {'dom'|'svg'|'canvas'|'webgl'} */ (id)];
  if (!p) throw new Error(`未知场景 profile: ${id}`);
  return p;
}

/**
 * 按标签/来源推断能力分级；locate 与 UI 共用这一处判定。
 * @param {'dom'|'svg'|'canvas'|'webgl'|'shadowDomClosed'|'crossOriginFrame'} kind
 * @returns {Capability}
 */
export function capabilityOf(kind) {
  switch (kind) {
    case 'dom':
      return LAYER_CAPABILITY.dom;
    case 'svg':
      return LAYER_CAPABILITY.svg;
    case 'canvas':
      return LAYER_CAPABILITY.canvas;
    case 'webgl':
      return LAYER_CAPABILITY.webgl;
    case 'shadowDomClosed':
      return LAYER_CAPABILITY.shadowDomClosed;
    case 'crossOriginFrame':
      return LAYER_CAPABILITY.crossOriginFrame;
    default:
      return 'UNSUPPORTED';
  }
}

/** 供基线脚本直接写入 JSON 的摘要。 */
export function profileSummary() {
  return Object.values(PROFILES).map((p) => ({
    id: p.id,
    scene: p.scene,
    capability: p.capability,
    editable: p.editable,
    pixelTolerance: p.pixelTolerance
  }));
}
