/**
 * 字幕解析的一致性护栏（P25 · R14）。
 *
 * 背景（R14-C1，用户可看见的缺陷）：同一个 `.vtt` 现在有**两套**解析器——
 * 时间线预览走 `packages/film-core/subtitle.mjs` 的 `parseSubtitles`，
 * 导出烧录用本包的 `parseSubtitleText`。R12 之前后者不清洗行内标记，
 * `<v 阿宁><i>第一句</i> &amp; 你好` 会原样烧进画面，而预览显示「第一句 & 你好」。
 * 修一行不够：**没有人会同时在两边改**。这个文件把口径钉死。
 *
 * 说明：这里**故意跨包 import** `film-core/subtitle.mjs`。产品代码零跨包引用这条规则
 * 仍然成立——本文件是测试，不是接线；目的就是让两条实现互相对账。
 * 若哪天 film-core 搬走，这个测试会先红，那正是它该做的事。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSubtitles } from '../../film-core/subtitle.mjs';
import { parseSubtitleText, SubtitleError } from '../subtitles.mjs';
import { FIXTURES, DIFF_WHITELIST } from './subtitle-parity-fixtures.mjs';

/**
 * 跑一遍本包解析器，把「抛错」也变成可比较的形态。
 * @param {{ id: string, format: 'vtt' | 'srt', text: string }} fixture
 * @returns {{ ok: true, cues: Array<[number, number, string]> } | { ok: false, code: string, message: string }}
 */
function renderSide(fixture) {
  try {
    const parsed = parseSubtitleText(fixture.text, { format: fixture.format, source: fixture.id });
    return { ok: true, cues: parsed.cues.map((cue) => [cue.startSec, cue.endSec, cue.text]) };
  } catch (err) {
    const code = err instanceof SubtitleError ? err.code : 'UNEXPECTED';
    return { ok: false, code, message: String(/** @type {any} */ (err)?.message ?? err) };
  }
}

/**
 * @param {{ format: 'vtt' | 'srt', text: string }} fixture
 * @returns {{ ok: true, cues: Array<[number, number, string]>, skipped: number }}
 */
function coreSide(fixture) {
  const parsed = parseSubtitles(fixture.text, { format: fixture.format });
  /** @type {Array<[number, number, string]>} */
  const cues = parsed.cues.map((cue) => [cue.start, cue.end, cue.text]);
  return { ok: true, cues, skipped: parsed.skipped };
}

/** 顺序无关的比较键：按 (start, end, text) 排序后再比。 */
function sortTriples(/** @type {Array<[number, number, string]>} */ triples) {
  return [...triples].sort((a, b) => a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));
}

test('夹具数量够：至少 14 条，且边界类型齐全', () => {
  assert.ok(FIXTURES.length >= 14, `only ${FIXTURES.length} fixtures`);
  const ids = new Set(FIXTURES.map((fixture) => fixture.id));
  for (const required of [
    'bom',
    'note-and-style',
    'entities',
    'short-time',
    'inline-voice-and-italic',
    'crlf',
    'cue-id',
    'srt-comma',
    'multiline',
    'empty-text',
    'end-before-start',
    'overlap',
    'srt-no-header',
  ]) {
    assert.ok(ids.has(required), `missing fixture ${required}`);
  }
});

test('P25-A1：两套解析器对同一份字幕给出同一批 cue（白名单之外零差异）', () => {
  /** @type {Array<{ id: string, verdict: 'SAME' | 'WHITELIST', cues: number, detail?: string }>} */
  const rows = [];
  /** @type {string[]} */
  const failures = [];

  for (const fixture of FIXTURES) {
    const mine = renderSide(fixture);
    const theirs = coreSide(fixture);
    const whitelisted = DIFF_WHITELIST.find((entry) => entry.id === fixture.id);

    if (whitelisted) {
      if (whitelisted.expect === 'render-throws') {
        if (mine.ok) {
          failures.push(`${fixture.id}: whitelist says render throws, but it returned ${mine.cues.length} cues`);
        } else if (mine.code !== 'SUBTITLE_PARSE_FAILED') {
          failures.push(`${fixture.id}: whitelist says SUBTITLE_PARSE_FAILED, got ${mine.code}`);
        }
        if (!theirs.ok) failures.push(`${fixture.id}: film-core must not throw`);
        if (theirs.ok && theirs.cues.length !== 0) failures.push(`${fixture.id}: film-core should drop the bad cue`);
        rows.push({ id: fixture.id, verdict: 'WHITELIST', cues: 0, detail: 'render throws / core drops' });
      }
      continue;
    }

    if (!mine.ok) {
      failures.push(`${fixture.id}: render threw ${mine.code} (${mine.message ?? ''}) but is not whitelisted`);
      rows.push({ id: fixture.id, verdict: 'SAME', cues: 0, detail: `render threw ${mine.code}` });
      continue;
    }
    const a = sortTriples(mine.cues);
    const b = sortTriples(theirs.cues);
    try {
      assert.deepEqual(a, b);
      rows.push({ id: fixture.id, verdict: 'SAME', cues: a.length });
    } catch {
      failures.push(
        `${fixture.id}: render=${JSON.stringify(a)} core=${JSON.stringify(b)}`,
      );
      rows.push({ id: fixture.id, verdict: 'SAME', cues: a.length, detail: 'MISMATCH' });
    }
  }

  if (failures.length > 0) {
    assert.fail(`parity mismatch:\n  ${failures.join('\n  ')}`);
  }

  const same = rows.filter((row) => row.verdict === 'SAME').length;
  const whitelistedRows = rows.filter((row) => row.verdict === 'WHITELIST').length;
  assert.equal(same + whitelistedRows, FIXTURES.length);
  assert.equal(whitelistedRows, DIFF_WHITELIST.length);
});

test('P25-A1 附：白名单每条都必须真的还在差（免得白名单变成"永久豁免"）', () => {
  for (const entry of DIFF_WHITELIST) {
    const fixture = FIXTURES.find((item) => item.id === entry.id);
    assert.ok(fixture, `whitelist entry ${entry.id} has no fixture`);
    const mine = renderSide(/** @type {any} */ (fixture));
    const theirs = coreSide(/** @type {any} */ (fixture));
    if (entry.expect === 'render-throws') {
      assert.equal(mine.ok, false, `${entry.id}: 差异已经不存在了，请把白名单删掉`);
      assert.equal(theirs.ok, true, `${entry.id}: film-core 不应该抛`);
    }
  }
});

test('行内标记与实体：烧录文本 == 预览文本（R14-C1 的回归钉子）', () => {
  const raw = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\n<v 阿宁><i>第一句</i> &amp; 你好\n';
  const mine = parseSubtitleText(raw, { format: 'vtt' });
  const theirs = parseSubtitles(raw, { format: 'vtt' });
  assert.equal(mine.cues[0]?.text, '第一句 & 你好');
  assert.equal(theirs.cues[0]?.text, '第一句 & 你好');
  assert.equal(mine.cues[0]?.text, theirs.cues[0]?.text);
});
