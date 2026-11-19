/**
 * CLI 输出/入参的 JSON Schema（WP18）。
 *
 * 这里是 **CLI 自己的信封**：`{ok, ...}` 与稳定的错误码。`FilmDoc` 本体属于
 * `contracts/film-doc.ts`（main 的解析器产出），CLI 只声明它是 object，
 * 不复制一份 doc schema——复制一份就等于给合同开了第二个真源。
 */

export const HASH = { type: 'string', pattern: '^[0-9a-f]{64}$' };

export const SOURCE_HASH = HASH;

/** `contracts/edit-ops.ts` 的 Envelope。 */
export const envelope = {
  type: 'object',
  required: ['projectId', 'batchId', 'owner', 'expectedHash', 'opId'],
  additionalProperties: false,
  properties: {
    projectId: { type: 'string', minLength: 1 },
    batchId: { type: 'string', minLength: 1 },
    owner: { type: 'string', enum: ['MAIN', 'SUB1', 'SUB2', 'BRAIN'] },
    expectedHash: { ...HASH },
    opId: { type: 'string', minLength: 1, maxLength: 200 },
  },
};

/**
 * Op 只校验"它是个带 op 字段的对象"：Op 的联合类型在合同里，
 * 这里再写一份字段白名单就是第二套语义。
 */
export const op = {
  type: 'object',
  required: ['op'],
  properties: { op: { type: 'string', minLength: 1 } },
};

/** `film apply --ops <file>` 的文件形态。 */
export const opsFile = {
  type: 'object',
  required: ['envelope', 'ops'],
  additionalProperties: false,
  properties: {
    envelope,
    ops: { type: 'array', minItems: 1, maxItems: 1000, items: op },
  },
};

const diagnostics = {
  type: 'array',
  items: {
    type: 'object',
    required: ['code', 'message', 'severity'],
    properties: {
      code: { type: 'string', minLength: 1 },
      message: { type: 'string' },
      severity: { type: 'string', enum: ['error', 'warning'] },
    },
  },
};

/** `film read` 的输出（P5-A1 就校这个）。 */
export const filmReadOutput = {
  type: 'object',
  required: ['ok', 'project', 'sourceHash', 'doc', 'diagnostics'],
  additionalProperties: false,
  properties: {
    ok: { const: true },
    project: { type: 'string', minLength: 1 },
    sourceHash: { ...HASH },
    doc: { type: ['object', 'null'] },
    diagnostics,
  },
};

