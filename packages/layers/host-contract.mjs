/**
 * 宿主契约（**数据**，不是文档）—— S22 · B-SUB1-R11-011
 *
 * 为什么有这个文件：R8/R9/R10 三次同型事故（接口扩了一倍、消费方不知道），
 * 每次都是合进真工作台才由用户发现。这里把 `mountCanvasGesture` 的全部 opts
 * 变成可机读的一张表，宿主接上第一件事就是跑 `checkHost()`，5 秒内知道少了什么。
 *
 * 用法（3 行）：
 *
 * ```js
 * import { checkHost } from './host-contract.mjs';
 * const report = checkHost(opts);                       // 接宿主前先跑一遍
 * if (!report.ok) throw new Error(JSON.stringify(report.missing)); // 硬缺：mount 都起不来
 * ```
 *
 * 三种「缺」要分清（`checkHost` 分开返回，不混在一起）：
 *
 * | 分类 | 字段 | 含义 |
 * |---|---|---|
 * | 硬缺 | `missing` | 没有替代品（`getStageRect`）或整组都缺（选择源 / 提交口）→ `mountCanvasGesture` 直接抛 |
 * | 失去能力 | `degraded` | 参与手势语义的能力掉了（多选/吸附到层/悬停描边/隐藏/批量提交/舞台边吸附） |
 * | 建议补 | `advisories` | 只是便利、联动或外观（点选便利、选择通知、错误回调、颜色/最小尺寸），不影响手势本身 |
 *
 * 每条都写 `fallback`：没给这个键时**到底会怎样**（降级成什么，或报什么码）。
 * 改了 opts 就必须改这张表 —— `host-conformance.test.mjs` 的 A1 会用脚本对比
 * 「表里的条目数」与「模块里真实出现的 `opts.*` 数量」，漏一个就红。
 *
 * 1.1.0（S25）：新增 `isLocked` / `getLayerOrder` / `keyboard` 三条，都是**可选**且都有
 * 说得出后果的 fallback（锁定保护退化、Tab 顺序退回可点表顺序、键盘用默认步长），
 * 所以 `degraded` 仍是 5 项能力——新增的这三条落在 `advisories`。
 *
 * 1.2.0（S97）：新增 `onClickThrough` 一条，**是能力不是便利**：不给它，clip 模式下
 * 选中片段之后点在片段内部永远选不到层（片段框盖着舞台，事件到不了场景页）。
 */

export const HOST_CONTRACT_VERSION = '1.2.0';

/** @typedef {'required'|'capability'|'convenience'|'notify'|'style'} HostRole */

/**
 * @typedef {object} HostEntry
 * @property {string} name        opts 键名
 * @property {boolean} required   严格含义：**没有替代品**。二选一的组见 HOST_REQUIREMENTS.anyOf
 * @property {string} type        JS 类型
 * @property {string|null} capability 缺失后**用户可感知**的能力名；`null` = 不是能力开关
 * @property {HostRole} role
 * @property {string} [group]     属于哪个 anyOf 组（selection / commit）
 * @property {string} fallback    没给时降级成什么 / 报什么码
 */

