import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';

import {
  LookSheetError,
  composeSheet,
  cropTile,
  pixelDigest,
  planSheetTimes,
  sheetPng,
  sheetTimes,
  toRgbaImage,
} from '../look-sheet.mjs';
import { crc32, decodePng } from '../png.mjs';

/**
 * 纯色小图：拼格/裁切/编码都只跟 RGBA 有关，不需要真素材。
 * @param {number} width @param {number} height @param {number} seed
 */
function solid(width, height, seed) {
  const data = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const i = index * 4;
    data[i] = (seed * 37) % 256;
    data[i + 1] = (seed * 59) % 256;
    data[i + 2] = (seed * 83) % 256;
    data[i + 3] = 255;
  }
  return { width, height, channels: /** @type {const} */ (4), data };
}

/**
 * 取末格（数组越界读成 NaN，断言里马上就红，不会静默通过）。
 * @param {number[]} values
 * @returns {number}
 */
function lastOf(values) {
  return values[values.length - 1] ?? Number.NaN;
}

/** 逐像素比：拼格是整像素拷贝，必须一个字节都不差。 */
/**
 * @param {{ width: number, height: number, data: Buffer }} actual
 * @param {{ width: number, height: number, data: Buffer }} expected
 * @param {string} label
 */
function assertSameImage(actual, expected, label) {
  assert.equal(actual.width, expected.width, `${label}: width`);
  assert.equal(actual.height, expected.height, `${label}: height`);
  assert.equal(actual.data.length, expected.data.length, `${label}: byte length`);
  assert.ok(actual.data.equals(expected.data), `${label}: pixel bytes differ`);
}

/**
 * 手工拼一个 RGB（color type 2）PNG —— `encodePng` 只出 RGBA，这条分支要自己造输入。
 * @param {number} width @param {number} height @param {number[]} pixels RGB 三元组按行展开
 */
function rgbPng(width, height, pixels) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width * 3; x += 1) {
      raw[y * (width * 3 + 1) + 1 + x] = pixels[y * width * 3 + x] ?? 0;
    }
  }
  /** @param {string} type @param {Buffer} body */
  const chunk = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), body])), 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('sheetTimes: 末格是区间最后一帧（end − 1/fps），不是 end', () => {
  const times = sheetTimes(0, 3, 4, { fps: 30 });
  const last = lastOf(times);
  assert.equal(times.length, 4);
  assert.equal(times[0], 0);
  assert.ok(Math.abs(last - (3 - 1 / 30)) < 1e-6, `末格 ${last} 应为 2.966667`);
  /* 旧公式 `start + (end-start)*i/count` 的末格是 2.25，比最后一帧早 0.72 秒。 */
  assert.ok(last > 2.9);
});

test('sheetTimes: 12 帧的片段正好一格一帧，首尾都落在帧上', () => {
  const plan = planSheetTimes({ start: 0, end: 0.4, count: 12, fps: 30 });
  assert.equal(plan.effective, 12);
  assert.equal(plan.truncated, false);
  assert.equal(plan.degenerate, false);
  assert.equal(plan.times[0], 0);
  assert.equal(lastOf(plan.times), Number((0.4 - 1 / 30).toFixed(6)));
  /* 12 格跨 11 个步长，每步正好 1/30 —— 短片段上「末格」等价于最后一帧本身。 */
  const step = plan.step ?? Number.NaN;
  assert.ok(Math.abs(step - 1 / 30) < 1e-6, `step=${step}`);
});

test('sheetTimes: 长区间抽 12 格时末格贴着结尾，旧公式会差 5 秒以上', () => {
  const plan = planSheetTimes({ start: 0, end: 65, count: 12, fps: 30 });
  const last = lastOf(plan.times);
  assert.equal(plan.times.length, 12);
  assert.ok(Math.abs(last - (65 - 1 / 30)) < 1e-6);
  /* 旧写法每格 = 65 / 12 = 5.4167s，末格 59.583s —— 最后 5.4 秒（162 帧）根本没被看到。 */
  const legacyLast = 0 + (65 - 0) * 11 / 12;
  assert.ok(legacyLast < 60, `旧公式末格 ${legacyLast}`);
  assert.ok(last - legacyLast > 5, '新写法必须把末格推到结尾附近');
});

test('sheetTimes: 非整数 fps（29.97）仍以 end − 1/fps 收尾', () => {
  const plan = planSheetTimes({ start: 0, end: 10, count: 12, fps: 29.97 });
  const last = lastOf(plan.times);
  assert.equal(plan.times.length, 12);
  assert.ok(Math.abs(last - (10 - 1 / 29.97)) < 1e-6, `末格 ${last}`);
  for (let index = 1; index < plan.times.length; index += 1) {
    const previous = plan.times[index - 1] ?? Number.NaN;
    const current = plan.times[index] ?? Number.NaN;
    assert.ok(current > previous, `第 ${index} 格没有严格递增`);
  }
});

test('sheetTimes: count = 1 只取起点，不造出 end 那一格', () => {
  const plan = planSheetTimes({ start: 1.5, end: 9, count: 1, fps: 30 });
  assert.deepEqual(plan.times, [1.5]);
  assert.equal(plan.effective, 1);
  assert.equal(plan.step, null);
  assert.equal(plan.truncated, false);
});

test('sheetTimes: 区间短于一帧时如实退化，不硬凑格数', () => {
  const plan = planSheetTimes({ start: 2, end: 2.02, count: 12, fps: 30 });
  assert.equal(plan.degenerate, true);
  assert.equal(plan.effective, 1);
  assert.deepEqual(plan.times, [2]);
  assert.equal(plan.truncated, true);
  assert.equal(plan.lastFrameTime, 2);
});

