// @ts-nocheck -- Heterogeneous catalog JSON is validated by scene/domain tests.
/** Independently authored catalog. No reference-product code, images or sound is bundled. */
import { MOTION_TEMPLATES } from './creation-motion-templates.mjs';

export const LIBRARY_CATEGORIES = Object.freeze(['media', 'skill', 'template', 'captions', 'voice', 'sound', 'music', 'text', 'sticker', 'filter', 'effect', 'transition']);
const COMMON = Object.freeze({
  title: { type: 'string', label: '主标题', default: '把想法变成画面' },
  subtitle: { type: 'string', label: '说明', default: '可编辑的原创网页场景' },
  accent: { type: 'string', label: '强调色', default: '#55d6c2' },
  color: { type: 'string', label: '文字颜色', default: '#f6f7fb' },
  fontSize: { type: 'number', label: '字号', default: 72, min: 20, max: 180 },
  duration: { type: 'number', label: '时长（秒）', default: 6, min: 0.1, max: 600 },
});
const rows = [];
function add(category, group, variants) {
  for (const [variant, name, extra = {}] of variants) {
    const schema = category === 'effect' ? { duration: COMMON.duration } : category === 'sticker' ? Object.fromEntries(Object.entries(COMMON).filter(([key]) => key !== 'subtitle')) : COMMON;
    rows.push(Object.freeze({
    id: `builtin:${category}-${variant}`, name, category, group, source: 'builtin', kind: category === 'filter' ? 'filter' : 'page',
    mediaKind: 'page', variant, durationSec: 6, tags: [category, group, '原创', 'HTML', '可编辑'],
    paramSchema: schema, params: Object.fromEntries(Object.entries(schema).map(([key, spec]) => [key, spec.default])), ...extra,
    }));
  }
}
add('text', '基本文本', [['basic', '清晰标题'], ['underline', '划线强调'], ['outline', '轮廓大字'], ['gradient', '渐变字卡'], ['badge', '胶囊文字'], ['editorial', '杂志标题'], ['kinetic', '逐字揭示'], ['lower', '人物名牌'], ['stack', '纵向关键词']]);
add('template', '信息场景', [['title', '片头标题'], ['talk', '口播信息卡'], ['chart', '柱状图表'], ['steps', '操作步骤'], ['data', '数据看板'], ['picture', '图片解说'], ['caption', '重点字幕卡'], ['quote', '引语观点']]);
for (const { variant, name, title, subtitle, accent, color, fields } of MOTION_TEMPLATES) {
  const paramSchema = {
    ...COMMON, title: { ...COMMON.title, default: title }, subtitle: { ...COMMON.subtitle, default: subtitle },
    accent: { ...COMMON.accent, type: 'color', default: accent }, color: { ...COMMON.color, type: 'color', default: color },
    ...fields,
  };
  add('template', '动态图形', [[variant, name, {
    paramSchema, params: Object.fromEntries(Object.entries(paramSchema).map(([key, spec]) => [key, spec.default])),
    tags: ['template', '动态图形', '原创', 'HTML', '可编辑', '动效'],
  }]]);
}
add('sticker', '形状标注', [['arrow', '方向标记'], ['ring', '聚焦圆环'], ['highlight', '重点框选'], ['pin', '定位标签'], ['check', '完成标记'], ['cross', '排除标记'], ['bubble', '对话气泡'], ['bracket', '注释括号'], ['number', '步骤序号'], ['spark', '亮点标注']]);
add('effect', '透明叠加', [['glow', '柔和光晕'], ['grain', '细微颗粒'], ['scan', '扫描线'], ['vignette', '柔暗四角'], ['confetti', '庆祝彩片'], ['grid', '科技网格'], ['light', '斜向光束'], ['pulse', '呼吸边框']]);
const FILTERS = [
  ['clean', '清晰通透', 'contrast(1.08) saturate(1.08)'], ['warm', '暖色时光', 'sepia(.18) saturate(1.12)'],
  ['cool', '冷静蓝调', 'hue-rotate(12deg) saturate(.86)'], ['mono', '经典黑白', 'grayscale(1) contrast(1.12)'],
  ['soft', '柔和低对比', 'contrast(.88) brightness(1.06)'], ['vivid', '鲜活色彩', 'saturate(1.45) contrast(1.05)'],
  ['faded', '褪色胶片', 'sepia(.22) contrast(.9) saturate(.75)'], ['night', '沉静夜色', 'brightness(.72) saturate(.8)'],
  ['bright', '明亮轻盈', 'brightness(1.15) contrast(.96)'], ['dramatic', '戏剧质感', 'contrast(1.3) saturate(.7)'],
];
add('filter', '画面调色', FILTERS.map(([id, name, filter]) => [id, name, { filter, paramSchema: { duration: COMMON.duration, intensity: { type: 'number', label: '强度', default: 1, min: 0, max: 1 } }, params: { duration: 6, intensity: 1 } }]));
export const ORIGINAL_CATALOG = Object.freeze(rows);
export const catalogItem = (id) => ORIGINAL_CATALOG.find((item) => item.id === id) ?? null;
export const catalogAssetFolder = (item) => `builtin/${item.id.replace(/^builtin:/, '')}`;
