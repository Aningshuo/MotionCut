/**
 * 设置中心面板（M49）。
 *
 * 六个真分区（播放 / 导出 / 存储 / 诊断 / 快捷键 / 关于）+ 五个只读占位
 * （Agents / Models / Providers / Skills / MCP）。
 *
 * 设计约束（任务书 §4）：
 * - 只读分区**只显示路径与检测状态**，不发网络请求、不读密钥明文；
 * - 改设置只走 `onChange(patch)`，写盘由宿主防抖（本组件不直接 fetch，方便测）；
 * - 「清理缓存」必须二次确认，且确认文案里带**删前文件数**——别让人闭眼点掉历史；
 * - 快捷键列表来自 `keymap.mjs`（与键盘处理同一份表），不在这里另抄一遍。
 */

import { createElement, useState } from 'react';
import type { ReactNode } from 'react';

import { SHORTCUTS, SHORTCUT_GROUPS } from './keymap.mjs';
import type { McpServerEntry, SettingsAiCard, SettingsDiagnostics, SettingsFields, StorageReport } from './api';
import { McpSettingsEditor } from './settings-mcp';
import { clearNoticeLog, formatNoticeTime, readNoticeLog } from './notice-log';
import { ModelKeyPanel } from './model-key-panel';
import { SettingsAgents } from './settings-agents';
import { SettingsMedia } from './settings-media';
import { SettingsModels } from './settings-models';
import { useStudioTheme } from './studio-theme';

const h = createElement;

export interface SettingsSection {
  id: string;
  label: string;
  /** 只读分区：没有控件，只有「路径 + 检测状态 + 原因」。 */
  readOnly?: boolean;
}

/** 分区顺序即导航顺序：真功能在前，AI 占位在后（占位不进持久化）。 */
/**
 * 分区顺序 = 导航顺序。CS1（§5）按 OpenFilm 的功能层次重排：
 * 先「智能体 → 聊天模型 → 自有密钥 → 接口与工具 → 媒体服务」五个 AI 域，
 * 再是原有的通用设置（播放 / 导出 / 存储 / 诊断 / 快捷键 / 关于）。
 *
 * `id` 保持不变（`agents` / `models` / `model-key` / `mcp`）：历史探针与外部脚本
 * 按 id 定位；只改标签与内容，不改契约。`providers` / `skills` 两张只读占位已并入
 * 「媒体服务」（它们本来就是「约定位置 + 未提供」的同一件事）。
 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = Object.freeze([
  { id: 'appearance', label: '外观' },
  { id: 'playback', label: '播放' },
  { id: 'export', label: '导出' },
  { id: 'model-key', label: '自有密钥' },
  { id: 'agents', label: '智能体' },
  { id: 'models', label: '聊天模型' },
  { id: 'mcp', label: '接口与工具' },
  { id: 'media', label: '媒体服务' },
  { id: 'storage', label: '存储' },
  { id: 'diagnostics', label: '诊断' },
  { id: 'shortcuts', label: '快捷键' },
  { id: 'about', label: '关于' },
]);

export interface SettingsPanelProps {
  section: string;
  onSection: (id: string) => void;
  settings: SettingsFields;
  defaults: SettingsFields;
  issues: string[];
  settingsPath: string;
  updatedAt: string | null;
  ai: SettingsAiCard[];
  diagnostics: SettingsDiagnostics | null;
  storage: StorageReport | null;
  busy: boolean;
  error: string;
  notice: string;
  projectOpen: boolean;
  version: string;
  onClose: () => void;
  onChange: (patch: Partial<SettingsFields>) => void;
  onReloadStorage: () => void;
  onCleanCache: (keep: number) => void;
  onCopyDiagnostics: () => void;
  /** S69：MCP 分区保存成功后把回读列表交回来（宿主同步 settings 状态）。 */
  onMcpSaved: (servers: McpServerEntry[]) => void;
}

