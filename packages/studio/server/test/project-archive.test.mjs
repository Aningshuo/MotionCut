// @ts-nocheck
/**
 * M58 工程打包/导入：zip 读写器 + 导入语义。
 *
 * 这里守的都不是「跑通就行」：
 *  - `crc32` 用标准测试向量（`123456789` → `cbf43926`），不是自己跟自己对；
 *  - 往返：打包 → 读回 → 解到新目录，**逐文件 sha256 相等**；`.film/history/**` 不进包；
 *  - 恶意包：`../evil` 这种条目**整包拒绝**（不是「能写的就写」）；
 *  - 清单不一致：少文件要逐条报 `mismatch`，不能默默成功；
 *  - 没有 manifest 的普通 zip → `ARCHIVE_NO_MANIFEST`。
 *
 * 跑法：`node --test packages/studio/server/test/project-archive.test.mjs`
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { deflateRawSync } from 'node:zlib';

import {
  ARCHIVE_VERSION,
  crc32,
  extractProjectArchive,
  isSafeEntryName,
  readProjectArchive,
  writeProjectArchive,
} from '../project-archive.mjs';

let base;
let source;

/** 手搓一个 zip（store/deflate 都可），用来造「本产品不会产出」的包。 */
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const method = entry.deflate === true ? 8 : 0;
    const body = method === 8 ? deflateRawSync(data) : data;
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    locals.push(header, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, eocd]);
}

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'opencut-archive-'));
  source = join(base, 'src');
  await mkdir(join(source, 'assets'), { recursive: true });
  await mkdir(join(source, '.film', 'history', 'snapshots'), { recursive: true });
  await writeFile(join(source, 'film.html'), '<!doctype html><html><body><section id="v1"></section></body></html>');
  await writeFile(join(source, 'assets', 'a.bin'), Buffer.alloc(4096, 9));
  await writeFile(join(source, '.film', 'subtitle-style.json'), '{"lineHeight":1.25}\n');
  await writeFile(join(source, '.film', 'history', 'snapshots', 's1.json'), '{"should":"not be packed"}\n');
});

after(async () => {
  await rm(base, { recursive: true, force: true });
});

