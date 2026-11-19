// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S36-TEMPLATE-LINT 验收 B1..B5
 *
 * 命题：**模板发布前机器能挡住「导出来动效不动」的那一类**。
 *
 * B1 三条种子模板 ok=true、0 error（截图 + json）
 * B2 八个反例逐个命中预期码（表：目录 → code → detail 原文）
 * B3 最硬的一条：`raf-opacity` 看起来完全正常（meta 有、标注有、CSS 也 paused + 负 delay），
 *    只有那段 rAF 在偷偷改 opacity —— 必须被 NON_CSS_ANIMATION 抓到；
 *    把 <script> 摘掉后同一份模板应当变绿（证明红的就是那段脚本，不是别的）
 * B4 CLI：`--json` 结构 + exit code（有 error=1 / 全绿=0），命令原文
 * B5 对 packages/motion/templates 整体跑：0 error，warning 如实列出
 *
 * 运行：node --test --test-concurrency=1 packages/motion/lint.test.mjs
 * （环境路径见 RUN_ROOT：OPENCUT_ENV_JSON 优先，否则自动建 .local-runs/layers/motion-lint/env.json）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { SceneHost, REPO_ROOT } from '../scene-runtime/host.mjs';
import { resolveLayerTestEnv } from '../layers/test-env.mjs';
import { lintTemplate, lintTree, LINT_CODES, LINT_SEVERITY } from './lint.mjs';

