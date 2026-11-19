/**
 * P33 验收：alpha 极性。
 *
 * 验的是**数值**，不是「没报错」：
 * - 预乘后半透明像素的 RGB ≈ 原色 × alpha（三档 64/128/192，误差 ≤2/255）；
 * - alpha=255 处 RGB **一个 bit 都不许掉**（8bit `premultiply` 会掉 1，这是本批
 *   为什么要先升到 `rgba64le` 的直接原因）；
 * - alpha=0 处预乘后必须是 (0,0,0)；
 * - `--alpha-mode straight` 的产物与 R16 的口径一致（同一组参数两次导出逐字节相同）；
 * - png-seq + premultiplied 必须被拒（PNG 规范是非预乘）。
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { ALPHA_MODES, PREMULTIPLY_FILTER, defaultAlphaMode, polarityTable, resolveAlphaMode } from '../alpha-polarity.mjs';
import { writeAlphaOutput } from '../alpha-export.mjs';
import { encodePng } from '../png.mjs';

const execFileAsync = promisify(execFile);

/** 测试用的「原色」：三个通道都不一样，乘错了立刻能看出来。 */
const BASE = { r: 200, g: 100, b: 50 };

/**
 * @param {number} alpha
 * @param {{ width?: number, height?: number }} [size]
 */
function frameWithAlpha(alpha, size = { width: 16, height: 16 }) {
  const width = size.width ?? 16;
  const height = size.height ?? 16;
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = BASE.r;
    data[i + 1] = BASE.g;
    data[i + 2] = BASE.b;
    data[i + 3] = alpha;
  }
  return encodePng({ width, height, data });
}

/**
 * 写一组「每帧一个 alpha 档」的序列：0 / 64 / 128 / 192 / 255。
 * @param {string} dir
 */
async function writeAlphaLadder(dir) {
  const ladder = [0, 64, 128, 192, 255];
  await fs.mkdir(dir, { recursive: true });
  for (const [index, alpha] of ladder.entries()) {
    await fs.writeFile(path.join(dir, `frame-${String(index).padStart(6, '0')}.png`), frameWithAlpha(alpha));
  }
  return ladder;
}

/**
 * 解一帧为 RGBA（**独立解码**，不走被测代码里的解码路径）。
 * @param {string} video
 * @param {number} frame
 * @param {{ w: number, h: number }} size
 */
async function decodeFrame(video, frame, size) {
  const { stdout } = await execFileAsync(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error',
      '-i', video,
      '-vf', `select=eq(n\\,${frame})`,
      '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
    ],
    { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
  );
  const expected = size.w * size.h * 4;
  assert.equal(stdout.length, expected, `frame ${frame} decodes to ${expected}B`);
  return { r: stdout[0], g: stdout[1], b: stdout[2], a: stdout[3] };
}

/** @type {string} */
let workDir;

test.before(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-alpha-polarity-'));
});

