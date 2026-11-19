// @ts-nocheck —— 以 node --test 的运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * E05-P1 关键帧：契约 → 校验（五拒 + 静态冲突）→ 编译（可 seek 的 CSS）
 *
 * 判据（派单 R30-070 第 4 步）：
 * 1. 同一 doc 两次编译 → CSS **字节相同**（给 sha）；
 * 2. 五条拒绝各一个负向用例 + 一个正向（3 帧、两种属性）；
 * 3. 编译出的规则里 `data-kf` 存在、`animation-delay` 含 `var(--motion-t)`；
 * 4. 不许动现有静态覆盖的行为。
 *
 * 跑法：node --test packages/film-core/test/keyframes.test.mjs
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { parse, sha256, writeValue } from '../film-doc.mjs';
import { MOTION_TIME_VAR } from '../../motion/instance.mjs';
import {
  INTERPOLABLE_PROPERTIES,
  KEYFRAME_ERROR_CODES,
  compileKeyframes,
  isInterpolableProperty,
  keyframeHash,
  validateKeyframeList,
} from '../keyframes.mjs';

/** 片段 4s（`#t=0,4` + speed 1），关键帧最长只能到 4s。 */
const FIXTURE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=1280, height=720">
<title>E05-P1 夹具</title>
</head>
<body>
<section id="pages">
  <iframe id="page-main" src="page.html#t=0,4" at="1.5" size="1280x720"></iframe>
