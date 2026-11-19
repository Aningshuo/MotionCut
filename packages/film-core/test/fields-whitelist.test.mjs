/**
 * M80 · `fields` op 的键白名单（B-MAIN-R30-039）。
 *
 * 守的是「错误出现得早」：以前 `{op:'fields', fields:{opacity:0.5}}` 会一路通过 ops，
 * 到写回层才被 M77 的键闸门拒掉 —— CLI / Agent 先以为成功。现在 ops 层就 INVALID，
 * 并且指到 `tracks[i].clips[j].field` + 给出 `allowed` 列表。
 *
 * 同时钉住两条不能破的边：
 * - 合法键行为不变（同值写回 changed=false、film.html 逐字节不变）；
 * - 元素类型真的有差别（纯音频没有几何、字幕没有几何）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse, sha256, writeValue } from '../film-doc.mjs';
import { EditError, applyOpsDetailed, fieldsAllowedFor } from '../ops.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const fixtureText = readFileSync(join(repo, 'tests', 'fixtures', 'main', 'film-basic.html'), 'utf8');
const fixtureHash = sha256(fixtureText);

/** @returns {any} */
function fixtureDoc() {
  const parsed = parse(fixtureText, { path: 'film-basic.html' });
  assert.equal(parsed.doc === null, false, JSON.stringify(parsed.diagnostics));
  return parsed.doc;
}

/**
 * 跑一条 fields op，返回抛出的 EditError（没抛就断言失败）。
 * @param {any[]} ops
 * @returns {any}
 */
function rejected(ops) {
  try {
    applyOpsDetailed(fixtureDoc(), ops);
  } catch (error) {
    assert.ok(error instanceof EditError, `不是 EditError：${String(error)}`);
    assert.equal(error.code, 'INVALID');
    return error;
  }
  assert.fail('这条 Op 应该被拒，但通过了');
}

test('F1 几何未知键：video 上的 opacity 被拒，field 指到 tracks[0].clips[0].opacity', () => {
  const error = rejected([{ op: 'fields', clip: 'c1', fields: { opacity: 0.5 } }]);
  assert.equal(error.field, 'tracks[0].clips[0].opacity');
  assert.ok(Array.isArray(error.allowed));
  assert.ok(error.allowed.includes('box'), 'allowed 应包含 box');
  assert.ok(error.allowed.includes('size'), 'allowed 应包含 size');
  assert.ok(!error.allowed.includes('opacity'));
  // HTTP 只转发 message：字段路径与 allowed 必须都在文案里
  assert.ok(error.message.includes('tracks[0].clips[0].opacity'), error.message);
  assert.ok(error.message.includes('box'), error.message);
});

test('F2 排印未知键：fontSize / fontFamily 必须走 style，不能直接挂在片段上', () => {
  for (const key of ['fontSize', 'fontFamily', 'lineHeight']) {
    const error = rejected([{ op: 'fields', clip: 'c1', fields: { [key]: '44px' } }]);
    assert.equal(error.field, `tracks[0].clips[0].${key}`);
    assert.ok(error.allowed.includes('style'), `${key}: allowed 应包含 style`);
    assert.ok(!error.allowed.includes(key));
  }
});

test('F3 外观未知键：colour / shadow 被拒', () => {
  for (const key of ['colour', 'shadow', 'blur']) {
    const error = rejected([{ op: 'fields', clip: 'c2', fields: { [key]: true } }]);
    assert.equal(error.field, `tracks[0].clips[1].${key}`);
    assert.ok(error.allowed.includes('attrs'));
  }
});

test('F4 合法键全部通过（几何/排印/外观/时间/音轨/来源）', () => {
  const ops = [
    {
      op: 'fields',
      clip: 'c1',
      fields: {
        box: { x: 10, y: 20, w: 640, h: 360 },
        size: { w: 640, h: 360 },
        // `style` 在值模型里是**字符串**（CSS 声明串），不是对象：写回要逐字节原样。
        style: 'opacity: 0.9',
        overrides: [{ at: '#title', t: '标题' }],
        fade: [0.2, 0.2],
        link: 'cut-1',
        attrs: { 'data-props': '{}' },
        speed: 1,
        volume: 0.8,
        muted: false,
      },
    },
  ];
  const applied = applyOpsDetailed(fixtureDoc(), ops);
  const clip = applied.value.tracks[0].clips[0];
  assert.deepEqual(clip.box, { x: 10, y: 20, w: 640, h: 360 });
  assert.equal(clip.style, 'opacity: 0.9');
  assert.equal(clip.speed, 1);
  assert.equal(clip.volume, 0.8);
  assert.equal(clip.muted, false);
});

