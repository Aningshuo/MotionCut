/**
 * 检查器字段核心 · 类型与门面（副线1 · WP14 / S10）
 *
 * 运行时实现在 `inspector-fields.mjs`（唯一实现，浏览器可直接加载给面板用）；
 * 本文件只做两件事：定义对外接口类型、按接口签名把实现再导出一遍。
 * 之所以拆开：`.mjs` 里的 `import './inspector.ts'` 浏览器跑不了——字段核心不能有两套。
 *
 * 硬规矩（合同 layers.ts）：
 * - 覆盖优先，没有覆盖才显示 computed；`source` 必须如实标注。
 * - 提交时只写用户真正改的字段（最小 patch），**不把整帧 computed 样式烘进 override**。
 * - 锁定的层 editable=false；提交由 edit-session 拒绝并报 LOCKED。
 */
import type { LayerBox, LayerRef, OverridePatch } from '../../contracts/layers';
import {
  buildInspector as buildInspectorRuntime,
  buildMultiInspector as buildMultiInspectorRuntime,
  patchForField as patchForFieldRuntime
} from './inspector-fields.mjs';

export { mergeOverride, overrideKeys, patchKeys, sameKeyValue } from './override-merge.mjs';

export type FieldUnit = 'px' | 'em' | 'deg' | '%' | '秒' | '色值' | '无';

export type FieldGroupId = 'text' | 'geometry' | 'typography' | 'appearance';

export interface InspectorField {
  readonly id: string;
  readonly label: string;
  readonly group: FieldGroupId;
  /** 当前生效值：有覆盖用覆盖，否则用运行时 computed。 */
  readonly current: string | number;
  readonly source: 'override' | 'computed';
  readonly editable: boolean;
  readonly unit: FieldUnit;
  /** 该字段对应的 override 键（style 键或 t/s/r），便于最小 patch。 */
  readonly overrideKey: string;
  /** 锁定原因（editable=false 时给出）。 */
  readonly lockedReason?: string;

  /* ── S13：几何字段（走 set op，不走 overrides） ── */
  readonly kind?: 'box' | 'override';
  readonly boxKey?: 'x' | 'y' | 'w' | 'h' | 'r';
  readonly styleProp?: 'left' | 'top' | 'width' | 'height' | 'rotate';
  /** 片段自己有没有写这个声明。 */
  readonly declared?: boolean;
  readonly sourceLabel?: 'declared' | 'measured';

  /* ── S15：坐标系。`display` 是面板该显示的值（屏幕空间），`current` 始终是声明值 ── */
  readonly display?: string | number;
  readonly space?: 'screen' | 'declared';

  /* ── S16：可数值化的排版字段 ── */
  readonly numeric?: boolean;
  readonly suffix?: string;
  readonly emptyState?: 'normal' | 'empty';
  /** 值从哪来（证据用）：override / 元素内联声明 / computed。 */
  readonly valueFrom?: 'override' | 'inline' | 'computed';
}

export interface InspectorGroup {
  readonly id: FieldGroupId;
  readonly label: string;
  readonly fields: readonly InspectorField[];
}

export interface InspectorModel {
  readonly mode: 'single';
  readonly ref: LayerRef;
  readonly locked: boolean;
  readonly groups: readonly InspectorGroup[];
  readonly fields: readonly InspectorField[];
}

export interface MultiInspectorModel {
  readonly mode: 'multi';
  readonly count: number;
  readonly refs: readonly LayerRef[];
  readonly locked: false;
  readonly groups: readonly [];
  readonly fields: readonly [];
  /** 明确告知 UI：本批不支持多选编辑，而不是假装能改。 */
  readonly note: '不支持多选编辑';
}

export type InspectorAny = InspectorModel | MultiInspectorModel;

/** describe() 的结果；`style` 是运行时 computed 子集。 */
export interface DescribedLayer {
  readonly box: LayerBox;
  readonly style: Readonly<Record<string, string>>;
  /** 元素自己的内联声明（S16：区分「倍数」与「像素」）。 */
  readonly inline?: Readonly<Record<string, string>>;
  /** data-lock / 覆盖 lock；由 describe.ts 汇总。 */
  readonly locked?: boolean;
  readonly text?: string;
  readonly tag?: string;
}

export interface BuildInspectorOptions {
  /** 外部已知的锁定（例如轨道锁）；与 override.lock 取或。 */
  readonly locked?: boolean;
  /** 覆盖里的文本；没有则用 describe 的文本。 */
  readonly text?: string;
  /** 片段自己声明的 box（S13）。 */
  readonly box?: unknown;
  /** 已换算到声明空间的基准框（S15）。 */
  readonly baseBox?: unknown;
  /** 没有 box 提交口时置灰几何字段（S13）。 */
  readonly boxEditable?: boolean;
  /** `readGeometrySpace()` 的结果（S15）：给了就按屏幕空间显示与提交。 */
  readonly geometry?: unknown;
}

/**
 * 构造单层检查器模型。
 *
 * `current` 的取值顺序：override.style[key] → describe.style[key] → 空串；
 * 几何：override.s/r 有值才算 override，否则取 describe.box（真实度量）。
 */
export function buildInspector(
  ref: LayerRef,
  override: OverridePatch | null | undefined,
  described: DescribedLayer,
  opts: BuildInspectorOptions = {}
): InspectorModel {
  return buildInspectorRuntime(ref, override, described, opts) as InspectorModel;
}

/** 多选：明确不支持编辑，不渲染可改字段。 */
export function buildMultiInspector(refs: readonly LayerRef[]): MultiInspectorModel {
  return buildMultiInspectorRuntime(refs) as unknown as MultiInspectorModel;
}

/** 字段 id → 最小 OverridePatch。只含用户改的这一个键。 */
export function patchForField(
  fieldId: string,
  value: string | number,
  opts: { suffix?: string } = {}
): { patch: OverridePatch } | { error: { code: string; message: string; at?: string } } {
  return patchForFieldRuntime(fieldId, value, opts);
}

/** 覆盖合并见 override-merge.mjs（运行时共享，避免两处实现漂移）。 */
