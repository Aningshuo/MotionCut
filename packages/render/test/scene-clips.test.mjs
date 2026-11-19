/**
 * P27 场景片段：src 解析 / 前置检查 / 失败分级。
 *
 * 这一层只做**静态**判断（不启浏览器），所以单测能覆盖住它；
 * 真导出与同帧对照在 `.local-runs/sub2/runs/R14/evidence/p27-scene-clip.json`。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  SCENE_CAPTURE_FAILED,
  SceneClipError,
  assertSceneClipsReady,
  classifySceneSrc,
  resolveSceneClip,
  splitSceneSrc,
  wrapSceneCaptureError,
} from '../scene-clips.mjs';

/** @returns {Promise<string>} */
async function tempProject() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'opencut-scene-'));
}

test('P27：src 分类——相对路径是工程内文件，http/协议相对是跨源，空是缺 src', () => {
  assert.equal(classifySceneSrc('scene.html#t=0,8'), 'file');
  assert.equal(classifySceneSrc('scenes/a.html'), 'file');
  assert.equal(classifySceneSrc('/abs/scene.html'), 'absolute-file');
  assert.equal(classifySceneSrc('https://example.com/a.html#t=0,4'), 'cross-origin');
  assert.equal(classifySceneSrc('//cdn.example.com/a.html'), 'cross-origin');
  assert.equal(classifySceneSrc('   '), 'empty');
  assert.deepEqual(splitSceneSrc('scene.html#t=0,8'), { pathname: 'scene.html', hash: 't=0,8' });
  assert.deepEqual(splitSceneSrc('scene.html'), { pathname: 'scene.html', hash: '' });
});

test('P27：相对路径解析到工程根内（#t= 不参与路径）', () => {
  const clip = { id: 'scene-a', src: 'scenes/a.html#t=0,8' };
  const resolved = resolveSceneClip(clip, { projectRoot: '/tmp/proj' });
  assert.equal(resolved.path, '/tmp/proj/scenes/a.html');
  assert.equal(resolved.relative, 'scenes/a.html');
  assert.equal(resolved.clipId, 'scene-a');
});

test('P27：跨源 / 越界 / 空 src 都是 SCENE_CAPTURE_FAILED，且带 reason', () => {
  const cases = [
    [{ id: 'x', src: 'https://example.com/a.html#t=0,4' }, 'cross-origin'],
    [{ id: 'x', src: '../../etc/passwd' }, 'outside-project'],
    [{ id: 'x', src: '   ' }, 'missing-src'],
  ];
  for (const [clip, reason] of /** @type {Array<[any, string]>} */ (cases)) {
    assert.throws(
      () => resolveSceneClip(clip, { projectRoot: '/tmp/proj' }),
      (/** @type {any} */ err) => err instanceof SceneClipError && err.code === SCENE_CAPTURE_FAILED && err.reason === reason,
      `reason ${reason}`,
    );
  }
});

test('P27：前置检查——文件在就通过；缺文件/不是文件都报 SCENE_CAPTURE_FAILED', async () => {
  const root = await tempProject();
  await fs.writeFile(path.join(root, 'ok.html'), '<!doctype html>');
  await fs.mkdir(path.join(root, 'dir.html'));
  // 计划里的 `time` 是 film-plan 从 `#t=` 解出来的（这里直接给，模拟计划的样子）
  const plan = { sceneClips: [{ id: 'ok', src: 'ok.html#t=0,8', time: [0, 8], requiresStage: true }] };
  const ready = await assertSceneClipsReady(plan, { projectRoot: root });
  assert.deepEqual(ready.clips.map((clip) => clip.clipId), ['ok']);
  assert.deepEqual(ready.clips[0]?.time, [0, 8]);

  await assert.rejects(
    assertSceneClipsReady({ sceneClips: [{ id: 'gone', src: 'gone.html#t=0,8' }] }, { projectRoot: root }),
    (/** @type {any} */ err) => err.code === SCENE_CAPTURE_FAILED && err.reason === 'missing-file' && err.clipId === 'gone',
  );
  await assert.rejects(
    assertSceneClipsReady({ sceneClips: [{ id: 'dir', src: 'dir.html#t=0,8' }] }, { projectRoot: root }),
    (/** @type {any} */ err) => err.code === SCENE_CAPTURE_FAILED && err.reason === 'not-a-file',
  );
});

test('P27：舞台取帧的失败收口成 SCENE_CAPTURE_FAILED，原码留在 causeCode', () => {
  const wrapped = wrapSceneCaptureError(
    Object.assign(new Error('NO_FILM: clip scene-a has no window.film'), { code: 'NO_FILM', clipId: 'scene-a', t: 2.5 }),
    { clipIds: ['scene-a'] },
  );
  assert.equal(wrapped.code, SCENE_CAPTURE_FAILED);
  assert.equal(wrapped.causeCode, 'NO_FILM');
  assert.equal(wrapped.clipId, 'scene-a');
  assert.equal(wrapped.t, 2.5);
  assert.match(wrapped.message, /scene-a/, '文案里要能看出是哪个片段');

  // 超时同样收口
  assert.equal(
    wrapSceneCaptureError(Object.assign(new Error('x'), { code: 'FRAME_TIMEOUT' }), { clipIds: ['a'] }).causeCode,
    'FRAME_TIMEOUT',
  );
  // 取消不收口：它是用户的意图，不是场景画不出来
  const cancelled = Object.assign(new Error('cancelled'), { code: 'CAPTURE_CANCELLED' });
  assert.equal(wrapSceneCaptureError(cancelled, { clipIds: ['a'] }), cancelled);
  // 不是取帧错误就原样返回
  const other = new Error('boom');
  assert.equal(wrapSceneCaptureError(other, { clipIds: ['a'] }), other);
});
