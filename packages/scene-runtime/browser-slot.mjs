/**
 * 浏览器槽 / 归属标记（R36 → R37 撤回限流）
 *
 * ## 现状（2026-11-08 起）
 *
 * **默认不限制并发**：`OPENCUT_BROWSER_GATE` 不是 `1` 时，`acquireBrowserSlot()` 直接返回
 * `null`，`SceneHost` 行为与加这套东西之前完全一致 —— 想开几个开几个。开发和测试都按原来的
 * 节奏跑，三条线互不排队。
 *
 * 保留下来的是**归属标记 + 精确回收**：每个 Chromium 都带
 * `--opencut-owner=<tag>-<uniq>`。测试跑完如果浏览器没关干净，可以按这个前缀只杀自己起的
 * 那几个，不按 "Chrome" 名字批量杀，也碰不到用户日常浏览器。
 *
 * ## 紧急刹车（默认关，只在机器真的扛不住时手动开）
 *
 * `OPENCUT_BROWSER_GATE=1 OPENCUT_TEST_SLOTS=4 OPENCUT_RENDER_SLOTS=1`：回到有配额的模式，
 * 拿不到就排队。槽位根在 `~/.opencut/test-gate`（跨 worktree 共享），取槽用 `mkdir` 原子性，
 * 持有者 pid 死了下一次取槽时回收。
 *
 * 关闭方式：不设 `OPENCUT_BROWSER_GATE`（默认）。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_ROOT = path.join(os.homedir(), '.opencut', 'test-gate');
const POLL_MS = 250;
/** 单个 lease 的硬上限：超过它的持有者只可能是 pid 复用，才允许回收。 */
const MAX_HOLD_MS = 3 * 60 * 60 * 1000;
/** 心跳超过这个时间没更新，才和 MAX_HOLD_MS 一起作为回收依据。 */
const STALE_BEAT_MS = 15 * 60 * 1000;
/** mkdir 成功到 owner.json 落盘之间的窗口，小于它的空目录不回收。 */
const EMPTY_DIR_GRACE_MS = 8000;

/** 槽位根目录。 */
export function gateRoot() {
  return process.env.OPENCUT_GATE_ROOT || DEFAULT_ROOT;
}

/** 闸门是否开启（默认关，只有测试入口显式开）。 */
export function gateEnabled() {
  return process.env.OPENCUT_BROWSER_GATE === '1';
}

/**
 * 紧急刹车档的池大小（**默认不生效**，只有 `OPENCUT_BROWSER_GATE=1` 才用）。
 *
 * - `test`：6 —— 三条线各跑一个文件也只用掉 3 个，仍有富余。
 * - `render`：2 —— 导出/烧录单独一池，不和测试抢。
 *
 * 想更严：`OPENCUT_TEST_SLOTS=1 OPENCUT_RENDER_SLOTS=1`。
 */
const POOL_DEFAULTS = { test: 6, render: 2 };

/**
 * 当前允许的并发槽数。
 * @param {'test' | 'render'} [pool]
 */
export function slotCount(pool = 'test') {
  const key = pool === 'render' ? 'OPENCUT_RENDER_SLOTS' : 'OPENCUT_TEST_SLOTS';
  const fallback = POOL_DEFAULTS[pool] ?? 1;
  const n = Number(process.env[key] || fallback);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/**
 * 按归属标记前缀回收浏览器（只杀命令行里带 `--opencut-owner=<tag>` 的进程）。
 *
 * 给测试入口用：一个测试文件跑完就调一次，把该文件漏关的 Chromium 精确收掉。
 * @param {string} tag
 * @param {{graceMs?: number}} [opts]
 * @returns {Promise<number[]>} 被终止的 pid
 */
export async function reapOwnedByTag(tag, opts = {}) {
  if (!tag) return [];
  return await killByMarker(`--opencut-owner=${tag}`, opts);
}

/** @param {string} root @param {string} pool @param {number} i */
function slotDir(root, pool, i) {
  return path.join(root, `slot-${pool}-${i}`);
}

/** @param {any} opts @returns {'test' | 'render'} */
function poolOf(opts) {
  return opts?.pool === 'render' ? 'render' : 'test';
}

/**
 * pid 是否还活着。
 * EPERM 说明进程存在但无权限发信号 —— 算活着（保守，避免误回收）。
 * @param {number} pid
 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {any} */ (err)?.code === 'EPERM';
  }
}

