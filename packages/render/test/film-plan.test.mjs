/**
 * P11 验收（A1–A9）：从 film.html 推导计划与音轨，并真跑一次混音。
 *
 * 真实 ffmpeg/ffprobe；film.html 用临时生成的项目（与计划包 synthetic-film-sample 同方言、
 * 同结构），不写 plans/，也不把素材入库。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parse } from '../../film-core/film-doc.mjs';
import { FilmPlanError, audioMixFromFilm, filmDuration, planFromFilm } from '../film-plan.mjs';
import { renderMix } from '../audio-mix.mjs';

const execFileAsync = promisify(execFile);
const ROOT = new URL('../../../', import.meta.url).pathname;
const BARS = path.join(ROOT, 'tests/fixtures/media/bars-3s-720p30.mp4');

/** @type {string} */
let workDir;

before(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-film-plan-'));
  await fs.mkdir(path.join(workDir, 'assets'), { recursive: true });

  // 8s 视频：3s 素材循环（stream copy，不重编码）
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-stream_loop', '-1', '-i', BARS, '-t', '8', '-c', 'copy', '-an',
    path.join(workDir, 'assets/test-video.mp4'),
  ]);
  // 8s 1kHz 纯音，峰值 ≈1.0（lavfi sine 默认幅度只有 ~0.088）
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=8,volume=11.317',
    '-ar', '48000', '-ac', '2',
    path.join(workDir, 'assets/test-tone.wav'),
  ]);
  await fs.writeFile(path.join(workDir, 'scene-a.html'), '<!doctype html><title>a</title>');
  await fs.writeFile(path.join(workDir, 'scene-b.html'), '<!doctype html><title>b</title>');
  /* R189：**带声音的视频**。上面那条 test-video.mp4 是 `-an` 造的（无声），改前所有用例
     都靠它，于是"视频片段自己的音轨会不会进混音"从来没被问过。这条 1kHz 纯音 + 彩条。 */
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-stream_loop', '-1', '-i', BARS, '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=8,volume=11.317',
    '-t', '8', '-c:v', 'copy', '-c:a', 'aac', '-ar', '48000', '-ac', '2',
    path.join(workDir, 'assets/test-av.mp4'),
  ]);
});

