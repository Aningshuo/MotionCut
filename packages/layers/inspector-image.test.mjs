// @ts-nocheck —— 验收/探针脚本以 node --test 的运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * 图像适配 / 四角裁切 / 换源的纯逻辑单测（R125 · M11-B / LI-A24）。
 *
 * 这里钉**数据层**：序列化往返、四角 polygon 的顺序与钳制、换源白名单、三态读数、预告阈值。
 * 「画面上真的少了一角 / 真的换成了另一张」由 `scripts/s211-r125-m11-mask.mjs` 在真实舞台上量。
 *
 * 为什么换源白名单值得单测：它挡的是「把预览打到别人服务器上」——这种错一旦漏到 UI 才被发现，
 * 代价比一条断言高得多。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CROP_CORNERS,
  CROP_DEFAULTS,
  CROP_PROP,
  FIT_MODES,
  MEDIA_PROP,
  POSITIONS,
  cropPatch,
  cropPolygon,
  formatCrop,
  mediaPatch,
  mediaWarn,
  normalizeCrop,
  parseCrop,
  readCrop,
  readMedia
} from './inspector-image.mjs';

test('A24-1 四角序列化往返逐字相同；缺角/坏版本一律 null（不猜）', () => {
  const text = formatCrop(CROP_DEFAULTS);
  assert.equal(text, 'v1;tl=0,0;tr=100,0;br=100,100;bl=0,100');
  assert.deepEqual(parseCrop(text), {
    tl: [0, 0], tr: [100, 0], br: [100, 100], bl: [0, 100]
  });
  assert.equal(parseCrop('v2;tl=0,0;tr=100,0;br=100,100;bl=0,100'), null);
  assert.equal(parseCrop('v1;tl=0,0;tr=100,0;br=100,100'), null, '缺一个角就不是我们的参数行');
  assert.equal(parseCrop('v1;tl=0,0;tr=100,0;br=100,100;bl=0'), null, '一角只有一个数');
  assert.equal(parseCrop('v1;tl=0,0;tr=100,0;br=100,100;bl=0,zzz'), null);
  assert.equal(parseCrop(''), null);
  assert.equal(parseCrop(undefined), null);
});

test('A24-2 polygon 的顺序是 tl→tr→br→bl，且钳到 0..100 并说明钳了哪项', () => {
  assert.equal(cropPolygon(CROP_DEFAULTS), 'polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)');
  const { crop, clamped } = normalizeCrop({ tl: [-5, 120], tr: [100, 0], br: [100, 100], bl: [0, 100] });
  assert.deepEqual(crop.tl, [0, 100]);
  assert.deepEqual(clamped, ['tl.x=-5→0', 'tl.y=120→100']);
  /* 顺序写反了（br 与 bl 互换）必须能看出来：这是四角裁切最容易写错的地方。 */
  const flipped = cropPolygon({ tl: [0, 0], tr: [100, 0], br: [100, 0], bl: [100, 100] });
  assert.equal(flipped, 'polygon(0% 0%, 100% 0%, 100% 0%, 100% 100%)');
  assert.equal(CROP_CORNERS.map((c) => c.id).join(','), 'tl,tr,br,bl');
});

test('A24-3 cropPatch：改一角只动这一角；reset 回 0/100；remove 写 none 并清参数行', () => {
  const base = { clipPath: '', cropSpec: formatCrop(CROP_DEFAULTS) };
  const set = cropPatch(base, 'set', { tlx: 12, tly: 8 });
  assert.equal(set.ok, true);
  assert.equal(set.patch.style[CROP_PROP], 'v1;tl=12,8;tr=100,0;br=100,100;bl=0,100');
  assert.equal(set.patch.style['clip-path'], 'polygon(12% 8%, 100% 0%, 100% 100%, 0% 100%)');
  assert.equal(set.note, '四角裁切已更新');

  const moved = cropPatch({ cropSpec: set.patch.style[CROP_PROP] }, 'set', { br: [90, 95] });
  assert.equal(moved.patch.style[CROP_PROP], 'v1;tl=12,8;tr=100,0;br=90,95;bl=0,100', '别的角原样保留');

  const reset = cropPatch({ cropSpec: moved.patch.style[CROP_PROP] }, 'reset');
  assert.equal(reset.patch.style[CROP_PROP], formatCrop(CROP_DEFAULTS));
  assert.equal(reset.patch.style['clip-path'], cropPolygon(CROP_DEFAULTS));

  const removed = cropPatch(base, 'remove');
  assert.equal(removed.patch.style['clip-path'], 'none');
  assert.equal(removed.patch.style[CROP_PROP], '');
});

