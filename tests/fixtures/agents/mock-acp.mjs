#!/usr/bin/env node
/**
 * 假 Agent（mock ACP 对端），仅用于测试。
 *
 * 行为由 prompt 文本里的关键字触发，便于同一进程覆盖 P1–P5：
 *   - 默认            ：正常回答 "Hello" + " world"，turn_end(done)
 *   - ECHO_CWD        ：回答当前进程 cwd（P6 用来验证工程绑定）
 *   - PERMISSION      ：发起 fs_write 权限请求，等宿主决策后回 text，仅 allow 才落盘
 *   - CANCEL          ：先输出 working，等宿主 cancel（P4）
 *   - HANG            ：不产生任何输出、不结束（P3）
 *   - GARBAGE         ：输出非 JSON 后退出（P5）
 *   - TOOLS           ：输出一轮 tool_start/progress/end 与 usage（P1 事件规范化）
 *
 * 协议是 JSON-RPC 2.0 换行分隔，字段与 contracts/agent.ts 对齐。
 */
import readline from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';

const argv = process.argv.slice(2);
const MODE = readArg('--mode') ?? 'normal';

function readArg(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * @param {{ send: (msg: unknown) => void, raw?: (text: string) => void, cwd?: string, exit?: (code: number) => void }} io
 */
export function createMockAgent(io) {
  const cwd = io.cwd ?? process.cwd();
  const sessions = new Map();
  /** @type {Map<number, (result: unknown) => void>} */
  const pendingRequests = new Map();
  let nextSession = 0;
  let nextRequest = 900;

  /** @param {unknown} result */
  const respond = (id, result) => io.send({ jsonrpc: '2.0', id, result });

  /**
   * ACP 的轮次结束 = session/prompt 的响应（stopReason），不是自定义通知。
   * @param {string} sessionId
   * @param {string} reason
   */
  const endTurn = (sessionId, reason) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    const requestId = session.promptRequestId;
    session.turnId = null;
    session.promptRequestId = undefined;
    if (typeof requestId === 'number') respond(requestId, { stopReason: reason });
  };

  /**
   * @param {string} sessionId
   * @param {string} text
   */
  const text = (sessionId, value) =>
    io.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } },
      },
    });

  /**
   * @param {string} sessionId
   * @param {string} toolCallId
   * @param {string} title
   * @param {string} status
   */
  const toolUpdate = (sessionId, toolCallId, title, status) =>
    io.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: { sessionUpdate: 'tool_call_update', toolCallId, title, status },
      },
    });

  /**
   * @param {any} params
   * @returns {Promise<void>}
   */
  const runPrompt = async (params) => {
    const sessionId = String(params?.sessionId ?? '');
    const session = sessions.get(sessionId);
    if (!session) {
      respond(params?.__id, { error: { code: -32001, message: 'unknown session' } });
      return;
    }
    const prompt = extractPrompt(params?.prompt);
    const lower = prompt.toUpperCase();
    const turnId = `turn-${++session.turnSeq}`;
    session.turnId = turnId;
    session.promptRequestId = params?.__id;

    if (lower.includes('HANG')) {
      return; // 永不结束，交给宿主超时回收
    }

    /* CS3：慢回合 —— 先睡 N 毫秒再正常结束，用来制造「断线之后回包才到」。
       prompt 里写 SLOW:1500 即可。 */
    const slow = /SLOW:(\d{1,6})/.exec(lower);
    if (slow !== null) {
      await new Promise((resolve) => setTimeout(resolve, Number(slow[1])));
      if (session.turnId !== turnId) return; // 期间被取消：不再产出
      text(sessionId, 'slow done');
      endTurn(sessionId, 'end_turn');
      return;
    }

    if (lower.includes('CANCEL')) {
      text(sessionId, 'working');
      return; // 等 session/cancel
    }

    if (lower.includes('GARBAGE')) {
      // 必须写原始字节，不能经过 JSON.stringify（否则会变成合法 JSON 字符串）。
      if (io.raw) io.raw('this is definitely not json {]');
      else io.send('this is definitely not json {]');
      io.exit?.(1);
      return;
    }

    if (lower.includes('MCP_PERMISSION')) {
      /* CS2：MCP 形状的权限请求（server/tool/arguments 都在 rawInput 里），
         用来验「按票裁决」真的接在 ACP 层。 */
      const requestId = nextRequest++;
      const decisionPromise = new Promise((resolve) => pendingRequests.set(requestId, resolve));
      io.send({
        jsonrpc: '2.0',
        id: requestId,
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: {
            toolCallId: 'tc-mcp-1',
            title: 'mcp.opencut.film_apply_ops',
            kind: 'other',
            rawInput: { server: 'opencut', tool: 'film_apply_ops', arguments: { project: cwd, confirm: true } },
          },
          options: [
            { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
          ],
        },
      });
      const result = /** @type {any} */ (await decisionPromise);
      const decision = result?.decision === 'allow' || result?.outcome?.optionId === 'allow' ? 'allow' : 'deny';
      text(sessionId, `permission:${decision}`);
      endTurn(sessionId, 'end_turn');
      return;
    }

    if (lower.includes('PERMISSION')) {
      const requestId = nextRequest++;
      const decisionPromise = new Promise((resolve) => pendingRequests.set(requestId, resolve));
      io.send({
        jsonrpc: '2.0',
        id: requestId,
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: {
            toolCallId: 'tc-write-1',
            title: 'Write scenes/intro.html',
            kind: 'edit',
            rawInput: { path: 'scenes/intro.html' },
          },
          options: [
            { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
          ],
        },
      });
      const result = /** @type {any} */ (await decisionPromise);
      const decision =
        result?.decision === 'allow' || result?.outcome?.optionId === 'allow' ? 'allow' : 'deny';
      if (decision === 'allow') {
        await fs.writeFile(path.join(cwd, 'allowed.txt'), 'write allowed by host\n');
      }
      text(sessionId, `permission:${decision}`);
      endTurn(sessionId, 'end_turn');
      return;
    }

    if (lower.includes('TOOLS')) {
      io.send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-1',
            title: 'Read film.html',
            kind: 'read',
            rawInput: { path: 'film.html' },
          },
        },
      });
      toolUpdate(sessionId, 'tc-1', 'Read film.html', 'in_progress');
      toolUpdate(sessionId, 'tc-1', 'Read film.html', 'completed');
      io.send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: { sessionUpdate: 'usage_update', inputTokens: 11, outputTokens: 7 },
        },
      });
      text(sessionId, 'tools done');
      endTurn(sessionId, 'end_turn');
      return;
    }

    if (lower.includes('ECHO_CWD')) {
      text(sessionId, `cwd=${cwd}`);
      endTurn(sessionId, 'end_turn');
      return;
    }

    text(sessionId, 'Hello');
    text(sessionId, ' world');
    endTurn(sessionId, 'end_turn');
  };

  /**
   * @param {any} msg
   */
  const handle = async (msg) => {
    if (!msg || typeof msg !== 'object') return;

    // 宿主对我们请求的响应
    if (typeof msg.id === 'number' && 'result' in msg && !msg.method) {
      const resolve = pendingRequests.get(msg.id);
      if (resolve) {
        pendingRequests.delete(msg.id);
        resolve(msg.result);
      }
      return;
    }

    const method = msg.method;
    if (method === 'initialize') {
      // 形状与真实 ACP InitializeResponse 对齐（agentCapabilities / _meta）。
      respond(msg.id, {
        protocolVersion: 1,
        agentInfo: { name: 'mock-acp', title: 'Mock', version: '0.1.0-mock' },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, embeddedContext: true },
          auth: {},
        },
        authMethods: [{ id: 'none', name: 'Mock' }],
        _meta: { steering: { supported: true } },
      });
      return;
    }

    if (method === 'session/new') {
      const sessionId = `mock-session-${++nextSession}`;
      sessions.set(sessionId, { sessionId, cwd: msg.params?.cwd ?? cwd, turnId: null, turnSeq: 0 });
      respond(msg.id, {
        sessionId, cwd: msg.params?.cwd ?? cwd,
        ...(MODE === 'config-models'
          ? { configOptions: [{ id: 'engine', category: 'model', currentValue: 'fast',
              options: [{ value: 'fast', name: 'Fast' }, { value: 'edit', name: 'Edit' }] }] }
          : { models: { currentModelId: 'fixture-scene', availableModels: [{ modelId: 'fixture-scene', name: 'Fixture Scene' }] } }),
      });
      return;
    }

    if (method === 'session/set_config_option' && MODE === 'config-models') {
      if (sessions.has(msg.params?.sessionId) && msg.params.configId === 'engine' && msg.params.value === 'edit') respond(msg.id, {});
      else io.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'invalid configuration selection' } });
      return;
    }

    if (method === 'session/prompt') {
      // 不在这里先回响应：ACP 要等轮次真正结束（或取消）才回 stopReason。
      await runPrompt({ ...msg.params, __id: msg.id });
      return;
    }

    if (method === 'session/cancel') {
      const sessionId = String(msg.params?.sessionId ?? '');
      const session = sessions.get(sessionId);
      if (session?.turnId) {
        endTurn(sessionId, 'cancelled');
      }
      return;
    }
  };

  return { handle, sessions };
}

