/**
 * opId 幂等账本（WP18 A4）。
 *
 * 合同要求"同一 opId 重放返回首次结果，不重复写入"。真正的幂等最终由 main 的
 * 写队列负责（它才握着 CAS 与历史）；但 CLI 是**独立进程**，两次调用之间没有
 * 共享内存，所以这里在 CLI 自己的状态目录留一本账：
 *
 *   <stateDir>/<sha256(projectPath)[0..24]>.json
 *   { "project": "<abs>", "entries": { "<opId>": { "hash": "...", "at": 1699..., "digest": "..." } } }
 *
 * 三条硬规矩：
 * 1. 账本只存 `hash`/`digest`，不存 Op 正文（避免把用户内容抄一份到别处）；
 * 2. 同 opId 但 payload 不同 → `E_OPID_REUSE`，宁可报错也不把 A 的结果当成 B 的；
 * 3. 写账本用 tmp + rename，权限 0600；账本是缓存不是真源，丢了最多多写一次，
 *    由 main 的 CAS 兜底。
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CliError } from './errors.mjs';

/**
 * @param {unknown} value
 * @returns {string}
 */
export function digestOf(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * @param {{ dir: string, now?: () => number }} opts
 */
export function createOpIdLedger(opts) {
  const dir = opts.dir;
  const now = opts.now ?? Date.now;

  /**
   * @param {string} projectPath
   * @returns {Promise<{ file: string, data: { project: string, entries: Record<string, { hash: string, at: number, digest: string }> } }>}
   */
  async function load(projectPath) {
    const name = crypto.createHash('sha256').update(projectPath).digest('hex').slice(0, 24);
    const file = path.join(dir, `${name}.json`);
    try {
      const text = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
        return { file, data: { project: projectPath, entries: parsed.entries } };
      }
    } catch {
      /* 没有账本 / 账本坏了：当作空账本。它是缓存，不是真源。 */
    }
    return { file, data: { project: projectPath, entries: {} } };
  }

  return {
    /**
     * @param {string} projectPath
     * @param {string} opId
     * @returns {Promise<{ hash: string, at: number, digest: string } | null>}
     */
    async lookup(projectPath, opId) {
      const { data } = await load(projectPath);
      const hit = data.entries[opId];
      return hit && typeof hit.hash === 'string' ? hit : null;
    },

    /**
     * @param {string} projectPath
     * @param {string} opId
     * @param {{ hash: string, digest: string }} value
     * @returns {Promise<void>}
     */
    async record(projectPath, opId, value) {
      const { file, data } = await load(projectPath);
      data.entries[opId] = { hash: value.hash, digest: value.digest, at: now() };
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(tmp, file);
    },

    /**
     * 同 opId 但内容不同：明确报错（不静默返回旧结果）。
     * @param {string} projectPath
     * @param {string} opId
     * @param {string} digest
     * @returns {Promise<void>}
     */
    async assertSamePayload(projectPath, opId, digest) {
      const hit = await this.lookup(projectPath, opId);
      if (hit && hit.digest !== digest) {
        throw new CliError(
          'INVALID',
          `opId ${opId} was already used with different ops; refusing to replay a different payload`,
          { opId },
        );
      }
    },
  };
}
