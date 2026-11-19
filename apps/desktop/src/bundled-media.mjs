import { posix, win32 } from 'node:path';

/**
 * @param {string} resourcesPath
 * @param {NodeJS.Platform} [platform]
 */
export function bundledFfmpegPath(resourcesPath, platform = process.platform) {
  return platform === 'win32'
    ? win32.join(resourcesPath, 'bin', 'ffmpeg.exe')
    : posix.join(resourcesPath, 'bin', 'ffmpeg');
}

/**
 * Make the bundled ffprobe and other tools available to subprocesses.
 * @param {string} ffmpegPath
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} [platform]
 */
export function addFfmpegDirectoryToPath(ffmpegPath, env, platform = process.platform) {
  const windows = platform === 'win32';
  const paths = windows ? win32 : posix;
  const pathKey = windows ? Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'Path' : 'PATH';
  const oldPath = env[pathKey];
  env[pathKey] = oldPath ? [paths.dirname(ffmpegPath), oldPath].join(paths.delimiter) : paths.dirname(ffmpegPath);
}
