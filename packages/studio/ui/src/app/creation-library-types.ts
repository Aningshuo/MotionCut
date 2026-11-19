/** Public UI/domain boundary for the existing workbench's creation library. */
export type LibraryCategory = 'media' | 'skill' | 'template' | 'captions' | 'voice' | 'sound' | 'music' | 'text' | 'sticker' | 'filter' | 'effect' | 'transition' | 'layers';
export interface LibraryItem {
  id: string;
  name: string;
  category: LibraryCategory;
  group: string;
  source: 'project' | 'builtin' | 'saved' | 'community';
  kind: string;
  src?: string;
  mediaKind?: 'video' | 'sound' | 'still' | 'page';
  durationSec?: number | null;
  bytes?: number;
  modifiedAt?: string;
  thumbUrl?: string;
  previewUrl?: string;
  favorite?: boolean;
  folderId?: string;
  refs?: number;
  tags?: string[];
  availability: 'ready' | 'needs-provider' | 'missing' | 'downloading' | 'failed';
  reason?: string;
  params?: Record<string, unknown>;
  paramSchema?: Record<string, { type?: string; label?: string; default?: unknown; min?: number; max?: number; options?: unknown[] }>;
  enabled?: boolean;
}
export interface LibraryTarget {
  at?: number;
  track?: number | null;
  clipId?: string;
  from?: string;
  to?: string;
  mode?: 'ripple' | 'new-track' | 'reject-overlap' | 'overlay' | 'clip';
  durationSec?: number;
  selectedClipIds?: string[];
}
export interface LibraryAction {
  action: string;
  itemId?: string;
  itemIds?: string[];
  name?: string;
  folderId?: string;
  value?: unknown;
  text?: string;
  src?: string;
  target?: LibraryTarget;
  params?: Record<string, unknown>;
  expectedHash?: string;
  expectedSubtitleHash?: string | null;
  opId?: string;
}
export interface LibraryCue { start: number; end: number; text: string; sourceIndex?: number; clipId?: string }
export interface LibraryMediaMapping { clipId: string; at: number; sourceIn: number; sourceOut: number; speed: number }
export interface LibraryAudioSource { clipId: string; src: string; kind?: string; muted?: boolean; mapping?: LibraryMediaMapping }
export interface LibrarySnapshot {
  projectId: string;
  sourceHash: string;
  items: LibraryItem[];
  folders: { id: string; name: string; parentId?: string }[];
  captions?: { file: string | null; cues: LibraryCue[]; format?: string; src?: string; mediaSrc?: string; hash?: string | null; clock?: string; mapping?: LibraryMediaMapping | null; timelineCues?: LibraryCue[]; error?: { code?: string; message: string } };
  audio?: { id: string; name: string; src: string; durationSec: number; selected?: boolean }[] | { sources: LibraryAudioSource[] };
  captionSources?: { sources: LibraryAudioSource[] };
  cuts?: { id: string; from: string; to: string; at: number; maxDuration?: number }[];
  jobs?: { id: string; kind: string; state: string; progress?: number; error?: string; result?: unknown }[];
  capabilities?: Record<string, { ready: boolean; provider?: string; reason?: string }>;
  preferences?: { order?: string[]; hidden?: string[]; view?: string; sort?: string };
}
export interface LibraryActionResult {
  ok: boolean;
  code?: string;
  message?: string;
  hash?: string;
  clipId?: string;
  item?: LibraryItem;
  job?: { id: string; state: string };
  agentPrompt?: string;
  [key: string]: unknown;
}
export interface CreationLibraryProps {
  projectId: string;
  snapshot: LibrarySnapshot | null;
  loading: boolean;
  busy: boolean;
  error?: string;
  playhead: number;
  selectedClipIds: string[];
  layerContent?: HTMLElement | null;
  onRefresh: () => void;
  onImport: (files: File[]) => Promise<void>;
  onAction: (request: LibraryAction) => Promise<LibraryActionResult>;
  onOpenSettings: () => void;
  onSubtitleStyle: () => void;
  onLayerCategory?: () => void;
}
export const RESOURCE_DRAG_MIME = 'application/x-opencut-resource+json';

const animationCategory = { id: 'effect', label: '动画库', icon: 'motion', hint: '浏览和添加预设动画' } as const;

