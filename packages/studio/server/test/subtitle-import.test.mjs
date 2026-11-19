// @ts-nocheck
/**
 * E12-P5 第 3 步：字幕导入 / 导出端点（B-MAIN-R30-086）
 *
 * 判据（任务书 §4）：
 *   1. **往返**：`vtt → 段 → vtt` 与原文逐字节相同（差异只能来自 `ROUND_TRIP_ALLOWED_DIFFS`）；
 *   2. **坏输入**：空文件 / 时间码不合法 / 非 UTF-8，三种各给明确错误码，不吞不崩；
 *   3. **老工程**：`tests/fixtures/main/film-basic.html` 开一次、写一次，`film.html`
 *      逐字节不变、不多字段、不重排（字幕是旁挂文件，根本不该碰 film.html）。
 *
 * 跑法：`node --test packages/studio/server/test/subtitle-import.test.mjs`
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { sha256 } from '../../../film-core/film-doc.mjs';
import { startStudio } from '../studio-server.mjs';
import { MAX_SUBTITLE_BYTES, ROUND_TRIP_ALLOWED_DIFFS, exportSubtitleBytes, importSubtitleBytes } from '../subtitle-import.mjs';
import { getJson, makeProject, postJson, repoRoot } from './helpers.mjs';

const quietLogger = () => undefined;

/** 夹具：真实工程里的伴生字幕（不是测试里现编的字符串）。 */
const FIXTURE_VTT = join(repoRoot, 'tests/fixtures/r50/projects/p55-zh/assets/base.vtt');
const FIXTURE_VTT_MULTI = join(repoRoot, 'tests/fixtures/r50/projects/p720/assets/base.vtt');
/** 带 cue 标识（`1` / `2`）的那种——真实工具导出的常态。 */
const FIXTURE_VTT_IDS = join(repoRoot, 'tests/fixtures/s75/assets/voice.vtt');

/** @type {{ root: string, dir: string, filmPath: string }|null} */
let project;
/** @type {Awaited<ReturnType<typeof startStudio>>} */
let studio;
/** @type {string} */
let projectId = '';

before(async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencut-sub-import-'));
  const made = await makeProject('alpha');
  const dir = join(root, 'alpha');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'film.html'), made.text, 'utf8');
  project = { root, dir, filmPath: join(dir, 'film.html') };
  studio = await startStudio({ port: 0, vitePort: 59371, projectsRoot: root, thumbnailTimeoutMs: 100, logger: quietLogger });
  const opened = await postJson(`${studio.url}/api/projects/open`, { path: dir });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  projectId = opened.body.project.projectId;
});

after(async () => {
  await studio?.close();
  if (project !== null) {
    await rm(project.root, { recursive: true, force: true });
  }
});

/** @param {string} file */
const bytesOf = (file) => readFile(file);

/** @param {string} suffix */
const urlOf = (suffix) => `${studio.url}/api/projects/${encodeURIComponent(projectId)}${suffix}`;

/**
 * 把字节原样 POST 到导入端点（**请求体就是文件字节**，不是 JSON 里的字符串）。
 * @param {Buffer} body
 * @param {{ query?: string, contentType?: string }} [options]
 */
