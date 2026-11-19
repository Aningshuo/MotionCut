/** HTTP/state adapter for the existing workbench. No second FilmDoc or write queue is introduced. */
import { createElement as h, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CreationLibrary } from './creation-library';
import type { LibraryAction, LibraryActionResult, LibrarySnapshot, LibraryTarget } from './creation-library-types';

export interface CreationLibraryBridgeProps {
  projectId: string;
  hash: string;
  playhead: number;
  selectedClipIds: string[];
  layerContent?: HTMLElement | null;
  onChanged: (result: LibraryActionResult) => void | Promise<void>;
  onOpenSettings: () => void;
  onSubtitleStyle: () => void;
  onAgentPrompt?: (prompt: string) => void;
  onLayerCategory?: () => void;
  /** Optional application-owned native import route; the bridge does not guess preload APIs. */
  onLargeImport?: (files: File[]) => Promise<void>;
}
const MAX_BROWSER_IMPORT = 24 * 1024 * 1024;
const ACTIVE = new Set(['queued', 'running', 'pending', 'processing']);
interface ApiFailure extends Error { status?: number; code?: string }
async function jsonRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init, headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) } });
  let body: LibraryActionResult;
  try { body = await response.json() as LibraryActionResult; }
  catch { throw Object.assign(new Error('服务返回了无法识别的结果'), { status: response.status }); }
  if (!response.ok || body.ok !== true) throw Object.assign(new Error(body.message || body.code || '资源操作失败'), { status: response.status, code: body.code });
  return body as T;
}
function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { const value = String(reader.result ?? ''); const comma = value.indexOf(','); if (comma < 0) reject(new Error('文件读取失败')); else resolve(value.slice(comma + 1)); };
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'));
    reader.onabort = () => reject(new Error('文件读取已取消'));
    reader.readAsDataURL(file);
  });
}

