/**
 * 实时电平表（M32 · B-MAIN-R16-016）。
 *
 * 数据来自舞台：音频图的总线后面挂着 L/R 两个分析节点，舞台按 20–30Hz 把
 * `{peakL, peakR, rmsL, rmsR}` postMessage 过来（见 content-origin.mjs 的 sampleLevels）。
 * 这里**只画**，不参与混音，也不 setState——25Hz 的 setState 会把整棵树重渲染，
 * 代价（M32-B5）直接超预算。
 *
 * 为什么电平是「实际混音」而不是原始文件峰值：取样点在总线上，链路上依次乘过
 * 片段 volume、淡变包络、走带主音量。静音片段自然平线，不用 UI 去猜。
 */

import { createElement, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

const h = createElement;

/** 电平表的量程（dBFS）。 */
export const METER_FLOOR_DB = -60;

/** 峰值保持时长（任务书：约 800ms）。 */
export const PEAK_HOLD_MS = 800;

export interface LevelSample {
  peakL: number;
  peakR: number;
  rmsL: number;
  rmsR: number;
  t: number;
  playing: boolean;
  /** 音频图是否真的挂上了（false = 浏览器没有 WebAudio，只有元素音量）。 */
  routed?: boolean;
}

type Listener = (sample: LevelSample | null) => void;

const listeners = new Set<Listener>();
/** 最近一次采样：组件挂载时先画这一帧，不用等下一个消息。 */
let latest: LevelSample | null = null;

/** 舞台 → 电平表。null = 没有数据（停播/换片）。 */
export function publishLevels(sample: LevelSample | null): void {
  if (sample === null && latest === null) return;
  latest = sample;
  for (const listener of listeners) listener(sample);
}

export function currentLevels(): LevelSample | null {
  return latest;
}

/** 订阅（返回退订）。挂载时立刻回放最近一次采样。 */
export function subscribeLevels(listener: Listener): () => void {
  listeners.add(listener);
  listener(latest);
  return () => {
    listeners.delete(listener);
  };
}

/** 测试与切工程用：清掉残留读数。 */
export function resetLevels(): void {
  latest = null;
}

/** 线性峰值 → dBFS（0 给 −Infinity，画的时候再夹到量程）。 */
export function dbOf(peak: number): number {
  const value = Number(peak);
  if (!Number.isFinite(value) || value <= 0) return Number.NEGATIVE_INFINITY;
  return 20 * Math.log10(value);
}

/** dBFS → 0…1 的横向位置（−60dB 在最左，0dB 在最右）。 */
export function levelRatio(db: number): number {
  if (!Number.isFinite(db)) return 0;
  const clamped = Math.max(METER_FLOOR_DB, Math.min(0, db));
  return (clamped - METER_FLOOR_DB) / -METER_FLOOR_DB;
}

export interface LevelMeterProps {
  /** 工程里有没有声音片段（false → 显示「无音轨」，不用一条平线冒充）。 */
  hasAudio: boolean;
  /** 走带是否在播（暂停时归零）。 */
  playing: boolean;
}

interface MeterState {
  peakL: number;
  peakR: number;
  holdL: number;
  holdR: number;
  holdAtL: number;
  holdAtR: number;
  /** 削波红框的到期时间（闪一次就撤）。 */
  clipUntil: number;
  routed: boolean;
  lastSampleAt: number;
  status: string;
}

/**
 * L/R 电平条。canvas 只画两条柱 + 峰值保持刻线；读数同时写进 DOM 属性，
 * 验收脚本读属性，不看像素（截图只做「看得见」的旁证）。
 */
export function LevelMeter(props: LevelMeterProps): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<MeterState>({
    peakL: 0,
    peakR: 0,
    holdL: 0,
    holdR: 0,
    holdAtL: 0,
    holdAtR: 0,
    clipUntil: 0,
    routed: true,
    lastSampleAt: 0,
    status: '',
  });
  const playingRef = useRef(props.playing);
  playingRef.current = props.playing;
  const hasAudioRef = useRef(props.hasAudio);
  hasAudioRef.current = props.hasAudio;

  useEffect(() => {
    let raf = 0;
    let stopped = false;

    const draw = (): void => {
      const canvas = canvasRef.current;
      const root = rootRef.current;
      const state = stateRef.current;
      if (canvas === null || root === null) return;
      const dpr = Math.max(1, Math.min(3, globalThis.devicePixelRatio || 1));
      const cssW = 96;
      const cssH = 22;
      if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
        canvas.style.width = `${cssW}px`;
        canvas.style.height = `${cssH}px`;
      }
      const ctx = canvas.getContext('2d');
      if (ctx === null) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      // 背板
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(0, 0, cssW, cssH);

      const barX = 14;
      const barW = cssW - barX - 3;
      const rowH = 7;
      const rows = [
        { y: 3, peak: state.peakL, hold: state.holdL, holdAt: state.holdAtL },
        { y: 12, peak: state.peakR, hold: state.holdR, holdAt: state.holdAtR },
      ];
      for (const [index, row] of rows.entries()) {
        ctx.fillStyle = 'rgba(255,255,255,0.10)';
        ctx.fillRect(barX, row.y, barW, rowH);
        const db = dbOf(row.peak);
        const width = Math.round(barW * levelRatio(db));
        if (width > 0) {
          const gradient = ctx.createLinearGradient(barX, 0, barX + barW, 0);
          gradient.addColorStop(0, '#3ddc84');
          gradient.addColorStop(0.72, '#d8d64a');
          gradient.addColorStop(0.92, '#e8683c');
          gradient.addColorStop(1, '#ff3b30');
          ctx.fillStyle = gradient;
          ctx.fillRect(barX, row.y, width, rowH);
        }
        // 峰值保持：一根 1.5px 的刻线，800ms 后开始跟着当前峰值回落。
        const holdRatio = levelRatio(dbOf(row.hold));
        if (holdRatio > 0) {
          const x = barX + Math.min(barW - 1.5, Math.max(0, barW * holdRatio - 1.5));
          ctx.fillStyle = dbOf(row.hold) >= -0.1 ? '#ff3b30' : 'rgba(255,255,255,0.85)';
          ctx.fillRect(x, row.y, 1.5, rowH);
        }
        // L / R 标签
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.font = '8px ui-monospace, Menlo, monospace';
        ctx.fillText(index === 0 ? 'L' : 'R', 3, row.y + rowH - 0.5);
        // −60/0 刻度只画一次（第一行下方）
        if (index === 1) {
          ctx.fillStyle = 'rgba(255,255,255,0.28)';
          ctx.fillRect(barX, 20.5, 1, 1.5);
          ctx.fillRect(barX + barW - 1, 20.5, 1, 1.5);
        }
      }
    };

    const paint = (): void => {
      raf = 0;
      const state = stateRef.current;
      const canvas = canvasRef.current;
      const root = rootRef.current;
      if (canvas === null || root === null) return;
      draw();
      const now = performance.now();
      // 峰值保持到期后跟着当前值走（不是直接清零，避免刻线跳变）。
      if (now - state.holdAtL > PEAK_HOLD_MS) state.holdL = state.peakL;
      if (now - state.holdAtR > PEAK_HOLD_MS) state.holdR = state.peakR;
      const clip = now < state.clipUntil;
      const peakDb = Math.max(dbOf(state.peakL), dbOf(state.peakR));
      const holdDb = Math.max(dbOf(state.holdL), dbOf(state.holdR));
      const status = !hasAudioRef.current
        ? 'no-audio'
        : !state.routed
          ? 'unrouted'
          : !playingRef.current
            ? 'paused'
            : 'live';
      if (status !== state.status) {
        state.status = status;
        root.setAttribute('data-status', status);
      }
      root.setAttribute('data-clip', clip ? '1' : '0');
      root.setAttribute('data-peak-db', Number.isFinite(peakDb) ? peakDb.toFixed(1) : '-inf');
      root.setAttribute('data-hold-db', Number.isFinite(holdDb) ? holdDb.toFixed(1) : '-inf');
      root.setAttribute('data-peak-l', Number.isFinite(dbOf(state.peakL)) ? dbOf(state.peakL).toFixed(1) : '-inf');
      root.setAttribute('data-peak-r', Number.isFinite(dbOf(state.peakR)) ? dbOf(state.peakR).toFixed(1) : '-inf');
      root.setAttribute('data-hold-l', Number.isFinite(dbOf(state.holdL)) ? dbOf(state.holdL).toFixed(1) : '-inf');
      root.setAttribute('data-hold-r', Number.isFinite(dbOf(state.holdR)) ? dbOf(state.holdR).toFixed(1) : '-inf');
      if (clip !== root.classList.contains('clipping')) root.classList.toggle('clipping', clip);

      // 没有新样本就停 rAF：静止时不烧主线程（B5 的预算要留给播放本身）。
      if (performance.now() - state.lastSampleAt < 400) {
        raf = requestAnimationFrame(paint);
      }
    };

    const wake = (): void => {
      if (stopped || raf !== 0) return;
      raf = requestAnimationFrame(paint);
    };

    const off = subscribeLevels((sample) => {
      const state = stateRef.current;
      const now = performance.now();
      if (sample === null) {
        state.peakL = 0;
        state.peakR = 0;
        state.holdL = 0;
        state.holdR = 0;
        state.holdAtL = 0;
        state.holdAtR = 0;
        state.lastSampleAt = 0;
        // 削波红框也要撤：否则停播后 red 会一直挂着（采样停了，没人再更新它）。
        state.clipUntil = 0;
        wake();
        return;
      }
      state.routed = sample.routed !== false;
      state.peakL = Math.max(0, Number(sample.peakL) || 0);
      state.peakR = Math.max(0, Number(sample.peakR) || 0);
      state.lastSampleAt = now;
      // 峰值保持：只有真的更高才刷新，否则等到期后跟随当前值。
      if (state.peakL >= state.holdL) {
        state.holdL = state.peakL;
        state.holdAtL = now;
      }
      if (state.peakR >= state.holdR) {
        state.holdR = state.peakR;
        state.holdAtR = now;
      }
      // ≥0dBFS：红一次（续期写法，削波期间持续红，但每次越界只算一次「闪」）。
      if (state.peakL >= 1 || state.peakR >= 1) state.clipUntil = now + 220;
      wake();
    });

    wake();
    return () => {
      stopped = true;
      off();
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, []);

  // 暂停 → 立刻归零（舞台也会发一条零值，这里兜住「舞台没来得及发」的情况）。
  useEffect(() => {
    if (props.playing) return;
    const state = stateRef.current;
    state.peakL = 0;
    state.peakR = 0;
    state.holdL = 0;
    state.holdR = 0;
    state.holdAtL = 0;
    state.holdAtR = 0;
    state.clipUntil = 0;
    const root = rootRef.current;
    if (root !== null) {
      root.setAttribute('data-peak-db', '-inf');
      root.setAttribute('data-hold-db', '-inf');
      root.setAttribute('data-peak-l', '-inf');
      root.setAttribute('data-peak-r', '-inf');
      root.setAttribute('data-hold-l', '-inf');
      root.setAttribute('data-hold-r', '-inf');
      root.setAttribute('data-clip', '0');
      root.classList.remove('clipping');
    }
  }, [props.playing]);

  return h(
    'div',
    {
      className: 'level-meter',
      'data-testid': 'level-meter',
      'data-has-audio': props.hasAudio ? 'true' : 'false',
      'data-status': props.hasAudio ? 'paused' : 'no-audio',
      title: props.hasAudio
        ? '实际混音电平（volume × 淡变 × 主音量），峰值保持 800ms；到 0dBFS 会标红'
        : '这个工程没有声音片段（<audio>），所以没有电平',
      ref: rootRef,
    },
    h('canvas', { ref: canvasRef, 'aria-hidden': 'true' }),
    props.hasAudio ? null : h('span', { className: 'level-meter-note' }, '无音轨'),
  );
}