</section>
</body>
</html>
`;

/** 三帧、两种属性（`opacity` 与 `translate`），中间帧带自己的缓动。 */
const GOOD_KF = [
  { t: 0, style: { opacity: '0', translate: '0 12px' }, ease: 'ease-out' },
  { t: 1, style: { opacity: '0.4', translate: '0 4px' }, ease: 'linear' },
  { t: 2.5, style: { opacity: '1', translate: '0 0' } },
];

/**
 * 把一条 `kf` 塞进 film.html 的 `overrides` 里（JSON 用单引号包属性，避免转义地狱）。
 * @param {any} kf
 * @param {{ at?: string, style?: Record<string, string>, extraEntries?: any[] }} [opts]
 */
function filmWith(kf, opts = {}) {
  const at = opts.at ?? '#title';
  const entry = { at };
  if (opts.style !== undefined) entry.style = opts.style;
  if (kf !== undefined) entry.kf = kf;
  const list = [entry, ...(opts.extraEntries ?? [])];
  return FIXTURE.replace('<iframe id="page-main"', `<iframe id="page-main" overrides='${JSON.stringify(list)}'`);
}

/** @param {string} text */
function parseOrThrow(text) {
  const result = parse(text);
  assert.equal(result.doc === null, false, `本该解析成功，却报：${JSON.stringify(result.diagnostics)}`);
  return result.doc;
}

/** @param {string} text */
function diagnosticsOf(text) {
  return parse(text).diagnostics;
}

/* ── 一、契约与白名单 ─────────────────────────────────────────────────── */

test('A0 码表齐全：六条错误码一个不少，且都在 film-doc 的诊断码里', async () => {
  assert.deepEqual([...KEYFRAME_ERROR_CODES], [
    'KF_TOO_SHORT',
    'KF_ORDER',
    'KF_PROPS_MISMATCH',
    'KF_NOT_INTERPOLABLE',
    'KF_OUT_OF_RANGE',
    'KF_STATIC_CONFLICT',
  ]);
  const { DIAGNOSTIC_CODES } = await import('../film-doc.mjs');
  for (const code of KEYFRAME_ERROR_CODES) {
    assert.equal(DIAGNOSTIC_CODES.includes(code), true, `${code} 不在 DIAGNOSTIC_CODES 里`);
  }
});

test('A0b 白名单：可插值属性认、不可插值的不认（`display` / `background-image`）', () => {
  assert.equal(isInterpolableProperty('opacity'), true);
  assert.equal(isInterpolableProperty('translate'), true);
  assert.equal(isInterpolableProperty('display'), false);
  assert.equal(isInterpolableProperty('background-image'), false);
  assert.equal(isInterpolableProperty('不是属性'), false);
  assert.equal(INTERPOLABLE_PROPERTIES.includes('opacity'), true);
});

/* ── 二、正向：3 帧两种属性 ────────────────────────────────────────────── */

test('A1 正向：3 帧两种属性解析成功，kf 原样留在 overrides 里（没被裁字段）', () => {
  const doc = parseOrThrow(filmWith(GOOD_KF));
  const entry = doc.tracks[0].clips[0].overrides[0];
  assert.equal(entry.at, '#title');
  assert.equal(Array.isArray(entry.kf), true);
  assert.equal(entry.kf.length, 3);
  assert.deepEqual(entry.kf.map((frame) => frame.t), [0, 1, 2.5]);
  assert.deepEqual(Object.keys(entry.kf[0].style).sort(), ['opacity', 'translate']);
});

test('A2 编译：@keyframes 按 t 比例分百分比，逐段写 animation-timing-function', () => {
  const doc = parseOrThrow(filmWith(GOOD_KF));
  const { css, plans } = compileKeyframes(doc);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].at, '#title');
  assert.equal(plans[0].clipStart, 1.5);
  assert.equal(plans[0].span, 2.5);

  /* 2.5 是末帧 → 100%；1/2.5 = 40%。 */
  assert.match(css, /0% \{ opacity: 0; translate: 0 12px; animation-timing-function: ease-out; \}/);
  assert.match(css, /40% \{ opacity: 0\.4; translate: 0 4px; animation-timing-function: linear; \}/);
  assert.match(css, /100% \{ opacity: 1; translate: 0 0; \}/);
  /* 末帧不写 timing-function（没有下一段）。 */
  assert.equal(/100% \{[^}]*animation-timing-function/.test(css), false);
});

test('A3 编译：动画是暂停的，delay 读 var(--motion-t) 且只含局部毫秒（不含 at）', () => {
  const doc = parseOrThrow(filmWith(GOOD_KF));
  const { css } = compileKeyframes(doc);
  assert.match(css, /animation: kf-[0-9a-f]{10} 2\.5s linear both;/);
  assert.match(css, /animation-play-state: paused;/);
  /* 局部口径：`--motion-t` 就是「片段内已经过了多少毫秒」，所以 delay = −var()。
     片段起点由注入侧（writeMotionTime 的 localMsOf）扣掉，CSS 里**不能**再出现 `s -`。 */
  assert.match(css, new RegExp(`animation-delay: calc\\(-1 \\* var\\(${MOTION_TIME_VAR}, 0\\) \\* 1ms\\);`));
  assert.equal(/animation-delay:[^;]*\d+s - /.test(css), false, 'CSS 里不该再把片段起点折进 delay');
  /* 元素选择器就是契约里那个属性。 */
  assert.match(css, /\[data-kf="[0-9a-f]{10}"\] \{/);
});

test('A4 同 doc 两次编译 → CSS 字节相同（同一个 sha256）', () => {
  const text = filmWith(GOOD_KF);
  const first = compileKeyframes(parseOrThrow(text)).css;
  const second = compileKeyframes(parseOrThrow(text)).css;
  assert.equal(first, second);
  const sha = createHash('sha256').update(first, 'utf8').digest('hex');
  assert.equal(createHash('sha256').update(second, 'utf8').digest('hex'), sha);
  /* 且与「对象顺序换了但语义相同」的输入一致（属性名字典序输出）。 */
  const shuffled = GOOD_KF.map((frame) => ({
    t: frame.t,
    ease: frame.ease,
    style: Object.fromEntries(Object.entries(frame.style).reverse()),
  }));
  assert.equal(compileKeyframes(parseOrThrow(filmWith(shuffled))).css, first);
});

test('A5 hash 不含片段起点：同选择器同帧序列、不同 at → 共用一条规则，plans 各带自己的起点', () => {
  assert.equal(keyframeHash('#title', GOOD_KF), keyframeHash('#title', GOOD_KF), '同输入必须同 hash');
  assert.notEqual(keyframeHash('#title', GOOD_KF), keyframeHash('#subtitle', GOOD_KF), '换选择器必须换 hash');

  const twoClips = {
    tracks: [
      {
        clips: [
          { id: 'a', at: 0, time: [0, 4], overrides: [{ at: '#title', kf: GOOD_KF }] },
          { id: 'b', at: 2, time: [0, 4], overrides: [{ at: '#title', kf: GOOD_KF }] },
        ],
      },
    ],
  };
  const { css, plans, stats } = compileKeyframes(twoClips);
  assert.equal(plans.length, 2);
  /* 局部口径下这是**正确**的复用：规则一样，各元素被写的局部毫秒数不同。 */
  assert.equal(stats.rules, 1, '同形片段共用一条规则');
  assert.deepEqual(plans.map((plan) => plan.clipStart), [0, 2]);
  assert.equal((css.match(/@keyframes/g) ?? []).length, 1);
  /* 跨片段但选择器/帧序列不同 → 必须分开。 */
  const mixed = {
    tracks: [
      {
        clips: [
          { id: 'a', at: 0, time: [0, 4], overrides: [{ at: '#title', kf: GOOD_KF }] },
          { id: 'b', at: 0, time: [0, 4], overrides: [{ at: '#subtitle', kf: GOOD_KF }] },
        ],
      },
    ],
  };
  assert.equal(compileKeyframes(mixed).stats.rules, 2);
});

/* ── 三、五拒 ─────────────────────────────────────────────────────────── */

test('B1 KF_TOO_SHORT：只有 1 条 → 拒，并说清「一条没有从哪到哪」', () => {
  const diags = diagnosticsOf(filmWith([{ t: 0, style: { opacity: '0' } }]));
  const hit = diags.find((item) => item.code === 'KF_TOO_SHORT');
  assert.equal(hit !== undefined, true, JSON.stringify(diags.map((d) => d.code)));
  assert.equal(hit.severity, 'error');
  assert.match(hit.message, /至少 2 条/);
});

test('B2 KF_ORDER：重复 t 与倒序都拒', () => {
  const repeat = diagnosticsOf(
    filmWith([
      { t: 0, style: { opacity: '0' } },
      { t: 0, style: { opacity: '1' } },
    ]),
  );
  assert.equal(repeat.some((d) => d.code === 'KF_ORDER'), true, JSON.stringify(repeat.map((d) => d.code)));

  const inverted = diagnosticsOf(
    filmWith([
      { t: 2, style: { opacity: '0' } },
      { t: 1, style: { opacity: '1' } },
    ]),
  );
  assert.equal(inverted.some((d) => d.code === 'KF_ORDER'), true);
});

test('B3 KF_PROPS_MISMATCH：两条帧的属性集不一致 → 拒（否则中间态会跳）', () => {
  const diags = diagnosticsOf(
    filmWith([
      { t: 0, style: { opacity: '0', translate: '0 8px' } },
      { t: 1, style: { opacity: '1' } },
    ]),
  );
  const hit = diags.find((item) => item.code === 'KF_PROPS_MISMATCH');
  assert.equal(hit !== undefined, true, JSON.stringify(diags.map((d) => d.code)));
  assert.match(hit.message, /属性集必须一致/);
});

test('B4 KF_NOT_INTERPOLABLE：background-image / display 都拒', () => {
  const image = diagnosticsOf(
    filmWith([
      { t: 0, style: { 'background-image': 'url(a.png)' } },
      { t: 1, style: { 'background-image': 'url(b.png)' } },
    ]),
  );
  const hit = image.find((item) => item.code === 'KF_NOT_INTERPOLABLE');
  assert.equal(hit !== undefined, true, JSON.stringify(image.map((d) => d.code)));
  assert.match(hit.message, /不是可插值属性/);

  const display = diagnosticsOf(
    filmWith([
      { t: 0, style: { display: 'block' } },
      { t: 1, style: { display: 'none' } },
    ]),
  );
  assert.equal(display.some((d) => d.code === 'KF_NOT_INTERPOLABLE'), true);
});

test('B5 KF_OUT_OF_RANGE：末帧超出片段时长 → 拒；恰好等号 → 放行', () => {
  const over = diagnosticsOf(
    filmWith([
      { t: 0, style: { opacity: '0' } },
      { t: 4.5, style: { opacity: '1' } },
    ]),
  );
  const hit = over.find((item) => item.code === 'KF_OUT_OF_RANGE');
  assert.equal(hit !== undefined, true, JSON.stringify(over.map((d) => d.code)));
  assert.match(hit.message, /超出片段时长 4s/);

  /* 恰好 4s = 片段长度，设计书 §2 明确「允许恰好等号」。 */
  const exact = diagnosticsOf(
    filmWith([
      { t: 0, style: { opacity: '0' } },
      { t: 4, style: { opacity: '1' } },
    ]),
  );
  assert.deepEqual(exact, [], '恰好等于片段时长不该报错');
});

test('B6 时长未知时不判越界（`#t=in` 到结尾 / 没写 #t=）', () => {
  const noOut = FIXTURE.replace('page.html#t=0,4', 'page.html#t=0');
  const text = noOut.replace(
    '<iframe id="page-main"',
    `<iframe id="page-main" overrides='${JSON.stringify([{ at: '#title', kf: [{ t: 0, style: { opacity: '0' } }, { t: 99, style: { opacity: '1' } }] }])}'`,
  );
  assert.deepEqual(diagnosticsOf(text), [], '时长不知道就不该拿 0 冒充');
});

