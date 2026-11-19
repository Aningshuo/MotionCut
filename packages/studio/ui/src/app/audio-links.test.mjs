// @ts-nocheck —— 单测按运行时断言；被测模块 audio-links.mjs 仍由 tsc 检查。
/**
 * R137 · SUB2 · M12 · A：HTML 标签不是路径（`</title>` 误判）+ 路径规则一条不许松。
 *
 * 每条都成对给「该放过」和「该拒」两侧 —— 只证「不报错了」等于没证：
 * 上一批的教训是「把可疑输入从拒绝改成文本」也能让红胶囊消失，但安全性一起没了。
 *
 * 跑法：`node --test packages/studio/ui/src/app/audio-links.test.mjs`
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyAudioPath,
  classifyPath,
  isMarkupFragment,
  scanAudioLinks,
} from './audio-links.mjs';

/** 把 scan 结果拼回原文：证明剥标签没吞字符。 */
const flatten = (parts) => parts.map((part) => (part.kind === 'text' ? part.text : part.raw)).join('');
const rejectsOf = (parts) => parts.filter((part) => part.kind === 'rejected');
const linksOf = (parts) => parts.filter((part) => part.kind === 'link');

/* ── 一、复现与修复：`</title>` 不再变拒绝胶囊 ───────────────────────── */

test('A1 修复：含 <title>…</title> 的 HTML 片段不再产出任何拒绝胶囊', () => {
  const text = '<!doctype html><html><head><title>BOX 页面</title></head><body><p>音频在 assets/voice.wav</p></body></html>';
  const parts = scanAudioLinks(text);
  assert.deepEqual(rejectsOf(parts), [], `不该有拒绝胶囊，实际：${JSON.stringify(rejectsOf(parts))}`);
  /* 标签外面的真路径照样可点。 */
  const links = linksOf(parts);
  assert.equal(links.length, 1);
  assert.equal(links[0].path, 'assets/voice.wav');
  /* 原文一个字符都不能少（`</title>` 必须原样留在文本里）。 */
  assert.equal(flatten(parts), text);
});

test('A2 修复：`</title>` 单独出现时是文本，不是路径', () => {
  const parts = scanAudioLinks('结束标记是 </title> 这一串');
  assert.deepEqual(rejectsOf(parts), []);
  assert.equal(linksOf(parts).length, 0);
  assert.equal(flatten(parts), '结束标记是 </title> 这一串');
});

test('A3 修复：自闭合 `<br/>` 也不出拒绝胶囊（旧代码会判 TRAVERSAL）', () => {
  const parts = scanAudioLinks('第一行<br/>第二行');
  assert.deepEqual(rejectsOf(parts), []);
  assert.equal(flatten(parts), '第一行<br/>第二行');
});

test('A4 isMarkupFragment：只认紧贴边界的标签名，不做形状猜测', () => {
  assert.equal(isMarkupFragment('/title', '<', '>'), true);
  assert.equal(isMarkupFragment('/title', '<', '.'), true, '句末标点不影响');
  assert.equal(isMarkupFragment('br/', '<', '>'), true);
  assert.equal(isMarkupFragment('/title', '', ''), false, '单独出现不是标签');
  assert.equal(isMarkupFragment('/title', ' ', '>'), false, '前面不是 < 就不是标签');
  assert.equal(isMarkupFragment('assets/a.wav', '<', '>'), false, '含 / 和 . 不是标签名');
  assert.equal(isMarkupFragment('/etc/passwd', ' ', ''), false);
});

/* ── 二、负向：路径规则一条没松（6 条） ─────────────────────────────── */

test('N1 真绝对路径：/etc/passwd 仍判 ABSOLUTE_PATH（且不是「不是音频」）', () => {
  assert.deepEqual(classifyAudioPath('/etc/passwd'), { ok: false, reason: 'ABSOLUTE_PATH' });
  const parts = scanAudioLinks('看 /etc/passwd 这里');
  assert.equal(rejectsOf(parts).length, 1);
  assert.equal(rejectsOf(parts)[0].reason, 'ABSOLUTE_PATH');
});

test('N2 http(s):// 仍判 SCHEME', () => {
  for (const raw of ['http://example.com/a.wav', 'https://example.com/a.wav']) {
    assert.deepEqual(classifyAudioPath(raw), { ok: false, reason: 'SCHEME' }, raw);
    assert.equal(rejectsOf(scanAudioLinks(raw))[0]?.reason, 'SCHEME', raw);
  }
});

test('N3 file: 仍判 SCHEME', () => {
  assert.deepEqual(classifyAudioPath('file:///etc/passwd'), { ok: false, reason: 'SCHEME' });
  assert.equal(rejectsOf(scanAudioLinks('file:///etc/passwd'))[0]?.reason, 'SCHEME');
});

