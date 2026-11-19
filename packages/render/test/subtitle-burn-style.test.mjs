/**
 * P37：烧录样式只认 S41 的 `toAssStyle()`。
 *
 * 这一组钉三件事：
 * 1. **默认零漂移**：三画幅的 ASS 冻结在这里（sha 写死，改一行就会红）。
 *    R31 重冻过一次：默认描边 0.12 → 0.055（对齐参照 `Sy.outline` 的 `stroke.widthEm`），
 *    三格 sha 全变、字节数不变（`2`→`1` 只换一个字符）。旧值留在 git 历史 `3fe64154` 的这行。
 *    R32 再重冻一次：字号 0.045 → 0.04（参照 `s8.md`）+ 描边色 `#000000` → `rgba(0,0,0,0.84)`
 *    （参照同一个 `Sy.outline.stroke.color`）。三格 sha 全变，**字节数仍 739/741/743** ——
 *    `32→29`、`62→61`、`&H00000000→&H29000000` 都不换位数。两轮独立生成逐位相同。
 * 2. **新字段真的生效**：颜色/对齐/描边/安全区逐字段对「期望 vs 实际」；
 * 3. **两个 outlineRatio 同名不同义**：旧入口按画面高、新入口按字号，三条数值并列。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  SUBTITLE_STYLE_DEFAULTS as RENDER_DEFAULTS,
  buildAssDocument,
  parseAssDocument,
  parseStyleArg,
  resolveAssStyleFields,
} from '../subtitles.mjs';
import { SUBTITLE_STYLE_DEFAULTS as CANONICAL_DEFAULTS } from '../../layers/subtitle-style.mjs';

const CUES = [
  { index: 1, startSec: 0.5, endSec: 2, text: '第一句 你好', id: null },
  { index: 2, startSec: 3, endSec: 4.2, text: 'second line', id: null },
];

/** @param {string} text */
function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** @param {string} ass */
function styleLine(ass) {
  return ass.split('\n').find((line) => line.startsWith('Style:')) ?? '';
}

/** @param {string} ass */
function styleFields(ass) {
  // Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour,
  //         Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle,
  //         Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
  const body = styleLine(ass).slice('Style: Default,'.length);
  const f = body.split(',');
  return {
    fontName: f[0],
    fontSize: Number(f[1]),
    primaryColour: f[2],
    outlineColour: f[4],
    backColour: f[5],
    bold: Number(f[6]),
    outline: Number(f[15]),
    shadow: Number(f[16]),
    alignment: Number(f[17]),
    marginL: Number(f[18]),
    marginR: Number(f[19]),
    marginV: Number(f[20]),
  };
}

test('P37-A1：三画幅默认 ASS 与 R22 逐字节相同（sha 表）', () => {
  /* R32（BATCH-MAIN-R30-090）：MarginV 取整由 `round` 改 `floor`（安全区是下限，
     取整只能往里收）→ 非 720p 两格的 MarginV 各掉 1（708→707、184→183），
     字节数不变、只有 Style 行里那个数字变，所以另两格的 sha 换了。
     720p 一个字节都没动（MarginV 61 = floor(61.2)），它仍是 R22 的原值。 */
  /** @type {Array<[string, {w: number, h: number}, any, string, number]>} */
  const rows = [
    ['720p', { w: 1280, h: 720 }, null, 'a83c7b4e252602a323bb7a20edb4f46dfff18cc00173787d9435908e3a3d525b', 739],
    [
      '1080x1920（letterbox）',
      { w: 1080, h: 1920 },
      { stage: { w: 1280, h: 720 }, fit: 'letterbox' },
      '760351487eab367f1b5c30e4bc648f085266b8a71a106c5b6694cc99e42e0dc9',
      741,
    ],
    [
      '3840x2160',
      { w: 3840, h: 2160 },
      { stage: { w: 1280, h: 720 }, fit: 'letterbox' },
      '3232bc056f63f9b091e8d7cbf51d2914ccf0fe16e8555d2761ed15c4b39a098e',
      743,
    ],
  ];
  for (const [name, size, layout, wantSha, wantBytes] of rows) {
    const ass = buildAssDocument({ cues: CUES, size, ...(layout ? { layout } : {}) });
    assert.equal(Buffer.byteLength(ass, 'utf8'), wantBytes, `${name} 字节数`);
    assert.equal(sha256(ass), wantSha, `${name} sha256`);
  }
});

