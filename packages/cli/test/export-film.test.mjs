/**
 * P12 CLI 验收：`opencut export film`。
 *
 * - 没有 film 端口 → `WAIT_MAIN_FILM`（不内建第二解析器）；
 * - `--film-module` 注入真实 film-core 解析 → 真实渲染，产物可 probe；
 * - `--out` 已存在 → 自动加后缀，旧文件不变。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createCli } from '../index.mjs';
import { probeMedia } from '../../render/verify.mjs';
import { createFilmPort } from './fixtures/film-module.mjs';

const execFileAsync = promisify(execFile);
const ROOT = new URL('../../../', import.meta.url).pathname;
const FILM_MODULE = path.join(ROOT, 'packages/cli/test/fixtures/film-module.mjs');
const BIN = path.join(ROOT, 'packages/cli/bin.mjs');

/** @type {string} */
let workDir;
/** @type {string} */
let project;

before(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-cli-film-'));
  project = path.join(workDir, 'proj');
  await fs.mkdir(path.join(project, 'assets'), { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', "color=c=red:s=320x180:r=30:d=2,hue=h='t*120':s=1",
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    path.join(project, 'assets/clip.mp4'),
  ]);
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', "aevalsrc='if(between(t,0.5,0.51),0.9*sin(2*PI*1000*t),0)':s=48000:d=2:c=stereo",
    path.join(project, 'assets/tone.wav'),
  ]);
  await fs.writeFile(
    path.join(project, 'film.html'),
    `<!doctype html><html><head><meta name="viewport" content="width=320, height=180"></head><body>
<section><video id="v" src="assets/clip.mp4#t=0,2" at="0"></video></section>
<section><audio id="a" src="assets/tone.wav#t=0,2" at="0" volume="0.8"></audio></section>
</body></html>`,
  );
});

after(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

/** @returns {{ write: (chunk: string) => void, text: string }} */
function sink() {
  /** @type {string[]} */
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(chunk);
    },
    get text() {
      return chunks.join('');
    },
  };
}

/** @param {string} name */
async function sha256(name) {
  return crypto.createHash('sha256').update(await fs.readFile(name)).digest('hex');
}

test('P12 CLI：没有 film 端口 → WAIT_MAIN_FILM（exit 7）', async () => {
  const cli = createCli({ root: workDir, cwd: workDir, stateDir: path.join(workDir, '.state'), log: () => {} });
  const stdout = sink();
  const code = await cli.run(['export', 'film', project, '--out', path.join(workDir, 'no-port.mp4'), '--json'], {
    stdout,
    stderr: sink(),
  });
  assert.equal(code, 7);
  const payload = JSON.parse(stdout.text);
  assert.equal(payload.error.code, 'WAIT_MAIN_FILM');
});

test('P12 CLI：--film-module 注入 → 真实渲染，产物有音轨；重名不覆盖', async () => {
  const cli = createCli({
    film: createFilmPort(),
    root: workDir,
    cwd: workDir,
    stateDir: path.join(workDir, '.state'),
    log: () => {},
  });
  const out = path.join(workDir, 'film-out.mp4');
  const first = sink();
  const code = await cli.run(['export', 'film', project, '--out', out, '--json'], { stdout: first, stderr: sink() });
  assert.equal(code, 0, first.text);
  const payload = JSON.parse(first.text);
  assert.equal(payload.ok, true);
  assert.equal(payload.frames, 60);
  assert.equal(payload.durationSec, 2);
  assert.equal(payload.audio.clips, 1);
  assert.equal(payload.plan.sceneClips, 0);

  const probe = await probeMedia(payload.path);
  assert.ok(probe.video && probe.audio, 'output must have both streams');
  assert.equal(probe.video.frames, 60);
  assert.ok(Math.abs((probe.audio.durationSec ?? 0) - 2) <= 1 / 30 + 0.001);
  const firstSha = await sha256(payload.path);

  const second = sink();
  assert.equal(
    await cli.run(['export', 'film', project, '--out', out, '--json'], { stdout: second, stderr: sink() }),
    0,
  );
  const again = JSON.parse(second.text);
  assert.notEqual(again.path, payload.path);
  assert.ok(again.path.includes(' 2.mp4'), again.path);
  assert.equal(await sha256(payload.path), firstSha, 'existing output must not be overwritten');
});

test('P12 CLI：bin.mjs --film-module 注入可用；--range 传给计划', async () => {
  const out = path.join(workDir, 'bin-out.mp4');
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [BIN, '--root', workDir, '--film-module', FILM_MODULE, 'export', 'film', project, '--out', out, '--range', '0.5:1.5', '--json'],
    { env: { ...process.env }, timeout: 120_000 },
  );
  assert.equal(stderr.trim(), '');
  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.frames, 30);
  assert.equal(payload.durationSec, 1);
  assert.deepEqual(payload.plan.range, [0.5, 1.5]);
  assert.ok(await fs.stat(payload.path));
});

test('P12 CLI：超出片长的 --range → INVALID_RANGE（exit 2）', async () => {
  const cli = createCli({
    film: createFilmPort(),
    root: workDir,
    cwd: workDir,
    stateDir: path.join(workDir, '.state'),
    log: () => {},
  });
  const stdout = sink();
  const code = await cli.run(
    ['export', 'film', project, '--out', path.join(workDir, 'bad-range.mp4'), '--range', '0:9', '--json'],
    { stdout, stderr: sink() },
  );
  assert.equal(code, 2);
  assert.equal(JSON.parse(stdout.text).error.code, 'INVALID_RANGE');
});
