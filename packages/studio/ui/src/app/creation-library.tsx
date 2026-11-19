/** Independently implemented creation-library UI. All domain writes are delegated through onAction. */
import { createElement as h, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties, FocusEvent, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { editorIcon } from './editor-icons';
import type { EditorIconName } from './editor-icons';
import {
  CREATION_CATEGORIES, RESOURCE_DRAG_MIME, arrangedLibraryCategories, filterLibraryItems,
  libraryActionTarget, libraryAudioSources, libraryCaptionRows, libraryCaptionVersions, libraryDuration, libraryPreviewKind, pickLibrarySelection,
  resourceDragPayload, safeLibraryPreviewUrl,
} from './creation-library-types';
import type { CreationLibraryProps, LibraryAction, LibraryActionResult, LibraryCategory, LibraryItem, LibrarySort } from './creation-library-types';
import './creation-library.css';

const extraIcons = {
  star: new URL('../assets/creation-icons/star.svg', import.meta.url).href,
  starred: new URL('../assets/creation-icons/star-filled.svg', import.meta.url).href,
  plus: new URL('../assets/creation-icons/plus.svg', import.meta.url).href,
  close: new URL('../assets/creation-icons/x.svg', import.meta.url).href,
  list: new URL('../assets/creation-icons/list.svg', import.meta.url).href,
  left: new URL('../assets/creation-icons/chevron-left.svg', import.meta.url).href,
  right: new URL('../assets/creation-icons/chevron-right.svg', import.meta.url).href,
  check: new URL('../assets/creation-icons/check.svg', import.meta.url).href,
  folderAdd: new URL('../assets/creation-icons/folder-plus.svg', import.meta.url).href,
  rename: new URL('../assets/creation-icons/pencil.svg', import.meta.url).href,
  folder: new URL('../assets/creation-icons/folder.svg', import.meta.url).href,
  file: new URL('../assets/creation-icons/file-text.svg', import.meta.url).href,
  download: new URL('../assets/creation-icons/download.svg', import.meta.url).href,
} as const;
type ExtraIcon = keyof typeof extraIcons;
function icon(name: EditorIconName | ExtraIcon, size = 16): ReactNode {
  if (!(name in extraIcons)) return editorIcon(name as EditorIconName, size);
  const src = extraIcons[name as ExtraIcon];
  return h('span', { className: 'cl-icon', 'aria-hidden': true, style: { width: size, height: size, maskImage: `url("${src}")`, WebkitMaskImage: `url("${src}")` } as CSSProperties });
}
function iconButton(label: string, glyph: EditorIconName | ExtraIcon, onClick: () => void, options: { disabled?: boolean; active?: boolean; className?: string; testId?: string } = {}): ReactNode {
  return h('button', { type: 'button', 'data-editor-hint': label, 'aria-label': label, className: `cl-icon-button ${options.active ? 'is-active' : ''} ${options.className ?? ''}`, disabled: options.disabled, 'data-testid': options.testId, onClick: (event: MouseEvent) => { event.stopPropagation(); onClick(); } }, icon(glyph));
}
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = ref.current;
    element?.querySelector<HTMLElement>('button,input,textarea,select,[tabindex="0"]')?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  const key = (event: KeyboardEvent<HTMLDivElement>): void => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
    if (event.key !== 'Tab') return;
    const nodes = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]') ?? [])].filter((node) => node.getAttribute('aria-hidden') !== 'true');
    const first = nodes[0]; const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  return h('div', { className: 'cl-modal-backdrop', onPointerDown: (event) => { if (event.target === event.currentTarget) onClose(); } },
    h('div', { ref, className: 'cl-modal', role: 'dialog', 'aria-modal': true, 'aria-labelledby': titleId, onKeyDown: key },
      h('header', null, h('h2', { id: titleId }, title), iconButton('关闭', 'close', onClose)), children));
}
function LayerSlot({ content }: { content?: HTMLElement | null }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!content || !ref.current) return;
    const host = ref.current;
    const previous = content.parentElement; const next = content.nextSibling;
    const wasHidden = content.hidden;
    content.hidden = false;
    host.appendChild(content);
    return () => { if (previous?.isConnected && content.parentElement === host) { content.hidden = wasHidden; previous.insertBefore(content, next?.parentNode === previous ? next : null); } };
  }, [content]);
  return h('div', { ref, className: 'cl-layer-slot', 'data-testid': 'creation-layers-host' }, !content ? h('p', { className: 'cl-empty-note' }, '选择片段后查看图层') : null);
}
function resourceGlyph(item: LibraryItem): EditorIconName {
  if (item.category === 'skill') return 'skill';
  if (item.category === 'sound') return 'waveform';
  if (item.mediaKind === 'sound' || ['voice', 'sound', 'music'].includes(item.category)) return item.category === 'voice' ? 'microphone' : 'music';
  return (CREATION_CATEGORIES.find((one) => one.id === item.category)?.icon ?? 'photo') as EditorIconName;
}
function Artwork({ item, full = false }: { item: LibraryItem; full?: boolean }): ReactNode {
  const [failed, setFailed] = useState(false);
  const kind = libraryPreviewKind(item);
  const thumbnail = safeLibraryPreviewUrl(item.thumbUrl);
  const preview = safeLibraryPreviewUrl(item.previewUrl);
  useEffect(() => setFailed(false), [item.id, thumbnail, preview]);
  if (failed) return h('span', { className: 'cl-artwork-fallback' }, icon('photo', 24), h('small', null, '预览未载入'));
  if (thumbnail) return h('img', { src: thumbnail, alt: '', loading: 'lazy', onError: () => setFailed(true) });
  if (kind === 'page' && preview) return h('iframe', { title: `${item.name}封面`, src: full ? preview : `${preview}${preview.includes('?') ? '&' : '?'}preview=thumbnail`, loading: 'lazy', sandbox: 'allow-scripts', tabIndex: -1, 'aria-hidden': true, className: full ? '' : 'cl-scene-thumbnail', onError: () => setFailed(true) });
  if (kind === 'image' && preview) return h('img', { src: preview, alt: '', loading: 'lazy', onError: () => setFailed(true) });
  return h('span', { className: 'cl-artwork-fallback', 'data-media-kind': kind }, editorIcon(resourceGlyph(item), 26));
}
/** Selected-clip saving intentionally has no library-card identity. */
export function selectedTextSaveRequest(selectedClipIds: readonly string[], name: string): { ok: boolean; request?: LibraryAction; message?: string } {
  if (selectedClipIds.length !== 1 || !selectedClipIds[0]) return { ok: false, message: '请在时间线上只选择一个文字片段再保存' };
  if (!name.trim()) return { ok: false, message: '请输入文字资源名称' };
  const clipId = selectedClipIds[0];
  return { ok: true, request: { action: 'resource.save', name: name.trim(), params: { category: 'text' }, target: { clipId, selectedClipIds: [clipId] } } };
}
export function skillPromptInsertionError(prompt: unknown): string {
  if (typeof prompt !== 'string' || !prompt.trim()) return '技能没有返回可放入对话的内容，未执行';
  return prompt.length > 16000 ? '技能内容超过对话输入上限（16,000 字符），请精简后再加入；未执行' : '';
}
type EditDialog = { action: 'resource.rename' | 'resource.move' | 'resource.save' | 'folder.create' | 'resource.remove'; item?: LibraryItem; clipId?: string };
const ACTIVE_JOBS = ['queued', 'running', 'pending', 'processing'];
const LANGUAGES = [['zh', '中文'], ['en', '英语'], ['ja', '日语'], ['ko', '韩语'], ['es', '西班牙语'], ['fr', '法语'], ['de', '德语']] as const;

