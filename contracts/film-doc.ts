/**
 * film.html 合同 v1.2.0
 *
 * 权威：工程目录里的 film.html 是唯一可编辑真源。
 * 严格：未知元素/属性/字段一律诊断（不静默丢弃），且**不得回写**旧文档把它改坏。
 * 保真：未修改的合法区域字节不变（layout patch）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * v1.2.0 是**纠错版**，不是功能新增。v1.1.0 及其夹具发明了一套 `data-clip` /
 * `data-track` / `data-src` / `data-at` / `data-time` / `data-fade` / `data-overrides`
 * 方言；它与计划正文（`03-文件工程与统一编辑合同.md` §1）和参考实现都**不一致**，
 * 导致读不了计划包自带的 `synthetic-film-sample/film.html`，也读不了参考的
 * `apps/desktop/bench/fixture/film.html`。以下是**唯一合法方言**，实现必须照此改。
 *
 * 1) 轨道 = `<section>`。`<body>` 只放 section；第一个 section 在最上层。
 *    section 只认标志 `hidden` / `muted` / `locked`，以及 `id|class|title|lang|dir|data-*|aria-*`
 *    （这些对影片无意义、原样保留）。其它属性 → 诊断。
 * 2) 片段 = 标签定类型：`<iframe>` 网页、`<video>` 视频、`<img>` 图片、`<audio>` 声音、
 *    `<div>` 文本（E12-P3，v1.2.0 之后的增量）。`<audio src="x.mp4">` 表示「这个视频拆出来的声音」
 *    （`sound: true`）。`<track>` **不是**片段；字幕是素材旁边的 WebVTT（`a.mp4` → `a.vtt`）。
 *    **文本片段**是唯一「内容在自己身上」的片段：`<div id="t1" time="0,6">你好</div>`，
 *    可见区间写在 `time` 属性（等价于 `src` 的 `#t=`），文字就是元素内容；`src` 可省
 *    （给 `scenes/intro.html` 时表示它挂在哪张页面上），缺 `src` 不再是 `MISSING_MEDIA`。
 * 3) 片段核心属性**不带 `data-` 前缀**：
 *    `id`（必填、全片唯一）、`src`（必填、相对路径）、`at`（时间线起点秒，缺省 0）、
 *    `speed`、`volume`、`muted`、`size`（仅网页，`1920x1080`）、`class`、
 *    `style`（CSS 声明；`left/top/width/height/rotate` 解析进 `box`，**其余声明原样保留、不诊断**
 *    —— 参考 fixture 与计划样例都用 `object-fit: cover`，不能被判成错误）、`overrides`（JSON 数组）。
 *    Studio 自有属性用 `data-link` / `data-props`（`data-*` 允许原样保留）。
 * 4) 源入出点只写在 `src` 的片段里：`src="a.mp4#t=2,6"` → `time=[2,6]`；
 *    `#t=2` → `time=[2]`（到结尾）；没有片段 → 整段。**没有 `time` 属性**。
 * 5) `overrides` 是数组，最多**一条没有 `at`** 的条目 = 片段自己的条目（放 `fade`）；
 *    带 `at` 的是层覆盖（选择器 + 同名序号）。
 * 6) `fade` 只存在片段自有覆盖里：`overrides: [{ fade: [in, out] }]`。
 *    **没有 `data-fade` 属性**；读出时 `Clip.fade` 是它派生出来的投影。
 * 7) `stage` 来自 `<meta name="viewport" content="width=W, height=H">`，缺省 1920×1080。
 *    **film.html 不存帧率**；`fps` 是项目/导出设置（缺省 30），由调用方注入。
 *
 * 兼容矩阵：任何仍与上述不一致的写法都必须在 `docs/COMPAT-MATRIX.md` 逐项写明，
 * 不得一边保留旧方言一边对用户称「与参考相同」。
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const CONTRACT_VERSION = '1.2.0';

/** 时间一律用有理数秒；禁止浮点累加计时。 */
export interface Rational {
  readonly num: number;
  readonly den: number;
}

export interface Stage {
  /** 画布像素尺寸，偶数，16..8192。来自 viewport；缺省 1920×1080。 */
  readonly w: number;
  readonly h: number;
}

export type ClipKind = 'video' | 'sound' | 'page' | 'still' | 'text';

