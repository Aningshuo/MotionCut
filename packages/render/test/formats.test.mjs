/**
 * P18 的单元测试：多格式导出的**参数层与编码层**。
 *
 * 只测能在秒级跑完的部分：
 * - stems 的 spec 拆分与文件名安全化
 * - gif 的真实编码（ffmpeg，几百毫秒）+ 循环标记 + 帧数
 *
 * 整片导出、静帧取帧这类要起 Chromium 的用例放在各自的 test 里，不进这里。
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { renderGif } from '../gif.mjs';
import { stemFileName, stemSpec } from '../stems.mjs';

const execFileAsync = promisify(execFile);

test('P18 stems：stem spec 只含一条片段，时长仍是整片', () => {
  const clip = { src: '/tmp/a.wav', at: 8, time: [0, 7.5], volume: 0.08, speed: 1, fade: [0.6, 0.6] };
  const spec = stemSpec({ duration: 30, sampleRate: 48000, channels: 2 }, clip);
  assert.equal(spec.duration, 30, 'stem 必须是整片时长，才能直接叠回时间线');
  assert.equal(spec.clips.length, 1);
  const first = /** @type {any} */ (spec.clips[0]);
  assert.deepEqual(first.time, [0, 7.5]);
  assert.notEqual(first.fade, clip.fade, 'fade 必须复制，不能共享引用');
  assert.equal(spec.sampleRate, 48000);
  assert.equal(spec.channels, 2);
});

test('P18 stems：文件名安全化（空格/斜杠/中文都不能直接当文件名）', () => {
  assert.equal(stemFileName('tone-1'), 'tone-1.wav');
  assert.equal(stemFileName('a b/c'), 'a_b_c.wav');
  assert.equal(stemFileName('人声 01'), '人声_01.wav'); // 中文必须保留，否则用户分不清谁是谁
  assert.equal(stemFileName(''), 'clip.wav');
  assert.ok(stemFileName('x'.repeat(200)).length <= 84);
});

test('P18 gif：6 帧真编码，帧数/循环标记/文件名都对', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p18-gif-test-'));
  try {
    // 用 ffmpeg 造 6 帧不同颜色的 PNG（不依赖任何素材文件）
    await execFileAsync('ffmpeg', [
      '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=12:duration=0.5',
      '-frames:v', '6', path.join(dir, 'frame-%06d.png'),
    ]);
    const out = path.join(dir, 'out.gif');
    const gif = await renderGif({ framesDir: dir, frames: 6, fps: 12, width: 160, outPath: out });
    assert.equal(gif.frames, 6);
    assert.equal(gif.fps, 12);
    assert.ok(gif.bytes > 0);

    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_read_frames,width', '-of', 'json', out,
    ]);
    const stream = JSON.parse(stdout).streams[0];
    assert.equal(Number(stream.nb_read_frames), 6, 'GIF 帧数必须等于输入帧数');
    assert.equal(Number(stream.width), 160, '宽度必须按 --width 缩放');

    const bytes = await fs.readFile(out);
    assert.ok(bytes.includes(Buffer.from('NETSCAPE2.0')), 'GIF 必须带 NETSCAPE2.0 扩展（-loop 0 的落地形式）');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('P18 gif：参数非法时先拒绝，不留半成品', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p18-gif-bad-'));
  try {
    const out = path.join(dir, 'bad.gif');
    await assert.rejects(renderGif({ framesDir: dir, frames: 0, fps: 12, width: 160, outPath: out }), /INVALID/);
    await assert.rejects(renderGif({ framesDir: dir, frames: 6, fps: 0, width: 160, outPath: out }), /INVALID/);
    await assert.rejects(renderGif({ framesDir: dir, frames: 6, fps: 12, width: 8, outPath: out }), /INVALID/);
    await assert.rejects(fs.stat(out), { code: 'ENOENT' }, '参数错误不得产出文件');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
