import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';
import { startStudio } from '../studio-server.mjs';

const exec = promisify(execFile);
const source = `<!doctype html><html><head><meta name="viewport" content="width=64, height=64"></head><body>
<section><iframe id="front" src="neighbor.html#t=0,2" at="0"></iframe></section>
<section>
  <iframe id="网页卡片" src="card.html#t=1,1.5" at="0.3" speed="2"></iframe>
  <iframe id="same-lane" src="neighbor.html#t=0,2" at="0"></iframe>
</section>
<section><audio id="other-sound" src="missing.wav#t=0,2"></audio></section>
</body></html>`;

/** @param {string} text */
const sha = (text) => createHash('sha256').update(text).digest('hex');

test('clip export pins one selected web scene, source time and duration without rendering neighbors', { timeout: 90_000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-clip-export-'));
  await fs.mkdir(path.join(dir, '.film'));
  await fs.writeFile(path.join(dir, 'film.html'), source);
  // Actual scene rendering checks source-in is retained. A restart at t=0 is magenta, not green.
  await fs.writeFile(path.join(dir, 'card.html'), `<!doctype html><script>
    window.film = {frame: (t) => {document.body.style.background = t >= 1 ? '#00f000' : '#ff00ff';}};
    </script><body></body>`);
  // Both overlapping unselected scene nodes would throw in the renderer if they mounted.
  await fs.writeFile(path.join(dir, 'neighbor.html'), `<!doctype html><body style="background:red"><script>
    window.film = {frame: () => {throw Error('Unselected scene must not render');}};
    </script></body>`);
  const studio = await startStudio({ port: 0, vitePort: 0, home: path.join(dir, 'home'), projectsRoot: dir });
  try {
    /** @param {string} endpoint @param {any} body */
    const post = (endpoint, body) => fetch(`${studio.url}${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const opened = await post('/api/projects/open', { dir });
    assert.equal(opened.status, 200);
    const { project: { projectId } } = await opened.json();
    const request = { projectId, clipId: '网页卡片', expectedHash: sha(source), fps: 12 };

    const conflict = await post('/api/export', { ...request, expectedHash: 'a'.repeat(64) });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).code, 'CONFLICT');
    const invalid = await post('/api/export', { ...request, range: { start: 0.3, end: 0.55 } });
    assert.equal(invalid.status, 400);
    const unsupported = await post('/api/export', { ...request, clipId: 'other-sound' });
    assert.equal(unsupported.status, 400);
    assert.equal((await unsupported.json()).code, 'CLIP_EXPORT_UNSUPPORTED');
    assert.deepEqual(studio.exportJobs.list(), []);

    const submitted = await post('/api/export', request);
    const accepted = await submitted.json();
    assert.equal(submitted.status, 202, JSON.stringify(accepted));
    assert.equal(accepted.job.clipId, '网页卡片');
    const deadline = Date.now() + 80_000;
    let job = accepted.job;
    while ((job.state === 'running' || job.state === 'queued') && Date.now() < deadline) {
      await wait(125);
      job = (await (await fetch(`${studio.url}${accepted.poll}`)).json()).job;
    }
    assert.equal(job.state, 'done', JSON.stringify(job.error));
    assert.equal(job.frames, 3);
    assert.equal(job.filmHtmlSha256, sha(source));
    assert.equal(await fs.readFile(path.join(dir, 'film.html'), 'utf8'), source);
    const spec = JSON.parse(await fs.readFile(job.specPath, 'utf8'));
    assert.equal(spec.clipId, '网页卡片');
    const { stdout } = await exec('ffmpeg', [
      '-v', 'error', '-i', job.output.path, '-vf', 'scale=2:2', '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ], { encoding: 'buffer' });
    assert.equal(stdout.length, 12);
    for (let i = 0; i < stdout.length; i += 3) {
      const r = stdout.readUInt8(i), g = stdout.readUInt8(i + 1), b = stdout.readUInt8(i + 2);
      assert.ok(r < 10 && g > 220 && b < 10, `expected only the selected scene, saw ${r}/${g}/${b}`);
    }
  } finally {
    await studio.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
