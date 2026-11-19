import { CREATION_CATEGORIES, RESOURCE_DRAG_MIME } from './creation-library-types';
import type { LibraryAction, LibraryCategory } from './creation-library-types';
export { RESOURCE_DRAG_MIME };
export interface ResourceDrop { projectId: string; itemId: string; category: LibraryCategory; at: number; track: number | null; clipId?: string; newTrack?: boolean; toleranceSec?: number; ripple?: boolean }
export function parseResourceDrag(raw: string, projectId: string): { projectId: string; itemId: string; category: LibraryCategory } | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.version !== 1 || value.projectId !== projectId || typeof value.itemId !== 'string' || !value.itemId.trim() || value.itemId.length > 2048 || typeof value.category !== 'string' || !CREATION_CATEGORIES.some(c => c.id === value.category)) return null;
    return { projectId, itemId: value.itemId, category: value.category as LibraryCategory };
  } catch { return null; }
}
export function resourceDropTime(clientX: number, timelineLeft: number, headWidth: number, pps: number, fps: {num: number; den: number}): number {
  const rate = fps.num / fps.den;
  if (![clientX, timelineLeft, headWidth, pps, rate].every(Number.isFinite) || pps <= 0 || rate <= 0) return 0;
  return Math.max(0, Math.round((clientX - timelineLeft - headWidth) / pps * rate) / rate);
}
export function resourceDropAction(drop: ResourceDrop, cuts: Array<{from: {id:string};to:{id:string};trackIndex?:number;at?:number;start?:number}>): LibraryAction {
  if (drop.category === 'transition') {
    if(drop.track===null) throw new Error('请把转场放到一条画面轨道的接缝');
    const cut = cuts.filter(c => (drop.track === null || c.trackIndex === drop.track) && (!drop.clipId || c.from.id === drop.clipId || c.to.id === drop.clipId) && Math.abs((c.at ?? c.start ?? 0)-drop.at) <= (drop.toleranceSec ?? 0.15)).sort((a,b) => Math.abs((a.at ?? a.start ?? 0)-drop.at)-Math.abs((b.at ?? b.start ?? 0)-drop.at))[0];
    if (!cut) throw new Error('请把转场放到相邻画面片段的接缝');
    return { action: 'resource.apply', itemId: drop.itemId, target: { from: cut.from.id, to: cut.to.id, durationSec: 0.6 } };
  }
  return { action: 'resource.apply', itemId: drop.itemId, target: { at: drop.at, track: drop.track, ...(drop.category === 'filter' && drop.clipId ? { mode: 'clip', clipId: drop.clipId } : { mode: drop.newTrack || drop.track === null ? 'new-track' : drop.ripple ? 'ripple' : 'reject-overlap' }) } };
}
