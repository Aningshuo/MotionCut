/**
 * P34 验收：响度标准化。
 *
 * 全部真 ffmpeg：两遍 loudnorm + ebur128 复核。断言的是**实测值**，不是「跑通了」：
 * - streaming → |I − (−14)| ≤ 0.5 LUFS，TP ≤ −1.0 dBTP；
 * - broadcast → |I − (−23)| ≤ 0.5 LUFS，TP ≤ −1.0 dBTP；
 * - 静音 → `LOUDNESS_UNMEASURABLE`，**不抛**，且不动输入文件；
 * - 超短（0.5s）→ 不许崩（能测就测，测不到就报 UNMEASURABLE）。
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  LOUDNESS_PRESETS,
  TP_HEADROOM_DB,
  formatLoudnessLine,
  measureDeliveredLoudness,
  normalizeLoudness,
  parseEbur128,
  parseLoudnormJson,
  resolveLoudnessPreset,
  summarizeLoudness,
} from '../loudness.mjs';

const execFileAsync = promisify(execFile);
const ROOT = new URL('../../../', import.meta.url).pathname;
const MEDIA = path.join(ROOT, 'tests/fixtures/media');

/** @type {string} */
let workDir;

test.before(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-loudness-'));
});

test.after(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

/** @param {string} file @param {string[]} args */
async function ffmpeg(file, ...args) {
  await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, ...args]);
}

test('P34：三档归一（缺省 off，别名可用，未知要拒）', () => {
  assert.equal(resolveLoudnessPreset(undefined), 'off');
  assert.equal(resolveLoudnessPreset(''), 'off');
  assert.equal(resolveLoudnessPreset('off'), 'off');
  assert.equal(resolveLoudnessPreset('streaming'), 'streaming');
  assert.equal(resolveLoudnessPreset('STREAM'), 'streaming');
  assert.equal(resolveLoudnessPreset('broadcast'), 'broadcast');
  assert.equal(resolveLoudnessPreset('ebu'), 'broadcast');
  assert.throws(() => resolveLoudnessPreset('loud'), (err) => {
    assert.equal(/** @type {any} */ (err).code, 'E_USAGE');
    assert.match(/** @type {any} */ (err).message, /off\|streaming\|broadcast/);
    return true;
  });
  assert.equal(LOUDNESS_PRESETS.streaming.I, -14);
  assert.equal(LOUDNESS_PRESETS.broadcast.I, -23);
  assert.equal(LOUDNESS_PRESETS.streaming.TP, -1);
  assert.equal(TP_HEADROOM_DB, 0.5);
});

test('P34-A1：streaming → I=−14±0.5 LUFS、TP ≤ −1.0 dBTP', async () => {
  const out = path.join(workDir, 'streaming.wav');
  const report = await normalizeLoudness({
    wavPath: path.join(MEDIA, 'tone-1khz-3s.wav'),
    outPath: out,
    preset: 'streaming',
  });
  assert.equal(report.measurable, true);
  assert.equal(report.code, null);
  assert.ok(Math.abs(report.output.I - -14) <= 0.5, `I=${report.output.I} not within ±0.5 of −14`);
  assert.ok(report.output.TP <= -1.0, `TP=${report.output.TP} > -1.0 dBTP`);
  // 源是 −21 LUFS：增益必须是**放大**，不是缩小
  assert.ok(report.gainDb > 6, `gain=${report.gainDb}dB should be about +7dB`);
  assert.equal(report.target.I, -14);
  assert.equal(report.encodeTarget.TP, -1.5);
  // 编码器输入的目标比交付目标低 0.5dB（给 AAC 过冲留余量）
  assert.equal(report.encodeTarget.TP, report.target.TP - TP_HEADROOM_DB);

  // 独立复核：再量一遍落盘的 wav，数要对得上报告
  const again = await measureDeliveredLoudness(out);
  assert.ok(again.integratedLufs !== null && again.truePeakDbtp !== null);
  assert.ok(Math.abs(again.integratedLufs - report.output.I) <= 0.1);
  assert.ok(again.truePeakDbtp <= -1.0);
});

test('P34-A2：broadcast → I=−23±0.5 LUFS、TP ≤ −1.0 dBTP', async () => {
  const out = path.join(workDir, 'broadcast.wav');
  const report = await normalizeLoudness({
    wavPath: path.join(MEDIA, 'tone-1khz-3s.wav'),
    outPath: out,
    preset: 'broadcast',
  });
  assert.equal(report.measurable, true);
  assert.ok(Math.abs(report.output.I - -23) <= 0.5, `I=${report.output.I} not within ±0.5 of −23`);
  assert.ok(report.output.TP <= -1.0, `TP=${report.output.TP} > -1.0 dBTP`);
  // 同一素材、两档：目标差 9 LU，实际增益也该差 9 dB 左右
  assert.ok(Math.abs(report.gainDb - (-1.95)) < 1.5, `gain=${report.gainDb}dB`);
});

