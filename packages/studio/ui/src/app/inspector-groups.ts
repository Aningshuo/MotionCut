/**
 * 检查器分组（S78 · B-SUB1-R31-040）——**只做逻辑层，不接线**。
 *
 * 背景：合同 v1 只有四个组 id（`text / geometry / typography / appearance`），而「裁剪」(`clipPath`)
 * 与「变换」(`rotation` / `scale`) 只是字段级存在。面板按组渲染时这两类会直接丢，用户在检查器里
 * 找不到它们，只能让 Agent 改源。
 *
 * 这里把「组」从渲染里拆出来，落成纯函数：
 * - `INSPECTOR_GROUPS`：组定义（id / 中文名 / 字段 / 适用元素类型）；
 * - `groupFieldsFor(kind)`：某类元素该显示哪些组（固定顺序）；
 * - `partitionFields(kind, fields)`：把一份字段集合分成「已知组 / 未归属」，**未归属必须显式返回**。
 *
 * 与 `packages/film-core/ops.mjs` 的关系：那边是**写盘白名单**（`fieldsAllowedFor`），这边是
 * **面板分组**。两份清单必须能对上——被白名单允许的字段，在这里必须归得到某个组，
 * 否则就是「白名单能写、面板看不见」，S78 的交叉校验（单测 + 验收脚本）专门盯这条。
 *
 * 注意：`fields` 里允许出现白名单之外的字段（`text` / `content` / `clipPath` / `rotation` / `scale`）。
 * 那是面板要展示、但合同 v1 还不接受写入的东西，属于「看得见、暂不可写」，不是漏项。
 */

/** 元素类型：与 film-core 的 kind 一一对应（未知值按 video 处理，和 `fieldsAllowedFor` 的兜底一致）。 */
export type InspectorKind = 'video' | 'still' | 'page' | 'sound' | 'subtitle';

/** 组 id：前四个来自合同 v1，其余是面板需要的补充。 */
export type InspectorGroupId =
  | 'text'
  | 'geometry'
  | 'transform'
  | 'clip'
  | 'typography'
  | 'appearance'
  | 'audio'
  | 'timing'
  | 'source';

export interface InspectorGroup {
  readonly id: InspectorGroupId;
  readonly label: string;
  readonly fields: readonly string[];
  readonly kinds: readonly InspectorKind[];
}

export interface InspectorFieldGroup {
  readonly id: InspectorGroupId;
  readonly label: string;
  readonly fields: string[];
}

/** 未归属的原因：`unknown` = 谁都不认识；`not-for-kind` = 认识，但这类元素没有这个组。 */
export type UngroupedReason = 'unknown' | 'not-for-kind';

export interface UngroupedField {
  readonly field: string;
  readonly reason: UngroupedReason;
}

export interface FieldPartition {
  readonly groups: InspectorFieldGroup[];
  readonly ungrouped: UngroupedField[];
}

const VISUAL: readonly InspectorKind[] = ['video', 'still', 'page'];
const ALL_KINDS: readonly InspectorKind[] = ['video', 'still', 'page', 'sound', 'subtitle'];

/**
 * 组定义。**顺序即渲染顺序**（`groupFieldsFor` 直接按这个顺序过滤），
 * 所以调顺序等于改面板，单测里用快照钉住了。
 */
export const INSPECTOR_GROUPS: readonly InspectorGroup[] = Object.freeze([
  {
    id: 'text',
    label: '文本',
    // 字幕内容只读展示：合同 v1 的 `fields` 白名单不接受 text/content，
    // 所以它们不会出现在交叉校验的 allowed 里，这里保留是为了面板有地方显示。
    fields: ['text', 'content'],
    kinds: ['subtitle'],
  },
  {
    id: 'geometry',
    label: '几何',
    fields: ['box', 'size', 'x', 'y', 'w', 'h'],
    kinds: VISUAL,
  },
  {
    id: 'transform',
    label: '变换',
    // `r` 是 film-core 里几何组接受的旋转；rotation/scale 是合同 v1 的字段级预留，面板先认。
    fields: ['r', 'rotation', 'scale'],
    kinds: VISUAL,
  },
  {
    id: 'clip',
    label: '裁剪',
    fields: ['clipPath'],
    kinds: VISUAL,
  },
  {
    id: 'typography',
    label: '排印',
    // 字号 / 字重 / 行高都住在 `style` 里（合同 v1 用整对象写），`overrides` 是逐元素的排印覆盖。
    fields: ['style', 'overrides', 'fontSize', 'fontWeight', 'lineHeight'],
    kinds: ['video', 'still', 'page', 'subtitle'],
  },
  {
    id: 'appearance',
    label: '外观',
    fields: ['attrs', 'fade', 'link', 'color', 'opacity'],
    kinds: ALL_KINDS,
  },
  {
    id: 'audio',
    label: '音频',
    fields: ['volume', 'muted'],
    kinds: ['video', 'still', 'page', 'sound'],
  },
  {
    id: 'timing',
    label: '时间',
    fields: ['at', 'time', 'speed'],
    kinds: ALL_KINDS,
  },
  {
    id: 'source',
    label: '来源',
    // 面板要能显示/重链文件来源；`kind`/`sound` 决定元素类型，写错会改语义，UI 只读展示。
    fields: ['src', 'kind', 'sound'],
    kinds: ALL_KINDS,
  },
]);

