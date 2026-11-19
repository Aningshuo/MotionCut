/**
 * 检查器字段核心 · 运行时（副线1 · WP14 / S10）
 *
 * 这里是**唯一实现**：字段模型（`buildInspector`）、多选模型、最小 patch（`patchForField`）。
 * `inspector.ts` 只是带类型的门面（再导出一遍），为了两件事：
 * 1. TS 调用方（React 壳、edit-session）继续 `import type` 拿接口；
 * 2. 浏览器/面板可以直接加载本文件——`.mjs` 不需要转译，`.ts` 需要。
 *
 * 硬规矩（合同 layers.ts）：
 * - 覆盖优先，没有覆盖才显示 computed；`source` 必须如实标注。
 * - 提交时只写用户真正改的字段（最小 patch），**不把整帧 computed 样式烘进 override**。
 * - 锁定的层 editable=false；提交由 edit-session 拒绝并报 LOCKED。
 *
 * 本文件是纯函数：不碰 DOM、不碰磁盘、不读时钟，便于在 Node 与浏览器里直接测。
 *
 * @typedef {import('../../contracts/layers').LayerRef} LayerRef
 * @typedef {import('../../contracts/layers').OverridePatch} OverridePatch
 * @typedef {import('../../contracts/layers').LayerError} LayerError
 * @typedef {import('../../contracts/layers').LayerBox} LayerBox
 */

import { mergeOverride } from './override-merge.mjs';
import { boxToScreen } from './geometry-space.mjs';
/* R113 · L2（LI-A16/A17/A18/A19）：调色五项 / 效果栈 / 17 混合模式能力矩阵的**唯一实现**在
   inspector-adjust.mjs（纯函数）。模型只负责把它的读数摆成字段，序列化一个字节都不在这里写。 */
import {
  BLEND_ITEMS,
  GRADE_SPECS,
  filterWithGrade,
  EFFECT_DEFS,
  blendMatrix,
  effectPatch,
  gradeFromFilter,
  readEffect
} from './inspector-adjust.mjs';
import { MASK_PROP, MASK_SHAPES, maskParamRows, readMask } from './inspector-mask.mjs';
import { CROP_CORNERS, CROP_DEFAULTS, CROP_PROP, FIT_MODES, MEDIA_PROP, POSITIONS, readCrop, readMedia } from './inspector-image.mjs';
/* E12-P3 B5（R38）：文本样式四项的取值域只认这一份（与服务端 `validateTextStyle()` 同一个模块）——
   面板允许的写法与写盘校验不可能分叉。text-style.mjs 是纯模块（零 import），可以进浏览器包。 */
import { TEXT_ALIGNS, isCssColor } from '../film-core/text-style.mjs';

export { mergeOverride, overrideKeys, patchKeys, sameKeyValue } from './override-merge.mjs';

/** @typedef {'px'|'em'|'deg'|'%'|'秒'|'色值'|'无'} FieldUnit */
/** @typedef {'text'|'geometry'|'typography'|'appearance'} FieldGroupId */

/**
 * @typedef {object} DescribedLayer
 * @property {LayerBox} box
 * @property {Readonly<Record<string,string>>} style
 * @property {Readonly<Record<string,string>>} [inline] 元素自己的内联声明（S16：区分「倍数」与「像素」）
 * @property {boolean} [locked]
 * @property {string} [text]
 * @property {string} [tag]
 */

/** @type {Record<FieldGroupId, string>} */
const GROUP_LABEL = {
  text: '文字',
  geometry: '位置尺寸',
  typography: '排版',
  appearance: '外观'
};

/** @type {readonly FieldGroupId[]} */
const GROUP_ORDER = ['text', 'geometry', 'typography', 'appearance'];

/**
 * R121 · M7-B（D02）：右栏按**对象**分组 —— 五页签，元素/片段降为次级切换。
 *
 * 为什么是这五页（不是按 `group` 直接当页签）：
 * - `group` 是数据来源（text/geometry/typography/appearance），页面按它分会出现
 *   「外观」一页塞 30 行、里面还混着调节/效果/描边四段；
 * - 用户看的是「我现在要改什么」：文案 / 位置尺寸 / 颜色调子 / 加效果 / 高级原文。
 *
 * 规矩：**每个字段恰好属于一页**（并集 == 整张表，不重不漏；`s210 · B3/union-equals-model` 钉住）。
 * 页签只是视图分流，字段、handler、readonly 一个都不删。
 */
export const OBJECT_TABS = Object.freeze([
  Object.freeze({ id: 'text', label: '文本' }),
  Object.freeze({ id: 'props', label: '属性' }),
  Object.freeze({ id: 'adjust', label: '调节' }),
  Object.freeze({ id: 'effects', label: '效果' }),
  Object.freeze({ id: 'advanced', label: '高级' })
]);

/** 原文/不结构化、只在「高级」里出现的字段（动了它们要懂 CSS）。 */
const ADVANCED_IDS = new Set(['filter', 'backdropFilter', 'backgroundImage']);

/**
 * 字段 → 页签。规则顺序：id 前缀（grade…/effect…）→ 显式表 → group 兜底。
 * @param {any} field
 * @returns {'text'|'props'|'adjust'|'effects'|'advanced'}
 */
export function tabOfField(field) {
  const id = String(field?.id ?? '');
  if (id.startsWith('grade')) return 'adjust';
  if (id.startsWith('effect')) return 'effects';
  if (ADVANCED_IDS.has(id)) return 'advanced';
  if (id === 'mixBlendMode') return 'adjust';
  const group = String(field?.group ?? '');
  if (group === 'text' || group === 'typography') return 'text';
  if (group === 'geometry' || group === 'appearance') return 'props';
  return 'advanced';
}

/** 给一批字段挂上 `tab`，并返回五页的统计（面板画页签用）。 */
function withTabs(/** @type {any[]} */ fields) {
  for (const field of fields) field.tab = tabOfField(field);
  return OBJECT_TABS.map((tab) => ({
    id: tab.id,
    label: tab.label,
    count: fields.filter((field) => field.tab === tab.id).length
  }));
}

