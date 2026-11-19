import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { LOUDNESS_PRESETS, measureLoudness } from '../../../render/loudness.mjs';
import { startStudio } from '../studio-server.mjs';

const exec = promisify(execFile);

test('clip loudness measures only the selected source trim and returns a single revision-bound op', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-clip-loudness-'));
  const media = path.join(dir, 'source.wav');
  await exec('ffmpeg', [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=5',
    '-af', "volume='if(lt(t,2),6,1)':eval=frame", '-ac', '2', media,
  ]);
  const fullLoudness = await measureLoudness(media, { target: LOUDNESS_PRESETS.streaming });
  const source = `<!doctype html><html><head><meta name="viewport" content="width=64,height=64"></head><body>
<section locked><audio id="locked" src="source.wav#t=0,2"></audio></section>
<section>
  <audio id="other" src="source.wav#t=0,1.5"></audio>
  <audio id="selected" src="source.wav#t=2.1,4.9" at="7" speed="1.25" volume="0.7"></audio>
</section>
</body></html>`;
  const film = path.join(dir, 'film.html');
  const hash = createHash('sha256').update(source).digest('hex');
  await fs.writeFile(film, source);
  const studio = await startStudio({ port: 0, vitePort: 0, home: path.join(dir, 'home') });
  try {
    /** @param {string} endpoint @param {any} body */
    const post = (endpoint, body) => fetch(`${studio.url}${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const opened = await post('/api/projects/open', { dir });
    assert.equal(opened.status, 200);
    const projectId = (await opened.json()).project.projectId;
    const scope = `${projectId}::main`;
    const endpoint = `/api/projects/${encodeURIComponent(scope)}/clip-loudness`;
    const locked = await post(endpoint, { clipId: 'locked', expectedHash: hash });
    assert.equal(locked.status, 400);
    assert.equal((await locked.json()).code, 'LOCKED');
    const stale = await post(endpoint, { clipId: 'selected', expectedHash: '0'.repeat(64) });
    assert.equal(stale.status, 409);
    const measured = await post(endpoint, { clipId: 'selected', expectedHash: hash });
    const plan = await measured.json();
    assert.equal(measured.status, 200, JSON.stringify(plan));
    assert.equal(plan.hash, hash);
    assert.equal(plan.loudness.limitedBy, 'volume');
    assert.ok(plan.loudness.inputLufs < Number(fullLoudness.fields.input_i) - 5);
    assert.deepEqual(plan.ops, [{ op: 'props', edits: [{ clip: 'selected', prop: 'volume', value: 2 }] }]);
    assert.equal(await fs.readFile(film, 'utf8'), source);

    const committed = await post(`/api/projects/${encodeURIComponent(scope)}/ops`, {
      envelope: { projectId: scope, owner: 'MAIN', batchId: 'test-loudness', opId: 'test-apply', expectedHash: plan.hash },
      ops: plan.ops,
    });
    assert.equal(committed.status, 200);
    const written = await fs.readFile(film, 'utf8');
    assert.equal(written, source.replace('volume="0.7"', 'volume="2"'));
    const result = await committed.json();
    assert.equal(result.undoDepth, 1);
    const undone = await post(`/api/projects/${encodeURIComponent(scope)}/undo`, { expectedHash: result.hash });
    assert.equal(undone.status, 200);
    assert.equal(await fs.readFile(film, 'utf8'), source);
  } finally {
    await studio.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
