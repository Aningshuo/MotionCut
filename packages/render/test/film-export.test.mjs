/**
 * P12 验收（A1–A9）：按 plan 渲染真实画面 + 音轨。
 *
 * 全部真实 ffmpeg/ffprobe。30s 结构片用 testsrc2 生成（测试素材，不是成品验收）。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parse } from '../../film-core/film-doc.mjs';
import { FilmPlanError, planFromFilm } from '../film-plan.mjs';
import { assertRenderable, renderFilmExport, renderFilmVideo } from '../film-export.mjs';
import { probeMedia } from '../verify.mjs';

const execFileAsync = promisify(execFile);

/** @type {string} */
let workDir;
/** @type {string} */
let tmpRoot;

before(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-film-export-'));
  tmpRoot = path.join(workDir, 'tmp');
  await fs.mkdir(tmpRoot, { recursive: true });
  process.env.TMPDIR = tmpRoot;
  await fs.mkdir(path.join(workDir, 'assets'), { recursive: true });

  // 30s 测试图案：红色底 + 随时间旋转的色相（亮度恒定，便于测 fade；
  // 颜色随时间变化，便于判断「取的是不是这一秒」）
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', "color=c=red:s=640x360:r=30:d=30,hue=h='t*120':s=1",
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
    path.join(workDir, 'assets/src-30s.mp4'),
  ]);

  // 30s 音轨：1.0s 处一个 10ms 1kHz 脉冲，其余静音
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', "aevalsrc='if(between(t,1,1.01),0.9*sin(2*PI*1000*t),0)':s=48000:d=30:c=stereo",
    path.join(workDir, 'assets/pulse-30s.wav'),
  ]);
});

