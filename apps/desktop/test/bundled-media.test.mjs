import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addFfmpegDirectoryToPath, bundledFfmpegPath } from '../src/bundled-media.mjs';

test('uses the native packaged FFmpeg executable and resource path', () => {
  assert.equal(
    bundledFfmpegPath(String.raw`C:\Program Files\MotionCut\resources`, 'win32'),
    String.raw`C:\Program Files\MotionCut\resources\bin\ffmpeg.exe`,
  );
  assert.equal(
    bundledFfmpegPath('/Applications/MotionCut.app/Contents/Resources', 'darwin'),
    '/Applications/MotionCut.app/Contents/Resources/bin/ffmpeg',
  );
});

test('prepends the Windows tool directory without adding a conflicting PATH key', () => {
  const env = { Path: String.raw`C:\Windows\System32;C:\Windows` };
  addFfmpegDirectoryToPath(String.raw`C:\Program Files\MotionCut\resources\bin\ffmpeg.exe`, env, 'win32');
  assert.deepEqual(env, {
    Path: String.raw`C:\Program Files\MotionCut\resources\bin;C:\Windows\System32;C:\Windows`,
  });
});

test('keeps the macOS PATH delimiter and supports a clean environment', () => {
  const env = { PATH: '/usr/bin:/bin' };
  addFfmpegDirectoryToPath('/Applications/MotionCut.app/Contents/Resources/bin/ffmpeg', env, 'darwin');
  assert.deepEqual(env, { PATH: '/Applications/MotionCut.app/Contents/Resources/bin:/usr/bin:/bin' });
  /** @type {NodeJS.ProcessEnv} */
  const emptyEnv = {};
  addFfmpegDirectoryToPath('/tmp/resources/bin/ffmpeg', emptyEnv, 'darwin');
  assert.deepEqual(emptyEnv, { PATH: '/tmp/resources/bin' });
});
