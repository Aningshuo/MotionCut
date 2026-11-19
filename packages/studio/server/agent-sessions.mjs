/**
 * Agent 会话存储（R28 · BATCH-SUB2-R29-073 · F08 服务端三端点）
 *
 * 契约照 OpenFilm 0.3.2 的主进程 `chat-store.mjs`（R26 取证，R26-F08-REF.json）：
 *   `.film/chat/sessions.json` = `{ version: 1, last, sessions: [...] }`
 *   `.film/chat/turns/<turn>.json` = 每个回合一份
 * 字段：`{ id, title, createdAt, updatedAt, turns, pinned?, archived? }`；id = `s` + base36 时间戳 + 6 位随机。
 *
 * 为什么不用 `createWriteQueue`：
 *   那个队列是**film.html 文本编辑**队列 —— 它自己 `io.read(filmPath)`、按 `edits` 打补丁、
 *   写 `.film/history` 快照。硬套到「一个 JSON 文件、整份替换」上，就得给它造一份假的 film 文档，
 *   还会把会话写盘塞进 film 的 hash 链。所以这里取它的**串行化那半**（一条 tail 链，同 idiom），
 *   配 `subtitle-store.mjs` 同规格的原子写（同目录临时文件 → fsync → rename → 回读校验）。
 *
 * 安全/健壮：
 *   - 文件不存在 = 空文档，不是错误；JSON 坏了回 `CHAT_CORRUPT` 且**绝不覆盖**（不拿空数组盖掉用户的会话）。
 *   - 上限 200 条（参照 `CIe=200`）；裁的是「最旧的、没置顶、且不是 last」那一条，置顶的一条不丢。
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** 会话 id：`s` + base36 时间戳 + 6 位随机（参照 `l1()` 原文）。 */
export const SESSION_ID_RE = /^s[a-z0-9]{6,32}$/;
export const MAX_SESSIONS = 200;
export const CHAT_VERSION = 1;
/** 标题上限（与 `create()` 里的 `slice(0, 80)` 同一口径，重命名也走它）。 */
export const MAX_TITLE = 80;
/** 回合 id：`t` + base36 时间戳 + 6 位随机（与 `sessions.json` 里的 id 同 idiom）。 */
export const TURN_ID_RE = /^t[a-z0-9]{6,32}$/;

/**
 * @param {{ now?: number, random?: () => number }} [input]
 * @returns {string}
 */
export function newSessionId(input = {}) {
  const now = input.now ?? Date.now();
  const random = input.random ?? Math.random;
  return `s${now.toString(36)}${random().toString(36).slice(2, 8)}`;
}

/**
 * @param {{ now?: number, random?: () => number }} [input]
 * @returns {string}
 */
export function newTurnId(input = {}) {
  const now = input.now ?? Date.now();
  const random = input.random ?? Math.random;
  return `t${now.toString(36)}${random().toString(36).slice(2, 8)}`;
}

/**
 * 会话目录：`<project.dir>/.film/chat`。
 * @param {{ dir: string }} project
 */
export function chatDirOf(project) {
  return path.join(project.dir, '.film', 'chat');
}

/**
 * @param {{ dir: string }} project
 */
export function sessionsPathOf(project) {
  return path.join(chatDirOf(project), 'sessions.json');
}

/** 回合步骤的上限（防一份坏回合把整条会话响应撑爆）。 */
export const MAX_TURN_STEPS = 50;
export const MAX_STEP_TEXT = 240;
export const MAX_STEP_OP = 32;
/** 回合里存的 prompt 上限：与 `agent-scene` 的 `MAX_PROMPT_CHARS` 同量级（4000）。 */
export const MAX_TURN_PROMPT = 4000;

/**
 * 回合步骤归一（R35 · E09/E2）：只留 `{ op, text }` 两个字符串字段，丢掉其它。
 *
 * 三条口径：
 *   - 不是数组 → 空数组（老回合没有这个字段；**不抛错、不补假数据**）；
 *   - `op` / `text` 都为空 → 丢（一个什么都不说的步骤行没有意义）；
 *   - 上限 50 条 / 文本 240 字 / kind 32 字 —— 这是展示用的摘要，不是 ops 本体。
 * @param {unknown} raw
 * @returns {{ op: string, text: string }[]}
 */
export function normalizeSteps(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const row = /** @type {Record<string, unknown>} */ (item);
    const op = typeof row.op === 'string' ? row.op.slice(0, MAX_STEP_OP) : '';
    const text = typeof row.text === 'string' ? row.text.slice(0, MAX_STEP_TEXT) : '';
    if (op === '' && text === '') continue;
    out.push({ op, text });
    if (out.length >= MAX_TURN_STEPS) break;
  }
  return out;
}

