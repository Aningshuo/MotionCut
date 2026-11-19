/**
 * P13 舞台取帧测试。
 *
 * 这些用例刻意都很短（fps 10 / 1 秒 / 10 帧）：舞台是**真浏览器**，每帧要等
 * media seeked + 两帧 rAF + 截图，帧一多就跑成分钟级。验收用的长片在
 * `.local-runs/.../evidence` 里单独跑，不进单元测试。
 *
 * 覆盖：
 * - A3 场景 `frame()` 同步（返回 undefined）也能出画（本批硬要求）
 * - A4 缺 `window.film` → NO_FILM；场景抛错 → FRAME_THREW；都不留半成品
 * - A5 网页片段盖在视频上：遮挡关系能从像素看出来（给坐标与颜色）
 * - A2 网页动效真的在片子里：同片段两帧有差异，且与「关掉网页」的对照帧差别明显
 * - A1（缩比）整段导出：画面/声音同长、decode 0、有音轨
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { parse as parseFilm } from '../../film-core/film-doc.mjs';
import { slotSnapshot } from '../../scene-runtime/browser-slot.mjs';
import { renderFilmExport } from '../film-export.mjs';
import { planFromFilm } from '../film-plan.mjs';
import { captureFilmFrames, resetStageLaunchCount, stageLaunchCount, startStageCapture } from '../stage-capture.mjs';
import { probeMedia } from '../verify.mjs';

const execFileAsync = promisify(execFile);

const VIDEO_RGB = [32, 64, 96]; // 0x204060，视频底色（yuv→rgb 会有几个点的误差）
const CARD_RGB = [246, 244, 237]; // #f6f4ed，网页卡片底色

/** @type {string} */
let workDir = '';

/**
 * @param {string} dir
 */
async function makeAssets(dir) {
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  // 纯色底：遮挡/层级靠颜色判定（这台机器的 ffmpeg 没编 drawtext，别用文字）
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x204060:s=640x360:r=30:d=3',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
    path.join(dir, 'assets', 'plate.mp4'),
  ]);
  // 会动的图案：验证舞台的 video 片段确实按 t 走（不是永远第 0 帧）
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=3',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
    path.join(dir, 'assets', 'moving.mp4'),
  ]);
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=3',
    '-ar', '48000', '-ac', '2',
    path.join(dir, 'assets', 'tone.wav'),
  ]);
}

/**
 * 写一个工程：网页片段在**轨道 0**（最上层），视频在轨道 1。
 * @param {string} dir
 * @param {{ scene: string, film?: string }} input
 */
async function writeProject(dir, input) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'scene.html'), input.scene, 'utf8');
  const film = input.film ?? `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=640, height=360"></head><body>
<section><iframe id="card" src="scene.html#t=0,1" at="0" style="left: 100px; top: 50px; width: 300px; height: 200px"></iframe></section>
<section><video id="plate" src="assets/plate.mp4#t=0,1" at="0" muted></video></section>
<section><audio id="tone" src="assets/tone.wav#t=0,1" volume="0.5"></audio></section>
</body></html>`;
  await fs.writeFile(path.join(dir, 'film.html'), film, 'utf8');
  await makeAssets(dir);
}

/** 同步 frame()：改一个 div 的宽度，返回 undefined（官方样例就是这种）。 */
const SYNC_SCENE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#f6f4ed}
#bar{height:80px;background:#c05050;width:10px}
</style></head><body><div id="bar"></div><script>
window.film = { duration: 1, frame: function (t) { document.getElementById('bar').style.width = (20 + t * 200) + 'px'; } };
</script></body></html>`;

/** 缺 window.film。 */
const NO_FILM_SCENE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#f6f4ed}</style></head><body><div>no film here</div></body></html>`;

