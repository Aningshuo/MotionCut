/**
 * 权限策略：默认拒绝。
 *
 * 本文件刻意 **不实现** 任何一键放行开关（`--allow-all` / `bypassPermissions` /
 * `yolo` / `--dangerously-skip-permissions`）。传入这些参数会被直接拒绝，
 * 而不是被忽略——静默忽略等于给了用户一个「以为放行了」的假象。
 *
 * @typedef {import('../../contracts/agent').PermissionRequest} PermissionRequest
 * @typedef {'fs_write' | 'fs_read' | 'shell' | 'network' | 'other'} PermissionKind
 */

/** 明确禁止的放行参数（大小写不敏感）。 */
const BYPASS_ARG_PATTERNS = [
  /^-{0,2}(?:allow-?all)$/i,
  /^-{0,2}(?:bypass-?permissions?)$/i,
  /^-{0,2}(?:dangerously-skip-permissions)$/i,
  /* codex 的真名（实测 CLI 0.159 的开关）：不止「跳过权限」，还跳过整个沙箱。 */
  /^-{0,2}(?:dangerously-bypass-approvals-and-sandbox)$/i,
  /^-{0,2}(?:bypass-approvals-and-sandbox)$/i,
  /^-{0,2}yolo$/i,
  /^-y$/i,
];

export class PermissionPolicyError extends Error {
  /**
   * @param {'BYPASS_FLAG_REJECTED'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'PermissionPolicyError';
    this.code = code;
  }
}

/**
 * 启动任何 Agent 进程前调用。发现放行参数立即抛错。
 * @param {readonly string[]} argv
 * @returns {void}
 */
export function assertNoBypassArgs(argv) {
  for (const arg of argv) {
    if (BYPASS_ARG_PATTERNS.some((re) => re.test(arg))) {
      throw new PermissionPolicyError(
        'BYPASS_FLAG_REJECTED',
        `BYPASS_FLAG_REJECTED: refusing to launch agent with bypass flag ${arg} (permissions default to deny)`,
      );
    }
  }
}

/**
 * 把 ACP 工具调用归一成合同里的五类权限。
 * @param {unknown} name
 * @param {unknown} input
 * @returns {PermissionKind}
 */
export function classifyToolRequest(name, input) {
  const tool = typeof name === 'string' ? name.toLowerCase() : '';
  if (/(write|edit|patch|delete|move|rename|mkdir|apply)/.test(tool)) return 'fs_write';
  if (/(read|list|glob|grep|search|view)/.test(tool)) return 'fs_read';
  if (/(shell|bash|terminal|exec|command|run)/.test(tool)) return 'shell';
  if (/(fetch|http|browser|network|download|upload|web)/.test(tool)) return 'network';
  if (input && typeof input === 'object') {
    const keys = Object.keys(input);
    if (keys.some((k) => /(path|file|dir)/i.test(k))) return 'fs_write';
    if (keys.some((k) => /(url|uri|host)/i.test(k))) return 'network';
    if (keys.some((k) => /(command|cmd|argv|shell)/i.test(k))) return 'shell';
  }
  return 'other';
}

/**
 * 构造合同要求的权限请求；`default` 永远是 deny。
 * @param {PermissionKind} kind
 * @param {string} detail
 * @returns {PermissionRequest}
 */
export function buildPermissionRequest(kind, detail) {
  return { kind, detail, default: 'deny' };
}

/**
 * 权限决策器。默认模式 `deny`：任何请求都立刻拒绝，只有用户显式
 * `allow` 才放行（`ask` 模式下由 UI 调用）。
 *
 * 注意：这里没有 `allowAll` 模式，也不接受通配路径。
 */
export class PermissionBroker {
  /** @type {'deny' | 'ask'} */
  #mode;
  /** @type {((request: PermissionRequest) => Promise<'allow' | 'deny'> | 'allow' | 'deny') | null} */
  #onRequest;
  #timeoutMs;
  /**
   * 受控工具策略。**没有默认放行**：不传 = 所有工具都走 deny/ask。
   * CS2（R30-125）起由 `tool-grant.mjs#grantAuthorizer()` 提供，按票裁决；
   * 返回 `false` 表示「这张票不认」，交回 deny/ask 模式；返回 `null` 同理。
   * @type {((subject: { server: string | null, tool: string }, context: { args: any, cwd: string | null, requestId: string | null, toolCallId: string | null }) => boolean | { decision?: string, hard?: boolean } | null) | null}
   */
  #allowControl;

