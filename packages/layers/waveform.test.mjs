// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S35-WAVEFORM 验收 A1..A6
 *
 * 命题：**波形是按真实采样算出来的**，而且缩放到子区间、静音、超满幅、缓存、失败
 * 都有确定行为。
 *
 * A1 三种素材（短 wav / 1 分钟 mp3 / 双声道不同内容）× 三种状态（正常/静音/volume=2）截图，
 *    另加 mp4 音轨可解（任务书要求支持 mp4/m4a 的音轨）。
 * A2 子区间：25% / 50% 子区间 vs **直接解码裁剪文件**，峰值 p99 差 ≤ 2/255；再比一次像素。
 * A3 缓存：二次调用 cached=true、hits/misses、不同 samplesPerSecond 是不同条目、
 *    1200px 命中重绘 < 2ms。
 * A4 1 小时 48k 立体声：首次耗时（解码/降采样分开）、内存、length 与预期分桶数（±1）。
 * A5 失败路径：损坏文件 → DECODE_FAILED；不支持的容器 → UNSUPPORTED_FORMAT；占位截图。
 * A6 确定性：两次独立 loadPeaks 的 min/max sha 相同。
 *
 * 运行：node --test --test-concurrency=1 packages/layers/waveform.test.mjs（env 由 test-env.mjs 自动准备；`OPENCUT_ENV_JSON` 可显式覆盖）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { build as esbuild } from 'esbuild';
import { SceneHost, REPO_ROOT } from '../scene-runtime/host.mjs';
import { resolveLayerTestEnv } from './test-env.mjs';

