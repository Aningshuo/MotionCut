/**
 * 交付画质档（P17，ADR-R8-01 交付层）。
 *
 * 为什么需要"档"而不是一个 crf：
 * - R8 实测 4:2:0 在这条片子上有个**硬地板**：crf 从 26 一路降到 0，p99 只从 30 降到 16。
 *   色度分辨率减半造成的误差和码率无关，所以「交付层 p99≤8」在 yuv420p 下不可达。
 * - 换到 yuv444p 后，p99 才跟着 crf 走（crf 10 → 7、crf 8 → 6、crf 4 → 4、crf 0 → 2）。
 * - 因此档位映射必须同时管 `crf` 与 `pixFmt`，只调 crf 是调不到门槛的。
 *
 * 三档的口径：
 *   draft    体积最小、硬件解码兼容性最好（4:2:0），画质明显下降但整片仍可看
 *   standard 默认档，720p 必须满足 MAE≤2 且 p99≤8（ADR-R8-01）
 *   high     近无损，体积约为 standard 的 1.6 倍
 *
 * 兼容性提醒：H.264 的 yuv444p 是 High 4:4:4 Predictive profile，
 * 部分硬件解码器/老播放器不支持（浏览器、VLC、QuickTime 的软件解码没问题）。
 * 需要最大化兼容性时用 `draft`，或者后续再做「444 主线 + 420 兼容副本」的双产物导出。
 */

/** 画质档名字面量（CLI 只认这三个）。 */
export const QUALITY_NAMES = Object.freeze(['draft', 'standard', 'high']);

/** 默认档：ADR-R8-01 要求 720p 默认档满足交付层门槛。 */
export const DEFAULT_QUALITY = 'standard';

/**
 * @typedef {{ crf: number, preset: string, pixFmt: string, label: string, note: string }} QualityLevel
 */

/**
 * 每档的编码参数。`pixFmt` 不是可选项：4:2:0 有 p99 地板，见文件头。
 * @type {Readonly<Record<string, QualityLevel>>}
 */
export const QUALITY_LEVELS = Object.freeze({
  draft: Object.freeze({
    crf: 26,
    preset: 'veryfast',
    pixFmt: 'yuv420p',
    label: '草稿',
    note: '体积最小、4:2:0 硬件解码兼容性最好；文字边缘会糊，不要用于交付',
  }),
  standard: Object.freeze({
    crf: 8,
    preset: 'medium',
    pixFmt: 'yuv444p',
    label: '标准',
    note: '默认档；720p 需满足 MAE≤2 且 p99≤8，实测 p99=6（R9 证据）',
  }),
  high: Object.freeze({
    crf: 2,
    preset: 'slow',
    pixFmt: 'yuv444p',
    label: '高',
    note: '近无损；实测 p99=3，体积约为 standard 的 1.6 倍',
  }),
});

/**
 * 档名 → 参数。未知档名抛 `INVALID_QUALITY`，由 CLI 层翻成 `INVALID`（退出码 2）。
 * @param {unknown} name
 * @returns {QualityLevel & { name: string }}
 */
export function resolveQuality(name) {
  const key = typeof name === 'string' && name !== '' ? name : DEFAULT_QUALITY;
  const level = QUALITY_LEVELS[key];
  if (!level) {
    const err = new Error(
      `INVALID_QUALITY: unknown quality "${String(name)}" (expected one of ${QUALITY_NAMES.join('|')})`,
    );
    /** @type {any} */ (err).code = 'INVALID_QUALITY';
    throw err;
  }
  return { name: key, ...level };
}

/**
 * 给证据/接口用的档位清单（不含内部实现细节以外的东西）。
 * @returns {Array<{ name: string, crf: number, preset: string, pixFmt: string, label: string }>}
 */
export function describeQualities() {
  return QUALITY_NAMES.map((name) => {
    const level = /** @type {QualityLevel} */ (QUALITY_LEVELS[name]);
    return { name, crf: level.crf, preset: level.preset, pixFmt: level.pixFmt, label: level.label };
  });
}
