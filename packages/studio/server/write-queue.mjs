/**
 * 每工程串行写队列（合同 contracts/edit-ops.ts）。
 *
 * 三条语义：
 * - 串行：同一 projectId 的写不会并发；跨工程并行（每工程一个实例，不共享锁）。
 * - 幂等：同一 opId 重放返回首次结果，不重复落盘。
 * - CAS：由 `FilmDocIo.commit()` 判定，队列自己不再拿哈希猜；`write()` 只负责纯编辑。
 *
 * 事件（contracts/events.ts）：成功 → `film.changed` + `history.moved`；
 * 冲突/非法 → `film.writeRejected`；竞态冲突 → 额外 `film.conflict`。
 */

import { sha256 as hashText, write as writeFilm } from '../../film-core/film-doc.mjs';

/** @typedef {'person'|'agent'|'external'|'system'} EventSource */
/**
 * @typedef {{
 *   opId: string,
 *   expectedHash: string,
 *   edits: readonly { clipId: string, field: string, value: unknown }[],
 *   by?: EventSource,
 * }} WriteJob
 * @typedef {{
 *   ok: boolean,
 *   hash?: string,
 *   text?: string,
 *   changed?: boolean,
 *   error?: { code: string, message: string, currentHash?: string, opId?: string },
 *   history?: { ok: boolean, code?: string, message?: string, commit?: string },
 * }} QueueResult
 */

/**
 * @param {{
 *   projectId: string,
 *   projectDir: string,
 *   filmPath: string,
 *   io: ReturnType<typeof import('./film-io.mjs').createFilmDocIo>,
 *   hub?: { publish: (event: any) => number },
 *   hooks?: { beforeRun?: (job: WriteJob) => Promise<void>|void, afterCommit?: (info: { hash: string, text: string }) => Promise<void>|void },
 *   history?: boolean,
 * }} options
 */
