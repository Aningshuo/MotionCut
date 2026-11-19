/**
 * 最小 DOM 层发现（副线1 · WP12）
 *
 * 输入 (page, clipId, t) → LayerRef[]。没有 schema：层从运行 DOM 现场发现，
 * 定位串 `at` 必须跨重载可复算（#id 优先，其次 tag.class:nth-of-type(n) 路径）。
 *
 * 快照一致性：先等一帧 rAF，再在页面内做一次同步遍历（遍历中不 await），
 * 因此不会把 MutationObserver 前后两半的状态混在一起返回。
 */
import type { LayerRef, LayerKind, LayerError } from '../../contracts/layers';
import { snapshotLayers } from './dom-probe.mjs';

type Page = import('playwright').Page;

export interface UnsupportedLayer {
  readonly at: string;
  readonly reason: 'CROSS_ORIGIN' | 'CLOSED_SHADOW';
  readonly capability: 'UNSUPPORTED';
  readonly src?: string;
}

export interface PixelOnlyLayer {
  readonly at: string;
  readonly capability: 'PIXEL_ONLY';
}

export interface DiscoverStats {
  /** 页面元素总数（含不可编辑）。 */
  readonly nodes: number;
  /** 本次返回的层数。 */
  readonly layers: number;
  /** 宿主侧墙钟耗时（页面内 performance.now 被受控时钟接管，不能用来计时）。 */
  readonly elapsedMs: number;
  readonly pixelOnly: number;
  readonly unsupported: number;
}

export interface DiscoverResult {
  readonly layers: readonly LayerRef[];
  /** 附加信息（不属于合同必需字段）：跨源 iframe 等不可注入区域。 */
  readonly unsupported: readonly UnsupportedLayer[];
  /** 附加信息：Canvas/WebGL 只能像素级处理。 */
  readonly pixelOnly: readonly PixelOnlyLayer[];
  readonly stats: DiscoverStats;
}

export type DiscoverReturn = DiscoverResult | { error: LayerError };

export interface DiscoverOptions {
  /** 默认 false：隐藏元素不进层列表。 */
  readonly includeInvisible?: boolean;
}

const KINDS: readonly LayerKind[] = ['text', 'image', 'shape', 'container', 'unknown'];

function toKind(v: unknown): LayerKind {
  return KINDS.includes(v as LayerKind) ? (v as LayerKind) : 'unknown';
}

interface RawLayer {
  at: string;
  kind: string;
  name: string;
  depth: number;
  parentAt: string | null;
}

interface RawSnapshot {
  layers: RawLayer[];
  unsupported: UnsupportedLayer[];
  pixelOnly: PixelOnlyLayer[];
}

/**
 * @param page Playwright Page
 * @param clipId 片段 id（本批只做透传；时间轴归属在 WP13/14 接入）
 * @param t 当前帧时间（秒）
 */
export async function discover(
  page: Page,
  clipId: string,
  t: number,
  opts: DiscoverOptions = {}
): Promise<DiscoverReturn> {
  if (!page || page.isClosed()) {
    return { error: { code: 'LAYER_GONE', message: '页面已关闭，无法发现层', clipId } };
  }
  if (!Number.isFinite(t)) {
    return { error: { code: 'CLIP_NOT_AT_TIME', message: `非法时间 t=${String(t)}`, clipId } };
  }

  const started = Date.now();
  try {
    // 一致快照：等一帧让 MutationObserver 的改动落地，再同步遍历。
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    );

    const snap = (await page.evaluate(
      snapshotLayers as unknown as (arg: { includeInvisible: boolean }) => RawSnapshot,
      { includeInvisible: !!opts.includeInvisible }
    )) as RawSnapshot;

    const layers: LayerRef[] = [];
    const seen = new Set<string>();
    for (const l of snap.layers ?? []) {
      if (!l || !l.at || seen.has(l.at)) continue;
      seen.add(l.at);
      layers.push({
        clipId,
        at: l.at,
        kind: toKind(l.kind),
        name: l.name || l.at,
        selector: l.at,
        depth: Number.isFinite(l.depth) ? l.depth : 1,
        ...(l.parentAt ? { parentAt: l.parentAt } : {})
      });
    }

    const nodes = await page
      .evaluate(() => document.querySelectorAll('*').length)
      .catch(() => layers.length);

    return {
      layers,
      unsupported: snap.unsupported ?? [],
      pixelOnly: snap.pixelOnly ?? [],
      stats: {
        nodes,
        layers: layers.length,
        elapsedMs: Date.now() - started,
        pixelOnly: (snap.pixelOnly ?? []).length,
        unsupported: (snap.unsupported ?? []).length
      }
    };
  } catch (err) {
    return {
      error: {
        code: 'LAYER_GONE',
        message: `发现层失败：${err instanceof Error ? err.message : String(err)}`,
        clipId
      }
    };
  }
}

export default discover;
