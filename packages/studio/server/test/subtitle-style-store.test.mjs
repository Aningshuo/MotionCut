// @ts-nocheck
/**
 * 字幕样式存储：**落盘只写差异**（R34 · BATCH-SUB1-R31-093）
 *
 * 为什么要这条（判据 E12-P5 的 C5）：点一下预设，盘上应该只有 `{"preset":"outline"}`。
 * 以前每次保存都把归一后的 18 个字段整包写下去 —— 看起来像用户逐项调过，实际只有
 * `preset` 是他选的；而「预设只写 id、派生值在渲染时展开」这句话也就落不了地。
 *
 * 读侧一直走 `normalizeSubtitleStyle` 补默认值，所以**少写等值字段不改变语义**：
 * 这一组用例把「写下去是差异 / 读回来是完整样式」两边都钉住。
 *
 * 跑法：`node --test packages/studio/server/test/subtitle-style-store.test.mjs`
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { SUBTITLE_STYLE_DEFAULTS } from '../../../layers/subtitle-style.mjs';
import { readSubtitleStyle, saveSubtitleStyle, stylePathOf } from '../subtitle-style-store.mjs';

let root = '';

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'opencut-subtitle-style-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 每个用例一个独立工程目录（写盘是原子的，但互相别看见对方的文件）。 @param {string} name */
async function projectDir(name) {
  const dir = join(root, name);
  await rm(dir, { recursive: true, force: true });
  await (await import('node:fs/promises')).mkdir(dir, { recursive: true });
  return dir;
}

/** 盘上那份 JSON 的 `style`。 @param {string} dir */
async function fileStyle(dir) {
  return JSON.parse(await readFile(stylePathOf(dir), 'utf8')).style;
}

test('S188-1 只写 preset：盘上恰好一个键，读回来是完整样式', async () => {
  const dir = await projectDir('only-preset');
  const saved = await saveSubtitleStyle({ projectDir: dir, patch: { preset: 'outline' } });
  assert.equal(saved.ok, true);
  assert.equal(saved.code, undefined);
  assert.deepEqual(await fileStyle(dir), { preset: 'outline' });

  /* 读回来：18 个字段齐全，且 preset 的派生值（outlineRatio 0.12）在**渲染时**才展开 ——
     这里读的是「基础样式 + preset id」，不是展开后的值。 */
  const read = await readSubtitleStyle(dir);
  assert.equal(read.ok, true);
  assert.deepEqual(Object.keys(read.style).sort(), Object.keys(SUBTITLE_STYLE_DEFAULTS).sort());
  assert.equal(read.style.preset, 'outline');
  assert.equal(read.style.outlineRatio, SUBTITLE_STYLE_DEFAULTS.outlineRatio);
});

test('S188-2 与默认值相同的字段不落盘，改过的字段照写', async () => {
  const dir = await projectDir('diff-fields');
  await saveSubtitleStyle({ projectDir: dir, patch: { preset: 'large' } });
  assert.deepEqual(await fileStyle(dir), { preset: 'large' });

  /* 改一个真正不同的值 → 只有它跟着 preset 一起写下去 */
  await saveSubtitleStyle({ projectDir: dir, patch: { fontScale: 1.5, cpsWarn: 20 } });
  assert.deepEqual(await fileStyle(dir), { preset: 'large', fontScale: 1.5, cpsWarn: 20 });

  /* 改回默认值 → 那个键从盘上消失（语义等价，盘上不留噪音） */
  await saveSubtitleStyle({ projectDir: dir, patch: { fontScale: 1 } });
  assert.deepEqual(await fileStyle(dir), { preset: 'large', cpsWarn: 20 });

  const read = await readSubtitleStyle(dir);
  assert.equal(read.style.fontScale, 1, '读回来仍是默认值');
  assert.equal(read.style.cpsWarn, 20, '写过的值还在');
});

test('S188-3 preset 与默认值相同时也必须写（它是「用户选了哪一支」的身份）', async () => {
  const dir = await projectDir('default-preset');
  await saveSubtitleStyle({ projectDir: dir, patch: { preset: 'default' } });
  assert.deepEqual(await fileStyle(dir), { preset: 'default' }, '不能写成空对象');
});

test('S188-4 未知字段与非法值仍然拒（不因为改成差异写就放过校验）', async () => {
  const dir = await projectDir('invalid');
  const unknown = await saveSubtitleStyle({ projectDir: dir, patch: { nope: 1 } });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'UNKNOWN_FIELD');
  assert.equal(unknown.field, 'nope');

  const bad = await saveSubtitleStyle({ projectDir: dir, patch: { fontSizeRatio: 9 } });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'INVALID_STYLE');
  assert.ok(bad.issues.length > 0);

  /* 两次都被拒 → 盘上不该出现文件 */
  const read = await readSubtitleStyle(dir);
  assert.equal(read.exists, false);
  assert.equal(read.style.preset, SUBTITLE_STYLE_DEFAULTS.preset);
});
