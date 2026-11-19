/**
 * P14（R7）验收：导出服务从 film.html 取音轨。
 *
 * 真实 HTTP + 真实 RenderQueue + 真实 ffmpeg；工程通过 `createProjectRegistry`
 * 真的打开（不是塞一个假对象）。
 *
 * 覆盖：
 * - A2 `{spec, projectId}` → 产物有音轨、时长与 film 一致、`audio.source === 'film'`
 * - A3 旧的 `{spec, audioMix}` 仍可用（P10 回归）
 * - A4 工程不存在 → `E_PROJECT_NOT_OPEN`，不产生任何文件
 * - 带网页片段的工程 → `E_SCENE_RENDER_REQUIRED`（不悄悄少网页）
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { RenderQueue, hashProject } from '../job.mjs';
import { probeMedia } from '../verify.mjs';
import { createExportsApi } from '../../studio/server/exports.mjs';
import { createProjectRegistry } from '../../studio/server/projects.mjs';

const execFileAsync = promisify(execFile);

/** @type {string} */
let workDir = '';

/**
 * @param {string} dir
 * @param {{ scene?: boolean }} [opts]
 */
async function makeProject(dir, opts = {}) {
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x204060:s=320x180:r=30:d=1',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    path.join(dir, 'assets', 'plate.mp4'),
  ]);
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=1',
    '-ar', '48000', '-ac', '2',
    path.join(dir, 'assets', 'tone.wav'),
  ]);
  const page = opts.scene
    ? '<section><iframe id="card" src="scene.html#t=0,1" at="0"></iframe></section>\n'
    : '';
  if (opts.scene) {
    await fs.writeFile(
      path.join(dir, 'scene.html'),
      '<!doctype html><html><body style="margin:0;background:#f6f4ed"></body></html>',
      'utf8',
    );
  }
  await fs.writeFile(
    path.join(dir, 'film.html'),
    `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=320, height=180"></head><body>
${page}<section><video id="plate" src="assets/plate.mp4#t=0,1" at="0" muted></video></section>
<section><audio id="tone" src="assets/tone.wav#t=0,1" volume="0.5"></audio></section>
</body></html>`,
    'utf8',
  );
}

/**
 * @param {string} framesDir
 */
async function makeFrames(framesDir) {
  await fs.mkdir(framesDir, { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=1',
    '-frames:v', '30', '-vsync', '0',
    path.join(framesDir, 'frame-%05d.png'),
  ]);
}

/**
 * @param {{ project: string, framesDir: string }} opts
 */
async function startApi(opts) {
  const queue = new RenderQueue({
    resolveProject: () => opts.project,
    resolveFrameSource: () => ({
      dir: opts.framesDir,
      pattern: 'frame-%05d.png',
      width: 320,
      height: 180,
      fps: 30,
      durationSec: 1,
    }),
    resolveAudio: () => null,
    preset: 'ultrafast',
  });
  const registry = createProjectRegistry({ hub: { publish: () => 0 } });
  const opened = await registry.open(opts.project);
  assert.ok(opened.ok, opened.ok ? '' : `${opened.code}: ${opened.message}`);
  const api = createExportsApi({ queue, registry, port: 0 });
  const bound = await api.listen({ port: 0 });
  return { url: `http://127.0.0.1:${bound.port}`, close: () => api.close(), queue, projectId: opened.project.projectId };
}

/**
 * @param {string} base
 * @param {any} body
 */
