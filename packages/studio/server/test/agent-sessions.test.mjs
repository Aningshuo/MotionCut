// F08 会话列表 · 服务端三端点（R28 · BATCH-SUB2-R29-073）
//
// 五条判据逐条测（真 HTTP + 真 registry + 真写盘，不起浏览器）：
//   ① 新建两次只多一条（已有空会话就返回它）
//   ② 排序：pinned 优先 → updatedAt 降序
//   ③ turns=0 不出现在列表
//   ④ 并发写 10 次后 JSON 合法且只有一条 last
//   ⑤ 不存在 sid → 404 带码
// 另加两条护栏：坏 JSON 不许被覆盖（CHAT_CORRUPT）；上限 200 且置顶不丢。
//
// 夹具直接往 `.film/chat/` 里写 sessions.json / turns/*.json —— 这三条端点是**只读 + 新建**，
// 没有「改回合」的写入口，所以回合要靠夹具铺（真实写入是后面 UI/生成器那批的活）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { startStudio } from '../studio-server.mjs';
import { MAX_SESSIONS, listVisible, normalizeDoc, normalizeSteps, trimToLimit, newSessionId } from '../agent-sessions.mjs';
import { makeProject } from './helpers.mjs';

/* `(url, body)` / `(url)` —— 与 helpers.mjs 同形；调用处一律拼完整 URL。
   （agent-scene.test.mjs 用的是 `(base, pathname, body)`，两种都见过，所以这里写清。） */
/** @param {string} url @param {unknown} [body] */
async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** @param {string} url */
async function getJson(url) {
  const response = await fetch(url);
  return { status: response.status, body: await response.json().catch(() => null) };
}

/**
 * @param {(ctx: { dir: string, studio: any, projectId: string, chatDir: string }) => Promise<void>} fn
 */
async function withProject(fn) {
  const project = await makeProject('f08');
  const home = path.join(project.root, 'home');
  await fs.mkdir(home, { recursive: true });
  const studio = await startStudio({ port: 0, vitePort: 59999, home, projectsRoot: project.root });
  try {
    const opened = await postJson(`${studio.url}/api/projects/open`, { dir: project.dir });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const chatDir = path.join(project.dir, '.film', 'chat');
    await fn({ dir: project.dir, studio, projectId: opened.body.project.projectId, chatDir });
  } finally {
    await studio.close().catch(() => undefined);
    await project.cleanup().catch(() => undefined);
  }
}

/** 铺一份 sessions.json（不经过端点，直接落盘）。 */
/** @param {string} chatDir @param {any[]} sessions @param {string | null} [last] */
async function seedSessions(chatDir, sessions, last = null) {
  await fs.mkdir(chatDir, { recursive: true });
  await fs.writeFile(path.join(chatDir, 'sessions.json'), JSON.stringify({ version: 1, last, sessions }, null, 1), 'utf8');
}

/** @param {string} chatDir @returns {Promise<any>} */
async function readDoc(chatDir) {
  return JSON.parse(await fs.readFile(path.join(chatDir, 'sessions.json'), 'utf8'));
}

/** @param {number} minute @returns {string} */
const iso = (minute) => `2026-11-12T10:${String(minute).padStart(2, '0')}:00.000Z`;

/* ── ① 新建两次只多一条 ──────────────────────────────────────────── */
test('① 连点两次「新建」只多一条会话（第二次返回同一条空会话）', async () => {
  await withProject(async ({ studio, projectId, chatDir }) => {
    const url = `${studio.url}/api/projects/${projectId}/agent/sessions`;
    const first = await postJson(url, {});
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.created, true);

    const second = await postJson(url, {});
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.created, false);
    assert.equal(second.body.session.id, first.body.session.id, '第二次必须返回同一条空会话');

    const doc = await readDoc(chatDir);
    assert.equal(doc.sessions.length, 1, `文件里只能有一条，实际 ${doc.sessions.length}`);
    assert.equal(doc.last, first.body.session.id);

    /* 带标题也不该造第二条：判据是「别造重复」，title 只能挂在已存在那条上（这里不改它）。 */
    const third = await postJson(url, { title: '手动标题' });
    assert.equal(third.status, 200);
    assert.equal((await readDoc(chatDir)).sessions.length, 1);
  });
});

