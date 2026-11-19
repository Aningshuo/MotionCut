// @ts-nocheck —— 以 node --test 的运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * 动效宿主适配（M27 · B-MAIN-R14-014）的单测。
 *
 * 只测「适配与规划」：库 → MotionEntryView、参数 → overrides 条目、报码。
 * 真 Studio / 真面板 / 一步撤销由 `scripts/m27-motion.mjs` 在浏览器里验。
 */

import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parse } from '../../../film-core/film-doc.mjs';
import { applyOps } from '../../../film-core/ops.mjs';
import { libraryView, planMotionApply } from '../motion-wire.mjs';

const FIXTURE = join(import.meta.dirname, '..', '..', '..', '..', 'tests', 'fixtures', 'main', 'motion-wire');

/** 复制夹具到临时工程。 */
async function makeProject() {
  const root = await mkdtemp(join(tmpdir(), 'opencut-motion-'));
  const dir = join(root, 'motion-wire');
  await cp(FIXTURE, dir, { recursive: true });
  return {
    dir,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** @param {string} dir */
async function docOf(dir) {
  const text = await readFile(join(dir, 'film.html'), 'utf8');
  const parsed = parse(text);
  assert.equal(parsed.diagnostics.filter((item) => item.severity === 'error').length, 0, JSON.stringify(parsed.diagnostics));
  return parsed.doc;
}

test('B1 适配层：library.json → MotionEntryView[]（参数拍平、缺源标出来）', async () => {
  const project = await makeProject();
  try {
    const view = await libraryView(project.dir);
    assert.equal(view.ok, true);
    assert.equal(view.exists, true);
    assert.equal(view.corrupt, false);
    assert.equal(view.entries.length, 2);

    const ok = view.entries.find((entry) => entry.id === 'motion_pop');
    assert.equal(ok.name, '弹入卡片');
    assert.equal(ok.kind, 'animation');
    assert.equal(ok.sourceOk, true);
    assert.deepEqual(ok.assetIssues, []);
    assert.deepEqual(
      ok.params.map((param) => ({ name: param.name, label: param.label, type: param.type })),
      [
        { name: 'speed', label: '速度', type: 'number' },
        { name: 'accent', label: '强调色', type: 'color' },
        { name: 'title', label: '标题文本', type: 'string' },
      ],
    );
    assert.deepEqual(
      { min: ok.params[0].min, max: ok.params[0].max, step: ok.params[0].step, default: ok.params[0].default },
      { min: 0.5, max: 3, step: 0.1, default: 1 },
    );
    assert.equal(ok.params[1].default, '#3b82f6');

    const gone = view.entries.find((entry) => entry.id === 'motion_gone');
    assert.equal(gone.sourceOk, false);
  } finally {
    await project.cleanup();
  }
});

test('B4 空库：没有 motion/library.json → {entries:[], exists:false}，不是错误', async () => {
  const project = await makeProject();
  try {
    await rm(join(project.dir, 'motion'), { recursive: true, force: true });
    const view = await libraryView(project.dir);
    assert.equal(view.ok, true);
    assert.equal(view.exists, false);
    assert.deepEqual(view.entries, []);
  } finally {
    await project.cleanup();
  }
});

test('B2 应用：参数折成 overrides（--speed/--accent + t 文本）+ 一批 props Op', async () => {
  const project = await makeProject();
  try {
    // 规划前先把「片段自有 fade + 别人的层覆盖」放进去：宿主必须保住它们。
    const doc = await docOf(project.dir);
    doc.tracks[0].clips[0].fade = [0.2, 0];
    doc.tracks[0].clips[0].overrides = [{ fade: [0.2, 0] }, { at: '#note', t: '别人的覆盖' }];
    const planned = await planMotionApply({
      project: { dir: project.dir },
      doc,
      clipId: 'm-card',
      entryId: 'motion_pop',
      params: { speed: 1.8, accent: '#ff8800', title: '动效已应用' },
    });
    assert.equal(planned.ok, true, JSON.stringify(planned));
    assert.equal(planned.scope, 'instance');
    assert.equal(planned.rootAt, '[data-instance="m-card"]');
    assert.deepEqual(planned.overrides, [
      { at: '[data-instance="m-card"]', style: { '--speed': '1.8', '--accent': '#ff8800' } },
      { at: '[data-instance="m-card"] h1', t: '动效已应用' },
    ]);
    assert.equal(planned.ops.length, 1);
    assert.equal(planned.ops[0].op, 'props');
    assert.equal(planned.ops[0].edits[1].prop, 'props');
    assert.match(planned.ops[0].edits[1].value, /"template":"motion_pop"/);

    // Op 真能落到 doc 上（props 通道），片段自有 fade / 别人的层覆盖不被吃掉。
    const after = applyOps(doc, planned.ops);
    const clip = after.tracks[0].clips[0];
    assert.deepEqual(planned.ops[0].edits[0], { clip: 'm-card', prop: 'overrides', value: clip.overrides });
    assert.deepEqual(clip.overrides, [
      { fade: [0.2, 0] },
      { at: '#note', t: '别人的覆盖' },
      { at: '[data-instance="m-card"]', style: { '--speed': '1.8', '--accent': '#ff8800' } },
      { at: '[data-instance="m-card"] h1', t: '动效已应用' },
    ]);
  } finally {
    await project.cleanup();
  }
});

test('应用：重复应用只替换自己的条目（不叠加）', async () => {
  const project = await makeProject();
  try {
    const doc = await docOf(project.dir);
    const first = await planMotionApply({
      project: { dir: project.dir },
      doc,
      clipId: 'm-card',
      entryId: 'motion_pop',
      params: { speed: 1.2, accent: '#3b82f6', title: 'A' },
    });
    const once = applyOps(doc, first.ops);
    const second = await planMotionApply({
      project: { dir: project.dir },
      doc: once,
      clipId: 'm-card',
      entryId: 'motion_pop',
      params: { speed: 2, accent: '#3b82f6', title: 'B' },
    });
    const twice = applyOps(once, second.ops);
    const list = twice.tracks[0].clips[0].overrides;
    assert.equal(list.length, 2, JSON.stringify(list));
    assert.equal(list[0].style['--speed'], '2');
    assert.equal(list[1].t, 'B');
  } finally {
    await project.cleanup();
  }
});

test('应用报码：模板不存在 / 源缺失 / 参数非法 / 片段类型不对', async () => {
  const project = await makeProject();
  try {
    const doc = await docOf(project.dir);
    const base = { project: { dir: project.dir }, doc, clipId: 'm-card' };

    assert.equal((await planMotionApply({ ...base, entryId: 'nope', params: {} })).code, 'MOTION_TEMPLATE_MISSING');
    assert.equal((await planMotionApply({ ...base, entryId: 'motion_gone', params: {} })).code, 'MOTION_SOURCE_MISSING');

    const bad = await planMotionApply({ ...base, entryId: 'motion_pop', params: { speed: 9, accent: '#fff', title: 'x' } });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'MOTION_INVALID_PARAM');
    assert.equal(bad.issues[0].key, 'speed');

    // 视频片段不接受动效参数（参数只会落到场景文档里）
    const videoDoc = structuredClone(doc);
    videoDoc.tracks[0].clips[0].kind = 'video';
    const wrongKind = await planMotionApply({ ...base, doc: videoDoc, entryId: 'motion_pop', params: {} });
    assert.equal(wrongKind.code, 'MOTION_CLIP_UNSUPPORTED');
  } finally {
    await project.cleanup();
  }
});

test('场景没有 data-instance → 退到 body（CSS 变量继承，参数照样生效）', async () => {
  const project = await makeProject();
  try {
    const scenePath = join(project.dir, 'scenes', 'card.html');
    const html = await readFile(scenePath, 'utf8');
    await writeFile(scenePath, html.replace(' data-instance="m-card"', ''), 'utf8');
    const planned = await planMotionApply({
      project: { dir: project.dir },
      doc: await docOf(project.dir),
      clipId: 'm-card',
      entryId: 'motion_pop',
      params: { speed: 1.5, accent: '#123456', title: '退到 body' },
    });
    assert.equal(planned.ok, true, JSON.stringify(planned));
    assert.equal(planned.scope, 'body');
    assert.equal(planned.rootAt, 'body');
    assert.equal(planned.overrides[0].at, 'body');
    assert.equal(planned.overrides[1].at, 'body h1');
  } finally {
    await project.cleanup();
  }
});
