/**
 * P35（B-SUB2-R18-018）：轨道开关 × 导出计划。
 *
 * 口径只有四句话，这里逐条钉住：
 * - `hidden` 整条跳过（画面与声音都不进计划），一条轨只报一条 warning；
 * - `muted` **只静音**，视频片段照旧出画（别顺手把画面也删了）；
 * - `locked` 只影响编辑，导出侧不看它（计划逐字节相同）；
 * - `solo` 不是方言属性，导出不看独奏（计划逐字节相同）。
 *
 * 用真 ffprobe 读素材时长，但不渲染——渲染层的对照在 `scripts/r18-acceptance.mjs`。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parse } from '../../film-core/film-doc.mjs';
import { planFromFilm } from '../film-plan.mjs';

const ROOT = new URL('../../../', import.meta.url).pathname;
const BARS = path.join(ROOT, 'tests/fixtures/media/bars-3s-720p30.mp4');
const TONE = path.join(ROOT, 'tests/fixtures/media/tone-1khz-3s.wav');

/** @type {string} */
let workDir;

/** 3s 的画面 + 3s 的声音，都从既有夹具复制（不动素材）。 */
async function ensureProject() {
  if (workDir) return workDir;
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-track-flags-'));
  await fs.mkdir(path.join(workDir, 'assets'), { recursive: true });
  await fs.copyFile(BARS, path.join(workDir, 'assets/bars.mp4'));
  await fs.copyFile(TONE, path.join(workDir, 'assets/tone.wav'));
  return workDir;
}

/**
 * @param {string} body
 * @returns {Promise<any>}
 */
async function docOf(body) {
  const { doc, diagnostics } = parse(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=1280, height=720"></head><body>${body}</body></html>`,
    { path: 'film.html' },
  );
  assert.equal(doc === null, false, `parse failed: ${diagnostics.map((d) => d.message).join('; ')}`);
  return doc;
}

const VIDEO = '<video id="pic" src="assets/bars.mp4#t=0,3" at="0" muted size="1280x720"></video>';
const AUDIO = '<audio id="tone" src="assets/tone.wav#t=0,3" at="0" volume="1"></audio>';

test('P35：hidden 轨整条跳过，画面/声音都不进计划，并留一条 warning', async () => {
  const root = await ensureProject();
  const doc = await docOf(`<section id="ghost-track" hidden>${VIDEO}${AUDIO}</section>`);
  const plan = await planFromFilm(doc, { projectRoot: root, fps: 30 });

  assert.equal(plan.visualClips.length, 0, 'hidden 轨的视频不能进 visualClips');
  assert.equal(plan.sceneClips.length, 0);
  assert.equal(plan.audioMix, null, 'hidden 轨的音频不能进 audioMix');
  assert.deepEqual(plan.hiddenTracks, ['ghost-track']);
  assert.equal(plan.emptyPicture, true, '整条画面轨都隐藏时仍要出片（黑场），计划层显式标记');
  // 时长不变：隐藏是可见性，不是长度
  assert.equal(plan.duration, 3);
  assert.equal(plan.frames, 90);

  const hiddenWarnings = plan.warnings.filter((/** @type {string} */ w) => w.includes('is hidden'));
  assert.deepEqual(hiddenWarnings, ['track ghost-track is hidden; skipped']);
});

test('P35：hidden 轨只报一条 warning（不按片段数重复）', async () => {
  const root = await ensureProject();
  const doc = await docOf(`<section id="multi" hidden>${VIDEO}<video id="pic2" src="assets/bars.mp4#t=0,3" at="0"></video></section>`);
  const plan = await planFromFilm(doc, { projectRoot: root, fps: 30 });
  assert.equal(plan.warnings.filter((/** @type {string} */ w) => w.includes('is hidden')).length, 1);
});

test('P35：muted 轨只静音——音频不进计划，视频照旧出画', async () => {
  const root = await ensureProject();
  const doc = await docOf(`<section id="voice" muted>${AUDIO}</section><section id="picture">${VIDEO}</section>`);
  const plan = await planFromFilm(doc, { projectRoot: root, fps: 30 });

  assert.equal(plan.audioMix, null, 'muted 轨的音频必须跳过');
  assert.equal(plan.visualClips.length, 1, 'muted 轨不影响同一工程里的**其它**轨画面');
  assert.equal(plan.visualClips[0].id, 'pic');
  assert.ok(plan.warnings.some((/** @type {string} */ w) => w.includes('muted')), plan.warnings.join(' | '));
});

test('P35：muted 轨里的视频照样出画（只静音，不出画是误读）', async () => {
  const root = await ensureProject();
  const doc = await docOf(`<section id="both" muted>${VIDEO}${AUDIO}</section>`);
  const plan = await planFromFilm(doc, { projectRoot: root, fps: 30 });

  assert.equal(plan.visualClips.length, 1, 'muted 只作用于声音');
  assert.equal(plan.audioMix, null);
  assert.equal(plan.emptyPicture, undefined, '有可见画面时不该标成空画面');
});

test('P35：locked 轨导出侧完全不看（计划逐字节相同）', async () => {
  const root = await ensureProject();
  const plain = await planFromFilm(
    await docOf(`<section id="picture">${VIDEO}</section><section id="voice">${AUDIO}</section>`),
    { projectRoot: root, fps: 30 },
  );
  const locked = await planFromFilm(
    await docOf(`<section id="picture">${VIDEO}</section><section id="voice" locked>${AUDIO}</section>`),
    { projectRoot: root, fps: 30 },
  );
  assert.equal(JSON.stringify(locked), JSON.stringify(plain));
});

test('P35：solo 不进文档、不参与导出（调用方塞了也当没看见）', async () => {
  const root = await ensureProject();
  const doc = await docOf(`<section id="a">${VIDEO}</section><section id="b">${AUDIO}</section>`);
  const baseline = await planFromFilm(doc, { projectRoot: root, fps: 30 });

  // 方言里没有 solo；就算上游硬塞一个，计划也不该变
  const withSolo = {
    ...doc,
    tracks: doc.tracks.map((/** @type {any} */ track, /** @type {number} */ index) => (index === 0 ? { ...track, solo: true } : track)),
  };
  const soloPlan = await planFromFilm(withSolo, { projectRoot: root, fps: 30 });
  assert.equal(JSON.stringify(soloPlan), JSON.stringify(baseline));
});