after(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

/**
 * 与计划包 synthetic-film-sample 同结构的 film.html。
 * @param {{ audio?: string, video?: string, sections?: string }} [opts]
 */
function filmHtml(opts = {}) {
  const audio = opts.audio ?? '<section><audio id="test-tone" src="assets/test-tone.wav#t=0,8" volume="0.08"></audio></section>';
  const video = opts.video ?? '<section><video id="test-footage" src="assets/test-video.mp4#t=0,8" at="0" muted></video></section>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=1280, height=720"></head><body>
<section><iframe id="card-a" src="scene-a.html#t=0,4" at="0"></iframe><iframe id="card-b" src="scene-b.html#t=0,4" at="4"></iframe></section>
${video}
${audio}
</body></html>`;
}

/**
 * @param {string} html
 * @param {string} [name]
 */
/**
 * @param {string} html
 * @param {string} [name]
 * @returns {Promise<any>}
 */
async function docOf(html, name = 'film.html') {
  const { doc, diagnostics } = parse(html, { path: name });
  assert.equal(doc === null, false, `parse failed: ${diagnostics.map((d) => d.message).join('; ')}`);
  return doc;
}

/**
 * @param {string} file
 * @param {{ channels?: number, sampleRate?: number }} [opts]
 */
async function decode(file, opts = {}) {
  const channels = opts.channels ?? 2;
  const sampleRate = opts.sampleRate ?? 48000;
  const { stdout } = await execFileAsync(
    'ffmpeg',
    ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', file, '-vn', '-ac', String(channels), '-ar', String(sampleRate), '-f', 'f32le', '-'],
    { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 },
  );
  const pcm = new Float32Array(stdout.length / 4);
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = stdout.readFloatLE(i * 4);
  return { pcm, frames: pcm.length / channels };
}

// ---- A1 -----------------------------------------------------------------

test('A1 计划样例：duration=8、3 轨、1 画面、2 网页、1 音轨（at=0/time=[0,8]/volume=0.08）', async () => {
  const doc = await docOf(filmHtml());
  const plan = await planFromFilm(doc, { projectRoot: workDir, fps: 30 });

  assert.equal(plan.duration, 8);
  assert.equal(plan.frames, 240);
  assert.equal(plan.range[0], 0);
  assert.equal(plan.range[1], 8);
  assert.equal(plan.visualClips.length, 1);
  assert.equal(plan.visualClips[0].id, 'test-footage');
  assert.equal(plan.visualClips[0].kind, 'video');
  assert.equal(plan.visualClips[0].trackIndex, 1);
  assert.equal(plan.sceneClips.length, 2);
  assert.deepEqual(plan.sceneClips.map((c) => c.id), ['card-a', 'card-b']);

  assert.ok(plan.audioMix, 'audioMix must not be null');
  assert.equal(plan.audioMix.duration, 8);
  assert.equal(plan.audioMix.sampleRate, 48000);
  assert.equal(plan.audioMix.channels, 2);
  assert.equal(plan.audioMix.clips.length, 1);
  const clip = plan.audioMix.clips[0];
  assert.equal(clip.at, 0);
  assert.deepEqual(clip.time, [0, 8]);
  assert.equal(clip.volume, 0.08);

  // 路径已解析为工程内绝对路径
  assert.ok(path.isAbsolute(clip.src));
  assert.ok(clip.src.startsWith(await fs.realpath(workDir)));
});

// ---- A2 -----------------------------------------------------------------

test('A2 真混音 8s：WAV 48k/2ch、8.000±0.001s、峰值≈0.08（±10%）、decode 0', async () => {
  const doc = await docOf(filmHtml());
  const plan = await planFromFilm(doc, { projectRoot: workDir, fps: 30 });
  const outWav = path.join(workDir, 'a2-mix.wav');
  assert.ok(plan.audioMix);
  const mixed = await renderMix(plan.audioMix, { outWav });

  const audio = await decode(mixed.path);
  assert.equal(mixed.report.sampleRate, 48000);
  assert.equal(mixed.report.channels, 2);
  const seconds = audio.frames / 48000;
  assert.ok(Math.abs(seconds - 8) <= 0.001, `duration ${seconds}`);

  let peak = 0;
  for (const value of audio.pcm) peak = Math.max(peak, Math.abs(value));
  assert.ok(Math.abs(peak - 0.08) / 0.08 <= 0.1, `peak ${peak}`);

  await assert.doesNotReject(() =>
    execFileAsync('ffmpeg', ['-v', 'error', '-i', mixed.path, '-f', 'null', '-']),
  );
});

// ---- A3 -----------------------------------------------------------------

test('A3 muted 片段 / muted 轨 → 不进 audioMix；空音轨 → null（不造静音）', async () => {
  const mutedClip = await docOf(
    filmHtml({ audio: '<section><audio id="tone" src="assets/test-tone.wav#t=0,8" volume="0.08" muted></audio></section>' }),
  );
  const planA = await planFromFilm(mutedClip, { projectRoot: workDir });
  assert.equal(planA.audioMix, null);
  assert.ok(planA.warnings.some((w) => w.includes('muted')), planA.warnings.join(' | '));

  const mutedTrack = await docOf(
    filmHtml({ audio: '<section muted><audio id="tone" src="assets/test-tone.wav#t=0,8" volume="0.08"></audio></section>' }),
  );
  const planB = await planFromFilm(mutedTrack, { projectRoot: workDir });
  assert.equal(planB.audioMix, null);

  const noAudio = await docOf(filmHtml({ audio: '' }));
  const planC = await planFromFilm(noAudio, { projectRoot: workDir });
  assert.equal(planC.audioMix, null);
  assert.ok(planC.warnings.some((w) => w.includes('no audible clips')), planC.warnings.join(' | '));
});

// ---- A4 -----------------------------------------------------------------

test('A4 speed=2 → 音频时长减半、atempo=[2]；fade=[0.5,0.5] 首尾线性下降', async () => {
  const doc = await docOf(
    filmHtml({
      video: '<section><video id="v" src="assets/test-video.mp4#t=0,8" at="0" muted></video></section>',
      audio: '<section><audio id="tone" src="assets/test-tone.wav#t=0,8" at="0" speed="2" volume="1" overrides=\'[{"fade":[0.5,0.5]}]\'></audio></section>',
    }),
  );
  const plan = await planFromFilm(doc, { projectRoot: workDir });
  assert.ok(plan.audioMix);
  const clip = plan.audioMix.clips[0];
  assert.deepEqual(clip.time, [0, 8]);
  assert.equal(clip.speed, 2);
  assert.deepEqual(clip.fade, [0.5, 0.5]);

  assert.ok(plan.audioMix);
  const mixed = await renderMix(plan.audioMix, { outWav: path.join(workDir, 'a4-mix.wav') });
  assert.deepEqual(mixed.report.clips[0].atempo.factors, [2]);
  // 片段本身 8s/2 = 4s；WAV 仍是整片 8s，后 4s 是静音
  assert.ok(Math.abs(mixed.report.clips[0].frames / 48000 - 4) <= 0.01, `clip ${mixed.report.clips[0].frames / 48000}s`);
  const audio = await decode(mixed.path);
  assert.ok(Math.abs(audio.frames / 48000 - 8) <= 0.01, `mix ${audio.frames / 48000}s`);

  /** @param {number} from @param {number} to */
  const rms = (from, to) => {
    let sum = 0;
    let n = 0;
    for (let frame = from; frame < to; frame += 1) {
      const v = audio.pcm[frame * 2] ?? 0;
      sum += v * v;
      n += 1;
    }
    return Math.sqrt(sum / n);
  };
  const start = rms(0, 240); // 5ms
  const middle = rms(Math.round(1.5 * 48000), Math.round(1.5 * 48000) + 240);
  const end = rms(Math.round(3.95 * 48000), Math.round(3.95 * 48000) + 240);
  assert.ok(start < middle * 0.2, `fade-in not applied: ${start} vs ${middle}`);
  assert.ok(end < middle * 0.2, `fade-out not applied: ${end} vs ${middle}`);
});

// ---- A5 -----------------------------------------------------------------

test('A5 #t=2,5 → time=[2,5] 只取该段；at=4 → 前 4s 静音、声从 4s 起', async () => {
  const doc = await docOf(
    filmHtml({
      video: '<section><video id="v" src="assets/test-video.mp4#t=0,8" at="0" muted></video></section>',
      audio: '<section><audio id="tone" src="assets/test-tone.wav#t=2,5" at="4" volume="1"></audio></section>',
    }),
  );
  const plan = await planFromFilm(doc, { projectRoot: workDir });
  assert.ok(plan.audioMix);
  const clip = plan.audioMix.clips[0];
  assert.deepEqual(clip.time, [2, 5]);
  assert.equal(clip.at, 4);

  assert.ok(plan.audioMix);
  const mixed = await renderMix(plan.audioMix, { outWav: path.join(workDir, 'a5-mix.wav') });
  assert.equal(mixed.report.clips[0].frames, 3 * 48000);
  const audio = await decode(mixed.path);
  assert.ok(Math.abs(audio.frames / 48000 - 8) <= 0.01, `mix ${audio.frames / 48000}s`);

  /** @param {number} from @param {number} to */
  const peak = (from, to) => {
    let max = 0;
    for (let frame = from; frame < to; frame += 1) max = Math.max(max, Math.abs(audio.pcm[frame * 2] ?? 0));
    return max;
  };
  assert.ok(peak(0, Math.round(3.9 * 48000)) < 1e-6, 'audio before at=4 must be silence');
  assert.ok(peak(Math.round(4.05 * 48000), Math.round(6.9 * 48000)) > 0.5, 'audio must start at 4s');
  assert.ok(peak(Math.round(7.05 * 48000), Math.round(7.9 * 48000)) < 1e-6, 'audio must stop at 7s');
});

// ---- A6 -----------------------------------------------------------------

test('A6 越界 → E_PATH_ESCAPE；不存在 → MEDIA_MISSING；range 越界 → INVALID_RANGE；不写盘', async () => {
  const before = (await fs.readdir(workDir)).sort();

  const escape = await docOf(
    filmHtml({ audio: '<section><audio id="tone" src="../../etc/x.wav#t=0,8"></audio></section>' }),
  );
  await assert.rejects(planFromFilm(escape, { projectRoot: workDir }), (err) => {
    assert.ok(err instanceof FilmPlanError);
    return err.code === 'E_PATH_ESCAPE';
  });

  const missing = await docOf(
    filmHtml({ audio: '<section><audio id="tone" src="assets/missing.wav#t=0,8"></audio></section>' }),
  );
  await assert.rejects(planFromFilm(missing, { projectRoot: workDir }), (err) => {
    assert.ok(err instanceof FilmPlanError);
    return err.code === 'MEDIA_MISSING';
  });

  const doc = await docOf(filmHtml());
  await assert.rejects(planFromFilm(doc, { projectRoot: workDir, range: [0, 9] }), (err) => {
    assert.ok(err instanceof FilmPlanError);
    return err.code === 'INVALID_RANGE';
  });
  await assert.rejects(
    planFromFilm(doc, { projectRoot: workDir, range: [5, 3] }),
    (/** @type {any} */ err) => err.code === 'INVALID_RANGE',
  );

  const after = (await fs.readdir(workDir)).sort();
  assert.deepEqual(after, before, 'planFromFilm must not write into the project');
});

// ---- A7 -----------------------------------------------------------------

test('A7 网页片段进 sceneClips 且标 requiresStage，不混进 visualClips', async () => {
  const doc = await docOf(filmHtml());
  const plan = await planFromFilm(doc, { projectRoot: workDir });
  assert.deepEqual(plan.sceneClips.map((c) => c.id), ['card-a', 'card-b']);
  for (const scene of plan.sceneClips) {
    assert.equal(scene.requiresStage, true);
    assert.equal(scene.unsupported, undefined, '字段名不能再写 unsupported：这些片段能导出');
    assert.equal(scene.trackIndex, 0);
  }
  assert.deepEqual(plan.visualClips.map((c) => c.id), ['test-footage']);
  assert.ok(!plan.visualClips.some((c) => c.kind === 'page'));
  // 不是静默丢弃：sceneClips 数量等于 doc 里的 iframe 数
  const pages = /** @type {any[]} */ (doc.tracks).flatMap((/** @type {any} */ t) => t.clips).filter((/** @type {any} */ c) => c.kind === 'page');
  assert.equal(plan.sceneClips.length, pages.length);
});

// ---- A8 -----------------------------------------------------------------

test('A8 同一 doc 两次计划逐字节相同（键顺序稳定）', async () => {
  const doc = await docOf(filmHtml());
  const first = await planFromFilm(doc, { projectRoot: workDir });
  const second = await planFromFilm(doc, { projectRoot: workDir });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

// ---- A10（R10 / F09）----------------------------------------------------

test('A10 音轨没有 #t= 时用源时长（ffprobe）算 span：wav / mp3 都成立，仍不覆盖 #t=', async () => {
  await fs.copyFile(path.join(ROOT, 'tests/fixtures/media/still-green-640x360.png'), path.join(workDir, 'assets/poster.png'));
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-ar', '44100', '-ac', '2', '-b:a', '128k',
    path.join(workDir, 'assets/test-tone-3s.mp3'),
  ]);

  /* wav：8s 纯音，**没有** #t= → 以前必抛 MEDIA_DURATION_UNKNOWN */
  const wavDoc = await docOf(
    filmHtml({
      video: '<section><video id="v" src="assets/test-video.mp4#t=0,8" at="0" muted></video></section>',
      audio: '<section><audio id="tone" src="assets/test-tone.wav" at="0" volume="1"></audio></section>',
    }),
  );
  const wavPlan = await planFromFilm(wavDoc, { projectRoot: workDir });
  assert.ok(wavPlan.audioMix);
  const wavClip = wavPlan.audioMix.clips[0];
  assert.equal(wavClip.time[0], 0);
  assert.ok(Math.abs(wavClip.time[1] - 8) <= 1 / 30, `wav 无 #t= 的 span 应≈8s，实得 ${wavClip.time[1]}`);

  /* mp3：3s，同样没有 #t= */
  const mp3Doc = await docOf(
    filmHtml({
      video: '<section><video id="v" src="assets/test-video.mp4#t=0,8" at="0" muted></video></section>',
      audio: '<section><audio id="tone" src="assets/test-tone-3s.mp3" at="0" volume="1"></audio></section>',
    }),
  );
  const mp3Plan = await planFromFilm(mp3Doc, { projectRoot: workDir });
  assert.ok(mp3Plan.audioMix);
  const mp3Clip = mp3Plan.audioMix.clips[0];
  assert.ok(Math.abs(mp3Clip.time[1] - 3) <= 0.1, `mp3 无 #t= 的 span 应≈3s，实得 ${mp3Clip.time[1]}`);

  /* #t= 仍然优先：给了 0,4 就按 4s，不去看源有多长 */
  const trimmed = await docOf(
    filmHtml({
      video: '<section><video id="v" src="assets/test-video.mp4#t=0,8" at="0" muted></video></section>',
      audio: '<section><audio id="tone" src="assets/test-tone.wav#t=0,4" at="0" volume="1"></audio></section>',
    }),
  );
  const trimmedPlan = await planFromFilm(trimmed, { projectRoot: workDir });
  assert.ok(trimmedPlan.audioMix);
  assert.deepEqual(trimmedPlan.audioMix.clips[0].time, [0, 4]);

  /* still 语义不变：图片没有内在时长，没有 #t= 仍然必须抛同一个错误码 */
  const stillDoc = await docOf(
    filmHtml({
      video: '<section><video id="v" src="assets/test-video.mp4#t=0,8" at="0" muted></video></section>',
      audio: '<section><img id="poster" src="assets/poster.png" at="0"></section>',
    }),
  );
  await assert.rejects(planFromFilm(stillDoc, { projectRoot: workDir }), (/** @type {any} */ err) => {
    assert.ok(err instanceof FilmPlanError);
    assert.equal(err.code, 'MEDIA_DURATION_UNKNOWN');
    return true;
  });
});

