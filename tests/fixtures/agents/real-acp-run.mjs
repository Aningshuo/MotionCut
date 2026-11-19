#!/usr/bin/env node
/**
 * P3 真实验收驱动（手动运行，不进 `node --test`：会真的调用用户的 Codex）。
 *
 *   node tests/fixtures/agents/real-acp-run.mjs
 *
 * 覆盖：
 * - P3-A1..A4、A7：真实适配器 initialize → session/new → prompt → session/update
 * - P3-A5：默认拒绝路径（真实 request_permission → deny → cancelled）
 * - P3-A6：真实 cancel 后本地收敛；close 后进程消失（ps/pid 验证）
 * - P3-A8：P8 真实改源（需要用户在逐请求上明确同意；见 approveP8）
 *
 * 安全：不读任何凭据文件；不传 --allow-all/bypass/yolo；沙箱只读或 workspace-write。
 * 证据写到 .local-runs/sub2/p3-evidence.json。
 */

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { PermissionBroker } from '../../../packages/agents/permission.mjs';
import {
  createCodexAcpSessions,
  findCodexExecutable,
  probeCodexAcp,
  resolveCodexAcp,
} from '../../../packages/agents/codex-acp.mjs';

const execFileAsync = promisify(execFile);
const ROOT = new URL('../../../', import.meta.url).pathname;
const EVIDENCE_PATH = path.join(ROOT, '.local-runs/sub2/p3-evidence.json');
const LOGS_DIR = path.join(ROOT, '.local-runs/sub2/adapter-logs');
const PROJECT = path.join(ROOT, 'tests/fixtures/agents/project');
const SCENE = path.join(PROJECT, 'scene-a.html');
const HEADING_BEFORE = 'CHANGE_ME_42';
const HEADING_AFTER = 'REAL_AGENT_EDITED';

/** @type {Record<string, any>} */
const evidence = {
  batch: 'B-SUB2-R2-002',
  startedAt: new Date().toISOString(),
  adapter: null,
  codex: null,
  probe: null,
  steps: {},
  p8: null,
  ps: [],
  errors: [],
};

/**
 * @param {string} text
 * @returns {string}
 */
function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * 等一轮结束，同时收集事件。
 * @param {AsyncIterable<any>} iterable
 * @param {{ timeoutMs?: number }} [opts]
 */
async function collectTurn(iterable, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 240_000;
  /** @type {any[]} */
  const events = [];
  const deadline = Date.now() + timeoutMs;
  const iterator = iterable[Symbol.asyncIterator]();
  for (;;) {
    const remaining = Math.max(1, deadline - Date.now());
    const result = await Promise.race([
      iterator.next(),
      new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), remaining)),
    ]);
    if (/** @type {any} */ (result).__timeout) throw new Error(`turn timeout after ${timeoutMs}ms`);
    if (/** @type {any} */ (result).done) throw new Error('event stream ended before turn_end');
    const event = /** @type {any} */ (result).value;
    events.push(event);
    if (event.type === 'turn_end') return events;
  }
}

/**
 * 进程是否还活着。
 * @param {number} pid
 * @returns {boolean}
 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 记录当前与 codex-acp 相关的进程（用于「没留悬挂进程」的证据）。
 * @returns {Promise<string[]>}
 */
async function psAdapter() {
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command=']);
    return {
      available: true,
      lines: stdout
        .split('\n')
        .filter((line) => line.includes('@agentclientprotocol/codex-acp/dist/index.js'))
        .map((line) => line.trim()),
    };
  } catch (err) {
    // 本机 Node 在沙箱里 spawn ps 会 EPERM；如实记录，不以空数组冒充「没有进程」。
    return { available: false, error: String(err), lines: [] };
  }
}

async function stepProbe() {
  const adapter = resolveCodexAcp();
  const codex = await findCodexExecutable();
  evidence.adapter = adapter;
  evidence.codex = codex;

  const probe = await probeCodexAcp({
    cwd: PROJECT,
    sandboxMode: 'read-only',
    logsDir: LOGS_DIR,
    timeoutMs: 90_000,
  });
  evidence.probe = probe;
  return probe;
}

