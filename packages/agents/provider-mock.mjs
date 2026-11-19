/**
 * 项目内 mock 场景 provider（M71-WP21）。
 *
 * ## 为什么是 mock
 *
 * 仓库里没有接真实大模型（`~/.opencut/providers.json` 只做只读探测，不读密钥），
 * 所以「一句话生成场景」的**最小闭环**先用一个**确定性**的本地 provider 跑通：
 * 同一 `prompt` + 同一 `seed` → 逐字节相同的 ops。响应里 `provider` 恒为 `"mock"`，
 * 交接 `notDone` 也明写「真实 provider 未验」——**不许**把它当成真实生成。
 *
 * ## 它能做什么
 *
 * 识别**六类**意图，六类都产出 ops：
 * - 图表 `chart` / 动画 `animation` / 素材 `asset`（M87 分类、M93 起真生成）：
 *   交给产品包 `packages/scene-gen/` 的生成器，出 `ops` + 要落盘的 `files`（PNG / html）。
 *   **这批文件由 `agent-scene` 的 apply 写进工程 `assets/`**，再走现有 ops 执行器。
 *   产出的是**本地确定性生成器**的结果，不是远端模型——`provider` 恒为 `mock`，
 *   响应里还有 `generatedBy: "local-scene-gen"`。
 * - 标题卡：给 page 片段的 `#title` 写 `text` + `style`（走 `overrides` Op）；
 * - 字幕：给 `#caption` 写 `text`；
 * - 形状：`insert` 一个静帧片段 + `set box` 定位。
 *
 * 找不到 page 片段时降级成「画面定位」（`set box`），并在 `warnings` 里写明
 * `NO_PAGE_CLIP`——降级要留痕，不假装成功。
 *
 * ## 可替换
 *
 * `providerFromEnv()` 认 `OPENCUT_AGENT_SCENE_URL`：配了就走 HTTP provider
 * （POST `{prompt, seed, doc}`，期望 `{ops, summary?, warnings?}`）。真实 provider
 * 的联网链路本批**未验**，只在单测里用一个本地 stub 证明协议能跑通。
 */

import { createHash } from 'node:crypto';

import { generateScene } from '../scene-gen/index.mjs';
import { DEFAULT_TIMEOUT_MS, createHttpProvider, parseRetryAfter, parseSseChunk, RETRY_POLICY, PROVIDER_CODES } from './provider-http.mjs';

/* 这三个是给单测/验收链用的：协议解析与错误码不该被复制成第二份实现。 */
export { createHttpProvider, DEFAULT_TIMEOUT_MS, parseRetryAfter, parseSseChunk, RETRY_POLICY, PROVIDER_CODES };

export const MOCK_PROVIDER_ID = 'mock';

/** 三块固定的文案池：从 seed 派生下标，保证确定性。 */
const TITLES = Object.freeze([
  '开场标题',
  '三分钟讲清楚',
  '今天只讲一件事',
  '从零开始的第一个场景',
  '这件事值得单独说',
]);

const CAPTIONS = Object.freeze([
  '这是一句自动生成的说明文字',
  '字幕：先把结论放在最前面',
  '一行字讲清这段画面的意思',
  '提示：可以随时改成你自己的话',
  '说明文字（可编辑）',
]);

const COLORS = Object.freeze(['#ffd166', '#8ecdf7', '#a6e3a1', '#f5a97f', '#cba6f7']);

/**
 * `"font-size:56px;color:#ffd166"` → `{"font-size":"56px","color":"#ffd166"}`。
 *
 * 渲染端（`packages/layers/apply-overrides.mjs`）只认**记录式** style：
 * 字符串会被 `Object.keys()` 拆成 `"0","1"…` 然后写进无效属性名——写盘成功、画面不动。
 * 这里把 provider 的书写形式一次性转成运行时认识的样子（S71 · BLK-R36-1）。
 *
 * @param {unknown} text
 * @returns {Record<string, string>}
 */
export function parseCssStyle(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const part of String(text ?? '').split(';')) {
    const at = part.indexOf(':');
    if (at <= 0) continue;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key !== '' && value !== '') out[key] = value;
  }
  return out;
}

/**
 * FNV-1a → xorshift32。纯函数、不碰时钟：同输入恒同序列。
 * @param {string} text
 * @returns {() => number} [0,1)
 */