const TEST_ENV = await resolveLayerTestEnv({ suite: 'waveform' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');
const TMP = path.join(RUN_ROOT, 'tmp/s35');
const AUDIO_TMP = path.join(RUN_ROOT, 'tmp/audio');
const BUNDLE_ABS = path.join(TMP, 'bundle.js');
const BUNDLE_URL = '/' + path.relative(REPO_ROOT, BUNDLE_ABS).split(path.sep).join('/');
const FIXTURE = 'tests/fixtures/scenes/waveform-stage.html';
const MEDIA = '/tests/fixtures/media';
const BATCH = 'B-SUB1-R18-018';

/** 素材：前三个是 A1 的三行，mp4 用来证明「mp4 的音轨也能解」 */
const SOURCES = {
  tone: `${MEDIA}/loud-1khz-3s.wav`,
  mp3: `${MEDIA}/tone-1min-44k1-mono.mp3`,
  stereo: `${MEDIA}/stereo-split-3s.wav`,
  mp4: `${MEDIA}/tone440-light-3s-720p30.mp4`,
  /* 超过 1.0 的 float wav：证明「不夹紧」用的是真素材，不是把 volume 调大 */
  over: `${MEDIA}/over-unity-3s.wav`
};
const ROWS = ['tone', 'mp3', 'stereo'];
const STATES = ['normal', 'muted', 'over'];

/* 1 小时 691MB 的缓存**跟着本 suite 的运行根走**（不再写死 `.local-runs/sub1/runs/R18`）：
   干净克隆第一次由 `ensureHour()` 生成一次，之后复用。
   它同时被当成 URL 用（`'/' + HOUR.rel`，由 SceneHost 的静态服务按 repo 相对路径读），
   所以这里算的是相对仓根的 POSIX 路径。 */
const HOUR = {
  rel: path.relative(REPO_ROOT, path.join(AUDIO_TMP, 'hour-48k-stereo.wav')).split(path.sep).join('/'),
  bytes: 691200078,
  duration: 3600,
  sampleRate: 48000,
  channels: 2,
  expectedBuckets: 360000
};

const evidence = {
  batch: BATCH,
  suite: 'waveform.test.mjs',
  cases: {},
  screenshots: [],
  waveform: {},
  startedAt: new Date().toISOString()
};

/** @type {SceneHost} */
let host;
/** @type {import('playwright').Page} */
let page;
const pageErrors = [];

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const round2 = (n) => Math.round(n * 100) / 100;

async function buildBundle() {
  await fs.mkdir(path.dirname(BUNDLE_ABS), { recursive: true });
  await esbuild({
    stdin: {
      contents: [
        'export { loadPeaks, drawWaveform, getWaveformCacheStats, clearWaveformCache, slicePeaks, computePeaks, isWaveformError, WAVEFORM_VERSION, WAVEFORM_ERROR_CODES } from "./packages/layers/waveform.mjs";'
      ].join('\n'),
      resolveDir: REPO_ROOT,
      loader: 'js'
    },
    bundle: true,
    format: 'iife',
    globalName: 'W35',
    platform: 'browser',
    target: 'es2022',
    outfile: BUNDLE_ABS,
    logLevel: 'silent'
  });
}

/** @param {string[]} args */
function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { cwd: REPO_ROOT, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr: String(stderr) }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/**
 * 裁剪素材：A2 的「直接解码该子区间」这一侧。
 * `-ss` 作为**输入选项**用在 PCM wav 上是样本精确的（0.75s × 48000 = 36000 帧整）。
 */
async function ensureTrimmed() {
  await fs.mkdir(AUDIO_TMP, { recursive: true });
  const src = path.join(REPO_ROOT, SOURCES.tone);
  const jobs = [
    { name: 'trim-quarter.wav', start: 0.75, duration: 0.75 },
    { name: 'trim-half.wav', start: 0.75, duration: 1.5 }
  ];
  const out = [];
  for (const job of jobs) {
    const target = path.join(AUDIO_TMP, job.name);
    try {
      const stat = await fs.stat(target);
      out.push({ file: path.relative(REPO_ROOT, target), bytes: stat.size, reused: true });
      continue;
    } catch {
      /* 没生成过就下面生成 */
    }
    await ffmpeg(['-ss', String(job.start), '-t', String(job.duration), '-i', src, '-c:a', 'pcm_s16le', target]);
    const stat = await fs.stat(target);
    out.push({ file: path.relative(REPO_ROOT, target), bytes: stat.size, start: job.start, duration: job.duration, reused: false });
  }
  return out;
}

async function ensureHour() {
  const abs = path.join(REPO_ROOT, HOUR.rel);
  const existing = await fs.stat(abs).catch(() => null);
  if (existing && existing.size === HOUR.bytes) return { generated: false, bytes: existing.size };
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await ffmpeg([
    '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=3600',
    '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=3600',
    '-filter_complex', '[0:a]volume=0.4[a0];[1:a]volume=0.2[a1];[a0][a1]amerge=inputs=2[out]',
    '-map', '[out]', '-c:a', 'pcm_s16le', abs
  ]);
  const stat = await fs.stat(abs);
  return { generated: true, bytes: stat.size };
}

/** 页面内画一格（dpr=2，画布按 CSS 像素 360×64） */
async function paintCell(mat, state, extra = {}) {
  return page.evaluate(
    ({ mat, state, extra }) => {
      const canvas = document.querySelector(`canvas[data-mat="${mat}"][data-state="${state}"]`);
      const cssW = 360;
      const cssH = 64;
      const dpr = 2;
      canvas.width = cssW * dpr;
      canvas.height = cssH * dpr;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      const peaks = window.__peaks[mat];
      /** @type {any} */
      const opts = { width: cssW, height: cssH, dpr, color: '#38bdf8', overflowColor: '#f87171', background: '#0f172a', ...extra };
      if (state === 'muted') opts.muted = true;
      if (state === 'over') opts.volume = 2;
      return window.W35.drawWaveform(canvas.getContext('2d'), peaks, opts);
    },
    { mat, state, extra }
  );
}

async function shot(name, clip) {
  const target = path.join(EVIDENCE_DIR, name);
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot(clip ? { path: target, clip } : { path: target });
  return { name, bytes: (await fs.stat(target)).size, sha256: sha(await fs.readFile(target)) };
}

/** 一行的外接矩形（三个画布 + 行标签） */
async function rowClip(mat) {
  return page.evaluate((mat) => {
    const label = document.querySelector(`[data-label="${mat}"]`).getBoundingClientRect();
    const cells = [...document.querySelectorAll(`canvas[data-mat="${mat}"]`)].map((el) => el.getBoundingClientRect());
    const x = Math.min(label.x, ...cells.map((r) => r.x));
    const y = Math.min(label.y, ...cells.map((r) => r.y));
    const right = Math.max(label.right, ...cells.map((r) => r.right));
    const bottom = Math.max(label.bottom, ...cells.map((r) => r.bottom));
    return { x: Math.floor(x) - 8, y: Math.floor(y) - 8, width: Math.ceil(right - x) + 16, height: Math.ceil(bottom - y) + 16 };
  }, mat);
}

async function save() {
  evidence.pageErrors = pageErrors;
  evidence.finishedAt = new Date().toISOString();
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(path.join(EVIDENCE_DIR, 's35-waveform.json'), JSON.stringify(evidence, null, 2) + '\n');
}

before(async () => {
  const env = JSON.parse(await fs.readFile(path.join(RUN_ROOT, 'env.json'), 'utf8'));
  evidence.batch = env.batchId ?? evidence.batch;
  await buildBundle();
  evidence.trimmed = await ensureTrimmed();
  evidence.hour = await ensureHour();

  host = await new SceneHost({ port: Number(env.sceneOrigin || env.studioPort), viewport: { width: 1280, height: 1340 } }).start();
  evidence.browser = host.browserVersion;
  const handle = await host.open(FIXTURE);
  page = handle.page;
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.addScriptTag({ url: BUNDLE_URL });
  await page.evaluate(async (sources) => {
    window.__peaks = {};
    for (const [key, src] of Object.entries(sources)) {
      window.__peaks[key] = await window.W35.loadPeaks(src, { samplesPerSecond: 100 });
    }
  }, SOURCES);
});

after(async () => {
  await save();
  if (host) await host.stop();
});

/* ── A1 三种素材 × 三种状态 ─────────────────────────────────────── */

test('A1 三种素材 × 三种状态（正常/静音/volume=2）+ mp4 音轨可解', async () => {
  const facts = {};
  for (const mat of ROWS) {
    facts[mat] = await page.evaluate((mat) => {
      const peaks = window.__peaks[mat];
      return {
        ok: peaks.ok,
        code: peaks.code ?? null,
        length: peaks.length,
        duration: Math.round(peaks.duration * 1000) / 1000,
        sampleRate: peaks.sampleRate,
        channels: peaks.channels,
        cached: peaks.cached,
        timing: peaks.timing ?? null,
        peakAbs: (() => {
          let m = 0;
          for (let i = 0; i < peaks.length; i += 1) {
            m = Math.max(m, Math.abs(peaks.min[i]), Math.abs(peaks.max[i]));
          }
          return Math.round(m * 1000) / 1000;
        })()
      };
    }, mat);
    assert.equal(facts[mat].ok, true, `${mat} 没解出峰值：${JSON.stringify(facts[mat])}`);
    const expected = { tone: 3, mp3: 60, stereo: 3 }[mat];
    assert.ok(Math.abs(facts[mat].duration - expected) < 0.05, `${mat} 时长 ${facts[mat].duration} 与素材 ${expected}s 不符`);
  }

  /* 三种素材的「正常」波形必须彼此不同：都长得一样说明画的不是真采样 */
  const summaries = {};
  for (const mat of ROWS) {
    for (const state of STATES) {
      summaries[`${mat}:${state}`] = await paintCell(mat, state);
    }
  }
  const normalPeaks = ROWS.map((mat) => summaries[`${mat}:normal`].peakAbs);
  assert.ok(new Set(normalPeaks.map((v) => v.toFixed(3))).size >= 2, `三种素材的峰值完全一样（${normalPeaks}），不像真采样`);

  /* 静音必须是平线：peakAbs 为 0，且三格都一样（没有残留旧波形） */
  for (const mat of ROWS) assert.equal(summaries[`${mat}:muted`].silent, true);
  /* volume=2：短 wav 振幅 0.99 → 超满幅后应出现溢出列；静音素材不会 */
  const overCols = ROWS.map((mat) => summaries[`${mat}:over`].overflowColumns);
  assert.ok(overCols.every((n) => n > 0), `volume=2 时应有溢出列，实际 ${JSON.stringify(overCols)}`);

  /* mp4 的音轨（AAC）也要能解 —— 任务书要求支持 mp4/m4a */
  /* 不夹紧：素材本身峰值 1.4（float wav），提取结果必须原样保留 > 1 */
  const overUnity = await page.evaluate(
    async ({ overSrc, toneSrc }) => {
      const peaks = await window.W35.loadPeaks(overSrc, { samplesPerSecond: 100 });
      if (!peaks.ok) return { ok: false, code: peaks.code };
      let mx = -Infinity;
      let mn = Infinity;
      for (let i = 0; i < peaks.length; i += 1) {
        mx = Math.max(mx, peaks.max[i]);
        mn = Math.min(mn, peaks.min[i]);
      }
      const canvas = document.querySelector('canvas[data-mat="tone"][data-state="normal"]');
      const drawAt = (volume) =>
        window.W35.drawWaveform(canvas.getContext('2d'), peaks, { width: 360, height: 64, dpr: 2, volume, color: '#38bdf8', overflowColor: '#f87171', background: '#0f172a' });
      const atOne = drawAt(1);
      /* 画回正常状态，别把 A1 的截图弄成溢出图 */
      window.W35.drawWaveform(canvas.getContext('2d'), window.__peaks.tone, { width: 360, height: 64, dpr: 2, color: '#38bdf8', overflowColor: '#f87171', background: '#0f172a' });
      void toneSrc;
      return { ok: true, max: Math.round(mx * 1000) / 1000, min: Math.round(mn * 1000) / 1000, atOne };
    },
    { overSrc: SOURCES.over, toneSrc: SOURCES.tone }
  );
  assert.equal(overUnity.ok, true, `超满幅素材没解出来：${JSON.stringify(overUnity)}`);
  assert.ok(overUnity.max > 1, `峰值 ${overUnity.max} 没保留 > 1（被夹紧了？）`);
  assert.ok(overUnity.atOne.overflowColumns > 0, 'volume=1 时素材本身已超满幅，应出现溢出列');

  const mp4 = await page.evaluate(async (src) => {
    const peaks = await window.W35.loadPeaks(src, { samplesPerSecond: 100 });
    return { ok: peaks.ok, code: peaks.code ?? null, duration: peaks.duration, channels: peaks.channels, sampleRate: peaks.sampleRate, length: peaks.length };
  }, SOURCES.mp4);
  assert.equal(mp4.ok, true, `mp4 音轨没解出来：${JSON.stringify(mp4)}`);
  assert.ok(Math.abs(mp4.duration - 3) < 0.06, `mp4 时长 ${mp4.duration}`);
  assert.equal(mp4.channels, 2);

  const shots = [];
  for (const mat of ROWS) {
    shots.push(await shot(`s35-a1-${mat}.png`, await rowClip(mat)));
  }
  const grid = await page.evaluate(() => {
    const el = document.querySelector('[data-grid="a1"]').getBoundingClientRect();
    return { x: Math.floor(el.x) - 6, y: Math.floor(el.y) - 6, width: Math.ceil(el.width) + 12, height: Math.ceil(el.height) + 12 };
  });
  shots.push(await shot('s35-a1-grid.png', grid));

  evidence.cases.A1 = { facts, summaries, mp4, overUnity, shots };
  evidence.screenshots.push(...shots);
  evidence.waveform.sources = facts;
  evidence.waveform.overUnity = { max: overUnity.max, min: overUnity.min, overflowColumnsAtVolume1: overUnity.atOne.overflowColumns };
});

/* ── A2 子区间正确性 ───────────────────────────────────────────── */

test('A2 子区间：25% / 50% 与「直接解码裁剪文件」比，p99 ≤ 2/255', async () => {
  const quarter = path.join(AUDIO_TMP, 'trim-quarter.wav');
  const half = path.join(AUDIO_TMP, 'trim-half.wav');
  const rel = (abs) => '/' + path.relative(REPO_ROOT, abs).split(path.sep).join('/');

  const compare = await page.evaluate(
    async ({ fullSrc, quarterSrc, halfSrc }) => {
      const p99 = (values) => {
        if (values.length === 0) return 0;
        const sorted = Float64Array.from(values).sort();
        const index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99));
        return sorted[index];
      };
      const full = await window.W35.loadPeaks(fullSrc, { samplesPerSecond: 100 });
      const cases = [
        { name: 'quarter', src: quarterSrc, start: 0.75, end: 1.5 },
        { name: 'half', src: halfSrc, start: 0.75, end: 2.25 }
      ];
      const rows = [];
      for (const item of cases) {
        const trimmed = await window.W35.loadPeaks(item.src, { samplesPerSecond: 100 });
        const sliced = window.W35.slicePeaks(full, item.start, item.end);
        const n = Math.min(sliced.length, trimmed.length);
        const diffs = [];
        for (let i = 0; i < n; i += 1) {
          diffs.push(Math.abs(sliced.min[i] - trimmed.min[i]) * 255);
          diffs.push(Math.abs(sliced.max[i] - trimmed.max[i]) * 255);
        }
        rows.push({
          name: item.name,
          start: item.start,
          end: item.end,
          bucketsFull: sliced.length,
          bucketsTrimmed: trimmed.length,
          p99: Math.round(p99(diffs) * 100) / 100,
          max: Math.round(Math.max(...diffs) * 100) / 100,
          differenceInBuckets: sliced.length - trimmed.length
        });
      }
      return { rows, fullDuration: full.duration, sps: full.samplesPerSecond };
    },
    { fullSrc: SOURCES.tone, quarterSrc: rel(quarter), halfSrc: rel(half) }
  );

  for (const row of compare.rows) {
    assert.equal(row.bucketsTrimmed, Math.round((row.end - row.start) * 100), `${row.name} 裁剪文件分桶数不对`);
    assert.ok(Math.abs(row.differenceInBuckets) <= 1, `${row.name} 分桶数差 ${row.differenceInBuckets}（应 ≤1）`);
    assert.ok(row.p99 <= 2, `${row.name} 子区间峰值 p99 ${row.p99}/255 > 2/255`);
  }

  /* 像素侧再验一次：同一张画布上「整幅 + clip」与「裁剪文件整幅」应几乎逐像素相同 */
  const pixels = await page.evaluate(
    async ({ fullSrc, quarterSrc, halfSrc }) => {
      const paint = (canvasSel, peaks, opts) => {
        const canvas = document.querySelector(canvasSel);
        canvas.width = 1200 * 2;
        canvas.height = 96 * 2;
        window.W35.drawWaveform(canvas.getContext('2d'), peaks, { width: 1200, height: 96, dpr: 2, color: '#38bdf8', background: '#0f172a', ...opts });
      };
      const full = await window.W35.loadPeaks(fullSrc, { samplesPerSecond: 100 });
      const trimmed = await window.W35.loadPeaks(quarterSrc, { samplesPerSecond: 100 });
      paint('canvas[data-wide="quarter"]', full, { clipStart: 0.75, clipEnd: 1.5 });
      paint('canvas[data-wide="quarter-ref"]', trimmed, {});
      const half = await window.W35.loadPeaks(halfSrc, { samplesPerSecond: 100 });
      paint('canvas[data-wide="half"]', full, { clipStart: 0.75, clipEnd: 2.25 });
      paint('canvas[data-wide="half-ref"]', half, {});
      const a = document.querySelector('canvas[data-wide="quarter"]').getContext('2d').getImageData(0, 0, 2400, 192).data;
      const b = document.querySelector('canvas[data-wide="quarter-ref"]').getContext('2d').getImageData(0, 0, 2400, 192).data;
      const diffs = [];
      let changed = 0;
      for (let i = 0; i < a.length; i += 4) {
        const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
        if (d > 0) changed += 1;
        diffs.push(d);
      }
      const halfPixels = (() => {
        const a2 = document.querySelector('canvas[data-wide="half"]').getContext('2d').getImageData(0, 0, 2400, 192).data;
        const b2 = document.querySelector('canvas[data-wide="half-ref"]').getContext('2d').getImageData(0, 0, 2400, 192).data;
        const list = [];
        for (let i = 0; i < a2.length; i += 4) {
          list.push(Math.max(Math.abs(a2[i] - b2[i]), Math.abs(a2[i + 1] - b2[i + 1]), Math.abs(a2[i + 2] - b2[i + 2])));
        }
        const s2 = Float64Array.from(list).sort();
        return { p99: s2[Math.floor(s2.length * 0.99)], max: s2[s2.length - 1] };
      })();
      const sorted = Float64Array.from(diffs).sort();
      return {
        p99: sorted[Math.floor(sorted.length * 0.99)],
        max: sorted[sorted.length - 1],
        changedPixels: changed,
        totalPixels: diffs.length,
        half: halfPixels
      };
    },
    { fullSrc: SOURCES.tone, quarterSrc: rel(quarter), halfSrc: rel(half) }
  );
  assert.ok(pixels.p99 <= 2, `像素 p99 ${pixels.p99} > 2/255`);

  /* 100%：clipStart/clipEnd 取整段时与不带 clip 的画法完全一致 */
  const whole = await page.evaluate(
    async (fullSrc) => {
      const canvas = document.querySelector('canvas[data-wide="full"]');
      canvas.width = 1200 * 2;
      canvas.height = 96 * 2;
      const peaks = await window.W35.loadPeaks(fullSrc, { samplesPerSecond: 100 });
      const base = { width: 1200, height: 96, dpr: 2, color: '#38bdf8', background: '#0f172a' };
      window.W35.drawWaveform(canvas.getContext('2d'), peaks, base);
      const a = canvas.getContext('2d').getImageData(0, 0, 2400, 192).data;
      window.W35.drawWaveform(canvas.getContext('2d'), peaks, { ...base, clipStart: 0, clipEnd: peaks.duration });
      const b = canvas.getContext('2d').getImageData(0, 0, 2400, 192).data;
      let max = 0;
      for (let i = 0; i < a.length; i += 1) max = Math.max(max, Math.abs(a[i] - b[i]));
      return { max };
    },
    SOURCES.tone
  );
  assert.equal(whole.max, 0, '整段 clip 与不传 clip 应逐像素相同');

  const wide = await page.evaluate(() => {
    const el = document.querySelectorAll('.wide')[0].getBoundingClientRect();
    return { x: Math.floor(el.x) - 6, y: Math.floor(el.y) - 6, width: Math.ceil(el.width) + 12, height: Math.ceil(el.height) + 12 };
  });
  const png = await shot('s35-a2-subrange.png', wide);

  evidence.cases.A2 = { rows: compare.rows, pixels, whole, shots: [png] };
  evidence.screenshots.push(png);
});

