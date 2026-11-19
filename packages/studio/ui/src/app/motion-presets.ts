// @ts-nocheck —— 预设表是数据驱动的（at(p) 的键由 props 声明），逐点标 any 只会淹没语义。
/**
 * E12-P4 · 动效三槽（入场 / 循环 / 出场）—— **预设即 kf**，不新增格式。
 *
 * 这里只有纯函数：把「选中了哪几个预设 + 时长 + 延迟」算成一串 `OverrideEntry.kf`，
 * 再交给 App 走既有 `overrides` Op 写盘。没有 React、没有 DOM、没有网络，
 * 所以可以单测（`motion-presets.test.mjs`）。
 *
 * ## 为什么是 kf 而不是新机制
 *
 * E05 的关键帧已经同时被预览（`scene-runtime` 写 `--motion-t`）与导出
 * （`content-origin` 的 `STAGE_RUNTIME`）消费，K01–K05 全绿。再发明一种
 * 「动效描述」就得把那条确定性链重做一遍 —— 这个面板只负责**生成** `kf`。
 *
 * ## 时长 / 延迟怎么落到 kf
 *
 * `kf` 的 `t` 是**相对片段起点**的秒，`animation-delay` 已被 `--motion-t` 占用，
 * 所以「延迟」不能写成 CSS delay —— 只能在 `t=0..L` 之间**保持首帧值**：
 *
 * ```
 * 入场：t=0（首值）· t=L（仍是首值，这段是延迟）· t=L+D（末值）
 * 循环：t=L … t=L+D（波形，首尾同值）
 * 出场：t=片段时长−L−D … t=片段时长−L（末值落在片段结束前 L 秒）
 * ```
 *
 * ## 合成（出场 > 循环 > 入场）
 *
 * 判据要求「同一元素多槽叠加」，而一条 `kf` 只能有一个属性值序列。做法是：
 * 取所有槽的边界时间 + 波形采样点的并集，逐时间点按优先级求每个属性的值，
 * 再输出**属性集一致**的帧（`KF_PROPS_MISMATCH` 要求每帧属性集相同）。
 * 两个槽的时间区间重叠时按优先级取值，并回报 `conflicts` 给界面提示。
 */

/** 槽 id（顺序即界面顺序）。 */
export const MOTION_SLOTS = Object.freeze(['in', 'loop', 'out']);

/** 槽的中文名。 */
export const MOTION_SLOT_LABELS = Object.freeze({ in: '入场', loop: '循环', out: '出场' });

/**
 * 合成优先级（高 → 低）：出场压循环，循环压入场。
 * 与派单口径一致，改这里等于改产品行为。
 */
export const MOTION_PRIORITY = Object.freeze(['out', 'loop', 'in']);

/** 时长 / 延迟的合法区间（秒）。 */
export const MOTION_LIMITS = Object.freeze({
  duration: { min: 0.2, max: 3 },
  delay: { min: 0, max: 2 },
});

/** 各属性的「基值」：没有槽在动它时用它。 */
const BASE_VALUE = Object.freeze({
  opacity: '1',
  translate: '0 0px',
  scale: '1',
  rotate: '0deg',
  filter: 'brightness(1)',
});

const num = (value) => {
  const text = Number(value).toFixed(3);
  return text.replace(/\.?0+$/, '') || '0';
};

/** 正弦波形（循环槽）：0 → 1 → 0。 */
const wave = (progress) => Math.sin(Math.PI * progress);

/**
 * 预设表。`at(progress)` 返回这一帧的样式；`props` 必须与 `at` 的键一致
 * （由单测守：`Object.keys(at(0))` 与 `props` 相同）。
 *
 * 值一律用 `px` / 无单位数字 / 函数式 filter —— `INTERPOLABLE_PROPERTIES` 收的写法。
 */
