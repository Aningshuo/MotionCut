/**
 * 字幕样式 schema 的回归测试（S41 · B-SUB1-R21-021）
 *
 * 这里**故意 import `packages/render/subtitles.mjs`**：A1 的判据是「与烧录端的默认产出逐字段
 * 相等」，而唯一可信的对照就是那条真产出。产品代码没有这个反向依赖（`layers/` 不 import
 * `render/`），只有测试文件这么用——它是这一批最重要的那道闸。
 *
 * 覆盖：
 * - U1 默认值形状（16 字段、深冻结、与 render 的同名默认值同值）
 * - U2 normalize：缺省合并 / 范围 / 颜色 / 对齐 / 类型 / 未知键 / 非对象
 * - U3 toAssStyle ↔ render 的 `buildAssDocument()` 逐字段（720p）
 * - U4 三画幅 × P32 表
 * - U5 旧字段名别名
 * - U6 三条预设可序列化、default 等于默认
 * - U7 颜色 → ASS（BGR + alpha 取反）
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAssDocument,
  parseAssDocument,
  SUBTITLE_STYLE_DEFAULTS as RENDER_DEFAULTS
} from '../render/subtitles.mjs';
import {
  CSS_OUTLINE_RING_MAX,
  SUBTITLE_CANVAS_TABLE,
  SUBTITLE_LINE_STEP_K,
  SUBTITLE_STYLE_DEFAULTS,
  cssOutlineRing,
  isColorRejected,
  normalizeSubtitleStyle,
  parseCssColor,
  subtitleLayout,
  toAssColor,
  toAssStyle,
  toCssDecor,
  toCssStyle
} from './subtitle-style.mjs';
import {
  SUBTITLE_PRESETS,
  getSubtitlePreset,
  listSubtitlePresets,
  resolveSubtitlePreset
} from './subtitle-presets.mjs';

const STAGE = { w: 1280, h: 720 };

/**
 * 取任意对象上的字段（typed 对象不能拿 string 下标，这里显式放宽）。
 * @param {unknown} obj @param {string} key
 */
const pick = (obj, key) => /** @type {any} */ (obj)[key];

/**
 * 拆 ASS 的 `Style:` 行（字段顺序见 `Format:` 行）。
 * @param {string} ass
 */
function parseStyleLine(ass) {
  const line = String(ass)
    .split(/\r?\n/)
    .find((item) => item.startsWith('Style: '));
  assert.ok(line, 'ASS 里必须有 Style: 行');
  const f = line.slice('Style: '.length).split(',');
  return {
    fontName: f[1],
    fontSize: Number(f[2]),
    primaryColour: f[3],
    outlineColour: f[5],
    backColour: f[6],
    bold: Number(f[7]),
    outline: Number(f[16]),
    shadow: Number(f[17]),
    alignment: Number(f[18]),
    marginL: Number(f[19]),
    marginV: Number(f[21])
  };
}

