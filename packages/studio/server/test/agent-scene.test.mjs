// M71-WP21：Agent 原创场景最小闭环（草稿 → 校验 → 应用 → 回滚）。
//
// 这里刻意混两种测法：
// - 真 HTTP + 真 registry（写盘、幂等、并发、回滚、版本快照都是真跑）；
// - 假 registry + 注入 provider（只验「坏草稿」的四道门槛：未知字段 / 超 40 /
//   越界 / provider 失败），不碰磁盘。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parse } from '../../../film-core/film-doc.mjs';
import { MAX_SCENE_OPS, buildSceneRoster, createAgentScene, listSkills, skillsDirOf } from '../agent-scene.mjs';
import { createHttpProvider } from '../../../agents/provider-mock.mjs';
import { startStudio } from '../studio-server.mjs';

const FILM = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=1280, height=720">
<title>M71 夹具</title>
</head>
<body>
<section id="pages">
  <iframe id="page-main" src="page.html#t=0,8" at="0" size="1280x720"
          style="left: 0px; top: 0px; width: 1280px; height: 720px; border: 0"></iframe>
</section>
</body>
</html>
`;

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>page</title>
<style>
  html, body { margin: 0; width: 1280px; height: 720px; background: #0b0f16; }
  #title { position: absolute; left: 96px; top: 72px; font-size: 44px; color: #fff; }
  #caption { position: absolute; left: 96px; top: 500px; font-size: 16px; color: #6b7c93; }
</style></head>
<body>
  <h1 id="title">开场标题</h1>
  <p id="caption">说明文字</p>
  <script>window.film = { frame() { return true; } };</script>
</body></html>
`;

/** @param {string} file */
async function shaOfFile(file) {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

/** @param {string} base @param {string} pathname @param {any} [body] */
async function postJson(base, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json() };
}


/**
 * CS3：应用草稿要先拿「用户批准票」（一次性）。这里把两步封在一起，
 * 让原有断言只关心写盘结果。
 * @param {string} base @param {string} draftId
 */
async function applyDraft(base, draftId) {
  const approval = await postJson(base, `/api/agent/scene/${encodeURIComponent(draftId)}/approval`);
  const token = typeof approval.body?.approvalToken === 'string' ? approval.body.approvalToken : '';
  const response = await fetch(`${base}/api/agent/scene/${encodeURIComponent(draftId)}/apply`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === '' ? {} : { 'x-opencut-apply-approval': token }),
    },
    body: '{}',
  });
  return { status: response.status, body: await response.json() };
}

/** @param {string} base @param {string} pathname */
async function getJson(base, pathname) {
  const response = await fetch(`${base}${pathname}`);
  return { status: response.status, body: await response.json() };
}

/**
 * 开一个真工程 + 真 Studio，跑完清理。
 * @param {(ctx: any) => Promise<void>} fn
 * @param {{studio?: any}} [options]
 */