/* ── A3 缓存 ───────────────────────────────────────────────────── */

test('A3 缓存：二次调用 cached=true 且不重解码；不同 sps 是不同条目；命中重绘 < 2ms', async () => {
  const cache = await page.evaluate(
    async (src) => {
      window.W35.clearWaveformCache();
      const first = await window.W35.loadPeaks(src, { samplesPerSecond: 100 });
      const afterFirst = window.W35.getWaveformCacheStats();
      const second = await window.W35.loadPeaks(src, { samplesPerSecond: 100 });
      const afterSecond = window.W35.getWaveformCacheStats();
      const other = await window.W35.loadPeaks(src, { samplesPerSecond: 50 });
      const afterOther = window.W35.getWaveformCacheStats();
      return {
        firstCached: first.cached,
        secondCached: second.cached,
        otherCached: other.cached,
        length100: first.length,
        length50: other.length,
        afterFirst,
        afterSecond,
        afterOther,
        sameArrays: first.min === second.min
      };
    },
    SOURCES.stereo
  );
  assert.equal(cache.firstCached, false);
  assert.equal(cache.secondCached, true, '同一 src+sps 第二次应命中缓存');
  assert.equal(cache.afterSecond.hits, 1);
  assert.equal(cache.afterSecond.misses, 1);
  assert.equal(cache.afterSecond.decodes, 1, '命中缓存时不该再解码');
  assert.equal(cache.otherCached, false);
  assert.equal(cache.afterOther.entries, 2, '不同 samplesPerSecond 应是不同条目');
  assert.equal(cache.afterOther.decodes, 2);
  assert.equal(cache.length100, 300);
  assert.equal(cache.length50, 150);
  assert.equal(cache.sameArrays, true, '命中缓存应复用同一份 Float32Array，而不是重算一份');

  const redraw = await page.evaluate(
    async (src) => {
      const canvas = document.querySelector('canvas[data-perf]');
      const cssW = 1200;
      const cssH = 120;
      canvas.width = cssW * 2;
      canvas.height = cssH * 2;
      const ctx = canvas.getContext('2d');
      const peaks = await window.W35.loadPeaks(src, { samplesPerSecond: 100 });
      const realNow = Performance.prototype.now;
      const now = () => realNow.call(performance);
      const samples = [];
      for (let i = 0; i < 30; i += 1) {
        const t0 = now();
        window.W35.drawWaveform(ctx, peaks, { width: cssW, height: cssH, dpr: 2, color: '#38bdf8', overflowColor: '#f87171', background: '#0f172a', playhead: 1.5, playheadColor: '#f8fafc' });
        samples.push(now() - t0);
      }
      samples.sort((a, b) => a - b);
      return {
        samples: samples.map((v) => Math.round(v * 100) / 100),
        median: Math.round(samples[Math.floor(samples.length / 2)] * 100) / 100,
        p95: Math.round(samples[Math.floor(samples.length * 0.95)] * 100) / 100,
        canvasWidth: cssW
      };
    },
    SOURCES.tone
  );
  assert.ok(redraw.median < 2, `1200px 命中重绘中位 ${redraw.median}ms ≥ 2ms`);

  const perfBox = await page.evaluate(() => {
    const el = document.querySelector('canvas[data-perf]').getBoundingClientRect();
    return { x: Math.floor(el.x) - 6, y: Math.floor(el.y) - 24, width: Math.ceil(el.width) + 12, height: Math.ceil(el.height) + 30 };
  });
  const png = await shot('s35-a3-redraw.png', perfBox);

  evidence.cases.A3 = { cache, redraw, shots: [png] };
  evidence.screenshots.push(png);
  evidence.waveform.cache = cache.afterOther;
  evidence.waveform.redraw = { medianMs: redraw.median, p95Ms: redraw.p95, width: redraw.canvasWidth };
});