test('sheetTimes: 要求格数超过帧数时夹到帧数，且没有重复时间戳', () => {
  const plan = planSheetTimes({ start: 0, end: 0.4, count: 20, fps: 30 });
  assert.equal(plan.requested, 20);
  assert.equal(plan.effective, 12, '0.4s @30fps 只有 12 帧，不能造 20 格');
  assert.equal(plan.truncated, true);
  assert.equal(new Set(plan.times).size, plan.times.length);
  /* 这条是硬要求：重复格子会让「末格是不是倒数第二格的复制」这个判据失效。 */
  assert.ok(Math.abs(lastOf(plan.times) - (0.4 - 1 / 30)) < 1e-6);
});

test('sheetTimes: 相邻严格递增且无重复（多组区间扫一遍）', () => {
  const cases = [
    { start: 0, end: 1, count: 12, fps: 30 },
    { start: 0.3, end: 4.7, count: 7, fps: 24 },
    { start: 12, end: 12.5, count: 5, fps: 25 },
    { start: 0, end: 600, count: 12, fps: 60 },
    { start: 5, end: 5.5, count: 3, fps: 30 },
    { start: 0, end: 10, count: 12, fps: 29.97 },
  ];
  for (const input of cases) {
    const plan = planSheetTimes(input);
    assert.ok(plan.times.length >= 1);
    assert.equal(plan.times[0], Number(input.start.toFixed(6)), `${JSON.stringify(input)} 首格`);
    assert.equal(new Set(plan.times).size, plan.times.length, `${JSON.stringify(input)} 有重复`);
    for (let index = 1; index < plan.times.length; index += 1) {
      const previous = plan.times[index - 1] ?? Number.NaN;
      const current = plan.times[index] ?? Number.NaN;
      assert.ok(current > previous, `${JSON.stringify(input)} 第 ${index} 格`);
    }
    if (plan.degenerate) continue;
    /* 只有 1 格时不存在「末格」——那 1 格是起点，不拿 end − 1/fps 去要求它。 */
    if (plan.effective < 2) continue;
    assert.ok(
      Math.abs(lastOf(plan.times) - (input.end - 1 / (input.fps ?? 30))) <= 1e-3,
      `${JSON.stringify(input)} 末格偏差超 1e-3`,
    );
  }
});

test('sheetTimes: 非法区间直接抛，不做静默钳制', () => {
  assert.throws(() => sheetTimes(3, 3, 5), (err) => err instanceof LookSheetError && err.code === 'INVALID_RANGE');
  assert.throws(() => sheetTimes(4, 3, 5), (err) => err instanceof LookSheetError && err.code === 'INVALID_RANGE');
  assert.throws(() => sheetTimes(Number.NaN, 3, 5), (err) => err instanceof LookSheetError && err.code === 'INVALID_RANGE');
});

test('composeSheet / cropTile: 整像素往返，最后一格在右下角', () => {
  const tiles = [solid(4, 3, 1), solid(4, 3, 2), solid(4, 3, 3)];
  const composed = composeSheet(tiles, { cols: 2 });
  assert.equal(composed.cols, 2);
  assert.equal(composed.rows, 2);
  assert.equal(composed.image.width, 8);
  assert.equal(composed.image.height, 6);
  for (const [index, tile] of tiles.entries()) {
    assertSameImage(cropTile(composed.image, composed, index), tile, `第 ${index} 格`);
  }
});

test('composeSheet: 尺寸不一致的格子直接拒绝（不许暗地缩放）', () => {
  assert.throws(
    () => composeSheet([solid(4, 3, 1), solid(5, 3, 2)]),
    (err) => err instanceof LookSheetError && err.code === 'INVALID',
  );
  assert.throws(() => composeSheet([]), (err) => err instanceof LookSheetError && err.code === 'INVALID');
});

test('pixelDigest: 只认像素，不认 PNG 编码', () => {
  const a = solid(3, 2, 7);
  const b = solid(3, 2, 7);
  const c = solid(3, 2, 8);
  assert.equal(pixelDigest(a), pixelDigest(b));
  assert.notEqual(pixelDigest(a), pixelDigest(c));
  /* 同一份像素编两次必须同一串字节：证据里的 sha 才能当「同一帧」的判据。 */
  assert.ok(sheetPng(a).equals(sheetPng(b)));
  const back = decodePng(sheetPng(a));
  assert.equal(back.width, 3);
  assert.equal(back.height, 2);
  assert.ok(back.data.equals(a.data));
});

test('toRgbaImage: 四通道原样返回，三通道补成不透明', () => {
  const rgba = solid(2, 2, 3);
  const kept = toRgbaImage(sheetPng(rgba));
  assert.equal(kept.channels, 4);
  assert.ok(kept.data.equals(rgba.data));

  /* RGB（PNG color type 2）走补 alpha 的分支：仓库里的编码器只出 RGBA，
     所以这里手工拼一个最小的 RGB PNG，保证那条路真的被执行到。 */
  const rgb = rgbPng(2, 1, [1, 2, 3, 4, 5, 6]);
  const widened = toRgbaImage(rgb);
  assert.equal(widened.width, 2);
  assert.equal(widened.height, 1);
  assert.equal(widened.channels, 4);
  assert.deepEqual([...widened.data], [1, 2, 3, 255, 4, 5, 6, 255]);
});
