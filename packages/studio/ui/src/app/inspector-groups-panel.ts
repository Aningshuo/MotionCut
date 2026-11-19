/**
 * 检查器分组面板（S80 · B-SUB1-R31-041）—— 把 S78 的 9 个组真正接到界面上。
 *
 * 三条设计约束（来自批次任务书）：
 * 1. **按 `groupFieldsFor(kind)` 的固定顺序**渲染；组内字段顺序也由 `inspector-groups.ts` 决定。
 * 2. 能写的字段必须走 `/ops`，且只能写 `fieldsAllowedFor(kind)` 白名单里的键；
 *    「裁剪 / 变换」是通过**白名单里的 `overrides`** 写进片段（`clip-path` / `r` / `s` 是覆盖条目的键），
 *    不是绕过白名单直接写 `clipPath`。
 * 3. 合同 v1 不接受写入的字段**显式标「看得见、暂不可写」**（带 title 说明原因），不许静默禁用、不许不渲染。
 *    未归属字段同理：在面板里单列一块并 `console.warn`，不静默丢。
 */

import { createElement, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { fieldsAllowedFor } from '../../../../film-core/ops.mjs';
import { elementLocked, groupFieldsFor, partitionFields } from './inspector-groups';
import type { Clip } from './types';

const h = createElement;

/** 覆盖条目：`overrides` 数组里 `at` 命中的那一条。 */
interface OverrideEntryLike {
  at?: string;
  t?: unknown;
  style?: Record<string, unknown>;
  lock?: unknown;
  s?: unknown;
  r?: unknown;
  [key: string]: unknown;
}

/**
 * R102 / U04（U 批）：**密度与单位**。
 *
 * 三条都不是新能力，是把已有字段「排得更紧、说得更清」：
 * 1. `PAIRS`：X/Y 与 W/H 同一行两格（几何组从 4 行变 2 行，读数在交接 `densityBeforeAfter`）；
 * 2. `UNIT_OF`：数值字段给出单位后缀（`px` / `°` / `×`）—— **只影响显示**，提交的仍是裸数字；
 * 3. `SHORT_WHY`：只读项的**短理由**与徽标同一行（完整句子仍在该行 `title` 与 `data-why` 里）。
 *    不再为「为什么只读」多开一行；徽标原文「看得见、暂不可写」照旧保留。
 */
const PAIRS: ReadonlyArray<readonly [string, string]> = [['x', 'y'], ['w', 'h']];
const UNIT_OF: Record<string, string> = { x: 'px', y: 'px', w: 'px', h: 'px', r: '°', rotation: '°', scale: '×' };
/** 只读理由的**短标签**（完整句子仍在该行 `title` 与 `data-why` 里）。 */
const SHORT_WHY = {
  contract: '合同 v1 不收',
  layer: '在图层区改',
  structured: '结构化',
  canvas: '画布设置',
  pick: '需选中图层',
  locked: '已锁定',
  none: '只读',
} as const;

/** 单位后缀（`noUncheckedIndexedAccess` 下用函数收窄，别把 `string | undefined` 传进节点）。 */
function unitOf(field: string): string | null {
  return UNIT_OF[field] ?? null;
}

/** 只读理由 → 短标签。顺序即优先级。 */
function shortWhyOf(reason: string, locked: boolean): string {
  if (locked) return SHORT_WHY.locked;
  if (reason.includes('合同 v1')) return SHORT_WHY.contract;
  if (reason.includes('先选中')) return SHORT_WHY.pick;
  if (reason.includes('画布')) return SHORT_WHY.canvas;
  if (reason.includes('结构化') || reason.includes('对象')) return SHORT_WHY.structured;
  if (reason.includes('图层')) return SHORT_WHY.layer;
  return SHORT_WHY.none;
}

/** 本面板的局部样式（只挂在 `.ig` 下的类）。`styles.css` 归 MAIN，这里只写自己的类。 */
const LOCAL_CSS_ID = 'u04-inspector-density';
const LOCAL_CSS = `
.ig { container: clip-fields / inline-size; min-width: 0; }
.ig .ig-row { grid-template-columns: minmax(48px, 24%) minmax(0, 1fr); min-width: 0; min-height: 26px; padding: 0; }
.ig .ig-pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 6px; }
.ig .ig-pair > .ig-row { grid-template-columns: max-content minmax(0, 1fr); column-gap: 4px; }
.ig .ig-input { font-family: inherit; font-variant-numeric: tabular-nums; }
@container clip-fields (max-width: 179px) {
  .ig .ig-pair { grid-template-columns: minmax(0, 1fr); }
}
.ig .ig-ctl { display: flex; align-items: center; gap: 4px; min-width: 0; }
.ig .ig-ctl > .ig-input { flex: 1 1 auto; min-width: 0; }
.ig .ig-ctl > .ig-value { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ig .ig-unit { flex: 0 0 auto; color: var(--text-mute); font-size: var(--fs-sm); line-height: 1; }
.ig .ig-readonly { grid-column: 1 / -1; display: flex; align-items: center; gap: 6px; min-width: 0; }
.ig .ig-why { flex: 0 1 auto; color: var(--text-mute); font-size: var(--fs-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ig .ig-error { grid-column: 1 / -1; color: #ff9a9a; font-size: var(--fs-sm); line-height: 1.3; }
`;

function ensureLocalCss(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(LOCAL_CSS_ID) !== null) return;
  const node = document.createElement('style');
  node.id = LOCAL_CSS_ID;
  node.textContent = LOCAL_CSS;
  document.head.appendChild(node);
}