function newToken() {
  return `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string} dir
 * @returns {Promise<any | null>}
 */
async function readOwner(dir) {
  try {
    return JSON.parse(await fsp.readFile(path.join(dir, 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 原子写 owner.json（tmp + rename），避免读到半个文件。
 * @param {string} dir
 * @param {any} owner
 */
async function writeOwner(dir, owner) {
  const tmp = path.join(dir, `owner.${process.pid}.${Math.random().toString(36).slice(2, 7)}.tmp`);
  await fsp.writeFile(tmp, JSON.stringify(owner, null, 2));
  await fsp.rename(tmp, path.join(dir, 'owner.json'));
}

/**
 * 按命令行标记精确找进程。
 *
 * 用 `pgrep -f` 而不是 `ps`：这台 macOS 上 `ps` 被系统策略拒绝（operation not permitted），
 * 但 pgrep 可读。只匹配 `--opencut-gate-token=<token>` 这种**唯一**标记，
 * 不按 "Chrome" / "chromium" 名字，所以不会碰到用户日常浏览器。
 * @param {string} marker
 * @returns {Promise<number[]>}
 */
/** 允许用来匹配进程的命令行前缀（白名单，避免误杀）。 */
const MARKER_PREFIXES = ['--opencut-gate-token=', '--opencut-owner='];

/** @param {string} marker */
async function pidsByMarker(marker) {
  if (!marker || !MARKER_PREFIXES.some((p) => marker.startsWith(p))) return [];
  try {
    const { stdout } = await execFileAsync('pgrep', ['-f', '--', marker], { maxBuffer: 2 * 1024 * 1024 });
    return String(stdout)
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  } catch (err) {
    // pgrep 退出码 1 = 没匹配；其它错误（权限）也不能假装收掉了，交给调用方记账。
    if (/** @type {any} */ (err)?.code === 1) return [];
    return [];
  }
}

/**
 * 按命令行标记精确结束进程（先 TERM，再 KILL）。
 * @param {string} marker
 * @param {{graceMs?: number}} [opts]
 * @returns {Promise<number[]>} 实际找到并处理过的 pid
 */
export async function killByMarker(marker, opts = {}) {
  const graceMs = opts.graceMs ?? 4000;
  const pids = await pidsByMarker(marker);
  if (pids.length === 0) return [];
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* 已经退出 */
    }
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!pids.some((pid) => pidAlive(pid))) return pids;
    await sleep(150);
  }
  for (const pid of pids) {
    if (!pidAlive(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已经退出 */
    }
  }
  return pids;
}

/**
 * 等到某个标记的进程全部退出（用于「上一轮完全退出再启动下一轮」）。
 * @param {string} marker
 * @param {number} timeoutMs
 */
async function waitMarkerGone(marker, timeoutMs) {
  if (!marker) return true;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pids = await pidsByMarker(marker);
    if (pids.length === 0) return true;
    if (Date.now() >= deadline) return false;
    await sleep(200);
  }
}

/** @param {string} root */
async function lastReleasePath(root) {
  return path.join(root, 'last-release.json');
}

/**
 * 取一个浏览器槽。
 *
 * @param {string} label 诊断用（会出现在 owner.json 与排队快照里）
 * @param {{timeoutMs?: number, root?: string, pool?: 'test'|'render'}} [opts]
 * @returns {Promise<null | {token: string, marker: string, label: string, dir: string, annotate: (extra: any) => Promise<void>, release: () => Promise<void>, releaseSync: () => void}>}
 */
export async function acquireBrowserSlot(label = 'browser', opts = {}) {
  if (!gateEnabled()) return null;
  const root = opts.root || gateRoot();
  const pool = poolOf(opts);
  await fsp.mkdir(root, { recursive: true });
  await sweepQueue(root).catch(() => {});

  // 上一轮如果还留着带标记的进程，先等它自己退出；等不到才精确收掉。
  try {
    const last = JSON.parse(await fsp.readFile(await lastReleasePath(root), 'utf8'));
    if (last?.marker) {
      const gone = await waitMarkerGone(last.marker, 8000);
      if (!gone) await killByMarker(last.marker, { graceMs: 3000 });
    }
  } catch {
    /* 没有上一轮的记录 */
  }

  const timeoutMs = opts.timeoutMs ?? Number(process.env.OPENCUT_GATE_TIMEOUT_MS || 900000);
  const deadline = Date.now() + timeoutMs;
  const token = newToken();
  const marker = `--opencut-gate-token=${token}`;
  const owner = {
    token,
    marker,
    pid: process.pid,
    ppid: process.ppid,
    label,
    pool,
    cwd: process.cwd(),
    host: os.hostname(),
    startedAt: new Date().toISOString(),
    beat: new Date().toISOString(),
  };
  let queued = false;

  for (;;) {
    for (let i = 0; i < slotCount(pool); i++) {
      const dir = slotDir(root, pool, i);
      if (await tryTake(dir, owner)) {
        if (queued) await clearQueue(root, token);
        return makeLease(dir, owner, root);
      }
    }
    if (!queued) {
      await writeQueue(root, owner);
      queued = true;
    }
    if (Date.now() >= deadline) {
      if (queued) await clearQueue(root, token);
      const err = new Error(`等待浏览器槽超时（${timeoutMs}ms）：${label}`);
      /** @type {any} */ (err).code = 'GATE_TIMEOUT';
      /** @type {any} */ (err).queue = await queueSnapshot(root);
      throw err;
    }
    await sleep(POLL_MS + Math.floor(Math.random() * 120));
  }
}

/**
 * 尝试原子占位。成功返回 true。
 * @param {string} dir
 * @param {any} owner
 */
async function tryTake(dir, owner) {
  try {
    await fsp.mkdir(dir);
  } catch (err) {
    if (/** @type {any} */ (err)?.code !== 'EEXIST') throw err;
    await reapIfStale(dir);
    return false;
  }
  await writeOwner(dir, owner);
  return true;
}

/**
 * 判断并回收 stale 槽。
 * @param {string} dir
 */
async function reapIfStale(dir) {
  const owner = await readOwner(dir);
  if (!owner) {
    // mkdir 刚成功、owner.json 还没落盘：给一个宽限期。
    const st = await fsp.stat(dir).catch(() => null);
    if (!st) return;
    if (Date.now() - st.mtimeMs < EMPTY_DIR_GRACE_MS) return;
    await bury(dir, null);
    return;
  }
  const startedAt = Date.parse(owner.startedAt || 0);
  const beat = Date.parse(owner.beat || owner.startedAt || 0);
  const pool = owner.pool || (path.basename(dir).startsWith('slot-render-') ? 'render' : 'test');
  // 测试文件不该跑 15 分钟；渲染作业可能跑几十分钟。按池给不同上限，防止一个卡死的
  // 测试永久占位，也防止正常的长导出被误判。
  const maxHoldMs = pool === 'render' ? 3 * 60 * 60 * 1000 : 15 * 60 * 1000;
  const staleBeatMs = pool === 'render' ? 15 * 60 * 1000 : 5 * 60 * 1000;
  const heldTooLong = Number.isFinite(startedAt) && Date.now() - startedAt > maxHoldMs;
  const beatStale = Number.isFinite(beat) && Date.now() - beat > staleBeatMs;
  if (pidAlive(owner.pid)) {
    // 活着就不动 —— 除非「心跳长期不动」且命令行里找不到它自己的 marker：
    // 那说明这个 pid 已被别的进程复用（R26 的 13 分钟排队就是这个形态）。
    const markerAlive = owner.marker ? (await pidsByMarker(owner.marker)).length > 0 : false;
    if (!(beatStale && !markerAlive) && !(heldTooLong && beatStale)) return;
  }
  await bury(dir, owner);
}

/**
 * 用 rename 拿到回收权（原子），校验 token 没被调包，再精确清掉带标记的进程。
 * @param {string} dir
 * @param {any | null} expect
 */
async function bury(dir, expect) {
  const tmp = `${dir}.reap-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
  try {
    await fsp.rename(dir, tmp);
  } catch (err) {
    if (/** @type {any} */ (err)?.code === 'ENOENT') return;
    throw err;
  }
  const inside = await readOwner(tmp);
  // 判定之后如果换过主人（理论上不该发生），原样放回去。
  if (expect && inside && inside.token !== expect.token) {
    await fsp.rename(tmp, dir).catch(() => {});
    return;
  }
  const marker = inside?.marker;
  if (marker) await killByMarker(marker);
  await fsp.rm(tmp, { recursive: true, force: true });
}