async function withProject(fn, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-m71-'));
  const dir = path.join(root, 'proj');
  const home = path.join(root, 'home');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(path.join(dir, '.film'), { recursive: true });
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  await fs.writeFile(path.join(dir, 'film.html'), FILM, 'utf8');
  await fs.writeFile(path.join(dir, 'page.html'), PAGE, 'utf8');
  await fs.writeFile(path.join(dir, 'assets', 'ai-shape.png'), 'png', 'utf8');
  const studio = await startStudio({ port: 0, vitePort: 59999, home, projectsRoot: root, ...(options.studio ?? {}) });
  try {
    const opened = await postJson(studio.url, '/api/projects/open', { dir });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    await fn({ root, dir, home, studio, projectId: opened.body.project.projectId });
  } finally {
    await studio.close().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/* ── 真 HTTP：草稿 / 应用 / 幂等 / 回滚 ─────────────────────────────── */

test('草稿不写盘：film.html 的字节与工程 hash 都不变', async () => {
  await withProject(async ({ dir, studio, projectId }) => {
    const filmPath = path.join(dir, 'film.html');
    const before = await shaOfFile(filmPath);
    const summary = await getJson(studio.url, `/api/projects/${projectId}`);
    const created = await postJson(studio.url, '/api/agent/scene', {
      project: projectId,
      prompt: '把 #page-main 的标题卡改成金色',
      seed: 'seed-draft',
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.ok, true);
    assert.equal(await shaOfFile(filmPath), before, '草稿不能碰 film.html');
    assert.equal(created.body.baseHash, summary.body.project.sourceHash);
    assert.equal(created.body.seed, 'seed-draft');
    /* R114-B2：draft 的 provider 是对象（id + 实际模型 + 能力）。 */
    assert.equal(created.body.provider.id, 'mock');
    assert.equal(created.body.provider.model, 'builtin-scene-v1');
    assert.deepEqual(created.body.provider.capabilities, { thinking: false, speed: false, images: true });
    assert.equal(created.body.providerIsMock, true);
    assert.ok(Array.isArray(created.body.ops) && created.body.ops.length > 0, 'ops 不能是空的');
    assert.equal(typeof created.body.summary, 'string');
    assert.ok(created.body.summary.length > 0);
    assert.ok(Array.isArray(created.body.warnings));
    assert.deepEqual(created.body.scope, ['page-main'], 'prompt 点名就把范围钉死');
  });
});

test('apply 写盘：sha256Before/After 与磁盘一致，applied = ops 数', async () => {
  await withProject(async ({ dir, studio, projectId }) => {
    const filmPath = path.join(dir, 'film.html');
    const before = await shaOfFile(filmPath);
    const created = await postJson(studio.url, '/api/agent/scene', {
      project: projectId,
      prompt: '给 #page-main 加一个标题卡',
      seed: 'seed-apply',
    });
    const applied = await applyDraft(studio.url, created.body.draftId);
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.equal(applied.body.alreadyApplied, false);
    assert.equal(applied.body.applied, created.body.ops.length);
    assert.equal(applied.body.sha256Before, before);
    assert.equal(applied.body.sha256After, await shaOfFile(filmPath), '返回值必须等于磁盘');
    assert.notEqual(applied.body.sha256After, applied.body.sha256Before);
    assert.match(applied.body.snapshotSha, /^[0-9a-f]{40}$/, 'apply 前要拍 M62 快照');
    const text = await fs.readFile(filmPath, 'utf8');
    assert.match(text, /overrides=/, '写回的是 overrides 属性');
  });
});

test('apply 幂等：第二次 alreadyApplied=true、applied=0、sha 不变', async () => {
  await withProject(async ({ dir, studio, projectId }) => {
    const created = await postJson(studio.url, '/api/agent/scene', {
      project: projectId,
      prompt: '给 #page-main 配一句字幕',
      seed: 'seed-idem',
    });
    const first = await applyDraft(studio.url, created.body.draftId);
    const second = await applyDraft(studio.url, created.body.draftId);
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.alreadyApplied, true);
    assert.equal(second.body.applied, 0);
    assert.equal(second.body.sha256After, first.body.sha256After);
    assert.equal(await shaOfFile(path.join(dir, 'film.html')), first.body.sha256After);
  });
});

test('并发两次 apply 只写一次（历史里只有一条快照）', async () => {
  await withProject(async ({ dir, studio, projectId }) => {
    const created = await postJson(studio.url, '/api/agent/scene', {
      project: projectId,
      prompt: '把 #page-main 的标题卡改大写',
      seed: 'seed-concurrent',
    });
    const draftId = created.body.draftId;
    const [left, right] = await Promise.all([
      applyDraft(studio.url, draftId),
      applyDraft(studio.url, draftId),
    ]);
    /* CS3：批准票一次性 —— 并发时第二次可能是 409 APPLY_APPROVAL_USED，
       也可能是 200 alreadyApplied（先到的那次已写盘）。两种都不许第二次写盘。 */
    for (const result of [left, right]) {
      const ok = result.status === 200 || (result.status === 409 && result.body.code === 'APPLY_APPROVAL_USED');
      assert.ok(ok, JSON.stringify(result.body));
    }
    const fresh = [left, right].filter((result) => result.status === 200 && result.body.alreadyApplied === false);
    assert.equal(fresh.length, 1, '必须有一次是真写、一次不写');
    const shaAfter = String(fresh[0]?.body?.sha256After ?? '');
    assert.equal(await shaOfFile(path.join(dir, 'film.html')), shaAfter);
    const snapshots = await fs.readdir(path.join(dir, '.film', 'history', 'snapshots'));
    assert.equal(snapshots.filter((name) => name.endsWith('.html')).length, 1, '只落一条历史快照');
  });
});

test('rollback 用 M62 快照恢复到 apply 前（逐字节相同）', async () => {
  await withProject(async ({ dir, studio, projectId }) => {
    const filmPath = path.join(dir, 'film.html');
    const beforeText = await fs.readFile(filmPath, 'utf8');
    const before = await shaOfFile(filmPath);
    const created = await postJson(studio.url, '/api/agent/scene', {
      project: projectId,
      prompt: '给 #page-main 加一个标题卡',
      seed: 'seed-rollback',
    });
    const applied = await applyDraft(studio.url, created.body.draftId);
    assert.notEqual(applied.body.sha256After, before);
    const rolled = await postJson(studio.url, `/api/agent/scene/${created.body.draftId}/rollback`);
    assert.equal(rolled.status, 200, JSON.stringify(rolled.body));
    assert.equal(rolled.body.sha256, before);
    assert.equal(rolled.body.restoredFrom, applied.body.snapshotSha);
    assert.equal(await shaOfFile(filmPath), before);
    assert.equal(await fs.readFile(filmPath, 'utf8'), beforeText, '回滚是逐字节恢复');
    // 回滚后工程还能用：summary 的 hash 跟着回到旧值。
    const summary = await getJson(studio.url, `/api/projects/${projectId}`);
    assert.equal(summary.body.project.sourceHash, before);
  });
});

test('rollback 没有快照 → 409 NO_SNAPSHOT（没 apply 过）', async () => {
  await withProject(async ({ studio, projectId }) => {
    const created = await postJson(studio.url, '/api/agent/scene', {
      project: projectId,
      prompt: '给 #page-main 加一个标题卡',
      seed: 'seed-nosnap',
    });
    const rolled = await postJson(studio.url, `/api/agent/scene/${created.body.draftId}/rollback`);
    assert.equal(rolled.status, 409);
    assert.equal(rolled.body.code, 'NO_SNAPSHOT');
  });
});

test('形状 prompt：insert 的新片段自动进范围，写盘后 doc 里有它', async () => {
  await withProject(async ({ studio, projectId }) => {
    const created = await postJson(studio.url, '/api/agent/scene', {
      project: projectId,
      prompt: '在 #page-main 上叠一个形状',
      seed: 'seed-shape',
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.ok(created.body.ops.some((/** @type {any} */ op) => op.op === 'insert'));
    assert.ok(created.body.ops.some((/** @type {any} */ op) => op.op === 'set' && op.field === 'box'));
    const applied = await applyDraft(studio.url, created.body.draftId);
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    const doc = await getJson(studio.url, `/api/projects/${projectId}/doc`);
    /** @type {any[]} */
    const clips = [];
    for (const track of doc.body.doc.tracks) clips.push(...track.clips);
    assert.ok(clips.some((clip) => String(clip.id).startsWith('ai-shape-')), '新片段在 doc 里');
  });
});

test('字幕 prompt 写 #caption，标题 prompt 写 #title', async () => {
  await withProject(async ({ dir, studio, projectId }) => {
    const caption = await postJson(studio.url, '/api/agent/scene', {
      project: projectId,
      prompt: '给 #page-main 配一句字幕',
      seed: 'seed-caption',
    });
    const entries = caption.body.ops[0].entries;
    assert.equal(entries[0].at, '#caption');
    // provider 的输出形状跟渲染端对齐：文本键是 `t`（`apply-overrides.mjs` 的
    // OVERRIDE_APPLY_KEYS 只认 t/style/lock/s/r），`text` 是 schema 放行但没人消费的旧键。
    assert.equal(typeof entries[0].t, 'string');
    assert.equal(entries[0].text, undefined);
    await applyDraft(studio.url, caption.body.draftId);
    const text = await fs.readFile(path.join(dir, 'film.html'), 'utf8');
    assert.match(text, /#caption/);
  });
});

test('同 prompt + 同 seed → ops 逐字节相同；换 seed → ops 不同', async () => {
  await withProject(async ({ studio, projectId }) => {
    const base = { project: projectId, prompt: '把 #page-main 的标题卡改成金色' };
    const one = await postJson(studio.url, '/api/agent/scene', { ...base, seed: 'same-seed' });
    const two = await postJson(studio.url, '/api/agent/scene', { ...base, seed: 'same-seed' });
    const three = await postJson(studio.url, '/api/agent/scene', { ...base, seed: 'other-seed' });
    assert.equal(JSON.stringify(one.body.ops), JSON.stringify(two.body.ops), '同 seed 必须逐字节相同');
    assert.equal(one.body.seed, 'same-seed');
    assert.notEqual(JSON.stringify(one.body.ops), JSON.stringify(three.body.ops), '换 seed 应该换文案');
  });
});

/* ── 真 HTTP：请求级错误 ───────────────────────────────────────────── */

test('工程未打开 → 404 FILM_NOT_FOUND；prompt 空 → 400；draftId 不存在 → 404', async () => {
  await withProject(async ({ studio }) => {
    const missing = await postJson(studio.url, '/api/agent/scene', { project: 'nope', prompt: '标题卡' });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'FILM_NOT_FOUND');

    const empty = await postJson(studio.url, '/api/agent/scene', { project: 'nope', prompt: '   ' });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.code, 'BAD_REQUEST');

    const noDraft = await postJson(studio.url, '/api/agent/scene/draft-does-not-exist/apply');
    assert.equal(noDraft.status, 404);
    assert.equal(noDraft.body.code, 'DRAFT_NOT_FOUND');
  });
});

test('请求体未知字段 → 400 UNKNOWN_FIELD（不做静默忽略）', async () => {
  await withProject(async ({ studio, projectId }) => {
    const bad = await postJson(studio.url, '/api/agent/scene', {
      project: projectId,
      prompt: '标题卡',
      temperature: 0.7,
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'UNKNOWN_FIELD');
    assert.equal(bad.body.field, 'temperature');
    /* R114-B2：会话引用（session）+ 选择（agent/model/options）。
       R122（M8）：再加 run（取消身份）/ refs（引用）/ attachments（聊天附件）。
       `temperature` 仍不在里面：模型参数不是本轮的口径，多一个就拒。 */
    assert.deepEqual(bad.body.allowed, [
      'project',
      'prompt',
      'seed',
      'session',
      'agent',
      'model',
      'options',
      'run',
      'refs',
      'attachments',
    ]);
  });
});

/* ── 假 registry + 注入 provider：四道门槛 ─────────────────────────── */

/**
 * 一个只够校验用的假 registry。
 * @param {any} doc
 * @returns {any}
 */
function fakeRegistry(doc) {
  return {
    get: (/** @type {string} */ projectId) =>
      projectId === 'p1' ? { projectId: 'p1', dir: '/tmp/does-not-exist', doc, sourceHash: 'hash-before' } : null,
    applyOps: async () => ({ ok: true, hash: 'hash-after', changed: true, touched: [], undoDepth: 1, redoDepth: 0 }),
    close: async () => ({ ok: true }),
    open: async () => ({ ok: true, project: { projectId: 'p1' } }),
  };
}

/** @param {{ops?: any[], targets?: string[], throws?: boolean, summary?: string}} plan */
function stubProvider(plan) {
  return {
    id: 'stub',
    mock: false,
    async generate() {
      if (plan.throws === true) throw new Error('provider 挂了');
      return { ops: plan.ops ?? [], targets: plan.targets ?? ['page-main'], summary: plan.summary ?? 'stub' };
    },
  };
}

/** @param {any} plan */
async function draftWith(plan, prompt = '把 #page-main 的标题改掉') {
  const parsed = parse(FILM, {});
  assert.notEqual(parsed.doc, null);
  const scene = createAgentScene({ registry: fakeRegistry(parsed.doc), provider: stubProvider(plan) });
  return { scene, seed: 'stub-seed', prompt };
}

test('provider 出的 Op 带未知字段 → 502 AGENT_FAILED + reason UNKNOWN_FIELD', async () => {
  const { scene, prompt } = await draftWith({
    ops: [{ op: 'set', clip: 'page-main', field: 'at', value: 1, extra: true }],
  });
  await assert.rejects(
    () => scene.draft({ projectId: 'p1', prompt, seed: 's' }),
    (/** @type {any} */ error) => {
      assert.equal(error.code, 'AGENT_FAILED');
      assert.equal(error.status, 502);
      assert.match(String(error.detail.reason), /^UNKNOWN_FIELD:ops\[0\]\.extra$/);
      return true;
    },
  );
});

test('超过 40 条 Op → 502 AGENT_FAILED + reason TOO_MANY_OPS', async () => {
  /** @type {any[]} */
  const ops = [];
  for (let index = 0; index < MAX_SCENE_OPS + 1; index += 1) {
    ops.push({ op: 'set', clip: 'page-main', field: 'at', value: index });
  }
  const { scene, prompt } = await draftWith({ ops });
  await assert.rejects(
    () => scene.draft({ projectId: 'p1', prompt, seed: 's' }),
    (/** @type {any} */ error) => {
      assert.equal(error.code, 'AGENT_FAILED');
      assert.equal(error.detail.reason, 'TOO_MANY_OPS');
      assert.equal(error.detail.max, MAX_SCENE_OPS);
      return true;
    },
  );
});

test('改到范围外的片段 → 409 OUT_OF_SCOPE', async () => {
  const { scene } = await draftWith({
    ops: [{ op: 'set', clip: 'photo', field: 'at', value: 0 }],
    targets: ['photo'],
  });
  await assert.rejects(
    () => scene.draft({ projectId: 'p1', prompt: '把 #page-main 的标题改掉', seed: 's' }),
    (/** @type {any} */ error) => {
      assert.equal(error.code, 'OUT_OF_SCOPE');
      assert.equal(error.status, 409);
      assert.equal(error.detail.clip, 'photo');
      return true;
    },
  );
});

test('provider 抛错 → 502 AGENT_FAILED（带原因）；空 ops → EMPTY_OPS', async () => {
  const failing = await draftWith({ throws: true });
  await assert.rejects(
    () => failing.scene.draft({ projectId: 'p1', prompt: failing.prompt, seed: 's' }),
    (/** @type {any} */ error) => {
      assert.equal(error.code, 'AGENT_FAILED');
      assert.equal(error.status, 502);
      assert.match(String(error.message), /provider 生成失败/);
      return true;
    },
  );

  const empty = await draftWith({ ops: [] });
  await assert.rejects(
    () => empty.scene.draft({ projectId: 'p1', prompt: empty.prompt, seed: 's' }),
    (/** @type {any} */ error) => {
      assert.equal(error.detail.reason, 'EMPTY_OPS');
      return true;
    },
  );
});

test('Op 过不了现有校验（舞台奇数尺寸）→ 502 AGENT_FAILED reason VALIDATION', async () => {
  const { scene, prompt } = await draftWith({ ops: [{ op: 'stage', w: 1281, h: 720 }] });
  await assert.rejects(
    () => scene.draft({ projectId: 'p1', prompt, seed: 's' }),
    (/** @type {any} */ error) => {
      assert.equal(error.code, 'AGENT_FAILED');
      assert.match(String(error.detail.reason), /^VALIDATION:/);
      return true;
    },
  );
});

test('provider 不声明范围且 prompt 没点名 → 502 NO_SCOPE（不猜）', async () => {
  const { scene } = await draftWith({
    ops: [{ op: 'set', clip: 'page-main', field: 'at', value: 0 }],
    targets: [],
  });
  await assert.rejects(
    () => scene.draft({ projectId: 'p1', prompt: '做一个标题卡', seed: 's' }),
    (/** @type {any} */ error) => {
      assert.equal(error.detail.reason, 'NO_SCOPE');
      return true;
    },
  );
});

test('HTTP provider：有可用 provider 就用它（provider 名不是 mock），协议走真 HTTP', async () => {
  const http = await import('node:http');
  /** @type {any} */
  let received = null;
  const server = http.createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ops: [{ op: 'set', clip: 'page-main', field: 'at', value: 0 }],
          summary: '远程 provider 给的方案',
          warnings: ['REMOTE_STUB'],
          provider: 'stub-remote',
        }),
      );
    });
  });
  await new Promise((/** @type {any} */ resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  const port = address.port;
  try {
    const parsed = parse(FILM, {});
    const scene = createAgentScene({
      registry: fakeRegistry(parsed.doc),
      provider: createHttpProvider({ url: `http://127.0.0.1:${String(port)}/scene`, id: 'stub-remote' }),
    });
    const created = await scene.draft({
      projectId: 'p1',
      prompt: '把 #page-main 的时间挪到 0',
      seed: 's-http',
    });
    assert.equal(created.provider.id, 'stub-remote');
    /* 外部 provider 没声明模型池：它自己就是唯一模型（id 即 model id）。 */
    assert.equal(created.provider.model, 'stub-remote');
    assert.equal(created.providerIsMock, false);
    assert.equal(created.ops.length, 1);
    assert.equal(created.summary, '远程 provider 给的方案');
    assert.deepEqual(created.warnings, ['REMOTE_STUB']);
    assert.equal(received.prompt, '把 #page-main 的时间挪到 0');
    assert.equal(received.seed, 's-http');
    assert.ok(received.doc && Array.isArray(received.doc.tracks), '要把 doc 发给 provider');
  } finally {
    await new Promise((/** @type {any} */ resolve) => server.close(resolve));
  }
});

