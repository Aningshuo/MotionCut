// @ts-nocheck
/**
 * M50 阶段与编码（B-MAIN-R26-026）：纯逻辑单测，不起浏览器、不跑 ffmpeg。
 *
 * 盯四件事：
 *   1. 阶段表：`burn` 在 `video` 与 `mux` 之间；原有六个阶段的**相对顺序**没变。
 *   2. 默认 bands：不取帧、不烧录时与 R20/M42 的常量**逐值相同**（A4 的零漂移底座）。
 *   3. 四种组合的 bands 都单调、不重叠、覆盖到 1，键序与阶段序一致。
 *   4. 编码：缺省 h264；hevc 透传；非法值在 HTTP 层拒（这里只验白名单常量与 start 兜底）。
 */

import assert from 'node:assert/strict';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  EXPORT_CODECS,
  EXPORT_REQUEST_FIELDS,
  EXPORT_STAGES,
  createExportJobs,
  exportBandsFor,
} from '../export-job.mjs';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const PROJECT_DIR = fssync.mkdtempSync(path.join(os.tmpdir(), 'opencut-phases-test-'));

/** 受控 runner：只把作业跑完，不碰 ffmpeg。 */
async function fakeRunner(job) {
  await sleep(5);
  job.percent = 1;
  job.stage = 'done';
  job.state = 'done';
  job.output = { path: `/tmp/${job.id}.mp4`, bytes: 1, sha256: 'x' };
}

test('阶段表：burn 夹在 video 与 mux 之间，原有顺序不变', () => {
  assert.deepEqual(EXPORT_STAGES, ['plan', 'capture', 'video', 'burn', 'mux', 'verify', 'done']);
  assert.ok(EXPORT_STAGES.indexOf('burn') > EXPORT_STAGES.indexOf('video'));
  assert.ok(EXPORT_STAGES.indexOf('burn') < EXPORT_STAGES.indexOf('mux'));
});

test('A4 底座：不取帧不烧录的 bands 与 R20 常量逐值相同', () => {
  assert.deepEqual(exportBandsFor({ scenes: false, burn: false }), {
    plan: [0, 0.05],
    video: [0.05, 0.86],
    mux: [0.86, 0.93],
    verify: [0.93, 0.99],
    done: [1, 1],
  });
});

test('四种组合的 bands：键序 = 阶段序，单调不重叠，收在 1', () => {
  const combos = [
    { scenes: false, burn: false },
    { scenes: true, burn: false },
    { scenes: false, burn: true },
    { scenes: true, burn: true },
  ];
  for (const combo of combos) {
    const bands = exportBandsFor(combo);
    const keys = Object.keys(bands);
    // 键序必须是阶段表的子序列（setStage 靠 EXPORT_STAGES 判前后，乱序会卡住百分比）。
    const order = keys.map((key) => EXPORT_STAGES.indexOf(key));
    assert.deepEqual(
      order,
      [...order].sort((a, b) => a - b),
      `${JSON.stringify(combo)} 的阶段键序乱了：${keys.join(',')}`,
    );
    // 每个键都在阶段表里；除了 done 都必须有正跨度。
    for (const key of keys) {
      assert.notEqual(EXPORT_STAGES.indexOf(key), -1, `${key} 不在阶段表里`);
      if (key !== 'done') assert.ok(bands[key][1] > bands[key][0], `${key} 跨度必须为正`);
    }
    assert.deepEqual(bands[keys[0]], [0, bands[keys[0]][1]], '第一段必须从 0 开始');
    assert.deepEqual(bands.done, [1, 1], 'done 必须收在 1');
    for (let i = 1; i < keys.length; i += 1) {
      const previous = bands[keys[i - 1]];
      const current = bands[keys[i]];
      assert.ok(current[0] >= previous[1] - 1e-9, `${keys[i]} 与 ${keys[i - 1]} 重叠`);
      // 允许 ≤1% 的空档（R20 基线里 verify 0.99 → done 1 就是 1%），不允许更大的洞。
      assert.ok(current[0] - previous[1] <= 0.011, `${keys[i - 1]} → ${keys[i]} 之间有 ${((current[0] - previous[1]) * 100).toFixed(1)}% 的洞`);
    }
  }
  // 带取帧：capture 段必须是 2% → 35%（A3 的判据）。
  const captured = exportBandsFor({ scenes: true, burn: false });
  assert.deepEqual(captured.capture, [0.02, 0.35]);
  // 带烧录：video 让位给 burn，burn 涨到 93%（A2 的判据）。
  const burned = exportBandsFor({ scenes: false, burn: true });
  assert.deepEqual(burned.video, [0.05, 0.6]);
  assert.deepEqual(burned.burn, [0.6, 0.93]);
});

test('编码白名单：只有 h264/hevc；请求字段里有 codec', () => {
  assert.deepEqual(EXPORT_CODECS, ['h264', 'hevc']);
  assert.ok(EXPORT_REQUEST_FIELDS.includes('codec'));
});

test('codec 入队快照：缺省 h264，hevc 原样透传，非法值兜底 h264', async () => {
  const jobs = createExportJobs({ runner: /** @type {any} */ (fakeRunner) });
  const doc = { tracks: [] };
  const plain = jobs.start({ projectId: 'p', projectDir: PROJECT_DIR, doc });
  assert.equal(plain.ok, true);
  assert.equal(plain.job.codec, 'h264', '不传 codec 必须是 h264');

  const hevc = jobs.start({ projectId: 'p', projectDir: PROJECT_DIR, doc, codec: 'hevc' });
  assert.equal(hevc.ok, true);
  assert.equal(hevc.job.codec, 'hevc');

  // HTTP 层会先 400；万一绕过来，start 也不许把非法值带进作业。
  const bogus = jobs.start({ projectId: 'p', projectDir: PROJECT_DIR, doc, codec: 'av1' });
  assert.equal(bogus.ok, true);
  assert.equal(bogus.job.codec, 'h264');

  await sleep(50);
  assert.equal(jobs.status(plain.job.id).state, 'done');
});
