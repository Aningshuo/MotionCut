// @ts-nocheck —— 测试以运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * P42：有理帧率。
 *
 * 钉三件事：
 * 1. **解析**：29.97/23.976/59.94 是**别名**，真值是 30000/1001 这类分数；非法值一律 INVALID_FPS。
 * 2. **整数运算**：frames = round(t×num/den)、duration = frames×den/num，长时程不累加浮点。
 * 3. **整数帧率逐位不变**：30fps 的帧位置/时长表达式与 R21 完全相同（否则 sha 会漂）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FPS_MAX,
  FpsError,
  durationOfFrames,
  frameCountAt,
  frameIndexCeil,
  parseFps,
  rateOfFps,
  snapSecondsToFrame,
} from '../fps.mjs';
import { buildTimeline, frameTimeAt } from '../timeline-range.mjs';

test('P42：NTSC 别名 → 30000/1001 这类分数（不是 2997/100）', () => {
  assert.deepEqual(pick(parseFps('29.97')), { num: 30000, den: 1001 });
  assert.deepEqual(pick(parseFps(29.97)), { num: 30000, den: 1001 });
  assert.deepEqual(pick(parseFps('23.976')), { num: 24000, den: 1001 });
  assert.deepEqual(pick(parseFps('59.94')), { num: 60000, den: 1001 });
  // 有理数写法直接透传（约分后）
  assert.deepEqual(pick(parseFps('30000/1001')), { num: 30000, den: 1001 });
  assert.deepEqual(pick(parseFps('60000/2002')), { num: 30000, den: 1001 });
  // 整数
  assert.deepEqual(pick(parseFps('30')), { num: 30, den: 1 });
  assert.deepEqual(pick(parseFps(24)), { num: 24, den: 1 });
  // 自定义小数：round(x*1000)/1000 再约分
  assert.deepEqual(pick(parseFps('25.5')), { num: 51, den: 2 });
  assert.deepEqual(pick(parseFps('12.345')), { num: 2469, den: 200 });
});

test('P42：ffmpeg 的 -r 参数是分数串；整数帧率仍是 "30"', () => {
  assert.equal(parseFps('29.97').arg, '30000/1001');
  assert.equal(parseFps('30').arg, '30');
  assert.equal(parseFps('23.976').arg, '24000/1001');
  // value 是它的十进制投影，给报告/合同（fps?: number）用
  assert.ok(Math.abs(parseFps('29.97').value - 29.97002997) < 1e-8);
});

test('P42：非法帧率一律 INVALID_FPS（0/负/超上限/双点/非数/零分母）', () => {
  for (const bad of ['0', '-1', '1000', String(FPS_MAX + 1), '29.97.5', 'abc', '', '30000/0', '0/1001', '30000.5/1001']) {
    assert.throws(
      () => parseFps(bad),
      (err) => err instanceof FpsError && err.code === 'INVALID_FPS',
      `should reject ${JSON.stringify(bad)}`,
    );
  }
});

test('P42：frames = round(t×num/den)，长时程不漂', () => {
  const rate = parseFps('29.97');
  assert.equal(frameCountAt(rate, 10), 300);
  assert.equal(frameCountAt(rate, 3600), 107892);
  // 10 小时：36000×30000/1001 = 1,078,921.07… → 1,078,921（不是靠浮点累加出来的近似）
  assert.equal(frameCountAt(rate, 36000), 1078921);
  // 与「先算小数再乘」的区别：2997/100 会得到 1,079,000 帧，差 79 帧
  assert.notEqual(frameCountAt(rate, 36000), Math.round(36000 * 29.97));
});

test('P42：duration = frames×den/num（300 帧 = 10.01s，不是 10.0）', () => {
  const rate = parseFps('29.97');
  assert.equal(durationOfFrames(rate, 300), 10.01);
  assert.equal(durationOfFrames(parseFps('23.976'), 240), 10.01);
  // 3600s 的帧格时长是 3599.9964（3600 不是 1001 的整数倍），差 3.6ms
  assert.equal(Number(durationOfFrames(rate, 107892).toFixed(4)), 3599.9964);
});

