// @ts-nocheck —— 全程跑假 ffmpeg（shim 脚本），不碰真编码
/**
 * P70：ffmpeg 依赖收口。
 *
 * 这一组钉的是「烧字幕到底能不能跑」这条路：
 *   1. 解析顺序固定 —— OPENCUT_FFMPEG → 工程内 bin/ffmpeg → PATH（显式路径最优先）；
 *   2. 能力探测走 `-filters`（Homebrew 8.1.2 就没有 subtitles），带缓存；
 *   3. 缺 libass 且要烧字幕 → `BURN_UNAVAILABLE`，附三条可执行建议；
 *   4. 探不到 ffmpeg 不许影响「不烧字幕」的导出。
 *
 * 全部用 shim 脚本：真 ffmpeg 的构建差异（有没有 libass）没法在本机复现两套。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  BURN_SUGGESTIONS,
  BurnUnavailableError,
  assertBurnCapable,
  checkFilters,
  clearFfmpegCaches,
  describeFfmpeg,
  ffmpegVersionLine,
  listFilters,
  resolveFfmpegPath,
} from '../ffmpeg.mjs';

const FILTERS_LIBASS = `Filters:
  T.. = Timeline support
  .S. = Slice threading
  A = Audio input/output
  V = Video input/output
 .. ass               V->V       Render ASS subtitles onto input video using the libass library.
 .. bbox              V->V       Compute bounding box of the input.
 TS subtitles         V->V       Render text subtitles onto input video using the libass library.
 .. scale             V->V       Scale the input video size.
`;

const FILTERS_PLAIN = `Filters:
  T.. = Timeline support
  .S. = Slice threading
  A = Audio input/output
  V = Video input/output
 .. bbox              V->V       Compute bounding box of the input.
 .. scale             V->V       Scale the input video size.
`;

/**
 * 写一个只会回答 `-version` / `-filters` / `-encoders` 的假 ffmpeg。
 * @param {string} dir
 * @param {string} name
 * @param {{ filters: string, version?: string }} body
 */
async function makeShim(dir, name, body) {
  const file = path.join(dir, name);
  const filtersFile = path.join(dir, `${name}.filters.txt`);
  const version = body.version ?? 'ffmpeg version 8.0-fake Copyright (c) 2000-2025 the FFmpeg developers';
  await fs.writeFile(filtersFile, body.filters, 'utf8');
  await fs.writeFile(
    file,
    `#!/bin/sh
# 真 ffmpeg 的调用是 \`ffmpeg -hide_banner -filters\`：要扫全部参数，不能只看 $1。
for arg in "$@"; do
  case "$arg" in
    -version) echo "${version}"; echo "built with clang"; exit 0 ;;
    -filters) cat "${filtersFile}"; exit 0 ;;
    -encoders) echo " V....D libx264              libx264"; echo " A....D aac                  AAC"; exit 0 ;;
  esac
done
echo "unexpected: $@" >&2
exit 1
`,
    'utf8',
  );
  await fs.chmod(file, 0o755);
  return file;
}

/** @param {string} prefix */
async function tmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('P70-D1 解析顺序：显式路径 > OPENCUT_FFMPEG > 工程 bin/ffmpeg > PATH', async () => {
  const root = await tmpDir('p70-d1-');
  const explicit = await makeShim(root, 'explicit-ffmpeg', { filters: FILTERS_LIBASS });
  const envOne = await makeShim(root, 'env-ffmpeg', { filters: FILTERS_LIBASS });
  const projectDir = path.join(root, 'project');
  await fs.mkdir(path.join(projectDir, 'bin'), { recursive: true });
  const projectOne = await makeShim(path.join(projectDir, 'bin'), 'ffmpeg', { filters: FILTERS_LIBASS });
  const pathDir = path.join(root, 'pathdir');
  await fs.mkdir(pathDir, { recursive: true });
  const pathOne = await makeShim(pathDir, 'ffmpeg', { filters: FILTERS_PLAIN });

  const env = { OPENCUT_FFMPEG: envOne, PATH: pathDir };

  assert.equal((await resolveFfmpegPath({ projectRoot: projectDir, env, explicit })).path, explicit);
  assert.equal((await resolveFfmpegPath({ projectRoot: projectDir, env, explicit })).source, 'explicit');

  const byEnv = await resolveFfmpegPath({ projectRoot: projectDir, env });
  assert.equal(byEnv.path, envOne);
  assert.equal(byEnv.source, 'env');

  const byProject = await resolveFfmpegPath({ projectRoot: projectDir, env: { PATH: pathDir } });
  assert.equal(byProject.path, projectOne);
  assert.equal(byProject.source, 'project');

  const byPath = await resolveFfmpegPath({ projectRoot: path.join(root, 'no-bin'), env: { PATH: pathDir } });
  assert.equal(byPath.path, pathOne);
  assert.equal(byPath.source, 'path');

  await fs.rm(root, { recursive: true, force: true });
});