export const MOTION_PRESETS = Object.freeze({
  in: Object.freeze([
    { id: 'fade', label: '淡入', props: ['opacity'], at: (p) => ({ opacity: num(p) }) },
    {
      id: 'rise',
      label: '上移',
      props: ['opacity', 'translate'],
      at: (p) => ({ opacity: num(Math.min(1, p * 1.2)), translate: `0 ${num((1 - p) * 24)}px` }),
    },
    {
      id: 'zoom',
      label: '缩放',
      props: ['opacity', 'scale'],
      at: (p) => ({ opacity: num(p), scale: num(0.92 + 0.08 * p) }),
    },
    {
      id: 'flash',
      label: '闪光',
      props: ['opacity', 'filter'],
      at: (p) => ({ opacity: num(p), filter: `brightness(${num(2 - p)})` }),
    },
  ]),
  loop: Object.freeze([
    { id: 'breathe', label: '呼吸', props: ['opacity'], at: (p) => ({ opacity: num(1 - 0.45 * wave(p)) }) },
    { id: 'pulse', label: '脉冲', props: ['scale'], at: (p) => ({ scale: num(1 + 0.06 * wave(p)) }) },
    { id: 'sway', label: '摇摆', props: ['rotate'], at: (p) => ({ rotate: `${num(2 * Math.sin(2 * Math.PI * p))}deg` }) },
  ]),
  out: Object.freeze([
    { id: 'fadeout', label: '淡出', props: ['opacity'], at: (p) => ({ opacity: num(1 - p) }) },
    {
      id: 'drop',
      label: '下移',
      props: ['opacity', 'translate'],
      at: (p) => ({ opacity: num(1 - p), translate: `0 ${num(24 * p)}px` }),
    },
    {
      id: 'shrink',
      label: '缩小',
      props: ['opacity', 'scale'],
      at: (p) => ({ opacity: num(1 - p), scale: num(1 - 0.08 * p) }),
    },
  ]),
});

/** @param {string} slot @param {string} presetId */
export function findPreset(slot, presetId) {
  const list = MOTION_PRESETS[slot] ?? [];
  return list.find((preset) => preset.id === presetId) ?? null;
}

/**
 * 校验一个槽的时长/延迟。返回稳定错误码（界面直接显示 code）。
 * @param {{duration: number, delay: number}} input
 */
export function validateTiming(input) {
  const duration = Number(input?.duration);
  const delay = Number(input?.delay);
  if (!Number.isFinite(duration)) return { ok: false, code: 'MOTION_DURATION_INVALID', message: `时长必须是数字：${String(input?.duration)}` };
  if (duration < MOTION_LIMITS.duration.min || duration > MOTION_LIMITS.duration.max) {
    return {
      ok: false,
      code: 'MOTION_DURATION_INVALID',
      message: `时长必须在 ${MOTION_LIMITS.duration.min}–${MOTION_LIMITS.duration.max}s：${duration}`,
    };
  }
  if (!Number.isFinite(delay)) return { ok: false, code: 'MOTION_DELAY_INVALID', message: `延迟必须是数字：${String(input?.delay)}` };
  if (delay < MOTION_LIMITS.delay.min || delay > MOTION_LIMITS.delay.max) {
    return { ok: false, code: 'MOTION_DELAY_INVALID', message: `延迟必须在 ${MOTION_LIMITS.delay.min}–${MOTION_LIMITS.delay.max}s：${delay}` };
  }
  return { ok: true, duration, delay };
}

/**
 * 一个槽在片段时间轴上的区间。
 * @param {'in'|'loop'|'out'} slot
 * @param {{duration: number, delay: number, clipDuration: number}} timing
 */
export function spanOf(slot, timing) {
  const { duration, delay, clipDuration } = timing;
  if (slot === 'in') return { start: 0, end: delay + duration };
  if (slot === 'loop') return { start: delay, end: delay + duration };
  const end = Math.max(0, clipDuration - delay);
  return { start: Math.max(0, end - duration), end };
}

/**
 * 单槽 → 帧（含延迟保持段；循环槽多采几个点，正弦才像波形）。
 * @param {'in'|'loop'|'out'} slot
 * @param {any} preset
 * @param {{duration: number, delay: number, clipDuration: number}} timing
 */