test('N4 Windows 盘符：C:/… 判 SCHEME、C:\\… 判 CONTROL', () => {
  assert.deepEqual(classifyAudioPath('C:/Users/x/a.wav'), { ok: false, reason: 'SCHEME' });
  assert.deepEqual(classifyAudioPath('C:\\Users\\x\\a.wav'), { ok: false, reason: 'CONTROL' });
  assert.equal(rejectsOf(scanAudioLinks('C:/Users/x/a.wav')).length, 1);
});

test('N5 .. 上跳仍判 TRAVERSAL', () => {
  assert.deepEqual(classifyAudioPath('../../etc/passwd'), { ok: false, reason: 'TRAVERSAL' });
  assert.deepEqual(classifyAudioPath('assets/../../x.wav'), { ok: false, reason: 'TRAVERSAL' });
  assert.equal(rejectsOf(scanAudioLinks('assets/../../x.wav'))[0]?.reason, 'TRAVERSAL');
});

test('N6 百分号编码绕过仍拒（解码后再判，不因剥标签松掉）', () => {
  assert.deepEqual(classifyAudioPath('assets/%2e%2e/secret.wav'), { ok: false, reason: 'TRAVERSAL' });
  /* `%2e%2e%2f` 解出 `../`：段里有 `..` → TRAVERSAL。 */
  assert.deepEqual(classifyAudioPath('%2e%2e%2fx.wav'), { ok: false, reason: 'TRAVERSAL' });
  /* `%2f%2e%2e/x.wav` 解出 `//../x.wav`：**先**撞上「前导 / 是绝对路径」这条
     （分类顺序 = 先安全后扩展名），仍是拒绝，不是「不是音频」。 */
  assert.deepEqual(classifyAudioPath('%2f%2e%2e/x.wav'), { ok: false, reason: 'ABSOLUTE_PATH' });
  for (const raw of ['assets/%2e%2e/secret.wav', '%2f%2e%2e/x.wav']) {
    assert.equal(rejectsOf(scanAudioLinks(raw)).length, 1, raw);
  }
  /* 一个**字面**斜杠都没有的编码串（`%2e%2e%2fx.wav`）连 `link` 都不会变：
     分词器只把「含 `/` 的 token」交给分类器，这条在分类之前就当文本了 ——
     安全性不受影响（点不了、也不发请求），但不能要求它出拒绝胶囊。 */
  assert.equal(linksOf(scanAudioLinks('%2e%2e%2fx.wav')).length, 0);
  assert.equal(rejectsOf(scanAudioLinks('%2e%2e%2fx.wav')).length, 0);
});

/* ── 三、`/tit` 的判据（裸斜杠开头到底算不算路径） ───────────────────── */

test('P1 判据：裸 `/tit` 仍拒，reason = ABSOLUTE_PATH（不是相对路径）', () => {
  assert.deepEqual(classifyPath('/tit'), { ok: false, reason: 'ABSOLUTE_PATH' });
  assert.deepEqual(classifyAudioPath('/tit'), { ok: false, reason: 'ABSOLUTE_PATH' });
  const parts = scanAudioLinks('裸写一个 /tit 看看');
  const rejects = rejectsOf(parts);
  assert.equal(rejects.length, 1);
  assert.equal(rejects[0].raw, '/tit');
  assert.equal(rejects[0].reason, 'ABSOLUTE_PATH');
});

test('P2 同一个形状两种来源：`</tit>` 是文本，`/tit` 是绝对路径', () => {
  assert.equal(isMarkupFragment('/tit', '<', '>'), true);
  assert.equal(isMarkupFragment('/tit', ' ', ' '), false);
  assert.deepEqual(scanAudioLinks('</tit>').filter((part) => part.kind === 'rejected'), []);
  assert.equal(rejectsOf(scanAudioLinks('/tit')).length, 1);
});

/* ── 四、别把标签里的合法路径一起吞掉 ───────────────────────────────── */

test('P3 `<audio src="assets/a.wav">` 里的路径仍变成可点胶囊', () => {
  const links = linksOf(scanAudioLinks('<audio src="assets/a.wav">'));
  assert.equal(links.length, 1);
  assert.equal(links[0].path, 'assets/a.wav');
});

test('P4 `<a href="/etc/passwd">` 里的绝对路径仍被拒（前面不是 <）', () => {
  const rejects = rejectsOf(scanAudioLinks('<a href="/etc/passwd">'));
  assert.equal(rejects.length, 1);
  assert.equal(rejects[0].raw, '/etc/passwd');
  assert.equal(rejects[0].reason, 'ABSOLUTE_PATH');
});

test('P5 标签片段与路径混排：原文完整、只有真路径参与分类', () => {
  const text = '<html><head><title>a</title></head><body>试听 assets/v.wav 或 ../../evil.wav</body></html>';
  const parts = scanAudioLinks(text);
  assert.equal(flatten(parts), text);
  assert.equal(linksOf(parts).length, 1);
  assert.equal(linksOf(parts)[0].path, 'assets/v.wav');
  assert.equal(rejectsOf(parts).length, 1);
  assert.equal(rejectsOf(parts)[0].reason, 'TRAVERSAL');
});
