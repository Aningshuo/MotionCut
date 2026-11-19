/**
 * 用户级设置中心存储（M49 · B-MAIN-R24-024）。
 *
 * ## 为什么是「用户级」而不是工程级
 *
 * 播放默认音量 / 导出默认 fps / 编码 / 质量这些是**这台机器上的人**的偏好，不是某个
 * 工程的内容。写进 `film.html` 或 `.film/` 会有两个坏结果：换工程就丢，而且每次改设置
 * 都变成一次可撤销的文档编辑（`/ops` 里多一条莫名其妙的 op）。所以落在：
 *
 *   `$OPENCUT_SETTINGS`（打包态 = `userData/settings.json`）
 *   缺省 = `~/.opencut/settings.json`
 *
 * 工程级的 `.film/` 只放**工程**自己的东西（字幕样式、历史快照），两者不混。
 *
 * ## 写盘规格（与 subtitle-style-store 同一套）
 *
 * 同目录临时文件 → `fsync` → `rename` → **回读校验**；失败清临时文件，不留半份设置。
 * 成功后返回回读内容的 sha256，UI/验收能对上「写进去的就是读回来的」。
 *
 * ## 坏 JSON 的处理：**不覆盖原文件**
 *
 * 读到解析失败时：原文件改名 `settings.json.bak-<ts>`（保留证据），本次返回默认值 +
 * `issues:["SETTINGS_CORRUPT"]`，**不**写新文件。下一次 PUT 才会重新落一份干净的。
 * 直接覆盖会让用户丢掉「上次到底写了什么」这条线索。
 *
 * ## 校验
 *
 * - 未知字段（顶层或分区内）→ `UNKNOWN_FIELD`，`field` 指到具体路径（`playback.foo`）；
 * - 越界/枚举外的值 → `OUT_OF_RANGE`，`field` + `allowed`；
 * - `PUT` 是**分区级补丁**：只改传进来的那几个键，没传的保持原值。
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SETTINGS_VERSION = 1;

/**
 * 默认值。改这里等于改产品默认行为——只在「确实要换默认」时动，并且要同步 UI 的初值。
 */
export const SETTINGS_DEFAULTS = Object.freeze({
  appearance: Object.freeze({ theme: 'dark' }),
  playback: Object.freeze({ volume: 100, loop: false, hideCursorWhilePlaying: false }),
  export: Object.freeze({
    fps: 30,
    codec: 'h264',
    quality: 'standard',
    // `null` 而不是 `{}`：空对象会让「有没有记过上次导出」变得不可判定。
    last: null,
  }),
  /**
   * MCP 外部 server（M65 · WP20）。**这里是唯一真源**：
   * 不再新建/读取 `~/.opencut/mcp.json`（旧文件只在 GET 里提示被忽略）。
   * 只对**新建 ACP 会话**生效；改完不重启已有会话。
   */
  mcp: Object.freeze({ servers: Object.freeze([]) }),
  /**
   * CS1（AC08/SET04）：智能体的显示开关。
   *
   * `null` = **不过滤**（全部启用，新装 Agent 默认可见）；数组 = 白名单（可为空，
   * 空数组就是「全关」）。要区分「没配过」与「全关」，所以不能用空数组当默认。
   */
  agent: Object.freeze({ enabled: null }),
  /**
   * CS1（AC11/SET06–08）：自有模型（BYOK）的连接参数。
   *
   * Key **不在这里**（`keys/model.enc`），这里只有非敏感的路由参数；四个 scope 的
   * 实际请求由 `model-key.mjs#modelEndpoint` 消费（env 显式覆盖 > 这里的默认）。
   */
  byok: Object.freeze({
    name: '',
    format: 'openai-chat',
    baseUrl: '',
    model: '',
    reasoning: 'auto',
    contextTokens: 0,
  }),
});

/** MCP server 名的格式：小写字母/数字开头，2–32 位，只允许 `-` `_`。 */
export const MCP_SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{1,31}$/;
/** 最多 32 条：再多不是「配置」而是「列表管理」，交给外部工具。 */
export const MCP_MAX_SERVERS = 32;
/**
 * 设置校验失败的**机器可读**原因（固定枚举，M80 · B-MAIN-R30-039）。
 *
 * 为什么要有它：以前 `PUT /api/settings` 只回 `code + message`，设置面板只能把中文
 * 原样贴出来，没法按原因给不同的修复建议（「名字不合规」和「重名」是两种改法）。
 *
 * 前七条是本批验收口径（副线1 已按它们做分支），后面几条覆盖其余 400 情形——
 * 形状必须一致（`{ok:false, code, message, field, reason}`），否则调用方还得写特例。
 * 扩展这个列表等于改契约：要同步副线1 的建议表。
 */
export const SETTINGS_ERROR_REASONS = Object.freeze([
  'NAME_PATTERN',
  'DUPLICATE_NAME',
  'TOO_MANY_SERVERS',
  'ARGS_NOT_ARRAY',
  'ENV_VALUE_NOT_STRING',
  'UNKNOWN_FIELD',
  'COMMAND_EMPTY',
  'NOT_OBJECT',
  'TYPE_INVALID',
  'VALUE_INVALID',
  'NOT_ALLOWED',
  'NOT_INTEGER',
  'SERVERS_NOT_ARRAY',
  'ENTRY_NOT_OBJECT',
  'ENV_NOT_OBJECT',
  'ENABLED_NOT_BOOLEAN',
  'WRITE_FAILED',
]);

/** 一条 server 允许的字段（未知字段一律 400，不静默丢）。 */
const MCP_ITEM_FIELDS = Object.freeze(['name', 'command', 'args', 'env', 'enabled']);

/**
 * @typedef {{ type: 'int'|'number'|'boolean'|'string'|'record'|'serverList'|'stringList', min?: number, max?: number,
 *   enum?: readonly (string|number)[], nullable?: boolean, fields?: Record<string, FieldRule>,
 *   maxItems?: number, maxLength?: number, pattern?: RegExp }} FieldRule
 * 每个分区的字段与规则。`enum` 优先于 `min/max`。
 *
 * `type: 'record'` 是**一个嵌套对象**（M54 的 `export.last`）：它有自己的一组子字段，
 * 每个子字段复用同一套规则。不用 `any` 放行——放行就等于「上次导出写了什么」没人校验，
 * A1 那种 `fps: 29.97` 的浮点值会静默变成字符串进表单。
 *
 * `type: 'serverList'` 是 MCP 的 `mcp.servers`（M65）：数组，每项字段单独校验，
 * 长度上限 `maxItems`。它需要「逐项 + 重名 + 未知子字段」三种判定，塞进 `record` 会失真。
 * @type {Record<string, Record<string, FieldRule>>}
 */
