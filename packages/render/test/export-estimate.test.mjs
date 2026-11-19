/**
 * P21 验收：耗时预估（`export-estimate.mjs`）。
 *
 * 这个模型的全部价值在「常数有出处、口径能复算」，所以测试盯的是**结构**不是某个具体秒数：
 * 1. `settle` 必须是入参 / 模型 / 兜底三者之一，且入参优先（主线改 settle 后能直接对比）。
 * 2. 没有网页片段 → 不走舞台取帧，captureSec = 0（否则会白报几十秒）。
 * 3. 各项相加必须等于 totalSec（否则界面上三个数加起来对不上总数）。
 * 4. 关键帧稀疏要能被指出来，并且给出"重编成 1s GOP 能省多少"。
 * 5. 人话输出不能是空的、不能把 0 帧的工程算出正数。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ESTIMATE_DEFAULTS,
  SETTLE_MODEL,
  estimateExport,
  formatEstimate,
  gopSlopeMsPerGopSec,
  settleForGop,
} from '../export-estimate.mjs';

/**
 * 一个形状与 `planFromFilm` 输出一致的假计划。
 * @param {{ visual?: number, scene?: number, audio?: number, frames?: number, fps?: number }} [opts]
 */
function fakePlan(opts = {}) {
  const visual = opts.visual ?? 2;
  const scene = opts.scene ?? 1;
  const audio = opts.audio ?? 1;
  const fps = opts.fps ?? 30;
  const frames = opts.frames ?? 300;
  return {
    fps,
    duration: frames / fps,
    outputDuration: frames / fps,
    frames,
    visualClips: Array.from({ length: visual }, (_, i) => ({
      id: `v${i + 1}`,
      kind: 'video',
      src: `/tmp/clip-${i + 1}.mp4`,
      at: i,
      duration: 2,
    })),
    sceneClips: Array.from({ length: scene }, (_, i) => ({ id: `s${i + 1}`, src: 'scene.html#t=0,2', at: i })),
    audioMix: audio > 0 ? { clips: Array.from({ length: audio }, () => ({ at: 0, time: [0, 2] })) } : null,
    warnings: [],
  };
}

/**
 * @param {string} p
 * @param {number} avgGopSec
 */
function fakeProfile(p, avgGopSec) {
  return {
    path: p,
    durationSec: 8,
    fps: 30,
    keyframeCount: Math.max(1, Math.round(8 / avgGopSec)),
    avgGopSec,
    maxGopSec: avgGopSec,
    codec: 'h264',
    pixFmt: 'yuv420p',
    bitrate: 2_500_000,
    hasVideo: true,
    hasAudio: false,
    scanMs: 70,
    scanMethod: 'full',
    sampled: false,
    note: null,
  };
}

test('P21：settle 入参优先，并且会被原样写进结果', () => {
  const plan = fakePlan();
  const profiles = [fakeProfile('/tmp/clip-1.mp4', 8), fakeProfile('/tmp/clip-2.mp4', 1)];
  const auto = estimateExport({ plan, profiles });
  const manual = estimateExport({ plan, profiles, settleMsPerFrame: 100 });

  assert.equal(auto.settleSource, 'model');
  assert.equal(manual.settleSource, 'input');
  assert.equal(manual.settleMsPerFrame, 100);
  assert.ok(auto.settleMsPerFrame > manual.settleMsPerFrame);
  // 入参只影响取帧，编码/收尾不变
  assert.equal(manual.encodeSec, auto.encodeSec);
  assert.equal(manual.finishSec, auto.finishSec);
  assert.ok(manual.totalSec < auto.totalSec);
});

test('P21：三项相加等于 totalSec，且 shares 加起来 ≈100', () => {
  const estimate = estimateExport({ plan: fakePlan(), profiles: [fakeProfile('/tmp/clip-1.mp4', 8)] });
  const sum = estimate.captureSec + estimate.encodeSec + estimate.finishSec;
  assert.ok(Math.abs(sum - estimate.totalSec) < 0.02, `${sum} vs ${estimate.totalSec}`);
  const shares = estimate.contributions.reduce((acc, c) => acc + c.sharePercent, 0);
  assert.ok(Math.abs(shares - 100) < 0.5, `shares ${shares}`);
});

test('P21：没有网页片段 → 不走舞台，取帧为 0', () => {
  const plan = fakePlan({ scene: 0, visual: 2 });
  const estimate = estimateExport({ plan, profiles: [fakeProfile('/tmp/clip-1.mp4', 8)] });
  assert.equal(estimate.mode, 'ffmpeg');
  assert.equal(estimate.captureSec, 0);
  assert.equal(estimate.gopPenaltySec, null);
  assert.ok(estimate.totalSec > 0);
  assert.match(estimate.reasons[0] ?? '', /不启动浏览器/);
});

