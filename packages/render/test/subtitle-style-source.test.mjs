// @ts-nocheck —— 纯文件读取 + 归一化，不跑 ffmpeg
/**
 * P48：工程字幕样式的读取与优先级。
 *
 * 1. 没有文件 = 默认（`style` 是 undefined，交给下游保持零漂移）；
 * 2. 有文件 = 归一化后使用，issues 不阻断（与 Studio 一致）；
 * 3. 坏 JSON / 顶层不是对象 / 主版本不同 → INVALID（CLI 退出码 2）；
 * 4. 显式参数永远优先，且不读文件。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SUBTITLE_STYLE_FILE, readProjectSubtitleStyle, resolveSubtitleStyle } from '../subtitle-style-source.mjs';

/** @param {any} [payload] */
async function projectWith(payload) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-style-'));
  if (payload !== undefined) {
    await fs.mkdir(path.join(dir, '.film'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.film', 'subtitle-style.json'),
      typeof payload === 'string' ? payload : JSON.stringify(payload),
      'utf8',
    );
  }
  return dir;
}

test('P48：没有文件 → 默认（style 为 undefined）', async () => {
  const dir = await projectWith();
  const resolved = await resolveSubtitleStyle({ projectRoot: dir });
  assert.equal(resolved.style, undefined);
  assert.equal(resolved.audit.origin, 'default');
  assert.equal(resolved.audit.exists, false);
  assert.deepEqual(resolved.audit.issues, []);
  await fs.rm(dir, { recursive: true, force: true });
});