const RULES = Object.freeze({
  appearance: {
    theme: { type: 'string', enum: ['dark', 'light'] },
  },
  playback: {
    volume: { type: 'int', min: 0, max: 100 },
    loop: { type: 'boolean' },
    hideCursorWhilePlaying: { type: 'boolean' },
  },
  mcp: {
    servers: { type: 'serverList', maxItems: MCP_MAX_SERVERS },
  },
  agent: {
    /* Agent id 的字符集与 `/api/agent/roster` 的 id 一致（mock / codex / …）。 */
    enabled: { type: 'stringList', nullable: true, maxItems: 24, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/ },
  },
  byok: {
    name: { type: 'string', maxLength: 60 },
    /* 三种协议是**三条不同的 wire**（packages/providers/wire-*.mjs），不是换 URL。 */
    format: { type: 'string', enum: ['openai-chat', 'openai-responses', 'anthropic-messages'] },
    baseUrl: { type: 'string', maxLength: 300 },
    model: { type: 'string', maxLength: 120 },
    reasoning: { type: 'string', enum: ['auto', 'off', 'low', 'medium', 'high'] },
    contextTokens: { type: 'int', min: 0, max: 2000000 },
  },
  export: {
    fps: { type: 'int', enum: [24, 25, 30, 60] },
    codec: { type: 'string', enum: ['h264', 'hevc'] },
    quality: { type: 'string', enum: ['draft', 'standard', 'high'] },
    /**
     * 上次导出用的参数（M54）：`null` = 还没导出过，表单用上面三个默认值。
     *
     * 注意 `fps` 这里**不枚举**、也不要求整数：工程可以是 29.97 / 23.976，
     * 记下来就得原样还回去，否则「上次 29.97、重开变 30」会悄悄改掉交付帧率。
     */
    last: {
      type: 'record',
      nullable: true,
      fields: {
        codec: { type: 'string', enum: ['h264', 'hevc'] },
        quality: { type: 'string', enum: ['draft', 'standard', 'high'] },
        fps: { type: 'number', min: 1, max: 240 },
        size: { type: 'string' },
        fit: { type: 'string', enum: ['letterbox', 'cover'] },
        loudness: { type: 'number', min: -60, max: 0 },
        subtitleBurn: { type: 'boolean' },
      },
    },
  },
});

/** 设置文件路径：`OPENCUT_SETTINGS` 覆盖 → `~/.opencut/settings.json`。 */
export function settingsPath() {
  const override = String(process.env.OPENCUT_SETTINGS ?? '').trim();
  if (override !== '') return path.resolve(override);
  return path.join(os.homedir(), '.opencut', 'settings.json');
}

/**
 * 同步读一份**已规范化**的设置（CS1）。
 *
 * 谁需要同步：请求链路里的 `modelEndpoint()`（`packages/studio/server/model-key.mjs`）
 * 是同步函数，被 `/api/settings/model-key/check` 与名册探测调用。异步 readSettings
 * 会把整条链路改成 async，收益为零 —— 设置文件很小、只在用户改设置时才变。
 *
 * 读不到/坏 JSON → 默认值（不抛）：请求链路不能因为设置文件坏了就整个 500。
 * @returns {any}
 */
export function readSettingsSync() {
  try {
    const text = readFileSync(settingsPath(), 'utf8');
    const parsed = JSON.parse(text);
    /* 文件形状是 `{version, settings, updatedAt}`（与 readSettings 同一份盘上格式）；
       直接 normalize 顶层会把整份设置读成默认值 —— 这里必须取 `.settings`。 */
    return normalizeSettings(parsed.settings ?? parsed).settings;
  } catch {
    return defaultSettings();
  }
}

/** @param {string} text */
function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * 深拷贝默认值（防止调用方改到冻结对象）。
 * @returns {any}
 */
export function defaultSettings() {
  return {
    appearance: { ...SETTINGS_DEFAULTS.appearance },
    playback: { ...SETTINGS_DEFAULTS.playback },
    export: { ...SETTINGS_DEFAULTS.export },
    mcp: { servers: [] },
    agent: { enabled: null },
    byok: { ...SETTINGS_DEFAULTS.byok },
  };
}

/**
 * 校验单个值（不含「未知字段」判定——那要看字段名，调用方各自做）。
 *
 * 读和写共用同一份判定：读的时候把不合法的值丢掉并留痕，写的时候直接 400，
 * 两条路径不会对「什么算合法」产生分歧。
 *
 * @param {FieldRule} rule
 * @param {unknown} value
 * @returns {{ ok: true, value: any } | { ok: false, message: string, allowed?: any[] }}
 */
function checkValue(rule, value) {
  if (rule.type === 'boolean') {
    if (typeof value !== 'boolean') return { ok: false, message: '必须是布尔值', allowed: [true, false] };
    return { ok: true, value };
  }
  if (rule.type === 'string') {
    if (typeof value !== 'string') return { ok: false, message: '必须是字符串', allowed: rule.enum === undefined ? [] : [...rule.enum] };
    if (Array.isArray(rule.enum) && !rule.enum.includes(value)) {
      return { ok: false, message: `只能是 ${rule.enum.join(' / ')}`, allowed: [...rule.enum] };
    }
    return { ok: true, value };
  }
  if (rule.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, message: '必须是有限数字', allowed: [rule.min, rule.max] };
    if (value < (rule.min ?? -Infinity) || value > (rule.max ?? Infinity)) {
      return { ok: false, message: `必须在 ${rule.min}..${rule.max}（收到 ${value}）`, allowed: [rule.min, rule.max] };
    }
    return { ok: true, value };
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { ok: false, message: '必须是整数', allowed: rule.enum === undefined ? [rule.min, rule.max] : [...rule.enum] };
  }
  if (Array.isArray(rule.enum)) {
    if (!rule.enum.includes(value)) return { ok: false, message: `只能是 ${rule.enum.join(' / ')}（收到 ${value}）`, allowed: [...rule.enum] };
    return { ok: true, value };
  }
  if (value < (rule.min ?? -Infinity) || value > (rule.max ?? Infinity)) {
    return { ok: false, message: `必须在 ${rule.min}..${rule.max}（收到 ${value}）`, allowed: [rule.min, rule.max] };
  }
  return { ok: true, value };
}