test('P42：单段 29.97 的 outputDuration 落帧格；30fps 保持窗口长度', () => {
  const frac = buildTimeline([[0, 10]], parseFps('29.97'));
  assert.equal(frac.frames, 300);
  assert.equal(frac.outputDuration, 10.01);

  const int = buildTimeline([[0, 10]], 30);
  assert.equal(int.frames, 300);
  assert.equal(int.outputDuration, 10, '30fps 仍是窗口长度（-t 与 R21 逐字节相同）');

  // 非整秒窗口：30fps 的 -t 还是 2.01（R21 语义），帧数是 60
  const odd = buildTimeline([[2.01, 4.02]], 30);
  assert.equal(odd.frames, 60);
  assert.equal(odd.outputDuration, 2.01);
});

test('P42：多段 29.97 每段落帧格，接缝仍在帧上', () => {
  const timeline = buildTimeline([[2, 4], [6, 8]], parseFps('29.97'));
  assert.equal(timeline.frames, 120);
  assert.equal(timeline.outputDuration, 4.004);
  assert.deepEqual(timeline.segments.map((s) => s.frames), [60, 60]);
  assert.deepEqual(timeline.segments.map((s) => s.startFrame), [60, 180]);
  assert.deepEqual(timeline.segments.map((s) => s.outStartFrame), [0, 60]);
  // 2s → 帧 60 → 2.002s；6s → 帧 180 → 6.006s
  assert.equal(timeline.segments[0].start, 2.002);
  assert.equal(timeline.segments[1].start, 6.006);
  assert.equal(frameTimeAt(timeline.segments, parseFps('29.97'), 0), 2.002);
  assert.equal(frameTimeAt(timeline.segments, parseFps('29.97'), 60), 6.006);
  assert.equal(
    frameTimeAt(timeline.segments, parseFps('29.97'), 59),
    Number(((60 + 59) * 1001 / 30000).toFixed(6)),
  );
});

test('P42：30fps 的帧位置与 R21 逐位相同（同一表达式，不是"约等于"）', () => {
  const timeline = buildTimeline([[2, 4]], 30);
  for (const index of [0, 1, 17, 59]) {
    assert.equal(frameTimeAt(timeline.segments, 30, index), Number((2 + index / 30).toFixed(6)));
    assert.equal(
      frameTimeAt(timeline.segments, parseFps('30'), index),
      Number((2 + index / 30).toFixed(6)),
    );
  }
});

test('P42：字幕网格 —— 30fps 用老表达式，29.97 落 1001/30000 的格', () => {
  assert.equal(snapSecondsToFrame(parseFps('30'), 0.5, 'floor'), 0.5);
  assert.equal(snapSecondsToFrame(parseFps('30'), 0.51, 'floor'), 0.5);
  // 老表达式就是 `ceil(sec/(1/fps)) * (1/fps)`，别在这里再套一层次取整
  assert.equal(snapSecondsToFrame(parseFps('30'), 0.51, 'ceil'), 16 * (1 / 30));
  const rate = parseFps('29.97');
  assert.equal(snapSecondsToFrame(rate, 0.5, 'floor'), (14 * 1001) / 30000);
  assert.equal(snapSecondsToFrame(rate, 0.5, 'ceil'), (15 * 1001) / 30000);
  assert.equal(frameIndexCeil(rate, 0.5), 15);
});

test('P42：rateOfFps 接受 {num,den} 与已解析对象', () => {
  assert.deepEqual(pick(rateOfFps({ num: 24000, den: 1001 })), { num: 24000, den: 1001 });
  const once = parseFps('29.97');
  assert.equal(rateOfFps(once), once, '已解析对象直接透传（不重复归一）');
  assert.deepEqual(pick(rateOfFps(undefined, 30)), { num: 30, den: 1 });
});

/** @param {{ num: number, den: number }} rate */
function pick(rate) {
  return { num: rate.num, den: rate.den };
}
