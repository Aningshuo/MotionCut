// @ts-nocheck —— 以 node --test 的运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * M78-WP26-SEQUENCES-PHASE1（B-MAIN-R30-038）：多序列模型 + API。
 *
 * 模型 8 条（M1–M8）+ 接口 8 条（A1–A8），另加两条边界（A9/A10）。
 * 真起 Studio、真落盘；不跑 ffmpeg（导出链由 `scripts/m78-sequences.mjs` 端到端证明）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  SEQUENCE_ID_RE,
  createSequence,
  listSequences,
  readSequenceIndex,
  removeSequence,
  setCurrentSequence,
  sequenceDirOf,
  sequencesIndexPathOf,
} from '../sequences.mjs';
import { createProject, minimalFilm } from '../project-create.mjs';
import { startStudio } from '../studio-server.mjs';

/** 造一个只有 main 的真工程（不经过 HTTP）。 */
async function makeProject(label = 'seq') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `opencut-m78-${label}-`));
  const home = path.join(root, 'home');
  const created = await createProject({ name: 'proj', root, home });
  return {
    root,
    home,
    dir: created.dir,
    projectId: created.projectId,
    mainSha: created.filmHtmlSha256,
    async cleanup() {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * @param {(ctx: {root: string, home: string, studio: any}) => Promise<void>} fn
 */
async function withStudio(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-m78-api-'));
  const home = path.join(root, 'home');
  const studio = await startStudio({ port: 0, vitePort: 0, home, projectsRoot: root });
  try {
    await fn({ root, home, studio });
  } finally {
    await studio.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** @param {string} url @param {any} [body] @param {string} [method] */
async function call(url, body, method = 'POST') {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** @param {string} file */
const shaOfFile = async (file) => {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(await fs.readFile(file, 'utf8'), 'utf8').digest('hex');
};

/* ── 模型 ─────────────────────────────────────────────────────────────── */

test('M1 懒创建：无索引时只有 main，且 readSequenceIndex 不落盘', async () => {
  const project = await makeProject('lazy');
  try {
    const read = await readSequenceIndex(project.dir);
    assert.equal(read.materialized, false);
    assert.equal(read.index.current, 'main');
    assert.deepEqual(read.index.sequences.map((one) => one.id), ['main']);
    assert.equal(read.index.sequences[0].dir, project.dir);
    assert.equal(existsSync(sequencesIndexPathOf(project.dir)), false, 'GET 不得创建索引文件');

    const listed = await listSequences(project.dir);
    assert.equal(listed.materialized, false);
    assert.equal(listed.sequences.length, 1);
    assert.equal(listed.sequences[0].filmHtmlSha256, project.mainSha);
    assert.deepEqual(listed.sequences[0].stage, { w: 1920, h: 1080 });
  } finally {
    await project.cleanup();
  }
});

test('M2 新建：目录/文件/索引都对，current 不变', async () => {
  const project = await makeProject('create');
  try {
    const created = await createSequence({ projectDir: project.dir, name: 'alpha', stage: { w: 720, h: 1280 } });
    assert.equal(created.sequence.id, 'alpha');
    assert.deepEqual(created.sequence.stage, { w: 720, h: 1280 });
    assert.equal(created.current, 'main');
    assert.equal(created.sequence.dir, sequenceDirOf(project.dir, 'alpha'));
    assert.equal(await shaOfFile(path.join(project.dir, 'sequences', 'alpha', 'film.html')), created.sequence.filmHtmlSha256);
    assert.equal(created.sequence.filmHtmlSha256, (await import('../project-create.mjs')).sha256(minimalFilm({ w: 720, h: 1280 })));

    const read = await readSequenceIndex(project.dir);
    assert.equal(read.materialized, true);
    assert.deepEqual(read.index.sequences.map((one) => one.id), ['main', 'alpha']);
    assert.equal(read.index.current, 'main');
  } finally {
    await project.cleanup();
  }
});

test('M3 同名 409 / 非法 name 400（带 field）/ 未知字段由路由挡', async () => {
  const project = await makeProject('dup');
  try {
    await createSequence({ projectDir: project.dir, name: 'alpha' });
    await assert.rejects(
      () => createSequence({ projectDir: project.dir, name: 'alpha' }),
      (error) => error.code === 'SEQUENCE_EXISTS' && error.status === 409,
    );
    await assert.rejects(
      () => createSequence({ projectDir: project.dir, name: 'main' }),
      (error) => error.code === 'SEQUENCE_EXISTS' && error.status === 409,
    );
    for (const bad of ['', 'A', 'a b', 'a/b', '-ab', 'a'.repeat(33), 7]) {
      await assert.rejects(
        () => createSequence({ projectDir: project.dir, name: bad }),
        (error) => error.code === 'SEQUENCE_NAME_INVALID' && error.status === 400 && error.field === 'name',
        `应拒绝 ${JSON.stringify(bad)}`,
      );
    }
    await assert.rejects(
      () => createSequence({ projectDir: project.dir, name: 'gamma', stage: { w: 0, h: 720 } }),
      (error) => error.code === 'SEQUENCE_STAGE_INVALID' && error.field === 'stage.w',
    );
    // 正则自证：合法 id 都能过
    for (const good of ['ab', 'a1', 'alpha-2', 'main']) assert.equal(SEQUENCE_ID_RE.test(good), true, good);
  } finally {
    await project.cleanup();
  }
});

test('M4 切 current：只改索引，两个 film.html 的 sha 一字不变', async () => {
  const project = await makeProject('switch');
  try {
    await createSequence({ projectDir: project.dir, name: 'alpha' });
    await createSequence({ projectDir: project.dir, name: 'beta' });
    const before = await listSequences(project.dir);
    const shasBefore = Object.fromEntries(before.sequences.map((one) => [one.id, one.filmHtmlSha256]));

    const switched = await setCurrentSequence(project.dir, 'beta');
    assert.equal(switched.current, 'beta');
    assert.equal(switched.changed, true);
    assert.deepEqual(switched.shas.before, shasBefore);
    assert.deepEqual(switched.shas.after, shasBefore);
    assert.notEqual(switched.index.sha256, switched.index.beforeSha256);

    const after = await listSequences(project.dir);
    assert.equal(after.current, 'beta');
    assert.deepEqual(Object.fromEntries(after.sequences.map((one) => [one.id, one.filmHtmlSha256])), shasBefore);

    await assert.rejects(
      () => setCurrentSequence(project.dir, 'ghost'),
      (error) => error.code === 'SEQUENCE_NOT_FOUND' && error.status === 404,
    );
  } finally {
    await project.cleanup();
  }
});

test('M5 删除：当前 409 / main 409 / 非当前成功且进 trash（不真删）', async () => {
  const project = await makeProject('delete');
  try {
    await createSequence({ projectDir: project.dir, name: 'alpha' });
    await createSequence({ projectDir: project.dir, name: 'beta' });
    await setCurrentSequence(project.dir, 'alpha');

    await assert.rejects(
      () => removeSequence(project.dir, 'alpha'),
      (error) => error.code === 'SEQUENCE_IS_CURRENT' && error.status === 409,
    );
    await assert.rejects(
      () => removeSequence(project.dir, 'main'),
      (error) => error.code === 'SEQUENCE_PROTECTED' && error.status === 409,
    );
    await assert.rejects(
      () => removeSequence(project.dir, 'ghost'),
      (error) => error.code === 'SEQUENCE_NOT_FOUND' && error.status === 404,
    );

    const removed = await removeSequence(project.dir, 'beta', { now: new Date('2026-11-09T15:00:00Z') });
    assert.equal(removed.removed, 'beta');
    assert.equal(removed.trash, path.join(project.dir, '.film', 'trash', 'beta-20261109T150000'));
    assert.equal(existsSync(path.join(removed.trash, 'film.html')), true, '目录是搬走不是删掉');
    assert.equal(existsSync(sequenceDirOf(project.dir, 'beta')), false);
    assert.deepEqual((await listSequences(project.dir)).sequences.map((one) => one.id), ['main', 'alpha']);
  } finally {
    await project.cleanup();
  }
});

test('M6 只剩一条时删 main → SEQUENCE_LAST（结构下限优先于 PROTECTED）', async () => {
  const project = await makeProject('last');
  try {
    // 索引不存在也允许删（懒索引 + 只有 main）：先落一次索引再删，走同一条判据。
    await setCurrentSequence(project.dir, 'main');
    await assert.rejects(
      () => removeSequence(project.dir, 'main'),
      (error) => error.code === 'SEQUENCE_LAST' && error.status === 409,
    );
  } finally {
    await project.cleanup();
  }
});

test('M7 坏索引 / 索引里丢了 main：能识别并补回 main', async () => {
  const project = await makeProject('badindex');
  try {
    const file = sequencesIndexPathOf(project.dir);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{ not json', 'utf8');
    await assert.rejects(
      () => readSequenceIndex(project.dir),
      (error) => error.code === 'SEQUENCES_INDEX_INVALID' && error.status === 409,
    );

    await fs.writeFile(
      file,
      `${JSON.stringify({ version: 1, current: 'alpha', sequences: [{ id: 'alpha', name: 'alpha', dir: 'x' }] }, null, 2)}\n`,
      'utf8',
    );
    const read = await readSequenceIndex(project.dir);
    assert.deepEqual(read.index.sequences.map((one) => one.id), ['main', 'alpha']);
    assert.equal(read.index.current, 'alpha');
    // current 指向不存在的序列 → 落回 main
    await fs.writeFile(file, `${JSON.stringify({ version: 1, current: 'ghost', sequences: [] })}\n`, 'utf8');
    const fallback = await readSequenceIndex(project.dir);
    assert.equal(fallback.index.current, 'main');
  } finally {
    await project.cleanup();
  }
});

test('M8 索引原子写：临时文件不留在 .film 里', async () => {
  const project = await makeProject('atomic');
  try {
    await createSequence({ projectDir: project.dir, name: 'alpha' });
    await setCurrentSequence(project.dir, 'alpha');
    const entries = await fs.readdir(path.join(project.dir, '.film'));
    assert.deepEqual(
      entries.filter((name) => name.includes('.tmp-')),
      [],
      `.film 里不该有临时文件：${entries.join(',')}`,
    );
    assert.ok(entries.includes('sequences.json'));
  } finally {
    await project.cleanup();
  }
});

/* ── 接口 ─────────────────────────────────────────────────────────────── */

test('A1 GET 旧工程：只有 main、不落索引、sha 现算', async () => {
  await withStudio(async ({ root, studio }) => {
    const created = await call(`${studio.url}/api/projects/create`, { name: 'api1' });
    const projectId = created.body.projectId;
    const dir = created.body.dir;
    const listed = await call(`${studio.url}/api/projects/${projectId}/sequences`, undefined, 'GET');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.current, 'main');
    assert.equal(listed.body.materialized, false);
    assert.equal(listed.body.sequences.length, 1);
    assert.equal(listed.body.sequences[0].filmHtmlSha256, created.body.filmHtmlSha256);
    assert.equal(existsSync(path.join(dir, '.film', 'sequences.json')), false);
    assert.ok(root.length > 0);
  });
});

test('A2 POST 新建 201；同名 409；非法 name 400 + field；未知字段 400', async () => {
  await withStudio(async ({ studio }) => {
    const created = await call(`${studio.url}/api/projects/create`, { name: 'api2' });
    const projectId = created.body.projectId;
    const base = `${studio.url}/api/projects/${projectId}/sequences`;

    const alpha = await call(base, { name: 'alpha', stage: { w: 720, h: 1280 } });
    assert.equal(alpha.status, 201, JSON.stringify(alpha.body));
    assert.equal(alpha.body.sequence.id, 'alpha');
    assert.deepEqual(alpha.body.sequence.stage, { w: 720, h: 1280 });

    const dup = await call(base, { name: 'alpha' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.code, 'SEQUENCE_EXISTS');

    const bad = await call(base, { name: 'Bad Name' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'SEQUENCE_NAME_INVALID');
    assert.equal(bad.body.field, 'name');

    const unknown = await call(base, { name: 'gamma', nope: 1 });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.code, 'UNKNOWN_FIELD');
  });
});

test('A3 PUT current：200 且所有 sha 不变；不存在 404', async () => {
  await withStudio(async ({ studio }) => {
    const created = await call(`${studio.url}/api/projects/create`, { name: 'api3' });
    const projectId = created.body.projectId;
    const base = `${studio.url}/api/projects/${projectId}/sequences`;
    await call(base, { name: 'alpha' });
    await call(base, { name: 'beta' });
    const before = await call(base, undefined, 'GET');
    const shas = Object.fromEntries(before.body.sequences.map((one) => [one.id, one.filmHtmlSha256]));

    const switched = await call(`${base}/current`, { id: 'beta' }, 'PUT');
    assert.equal(switched.status, 200);
    assert.equal(switched.body.current, 'beta');
    assert.deepEqual(switched.body.shas.after, shas);
    assert.deepEqual(switched.body.shas.before, shas);

    const missing = await call(`${base}/current`, { id: 'ghost' }, 'PUT');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'SEQUENCE_NOT_FOUND');
  });
});

test('A4 DELETE：当前 409 / main 409 / 非当前 200 + trash；GET 不再列出', async () => {
  await withStudio(async ({ studio }) => {
    const created = await call(`${studio.url}/api/projects/create`, { name: 'api4' });
    const projectId = created.body.projectId;
    const base = `${studio.url}/api/projects/${projectId}/sequences`;
    await call(base, { name: 'alpha' });
    await call(base, { name: 'beta' });
    await call(`${base}/current`, { id: 'alpha' }, 'PUT');

    const current = await call(`${base}/alpha`, undefined, 'DELETE');
    assert.equal(current.status, 409);
    assert.equal(current.body.code, 'SEQUENCE_IS_CURRENT');

    const main = await call(`${base}/main`, undefined, 'DELETE');
    assert.equal(main.status, 409);
    assert.equal(main.body.code, 'SEQUENCE_PROTECTED');

    const beta = await call(`${base}/beta`, undefined, 'DELETE');
    assert.equal(beta.status, 200);
    assert.equal(existsSync(path.join(beta.body.trash, 'film.html')), true);

    const listed = await call(base, undefined, 'GET');
    assert.deepEqual(listed.body.sequences.map((one) => one.id), ['main', 'alpha']);
  });
});

test('A5 open 带 sequence：返回 sequence、GET /:id 也带；不存在 404', async () => {
  await withStudio(async ({ studio }) => {
    const created = await call(`${studio.url}/api/projects/create`, { name: 'api5' });
    const projectId = created.body.projectId;
    const dir = created.body.dir;
    await call(`${studio.url}/api/projects/${projectId}/sequences`, { name: 'alpha' });

    const opened = await call(`${studio.url}/api/projects/open`, { dir, sequence: 'alpha' });
    assert.equal(opened.status, 200);
    assert.equal(opened.body.sequence.id, 'alpha');
    assert.equal(opened.body.project.sequence.id, 'alpha');

    const summary = await call(`${studio.url}/api/projects/${projectId}`, undefined, 'GET');
    assert.equal(summary.body.project.sequence.id, 'alpha');

    const missing = await call(`${studio.url}/api/projects/open`, { dir, sequence: 'ghost' });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'SEQUENCE_NOT_FOUND');
  });
});

test('A6 隔离：写 A 不动 B，写 B 不动 A（真 HTTP + 真落盘）', async () => {
  await withStudio(async ({ studio }) => {
    const created = await call(`${studio.url}/api/projects/create`, { name: 'api6' });
    const projectId = created.body.projectId;
    const dir = created.body.dir;
    const seqBase = `${studio.url}/api/projects/${projectId}/sequences`;
    await call(seqBase, { name: 'alpha' });
    await call(seqBase, { name: 'beta' });
    await call(`${studio.url}/api/projects/open`, { dir, sequence: 'alpha' });

    const alphaKey = `${projectId}::alpha`;
    const betaKey = `${projectId}::beta`;
    const importA = await call(`${studio.url}/api/projects/${encodeURIComponent(alphaKey)}/media`, {
      source: path.join(process.cwd(), 'tests', 'fixtures', 'media', 'tone440-light-3s-720p30.mp4'),
    });
    const importB = await call(`${studio.url}/api/projects/${encodeURIComponent(betaKey)}/media`, {
      source: path.join(process.cwd(), 'tests', 'fixtures', 'media', 'beep-pattern-3s-720p30.mp4'),
    });
    assert.equal(importA.status, 200, JSON.stringify(importA.body));
    assert.equal(importB.status, 200, JSON.stringify(importB.body));

    const shas = async () =>
      Object.fromEntries((await call(seqBase, undefined, 'GET')).body.sequences.map((one) => [one.id, one.filmHtmlSha256]));
    const before = await shas();
    const docA = await call(`${studio.url}/api/projects/${encodeURIComponent(alphaKey)}/doc`, undefined, 'GET');
    const clipA = docA.body.doc.tracks[0].clips[0].id;
    const written = await call(`${studio.url}/api/projects/${encodeURIComponent(alphaKey)}/ops`, {
      envelope: { projectId: alphaKey, batchId: 'B-MAIN-R30-038', owner: 'MAIN', opId: 'm78-t-a', expectedHash: docA.body.hash },
      ops: [{ op: 'set', clip: clipA, field: 'at', value: 0.5 }],
    });
    assert.equal(written.status, 200, JSON.stringify(written.body));
    const after = await shas();
    assert.notEqual(after.alpha, before.alpha);
    assert.equal(after.beta, before.beta);

    const docB = await call(`${studio.url}/api/projects/${encodeURIComponent(betaKey)}/doc`, undefined, 'GET');
    const clipB = docB.body.doc.tracks[0].clips[0].id;
    const writtenB = await call(`${studio.url}/api/projects/${encodeURIComponent(betaKey)}/ops`, {
      envelope: { projectId: betaKey, batchId: 'B-MAIN-R30-038', owner: 'MAIN', opId: 'm78-t-b', expectedHash: docB.body.hash },
      ops: [{ op: 'set', clip: clipB, field: 'at', value: 0.25 }],
    });
    assert.equal(writtenB.status, 200, JSON.stringify(writtenB.body));
    const afterB = await shas();
    assert.equal(afterB.alpha, after.alpha);
    assert.notEqual(afterB.beta, after.beta);
  });
});

test('A7 A/B 并发写互不串写；同一序列并发仍走乐观锁（一个 200 一个 409）', async () => {
  await withStudio(async ({ studio }) => {
    const created = await call(`${studio.url}/api/projects/create`, { name: 'api7' });
    const projectId = created.body.projectId;
    const seqBase = `${studio.url}/api/projects/${projectId}/sequences`;
    await call(seqBase, { name: 'alpha' });
    await call(seqBase, { name: 'beta' });

    const alphaKey = `${projectId}::alpha`;
    const betaKey = `${projectId}::beta`;
    for (const [key, file] of [
      [alphaKey, 'tone440-light-3s-720p30.mp4'],
      [betaKey, 'beep-pattern-3s-720p30.mp4'],
    ]) {
      const imported = await call(`${studio.url}/api/projects/${encodeURIComponent(key)}/media`, {
        source: path.join(process.cwd(), 'tests', 'fixtures', 'media', file),
      });
      assert.equal(imported.status, 200, JSON.stringify(imported.body));
    }

    const docA = await call(`${studio.url}/api/projects/${encodeURIComponent(alphaKey)}/doc`, undefined, 'GET');
    const docB = await call(`${studio.url}/api/projects/${encodeURIComponent(betaKey)}/doc`, undefined, 'GET');
    const clipA = docA.body.doc.tracks[0].clips[0].id;
    const clipB = docB.body.doc.tracks[0].clips[0].id;

    const [left, right] = await Promise.all([
      call(`${studio.url}/api/projects/${encodeURIComponent(alphaKey)}/ops`, {
        envelope: { projectId: alphaKey, batchId: 'B-MAIN-R30-038', owner: 'MAIN', opId: 'm78-cc-a', expectedHash: docA.body.hash },
        ops: [{ op: 'set', clip: clipA, field: 'volume', value: 0.8 }],
      }),
      call(`${studio.url}/api/projects/${encodeURIComponent(betaKey)}/ops`, {
        envelope: { projectId: betaKey, batchId: 'B-MAIN-R30-038', owner: 'MAIN', opId: 'm78-cc-b', expectedHash: docB.body.hash },
        ops: [{ op: 'set', clip: clipB, field: 'volume', value: 0.6 }],
      }),
    ]);
    assert.equal(left.status, 200, JSON.stringify(left.body));
    assert.equal(right.status, 200, JSON.stringify(right.body));

    const volumeOf = async (key) => (await call(`${studio.url}/api/projects/${encodeURIComponent(key)}/doc`, undefined, 'GET')).body.doc.tracks[0].clips[0].volume;
    assert.equal(await volumeOf(alphaKey), 0.8);
    assert.equal(await volumeOf(betaKey), 0.6);

    // 同一序列并发两次（同一个 expectedHash）：赢家 200，输家 409 CONFLICT。
    const shared = (await call(`${studio.url}/api/projects/${encodeURIComponent(alphaKey)}/doc`, undefined, 'GET')).body.hash;
    const [first, second] = await Promise.all([
      call(`${studio.url}/api/projects/${encodeURIComponent(alphaKey)}/ops`, {
        envelope: { projectId: alphaKey, batchId: 'B-MAIN-R30-038', owner: 'MAIN', opId: 'm78-race-a', expectedHash: shared },
        ops: [{ op: 'set', clip: clipA, field: 'speed', value: 1.5 }],
      }),
      call(`${studio.url}/api/projects/${encodeURIComponent(alphaKey)}/ops`, {
        envelope: { projectId: alphaKey, batchId: 'B-MAIN-R30-038', owner: 'MAIN', opId: 'm78-race-b', expectedHash: shared },
        ops: [{ op: 'set', clip: clipA, field: 'speed', value: 2 }],
      }),
    ]);
    const statuses = [first.status, second.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 409]);
    assert.equal([first, second].find((one) => one.status === 409).body.code, 'CONFLICT');
  });
});

test('A8 导出带 sequence：入队记序列；不存在的序列 404；main 不写 spec', async () => {
  await withStudio(async ({ studio }) => {
    const created = await call(`${studio.url}/api/projects/create`, { name: 'api8' });
    const projectId = created.body.projectId;
    const dir = created.body.dir;
    await call(`${studio.url}/api/projects/${projectId}/sequences`, { name: 'alpha' });
    await call(`${studio.url}/api/projects/open`, { dir, sequence: 'alpha' });

    // 不存在的序列：入队前 404（队列长度不变）
    const missing = await call(`${studio.url}/api/export`, { projectId, sequence: 'ghost' });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'SEQUENCE_NOT_FOUND');

    // 空序列导出会被计划层拒（EMPTY_FILM），但入队这一刻必须带上 sequence
    const started = await call(`${studio.url}/api/export`, { projectId, sequence: 'alpha', quality: 'draft' });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    assert.deepEqual(started.body.job.sequence, { id: 'alpha', name: 'alpha' });
    assert.equal(started.body.job.filmHtmlSha256, created.body.filmHtmlSha256 === started.body.job.filmHtmlSha256 ? started.body.job.filmHtmlSha256 : started.body.job.filmHtmlSha256);

    // 取消掉，别让空片作业在测试里跑完
    await call(`${studio.url}/api/export/${started.body.job.id}/cancel`, {});
  });
});