/** frame() 抛错。 */
const THROWING_SCENE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#f6f4ed}</style></head><body><script>
window.film = { duration: 1, frame: function () { throw new Error('scene exploded on purpose'); } };
</script></body></html>`;

/**
 * @param {string} dir
 * @param {{ range?: [number, number], fps?: number }} [opts]
 */
async function planOf(dir, opts = {}) {
  const text = await fs.readFile(path.join(dir, 'film.html'), 'utf8');
  const { doc } = parseFilm(text, { path: 'film.html' });
  return planFromFilm(doc, {
    projectRoot: dir,
    fps: opts.fps ?? 10,
    range: opts.range ?? [0, 1],
  });
}

/**
 * PNG → rgb24 原始像素。
 * @param {string} file
 * @returns {Promise<{ width: number, height: number, data: Buffer }>}
 */
async function readRgb(file) {
  const { stdout } = await execFileAsync(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
  const { stdout: sizeOut } = await execFileAsync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0', file,
  ]);
  const [width, height] = String(sizeOut).trim().split(',').map(Number);
  return { width: /** @type {number} */ (width), height: /** @type {number} */ (height), data: stdout };
}

/**
 * @param {{ width: number, data: Buffer }} img
 * @param {number} x
 * @param {number} y
 */
function pixelAt(img, x, y) {
  const offset = (y * img.width + x) * 3;
  return [
    /** @type {number} */ (img.data[offset]),
    /** @type {number} */ (img.data[offset + 1]),
    /** @type {number} */ (img.data[offset + 2]),
  ];
}

/**
 * @param {number[]} actual
 * @param {number[]} expected
 * @param {number} tolerance
 */
function near(actual, expected, tolerance) {
  return actual.every((value, index) => Math.abs(value - /** @type {number} */ (expected[index])) <= tolerance);
}

/**
 * 指定区域的平均绝对差（0–255）。
 * @param {{ width: number, data: Buffer }} a
 * @param {{ width: number, data: Buffer }} b
 * @param {{ x: number, y: number, w: number, h: number }} rect
 */
function meanAbsDiff(a, b, rect) {
  let sum = 0;
  let count = 0;
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      const offset = (y * a.width + x) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        sum += Math.abs(
          /** @type {number} */ (a.data[offset + channel]) - /** @type {number} */ (b.data[offset + channel]),
        );
        count += 1;
      }
    }
  }
  return sum / count;
}

/** @param {string} dir */
async function listPngs(dir) {
  const files = await fs.readdir(dir).catch(() => []);
  return files.filter((name) => name.endsWith('.png')).sort();
}

test.before(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-stage-'));
});

test.after(async () => {
  if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
});

test('P13-A3 场景 frame() 同步（返回 undefined）也能出画', async () => {
  const dir = path.join(workDir, 'a3');
  await writeProject(dir, { scene: SYNC_SCENE });
  const plan = await planOf(dir);
  assert.equal(plan.sceneClips.length, 1);
  assert.equal(plan.frames, 10);

  const framesDir = path.join(dir, 'frames');
  const capture = await captureFilmFrames({ plan, projectRoot: dir, framesDir, contentPort: 0 });

  assert.equal(capture.frames, 10);
  assert.deepEqual(capture.sceneClips, [{ id: 'card', state: 'ok' }]);
  const files = await listPngs(framesDir);
  assert.equal(files.length, 10, `expected 10 frames, got ${files.length}`);

  // 同步 frame 的 boot 噪声（包之前的第一次绘制）可以存在，但包之后不能再报错
  assert.ok(capture.bootErrors.every((entry) => entry.code === 'NO_FILM'), JSON.stringify(capture.bootErrors));
  assert.deepEqual(capture.pageErrors, []);

  // 动效真的画进去了：第 0 帧和第 9 帧不一样
  const first = await readRgb(path.join(framesDir, /** @type {string} */ (files[0])));
  const last = await readRgb(path.join(framesDir, /** @type {string} */ (files[files.length - 1])));
  const diff = meanAbsDiff(first, last, { x: 100, y: 50, w: 300, h: 200 });
  assert.ok(diff > 1, `scene animation did not change the frame (${diff})`);
});

test('P13-A4 缺 window.film → NO_FILM，且不产出任何帧', async () => {
  const dir = path.join(workDir, 'a4-nofilm');
  await writeProject(dir, { scene: NO_FILM_SCENE });
  const plan = await planOf(dir);
  const framesDir = path.join(dir, 'frames');

  await assert.rejects(
    captureFilmFrames({ plan, projectRoot: dir, framesDir, contentPort: 0, filmWaitMs: 300 }),
    (/** @type {any} */ err) => {
      assert.equal(err.code, 'NO_FILM', `got ${err.code}: ${err.message}`);
      return true;
    },
  );
  assert.deepEqual(await listPngs(framesDir), []);
});

test('P13-A4 场景抛错 → FRAME_THREW，且不产出任何帧', async () => {
  const dir = path.join(workDir, 'a4-throw');
  await writeProject(dir, { scene: THROWING_SCENE });
  const plan = await planOf(dir);
  const framesDir = path.join(dir, 'frames');

  await assert.rejects(
    captureFilmFrames({ plan, projectRoot: dir, framesDir, contentPort: 0 }),
    (/** @type {any} */ err) => {
      assert.equal(err.code, 'FRAME_THREW', `got ${err.code}: ${err.message}`);
      assert.match(err.message, /scene exploded on purpose/);
      return true;
    },
  );
  assert.deepEqual(await listPngs(framesDir), []);
});

test('P13 舞台的视频片段按时间走（不是永远第 0 帧）', async (t) => {
  const dir = path.join(workDir, 'video-seek');
  await writeProject(dir, { scene: SYNC_SCENE });
  const film = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=640, height=360"></head><body>
<section><video id="moving" src="assets/moving.mp4#t=0,2" at="0" muted></video></section>
</body></html>`;
  await fs.writeFile(path.join(dir, 'film.html'), film, 'utf8');
  // 没有网页片段也要能抓（这一步只测舞台取帧本身）
  const { doc } = parseFilm(film, { path: 'film.html' });
  const plan = await planFromFilm(doc, { projectRoot: dir, fps: 10, range: [0, 2] });

  const session = await startStageCapture({ projectRoot: dir, contentPort: 0 });
  try {
    const early = path.join(dir, 'early.png');
    const late = path.join(dir, 'late.png');
    await fs.writeFile(early, await session.captureAt(0.1));
    await fs.writeFile(late, await session.captureAt(1.5));
    const a = await readRgb(early);
    const b = await readRgb(late);
    const diff = meanAbsDiff(a, b, { x: 0, y: 0, w: 640, h: 360 });
    assert.ok(diff > 10, `video frame did not advance with t (mean |diff| ${diff})`);

    await t.test('拖动提交后，新舞台首次就绪的画面与原播放头一致', async () => {
      const { page } = await session.openChannel();
      const url = new URL(session.stageUrl);
      url.searchParams.set('start', '1.5');
      await page.goto(url.href);
      await page.evaluate(() => /** @type {any} */ (window).film.ready());
      // 不再调用 frame(1.5)，否则会掩盖舞台先在零秒出画的问题。
      const resumed = path.join(dir, 'resumed.png');
      await page.screenshot({ path: resumed });
      const firstFrame = await readRgb(resumed);
      assert.equal(firstFrame.width, b.width);
      assert.equal(firstFrame.height, b.height);
      assert.ok(meanAbsDiff(firstFrame, b, { x: 0, y: 0, w: 640, h: 360 }) < 1);
    });
  } finally {
    await session.close();
  }
  void plan;
});

