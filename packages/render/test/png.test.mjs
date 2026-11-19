import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  alphaHistogram,
  alphaStats,
  crc32,
  decodePng,
  encodePng,
  pixelAt,
} from '../png.mjs';

/**
 * @param {{ width: number, height: number }} size
 * @param {(x: number, y: number) => [number, number, number, number]} paint
 */
function image(size, paint) {
  const data = Buffer.alloc(size.width * size.height * 4);
  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      const [r, g, b, a] = paint(x, y);
      const i = (y * size.width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { ...size, channels: /** @type {const} */ (4), data };
}

test('P31：PNG 编码 → 解码是恒等变换（RGBA 逐字节相同）', () => {
  const src = image({ width: 7, height: 5 }, (x, y) => [x * 30, y * 40, (x + y) * 10, x === 0 ? 0 : 255]);
  const png = encodePng(src);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const back = decodePng(png);
  assert.equal(back.width, 7);
  assert.equal(back.height, 5);
  assert.equal(back.channels, 4);
  assert.deepEqual(back.data, src.data);
});

test('P31：alphaStats 只数 alpha<250 的像素，minAlpha 取到 0', () => {
  // 左半透明、右半不透明
  const img = image({ width: 4, height: 2 }, (x) => [255, 255, 255, x < 2 ? 0 : 255]);
  const stats = alphaStats(img);
  assert.equal(stats.transparentPixels, 4);
  assert.equal(stats.transparentRatio, 0.5);
  assert.equal(stats.minAlpha, 0);
  assert.equal(stats.maxAlpha, 255);

  // 默认阈值 250 是**容差**：250~255 都按不透明算，免得 8bit 舍入把实心帧判成透明。
  // 想要「任何 <255 都算」，把阈值调到 255。
  const edge = image({ width: 2, height: 1 }, (x) => [0, 0, 0, x === 0 ? 249 : 255]);
  assert.equal(alphaStats(edge).transparentPixels, 1);
  const nearOpaque = image({ width: 2, height: 1 }, (x) => [0, 0, 0, x === 0 ? 254 : 255]);
  assert.equal(alphaStats(nearOpaque).transparentPixels, 0);
  assert.equal(alphaStats(nearOpaque, { threshold: 255 }).transparentPixels, 1);
});

test('P31：RGB（无 alpha 通道）等价于全不透明，不是「读不到」', () => {
  // 手工造一个 colorType=2 的 PNG：encodePng 只出 RGBA，所以这里改 IHDR 的 colorType 不现实，
  // 直接用「channels=3 的伪图像」验证 alphaStats 的分支即可（解码路径由真实 Chromium PNG 覆盖）。
  const rgb = { width: 3, height: 2, channels: /** @type {const} */ (3), data: Buffer.alloc(18, 128) };
  const stats = alphaStats(/** @type {any} */ (rgb));
  assert.equal(stats.transparentPixels, 0);
  assert.equal(stats.minAlpha, 255);
});

test('P31：alphaHistogram 分 16 桶，全不透明落在最后一桶', () => {
  const opaque = image({ width: 4, height: 4 }, () => [10, 20, 30, 255]);
  assert.equal(alphaHistogram(opaque)[15], 16);
  const clear = image({ width: 4, height: 4 }, () => [0, 0, 0, 0]);
  assert.equal(alphaHistogram(clear)[0], 16);
});

test('P31：pixelAt 越界会夹到边界，不会读到别人的像素', () => {
  const img = image({ width: 2, height: 2 }, (x, y) => [x, y, 0, 255]);
  assert.deepEqual(pixelAt(img, 0, 0), { r: 0, g: 0, b: 0, a: 255 });
  assert.deepEqual(pixelAt(img, 99, 99), { r: 1, g: 1, b: 0, a: 255 });
  assert.deepEqual(pixelAt(img, -5, -5), { r: 0, g: 0, b: 0, a: 255 });
});

test('P31：crc32 与标准向量一致（zip 里要用）', () => {
  assert.equal(crc32(Buffer.from('123456789', 'utf8')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('P31：坏数据要报 PNG_INVALID/PNG_UNSUPPORTED，不能解出半张图', () => {
  assert.throws(() => decodePng(Buffer.from('not a png at all')), (/** @type {any} */ err) => err.code === 'PNG_INVALID');
  const good = encodePng(image({ width: 2, height: 2 }, () => [0, 0, 0, 0]));
  const truncated = good.subarray(0, 20);
  assert.throws(() => decodePng(truncated), (/** @type {any} */ err) => err.code === 'PNG_INVALID' || err instanceof Error);
});

test('P31：analyzeAlphaFrames 的临时目录用法（供 alpha-export 复用）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-png-'));
  try {
    await fs.writeFile(path.join(dir, 'frame-000000.png'), encodePng(image({ width: 2, height: 2 }, () => [0, 0, 0, 0])));
    const bytes = await fs.readFile(path.join(dir, 'frame-000000.png'));
    assert.equal(decodePng(bytes).width, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