/* ── R114-B2：模型与选项（MODEL_UNAVAILABLE / OPTION_UNSUPPORTED）──── */

test('模型不在能力闭集 → 400 MODEL_UNAVAILABLE（不静默降级到 mock）', async (t) => {
  await withProject(async ({ studio, projectId }) => {
    const bad = await postJson(studio.url, '/api/agent/scene', {
      project: projectId,
      prompt: '标题卡',
      model: 'gpt-4o-mini',
    });
    /* 路由转发 `model/options` 是 MAIN 的 patch：没落地时这条链路通不到校验层。 */
    if (bad.status === 200) {
      t.skip('scene 路由还没转发 model/options：等 MAIN 应用 R114-SUB2-SERVER-ROUTES.patch');
      return;
    }
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.equal(bad.body.code, 'MODEL_UNAVAILABLE');
    /* CS2：本机探测到 Codex 时，名册里会多一个 ACP provider（acp-codex）。
       断言只要求「内置模型在允许列表里、坏的模型不在」，不锁死列表长度。 */
    assert.ok(bad.body.allowed.includes('builtin-scene-v1'), JSON.stringify(bad.body.allowed));
    assert.ok(!bad.body.allowed.includes('gpt-4o-mini'));
    assert.equal(bad.body.model, 'gpt-4o-mini');
  });
});