/**
 * 片段标签 → 类型（唯一映射，不要各自维护第二张表）。
 *
 * ⚠️ **两份白名单**：这份与 `packages/film-core/film-doc.mjs` 的同名常量必须逐键相同。
 * 只改一处比不改更危险 —— `parse` 认得出、`write` 找不到反向标签会写成 `<video>`。
 * 判据：`coordination/openfilm-complete-r2/E12-P3-ACCEPTANCE.md` 的 B1（同一份量具 s190）。
 *
 * 文本片段（E12-P3）：合法写法是 `<div>`；`<text>` 只是**解析别名**（手写/SVG 习惯），
 * 写回统一成 `<div>`（见 `TAG_OF_KIND.text`）。两条都留是因为 B1 要「KIND_OF_TAG 有 text」——
 * 它逐个比标签表的**键**。
 *
 * ⚠️ 这两个对象字面量里**不要写注释**：量具 `s190` 用 `/\{([^}]*)\}/` 抠键，
 * 行内注释会跟着被当成一个键（踩过一次）。
 */
export const KIND_OF_TAG = {
  iframe: 'page',
  video: 'video',
  img: 'still',
  audio: 'sound',
  div: 'text',
  text: 'text',
} as const;
export const TAG_OF_KIND = { page: 'iframe', video: 'video', still: 'img', sound: 'audio', text: 'div' } as const;

/** 片段核心属性（**不带 `data-` 前缀**）。 */
export const CLIP_ATTRIBUTES = ['id', 'src', 'at', 'speed', 'volume', 'muted', 'size', 'class', 'style', 'overrides'] as const;

/** Studio 自有、原样保留的属性前缀（`data-link` / `data-props` 等）。 */
export const KEPT_ATTRIBUTE = /^(data-[a-z0-9-]+|aria-[a-z]+)$/;

export interface FilmBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** 圆角，可缺省。 */
  readonly r?: number;
}

/**
 * 关键帧缓动的名字（E05）。`steps-2` 编译成 CSS `steps(2, end)`，
 * 其余与 CSS `animation-timing-function` 同名同义。
 */
export type KeyframeEase = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'steps-2';

/** 编译时认的全部缓动名（`keyframes.mjs` 与类型共用一份，不各写一套）。 */
export const KEYFRAME_EASES = ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'steps-2'] as const;

/**
 * 一条关键帧（E05-P1）。
 *
 * ⚠️ **`t` 的单位是秒，且相对「片段起点」**。`OverrideEntry` 上另有一个 `t?: string`，
 * 那个是**文本**（历史命名，等于 `text` 的别名），`s`/`r` 是缩放/旋转 —— 三者与这里的
 * `t` 毫无关系。关键帧里的 `t` 只有时间这一个含义，不要拿 `OverrideEntry.t` 的语义套它。
 *
 * `style` 只允许**可插值**属性（白名单见 `packages/film-core/keyframes.mjs` 的
 * `INTERPOLABLE_PROPERTIES`）；`background-image` / `display` 一类会被 `KF_NOT_INTERPOLABLE` 拒。
 */
export interface Keyframe {
  /** 秒，相对片段起点；同一 `kf` 里严格升序、不得重复。 */
  readonly t: number;
  readonly style: Readonly<Record<string, string>>;
  /** 本帧到**下一帧**那一段的缓动（最后一帧的 ease 无意义，编译时忽略）。 */
  readonly ease?: KeyframeEase;
}

/** 层覆盖：`at` 是层在页面里的稳定定位（见 layers.ts）。 */
export interface OverrideEntry {
  readonly at: string;
  readonly n?: number;
  readonly t?: string;
  readonly s?: readonly [number, number];
  readonly r?: number;
  readonly style?: Readonly<Record<string, string>>;
  readonly lock?: true;
  readonly text?: string;
  /**
   * 关键帧序列（E05-P1）：**≥2 条**、`t` 严格升序、`t` 单位秒且相对片段起点。
   *
   * 缺省 = 静态覆盖（与 v1.2.0 行为逐字节相同）。一旦给了 `kf`，同一元素的同一属性
   * 不得再出现在静态 `style`（或 `s`/`r` 对应的 `scale`/`rotate`）里 —— 那是
   * `KF_STATIC_CONFLICT`，在**写盘前**就拒，不留到渲染时才发现。
   */
  readonly kf?: readonly Keyframe[];

  /**
   * 描边（E05-P3 前置）：`color` 必填，`width` 为像素（0–64，缺省 1）。
   *
   * 取值规则见 `packages/film-core/text-style.mjs`：颜色只收 `#rgb/#rgba/#rrggbb/#rrggbbaa`
   * 与 `rgb()/rgba()/hsl()/hsla()`，其余（命名色、`var()`、`url()`）→ `STROKE_INVALID`。
   * 写盘形态：`"stroke":{"color":"#ffcc00","width":2}`。渲染成 `-webkit-text-stroke` +
   * `paint-order: stroke fill`（描边落在字形外，不啃字）。
   */
  readonly stroke?: { readonly color: string; readonly width?: number };