/** computed 样式键 → 字段定义。 */
const STYLE_FIELDS = [
  /* ── 文本排版补链（R113 · L2 · LI-F11 / LI-A10）─────────────────────────
     字体家族 / 斜体 / 大小写 / 装饰线四个键都只是 `overrides.style` 的一条声明，
     与字号同一条写入口；「缺字体回退」是 describe 的只读读数（`fontCheck`），不写盘。 */
  { id: 'fontFamily', key: 'font-family', label: '字体', group: /** @type {FieldGroupId} */ ('typography'), unit: /** @type {FieldUnit} */ ('无'), control: 'font' },
  {
    id: 'fontStyle',
    key: 'font-style',
    label: '斜体',
    group: /** @type {FieldGroupId} */ ('typography'),
    unit: /** @type {FieldUnit} */ ('无'),
    control: 'select',
    choices: [
      { value: 'normal', label: '正常' },
      { value: 'italic', label: '斜体' },
      { value: 'oblique', label: '倾斜' }
    ]
  },
  { id: 'fontSize', key: 'font-size', label: '字号', group: /** @type {FieldGroupId} */ ('typography'), unit: /** @type {FieldUnit} */ ('px') },
  { id: 'fontWeight', key: 'font-weight', label: '字重', group: /** @type {FieldGroupId} */ ('typography'), unit: /** @type {FieldUnit} */ ('无') },
  { id: 'lineHeight', key: 'line-height', label: '行高', group: /** @type {FieldGroupId} */ ('typography'), unit: /** @type {FieldUnit} */ ('px') },
  { id: 'letterSpacing', key: 'letter-spacing', label: '字距', group: /** @type {FieldGroupId} */ ('typography'), unit: /** @type {FieldUnit} */ ('px') },
  { id: 'textAlign', key: 'text-align', label: '对齐', group: /** @type {FieldGroupId} */ ('typography'), unit: /** @type {FieldUnit} */ ('无') },
  /* R113 · L2：大小写与装饰线（LI-F11 的四项里的两项，另两项是上面的字体/斜体）。 */
  {
    id: 'textTransform',
    key: 'text-transform',
    label: '大小写',
    group: /** @type {FieldGroupId} */ ('typography'),
    unit: /** @type {FieldUnit} */ ('无'),
    control: 'select',
    choices: [
      { value: 'none', label: '不转换' },
      { value: 'uppercase', label: '全部大写' },
      { value: 'lowercase', label: '全部小写' },
      { value: 'capitalize', label: '首字母大写' }
    ]
  },
  {
    id: 'textDecoration',
    key: 'text-decoration-line',
    label: '装饰线',
    group: /** @type {FieldGroupId} */ ('typography'),
    unit: /** @type {FieldUnit} */ ('无'),
    control: 'select',
    choices: [
      { value: 'none', label: '无' },
      { value: 'underline', label: '下划线' },
      { value: 'line-through', label: '删除线' },
      { value: 'overline', label: '上划线' }
    ]
  },
  {
    id: 'textDecorationStyle',
    key: 'text-decoration-style',
    label: '装饰线型',
    group: /** @type {FieldGroupId} */ ('typography'),
    unit: /** @type {FieldUnit} */ ('无'),
    control: 'select',
    choices: [
      { value: 'solid', label: '实线' },
      { value: 'dashed', label: '虚线' },
      { value: 'dotted', label: '点线' },
      { value: 'wavy', label: '波浪' }
    ]
  },
  { id: 'color', key: 'color', label: '颜色', group: /** @type {FieldGroupId} */ ('appearance'), unit: /** @type {FieldUnit} */ ('色值') },
  { id: 'backgroundColor', key: 'background-color', label: '背景', group: /** @type {FieldGroupId} */ ('appearance'), unit: /** @type {FieldUnit} */ ('色值') },
  { id: 'opacity', key: 'opacity', label: '不透明度', group: /** @type {FieldGroupId} */ ('appearance'), unit: /** @type {FieldUnit} */ ('无') },
  /* ── 效果（S51）：五个字段全走 `overrides.style`，合同 `OverridePatch.style` 是
     `Record<string,string>`，所以一个键都不用加类型。顺序写死：不透明度之后、描边之前。 */
  {
    id: 'filter',
    key: 'filter',
    label: '滤镜',
    group: /** @type {FieldGroupId} */ ('appearance'),
    unit: /** @type {FieldUnit} */ ('无'),
    control: 'select',
    presets: [
      { value: 'none', label: '无' },
      { value: 'blur(4px)', label: '模糊 4px' },
      { value: 'brightness(1.2)', label: '提亮 1.2' },
      { value: 'contrast(1.2)', label: '对比 1.2' },
      { value: 'saturate(1.5)', label: '饱和 1.5' },
      { value: 'grayscale(1)', label: '去色' }
    ]
  },
  {
    id: 'mixBlendMode',
    key: 'mix-blend-mode',
    label: '混合模式',
    group: /** @type {FieldGroupId} */ ('appearance'),
    unit: /** @type {FieldUnit} */ ('无'),
    control: 'select',
    /* R113 · L2（LI-F16 / LI-A16）：参考的 **17 种**，逐项带能力（见 `blendMatrix`）。
       这里只给静态清单；运行时能力（CSS.supports）由 buildInspector 的 `opts.supports` 覆盖
       `options` 与 `matrix`，前端不会拿到一个「假下拉」。 */
    choices: BLEND_ITEMS.map((item) => ({ value: item.mode, label: item.label }))
  },
  { id: 'borderRadius', key: 'border-radius', label: '圆角', group: /** @type {FieldGroupId} */ ('appearance'), unit: /** @type {FieldUnit} */ ('px') },
  /* `box-shadow` 只有一个通道：内阴影与外阴影共用它。模型里按 `inset` 前缀拆成两个字段显示，
     提交时再合回去（谁也别把谁冲掉）——见 `splitBoxShadow`。 */
  { id: 'boxShadow', key: 'box-shadow', label: '盒子阴影', group: /** @type {FieldGroupId} */ ('appearance'), unit: /** @type {FieldUnit} */ ('无'), control: 'text', shadowPart: 'outer' },
  {
    id: 'backdropFilter',
    key: 'backdrop-filter',
    label: '背景模糊',
    group: /** @type {FieldGroupId} */ ('appearance'),
    unit: /** @type {FieldUnit} */ ('无'),
    control: 'select',
    presets: [
      { value: 'none', label: '无' },
      { value: 'blur(8px)', label: '模糊 8px' },
      { value: 'blur(16px)', label: '模糊 16px' }
    ]
  },
  /* ── 裁切 / 背景图 / 内阴影（S54）：三个键同样只是 `overrides.style` 的一条声明 ── */
  {
    id: 'clipPath',
    key: 'clip-path',
    label: '裁切',
    group: /** @type {FieldGroupId} */ ('appearance'),
    unit: /** @type {FieldUnit} */ ('px'),
    control: 'inset',
    /* 四边各一个数值 + 一个单位选择；提交时合成 `inset(t r b l)`。顺序固定「上右下左」。 */
    parts: [
      { id: 'top', label: '上' },
      { id: 'right', label: '右' },
      { id: 'bottom', label: '下' },
      { id: 'left', label: '左' }
    ]
  },
  { id: 'backgroundImage', key: 'background-image', label: '图片', group: /** @type {FieldGroupId} */ ('appearance'), unit: /** @type {FieldUnit} */ ('无'), control: 'text' },
  {
    id: 'backgroundSize',
    key: 'background-size',
    label: '背景图尺寸',
    group: /** @type {FieldGroupId} */ ('appearance'),
    unit: /** @type {FieldUnit} */ ('无'),
    control: 'select',
    choices: [
      { value: 'cover', label: '铺满（cover）' },
      { value: 'contain', label: '完整显示（contain）' },
      { value: '100% 100%', label: '拉伸（100% 100%）' }
    ]
  },
  {
    id: 'backgroundPosition',
    key: 'background-position',
    label: '背景图位置',
    group: /** @type {FieldGroupId} */ ('appearance'),
    unit: /** @type {FieldUnit} */ ('无'),
    control: 'select',
    choices: [
      { value: 'center', label: '居中' },
      { value: 'top', label: '上' },
      { value: 'bottom', label: '下' },
      { value: 'left', label: '左' },
      { value: 'right', label: '右' },
      { value: 'top left', label: '左上' },
      { value: 'top right', label: '右上' },
      { value: 'bottom left', label: '左下' },
      { value: 'bottom right', label: '右下' }
    ]
  },
  /* ── R125 · M11-B（LI-A24）：图像适配 / 图像位置 / 四角百分比裁切 / 换源 ──
     三条都是 `overrides.style` 的一条声明（`object-fit` / `object-position` / `clip-path`），
     换源用 `content: url(…)`（`<img>` 没有可写的属性通道，见 inspector-image.mjs 文件头）。 */
  {
    id: 'objectFit',
    key: 'object-fit',
    label: '图像适配',
    group: /** @type {FieldGroupId} */ ('appearance'),
    section: '图像',
    unit: /** @type {FieldUnit} */ ('无'),
    control: 'select',
    onlyFor: ['img', 'video', 'canvas', 'svg'],
    choices: FIT_MODES.map((item) => ({ value: item.value, label: item.label }))
  },
  {
    id: 'objectPosition',
    key: 'object-position',
    label: '图像位置',
    group: /** @type {FieldGroupId} */ ('appearance'),
    section: '图像',
    unit: /** @type {FieldUnit} */ ('无'),
    control: 'select',
    onlyFor: ['img', 'video', 'canvas', 'svg'],
    choices: POSITIONS.map((item) => ({ value: item.value, label: item.label }))
  },
  { id: 'cropCorners', key: 'clip-path', label: '四角裁切', group: /** @type {FieldGroupId} */ ('appearance'), section: '图像', unit: /** @type {FieldUnit} */ ('%'), control: 'crop4' },
  { id: 'mediaSrc', key: 'content', label: '素材', group: /** @type {FieldGroupId} */ ('appearance'), section: '图像', unit: /** @type {FieldUnit} */ ('无'), control: 'media' },
  { id: 'strokeWidth', key: '-webkit-text-stroke-width', label: '文字描边宽', group: /** @type {FieldGroupId} */ ('appearance'), unit: /** @type {FieldUnit} */ ('px') },
  { id: 'strokeColor', key: '-webkit-text-stroke-color', label: '文字描边色', group: /** @type {FieldGroupId} */ ('appearance'), unit: /** @type {FieldUnit} */ ('色值') },
  { id: 'textShadow', key: 'text-shadow', label: '阴影', group: /** @type {FieldGroupId} */ ('appearance'), unit: /** @type {FieldUnit} */ ('无') },
  /* ── R113 · L2（LI-F15 / LI-A16）：四角独立圆角 + 描边（内/中/外）─────────
   *
   * 四角与上面的「圆角」是**同一条** `border-radius` 声明（和 box-shadow 拆内外阴影同一种做法：
   * 一行写简写、一行写四角，谁写谁整条替换，读回后两边一致）。
   * 描边用 `outline` 系列而不是 `border`：`outline` **不占布局**，写多少都不动元素矩形
   * （几何/命中/框选/对齐全部不受影响，A26 的几何零漂移靠这条）。
   * 「内/中/外」是 `outline-offset` 的函数：offset = -w → 内、-w/2 → 中、0 → 外。
   * 外描边会被裁切（clip-path / 祖辈 overflow）吃掉一半 —— 面板按 `clipped` 给警示。 */
  {
    id: 'radiusCorners',
    key: 'border-radius',
    label: '四角',
    group: /** @type {FieldGroupId} */ ('appearance'),
    unit: /** @type {FieldUnit} */ ('px'),
    control: 'corners',
    parts: [
      { id: 'tl', label: '左上' },
      { id: 'tr', label: '右上' },
      { id: 'br', label: '右下' },
      { id: 'bl', label: '左下' }
    ]
  },
  {
    id: 'outlinePosition',
    key: 'outline-offset',
    label: '描边位置',
    group: /** @type {FieldGroupId} */ ('appearance'),
    unit: /** @type {FieldUnit} */ ('无'),
    control: 'select',
    choices: [
      { value: 'inner', label: '内' },
      { value: 'center', label: '中' },
      { value: 'outer', label: '外' }
    ]
  },
  { id: 'outlineWidth', key: 'outline-width', label: '描边粗细', group: /** @type {FieldGroupId} */ ('appearance'), unit: /** @type {FieldUnit} */ ('px') },
  { id: 'outlineColor', key: 'outline-color', label: '描边色', group: /** @type {FieldGroupId} */ ('appearance'), unit: /** @type {FieldUnit} */ ('色值') },
  {
    id: 'outlineStyle',
    key: 'outline-style',
    label: '描边线型',
    group: /** @type {FieldGroupId} */ ('appearance'),
    unit: /** @type {FieldUnit} */ ('无'),
    control: 'select',
    choices: [
      { value: 'solid', label: '实线' },
      { value: 'dashed', label: '虚线' },
      { value: 'dotted', label: '点线' }
    ]
  }
];

/**
 * 可以按「数值 + 单位」编辑的排版字段（S16）。
 *
 * 为什么不能只靠 computed：`line-height: 1.4` 的 computed 是 `67.2px`（浏览器给的是用值），
 * 拿它回写就把「倍数」烘成了像素。所以值的优先顺序是
 * **override → 元素自己的内联声明 → computed**，单位也按同一来源决定。
 *
 * - `min`/`exclusiveMin`：范围，越界一律 `INVALID_VALUE`；
 * - `defaultUnit`：输入没写单位时补什么（`fontSize` 补 `px`，`lineHeight` 保持无单位）；
 * - `allowNormal`：允许写 `normal`（行高/字距/字重）。
 */
export const NUMERIC_STYLE_FIELDS = Object.freeze({
  fontSize: Object.freeze({ key: 'font-size', label: '字号', min: 0, exclusiveMin: true, defaultUnit: 'px', allowNormal: false }),
  lineHeight: Object.freeze({ key: 'line-height', label: '行高', min: 0, exclusiveMin: true, defaultUnit: '', allowNormal: true }),
  letterSpacing: Object.freeze({ key: 'letter-spacing', label: '字距', defaultUnit: 'px', allowNormal: true }),
  strokeWidth: Object.freeze({ key: '-webkit-text-stroke-width', label: '描边宽度', min: 0, defaultUnit: 'px', allowNormal: false }),
  fontWeight: Object.freeze({ key: 'font-weight', label: '字重', min: 1, defaultUnit: '', allowNormal: true }),
  opacity: Object.freeze({ key: 'opacity', label: '不透明度', min: 0, max: 1, defaultUnit: '', allowNormal: false }),
  /* S51：圆角是**单值像素**，百分比一律拒绝（`50%` 在椭圆盒上不是「圆角」而是另一种形状，
     与 ASS 侧的矩形模型对不上；见 README §14）。 */
  borderRadius: Object.freeze({
    key: 'border-radius',
    label: '圆角',
    min: 0,
    max: 400,
    defaultUnit: 'px',
    allowNormal: false,
    allowPercent: false
  }),
  /* R113 · L2（LI-A16）：描边粗细。上限 50px —— 再粗就不是描边而是块了；
     真正的写入口在 `patchForField('outlineWidth')`（要顺带按位置重算 outline-offset）。 */
  outlineWidth: Object.freeze({
    key: 'outline-width',
    label: '描边粗细',
    min: 0,
    max: 50,
    defaultUnit: 'px',
    allowNormal: false,
    allowPercent: false
  })
});

/* ── 效果字段（S51）─────────────────────────────────────────────────────
 *
 * 五个键都只是 `overrides.style` 里的一条 CSS 声明（`apply-overrides.mjs` 用
 * `el.style.setProperty(key, value)` 原样写），所以**不需要动合同**，也不需要
 * 在宿主里加分支。这里负责的是「面板能填什么、什么算非法」。
 */

/** 下拉里的「自定义」哨兵值。面板见到它不提交，只把文本输入框露出来。 */
export const CUSTOM_OPTION = '__custom__';

/** 滤镜允许的函数（与 CSS Filter Effects 的函数集一致，`drop-shadow` 只在 `filter` 里可用）。 */
const FILTER_FUNCS = new Set(['blur', 'brightness', 'contrast', 'saturate', 'grayscale', 'sepia', 'hue-rotate', 'invert', 'opacity']);
/** `backdrop-filter` 不接受 `drop-shadow`（规范里是 `filter` 独有的），这里两边共用一个集合。 */
const BACKDROP_FUNCS = FILTER_FUNCS;

/** 混合模式的取值（写死；非法值报 `INVALID_VALUE`，不静默落一个浏览器不认识的值）。
 *  R113 · L2（LI-F16）：从 6 种扩到参考的 **17 种**（含 `plus-lighter` = 相加）；
 *  顺序与参考 `cM` 一致，能力矩阵见 `inspector-adjust.mjs` 的 `blendMatrix()`。 */
export const BLEND_MODES = Object.freeze(BLEND_ITEMS.map((item) => item.mode));

/** 效果字段 id（顺序 = 面板里的显示顺序）。 */
export const EFFECT_STYLE_FIELDS = Object.freeze(['filter', 'mixBlendMode', 'borderRadius', 'boxShadow', 'backdropFilter']);

/** 圆角上限（px）。与 `NUMERIC_STYLE_FIELDS.borderRadius.max` 同源，测试两边都断言。 */
export const BORDER_RADIUS_MAX = NUMERIC_STYLE_FIELDS.borderRadius.max;

/**
 * 归一化 CSS 值，用于「预设 ↔ 文本」的可逆比对：
 * 小写、折叠空白、去掉函数参数两侧的空格（`blur( 4px )` 与 `blur(4px)` 视为同一个）。
 * @param {unknown} text
 */