const LAYER_FIELDS = new Set(['clipPath', 'rotation', 'scale']);

/** 默认展开的组：本批真正要改的三组（几何 / 变换 / 裁剪）；其余折叠，顺序仍在。 */
const OPEN_BY_DEFAULT = new Set(['geometry', 'transform', 'clip']);
/** R102 / U04：用户手动开合过的组（跨重渲染保留；不写盘、不进 UI 状态树）。 */
const OPEN_STATE = new Map<string, boolean>();

/** 结构化 / 由别处编辑的字段：给一句「在哪改」，而不是空白。 */
const READONLY_REASON: Record<string, string> = {
  text: '合同 v1 不接受写入：fieldsAllowedFor 里没有 text',
  content: '合同 v1 不接受写入：fieldsAllowedFor 里没有 content',
  style: '结构化原始值：改上面的字号/颜色/描边等字段就会同步它，不用直接编 CSS',
  overrides: '结构化原始值：裁剪/旋转/文本样式写的就是它，逐条在下面各组里改',
  attrs: '结构化原始值：网页片段的属性表，在「图层」区逐条改',
  fade: '在「音频」区改淡入淡出（那里有滑杆与撤销）',
  /* B02（R108 / A24 口径）：这两格是**结构化原始值**，只读是设计，不是没做完——
     把「为什么」和「改哪里」都写成一句人话，别让人猜。 */
  box: '结构化原始值：改几何组的 X / Y / 宽 / 高 会自动同步它，不用直接编 JSON',
  size: '网页片段的渲染尺寸（size="宽x高"）：换它等于换画布，页内所有坐标的基准都会变；本批不开写入口（B04 统一提交内核后再定）',
  kind: '由 src 后缀与容器标签决定，不单独写',
  sound: '由 src 是否有音轨决定，不单独写',
  fontSize: '图层样式字段：在「图层」区改',
  fontWeight: '图层样式字段：在「图层」区改',
  lineHeight: '图层样式字段：在「图层」区改',
  color: '图层样式字段：在「图层」区改',
  opacity: '图层样式字段：在「图层」区改',
};

/**
 * 「改哪里」（B02 / R108 的只读原因矩阵要的第三列）。
 * 与 `READONLY_REASON` 同键：原因说「为什么」，这里说「去哪改」。只读项才有。
 */
const READONLY_WHERE: Record<string, string> = {
  text: '暂无入口（合同 v1 不收 text）',
  content: '暂无入口（合同 v1 不收 content）',
  style: '本页签「排印」「外观」各组',
  overrides: '本页签「裁剪」「变换」各组',
  attrs: '「图层」区',
  fade: '「音频」区',
  box: '本页签「几何」组 X / Y / 宽 / 高',
  size: '暂无入口（待 B04 统一提交内核）',
  kind: '—（由 src 后缀决定）',
  sound: '—（由 src 是否带音轨决定）',
  fontSize: '「图层」区',
  fontWeight: '「图层」区',
  lineHeight: '「图层」区',
  color: '「图层」区',
  opacity: '「图层」区',
};