  /**
   * @param {{
   *   mode?: 'deny' | 'ask',
   *   onRequest?: ((request: PermissionRequest) => Promise<'allow' | 'deny'> | 'allow' | 'deny') | null,
   *   timeoutMs?: number,
   *   allowControl?: ((subject: { server: string | null, tool: string }, context?: any) => boolean | { decision?: string, hard?: boolean } | null) | null,
   *   allowAll?: boolean,
   *   bypass?: boolean,
   *   yolo?: boolean,
   * }} [opts]
   */
  constructor(opts = {}) {
    /* 一键放行必须**炸**，不能静默降级：静默忽略等于给调用方一个「以为放行了」的假象，
       而 yolo/allow-all 一旦被当成 truthy 传进来，最坏的结果是全部 allow。 */
    const forbidden = /** @type {any} */ (opts);
    if (forbidden?.allowAll === true || forbidden?.bypass === true || forbidden?.yolo === true || forbidden?.mode === 'allow') {
      throw new PermissionPolicyError(
        'BYPASS_FLAG_REJECTED',
        'BYPASS_FLAG_REJECTED: PermissionBroker 不接受 allow-all / yolo / bypass（权限默认拒绝，只有用户逐次允许才放行）',
      );
    }
    this.#mode = opts.mode === 'ask' ? 'ask' : 'deny';
    this.#onRequest = opts.onRequest ?? null;
    this.#allowControl = opts.allowControl ?? null;
    // 超时同样落到 deny；0 表示立即。
    this.#timeoutMs = Number.isFinite(opts.timeoutMs) ? Math.max(0, Number(opts.timeoutMs)) : 0;
  }

  /** @returns {'deny' | 'ask'} */
  get mode() {
    return this.#mode;
  }

  /**
   * 决定一次权限请求。默认拒绝，且永不返回未定义。
   * @param {PermissionRequest} request
   * @param {{ server: string | null, tool: string } | null} [subject] 机器可读的工具身份（受控工具策略用）
   * @param {{ args?: any, cwd?: string | null, requestId?: string | null, toolCallId?: string | null }} [context]
   * @returns {Promise<'allow' | 'deny'>}
   */
  async decide(request, subject = null, context = {}) {
    /* 受控工具先判：**按票**放行（CS2）。票没签、过期、工程不符、工具不在表里都不放；
       票不认时返回 false/记录而不是 allow —— 「没有票」永远不等于「放行」。 */
    if (subject && this.#allowControl) {
      const verdict = this.#allowControl(subject, {
        args: context?.args ?? null,
        cwd: context?.cwd ?? null,
        requestId: context?.requestId ?? null,
        toolCallId: context?.toolCallId ?? null,
      });
      if (verdict === true) return 'allow';
      if (verdict !== null && typeof verdict === 'object' && /** @type {any} */ (verdict).decision === 'allow') return 'allow';
      if (verdict !== null && typeof verdict === 'object' && /** @type {any} */ (verdict).decision === 'deny' && /** @type {any} */ (verdict).hard === true) return 'deny';
    }
    if (this.#mode !== 'ask' || !this.#onRequest) return 'deny';

    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve('deny'), this.#timeoutMs);
      timer.unref?.();
    });

    try {
      const answer = await Promise.race([
        Promise.resolve(this.#onRequest(request)).catch(() => 'deny'),
        timeout,
      ]);
      return answer === 'allow' ? 'allow' : 'deny';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * 从 ACP 的 options 里挑一个与决策一致的 optionId。
 * 默认拒绝时优先 `reject_once`（只拒绝本次，不写永久策略）。
 * @param {ReadonlyArray<{ optionId?: unknown, kind?: unknown }>} options
 * @param {'allow' | 'deny'} decision
 * @returns {string | null}
 */
export function selectPermissionOption(options, decision) {
  const usable = (options ?? []).filter(
    (option) => option && typeof option.optionId === 'string' && option.optionId.length > 0,
  );
  const preferred = decision === 'allow' ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  for (const kind of preferred) {
    const match = usable.find((option) => option.kind === kind);
    if (match) return /** @type {string} */ (match.optionId);
  }
  // 对端没按 ACP 的 kind 标注时，只能按语义名兜底；仍然只认「一次」，不认永久放行。
  const fallback = decision === 'allow' ? /allow/i : /deny|reject|cancel/i;
  for (const option of usable) {
    if (fallback.test(/** @type {string} */ (option.optionId))) return /** @type {string} */ (option.optionId);
  }
  return null;
}

/**
 * 写入沙箱判定：只允许工程目录内、且不在 denyWrite 列表里的路径。
 * 纯函数，供 ACP 侧在真正落盘前复核。
 * @param {import('../../contracts/agent').AgentSandboxPolicy} policy
 * @param {string} absolutePath
 * @returns {{ ok: true } | { ok: false, reason: 'OUTSIDE_WORKSPACE' | 'DENY_WRITE' }}
 */
export function isWriteAllowed(policy, absolutePath) {
  const normalize = (/** @type {string} */ p) => (p.endsWith('/') ? p.slice(0, -1) : p);
  const target = normalize(absolutePath);
  const inAllow = policy.allowWriteUnder.some((root) => {
    const r = normalize(root);
    return target === r || target.startsWith(`${r}/`);
  });
  if (!inAllow) return { ok: false, reason: 'OUTSIDE_WORKSPACE' };
  const denied = policy.denyWrite.some((root) => {
    const r = normalize(root);
    return target === r || target.startsWith(`${r}/`);
  });
  if (denied) return { ok: false, reason: 'DENY_WRITE' };
  return { ok: true };
}
