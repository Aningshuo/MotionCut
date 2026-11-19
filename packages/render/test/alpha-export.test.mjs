import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ALPHA_FORMATS,
  analyzeAlphaFrames,
  buildStoreZip,
  frameFileName,
  resolveAlphaFormat,
  resolvePngSeqPaths,
  writeAlphaOutput,
} from '../alpha-export.mjs';
import { encodePng } from '../png.mjs';

/** @param {number} alpha @param {{ width?: number, height?: number }} [size] */
function pngWithAlpha(alpha, size = { width: 4, height: 4 }) {
  const width = size.width ?? 4;
  const height = size.height ?? 4;
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 200;
    data[i + 1] = 120;
    data[i + 2] = 60;
    data[i + 3] = alpha;
  }
  return encodePng({ width, height, data });
}

/**
 * 只读 zip 的中央目录（够用来数条目与读文件名；不实现解压）。
 * @param {Buffer} zip
 */
function readZipEntries(zip) {
  const eocd = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocd), 0x06054b50, 'EOCD signature');
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  /** @type {Array<{ name: string, size: number }>} */
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    assert.equal(zip.readUInt32LE(offset), 0x02014b50, 'central directory signature');
    const nameLength = zip.readUInt16LE(offset + 28);
    const size = zip.readUInt32LE(offset + 24);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    entries.push({ name, size });
    offset += 46 + nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
  }
  return entries;
}

test('P31：--alpha-format 归一（缺省 prores4444，别名可用，未知要拒）', () => {
  assert.deepEqual([...ALPHA_FORMATS], ['prores4444', 'png-seq']);
  assert.equal(resolveAlphaFormat(undefined), 'prores4444');
  assert.equal(resolveAlphaFormat('prores'), 'prores4444');
  assert.equal(resolveAlphaFormat('4444'), 'prores4444');
  assert.equal(resolveAlphaFormat('png-seq'), 'png-seq');
  assert.equal(resolveAlphaFormat('PNGSEQ'), 'png-seq');
  assert.throws(() => resolveAlphaFormat('gif'), (/** @type {any} */ err) => err.code === 'INVALID');
});

test('P31：帧文件名与序列路径（--out take.mp4 → take/ + take.zip）', () => {
  assert.equal(frameFileName('frame-%06d.png', 0), 'frame-000000.png');
  assert.equal(frameFileName('frame-%06d.png', 239), 'frame-000239.png');
  assert.deepEqual(resolvePngSeqPaths('/x/take.mp4'), { dir: '/x/take', zip: '/x/take.zip' });
  assert.deepEqual(resolvePngSeqPaths('/x/take.zip'), { dir: '/x/take', zip: '/x/take.zip' });
  assert.deepEqual(resolvePngSeqPaths('/x/take'), { dir: '/x/take', zip: '/x/take.zip' });
});

test('P31：analyzeAlphaFrames 逐帧统计（含全透明帧的识别）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-alpha-'));
  try {
    await fs.writeFile(path.join(dir, 'frame-000000.png'), pngWithAlpha(0)); // 全透明
    await fs.writeFile(path.join(dir, 'frame-000001.png'), pngWithAlpha(255)); // 全不透明
    await fs.writeFile(path.join(dir, 'frame-000002.png'), pngWithAlpha(255)); // 全不透明
    const report = await analyzeAlphaFrames({ framesDir: dir, frames: 3 });
    assert.equal(report.hasAlpha, true);
    assert.equal(report.framesWithAlpha, 1);
    assert.equal(report.firstFrame, 0);
    assert.equal(report.lastFrame, 0);
    assert.equal(report.maxTransparentRatio, 1);
    assert.deepEqual(report.fullyTransparentFrames, [0]);
    assert.equal(report.perFrame.length, 3);
    assert.equal(report.perFrame[1]?.transparentRatio, 0);
    assert.deepEqual(report.size, { w: 4, h: 4 });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('P31：实心工程必须报 hasAlpha=false（不许全 255 还叫透明）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-alpha-'));
  try {
    for (let i = 0; i < 4; i += 1) {
      await fs.writeFile(path.join(dir, `frame-${String(i).padStart(6, '0')}.png`), pngWithAlpha(255));
    }
    const report = await analyzeAlphaFrames({ framesDir: dir, frames: 4 });
    assert.equal(report.hasAlpha, false);
    assert.equal(report.framesWithAlpha, 0);
    assert.equal(report.firstFrame, null);
    assert.equal(report.lastFrame, null);
    assert.equal(report.minAlphaOverall, 255);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('P31：analyzeAlphaFrames 遇到尺寸不一致要报错，不能混着算', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-alpha-'));
  try {
    await fs.writeFile(path.join(dir, 'frame-000000.png'), pngWithAlpha(0, { width: 4, height: 4 }));
    await fs.writeFile(path.join(dir, 'frame-000001.png'), pngWithAlpha(0, { width: 6, height: 4 }));
    await assert.rejects(
      analyzeAlphaFrames({ framesDir: dir, frames: 2 }),
      (/** @type {any} */ err) => err.code === 'INVALID' && /6x4/.test(err.message),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('P31：store-only zip 的中央目录与文件数对得上', () => {
  const zip = buildStoreZip([
    { name: 'a.png', data: Buffer.from('hello') },
    { name: 'b.json', data: Buffer.from('{"x":1}') },
  ]);
  const entries = readZipEntries(zip);
  assert.deepEqual(entries.map((entry) => entry.name), ['a.png', 'b.json']);
  assert.deepEqual(entries.map((entry) => entry.size), [5, 7]);
  // 局部头签名 + 原始字节直接在里面（store-only 不压缩）
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.ok(zip.includes(Buffer.from('hello')));
});

test('P31：writeAlphaOutput 的 png-seq 形态（1 基命名 + 两个元数据文件）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-seq-'));
  try {
    const framesDir = path.join(dir, 'frames');
    await fs.mkdir(framesDir);
    for (let i = 0; i < 3; i += 1) {
      await fs.writeFile(path.join(framesDir, `frame-${String(i).padStart(6, '0')}.png`), pngWithAlpha(i === 0 ? 0 : 255));
    }
    const report = await analyzeAlphaFrames({ framesDir, frames: 3 });
    const written = await writeAlphaOutput({
      outPath: path.join(dir, 'take.mp4'),
      format: 'png-seq',
      framesDir,
      frames: 3,
      fps: 30,
      size: { w: 4, h: 4 },
      report,
    });
    assert.equal(written.kind, 'png-seq');
    assert.equal(written.path, path.join(dir, 'take.zip'));
    assert.equal(written.dir, path.join(dir, 'take'));
    const names = (await fs.readdir(written.dir)).sort();
    assert.deepEqual(names, [
      'alpha-report.json',
      'frame-000001.png',
      'frame-000002.png',
      'frame-000003.png',
      'sequence.json',
    ]);
    const entries = readZipEntries(await fs.readFile(written.path));
    assert.equal(entries.length, 5);
    assert.equal(entries[0]?.name, 'frame-000001.png');
    const sequence = JSON.parse(await fs.readFile(path.join(written.dir, 'sequence.json'), 'utf8'));
    assert.equal(sequence.startNumber, 1);
    assert.equal(sequence.frames, 3);
    assert.equal(sequence.durationSec, 0.1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