/**
 * 校验一条 MCP server（M65）。
 *
 * **env 值不回显**：错误消息只说「必须是字符串」，不把收到的东西拼进去——
 * 设置面板的报错可能被截图、被贴进工单，密钥不能靠「用户不会发」来保命。
 *
 * @param {unknown} entry
 * @param {string} prefix 形如 `mcp.servers[0]`
 * @returns {{ ok: true, value: any } | { ok: false, code: 'UNKNOWN_FIELD'|'OUT_OF_RANGE', field: string,
 *   allowed?: any[], reason?: string, message: string }}
 */
export function checkMcpServerEntry(entry, prefix = 'mcp.servers[0]') {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return {
      ok: false,
      code: 'OUT_OF_RANGE',
      field: prefix,
      allowed: ['object'],
      reason: 'ENTRY_NOT_OBJECT',
      message: `${prefix} 必须是对象`,
    };
  }
  const record = /** @type {Record<string, any>} */ (entry);
  for (const key of Object.keys(record)) {
    if (!MCP_ITEM_FIELDS.includes(key)) {
      return {
        ok: false,
        code: 'UNKNOWN_FIELD',
        field: `${prefix}.${key}`,
        reason: 'UNKNOWN_FIELD',
        message: `未知设置字段：${prefix}.${key}`,
      };
    }
  }
  const name = record.name;
  if (typeof name !== 'string' || !MCP_SERVER_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      code: 'OUT_OF_RANGE',
      field: `${prefix}.name`,
      allowed: [MCP_SERVER_NAME_PATTERN.source],
      reason: 'NAME_PATTERN',
      message: `${prefix}.name 必须匹配 ${MCP_SERVER_NAME_PATTERN.source}`,
    };
  }
  const command = record.command;
  if (typeof command !== 'string' || command.trim() === '') {
    return {
      ok: false,
      code: 'OUT_OF_RANGE',
      field: `${prefix}.command`,
      allowed: ['non-empty string'],
      reason: 'COMMAND_EMPTY',
      message: `${prefix}.command 必须是非空字符串`,
    };
  }
  const args = record.args === undefined ? [] : record.args;
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    return {
      ok: false,
      code: 'OUT_OF_RANGE',
      field: `${prefix}.args`,
      allowed: ['string[]'],
      reason: 'ARGS_NOT_ARRAY',
      message: `${prefix}.args 必须是字符串数组`,
    };
  }
  const env = record.env === undefined ? {} : record.env;
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    return {
      ok: false,
      code: 'OUT_OF_RANGE',
      field: `${prefix}.env`,
      allowed: ['Record<string,string>'],
      reason: 'ENV_NOT_OBJECT',
      message: `${prefix}.env 必须是「字符串→字符串」的对象`,
    };
  }
  for (const [key, value] of Object.entries(/** @type {Record<string, any>} */ (env))) {
    if (typeof value !== 'string') {
      // 值本身绝不进消息（日志/错误里都不许出现 env 值）。
      return {
        ok: false,
        code: 'OUT_OF_RANGE',
        field: `${prefix}.env.${key}`,
        allowed: ['string'],
        reason: 'ENV_VALUE_NOT_STRING',
        message: `${prefix}.env.${key} 必须是字符串（值不回显）`,
      };
    }
  }
  const enabled = record.enabled === undefined ? true : record.enabled;
  if (typeof enabled !== 'boolean') {
    return {
      ok: false,
      code: 'OUT_OF_RANGE',
      field: `${prefix}.enabled`,
      allowed: [true, false],
      reason: 'ENABLED_NOT_BOOLEAN',
      message: `${prefix}.enabled 必须是布尔值`,
    };
  }
  return { ok: true, value: { name, command, args: [...args], env: { ...env }, enabled } };
}

/**
 * 校验整张 `mcp.servers`（写路径用：任何一条不合法都 400）。
 * @param {unknown} list
 * @param {number} maxItems
 */
function checkServerList(list, maxItems) {
  if (!Array.isArray(list)) {
    return {
      ok: false,
      code: 'OUT_OF_RANGE',
      field: 'mcp.servers',
      allowed: ['array'],
      reason: 'SERVERS_NOT_ARRAY',
      message: 'mcp.servers 必须是数组',
    };
  }
  if (list.length > maxItems) {
    return {
      ok: false,
      code: 'OUT_OF_RANGE',
      field: 'mcp.servers',
      allowed: [0, maxItems],
      reason: 'TOO_MANY_SERVERS',
      message: `mcp.servers 最多 ${maxItems} 条（收到 ${list.length}）`,
    };
  }
  /** @type {string[]} */
  const names = [];
  /** @type {any[]} */
  const servers = [];
  for (let index = 0; index < list.length; index += 1) {
    const checked = checkMcpServerEntry(list[index], `mcp.servers[${index}]`);
    if (checked.ok !== true) return checked;
    if (names.includes(checked.value.name)) {
      return {
        ok: false,
        code: 'OUT_OF_RANGE',
        field: `mcp.servers[${index}].name`,
        allowed: ['unique'],
        reason: 'DUPLICATE_NAME',
        message: `mcp.servers[${index}].name 与前面的 name 重复：${checked.value.name}`,
      };
    }
    names.push(checked.value.name);
    servers.push(checked.value);
  }
  return { ok: true, value: servers };
}

/**
 * 读路径的「宽容版」：坏条目丢掉并留痕，好条目保留；重名保留第一条。
 * @param {unknown} list
 * @param {number} maxItems
 * @returns {{ servers: any[], issues: string[] }}
 */
