/**
 * 快捷键表（M49）。
 *
 * ## 为什么要有这个文件
 *
 * 设置中心的「快捷键」分区要列出现有快捷键。如果面板自己抄一份文案，那就变成两个真相：
 * 改了实现忘了改面板，用户看到的键就是错的。所以表**只有这一份**，面板渲染它，
 * 键盘处理也用它判断（`matchShortcut`）。
 *
 * ## 不在这里做的事
 *
 * - 不做可配置键位（本批只读展示，写进 notDone）；
 * - 不处理输入框聚焦/拖拽中这些上下文——那是宿主的事（`App.tsx` 的两处 keydown 里判）。
 *
 * `keys` 是给人看的写法（`Space`、`⌘Z` 这类）；`match` 是实际判定的键（`event.key`）。
 */

import { createElement } from 'react';

/**
 * @typedef {object} Shortcut
 * @property {string} id 分发用的稳定 id
 * @property {string[]} keys 展示用（多写法并列）
 * @property {string} match `event.key` 的匹配值（小写化后比较；空串 = 特殊，不参与匹配）
 * @property {string} label 一句话说明
 * @property {'playback'|'edit'|'view'} group
 */

/** @type {readonly Shortcut[]} */
export const SHORTCUTS = Object.freeze([
  { id: 'play', keys: ['Space'], match: ' ', label: '播放 / 暂停', group: 'playback' },
  { id: 'pause', keys: ['K'], match: 'k', label: '暂停', group: 'playback' },
  { id: 'playForward', keys: ['L'], match: 'l', label: '正向播放', group: 'playback' },
  { id: 'stepBack', keys: ['J', '←'], match: 'j', label: '后退一帧（J / 逗号）', group: 'playback' },
  { id: 'stepForward', keys: ['→'], match: '.', label: '前进一帧（句号）', group: 'playback' },
  { id: 'home', keys: ['Home'], match: 'home', label: '跳到开头', group: 'playback' },
  { id: 'end', keys: ['End'], match: 'end', label: '跳到结尾', group: 'playback' },
  { id: 'split', keys: ['S'], match: 's', label: '在播放头切分选中片段', group: 'edit' },
  { id: 'delete', keys: ['Delete', 'Backspace'], match: 'delete', label: '删除选中片段（选中转场时删转场）', group: 'edit' },
  { id: 'escape', keys: ['Esc'], match: 'escape', label: '退出当前选择 / 关闭面板', group: 'view' },
  { id: 'undo', keys: ['⌘Z'], match: '', label: '撤销（用工具栏按钮；浏览器保留系统键）', group: 'edit' },
  { id: 'redo', keys: ['⇧⌘Z'], match: '', label: '重做（用工具栏按钮；浏览器保留系统键）', group: 'edit' },
]);

/** 分区标题（面板里分组显示）。 */
export const SHORTCUT_GROUPS = Object.freeze([
  { id: 'playback', label: '播放' },
  { id: 'edit', label: '编辑' },
  { id: 'view', label: '视图' },
]);

/**
 * 把一个 KeyboardEvent 映射成快捷键 id。
 *
 * 只认 `match` 非空的条目；`Delete`/`Backspace` 都归 `delete`，`Esc` 归 `escape`，
 * 逗号归 `stepBack`（表里 stepBack 的 match 是 `j`，逗号在下面单独补——同一动作的两种按键）。
 * @param {KeyboardEvent} event
 * @returns {string|null}
 */
export function matchShortcut(event) {
  const key = String(event.key ?? '').toLowerCase();
  if (key === 'delete' || key === 'backspace') return 'delete';
  if (key === 'escape') return 'escape';
  if (key === ',') return 'stepBack';
  const found = SHORTCUTS.find((item) => item.match !== '' && item.match === key);
  return found === undefined ? null : found.id;
}
