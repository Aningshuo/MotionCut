/**
 * P21 验收：素材体检（`media-probe.mjs`）。
 *
 * 覆盖四件容易被"优化"掉的事：
 * 1. `avgGopSec` 的口径（= 时长 / 关键帧数）：单关键帧素材必须等于时长，1s GOP 素材必须 ≈1。
 * 2. 音频文件没有视频流时**不抛错**：返回 hasVideo=false，让上层知道"这条没法按 GOP 归因"。
 * 3. 文件不存在 → `MEDIA_MISSING`，别把 ENOENT 漏出去。
 * 4. 扫描预算不够时必须退化成抽样并标 `sampled:true`，而不是硬扫下去或返回错误。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { MediaProbeError, probeVideoProfile, isSparseGop } from '../media-probe.mjs';

const execFileAsync = promisify(execFile);
const ROOT = new URL('../../../', import.meta.url).pathname;
const BARS = path.join(ROOT, 'tests/fixtures/media/bars-3s-720p30.mp4');
const TONE = path.join(ROOT, 'tests/fixtures/media/tone-1khz-3s.wav');

/** @type {string} */
let workDir;

before(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-probe-'));
});

after(async () => {
  if (workDir) await fs.rm(workDir, { recursive: true, force: true });
});

/**
 * 用 lavfi 造一条确定 GOP 的素材（-g N = 每 N 帧一个关键帧）。
 * @param {string} name
 * @param {number} gop
 * @param {number} seconds
 * @returns {Promise<string>}
 */
async function makeClip(name, gop, seconds) {
  const file = path.join(workDir, name);
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=s=160x90:r=30:d=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30',
    '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p', '-an', file,
  ]);
  return file;
}

test('P21：1s GOP 素材 avgGopSec ≈ 1，单关键帧素材 avgGopSec = 时长', async () => {
  const oneSecond = await makeClip('gop1.mp4', 30, 4);
  // 8s：单关键帧素材的 avgGop 等于整片长度，要高于 5s 那条经验分界线才能算 "sparse"
  const single = await makeClip('gop-single.mp4', 100000, 8);

  const a = await probeVideoProfile(oneSecond);
  assert.equal(a.scanMethod, 'full');
  assert.equal(a.sampled, false);
  assert.ok(a.keyframeCount >= 3, `expected >=3 keyframes, got ${a.keyframeCount}`);
  assert.ok(Math.abs((a.avgGopSec ?? 0) - 1) < 0.2, `avgGop ${a.avgGopSec} should be ~1`);
  assert.ok((a.maxGopSec ?? 0) <= 1.2, `maxGop ${a.maxGopSec} should be <=1.2`);

  const b = await probeVideoProfile(single);
  assert.equal(b.keyframeCount, 1);
  // 整段只有 1 个关键帧 → 平均间隔就是整片长度
  assert.ok(Math.abs((b.avgGopSec ?? 0) - (b.durationSec ?? 0)) < 0.05, `avgGop ${b.avgGopSec} should equal duration ${b.durationSec}`);
  assert.ok((b.maxGopSec ?? 0) >= (b.durationSec ?? 0) - 0.05);
  assert.equal(isSparseGop(b), true);
  assert.equal(isSparseGop(a), false);
});

test('P21：音频文件不抛错，返回 hasVideo=false', async () => {
  const profile = await probeVideoProfile(TONE);
  assert.equal(profile.hasVideo, false);
  assert.equal(profile.hasAudio, true);
  assert.equal(profile.keyframeCount, 0);
  assert.equal(profile.avgGopSec, null);
  assert.equal(profile.scanMethod, 'none');
  assert.match(profile.note ?? '', /no video stream/);
});

test('P21：文件不存在 → MEDIA_MISSING', async () => {
  await assert.rejects(
    () => probeVideoProfile(path.join(workDir, 'nope.mp4')),
    (/** @type {any} */ err) => err instanceof MediaProbeError && err.code === 'MEDIA_MISSING',
  );
});

test('P21：扫描预算不足 → 退化成抽样并标 sampled:true', async () => {
  const file = await makeClip('gop2.mp4', 60, 6);
  const forced = await probeVideoProfile(file, { maxScanMs: 1 });
  assert.equal(forced.sampled, true);
  assert.equal(forced.scanMethod, 'sampled');
  assert.match(forced.note ?? '', /sampled \d+ windows/);
  // 抽样只能给估计值：方向必须和真实值一致（±50%），不能给出"0 个关键帧"这种结论
  const real = await probeVideoProfile(file);
  assert.ok((forced.avgGopSec ?? 0) > (real.avgGopSec ?? 0) * 0.5);
  assert.ok((forced.avgGopSec ?? 0) < (real.avgGopSec ?? 0) * 1.5);
  assert.ok((forced.maxGopSec ?? 0) <= (real.maxGopSec ?? 0) + 0.1, 'maxGop 在抽样下是下界');
});

test('P21：仓库自带 fixture 可被体检', async () => {
  const profile = await probeVideoProfile(BARS);
  assert.equal(profile.hasVideo, true);
  assert.ok((profile.durationSec ?? 0) > 2.5);
  assert.ok(profile.keyframeCount >= 1);
  assert.ok(profile.scanMs >= 0);
});