/**
 * @param {unknown} prompt
 * @returns {string}
 */
function extractPrompt(prompt) {
  if (typeof prompt === 'string') return prompt;
  if (Array.isArray(prompt)) {
    return prompt
      .map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text) : ''))
      .join(' ');
  }
  return '';
}

async function selftest() {
  /** @type {any[]} */
  const out = [];
  const mock = createMockAgent({ send: (m) => out.push(m), cwd: '/tmp/mock-selftest' });
  await mock.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert(out[0]?.result?.agentCapabilities?.promptCapabilities?.image === true, 'initialize capabilities');
  await mock.handle({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/tmp/a' } });
  const sid = out[1]?.result?.sessionId;
  assert(typeof sid === 'string', 'session/new returns id');
  out.length = 0;
  await mock.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'session/prompt',
    params: { sessionId: sid, prompt: [{ type: 'text', text: 'hi' }] },
  });
  const updates = out.filter((m) => m.method === 'session/update');
  const end = out.find((m) => m.id === 3 && m.result);
  assert(updates.length === 2, 'two text chunks');
  assert(end?.result?.stopReason === 'end_turn', 'prompt resolved with end_turn');
  console.log('mock-acp selftest: PASS');
}

/**
 * @param {boolean} cond
 * @param {string} label
 */
function assert(cond, label) {
  if (!cond) {
    console.error(`mock-acp selftest: FAIL (${label})`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (argv.includes('--selftest')) {
  await selftest();
  process.exit(0);
} else if (isMain || !process.env.NODE_TEST_CONTEXT) {
  if (MODE === 'garbage') {
    process.stdout.write('not json at all\n');
    process.exit(1);
  }
  const mock = createMockAgent({
    send: (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`),
    raw: (text) => process.stdout.write(`${text}\n`),
    exit: (code) => process.exit(code),
  });
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write('mock-acp: bad json from host\n');
      return;
    }
    void mock.handle(msg);
  });
  rl.on('close', () => process.exit(0));
}
