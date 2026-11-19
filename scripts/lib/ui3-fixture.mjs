// @ts-nocheck —— 取证夹具；产品模块仍由 tsc 严格检查。
/**
 * UI-3 / UI-4 共用的夹具与页内量测（B-SUB1-R31-058）。
 *
 * 夹具与 `scripts/ui-shots.mjs --profile=ui1` **同一份**：同一张 `film-v12.html`、
 * 同样两个场景页（`#title` / `#lead` / `#cards` / `#card-1..3` / `#foot`）、同样两条视频 +
 * 三条音频。改前改后要「同素材同操作」，所以这里不另造一套。
 */

import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const REPO = new URL('../..', import.meta.url).pathname;

const SCENE = (label, accent) => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${label}</title>
<style>
  html, body { margin: 0; width: 1280px; height: 720px; background: #0b1220; color: #f8fafc;
    font-family: system-ui, "PingFang SC", "Microsoft YaHei", sans-serif; }
  /* 四周留 56px 的 body 边：舞台点这块区域 = 「点片段本体」（命中不到任何层）。 */
  .page { position: absolute; left: 56px; top: 56px; right: 56px; bottom: 56px; box-sizing: border-box;
    padding: 28px 36px; display: flex; flex-direction: column; gap: 16px; }
  h1 { margin: 0; font-size: 56px; letter-spacing: -0.02em; }
  p.lead { margin: 0; font-size: 21px; color: #cbd5e1; max-width: 780px; }
  .cards { display: flex; gap: 18px; margin-top: 10px; }
  .card { flex: 1 1 0; padding: 20px; border-radius: 14px; background: #16233a; border: 1px solid #24324d; }
  .card h2 { margin: 0 0 8px; font-size: 21px; color: ${accent}; }
  .card span { font-size: 15px; color: #94a3b8; }
  footer { margin-top: auto; font-size: 14px; color: #64748b; }
</style>
</head>
<body>
  <div class="page" id="page">
    <h1 id="title">${label}</h1>
    <p class="lead" id="lead">这一页是 UI-1 的量测夹具：层级够多、字段够长，检查器才会溢出。</p>
    <div class="cards" id="cards">
      <div class="card" id="card-1"><h2>入轨</h2><span>素材、序列、轨道</span></div>
      <div class="card" id="card-2"><h2>降噪</h2><span>字幕、动效、覆盖</span></div>
      <div class="card" id="card-3"><h2>收口</h2><span>导出、账本、回归</span></div>
    </div>
    <footer id="foot">OpenFilm · ${label}</footer>
  </div>
<script>
  window.film = {
    meta: { width: 1280, height: 720, duration: 4 },
    async ready() { document.body.dataset.filmReady = '1'; },
    async frame(t) { document.body.dataset.filmFrame = Number(t).toFixed(3); }
  };
</script>
</body>
</html>
`;

/**
 * 建一份与 `ui-shots --profile=ui1` 相同的工程目录。
 * @param {string} work 临时目录
 * @returns {Promise<{dir: string, projectsRoot: string}>}
 */
export async function buildUi1Project(work) {
  const projectsRoot = join(work, 'projects');
  const dir = join(projectsRoot, 'ui1-fixture');
  await mkdir(join(dir, 'scenes'), { recursive: true });
  await mkdir(join(dir, 'assets'), { recursive: true });
  await copyFile(join(REPO, 'contracts/fixtures/film-v12.html'), join(dir, 'film.html'));
  await writeFile(join(dir, 'scenes', 'card-a.html'), SCENE('季度复盘', '#1f6feb'), 'utf8');
  await writeFile(join(dir, 'scenes', 'card-b.html'), SCENE('下一步', '#3fb950'), 'utf8');

  const ffmpeg = join(REPO, 'resources/bin/ffmpeg');
  const ff = (args) => execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'pipe' });
  ff(['-f', 'lavfi', '-i', 'color=c=0x1f6feb:s=320x180:d=9:r=24', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', join(dir, 'assets', 'take-01.mp4')]);
  ff(['-f', 'lavfi', '-i', 'color=c=0x3fb950:s=320x180:d=9:r=24', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', join(dir, 'assets', 'take-02.mp4')]);
  ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=9', '-ac', '1', '-ar', '44100', join(dir, 'assets', 'voice.wav')]);
  ff(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=9', '-ac', '1', '-ar', '44100', '-b:a', '64k', join(dir, 'assets', 'bgm.mp3')]);
  ff(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=1', '-ac', '1', '-ar', '44100', join(dir, 'assets', 'whoosh.wav')]);

  return { dir, projectsRoot };
}

/** 与 ui-shots 的 ui1 档同一个就绪判据。 */
export async function waitUi1Ready(page) {
  await page.waitForSelector('[data-testid="preview"]', { timeout: 30000 });
  await page.waitForSelector('.tl-clip', { timeout: 30000 });
  await page.waitForSelector('[data-testid="layer-select"]', { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="layer-select"] option').length > 1, undefined, { timeout: 30000 });
  await page
    .waitForFunction(() => (document.querySelector('[data-testid="inspector-target"]')?.textContent ?? '').trim() !== '', undefined, { timeout: 15000 })
    .catch(() => undefined);
  await new Promise((done) => globalThis.setTimeout(done, 350));
}

/** 固定的「等一拍」：量测前让 React 与舞台帧都落定。 */
export const settle = (page, ms = 220) => page.waitForTimeout(ms);

/**
 * 页内量测：控件清单 + 可交互元素 + Tab 顺序的原料。
 * 只读 DOM，不点任何东西。
 */
export function inventoryInPage() {
  const describe = (el) => {
    const rect = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      testid: el.getAttribute('data-testid') ?? '',
      type: el.getAttribute('type') ?? '',
      name: (el.getAttribute('aria-label') ?? el.textContent ?? el.getAttribute('placeholder') ?? '').trim().replace(/\s+/g, ' ').slice(0, 40),
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      visible: rect.width > 0 && rect.height > 0,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
    };
  };
  const testids = [...document.querySelectorAll('[data-testid]')].map((el) => el.getAttribute('data-testid'));
  const interactive = [...document.querySelectorAll('button, input, select, textarea, [role="button"], a[href]')]
    .filter((el) => el.offsetParent !== null || el.getBoundingClientRect().width > 0)
    .map(describe);
  return {
    testids: testids.sort(),
    testidCount: testids.length,
    uniqueTestids: [...new Set(testids)].sort(),
    interactiveCount: interactive.length,
    interactive,
    disabled: interactive.filter((item) => item.disabled).map((item) => `${item.tag}${item.testid === '' ? '' : `[${item.testid}]`}:${item.name}`),
  };
}
