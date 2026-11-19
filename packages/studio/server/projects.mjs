/**
 * 工程库 / 多标签 / 每工程视图状态（WP05）。
 *
 * 边界（任务书 M4）：
 * - 每工程一个写队列、一个 `FilmDocIo`、一个 fs.watch、一份视图状态（播放头/选区）；跨工程不共享。
 * - 同一工程重复打开 → 聚焦已有标签，不建第二个队列。
 * - 内存里只有 `parse()` 的投影；权威永远是磁盘上的 film.html。
 * - 外部改动只发 `film.changed`（带新 hash），**不**自动覆盖用户未落盘的编辑，也不自动回写。
 * - 缩略帧：本批只做请求可观测（PENDING_FRAME / 超时 / 失败码），真正的 `frame(t)` 由副线1 接。
 */

import { watch as fsWatch } from 'node:fs';
import { access, constants, readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { parse as parseFilm } from '../../film-core/film-doc.mjs';
import { observePageFrom } from './element-world.mjs';
import { createEditSession } from './edit-session.mjs';
import { createFilmDocIo } from './film-io.mjs';
import { projectIdFor } from './project-create.mjs';
import { canonicalProjectDirectory } from './project-identity.mjs';
import { createWriteQueue } from './write-queue.mjs';

export const THUMBNAIL_TIMEOUT_MS = 1500;

/**
 * @param {{
 *   hub: { publish: (event: any) => number },
 *   io?: ReturnType<typeof createFilmDocIo>,
 *   ioFactory?: (context: { projectDir: string, filmPath: string, projectId: string }) => ReturnType<typeof createFilmDocIo>,
 *   queueHooks?: { beforeRun?: (job: any) => Promise<void>|void },
 *   watchImpl?: typeof fsWatch,
 *   now?: () => Date,
 *   thumbnailTimeoutMs?: number,
 *   history?: boolean,
 * }} options
 */
export function createProjectRegistry(options) {
  const hub = options.hub;
  const now = options.now ?? (() => new Date());
  const watchImpl = options.watchImpl ?? fsWatch;
  const thumbnailTimeoutMs = options.thumbnailTimeoutMs ?? THUMBNAIL_TIMEOUT_MS;
  const history = options.history;

  /** @type {Map<string, any>} */
  const projects = new Map();
  /** @type {Map<string, ReturnType<typeof openEntry>>} */
  const opening = new Map();
  /** @type {{ opens: number, queuesCreated: number, watchesCreated: number }} */
  const stats = { opens: 0, queuesCreated: 0, watchesCreated: 0 };

  /**
   * @param {{ projectId: string, projectDir: string, filmPath: string }} context
   */
  function ioFor(context) {
    if (options.ioFactory !== undefined) return options.ioFactory(context);
    if (options.io !== undefined) return options.io;
    return createFilmDocIo();
  }

  /**
   * 写前观察一个 page 片段的目标元素（R143）。**只读源码**，不开浏览器：
   * 写入口是同步链，观察必须能在毫秒级完成，而且判的应该是「被写回去的那份东西」。
   * @param {{ projectId: string, projectDir: string, src: unknown, keys: string[] }} input
   * @returns {Promise<{ ok: true, observation: any } | { ok: false, code: string, message: string }>}
   */
  async function observePage(input) {
    return observePageFrom(input);
  }

  /**
   * 打开工程。幂等：同一路径重复打开返回已有状态（单标签、单队列）。
   * @param {string} dirPath
   * @returns {Promise<{ ok: true, project: any, existing: boolean } | { ok: false, code: string, message: string, diagnostics?: any[] }>}
   */
  async function open(dirPath) {
    if (typeof dirPath !== 'string' || dirPath.trim() === '') {
      return { ok: false, code: 'FILM_NOT_FOUND', message: '工程路径为空' };
    }
    const projectDir = canonicalProjectDirectory(dirPath);
    const projectId = projectIdFor(projectDir);

    const existing = projects.get(projectId);
    if (existing !== undefined) {
      return { ok: true, project: existing, existing: true };
    }
    const pending = opening.get(projectId);
    if (pending !== undefined) {
      const result = await pending;
      return result.ok ? { ...result, existing: true } : result;
    }
    const job = openEntry(projectDir, projectId, resolve(dirPath));
    opening.set(projectId, job);
    try {
      return await job;
    } finally {
      opening.delete(projectId);
    }
  }

  /**
   * @param {string} projectDir @param {string} projectId @param {string} cwd
   * @returns {Promise<{ ok: true, project: any, existing: boolean } | { ok: false, code: string, message: string, diagnostics?: any[] }>}
   */
  async function openEntry(projectDir, projectId, cwd) {
    try {
      const info = await stat(projectDir);
      if (!info.isDirectory()) {
        return { ok: false, code: 'FILM_NOT_FOUND', message: `不是目录：${projectDir}` };
      }
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT' ? 'FILM_NOT_FOUND' : 'FILM_UNREADABLE';
      return { ok: false, code, message: `${projectDir}: ${String(/** @type {Error} */ (error).message)}` };
    }

    const filmPath = join(projectDir, 'film.html');
    try {
      await access(filmPath, constants.R_OK);
    } catch (error) {
      const missing = /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT';
      return {
        ok: false,
        code: missing ? 'FILM_NOT_FOUND' : 'FILM_UNREADABLE',
        message: `${filmPath}: ${String(/** @type {Error} */ (error).message)}`,
      };
    }

    const io = ioFor({ projectId, projectDir, filmPath });
    /** @type {{ text: string, sourceHash: string, mtimeMs: number }} */
    let read;
    try {
      read = await io.read(filmPath);
    } catch (error) {
      return {
        ok: false,
        code: 'FILM_UNREADABLE',
        message: String(/** @type {Error} */ (error).message),
      };
    }

    const parsed = parseFilm(read.text, { path: filmPath });
    if (parsed.doc === null) {
      // 坏文件不建空工程：把诊断原样交回，让 UI 决定怎么修。
      return {
        ok: false,
        code: 'FILM_INVALID',
        message: 'film.html 存在错误级诊断，未打开',
        diagnostics: parsed.diagnostics,
      };
    }

    // 编辑会话：唯一写入口的落盘侧（Op 批 → CAS → .film/history）。打开即 load()，失败就不算打开。
    const session = createEditSession({
      path: filmPath,
      io,
      projectId,
      history,
      /* R143：元素写守卫的观察源（读 page 源码；写前现读，不吃缓存）。 */
      observe: (input) => observePage({ projectId, projectDir, src: input.src, keys: input.keys }),
    });
    const sessionOpened = await session.load();
    if (sessionOpened.ok !== true) {
      return {
        ok: false,
        code: 'FILM_INVALID',
        message: `编辑会话无法载入：${sessionOpened.message}`,
      };
    }

    const queue = createWriteQueue({
      projectId,
      projectDir,
      filmPath,
      io,
      hub,
      hooks: {
        ...(options.queueHooks ?? {}),
        // commit 成功→立刻更新投影，fs.watch 随后读到同 hash 就不会误发 external。
        afterCommit: (info) => {
          const parsedAfter = parseFilm(info.text, { path: filmPath });
          if (parsedAfter.doc !== null) project.doc = parsedAfter.doc;
          project.sourceHash = info.hash;
          project.diagnostics = parsedAfter.diagnostics;
          project.mtimeMs = now().getTime();
          // 队列写入也改了磁盘：标记会话待重载，等下一批 Op 前再读（不在这里多一次 IO）。
          project.sessionStale = true;
        },
      },
      history,
    });
    stats.queuesCreated += 1;

    /** @type {any} */
    const project = {
      projectId,
      dir: projectDir,
      filmPath,
      io,
      queue,
      session,
      /** 磁盘被别的路径改过（队列写 / 外部编辑）：下一批 Op 前重载会话。 */
      sessionStale: false,
      /** 幂等键 → 首次结果（同一 opId 重放不再落盘）。 */
      opLog: new Map(),
      /** 每工程一条串行链：Op / 撤销 / 重做排队跑。 */
      chain: Promise.resolve(null),
      doc: parsed.doc,
      diagnostics: parsed.diagnostics,
      sourceHash: parsed.sourceHash,
      mtimeMs: read.mtimeMs,
      openedAt: now().toISOString(),
      view: { playhead: 0, selection: [], cwd },
      watcher: null,
      external: { lastAt: null, lastHash: null, count: 0, error: null },
      thumbnails: createThumbnails(projectId, parsed.doc),
      closing: false,
    };

    const watcher = watchImpl(filmPath, { persistent: false }, () => {
      scheduleExternalCheck(project);
    });
    watcher.on?.('error', (error) => {
      project.external.error = String(error?.message ?? error);
    });
    project.watcher = watcher;
    stats.watchesCreated += 1;

    projects.set(projectId, project);
    stats.opens += 1;
    return { ok: true, project, existing: false };
  }

  /** @type {WeakMap<any, NodeJS.Timeout>} */
  const debounces = new WeakMap();

  /** @param {any} project */
  function scheduleExternalCheck(project) {
    if (project.closing) return;
    const previous = debounces.get(project);
    if (previous !== undefined) clearTimeout(previous);
    const timer = setTimeout(() => {
      debounces.delete(project);
      void checkExternal(project);
    }, 80);
    timer.unref?.();
    debounces.set(project, timer);
  }

  /** @param {any} project */
  async function checkExternal(project) {
    if (project.closing || projects.get(project.projectId) !== project) return;
    /** @type {{ text: string, sourceHash: string, mtimeMs: number }} */
    let read;
    try {
      read = await project.io.read(project.filmPath);
    } catch (error) {
      project.external.error = String(/** @type {Error} */ (error).message);
      return;
    }
    project.external.lastAt = now().toISOString();
    project.external.lastHash = read.sourceHash;
    if (read.sourceHash === project.sourceHash) return;

    const parsed = parseFilm(read.text, { path: project.filmPath });
    project.sourceHash = read.sourceHash;
    project.mtimeMs = read.mtimeMs;
    project.diagnostics = parsed.diagnostics;
    if (parsed.doc !== null) project.doc = parsed.doc;
    project.external.count += 1;
    project.external.error = null;
    // 磁盘变了：标记会话待重载；下一批 Op 前会重读，失败则拒绝这一批（不写坏）。
    project.sessionStale = true;
    hub.publish({
      type: 'film.changed',
      projectId: project.projectId,
      sourceHash: read.sourceHash,
      by: 'external',
    });
  }

  /**
   * @param {string} projectId
   * @param {{ opId: string, expectedHash: string, edits: any[], by?: 'person'|'agent' }} write
   */
  async function write(projectId, write) {
    const project = projects.get(projectId);
    if (project === undefined) {
      return { ok: false, error: { code: 'FILM_NOT_FOUND', message: `工程未打开：${projectId}` } };
    }
    const result = await project.queue.submit(write);
    if (result.ok === true && typeof result.text === 'string') {
      const parsed = parseFilm(result.text, { path: project.filmPath });
      if (parsed.doc !== null) project.doc = parsed.doc;
      project.diagnostics = parsed.diagnostics;
      project.sourceHash = String(result.hash ?? parsed.sourceHash);
      project.mtimeMs = now().getTime();
      project.sessionStale = true;
    }
    return result;
  }

  /**
   * Agent 用的 cwd：本批只存字段，不参与执行。
   * @param {string} projectId
   * @param {string} cwd
   */
  function setCwd(projectId, cwd) {
    const project = projects.get(projectId);
    if (project === undefined) return { ok: false, code: 'FILM_NOT_FOUND' };
    if (typeof cwd !== 'string' || cwd === '') return { ok: false, code: 'INVALID', message: 'cwd 必须是非空字符串' };
    project.view.cwd = cwd;
    return { ok: true, cwd: project.view.cwd };
  }

  /**
   * @param {string} projectId
   * @param {{ playhead?: number, selection?: unknown[] }} view
   */
  function setView(projectId, view) {
    const project = projects.get(projectId);
    if (project === undefined) return { ok: false, code: 'FILM_NOT_FOUND' };
    if (typeof view.playhead === 'number' && Number.isFinite(view.playhead)) {
      project.view.playhead = Math.max(0, view.playhead);
    }
    if (Array.isArray(view.selection)) project.view.selection = view.selection;
    return { ok: true, view: project.view };
  }

  /**
   * @param {string} projectId
   * @param {{ waitMs?: number }} [input]
   */
  async function close(projectId, input = {}) {
    const project = projects.get(projectId);
    if (project === undefined) return { ok: false, code: 'FILM_NOT_FOUND', message: '工程未打开' };
    const waitMs = input.waitMs ?? 3000;
    project.closing = true;
    try {
      project.watcher?.close?.();
    } catch {
      // watcher 已经关了也不影响后续清理。
    }
    clearThumbnails(project);

    /** @type {{ drained: boolean, pending: number }} */
    let drain = { drained: project.queue.pending() === 0, pending: project.queue.pending() };
    if (!drain.drained) {
      drain = await Promise.race([
        project.queue.idle(),
        new Promise((resolveTimer) => {
          const timer = setTimeout(() => resolveTimer({ drained: false, pending: project.queue.pending() }), waitMs);
          timer.unref?.();
        }),
      ]);
    }
    if (!drain.drained) project.queue.close();
    projects.delete(projectId);
    return {
      ok: true,
      projectId,
      drained: drain.drained,
      cancelled: drain.drained ? 0 : drain.pending,
      pendingWrites: drain.pending,
      sourceHash: project.sourceHash,
    };
  }

  /**
   * 列出某个根目录下的工程（深度 1，存在 film.html 才算）。
   * @param {string} root
   */
  async function list(root) {
    if (typeof root !== 'string' || root.trim() === '') {
      return { ok: false, code: 'FILM_NOT_FOUND', message: '缺少 root' };
    }
    const dir = resolve(root);
    /** @type {string[]} */
    let entries;
    try {
      entries = await readdir(dir);
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT' ? 'FILM_NOT_FOUND' : 'FILM_UNREADABLE';
      return { ok: false, code, message: String(/** @type {Error} */ (error).message) };
    }
    /** @type {any[]} */
    const items = [];
    const seen = new Set();
    for (const name of entries.sort()) {
      if (name.startsWith('.')) continue;
      const candidate = join(dir, name);
      try {
        const info = await stat(candidate);
        if (!info.isDirectory()) continue;
        await access(join(candidate, 'film.html'), constants.R_OK);
      } catch {
        continue;
      }
      const projectPath = canonicalProjectDirectory(candidate);
      const projectId = projectIdFor(projectPath);
      if (seen.has(projectId)) continue;
      seen.add(projectId);
      items.push({
        projectId,
        name: basename(projectPath),
        path: projectPath,
        opened: projects.has(projectId),
        label: name,
      });
    }
    return { ok: true, root: dir, projects: items };
  }

  /**
   * `GET /api/projects/:id/doc` 的读侧：权威是磁盘（project.doc 由 open/写回/外部变更同步）。
   * @param {string} projectId
   */
  function docOf(projectId) {
    const project = projects.get(projectId);
    if (project === undefined) return null;
    return {
      doc: project.doc,
      hash: project.sourceHash,
      diagnostics: project.diagnostics,
      undoDepth: project.session?.depths?.().undo ?? 0,
      redoDepth: project.session?.depths?.().redo ?? 0,
    };
  }

  /**
   * 每工程一条串行链：Op / 撤销 / 重做排队跑，跨工程并行（合同：每工程一条写队列）。
   * @param {any} project
   * @param {() => Promise<any>} task
   */
  function serialize(project, task) {
    const run = project.chain.then(task, task);
    project.chain = run.then(() => null, () => null);
    return run;
  }

  /**
   * 会话待重载时先重读磁盘；失败就拒绝这一批（宁可 409，也不拿旧基做 CAS）。
   * @param {any} project
   * @returns {Promise<{ ok: false, code: string, message: string, currentHash?: string }|null>}
   */
  async function refreshSession(project) {
    if (project.sessionStale !== true) return null;
    const reloaded = await project.session.reload();
    project.sessionStale = false;
    if (reloaded.ok !== true) {
      return {
        ok: false,
        code: 'CONFLICT',
        message: `磁盘内容已变且无法重载：${reloaded.message}`,
        currentHash: project.session.sourceHash ?? project.sourceHash,
      };
    }
    adoptSession(project);
    return null;
  }

  /**
   * 写入成功后把会话的投影同步回工程（内存只做投影，权威是磁盘）。
   * @param {any} project
   * @param {string} [hash]
   */
  function adoptSession(project, hash) {
    const text = project.session.text;
    if (typeof text === 'string') {
      const parsed = parseFilm(text, { path: project.filmPath });
      if (parsed.doc !== null) project.doc = parsed.doc;
      project.diagnostics = parsed.diagnostics;
    }
    project.sourceHash =
      typeof hash === 'string' && hash !== '' ? hash : (project.session.sourceHash ?? project.sourceHash);
    project.mtimeMs = now().getTime();
  }

  /**
   * 发 `doc.changed`（任务书 M10 的字段）。`contracts/events.ts` v1.1.0 目前只列到 film.changed，
   * 合同归大脑；这里按派单字段发，UI 侧两种都识别。
   * @param {any} project
   * @param {{ hash: string, changed: boolean, by?: string, opId?: string }} event
   */
  function publishDocChanged(project, event) {
    hub.publish(
      /** @type {any} */ ({
        type: 'doc.changed',
        projectId: project.projectId,
        hash: event.hash,
        changed: event.changed === true,
        by: event.by ?? 'person',
        opId: event.opId ?? '',
      }),
    );
  }

  /**
   * 一批 Op：唯一写入口。同 `opId` 重放直接返回第一次的结果，不再落盘。
   * @param {string} projectId
   * @param {{ opId: string, expectedHash?: string, by?: 'person'|'agent', target?: any }} envelope
   * @param {readonly any[]} ops
   */
  async function applyOps(projectId, envelope, ops) {
    const project = projects.get(projectId);
    if (project === undefined) return { ok: false, code: 'NOT_FOUND', message: `工程未打开：${projectId}` };
    if (envelope === null || typeof envelope !== 'object') {
      return { ok: false, code: 'INVALID', message: '缺少 envelope' };
    }
    if (typeof envelope.opId !== 'string' || envelope.opId === '') {
      return { ok: false, code: 'INVALID', message: 'envelope.opId 必填' };
    }
    if (!Array.isArray(ops) || ops.length === 0) {
      return { ok: false, code: 'INVALID', message: 'ops 必须是非空数组' };
    }

    return serialize(project, async () => {
      const cached = project.opLog.get(envelope.opId);
      if (cached !== undefined) {
        return { ...cached, changed: false, replayed: true };
      }

      const stale = await refreshSession(project);
      if (stale !== null) return stale;

      const currentHash = project.session.sourceHash;
      if (typeof envelope.expectedHash === 'string' && envelope.expectedHash !== currentHash) {
        return { ok: false, code: 'CONFLICT', message: 'expectedHash 与当前不符，未写入', currentHash };
      }

      const by = envelope.by === 'agent' ? 'agent' : 'person';
      const result = await project.session.apply(ops, {
        opId: envelope.opId,
        by,
        ...(envelope.target === undefined ? {} : { target: envelope.target }),
      });
      if (result.ok !== true) {
        return {
          ok: false,
          code: result.error.code,
          message: result.error.message,
          ...(typeof result.error.currentHash === 'string' ? { currentHash: result.error.currentHash } : {}),
          ...(Array.isArray(result.error.violations) ? { violations: result.error.violations } : {}),
          ...(typeof result.error.status === 'number' ? { status: result.error.status } : {}),
          ...(result.error.detail === undefined ? {} : { detail: result.error.detail }),
        };
      }

      adoptSession(project, result.hash);
      const payload = {
        ok: true,
        hash: result.hash,
        changed: result.changed !== false,
        touched: result.touched ?? [],
        undoDepth: project.session.depths().undo,
        redoDepth: project.session.depths().redo,
        ...(result.element === undefined ? {} : { element: result.element }),
      };
      project.opLog.set(envelope.opId, payload);
      while (project.opLog.size > 200) {
        const oldest = project.opLog.keys().next();
        if (oldest.done === true) break;
        project.opLog.delete(oldest.value);
      }
      if (payload.changed) publishDocChanged(project, { ...payload, by, opId: envelope.opId });
      return payload;
    });
  }

  /**
   * 撤销 / 重做一批（以 Op 批为单位；不在这里做本地反演）。
   * @param {string} projectId
   * @param {'undo'|'redo'} kind
   * @param {{ expectedHash?: string }} [input]
   */
  async function stepHistory(projectId, kind, input = {}) {
    const project = projects.get(projectId);
    if (project === undefined) return { ok: false, code: 'NOT_FOUND', message: `工程未打开：${projectId}` };

    return serialize(project, async () => {
      const stale = await refreshSession(project);
      if (stale !== null) return stale;

      const currentHash = project.session.sourceHash;
      if (typeof input.expectedHash === 'string' && input.expectedHash !== currentHash) {
        return { ok: false, code: 'CONFLICT', message: 'expectedHash 与当前不符，未执行', currentHash };
      }
      const result = kind === 'undo' ? await project.session.undo() : await project.session.redo();
      if (result.ok !== true) {
        return {
          ok: false,
          code: result.error?.code ?? 'INVALID',
          message: String(result.error?.message ?? '历史操作失败'),
          ...(typeof result.error?.currentHash === 'string' ? { currentHash: result.error.currentHash } : {}),
        };
      }
      adoptSession(project, result.hash);
      const payload = {
        ok: true,
        hash: result.hash,
        changed: true,
        touched: [],
        undoDepth: project.session.depths().undo,
        redoDepth: project.session.depths().redo,
        ...(result.element === undefined ? {} : { element: result.element }),
      };
      // 撤销/重做也是一次成功写入：同样发 doc.changed。
      publishDocChanged(project, { ...payload, by: 'person', opId: kind });
      return payload;
    });
  }

  /** @param {string} projectId @param {{ expectedHash?: string }} [input] */
  async function undo(projectId, input = {}) {
    return stepHistory(projectId, 'undo', input);
  }

  /** @param {string} projectId @param {{ expectedHash?: string }} [input] */
  async function redo(projectId, input = {}) {
    return stepHistory(projectId, 'redo', input);
  }

  /** @param {string} projectId */
  function summary(projectId) {
    const project = projects.get(projectId);
    if (project === undefined) return null;
    return summarize(project, now);
  }

  function summarizeAll() {
    return [...projects.values()].map((project) => summarize(project, now));
  }

  /** @param {any} project */
  function clearThumbnails(project) {
    for (const item of project.thumbnails.items) {
      if (item.timer !== null) clearTimeout(item.timer);
    }
    project.thumbnails.items = [];
  }

  async function closeAll() {
    const ids = [...projects.keys()];
    const results = [];
    for (const id of ids) results.push(await close(id, { waitMs: 1000 }));
    return results;
  }

  return {
    open,
    close,
    closeAll,
    list,
    /** @param {string} projectId */
    get: (projectId) => projects.get(projectId) ?? null,
    summary,
    docOf,
    summaries: summarizeAll,
    write,
    applyOps,
    undo,
    redo,
    setView,
    setCwd,
    stats: () => ({ ...stats, open: projects.size }),
    /** @param {string} projectId */
    thumbnails: (projectId) => {
      const project = projects.get(projectId);
      if (project === undefined) return null;
      return thumbnailSummary(project);
    },
    /** @param {string} projectId @param {string[]|undefined} [clipIds] */
    requestThumbnails: (projectId, clipIds) => {
      const project = projects.get(projectId);
      if (project === undefined) return null;
      const only = Array.isArray(clipIds) && clipIds.length > 0 ? clipIds : undefined;
      for (const item of project.thumbnails.items) {
        if (only !== undefined && !only.includes(item.clipId)) continue;
        // 重新发起：状态回到 PENDING_FRAME，重新计时（本批没有 frame(t)，仍不会假成功）。
        if (item.timer !== null) clearTimeout(item.timer);
        const requestedAt = now();
        item.state = 'PENDING_FRAME';
        item.code = 'PENDING_FRAME';
        item.timedOut = false;
        item.requestedAt = requestedAt.toISOString();
        item.deadlineAt = new Date(requestedAt.getTime() + thumbnailTimeoutMs).toISOString();
        const timer = setTimeout(() => {
          item.state = 'TIMEOUT';
          item.code = 'THUMBNAIL_TIMEOUT';
          item.timedOut = true;
          item.timer = null;
        }, thumbnailTimeoutMs);
        timer.unref?.();
        item.timer = timer;
      }
      return thumbnailSummary(project, only);
    },
  };

  /**
   * 打开时对每个片段发一次缩略请求。本批没有 frame(t)：状态固定 PENDING_FRAME，
   * 超时后标记 TIMEOUT/THUMBNAIL_TIMEOUT（请求可观测，失败有码），不做假成功。
   * @param {string} projectId
   * @param {import('../../film-core/film-doc.mjs').FilmDoc} doc
   */
  function createThumbnails(projectId, doc) {
    const items = [];
    let index = 0;
    for (const track of doc.tracks) {
      for (const clip of track.clips) {
        index += 1;
        const requestedAt = now();
        const item = {
          id: `${projectId}:${clip.id}:${index}`,
          projectId,
          clipId: clip.id,
          src: clip.src,
          track: track.index,
          requestedAt: requestedAt.toISOString(),
          deadlineAt: new Date(requestedAt.getTime() + thumbnailTimeoutMs).toISOString(),
          state: /** @type {'PENDING_FRAME'|'TIMEOUT'} */ ('PENDING_FRAME'),
          code: 'PENDING_FRAME',
          timedOut: false,
          timer: /** @type {NodeJS.Timeout|null} */ (null),
        };
        const timer = setTimeout(() => {
          item.state = 'TIMEOUT';
          item.code = 'THUMBNAIL_TIMEOUT';
          item.timedOut = true;
          item.timer = null;
        }, thumbnailTimeoutMs);
        timer.unref?.();
        item.timer = timer;
        items.push(item);
      }
    }
    return { items, requested: items.length, frameConnected: false };
  }

  /** @param {any} project @param {string[]|undefined} [onlyIds] */
  function thumbnailSummary(project, onlyIds) {
    const items = project.thumbnails.items.filter((/** @type {any} */ item) => onlyIds === undefined || onlyIds.includes(item.clipId));
    /** @type {Record<string, number>} */
    const counts = { PENDING_FRAME: 0, TIMEOUT: 0 };
    for (const item of items) counts[item.state] = (counts[item.state] ?? 0) + 1;
    return {
      projectId: project.projectId,
      frameConnected: project.thumbnails.frameConnected,
      requested: items.length,
      pending: counts.PENDING_FRAME,
      timedOut: counts.TIMEOUT,
      items: items.map((/** @type {any} */ item) => ({
        id: item.id,
        clipId: item.clipId,
        state: item.state,
        code: item.code,
        requestedAt: item.requestedAt,
        deadlineAt: item.deadlineAt,
        timedOut: item.timedOut,
      })),
    };
  }
}

/**
 * @param {any} project
 * @param {() => Date} now
 */
function summarize(project, now) {
  const doc = project.doc;
  let clips = 0;
  let duration = 0;
  for (const track of doc.tracks) {
    clips += track.clips.length;
    for (const clip of track.clips) {
      if (!Array.isArray(clip.time)) continue;
      const speed = typeof clip.speed === 'number' && clip.speed > 0 ? clip.speed : 1;
      const span = (clip.time[1] - clip.time[0]) / speed;
      const at = typeof clip.at === 'number' ? clip.at : 0;
      if (Number.isFinite(span) && Number.isFinite(at)) duration = Math.max(duration, at + span);
    }
  }
  return {
    projectId: project.projectId,
    path: project.dir,
    filmPath: project.filmPath,
    name: project.dir.split(/[\\/]/).pop() ?? project.projectId,
    sourceHash: project.sourceHash,
    stage: { w: doc.stage.w, h: doc.stage.h },
    fps: { num: doc.fps.num, den: doc.fps.den },
    trackCount: doc.tracks.length,
    clipCount: clips,
    durationSec: Number(duration.toFixed(6)),
    diagnostics: project.diagnostics,
    view: { playhead: project.view.playhead, selection: project.view.selection, cwd: project.view.cwd },
    openedAt: project.openedAt,
    pendingWrites: project.queue.pending(),
    external: { lastAt: project.external.lastAt, lastHash: project.external.lastHash, count: project.external.count, error: project.external.error },
    thumbnails: {
      requested: project.thumbnails.items.length,
      pending: project.thumbnails.items.filter((/** @type {any} */ item) => item.state === 'PENDING_FRAME').length,
      timedOut: project.thumbnails.items.filter((/** @type {any} */ item) => item.state === 'TIMEOUT').length,
      frameConnected: project.thumbnails.frameConnected,
    },
    observedAt: now().toISOString(),
  };
}