test('P21：关键帧稀疏会被点名，并给出重编后的收益', () => {
  const plan = fakePlan({ visual: 4 });
  const profiles = [fakeProfile('/tmp/clip-1.mp4', 8)];
  const estimate = estimateExport({ plan, profiles });

  assert.ok(estimate.gopPenaltySec !== null && estimate.gopPenaltySec > 0);
  const text = estimate.reasons.join('\n');
  assert.match(text, /关键帧间隔 8s/);
  assert.match(text, /整片只有 1 个关键帧/);
  assert.match(text, /1s GOP/);

  // 稀疏 vs 正常：同样帧数下，1s GOP 必须更快
  const fast = estimateExport({ plan, profiles: [fakeProfile('/tmp/clip-1.mp4', 1)] });
  assert.ok(fast.totalSec < estimate.totalSec);
  assert.equal(fast.gopPenaltySec, null, '1s GOP 不该再报"重编能省"');
  assert.match(fast.reasons.join('\n'), /关键帧间隔正常/);
});

test('P21：没有 profiles 也没有 settle → 兜底并降置信度', () => {
  const estimate = estimateExport({ plan: fakePlan() });
  assert.equal(estimate.settleSource, 'fallback');
  assert.equal(estimate.settleMsPerFrame, SETTLE_MODEL.fallbackSettleMs);
  assert.equal(estimate.confidence, 'low');
  assert.match(estimate.reasons.join('\n'), /兜底/);
});

test('P21：抽样来的 profile 会把置信度压到 medium', () => {
  const sampled = { ...fakeProfile('/tmp/clip-1.mp4', 8), sampled: true, scanMethod: 'sampled' };
  const estimate = estimateExport({ plan: fakePlan(), profiles: [sampled] });
  assert.equal(estimate.confidence, 'medium');
  assert.match(estimate.reasons.join('\n'), /抽样扫描/);
});

test('P21：settle 随 GOP 单调增，通道越多斜率越大（>3 不外推）', () => {
  const points = [0.5, 1, 3, 8].map((gop) => settleForGop(gop, 3));
  for (let i = 1; i < points.length; i += 1) {
    assert.ok((points[i] ?? 0) > (points[i - 1] ?? 0), `settle should grow: ${points.join(',')}`);
  }
  // 锚点必须原样落在 8s 上（这是 R10 的实测值，不能被模型改动）
  assert.equal(settleForGop(SETTLE_MODEL.anchorGopSec, 3), SETTLE_MODEL.anchorSettleMs);
  assert.ok(gopSlopeMsPerGopSec(1) < gopSlopeMsPerGopSec(3));
  assert.equal(gopSlopeMsPerGopSec(6), gopSlopeMsPerGopSec(3));
  assert.equal(gopSlopeMsPerGopSec(0), gopSlopeMsPerGopSec(1));
});

test('P21：质量档只影响编码，档位越高越慢', () => {
  const plan = fakePlan();
  const draft = estimateExport({ plan, quality: 'draft' });
  const standard = estimateExport({ plan, quality: 'standard' });
  const high = estimateExport({ plan, quality: 'high' });
  assert.ok(draft.encodeSec < standard.encodeSec);
  assert.ok(standard.encodeSec < high.encodeSec);
  const expectedDraft = (plan.frames * ESTIMATE_DEFAULTS.encodeMsPerFrame.draft) / 1000;
  assert.ok(Math.abs(draft.encodeSec - expectedDraft) < 0.01, `${draft.encodeSec} vs ${expectedDraft}`);
  // 不认识的档位退回 standard，不静默按 0 算
  assert.equal(estimateExport({ plan, quality: 'ultra' }).encodeSec, standard.encodeSec);
});

test('P21：人话输出包含三个分项与合计', () => {
  const estimate = estimateExport({ plan: fakePlan(), profiles: [fakeProfile('/tmp/clip-1.mp4', 8)] });
  const text = formatEstimate(estimate);
  assert.match(text, /^ESTIMATE /);
  for (const label of ['取帧', '编码', '收尾', '合计']) assert.ok(text.includes(label), `missing ${label}`);
  assert.ok(text.split('\n').length >= 5);
});

test('P21：plan 不合法直接抛错，不返回一个"看起来还行"的 0', () => {
  assert.throws(() => estimateExport({ plan: { frames: 0 } }), /positive number/);
  assert.throws(() => estimateExport(/** @type {any} */ ({})), /plan is required/);
});
