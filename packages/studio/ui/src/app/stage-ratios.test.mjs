/**
 * 画幅比例映射的单测（R38 · C 批）。
 *
 * 钉死的是**产品口径**：四档的尺寸（尤其 9:16 = 1080×1920，C8 逐字判这组数）
 * 与「已经是这一档就不写盘」。改这里 = 改判据口径，得单独签字。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { STAGE_RATIOS, ratioIdOf, ratioPick, stageForRatio } from './stage-ratios.mjs';

test('R38 · 四档齐全且顺序固定：16:9 / 9:16 / 1:1 / 4:3', () => {
  assert.deepEqual(
    STAGE_RATIOS.map((one) => one.id),
    ['16:9', '9:16', '1:1', '4:3'],
  );
  assert.deepEqual(
    STAGE_RATIOS.map((one) => [one.w, one.h]),
    [
      [1920, 1080],
      [1080, 1920],
      [1080, 1080],
      [1440, 1080],
    ],
  );
});

test('R38 · ratioIdOf：同一比例的不同分辨率都算同一档', () => {
  assert.equal(ratioIdOf({ w: 1280, h: 720 }), '16:9', '1280×720 也是 16:9（不能被改成 1920×1080）');
  assert.equal(ratioIdOf({ w: 1920, h: 1080 }), '16:9');
  assert.equal(ratioIdOf({ w: 720, h: 1280 }), '9:16');
  assert.equal(ratioIdOf({ w: 1080, h: 1920 }), '9:16');
  assert.equal(ratioIdOf({ w: 1080, h: 1080 }), '1:1');
  assert.equal(ratioIdOf({ w: 1440, h: 1080 }), '4:3');
  assert.equal(ratioIdOf({ w: 960, h: 720 }), '4:3');
  assert.equal(ratioIdOf({ w: 1000, h: 1000 }), '1:1');
});

test('R38 · ratioIdOf：不在四档内给 null（界面四颗都不高亮，不瞎猜）', () => {
  assert.equal(ratioIdOf({ w: 1000, h: 700 }), null);
  assert.equal(ratioIdOf({ w: 2100, h: 900 }), null);
  assert.equal(ratioIdOf(null), null);
  assert.equal(ratioIdOf(undefined), null);
  assert.equal(ratioIdOf({ w: 0, h: 720 }), null);
  assert.equal(ratioIdOf(/** @type {any} */ ({})), null, 'w/h 缺失 → null');
});

test('R38 · ratioPick：跨档才返回尺寸，同档返回 null（不产生空 op / 不多一步撤销）', () => {
  assert.deepEqual(ratioPick({ w: 1280, h: 720 }, '9:16'), { w: 1080, h: 1920 }, 'C8 要的就是这组数');
  assert.deepEqual(ratioPick({ w: 1080, h: 1920 }, '16:9'), { w: 1920, h: 1080 });
  assert.deepEqual(ratioPick({ w: 1280, h: 720 }, '1:1'), { w: 1080, h: 1080 });
  assert.deepEqual(ratioPick({ w: 1000, h: 700 }, '4:3'), { w: 1440, h: 1080 });

  assert.equal(ratioPick({ w: 1280, h: 720 }, '16:9'), null, '已经是 16:9（哪怕是 1280×720）→ 不写盘');
  assert.equal(ratioPick({ w: 1080, h: 1920 }, '9:16'), null);
  assert.equal(ratioPick({ w: 1280, h: 720 }, '21:9'), null, '未知档 → null');
});

test('R38 · stageForRatio：未知档 null，已知档返回同一份常量', () => {
  assert.equal(stageForRatio('21:9'), null);
  assert.equal(stageForRatio('9:16'), STAGE_RATIOS[1]);
});
