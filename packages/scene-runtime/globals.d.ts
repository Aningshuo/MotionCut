/**
 * 场景运行器在浏览器 realm 注入的全局对象。
 * 仅供 host.mjs 的 page.evaluate 回调做类型标注，不产生运行时代码。
 */
export {};

declare global {
  interface Window {
    /** 场景作者契约（contracts/frame.ts SceneContract）。 */
    film: {
      meta?: { width: number; height: number; duration?: number };
      ready(): Promise<void>;
      frame(t: number): Promise<void>;
    };
    /** 宿主注入的受控时钟与 video 观察器（见 host.mjs installClock）。 */
    __filmHost: {
      clock: { now(): number; set(ms: number): void; pending(): number };
      version: number;
      time(t: number): number;
      settle(t: number): Promise<{ animations: number; virtualNow: number }>;
      state(): { t: number; animations: number; timers: number; videos: number };
      videoProbes?: any[];
    };
  }

  interface HTMLVideoElement {
    __filmProbe?: Record<string, unknown>;
  }
}
