/**
 * 图层定位与实例覆盖合同 v1.0.0
 *
 * 层不是 schema：从运行 DOM 发现。定位必须稳定、可失效、可报错；覆盖只写进片段的 overrides，
 * 不改页面源码，也不把某一帧的 computed 样式烘进源。
 */

export type LayerKind = 'text' | 'image' | 'shape' | 'container' | 'unknown';

/** 运行 DOM 里的一层；`at` 是稳定定位串（选择器路径 + 同名序号），跨重载可复算。 */
export interface LayerRef {
  readonly clipId: string;
  readonly at: string;
  readonly kind: LayerKind;
  readonly name: string;
  /** 源上的选择器（用于重定位与冲突提示），可能为空。 */
  readonly selector?: string;
  readonly depth: number;
  readonly parentAt?: string;
}

export interface LayerBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly rotation?: number;
}

export type LayerErrorCode =
  | 'CLIP_NOT_AT_TIME'    // 片段不在当前帧，不可定位
  | 'LAYER_GONE'          // 源改动后目标不存在
  | 'NOT_EDITABLE'        // Canvas/跨源/封闭 ShadowDOM 内部对象
  | 'AMBIGUOUS'           // 定位串命中多个且无法用序号消歧
  | 'LOCKED';

export interface LayerError {
  readonly code: LayerErrorCode;
  readonly message: string;
  readonly clipId?: string;
  readonly at?: string;
}

/** 覆盖写入：几何 + 样式 + 文本，全部落到该层的 override 条目。 */
export interface OverridePatch {
  readonly t?: string;
  readonly s?: readonly [number, number];
  readonly r?: number;
  readonly style?: Readonly<Record<string, string>>;
  readonly lock?: true;
}

export interface LayerApi {
  /** 发现当前帧可编辑层，按页面结构返回扁平列表 + 父子关系。 */
  discover(clipId: string, t: number): Promise<{ layers: readonly LayerRef[] } | { error: LayerError }>;
  /** 命中测试：画布坐标 → 层（支持 Alt 穿透到下层）。 */
  hitTest(clipId: string, t: number, point: { x: number; y: number }, deep?: boolean): Promise<LayerRef | null>;
  /** 读取某层的当前值（含是否已覆盖）。 */
  describe(ref: LayerRef): Promise<{ box: LayerBox; style: Readonly<Record<string, string>>; override?: OverridePatch } | { error: LayerError }>;
  /**
   * 写入覆盖。必须：
   * - 先 paint（画面立刻变），落盘成功后确认；失败回滚画面；
   * - 与其它在途编辑合并（同一层连续改字号/颜色/描边不得互相覆盖）；
   * - 子层 riders 一起落，不产生「只移动了容器、文字没跟」。
   */
  edit(ref: LayerRef, patch: OverridePatch | null, opts?: { readonly allCopies?: boolean }): Promise<{ hash?: string; error?: LayerError }>;
}

/**
 * 能力分级：必须如实显示，不许把像素内部对象说成可编辑层。
 *
 * **这是「像素投影」标签，不是能力上限**：Canvas/WebGL 标 `PIXEL_ONLY` 只表示
 * 「不能把任意像素自动拆成 DOM 层」；只要该场景有源码或语义对象桥（作者导出对象、
 * 我方注入的 scene 适配器），AI 与人仍可改它的算法、结构、参数——见 `bridge`。
 * 不得用这个标签删掉总包里的源码编辑能力，也不得反过来把 PIXEL_ONLY 宣传成「可任意拆层」。
 */
export const LAYER_CAPABILITY = {
  dom: 'FULL',
  svg: 'PARTIAL',
  canvas: 'PIXEL_ONLY',
  webgl: 'PIXEL_ONLY',
  shadowDomClosed: 'UNSUPPORTED',
  crossOriginFrame: 'UNSUPPORTED',
} as const;

export type LayerCapability = (typeof LAYER_CAPABILITY)[keyof typeof LAYER_CAPABILITY];

/** 一个场景实际具备的编辑路径：像素标签 + 是否存在源码/语义桥。 */
export interface LayerCapabilityInfo {
  readonly level: LayerCapability;
  /** `none` = 只能看像素；`source` = 有场景源码可改；`semantic` = 运行时可交出可寻址对象。 */
  readonly bridge: 'none' | 'source' | 'semantic';
  /**
   * 同一受控渲染器上同 t 是否可复现同一哈希。
   * `same-hash` 才允许用哈希做基线；`tolerance` 必须同时给阈值和 renderer 标识。
   */
  readonly determinism: 'same-hash' | 'tolerance';
  readonly tolerance?: Readonly<{ readonly maxPixelDiffRatio: number; readonly renderer: string }>;
  readonly note?: string;
}
