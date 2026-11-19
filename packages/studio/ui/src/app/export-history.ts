/**
 * 导出历史（M29）——**只写 UI 侧**。
 *
 * 任务书明确：历史只准放 localStorage / IndexedDB，**不在工程目录新增 json**。
 * 理由不只是「少一个文件」：`film.html` + `.film/` 是合同的写入面，历史属于
 * 使用记录而不是影片内容，混进去会让协作方看到跟片子无关的状态。
 *
 * 存的东西按任务书：开始/结束时间、预设、尺寸、帧数、耗时、产物路径、状态、错误码。
 * 上限 50 条（够回看最近一天的活），超出丢最旧的。
 */

import type { ExportHistoryItem, ExportJobView } from './types';

const KEY = 'opencut.exportHistory.v1';
const LIMIT = 50;

/** @returns {boolean} 有没有可用的 localStorage（浏览器里正常有；单测/无 DOM 时没有）。 */
function hasStorage(): boolean {
  try {
    return typeof globalThis.localStorage !== 'undefined' && globalThis.localStorage !== null;
  } catch {
    return false;
  }
}

/** 读历史：坏数据不炸，直接当空。 */
export function loadHistory(): ExportHistoryItem[] {
  if (!hasStorage()) return [];
  try {
    const raw = globalThis.localStorage.getItem(KEY);
    if (raw === null || raw === '') return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is ExportHistoryItem => {
      const value = item as Partial<ExportHistoryItem> | null;
      return value !== null && typeof value === 'object' && typeof value.id === 'string' && typeof value.state === 'string';
    });
  } catch {
    return [];
  }
}

/** 整体写回（顺序即展示顺序）。 */
function save(items: ExportHistoryItem[]): ExportHistoryItem[] {
  if (!hasStorage()) return items;
  try {
    globalThis.localStorage.setItem(KEY, JSON.stringify(items.slice(0, LIMIT)));
  } catch {
    /* 配额满/隐私模式：历史丢就丢了，不能影响导出本身 */
  }
  return items.slice(0, LIMIT);
}

/**
 * 记一条：同 id 覆盖（轮询会重复看到同一个终态快照），新的在最前。
 * @param {ExportHistoryItem} item
 */
export function recordHistory(item: ExportHistoryItem): ExportHistoryItem[] {
  const previous = loadHistory().filter((entry) => entry.id !== item.id);
  return save([item, ...previous]);
}

/**
 * 服务端的作业快照 → 一条历史。
 * @param {ExportJobView} job
 * @param {string} projectName
 * @returns {ExportHistoryItem|null} 非终态返回 null（只有终态才配进历史）
 */
export function historyFromJob(job: ExportJobView, projectName: string): ExportHistoryItem | null {
  if (job.state !== 'done' && job.state !== 'failed' && job.state !== 'cancelled') return null;
  const startedAt = job.startedAt ?? job.queuedAt ?? '';
  const finishedAt = job.finishedAt ?? '';
  const startedMs = Date.parse(startedAt);
  const finishedMs = Date.parse(finishedAt);
  return {
    id: job.id,
    projectId: job.projectId,
    projectName,
    startedAt,
    finishedAt,
    quality: job.quality ?? 'standard',
    // 编码（M50）：老客户端/老作业没有这个字段，写空串而不是猜一个 h264。
    codec: job.codec ?? '',
    range: job.range === null || job.range === undefined ? 'all' : `${job.range[0]}-${job.range[1]}`,
    frames: Number(job.frames) || 0,
    framesTotal: Number(job.framesTotal) || 0,
    durationSec: typeof job.output?.durationSec === 'number' ? job.output.durationSec : null,
    path: job.output?.path ?? null,
    bytes: typeof job.output?.bytes === 'number' ? job.output.bytes : null,
    // 记录**成片尺寸**（M42）：选了竖屏/信息流之后，历史里写「舞台 1280×720」会误导。
    // 老作业（M42 之前）没有 outputSize，退回 stageSize。
    size: (() => {
      const output = job.outputSize ?? null;
      if (output !== null && Number(output.w) > 0 && Number(output.h) > 0) return `${output.w}x${output.h}`;
      return job.stageSize === null || job.stageSize === undefined ? '' : `${job.stageSize.w}x${job.stageSize.h}`;
    })(),
    elapsedMs: Number.isFinite(startedMs) && Number.isFinite(finishedMs) ? Math.max(0, finishedMs - startedMs) : 0,
    state: job.state,
    errorCode: job.error?.code ?? null,
    errorMessage: job.error?.message ?? null,
  };
}

/** 清空（面板上的「清空历史」）。 */
export function clearHistory(): ExportHistoryItem[] {
  if (!hasStorage()) return [];
  try {
    globalThis.localStorage.removeItem(KEY);
  } catch {
    /* 同上：清理失败不影响别的 */
  }
  return [];
}
