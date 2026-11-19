// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * R113 · L2 纯函数验收（LI-A16 / A17 / A18 / A19）
 *
 * 只打 `inspector-adjust.mjs`：调色五项序列化、效果栈增删启停、三态、17 混合模式能力矩阵。
 * 面板与写盘由 s208 量具验（真实 Studio + Playwright）；这里先把「公式与形状」钉死。
 *
 * 运行：node --test packages/layers/inspector-adjust.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BLEND_ITEMS,
  EFFECT_DEFAULTS,
  EFFECT_DEFS,
  FADE_MAX,
  FADE_MIN,
  blendMatrix,
  effectPatch,
  filterWithGrade,
  gradeFromFilter,
  parseFilterFunctions,
  parseInsetShadow,
  parseDropShadow,
  readEffect
} from './inspector-adjust.mjs';

/* ────────────────────────── 调色五项（LI-A17） ────────────────────────── */

test('A17-1 五个公式与参考一致：brightness(1+v/100) / contrast / saturate / hue-rotate(deg) / grayscale(%)', () => {
  const cases = [
    ['gradeBrightness', 20, 'brightness(1.2)'],
    ['gradeContrast', -30, 'contrast(0.7)'],
    ['gradeSaturate', 50, 'saturate(1.5)'],
    ['gradeHue', -90, 'hue-rotate(-90deg)'],
    ['gradeGrayscale', 40, 'grayscale(40%)']
  ];
  for (const [field, value, expected] of cases) {
    const built = filterWithGrade('none', field, value);
    assert.ok(built.ok, `${field} 应成功：${JSON.stringify(built)}`);
    assert.equal(built.value, expected, `${field}=${value} 的序列化`);
    /* 读回同一个值（可逆） */
    const back = gradeFromFilter(built.value);
    assert.ok(back.ok);
    assert.equal(back.values[field], value, `${field} 读回 ${JSON.stringify(back.values)}`);
  }
});

test('A17-2 零值删函数；改一项保留其他函数与顺序；新函数插在 drop-shadow 之前', () => {
  const base = 'sepia(0.3) brightness(1.2) drop-shadow(0 8px 24px rgba(0,0,0,.35))';

  /* 零值删函数 */
  const removed = filterWithGrade(base, 'gradeBrightness', 0);
  assert.equal(removed.value, 'sepia(0.3) drop-shadow(0 8px 24px rgba(0,0,0,.35))');

  /* 改一项：其他函数原位、顺序不变 */
  const changed = filterWithGrade(base, 'gradeSaturate', 25);
  assert.equal(changed.value, 'sepia(0.3) brightness(1.2) saturate(1.25) drop-shadow(0 8px 24px rgba(0,0,0,.35))');

  /* 没有任何调色函数时：插在 drop-shadow 前（不是文件末尾） */
  const inserted = filterWithGrade('sepia(0.3) drop-shadow(0 2px 4px #000)', 'gradeContrast', 10);
  assert.equal(inserted.value, 'sepia(0.3) contrast(1.1) drop-shadow(0 2px 4px #000)');

  /* 值本来就是 0 且没有这个函数：不动（不发空 op） */
  const noop = filterWithGrade('sepia(0.3)', 'gradeHue', 0);
  assert.equal(noop.ok, true);
  assert.equal(noop.unchanged, true);
});

test('A17-3 解析不了的 filter 不动，标「手写」；超范围的值也标手写', () => {
  const custom = filterWithGrade('blur(4px', 'gradeBrightness', 10);
  assert.equal(custom.ok, false);
  assert.equal(custom.error.code, 'FILTER_CUSTOM');

  const outOfRange = gradeFromFilter('brightness(3)');
  assert.ok(outOfRange.ok);
  assert.equal(outOfRange.custom, true, 'brightness(3) = 200，超出 −100..100 → 手写');
  assert.equal(gradeFromFilter('brightness(1.2)').values.gradeBrightness, 20);
  /* 超范围拒绝写入 */
  assert.equal(filterWithGrade('none', 'gradeBrightness', 300).ok, false);
  assert.equal(filterWithGrade('none', 'gradeHue', -200).ok, false);
});

test('A17-4 filter 函数扫描：未知函数保留（url()/sepia），畸形串拒绝', () => {
  const parsed = parseFilterFunctions('url(#fx) sepia(0.3) blur(2px)');
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.funcs.map((fn) => fn.name), ['url', 'sepia', 'blur']);

  assert.equal(parseFilterFunctions('blur(2px) garbage').ok, false);
  assert.equal(parseFilterFunctions('blur(2px').ok, false);
  assert.deepEqual(parseFilterFunctions('none').funcs, []);
});

/* ────────────────────────── 效果栈（LI-A18 / A19） ────────────────────────── */