export function deterministicRandom(text) {
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.codePointAt(index) ?? 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  let state = hash === 0 ? 0x9e3779b9 : hash;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

/**
 * 意图分类。只认中文关键词与英文同义词，顺序固定。
 *
 * M87 加了图表 / 动画 / 素材三类意图，M93 把生成器搬进产品包后**三类都真生成**
 * （`packages/scene-gen/`）。顺序把这三类放前面：`让方块从左滑到右` 里的「方块」
 * 不是 shape（形状卡片的说法是「形状/图形/卡片」），先判具体动作与数据形态，
 * 再落到老的三类。
 *
 * @param {string} prompt
 * @returns {'chart'|'animation'|'asset'|'shape'|'caption'|'title'}
 */
export function classifyPrompt(prompt) {
  const text = String(prompt ?? '');
  if (/柱状图|柱形图|条形图|折线图|饼图|图表|chart|bar chart/i.test(text)) return 'chart';
  if (/从左滑到右|滑到|滑动|位移|移动|动画|淡入|animate|animation|slide/i.test(text)) return 'animation';
  if (/渐变|纯色|背景|底色|壁纸|gradient|background|solid/i.test(text)) return 'asset';
  if (/形状|图形|shape|卡片|card/i.test(text)) return 'shape';
  if (/字幕|说明|caption|subtitle|文案/i.test(text)) return 'caption';
  return 'title';
}

/**
 * @param {readonly any[]} list
 * @param {() => number} rand
 */
function pick(list, rand) {
  const index = Math.min(list.length - 1, Math.floor(rand() * list.length));
  return list[index];
}

/**
 * @param {any} doc
 * @param {string[]} scopeIds
 * @returns {any|null}
 */
function pickTarget(doc, scopeIds) {
  /** @type {any[]} */
  const clips = [];
  for (const track of doc?.tracks ?? []) {
    for (const clip of track?.clips ?? []) clips.push(clip);
  }
  if (clips.length === 0) return null;
  for (const id of scopeIds) {
    const hit = clips.find((clip) => clip.id === id);
    if (hit !== undefined) return hit;
  }
  const page = clips.find((clip) => clip.kind === 'page');
  return page ?? clips[0];
}

/** @param {any} doc @param {string} base */
function uniqueClipId(doc, base) {
  /** @type {Set<string>} */
  const used = new Set();
  for (const track of doc?.tracks ?? []) {
    for (const clip of track?.clips ?? []) used.add(clip.id);
  }
  if (!used.has(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${String(index)}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${String(used.size + 2)}`;
}

/**
 * 画面时间线的末尾（静帧插入点）。没有任何片段就是 0。
 * @param {any} doc
 */
function timelineEnd(doc) {
  let end = 0;
  for (const track of doc?.tracks ?? []) {
    for (const clip of track?.clips ?? []) {
      if (!Array.isArray(clip.time)) continue;
      const speed = typeof clip.speed === 'number' && clip.speed > 0 ? clip.speed : 1;
      const span = (Number(clip.time[1]) - Number(clip.time[0])) / speed;
      const at = typeof clip.at === 'number' ? clip.at : 0;
      if (Number.isFinite(span) && Number.isFinite(at)) end = Math.max(end, at + span);
    }
  }
  return Math.round(end * 1000) / 1000;
}

/**
 * 项目内 mock provider。
 * @returns {{ id: string, mock: true, generate: (input: any) => Promise<any> }}
 */
export function createMockProvider() {
  /**
   * R122（M8-B）：把「这一趟真的收到了什么」如实回给服务端。
   *
   * 只回**已经进到 generate 的**东西：引用是服务端解析后的结果（`sample` 里就是从
   * 页面/文件读出来的那段内容），附件是 `{name, bytes, sha256, head}`。
   * 没有引用/附件就是空数组 —— 不补零、不编数。
   * @param {any} input
   */
  const echoOf = (input) => ({
    refs: (Array.isArray(input?.refs) ? input.refs : []).map((/** @type {any} */ row) => ({
      kind: String(row?.kind ?? ''),
      identity: String(row?.identity ?? ''),
      ok: row?.ok === true,
      sample: typeof row?.sample === 'string' ? row.sample : '',
    })),
    attachments: (Array.isArray(input?.attachments) ? input.attachments : []).map((/** @type {any} */ row) => ({
      name: String(row?.name ?? ''),
      bytes: Number(row?.bytes ?? 0),
      sha256: typeof row?.sha256 === 'string' ? row.sha256 : '',
      available: row?.available === true,
      head: typeof row?.head === 'string' ? row.head : '',
    })),
  });

  const inner = {
    id: MOCK_PROVIDER_ID,
    mock: true,
    /** @param {any} input */
    async generateInner(input) {
      const doc = input?.doc;
      const prompt = String(input?.prompt ?? '');
      const seed = String(input?.seed ?? '0');
      const scopeIds = Array.isArray(input?.scopeIds) ? input.scopeIds : [];
      const kind = classifyPrompt(prompt);
      /* 图表/动画/素材：交给产品包 `packages/scene-gen/` 真生成（M93）。
         产出 = ops + 要落盘的 files；写盘在 `agent-scene.apply`（唯一写入口不变）。
         provider 仍是 mock：`generatedBy` 明写本地生成器，不冒充远端模型。 */
      if (kind === 'chart' || kind === 'animation' || kind === 'asset') {
        const scene = generateScene({ kind, prompt, doc, seed });
        return {
          ops: scene.ops,
          files: scene.files,
          targets: scene.targets,
          summary: scene.summary,
          warnings: scene.warnings,
          provider: MOCK_PROVIDER_ID,
          generatedBy: 'local-scene-gen',
          sceneKind: kind,
          sources: scene.sources,
        };
      }
      const rand = deterministicRandom(`${seed}|${prompt}|${kind}`);
      const target = pickTarget(doc, scopeIds);
      if (target === null) {
        throw Object.assign(new Error('工程里没有任何片段，无法生成场景'), { code: 'NO_CLIP' });
      }
      /** @type {any[]} */
      const ops = [];
      /** @type {string[]} */
      const warnings = [];

      if (kind === 'shape') {
        const suffix = createHash('sha256').update(`${seed}|${prompt}`).digest('hex').slice(0, 6);
        const id = uniqueClipId(doc, `ai-shape-${suffix}`);
        const stage = doc?.stage ?? { w: 1280, h: 720 };
        const w = 320;
        const h = 180;
        const x = Math.round((Number(stage.w ?? 1280) - w) / 2);
        const y = Math.round((Number(stage.h ?? 720) - h) / 2);
        const at = timelineEnd(doc);
        /** @type {any[]} */
        const pictureTracks = [];
        (doc?.tracks ?? []).forEach((/** @type {any} */ track, /** @type {number} */ index) => {
          const first = track?.clips?.[0];
          const role = track?.role ?? (first?.kind === 'sound' ? 'audio' : first?.kind === 'page' ? 'page' : 'picture');
          if (role === 'picture') pictureTracks.push(index);
        });
        ops.push({
          op: 'insert',
          clip: { id, src: 'assets/ai-shape.png', size: { w, h } },
          ...(pictureTracks.length > 0 ? { track: pictureTracks[pictureTracks.length - 1] } : {}),
        });
        ops.push({ op: 'set', clip: id, field: 'box', value: { x, y, w, h } });
        return {
          ops,
          targets: [target.id, id],
          summary: `在 ${String(at).replace(/\.0$/, '')}s 处插入一个 ${w}×${h} 的静帧形状，并居中定位`,
          warnings,
        };
      }

      if (target.kind === 'page') {
        if (kind === 'caption') {
          const text = pick(CAPTIONS, rand);
          /* `t` 而不是 `text`：`text` 会被 film-core 放行、被渲染端忽略（BLK-R36-1）。 */
          ops.push({ op: 'overrides', clip: target.id, entries: [{ at: '#caption', t: text }] });
          return { ops, targets: [target.id], summary: `把 ${target.id} 的 #caption 改成「${text}」`, warnings };
        }
        const text = pick(TITLES, rand);
        const size = 44 + 4 * Math.floor(rand() * 4);
        const color = pick(COLORS, rand);
        ops.push({
          op: 'overrides',
          clip: target.id,
          entries: [{ at: '#title', t: text, style: parseCssStyle(`font-size:${String(size)}px;color:${color}`) }],
        });
        return {
          ops,
          targets: [target.id],
          summary: `把 ${target.id} 的 #title 改成「${text}」（${String(size)}px）`,
          warnings,
        };
      }

      // 没有 page 片段：降级成画面定位，并明确写进 warnings。
      const stage = doc?.stage ?? { w: 1280, h: 720 };
      const w = Math.min(720, Math.round(Number(stage.w ?? 1280) * 0.5));
      const h = Math.round(w * 0.2);
      const x = Math.round((Number(stage.w ?? 1280) - w) / 2);
      const y = kind === 'caption' ? Math.round(Number(stage.h ?? 720) * 0.8) : Math.round(Number(stage.h ?? 720) * 0.12);
      ops.push({ op: 'set', clip: target.id, field: 'box', value: { x, y, w, h } });
      warnings.push('NO_PAGE_CLIP');
      const label = kind === 'caption' ? '字幕位' : '标题位';
      return {
        ops,
        targets: [target.id],
        summary: `没找到 page 片段，改为把 ${target.id} 定位到${label}（${String(w)}×${String(h)}）`,
        warnings,
      };
    },
  };

  return {
    id: MOCK_PROVIDER_ID,
    mock: true,
    /** @param {any} input */
    async generate(input) {
      const out = await inner.generateInner(input);
      /* 失败路径在上面直接抛（空 ops 也一样）；能走到这里就是一份成功的结果。 */
      return { ...out, echo: echoOf(input) };
    },
  };
}