test.after(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

test('P33：极性的默认值随格式走（不是写死一种）', () => {
  assert.deepEqual([...ALPHA_MODES], ['premultiplied', 'straight']);
  assert.equal(defaultAlphaMode('prores4444'), 'premultiplied');
  assert.equal(defaultAlphaMode('png-seq'), 'straight');
  // 显式覆盖两个方向都要能用
  assert.equal(resolveAlphaMode('straight', 'prores4444'), 'straight');
  assert.equal(resolveAlphaMode('premultiplied', 'prores4444'), 'premultiplied');
  assert.equal(resolveAlphaMode(undefined, 'png-seq'), 'straight');
  assert.equal(resolveAlphaMode('', 'prores4444'), 'premultiplied');
});

test('P33：--alpha-mode 的非法值要拒（不静默退回默认）', () => {
  assert.throws(() => resolveAlphaMode('premultipliedness', 'png-seq'), (err) => {
    assert.equal(/** @type {any} */ (err).code, 'E_USAGE');
    assert.match(/** @type {any} */ (err).message, /premultiplied\|straight/);
    return true;
  });
  // 注意 `pre` / `premult` 是别名，别拿它们当非法值
  assert.equal(resolveAlphaMode('premult', 'prores4444'), 'premultiplied');
  assert.equal(resolveAlphaMode('unpremultiplied', 'prores4444'), 'straight');
  assert.throws(() => resolveAlphaMode('straightish', 'prores4444'), /must be one of/);
});

test('P33：极性表覆盖「支持」与「故意拒绝」两类', () => {
  const rows = polarityTable();
  assert.equal(rows.length, 4);
  const defaults = rows.filter((row) => row.isDefault).map((row) => `${row.format}:${row.mode}`);
  assert.deepEqual(defaults.sort(), ['png-seq:straight', 'prores4444:premultiplied']);
  const rejected = rows.filter((row) => !row.supported);
  assert.equal(rejected.length, 1);
  const [only] = rejected;
  assert.ok(only);
  assert.equal(only.format, 'png-seq');
  assert.equal(only.mode, 'premultiplied');
});

test('P33-A1：预乘后 RGB ≈ 原色×alpha，alpha=255 一个 bit 都不掉', async () => {
  const framesDir = path.join(workDir, 'ladder');
  const ladder = await writeAlphaLadder(framesDir);
  const size = { w: 16, h: 16 };

  const prem = await writeAlphaOutput({
    outPath: path.join(workDir, 'prem.mp4'),
    format: 'prores4444',
    mode: 'premultiplied',
    framesDir,
    frames: ladder.length,
    fps: 30,
    size,
    report: { note: 'test' },
  });
  const straight = await writeAlphaOutput({
    outPath: path.join(workDir, 'straight.mp4'),
    format: 'prores4444',
    mode: 'straight',
    framesDir,
    frames: ladder.length,
    fps: 30,
    size,
    report: { note: 'test' },
  });

  assert.equal(prem.mode, 'premultiplied');
  assert.equal(straight.mode, 'straight');
  assert.equal(prem.polarity.filter, PREMULTIPLY_FILTER);
  assert.equal(straight.polarity.filter, null);
  // 预乘是「编码前那一层」的事，不改变 alpha 通道本身
  assert.match(String(prem.pixFmt), /^yuva/);
  assert.match(String(straight.pixFmt), /^yuva/);

  /** @type {Array<{ alpha: number, straight: any, prem: any, expected: number[], error: number }>} */
  const rows = [];
  for (const [index, alpha] of ladder.entries()) {
    const plain = await decodeFrame(straight.path, index, size);
    const multiplied = await decodeFrame(prem.path, index, size);
    // 参考值用**解码后的 straight 像素**（同一台编码器、同一条色彩转换）乘**解码后的 alpha**，
    // 这样比较的是「预乘」这一件事，不掺 8→10bit 的往返误差。
    const plainRgb = [plain.r ?? 0, plain.g ?? 0, plain.b ?? 0];
    const actual = [multiplied.r ?? 0, multiplied.g ?? 0, multiplied.b ?? 0];
    const expected = plainRgb.map((value) => Math.round((value * (plain.a ?? 0)) / 255));
    const error = Math.max(...actual.map((value, channel) => Math.abs(value - (expected[channel] ?? 0))));
    rows.push({ alpha, straight: plain, prem: multiplied, expected, error });
  }

  for (const row of rows) {
    // alpha=255：**逐 bit 相同**，这是「不许影响不透明像素」的硬判据
    if (row.alpha === 255) {
      assert.deepEqual(
        [row.prem.r, row.prem.g, row.prem.b],
        [row.straight.r, row.straight.g, row.straight.b],
        'alpha=255 must be untouched by premultiplication',
      );
      assert.equal(row.error, 0);
      continue;
    }
    assert.ok(row.error <= 2, `alpha=${row.alpha}: |prem-expected| = ${row.error} > 2 (${JSON.stringify(row)})`);
  }

  // alpha=0 必须是纯黑（预乘的定义），不是保留原色
  const zero = rows.find((row) => row.alpha === 0);
  assert.ok(zero);
  assert.deepEqual([zero.prem.r, zero.prem.g, zero.prem.b], [0, 0, 0]);
  assert.equal(zero.prem.a, 0);

  // 半透明档必须**真的被乘过**：不然「预乘」只是嘴上说说
  for (const row of rows.filter((entry) => entry.alpha > 0 && entry.alpha < 255)) {
    assert.ok(row.prem.r < row.straight.r, `alpha=${row.alpha}: premultiplied red must be smaller than straight`);
  }
});

test('P33-A2：--alpha-mode straight 与「不传 mode」逐字节相同（R16 口径）', async () => {
  const framesDir = path.join(workDir, 'ladder-straight');
  const ladder = await writeAlphaLadder(framesDir);
  const size = { w: 16, h: 16 };
  const base = {
    format: /** @type {const} */ ('prores4444'),
    framesDir,
    frames: ladder.length,
    fps: 30,
    size,
    report: { note: 'a2' },
  };
  const explicit = await writeAlphaOutput({ ...base, outPath: path.join(workDir, 'a2-explicit.mp4'), mode: 'straight' });
  const implicit = await writeAlphaOutput({ ...base, outPath: path.join(workDir, 'a2-implicit.mp4'), mode: undefined });
  // 「不传 mode」走的是格式默认值（prores4444 → 预乘），所以这两个**不该**相同；
  // R16 的口径是 straight，对应的是显式 straight 这一条。
  assert.notEqual(explicit.sha256, implicit.sha256, 'default for prores4444 is premultiplied (P33 decision)');
  const again = await writeAlphaOutput({ ...base, outPath: path.join(workDir, 'a2-explicit-2.mp4'), mode: 'straight' });
  assert.equal(explicit.sha256, again.sha256, 'straight mode must be deterministic (byte-identical reruns)');
  assert.equal(explicit.bytes, again.bytes);
});

test('P33：png-seq + premultiplied 必须被拒（PNG 规范是非预乘）', async () => {
  const framesDir = path.join(workDir, 'ladder-png');
  const ladder = await writeAlphaLadder(framesDir);
  await assert.rejects(
    () =>
      writeAlphaOutput({
        outPath: path.join(workDir, 'reject.mp4'),
        format: 'png-seq',
        mode: 'premultiplied',
        framesDir,
        frames: ladder.length,
        fps: 30,
        size: { w: 16, h: 16 },
        report: {},
      }),
    (err) => {
      assert.equal(/** @type {any} */ (err).code, 'INVALID');
      assert.match(/** @type {any} */ (err).message, /non-premultiplied by specification/);
      return true;
    },
  );
});

test('P33-A3：png-seq 保持 straight（半透明像素 RGB 等于原色，未被乘）', async () => {
  const framesDir = path.join(workDir, 'ladder-png-ok');
  const ladder = await writeAlphaLadder(framesDir);
  const written = await writeAlphaOutput({
    outPath: path.join(workDir, 'png-out.mp4'),
    format: 'png-seq',
    framesDir,
    frames: ladder.length,
    fps: 30,
    size: { w: 16, h: 16 },
    report: { note: 'a3' },
  });
  assert.equal(written.mode, 'straight');
  assert.equal(written.volumeCount, 1);
  assert.equal(written.dirKept, true);
  const dir = /** @type {string} */ (written.dir);
  const half = await fs.readFile(path.join(dir, 'frame-000003.png')); // alpha=128
  const { decodePng } = await import('../png.mjs');
  const image = decodePng(half);
  assert.deepEqual([image.data[0], image.data[1], image.data[2], image.data[3]], [BASE.r, BASE.g, BASE.b, 128]);
});
