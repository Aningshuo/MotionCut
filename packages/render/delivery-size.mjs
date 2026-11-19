/**
 * 交付画幅（P24）：同一份时间线出 720p / 1080p / 竖屏 / 4K。
 *
 * 为什么不"取 1280×720 再放大"：
 * 放大只会让 1080p 变成"更糊的 720p"。舞台页本身支持等比缩放（`fit=contain`），
 * 把浏览器视口直接设成目标尺寸，文字和矢量就按 1.5×/3× 真渲染，视频由合成器缩放——
 * 这才是"真的 1080p 出片"。
 *
 * 两种 fit：
 * - `letterbox`（默认）：整幅塞进目标画幅，多出来的边用黑填。**不裁内容**。
 * - `cover`：填满目标画幅，超出的部分裁掉。做法是把视口开到 `stage × max(比例)`，
 *   舞台正好铺满，再用 ffmpeg 居中裁一刀。代价是视口像素变多（1080×1920 时
 *   3414×1920 = 6.55MP/帧），内存与耗时都会上去——由调用方的预算守卫生效。
 */

export const DELIVERY_SIZE_VERSION = '1.0.0';

/** @typedef {{ w: number, h: number }} Size */

/**
 * 常用画幅的别名（CLI 可以直接 `--size 1080p`）。
 * @type {Readonly<Record<string, Size>>}
 */
export const SIZE_PRESETS = Object.freeze({
  '720p': Object.freeze({ w: 1280, h: 720 }),
  '1080p': Object.freeze({ w: 1920, h: 1080 }),
  portrait: Object.freeze({ w: 1080, h: 1920 }),
  '4k': Object.freeze({ w: 3840, h: 2160 }),
});

/**
 * @param {number} value
 * @returns {number}
 */
function evenCeil(value) {
  const n = Math.max(2, Math.ceil(Number(value) || 0));
  return n % 2 === 0 ? n : n + 1;
}

/**
 * `--size` 归一：`1080p` / `1080x1920` / `1080×1920`。
 * 未知写法的报错要带上可用别名，别让人猜。
 * @param {string | undefined | null} raw
 * @returns {Size | null}
 */
export function parseSizeArg(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const text = String(raw).trim().toLowerCase();
  const preset = SIZE_PRESETS[text];
  if (preset) return { w: preset.w, h: preset.h };
  const match = /^(\d+)\s*[x×*]\s*(\d+)$/.exec(text);
  if (!match) {
    const names = Object.keys(SIZE_PRESETS).join('|');
    throw new Error(`INVALID_SIZE: "${raw}" is not WxH (e.g. 1080x1920) or one of ${names}`);
  }
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (!(w > 0) || !(h > 0)) throw new Error(`INVALID_SIZE: "${raw}" has a zero dimension`);
  return { w: evenCeil(w), h: evenCeil(h) };
}

/**
 * 画幅计划：输出尺寸 + 取帧视口 + 舞台 fit + 后期滤镜（cover 的裁切）。
 *
 * `vf` 与 `ffmpegVf` 的区别：
 * - `vf`：**舞台取帧**路径用。画面已经是目标尺寸，只有 cover 需要再裁一刀。
 * - `ffmpegVf`：**纯 ffmpeg 合成**路径用（工程里没有网页片段，不走舞台）。
 *   那条路的画布始终是 stage.w×stage.h，缩放/留边必须由滤镜补上。
 *
 * @param {{ stage: Size, size?: Size | null, fit?: 'letterbox' | 'cover' | string | null }} input
 * @returns {{ fit: 'none' | 'letterbox' | 'cover', output: Size, viewport: Size,
 *   stageFit: 'none' | 'contain', vf: string | null, ffmpegVf: string | null,
 *   scale: number, cropped: { x: number, y: number } | null }}
 */
export function planDelivery(input) {
  const stage = { w: evenCeil(input.stage?.w ?? 1280), h: evenCeil(input.stage?.h ?? 720) };
  const size = input.size ?? null;
  if (!size) {
    return {
      fit: 'none',
      output: stage,
      viewport: stage,
      stageFit: 'none',
      vf: null,
      ffmpegVf: null,
      scale: 1,
      cropped: null,
    };
  }
  const output = { w: evenCeil(size.w), h: evenCeil(size.h) };
  const fitRaw = typeof input.fit === 'string' && input.fit !== '' ? input.fit : 'letterbox';
  if (fitRaw !== 'letterbox' && fitRaw !== 'cover') {
    throw new Error(`INVALID_FIT: "${fitRaw}" is not letterbox|cover`);
  }

  if (fitRaw === 'letterbox') {
    return {
      fit: 'letterbox',
      output,
      viewport: { ...output },
      stageFit: 'contain',
      vf: null,
      ffmpegVf:
        `scale=${output.w}:${output.h}:force_original_aspect_ratio=decrease,` +
        `pad=${output.w}:${output.h}:(ow-iw)/2:(oh-ih)/2:color=black`,
      scale: Math.min(output.w / stage.w, output.h / stage.h),
      cropped: null,
    };
  }

  // cover：视口开到 stage×max(比例)，舞台正好铺满，再居中裁到目标画幅
  const scale = Math.max(output.w / stage.w, output.h / stage.h);
  const viewport = { w: evenCeil(stage.w * scale), h: evenCeil(stage.h * scale) };
  const x = Math.max(0, Math.round((viewport.w - output.w) / 2));
  const y = Math.max(0, Math.round((viewport.h - output.h) / 2));
  return {
    fit: 'cover',
    output,
    viewport,
    stageFit: 'contain',
    vf: `crop=${output.w}:${output.h}:${x}:${y}`,
    ffmpegVf: `scale=${output.w}:${output.h}:force_original_aspect_ratio=increase,crop=${output.w}:${output.h}`,
    scale,
    cropped: { x, y },
  };
}

/**
 * 画幅倍率说明（证据/CLI 共用）：相对 1280×720 基线的像素倍率。
 * @param {Size} size
 * @returns {{ pixels: number, vs720p: number }}
 */
export function sizeFootprint(size) {
  const pixels = Number(size.w) * Number(size.h);
  return { pixels, vs720p: Number((pixels / (1280 * 720)).toFixed(3)) };
}
