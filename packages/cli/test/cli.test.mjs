/**
 * WP18 CLI 验收（P5-A1..A5、A10 的 CLI 侧）。
 *
 * 所有 film 读写都走 `test/fixtures/stub-ports.mjs` 的**桩**（真实解析器在 main 树，
 * 本批 WAIT_MAIN_FILM）。桩的哈希与字节是真的，doc 是固定的——证据里也这么标。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createCli } from '../index.mjs';
import { createFilmPort, createProjectsPort } from './fixtures/stub-ports.mjs';
import { validate } from '../jsonschema.mjs';
import { filmReadOutput, errorOutput } from '../schema.mjs';

const execFileAsync = promisify(execFile);
const ROOT = new URL('../../../', import.meta.url).pathname;
const FIXTURE = path.join(ROOT, 'contracts/fixtures/film-v12.html');
const STUB_MODULE = path.join(ROOT, 'packages/cli/test/fixtures/stub-ports.mjs');
const BIN = path.join(ROOT, 'packages/cli/bin.mjs');

/** @type {string} */
let workDir;

before(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-cli-'));
});

after(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

/**
 * @returns {{ write: (chunk: string) => void, text: string }}
 */
function sink() {
  /** @type {string[]} */
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(chunk);
    },
    get text() {
      return chunks.join('');
    },
  };
}

/**
 * @param {string} name
 * @returns {Promise<string>}
 */
