import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CANVAS_FRAME_VERSION,
  clampCrop,
  contentPixelBox,
  emptyBands,
  featherBand,
  insideContent,
  mapRect,
  planCanvasFrame,
  unmapPoint,
} from '../canvas-frame.mjs';

const STAGE = { w: 1280, h: 720 };

/** 16:9 / 9:16 / 4:3 三档（与 P59 的验收矩阵同一组）。 */
const OUTPUTS = [
  { id: '16:9', size: { w: 1280, h: 720 } },
  { id: '9:16', size: { w: 1080, h: 1920 } },
  { id: '4:3', size: { w: 1440, h: 1080 } },
];

test('planCanvasFrame: 三比例的 scale / 画面框 / 黑边与手算一致', () => {
  const rows = OUTPUTS.map((row) => {
    const frame = planCanvasFrame({ stage: STAGE, output: row.size, fit: 'letterbox' });
    return {
      id: row.id,
      scale: Number(frame.scale.toFixed(6)),
      content: [
        Number(frame.content.x.toFixed(3)),
        Number(frame.content.y.toFixed(3)),
        Number(frame.content.w.toFixed(3)),
        Number(frame.content.h.toFixed(3)),
      ],
      bars: frame.bars,
      bands: emptyBands(frame),
      box: contentPixelBox(frame),
    };
  });
  /* 手算：
     16:9  1280×720 → scale 1        content 1280×720  at (0,0)        bars 0/0/0/0
     9:16  1080×1920 → scale 0.84375 content 1080×607.5 at (0,656.25)  bars 656.25/656.25/0/0
     4:3   1440×1080 → scale 1.125   content 1440×810   at (0,135)     bars 135/135/0/0 */
  assert.deepEqual(rows, [
    { id: '16:9', scale: 1, content: [0, 0, 1280, 720], bars: { top: 0, bottom: 0, left: 0, right: 0 }, bands: { top: 0, bottom: 0, left: 0, right: 0 }, box: { left: 0, top: 0, right: 1279, bottom: 719, width: 1280, height: 720 } },
    { id: '9:16', scale: 0.84375, content: [0, 656.25, 1080, 607.5], bars: { top: 656.25, bottom: 656.25, left: 0, right: 0 }, bands: { top: 656, bottom: 656, left: 0, right: 0 }, box: { left: 0, top: 656, right: 1079, bottom: 1263, width: 1080, height: 608 } },
    { id: '4:3', scale: 1.125, content: [0, 135, 1440, 810], bars: { top: 135, bottom: 135, left: 0, right: 0 }, bands: { top: 135, bottom: 135, left: 0, right: 0 }, box: { left: 0, top: 135, right: 1439, bottom: 944, width: 1440, height: 810 } },
  ]);
  const [first] = OUTPUTS;
  assert.ok(first, 'OUTPUTS 至少一行');
  assert.equal(planCanvasFrame({ stage: STAGE, output: first.size }).version, CANVAS_FRAME_VERSION);
});

test('planCanvasFrame: fit=none 就是画布本身，scale=1 且没有黑边', () => {
  const frame = planCanvasFrame({ stage: STAGE, output: { w: 1920, h: 1080 }, fit: 'none' });
  assert.equal(frame.fit, 'none');
  assert.equal(frame.scale, 1);
  assert.deepEqual(frame.output, STAGE);
  assert.deepEqual(frame.content, { x: 0, y: 0, w: 1280, h: 720 });
  assert.deepEqual(emptyBands(frame), { top: 0, bottom: 0, left: 0, right: 0 });
});

test('mapRect / unmapPoint 互逆：画布矩形映射到成片再换算回来是原值', () => {
  const rect = { x: 128, y: 72, w: 640, h: 360 };
  for (const row of OUTPUTS) {
    const frame = planCanvasFrame({ stage: STAGE, output: row.size, fit: 'letterbox' });
    const mapped = mapRect(rect, frame);
    const back = unmapPoint({ x: mapped.x, y: mapped.y }, frame);
    assert.ok(Math.abs(back.x - rect.x) < 1e-9, `${row.id} x`);
    assert.ok(Math.abs(back.y - rect.y) < 1e-9, `${row.id} y`);
    assert.ok(Math.abs(mapped.w - rect.w * frame.scale) < 1e-9, `${row.id} w`);
  }
});

test('insideContent：黑边上的点不在画面框里（9:16 上下各 656 行）', () => {
  const portrait = OUTPUTS[1];
  assert.ok(portrait, 'OUTPUTS 第二行是竖屏');
  const frame = planCanvasFrame({ stage: STAGE, output: portrait.size, fit: 'letterbox' });
  assert.equal(insideContent({ x: 540, y: 100 }, frame), false, '上方黑边');
  assert.equal(insideContent({ x: 540, y: 1800 }, frame), false, '下方黑边');
  assert.equal(insideContent({ x: 540, y: 960 }, frame), true, '画面中心');
  assert.equal(insideContent({ x: -1, y: 960 }, frame), false, '左边外');
});

test('featherBand：成片像素 = 画布像素 × scale，换算回来恒定', () => {
  const authored = 40;
  const seen = OUTPUTS.map((row) => {
    const frame = planCanvasFrame({ stage: STAGE, output: row.size, fit: 'letterbox' });
    const band = featherBand(authored, frame);
    return { id: row.id, outputPx: Number(band.outputPx.toFixed(4)), expected: band.expectedOutputPx, canvas: band.canvasPx };
  });
  assert.deepEqual(seen, [
    { id: '16:9', outputPx: 40, expected: 40, canvas: 40 },
    { id: '9:16', outputPx: 33.75, expected: 34, canvas: 40 },
    { id: '4:3', outputPx: 45, expected: 45, canvas: 40 },
  ]);
});

test('clampCrop：cover 不放大源，偏移夹进源范围，越界标出来', () => {
  const source = { w: 1920, h: 1080 };
  const box = { w: 640, h: 360 };
  const fit = clampCrop({ source, box });
  assert.equal(fit.upscaled, false);
  assert.equal(fit.zoom, 1 / 3);
  assert.deepEqual(fit.visible, { w: 1920, h: 1080 });
  assert.deepEqual(fit.offset, { x: 0, y: 0 });

  const over = clampCrop({ source, box, offset: { x: 9999, y: -50 } });
  assert.equal(over.offset.x, 0, '1920 宽的源在 zoom=1/3 时整个都可见，没有可偏移的余量');
  assert.equal(over.offset.y, 0);
  assert.equal(over.insideSource, true);

  const half = clampCrop({ source, box, zoom: 0.5, offset: { x: 9999, y: 9999 } });
  assert.deepEqual(half.visible, { w: 1280, h: 720 });
  assert.deepEqual(half.offset, { x: 640, y: 360 }, '夹到 maxOffset');
  assert.equal(half.clamped.x, true);
  assert.equal(half.clamped.y, true);

  const up = clampCrop({ source, box, zoom: 2 });
  assert.equal(up.zoom, 1, '缩放夹到 ≤1');
  assert.equal(up.upscaled, true, '请求过 >1 必须标出来，不静默改语义');
  assert.equal(up.requestedZoom, 2);
});