export function createWriteQueue(options) {
  const { projectId, projectDir, filmPath, io, hub } = options;
  const hooks = options.hooks ?? {};
  const withHistory = options.history !== false;

  /** @type {Promise<void>} */
  let tail = Promise.resolve();
  /** @type {Map<string, QueueResult>} */
  const applied = new Map();
  let pending = 0;
  let closed = false;
  /** @type {Set<() => void>} */
  const idleWaiters = new Set();

  /** @param {any} event */
  function publish(event) {
    if (hub === undefined) return;
    try {
      hub.publish(event);
    } catch {
      // 事件通道故障不能影响落盘；调用方以 film.read 为权威。
    }
  }

  /**
   * @param {string} code
   * @param {string} message
   * @param {{ expectedHash?: string, actualHash?: string }} [extra]
   */
  function reportRejected(code, message, extra = {}) {
    publish({
      type: 'film.writeRejected',
      projectId,
      code,
      ...extra,
    });
    return message;
  }

  /**
   * @param {WriteJob} job
   * @returns {Promise<QueueResult>}
   */
  async function run(job) {
    await hooks.beforeRun?.(job);
    if (closed) {
      return { ok: false, error: { code: 'QUEUE_TIMEOUT', message: '工程已关闭，写被明确取消', opId: job.opId } };
    }

    /** @type {{ text: string, sourceHash: string }} */
    let read;
    try {
      read = await io.read(filmPath);
    } catch (error) {
      const message = reportRejected('IO', `读取失败：${String(/** @type {Error} */ (error).message)}`);
      return { ok: false, error: { code: 'IO', message, opId: job.opId } };
    }

    const written = writeFilm(read.text, job.edits, job.expectedHash);
    if (written.ok !== true || typeof written.text !== 'string') {
      const code = written.code === 'CONFLICT' ? 'CONFLICT' : 'INVALID';
      const message = (written.diagnostics ?? [])
        .map((/** @type {any} */ diag) => `${diag.code}: ${diag.message}`)
        .join('; ') || '写回被拒绝';
      reportRejected(code, message, {
        expectedHash: job.expectedHash,
        actualHash: read.sourceHash,
      });
      if (code === 'CONFLICT') {
        // 旧 baseHash：没有「Agent 原写文本」可存（编辑基于调用方手里的旧版本），
        // 至少把请求与两个哈希留下，能追溯是哪一版被拒。
        const kept = await io.keepConflict({
          projectDir,
          edits: job.edits,
          opId: job.opId,
          expectedHash: job.expectedHash,
          actualHash: read.sourceHash,
        });
        publish({
          type: 'film.conflict',
          projectId,
          sourceHash: read.sourceHash,
          keptAside: kept.ok ? kept.files[0] ?? kept.dir : '',
          keys: job.edits.map((edit) => `${edit.clipId}.${edit.field}`),
        });
      }
      return { ok: false, error: { code, message, currentHash: read.sourceHash, opId: job.opId } };
    }

    if (written.changed === false) {
      return { ok: true, hash: String(written.sourceHash), text: written.text, changed: false };
    }

    const committed = await io.commit(filmPath, written.text, job.expectedHash);
    if (committed.ok !== true) {
      if (committed.code === 'CONFLICT') {
        const kept = await io.keepConflict({
          projectDir,
          text: written.text,
          edits: job.edits,
          opId: job.opId,
          expectedHash: job.expectedHash,
          actualHash: committed.actualHash,
        });
        publish({
          type: 'film.conflict',
          projectId,
          sourceHash: String(committed.actualHash ?? ''),
          keptAside: kept.ok ? kept.files[0] ?? kept.dir : '',
          keys: job.edits.map((edit) => `${edit.clipId}.${edit.field}`),
        });
        const message = reportRejected('CONFLICT', 'CAS 失败：磁盘内容已被改动，Agent 原写已另存', {
          expectedHash: job.expectedHash,
          actualHash: committed.actualHash,
        });
        return {
          ok: false,
          error: { code: 'CONFLICT', message, currentHash: committed.actualHash, opId: job.opId },
        };
      }
      const message = reportRejected('IO', String(committed.message ?? '写入失败'));
      return { ok: false, error: { code: 'IO', message, opId: job.opId } };
    }

    // 先让上层把投影更新到新 hash，再发事件：避免 fs.watch 把「自己的写」误报成 external。
    await hooks.afterCommit?.({ hash: committed.sourceHash, text: written.text });

    /** @type {QueueResult} */
    const result = {
      ok: true,
      hash: committed.sourceHash,
      text: written.text,
      changed: true,
    };

    if (withHistory) {
      const snapshot = await io.snapshot({
        projectDir,
        text: written.text,
        sourceHash: committed.sourceHash,
        prevSourceHash: String(written.prevSourceHash ?? ''),
        opId: job.opId,
        projectId,
      });
      result.history = snapshot.ok
        ? { ok: true, commit: snapshot.commit }
        : { ok: false, code: snapshot.code, message: snapshot.message };
      if (snapshot.ok) {
        publish({
          type: 'history.moved',
          projectId,
          version: String(committed.sourceHash).slice(0, 12),
          kind: 'commit',
        });
      }
    }

    publish({
      type: 'film.changed',
      projectId,
      sourceHash: committed.sourceHash,
      by: job.by ?? 'person',
    });
    return result;
  }

  /**
   * 入队；同工程串行。
   * @param {WriteJob} job
   * @returns {Promise<QueueResult>}
   */
  function submit(job) {
    const key = `${projectId}\u0000${job.opId}`;
    const cached = applied.get(key);
    if (cached !== undefined) {
      // 幂等重放：返回首次结果，不重复落盘、不重复发事件。
      return Promise.resolve({ ...cached, replayed: true });
    }
    if (closed) {
      return Promise.resolve({
        ok: false,
        error: { code: 'QUEUE_TIMEOUT', message: '工程已关闭，写被明确取消', opId: job.opId },
      });
    }

    pending += 1;
    const next = tail.then(
      () => run(job),
      () => run(job),
    );
    const settled = next.then(
      (result) => {
        if (result.ok === true || (result.error !== undefined && result.error.code !== 'QUEUE_TIMEOUT')) {
          applied.set(key, result);
        }
        return result;
      },
      (error) => {
        const result = {
          ok: false,
          error: { code: 'IO', message: String(/** @type {Error} */ (error)?.message ?? error), opId: job.opId },
        };
        applied.set(key, result);
        return result;
      },
    );
    tail = settled.then(() => undefined, () => undefined);
    // 计数归零后再唤醒 idle() 等待者。
    settled.finally(() => {
      pending -= 1;
      if (pending === 0) {
        for (const waiter of idleWaiters) waiter();
        idleWaiters.clear();
      }
    });
    return settled;
  }

  /** @returns {Promise<{ drained: boolean, pending: number }>} */
  function idle() {
    if (pending === 0) return Promise.resolve({ drained: true, pending: 0 });
    return new Promise((resolve) => {
      idleWaiters.add(() => resolve({ drained: true, pending }));
    });
  }

  /** 明确关闭：已入队未开始的写在 run() 处被拒为 QUEUE_TIMEOUT，不静默丢。 */
  function close() {
    closed = true;
  }

  return {
    projectId,
    filmPath,
    submit,
    idle,
    close,
    isClosed: () => closed,
    pending: () => pending,
    appliedCount: () => applied.size,
  };
}

/** 供测试/调用方复用的哈希（避免两套实现）。 */
export { hashText };
export { writeFilm };
