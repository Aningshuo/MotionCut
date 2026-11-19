/**
 * 「我的模型 Key」的存储（B-SUB1-R31-054 · DECISION-R50-CLOSING 第 2 条）。
 *
 * ## 口径
 *
 * 用户决定：**一人一份、可改可清**，不做统一 key。所以这把 key 属于「这台机器上的这个人」，
 * 与 `settings.json` 同级（`$OPENCUT_SETTINGS` 被覆盖时跟着走）：
 *
 *   `<settings 目录>/keys/model.enc`   密文（AES-256-GCM）
 *   `<settings 目录>/keys/.vault-key`  本机主密钥，0600（只在本机，不进仓）
 *
 * 没有新建「第二套配置存储」：密钥本身交给仓库里已有的 `packages/providers/keys.mjs`
 * （BYOK key store，负责 0600、原子写、`describe()` 只回非敏感元数据），这里补的只是
 * 「没有 Electron safeStorage 时也要落密文」这一层——`createKeyStore` 的
 * `safeStorage` 形参本来就是给这种注入留的口子。
 *
 * ## 为什么不用明文
 *
 * `settings.json` 是用户会打开、会贴进工单的文本文件。key 一旦明文躺在里面，
 * 「日志/证据只许出现尾 4 位」这条纪律在第一步就破了。所以：**配置面不存 key**，
 * 存 key 的地方只有 `.enc`；设置里显示的状态（`已配置 sk-****1234`）是解出来现算的尾 4 位。
 *
 * ## 脱敏
 *
 * 本模块**不返回** key 原文给任何调用方（除了 `readKey()`，它只给请求链路用）。
 * `status()` 只回 `{configured, tail, updatedAt, backend}`；错误消息不拼 key。
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { createKeyStore } from '../../providers/keys.mjs';
import { readSettingsSync, settingsPath } from './settings-store.mjs';

/** key store 里的名字（不是给人看的）。 */
export const MODEL_KEY_NAME = 'model';
/** 与 `packages/providers/keys.mjs` 的下限一致；比它更短的不是 key，是误触。 */
export const MODEL_KEY_MIN_LENGTH = 8;
/** 上限只防「把一整份文件粘进来」；正常 key 远小于它。 */
export const MODEL_KEY_MAX_LENGTH = 4096;

export const MODEL_KEY_ERRORS = Object.freeze({
  EMPTY: 'KEY_EMPTY',
  TOO_SHORT: 'KEY_TOO_SHORT',
  TOO_LONG: 'KEY_TOO_LONG',
  INVALID: 'KEY_INVALID',
  WRITE_FAILED: 'KEY_WRITE_FAILED',
  READ_FAILED: 'KEY_READ_FAILED',
});

/** 机器可读错误（路由直接照发 code + message）。 */
export class ModelKeyError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'ModelKeyError';
    this.code = code;
  }
}

/** key 与 settings.json 同级：`$OPENCUT_SETTINGS` 覆盖时自动跟着走。 */
export function modelKeyDir() {
  const override = String(process.env.OPENCUT_MODEL_KEYS_DIR ?? '').trim();
  if (override !== '') return path.resolve(override);
  return path.join(path.dirname(settingsPath()), 'keys');
}

/**
 * 本机 AES-256-GCM 外壳：形状与 Electron `safeStorage` 一致，`createKeyStore` 直接能用。
 *
 * 主密钥 32 字节，`<dir>/.vault-key`（0600）。**文件已存在但读不出 32 字节时不重生成**——
 * 悄悄换一把会让原有 `.enc` 永远解不开，那是数据丢失，不是「自愈」。
 *
 * @param {string} dir
 */
