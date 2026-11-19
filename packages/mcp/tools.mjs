/**
 * MCP tools 声明与实现（WP18）。
 *
 * 五个 tool 全部映射到 `packages/cli/ops.mjs` 的同一套动作——CLI 能做的事，
 * MCP 才做得到；CLI 拒绝的事（越界、没 --allow-write），MCP 也拒绝。
 *
 * 声明都带 JSON Schema（`tools/list` 要完整）；写类 tool 额外带
 * `annotations.readOnlyHint=false`，并且**默认关闭**，必须显式 `--allow-write`。
 */

import path from 'node:path';

import { CliError } from '../cli/errors.mjs';
import { applyOps, applyCreationLibrary, readCreationLibrary, exportStatus, listProjects, proposeOps, readFilm, startExport } from '../cli/ops.mjs';

/** @typedef {{ name: string, title: string, description: string, inputSchema: object, write: boolean, example?: Record<string, unknown>, run: (args: any) => Promise<any> }} Tool */

const projectProp = { type: 'string', minLength: 1, description: '工程目录（绝对路径，或相对沙箱根/CWD 的路径）' };
const jobIdProp = { type: 'string', minLength: 1, description: 'export_start 返回的 jobId' };

/**
 * @param {import('../cli/ops.mjs').Context} ctx
 * @param {{ allowWrite?: boolean, studio?: { baseUrl: string, grantId: string, projectId?: string } }} [opts]
 * @returns {Tool[]}
 */