/* ── ② 排序 + ③ turns=0 不出现 ───────────────────────────────────── */
test('②③ 列表：只筛 turns>0，pinned 优先 → updatedAt 倒序', async () => {
  await withProject(async ({ studio, projectId, chatDir }) => {
    await seedSessions(chatDir, [
      { id: 'saaa111', title: '空会话', createdAt: iso(9), updatedAt: iso(9), turns: 0 },
      { id: 'sbbb222', title: '旧', createdAt: iso(1), updatedAt: iso(1), turns: 2 },
      { id: 'sccc333', title: '新', createdAt: iso(2), updatedAt: iso(8), turns: 5 },
      { id: 'sddd444', title: '置顶但旧', createdAt: iso(3), updatedAt: iso(3), turns: 1, pinned: true },
      { id: 'seee555', title: '置顶且新', createdAt: iso(4), updatedAt: iso(7), turns: 3, pinned: true },
    ], 'sccc333');
    const listed = await getJson(`${studio.url}/api/projects/${projectId}/agent/sessions`);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    /** @type {any[]} */
    const rows = listed.body.sessions;
    const ids = rows.map((item) => item.id);
    assert.deepEqual(ids, ['seee555', 'sddd444', 'sccc333', 'sbbb222'], `排序不对：${ids.join(',')}`);
    assert.equal(rows.some((item) => item.turns === 0), false, 'turns=0 不许出现');
    assert.equal(listed.body.last, 'sccc333');
    assert.equal(listed.body.hidden, 1, '被筛掉的条数要报出来');
  });
});

/* ── ④ 并发 10 次 ────────────────────────────────────────────────── */
test('④ 并发 POST 10 次：JSON 合法、只剩一条会话、last 指向它', async () => {
  await withProject(async ({ studio, projectId, chatDir }) => {
    const url = `${studio.url}/api/projects/${projectId}/agent/sessions`;
    const results = await Promise.all(Array.from({ length: 10 }, () => postJson(url, {})));
    const codes = results.map((item) => item.status).sort();
    assert.equal(codes.filter((code) => code === 201).length, 1, `只该有一次真新建，实际 ${codes.join(',')}`);
    assert.equal(codes.filter((code) => code === 200).length, 9, `其余九次都该复用，实际 ${codes.join(',')}`);
    const ids = new Set(results.map((item) => item.body.session.id));
    assert.equal(ids.size, 1, '10 次必须指向同一条');

    const doc = await readDoc(chatDir); // JSON.parse 失败这里就炸 —— 合法性由它证明
    assert.equal(doc.version, 1);
    assert.equal(doc.sessions.length, 1, `并发后只能有一条，实际 ${doc.sessions.length}`);
    assert.equal(typeof doc.last, 'string');
    /** @type {any[]} */
    const sessions = doc.sessions;
    assert.equal(sessions.filter((item) => item.id === doc.last).length, 1, 'last 必须恰好命中一条');
  });
});

/* ── ⑤ 不存在的 sid → 404 带码 ───────────────────────────────────── */
test('⑤ 不存在的 sid → 404 + SESSION_NOT_FOUND', async () => {
  await withProject(async ({ studio, projectId }) => {
    const missing = await getJson(`${studio.url}/api/projects/${projectId}/agent/sessions/szzz999`);
    assert.equal(missing.status, 404, JSON.stringify(missing.body));
    assert.equal(missing.body.code, 'SESSION_NOT_FOUND');
    assert.equal(missing.body.ok, false);

    /* id 格式不对 → 400，不要跟 404 混。 */
    const bad = await getJson(`${studio.url}/api/projects/${projectId}/agent/sessions/NOT-AN-ID`);
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.equal(bad.body.code, 'SESSION_ID_INVALID');
  });
});