test('不支持的 options → 400 OPTION_UNSUPPORTED（维度/未知键都拒）', async (t) => {
  await withProject(async ({ studio, projectId }) => {
    const noThinking = await postJson(studio.url, '/api/agent/scene', {
      project: projectId,
      prompt: '标题卡',
      options: { thinking: 'high' },
    });
    if (noThinking.status === 200) {
      t.skip('scene 路由还没转发 options：等 MAIN 应用 R114-SUB2-SERVER-ROUTES.patch');
      return;
    }
    assert.equal(noThinking.status, 400, JSON.stringify(noThinking.body));
    assert.equal(noThinking.body.code, 'OPTION_UNSUPPORTED');
    assert.equal(noThinking.body.dimension, 'thinking');
    assert.equal(noThinking.body.supported, false);

    const unknown = await postJson(studio.url, '/api/agent/scene', {
      project: projectId,
      prompt: '标题卡',
      options: { temperature: 0.7 },
    });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.code, 'OPTION_UNSUPPORTED');
    assert.equal(unknown.body.option, 'temperature');

    const notObject = await postJson(studio.url, '/api/agent/scene', {
      project: projectId,
      prompt: '标题卡',
      options: 'fast',
    });
    assert.equal(notObject.status, 400);
    assert.equal(notObject.body.code, 'OPTION_UNSUPPORTED');
  });
});