// ---- 辅助导出 -----------------------------------------------------------

test('audioMixFromFilm 只取音轨；filmDuration 与计划一致', async () => {
  const doc = await docOf(filmHtml());
  assert.equal(await filmDuration(doc, { projectRoot: workDir }), 8);
  const mix = await audioMixFromFilm(doc, { projectRoot: workDir });
  assert.ok(mix);
  assert.equal(mix.clips.length, 1);
});

// ---- R189：画面片段自带的音轨 ------------------------------------------

test('R189 带声音的 <video> 不静音 → 自己的音轨进 audioMix（没声音轨也成立）', async () => {
  const doc = await docOf(
    filmHtml({
      video: '<section><video id="av" src="assets/test-av.mp4#t=0,8" at="0"></video></section>',
      audio: '',
    }),
  );
  const plan = await planFromFilm(doc, { projectRoot: workDir, fps: 30 });
  assert.equal(plan.visualClips.length, 1, '画面仍然只有一条');
  assert.ok(plan.audioMix, 'audioMix 不能是 null —— 源里明明有 aac 音轨');
  assert.equal(plan.audioMix.clips.length, 1);
  const clip = plan.audioMix.clips[0];
  assert.equal(path.basename(clip.src), 'test-av.mp4');
  assert.deepEqual(clip.time, [0, 8]);
  assert.equal(clip.at, 0);
  assert.equal(clip.volume, 1);
  assert.deepEqual(clip.fade, [0, 0]);

  /* 真混一次：不是"计划里有条数"就算数，得能解出非静音波形 */
  const outWav = path.join(workDir, 'r189-av-mix.wav');
  await renderMix(plan.audioMix, { outWav });
  const { pcm } = await decode(outWav);
  let peak = 0;
  for (let i = 0; i < pcm.length; i += 1) peak = Math.max(peak, Math.abs(pcm[i] ?? 0));
  assert.ok(peak > 0.05, `mux 出来的波形几乎是静音（peak=${peak}）`);
});