export function normalizeCssValue(text) {
  return String(text ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .toLowerCase();
}

/**
 * 解析并校验 `filter` / `backdrop-filter` 的函数列表。
 *
 * 接受 `none` 或 `name(args)` 的空格分隔序列（CSS 语法就是这么定义的）。
 * 拒绝：空串、未知函数、空参数、残留字符（例如 `blur(4px) garbage`）、
 * 以及 `;{}<>`（防止把整条声明截断成两条）。
 *
 * @param {unknown} text
 * @param {{label?: string, allow?: Set<string>}} [opts]
 * @returns {{ok: true, value: string} | {ok: false, error: {code: string, message: string}}}
 */
export function parseFilterList(text, opts = {}) {
  const label = opts.label ?? '滤镜';
  const allow = opts.allow ?? FILTER_FUNCS;
  const raw = String(text ?? '').trim();
  if (raw === '') {
    return { ok: false, error: { code: 'INVALID_VALUE', message: `${label}不能为空（要清掉请选 none）` } };
  }
  if (/^none$/i.test(raw)) return { ok: true, value: 'none' };
  if (/[;{}<>]/.test(raw)) {
    return { ok: false, error: { code: 'INVALID_VALUE', message: `${label}含非法字符：${raw}` } };
  }
  /** @type {string} */
  let consumed = '';
  const re = /([a-z-]+)\(([^()]*)\)/gi;
  let match;
  while ((match = re.exec(raw)) !== null) {
    const name = (match[1] ?? '').toLowerCase();
    if (!allow.has(name)) {
      return { ok: false, error: { code: 'INVALID_VALUE', message: `${label}不认识函数 ${name}()` } };
    }
    if ((match[2] ?? '').trim() === '') {
      return { ok: false, error: { code: 'INVALID_VALUE', message: `${label}的 ${name}() 缺少参数` } };
    }
    consumed += match[0];
  }
  const squeeze = (/** @type {string} */ s) => s.replace(/\s+/g, '').toLowerCase();
  if (squeeze(consumed) !== squeeze(raw)) {
    return { ok: false, error: { code: 'INVALID_VALUE', message: `${label}写不成函数列表：${raw}` } };
  }
  return { ok: true, value: raw.replace(/\s+/g, ' ') };
}


/* ── 裁切 / 背景图 / 内阴影（S54）───────────────────────────────────────
 *
 * 这三个字段和 S51 的五个一样：只是 `overrides.style` 里的一条声明，**不动合同**。
 * 这里负责「什么算合法」与「模型怎么拆」：
 *
 * | 字段 | CSS key | 合法值 | 拒绝 |
 * |---|---|---|---|
 * | `clipPath` | `clip-path` | `inset(t r b l)`，1–4 个非负 px/%（CSS 简写展开） | 负值、`circle()` 等非 inset、四边合计达到/超过盒 |
 * | `backgroundImage` | `background-image` | `none` / 工程内相对路径 / `data:image/*;base64,…` | `..`、绝对路径、`http(s):`/`file:`/`javascript:` 等任何 scheme |
 * | `backgroundSize` | `background-size` | `cover` / `contain` / `100% 100%` | 其它 |
 * | `backgroundPosition` | `background-position` | 九个方向词 | 其它 |
 * | `boxShadowInset` | `box-shadow` | 必须以 `inset` 开头 | 没有 inset 前缀 |
 */

/** 裁切的四边（顺序 = `inset()` 的简写顺序）。 */
export const CLIP_INSET_PARTS = Object.freeze(['top', 'right', 'bottom', 'left']);
/** 背景图尺寸的固定选项（不给任意文本：`background-size` 的语法太杂，写错只会静默失效）。 */
export const BACKGROUND_SIZES = Object.freeze(['cover', 'contain', '100% 100%']);
/** 背景图位置的九个方向词。 */
export const BACKGROUND_POSITIONS = Object.freeze([
  'center', 'top', 'bottom', 'left', 'right',
  'top left', 'top right', 'bottom left', 'bottom right'
]);

/**
 * 按**顶层**逗号切（`rgb(0, 0, 0)` 里的逗号不能切）。
 * @param {string} text
 * @returns {string[]}
 */
export function splitTopLevelCommas(text) {
  const raw = String(text ?? '');
  /** @type {string[]} */
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      out.push(raw.slice(start, i));
      start = i + 1;
    }
  }
  out.push(raw.slice(start));
  return out.map((part) => part.trim()).filter(Boolean);
}

/**
 * 四角圆角的四个角（顺序 = `border-radius` 简写的 左上 右上 右下 左下）。
 * 与 `CLIP_INSET_PARTS` 同一种「一条声明拆四格」的做法。
 */
export const CORNER_PARTS = Object.freeze([
  Object.freeze({ id: 'tl', label: '左上' }),
  Object.freeze({ id: 'tr', label: '右上' }),
  Object.freeze({ id: 'br', label: '右下' }),
  Object.freeze({ id: 'bl', label: '左下' })
]);

/**
 * 解析 `border-radius` 的四个角（支持 1–4 值简写；百分比原样保留成字符串）。
 *
 * computed 一般是 `4px` 或 `4px 8px 4px 8px`（Chromium 会展开成四个值），
 * 但作者也可能写 `50%` —— 面板四格只收像素，所以非 px 的值标 `custom`（不静默改写成 0）。
 *
 * @param {unknown} text
 * @returns {{values: string[], custom: boolean}}
 */
export function parseRadiusCorners(text) {
  const raw = String(text ?? '').trim();
  if (raw === '' || /^none$/i.test(raw)) return { values: ['0', '0', '0', '0'], custom: false };
  /* 斜杠语法（`10px / 20px`，椭圆角）不拆：那是另一件事，四格表达不了。 */
  if (raw.includes('/')) return { values: ['0', '0', '0', '0'], custom: true };
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length === 0 || parts.length > 4) return { values: ['0', '0', '0', '0'], custom: true };
  const [a, b, c, d] = parts;
  const expanded = parts.length === 1
    ? [a, a, a, a]
    : parts.length === 2
      ? [a, b, a, b]
      : parts.length === 3
        ? [a, b, c, b]
        : [a, b, c, d];
  let custom = false;
  const values = expanded.map((part) => {
    const hit = /^([+-]?(?:\d+\.?\d*|\.\d+))(px|%)?$/i.exec(String(part ?? '').trim());
    if (!hit) {
      custom = true;
      return '0';
    }
    if ((hit[2] ?? '').toLowerCase() === '%') {
      custom = true;
      return '0';
    }
    return String(Number(hit[1]));
  });
  return { values, custom };
}

/**
 * 把 `box-shadow` 拆成内阴影 / 外阴影两半。
 *
 * 这个 CSS 属性**只有一个通道**，内阴影和外阴影共用。面板把它们做成两行，
 * 显示各自的半边、提交时再合回去 —— 否则改内阴影会把外阴影悄悄冲掉。
 * @param {unknown} text
 * @returns {{inset: string[], outer: string[]}}
 */
export function splitBoxShadow(text) {
  const raw = String(text ?? '').trim();
  if (raw === '' || /^none$/i.test(raw)) return { inset: [], outer: [] };
  const parts = splitTopLevelCommas(raw);
  return {
    inset: parts.filter((part) => /^inset\b/i.test(part)),
    outer: parts.filter((part) => !/^inset\b/i.test(part))
  };
}

/**
 * 解析 `clip-path: inset(...)`。
 *
 * CSS 的 `inset()` 支持 1–4 个值（1=四边、2=上下/左右、3=上/左右/下、4=上右下左），
 * 这里按同一套展开，然后**统一序列化成四个值**（面板提交的唯一形状）。
 * 四边合计达到或超过盒子尺寸 = 整块被裁没了，按非法处理。
 *
 * @param {unknown} text
 * @param {{box?: {w?: number, h?: number}}} [opts]
 * @returns {{ok: true, value: string, parts: Array<{id: string, value: string, unit: string}>}
 *   | {ok: false, error: {code: string, message: string}}}
 */
export function parseClipInset(text, opts = {}) {
  const raw = String(text ?? '').trim();
  /** @type {(message: string) => {ok: false, error: {code: string, message: string}}} */
  const fail = (message) => ({ ok: false, error: { code: 'INVALID_VALUE', message } });
  const match = /^inset\(\s*([^()]*?)\s*\)$/i.exec(raw);
  if (!match) return fail(`裁切只接受 inset(上 右 下 左)（收到「${raw || '空'}」）`);
  const tokens = String(match[1] ?? '').split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 4) return fail('inset() 里要 1–4 个长度');
  /** @type {Array<{num: number, unit: string}>} */
  const values = [];
  for (const token of tokens) {
    const hit = /^(\d+(?:\.\d+)?|\.\d+)(px|%)?$/i.exec(token);
    if (!hit) return fail(`看不懂的长度「${token}」（只收非负的 px 或 %）`);
    values.push({ num: Number(hit[1]), unit: (hit[2] ?? 'px').toLowerCase() });
  }
  const first = values[0];
  if (!first) return fail('inset() 里要 1–4 个长度');
  const v1 = values[1] ?? first;
  const v2 = values[2] ?? first;
  const v3 = values[3] ?? v1;
  const edges = /** @type {Array<{num: number, unit: string}>} */ ([first, v1, v2, v3]);
  const box = opts.box ?? null;
  const axis = (/** @type {{num:number,unit:string}} */ item, /** @type {'x'|'y'} */ which) => {
    if (item.unit !== '%') return item.num;
    const base = which === 'x' ? Number(box?.w) : Number(box?.h);
    return Number.isFinite(base) && base > 0 ? (item.num / 100) * base : Number.NaN;
  };
  if (box && Number.isFinite(Number(box.w)) && Number.isFinite(Number(box.h))) {
    const vertical = (axis(first, 'y') || 0) + (axis(v2, 'y') || 0);
    const horizontal = (axis(v3, 'x') || 0) + (axis(v1, 'x') || 0);
    if (vertical >= Number(box.h)) {
      return fail(`上下合计 ${Math.round(vertical * 100) / 100}px 已经达到盒高 ${box.h}px（整块被裁没了）`);
    }
    if (horizontal >= Number(box.w)) {
      return fail(`左右合计 ${Math.round(horizontal * 100) / 100}px 已经达到盒宽 ${box.w}px（整块被裁没了）`);
    }
  }
  const text_ = edges.map((/** @type {{num: number, unit: string}} */ item) => `${item.num}${item.unit}`).join(' ');
  return {
    ok: true,
    value: `inset(${text_})`,
    parts: CLIP_INSET_PARTS.map((id, index) => {
      const item = /** @type {{num: number, unit: string}} */ (edges[index]);
      return { id, value: String(item.num), unit: item.unit };
    })
  };
}

/**
 * 解析 `background-image`：只允许 `none`、工程内相对路径、`data:image/*`。
 *
 * 为什么这么严：这是**内容源**的一条声明，写进 `overrides.style` 后会原样进
 * `el.style.setProperty()`。放任意 URL 等于给工程文件开一个外链出口（离线导出、
 * 隐私、`file://` 读盘都在这条线上），所以按白名单来，而不是按黑名单。
 *
 * @param {unknown} text
 * @returns {{ok: true, value: string} | {ok: false, error: {code: string, message: string}}}
 */