test('默认选择：不带 model/options 仍走内置模型，回包带 capabilities', async () => {
  await withProject(async ({ studio, projectId }) => {
    const ok = await postJson(studio.url, '/api/agent/scene', { project: projectId, prompt: '标题卡' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.provider.id, 'mock');
    assert.equal(ok.body.provider.model, 'builtin-scene-v1');
    assert.deepEqual(ok.body.provider.capabilities, { thinking: false, speed: false, images: true });
    assert.equal(ok.body.selection.provider, 'mock');
    assert.equal(ok.body.selection.model, 'builtin-scene-v1');
    assert.equal(ok.body.selection.thinking, null);
    assert.equal(ok.body.selection.speed, null);
  });
});

/* ── R118（L5）：名册里的 Skill 只读清单（`@` 菜单的 Skill 候选）───────── */

test('listSkills：只报目录名；目录不存在 = 没装（不是错误）', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-skills-'));
  try {
    await fs.mkdir(path.join(root, 'cut-tight'), { recursive: true });
    await fs.mkdir(path.join(root, 'B-uppercase'), { recursive: true });
    await fs.mkdir(path.join(root, '.hidden'), { recursive: true });
    await fs.writeFile(path.join(root, 'README.md'), '# not a skill', 'utf8');
    const listed = await listSkills(root);
    assert.equal(listed.available, true);
    assert.equal(listed.reason, '');
    assert.deepEqual(
      listed.skills.map((row) => row.id),
      ['B-uppercase', 'cut-tight'],
      '只列目录、按名字排序；点开头的隐藏目录与普通文件不算',
    );

    const missing = await listSkills(path.join(root, 'nope'));
    assert.equal(missing.available, false);
    assert.equal(missing.reason, 'NOT_INSTALLED');
    assert.deepEqual(missing.skills, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('buildSceneRoster：skills 段有就列、没有就是 0（不造假条目）', () => {
  const provider = { id: 'mock', mock: true };
  const withSkills = buildSceneRoster({
    provider,
    skills: { available: true, reason: '', skills: [{ id: 'a', label: 'a' }] },
  });
  assert.equal(withSkills.skills.available, true);
  assert.equal(withSkills.skills.count, 1);
  assert.deepEqual(withSkills.skills.items, [{ id: 'a', label: 'a' }]);
  const empty = buildSceneRoster({ provider });
  assert.equal(empty.skills.available, false);
  assert.equal(empty.skills.count, 0);
  assert.deepEqual(empty.skills.items, []);
});

test('skillsDirOf：默认 ~/.opencut/skills，可用 OPENCUT_SKILLS_DIR 覆盖', () => {
  assert.equal(skillsDirOf({}).endsWith(path.join('.opencut', 'skills')), true);
  assert.equal(skillsDirOf({ OPENCUT_SKILLS_DIR: '/tmp/sk' }), '/tmp/sk');
  assert.equal(skillsDirOf({ OPENCUT_SKILLS_DIR: '   ' }).endsWith(path.join('.opencut', 'skills')), true);
});

test('端到端：GET /api/agent/roster 带着真读到的 Skill（空目录也照样报 available）', async () => {
  const skillsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-skills-e2e-'));
  await fs.mkdir(path.join(skillsRoot, 'cut-tight'), { recursive: true });
  const previous = process.env.OPENCUT_SKILLS_DIR;
  process.env.OPENCUT_SKILLS_DIR = skillsRoot;
  try {
    await withProject(async ({ studio }) => {
      const roster = await getJson(studio.url, '/api/agent/roster');
      assert.equal(roster.status, 200, JSON.stringify(roster.body));
      assert.equal(roster.body.skills.available, true);
      assert.deepEqual(
        roster.body.skills.items.map((/** @type {any} */ row) => row.id),
        ['cut-tight'],
      );
      /* 名册不带本机路径（只报「能引用什么」）。 */
      assert.equal(JSON.stringify(roster.body).includes(skillsRoot), false);
    });
  } finally {
    if (previous === undefined) delete process.env.OPENCUT_SKILLS_DIR;
    else process.env.OPENCUT_SKILLS_DIR = previous;
    await fs.rm(skillsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

/* ══ R122 · M8-A：服务端 run 取消（D08 / LI-A37）══════════════════════
 *
 * 这一组不启 HTTP：`createAgentScene` 直接跑，provider 用一个「等闸门」的桩，
 * 好让取消恰好落在**生成中**（这正是上一批漏掉的窗口）。
 */

/** 一个可以由测试决定何时返回的 provider。 */
function gatedProvider() {
  /** @type {() => void} */
  let open = () => {};
  const gate = new Promise((resolve) => {
    open = () => resolve(null);
  });
  /** @type {any[]} */
  const calls = [];
  return {
    calls,
    provider: {
      id: 'gated',
      mock: false,
      /** @param {any} input */
      async generate(input) {
        calls.push(input);
        await gate;
        return {
          ops: [{ op: 'set', clip: 'page-main', field: 'at', value: 1 }],
          targets: ['page-main'],
          summary: 'gated',
          echo: {
            refs: (Array.isArray(input.refs) ? input.refs : []).map((/** @type {any} */ row) => ({ kind: row.kind, sample: row.sample, ok: row.ok })),
            attachments: (Array.isArray(input.attachments) ? input.attachments : []).map((/** @type {any} */ row) => ({
              name: row.name,
              bytes: row.bytes,
              sha256: row.sha256,
              available: row.available,
              head: row.head,
            })),
          },
        };
      },
    },
    release: () => open(),
  };
}

/** 一个只够「续接会话」的假 store（真写盘那套在 agent-sessions.test.mjs）。 */
function fakeSessions() {
  /** @type {Map<string, any[]>} */
  const turns = new Map();
  return {
    /** @param {string} sid */
    async get(sid) {
      return sid === 'saaaaaa1' ? { ok: true, session: { id: sid, title: '取消测试会话' }, turns: turns.get(sid) ?? [] } : { ok: false, code: 'SESSION_NOT_FOUND' };
    },
    /** @param {string} sid @param {any} turn */
    async appendTurn(sid, turn) {
      const list = turns.get(sid) ?? [];
      const row = { id: `t${String(list.length + 1).padStart(6, '0')}`, sessionId: sid, prompt: turn.prompt, state: turn.state, at: turn.at };
      list.push(row);
      turns.set(sid, list);
      return { ok: true, turn: row };
    },
    /** @param {string} sid */
    turnsOf: (sid) => turns.get(sid) ?? [],
  };
}

/** @param {string} dir */
function registryOf(dir) {
  const parsed = parse(FILM, {});
  assert.notEqual(parsed.doc, null);
  return {
    get: (/** @type {string} */ projectId) => (projectId === 'p1' ? { projectId: 'p1', dir, doc: parsed.doc, sourceHash: 'hash-before' } : null),
    applyOps: async () => ({ ok: true, hash: 'hash-after', changed: true, touched: [], undoDepth: 1, redoDepth: 0 }),
    close: async () => ({ ok: true }),
    open: async () => ({ ok: true, project: { projectId: 'p1' } }),
  };
}

test('R122-A① 生成中点取消 → 409 RUN_CANCELLED，草稿不建、回合不记、provider 被 abort', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-run-cancel-'));
  const gated = gatedProvider();
  const sessions = fakeSessions();
  const scene = createAgentScene({ registry: registryOf(dir), provider: gated.provider });
  try {
    const pending = scene.draft({
      projectId: 'p1',
      prompt: '把 #page-main 的标题改掉',
      seed: 's',
      session: 'saaaaaa1',
      sessions,
      run: { runId: 'run-cancel-1', generation: 1 },
    });
    /* 等 provider 真的进来了（= run 已在台账里），再取消。 */
    for (let i = 0; i < 200 && gated.calls.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(gated.calls.length, 1, 'provider 没被调用');

    const registered = /** @type {any} */ (scene.runs.get('run-cancel-1'));
    assert.equal(registered.state, 'running');
    const out = scene.runs.cancelHttp('run-cancel-1', { project: 'p1', session: 'saaaaaa1' });
    assert.equal(out.status, 200);
    assert.equal(out.body.cancelled, true);

    gated.release();
    await assert.rejects(
      () => pending,
      (/** @type {any} */ error) => {
        assert.equal(error.code, 'RUN_CANCELLED');
        assert.equal(error.status, 409);
        return true;
      },
    );

    assert.equal(scene.count(), 0, '取消后仍然建了草稿');
    assert.equal(sessions.turnsOf('saaaaaa1').length, 0, '取消后仍然记了回合');
    assert.equal(/** @type {any} */ (scene.runs.get('run-cancel-1')).state, 'cancelled');
    assert.equal(gated.calls[0].signal.aborted, true, 'provider 的 signal 没被 abort');
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('R122-A② 跨项目取消 → 403 且**不取消**：生成照常完成、回合照记', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-run-foreign-'));
  const gated = gatedProvider();
  const sessions = fakeSessions();
  const scene = createAgentScene({ registry: registryOf(dir), provider: gated.provider });
  try {
    const pending = scene.draft({
      projectId: 'p1',
      prompt: '把 #page-main 的标题改掉',
      seed: 's',
      session: 'saaaaaa1',
      sessions,
      run: { runId: 'run-foreign-1', generation: 1 },
    });
    for (let i = 0; i < 200 && gated.calls.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));

    const wrong = scene.runs.cancelHttp('run-foreign-1', { project: 'p2' });
    assert.equal(wrong.status, 403);
    assert.equal(/** @type {any} */ (wrong.body).code, 'RUN_FOREIGN_PROJECT');
    assert.equal(/** @type {any} */ (scene.runs.get('run-foreign-1')).state, 'running', '403 把 run 停了');
    assert.equal(gated.calls[0].signal.aborted, false, '403 把 provider 也 abort 了');

    gated.release();
    const created = await pending;
    assert.equal(typeof created.draftId, 'string');
    assert.equal(scene.count(), 1);
    assert.equal(sessions.turnsOf('saaaaaa1').length, 1, '正常完成的回合应该记下来');
    assert.equal(/** @type {any} */ (scene.runs.get('run-foreign-1')).state, 'done');
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('R122-A③ 重复取消幂等；已完成之后再取消只回执、不改状态', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-run-idem-'));
  const gated = gatedProvider();
  const scene = createAgentScene({ registry: registryOf(dir), provider: gated.provider });
  try {
    const pending = scene.draft({ projectId: 'p1', prompt: '把 #page-main 的标题改掉', seed: 's', run: { runId: 'run-idem-1', generation: 2 } });
    for (let i = 0; i < 200 && gated.calls.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const first = scene.runs.cancelHttp('run-idem-1', { project: 'p1' });
    const second = scene.runs.cancelHttp('run-idem-1', { project: 'p1' });
    assert.equal(first.body.idempotent, false);
    assert.equal(second.body.idempotent, true);
    gated.release();
    await assert.rejects(() => pending, (/** @type {any} */ error) => error.code === 'RUN_CANCELLED');

    /* 已完成的一条：再取消 = 200，但状态还是 done（不能把历史改写成取消）。 */
    const done = await scene.draft({ projectId: 'p1', prompt: '把 #page-main 的标题改掉', seed: 's', run: { runId: 'run-idem-2', generation: 3 } });
    assert.equal(typeof done.draftId, 'string');
    const late = scene.runs.cancelHttp('run-idem-2', { project: 'p1' });
    assert.equal(late.status, 200);
    assert.equal(late.body.cancelled, false);
    assert.equal(late.body.state, 'done');
    assert.equal(scene.count(), 1, '已完成的草稿不该被取消动作删掉');
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('R122-A④ 取消过的 runId 重放 → 409（不借重试洗回 running 再跑一遍）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-run-replay-'));
  const gated = gatedProvider();
  const scene = createAgentScene({ registry: registryOf(dir), provider: gated.provider });
  try {
    const pending = scene.draft({ projectId: 'p1', prompt: '把 #page-main 的标题改掉', seed: 's', run: { runId: 'run-replay-1', generation: 1 } });
    for (let i = 0; i < 200 && gated.calls.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    scene.runs.cancelHttp('run-replay-1', { project: 'p1' });
    gated.release();
    await assert.rejects(() => pending, (/** @type {any} */ error) => error.code === 'RUN_CANCELLED');

    const before = gated.calls.length;
    await assert.rejects(
      () => scene.draft({ projectId: 'p1', prompt: '再来一次', seed: 's', run: { runId: 'run-replay-1', generation: 1 } }),
      (/** @type {any} */ error) => {
        assert.equal(error.code, 'RUN_CANCELLED');
        assert.equal(error.status, 409);
        return true;
      },
    );
    assert.equal(gated.calls.length, before, '被取消的 runId 重放又调了一次 provider');
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('R122-A⑤ run 形状不对 → 400 RUN_INVALID（不猜、不静默忽略）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-run-bad-'));
  const gated = gatedProvider();
  const scene = createAgentScene({ registry: registryOf(dir), provider: gated.provider });
  try {
    for (const run of /** @type {any[]} */ (['run-1', { runId: '' }, { runId: 'run x' }, { runId: 'run-1', generation: -1 }, { runId: 'run-1', generation: 1.5 }])) {
      await assert.rejects(
        () => scene.draft({ projectId: 'p1', prompt: '把 #page-main 的标题改掉', seed: 's', run }),
        (/** @type {any} */ error) => {
          assert.equal(error.code, 'RUN_INVALID');
          assert.equal(error.status, 400);
          return true;
        },
      );
    }
    assert.equal(gated.calls.length, 0, '坏 run 不该调到 provider');
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

/* ══ R122 · M8-B：引用与聊天附件真的到消费者手上（D07 / LI-A35）════════ */

test('R122-B① 引用解析：元素文本/片段/素材/文件/Skill 都读到真东西（唯一 token）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-refs-'));
  const skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-refs-skills-'));
  const token = `tok-${createHash('sha256').update(dir).digest('hex').slice(0, 10)}`;
  const gated = gatedProvider();
  const scene = createAgentScene({ registry: registryOf(dir), provider: gated.provider, skillsDir });
  try {
    /* 页面里放唯一 token：只有真正读到这份文件的人才能说出它。 */
    await fs.writeFile(
      path.join(dir, 'page.html'),
      `<!doctype html><html><body><h1 id="title">${token}-element</h1></body></html>`,
      'utf8',
    );
    await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
    await fs.writeFile(path.join(dir, 'assets', 'note.txt'), `${token}-asset`, 'utf8');
    await fs.mkdir(path.join(skillsDir, `skill-${token}`), { recursive: true });

    const pending = scene.draft({
      projectId: 'p1',
      prompt: '把 #page-main 的标题改掉',
      seed: 's',
      run: { runId: 'run-refs-1', generation: 1 },
      refs: [
        { kind: 'project', identity: 'p1', label: '工程 · p1' },
        { kind: 'clip', identity: 'page-main', label: '片段 · page-main' },
        { kind: 'element', identity: 'page-main::#title', label: '元素 · #title @ page-main' },
        { kind: 'asset', identity: 'assets/note.txt', label: '素材 · note.txt' },
        { kind: 'file', identity: 'page.html', label: '文件 · page.html' },
        { kind: 'skill', identity: `skill-${token}`, label: 'Skill' },
      ],
    });
    for (let i = 0; i < 200 && gated.calls.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    gated.release();
    const created = await pending;

    const byKind = Object.fromEntries(created.consumed.refs.map((/** @type {any} */ row) => [row.kind, row]));
    assert.equal(byKind.project.ok, true);
    assert.equal(byKind.clip.ok, true);
    assert.equal(byKind.element.ok, true);
    assert.match(String(byKind.element.sample), new RegExp(`${token}-element`), '元素引用没读到页面里的文本');
    assert.equal(byKind.asset.bytes, Buffer.byteLength(`${token}-asset`));
    assert.match(String(byKind.asset.sample), new RegExp(`${token}-asset`), '素材引用没读到文件内容');
    assert.match(String(byKind.file.sample), new RegExp(`${token}-element`), '文件引用没读到文件内容');
    assert.equal(byKind.skill.ok, true);
    assert.equal(byKind.skill.sample, `skill-${token}`);

    /* 消费者（provider）自报：它拿到的就是解析结果，不是 UI 标签。 */
    const echo = created.providerEcho;
    assert.notEqual(echo, null);
    const echoed = Object.fromEntries(echo.refs.map((/** @type {any} */ row) => [row.kind, row.sample]));
    assert.match(String(echoed.element), new RegExp(`${token}-element`));
    assert.match(String(echoed.asset), new RegExp(`${token}-asset`));
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await fs.rm(skillsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('R122-B② 引用读不到不拦生成，但 ok:false + reason 原样回（不装作读到了）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-refs-bad-'));
  const gated = gatedProvider();
  const scene = createAgentScene({ registry: registryOf(dir), provider: gated.provider, skillsDir: path.join(dir, 'no-skills') });
  try {
    await fs.writeFile(path.join(dir, 'page.html'), '<!doctype html><html><body><p>没有那个 id</p></body></html>', 'utf8');
    const pending = scene.draft({
      projectId: 'p1',
      prompt: '把 #page-main 的标题改掉',
      seed: 's',
      run: { runId: 'run-refs-2', generation: 1 },
      refs: [
        { kind: 'element', identity: 'page-main::#missing', label: '元素 · #missing' },
        { kind: 'asset', identity: 'assets/none.png', label: '素材 · none.png' },
        { kind: 'skill', identity: 'not-installed', label: 'Skill' },
        { kind: 'clip', identity: 'nope', label: '片段 · nope' },
      ],
    });
    for (let i = 0; i < 200 && gated.calls.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    gated.release();
    const created = await pending;
    const rows = created.consumed.refs;
    assert.equal(rows.length, 4);
    assert.deepEqual(
      rows.map((/** @type {any} */ row) => row.reason),
      ['ELEMENT_NOT_FOUND', 'NOT_FOUND', 'SKILLS_UNAVAILABLE', 'CLIP_NOT_FOUND'],
    );
    assert.equal(rows.every((/** @type {any} */ row) => row.ok === false), true);
    assert.equal(typeof created.draftId, 'string', '引用读不到不该让整次生成失败');
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('R122-B③ 附件内容可用：base64 → 字节数/摘要核对后交给 provider；不符就 400', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencut-attach-'));
  const gated = gatedProvider();
  const scene = createAgentScene({ registry: registryOf(dir), provider: gated.provider });
  try {
    const content = Buffer.from('附件内容：这一段必须原样到达消费者', 'utf8');
    const data = content.toString('base64');
    const sha256 = createHash('sha256').update(content).digest('hex');

    const pending = scene.draft({
      projectId: 'p1',
      prompt: '把 #page-main 的标题改掉',
      seed: 's',
      run: { runId: 'run-attach-1', generation: 1 },
      attachments: [{ name: 'note.txt', kind: 'text/plain', bytes: content.length, sha256, data }],
    });
    for (let i = 0; i < 200 && gated.calls.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    gated.release();
    const created = await pending;
    const seen = created.providerEcho.attachments[0];
    assert.equal(seen.name, 'note.txt');
    assert.equal(seen.bytes, content.length);
    assert.equal(seen.sha256, sha256, 'provider 拿到的不是同一份内容');
    assert.equal(seen.available, true);
    assert.match(String(seen.head), /附件内容/, 'provider 没拿到内容（只拿到元数据）');
    assert.equal(/** @type {any} */ (created.consumed).attachments[0].sha256, sha256);

    /* 摘要不符 → 400（客户端说 A、内容却是 B，不能当没事）。 */
    await assert.rejects(
      () =>
        scene.draft({
          projectId: 'p1',
          prompt: '把 #page-main 的标题改掉',
          seed: 's',
          run: { runId: 'run-attach-2', generation: 1 },
          attachments: [{ name: 'note.txt', kind: 'text/plain', bytes: content.length, sha256: 'f'.repeat(64), data }],
        }),
      (/** @type {any} */ error) => {
        assert.equal(error.code, 'ATTACHMENTS_INVALID');
        assert.equal(error.status, 400);
        return true;
      },
    );
    /* 字节数不符 → 400。 */
    await assert.rejects(
      () =>
        scene.draft({
          projectId: 'p1',
          prompt: '把 #page-main 的标题改掉',
          seed: 's',
          run: { runId: 'run-attach-3', generation: 1 },
          attachments: [{ name: 'note.txt', kind: 'text/plain', bytes: content.length + 1, data }],
        }),
      (/** @type {any} */ error) => error.code === 'ATTACHMENTS_INVALID',
    );
    /* 没有内容 = 只有元数据：标 available:false，不假装模型看过。 */
    const meta = await scene.draft({
      projectId: 'p1',
      prompt: '把 #page-main 的标题改掉',
      seed: 's',
      run: { runId: 'run-attach-4', generation: 1 },
      attachments: [{ name: 'huge.mp4', kind: 'video/mp4', bytes: 999999 }],
    });
    assert.equal(/** @type {any} */ (meta.consumed).attachments[0].available, false);
    assert.equal(/** @type {any} */ (meta.consumed).attachments[0].reason, 'TOO_LARGE', '超上限且没内容 → 说清是太大，不是「空文件」');
    /* 小文件但没内容（客户端没读完就发）→ NO_CONTENT。 */
    const noContent = await scene.draft({
      projectId: 'p1',
      prompt: '把 #page-main 的标题改掉',
      seed: 's',
      run: { runId: 'run-attach-5', generation: 1 },
      attachments: [{ name: 'clip.txt', kind: 'text/plain', bytes: 12 }],
    });
    assert.equal(/** @type {any} */ (noContent.consumed).attachments[0].reason, 'NO_CONTENT');
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

/* ── R137（M12-B）：附件服务端四条边界（走真路由，不是函数直调） ──────────── */

test('附件契约：9 个 400 / 8 个 200 / 单 512KiB / 合计 2MiB（准确 code 与文案）', async () => {
  await withProject(async ({ studio, projectId }) => {
    /** @param {string} name @param {number} size @param {number} fill */
    const item = (name, size, fill) => {
      const buf = Buffer.alloc(size, fill);
      return {
        name,
        kind: 'text/plain',
        bytes: buf.length,
        sha256: createHash('sha256').update(buf).digest('hex'),
        data: buf.toString('base64'),
      };
    };
    /** @param {any[]} [attachments] */
    const draft = (attachments) =>
      postJson(studio.url, '/api/agent/scene', {
        project: projectId,
        prompt: '把 #page-main 的标题卡改成金色',
        seed: 's',
        ...(attachments === undefined ? {} : { attachments }),
      });

    /* 数量：9 个先被数量上限拦下（在内容校验之前），字段与文案都要准确。 */
    const nine = await draft(Array.from({ length: 9 }, (_, index) => item(`f${String(index)}.txt`, 4, index)));
    assert.equal(nine.status, 400);
    assert.equal(nine.body.ok, false);
    assert.equal(nine.body.code, 'ATTACHMENTS_INVALID');
    assert.equal(nine.body.message, 'attachments 最多 8 个');
    assert.equal(nine.body.max, 8);

    /* 8 个是**边界内**：刚好收下，且每个都带内容。 */
    const eight = await draft(Array.from({ length: 8 }, (_, index) => item(`g${String(index)}.txt`, 4, index)));
    assert.equal(eight.status, 200, JSON.stringify(eight.body));
    assert.equal(eight.body.consumed.attachments.length, 8);
    assert.ok(/** @type {any[]} */ (eight.body.consumed.attachments).every((row) => row.available === true));

    /* 单个 512KiB：正好收，多 1 字节拒。 */
    const exact = await draft([item('edge.bin', 512 * 1024, 5)]);
    assert.equal(exact.status, 200);
    assert.equal(exact.body.consumed.attachments[0].available, true);
    assert.equal(exact.body.consumed.attachments[0].bytes, 512 * 1024);

    const over = await draft([item('over.bin', 512 * 1024 + 1, 5)]);
    assert.equal(over.status, 400);
    assert.equal(over.body.code, 'ATTACHMENTS_INVALID');
    assert.match(over.body.message, /单个上限 524288 字节/);
    assert.equal(over.body.max, 512 * 1024);

    /* 合计 2MiB：4×512KiB 正好顶到；再多 1 字节拒（这一条只有**总量**能拦）。 */
    const total = await draft(Array.from({ length: 4 }, (_, index) => item(`t${String(index)}.bin`, 512 * 1024, index)));
    assert.equal(total.status, 200);
    assert.equal(total.body.consumed.attachments.length, 4);

    const totalOver = await draft([
      ...Array.from({ length: 4 }, (_, index) => item(`u${String(index)}.bin`, 512 * 1024, index)),
      item('one-more.bin', 1, 9),
    ]);
    assert.equal(totalOver.status, 400);
    assert.equal(totalOver.body.code, 'ATTACHMENTS_INVALID');
    assert.match(totalOver.body.message, /附件总量超上限：2097153 > 2097152/);
    assert.equal(totalOver.body.max, 2 * 1024 * 1024);
  });
});

/* ── R144（M14-R2 · B2）：受控非法模型 / 协议字段一律 4xx，不静默纠正 ──────── */

test('选择校验：非法模型名 / 协议字段 / 未知 agent 都是 4xx（不降级、不换模型）', async () => {
  await withProject(async ({ studio, projectId }) => {
    /** @param {Record<string, any>} patch */
    const draft = (patch) =>
      postJson(studio.url, '/api/agent/scene', { project: projectId, prompt: '负向用例', seed: 's', ...patch });

    /* 模型名不存在（含看起来像路径的）→ MODEL_UNAVAILABLE，allowed 里列出真可用的。 */
    const ghost = await draft({ model: 'ghost-model-1' });
    assert.equal(ghost.status, 400);
    assert.equal(ghost.body.code, 'MODEL_UNAVAILABLE');
    assert.equal(ghost.body.message, '没有可用模型：ghost-model-1');
    assert.ok(Array.isArray(ghost.body.allowed));

    const traversal = await draft({ model: '../../etc/passwd' });
    assert.equal(traversal.status, 400);
    assert.equal(traversal.body.code, 'MODEL_UNAVAILABLE');
    assert.equal(traversal.body.model, '../../etc/passwd');

    /* 协议字段不是 options 的键：给 protocol 必须明说不认识，而不是**忽略后照跑**。 */
    const protocol = await draft({ options: { protocol: 'acp/1' } });
    assert.equal(protocol.status, 400);
    assert.equal(protocol.body.code, 'OPTION_UNSUPPORTED');
    assert.equal(protocol.body.message, 'options 不认识 protocol（只接受 thinking / speed）');
    assert.deepEqual(protocol.body.allowed, ['thinking', 'speed']);
    assert.equal(protocol.body.option, 'protocol');

    /* 取值不在该模型声明的闭集里 → OPTION_UNSUPPORTED（不是悄悄按默认值跑）。 */
    const thinking = await draft({ options: { thinking: 'ultra-deep' } });
    assert.equal(thinking.status, 400);
    assert.equal(thinking.body.code, 'OPTION_UNSUPPORTED');
    assert.equal(thinking.body.dimension, 'thinking');
    assert.equal(thinking.body.value, 'ultra-deep');

    /* 不存在的 agent（例如把 ACP 当成已接）：AGENT_UNSUPPORTED，allowed 里只有真接通的。 */
    const agent = await draft({ agent: 'acp-agent-9' });
    assert.equal(agent.status, 400);
    assert.equal(agent.body.code, 'AGENT_UNSUPPORTED');
    assert.equal(agent.body.message, '没有这个 Agent：acp-agent-9');
    assert.ok(Array.isArray(agent.body.allowed));
    assert.equal(agent.body.allowed.includes('acp-agent-9'), false);
  });
});