test('P37-A1：默认 720p 的 Style 行逐字符不变（整行）', () => {
  const ass = buildAssDocument({ cues: CUES, size: { w: 1280, h: 720 } });
  /* R32 整行重冻：字号 32→29（0.045→0.04）、OutlineColour &H00000000→&H29000000
     （rgba(0,0,0,0.84)）、MarginV 62→61（半行距跟着字号变小）。Outline 仍 1、Shadow 仍 1。 */
  assert.equal(
    styleLine(ass),
    'Style: Default,Heiti SC,29,&H00FFFFFF,&H000000FF,&H29000000,&H64000000,0,0,0,0,100,100,0,0,1,1,1,2,64,64,61,1',
  );
  assert.deepEqual(styleFields(ass), {
    fontName: 'Heiti SC',
    fontSize: 29,
    primaryColour: '&H00FFFFFF',
    outlineColour: '&H29000000',
    backColour: '&H64000000',
    bold: 0,
    outline: 1,
    shadow: 1,
    alignment: 2,
    marginL: 64,
    marginR: 64,
    marginV: 61,
  });
});

test('P37-A2：自定义字段逐项生效（颜色/对齐/描边/安全区/字重）', () => {
  const ass = buildAssDocument({
    cues: CUES,
    size: { w: 1280, h: 720 },
    subtitleStyle: { color: '#ffcc00', align: 'left', outlineRatio: 0.22, bottomSafeRatio: 0.15, bold: true },
  });
  const f = styleFields(ass);
  const expected = {
    primaryColour: '&H0000CCFF',
    alignment: 1,
    /* R32：0.22 × 28.8 × 0.5 = 3.168 → 3（基准字号从 32.4 降下来，这一档跟着掉 1px） */
    outline: 3,
    /* R32：720×0.15 + (1.25−1)/2×28.8 = 108 + 3.6 = 111.6 → floor 111（round 会给 112） */
    marginV: 111,
    bold: -1,
  };
  assert.deepEqual(
    {
      primaryColour: f.primaryColour,
      alignment: f.alignment,
      outline: f.outline,
      marginV: f.marginV,
      bold: f.bold,
    },
    expected,
  );

  // 非默认颜色也要能回读：outlineColour / backColour 都跟着新 schema 走
  const colours = buildAssDocument({
    cues: [],
    size: { w: 1280, h: 720 },
    subtitleStyle: { outlineColor: '#112233', shadowColor: 'rgba(0,0,0,1)' },
  });
  assert.equal(styleFields(colours).outlineColour, '&H00332211');
  assert.equal(styleFields(colours).backColour, '&H00000000');
});

test('P37-A4：两个 outlineRatio 同名不同义（旧=画面高 / 新=字号）', () => {
  const legacy002 = styleFields(
    buildAssDocument({ cues: [], size: { w: 1280, h: 720 }, style: { outlineRatio: 0.02 } }),
  );
  const canonical002 = styleFields(
    buildAssDocument({ cues: [], size: { w: 1280, h: 720 }, subtitleStyle: { outlineRatio: 0.02 } }),
  );
  const canonical022 = styleFields(
    buildAssDocument({ cues: [], size: { w: 1280, h: 720 }, subtitleStyle: { outlineRatio: 0.22 } }),
  );

  assert.equal(legacy002.outline, 14, '旧入口 0.02 → 720×0.02 = 14.4 → 14px');
  assert.equal(canonical002.outline, 0, '新入口 0.02 → 28.8×0.02×0.5 = 0.288 → 0px');
  assert.equal(canonical022.outline, 3, '新入口 0.22 → 28.8×0.22×0.5 = 3.168 → 3px');

  // 三个字号都相同：两个入口只差描边口径，不互相影响别的字段
  assert.deepEqual(
    [legacy002.fontSize, canonical002.fontSize, canonical022.fontSize],
    [29, 29, 29],
  );
});

