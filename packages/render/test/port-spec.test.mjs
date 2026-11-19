// @ts-nocheck —— 纯校验函数，不跑 ffmpeg
/**
 * P47：作业 spec 的白名单与「整片」语义。
 *
 * 这一组钉的是**门禁**，不是渲染：
 * 1. codec / quality / loudness 三张表放开到 `export film` 的能力面；
 * 2. ranges 1..100（多段不再是 CODEC_UNAVAILABLE）；
 * 3. 两个都不给 = 整片；两个都给 = INVALID_RANGE；
 * 4. alpha 仍明确拒绝（ALPHA_REQUIRES_STAGE），subtitleBurn/subtitleStyle 有类型校验。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { JOB_CODECS, JOB_LOUDNESS, JOB_QUALITIES, validateSpec } from '../job.mjs';

/** @param {Record<string, any>} [patch] */
function spec(patch = {}) {
  return {
    jobId: 'job-1',
    projectId: '/tmp/project',
    outputDir: '/tmp/output/job-1',
    expectedHash: 'a'.repeat(64),
    owner: 'SUB2',
    kind: 'video',
    range: [0, 1],
    ...patch,
  };
}

test('P47 门禁：三张表与 export film 的能力面对齐', () => {
  assert.deepEqual([...JOB_CODECS], ['h264', 'hevc', 'prores422hq', 'prores4444']);
  assert.deepEqual([...JOB_QUALITIES], ['draft', 'standard', 'high']);
  assert.deepEqual([...JOB_LOUDNESS], ['off', 'streaming', 'broadcast']);
  for (const codec of JOB_CODECS) assert.equal(validateSpec(spec({ codec })), null, codec);
  for (const quality of JOB_QUALITIES) assert.equal(validateSpec(spec({ quality })), null, quality);
  for (const loudness of JOB_LOUDNESS) assert.equal(validateSpec(spec({ loudness })), null, loudness);
});

test('P47 门禁：未知 codec / quality / loudness 仍是 CODEC_UNAVAILABLE', () => {
  assert.equal(validateSpec(spec({ codec: 'av1' }))?.error, 'CODEC_UNAVAILABLE');
  assert.equal(validateSpec(spec({ quality: 'master' }))?.error, 'CODEC_UNAVAILABLE');
  assert.equal(validateSpec(spec({ loudness: 'podcast' }))?.error, 'CODEC_UNAVAILABLE');
  assert.equal(validateSpec(spec({ kind: 'gif' }))?.error, 'CODEC_UNAVAILABLE');
});

test('P47 门禁：ranges 1..100，多段不再被拒', () => {
  assert.equal(validateSpec(spec({ range: undefined, ranges: [[2, 4], [6, 8]] })), null);
  assert.equal(validateSpec(spec({ range: undefined, ranges: Array.from({ length: 100 }, (_, i) => [i, i + 1]) })), null);
  assert.equal(validateSpec(spec({ range: undefined, ranges: [] }))?.error, 'INVALID_RANGE');
  assert.equal(
    validateSpec(spec({ range: undefined, ranges: Array.from({ length: 101 }, (_, i) => [i, i + 1]) }))?.error,
    'INVALID_RANGE',
  );
});

test('P47 门禁：整片 = 两个都不给；两个都给 = INVALID_RANGE', () => {
  assert.equal(validateSpec(spec({ range: undefined })), null);
  assert.equal(validateSpec(spec({ ranges: [[0, 1]] }))?.error, 'INVALID_RANGE');
});

test('P47 门禁：alpha 仍明确拒绝', () => {
  assert.equal(validateSpec(spec({ alpha: true }))?.error, 'ALPHA_REQUIRES_STAGE');
  assert.equal(validateSpec(spec({ alpha: false })), null);
});

test('P47 门禁：subtitleBurn / subtitleStyle 类型', () => {
  assert.equal(validateSpec(spec({ subtitleBurn: true })), null);
  assert.equal(validateSpec(spec({ subtitleBurn: 'yes' }))?.error, 'INVALID');
  assert.equal(validateSpec(spec({ subtitleStyle: { bold: true } })), null);
  assert.equal(validateSpec(spec({ subtitleStyle: [] }))?.error, 'INVALID');
  assert.equal(validateSpec(spec({ subtitleStyle: 'bold' }))?.error, 'INVALID');
});

test('P47 门禁：fps 越界仍是 INVALID_FPS（与 export film 同码）', () => {
  assert.equal(validateSpec(spec({ fps: 0 }))?.error, 'INVALID_FPS');
  assert.equal(validateSpec(spec({ fps: 1000 }))?.error, 'INVALID_FPS');
  assert.equal(validateSpec(spec({ fps: 29.97 })), null);
});