function slotFrames(slot, preset, timing) {
  const span = spanOf(slot, timing);
  const { duration, delay } = timing;
  /** @type {number[]} */
  const offsets = slot === 'loop' ? [0, 0.25, 0.5, 0.75, 1] : [0, 0.5, 1];
  /** @type {{t: number, style: Record<string, string>}[]} */
  const frames = [];
  /* 延迟段：t=0 与 t=delay 都是首值（kf 的 delay 只能靠保持帧表达）。 */
  if (slot !== 'out' && delay > 0) {
    frames.push({ t: 0, style: preset.at(0) });
  }
  for (const offset of offsets) {
    const t = slot === 'out' ? span.start + duration * offset : delay + duration * offset;
    frames.push({ t, style: preset.at(offset) });
  }
  /* 出场槽：末值必须落在片段结束前 delay 秒内，超过片段长度时截到片段末尾。 */
  return { span, frames: frames.filter((frame) => frame.t <= timing.clipDuration + 1e-9) };
}

/**
 * 三槽 → 一条 `kf`。
 *
 * @param {Record<string, {preset: string, duration: number, delay: number} | null | undefined>} selection
 * @param {{clipDuration: number}} context 片段时长（秒）；出场槽必须有它
 * @returns {{ok: true, kf: any[], spans: any[], conflicts: string[], props: string[]} | {ok: false, code: string, message: string}}
 */
export function composeMotionKf(selection, context) {
  const clipDuration = Number(context?.clipDuration);
  const chosen = [];
  for (const slot of MOTION_SLOTS) {
    const item = selection?.[slot];
    if (item === null || item === undefined) continue;
    const preset = findPreset(slot, item.preset);
    if (preset === null) return { ok: false, code: 'MOTION_PRESET_UNKNOWN', message: `没有这个预设：${slot}/${String(item.preset)}` };
    const timing = validateTiming(item);
    if (timing.ok !== true) return timing;
    /* 只有出场槽要用片段时长（它从末尾往前排）；入场/循环不依赖它。 */
    if (slot === 'out' && (!Number.isFinite(clipDuration) || clipDuration <= 0)) {
      return { ok: false, code: 'MOTION_CLIP_DURATION_UNKNOWN', message: '这个片段的时长读不出来（没有 #t=in,out），挂不了出场槽' };
    }
    const { span, frames } = slotFrames(slot, preset, { duration: timing.duration, delay: timing.delay, clipDuration });
    if (frames.length < 2) return { ok: false, code: 'MOTION_OUT_OF_RANGE', message: `${MOTION_SLOT_LABELS[slot]}的时间区间落在片段之外` };
    chosen.push({ slot, preset, timing, span, frames });
  }
  if (chosen.length === 0) return { ok: false, code: 'MOTION_EMPTY', message: '还没有选任何预设' };

  /* 冲突：区间相交（端点相接不算）。 */
  const conflicts = [];
  for (let i = 0; i < chosen.length; i += 1) {
    for (let j = i + 1; j < chosen.length; j += 1) {
      const a = chosen[i];
      const b = chosen[j];
      const overlap = Math.min(a.span.end, b.span.end) - Math.max(a.span.start, b.span.start);
      if (overlap > 1e-6) {
        conflicts.push(
          `${MOTION_SLOT_LABELS[a.slot]}与${MOTION_SLOT_LABELS[b.slot]}重叠 ${num(overlap)}s：按「出场 > 循环 > 入场」取值`,
        );
      }
    }
  }

  /* 属性集 = 选中预设的并集（kf 要求每帧属性集一致）。 */
  const props = [];
  for (const item of chosen) for (const prop of item.preset.props) if (!props.includes(prop)) props.push(prop);

  /* 采样时间：所有帧时间 + 区间端点 + 0（<=片段时长）。 */
  const times = new Set([0]);
  for (const item of chosen) {
    for (const frame of item.frames) times.add(Math.min(clipDuration, Math.max(0, frame.t)));
    times.add(Math.max(0, item.span.start));
    times.add(Math.min(clipDuration, item.span.end));
  }
  const sorted = [...times].filter((t) => Number.isFinite(t)).sort((a, b) => a - b);

  /** 某属性在某时刻的取值：按优先级找「正在生效」的最高优先槽。 */
  const valueAt = (prop, t) => {
    for (const slotId of MOTION_PRIORITY) {
      const item = chosen.find((candidate) => candidate.slot === slotId);
      if (item === undefined) continue;
      if (!item.preset.props.includes(prop)) continue;
      if (t < item.span.start - 1e-9 || t > item.span.end + 1e-9) continue;
      const span = Math.max(1e-9, item.span.end - item.span.start);
      const progress = Math.min(1, Math.max(0, (t - item.span.start) / span));
      const style = item.preset.at(progress);
      if (style[prop] !== undefined) return style[prop];
    }
    return BASE_VALUE[prop] ?? '0';
  };

  const kf = sorted.map((t) => {
    const style = {};
    for (const prop of props) style[prop] = valueAt(prop, t);
    return { t: Number(num(t)), style, ease: 'linear' };
  });
  /* 末帧必须是 100%：时间相同的相邻帧合并（采样可能产生重复 t）。 */
  const deduped = [];
  for (const frame of kf) {
    const previous = deduped[deduped.length - 1];
    if (previous !== undefined && Math.abs(previous.t - frame.t) < 1e-6) deduped[deduped.length - 1] = frame;
    else deduped.push(frame);
  }
  if (deduped.length < 2) return { ok: false, code: 'MOTION_TOO_SHORT', message: '合成后不足 2 帧' };

  return {
    ok: true,
    kf: deduped,
    spans: chosen.map((item) => ({ slot: item.slot, preset: item.preset.id, start: item.span.start, end: item.span.end, duration: item.timing.duration, delay: item.timing.delay })),
    conflicts,
    props,
  };
}