test('P13-A5 网页片段盖在视频上：遮挡关系能从像素看出来', async () => {
  const dir = path.join(workDir, 'a5');
  await writeProject(dir, { scene: SYNC_SCENE });
  const plan = await planOf(dir);
  const framesDir = path.join(dir, 'frames');

  const session = await startStageCapture({ projectRoot: dir, contentPort: 0 });
  try {
    const png = await session.captureAt(0.5);
    const file = path.join(dir, 'a5-frame.png');
    await fs.writeFile(file, png);
    const img = await readRgb(file);

    // 卡片 box = left 100 / top 50 / 300x200；卡内取中心，卡外取正下方
    const inside = pixelAt(img, 250, 150);
    const outside = pixelAt(img, 250, 320);
    const corner = pixelAt(img, 20, 20);
    assert.ok(near(inside, CARD_RGB, 12), `inside card should be the page colour, got ${inside}`);
    assert.ok(near(outside, VIDEO_RGB, 24), `outside card should be the video plate, got ${outside}`);
    assert.ok(near(corner, VIDEO_RGB, 24), `top-left corner should be the video plate, got ${corner}`);
    // 卡片边缘外侧也是视频：证明卡片不是铺满全屏
    const beside = pixelAt(img, 60, 150);
    assert.ok(near(beside, VIDEO_RGB, 24), `left of the card should be video, got ${beside}`);
  } finally {
    await session.close();
  }
});