test('crc32：标准测试向量', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('isSafeEntryName：挡绝对路径 / 反斜杠 / 上层跳转', () => {
  assert.equal(isSafeEntryName('film.html'), true);
  assert.equal(isSafeEntryName('assets/a.mp4'), true);
  for (const bad of ['/etc/passwd', '../a', 'a/../../b', 'a\\b', 'C:/x', 'a//b', './a', '']) {
    assert.equal(isSafeEntryName(bad), false, bad);
  }
});

test('打包 → 读回：清单 3 个文件，history 不进包', async () => {
  const out = join(base, 'one.zip');
  const written = await writeProjectArchive(source, out, { name: '演示工程' });
  assert.equal(written.ok, true);
  assert.deepEqual(
    written.manifest.files.map((item) => item.path),
    ['.film/subtitle-style.json', 'assets/a.bin', 'film.html'],
  );
  assert.equal(written.manifest.name, '演示工程');
  assert.equal(written.manifest.version, ARCHIVE_VERSION);

  const read = await readProjectArchive(out);
  assert.equal(read.ok, true);
  assert.equal(read.entries.length, 4, '3 个文件 + manifest.json');
  assert.equal(read.manifest.files.some((item) => item.path.includes('history')), false);
});

test('解包 → 逐文件 sha256 与源一致，mismatch 为空', async () => {
  const out = join(base, 'two.zip');
  await writeProjectArchive(source, out, { name: 'x' });
  const target = join(base, 'restored');
  const extracted = await extractProjectArchive(out, target);
  assert.equal(extracted.ok, true);
  assert.equal(extracted.files, 3);
  assert.deepEqual(extracted.mismatch, []);
  assert.deepEqual(extracted.extra, []);

  const film = await readFile(join(target, 'film.html'), 'utf8');
  assert.match(film, /<section id="v1">/);
  const bin = await readFile(join(target, 'assets', 'a.bin'));
  assert.equal(bin.length, 4096);
  assert.equal(bin[0], 9);
});

test('恶意包：条目带 ../ → 整包拒绝，目标目录不留东西', async () => {
  const evil = join(base, 'evil.zip');
  await writeFile(evil, buildZip([{ name: '../evil.txt', data: 'pwned' }]));
  const target = join(base, 'evil-out');
  const extracted = await extractProjectArchive(evil, target);
  assert.equal(extracted.ok, false);
  assert.equal(extracted.code, 'ARCHIVE_UNSAFE_PATH');
  await assert.rejects(readFile(join(base, 'evil.txt'), 'utf8'), /ENOENT/);
});

test('没有 manifest 的普通 zip → ARCHIVE_NO_MANIFEST', async () => {
  const plain = join(base, 'plain.zip');
  await writeFile(plain, buildZip([{ name: 'film.html', data: '<html></html>', deflate: true }]));
  const read = await readProjectArchive(plain);
  assert.equal(read.ok, false);
  assert.equal(read.code, 'ARCHIVE_NO_MANIFEST');
});

test('清单里有、包里没有 → 逐条报 mismatch', async () => {
  const manifest = {
    version: ARCHIVE_VERSION,
    name: 'incomplete',
    createdAt: new Date().toISOString(),
    files: [
      { path: 'film.html', bytes: 13, sha256: 'x'.repeat(64) },
      { path: 'assets/missing.mp4', bytes: 10, sha256: 'y'.repeat(64) },
    ],
  };
  const zip = join(base, 'incomplete.zip');
  await writeFile(
    zip,
    buildZip([
      { name: 'film.html', data: '<html></html>' },
      { name: 'manifest.json', data: JSON.stringify(manifest), deflate: true },
    ]),
  );
  const extracted = await extractProjectArchive(zip, join(base, 'incomplete-out'));
  assert.equal(extracted.ok, true);
  const reasons = extracted.mismatch.map((item) => `${item.path}:${item.reason}`).sort();
  assert.deepEqual(reasons, ['assets/missing.mp4:清单里有，包里没有', 'film.html:sha256 与清单不一致']);
});

test('不是 zip → ARCHIVE_NOT_ZIP', async () => {
  const junk = join(base, 'junk.zip');
  await writeFile(junk, 'this is not a zip at all');
  const read = await readProjectArchive(junk);
  assert.equal(read.ok, false);
  assert.equal(read.code, 'ARCHIVE_NOT_ZIP');
});

/* ── 路由：真服务端上打一次包、再导回来 ────────────────────────────────── */

test('POST /archive → 产物能读；POST /import → 解到新目录并打开', async () => {
  const { startStudio } = await import('../studio-server.mjs');
  const { getJson, postJson } = await import('./helpers.mjs');
  const root = join(base, 'studio-root');
  await mkdir(root, { recursive: true });
  const studio = await startStudio({ port: 0, vitePort: 59373, home: join(base, 'home'), projectsRoot: root, logger: () => undefined });
  try {
    const opened = await postJson(`${studio.url}/api/projects/open`, { dir: source });
    assert.equal(opened.status, 200, JSON.stringify(opened.body).slice(0, 200));
    const projectId = opened.body.project.projectId;

    const archived = await postJson(`${studio.url}/api/projects/${encodeURIComponent(projectId)}/archive`, {});
    assert.equal(archived.status, 200);
    assert.equal(archived.body.files, 3);
    assert.ok(archived.body.bytes > 0);
    const readBack = await readProjectArchive(archived.body.path);
    assert.equal(readBack.ok, true);

    const imported = await postJson(`${studio.url}/api/projects/import`, { zipPath: archived.body.path });
    assert.equal(imported.status, 200, JSON.stringify(imported.body).slice(0, 300));
    assert.equal(imported.body.files, 3);
    assert.deepEqual(imported.body.mismatch, []);
    // 包里的工程名来自导出时的 `summary.name`（这里是目录名 src），不是文件名。
    assert.equal(imported.body.project.name, 'src');
    // 重名不覆盖：第二次导到 -2
    const again = await postJson(`${studio.url}/api/projects/import`, { zipPath: archived.body.path });
    assert.equal(again.status, 200);
    assert.notEqual(again.body.dir, imported.body.dir);

    const listed = await getJson(`${studio.url}/api/projects`);
    assert.equal(listed.status, 200);
  } finally {
    await studio.close();
  }
});
