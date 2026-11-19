/**
 * 字幕样式 schema 与 ASS 映射（S41 · B-SUB1-R21-021）
 *
 * 这个文件回答两个问题，且**只回答这两个**：
 * 1. 用户能调什么（`SUBTITLE_STYLE_DEFAULTS` + `normalizeSubtitleStyle`）；
 * 2. 同一份样式在「预览」和「成片」上分别是什么数（`toAssStyle`）。
 *
 * ## 为什么要有它（R14-C1 的教训）
 *
 * 预览（`subtitle-overlay.mjs` 的 CSS）和烧录（`render/subtitles.mjs` 的 ASS）是两套渲染器。
 * 两套各自读一份「默认值」的话，任何一次单边改动都会变成「预览一套、成片另一套」——
 * R14-C1 那次双解析器就是这么来的（同一份 vtt，预览显示「第一句 & 你好」、成片烧出标签原文）。
 *
 * 所以默认值只在这里定义一次：`render/subtitles.mjs` 的默认产出是**对齐目标**（A1 逐字段比），
 * 本模块是**唯一**的「样式 → ASS」入口。副线2 下轮（S43）直接 `import { toAssStyle }`，
 * 不再自己算一遍字号/边距。
 *
 * ## 为什么 `fontFamily` 和 `assFontName` 是两个字段
 *
 * CSS 要的是**族列表**（缺字时逐级回退），ASS 的 `Fontname` 是**单值**。硬把它们合成一个
 * 字段就只能二选一：给列表 → ASS 里写一串逗号（libass 认不出，回退到默认字体）；
 * 给单值 → 预览丢掉回退链。所以两个字段各司其职：默认值分别是舞台的族表和族表里
 * 第一个具体的 CJK 族（`Heiti SC`，与 `render/subtitles.mjs` 的默认 Fontname 一字不差）。
 * S45 起族表**首位**就是它（ADR-R24-02），回退链只负责缺字，不再是「主字体」。 
 *
 * ## 与 P32 的关系
 *
 * `toAssStyle(style, { stage, canvas, fit })` 明确区分**舞台**（设计坐标，1280×720）和
 * **画布**（交付坐标，1080×1920 / 3840×2160 / …）：
 *
 *     scale   = min(canvas.w / stage.w, canvas.h / stage.h)   // letterbox，P32 定死
 *     offset  = (canvas - stage × scale) / 2                  // 居中留边
 *     字号    = round(stage.h × fontSizeRatio × fontScale × scale)
 *     描边    = round(stage.h × fontSizeRatio × outlineRatio × 0.5 × scale)
 *     MarginV = round((stage.h × bottomSafeRatio + 半行距) × scale + offsetY)
 *
 * 不这么算的话，竖屏上会按 1920 的高度算出 86px 的字（预览是 27px），而且落到黑边里。
 * 三画幅的逐格数值见 `SUBTITLE_CANVAS_TABLE`（验收 A2 就比这张表）。
 */

/* 行距换算的唯一权威（ADR-R37-03）：`em = lineHeight / 1.25`。
   放在 film-core 是大脑定的单一来源，预览只**消费**，不另算一套。 */
import { subtitleLineStep, subtitleLineStepPx } from '../film-core/subtitle-layout.mjs';

/** 模块版本（加字段要升次版本；删/改语义要升主版本）。 */
export const SUBTITLE_STYLE_VERSION = '1.0.0';

/**
 * 舞台默认尺寸（设计坐标）。P32 的 `scale` 就是以它为分母。
 * @type {{w: number, h: number}}
 */
export const SUBTITLE_STAGE_DEFAULT = Object.freeze({ w: 1280, h: 720 });

/**
 * 字号三档（÷ 舞台高），照参照的 `s8={sm:3.2,md:4,lg:5.2}`（百分数）。
 *
 * 为什么单列一张表而不是让调用方各写各的：参照的三个档位是**同一把尺子上的三个点**
 * （3.2 / 4 / 5.2），彼此比值为 0.8 / 1 / 1.3。我们自己只有 `fontScale` 一个倍率旋钮，
 * 若各处手写 `1.4`、`0.8` 这类数，改基准字号时会各飘各的。这里的 `md` 就是默认值，
 * `large` 预设置的 `fontScale` 由 `lg / md` 推出来（见 `SUBTITLE_PRESET_BUNDLES`）。
 *
 * @type {Readonly<{sm: number, md: number, lg: number}>}
 */
export const SUBTITLE_SIZE_TIERS = Object.freeze({
  sm: 0.032,
  md: 0.04,
  lg: 0.052
});

/**
 * 默认样式。**每一个数值都必须与 `render/subtitles.mjs` 的默认产出对得上**（验收 A1 逐字段比）。
 *
 * 字段表见 `packages/layers/README.md` 的「字幕样式字段」；这里只记由来：
 *
 * - `fontSizeRatio 0.04` / `bottomSafeRatio 0.08` / `lineHeight 1.25` /
 *   `shadowRatio 0.0015`：`bottomSafeRatio` / `lineHeight` / `shadowRatio` 与 render 的
 *   `SUBTITLE_STYLE_DEFAULTS` 同值（任务书冻结值）。
 *   **`fontSizeRatio` 是 R32 改的（原 0.045）**：参照的字号档是
 *   `s8={sm:3.2,md:4,lg:5.2}`（`/shell/dist/assets/index-CdXJvJfX.js` 字符偏移 1110753），
 *   `Ri()` 里 `sizePct:s8.md` 就是**默认 4% 画面高**（`sizePct` 是百分数，100 = 满高）。
 *   我们的 0.045 是 4.5%，同一句字大 12.5%，断行位置也跟着不同 —— 那一档没有任何出处。
 *   三档常量见 `SUBTITLE_SIZE_TIERS`（0.032 / 0.04 / 0.052），默认取 `md`。
 * - `outlineRatio 0.055`：**R31 改过**（原 0.12）。参照的字幕默认样式就是 `Sy.outline`，
 *   它的描边是 `stroke:{widthEm:.055}`（同文件字符偏移 1111150），
 *   `-webkit-text-stroke: .055em` + `paint-order: stroke fill`（同文件 1116859）。
 *   `widthEm` 与我们这个字段**同名同义**（都相对字号、都是描边带总宽），所以照抄 0.055；
 *   720p 下外扩 = round(0.055 × 28.8 × 0.5) = **1px**（原来是 2px，整整一倍）。
 *   这不是审美选择：0.12 没有任何出处，是早期按「看着够厚」拍的。
 * - `outlineColor 'rgba(0,0,0,0.84)'`：**R32 改的（原 `#000000`）**。同一个 `Sy.outline`
 *   里 `stroke:{widthEm:.055,color:"rgba(0,0,0,0.84)"}`（同文件字符偏移 1111189）——
 *   宽度和颜色本就该一起抄。R25 曾把预览从 `rgba(0,0,0,0.85)` 收到不透明黑，理由只是
 *   「成片烧的是 `&H00000000`，让预览别自己飘」；那是在没有原文的情况下二选一。
 *   现在有了原文：0.84 才是参照值，成片也跟着写 `&H29000000`（`toAssColor` 按 alpha 反写，
 *   `round((1−0.84)×255) = 41 = 0x29`），预览与成片仍是同一档，不再靠「谁迁就谁」。
 * - `shadowColor 'rgba(0,0,0,0.608)'`：对应成片写死的 `&H64000000`
 *   （ASS alpha `0x64` = 100/255 透明 → 不透明度 1 − 100/255 = 0.6078）。
 * - `color '#ffffff'` → `&H00FFFFFF`；`align 'center'` → ASS `Alignment 2`。
 * - `background 'transparent'` / `cpsWarn 17`：只影响预览（CPS 提示不写进 ASS）。
 *
 * @typedef {object} SubtitleStyle
 * @property {string} fontFamily         CSS 族列表（预览用）
 * @property {string} assFontName        ASS 单值字体名（成片用）
 * @property {number} fontSizeRatio      字号 ÷ 舞台高（三档见 `SUBTITLE_SIZE_TIERS`，默认 0.04）
 * @property {string} color              主色（CSS 颜色）
 * @property {string} outlineColor       描边色（CSS 颜色）
 * @property {number} outlineRatio       描边总宽 ÷ 字号（0.055 = 字号的 5.5%，参照 `widthEm`）
 * @property {string} shadowColor        阴影色（CSS 颜色）
 * @property {number} shadowRatio        阴影位移 ÷ 舞台高
 * @property {string} background         文字底色（预览用；ASS 走 BorderStyle，不进样式表）
 * @property {'left'|'center'|'right'} align 水平对齐
 * @property {number} lineHeight         行高倍数
 * @property {number} maxLines           最多几行（超出截断加 …）
 * @property {number} bottomSafeRatio    文字行盒底边 ÷ 舞台高
 * @property {number} fontScale          字号整体倍率（1 = 不放大）
 * @property {boolean} bold              是否加粗（ASS 走合成加粗 Bold=-1）
 * @property {number} cpsWarn            语速提示阈值（字符/秒，只提示不拦）
 * @property {string} preset             六种样式预设的 id（R30，见 `SUBTITLE_PRESET_IDS`）
 * @property {number} secondaryScale     双语第 2 行起的字号倍率（1 = 不分档）
 */
