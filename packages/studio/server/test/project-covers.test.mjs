// @ts-nocheck
/**
 * M57 最近工程封面：纯函数 + 真服务端一条链。
 *
 * 纯函数守三件事：
 *  - `firstVideoAsset` 只认工程内 `assets/` 下的视频（`#t=` 片段要剥掉、外链/音频/上层跳转都要跳过）；
 *  - `coverNameFor` 同路径永远同名（重新打开只覆盖不新增）；`isCoverName` 挡住目录穿越；
 *  - `coverPath` 落在注入的 home 下。
 *
 * 集成守一件事：**打开带视频素材的工程后，索引里出现 cover，且 `/api/covers/<name>` 返回 PNG**。
 * 这条链最容易假绿——索引字段写对了但文件没生成，列表就是一片占位块。
 *
 * 跑法：`node --test packages/studio/server/test/project-covers.test.mjs`
 */

import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { startStudio } from '../studio-server.mjs';
import { coverNameFor, coverPath, coversDir, firstVideoAsset, isCoverName } from '../project-covers.mjs';
import { getJson, postJson } from './helpers.mjs';

const quietLogger = () => undefined;

test('firstVideoAsset：认 assets/ 下的视频，剥 #t= 片段', () => {
  const doc = {
    tracks: [
      { clips: [{ src: 'assets/take-a.mp4#t=0,3' }, { src: 'assets/b.webm' }] },
      { clips: [{ src: 'assets/c.mov' }] },
    ],
  };
  assert.equal(firstVideoAsset(doc), 'take-a.mp4');
});

test('firstVideoAsset：外链 / 音频 / 图片 / 上层跳转都不算', () => {
  assert.equal(firstVideoAsset({ tracks: [{ clips: [{ src: 'https://x/y.mp4' }] }] }), null);
  assert.equal(firstVideoAsset({ tracks: [{ clips: [{ src: 'assets/tone.wav' }] }] }), null);
  assert.equal(firstVideoAsset({ tracks: [{ clips: [{ src: 'assets/cover.png' }] }] }), null);
  assert.equal(firstVideoAsset({ tracks: [{ clips: [{ src: 'assets/../secret.mp4' }] }] }), null);
  assert.equal(firstVideoAsset({}), null);
});

test('firstVideoAsset：前面的空轨道不影响，跳过没有 src 的片段', () => {
  const doc = {
    tracks: [
      { clips: [{}, { src: '' }] },
      { clips: [{ src: 'assets/second.mp4' }] },
    ],
  };
  assert.equal(firstVideoAsset(doc), 'second.mp4');
});

test('coverNameFor：同路径同名、16 位十六进制、能被 isCoverName 接受', () => {
  const a = coverNameFor('/tmp/proj/one');
  const b = coverNameFor('/tmp/proj/one');
  const c = coverNameFor('/tmp/proj/two');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[a-f0-9]{16}\.png$/);
  assert.equal(isCoverName(a), true);
});

test('isCoverName：拒绝目录穿越与奇怪形状', () => {
  for (const bad of ['../a.png', 'a.png', 'ABCDEF0123456789.png', 'abcdef0123456789.png.bak', '']) {
    assert.equal(isCoverName(bad), false, bad);
  }
});

test('coverPath：落在注入的 home 下', () => {
  const name = coverNameFor('/tmp/proj/one');
  assert.equal(coverPath(name, '/tmp/home-x'), join('/tmp/home-x', '.opencut', 'covers', name));
  assert.equal(coversDir('/tmp/home-x'), join('/tmp/home-x', '.opencut', 'covers'));
});

/* ── 集成：打开 → 索引有 cover → 路由能取到 PNG ───────────────────────── */

let studio;
let home;
let projectDir;
let projectRoot;

const FILM = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>M57 封面夹具</title>
<style>html,body{margin:0;height:100%;background:#000}section{position:relative}video{position:absolute}</style>
</head><body>
<section id="v1"><video id="s-1" src="assets/a.mp4#t=0,1" at="0" style="left:0px;top:0px;width:320px;height:180px"></video></section>
</body></html>
`;

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'opencut-cover-home-'));
  projectRoot = await mkdtemp(join(tmpdir(), 'opencut-cover-proj-'));
  projectDir = join(projectRoot, 'cover-demo');
  await mkdir(join(projectDir, 'assets'), { recursive: true });
  await writeFile(join(projectDir, 'film.html'), FILM, 'utf8');
  await cp(join(import.meta.dirname, '../../../../tests/fixtures/media/insert-1s-720p30.mp4'), join(projectDir, 'assets', 'a.mp4'));

  studio = await startStudio({
    port: 0,
    vitePort: 59372,
    home,
    projectsRoot: projectRoot,
    thumbnailTimeoutMs: 200,
    logger: quietLogger,
  });
});

after(async () => {
  await studio?.close();
  await rm(home, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
});

test('打开工程后：索引出现 cover，/api/covers/<name> 返回 PNG', async () => {
  const opened = await postJson(`${studio.url}/api/projects/open`, { dir: projectDir });
  assert.equal(opened.status, 200, JSON.stringify(opened.body).slice(0, 300));

  // 封面是**异步**生成的（不挡打开响应）：轮询到出现为止，超时就说明这条链断了。
  let cover = '';
  for (let i = 0; i < 100; i += 1) {
    const listed = await getJson(`${studio.url}/api/projects`);
    cover = listed.body?.recent?.[0]?.cover ?? '';
    if (cover !== '') break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(cover, coverNameFor(await realpath(projectDir)), '索引里的 cover 应该按工程的实际路径来命名');

  const response = await fetch(`${studio.url}/api/covers/${encodeURIComponent(cover)}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  const buffer = Buffer.from(await response.arrayBuffer());
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG magic');
  // 用 IHDR 判尺寸，别用「字节数够不够大」：纯黑首帧的 PNG 只有几百字节，
  // 但尺寸对就说明 ffmpeg 真的按 320 宽抽了一帧。
  assert.equal(buffer.readUInt32BE(16), 320, '封面宽度应为 THUMB_WIDTH=320');
  assert.equal(buffer.readUInt32BE(20), 180, '320 宽对应 180 高（scale=320:-2）');
});

test('封面名非法 → 400；合法但不存在 → 404', async () => {
  const bad = await fetch(`${studio.url}/api/covers/..%2Fsettings.json`);
  assert.equal(bad.status, 400);
  const missing = await fetch(`${studio.url}/api/covers/${'0'.repeat(16)}.png`);
  assert.equal(missing.status, 404);
  const body = await missing.json();
  assert.equal(body.code, 'COVER_NOT_FOUND');
});
