// @ts-nocheck —— 验收脚本以 node --test 运行时断言为准；产品模块仍由 tsc 严格检查。
/**
 * S29-MOTION-LIBRARY 验收 A1..A4
 *
 * A1/A2 是纯 Node（安装幂等 + 校验错误码）。
 * A3 是**真模板**：每条的 .html 用 SceneHost 直接当文档打开（`<link>`/`<img>` 都是相对路径，
 *    真加载），先用 `instantiate()` 拿覆盖条目，再在页内用 `applyOverrideEntries` 落到 DOM，
 *    对比应用前后的 computed style —— 不是贴 JSON。
 * A4 是真面板：宿主侧用 `listEntries` 拍成 MotionEntryView，挂 `mountMotionPanel`；
 *    删掉一个资产后再挂一次，验「变红 + 应用禁用」。
 *
 * 运行：node --test --test-concurrency=1 packages/motion/seed.test.mjs
 * （环境路径见 RUN_ROOT：OPENCUT_ENV_JSON 优先，否则自动建 .local-runs/layers/motion-seed/env.json）
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { build as esbuild } from 'esbuild';
import { SceneHost, REPO_ROOT } from '../scene-runtime/host.mjs';
import { resolveLayerTestEnv } from '../layers/test-env.mjs';
import { installSeedLibrary, SEED_TEMPLATES } from './seed.mjs';
import { instantiate, listEntries, readLibrary, validateLibrary } from './library.mjs';

/* S57：环境可移植（R37-C5）。OPENCUT_ENV_JSON 优先；否则现建 `.local-runs/layers/motion-seed/env.json`。 */
const TEST_ENV = await resolveLayerTestEnv({ suite: 'motion-seed' });
const RUN_ROOT = TEST_ENV.runRoot;
const EVIDENCE_DIR = path.join(RUN_ROOT, 'evidence');
const PROJECTS = path.join(RUN_ROOT, 'projects');
const BUNDLE_ABS = path.join(RUN_ROOT, 'tmp/s29/bundle.js');
const BUNDLE_URL = '/' + path.relative(REPO_ROOT, BUNDLE_ABS).split(path.sep).join('/');
const PANEL_FIXTURE = 'tests/fixtures/scenes/motion-panel-stage.html';
const BATCH = 'B-SUB1-R15-015';

/** 每条模板「应用时」用的自定义参数（与默认值都不同，才看得出变化） */
const CUSTOM = {
  pulse: { duration: 2400, easing: 'linear', color: '#ef4444', label: '测试脉冲', badge: false },
  badge: { title: '已上线', size: 26, accent: '#f59e0b', align: 'flex-end' },
  'lower-third': { headline: '改过的标题', subline: '副标题也改了', width: 90, tint: '#22d3ee', weight: '400' }
};

const evidence = {
  batch: BATCH,
  suite: 'seed.test.mjs',
  cases: {},
  screenshots: [],
  startedAt: new Date().toISOString()
};

/** @type {SceneHost} */
let host;

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function buildBundle() {
  await fs.mkdir(path.dirname(BUNDLE_ABS), { recursive: true });
  await esbuild({
    stdin: {
      contents: [
        "export { applyOverrideEntries } from './packages/layers/apply-overrides.mjs';",
        "export { mountMotionPanel } from './packages/motion/panel.mjs';"
      ].join('\n'),
      resolveDir: REPO_ROOT,
      loader: 'js'
    },
    bundle: true,
    format: 'iife',
    globalName: 'R29',
    platform: 'browser',
    target: 'es2022',
    outfile: BUNDLE_ABS,
    logLevel: 'silent'
  });
}

async function save() {
  const files = [];
  for (const name of ['s29-a4-normal.png', 's29-a4-missing.png', 's29-a3-pulse.png', 's29-a3-badge.png', 's29-a3-lower-third.png']) {
    try {
      const buf = await fs.readFile(path.join(EVIDENCE_DIR, name));
      files.push({ name, bytes: buf.length, sha256: sha(buf) });
    } catch {
      files.push({ name, bytes: 0, sha256: null, missing: true });
    }
  }
  evidence.screenshots = files;
  evidence.finishedAt = new Date().toISOString();
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await fs.writeFile(path.join(EVIDENCE_DIR, 's29-motion-library.json'), JSON.stringify(evidence, null, 2) + '\n');
}