/** 字段 → 组。重复字段在模块加载时直接抛：宁可启动就红，也不要面板里出现两份。 */
const GROUP_BY_FIELD: ReadonlyMap<string, InspectorGroup> = (() => {
  const map = new Map<string, InspectorGroup>();
  for (const group of INSPECTOR_GROUPS) {
    for (const field of group.fields) {
      const existing = map.get(field);
      if (existing !== undefined) {
        throw new Error(`检查器分组重复：字段 "${field}" 同时出现在 "${existing.id}" 与 "${group.id}"`);
      }
      map.set(field, group);
    }
  }
  return map;
})();

function normalizeKind(kind: string): InspectorKind {
  const known: readonly string[] = ALL_KINDS;
  /* 与 film-core 的 `fieldsAllowedFor` 同一个兜底：未知 kind 当 video。 */
  return known.includes(kind) ? (kind as InspectorKind) : 'video';
}

/** 某类元素该显示的组（按 `INSPECTOR_GROUPS` 的固定顺序）。 */
export function groupFieldsFor(kind: string): InspectorGroup[] {
  const normalized = normalizeKind(kind);
  return INSPECTOR_GROUPS.filter((group) => group.kinds.includes(normalized));
}

/** 字段属于哪个组；谁都不认识时返回 `null`（调用方必须自己决定怎么显示）。 */
export function fieldGroupId(field: string): InspectorGroupId | null {
  return GROUP_BY_FIELD.get(field)?.id ?? null;
}

/**
 * 选中的那一层在 `overrides` 里是不是 `lock: true`（S87）。
 *
 * 面板据此**整体只读**：锁的意义就是「别再改它」，只在提交时等服务端 400 已经太晚了——
 * 用户会以为改动生效了。服务端那一半（`ELEMENT_LOCKED`）仍然必须在，这里是同一件事的前端半边。
 *
 * @param clip 片段（`overrides` 数组里每条都是 `{at, ...}`）
 * @param at 当前选中的图层选择器（空串 = 没选层）
 */
export function elementLocked(clip: { overrides?: unknown } | null, at: string): boolean {
  if (at === '' || clip === null || !Array.isArray(clip.overrides)) return false;
  for (const entry of clip.overrides) {
    if (entry === null || typeof entry !== 'object') continue;
    const item = entry as { at?: unknown; lock?: unknown };
    if (item.at === at && item.lock === true) return true;
  }
  return false;
}

/**
 * 把字段集合分到「已知组 / 未归属」。
 *
 * 三条约定：
 * 1. 组按 `groupFieldsFor(kind)` 的顺序出现，组内保持**输入顺序**；
 * 2. 没有字段的组不返回（面板不该画空壳）；
 * 3. 未归属一定显式返回，带原因——`unknown`（谁都不认识）或 `not-for-kind`（这类元素没这个组）。
 *    静默丢字段是这里最不能犯的错。
 */
export function partitionFields(kind: string, fields: Iterable<string>): FieldPartition {
  const groups = groupFieldsFor(kind);
  const buckets = new Map<InspectorGroupId, string[]>();
  for (const group of groups) buckets.set(group.id, []);
  const ungrouped: UngroupedField[] = [];

  for (const field of fields) {
    const group = GROUP_BY_FIELD.get(field);
    if (group === undefined) {
      ungrouped.push({ field, reason: 'unknown' });
      continue;
    }
    const bucket = buckets.get(group.id);
    if (bucket === undefined) {
      ungrouped.push({ field, reason: 'not-for-kind' });
      continue;
    }
    bucket.push(field);
  }

  return {
    groups: groups
      .map((group) => ({ id: group.id, label: group.label, fields: buckets.get(group.id) ?? [] }))
      .filter((group) => group.fields.length > 0),
    ungrouped,
  };
}