/** Presentation metadata only. Availability and content always come from the server snapshot. */
export const CREATION_CATEGORIES = Object.freeze([
  { id: 'media', label: '素材', icon: 'media-library', hint: '导入和浏览素材' },
  { id: 'layers', label: '图层', icon: 'layers', hint: '选择和管理画布图层' },
  animationCategory,
  { id: 'skill', label: '技能', icon: 'skill', hint: '管理剪辑技能' },
  { id: 'template', label: '模板', icon: 'layout', hint: '浏览和添加场景模板' },
  { id: 'captions', label: '字幕', icon: 'subtitles', hint: '导入、识别和编辑字幕' },
  { id: 'voice', label: '配音', icon: 'microphone', hint: '为片段添加配音' },
  { id: 'sound', label: '音效', icon: 'waveform', hint: '查找和添加音效' },
  { id: 'music', label: '音乐', icon: 'music', hint: '查找和添加配乐' },
  { id: 'text', label: '文字', icon: 'text', hint: '添加文字和文字样式' },
  { id: 'sticker', label: '贴纸', icon: 'sticker', hint: '添加贴纸素材' },
  { id: 'filter', label: '滤镜', icon: 'settings', hint: '应用画面滤镜' },
  { id: 'transition', label: '转场', icon: 'transition', hint: '在片段接缝处添加转场' },
] as const);

export type LibrarySort = 'recent' | 'name' | 'duration';
export interface LibraryFilter {
  category: LibraryCategory;
  query: string;
  scope: string;
  mediaKind: string;
  sort: LibrarySort;
}

export function arrangedLibraryCategories(order: readonly string[] = []): typeof CREATION_CATEGORIES[number][] {
  const ranks = new Map(order.map((id, index) => [id, index]));
  const categories: (typeof CREATION_CATEGORIES)[number][] = CREATION_CATEGORIES.filter(one => one.id !== animationCategory.id)
    .sort((a, b) => (ranks.get(a.id) ?? order.length + CREATION_CATEGORIES.indexOf(a)) - (ranks.get(b.id) ?? order.length + CREATION_CATEGORIES.indexOf(b)));
  // Keep the new entry in the third slot even if a project saved the old category order.
  categories.splice(2, 0, animationCategory);
  return categories;
}