async function post(base, body) {
  const res = await fetch(`${base}/exports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/**
 * @param {string} base
 * @param {string} jobId
 */
async function waitJob(base, jobId) {
  for (let i = 0; i < 400; i += 1) {
    const body = await (await fetch(`${base}/exports/${jobId}`)).json();
    if (body.state === 'done' || body.state === 'failed' || body.state === 'cancelled') return body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`job ${jobId} did not finish`);
}

/**
 * @param {string} jobId
 * @param {string} outputDir
 * @param {string} expectedHash
 */
function specOf(jobId, outputDir, expectedHash) {
  return {
    jobId,
    projectId: 'p14',
    owner: 'SUB2',
    kind: 'video',
    range: [0, 1],
    fps: 30,
    outputDir,
    expectedHash,
  };
}

test.before(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-export-film-'));
});

test.after(async () => {
  if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
});

test('P14-A2 带 projectId：音轨来自 film，产物有声音且时长与 film 一致', async () => {
  const project = path.join(workDir, 'a2-project');
  const framesDir = path.join(workDir, 'a2-frames');
  const outputDir = path.join(workDir, 'a2-out');
  await makeProject(project);
  await makeFrames(framesDir);
  const api = await startApi({ project, framesDir });
  try {
    const posted = await post(api.url, {
      spec: specOf('p14-a2', outputDir, await hashProject(project)),
      projectId: api.projectId,
    });
    assert.equal(posted.status, 202, JSON.stringify(posted.body));
    assert.equal(posted.body.audio.source, 'film');
    assert.equal(posted.body.audio.clips, 1);
    assert.equal(posted.body.plan.durationSec, 1);
    assert.equal(posted.body.plan.frames, 30);

    const done = await waitJob(api.url, 'p14-a2');
    assert.equal(done.state, 'done', JSON.stringify(done));
    assert.equal(done.audio.source, 'film', `progress audio: ${JSON.stringify(done.audio)}`);

    const result = /** @type {any} */ (await api.queue.result('p14-a2'));
    const probe = await probeMedia(result.path);
    assert.ok(probe.audio, 'output must carry an audio stream');
    assert.ok(Math.abs(Number(probe.audio.durationSec) - 1) <= 1 / 30 + 0.001);
    assert.ok(probe.video);
    assert.ok(Math.abs(Number(probe.video.durationSec) - 1) <= 1 / 30 + 0.001);

    const got = await (await fetch(`${api.url}/exports/p14-a2`)).json();
    assert.equal(got.audio.source, 'film');
  } finally {
    await api.close();
  }
});

test('P14-A3 旧的显式 audioMix 仍可用（响应形状不变）', async () => {
  const project = path.join(workDir, 'a3-project');
  const framesDir = path.join(workDir, 'a3-frames');
  const outputDir = path.join(workDir, 'a3-out');
  await makeProject(project);
  await makeFrames(framesDir);
  const api = await startApi({ project, framesDir });
  try {
    const posted = await post(api.url, {
      spec: specOf('p14-a3', outputDir, await hashProject(project)),
      audioMix: { duration: 1, clips: [{ src: path.join(project, 'assets', 'tone.wav'), at: 0, time: [0, 1] }] },
    });
    assert.equal(posted.status, 202, JSON.stringify(posted.body));
    // P10 的响应形状原样保留：显式 audioMix 不带 source（source 只标记 film 推导）
    assert.deepEqual(posted.body.audio, { clips: 1, durationSec: 1 });

    const done = await waitJob(api.url, 'p14-a3');
    assert.equal(done.state, 'done', JSON.stringify(done));
    assert.equal(done.audio.source, undefined);
    const result = /** @type {any} */ (await api.queue.result('p14-a3'));
    const probe = await probeMedia(result.path);
    assert.ok(probe.audio);
  } finally {
    await api.close();
  }
});

test('P14-A4 工程不存在 → E_PROJECT_NOT_OPEN，且不产生任何文件', async () => {
  const project = path.join(workDir, 'a4-project');
  const framesDir = path.join(workDir, 'a4-frames');
  const outputDir = path.join(workDir, 'a4-out');
  await makeProject(project);
  await makeFrames(framesDir);
  const api = await startApi({ project, framesDir });
  try {
    const posted = await post(api.url, {
      spec: specOf('p14-a4', outputDir, await hashProject(project)),
      projectId: 'no-such-project',
    });
    assert.equal(posted.status, 404, JSON.stringify(posted.body));
    assert.equal(posted.body.error, 'E_PROJECT_NOT_OPEN');
    await assert.rejects(fs.readdir(outputDir), /ENOENT/);
  } finally {
    await api.close();
  }
});

test('P14 带网页片段的工程 → E_SCENE_RENDER_REQUIRED（不悄悄少网页）', async () => {
  const project = path.join(workDir, 'scene-project');
  const framesDir = path.join(workDir, 'scene-frames');
  const outputDir = path.join(workDir, 'scene-out');
  await makeProject(project, { scene: true });
  await makeFrames(framesDir);
  const api = await startApi({ project, framesDir });
  try {
    const posted = await post(api.url, {
      spec: specOf('p14-scene', outputDir, await hashProject(project)),
      projectId: api.projectId,
    });
    assert.equal(posted.status, 409, JSON.stringify(posted.body));
    assert.equal(posted.body.error, 'E_SCENE_RENDER_REQUIRED');
    assert.deepEqual(posted.body.scenes, ['card']);
    await assert.rejects(fs.readdir(outputDir), /ENOENT/);
  } finally {
    await api.close();
  }
});

test('P14 projectId 与 audioMix 同时给 → 400，不猜用哪个', async () => {
  const project = path.join(workDir, 'both-project');
  const framesDir = path.join(workDir, 'both-frames');
  await makeProject(project);
  await makeFrames(framesDir);
  const api = await startApi({ project, framesDir });
  try {
    const posted = await post(api.url, {
      spec: specOf('p14-both', path.join(workDir, 'both-out'), await hashProject(project)),
      projectId: api.projectId,
      audioMix: { duration: 1, clips: [{ src: path.join(project, 'assets', 'tone.wav'), at: 0 }] },
    });
    assert.equal(posted.status, 400, JSON.stringify(posted.body));
    assert.equal(posted.body.error, 'CONFLICTING_AUDIO_SOURCE');
  } finally {
    await api.close();
  }
});