function normalizeServerList(list, maxItems) {
  /** @type {any[]} */
  const servers = [];
  /** @type {string[]} */
  const issues = [];
  if (!Array.isArray(list)) {
    return { servers, issues: ['mcp.servers'] };
  }
  if (list.length > maxItems) issues.push('mcp.servers');
  /** @type {Set<string>} */
  const names = new Set();
  for (let index = 0; index < Math.min(list.length, maxItems); index += 1) {
    const checked = checkMcpServerEntry(list[index], `mcp.servers[${index}]`);
    if (checked.ok !== true) {
      issues.push(checked.field);
      continue;
    }
    if (names.has(checked.value.name)) {
      issues.push(`mcp.servers[${index}].name`);
      continue;
    }
    names.add(checked.value.name);
    servers.push(checked.value);
  }
  return { servers, issues };
}

/**
 * 有效 MCP server 列表 → ACP `session/new` 的 `mcpServers`。
 *
 * 顺序 = 设置里的顺序；只取 `enabled !== false`（缺省 true）；
 * 只映射协议认识的四个字段，`enabled` 不下发。
 * @param {any} settings
 * @returns {{name: string, command: string, args: string[], env: Record<string,string>}[]}
 */
export function mcpServersForSettings(settings) {
  const list = settings?.mcp?.servers;
  if (!Array.isArray(list)) return [];
  return list
    .filter((entry) => entry !== null && typeof entry === 'object' && entry.enabled !== false)
    .map((entry) => ({
      name: String(entry.name),
      command: String(entry.command),
      args: Array.isArray(entry.args) ? [...entry.args] : [],
      env: entry.env !== null && typeof entry.env === 'object' && !Array.isArray(entry.env) ? { ...entry.env } : {},
    }));
}

/**
 * 旧的 MCP 配置文件位置（**只用于检测存在性，绝不读取内容**）。
 * 与 settings.json 同目录：`$OPENCUT_SETTINGS` 被覆盖时，legacy 也跟着落在同一目录。
 * @returns {string}
 */
export function legacyMcpPath() {
  return path.join(path.dirname(settingsPath()), 'mcp.json');
}

/** legacy 文件是否存在（`existsSync` 只 stat，不读内容）。 */
export function legacyMcpExists() {
  return existsSync(legacyMcpPath());
}

/**
 * 归一化：以默认值为底，逐分区逐字段接受合法值。
 *
 * 读文件时用它（文件里可能缺字段、可能有旧版本没见过的键）：**未知键忽略**，
 * 非法值回退默认并在 issues 里留痕（读不该因为一个坏字段整个失败）。
 *
 * @param {unknown} raw
 * @returns {{ settings: any, issues: string[] }}
 */
export function normalizeSettings(raw) {
  /** @type {any} */
  const settings = defaultSettings();
  /** @type {string[]} */
  const issues = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { settings, issues: ['SETTINGS_SHAPE'] };
  }
  const input = /** @type {Record<string, any>} */ (raw);
  for (const [section, fields] of Object.entries(/** @type {Record<string, Record<string, FieldRule>>} */ (RULES))) {
    const values = input[section];
    if (values === undefined) continue;
    if (values === null || typeof values !== 'object' || Array.isArray(values)) {
      issues.push(`${section.toUpperCase()}_SHAPE`);
      continue;
    }
    for (const [field, rule] of Object.entries(fields)) {
      const value = values[field];
      if (value === undefined) continue;
      // 嵌套记录（`export.last`）：逐子字段校验，坏的那个丢掉并留痕，其余保留。
      // 整条丢掉会让「上次导出」因为一个 fps 越界就全部丢失，代价太大。
      if (rule.type === 'record') {
        if (value === null && rule.nullable === true) {
          settings[section][field] = null;
          continue;
        }
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          issues.push(`${section}.${field}`);
          continue;
        }
        /** @type {Record<string, any>} */
        const record = {};
        for (const [sub, subRule] of Object.entries(rule.fields ?? {})) {
          const subValue = /** @type {Record<string, any>} */ (value)[sub];
          if (subValue === undefined) continue;
          const checked = checkValue(subRule, subValue);
          if (!checked.ok) {
            issues.push(`${section}.${field}.${sub}`);
            continue;
          }
          record[sub] = checked.value;
        }
        settings[section][field] = record;
        continue;
      }
      // 字符串白名单（CS1 · agent.enabled）：null 表示「没配过」，数组表示白名单。
      if (rule.type === 'stringList') {
        if (value === null && rule.nullable === true) {
          settings[section][field] = null;
          continue;
        }
        if (!Array.isArray(value)) {
          issues.push(`${section}.${field}`);
          continue;
        }
        const max = rule.maxItems ?? 24;
        /** @type {string[]} */
        const list = [];
        let dropped = false;
        for (const item of value) {
          if (typeof item !== 'string' || (rule.pattern !== undefined && !rule.pattern.test(item)) || list.length >= max) {
            dropped = true;
            continue;
          }
          list.push(item);
        }
        if (dropped) issues.push(`${section}.${field}`);
        settings[section][field] = list;
        continue;
      }
      // MCP server 列表（M65）：坏条目丢掉并逐条留痕，不让一条手写错的配置毁掉整页。
      if (rule.type === 'serverList') {
        const normalizedList = normalizeServerList(value, rule.maxItems ?? MCP_MAX_SERVERS);
        for (const issue of normalizedList.issues) issues.push(issue);
        settings[section][field] = normalizedList.servers;
        continue;
      }
      if (rule.type === 'boolean') {
        if (typeof value !== 'boolean') {
          issues.push(`${section}.${field}`);
          continue;
        }
        settings[section][field] = value;
        continue;
      }
      if (rule.type === 'string') {
        if (
          typeof value !== 'string' ||
          (Array.isArray(rule.enum) && !rule.enum.includes(value)) ||
          (rule.maxLength !== undefined && value.length > rule.maxLength)
        ) {
          issues.push(`${section}.${field}`);
          continue;
        }
        settings[section][field] = value;
        continue;
      }
      if (!Number.isInteger(value)) {
        issues.push(`${section}.${field}`);
        continue;
      }
      if (Array.isArray(rule.enum)) {
        if (!rule.enum.includes(value)) {
          issues.push(`${section}.${field}`);
          continue;
        }
        settings[section][field] = value;
        continue;
      }
      if ((value < (rule.min ?? -Infinity)) || (value > (rule.max ?? Infinity))) {
        issues.push(`${section}.${field}`);
        continue;
      }
      settings[section][field] = value;
    }
  }
  return { settings, issues };
}