/** @type {readonly HostEntry[]} */
export const HOST_CONTRACT = Object.freeze([
  {
    name: 'getStageRect',
    required: true,
    type: 'function',
    capability: null,
    role: 'required',
    fallback: '没有舞台矩形就没法把指针换算到舞台局部坐标：mountCanvasGesture 直接抛 NO_STAGE_RECT。'
  },
  {
    name: 'getSelection',
    required: false,
    type: 'function',
    capability: null,
    role: 'required',
    group: 'selection',
    fallback: '与 getSelectionSet 二选一；两者都没给 → mount 抛 NO_SELECTION_SOURCE（选择是唯一真源，不能猜）。'
  },
  {
    name: 'getSelectionSet',
    required: false,
    type: 'function',
    capability: 'multiselect',
    role: 'capability',
    group: 'selection',
    fallback: '只用 getSelection 的单选：选择恒为 1 层，Shift 加选/框选不生效，松手永远只有一条 op（SINGLE_SELECTION_ONLY）。'
  },
  {
    name: 'getLayerRects',
    required: false,
    type: 'function',
    capability: null,
    role: 'convenience',
    fallback: '本模块不做点选/框选（选择由宿主决定，getSelection 是唯一来源）；点空白仍然穿透到舞台。'
  },
  {
    name: 'getSnapTargets',
    required: false,
    type: 'function',
    capability: 'snap-to-layers',
    role: 'capability',
    fallback: '只吸附舞台的左/中/右、上/中/下；层与层的边/中线不再吸附，也不会画那两条参考线（SNAP_STAGE_ONLY）。'
  },
  {
    name: 'isHidden',
    required: false,
    type: 'function',
    capability: 'hide-layers',
    role: 'capability',
    fallback: '没有「会话内隐藏」：宿主认为隐藏的层仍然画框、仍然可拖（NO_HIDDEN_LAYERS）。'
  },
  {
    name: 'getHighlightRect',
    required: false,
    type: 'function',
    capability: 'hover-outline',
    role: 'capability',
    fallback: 'setHighlight() 变成空操作：悬停树行时舞台上不会有淡描边（NO_HOVER_OUTLINE）。'
  },
  {
    name: 'onPreview',
    required: false,
    type: 'function',
    capability: null,
    role: 'notify',
    fallback: '只在覆盖层上画预览：宿主的画面要等 onCommit 才变，拖动不跟手。'
  },
  {
    name: 'onCommit',
    required: false,
    type: 'function',
    capability: null,
    role: 'required',
    group: 'commit',
    fallback: '与 onCommitMany 二选一；都没有 → mount 抛 NO_COMMITTER（不许假装提交成功）。'
  },
  {
    name: 'onCommitMany',
    required: false,
    type: 'function',
    capability: 'batch-commit',
    role: 'capability',
    group: 'commit',
    fallback: '多选松手不提交，报 NO_BATCH_COMMITTER（不静默、也不拆成多次提交——拆了就得多步撤销）。'
  },
  {
    name: 'onSelectionChange',
    required: false,
    type: 'function',
    capability: null,
    role: 'notify',
    fallback: '点选/框选的结果不通知宿主；宿主得自己调 getSelection 或读 state.ats 才能同步高亮。'
  },
  {
    name: 'onError',
    required: false,
    type: 'function',
    capability: null,
    role: 'notify',
    fallback: '错误仍然写进 state.error，并 console.warn 一次带码（不静默）；只是宿主收不到回调。'
  },
  {
    name: 'onCancel',
    required: false,
    type: 'function',
    capability: null,
    role: 'notify',
    fallback: '取消只回滚覆盖层的预览；宿主如果已经把预览打到画面上，得自己撤回（Esc 后画面可能停在预览态）。'
  },
  {
    name: 'onClickThrough',
    required: false,
    type: 'function',
    capability: 'click-through',
    role: 'capability',
    fallback:
      '片段框（data-gesture-frame）盖着舞台时，一次「按下不移动就松手」不会转发给场景页：clip 模式下选中片段后，点在它内部选不到层（只能先去图层树/下拉选）。拖动、缩放手势不受影响。'
  },
  {
    name: 'stageSize',
    required: false,
    type: 'object',
    capability: 'stage-bounds-snap',
    role: 'capability',
    fallback: '不知道舞台逻辑尺寸：舞台的左/中/右、上/中/下吸附关闭，只剩层与层的吸附（NO_STAGE_BOUNDS）。'
  },
  {
    name: 'minSize',
    required: false,
    type: 'number',
    capability: null,
    role: 'style',
    fallback:
      '按目标分档：片段（`clip === at`）16×16，场景内图层 8×8（`GESTURE_MIN_CLIP_SIZE` / `GESTURE_MIN_SIZE`，声明空间 px）。'
  },
  {
    name: 'minVisible',
    required: false,
    type: 'number',
    capability: null,
    role: 'style',
    fallback: '拖动后至少留 GESTURE_MIN_VISIBLE=32px 可见；被夹住时按 `onError` 报一次 `FRAME_CLAMPED`。'
  },
  {
    name: 'grid',
    required: false,
    type: 'number',
    capability: null,
    role: 'capability',
    fallback: '没有网格：只吸舞台边/中心与其它对象的三条线（要网格吸附就传步长，如 8/16）。'
  },
  {
    name: 'hostSizeLabel',
    required: false,
    type: 'string',
    capability: null,
    role: 'style',
    fallback:
      '默认接管 `[data-testid="clip-hud"]`：手势层显示数字时把宿主那份只读尺寸标签临时藏起来，松手原样还回去（同一时刻画布上只有一组数字）。传 null 关掉，或传自己的选择器。'
  },
  {
    name: 'accent',
    required: false,
    type: 'string',
    capability: null,
    role: 'style',
    fallback: '用默认主色 #3b82f6 画框、手柄、HUD。'
  },
  {
    name: 'guideColor',
    required: false,
    type: 'string',
    capability: null,
    role: 'style',
    fallback: '用默认参考线色 #f43f5e（粉）画吸附线。'
  },
  {
    name: 'isLocked',
    required: false,
    type: 'function',
    capability: null,
    role: 'convenience',
    fallback:
      '只能靠层对象上的 `locked: true` 判断锁定：宿主没标 locked、也没给 isLocked 时，锁定层会被当成可编辑（方向键照样能推，Tab 也不会跳过）。'
  },
  {
    name: 'getLayerOrder',
    required: false,
    type: 'function',
    capability: null,
    role: 'convenience',
    fallback: 'Tab 顺序退回 `getLayerRects()` 的数组顺序（通常与图层树的视觉顺序不一致）。'
  },
  {
    name: 'keyboard',
    required: false,
    type: 'object',
    capability: null,
    role: 'style',
    fallback: '用默认键盘配置：启用、步长按屏幕 px（1 / 10 / 0.1）、连按合并窗口 300ms。'
  }
]);

