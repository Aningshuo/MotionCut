/**
 * ACP 场景 provider（CS2 · R30-125）：把 GUI 的「一句话生成场景」接到真实 Codex。
 *
 * ## 为什么要有这一层
 *
 * CS1 证明了 ACP 会话能开、受控工具能用，但那个链路只在验收脚本里跑过 ——
 * GUI 的 `/api/agent/scene` 只认 mock/http provider（`providers.mjs` 里明写着
 * 「ACP 会话还没接进这条链路」）。这一层就是那条缺失的接线：
 *
 *   GUI 面板 → /api/agent/scene → 本 provider → codex-acp 会话 → MCP 受控工具
 *
 * ## 两种请求分开走
 *
 * - **普通问答**：不要求 ops。agent 只回文字 → 这里回 `{ops: [], summary}`，
 *   `agent-scene` 认 `allowTextOnly`，草稿标 `textOnly`，不写盘、不进撤销栈。
 * - **剪辑请求**：agent 先 `film_read`，再用 `film_propose_ops` 交提案。提案在
 *   **MCP 侧已经按当前文档校验过**（touched/inverse 都真算过）；这里把提案原样
 *   交给草稿，用户在面板上点「应用」才走 `/ops` 写盘 —— 这样「停止/取消」时
 *   不存在「写了一半」的善后问题。
 *
 * ## 取消
 *
 * 面板的 Stop 走 `/api/agent/runs/:id/cancel` → `AbortSignal` → 这里调
 * `sessions.cancel(sessionId, turnId)`，并**等 turn_end 到终态**再抛 `RUN_CANCELLED`。
 * 迟到事件不参与 ops 收集：abort 之后一律不返回本次结果。
 */

import path from 'node:path';

/**
 * 给 agent 的操作说明。不写死片段 id —— 它自己用 film_read 读。
 * @param {string} prompt
 * @param {{ projectId?: string, projectDir?: string }} [opts]
 */
export function buildAcpPrompt(prompt, opts = {}) {
  const target = typeof opts.projectId === 'string' && opts.projectId !== '' ? opts.projectId : '当前工程';
  const dir = typeof opts.projectDir === 'string' && opts.projectDir !== '' ? opts.projectDir : '';
  return [
    `你在 OpenCut Studio 里剪片，工程是「${target}」，工程目录（也就是你的工作目录）是：${dir === '' ? '（未提供）' : dir}`,
    dir === '' ? '' : `调用 MCP 工具时，project 参数**原样传这个绝对路径**：${dir}（不要用工程 id/hash 当路径）。`,
    '你只能通过 MCP 工具操作工程，禁止直接编辑 film.html、禁止 shell / 文件读写：',
    '- `mcp.opencut.film_read`：读工程（参数 project 传上面的绝对路径），拿 sourceHash 与片段 id；',
    '- `mcp.opencut.film_propose_ops`：提交编辑提案（只校验、不写盘）。',
    '- `mcp.opencut.creation_library_read`：读实际素材库、可编辑网页资源、字幕/配音能力、转场和sourceHash；不可用服务不能当作已经完成。',
    '- `mcp.opencut.creation_library_action`：用库中的真实itemId应用文字/模板/滤镜/转场或处理字幕；需要confirm:true、稳定request.opId，film写要request.expectedHash。复用当前工程写票，拒绝或待授权就停下来等用户处理。',
    'Op 方言（clip 是片段 id）：',
    '- 改文字/颜色（page 片段）：{"op":"overrides","clip":"<page id>","entries":[{"at":"#title","t":"新标题","style":{"color":"#ff6b6b"}}]}',
    '- 单字段：{"op":"set","clip":"a","field":"volume","value":0.5}',
    '- 改区间/位置：{"op":"fields","clip":"a","fields":{"time":[0,3]}} / {"op":"move","clip":"b","at":4.5}',
    '- 分割：{"op":"split","clip":"a","at":1.5}（at 是时间线秒数，右半自动命名）',
    '把这次要做的**所有**编辑放进一次 film_propose_ops 调用里，不要分多次。',
    '完成后用一句中文说明你改了什么（不要贴 JSON）。',
    '',
    '用户请求：',
    prompt,
  ].join('\n');
}