test('P48：文件里只写两个字段也算合法，其余走默认', async () => {
  const dir = await projectWith({ version: '1.0.0', style: { fontScale: 1.5, bold: true } });
  const resolved = await resolveSubtitleStyle({ projectRoot: dir });
  assert.equal(resolved.audit.origin, 'project');
  assert.equal(resolved.style.fontScale, 1.5);
  assert.equal(resolved.style.bold, true);
  assert.deepEqual(resolved.audit.issues, []);
  const stored = await readProjectSubtitleStyle(dir);
  assert.equal(stored.exists, true);
  assert.match(stored.sha256, /^[0-9a-f]{64}$/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('P48：字段越界不阻断，但 issues 要记下来', async () => {
  const dir = await projectWith({ version: '1.0.0', style: { fontScale: 99 } });
  const resolved = await resolveSubtitleStyle({ projectRoot: dir });
  assert.equal(resolved.audit.origin, 'project');
  assert.ok(resolved.audit.issues.length > 0);
  assert.equal(typeof resolved.style.fontScale, 'number');
  await fs.rm(dir, { recursive: true, force: true });
});

test('P48：坏 JSON → INVALID', async () => {
  const dir = await projectWith('{bad');
  await assert.rejects(resolveSubtitleStyle({ projectRoot: dir }), (err) => {
    assert.equal(err.code, 'INVALID');
    assert.match(String(err.message), /subtitle-style\.json/);
    return true;
  });
  await fs.rm(dir, { recursive: true, force: true });
});

test('P48：顶层不是对象 / 主版本不同 → INVALID', async () => {
  for (const payload of ['[]', '{"version":"2.0.0","style":{}}']) {
    const dir = await projectWith(payload);
    await assert.rejects(resolveSubtitleStyle({ projectRoot: dir }), (err) => err.code === 'INVALID', payload);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('P48：显式参数优先，且不去读文件', async () => {
  const dir = await projectWith({ version: '1.0.0', style: { fontScale: 1.5 } });
  const resolved = await resolveSubtitleStyle({ projectRoot: dir, explicit: { fontSizeRatio: 0.05 } });
  assert.equal(resolved.audit.origin, 'explicit');
  assert.equal(resolved.audit.file, null);
  assert.equal(resolved.style.fontSizeRatio, 0.05);
  await fs.rm(dir, { recursive: true, force: true });
});

test('P48：路径常量与 Studio 一致', () => {
  assert.equal(SUBTITLE_STYLE_FILE, '.film/subtitle-style.json');
});

/* ── P65：形状不对必须说出来 ─────────────────────────────────────────────── */

test('P65：顶层写了样式字段、没有 style 键 → 用默认 + TOP_LEVEL_STYLE_IGNORED', async () => {
  const dir = await projectWith({ version: '1.0.0', fontSizeRatio: 0.08, lineHeight: 1.0, color: '#ffcc00' });
  const stored = await readProjectSubtitleStyle(dir);
  assert.equal(stored.exists, true);
  assert.equal(stored.shape, 'top-level');
  assert.equal(stored.style, null);
  assert.deepEqual(stored.warnings, ['TOP_LEVEL_STYLE_IGNORED']);
  assert.deepEqual(stored.ignoredFields, ['fontSizeRatio', 'color', 'lineHeight']);

  const resolved = await resolveSubtitleStyle({ projectRoot: dir });
  assert.equal(resolved.style, undefined, '必须走默认（默认 ASS 逐字节不变）');
  assert.equal(resolved.audit.origin, 'default');
  assert.equal(resolved.audit.shape, 'top-level');
  assert.deepEqual(resolved.warnings, ['TOP_LEVEL_STYLE_IGNORED']);
  await fs.rm(dir, { recursive: true, force: true });
});

test('P65：style 与顶层字段并存 → 用 style + TOP_LEVEL_SHADOWED', async () => {
  const dir = await projectWith({
    version: '1.0.0',
    fontSizeRatio: 0.08,
    style: { fontScale: 1.5 },
  });
  const stored = await readProjectSubtitleStyle(dir);
  assert.equal(stored.shape, 'both');
  assert.deepEqual(stored.warnings, ['TOP_LEVEL_SHADOWED']);

  const resolved = await resolveSubtitleStyle({ projectRoot: dir });
  assert.equal(resolved.audit.origin, 'project');
  assert.equal(resolved.style.fontScale, 1.5, '以 style 为准');
  assert.deepEqual(resolved.warnings, ['TOP_LEVEL_SHADOWED']);
  await fs.rm(dir, { recursive: true, force: true });
});

test('P65：非法字号 → INVALID_SUBTITLE_STYLE（带字段名与实际值）', async () => {
  for (const style of [{ fontSize: -3 }, { fontSizeRatio: 0 }]) {
    const dir = await projectWith({ version: '1.0.0', style });
    await assert.rejects(resolveSubtitleStyle({ projectRoot: dir }), (err) => {
      assert.equal(err.code, 'INVALID_SUBTITLE_STYLE');
      const field = Object.keys(style)[0];
      assert.match(String(err.message), new RegExp(`"${field}"`));
      assert.match(String(err.message), new RegExp(String(Object.values(style)[0]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    });
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('P65：lineHeight ≤ 0 → INVALID_SUBTITLE_STYLE', async () => {
  for (const lineHeight of [0, -1.25]) {
    const dir = await projectWith({ version: '1.0.0', style: { lineHeight } });
    await assert.rejects(resolveSubtitleStyle({ projectRoot: dir }), (err) => {
      assert.equal(err.code, 'INVALID_SUBTITLE_STYLE');
      assert.match(String(err.message), /"lineHeight"/);
      assert.match(String(err.message), new RegExp(String(lineHeight)));
      return true;
    });
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('P65：颜色非法 → INVALID_SUBTITLE_STYLE', async () => {
  for (const style of [{ color: 'nope' }, { outlineColor: '#12' }, { background: 'rgb(1,2)' }]) {
    const dir = await projectWith({ version: '1.0.0', style });
    await assert.rejects(resolveSubtitleStyle({ projectRoot: dir }), (err) => {
      assert.equal(err.code, 'INVALID_SUBTITLE_STYLE');
      assert.match(String(err.message), new RegExp(`"${Object.keys(style)[0]}"`));
      return true;
    });
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('P65：合法颜色都收（#rgb / #rrggbb / #rrggbbaa / rgb() / rgba() / transparent）', async () => {
  const dir = await projectWith({
    version: '1.0.0',
    style: { color: '#fff', outlineColor: '#112233', shadowColor: '#11223344', background: 'rgba(0,0,0,0.5)' },
  });
  const resolved = await resolveSubtitleStyle({ projectRoot: dir });
  assert.equal(resolved.audit.origin, 'project');
  assert.deepEqual(resolved.warnings, []);
  await fs.rm(dir, { recursive: true, force: true });
});

test('P65：未知字段保留 + warn（不阻断）', async () => {
  const dir = await projectWith({ version: '1.0.0', style: { fontSize: 30, glow: true } });
  const resolved = await resolveSubtitleStyle({ projectRoot: dir });
  assert.equal(resolved.audit.origin, 'project');
  const fields = resolved.audit.issues.filter((issue) => issue.code === 'STYLE_UNKNOWN_KEY').map((issue) => issue.field);
  assert.ok(fields.includes('fontSize'), `fontSize 应当是未知字段：${JSON.stringify(fields)}`);
  assert.ok(fields.includes('glow'));
  await fs.rm(dir, { recursive: true, force: true });
});

test('P65：空文件 → INVALID（既有行为不变）', async () => {
  const dir = await projectWith('');
  await assert.rejects(resolveSubtitleStyle({ projectRoot: dir }), (err) => {
    assert.equal(err.code, 'INVALID');
    assert.match(String(err.message), /not valid JSON/);
    return true;
  });
  await fs.rm(dir, { recursive: true, force: true });
});

test('P65：只有 version 的对象 → 默认（empty 形状，无警告）', async () => {
  const dir = await projectWith({ version: '1.0.0' });
  const resolved = await resolveSubtitleStyle({ projectRoot: dir });
  assert.equal(resolved.style, undefined);
  assert.equal(resolved.audit.origin, 'default');
  assert.equal(resolved.audit.shape, 'empty');
  assert.deepEqual(resolved.warnings, []);
  await fs.rm(dir, { recursive: true, force: true });
});

test('P65：prepareSubtitleBurn 的警告文案带文件形状提示', async () => {
  const { auditWarningsOf } = await import('../subtitles.mjs');
  const ignored = auditWarningsOf({ warnings: ['TOP_LEVEL_STYLE_IGNORED'], ignoredFields: ['fontSizeRatio'] });
  assert.equal(ignored.length, 1);
  assert.match(ignored[0], /must wrap fields in \{"style":\{\.\.\.\}\}/);
  assert.match(ignored[0], /fontSizeRatio/);
  assert.match(ignored[0], /using default style/);

  const shadowed = auditWarningsOf({ warnings: ['TOP_LEVEL_SHADOWED'], ignoredFields: ['color'] });
  assert.match(shadowed[0], /shadowed by "style"/);

  assert.deepEqual(auditWarningsOf(undefined), []);
  assert.deepEqual(auditWarningsOf({ warnings: [] }), []);
});