/**
 * 硬性要求：`required` = 没有替代品；`anyOf` = 组内至少给一个。
 * 和 HOST_CONTRACT 分开是因为「组」是关系，不是单个键的属性。
 */
export const HOST_REQUIREMENTS = Object.freeze({
  required: Object.freeze(['getStageRect']),
  anyOf: Object.freeze([
    Object.freeze({ name: 'selection', anyOf: Object.freeze(['getSelection', 'getSelectionSet']), code: 'NO_SELECTION_SOURCE' }),
    Object.freeze({ name: 'commit', anyOf: Object.freeze(['onCommit', 'onCommitMany']), code: 'NO_COMMITTER' })
  ])
});

/** @param {any} opts @param {string} name */
function has(opts, name) {
  if (!opts || typeof opts !== 'object') return false;
  const value = opts[name];
  return value !== undefined && value !== null;
}

/**
 * 接宿主前跑一遍：缺了什么、因此少了哪些能力，一次说清。
 *
 * @param {any} opts 传给 mountCanvasGesture 的同一个对象
 * @returns {{
 *   ok: boolean,
 *   contractVersion: string,
 *   present: string[],
 *   missing: {name: string, code: string, anyOf?: string[], message: string}[],
 *   degraded: {name: string, capability: string, fallback: string, code: string}[],
 *   advisories: {name: string, role: string, fallback: string}[],
 *   capabilities: string[],
 *   lostCapabilities: string[]
 * }}
 */
