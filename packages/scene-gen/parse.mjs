/**
 * 一句话 → 规格（M87-WP21，M93 搬进产品包）
 *
 * 刻意保持**小语法**（写在交接里，别当成 NLU）：
 *
 *   图表     `画个柱状图：0.42, 0.68, 0.35`      → 冒号后的数字就是系列
 *   动画     `让方块从左滑到右，关键帧 0:120, 1:520, 2.5:980`
 *   素材     `生成渐变底 #3b6ea5 → #c8e6a0，640×360，2 秒`
 *
 * 缺数据时**不报错**：按 prompt 的哈希派生一组确定默认值（同一句话永远同一组），
 * 并在返回值的 `sources` 里如实标 `default` —— 「画个柱状图」这五个字里确实没有数，
 * 假装有才是撒谎。调用方要把 `sources` 里的 `default` 变成用户可见的 warning。
 */

/** @param {unknown} value */
function stableRandom(value) {
  const text = String(value);
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.codePointAt(index) ?? 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  let state = hash === 0 ? 0x9e3779b9 : hash;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

/** @param {number} value @returns {number} */
const round3 = (value) => Number(Number(value).toFixed(3));

/**
 * @param {string} text
 * @returns {string[]}
 */
export function extractColors(text) {
  return [...String(text ?? '').matchAll(/#([0-9a-fA-F]{6})\b/g)].map((match) => `#${String(match[1]).toLowerCase()}`);
}

/**
 * `0:120, 1:520, 2.5:980` → [{t,x},…]；认全角冒号与中文逗号。
 * @param {string} text
 * @returns {Array<{ t: number, x: number }>}
 */
export function extractKeyframes(text) {
  const cleaned = String(text ?? '').replace(/，/g, ',');
  const out = [];
  for (const match of cleaned.matchAll(/(\d+(?:\.\d+)?)\s*[:：]\s*(\d+(?:\.\d+)?)/g)) {
    out.push({ t: Number(match[1]), x: Number(match[2]) });
  }
  return out;
}

/**
 * 冒号之后的那一段里的数字（图表系列）。没有冒号就整句找，但排除 `t:x` 与 `640×360` 里的。
 * @param {string} text
 * @returns {number[]}
 */
export function extractSeries(text) {
  const source = String(text ?? '').replace(/，/g, ',');
  const at = Math.max(source.lastIndexOf('：'), source.lastIndexOf(':'));
  const tail = at >= 0 ? source.slice(at + 1) : source;
  const withoutPairs = tail.replace(/#[0-9a-fA-F]{6}\b/g, ' ').replace(/\d+(?:\.\d+)?\s*[:：]\s*\d+(?:\.\d+)?/g, ' ');
  const numbers = [...withoutPairs.matchAll(/(?<![\w.])\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  return numbers.filter((value) => Number.isFinite(value));
}

/**
 * `640×360` / `640x360` / `640*360`。
 * @param {string} text
 * @returns {{ w: number, h: number } | null}
 */
export function extractSize(text) {
  const match = /(\d{2,5})\s*[×xX*]\s*(\d{2,5})/.exec(String(text ?? ''));
  return match === null ? null : { w: Number(match[1]), h: Number(match[2]) };
}

/**
 * `2 秒` / `2.5s`。
 * @param {string} text
 * @returns {number | null}
 */
export function extractSeconds(text) {
  const match = /(\d+(?:\.\d+)?)\s*(?:秒|s\b)/i.exec(String(text ?? ''));
  return match === null ? null : Number(match[1]);
}

/**
 * 按 prompt 派生一组确定默认值（同句子恒同值）。
 * @param {string} prompt
 */
function defaults(prompt) {
  const rand = stableRandom(prompt);
  const values = Array.from({ length: 5 }, () => round3(0.3 + rand() * 0.65));
  const keyframes = [
    { t: 0, x: 120 },
    { t: 1, x: 520 },
    { t: 2.5, x: 980 },
  ];
  const palette = ['#3b6ea5', '#c8e6a0', '#7a1f4f', '#f2c14e', '#2f4858', '#e07a5f'];
  const from = palette[Math.floor(rand() * palette.length) % palette.length] ?? '#3b6ea5';
  const to = palette[(palette.indexOf(from) + 3) % palette.length] ?? '#c8e6a0';
  return { values, keyframes, from, to };
}

/**
 * @typedef {'chart'|'animation'|'asset'} SceneIntent
 * @typedef {{ values?: 'prompt'|'default', keyframes?: 'prompt'|'default', colors?: 'prompt'|'default', size?: 'prompt'|'default', seconds?: 'prompt'|'default' }} SpecSources
 * @typedef {{
 *   kind: SceneIntent,
 *   spec: any,
 *   sources: SpecSources,
 * }} SpecForResult
 */

/**
 * 一句话 → 生成器能吃的规格。
 * @param {SceneIntent} kind
 * @param {string} prompt
 * @param {{ outDir?: string, stage?: { w: number, h: number }, box?: { x: number, y: number, w: number, h: number } }} [context]
 * @returns {SpecForResult}
 */
export function specFor(kind, prompt, context = {}) {
  const text = String(prompt ?? '');
  const fallback = defaults(text);
  if (kind === 'chart') {
    const series = extractSeries(text);
    const values = series.length >= 2 ? series : fallback.values;
    return {
      kind,
      spec: { values, title: '', labels: [] },
      sources: { values: series.length >= 2 ? 'prompt' : 'default' },
    };
  }
  if (kind === 'animation') {
    const parsed = extractKeyframes(text);
    const keyframes = parsed.length >= 2 ? parsed : fallback.keyframes;
    return {
      kind,
      spec: { keyframes, curve: /ease|缓动|回弹/i.test(text) ? 'ease' : 'linear' },
      sources: { keyframes: parsed.length >= 2 ? 'prompt' : 'default' },
    };
  }
  const colors = extractColors(text);
  const size = extractSize(text);
  const seconds = extractSeconds(text);
  return {
    kind: 'asset',
    spec: {
      kind: 'gradient',
      from: colors[0] ?? fallback.from,
      to: colors[1] ?? fallback.to,
      w: size?.w ?? 640,
      h: size?.h ?? 360,
      seconds: seconds ?? 2,
      box: context.box ?? {
        x: Math.round((context.stage?.w ?? 1280) / 2 - 320),
        y: Math.round((context.stage?.h ?? 720) / 2 - 180),
        w: size?.w ?? 640,
        h: size?.h ?? 360,
      },
      outDir: context.outDir,
    },
    sources: {
      colors: colors.length >= 2 ? 'prompt' : 'default',
      size: size === null ? 'default' : 'prompt',
      seconds: seconds === null ? 'default' : 'prompt',
    },
  };
}
