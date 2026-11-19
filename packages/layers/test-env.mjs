/**
 * 测试用的运行环境解析（S48 · B-SUB1-R24-024）
 *
 * ## 为什么要有它（R26-C1）
 *
 * `packages/layers/*.test.mjs` 里有三十多个文件把 `<repo>/.local-runs/sub1/runs/R12/env.json`
 * 这样的路径**写死**在模块顶层。分支里没有那些目录（它们是本地的、不入库的），
 * 于是 `node --test packages/layers/*.test.mjs` 在集成树里报 **163 条 hookFailed** ——
 * 不是测试失败，是测试**不可移植**：每次审计都得先手工补十几个 env.json 才看得见真结果。
 *
 * ## 规则
 *
 * 1. `OPENCUT_ENV_JSON` 有值 → **完全沿用**（派工环境、验收脚本仍按原路径写证据）；
 * 2. 否则用 `<repo>/.local-runs/layers/<suite>/env.json`；
 * 3. 文件不存在就建：端口用 `net.createServer().listen(0)` 取空闲端口（**不写死 5937x**，
 *    避免并行/多分支互相抢端口），目录只建一次（幂等）；
 * 4. 存在就复用（第二次跑不会重新分配端口，证据也留在同一处）。
 *
 * `suite` 用测试文件名去掉 `.test.mjs`（如 `subtitle-overlay`），每个 suite 一个目录，
 * 互不覆盖；`.local-runs/` 本来就在 `.gitignore` 里。
 */

import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓根（本文件在 `packages/layers/`，往上两级）。 */
export const TEST_ENV_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 默认根目录：`<repo>/.local-runs/layers`。 */
export const LAYERS_RUNS_ROOT = path.join(TEST_ENV_REPO_ROOT, '.local-runs', 'layers');

/**
 * 取一个空闲端口。
 *
 * `listen(0)` 让内核分配，读回实际端口再关掉。中间那句 `unref()` 是为了「就算忘记关，
 * 进程也能退出」——测试进程卡住比端口冲突更难查。
 *
 * @returns {Promise<number>}
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error('listen(0) 没有拿到端口'));
      });
    });
  });
}

/**
 * 兄弟 suite 已经占用的端口（同一个 `.local-runs/layers` 下）。
 *
 * 单个进程内先分配、后写盘，理论上两个文件仍可能拿到同一个刚释放的端口；
 * 先把邻居用过的排掉，能挡掉绝大多数撞车（并行跑 `--test-concurrency=N` 时也是）。
 *
 * @param {string} root
 * @returns {Promise<Set<number>>}
 */
async function siblingPorts(root) {
  /** @type {Set<number>} */
  const used = new Set();
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return used;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = await fs.readFile(path.join(root, entry.name, 'env.json'), 'utf8');
      const env = JSON.parse(raw);
      for (const key of ['studioPort', 'sceneOrigin', 'vitePort', 'cdpPort']) {
        const value = Number(env?.[key]);
        if (Number.isFinite(value) && value > 0) used.add(value);
      }
    } catch {
      /* 没有/读不动就跳过 */
    }
  }
  return used;
}

/**
 * 解析（必要时创建）一个 suite 的测试环境。
 *
 * @param {{suite: string, batchId?: string, title?: string}} meta
 *   `suite` 决定目录名；`batchId` 只写进 env 便于排障。
 * @param {{envPath?: string, runsRoot?: string}} [options]
 * @returns {Promise<{envPath: string, runRoot: string, evidenceDir: string, tmpRoot: string, env: any, created: boolean}>}
 */
export async function resolveLayerTestEnv(meta, options = {}) {
  const suite = String(meta?.suite ?? '').trim();
  if (suite === '') throw new Error('resolveLayerTestEnv 需要 meta.suite（测试文件名去掉 .test.mjs）');

  const fromEnvVar = typeof process.env.OPENCUT_ENV_JSON === 'string' && process.env.OPENCUT_ENV_JSON !== ''
    ? process.env.OPENCUT_ENV_JSON
    : null;
  const envPath = path.resolve(fromEnvVar ?? options.envPath ?? path.join(options.runsRoot ?? LAYERS_RUNS_ROOT, suite, 'env.json'));
  const runRoot = path.dirname(envPath);
  const evidenceDir = path.join(runRoot, 'evidence');
  const tmpRoot = path.join(runRoot, 'tmp');

  /** @type {{env: any, created: boolean}} */
  let loaded;
  try {
    loaded = { env: JSON.parse(await fs.readFile(envPath, 'utf8')), created: false };
  } catch (error) {
    const code = /** @type {{code?: string}} */ (error)?.code;
    if (code !== 'ENOENT') throw error;
    const avoid = await siblingPorts(path.dirname(envPath));
    /** @type {number[]} */
    const ports = [];
    while (ports.length < 4) {
      const port = await freePort();
      if (avoid.has(port) || ports.includes(port)) continue;
      ports.push(port);
    }
    const env = {
      suite,
      batchId: meta?.batchId ?? null,
      owner: 'layers-test',
      sceneOrigin: ports[0],
      studioPort: ports[1],
      vitePort: ports[2],
      cdpPort: ports[3],
      boundTo: '127.0.0.1',
      evidenceRoot: evidenceDir,
      tmpRoot,
      note: '由 packages/layers/test-env.mjs 自动创建（S48）：端口来自 listen(0)，不写死；删掉本目录会重新分配'
    };
    await fs.mkdir(runRoot, { recursive: true });
    /* 先写临时文件再 rename：两个进程同时创建同一个 suite 时不会读到半截 JSON */
    const staging = `${envPath}.${process.pid}.tmp`;
    await fs.writeFile(staging, JSON.stringify(env, null, 2) + '\n', 'utf8');
    await fs.rename(staging, envPath);
    loaded = { env, created: true };
  }

  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.mkdir(tmpRoot, { recursive: true });

  return { envPath, runRoot, evidenceDir, tmpRoot, env: loaded.env, created: loaded.created };
}