export function CreationLibraryBridge(props: CreationLibraryBridgeProps): ReactNode {
  const { projectId, hash } = props;
  const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const currentProject = useRef(projectId); currentProject.current = projectId;
  const propsRef = useRef(props); propsRef.current = props;
  const snapshotRef = useRef<LibrarySnapshot | null>(null);
  const readSerial = useRef(0);
  const reading = useRef(false);
  const readController = useRef<AbortController | null>(null);
  const previousJobs = useRef(new Map<string, string>());
  const captionTarget = useRef<LibraryTarget | null>(null);
  const captionSource = useRef<string | undefined>(undefined);
  const pendingWrites = useRef(0);
  const endpoint = projectId ? `/api/projects/${encodeURIComponent(projectId)}/creation-library` : '';

  const load = useCallback(async (quiet = false): Promise<LibrarySnapshot | null> => {
    if (!projectId) return null;
    if (quiet && reading.current) return null;
    const serial = ++readSerial.current;
    reading.current = true;
    readController.current?.abort();
    const controller = new AbortController(); readController.current = controller;
    if (!quiet) setLoading(true);
    try {
      const next = await jsonRequest<LibrarySnapshot & { ok: boolean }>(endpoint, { signal: controller.signal });
      if (!mounted.current || controller.signal.aborted || currentProject.current !== projectId || serial !== readSerial.current) return null;
      const normalized: LibrarySnapshot = { ...next, projectId, items: next.items ?? [], folders: next.folders ?? [] };
      // The catalog's default companion is not necessarily the source chosen in the caption pane.
      // Re-read that exact source and its fresh sidecar hash; never merge an old caption copy into a new film snapshot.
      if (captionTarget.current) {
        try {
          const selectedCaption = await jsonRequest<LibraryActionResult>(`${endpoint}/actions`, { method: 'POST', signal: controller.signal, body: JSON.stringify({ action: 'caption.read', src: captionSource.current, expectedHash: normalized.sourceHash, opId: crypto.randomUUID(), target: captionTarget.current }) });
          if (selectedCaption.captions) normalized.captions = selectedCaption.captions as LibrarySnapshot['captions'];
        } catch (problem) {
          const failure = problem as ApiFailure;
          normalized.captions = { file: null, cues: [], error: { code: failure.code, message: failure.message || '所选来源的字幕无法读取' } };
          if (failure.status === 404) { captionTarget.current = null; captionSource.current = undefined; }
        }
      }
      if (controller.signal.aborted || currentProject.current !== projectId || serial !== readSerial.current) return null;
      snapshotRef.current = normalized; setSnapshot(normalized); setError('');
      let finished = false;
      for (const job of normalized.jobs ?? []) {
        const previous = previousJobs.current.get(job.id);
        if (previous && ACTIVE.has(previous) && !ACTIVE.has(job.state)) finished = true;
        previousJobs.current.set(job.id, job.state);
      }
      if (finished) void Promise.resolve().then(() => propsRef.current.onChanged({ ok: true, hash: normalized.sourceHash, jobsChanged: true })).catch(() => { if (mounted.current && currentProject.current === projectId) setError('任务已结束，工作台状态需要重新刷新'); });
      return normalized;
    } catch (problem) {
      if (mounted.current && !controller.signal.aborted && currentProject.current === projectId && serial === readSerial.current) setError(problem instanceof Error ? problem.message : '资源载入失败');
      return null;
    } finally { if (serial === readSerial.current) { reading.current = false; if (mounted.current && !controller.signal.aborted) setLoading(false); } }
  }, [projectId, endpoint]);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; readController.current?.abort(); }; }, []);
  useEffect(() => {
    snapshotRef.current = null; previousJobs.current.clear(); captionTarget.current = null; captionSource.current = undefined; pendingWrites.current = 0;
    setSnapshot(null); setError(''); setBusy(false);
    if (!projectId) { readController.current?.abort(); setLoading(false); }
  }, [projectId]);
  useEffect(() => { if (projectId) void load(); }, [projectId, hash, load]);
  const selectedSourceId = props.selectedClipIds.length === 1 && snapshot?.captionSources?.sources.some((one) => one.clipId === props.selectedClipIds[0]) ? props.selectedClipIds[0] ?? '' : '';
  useEffect(() => {
    if (!selectedSourceId || !projectId || captionTarget.current?.clipId === selectedSourceId) return;
    captionTarget.current = { clipId: selectedSourceId, selectedClipIds: [selectedSourceId] };
    captionSource.current = undefined;
    void load();
  }, [projectId, selectedSourceId, load]);
  const activeJobs = (snapshot?.projectId === projectId ? snapshot.jobs ?? [] : []).some((job) => ACTIVE.has(job.state));
  useEffect(() => {
    if (!projectId || !activeJobs) return;
    const interval = window.setInterval(() => { if (pendingWrites.current === 0) void load(true); }, 1000);
    return () => window.clearInterval(interval);
  }, [projectId, activeJobs, load]);
  useEffect(() => {
    const refresh = (event: Event): void => {
      const detail = (event as CustomEvent<{ projectId?: string }>).detail;
      if (!detail?.projectId || detail.projectId === projectId) void load(true);
    };
    window.addEventListener('opencut:creation-library-refresh', refresh);
    return () => window.removeEventListener('opencut:creation-library-refresh', refresh);
  }, [projectId, load]);

  async function perform(request: LibraryAction): Promise<LibraryActionResult> {
    const requestedProject = projectId;
    if (!requestedProject) return { ok: false, code: 'PROJECT_REQUIRED', message: '请先打开工程' };
    const current = snapshotRef.current?.projectId === requestedProject ? snapshotRef.current : await load(true);
    if (!current?.sourceHash) return { ok: false, code: 'SNAPSHOT_REQUIRED', message: '资源状态尚未载入，请刷新后再试' };
    const action = { ...request, expectedHash: current.sourceHash, opId: request.opId || crypto.randomUUID() };
    pendingWrites.current += 1; setBusy(true); setError('');
    try {
      // Exactly one POST per user action. A timeout/unknown result is never retried automatically.
      const result = await jsonRequest<LibraryActionResult>(`${endpoint}/actions`, { method: 'POST', body: JSON.stringify(action) });
      if (mounted.current && currentProject.current === requestedProject) {
        if (request.action === 'caption.read' && result.captions) { captionTarget.current = { ...request.target }; captionSource.current = request.src; }
        if (result.job?.id) previousJobs.current.set(result.job.id, result.job.state);
        if (typeof result.agentPrompt === 'string' && result.agentPrompt) propsRef.current.onAgentPrompt?.(result.agentPrompt);
        if (result.hash || result.clipId) {
          try { await propsRef.current.onChanged(result); }
          catch { setError('操作已完成，工作台状态需要重新刷新'); }
        }
        await load();
      }
      return result;
    } catch (problem) {
      const failure = problem as ApiFailure;
      if (mounted.current && currentProject.current === requestedProject) await load(true);
      return { ok: false, code: failure.code || (failure.status === 409 ? 'CONFLICT' : 'REQUEST_FAILED'), message: failure.status === 409 ? '工程已更新，状态已刷新。请确认后再操作。' : failure.message || '操作结果未确认，请刷新后查看，勿重复提交。' };
    } finally {
      if (currentProject.current === requestedProject) { pendingWrites.current = Math.max(0, pendingWrites.current - 1); if (mounted.current) setBusy(pendingWrites.current > 0); }
    }
  }

  async function importFiles(files: File[]): Promise<void> {
    const requestedProject = projectId;
    if (!requestedProject) throw new Error('请先打开工程');
    const large = files.filter((file) => file.size > MAX_BROWSER_IMPORT);
    if (large.length && !propsRef.current.onLargeImport) throw new Error('超过 24 MB 的素材请使用工作台原有的本机导入入口');
    pendingWrites.current += 1; setBusy(true); setError('');
    try {
      if (large.length) await propsRef.current.onLargeImport?.(large);
      for (const file of files.filter((one) => one.size <= MAX_BROWSER_IMPORT)) {
        if (currentProject.current !== requestedProject) throw new Error('工程已切换，剩余文件未导入');
        if (/\.html?$/i.test(file.name)) {
          const result = await perform({ action: 'resource.import-page', params: { fileName: file.name, content: await file.text() } });
          if (!result.ok) throw new Error(result.message || '网页场景导入失败');
        } else {
          const result = await perform({ action: 'resource.import-media', params: { fileName: file.name, data: await fileBase64(file) } });
          if (!result.ok) throw new Error(result.message || '素材导入失败');
        }
      }
      if (currentProject.current === requestedProject) { await load(); await propsRef.current.onChanged({ ok: true, hash: snapshotRef.current?.sourceHash }); }
    } catch (problem) { if (currentProject.current === requestedProject) await load(true); throw problem; }
    finally { if (currentProject.current === requestedProject) { pendingWrites.current = Math.max(0, pendingWrites.current - 1); if (mounted.current) setBusy(pendingWrites.current > 0); } }
  }

  return h(CreationLibrary, {
    projectId, snapshot: snapshot?.projectId === projectId ? snapshot : null, loading, busy, error,
    playhead: props.playhead, selectedClipIds: props.selectedClipIds, layerContent: props.layerContent,
    onRefresh: () => void load(), onImport: importFiles, onAction: perform,
    onOpenSettings: props.onOpenSettings, onSubtitleStyle: props.onSubtitleStyle, onLayerCategory: props.onLayerCategory,
  });
}
