/**
 * CLI 测试用 film 端口 —— 用本树 `packages/film-core` 的真实解析器。
 *
 * 这不是产品接线：只是让 `export film` 的 CLI 路径能在测试里跑起来。
 * 生产上由 `--film-module` 注入主线实现；没有注入时 CLI 报 `WAIT_MAIN_FILM`。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { parse } from '../../../film-core/film-doc.mjs';

export function createFilmPort() {
  return {
    /**
     * @param {string} project
     */
    async read(project) {
      const file = path.join(project, 'film.html');
      const text = await fs.readFile(file, 'utf8');
      const result = parse(text, { path: 'film.html' });
      return { doc: result.doc, diagnostics: result.diagnostics, sourceHash: result.sourceHash };
    },
  };
}
