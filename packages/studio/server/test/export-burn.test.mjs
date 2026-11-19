/**
 * 烧字幕纯函数单测（M41 · B-MAIN-R21-021）
 *
 * 不跑 ffmpeg：只验「路径命名 / 入队前可行性 / ASS+VTT 文本」这三段。
 * 真渲染在 `scripts/m41-subtitle-burn.mjs`（真 Studio + 真 ffmpeg）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildAssDocument } from '../../../render/subtitles.mjs';
import {
  burnBaseOf,
  buildBurnBundle,
  checkBurnFeasible,
  threePiecePaths,
  writeBurnFiles,
} from '../export-burn.mjs';
import { SUBTITLE_STYLE_DEFAULTS } from '../../../layers/subtitle-style.mjs';

/** @param {string} prefix */
async function makeProject(prefix = 'opencut-burn-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  return { projectId: 'p', dir };
}

/** @param {string} dir @param {string} rel @param {string} text */
async function write(dir, rel, text) {
  const file = path.join(dir, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
  return file;
}

const VTT = `WEBVTT

00:00:00.500 --> 00:00:02.000
第一句

00:00:02.200 --> 00:00:03.000
第二句
`;

/**
 * 一条 3 秒、从 1.0s 起播的片段（源时间 0 → 成片 1.0）。
 * `visualClips[].src` 在真计划里是**解析后的绝对 realpath**，这里必须一致。
 * @param {string} src
 */
function makePlan(src = 'assets/a.mp4') {
  return {
    fps: 30,
    outputDuration: 4,
    stage: { w: 1280, h: 720 },
    visualClips: [{ id: 'v1', kind: 'video', src, time: [0, 3], at: 1, speed: 1, duration: 3 }],
  };
}

/** 工程里那条素材的 realpath（buildBurnBundle 会把 subtitleSrc 解析成它）。 */
/**
 * @param {{ dir: string }} project
 * @param {string} rel
 */
async function mediaSrcOf(project, rel) {
  return fs.realpath(path.join(project.dir, rel));
}

test('三件套命名：去扩展名 + -master/-subbed/.vtt', () => {
  assert.equal(burnBaseOf('/x/film-20261108-131500.mp4'), '/x/film-20261108-131500');
  assert.equal(burnBaseOf('/x/film.mp4'), '/x/film');
  assert.deepEqual(threePiecePaths('/x/film'), {
    base: '/x/film',
    master: '/x/film-master.mp4',
    subbed: '/x/film-subbed.mp4',
    vtt: '/x/film.vtt',
  });
  // 不烧录时路径一个字都不改（调用方根本不走这里）
  assert.equal(burnBaseOf('/x/weird.name'), '/x/weird.name');
});

test('A5/A6 可行性：src 越界/不存在、无伴生、空字幕（多段不再拒绝）', async () => {
  const project = await makeProject();
  await write(project.dir, 'assets/a.mp4', 'not really a video');
  await write(project.dir, 'assets/a.vtt', VTT);

  // M44：多段 + 烧录是正常请求——P40 的映射层按「计划层切好的窗口」拆条，
  // studio 不再用 SUBTITLE_BURN_MULTI_RANGE 挡（挡住的是已经能跑的能力）。
  const multi = await checkBurnFeasible(
    { project, subtitleSrc: 'assets/a.mp4', ranges: [[0, 1], [2, 3]] },
    { probe: async () => ({ ok: true, detail: 'fake libass', version: 'test' }) },
  );
  assert.equal(multi.ok, true);
  assert.equal(multi.cues.length, 2);
  assert.equal('code' in multi, false);

  const escape = await checkBurnFeasible({ project, subtitleSrc: '../a.mp4' });
  assert.equal(escape.ok, false);
  assert.equal(escape.code, 'SUBTITLE_SRC_INVALID');

  const missing = await checkBurnFeasible({ project, subtitleSrc: 'assets/nope.mp4' });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'SUBTITLE_SRC_INVALID');

  const bare = await checkBurnFeasible({ project, subtitleSrc: 'assets/only.mp4' });
  assert.equal(bare.ok, false);
  assert.equal(bare.code, 'SUBTITLE_SRC_INVALID');

  await write(project.dir, 'assets/b.mp4', 'x');
  const noSidecar = await checkBurnFeasible({ project, subtitleSrc: 'assets/b.mp4' });
  assert.equal(noSidecar.ok, false);
  assert.equal(noSidecar.code, 'SUBTITLE_EMPTY');
  assert.match(noSidecar.message, /b\.vtt/);

  await write(project.dir, 'assets/c.mp4', 'x');
  await write(project.dir, 'assets/c.vtt', 'WEBVTT\n\n');
  const empty = await checkBurnFeasible({ project, subtitleSrc: 'assets/c.mp4' });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'SUBTITLE_EMPTY');

  const ok = await checkBurnFeasible(
    { project, subtitleSrc: 'assets/a.mp4' },
    { probe: async () => ({ ok: true, detail: 'fake libass', version: 'test' }) },
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.cues.length, 2);
  assert.equal(ok.file, 'assets/a.vtt');
});