/**
 * @param {{
 *   sessions: import('./acp.mjs').AgentSessions,
 *   projectIdOf?: (projectDir: string) => string | null,
 *   providerId?: string,
 *   label?: string,
 *   agentId?: string,
 *   log?: (line: string) => void,
 *   onTurnStart?: ((info: { sessionId: string, turnId: string | null, runId: string | null }) => void) | null,
 *   onTurnEnd?: ((info: { sessionId: string, turnId: string | null }) => void) | null,
 * }} options
 */
export function createAcpSceneProvider(options) {
  const sessions = options.sessions;
  const providerId = options.providerId ?? 'acp-codex';
  const label = options.label ?? 'Codex（ACP 会话）';
  const agentId = options.agentId ?? 'codex';
  const log = options.log ?? (() => {});

  /** @type {Map<string, string>} projectId → ACP sessionId（同工程复用同一会话） */
  const byProject = new Map();

  /** @param {string} projectId @param {string | null} [runId] */
  async function ensureSession(projectId, runId = null) {
    const known = byProject.get(projectId);
    if (known !== undefined) {
      const state = sessions.inspect(known);
      /* CS3：run 变了要重开 —— 票绑的是「开这个会话时那一趟 run」，
         复用上一趟的会话等于让新 run 用旧票。 */
      if (state !== null && state.alive === true && state.state !== 'ERROR' && (runId === null || state.runId === runId)) {
        return known;
      }
      byProject.delete(projectId);
      if (state?.alive && !state.turnId) await sessions.close(known);
    }
    const opened = await sessions.open(projectId, agentId, runId === null ? {} : { runId });
    if ('error' in opened) {
      const error = new Error(`${opened.error}: 会话开不起来（project=${projectId}）`);
      // @ts-expect-error 稳定错误码
      error.code = opened.error;
      throw error;
    }
    byProject.set(projectId, opened.sessionId);
    return opened.sessionId;
  }

  /**
   * @param {{
   *   doc: any,
   *   prompt: string,
   *   projectId: string,
   *   projectDir: string,
   *   runId?: string,
   *   signal?: AbortSignal | null,
   *   seed?: string,
   *   selection?: {model:string,thinking:string|null},
   * }} input
   */
  async function generate(input) {
    const projectId = String(input.projectId ?? '');
    if (projectId === '') throw Object.assign(new Error('ACP provider 需要 projectId'), { code: 'BAD_REQUEST' });
    const sessionId = await ensureSession(projectId, typeof input.runId === 'string' && input.runId !== '' ? input.runId : null);
    if (input.selection) {
      const wireModel = await sessions.selectModel(sessionId, input.selection.model, input.selection.thinking);
      log(`ACP_SCENE_MODEL session=${sessionId} model=${wireModel}`);
    }
    const prompt = buildAcpPrompt(input.prompt, { projectId, projectDir: input.projectDir });

    /** @type {{ proposal: { id: string, ops: any[], tool: string, ok: boolean } | null, text: string, events: string[] }} */
    const acc = { proposal: null, text: '', events: [] };
    /** @type {Map<string, { tool: string, ops: any[], requestedAt: number }>} */
    const calls = new Map();

    const sent = await sessions.send(sessionId, prompt);
    if ('error' in sent) {
      throw Object.assign(new Error(`${sent.error}: 回合没发出去`), { code: sent.error });
    }
    const turnId = sent.turnId ?? null;
    log(`ACP_SCENE_TURN session=${sessionId} turn=${String(turnId)} project=${projectId}`);
    /* CS3：票要绑到这一回合（turnId）。绑完才有工具权限；回合结束立刻解绑。 */
    try {
      options.onTurnStart?.({ sessionId, turnId, runId: typeof input.runId === 'string' && input.runId !== '' ? input.runId : null });
    } catch {
      /* 绑票失败不该把回合弄挂：没有票 = 工具全拒，这是安全侧默认。 */
    }

    let aborted = false;
    let completed = false;
    const onAbort = () => {
      aborted = true;
      /* 取消是服务端语义：先停这一 run，再等 turn_end。**不**在这里直接抛错 ——
         队列里的尾部事件要走到终态，会话才不会卡在 BUSY。 */
      if (turnId !== null) void sessions.cancel(sessionId, turnId).catch(() => undefined);
    };
    if (input.signal) {
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      for await (const raw of sessions.events(sessionId)) {
        /** @type {any} */
        const event = raw;
        acc.events.push(event.type);
        if (event.type === 'text') acc.text += String(event.text ?? '');
        if (event.type === 'tool_start') {
          const raw = event.input;
          const tool = raw !== null && typeof raw === 'object' ? String(/** @type {any} */ (raw).tool ?? '') : '';
          const args = raw !== null && typeof raw === 'object' ? /** @type {any} */ (raw).arguments ?? {} : {};
          if (tool === 'film_propose_ops') {
            calls.set(String(event.id ?? ''), {
              tool,
              ops: Array.isArray(args.ops) ? args.ops : [],
              requestedAt: Date.now(),
            });
          }
        }
        if (event.type === 'tool_end') {
          const call = calls.get(String(event.id ?? ''));
          if (call !== undefined) {
            /* 同一回合可能有多次提案：按出现顺序拼接（后一次基于前一次的结果）。 */
            if (event.ok === true && event.output?.isError !== true && event.output?.structuredContent?.ok !== false) {
              if (acc.proposal === null) acc.proposal = { id: String(event.id ?? ''), ops: [], tool: call.tool, ok: true };
              acc.proposal.ops.push(...call.ops);
            } else {
              acc.proposal = acc.proposal ?? { id: String(event.id ?? ''), ops: [], tool: call.tool, ok: false };
              acc.proposal.ok = false;
            }
          }
        }
        if (event.type === 'turn_end') {
          if (!aborted && event.reason !== 'done') {
            const detail = sessions.inspect(sessionId)?.lastError ?? event.error ?? event.reason;
            throw Object.assign(new Error(String(detail)), { code: event.error ?? 'ACP_TURN_FAILED' });
          }
          completed = event.reason === 'done';
          break;
        }
      }
    } finally {
      input.signal?.removeEventListener?.('abort', onAbort);
      try {
        options.onTurnEnd?.({ sessionId, turnId });
      } catch {
        /* 解绑失败：票会在会话关闭/过期时被收回，这里不额外放大错误。 */
      }
    }

    if (aborted) {
      throw Object.assign(new Error('这次生成已被取消：迟到结果不返回、草稿不建'), { code: 'RUN_CANCELLED' });
    }

    if (!completed) throw Object.assign(new Error('模型连接在回合完成前关闭'), { code: 'ACP_TURN_INCOMPLETE' });
    if (acc.proposal?.ok === false) throw Object.assign(new Error('剪辑提案未通过工具校验'), { code: 'PROPOSE_REJECTED' });

    const ops = acc.proposal?.ops ?? [];
    /** @type {string[]} */
    const targets = [];
    for (const op of ops) {
      const id = typeof op?.clip === 'string' ? op.clip : '';
      if (id !== '' && !targets.includes(id)) targets.push(id);
    }
    const summary = acc.text.trim();
    /** @type {string[]} */
    const warnings = [];
    if (ops.length === 0 && summary === '') throw Object.assign(new Error('模型没有返回文字或剪辑提案'), { code: 'EMPTY_TURN' });

    log(`ACP_SCENE_RESULT session=${sessionId} ops=${String(ops.length)} targets=${String(targets.length)} text=${String(summary.length)}`);

    return {
      provider: providerId,
      generatedBy: 'acp-session',
      model: input.selection?.model ?? null,
      ops,
      files: [],
      targets,
      summary,
      warnings,
      /** `agent-scene` 用它决定「纯问答草稿」是否合法。 */
      textOnly: ops.length === 0,
    };
  }

  return {
    id: providerId,
    label,
    mock: false,
    /** 只有 ACP 引擎允许「一句人话、零 ops」的草稿。 */
    allowTextOnly: true,
    generate,
    /** 会话复用表（inspect/交接用）。 */
    sessionOf: (/** @type {string} */ projectId) => byProject.get(projectId) ?? null,
    dispose: async () => {
      byProject.clear();
      await sessions.dispose();
    },
  };
}

/**
 * 解析 `film.html` 所在工程的 id（给 provider 的 `projectIdOf` 用）。
 * @param {string} projectDir
 */
export function projectIdOf(projectDir) {
  return path.basename(String(projectDir));
}