/**
 * 把磁盘上的任意形状收敛成合法文档。**不抛错**：坏条目丢掉，缺字段补默认。
 *
 * R118（L5 · LI-A46「新字段兼容不静默丢失」）：**未知字段原样保留**。
 * 改前的写法只挑七个已知键重建一条记录 —— 只要有人（旧版本、外部工具、以后加的
 * 字段）在 `sessions.json` 里多写一个键，本进程改名一次就把它抹掉了，而且一声不响。
 * 现在用 `...item` 打底、已知键覆盖在上面：新字段读不懂也不会被写丢。
 * @param {unknown} raw
 * @returns {{ version: number, last: string | null, sessions: any[] }}
 */
export function normalizeDoc(raw) {
  const doc = raw !== null && typeof raw === 'object' ? /** @type {any} */ (raw) : {};
  /** @type {any[]} */
  const rawSessions = Array.isArray(doc.sessions) ? doc.sessions : [];
  const sessions = rawSessions
    .filter((item) => item !== null && typeof item === 'object' && typeof item.id === 'string' && SESSION_ID_RE.test(item.id))
    .map((item) => ({
          /* 不认识的键一个不丢（见上面的说明）；下面七个键以归一后的值为准。 */
          ...item,
          id: item.id,
          title: typeof item.title === 'string' ? item.title : '',
          createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString(),
          updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : (typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString()),
          turns: Number.isFinite(item.turns) && item.turns >= 0 ? Math.floor(item.turns) : 0,
          pinned: item.pinned === true,
      archived: item.archived === true,
    }));
  const last = typeof doc.last === 'string' && sessions.some((s) => s.id === doc.last) ? doc.last : (sessions[0]?.id ?? null);
  return { version: CHAT_VERSION, last, sessions };
}

/**
 * 列表口径：只筛 `turns > 0`；`pinned` 优先 → `updatedAt` 倒序（同值按 id 稳定排序）。
 *
 * R114（L3）：默认**不含归档**（归档就是不碍事；恢复后回到列表）。要看归档，
 * 显式传 `includeArchived: true` —— 默认不返回，避免旧行为突然多出一堆行。
 * @param {any[]} sessions
 * @param {{ includeArchived?: boolean }} [options]
 * @returns {any[]}
 */
