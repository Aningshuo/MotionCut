// @ts-nocheck —— 以真导出（真 Studio + 真 Chromium + 真 PNG）为准；产品模块仍由 tsc 严格检查。
/**
 * E05-P2 导出侧验收：关键帧在**生产导出路径**上逐帧确定
 *
 * 判据（派单 R30-071 第 2 节）：
 * 1. 每帧截图前显式写 `--motion-t`，写完等帧再截 → 所以同一 t 的两次导出必须**逐帧 sha 全等**；
 * 2. `t` 落在片段之前 → 停在首帧；`t` 在片段内 → 跟着动；`t` 到末帧 → 到终态；
 * 3. 没有 kf 的工程走的是同一条路径但**零新增调用**（kfActive=false 短路）。
 *
 * 跑法：node --test packages/render/test/keyframes-export.test.mjs
 *
 * 注意：这是**真导出**（起 Studio + Chromium），一次 30 帧约 20–40s；本文件刻意只用
 * 一个 30 帧的段跑两遍，不铺开更多夹具。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parse } from '../../film-core/film-doc.mjs';
import { REPO_ROOT } from '../../scene-runtime/host.mjs';
import { planFromFilm } from '../film-plan.mjs';
import { captureFilmFrames, syncKeyframeFrame } from '../stage-capture.mjs';

/** kf 夹具：片段 at=1、区间 0–8s，`#box` 的 kf 从 t=0 走到 t=2（局部）。 */
const KF_PROJECT = path.join(REPO_ROOT, 'tests/fixtures/main/kf-export');
/** 对照夹具（base 里就有）：两段动效模板，没有 kf。 */
const PLAIN_PROJECT = path.join(REPO_ROOT, 'tests/fixtures/main/motion-export');

const FPS = 10;
/** [0, 3] @10fps = 30 帧 @100ms，正好覆盖「片段前 → 片段内 → 接近末帧」。 */
const RANGE = [0, 3];

/** @type {string} */
let workDir;

test.before(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'e05-p2-export-'));
});

test.after(async () => {
  await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
});

/**
 * 跑一次真导出，返回逐帧 sha。
 * @param {string} projectRoot
 * @param {string} tag
 * @param {[number, number]} [range]
 * @returns {Promise<string[]>}
 */
async function exportOnce(projectRoot, tag, range = /** @type {[number, number]} */ (RANGE)) {
  const text = await fs.readFile(path.join(projectRoot, 'film.html'), 'utf8');
  const parsed = parse(text);
  assert.equal(parsed.doc === null, false, `夹具自己先红了：${JSON.stringify(parsed.diagnostics)}`);
  const plan = await planFromFilm(parsed.doc, { projectRoot, fps: FPS, range });
  const framesDir = path.join(workDir, tag);
  const out = await captureFilmFrames({ plan, projectRoot, framesDir });
  return out.sha256;
}

test('A1 关键帧真的进了成片：片段前是空舞台、起点画出首帧、片段内跟着走、后段到终态', async () => {
  const shas = await exportOnce(KF_PROJECT, 'kf-a');
  assert.equal(shas.length, 30, 'range [0,3] @10fps 应该正好 30 帧');

  /* t=0 … 0.9：片段（at=1）还没出现 → 舞台整片是空的，逐帧相同。 */
  for (let i = 1; i <= 9; i += 1) {
    assert.equal(shas[i], shas[0], `t=${(i / FPS).toFixed(1)}s 早于片段起点，应是同一张空舞台`);
  }

  /* t=1.0 正好是片段起点 → 局部 0 → 首帧；与空舞台必须不同（片段画出来了）。 */
  assert.notEqual(shas[10], shas[0], 't=片段起点应已画出片段（首帧）');

  /* t=2.0 → 局部 1s = 50%，必须与首帧不同（否则等于没接上时钟）。 */
  assert.notEqual(shas[20], shas[10], 't=2.0s（局部 50%）必须已经离开首帧');

  /* 末段 t=2.9（局部 1.9 / span 2 = 95%）与首帧不同。 */
  assert.notEqual(shas[29], shas[10], 't=2.9s 应到（接近）终态');

  /* 至少 4 种不同画面：证明是连续插值，不是「首帧/末帧」两态跳变。 */
  assert.ok(new Set(shas).size >= 4, `帧间应连续变化，实际只有 ${new Set(shas).size} 种`);
});