test('U1 默认值：18 个字段（R30 加 preset / secondaryScale）、冻结、与 render 的同名字段同值', () => {
  const keys = Object.keys(SUBTITLE_STYLE_DEFAULTS);
  /* 16 → 18：`preset`（六种样式 id）与 `secondaryScale`（双语第二行倍率）。
     render 侧不认这两个字段（它只吃展开后的派生值），所以下面的同值断言不扩。 */
  assert.equal(keys.length, 18, `字段数应为 18：${keys.join(',')}`);
  assert.equal(Object.isFrozen(SUBTITLE_STYLE_DEFAULTS), true);

  // 与 render 同名的那些必须同值（这是「单一样式来源」的底线）
  for (const key of ['fontSizeRatio', 'bottomSafeRatio', 'shadowRatio', 'lineHeight', 'fontScale', 'bold', 'cpsWarn']) {
    assert.equal(pick(SUBTITLE_STYLE_DEFAULTS, key), pick(RENDER_DEFAULTS, key), `${key} 应与 render 同值`);
  }
  // render 的描边口径叫 strokeWidthRatio，这里叫 outlineRatio
  assert.equal(SUBTITLE_STYLE_DEFAULTS.outlineRatio, RENDER_DEFAULTS.strokeWidthRatio);
  // ASS 的 Fontname 与 render 的默认字体一字不差
  assert.equal(SUBTITLE_STYLE_DEFAULTS.assFontName, RENDER_DEFAULTS.fontFamily);
  /* ADR-R24-02（S45）：预览族表**首位**必须是 ASS 的 Fontname —— 否则两条链又不是同一条
     （S43 实测过：system-ui 在 macOS 落 PingFang+SF，字宽差 1.07%~2.22%）。回退链仍然保留。 */
  const firstFamily = SUBTITLE_STYLE_DEFAULTS.fontFamily.split(',')[0]?.trim().replace(/^"|"$/g, '');
  assert.equal(firstFamily, SUBTITLE_STYLE_DEFAULTS.assFontName, `族表首位应是 ASS Fontname：${SUBTITLE_STYLE_DEFAULTS.fontFamily}`);
  assert.ok(SUBTITLE_STYLE_DEFAULTS.fontFamily.split(',').length >= 2, '缺字回退链不能丢');
  /* 颜色三件套。R32 起描边不再是写死的 `&H00000000`：默认值改成参照的
     `rgba(0,0,0,0.84)`，`toAssColor` 按 alpha 反写 → alpha = round((1−0.84)×255) = 41 = 0x29，
     成片与预览因此仍在同一档（84%），不是「预览一套、成片另一套」。 */
  assert.equal(toAssColor(SUBTITLE_STYLE_DEFAULTS.color), '&H00FFFFFF');
  assert.equal(toAssColor(SUBTITLE_STYLE_DEFAULTS.outlineColor), '&H29000000');
  assert.equal(toAssColor(SUBTITLE_STYLE_DEFAULTS.shadowColor), '&H64000000');
});

test('U2 normalize：缺省合并 + 非法值给 issue 并回退默认', () => {
  const plain = normalizeSubtitleStyle();
  assert.deepEqual(plain.issues, []);
  assert.deepEqual(plain.style, SUBTITLE_STYLE_DEFAULTS);

  const merged = normalizeSubtitleStyle({ fontSizeRatio: 0.06, color: '#ffe066' });
  assert.equal(merged.style.fontSizeRatio, 0.06);
  assert.equal(merged.style.color, '#ffe066');
  assert.equal(merged.style.maxLines, 2, '没给的字段走默认');
  assert.deepEqual(merged.issues, []);

  const bad = normalizeSubtitleStyle({
    fontSizeRatio: -1,
    color: 'not-a-color',
    maxLines: 0,
    align: 'justify',
    lineHeight: '1.4',
    nope: 1
  });
  const codes = bad.issues.map((issue) => `${issue.field}:${issue.code}`).sort();
  assert.deepEqual(codes, [
    'align:STYLE_ALIGN',
    'color:STYLE_COLOR',
    'fontSizeRatio:STYLE_RANGE',
    'lineHeight:STYLE_TYPE',
    'maxLines:STYLE_RANGE',
    'nope:STYLE_UNKNOWN_KEY'
  ]);
  // 全部回退到默认，且未知键不写进样式
  assert.equal(bad.style.fontSizeRatio, SUBTITLE_STYLE_DEFAULTS.fontSizeRatio);
  assert.equal(bad.style.color, SUBTITLE_STYLE_DEFAULTS.color);
  assert.equal(bad.style.maxLines, SUBTITLE_STYLE_DEFAULTS.maxLines);
  assert.equal('nope' in bad.style, false);

  const notObject = normalizeSubtitleStyle('oops');
  assert.equal(notObject.issues[0]?.code, 'STYLE_NOT_OBJECT');
  assert.deepEqual(notObject.style, SUBTITLE_STYLE_DEFAULTS);

  // 边界：0 对 fontSizeRatio 非法（会让字消失），maxLines 必须是整数
  assert.equal(normalizeSubtitleStyle({ fontSizeRatio: 0 }).issues[0]?.code, 'STYLE_RANGE');
  assert.equal(normalizeSubtitleStyle({ maxLines: 2.5 }).issues[0]?.code, 'STYLE_RANGE');
  // 边界内的极值合法
  assert.deepEqual(normalizeSubtitleStyle({ fontSizeRatio: 0.5, maxLines: 6, lineHeight: 1 }).issues, []);
});