/* ── 四、静态冲突（写盘前拒） ──────────────────────────────────────────── */

test('B7 KF_STATIC_CONFLICT：同一属性同时有静态 style 与 kf → 拒', () => {
  const diags = diagnosticsOf(
    filmWith(GOOD_KF, { style: { opacity: '0.9' } }),
  );
  const hit = diags.find((item) => item.code === 'KF_STATIC_CONFLICT');
  assert.equal(hit !== undefined, true, JSON.stringify(diags.map((d) => d.code)));
  assert.match(hit.message, /opacity/);
  assert.match(hit.message, /静态覆盖与关键帧/);
});

test('B8 KF_STATIC_CONFLICT：`s`/`r` 也算静态占用（它们落到 scale/rotate 上）', () => {
  const withScale = filmWith(
    [
      { t: 0, style: { scale: '1' } },
      { t: 1, style: { scale: '1.4' } },
    ],
  ).replace(`"#title"`, `"#title","s":[1,1]`);
  const diags = diagnosticsOf(withScale);
  const hit = diags.find((item) => item.code === 'KF_STATIC_CONFLICT');
  assert.equal(hit !== undefined, true, JSON.stringify(diags.map((d) => d.code)));
  assert.match(hit.message, /scale/);
});

test('B9 KF_STATIC_CONFLICT：同一 at 拆成两条（一条 style、一条 kf）→ 也拒', () => {
  const text = filmWith(GOOD_KF, { extraEntries: [{ at: '#title', style: { translate: '0 3px' } }] });
  /* 两条都叫 #title 时，第二条会覆盖前一条的 at 槽位；冲突在 buildClip 末端统一判。 */
  const diags = diagnosticsOf(text);
  const hit = diags.find((item) => item.code === 'KF_STATIC_CONFLICT');
  assert.equal(hit !== undefined, true, JSON.stringify(diags.map((d) => d.code)));
  assert.match(hit.message, /translate/);
});