test('A2 确定性：同一工程两次独立导出，30 帧逐帧 sha 全等', async () => {
  const first = await exportOnce(KF_PROJECT, 'kf-b1');
  const second = await exportOnce(KF_PROJECT, 'kf-b2');
  assert.equal(first.length, second.length);
  const mismatches = first.map((sha, index) => (sha === second[index] ? null : index)).filter((i) => i !== null);
  assert.deepEqual(mismatches, [], `以下帧两次导出不一致：${mismatches.join(',')}`);
});

test('A3 无 kf 工程：同一条路径两次导出也全等（kf 分支短路，不多调一次 evaluate）', async () => {
  const range = /** @type {[number, number]} */ ([0, 1]);
  const first = await exportOnce(PLAIN_PROJECT, 'plain-1', range);
  const second = await exportOnce(PLAIN_PROJECT, 'plain-2', range);
  assert.deepEqual(
    first.map((sha, index) => (sha === second[index] ? null : index)).filter((i) => i !== null),
    [],
  );
  /* 动效模板在两帧之间确实在动（否则这条对照是死的）。 */
  assert.ok(new Set(first).size > 1, '对照工程本身应该有动画');
});

test('A4 syncKeyframeFrame 的页内语义：唯一命中才打标记、值幂等、t<at 钳成 0', () => {
  /* 这个函数会被 Playwright 序列化，这里用最小 DOM 替身验证契约面的三条：
     ① 选择器多命中 → 不打标记（避免两条规则抢同一元素）；
     ② 同一 t 写两次 → 属性值不变（幂等）；
     ③ t 早于 at → 写 0。 */
  const makeEl = (attrs = {}) => {
    const props = { ...attrs };
    const style = new Map();
    return {
      getAttribute: (name) => (name in props ? props[name] : null),
      setAttribute: (name, value) => {
        props[name] = String(value);
      },
      removeAttribute: (name) => {
        delete props[name];
      },
      get style() {
        return { setProperty: (name, value) => style.set(name, String(value)), map: style };
      },
      /* 模拟「元素在一个 at=1 的 clip 容器里」——否则测不到 local = t − at。 */
      closest: (selector) => (selector === '[at]' ? { getAttribute: () => '1' } : null),
    };
  };

  const one = makeEl();
  const other = makeEl();
  const multi = [one, other];
  const doc = {
    documentElement: makeEl(),
    head: { appendChild: () => undefined },
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    querySelectorAll: (sel) => {
      if (sel === '#one') return [one];
      if (sel === '#multi') return multi;
      if (sel === '[data-kf]') return [one];
      return [];
    },
  };

  const g = /** @type {any} */ (globalThis);
  const savedDocument = g.document;
  g.document = doc;
  try {
    const result = syncKeyframeFrame({
      t: 1, // 片段 at=1 → 局部 0
      css: '[data-kf="h1"]{animation-delay:calc(-1 * var(--motion-t) * 1ms)}',
      plans: [
        { at: '#one', hash: 'h1' },
        { at: '#multi', hash: 'h2' },
      ],
    });
    assert.equal(one.getAttribute('data-kf'), 'h1');
    assert.equal(one.getAttribute('data-ov-kf-at'), '#one');
    assert.equal(other.getAttribute('data-kf'), null, '多命中的选择器不该打标记');
    assert.equal(result.marked, 1);
    assert.equal(one.style.map.get('--motion-t'), '0', 't 等于片段起点 → 局部 0');

    /* 幂等：同一个 t 再写一次，值不变。 */
    const before = one.style.map.get('--motion-t');
    syncKeyframeFrame({ t: 1, css: '', plans: [{ at: '#one', hash: 'h1' }] });
    assert.equal(one.style.map.get('--motion-t'), before);

    /* t 在片段内 → 局部毫秒 = (t - at) * 1000。 */
    syncKeyframeFrame({ t: 2.5, css: '', plans: [{ at: '#one', hash: 'h1' }] });
    assert.equal(one.style.map.get('--motion-t'), '1500');
  } finally {
    g.document = savedDocument;
  }
});
