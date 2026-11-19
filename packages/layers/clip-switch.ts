/**
 * 切片段刷新 + 迟到回包（副线1 · WP14 / 07 图风险复验）
 *
 * 机制：**代际令牌**。每次 switchTo 先自增 generation，并立刻把 UI 目标改成新片段；
 * discover 的响应回来时只有在 `gen === this.generation` 才允许落地，否则丢弃（丢弃计数）。
 * 这样 A 的 300ms 迟到响应不可能覆盖 B，也不会把 B 的层列表与 A 的检查器目标拼在一起。
 *
 * 这里只做客户端状态机；层发现用注入的 discover（真实浏览器里就是 packages/layers/discover.ts）。
 */
import type { LayerError, LayerRef } from '../../contracts/layers';
import type { DiscoverReturn } from './discover';

export interface InspectorTarget {
  /** 检查器当前针对的片段；切片段后必须等于新片段。 */
  readonly clipId: string;
  /** 选中的层定位串；还没选就是 null。 */
  readonly at: string | null;
}

export interface ClipSwitchState {
  readonly clipId: string;
  readonly generation: number;
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly layers: readonly LayerRef[];
  readonly inspector: InspectorTarget;
  /** 被代际令牌丢弃的迟到响应数（可观测，不是静默）。 */
  readonly droppedResponses: number;
  readonly error?: LayerError;
}

export type DiscoverFn = (clipId: string) => Promise<DiscoverReturn>;

export interface ClipSwitchOptions {
  readonly discover: DiscoverFn;
  readonly onChange?: (state: ClipSwitchState) => void;
  /** 初始片段（可空）。 */
  readonly clipId?: string;
}

export interface SwitchOutcome {
  /** 本次调用是否为最终生效的那一代。 */
  readonly applied: boolean;
  readonly generation: number;
  readonly state: ClipSwitchState;
}

const isError = (res: DiscoverReturn): res is { error: LayerError } => 'error' in res;

export class ClipSwitchController {
  #discover: DiscoverFn;
  #onChange: (state: ClipSwitchState) => void;
  #generation = 0;
  #state: ClipSwitchState;

  constructor(opts: ClipSwitchOptions) {
    this.#discover = opts.discover;
    this.#onChange = opts.onChange ?? (() => {});
    this.#state = {
      clipId: opts.clipId ?? '',
      generation: 0,
      status: opts.clipId ? 'loading' : 'idle',
      layers: [],
      inspector: { clipId: opts.clipId ?? '', at: null },
      droppedResponses: 0
    };
  }

  get state(): ClipSwitchState {
    return this.#state;
  }

  get generation(): number {
    return this.#generation;
  }

  /** 选中当前片段的某一层；别的片段的层不接受（防跨片段残留）。 */
  select(at: string | null): void {
    if (at !== null && !this.#state.layers.some((l) => l.at === at)) return;
    this.#set({ inspector: { clipId: this.#state.clipId, at } });
  }

  /**
   * 切到片段 `clipId`。返回时可能尚未 ready（discover 还在途）；
   * 若期间又切了别的片段，本次结果被丢弃，`applied=false`。
   */
  async switchTo(clipId: string): Promise<SwitchOutcome> {
    const gen = ++this.#generation;
    this.#state = {
      ...this.#state,
      clipId,
      generation: gen,
      status: 'loading',
      layers: [],
      /* 检查器目标立即切到新片段；旧片段的选中层不得残留 */
      inspector: { clipId, at: null }
    };
    this.#publish();

    const res = await this.#discover(clipId);

    if (gen !== this.#generation) {
      this.#state = { ...this.#state, droppedResponses: this.#state.droppedResponses + 1 };
      this.#publish();
      return { applied: false, generation: gen, state: this.#state };
    }

    if (isError(res)) {
      this.#state = { ...this.#state, status: 'error', layers: [], error: res.error, inspector: { clipId, at: null } };
      this.#publish();
      return { applied: true, generation: gen, state: this.#state };
    }

    this.#state = {
      ...this.#state,
      status: 'ready',
      layers: res.layers,
      inspector: { clipId, at: null }
    };
    delete (this.#state as { error?: LayerError }).error;
    this.#publish();
    return { applied: true, generation: gen, state: this.#state };
  }

  #set(patch: Partial<ClipSwitchState>): void {
    this.#state = { ...this.#state, ...patch };
    this.#publish();
  }

  #publish(): void {
    this.#onChange(this.#state);
  }
}

export default ClipSwitchController;