async function makeProject(name) {
  const dir = path.join(workDir, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.copyFile(FIXTURE, path.join(dir, 'film.html'));
  return dir;
}

/**
 * @param {string} project
 * @returns {Promise<string>}
 */
async function hashOf(project) {
  const buf = await fs.readFile(path.join(project, 'film.html'));
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * @param {Record<string, any>} [overrides]
 * @returns {ReturnType<typeof createCli>}
 */
function makeCli(overrides = {}) {
  return createCli({
    film: createFilmPort(),
    projects: createProjectsPort({ root: workDir }),
    root: workDir,
    cwd: workDir,
    stateDir: path.join(workDir, '.state'),
    log: () => {},
    ...overrides,
  });
}

/**
 * @param {string} project
 * @param {string} opId
 * @param {string} expectedHash
 * @param {Record<string, any>} [op]
 * @returns {Promise<string>}
 */
async function writeOps(project, opId, expectedHash, op = { op: 'set', field: 'title', value: 'edited-by-cli' }) {
  const file = path.join(workDir, `${opId}.json`);
  await fs.writeFile(
    file,
    JSON.stringify(
      {
        envelope: {
          projectId: path.basename(project),
          batchId: 'B-SUB2-R3-003R1',
          owner: 'SUB2',
          expectedHash,
          opId,
        },
        ops: [op],
      },
      null,
      2,
    ),
  );
  return file;
}

// ---- P5-A1 -------------------------------------------------------------

test('A1 film read 输出可被 schema 校验且含真实 sourceHash', async () => {
  const project = await makeProject('a1');
  const out = sink();
  const err = sink();
  const code = await makeCli().run(['film', 'read', 'a1', '--json'], { stdout: out, stderr: err });
  assert.equal(code, 0);
  const parsed = JSON.parse(out.text);
  const checked = validate(filmReadOutput, parsed);
  assert.deepEqual(checked, { ok: true }, JSON.stringify(checked));
  assert.equal(parsed.sourceHash, await hashOf(project));
  assert.equal(parsed.doc.stage.w, 1920);
  assert.equal(err.text, '');
});

test('A1 project info 只给摘要（stage/fps/轨/片段/诊断）', async () => {
  await makeProject('a1b');
  const out = sink();
  const code = await makeCli().run(['project', 'info', 'a1b', '--json'], { stdout: out, stderr: sink() });
  assert.equal(code, 0);
  const parsed = JSON.parse(out.text);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.stage, { w: 1920, h: 1080 });
  assert.equal(parsed.fps.value, 30);
  assert.equal(parsed.tracks.total, 2);
  assert.equal(parsed.clips.total, 3);
  assert.deepEqual(parsed.diagnostics, { total: 0, errors: 0, warnings: 0 });
});

test('A1 project list 走 projects 端口', async () => {
  await makeProject('a1c');
  const out = sink();
  const code = await makeCli().run(['project', 'list', '--json'], { stdout: out, stderr: sink() });
  assert.equal(code, 0);
  const parsed = JSON.parse(out.text);
  assert.ok(parsed.projects.some((/** @type {any} */ p) => p.id === 'a1c'));
});

// ---- P5-A2 -------------------------------------------------------------

test('A2 film apply 成功：hash 改变且文件真的变了', async () => {
  const project = await makeProject('a2');
  const before = await hashOf(project);
  const beforeText = await fs.readFile(path.join(project, 'film.html'), 'utf8');
  const ops = await writeOps(project, 'op-a2', before);

  const out = sink();
  const code = await makeCli().run(['film', 'apply', 'a2', '--ops', ops, '--json'], { stdout: out, stderr: sink() });
  assert.equal(code, 0);
  const parsed = JSON.parse(out.text);
  assert.equal(parsed.ok, true);
  assert.notEqual(parsed.hash, before);
  assert.equal(parsed.hash, await hashOf(project));

  const afterText = await fs.readFile(path.join(project, 'film.html'), 'utf8');
  assert.notEqual(afterText, beforeText);
  assert.match(afterText, /<title>edited-by-cli<\/title>/);
});

// ---- P5-A3 -------------------------------------------------------------

test('A3 旧 expectedHash → CONFLICT + 当前 hash，退出码非 0，文件未变', async () => {
  const project = await makeProject('a3');
  const current = await hashOf(project);
  const stale = 'a'.repeat(64);
  const ops = await writeOps(project, 'op-a3', stale);

  const out = sink();
  const err = sink();
  const code = await makeCli().run(['film', 'apply', 'a3', '--ops', ops], { stdout: out, stderr: err });
  assert.notEqual(code, 0);
  assert.equal(code, 3);
  assert.equal(out.text.trim(), `CONFLICT ${current}`);
  assert.equal(await hashOf(project), current, 'file must not change on conflict');
  assert.match(err.text, /CONFLICT/);

  const jsonOut = sink();
  const code2 = await makeCli().run(['film', 'apply', 'a3', '--ops', ops, '--json'], { stdout: jsonOut, stderr: sink() });
  assert.equal(code2, 3);
  const parsed = JSON.parse(jsonOut.text);
  assert.equal(validate(errorOutput, parsed).ok, true);
  assert.equal(parsed.error.code, 'CONFLICT');
  assert.equal(parsed.error.currentHash, current);
});

// ---- P5-A4 -------------------------------------------------------------

test('A4 opId 幂等：重放返回首次结果，不重复写', async () => {
  const project = await makeProject('a4');
  const hash0 = await hashOf(project);
  const ops = await writeOps(project, 'op-a4', hash0);

  const first = sink();
  assert.equal(await makeCli().run(['film', 'apply', 'a4', '--ops', ops, '--json'], { stdout: first, stderr: sink() }), 0);
  const firstParsed = JSON.parse(first.text);
  const hash1 = await hashOf(project);
  assert.equal(firstParsed.hash, hash1);
  const text1 = await fs.readFile(path.join(project, 'film.html'), 'utf8');
  const mtime1 = (await fs.stat(path.join(project, 'film.html'))).mtimeMs;

  // 第二次：同一 opId、同一 payload，expectedHash 已经过时（用旧值），仍然必须返回首次结果
  const second = sink();
  const code = await makeCli().run(['film', 'apply', 'a4', '--ops', ops, '--json'], { stdout: second, stderr: sink() });
  assert.equal(code, 0);
  const secondParsed = JSON.parse(second.text);
  assert.equal(secondParsed.hash, hash1);
  assert.equal(secondParsed.replayed, true);
  assert.equal(await hashOf(project), hash1);
  assert.equal(await fs.readFile(path.join(project, 'film.html'), 'utf8'), text1);
  assert.equal((await fs.stat(path.join(project, 'film.html'))).mtimeMs, mtime1);
});

test('A4 同 opId 不同 payload → INVALID，不冒充幂等', async () => {
  const project = await makeProject('a4b');
  const hash0 = await hashOf(project);
  const ops1 = await writeOps(project, 'op-a4b', hash0, { op: 'set', field: 'title', value: 'one' });
  assert.equal(await makeCli().run(['film', 'apply', 'a4b', '--ops', ops1, '--json'], { stdout: sink(), stderr: sink() }), 0);

  const ops2 = await writeOps(project, 'op-a4b', hash0, { op: 'set', field: 'title', value: 'two' });
  const out = sink();
  const code = await makeCli().run(['film', 'apply', 'a4b', '--ops', ops2, '--json'], { stdout: out, stderr: sink() });
  assert.equal(code, 2);
  assert.equal(JSON.parse(out.text).error.code, 'INVALID');
});

// ---- P5-A5 -------------------------------------------------------------

test('A5 路径逃逸 → E_PATH_ESCAPE，且不读不写', async () => {
  const cli = makeCli();
  const out = sink();
  const code = await cli.run(['film', 'read', '../../etc/passwd', '--json'], { stdout: out, stderr: sink() });
  assert.equal(code, 4);
  const parsed = JSON.parse(out.text);
  assert.equal(parsed.error.code, 'E_PATH_ESCAPE');
  assert.equal(validate(errorOutput, parsed).ok, true);
});

test('A5 符号链接逃逸 → E_PATH_ESCAPE', async () => {
  const link = path.join(workDir, 'escape-link');
  await fs.rm(link, { force: true });
  await fs.symlink('/etc', link);
  const out = sink();
  const code = await makeCli().run(['film', 'read', 'escape-link', '--json'], { stdout: out, stderr: sink() });
  assert.equal(code, 4);
  assert.equal(JSON.parse(out.text).error.code, 'E_PATH_ESCAPE');
});

// ---- dry-run / 用法 -----------------------------------------------------

test('--dry-run 不写盘，但仍校验 expectedHash', async () => {
  const project = await makeProject('dry');
  const hash0 = await hashOf(project);
  const ops = await writeOps(project, 'op-dry', hash0);

  const out = sink();
  const code = await makeCli().run(['film', 'apply', 'dry', '--ops', ops, '--json', '--dry-run'], { stdout: out, stderr: sink() });
  assert.equal(code, 0);
  const parsed = JSON.parse(out.text);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.hash, hash0);
  assert.equal(await hashOf(project), hash0);
});