test('R189 静音的画面片段 / 无声源 → 仍然 audioMix=null（不造空音轨）', async () => {
  /* ① 片段自己 muted（导入侧对"没有音轨的视频"就是这么写的） */
  const mutedDoc = await docOf(
    filmHtml({
      video: '<section><video id="av" src="assets/test-av.mp4#t=0,8" at="0" muted></video></section>',
      audio: '',
    }),
  );
  const mutedPlan = await planFromFilm(mutedDoc, { projectRoot: workDir });
  assert.equal(mutedPlan.audioMix, null);
  assert.ok(mutedPlan.warnings.some((w) => w.includes('muted')), mutedPlan.warnings.join(' | '));

  /* ② 轨道 muted：同一件事，旗标在轨道上 */
  const trackDoc = await docOf(
    filmHtml({
      video: '<section muted><video id="av" src="assets/test-av.mp4#t=0,8" at="0"></video></section>',
      audio: '',
    }),
  );
  assert.equal((await planFromFilm(trackDoc, { projectRoot: workDir })).audioMix, null);

  /* ③ 源本身没有音频流：不静音也不加，绝不凭空造一条静音轨 */
  const silentDoc = await docOf(
    filmHtml({
      video: '<section><video id="v" src="assets/test-video.mp4#t=0,8" at="0"></video></section>',
      audio: '',
    }),
  );
  assert.equal((await planFromFilm(silentDoc, { projectRoot: workDir })).audioMix, null);
});

