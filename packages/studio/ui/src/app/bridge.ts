/**
 * 渲染层与宿主之间那一层 `window.opencut`。
 *
 * 两种来源：
 * - **Electron**：`apps/desktop/src/preload.cjs` 用 contextBridge 暴露具名方法（`transport: 'electron'`）；
 * - **浏览器**（Studio 静态页 / Vite / Playwright）：本文件装一个**同形状的最小桥**
 *   （`transport: 'browser'`），内部只用 fetch / WebSocket，不碰文件系统。
 *
 * 页面代码只认具名方法：不直接读 Node 全局，也不直接碰 preload 的 IPC 通道。
 */

export type Transport = 'electron' | 'browser';

export interface OpenDialogResult {
  canceled: boolean;
  path?: string;
  code?: string;
}

export interface OpencutBridge {
  transport?: Transport;
  health?: () => Promise<unknown>;
  openProjectDialog?: () => Promise<OpenDialogResult>;
  /** 导出工程包（M59）：Electron 走系统保存框；浏览器没有，回 `ELECTRON_ONLY`。 */
  pickArchiveSave?: (defaultName?: string) => Promise<OpenDialogResult>;
  /** 导入工程包（M59）：同上，只要绝对路径。 */
  pickArchiveOpen?: () => Promise<OpenDialogResult>;
}

export interface Probe {
  require: string;
  process: string;
  opencut: string[] | null;
  transport: Transport;
  href: string;
}

function globalObject(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

/** 浏览器里补一个同形状的桥；Electron 已经装好时不动它。 */
export function installBridge(): Transport {
  const scope = globalObject();
  const existing = scope.opencut as OpencutBridge | undefined;
  if (existing !== undefined && existing !== null) {
    return existing.transport === 'electron' ? 'electron' : 'browser';
  }
  const bridge: OpencutBridge = Object.freeze({
    transport: 'browser',
    async health() {
      const response = await fetch('/healthz', { cache: 'no-store' });
      if (!response.ok) return { ok: false, code: `HTTP_${response.status}` };
      return response.json();
    },
    async openProjectDialog(): Promise<OpenDialogResult> {
      // 浏览器没有系统目录选择器：不假装能开，直接说清楚。
      return { canceled: true, code: 'ELECTRON_ONLY' };
    },
    async pickArchiveSave(): Promise<OpenDialogResult> {
      return { canceled: true, code: 'ELECTRON_ONLY' };
    },
    async pickArchiveOpen(): Promise<OpenDialogResult> {
      return { canceled: true, code: 'ELECTRON_ONLY' };
    },
  });
  Object.defineProperty(scope, 'opencut', {
    value: bridge,
    enumerable: true,
    configurable: true,
    writable: false,
  });
  return 'browser';
}

export function transport(): Transport {
  const bridge = globalObject().opencut as OpencutBridge | undefined;
  return bridge?.transport === 'electron' ? 'electron' : 'browser';
}

/** 页面探针：验收 A5 直接读它（无 Node 全局、桥存在、宿主类型）。 */
export function installProbe(): Probe {
  const scope = globalObject();
  const bridge = scope.opencut as OpencutBridge | undefined;
  const probe: Probe = {
    require: typeof scope.require,
    process: typeof scope.process,
    opencut: bridge === undefined ? null : Object.keys(bridge).sort(),
    transport: transport(),
    href: location.href,
  };
  scope.__opencutProbe = probe;
  return probe;
}