/* ── A4 1 小时素材 ─────────────────────────────────────────────── */

test('A4 1 小时 48k 立体声：耗时/内存/length', async () => {
  const stat = await fs.stat(path.join(REPO_ROOT, HOUR.rel));
  const result = await page.evaluate(
    async ({ src, expected }) => {
      window.W35.clearWaveformCache();
      const realNow = Performance.prototype.now;
      const now = () => realNow.call(performance);
      const t0 = now();
      const peaks = await window.W35.loadPeaks(src, { samplesPerSecond: 100 });
      const t1 = now();
      const stats = window.W35.getWaveformCacheStats();
      const mem = performance.memory
        ? { usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize }
        : null;
      return {
        ok: peaks.ok,
        code: peaks.code ?? null,
        length: peaks.length,
        duration: peaks.duration,
        sampleRate: peaks.sampleRate,
        channels: peaks.channels,
        timing: peaks.timing ?? null,
        wallMs: Math.round((t1 - t0) * 10) / 10,
        stats,
        mem,
        expected
      };
    },
    { src: '/' + HOUR.rel, expected: HOUR.expectedBuckets }
  );

  assert.equal(result.ok, true, `1 小时素材没解出来：${JSON.stringify(result)}`);
  assert.ok(Math.abs(result.length - HOUR.expectedBuckets) <= 1, `length ${result.length} 与预期分桶数 ${HOUR.expectedBuckets} 差超过 1`);
  assert.ok(Math.abs(result.duration - HOUR.duration) < 1, `duration ${result.duration}`);
  assert.equal(result.sampleRate, HOUR.sampleRate);
  assert.equal(result.channels, HOUR.channels);
  assert.equal(result.stats.entries, 1);
  /* 只缓存峰值：2 个 Float32Array × 360000 × 4B = 2.88MB，不能是 AudioBuffer 那种量级 */
  assert.equal(result.stats.bytes, HOUR.expectedBuckets * 4 * 2);

  evidence.cases.A4 = { file: HOUR.rel, fileBytes: stat.size, ...result };
  evidence.waveform.hour = {
    fileBytes: stat.size,
    decodedSamples: HOUR.duration * HOUR.sampleRate * HOUR.channels,
    length: result.length,
    expectedBuckets: HOUR.expectedBuckets,
    wallMs: result.wallMs,
    decodeMs: result.timing?.decodeMs ?? null,
    peaksMs: result.timing?.peaksMs ?? null,
    peaksBytes: result.stats.bytes,
    heapBytes: result.mem?.usedJSHeapSize ?? null
  };
});