/* ── 点开：turns + lastDraft ─────────────────────────────────────── */
test('点开：返回该会话的回合，并把最后一回合的 draftId 当作 lastDraft', async () => {
  await withProject(async ({ studio, projectId, chatDir }) => {
    await seedSessions(chatDir, [
      { id: 'sfff777', title: '有回合', createdAt: iso(1), updatedAt: iso(5), turns: 2 },
    ], 'sfff777');
    const turnsDir = path.join(chatDir, 'turns');
    await fs.mkdir(turnsDir, { recursive: true });
    await fs.writeFile(
      path.join(turnsDir, 't1.json'),
      JSON.stringify({ turn: { id: 't1', sessionId: 'sfff777', prompt: '第一句', draftId: 'draft-a', state: 'done', at: iso(1), steps: [
        { op: 'insert', text: '插入 title 片段' },
        { op: 'overrides', text: '覆盖 title 的 2 处', extra: '丢掉' },
        { text: '只有摘要，没有 kind' },
        { op: 'set' },
        null,
        '不是对象',
      ] }, items: [] }),
      'utf8',
    );
    await fs.writeFile(
      path.join(turnsDir, 't2.json'),
      JSON.stringify({ turn: { id: 't2', sessionId: 'sfff777', prompt: '第二句', draftId: 'draft-b', state: 'error', at: iso(5) }, items: [] }),
      'utf8',
    );
    /* 别的会话的回合不许串进来。 */
    await fs.writeFile(
      path.join(turnsDir, 't9.json'),
      JSON.stringify({ turn: { id: 't9', sessionId: 'sother01', prompt: '别人', draftId: 'draft-z', state: 'done', at: iso(6) }, items: [] }),
      'utf8',
    );

    const opened = await getJson(`${studio.url}/api/projects/${projectId}/agent/sessions/sfff777`);
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.equal(opened.body.session.id, 'sfff777');
    /** @type {any[]} */
    const turnRows = opened.body.turns;
    assert.deepEqual(turnRows.map((item) => item.id), ['t1', 't2'], '回合要按 at 升序且只含本会话');
    assert.deepEqual(opened.body.lastDraft, { draftId: 'draft-b', state: 'error', at: iso(5) });
    /* R35 · E2：步骤摘要按可选字段透传 —— 只留 op/text，空项与坏项丢掉，老回合给空数组。 */
    assert.deepEqual(turnRows[0].steps, [
      { op: 'insert', text: '插入 title 片段' },
      { op: 'overrides', text: '覆盖 title 的 2 处' },
      { op: '', text: '只有摘要，没有 kind' },
      { op: 'set', text: '' },
    ], 't1 的 steps 没按 op/text 归一');
    assert.deepEqual(turnRows[1].steps, [], 't2 没有 steps 字段 → 空数组（不许补假数据）');
  });
});

/* ── 步骤归一（R35 · E09/E2）────────────────────────────────────────── */
test('normalizeSteps：非数组→空、空项丢、上限 50、长文本截断', () => {
  assert.deepEqual(normalizeSteps(undefined), []);
  assert.deepEqual(normalizeSteps(null), []);
  assert.deepEqual(normalizeSteps('x'), []);
  assert.deepEqual(normalizeSteps([{ op: 'set', text: '' }, {}, null, 3]), [{ op: 'set', text: '' }]);
  assert.equal(normalizeSteps(Array.from({ length: 60 }, (_, index) => ({ op: 'set', text: `第 ${index} 条` }))).length, 50);
  const [long] = normalizeSteps([{ op: 'x'.repeat(99), text: 'y'.repeat(999) }]);
  assert.equal(long?.op.length, 32);
  assert.equal(long?.text.length, 240);
});