test('A18-1 投影：添加默认 → 读回 present → 改参数 → 删除只删自己', () => {
  const added = effectPatch({ filter: 'brightness(1.1)' }, 'drop-shadow', 'add');
  assert.ok(added.ok);
  const filter = added.patch.style.filter;
  assert.match(filter, /^brightness\(1\.1\) drop-shadow\(0px 8px 24px rgba\(0, 0, 0, 0\.35\)\)$/);

  const read = readEffect({ filter }, 'drop-shadow');
  assert.equal(read.state, 'present');
  assert.deepEqual(read.params, { x: 0, y: 8, blur: 24, color: 'rgba(0, 0, 0, 0.35)' });

  const set = effectPatch({ filter }, 'drop-shadow', 'set', { x: 2, y: 3, blur: 6, color: '#000' });
  const updated = readEffect({ filter: set.patch.style.filter }, 'drop-shadow');
  assert.equal(updated.params.x, 2);
  assert.equal(updated.params.blur, 6);

  const removed = effectPatch({ filter: set.patch.style.filter }, 'drop-shadow', 'remove');
  assert.equal(removed.patch.style.filter, 'brightness(1.1)', '去掉投影后调色原样还在');
});

test('A18-2 内阴影：inset 只增删自己，外阴影/作者 box-shadow 不动', () => {
  const base = '0 2px 4px rgba(0,0,0,.2), 0 0 0 1px #333';
  const added = effectPatch({ boxShadow: base }, 'inset-shadow', 'add');
  assert.ok(added.ok);
  assert.equal(added.patch.style['box-shadow'], 'inset 0px 2px 8px 0px rgba(0, 0, 0, 0.35), 0 2px 4px rgba(0,0,0,.2), 0 0 0 1px #333');

  const read = readEffect({ boxShadow: added.patch.style['box-shadow'] }, 'inset-shadow');
  assert.equal(read.state, 'present');
  assert.equal(read.params.blur, 8);

  const removed = effectPatch({ boxShadow: added.patch.style['box-shadow'] }, 'inset-shadow', 'remove');
  assert.equal(removed.patch.style['box-shadow'], base);
});

test('A18-3 图层模糊与背景模糊分开：一个在 filter、一个在 backdrop-filter', () => {
  const blur = effectPatch({ filter: 'brightness(1.2)' }, 'blur', 'add');
  assert.equal(blur.patch.style.filter, 'brightness(1.2) blur(4px)');

  const backdrop = effectPatch({}, 'backdrop-blur', 'add');
  assert.equal(backdrop.patch.style['backdrop-filter'], 'blur(8px)', '默认 8px');

  /* 两者互不影响 */
  const both = effectPatch({ filter: blur.patch.style.filter, backdropFilter: 'blur(8px)' }, 'blur', 'set', { value: 12 });
  assert.equal(both.patch.style.filter, 'brightness(1.2) blur(12px)');
  assert.equal(both.patch.style['backdrop-filter'], undefined, '改图层模糊不该碰背景模糊');
});

test('A18-4 四边渐隐：单边加/关，四层时 mask-composite=intersect，作者蒙版原样保留', () => {
  const top = effectPatch({}, 'edge-fade', 'set', { edge: 'top', value: 12 });
  assert.equal(top.patch.style['mask-image'], 'linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,1) 12%)');
  assert.equal(top.patch.style['mask-composite'], undefined, '单层不需要 composite');

  const both = effectPatch({ maskImage: top.patch.style['mask-image'] }, 'edge-fade', 'set', { edge: 'left', value: 20 });
  assert.match(both.patch.style['mask-image'], /to bottom[\s\S]*to right/);
  assert.equal(both.patch.style['mask-composite'], 'add, intersect');

  const off = effectPatch({ maskImage: both.patch.style['mask-image'] }, 'edge-fade', 'set', { edge: 'left', value: 0 });
  assert.equal(off.patch.style['mask-image'], 'linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,1) 12%)');

  /* 作者自己的蒙版：我们的层排在前面，作者层留在后面 */
  const withAuthor = effectPatch({ maskImage: 'radial-gradient(circle, #000 60%, transparent)' }, 'edge-fade', 'set', { edge: 'top', value: 10 });
  assert.match(withAuthor.patch.style['mask-image'], /^linear-gradient\(to bottom[\s\S]*radial-gradient/);

  const closed = effectPatch({ maskImage: withAuthor.patch.style['mask-image'] }, 'edge-fade', 'remove');
  assert.equal(closed.patch.style['mask-image'], 'radial-gradient(circle, #000 60%, transparent)', '关掉渐隐只留作者的蒙版');

  assert.equal(effectPatch({}, 'edge-fade', 'set', { edge: 'top', value: FADE_MAX + 1 }).ok, false);
  assert.equal(effectPatch({}, 'edge-fade', 'set', { edge: 'top', value: FADE_MIN / 2 }).ok, false);
});

test('A19-1 三态分开：absent / custom / mixed，不混成一个空值', () => {
  assert.equal(readEffect({}, 'drop-shadow').state, 'absent');
  assert.equal(readEffect({ filter: 'drop-shadow(var(--x))' }, 'drop-shadow').state, 'custom');
  assert.equal(
    readEffect({ filter: 'drop-shadow(0 2px 4px #000) drop-shadow(0 9px 9px #fff)' }, 'drop-shadow').state,
    'mixed',
    '同一个元素两处投影参数不一致 → mixed'
  );
  assert.equal(readEffect({ maskImage: 'radial-gradient(circle, #000, transparent)' }, 'edge-fade').state, 'custom');
  assert.equal(readEffect({ filter: 'blur(2px) blur(4px)' }, 'blur').state, 'mixed');

  /* custom 拒绝改参数（只允许删除） */
  const rejected = effectPatch({ filter: 'drop-shadow(var(--x))' }, 'drop-shadow', 'set', { x: 1 });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'EFFECT_CUSTOM');
});

