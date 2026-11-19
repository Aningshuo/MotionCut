/**
 * P10-A5：MCP `export_start` 支持 audioMix（协议层 + 真实 stdio 子进程）。
 *
 * 渲染端口是 **STUB**（`test/fixtures/render-stub-port.mjs`）：本用例验证的是
 * 「MCP 参数校验 → 写门禁 → ops.startExport → 端口透传」与审计字段；
 * 真实混音/封装由 packages/render 的测试覆盖。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createContext } from '../../cli/ops.mjs';
import { createFilmPort, createProjectsPort } from '../../cli/test/fixtures/stub-ports.mjs';
import { createMcpServer } from '../server.mjs';
import { createRenderPort } from './fixtures/render-stub-port.mjs';

const execFileAsync = promisify(execFile);
const ROOT = new URL('../../../', import.meta.url).pathname;
const FIXTURE = path.join(ROOT, 'contracts/fixtures/film-v12.html');
const SESSION = path.join(ROOT, 'packages/mcp/test/fixtures/audio-export-session.mjs');
const RENDER_STUB = path.join(ROOT, 'packages/mcp/test/fixtures/render-stub-port.mjs');

/** @type {string} */
let workDir;
/** @type {string} */
let project;
/** @type {string} */
let logFile;

before(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-mcp-audio-'));
  project = path.join(workDir, 'proj');
  await fs.mkdir(project, { recursive: true });
  await fs.copyFile(FIXTURE, path.join(project, 'film.html'));
  logFile = path.join(workDir, 'render-stub.log');
});

after(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

/** @param {{ allowWrite?: boolean }} [opts] */
function makeServer(opts = {}) {
  const ctx = createContext({
    film: createFilmPort(),
    projects: createProjectsPort({ root: workDir }),
    render: createRenderPort(),
    root: workDir,
    cwd: workDir,
    stateDir: path.join(workDir, '.state'),
    log: () => {},
  });
  return createMcpServer(ctx, { allowWrite: opts.allowWrite ?? true });
}

/** @param {string} jobId */
function spec(jobId) {
  return {
    jobId,
    projectId: 'proj',
    owner: 'SUB2',
    kind: 'video',
    range: [0, 1],
    fps: 30,
    outputDir: path.join(workDir, 'out'),
    expectedHash: 'a'.repeat(64),
  };
}

function audioMix() {
  return {
    duration: 1,
    clips: [
      { src: '/tmp/tone-a.wav', at: 0 },
      { src: '/tmp/tone-b.wav', at: 0.5, volume: 0.5, fade: [0.1, 0.1] },
    ],
  };
}

// ---- 协议层 --------------------------------------------------------------

test('P10-A5 schema：export_start 暴露 audioMix（additionalProperties:false）', async () => {
  const server = makeServer();
  const list = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const tool = /** @type {any[]} */ (list.result.tools).find((entry) => entry.name === 'export_start');
  assert.ok(tool, 'export_start missing');
  const audio = tool.inputSchema.properties.audioMix;
  assert.ok(audio, 'audioMix not in schema');
  assert.equal(audio.type, 'object');
  assert.equal(audio.additionalProperties, false);
  assert.deepEqual(audio.required, ['duration', 'clips']);
  assert.equal(audio.properties.clips.items.additionalProperties, false);
  assert.ok(!tool.inputSchema.required.includes('audioMix'), 'audioMix must stay optional');
});

test('P10-A5 写门禁：无 confirm → E_CONFIRM_REQUIRED；有 confirm → 透传并返回结构化结果', async () => {
  const server = makeServer({ allowWrite: true });

  const denied = await server.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'export_start', arguments: { project: 'proj', spec: spec('p10-mcp-1'), audioMix: audioMix() } },
  });
  assert.equal(denied.result.isError, true);
  assert.equal(denied.result.structuredContent.error.code, 'E_CONFIRM_REQUIRED');
  assert.equal(denied.result.structuredContent.error.example.confirm, true);

  const ok = await server.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'export_start',
      arguments: { project: 'proj', spec: spec('p10-mcp-2'), audioMix: audioMix(), confirm: true },
    },
  });
  assert.equal(ok.result.isError, false, JSON.stringify(ok.result));
  assert.equal(ok.result.structuredContent.ok, true);
  assert.equal(ok.result.structuredContent.jobId, 'p10-mcp-2');
  assert.deepEqual(ok.result.structuredContent.audio, { clips: 2, durationSec: 1 });
});

