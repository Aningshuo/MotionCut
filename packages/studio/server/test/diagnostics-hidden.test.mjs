/**
 * M68-NEW-05-DIAG-HIDDEN 的服务端单测（B-MAIN-R30-033）。
 *
 * 口径写死：`.film/cache/**`=cache、`.film/history/**` 与版本快照=history、
 * `.film/logs/**` 与 `*.log`=logs、其余=other；不跟随符号链接；不可读只记 issue；
 * 清理只动 cache，history/logs 一个字节都不许变。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { classifyHiddenPath, cleanCache, hiddenUsage } from '../settings-store.mjs';
import { startStudio } from '../studio-server.mjs';

/** @param {any} buffer */
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');

/** @param {number} bytes */
function blob(bytes) {
  return Buffer.alloc(bytes, 0x61);
}

/**
 * 造一个工程：cache 5 个（10B each）、history 5 个（20B）、logs 5 个（30B）、
 * 版本快照 1 个（40B）、other（film.html 固定内容）。
 * @param {string} dir
 */
async function makeProject(dir) {
  await fs.mkdir(path.join(dir, '.film', 'cache'), { recursive: true });
  await fs.mkdir(path.join(dir, '.film', 'history', 'snapshots'), { recursive: true });
  await fs.mkdir(path.join(dir, '.film', 'logs'), { recursive: true });
  await fs.mkdir(path.join(dir, '.film', 'versions.git'), { recursive: true });
  for (let index = 0; index < 5; index += 1) {
    await fs.writeFile(path.join(dir, '.film', 'cache', `c${index}.bin`), blob(10));
    await fs.writeFile(path.join(dir, '.film', 'history', 'snapshots', `h${index}.html`), blob(20));
    await fs.writeFile(path.join(dir, '.film', 'logs', `l${index}.txt`), blob(30));
  }
  await fs.writeFile(path.join(dir, '.film', 'versions.git', 'pack.idx'), blob(40));
  await fs.writeFile(path.join(dir, 'film.html'), '<!doctype html><html><body></body></html>');
  await fs.writeFile(path.join(dir, 'render.log'), blob(5));
  return dir;
}

const CACHE_BYTES = 5 * 10;
const HISTORY_BYTES = 5 * 20 + 40;
const LOGS_BYTES = 5 * 30 + 5;

/** @param {string} dir */
async function tempProject(dir) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `opencut-diag-${dir}-`));
  return makeProject(root);
}

test('classifyHiddenPath：cache/history/版本快照/logs/other 的口径', () => {
  assert.equal(classifyHiddenPath('.film/cache/a.bin'), 'cache');
  assert.equal(classifyHiddenPath('.film/cache/nested/a.log'), 'cache', '显式目录优先于 *.log');
  assert.equal(classifyHiddenPath('.film/history/snapshots/a.html'), 'history');
  assert.equal(classifyHiddenPath('.film/versions.git/objects/ab/cd'), 'history');
  assert.equal(classifyHiddenPath('.film/versions-backup/x'), 'history');
  assert.equal(classifyHiddenPath('.film/logs/run.txt'), 'logs');
  assert.equal(classifyHiddenPath('render.log'), 'logs');
  assert.equal(classifyHiddenPath('assets/film.html'), 'other');
  assert.equal(classifyHiddenPath('exports/movie.mp4'), 'other');
});