  /**
   * 底框（E05-P3 前置）：文本后面那块色块。`color` 必填，`padX`/`padY`/`radius` 像素 0–200。
   *
   * 非法 → `BG_INVALID`。写盘形态：
   * `"bg":{"color":"#000000cc","padX":12,"padY":6,"radius":4}` -->
   * `background-color` + `padding` + `border-radius`。
   */
  readonly bg?: { readonly color: string; readonly padX?: number; readonly padY?: number; readonly radius?: number };

  /** 对齐（E05-P3 前置）：四选一，其余 → `ALIGN_INVALID`。写盘 `"align":"center"`。 */
  readonly align?: 'left' | 'center' | 'right' | 'justify';

  /** 字距（E05-P3 前置）：像素，−50…400（可小数），其余 → `TRACKING_INVALID`。写盘 `"tracking":1.5`。 */
  readonly tracking?: number;
}

/**
 * 片段自有覆盖：`overrides` 里**没有 `at`** 的那一条（至多一条）。
 * 目前只承载 `fade`，将来新增片段级属性也放这里，不要退回 `data-*`。
 */
export interface ClipOwnOverride {
  readonly fade?: readonly [number, number];
}

export type ClipOverride = OverrideEntry | ClipOwnOverride;

/** 判断一条覆盖是不是「片段自有」（没有 `at`）。 */
export function isOwnOverride(entry: ClipOverride): entry is ClipOwnOverride {
  return !('at' in entry) || (entry as OverrideEntry).at === undefined;
}

export interface Clip {
  readonly id: string;
  /** 相对工程目录的文件路径；**文本片段**可以为空串（它没有媒体文件）。 */
  readonly src: string;
  /** 类型由标签 + 文件扩展名决定；读出时可用来校验。 */
  readonly kind?: ClipKind;
  /**
   * 文本片段的**内容**（`<div id="t1" time="0,6">你好</div>` 里的「你好」，去掉首尾空白）。
   * 只有 `kind === 'text'` 会有；改它走 `fields: { text }` 或 `props: { prop: 'text' }`，
   * 落盘只替换元素内部的文本，不碰属性区。
   */
  readonly text?: string;
  /** `<audio>` 指向视频文件 = 该视频的声音。 */
  readonly sound?: true;
  /** 影片时间线上的起点（秒）；缺省 0。 */
  readonly at?: number;
  /** 源内裁剪 [from, to]，秒；来自 `src` 的 `#t=` 片段，**不是**属性。 */
  readonly time?: readonly [number, number];
  readonly speed?: number;
  readonly volume?: number;
  readonly muted?: true;
  /** 仅网页片段：布局尺寸 `WxH`。 */
  readonly size?: { readonly w: number; readonly h: number };
  readonly box?: FilmBox;
  /** `overrides` 属性：片段自有条目 + 层条目。 */
  readonly overrides?: readonly ClipOverride[];
  /** `data-link`：同一组一起移动/裁剪/分割。 */
  readonly link?: string;
  /**
   * 淡入淡出 [in, out]，秒。**投影**：读自 `overrides` 里无 `at` 的条目，
   * 写回时也必须写回那里，不得落成 `data-fade`。
   */
  readonly fade?: readonly [number, number];
  readonly attrs?: Readonly<Record<string, string>>;
}

export interface Track {
  /** 由 section 顺序派生（0 在最上层），不是属性。 */
  readonly index: number;
  /** 由片段类型派生（画面/声音/网页），不是属性。字幕不是轨道类型：它是旁挂 VTT。 */
  readonly role: 'picture' | 'audio' | 'subtitle' | 'page';
  /** 来自 section 的 `id|class|title` 等；缺失则无。 */
  readonly name?: string;
  readonly locked?: boolean;
  readonly hidden?: boolean;
  readonly muted?: boolean;
  readonly clips: readonly Clip[];
}

export interface FilmDoc {
  readonly stage: Stage;
  /**
   * 项目/导出设置，**不从 film.html 读**。解析器不填时由调用方注入（缺省 30/1）。
   * 参考实现同样是 `render.opts.fps ?? 30`，文档里没有帧率。
   */
  readonly fps: Rational;
  readonly tracks: readonly Track[];
  /** 源文件内容哈希（sha256），用作修订号。 */
  readonly sourceHash: string;
}