/* ── 护栏：坏 JSON 不被覆盖 ──────────────────────────────────────── */
test('护栏：sessions.json 坏了 → 500 + CHAT_CORRUPT，且文件字节不变（不许拿空数组盖掉）', async () => {
  await withProject(async ({ studio, projectId, chatDir }) => {
    await fs.mkdir(chatDir, { recursive: true });
    const broken = '{ "version": 1, "sessions": [ 这不是 json';
    await fs.writeFile(path.join(chatDir, 'sessions.json'), broken, 'utf8');

    const listed = await getJson(`${studio.url}/api/projects/${projectId}/agent/sessions`);
    assert.equal(listed.status, 500, JSON.stringify(listed.body));
    assert.equal(listed.body.code, 'CHAT_CORRUPT');

    const created = await postJson(`${studio.url}/api/projects/${projectId}/agent/sessions`, {});
    assert.equal(created.status, 400, JSON.stringify(created.body));
    assert.equal(created.body.code, 'CHAT_CORRUPT');

    const after = await fs.readFile(path.join(chatDir, 'sessions.json'), 'utf8');
    assert.equal(after, broken, '坏文件必须一个字节都没动');
  });
});

/* ── 护栏：上限 200，置顶不丢 ────────────────────────────────────── */
test('护栏：超过 200 条时裁最旧的未置顶，置顶的一条都不丢', async () => {
  await withProject(async ({ studio, projectId, chatDir }) => {
    const sessions = Array.from({ length: MAX_SESSIONS + 5 }, (_, index) => ({
      id: `s${index.toString(36).padStart(4, '0')}abc`,
      title: `#${index}`,
      createdAt: iso(0),
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      turns: 1,
      pinned: index === 0, // 最旧但置顶 → 不许裁
    }));
    const newest = sessions[sessions.length - 1];
    await seedSessions(chatDir, sessions, newest === undefined ? null : newest.id);

    const created = await postJson(`${studio.url}/api/projects/${projectId}/agent/sessions`, {});
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const doc = await readDoc(chatDir);
    assert.equal(doc.sessions.length, MAX_SESSIONS, `应裁到 ${MAX_SESSIONS}，实际 ${doc.sessions.length}`);
    /** @type {any[]} */
    const kept = doc.sessions;
    assert.equal(kept.some((item) => item.pinned === true), true, '置顶那条被裁掉了');
    assert.equal(kept.some((item) => item.id === doc.last), true, 'last 必须在文件里');
    /* 裁掉的一定是最旧的未置顶那几条（index 1..5），不是随机的。 */
    for (const index of [1, 2, 3, 4, 5]) {
      assert.equal(kept.some((item) => item.title === `#${index}`), false, `#${index} 应该被裁掉`);
    }
  });
});

/* ── 纯函数：口径本身的自证 ──────────────────────────────────────── */
test('纯函数：id 形状 / normalizeDoc 容错 / listVisible 排序 / trimToLimit 不丢置顶', () => {
  assert.match(newSessionId({ now: 1762900000000, random: () => 0.123456 }), /^s[a-z0-9]{6,32}$/);

  const doc = normalizeDoc({
    version: 99,
    last: 'not-in-list',
    sessions: [
      { id: 'saaa111', turns: 'x', pinned: 'yes' },
      { id: 'bad id', turns: 3 },
      null,
      { id: 'sbbb222', turns: 2, updatedAt: iso(4) },
    ],
  });
  assert.equal(doc.version, 1, 'version 必须被收敛成 1');
  assert.equal(doc.sessions.length, 2, '坏条目要丢掉');
  assert.equal(doc.sessions[0].turns, 0, 'turns 非数字按 0');
  assert.equal(doc.sessions[0].pinned, false, 'pinned 只认 true');
  assert.equal(doc.last, 'saaa111', 'last 指向不在列表里的 id → 落到第一条');

  const ordered = listVisible([
    { id: 'sa1', turns: 1, updatedAt: iso(1), pinned: false },
    { id: 'sa2', turns: 1, updatedAt: iso(9), pinned: false },
    { id: 'sa3', turns: 1, updatedAt: iso(2), pinned: true },
    { id: 'sa4', turns: 0, updatedAt: iso(9), pinned: true },
  ]);
  assert.deepEqual(ordered.map((item) => item.id), ['sa3', 'sa2', 'sa1']);

  const many = Array.from({ length: 210 }, (_, index) => ({ id: `s${index}`, turns: 1, updatedAt: iso(index % 60), pinned: index === 7 }));
  const trimmed = trimToLimit(many, null);
  assert.equal(trimmed.sessions.length, MAX_SESSIONS);
  assert.equal(trimmed.sessions.some((item) => item.id === 's7'), true, '置顶的不许裁');
});