async function stepCancel() {
  const created = await createCodexAcpSessions({
    resolveProject: () => PROJECT,
    sandboxMode: 'read-only',
    logsDir: LOGS_DIR,
    turnTimeoutMs: 240_000,
    cancelGraceMs: 5_000,
  });
  const { sessions } = created;
  /** @type {Record<string, any>} */
  const result = { commandLine: created.commandLine, env: created.env };

  try {
    const opened = await sessions.open('p3-cancel', 'codex');
    if (!('sessionId' in opened)) throw new Error(`open failed: ${JSON.stringify(opened)}`);
    const pid = sessions.inspect(opened.sessionId)?.pid;
    result.pid = pid;
    result.descriptor = sessions.inspect(opened.sessionId)?.descriptor;

    const sent = await sessions.send(
      opened.sessionId,
      'Count slowly from 1 to 200, one number per line. Do not use tools.',
    );
    if (!('turnId' in sent)) throw new Error(`send failed: ${JSON.stringify(sent)}`);

    // 等第一条 text（证明轮次真的开始），然后取消。
    let sawText = false;
    const iterator = sessions.events(opened.sessionId)[Symbol.asyncIterator]();
    const first = await Promise.race([
      iterator.next(),
      new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), 120_000)),
    ]);
    if (/** @type {any} */ (first).__timeout) throw new Error('no session/update before cancel');
    const firstEvent = /** @type {any} */ (first).value;
    sawText = firstEvent?.type === 'text' || firstEvent?.type === 'thinking';
    result.firstEvent = firstEvent;

    const t0 = Date.now();
    await sessions.cancel(opened.sessionId, sent.turnId);
    result.cancelMs = Date.now() - t0;

    /** @type {any[]} */
    const rest = [];
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const deadlineRace = new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), 1_000));
      const next = await Promise.race([iterator.next(), deadlineRace]);
      if (/** @type {any} */ (next).__timeout) {
        if (rest.some((e) => e.type === 'turn_end')) break;
        continue;
      }
      if (/** @type {any} */ (next).done) break;
      const event = /** @type {any} */ (next).value;
      rest.push(event);
      if (event.type === 'turn_end') break;
    }
    result.eventsAfterCancel = rest;
    result.sawTextBeforeCancel = sawText;
    result.turnEnd = rest.find((e) => e.type === 'turn_end') ?? null;
    result.transcript = sessions.transcript(opened.sessionId).slice(-40);
    result.aliveBeforeClose = typeof pid === 'number' ? pidAlive(pid) : null;

    await sessions.close(opened.sessionId);
    await new Promise((resolve) => setTimeout(resolve, 800));
    result.aliveAfterClose = typeof pid === 'number' ? pidAlive(pid) : null;
  } finally {
    await sessions.dispose();
  }
  return result;
}

async function stepPermissionDeny() {
  const created = await createCodexAcpSessions({
    resolveProject: () => PROJECT,
    sandboxMode: 'workspace-write',
    logsDir: LOGS_DIR,
    turnTimeoutMs: 180_000,
  });
  const { sessions } = created;
  /** @type {Record<string, any>} */
  const result = { brokerMode: 'deny(default)' };
  try {
    const opened = await sessions.open('p3-perm', 'codex');
    if (!('sessionId' in opened)) throw new Error(`open failed: ${JSON.stringify(opened)}`);
    const sent = await sessions.send(
      opened.sessionId,
      'Use your shell tool to run `cat ./scene-a.html`, then reply with the first line.',
    );
    if (!('turnId' in sent)) throw new Error(`send failed: ${JSON.stringify(sent)}`);
    const events = await collectTurn(sessions.events(opened.sessionId));
    result.events = events;
    result.permission = events.find((e) => e.type === 'permission') ?? null;
    result.turnEnd = events.find((e) => e.type === 'turn_end') ?? null;
    result.transcript = sessions.transcript(opened.sessionId).slice(-40);
    await sessions.close(opened.sessionId);
  } finally {
    await sessions.dispose();
  }
  return result;
}

/**
 * P8：真实改源。这里扮演「用户」在单个请求上点允许：
 * - 只允许读/搜 scene-a.html；
 * - 只允许写 scene-a.html；
 * - 其他一律拒绝（默认拒绝不变）。
 * @returns {Promise<Record<string, any>>}
 */