test('能力探测放在文件检查之后：没 libass → SUBTITLE_BURN_UNAVAILABLE', async () => {
  const project = await makeProject();
  await write(project.dir, 'assets/a.mp4', 'x');
  await write(project.dir, 'assets/a.vtt', VTT);
  const probe = async () => ({ ok: false, detail: "ffmpeg has no 'subtitles' filter (built without libass)", version: '8.1.2' });
  const unavailable = await checkBurnFeasible({ project, subtitleSrc: 'assets/a.mp4' }, { probe });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.code, 'SUBTITLE_BURN_UNAVAILABLE');
  assert.match(unavailable.message, /libass/);
});

test('ASS/VTT：cue 映射到成片时间，样式来自工程文件（默认 = 默认样式）', async () => {
  const project = await makeProject();
  await write(project.dir, 'assets/a.mp4', 'x');
  const bundle = await buildBurnBundle({
    projectDir: project.dir,
    src: 'assets/a.mp4',
    file: 'assets/a.vtt',
    cues: [
      { start: 0.5, end: 2, text: '第一句' },
      { start: 2.2, end: 3, text: '第二句' },
    ],
    plan: makePlan(await mediaSrcOf(project, 'assets/a.mp4')),
    size: { w: 1280, h: 720 },
  });
  assert.equal(bundle.ok, true);
  assert.equal(bundle.styleExists, false);
  // 片段 at=1：源 0.5 → 成片 1.5；源 2.2 → 成片 3.2（都在窗口内）
  assert.equal(bundle.cues.length, 2);
  assert.equal(bundle.cues[0].startSec, 1.5);
  assert.equal(bundle.cues[1].startSec, 3.2);

  // ASS 与 buildAssDocument 直接调用**逐字节**相同：说明 studio 没自己算样式
  const direct = buildAssDocument({
    cues: bundle.cues,
    size: { w: 1280, h: 720 },
    subtitleStyle: { ...SUBTITLE_STYLE_DEFAULTS },
    generator: 'studio/export-burn.mjs',
  });
  assert.equal(bundle.assText, direct);
  const styleLine = bundle.assText.split('\n').find((line) => line.startsWith('Style: Default,'));
  assert.ok(styleLine !== undefined);
  assert.match(bundle.assText, /PlayResX: 1280/);
  assert.match(bundle.assText, /PlayResY: 720/);

  assert.match(bundle.vttText, /^WEBVTT\n\n/);
  assert.match(bundle.vttText, /00:00:01\.500 --> 00:00:03\.000/);
  assert.match(bundle.vttText, /00:00:03\.200 --> 00:00:04\.000/);
  assert.ok(bundle.vttText.endsWith('\n'));
});

test('样式文件生效：fontSizeRatio 0.06 会改 ASS 字号（studio 不参与换算）', async () => {
  const project = await makeProject();
  await write(project.dir, 'assets/a.mp4', 'x');
  await write(
    project.dir,
    '.film/subtitle-style.json',
    `${JSON.stringify({ version: '1.0.0', style: { fontSizeRatio: 0.06, color: '#ffcc00' }, updatedAt: '2026-11-08T00:00:00.000Z' }, null, 2)}\n`,
  );
  const bundle = await buildBurnBundle({
    projectDir: project.dir,
    src: 'assets/a.mp4',
    cues: [{ start: 0.5, end: 1.5, text: '样式' }],
    plan: makePlan(await mediaSrcOf(project, 'assets/a.mp4')),
    size: { w: 1280, h: 720 },
  });
  assert.equal(bundle.ok, true);
  assert.equal(bundle.styleExists, true);
  assert.equal(bundle.style.fontSizeRatio, 0.06);
  const expected = buildAssDocument({
    cues: bundle.cues,
    size: { w: 1280, h: 720 },
    subtitleStyle: bundle.style,
    generator: 'studio/export-burn.mjs',
  });
  assert.equal(bundle.assText, expected);
  // 720 × 6% = 43.2 → 43（ASS 取整）
  assert.match(bundle.assText, /Style: Default,[^,]+,[^,]+,&H0000CCFF,/);
});

