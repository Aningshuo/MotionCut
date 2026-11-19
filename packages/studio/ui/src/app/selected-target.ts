/**
 * 统一选中目标（R112 · L1 · 验收 LI-A03 / A04 / A06）。
 *
 * 为什么要单独一个模块、而不是在 App 里再攒一份 state：
 * 改动前「选中了什么」有三套答案 —— `layerAt`（画布/树）、`elementSel`（Shift 多选）、
 * `selection`（时间线片段）。三者各自能写、各自能被异步回包改，于是「树选的」和
 * 「画布选的」不是同一个对象（D31/D45 都是这类错位），旧回包还能把新目标顶掉。
 *
 * 这里只放**纯函数**：怎么拼、怎么比、什么时候该丢。写状态的地方仍然只有 App 一处
 * （`writeTarget`），所以「一份 target」是可数的：`selectionEpoch` 每次写 +1，
 * 任何异步回包拿旧 epoch 回来都会被 `staleReason()` 判掉。
 *
 * 字段对齐增量包的 `独立接口示例.ts`：`{projectId, sequenceId, clipId, framePath,
 * elementKey, sourceRevision, selectionEpoch}`。刻意**不加** `kind`/`name` —— 那是
 * describe 的产物，不是身份；身份里混进展示字段，两处就会各存一个版本。
 */

/** 一份选中目标。所有字段都是身份的一部分，缺一个就会串（见 `targetSignature`）。 */
export interface SelectedTarget {
  /** 工程 id（跨工程串写的第一道闸）。 */
  projectId: string;
  /** 序列 id。本产品一个工程一条主序列，`main` 是缺省；契约留着是为了多序列不返工。 */
  sequenceId: string;
  /** 承载这一层的片段 id（元素级编辑的 owner；空 = 只选了工程/序列）。 */
  clipId: string;
  /** 页面帧路径（页面片段 `src` 去掉 `#t=`），元素定位串活在这一帧里。 */
  framePath: string;
  /** 元素定位串（`#card-a` / `h2.title:nth-of-type(2)`）。空 = 只选了片段。 */
  elementKey: string;
  /** 写入时的文档 hash（CAS 基座）。回包带着它回来才允许落到当前目标上。 */
  sourceRevision: string;
  /** 单调递增的选中代数。每次写目标 +1，旧回包靠它被判掉。 */
  selectionEpoch: number;
}

/** 目标是从哪条入口写的。只做归因与证据，不参与身份比较。 */
export type SelectionOrigin = 'tree' | 'canvas' | 'timeline' | 'agent' | 'system';

/** 空目标：`projectId` 之外全空、epoch 0。用常量而不是字面量，免得各处拼得不一样。 */
export const EMPTY_TARGET: SelectedTarget = Object.freeze({
  projectId: '',
  sequenceId: '',
  clipId: '',
  framePath: '',
  elementKey: '',
  sourceRevision: '',
  selectionEpoch: 0,
}) as SelectedTarget;

/** 判旧回包用的「现在是什么」。四个维度缺一个都能造成串写。 */
export interface TargetScope {
  projectId: string;
  sequenceId: string;
  selectionEpoch: number;
  sourceRevision: string;
}

/**
 * 回包该不该丢。`null` = 可以落；其它值都是**丢弃原因码**（写证据时要能点名）。
 *
 * 顺序是有讲究的：先判「换了工程/序列」——那种情况 epoch 也会变，但报 `FOREIGN_PROJECT`
 * 比报 `STALE_EPOCH` 更接近真相，排障的人一眼知道是换工程而不是连点两下。
 */
export type StaleReason =
  | 'NO_TARGET'
  | 'FOREIGN_PROJECT'
  | 'FOREIGN_SEQUENCE'
  | 'STALE_EPOCH'
  | 'STALE_REVISION'
  | null;

export function staleReason(target: SelectedTarget | null, scope: TargetScope): StaleReason {
  if (target === null || target.clipId === '') return 'NO_TARGET';
  if (target.projectId !== scope.projectId) return 'FOREIGN_PROJECT';
  if (target.sequenceId !== scope.sequenceId) return 'FOREIGN_SEQUENCE';
  if (target.selectionEpoch !== scope.selectionEpoch) return 'STALE_EPOCH';
  if (target.sourceRevision !== scope.sourceRevision) return 'STALE_REVISION';
  return null;
}

/** 目标身份（不含 epoch / hash）：两入口选到「同一个东西」时这个串必须逐字符相同。 */
export function targetSignature(target: SelectedTarget): string {
  return [target.projectId, target.sequenceId, target.clipId, target.framePath, target.elementKey].join('|');
}