/** @param {number} bytes */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 一行：左标签 + 右控件 + 可选说明。 */
function row(label: string, control: ReactNode, hint?: string): ReactNode {
  return h(
    'div',
    { className: 'settings-row', key: label },
    h('div', { className: 'settings-row-label' }, h('span', null, label), hint === undefined ? null : h('small', null, hint)),
    h('div', { className: 'settings-row-control' }, control),
  );
}

export function SettingsPanel(props: SettingsPanelProps): ReactNode {
  const theme = useStudioTheme();
  const [confirmClean, setConfirmClean] = useState(false);
  /* CS1（AC07/AT13）：统一设置壳的搜索。只过滤**分区名**（不假装能搜设置项内容），
     命中数写在 `data-hits`，空结果有单独一行。 */
  const [query, setQuery] = useState('');
  /* CS3（R-F04）：智能体程序路径的复制位反馈。空字符串 = 还没点过。 */
  const [agentsPathCopy, setAgentsPathCopy] = useState('');
  const term = query.trim().toLowerCase();
  const navSections = SETTINGS_SECTIONS.filter((item) => term === '' || item.label.toLowerCase().includes(term));
  /** 找不到就回播放页（`noUncheckedIndexedAccess` 下数组下标可能是 undefined）。 */
  const fallbackSection: SettingsSection = { id: 'playback', label: '播放' };
  const section = SETTINGS_SECTIONS.find((item) => item.id === props.section) ?? fallbackSection;
  const playback = props.settings.playback;
  const exportDefaults = props.settings.export;
  const ai = props.ai.find((card) => card.id === section.id) ?? null;
  /* CS3（R-F04 / SET01–SET05）：智能体那条「程序路径」卡从 Agents 页搬到这里。
     只读副本，不新增存储；空路径就是空，不拿假值糊。 */
  const agentsCard = props.ai.find((card) => card.id === 'agents') ?? null;
  const copyAgentsPath = (): void => {
    const text = agentsCard?.path ?? '';
    if (text === '') {
      setAgentsPathCopy('empty');
      return;
    }
    void navigator.clipboard
      ?.writeText(text)
      .then(() => setAgentsPathCopy('copied'))
      .catch(() => setAgentsPathCopy('failed'));
  };
  const snapshots = props.storage?.history.snapshots ?? 0;
  const keep = 20;

  const content = (() => {
    if (section.id === 'appearance') {
      return h('div', { className: 'settings-group', 'data-testid': 'settings-group-appearance' },
        row('界面主题', h('div', { className: 'theme-options', role: 'group', 'aria-label': '界面主题' },
          ...(['dark', 'light'] as const).map((mode) => h('button', {
            key: mode, type: 'button', 'aria-pressed': theme === mode, 'data-testid': 'theme-' + mode,
            onClick: () => props.onChange({ appearance: { theme: mode } }),
          }, mode === 'dark' ? '深色' : '浅色')),
        )),
      );
    }
    if (section.id === 'playback') {
      return h(
        'div',
        { className: 'settings-group', 'data-testid': 'settings-group-playback' },
        row(
          '默认音量',
          h(
            'div',
            { className: 'settings-slider' },
            h('input', {
              type: 'range',
              min: 0,
              max: 100,
              step: 1,
              value: playback.volume,
              'data-testid': 'settings-volume',
              'data-value': String(playback.volume),
              onChange: (event: { target: { value: string } }) => props.onChange({ playback: { ...playback, volume: Number(event.target.value) } }),
            }),
            h('span', { className: 'settings-value', 'data-testid': 'settings-volume-value' }, `${playback.volume}%`),
          ),
          '新开工程时生效；已经打开的工程不受影响',
        ),
        row(
          '循环播放',
          h('input', {
            type: 'checkbox',
            checked: playback.loop,
            'data-testid': 'settings-loop',
            onChange: (event: { target: { checked: boolean } }) => props.onChange({ playback: { ...playback, loop: event.target.checked } }),
          }),
          '只持久化（本轮不接线）',
        ),
        row(
          '播放时隐藏鼠标',
          h('input', {
            type: 'checkbox',
            checked: playback.hideCursorWhilePlaying,
            'data-testid': 'settings-hide-cursor',
            onChange: (event: { target: { checked: boolean } }) =>
              props.onChange({ playback: { ...playback, hideCursorWhilePlaying: event.target.checked } }),
          }),
          '只持久化（本轮不接线）',
        ),
      );
    }
    if (section.id === 'export') {
      return h(
        'div',
        { className: 'settings-group', 'data-testid': 'settings-group-export' },
        row(
          '默认帧率',
          h(
            'select',
            {
              'data-testid': 'settings-fps',
              value: String(exportDefaults.fps),
              onChange: (event: { target: { value: string } }) =>
                props.onChange({ export: { ...exportDefaults, fps: Number(event.target.value) as SettingsFields['export']['fps'] } }),
            },
            ...[24, 25, 30, 60].map((fps) => h('option', { value: String(fps), key: fps }, `${fps} fps`)),
          ),
          '导出面板初值（不影响已填的表单）',
        ),
        row(
          '默认编码',
          h(
            'select',
            {
              'data-testid': 'settings-codec',
              value: exportDefaults.codec,
              onChange: (event: { target: { value: string } }) =>
                props.onChange({ export: { ...exportDefaults, codec: event.target.value as SettingsFields['export']['codec'] } }),
            },
            h('option', { value: 'h264' }, 'H.264'),
            h('option', { value: 'hevc' }, 'HEVC'),
          ),
          '导出面板初值；M50 起真的作用到导出请求（h264 默认 = 与以前逐字节相同）',
        ),
        row(
          '默认质量',
          h(
            'select',
            {
              'data-testid': 'settings-quality',
              value: exportDefaults.quality,
              onChange: (event: { target: { value: string } }) =>
                props.onChange({ export: { ...exportDefaults, quality: event.target.value as SettingsFields['export']['quality'] } }),
            },
            h('option', { value: 'draft' }, 'draft'),
            h('option', { value: 'standard' }, 'standard'),
            h('option', { value: 'high' }, 'high'),
          ),
          '导出面板初值',
        ),
        row(
          '临时目录',
          h('code', { className: 'settings-path', 'data-testid': 'settings-tmpdir' }, '系统临时目录（导出中自动清理）'),
          '只读展示：没有单独配置项，避免「配了不生效」',
        ),
      );
    }
    if (section.id === 'storage') {
      return h(
        'div',
        { className: 'settings-group', 'data-testid': 'settings-group-storage' },
        row('工程根', h('code', { className: 'settings-path', 'data-testid': 'settings-project-root' }, props.diagnostics?.projectRoot || '—'), '只读'),
        row(
          '缓存大小',
          h(
            'span',
            { className: 'settings-path', 'data-testid': 'settings-cache-size', 'data-snapshots': String(snapshots) },
            props.storage === null
              ? '…'
              : `历史快照 ${snapshots} 个 / ${formatBytes(props.storage.history.bytes)} · 导出产物 ${props.storage.exports.files} 个 / ${formatBytes(props.storage.exports.bytes)}`,
          ),
          '导出产物**不会**被清理',
        ),
        row(
          '清理历史快照',
          confirmClean
            ? h(
                'div',
                { className: 'settings-confirm' },
                h('span', { 'data-testid': 'settings-clean-confirm-text' }, `将删除 ${Math.max(0, snapshots - keep)} 个旧快照（保留最新 ${keep} 个），不可撤销`),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'btn tiny danger',
                    'data-testid': 'settings-clean-confirmed',
                    disabled: props.busy || !props.projectOpen,
                    onClick: () => {
                      setConfirmClean(false);
                      props.onCleanCache(keep);
                    },
                  },
                  '确认清理',
                ),
                h(
                  'button',
                  { type: 'button', className: 'btn tiny', 'data-testid': 'settings-clean-cancel', onClick: () => setConfirmClean(false) },
                  '取消',
                ),
              )
            : h(
                'button',
                {
                  type: 'button',
                  className: 'btn tiny',
                  'data-testid': 'settings-clean',
                  disabled: props.busy || !props.projectOpen,
                  onClick: () => {
                    props.onReloadStorage();
                    setConfirmClean(true);
                  },
                },
                '清理…',
              ),
          props.projectOpen ? '只清 .film/history/snapshots' : '先打开一个工程',
        ),
        row('刷新统计', h('button', { type: 'button', className: 'btn tiny', 'data-testid': 'settings-storage-reload', onClick: props.onReloadStorage }, '重新统计')),
      );
    }
    if (section.id === 'diagnostics') {
      const diag = props.diagnostics;
      const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
      const electron = /Electron\/([0-9.]+)/.exec(ua)?.[1] ?? '—';
      const chromium = /Chrome\/([0-9.]+)/.exec(ua)?.[1] ?? '—';
      return h(
        'div',
        { className: 'settings-group', 'data-testid': 'settings-group-diagnostics' },
        row('版本', h('code', { className: 'settings-path' }, props.version), 'Studio 版本'),
        /* 剪辑区不再常驻错误条，统一在这里按时间倒序列出最近 30 条 */
        (() => {
          const entries = readNoticeLog().slice(-30).reverse();
          return h(
            'div',
            { className: 'settings-log', 'data-testid': 'settings-notice-log' },
            h('div', { className: 'settings-log-head' },
              h('strong', null, `错误与提示（${String(entries.length)}）`),
              entries.length === 0
                ? null
                : h('button', {
                    type: 'button',
                    className: 'btn tiny',
                    'data-testid': 'settings-notice-log-clear',
                    onClick: () => { clearNoticeLog(); },
                  }, '清空'),
            ),
            entries.length === 0
              ? h('p', { className: 'settings-log-empty' }, '暂无记录')
              : h('ul', { className: 'settings-log-list' },
                  ...entries.map((entry, index) => h('li', {
                    key: `${entry.at}-${String(index)}`,
                    'data-level': entry.level,
                  },
                    h('time', { dateTime: entry.at }, formatNoticeTime(entry.at)),
                    h('span', { className: 'settings-log-text' }, entry.text),
                    entry.guardCode === undefined ? null : h('code', null, entry.guardCode),
                  )),
                ),
          );
        })(),
        row('Electron / Chromium', h('code', { className: 'settings-path', 'data-testid': 'settings-versions' }, `${electron} / ${chromium}`), '来自 navigator.userAgent'),
        row('Node', h('code', { className: 'settings-path' }, diag?.node ?? '—'), 'Studio 进程'),
        row('ffmpeg', h('code', { className: 'settings-path', 'data-testid': 'settings-ffmpeg' }, diag === null ? '…' : diag.ffmpeg.ok ? diag.ffmpeg.line : `不可用：${diag.ffmpeg.line}`)),
        row('ffmpeg 路径', h('code', { className: 'settings-path' }, diag?.ffmpeg.path ?? '—')),
        row(
          '端口',
          h('code', { className: 'settings-path', 'data-testid': 'settings-ports' }, diag === null ? '…' : `studio ${diag.ports.studio ?? '—'} · vite ${diag.ports.vite ?? '—'} · content ${diag.ports.content ?? '—'}`),
        ),
        row('设置文件', h('code', { className: 'settings-path', 'data-testid': 'settings-file' }, props.settingsPath)),
        /* CS3（R-F04）：绝对路径的唯一常驻位置 + 复制位。
           Agents 页只回答「连没连上」，要贴给别人的路径从这里拿。 */
        row(
          '智能体程序路径',
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap', minWidth: 0 } },
            h(
              'code',
              {
                className: 'settings-path',
                'data-testid': 'settings-agents-path',
                'data-exists': String(agentsCard?.exists === true),
                style: { overflowWrap: 'anywhere' },
              },
              agentsCard?.path ?? '—',
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'btn tiny',
                'data-testid': 'settings-diagnostics-copy',
                'data-copy-state': agentsPathCopy === '' ? 'idle' : agentsPathCopy,
                onClick: copyAgentsPath,
              },
              agentsPathCopy === 'copied' ? '已复制' : agentsPathCopy === 'failed' ? '复制失败' : agentsPathCopy === 'empty' ? '没有路径' : '复制路径',
            ),
          ),
          `约定位置${agentsCard?.exists === true ? '存在' : '不存在'}；与「智能体」页同源（只 stat，不读内容）`,
        ),
        row(
          '复制诊断信息',
          h('button', { type: 'button', className: 'btn tiny', 'data-testid': 'settings-copy-diag', onClick: props.onCopyDiagnostics }, '复制到剪贴板'),
          '纯文本，不含任何密钥',
        ),
      );
    }
    if (section.id === 'shortcuts') {
      return h(
        'div',
        { className: 'settings-group', 'data-testid': 'settings-group-shortcuts' },
        ...SHORTCUT_GROUPS.map((group) =>
          h(
            'div',
            { className: 'settings-shortcut-group', key: group.id },
            h('h4', null, group.label),
            ...SHORTCUTS.filter((item) => item.group === group.id).map((item) =>
              h(
                'div',
                { className: 'settings-shortcut', key: item.id, 'data-testid': `settings-shortcut-${item.id}` },
                h('span', null, item.label),
                h('kbd', null, item.keys.join(' / ')),
              ),
            ),
          ),
        ),
        h('p', { className: 'settings-note' }, '只读列表：键位由代码里的 keymap 决定（本批不做自定义键位）。'),
      );
    }
    if (section.id === 'about') {
      return h(
        'div',
        { className: 'settings-group', 'data-testid': 'settings-group-about' },
        /* B08（R109）：产品身份显示在这里。渲染层不能 import 主进程模块（apps/desktop/src/identity.mjs），
           所以这一行是**展示副本**；真值源仍是 identity.mjs 的 APP_NAME，改名时两处一起改。 */
        row('应用', h('code', { className: 'settings-path', 'data-testid': 'settings-app-name' }, 'MotionCut'), '产品名（打包名 / 窗口标题同源）'),
        /* R41（R31-100 A2）：这一行叫「版本」，顶栏那颗按钮也叫「版本」—— 但两者不是一件事：
           这里是**应用版本号**（只读，Studio x.y.z），顶栏那颗是**工程版本历史**
           （新建命名版本 / 对比 / 恢复 film.html）。加半句提示，避免对着设置找版本历史。 */
        row('版本', h('code', { className: 'settings-path' }, props.version), 'Studio 版本；工程版本历史在顶栏「版本」'),
        row('合同', h('code', { className: 'settings-path' }, 'opencut 1.2.0 / r5'), 'contracts/MANIFEST.json'),
        row('许可证', h('code', { className: 'settings-path' }, '私有项目（未开源）')),
        row('项目主页', h('code', { className: 'settings-path' }, '本地应用：不联网')),
        row('设置文件', h('code', { className: 'settings-path' }, props.settingsPath)),
      );
    }
    if (section.id === 'mcp') {
      /* CS1（§5 接口与工具）：ACP / CLI / MCP 三个方向先写清楚，再放 MCP 编辑器。
         编辑器本身没改（S69 的契约）；这一块只是把「入站/出站」与「聊天 Agent 的桥」
         分开说，避免把 MCP 当成聊天协议（AT24）。 */
      const servers = props.settings.mcp?.servers ?? [];
      const enabledServers = servers.filter((row) => row.enabled !== false);
      const inboundCard = props.ai.find((card) => card.id === 'mcp-inbound') ?? null;
      const inboundPath = inboundCard?.path ?? '';
      return h(
        'div',
        { 'data-testid': 'settings-group-tools', 'data-wired': 'true' },
        h(
          'div',
          { className: 'settings-card', 'data-testid': 'settings-tools-directions' },
          h('div', { className: 'settings-card-head' }, h('strong', null, '接口方向（四种，合同不同）')),
          h('p', { className: 'settings-note', 'data-direction': 'acp' }, 'ACP（工作台 → Agent 桥）：会话主路径与版本合同归主线；本页只显示设置项，不探测握手。'),
          h('p', { className: 'settings-note', 'data-direction': 'cli' }, 'CLI 编辑入口：由 Agent 侧调用，不在设置里开放任意 shell。'),
        ),
        /* CS2（U07）· 入站：本台**给**外部 Agent 的编辑服务。它和下面的 server 列表
           不是同一件事 —— 入站是 stdio 服务，出站是允许名单。旧文案把两者混在一句，
           导致「下面的列表对入站生效」这种错读。 */
        h(
          'div',
          {
            className: 'settings-card',
            'data-testid': 'settings-mcp-inbound',
            'data-direction': 'inbound',
            'data-entry': inboundPath,
            'data-entry-exists': String(inboundCard?.exists === true),
          },
          h(
            'div',
            { className: 'settings-card-head' },
            h('strong', null, '入站 · 本台给外部 Agent'),
            h(
              'span',
              { className: 'settings-badge', 'data-testid': 'settings-mcp-inbound-state' },
              inboundCard === null ? '入口未知' : inboundCard.exists ? '入口存在' : '入口缺失',
            ),
          ),
          h(
            'p',
            { className: 'settings-note' },
            'stdio JSON-RPC（MCP 2025-06-18 协商）：外部 Agent 通过 tools/list、tools/call 读写本机工程。film 端口按集成合同注入（产品写路径与历史归主线）；写工具还要两层门：启动加 --allow-write，且每次调用带 confirm:true。',
          ),
          h('code', { className: 'settings-path', 'data-testid': 'settings-mcp-inbound-path' }, inboundPath === '' ? '—' : inboundPath),
          h(
            'p',
            { className: 'settings-note', 'data-testid': 'settings-mcp-inbound-command' },
            `启动：node ${inboundPath === '' ? '<entry>' : inboundPath} --root <工程根> --film-module <主线端口> [--allow-write]`,
          ),
          h(
            'p',
            { className: 'settings-note' },
            '消费者是外部 Agent 自己（Claude Desktop / Codex 等按 stdio 拉起）；本页不偷偷起进程、不自动放行写工具。',
          ),
        ),
        /* CS2（U07）· 出站：本 Agent 连外部 server 的**允许名单**。消费者是 ACP
           session/new 的 mcpServers —— 只下发 enabled 的条目；已在跑的会话不重启。 */
        h(
          'div',
          {
            className: 'settings-card',
            'data-testid': 'settings-mcp-outbound',
            'data-direction': 'outbound',
            'data-total': String(servers.length),
            'data-enabled': String(enabledServers.length),
          },
          h(
            'div',
            { className: 'settings-card-head' },
            h('strong', null, '出站 · 本 Agent 连外部 server'),
            h(
              'span',
              { className: 'settings-badge', 'data-testid': 'settings-mcp-outbound-state' },
              `${String(enabledServers.length)}/${String(servers.length)} 启用`,
            ),
          ),
          h(
            'p',
            { className: 'settings-note' },
            '下面的列表就是允许名单：只有勾选启用的条目会随新建 ACP 会话下发（session/new.mcpServers）；不改你的全局配置，也不会因为「发现了」就自动放行。',
          ),
          h(
            'p',
            { className: 'settings-note' },
            '入站 ≠ 出站：入站是本台提供工具，出站是本 Agent 使用别人的工具；两者开关、作用域、失败语义都不同。',
          ),
        ),
        h(McpSettingsEditor, { onSaved: props.onMcpSaved }),
      );
    }
    /* 自有密钥（S104 + CS1 AC11）：Key 仍走 `/api/settings/model-key`（一次性提交），
       连接参数（格式/地址/模型/推理/上下文）走 `byok` 分区补丁。 */
    if (section.id === 'model-key') {
      return h(ModelKeyPanel, { settings: props.settings, onChange: props.onChange });
    }
    /* CS1（AC08/AT14–15）：智能体发现/连接/显示开关。 */
    if (section.id === 'agents') {
      return h(SettingsAgents, { settings: props.settings, ai: props.ai, onChange: props.onChange, onOpenSection: props.onSection });
    }
    /* CS1（AC09/AC10）：聊天模型的真实目录 + 全局默认（与会话 chip 同源）。 */
    if (section.id === 'models') {
      return h(SettingsModels, { settings: props.settings, onChange: props.onChange });
    }
    /* CS1（AC12）：媒体服务与聊天模型分域；本版全部未提供，不放开关。 */
    if (section.id === 'media') {
      return h(SettingsMedia, { ai: props.ai });
    }
    // 四个只读分区（Agents / Models / Providers / Skills）：诚实标注，不放假开关。
    // U07（R102）：措辞从「只读 · 尚未实现」收敛成 **未接** —— 用户看得懂「没接上」，
    // 「尚未实现」听起来像「快好了」。三个位置都标：导航小字 / 标题 chip / 卡片状态点，
    // 另加 `data-wired="false"` 让量具能直接判（不用去嗅文案）。
    return h(
      'div',
      { className: 'settings-group', 'data-testid': `settings-group-${section.id}`, 'data-readonly': 'true', 'data-wired': 'false' },
      h(
        'div',
        { className: 'settings-card', 'data-testid': 'settings-ai-card', 'data-exists': ai === null ? 'false' : String(ai.exists), 'data-wired': 'false' },
        h(
          'div',
          { className: 'settings-card-head' },
          h('strong', null, section.label),
          /* 只有**真检测到**才说「检测到」；没状态就写「未接」，不写「未检测到」——
             后者听着像「检测了但没找到」，实际是「根本没接」。 */
          h('span', { className: ai !== null && ai.exists ? 'dot ok' : 'dot warn' }, ai !== null && ai.exists ? '检测到' : '未接'),
          h('span', { className: 'settings-badge', 'data-testid': 'settings-readonly-badge' }, '只读 · 尚未实现'),
        ),
        h('code', { className: 'settings-path', 'data-testid': 'settings-ai-path' }, ai?.path ?? '—'),
        h('p', { className: 'settings-note', 'data-testid': 'settings-ai-reason' }, ai?.reason ?? '未接：这一版没有可连的 provider / 服务'),
      ),
      h(
        'p',
        { className: 'settings-note', 'data-testid': 'settings-readonly-note' },
        '未接（尚未实现）：这一区没有接到任何 provider 或服务，所以这里只显示约定位置与检测状态 —— 不读内容、不发网络请求、不读密钥明文，也没有开关；本版不能从这里编辑它。',
      ),
    );
  })();

  return h(
    'div',
    {
      className: 'settings-backdrop',
      'data-testid': 'settings-backdrop',
      onMouseDown: (event: { target: unknown; currentTarget: unknown }) => {
        if (event.target === event.currentTarget) props.onClose();
      },
    },
    h(
      'div',
      {
        className: 'settings-panel',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': '设置',
        'data-testid': 'settings-panel',
        'data-section': section.id,
        'data-exists': String(props.settingsPath !== ''),
        'data-error': props.error,
        'data-saved-at': props.updatedAt ?? '',
      },
      h(
        'div',
        { className: 'settings-head' },
        h('strong', null, '设置'),
        h('span', { className: 'settings-head-path', title: props.settingsPath }, props.settingsPath),
        h('button', { type: 'button', className: 'btn tiny', 'data-testid': 'settings-close', onClick: props.onClose }, '关闭'),
      ),
      h(
        'div',
        { className: 'settings-body' },
        h(
          'nav',
          {
            className: 'settings-nav',
            'data-testid': 'settings-nav',
            'data-hits': String(navSections.length),
            'data-query': term,
            'data-scope': 'section-label',
          },
          h('input', {
            'data-testid': 'settings-search',
            type: 'search',
            value: query,
            placeholder: '搜索设置分区…',
            'aria-label': '搜索设置分区（只搜分区名）',
            style: {
              width: '100%',
              height: '24px',
              marginBottom: '6px',
              padding: '0 6px',
              border: '1px solid var(--line)',
              /* ST34/35：搜索 10.5 → 15，圆角 6 → 8（盒子宽高不动）。 */
              borderRadius: '8px',
              background: 'var(--bg)',
              color: 'var(--text)',
              font: 'inherit',
              fontSize: '15px',
              boxSizing: 'border-box',
            },
            onChange: (event: { target: { value: string } }) => setQuery(event.target.value),
          }),
          navSections.length === 0
            ? h(
                'p',
                { 'data-testid': 'settings-search-empty', style: { margin: 0, fontSize: '9.5px', color: 'var(--text-mute)' } },
                `分区名里没有「${query.trim()}」（只搜分区名）`,
              )
            : null,
          ...navSections.map((item) =>
            h(
              'button',
              {
                type: 'button',
                key: item.id,
                className: item.id === section.id ? 'settings-nav-item active' : 'settings-nav-item',
                'data-testid': `settings-nav-${item.id}`,
                'data-active': String(item.id === section.id),
                'aria-current': item.id === section.id ? 'page' : undefined,
                onClick: () => props.onSection(item.id),
              },
              item.label,
              /* U07（R102）：导航上直接写「未接」。原来的「只读·未实现」是给开发者看的，
                 用户读到的是「这功能坏了」。`data-wired` 供量具判，不靠文案。 */
              item.readOnly === true ? h('small', { 'data-wired': 'false' }, '未接') : null,
            ),
          ),
        ),
        h(
          'div',
          {
            className: 'settings-content',
            'data-testid': 'settings-content',
            /* 滑动时显形、停下 700ms 淡出；只改 class，不触发 React 重渲染 */
            onScroll: (event: { currentTarget: HTMLElement }) => {
              const el = event.currentTarget;
              el.classList.add('is-scrolling');
              const holder = el as HTMLElement & { __scrollFade?: number };
              if (holder.__scrollFade !== undefined) window.clearTimeout(holder.__scrollFade);
              holder.__scrollFade = window.setTimeout(() => {
                el.classList.remove('is-scrolling');
                holder.__scrollFade = undefined;
              }, 700);
            },
          },
          h(
            'h3',
            null,
            section.label,
            section.readOnly === true
              ? h(
                  'small',
                  {
                    className: 'settings-badge',
                    'data-testid': 'settings-unwired',
                    'data-wired': 'false',
                    title: '这一区没有接到任何 provider / 服务：只显示约定位置与检测状态',
                  },
                  '未接',
                )
              : null,
          ),
          props.issues.length > 0
            ? h('div', { className: 'settings-issues', 'data-testid': 'settings-issues' }, `设置文件有问题：${props.issues.join(', ')}`)
            : null,
          content,
          props.notice === '' ? null : h('div', { className: 'settings-notice', 'data-testid': 'settings-notice' }, props.notice),
          props.error === '' ? null : h('div', { className: 'settings-error', 'data-testid': 'settings-error' }, props.error),
        ),
      ),
    ),
  );
}
