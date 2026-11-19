// R184：视频代理（HEVC → H.264）的纯函数/缓存契约。
//
// 只测**能离线判定的部分**：路径净化、缓存 key、支持编码放行、annotate 只认已存在的代理。
// 真转码要 ffmpeg（`ensureVideoProxy` 的 BUILT 分支）在 m81-r184 的端到端里验过，这里不重跑。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  CHROMIUM_VIDEO_CODECS,
  PROXY_DIR,
  annotateVideoProxies,
  ensureVideoProxy,
  probeVideoCodec,
  proxyRelPathFor,
  stripFragment,
  warmVideoProxies,
} from '../video-proxy.mjs';

const REPO = join(import.meta.dirname, '..', '..', '..');
const FFMPEG = join(REPO, 'resources/bin/ffmpeg');
const FFPROBE = join(REPO, 'resources/bin/ffprobe');

/** 造一个 2 帧的 H.264 素材（Chromium 能放的对照组）。 @param {string} file */
const makeH264 = (file) => {
  mkdirSync(dirname(file), { recursive: true });
  execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x204060:s=320x180:d=0.2:r=10', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file], { stdio: 'pipe' });
};

test('R184 · stripFragment 去掉 #t= 片段，URL/绝对路径不吞', () => {
  assert.equal(stripFragment('assets/a.mp4#t=0,167.5'), 'assets/a.mp4');
  assert.equal(stripFragment('assets/a.mp4'), 'assets/a.mp4');
  assert.equal(stripFragment(undefined), '');
  assert.equal(stripFragment(null), '');
});

test('R184 · 代理路径：普通目录 + 内容哈希，源不存在返回 null', async () => {
  const work = mkdtempSync(join(tmpdir(), 'r184-proxy-path-'));
  makeH264(join(work, 'assets', 'a.mp4'));
  const rel = await proxyRelPathFor(work, 'assets/a.mp4#t=0,10');
  assert.ok(rel !== null, '源存在时必须给出代理路径');
  assert.ok(rel.startsWith(`${PROXY_DIR}/`), '代理必须在 proxies/ 下（内容 origin 拒绝 .film/**）');
  assert.ok(!rel.startsWith('.'), '不能以 . 开头');
  assert.match(rel, /^proxies\/[0-9a-f]{40}\.mp4$/);

  /* 同一份源 → 同一个 key（可复用）；换字节 → 换 key */
  assert.equal(await proxyRelPathFor(work, 'assets/a.mp4'), rel);
  makeH264(join(work, 'assets', 'b.mp4'));
  assert.notEqual(await proxyRelPathFor(work, 'assets/b.mp4'), rel);

  assert.equal(await proxyRelPathFor(work, 'assets/missing.mp4'), null);
  assert.equal(await proxyRelPathFor(work, 'https://example.com/a.mp4'), null);
  assert.equal(await proxyRelPathFor(work, '/abs/a.mp4'), null);
});

test('R184 · Chromium 能放的编码直接放行（不转代理）', async () => {
  const work = mkdtempSync(join(tmpdir(), 'r184-proxy-pass-'));
  makeH264(join(work, 'assets', 'a.mp4'));
  const codec = await probeVideoCodec(join(work, 'assets', 'a.mp4'), FFPROBE);
  assert.equal(codec, 'h264');
  assert.ok(CHROMIUM_VIDEO_CODECS.includes(codec));
  const result = await ensureVideoProxy(work, 'assets/a.mp4', { ffmpegPath: FFMPEG, ffprobePath: FFPROBE });
  assert.equal(result.reason, 'SUPPORTED');
  assert.equal(result.proxy, null);
  assert.equal(existsSync(join(work, PROXY_DIR)), false, '放行时不该建 proxies/ 目录');
});

test('R184 · annotate 只给「代理文件真的在」的片段挂 proxy', async () => {
  const work = mkdtempSync(join(tmpdir(), 'r184-proxy-annotate-'));
  makeH264(join(work, 'assets', 'a.mp4'));
  /** @type {any} */
  const doc = {
    stage: { w: 1920, h: 1080 },
    tracks: [
      { id: 'v2', clips: [{ id: 'mg1', kind: 'page', src: 'mg.html#t=0,7' }] },
      { id: 'v1', clips: [{ id: 'main', kind: 'video', src: 'assets/a.mp4#t=0,10' }] },
    ],
  };

  /** @type {any} */
  const untouched = await annotateVideoProxies(work, doc);
  assert.equal(untouched.tracks[1].clips[0].proxy, undefined, '没有代理文件 → 不挂');
  assert.equal(doc.tracks[1].clips[0].proxy, undefined, '入参 doc 不许被改');

  /* 手工放一个代理（名字与 ensure 算出来的一致）→ 必须挂上 */
  const rel = await proxyRelPathFor(work, 'assets/a.mp4');
  if (rel === null) throw new Error('代理路径必须是字符串');
  mkdirSync(join(work, dirname(rel)), { recursive: true });
  writeFileSync(join(work, rel), 'stub');
  /** @type {any} */
  const annotated = await annotateVideoProxies(work, doc);
  assert.equal(annotated.tracks[1].clips[0].proxy, rel);
  assert.equal(annotated.tracks[0].clips[0].proxy, undefined, 'page 片段不该有 proxy');
  assert.equal(annotated.tracks[0].clips[0].id, 'mg1');
});

test('warmVideoProxies 记录支持的编码，跳过停用素材，不改 doc、不建目录', async () => {
  const work = mkdtempSync(join(tmpdir(), 'r184-proxy-warm-'));
  makeH264(join(work, 'assets', 'a.mp4'));
  writeFileSync(join(work, 'assets', 'corrupt.mp4'), 'not a media file');
  const doc = { tracks: [{ clips: [
    { id: 'main', kind: 'video', src: 'assets/a.mp4#t=0,10' },
    { id: 'disabled', kind: 'video', src: 'assets/corrupt.mp4#t=0,10', attrs: { 'data-opencut-disabled': '1' } },
  ] }] };
  const summary = await warmVideoProxies(work, doc, { ffmpegPath: FFMPEG, ffprobePath: FFPROBE });
  assert.deepEqual(summary.supported, ['assets/a.mp4:h264']);
  assert.deepEqual(summary.built, []);
  assert.deepEqual(summary.cached, []);
  assert.deepEqual(summary.failed, []);
  assert.equal(existsSync(join(work, PROXY_DIR)), false);
});
