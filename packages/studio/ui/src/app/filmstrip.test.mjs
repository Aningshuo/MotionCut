// @ts-nocheck —— 单测：胶片条的格子数与取帧毫秒（纯函数，不起浏览器）
/**
 * E04（R29）：`filmstripCells` 是「每一格取哪一毫秒」的唯一实现，
 * 判据（BATCH-SUB1-R31-087 §4）：
 *   ① 8.5s 片段上缩略图数 = ceil(宽 / 80)
 *   ② 缩放（pps 变）后格子重排：每格仍是 80px，但毫秒步长跟着变
 *   ③ 末格超过源出点要夹到 `sourceOut − 40ms`（与 derived 的末尾容差同一个口径）
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { THUMB_W, cellRangeInView, filmstripCells, filmstripUrl } from './filmstrip.ts';

test('E04 · 一格 80px（参照的量测值）', () => {
  assert.equal(THUMB_W, 80);
});

test('E04 · 8.5s 片段：张数 = ceil(宽/80)', () => {
  const pps = 64;
  const width = 8.5 * pps; // 544
  const cells = filmstripCells({ width, pps, sourceIn: 0, sourceOut: 8.5 });
  assert.equal(cells.length, Math.ceil(width / THUMB_W));
  assert.equal(cells.length, 7);
  /* 每格贴齐：left = i×80、间距 0 */
  assert.deepEqual(
    cells.map((cell) => cell.left),
    [0, 80, 160, 240, 320, 400, 480],
  );
  /* 毫秒 = left / pps × 1000（匀速时间线） */
  assert.deepEqual(
    cells.map((cell) => cell.ms),
    [0, 1250, 2500, 3750, 5000, 6250, 7500],
  );
});

test('E04 · 缩放后重排：每格仍是 80px，毫秒步长反过来变', () => {
  const wide = filmstripCells({ width: 8.5 * 64, pps: 64, sourceIn: 0, sourceOut: 9 });
  const narrow = filmstripCells({ width: 8.5 * 32, pps: 32, sourceIn: 0, sourceOut: 9 });
  assert.equal(wide.length, 7);
  assert.equal(narrow.length, Math.ceil((8.5 * 32) / 80)); // 4
  assert.equal(wide[1].ms - wide[0].ms, 1250);
  assert.equal(narrow[1].ms - narrow[0].ms, 2500); // 放大后一格的毫秒步长变大
});

test('E04 · 末格夹到 sourceOut − 40ms（derived 的末尾容差）', () => {
  /* 片段被拉长到超过源时长（慢放/补尾）：最后几格的源时刻会越界 */
  const cells = filmstripCells({ width: 800, pps: 64, speed: 1, sourceIn: 0, sourceOut: 2 });
  const last = cells[cells.length - 1];
  assert.equal(last.ms, 1960); // 2s − 40ms
  assert.ok(cells.every((cell) => cell.ms <= 1960));
});

test('E04 · 变速：源时刻按 speed 走', () => {
  const normal = filmstripCells({ width: 160, pps: 64, speed: 1, sourceIn: 0, sourceOut: 9 });
  const fast = filmstripCells({ width: 160, pps: 64, speed: 2, sourceIn: 0, sourceOut: 9 });
  assert.equal(normal[1].ms, 1250);
  assert.equal(fast[1].ms, 2500); // 2× 速：同样的时间线位置对应两倍源时刻
});

test('E04 · 片宽为 0 / pps 非法 → 不画', () => {
  assert.deepEqual(filmstripCells({ width: 0, pps: 64 }), []);
  assert.deepEqual(filmstripCells({ width: 320, pps: 0 }), []);
});

test('E04 · URL 形状：what=frame + rel/ms/w=160（DPR2）', () => {
  assert.equal(
    filmstripUrl('/api/projects/p1/derived', 'assets/take-01.mp4', 1250),
    '/api/projects/p1/derived?what=frame&rel=assets%2Ftake-01.mp4&ms=1250&w=160',
  );
});

/* ── R30/A · 可见窗口裁剪 ──────────────────────────────────────────────── */

test('R30A · 窗口内的格子 + 右侧一格预取', () => {
  /* 60s 片段 @64pps = 3840px；视口 1000px 宽、片段左缘在 −200（已滚动） */
  const range = cellRangeInView({
    stripLeft: -200,
    stripWidth: 3840,
    viewLeft: 0,
    viewRight: 1000,
    cssWidth: 3840,
    count: Math.ceil(3840 / THUMB_W),
  });
  /* 可见带换算到片段内是 200..1200 → 第 2..14 格 */
  assert.equal(range.visibleFrom, 2);
  assert.equal(range.visibleTo, 14);
  assert.equal(range.from, 2);
  assert.equal(range.to, 15); // 只多一格，不是整条
  assert.ok(range.to - range.from + 1 <= range.visibleTo - range.visibleFrom + 1 + 1);
});

test('R30A · 预取恒为一格（并发上限 = 可见格数 + 1）', () => {
  for (const [viewLeft, viewRight] of [[0, 320], [0, 1000], [500, 1500], [0, 3840]]) {
    const range = cellRangeInView({
      stripLeft: 0,
      stripWidth: 3840,
      viewLeft,
      viewRight,
      cssWidth: 3840,
      count: 48,
    });
    const visible = range.visibleTo - range.visibleFrom + 1;
    const want = Math.min(48, visible + 1);
    assert.equal(range.to - range.from + 1, want, `窗口 ${viewLeft}..${viewRight}`);
  }
});

test('R30A · 完全在视口外 → 一个请求都不发', () => {
  const range = cellRangeInView({
    stripLeft: 5000,
    stripWidth: 3840,
    viewLeft: 0,
    viewRight: 1000,
    cssWidth: 3840,
    count: 48,
  });
  assert.equal(range.to, -1);
  assert.ok(range.to < range.from);
});

test('R30A · 缩放/transform：屏幕宽 ≠ CSS 宽时按比例换算', () => {
  /* 片段被祖先 transform 缩到一半：CSS 宽 3840、屏幕宽 1920；可见 0..960 屏幕 px
     = 0..1920 CSS px = 前 24 格 */
  const range = cellRangeInView({
    stripLeft: 0,
    stripWidth: 1920,
    viewLeft: 0,
    viewRight: 960,
    cssWidth: 3840,
    count: 48,
  });
  assert.equal(range.scale, 0.5);
  assert.equal(range.visibleFrom, 0);
  assert.equal(range.visibleTo, 23);
  assert.equal(range.to, 24);
});

test('R30A · 末尾不越界（最后一格不再多要）', () => {
  const range = cellRangeInView({
    stripLeft: -3000,
    stripWidth: 3840,
    viewLeft: 0,
    viewRight: 1000,
    cssWidth: 3840,
    count: 48,
  });
  assert.equal(range.to, 47);
});
