/**
 * 播放时钟（WP08）在服务端的入口。
 *
 * 实现是纯逻辑，放在 `packages/studio/ui/src/player/clock.mjs`（播放器与测试共用同一份，
 * 不复制第二套）：服务端只做 re-export，供渲染/导出一侧复用同一时钟语义。
 */

export {
  STATES,
  TRANSITIONS,
  PENDING_FRAME,
  ClockError,
  createPlaybackClock,
  createPlayer,
  measureAvDrift,
} from '../ui/src/player/clock.mjs';