test('A24-4 作者自己写的 polygon：读成 custom，改它要标 replacedForeign（不静默替换）', () => {
  const foreign = { clipPath: 'polygon(10% 0%, 90% 0%, 90% 100%, 10% 100%)' };
  const read = readCrop(foreign);
  assert.equal(read.state, 'custom');
  assert.match(read.note, /polygon/);
  const patched = cropPatch(foreign, 'set', { tl: [4, 4] });
  assert.equal(patched.replacedForeign, true, '替换别人的裁切必须自报');
  assert.match(patched.patch.style['clip-path'], /^polygon\(/);
  /* 不是 polygon（比如 circle/inset）→ 不算我们的，也不当 custom 的 polygon 处理。 */
  assert.equal(readCrop({ clipPath: 'inset(10px)' }).state, 'absent');
  assert.equal(readCrop({}).state, 'absent');
});

test('A24-5 换源白名单：只收工程内相对路径与 data:image；外链/绝对路径/上跳一律拒', () => {
  const ok = mediaPatch({}, { src: 'assets/take-02.png' });
  assert.equal(ok.ok, true);
  assert.equal(ok.patch.style['content'], 'url("assets/take-02.png")');
  assert.equal(ok.patch.style[MEDIA_PROP], 'v1;src=assets/take-02.png');

  for (const src of ['assets/x.png', 'scenes/x.png', './x.png', 'data:image/png;base64,AAAA']) {
    assert.equal(mediaPatch({}, { src }).ok, true, `应当放行：${src}`);
  }
  for (const src of ['http://example.com/x.png', 'https://example.com/x.png', '/etc/x.png', 'C:\\x.png', 'assets/../../secret.png', 'file:///tmp/x.png']) {
    const res = mediaPatch({}, { src });
    assert.equal(res.ok, false, `应当拒绝：${src}`);
    assert.equal(res.error.code, 'PATH_NOT_ALLOWED');
  }
  const empty = mediaPatch({}, { src: '   ' });
  assert.equal(empty.ok, false);
  assert.equal(empty.error.code, 'INVALID_VALUE');

  const restore = mediaPatch({}, { action: 'restore' });
  assert.equal(restore.patch.style.content, 'normal');
  assert.equal(restore.patch.style[MEDIA_PROP], '');
});

test('A24-6 换源三态读数：参数行 → replaced；手写 url() → custom；其余 original', () => {
  assert.deepEqual(readMedia({ mediaSpec: 'v1;src=assets/a.png' }), { state: 'replaced', src: 'assets/a.png', note: '' });
  const custom = readMedia({ content: 'url("https://x/y.png")' });
  assert.equal(custom.state, 'custom');
  assert.match(custom.note, /手写/);
  assert.equal(readMedia({ content: 'normal' }).state, 'original');
  assert.equal(readMedia({}).state, 'original');
  /* 退化值：参数行在、src 为空。读回仍是 `replaced`（空 src），但 `mediaPatch` 拒绝空 src，
     所以 UI 造不出这种值 —— 这里如实钉住读数，不去「猜它应该是 original」。 */
  assert.deepEqual(readMedia({ mediaSpec: 'v1;src=' }), { state: 'replaced', src: '', note: '' });
  /* 版本头不对 → 不是我们的参数行 */
  assert.equal(readMedia({ mediaSpec: 'v0;src=assets/a.png', content: 'normal' }).state, 'original');
});

test('A24-7 换源预告：新素材比盒子小才说话（给出百分比），不比就不吵', () => {
  const warn = mediaWarn({ w: 100, h: 50 }, { w: 400, h: 200 });
  assert.equal(warn.code, 'SOURCE_SMALLER');
  assert.match(warn.message, /25%/);
  assert.equal(mediaWarn({ w: 800, h: 600 }, { w: 400, h: 200 }), null, '一样大或更大：没有要说的话');
  assert.equal(mediaWarn({ w: 400, h: 200 }, { w: 400, h: 200 }), null);
  assert.equal(mediaWarn({ w: 0, h: 0 }, { w: 400, h: 200 }), null, '尺寸未知 → 不编');
  assert.equal(mediaWarn({ w: 100, h: 50 }, { w: 0, h: 0 }), null);
});

test('A24-8 枚举是面板的单一真值：三态适配 / 九宫格位置不重复、不缺项', () => {
  assert.deepEqual(FIT_MODES.map((m) => m.value), ['fill', 'cover', 'contain']);
  assert.equal(POSITIONS.length, 9);
  assert.equal(new Set(POSITIONS.map((p) => p.value)).size, 9);
  for (const pos of ['center', 'top left', 'bottom right']) {
    assert.ok(POSITIONS.some((p) => p.value === pos), `九宫格缺 ${pos}`);
  }
  for (const item of [...FIT_MODES, ...POSITIONS]) assert.ok(item.label.length > 0, '每项都要有中文标签');
});
