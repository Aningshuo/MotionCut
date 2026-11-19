// @ts-nocheck —— 测试以运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * P41：兼容像素格式（`--pix-fmt`）。
 *
 * 两条硬约束：
 * 1. `auto` 必须**原样**返回档位表的值，且 `videoEncodeArgs` 与 R22/R23 逐项相同
 *    —— 默认产物 sha 就是靠这个守住的；
 * 2. `420`/`444` 要按编码器收敛 profile：只换 `-pix_fmt` 不钉 profile 的话，
 *    libx264 会自己挑 High，但 libx265/libvpx 的 profile 不能靠猜。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PIX_FMT_MODES,
  PixFmtError,
  applyPixFmt,
  naturalProfile,
  resolveCodec,
  resolvePixFmtMode,
  videoEncodeArgs,
} from '../codec-matrix.mjs';
import { QUALITY_LEVELS, resolveQuality } from '../quality.mjs';

const h264 = resolveCodec('h264');
const hevc = resolveCodec('hevc');
const vp9 = resolveCodec('vp9');
const prores = resolveCodec('prores422hq');

/** @param {string} name */
const settingsOf = (name) => {
  const level = resolveQuality(name);
  return { crf: level.crf, preset: level.preset, pixFmt: level.pixFmt };
};

test('P41：--pix-fmt 只认 auto|420|444（未知值 INVALID）', () => {
  assert.deepEqual([...PIX_FMT_MODES], ['auto', '420', '444']);
  assert.equal(resolvePixFmtMode(undefined), 'auto');
  assert.equal(resolvePixFmtMode('auto'), 'auto');
  assert.equal(resolvePixFmtMode('420'), '420');
  assert.equal(resolvePixFmtMode('444'), '444');
  assert.equal(resolvePixFmtMode(''), 'auto');
  // 空串按"没给"处理（缺省 auto）；认不出的值一律 INVALID
  for (const bad of ['4200', 'yuv420p', 'AUTO', '4:2:0']) {
    assert.throws(() => resolvePixFmtMode(bad), (err) => err instanceof PixFmtError && err.code === 'INVALID', bad);
  }
});

test('P41：auto 原样返回档位表（standard 仍是 yuv444p / crf 8 / medium）', () => {
  for (const name of ['draft', 'standard', 'high']) {
    const base = settingsOf(name);
    const applied = applyPixFmt(h264, 'auto', base);
    assert.equal(applied.pixFmt, base.pixFmt, `${name} pixFmt`);
    assert.equal(applied.crf, base.crf, `${name} crf`);
    assert.equal(applied.preset, base.preset, `${name} preset`);
    assert.deepEqual(applied.profileArg, [], `${name} 不能追加 -profile:v`);
    assert.equal(applied.profile, name === 'draft' ? 'High' : 'High 4:4:4 Predictive');
  }
});

test('P41：h264 的 auto args 与 R22 逐项相同（顺序也一样）', () => {
  const base = settingsOf('standard');
  const args = videoEncodeArgs(h264, applyPixFmt(h264, 'auto', base));
  assert.deepEqual(args, [
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '8', '-pix_fmt', 'yuv444p',
  ]);
  const draft = videoEncodeArgs(h264, applyPixFmt(h264, 'auto', settingsOf('draft')));
  assert.deepEqual(draft, ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p']);
});

test('P41：420 按编码器收敛 profile（h264=High / hevc=Main / vp9=Profile 0）', () => {
  const h = applyPixFmt(h264, '420', settingsOf('standard'));
  assert.equal(h.pixFmt, 'yuv420p');
  assert.deepEqual(h.profileArg, ['-profile:v', 'high']);
  assert.equal(h.profile, 'High');
  const args = videoEncodeArgs(h264, h);
  assert.deepEqual(args.slice(-4), ['-pix_fmt', 'yuv420p', '-profile:v', 'high']);

  const x = applyPixFmt(hevc, '420', settingsOf('standard'));
  assert.equal(x.pixFmt, 'yuv420p');
  assert.deepEqual(x.profileArg, ['-profile:v', 'main']);
  assert.equal(x.profile, 'Main');
  // hevc 的 hvc1 tag 不能被 profile 参数挤掉
  assert.ok(videoEncodeArgs(hevc, x).includes('hvc1'));

  const v = applyPixFmt(vp9, '420', settingsOf('standard'));
  assert.equal(v.pixFmt, 'yuv420p');
  assert.deepEqual(v.profileArg, ['-profile:v', '0']);
  assert.equal(v.profile, 'Profile 0');
});

test('P41：444 也钉 profile（h264=high444 / vp9=1 / hevc 交给 x265）', () => {
  assert.deepEqual(applyPixFmt(h264, '444', settingsOf('draft')).profileArg, ['-profile:v', 'high444']);
  assert.equal(applyPixFmt(h264, '444', settingsOf('draft')).pixFmt, 'yuv444p');
  assert.deepEqual(applyPixFmt(vp9, '444', settingsOf('draft')).profileArg, ['-profile:v', '1']);
  assert.deepEqual(applyPixFmt(hevc, '444', settingsOf('draft')).profileArg, []);
  // ffprobe 对 HEVC 4:4:4 报 "Rext"；plan 与回读必须同一个词
  assert.equal(applyPixFmt(hevc, '444', settingsOf('draft')).profile, 'Rext');
});

test('P41：prores422hq 不吃 --pix-fmt（E_USAGE，不是静默忽略）', () => {
  for (const mode of ['420', '444']) {
    assert.throws(
      () => applyPixFmt(prores, mode, { crf: null, preset: null, pixFmt: 'yuv422p10le' }),
      (err) => err instanceof PixFmtError && err.code === 'E_USAGE',
      mode,
    );
  }
  // auto 仍然正常（prores 自己的 yuv422p10le）
  const auto = applyPixFmt(prores, 'auto', { crf: null, preset: null, pixFmt: 'yuv422p10le' });
  assert.equal(auto.pixFmt, 'yuv422p10le');
  assert.equal(auto.profile, 'HQ');
});

test('P41：档位表本身没有被 --pix-fmt 改动', () => {
  assert.equal(QUALITY_LEVELS.draft.pixFmt, 'yuv420p');
  assert.equal(QUALITY_LEVELS.standard.pixFmt, 'yuv444p');
  assert.equal(QUALITY_LEVELS.high.pixFmt, 'yuv444p');
  assert.equal(QUALITY_LEVELS.standard.crf, 8);
});

test('P41：naturalProfile 是 ffprobe 会报的名字（给 plan/结果）', () => {
  assert.equal(naturalProfile(h264, 'yuv420p'), 'High');
  assert.equal(naturalProfile(h264, 'yuv444p'), 'High 4:4:4 Predictive');
  assert.equal(naturalProfile(hevc, 'yuv420p'), 'Main');
  assert.equal(naturalProfile(hevc, 'yuv444p'), 'Rext');
  assert.equal(naturalProfile(vp9, 'yuv420p'), 'Profile 0');
  assert.equal(naturalProfile(vp9, 'yuv444p'), 'Profile 1');
  assert.equal(naturalProfile(prores, 'yuv422p10le'), 'HQ');
});