test('U3 toAssStyle(默认) 与 render 的 buildAssDocument() 逐字段相等（720p）', () => {
  const want = parseStyleLine(buildAssDocument({ cues: [], size: STAGE }));
  const got = toAssStyle(SUBTITLE_STYLE_DEFAULTS, { stage: STAGE, canvas: STAGE, fit: 'letterbox' });

  assert.equal(got.fontName, want.fontName);
  assert.equal(got.fontSizePx, want.fontSize);
  /* R32：字号 0.045 → 0.04（参照 `s8.md`）= 28.8 → round 29。 */
  assert.equal(got.fontSizePx, 29);
  assert.equal(got.outlinePx, want.outline);
  /* R31：默认描边从 2px 收敛到参照的 1px（`outlineRatio 0.055`），这里跟着改。
     R32 基准字号变小后是 round(0.055 × 28.8 × 0.5) = 0.792，取整仍是 1px。 */
  assert.equal(got.outlinePx, 1);
  assert.equal(got.shadowPx, want.shadow);
  assert.equal(got.marginV, want.marginV);
  /* R32：MarginV 只随半行距变 —— 57.6 + (1.25−1)/2 × 28.8 = 61.2 → 61（原 62）。 */
  assert.equal(got.marginV, 61);
  assert.equal(got.marginH, want.marginL);
  assert.equal(got.primaryColour, want.primaryColour);
  assert.equal(got.outlineColour, want.outlineColour);
  assert.equal(got.backColour, want.backColour);
  assert.equal(got.alignment, want.alignment);
  assert.equal(got.weight, want.bold);
  assert.deepEqual(got.styleIssues, []);

  // 预览侧的默认值也是同一套
  const css = toCssStyle(SUBTITLE_STYLE_DEFAULTS, STAGE);
  /* S47：预览字号取整到 ASS 的 `Fontsize` —— 两边必须**逐值相等**。
     28.8 vs 29 的 0.7% 差在 400px 的行上是 3px，正是 9 格 ink 里 720p 那格的 Δw。 */
  assert.equal(css.fontSizePx, want.fontSize, '预览字号 == ASS Fontsize');
  assert.equal(css.fontSizePx, 29);
  assert.equal(css.exactFontSizePx, 28.8, '未取整的字号只作对照');
  /* 名义 text-stroke 总宽（字号 × outlineRatio）。预览**不再用它绘制**（见 U9），
     保留是因为它仍是「等价 CSS 旋钮」的对照值。 */
  assert.equal(css.strokeWidthPx, Math.round(29 * 0.055 * 100) / 100);
  assert.equal(css.strokeWidthPx, 1.6);
  /* 描边与投影：**预览是设计值、成片是画布整数**（R35 重冻，p72 的唯一真红门）。
   *
   * 旧断言写的是「逐值相等」，那是靠 `toCssDecor` 在**预览 CSS 像素**上取整凑出来的：
   * 设计值 0.792 → 1，看起来与 720p 的 ASS `Outline=1` 相等；但同一个式子放到 9:16 的
   * 预览舞台（h≈514.98，设计舞台的 0.715 倍）上，0.566 → 1 CSS px 折 **3.73 画布像素**，
   * 而成片只有 2 —— 预览描边凭空厚 86%，p72 的 Δtop 5.85/6.00 就是这么来的。
   *
   * 现在：`toCssDecor` 只做「设计 px → 预览 CSS px」的一次缩放（0.792 / 1.08），
   * 量化留给导出侧的**画布**空间（`toAssStyle` 的 round，720p 就是 1 / 1）。
   * 两者差 0.208 / 0.08 = 导出侧半步取整的必然结果，不是口径不一致。 */
  assert.equal(css.outlinePx, 0.792, '预览描边外扩 = 设计值（不按 CSS 像素取整）');
  assert.equal(got.outlinePx, 1, '成片 Outline = round(0.792 × 1.0)');
  assert.equal(css.shadowPx, 1.08, '预览投影位移 = 设计值');
  assert.equal(got.shadowPx, 1, '成片 Shadow = round(1.08 × 1.0)');
  assert.equal(css.bottomPx, 57.6);
  assert.equal(css.background, 'transparent', 'A5：预览不画底色（ASS BorderStyle 恒为 1，backColour 不生效）');
});

