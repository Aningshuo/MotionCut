/**
 * P24 画幅：`--size` 解析与 letterbox / cover 的几何。
 *
 * 这里只测"算得对不对"；"渲出来是不是这个尺寸"由导出的 ffprobe 证据负责。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSizeArg, planDelivery, sizeFootprint, SIZE_PRESETS } from '../delivery-size.mjs';

test('P24：--size 接受别名与 WxH，奇数尺寸向上取偶', () => {
  assert.deepEqual(parseSizeArg('1080p'), { w: 1920, h: 1080 });
  assert.deepEqual(parseSizeArg('portrait'), { w: 1080, h: 1920 });
  assert.deepEqual(parseSizeArg('1080x1920'), { w: 1080, h: 1920 });
  assert.deepEqual(parseSizeArg('1080×1920'), { w: 1080, h: 1920 });
  assert.deepEqual(parseSizeArg('641x361'), { w: 642, h: 362 });
  assert.equal(parseSizeArg(undefined), null);
  assert.equal(parseSizeArg(''), null);
  assert.throws(() => parseSizeArg('big'), /INVALID_SIZE/);
  assert.throws(() => parseSizeArg('0x100'), /INVALID_SIZE/);
});

test('P24：不传 size 时一行都不变（回归）', () => {
  const plan = planDelivery({ stage: { w: 1280, h: 720 } });
  assert.equal(plan.fit, 'none');
  assert.deepEqual(plan.output, { w: 1280, h: 720 });
  assert.deepEqual(plan.viewport, { w: 1280, h: 720 });
  assert.equal(plan.stageFit, 'none');
  assert.equal(plan.vf, null);
  assert.equal(plan.ffmpegVf, null);
  assert.equal(plan.scale, 1);
});

test('P24：letterbox 用目标视口 + contain，不裁内容', () => {
  const plan = planDelivery({ stage: { w: 1280, h: 720 }, size: { w: 1080, h: 1920 }, fit: 'letterbox' });
  assert.equal(plan.fit, 'letterbox');
  assert.deepEqual(plan.output, { w: 1080, h: 1920 });
  assert.deepEqual(plan.viewport, { w: 1080, h: 1920 });
  assert.equal(plan.stageFit, 'contain');
  assert.equal(plan.vf, null);
  // 1080/1280=0.8438 < 1920/720=2.667 → 宽度是约束边
  assert.equal(plan.scale, 0.84375);
  // ffmpeg 合成路径：先等比缩小再上下补黑
  assert.match(String(plan.ffmpegVf), /scale=1080:1920:force_original_aspect_ratio=decrease/);
  assert.match(String(plan.ffmpegVf), /pad=1080:1920/);
});

test('P24：cover 把视口开到 stage×max(比例)，再居中裁', () => {
  const plan = planDelivery({ stage: { w: 1280, h: 720 }, size: { w: 1080, h: 1920 }, fit: 'cover' });
  assert.equal(plan.fit, 'cover');
  assert.equal(plan.scale, 1920 / 720);
  assert.deepEqual(plan.viewport, { w: 3414, h: 1920 });
  assert.equal(plan.vf, 'crop=1080:1920:1167:0');
  assert.deepEqual(plan.cropped, { x: 1167, y: 0 });
  assert.match(String(plan.ffmpegVf), /force_original_aspect_ratio=increase/);
});

test('P24：4K 正好 3× 舞台，cover 不需要裁', () => {
  const plan = planDelivery({ stage: { w: 1280, h: 720 }, size: { w: 3840, h: 2160 }, fit: 'cover' });
  assert.deepEqual(plan.viewport, { w: 3840, h: 2160 });
  assert.equal(plan.vf, 'crop=3840:2160:0:0');
});

test('P24：未知 fit 报错，不静默退回默认', () => {
  assert.throws(() => planDelivery({ stage: { w: 1280, h: 720 }, size: { w: 1080, h: 1920 }, fit: 'stretch' }), /INVALID_FIT/);
});

test('P24：像素倍率口径', () => {
  assert.equal(sizeFootprint({ w: 1280, h: 720 }).vs720p, 1);
  assert.equal(sizeFootprint({ w: 1920, h: 1080 }).vs720p, 2.25);
  assert.equal(sizeFootprint({ w: 1080, h: 1920 }).vs720p, 2.25);
  assert.equal(sizeFootprint({ w: 3840, h: 2160 }).vs720p, 9);
  assert.equal(SIZE_PRESETS['4k']?.w, 3840);
});