export function listVisible(sessions, options = {}) {
  const includeArchived = options.includeArchived === true;
  return sessions
    .filter((item) => item.turns > 0 && (includeArchived === true || item.archived !== true))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const delta = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
      if (Number.isFinite(delta) && delta !== 0) return delta;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

/**
 * 超过上限时裁掉「最旧的、没置顶、且不是 last」那一条。置顶一条都不丢。
 * @param {any[]} sessions
 * @param {string | null} last
 * @returns {{ sessions: any[], dropped: string[] }}
 */
export function trimToLimit(sessions, last) {
  const out = [...sessions];
  const dropped = [];
  while (out.length > MAX_SESSIONS) {
    let index = -1;
    for (let i = 0; i < out.length; i += 1) {
      const item = out[i];
      if (item.pinned === true || item.id === last) continue;
      if (index === -1 || Date.parse(item.updatedAt) < Date.parse(out[index].updatedAt)) index = i;
    }
    if (index === -1) break; // 全是置顶 → 宁可超上限也不丢
    dropped.push(out[index].id);
    out.splice(index, 1);
  }
  return { sessions: out, dropped };
}

/**
 * 同目录临时文件 → fsync → rename → 回读校验（与 `subtitle-store.writeAtomic` 同规格）。
 * @param {{ path: string, text: string }} input
 * @returns {Promise<{ ok: true } | { ok: false, code: string, message: string }>}
 */
export async function writeAtomic(input) {
  const dir = path.dirname(input.path);
  const temp = path.join(dir, `.${path.basename(input.path)}.tmp-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`);
  let handle = null;
  try {
    await fs.mkdir(dir, { recursive: true });
    handle = await fs.open(temp, 'wx');
    await handle.writeFile(input.text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temp, input.path);
  } catch (error) {
    if (handle !== null) await handle.close().catch(() => undefined);
    await fs.unlink(temp).catch(() => undefined);
    return { ok: false, code: 'CHAT_WRITE_FAILED', message: String(/** @type {Error} */ (error).message) };
  }
  const back = await fs.readFile(input.path, 'utf8').catch(() => null);
  if (back !== input.text) {
    return { ok: false, code: 'CHAT_WRITE_FAILED', message: '回读校验失败：写入内容与内存不一致' };
  }
  return { ok: true };
}

/* ── 串行化：同一个 sessions.json 上的读-改-写必须排队 ────────────────────
   并发 10 个 POST 若各自「读 → 判断有没有空会话 → 写」，就会各建一条（甚至互相覆盖）。
   这里按文件路径挂一条 tail 链，写法与 `write-queue.mjs` 的 tail 一致。 */
/** @type {Map<string, Promise<unknown>>} */
const tails = new Map();

/**
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
function enqueue(key, run) {
  const previous = tails.get(key) ?? Promise.resolve();
  const next = previous.then(run, run);
  tails.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/**
 * 建一个工程会话 store。
 * @param {{ project: { projectId: string, dir: string } }} options
 */
export function createSessionsStore(options) {
  const project = options.project;
  const file = sessionsPathOf(project);
  const dir = chatDirOf(project);

  /**
   * 读文档。文件不存在 = 空文档；JSON 坏了 = `CHAT_CORRUPT`（调用方不许写回去）。
   * @returns {Promise<{ ok: true, doc: any, exists: boolean } | { ok: false, code: string, message: string }>}
   */
  async function read() {
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
        return { ok: true, doc: { version: CHAT_VERSION, last: null, sessions: [] }, exists: false };
      }
      return { ok: false, code: 'CHAT_UNREADABLE', message: `${file}: ${String(/** @type {Error} */ (error).message)}` };
    }
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      return { ok: false, code: 'CHAT_CORRUPT', message: `${path.basename(file)} 不是合法 JSON：${String(/** @type {Error} */ (error).message)}` };
    }
    return { ok: true, doc: normalizeDoc(raw), exists: true };
  }

  /**
   * 整份写回（调用方已在队列里）。
   * @param {any} doc
   */
  async function persist(doc) {
    const text = `${JSON.stringify({ version: CHAT_VERSION, last: doc.last ?? null, sessions: doc.sessions }, null, 1)}\n`;
    return writeAtomic({ path: file, text });
  }

  /**
   * 列出：只筛 turns>0，pinned 优先 → updatedAt 倒序。
   * `includeArchived` 为真时连归档一起给（UI 的「已归档」页签用）。
   * @param {{ includeArchived?: boolean }} [input]
   * @returns {Promise<{ ok: true, version: number, last: string|null, sessions: any[], total: number, hidden: number, archived: number } | { ok: false, code: string, message: string }>}
   */
  async function list(input = {}) {
    const read_ = await read();
    if (read_.ok !== true) return read_;
    const includeArchived = input?.includeArchived === true;
    const visible = listVisible(read_.doc.sessions, { includeArchived });
    return {
      ok: true,
      version: read_.doc.version,
      last: read_.doc.last,
      sessions: visible,
      total: read_.doc.sessions.length,
      hidden: read_.doc.sessions.length - visible.length,
      /* 归档条数单独报：UI 要说「还有 N 条已归档」，不能只说「隐藏了 N 条」。 */
      archived: read_.doc.sessions.filter((/** @type {any} */ item) => item.archived === true).length,
    };
  }

  /**
   * 新建：**已有空会话就返回它**（参照 `ar()`「已是新对话就只聚焦」），不造重复。
   * @param {{ title?: unknown }} [input]
   * @returns {Promise<{ ok: true, created: boolean, session: any, doc: any } | { ok: false, code: string, message: string }>}
   */
  async function create(input = {}) {
    return enqueue(file, async () => {
      const read_ = await read();
      if (read_.ok !== true) return read_;
      const doc = read_.doc;
      /** @type {any[]} */
      const sessions = doc.sessions;
      const existing = sessions.find((item) => item.turns === 0 && item.archived !== true);
      if (existing !== undefined) {
        return { ok: true, created: false, session: existing, doc };
      }
      const now = new Date().toISOString();
      const title = typeof input.title === 'string' ? input.title.slice(0, 80) : '';
      const session = { id: newSessionId(), title, createdAt: now, updatedAt: now, turns: 0, pinned: false, archived: false };
      doc.sessions.push(session);
      doc.last = session.id;
      const trimmed = trimToLimit(doc.sessions, doc.last);
      doc.sessions = trimmed.sessions;
      const written = await persist(doc);
      if (written.ok !== true) return written;
      return { ok: true, created: true, session, doc, dropped: trimmed.dropped };
    });
  }

  /**
   * 读一个回合目录里的记录，按 `at` 升序。
   * @param {string} sid
   */
  async function turnsOf(sid) {
    const turnsDir = path.join(dir, 'turns');
    let names;
    try {
      names = await fs.readdir(turnsDir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names.filter((item) => item.endsWith('.json')).sort()) {
      let parsed;
      try {
        parsed = JSON.parse(await fs.readFile(path.join(turnsDir, name), 'utf8'));
      } catch {
        continue; // 单个回合坏了不该把整条会话读失败
      }
      const turn = parsed?.turn ?? null;
      if (turn === null || typeof turn !== 'object' || turn.sessionId !== sid) continue;
      out.push({
        id: typeof turn.id === 'string' ? turn.id : name.replace(/\.json$/, ''),
        prompt: typeof turn.prompt === 'string' ? turn.prompt : '',
        draftId: typeof turn.draftId === 'string' ? turn.draftId : null,
        state: typeof turn.state === 'string' ? turn.state : null,
        at: typeof turn.at === 'string' ? turn.at : null,
        /* R35（E09 · E2）：步骤摘要是**回合自带的可选字段**，不是从 `draft.ops` 里现取
           —— 草稿只在内存里，刷新即失，而「这个回合做了什么」要能复盘。写入面还没有
           （本文件只有 list/create/get），字段先按可选透传：没有就是空数组，UI 不渲染。 */
        steps: normalizeSteps(turn.steps),
      });
    }
    return out.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
  }

  /**
   * 点开：session + turns + lastDraft（最后一回合的草稿）。
   * @param {string} sid
   * @returns {Promise<{ ok: true, session: any, turns: any[], lastDraft: any|null } | { ok: false, code: string, message: string }>}
   */
  async function get(sid) {
    const read_ = await read();
    if (read_.ok !== true) return read_;
    /** @type {any[]} */
    const sessions = read_.doc.sessions;
    const session = sessions.find((item) => item.id === sid) ?? null;
    if (session === null) return { ok: false, code: 'SESSION_NOT_FOUND', message: `没有这条会话：${sid}` };
    const turns = await turnsOf(sid);
    const lastTurn = turns.length === 0 ? null : (turns[turns.length - 1] ?? null);
    return {
      ok: true,
      session,
      turns,
      lastDraft: lastTurn === null || lastTurn.draftId === null ? null : { draftId: lastTurn.draftId, state: lastTurn.state, at: lastTurn.at },
    };
  }

  /**
   * 局部更新一条会话的元数据：`title` / `pinned` / `archived`（R114 · L3 / R114-B2）。
   *
   * 口径（答复件 ANSWER-SUB2-R114-DEPS §2.2）：
   *   - **只**接受这三个键；给别的键 = `UNKNOWN_FIELD`，不静默忽略（静默忽略会让 UI
   *     以为写成功了，下次读回来还是旧值）；一个键都不给 = `EMPTY_PATCH`；
   *   - **`pinned` 与 `archived` 互不清除**：置顶一条归档会话不会顺手取消置顶，
   *     恢复一条置顶会话也不会把 pinned 抹掉 —— 两个布尔各管各的；
   *   - `archived:false` 就是**恢复**：归档只改一个布尔，回合文件一个不删；
   *   - **不动 `updatedAt`**：改名/置顶/归档不是「有了新回合」，跟着改会让列表
   *     按「最后改过名字」重排，用户会觉得顺序自己在跳。置顶本来就有独立排序位；
   *   - 坏文件（`CHAT_CORRUPT`）照旧**不覆盖**：`read()` 失败就直接把错误返回。
   *
   * @param {string} sid
   * @param {{ title?: unknown, pinned?: unknown, archived?: unknown }} [input]
   * @returns {Promise<{ ok: true, session: any, last: string|null } | { ok: false, code: string, message: string }>}
   */
  async function update(sid, input = {}) {
    return enqueue(file, async () => {
      const read_ = await read();
      if (read_.ok !== true) return read_;
      const doc = read_.doc;
      const session = doc.sessions.find((/** @type {any} */ item) => item.id === sid) ?? null;
      if (session === null) return { ok: false, code: 'SESSION_NOT_FOUND', message: `没有这条会话：${sid}` };
      const hasTitle = input?.title !== undefined;
      const hasPinned = input?.pinned !== undefined;
      const hasArchived = input?.archived !== undefined;
      if (hasTitle !== true && hasPinned !== true && hasArchived !== true) {
        return { ok: false, code: 'EMPTY_PATCH', message: '至少要给一个字段（title / pinned / archived）' };
      }
      if (hasTitle === true) {
        if (typeof input.title !== 'string') {
          return { ok: false, code: 'TITLE_INVALID', message: 'title 必须是字符串', field: 'title' };
        }
        if (input.title.length > MAX_TITLE) {
          return { ok: false, code: 'TITLE_INVALID', message: `title 最长 ${String(MAX_TITLE)} 字`, field: 'title', max: MAX_TITLE };
        }
        session.title = input.title.trim();
      }
      if (hasPinned === true) {
        if (typeof input.pinned !== 'boolean') {
          return { ok: false, code: 'VALUE_INVALID', message: 'pinned 必须是布尔值', field: 'pinned', expected: 'boolean' };
        }
        /* 只改这一个布尔 —— 不碰 archived。 */
        session.pinned = input.pinned;
      }
      if (hasArchived === true) {
        if (typeof input.archived !== 'boolean') {
          return { ok: false, code: 'VALUE_INVALID', message: 'archived 必须是布尔值', field: 'archived', expected: 'boolean' };
        }
        /* 只改这一个布尔 —— 不碰 pinned。 */
        session.archived = input.archived;
      }
      const written = await persist(doc);
      if (written.ok !== true) return written;
      return { ok: true, session, last: doc.last };
    });
  }

  /**
   * 给会话追加一个回合（R114 · L3「真实续接」的落盘那一半）。
   *
   * 写 `turns/<turnId>.json` = `{ turn: { id, sessionId, prompt, draftId, state, at, steps } }`
   * （与 `turnsOf()` 的读法逐字段对齐），再 bump `turns` / `updatedAt` / `last`。
   *
   * 顺序：先写回合文件 → 再整份写 sessions.json。第二步失败就把刚写的回合文件收掉，
   * 不让它变成「有回合没计数」的孤儿。已归档的会话收到新回合 = 自动恢复（继续用
   * 一个归档会话，结果却还在归档里，比恢复更奇怪）。
   *
   * @param {string} sid
   * @param {{ prompt?: unknown, draftId?: unknown, state?: unknown, steps?: unknown, at?: unknown, turnId?: unknown }} [input]
   * @returns {Promise<{ ok: true, turn: any, session: any, created: boolean } | { ok: false, code: string, message: string }>}
   */
  async function appendTurn(sid, input = {}) {
    return enqueue(file, async () => {
      const read_ = await read();
      if (read_.ok !== true) return read_;
      const doc = read_.doc;
      const session = doc.sessions.find((/** @type {any} */ item) => item.id === sid) ?? null;
      if (session === null) return { ok: false, code: 'SESSION_NOT_FOUND', message: `没有这条会话：${sid}` };
      const prompt = typeof input?.prompt === 'string' ? input.prompt.slice(0, MAX_TURN_PROMPT) : '';
      const draftId = typeof input?.draftId === 'string' && input.draftId !== '' ? input.draftId : null;
      const state = typeof input?.state === 'string' && input.state !== '' ? input.state : null;
      const at = typeof input?.at === 'string' && input.at !== '' ? input.at : new Date().toISOString();
      const turnId = typeof input?.turnId === 'string' && TURN_ID_RE.test(input.turnId) ? input.turnId : newTurnId();
      const turn = {
        id: turnId,
        sessionId: sid,
        prompt,
        draftId,
        state,
        at,
        steps: normalizeSteps(input?.steps),
      };
      const turnsDir = path.join(dir, 'turns');
      const turnFile = path.join(turnsDir, `${turnId}.json`);
      const writtenTurn = await writeAtomic({ path: turnFile, text: `${JSON.stringify({ turn }, null, 1)}\n` });
      if (writtenTurn.ok !== true) return writtenTurn;
      session.turns = (Number.isFinite(session.turns) ? session.turns : 0) + 1;
      /* CS3 · 对话面板：新建的会话还没有标题时，用第一句原话当标题（真实数据，
         不编名字）。用户随时可以重命名覆盖它。 */
      if (session.title === '' && prompt !== '') {
        session.title = prompt.replace(/\s+/g, ' ').trim().slice(0, 40);
      }
      session.updatedAt = at;
      if (session.archived === true) session.archived = false;
      doc.last = sid;
      const written = await persist(doc);
      if (written.ok !== true) {
        await fs.unlink(turnFile).catch(() => undefined);
        return written;
      }
      return { ok: true, turn, session, created: true };
    });
  }

  return { file, dir, read, list, create, get, update, appendTurn, persist };
}