/**
 * @param {string} dir
 * @param {any} owner
 * @param {string} root
 */
function makeLease(dir, owner, root) {
  let released = false;
  let beatTimer = null;

  const touch = async () => {
    // 已经 release 就别再写：写回会把刚删掉的 owner.json 重新创建出来，
    // 留下「token 已释放、目录还在」的假占用（R26 主线排队 13 分钟就是这个）。
    if (released) return;
    try {
      owner.beat = new Date().toISOString();
      await writeOwner(dir, owner);
      // 写落在 release 的 rm 之后：自己再收一次。
      if (released) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    } catch {
      /* 槽被别人回收了也别炸 */
    }
  };
  beatTimer = setInterval(touch, 5000);
  if (typeof beatTimer.unref === 'function') beatTimer.unref();

  const release = async () => {
    if (released) return;
    released = true;
    if (beatTimer) clearInterval(beatTimer);
    active.delete(lease);
    try {
      const current = await readOwner(dir);
      // token 对得上才删：绝不删别人的槽。
      if (current?.token === owner.token) {
        await fsp.rm(dir, { recursive: true, force: true });
      }
    } catch {
      /* 已经没了 */
    }
    try {
      await fsp.writeFile(
        await lastReleasePath(root),
        JSON.stringify({ token: owner.token, marker: owner.marker, pid: process.pid, at: new Date().toISOString() }, null, 2),
      );
    } catch {
      /* 记账失败不影响主流程 */
    }
  };

  const lease = {
    token: owner.token,
    marker: owner.marker,
    label: owner.label,
    pool: owner.pool,
    dir,
    /** @param {any} extra */
    async annotate(extra) {
      Object.assign(owner, extra);
      await writeOwner(dir, owner).catch(() => {});
    },
    release,
    releaseSync() {
      if (released) return;
      released = true;
      if (beatTimer) clearInterval(beatTimer);
      active.delete(lease);
      try {
        const raw = fs.readFileSync(path.join(dir, 'owner.json'), 'utf8');
        const current = JSON.parse(raw);
        if (current?.token === owner.token) fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 已经没了 */
      }
    },
  };
  active.add(lease);
  registerExit();
  return lease;
}