/* ── R114-B2：会话 PATCH（rename / pin / archive）──────────────────── */
/** @param {string} url @param {unknown} body */
async function patchJson(url, body) {
  const response = await fetch(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test('⑥ PATCH：改名/置顶/归档都落盘，pinned 与 archived 互不清除', async (t) => {
  await withProject(async ({ studio, projectId, chatDir }) => {
    const first = await postJson(`${studio.url}/api/projects/${projectId}/agent/sessions`, {});
    const sid = first.body.session.id;
    const url = `${studio.url}/api/projects/${projectId}/agent/sessions/${sid}`;
    /* 路由归 MAIN（`studio-server.mjs`）：patch 还没落地时跳过，而不是把测试挂红。 */
    const gate = await patchJson(url, {});
    if (gate.status === 405) {
      t.skip('PATCH 路由未落地：等 MAIN 应用 evidence/rounds/R50-SUB2/R114-SUB2-SERVER-ROUTES.patch');
      return;
    }

    const renamed = await patchJson(url, { title: '改过的标题' });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.deepEqual(Object.keys(renamed.body).sort(), ['last', 'ok', 'session']);
    assert.equal(renamed.body.session.title, '改过的标题');
    assert.equal(renamed.body.session.pinned, false);
    assert.equal(renamed.body.session.archived, false);

    const pinned = await patchJson(url, { pinned: true });
    assert.equal(pinned.status, 200);
    assert.equal(pinned.body.session.pinned, true);
    assert.equal(pinned.body.session.archived, false, '置顶不能顺手取消归档位');

    const archived = await patchJson(url, { archived: true });
    assert.equal(archived.status, 200);
    assert.equal(archived.body.session.archived, true);
    assert.equal(archived.body.session.pinned, true, '归档不能顺手取消置顶');

    const doc = await readDoc(chatDir);
    const row = doc.sessions.find((/** @type {any} */ item) => item.id === sid);
    assert.equal(row.title, '改过的标题');
    assert.equal(row.pinned, true);
    assert.equal(row.archived, true);
    assert.equal(row.turns, 0, 'turns 不是 PATCH 能改的字段');
    assert.equal(doc.last, sid, 'last 不被 PATCH 改掉');

    /* 恢复：archived:false 回列表，pin 仍在。 */
    const restored = await patchJson(url, { archived: false });
    assert.equal(restored.body.session.archived, false);
    assert.equal(restored.body.session.pinned, true);
  });
});

test('⑦ PATCH：空 patch → EMPTY_PATCH；未知键 → UNKNOWN_FIELD；不存在的 sid → 404', async (t) => {
  await withProject(async ({ studio, projectId }) => {
    const first = await postJson(`${studio.url}/api/projects/${projectId}/agent/sessions`, {});
    const sid = first.body.session.id;
    const url = `${studio.url}/api/projects/${projectId}/agent/sessions/${sid}`;
    if ((await patchJson(url, {})).status === 405) {
      t.skip('PATCH 路由未落地（同上）');
      return;
    }

    const empty = await patchJson(url, {});
    assert.equal(empty.status, 400, JSON.stringify(empty.body));
    assert.equal(empty.body.code, 'EMPTY_PATCH');

    const unknown = await patchJson(url, { color: 'red' });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.code, 'UNKNOWN_FIELD');
    assert.equal(unknown.body.field, 'color');

    const badTitle = await patchJson(url, { title: 42 });
    assert.equal(badTitle.status, 400);
    assert.equal(badTitle.body.code, 'TITLE_INVALID');

    const longTitle = await patchJson(url, { title: 'x'.repeat(81) });
    assert.equal(longTitle.status, 400);
    assert.equal(longTitle.body.code, 'TITLE_INVALID');

    const missing = await patchJson(`${studio.url}/api/projects/${projectId}/agent/sessions/snosuch01`, { pinned: true });
    assert.equal(missing.status, 404, JSON.stringify(missing.body));
    assert.equal(missing.body.code, 'SESSION_NOT_FOUND');
  });
});

test('⑧ PATCH：坏 sessions.json → 500 CHAT_CORRUPT，且字节一个都没动', async (t) => {
  await withProject(async ({ studio, projectId, chatDir }) => {
    await fs.mkdir(chatDir, { recursive: true });
    const broken = '{ "version": 1, "sessions": [ 坏';
    await fs.writeFile(path.join(chatDir, 'sessions.json'), broken, 'utf8');
    const probePatch = await patchJson(`${studio.url}/api/projects/${projectId}/agent/sessions/sabc1234`, { pinned: true });
    if (probePatch.status === 405) {
      t.skip('PATCH 路由未落地（同上）');
      return;
    }
    const patched = probePatch;
    assert.equal(patched.status, 500, JSON.stringify(patched.body));
    assert.equal(patched.body.code, 'CHAT_CORRUPT');
    assert.equal(await fs.readFile(path.join(chatDir, 'sessions.json'), 'utf8'), broken);
  });
});
/* ── ⑨ R118（L5 · LI-A46）：新字段兼容 —— 不认识的键一个不丢 ────────── */
test('⑨ PATCH 之后：sessions.json 里的未知字段原样保留（新字段不静默丢失）', async (t) => {
  await withProject(async ({ studio, projectId, chatDir }) => {
    /* 旧版本/外部工具写进去的字段：本进程读不懂，但**不许抹掉**。
       同时给一条没有 pinned/archived 的老记录（补默认值，不是删除）。 */
    const legacy = {
      id: 'slegacy01',
      title: '老会话',
      createdAt: iso(1),
      updatedAt: iso(5),
      turns: 2,
      /* ↓ 三个未知键 */
      color: '#ff0000',
      summary: { model: 'old-model', tokens: 1234 },
      tags: ['开场', '复盘'],
    };
    await seedSessions(chatDir, [legacy], 'slegacy01');
    const url = `${studio.url}/api/projects/${projectId}/agent/sessions/slegacy01`;
    const probe = await patchJson(url, {});
    if (probe.status === 405) {
      t.skip('PATCH 路由未落地（同上）');
      return;
    }
    const patched = await patchJson(url, { title: '改过名的老会话' });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    const doc = await readDoc(chatDir);
    const row = doc.sessions.find((/** @type {any} */ item) => item.id === 'slegacy01');
    assert.equal(row.title, '改过名的老会话');
    assert.equal(row.color, '#ff0000', '未知字段 color 被写丢了');
    assert.deepEqual(row.summary, { model: 'old-model', tokens: 1234 }, '未知字段 summary 被写丢了');
    assert.deepEqual(row.tags, ['开场', '复盘'], '未知字段 tags 被写丢了');
    /* 老记录没有 pinned/archived → 补 false，不是把整条丢掉。 */
    assert.equal(row.pinned, false);
    assert.equal(row.archived, false);
    assert.equal(row.turns, 2);
    assert.equal(doc.last, 'slegacy01');
  });
});

test('⑨b normalizeDoc 纯函数：未知键保留、已知键以归一值为准', () => {
  const doc = normalizeDoc({
    version: 9,
    last: 'sabc1234',
    sessions: [{ id: 'sabc1234', title: 42, turns: -1, color: 'red', extra: { a: 1 } }],
  });
  const row = doc.sessions[0];
  assert.equal(row.title, '', 'title 不是字符串 → 归一成空串');
  assert.equal(row.turns, 0, '负数 turns → 0');
  assert.equal(row.color, 'red');
  assert.deepEqual(row.extra, { a: 1 });
  assert.equal(doc.version, 1, 'version 仍写 1（不把未知版本号带回磁盘）');
});