/**
 * 校验 PUT 的补丁。**不**静默丢字段：未知就报，越界就报。
 *
 * @param {unknown} patch
 * @param {any} current 现有设置（补丁合并在它上面）
 * @returns {any} `{ok:true, settings}` 或 `{ok:false, code:'UNKNOWN_FIELD'|'OUT_OF_RANGE'|'INVALID_BODY', field, reason, allowed, message}`
 *   （`reason` 取自 `SETTINGS_ERROR_REASONS`；错误体五键固定，路由直接照发）
 *   （返回 any：调用方按 `ok` 分支，联合类型在 JS 里反而让每个 `result.code` 都要先窄化）
 */
export function applySettingsPatch(patch, current) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return {
      ok: false,
      code: 'INVALID_BODY',
      field: 'settings',
      reason: 'NOT_OBJECT',
      message: 'settings 必须是对象（分区级补丁）',
    };
  }
  const input = /** @type {Record<string, any>} */ (patch);
  for (const section of Object.keys(input)) {
    if (!Object.hasOwn(RULES, section)) {
      return { ok: false, code: 'UNKNOWN_FIELD', field: section, reason: 'UNKNOWN_FIELD', message: `未知设置分区：${section}` };
    }
    const values = input[section];
    if (values === null || typeof values !== 'object' || Array.isArray(values)) {
      return { ok: false, code: 'UNKNOWN_FIELD', field: section, reason: 'NOT_OBJECT', message: `${section} 必须是对象` };
    }
    const sectionRules = /** @type {Record<string, FieldRule>} */ (RULES[section]);
    for (const field of Object.keys(values)) {
      if (!Object.hasOwn(sectionRules, field)) {
        return {
          ok: false,
          code: 'UNKNOWN_FIELD',
          field: `${section}.${field}`,
          reason: 'UNKNOWN_FIELD',
          message: `未知设置字段：${section}.${field}`,
        };
      }
      const rule = /** @type {FieldRule} */ (sectionRules[field]);
      const value = values[field];
      // 嵌套记录（`export.last`）：允许 null（清除记忆）；对象则逐子字段校验，
      // 未知子字段一律 400 —— 否则 UI 写错名字会静默丢失「记住上次」。
      if (rule.type === 'record') {
        if (value === null && rule.nullable === true) continue;
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          return {
            ok: false,
            code: 'UNKNOWN_FIELD',
            field: `${section}.${field}`,
            reason: 'NOT_OBJECT',
            message: `${section}.${field} 必须是对象或 null`,
          };
        }
        for (const sub of Object.keys(value)) {
          const subRule = (rule.fields ?? {})[sub];
          if (subRule === undefined) {
            return {
              ok: false,
              code: 'UNKNOWN_FIELD',
              field: `${section}.${field}.${sub}`,
              reason: 'UNKNOWN_FIELD',
              message: `未知设置字段：${section}.${field}.${sub}`,
            };
          }
          const checked = checkValue(subRule, /** @type {Record<string, any>} */ (value)[sub]);
          if (!checked.ok) {
            return {
              ok: false,
              code: 'OUT_OF_RANGE',
              field: `${section}.${field}.${sub}`,
              allowed: checked.allowed,
              reason: 'VALUE_INVALID',
              message: `${section}.${field}.${sub} ${checked.message}`,
            };
          }
        }
        continue;
      }
      // 字符串白名单（CS1）：写路径不宽容 —— 非数组 / 非字符串 / 超长 / 不匹配都 400。
      if (rule.type === 'stringList') {
        if (value === null && rule.nullable === true) continue;
        if (!Array.isArray(value)) {
          return {
            ok: false,
            code: 'OUT_OF_RANGE',
            field: `${section}.${field}`,
            allowed: ['array', 'null'],
            reason: 'TYPE_INVALID',
            message: `${section}.${field} 必须是字符串数组或 null`,
          };
        }
        const max = rule.maxItems ?? 24;
        if (value.length > max) {
          return {
            ok: false,
            code: 'OUT_OF_RANGE',
            field: `${section}.${field}`,
            allowed: [0, max],
            reason: 'VALUE_INVALID',
            message: `${section}.${field} 最多 ${max} 条（收到 ${value.length}）`,
          };
        }
        for (const item of value) {
          if (typeof item !== 'string' || (rule.pattern !== undefined && !rule.pattern.test(item))) {
            return {
              ok: false,
              code: 'OUT_OF_RANGE',
              field: `${section}.${field}`,
              allowed: [],
              reason: 'VALUE_INVALID',
              message: `${section}.${field} 里有一项格式不合法：${String(item).slice(0, 40)}`,
            };
          }
        }
        continue;
      }
      // MCP server 列表（M65）：写路径不宽容——未知字段/重名/超长都指到具体路径。
      if (rule.type === 'serverList') {
        const checked = checkServerList(value, rule.maxItems ?? MCP_MAX_SERVERS);
        if (checked.ok !== true) return checked;
        continue;
      }
      if (rule.type === 'boolean') {
        if (typeof value !== 'boolean') {
          return {
            ok: false,
            code: 'OUT_OF_RANGE',
            field: `${section}.${field}`,
            allowed: [true, false],
            reason: 'TYPE_INVALID',
            message: `${section}.${field} 必须是布尔值`,
          };
        }
        continue;
      }
      if (rule.type === 'string') {
        const allowed = Array.isArray(rule.enum) ? [...rule.enum] : [];
        if (typeof value !== 'string' || (allowed.length > 0 && !allowed.includes(value))) {
          return {
            ok: false,
            code: 'OUT_OF_RANGE',
            field: `${section}.${field}`,
            allowed,
            reason: 'NOT_ALLOWED',
            message:
              allowed.length > 0
                ? `${section}.${field} 只能是 ${allowed.join(' / ')}（收到 ${String(value)}）`
                : `${section}.${field} 必须是字符串`,
          };
        }
        if (rule.maxLength !== undefined && value.length > rule.maxLength) {
          return {
            ok: false,
            code: 'OUT_OF_RANGE',
            field: `${section}.${field}`,
            allowed: [0, rule.maxLength],
            reason: 'VALUE_INVALID',
            message: `${section}.${field} 最长 ${rule.maxLength} 个字符（收到 ${value.length}）`,
          };
        }
        continue;
      }
      if (!Number.isInteger(value)) {
        return {
          ok: false,
          code: 'OUT_OF_RANGE',
          field: `${section}.${field}`,
          allowed: rule.enum === undefined ? [rule.min, rule.max] : [...rule.enum],
          reason: 'NOT_INTEGER',
          message: `${section}.${field} 必须是整数`,
        };
      }
      if (Array.isArray(rule.enum)) {
        if (!rule.enum.includes(value)) {
          return {
            ok: false,
            code: 'OUT_OF_RANGE',
            field: `${section}.${field}`,
            allowed: rule.enum,
            reason: 'NOT_ALLOWED',
            message: `${section}.${field} 只能是 ${rule.enum.join(' / ')}（收到 ${value}）`,
          };
        }
        continue;
      }
      if (value < (rule.min ?? -Infinity) || value > (rule.max ?? Infinity)) {
        return {
          ok: false,
          code: 'OUT_OF_RANGE',
          field: `${section}.${field}`,
          allowed: [rule.min, rule.max],
          reason: 'VALUE_INVALID',
          message: `${section}.${field} 必须在 ${rule.min}..${rule.max}（收到 ${value}）`,
        };
      }
    }
  }
  /** @type {any} */
  const merged = defaultSettings();
  for (const section of Object.keys(RULES)) {
    merged[section] = { ...current[section], ...(input[section] ?? {}) };
  }
  // `mcp.servers` 是数组：不共享引用，免得调用方后续改动污染「当前设置」。
  if (Array.isArray(merged.mcp?.servers)) {
    merged.mcp = {
      ...merged.mcp,
      servers: merged.mcp.servers.map((/** @type {any} */ entry) => ({
        ...entry,
        args: Array.isArray(entry?.args) ? [...entry.args] : [],
        env: entry?.env !== null && typeof entry?.env === 'object' ? { ...entry.env } : {},
      })),
    };
  }
  return { ok: true, settings: merged };
}

