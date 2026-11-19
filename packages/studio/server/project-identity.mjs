import { realpathSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

/** Normalize existing directory aliases while retaining the path of a missing project. @param {string} dir */
export function canonicalProjectDirectory(dir) {
  const absolute = resolve(dir);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Resolve an output path through its closest existing ancestor. A dangling symlink
 * is an existing entry, so it must not be treated as a directory to create.
 * @param {string} filename
 * @returns {Promise<string>}
 */
export async function canonicalOutputPath(filename) {
  const absolute = resolve(filename);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
    const existing = await lstat(absolute).catch((/** @type {NodeJS.ErrnoException} */ cause) => {
      if (cause.code !== 'ENOENT') throw cause;
      return null;
    });
    if (existing !== null || dirname(absolute) === absolute) throw error;
    const parent = await canonicalOutputPath(dirname(absolute));
    return join(parent, basename(absolute));
  }
}