export const SUBTITLE_STYLE_DEFAULTS = Object.freeze({
  /*
   * ADR-R24-02（S45）：首位是 `Heiti SC` —— 与 ASS 的 `Fontname` 同一个族。
   *
   * 改之前是 `system-ui, -apple-system, "PingFang SC", …`：macOS 上 CJK 落 PingFang、
   * Latin 落 SF，与成片的 Heiti 每行宽度差 1.07%~2.22%（32/48/64px 实测），
   * 4K 同一句的 ink 宽差 30px。预览与成片不是同一条链，任何「参数相等」的证明都救不了。
   *
   * 回退链保留：`Heiti SC` 缺字（生僻符号/emoji）时仍有 PingFang → 雅黑 → sans-serif，
   * 不会变成方框。`assFontName` 不动，成片已交付的像素不能回头改。
   */
  fontFamily: '"Heiti SC", "PingFang SC", "Microsoft YaHei", sans-serif',
  assFontName: 'Heiti SC',
  fontSizeRatio: SUBTITLE_SIZE_TIERS.md,
  color: '#ffffff',
  outlineColor: 'rgba(0,0,0,0.84)',
  /* R31：0.12 → 0.055，参照 `Sy.outline` 的 `stroke.widthEm`（原文与偏移见上面「默认样式」段）。
     0.055 是**描边带总宽**（与 `-webkit-text-stroke-width` 同义），ASS 的 Outline 是外扩量，
     所以 `toAssStyle` 里还要乘 0.5 —— 720p：0.055 × 28.8 × 0.5 = 0.792 → round 1px。
     （R32 把基准字号 0.045 → 0.04 之后这个乘积从 0.891 落到 0.792，取整后仍是 1px。） */
  outlineRatio: 0.055,
  shadowColor: 'rgba(0,0,0,0.608)',
  shadowRatio: 0.0015,
  background: 'transparent',
  align: 'center',
  lineHeight: 1.25,
  maxLines: 2,
  bottomSafeRatio: 0.08,
  fontScale: 1,
  bold: false,
  cpsWarn: 17,
  /* R30（E12-P5）：样式预设。**只存 id，不存派生值** —— 派生值由 `applyStylePreset()`
     在渲染时算，一处改、预览与成片同时变（存一份派生值就会有两份真相）。 */
  preset: 'default',
  /* 双语：第 2 行起字号 × 这个倍率。1 = 不缩（默认样式逐像素不变）。 */
  secondaryScale: 1,
});

/**
 * 字段的取值范围。`normalizeSubtitleStyle` 用它夹：超范围的给 issue 并回退默认，**不静默裁**。
 *
 * `open` 表示下界排除（`fontSizeRatio: 0` 会让字消失，不能当合法值）。
 * @type {Record<string, {min: number, max: number, open?: boolean, integer?: boolean}>}
 */
export const SUBTITLE_STYLE_LIMITS = Object.freeze({
  fontSizeRatio: { min: 0, max: 0.5, open: true },
  outlineRatio: { min: 0, max: 1 },
  shadowRatio: { min: 0, max: 0.1 },
  bottomSafeRatio: { min: 0, max: 0.5 },
  lineHeight: { min: 1, max: 3 },
  maxLines: { min: 1, max: 6, integer: true },
  fontScale: { min: 0, max: 5, open: true },
  cpsWarn: { min: 0, max: 100 },
  secondaryScale: { min: 0.4, max: 1 }
});

/* ── 六种样式预设（R30 · E12-P5）──────────────────────────────────────────
 *
 * 预设是**样式字段的一组取值**，不是另一条渲染路径：`applyStylePreset()` 只是把
 * 这组值合并进样式，之后预览与成片仍旧各读同一份 `style`。所以：
 *   - 存盘只写 `preset` 这个 id（`{...现状, preset:'box'}` 是补丁，不是重写整条样式）；
 *   - 用户手改的字段在 `applyStylePreset` 里**赢过**预设（预设只是默认值来源）。
 *
 * 「描边」是「加粗一档」= **2px**（`outlineRatio 0.12`）：R31 把默认描边收敛到参照的
 * 0.055（1px）之后，这一档就正好落回任务书原来写的 2px，与「默认」在像素上仍然分得开。
 * （R30 之所以写成 4px，是因为当时默认自己就是 2px，写 2px 会与默认逐像素相同。）
 */
export const SUBTITLE_PRESET_IDS = Object.freeze(['default', 'outline', 'box', 'large', 'highlight', 'bilingual']);