/* ── A5 失败路径 ───────────────────────────────────────────────── */

test('A5 失败路径：DECODE_FAILED / UNSUPPORTED_FORMAT + 占位图', async () => {
  const corrupt = path.join(AUDIO_TMP, 'corrupt.mp3');
  await fs.mkdir(AUDIO_TMP, { recursive: true });
  /* 扩展名是 .mp3、内容是随机字节：容器头解析必然失败 */
  const junk = Buffer.alloc(4096);
  for (let i = 0; i < junk.length; i += 1) junk[i] = (i * 37) % 256;
  await fs.writeFile(corrupt, junk);

  const result = await page.evaluate(
    async ({ corruptSrc }) => {
      const before = window.W35.getWaveformCacheStats();
      const decode = await window.W35.loadPeaks(corruptSrc, { samplesPerSecond: 100 });
      const mid = window.W35.getWaveformCacheStats();
      const format = await window.W35.loadPeaks('/tmp/whatever.mov', { samplesPerSecond: 100 });
      const after = window.W35.getWaveformCacheStats();
      const paint = (selector, peaks) => {
        const canvas = document.querySelector(selector);
        canvas.width = 600 * 2;
        canvas.height = 96 * 2;
        canvas.style.width = '600px';
        canvas.style.height = '96px';
        return window.W35.drawWaveform(canvas.getContext('2d'), peaks, { width: 600, height: 96, dpr: 2, color: '#e2e8f0', background: '#0f172a' });
      };
      const decodeDraw = paint('canvas[data-error="decode"]', decode);
      const formatDraw = paint('canvas[data-error="format"]', format);
      return {
        decode: { ok: decode.ok, code: decode.code, message: decode.message },
        format: { ok: format.ok, code: format.code, message: format.message },
        decodesBefore: before.decodes,
        decodesAfterCorrupt: mid.decodes,
        decodesAfterFormat: after.decodes,
        decodeDraw,
        formatDraw,
        isError: window.W35.isWaveformError(decode)
      };
    },
    { corruptSrc: '/' + path.relative(REPO_ROOT, corrupt).split(path.sep).join('/') }
  );

  assert.equal(result.decode.ok, false);
  assert.equal(result.decode.code, 'DECODE_FAILED', `损坏文件应给 DECODE_FAILED，实际 ${result.decode.code}：${result.decode.message}`);
  assert.equal(result.format.ok, false);
  assert.equal(result.format.code, 'UNSUPPORTED_FORMAT', `不支持的容器应给 UNSUPPORTED_FORMAT，实际 ${result.format.code}`);
  /* 扩展名能一眼看出不行时**不该下载**：解码次数不增 */
  assert.equal(result.decodesAfterFormat, result.decodesAfterCorrupt, '不支持的容器不该先下载再拒');
  assert.equal(result.decodeDraw.placeholder, true);
  assert.equal(result.formatDraw.placeholder, true);
  assert.equal(result.isError, true);

  const box = await page.evaluate(() => {
    const sections = document.querySelectorAll('.wide');
    const el = sections[sections.length - 1].getBoundingClientRect();
    return { x: Math.floor(el.x) - 6, y: Math.floor(el.y) - 6, width: Math.ceil(el.width) + 12, height: Math.ceil(el.height) + 12 };
  });
  const png = await shot('s35-a5-error.png', box);

  evidence.cases.A5 = { ...result, shot: png };
  evidence.screenshots.push(png);
});

