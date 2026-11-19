/**
 * 全局浏览器槽自测（B-R36-GATE）
 *
 * 这里**不起浏览器**，只验证名额语义：排队、超时、stale 回收、token 归属、
 * 进程退出兜底。真浏览器的清理在 scripts/r36-gate-selftest.mjs 里用真 Host 验。
 *
 * 运行：node --test --test-concurrency=1 packages/scene-runtime/browser-slot.test.mjs
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { acquireBrowserSlot, gateRoot, pidAlive, slotSnapshot } from './browser-slot.mjs';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 每个用例一个独立闸门根，避免互相踩。 */
/** @param {string} name */
async function freshRoot(name) {
  const root = path.join(os.tmpdir(), `opencut-gate-test-${process.pid}-${name}`);
  await fs.rm(root, { recursive: true, force: true });
  process.env.OPENCUT_GATE_ROOT = root;
  process.env.OPENCUT_BROWSER_GATE = '1';
  process.env.OPENCUT_TEST_SLOTS = '1';
  return root;
}

test('G1 闸门关闭时 acquire 返回 null（产品运行零影响）', async () => {
  await freshRoot('off');
  process.env.OPENCUT_BROWSER_GATE = '0';
  const lease = await acquireBrowserSlot('off');
  assert.equal(lease, null);
});

test('G2 开启时拿到唯一槽，release 后归还', async () => {
  const root = await freshRoot('basic');
  const lease = await acquireBrowserSlot('g2');
  assert.ok(lease);
  assert.match(lease.marker, /^--opencut-gate-token=/);
  const held = await slotSnapshot(root);
  assert.equal(held.length, 1);
  assert.equal(held[0].pid, process.pid);
  assert.equal(held[0].alive, true);
  await lease.release();
  assert.deepEqual(await slotSnapshot(root), []);
  // 幂等：再 release 一次不炸
  await lease.release();
});

test('G3 槽被占时排队，超时报 GATE_TIMEOUT（不抢别人的）', async () => {
  const root = await freshRoot('queue');
  const first = await acquireBrowserSlot('g3-first');
  assert.ok(first);
  const startedAt = Date.now();
  await assert.rejects(
    () => acquireBrowserSlot('g3-second', { timeoutMs: 900 }),
    (err) => /** @type {any} */ (err)?.code === 'GATE_TIMEOUT',
  );
  assert.ok(Date.now() - startedAt >= 800, '应该真的等了一会儿');
  // 第一个持有者不受影响
  const held = await slotSnapshot(root);
  assert.equal(held.length, 1);
  assert.equal(held[0].label, 'g3-first');
  await first.release();
  assert.deepEqual(await slotSnapshot(root), []);
});

test('G4 持有者已死 → 下一次取槽回收（不需要等它自己释放）', async () => {
  const root = await freshRoot('stale');
  await fs.mkdir(path.join(root, 'slot-test-0'), { recursive: true });
  const deadPid = 999999;
  assert.equal(pidAlive(deadPid), false);
  await fs.writeFile(
    path.join(root, 'slot-test-0', 'owner.json'),
    JSON.stringify({
      token: 'dead-holder',
      marker: '--opencut-gate-token=dead-holder',
      pid: deadPid,
      label: 'crashed',
      startedAt: new Date().toISOString(),
      beat: new Date().toISOString(),
    }),
  );
  const lease = await acquireBrowserSlot('g4');
  assert.ok(lease, 'stale 槽应该被回收后拿到');
  const held = await slotSnapshot(root);
  assert.equal(held.length, 1);
  assert.equal(held[0].label, 'g4');
  await lease.release();
});

test('G5 活着的持有者不会被抢（哪怕等得久）', async () => {
  const root = await freshRoot('alive');
  const first = await acquireBrowserSlot('g5-first');
  assert.ok(first);
  // 模拟另一个进程反复尝试：只能超时，不能把 first 挤掉
  await assert.rejects(() => acquireBrowserSlot('g5-second', { timeoutMs: 700 }), /等待浏览器槽超时/);
  const held = await slotSnapshot(root);
  assert.equal(held[0].token, first.token);
  await first.release();
});

test('G6 子进程 exit 时同步释放槽（父进程不必替它收）', async () => {
  const root = await freshRoot('exit');
  const snippet = `
    const m = await import(${JSON.stringify(path.join(HERE, 'browser-slot.mjs'))});
    const lease = await m.acquireBrowserSlot('child');
    process.stdout.write('ACQUIRED ' + lease.token + '\\n');
    process.exit(0);
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', snippet], {
    env: { ...process.env, OPENCUT_BROWSER_GATE: '1', OPENCUT_GATE_ROOT: root, OPENCUT_TEST_SLOTS: '1' },
    timeout: 20000,
  });
  assert.match(stdout, /ACQUIRED /);
  const held = await slotSnapshot(root);
  assert.deepEqual(held, [], '子进程退出后槽必须已经归还');
});

test('G7 token 不匹配时 release 不删别人的槽', async () => {
  const root = await freshRoot('token');
  const lease = await acquireBrowserSlot('g7');
  assert.ok(lease);
  // 把 owner 换成一个陌生 token，模拟"槽已经被下一个持有者接管"
  const ownerPath = path.join(root, 'slot-test-0', 'owner.json');
  const owner = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
  await fs.writeFile(ownerPath, JSON.stringify({ ...owner, token: 'someone-else' }));
  await lease.release();
  const held = await slotSnapshot(root);
  assert.equal(held.length, 1, '陌生 token 的槽不能被删');
  assert.equal(held[0].token, 'someone-else');
});
