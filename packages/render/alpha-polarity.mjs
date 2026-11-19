/**
 * alpha 极性（P33 / RD-026）。
 *
 * 「极性」只有两种，问题是**谁来解释**：
 *
 * - **straight（非预乘）**：像素存的是「本来什么颜色」，透明度单独记。
 *   PNG 规范就是这么定的（`tRNS`/alpha 通道与 RGB 互不相乘）。
 * - **premultiplied（预乘）**：像素存的是「这个颜色贡献多少」，RGB 已经乘过 alpha。
 *   ProRes 4444 在 Apple 的管线（FCP / Motion / Resolve 的默认导入）里按预乘解释。
 *
 * R16 我们统一写 straight —— 于是把 `.mov` 拖进 Resolve，边缘会**偏亮一圈**：
 * NLE 认为 RGB 已经乘过 alpha，合成时又乘一次，半透明像素被 `alpha²` 压暗，
 * 反过来在按 straight 解释的工具里则是我们期望的样子。没有一种写法对两边都对，
 * 所以按**交付格式的惯例**定默认值（产品决策，R21 拍板）：
 *
 * | 格式 | 默认极性 | 依据 |
 * |---|---|---|
 * | `prores4444` | premultiplied | Apple ProRes 4444 的行业惯例（NLE 交付格式） |
 * | `png-seq` | straight | PNG 规范（非预乘）；改了反而是错的 |
 *
 * `--alpha-mode` 可以显式覆盖，但**只能往 straight 的方向覆盖**：
 * PNG 序列 + premultiplied 会被拒（`E_USAGE`），因为写出预乘 PNG 等于交给下游
 * 一张「没有标记的谎言」—— 规范说非预乘，任何按规范读它的工具都会再乘一次。
 *
 * ## 预乘发生在哪一层
 *
 * 只在**送进编码器之前**的滤镜里（`premultiplyFilter()`），取帧的 PNG 一个像素都不动：
 * PNG 序列、alpha 报告、`hasAlpha` 判据看到的都还是同一份 straight 数据。
 *
 * ## 为什么先把像素升到 16bit 再乘
 *
 * ffmpeg 的 `premultiply` 在 8bit 路径上用的是 `>>8` 而不是 `/255`（快速近似），
 * 实测 `(200,100,50,255)` 会被乘成 `(199,100,50)` —— **alpha=255 的不透明像素掉 1**。
 * 这是「不许影响不透明像素」这条硬要求的直接违反。改成 `rgba64le`（16bit/通道）
 * 再乘，同一组输入得到 `(200,100,50,255)`，一个 bit 都不差（实测见
 * `test/alpha-polarity.test.mjs` 与 `evidence/p33-alpha-polarity.json`）。
 *
 * 代价是 4K 一帧要过一遍 32MB 的中间缓冲，但这一步本来就要做 RGB→YUV 的转换，
 * 实测（240 帧 4K）编码耗时增加 <8%（见 README「透明输出」的分卷表）。
 */

/** @type {ReadonlyArray<'premultiplied' | 'straight'>} */
export const ALPHA_MODES = Object.freeze(['premultiplied', 'straight']);

/**
 * 每种交付格式的**默认**极性。别把默认值写死成一种：
 * 同一个开关在不同格式下就该有不同的默认（这正是 P33 的结论）。
 * @param {'prores4444' | 'png-seq'} format
 * @returns {'premultiplied' | 'straight'}
 */
export function defaultAlphaMode(format) {
  return format === 'png-seq' ? 'straight' : 'premultiplied';
}

/**
 * `--alpha-mode` 归一：显式值优先，否则跟随格式。
 * @param {string | undefined | null} raw
 * @param {'prores4444' | 'png-seq'} format
 * @returns {'premultiplied' | 'straight'}
 */
export function resolveAlphaMode(raw, format) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return defaultAlphaMode(format);
  const text = String(raw).trim().toLowerCase();
  if (text === 'premultiplied' || text === 'premult' || text === 'pre') return 'premultiplied';
  if (text === 'straight' || text === 'unpremultiplied') return 'straight';
  const error = new Error(`--alpha-mode must be one of ${ALPHA_MODES.join('|')}, got "${raw}"`);
  error.name = 'AlphaPolarityError';
  /** @type {any} */ (error).code = 'E_USAGE';
  throw error;
}

/**
 * 预乘滤镜链（只在不透明像素不掉 bit 的前提下成立，理由见文件头）。
 *
 * `format=rgba64le` 是**必须**的：8bit 路径的 `>>8` 近似会让 alpha=255 的像素掉 1。
 * `premultiply=inplace=1` 是单输入模式（自己拿自己的 alpha 当乘数）——
 * 双输入模式要额外拉一路 `alphaextract`，多一次全帧拷贝，没有收益。
 */
export const PREMULTIPLY_FILTER = 'format=rgba64le,premultiply=inplace=1';

/**
 * 产品口径表（README「透明输出」与交接的 `alpha.polarityTable` 共用一份）。
 * `supported: false` 的行是**故意拒绝**的组合，不是没做。
 */
export function polarityTable() {
  return [
    {
      format: 'prores4444',
      mode: 'premultiplied',
      isDefault: true,
      supported: true,
      whoReadsIt: 'FCP / Motion / Resolve / Premiere 的默认导入（Apple 惯例）',
      onDisk: 'RGB 已乘 alpha；alpha=255 处与 straight 逐字节相同',
    },
    {
      format: 'prores4444',
      mode: 'straight',
      isDefault: false,
      supported: true,
      whoReadsIt: '按 straight 解释的合成器（AE 的「Straight Unmatted」、Nuke 的 unpremult）',
      onDisk: 'RGB 未乘 alpha；与 R16 P31 产物逐字节相同（`--alpha-mode straight`）',
    },
    {
      format: 'png-seq',
      mode: 'straight',
      isDefault: true,
      supported: true,
      whoReadsIt: 'PNG 规范（任何按规范读的工具）',
      onDisk: 'RGBA8，RGB 未乘 alpha',
    },
    {
      format: 'png-seq',
      mode: 'premultiplied',
      isDefault: false,
      supported: false,
      whoReadsIt: '—',
      onDisk: '拒绝：PNG 规范是非预乘，写预乘 PNG 等于给下游一张没有标记的假数据',
    },
  ];
}