/**
 * 读设置。
 * @returns {Promise<{
 *   ok: true, settings: any, defaults: any, issues: string[], path: string,
 *   exists: boolean, updatedAt: string|null, sha256: string|null, version: number,
 *   backup: string|null,
 * }>}
 */
export async function readSettings() {
  const file = settingsPath();
  const base = {
    ok: /** @type {true} */ (true),
    defaults: defaultSettings(),
    path: file,
    version: SETTINGS_VERSION,
  };
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      return { ...base, settings: defaultSettings(), issues: [], exists: false, updatedAt: null, sha256: null, backup: null };
    }
    return {
      ...base,
      settings: defaultSettings(),
      issues: ['SETTINGS_UNREADABLE'],
      exists: false,
      updatedAt: null,
      sha256: null,
      backup: null,
    };
  }

  /** @type {any} */
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (parsed === null || typeof parsed !== 'object') {
    // 坏 JSON：改名留证据，本次返回默认值，**不写新文件**。
    const backup = `${file}.bak-${Date.now()}`;
    try {
      await fs.rename(file, backup);
    } catch {
      return {
        ...base,
        settings: defaultSettings(),
        issues: ['SETTINGS_CORRUPT'],
        exists: true,
        updatedAt: null,
        sha256: sha256(text),
        backup: null,
      };
    }
    return {
      ...base,
      settings: defaultSettings(),
      issues: ['SETTINGS_CORRUPT'],
      exists: false,
      updatedAt: null,
      sha256: sha256(text),
      backup,
    };
  }

  const normalized = normalizeSettings(parsed.settings ?? parsed);
  return {
    ...base,
    settings: normalized.settings,
    issues: normalized.issues,
    exists: true,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    sha256: sha256(text),
    backup: parsed.version !== undefined && parsed.version !== SETTINGS_VERSION ? `version:${parsed.version}` : null,
  };
}

/**
 * 原子写设置（临时文件 → fsync → rename → 回读校验）。
 * @param {any} settings 已通过 `applySettingsPatch` 的完整设置
 * @returns {Promise<{ ok: true, path: string, updatedAt: string, sha256: string, bytes: number }
 *   | { ok: false, code: 'SETTINGS_WRITE_FAILED'|'SETTINGS_VERIFY_FAILED', field: null, reason: 'WRITE_FAILED', message: string }>}
 */
export async function writeSettings(settings) {
  const file = settingsPath();
  const payload = { version: SETTINGS_VERSION, settings, updatedAt: new Date().toISOString() };
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  const dir = path.dirname(file);
  const temp = path.join(dir, `.settings-${process.pid}-${Date.now()}.tmp`);
  try {
    await fs.mkdir(dir, { recursive: true });
    const handle = await fs.open(temp, 'w');
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, file);
    try {
      const dirHandle = await fs.open(dir, 'r');
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch {
      // 目录 fsync 在部分文件系统不支持：rename 已经原子，忽略。
    }
    const readBack = await fs.readFile(file, 'utf8');
    if (readBack !== text) {
      return { ok: false, code: 'SETTINGS_VERIFY_FAILED', field: null, reason: 'WRITE_FAILED', message: '回读内容与写入不一致' };
    }
    return { ok: true, path: file, updatedAt: payload.updatedAt, sha256: sha256(readBack), bytes: Buffer.byteLength(readBack, 'utf8') };
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    return {
      ok: false,
      code: 'SETTINGS_WRITE_FAILED',
      field: null,
      reason: 'WRITE_FAILED',
      message: String(/** @type {Error} */ (error)?.message ?? error),
    };
  }
}

/**
 * 目录/文件的体量统计（存储分区用；只读）。
 * @param {string} target
 * @returns {Promise<{ files: number, bytes: number, exists: boolean }>}
 */
export async function sizeOf(target) {
  /** @type {{ files: number, bytes: number }} */
  const total = { files: 0, bytes: 0 };
  const walk = async (/** @type {string} */ current) => {
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const info = await fs.stat(full);
        total.files += 1;
        total.bytes += info.size;
      } catch {
        // 统计期间被删掉的：跳过
      }
    }
  };
  try {
    const info = await fs.stat(target);
    if (info.isFile()) return { files: 1, bytes: info.size, exists: true };
  } catch {
    return { files: 0, bytes: 0, exists: false };
  }
  await walk(target);
  return { ...total, exists: true };
}