export function parseBackgroundImage(text) {
  const raw = String(text ?? '').trim();
  /** @type {(message: string) => {ok: false, error: {code: string, message: string}}} */
  const fail = (message) => ({ ok: false, error: { code: 'INVALID_VALUE', message } });
  if (raw === '' || /^none$/i.test(raw)) return { ok: true, value: 'none' };
  let inner = raw;
  const wrapped = /^url\(\s*(['"]?)(.*?)\1\s*\)$/i.exec(raw);
  if (wrapped) inner = String(wrapped[2] ?? '').trim();
  else if (/^url\(/i.test(raw)) return fail(`background-image 的 url() 写法不完整：${raw}`);
  if (inner === '') return fail('背景图路径是空的（要清掉请选 none）');
  /* data URL 先判：base64 里本来就有 `;` 与 `/`，不能过下面那条「非法字符」检查 */
  if (/^data:/i.test(inner)) {
    if (!/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[a-z0-9+/=]+$/i.test(inner)) {
      return fail('data URL 只收 data:image/{png,jpeg,gif,webp,svg+xml};base64,…');
    }
    return { ok: true, value: `url("${inner}")` };
  }
  if (/[;{}<>"']/.test(inner)) return fail(`背景图路径含非法字符：${inner}`);
  if (/^[a-z][a-z0-9+.-]*:/i.test(inner)) return fail(`背景图不接受外部或绝对来源：${inner}`);
  if (inner.startsWith('//')) return fail(`背景图不接受协议相对地址：${inner}`);
  if (inner.startsWith('/') || inner.startsWith('\\')) return fail(`背景图必须是工程内相对路径：${inner}`);
  if (inner.split(/[\\/]/).includes('..')) return fail(`背景图不能跳出工程目录：${inner}`);
  if (!/^[A-Za-z0-9._\-\/ ]+$/.test(inner)) return fail(`背景图路径只收字母数字与 . _ - /：${inner}`);
  return { ok: true, value: `url("${inner}")` };
}

/**
 * 把 `48px` / `1.4` / `-0.5px` / `normal` / 空串 解析成统一形状。
 * @param {unknown} raw
 * @returns {{kind:'number', value:number, suffix:string, raw:string}
 *   | {kind:'normal', raw:string}
 *   | {kind:'empty', raw:string}
 *   | {kind:'error', code:string, message:string, raw:string}}
 */
export function parseNumericValue(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return { kind: 'empty', raw: text };
  if (/^normal$/i.test(text)) return { kind: 'normal', raw: text };
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))\s*([a-z%]*)$/i.exec(text);
  if (!m) return { kind: 'error', code: 'INVALID_VALUE', message: `读不出数值：${text}`, raw: text };
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return { kind: 'error', code: 'INVALID_VALUE', message: `不是有限数值：${text}`, raw: text };
  return { kind: 'number', value, suffix: (m[2] ?? '').toLowerCase(), raw: text };
}

/** @param {number} n */
const round1 = (n) => Math.round(n * 10) / 10;

/** `rgb(17, 24, 39)` 之类原样返回；用于展示，不改写。 @param {unknown} v */
function asText(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** @param {unknown} v @param {number} [fallback] */
function num(v, fallback = 0) {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : fallback;
}

/** @param {OverridePatch|null|undefined} override @param {string} key */
function hasStyleKey(override, key) {
  const style = override?.style;
  return !!style && Object.prototype.hasOwnProperty.call(style, key);
}

/**
 * 下拉字段的选项 / 当前选中项（S51）。
 *
 * `presets` 带「自定义」哨兵（`filter`/`backdropFilter`），`choices` 不带（`mixBlendMode`
 * 只有六个合法值，写别的浏览器会整条忽略）。`display` 给面板绑 `<select>.value`：
 * 命中预设就是预设值，自定义就是**原文**（不能给哨兵，否则两层不同的自定义值会被判成相同）。
 *
 * @param {any} def
 * @param {string} raw
 */
function describeChoice(def, raw) {
  const items = def.presets ?? def.choices ?? [];
  const wanted = normalizeCssValue(raw);
  const hit = items.find((/** @type {any} */ item) => normalizeCssValue(item.value) === wanted) ?? null;
  return {
    options: def.presets ? [...def.presets, { value: CUSTOM_OPTION, label: '自定义' }] : [...def.choices],
    selected: hit ? hit.value : def.presets ? CUSTOM_OPTION : raw,
    custom: !hit,
    display: hit ? hit.value : raw
  };
}

/**
 * 构造单层检查器模型。
 *
 * `current` 的取值顺序：override.style[key] → describe.style[key] → 空串；
 * 几何：声明过的 box（`opts.box`）→ 实测 `describe.box`；覆盖 `s`/`r` 只影响来源标注。
 *
 * @param {LayerRef} ref
 * @param {OverridePatch|null|undefined} override
 * @param {DescribedLayer} described
 * @param {{locked?: boolean, text?: string, box?: any, baseBox?: any, boxEditable?: boolean, geometry?: any,
 *   supports?: (property: string, value: string) => boolean,
 *   fontCheck?: {family: string, available: boolean|null},
 *   clipped?: boolean,
 *   pendingStyle?: Record<string, string>}} [opts]
 *   `box`：片段自己声明的 box（`{x,y,w,h,r?}` 或 `{x,y,w,h,rotation}`）；
 *   `boxEditable`：调用方没有 box 提交口（`deps.commitBox`）时传 false，几何字段会置灰并给原因；
 *   `geometry`：`readGeometrySpace()` 的结果。给了就把几何字段显示成**屏幕值**（`display`），
 *   `current` 仍是声明值——提交侧要的是声明值，别拿 display 去提交。
 *   `baseBox`：**已经换算到声明空间**的基准框（面板算好传进来）。给了就用它当 `current`，
 *   避免「实测矩形 → 声明空间」被重复投影一次。
 *   `pendingStyle`：面板刚提交、还没被 describe 证实的声明（键 → 值）。**优先级最高**——
 *   否则读回慢一步时，四角/调色会拿旧值重画，连改四格只剩最后两格（实测踩过）；
 *   `supports`：`CSS.supports`（混合模式能力矩阵用；不传 = 按 Chromium 140 全支持）；
 *   `fontCheck`：describe 的字体可用性（缺字体只提示，不改值）；
 *   `clipped`：元素（或祖辈）当前有裁切 —— 四角圆角锁一致、外描边给警示。
 */
export function buildInspector(ref, override, described, opts = {}) {
  const locked = Boolean(opts.locked || override?.lock || described.locked);
  const editable = !locked;
  const style = described.style || {};
  const oStyle = override?.style || {};

  /** @type {any[]} */
  const fields = [];

  /* ---- 文字 ---- */
  const overrideText = typeof override?.t === 'string' ? override.t : undefined;
  const computedText = opts.text ?? described.text ?? '';
  fields.push({
    id: 'text',
    label: '内容',
    group: 'text',
    current: overrideText !== undefined ? overrideText : computedText,
    source: overrideText !== undefined ? 'override' : 'computed',
    editable,
    unit: '无',
    overrideKey: 't',
    ...(locked ? { lockedReason: 'LAYER_LOCKED' } : {})
  });

  /* ---- 文字样式四项（E12-P3 B5 · R38）----
   *
   * 四键就是 `TEXT_STYLE_KEYS`（`packages/film-core/text-style.mjs:37`）：
   * stroke / bg / align / tracking。它们是 **OverrideEntry 上的键**，不是 CSS 属性 ——
   * 所以**不进** `ELEMENT_FIELD_GROUPS.text` / `fieldsAllowedFor('text')`，
   * 写回走 `set { field:'overrides' }`，服务端 `film-doc.mjs` 用 `validateTextStyle()` 校。
   *
   * `source` 用 `override` / `computed` 两个值就够（面板靠它上色，见 `.inspector-field-source`）。
   * testid 里必须出现英文键名：副线2 的量具按 `data-testid + name + label` 跑
   * `/stroke|bg|align|tracking/i`（`s190-r52-e12p3-accept.mjs:553`），只写中文 label 判不到 ——
   * 前缀在 `inspector-panel.mjs` 里统一加（`inspector-field-<id>`），这里只提供 id。
   */
  const textStyleOverride = /** @type {any} */ (override);
  const hasStroke = textStyleOverride?.stroke !== undefined && textStyleOverride?.stroke !== null;
  const hasBg = textStyleOverride?.bg !== undefined && textStyleOverride?.bg !== null;
  const hasAlign = typeof textStyleOverride?.align === 'string';
  const hasTracking = typeof textStyleOverride?.tracking === 'number';
  fields.push(
    {
      id: 'stroke',
      label: '描边',
      group: 'text',
      current: hasStroke ? String(textStyleOverride.stroke?.color ?? '') : '',
      source: hasStroke ? 'override' : 'computed',
      editable,
      unit: '色值',
      overrideKey: 'stroke',
      ...(locked ? { lockedReason: 'LAYER_LOCKED' } : {})
    },
    {
      id: 'bg',
      label: '底框',
      group: 'text',
      current: hasBg ? String(textStyleOverride.bg?.color ?? '') : '',
      source: hasBg ? 'override' : 'computed',
      editable,
      unit: '色值',
      overrideKey: 'bg',
      ...(locked ? { lockedReason: 'LAYER_LOCKED' } : {})
    },
    {
      id: 'align',
      label: '对齐',
      group: 'text',
      current: hasAlign ? textStyleOverride.align : 'left',
      source: hasAlign ? 'override' : 'computed',
      editable,
      unit: '无',
      overrideKey: 'align',
      control: 'select',
      options: [
        { value: 'left', label: '左' },
        { value: 'center', label: '中' },
        { value: 'right', label: '右' },
        { value: 'justify', label: '两端' }
      ],
      selected: hasAlign ? textStyleOverride.align : 'left',
      ...(locked ? { lockedReason: 'LAYER_LOCKED' } : {})
    },
    {
      id: 'tracking',
      label: '字距',
      group: 'text',
      current: hasTracking ? textStyleOverride.tracking : 0,
      source: hasTracking ? 'override' : 'computed',
      editable,
      unit: 'px',
      overrideKey: 'tracking',
      ...(locked ? { lockedReason: 'LAYER_LOCKED' } : {})
    }
  );

  /* ---- 位置尺寸（S13 起可编辑）：box 字段，提交走 `set` op 的 field:'box' ----
   *
   * 与 `s`/`r` 覆盖的区别（两套写入口，互不污染）：
   * - `s`/`r` 是 **overrides**，改的是渲染时的变换，不改片段源文件里的声明；
   * - `box`（x/y/w/h/r）是 **片段自己的 style 声明** `left/top/width/height/rotate`，会落盘。
   * 面板里几何组的输入框一律走 box（持久化），`patchForField` 里那条 `s`/`r` 路径保留给
   * 程序化调用（不经过面板）。
   *
   * 数值来源：`opts.box`（片段声明的 box，精确）优先，没有就退回 `describe().box`（实测矩形）。
   * 因此 `declared=false` 的字段第一次编辑会把实测宽高写进声明——这是 box 整体替换语义的必然，
   * 已在 CAPABILITY.md §9 写清。
   */
  const box = described.box;
  /** 片段声明的 box（`style` 里的 left/top/width/height/rotate），没有就 null。 */
  const declared = opts.box && typeof opts.box === 'object' ? opts.box : null;
  const scale = override?.s;
  const [sx, sy] = Array.isArray(scale) && scale.length >= 2 ? [num(scale[0], 1), num(scale[1], 1)] : [1, 1];
  const scaled = Boolean(scale);
  const boxLock = locked ? 'LAYER_LOCKED' : opts.boxEditable === false ? 'NO_BOX_COMMITTER' : '';
  /* S15：祖先坐标系（可选）。有它时几何字段显示**屏幕值**、提交前换算回声明值；
     没有时退回 R7 行为（显示声明值、原样提交），保证向后兼容。 */
  const geometry = opts.geometry && opts.geometry.ok === true ? opts.geometry : null;
  /**
   * @param {string} id
   * @param {string} label
   * @param {number} declaredValue 声明空间的值（提交与展示都要）
   * @param {FieldUnit} unit
   * @param {'x'|'y'|'w'|'h'|'r'} boxKey
   * @param {string} styleProp
   * @param {number} [screenValue] 屏幕空间的值（有 geometry 时给）
   */
  const geo = (id, label, declaredValue, unit, boxKey, styleProp, screenValue) => ({
    id,
    label,
    group: 'geometry',
    current: round1(declaredValue),
    source: 'computed',
    editable: !boxLock,
    unit,
    kind: 'box',
    boxKey,
    styleProp,
    /* 面板显示哪个值：有坐标系就显示屏幕值，否则与 R7 一样显示声明值 */
    display: round1(screenValue === undefined ? declaredValue : screenValue),
    space: screenValue === undefined ? 'declared' : 'screen',
    declared: Boolean(declared && declared[boxKey] !== undefined && declared[boxKey] !== null),
    sourceLabel: opts.box && opts.box[boxKey] !== undefined && opts.box[boxKey] !== null ? 'declared' : 'measured',
    ...(boxLock ? { lockedReason: boxLock } : {})
  });
  /** 片段声明里这一项的原值（`r` 兼容 `rotation` 写法）。 @param {'x'|'y'|'w'|'h'|'r'} key */
  const declaredRaw = (key) => {
    if (!declared) return undefined;
    return key === 'r' ? (declared.r ?? declared.rotation) : declared[key];
  };
  /** 声明里到底有没有这一项（0 也算有）。 @param {'x'|'y'|'w'|'h'|'r'} key */
  const declaredHas = (key) => {
    const raw = declaredRaw(key);
    return raw !== undefined && raw !== null && Number.isFinite(Number(raw));
  };
  /**
   * 显示值：声明优先，没有就用兜底。
   * @param {'x'|'y'|'w'|'h'|'r'} key
   * @param {number} fallback
   * @param {boolean} [nonZero] 宽高只认非零声明（0 说明作者没写这个声明）
   */
  const declaredNum = (key, fallback, nonZero = false) => {
    const raw = declaredRaw(key);
    if (raw === undefined || raw === null) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    if (nonZero && n === 0) return fallback;
    return n;
  };

  /* 当前值（**声明空间**）：宿主给了 baseBox 就用它（已把实测换算回声明空间），
     否则与 R7 一样：声明优先、没有就实测。 */
  const base = opts.baseBox && typeof opts.baseBox === 'object' ? opts.baseBox : null;
  const cur = base
    ? {
        x: num(base.x, box.x),
        y: num(base.y, box.y),
        w: num(base.w, box.w * (scaled ? sx : 1)),
        h: num(base.h, box.h * (scaled ? sy : 1)),
        r: num(base.r, override?.r ?? box.rotation ?? 0)
      }
    : {
        x: declaredNum('x', box.x),
        y: declaredNum('y', box.y),
        w: declaredNum('w', box.w * (scaled ? sx : 1), true),
        h: declaredNum('h', box.h * (scaled ? sy : 1), true),
        r: declaredNum('r', override?.r ?? box.rotation ?? 0)
      };
  const screenBox = geometry ? boxToScreen({ x: cur.x, y: cur.y, w: cur.w, h: cur.h, r: cur.r }, geometry) : null;
  const scr = (/** @type {'x'|'y'|'w'|'h'|'r'} */ key) => (screenBox ? screenBox[key] : undefined);

  fields.push(geo('x', 'X', cur.x, 'px', 'x', 'left', scr('x')));
  fields.push(geo('y', 'Y', cur.y, 'px', 'y', 'top', scr('y')));
  fields.push({
    ...geo('w', '宽', cur.w, 'px', 'w', 'width', scr('w')),
    ...(scaled && !declared ? { source: 'override' } : {})
  });
  fields.push({
    ...geo('h', '高', cur.h, 'px', 'h', 'height', scr('h')),
    ...(scaled && !declared ? { source: 'override' } : {})
  });
  fields.push({
    ...geo('rotation', '旋转', cur.r, 'deg', 'r', 'rotate', scr('r')),
    ...(override?.r !== undefined && !declaredHas('r') ? { source: 'override' } : {})
  });

  /* ---- 排版 / 外观：override → 元素内联声明 → computed，同名键 ---- */
  const inlineStyle = /** @type {Record<string, string>} */ (described.inline || {});
  for (const def of STYLE_FIELDS) {
    /* R125 · M11-B：`object-fit` / `object-position` 只对**替换元素**有意义；
       给 <h1> 摆一个下拉是噪音（而且写了也不生效 → 假成功）。 */
    if (Array.isArray(def.onlyFor)) {
      const tag = String(described?.tag ?? '');
      if (!def.onlyFor.includes(tag)) continue;
    }
    const overridden = hasStyleKey(override, def.key);
    const inlineRaw = typeof inlineStyle[def.key] === 'string' ? inlineStyle[def.key] : '';
    /* R113 · L2：面板刚写、还没被 describe 证实的值优先（见 opts.pendingStyle 的说明）。 */
    const pendingRaw = opts.pendingStyle && typeof opts.pendingStyle[def.key] === 'string' ? opts.pendingStyle[def.key] : '';
    const raw = pendingRaw !== '' ? pendingRaw : overridden ? oStyle[def.key] : inlineRaw || style[def.key];
    /* `box-shadow` 一个通道两个语义：按 `inset` 前缀拆开，两行各显示自己那半边，
       提交时再合回去（`sibling` 就是另一半，见 patchForField）。 */
    let current = asText(raw);
    let sibling = '';
    if (def.shadowPart) {
      const split = /** @type {{inset: string[], outer: string[]}} */ (splitBoxShadow(current));
      const part = def.shadowPart === 'inset' ? split.inset : split.outer;
      current = part.join(', ') || (def.shadowPart === 'outer' ? 'none' : '');
      sibling = (def.shadowPart === 'inset' ? split.outer : split.inset).join(', ');
    }
    /* 裁切：四边拆成四个输入框；当前值不是合法的 inset 时四格留空并标 custom */
    const inset = def.control === 'inset' ? parseClipInset(current) : null;
    const spec = NUMERIC_STYLE_FIELDS[/** @type {keyof typeof NUMERIC_STYLE_FIELDS} */ (def.id)];
    const parsed = spec ? parseNumericValue(asText(raw)) : null;
    /* 下拉字段（S51）：把当前值对回预设，对不上就是「自定义」。
       比对走 `normalizeCssValue`——computed 会把 `blur( 4px )` 折成 `blur(4px)`，
       不归一化就会出现「明明选了预设却显示自定义」。 */
    const choice = def.control === 'select' ? describeChoice(def, asText(raw)) : null;
    fields.push({
      id: def.id,
      label: def.label,
      group: def.group,
      current,
      source: overridden || pendingRaw !== '' ? 'override' : 'computed',
      /* 值从哪儿来的（证据用）：override / inline（作者写的声明）/ computed */
      valueFrom: pendingRaw !== '' ? 'pending' : overridden ? 'override' : inlineRaw ? 'inline' : 'computed',
      ...(parsed
        ? {
            numeric: true,
            /* 面板输入框显示的数字（`normal`/空 时为空串） */
            display: parsed.kind === 'number' ? parsed.value : '',
            suffix: parsed.kind === 'number' ? parsed.suffix : '',
            emptyState: parsed.kind === 'normal' ? 'normal' : parsed.kind === 'empty' ? 'empty' : ''
          }
        : {}),
      ...(choice ? { control: 'select', options: choice.options, selected: choice.selected, custom: choice.custom, display: choice.display } : {}),
      ...(def.control === 'text' ? { control: 'text' } : {}),
      ...(def.control === 'inset'
        ? {
            control: 'inset',
            /* 四边当前值：合法 inset 就用解析结果，否则留空并标 custom（面板显示原文在 current 里） */
            parts: inset && inset.ok
              ? inset.parts
              : CLIP_INSET_PARTS.map((id) => ({ id, value: '', unit: 'px' })),
            unitValue: inset && inset.ok ? (inset.parts[0]?.unit ?? 'px') : 'px',
            custom: !(inset && inset.ok)
          }
        : {}),
      ...(sibling ? { sibling, /* 整条声明的原文（效果栈读内阴影时要它，不能只看外半边） */ whole: [current, sibling].filter(Boolean).join(', ') } : {}),
      editable,
      unit: def.unit,
      overrideKey: def.key,
      ...(locked ? { lockedReason: 'LAYER_LOCKED' } : {})
    });
  }

  /* ── R113 · L2：四角圆角 / 描边 / 调节五项 / 效果栈 / 混合模式能力矩阵 ──────────
   *
   * 这一段**只摆读数**：序列化规则全在 `inspector-adjust.mjs`（调色与效果）与
   * `patchForField`（四角/描边）。字段上的 `section` 让面板在同一组里画出小标题
   * （「外观」组里分 外观 / 描边 / 调节 / 效果 四段），**不改组的 id 与顺序**——
   * 组的形状是 `inspector-groups.ts` 与既有单测钉住的，这一批一个字节都不动。
   */
  /** 生效值：override → 元素内联 → computed（与上面排版/外观同一条优先顺序）。 */
  const eff = (/** @type {string} */ key) => {
    const pending = opts.pendingStyle && typeof opts.pendingStyle[key] === 'string' ? opts.pendingStyle[key] : '';
    if (pending !== '') return pending;
    if (hasStyleKey(override, key)) return asText(oStyle[key]);
    const inlineRaw = typeof inlineStyle[key] === 'string' ? inlineStyle[key] : '';
    if (inlineRaw !== '') return inlineRaw;
    return asText(style[key]);
  };

  /* 四角圆角：与「圆角」同一条 border-radius。有裁切时四角必须一致（否则裁切结果不可预期）。 */
  const corners = fields.find((field) => field.id === 'radiusCorners');
  if (corners) {
    const parsed = parseRadiusCorners(corners.current);
    corners.control = 'corners';
    corners.parts = CORNER_PARTS.map((part, index) => ({
      id: part.id,
      label: part.label,
      value: /** @type {string[]} */ (parsed.values)[index] ?? '0',
      unit: 'px'
    }));
    corners.custom = parsed.custom;
    corners.clipLinked = opts.clipped === true;
    corners.reason = corners.clipLinked
      ? '有裁切：四角必须一致（不一致的圆角 + 裁切结果不可预期），改一个角会同步四个角'
      : '四角各写一个值（border-radius: 左上 右上 右下 左下）';
  }

  /* 描边位置：由 outline-offset 与 outline-width 反推（offset = -w 内 / -w/2 中 / 0 外）。 */
  const outlinePos = fields.find((field) => field.id === 'outlinePosition');
  const outlineWidthNow = Number.parseFloat(eff('outline-width')) || 0;
  if (outlinePos) {
    const offsetNow = Number.parseFloat(eff('outline-offset')) || 0;
    const derived = outlineWidthNow <= 0
      ? 'outer'
      : offsetNow <= -outlineWidthNow + 0.01
        ? 'inner'
        : offsetNow <= -outlineWidthNow / 2 + 0.01
          ? 'center'
          : 'outer';
    outlinePos.current = derived;
    outlinePos.selected = derived;
    outlinePos.display = derived;
    outlinePos.custom = false;
    outlinePos.options = [
      { value: 'inner', label: '内（整条画在盒内）' },
      { value: 'center', label: '中（骑在边上）' },
      { value: 'outer', label: '外（整条画在盒外）' }
    ];
    outlinePos.clipped = opts.clipped === true;
  }
  for (const field of fields) {
    if (field.id !== 'outlineWidth' && field.id !== 'outlineColor' && field.id !== 'outlineStyle') continue;
    field.clipped = opts.clipped === true;
    field.section = '描边';
  }
  if (outlinePos) outlinePos.section = '描边';

  /* 效果栈：五个效果各一行，三态（absent / custom / mixed）分开写。 */
  const cssBase = {
    filter: eff('filter'),
    boxShadow: eff('box-shadow'),
    backdropFilter: eff('backdrop-filter'),
    maskImage: eff('mask-image'),
    /* R125 · M11-A：蒙版的参数行（唯一的真值，见 inspector-mask.mjs 文件头）。 */
    maskSpec: eff(MASK_PROP),
    /* R125 · M11-B：四角裁切 / 换源的参数行 + 它们各自的载体声明。 */
    cropSpec: eff(CROP_PROP),
    clipPath: eff('clip-path'),
    content: eff('content'),
    mediaSpec: eff(MEDIA_PROP)
  };
  /* R125 · M11-B：四角裁切 / 换源的**读数**（控件只读这几项；序列化不在这里）。 */
  const cropField = fields.find((field) => field.id === 'cropCorners');
  if (cropField) {
    cropField.cropSpec = eff(CROP_PROP);
    cropField.clipPathRaw = eff('clip-path');
    cropField.cropState = readCrop({ cropSpec: cropField.cropSpec, clipPath: cropField.clipPathRaw }).state;
    cropField.source = hasStyleKey(override, CROP_PROP) || hasStyleKey(override, 'clip-path') ? 'override' : 'computed';
  }
  const mediaField = fields.find((field) => field.id === 'mediaSrc');
  if (mediaField) {
    mediaField.mediaSpec = eff(MEDIA_PROP);
    mediaField.contentRaw = eff('content');
    const info = readMedia({ mediaSpec: mediaField.mediaSpec, content: mediaField.contentRaw });
    mediaField.mediaState = info.state;
    mediaField.source = hasStyleKey(override, MEDIA_PROP) ? 'override' : 'computed';
  }

  for (const def of EFFECT_DEFS) {
    const info = readEffect(cssBase, def.kind);
    const writesKey = def.writes;
    fields.push({
      id: def.id,
      label: def.label,
      group: 'appearance',
      section: '效果',
      current: info.state,
      unit: '无',
      control: 'effect',
      effectKind: def.kind,
      effectState: info.state,
      effectParams: info.params,
      effectCount: info.count,
      effectOrder: def.order,
      effectWrites: writesKey,
      effectNote: info.note,
      source: hasStyleKey(override, writesKey) ? 'override' : 'computed',
      /* 手写（custom）不给参数控件：只留「删除 / 重置」，绝不把看不懂的值当空值覆写。 */
      editable: editable && info.state !== 'custom',
      overrideKey: writesKey,
      ...(info.state === 'custom' ? { lockedReason: 'EFFECT_CUSTOM' } : {}),
      ...(locked ? { lockedReason: 'LAYER_LOCKED' } : {})
    });
  }

  /* R125 · M11-A（LI-A20/A21）：六类蒙版 —— 一行「蒙版」，控件里带形状选择 / 参数 / 画布。
     参数行 `--oc-mask` 是唯一真值（见 inspector-mask.mjs 文件头），这里只把读数摆成字段。 */
  const maskInfo = readMask({ maskSpec: cssBase.maskSpec, maskImage: cssBase.maskImage });
  const maskBox = described?.box && Number(described.box.w) > 0
    ? { w: Number(described.box.w), h: Number(described.box.h) }
    : null;
  fields.push({
    id: 'mask',
    label: '蒙版',
    group: 'appearance',
    section: '蒙版',
    current: maskInfo.state,
    unit: '无',
    control: 'mask',
    maskState: maskInfo.state,
    maskSpec: maskInfo.spec,
    maskForeign: maskInfo.foreign,
    maskNote: maskInfo.note,
    maskShapes: MASK_SHAPES,
    maskBox,
    source: hasStyleKey(override, MASK_PROP) ? 'override' : 'computed',
    editable,
    ...(maskInfo.state === 'custom' ? { lockedReason: 'MASK_CUSTOM' } : {}),
    ...(locked ? { lockedReason: 'LAYER_LOCKED' } : {})
  });

  /* 调节五项：调色的读数是**整条 filter**，五项各自一个滑杆；解析不了 → 整组「手写，请到高级」。 */
  const grade = gradeFromFilter(cssBase.filter);
  for (const spec of GRADE_SPECS) {
    const value = grade.ok === true ? grade.values[spec.id] ?? null : null;
    const mixedHere = grade.ok === true && (grade.mixedFields ?? []).includes(spec.label);
    const custom = grade.ok !== true || grade.custom === true || mixedHere;
    fields.push({
      id: spec.id,
      label: spec.label,
      group: 'appearance',
      section: '调节',
      current: value === null ? '' : value,
      display: value === null ? '' : value,
      numeric: true,
      control: 'grade',
      gradeMin: spec.min,
      gradeMax: spec.max,
      step: 1,
      unit: '无',
      source: hasStyleKey(override, 'filter') ? 'override' : 'computed',
      overrideKey: 'filter',
      gradeCustom: custom,
      gradeMixed: mixedHere,
      reason: custom
        ? (grade.reason || '这一段 filter 是手写的（解析不了），调色不改它：请到「滤镜」里改原文')
        : `改 filter 里的 ${spec.fn}()：零值删函数，其他函数与顺序不动，插在 drop-shadow 之前`,
      editable: editable && !custom,
      ...(custom ? { lockedReason: 'FILTER_CUSTOM' } : {}),
      ...(locked ? { lockedReason: 'LAYER_LOCKED' } : {})
    });
  }

  /* 混合模式：17 项能力矩阵（浏览器支持 → 真实可见；不支持 → 仅透传并标明）。 */
  const blend = fields.find((field) => field.id === 'mixBlendMode');
  if (blend) {
    const matrix = blendMatrix(opts.supports);
    blend.matrix = matrix;
    /** @type {any[]} */
    const options = matrix.map((item) => ({
      value: item.mode,
      label: item.capability === 'passthrough' ? `${item.label}（仅透传）` : item.label,
      disabled: !item.supported,
      capability: item.capability,
      note: item.note
    }));
    const selected = String(blend.selected ?? '');
    if (selected !== '' && !options.some((option) => option.value === selected)) {
      /* 作者写了 17 种之外的值：保留原文（别静默改成 normal），标成未知。 */
      options.push({ value: selected, label: `${selected}（不在 17 种里）`, disabled: false, capability: 'passthrough', note: '不在参考的 17 种里' });
    }
    blend.options = options;
  }

  /* 字体：缺字体只提示（describe 的 fontCheck），不改用户写的值。 */
  const fontField = fields.find((field) => field.id === 'fontFamily');
  if (fontField && opts.fontCheck) fontField.fontCheck = opts.fontCheck;

  const groups = GROUP_ORDER.map((id) => ({
    id,
    label: GROUP_LABEL[id],
    fields: fields.filter((f) => f.group === id)
  })).filter((g) => g.fields.length > 0);

  /* R121 · M7-B：页签视图（每个字段恰好一页）。 */
  const tabs = withTabs(fields);

  return {
    mode: 'single',
    ref,
    locked,
    groups,
    tabs,
    fields,
    /* R113 · L2：效果栈与调色的**底座原文**（面板提交时原样带着走，见 effectPatch/filterWithGrade）。 */
    adjust: { css: cssBase, grade, effects: EFFECT_DEFS.map((def) => ({ kind: def.kind, ...readEffect(cssBase, def.kind) })) }
  };
}

/**
 * 多选模型（S26）。
 *
 * 两种入参：
 * 1. **只给 ref 数组**（R7 起的旧签名）→ 返回 `{mode:'multi', note:'不支持多选编辑', fields:[]}`，
 *    一个字节都不改旧行为（`inspector.test.mjs` 的 S3-A1 还在断言这个形状）；
 * 2. **给 `{ref, override, described, declaredBox, baseBox, geometry, locked}`**（面板 `selectMany` 用）
 *    → 返回真正的多选模型：共同字段 + `mixed` 标记 + 不可编辑原因码。
 *
 * 多选的判定（写死，别在面板里另写一份）：
 *
 * | 情况 | 结果 |
 * |---|---|
 * | 各层显示值全相同 | `current` = 那个值，`mixed:false` |
 * | 值不同 | `current:''`、`mixed:true`、`values:[…]`（**绝不**拿第一层的值冒充共同值） |
 * | 某层缺这个字段 | `FIELD_UNSUPPORTED` |
 * | 内容是 `text` 但某层没有文本 | `FIELD_UNSUPPORTED` |
 * | 旋转字段值不同 | `MULTI_MIXED`（多选下角度不一致不给改：每层各转各的才是本意） |
 * | 任一层锁定 | `LOCKED` |
 * | 宿主没给批量提交口 | `NO_COMMITTER` |
 *
 * 其余几何/排版/外观字段即使 `mixed` 也可编辑（改一个值套到所有层）——A2 就是这条。
 *
 * @param {readonly any[]} items
 * @param {{boxEditable?: boolean, commitManyAvailable?: boolean}} [opts]
 */
export function buildMultiInspector(items, opts = {}) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  /* 旧签名：纯 ref 数组（有 at、没有 described）→ 老形状，不做多选编辑 */
  /** @param {any} item */
  const looksLikeRef = (item) => !!item && !item.described && (typeof item.at === 'string' || !!item.ref);
  if (list.length > 0 && list.every(looksLikeRef)) {
    return {
      mode: 'multi',
      count: list.length,
      refs: list.map((item) => item.ref ?? item),
      locked: false,
      groups: [],
      fields: [],
      note: '不支持多选编辑'
    };
  }

  const models = list.map((item) => ({
    item,
    model: buildInspector(item.ref, item.override, item.described, {
      box: item.declaredBox,
      baseBox: item.baseBox,
      boxEditable: opts.boxEditable !== false,
      geometry: item.geometry && item.geometry.ok === true ? item.geometry : null,
      locked: item.locked === true
    })
  }));

  const anyLocked = models.some((entry) => entry.model.locked);
  const boxCommitter = opts.boxEditable !== false;
  const multiCommitter = opts.commitManyAvailable !== false;
  /** @param {any} entry */
  const hasText = (entry) => {
    const described = entry.item.described;
    return !!(described && typeof described.text === 'string' && described.text !== '');
  };

  /** 字段 id 按首次出现的顺序收集（各层 buildInspector 的字段集合可能不同）。 */
  /** @type {string[]} */
  const ids = [];
  /** @type {Map<string, any[]>} */
  const byId = new Map();
  for (const entry of models) {
    for (const field of entry.model.fields) {
      if (!byId.has(field.id)) {
        byId.set(field.id, []);
        ids.push(field.id);
      }
      /** @type {any[]} */ (byId.get(field.id)).push({ field, entry });
    }
  }

  /** @type {any[]} */
  const fields = [];
  for (const id of ids) {
    const entries = /** @type {any[]} */ (byId.get(id));
    const base = entries[0].field;
    const presentInAll = entries.length === models.length;
    const values = entries.map((entry) => {
      const value = entry.field.display !== undefined ? entry.field.display : entry.field.current;
      return value;
    });
    const equal = values.every((value) => {
      const first = values[0];
      if (typeof value === 'number' || typeof first === 'number') return Number(value) === Number(first);
      return String(value) === String(first);
    });

    let editable = true;
    /** @type {string} */
    let reason = '';
    if (!presentInAll) {
      editable = false;
      reason = 'FIELD_UNSUPPORTED';
    } else if (base.id === 'text' && !models.every(hasText)) {
      editable = false;
      reason = 'FIELD_UNSUPPORTED';
    } else if (base.kind === 'box' && base.boxKey === 'r' && !equal) {
      /* 角度不一致：不批量改（每层自己的角度是内容的一部分） */
      editable = false;
      reason = 'MULTI_MIXED';
    } else if (anyLocked) {
      editable = false;
      reason = 'LOCKED';
    } else if (base.kind === 'box' && !boxCommitter) {
      editable = false;
      reason = 'NO_COMMITTER';
    } else if (base.kind !== 'box' && !multiCommitter) {
      editable = false;
      reason = 'NO_COMMITTER';
    }

    fields.push({
      ...base,
      current: equal ? base.current : '',
      display: equal ? (base.display !== undefined ? base.display : base.current) : '',
      source: equal ? base.source : 'computed',
      /* 多选且值不同：裁切的四格要留空（拿第一层的值冒充是错的） */
      ...(base.parts && !equal ? { parts: base.parts.map((/** @type {any} */ part) => ({ ...part, value: '' })) } : {}),
      mixed: !equal,
      values,
      editable,
      ...(editable ? {} : { lockedReason: reason })
    });
  }

  const groups = GROUP_ORDER.map((id) => ({
    id,
    label: GROUP_LABEL[id],
    fields: fields.filter((field) => field.group === id)
  })).filter((group) => group.fields.length > 0);

  const tabs = withTabs(fields);

  return {
    mode: 'multi',
    count: list.length,
    refs: list.map((item) => item.ref),
    locked: anyLocked,
    groups,
    tabs,
    fields,
    mixedCount: fields.filter((field) => field.mixed).length,
    note: ''
  };
}

/* ── 位置尺寸：字段 id ↔ film-core `box` 的数字键 ↔ 片段 style 声明 ──────────
 *
 * film-core 的 `set` 只认 `box: {x, y, w, h, r?}`（`packages/film-core/ops.mjs` 的
 * `applyProp('box', …)`），写回时由 `styleText()` 展开成
 * `left/top/width/height/rotate`（`packages/film-core/film-doc.mjs`）。
 * 所以字段 id 保持面板既有的 `x/y/w/h/rotation`，`boxKey` 是提交用的键，
 * `styleProp` 是它在 `style` 里的名字——三者同名不同层，别混。
 */
export const BOX_FIELD_MAP = Object.freeze({
  x: Object.freeze({ boxKey: 'x', styleProp: 'left', unit: 'px' }),
  y: Object.freeze({ boxKey: 'y', styleProp: 'top', unit: 'px' }),
  w: Object.freeze({ boxKey: 'w', styleProp: 'width', unit: 'px' }),
  h: Object.freeze({ boxKey: 'h', styleProp: 'height', unit: 'px' }),
  rotation: Object.freeze({ boxKey: 'r', styleProp: 'rotate', unit: 'deg' })
});

/** 几何组（走 box 提交）的字段 id。 */
export const BOX_FIELDS = Object.freeze(Object.keys(BOX_FIELD_MAP));

/**
 * 把 describe().box（`{x,y,w,h,rotation}`）或片段声明（`{x,y,w,h,r}`）归一成 box 提交形状。
 * 缺 `w/h` 或非正数时给出 `null`——调用方必须先拿到一个能用的基准框。
 * @param {any} source
 * @returns {{x: number, y: number, w: number, h: number, r?: number} | null}
 */
export function normalizeBox(source) {
  if (!source || typeof source !== 'object') return null;
  const x = Number(source.x ?? 0);
  const y = Number(source.y ?? 0);
  const w = Number(source.w);
  const h = Number(source.h);
  if (![x, y, w, h].every((n) => Number.isFinite(n)) || w <= 0 || h <= 0) return null;
  /** @type {{x: number, y: number, w: number, h: number, r?: number}} */
  const box = { x, y, w, h };
  const r = source.r !== undefined && source.r !== null ? Number(source.r) : Number(source.rotation);
  /* r=0 与「没有 rotate 声明」在 film-core 里是同一个状态（写回时 0 不产生声明，
     回读也拿不到 0），所以基准框里不保留 0，免得提交一个回读对不上的值。 */
  if (Number.isFinite(r) && r !== 0) box.r = r;
  return box;
}

/**
 * 几何字段 → 一个 `set` Op（`field:'box'`）。**不写盘**，只产请求体。
 *
 * 语义（按 film-core 实现，见 CAPABILITY.md §9）：
 * - `box` 是**整体替换**，不是合并：x/y/w/h 必须齐（缺的会被 film-core 当 0 或直接报错），
 *   所以每次都带上基准框里的另外三个值；`r` 只在真的设了的时候才放。
 * - 清空 `rotate`（或设成 0）→ `value` 里不带 `r` → film-core 写回时该声明消失（不是 `0deg`）。
 * - 清空 `left`/`top` → 只能落到 `0`（`styleText` 总会写 left/top），不是删除声明。
 * - 清空 `width`/`height` → 拒绝：film-core 要求 w/h > 0。
 *
 * @param {string} fieldId
 * @param {string|number} value 空串 = 清空
 * @param {any} baseBox 基准框（normalizeBox 的入参）
 * @returns {{op: {op: 'set', field: 'box', value: {x: number, y: number, w: number, h: number, r?: number}}} | {error: {code: string, message: string}}}
 */
export function patchForBox(fieldId, value, baseBox) {
  const map = BOX_FIELD_MAP[/** @type {keyof typeof BOX_FIELD_MAP} */ (fieldId)];
  if (!map) return { error: { code: 'NOT_EDITABLE', message: `不是几何字段：${fieldId}` } };

  const base = normalizeBox(baseBox);
  if (!base) {
    return {
      error: {
        code: 'NO_BASE_BOX',
        message: `字段 ${fieldId} 缺少可用的基准框（需要 x/y/w/h 且宽高大于 0）`
      }
    };
  }

  /** @type {{x: number, y: number, w: number, h: number, r?: number}} */
  const next = { ...base };
  const text = String(value ?? '').trim();
  const key = map.boxKey;

  if (text === '') {
    if (key === 'r') delete next.r;
    else if (key === 'w' || key === 'h') {
      return { error: { code: 'INVALID', message: `${map.styleProp} 不能清空：宽高必须大于 0` } };
    } else next[key] = 0;
  } else {
    const n = Number(text);
    if (!Number.isFinite(n)) {
      return { error: { code: 'INVALID', message: `${map.styleProp} 必须是数值：${text}` } };
    }
    if ((key === 'w' || key === 'h') && n <= 0) {
      return { error: { code: 'INVALID', message: `${map.styleProp} 必须大于 0` } };
    }
    next[key] = n;
  }
  /* 角度设成 0 = 没有这条声明：和清空等价（film-core 写 0 时本来也不落声明）。 */
  if (key === 'r' && next.r === 0) delete next.r;

  /** @type {{x: number, y: number, w: number, h: number, r?: number}} */
  const boxValue = { x: next.x, y: next.y, w: next.w, h: next.h };
  if (next.r !== undefined && Number.isFinite(next.r)) boxValue.r = next.r;
  return { op: { op: 'set', field: 'box', value: boxValue } };
}

/**
 * 数值型排版字段 → 最小 OverridePatch（S16）。
 *
 * 单位规则：输入里写了单位就用写的；没写就沿用**当前值的单位**（`opts.suffix`），
 * 再没有才用字段默认（`fontSize` → `px`，`lineHeight` → 无单位）。
 * 这样 `48px → 60` 写回 `60px`，`1.4 → 1.5` 写回 `1.5`，不会把倍数烘成像素。
 *
 * @param {string} fieldId
 * @param {string} text 用户输入
 * @param {{key: string, label: string, min?: number, exclusiveMin?: boolean, max?: number, defaultUnit: string, allowNormal: boolean, allowPercent?: boolean}} spec
 * @param {{suffix?: string}} opts
 * @returns {{patch: OverridePatch} | {error: {code: string, message: string}}}
 */
function numericPatch(fieldId, text, spec, opts = {}) {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { error: { code: 'INVALID_VALUE', message: `${spec.label}需要一个数值（空值/normal 不写盘）` } };
  }
  const parsed = parseNumericValue(trimmed);
  if (parsed.kind === 'error') {
    return { error: { code: 'INVALID_VALUE', message: parsed.message } };
  }
  if (parsed.kind === 'normal') {
    if (!spec.allowNormal) return { error: { code: 'INVALID_VALUE', message: `${spec.label}不接受 normal` } };
    return { patch: { style: { [spec.key]: 'normal' } } };
  }
  if (parsed.kind !== 'number') {
    return { error: { code: 'INVALID_VALUE', message: `${spec.label}读不出数值：${trimmed}` } };
  }

  const value = parsed.value;
  /* S51：圆角这类字段不接受百分比。`parseNumericValue` 会把 `50%` 读成「50 + %」，
     默认逻辑会照写成 `50%`——那在圆角上是另一个形状，必须在这里挡住。 */
  if (spec.allowPercent === false && parsed.suffix === '%') {
    return { error: { code: 'INVALID_VALUE', message: `${spec.label}不接受百分比（收到 ${trimmed}）` } };
  }
  if (spec.min !== undefined) {
    const bad = spec.exclusiveMin === true ? value <= spec.min : value < spec.min;
    if (bad) {
      return {
        error: {
          code: 'INVALID_VALUE',
          message: `${spec.label}必须${spec.exclusiveMin === true ? '大于' : '不小于'} ${spec.min}（收到 ${value}）`
        }
      };
    }
  }
  if (spec.max !== undefined && value > spec.max) {
    return { error: { code: 'INVALID_VALUE', message: `${spec.label}不能大于 ${spec.max}（收到 ${value}）` } };
  }

  const unit = parsed.suffix || opts.suffix || spec.defaultUnit || '';
  void fieldId;
  return { patch: { style: { [spec.key]: `${value}${unit}` } } };
}

/**
 * 由一个**完整的声明 box** 建 `set` Op（S15：屏幕值换算回声明值之后走这里）。
 * 与 `patchForBox` 共用同一套校验（w/h > 0、r=0 不落声明）。
 * @param {any} box `{x,y,w,h,r?}`
 * @returns {{op: {op: 'set', field: 'box', value: {x: number, y: number, w: number, h: number, r?: number}}} | {error: {code: string, message: string}}}
 */
export function patchForBoxValue(box) {
  const norm = normalizeBox(box);
  if (!norm) {
    return { error: { code: 'NO_BASE_BOX', message: 'box 需要 x/y/w/h 且宽高大于 0' } };
  }
  /** @type {{x: number, y: number, w: number, h: number, r?: number}} */
  const value = { x: norm.x, y: norm.y, w: norm.w, h: norm.h };
  if (norm.r !== undefined && Number.isFinite(norm.r)) value.r = norm.r;
  return { op: { op: 'set', field: 'box', value } };
}

/**
 * 字段 id → 最小 OverridePatch。只含用户改的这一个键。
 *
 * 几何字段（x/y/w/h）在这里**刻意不给 patch**：`s`/`r` 覆盖表达不了位置与尺寸，
 * 面板走的是 `patchForBox` + `set` op。要程序化改几何，用 `patchForBox`。
 *
 * @param {string} fieldId
 * @param {string|number} value
 * @param {{suffix?: string, box?: {w?: number, h?: number}, other?: string,
 *   base?: {filter?: string}, clipped?: boolean, outline?: {width?: number, position?: string}}} [opts]
 *   `box`：裁切算「四边合计超盒」用；`other`：box-shadow 的另一半（内/外），提交时合回一条；
 *   `base`：调色五项要重写的那条 filter 原文（override → inline → computed）；
 *   `clipped`：元素当前有裁切（四角必须一致、外描边可能被裁）；
 *   `outline`：当前描边粗细/位置（改位置/粗细时一起算 outline-offset）。
 * @returns {{patch: OverridePatch} | {error: {code: string, message: string, at?: string}}}
 */
export function patchForField(fieldId, value, opts = {}) {
  const text = String(value);

  /* ── R113 · L2：文本排版补链 / 四角圆角 / 描边 / 调色五项 ───────────────────
   *
   * 这一组必须在 `numericSpec` 之前：`outlineWidth` 也在 NUMERIC_STYLE_FIELDS 里，
   * 但它要**顺带**按位置重算 `outline-offset`（否则改粗细会把「内」变成「外」）。
   */
  const gradeSpec = GRADE_SPECS.find((item) => item.id === fieldId);
  if (gradeSpec !== undefined) {
    const base = String(opts.base?.filter ?? '');
    const built = filterWithGrade(base, fieldId, value);
    if (built.ok !== true) return { error: built.error };
    if (built.unchanged === true) return { patch: { style: {} } };
    return {
      patch: { style: { filter: built.value } },
      ...(built.note === undefined ? {} : { note: built.note })
    };
  }

  if (fieldId === 'fontFamily') {
    const family = text.replace(/\s+/g, ' ').trim();
    if (family === '') return { patch: { style: { 'font-family': 'inherit' } } };
    if (family.length > 200) return { error: { code: 'INVALID_VALUE', message: `字体名太长（${family.length} 字符，上限 200）` } };
    if (/[;{}<>]/.test(family)) {
      return { error: { code: 'INVALID_VALUE', message: `字体名不能含 ; { } < >：${family}` } };
    }
    if (!/^[A-Za-z0-9\u4e00-\u9fff ,.'"_-]+$/.test(family)) {
      return { error: { code: 'INVALID_VALUE', message: `字体名有不认识的字符：${family}` } };
    }
    return { patch: { style: { 'font-family': family } } };
  }

  /** @type {Record<string, readonly string[]>} */
  const enums = {
    fontStyle: ['normal', 'italic', 'oblique'],
    textTransform: ['none', 'uppercase', 'lowercase', 'capitalize'],
    textDecoration: ['none', 'underline', 'line-through', 'overline'],
    textDecorationStyle: ['solid', 'dashed', 'dotted', 'wavy'],
    outlineStyle: ['solid', 'dashed', 'dotted']
  };
  const allowedEnum = enums[fieldId];
  if (allowedEnum !== undefined) {
    const picked = normalizeCssValue(text);
    if (!allowedEnum.includes(picked)) {
      return {
        error: { code: 'INVALID_VALUE', message: `${fieldId} 只接受 ${allowedEnum.join(' / ')}（收到「${text.trim() || '空'}」）` }
      };
    }
    const key = STYLE_FIELDS.find((def) => def.id === fieldId)?.key ?? fieldId;
    return { patch: { style: { [key]: picked } } };
  }

  if (fieldId === 'radiusCorners') {
    const parts = text.trim().split(/\s+/).filter(Boolean);
    if (parts.length !== 4) {
      return { error: { code: 'INVALID_VALUE', message: `四角要给四个值（左上 右上 右下 左下），收到 ${parts.length} 个` } };
    }
    /** @type {number[]} */
    const numbers = [];
    for (const part of parts) {
      const n = Number(part);
      if (!Number.isFinite(n) || n < 0) {
        return { error: { code: 'INVALID_VALUE', message: `圆角必须是非负数：${part}` } };
      }
      if (n > BORDER_RADIUS_MAX) {
        return { error: { code: 'INVALID_VALUE', message: `圆角不能大于 ${BORDER_RADIUS_MAX}px（收到 ${n}）` } };
      }
      numbers.push(Math.round(n * 100) / 100);
    }
    if (opts.clipped === true) {
      const first = numbers[0];
      if (!numbers.every((n) => Math.abs(n - Number(first)) < 0.01)) {
        return {
          error: {
            code: 'RADIUS_LINKED_BY_CLIP',
            message: '这个元素有裁切（clip-path / overflow）：四角必须一致，否则裁切结果不可预期'
          }
        };
      }
    }
    return { patch: { style: { 'border-radius': numbers.map((n) => `${n}px`).join(' ') } } };
  }

  /* 描边：outline 系列（不占布局）。位置是 outline-offset 的函数，改粗细/位置都要一起算。 */
  if (fieldId === 'outlinePosition') {
    const position = normalizeCssValue(text);
    if (!['inner', 'center', 'outer'].includes(position)) {
      return { error: { code: 'INVALID_VALUE', message: `描边位置只接受 内 / 中 / 外（收到「${text.trim()}」）` } };
    }
    const width = Number(opts.outline?.width ?? 0);
    if (!(width > 0)) {
      return {
        error: { code: 'INVALID_VALUE', message: '描边粗细是 0：先把「描边粗细」设成大于 0，位置才有意义' }
      };
    }
    const offset = position === 'inner' ? -width : position === 'center' ? -width / 2 : 0;
    return { patch: { style: { 'outline-offset': `${Math.round(offset * 100) / 100}px` } } };
  }
  if (fieldId === 'outlineWidth') {
    const width = Number(text);
    if (!Number.isFinite(width) || width < 0 || width > 50) {
      return { error: { code: 'INVALID_VALUE', message: `描边粗细必须在 0..50px（收到「${text.trim() || '空'}」）` } };
    }
    const position = String(opts.outline?.position ?? 'outer');
    const offset = position === 'inner' ? -width : position === 'center' ? -width / 2 : 0;
    return {
      patch: { style: { 'outline-width': `${Math.round(width * 100) / 100}px`, 'outline-offset': `${Math.round(offset * 100) / 100}px` } }
    };
  }
  if (fieldId === 'outlineColor') {
    const color = text.trim();
    if (!isCssColor(color)) {
      return { error: { code: 'INVALID_VALUE', message: `描边色只接受 CSS 颜色（#rgb / #rrggbb / rgba(…) / 颜色名），收到「${color}」` } };
    }
    return { patch: { style: { 'outline-color': color } } };
  }

  const numericSpec = NUMERIC_STYLE_FIELDS[/** @type {keyof typeof NUMERIC_STYLE_FIELDS} */ (fieldId)];
  if (numericSpec) return numericPatch(fieldId, text, numericSpec, opts);

  /* ── 效果字段（S51）：四个非数值键 ─────────────────────────────────── */
  if (fieldId === 'filter' || fieldId === 'backdropFilter') {
    const label = fieldId === 'filter' ? '滤镜' : '背景模糊';
    if (text.trim() === CUSTOM_OPTION) {
      return { error: { code: 'INVALID_VALUE', message: `${label}选「自定义」时要填具体写法（例如 blur(5px)）` } };
    }
    const checked = parseFilterList(text, { label, allow: fieldId === 'filter' ? FILTER_FUNCS : BACKDROP_FUNCS });
    if (!checked.ok) return { error: checked.error };
    return { patch: { style: { [fieldId === 'filter' ? 'filter' : 'backdrop-filter']: checked.value } } };
  }
  if (fieldId === 'mixBlendMode') {
    const mode = normalizeCssValue(text);
    if (!BLEND_MODES.includes(/** @type {any} */ (mode))) {
      return {
        error: {
          code: 'INVALID_VALUE',
          message: `混合模式只接受 ${BLEND_MODES.join(' / ')}（收到 ${text.trim() || '空'}）`
        }
      };
    }
    return { patch: { style: { 'mix-blend-mode': mode } } };
  }
  if (fieldId === 'boxShadow' || fieldId === 'boxShadowInset') {
    const isInset = fieldId === 'boxShadowInset';
    const label = isInset ? '内阴影' : '盒子阴影';
    const shadow = text.trim();
    const other = String(opts.other ?? '').trim();
    const otherNone = other === '' || /^none$/i.test(other);
    /* 空串 = 这一半不要了（与 `filter` 的 `none` 同义；写一串空值浏览器会整条忽略） */
    if (shadow === '') return { patch: { style: { 'box-shadow': otherNone ? 'none' : other } } };
    if (/[;{}<>]/.test(shadow)) {
      return { error: { code: 'INVALID_VALUE', message: `${label}不能含 ; { } < >：${shadow}` } };
    }
    if (isInset && !/^inset\b/i.test(shadow)) {
      return { error: { code: 'INVALID_VALUE', message: `内阴影必须以 inset 开头（收到「${shadow}」）；外阴影请用「盒子阴影」` } };
    }
    if (!isInset && /^inset\b/i.test(shadow)) {
      return { error: { code: 'INVALID_VALUE', message: `「盒子阴影」收外阴影，内阴影请用「内阴影」字段` } };
    }
    const combined = `${shadow.replace(/\s+/g, ' ')}${otherNone ? '' : `, ${other}`}`;
    return { patch: { style: { 'box-shadow': combined } } };
  }
  if (fieldId === 'clipPath') {
    const checked = parseClipInset(text, { box: opts.box });
    if (!checked.ok) return { error: checked.error };
    return { patch: { style: { 'clip-path': checked.value } } };
  }
  if (fieldId === 'backgroundImage') {
    const checked = parseBackgroundImage(text);
    if (!checked.ok) return { error: checked.error };
    return { patch: { style: { 'background-image': checked.value } } };
  }
  if (fieldId === 'backgroundSize' || fieldId === 'backgroundPosition') {
    const label = fieldId === 'backgroundSize' ? '背景图尺寸' : '背景图位置';
    const allowed = fieldId === 'backgroundSize' ? BACKGROUND_SIZES : BACKGROUND_POSITIONS;
    const value = normalizeCssValue(text);
    if (!allowed.includes(/** @type {any} */ (value))) {
      return {
        error: { code: 'INVALID_VALUE', message: `${label}只接受 ${allowed.join(' / ')}（收到 ${text.trim() || '空'}）` }
      };
    }
    return { patch: { style: { [fieldId === 'backgroundSize' ? 'background-size' : 'background-position']: value } } };
  }

  /* ── 文本样式四项（E12-P3 B5 · R38）────────────────────────────────────
     `stroke` / `bg` / `align` / `tracking` 是 **OverrideEntry** 上的键
     （`film-core/text-style.mjs` 的 `TEXT_STYLE_KEYS`），不在 `OverridePatch` 契约里 ——
     和 `kf` 一样按 any 写，**不改契约、也不塞进 `fields` 白名单**。
     空串 = 去掉这一项：返回 `{ [key]: null }`，由 `mergeOverride` 的 null 语义删键；
     `validateTextStyle()` 不接受 null，所以 null 绝不能提交给服务端（合并层会消化）。
     取值域复用 `isCssColor` / `TEXT_ALIGNS`：面板放行的写法与服务端校验同一个来源。 */
  if (fieldId === 'stroke' || fieldId === 'bg') {
    const label = fieldId === 'stroke' ? '描边' : '底框';
    const value = text.trim();
    /** @type {any} */
    const patch = {};
    if (value === '') {
      patch[fieldId] = null;
      return { patch };
    }
    if (!isCssColor(value)) {
      return { error: { code: 'INVALID_VALUE', message: `${label}只接受 CSS 颜色（#rgb / #rrggbb / rgba(…) / 颜色名），收到「${value}」` } };
    }
    patch[fieldId] = { color: value };
    return { patch };
  }
  if (fieldId === 'align') {
    const value = text.trim();
    if (!TEXT_ALIGNS.includes(/** @type {any} */ (value))) {
      return { error: { code: 'INVALID_VALUE', message: `对齐只接受 ${TEXT_ALIGNS.join(' / ')}（收到「${value || '空'}」）` } };
    }
    /** @type {any} */
    const patch = { align: value };
    return { patch };
  }
  if (fieldId === 'tracking') {
    /* 与 `validateTextStyle()` 的 −50…400 一致（超出会被服务端 `TRACKING_INVALID` 拒）。 */
    const value = Number(text);
    if (!Number.isFinite(value) || value < -50 || value > 400) {
      return { error: { code: 'INVALID_VALUE', message: `字距必须在 −50…400（px），收到「${text.trim() || '空'}」` } };
    }
    /** @type {any} */
    const patch = { tracking: value };
    return { patch };
  }

  /** @type {Record<string, OverridePatch>} */
  const literal = {
    text: { t: text },
    rotation: { r: num(text) },
    strokeWidth: { style: { '-webkit-text-stroke-width': `${num(text)}px` } },
    strokeColor: { style: { '-webkit-text-stroke-color': text } }
  };
  const fixed = literal[fieldId];
  if (fixed) return { patch: fixed };

  if (fieldId === 'x' || fieldId === 'y' || fieldId === 'w' || fieldId === 'h') {
    return {
      error: {
        code: 'NOT_EDITABLE',
        message: `字段 ${fieldId} 需要一个基准框才能换算成覆盖；请先用几何编辑入口`,
        at: undefined
      }
    };
  }

  const def = STYLE_FIELDS.find((d) => d.id === fieldId);
  if (!def) {
    return { error: { code: 'NOT_EDITABLE', message: `未知检查器字段：${fieldId}` } };
  }
  const cssValue = def.unit === 'px' && !/[a-z%]$/i.test(text) ? `${num(text)}px` : text;
  return { patch: { style: { [def.key]: cssValue } } };
}
