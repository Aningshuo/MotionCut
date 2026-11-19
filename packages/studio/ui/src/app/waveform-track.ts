/**
 * 时间线波形（M34 · B-MAIN-R17-017）
 *
 * 峰值提取与绘制**全部**走副线1 冻结的 `packages/layers/waveform.mjs`
 * （`loadPeaks` / `drawWaveform` / `getWaveformCacheStats`），这里只做宿主侧接线：
 *
 * 1. 把 `clip.src` 换成**同源**的 `/api/projects/<id>/file?path=…`（内容 origin 不发 CORS，
 *    Studio 页面 fetch 不到素材；`project-file.mjs` 是那条只读通道）。
 * 2. 画在片段底部（38px 片高的 34% ≈ 10px），音量线叠在它上面（DOM 顺序）。
 * 3. **只在几何/音量/静音变化时重画**：播放、拖播放头、切选中都不重画（波形不会变），
 *    缩放（宽度变了）才重画——重画走的是 `loadPeaks` 的缓存，不重新解码。
 * 4. 缓存计数写进一个隐藏节点（`[data-testid="waveform-stats"]`），**不进 React state**：
 *    验收脚本读它证明「只有换 src 才解码」。
 *
 * 裁剪/变速的对齐：`clipStart/clipEnd` 直接用片段的源区间 `time`（`#t=in,out`）。
 * 变速只改变时间线上的宽度，不改源区间，所以同一套映射对变速同样成立。
 */

import { createElement, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

import { clearWaveformCache, drawWaveform, getWaveformCacheStats, isWaveformError, loadPeaks } from '../../../../layers/waveform.mjs';

/** 峰值密度：100 点/秒（200px 的片段也有 20 个桶）。 */
const SAMPLES_PER_SECOND = 100;
/** 设备像素比上限：波形是 1px 柱，3x 屏上再高只是白烧像素。 */
const MAX_DPR = 2;

/**
 * CSS 颜色 → `rgba(r, g, b, a)`。
 *
 * 为什么要自己解析（R23 / D59）：
 * 1. `--tl-wave` 的值是 `#fff6`（**4 位 hex**）。canvas 的 `fillStyle` 对 4/8 位 hex 的支持
 *    在各实现里不一致，而判据是「像素 == rgba(255,255,255,0.4)」，把解析交给浏览器就等于
 *    把判据交给浏览器；
 * 2. 变量可能是 `#ffffff52`、`rgb(...)`、`rgba(...)` 中的任意一种（主题换过就会变），
 *    统一归一成 rgba 再进 canvas。
 * 解析不出来时用 fallback（仍然是 token 的语义值），不抛错、不画错色。
 *
 * @param {string} value getComputedStyle(...).getPropertyValue('--tl-wave')
 * @param {string} fallback
 * @returns {string}
 */
export function resolveCssColor(value: string, fallback: string): string {
  const text = String(value ?? '').trim();
  if (text === '') return fallback;
  const clamp = (n: number, max: number) => Math.min(max, Math.max(0, n));
  const hex = /^#([0-9a-f]{3,8})$/i.exec(text);
  if (hex !== null) {
    const digits = hex[1] ?? '';
    const expand = (ch: string) => parseInt(ch + ch, 16);
    if (digits.length === 3 || digits.length === 4) {
      const r = expand(digits.charAt(0));
      const g = expand(digits.charAt(1));
      const b = expand(digits.charAt(2));
      const a = digits.length === 4 ? expand(digits.charAt(3)) / 255 : 1;
      return `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`;
    }
    if (digits.length === 6 || digits.length === 8) {
      const r = parseInt(digits.slice(0, 2), 16);
      const g = parseInt(digits.slice(2, 4), 16);
      const b = parseInt(digits.slice(4, 6), 16);
      const a = digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1;
      return `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`;
    }
    return fallback;
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (fn !== null) {
    const parts = (fn[1] ?? '').split(/[,/\s]+/).map((item) => item.trim()).filter((item) => item !== '');
    if (parts.length >= 3) {
      const num = (raw: string, max: number) => (raw.endsWith('%') ? (Number(raw.slice(0, -1)) / 100) * max : Number(raw));
      const r = clamp(Math.round(num(parts[0] ?? '', 255)), 255);
      const g = clamp(Math.round(num(parts[1] ?? '', 255)), 255);
      const b = clamp(Math.round(num(parts[2] ?? '', 255)), 255);
      const a = parts.length >= 4 ? clamp(num(parts[3] ?? '1', 1), 1) : 1;
      if ([r, g, b, a].every((n) => Number.isFinite(n))) {
        return `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`;
      }
    }
    return fallback;
  }
  return fallback;
}

/** 波形柱的兜底色 = `--tl-wave: #fff6` 的等价 rgba（变量读不到时才用）。 */
const WAVE_FALLBACK = 'rgba(255, 255, 255, 0.4)';

/** 已注册的统计节点（App 顶上挂一个 `<WaveformStats/>`）。 */
let statsNode: HTMLElement | null = null;
/**
 * 宿主侧重画次数（M36）：高度变化会重画波形，但**不重新解码**。
 * 副线1 的缓存统计只有 hits/misses/decodes，没有「画了几次」；这里自己数，
 * 验收就能给「decodes 不变、redraws 增长」两个数。
 */
let redraws = 0;

/**
 * `clip.src` → 同源取字节的 URL。
 *
 * - 去掉 `#t=in,out`（那是方言里的源区间，不是 URL 的一部分）；
 * - `http(s):` / `data:` 一律不画：前者跨源（内容 origin 不发 CORS），后者没有文件可读；
 * - 其余按工程相对路径拼到只读出口上。
 *
 * @param {string} fileBase 形如 `/api/projects/<id>/file`
 * @param {string} src
 */
export function waveformUrlOf(fileBase: string, src: string): string {
  const bare = String(src ?? '').split('#')[0] ?? '';
  if (bare === '' || fileBase === '') return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(bare)) return '';
  return `${fileBase}?path=${encodeURIComponent(bare)}`;
}

function publishStats(): void {
  if (statsNode === null) return;
  const stats = getWaveformCacheStats();
  statsNode.setAttribute('data-hits', String(stats.hits));
  statsNode.setAttribute('data-misses', String(stats.misses));
  statsNode.setAttribute('data-decodes', String(stats.decodes));
  statsNode.setAttribute('data-entries', String(stats.entries));
  statsNode.setAttribute('data-bytes', String(stats.bytes));
  statsNode.setAttribute('data-errors', String(stats.errors));
  statsNode.setAttribute('data-redraws', String(redraws));
}

/**
 * 换工程时清缓存（副线1 的 `clearWaveformCache`）。
 *
 * 缓存键是 `(samplesPerSecond, url)`，URL 里带 projectId，所以不会串工程；清它只为
 * 两点：① 换工程后不把上一个工程的峰值一直挂在内存里；② 同一工程里素材被外部替换时，
 * 至少「换回来」能看到新波形。**不**在每次 `/ops` 之后清——那样每次编辑都会重新解码。
 */
export function resetWaveformCache(): void {
  clearWaveformCache();
  redraws = 0;
  publishStats();
}

/** 隐藏的统计节点：读缓存计数不必碰 React 状态。 */export function WaveformStats(): ReactNode {
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    statsNode = ref.current;
    publishStats();
    return () => {
      if (statsNode === ref.current) statsNode = null;
    };
  }, []);
  return createElement('span', { ref, 'data-testid': 'waveform-stats', hidden: true });
}

