/**
 * 场景生成器的错误码（M93 搬进产品包时统一）。
 *
 * 为什么要有码：上层 `agent-scene` 把 provider 抛出的 `code` 原样透到
 * `AGENT_FAILED.reason`，界面/验收脚本据此区分「输入坏了」与「provider 坏了」。
 * 只有 message 的话，所有失败都长成一句话，判不了。
 */

/** 错误码表：不写 `Record<string,string>` 注解，让 TS 保留字面量类型（否则取值是 `string|undefined`）。 */
export const SCENE_GEN_CODES = Object.freeze({
  EMPTY_VALUES: 'EMPTY_VALUES',
  BAD_VALUE: 'BAD_VALUE',
  TOO_MANY_VALUES: 'TOO_MANY_VALUES',
  BAD_KEYFRAMES: 'BAD_KEYFRAMES',
  BAD_KEYFRAME_ORDER: 'BAD_KEYFRAME_ORDER',
  BAD_COLOR: 'BAD_COLOR',
  MISSING_OUTDIR: 'MISSING_OUTDIR',
  BAD_SECONDS: 'BAD_SECONDS',
  UNKNOWN_INTENT: 'UNKNOWN_INTENT',
});

/**
 * @param {string} code
 * @param {string} message
 * @returns {Error & { code: string }}
 */
export function sceneError(code, message) {
  return /** @type {Error & { code: string }} */ (Object.assign(new Error(message), { code }));
}
