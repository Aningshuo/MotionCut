// @ts-nocheck —— 验收/探针脚本以 node --test 的运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * 蒙版的纯逻辑单测（R125 · M11-A / LI-A20 · A21）。
 *
 * 这里钉的是**数据层**：序列化往返、能力矩阵、与四边渐隐的共存、钳制、手势算法。
 * 「像素上真的挖了个星」由 `scripts/s211-r125-m11-mask.mjs` 在真实舞台上量 —— 两者分工不同。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MASK_DEFAULTS,
  MASK_RANGES,
  MASK_SHAPES,
  MASK_PROP,
  applyMaskGesture,
  composeMaskLayers,
  formatMaskSpec,
  isOwnMaskLayer,
  maskCapability,
  maskDataUrl,
  maskParamRows,
  maskPatch,
  normalizeMaskSpec,
  parseMaskSpec,
  readMask,
  splitMaskLayers
} from './inspector-mask.mjs';

test('A21-1 序列化往返逐字相同；未知版本/坏键一律 null（不猜）', () => {
  const spec = { shape: 'star', x: 40.5, y: 55, w: 62.25, h: 48, feather: 6, radius: 0, rot: -15, invert: 1 };
  const text = formatMaskSpec(spec);
  assert.equal(text, 'v1;shape=star;x=40.5;y=55;w=62.25;h=48;feather=6;radius=0;rot=-15;invert=1');
  assert.deepEqual(parseMaskSpec(text), spec);
  assert.equal(formatMaskSpec(parseMaskSpec(text)), text);

  assert.equal(parseMaskSpec('v2;shape=star'), null, '不同版本不认');
  assert.equal(parseMaskSpec('v1;shape=blob'), null, '未知形状不认');
  assert.equal(parseMaskSpec('v1;shape=rect;zzz=1'), null, '未知键不认');
  assert.equal(parseMaskSpec('v1;shape=rect;x=abc'), null, '非数字不认');
  assert.equal(parseMaskSpec(null), null);
});