export function CreationLibrary(props: CreationLibraryProps): ReactNode {
  const { snapshot, projectId, loading, busy } = props;
  const [category, setCategory] = useState<LibraryCategory>('media');
  const [scope, setScope] = useState('all');
  const [query, setQuery] = useState('');
  const [mediaKind, setMediaKind] = useState('all');
  const [sort, setSort] = useState<LibrarySort>('recent');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState('');
  const [preview, setPreview] = useState<LibraryItem | null>(null);
  const [menu, setMenu] = useState<{ item: LibraryItem; x: number; y: number } | null>(null);
  const [dialog, setDialog] = useState<EditDialog | null>(null);
  const [dialogName, setDialogName] = useState('');
  const [dialogFolder, setDialogFolder] = useState('');
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [newText, setNewText] = useState('');
  const [speech, setSpeech] = useState('');
  const [language, setLanguage] = useState('zh');
  const [audioIds, setAudioIds] = useState<string[]>([]);
  const [captionText, setCaptionText] = useState('');
  const [cutId, setCutId] = useState('');
  const [transitionDuration, setTransitionDuration] = useState(0.5);
  const tabsRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const captionImportRef = useRef<HTMLInputElement>(null);
  const specialImportRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const skillInsertionFeedback = useRef<{ ok: boolean; message: string; code?: string } | null>(null);
  const awaitingSkillInsertion = useRef(false);
  const activeProject = useRef(projectId);
  activeProject.current = projectId;
  const tabId = useId();
  const categories = useMemo(() => arrangedLibraryCategories(snapshot?.preferences?.order), [snapshot?.preferences?.order]);
  const items = useMemo(() => filterLibraryItems(snapshot?.items ?? [], { category, query, scope, mediaKind, sort }), [snapshot?.items, category, query, scope, mediaKind, sort]);
  const picked = snapshot?.items.find((one) => one.id === selected[selected.length - 1] && one.category === category) ?? null;
  const locked = busy || requesting || projectId === '';
  const folders = snapshot?.folders ?? [];
  const visibleFolders = folders.filter((folder) => ['media', 'sound', 'music'].includes(category) || !folder.id.startsWith('project-folder:'));
  const sources: { id: string; label: string; icon: EditorIconName | ExtraIcon }[] = [
    { id: 'all', label: '全部资源', icon: 'grid' },
    { id: 'favorites', label: '收藏', icon: 'star' },
    { id: 'project', label: '工程资源', icon: 'project' },
    { id: 'saved', label: '我的保存', icon: 'download' },
    { id: 'builtin', label: '内置资源', icon: 'layout' },
  ];
  if (snapshot?.items.some(item => item.category === category && item.source === 'community')) {
    sources.push({ id: 'community', label: '社区', icon: 'agent' });
  }
  const cuts = snapshot?.cuts ?? [];
  const cut = cuts.find((one) => one.id === cutId) ?? cuts[0];
  const groups = useMemo(() => [...new Set((snapshot?.items ?? []).filter((one) => one.category === category).map((one) => one.group).filter(Boolean))], [snapshot?.items, category]);

  useEffect(() => {
    tabsRef.current?.querySelector<HTMLElement>(`[data-category="${category}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [category]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setSelected([]); setScope('all'); setQuery(''); setPreview(null); setMenu(null); setNotice(null); setAudioIds([]); setRequesting(false); setDialog(null); skillInsertionFeedback.current = null; awaitingSkillInsertion.current = false; }, [projectId]);
  useEffect(() => { setValues(picked?.params ?? {}); }, [picked?.id]);
  useEffect(() => {
    const mapped = snapshot?.captions?.mapping?.clipId;
    if (mapped) setAudioIds([mapped]);
    else if (audioIds.length === 0) setAudioIds(libraryAudioSources(snapshot).filter((one) => one.selected).map((one) => one.id));
  }, [snapshot?.captions?.mapping?.clipId, snapshot?.audio]);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const close = (): void => setMenu(null);
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('blur', close); };
  }, [menu]);
  useEffect(() => {
    const feedback = (event: Event): void => {
      const detail = (event as CustomEvent<{ projectId?: string; ok?: boolean; message?: string; code?: string }>).detail;
      if (detail?.projectId !== projectId || typeof detail.ok !== 'boolean' || !detail.message) return;
      if (awaitingSkillInsertion.current) skillInsertionFeedback.current = { ok: detail.ok, message: detail.message, code: detail.code };
      setNotice({ error: !detail.ok, text: detail.message });
    };
    window.addEventListener('opencut:agent-prompt-insert-result', feedback);
    return () => window.removeEventListener('opencut:agent-prompt-insert-result', feedback);
  }, [projectId]);

  async function request(action: LibraryAction): Promise<LibraryActionResult> {
    const requestedProject = projectId;
    setRequesting(true); setNotice(null);
    if (action.action === 'skill.use') { skillInsertionFeedback.current = null; awaitingSkillInsertion.current = true; }
    try {
      let result = await props.onAction({ ...action, expectedHash: action.expectedHash ?? snapshot?.sourceHash,
        ...(action.action.startsWith('caption.') ? { expectedSubtitleHash: snapshot?.captions?.hash, ...(action.action === 'caption.read' ? {} : { src: action.src ?? snapshot?.captions?.src }) } : {}),
        target: { ...libraryActionTarget(props.playhead, props.selectedClipIds), ...action.target } });
      if (action.action === 'skill.use' && result.ok) {
        const problem = skillPromptInsertionError(result.agentPrompt);
        const feedback = skillInsertionFeedback.current;
        if (problem || feedback?.ok === false) result = { ...result, ok: false, code: feedback?.code || 'PROMPT_INSERT_FAILED', message: problem || feedback?.message };
        else if (feedback?.ok) result = { ...result, message: feedback.message };
      }
      if (mounted.current && activeProject.current === requestedProject) setNotice({ error: !result.ok, text: result.message || (result.ok ? '已完成' : '操作未完成，请重试') });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : '操作未完成，请重试';
      if (mounted.current && activeProject.current === requestedProject) setNotice({ error: true, text: message });
      return { ok: false, message };
    } finally { if (activeProject.current === requestedProject && action.action === 'skill.use') awaitingSkillInsertion.current = false; if (mounted.current && activeProject.current === requestedProject) setRequesting(false); }
  }
  function changeCategory(next: LibraryCategory): void {
    setCategory(next); setScope('all'); setSelected([]); setAnchor(''); setQuery(''); setMediaKind('all'); setMenu(null); setNotice(null);
    if (next === 'layers') props.onLayerCategory?.();
  }
  function select(item: LibraryItem, event: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }): void {
    setSelected((current) => pickLibrarySelection(current, item.id, items.map((one) => one.id), { range: event.shiftKey, additive: event.metaKey || event.ctrlKey, anchor }));
    if (!event.shiftKey) setAnchor(item.id);
  }
  function openEdit(action: EditDialog['action'], item?: LibraryItem): void {
    setMenu(null); setDialog({ action, item }); setDialogName(action === 'resource.rename' ? item?.name ?? '' : ''); setDialogFolder(visibleFolders.some((folder) => folder.id === item?.folderId) ? item?.folderId ?? '' : '');
  }
  function openSelectedTextSave(): void {
    if (props.selectedClipIds.length !== 1 || !props.selectedClipIds[0]) { setNotice({ error: true, text: '请在时间线上只选择一个文字片段再保存' }); return; }
    setMenu(null); setDialog({ action: 'resource.save', clipId: props.selectedClipIds[0] }); setDialogName('我的文字样式'); setDialogFolder('');
  }
  async function submitEdit(event: { preventDefault: () => void }): Promise<void> {
    event.preventDefault();
    if (!dialog) return;
    let action: LibraryAction;
    if (dialog.action === 'resource.save' && dialog.clipId) {
      const saved = selectedTextSaveRequest([dialog.clipId], dialogName);
      if (!saved.ok || !saved.request) { setNotice({ error: true, text: saved.message || '请选择一个文字片段' }); return; }
      action = saved.request;
    } else action = { action: dialog.action, itemId: dialog.item?.id, itemIds: dialog.item && selected.includes(dialog.item.id) ? selected : dialog.item ? [dialog.item.id] : undefined,
      ...(dialog.action === 'resource.move' ? { folderId: dialogFolder } : dialog.action !== 'resource.remove' ? { name: dialogName.trim(), params: { category, ...(dialog.action === 'resource.save' ? { name: dialogName.trim() } : {}) } } : {}) };
    const result = await request(action);
    if (result.ok) setDialog(null);
  }
  async function apply(item: LibraryItem): Promise<void> {
    if (item.availability === 'needs-provider') { props.onOpenSettings(); return; }
    if (locked || item.availability !== 'ready') { setNotice({ error: true, text: item.reason || '这个资源暂时不可用' }); return; }
    if (item.category === 'skill') { await request({ action: 'skill.use', itemId: item.id }); return; }
    if (item.category === 'voice') { setSelected([item.id]); setNotice({ error: false, text: '输入台词后生成配音' }); return; }
    if (item.category === 'transition' && !cut) { setNotice({ error: true, text: '请先在时间线准备两个相邻片段' }); return; }
    const params: Record<string, unknown> = { ...(item.params ?? {}), ...(item.id === picked?.id ? values : {}) };
    const text = item.id === 'builtin:text-basic' || (item.category === 'text' && newText.trim() !== '') ? newText.trim() || '新文字' : undefined;
    if (text !== undefined) params.title = text;
    await request({ action: 'resource.apply', itemId: item.id, params, ...(text === undefined ? {} : { text }),
      ...(item.category === 'transition' && cut ? { target: { from: cut.from, to: cut.to, at: cut.at, durationSec: transitionDuration } } : {}),
    });
  }
  async function importFiles(files: File[]): Promise<void> {
    if (files.length === 0) return;
    const requestedProject = projectId;
    setRequesting(true); setNotice(null);
    try {
      await props.onImport(files);
      if (mounted.current && activeProject.current === requestedProject) {
        // The normal file picker/drop route also imports HTML. Its void return
        // carries no resource identities: show the pool without guessing a card.
        changeCategory('media');
        setNotice({ error: false, text: `已导入 ${files.length} 个文件` });
      }
    }
    catch (error) { if (mounted.current && activeProject.current === requestedProject) setNotice({ error: true, text: error instanceof Error ? error.message : '导入失败' }); }
    finally { if (mounted.current && activeProject.current === requestedProject) setRequesting(false); }
  }
  async function importTextFile(file: File, kind: 'caption' | 'skill' | 'page'): Promise<void> {
    const requestedProject = projectId;
    try {
      const content = await file.text();
      if (kind === 'caption') {
        const format = /\.vtt$/i.test(file.name) ? 'vtt' : /\.srt$/i.test(file.name) ? 'srt' : '';
        if (!format) { setNotice({ error: true, text: '请选择 SRT 或 VTT 字幕文件' }); return; }
        const clipId = snapshot?.captions?.mapping?.clipId;
        await request({ action: 'caption.import', target: { clipId, selectedClipIds: clipId ? [clipId] : props.selectedClipIds }, params: { format, content } });
      } else {
        const result = await request({ action: kind === 'skill' ? 'skill.import' : 'resource.import-page', params: { fileName: file.name, content } });
        if (kind === 'page' && result.ok && activeProject.current === requestedProject) {
          changeCategory('media');
          if (typeof result.itemId === 'string') setSelected([result.itemId]);
          setNotice({ error: false, text: '网页场景已加入素材，可预览或拖入轨道' });
        }
      }
    } catch (error) { setNotice({ error: true, text: error instanceof Error ? error.message : '文件读取失败' }); }
  }
  function categoryKeys(event: KeyboardEvent<HTMLDivElement>): void {
    const current = categories.findIndex((one) => one.id === category);
    let index = current;
    if (event.key === 'ArrowRight') index = (current + 1) % categories.length;
    else if (event.key === 'ArrowLeft') index = (current - 1 + categories.length) % categories.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = categories.length - 1;
    else return;
    event.preventDefault(); event.stopPropagation();
    const next = categories[index];
    if (next) { changeCategory(next.id); const tab = tabsRef.current?.querySelector<HTMLButtonElement>(`[data-category="${next.id}"]`); tab?.focus(); tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  }
  function gridKeys(event: KeyboardEvent<HTMLDivElement>, item: LibraryItem, index: number): void {
    if (event.target !== event.currentTarget) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); setSelected(items.map((one) => one.id)); return; }
    if (event.key === 'Enter') { event.preventDefault(); void apply(item); return; }
    if (event.key === ' ') { event.preventDefault(); select(item, { ctrlKey: true }); return; }
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); if (item.source === 'project' || item.source === 'saved') openEdit('resource.remove', item); return; }
    const columns = view === 'list' ? 1 : Math.max(1, getComputedStyle(gridRef.current as HTMLElement).gridTemplateColumns.split(' ').length);
    const shift = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowDown' ? columns : event.key === 'ArrowUp' ? -columns : 0;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : Math.min(items.length - 1, Math.max(0, index + shift));
    if (shift || event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); const target = items[next];
      if (target) { select(target, { shiftKey: event.shiftKey }); gridRef.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.focus(); }
    }
  }
  function resourceCard(item: LibraryItem, index: number): ReactNode {
    const chosen = selected.includes(item.id); const duration = libraryDuration(item.durationSec);
    const unavailable = item.availability !== 'ready';
    const status = item.availability === 'needs-provider' ? '需配置' : item.availability === 'missing' ? '文件缺失' : item.availability === 'downloading' ? '准备中' : item.availability === 'failed' ? '不可用' : '';
    return h('div', { key: item.id, className: `cl-resource ${chosen ? 'is-selected' : ''} ${unavailable ? 'is-unavailable' : ''}`, role: 'option', 'aria-selected': chosen,
      tabIndex: chosen || (selected.length === 0 && index === 0) ? 0 : -1, 'data-item-id': item.id, 'data-index': index, 'data-testid': 'creation-resource',
      title: item.reason || item.name, draggable: !unavailable && projectId !== '',
      onDragStart: (event) => { if (unavailable || !projectId) { event.preventDefault(); return; } event.dataTransfer.setData(RESOURCE_DRAG_MIME, resourceDragPayload(projectId, item)); event.dataTransfer.effectAllowed = 'copy'; setSelected([item.id]); },
      onClick: (event: MouseEvent) => select(item, event), onDoubleClick: () => void apply(item), onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => gridKeys(event, item, index),
      onContextMenu: (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); if (!chosen) setSelected([item.id]); setMenu({ item, x: Math.min(event.clientX, window.innerWidth - 190), y: Math.min(event.clientY, window.innerHeight - 310) }); },
    }, h('div', { className: 'cl-artwork', draggable: !unavailable && projectId !== '' }, h(Artwork, { item }), duration ? h('span', { className: 'cl-duration' }, duration) : null,
      status ? h('span', { className: 'cl-resource-status' }, status) : null,
      h('div', { className: 'cl-card-actions' }, iconButton('预览', 'play', () => setPreview(item), { disabled: !safeLibraryPreviewUrl(item.previewUrl || item.thumbUrl) }),
        iconButton(item.favorite ? '取消收藏' : '收藏', item.favorite ? 'starred' : 'star', () => void request({ action: 'resource.favorite', itemId: item.id, value: !item.favorite }), { disabled: locked, active: item.favorite }),
        iconButton(item.availability === 'needs-provider' ? '配置服务' : '应用到工程', item.availability === 'needs-provider' ? 'settings' : 'plus', () => void apply(item), { disabled: locked || (unavailable && item.availability !== 'needs-provider') }))),
      h('div', { className: 'cl-resource-caption' }, h('span', null, item.name), item.favorite ? icon('starred', 12) : null),
      view === 'list' ? h('span', { className: 'cl-list-kind' }, item.mediaKind === 'video' ? '视频' : item.mediaKind === 'still' ? '图片' : item.mediaKind === 'sound' ? '音频' : category === 'skill' ? '技能' : '') : null);
  }
  function capabilityNotice(id: string, label: string): ReactNode {
    const alias = id === 'media.tts' ? 'voice' : id === 'caption.recognize' ? 'subtitle' : id === 'caption.translate' ? 'translate' : id;
    const capability = snapshot?.capabilities?.[id] ?? snapshot?.capabilities?.[alias];
    if (capability?.ready) return null;
    return h('div', { className: 'cl-service-note' }, h('span', null, capability?.reason || `${label}需要配置服务`), h('button', { type: 'button', onClick: props.onOpenSettings }, '去设置'));
  }
  function captionsPane(): ReactNode {
    const cues = libraryCaptionRows(snapshot); const audio = libraryAudioSources(snapshot);
    const mappedClipId = snapshot?.captions?.mapping?.clipId;
    const captionTarget = { clipId: mappedClipId, selectedClipIds: mappedClipId ? [mappedClipId] : props.selectedClipIds };
    const versions = libraryCaptionVersions(snapshot);
    return h('div', { className: 'cl-special-pane', 'data-testid': 'creation-captions' },
      snapshot?.captions?.error ? h('p', { className: 'cl-notice is-error', role: 'alert' }, snapshot.captions.error.message) : null,
      versions.length > 1 ? h('label', { className: 'cl-form-field' }, h('span', null, '字幕版本'), h('select', { 'aria-label': '字幕版本', disabled: locked, value: snapshot?.captions?.src ?? versions[0]?.src, onChange: (event: ChangeEvent<HTMLSelectElement>) => { const version = versions.find((one) => one.src === event.currentTarget.value); if (version) void request({ action: 'caption.read', src: version.src, target: { clipId: version.clipId, selectedClipIds: version.clipId ? [version.clipId] : [] } }); } }, versions.map((version) => h('option', { key: version.id, value: version.src }, version.label)))) : null,
      h('section', { className: 'cl-form-section' }, h('h3', null, '添加字幕'),
        h('div', { className: 'cl-inline-field' }, h('input', { value: captionText, onChange: (event) => setCaptionText(event.currentTarget.value), placeholder: '输入这一句字幕', 'aria-label': '新字幕内容' }), iconButton('在播放头添加字幕', 'plus', () => void request({ action: 'caption.add', target: captionTarget, text: captionText, params: { timeBase: 'timeline', start: props.playhead, end: props.playhead + 3, text: captionText } }), { disabled: locked || !captionText.trim() })),
        h('div', { className: 'cl-button-row' }, h('button', { type: 'button', className: 'cl-secondary', onClick: () => captionImportRef.current?.click(), disabled: locked }, icon('download'), '导入字幕'), h('button', { type: 'button', className: 'cl-secondary', onClick: props.onSubtitleStyle }, '字幕样式'))),
      h('section', { className: 'cl-form-section' }, h('h3', null, '识别与翻译'), capabilityNotice('caption.recognize', '语音识别'),
        audio.length ? h('fieldset', { className: 'cl-audio-sources' }, h('legend', null, '声音来源（一次一条）'), audio.map((one) => h('label', { key: one.id }, h('input', { type: 'radio', name: `${tabId}-caption-source`, checked: audioIds.includes(one.id), disabled: locked, onChange: () => { setAudioIds([one.id]); void request({ action: 'caption.read', target: { clipId: one.id, selectedClipIds: [one.id] } }); } }), h('span', null, one.name), h('small', null, libraryDuration(one.durationSec))))) : h('p', { className: 'cl-empty-note' }, '先在工程中加入带声音的视频或音频'),
        h('label', { className: 'cl-form-field' }, h('span', null, '目标语言'), h('select', { value: language, onChange: (event: ChangeEvent<HTMLSelectElement>) => setLanguage(event.currentTarget.value) }, LANGUAGES.map(([id, label]) => h('option', { key: id, value: id }, label)))),
        h('div', { className: 'cl-button-row' }, h('button', { type: 'button', className: 'cl-secondary', disabled: locked || audioIds.length === 0 || (snapshot?.capabilities?.['caption.recognize'] ?? snapshot?.capabilities?.subtitle)?.ready !== true, onClick: () => void request({ action: 'caption.recognize', target: { selectedClipIds: audioIds, clipId: audioIds.length === 1 ? audioIds[0] : undefined }, params: { audioIds, selectedClipIds: audioIds, language } }) }, '识别字幕'), h('button', { type: 'button', className: 'cl-secondary', disabled: locked || cues.length === 0 || (snapshot?.capabilities?.['caption.translate'] ?? snapshot?.capabilities?.translate)?.ready !== true, onClick: () => void request({ action: 'caption.translate', target: captionTarget, params: { language } }) }, '翻译字幕')),
        capabilityNotice('caption.translate', '字幕翻译')),
      h('section', { className: 'cl-form-section' }, h('h3', null, '字幕内容'), cues.length ? h('ol', { className: 'cl-cues' }, cues.map((cue, index) => h('li', { key: `${cue.sourceIndex ?? index}:${cue.start}` }, h('div', { className: 'cl-cue-time' }, h('span', null, `${libraryDuration(cue.start)} – ${libraryDuration(cue.end)}`), iconButton('删除这一句', 'trash', () => void request({ action: 'caption.remove', target: captionTarget, params: { index: cue.sourceIndex ?? index } }), { disabled: locked })), h('textarea', { defaultValue: cue.text, key: `${index}:${cue.text}`, 'aria-label': `第${index + 1}句字幕`, rows: 2, onBlur: (event: FocusEvent<HTMLTextAreaElement>) => { const text = event.currentTarget.value; if (text !== cue.text) void request({ action: 'caption.update', target: captionTarget, text, params: { timeBase: 'timeline', index: cue.sourceIndex ?? index, start: cue.start, end: cue.end, text } }); } })))) : h('p', { className: 'cl-empty-note' }, '导入文件、识别语音，或手动添加第一句')));
  }
  function voicePane(): ReactNode {
    const voices = (snapshot?.items ?? []).filter((one) => one.category === 'voice');
    const voice = picked?.category === 'voice' ? picked : voices[0];
    return h('section', { className: 'cl-form-section cl-voice-form' }, h('h3', null, '生成配音'), capabilityNotice('media.tts', '配音'),
      h('label', { className: 'cl-form-field' }, h('span', null, '声音'), h('select', { 'aria-label': '配音声音', value: voice?.id ?? '', onChange: (event: ChangeEvent<HTMLSelectElement>) => setSelected([event.currentTarget.value]) }, voices.length ? voices.map((one) => h('option', { value: one.id, key: one.id }, one.name)) : h('option', { value: '' }, '暂无可用声音'))),
      h('textarea', { 'aria-label': '配音台词', placeholder: '输入要朗读的台词', value: speech, rows: 4, onChange: (event: ChangeEvent<HTMLTextAreaElement>) => setSpeech(event.currentTarget.value) }),
      h('button', { type: 'button', className: 'cl-primary', disabled: locked || !speech.trim() || !voice || (snapshot?.capabilities?.['media.tts'] ?? snapshot?.capabilities?.voice)?.ready !== true,
        onClick: () => void request({ action: 'media.tts', itemId: voice?.id, text: speech, params: { voiceId: voice?.id, text: speech } }) }, '生成并加入工程'));
  }
  function parameters(): ReactNode {
    if (!picked) return null;
    const schema = picked.paramSchema ?? {}; const entries = Object.entries(schema);
    if (entries.length === 0 && picked.category !== 'skill') return null;
    return h('section', { className: 'cl-form-section cl-item-detail' }, h('h3', null, picked.name),
      picked.category === 'skill' ? h('div', { className: 'cl-button-row' }, h('button', { type: 'button', className: 'cl-secondary', disabled: locked || picked.availability !== 'ready', onClick: () => void request({ action: 'skill.toggle', itemId: picked.id, value: picked.enabled !== true }) }, picked.enabled ? '停用技能' : '启用技能'), h('button', { type: 'button', className: 'cl-primary', disabled: locked || picked.availability !== 'ready', onClick: () => void apply(picked) }, '用于当前对话')) : null,
      entries.map(([name, field]) => {
        const value = values[name] ?? field.default ?? '';
        const control = field.options?.length ? h('select', { value: String(value), onChange: (event: ChangeEvent<HTMLSelectElement>) => { const next = event.currentTarget.value; setValues((current) => ({ ...current, [name]: next })); } }, field.options.map((option) => h('option', { value: String(option), key: String(option) }, String(option))))
          : field.type === 'boolean' ? h('input', { type: 'checkbox', checked: value === true, onChange: (event) => { const checked = event.currentTarget.checked; setValues((current) => ({ ...current, [name]: checked })); } })
            : h('input', { type: field.type === 'number' || field.type === 'integer' ? 'number' : field.type === 'color' ? 'color' : 'text', value: typeof value === 'string' || typeof value === 'number' ? value : '', min: field.min, max: field.max, step: field.type === 'integer' ? 1 : 'any', onChange: (event) => { const next = event.currentTarget.value; setValues((current) => ({ ...current, [name]: field.type === 'number' || field.type === 'integer' ? Number(next) : next })); } });
        return h('label', { className: 'cl-form-field', key: name }, h('span', null, field.label || name), control);
      }), entries.length ? h('button', { type: 'button', className: 'cl-primary', disabled: locked || picked.availability !== 'ready', onClick: () => void apply(picked) }, '应用设置') : null);
  }
  function jobs(): ReactNode {
    const entries = snapshot?.jobs ?? [];
    if (entries.length === 0) return null;
    return h('section', { className: 'cl-jobs', 'aria-label': '创作任务' }, entries.map((job) => {
      const active = ACTIVE_JOBS.includes(job.state);
      const progress = typeof job.progress === 'number' ? Math.min(100, Math.max(0, job.progress <= 1 ? job.progress * 100 : job.progress)) : null;
      const name = job.kind === 'tts' || job.kind === 'media.tts' ? '配音' : /recogn/.test(job.kind) ? '字幕识别' : /translat/.test(job.kind) ? '字幕翻译' : '创作任务';
      return h('div', { className: 'cl-job', key: job.id }, h('span', null, name), h('span', { className: 'cl-job-state' }, active ? progress === null ? '处理中' : `${Math.round(progress)}%` : job.state === 'succeeded' || job.state === 'completed' || job.state === 'done' ? '完成' : job.state === 'cancelled' || job.state === 'canceled' ? '已取消' : job.error || job.state), active ? iconButton('取消任务', 'close', () => void request({ action: 'job.cancel', params: { jobId: job.id } })) : null, active ? h('progress', { max: 100, ...(progress === null ? {} : { value: progress }), 'aria-label': `${name}进度` }) : null);
    }));
  }
  function navItem(id: string, label: string, glyph?: EditorIconName | ExtraIcon): ReactNode {
    return h('button', { key: id, type: 'button', className: scope === id ? 'is-active' : '', 'aria-current': scope === id ? 'page' : undefined, onClick: () => { setScope(id); setSelected([]); } }, glyph ? icon(glyph, 14) : null, h('span', null, label));
  }

  return h('section', { className: 'creation-library', 'data-testid': 'creation-library', 'data-category': category, 'aria-label': '创作资源',
    onKeyDown: (event) => { if (event.key !== 'Tab') event.stopPropagation(); } },
    h('div', { className: 'cl-category-header' }, iconButton('前面的分类', 'left', () => tabsRef.current?.scrollBy({ left: -180, behavior: 'smooth' })),
      h('div', { className: 'cl-category-tabs', role: 'tablist', 'aria-label': '创作分类', ref: tabsRef, onKeyDown: categoryKeys }, categories.map((one) => h('button', { key: one.id, id: `${tabId}-${one.id}`, type: 'button', role: 'tab', 'aria-selected': category === one.id, 'aria-controls': `${tabId}-panel`, tabIndex: category === one.id ? 0 : -1, className: category === one.id ? 'is-active' : '', 'data-category': one.id, 'data-editor-hint': one.hint, 'aria-description': one.hint, onClick: () => changeCategory(one.id) }, editorIcon(one.icon, 17), h('span', null, one.label)))),
      iconButton('后面的分类', 'right', () => tabsRef.current?.scrollBy({ left: 180, behavior: 'smooth' })),
      h('label', { className: 'cl-category-picker', 'data-editor-hint': '选择创作分类' }, icon('grid', 15),
        h('select', { 'aria-label': '全部创作分类', value: category, onChange: (event: ChangeEvent<HTMLSelectElement>) => changeCategory(event.currentTarget.value as LibraryCategory) },
          categories.map(one => h('option', { key: one.id, value: one.id }, one.label))))),
    h('input', { type: 'file', hidden: true, multiple: true, ref: importRef, accept: 'video/*,audio/*,image/*', onChange: (event) => { void importFiles([...(event.currentTarget.files ?? [])]); event.currentTarget.value = ''; } }),
    h('input', { type: 'file', hidden: true, ref: captionImportRef, accept: '.srt,.vtt', onChange: (event) => { const file = event.currentTarget.files?.[0]; if (file) void importTextFile(file, 'caption'); event.currentTarget.value = ''; } }),
    h('input', { type: 'file', hidden: true, ref: specialImportRef, accept: category === 'skill' ? '.md,.txt' : '.html,.htm', onChange: (event) => { const file = event.currentTarget.files?.[0]; if (file) void importTextFile(file, category === 'skill' ? 'skill' : 'page'); event.currentTarget.value = ''; } }),
    h('div', { className: `cl-body ${category === 'layers' ? 'cl-body-layers' : ''}`, id: `${tabId}-panel`, role: 'tabpanel', 'aria-labelledby': `${tabId}-${category}` },
      category === 'layers' ? h(LayerSlot, { content: props.layerContent }) : h('div', { className: 'cl-browser' },
        h('nav', { className: 'cl-subnav', 'aria-label': '资源目录' },
          sources.map(source => navItem(source.id, source.label, source.icon)),
          groups.length ? h('div', { className: 'cl-nav-group' }, h('span', { className: 'cl-nav-caption' }, '分类'), groups.map((group) => navItem(`group:${group}`, group))) : null,
          h('div', { className: 'cl-nav-group' }, h('div', { className: 'cl-nav-caption' }, h('span', null, '文件夹'), iconButton('新建文件夹', 'folderAdd', () => openEdit('folder.create'), { disabled: locked })), visibleFolders.map((folder) => navItem(`folder:${folder.id}`, folder.name, 'folder')))),
        h('div', { className: 'cl-panel-content' },
          h('div', { className: 'cl-compact-directory' }, icon('folder', 14),
            h('select', { 'aria-label': '资源目录', value: scope, onChange: (event: ChangeEvent<HTMLSelectElement>) => { setScope(event.currentTarget.value); setSelected([]); } },
              h('optgroup', { label: '来源' }, sources.map(source => h('option', { key: source.id, value: source.id }, source.label))),
              groups.length ? h('optgroup', { label: '分类' }, groups.map(group => h('option', { key: group, value: `group:${group}` }, group))) : null,
              visibleFolders.length ? h('optgroup', { label: '文件夹' }, visibleFolders.map(folder => h('option', { key: folder.id, value: `folder:${folder.id}` }, folder.name))) : null),
            iconButton('新建文件夹', 'folderAdd', () => openEdit('folder.create'), { disabled: locked })),
          h('div', { className: 'cl-toolbar' }, h('label', { className: 'cl-search' }, icon('search', 15), h('input', { type: 'search', value: query, onChange: (event) => setQuery(event.currentTarget.value), placeholder: '搜索资源', 'aria-label': '搜索当前分类' })),
            category === 'media' ? iconButton('导入素材', 'export', () => importRef.current?.click(), { disabled: locked, testId: 'creation-import-media' })
              : category === 'captions' ? iconButton('导入字幕', 'export', () => captionImportRef.current?.click(), { disabled: locked })
                : ['skill', 'template'].includes(category) ? iconButton(category === 'skill' ? '导入技能' : '导入网页场景', 'export', () => specialImportRef.current?.click(), { disabled: locked }) : null,
            iconButton(view === 'grid' ? '切换列表' : '切换网格', view === 'grid' ? 'list' : 'grid', () => setView((current) => current === 'grid' ? 'list' : 'grid')),
            h('select', { className: 'cl-sort', 'aria-label': '资源排序', value: sort, onChange: (event: ChangeEvent<HTMLSelectElement>) => setSort(event.currentTarget.value as LibrarySort) }, h('option', { value: 'recent' }, '最近'), h('option', { value: 'name' }, '名称'), h('option', { value: 'duration' }, '时长')),
            iconButton('刷新资源', 'refresh', props.onRefresh, { disabled: requesting })),
          category === 'media' ? h('div', { className: 'cl-media-filters', role: 'group', 'aria-label': '素材类型' }, [['all', '全部'], ['video', '视频'], ['still', '图片'], ['sound', '音频'], ['page', '网页']].map(([id, label]) => h('button', { type: 'button', key: id, 'aria-pressed': mediaKind === id, className: mediaKind === id ? 'is-active' : '', onClick: () => setMediaKind(id as string) }, label))) : null,
          h('div', { className: 'cl-scroll' },
            notice ? h('div', { className: `cl-notice ${notice.error ? 'is-error' : ''}`, role: notice.error ? 'alert' : 'status' }, h('span', null, notice.text), iconButton('收起提示', 'close', () => setNotice(null))) : null,
            props.error ? h('div', { className: 'cl-state', role: 'alert' }, icon('refresh', 25), h('p', null, props.error), h('button', { type: 'button', className: 'cl-secondary', onClick: props.onRefresh }, '重新载入')) : null,
            loading && !snapshot ? h('div', { className: 'cl-state', role: 'status' }, icon('refresh', 25), h('p', null, '正在载入资源')) : projectId === '' ? h('div', { className: 'cl-state' }, editorIcon('project', 28), h('p', null, '打开工程后使用创作资源'))
              : scope === 'community' && items.length === 0 ? h('div', { className: 'cl-state' }, editorIcon('agent', 28), h('p', null, '当前没有可用的社区资源'), h('small', null, '可继续使用工程或内置资源'))
                : category === 'captions' ? captionsPane()
                  : h('div', null,
                    category === 'text' ? h('section', { className: 'cl-new-text cl-form-section' }, h('div', { className: 'cl-inline-field' }, h('input', { value: newText, 'aria-label': '新文字内容', placeholder: '输入标题文字', onChange: (event) => setNewText(event.currentTarget.value) }), iconButton('添加文字', 'plus', () => { const basic = snapshot?.items.find((one) => one.id === 'builtin:text-basic'); if (basic) void apply(basic); else setNotice({ error: true, text: '文字资源暂未载入，请刷新重试' }); }, { disabled: locked })), h('button', { type: 'button', className: 'cl-text-button', disabled: locked || props.selectedClipIds.length !== 1, title: props.selectedClipIds.length === 1 ? '保存时间线上所选片段的当前外观' : '请在时间线上只选择一个文字片段', onClick: openSelectedTextSave }, '保存所选文字样式')) : null,
                    category === 'transition' ? h('section', { className: 'cl-transition-options cl-form-section' }, h('label', { className: 'cl-form-field' }, h('span', null, '片段接缝'), h('select', { value: cut?.id ?? '', onChange: (event: ChangeEvent<HTMLSelectElement>) => setCutId(event.currentTarget.value), disabled: cuts.length === 0 }, cuts.length ? cuts.map((one) => h('option', { key: one.id, value: one.id }, `${libraryDuration(one.at)} · ${one.from} → ${one.to}`)) : h('option', { value: '' }, '暂无相邻片段'))), h('label', { className: 'cl-form-field' }, h('span', null, '时长'), h('input', { type: 'number', min: 0.05, max: cut?.maxDuration ?? 5, step: 0.05, value: transitionDuration, onChange: (event) => setTransitionDuration(Math.max(0.05, Number(event.currentTarget.value) || 0.5)), 'aria-label': '转场时长（秒）' })), h('button', { type: 'button', className: 'cl-text-button', disabled: locked || !cut, onClick: () => void request({ action: 'transition.remove', target: { from: cut?.from, to: cut?.to, at: cut?.at } }) }, '移除接缝转场')) : null,
                    category === 'voice' ? voicePane() : null,
                    items.length ? h('div', { ref: gridRef, className: `cl-resources cl-view-${view}`, role: 'listbox', 'aria-label': '资源列表', 'aria-multiselectable': true, 'aria-busy': loading }, items.map(resourceCard))
                      : h('div', { className: 'cl-state' }, editorIcon(resourceGlyph({ category } as LibraryItem), 28), h('p', null, query ? '没有找到匹配资源' : scope === 'favorites' ? '还没有收藏资源' : scope.startsWith('folder:') ? '这个文件夹是空的' : '这里还没有资源'), category === 'media' && !query ? h('button', { type: 'button', className: 'cl-secondary', disabled: locked, onClick: () => importRef.current?.click() }, '导入素材') : null),
                    parameters()), jobs())))),
    menu ? h('div', { ref: menuRef, className: 'cl-context-menu', role: 'menu', 'aria-label': menu.item.name, style: { left: Math.max(4, menu.x), top: Math.max(4, menu.y) }, onPointerDown: (event) => event.stopPropagation(), onKeyDown: (event) => {
      if (event.key === 'Escape') { setMenu(null); gridRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus(); }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    } },
      [
        ['预览', 'play', () => setPreview(menu.item), false],
        ['应用到工程', 'plus', () => void apply(menu.item), locked || menu.item.availability !== 'ready'],
        [menu.item.favorite ? '取消收藏' : '收藏', 'star', () => void request({ action: 'resource.favorite', itemId: menu.item.id, value: !menu.item.favorite }), locked],
        ['重命名', 'rename', () => openEdit('resource.rename', menu.item), locked || !['project', 'saved'].includes(menu.item.source)],
        ['移到文件夹', 'folder', () => openEdit('resource.move', menu.item), locked || !['project', 'saved'].includes(menu.item.source)],
        ['保存为资源', 'download', () => openEdit('resource.save', menu.item), locked],
        ['移除资源', 'trash', () => openEdit('resource.remove', menu.item), locked || !['project', 'saved'].includes(menu.item.source)],
      ].map(([label, glyph, onClick, disabled], index) => h('button', { key: index, type: 'button', role: 'menuitem', disabled: disabled as boolean, onClick: () => { (onClick as () => void)(); setMenu(null); } }, icon(glyph as EditorIconName | ExtraIcon, 15), label as string))) : null,
    preview ? h(Modal, { title: preview.name, onClose: () => setPreview(null), children: h(PreviewContent, { item: preview, onApply: () => void apply(preview), disabled: locked || preview.availability !== 'ready' }) }) : null,
    dialog ? h(Modal, { title: dialog.action === 'folder.create' ? '新建文件夹' : dialog.action === 'resource.remove' ? '移除资源' : dialog.action === 'resource.move' ? '移动资源' : dialog.action === 'resource.save' ? dialog.clipId ? '保存所选文字样式' : '保存资源' : '重命名', onClose: () => setDialog(null), children:
      h('form', { className: 'cl-edit-form', onSubmit: (event) => void submitEdit(event) },
        dialog.clipId ? h('p', null, '保存打开此窗口时所选片段的当前外观，便于下次复用。') : null,
        dialog.action === 'resource.remove' ? h('p', null, '从资源库中移除所选资源。工程正在引用的源文件将由服务端保护。')
          : dialog.action === 'resource.move' ? h('label', { className: 'cl-form-field' }, h('span', null, '文件夹'), h('select', { value: dialogFolder, onChange: (event: ChangeEvent<HTMLSelectElement>) => setDialogFolder(event.currentTarget.value) }, h('option', { value: '' }, '未分组'), visibleFolders.map((one) => h('option', { value: one.id, key: one.id }, one.name))))
            : h('label', { className: 'cl-form-field' }, h('span', null, '名称'), h('input', { value: dialogName, autoFocus: true, maxLength: 120, required: true, onChange: (event) => setDialogName(event.currentTarget.value) })),
        notice?.error ? h('p', { className: 'cl-inline-error', role: 'alert' }, notice.text) : null,
        h('footer', null, h('button', { type: 'button', className: 'cl-secondary', onClick: () => setDialog(null) }, '取消'), h('button', { type: 'submit', className: 'cl-primary', disabled: requesting || (dialog.action !== 'resource.remove' && dialog.action !== 'resource.move' && !dialogName.trim()) }, requesting ? '处理中' : '确认'))) }) : null);
}

function PreviewContent({ item, onApply, disabled }: { item: LibraryItem; onApply: () => void; disabled: boolean }): ReactNode {
  const [error, setError] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [time, setTime] = useState(0);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const timeRef = useRef(0);
  const lastControl = useRef('');
  const source = safeLibraryPreviewUrl(item.previewUrl || item.thumbUrl);
  const kind = libraryPreviewKind(item);
  const duration = typeof item.durationSec === 'number' && Number.isFinite(item.durationSec) && item.durationSec > 0 ? item.durationSec : 2;
  const motionSource = kind === 'page' && source ? (() => { const url = new URL(source, window.location.href); url.searchParams.set('preview', 'motion'); return url.href; })() : '';
  function control(nextPlaying: boolean, nextTime: number, force = false): void {
    const message = { type: 'opencut:resource-preview-control', playing: nextPlaying, time: Math.max(0, Math.min(duration, nextTime)), duration };
    const fingerprint = JSON.stringify(message);
    const target = frameRef.current?.contentWindow;
    if (!target || (!force && lastControl.current === fingerprint)) return;
    // The preview deliberately has an opaque origin; it never receives same-origin access.
    target.postMessage(message, '*');
    lastControl.current = fingerprint;
  }
  useEffect(() => { setError(false); setPlaying(true); setTime(0); timeRef.current = 0; lastControl.current = ''; }, [item.id, source]);
  useEffect(() => {
    if (kind === 'page' && source && !error) control(playing, timeRef.current);
  }, [kind, motionSource, playing, error, duration]);
  useEffect(() => {
    if (kind !== 'page' || !source || error || !playing) return;
    const start = performance.now(); const from = timeRef.current;
    let frame = 0; let lastShown = start;
    const tick = (now: number): void => {
      if (now - lastShown >= 50) { const next = (from + Math.max(0, now - start) / 1000) % duration; timeRef.current = next; setTime(next); lastShown = now; }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [kind, motionSource, playing, error, duration]);
  function seek(event: ChangeEvent<HTMLInputElement>): void {
    const value = Number(event.currentTarget.value);
    if (!Number.isFinite(value)) return;
    const next = Math.max(0, Math.min(duration, value));
    timeRef.current = next; setTime(next); setPlaying(false); control(false, next);
  }
  return h('div', { className: 'cl-preview-content' },
    !source || error ? h('div', { className: 'cl-state', role: error ? 'alert' : undefined }, h('p', null, error ? '预览载入失败' : '这个资源没有可用预览'))
      : kind === 'video' ? h('video', { src: source, controls: true, autoPlay: false, preload: 'metadata', onError: () => setError(true) })
        : kind === 'audio' ? h('div', { className: 'cl-audio-preview' }, editorIcon('music', 32), h('audio', { src: source, controls: true, preload: 'metadata', onError: () => setError(true) }))
          : kind === 'page' ? h('iframe', { ref: frameRef, src: motionSource, title: item.name, sandbox: 'allow-scripts', onLoad: () => control(playing, timeRef.current, true), onError: () => setError(true) })
            : h('img', { src: source, alt: item.name, onError: () => setError(true) }),
    kind === 'page' && source && !error ? h('div', { className: 'cl-page-preview-controls', role: 'group', 'aria-label': '资源预览播放控制' },
      iconButton(playing ? '暂停预览' : '播放预览', playing ? 'pause' : 'play', () => setPlaying((current) => !current), { className: 'cl-preview-toggle' }),
      h('input', { type: 'range', min: 0, max: duration, step: 0.01, value: time, 'aria-label': '预览时间', 'aria-valuetext': `${time.toFixed(2)} 秒，共 ${duration.toFixed(2)} 秒`, onChange: seek }),
      h('output', { className: 'cl-preview-time', 'aria-live': 'off' }, `${time.toFixed(2)} / ${duration.toFixed(2)}s`)) : null,
    h('footer', null, h('button', { type: 'button', className: 'cl-primary', onClick: onApply, disabled }, '应用到工程')));
}