test('film apply 缺 --ops → E_USAGE（写操作永不隐式）', async () => {
  await makeProject('noops');
  const out = sink();
  const code = await makeCli().run(['film', 'apply', 'noops', '--json'], { stdout: out, stderr: sink() });
  assert.equal(code, 1);
  assert.equal(JSON.parse(out.text).error.code, 'E_USAGE');
});

test('端口未接线 → WAIT_MAIN_FILM（退出码 7），不假装成功', async () => {
  await makeProject('nowire');
  const cli = createCli({ root: workDir, cwd: workDir, stateDir: path.join(workDir, '.state'), log: () => {} });
  const out = sink();
  const code = await cli.run(['film', 'read', 'nowire', '--json'], { stdout: out, stderr: sink() });
  assert.equal(code, 7);
  assert.equal(JSON.parse(out.text).error.code, 'WAIT_MAIN_FILM');
});

// ---- P5-A10 ------------------------------------------------------------

test('A10 stdout 只有结果/错误码，stderr 有日志，且无 Key 泄漏（真实子进程）', async () => {
  await makeProject('a10');
  const secret = 'sk-live-abcdef1234567890';
  const leakDir = path.join(workDir, secret);
  await fs.mkdir(leakDir, { recursive: true });

  const env = {
    ...process.env,
    OPENCUT_ENV_JSON: '',
    OPENCUT_TEST_SECRET: secret,
    OPENCUT_TEST_KEY: secret,
  };

  // 成功：stdout 是纯 JSON
  const ok = await execFileAsync('node', [BIN, 'film', 'read', 'a10', '--json', '--film-module', STUB_MODULE, '--root', workDir], {
    cwd: workDir,
    env,
  });
  assert.doesNotThrow(() => JSON.parse(ok.stdout));
  assert.equal(ok.stderr.trim(), '');
  assert.ok(!ok.stdout.includes(secret));

  // 失败：错误信息里带路径（路径名就是密文），必须被 redact
  const failed = await execFileAsync(
    'node',
    [BIN, 'film', 'read', secret, '--json', '--film-module', STUB_MODULE, '--root', workDir],
    { cwd: workDir, env },
  ).catch((e) => e);

  assert.notEqual(failed.code, 0);
  assert.ok(!String(failed.stdout).includes(secret), `stdout leaked secret: ${failed.stdout}`);
  assert.ok(!String(failed.stderr).includes(secret), `stderr leaked secret: ${failed.stderr}`);
  assert.match(String(failed.stdout), /"code": "JOB_FAILED"/);
  assert.ok(String(failed.stderr).trim().length > 0, '失败时 stderr 必须有人读的日志');

  // 用法错误：stdout 只有一个错误码
  const usage = await execFileAsync('node', [BIN, 'nope', '--root', workDir, '--film-module', STUB_MODULE], {
    cwd: workDir,
    env,
  }).catch((e) => e);
  assert.equal(usage.code, 1);
  assert.equal(String(usage.stdout).trim(), 'E_USAGE');
});
