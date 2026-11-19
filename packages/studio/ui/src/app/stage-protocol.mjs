/**
 * 舞台协议（渲染层一侧）：与 `contracts/stage.ts` v1.0.0 对齐的最小实现。
 *
 * 只放**纯函数**，方便在 node --test 里直接跑；真正的 postMessage 连接在 stage-preview.ts。
 * 规则（合同）：版本不符只报 UNSUPPORTED；不认识的 op/type 忽略且不回包；seq 单调递增，迟到回包丢弃。
 */

export const STAGE_PROTOCOL_VERSION = '1.0.0';

/** 合同 `contracts/stage.ts` 的 StageOp，逐字对应（测试锁死这一条，别往里加）。 */
export const STAGE_OPS = Object.freeze(['ping', 'setTime', 'setPlaying', 'setRate', 'setVolume', 'requestFrame']);

/**
 * 舞台**扩展** op（M13 起，检查器用）：不在合同 StageOp 里，只被 Studio 的检查器发；
 * 合同的 `window.film` 与 StageCommand 语义不变（协议版本仍是 1.0.0）。
 *
 * `layerRects`（M21）：一次取回该片段所有可见层的舞台局部矩形（树悬停描边/舞台点选）。
 * `setSolo`（M38）：独奏是**视图态**，不写文档；舞台只按轨道下标过滤预览的可见/出声。
 * `pickAt`（S97）：片段框盖着舞台时，把「按下不移动就松手」的那一下转给场景页——
 * 场景按舞台坐标重新做命中（最小者赢/letterbox 换算/隐藏层排除都在它那边），
 * 然后照常发一条 `pick` 主动事件（seq 0）。**不是新回包类型**，宿主那条 pick 分支原样复用。
 * 回包复用 `layers` 类型，不新增回包种类。
 */
export const STAGE_LAYER_OPS = Object.freeze([
  'installLayers',
  'describeLayer',
  'setOverrides',
  'listLayers',
  'layerRects',
  'setSolo',
  'pickAt',
  'previewBody',
]);

/** 舞台回包类型（除合同的 state/frame/error 外，多三种「一问一答」）。 */
export const STAGE_REPLY_TYPES = Object.freeze(['layer', 'overrides', 'layers']);

/**
 * 舞台**主动事件**（seq 0，不是回包）：M19 点击选层、M32 实时电平、S93 按键转发。
 * 与扩展 op 同一性质——合同的 StageUpdate 三种不动，这是 Studio 与舞台之间的附加事件。
 *
 * `key`（S93）：跨源 iframe 里的按键不冒泡到父文档，舞台只转 Escape（清空元素多选）。
 */
export const STAGE_EVENT_TYPES = Object.freeze(['pick', 'levels', 'key', 'body']);

/** @param {unknown} op */
export function isStageOp(op) {
  return typeof op === 'string' && (STAGE_OPS.includes(op) || STAGE_LAYER_OPS.includes(op));
}

/**
 * 组装一条 StageCommand；未知 op 直接抛错（调用方写错了，不静默发出去）。
 * @param {number} seq
 * @param {string} op
 * @param {Record<string, unknown>} [args]
 */
export function makeStageCommand(seq, op, args = {}) {
  if (!isStageOp(op)) throw new Error(`unknown stage op: ${String(op)}`);
  if (!Number.isInteger(seq) || seq <= 0) throw new Error(`stage seq must be a positive integer: ${String(seq)}`);
  return { v: STAGE_PROTOCOL_VERSION, seq, op, ...args };
}

/**
 * 判断一条来自舞台的 postMessage 是什么。
 * @param {unknown} data
 * @returns {{ kind: 'state'|'frame'|'error'|'layer'|'overrides'|'layers'|'pick'|'levels'|'key'|'body', message: any }|{ kind: 'unsupported', version: unknown }|{ kind: 'ignore' }}
 */
export function classifyStageMessage(data) {
  if (data === null || typeof data !== 'object') return { kind: 'ignore' };
  const message = /** @type {any} */ (data);
  if (typeof message.v !== 'string') return { kind: 'ignore' };
  if (message.v !== STAGE_PROTOCOL_VERSION) return { kind: 'unsupported', version: message.v };
  if (
    message.type !== 'state' &&
    message.type !== 'frame' &&
    message.type !== 'error' &&
    message.type !== 'layer' &&
    message.type !== 'overrides' &&
    message.type !== 'layers' &&
    message.type !== 'pick' &&
    message.type !== 'body' &&
    message.type !== 'levels' &&
    message.type !== 'key' &&
    /* UI-V4-01：舞台空白拖拽 seek（只报比例，时长归宿主）。 */
    message.type !== 'seek'
  ) {
    return { kind: 'ignore' };
  }
  return { kind: message.type, message };
}

/**
 * 迟到的回包：seq 小于已经处理过的最大值。
 * @param {unknown} seq
 * @param {number} lastSeen
 */
export function isStaleSeq(seq, lastSeen) {
  return typeof seq === 'number' && Number.isFinite(seq) && seq < lastSeen;
}

/**
 * 时间码 `mm:ss.ff`（ff 是帧号，用调用方给的 fps）。
 * @param {number} seconds
 * @param {{ num: number, den: number }} fps
 */
export function formatTimecode(seconds, fps) {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const rate = fps && fps.num > 0 ? fps.num / (fps.den > 0 ? fps.den : 1) : 30;
  const totalFrames = Math.round(safe * rate);
  const framesPerSecond = Math.round(rate);
  const frames = totalFrames % framesPerSecond;
  const totalSeconds = Math.floor(totalFrames / framesPerSecond);
  const mm = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const ss = String(totalSeconds % 60).padStart(2, '0');
  const ff = String(frames).padStart(2, '0');
  return `${mm}:${ss}.${ff}`;
}
