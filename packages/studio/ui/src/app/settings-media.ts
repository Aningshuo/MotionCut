/** Media configuration only; credentials remain in the existing credential store. */
import { createElement as h, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import type { SettingsAiCard } from './api';
import { editorIcon } from './editor-icons';
import './settings-media.css';

export const MEDIA_TASKS = Object.freeze([
  { id: 'image', label: '图像生成', note: '本版未提供' },
  { id: 'voice', label: '语音合成', note: '本机声音或兼容 HTTP 服务' },
  { id: 'subtitle', label: '字幕识别', note: '本机 Whisper 或兼容 HTTP 服务' },
  { id: 'music', label: '音乐生成', note: '本版未提供' },
  { id: 'video', label: '视频生成', note: '本版未提供' },
]);
export interface SettingsMediaProps { ai: SettingsAiCard[] }
interface HttpConfig { endpoint: string; model: string; keyRef: 'model' | null }
interface MediaConfig {
  tts: HttpConfig & { mode: 'system' | 'http'; voice: string };
  asr: HttpConfig & { mode: 'disabled' | 'whisper-cli' | 'http'; binary: string; modelPath: string };
  translate: HttpConfig & { mode: 'disabled' | 'http' };
}
interface ServiceCapability { ready: boolean; reason?: string; provider?: string }
interface MediaResponse {
  ok: boolean;
  config: MediaConfig;
  capabilities: Record<string, ServiceCapability | boolean>;
  voices: { id: string; name: string; language?: string }[];
  message?: string;
  code?: string;
}
type ServiceId = 'tts' | 'asr' | 'translate';
const EMPTY_HTTP: HttpConfig = { endpoint: '', model: '', keyRef: null };
function normalizeConfig(raw: Partial<MediaConfig> | undefined): MediaConfig {
  return {
    tts: { ...EMPTY_HTTP, mode: 'system', voice: '', ...(raw?.tts ?? {}) },
    asr: { ...EMPTY_HTTP, mode: 'disabled', binary: '', modelPath: '', ...(raw?.asr ?? {}) },
    translate: { ...EMPTY_HTTP, mode: 'disabled', ...(raw?.translate ?? {}) },
  };
}
function capabilityOf(body: MediaResponse | null, id: ServiceId): ServiceCapability {
  const action = id === 'tts' ? 'media.tts' : id === 'asr' ? 'caption.recognize' : 'caption.translate';
  const alias = id === 'tts' ? 'voice' : id === 'asr' ? 'subtitle' : 'translate';
  const value = body?.capabilities?.[id] ?? body?.capabilities?.[action] ?? body?.capabilities?.[alias];
  return typeof value === 'boolean' ? { ready: value } : value ?? { ready: false };
}
async function mediaSettings(method: 'GET' | 'PUT', config?: MediaConfig, signal?: AbortSignal): Promise<MediaResponse> {
  const response = await fetch('/api/settings/media-services', {
    method, cache: 'no-store', signal, headers: { accept: 'application/json', ...(method === 'PUT' ? { 'content-type': 'application/json' } : {}) },
    ...(method === 'PUT' ? { body: JSON.stringify({ config }) } : {}),
  });
  const body = await response.json() as MediaResponse;
  if (!response.ok || body.ok !== true) throw new Error(body.message || body.code || '媒体服务配置读取失败');
  return body;
}

export function SettingsMedia(props: SettingsMediaProps): ReactNode {
  const [body, setBody] = useState<MediaResponse | null>(null);
  const [draft, setDraft] = useState<MediaConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [dirty, setDirty] = useState(false);
  const mounted = useRef(true);
  const requestRef = useRef<AbortController | null>(null);
  const providers = props.ai.find((card) => card.id === 'providers') ?? null;
  const skills = props.ai.find((card) => card.id === 'skills') ?? null;
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; requestRef.current?.abort(); }; }, []);
  async function load(): Promise<void> {
    requestRef.current?.abort();
    const controller = new AbortController(); requestRef.current = controller;
    setLoading(true); setError('');
    try {
      const next = await mediaSettings('GET', undefined, controller.signal);
      if (mounted.current && !controller.signal.aborted) { setBody(next); setDraft(normalizeConfig(next.config)); setDirty(false); }
    } catch (problem) { if (mounted.current && !controller.signal.aborted) setError(problem instanceof Error ? problem.message : '配置读取失败'); }
    finally { if (mounted.current && !controller.signal.aborted) setLoading(false); }
  }
  function update(id: ServiceId, field: string, value: string | null): void {
    setDraft((current) => current ? { ...current, [id]: { ...current[id], [field]: value } } : current);
    setDirty(true); setNote('');
  }
  async function save(): Promise<void> {
    if (!draft) return;
    setSaving(true); setError(''); setNote('');
    try {
      const next = await mediaSettings('PUT', draft);
      if (mounted.current) { setBody(next); setDraft(normalizeConfig(next.config)); setDirty(false); setNote('配置已保存。到创作库中生成配音或处理字幕。'); }
    } catch (problem) { if (mounted.current) setError(problem instanceof Error ? problem.message : '保存失败'); }
    finally { if (mounted.current) setSaving(false); }
  }
  function input(id: ServiceId, name: string, label: string, value: string, options: { placeholder?: string; type?: string } = {}): ReactNode {
    return h('label', { className: 'sm-field', key: name }, h('span', null, label), h('input', { type: options.type ?? 'text', value, placeholder: options.placeholder, spellCheck: false, autoComplete: 'off', disabled: saving, onChange: (event) => update(id, name, event.currentTarget.value), 'data-testid': `settings-media-${id}-${name}` }));
  }
  function httpFields(id: ServiceId): ReactNode {
    if (!draft) return null;
    const config = draft[id];
    return h('div', { className: 'sm-http-fields' }, input(id, 'endpoint', 'API 地址', config.endpoint, { placeholder: 'https://…', type: 'url' }), input(id, 'model', '模型', config.model, { placeholder: '服务提供商的模型标识' }),
      h('label', { className: 'sm-field' }, h('span', null, '认证'), h('select', { value: config.keyRef ?? '', disabled: saving, onChange: (event: ChangeEvent<HTMLSelectElement>) => update(id, 'keyRef', event.currentTarget.value === 'model' ? 'model' : null) }, h('option', { value: '' }, '无需密钥'), h('option', { value: 'model' }, '使用已保存的模型密钥'))));
  }
  function state(id: ServiceId): ReactNode {
    const capability = capabilityOf(body, id);
    return h('span', { className: `sm-service-state ${capability.ready && !dirty ? 'is-ready' : ''}`, title: dirty ? '保存后重新检查配置状态' : capability.reason, 'data-testid': `settings-media-${id}-state`, 'data-ready': capability.ready && !dirty ? 'true' : 'false' }, dirty ? '有未保存更改' : capability.ready ? '配置可用' : capability.reason || '未配置');
  }
  function serviceCard(id: ServiceId, title: string, glyph: 'microphone' | 'subtitles' | 'text'): ReactNode {
    if (!draft) return null;
    const config = draft[id];
    const options = id === 'tts' ? [['system', '本机声音'], ['http', '兼容 HTTP 服务']] : id === 'asr' ? [['disabled', '暂不启用'], ['whisper-cli', '本机 Whisper CLI'], ['http', '兼容 HTTP 服务']] : [['disabled', '暂不启用'], ['http', '兼容 HTTP 服务']];
    return h('section', { className: 'sm-service-card', 'data-testid': `settings-media-service-${id}` },
      h('header', null, h('h3', null, editorIcon(glyph, 16), title), state(id)),
      h('label', { className: 'sm-field' }, h('span', null, '方式'), h('select', { value: config.mode, disabled: saving, onChange: (event: ChangeEvent<HTMLSelectElement>) => update(id, 'mode', event.currentTarget.value), 'data-testid': `settings-media-${id}-mode` }, options.map(([value, label]) => h('option', { key: value, value }, label)))),
      config.mode === 'http' ? httpFields(id) : null,
      id === 'tts' && draft.tts.mode === 'system' ? h('label', { className: 'sm-field' }, h('span', null, '声音'), h('select', { value: draft.tts.voice, disabled: saving, onChange: (event: ChangeEvent<HTMLSelectElement>) => update('tts', 'voice', event.currentTarget.value), 'data-testid': 'settings-media-tts-voice' }, h('option', { value: '' }, '系统默认'), (body?.voices ?? []).map((voice) => h('option', { key: voice.id, value: voice.id }, `${voice.name}${voice.language ? ` · ${voice.language}` : ''}`)))) : null,
      id === 'tts' && draft.tts.mode === 'http' ? input('tts', 'voice', '声音 ID', draft.tts.voice, { placeholder: '服务提供商的声音标识' }) : null,
      id === 'asr' && draft.asr.mode === 'whisper-cli' ? h('div', null, input('asr', 'binary', '可执行文件', draft.asr.binary, { placeholder: '/…/whisper-cli' }), input('asr', 'modelPath', '模型文件', draft.asr.modelPath, { placeholder: '/…/ggml-model.bin' })) : null,
      config.mode === 'http' ? h('p', { className: 'sm-service-hint' }, '使用兼容 OpenAI 格式的服务。保存不会发起生成或调用模型。') : id === 'tts' ? h('p', { className: 'sm-service-hint' }, '使用这台电脑已安装的声音，不调用在线配音服务。') : null);
  }
  return h('div', { className: 'settings-group settings-media-services', 'data-testid': 'settings-group-media', 'data-wired': body ? 'true' : 'false' },
    h('div', { className: 'sm-heading' }, h('div', null, h('h2', null, '配音与字幕服务'), h('p', null, '创作库与这里共用配置。聊天模型和媒体服务分别设置。')),
      h('button', { type: 'button', className: 'sm-refresh', onClick: () => void load(), disabled: loading || saving || dirty, title: dirty ? '先保存当前修改' : '重新读取配置', 'aria-label': '重新读取媒体配置' }, editorIcon('refresh', 16))),
    error ? h('div', { className: 'sm-notice is-error', role: 'alert' }, h('span', null, error), !draft ? h('button', { type: 'button', onClick: () => void load(), disabled: loading }, '重试') : null) : null,
    loading && !draft ? h('p', { className: 'sm-loading', role: 'status' }, '正在读取配置') : null,
    serviceCard('tts', '配音', 'microphone'), serviceCard('asr', '语音识别', 'subtitles'), serviceCard('translate', '字幕翻译', 'text'),
    draft ? h('div', { className: 'sm-save-row' }, h('span', { className: 'sm-save-note', role: 'status' }, note || (dirty ? '修改尚未保存' : '配置状态不代表已经执行生成任务')),
      h('button', { type: 'button', className: 'sm-save', onClick: () => void save(), disabled: !dirty || saving || loading, 'data-testid': 'settings-media-save' }, saving ? '保存中' : '保存配置')) : null,
    h('details', { className: 'sm-other-services' }, h('summary', null, '其它媒体能力'), MEDIA_TASKS.filter((task) => !['voice', 'subtitle'].includes(task.id)).map((task) => h('div', { className: 'sm-unavailable', key: task.id, 'data-testid': `settings-media-task-${task.id}`, 'data-provided': 'false' }, h('span', null, task.label), h('small', null, '本版未提供')))),
    h('details', { className: 'sm-other-services' }, h('summary', null, '配置位置'), h('p', { className: 'sm-service-hint' }, '以下仅显示既有约定位置，不读取凭据。'), h('code', { className: 'settings-path', 'data-testid': 'settings-media-providers-path' }, providers?.path ?? '—'), h('code', { className: 'settings-path', 'data-testid': 'settings-media-skills-path' }, skills?.path ?? '—')));
}
