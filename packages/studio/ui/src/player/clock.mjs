/**
 * 播放时钟与状态机（WP08）。纯逻辑：不碰 DOM、不读全局时间、不自己造画面。
 *
 * 三条硬规则：
 * 1. **音频时钟为主**：给一个 `audioClock`（`AudioContext` 那样的 `{ currentTime }`）就用它推导视频时间；
 *    没有音频片段时退化为注入的单调时钟（`now()` 秒）。位置永远是「锚点 + 经过时间 × 速率」算出来的，
 *    不做逐帧累加，所以 29.97 播一小时也不会漂。
 * 2. **帧率是有理数**：`30000/1001` 全程按整数帧换算，只有落到秒时才除一次。
 * 3. **迟到的帧不许覆盖新位置**：每次 `seek` 递增代际令牌，回来时令牌不是最新的就丢掉。
 *
 * 画面由注入的 `FrameProvider` 提供（合同 contracts/frame.ts）；没有 provider 时状态是
 * `PENDING_FRAME`，不显示假画面——这是集成切片接副线1 之前唯一诚实的表现。
 */

/** 五个状态。 */
export const STATES = Object.freeze(['idle', 'playing', 'paused', 'seeking', 'ended']);

/** 合法迁移：`from → [to...]`。非法迁移抛错，不静默吞。 */
export const TRANSITIONS = Object.freeze({
  idle: ['playing', 'seeking'],
  playing: ['paused', 'seeking', 'ended', 'idle'],
  paused: ['playing', 'seeking', 'idle'],
  seeking: ['playing', 'paused', 'ended', 'idle'],
  ended: ['seeking', 'playing', 'idle'],
});

/** 这两个状态之间允许迁移吗（宿主与测试都用它判定，不各自维护一张表）。 */
/** @param {string} from @param {string} to */
export function canTransition(from, to) {
  const table = /** @type {Record<string, string[]>} */ (TRANSITIONS);
  return (table[from] ?? []).includes(to);
}

/** 没有 provider 时的明确状态：不是错误，是「还没接画面」。 */
export const PENDING_FRAME = 'PENDING_FRAME';

export class ClockError extends Error {
  /**
   * @param {string} message
   * @param {'INVALID'|'STATE'|'PENDING_FRAME'} [code]
   */
  constructor(message, code = 'INVALID') {
    super(message);
    this.name = 'ClockError';
    this.code = code;
  }
}

/** JKL：J 倒放（-1/-2），K 停，L 顺放（1/2/4）。 */
const JKL_FORWARD = [1, 2, 4];
const JKL_BACKWARD = [-1, -2];

/**
 * @typedef {{ currentTime: number }} AudioClockLike
 * @typedef {{ request: (input: { t: number, gen: number, timeoutMs?: number }) => Promise<any> }} FrameProvider
 */

/**
 * @param {{
 *   fps: { num: number, den: number },
 *   duration?: number|null,
 *   audioClock?: AudioClockLike|null,
 *   now?: () => number,
 *   frameProvider?: FrameProvider|null,
 *   frameTimeoutMs?: number,
 * }} options
 */