test('U9 预览装饰（S47）：描边环的几何 + text-shadow 组成', () => {
  /* 1) 环的几何：轴向必须精确等于半径（ink bbox 的外扩就是靠这四个点），
        任何点都不出半径（否则 bbox 会比 ASS 大），弓高 ≤0.35px（看不出多边形）。 */
  for (const radius of [1, 2, 3, 5, 9, 15, 24]) {
    const ring = cssOutlineRing(radius);
    assert.ok(ring.length >= 8 && ring.length <= CSS_OUTLINE_RING_MAX, `方向数应在 8..${CSS_OUTLINE_RING_MAX}：${ring.length}`);
    assert.equal(ring.length % 4, 0, '方向数必须是 4 的倍数（保证 0/90/180/270 四个轴向点一定在环上）');
    const maxX = Math.max(...ring.map((p) => Math.abs(p.dx)));
    const maxY = Math.max(...ring.map((p) => Math.abs(p.dy)));
    assert.ok(Math.abs(maxX - radius) < 1e-6, `r=${radius} 的横向外扩应等于半径：${maxX}`);
    assert.ok(Math.abs(maxY - radius) < 1e-6, `r=${radius} 的纵向外扩应等于半径：${maxY}`);
    const maxRadius = Math.max(...ring.map((p) => Math.hypot(p.dx, p.dy)));
    assert.ok(maxRadius <= radius + 0.01, `环上不该有点超出半径：${maxRadius} > ${radius}`);
    const sag = radius * (1 - Math.cos(Math.PI / ring.length));
    assert.ok(sag <= 0.35, `弓高应 ≤0.35px：r=${radius} sag=${sag}`);
  }
  assert.deepEqual(cssOutlineRing(0), [], '半径 0 → 没有环');
  assert.deepEqual(cssOutlineRing(-3), [], '负半径 → 没有环');

  /* 2) text-shadow 的组成：描边环 + 投影环，投影在后（后画的在下面） */
  const decor = toCssDecor(SUBTITLE_STYLE_DEFAULTS, STAGE);
  const parts = decor.textShadow.split(', ');
  /* R35：默认描边的**设计值** 0.792（不再按预览 CSS 像素 round 成 1）、投影 1.08。
     环仍是 8 向，尺寸口径没变，只是半径回到设计值。 */
  assert.equal(decor.outlinePx, 0.792);
  assert.equal(decor.shadowPx, 1.08);
  assert.equal(parts.length, 16, `720p 默认：8 向描边 + 8 向投影 = 16 条：${parts.length}`);
  /* 环从 0° 开始：第 0 条是 (+r, 0)，第 8 条（= 投影环的 0°）是 (+r+d, +d) —— 正好是右下那一条。
     R32：描边色改成参照的 rgba(0,0,0,0.84)（影子仍是 0.608，两者本来就不是同一个数）。 */
  assert.equal(parts[0], '0.792px 0px 0 rgba(0,0,0,0.84)');
  assert.equal(parts[1], '0.56px 0.56px 0 rgba(0,0,0,0.84)');
  assert.equal(parts[8], '1.87px 1.08px 0 rgba(0,0,0,0.608)');
  assert.equal(decor.fontWeight, 400);

  /* 3) bold：CSS 700 ↔ ASS Bold=-1 */
  assert.equal(toCssDecor({ bold: true }, STAGE).fontWeight, 700);
  assert.equal(toAssStyle({ bold: true }, { stage: STAGE, canvas: STAGE }).weight, -1);

  /* 4) 开关：shadowRatio 0 → 只留描边环；shadowColor 全透明 → 投影那圈不写（画了也看不见，白算） */
  assert.equal(toCssDecor({ shadowRatio: 0 }, STAGE).textShadow.split(', ').length, 8);
  assert.equal(toCssDecor({ shadowColor: 'rgba(0,0,0,0)' }, STAGE).textShadow.split(', ').length, 8);

  /* 5) 三画幅：**在「设计 px」空间比对**（R35 重冻）。
   *
   * `css.outlinePx` 已经是设计值（不取整），`ass.outlinePx` 是 `round(设计值 × 交付缩放)`
   * 的画布整数。两边折回设计空间后，差必须 ≤ 导出侧取整的半步（0.5 / 交付缩放）——
   * 这就是「预览与导出同源、只在画布空间量化一次」的可量形式。
   * 旧写法 `css.outlinePx === ass.outlinePx` 只在这两套量化碰巧同档时成立（720p/4:3），
   * 9:16 的 cover 缩放下它是靠 `toCssDecor` 的 CSS 取整凑出来的假相等。
   *
   * 注意预览吃的是**letterbox 后的舞台矩形**（1080×607.5），不是画布 1080×1920 ——
   * 直接拿画布高会让竖屏字号算成 86（P32 修掉的那个错）。 */
  for (const row of SUBTITLE_CANVAS_TABLE) {
    const canvas = row.canvas;
    const scale = Math.min(canvas.w / STAGE.w, canvas.h / STAGE.h);
    const stageRect = { w: STAGE.w * scale, h: STAGE.h * scale };
    const css = toCssStyle(SUBTITLE_STYLE_DEFAULTS, stageRect);
    const ass = toAssStyle(SUBTITLE_STYLE_DEFAULTS, { stage: STAGE, canvas });
    assert.equal(css.fontSizePx, ass.fontSizePx, `${canvas.w}×${canvas.h} 字号`);
    const designFromCss = css.outlinePx / scale;
    const designFromAss = ass.outlinePx / ass.scale;
    assert.ok(
      Math.abs(designFromCss - designFromAss) <= 0.5 / ass.scale + 1e-9,
      `${canvas.w}×${canvas.h} 描边：预览 ${designFromCss.toFixed(3)} vs 成片 ${designFromAss.toFixed(3)}（差应 ≤ 半步 ${(0.5 / ass.scale).toFixed(3)}）`
    );
    const shadowFromCss = css.shadowPx / scale;
    const shadowFromAss = ass.shadowPx / ass.scale;
    assert.ok(
      Math.abs(shadowFromCss - shadowFromAss) <= 0.5 / ass.scale + 1e-9,
      `${canvas.w}×${canvas.h} 投影：预览 ${shadowFromCss.toFixed(3)} vs 成片 ${shadowFromAss.toFixed(3)}`
    );
  }
});