/**
 * 判据 ① 的独立算法：帧数 + 时长（末帧 t）。
 * @param {any[]} kf
 */
export function kfSummary(kf) {
  const list = Array.isArray(kf) ? kf : [];
  const last = list.length === 0 ? 0 : Number(list[list.length - 1]?.t ?? 0);
  return { frames: list.length, span: Number(last.toFixed(3)) };
}

/** 预设的中文名（找不到时回 id）。 */
export function presetLabel(slot, presetId) {
  return findPreset(slot, presetId)?.label ?? String(presetId);
}

/* ────────────────────────── 面板（React，无 JSX） ────────────────────────── */

import { createElement, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

const h = createElement;

/** 每个槽的默认时长/延迟（应用前的初值）。 */
const DEFAULT_TIMING = Object.freeze({ duration: 0.6, delay: 0 });

/** @typedef {{preset: string, duration: number, delay: number}} SlotChoice */

export interface MotionPresetsProps {
  /** 当前选中的片段（写盘目标）。 */
  clipId: string;
  /** 选中的元素定位串（`overrides[].at`）；空 = 还没选元素。 */
  at: string;
  /** 展示用：元素名 / 片段名。 */
  atLabel: string;
  /** 片段时长（秒）；0 / NaN = 读不出来（出场槽会被拒）。 */
  clipDuration: number;
  /** 已有 kf（从 doc 的 overrides 里读），用于显示「当前」摘要。 */
  currentKf: any[] | null;
  busy: boolean;
  /**
   * R28 · A：显式重置令牌。宿主在「元素真的没了 / 用户真的清空选中」时自增；
   * doc 刷新期间的短暂空目标**不**自增（面板据此保留三槽）。
   */
  resetToken?: number;
  onApply: (kf: any[]) => Promise<{ ok: boolean; code?: string; message?: string }>;
  onClear: () => Promise<{ ok: boolean; code?: string; message?: string }>;
}

/**
 * 三槽面板：选预设 → 选时长/延迟 → 应用。
 *
 * 每个槽一张卡；卡里一排预设 chip（选中即高亮）+ 两个数字输入。
 * 「应用」把 `composeMotionKf` 的结果交给宿主写盘；冲突/拒绝都显示在卡片下方，
 * 不把失败说成成功。
 */
export function MotionPresets(props: MotionPresetsProps): ReactNode {
  /** @type {[Record<string, SlotChoice|null>, Function]} */
  const [choices, setChoices] = useState<Record<string, SlotChoice | null>>({ in: null, loop: null, out: null });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null);

  /**
   * R28 · A：面板自己记住「最近一次目标」。
   *
   * 以前是 `useEffect(..., [props.at, props.clipId])` 无条件清空 —— 写完盘 doc 刷新时
   * 目标会短暂变成空（甚至被顶到另一个元素），三槽就跟着没了，探针只能「重选 + 补齐」。
   * 现在只在**真的换了目标**时清：
   * - `resetToken` 变了（宿主说元素没了 / 选中被清）→ 清；
   * - 目标变成空串（刷新中间态）→ **保留**，等它回来；
   * - 换到另一个非空目标（同片段换元素、或换片段）→ 清。
   */
  const lastTargetRef = useRef({ clipId: props.clipId, at: props.at });
  const tokenRef = useRef(props.resetToken ?? 0);
  useEffect(() => {
    const token = props.resetToken ?? 0;
    if (token !== tokenRef.current) {
      tokenRef.current = token;
      lastTargetRef.current = { clipId: props.clipId, at: props.at };
      setChoices({ in: null, loop: null, out: null });
      setNote(null);
      return;
    }
    /* 空目标 = doc 刷新中间态：只保留，不清槽位（等目标回来）。 */
    if (props.at === '') return;
    const previous = lastTargetRef.current;
    /* 回到同一个目标（含「空一下又回来」）：不动三槽。 */
    if (previous.clipId === props.clipId && previous.at === props.at) return;
    lastTargetRef.current = { clipId: props.clipId, at: props.at };
    setChoices({ in: null, loop: null, out: null });
    setNote(null);
  }, [props.at, props.clipId, props.resetToken]);

  const pick = (slot: string, presetId: string): void => {
    setChoices((previous) => {
      const current = previous[slot];
      const next = current !== null && current.preset === presetId ? null : { ...DEFAULT_TIMING, preset: presetId };
      return { ...previous, [slot]: next };
    });
    setNote(null);
  };

  const setTiming = (slot: string, key: 'duration' | 'delay', raw: string): void => {
    const value = raw === '' ? Number.NaN : Number(raw);
    setChoices((previous) => {
      const current = previous[slot];
      if (current === null || current === undefined) return previous;
      return { ...previous, [slot]: { ...current, [key]: value } };
    });
  };

  const apply = async (): Promise<void> => {
    if (props.at === '' || props.clipId === '') {
      setNote({ kind: 'error', text: '先在画布或图层里选一个元素：动效挂在元素上' });
      return;
    }
    const composed = composeMotionKf(choices, { clipDuration: props.clipDuration });
    if (composed.ok !== true) {
      setNote({ kind: 'error', text: `${composed.code} · ${composed.message}` });
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const result = await props.onApply(composed.kf);
      if (result.ok !== true) {
        setNote({ kind: 'error', text: `${result.code ?? 'MOTION_APPLY_FAILED'} · ${result.message ?? '写盘失败'}` });
        return;
      }
      const summary = kfSummary(composed.kf);
      const conflict = composed.conflicts.length > 0 ? ` · ${composed.conflicts[0]}` : '';
      setNote({
        kind: composed.conflicts.length > 0 ? 'warn' : 'ok',
        text: `已写入 ${composed.spans.length} 个槽 · ${summary.frames} 帧 / ${summary.span}s${conflict}`,
      });
    } finally {
      setBusy(false);
    }
  };

  const clear = async (): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      const result = await props.onClear();
      setNote(
        result.ok === true
          ? { kind: 'ok', text: '已清除这个元素的关键帧' }
          : { kind: 'error', text: `${result.code ?? 'MOTION_CLEAR_FAILED'} · ${result.message ?? '清除失败'}` },
      );
    } finally {
      setBusy(false);
    }
  };

  const disabled = busy || props.busy;
  const summary = kfSummary(props.currentKf ?? []);
  const chosenCount = MOTION_SLOTS.filter((slot) => choices[slot] !== null).length;

  return h(
    'div',
    { className: 'motion-presets', 'data-testid': 'motion-presets', 'data-slots': String(chosenCount) },
    h(
      'div',
      { className: 'motion-presets-head' },
      h('span', { className: 'motion-presets-title' }, '三槽动效'),
      h(
        'span',
        { className: 'motion-presets-target', 'data-testid': 'motion-preset-target', title: props.atLabel },
        props.at === '' ? '未选元素' : props.atLabel,
      ),
    ),
    h(
      'p',
      { className: 'motion-presets-summary', 'data-testid': 'motion-preset-summary' },
      summary.frames === 0
        ? '当前：这个元素还没有关键帧'
        : `当前：${summary.frames} 帧 / ${summary.span}s（${props.currentKf?.map((frame: any) => Object.keys(frame.style ?? {}).join('+')).flat().filter((value: string, index: number, list: string[]) => list.indexOf(value) === index).join(',')}）`,
    ),
    ...MOTION_SLOTS.map((slot) =>
      h(
        'section',
        {
          className: `motion-slot${choices[slot] === null ? '' : ' is-on'}`,
          key: slot,
          'data-testid': `motion-slot-${slot}`,
          'data-on': choices[slot] === null ? 'false' : 'true',
        },
        h(
          'div',
          { className: 'motion-slot-head' },
          h('span', { className: 'motion-slot-name' }, MOTION_SLOT_LABELS[slot]),
          h('span', { className: 'motion-slot-state' }, choices[slot] === null ? '未启用' : presetLabel(slot, choices[slot].preset)),
        ),
        h(
          'div',
          { className: 'motion-slot-presets' },
          (MOTION_PRESETS[slot] ?? []).map((preset) =>
            h(
              'button',
              {
                key: preset.id,
                type: 'button',
                className: `motion-chip${choices[slot]?.preset === preset.id ? ' active' : ''}`,
                'data-testid': `motion-preset-${slot}-${preset.id}`,
                'aria-pressed': choices[slot]?.preset === preset.id ? 'true' : 'false',
                disabled,
                onClick: () => pick(slot, preset.id),
              },
              preset.label,
            ),
          ),
        ),
        choices[slot] === null
          ? null
          : h(
              'div',
              { className: 'motion-slot-timing' },
              h(
                'label',
                { className: 'motion-timing-field' },
                h('span', null, '时长'),
                h('input', {
                  className: 'motion-timing-input',
                  'data-testid': `motion-preset-dur-${slot}`,
                  type: 'number',
                  min: String(MOTION_LIMITS.duration.min),
                  max: String(MOTION_LIMITS.duration.max),
                  step: '0.1',
                  value: String(choices[slot].duration),
                  disabled,
                  onChange: (event: any) => setTiming(slot, 'duration', event.currentTarget.value),
                }),
                h('span', { className: 'motion-timing-unit' }, 's'),
              ),
              h(
                'label',
                { className: 'motion-timing-field' },
                h('span', null, '延迟'),
                h('input', {
                  className: 'motion-timing-input',
                  'data-testid': `motion-preset-delay-${slot}`,
                  type: 'number',
                  min: String(MOTION_LIMITS.delay.min),
                  max: String(MOTION_LIMITS.delay.max),
                  step: '0.1',
                  value: String(choices[slot].delay),
                  disabled,
                  onChange: (event: any) => setTiming(slot, 'delay', event.currentTarget.value),
                }),
                h('span', { className: 'motion-timing-unit' }, 's'),
              ),
            ),
      ),
    ),
    h(
      'div',
      { className: 'motion-presets-actions' },
      h(
        'button',
        { type: 'button', className: 'btn tiny primary', 'data-testid': 'motion-preset-apply', disabled: disabled || chosenCount === 0, onClick: () => void apply() },
        '应用',
      ),
      h(
        'button',
        { type: 'button', className: 'btn tiny', 'data-testid': 'motion-preset-clear', disabled: disabled || summary.frames === 0, onClick: () => void clear() },
        '清除',
      ),
      h('span', { className: 'motion-presets-hint', 'data-testid': 'motion-preset-hint' }, '预设 = 一串关键帧；写回 overrides，一步撤销'),
    ),
    note === null
      ? null
      : h(
          'p',
          { className: `motion-presets-note ${note.kind}`, 'data-testid': 'motion-preset-note', 'data-kind': note.kind },
          note.text,
        ),
  );
}