export function createPlaybackClock(options) {
  const fps = { num: Number(options.fps.num), den: Number(options.fps.den) };
  if (!Number.isFinite(fps.num) || !Number.isFinite(fps.den) || fps.num <= 0 || fps.den <= 0) {
    throw new ClockError('帧率必须是正有理数', 'INVALID');
  }
  const duration = options.duration ?? null;
  const frameProvider = options.frameProvider ?? null;
  const timeoutMs = options.frameTimeoutMs ?? 2000;

  /** 有音频时钟就以它为主；否则用注入的单调时钟。 */
  const clockNow = () => {
    if (options.audioClock !== null && options.audioClock !== undefined) return Number(options.audioClock.currentTime);
    if (options.now !== undefined) return Number(options.now());
    return Date.now() / 1000;
  };

  let state = /** @type {'idle'|'playing'|'paused'|'seeking'|'ended'} */ ('idle');
  let rate = 1;
  /** 锚点：`anchorSeconds` 是锚点处的时间线位置，`anchorClock` 是当时的时钟读数。 */
  let anchorSeconds = 0;
  let anchorClock = clockNow();
  let generation = 0;
  /** @type {number|null} 只保留最后一个还没落地的 seek。 */
  let pendingSeek = null;
  let pumping = false;
  /** @type {{ t: number, gen: number, frame: any }|null} */
  let lastFrame = null;
  let status = PENDING_FRAME;
  /** seek 前是否在播：落帧后要回到 playing，而不是停在 paused。 */
  let resumeAfterSeek = false;
  /** 连续 seek 里被合并掉的次数（验收 A2 直接读它）。 */
  let coalesced = 0;
  let rendered = 0;

  const frameSeconds = fps.den / fps.num;

  /** @param {number} seconds */
  const clamp = (seconds) => {
    const floor = Math.max(0, Number(seconds));
    if (duration === null || !Number.isFinite(duration)) return floor;
    return Math.min(floor, Math.max(0, duration));
  };

  /** 当前时间线位置（秒）。不累加：每次都由锚点算。 */
  function position() {
    if (state !== 'playing') return anchorSeconds;
    const elapsed = (clockNow() - anchorClock) * rate;
    return clamp(anchorSeconds + elapsed);
  }

  /** 当前帧号（整数，有理数换算）。 */
  function frame() {
    return secondsToFrameExact(position());
  }

  /** @param {number} seconds */
  function secondsToFrameExact(seconds) {
    const scaled = (seconds * fps.num) / fps.den;
    return Math.floor(scaled + 1e-9);
  }

  /** @param {number} index */
  function frameToSecondsExact(index) {
    return (index * fps.den) / fps.num;
  }

  /** @param {'idle'|'playing'|'paused'|'seeking'|'ended'} to */
  function transition(to) {
    if (to === state) return;
    const allowed = TRANSITIONS[state] ?? [];
    if (!allowed.includes(to)) {
      throw new ClockError(`非法状态迁移：${state} → ${to}`, 'STATE');
    }
    state = to;
  }

  /** @param {'idle'|'playing'|'paused'|'seeking'|'ended'} nextState */
  function settleTo(nextState) {
    anchorSeconds = position();
    anchorClock = clockNow();
    transition(nextState);
  }

  function play() {
    if (state === 'playing') return { state, t: position() };
    if (state === 'ended') {
      // 播完再按播放：从头开始，而不是卡在片尾。
      anchorSeconds = 0;
      anchorClock = clockNow();
      transition('seeking');
      transition('playing');
      return { state, t: 0 };
    }
    anchorClock = clockNow();
    transition('playing');
    return { state, t: position() };
  }

  function pause() {
    if (state === 'playing') settleTo('paused');
    else if (state === 'seeking') transition('paused');
    return { state, t: position() };
  }

  /** @param {number} nextRate */
  function setRate(nextRate) {
    const value = Number(nextRate);
    if (!Number.isFinite(value) || value === 0) throw new ClockError('速率必须是有限非零数', 'INVALID');
    if (Math.abs(value) < 0.25 || Math.abs(value) > 4) throw new ClockError('速率只在 0.25..4（含倒放 -0.25..-4）', 'INVALID');
    anchorSeconds = position();
    anchorClock = clockNow();
    rate = value;
    return rate;
  }

  /**
   * 跳转。连续调用只保留最后一个未完成的请求（合并），返回的 Promise 在**最终位置**落帧后 resolve。
   * @param {number} seconds
   */
  function seek(seconds) {
    const target = clamp(Number(seconds));
    if (!Number.isFinite(target)) throw new ClockError('seek 需要有限秒数', 'INVALID');
    generation += 1;
    const gen = generation;
    if (pendingSeek !== null) coalesced += 1;
    pendingSeek = target;

    // 跳转期间一律进 seeking：画面还在路上，位置已经是新的。
    resumeAfterSeek = state === 'playing' || (state === 'seeking' && resumeAfterSeek);
    anchorSeconds = target;
    anchorClock = clockNow();
    if (state !== 'seeking') transition('seeking');

    return pump(gen).then((result) => ({ ...result, gen, t: target, coalesced }));
  }

  /** 落帧结束：原来在播就回到 playing，否则停在 paused。 */
  function endSeek() {
    if (state !== 'seeking') {
      resumeAfterSeek = false;
      return;
    }
    if (resumeAfterSeek) {
      anchorClock = clockNow();
      resumeAfterSeek = false;
      transition('playing');
    } else {
      transition('paused');
    }
  }

  /**
   * 一次只发一个请求；期间来的 seek 只更新 pendingSeek，回来时按最新代际决定要不要画。
   * @param {number} gen
   */
  async function pump(gen) {
    if (frameProvider === null || frameProvider === undefined) {
      status = PENDING_FRAME;
      endSeek();
      return { ok: false, code: PENDING_FRAME, rendered: false };
    }
    if (pumping) return { ok: true, deferred: true, rendered: false };
    pumping = true;
    try {
      while (pendingSeek !== null) {
        const target = pendingSeek;
        const myGen = generation;
        pendingSeek = null;
        let frameResult;
        try {
          frameResult = await frameProvider.request({ t: target, gen: myGen, timeoutMs });
        } catch (error) {
          status = 'FRAME_FAILED';
          endSeek();
          return { ok: false, code: 'FRAME_FAILED', message: String(/** @type {Error} */ (error)?.message ?? error), rendered: false };
        }
        if (myGen !== generation) {
          // 迟到的帧：位置已经变了，丢掉，不覆盖新画面。
          coalesced += 1;
          continue;
        }
        lastFrame = { t: target, gen: myGen, frame: frameResult };
        status = 'FRAME_READY';
        rendered += 1;
      }
      endSeek();
      return { ok: true, rendered: true, frame: lastFrame };
    } finally {
      pumping = false;
    }
  }

  /**
   * 逐帧：±1 帧，精确停在相邻帧上（按整数帧算，不靠浮点加减）。
   * @param {number} delta
   */
  function step(delta) {
    const stepCount = Math.trunc(Number(delta));
    if (!Number.isFinite(stepCount) || stepCount === 0) throw new ClockError('step 需要 ±1 帧', 'INVALID');
    if (state === 'playing') settleTo('paused');
    const base = secondsToFrameExact(position());
    const target = Math.max(0, base + stepCount);
    const seconds = frameToSecondsExact(target);
    return { t: seconds, frame: target, done: seek(seconds) };
  }

  /**
   * JKL：L 顺放 1→2→4，J 倒放 -1→-2，K 停。
   * @param {'j'|'k'|'l'} key
   */
  function press(key) {
    const k = String(key).toLowerCase();
    if (k === 'k') return { ...pause(), rate };
    if (k === 'l') {
      // 停着按 L = 1x 起播；已经在放才升到 2x / 4x。
      const next = state === 'playing' ? JKL_FORWARD.find((candidate) => candidate > rate) ?? 4 : 1;
      setRate(next);
      if (state !== 'playing') play();
      return { state, rate, t: position() };
    }
    if (k === 'j') {
      const next = state === 'playing' ? JKL_BACKWARD.find((candidate) => candidate < rate) ?? -2 : -1;
      setRate(next);
      if (state !== 'playing') play();
      return { state, rate, t: position() };
    }
    throw new ClockError(`JKL 只有 j/k/l，收到 ${key}`, 'INVALID');
  }

  /** 每帧调用：到片尾就进 ended（由宿主驱动画面）。 */
  function tick() {
    if (state === 'playing' && duration !== null) {
      const t = position();
      /* 到片尾的容差取**半帧**，不是 1e-9。
         媒体元素的最终 currentTime 常常比 duration 小十几微秒（实测 WebM：duration
         12.008、音频停在 12.007985），严格比较会让状态机永远停在 playing、不触发 ended。
         半帧在语义上也刚好：最后一帧的起点就是 duration - 1/fps。 */
      if (rate > 0 && t >= duration - frameSeconds / 2) {
        anchorSeconds = duration;
        anchorClock = clockNow();
        transition('ended');
      } else if (rate < 0 && t <= 0) {
        anchorSeconds = 0;
        anchorClock = clockNow();
        transition('paused');
      }
    }
    return { state, t: position(), frame: frame() };
  }

  /**
   * 打开/重开工程：回到确定初值（idle + 0），不恢复上次的播放状态与播放头。
   * 这是验收 A9 的口径：重开是确定值，不是「接着上次播」。
   */
  function open() {
    reset();
    return { state, t: 0, frame: 0, status };
  }

  /** 退出重开/切工程：回到确定初值，不残留上次播放。 */
  function reset() {
    generation += 1;
    pendingSeek = null;
    rate = 1;
    anchorSeconds = 0;
    anchorClock = clockNow();
    lastFrame = null;
    status = PENDING_FRAME;
    if (state !== 'idle') transition('idle');
    return { state, t: 0, frame: 0 };
  }

  return {
    open,
    reset,
    play,
    pause,
    seek,
    step,
    press,
    tick,
    /** 显式迁移：非法迁移抛 ClockError('STATE')，供宿主强制状态时使用。 */
    /** @param {string} to */
    transitionTo: (to) => {
      const next = STATES.find((candidate) => candidate === to);
      if (next === undefined) throw new ClockError(`未知状态：${to}`, 'INVALID');
      transition(/** @type {any} */ (next));
      return state;
    },
    position,
    frame,
    setRate,
    get state() {
      return state;
    },
    get rate() {
      return rate;
    },
    get generation() {
      return generation;
    },
    get status() {
      return status;
    },
    get lastFrame() {
      return lastFrame;
    },
    /** 只用于验收/诊断：连续 seek 被合并的次数、真正落帧的次数。 */
    stats: () => ({ coalesced, rendered, pending: pendingSeek, generation, status }),
    /** 持久化用的视图：只存播放头，不存「正在播」。 */
    viewState: () => ({ playhead: position(), state: /** @type {const} */ ('idle') }),
  };
}

/**
 * 音画偏差：音频脉冲与它对应的画面变化点之间的差，换算成帧。
 * @param {{ audioAt: number, videoAt: number, fps: { num: number, den: number } }} input
 * @returns {{ driftSeconds: number, driftFrames: number }}
 */
export function measureAvDrift(input) {
  const driftSeconds = Number(input.videoAt) - Number(input.audioAt);
  const driftFrames = (driftSeconds * input.fps.num) / input.fps.den;
  return { driftSeconds, driftFrames };
}

/**
 * 播放器的确定初值：任何一次「打开/重开」都从 idle + 0 开始，不继承上次播放状态。
 * @param {Parameters<typeof createPlaybackClock>[0]} options
 */
export function createPlayer(options) {
  return createPlaybackClock(options);
}