test('U4 三画幅与 P32 的 byCanvas 表逐格一致', () => {
  for (const row of SUBTITLE_CANVAS_TABLE) {
    const got = toAssStyle(SUBTITLE_STYLE_DEFAULTS, { stage: STAGE, canvas: row.canvas });
    const label = `${row.canvas.w}×${row.canvas.h}`;
    assert.ok(Math.abs(got.scale - row.scale) < 1e-9, `${label} scale`);
    assert.ok(Math.abs(got.offsetY - row.offsetY) < 1e-9, `${label} offsetY`);
    assert.equal(got.fontSizePx, row.fontSizePx, `${label} fontSize`);
    assert.equal(got.outlinePx, row.outlinePx, `${label} outline`);
    assert.equal(got.marginV, row.marginV, `${label} marginV`);
    assert.deepEqual(got.playRes, row.canvas, `${label} PlayRes = 输出画布`);

    // 与 render 的 layout 路径再对一次（720p 不传 layout，其它画幅显式传）
    const ass =
      row.canvas.w === STAGE.w && row.canvas.h === STAGE.h
        ? buildAssDocument({ cues: [], size: row.canvas })
        : buildAssDocument({
            cues: [],
            size: row.canvas,
            layout: { stage: STAGE, scale: got.scale, offset: { x: got.offsetX, y: got.offsetY } }
          });
    const want = parseStyleLine(ass);
    assert.equal(got.fontSizePx, want.fontSize, `${label} 与 render fontSize`);
    assert.equal(got.marginV, want.marginV, `${label} 与 render marginV`);
    assert.equal(got.outlinePx, want.outline, `${label} 与 render outline`);
    const parsed = parseAssDocument(ass);
    assert.equal(parsed.marginV, got.marginV, `${label} 回读 marginV`);
  }
});

