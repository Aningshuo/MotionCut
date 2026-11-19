/**
 * P38：编码矩阵的纯函数单测。
 *
 * 真正的产物（ffprobe 矩阵 / PSNR / 音频）在 `scripts/r19-acceptance.mjs` 里验；
 * 这里只钉「参数长什么样」——尤其是 h264 必须与 R22 逐项相同，否则默认产物 sha 会变。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CODEC_MATRIX,
  CODEC_NAMES,
  DEFAULT_CODEC,
  audioEncodeArgs,
  codecQuality,
  containerArgs,
  describeCodec,
  requiredEncoders,
  resolveCodec,
  videoEncodeArgs,
} from '../codec-matrix.mjs';
import { resolveQuality } from '../quality.mjs';

const STANDARD = resolveQuality('standard');

test('P38/P47：编码表覆盖五个 codec（P47 加 prores4444 交付编码），缺省 h264', () => {
  assert.deepEqual([...CODEC_NAMES], ['h264', 'hevc', 'vp9', 'prores422hq', 'prores4444']);
  assert.equal(DEFAULT_CODEC, 'h264');
  assert.equal(resolveCodec(undefined).name, 'h264');
  assert.equal(resolveCodec('vp9').container, 'webm');
  assert.throws(() => resolveCodec('av1'), /INVALID_CODEC/);
});

test('P38：h264 的编码参数与 R22 逐项相同（顺序也相同）', () => {
  const codec = resolveCodec('h264');
  const q = codecQuality(codec, STANDARD);
  assert.deepEqual(q, { crf: 8, preset: 'medium', pixFmt: 'yuv444p' });
  // R22 的原参数：-c:v libx264 -preset <p> -crf <n> -pix_fmt <f>
  assert.deepEqual(videoEncodeArgs(codec, q), [
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '8', '-pix_fmt', 'yuv444p',
  ]);
  assert.deepEqual(containerArgs(codec), ['-movflags', '+faststart']);
  assert.deepEqual(audioEncodeArgs(codec), ['-c:a', 'aac', '-b:a', '192k']);
});

test('P38：hevc 带 hvc1，且不吃 yuv444（Main profile 是 4:2:0）', () => {
  const codec = resolveCodec('hevc');
  const q = codecQuality(codec, STANDARD);
  assert.equal(q.crf, 20);
  assert.equal(q.pixFmt, 'yuv420p');
  assert.deepEqual(videoEncodeArgs(codec, q), [
    '-c:v', 'libx265', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1',
  ]);
  assert.equal(describeCodec(codec).tag, 'hvc1');
  assert.deepEqual(audioEncodeArgs(codec), ['-c:a', 'aac', '-b:a', '192k']);
});

test('P38：vp9 是恒定质量（-b:v 0），standard/high 用 4:4:4 绕开色度地板', () => {
  const codec = resolveCodec('vp9');
  const standard = codecQuality(codec, STANDARD);
  assert.deepEqual(standard, { crf: 28, preset: 'good', pixFmt: 'yuv444p' });
  assert.deepEqual(videoEncodeArgs(codec, standard), [
    '-c:v', 'libvpx-vp9', '-crf', '28', '-b:v', '0', '-pix_fmt', 'yuv444p',
    '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2',
  ]);
  assert.deepEqual(containerArgs(codec), [], 'webm 不认 -movflags');
  assert.deepEqual(audioEncodeArgs(codec), ['-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '2']);

  const draft = codecQuality(codec, resolveQuality('draft'));
  assert.equal(draft.pixFmt, 'yuv420p', 'draft 仍给 4:2:0 兼容档');
});

test('P38：prores422hq 固定 profile 3 / yuv422p10le，不吃 quality', () => {
  const codec = resolveCodec('prores422hq');
  const q = codecQuality(codec, resolveQuality('high'));
  assert.deepEqual(q, { crf: null, preset: null, pixFmt: 'yuv422p10le' });
  assert.deepEqual(videoEncodeArgs(codec, q), [
    '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le',
  ]);
  assert.deepEqual(audioEncodeArgs(codec), ['-c:a', 'pcm_s16le']);
  assert.equal(/** @type {any} */ (CODEC_MATRIX.prores422hq).proresProfile, 3);
});

test('P38：探测的编码器列表包含音频，缺一个都不算可用', () => {
  assert.deepEqual(requiredEncoders(resolveCodec('h264')), ['libx264', 'aac']);
  assert.deepEqual(requiredEncoders(resolveCodec('hevc')), ['libx265', 'aac']);
  assert.deepEqual(requiredEncoders(resolveCodec('vp9')), ['libvpx-vp9', 'libopus']);
  assert.deepEqual(requiredEncoders(resolveCodec('prores422hq')), ['prores_ks', 'pcm_s16le']);
});