async function postBytes(body, options = {}) {
  const response = await fetch(`${urlOf('/subtitles/import')}${options.query ?? ''}`, {
    method: 'POST',
    headers: { 'content-type': options.contentType ?? 'application/octet-stream' },
    body,
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, body: payload };
}

test('A1 往返：规范 VTT 文件 → 段 → VTT，与原文逐字节相同', async () => {
  const raw = await bytesOf(FIXTURE_VTT);
  const imported = importSubtitleBytes(raw, { name: 'base.vtt' });
  assert.equal(imported.ok, true, JSON.stringify(imported));
  assert.equal(imported.format, 'vtt');
  assert.equal(imported.cueCount, 1);
  assert.equal(imported.encoding, 'utf-8');
  assert.equal(imported.skipped, 0);

  const exported = exportSubtitleBytes(imported.cues);
  assert.equal(exported.ok, true);
  assert.equal(exported.roundTrip.cueEqual, true);
  assert.equal(exported.roundTrip.byteIdentical, true);
  /* 判据本体：与磁盘上的原文**逐字节**相同（不是「结构相等」）。 */
  assert.equal(Buffer.compare(Buffer.from(exported.text, 'utf8'), raw), 0);

  /* 同一条链走 HTTP 再验一次（端点与纯函数不能有第二套行为）。 */
  const viaHttp = await postBytes(raw, { query: '?name=base.vtt', contentType: 'text/vtt' });
  assert.equal(viaHttp.status, 200, JSON.stringify(viaHttp.body));
  assert.deepEqual(viaHttp.body.cues, imported.cues);
  /* 原文不回传：2 MiB 的文件没理由在响应里再传一遍。 */
  assert.equal('text' in viaHttp.body, false);

  const roundTrip = await postJson(urlOf('/subtitles/export'), { cues: viaHttp.body.cues });
  assert.equal(roundTrip.status, 200, JSON.stringify(roundTrip.body));
  assert.equal(roundTrip.body.text, raw.toString('utf8'));
  assert.equal(roundTrip.body.roundTrip.byteIdentical, true);
});

test('A2 往返：多行 + 中文标点的第二条真实夹具，同样逐字节', async () => {
  const raw = await bytesOf(FIXTURE_VTT_MULTI);
  const imported = importSubtitleBytes(raw, { name: 'base.vtt' });
  assert.equal(imported.ok, true, JSON.stringify(imported));
  assert.equal(imported.cueCount, 1);
  assert.equal(imported.cues[0].text.includes('\n'), true, '这条夹具是两行');

  const exported = exportSubtitleBytes(imported.cues);
  assert.equal(Buffer.compare(Buffer.from(exported.text, 'utf8'), raw), 0);
});

test('A3 往返：带 cue 标识 / CRLF / BOM / 行内标签的文件 —— 差异清单 + 第二版是固定点', async () => {
  const raw = await bytesOf(FIXTURE_VTT_IDS);
  const imported = importSubtitleBytes(raw, { name: 'voice.vtt' });
  assert.equal(imported.ok, true, JSON.stringify(imported));
  assert.equal(imported.cueCount, 2);
  assert.equal(imported.skipped, 0);

  const first = exportSubtitleBytes(imported.cues);
  /* 第一版就与原文不同 —— 差异必须**全在清单里**，不能有清单外的惊喜。 */
  assert.notEqual(first.text, raw.toString('utf8'));
  assert.equal(first.text.includes('\n1\n'), false, 'cue 标识被丢掉（清单第 1 条）');
  assert.equal(first.roundTrip.cueEqual, true);
  assert.equal(first.roundTrip.byteIdentical, true);

  /* 固定点：把导出的文本再导入、再导出，逐字节相同。 */
  const again = importSubtitleBytes(Buffer.from(first.text, 'utf8'), { name: 'first.vtt' });
  assert.equal(again.ok, true);
  assert.deepEqual(again.cues, imported.cues);
  assert.equal(exportSubtitleBytes(again.cues).text, first.text);

  /* 清单里的行为逐条抽验（用一份把所有雷都踩上的文件）。 */
  const messy = [
    '\uFEFFWEBVTT - 标题', // BOM + 头部元数据
    '',
    'NOTE 这是注释块',
    '它不该进段列表',
    '',
    'intro',
    '00:00:02.000 --> 00:00:01.000', // 乱序 + 一条倒置
    ' <i>斜体</i> &amp; 实体 ',
    '',
    '2',
    '00:00:00,500 --> 00:00:01,000', // 逗号毫秒（SRT 风味混进来）
    '<c.red>第一句</c>',
    '',
  ].join('\r\n');
  const messyImported = importSubtitleBytes(Buffer.from(messy, 'utf8'), { name: 'messy.vtt' });
  assert.equal(messyImported.ok, true, JSON.stringify(messyImported));
  /* 倒置那条（02.000 --> 01.000）被跳过 —— 解析器的既定行为；剩一条，逗号毫秒也认。
     注意它**不在** badLines 里：时间码读得出，是 `end <= start` 才被跳，
     所以给的是 skippedNote 而不是「第 N 行时间码坏了」（别让面板指错行）。 */
  assert.equal(messyImported.skipped, 1);
  assert.deepEqual(messyImported.cues.map((cue) => cue.start), [0.5]);
  assert.deepEqual(messyImported.cues.map((cue) => cue.text), ['第一句']);
  assert.deepEqual(messyImported.badLines, []);
  assert.match(messyImported.skippedNote, /结束时间不大于开始时间/);
  assert.equal(messyImported.bom, true);

  const messyOut = exportSubtitleBytes(messyImported.cues).text;
  assert.equal(messyOut.includes('NOTE'), false, 'NOTE 块被丢掉');
  assert.equal(messyOut.includes('<i>'), false, '行内标签被剥掉');
  assert.equal(messyOut.includes('\r'), false, 'CRLF 归一成 LF');
  assert.equal(messyOut.includes('&amp;'), false, '实体被还原');
  assert.equal(messyOut.startsWith('WEBVTT'), true);
  assert.equal(messyOut.includes('标题'), false, '头部元数据不保留');
  /* 差异清单本身也得在导出结果里可核对（它是对外的承诺，不是内部注释）。 */
  assert.equal(ROUND_TRIP_ALLOWED_DIFFS.length >= 5, true);
});

test('B1 坏输入：空文件 → SUBTITLE_EMPTY（0 字节与只有空白都算）', async () => {
  const zero = await postBytes(Buffer.alloc(0), { query: '?name=empty.vtt' });
  assert.equal(zero.status, 400);
  assert.equal(zero.body.code, 'SUBTITLE_EMPTY');
  assert.match(zero.body.message, /空/);

  const spaces = await postBytes(Buffer.from(' \n\n\t\n', 'utf8'), { query: '?name=empty.vtt' });
  assert.equal(spaces.status, 400);
  assert.equal(spaces.body.code, 'SUBTITLE_EMPTY');
});

test('B1b 坏输入：超过 2 MiB → SUBTITLE_TOO_LARGE（模块层兜底；HTTP 层会先 413）', async () => {
  /* HTTP 上这一步由 `readRaw` 的 413 拦掉，错误码同样是 SUBTITLE_TOO_LARGE；
     这里打的是模块自己的兜底 —— 直接调用者（脚本/测试）不该能绕过上限。 */
  const big = importSubtitleBytes(Buffer.alloc(MAX_SUBTITLE_BYTES + 1, 0x61), { name: 'big.vtt' });
  assert.equal(big.ok, false);
  assert.equal(big.code, 'SUBTITLE_TOO_LARGE');
  assert.equal(big.bytes, MAX_SUBTITLE_BYTES + 1);

  const atLimit = importSubtitleBytes(Buffer.alloc(MAX_SUBTITLE_BYTES, 0x61), { name: 'limit.vtt' });
  /* 边界是闭区间：刚好 2 MiB 不因长度被拒（这里会因为它不是字幕而 NO_CUES，不是 TOO_LARGE）。 */
  assert.notEqual(atLimit.code, 'SUBTITLE_TOO_LARGE');
});

test('B2 坏输入：时间码不合法 → SUBTITLE_BAD_TIMECODE（指到行）', async () => {
  const broken = Buffer.from('WEBVTT\n\n00:00:0X.000 --> 00:00:02.000\n你好\n\n00:00:05.000 --> 00:00:03.000\n倒置\n', 'utf8');
  const result = await postBytes(broken, { query: '?name=bad.vtt' });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'SUBTITLE_BAD_TIMECODE');
  assert.equal(result.body.line, 3);
  assert.match(result.body.message, /第 3 行/);
  assert.equal(Array.isArray(result.body.badLines), true);
  assert.equal(result.body.badLines[0].text.includes('0X'), true);
});

