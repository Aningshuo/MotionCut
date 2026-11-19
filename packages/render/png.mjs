/**
 * 最小 PNG 编解码（P31）。
 *
 * 为什么自己写：逐帧判透明要读 240~900 张 `frame-%06d.png` 的 alpha 通道，
 * 而仓库里没有 PNG 解析器。两条候选路线各有问题：
 * - 调 ffmpeg 解码成 rawvideo：每帧 8.3MB（1080×1920）/33MB（4K）走管道，
 *   900 帧 4K 要过 30GB 内存带宽，纯属浪费；
 * - 新增 `pngjs` 之类的依赖：锁文件不许动（任务书 §2）。
 *
 * 所以只实现**我们真的会遇到的那一种 PNG**：Chromium `page.screenshot()` 的输出，
 * 即 bitDepth=8、非隔行、colorType 6（RGBA）或 2（RGB）。别的形态直接报
 * `PNG_UNSUPPORTED`，不猜。
 *
 * 编码只用于「把预览覆盖层合成到静帧上」（P32 的同帧对照），
 * 走 filter=0 + zlib 默认压缩，输出合法但体积不优化。
 */

import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** @type {Uint32Array | null} */
let crcTable = null;

function getCrcTable() {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

/**
 * @param {Buffer} buf
 * @returns {number}
 */
export function crc32(buf) {
  const table = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = (table[(c ^ (buf[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export class PngError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'PngError';
    this.code = code;
  }
}

/**
 * @typedef {{ width: number, height: number, channels: 1 | 2 | 3 | 4, data: Buffer }} PngImage
 */

/**
 * 解 PNG → 原始像素（alpha 在 channels=4 时位于每像素第 4 字节）。
 * @param {Buffer} buffer
 * @returns {PngImage}
 */
export function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new PngError('PNG_INVALID', 'not a PNG (bad signature)');
  }
  let offset = 8;
  /** @type {{ width: number, height: number, bitDepth: number, colorType: number, interlace: number } | null} */
  let header = null;
  /** @type {Buffer[]} */
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const bodyStart = offset + 8;
    const body = buffer.subarray(bodyStart, bodyStart + length);
    if (type === 'IHDR') {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8] ?? 0,
        colorType: body[9] ?? 0,
        interlace: body[12] ?? 0,
      };
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset = bodyStart + length + 4; // 跳过 CRC
  }
  if (!header) throw new PngError('PNG_INVALID', 'missing IHDR');
  if (header.bitDepth !== 8) {
    throw new PngError('PNG_UNSUPPORTED', `bit depth ${header.bitDepth} is not supported (only 8)`);
  }
  if (header.interlace !== 0) throw new PngError('PNG_UNSUPPORTED', 'interlaced PNG is not supported');
  /** @type {Record<number, 1 | 2 | 3 | 4>} */
  const channelOf = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const channels = channelOf[header.colorType];
  if (!channels) throw new PngError('PNG_UNSUPPORTED', `color type ${header.colorType} is not supported`);

  const { width, height } = header;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) {
    throw new PngError('PNG_INVALID', `inflated ${raw.length}B, expected ${(stride + 1) * height}B`);
  }

  const out = Buffer.allocUnsafe(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const lineStart = y * (stride + 1) + 1;
    const outStart = y * stride;
    const prevStart = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const rawByte = raw[lineStart + x] ?? 0;
      const left = x >= channels ? (out[outStart + x - channels] ?? 0) : 0;
      const up = y > 0 ? (out[prevStart + x] ?? 0) : 0;
      const upLeft = y > 0 && x >= channels ? (out[prevStart + x - channels] ?? 0) : 0;
      let value;
      switch (filter) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = rawByte + left;
          break;
        case 2:
          value = rawByte + up;
          break;
        case 3:
          value = rawByte + ((left + up) >> 1);
          break;
        case 4: {
          // Paeth
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          value = rawByte + predictor;
          break;
        }
        default:
          throw new PngError('PNG_UNSUPPORTED', `unknown filter ${filter} on row ${y}`);
      }
      out[outStart + x] = value & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/**
 * 编 PNG（RGBA8，filter=0）。
 * @param {{ width: number, height: number, data: Buffer | Uint8Array }} image `data` 必须是 RGBA，长度 = w*h*4
 * @returns {Buffer}
 */
export function encodePng(image) {
  const { width, height } = image;
  const src = Buffer.from(image.data);
  const expected = width * height * 4;
  if (src.length !== expected) {
    throw new PngError('PNG_INVALID', `encode needs ${expected}B of RGBA, got ${src.length}B`);
  }
  const stride = width * 4;
  const raw = Buffer.allocUnsafe((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    src.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  /** @param {string} type @param {Buffer} body */
  const chunk = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), body])), 0);
    return Buffer.concat([head, body, crc]);
  };
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 把一个 PNG 的 alpha 通道压成统计量（逐帧判透明的核心）。
 *
 * `threshold` 取 250 是**容差**，不是"宽松"：alpha ∈ [250,255] 一律按不透明算，
 * 免得 8bit 舍入 / 编码噪声把一张实心帧判成"有透明"。真要抓 alpha=254 的边缘，
 * 显式传 `threshold: 255`（判据就变成"任何 <255 的像素"）。
 *
 * @param {PngImage} image
 * @param {{ threshold?: number }} [opts]
 * @returns {{ transparentPixels: number, transparentRatio: number, minAlpha: number, maxAlpha: number }}
 */
export function alphaStats(image, opts = {}) {
  const threshold = Number(opts.threshold) || 250;
  const { data, channels, width, height } = image;
  const pixels = width * height;
  if (channels !== 4) {
    // RGB 没有 alpha 通道：等价于「全不透明」，不是「读不到」
    return { transparentPixels: 0, transparentRatio: 0, minAlpha: 255, maxAlpha: 255 };
  }
  let transparent = 0;
  let min = 255;
  let max = 0;
  for (let i = 3; i < data.length; i += 4) {
    const a = data[i] ?? 0;
    if (a < min) min = a;
    if (a > max) max = a;
    if (a < threshold) transparent += 1;
  }
  return {
    transparentPixels: transparent,
    transparentRatio: Number((transparent / Math.max(1, pixels)).toFixed(6)),
    minAlpha: min,
    maxAlpha: max,
  };
}

/**
 * @param {PngImage} image
 * @param {number} x @param {number} y
 * @returns {{ r: number, g: number, b: number, a: number }}
 */
export function pixelAt(image, x, y) {
  const { data, channels, width, height } = image;
  const px = Math.max(0, Math.min(width - 1, Math.round(x)));
  const py = Math.max(0, Math.min(height - 1, Math.round(y)));
  const i = (py * width + px) * channels;
  return {
    r: data[i] ?? 0,
    g: data[i + 1] ?? 0,
    b: data[i + 2] ?? 0,
    a: channels === 4 ? (data[i + 3] ?? 0) : 255,
  };
}

/**
 * alpha 直方图（16 桶，按 256/16 分）：报告里给人看的形状，不是判据。
 * @param {PngImage} image
 * @returns {number[]} 16 个桶的像素数
 */
export function alphaHistogram(image) {
  const bins = new Array(16).fill(0);
  if (image.channels !== 4) {
    bins[15] = image.width * image.height;
    return bins;
  }
  const { data } = image;
  for (let i = 3; i < data.length; i += 4) bins[(data[i] ?? 0) >> 4] += 1;
  return bins;
}
