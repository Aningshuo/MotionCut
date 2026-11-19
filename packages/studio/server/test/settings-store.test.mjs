/**
 * M49 设置中心的服务端单测（B-MAIN-R24-024）。
 *
 * 覆盖任务书 A2–A4 的**逻辑面**（真实 UI 验收在 `scripts/m49-settings-center.mjs`）：
 *
 * - 默认值与「文件不存在不是错误」；
 * - 补丁校验：未知字段 / 越界 / 枚举外（fps 29）/ 布尔类型；
 * - 原子写 + 回读（不留 .tmp，sha 对得上）；
 * - 坏 JSON：**原文件被改名而不是被覆盖**，返回默认值 + SETTINGS_CORRUPT；
 * - 清理历史快照：只删 `.film/history/snapshots` 里的旧文件、必须显式 confirm；
 * - 五个只读 AI 卡片只给路径与存在性（不读内容）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  SETTINGS_DEFAULTS,
  aiCards,
  applySettingsPatch,
  cleanHistory,
  defaultSettings,
  normalizeSettings,
  readSettings,
  settingsPath,
  writeSettings,
} from '../settings-store.mjs';

/**
 * 每个用例一个临时目录 + 独立的 OPENCUT_SETTINGS。
 * @param {(ctx: {dir: string, file: string}) => Promise<void>} fn
 */
async function withSettingsDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-settings-'));
  const previous = process.env.OPENCUT_SETTINGS;
  process.env.OPENCUT_SETTINGS = path.join(dir, 'settings.json');
  try {
    await fn({ dir, file: process.env.OPENCUT_SETTINGS });
  } finally {
    if (previous === undefined) delete process.env.OPENCUT_SETTINGS;
    else process.env.OPENCUT_SETTINGS = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('默认值：文件不存在给默认，不是错误', async () => {
  await withSettingsDir(async (/** @type {{dir: string, file: string}} */ { file }) => {
    const read = await readSettings();
    assert.equal(read.ok, true);
    assert.equal(read.exists, false);
    assert.deepEqual(read.settings, defaultSettings());
    assert.deepEqual(read.settings, JSON.parse(JSON.stringify(SETTINGS_DEFAULTS)));
    assert.deepEqual(read.issues, []);
    assert.equal(read.path, file);
    assert.equal(read.version, 1);
  });
});

test('旧设置默认深色，修改外观后保留播放参数并可重新读取', async () => {
  await withSettingsDir(async ({ file }) => {
    await fs.writeFile(file, JSON.stringify({ settings: { playback: { volume: 37 } } }));
    const old = await readSettings();
    assert.equal(old.settings.appearance.theme, 'dark');
    const applied = applySettingsPatch({ appearance: { theme: 'light' } }, old.settings);
    assert.equal(applied.ok, true);
    await writeSettings(applied.settings);
    const reopened = await readSettings();
    assert.equal(reopened.settings.appearance.theme, 'light');
    assert.equal(reopened.settings.playback.volume, 37);
    assert.equal(applySettingsPatch({ appearance: { theme: 'invalid' } }, reopened.settings).ok, false);
  });
});

test('补丁校验：未知分区/未知字段/越界/枚举外/类型', () => {
  const current = defaultSettings();

  const unknownSection = applySettingsPatch({ playback: {}, nope: {} }, current);
  assert.equal(unknownSection.ok, false);
  assert.equal(unknownSection.code, 'UNKNOWN_FIELD');
  assert.equal(unknownSection.field, 'nope');

  const unknownField = applySettingsPatch({ playback: { volume: 10, foo: 1 } }, current);
  assert.equal(unknownField.ok, false);
  assert.equal(unknownField.code, 'UNKNOWN_FIELD');
  assert.equal(unknownField.field, 'playback.foo');

  const tooLoud = applySettingsPatch({ playback: { volume: 101 } }, current);
  assert.equal(tooLoud.ok, false);
  assert.equal(tooLoud.code, 'OUT_OF_RANGE');
  assert.equal(tooLoud.field, 'playback.volume');

  const negative = applySettingsPatch({ playback: { volume: -1 } }, current);
  assert.equal(negative.code, 'OUT_OF_RANGE');

  const fractional = applySettingsPatch({ playback: { volume: 3.5 } }, current);
  assert.equal(fractional.code, 'OUT_OF_RANGE');

  const badFps = applySettingsPatch({ export: { fps: 29 } }, current);
  assert.equal(badFps.ok, false);
  assert.equal(badFps.code, 'OUT_OF_RANGE');
  assert.deepEqual(badFps.allowed, [24, 25, 30, 60]);

  const badCodec = applySettingsPatch({ export: { codec: 'vp9' } }, current);
  assert.equal(badCodec.code, 'OUT_OF_RANGE');

  const badQuality = applySettingsPatch({ export: { quality: 'ultra' } }, current);
  assert.equal(badQuality.code, 'OUT_OF_RANGE');

  const badBool = applySettingsPatch({ playback: { loop: 'yes' } }, current);
  assert.equal(badBool.code, 'OUT_OF_RANGE');

  const good = applySettingsPatch({ playback: { volume: 35 }, export: { fps: 24 } }, current);
  assert.equal(good.ok, true);
  assert.equal(good.settings.playback.volume, 35);
  assert.equal(good.settings.export.fps, 24);
  // 没传的字段保持原值（补丁语义）
  assert.equal(good.settings.playback.loop, false);
  assert.equal(good.settings.export.quality, 'standard');
});

test('原子写 + 回读：35 落盘、无 .tmp、sha 与回读一致', async () => {
  await withSettingsDir(async (/** @type {{dir: string, file: string}} */ { dir, file }) => {
    const patch = applySettingsPatch({ playback: { volume: 35 } }, defaultSettings());
    assert.equal(patch.ok, true);
    const written = await writeSettings(patch.settings);
    assert.equal(written.ok, true);
    assert.equal(written.path, file);
    assert.equal(written.sha256.length, 64);

    const read = await readSettings();
    assert.equal(read.exists, true);
    assert.equal(read.settings.playback.volume, 35);
    assert.equal(read.updatedAt, written.updatedAt);

    const names = await fs.readdir(dir);
    assert.deepEqual(names.filter((name) => name.endsWith('.tmp')), []);

    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(raw.version, 1);
    assert.equal(raw.settings.playback.volume, 35);
  });
});

test('坏 JSON：改名留证据、返回默认 + SETTINGS_CORRUPT、不写新文件', async () => {
  await withSettingsDir(async (/** @type {{dir: string, file: string}} */ { dir, file }) => {
    await fs.writeFile(file, '{bad', 'utf8');
    const read = await readSettings();
    assert.equal(read.ok, true);
    assert.deepEqual(read.issues, ['SETTINGS_CORRUPT']);
    assert.deepEqual(read.settings, defaultSettings());
    assert.equal(read.exists, false);
    assert.equal(typeof read.backup, 'string');

    // 原文件没被覆盖：它被改名了，内容还在。
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });
    const backup = /** @type {string} */ (read.backup);
    assert.equal(await fs.readFile(backup, 'utf8'), '{bad');
    const names = await fs.readdir(dir);
    assert.ok(names.some((name) => name.startsWith('settings.json.bak-')));

    // 再 PUT 一次才落新文件（GET 不写盘）。
    const patch = applySettingsPatch({ playback: { volume: 12 } }, read.settings);
    assert.equal(patch.ok, true);
    const written = await writeSettings(patch.settings);
    assert.equal(written.ok, true);
    assert.equal((await readSettings()).settings.playback.volume, 12);
  });
});