test('P37：两个入口同时给 → E_USAGE（不许猜）', () => {
  assert.throws(
    () => buildAssDocument({
      cues: [],
      size: { w: 1280, h: 720 },
      style: { fontSizeRatio: 0.05 },
      subtitleStyle: { fontSizeRatio: 0.06 },
    }),
    (err) => /** @type {any} */ (err).code === 'E_USAGE',
  );
});

test('P37：非法新样式 → issue + 回退默认（逐字段不静默）', () => {
  const resolved = resolveAssStyleFields({
    size: { w: 1280, h: 720 },
    subtitleStyle: { color: 'not-a-color', outlineRatio: 2, fontSizeRatio: 0 },
  });
  const fields = new Set(resolved.issues.map((issue) => issue.field));
  assert.deepEqual([...fields].sort(), ['color', 'fontSizeRatio', 'outlineRatio']);
  assert.equal(resolved.fields.primaryColour, '&H00FFFFFF');
  /* R31：默认描边 = 1px（参照 0.055em）；outlineRatio:2 越界后回退到这个默认。
     R32：基准字号 0.04 → 29px。 */
  assert.equal(resolved.fields.outlinePx, 1);
  assert.equal(resolved.fields.fontSizePx, 29);
});

test('P37：render 的旧默认值是从 S41 派生的视图，不是第二套常量', () => {
  assert.equal(RENDER_DEFAULTS.fontSizeRatio, CANONICAL_DEFAULTS.fontSizeRatio);
  assert.equal(RENDER_DEFAULTS.bottomSafeRatio, CANONICAL_DEFAULTS.bottomSafeRatio);
  assert.equal(RENDER_DEFAULTS.strokeWidthRatio, CANONICAL_DEFAULTS.outlineRatio);
  assert.equal(RENDER_DEFAULTS.shadowRatio, CANONICAL_DEFAULTS.shadowRatio);
  assert.equal(RENDER_DEFAULTS.fontFamily, CANONICAL_DEFAULTS.assFontName);
  assert.equal(RENDER_DEFAULTS.lineHeight, CANONICAL_DEFAULTS.lineHeight);
  assert.equal(RENDER_DEFAULTS.fontScale, CANONICAL_DEFAULTS.fontScale);
  assert.equal(RENDER_DEFAULTS.bold, CANONICAL_DEFAULTS.bold);
  assert.equal(RENDER_DEFAULTS.cpsWarn, CANONICAL_DEFAULTS.cpsWarn);
  assert.equal(RENDER_DEFAULTS.outlineRatio, null, '旧字段默认 null：不显式给就不参与');
});

test('P37：--subtitle-style 的 JSON / k=v 都归一到新 schema', () => {
  assert.deepEqual(parseStyleArg('{"color":"#ffcc00","align":"left"}'), { color: '#ffcc00', align: 'left' });
  assert.deepEqual(parseStyleArg('color=#ffcc00,align=left,outlineRatio=0.22'), {
    color: '#ffcc00',
    align: 'left',
    outlineRatio: 0.22,
  });
  assert.deepEqual(parseStyleArg('fontSizeRatio=0.05,bold=1'), { fontSizeRatio: 0.05, bold: true });
  assert.throws(() => parseStyleArg('{"color":'), /SUBTITLE_UNSUPPORTED/);
  assert.throws(() => parseStyleArg('null'), /SUBTITLE_UNSUPPORTED/);
});

test('P37：layout.fit=cover 的几何也走 toAssStyle（负 offsetY 不丢）', () => {
  const fields = resolveAssStyleFields({
    size: { w: 1080, h: 1920 },
    layout: { stage: { w: 1280, h: 720 }, fit: 'cover' },
  }).fields;
  // scale = max(1080/1280, 1920/720) = 2.6667；offsetY = (1920 - 720×2.6667)/2 = 0
  assert.equal(fields.scale, 2.6666666666666665);
  assert.equal(fields.offsetY, 0);
  /* R32：字号 0.04 → 720×0.04×2.6667 = 76.8 → 77；MarginV = 61.2×2.6667 = 163.2 → 163。 */
  assert.equal(fields.fontSizePx, 77);
  assert.equal(parseAssDocument(buildAssDocument({
    cues: [],
    size: { w: 1080, h: 1920 },
    layout: { stage: { w: 1280, h: 720 }, fit: 'cover' },
  })).marginV, 163);
});