/** @type {Readonly<Record<string, Readonly<Record<string, unknown>>>>} */
export const SUBTITLE_PRESET_BUNDLES = Object.freeze({
  default: Object.freeze({}),
  /* 描边：ASS Outline 1 → 2（720p），预览描边环半径同步 1 → 2 */
  outline: Object.freeze({ outlineRatio: 0.12 }),
  /* 底框：半透明黑底、圆角（预览走 subtitle-box 的 padding/radius，ASS 走 BorderStyle=3）。
     描边不再单独给值 —— 底框档的 `Outline` 是**框内边距**，与描边不是同一件事。 */
  box: Object.freeze({ background: 'rgba(0,0,0,0.62)' }),
  /* 大字：整档放大 1.3×（字号、行距、墨迹一起长）。
     R32 从 1.4 收敛到 1.3 —— 参照的 lg 档是 5.2% 画面高，默认（md）4%，比值正好 1.3。
     原来的 1.4 是在 0.045 基准上拍的（4.5% × 1.4 = 6.3%），既不是参照的 lg，也没有出处。
     现在 0.04 × 1.3 = 0.052，与 `SUBTITLE_SIZE_TIERS.lg` 逐位相同。 */
  large: Object.freeze({ fontScale: SUBTITLE_SIZE_TIERS.lg / SUBTITLE_SIZE_TIERS.md }),
  /* 高亮词：白底黑字（底色走同一个 background 通道，不是另一套） */
  highlight: Object.freeze({ background: '#ffffff', color: '#000000', outlineColor: '#ffffff', outlineRatio: 0 }),
  /* 双语：第 2 行起 0.72×；行数上限抬到 2 行（默认就是 2） */
  bilingual: Object.freeze({ secondaryScale: 0.72 })
});

/**
 * 背景色是不是「看得见的」（要画框 / 要写 BorderStyle=3）。
 *
 * 与 `subtitle-overlay.mjs` 的 `isVisibleBackground`、以及 ASS 的 alpha 反写同一条口径：
 * `transparent` / `none` / 空 / alpha=0 都算没有。
 *
 * @param {unknown} css
 * @returns {boolean}
 */
export function isOpaqueBackground(css) {
  const text = String(css ?? '').trim().toLowerCase();
  if (text === '' || text === 'none' || text === 'transparent' || text === 'initial') return false;
  const parsed = parseCssColor(text);
  if (parsed !== null) return parsed.a > 0;
  /* 颜色名 / var() / hsl() 交给浏览器：**认不出来不等于没有**，宁可画框也别吞掉用户的底色 */
  return true;
}

/**
 * 把 `style.preset` 展开成实际样式（预设值 + 用户手改值，用户赢）。
 *
 * 未知 id（老文件/手写 JSON 里的 typo）一律按 `default` 处理，**不抛**：
 * 归一那一步已经给过 `STYLE_PRESET` issue 了，这里再抛就等于同一次错误报两遍。
 *
 * @param {any} style 已经 `normalizeSubtitleStyle()` 过的样式
 * @returns {SubtitleStyle}
 */
export function applyStylePreset(style) {
  const key = String(style?.preset ?? 'default');
  const bundle = SUBTITLE_PRESET_BUNDLES[key] ?? SUBTITLE_PRESET_BUNDLES.default ?? {};
  return { ...style, ...bundle };
}

/** 颜色字段（解析失败 → issue + 回退默认）。 */
const COLOR_FIELDS = Object.freeze(['color', 'outlineColor', 'shadowColor', 'background']);
/** 字符串字段（空串非法）。 */
const TEXT_FIELDS = Object.freeze(['fontFamily', 'assFontName']);
/** `align` 的合法值 → ASS 对齐码（1/2/3 = 左下、中下、右下）。 */
export const SUBTITLE_ALIGN_TO_ASS = Object.freeze({ left: 1, center: 2, right: 3 });

/**
 * 旧字段名 → 新字段名。S23 冻结了 overlay 的 `strokeColor` / `strokeWidthRatio`，
 * 老宿主可能还在用；两个名字都收，语义完全一样（不产生 issue，这不是错误）。
 * @type {Record<string, string>}
 */
const FIELD_ALIASES = Object.freeze({ strokeColor: 'outlineColor', strokeWidthRatio: 'outlineRatio' });

/**
 * P32 的三画幅表（验收 A2 的对照）。数值来源：`rounds/R21/AUDIT-R21.md` 的 P32 段
 * 与 `packages/render/test/subtitles.test.mjs` 的 P32 用例，逐格手抄后由脚本复算。
 *
 * **重冻史**：
 * - R31：`outlinePx` 三格（2/2/6 → 1/1/3），默认描边 0.12 → 0.055。
 * - R32：`fontSizeRatio 0.045 → 0.04`，**字号/描边/MarginV 三项全动**：
 *   720p 32→29、1→1、62→61；9:16 27→24、1→1、708→708；4K 97→86、3→2、185→184。
 *   （MarginV 只随半行距变，半行距 = (1.25−1)/2 × 字号，所以三格各掉 1、0、1。）
 * - R32（BATCH-MAIN-R30-090，签字项）：MarginV 取整由 `round` 改 **`floor`**
 *   —— 安全区是下限，取整只能往里收。9:16 707（708.89→707 精确值是 707.8875）、
 *   4K 183（183.6）。720p 61 不变（61.2）。这张表就是「四画幅同一套规则」的落点：
 *   同一条连续值、同一个 floor，各画幅只差 scale/offsetY。
 * @type {ReadonlyArray<{canvas: {w: number, h: number}, scale: number, offsetY: number,
 *   fontSizePx: number, outlinePx: number, marginV: number}>}
 */
export const SUBTITLE_CANVAS_TABLE = Object.freeze([
  Object.freeze({
    canvas: Object.freeze({ w: 1280, h: 720 }),
    scale: 1,
    offsetY: 0,
    fontSizePx: 29,
    outlinePx: 1,
    marginV: 61
  }),
  Object.freeze({
    canvas: Object.freeze({ w: 1080, h: 1920 }),
    scale: 0.84375,
    offsetY: 656.25,
    fontSizePx: 24,
    outlinePx: 1,
    marginV: 707
  }),
  Object.freeze({
    canvas: Object.freeze({ w: 3840, h: 2160 }),
    scale: 3,
    offsetY: 0,
    fontSizePx: 86,
    outlinePx: 2,
    marginV: 183
  })
]);

