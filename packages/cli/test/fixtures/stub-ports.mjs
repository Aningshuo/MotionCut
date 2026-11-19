/**
 * 测试用 film 端口桩（**STUB，不是实现**）。
 *
 * 本树没有 main 的 `film-core`，WP18 又不许写第二套解析器，所以这里只做两件事：
 * 1. `read()`：真实读取 `<project>/film.html` 的字节并算 sha256（哈希是真的），
 *    `doc` 是一份**固定文档**（明确标注：不是从 film.html 解析出来的）。
 * 2. `applyOps()`：只认一种 Op —— `{op:'set', field:'title', value}`，把
 *    `<title>…</title>` 原地换掉并原子落盘（字节确实变了、哈希确实变了）。
 *    其它 Op 一律 INVALID，绝不假装成功。
 *
 * 真实接线：main 的 `FilmDocIo` + 写队列，在集成时由大脑用 `--film-module` 注入。
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** @param {Buffer | string} data */
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

const FIXED_DOC = {
  stage: { w: 1920, h: 1080 },
  fps: { num: 30, den: 1 },
  tracks: [
    { index: 0, role: 'picture', name: 'V1', clips: [{ id: 'clip-a', src: 'assets/a.mp4', at: 0 }, { id: 'clip-b', src: 'assets/b.png', at: 2 }] },
    { index: 1, role: 'audio', name: 'A1', clips: [{ id: 'clip-c', src: 'assets/tone.wav', at: 0 }] },
  ],
};

/**
 * @param {string} project
 * @returns {Promise<{ text: string, sourceHash: string }>}
 */
async function readFilm(project) {
  const file = path.join(project, 'film.html');
  const buf = await fs.readFile(file);
  return { text: buf.toString('utf8'), sourceHash: sha256(buf) };
}

/**
 * @param {{ root?: string }} [ctx]
 */
export function createFilmPort(ctx = {}) {
  return {
    /**
     * @param {string} project
     */
    async read(project) {
      const { sourceHash } = await readFilm(project);
      return {
        doc: FIXED_DOC,
        diagnostics: [],
        sourceHash,
        stub: 'FIXED_DOC (not parsed from film.html)',
      };
    },

    /**
     * @param {string} project
     * @param {{ expectedHash: string, opId: string }} envelope
     * @param {Array<{ op: string, field?: string, value?: unknown }>} ops
     */
    async applyOps(project, envelope, ops) {
      const { text, sourceHash } = await readFilm(project);
      if (sourceHash !== envelope.expectedHash) {
        return {
          ok: false,
          error: {
            code: 'CONFLICT',
            message: 'expectedHash does not match current film.html',
            currentHash: sourceHash,
            opId: envelope.opId,
          },
        };
      }

      let next = text;
      const touched = [];
      for (const op of ops) {
        if (op?.op !== 'set' || op.field !== 'title') {
          return {
            ok: false,
            error: {
              code: 'INVALID',
              message: `STUB supports only {op:'set', field:'title'}; got ${JSON.stringify(op)}`,
              opId: envelope.opId,
            },
          };
        }
        const value = String(op.value ?? '').replace(/[<>]/g, '');
        if (!/<title>[\s\S]*?<\/title>/.test(next)) {
          return { ok: false, error: { code: 'NOT_FOUND', message: 'no <title> in fixture', opId: envelope.opId } };
        }
        next = next.replace(/<title>[\s\S]*?<\/title>/, `<title>${value}</title>`);
        touched.push('title');
      }

      const tmp = `${path.join(project, 'film.html')}.${process.pid}.tmp`;
      await fs.writeFile(tmp, next, 'utf8');
      await fs.rename(tmp, path.join(project, 'film.html'));

      return { ok: true, hash: sha256(Buffer.from(next, 'utf8')), touched };
    },
  };
}

/** @param {{ root?: string }} [ctx] */
export function createProjectsPort(ctx = {}) {
  const root = ctx.root ?? process.cwd();
  return {
    async list() {
      const entries = await fs.readdir(root, { withFileTypes: true });
      /** @type {Array<{ id: string, name: string, path: string }>} */
      const out = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(root, entry.name);
        try {
          await fs.access(path.join(dir, 'film.html'));
          out.push({ id: entry.name, name: entry.name, path: dir });
        } catch {
          /* 不是工程目录，跳过：这里只是测试桩的扫描，不承担工程发现语义 */
        }
      }
      return out.sort((a, b) => a.id.localeCompare(b.id));
    },
  };
}

/** bin.mjs 的注入契约：一个模块给三个端口。 */
export function createPorts(ctx = {}) {
  return { projects: createProjectsPort(ctx), film: createFilmPort(ctx) };
}