export interface WaveformLayerProps {
  /** 同源 URL（`/api/projects/<id>/file?path=…`）；空串 = 没有可用地址，不画。 */
  url: string;
  /** 裸 src（`#t=` 之前那段），只用于 title / data-*。 */
  src: string;
  /** 画布宽（CSS px，= 片段内宽）。 */
  width: number;
  /** 画布高（CSS px）。 */
  height: number;
  volume: number;
  muted: boolean;
  clipStart: number;
  clipEnd: number;
}

/**
 * 一块波形画布。
 *
 * 重画条件用「签名」判定：`url|w|h|volume|muted|start|end|dpr` 任一变化才重画。
 * 播放/选中/滚动都不改这些值，所以那三种操作**一次都不重画**。
 */
export function WaveformLayer(props: WaveformLayerProps): ReactNode {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const drawnRef = useRef<string>('');

  const { url, src, width, height, volume, muted, clipStart, clipEnd } = props;

  useEffect(() => {
    const canvas = ref.current;
    if (canvas === null) return undefined;
    if (url === '' || width < 2 || height < 2) {
      drawnRef.current = '';
      return undefined;
    }
    const dpr = Math.min(MAX_DPR, Math.max(1, window.devicePixelRatio || 1));
    /* 颜色也进签名：换主题（`--tl-wave` 变了）要重画，否则画布留着旧主题的像素。 */
    const waveColor = resolveCssColor(getComputedStyle(canvas).getPropertyValue('--tl-wave'), WAVE_FALLBACK);
    const signature = `${url}|${width}|${height}|${volume}|${muted ? 1 : 0}|${clipStart}|${clipEnd}|${dpr}|${waveColor}`;
    if (drawnRef.current === signature) return undefined;
    drawnRef.current = signature;

    let cancelled = false;
    canvas.setAttribute('data-waveform-state', 'loading');
    redraws += 1;
    // 画布尺寸在这里定（不在 render 里）：宽高变了要先改 backing store，再画。
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    void loadPeaks(url, { samplesPerSecond: SAMPLES_PER_SECOND })
      .then((peaks) => {
        if (cancelled) return;
        const ctx = canvas.getContext('2d');
        if (ctx === null) return;
        const summary = drawWaveform(ctx, peaks, {
          width,
          height,
          dpr,
          volume,
          muted,
          clipStart,
          clipEnd,
          /* R23 / D59：不再写死蓝调 —— 直接吃 `--tl-wave`（`#fff6` → rgba(255,255,255,0.4)）。 */
          color: waveColor,
          overflowColor: '#f87171',
        });
        const failed = isWaveformError(peaks);
        canvas.setAttribute('data-waveform-state', failed ? 'placeholder' : summary.silent ? 'silent' : 'ok');
        canvas.setAttribute('data-waveform-code', failed ? String(peaks.code) : '');
        canvas.setAttribute('data-waveform-columns', String(summary.columns));
        canvas.setAttribute('data-overflow-columns', String(summary.overflowColumns));
        canvas.setAttribute('data-peak-abs', String(Number(summary.peakAbs.toFixed(4))));
        publishStats();
      })
      .catch((error) => {
        if (cancelled) return;
        canvas.setAttribute('data-waveform-state', 'placeholder');
        canvas.setAttribute('data-waveform-code', String(error?.code ?? 'DECODE_FAILED'));
        publishStats();
      });

    return () => {
      cancelled = true;
    };
  }, [url, width, height, volume, muted, clipStart, clipEnd]);

  return createElement('canvas', {
    ref,
    className: 'tl-clip-wave',
    'data-testid': 'clip-waveform',
    'data-src': src,
    'data-clip-start': String(clipStart),
    'data-clip-end': String(clipEnd),
    style: { width: `${width}px`, height: `${height}px` },
  });
}