test('文件里有未知键/坏值：读的时候忽略并留 issue，不让整页失败', async () => {
  await withSettingsDir(async (/** @type {{dir: string, file: string}} */ { file }) => {
    await fs.writeFile(
      file,
      JSON.stringify({ version: 1, settings: { playback: { volume: 500, extra: true }, export: { fps: 30 } } }),
      'utf8',
    );
    const read = await readSettings();
    assert.equal(read.ok, true);
    assert.equal(read.settings.playback.volume, 100);
    assert.ok(read.issues.includes('playback.volume'));
    assert.equal(read.settings.export.fps, 30);
    const normalized = normalizeSettings({ playback: 'nope' });
    assert.deepEqual(normalized.issues, ['PLAYBACK_SHAPE']);
  });
});

test('清理历史快照：只删 snapshots 里的旧文件，必须 confirm', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-clean-'));
  try {
    const snapshots = path.join(dir, '.film', 'history', 'snapshots');
    await fs.mkdir(snapshots, { recursive: true });
    await fs.writeFile(path.join(dir, '.film', 'history', 'keep.txt'), 'x', 'utf8');
    await fs.mkdir(path.join(dir, 'exports'), { recursive: true });
    await fs.writeFile(path.join(dir, 'exports', 'film.mp4'), 'video', 'utf8');
    for (let index = 0; index < 5; index += 1) {
      const file = path.join(snapshots, `snap-${index}.html`);
      await fs.writeFile(file, `<html>${index}</html>`, 'utf8');
      const stamp = new Date(Date.now() - (5 - index) * 60000);
      await fs.utimes(file, stamp, stamp);
    }

    const refused = await cleanHistory(dir, { keep: 2 });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'CONFIRM_REQUIRED');
    assert.equal((await fs.readdir(snapshots)).length, 5);

    const cleaned = await cleanHistory(dir, { keep: 2, confirm: true });
    assert.equal(cleaned.ok, true);
    assert.equal(cleaned.before, 5);
    assert.equal(cleaned.deleted, 3);
    assert.equal(cleaned.kept, 2);
    const left = (await fs.readdir(snapshots)).sort();
    assert.deepEqual(left, ['snap-3.html', 'snap-4.html']);
    // exports 与 history 根上的文件都不动
    assert.equal(await fs.readFile(path.join(dir, 'exports', 'film.mp4'), 'utf8'), 'video');
    assert.equal(await fs.readFile(path.join(dir, '.film', 'history', 'keep.txt'), 'utf8'), 'x');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('AI 诊断列出五个用户位置和入站 MCP 程序，仅返回元数据', () => {
  const cards = aiCards();
  assert.deepEqual(cards.map((card) => card.id), ['agents', 'models', 'providers', 'skills', 'mcp', 'mcp-inbound']);
  for (const card of cards) {
    assert.equal(typeof card.path, 'string');
    if (card.id === 'mcp-inbound') {
      assert.ok(card.path.endsWith(path.join('packages', 'mcp', 'bin.mjs')));
      assert.equal(card.exists, true);
    } else {
      assert.ok(card.path.startsWith(os.homedir()));
      assert.ok(card.reason.includes('只读'));
    }
    assert.equal(typeof card.exists, 'boolean');
    // 不读内容：卡片的字段里没有 content / token / key
    assert.deepEqual(Object.keys(card).sort(), ['exists', 'id', 'label', 'path', 'reason']);
  }
});

test('settingsPath：OPENCUT_SETTINGS 覆盖优先', async () => {
  await withSettingsDir(async (/** @type {{dir: string, file: string}} */ { file }) => {
    assert.equal(settingsPath(), file);
  });
  const previous = process.env.OPENCUT_SETTINGS;
  delete process.env.OPENCUT_SETTINGS;
  try {
    assert.equal(settingsPath(), path.join(os.homedir(), '.opencut', 'settings.json'));
  } finally {
    if (previous !== undefined) process.env.OPENCUT_SETTINGS = previous;
  }
});

/* ── M54：`export.last` 记住上次导出 ───────────────────────────────────────
 * 这一组守的是「表单初值 = 上次」这条链的前半段：写法合法就原样存回来，
 * 写法坏了要**指到子字段**报错，而不是把整条记忆丢掉。
 */

test('export.last：默认 null = 没导出过', () => {
  assert.equal(defaultSettings().export.last, null);
  assert.equal(normalizeSettings({}).settings.export.last, null);
});

test('export.last：浮点 fps 原样保留（29.97 不许被四舍五入成 30）', () => {
  const { settings, issues } = normalizeSettings({
    export: {
      last: { codec: 'hevc', quality: 'high', fps: 29.97, size: '3840x2160', fit: 'letterbox', loudness: -14 },
    },
  });
  assert.deepEqual(issues, []);
  assert.deepEqual(settings.export.last, {
    codec: 'hevc',
    quality: 'high',
    fps: 29.97,
    size: '3840x2160',
    fit: 'letterbox',
    loudness: -14,
  });
});

test('export.last：坏子字段只丢那一个，其余保留并留痕', () => {
  const { settings, issues } = normalizeSettings({
    export: { last: { codec: 'hevc', quality: 'ultra', fps: 30 } },
  });
  assert.deepEqual(issues, ['export.last.quality']);
  assert.deepEqual(settings.export.last, { codec: 'hevc', fps: 30 });
});

test('export.last：未知子字段 → UNKNOWN_FIELD 指到 export.last.<name>', () => {
  const result = applySettingsPatch({ export: { last: { codec: 'h264', nonsense: 1 } } }, defaultSettings());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNKNOWN_FIELD');
  assert.equal(result.field, 'export.last.nonsense');
});

test('export.last：fps 越界 → OUT_OF_RANGE 指到 export.last.fps', () => {
  const result = applySettingsPatch({ export: { last: { fps: 0 } } }, defaultSettings());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'OUT_OF_RANGE');
  assert.equal(result.field, 'export.last.fps');
});

test('export.last：null 可以清除记忆，且不影响同分区的 fps/codec', () => {
  const current = { ...defaultSettings(), export: { fps: 25, codec: 'hevc', quality: 'high', last: { fps: 30 } } };
  const result = applySettingsPatch({ export: { last: null } }, current);
  assert.equal(result.ok, true);
  assert.equal(result.settings.export.last, null);
  assert.equal(result.settings.export.fps, 25);
  assert.equal(result.settings.export.codec, 'hevc');
});

test('export.last：写盘 → 读回逐字段相等（原子写不吞浮点）', async () => {
  await withSettingsDir(async () => {
    const last = { codec: 'hevc', quality: 'high', fps: 23.976, size: '1080x1920', fit: 'cover', loudness: -16, subtitleBurn: true };
    const patched = applySettingsPatch({ export: { last } }, defaultSettings());
    assert.equal(patched.ok, true);
    const wrote = await writeSettings({ ...defaultSettings(), export: patched.settings.export });
    assert.equal(wrote.ok, true);
    const read = await readSettings();
    assert.deepEqual(read.settings.export.last, last);
  });
});
