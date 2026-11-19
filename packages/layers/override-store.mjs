/**
 * 覆盖落盘的 CAS 小实现（副线1 · WP14 测试接缝）
 *
 * 真正的 film.html 写队列归主线（FilmDocIo）；这里只证明客户端这一半：
 * - 哈希就是修订号（sha256 of UTF-8 text）；
 * - 写前核对 expectedHash，不等 → CONFLICT，**不写**；
 * - 同目录临时文件 → fsync → rename，写完回读校验。
 *
 * 文件格式是覆盖条目的 JSON（测试夹具），不是 film.html。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/** @param {string} text */
export function hashText(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * @param {string} file
 * @returns {Promise<{text: string, hash: string}>}
 */
export async function readOverride(file) {
  const text = await fs.readFile(file, 'utf8');
  return { text, hash: hashText(text) };
}

/**
 * @param {string} file
 * @param {string} text
 * @param {string} expectedHash
 * @returns {Promise<{ok: true, hash: string} | {ok: false, code: 'CONFLICT'|'IO', actualHash?: string}>}
 */
export async function writeOverrideCAS(file, text, expectedHash) {
  let current;
  try {
    current = await readOverride(file);
  } catch (err) {
    if (/** @type {any} */ (err).code === 'ENOENT') return { ok: false, code: 'IO' };
    throw err;
  }
  if (current.hash !== expectedHash) {
    return { ok: false, code: 'CONFLICT', actualHash: current.hash };
  }
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(text, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
  const back = await readOverride(file);
  if (back.hash !== hashText(text)) return { ok: false, code: 'IO', actualHash: back.hash };
  return { ok: true, hash: back.hash };
}

/**
 * 初始化一个覆盖文件（测试/证据目录用，不碰用户作品）。
 * @param {string} file
 * @param {unknown} value
 * @returns {Promise<{text: string, hash: string}>}
 */
export async function seedOverride(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const text = JSON.stringify(value, null, 2) + '\n';
  await fs.writeFile(file, text, 'utf8');
  return { text, hash: hashText(text) };
}