test('hiddenUsage：三类字节数与 other/total 对得上（5+5+5）', async () => {
  const dir = await tempProject('sum');
  try {
    const usage = await hiddenUsage({ projects: [{ id: 'p1', path: dir }] });
    const otherBytes = (await fs.stat(path.join(dir, 'film.html'))).size;
    assert.equal(usage.cacheBytes, CACHE_BYTES);
    assert.equal(usage.historyBytes, HISTORY_BYTES);
    assert.equal(usage.logsBytes, LOGS_BYTES);
    assert.equal(usage.otherBytes, otherBytes);
    assert.equal(usage.totalBytes, CACHE_BYTES + HISTORY_BYTES + LOGS_BYTES + otherBytes);
    assert.deepEqual(usage.issues, []);
    assert.equal(usage.byProject.length, 1);
    const first = /** @type {any} */ (usage.byProject[0]);
    assert.deepEqual(Object.keys(first).sort(), ['cacheBytes', 'historyBytes', 'id', 'logsBytes', 'path']);
    assert.equal(first.id, 'p1');
    assert.equal(first.path, dir);
    assert.equal(first.cacheBytes, CACHE_BYTES);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('hiddenUsage：不跟随符号链接（文件/目录都不统计）', async () => {
  const dir = await tempProject('symlink');
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-diag-outside-'));
  try {
    await fs.writeFile(path.join(outside, 'big.bin'), blob(1000));
    await fs.symlink(path.join(outside, 'big.bin'), path.join(dir, '.film', 'cache', 'link.bin'));
    await fs.symlink(outside, path.join(dir, '.film', 'cache', 'linkdir'));
    const usage = await hiddenUsage({ projects: [{ id: 'p', path: dir }] });
    assert.equal(usage.cacheBytes, CACHE_BYTES, '符号链接不得计入');
    assert.equal(usage.issues.length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('hiddenUsage：不可读目录记 UNREADABLE:<path>，不整体抛错', async () => {
  const dir = await tempProject('unreadable');
  const locked = path.join(dir, '.film', 'cache', 'locked');
  try {
    await fs.mkdir(locked, { recursive: true });
    await fs.writeFile(path.join(locked, 'x.bin'), blob(7));
    await fs.chmod(locked, 0o000);
    const usage = await hiddenUsage({ projects: [{ id: 'p', path: dir }] });
    assert.ok(usage.issues.some((line) => line === `UNREADABLE:${locked}`), JSON.stringify(usage.issues));
    assert.equal(usage.cacheBytes, CACHE_BYTES, '不可读目录里的 7B 不计入');
  } finally {
    await fs.chmod(locked, 0o755).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('hiddenUsage：>2GB 文件只统计不读取', async () => {
  const dir = await tempProject('huge');
  const huge = path.join(dir, '.film', 'cache', 'huge.part');
  try {
    const handle = await fs.open(huge, 'w');
    try {
      await handle.truncate(2_200_000_000);
    } finally {
      await handle.close();
    }
    const started = Date.now();
    const usage = await hiddenUsage({ projects: [{ id: 'p', path: dir }] });
    const elapsed = Date.now() - started;
    assert.equal(usage.cacheBytes, CACHE_BYTES + 2_200_000_000);
    assert.ok(elapsed < 1000, `扫描耗时 ${elapsed}ms（不应读文件内容）`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('cleanCache：只删 cache，history/logs/other 字节与 sha 全不变', async () => {
  const dir = await tempProject('clean');
  try {
    const before = await hiddenUsage({ projects: [{ id: 'p', path: dir }] });
    const historyFile = path.join(dir, '.film', 'history', 'snapshots', 'h0.html');
    const logFile = path.join(dir, '.film', 'logs', 'l0.txt');
    const otherFile = path.join(dir, 'film.html');
    const historySha = sha(await fs.readFile(historyFile));
    const logSha = sha(await fs.readFile(logFile));
    const otherSha = sha(await fs.readFile(otherFile));

    const result = await cleanCache(dir, { confirm: true });
    assert.equal(result.ok, true);
    assert.equal(result.removed, 5);
    assert.equal(result.freedBytes, CACHE_BYTES);
    assert.equal(result.before.cacheBytes, CACHE_BYTES);
    assert.equal(result.after.cacheBytes, 0);
    assert.equal(result.after.historyBytes, before.historyBytes);
    assert.equal(result.after.logsBytes, before.logsBytes);
    assert.equal(result.after.otherBytes, before.otherBytes);

    assert.equal(sha(await fs.readFile(historyFile)), historySha);
    assert.equal(sha(await fs.readFile(logFile)), logSha);
    assert.equal(sha(await fs.readFile(otherFile)), otherSha);
    assert.deepEqual(await fs.readdir(path.join(dir, '.film', 'cache')), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('cleanCache：重复清理 freedBytes=0，不报错', async () => {
  const dir = await tempProject('repeat');
  try {
    assert.equal((await cleanCache(dir, { confirm: true })).freedBytes, CACHE_BYTES);
    const again = await cleanCache(dir, { confirm: true });
    assert.equal(again.ok, true);
    assert.equal(again.freedBytes, 0);
    assert.equal(again.removed, 0);
    assert.equal(again.before.historyBytes, again.after.historyBytes);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('cleanCache：缺 confirm 直接拒绝，一个文件都不删', async () => {
  const dir = await tempProject('confirm');
  try {
    const refused = await cleanCache(dir, {});
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'CONFIRM_REQUIRED');
    const entries = await fs.readdir(path.join(dir, '.film', 'cache'));
    assert.equal(entries.length, 5);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('并发 4 个诊断：结果一致，不互相踩', async () => {
  const dir = await tempProject('parallel');
  try {
    const results = await Promise.all(
      Array.from({ length: 4 }, () => hiddenUsage({ projects: [{ id: 'p', path: dir }] })),
    );
    for (const usage of results) {
      assert.equal(usage.cacheBytes, CACHE_BYTES);
      assert.equal(usage.historyBytes, HISTORY_BYTES);
      assert.equal(usage.logsBytes, LOGS_BYTES);
      assert.deepEqual(usage.issues, []);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('性能：批量小文件（200）诊断 ≤300ms', async () => {
  // 1000 文件的真实吞吐由 `scripts/m68-diag-hidden.mjs` 的 D4 在独立进程里证明；
  // 单测这里只留 200 个，避免与其它测试文件并行时把沙箱 FS broker 压垮。
  const dir = await tempProject('perf');
  try {
    await fs.mkdir(path.join(dir, '.film', 'cache', 'bulk'), { recursive: true });
    for (let start = 0; start < 200; start += 20) {
      await Promise.all(
        Array.from({ length: 20 }, (_, offset) =>
          fs.writeFile(path.join(dir, '.film', 'cache', 'bulk', `f${start + offset}.bin`), blob(1)),
        ),
      );
    }
    const started = Date.now();
    const usage = await hiddenUsage({ projects: [{ id: 'p', path: dir }] });
    const elapsed = Date.now() - started;
    assert.ok(usage.cacheBytes >= 200, `cache=${usage.cacheBytes}`);
    assert.ok(elapsed <= 300, `诊断 ${elapsed}ms > 300ms`);
    process.stdout.write(`# perf 200-files diag=${elapsed}ms
`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('GET /api/settings/diagnostics：hidden 按工程返回；cache/clean 只清 cache', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-diag-http-'));
  const dir = path.join(root, 'proj');
  await makeProject(dir);
  await fs.writeFile(
    path.join(dir, 'film.html'),
    '<!doctype html><html><head><title>m68</title></head><body><section id="v1"><video id="a" src="assets/a.mp4" at="0" style="left:0px;top:0px;width:10px;height:10px"></video></section></body></html>',
  );
  const previous = process.env.OPENCUT_SETTINGS;
  process.env.OPENCUT_SETTINGS = path.join(root, 'settings.json');
  const studio = await startStudio({ port: 0, vitePort: 59999, projectsRoot: root, home: root });
  try {
    const opened = await fetch(`${studio.url}/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir }),
    });
    assert.equal(opened.status, 200);

    const diagnostics = await fetch(`${studio.url}/api/settings/diagnostics`);
    const body = await diagnostics.json();
    assert.equal(diagnostics.status, 200);
    assert.equal(body.hidden.cacheBytes, CACHE_BYTES);
    assert.equal(body.hidden.historyBytes, HISTORY_BYTES);
    assert.equal(body.hidden.logsBytes, LOGS_BYTES);
    assert.ok(Array.isArray(body.hidden.byProject) && body.hidden.byProject.length >= 1);
    assert.deepEqual(body.issues, []);

    const logShaBefore = sha(await fs.readFile(path.join(dir, '.film', 'logs', 'l0.txt')));
    const historyShaBefore = sha(await fs.readFile(path.join(dir, '.film', 'history', 'snapshots', 'h0.html')));
    const cleaned = await fetch(`${studio.url}/api/settings/cache/clean`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: body.hidden.byProject[0].id, confirm: true }),
    });
    const cleanBody = await cleaned.json();
    assert.equal(cleaned.status, 200);
    assert.equal(cleanBody.freedBytes, CACHE_BYTES);
    assert.equal(sha(await fs.readFile(path.join(dir, '.film', 'logs', 'l0.txt'))), logShaBefore);
    assert.equal(sha(await fs.readFile(path.join(dir, '.film', 'history', 'snapshots', 'h0.html'))), historyShaBefore);

    const again = await fetch(`${studio.url}/api/settings/diagnostics`);
    const after = await again.json();
    assert.equal(after.hidden.cacheBytes, 0);
    assert.equal(after.hidden.historyBytes, body.hidden.historyBytes);
    assert.equal(after.hidden.logsBytes, body.hidden.logsBytes);
  } finally {
    await studio.close();
    if (previous === undefined) delete process.env.OPENCUT_SETTINGS;
    else process.env.OPENCUT_SETTINGS = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