test('P70-D2 显式/环境变量指向不存在的文件：不回退到 PATH，直接判未找到', async () => {
  const root = await tmpDir('p70-d2-');
  const pathDir = path.join(root, 'pathdir');
  await fs.mkdir(pathDir, { recursive: true });
  const pathOne = await makeShim(pathDir, 'ffmpeg', { filters: FILTERS_LIBASS });
  const missing = path.join(root, 'nope', 'ffmpeg');

  const explicit = await resolveFfmpegPath({ env: { PATH: pathDir }, explicit: missing });
  assert.equal(explicit.found, false);
  assert.equal(explicit.path, missing, '必须把写错的路径原样报出来，不能悄悄换成 PATH 里的那个');
  assert.equal(explicit.source, 'explicit');

  const fromEnv = await resolveFfmpegPath({ env: { PATH: pathDir, OPENCUT_FFMPEG: missing } });
  assert.equal(fromEnv.found, false);
  assert.equal(fromEnv.path, missing);

  const ok = await resolveFfmpegPath({ env: { PATH: pathDir } });
  assert.equal(ok.path, pathOne);

  await fs.rm(root, { recursive: true, force: true });
});

test('P70-D3 listFilters 解析表体：有 libass 的构建能列出 subtitles 与 ass', async () => {
  const root = await tmpDir('p70-d3-');
  const shim = await makeShim(root, 'ffmpeg', { filters: FILTERS_LIBASS });
  const filters = await listFilters(shim);
  assert.ok(filters.has('subtitles'));
  assert.ok(filters.has('ass'));
  assert.ok(filters.has('scale'));
  assert.equal(filters.has('T..'), false, '表头不能被当成滤镜');

  const check = await checkFilters({ ffmpegPath: shim });
  assert.equal(check.ok, true);
  assert.deepEqual(check.missing, []);

  await fs.rm(root, { recursive: true, force: true });
});

test('P70-D4 缺 libass 的构建：checkFilters 报 missing，不抛错', async () => {
  const root = await tmpDir('p70-d4-');
  const shim = await makeShim(root, 'ffmpeg', { filters: FILTERS_PLAIN });
  const check = await checkFilters({ ffmpegPath: shim, required: ['subtitles', 'ass'] });
  assert.equal(check.ok, false);
  assert.deepEqual(check.missing, ['subtitles', 'ass']);
  assert.ok(check.available.includes('scale'));

  await fs.rm(root, { recursive: true, force: true });
});

test('P70-D5 缺 libass 且要烧字幕 → BURN_UNAVAILABLE + 三条建议', async () => {
  const root = await tmpDir('p70-d5-');
  const shim = await makeShim(root, 'ffmpeg', { filters: FILTERS_PLAIN });
  await assert.rejects(assertBurnCapable({ explicit: shim }), (error) => {
    assert.ok(error instanceof BurnUnavailableError);
    assert.equal(error.code, 'BURN_UNAVAILABLE');
    assert.match(String(error.message), /^BURN_UNAVAILABLE: /);
    assert.match(String(error.message), /subtitles/);
    assert.match(String(error.message), /libass/);
    assert.equal(error.suggestions.length, 3);
    assert.deepEqual(error.suggestions, [...BURN_SUGGESTIONS]);
    assert.match(error.suggestions[0], /OPENCUT_FFMPEG/);
    assert.match(error.suggestions[2], /sidecar/);
    return true;
  });

  await fs.rm(root, { recursive: true, force: true });
});

