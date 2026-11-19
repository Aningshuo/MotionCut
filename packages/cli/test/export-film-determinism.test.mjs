/**
 * P14-A1：同一工程、同一 `--range`，**两个全新进程**导出必须可复现。
 *
 * 比对四样东西：
 * 1. `--plan-out` 写出的计划 JSON（逐字节）
 * 2. 帧数
 * 3. 首/中/末帧 PNG 的 sha256（从成片里解出来，等于比对编码后的画面）
 * 4. 视频码流哈希（`-c copy -f md5`）
 *
 * 整文件 sha 通常**不同**：MP4 的 `mvhd/tkhd` 里带创建/修改时间。这条差异在
 * 证据里单独解释，不混进「可复现」的判据里。
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = new URL('../../../', import.meta.url).pathname;
const BIN = path.join(ROOT, 'packages/cli/bin.mjs');
const FILM_MODULE = path.join(ROOT, 'packages/cli/test/fixtures/film-module.mjs');

/** @type {string} */
let workDir = '';

/**
 * 1 秒 / 10fps / 10 帧的小工程：场景会随 t 改变宽度（同步 frame），
 * 视频是纯色底板，音轨是 1kHz。
 * @param {string} dir
 */
async function makeProject(dir) {
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x204060:s=320x180:r=30:d=1',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    path.join(dir, 'assets', 'plate.mp4'),
  ]);
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=1',
    '-ar', '48000', '-ac', '2',
    path.join(dir, 'assets', 'tone.wav'),
  ]);
  await fs.writeFile(
    path.join(dir, 'scene.html'),
    `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#f6f4ed}#bar{height:60px;background:#c05050;width:10px}
</style></head><body><div id="bar"></div><script>
window.film = { duration: 1, frame: function (t) { document.getElementById('bar').style.width = (20 + t * 200) + 'px'; } };
</script></body></html>`,
    'utf8',
  );
  await fs.writeFile(
    path.join(dir, 'film.html'),
    `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=320, height=180"></head><body>
<section><iframe id="card" src="scene.html#t=0,1" at="0" style="left: 40px; top: 20px; width: 200px; height: 120px"></iframe></section>
<section><video id="plate" src="assets/plate.mp4#t=0,1" at="0" muted></video></section>
<section><audio id="tone" src="assets/tone.wav#t=0,1" volume="0.5"></audio></section>
</body></html>`,
    'utf8',
  );
}

/**
 * @param {string} root
 * @param {string} project
 * @param {string} tag
 */
async function runExport(root, project, tag) {
  const out = path.join(root, `${tag}.mp4`);
  const planOut = path.join(root, `${tag}.plan.json`);
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    BIN,
    '--root', root,
    'export', 'film', project,
    '--film-module', FILM_MODULE,
    '--out', out,
    '--plan-out', planOut,
    '--range', '0:1',
    '--fps', '10',
    '--json',
  ], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 });
  void stderr;
  return { out, planOut, result: JSON.parse(stdout) };
}

/**
 * @param {string} file
 */
async function sha256OfFile(file) {
  const buffer = await fs.readFile(file);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * 解出第 n 帧 PNG，返回 sha256。
 * @param {string} video
 * @param {number} index
 * @param {string} outFile
 */
async function framePngSha(video, index, outFile) {
  await execFileAsync('ffmpeg', [
    '-y', '-v', 'error',
    '-i', video,
    '-vf', `select='eq(n\\,${index})'`,
    '-vsync', '0', '-frames:v', '1',
    outFile,
  ]);
  return sha256OfFile(outFile);
}

/**
 * 视频码流哈希（不含容器）。
 * @param {string} video
 */
async function streamHash(video) {
  const { stdout } = await execFileAsync('ffmpeg', [
    '-v', 'error', '-i', video, '-map', '0:v:0', '-c', 'copy', '-f', 'md5', '-',
  ]);
  return stdout.trim();
}

test.before(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-det-'));
});

test.after(async () => {
  if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
});

test('P14-A1 两个全新进程：计划字节一致、帧数一致、三帧 PNG 一致', async () => {
  const root = path.join(workDir, 'det');
  const project = path.join(root, 'project');
  await makeProject(project);

  const first = await runExport(root, project, 'run1');
  const second = await runExport(root, project, 'run2');

  // 1) 计划 JSON 逐字节一致
  const planA = await fs.readFile(first.planOut);
  const planB = await fs.readFile(second.planOut);
  assert.ok(planA.length > 0);
  assert.equal(crypto.createHash('sha256').update(planA).digest('hex'), crypto.createHash('sha256').update(planB).digest('hex'));
  const plan = JSON.parse(planA.toString('utf8'));
  assert.equal(plan.frames, 10);
  assert.equal(plan.sceneClips.length, 1);

  // 2) 帧数一致
  assert.equal(first.result.frames, second.result.frames);
  assert.equal(first.result.frames, 10);

  // 3) 首/中/末帧 PNG 的 sha256 一致
  const hashA = [];
  const hashB = [];
  for (const [index, label] of [[0, 'first'], [4, 'mid'], [9, 'last']]) {
    hashA.push(await framePngSha(first.out, /** @type {number} */ (index), path.join(root, `a-${label}.png`)));
    hashB.push(await framePngSha(second.out, /** @type {number} */ (index), path.join(root, `b-${label}.png`)));
  }
  assert.deepEqual(hashA, hashB, `frame pngs differ:\n  A=${hashA.join(',')}\n  B=${hashB.join(',')}`);
  // 三帧互不相同（确实在放，不是同一张图重复）
  assert.equal(new Set(hashA).size, 3);

  // 4) 视频码流一致
  assert.equal(await streamHash(first.out), await streamHash(second.out));

  // 整文件 sha：允许不同，但差在哪要说得清（容器时间戳）
  const wholeA = await sha256OfFile(first.out);
  const wholeB = await sha256OfFile(second.out);
  if (wholeA !== wholeB) {
    const a = await fs.readFile(first.out);
    const b = await fs.readFile(second.out);
    assert.equal(a.length, b.length, 'same bitstream should produce the same file size');
    let offset = -1;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) {
        offset = i;
        break;
      }
    }
    assert.ok(offset >= 0 && offset < 64, `unexpected diff offset ${offset} (should be inside the mvhd header)`);
  }
});
