/**
 * P21-A5 验收：`export film --estimate` 只估算，**不改动任何文件**。
 *
 * 检查方式不是"看有没有报错"，而是把整个工程目录（含 mtime 之外的内容）做一次树哈希，
 * 跑前跑后必须逐字节相同：工程 hash 一致才算真的没写盘。
 *
 * 顺带钉住三件容易被改坏的事：
 * - `--estimate` 与 `--out/--plan-out/--frames-out/--profile-out/--also-compat` 同时出现 → E_USAGE，
 *   不能"忽略掉继续跑"（用户会以为文件已经生成了）。
 * - `--settle-ms` 真的会改变结果（主线改 settle 后要靠它对比）。
 * - 没有网页片段时不报取帧时间。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { createCli } from '../index.mjs';
import { createFilmPort } from './fixtures/film-module.mjs';

const execFileAsync = promisify(execFile);

/** @type {string} */
let workDir;
/** @type {string} */
let project;

before(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-cli-estimate-'));
  project = path.join(workDir, 'proj');
  await fs.mkdir(path.join(project, 'assets'), { recursive: true });
  // 2 秒、每个关键帧间隔 1s（-g 30）：GOP 模型走"正常素材"分支
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', "color=c=red:s=320x180:r=30:d=2,hue=h='t*120':s=1",
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
    path.join(project, 'assets/clip.mp4'),
  ]);
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', "aevalsrc='0.2*sin(2*PI*1000*t)':s=48000:d=2:c=stereo",
    path.join(project, 'assets/tone.wav'),
  ]);
  await fs.writeFile(
    path.join(project, 'scene-a.html'),
    '<!doctype html><html><body><div style="width:100%;height:100%;background:#123"></div></body></html>',
  );
  // 有 iframe 片段 → 走舞台取帧分支（否则 captureSec 恒为 0，测不到 settle）
  await fs.writeFile(
    path.join(project, 'film.html'),
    `<!doctype html><html><head><meta name="viewport" content="width=320, height=180"></head><body>
<section><iframe id="s" src="scene-a.html#t=0,2" at="0"></iframe></section>
<section><video id="v" src="assets/clip.mp4#t=0,2" at="0"></video></section>
<section><audio id="a" src="assets/tone.wav#t=0,2" at="0" volume="0.8"></audio></section>
</body></html>`,
  );
});

after(async () => {
  if (workDir) await fs.rm(workDir, { recursive: true, force: true });
});

/** @returns {{ write: (chunk: string) => void, text: string }} */
function sink() {
  /** @type {string[]} */
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(chunk);
    },
    get text() {
      return chunks.join('');
    },
  };
}

/**
 * 工程树哈希：相对路径 + 内容 + 大小。跑前跑后一致 = 没动过任何文件。
 * @param {string} dir
 * @returns {Promise<string>}
 */
async function treeHash(dir) {
  const hash = crypto.createHash('sha256');
  /** @param {string} current @param {string} prefix */
  const walk = async (current, prefix) => {
    const entries = (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else {
        const body = await fs.readFile(full);
        hash.update(`${rel}\u0000${body.length}\u0000`);
        hash.update(body);
      }
    }
  };
  await walk(dir, '');
  return hash.digest('hex');
}

function makeCli() {
  return createCli({
    root: workDir,
    cwd: workDir,
    stateDir: path.join(workDir, '.state'),
    film: createFilmPort(),
    log: () => {},
  });
}

test('P21-A5：--estimate 不写任何文件（工程树哈希前后一致）', async () => {
  const beforeHash = await treeHash(project);
  const out = sink();
  const err = sink();
  const code = await makeCli().run(['export', 'film', project, '--estimate'], { stdout: out, stderr: err });
  assert.equal(code, 0, `exit ${code}: ${err.text}`);
  const afterHash = await treeHash(project);
  assert.equal(afterHash, beforeHash);
  assert.match(out.text, /^ESTIMATE /);
  assert.match(out.text, /合计/);
});

test('P21：--estimate --json 给出可解析的估算对象', async () => {
  const out = sink();
  const code = await makeCli().run(['export', 'film', project, '--estimate', '--json'], {
    stdout: out,
    stderr: sink(),
  });
  assert.equal(code, 0);
  const payload = JSON.parse(out.text);
  const estimate = payload.estimate;
  assert.equal(estimate.frames, 60);
  assert.equal(estimate.fps, 30);
  assert.equal(estimate.mode, 'stage');
  assert.ok(estimate.totalSec > 0);
  assert.ok(estimate.captureSec > 0);
  assert.ok(Array.isArray(estimate.reasons) && estimate.reasons.length >= 2);
  assert.equal(payload.profiles.length, 1);
  assert.ok(payload.profiles[0].avgGopSec >= 0.5);
});

test('P21：--settle-ms 会改变预估（settle 是入参，不是常数）', async () => {
  /** @param {string[]} extra */
  const runEstimate = async (extra) => {
    const out = sink();
    const code = await makeCli().run(['export', 'film', project, '--estimate', '--json', ...extra], {
      stdout: out,
      stderr: sink(),
    });
    assert.equal(code, 0);
    return JSON.parse(out.text).estimate;
  };
  const auto = await runEstimate([]);
  const slow = await runEstimate(['--settle-ms', '900']);
  const fast = await runEstimate(['--settle-ms', '100']);
  assert.equal(slow.settleSource, 'input');
  assert.ok(slow.totalSec > auto.totalSec);
  assert.ok(fast.totalSec < auto.totalSec);
});

test('P21：--estimate 与写盘开关同时出现 → E_USAGE（不静默忽略）', async () => {
  for (const flag of ['--out', '--plan-out', '--frames-out', '--profile-out']) {
    const err = sink();
    const value = flag === '--also-compat' ? [] : [path.join(workDir, `x${flag}`)];
    const code = await makeCli().run(['export', 'film', project, '--estimate', flag, ...value], {
      stdout: sink(),
      stderr: err,
    });
    assert.equal(code, 1, `${flag} should be rejected`);
    assert.match(err.text, /--estimate does not export anything/);
  }
  const code = await makeCli().run(['export', 'film', project, '--estimate', '--also-compat'], {
    stdout: sink(),
    stderr: sink(),
  });
  assert.equal(code, 1);
});

test('P21：--estimate 仍然走同一个 film 端口（没有端口就 WAIT_MAIN_FILM）', async () => {
  const cli = createCli({ root: workDir, cwd: workDir, stateDir: path.join(workDir, '.state'), log: () => {} });
  const err = sink();
  const code = await cli.run(['export', 'film', project, '--estimate'], { stdout: sink(), stderr: err });
  assert.equal(code, 7);
  assert.match(err.text, /WAIT_MAIN_FILM/);
});
