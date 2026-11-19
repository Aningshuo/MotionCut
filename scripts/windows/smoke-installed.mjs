/** Run after building the NSIS installer on a native Windows x64 machine. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

import { subtitleFilterArg } from '../../packages/render/subtitles.mjs';
import { buildUi1Project } from '../lib/ui3-fixture.mjs';

const installerPath = process.argv[2];
const expectedSubtitle = '画面位置与中文字幕';
const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
const system32 = join(systemRoot, 'System32');

/** @returns {NodeJS.ProcessEnv} */
function cleanEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(path$|opencut_|electron_|node_options$|node_path$|playwright_|ffreport$)/i.test(key)) {
      delete env[key];
    }
  }
  env.Path = [system32, systemRoot, join(system32, 'Wbem')].join(';');
  return env;
}

/**
 * @param {string} executable
 * @param {string[]} args
 * @param {{env: NodeJS.ProcessEnv, cwd: string, windowsVerbatimArguments?: boolean, timeout?: number}} options
 */
function run(executable, args, options) {
  const result = spawnSync(executable, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 60_000, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${executable} failed: ${result.stderr.toString('utf8')}`);
  return result;
}

/** @param {() => Promise<boolean>|boolean} predicate @param {string} reason @param {number} [timeout] */
async function waitFor(predicate, reason, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(250);
  }
  throw new Error(reason);
}

async function allocatePorts() {
  const sockets = [createServer(), createServer(), createServer(), createServer()];
  try {
    const ports = await Promise.all(sockets.map((socket) => new Promise((done, fail) => {
      socket.once('error', fail);
      socket.listen(0, '127.0.0.1', () => {
        const address = socket.address();
        if (address === null || typeof address === 'string') {
          fail(new Error('Windows smoke test could not reserve a localhost port'));
          return;
        }
        done(address.port);
      });
    })));
    const [studioPort, contentPort, vitePort, cdpPort] = ports;
    assert.ok(studioPort && contentPort && vitePort && cdpPort);
    return { studioPort, contentPort, vitePort, cdpPort };
  } finally {
    await Promise.all(sockets.filter((socket) => socket.listening).map((socket) => new Promise((done) => socket.close(done))));
  }
}

/** @param {string} url @param {number} status @param {object} [body] */
async function requestJson(url, status, body) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    ...(body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
  });
  const data = await response.json();
  assert.equal(response.status, status, `${url}: ${JSON.stringify(data)}`);
  return data;
}

/** @param {string} base @param {object} input */
async function exportFilm(base, input) {
  const started = await requestJson(`${base}/api/export`, 202, { range: { start: 0, end: 3 }, codec: 'h264', ...input });
  const id = started.job?.id;
  assert.ok(typeof id === 'string' && id.length > 0, 'export queue returned no job id');
  const endpoint = `${base}/api/export/${encodeURIComponent(id)}`;
  await waitFor(async () => {
    const result = await requestJson(endpoint, 200);
    return ['done', 'failed', 'cancelled'].includes(result.job?.state);
  }, `export ${id} did not reach a terminal state`, 240_000);
  const result = await requestJson(endpoint, 200);
  assert.equal(result.job?.state, 'done', JSON.stringify(result.job));
  assert.equal(result.job?.percent, 1);
  assert.equal(result.job?.frames, 90);
  return result.job;
}

/** Assert reported files resolve to the test project before opening them.
 * @param {{artifacts?: Array<{kind:string, path:string, bytes:number}>}} job
 * @param {string} kind
 * @param {string} project
 */
async function artifactPath(job, kind, project) {
  const output = job.artifacts?.find((artifact) => artifact.kind === kind);
  assert.ok(output && output.bytes > 100, `Missing nonempty ${kind} export artifact`);
  // The Windows runner may use an 8.3 alias for TEMP while the application reports the long path.
  const [actualProject, actualOutput] = await Promise.all([realpath(project), realpath(output.path)]);
  const rel = relative(actualProject, actualOutput);
  assert.ok(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  return actualOutput;
}

async function main() {
  assert.equal(process.platform, 'win32', 'Run the installer acceptance on native Windows');
  assert.equal(process.arch, 'x64', 'Run the installer acceptance using Windows x64 Node');
  assert.ok(installerPath, 'Usage: node scripts/windows/smoke-installed.mjs <installer.exe>');
  const installer = resolve(installerPath);
  const work = await mkdtemp(join(tmpdir(), 'MotionCut 中文 安装 '));
  const installDir = join(work, '安装 位置');
  const app = join(installDir, 'MotionCut.exe');
  const env = cleanEnvironment();
  const options = { env, cwd: work };
  /** @type {ReturnType<typeof spawn>|undefined} */
  let appProcess;
  /** @type {import('playwright').Browser|undefined} */
  let browser;
  /** @type {Error|undefined} */
  let startupError;
  let studioLog = '';
  let passed = false;
  try {
    const external = spawnSync(join(system32, 'where.exe'), ['ffmpeg.exe'], { ...options, windowsHide: true });
    assert.equal(external.status, 1, 'System-only PATH must not contain FFmpeg');
    const occupied = join(work, '已有 文件');
    await mkdir(occupied);
    const sentinel = join(occupied, 'personal.txt');
    await writeFile(sentinel, 'untouched');
    const declined = spawnSync(installer, ['/S', `/D=${occupied}`], {
      ...options, windowsHide: true, windowsVerbatimArguments: true, timeout: 180_000,
    });
    assert.ifError(declined.error);
    assert.equal(declined.status, 3, 'Installer must refuse a nonempty unrelated folder');
    assert.equal(await readFile(sentinel, 'utf8'), 'untouched');
    assert.ok(!existsSync(join(occupied, 'MotionCut.exe')));
    run(installer, ['/S', `/D=${installDir}`], {
      ...options, windowsVerbatimArguments: true, timeout: 180_000,
    });

    const ffmpeg = join(installDir, 'resources', 'bin', 'ffmpeg.exe');
    const ffprobe = join(installDir, 'resources', 'bin', 'ffprobe.exe');
    assert.ok(existsSync(app) && existsSync(ffmpeg) && existsSync(ffprobe), 'Installer did not place the expected files in the isolated directory');
    run(ffmpeg, ['-hide_banner', '-version'], options);
    run(ffprobe, ['-hide_banner', '-version'], options);

    const fixture = await buildUi1Project(work, ffmpeg);
    const sidecar = join(fixture.dir, 'assets', 'take-01.srt');
    await writeFile(sidecar, `1\n00:00:00,100 --> 00:00:02,700\n${expectedSubtitle}\n`, 'utf8');
    const ports = await allocatePorts();
    const base = `http://127.0.0.1:${ports.studioPort}`;
    const cdp = `http://127.0.0.1:${ports.cdpPort}`;
    const studioHome = join(work, "字幕 工作 O'Brien,[x64]");
    const userData = join(work, '用户 配置');
    const envFile = join(work, 'env.json');
    await mkdir(userData, { recursive: true });
    await writeFile(envFile, JSON.stringify({ ...ports, userData, studioHome, projectsRoot: fixture.projectsRoot }), 'utf8');

    appProcess = spawn(app, [], {
      cwd: work,
      env: {
        ...env, OPENCUT_ENV_JSON: envFile, OPENCUT_APP_DATA: join(work, 'app-data'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    appProcess.on('error', (error) => { startupError = error; });
    const capture = (/** @type {Buffer} */ data) => { studioLog = (studioLog + data.toString('utf8')).slice(-24_000); };
    appProcess.stdout?.on('data', capture);
    appProcess.stderr?.on('data', capture);

    await waitFor(async () => {
      if (startupError) throw startupError;
      if (appProcess?.exitCode !== null) throw new Error(`Installed app exited early: ${appProcess?.exitCode}`);
      try {
        const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) });
        return response.ok && (await response.json()).ok === true;
      } catch {
        return false;
      }
    }, 'Installed application did not start Studio', 90_000);

    const shellResponse = await fetch(`${base}/?shell=1`, { signal: AbortSignal.timeout(6000) });
    assert.equal(shellResponse.headers.get('x-opencut-ui'), 'dist', 'Installed application must serve the compiled editor');
    await waitFor(async () => {
      try {
        const response = await fetch(`${cdp}/json/list`, { signal: AbortSignal.timeout(1000) });
        return response.ok && (await response.json()).some((/** @type {{url:string}} */ target) => target.url === `${base}/?shell=1`);
      } catch {
        return false;
      }
    }, 'Installed Electron window did not open the editor shell');
    browser = await chromium.connectOverCDP(cdp, { timeout: 10_000 });
    const shellPage = browser.contexts().flatMap((context) => context.pages()).find((page) => page.url() === `${base}/?shell=1`);
    assert.ok(shellPage, 'Installed Electron window has no editor page');
    await shellPage.getByRole('button', { name: '新建项目' }).waitFor({ state: 'visible', timeout: 15_000 });
    assert.ok(studioLog.includes('STUDIO_FFMPEG'), 'Installed Studio startup did not report using bundled FFmpeg');

    const { project } = await requestJson(`${base}/api/projects/open`, 200, { path: fixture.dir });
    assert.ok(typeof project?.projectId === 'string');
    const ordinary = await exportFilm(base, { projectId: project.projectId, outPath: join(fixture.dir, '普通 导出.mp4') });
    const burned = await exportFilm(base, {
      projectId: project.projectId, outPath: join(fixture.dir, '字幕 烧录.mp4'),
      subtitleBurn: true, subtitleSrc: 'assets/take-01.mp4',
    });
    const plainMp4 = await artifactPath(ordinary, 'master', fixture.dir);
    const masterMp4 = await artifactPath(burned, 'master', fixture.dir);
    const subbedMp4 = await artifactPath(burned, 'subbed', fixture.dir);
    const emittedCaptions = await readFile(await artifactPath(burned, 'vtt', fixture.dir), 'utf8');
    assert.ok(emittedCaptions.includes(expectedSubtitle), 'Subtitle sidecar lost the Unicode cue');
    assert.equal(burned.subtitle?.cues, 1);
    assert.equal(typeof burned.assText, 'string');
    assert.ok(burned.assText.includes(expectedSubtitle), 'ASS generated for export lost the Unicode cue');

    // Replay the in-app ASS against the verified master. This detects unresolved
    // CJK glyphs even if a decoder would accept a video full of missing-glyph boxes.
    const assPath = join(studioHome, "字幕 O'Brien,[x64].ass");
    await writeFile(assPath, burned.assText, 'utf8');
    const glyphLog = run(ffmpeg, [
      '-nostdin', '-v', 'verbose', '-ss', '1.5', '-i', masterMp4,
      '-vf', subtitleFilterArg(assPath), '-an', '-frames:v', '1', '-f', 'null', '-',
    ], options).stderr.toString('utf8');
    assert.match(glyphLog, /Using font provider directwrite/i);
    assert.doesNotMatch(glyphLog, /failed to find any fallback with glyph|glyph 0x[\da-f]+ not found in font|LastResort/i);

    for (const file of [plainMp4, subbedMp4]) {
      const probe = JSON.parse(run(ffprobe, [
        '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name', '-of', 'json', file,
      ], options).stdout.toString('utf8'));
      assert.ok(Math.abs(Number(probe.format?.duration) - 3) < 0.15, 'MP4 duration differs from requested 3 seconds');
      assert.ok(probe.streams.some((/** @type {{codec_type:string, codec_name:string}} */ stream) => stream.codec_type === 'video' && stream.codec_name === 'h264'));
      assert.ok(probe.streams.some((/** @type {{codec_type:string, codec_name:string}} */ stream) => stream.codec_type === 'audio' && stream.codec_name === 'aac'));
      run(ffmpeg, ['-nostdin', '-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], options);
    }

    const crop = (/** @type {string} */ file) => run(ffmpeg, [
      '-nostdin', '-v', 'error', '-ss', '1.5', '-i', file, '-frames:v', '1',
      '-vf', 'crop=iw:ih/4:0:ih*3/4', '-pix_fmt', 'gray', '-f', 'rawvideo', '-',
    ], options).stdout;
    const original = crop(masterMp4);
    const rendered = crop(subbedMp4);
    assert.ok(original.length > 0);
    assert.equal(original.length, rendered.length);
    const visiblePixels = rendered.reduce((count, value, index) => count + Number(value > 205 && (original[index] ?? value) < 175), 0);
    assert.ok(visiblePixels > 100, `Subtitle not visible in rendered frame: ${visiblePixels} brightened pixels`);
    console.log(JSON.stringify({ result: 'PASS', installed: true, gui: true, mp4: true, subtitle: expectedSubtitle, visiblePixels, frames: burned.frames }));
    passed = true;
  } catch (error) {
    if (studioLog) console.error(studioLog);
    throw error;
  } finally {
    const pid = appProcess?.pid;
    if (pid !== undefined && appProcess?.exitCode === null) {
      spawnSync(join(system32, 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { ...options, windowsHide: true, timeout: 10_000 });
    }
    if (browser) await browser.close().catch(() => {});
    const uninstaller = join(installDir, 'Uninstall.exe');
    if (existsSync(uninstaller)) {
      const retained = join(installDir, 'personal.txt');
      await writeFile(retained, 'keep during uninstall');
      run(uninstaller, ['/S'], { ...options, timeout: 90_000 });
      await waitFor(() => !existsSync(app), 'Silent uninstaller did not remove the installed executable', 30_000);
      assert.equal(await readFile(retained, 'utf8'), 'keep during uninstall');
    }
    if (passed) await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

await main();
