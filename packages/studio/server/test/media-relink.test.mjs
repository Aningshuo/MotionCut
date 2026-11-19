// @ts-nocheck —— 运行时断言为准；产品模块仍由 tsc（checkJs）严格检查。
/**
 * 素材缺失 / 重链的纯函数单测（M26 · B-MAIN-R13-013）。
 *
 * 真落盘 / 一步撤销 / 批量确认 / 导出守门 由 `scripts/m26-relink.mjs` 在真 Studio 上验；
 * 这里只测判据：怎么判 missing / unreadable、怎么保 `#t=`、什么情况报什么码。
 */

import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { mediaStatusOf, planRelink, relativeOf, scanRelinkDir } from '../media-relink.mjs';

const MEDIA = resolve(import.meta.dirname, '../../../../tests/fixtures/media');

/** 造一个工程目录：几个真实素材 + 一个缺失 + 一个坏文件。 */
async function projectFixture(label) {
  const root = await mkdtemp(join(tmpdir(), `opencut-${label}-`));
  const dir = join(root, 'proj');
  await mkdir(join(dir, 'assets'), { recursive: true });
  await copyFile(join(MEDIA, 'transition-a-light-3s-720p30.mp4'), join(dir, 'assets/full.mp4'));
  await copyFile(join(MEDIA, 'insert-1s-720p30.mp4'), join(dir, 'assets/short.mp4'));
  await copyFile(join(MEDIA, 'tone-1khz-3s.wav'), join(dir, 'assets/tone.wav'));
  await copyFile(join(MEDIA, 'still-green-640x360.png'), join(dir, 'assets/still.png'));
  await writeFile(join(dir, 'assets/broken.mp4'), 'not really a video', 'utf8');
  return { root, dir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** @param {string} dir */
function docOf(dir) {
  return {
    stage: { w: 1280, h: 720 },
    fps: { num: 30, den: 1 },
    tracks: [
      {
        index: 0,
        role: 'picture',
        clips: [
          { id: 'c-full', kind: 'video', src: 'assets/full.mp4#t=0,2', at: 0, time: [0, 2] },
          { id: 'c-gone', kind: 'video', src: 'assets/missing.mp4#t=0,2', at: 2, time: [0, 2] },
          { id: 'c-broken', kind: 'video', src: 'assets/broken.mp4#t=0,2', at: 4, time: [0, 2] },
          { id: 'c-sound', kind: 'sound', src: 'assets/tone.wav#t=0,3', at: 0, time: [0, 3] },
          { id: 'c-still', kind: 'still', src: 'assets/still.png#t=0,2', at: 6, time: [0, 2] },
          { id: 'c-page', kind: 'page', src: 'scenes/page.html#t=0,2', at: 8, time: [0, 2] },
        ],
      },
    ],
  };
}

test('A1 缺失检测：ok / missing / unreadable 三态；页面片段不参与', async () => {
  const project = await projectFixture('status');
  try {
    const { items, summary } = await mediaStatusOf({ project, doc: docOf(project.dir) });
    const bySrc = Object.fromEntries(items.map((item) => [item.src, item]));
    assert.equal(bySrc['assets/full.mp4'].status, 'ok');
    assert.equal(bySrc['assets/missing.mp4'].status, 'missing');
    assert.equal(bySrc['assets/broken.mp4'].status, 'unreadable');
    assert.equal(bySrc['assets/tone.wav'].status, 'ok');
    assert.equal(bySrc['assets/still.png'].status, 'ok');
    assert.equal(bySrc['assets/still.png'].durationSec, null, '静帧没有内在时长');
    assert.equal(bySrc['scenes/page.html'], undefined, '页面片段不是素材文件');
    assert.deepEqual(summary, { total: 5, ok: 3, missing: 1, unreadable: 1 });
    assert.deepEqual(bySrc['assets/full.mp4'].clips, ['c-full']);
  } finally {
    await project.cleanup();
  }
});

test('A2 重链保留 #t= 与 at：只换文件名', async () => {
  const project = await projectFixture('relink');
  try {
    const plan = await planRelink({
      project,
      doc: docOf(project.dir),
      targets: [{ clip: 'c-gone', src: join(project.dir, 'assets/full.mp4') }],
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.ops.length, 1);
    assert.deepEqual(plan.ops[0].edits, [{ clip: 'c-gone', prop: 'src', value: 'assets/full.mp4#t=0,2' }]);
    assert.equal(plan.applied[0].to, 'assets/full.mp4#t=0,2');
    assert.equal(plan.applied[0].sizeUnverified, true, '旧文件不在了：尺寸如实标未验证');
    assert.deepEqual(plan.warnings.map((item) => item.code), ['RELINK_SIZE_UNVERIFIED']);
  } finally {
    await project.cleanup();
  }
});

test('A3 新素材更短 → RELINK_DURATION_SHORT + 建议区间，0 个 Op', async () => {
  const project = await projectFixture('short');
  try {
    const plan = await planRelink({
      project,
      doc: docOf(project.dir),
      targets: [{ clip: 'c-full', src: 'assets/short.mp4' }],
    });
    assert.equal(plan.ok, false);
    assert.equal(plan.code, 'RELINK_DURATION_SHORT');
    assert.equal(plan.ops.length, 0);
    assert.deepEqual(plan.rejected[0].suggest, { trim: [0, 1], availableSec: 1 });
  } finally {
    await project.cleanup();
  }
});

test('A4 类型不匹配：视频片段塞音频/静帧都要报码', async () => {
  const project = await projectFixture('kind');
  try {
    const toSound = await planRelink({ project, doc: docOf(project.dir), targets: [{ clip: 'c-full', src: 'assets/tone.wav' }] });
    assert.equal(toSound.ok, false);
    assert.equal(toSound.rejected[0].code, 'RELINK_KIND_MISMATCH');
    const toStill = await planRelink({ project, doc: docOf(project.dir), targets: [{ clip: 'c-full', src: 'assets/still.png' }] });
    assert.equal(toStill.rejected[0].code, 'RELINK_KIND_MISMATCH');
    // 声音片段：静帧不行；**没有音轨的视频**也不行（<audio src="x.mp4"> 要的是那条音轨）
    const soundToStill = await planRelink({ project, doc: docOf(project.dir), targets: [{ clip: 'c-sound', src: 'assets/still.png' }] });
    assert.equal(soundToStill.rejected[0].code, 'RELINK_KIND_MISMATCH');
    const soundToVideo = await planRelink({ project, doc: docOf(project.dir), targets: [{ clip: 'c-sound', src: 'assets/full.mp4' }] });
    assert.equal(soundToVideo.ok, false);
    assert.equal(soundToVideo.rejected[0].code, 'RELINK_KIND_MISMATCH');
    assert.match(soundToVideo.rejected[0].message, /有音轨/);
  } finally {
    await project.cleanup();
  }
});

test('目录越界与坏文件：拒绝且不写 Op', async () => {
  const project = await projectFixture('escape');
  try {
    const outside = await planRelink({ project, doc: docOf(project.dir), targets: [{ clip: 'c-gone', src: '/tmp/whatever.mp4' }] });
    assert.equal(outside.rejected[0].code, 'RELINK_OUTSIDE_PROJECT');
    const broken = await planRelink({ project, doc: docOf(project.dir), targets: [{ clip: 'c-gone', src: 'assets/broken.mp4' }] });
    assert.equal(broken.rejected[0].code, 'RELINK_UNREADABLE');
    const missing = await planRelink({ project, doc: docOf(project.dir), targets: [{ clip: 'c-gone', src: 'assets/nope.mp4' }] });
    assert.equal(missing.rejected[0].code, 'RELINK_SOURCE_MISSING');
  } finally {
    await project.cleanup();
  }
});

test('部分被拒 → 整批不执行（不出现改了一半）', async () => {
  const project = await projectFixture('partial');
  try {
    const plan = await planRelink({
      project,
      doc: docOf(project.dir),
      targets: [
        { clip: 'c-gone', src: 'assets/full.mp4' },
        { clip: 'c-broken', src: 'assets/tone.wav' },
      ],
    });
    assert.equal(plan.ok, false);
    assert.equal(plan.code, 'RELINK_PARTIAL');
    assert.equal(plan.ops.length, 0);
    assert.equal(plan.applied.length, 1);
    assert.equal(plan.rejected.length, 1);
  } finally {
    await project.cleanup();
  }
});

test('A5 批量重链：5 个缺失里 3 个同名可匹配 → 3 将重链 / 2 跳过', async () => {
  const project = await projectFixture('batch');
  try {
    const doc = {
      stage: { w: 1280, h: 720 },
      fps: { num: 30, den: 1 },
      tracks: [
        {
          index: 0,
          role: 'picture',
          clips: [
            { id: 'b1', kind: 'video', src: 'assets/one.mp4#t=0,2', at: 0, time: [0, 2] },
            { id: 'b2', kind: 'video', src: 'assets/two.mp4#t=0,2', at: 2, time: [0, 2] },
            { id: 'b3', kind: 'video', src: 'assets/three.mp4#t=0,2', at: 4, time: [0, 2] },
            { id: 'b4', kind: 'video', src: 'assets/four.mp4#t=0,2', at: 6, time: [0, 2] },
            { id: 'b5', kind: 'video', src: 'assets/five.mp4#t=0,2', at: 8, time: [0, 2] },
            { id: 'b6', kind: 'video', src: 'assets/full.mp4#t=0,2', at: 10, time: [0, 2] },
          ],
        },
      ],
    };
    // 候选目录：只有 one/two/three 三个同名文件。
    const found = join(project.root, 'found');
    await mkdir(found, { recursive: true });
    await copyFile(join(MEDIA, 'transition-a-light-3s-720p30.mp4'), join(found, 'one.mp4'));
    await copyFile(join(MEDIA, 'transition-a-light-3s-720p30.mp4'), join(found, 'two.mp4'));
    await copyFile(join(MEDIA, 'transition-a-light-3s-720p30.mp4'), join(found, 'three.mp4'));
    const scanned = await scanRelinkDir({ project, doc, dir: found });
    assert.equal(scanned.ok, true);
    assert.deepEqual(scanned.summary, { relink: 3, skip: 2 });
    assert.deepEqual(scanned.matched.map((item) => item.clip), ['b1', 'b2', 'b3']);
    // 候选目录在工程外：标 copy，newSrc 仍是工程内相对路径（assets/…）
    assert.deepEqual(scanned.matched.map((item) => item.copy), [true, true, true]);
    assert.deepEqual(scanned.matched.map((item) => item.newSrc), [
      'assets/relinked/one.mp4#t=0,2',
      'assets/relinked/two.mp4#t=0,2',
      'assets/relinked/three.mp4#t=0,2',
    ]);
    assert.deepEqual(scanned.skipped.map((item) => item.reason).sort(), ['NO_SAME_NAME', 'NO_SAME_NAME']);
    assert.deepEqual(scanned.skipped.map((item) => item.clip).sort(), ['b4', 'b5']);
  } finally {
    await project.cleanup();
  }
});

test('relativeOf：工程内 → 相对路径；越界 / .film → null', async () => {
  const project = await projectFixture('rel');
  try {
    assert.equal(relativeOf(project, join(project.dir, 'assets/full.mp4')), 'assets/full.mp4');
    assert.equal(relativeOf(project, join(project.dir, '.film/history/x.html')), null);
    assert.equal(relativeOf(project, '/tmp/out.mp4'), null);
  } finally {
    await project.cleanup();
  }
});
