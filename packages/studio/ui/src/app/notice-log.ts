/**
 * 提示/错误诊断日志（只存本机 localStorage，不发请求）。
 *
 * 为什么单独放一个模块：剪辑区顶部不应常驻错误条（会挡画面），
 * 但错误又不能丢——统一记到这里，由「设置 → 诊断」列出时间与文案，
 * 用户可据此回溯“什么时间报的什么错”。
 */

export type NoticeEntry = {
  /** ISO 时间戳（本地时区） */
  at: string;
  level: 'info' | 'error';
  text: string;
  guardCode?: string;
};

const KEY = 'opencut.notice-log.v1';
const LIMIT = 100;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readNoticeLog(): NoticeEntry[] {
  const store = storage();
  if (store === null) return [];
  try {
    const raw = store.getItem(KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is NoticeEntry =>
      typeof item === 'object' && item !== null
      && typeof (item as NoticeEntry).at === 'string'
      && typeof (item as NoticeEntry).text === 'string'
      && ((item as NoticeEntry).level === 'info' || (item as NoticeEntry).level === 'error'),
    );
  } catch {
    return [];
  }
}

/** 追加一条；同一文案 3 秒内重复只记一次（避免连点刷屏）。 */
export function recordNotice(entry: Omit<NoticeEntry, 'at'>): NoticeEntry[] {
  const store = storage();
  const now = Date.now();
  const at = new Date(now).toISOString();
  const list = readNoticeLog();
  const last = list[list.length - 1];
  const tooSoon = last !== undefined
    && last.text === entry.text
    && now - Date.parse(last.at) < 3000;
  const next = tooSoon ? list : [...list, { ...entry, at }].slice(-LIMIT);
  if (store !== null && !tooSoon) {
    try { store.setItem(KEY, JSON.stringify(next)); } catch { /* 配额满时静默 */ }
  }
  return next;
}

export function clearNoticeLog(): void {
  const store = storage();
  try { store?.removeItem(KEY); } catch { /* ignore */ }
}

/** `2026-11-18 11:08:42`，给设置面板显示 */
export function formatNoticeTime(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
