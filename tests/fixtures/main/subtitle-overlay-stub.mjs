/* 字幕渲染 **stub**（20 行）：贴到 getStage() 区域 + 显示当前 cue 文本，只验接线，不是真渲染。真实组件见 packages/layers/subtitle-overlay.mjs。 */
/** @param {HTMLElement} container @param {{ getCues: () => any[], getTime: () => number, getStage?: () => {x: number, y: number, w: number, h: number}, style?: any, onError?: (info: {code: string, message: string}) => void }} options */
export function mountSubtitleOverlay(container, options) {
  const node = document.createElement('div'); node.dataset.subtitleOverlay = '1';
  node.style.cssText = 'position:fixed;pointer-events:none;z-index:30;display:none;align-items:flex-end;justify-content:center;padding-bottom:2%;box-sizing:border-box;';
  const text = document.createElement('div'); text.style.cssText = 'max-width:80%;padding:2px 10px;border-radius:4px;background:rgba(0,0,0,.55);color:#fff;font:500 20px/1.4 system-ui,sans-serif;white-space:pre-wrap;text-align:center;';
  node.appendChild(text); container.appendChild(node);
  /** @param {number} t */
  const render = (t) => { try {
      const stage = options.getStage?.();
      if (stage) Object.assign(node.style, { left: `${stage.x}px`, top: `${stage.y}px`, width: `${stage.w}px`, height: `${stage.h}px` });
      const cue = /** @type {any[]} */ (options.getCues() ?? []).find((item) => t >= item.start && t < item.end);
      text.textContent = cue === undefined ? '' : String(cue.text);
      node.style.display = cue === undefined ? 'none' : 'flex';
    } catch (error) {
      options.onError?.({ code: 'SUBTITLE_RENDER_FAILED', message: String(/** @type {any} */ (error)?.message ?? error) });
    }
  };
  render(options.getTime()); return { render, destroy: () => node.remove() };
}