test('disabled clips preserve the timeline end and contribute no picture, page capture or sound', async () => {
  const html = `<!doctype html><html><head><meta name="viewport" content="width=1280, height=720"></head><body>
<section><iframe id="disabled-page" src="missing.html#t=0,8" at="7" data-opencut-disabled="1"></iframe></section>
<section><video id="visible" src="assets/test-video.mp4#t=0,8" muted></video>
<video id="disabled-picture" src="assets/missing.mp4#t=0,8" at="12" style="filter:contrast(2)" data-opencut-disabled="1"></video></section>
<section><audio id="disabled-audio" src="assets/missing.wav" at="4" data-native="3" data-opencut-disabled="1"></audio></section></body></html>`;
  const doc = await docOf(html);
  const plan = await planFromFilm(doc, { projectRoot: workDir });
  assert.equal(plan.duration, 20);
  assert.deepEqual(plan.visualClips.map((clip) => clip.id), ['visible']);
  assert.deepEqual(plan.sceneClips, []);
  assert.equal(plan.audioMix, null);
  assert.equal(plan.requiresStage, undefined);
  assert.equal(plan.emptyPicture, undefined);

  const empty = await planFromFilm(await docOf(html.replace(/<video id="visible"[^>]*><\/video>/, '')), { projectRoot: workDir });
  assert.equal(empty.duration, 20);
  assert.equal(empty.emptyPicture, true);
  assert.deepEqual(empty.visualClips, []);
});