/* ── A6 确定性 ─────────────────────────────────────────────────── */

test('A6 两次独立 loadPeaks 的 min/max sha 相同', async () => {
  const result = await page.evaluate(
    async (sources) => {
      const digest = (peaks) => {
        /* 页面里没有 crypto.subtle 的同步版本，退化成把字节折成一个 64 位 FNV——够用于「两次是否逐字节相同」，
           真正的 sha256 由 Node 侧对导出的 base64 再算一次。 */
        const bytes = new Uint8Array(peaks.min.byteLength + peaks.max.byteLength);
        bytes.set(new Uint8Array(peaks.min.buffer, peaks.min.byteOffset, peaks.min.byteLength), 0);
        bytes.set(new Uint8Array(peaks.max.buffer, peaks.max.byteOffset, peaks.max.byteLength), peaks.min.byteLength);
        let hash = 0xcbf29ce484222325n;
        for (let i = 0; i < bytes.length; i += 1) {
          hash ^= BigInt(bytes[i]);
          hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
        }
        return { fnv: hash.toString(16), bytes: bytes.length };
      };
      const out = {};
      for (const [key, src] of Object.entries(sources)) {
        window.W35.clearWaveformCache();
        const a = await window.W35.loadPeaks(src, { samplesPerSecond: 100 });
        window.W35.clearWaveformCache();
        const b = await window.W35.loadPeaks(src, { samplesPerSecond: 100 });
        out[key] = { first: digest(a), second: digest(b), same: digest(a).fnv === digest(b).fnv, length: a.length };
      }
      return out;
    },
    { tone: SOURCES.tone, mp3: SOURCES.mp3, stereo: SOURCES.stereo }
  );

  for (const [key, value] of Object.entries(result)) {
    assert.equal(value.same, true, `${key} 两次 loadPeaks 的峰值不一致（${value.first.fnv} vs ${value.second.fnv}）`);
  }

  /* Node 侧再算一次真 sha256：把页面里的 Float32Array 原样传回来 */
  const buffers = await page.evaluate(
    async (src) => {
      window.W35.clearWaveformCache();
      const peaks = await window.W35.loadPeaks(src, { samplesPerSecond: 100 });
      const toB64 = (arr) => {
        const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
        return btoa(binary);
      };
      return { min: toB64(peaks.min), max: toB64(peaks.max) };
    },
    SOURCES.tone
  );
  const shaMin = sha(Buffer.from(buffers.min, 'base64'));
  const shaMax = sha(Buffer.from(buffers.max, 'base64'));

  evidence.cases.A6 = { page: result, sha256: { min: shaMin, max: shaMax } };
});