test('U5 旧字段名（strokeColor / strokeWidthRatio）映射到新名', () => {
  const legacy = normalizeSubtitleStyle({ strokeColor: '#112233', strokeWidthRatio: 0.2 });
  assert.deepEqual(legacy.issues, []);
  assert.equal(legacy.style.outlineColor, '#112233');
  assert.equal(legacy.style.outlineRatio, 0.2);
  assert.equal('strokeColor' in legacy.style, false, '别名归一后不应该留在样式里');

  // 同一次调用里两个名字都给：后写的赢（与对象展开的直觉一致）
  const both = normalizeSubtitleStyle({ strokeWidthRatio: 0.1, outlineRatio: 0.3 });
  assert.equal(both.style.outlineRatio, 0.3);
});

test('U6 六条预设：可序列化、default 等于默认、两两不同', () => {
  /* R30（E12-P5）：三条 → 六条。签名要带上 borderStyle / 颜色 / 双语倍率 ——
     只比「字号/描边/边距」的话，底框与高亮词会撞成同一个（都是 32/5/62）。 */
  assert.deepEqual(listSubtitlePresets(), ['default', 'outline', 'box', 'large', 'highlight', 'bilingual']);
  for (const id of listSubtitlePresets()) {
    const preset = getSubtitlePreset(id);
    assert.ok(preset);
    assert.equal(preset.id, id);
    assert.ok(preset.label.length > 0);
    // 可序列化 = 能落进工程文件
    assert.equal(JSON.parse(JSON.stringify(preset)).id, id);
  }
  const { style, issues } = resolveSubtitlePreset('default');
  assert.deepEqual(issues, []);
  assert.deepEqual(style, SUBTITLE_STYLE_DEFAULTS, 'default 是空覆盖，必须与默认逐字段相同');

  const signatures = listSubtitlePresets().map((id) => {
    const row = toAssStyle(resolveSubtitlePreset(id).style, { stage: STAGE, canvas: STAGE });
    return [
      row.fontSizePx,
      row.outlinePx,
      row.marginV,
      row.borderStyle,
      row.primaryColour,
      row.outlineColour,
      row.secondaryScale
    ].join('/');
  });
  assert.equal(new Set(signatures).size, 6, `六条预设必须互不相同：${signatures.join(' ')}`);
  assert.equal(getSubtitlePreset('nope'), null, '未知预设给 null，不悄悄回 default');
});