test('B3 坏输入：非 UTF-8（GBK）→ SUBTITLE_NOT_UTF8（指到字节）', async () => {
  /* 「WEBVTT\n\n」+ GBK 的「字幕」= D7 D6 C4 BB（不是合法 UTF-8）。 */
  const gbk = Buffer.concat([Buffer.from('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n', 'utf8'), Buffer.from([0xd7, 0xd6, 0xc4, 0xbb])]);
  const result = await postBytes(gbk, { query: '?name=gbk.vtt' });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'SUBTITLE_NOT_UTF8');
  assert.equal(Number.isInteger(result.body.byteOffset), true);
  assert.match(result.body.message, /UTF-8/);

  /* UTF-16 的 BOM 单独认出来：文案要能照着做（另存为 UTF-8）。 */
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('WEBVTT', 'utf16le')]);
  const wide = await postBytes(utf16, { query: '?name=wide.vtt' });
  assert.equal(wide.status, 400);
  assert.equal(wide.body.code, 'SUBTITLE_NOT_UTF8');
  assert.equal(wide.body.detected, 'utf-16le');
});

test('B4 三种坏输入都不落盘（不吞不崩，也不留半份文件）', async () => {
  const before = await readFile(join(project.dir, 'film.html'), 'utf8');
  for (const [label, body] of [
    ['empty', Buffer.alloc(0)],
    ['badtime', Buffer.from('WEBVTT\n\nxx --> yy\n你好\n', 'utf8')],
    ['notutf8', Buffer.concat([Buffer.from('WEBVTT\n\n'), Buffer.from([0xd7, 0xd6])])],
  ]) {
    const result = await postBytes(body, { query: `?src=assets/take-a.mp4&save=1&name=${label}.vtt` });
    assert.equal(result.status, 400, `${label} 应该 400，实得 ${result.status}`);
    assert.equal(result.body.ok, false);
  }
  /* 目录里不该出现任何 .vtt（失败的导入连文件都不该建）。 */
  for (const name of ['assets/take-a.vtt', 'assets/take-a.srt']) {
    const exists = await stat(join(project.dir, name)).then(() => true, () => false);
    assert.equal(exists, false, `${name} 不该被创建`);
  }
  assert.equal(await readFile(join(project.dir, 'film.html'), 'utf8'), before);
});