test('P70-D6 有 libass：assertBurnCapable 放行，并带回路径/来源/版本', async () => {
  const root = await tmpDir('p70-d6-');
  const shim = await makeShim(root, 'ffmpeg', { filters: FILTERS_LIBASS, version: 'ffmpeg version 8.0-libass test build' });
  const info = await assertBurnCapable({ explicit: shim });
  assert.equal(info.ok, true);
  assert.equal(info.hasSubtitles, true);
  assert.equal(info.filters.subtitles, true);
  assert.equal(info.filters.ass, true);
  assert.equal(info.path, shim);
  assert.equal(info.source, 'explicit');
  assert.equal(info.version, 'ffmpeg version 8.0-libass test build');

  await fs.rm(root, { recursive: true, force: true });
});

test('P70-D7 -version 首行解析：跳过空行，只取第一行', async () => {
  const root = await tmpDir('p70-d7-');
  const shim = await makeShim(root, 'ffmpeg', { filters: FILTERS_LIBASS, version: 'ffmpeg version 9.9-first-line' });
  assert.equal(await ffmpegVersionLine(shim), 'ffmpeg version 9.9-first-line');
  await fs.rm(root, { recursive: true, force: true });
});

test('P70-D8 缓存：同一路径第二次不再起进程；clearFfmpegCaches 之后重新探', async () => {
  const root = await tmpDir('p70-d8-');
  const shim = await makeShim(root, 'ffmpeg', { filters: FILTERS_LIBASS });
  const first = await listFilters(shim);
  assert.ok(first.has('subtitles'));

  /* 把 shim 换成「没有 libass」的版本：没清缓存时必须还看到旧结果 */
  await fs.writeFile(path.join(root, 'ffmpeg.filters.txt'), FILTERS_PLAIN, 'utf8');
  const cached = await listFilters(shim);
  assert.ok(cached.has('subtitles'), '命中缓存时不该重新读盘');

  clearFfmpegCaches(shim);
  const fresh = await listFilters(shim);
  assert.equal(fresh.has('subtitles'), false, '清了缓存就必须重新探');

  await fs.rm(root, { recursive: true, force: true });
});

test('P70-D9 路径不存在：describeFfmpeg 不抛错，把事实记成 ok:false', async () => {
  const root = await tmpDir('p70-d9-');
  const missing = path.join(root, 'nope', 'ffmpeg');
  const info = await describeFfmpeg({ explicit: missing });
  assert.equal(info.found, false);
  assert.equal(info.ok, false);
  assert.equal(info.hasSubtitles, false);
  assert.deepEqual(info.filters, { subtitles: false, ass: false });
  assert.match(String(info.error), /not found/);
  await fs.rm(root, { recursive: true, force: true });
});

test('P70-D10 spec.json 三字段：path / version 首行 / hasSubtitles', async () => {
  const root = await tmpDir('p70-d10-');
  const projectDir = path.join(root, 'project');
  await fs.mkdir(path.join(projectDir, 'bin'), { recursive: true });
  await makeShim(path.join(projectDir, 'bin'), 'ffmpeg', { filters: FILTERS_PLAIN, version: 'ffmpeg version 8.1.2 (no libass)' });
  const info = await describeFfmpeg({ projectRoot: projectDir, env: { PATH: '' } });
  assert.equal(info.source, 'project');
  assert.equal(info.version, 'ffmpeg version 8.1.2 (no libass)');
  assert.equal(info.hasSubtitles, false);
  assert.deepEqual(info.missing, ['subtitles', 'ass']);
  /* 这三个字段就是写进 spec.json 的那份 */
  assert.deepEqual(
    { path: info.path, version: info.version, hasSubtitles: info.hasSubtitles },
    { path: path.join(projectDir, 'bin', 'ffmpeg'), version: 'ffmpeg version 8.1.2 (no libass)', hasSubtitles: false },
  );
  await fs.rm(root, { recursive: true, force: true });
});

test('P70-D11 PATH 里只有一个没有 libass 的版本：解析成功但烧字幕被拦', async () => {
  const root = await tmpDir('p70-d11-');
  const pathDir = path.join(root, 'pathdir');
  await fs.mkdir(pathDir, { recursive: true });
  const shim = await makeShim(pathDir, 'ffmpeg', { filters: FILTERS_PLAIN });
  const resolved = await resolveFfmpegPath({ env: { PATH: pathDir } });
  assert.equal(resolved.path, shim);
  assert.equal(resolved.found, true);
  await assert.rejects(assertBurnCapable({ env: { PATH: pathDir } }), (error) => {
    assert.equal(error.code, 'BURN_UNAVAILABLE');
    assert.match(String(error.message), new RegExp(shim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    return true;
  });
  await fs.rm(root, { recursive: true, force: true });
});
