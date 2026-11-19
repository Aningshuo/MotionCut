/**
 * BYOK 的 Key 存储（WP19 A6）。
 *
 * 优先级：
 * 1. 宿主给了 `safeStorage`（Electron 的 OS 钥匙串封装）且可用 → 加密后落
 *    `<dir>/<name>.enc`（内容 base64，权限 0600）；
 * 2. 否则 → 明文 `<dir>/<name>.key`，权限**实测** 0600，目录 0700。
 *
 * 不存的：明文 Key 的任何副本、指纹、前缀/后缀、长度以外的元数据。
 * `describe()` 只回 `{present, source, bytes}`——它会被打进日志，所以什么都不能带。
 *
 * 路径写在这里：`<dir>/<name>.key` / `<dir>/<name>.enc`，`dir` 默认
 * `<env.userData>/keys`（由宿主传进来，本包不猜目录）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { ProviderError } from './errors.mjs';

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * @typedef {{ isEncryptionAvailable: () => boolean, encryptString: (s: string) => Buffer, decryptString: (b: Buffer) => string }} SafeStorageLike
 */

/**
 * @param {{ dir: string, safeStorage?: SafeStorageLike | null, mode?: number }} opts
 */
export function createKeyStore(opts) {
  const dir = path.resolve(opts.dir);
  const safeStorage = opts.safeStorage ?? null;
  const fileMode = opts.mode ?? 0o600;

  /**
   * @param {string} name
   * @returns {string}
   */
  function assertName(name) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      throw new ProviderError('INVALID_REQUEST', `invalid key name: ${String(name).slice(0, 40)}`);
    }
    return name;
  }

  const encrypted = () => Boolean(safeStorage?.isEncryptionAvailable?.());

  /**
   * @param {string} name
   * @returns {Promise<string>}
   */
  async function pathOf(name) {
    return path.join(dir, `${assertName(name)}${encrypted() ? '.enc' : '.key'}`);
  }

  return {
    dir,

    /**
     * @param {string} name
     * @param {string} key
     * @returns {Promise<{ name: string, source: 'safeStorage' | 'file', path: string, mode: number, bytes: number }>}
     */
    async save(name, key) {
      assertName(name);
      if (typeof key !== 'string' || key.trim().length < 8) {
        throw new ProviderError('INVALID_REQUEST', 'key must be a string of at least 8 characters');
      }
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const file = await pathOf(name);
      const payload = encrypted()
        ? `${/** @type {SafeStorageLike} */ (safeStorage).encryptString(key).toString('base64')}\n`
        : key;
      await fs.writeFile(file, payload, { mode: fileMode });
      // 已存在的文件不会被 mode 改写入位；显式 chmod 一次，实测才可信
      await fs.chmod(file, fileMode);
      const stat = await fs.stat(file);
      return {
        name,
        source: encrypted() ? 'safeStorage' : 'file',
        path: file,
        mode: stat.mode & 0o777,
        bytes: stat.size,
      };
    },

    /**
     * @param {string} name
     * @returns {Promise<string | null>}
     */
    async load(name) {
      assertName(name);
      for (const suffix of ['.enc', '.key']) {
        const file = path.join(dir, `${name}${suffix}`);
        let text;
        try {
          text = await fs.readFile(file, 'utf8');
        } catch {
          continue;
        }
        if (suffix === '.enc') {
          if (!safeStorage) {
            throw new ProviderError('KEY_MISSING', `key ${name} is encrypted but no safeStorage is available`);
          }
          return safeStorage.decryptString(Buffer.from(text.trim(), 'base64'));
        }
        return text;
      }
      return null;
    },

    /**
     * @param {string} name
     * @returns {Promise<boolean>}
     */
    async has(name) {
      return (await this.load(name)) !== null;
    },

    /**
     * 只回非敏感元数据；这个方法的结果可以安全进日志。
     * @param {string} name
     * @returns {Promise<{ name: string, present: boolean, source: 'safeStorage' | 'file' | null, bytes: number }>}
     */
    async describe(name) {
      assertName(name);
      for (const [suffix, source] of [['.enc', 'safeStorage'], ['.key', 'file']]) {
        try {
          const stat = await fs.stat(path.join(dir, `${name}${suffix}`));
          return { name, present: true, source: /** @type {'safeStorage' | 'file'} */ (source), bytes: stat.size };
        } catch {
          /* 继续找下一个后缀 */
        }
      }
      return { name, present: false, source: null, bytes: 0 };
    },

    /**
     * @param {string} name
     * @returns {Promise<boolean>} 是否真的删掉了
     */
    async remove(name) {
      assertName(name);
      let removed = false;
      for (const suffix of ['.enc', '.key']) {
        try {
          await fs.unlink(path.join(dir, `${name}${suffix}`));
          removed = true;
        } catch {
          /* 不存在就算了 */
        }
      }
      return removed;
    },

    /** 稳定标识（不含 Key）。 */
    get backend() {
      return encrypted() ? 'safeStorage' : 'file-0600';
    },
  };
}

/**
 * 生成一个假 Key 供测试/演示（**不是**真实凭据）。
 * @returns {string}
 */
export function fakeKey() {
  return `sk-test-${crypto.randomBytes(12).toString('hex')}`;
}