/** 诊断码：稳定、可判定、可写进验收。 */
export type FilmDiagnosticCode =
  | 'FILM_NOT_FOUND'
  | 'FILM_UNREADABLE'
  | 'UNKNOWN_ELEMENT'
  | 'UNKNOWN_ATTRIBUTE'
  | 'UNKNOWN_FIELD'
  | 'BAD_TIME'
  | 'TIME_PAST_END'
  | 'TIME_INVERTED'
  | 'BAD_SPEED'
  | 'BAD_STAGE'
  | 'DUPLICATE_CLIP_ID'
  | 'TRACK_ROLE_CONFLICT'
  | 'PAGE_WITHOUT_DURATION'
  | 'MISSING_MEDIA'
  /** v1.2.0：`data-clip` / `data-at` 一类旧方言；报错并给出正确写法。 */
  | 'LEGACY_DIALECT'
  /**
   * E05-P1 关键帧：五条拒绝 + 静态冲突，各一个稳定码（实现见 `packages/film-core/keyframes.mjs`）。
   * R12 只把它们加进了 `film-doc.mjs` 的 `DIAGNOSTIC_CODES`，联合类型漏了 —— R15 补齐。
   */
  | 'KF_TOO_SHORT'
  | 'KF_ORDER'
  | 'KF_PROPS_MISMATCH'
  | 'KF_NOT_INTERPOLABLE'
  | 'KF_OUT_OF_RANGE'
  | 'KF_STATIC_CONFLICT'
  /** E05-P3 前置：文本样式四键的非法值（规则见 `packages/film-core/text-style.mjs`）。 */
  | 'STROKE_INVALID'
  | 'BG_INVALID'
  | 'ALIGN_INVALID'
  | 'TRACKING_INVALID';

export interface FilmDiagnostic {
  readonly code: FilmDiagnosticCode;
  /** 人可读、带位置（文件:行 或 `#id`）。 */
  readonly message: string;
  readonly severity: 'error' | 'warning';
  readonly path?: string;
  readonly clipId?: string;
}

/** 真实媒体时长未知时用 null；不得用 0 冒充。 */
export type NativeDuration = number | null;

/** 末端容差：film.html 写毫秒，素材可能是 2.166667s，2.167 必须接受；误差上限 1ms + 1e-6。 */
export const PAST_END_EPS = 0.001 + 1e-6;

export interface ParseResult {
  readonly doc: FilmDoc | null;
  readonly diagnostics: readonly FilmDiagnostic[];
  /** 解析器读到的原始字节哈希，写回时作 baseRevision。 */
  readonly sourceHash: string;
}

export interface WriteResult {
  readonly ok: boolean;
  /**
   * 写回后的**完整文件文本**（未修改区域与原文字节一致）。
   * 调用方拿到它就能直接落盘或回给 Agent；不需要再调一次 parse 取内容。
   * `ok=false` 时缺省或不完整，调用方不得落盘。
   */
  readonly text?: string;
  /** `text` 的 UTF-8 字节长度；与 `text` 一起返回，省得调用方再算一遍。 */
  readonly bytes?: number;
  /** 写回后的内容哈希（sha256），下一次 CAS 就用它。 */
  readonly sourceHash?: string;
  /** 写回前的哈希（= 入参 `baseHash`），便于历史记录对齐。 */
  readonly prevSourceHash?: string;
  /** `text` 是否与入参不同。true 才值得落盘/记历史。 */
  readonly changed?: boolean;
  readonly code?: 'CONFLICT' | 'INVALID' | 'IO';
  readonly diagnostics?: readonly FilmDiagnostic[];
}

/** 合同函数签名（实现由主线提供）。 */
export interface FilmDocApi {
  parse(text: string, opts?: { readonly path?: string; readonly native?: Readonly<Record<string, NativeDuration>> }): ParseResult;
  /**
   * 只改动指定区域，其余字节保持原样；未知字段不得被抹掉。
   * **纯函数**：不读盘、不写盘、不取时间。返回新 `text`/`sourceHash`。
   */
  write(text: string, edits: readonly FilmEdit[], baseHash: string): WriteResult;
}

/**
 * 磁盘这一侧的唯一入口（由 Studio 实现，不是解析器的一部分）。
 * 三个动作必须是一个整体：核对 → 原子写 → 记历史；任何一步失败都不能留下半份文件。
 */
export interface FilmDocIo {
  /** 读原始字节与哈希；哈希就是修订号。 */
  read(path: string): Promise<{ text: string; sourceHash: string; mtimeMs: number }>;
  /**
   * CAS 落盘：磁盘当前哈希必须等于 `expectedHash`，否则 `CONFLICT` 且**不写**。
   * 实现要求：同目录临时文件 → fsync → rename；写完回读校验哈希。
   */
  commit(
    path: string,
    text: string,
    expectedHash: string,
  ): Promise<{ ok: true; sourceHash: string } | { ok: false; code: 'CONFLICT' | 'IO'; actualHash?: string }>;
}

/** 结构化最小改动：按片段 id + 字段，而不是整份重排。 */
export interface FilmEdit {
  readonly clipId: string;
  readonly field: keyof Clip | 'overrides';
  readonly value: unknown;
}
