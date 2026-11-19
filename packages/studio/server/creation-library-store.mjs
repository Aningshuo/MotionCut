// @ts-nocheck -- Runtime file boundaries and atomic storage are covered by domain tests.
/** Creation-library storage. Source files are never renamed/deleted by metadata actions. */
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class LibraryError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export function relativeSource(value) {
  if (typeof value !== 'string' || !value || value.length > 2000 || value.includes('\\') || value.includes('\0') || path.posix.isAbsolute(value)) throw new LibraryError('PATH_ESCAPE', '需要工程内的相对路径');
  const parts = value.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || p.startsWith('.') || p === 'node_modules') || /^[a-z][\w+.-]*:/i.test(value)) throw new LibraryError('PATH_ESCAPE', '路径不能越界或指向隐藏文件');
  return value;
}
export const sourcePart = (src) => relativeSource(String(src ?? '').split(/[?#]/)[0]);
export async function safePath(root, rel, { missing = false, directory = false } = {}) {
  relativeSource(rel);
  const base = await fs.realpath(root);
  let current = base;
  for (const part of rel.split('/')) {
    current = path.join(current, part);
    let stat;
    try { stat = await fs.lstat(current); } catch (error) {
      if (missing && error.code === 'ENOENT') continue;
      if (error.code === 'ENOENT') throw new LibraryError('SOURCE_MISSING', `文件不存在：${rel}`, 404);
      throw error;
    }
    if (stat.isSymbolicLink()) throw new LibraryError('PATH_ESCAPE', '资源不能经过符号链接');
  }
  if (directory && !(await fs.stat(current)).isDirectory()) throw new LibraryError('INVALID_SOURCE', '需要文件夹');
  return current;
}
export async function ensureRoot(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new LibraryError('LIBRARY_ROOT_REQUIRED', '需要独立的本地素材库目录');
  await fs.mkdir(root, { recursive: true });
  if ((await fs.lstat(root)).isSymbolicLink()) throw new LibraryError('PATH_ESCAPE', '素材库不能是符号链接');
  return fs.realpath(root);
}
const stateDefault = () => ({ version: 1, favorites: [], folders: [], metadata: {}, excluded: {}, saved: [], skills: [], receipts: {} });
export async function readState(root) {
  await ensureRoot(root);
  const file = await safePath(root, 'state.json', { missing: true });
  let value;
  try { value = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return stateDefault(); throw new LibraryError('LIBRARY_STATE_INVALID', '素材库索引无法读取，请保留文件并检查', 500); }
  if (!value || value.version !== 1 || !Array.isArray(value.saved)) throw new LibraryError('LIBRARY_STATE_INVALID', '素材库索引格式不兼容', 500);
  return { ...stateDefault(), ...value };
}
const stateQueues = new Map();
export async function updateState(root, fn) {
  const key = await ensureRoot(root);
  const before = stateQueues.get(key) ?? Promise.resolve();
  const run = before.catch(() => {}).then(async () => {
    const state = await readState(root);
    const result = await fn(state);
    const temporary = path.join(key, `state-${randomUUID()}.tmp`);
    try { await fs.writeFile(temporary, JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 }); await safePath(key, 'state.json', { missing: true }); await fs.rename(temporary, path.join(key, 'state.json')); }
    finally { await fs.rm(temporary, { force: true }); }
    return result;
  });
  stateQueues.set(key, run);
  try { return await run; } finally { if (stateQueues.get(key) === run) stateQueues.delete(key); }
}

/** Static local dependency closure; no scripts are executed and no URLs fetched. */
export async function sourceClosure(root, initial) {
  const pending = [relativeSource(initial)], visited = new Set(), files = [];
  let bytes = 0;
  while (pending.length) {
    const rel = pending.shift();
    if (visited.has(rel)) continue;
    if (visited.size >= 256) throw new LibraryError('BUNDLE_TOO_LARGE', '单个素材依赖超过256个文件');
    visited.add(rel);
    const file = await safePath(root, rel);
    const st = await fs.stat(file);
    if (!st.isFile()) throw new LibraryError('INVALID_SOURCE', `不是文件：${rel}`);
    bytes += st.size;
    if (bytes > 256 * 1024 * 1024) throw new LibraryError('BUNDLE_TOO_LARGE', '单个素材包超过256MB');
    const data = await fs.readFile(file);
    files.push({ rel, data, hash: digest(data) });
    if (!/\.(?:html?|css|m?js|svg)$/i.test(rel)) continue;
    const text = data.toString('utf8');
    const refs = [...text.matchAll(/(?:src|href|poster)\s*=\s*["']([^"']+)["']|url\(\s*["']?([^\s)'";]+)["']?\s*\)|(?:import\s*(?:\(|[^;]*?\sfrom\s*)?|export\s+[^;]*?\sfrom\s*|fetch\s*\(|new\s+URL\s*\()\s*["']([^"']+)["']/g)].map((m) => m[1] ?? m[2] ?? m[3]);
    for (const match of text.matchAll(/srcset\s*=\s*["']([^"']+)["']/g)) for (const candidate of match[1].replace(/data:[^\s]+(?:\s+[\d.]+[wx])?/gi, '').split(',')) { const ref = candidate.trim().split(/\s+/)[0]; if (ref) refs.push(ref); }
    for (let ref of refs) {
      if (/^(?:#|data:|https?:|blob:|mailto:|about:)/i.test(ref)) continue;
      try { ref = decodeURIComponent(ref.split(/[?#]/)[0]); } catch { throw new LibraryError('PATH_ESCAPE', '依赖路径编码无效'); }
      if (!ref) continue;
      if (ref.startsWith('/') || ref.includes('\\') || /^[a-z][\w+.-]*:/i.test(ref)) throw new LibraryError('PATH_ESCAPE', `依赖不能使用绝对路径：${ref}`);
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), ref));
      relativeSource(resolved);
      pending.push(resolved);
    }
  }
  return files;
}
/** Staged immutable copy. Only a newly-created destination is removed on failed staging. */
export async function copySourceBundle(sourceRoot, source, targetRoot, destination) {
  const files = await sourceClosure(sourceRoot, source);
  await ensureRoot(targetRoot);
  const dest = await safePath(targetRoot, destination, { missing: true });
  const staging = `${dest}-pending-${randomUUID()}`;
  try {
    await fs.mkdir(staging, { recursive: true });
    for (const file of files) { const out = path.join(staging, file.rel); await fs.mkdir(path.dirname(out), { recursive: true }); await fs.writeFile(out, file.data, { flag: 'wx' }); }
    await fs.writeFile(path.join(staging, 'bundle-manifest.json'), JSON.stringify({ version: 1, source, files: files.map(({ rel, hash }) => ({ path: rel, hash })) }));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    try { await fs.rename(staging, dest); } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) {
        // Some approved host-operation brokers lose ENOTEMPTY's errno. This
        // exact collision may enter verification, never bypass it or replace dest.
        if (error.code !== 'EIO' || error.message !== 'Directory not empty (os error 66)' || error.__codebuddyBrokerHostOperationError !== true) throw error;
        try { await safePath(targetRoot, destination, { directory: true }); }
        catch (problem) { if (problem.code === 'PATH_ESCAPE') throw problem; throw error; }
      }
      try {
        const prior = JSON.parse(await fs.readFile(await safePath(targetRoot, `${destination}/bundle-manifest.json`), 'utf8'));
        if (prior.version !== 1 || prior.source !== source || JSON.stringify(prior.files) !== JSON.stringify(files.map(({ rel, hash }) => ({ path: rel, hash })))) throw new LibraryError('INSTANCE_EXISTS', '实例目录已存在且内容不同', 409);
        // A manifest records the original copy; people and Agents may have
        // edited the instance since. Verify actual bytes before reusing it.
        for (const expected of files) {
          const existing = await safePath(targetRoot, `${destination}/${expected.rel}`);
          const info = await fs.stat(existing);
          if (!info.isFile() || info.size !== expected.data.length) throw new LibraryError('INSTANCE_EXISTS', '实例文件已修改或缺失，保留现有内容', 409);
          const hash = createHash('sha256');
          for await (const chunk of createReadStream(existing)) hash.update(chunk);
          if (hash.digest('hex') !== expected.hash) throw new LibraryError('INSTANCE_EXISTS', '实例文件已修改，保留现有内容', 409);
        }
      } catch (problem) {
        if (problem.code === 'PATH_ESCAPE' || problem.code === 'INSTANCE_EXISTS') throw problem;
        throw new LibraryError('INSTANCE_EXISTS', '实例目录已存在但无法完整核验，保留现有内容', 409);
      }
    }
    return { src: `${destination}/${source}`, files: files.map(({ rel }) => `${destination}/${rel}`), version: digest(files.map(({ rel, hash }) => `${rel}:${hash}`).join('\n')) };
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}
async function verifyExistingScene(root, destination, files) {
  for (const [name, contents] of files) {
    const file = await safePath(root, `${destination}/${name}`);
    const info = await fs.stat(file);
    const expected = Buffer.from(contents);
    if (!info.isFile() || info.size !== expected.length || !(await fs.readFile(file)).equals(expected)) {
      throw new LibraryError('INSTANCE_EXISTS', '实例目录已存在且内容不同', 409);
    }
  }
}

export async function writeSceneBundle(root, destination, scene) {
  await ensureRoot(root);
  const files = Object.entries(scene);
  for (const [name] of files) relativeSource(name);
  const dest = await safePath(root, destination, { missing: true });
  let existing;
  try { existing = await fs.lstat(dest); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) {
    await safePath(root, destination, { directory: true });
    await verifyExistingScene(root, destination, files);
    return `${destination}/scene.html`;
  }

  const temporary = `${dest}-pending-${randomUUID()}`;
  let stagingCreated = false;
  try {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.mkdir(temporary);
    stagingCreated = true;
    for (const [name, content] of files) {
      const out = path.join(temporary, name);
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, content, { flag: 'wx' });
    }
    try {
      await fs.rename(temporary, dest);
      stagingCreated = false;
    } catch (error) {
      const collision = ['EEXIST', 'ENOTEMPTY'].includes(error.code) ||
        (error.code === 'EIO' && error.message === 'Directory not empty (os error 66)' && error.__codebuddyBrokerHostOperationError === true);
      if (!collision) throw error;
      try { await safePath(root, destination, { directory: true }); }
      catch (problem) { if (problem.code === 'PATH_ESCAPE') throw problem; throw error; }
      await verifyExistingScene(root, destination, files);
    }
    return `${destination}/scene.html`;
  } finally {
    if (stagingCreated) await fs.rm(temporary, { recursive: true, force: true });
  }
}