test('B10 写盘前就拒：解析报 KF_STATIC_CONFLICT 的文本，writeValue 直接 INVALID（不是渲染时才发现）', () => {
  const text = filmWith(GOOD_KF, { style: { opacity: '0.9' } });
  const result = writeValue(text, { stage: { w: 1280, h: 720 }, fps: { num: 30, den: 1 }, tracks: [] }, sha256(text));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID');
  assert.equal(
    result.diagnostics.some((item) => item.code === 'KF_STATIC_CONFLICT'),
    true,
    JSON.stringify(result.diagnostics.map((d) => d.code)),
  );
});

/* ── 五、不影响静态覆盖 ───────────────────────────────────────────────── */

test('C1 没有 kf 的条目：编译产出空 CSS，计划为空（静态覆盖一个字都不碰）', () => {
  const plain = FIXTURE.replace(
    '<iframe id="page-main"',
    `<iframe id="page-main" overrides='${JSON.stringify([{ at: '#title', style: { opacity: '0.5' }, r: 8 }])}'`,
  );
  const doc = parseOrThrow(plain);
  const { css, plans, stats } = compileKeyframes(doc);
  assert.equal(css, '');
  assert.equal(plans.length, 0);
  assert.equal(stats.rules, 0);
  /* 静态覆盖原样在模型里。 */
  const entry = doc.tracks[0].clips[0].overrides[0];
  assert.equal(entry.style.opacity, '0.5');
  assert.equal(entry.r, 8);
});

test('C2 纯静态文档 compileKeyframes 不抛（doc 里连 overrides 都没有）', () => {
  const doc = parseOrThrow(FIXTURE);
  assert.deepEqual(compileKeyframes(doc), {
    css: '',
    plans: [],
    diagnostics: [],
    stats: { rules: 0, plans: 0, deduped: 0, declarationCount: 0 },
  });
});

test('C3 validateKeyframeList 单独可用：不依赖 parse 也能判（给 UI/P3 预检用）', () => {
  assert.deepEqual(validateKeyframeList(GOOD_KF, { duration: 4 }), { ok: true });
  const short = validateKeyframeList([], {});
  assert.equal(short.ok, false);
  assert.equal(short.code, 'KF_TOO_SHORT');
  const badEase = validateKeyframeList(
    [
      { t: 0, style: { opacity: '0' }, ease: 'bounce' },
      { t: 1, style: { opacity: '1' } },
    ],
    {},
  );
  assert.equal(badEase.ok, false);
  assert.equal(badEase.code, 'KF_PROPS_MISMATCH');
});
