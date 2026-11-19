/**
 * 真实 film 端口（M74 · WP18 的集成缝）。
 *
 * CLI / MCP 都只认这一层契约：
 *
 *   read(project)                    → { ok, sourceHash, doc, diagnostics }
 *   applyOps(project, envelope, ops) → { ok, hash, touched, changed }
 *
 * 在这之前这两个方法只存在于测试桩里：`packages/cli/bin.mjs` 默认 `WAIT_MAIN_FILM`，
 * 从没有人拿真实 `film-core` 跑过一遍 CLI。这个文件就是那次「接线」——
 * 解析、Op 演算、写回补丁全部复用 `packages/film-core`，端口自己不加业务规则。
 *
 * ## 写盘规格
 *
 * 与 Studio 的 `film-io` 同一套语义：CAS（expectedHash）→ 补丁 → 同目录临时文件 →
 * fsync → rename → **回读校验 sha256**。`writeValue` 说内容没变时**不落盘**
 * （这是「同一 Op 第二次不产生写」的底层保证，M74 的 `只发生一次写` 就靠它）。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { parse, writeValue } from '../../film-core/film-doc.mjs';
import { applyOpsDetailed } from '../../film-core/ops.mjs';

/** @param {string|Buffer} data */
function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** @param {unknown} error */
function codeOf(error) {
  const code = /** @type {any} */ (error)?.code;
  return typeof code === 'string' && code !== '' ? code : 'INVALID';
}

/**
 * 原子写：同目录临时文件 → fsync → rename。
 * @param {string} file @param {string} text
 */
async function writeAtomic(file, text) {
  const dir = path.dirname(file);
  const temp = path.join(dir, `${path.basename(file)}.tmp-${String(process.pid)}-${Math.random().toString(36).slice(2, 8)}`);
  /** @type {import('node:fs/promises').FileHandle|null} */
  let handle = null;
  try {
    handle = await fs.open(temp, 'wx');
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temp, file);
  } catch (error) {
    if (handle !== null) await handle.close().catch(() => undefined);
    await fs.unlink(temp).catch(() => undefined);
    throw error;
  }
}

/**
 * @param {{ root?: string, env?: Record<string, any>, cwd?: string }} [ctx]
 */
export function createFilmPort(ctx = {}) {
  /** @param {string} projectDir */
  const filmPathOf = (projectDir) => path.join(projectDir, 'film.html');

  /**
   * 读 film.html。缺文件 → `NOT_FOUND`；解析不出 doc → `INVALID_FILM`（PARSE 类）。
   * @param {string} projectDir
   */
  async function read(projectDir) {
    const filmPath = filmPathOf(projectDir);
    let text;
    try {
      text = await fs.readFile(filmPath, 'utf8');
    } catch (error) {
      const missing = /** @type {any} */ (error)?.code === 'ENOENT';
      return {
        ok: false,
        error: {
          code: missing ? 'NOT_FOUND' : 'IO',
          message: `${filmPath}: ${String(/** @type {any} */ (error)?.message ?? error)}`,
        },
      };
    }
    const parsed = parse(text, { path: filmPath });
    if (parsed.doc === null) {
      const first = (parsed.diagnostics ?? []).find((item) => item.severity === 'error') ?? null;
      return {
        ok: false,
        error: {
          code: 'INVALID_FILM',
          message: `film.html 解析失败：${first?.code ?? 'PARSE'}: ${first?.message ?? '没有可用的 FilmDoc'}`,
          ...(first ? { reason: String(first.code ?? 'PARSE') } : {}),
        },
        diagnostics: parsed.diagnostics ?? [],
      };
    }
    return { ok: true, sourceHash: sha256(text), doc: parsed.doc, diagnostics: parsed.diagnostics ?? [] };
  }

  /**
   * 应用一批 Op。CAS 在**读盘之后、写盘之前**再核一次（别的进程可能刚写过）。
   * @param {string} projectDir
   * @param {{ opId: string, expectedHash: string, batchId?: string, owner?: string }} envelope
   * @param {any[]} ops
   */
  async function applyOps(projectDir, envelope, ops) {
    const filmPath = filmPathOf(projectDir);
    const text = await fs.readFile(filmPath, 'utf8').catch((error) => {
      throw Object.assign(new Error(`${filmPath}: ${String(/** @type {any} */ (error)?.message ?? error)}`), {
        code: /** @type {any} */ (error)?.code === 'ENOENT' ? 'NOT_FOUND' : 'IO',
      });
    });
    const before = sha256(text);
    if (before !== envelope.expectedHash) {
      return {
        ok: false,
        error: { code: 'CONFLICT', message: 'expectedHash 与当前 film.html 不符', currentHash: before },
      };
    }

    const parsed = parse(text, { path: filmPath });
    if (parsed.doc === null) {
      const first = (parsed.diagnostics ?? []).find((item) => item.severity === 'error') ?? null;
      return {
        ok: false,
        error: {
          code: 'INVALID_FILM',
          message: `film.html 解析失败：${first?.code ?? 'PARSE'}: ${first?.message ?? '没有可用的 FilmDoc'}`,
        },
      };
    }

    /** @type {{ value: any, touched: string[] }} */
    let applied;
    try {
      applied = applyOpsDetailed(parsed.doc, ops);
    } catch (error) {
      const code = codeOf(error);
      return {
        ok: false,
        error: {
          code: code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INVALID',
          message: String(/** @type {any} */ (error)?.message ?? error),
        },
      };
    }

    const written = writeValue(text, applied.value, before);
    if (written?.ok !== true) {
      const first = (written?.diagnostics ?? []).find((/** @type {any} */ item) => item.severity === 'error') ?? null;
      return {
        ok: false,
        error: {
          code: written?.code ?? 'INVALID',
          message: String(first?.message ?? '写回失败'),
        },
      };
    }
    // 内容没变（同一 Op 第二次）：**不落盘**，返回同一个 hash。
    if (written.changed !== true) {
      return { ok: true, hash: before, touched: applied.touched ?? [], changed: false };
    }

    // 读之后、写之前再核一次 CAS：并发写不能靠「刚才读过」来担保。
    const currentText = await fs.readFile(filmPath, 'utf8');
    const current = sha256(currentText);
    if (current !== before) {
      return {
        ok: false,
        error: { code: 'CONFLICT', message: 'film.html 在读取后被改动', currentHash: current },
      };
    }

    try {
      await writeAtomic(filmPath, written.text);
    } catch (error) {
      return {
        ok: false,
        error: { code: 'IO', message: `写 film.html 失败：${String(/** @type {any} */ (error)?.message ?? error)}` },
      };
    }

    const back = await fs.readFile(filmPath, 'utf8');
    if (sha256(back) !== written.sourceHash) {
      return { ok: false, error: { code: 'IO', message: '回读校验失败：写入内容与预期 sha256 不一致' } };
    }
    return {
      ok: true,
      hash: written.sourceHash,
      touched: applied.touched ?? [],
      changed: true,
      bytes: Buffer.byteLength(back, 'utf8'),
    };
  }

  return { read, applyOps, propose, filmPathOf };
}

