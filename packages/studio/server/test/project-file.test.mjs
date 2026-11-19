// @ts-nocheck —— 以 node --test 的运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * 工程内文件只读出口（M34 · B-MAIN-R17-017）的单测。
 *
 * 这条路由是给时间线波形用的（Studio 页面 `fetch` 音频 → decodeAudioData）：
 * 内容 origin 有意不发 CORS 头，所以必须有一条**同源**的只读通道。
 * 这里锁两件事：路径守卫（不能越界）与真能取到字节（含 content-type）。
 */

import assert from 'node:assert/strict';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { checkRelPath, contentTypeOf, isInside } from '../project-file.mjs';
import { startStudio } from '../studio-server.mjs';
import { makeProject } from './helpers.mjs';

const quietLogger = () => undefined;

test('M34-1 checkRelPath：正常相对路径放行', () => {
  for (const rel of ['film.html', 'assets/tone.wav', 'scenes/a-b/c.html', 'a.b/c.mp4']) {
    const checked = checkRelPath(rel);
    assert.equal(checked.ok, true, rel);
    assert.equal(checked.rel, rel);
  }
});

test('M34-2 checkRelPath：越界与隐藏目录一律拒', () => {
  const cases = [
    ['', 'INVALID_PATH'],
    ['/etc/passwd', 'INVALID_PATH'],
    ['assets\\tone.wav', 'INVALID_PATH'],
    ['assets/\u0000x', 'INVALID_PATH'],
    ['../secret', 'E_PATH_ESCAPE'],
    ['assets/../../etc/passwd', 'E_PATH_ESCAPE'],
    ['./film.html', 'E_PATH_ESCAPE'],
    ['.film/state.json', 'E_PATH_ESCAPE'],
    ['node_modules/x.js', 'E_PATH_ESCAPE'],
    ['assets//tone.wav', 'INVALID_PATH'],
    [null, 'INVALID_PATH'],
  ];
  for (const [rel, code] of cases) {
    const checked = checkRelPath(rel);
    assert.equal(checked.ok, false, String(rel));
    assert.equal(checked.code, code, String(rel));
  }
});

test('M34-3 contentTypeOf / isInside', () => {
  assert.equal(contentTypeOf('assets/tone.wav'), 'audio/wav');
  assert.equal(contentTypeOf('assets/a.MP4'), 'video/mp4');
  assert.equal(contentTypeOf('assets/a.mp3'), 'audio/mpeg');
  assert.equal(contentTypeOf('film.html'), 'text/html; charset=utf-8');
  assert.equal(contentTypeOf('assets/weird.xyz'), 'application/octet-stream');
  assert.equal(contentTypeOf('noext'), 'application/octet-stream');

  assert.equal(isInside('/a/b', '/a/b'), true);
  assert.equal(isInside('/a/b', '/a/b/c/d.wav'), true);
  // 前缀相同的兄弟目录不算在里头（这条最容易写错）
  assert.equal(isInside('/a/b', '/a/bc/d.wav'), false);
  assert.equal(isInside('/a/b', '/a/x'), false);
});

/** @type {any} */
let project = null;
/** @type {any} */
let studio = null;
/** @type {string} */
let outsideFile = '';

before(async () => {
  project = await makeProject('project-file');
  await mkdir(join(project.dir, 'assets'), { recursive: true });
  await writeFile(join(project.dir, 'assets', 'tone.wav'), Buffer.from('RIFF0000WAVEfmt fake-bytes'));
  // 工程外的一个文件 + 指向它的符号链接（realpath 之后必须被拒）
  const outsideDir = join(project.root, 'outside');
  await mkdir(outsideDir, { recursive: true });
  outsideFile = join(outsideDir, 'secret.txt');
  await writeFile(outsideFile, 'TOP SECRET');
  await symlink(outsideFile, join(project.dir, 'assets', 'link.txt'));

  studio = await startStudio({ port: 0, vitePort: 0, projectsRoot: project.root, logger: quietLogger });
  const opened = await fetch(`${studio.url}/api/projects/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dir: project.dir }),
  }).then((response) => response.json());
  project.id = opened.project.projectId;
});

after(async () => {
  if (studio !== null) await studio.close();
  if (project !== null) {
    await rm(project.root, { recursive: true, force: true });
    await rm(join(tmpdir(), 'opencut-project-file-outside'), { recursive: true, force: true });
  }
});

const fileUrl = (rel) => `${studio.url}/api/projects/${encodeURIComponent(project.id)}/file?path=${encodeURIComponent(rel)}`;

test('M34-4 GET /file：取到字节、content-type 对、no-store', async () => {
  const film = await fetch(fileUrl('film.html'));
  assert.equal(film.status, 200);
  assert.equal(film.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(film.headers.get('cache-control'), 'no-store');
  assert.equal(film.headers.get('x-content-type-options'), 'nosniff');
  const text = await film.text();
  assert.equal(text.includes('<html'), true);

  const wav = await fetch(fileUrl('assets/tone.wav'));
  assert.equal(wav.status, 200);
  assert.equal(wav.headers.get('content-type'), 'audio/wav');
  const bytes = Buffer.from(await wav.arrayBuffer());
  assert.equal(bytes.toString('utf8'), 'RIFF0000WAVEfmt fake-bytes');
  assert.equal(wav.headers.get('content-length'), String(bytes.length));

  const head = await fetch(fileUrl('assets/tone.wav'), { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(bytes.length));
});

test('M34-5 GET /file：越界一律拒，不泄露内容', async () => {
  const escape = await fetch(fileUrl('../outside/secret.txt'));
  assert.equal(escape.status, 400);
  assert.equal((await escape.json()).code, 'E_PATH_ESCAPE');

  const absolute = await fetch(fileUrl('/etc/hosts'));
  assert.equal(absolute.status, 400);

  const dotDir = await fetch(fileUrl('.film/state.json'));
  assert.equal(dotDir.status, 400);
  assert.equal((await dotDir.json()).code, 'E_PATH_ESCAPE');

  // 符号链接：字面路径在工程内，realpath 之后在工程外
  const linked = await fetch(fileUrl('assets/link.txt'));
  assert.equal(linked.status, 403);
  const body = await linked.json();
  assert.equal(body.code, 'E_PATH_ESCAPE');
  assert.equal(JSON.stringify(body).includes('TOP SECRET'), false);
});

test('M34-6 GET /file：文件不存在是 404，不是 500', async () => {
  const missing = await fetch(fileUrl('assets/nope.wav'));
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, 'FILE_NOT_FOUND');
});

test('M34-7 GET /file：工程没打开是 404 FILM_NOT_FOUND', async () => {
  const response = await fetch(`${studio.url}/api/projects/not-open/file?path=film.html`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, 'FILM_NOT_FOUND');
});