test('A21-2 六类形状都能出 url，且我们的层能被认出来（不与渐隐混淆）', () => {
  for (const item of MASK_SHAPES) {
    const { spec } = normalizeMaskSpec({ ...MASK_DEFAULTS, shape: item.id }, { w: 300, h: 200 });
    const url = maskDataUrl(spec, { w: 300, h: 200 });
    assert.match(url, /^url\("data:image\/svg\+xml,/, `${item.id} 应生成 data url`);
    assert.equal(isOwnMaskLayer(url), true, `${item.id} 的层应被认成自己的`);
    const svg = decodeURIComponent(url.slice('url("'.length, -2));
    assert.match(svg, /viewBox="0 0 100 100"/);
    assert.match(svg, /preserveAspectRatio="none"/, '必须按元素盒子拉伸，否则百分比坐标对不上');
  }
  assert.equal(isOwnMaskLayer('linear-gradient(to bottom, rgba(0,0,0,0) 0%, #000 12%)'), false);
  assert.equal(isOwnMaskLayer('url("assets/mask.png")'), false, '作者自己的图片蒙版不是我们的');
});

test('A21-3 maskPatch：加/改/重置/反转/删都只动我们的层与 --oc-mask', () => {
  const fade = 'linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,1) 12%)';
  const css = { maskImage: fade, maskSpec: '' };

  const created = maskPatch(css, 'add', { shape: 'heart' }, { w: 320, h: 180 });
  assert.equal(created.ok, true);
  assert.equal(created.spec.shape, 'heart');
  const style = created.patch.style;
  assert.ok(String(style[MASK_PROP]).startsWith('v1;shape=heart;'), `应写参数行：${style[MASK_PROP]}`);
  assert.match(style['mask-image'], /^url\("data:image\/svg\+xml,/);
  assert.ok(style['mask-image'].includes(fade), '四边渐隐那一层必须原样留着（不互清）');
  assert.equal(style['mask-size'], '100% 100%, auto', '每层各给一个 size，别把作者的层也改成拉伸');
  assert.equal(style['mask-composite'], 'add, intersect');

  /* 改一项：其余参数不动 */
  const css2 = { maskImage: style['mask-image'], maskSpec: style[MASK_PROP] };
  const moved = maskPatch(css2, 'set', { x: 70 }, { w: 320, h: 180 });
  assert.equal(readMask({ maskSpec: moved.patch.style[MASK_PROP] }).spec.x, 70);
  assert.equal(readMask({ maskSpec: moved.patch.style[MASK_PROP] }).spec.shape, 'heart', '改 X 不该把形状丢掉');
  assert.equal(readMask({ maskSpec: moved.patch.style[MASK_PROP] }).spec.w, created.spec.w);

  /* 反转：只翻一位 */
  const inv = maskPatch(css2, 'invert', {}, { w: 320, h: 180 });
  assert.equal(parseMaskSpec(inv.patch.style[MASK_PROP]).invert, 1);

  /* 重置：形状保留、参数回默认 */
  const reset = maskPatch(css2, 'reset', {}, { w: 320, h: 180 });
  const back = parseMaskSpec(reset.patch.style[MASK_PROP]);
  assert.equal(back.shape, 'heart');
  assert.deepEqual({ ...back, shape: 'heart' }, { ...MASK_DEFAULTS, shape: 'heart' });

  /* 删除：我们的层没了、别人的层还在 */
  const gone = maskPatch(css2, 'remove', {}, { w: 320, h: 180 });
  assert.equal(gone.patch.style['mask-image'], fade, '删我们的不该把作者/渐隐一起删');
  assert.equal(gone.patch.style[MASK_PROP], '');
});

test('A21-4 作者自己的蒙版：读成 custom；set/重置被拒、remove 只删我们的', () => {
  const custom = readMask({ maskImage: 'url("assets/mask.png")' });
  assert.equal(custom.state, 'custom');
  assert.match(custom.note, /本来就有蒙版/);

  const refused = maskPatch({ maskImage: 'url("assets/mask.png")' }, 'set', { x: 10 });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'MASK_CUSTOM');

  const add = maskPatch({ maskImage: 'url("assets/mask.png")' }, 'add', { shape: 'circle' }, { w: 100, h: 100 });
  assert.equal(add.ok, true);
  assert.ok(String(add.patch.style['mask-image']).includes('url("assets/mask.png")'), '新建时也不动别人的层');
});

test('A21-5 钳制：宽高最少 1%、位置 0..100、旋转 ±180、羽化 0..40，并说明钳了哪项', () => {
  const wide = maskPatch({ maskImage: 'none' }, 'add', { w: 0, h: 300, x: -20, y: 130, rot: -400, feather: 999 }, { w: 300, h: 200 });
  assert.equal(wide.spec.w, MASK_RANGES.w[0]);
  assert.equal(wide.spec.h, 100);
  assert.equal(wide.spec.x, 0);
  assert.equal(wide.spec.y, 100);
  assert.equal(wide.spec.rot, -180);
  assert.equal(wide.spec.feather, 40);
  assert.match(wide.note, /已钳制/);
  assert.ok(wide.clamped.length >= 5, `应逐项报告：${JSON.stringify(wide.clamped)}`);
});

test('A21-6 能力矩阵：圆没有旋转、圆角只有矩形/线；六类都有羽化与反转（不是「没做」）', () => {
  assert.equal(maskCapability('circle').rotation, false);
  assert.equal(maskCapability('star').rotation, true);
  assert.equal(maskCapability('circle').radius, false);
  assert.equal(maskCapability('star').radius, false);
  assert.equal(maskCapability('rect').radius, true);
  assert.equal(maskCapability('line').radius, true);
  for (const item of MASK_SHAPES) {
    assert.equal(maskCapability(item.id).feather, true, `${item.id} 的羽化应可用`);
    assert.equal(maskCapability(item.id).invert, true, `${item.id} 的反转应可用`);
  }
  /* 面板行：不支持的参数是 disabled + 人话理由（不是藏起来让人猜） */
  const circleRows = maskParamRows('circle');
  const rot = circleRows.find((row) => row.id === 'rot');
  assert.equal(rot.enabled, false);
  assert.match(rot.reason, /圆旋转后还是圆/);
  assert.equal(circleRows.find((row) => row.id === 'radius').enabled, false);
  assert.equal(circleRows.find((row) => row.id === 'feather').enabled, true);
});

test('A21-7 画布手势：移动只改 x/y、缩放对称改 w/h、旋转只改 rot，且都钳在范围内', () => {
  const base = { ...MASK_DEFAULTS, x: 50, y: 50, w: 40, h: 30, rot: 10 };
  const moved = applyMaskGesture(base, { kind: 'move', dxPct: 10, dyPct: -25 }).spec;
  assert.deepEqual([moved.x, moved.y], [60, 25]);
  assert.deepEqual([moved.w, moved.h], [40, 30]);

  const resized = applyMaskGesture(base, { kind: 'resize', dwPct: 5, dhPct: -5 }).spec;
  assert.deepEqual([resized.w, resized.h], [50, 20], '缩放以中心为锚点，宽高各 ±2×位移');
  assert.deepEqual([resized.x, resized.y], [50, 50], '缩放不该顺手移动');

  const rotated = applyMaskGesture({ ...base, rot: 170 }, { kind: 'rotate', dRot: 30 }).spec;
  assert.equal(rotated.rot, -160, '越过 180 回绕到 -160（不是直接钳成 180）');

  const clamped = applyMaskGesture({ ...base, w: 99 }, { kind: 'resize', dwPct: 20 }).spec;
  assert.equal(clamped.w, 100);
});

test('A21-8 层拆分：括号/引号里的逗号不切（作者蒙版常带 rgba()）', () => {
  const layers = splitMaskLayers('linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,1) 12%), url("a,b.png")');
  assert.equal(layers.length, 2);
  assert.equal(layers[1], 'url("a,b.png")');

  const composed = composeMaskLayers('none', 'url("data:image/svg+xml,abc")');
  assert.equal(composed['mask-image'], 'url("data:image/svg+xml,abc")');
  assert.equal(composed['mask-size'], '100% 100%');
  assert.equal(composed['mask-composite'], undefined, '只有一层时不写 composite');
});