const LABELS: Record<string, string> = {
  text: '文本',
  content: '内容',
  box: '位置与尺寸',
  size: '画幅',
  x: 'X',
  y: 'Y',
  w: '宽',
  h: '高',
  r: '旋转',
  rotation: '旋转（图层）',
  scale: '缩放（图层）',
  clipPath: '裁切',
  style: '样式',
  overrides: '覆盖样式',
  fontSize: '字号',
  fontWeight: '字重',
  lineHeight: '行高',
  attrs: '属性',
  fade: '淡入淡出',
  link: '链接',
  color: '颜色',
  opacity: '不透明度',
  volume: '音量',
  muted: '静音',
  at: '开始位置',
  time: '时间范围',
  speed: '倍速',
  src: '素材来源',
  kind: '类型',
  sound: '含音轨',
};

type Control = 'number' | 'text' | 'checkbox' | 'readonly';

interface Row {
  field: string;
  label: string;
  control: Control;
  value: string | number | boolean;
  writable: boolean;
  reason: string;
  unit?: string;
}

function entryOf(clip: Clip, at: string): OverrideEntryLike | null {
  if (at === '') return null;
  const list = Array.isArray(clip.overrides) ? clip.overrides : [];
  const found = list.find((entry) => entry !== null && typeof entry === 'object' && (entry as OverrideEntryLike).at === at);
  return found === undefined ? null : (found as OverrideEntryLike);
}

function styleStringOf(entry: OverrideEntryLike | null): string {
  if (entry === null || entry.style === null || typeof entry.style !== 'object') return '';
  const value = (entry.style as Record<string, unknown>)['clip-path'];
  return typeof value === 'string' ? value : '';
}