test('U6b 预设是「样式里的一个 id」：非法值当场拒、default 不改任何派生值', () => {
  const bad = normalizeSubtitleStyle({ preset: 'sparkle' });
  assert.equal(bad.style.preset, 'default', '非法 preset 回退默认');
  assert.deepEqual(bad.issues.map((issue) => issue.code), ['STYLE_PRESET']);

  /* 默认样式（不传 preset）与 preset:'default' 派生出的每一个 ASS 字段都必须相同 */
  const implicit = toAssStyle({}, { stage: STAGE, canvas: STAGE });
  const explicit = toAssStyle({ preset: 'default' }, { stage: STAGE, canvas: STAGE });
  /** @param {any} row */
  const pick = (row) => [
    row.fontSizePx, row.outlinePx, row.shadowPx, row.marginV, row.primaryColour,
    row.outlineColour, row.backColour, row.alignment, row.borderStyle, row.secondaryScale
  ].join('|');
  assert.equal(pick(implicit), pick(explicit));
});

test('U8 色值「非法」判据只拦像 hex/rgb 又解析不了的（R10）', () => {
  /* 写死 10 行，与任务书 §2 表逐行相同；只允许 `#zzz`、`rgb(999)` 被拒。 */
  const table = [
    ['#fff', false],
    ['rgba(0,0,0,.5)', false],
    ['#zzz', true],
    ['rgb(999)', true],
    ['white', false],
    ['red', false],
    ['transparent', false],
    ['currentColor', false],
    ['hsl(0 0% 0%)', false],
    ['var(--accent)', false]
  ];
  for (const [value, rejected] of table) {
    assert.equal(isColorRejected(value), rejected, `${value} 期望 ${rejected ? '拒' : '放行'}`);
  }
  /* 空串/非字符串一律放行（清空走 none / 由调用方判空）。 */
  assert.equal(isColorRejected(''), false);
  assert.equal(isColorRejected('   '), false);
  assert.equal(isColorRejected(null), false);
  /* 前后空格不改变判定：`  #zzz  ` 仍拒。 */
  assert.equal(isColorRejected('  #zzz  '), true);
  /* parseCssColor 自己的行为不变（不内置颜色名表）。 */
  assert.equal(parseCssColor('red'), null);
});

test('U7 颜色：ASS 是 &HAABBGGRR（BGR 顺序、alpha 取反）', () => {
  assert.deepEqual(parseCssColor('#f00'), { r: 255, g: 0, b: 0, a: 1 });
  assert.deepEqual(parseCssColor('#00ff0080'), { r: 0, g: 255, b: 0, a: 128 / 255 });
  assert.deepEqual(parseCssColor('rgba(0,0,0,0.608)'), { r: 0, g: 0, b: 0, a: 0.608 });
  assert.equal(parseCssColor('red'), null, '不内置颜色名表');
  assert.equal(parseCssColor('#12345'), null);

  assert.equal(toAssColor('#ffffff'), '&H00FFFFFF');
  assert.equal(toAssColor('#ff0000'), '&H000000FF', '红 → BBGGRR 里的 RR 在最后');
  assert.equal(toAssColor('#000000'), '&H00000000');
  assert.equal(toAssColor('transparent'), '&HFF000000', '全透明 → alpha FF');
  assert.equal(toAssColor('#0000009B'), '&H64000000', '0x9B 不透明度 ↔ ASS 0x64');
});

test('U8 fit 只认 letterbox / cover；非法值给 issue 并退回 letterbox', () => {
  const box = subtitleLayout({ stage: STAGE, canvas: { w: 1080, h: 1920 }, fit: 'letterbox' });
  assert.equal(box.scale, 0.84375);
  assert.equal(box.offsetY, 656.25);

  const cover = subtitleLayout({ stage: STAGE, canvas: { w: 1080, h: 1920 }, fit: 'cover' });
  assert.ok(Math.abs(cover.scale - 8 / 3) < 1e-12);
  assert.equal(cover.offsetY, 0);
  assert.ok(cover.offsetX < 0, 'cover 横向裁切 → offsetX 为负');

  const bad = subtitleLayout({ stage: STAGE, canvas: { w: 1080, h: 1920 }, fit: 'stretch' });
  assert.equal(bad.fit, 'letterbox');
  assert.equal(bad.issues[0]?.code, 'STYLE_FIT');
});