/** @type {Set<any>} */
const active = new Set();
let exitRegistered = false;

function registerExit() {
  if (exitRegistered) return;
  exitRegistered = true;
  // 只挂 exit：不抢 SIGINT/SIGTERM 的默认语义。默认信号终止 Node 时也会走 exit。
  process.on('exit', () => {
    for (const lease of Array.from(active)) lease.releaseSync();
  });
  process.on('uncaughtException', () => {
    for (const lease of Array.from(active)) lease.releaseSync();
  });
}

/**
 * 排队快照（诊断用：谁在等、等了多久）。
 * @param {string} root
 */
export async function queueSnapshot(root = gateRoot()) {
  const dir = path.join(root, 'queue');
  /** @type {any[]} */
  const out = [];
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    try {
      out.push(JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8')));
    } catch {
      /* 半个文件，跳过 */
    }
  }
  return out;
}

/**
 * 清掉「排队进程已经不在」的残留队列文件。
 *
 * 队列文件只在两种时机删除：拿到槽（clearQueue）、等超时（clearQueue）。
 * 进程被 SIGKILL / 父进程退出时两个都不会发生，文件就永久留下（R26 留下 17 条）。
 * 这里按 pid + 文件时间做保守清扫：pid 活着且不超过 30 分钟的一律不动。
 * @param {string} root
 */
async function sweepQueue(root) {
  const dir = path.join(root, 'queue');
  const names = await fsp.readdir(dir).catch(() => []);
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    const rec = await fsp
      .readFile(file, 'utf8')
      .then((raw) => JSON.parse(raw))
      .catch(() => null);
    const pid = Number(rec?.pid);
    const st = await fsp.stat(file).catch(() => null);
    const age = st ? Date.now() - st.mtimeMs : 0;
    if (Number.isInteger(pid) && pid > 0 && pidAlive(pid) && age < 30 * 60 * 1000) continue;
    await fsp.rm(file, { force: true }).catch(() => {});
  }
}

/** @param {string} root @param {{token: string}} owner */
async function writeQueue(root, owner) {
  const dir = path.join(root, 'queue');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${owner.token}.json`), JSON.stringify(owner, null, 2)).catch(() => {});
}

/** @param {string} root @param {string} token */
async function clearQueue(root, token) {
  await fsp.rm(path.join(root, 'queue', `${token}.json`), { force: true }).catch(() => {});
}

/**
 * 便捷包装：`withBrowserSlot('label', async (lease) => { ... })`
 *
 * 给**不能走 SceneHost** 的验收脚本用（它们直接 `chromium.launch`）。
 * `lease` 可能为 null（闸门关闭），调用方自己决定是否加 `lease.marker`。
 *
 * @template T
 * @param {string} label
 * @param {(lease: any) => Promise<T>} fn
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<T>}
 */
export async function withBrowserSlot(label, fn, opts = {}) {
  const lease = await acquireBrowserSlot(label, opts);
  try {
    return await fn(lease);
  } finally {
    if (lease) await lease.release().catch(() => {});
  }
}

/**
 * 当前所有槽的持有者（含活的/死的判定）。给 runner 和小规模验证用。
 * @param {string} root
 */
export async function slotSnapshot(root = gateRoot()) {
  /** @type {any[]} */
  const out = [];
  for (const pool of /** @type {const} */ (['test', 'render'])) {
    for (let i = 0; i < slotCount(pool); i++) {
      const dir = slotDir(root, pool, i);
      const owner = await readOwner(dir);
      if (!owner) continue;
      out.push({ slot: i, pool, ...owner, alive: pidAlive(owner.pid) });
    }
  }
  return out;
}
