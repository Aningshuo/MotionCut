// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S5-WP15 验收 A1/A2/A4/A5/A6/A7/A8/A9/A10（库 + 落盘 + 进程重开）
 *
 * 运行：node --test --test-concurrency=1 packages/motion/library.test.mjs
 * （环境路径见 RUN_ROOT：OPENCUT_ENV_JSON 优先，否则自动建 .local-runs/layers/motion-library/env.json）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { resolveLayerTestEnv } from '../layers/test-env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
/* S57：环境可移植（R37-C5）。OPENCUT_ENV_JSON 优先；否则现建 `.local-runs/layers/motion-library/env.json`。 */
const TEST_ENV = await resolveLayerTestEnv({ suite: 'motion-library' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');
const TMP_ROOT = path.join(RUN_ROOT, 'tmp');

const lib = await import(new URL('./library.mjs', import.meta.url).href);
const params = await import(new URL('./params.mjs', import.meta.url).href);

const evidence = { batch: 'B-SUB1-R3-003R1', suite: 'library.test.mjs', cases: {}, startedAt: new Date().toISOString() };
const PROJECT = path.join(TMP_ROOT, `library-${process.pid}`);

const SCHEMA = {
  title: { type: 'string', default: '默认标题', maxLength: 40, apply: { kind: 'text', selector: '.badge-title' } },
  tone: { type: 'color', default: '#25304a' },
  pad: { type: 'number', default: 1, min: 0.5, max: 3, step: 0.1 }
};

const V1 = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>badge v1</title>
<style>.badge{display:block;padding:calc(8px * var(--pad,1));background:var(--tone,#25304a);border-radius:10px}</style>
</head><body>
<div class="badge" data-version="1">
  <img src="assets/logo.png" alt="logo">
  <span class="badge-title">默认标题</span>
</div>
</body></html>
`;

const V2 = V1.replace('data-version="1"', 'data-version="2"').replace('border-radius:10px', 'border-radius:2px');

async function save() {
  evidence.finishedAt = new Date().toISOString();
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(path.join(EVIDENCE_DIR, 's5-library.json'), JSON.stringify(evidence, null, 2) + '\n');
}

async function sha(file) {
  return lib.sha256(await fs.readFile(file, 'utf8'));
}

before(async () => {
  await fs.mkdir(path.join(PROJECT, 'scenes'), { recursive: true });
  await fs.mkdir(path.join(PROJECT, 'assets'), { recursive: true });
  await fs.writeFile(path.join(PROJECT, 'scenes/source.html'), V1);
  await fs.writeFile(path.join(PROJECT, 'assets/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

after(async () => {
  await save();
});

test('S5-A1 另存模板：复制源、记相对路径+源哈希；重名不覆盖（拒绝 / 加后缀）', async () => {
  const first = await lib.saveAsTemplate(PROJECT, {
    name: 'badge',
    from: 'scenes/source.html',
    params: SCHEMA,
    now: '2026-11-07T00:00:00.000Z'
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.entry.sourcePath, 'scenes/badge.html');
  assert.equal(first.entry.sourceHash, lib.sha256(V1));
  assert.equal(first.entry.version, 1);
  assert.equal(await sha(path.join(PROJECT, 'scenes/badge.html')), lib.sha256(V1));
  assert.deepEqual(
    first.entry.assets.map((a) => a.ref),
    ['assets/logo.png']
  );

  // 改了源再存同名：拒绝，且已存在的模板纹丝不动
  const changed = V1.replace('默认标题', '改过的标题');
  await fs.writeFile(path.join(PROJECT, 'scenes/source.html'), changed);
  const beforeHash = await sha(path.join(PROJECT, 'scenes/badge.html'));
  const second = await lib.saveAsTemplate(PROJECT, { name: 'badge', from: 'scenes/source.html', params: SCHEMA });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'NAME_TAKEN');
  assert.equal(await sha(path.join(PROJECT, 'scenes/badge.html')), beforeHash, '重名不得覆盖');

  const suffixed = await lib.saveAsTemplate(PROJECT, {
    name: 'badge',
    from: 'scenes/source.html',
    params: SCHEMA,
    onConflict: 'suffix'
  });
  assert.equal(suffixed.ok, true, JSON.stringify(suffixed));
  assert.equal(suffixed.entry.sourcePath, 'scenes/badge-2.html');
  assert.notEqual(suffixed.entry.id, first.entry.id);

  evidence.cases['S5-A1'] = {
    ok: true,
    entry: { id: first.entry.id, sourcePath: first.entry.sourcePath, sourceHash: first.entry.sourceHash },
    nameTaken: second.code,
    suffix: suffixed.entry.sourcePath
  };
});

test('S5-A2 插入实例：模板源未被改写，参数进 overrides / data-props', async () => {
  const { library } = await lib.readLibrary(PROJECT);
  const entry = library.entries.find((e) => e.sourcePath === 'scenes/badge.html');
  assert.ok(entry);
  const before = await sha(path.join(PROJECT, entry.sourcePath));

  const inst = await lib.instantiate(PROJECT, library, entry.id, {
    clipId: 'clip-a',
    params: { title: '实例 A', tone: '#ff2d55', pad: 1.4 }
  });
  assert.equal(inst.ok, true, JSON.stringify(inst));
  assert.equal(inst.clip.src, 'scenes/badge.html');
  assert.equal(inst.rootAt, '[data-instance="clip-a"]');
  assert.equal(inst.clip.attrs['data-instance'], 'clip-a');

  const props = JSON.parse(inst.clip.attrs['data-props']);
  assert.deepEqual(props.values, { title: '实例 A', tone: '#ff2d55', pad: 1.4 });
  assert.equal(props.template, entry.id);
  assert.equal(props.version, 1);

  const rootOverride = inst.clip.overrides.find((o) => o.at === '[data-instance="clip-a"]');
  assert.ok(rootOverride, 'root override 必须存在');
  assert.equal(rootOverride.style['--tone'], '#ff2d55');
  assert.equal(rootOverride.style['--pad'], '1.4');
  const textOverride = inst.clip.overrides.find((o) => o.at.includes('.badge-title'));
  assert.equal(textOverride.t, '实例 A');

  assert.equal(await sha(path.join(PROJECT, entry.sourcePath)), before, '实例化不得改模板源');

  evidence.cases['S5-A2'] = { ok: true, overrides: inst.clip.overrides, templateHash: before };
});

test('S5-A4 参数校验：类型错/越界/未知键都报 INVALID_PARAM，且不落盘', async () => {
  const { library, hash } = await lib.readLibrary(PROJECT);
  const entry = library.entries.find((e) => e.sourcePath === 'scenes/badge.html');

  const bad1 = await lib.instantiate(PROJECT, library, entry.id, { clipId: 'clip-bad', params: { pad: '1.4' } });
  assert.equal(bad1.ok, false);
  assert.equal(bad1.code, 'INVALID_PARAM');
  assert.ok(bad1.errors.some((e) => e.key === 'pad' && e.reason === 'TYPE'), JSON.stringify(bad1.errors));

  const bad2 = await lib.instantiate(PROJECT, library, entry.id, { clipId: 'clip-bad', params: { pad: 9 } });
  assert.equal(bad2.code, 'INVALID_PARAM');
  assert.ok(bad2.errors.some((e) => e.key === 'pad' && e.reason === 'ABOVE_MAX'));

  const bad3 = await lib.instantiate(PROJECT, library, entry.id, { clipId: 'clip-bad', params: { nope: 1 } });
  assert.equal(bad3.code, 'INVALID_PARAM');
  assert.ok(bad3.errors.some((e) => e.key === 'nope' && e.reason === 'UNKNOWN_PARAM'));

  const badColor = await lib.instantiate(PROJECT, library, entry.id, { clipId: 'clip-bad', params: { tone: '#12' } });
  assert.equal(badColor.code, 'INVALID_PARAM');
  assert.ok(badColor.errors.some((e) => e.key === 'tone' && e.reason === 'BAD_COLOR'));

  const after = await lib.readLibrary(PROJECT);
  assert.equal(after.hash, hash, '非法参数不得改库文件');

  // schema 自身的问题走 INVALID_SCHEMA，不和值校验混为一谈
  const badSchema = params.validateSchema({ pad: { type: 'number', min: 3, max: 1 } });
  assert.equal(badSchema.ok, false);
  assert.equal(badSchema.code, 'INVALID_SCHEMA');
  assert.ok(badSchema.errors.some((e) => e.reason === 'MIN_ABOVE_MAX'));

  evidence.cases['S5-A4'] = {
    ok: true,
    type: bad1.errors,
    range: bad2.errors,
    unknown: bad3.errors,
    color: badColor.errors,
    schema: badSchema.errors
  };
});

test('S5-A5 模板升级/回退：源哈希变化才可升级，回退把旧字节真的写回去', async () => {
  const before = await lib.readLibrary(PROJECT);
  const entry = before.library.entries.find((e) => e.sourcePath === 'scenes/badge.html');
  const target = path.join(PROJECT, entry.sourcePath);
  const v1Hash = await sha(target);

  // 外部把源改成 v2
  await fs.writeFile(target, V2);
  const changed = await lib.listEntries(PROJECT, before.library);
  const status = changed.find((s) => s.entry.id === entry.id);
  assert.equal(status.status, 'changed');
  assert.equal(status.actualHash, lib.sha256(V2));

  // 没变时升级要被拒
  const noChange = await lib.upgradeTemplate(PROJECT, before.library, entry.id);
  assert.equal(noChange.ok, true, '源已变，应允许升级');
  assert.equal(noChange.version, 2);
  assert.equal(noChange.to, lib.sha256(V2));

  const again = await lib.upgradeTemplate(PROJECT, noChange.library, entry.id);
  assert.equal(again.ok, false);
  assert.equal(again.code, 'NO_CHANGE');

  const rolled = await lib.rollbackTemplate(PROJECT, noChange.library, entry.id);
  assert.equal(rolled.ok, true, JSON.stringify(rolled));
  assert.equal(rolled.version, 1);
  assert.equal(await sha(target), v1Hash, '回退后源字节必须与旧版一致');
  const v1 = await fs.readFile(target, 'utf8');
  assert.match(v1, /data-version="1"/);
  assert.doesNotMatch(v1, /data-version="2"/);

  const twice = await lib.rollbackTemplate(PROJECT, rolled.library, entry.id);
  assert.equal(twice.ok, false);
  assert.equal(twice.code, 'NO_HISTORY');

  evidence.cases['S5-A5'] = {
    ok: true,
    statusBeforeUpgrade: status.status,
    upgradedTo: noChange.to,
    restoredHash: rolled.restoredHash,
    v1Hash,
    twice: twice.code
  };
});

test('S5-A6 依赖缺失：MISSING_ASSET，条目仍列出且标不可用', async () => {
  await fs.writeFile(
    path.join(PROJECT, 'scenes/broken.html'),
    V1.replace('assets/logo.png', 'assets/missing.png')
  );
  const saved = await lib.saveAsTemplate(PROJECT, {
    name: 'broken-tpl',
    from: 'scenes/broken.html',
    params: SCHEMA
  });
  assert.equal(saved.ok, true, JSON.stringify(saved));

  const { library } = await lib.readLibrary(PROJECT);
  const listed = await lib.listEntries(PROJECT, library);
  const broken = listed.find((s) => s.entry.id === saved.entry.id);
  assert.ok(broken, '缺资源的条目仍必须出现在列表里');
  assert.equal(broken.status, 'missing-asset');
  assert.deepEqual(
    broken.missingAssets.map((m) => m.ref),
    ['assets/missing.png']
  );

  const inst = await lib.instantiate(PROJECT, library, saved.entry.id, { clipId: 'clip-broken' });
  assert.equal(inst.ok, false);
  assert.equal(inst.code, 'MISSING_ASSET');
  assert.equal(inst.missing[0].ref, 'assets/missing.png');

  evidence.cases['S5-A6'] = { ok: true, status: broken.status, missing: broken.missingAssets, insert: inst.code };
});

test('S5-A7 库持久化：新进程读磁盘仍是同样的条目', async () => {
  const onDisk = JSON.parse(await fs.readFile(lib.libraryPath(PROJECT), 'utf8'));
  assert.ok(onDisk.entries.length >= 3);

  const script = `
    import { readLibrary } from ${JSON.stringify(new URL('./library.mjs', import.meta.url).href)};
    const { library, exists } = await readLibrary(${JSON.stringify(PROJECT)});
    process.stdout.write(JSON.stringify({ exists, count: library.entries.length, ids: library.entries.map(e => e.id) }));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  const fromChild = JSON.parse(out);
  assert.equal(fromChild.exists, true);
  assert.equal(fromChild.count, onDisk.entries.length);
  assert.deepEqual(fromChild.ids.sort(), onDisk.entries.map((e) => e.id).sort());

  evidence.cases['S5-A7'] = { ok: true, child: fromChild };
});

test('S5-A8 删除模板：被引用时拒绝并列引用者；无人用时只归档不物理删', async () => {
  const { library } = await lib.readLibrary(PROJECT);
  const entry = library.entries.find((e) => e.sourcePath === 'scenes/badge.html');

  const refused = await lib.deleteTemplate(PROJECT, library, entry.id, { referencedBy: ['clip-a', 'clip-c'] });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'TEMPLATE_IN_USE');
  assert.deepEqual(refused.referencedBy, ['clip-a', 'clip-c']);

  const archived = await lib.deleteTemplate(PROJECT, library, entry.id, { referencedBy: [] });
  assert.equal(archived.ok, true);
  assert.equal(archived.archived, true);

  const visible = await lib.listEntries(PROJECT, archived.library);
  assert.equal(visible.some((s) => s.entry.id === entry.id), false, '默认列表不显示归档');
  const all = await lib.listEntries(PROJECT, archived.library, { includeArchived: true });
  assert.equal(all.find((s) => s.entry.id === entry.id).status, 'archived');
  assert.ok(await sha(path.join(PROJECT, entry.sourcePath)), '归档不删源文件');

  const reuse = await lib.instantiate(PROJECT, archived.library, entry.id, { clipId: 'clip-x' });
  assert.equal(reuse.ok, false);
  assert.equal(reuse.code, 'TEMPLATE_ARCHIVED');

  // 复原，后面的用例还要用
  const restored = {
    version: lib.LIBRARY_VERSION,
    entries: archived.library.entries.map((e) => (e.id === entry.id ? { ...e, archived: false } : e))
  };
  await lib.writeLibrary(PROJECT, restored);

  evidence.cases['S5-A8'] = { ok: true, refused: refused.code, archived: archived.archived, visibleAfter: visible.length };
});

test('S5-A9 同一模板 3 个实例：覆盖集合互不污染', async () => {
  const { library } = await lib.readLibrary(PROJECT);
  const entry = library.entries.find((e) => e.sourcePath === 'scenes/badge.html');
  const before = await sha(path.join(PROJECT, entry.sourcePath));

  const specs = [
    { clipId: 'clip-a', params: { title: 'A', tone: '#ff2d55', pad: 1 } },
    { clipId: 'clip-b', params: { title: 'B', tone: '#27c7a8', pad: 2 } },
    { clipId: 'clip-c', params: { title: 'C', tone: '#f5c542', pad: 3 } }
  ];
  const out = [];
  for (const s of specs) {
    const r = await lib.instantiate(PROJECT, library, entry.id, s);
    assert.equal(r.ok, true, JSON.stringify(r));
    out.push(r);
  }

  const serial = out.map((r) => JSON.stringify(r.clip.overrides));
  assert.equal(new Set(serial).size, 3, '三个实例的覆盖集合必须不同');
  for (const [i, r] of out.entries()) {
    const other = out[(i + 1) % 3];
    const mine = JSON.parse(r.clip.attrs['data-props']).values;
    const theirs = JSON.parse(other.clip.attrs['data-props']).values;
    assert.notEqual(mine.tone, theirs.tone);
    assert.equal(mine.title, specs[i].params.title);
    assert.ok(!JSON.stringify(other.clip.overrides).includes(mine.tone), '值不得出现在别的实例里');
  }
  assert.equal(await sha(path.join(PROJECT, entry.sourcePath)), before, '三个实例都不得改模板源');

  evidence.cases['S5-A9'] = {
    ok: true,
    overrides: out.map((r) => r.clip.overrides),
    templateHash: before
  };
});

test('S5-A10 库操作 100 次后仍可解析、无重复 id、重复写字节稳定', async () => {
  const source = await fs.readFile(path.join(PROJECT, 'scenes/source.html'), 'utf8');
  for (let i = 0; i < 100; i++) {
    await fs.writeFile(path.join(PROJECT, `scenes/bulk-${i}.html`), source);
    const r = await lib.saveAsTemplate(PROJECT, { name: `bulk${i}`, from: `scenes/bulk-${i}.html`, params: SCHEMA });
    assert.equal(r.ok, true, `第 ${i} 次：${JSON.stringify(r)}`);
  }
  const { library } = await lib.readLibrary(PROJECT);
  const ids = library.entries.map((e) => e.id);
  assert.equal(ids.length, new Set(ids).size, 'id 必须唯一');
  assert.ok(library.entries.length >= 100, `条目数 ${library.entries.length}`);

  const raw = await fs.readFile(lib.libraryPath(PROJECT), 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw));

  const writes = [];
  for (let i = 0; i < 5; i++) writes.push((await lib.writeLibrary(PROJECT, library)).hash);
  assert.equal(new Set(writes).size, 1, '同一库重复写必须字节一致');

  // 100 次实例化也不该产生重复 id 或改坏库
  const target = library.entries.find((e) => e.sourcePath === 'scenes/badge.html');
  for (let i = 0; i < 100; i++) {
    const r = await lib.instantiate(PROJECT, library, target.id, { clipId: `inst-${i}`, params: { title: `T${i}` } });
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  const after = await lib.readLibrary(PROJECT);
  assert.equal(new Set(after.library.entries.map((e) => e.id)).size, after.library.entries.length);

  evidence.cases['S5-A10'] = {
    ok: true,
    entries: library.entries.length,
    uniqueIds: new Set(ids).size,
    libraryBytes: Buffer.byteLength(raw, 'utf8'),
    stableWriteHash: writes[0]
  };
});