/**
 * 工程里两类「可清理」的东西：历史快照（可删旧）与导出产物（**不可删**，只统计）。
 * @param {string} projectDir
 */
export async function projectStorage(projectDir) {
  const history = await sizeOf(path.join(projectDir, '.film', 'history'));
  const snapshotDir = path.join(projectDir, '.film', 'history', 'snapshots');
  /** @type {string[]} */
  let snapshots = [];
  try {
    snapshots = (await fs.readdir(snapshotDir)).filter((name) => !name.startsWith('.'));
  } catch {
    snapshots = [];
  }
  const exports = await sizeOf(path.join(projectDir, 'exports'));
  return {
    projectDir,
    history: { ...history, snapshots: snapshots.length },
    exports,
    snapshotDir,
  };
}

/**
 * 清理历史快照：**只**删 `.film/history/snapshots` 里的旧文件，保留最新 `keep` 个。
 *
 * 不碰 `exports/`（产物是用户的东西），不删 git 目录（撤销/排障还要能查），
 * 只删文件名（不是目录），并且逐个 unlink。UI 侧有二次确认与「删前列出文件数」。
 *
 * @param {string} projectDir
 * @param {{ keep?: number, confirm?: boolean }} options
 */
export async function cleanHistory(projectDir, options = {}) {
  const keep = Number.isInteger(options.keep) ? Math.max(0, Number(options.keep)) : 20;
  if (options.confirm !== true) {
    return { ok: false, code: 'CONFIRM_REQUIRED', message: '清理历史快照需要 confirm:true（不可撤销）' };
  }
  const root = path.resolve(projectDir);
  const snapshotDir = path.join(root, '.film', 'history', 'snapshots');
  if (!path.resolve(snapshotDir).startsWith(`${root}${path.sep}`)) {
    return { ok: false, code: 'E_PATH_ESCAPE', message: `快照目录越界：${snapshotDir}` };
  }
  /** @type {{ name: string, size: number, mtimeMs: number }[]} */
  let entries = [];
  try {
    const names = await fs.readdir(snapshotDir);
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const full = path.join(snapshotDir, name);
      try {
        const info = await fs.stat(full);
        if (info.isFile()) entries.push({ name, size: info.size, mtimeMs: info.mtimeMs });
      } catch {
        // 并发删除：跳过
      }
    }
  } catch {
    entries = [];
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const doomed = entries.slice(keep);
  let deleted = 0;
  let bytes = 0;
  for (const entry of doomed) {
    try {
      await fs.unlink(path.join(snapshotDir, entry.name));
      deleted += 1;
      bytes += entry.size;
    } catch {
      // 已经没了：不算失败
    }
  }
  return {
    ok: true,
    keep,
    before: entries.length,
    deleted,
    bytes,
    kept: entries.length - deleted,
    snapshotDir,
  };
}

/**
 * `.film/` 隐藏占用的分类（M68 · NEW-05）。
 *
 * 口径写死（任务书 §4.2）：
 * - `.film/cache/**` → cache；
 * - `.film/history/**`、`.film/versions.git/**`、`.film/versions-backup/**`、`.film/versions/**` → history；
 * - `.film/logs/**` 与任意 `*.log` → logs；
 * - 其余 → other。
 *
 * 重叠时**显式目录优先**（`.film/cache/x.log` 计 cache）；分类只按路径，不读内容。
 * @param {string} relative 相对工程根的路径（`/` 分隔）
 * @returns {'cache'|'history'|'logs'|'other'}
 */
export function classifyHiddenPath(relative) {
  const norm = String(relative).split(path.sep).join('/');
  if (norm === '.film/cache' || norm.startsWith('.film/cache/')) return 'cache';
  if (norm === '.film/history' || norm.startsWith('.film/history/')) return 'history';
  if (norm === '.film/versions' || norm.startsWith('.film/versions/')) return 'history';
  if (norm === '.film/versions.git' || norm.startsWith('.film/versions.git/')) return 'history';
  if (norm === '.film/versions-backup' || norm.startsWith('.film/versions-backup/')) return 'history';
  if (norm === '.film/logs' || norm.startsWith('.film/logs/')) return 'logs';
  const base = norm.slice(norm.lastIndexOf('/') + 1).toLowerCase();
  if (base.endsWith('.log')) return 'logs';
  return 'other';
}

/**
 * 扫描单个工程的隐藏占用。
 *
 * 边界：
 * - **不跟随符号链接**（Dirent.isSymbolicLink 直接跳过，不算进任何桶）；
 * - 只 `lstat` 拿 size，不打开文件（>2GB 也只 stat，不读）；
 * - 目录不可读 → `issues:["UNREADABLE:<abs>"]`，不抛。
 *
 * @param {string} projectDir
 * @param {{files?: string[], issues?: string[]}} [collect]
 * @returns {Promise<{cacheBytes:number,historyBytes:number,logsBytes:number,otherBytes:number}>}
 */
async function scanHidden(projectDir, collect = {}) {
  const totals = { cacheBytes: 0, historyBytes: 0, logsBytes: 0, otherBytes: 0 };
  const issues = collect.issues;
  const files = collect.files;
  /** @param {string} current */
  const walk = async (current) => {
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') issues?.push(`UNREADABLE:${current}`);
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      let size = 0;
      try {
        const info = await fs.lstat(full);
        if (!info.isFile()) continue;
        size = info.size;
      } catch {
        issues?.push(`UNREADABLE:${full}`);
        continue;
      }
      const kind = classifyHiddenPath(path.relative(projectDir, full));
      if (kind === 'cache') totals.cacheBytes += size;
      else if (kind === 'history') totals.historyBytes += size;
      else if (kind === 'logs') totals.logsBytes += size;
      else totals.otherBytes += size;
      files?.push(full);
    }
  };
  await walk(projectDir);
  return totals;
}

/**
 * 多工程隐藏占用汇总（诊断页用）。
 *
 * @param {{projects?: {id: string, path: string}[]}} [options]
 * @returns {Promise<{
 *   cacheBytes: number, historyBytes: number, logsBytes: number, otherBytes: number, totalBytes: number,
 *   byProject: {id: string, path: string, cacheBytes: number, historyBytes: number, logsBytes: number}[],
 *   issues: string[],
 * }>}
 */
