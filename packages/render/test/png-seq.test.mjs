/**
 * P33-A4：PNG 序列的体积预算与分卷。
 *
 * 单测层面只验**算术与命名**（不落 2.6GB 的文件）；真实的 4K 240 帧分卷证据在
 * `scripts/r17-alpha-polarity.mjs` 里跑，报告里的卷数与字节数以那次为准。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ESTIMATE_SAMPLE_FRAMES,
  PNG_SEQ_VOLUME_LIMIT,
  estimatePngSequenceBytes,
  planPngSeqVolumes,
  sampleFrameIndices,
} from '../png-seq.mjs';

test('P33：单卷上限是十进制 2GB（两种读法下都 ≤2GB）', () => {
  assert.equal(PNG_SEQ_VOLUME_LIMIT, 2_000_000_000);
  assert.ok(PNG_SEQ_VOLUME_LIMIT <= 2 * 1024 ** 3);
  assert.equal(ESTIMATE_SAMPLE_FRAMES, 12);
});

test('P33：取样均匀覆盖全片（含首尾、严格递增）', () => {
  const indices = sampleFrameIndices(240);
  assert.equal(indices.length, 12);
  assert.equal(indices[0], 0);
  assert.equal(indices[indices.length - 1], 239);
  for (let i = 1; i < indices.length; i += 1) {
    const current = indices[i] ?? -1;
    const previous = indices[i - 1] ?? -1;
    assert.ok(current > previous);
  }
  // 帧数比取样数还少时不能造出重复下标
  assert.deepEqual(sampleFrameIndices(3), [0, 1, 2]);
  assert.deepEqual(sampleFrameIndices(1), [0]);
  assert.deepEqual(sampleFrameIndices(0), []);
});

test('P33：体积预算 = 均值 × 帧数（均匀内容误差为 0）', () => {
  const estimate = estimatePngSequenceBytes({ frames: 240, sampleBytes: new Array(12).fill(1000) });
  assert.equal(estimate.estimatedBytes, 240_000);
  assert.equal(estimate.perFrameMean, 1000);
  assert.equal(estimate.method, 'sampled-frames');
  assert.throws(() => estimatePngSequenceBytes({ frames: 240, sampleBytes: [] }), /at least one real frame size/);
  assert.throws(() => estimatePngSequenceBytes({ frames: 0, sampleBytes: [1] }), /positive frame count/);
});

test('P33：放得下就不分卷（沿用 R16 命名 take.zip）', () => {
  const frames = Array.from({ length: 240 }, (_, index) => ({ index, bytes: 1_000_000 }));
  const planned = planPngSeqVolumes({ frameBytes: frames, stem: 'take' });
  assert.equal(planned.split, false);
  assert.equal(planned.volumes.length, 1);
  const [only] = planned.volumes;
  assert.ok(only);
  assert.equal(only.name, 'take.zip');
  assert.equal(only.bytes, 240_000_000);
  assert.equal(only.firstIndex, 0);
  assert.equal(only.lastIndex, 239);
  assert.equal(planned.totalBytes, 240_000_000);
});

test('P33：超过 2GB 按整帧分卷，命名可预期（part001…），每卷 ≤ 上限', () => {
  // 4K 一帧 ~11MB：240 帧 = 2.64GB → 至少 2 卷
  const frames = Array.from({ length: 240 }, (_, index) => ({ index, bytes: 11_000_000 }));
  const planned = planPngSeqVolumes({ frameBytes: frames, stem: 'take' });
  assert.equal(planned.split, true);
  assert.ok(planned.volumes.length >= 2);
  assert.deepEqual(
    planned.volumes.map((volume) => volume.name),
    planned.volumes.map((_, index) => `take.part${String(index + 1).padStart(3, '0')}.zip`),
  );
  let sum = 0;
  let covered = 0;
  for (const volume of planned.volumes) {
    assert.ok(volume.bytes <= PNG_SEQ_VOLUME_LIMIT, `${volume.name} is ${volume.bytes}B > limit`);
    assert.equal(volume.frames, volume.lastIndex - volume.firstIndex + 1);
    sum += volume.bytes;
    covered += volume.frames;
  }
  assert.equal(covered, 240);
  assert.equal(sum, planned.totalBytes);
  assert.equal(planned.totalBytes, 240 * 11_000_000);
});

test('P33：单帧就超限时单独成卷并显式标出（不切半张 PNG）', () => {
  const frames = [
    { index: 0, bytes: 100 },
    { index: 1, bytes: 3_000_000_000 },
    { index: 2, bytes: 100 },
  ];
  const planned = planPngSeqVolumes({ frameBytes: frames, stem: 'huge' });
  assert.equal(planned.split, true);
  assert.deepEqual(planned.oversizedFrames, [1]);
  const giant = planned.volumes.find((volume) => volume.firstIndex === 1);
  assert.ok(giant);
  assert.equal(giant.frames, 1);
});

test('P33：清单开销记到第 1 卷（拿到 part001 的人能看到完整卷表）', () => {
  // 每帧 1.2GB：两帧一定放不进 2GB 的卷，所以每卷刚好一帧，账目干净
  const frames = Array.from({ length: 3 }, (_, index) => ({ index, bytes: 1_200_000_000 }));
  const planned = planPngSeqVolumes({ frameBytes: frames, stem: 'take', overheadBytes: 40_000, limitBytes: 2_000_000_000 });
  assert.equal(planned.split, true);
  assert.equal(planned.volumes.length, 3);
  const [first, second] = planned.volumes;
  assert.ok(first && second);
  assert.equal(first.bytes, 1_200_000_000 + 40_000);
  assert.equal(second.bytes, 1_200_000_000);
  assert.equal(planned.totalBytes, 3 * 1_200_000_000 + 40_000);
});
