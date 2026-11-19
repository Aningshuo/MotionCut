// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S5-WP15 验收 A3 / A5（真实浏览器 DOM）
 *
 * 运行：node --test --test-concurrency=1 packages/motion/library-browser.test.mjs
 * （环境路径见 RUN_ROOT：OPENCUT_ENV_JSON 优先，否则自动建 .local-runs/layers/motion-library-browser/env.json）
 *
 * A3 要的是「改 A 的参数，B 不变」——两个值都从 `getComputedStyle` / `textContent` 读，
 * 不看内存里的对象。A5 要的是升级/回退之后的**表现**：模板源字节变 → 重建实例页 → DOM 跟着变；
 * 回退 → 字节回到 v1 → DOM 也回到 v1。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SceneHost, REPO_ROOT } from '../scene-runtime/host.mjs';
import { resolveLayerTestEnv } from '../layers/test-env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* S57：环境可移植（R37-C5）。OPENCUT_ENV_JSON 优先；否则现建 `.local-runs/layers/motion-library-browser/env.json`。 */
const TEST_ENV = await resolveLayerTestEnv({ suite: 'motion-library-browser' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');
const TMP_ROOT = path.join(RUN_ROOT, 'tmp');

const lib = await import(new URL('./library.mjs', import.meta.url).href);
const { applyInstance } = await import(new URL('./instance.mjs', import.meta.url).href);

const SCHEMA = {
  title: { type: 'string', default: '默认标题', maxLength: 40, apply: { kind: 'text', selector: '.badge-title' } },
  tone: { type: 'color', default: '#25304a' },
  pad: { type: 'number', default: 1, min: 0.5, max: 3, step: 0.1 }
};

const V1 = `<div class="badge" data-version="1" style="display:inline-block;padding:calc(8px * var(--pad, 1));background:var(--tone, #25304a);border-radius:10px">
  <span class="badge-title">默认标题</span>
</div>
`;
const V2 = V1.replace('data-version="1"', 'data-version="2"').replace('border-radius:10px', 'border-radius:2px');

const PROJECT = path.join(TMP_ROOT, `library-dom-${process.pid}`);
const evidence = { batch: 'B-SUB1-R3-003R1', suite: 'library-browser.test.mjs', cases: {}, startedAt: new Date().toISOString() };

/** @type {SceneHost} */
let host;
let port;

async function save() {
  evidence.finishedAt = new Date().toISOString();
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(path.join(EVIDENCE_DIR, 's5-library-browser.json'), JSON.stringify(evidence, null, 2) + '\n');
}

function rel(file) {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

/** 用当前模板字节 + 两个实例包装，生成一个真实页面（实例根是包装层，模板片段在里面）。 */
async function writeHost(name, instanceAttrs) {
  const fragment = await fs.readFile(path.join(PROJECT, 'scenes/badge.html'), 'utf8');
  const mounts = instanceAttrs
    .map(
      (a) =>
        `<div class="mount" data-instance="${a['data-instance']}" data-props='${a['data-props'].replace(/'/g, '&#39;')}'>${fragment}</div>`
    )
    .join('\n');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>library host</title>
<style>html,body{margin:0;width:640px;height:360px;background:#0f1420;color:#eef2ff;font-family:system-ui}
.mount{margin:16px 20px}</style></head>
<body>${mounts}</body></html>
`;
  const file = path.join(PROJECT, `host-${name}.html`);
  await fs.writeFile(file, html);
  return file;
}

async function readDom(page, selector) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return null;
    const badge = root.querySelector('.badge');
    if (!badge) return null;
    const cs = getComputedStyle(badge);
    return {
      bg: cs.backgroundColor,
      radius: cs.borderRadius,
      padTop: cs.paddingTop,
      title: root.querySelector('.badge-title') ? root.querySelector('.badge-title').textContent : null,
      version: badge.getAttribute('data-version')
    };
  }, selector);
}

before(async () => {
  port = Number(JSON.parse(await fs.readFile(process.env.OPENCUT_ENV_JSON ?? path.join(RUN_ROOT, 'env.json'), 'utf8')).studioPort);
  host = await new SceneHost({ port }).start();
  await fs.mkdir(path.join(PROJECT, 'scenes'), { recursive: true });
  await fs.writeFile(path.join(PROJECT, 'scenes/source.html'), V1);

  const saved = await lib.saveAsTemplate(PROJECT, { name: 'badge', from: 'scenes/source.html', params: SCHEMA });
  assert.equal(saved.ok, true, JSON.stringify(saved));
});

after(async () => {
  await save();
  if (host) await host.stop();
});

test('S5-A3 实例隔离：改 A 的参数，B 的 DOM 值不变（两个值都真读）', async () => {
  const { library } = await lib.readLibrary(PROJECT);
  const entry = library.entries.find((e) => e.sourcePath === 'scenes/badge.html');
  const templateHash = lib.sha256(await fs.readFile(path.join(PROJECT, entry.sourcePath), 'utf8'));

  const a = await lib.instantiate(PROJECT, library, entry.id, {
    clipId: 'clip-a',
    params: { title: '实例 A', tone: '#ff2d55', pad: 1.4 }
  });
  const b = await lib.instantiate(PROJECT, library, entry.id, {
    clipId: 'clip-b',
    params: { title: '实例 B', tone: '#27c7a8', pad: 2 }
  });
  assert.equal(a.ok && b.ok, true);

  const file = await writeHost('a3', [a.clip.attrs, b.clip.attrs]);
  const handle = await host.open(rel(file));
  const page = handle.page;

  const initialA = await readDom(page, '[data-instance="clip-a"]');
  const initialB = await readDom(page, '[data-instance="clip-b"]');
  assert.equal(initialA.bg, 'rgb(37, 48, 74)', '未应用参数时是模板默认色');
  assert.equal(initialA.title, '默认标题');

  // 只给 A 应用参数
  await applyInstance(page, { selector: '[data-instance="clip-a"]', schema: SCHEMA, values: a.values });
  const aAfter = await readDom(page, '[data-instance="clip-a"]');
  const bAfter = await readDom(page, '[data-instance="clip-b"]');

  assert.equal(aAfter.bg, 'rgb(255, 45, 85)');
  assert.equal(aAfter.title, '实例 A');
  assert.equal(aAfter.padTop, '11.2px');
  assert.equal(bAfter.bg, 'rgb(37, 48, 74)', 'B 不能跟着 A 变');
  assert.equal(bAfter.title, '默认标题');
  assert.equal(bAfter.padTop, '8px');

  // 再给 B 应用，A 保持自己的值
  await applyInstance(page, { selector: '[data-instance="clip-b"]', schema: SCHEMA, values: b.values });
  const aFinal = await readDom(page, '[data-instance="clip-a"]');
  const bFinal = await readDom(page, '[data-instance="clip-b"]');
  assert.equal(aFinal.bg, 'rgb(255, 45, 85)');
  assert.equal(bFinal.bg, 'rgb(39, 199, 168)');
  assert.equal(aFinal.title, '实例 A');
  assert.equal(bFinal.title, '实例 B');

  const afterHash = lib.sha256(await fs.readFile(path.join(PROJECT, entry.sourcePath), 'utf8'));
  assert.equal(afterHash, templateHash, '两个实例都不许改模板源');

  evidence.cases['S5-A3'] = {
    ok: true,
    templateHash,
    dom: { initialA, initialB, aAfter, bAfter, aFinal, bFinal },
    read: 'getComputedStyle(backgroundColor/paddingTop) + textContent'
  };
  await handle.dispose();
});

test('S5-A5 升级/回退的真实表现：源字节 → 重建实例页 → DOM 跟着变', async () => {
  const before = await lib.readLibrary(PROJECT);
  const entry = before.library.entries.find((e) => e.sourcePath === 'scenes/badge.html');
  const target = path.join(PROJECT, entry.sourcePath);
  const v1Hash = lib.sha256(await fs.readFile(target, 'utf8'));

  // v1：默认圆角 10px
  const inst = await lib.instantiate(PROJECT, before.library, entry.id, { clipId: 'clip-a', params: { tone: '#ff2d55' } });
  const hostA = await writeHost('v1', [inst.clip.attrs]);
  const h1 = await host.open(rel(hostA));
  const domV1 = await readDom(h1.page, '[data-instance="clip-a"]');
  assert.equal(domV1.radius, '10px');
  assert.equal(domV1.version, '1');
  await h1.dispose();

  // 外部改源 → 待升级
  await fs.writeFile(target, V2);
  const changed = (await lib.listEntries(PROJECT, before.library)).find((s) => s.entry.id === entry.id);
  assert.equal(changed.status, 'changed');

  const upgraded = await lib.upgradeTemplate(PROJECT, before.library, entry.id);
  assert.equal(upgraded.ok, true, JSON.stringify(upgraded));
  assert.equal(upgraded.version, 2);

  const hostB = await writeHost('v2', [inst.clip.attrs]);
  const h2 = await host.open(rel(hostB));
  const domV2 = await readDom(h2.page, '[data-instance="clip-a"]');
  assert.equal(domV2.radius, '2px', '升级后实例表现应跟着新源');
  assert.equal(domV2.version, '2');
  await h2.dispose();

  // 回退 → 源字节回到 v1 → 表现回到 v1
  const rolled = await lib.rollbackTemplate(PROJECT, upgraded.library, entry.id);
  assert.equal(rolled.ok, true, JSON.stringify(rolled));
  const rawBack = await fs.readFile(target, 'utf8');
  assert.equal(lib.sha256(rawBack), v1Hash);

  const hostC = await writeHost('v1-back', [inst.clip.attrs]);
  const h3 = await host.open(rel(hostC));
  const domBack = await readDom(h3.page, '[data-instance="clip-a"]');
  assert.equal(domBack.radius, '10px', '回退必须复现旧表现');
  assert.equal(domBack.version, '1');
  await h3.dispose();

  evidence.cases['S5-A5'] = {
    ok: true,
    v1Hash,
    upgradedTo: upgraded.to,
    restored: rolled.restoredHash,
    dom: { domV1, domV2, domBack }
  };
});