export function createTools(ctx, opts = {}) {
  const allowWrite = opts.allowWrite === true;
  /* CS2：给了 Studio 写入口时，`film_apply_ops` 走 `/api/projects/:id/ops`（进撤销栈），
     不再本地直写 film.html。没有就维持原行为（CLI / 独立 MCP 场景）。 */
  const studio = opts.studio !== undefined && opts.studio !== null ? opts.studio : null;

  /**
   * 写类门禁分两层：
   * 1. 启动开关 `--allow-write`（缺了就 E_WRITE_DENIED）；
   * 2. **每次调用**的 `confirm: true`（缺了就 E_CONFIRM_REQUIRED，并回一个正确示例）。
   * 只有第一层时，一个误配置的服务会替所有调用方长期放行；第二层让"这一次"
   * 也必须有人明确点头。
   * @param {string} name
   * @param {unknown} confirm
   * @param {Record<string, unknown>} example
   */
  function requireWrite(name, confirm, example) {
    if (!allowWrite) {
      throw new CliError(
        'E_WRITE_DENIED',
        `${name} is a write tool: restart the server with --allow-write to enable it`,
        { example },
      );
    }
    if (confirm !== true) {
      throw new CliError(
        'E_CONFIRM_REQUIRED',
        `${name} needs per-call confirmation: pass "confirm": true (the startup flag alone is not consent for this call)`,
        { example },
      );
    }
  }

  /** @param {{ projectId: string, confirm: true }} [request] */
  async function projectNavigation(request) {
    if (!studio?.projectId || !studio.grantId) {
      throw new CliError('NEEDS_STUDIO', '项目导航需要 MotionCut 内已运行的 Agent 会话');
    }
    const base = new URL(studio.baseUrl);
    if (base.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) || base.username || base.password) {
      throw new CliError('E_USAGE', '项目导航需要本机 Studio 地址');
    }
    const url = new URL(`/api/projects/${encodeURIComponent(studio.projectId)}/agent/project-navigation`, base);
    const response = await fetch(url, {
      redirect: 'error',
      headers: {
        'x-opencut-agent-grant': studio.grantId,
        ...(request === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(request === undefined ? {} : { method: 'POST', body: JSON.stringify(request) }),
    }).catch(() => { throw new CliError('STUDIO_UNREACHABLE', '无法联系本机 MotionCut'); });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.ok !== true) {
      throw new CliError(result?.code ?? 'E_OUTPUT_INVALID', result?.message ?? '项目导航失败');
    }
    return result;
  }

  return [
    {
      name: 'project_list',
      title: 'Project list',
      description: '列出沙箱内的工程（只读）。',
      write: false,
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      run: async () => ({ ok: true, projects: await listProjects(ctx) }),
    },
    ...(studio?.projectId ? [
      {
        name: 'project_navigation_list',
        title: 'MotionCut project catalog',
        description: '列出可在 MotionCut 中打开的本地项目的项目 ID、名称和路径。此工具仅提供导航目录，不授予对其他项目的编辑权限。',
        write: false,
        inputSchema: { type: 'object', additionalProperties: false, properties: {} },
        run: async () => projectNavigation(),
      },
      {
        name: 'project_open',
        title: 'Open a MotionCut project',
        description: '按 project_navigation_list 返回的确切 projectId 请求 MotionCut 打开或聚焦该项目。重名时先按路径核对，禁止猜测。当前 Agent 会话仍属于原项目，要编辑目标项目请在目标标签内开始对话。',
        write: true,
        inputSchema: {
          type: 'object', additionalProperties: false, required: ['projectId', 'confirm'],
          properties: { projectId: { type: 'string', pattern: '^[0-9a-f]{16}$' }, confirm: { type: 'boolean' } },
        },
        run: async (/** @type {any} */ args) => {
          const example = { projectId: args.projectId, confirm: /** @type {const} */ (true) };
          requireWrite('project_open', args.confirm, example);
          return projectNavigation(example);
        },
      },
    ] : []),
    {
      name: 'film_read',
      title: 'Film read',
      description: '读取 film.html，返回规范化 FilmDoc 与 sourceHash（只读）。',
      write: false,
      inputSchema: { type: 'object', additionalProperties: false, required: ['project'], properties: { project: projectProp } },
      run: async (args) => readFilm(ctx, args.project),
    },
    {
      name: 'film_apply_ops',
      title: 'Film apply ops',
      /* CS1（R30-124）：以前 description 只有一句「按 Envelope 应用一批 Op」，`ops` 里能写什么全靠猜，
         example 还示范了一个**不存在的字段**（`{op:'set', field:'title'}`）—— 实测 agent 读完
         film_read 之后自己去 spawn 子 agent 反推 op 形状，最后一版没写成。工具面自己说清楚方言，
         比让模型猜便宜得多。 */
      description: [
        '按 Envelope（expectedHash + opId）应用一批 Op；写类，需 --allow-write。整批原子：任一 Op 失败则该批不写盘。',
        'Op 方言（与 film-core 同一套，clip 是片段 id）：',
        '- 改文字/改字段：{"op":"fields","clip":"title","fields":{"text":"新标题"}}（fields 可含 at/time/volume/speed/fade/src/style/box/size）',
        '- 单字段：{"op":"set","clip":"a","field":"volume","value":0.5}（field ∈ at/time/volume/speed/fade/text/src/box/size/link/props/overrides）',
        '- 分割：{"op":"split","clip":"a","at":1.5}（at 是**时间线**秒数；右半自动命名 a-b）',
        '- 移动：{"op":"move","clip":"a","at":2}；删除：{"op":"remove","clip":"a"}；插入：{"op":"insert","clip":{"src":"assets/x.mp4","at":0,"time":[0,3]}}',
        '一次调用可以带多条 ops，按顺序应用；要「同时改标题 + 分割」就放同一批里。',
      ].join('\n'),
      write: true,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['project', 'expectedHash', 'opId', 'ops'],
        properties: {
          project: projectProp,
          expectedHash: { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'film_read 返回的 sourceHash（原样回传）' },
          opId: { type: 'string', minLength: 1, maxLength: 200, description: '幂等键；同一 opId 重放返回首次结果' },
          ops: {
            type: 'array',
            minItems: 1,
            maxItems: 1000,
            items: {
              type: 'object',
              required: ['op'],
              properties: {
                op: { type: 'string', description: 'fields | set | split | move | insert | remove | props | track | reorder' },
                clip: { oneOf: [{ type: 'string', description: '既有片段 id' }, { type: 'object', required: ['src'], properties: { id: { type: 'string' }, src: { type: 'string' }, kind: { type: 'string' }, time: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } } }], description: 'fields/set/split/move/remove传id；insert传包含src的完整片段对象' },
                track: { oneOf: [{ type: 'integer', minimum: 0 }, { type: 'object', required: ['insert'], properties: { insert: { type: 'integer', minimum: 0 } } }] },
                at: { type: 'number', description: '时间线秒数（split/move/insert）' },
                field: { type: 'string', description: 'set 的字段名' },
                value: { description: 'set 的字段值' },
                fields: { type: 'object', description: 'fields 的字段对象，例如 {"text":"新标题"}' },
              },
            },
          },
          projectId: { type: 'string', description: '缺省取工程目录名' },
          batchId: { type: 'string', description: '缺省 MCP' },
          owner: { type: 'string', enum: ['MAIN', 'SUB1', 'SUB2', 'BRAIN'], description: '缺省 SUB2（本线）' },
          dryRun: { type: 'boolean', description: '只校验 expectedHash，不写盘' },
          confirm: { type: 'boolean', description: '写类二次确认：必须显式 true（dryRun 也要）' },
        },
      },
      example: {
        project: 'demo',
        expectedHash: '<sha256>',
        opId: 'op-1',
        ops: [{ op: 'fields', clip: 'title', fields: { text: '新标题' } }, { op: 'split', clip: 'a', at: 1.5 }],
        confirm: true,
      },
      run: async (args) => {
        const envelope = {
          /* 走 Studio 时，工程 id 必须是 Studio 认的那个（可能是哈希/序列 id，不是目录名）。 */
          projectId: args.projectId ?? studio?.projectId ?? path.basename(String(args.project).replace(/[/\\]+$/, '')),
          batchId: args.batchId ?? 'MCP',
          owner: args.owner ?? 'SUB2',
          expectedHash: args.expectedHash,
          opId: args.opId,
        };
        requireWrite('film_apply_ops', args.confirm, {
          project: args.project,
          expectedHash: args.expectedHash,
          opId: args.opId,
          ops: args.ops,
          confirm: true,
        });
        const { result } = await applyOps(
          ctx,
          args.project,
          { envelope, ops: args.ops },
          { dryRun: args.dryRun === true, ...(studio === null ? {} : { studio }) },
        );
        return result;
      },
    },
    {
      name: 'film_propose_ops',
      title: 'Film propose ops',
      /* CS2（R30-125）：GUI 的 ACP agent 用它提交「打算怎么改」，由产品侧校验并回
         touched / inverse，用户在面板上点「应用」才真的写。它**不写盘** —— 这样
         「停止/取消」时不存在「已经写了一半」的善后问题。 */
      description: [
        '只读提案：把一批 Op 在内存里演算，返回会不会改、改到哪些片段、逆操作是什么；不写盘。',
        'Op 方言与 film_apply_ops 完全相同（fields / set / split / move / remove / insert / overrides / props / track / reorder）。',
        '剪辑请求应当先 propose，再把同一批 ops 交给产品去应用；不要直接改 film.html。',
      ].join('\n'),
      write: false,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['project', 'ops'],
        properties: {
          project: projectProp,
          ops: {
            type: 'array',
            minItems: 1,
            maxItems: 1000,
            items: {
              type: 'object',
              required: ['op'],
              properties: {
                op: { type: 'string', description: 'fields | set | split | move | insert | remove | props | track | reorder | overrides' },
                clip: { oneOf: [{ type: 'string' }, { type: 'object', required: ['src'], properties: { id: { type: 'string' }, src: { type: 'string' }, kind: { type: 'string' }, time: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } } }], description: '既有片段id，或insert使用的新片段对象' },
                track: { oneOf: [{ type: 'integer', minimum: 0 }, { type: 'object', required: ['insert'], properties: { insert: { type: 'integer', minimum: 0 } } }] },
                at: { type: 'number', description: '时间线秒数（split/move/insert）' },
                field: { type: 'string' },
                value: {},
                fields: { type: 'object' },
                entries: { type: 'array' },
              },
            },
          },
          expectedHash: { type: 'string', pattern: '^[0-9a-f]{64}$', description: '可选：film_read 的 sourceHash；给了就核 CAS' },
          opId: { type: 'string', description: '可选：仅供审计/回显，不落账本' },
          projectId: { type: 'string' },
        },
      },
      example: {
        project: 'demo',
        ops: [
          { op: 'overrides', clip: 'page1', entries: [{ at: '#title', t: '新标题', style: { color: '#ff6b6b' } }] },
          { op: 'split', clip: 'a', at: 1.5 },
          { op: 'move', clip: 'b', at: 4.5 },
        ],
      },
      run: async (args) =>
        proposeOps(ctx, args.project, {
          envelope: {
            projectId: args.projectId ?? path.basename(String(args.project).replace(/[/\\]+$/, '')),
            batchId: 'MCP-PROPOSE',
            owner: 'MAIN',
            opId: args.opId ?? `propose-${Date.now().toString(36)}`,
            ...(typeof args.expectedHash === 'string' ? { expectedHash: args.expectedHash } : {}),
          },
          ops: args.ops,
        }),
    },
    {
      name: 'creation_library_read', title: 'Read creation library', write: false,
      description: '读取当前 Studio 工程的真实素材、可编辑网页模板/文字/贴纸/滤镜/特效、技能、字幕、配音、音乐音效、转场及能力状态；返回sourceHash与真实itemId。没有Studio连接时明确NEEDS_STUDIO。',
      inputSchema: { type: 'object', additionalProperties: false, required: ['project'], properties: { project: projectProp } },
      run: async (args) => readCreationLibrary(ctx, args.project, { ...(studio ? { studio } : {}) }),
    },
    {
      name: 'creation_library_action', title: 'Apply creation library action', write: true,
      description: [
        '操作现有工作台的同一素材库/时间线，不另存第二份film。需--allow-write、confirm:true和原Studio工程写票（权限等同film_apply_ops）。',
        '先creation_library_read取得真实itemId/sourceHash；request必须action与稳定opId，film写必须expectedHash。resource.apply保留可编辑HTML：target.at秒/track/mode；overlay新层、ripple波纹、reject-overlap拒碰撞、clip仅滤镜作用选中画面。',
        '资源：resource.apply/favorite/save/rename/move/remove/import-page/import-media，folder.create；skill.import/toggle/use（use只回agentPrompt不自动执行）。import-page或skill.import用params.fileName/content；import-media用params.fileName/data(base64)。',
        '字幕：caption.read/export/import/add/update/remove/recognize/translate；配音/媒体：media.tts、job.cancel；真实Provider未配置时返回不可用，不冒充已生成。',
        '转场：resource.apply传transition/itemId及target.from/to/durationSec；transition.resize/remove复用同一接缝与undo。所有参数可按read返回的paramSchema填写。',
      ].join('\n'),
      inputSchema: { type: 'object', additionalProperties: false, required: ['project', 'request', 'confirm'], properties: {
        project: projectProp, confirm: { type: 'boolean', const: true },
        request: { type: 'object', required: ['action', 'opId'], additionalProperties: false, properties: {
          action: { type: 'string', enum: ['resource.apply', 'resource.favorite', 'resource.save', 'resource.rename', 'resource.move', 'resource.remove', 'resource.import-page', 'resource.import-media', 'folder.create', 'skill.import', 'skill.toggle', 'skill.use', 'caption.read', 'caption.export', 'caption.import', 'caption.add', 'caption.update', 'caption.remove', 'caption.recognize', 'caption.translate', 'media.tts', 'job.cancel', 'transition.resize', 'transition.remove'] },
          opId: { type: 'string', minLength: 1, maxLength: 160 }, expectedHash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, itemId: { type: 'string' }, itemIds: { type: 'array', items: { type: 'string' } }, name: { type: 'string' }, folderId: { type: 'string' }, value: {}, text: { type: 'string' }, src: { type: 'string' },
          params: { type: 'object', additionalProperties: true }, target: { type: 'object', additionalProperties: false, properties: { at: { type: 'number', minimum: 0 }, track: { type: ['integer', 'null'], minimum: 0 }, clipId: { type: 'string' }, selectedClipIds: { type: 'array', items: { type: 'string' } }, from: { type: 'string' }, to: { type: 'string' }, mode: { enum: ['ripple', 'new-track', 'reject-overlap', 'overlay', 'clip'] }, durationSec: { type: 'number', minimum: 0.001 } } },
        } },
      } },
      example: { project: 'demo', confirm: true, request: { action: 'resource.apply', itemId: 'builtin:text-basic', expectedHash: '<sha256>', opId: 'title-1', text: '新标题', target: { at: 0, mode: 'overlay' } } },
      run: async (args) => {
        requireWrite('creation_library_action', args.confirm, { project: args.project, request: args.request, confirm: true });
        return applyCreationLibrary(ctx, args.project, args.request, { ...(studio ? { studio } : {}) });
      },
    },
    {
      name: 'export_start',
      title: 'Export start',
      description: '启动一次渲染作业（复用 packages/render 的作业 API）；写类，需 --allow-write。',
      write: true,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['project', 'spec'],
        properties: {
          project: projectProp,
          spec: {
            type: 'object',
            description: 'RenderJobSpec（jobId/projectId/kind/expectedHash 必填；outputDir 缺省在沙箱 output 下）',
          },
          audioMix: {
            type: 'object',
            additionalProperties: false,
            required: ['duration', 'clips'],
            description: '可选：显式音频时间线；服务端先 renderMix 出 mix.wav，再渲染并单独封装',
            properties: {
              duration: { type: 'number', minimum: 0.001, description: '目标时长（秒）' },
              sampleRate: { type: 'integer', enum: [48000, 44100] },
              channels: { type: 'integer', enum: [2] },
              clips: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['src', 'at'],
                  properties: {
                    src: { type: 'string', minLength: 1, description: '音频文件路径' },
                    at: { type: 'number', minimum: 0, description: '时间线位置（秒）' },
                    time: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' }, description: '[in, out]' },
                    volume: { type: 'number', minimum: 0 },
                    speed: { type: 'number', minimum: 0.05, description: '变速（保持音高）' },
                    fade: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number', minimum: 0 } },
                  },
                },
              },
            },
          },
          dryRun: { type: 'boolean', description: '只回显补全后的 spec，不入队' },
          confirm: { type: 'boolean', description: '写类二次确认：必须显式 true（dryRun 也要）' },
        },
      },
      example: { project: 'demo', spec: { jobId: 'j1', projectId: 'demo', kind: 'video', expectedHash: '<sha256>' }, confirm: true },
      run: async (args) => {
        requireWrite('export_start', args.confirm, {
          project: args.project,
          spec: args.spec,
          ...(args.audioMix !== undefined ? { audioMix: args.audioMix } : {}),
          confirm: true,
        });
        const { result } = await startExport(ctx, args.project, args.spec, {
          dryRun: args.dryRun === true,
          ...(args.audioMix !== undefined ? { audioMix: args.audioMix } : {}),
        });
        return result;
      },
    },
    {
      name: 'export_status',
      title: 'Export status',
      description: '查询渲染作业进度（只读）。',
      write: false,
      inputSchema: { type: 'object', additionalProperties: false, required: ['jobId'], properties: { jobId: jobIdProp } },
      run: async (args) => exportStatus(ctx, args.jobId),
    },
  ];
}
