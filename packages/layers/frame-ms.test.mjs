// @ts-nocheck —— 单测：跨包 import 带 .ts 后缀（node 直接跑），tsc 这边不追这两条
/**
 * R31 · E12-P2 / J6：取帧毫秒只有一处口径。
 *
 * 这一组钉的不是「写得对不对」，而是**两条路径必须落到同一个毫秒**：
 * 素材抽屉（区间中点）与时间线胶片条（片段内第 k 格）以前各写一遍 `Math.round`，
 * 时间线多一道 `源出点 − 40ms`、抽屉没有 —— 出点前 40ms 以内两边会差 20ms 上下，
 * 同一格在缓存里就是两张图（`derived` 的缓存键带 ms）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { END_TOLERANCE_MS, frameMsAt, frameMsMidpoint, normalizeFrameMs } from './frame-ms.mjs';
import { filmstripCells, filmstripUrl } from '../studio/ui/src/app/filmstrip.ts';

/** 与 `server/derived.mjs` 的常数对齐（那边是吸收带，这边是预防，同一档 40ms）。 */
test('R31-B1：末尾容差与 derived 同值（40ms）', () => {
  assert.equal(END_TOLERANCE_MS, 40);
});

test('R31-B2：取整规则 = round(秒 × 1000)，下界 0，非数值给 0', () => {
  assert.equal(frameMsAt(0), 0);
  assert.equal(frameMsAt(1.25), 1250);
  /* 四舍五入，不是截断：0.0005s → 0.5ms → 1ms */
  assert.equal(frameMsAt(0.0005), 1);
  assert.equal(frameMsAt(0.00049), 0);
  assert.equal(frameMsAt(-1.2), 0);
  assert.equal(frameMsAt('2.5'), 2500, '字符串数字也认（`#t=` 解析出来可能是字符串）');
  assert.equal(frameMsAt(Number.NaN), 0);
  assert.equal(frameMsAt(undefined), 0);
  /* 浮点臭名昭著的 8.5：直接乘 1000 是 8500.000000000001，取整后仍是 8500 */
  assert.equal(frameMsAt(8.5), 8500);
  /* 幂等：已经是整数毫秒的再过一遍不变 */
  assert.equal(normalizeFrameMs(1250), 1250);
  assert.equal(normalizeFrameMs(1250.4), 1250);
});

test('R31-B3：给得出源出点 → 夹到 出点 − 40ms', () => {
  assert.equal(frameMsAt(3.0, 3.0), 2960, '落在末帧之后 → 退 40ms');
  assert.equal(frameMsAt(2.99, 3.0), 2960);
  assert.equal(frameMsAt(1.0, 3.0), 1000, '离得远的不动');
  assert.equal(frameMsAt(3.0, null), 3000, '不知道出点就不夹');
  assert.equal(frameMsAt(3.0, 0), 3000);
  assert.equal(frameMsAt(0.01, 0.02), 0, '夹出来是负的 → 回到 0');
});

test('R31-B4：两条路径同一位点 → 同一个毫秒（旧代码在这里分叉）', () => {
  /* 夹具片段 `#t=0,2.5`：抽屉取区间中点 = 1.25s；时间线第 1 格（left=80 @64pps）= 1.25s */
  const drawer = frameMsMidpoint(0, 2.5);
  const timeline = filmstripCells({ width: 160, pps: 64, speed: 1, sourceIn: 0, sourceOut: 2.5 })[1].ms;
  assert.equal(drawer, 1250);
  assert.equal(timeline, 1250);
  assert.equal(drawer, timeline);

  /* 同一个 URL：这一格在两边的请求必须逐字符相同（缓存命中同一个文件） */
  assert.equal(
    filmstripUrl('/api/projects/p1/derived', 'assets/take-01.mp4', timeline),
    `/api/projects/p1/derived?what=frame&rel=assets%2Ftake-01.mp4&ms=${String(drawer)}&w=160`,
  );

  /* 旧代码真正分叉的地方：**出点前 40ms 以内**。时间线的末格夹到 出点−40，抽屉不夹。 */
  const tightDrawer = frameMsMidpoint(2.96, 3.0);
  const tightTimeline = filmstripCells({ width: 160, pps: 64, speed: 1, sourceIn: 2.96, sourceOut: 3.0 })[0].ms;
  assert.equal(tightDrawer, 2960);
  assert.equal(tightTimeline, 2960);
  assert.equal(tightDrawer, tightTimeline);
  /* 旧值（改之前）：抽屉 `round(((2.96+3.0)/2)*1000)` = **2980**、时间线 **2960** —— 两个不同的 ms。
     注意：源**末尾**这一档会被服务端自己的吸收带（`ms > duration−40 → seek=duration−40`）抹平，
     所以 2980/2960 在 3.0s 的源上会落到同一个 seek。真正抹不平的是「裁切出点早于源末尾」。 */

  /* 10s 源、裁到 2.00–2.02（20ms 的极短片段）：旧抽屉 2010 vs 旧时间线 1980 —— 两张不同的图，
     服务端也不会替它们归一（2010 离源末尾还有 8 秒）。 */
  assert.equal(frameMsMidpoint(2, 2.02), 1980);

  /* 不到 40ms 的极短片段：中点被夹到 0（不发负请求、也不发末帧之后的请求） */
  assert.equal(frameMsMidpoint(0, 0.03), 0);
});

test('R31-B5：抽屉中点只在「真给了出点」时才夹', () => {
  /* `#t=2`（到结尾）：没有出点 → 中点就是 2.0s，不许因为「拿入点当出点」被挪到 1960 */
  assert.equal(frameMsMidpoint(2, null), 2000);
  assert.equal(frameMsMidpoint(2, undefined), 2000);
  assert.equal(frameMsMidpoint(2, 1), 2000, '出点比入点小 → 当没给');
  assert.equal(frameMsMidpoint(0, 8.5), 4250);
  /* 零长度区间（`#t=8.5,8.5`）：上游 `mediaRangeOf()` 已经把这种 `to <= from` 归一成 null，
     到这里等价于「没给点」→ 不夹，取入点本身。 */
  assert.equal(frameMsMidpoint(8.5, 8.5), 8500);
});