export async function hiddenUsage(options = {}) {
  const projects = Array.isArray(options.projects) ? options.projects : [];
  /** @type {string[]} */
  const issues = [];
  let cacheBytes = 0;
  let historyBytes = 0;
  let logsBytes = 0;
  let otherBytes = 0;
  /** @type {{id: string, path: string, cacheBytes: number, historyBytes: number, logsBytes: number}[]} */
  const byProject = [];
  for (const project of projects) {
    const pathValue = typeof project?.path === 'string' ? project.path : '';
    if (pathValue === '') continue;
    const totals = await scanHidden(pathValue, { issues });
    byProject.push({
      id: String(project.id ?? ''),
      path: pathValue,
      cacheBytes: totals.cacheBytes,
      historyBytes: totals.historyBytes,
      logsBytes: totals.logsBytes,
    });
    cacheBytes += totals.cacheBytes;
    historyBytes += totals.historyBytes;
    logsBytes += totals.logsBytes;
    otherBytes += totals.otherBytes;
  }
  return {
    cacheBytes,
    historyBytes,
    logsBytes,
    otherBytes,
    totalBytes: cacheBytes + historyBytes + logsBytes + otherBytes,
    byProject,
    issues,
  };
}

/**
 * 只清 `.film/cache/**`（M68）。**不动** history / logs / 其它文件。
 *
 * 返回清理前后对比；目录本身保留（UI 可能往里写）。符号链接不跟随、不删除。
 *
 * @param {string} projectDir
 * @param {{confirm?: boolean}} [options]
 * @returns {Promise<any>}
 */
export async function cleanCache(projectDir, options = {}) {
  if (options.confirm !== true) {
    return { ok: false, code: 'CONFIRM_REQUIRED', message: '清理缓存需要 confirm:true（不可撤销）' };
  }
  const root = path.resolve(projectDir);
  const cacheDir = path.join(root, '.film', 'cache');
  if (!path.resolve(cacheDir).startsWith(`${root}${path.sep}`)) {
    return { ok: false, code: 'E_PATH_ESCAPE', message: `缓存目录越界：${cacheDir}` };
  }
  const before = await hiddenUsage({ projects: [{ id: '', path: root }] });
  /** @type {string[]} */
  const issues = [];
  let removed = 0;
  let freedBytes = 0;
  /** @param {string} current */
  const walk = async (current) => {
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') issues.push(`UNREADABLE:${current}`);
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full);
        await fs.rmdir(full).catch(() => {});
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const info = await fs.lstat(full);
        await fs.unlink(full);
        removed += 1;
        freedBytes += info.size;
      } catch {
        issues.push(`UNREADABLE:${full}`);
      }
    }
  };
  await walk(cacheDir);
  const after = await hiddenUsage({ projects: [{ id: '', path: root }] });
  const pick = (/** @type {any} */ usage) => ({
    cacheBytes: usage.cacheBytes,
    historyBytes: usage.historyBytes,
    logsBytes: usage.logsBytes,
    otherBytes: usage.otherBytes,
    totalBytes: usage.totalBytes,
  });
  return {
    ok: true,
    path: cacheDir,
    removed,
    freedBytes,
    before: pick(before),
    after: pick(after),
    issues: [...new Set([...issues, ...before.issues, ...after.issues])],
  };
}

/**
 * 诊断信息（只读、不联网）。
 *
 * `ffmpeg` 走 `OPENCUT_FFMPEG` 或 PATH；版本用 `-version` 的第一行。失败不抛：
 * 诊断页要能显示「没找到」而不是整页 500。
 */
export async function diagnostics({ ports = {}, projectRoot = '', logsDir = '', studioVersion = '' } = {}) {
  const ffmpegPath = String(process.env.OPENCUT_FFMPEG ?? 'ffmpeg');
  const version = await new Promise((done) => {
    execFile(ffmpegPath, ['-version'], { timeout: 3000 }, (error, stdout) => {
      if (error) {
        done({ ok: false, line: String(/** @type {Error} */ (error)?.message ?? error).slice(0, 160) });
        return;
      }
      done({ ok: true, line: String(stdout ?? '').split('\n')[0] ?? '' });
    });
  });
  return {
    studioVersion,
    settingsPath: settingsPath(),
    ffmpeg: { path: ffmpegPath, ...version },
    ports,
    projectRoot,
    logsDir,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  };
}

/**
 * 五个 AI 分区的**只读**卡片（M49）。
 *
 * 只看路径在不在（`existsSync`）：不读内容、不解析密钥、不发网络请求。
 * 路径都是「约定位置」，检测不到就如实写「未检测到」+ 只读原因。
 */
export function aiCards() {
  const home = os.homedir();
  /* CS2（U07）：入站 MCP 的真实入口在本仓里，不是一个用户目录下的约定文件。
     只报路径与存在性（stat），不启动进程、不读内容。 */
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  /** @type {Array<{id: string, label: string, path: string, reason: string}>} */
  const cards = [
    { id: 'agents', label: 'Agents', path: path.join(home, '.opencut', 'agents.json'), reason: '本轮只读：Agent 清单由外部工具管理，设置中心只显示约定位置' },
    { id: 'models', label: 'Models', path: path.join(home, '.opencut', 'models.json'), reason: '本轮只读：模型配置不落本应用，避免两份真相' },
    { id: 'providers', label: 'Providers', path: path.join(home, '.opencut', 'providers.json'), reason: '本轮只读：不读取密钥明文，只 stat 路径' },
    { id: 'skills', label: 'Skills', path: path.join(home, '.opencut', 'skills'), reason: '本轮只读：技能目录由外部安装器维护' },
    { id: 'mcp', label: 'MCP', path: path.join(home, '.opencut', 'mcp.json'), reason: '只读：本卡片只显示旧位置是否存在；MCP 配置真源是设置中心 mcp.servers（M65），本文件不再读取' },
    {
      id: 'mcp-inbound',
      label: 'MCP 入站编辑服务',
      path: path.join(repoRoot, 'packages', 'mcp', 'bin.mjs'),
      reason: '本台给外部 Agent 的 stdio JSON-RPC 服务：读工具默认可用，写工具需 --allow-write + 每次 confirm；本卡片只 stat 路径',
    },
  ];
  return cards.map((card) => ({ ...card, exists: existsSync(card.path) }));
}