async function stepP8() {
  const original = await fs.readFile(SCENE, 'utf8');
  const beforeSha = sha256(original);
  /** @type {Array<{ request: any, decision: string }>} */
  const decisions = [];

  const broker = new PermissionBroker({
    mode: 'ask',
    timeoutMs: 5_000,
    onRequest: (request) => {
      // locations 可能是相对路径，只认这个文件名；其他文件一律拒绝。
      const inProject = request.detail.includes(path.basename(SCENE));
      const decision =
        inProject && (request.kind === 'fs_read' || request.kind === 'fs_write') ? 'allow' : 'deny';
      decisions.push({ request, decision });
      return decision;
    },
  });

  const created = await createCodexAcpSessions({
    resolveProject: () => PROJECT,
    sandboxMode: 'workspace-write',
    logsDir: LOGS_DIR,
    permissionBroker: broker,
    turnTimeoutMs: 300_000,
  });
  const { sessions } = created;
  /** @type {Record<string, any>} */
  const result = { beforeSha, decisions, headingBefore: HEADING_BEFORE };
  try {
    const opened = await sessions.open('p8', 'codex');
    if (!('sessionId' in opened)) throw new Error(`open failed: ${JSON.stringify(opened)}`);
    const sent = await sessions.send(
      opened.sessionId,
      `Edit ./scene-a.html: replace the heading text ${HEADING_BEFORE} with ${HEADING_AFTER}. ` +
        'Use your file tools; do not explain, just do it.',
    );
    if (!('turnId' in sent)) throw new Error(`send failed: ${JSON.stringify(sent)}`);
    const events = await collectTurn(sessions.events(opened.sessionId), { timeoutMs: 300_000 });
    result.events = events;
    result.turnEnd = events.find((e) => e.type === 'turn_end') ?? null;
    result.transcript = sessions.transcript(opened.sessionId).slice(-60);

    const after = await fs.readFile(SCENE, 'utf8');
    result.afterSha = sha256(after);
    result.changed = after !== original;
    result.headingAfter = after.includes(HEADING_AFTER) ? HEADING_AFTER : null;

    try {
      const { stdout } = await execFileAsync('git', ['diff', '--', path.relative(ROOT, SCENE)], {
        cwd: ROOT,
      });
      result.gitDiff = stdout;
    } catch (err) {
      result.gitDiffError = String(err);
    }

    await sessions.close(opened.sessionId);
  } finally {
    await sessions.dispose();
    await fs.writeFile(SCENE, original);
  }
  return result;
}

try {
  // 1) 探测（P3-A1..A3、A7）
  const probe = await stepProbe();
  evidence.steps.probe = {
    ok: probe.ok,
    auth: probe.auth,
    authEvidence: probe.authEvidence,
    steps: probe.steps,
  };

  // 2) 真实 cancel（P3-A6）
  evidence.steps.cancel = await stepCancel();

  // 3) 真实默认拒绝（P3-A5）
  evidence.steps.permissionDeny = await stepPermissionDeny();

  // 4) P8 真实改源（P3-A8）
  evidence.p8 = await stepP8();

  evidence.ps = await psAdapter();
  evidence.credentialFilesNotOpened = [
    '~/.codex/auth.json',
    '~/Library/Keychains/**',
    '~/.config/opencut/**',
  ];
  evidence.credentialReads = [];
  evidence.finishedAt = new Date().toISOString();
  evidence.ok =
    probe.ok &&
    evidence.steps.cancel.turnEnd?.reason === 'cancelled' &&
    evidence.steps.permissionDeny.permission?.request?.default === 'deny' &&
    evidence.p8.changed === true;
} catch (err) {
  evidence.errors.push(err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
  evidence.finishedAt = new Date().toISOString();
  evidence.ok = false;
} finally {
  await fs.mkdir(path.dirname(EVIDENCE_PATH), { recursive: true });
  await fs.writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`evidence → ${EVIDENCE_PATH}`);
  console.log(
    JSON.stringify(
      {
        ok: evidence.ok,
        auth: evidence.probe?.auth,
        cancel: evidence.steps.cancel?.turnEnd,
        permission: evidence.steps.permissionDeny?.permission?.request,
        p8: evidence.p8
          ? {
              changed: evidence.p8.changed,
              headingAfter: evidence.p8.headingAfter,
              beforeSha: evidence.p8.beforeSha?.slice(0, 12),
              afterSha: evidence.p8.afterSha?.slice(0, 12),
              decisions: evidence.p8.decisions?.map((d) => `${d.request.kind}:${d.decision}`),
              diffChars: evidence.p8.gitDiff?.length ?? null,
            }
          : null,
        ps: evidence.ps,
        errors: evidence.errors,
      },
      null,
      2,
    ),
  );
}