test('A19-2 启停与重置：停用删函数、启用按默认加回、重置回默认参数', () => {
  const added = effectPatch({ filter: 'contrast(1.1)' }, 'drop-shadow', 'add');
  const off = effectPatch({ filter: added.patch.style.filter }, 'drop-shadow', 'toggle');
  assert.equal(off.patch.style.filter, 'contrast(1.1)');

  const on = effectPatch({ filter: 'contrast(1.1)' }, 'drop-shadow', 'toggle');
  assert.equal(on.patch.style.filter, added.patch.style.filter, '启用按默认参数加回');

  const custom = effectPatch({ filter: 'drop-shadow(1px 2px 3px #123)' }, 'drop-shadow', 'reset');
  assert.equal(custom.patch.style.filter, 'drop-shadow(0px 8px 24px rgba(0, 0, 0, 0.35))');
});

test('A19-3 互不擦除：调色 + 投影 + 模糊 + 作者 filter 四者共存，顺序稳定', () => {
  let filter = 'sepia(0.2)';
  filter = filterWithGrade(filter, 'gradeBrightness', 15).value; // sepia(0.2) brightness(1.15)
  filter = effectPatch({ filter }, 'blur', 'add', { value: 3 }).patch.style.filter; // ... blur(3px)
  filter = effectPatch({ filter }, 'drop-shadow', 'add').patch.style.filter; // ... drop-shadow(...)
  assert.equal(filter, 'sepia(0.2) brightness(1.15) blur(3px) drop-shadow(0px 8px 24px rgba(0, 0, 0, 0.35))');

  /* 调色归零只删自己，其他三项一个不动 */
  const zero = filterWithGrade(filter, 'gradeBrightness', 0);
  assert.equal(zero.value, 'sepia(0.2) blur(3px) drop-shadow(0px 8px 24px rgba(0, 0, 0, 0.35))');
  assert.equal(readEffect({ filter: zero.value }, 'drop-shadow').state, 'present');
  assert.equal(readEffect({ filter: zero.value }, 'blur').state, 'present');
});

/* ────────────────────────── 混合模式（LI-A16 ③） ────────────────────────── */

test('A16-1 17 种混合模式：名称/顺序/能力；不支持的显式标 passthrough', () => {
  assert.equal(BLEND_ITEMS.length, 17);
  assert.deepEqual(BLEND_ITEMS.map((item) => item.mode), [
    'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'plus-lighter',
    'color-dodge', 'color-burn', 'soft-light', 'hard-light', 'difference', 'exclusion',
    'hue', 'saturation', 'color', 'luminosity'
  ]);

  /* 本机（Chromium 140）全支持：normal 自成一档，其余 16 个需要下层有内容 */
  const real = blendMatrix();
  assert.equal(real.length, 17);
  assert.equal(real.filter((item) => item.capability === 'visible').length, 1);
  assert.equal(real.filter((item) => item.capability === 'needs-backdrop').length, 16);
  assert.equal(real.filter((item) => item.capability === 'passthrough').length, 0);

  /* 注入一个「不支持 plus-lighter」的合成器：必须显式标 passthrough，而不是静默当支持 */
  const fake = blendMatrix((property, value) => !(property === 'mix-blend-mode' && value === 'plus-lighter'));
  const plus = fake.find((item) => item.mode === 'plus-lighter');
  assert.equal(plus.supported, false);
  assert.equal(plus.capability, 'passthrough');
  assert.match(plus.note, /不支持/);
});

/* ────────────────────────── 形状（给面板读的） ────────────────────────── */