/* S57：环境可移植（R37-C5）。OPENCUT_ENV_JSON 优先；否则现建 `.local-runs/layers/motion-lint/env.json`。 */
const TEST_ENV = await resolveLayerTestEnv({ suite: 'motion-lint' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');
const TMP = path.join(RUN_ROOT, 'tmp/s36');
const REPORT = path.join(TMP, 'report.html');
const REPORT_URL = '/' + path.relative(REPO_ROOT, REPORT).split(path.sep).join('/');
const SEEDS = 'packages/motion/templates';
const FIXTURES = 'tests/fixtures/motion-lint';
const BATCH = 'B-SUB1-R18-018';

const SEED_DIRS = ['badge', 'lower-third', 'pulse'];

/** 反例表：目录 → 期望命中的码（顺序无所谓，集合必须完全一致时才断言） */
const CASES = [
  { dir: 'wall-clock', expect: ['WALL_CLOCK'] },
  { dir: 'smil', expect: ['NON_CSS_ANIMATION'] },
  { dir: 'canvas-webgl', expect: ['NON_CSS_ANIMATION'] },
  { dir: 'raf-opacity', expect: ['NON_CSS_ANIMATION', 'WALL_CLOCK'] },
  { dir: 'missing-asset', expect: ['MISSING_ASSET'] },
  { dir: 'bad-range', expect: ['BAD_RANGE', 'BAD_DEFAULT'] },
  { dir: 'unit-mismatch', expect: ['UNIT_MISMATCH', 'WALL_CLOCK'] },
  { dir: 'unannotated', expect: [] }
];

const evidence = {
  batch: BATCH,
  suite: 'lint.test.mjs',
  cases: {},
  codsTable: LINT_SEVERITY,
  screenshots: [],
  startedAt: new Date().toISOString()
};

/** @type {SceneHost} */
let host;
/** @type {import('playwright').Page} */
let page;
const pageErrors = [];

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** @param {string[]} args */
function runNode(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? Number(error.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function shot(name, clip, targetPage) {
  const target = path.join(EVIDENCE_DIR, name);
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  const surface = targetPage ?? page;
  await surface.screenshot(clip ? { path: target, clip } : { path: target });
  return { name, bytes: (await fs.stat(target)).size, sha256: sha(await fs.readFile(target)) };
}

/** 把 lint 结果渲染成一页报告（截图用；报告只是结果的渲染，不参与判定） */
function reportHtml(rows) {
  const row = (item) => {
    const status = item.ok ? '<span class="ok">OK</span>' : '<span class="bad">FAIL</span>';
    const issues = [...item.errors, ...item.warnings]
      .map((issue) => `<li class="${issue.severity}"><code>${issue.code}</code> <span class="where">${issue.file}${issue.line ? `:${issue.line}` : ''}</span> —— ${escapeHtml(issue.detail)}</li>`)
      .join('');
    return `<tr data-dir="${escapeHtml(item.dir)}"><td class="dir">${escapeHtml(item.dir)}</td><td>${status}</td><td>${item.errors.length}</td><td>${item.warnings.length}</td><td><ul>${issues || '<li class="none">—</li>'}</ul></td></tr>`;
  };
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>S36 模板自检报告</title>
<style>
  html,body{margin:0;background:#0b1220;color:#e2e8f0;font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
  .wrap{padding:16px}
  h1{font-size:15px;margin:0 0 4px}
  p.sub{margin:0 0 12px;color:#94a3b8;font-size:12px}
  table{border-collapse:collapse;width:1196px;table-layout:fixed}
  th,td{padding:6px 8px;border-bottom:1px solid rgba(148,163,184,.18);vertical-align:top;text-align:left}
  th{color:#94a3b8;font-weight:600;font-size:12px}
  td.dir{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#e2e8f0;width:250px;white-space:nowrap}
  td:nth-child(2){width:60px}
  td:nth-child(3),td:nth-child(4){width:70px;color:#94a3b8}
  ul{margin:0;padding-left:14px}
  li{font-size:12px;margin:1px 0}
  li.error{color:#fca5a5}
  li.warning{color:#fcd34d}
  li.none{color:#475569;list-style:none;padding-left:0}
  code{color:#93c5fd}
  .where{color:#94a3b8}
  .ok{color:#4ade80;font-weight:600}
  .bad{color:#f87171;font-weight:600}
</style></head><body><div class="wrap">
<h1>S36 模板自检 · ${escapeHtml(rows.length)} 个目录</h1>
<p class="sub">判据：画面必须只是 --motion-t 的函数；自己会走的（墙钟 / SMIL / canvas / rAF）一律 error。</p>
<table><thead><tr><th>模板目录</th><th>结果</th><th>error</th><th>warn</th><th>明细</th></tr></thead>
<tbody>${rows.map(row).join('')}</tbody></table>
</div></body></html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
}

before(async () => {
  const env = JSON.parse(await fs.readFile(path.join(RUN_ROOT, 'env.json'), 'utf8'));
  evidence.batch = env.batchId ?? evidence.batch;
  await fs.mkdir(TMP, { recursive: true });

  /* 先把 11 个目录都跑一遍，报告页与断言共用这一份结果 */
  const rows = [];
  for (const name of SEED_DIRS) {
    const result = await lintTemplate(path.join(REPO_ROOT, SEEDS, name));
    rows.push({ dir: `${SEEDS}/${name}`, ...result });
  }
  for (const item of CASES) {
    const result = await lintTemplate(path.join(REPO_ROOT, FIXTURES, item.dir));
    rows.push({ dir: `${FIXTURES}/${item.dir}`, ...result });
  }
  evidence.report = rows.map((item) => ({
    dir: item.dir,
    ok: item.ok,
    errors: item.errors,
    warnings: item.warnings,
    facts: { entry: item.facts.entry, params: item.facts.params, clockVar: item.facts.clockVar, deterministic: item.facts.deterministic }
  }));

  await fs.writeFile(REPORT, reportHtml(rows), 'utf8');
  host = await new SceneHost({ port: Number(env.sceneOrigin || env.studioPort), viewport: { width: 1240, height: 900 } }).start();
  const handle = await host.open(path.relative(REPO_ROOT, REPORT));
  page = handle.page;
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.waitForSelector('table');
});

after(async () => {
  evidence.pageErrors = pageErrors;
  evidence.finishedAt = new Date().toISOString();
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(path.join(EVIDENCE_DIR, 's36-lint.json'), JSON.stringify(evidence, null, 2) + '\n');
  if (host) await host.stop();
});

/* ── B1 三条种子模板 ───────────────────────────────────────────── */

test('B1 三条种子模板 ok=true、0 error', async () => {
  const results = {};
  for (const name of SEED_DIRS) {
    const result = await lintTemplate(path.join(REPO_ROOT, SEEDS, name));
    results[name] = {
      ok: result.ok,
      errors: result.errors,
      warnings: result.warnings,
      facts: { entry: result.facts.entry, params: result.facts.params, clockVar: result.facts.clockVar, hasClockMeta: result.facts.hasClockMeta }
    };
    assert.equal(result.ok, true, `${name} 有 error：${JSON.stringify(result.errors, null, 1)}`);
    assert.equal(result.errors.length, 0);
    assert.equal(result.facts.hasClockMeta, true, `${name} 缺 motion-clock meta`);
    assert.equal(result.facts.clockVar, '--motion-t');
    assert.ok(result.facts.params.length >= 4, `${name} 参数只有 ${result.facts.params.length} 个`);
  }

  const json = await fs.readFile(path.join(EVIDENCE_DIR, 's36-lint.json'), 'utf8').catch(() => '');
  void json;
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('tbody tr')]
      .filter((tr) => tr.getAttribute('data-dir').startsWith('packages/motion/templates/'))
      .map((tr) => ({ dir: tr.getAttribute('data-dir'), text: tr.textContent }))
  );
  assert.equal(rows.length, 3);

  const box = await page.evaluate(() => {
    const table = document.querySelector('table').getBoundingClientRect();
    const rows = [...document.querySelectorAll('tbody tr')];
    /* 前 3 行就是三条种子模板（行高不等：lower-third 会换行），按第 3 行的下边界截 */
    const third = rows[2].getBoundingClientRect();
    return { x: Math.floor(table.x) - 8, y: Math.max(0, Math.floor(table.y) - 8), width: Math.ceil(table.width) + 16, height: Math.ceil(third.bottom - table.y) + 14 };
  });
  const png = await shot('s36-b1-seed-templates.png', box);
  evidence.cases.B1 = { results, shot: png };
  evidence.screenshots.push(png);
});

/* ── B2 八个反例 ───────────────────────────────────────────────── */

test('B2 八个反例：每个都命中预期码，无重复无漏报', async () => {
  const table = [];
  for (const item of CASES) {
    const dir = path.join(REPO_ROOT, FIXTURES, item.dir);
    const result = await lintTemplate(dir);
    const codes = [...new Set(result.errors.map((entry) => entry.code))].sort();
    const expected = [...new Set(item.expect)].sort();

    assert.deepEqual(codes, expected, `${item.dir} 命中的码不对：${JSON.stringify(result.errors.map((e) => `${e.code}@${e.file}:${e.line ?? '?'}`))}`);
    assert.equal(result.ok, item.expect.length === 0, `${item.dir} 的 ok 与预期不符`);

    /* 每条 issue 的 severity 必须与 LINT_SEVERITY 表一致（不许某个码一会儿 error 一会儿 warning） */
    for (const entry of [...result.errors, ...result.warnings]) {
      assert.equal(entry.severity, LINT_SEVERITY[entry.code], `${entry.code} 的 severity 与表不一致`);
      assert.ok(entry.detail.length > 0);
    }
    table.push({
      dir: item.dir,
      ok: result.ok,
      codes,
      issues: [...result.errors, ...result.warnings].map((entry) => ({ code: entry.code, severity: entry.severity, file: entry.file, line: entry.line ?? null, detail: entry.detail }))
    });
  }
  evidence.cases.B2 = { table };
});

/* ── B3 「看着完全正常」的 rAF 模板 ───────────────────────────── */

test('B3 看起来正常但用 rAF 改 opacity 的模板必须被 NON_CSS_ANIMATION 抓到', async () => {
  const dir = path.join(REPO_ROOT, FIXTURES, 'raf-opacity');
  const result = await lintTemplate(dir);

  /* ① 它「看起来正常」的证据：meta 有、标注有、CSS 里那条动画是 paused + 负 delay 的 */
  assert.equal(result.facts.hasClockMeta, true, '这个反例本来应该有 clock meta');
  assert.deepEqual(result.facts.params, ['period'], '这个反例本来应该有 period 标注');
  assert.equal(result.facts.deterministic, false, 'rAF 模板不该被判成 deterministic');

  const nonCss = result.errors.filter((entry) => entry.code === LINT_CODES.NON_CSS_ANIMATION);
  assert.ok(nonCss.length >= 1, `没抓到 rAF：${JSON.stringify(result.errors)}`);
  assert.ok(
    nonCss.some((entry) => /requestAnimationFrame/.test(entry.detail)),
    `NON_CSS_ANIMATION 的 detail 没说是 requestAnimationFrame：${JSON.stringify(nonCss)}`
  );
  /* 报出来的行号必须落在那段脚本里（21..28 行之间） */
  const rafLines = nonCss.filter((entry) => /requestAnimationFrame/.test(entry.detail)).map((entry) => entry.line ?? 0);
  assert.ok(rafLines.every((line) => line >= 20 && line <= 30), `rAF 行号离谱：${rafLines}`);

  /* ② 把 <script> 摘掉，同一份模板应当变绿 —— 证明红的原因就是那段脚本 */
  const html = await fs.readFile(path.join(dir, 'raf-opacity.html'), 'utf8');
  const stripped = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '<!-- script removed for B3 control -->');
  const controlDir = path.join(TMP, 'b3-control');
  await fs.mkdir(controlDir, { recursive: true });
  await fs.writeFile(path.join(controlDir, 'raf-opacity.html'), stripped, 'utf8');
  await fs.copyFile(path.join(dir, 'raf-opacity.css'), path.join(controlDir, 'raf-opacity.css'));
  const control = await lintTemplate(path.join(controlDir, 'raf-opacity.html'));
  assert.equal(control.ok, true, `摘掉脚本后应当变绿，实际：${JSON.stringify(control.errors)}`);
  assert.equal(control.facts.deterministic, true);

  /* 专用信息卡：左边「看起来正常」的证据，右边「被抓到的」。比在表格里截一行清楚得多。 */
  const cardPath = path.join(TMP, 'b3-raf.html');
  const issueRows = result.errors
    .map((entry) => `<li><code>${entry.code}</code> <span class="where">${entry.file}:${entry.line ?? '?'}</span><div class="detail">${escapeHtml(entry.detail)}</div></li>`)
    .join('');
  await fs.writeFile(
    cardPath,
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>B3 rAF 反例</title><style>
  html,body{margin:0;background:#0b1220;color:#e2e8f0;font:13px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
  .wrap{padding:18px 20px;width:1120px}
  h1{font-size:16px;margin:0 0 2px}
  .path{color:#94a3b8;font-family:ui-monospace,Menlo,monospace;font-size:12px;margin-bottom:14px}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:18px}
  h2{font-size:13px;margin:0 0 8px;color:#94a3b8;font-weight:600;letter-spacing:.02em}
  ul{margin:0;padding-left:16px}
  li{margin:0 0 8px}
  .ok li{color:#86efac}
  .bad li{color:#fca5a5}
  code{color:#93c5fd}
  .where{color:#94a3b8;font-family:ui-monospace,Menlo,monospace;font-size:11px}
  .detail{color:#e2e8f0;font-size:12px;margin-top:2px}
  .verdict{margin-top:14px;padding:8px 10px;border-radius:6px;background:#111f38;border:1px solid rgba(148,163,184,.25)}
  .pill{display:inline-block;padding:1px 7px;border-radius:999px;background:#7f1d1d;color:#fecaca;font-size:11px;margin-left:6px}
</style></head><body><div class="wrap">
<h1>B3 · 看起来完全正常，但用 rAF 每帧改 opacity</h1>
<div class="path">tests/fixtures/motion-lint/raf-opacity<span class="pill">FAIL · ${result.errors.length} error</span></div>
<div class="cols">
  <div class="ok"><h2>它「看起来正常」的证据</h2><ul>
    <li>有 &lt;meta name="motion-clock" content="--motion-t;unit=ms"&gt;</li>
    <li>参数标注齐全：<code>period</code>（number · 300–2000 · 默认 900）</li>
    <li>CSS 里那条 <code>breathe</code> 是 <code>animation-play-state: paused</code> + <code>animation-delay: calc(-1 * var(--motion-t) * 1ms)</code></li>
    <li>静态看没有任何「墙钟」特征</li>
  </ul></div>
  <div class="bad"><h2>被抓到的</h2><ul>${issueRows}</ul></div>
</div>
<div class="verdict">摘掉 <code>&lt;script&gt;</code> 后同一份模板：<b style="color:#86efac">ok=true，0 error，deterministic=true</b> —— 红的原因就是那段 rAF，不是别的。</div>
</div></body></html>`,
    'utf8'
  );
  const cardHandle = await host.open(path.relative(REPO_ROOT, cardPath));
  await cardHandle.page.waitForSelector('.verdict');
  const png = await shot('s36-b3-raf.png', await cardHandle.page.evaluate(() => {
    const box = document.querySelector('.wrap').getBoundingClientRect();
    return { x: 0, y: 0, width: Math.ceil(box.width), height: Math.ceil(box.height) };
  }), cardHandle.page);

  evidence.cases.B3 = {
    caught: nonCss.map((entry) => ({ code: entry.code, line: entry.line, detail: entry.detail })),
    facts: { hasClockMeta: result.facts.hasClockMeta, params: result.facts.params, deterministic: result.facts.deterministic },
    controlWithoutScript: { ok: control.ok, errors: control.errors, deterministic: control.facts.deterministic },
    shot: png
  };
  evidence.screenshots.push(png);
});

/* ── B4 CLI ───────────────────────────────────────────────────── */

test('B4 CLI：--json 结构 + exit code', async () => {
  const failing = await runNode(['packages/motion/lint.mjs', `${FIXTURES}/raf-opacity`, '--json']);
  assert.equal(failing.code, 1, `有 error 时 CLI 应退 1，实际 ${failing.code}\n${failing.stderr}`);
  const parsed = JSON.parse(failing.stdout);
  assert.equal(typeof parsed.ok, 'boolean');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.target, `${FIXTURES}/raf-opacity`);
  assert.ok(Array.isArray(parsed.errors) && parsed.errors.length > 0);
  assert.ok(Array.isArray(parsed.warnings));
  assert.ok(Array.isArray(parsed.results) && parsed.results.length === 1);
  const first = parsed.errors[0];
  for (const key of ['code', 'severity', 'file', 'detail']) {
    assert.equal(typeof first[key], 'string', `issue 缺字段 ${key}`);
  }

  const passing = await runNode(['packages/motion/lint.mjs', SEEDS, '--json']);
  assert.equal(passing.code, 0, `全绿时 CLI 应退 0，实际 ${passing.code}\n${passing.stdout}\n${passing.stderr}`);
  const okParsed = JSON.parse(passing.stdout);
  assert.equal(okParsed.ok, true);
  assert.equal(okParsed.errors.length, 0);
  assert.equal(okParsed.results.length, 3);

  /* 人话模式也要能跑，且带「合计」行 */
  const human = await runNode(['packages/motion/lint.mjs', SEEDS]);
  assert.equal(human.code, 0);
  assert.match(human.stdout, /合计：3 个模板，0 error/);

  const bad = await runNode(['packages/motion/lint.mjs', `${FIXTURES}/missing-asset`]);
  assert.equal(bad.code, 1);
  assert.match(bad.stdout, /MISSING_ASSET/);

  evidence.cases.B4 = {
    commands: [
      { cmd: 'node packages/motion/lint.mjs tests/fixtures/motion-lint/raf-opacity --json', exit: failing.code, stdoutHead: failing.stdout.split('\n').slice(0, 3) },
      { cmd: 'node packages/motion/lint.mjs packages/motion/templates --json', exit: passing.code, stdoutHead: passing.stdout.split('\n').slice(0, 3) },
      { cmd: 'node packages/motion/lint.mjs packages/motion/templates', exit: human.code, stdoutTail: human.stdout.trim().split('\n').slice(-2) },
      { cmd: 'node packages/motion/lint.mjs tests/fixtures/motion-lint/missing-asset', exit: bad.code, stdoutTail: bad.stdout.trim().split('\n').slice(-2) }
    ],
    jsonShape: { top: Object.keys(parsed), issue: Object.keys(first) }
  };
});

/* ── B5 对模板目录整体跑 ───────────────────────────────────────── */

test('B5 packages/motion/templates 整体：0 error，warning 如实列出', async () => {
  const tree = await lintTree(path.join(REPO_ROOT, SEEDS));
  assert.equal(tree.ok, true, `整体有 error：${JSON.stringify(tree.errors, null, 1)}`);
  assert.equal(tree.errors.length, 0);
  assert.equal(tree.results.length, 3, `只应有 3 个模板，实际 ${tree.results.length}`);

  const warnings = tree.results.flatMap((item) => item.warnings.map((entry) => ({ dir: item.dir, ...entry })));
  /* 有几条写几条：不为好看去改模板，也不把 warning 藏起来 */
  evidence.cases.B5 = {
    ok: tree.ok,
    templates: tree.results.map((item) => ({ dir: item.dir, ok: item.ok, errors: item.errors.length, warnings: item.warnings.length, params: item.facts.params.length })),
    warnings
  };
  assert.equal(warnings.length, 0, `种子模板出现了 warning，如实记录后请复核：${JSON.stringify(warnings)}`);
});