test('P10-A5 参数校验：audioMix 里多余字段 → -32602 指到字段', async () => {
  const server = makeServer({ allowWrite: true });
  const bad = await server.handle({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'export_start',
      arguments: {
        project: 'proj',
        spec: spec('p10-mcp-3'),
        audioMix: { duration: 1, clips: [{ src: '/tmp/a.wav', at: 0, bogus: true }] },
        confirm: true,
      },
    },
  });
  assert.equal(bad.error.code, -32602);
  assert.equal(bad.error.data.path, '$.audioMix.clips[0].bogus');
});

// ---- 真实 stdio ----------------------------------------------------------

test('P10-A5 真实 stdio 子进程：audioMix 透传 + 审计 hasAudioMix', async () => {
  const auditDir = path.join(workDir, 'audit');
  const transcriptPath = path.join(workDir, 'transcript.json');
  const stubLog = path.join(workDir, 'stub-io.log');
  await fs.writeFile(stubLog, '');

  await execFileAsync(
    process.execPath,
    [
      SESSION,
      '--transcript',
      transcriptPath,
      '--project',
      project,
      '--root',
      workDir,
      '--render-module',
      RENDER_STUB,
      '--audit-dir',
      auditDir,
      '--allow-write',
    ],
    { env: { ...process.env, OPENCUT_STUB_RENDER_LOG: stubLog }, timeout: 30_000 },
  );

  /** @type {any} */
  const transcript = JSON.parse(await fs.readFile(transcriptPath, 'utf8'));
  assert.equal(transcript.layer, 'REAL_STDIO');
  assert.equal(transcript.exitCode, 0, transcript.stderr);

  const byId = new Map(/** @type {any[]} */ (transcript.exchanges).map((e) => [e.request.id, e.response]));
  const denied = /** @type {any} */ (byId.get(2));
  const accepted = /** @type {any} */ (byId.get(3));
  assert.equal(denied.result.isError, true);
  assert.equal(denied.result.structuredContent.error.code, 'E_CONFIRM_REQUIRED');
  assert.equal(accepted.result.isError, false, JSON.stringify(accepted.result));
  assert.equal(accepted.result.structuredContent.jobId, 'p10-stdio');
  assert.deepEqual(accepted.result.structuredContent.audio, { clips: 2, durationSec: 1 });

  // 端口只被成功那次调用触及，且 audioMix 原样到达
  const calls = (await fs.readFile(stubLog, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(calls.length, 1, `stub called ${calls.length} times`);
  assert.equal(calls[0].spec.jobId, 'p10-stdio');
  assert.equal(calls[0].audioMix.clips.length, 2);
  assert.equal(calls[0].audioMix.duration, 1);

  // 审计：export_start 行都有 hasAudioMix 字段，且不写片段路径
  const auditText = await fs.readFile(path.join(auditDir, 'audit.jsonl'), 'utf8');
  const lines = auditText
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const exportLines = lines.filter((entry) => entry.tool === 'export_start');
  assert.ok(exportLines.length >= 2, `expected >=2 export_start lines, got ${exportLines.length}`);
  for (const entry of exportLines) {
    assert.ok('hasAudioMix' in entry, 'audit line missing hasAudioMix');
    assert.equal(entry.hasAudioMix, true);
  }
  assert.ok(!auditText.includes('/tmp/tone-a.wav'), 'audit must not contain clip paths');
  assert.ok(!auditText.includes('tone-b.wav'), 'audit must not contain clip paths');
});