before(async () => {
  const env = JSON.parse(await fs.readFile(path.join(RUN_ROOT, 'env.json'), 'utf8'));
  evidence.batch = env.batchId ?? evidence.batch;
  await buildBundle();
  host = await new SceneHost({ port: Number(env.sceneOrigin || env.studioPort), viewport: { width: 1280, height: 720 } }).start();
  evidence.browser = host.browserVersion;
});

after(async () => {
  await save();
  if (host) await host.stop();
});

/** 全新临时工程目录 */
async function freshProject(name) {
  const dir = path.join(PROJECTS, `${name}-${process.pid}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** 宿主侧适配：LibraryStatus → MotionEntryView（MAIN 接线照这个写） */
async function viewsOf(root) {
  const { library } = await readLibrary(root);
  const statuses = await listEntries(root, library);
  return statuses.map(({ entry, status, missingAssets }) => ({
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    sourceOk: status !== 'source-missing',
    assetIssues: missingAssets.map((asset) => ({ path: asset.path, reason: '资源不存在' })),
    params: Object.entries(entry.params ?? {}).map(([name, spec]) => {
      const view = { name, label: spec.label ?? name, type: spec.type };
      if (spec.default !== undefined) view.default = spec.default;
      if (typeof spec.min === 'number') view.min = spec.min;
      if (typeof spec.max === 'number') view.max = spec.max;
      if (typeof spec.step === 'number') view.step = spec.step;
      if (Array.isArray(spec.options)) view.options = [...spec.options];
      return view;
    })
  }));
}

/* ── A1 幂等安装 ─────────────────────────────────────────────────── */

test('A1 装到临时工程：installed=3/skipped=0，再装 installed=0/skipped=3', async () => {
  const root = await freshProject('seed-a1');
  const first = await installSeedLibrary(root);
  assert.equal(first.ok, true, `安装失败：${JSON.stringify(first)}`);
  assert.deepEqual([...first.installed].sort(), ['badge', 'lower-third', 'pulse']);
  assert.deepEqual(first.skipped, []);
  assert.equal(first.validation.ok, true);
  const assetCopies = first.copied.filter((rel) => rel.startsWith('motion/assets/'));
  assert.equal(assetCopies.length, 9, `首次应复制 9 个模板/资产文件，实际 ${assetCopies.length}`);
  assert.equal(first.copied.length, 12, `外加 3 份版本快照，首次共 12 个文件，实际 ${first.copied.length}`);
  assert.equal(first.kept.length, 0);

  const libraryFile = path.join(root, 'motion/library.json');
  const raw = await fs.readFile(libraryFile, 'utf8');
  const lib = JSON.parse(raw);
  assert.equal(lib.entries.length, 3);
  assert.equal(lib.version, 1);

  /* 第二次：一个字节都不该动 */
  const second = await installSeedLibrary(root);
  assert.equal(second.ok, true);
  assert.deepEqual(second.installed, []);
  assert.deepEqual([...second.skipped].sort(), ['badge', 'lower-third', 'pulse']);
  assert.equal(second.copied.length, 0, `幂等重跑不应复制文件，实际 ${second.copied.join(',')}`);
  assert.equal(await fs.readFile(libraryFile, 'utf8'), raw, 'library.json 被重写了');

  /* 三种 kind 各一条、参数 ≥3、至少两类控件 */
  const kinds = lib.entries.map((entry) => entry.kind).sort();
  assert.deepEqual(kinds, ['animation', 'component', 'saved']);
  for (const entry of lib.entries) {
    const params = Object.values(entry.params);
    assert.ok(params.length >= 3, `${entry.name} 参数不足 3 个`);
    const types = new Set(params.map((spec) => spec.type));
    assert.ok(types.size >= 2, `${entry.name} 控件类型不足两类：${[...types]}`);
    /* 资产真的在包里、且不是网络地址 */
    assert.ok(entry.assets.length > 0, `${entry.name} 没有资产`);
    for (const asset of entry.assets) {
      assert.ok(!/^(https?:)?\/\//.test(asset.ref), `资产是网络地址：${asset.ref}`);
      await fs.access(path.join(root, asset.path));
    }
    const html = await fs.readFile(path.join(root, entry.sourcePath), 'utf8');
    assert.ok(!/https?:\/\//.test(html.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '')), `${entry.name} 的模板引用了网络资源`);
  }

  /* CLI：另起一个工程，走可执行入口 */
  const cliRoot = await freshProject('seed-a1-cli');
  const cli = await new Promise((resolve) => {
    execFile(process.execPath, ['packages/motion/seed.mjs', cliRoot], { cwd: REPO_ROOT }, (error, stdout, stderr) =>
      resolve({ code: error ? Number(error.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) })
    );
  });
  assert.equal(cli.code, 0, `CLI 退出码 ${cli.code}\n${cli.stderr}`);
  assert.match(cli.stdout, /安装 3 条：pulse \/ badge \/ lower-third/);
  assert.match(cli.stdout, /校验：通过/);
  await fs.access(path.join(cliRoot, 'motion/library.json'));

  evidence.cases.A1 = {
    installed: first.installed,
    skippedAfter: second.skipped,
    copied: first.copied,
    libraryBytes: Buffer.byteLength(raw),
    librarySha256: sha(Buffer.from(raw)),
    kinds,
    cli: { code: cli.code, lines: cli.stdout.trim().split('\n') }
  };
});

/* ── A2 校验：干净库过、四种改坏各给不同码 ───────────────────────── */

test('A2 干净库过 validateLibrary；缺资产/重复 id/坏 schema/越界默认值 → 4 个不同错误码', async () => {
  const root = await freshProject('seed-a2');
  const seeded = await installSeedLibrary(root);
  assert.equal(seeded.ok, true);

  const { library } = await readLibrary(root);
  const clean = await validateLibrary(root, library);
  assert.equal(clean.ok, true, `干净库不该报错：${JSON.stringify(clean.errors)}`);

  /* ① 缺资产：删掉 pulse.css（在副本上动，别影响其它用例） */
  const missingRoot = await freshProject('seed-a2-missing');
  await fs.cp(path.join(root, 'motion'), path.join(missingRoot, 'motion'), { recursive: true });
  await fs.rm(path.join(missingRoot, 'motion/assets/pulse/pulse.css'));
  const missingLib = (await readLibrary(missingRoot)).library;
  const missing = await validateLibrary(missingRoot, missingLib);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'MISSING_ASSET', JSON.stringify(missing.errors));

  /* ② 重复 id */
  const dupLib = structuredClone(library);
  dupLib.entries.push({ ...structuredClone(dupLib.entries[0]) });
  const duplicate = await validateLibrary(root, dupLib);
  assert.equal(duplicate.code, 'DUPLICATE_ID', JSON.stringify(duplicate.errors));

  /* ③ 坏 schema：类型不是五种之一 */
  const badSchemaLib = structuredClone(library);
  badSchemaLib.entries[0].params.__broken = { type: 'nope' };
  const badSchema = await validateLibrary(root, badSchemaLib);
  assert.equal(badSchema.code, 'INVALID_SCHEMA', JSON.stringify(badSchema.errors));

  /* ④ 默认值越界：duration 默认 999999（min 200 / max 4000） */
  const outOfRangeLib = structuredClone(library);
  const pulse = outOfRangeLib.entries.find((entry) => entry.name === 'pulse');
  pulse.params.duration.default = 999999;
  const outOfRange = await validateLibrary(root, outOfRangeLib);
  assert.equal(outOfRange.code, 'DEFAULT_OUT_OF_RANGE', JSON.stringify(outOfRange.errors));

  /* ⑤ 第五类：version 不是整数（任务书 3.3 提到） */
  const badVersionLib = structuredClone(library);
  badVersionLib.entries[0].version = 2.5;
  const badVersion = await validateLibrary(root, badVersionLib);
  assert.equal(badVersion.code, 'BAD_VERSION', JSON.stringify(badVersion.errors));

  const codes = [missing.code, duplicate.code, badSchema.code, outOfRange.code, badVersion.code];
  assert.equal(new Set(codes).size, 5, `错误码应互不相同：${codes.join(',')}`);

  evidence.cases.A2 = {
    clean: { ok: clean.ok, errors: clean.errors.length },
    codes,
    samples: {
      missingAsset: missing.errors[0],
      duplicateId: duplicate.errors[0],
      invalidSchema: badSchema.errors[0],
      defaultOutOfRange: outOfRange.errors[0],
      badVersion: badVersion.errors[0]
    }
  };
});

/* ── A3 三条模板都能 instantiate，且落到 DOM 有可见变化 ──────────── */

test('A3 3 条模板都能 instantiate：给出每条应用前/后的 DOM 差异', async () => {
  const root = await freshProject('seed-a3');
  const seeded = await installSeedLibrary(root);
  assert.equal(seeded.ok, true);
  const { library } = await readLibrary(root);

  /** @type {Record<string, any>} */
  const perTemplate = {};
  for (const tpl of SEED_TEMPLATES) {
    const entry = library.entries.find((item) => item.name === tpl.name);
    assert.ok(entry, `库里没有 ${tpl.name}`);
    const inst = await instantiate(root, library, entry.id, { clipId: `clip-${tpl.slug}`, params: CUSTOM[tpl.slug] });
    assert.equal(inst.ok, true, `${tpl.name} instantiate 失败：${JSON.stringify(inst)}`);
    assert.ok(inst.clip.overrides.length > 0, `${tpl.name} 没有产出覆盖条目`);

    const rel = path.relative(REPO_ROOT, path.join(root, entry.sourcePath)).split(path.sep).join('/');
    const handle = await host.open(rel);
    const page = handle.page;
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.addScriptTag({ url: BUNDLE_URL });

    const readStyles = () =>
      page.evaluate(() => {
        const q = (sel) => document.querySelector(sel);
        const cs = (sel) => getComputedStyle(q(sel));
        const img = document.querySelector('img');
        const base = {
          imgLoaded: !!img && img.complete && img.naturalWidth > 0,
          docTitle: document.title
        };
        if (q('.pulse-core')) {
          return {
            ...base,
            kind: 'pulse',
            animationDuration: cs('.pulse-core').animationDuration,
            animationTiming: cs('.pulse-core').animationTimingFunction,
            coreColor: cs('.pulse-core').backgroundColor,
            label: q('.pulse-label').textContent,
            badgeOpacity: cs('.pulse-badge').opacity
          };
        }
        if (q('.badge-title')) {
          return {
            ...base,
            kind: 'badge',
            title: q('.badge-title').textContent,
            fontSize: cs('.badge-title').fontSize,
            titleColor: cs('.badge-title').color,
            justify: cs('.motion-badge').justifyContent
          };
        }
        return {
          ...base,
          kind: 'lower-third',
          headline: q('.lt-headline').textContent,
          subline: q('.lt-subline').textContent,
          barWidth: cs('.lt-bar').width,
          borderLeft: cs('.lt-bar').borderLeftColor,
          fontWeight: cs('.lt-headline').fontWeight
        };
      });

    const before = await readStyles();
    assert.equal(before.imgLoaded, true, `${tpl.name} 的 SVG 资产没加载（相对路径或资产缺失）`);

    const applied = await page.evaluate(
      (arg) => {
        const rootEl = document.querySelector('[data-role="root"]');
        rootEl.setAttribute('data-instance', arg.clipId);
        const result = window.R29.applyOverrideEntries(arg.overrides);
        return { ...result, instance: rootEl.getAttribute('data-instance') };
      },
      { overrides: inst.clip.overrides, clipId: inst.clip.id }
    );
    assert.equal(applied.applied > 0, true, `${tpl.name} 一条覆盖都没落地：${JSON.stringify(applied)}`);
    assert.deepEqual(applied.unsupported, [], `${tpl.name} 有被拒的覆盖：${JSON.stringify(applied.unsupported)}`);

    const after = await readStyles();
    await page.screenshot({ path: path.join(EVIDENCE_DIR, `s29-a3-${tpl.slug}.png`) });
    assert.deepEqual(pageErrors, []);
    await handle.dispose();

    perTemplate[tpl.slug] = { entry: entry.id, overrides: inst.clip.overrides.length, before, after, applied };
  }

  /* 每条都要有「可见变化」的硬证据 */
  const pulse = perTemplate.pulse;
  assert.equal(pulse.before.animationDuration, '1.2s');
  assert.equal(pulse.after.animationDuration, '2.4s', `pulse 周期没变：${pulse.after.animationDuration}`);
  assert.equal(pulse.before.coreColor, 'rgb(59, 130, 246)');
  assert.equal(pulse.after.coreColor, 'rgb(239, 68, 68)');
  assert.equal(pulse.before.animationTiming, 'ease-out');
  assert.equal(pulse.after.animationTiming, 'linear');
  assert.equal(pulse.before.label, '脉冲');
  assert.equal(pulse.after.label, '测试脉冲');
  assert.equal(pulse.before.badgeOpacity, '1');
  assert.equal(pulse.after.badgeOpacity, '0');

  const badge = perTemplate.badge;
  assert.equal(badge.before.title, '新版本已就绪');
  assert.equal(badge.after.title, '已上线');
  assert.equal(badge.before.fontSize, '18px');
  assert.equal(badge.after.fontSize, '26px');
  /* Chromium 把 flex-start 序列化成 flow-start（CSS Box Alignment L3），两种写法都认 */
  assert.match(badge.before.justify, /(?:flex|flow)-start/);
  assert.match(badge.after.justify, /(?:flex|flow)-end/);

  const lower = perTemplate['lower-third'];
  assert.equal(lower.before.headline, '今晚 8 点直播');
  assert.equal(lower.after.headline, '改过的标题');
  assert.equal(lower.before.fontWeight, '700');
  assert.equal(lower.after.fontWeight, '400');
  assert.ok(parseFloat(lower.after.barWidth) > parseFloat(lower.before.barWidth), `宽度没变宽：${lower.before.barWidth} → ${lower.after.barWidth}`);

  evidence.cases.A3 = perTemplate;
});

/* ── A4 面板：3 条正常 / 缺资产变红且禁用应用 ───────────────────── */

test('A4 面板显示 3 条（sourceOk 全 true）；删一个资产后对应条目变红且「应用」禁用', async () => {
  const root = await freshProject('seed-a4');
  const seeded = await installSeedLibrary(root);
  assert.equal(seeded.ok, true);

  const normalViews = await viewsOf(root);
  assert.equal(normalViews.length, 3);
  assert.deepEqual(normalViews.map((view) => view.sourceOk), [true, true, true]);
  assert.deepEqual(normalViews.map((view) => view.assetIssues.length), [0, 0, 0]);

  /** 挂面板并读状态 */
  async function mountPanel(views) {
    const handle = await host.open(PANEL_FIXTURE);
    const page = handle.page;
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.addScriptTag({ url: BUNDLE_URL });
    await page.evaluate(async (arg) => {
      const rail = document.getElementById('rail');
      rail.textContent = '';
      window.__applied = [];
      window.__panel = window.R29.mountMotionPanel(rail, {
        loadLibrary: async () => ({ ok: true, entries: arg.views }),
        applyEntry: async (id, params) => {
          window.__applied.push({ id, params });
          return { ok: true };
        }
      });
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    }, { views });
    await page.waitForFunction(() => {
      const state = window.__panel?.getState();
      return !!state && state.phase !== 'loading';
    });
    return { handle, page, pageErrors };
  }

  /* ① 正常态 */
  const normal = await mountPanel(normalViews);
  const normalDom = await normal.page.evaluate(() => ({
    rows: [...document.querySelectorAll('[data-motion-entry]')].map((row) => ({
      id: row.getAttribute('data-id'),
      sourceOk: row.getAttribute('data-source-ok'),
      assetIssues: row.getAttribute('data-asset-issues'),
      name: row.querySelector('[data-motion-name]')?.textContent ?? ''
    })),
    status: document.querySelector('[data-motion-status]')?.textContent ?? '',
    state: window.__panel.getState()
  }));
  assert.equal(normalDom.rows.length, 3);
  assert.equal(normalDom.rows.every((row) => row.sourceOk === 'true'), true);
  assert.equal(normalDom.rows.every((row) => row.assetIssues === '0'), true);
  assert.equal(normalDom.state.counts.entries, 3);

  /* 选中 pulse（库里按名字排序是 badge 在前；这里指定 id，别吃排序的亏）：参数表单要按 schema 出来 */
  const pulseView = normalViews.find((view) => view.name === 'pulse');
  await normal.page.click(`[data-motion-entry][data-id="${pulseView.id}"]`);
  await normal.page.waitForSelector('[data-motion-form]');
  const form = await normal.page.evaluate(() => ({
    fields: document.querySelectorAll('[data-motion-field]').length,
    params: window.__panel.getState().entryParams.length,
    applyDisabled: document.querySelector('[data-motion-apply]')?.disabled,
    blockedReason: document.querySelector('[data-motion-apply]')?.getAttribute('data-blocked-reason')
  }));
  assert.equal(form.fields, form.params, `控件数 ${form.fields} != 参数数 ${form.params}`);
  assert.equal(form.applyDisabled, false);
  assert.equal(form.blockedReason, '');

  /* 应用一次，证明这个库是真能用的（宿主 stub 收参数） */
  await normal.page.click('[data-motion-apply]');
  await normal.page.waitForFunction(() => window.__panel.getState().lastResult !== null);
  const appliedCall = await normal.page.evaluate(() => window.__applied);
  assert.equal(appliedCall.length, 1);
  assert.equal(Object.keys(appliedCall[0].params).length, 5);

  await normal.page.screenshot({ path: path.join(EVIDENCE_DIR, 's29-a4-normal.png') });
  assert.deepEqual(normal.pageErrors, []);
  await normal.handle.dispose();

  /* ② 缺资产：删 pulse.css 再拍视图 */
  await fs.rm(path.join(root, 'motion/assets/pulse/pulse.css'));
  const brokenViews = await viewsOf(root);
  const brokenPulse = brokenViews.find((view) => view.name === 'pulse');
  assert.equal(brokenPulse.sourceOk, true, '源还在，sourceOk 应仍为 true');
  assert.equal(brokenPulse.assetIssues.length, 1, `缺资产应报 1 条：${JSON.stringify(brokenPulse.assetIssues)}`);
  assert.match(brokenPulse.assetIssues[0].path, /pulse\.css$/);

  const broken = await mountPanel(brokenViews);
  await broken.page.click('[data-motion-entry][data-id="' + brokenPulse.id + '"]');
  await broken.page.waitForSelector('[data-motion-form]');
  const brokenRow = await broken.page.evaluate((entryId) => {
    const row = document.querySelector(`[data-motion-entry][data-id="${entryId}"]`);
    return row
      ? {
          assetIssues: row.getAttribute('data-asset-issues'),
          borderColor: getComputedStyle(row).borderColor,
          countText: row.querySelector('[data-motion-asset-count]')?.textContent ?? ''
        }
      : null;
  }, brokenPulse.id);

  const brokenDom = await broken.page.evaluate((entryId) => {
    const row = document.querySelector(`[data-motion-entry][data-id="${entryId}"]`);
    const apply = document.querySelector('[data-motion-apply]');
    const warn = document.querySelector('[data-motion-asset-issue]');
    return {
      row: row ? { assetIssues: row.getAttribute('data-asset-issues') } : null,
      apply: apply ? { disabled: apply.disabled, blocked: apply.getAttribute('data-blocked'), reason: apply.getAttribute('data-blocked-reason') } : null,
      warn: warn ? { text: warn.textContent, color: getComputedStyle(warn).color } : null,
      note: document.querySelector('[data-motion-asset-blocked]')?.textContent ?? ''
    };
  }, brokenPulse.id);

  assert.equal(brokenRow.assetIssues, '1');
  assert.equal(brokenRow.borderColor, 'rgb(239, 68, 68)', `缺资产的行没有标红：${brokenRow.borderColor}`);
  assert.equal(brokenRow.countText, '资产问题 1');
  assert.equal(brokenDom.apply.disabled, true, '缺资产的条目「应用」应禁用');
  assert.equal(brokenDom.apply.blocked, 'true');
  assert.equal(brokenDom.apply.reason, 'MISSING_ASSET');
  assert.match(brokenDom.note, /资产缺失 1 个/);
  assert.match(brokenDom.warn.text, /pulse\.css/);

  /* 点一下也不许调 applyEntry */
  await broken.page.evaluate(() => {
    document.querySelector('[data-motion-apply]').click();
  });
  const callsAfterClick = await broken.page.evaluate(() => window.__applied.length);
  assert.equal(callsAfterClick, 0, '禁用状态下仍然调了 applyEntry');

  await broken.page.screenshot({ path: path.join(EVIDENCE_DIR, 's29-a4-missing.png') });
  assert.deepEqual(broken.pageErrors, []);
  await broken.handle.dispose();

  evidence.cases.A4 = {
    normal: { rows: normalDom.rows, status: normalDom.status, form, appliedParams: appliedCall[0]?.params },
    broken: { row: brokenRow, apply: brokenDom.apply, warn: brokenDom.warn, note: brokenDom.note, callsAfterClick }
  };
});
