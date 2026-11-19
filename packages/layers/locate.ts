/**
 * 稳定定位（副线1 · WP12）
 *
 * 页面重载后按 `at` 复算；0 命中 → LAYER_GONE，>1 → AMBIGUOUS，
 * Canvas/WebGL 内部 → NOT_EDITABLE。绝不返回幽灵层。
 */
import type { LayerRef, LayerError } from '../../contracts/layers';
import { locateByAt, snapshotLayers } from './dom-probe.mjs';

type Page = import('playwright').Page;

interface LocateInfo {
  matches: number;
  tag: string;
  kind: string;
  name: string;
  text: string;
  id: string;
  classes: string[];
  box: { x: number; y: number; w: number; h: number; rotation?: number } | null;
  inCanvas: boolean;
  isCanvas: boolean;
  crossOriginFrame: boolean;
}

interface RawLayer {
  at: string;
  kind: string;
  name: string;
  depth: number;
  parentAt: string | null;
}

export type LocateReturn = { ref: LayerRef; box?: NonNullable<LocateInfo['box']> } | { error: LayerError };

const KINDS = ['text', 'image', 'shape', 'container', 'unknown'] as const;

/**
 * @param page Playwright Page
 * @param clipId 片段 id
 * @param at 稳定定位串（discover 返回的 LayerRef.at）
 */
export async function locate(page: Page, clipId: string, at: string): Promise<LocateReturn> {
  if (!page || page.isClosed()) {
    return { error: { code: 'LAYER_GONE', message: '页面已关闭，无法定位', clipId, at } };
  }
  if (!at) {
    return { error: { code: 'LAYER_GONE', message: '空定位串', clipId } };
  }

  const info = (await page.evaluate(
    locateByAt as unknown as (a: string) => LocateInfo,
    at
  )) as LocateInfo;

  if (!info || info.matches === 0) {
    return { error: { code: 'LAYER_GONE', message: `源改动后目标不存在：${at}`, clipId, at } };
  }
  if (info.matches > 1) {
    return {
      error: { code: 'AMBIGUOUS', message: `定位串命中 ${info.matches} 个元素且无法用序号消歧：${at}`, clipId, at }
    };
  }
  if (info.isCanvas || info.inCanvas) {
    return {
      error: {
        code: 'NOT_EDITABLE',
        message: `Canvas/WebGL 内部对象不可作为 DOM 层编辑（PIXEL_ONLY）：${at}`,
        clipId,
        at
      }
    };
  }

  // 用与 discover 相同的遍历补全 depth / parentAt，保证两处 ref 结构一致。
  let depth = 1;
  let parentAt: string | undefined;
  try {
    const snap = (await page.evaluate(
      snapshotLayers as unknown as (arg: { includeInvisible: boolean }) => { layers: RawLayer[] },
      { includeInvisible: true }
    )) as { layers: RawLayer[] };
    const hit = (snap.layers ?? []).find((l) => l.at === at);
    if (hit) {
      depth = Number.isFinite(hit.depth) ? hit.depth : 1;
      if (hit.parentAt) parentAt = hit.parentAt;
    }
  } catch {
    /* depth 兜底为 1，不影响定位结果 */
  }

  const kind = (KINDS as readonly string[]).includes(info.kind)
    ? (info.kind as LayerRef['kind'])
    : 'unknown';

  const ref: LayerRef = {
    clipId,
    at,
    kind,
    name: info.name || info.text || at,
    selector: at,
    depth,
    ...(parentAt ? { parentAt } : {})
  };
  return info.box ? { ref, box: info.box } : { ref };
}

export default locate;