test('多段（M44）：两段拼接 → 跨切点拆成相邻两条、落间隙的整条丢弃', async () => {
  const project = await makeProject();
  await write(project.dir, 'assets/a.mp4', 'x');
  const src = await mediaSrcOf(project, 'assets/a.mp4');
  /** 两段：源 2–4 放成片 0–2、源 6–8 放成片 2–4（P40 的 plan 形状）。 */
  const plan = {
    fps: 30,
    outputDuration: 4,
    stage: { w: 1280, h: 720 },
    visualClips: [
      { id: 'v1', kind: 'video', src, time: [2, 4], at: 0, speed: 1, duration: 2 },
      { id: 'v2', kind: 'video', src, time: [6, 8], at: 2, speed: 1, duration: 2 },
    ],
  };
  const bundle = await buildBurnBundle({
    projectDir: project.dir,
    src: 'assets/a.mp4',
    cues: [
      { start: 2.5, end: 3.5, text: '第一条 正常' },
      { start: 3.5, end: 6.5, text: '第二条 跨两个切点' },
      { start: 4.5, end: 5.5, text: '第三条 全在间隙' },
      { start: 6.5, end: 7.5, text: '第四条 最后' },
    ],
    plan,
    size: { w: 1280, h: 720 },
  });
  assert.equal(bundle.ok, true);
  assert.deepEqual(
    bundle.cues.map((cue) => [cue.startSec, cue.endSec, cue.text]),
    [
      [0.5, 1.5, '第一条 正常'],
      [1.5, 2, '第二条 跨两个切点'],
      [2, 2.5, '第二条 跨两个切点'],
      [2.5, 3.5, '第四条 最后'],
    ],
  );
  // VTT 是**成片时间**的规范版，±1ms：两条相邻段首尾相接，不重叠也不留缝。
  assert.match(bundle.vttText, /00:00:00\.500 --> 00:00:01\.500/);
  assert.match(bundle.vttText, /00:00:01\.500 --> 00:00:02\.000/);
  assert.match(bundle.vttText, /00:00:02\.000 --> 00:00:02\.500/);
  assert.match(bundle.vttText, /00:00:02\.500 --> 00:00:03\.500/);
  assert.equal(bundle.vttText.includes('第三条'), false, '落间隙的 cue 一条都不许出');
  // ASS 的 Dialogue 行与 VTT 一一对应（4 条，时间同源）。
  const dialogues = bundle.assText.split('\n').filter((line) => line.startsWith('Dialogue:'));
  assert.equal(dialogues.length, 4);
  assert.match(dialogues[0] ?? '', /^Dialogue: 0,0:00:00\.50,0:00:01\.50,/);
  assert.match(dialogues[3] ?? '', /^Dialogue: 0,0:00:02\.50,0:00:03\.50,/);
  assert.equal(dialogues.some((line) => line.includes('第三条')), false);
  // 再算一次必须逐字节相同（同一份输入 → 同一份 ASS/VTT）。
  const again = await buildBurnBundle({
    projectDir: project.dir,
    src: 'assets/a.mp4',
    cues: [
      { start: 2.5, end: 3.5, text: '第一条 正常' },
      { start: 3.5, end: 6.5, text: '第二条 跨两个切点' },
      { start: 4.5, end: 5.5, text: '第三条 全在间隙' },
      { start: 6.5, end: 7.5, text: '第四条 最后' },
    ],
    plan,
    size: { w: 1280, h: 720 },
  });
  if (again.ok !== true) throw new Error(`第二次计算失败：${again.code}`);
  assert.equal(again.assText, bundle.assText);
  assert.equal(again.vttText, bundle.vttText);
});

test('字幕全在窗口外 → SUBTITLE_EMPTY（不产空字幕的片子）', async () => {
  const project = await makeProject();
  await write(project.dir, 'assets/a.mp4', 'x');
  const bundle = await buildBurnBundle({
    projectDir: project.dir,
    src: 'assets/a.mp4',
    cues: [{ start: 100, end: 101, text: '窗口外' }],
    plan: makePlan(await mediaSrcOf(project, 'assets/a.mp4')),
    size: { w: 1280, h: 720 },
  });
  assert.equal(bundle.ok, false);
  assert.equal(bundle.code, 'SUBTITLE_EMPTY');
});

test('writeBurnFiles 落盘 UTF-8/LF，内容与内存一致', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-burnio-'));
  const assPath = path.join(dir, 'a.ass');
  const vttPath = path.join(dir, 'a.vtt');
  const written = await writeBurnFiles({ assPath, vttPath, assText: '[Script Info]\n', vttText: 'WEBVTT\n\n' });
  assert.equal(written.ok, true);
  assert.equal(await fs.readFile(assPath, 'utf8'), '[Script Info]\n');
  const vtt = await fs.readFile(vttPath, 'utf8');
  assert.equal(vtt, 'WEBVTT\n\n');
  assert.equal(vtt.includes('\r'), false);
});