test('U10 行距（S50）：lineHeightPx = Fontsize × k，k=1（libass 实测），底部补偿走 textOffsetPx', () => {
  /* k 是**量出来的**，不是排版常数：libass 没有行距字段，多行按字体的 ascent+descent 堆，
     Heiti SC 加起来正好 1 em。27 格实测表在 `SUBTITLE_LINE_STEP_K` 的注释里。 */
  assert.equal(SUBTITLE_LINE_STEP_K, 1);

  const cases = [
    /* R32：0.045 → 0.04 之后三格各降 —— 720: 32.4→28.8、9:16 舞台(607.5): 27.34→24.3、4K: 97.2→86.4 */
    { stage: { w: 1280, h: 720 }, fontSize: 29 },
    { stage: { w: 1080, h: 607.5 }, fontSize: 24 },
    { stage: { w: 3840, h: 2160 }, fontSize: 86 }
  ];
  for (const item of cases) {
    const css = toCssStyle(SUBTITLE_STYLE_DEFAULTS, item.stage);
    assert.equal(css.fontSizePx, item.fontSize, `字号：${JSON.stringify(item.stage)}`);
    assert.equal(css.lineHeightPx, item.fontSize, '行距 = 字号（libass 的 1 em）');
    /* 块是底对齐的：行盒矮了 0.25em，最后一行会往下掉半行距 —— 文字要相对上移同样多 */
    assert.equal(css.textOffsetPx, Math.round((item.fontSize * 0.25 / 2) * 100) / 100, '半行距补偿');
    /* 底边距仍是纯安全区 8%：补偿不藏在 bottom 里，否则「底边距」这个字段就变味了 */
    assert.equal(css.bottomPx, Math.round(item.stage.h * 0.08 * 100) / 100, 'bottom 不含补偿');
  }

  /* 非默认行距：换算走 film-core 的 `subtitleLineStep()`（ADR-R37-03，em = lineHeight / 1.25）。
     默认 1.25 → em=1，所以上面三格与 S50 完全一致；这里只钉 1.5 / 1.0 / 1.8 三档。
     （S58 之前预览用的是 `1 + (lineHeight − 1.25)`，1.5 会给 1.25em=40px、1.8 给 1.55em —— 
      那条线性增量已经作废，改成跟权威的 em 走。） */
  const wide = toCssStyle({ lineHeight: 1.5 }, STAGE);
  assert.equal(wide.lineHeightPx, 34.8, '1.5 → 1.2em × 29');
  assert.equal(wide.textOffsetPx, 4.35, '半行距 = (1.5 − 1.2) / 2 × 29');

  const loose = toCssStyle({ lineHeight: 1.8 }, STAGE);
  assert.equal(loose.lineHeightPx, 41.76, '1.8 → 1.44em × 29');
  assert.equal(loose.textOffsetPx, 5.22);

  const tight = toCssStyle({ lineHeight: 1.0 }, STAGE);
  assert.equal(tight.lineHeightPx, 23.2, '1.0 → 0.8em × 29');
  assert.equal(tight.textOffsetPx, 2.9, '半行距 = (1.0 − 0.8) / 2 × 29');

  /* ASS 侧：MarginV 把半行距算在 61 里（R32 字号变小后从 62 落到 61） */
  assert.equal(toAssStyle(SUBTITLE_STYLE_DEFAULTS, { stage: STAGE, canvas: STAGE }).marginV, 61);
});
