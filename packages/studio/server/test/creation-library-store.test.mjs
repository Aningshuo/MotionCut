// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { copySourceBundle, writeSceneBundle } from '../creation-library-store.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-bundle-recovery-'));
  const source = path.join(root, 'source'), target = path.join(root, 'target');
  await fs.mkdir(path.join(source, 'card'), { recursive: true });
  await fs.writeFile(path.join(source, 'card', 'scene.html'), '<html><link rel="stylesheet" href="style.css"><body>editable</body></html>');
  await fs.writeFile(path.join(source, 'card', 'style.css'), '.a{color:#abcdef}');
  const copy = () => copySourceBundle(source, 'card/scene.html', target, 'instance');
  await copy();
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return { root, source, target, copy, css: path.join(target, 'instance', 'card', 'style.css'), manifest: path.join(target, 'instance', 'bundle-manifest.json') };
}
test('existing immutable bundle is reused only when manifest identity and all actual bytes still match', async (t) => {
  const f = await fixture(t), before = await fs.readFile(f.css), info = await fs.stat(f.css);
  const reused = await f.copy(); assert.equal(reused.src, 'instance/card/scene.html'); assert.deepEqual(await fs.readFile(f.css), before); assert.equal((await fs.stat(f.css)).mtimeMs, info.mtimeMs);
  await fs.writeFile(f.css, '.a{color:#123456}');
  await assert.rejects(f.copy(), { code: 'INSTANCE_EXISTS', status: 409 });
  assert.equal(await fs.readFile(f.css, 'utf8'), '.a{color:#123456}', 'a same-size human edit must survive; a stale manifest cannot approve it');
  assert.equal((await fs.readdir(f.target)).some((name) => name.includes('-pending-')), false, 'only our failed pending copy is removed');
});
test('missing dependency or invalid manifest fails closed without replacing the surviving instance', async (t) => {
  const f = await fixture(t); await fs.unlink(f.css);
  await assert.rejects(f.copy(), { code: 'INSTANCE_EXISTS', status: 409 });
  await assert.rejects(fs.stat(f.css), { code: 'ENOENT' });
  const original = await fs.readFile(path.join(f.target, 'instance', 'card', 'scene.html'));
  await fs.writeFile(f.manifest, '{broken-index');
  await assert.rejects(f.copy(), { code: 'INSTANCE_EXISTS', status: 409 });
  assert.deepEqual(await fs.readFile(path.join(f.target, 'instance', 'card', 'scene.html')), original);
});
test('recovery rejects symlink substitution and never reads or overwrites the replacement destination', async (t) => {
  const f = await fixture(t), outside = path.join(f.root, 'outside.css'); await fs.writeFile(outside, '.outside{color:red}');
  await fs.unlink(f.css); await fs.symlink(outside, f.css);
  await assert.rejects(f.copy(), { code: 'PATH_ESCAPE' });
  assert.equal(await fs.readFile(outside, 'utf8'), '.outside{color:red}'); assert.equal((await fs.lstat(f.css)).isSymbolicLink(), true);
});

const brokerNonEmpty = () => Object.assign(new Error('Directory not empty (os error 66)'), { code: 'EIO', syscall: 'rename', __codebuddyBrokerHostOperationError: true });
/** Only this owned staging/destination pair is intercepted; native fs is
 * restored even when an assertion fails. Other destinations keep native fs. */
async function withRenameFailure(t, destination, error, body) {
  const native = fs.rename, expected = path.join(await fs.realpath(path.dirname(destination)), path.basename(destination)); let calls = 0;
  const intercepted = t.mock.method(fs, 'rename', async (from, to) => {
    if (String(to) === expected && String(from).startsWith(`${expected}-pending-`)) { calls++; throw error; }
    return native(from, to);
  });
  try { await body(); assert.ok(calls > 0, 'the actual staging rename must encounter the simulated broker error'); }
  finally { intercepted.mock.restore(); assert.equal(fs.rename, native, 'restore the fs mock before another test or cleanup'); }
}

test('broker EIO/os66 collision reuses only a fully matching immutable copy and leaves bytes/mtime intact', { concurrency: false }, async (t) => {
  const f = await fixture(t), bytes = await fs.readFile(f.css), before = await fs.stat(f.css);
  await withRenameFailure(t, path.join(f.target, 'instance'), brokerNonEmpty(), async () => {
    const result = await f.copy(); assert.equal(result.src, 'instance/card/scene.html');
    assert.deepEqual(await fs.readFile(f.css), bytes); assert.equal((await fs.stat(f.css)).mtimeMs, before.mtimeMs);
  });
  assert.equal((await fs.readdir(f.target)).some(name => name.includes('-pending-')), false);
});