test('C1 老工程：开一次写一次 —— film.html 逐字节不变、无多字段、无重排', async () => {
  const filmBefore = await readFile(project.filmPath);
  const hashBefore = sha256(filmBefore.toString('utf8'));

  const raw = await bytesOf(FIXTURE_VTT);
  const saved = await postBytes(raw, { query: '?src=assets/take-a.mp4&save=1&name=base.vtt', contentType: 'text/vtt' });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.saved.ok, true, JSON.stringify(saved.body.saved));
  assert.equal(saved.body.saved.file, 'assets/take-a.vtt');
  assert.equal(saved.body.saved.format, 'vtt');

  /* film.html 一个字节都不能动：字幕是旁挂 VTT，不是 film.html 的属性。 */
  const filmAfter = await readFile(project.filmPath);
  assert.equal(Buffer.compare(filmAfter, filmBefore), 0);
  assert.equal(sha256(filmAfter.toString('utf8')), hashBefore);

  /* 也不该顺手写出一个样式文件（样式只有用户改样式时才落盘）。 */
  const styleExists = await stat(join(project.dir, '.film/subtitle-style.json')).then(() => true, () => false);
  assert.equal(styleExists, false);

  /* 落盘的就是规范形态：读回来与导入的段逐条相同、再导出逐字节相同。 */
  const onDisk = await readFile(join(project.dir, 'assets/take-a.vtt'), 'utf8');
  assert.equal(Buffer.compare(Buffer.from(onDisk, 'utf8'), raw), 0);
  const read = await getJson(`${studio.url}/api/projects/${encodeURIComponent(projectId)}/subtitles?src=${encodeURIComponent('assets/take-a.mp4')}`);
  assert.equal(read.status, 200);
  assert.equal(read.body.found, true);
  assert.equal(read.body.file, 'assets/take-a.vtt');
  assert.deepEqual(read.body.cues, saved.body.cues);

  /* 写第二次（同样的字节）→ 内容不变、哈希不变（幂等，不抖）。 */
  const twice = await postBytes(raw, { query: '?src=assets/take-a.mp4&save=1&name=base.vtt', contentType: 'text/vtt' });
  assert.equal(twice.status, 200);
  assert.equal(twice.body.saved.hash, saved.body.saved.hash);
});

test('C2 导入 SRT 到没有伴生字幕的片段 → 落 .srt（不悄悄转成 .vtt）', async () => {
  const srt = '1\n00:00:01,000 --> 00:00:02,500\n第一行\n第二行\n\n2\n00:00:03,000 --> 00:00:04,000\n中文标点：好。\n';
  const saved = await postBytes(Buffer.from(srt, 'utf8'), { query: '?src=assets/take-b.mp4&save=1&name=in.srt', contentType: 'application/x-subrip' });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.format, 'srt');
  assert.equal(saved.body.saved.file, 'assets/take-b.srt');
  const onDisk = await readFile(join(project.dir, 'assets/take-b.srt'), 'utf8');
  assert.equal(onDisk, srt, 'SRT 往返逐字节相同（含序号行与逗号毫秒）');

  /* 已有 .srt 之后再导入，格式跟随已有那份（不会被改成 .vtt）。 */
  const again = await postBytes(Buffer.from(srt, 'utf8'), { query: '?src=assets/take-b.mp4&save=1&name=in.vtt' });
  assert.equal(again.status, 200);
  assert.equal(again.body.saved.format, 'srt');
  assert.equal(again.body.saved.file, 'assets/take-b.srt');
});

test('D1 导出端点：坏 cues / 未知字段不吞（400 + 明确码）', async () => {
  const empty = await postJson(urlOf('/subtitles/export'), { cues: [] });
  assert.equal(empty.status, 200, '空段列表是合法输入（写出只有头的 VTT）');
  /* 空段列表写出「只有头」的 VTT：`serializeSubtitles` 是 `WEBVTT\n\n` + 空块 + `\n`。 */
  assert.equal(empty.body.text, 'WEBVTT\n\n\n');

  const bad = await postJson(urlOf('/subtitles/export'), { cues: [{ start: 2, end: 1, text: 'x' }] });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'SUBTITLE_INVALID');
  assert.match(bad.body.message, /结束时间必须大于开始时间/);

  const unknown = await postJson(urlOf('/subtitles/export'), { cues: [], formt: 'vtt' });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, 'UNKNOWN_FIELD');
  assert.equal(unknown.body.field, 'formt');
});