/** @param {number} n @returns {number} */
function finite(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/** @param {number} n @param {number} [digits] @returns {number} */
function round(n, digits = 3) {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

/**
 * CSS 颜色 → `{r,g,b,a}`（a 为 0…1）。认 `#rgb` / `#rrggbb` / `#rrggbbaa` /
 * `rgb()` / `rgba()` / `transparent`。**不认**颜色名（`red` 这种）——库不该内置一张色表，
 * 宿主传什么都该是它能自己验证的形式；不认就给 issue，不猜。
 *
 * @param {unknown} css
 * @returns {{r: number, g: number, b: number, a: number} | null}
 */
export function parseCssColor(css) {
  if (typeof css !== 'string') return null;
  const text = css.trim().toLowerCase();
  if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const hex = /^#([0-9a-f]{3,8})$/.exec(text);
  if (hex) {
    const body = hex[1] ?? '';
    if (body.length === 3) {
      const r = Number.parseInt(body.charAt(0) + body.charAt(0), 16);
      const g = Number.parseInt(body.charAt(1) + body.charAt(1), 16);
      const b = Number.parseInt(body.charAt(2) + body.charAt(2), 16);
      return { r, g, b, a: 1 };
    }
    if (body.length === 6 || body.length === 8) {
      const r = Number.parseInt(body.slice(0, 2), 16);
      const g = Number.parseInt(body.slice(2, 4), 16);
      const b = Number.parseInt(body.slice(4, 6), 16);
      const a = body.length === 8 ? Number.parseInt(body.slice(6, 8), 16) / 255 : 1;
      return { r, g, b, a };
    }
    return null;
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(text);
  if (fn) {
    const parts = (fn[1] ?? '').split(/[,/]/).map((piece) => piece.trim()).filter((piece) => piece !== '');
    if (parts.length < 3 || parts.length > 4) return null;
    /** @type {number[]} */
    const nums = [];
    for (const [index, piece] of parts.entries()) {
      const pct = piece.endsWith('%');
      const raw = Number.parseFloat(piece);
      if (!Number.isFinite(raw)) return null;
      if (index === 3) {
        /* alpha 允许 0…1 或百分比 */
        const a = pct ? raw / 100 : raw;
        if (a < 0 || a > 1) return null;
        nums.push(a);
      } else {
        const v = pct ? (raw / 100) * 255 : raw;
        if (v < 0 || v > 255) return null;
        nums.push(Math.round(v));
      }
    }
    return { r: nums[0] ?? 0, g: nums[1] ?? 0, b: nums[2] ?? 0, a: nums[3] ?? 1 };
  }
  return null;
}

/**
 * 颜色输入是否应当**当场拒绝**（R10 / S2H-A）。
 *
 * 为什么不是「`parseCssColor` 不认识就拒」：那个函数**故意**不内置颜色名表，
 * `white` / `red` / `currentColor` / `hsl()` / `var()` 都是浏览器认的合法值。
 * 拿它当「非法」判据会把可用输入从「浏览器认的都行」缩成「只有 hex/rgb」——
 * R9 就是这么误伤的，左列 dock 从更早之前就这样。
 *
 * 判据（写死，两处共用）：
 * **拒** 当且仅当「看起来就是 hex / `rgb()` 写法」（`#` 开头或 `/^rgba?\(/i`）
 * **且** `parseCssColor` 解析不了（`#zzz`、`rgb(999)`）；
 * 其余一律**放行**交浏览器——浏览器不认时表现为「提交成功但无视觉变化」，
 * 与 R9 之前的旧行为一致，可接受。
 *
 * @param {unknown} value
 * @returns {boolean} true = 拒（调用方不发请求，给「不是合法颜色」）
 */
export function isColorRejected(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text === '') return false;
  const looksHexOrRgb = text.startsWith('#') || /^rgba?\(/i.test(text);
  if (!looksHexOrRgb) return false;
  return parseCssColor(text) === null;
}

/**
 * CSS 颜色 → ASS 的 `&HAABBGGRR`。
 *
 * ASS 的两条反直觉：分量顺序是 **BGR**，alpha 是**反的**（`00` = 完全显示、`FF` = 完全透明）。
 * 成片里默认那三组 `&H00FFFFFF` / `&H00000000` / `&H64000000` 就是这么来的。
 *
 * @param {unknown} css
 * @returns {string} 解析失败返回 `&H00000000`（调用方应当先 normalize，那时就给过 issue 了）
 */
export function toAssColor(css) {
  const parsed = parseCssColor(css);
  if (parsed === null) return '&H00000000';
  /** @param {number} n @returns {number} */
  const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
  /** @param {number} n @returns {string} */
  const hex2 = (n) => clamp(n).toString(16).toUpperCase().padStart(2, '0');
  const alpha = clamp((1 - parsed.a) * 255);
  return `&H${hex2(alpha)}${hex2(parsed.b)}${hex2(parsed.g)}${hex2(parsed.r)}`;
}

/**
 * 样式归一：缺省合并 + 范围钳制；非法值**给 issue 并回退默认**，绝不静默改。
 *
 * 返回 `{ style, issues }`（而不是直接返回 style）：调用方必须能看见「哪些字段被拒了」。
 * 静默回退是最坏的一种：用户以为改了，实际没生效。overlay 会把 issues 通过 `onError`
 * 报成 `SUBTITLE_STYLE_INVALID`（一次一条，消息里列出所有字段）。
 *
 * issue 形状：`{ code, field, value, fallback, message }`，code 见 `STYLE_ISSUE_CODES`。
 *
 * @param {unknown} [partial]
 * @returns {{style: SubtitleStyle, issues: Array<{code: string, field: string, value: unknown, fallback: unknown, message: string}>}}
 */
export function normalizeSubtitleStyle(partial) {
  /** @type {any} */
  const style = { ...SUBTITLE_STYLE_DEFAULTS };
  /** @type {Array<{code: string, field: string, value: unknown, fallback: unknown, message: string}>} */
  const issues = [];
  if (partial === undefined || partial === null) return { style, issues };
  if (typeof partial !== 'object' || Array.isArray(partial)) {
    issues.push({
      code: 'STYLE_NOT_OBJECT',
      field: '',
      value: partial,
      fallback: '默认样式',
      message: `字幕样式必须是普通对象（收到 ${Object.prototype.toString.call(partial)}）`
    });
    return { style, issues };
  }

  /** @type {Record<string, unknown>} */
  const input = {};
  for (const [rawKey, value] of Object.entries(/** @type {Record<string, unknown>} */ (partial))) {
    /* 别名（`strokeColor → outlineColor`、`strokeWidthRatio → outlineRatio`）直接归到新名。
       同一次调用里两个名字都给时**后写的那个赢**——与对象展开的直觉一致，
       也让「`{...旧样式, strokeWidthRatio: 0.2}`」这种补丁能生效。 */
    const key = FIELD_ALIASES[rawKey] ?? rawKey;
    input[key] = value;
  }

  for (const [key, value] of Object.entries(input)) {
    if (!Object.prototype.hasOwnProperty.call(SUBTITLE_STYLE_DEFAULTS, key)) {
      issues.push({
        code: 'STYLE_UNKNOWN_KEY',
        field: key,
        value,
        fallback: null,
        message: `未知的字幕样式字段「${key}」被忽略（可用字段见 README 的字幕样式表）`
      });
      continue;
    }
    const fallback = /** @type {any} */ (SUBTITLE_STYLE_DEFAULTS)[key];

    if (TEXT_FIELDS.includes(key)) {
      const text = typeof value === 'string' ? value.trim() : '';
      if (text === '') {
        issues.push({ code: 'STYLE_TYPE', field: key, value, fallback, message: `${key} 必须是非空字符串` });
        continue;
      }
      style[key] = text;
      continue;
    }

    if (key === 'align') {
      if (value !== 'left' && value !== 'center' && value !== 'right') {
        issues.push({
          code: 'STYLE_ALIGN',
          field: key,
          value,
          fallback,
          message: `align 只能是 left / center / right（收到 ${JSON.stringify(value)}）`
        });
        continue;
      }
      style[key] = value;
      continue;
    }

    if (key === 'bold') {
      if (typeof value !== 'boolean') {
        issues.push({ code: 'STYLE_TYPE', field: key, value, fallback, message: 'bold 必须是布尔值' });
        continue;
      }
      style[key] = value;
      continue;
    }

    /* 预设 id：**非法值当场拒**（调用方拿 issues 回 400），不静默落到 default */
    if (key === 'preset') {
      if (typeof value !== 'string' || !SUBTITLE_PRESET_IDS.includes(value)) {
        issues.push({
          code: 'STYLE_PRESET',
          field: key,
          value,
          fallback,
          message: `preset 只能是 ${SUBTITLE_PRESET_IDS.join(' / ')}（收到 ${JSON.stringify(value)}）`
        });
        continue;
      }
      style[key] = value;
      continue;
    }

    if (COLOR_FIELDS.includes(key)) {
      if (parseCssColor(value) === null) {
        issues.push({
          code: 'STYLE_COLOR',
          field: key,
          value,
          fallback,
          message: `${key} 不是可解析的颜色（支持 #rgb / #rrggbb / #rrggbbaa / rgb() / rgba() / transparent）`
        });
        continue;
      }
      style[key] = typeof value === 'string' ? value.trim() : fallback;
      continue;
    }

    /* 剩下的都是数值字段 */
    const limit = SUBTITLE_STYLE_LIMITS[key];
    const numeric = typeof value === 'number' ? value : Number.NaN;
    if (!Number.isFinite(numeric)) {
      issues.push({ code: 'STYLE_TYPE', field: key, value, fallback, message: `${key} 必须是有限数` });
      continue;
    }
    if (limit === undefined) {
      style[key] = numeric;
      continue;
    }
    const lowerOk = limit.open === true ? numeric > limit.min : numeric >= limit.min;
    if (!lowerOk || numeric > limit.max) {
      issues.push({
        code: 'STYLE_RANGE',
        field: key,
        value,
        fallback,
        message:
          `${key} 必须在 ${limit.open === true ? '(' : '['}${limit.min}, ${limit.max}] 之间` +
          `（收到 ${numeric}）`
      });
      continue;
    }
    if (limit.integer === true && !Number.isInteger(numeric)) {
      issues.push({ code: 'STYLE_RANGE', field: key, value, fallback, message: `${key} 必须是整数（收到 ${numeric}）` });
      continue;
    }
    style[key] = numeric;
  }

  return { style, issues };
}

/**
 * 舞台 → 画布的几何（P32）。`fit` 只认两种：
 *
 * - `letterbox`（默认）：`scale = min(...)`，整幅舞台缩进画布里居中，多出来的地方是黑边；
 * - `cover`：`scale = max(...)`，铺满画布、超出的部分被裁掉（offset 为负）。
 *
 * 不做 `stretch`：ASS 的 `Fontsize` 只有一个数，非等比缩放要么字被拉扁、要么边距对不上，
 * 与其给一个「看起来能用」的假模式，不如明确报 issue 让它退回 letterbox。
 *
 * @param {{stage?: {w: number, h: number}, canvas?: {w: number, h: number}, fit?: string}} [input]
 * @returns {{fit: 'letterbox'|'cover', scale: number, offsetX: number, offsetY: number,
 *   stage: {w: number, h: number}, canvas: {w: number, h: number},
 *   issues: Array<{code: string, field: string, value: unknown, fallback: unknown, message: string}>}}
 */
export function subtitleLayout(input = {}) {
  const stage = {
    w: finite(/** @type {any} */ (input.stage)?.w) > 0 ? finite(/** @type {any} */ (input.stage)?.w) : SUBTITLE_STAGE_DEFAULT.w,
    h: finite(/** @type {any} */ (input.stage)?.h) > 0 ? finite(/** @type {any} */ (input.stage)?.h) : SUBTITLE_STAGE_DEFAULT.h
  };
  const canvas = {
    w: finite(/** @type {any} */ (input.canvas)?.w) > 0 ? finite(/** @type {any} */ (input.canvas)?.w) : stage.w,
    h: finite(/** @type {any} */ (input.canvas)?.h) > 0 ? finite(/** @type {any} */ (input.canvas)?.h) : stage.h
  };
  /** @type {Array<{code: string, field: string, value: unknown, fallback: unknown, message: string}>} */
  const issues = [];
  /** @type {'letterbox'|'cover'} */
  let fit = 'letterbox';
  if (input.fit !== undefined && input.fit !== null) {
    if (input.fit === 'letterbox' || input.fit === 'cover') fit = input.fit;
    else {
      issues.push({
        code: 'STYLE_FIT',
        field: 'fit',
        value: input.fit,
        fallback: 'letterbox',
        message: `fit 只支持 letterbox / cover（收到 ${JSON.stringify(input.fit)}）；不支持 stretch —— ASS 的字号只有一个数`
      });
    }
  }
  const sx = canvas.w / stage.w;
  const sy = canvas.h / stage.h;
  const scale = fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
  return {
    fit,
    scale,
    offsetX: round((canvas.w - stage.w * scale) / 2, 4),
    offsetY: round((canvas.h - stage.h * scale) / 2, 4),
    stage,
    canvas,
    issues
  };
}

/**
 * 样式 → ASS 字段。**唯一的入口**（副线2 的 S43 直接 import，别再在 render 里算第二遍）。
 *
 * 算法与 `render/subtitles.mjs` 的 `assFontSizePx` / `assOutlinePx` / `assMarginVPx`
 * 逐式相同（A1 拿真产出比对），差别只有一处：这里的输入是**舞台 + 画布**，
 * 不是「一个 size 加一层 layout」。
 *
 * `outlineRatio` 是**相对字号**的描边总宽比（0.12 = 字号的 12%），与 CSS
 * `-webkit-text-stroke-width` 同一个旋钮。CSS 的描边带以字形轮廓居中（`paint-order: stroke fill`
 * 把填充盖回内侧），所以可见外扩 = 总宽的一半；libass 的 `Outline` 恰好是**外扩量**。
 * 因此换算多一个 `0.5`（`ASS_OUTLINE_CENTER_FACTOR`）——不是「ASS 只往外扩」。
 *
 * @param {any} styleInput 归一前的样式（内部会 normalize，非法值走默认并记 issue）
 * @param {{stage?: {w: number, h: number}, canvas?: {w: number, h: number}, fit?: string}} [layout]
 * @returns {{
 *   fontName: string, fontSizePx: number, outlinePx: number, shadowPx: number,
 *   marginV: number, marginH: number,
 *   primaryColour: string, outlineColour: string, backColour: string,
 *   alignment: number, lineHeight: number, weight: number,
 *   borderStyle: number, preset: string, secondaryScale: number, secondaryFontSizePx: number,
 *   scale: number, offsetX: number, offsetY: number, fit: string,
 *   playRes: {w: number, h: number}, stage: {w: number, h: number},
 *   styleIssues: Array<{code: string, field: string, value: unknown, fallback: unknown, message: string}>,
 *   style: SubtitleStyle
 * }}
 */
export function toAssStyle(styleInput, layout = {}) {
  const normalized = normalizeSubtitleStyle(styleInput ?? SUBTITLE_STYLE_DEFAULTS);
  /* 预设在这里展开：之后所有派生值（字号/描边/颜色/行距）都只读这一份 `style`，
     预览侧 `toCssStyle` 走同一个 `applyStylePreset()`，两边不会各算一套。 */
  const style = applyStylePreset(normalized.style);
  const geo = subtitleLayout(layout);

  const canvas = geo.canvas;
  const stage = geo.stage;
  const scale = geo.scale;
  const fontSize = stage.h * style.fontSizeRatio * style.fontScale;
  /* 半行距：CSS 的行盒比字号高，ASS 的 MarginV 量到行盒底边，不补这段成片会偏低（720p 实测 4.54px） */
  const halfLeading = Math.max(0, (style.lineHeight - 1) / 2) * fontSize;

  const fontSizePx = Math.max(8, Math.round(fontSize * scale));
  /* 底框（高亮词/底框）：BorderStyle=3 时 `Outline` 就是**框的内边距**（libass/VSFilter 同义），
     底色写进 OutlineColour —— 框色与描边色在 ASS 里共用这一列，所以底框档不再画描边。 */
  const boxed = isOpaqueBackground(style.background);
  const outlinePx = boxed
    ? Math.max(2, Math.round(fontSizePx * 0.16))
    : Math.max(0, Math.round(stage.h * style.fontSizeRatio * style.outlineRatio * 0.5 * scale));
  const shadowPx = boxed ? 0 : Math.max(0, Math.round(stage.h * style.shadowRatio * scale));
  /* 底边距（R32 · BATCH-MAIN-R30-090）：**四画幅共用同一个取整规则 —— 向下取整**。
   *
   * 为什么不是 `Math.round`：`bottomSafeRatio` 的语义是「画面底边**至少**留这么多」，
   * 取整只能往里收、不能往外放。round 会让字幕落到比安全区更靠外的位置 ——
   * 4:3（stage 1280×720 → 1440×1080，scale 1.5）实测精确值 91.8 → round 成 92，
   * 于是 p61 的「4:3 gap 应该 = 16:9 gap × scale」差 1.5px（实测 90 vs 期望 88.5）；
   * 9:16 的 707.89 → 707 也对（离画面底更远 0.11px，方向安全）。
   *
   * 「同一套规则」指的是：**同一份连续值**（舞台安全区 + 半行距，再乘 scale 加 offsetY）
   * 在四画幅上走同一个 `floor`，不是各画幅各自 round 一套。加 `1e-9` 只为吃掉
   * 浮点乘法的尾巴（`163.19999999999998` 应当落在 163，不该掉到 162）。 */
  const marginVExact = (stage.h * style.bottomSafeRatio + halfLeading) * scale + geo.offsetY;
  const marginV = Math.max(0, Math.floor(marginVExact + 1e-9));
  /* 水平边距：render 用 5% 舞台宽（`MarginH`）。居中排版时 libass 不看它，但写成 0 会让
     「对齐改成 left/right」时字贴到画布边上，所以照样给值。 */
  const marginH = Math.round(stage.w * 0.05 * scale);
  const secondaryRaw = Number(style.secondaryScale);
  const secondaryScale = Number.isFinite(secondaryRaw) && secondaryRaw > 0 && secondaryRaw < 1 ? secondaryRaw : 1;

  return {
    fontName: style.assFontName,
    fontSizePx,
    outlinePx,
    shadowPx,
    marginV,
    marginH,
    primaryColour: toAssColor(style.color),
    outlineColour: toAssColor(boxed ? style.background : style.outlineColor),
    backColour: toAssColor(style.shadowColor),
    alignment: SUBTITLE_ALIGN_TO_ASS[style.align] ?? 2,
    lineHeight: style.lineHeight,
    /* ASS 的 Bold=-1 是合成加粗（比真粗体更胖），默认跟舞台一样不加粗 */
    weight: style.bold ? -1 : 0,
    /* 1 = 描边+阴影；3 = 不透明底框（边框色即底框色，见上面的 outlinePx） */
    borderStyle: boxed ? 3 : 1,
    preset: style.preset,
    secondaryScale,
    secondaryFontSizePx: secondaryScale < 1 ? Math.max(8, Math.round(fontSizePx * secondaryScale)) : 0,
    scale,
    offsetX: geo.offsetX,
    offsetY: geo.offsetY,
    fit: geo.fit,
    playRes: { w: canvas.w, h: canvas.h },
    stage: { w: stage.w, h: stage.h },
    styleIssues: [...normalized.issues, ...geo.issues],
    style
  };
}

/**
 * 预览描边的方向数下限 / 上限（S47）。见 `cssOutlineRing()`。
 */
export const CSS_OUTLINE_RING_MIN = 8;
export const CSS_OUTLINE_RING_MAX = 24;

/**
 * 预览描边的方向环（屏幕 px）：**外扩恰好等于半径**，两轴都准。
 *
 * ## 为什么不用 `-webkit-text-stroke`（S47 实测，三条都是量出来的）
 *
 * 1. 可见外扩**不是** `总宽 / 2` 的固定比例：圆角拉丁字形 `0.475W`（≈0.95×W/2），
 *    CJK 带尖角字形 `0.58W ~ 0.80W`，而且**横竖不等**（4K big-caption 实测：横 0.577W、竖 0.800W）。
 *    原因是 Chrome 的 text-stroke 用 **miter** 接头：尖角按 `半宽 / sin(θ/2)` 外伸，
 *    字号越大越明显（32px 时不足 1px，134px 时竖向多出 8px）。
 * 2. `stroke-linejoin` / `stroke-linecap` 对它**完全无效**：`miter/round/butt` 五种组合
 *    的 ink bbox **逐字节相同**（实测脚本见 `scripts/s47-decor.mjs` 的 A6 对照）。
 * 3. libass 的 `Outline` 是各向外扩量、圆角、横竖相同。所以「给 text-stroke 乘一个系数」
 *    这条路走不通 —— 4K big-caption 需要横 `1.73×O`、竖 `1.25×O` 两个互斥的系数。
 *
 * ## 现在的做法
 *
 * 用 N 个**零模糊** `text-shadow` 把字形向外平移一圈，取并集 = 一次形态学膨胀。
 * 轴向那四个偏移恰好是 ±r，所以 ink bbox 的**外扩精确等于 r**（实测 r=2/5/15 两轴全中，
 * 见 `scripts/s47-decor.mjs` 的 A7 几何表）。令 `r = Outline` 就天然对齐成片。
 *
 * 方向数按半径取（保持 4 的倍数，保证 0°/90°/180°/270° 这四个轴向点一定在环上）：
 * 弓高 `r(1 − cos(π/N))` 在 r=4/9/20 处都不超过 0.31px，再小就只是白花钱。
 *
 * @param {number} radius 外扩半径（屏幕 px）
 * @returns {Array<{dx: number, dy: number}>}
 */
export function cssOutlineRing(radius) {
  const r = Math.max(0, finite(radius));
  if (!(r > 0)) return [];
  const n = r <= 4 ? 8 : r <= 9 ? 12 : r <= 20 ? 16 : CSS_OUTLINE_RING_MAX;
  /** @type {Array<{dx: number, dy: number}>} */
  const points = [];
  for (let i = 0; i < n; i += 1) {
    const angle = (i / n) * Math.PI * 2;
    points.push({ dx: round(Math.cos(angle) * r, 3), dy: round(Math.sin(angle) * r, 3) });
  }
  return points;
}

/**
 * 预览的 `text-shadow`：**描边环 + 投影**，一次写清。
 *
 * 顺序有意义：CSS 的 shadow 列表**先写的画在上面**，所以描边环在前、投影在后
 * （投影必须落在描边下面，否则半透明的投影会盖住描边）。
 *
 * 投影不能只画一份「字形」：libass 的 Shadow 是**描边后形状**的投影。所以投影也是
 * 一整圈环，只是整体再平移 `(shadowPx, shadowPx)` —— 并集再减去描边环，露出来的正好是
 * 右下那一条 `shadowPx` 宽的边，与成片的 bbox 增长一致（A3 的判据）。
 *
 * @param {any} styleInput
 * @param {{w: number, h: number}} stage
 * @returns {{outlinePx: number, shadowPx: number, textShadow: string, fontWeight: number, exactFontSizePx: number}}
 */
export function toCssDecor(styleInput, stage) {
  const { style: normalized } = normalizeSubtitleStyle(styleInput ?? SUBTITLE_STYLE_DEFAULTS);
  /* 预设必须在**这里**也展开：描边环半径是从 outlineRatio 算的，只展开字号不展开描边，
     会出现「字大了、环没粗」的半套预设。 */
  const style = applyStylePreset(normalized);
  const h = finite(stage?.h) > 0 ? finite(stage.h) : SUBTITLE_STAGE_DEFAULT.h;
  const width = round(h * style.fontSizeRatio * style.fontScale, 2);
  /* 与 `toAssStyle` 同一口径 —— 但**不在这里取整**（R35，p72 的唯一真红门根因）。
   *
   * 这里是「设计舞台（1280×720）上的描边外扩」，而 `h` 是**预览舞台**的高度（设计舞台的缩放版：
   * 9:16 典型 514.98 / 720 = 0.715）。取整一旦发生在这个格子上，就是拿**预览 CSS 像素**当量子：
   * 0.566 → 1，一格 1 CSS px = 3.73 画布 px，而成片的 `Outline` 只有 2 —— 预览描边凭空厚 86%，
   * 且字幕块是底对齐的，多出来的那一圈把**顶边**整块顶上去（p72 的 Δtop 5.85/6.00 就是这么来的）。
   *
   * 成片的取整发生在**画布**空间（`toAssStyle` 的 `round(… × scale)`），那是对的：交付像素是
   * 整数。预览这边只做「设计 px → 预览 CSS px」的一次缩放，把量化留给浏览器（它按设备像素
   * 抗锯齿画分数偏移）。残差 = 成片取整的半步 ≤ 0.5 画布 px ≈ 0.03 预览 CSS px（p72 的
   * `strokeParity` 量的就是这条，限 0.75）。
   *
   * 同理 `shadowPx`：720p 设计值 1.08、9:16 预览 0.772，取整成 1 CSS px（=3.73 画布）比成片的
   * 3 画布 px 还厚。阴影是**右下位移**，不参与顶边，但同一条量化错误，一起改。 */
  const outlinePx = Math.max(0, round(h * style.fontSizeRatio * style.outlineRatio * 0.5, 3));
  const shadowPx = Math.max(0, round(h * style.shadowRatio, 3));
  const parts = [];
  for (const point of cssOutlineRing(outlinePx)) {
    parts.push(`${point.dx}px ${point.dy}px 0 ${style.outlineColor}`);
  }
  if (shadowPx > 0) {
    const shadow = parseCssColor(style.shadowColor);
    /* alpha=0 的投影画了也看不见，但会让浏览器白算一整圈 —— 直接不写 */
    if (shadow && shadow.a > 0) {
      for (const point of cssOutlineRing(outlinePx)) {
        parts.push(`${round(point.dx + shadowPx, 2)}px ${round(point.dy + shadowPx, 2)}px 0 ${style.shadowColor}`);
      }
    }
  }
  return {
    outlinePx,
    shadowPx,
    textShadow: parts.length > 0 ? parts.join(', ') : 'none',
    /* ASS 的 `Bold=-1` 是合成加粗；CSS 这边用 700（实测三档宽度差见 A4） */
    fontWeight: style.bold ? 700 : 400,
    /* 未取整的字号：只用于对照（预览真正画的是整数，见 toCssStyle） */
    exactFontSizePx: width
  };
}

/**
 * 预览行距系数（S50 · B-SUB1-R25-025）：`lineHeightPx = fontSizePx × k`。
 *
 * ## 为什么是 1.0，而不是样式表里的 `lineHeight: 1.25`
 *
 * ASS 里**没有行距字段**（Style 行的 `Spacing` 是字距）。libass 排多行时按字体的
 * ascent+descent 逐行堆，Heiti SC 的这两个数加起来**恰好是 1 em** —— 所以成片的
 * 行距就是 `Fontsize`，与 `lineHeight: 1.25` 无关。CSS 那边按 1.25 排，两行就比
 * 成片高 0.25 × 字号（720p：8px，正是 R26 记的 UV-4）。
 *
 * ## 怎么标定的（`scripts/s50-block-metrics.mjs` 的 27 格）
 *
 * 用「每行内容完全相同」的 cue（同一单位句重复，由 `planSubtitleLines` 决定断点），
 * 量烧录帧的 ink 带：块高 = `(n−1) × 行距 + 单行 ink 高`，于是
 * `行距 = (块高_n − 单行ink) / (n−1)`。
 *
 * | 画幅 | 预设 | Fontsize | 实测行距（n=2 / n=3） |
 * |---|---|---|---|
 * | 720p | default / bold-outline | 32 | 32 / 32 |
 * | 720p | big-caption | 45 | 44 / 45（逐行取整，均值 44.5） |
 * | 竖屏 | default | 27 | 28 / 27（均值 27.5） |
 * | 竖屏 | bold-outline / big-caption | 27 / 38 | 27 / 27、38 / 38 |
 * | 4K | 全部 | 97 / 97 / 134 | 97 / 97、97 / 97、134 / 134 |
 *
 * 9 格里有 7 格**逐像素等于 Fontsize**，另两格的 ±0.5px 来自 libass 逐行取整
 * （它把每行的 y 舍入到整数像素，倾斜是累积的）。所以 k 取 1，不做分档拟合 ——
 * 拟合那 0.5px 等于把取整噪声写成系数，换个字号就错。
 *
 * 换了 `assFontName`（字体）就要重标：k 是**字体度量**，不是排版常数。
 */
export const SUBTITLE_LINE_STEP_K = 1;

/**
 * 样式在**某个舞台尺寸**下的 CSS 数值（预览用；与 `toAssStyle` 同一套默认值）。
 *
 * 预览不缩放画布，所以这里不算 `scale`——舞台是 1280×720 就按 1280×720 画，
 * 由舞台容器自己的 transform 负责缩到视口。这两条不要混：ASS 的 scale 是
 * 「交付画布 ÷ 舞台」，CSS 的 transform 是「视口 ÷ 舞台」，两者各自独立。
 *
 * ## 字号为什么要取整（S47）
 *
 * ASS 的 `Fontsize` 是**整数**（32、27、97、134），预览此前用未取整的 32.4。
 * 1.25% 的差在 400px 的一行上是 5px —— 9 格 ink bbox 里 720p 那格的 Δw=−4 就是这么来的
 * （`scripts/r20-acceptance.mjs` 也记过这条「既有换算差」）。预览取整之后，
 * `toCssStyle().fontSizePx` 与 `toAssStyle().fontSizePx` 在交付尺寸下**逐值相等**。
 *
 * ## 行距与底部补偿（S50）
 *
 * `lineHeightPx` 用标定过的 `SUBTITLE_LINE_STEP_K`（不是样式表的 `lineHeight`）。
 * 但**块是底对齐的**：行盒变矮，最后一行会整体下移 `(旧行盒 − 新行盒)/2`
 * —— 单行字幕会因此偏 4px。所以另给一个 `textOffsetPx`，由覆盖层把文字**相对上移**
 * 这段半行距（`position:relative` + `top`，不动布局、不改块高）：
 *
 *     textOffsetPx = (fontSize × style.lineHeight − lineHeightPx) / 2
 *
 * 这一项与 `toAssStyle` 的 `marginV` 里那半行距是同一笔账（那边是
 * `(lineHeight−1)/2 × fontSize`，加进了 MarginV），所以预览与成片的最后一行
 * 仍然对齐 —— 改行距**只影响行与行之间**，不移动块的底边，也不动 `bottomPx`（仍是安全区）。
 *
 * @param {any} styleInput
 * @param {{w: number, h: number}} stage
 * @returns {{fontSizePx: number, exactFontSizePx: number, lineHeightPx: number, textOffsetPx: number,
 *   strokeWidthPx: number, outlinePx: number, shadowPx: number, fontWeight: number,
 *   textShadow: string, bottomPx: number, sideSafePx: number, maxLines: number,
 *   textAlign: string, color: string, outlineColor: string, background: string, lineHeight: number,
 *   lineStepEm: number}}
 */
export function toCssStyle(styleInput, stage) {
  const { style } = normalizeSubtitleStyle(styleInput ?? SUBTITLE_STYLE_DEFAULTS);
  return cssStyleOf(applyStylePreset(style), stage);
}

/**
 * 样式 → 预览几何（`toCssStyle` 的最后一步；预设已在调用处展开）。
 *
 * @param {any} style 已归一 + 已展开预设的样式
 * @param {{w: number, h: number}} stage
 * @returns {{fontSizePx: number, exactFontSizePx: number, lineHeightPx: number, textOffsetPx: number,
 *   strokeWidthPx: number, outlinePx: number, shadowPx: number, fontWeight: number,
 *   textShadow: string, bottomPx: number, sideSafePx: number, maxLines: number,
 *   textAlign: string, color: string, outlineColor: string, background: string, lineHeight: number,
 *   lineStepEm: number, secondaryScale: number, preset: string|null}}
 */
function cssStyleOf(style, stage) {
  const h = finite(stage?.h) > 0 ? finite(stage.h) : SUBTITLE_STAGE_DEFAULT.h;
  const w = finite(stage?.w) > 0 ? finite(stage.w) : SUBTITLE_STAGE_DEFAULT.w;
  const exactFontSize = round(h * style.fontSizeRatio * style.fontScale, 2);
  /* 取整到 ASS 的 Fontsize 口径（最小 1px：0 号字没有意义，且会让 canvas 报 InvalidState） */
  const fontSize = Math.max(1, Math.round(exactFontSize));
  const decor = toCssDecor(style, { w, h });
  /* 行距：唯一权威是 film-core 的 `subtitleLineStep()`（ADR-R37-03），em = lineHeight / 1.25。
     自然步进仍是标定值 `SUBTITLE_LINE_STEP_K`（Heiti SC 实测 1em），所以
     **行盒 = Fontsize × K × em**：默认 1.25 → em=1 → 与 S50 的 27 格逐像素相同；
     1.8 → 1.44em、1.0 → 0.8em（旧写法 `1 + (lineHeight − 1.25)` 会给 1.55 / 0.75，是错的）。
     成片侧的 `\pos` 由副线2 P53 落，本文件不写任何 ASS 行距。 */
  const lineStep = subtitleLineStep(style);
  /* P74：像素值走 `subtitleLineStepPx()`——行距的**唯一取整点**。`lineStepEm` 一并带出去，
     覆盖层按成片字号折算时乘的是同一个 em，不再自己 `round(round(…))` 两次。 */
  const lineStepPx = subtitleLineStepPx({ style, fontSizePx: fontSize * SUBTITLE_LINE_STEP_K });
  const lineHeightPx = round(lineStepPx.px === null ? fontSize * SUBTITLE_LINE_STEP_K : lineStepPx.px, 2);
  const legacyLineHeightPx = round(fontSize * style.lineHeight, 2);
  return {
    fontSizePx: fontSize,
    exactFontSizePx: exactFontSize,
    lineHeightPx,
    /* 半行距补偿：正的 = 文字要相对块底往上挪这么多（见上面的「行距与底部补偿」） */
    textOffsetPx: round((legacyLineHeightPx - lineHeightPx) / 2, 2),
    /* 名义 text-stroke 总宽（字号 × outlineRatio）。预览**不再用它绘制**（见 cssOutlineRing），
       保留是因为它仍是「等价 CSS 旋钮」的对照值，也是 S41 起就有字段。 */
    strokeWidthPx: round(fontSize * style.outlineRatio, 2),
    outlinePx: decor.outlinePx,
    shadowPx: decor.shadowPx,
    fontWeight: decor.fontWeight,
    textShadow: decor.textShadow,
    bottomPx: round(h * style.bottomSafeRatio, 2),
    sideSafePx: round(w * 0.04, 2),
    maxLines: style.maxLines,
    textAlign: style.align,
    color: style.color,
    outlineColor: style.outlineColor,
    /* R30：底色不再是恒 transparent —— 底框 / 高亮词两个预设靠它画框（几何走
       `subtitle-box.mjs` 的 padding/radius，预览侧 `syncBoxes()` 早就支持）。 */
    background: style.background,
    preset: style.preset,
    /* 双语：第 2 行起字号 × 这个倍率（1 = 不分档，默认样式逐像素不变） */
    secondaryScale: style.secondaryScale,
    lineHeight: style.lineHeight,
    /* P74：行距的连续倍数（`lineHeight / 1.25`）。覆盖层按成片字号折算行盒时乘它，
       与成片 `\pos` 的 `fontSizePx × em` 是同一个数。 */
    lineStepEm: lineStep.em
  };
}