after(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

/**
 * @param {string} html
 * @returns {any}
 */
function docOf(html) {
  const { doc, diagnostics } = parse(html, { path: 'film.html' });
  assert.ok(doc, `parse failed: ${diagnostics.map((d) => d.message).join('; ')}`);
  return doc;
}

/** 30s 结构片：三段画面 + 段间 fade + 30s 音轨。 */
function film30Html() {
  return `<!doctype html><html><head><meta name="viewport" content="width=640, height=360"></head><body>
<section><video id="seg-1" src="assets/src-30s.mp4#t=0,10" at="0" overrides='[{"fade":[0,0.5]}]'></video>
<video id="seg-2" src="assets/src-30s.mp4#t=10,20" at="10" overrides='[{"fade":[0.5,0.5]}]'></video>
<video id="seg-3" src="assets/src-30s.mp4#t=20,30" at="20" overrides='[{"fade":[0.5,0]}]'></video></section>
<section><audio id="pulse" src="assets/pulse-30s.wav#t=0,30" at="0" volume="1"></audio></section>
</body></html>`;
}

/**
 * @param {string} file
 * @param {number} index
 * @param {{ width?: number, height?: number }} [opts]
 */
async function grayFrame(file, index, opts = {}) {
  const scale = opts.width ? `,scale=${opts.width}:${opts.height ?? Math.round((opts.width * 9) / 16)}` : '';
  const { stdout } = await execFileAsync(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-vf', `select='eq(n\\,${index})'${scale}`, '-vsync', '0', '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', '-'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout;
}

/**
 * RGB 帧（比较颜色随时间的变化；亮度恒定）。
 * @param {string} file @param {number} index
 */
async function rgbFrame(file, index) {
  const { stdout } = await execFileAsync(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-vf', `select='eq(n\,${index})',scale=64:36`, '-vsync', '0', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout;
}

/** @param {Buffer} gray */
function meanLuma(gray) {
  let sum = 0;
  for (const value of gray) sum += value;
  return sum / gray.length;
}

/** @param {Buffer} a @param {Buffer} b */
function meanAbsDiff(a, b) {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return sum / n;
}

/** @param {string} file */
async function decodeAudio(file) {
  const { stdout } = await execFileAsync(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-vn', '-ac', '2', '-ar', '48000', '-f', 'f32le', '-'],
    { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 },
  );
  const pcm = new Float32Array(stdout.length / 4);
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = stdout.readFloatLE(i * 4);
  return { pcm, frames: pcm.length / 2 };
}

/** @param {string} name */
async function sha256(name) {
  return crypto.createHash('sha256').update(await fs.readFile(name)).digest('hex');
}

// ---- A1 / A2 / A3 / A5：一次 30s 渲染 ----------------------------------

test('P12-A1/A2/A3/A5 30s 结构片：900 帧、双流 30s、末帧有画面、段间 fade、脉冲 1.000s', async () => {
  const doc = docOf(film30Html());
  const plan = await planFromFilm(doc, { projectRoot: workDir, fps: 30 });
  assert.equal(plan.duration, 30);
  assert.equal(plan.frames, 900);
  assert.equal(plan.visualClips.length, 3);
  assert.ok(plan.audioMix);
  assert.equal(plan.audioMix.clips.length, 1);

  const out = path.join(workDir, 'out-30s.mp4');
  const started = Date.now();
  const result = await renderFilmExport({ plan, projectRoot: workDir, outPath: out });
  const elapsed = Date.now() - started;

  // A1
  const probe = result.probe;
  assert.equal(probe.video.frames, 900);
  assert.ok(Math.abs(probe.video.durationSec - 30) <= 1 / 30 + 0.001, `video ${probe.video.durationSec}`);
  assert.ok(Math.abs(probe.audio.durationSec - 30) <= 1 / 30 + 0.001, `audio ${probe.audio.durationSec}`);
  assert.ok(Math.abs(probe.format.durationSec - 30) <= 1 / 30 + 0.001, `container ${probe.format.durationSec}`);
  assert.equal(result.decode.exitCode, 0);
  assert.ok(elapsed < 180_000, `30s export took ${elapsed}ms`);

  // A2：末帧有画面；三段中点互不相同
  const last = meanLuma(await grayFrame(result.path, 899));
  const first = meanLuma(await grayFrame(result.path, 0));
  assert.ok(last > 30, `last frame luma ${last}`);
  const mids = [await rgbFrame(result.path, 150), await rgbFrame(result.path, 450), await rgbFrame(result.path, 750)];
  const m0 = /** @type {Buffer} */ (mids[0]);
  const m1 = /** @type {Buffer} */ (mids[1]);
  const m2 = /** @type {Buffer} */ (mids[2]);
  const diffs = [meanAbsDiff(m0, m1), meanAbsDiff(m0, m2), meanAbsDiff(m1, m2)];
  assert.ok(Math.min(...diffs) > 20, `segments look identical: ${diffs.map((d) => d.toFixed(2)).join('/')}`);
  assert.ok(first > 30, `first frame luma ${first}`);

  // A3：段间 fade —— 边界两侧的亮度显著低于段中
  const midLuma = meanLuma(await grayFrame(result.path, 150));
  const beforeBoundary = meanLuma(await grayFrame(result.path, 299)); // 9.9667s
  const afterBoundary = meanLuma(await grayFrame(result.path, 300)); // 10.0s
  assert.ok(beforeBoundary < midLuma * 0.5, `fade-out missing at 9.967s: ${beforeBoundary} vs ${midLuma}`);
  assert.ok(afterBoundary < midLuma * 0.5, `fade-in missing at 10.0s: ${afterBoundary} vs ${midLuma}`);

  // 音轨 30s 连续（至少存在且非全静音）
  const audio = await decodeAudio(result.path);
  assert.ok(Math.abs(audio.frames / 48000 - 30) <= 1 / 30 + 0.001, `audio frames ${audio.frames / 48000}`);
  let audioPeak = 0;
  for (const value of audio.pcm) audioPeak = Math.max(audioPeak, Math.abs(value));
  assert.ok(audioPeak > 0.1, `audio is silent (${audioPeak})`);

  // A5：1kHz 脉冲在 1.000s ±1ms
  let onset = -1;
  for (let frame = Math.round(0.9 * 48000); frame < Math.round(1.1 * 48000); frame += 1) {
    if (Math.abs(audio.pcm[frame * 2] ?? 0) > 0.3) {
      onset = frame;
      break;
    }
  }
  assert.ok(onset >= 0, 'pulse not found');
  const pulseSec = onset / 48000;
  assert.ok(Math.abs(pulseSec - 1) <= 0.001, `pulse at ${pulseSec}s`);
  // 双流差
  assert.ok(Math.abs(probe.video.durationSec - probe.audio.durationSec) <= 1 / 30 + 0.001);

  // 报告
  console.log(JSON.stringify({
    elapsedMs: elapsed,
    path: result.path,
    bytes: result.bytes,
    sha256: result.sha256,
    video: { frames: probe.video.frames, duration: probe.video.durationSec },
    audio: { duration: probe.audio.durationSec, peak: audioPeak },
    luma: { first, last, mid: midLuma, beforeBoundary, afterBoundary },
    segmentDiffs: diffs,
    pulseSec,
    decode: result.decode.exitCode,
  }));
});

// ---- A4 -----------------------------------------------------------------

test('P12-A4 两段 10s：#t 入出点、at=5、speed=2 逐帧对应源画面', async () => {
  const doc = docOf(`<!doctype html><html><head><meta name="viewport" content="width=640, height=360"></head><body>
<section><video id="a" src="assets/src-30s.mp4#t=0,5" at="0"></video></section>
<section><video id="b" src="assets/src-30s.mp4#t=10,20" at="5" speed="2"></video></section>
<section><audio id="p" src="assets/pulse-30s.wav#t=0,10" at="0" volume="0.5"></audio></section>
</body></html>`);
  const plan = await planFromFilm(doc, { projectRoot: workDir, fps: 30 });
  assert.equal(plan.duration, 10);
  assert.equal(plan.frames, 300);
  assert.deepEqual(plan.visualClips.map((c) => c.at), [0, 5]);
  assert.deepEqual(plan.visualClips[1].time, [10, 20]);
  assert.equal(plan.visualClips[1].speed, 2);

  const out = path.join(workDir, 'out-10s.mp4');
  const result = await renderFilmExport({ plan, projectRoot: workDir, outPath: out });
  assert.equal(result.probe.video.frames, 300);

  const src = path.join(workDir, 'assets/src-30s.mp4');
  // 第 1s：第一段源 1s
  const out1 = await rgbFrame(result.path, 30);
  const src1 = await rgbFrame(src, 30);
  const srcWrong = await rgbFrame(src, 90);
  assert.ok(meanAbsDiff(out1, src1) < 10, `frame 1s does not match source 1s: ${meanAbsDiff(out1, src1)}`);
  assert.ok(meanAbsDiff(out1, srcWrong) > 50, `frame 1s accidentally matches source 3s`);

  // 第 6s：第二段 at=5 + 1s×speed2 → 源 12s
  const out6 = await rgbFrame(result.path, 180);
  const src12 = await rgbFrame(src, 360);
  const src14 = await rgbFrame(src, 420);
  assert.ok(meanAbsDiff(out6, src12) < 10, `frame 6s does not match source 12s: ${meanAbsDiff(out6, src12)}`);
  assert.ok(meanAbsDiff(out6, src14) > 50, `frame 6s accidentally matches source 14s`);

  // 段尾：10s 片到 10s，最后一段在 5+5=10s 结束
  assert.ok(Math.abs(result.probe.video.durationSec - 10) <= 1 / 30 + 0.001);
});

// ---- A6 -----------------------------------------------------------------

test('P12-A6 网页片段：UNSUPPORTED_SCENE_CLIP，不产出 mp4 / .partial / 混音目录', async () => {
  const doc = docOf(`<!doctype html><html><head><meta name="viewport" content="width=640, height=360"></head><body>
<section><iframe id="page-a" src="scene.html#t=0,5" at="0"></iframe></section>
<section><video id="v" src="assets/src-30s.mp4#t=0,5" at="0"></video></section>
<section><audio id="p" src="assets/pulse-30s.wav#t=0,5" at="0"></audio></section>
</body></html>`);
  const plan = await planFromFilm(doc, { projectRoot: workDir, fps: 30 });
  assert.equal(plan.sceneClips.length, 1);

  const out = path.join(workDir, 'out-scene.mp4');
  const before = (await fs.readdir(tmpRoot)).sort();
  await assert.rejects(
    renderFilmExport({ plan, projectRoot: workDir, outPath: out }),
    (/** @type {any} */ err) => err instanceof FilmPlanError && err.code === 'UNSUPPORTED_SCENE_CLIP' && err.clipId === 'page-a',
  );
  assert.deepEqual(
    (await fs.readdir(workDir)).filter((n) => n.startsWith('out-scene')),
    [],
  );
  assert.deepEqual((await fs.readdir(tmpRoot)).sort(), before, 'no mix temp dir should be created');
});

// ---- A7 -----------------------------------------------------------------

test('P12-A7 坏源 → 明确错误码、无残留；取消 → CANCELLED、无残留', async () => {
  const doc = docOf(`<!doctype html><html><head><meta name="viewport" content="width=640, height=360"></head><body>
<section><video id="v" src="assets/src-30s.mp4#t=0,5" at="0"></video></section>
<section><audio id="p" src="assets/pulse-30s.wav#t=0,5" at="0"></audio></section>
</body></html>`);
  const plan = await planFromFilm(doc, { projectRoot: workDir, fps: 30 });
  const broken = JSON.parse(JSON.stringify(plan));
  const brokenFile = path.join(workDir, 'assets', 'broken.mp4');
  await fs.writeFile(brokenFile, 'not a video');
  broken.visualClips[0].src = brokenFile;

  const badOut = path.join(workDir, 'out-broken.mp4');
  await assert.rejects(renderFilmExport({ plan: broken, projectRoot: workDir, outPath: badOut }), (/** @type {any} */ err) => {
    return typeof err.code === 'string' && err.code.length > 0;
  });
  assert.deepEqual((await fs.readdir(workDir)).filter((n) => n.startsWith('out-broken')), []);

  // 取消：30s 渲染，150ms 后 abort
  const longDoc = docOf(film30Html());
  const longPlan = await planFromFilm(longDoc, { projectRoot: workDir, fps: 30 });
  const controller = new AbortController();
  const cancelOut = path.join(workDir, 'out-cancel.mp4');
  const running = renderFilmExport({ plan: longPlan, projectRoot: workDir, outPath: cancelOut, signal: controller.signal });
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(running, (/** @type {any} */ err) => err.code === 'CANCELLED');
  assert.deepEqual((await fs.readdir(workDir)).filter((n) => n.startsWith('out-cancel')), []);
  assert.deepEqual((await fs.readdir(tmpRoot)).filter((n) => n.startsWith('opencut-film-')), []);
});

test('P12-A7 旋转/圆角 box.r≠0 → UNSUPPORTED（不静默丢）', async () => {
  const doc = docOf(`<!doctype html><html><head><meta name="viewport" content="width=640, height=360"></head><body>
<section><video id="v" src="assets/src-30s.mp4#t=0,5" at="0" style="left: 10px; top: 20px; width: 320px; height: 180px; rotate: 8deg"></video></section>
</body></html>`);
  const plan = await planFromFilm(doc, { projectRoot: workDir, fps: 30 });
  assert.equal(plan.visualClips[0].box.r, 8);
  assert.throws(
    () => assertRenderable(plan),
    (/** @type {any} */ err) => err.code === 'UNSUPPORTED',
  );
});

// ---- A8 -----------------------------------------------------------------

test('P12-A8 只读工程；--out 已存在时不覆盖，返回实际路径', async () => {
  const doc = docOf(`<!doctype html><html><head><meta name="viewport" content="width=640, height=360"></head><body>
<section><video id="v" src="assets/src-30s.mp4#t=0,2" at="0"></video></section>
<section><audio id="p" src="assets/pulse-30s.wav#t=0,2" at="0"></audio></section>
</body></html>`);
  const filmPath = path.join(workDir, 'film.html');
  const html = `<!doctype html><html><head><meta name="viewport" content="width=640, height=360"></head><body>
<section><video id="v" src="assets/src-30s.mp4#t=0,2" at="0"></video></section>
<section><audio id="p" src="assets/pulse-30s.wav#t=0,2" at="0"></audio></section>
</body></html>`;
  await fs.writeFile(filmPath, html);
  const hashBefore = await sha256(filmPath);

  const plan = await planFromFilm(doc, { projectRoot: workDir, fps: 30 });
  const out = path.join(workDir, 'out-dup.mp4');
  const first = await renderFilmExport({ plan, projectRoot: workDir, outPath: out });
  const firstSha = first.sha256;
  const second = await renderFilmExport({ plan, projectRoot: workDir, outPath: out });

  assert.notEqual(second.path, first.path);
  assert.ok(second.path.includes(' 2.mp4'), second.path);
  assert.equal(await sha256(first.path), firstSha);
  assert.equal(await sha256(filmPath), hashBefore, 'film.html must not be modified');

  // 只读检查：工程目录里除了 film.html 没有被写出别的东西
  const projectFiles = (await fs.readdir(workDir)).filter((n) => n.endsWith('.html'));
  assert.deepEqual(projectFiles, ['film.html']);
});

// ---- 渲染层直接调用 -----------------------------------------------------

test('P12 renderFilmVideo 单独可渲染无声片（无音轨）', async () => {
  const doc = docOf(`<!doctype html><html><head><meta name="viewport" content="width=640, height=360"></head><body>
<section><video id="v" src="assets/src-30s.mp4#t=0,1" at="0"></video></section>
</body></html>`);
  const plan = await planFromFilm(doc, { projectRoot: workDir, fps: 30 });
  const out = path.join(workDir, 'out-silent.mp4');
  const video = await renderFilmVideo({ plan, outPath: out });
  assert.equal(video.frames, 30);
  const probe = await probeMedia(out);
  assert.ok(probe.video);
  assert.equal(probe.audio, null);
  assert.equal(probe.video.frames, 30);
});