test('broker collision still rejects same-length edits, bad manifests and symlink substitutions without replacing them', { concurrency: false }, async (t) => {
  for (const kind of ['edit', 'manifest', 'symlink']) {
    const f = await fixture(t); let outside;
    if (kind === 'edit') await fs.writeFile(f.css, '.a{color:#123456}');
    else if (kind === 'manifest') await fs.writeFile(f.manifest, '{broken-index');
    else { outside = path.join(f.root, 'outside.css'); await fs.writeFile(outside, '.outside{keep:true}'); await fs.unlink(f.css); await fs.symlink(outside, f.css); }
    const survivingHtml = await fs.readFile(path.join(f.target, 'instance', 'card', 'scene.html'));
    await withRenameFailure(t, path.join(f.target, 'instance'), brokerNonEmpty(), async () => {
      await assert.rejects(f.copy(), { code: kind === 'symlink' ? 'PATH_ESCAPE' : 'INSTANCE_EXISTS' });
    });
    assert.deepEqual(await fs.readFile(path.join(f.target, 'instance', 'card', 'scene.html')), survivingHtml);
    if (kind === 'edit') assert.equal(await fs.readFile(f.css, 'utf8'), '.a{color:#123456}');
    if (kind === 'manifest') assert.equal(await fs.readFile(f.manifest, 'utf8'), '{broken-index');
    if (outside) { assert.equal((await fs.lstat(f.css)).isSymbolicLink(), true); assert.equal(await fs.readFile(outside, 'utf8'), '.outside{keep:true}'); }
    assert.equal((await fs.readdir(f.target)).some(name => name.includes('-pending-')), false);
  }
});

test('nonmatching, prefixed, suffixed or unmarked EIO and non-EIO errors propagate unchanged despite an identical copy', { concurrency: false }, async (t) => {
  const f = await fixture(t), before = await fs.readFile(f.css);
  const marked = message => Object.assign(new Error(message), { code: 'EIO', __codebuddyBrokerHostOperationError: true });
  for (const error of [marked('Input/output error'), marked('Directory not empty (os error 39)'), marked('Broker: Directory not empty (os error 66)'), marked('Directory not empty (os error 66); unrelated I/O failure'), Object.assign(new Error('Directory not empty (os error 66)'), { code: 'EIO' }), Object.assign(new Error('Directory not empty (os error 66)'), { code: 'EACCES', __codebuddyBrokerHostOperationError: true })]) {
    await withRenameFailure(t, path.join(f.target, 'instance'), error, async () => { await assert.rejects(f.copy(), problem => problem === error); });
    assert.deepEqual(await fs.readFile(f.css), before);
  }
  assert.equal((await fs.readdir(f.target)).some(name => name.includes('-pending-')), false);
});

test('cached scenes verify original bytes without staging or invoking bulk cleanup', { concurrency: false }, async (t) => {
  const f = await fixture(t), scene = { 'scene.html': '<main>original-scene</main>', 'scene.css': '.title{color:#abcdef}' };
  const destination = path.join(f.target, 'scene-cache');
  await writeSceneBundle(f.target, 'scene-cache', scene);
  const file = path.join(destination, 'scene.html'), css = path.join(destination, 'scene.css'), stat = await fs.stat(file);
  const rename = t.mock.method(fs, 'rename', async () => { throw new Error('cache hit must not stage'); });
  const rm = t.mock.method(fs, 'rm', async () => { throw new Error('cache hit must not remove files'); });
  try {
    assert.equal(await writeSceneBundle(f.target, 'scene-cache', scene), 'scene-cache/scene.html');
    assert.equal((await fs.stat(file)).mtimeMs, stat.mtimeMs);
    await fs.writeFile(file, '<main>modified-scene</main>');
    await assert.rejects(writeSceneBundle(f.target, 'scene-cache', scene), { code: 'INSTANCE_EXISTS' });
    assert.equal(await fs.readFile(file, 'utf8'), '<main>modified-scene</main>');
    await fs.writeFile(file, scene['scene.html']);
    const outside = path.join(f.root, 'external-scene.css');
    await fs.writeFile(outside, scene['scene.css']);
    await fs.unlink(css);
    await fs.symlink(outside, css);
    await assert.rejects(writeSceneBundle(f.target, 'scene-cache', scene), { code: 'PATH_ESCAPE' });
    assert.equal(await fs.readFile(outside, 'utf8'), scene['scene.css']);
    assert.equal(rename.mock.callCount(), 0);
    assert.equal(rm.mock.callCount(), 0);
  } finally {
    rename.mock.restore();
    rm.mock.restore();
  }
});

test('scene writes verify a competing destination before reusing it', { concurrency: false }, async (t) => {
  const f = await fixture(t), scene = { 'scene.html': '<main>safe</main>' };
  const native = fs.rename;
  const race = t.mock.method(fs, 'rename', async (from, to) => {
    if (path.basename(to) !== 'raced') return native(from, to);
    await fs.mkdir(to);
    await fs.writeFile(path.join(to, 'scene.html'), scene['scene.html']);
    throw brokerNonEmpty();
  });
  try { assert.equal(await writeSceneBundle(f.target, 'raced', scene), 'raced/scene.html'); }
  finally { race.mock.restore(); }
  const absent = brokerNonEmpty();
  await withRenameFailure(t, path.join(f.target, 'absent'), absent, async () => { await assert.rejects(writeSceneBundle(f.target, 'absent', scene), problem => problem === absent); });
  await assert.rejects(fs.stat(path.join(f.target, 'absent')), { code: 'ENOENT' });
  assert.equal((await fs.readdir(f.target)).some(name => name.includes('-pending-')), false);
});