/**
 * HTTP provider：实现在 `provider-http.mjs`（M90 拆出去，带超时/重试/错误分类）。
 * 上面已 import + re-export，`agent-scene.mjs` 与既有单测的 import 路径不变。
 */

/**
 * 显式关闭时的 provider：一问就抛 `NO_PROVIDER`。
 *
 * 为什么要这个而不是「返回空 ops」：空 ops 会被上层当成「生成成功但没改东西」，
 * 用户看到的是**静默不动**。这里让错误一路冒到 HTTP（agent-scene 会包成
 * `AGENT_FAILED` + `reason:"NO_PROVIDER"`），界面能说清「没有 provider」。
 *
 * @param {string} choice
 */
export function createDisabledProvider(choice = 'none') {
  return {
    id: 'none',
    mock: false,
    disabled: true,
    /** @param {any} _input */
    async generate(_input) {
      throw Object.assign(
        new Error(
          `没有可用的 provider（no provider）：OPENCUT_AGENT_PROVIDER=${choice} 已关闭项目内 mock，且未配置 OPENCUT_AGENT_SCENE_URL`,
        ),
        { code: 'NO_PROVIDER' },
      );
    },
  };
}

/**
 * 按环境变量选 provider：
 * - `OPENCUT_AGENT_PROVIDER=none|off|disabled` → 明确不可用（**不静默**）；
 * - 配了 `OPENCUT_AGENT_SCENE_URL` → HTTP provider；
 * - 其余（未设 / `mock`）→ 项目内 mock；设了别的名字 → 当不可用，不偷偷降级。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ id: string, mock: boolean, generate: (input: any) => Promise<any> }}
 */
export function providerFromEnv(env = process.env) {
  const url = typeof env.OPENCUT_AGENT_SCENE_URL === 'string' ? env.OPENCUT_AGENT_SCENE_URL : '';
  const choice = String(env.OPENCUT_AGENT_PROVIDER ?? '').trim().toLowerCase();
  if (choice === 'none' || choice === 'off' || choice === 'disabled') return createDisabledProvider(choice);
  if (url !== '') {
    const rawTimeout = Number(env.OPENCUT_AGENT_SCENE_TIMEOUT_MS);
    return createHttpProvider({
      url,
      id: env.OPENCUT_AGENT_SCENE_PROVIDER || 'http',
      /* 超时是**客户端**的预算：验收要把它调到 800ms 才测得起「上限内放弃」。 */
      ...(Number.isFinite(rawTimeout) && rawTimeout > 0 ? { timeoutMs: rawTimeout } : { timeoutMs: DEFAULT_TIMEOUT_MS }),
    });
  }
  if (choice === '' || choice === 'mock') return createMockProvider();
  return createDisabledProvider(choice);
}