/** `project info` 的输出：只放摘要，不放整份 doc。 */
export const projectInfoOutput = {
  type: 'object',
  required: ['ok', 'project', 'sourceHash', 'stage', 'fps', 'tracks', 'clips', 'diagnostics'],
  additionalProperties: false,
  properties: {
    ok: { const: true },
    project: { type: 'string', minLength: 1 },
    sourceHash: { ...HASH },
    stage: {
      type: ['object', 'null'],
      properties: { w: { type: 'number' }, h: { type: 'number' } },
    },
    fps: {
      type: ['object', 'null'],
      properties: {
        num: { type: 'number' },
        den: { type: 'number' },
        value: { type: ['number', 'null'] },
      },
    },
    tracks: {
      type: 'object',
      required: ['total', 'byRole', 'locked', 'hidden', 'muted'],
      properties: {
        total: { type: 'integer', minimum: 0 },
        byRole: {
          type: 'object',
          required: ['picture', 'audio', 'subtitle', 'page'],
          properties: {
            picture: { type: 'integer', minimum: 0 },
            audio: { type: 'integer', minimum: 0 },
            subtitle: { type: 'integer', minimum: 0 },
            page: { type: 'integer', minimum: 0 },
          },
        },
        locked: { type: 'integer', minimum: 0 },
        hidden: { type: 'integer', minimum: 0 },
        muted: { type: 'integer', minimum: 0 },
      },
    },
    clips: {
      type: 'object',
      required: ['total', 'byKind'],
      properties: {
        total: { type: 'integer', minimum: 0 },
        byKind: {
          type: 'object',
          required: ['video', 'sound', 'page', 'still'],
          properties: {
            video: { type: 'integer', minimum: 0 },
            sound: { type: 'integer', minimum: 0 },
            page: { type: 'integer', minimum: 0 },
            still: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
    diagnostics: {
      type: 'object',
      required: ['total', 'errors', 'warnings'],
      properties: {
        total: { type: 'integer', minimum: 0 },
        errors: { type: 'integer', minimum: 0 },
        warnings: { type: 'integer', minimum: 0 },
      },
    },
  },
};

export const projectListOutput = {
  type: 'object',
  required: ['ok', 'projects'],
  additionalProperties: false,
  properties: {
    ok: { const: true },
    projects: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'path'],
        properties: {
          id: { type: 'string', minLength: 1 },
          name: { type: 'string' },
          path: { type: 'string', minLength: 1 },
        },
      },
    },
  },
};

/** `film apply` 的输出。`replayed=true` 表示同 opId 重放，没有第二次写盘。 */
export const filmApplyOutput = {
  type: 'object',
  required: ['ok', 'project', 'hash', 'opId'],
  additionalProperties: false,
  properties: {
    ok: { const: true },
    project: { type: 'string', minLength: 1 },
    hash: { ...HASH },
    opId: { type: 'string', minLength: 1 },
    replayed: { type: 'boolean' },
    touched: { type: 'array', items: { type: 'string' } },
    dryRun: { type: 'boolean' },
    ops: { type: 'integer', minimum: 0 },
  },
};

export const exportStartOutput = {
  type: 'object',
  required: ['ok', 'jobId'],
  additionalProperties: false,
  properties: {
    ok: { const: true },
    jobId: { type: 'string', minLength: 1 },
    state: { type: 'string' },
    dryRun: { type: 'boolean' },
    spec: { type: 'object' },
    // P47：detached worker 的 pid（宿主可以据此判断作业是否还活着）
    pid: { type: 'integer', minimum: 0 },
  },
};

export const exportStatusOutput = {
  type: 'object',
  required: ['ok', 'jobId', 'state'],
  additionalProperties: true,
  properties: {
    ok: { const: true },
    jobId: { type: 'string', minLength: 1 },
    state: { type: 'string', enum: ['waiting', 'running', 'done', 'failed', 'cancelled'] },
    framesDone: { type: 'integer', minimum: 0 },
    framesTotal: { type: 'integer', minimum: 0 },
    // P49：取帧 / 编码两个阶段（长工程靠它区分「在画网页」和「在编码」）。
    // 不写 enum：`RenderQueue` 的 stage 是另一条轴（validate/audio/frames/encode/mux/verify…），
    // 两个端口共用这个字段，写死枚举会把它挡在 schema 外面。
    stage: { type: 'string' },
    // P50：崩溃回收标记（本次 status 顺手清掉了 partial/lock/pid）
    reaped: { type: 'boolean' },
  },
};

export const exportCancelOutput = {
  type: 'object',
  required: ['ok', 'jobId'],
  additionalProperties: true,
  properties: {
    ok: { const: true },
    jobId: { type: 'string', minLength: 1 },
    state: { type: 'string', enum: ['waiting', 'running', 'done', 'failed', 'cancelled'] },
  },
};

/** 失败输出：stdout 上永远只有 `{ok:false, error:{code,...}}` 这一种形态。 */
export const errorOutput = {
  type: 'object',
  required: ['ok', 'error'],
  additionalProperties: true,
  properties: {
    ok: { const: false },
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string', minLength: 1 },
        message: { type: 'string' },
        currentHash: { ...HASH },
      },
    },
  },
};

export const SCHEMAS = Object.freeze({
  envelope,
  opsFile,
  filmReadOutput,
  projectInfoOutput,
  projectListOutput,
  filmApplyOutput,
  exportStartOutput,
  exportStatusOutput,
  exportCancelOutput,
  errorOutput,
});