/** 同不同一个「东西」。epoch 每次写都变，所以比较时**不看**它。 */
export function sameTarget(a: SelectedTarget | null, b: SelectedTarget | null): boolean {
  if (a === null || b === null) return a === b;
  return targetSignature(a) === targetSignature(b);
}

/** 目标是否落在元素级（有 elementKey）。 */
export function isElementTarget(target: SelectedTarget | null): boolean {
  return target !== null && target.clipId !== '' && target.elementKey !== '';
}

/**
 * 面板里的统一 id 是 `<clipId>::<at>`（v2 起），树与画布都用这一种写法。
 * 目标里存**裸 at**，所以进出都要过一次：拼的时候加，读的时候剥。
 */
export function unifiedAt(clipId: string, at: string): string {
  if (at === '') return '';
  if (clipId === '') return at;
  return at.startsWith(`${clipId}::`) ? at : `${clipId}::${at}`;
}

/** 剥掉 `<clipId>::` 前缀。前缀是**当前片段**时才算前缀，否则原样返回（跨片段不误伤）。 */
export function bareAt(clipId: string, at: string): string {
  if (at === '') return '';
  if (clipId !== '' && at.startsWith(`${clipId}::`)) return at.slice(clipId.length + 2);
  return at;
}

/**
 * 页面帧路径：片段的 `src` 去掉 `#t=` 与开头的 `./`。
 *
 * 为什么不用 `clip.id` 充当帧身份：`clip.id` 是片段（时间线上的那一条），
 * 帧路径是**页面文件**。同一页被两个片段引用时 id 不同、帧相同——回包要按帧对，
 * 按 id 对就会把 A 片段那次的 describe 落到 B 片段上（这正是要防的串写）。
 */
export function framePathOf(src: string): string {
  const bare = String(src ?? '').split('#')[0] ?? '';
  return bare.startsWith('./') ? bare.slice(2) : bare;
}

export interface MakeTargetInput {
  projectId: string;
  sequenceId: string;
  clipId: string;
  framePath: string;
  elementKey: string;
  sourceRevision: string;
}

/** 拼一份目标。epoch 由写入方给（`writeTarget` 自增），这里不接受外部传入。 */
export function makeTarget(input: MakeTargetInput, selectionEpoch: number): SelectedTarget {
  return {
    projectId: input.projectId,
    sequenceId: input.sequenceId === '' ? 'main' : input.sequenceId,
    clipId: input.clipId,
    framePath: input.framePath,
    elementKey: input.elementKey,
    sourceRevision: input.sourceRevision,
    selectionEpoch,
  };
}

/** 元素空态的原因码：面板拿到它就把「先选片段」那类前置条件话术换掉。 */
export type EmptyReason = 'NO_TARGET' | 'NO_CLIP' | 'ELEMENT_GONE' | 'NO_LAYERS' | null;

export interface EmptyState {
  code: Exclude<EmptyReason, null>;
  /** 人话：告诉用户**下一步在哪点**，而不是「未选中」。 */
  message: string;
}

/**
 * 目标为空 / 元素消失时给什么空态。
 *
 * `known` = 这一帧当前的元素清单（`listLayers` 的结果）；`null` 表示还不知道，
 * 那就别判「消失」——不知道 ≠ 没了（R28 · A 踩过：入场透明度 0 的层被过滤掉，
 * 误判成元素消失会把用户刚选中的层清掉）。
 */
export function emptyStateOf(target: SelectedTarget | null, known: readonly string[] | null): EmptyState | null {
  if (target === null || target.projectId === '') {
    return { code: 'NO_TARGET', message: '在画布上点一个元素，或从左栏「图层」里选一层' };
  }
  if (target.clipId === '') {
    return { code: 'NO_CLIP', message: '在时间线上点一个网页片段，再在画布或左栏「图层」里选元素' };
  }
  if (target.elementKey !== '' && known !== null && known.length > 0 && !known.includes(target.elementKey)) {
    return {
      code: 'ELEMENT_GONE',
      message: `元素 ${target.elementKey} 已不在这一帧里：重新选一层，旧定位串不会套到同名元素上`,
    };
  }
  if (target.elementKey === '' && known !== null && known.length === 0) {
    return { code: 'NO_LAYERS', message: '这个片段的场景里没有可编辑图层' };
  }
  return null;
}

/** 证据用的快照（不含函数、可直接 JSON.stringify）。 */
export function targetSnapshot(target: SelectedTarget | null): Record<string, unknown> {
  if (target === null) return { target: null };
  return {
    target: { ...target },
    signature: targetSignature(target),
    element: isElementTarget(target),
  };
}