test('P13-A2 网页动效真的在片子里（与关掉网页的对照帧比）', async () => {
  const dir = path.join(workDir, 'a2');
  await writeProject(dir, { scene: SYNC_SCENE });
  const plan = await planOf(dir);

  const withScenes = await captureFilmFrames({ plan, projectRoot: dir, framesDir: path.join(dir, 'f-on'), contentPort: 0 });
  const without = await captureFilmFrames({
    plan,
    projectRoot: dir,
    framesDir: path.join(dir, 'f-off'),
    contentPort: 0,
    omitScenes: true,
  });
  assert.equal(withScenes.capture.omittedScenes, false);
  assert.equal(without.capture.omittedScenes, true);

  const on = await readRgb(path.join(withScenes.dir, 'frame-000003.png'));
  const off = await readRgb(path.join(without.dir, 'frame-000003.png'));
  // 卡片区域：开网页是浅色卡片，关网页是视频底色 → 差异很大
  const cardDiff = meanAbsDiff(on, off, { x: 100, y: 50, w: 300, h: 200 });
  assert.ok(cardDiff > 40, `scenes are not visible in the output (mean |diff| ${cardDiff})`);
  // 卡片外的区域两边应该基本一致（同一帧视频）
  const outsideDiff = meanAbsDiff(on, off, { x: 0, y: 300, w: 640, h: 60 });
  assert.ok(outsideDiff < 2, `the video plate should be identical, got ${outsideDiff}`);
});

test('P13-A1（缩比）整段导出：双流同长、有音轨、decode 0', async () => {
  const dir = path.join(workDir, 'a1');
  await writeProject(dir, { scene: SYNC_SCENE });
  const plan = await planOf(dir);
  const capture = await captureFilmFrames({
    plan,
    projectRoot: dir,
    framesDir: path.join(dir, 'frames'),
    contentPort: 0,
  });

  const outPath = path.join(dir, 'out', 'scene.mp4');
  const result = await renderFilmExport({ plan, projectRoot: dir, outPath, capture });

  assert.equal(result.pictureSource, 'stage');
  assert.equal(result.frames, 10);
  const probe = await probeMedia(outPath);
  assert.ok(probe.video);
  assert.equal(probe.video.codec, 'h264');
  assert.equal(probe.video.frames, 10);
  assert.ok(Math.abs(Number(probe.video.durationSec) - 1) <= 1 / 10 + 0.001);
  assert.ok(probe.audio, 'output must carry the film audio track');
  assert.ok(Math.abs(Number(probe.audio.durationSec) - Number(probe.video.durationSec)) <= 1 / 10 + 0.001);
  assert.equal(result.decode.exitCode, 0);
});

test('P51 一次 startStageCapture 只起一个浏览器（launchCount=1），收尾把槽还回去', async () => {
  const dir = path.join(workDir, 'p51-launch');
  await writeProject(dir, { scene: SYNC_SCENE });
  const plan = await planOf(dir);

  resetStageLaunchCount();
  const capture = await captureFilmFrames({
    plan,
    projectRoot: dir,
    framesDir: path.join(dir, 'frames'),
    contentPort: 0,
  });
  // 整段取帧（10 帧、一次 session）只允许起一个 Chromium
  assert.equal(stageLaunchCount(), 1, `expected exactly 1 launch, got ${stageLaunchCount()}`);
  assert.equal(capture.frames, 10);

  /* 闸门开（runner 会设 OPENCUT_BROWSER_GATE=1）时，取帧期间占的那一个名额必须已经还回去：
     槽里不该再有任何 `stage:` 标签的持有者。闸门关时压根没有槽，这条同样成立。
     只看自己这一类：别的 worktree 可能正拿着槽，那是它的事。 */
  const after = await slotSnapshot().catch(() => []);
  const mine = after.filter((row) => String(row?.label ?? '').startsWith('stage:'));
  assert.deepEqual(mine, [], `stage slot was not released: ${JSON.stringify(mine)}`);
});