async function openLocalVault(dir) {
  const file = path.join(dir, '.vault-key');
  /** @param {string} text */
  const parse = (text) => {
    const buffer = Buffer.from(String(text).trim(), 'base64');
    if (buffer.length !== 32) {
      throw new ModelKeyError(MODEL_KEY_ERRORS.READ_FAILED, '本机密钥文件损坏（.vault-key 不是 32 字节）');
    }
    return buffer;
  };
  /** @type {Buffer} */
  let master;
  try {
    master = parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== 'ENOENT') {
      if (error instanceof ModelKeyError) throw error;
      throw new ModelKeyError(MODEL_KEY_ERRORS.READ_FAILED, '本机密钥文件不可读');
    }
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const generated = crypto.randomBytes(32);
    try {
      await fs.writeFile(file, `${generated.toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
      master = generated;
    } catch (writeError) {
      if (/** @type {NodeJS.ErrnoException} */ (writeError)?.code !== 'EEXIST') {
        throw new ModelKeyError(MODEL_KEY_ERRORS.WRITE_FAILED, '本机密钥文件写入失败');
      }
      master = parse(await fs.readFile(file, 'utf8'));
    }
  }
  return {
    isEncryptionAvailable: () => true,
    /** @param {string} text */
    encryptString(text) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', master, iv);
      const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    /** @param {Buffer} payload */
    decryptString(payload) {
      const buffer = Buffer.from(payload);
      if (buffer.length < 12 + 16) throw new ModelKeyError(MODEL_KEY_ERRORS.READ_FAILED, '密文长度不合法');
      const iv = buffer.subarray(0, 12);
      const tag = buffer.subarray(12, 28);
      const body = buffer.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', master, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    },
  };
}

/**
 * @typedef {{
 *   configured: boolean, tail: string | null, updatedAt: string | null,
 *   backend: 'local-vault', issue: string | null,
 * }} ModelKeyStatus
 */

/**
 * @param {{ dir?: string }} [options]
 */
export async function createModelKeyStore(options = {}) {
  const dir = path.resolve(options.dir ?? modelKeyDir());
  const vault = await openLocalVault(dir);
  const store = createKeyStore({ dir, safeStorage: vault });

  /** @returns {Promise<ModelKeyStatus>} */
  async function status() {
    /** @type {{ present: boolean, source: string | null, bytes: number } | null} */
    const info = await store.describe(MODEL_KEY_NAME).catch(() => null);
    if (info === null || info.present !== true) {
      return { configured: false, tail: null, updatedAt: null, backend: 'local-vault', issue: null };
    }
    /** @type {string | null} */
    let key = null;
    try {
      key = await store.load(MODEL_KEY_NAME);
    } catch {
      // 解不开：如实报「读取失败」，不冒充「未配置」（否则用户会以为 key 没存上）。
      return { configured: false, tail: null, updatedAt: null, backend: 'local-vault', issue: 'KEY_UNREADABLE' };
    }
    if (key === null) return { configured: false, tail: null, updatedAt: null, backend: 'local-vault', issue: null };
    let updatedAt = null;
    try {
      updatedAt = (await fs.stat(path.join(dir, `${MODEL_KEY_NAME}.enc`))).mtime.toISOString();
    } catch {
      updatedAt = null;
    }
    return { configured: true, tail: key.slice(-4), updatedAt, backend: 'local-vault', issue: null };
  }

  return {
    dir,
    status,

    /**
     * 保存/覆盖。校验先于写盘：空串、纯空白、太短都不许变成「已配置」。
     * @param {unknown} input
     * @returns {Promise<ModelKeyStatus>}
     */
    async save(input) {
      if (typeof input !== 'string') {
        throw new ModelKeyError(MODEL_KEY_ERRORS.INVALID, 'key 必须是字符串');
      }
      const key = input.trim();
      if (key === '') throw new ModelKeyError(MODEL_KEY_ERRORS.EMPTY, 'key 不能为空');
      if (key.length < MODEL_KEY_MIN_LENGTH) {
        throw new ModelKeyError(MODEL_KEY_ERRORS.TOO_SHORT, `key 至少 ${MODEL_KEY_MIN_LENGTH} 个字符`);
      }
      if (key.length > MODEL_KEY_MAX_LENGTH) {
        throw new ModelKeyError(MODEL_KEY_ERRORS.TOO_LONG, `key 不能超过 ${MODEL_KEY_MAX_LENGTH} 个字符`);
      }
      if (/[\r\n\t]/.test(key)) {
        // 换行进 header 会变成头部注入；不允许。
        throw new ModelKeyError(MODEL_KEY_ERRORS.INVALID, 'key 不能包含换行或制表符');
      }
      try {
        await store.save(MODEL_KEY_NAME, key);
      } catch (error) {
        if (error instanceof ModelKeyError) throw error;
        throw new ModelKeyError(MODEL_KEY_ERRORS.WRITE_FAILED, 'key 写入失败（本机存储不可写）');
      }
      return status();
    },

    /** 清除：文件删掉，状态回到未配置。 */
    async clear() {
      try {
        await store.remove(MODEL_KEY_NAME);
      } catch {
        throw new ModelKeyError(MODEL_KEY_ERRORS.WRITE_FAILED, 'key 清除失败（本机存储不可写）');
      }
      return status();
    },

    /**
     * 请求链路用：解出原文。**调用方不许把它写进日志/证据。**
     * @returns {Promise<string | null>}
     */
    async readKey() {
      try {
        return await store.load(MODEL_KEY_NAME);
      } catch {
        return null;
      }
    },
  };
}

/** 进程内单例：每次请求都去读盘没必要，但换 key 后下一次 `readKey()` 必须拿到新的。 */
/** @type {ReturnType<typeof createModelKeyStore> | null} */
let singleton = null;
export function modelKeyStore() {
  let current = singleton;
  if (current === null) {
    current = createModelKeyStore();
    singleton = current;
    // 失败不缓存：下一次还能重试（比如目录权限刚被修好）。
    current.catch(() => {
      if (singleton === current) singleton = null;
    });
  }
  return current;
}

/** 给 provider 的取值函数：每次请求现读，改了 key 立即生效。 */
export async function readModelKey() {
  try {
    return await (await modelKeyStore()).readKey();
  } catch {
    return null;
  }
}

/** 三条 wire 的合法值（与 `packages/providers/client.mjs#WIRES` 的键同源）。 */
export const MODEL_WIRES = Object.freeze(['openai-chat', 'openai-responses', 'anthropic-messages']);

/**
 * 请求端点解析（CS1 · AC11）：**env 显式覆盖 > 设置里的自有模型 > 缺省**。
 *
 * 为什么让设置参与：设置页的三个字段（API 格式 / Base URL / 模型 ID）必须真的有消费者，
 * 否则就是「保存表单」。`/api/settings/model-key/check` 是所有真实请求里最先跑通的一段，
 * 它调这里 —— 于是「设置 → 实际请求」有一条能截图、能回读的链路。
 *
 * 优先级为什么 env 在前：运维/测试用环境变量钉死端点时，不能被用户设置悄悄改走。
 * 真实厂商的 200 回路**本批未验**，证据里只出现本地 stub 的 200。
 *
 * @returns {{baseUrl: string, model: string, wire: string, timeoutMs: number, source: 'env'|'settings'|'default'}}
 */
export function modelEndpoint(env = process.env) {
  const settings = readSettingsSync();
  const byok = settings?.byok ?? {};
  const envBase = String(env.OPENCUT_MODEL_BASE_URL ?? '').trim();
  const envModel = String(env.OPENCUT_MODEL_NAME ?? '').trim();
  const envWire = String(env.OPENCUT_MODEL_WIRE ?? '').trim();
  const setBase = String(byok.baseUrl ?? '').trim();
  const setModel = String(byok.model ?? '').trim();
  const setWire = String(byok.format ?? '').trim();
  const wireFromSettings = MODEL_WIRES.includes(setWire) ? setWire : '';
  const baseUrl = envBase || setBase || 'https://api.openai.com/v1';
  const model = envModel || setModel || 'gpt-4o-mini';
  const wire = envWire || wireFromSettings || 'openai-chat';
  const rawTimeout = Number(env.OPENCUT_MODEL_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 8000;
  const source = envBase !== '' || envModel !== '' || envWire !== '' ? 'env' : baseUrl !== 'https://api.openai.com/v1' || setModel !== '' || wireFromSettings !== '' ? 'settings' : 'default';
  return { baseUrl, model, wire, timeoutMs, source };
}