/** x/y/w/h/r 都住在 `box` 里；缺省按 0 展示。 */
function boxNumber(clip: Clip, key: 'x' | 'y' | 'w' | 'h' | 'r'): number {
  const box = clip.box ?? {};
  const value = (box as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * 给一个字段算出「怎么显示、能不能写」。
 * 返回 null = 这个字段对当前片段没有意义（不渲染空行）。
 */
function rowFor(field: string, clip: Clip, kind: string, allowed: readonly string[], layerAt: string): Row | null {
  const label = LABELS[field] ?? field;
  const canWriteClip = allowed.includes(field);

  if (LAYER_FIELDS.has(field)) {
    const entry = entryOf(clip, layerAt);
    const hasLayer = layerAt !== '';
    const writable = hasLayer && kind === 'page';
    const value =
      field === 'clipPath' ? styleStringOf(entry) : field === 'rotation' ? Number(entry?.r ?? 0) : Number(entry?.s ?? 1);
    return {
      field,
      label,
      control: writable ? (field === 'clipPath' ? 'text' : 'number') : 'readonly',
      value,
      writable,
      reason: writable
        ? `${field === 'clipPath' ? '写 overrides.style["clip-path"]' : field === 'rotation' ? '写 overrides.r（度）' : '写 overrides.s'}，走白名单字段 overrides`
        : kind === 'page'
          ? '先选中一个场景图层：这是图层级字段'
          : '只有网页（场景）片段有图层，视频/音频没有',
    };
  }

  if (['x', 'y', 'w', 'h', 'r'].includes(field)) {
    return { field, label, control: canWriteClip ? 'number' : 'readonly', value: boxNumber(clip, field as 'x'), writable: canWriteClip, reason: canWriteClip ? '写这个片段自己的 box（left/top/width/height），走 /ops，一步撤销' : '合同 v1 不接受写入' };
  }

  if (field === 'at' || field === 'speed') {
    return { field, label, control: canWriteClip ? 'number' : 'readonly', value: Number(clip[field] ?? (field === 'speed' ? 1 : 0)), writable: canWriteClip, reason: canWriteClip ? '走 /ops fields' : '合同 v1 不接受写入' };
  }
  if (field === 'volume') {
    return { field, label, control: canWriteClip ? 'number' : 'readonly', value: typeof clip.volume === 'number' ? clip.volume : 1, writable: canWriteClip, reason: canWriteClip ? '走 /ops fields（0–1）' : '合同 v1 不接受写入', unit: '' };
  }
  if (field === 'muted') {
    return { field, label, control: canWriteClip ? 'checkbox' : 'readonly', value: clip.muted === true, writable: canWriteClip, reason: canWriteClip ? '走 /ops fields' : '合同 v1 不接受写入' };
  }
  if (field === 'src' || field === 'link') {
    return { field, label, control: canWriteClip ? 'text' : 'readonly', value: String(clip[field] ?? ''), writable: canWriteClip, reason: canWriteClip ? '走 /ops fields' : '合同 v1 不接受写入' };
  }

  const reason = READONLY_REASON[field] ?? '只读展示';
  const raw = (clip as unknown as Record<string, unknown>)[field];
  const display =
    field === 'overrides'
      ? `${Array.isArray(raw) ? raw.length : 0} 条`
      : raw === undefined || raw === null
        ? '—'
        : typeof raw === 'object'
          ? JSON.stringify(raw)
          : String(raw);
  return { field, label, control: 'readonly', value: display, writable: false, reason };
}

/** 一个可写字段：本地草稿 + Enter/失焦提交；提交后由 doc 刷新回填。 */
function EditableRow(props: { row: Row; busy: boolean; onCommit: (field: string, value: unknown) => void }): ReactNode {
  const { row } = props;
  const [draft, setDraft] = useState(String(row.value ?? ''));
  const [focused, setFocused] = useState(false);
  /* R102 / U04：**错误就地显示**。以前非数字直接 `return`（静默丢掉一次编辑，用户以为改了）；
     现在停在原地并在行内说明原因，值仍留在输入框里可改。 */
  const [error, setError] = useState('');
  /* Enter 提交后焦点还在输入框里，失焦会再提交一次 → 第二次带着旧 hash 撞 409。
     用 ref 记住「这次已经发过的值」，同一个值不再发第二遍。 */
  const sentRef = useRef('');
  useEffect(() => {
    if (!focused) setDraft(String(row.value ?? ''));
  }, [row.value, focused]);

  const commit = (): void => {
    if (draft === sentRef.current || draft === String(row.value ?? '')) return;
    if (row.control === 'number') {
      const value = Number(draft);
      if (draft.trim() === '' || !Number.isFinite(value)) {
        setError(`不是数字：${JSON.stringify(draft)}`);
        return;
      }
      setError('');
      sentRef.current = draft;
      try {
        props.onCommit(row.field, value);
      } catch (failure) {
        setError(`提交失败：${String((failure as { message?: string })?.message ?? failure)}`);
      }
      return;
    }
    setError('');
    sentRef.current = draft;
    try {
      props.onCommit(row.field, draft);
    } catch (failure) {
      setError(`提交失败：${String((failure as { message?: string })?.message ?? failure)}`);
    }
  };

  if (row.control === 'checkbox') {
    return h('input', {
      type: 'checkbox',
      className: 'ig-check',
      'data-testid': `inspector-clip-input-${row.field}`,
      checked: row.value === true,
      disabled: props.busy,
      onChange: (event: { currentTarget: HTMLInputElement }) => props.onCommit(row.field, event.currentTarget.checked),
    });
  }

  return h(
    'span',
    { className: 'ig-ctl' },
    h('input', {
      className: 'ig-input',
      'data-testid': `inspector-clip-input-${row.field}`,
      /* R102 / U04：类型化控件 —— 数值框给 `inputmode=decimal`（移动端弹数字键盘）与
         `data-control=number`（量具/脚本读得到它是数值框）。**不改 type**：
         `type=number` 会在值不合法时把 `value` 读成空串，提交链会静默丢值。 */
      inputMode: row.control === 'number' ? 'decimal' : undefined,
      'data-control': row.control,
      value: draft,
      /* R5 / S1G：值比框宽时出省略号（`.ig-input` 的 text-overflow），完整值给 title。 */
      title: draft,
      disabled: props.busy,
      spellcheck: false,
      onChange: (event: { currentTarget: HTMLInputElement }) => setDraft(event.currentTarget.value),
      onFocus: () => setFocused(true),
      onBlur: () => {
        setFocused(false);
        commit();
      },
      onKeyDown: (event: { key: string }) => {
        if (event.key === 'Enter') commit();
      },
    }),
    unitOf(row.field) === null ? null : h('span', { className: 'ig-unit', 'data-unit': unitOf(row.field) ?? undefined }, unitOf(row.field)),
    error === '' ? null : h('span', { className: 'ig-error', 'data-testid': `inspector-clip-error-${row.field}`, role: 'status' }, error),
  );
}

export interface GroupedInspectorProps {
  clip: Clip;
  kind: string;
  layerAt: string;
  busy: boolean;
  onCommit: (field: string, value: unknown) => void;
}

/**
 * 面板主体：按 `groupFieldsFor(kind)` 渲染组，组内按 `INSPECTOR_GROUPS` 的字段顺序。
 * 未归属字段单独一块（带 console 警告）——这是 S78 单测在守的语义，接线后不能退化。
 */
export function GroupedInspector(props: GroupedInspectorProps): ReactNode {
  const { clip, kind, layerAt } = props;
  const allowed = fieldsAllowedFor(kind);
  const groups = groupFieldsFor(kind);
  /* S87：这一层被 `lock: true` 锁住 → 整个面板只读（服务端还会用 ELEMENT_LOCKED 兜底）。 */
  const locked = elementLocked(clip as unknown as { overrides?: unknown }, layerAt);
  const lockReason = '元素已锁定（只读）：先在图层里解锁再改';

  /* 未归属：片段自身的键里，除了 `id`（身份）之外没人认领的那些。 */
  const keys = Object.keys(clip as unknown as Record<string, unknown>).filter((key) => key !== 'id');
  const partition = partitionFields(kind, keys);
  const ungroupedKey = partition.ungrouped.map((item) => item.field).join(',');

  useEffect(() => {
    if (partition.ungrouped.length > 0) {
      // eslint-disable-next-line no-console
      console.warn('[inspector] 未归属字段（不渲染、不写盘）', partition.ungrouped);
    }
  }, [ungroupedKey]);

  /* R102 / U04：局部样式只挂一次（`styles.css` 归 MAIN，本面板的新类自己带）。 */
  ensureLocalCss();

  /** 一条字段行。只读行的「为什么只读」不再只躺在 title 里：
      徽标保留原文「看得见、暂不可写」（BATCH-SUB1-R31-061 §2 的硬要求），
      后面跟一个短理由（完整句子在 `title` 与 `data-why`）。 */
  const rowNode = (row: Row, inPair = false): ReactNode =>
    h(
      'div',
      {
        className: `ig-row${row.writable ? '' : ' ro'}`,
        'data-clip-field': row.field,
        'data-writable': row.writable ? 'true' : 'false',
        'data-why': row.reason,
        /* B02 / 只读原因矩阵：第四列「改哪里」直接落在 DOM 上（验收与文档同一份真相）。 */
        'data-where': row.writable ? '本页签直接改（/ops fields）' : (READONLY_WHERE[row.field] ?? '—'),
        'data-locked': locked ? 'true' : 'false',
        'data-testid': `inspector-clip-field-${row.field}`,
        title: row.reason,
        key: row.field,
      },
      /* 成对那一行标签列只有 22px：中文「宽 w / 高 h」会被截成「宽…」——
         所以配对行改用设计工具的叫法（X / Y / W / H），完整名字在 title 里。 */
      h('span', { className: 'ig-label', title: row.label }, inPair ? row.field.toUpperCase() : row.label),
      row.writable
        ? h(EditableRow, { row, busy: props.busy, onCommit: props.onCommit })
        : h(
            'span',
            { className: 'ig-ctl' },
            h('span', { className: 'ig-value', title: String(row.value) }, String(row.value)),
            unitOf(row.field) === null ? null : h('span', { className: 'ig-unit', 'data-unit': unitOf(row.field) ?? undefined }, unitOf(row.field)),
          ),
      row.writable
        ? null
        : h(
            'span',
            { className: 'ig-readonly' },
            h(
              'span',
              {
                className: 'ig-lock',
                'data-testid': `inspector-clip-lock-${row.field}`,
                'data-locked': locked ? 'true' : 'false',
                title: row.reason,
              },
              locked ? '已锁定（只读）' : '看得见、暂不可写',
            ),
            h('span', { className: 'ig-why', 'data-short': shortWhyOf(row.reason, locked) }, shortWhyOf(row.reason, locked)),
          ),
    );

  /** 组内行 → 节点：X/Y 与 W/H 成对时并到同一行的两格（`PAIRS`）。 */
  const groupNodes = (rows: Row[]): ReactNode[] => {
    const nodes: ReactNode[] = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (row === undefined) continue;
      const pair = PAIRS.find(([first, second]) => row.field === first && rows[index + 1]?.field === second);
      if (pair === undefined) {
        nodes.push(rowNode(row));
        continue;
      }
      const mate = rows[index + 1] as Row;
      nodes.push(
        h('div', { className: 'ig-pair', 'data-pair': `${pair[0]},${pair[1]}`, key: `${pair[0]}-${pair[1]}` }, rowNode(row, true), rowNode(mate, true)),
      );
      index += 1;
    }
    return nodes;
  };

  return h(
    'div',
    { className: 'ig', 'data-testid': 'inspector', 'data-kind': kind, 'data-clip-groups': String(groups.length), 'data-element-locked': locked ? 'true' : 'false' },
    h('div', { className: 'ig-caption' }, `片段字段 · ${String(groups.length)} 组`),
    locked
      ? h(
          'p',
          { className: 'ig-locked-banner', 'data-testid': 'inspector-element-locked', role: 'status' },
          `图层 ${layerAt} 已锁定：这一屏只读，解锁后才能改（服务端会拒 ELEMENT_LOCKED）`,
        )
      : null,
    ...groups.map((group) => {
      const rows = group.fields
        .map((field) => rowFor(field, clip, kind, allowed, layerAt))
        .filter((row): row is Row => row !== null)
        /* 锁定层：能写的也降成只读，理由与「看得见、暂不可写」不同，分开写。 */
        .map((row) => (locked && row.writable ? { ...row, writable: false, reason: lockReason } : row));
      if (rows.length === 0) return null;
      return h(
        'details',
        {
          className: 'ig-group',
          'data-clip-group': group.id,
          'data-testid': `inspector-clip-group-${group.id}`,
          /* R102 / U04：折叠状态**跨重渲染保留**（doc 一改就重渲染，以前会弹回默认三组）。 */
          open: OPEN_STATE.get(group.id) ?? OPEN_BY_DEFAULT.has(group.id),
          onToggle: (event: { currentTarget: HTMLDetailsElement }) => {
            OPEN_STATE.set(group.id, event.currentTarget.open);
          },
          key: group.id,
        },
        h('summary', { className: 'ig-head', title: `${String(rows.length)} 项属性` }, h('span', { className: 'ig-title' }, group.label), h('span', { className: 'ig-count', 'aria-hidden': 'true' }, String(rows.length))),
        ...groupNodes(rows),
      );
    }),
    partition.ungrouped.length === 0
      ? null
      : h(
          'section',
          { className: 'ig-warn', 'data-testid': 'inspector-clip-ungrouped', 'data-count': String(partition.ungrouped.length) },
          h('strong', null, `有 ${String(partition.ungrouped.length)} 个字段没有归组`),
          h(
            'ul',
            null,
            ...partition.ungrouped.map((item) =>
              h('li', { key: item.field, 'data-field': item.field }, `${item.field} · ${item.reason === 'unknown' ? '谁都不认识' : '这类元素没有这个组'}（不渲染、不写盘）`),
            ),
          ),
        ),
  );
}

/**
 * 面板 → Op 的唯一出口（纯函数，便于单测/验收脚本复用）。
 *
 * - 图层级字段（clipPath / rotation / scale）写的是**白名单里的 `overrides`**：
 *   构造/更新 `at === layerAt` 的那条覆盖，`clip-path` 落在 `style`，旋转/缩放落在 `r` / `s`。
 * - 其余字段写 `fields: { [field]: value }`；`x/y/w/h/r` 合并进 `box` 对象。
 * - 不检查白名单（服务端会查）；这里只负责**不构造越权形状**。
 */
export function buildFieldOp(
  clip: Clip,
  field: string,
  value: unknown,
  layerAt: string,
): { ops: Array<Record<string, unknown>>; error?: string } {
  if (field === 'clipPath' || field === 'rotation' || field === 'scale') {
    if (layerAt === '') return { ops: [], error: '先选中一个场景图层' };
    const list = Array.isArray(clip.overrides) ? clip.overrides.map((entry) => ({ ...(entry as OverrideEntryLike) })) : [];
    const index = list.findIndex((entry) => entry.at === layerAt);
    const entry: OverrideEntryLike = index >= 0 ? (list[index] as OverrideEntryLike) : { at: layerAt };
    if (field === 'clipPath') {
      const style = entry.style !== null && typeof entry.style === 'object' ? { ...entry.style } : {};
      const text = String(value ?? '').trim();
      if (text === '') delete style['clip-path'];
      else style['clip-path'] = text;
      entry.style = style;
    } else if (field === 'rotation') {
      entry.r = Number(value);
    } else {
      entry.s = Number(value);
    }
    if (index >= 0) list[index] = entry;
    else list.push(entry);
    return { ops: [{ op: 'fields', clip: clip.id, fields: { overrides: list } }] };
  }

  if (['x', 'y', 'w', 'h', 'r'].includes(field)) {
    const box = { ...(clip.box ?? {}) } as Record<string, unknown>;
    box[field] = Number(value);
    return { ops: [{ op: 'fields', clip: clip.id, fields: { box } }] };
  }

  return { ops: [{ op: 'fields', clip: clip.id, fields: { [field]: value } }] };
}

export const INSPECTOR_LAYER_FIELDS: readonly string[] = Object.freeze([...LAYER_FIELDS]);