test('形状：五个效果各有 id/kind/label/order/writes；默认参数与参考一致', () => {
  assert.deepEqual(EFFECT_DEFS.map((def) => def.kind), ['drop-shadow', 'inset-shadow', 'blur', 'backdrop-blur', 'edge-fade']);
  assert.deepEqual(EFFECT_DEFS.map((def) => def.order), [1, 2, 3, 4, 5]);
  assert.deepEqual(EFFECT_DEFS.map((def) => def.writes), ['filter', 'box-shadow', 'filter', 'backdrop-filter', 'mask-image']);
  assert.deepEqual(EFFECT_DEFAULTS['drop-shadow'], { x: 0, y: 8, blur: 24, color: 'rgba(0, 0, 0, 0.35)' });
  assert.equal(EFFECT_DEFAULTS.blur.value, 4);
  assert.equal(EFFECT_DEFAULTS['backdrop-blur'].value, 8);
  /* 解析器对裸参数也能用（面板「当前值」与「提交值」同一套） */
  assert.deepEqual(parseDropShadow('0 8px 24px rgba(0,0,0,.35)'), { x: 0, y: 8, blur: 24, color: 'rgba(0,0,0,.35)' });
  assert.deepEqual(parseInsetShadow('inset 0 2px 8px 4px #000'), { x: 0, y: 2, blur: 8, spread: 4, color: '#000' });
  assert.equal(parseDropShadow('nonsense'), null);
});

/* ─────────────────── R121 · M7-A：浏览器自己的序列化顺序 ───────────────────
   视觉对照跑出来的**真缺陷**（不是量具问题）：Chromium 的计算值把
   `drop-shadow` 写成「颜色在前」、把 `box-shadow` 写成「inset 在尾」。
   旧解析器只认「长度在前 / inset 在前」，于是面板刚写下去的效果读回来变成
   「手写」或「未添加」——按钮整排消失、再点一次「添加」还会叠出第二条。
   这两条钉住「两种顺序等价」，且不把真正的手写值当成结构化。 */

test('A20-1 投影：颜色在前 / 长度在前两种序列化解析成同一组参数；reset 从 color-first 回默认', () => {
  const colorFirst = parseDropShadow('rgba(0, 0, 0, 0.35) 0px 48px 24px');
  const lengthFirst = parseDropShadow('0px 48px 24px rgba(0, 0, 0, 0.35)');
  assert.deepEqual(colorFirst, { x: 0, y: 48, blur: 24, color: 'rgba(0, 0, 0, 0.35)' });
  assert.deepEqual(colorFirst, lengthFirst);

  const read = readEffect({ filter: 'drop-shadow(rgba(0, 0, 0, 0.35) 0px 48px 24px)' }, 'drop-shadow');
  assert.equal(read.state, 'present');
  assert.deepEqual(read.params, { x: 0, y: 48, blur: 24, color: 'rgba(0, 0, 0, 0.35)' });

  const reset = effectPatch({ filter: 'drop-shadow(rgba(0, 0, 0, 0.35) 0px 48px 24px)' }, 'drop-shadow', 'reset', read.params);
  assert.equal(reset.ok, true);
  assert.equal(reset.patch.style.filter, 'drop-shadow(0px 8px 24px rgba(0, 0, 0, 0.35))');
});

test('A20-2 内阴影：inset 在尾（Chromium 计算值）也认；非 inset 的 box-shadow 仍是「未添加」', () => {
  const tail = readEffect({ boxShadow: 'rgba(0, 0, 0, 0.35) 0px 18px 8px 0px inset' }, 'inset-shadow');
  const head = readEffect({ boxShadow: 'inset 0px 18px 8px 0px rgba(0, 0, 0, 0.35)' }, 'inset-shadow');
  assert.equal(tail.state, 'present');
  assert.deepEqual(tail.params, { x: 0, y: 18, blur: 8, spread: 0, color: 'rgba(0, 0, 0, 0.35)' });
  assert.deepEqual(tail.params, head.params);

  const outer = readEffect({ boxShadow: 'rgba(0, 0, 0, 0.35) 0px 8px 24px 0px' }, 'inset-shadow');
  assert.equal(outer.state, 'absent');

  /* 加一条内阴影时**不能**把已有的外阴影/作者阴影带走 */
  const added = effectPatch({ boxShadow: 'rgba(0, 0, 0, 0.35) 0px 8px 24px 0px' }, 'inset-shadow', 'add', {});
  assert.equal(added.ok, true);
  assert.match(String(added.patch.style['box-shadow']), /^inset 0px 2px 8px 0px rgba\(0, 0, 0, 0\.35\), rgba\(0, 0, 0, 0\.35\) 0px 8px 24px 0px$/);
});
