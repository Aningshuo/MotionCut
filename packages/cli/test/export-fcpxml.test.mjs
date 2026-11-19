/**
 * P22 验收：`export fcpxml`。
 *
 * 这一层验的是"CLI 说的和写出来的一致"：
 * - 产物真的是 well-formed XML（真跑 `xmllint --noout`，不是自己说自己对）；
 * - 片段数与 plan.visualClips 一致、总时长与 plan 一致（±1 帧）——用回读，不看输出行；
 * - `film export fcpxml`（任务书写法）与 `export fcpxml` 产出的字节完全相同；
 * - 30 秒片远小于 200KB，且没有任何内嵌媒体。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { createCli } from '../index.mjs';
import { createFilmPort } from './fixtures/film-module.mjs';
import { parseFcpxml, parseRationalTime } from '../../render/fcpxml.mjs';

const execFileAsync = promisify(execFile);

/** @type {string} */
let workDir;
/** @type {string} */
let project;

before(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-cli-fcpxml-'));
  project = path.join(workDir, 'proj');
  await fs.mkdir(path.join(project, 'assets'), { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', "testsrc2=s=320x180:r=30:d=2",
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24',
    path.join(project, 'assets/clip.mp4'),
  ]);
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', "aevalsrc='0.2*sin(2*PI*440*t)':s=48000:d=2:c=stereo",
    path.join(project, 'assets/tone.wav'),
  ]);
  await fs.writeFile(
    path.join(project, 'scene-a.html'),
    '<!doctype html><html><body><div style="width:100%;height:100%;background:#246"></div></body></html>',
  );
  await fs.writeFile(
    path.join(project, 'film.html'),
    `<!doctype html><html><head><meta name="viewport" content="width=320, height=180"></head><body>
<section><iframe id="card" src="scene-a.html#t=0,2" at="0"></iframe></section>
<section><video id="take" src="assets/clip.mp4#t=0,2" at="0"></video></section>
<section><audio id="tone" src="assets/tone.wav#t=0,2" at="0" volume="0.5"></audio></section>
</body></html>`,
  );
});

after(async () => {
  if (workDir) await fs.rm(workDir, { recursive: true, force: true });
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

function makeCli() {
  return createCli({
    root: workDir,
    cwd: workDir,
    stateDir: path.join(workDir, '.state'),
    film: createFilmPort(),
    log: () => {},
  });
}

test('P22-A1：export fcpxml → xmllint exit 0', async () => {
  const out = path.join(workDir, 'film.fcpxml');
  const code = await makeCli().run(['export', 'fcpxml', project, '--out', out], {
    stdout: sink(),
    stderr: sink(),
  });
  assert.equal(code, 0);
  const { stdout } = await execFileAsync('xmllint', ['--noout', out]);
  assert.equal(stdout, '');
});

test('P22-A2/A5：回读片段数与总时长对账，文件远小于 200KB', async () => {
  const out = path.join(workDir, 'film2.fcpxml');
  const json = sink();
  const code = await makeCli().run(['export', 'fcpxml', project, '--out', out, '--json'], {
    stdout: json,
    stderr: sink(),
  });
  assert.equal(code, 0);
  const payload = JSON.parse(json.text);
  assert.equal(payload.version, '1.9');
  assert.equal(payload.clips, 1);
  assert.equal(payload.frames, 60);
  assert.equal(payload.check.problems.length, 0);

  const xml = await fs.readFile(out, 'utf8');
  const parsed = parseFcpxml(xml);
  const sequence = parsed.elements.find((el) => el.name === 'sequence');
  assert.ok(sequence);
  assert.equal(parseRationalTime(sequence.attrs.duration), 2);
  // 1 个 asset-clip（视频）+ 1 个音频 asset-clip
  const spineClips = parsed.elements.filter((el) => el.name === 'asset-clip' && el.parent === 'spine');
  assert.equal(spineClips.length, 2);
  // 网页片段 → 1 个带 note 的 gap
  const gaps = parsed.elements.filter((el) => el.name === 'gap' && (el.attrs.note ?? '') !== '');
  assert.equal(gaps.length, 1);
  assert.match(gaps[0]?.attrs.note ?? '', /no media file/);

  assert.ok(xml.length < 200 * 1024);
  assert.ok(!xml.includes('base64'));
  assert.match(xml, /<fcpxml version="1.9">/);
});

test('P22：film export fcpxml 与 export fcpxml 产出逐字节相同', async () => {
  const a = path.join(workDir, 'a.fcpxml');
  const b = path.join(workDir, 'b.fcpxml');
  assert.equal(await makeCli().run(['export', 'fcpxml', project, '--out', a], { stdout: sink(), stderr: sink() }), 0);
  // 任务书里的写法：`film export fcpxml --out x`（工程用 --project 给）
  const code = await makeCli().run(['film', 'export', 'fcpxml', '--project', project, '--out', b], {
    stdout: sink(),
    stderr: sink(),
  });
  assert.equal(code, 0);
  assert.equal(await fs.readFile(a, 'utf8'), await fs.readFile(b, 'utf8'));
});

test('P22：缺 --out → E_USAGE；--range 生效后时长按区间走', async () => {
  const code = await makeCli().run(['export', 'fcpxml', project], { stdout: sink(), stderr: sink() });
  assert.equal(code, 1);

  const out = path.join(workDir, 'range.fcpxml');
  const json = sink();
  const ok = await makeCli().run(['export', 'fcpxml', project, '--out', out, '--range', '0:1', '--json'], {
    stdout: json,
    stderr: sink(),
  });
  assert.equal(ok, 0);
  const payload = JSON.parse(json.text);
  assert.equal(payload.frames, 30);
  assert.equal(payload.durationSec, 1);
});