/**
 * 只读提案：把 Op 批在**内存里**演算一遍，回 `{ok, sourceHash, touched, inverse, changed}`。
 *
 * 用途（CS2 · R30-125）：ACP agent 在 GUI 里点「应用」之前，要能先确认「这批 Op 合不合法、
 * 会改到哪些片段」。它**不写盘**，也不产生 opId 账本记录；真正的写入仍只走 `applyOps`
 * / Studio 的 `/ops`。`changed:false` 表示这批 Op 等价于没改（例如把 text 设成原值）。
 *
 * @param {string} projectDir
 * @param {{ expectedHash?: string }} envelope
 * @param {any[]} ops
 */
async function propose(projectDir, envelope, ops) {
  // 注意：这个函数在工厂**外面**，拿不到闭包里的 filmPathOf —— 直接拼，别引用。
  const filmPath = path.join(projectDir, 'film.html');
  const text = await fs.readFile(filmPath, 'utf8').catch((error) => {
    throw Object.assign(new Error(`${filmPath}: ${String(/** @type {any} */ (error)?.message ?? error)}`), {
      code: /** @type {any} */ (error)?.code === 'ENOENT' ? 'NOT_FOUND' : 'IO',
    });
  });
  const before = sha256(text);
  if (typeof envelope?.expectedHash === 'string' && envelope.expectedHash !== before) {
    return { ok: false, error: { code: 'CONFLICT', message: 'expectedHash 与当前 film.html 不符', currentHash: before } };
  }
  const parsed = parse(text, { path: filmPath });
  if (parsed.doc === null) {
    const first = (parsed.diagnostics ?? []).find((item) => item.severity === 'error') ?? null;
    return {
      ok: false,
      error: { code: 'INVALID_FILM', message: `film.html 解析失败：${first?.code ?? 'PARSE'}: ${first?.message ?? '没有可用的 FilmDoc'}` },
    };
  }
  /** @type {{ value: any, touched: string[], inverse: any[] }} */
  let applied;
  try {
    applied = applyOpsDetailed(parsed.doc, ops);
  } catch (error) {
    return { ok: false, error: { code: codeOf(error) === 'NOT_FOUND' ? 'NOT_FOUND' : 'INVALID', message: String(/** @type {any} */ (error)?.message ?? error) } };
  }
  const written = writeValue(text, applied.value, before);
  return {
    ok: true,
    sourceHash: before,
    touched: applied.touched ?? [],
    inverse: applied.inverse ?? [],
    changed: written?.ok === true ? written.changed === true : true,
    ...(written?.ok === true ? { nextHash: String(written.sourceHash) } : {}),
  };
}

export default createFilmPort;