export function checkHost(opts) {
  /** @type {{name: string, code: string, anyOf?: string[], message: string}[]} */
  const missing = [];
  for (const name of HOST_REQUIREMENTS.required) {
    if (!has(opts, name)) {
      missing.push({ name, code: 'NO_STAGE_RECT', message: `缺 ${name}（函数）：没有舞台矩形，手势层起不来` });
    }
  }
  for (const group of HOST_REQUIREMENTS.anyOf) {
    if (!group.anyOf.some((name) => has(opts, name))) {
      missing.push({
        name: group.name,
        anyOf: [...group.anyOf],
        code: group.code,
        message: `缺 ${group.name}：${group.anyOf.join(' / ')} 至少给一个`
      });
    }
  }

  const present = [];
  /** @type {{name: string, capability: string, fallback: string, code: string}[]} */
  const degraded = [];
  /** @type {{name: string, role: string, fallback: string}[]} */
  const advisories = [];

  for (const entry of HOST_CONTRACT) {
    if (has(opts, entry.name)) {
      present.push(entry.name);
      continue;
    }
    /* 二选一的组：组内另一个已给 → 这只是「另一种入口没接」，按条目自己的声明走 */
    if (entry.capability) {
      degraded.push({
        name: entry.name,
        capability: entry.capability,
        fallback: entry.fallback,
        code: /** @type {Record<string, string>} */ (CAPABILITY_CODES)[entry.capability] ?? 'NO_CAPABILITY'
      });
    } else {
      advisories.push({ name: entry.name, role: entry.role, fallback: entry.fallback });
    }
  }

  return {
    ok: missing.length === 0,
    contractVersion: HOST_CONTRACT_VERSION,
    present,
    missing,
    degraded,
    advisories,
    capabilities: HOST_CONTRACT.filter((entry) => entry.capability && has(opts, entry.name)).map((entry) => /** @type {string} */ (entry.capability)),
    lostCapabilities: degraded.map((item) => item.capability)
  };
}

/** 能力 → 缺失时上报的码（和运行时里 reportError 的码保持一致）。 */
export const CAPABILITY_CODES = Object.freeze({
  multiselect: 'SINGLE_SELECTION_ONLY',
  'snap-to-layers': 'SNAP_STAGE_ONLY',
  'hide-layers': 'NO_HIDDEN_LAYERS',
  'hover-outline': 'NO_HOVER_OUTLINE',
  'batch-commit': 'NO_BATCH_COMMITTER',
  'stage-bounds-snap': 'NO_STAGE_BOUNDS',
  'click-through': 'NO_CLICK_THROUGH'
});

/* ── fixtures：给宿主抄的最小/完整两份 ─────────────────────────────────── */

const STAGE = Object.freeze({ w: 1280, h: 720 });

/**
 * 最小宿主：**只有 R9 那 6 个键**（getStageRect / getSelection / onPreview / onCommit / onCancel / stageSize）。
 * 用来验「新接一个宿主，基础手势能不能跑、丢了哪些能力」。
 * 真实宿主用自己的实现覆盖同名键即可（键集合才是关键）。
 */
export function createMinimalHost() {
  return {
    getStageRect: () => ({ x: 0, y: 0, w: STAGE.w, h: STAGE.h, scale: 1 }),
    getSelection: () => null,
    onPreview: () => {},
    onCommit: () => {},
    onCancel: () => {},
    stageSize: { w: STAGE.w, h: STAGE.h }
  };
}

/**
 * 完整宿主：`HOST_CONTRACT` 的 24 个键全给（`checkHost().ok === true`、`degraded` 为空）。
 * 这些实现都是**占位**：真实宿主换成自己的（舞台矩形、真实选择、真实 /ops 提交）。
 */
export function createFullHost() {
  return {
    getStageRect: () => ({ x: 0, y: 0, w: STAGE.w, h: STAGE.h, scale: 1 }),
    getSelection: () => null,
    getSelectionSet: () => [],
    getLayerRects: () => [],
    getSnapTargets: () => [],
    isHidden: () => false,
    getHighlightRect: () => null,
    onPreview: () => {},
    onCommit: () => {},
    onCommitMany: () => {},
    onSelectionChange: () => {},
    onError: () => {},
    onCancel: () => {},
    onClickThrough: () => {},
    stageSize: { w: STAGE.w, h: STAGE.h },
    minSize: 8,
    minVisible: 32,
    /* 0 = 关（`SNAP_GRID_MIN` 以下是「不吸网格」）；用 null 会被 checkHost 判成类型不符 */
    grid: 0,
    hostSizeLabel: '[data-testid="clip-hud"]',
    accent: '#3b82f6',
    guideColor: '#f43f5e',
    isLocked: () => false,
    getLayerOrder: () => [],
    /* 与 GESTURE_NUDGE_IDLE_MS 默认值一致；不 import 是为了避免 host-contract ↔ canvas-gesture 循环依赖 */
    keyboard: { enabled: true, stepUnit: 'screen', idleMs: 300 }
  };
}