export function filterLibraryItems(items: readonly LibraryItem[], filter: LibraryFilter): LibraryItem[] {
  const query = filter.query.trim().toLocaleLowerCase();
  return items.filter((item) => {
    if (item.category !== filter.category) return false;
    // Each editable page gets a private on-disk copy. Undo keeps it for redo and explicit project browsing.
    if (filter.scope === 'all' && !query && item.source === 'project' && item.refs === 0 && !item.favorite
      && /^assets\/creation-library\/[a-f0-9]{24}\//.test(item.src ?? '')) return false;
    if (query !== '' && ![item.name, item.group, ...(item.tags ?? [])].join(' ').toLocaleLowerCase().includes(query)) return false;
    if (filter.scope === 'favorites' && item.favorite !== true) return false;
    if (['project', 'saved', 'community', 'builtin'].includes(filter.scope) && item.source !== filter.scope) return false;
    if (filter.scope.startsWith('folder:') && item.folderId !== filter.scope.slice(7)) return false;
    if (filter.scope.startsWith('group:') && item.group !== filter.scope.slice(6)) return false;
    return filter.mediaKind === 'all' || item.mediaKind === filter.mediaKind;
  }).sort((a, b) => {
    if (filter.sort === 'name') return a.name.localeCompare(b.name, 'zh-CN');
    if (filter.sort === 'duration') return (a.durationSec ?? Number.POSITIVE_INFINITY) - (b.durationSec ?? Number.POSITIVE_INFINITY) || a.name.localeCompare(b.name, 'zh-CN');
    const delta = (Date.parse(b.modifiedAt ?? '') || 0) - (Date.parse(a.modifiedAt ?? '') || 0);
    return delta || a.name.localeCompare(b.name, 'zh-CN');
  });
}

/** Selection is a view concern; range selection follows the currently visible order. */
export function pickLibrarySelection(current: readonly string[], id: string, visible: readonly string[], options: { range?: boolean; additive?: boolean; anchor?: string } = {}): string[] {
  if (options.range && options.anchor) {
    const from = visible.indexOf(options.anchor);
    const to = visible.indexOf(id);
    if (from >= 0 && to >= 0) {
      const range = visible.slice(Math.min(from, to), Math.max(from, to) + 1);
      return [...new Set([...(options.additive ? current : []), ...range])];
    }
  }
  if (options.additive) return current.includes(id) ? current.filter((one) => one !== id) : [...current, id];
  return [id];
}

/** No filesystem path, URL, account or serialized resource is exposed in drag data. */
export function resourceDragPayload(projectId: string, item: Pick<LibraryItem, 'id' | 'category'>): string {
  return JSON.stringify({ version: 1, projectId, itemId: item.id, category: item.category });
}

export function libraryActionTarget(playhead: number, selectedClipIds: readonly string[]): LibraryTarget {
  return { at: Number.isFinite(playhead) ? Math.max(0, playhead) : 0, selectedClipIds: [...selectedClipIds], mode: 'overlay' };
}

export function libraryDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '';
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

export function libraryPreviewKind(item: LibraryItem): 'video' | 'audio' | 'page' | 'image' {
  if (item.mediaKind === 'page' || /^(page|template|html)$/.test(item.kind) || /\.html?(?:[?#]|$)/i.test(item.previewUrl ?? item.src ?? '')) return 'page';
  if (item.mediaKind === 'sound' || ['sound', 'music', 'voice', 'audio'].includes(item.kind)) return 'audio';
  if (item.mediaKind === 'video' || item.kind === 'video') return 'video';
  return 'image';
}

/** Adapt legacy asset rows and the source-clock caption service without storing a second document. */
export function libraryAudioSources(snapshot: LibrarySnapshot | null): { id: string; name: string; src: string; durationSec: number | null; selected?: boolean }[] {
  const sources = snapshot?.captionSources ?? (snapshot?.audio && !Array.isArray(snapshot.audio) ? snapshot.audio : null);
  if (!sources) return Array.isArray(snapshot?.audio) ? snapshot.audio : [];
  return sources.sources.map((source) => {
    const mapping = source.mapping;
    const duration = mapping ? (mapping.sourceOut - mapping.sourceIn) / mapping.speed : Number.NaN;
    return { id: source.clipId, name: source.src.split(/[\\/]/).pop() || source.clipId, src: source.src, durationSec: Number.isFinite(duration) ? duration : null };
  });
}

export function libraryCaptionRows(snapshot: LibrarySnapshot | null): LibraryCue[] {
  const captions = snapshot?.captions;
  return captions?.timelineCues ?? (captions?.cues ?? []).map((cue, sourceIndex) => ({ ...cue, sourceIndex }));
}

/** Only completed, real translation outputs become selectable versions; no speculative paths. */
export function libraryCaptionVersions(snapshot: LibrarySnapshot | null): { id: string; label: string; src: string; clipId?: string }[] {
  const captions = snapshot?.captions;
  const clipId = captions?.mapping?.clipId;
  const source = snapshot?.captionSources?.sources.find((one) => one.clipId === clipId)?.src;
  const original = captions?.mediaSrc || source || (captions?.src && !/\.translated-[^/]+\.(?:srt|vtt)$/i.test(captions.src) ? captions.src : '');
  if (!original) return [];
  const versions = [{ id: 'original', label: '原文', src: original, clipId }];
  const seen = new Set([original]);
  for (const job of snapshot?.jobs ?? []) {
    if (job.state !== 'completed' || !job.result || typeof job.result !== 'object') continue;
    const result = job.result as { ok?: boolean; src?: unknown; mediaSrc?: unknown; mapping?: { clipId?: string }; language?: string };
    if (result.ok === false || typeof result.src !== 'string' || !/\.translated-[^/]+\.(?:srt|vtt)$/i.test(result.src) || result.mediaSrc !== original || seen.has(result.src)) continue;
    seen.add(result.src);
    const language = result.language || /\.translated-([^/]+)\.(?:srt|vtt)$/i.exec(result.src)?.[1] || '译文';
    versions.push({ id: job.id, label: `译文 · ${language}`, src: result.src, clipId: clipId || result.mapping?.clipId });
  }
  return versions;
}

/** Resource URLs are supplied by the backend; reject executable URL schemes before assigning a media element. */
export function safeLibraryPreviewUrl(value: string | undefined): string {
  const source = (value ?? '').trim();
  if (source === '' || source.startsWith('//') || /[\u0000-\u001f]/.test(source)) return '';
  if (/^[a-z][a-z\d+.-]*:/i.test(source) && !/^(https?:|blob:)/i.test(source)) return '';
  return source;
}