test('F5 合法路径逐字节不变：把现值原样写回 → changed=false，film.html sha 不变', () => {
  const doc = fixtureDoc();
  const clip = doc.tracks[0].clips[0];
  const same = {
    volume: clip.volume,
    at: clip.at,
    time: clip.time,
    box: clip.box ?? null,
    style: clip.style ?? null,
  };
  const applied = applyOpsDetailed(doc, [{ op: 'fields', clip: 'c1', fields: same }]);
  const written = writeValue(fixtureText, applied.value, fixtureHash);
  assert.equal(written.ok, true, JSON.stringify(written.diagnostics ?? []));
  assert.equal(written.changed, false, '同值写回不该改文件');
  assert.equal(written.text, fixtureText);
  assert.equal(written.sourceHash, fixtureHash);
});

test('F6 overrides 与 fields 混批：两条都生效，一次写回', () => {
  const applied = applyOpsDetailed(fixtureDoc(), [
    { op: 'fields', clip: 'c1', fields: { box: { x: 1, y: 2, w: 3, h: 4 } } },
    { op: 'set', clip: 'c1', field: 'overrides', value: [{ at: '#title', t: '混批' }] },
  ]);
  const clip = applied.value.tracks[0].clips[0];
  assert.deepEqual(clip.box, { x: 1, y: 2, w: 3, h: 4 });
  assert.deepEqual(clip.overrides, [{ at: '#title', t: '混批' }]);
  const written = writeValue(fixtureText, applied.value, fixtureHash);
  assert.equal(written.ok, true, JSON.stringify(written.diagnostics ?? []));
  assert.equal(written.changed, true);
});

test('F7 元素类型差别：纯音频没有几何（box 被拒），但有音轨键', () => {
  const error = rejected([{ op: 'fields', clip: 'a1', fields: { box: { x: 0, y: 0, w: 10, h: 10 } } }]);
  assert.equal(error.field, 'tracks[1].clips[0].box');
  assert.ok(!error.allowed.includes('box'), `audio 的 allowed 不该有 box：${error.allowed.join(',')}`);
  assert.ok(error.allowed.includes('volume'));
  assert.ok(error.allowed.includes('muted'));

  // 同一个键在 video 上合法
  const ok = applyOpsDetailed(fixtureDoc(), [{ op: 'fields', clip: 'c1', fields: { box: { x: 0, y: 0, w: 10, h: 10 } } }]);
  assert.deepEqual(ok.value.tracks[0].clips[0].box, { x: 0, y: 0, w: 10, h: 10 });
});

test('F8 已经在该片段上的键永远允许（撤销/重做要能原样写回）', () => {
  const doc = fixtureDoc();
  // 模拟旧文档里带着一个当前白名单没有的键：撤销/重做必须还能把它写回去。
  doc.tracks[0].clips[0].legacyFlag = 'keep-me';
  const applied = applyOpsDetailed(doc, [
    { op: 'fields', clip: 'c1', fields: { legacyFlag: 'keep-me' } },
  ]);
  assert.equal(applied.value.tracks[0].clips[0].legacyFlag, 'keep-me');

  // 同一个键在**没有**它的片段上仍是新增键 → 白名单照拒。
  const error = rejected([{ op: 'fields', clip: 'c2', fields: { legacyFlag: 'x' } }]);
  assert.equal(error.field, 'tracks[0].clips[1].legacyFlag');
});

test('F9 fields 不是对象 → INVALID（不静默当成空补丁）', () => {
  for (const fields of [null, 'x', ['box']]) {
    const error = rejected([{ op: 'fields', clip: 'c1', fields }]);
    assert.ok(error.message.includes('fields'), error.message);
  }
});

test('F10 fieldsAllowedFor：五类元素的 allowed 与分组表一致', () => {
  const video = fieldsAllowedFor('video');
  const sound = fieldsAllowedFor('sound');
  const subtitle = fieldsAllowedFor('subtitle');
  const page = fieldsAllowedFor('page');
  const still = fieldsAllowedFor('still');
  for (const key of ['box', 'size', 'style', 'overrides', 'attrs', 'fade', 'link', 'at', 'time', 'speed', 'volume', 'muted', 'src']) {
    assert.ok(video.includes(key), `video 缺少 ${key}`);
    assert.ok(page.includes(key), `page 缺少 ${key}`);
    assert.ok(still.includes(key), `still 缺少 ${key}`);
  }
  assert.ok(!sound.includes('box'));
  assert.ok(!sound.includes('style'));
  assert.ok(subtitle.includes('style'));
  assert.ok(!subtitle.includes('box'));
  // 未知类型按画面类处理（不因为 kind 写错就拒掉整批）
  assert.deepEqual(fieldsAllowedFor('nope'), video);
});