test('P34-A4：全静音 → LOUDNESS_UNMEASURABLE，不抛、不动输入', async () => {
  const silent = path.join(workDir, 'silent.wav');
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '3',
    '-c:a', 'pcm_f32le', silent,
  ]);
  const before = await fs.readFile(silent);
  const out = path.join(workDir, 'silent-out.wav');
  const report = await normalizeLoudness({ wavPath: silent, outPath: out, preset: 'streaming' });
  assert.equal(report.measurable, false);
  assert.equal(report.code, 'LOUDNESS_UNMEASURABLE');
  assert.match(report.reason, /input_i|silence/);
  // 回退到原文件：调用方拿到的 path 必须还能用（继续出片）
  assert.equal(report.path, silent);
  assert.equal(report.gainDb, null);
  // 归一化产物不该被写出来（没东西可写）
  await assert.rejects(() => fs.stat(out));
  // 输入文件一个字节都没变
  assert.deepEqual(await fs.readFile(silent), before);
});

test('P34：超短（0.5s）不许崩', async () => {
  const short = path.join(workDir, 'short.wav');
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5',
    '-ar', '48000', '-ac', '2', '-c:a', 'pcm_f32le', short,
  ]);
  const report = await normalizeLoudness({
    wavPath: short,
    outPath: path.join(workDir, 'short-out.wav'),
    preset: 'streaming',
  });
  // 要么测得到（且达标），要么明说测不到——但不许抛，也不许静默给个假数
  if (report.measurable) {
    assert.ok(Number.isFinite(report.output.I));
    assert.ok(Math.abs(report.output.I - -14) <= 0.5);
  } else {
    assert.equal(report.code, 'LOUDNESS_UNMEASURABLE');
  }
});

test('P34：单声道源上混后照常达标', async () => {
  const mono = path.join(workDir, 'mono.wav');
  // 单声道 + 44.1k：混音阶段会 `-ac 2` 上混、`-ar 48000` 重采样，响度不该因此跑偏
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=4',
    '-af', 'volume=0.25', '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', mono,
  ]);
  const upmixed = path.join(workDir, 'mono-48k-stereo.wav');
  await ffmpeg(mono, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_f32le', upmixed);
  const report = await normalizeLoudness({
    wavPath: upmixed,
    outPath: path.join(workDir, 'mono-out.wav'),
    preset: 'streaming',
  });
  assert.equal(report.measurable, true);
  assert.ok(Math.abs(report.output.I - -14) <= 0.5);
  assert.ok(report.output.TP <= -1.0);
});

test('P34：loudnorm 的 "-inf" 也要能解析（静音不是 JSON）', () => {
  const stderr = [
    '[Parsed_loudnorm_0 @ 0x1] ',
    '{',
    '\t"input_i" : "-inf",',
    '\t"input_tp" : "-inf",',
    '\t"input_lra" : "0.00",',
    '\t"input_thresh" : "-inf",',
    '\t"target_offset" : "0.00"',
    '}',
  ].join('\n');
  const fields = parseLoudnormJson(stderr);
  assert.equal(fields.input_i, '-inf');
  assert.equal(fields.input_lra, '0.00');
  assert.equal(Number.isFinite(Number(fields.input_i)), false);
  // ebur128 的 summary 解析
  const summary = parseEbur128(
    ['Summary:', '', '  Integrated loudness:', '    I:         -14.0 LUFS', '', '  True peak:', '    Peak:      -1.4 dBFS'].join('\n'),
  );
  assert.equal(summary.I, -14);
  assert.equal(summary.TP, -1.4);
});

test('P34：报告摘要与人读一行', () => {
  const summary = summarizeLoudness({
    preset: 'streaming',
    target: { I: -14, TP: -1, LRA: 11 },
    encodeTarget: { I: -14, TP: -1.5, LRA: 11 },
    input: { I: -21.05, TP: -21.07, LRA: 0, thresh: -31.05 },
    output: { I: -14, TP: -14, LRA: 0 },
    delivered: { I: -14, TP: -13.9, LRA: 0, iWithinHalfLu: true, tpWithinTarget: true },
    gainDb: 7.05,
    peakGainDb: 7.17,
    uniformGain: true,
    applied: 'linear',
    measured: { input_i: '-21.05' },
    code: null,
    reason: null,
    passes: 2,
  });
  assert.ok(summary);
  assert.equal(summary.preset, 'streaming');
  assert.equal(summary.gainDb, 7.05);
  assert.equal(summary.measured.input_i, '-21.05');
  assert.equal(
    formatLoudnessLine(summary),
    'loudness=streaming -21.1→-14.0 LUFS (+7.0dB) TP -13.9dBTP',
  );

  const silent = summarizeLoudness({ preset: 'broadcast', code: 'LOUDNESS_UNMEASURABLE', reason: 'silence' });
  assert.match(formatLoudnessLine(silent), /loudness=broadcast UNMEASURABLE \(silence\)/);
  assert.equal(formatLoudnessLine(null), 'loudness=off');
});
