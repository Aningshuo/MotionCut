/** Validate an actual macOS disk image in an isolated Applications directory. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

import { APP_NAME } from '../../apps/desktop/src/identity.mjs';
import { subtitleFilterArg } from '../../packages/render/subtitles.mjs';
import { buildUi1Project } from '../lib/ui3-fixture.mjs';

const expectedSubtitle = '画面位置与中文字幕';

function cleanEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(path$|opencut_|electron_|node_options$|node_path$|playwright_|dyld_|ffreport$)/i.test(key)) {
      delete env[key];
    }
  }
  env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  return env;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd: string, env: NodeJS.ProcessEnv, timeout?: number}} options
 */
function run(command, args, options) {
  const result = spawnSync(command, args, { maxBuffer: 8 * 1024 * 1024, timeout: 60_000, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed: ${result.stderr.toString('utf8')}`);
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
  const listeners = Array.from({ length: 4 }, () => createServer());
  try {
    const [studioPort, contentPort, vitePort, cdpPort] = await Promise.all(
      listeners.map((listener) => new Promise((done, fail) => {
        listener.once('error', fail);
        listener.listen(0, '127.0.0.1', () => {
          const address = listener.address();
          if (address === null || typeof address === 'string') {
            fail(new Error('Could not reserve a localhost port'));
            return;
          }
          done(address.port);
        });
      })),
    );
    return { studioPort, contentPort, vitePort, cdpPort };
  } finally {
    await Promise.all(listeners.filter((listener) => listener.listening).map((listener) => new Promise((done) => listener.close(done))));
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
  const { job: pending } = await requestJson(`${base}/api/export`, 202, {
    codec: 'h264', range: { start: 0, end: 3 }, ...input,
  });
  assert.ok(typeof pending?.id === 'string' && pending.id.length > 0, 'Export queue did not return a job');
  const endpoint = `${base}/api/export/${encodeURIComponent(pending.id)}`;
  let job = pending;
  await waitFor(async () => {
    ({ job } = await requestJson(endpoint, 200));
    return ['done', 'failed', 'cancelled'].includes(job?.state);
  }, `Export ${pending.id} did not finish`, 240_000);
  assert.equal(job?.state, 'done', JSON.stringify(job));
  assert.equal(job.percent, 1);
  assert.equal(job.frames, 90);
  return job;
}

/**
 * @param {{artifacts?: Array<{kind:string, path:string, bytes:number, sha256:string}>}} job
 * @param {string} kind
 * @param {string} project
 */
async function checkedArtifact(job, kind, project) {
  const output = job.artifacts?.find((artifact) => artifact.kind === kind);
  assert.ok(output && output.bytes > 0, `Missing nonempty ${kind} export artifact`);
  const [directory, path] = await Promise.all([realpath(project), realpath(output.path)]);
  const rel = relative(directory, path);
  assert.ok(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'Export resolved outside the test project');
  const bytes = await readFile(path);
  assert.equal(bytes.length, output.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), output.sha256);
  return path;
}

/** @param {import('playwright').Page} page @param {string} selector */
async function checkTitleBar(page, selector) {
  const header = page.locator(`html.motioncut-mac-shell ${selector}`);
  await header.waitFor({ state: 'visible', timeout: 15_000 });
  const bounds = await header.evaluate((element) => ({
    top: element.getBoundingClientRect().top,
    leftInset: Number.parseFloat(getComputedStyle(element).paddingLeft),
  }));
  assert.equal(bounds.top, 0, 'The app header must start at the top of the content view');
  assert.ok(bounds.leftInset >= 80, 'The app header must reserve space for the native window buttons');
  const dragRegion = header.getByTestId('window-drag-region');
  await dragRegion.waitFor({ state: 'visible', timeout: 15_000 });
  assert.equal(await dragRegion.evaluate((element) => getComputedStyle(element).getPropertyValue('-webkit-app-region')), 'drag');
}

/** @param {number} pid @param {NodeJS.Signals} signal */
function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ESRCH') throw error;
  }
}

async function main() {
  assert.equal(process.platform, 'darwin', 'Test the disk image on macOS');
  const imageArgument = process.argv[2];
  const arch = process.argv[3] ?? 'x64';
  assert.ok(imageArgument && (arch === 'arm64' || arch === 'x64'),
    'Usage: node scripts/macos/smoke-installed.mjs <installer.dmg> [arm64|x64]');
  assert.equal(process.arch, arch, 'Use a matching native Node runtime');
  const machArch = arch === 'x64' ? 'x86_64' : 'arm64';
  const image = resolve(imageArgument);
  const work = await realpath(await mkdtemp(join(tmpdir(), 'MotionCut 中文 安装 ')));
  const mountPoint = join(work, 'mounted');
  const applications = join(work, 'Applications');
  const installedApp = join(applications, `${APP_NAME}.app`);
  const app = join(installedApp, 'Contents', 'MacOS', APP_NAME);
  const bundledBin = join(installedApp, 'Contents', 'Resources', 'bin');
  const ffmpeg = join(bundledBin, 'ffmpeg');
  const ffprobe = join(bundledBin, 'ffprobe');
  const env = cleanEnvironment();
  const options = { cwd: work, env };
  let mounted = false;
  /** @type {ReturnType<typeof spawn>|undefined} */
  let child;
  /** @type {import('playwright').Browser|undefined} */
  let browser;
  /** @type {Error|undefined} */
  let startupError;
  let studioLog = '';
  try {
    assert.notEqual(run('/usr/sbin/sysctl', ['-in', 'sysctl.proc_translated'], options).stdout.toString().trim(),
      '1', 'The acceptance test requires a native macOS runtime');
    for (const tool of ['ffmpeg', 'ffprobe']) {
      const found = spawnSync('/usr/bin/which', [tool], options);
      assert.ifError(found.error);
      assert.equal(found.status, 1, `System-only PATH unexpectedly contains ${tool}`);
    }
    await Promise.all([mkdir(applications), mkdir(mountPoint)]);
    run('/usr/bin/hdiutil', ['verify', image], { ...options, timeout: 180_000 });
    run('/usr/bin/hdiutil', ['attach', image, '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mountPoint], options);
    mounted = true;
    run('/usr/bin/ditto', [join(mountPoint, `${APP_NAME}.app`), installedApp], { ...options, timeout: 180_000 });
    run('/usr/bin/hdiutil', ['detach', mountPoint], options);
    mounted = false;

    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', installedApp], options);
    for (const binary of [app, ffmpeg, ffprobe]) {
      run('/usr/bin/lipo', [binary, '-verify_arch', machArch], options);
    }
    run(ffmpeg, ['-hide_banner', '-version'], options);
    run(ffprobe, ['-hide_banner', '-version'], options);

    const fixture = await buildUi1Project(work, ffmpeg);
    await writeFile(join(fixture.dir, 'assets', 'take-01.srt'),
      `1\n00:00:00,100 --> 00:00:02,700\n${expectedSubtitle}\n`, 'utf8');
    const ports = await allocatePorts();
    const base = `http://127.0.0.1:${ports.studioPort}`;
    const cdp = `http://127.0.0.1:${ports.cdpPort}`;
    const studioHome = join(work, `字幕 工作 O'Brien,[${arch}]`);
    const userData = join(work, '用户 配置');
    const envFile = join(work, 'env.json');
    const appData = join(work, 'app-data');
    const legacy = join(appData, 'OpenFilm');
    const legacySentinel = join(legacy, 'existing-profile.txt');
    await mkdir(userData);
    await mkdir(legacy, { recursive: true });
    await writeFile(legacySentinel, 'unrelated profile');
    await writeFile(envFile, JSON.stringify({ ...ports, userData, studioHome, projectsRoot: fixture.projectsRoot }), 'utf8');
    child = spawn(app, [], {
      cwd: work,
      env: { ...env, OPENCUT_ENV_JSON: envFile, OPENCUT_APP_DATA: appData },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.on('error', (error) => { startupError = error; });
    const capture = (/** @type {Buffer} */ data) => { studioLog = (studioLog + data.toString('utf8')).slice(-32_000); };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    await waitFor(async () => {
      if (startupError) throw startupError;
      if (child?.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Installed app exited early: ${child?.exitCode ?? child?.signalCode}`);
      }
      try {
        const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) });
        return response.ok && (await response.json()).ok === true;
      } catch {
        return false;
      }
    }, 'Installed application did not start Studio', 90_000);
    const shellUrl = `${base}/?shell=1`;
    const shellResponse = await fetch(shellUrl, { signal: AbortSignal.timeout(6000) });
    assert.equal(shellResponse.headers.get('x-opencut-ui'), 'dist', 'Installed editor must serve its compiled renderer');
    await waitFor(async () => {
      try {
        const response = await fetch(`${cdp}/json/list`, { signal: AbortSignal.timeout(1000) });
        return response.ok && (await response.json()).some((/** @type {{url:string}} */ target) => target.url === shellUrl);
      } catch {
        return false;
      }
    }, 'Installed Electron window did not open the editor shell');
    browser = await chromium.connectOverCDP(cdp, { timeout: 10_000 });
    const page = browser.contexts().flatMap((context) => context.pages()).find((entry) => entry.url() === shellUrl);
    assert.ok(page, 'Installed Electron window has no compiled editor page');
    await page.getByRole('button', { name: '新建项目' }).waitFor({ state: 'visible', timeout: 15_000 });
    await checkTitleBar(page, '.project-home-masthead');
    assert.ok(studioLog.includes(`STUDIO_FFMPEG ${ffmpeg}`), 'Studio startup did not select the installed FFmpeg');
    assert.doesNotMatch(studioLog, /MAIN_LEGACY_(USERDATA|NOTICE)/);

    const { project } = await requestJson(`${base}/api/projects/open`, 200, { path: fixture.dir });
    assert.ok(typeof project?.projectId === 'string');
    const opened = await page.evaluate((projectId) => /** @type {any} */ (window).opencut.tabs.open({ projectId }), project.projectId);
    assert.equal(opened.ok, true, JSON.stringify(opened));
    await waitFor(() => browser?.contexts().flatMap((context) => context.pages())
      .some((entry) => new URL(entry.url()).searchParams.get('project') === project.projectId) === true,
    'Installed app did not open the project editor');
    const editor = browser.contexts().flatMap((context) => context.pages())
      .find((entry) => new URL(entry.url()).searchParams.get('project') === project.projectId);
    assert.ok(editor);
    await checkTitleBar(editor, '.topbar');
    await editor.getByTestId('project-home-link').click({ timeout: 15_000 });
    await page.getByTestId('home-new-project').waitFor({ state: 'visible', timeout: 15_000 });
    assert.equal(await readFile(legacySentinel, 'utf8'), 'unrelated profile');
    assert.doesNotMatch(studioLog, /MAIN_LEGACY_(USERDATA|NOTICE)/);
    const ordinary = await exportFilm(base, { projectId: project.projectId, outPath: join(fixture.dir, '普通 导出.mp4') });
    const burned = await exportFilm(base, {
      projectId: project.projectId, outPath: join(fixture.dir, '字幕 烧录.mp4'),
      subtitleBurn: true, subtitleSrc: 'assets/take-01.mp4',
    });
    const plainMp4 = await checkedArtifact(ordinary, 'master', fixture.dir);
    const masterMp4 = await checkedArtifact(burned, 'master', fixture.dir);
    const subbedMp4 = await checkedArtifact(burned, 'subbed', fixture.dir);
    const captions = await readFile(await checkedArtifact(burned, 'vtt', fixture.dir), 'utf8');
    assert.ok(captions.includes(expectedSubtitle), 'Subtitle sidecar lost the Chinese cue');
    assert.equal(burned.subtitle?.cues, 1);
    assert.equal(typeof burned.assText, 'string');
    assert.ok(burned.assText.includes(expectedSubtitle), 'ASS generated for export lost the Chinese cue');

    for (const file of [plainMp4, masterMp4, subbedMp4]) {
      const probe = JSON.parse(run(ffprobe, [
        '-v', 'error', '-count_frames', '-show_entries', 'format=duration:stream=codec_type,codec_name,nb_read_frames',
        '-of', 'json', file,
      ], options).stdout.toString('utf8'));
      assert.ok(Math.abs(Number(probe.format?.duration) - 3) < 0.15, 'MP4 duration differs from 3 seconds');
      const video = probe.streams.find((/** @type {{codec_type:string}} */ stream) => stream.codec_type === 'video');
      assert.equal(video?.codec_name, 'h264');
      assert.equal(Number(video?.nb_read_frames), 90, 'MP4 has an unexpected number of decodable frames');
      const audio = probe.streams.find((/** @type {{codec_type:string}} */ stream) => stream.codec_type === 'audio');
      assert.equal(audio?.codec_name, 'aac');
      run(ffmpeg, ['-nostdin', '-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], options);
    }

    // Check for actual Chinese glyphs and compare the installed app's rendered output to its master.
    const assPath = join(studioHome, `字幕 O'Brien,[${arch}].ass`);
    await writeFile(assPath, burned.assText, 'utf8');
    const glyphLog = run(ffmpeg, [
      '-nostdin', '-v', 'verbose', '-ss', '1.5', '-i', masterMp4,
      '-vf', subtitleFilterArg(assPath), '-an', '-frames:v', '1', '-f', 'null', '-',
    ], options).stderr.toString('utf8');
    assert.match(glyphLog, /Using font provider coretext/i);
    assert.doesNotMatch(glyphLog, /failed to find any fallback with glyph|glyph 0x[\da-f]+ not found in font|LastResort/i);
    const crop = (/** @type {string} */ file) => run(ffmpeg, [
      '-nostdin', '-v', 'error', '-ss', '1.5', '-i', file, '-frames:v', '1',
      '-vf', 'crop=iw:ih/4:0:ih*3/4', '-pix_fmt', 'gray', '-f', 'rawvideo', '-',
    ], options).stdout;
    const original = crop(masterMp4);
    const rendered = crop(subbedMp4);
    assert.ok(original.length > 0);
    assert.equal(original.length, rendered.length);
    const visiblePixels = rendered.reduce((count, value, index) => count + Number(value > 205 && (original[index] ?? value) < 175), 0);
    assert.ok(visiblePixels > 100, `Subtitle did not change enough pixels in the rendered frame: ${visiblePixels}`);
    console.log(JSON.stringify({
      result: 'PASS', arch, installed: true, gui: true, integratedTitleBar: true, legacyProfileUntouched: true,
      mp4: true, subtitle: expectedSubtitle, visiblePixels, frames: burned.frames,
    }));
  } catch (error) {
    if (studioLog) console.error(studioLog);
    throw error;
  } finally {
    if (child?.pid !== undefined) {
      signalProcessGroup(child.pid, 'SIGTERM');
      await delay(1000);
      signalProcessGroup(child.pid, 'SIGKILL');
    }
    try {
      if (browser) await browser.close().catch(() => {});
    } finally {
      if (mounted) run('/usr/bin/hdiutil', ['detach', '-force', mountPoint], options);
      await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
  }
}

await main();
