/**
 * 模板墙钟检查（副线1 · S31-MOTION-FRAME-T）
 *
 * ## 为什么要有它
 *
 * 模板里的动画如果由**墙钟**推进（`infinite` 自己转、`transition` 自己跑、`rAF` 自增、
 * 读 `performance.now()`），画面就不是 `frame(t)` 的函数：预览里暂停/拖时间轴不跟，
 * 导出按帧取图时第 N 帧拿到的是「当时恰好转到哪」——**同一工程两次导出不一样**。
 * 这跟 R11 修的 rVFC 暂停态 seek 是同一类问题，所以要有可执行的闸门，而不是靠人眼。
 *
 * ## 判定口径（关键）
 *
 * 被禁的是**自走**，不是**循环**：
 *
 * - `animation` 声明所在规则必须有 `animation-play-state: paused` —— 暂停的动画不会自己走，
 *   相位完全由 `animation-delay` 决定；
 * - 并且该规则要有 `animation-delay: … var(--motion-t) …` —— 否则「暂停」等于「冻在第 0 帧」，
 *   也谈不上 seek（`NOT_SEEKABLE`）；
 * - `animation-iteration-count: infinite` 在**已暂停且可 seek** 的前提下允许：它只是「相位按
 *   duration 取模」，`t` 与 `t+period` 天然一致。没暂停的 `infinite` 才是墙钟循环（`INFINITE_LOOP`）。
 * - `transition` 一律禁：它只能由状态变化触发、按墙钟推进，无法按 t 定位。
 *
 * ## 用法
 *
 * ```sh
 * node packages/motion/wall-clock-check.mjs                 # 扫包内 templates
 * node packages/motion/wall-clock-check.mjs <dir> [<dir>…]  # 扫任意目录
 * ```
 *
 * 命中打印 `文件:行:列 [CODE] 摘要`，退出码 1；干净退出码 0。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOTION_TIME_VAR } from './instance.mjs';

/** 稳定的规则码（宿主/CI 按码判断，不解析人话）。 */
export const WALL_CLOCK_RULES = Object.freeze({
  CLOCK_READ: 'CLOCK_READ',
  SELF_DRIVE: 'SELF_DRIVE',
  UNPAUSED_ANIMATION: 'UNPAUSED_ANIMATION',
  INFINITE_LOOP: 'INFINITE_LOOP',
  NOT_SEEKABLE: 'NOT_SEEKABLE',
  TRANSITION: 'TRANSITION',
  SMIL: 'SMIL',
  BAD_TIME_VAR: 'BAD_TIME_VAR'
});

/** 规则码 → 人话（CLI 与交接共用一份，不各写一套）。 */
export const RULE_LABELS = Object.freeze({
  CLOCK_READ: '读了墙钟（performance.now / Date.now / new Date）',
  SELF_DRIVE: '自驱推进（requestAnimationFrame / setTimeout / setInterval）',
  UNPAUSED_ANIMATION: 'animation 没有 animation-play-state: paused，会自己走',
  INFINITE_LOOP: 'animation 无限循环且未暂停，相位不受 t 控制',
  NOT_SEEKABLE: 'animation 已暂停但没有 animation-delay 读 --motion-t，冻在第 0 帧',
  TRANSITION: 'transition 按墙钟推进，无法按 t 定位',
  SMIL: 'SVG SMIL 动画自己走，不受 t 控制',
  BAD_TIME_VAR: '声明的时钟变量不是 --motion-t，宿主找不到入口'
});

const SCAN_EXT = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.svg']);

/**
 * @typedef {{rule: string, file: string, line: number, column: number, snippet: string, detail: string}} WallClockHit
 */

/** @param {string} text @param {number} index */
function lineOf(text, index) {
  let line = 1;
  let column = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

/** @param {string} text @param {number} [offsetBase] */
function stripCssComments(text, offsetBase = 0) {
  /* 保留换行与长度，行号/列号才能按原文本算 */
  return text.replace(/\/\*[\s\S]*?\*\//g, (match) => (offsetBase >= 0 ? match.replace(/[^\n]/g, ' ') : match));
}

/** @param {string} text @param {number} [offsetBase] */
function stripHtmlComments(text, offsetBase = 0) {
  return text.replace(/<!--[\s\S]*?-->/g, (match) => (offsetBase >= 0 ? match.replace(/[^\n]/g, ' ') : match));
}

/**
 * 拆 CSS 叶子块（body 里没有嵌套 `{}` 的块）。`@keyframes` 外层被跳过，内层 `0% {}` 是叶子。
 * @param {string} text
 * @returns {{selector: string, body: string, bodyStart: number}[]}
 */
function cssLeafBlocks(text) {
  /** @type {{selector: string, body: string, bodyStart: number}[]} */
  const out = [];
  /** @type {{preludeStart: number, bodyStart: number, nested: boolean}[]} */
  const stack = [];
  let lastBreak = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') {
      stack.push({ preludeStart: lastBreak, bodyStart: i + 1, nested: false });
      lastBreak = i + 1;
    } else if (ch === '}') {
      const top = stack.pop();
      if (top) {
        if (!top.nested) {
          out.push({
            selector: text.slice(top.preludeStart, top.bodyStart - 1).trim(),
            body: text.slice(top.bodyStart, i),
            bodyStart: top.bodyStart
          });
        }
        const parent = stack[stack.length - 1];
        if (parent) parent.nested = true;
      }
      lastBreak = i + 1;
    } else if (ch === ';' && stack.length === 0) {
      lastBreak = i + 1;
    }
  }
  return out;
}

/**
 * 拆声明（尊重 calc() 里的分号/冒号，虽然 CSS 里少见）。
 * @param {string} body
 * @param {number} bodyStart
 * @returns {{prop: string, value: string, at: number}[]}
 */
function splitDecls(body, bodyStart) {
  /** @type {{prop: string, value: string, at: number}[]} */
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= body.length; i += 1) {
    const ch = body[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if ((ch === ';' || i === body.length) && depth === 0) {
      const raw = body.slice(start, i);
      const colon = raw.indexOf(':');
      if (colon > 0) {
        out.push({
          prop: raw.slice(0, colon).trim().toLowerCase(),
          value: raw.slice(colon + 1).replace(/!important\s*$/i, '').trim(),
          at: bodyStart + start + colon + 1
        });
      }
      start = i + 1;
    }
  }
  return out;
}

/** @param {string} value 值里有没有 > 0 的时间（`0.2s` / `200ms`）。 */
function hasNonZeroTime(value) {
  for (const match of value.matchAll(/(-?\d*\.?\d+)\s*(m?s)\b/g)) {
    if (Math.abs(Number(match[1] ?? 0)) > 0) return true;
  }
  return false;
}

/**
 * 扫一段 CSS。
 * @param {string} css
 * @param {string} file
 * @param {number} [offsetBase] 这段 CSS 在文件里的起始偏移（`<style>` 块用）
 * @returns {WallClockHit[]}
 */
export function scanCss(css, file, offsetBase = 0) {
  const cleaned = stripCssComments(css, 0);
  /** @type {WallClockHit[]} */
  const hits = [];
  /** @param {number} index @param {string} rule @param {string} snippet @param {string} detail */
  const push = (index, rule, snippet, detail) => {
    const at = lineOf(cleaned, index);
    hits.push({ rule, file, line: at.line, column: at.column, snippet: snippet.slice(0, 160), detail });
  };

  for (const block of cssLeafBlocks(cleaned)) {
    const decls = splitDecls(block.body, block.bodyStart);
    const paused = decls.some((d) => d.prop === 'animation-play-state' && /\bpaused\b/.test(d.value));
    const seekDelay = decls.find((d) => d.prop === 'animation-delay' && /var\(\s*--motion-t/.test(d.value));

    for (const decl of decls) {
      if (decl.prop === 'transition' || decl.prop === 'transition-duration' || decl.prop === 'transition-property') {
        if (decl.prop === 'transition-property') continue;
        if (/\bnone\b/.test(decl.value) && decl.prop === 'transition') continue;
        if (hasNonZeroTime(decl.value)) {
          push(offsetBase + decl.at, WALL_CLOCK_RULES.TRANSITION, decl.value, `在 ${block.selector} 里：${decl.prop}: ${decl.value}`);
        }
        continue;
      }
      if (decl.prop === 'animation-iteration-count' && /\binfinite\b/.test(decl.value) && !paused) {
        push(offsetBase + decl.at, WALL_CLOCK_RULES.INFINITE_LOOP, decl.value, `在 ${block.selector} 里无限循环且未暂停`);
        continue;
      }
      if (decl.prop !== 'animation' && decl.prop !== 'animation-name') continue;
      if (/^\s*none\s*$/.test(decl.value)) continue;
      const infinite = /\binfinite\b/.test(decl.value);
      if (!paused) {
        push(
          offsetBase + decl.at,
          infinite ? WALL_CLOCK_RULES.INFINITE_LOOP : WALL_CLOCK_RULES.UNPAUSED_ANIMATION,
          decl.value,
          infinite
            ? `在 ${block.selector} 里无限循环且没有 animation-play-state: paused`
            : `在 ${block.selector} 里没有 animation-play-state: paused，会按墙钟推进`
        );
        continue;
      }
      if (!seekDelay) {
        push(offsetBase + decl.at, WALL_CLOCK_RULES.NOT_SEEKABLE, decl.value, `在 ${block.selector} 里已暂停但 animation-delay 没读 var(--motion-t)`);
      }
    }
  }
  return hits;
}

/**
 * 扫一段 HTML/SVG/JS：墙钟读取、自驱推进、SMIL。
 * @param {string} text
 * @param {string} file
 * @returns {WallClockHit[]}
 */
export function scanMarkup(text, file) {
  const cleaned = stripHtmlComments(text, 0);
  /** @type {{re: RegExp, rule: string, detail: string}[]} */
  const patterns = [
    { re: /\bperformance\s*\.\s*now\s*\(/g, rule: WALL_CLOCK_RULES.CLOCK_READ, detail: 'performance.now()' },
    { re: /\bDate\s*\.\s*now\s*\(/g, rule: WALL_CLOCK_RULES.CLOCK_READ, detail: 'Date.now()' },
    { re: /\bnew\s+Date\s*\(/g, rule: WALL_CLOCK_RULES.CLOCK_READ, detail: 'new Date()' },
    { re: /\brequestAnimationFrame\s*\(/g, rule: WALL_CLOCK_RULES.SELF_DRIVE, detail: 'requestAnimationFrame()' },
    { re: /\bsetInterval\s*\(/g, rule: WALL_CLOCK_RULES.SELF_DRIVE, detail: 'setInterval()' },
    { re: /\bsetTimeout\s*\(/g, rule: WALL_CLOCK_RULES.SELF_DRIVE, detail: 'setTimeout()' },
    { re: /<\s*(?:animate|animateTransform|animateMotion|set)\b/g, rule: WALL_CLOCK_RULES.SMIL, detail: 'SVG SMIL 动画' }
  ];
  /** @type {WallClockHit[]} */
  const hits = [];
  for (const { re, rule, detail } of patterns) {
    for (const match of cleaned.matchAll(re)) {
      const at = lineOf(cleaned, match.index ?? 0);
      hits.push({
        rule,
        file,
        line: at.line,
        column: at.column,
        snippet: cleaned.slice(match.index ?? 0, (match.index ?? 0) + 80).split('\n')[0] ?? '',
        detail
      });
    }
  }
  return hits;
}

/**
 * 按扩展名分派（`.html` 同时扫内联 `<style>`）。
 * @param {string} text
 * @param {{file?: string}} [opts]
 * @returns {WallClockHit[]}
 */
export function scanSource(text, opts = {}) {
  const file = opts.file ?? '<inline>';
  const ext = path.extname(file).toLowerCase();
  if (ext === '.css') return scanCss(text, file);
  if (ext === '.js' || ext === '.mjs' || ext === '.svg') return scanMarkup(text, file);
  if (ext !== '.html' && ext !== '.htm') return [];
  /** @type {WallClockHit[]} */
  const hits = [...scanMarkup(text, file)];
  for (const match of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    const bodyStart = (match.index ?? 0) + match[0].indexOf('>') + 1;
    hits.push(...scanCss(match[1] ?? '', file, bodyStart));
  }
  return hits;
}

/**
 * 入口 HTML 里 `link` 的本地样式表（相对路径、非网络、非 data:）。
 * @param {string} html
 * @returns {string[]}
 */
export function linkedStylesheets(html) {
  /** @type {string[]} */
  const out = [];
  for (const match of html.matchAll(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi)) {
    const href = match[1] ?? '';
    if (!href || /^(?:https?:)?\/\//.test(href) || href.startsWith('data:')) continue;
    out.push(href);
  }
  return out;
}

/**
 * 扫一份模板入口，**连它 link 的样式表一起**（墙钟通常写在 CSS 里，只看 HTML 会漏）。
 *
 * 局限（写进交接的 unverified）：只跟同目录的相对 `link`，不跟 `@import`、不跟 JS 里动态拼的 URL。
 *
 * 返回值带 `missing`：**读不到的样式表**要如实报出来——扫不到就不能断言「没有墙钟」，
 * 调用方据此给 `deterministic` 留空（unknown），而不是默认成 true。
 *
 * @param {string} root 工程根
 * @param {string} rel 入口相对路径
 * @param {string} [html] 已经读好的入口文本（省一次读盘）
 * @returns {Promise<{hits: WallClockHit[], missing: string[]}>}
 */
export async function scanLinked(root, rel, html) {
  const text = html ?? (await fs.readFile(path.join(root, rel), 'utf8'));
  /** @type {WallClockHit[]} */
  const hits = [...scanSource(text, { file: rel })];
  /** @type {string[]} */
  const missing = [];
  const dir = path.dirname(path.join(root, rel));
  for (const href of linkedStylesheets(text)) {
    try {
      const css = await fs.readFile(path.resolve(dir, href), 'utf8');
      const cssRel = path.relative(root, path.resolve(dir, href)).split(path.sep).join('/');
      hits.push(...scanSource(css, { file: cssRel }));
    } catch {
      /* 缺资产由 checkAssets/validateLibrary 报；这里只记「没扫到」，不假装扫过 */
      missing.push(href);
    }
  }
  return { hits, missing };
}

/**
 * 递归扫一个目录（只看 `TEMPLATE_EXTS`）。
 * @param {string} dir
 * @returns {Promise<{ok: boolean, dir: string, files: string[], hits: WallClockHit[], infos: {file: string, timeVar: boolean, animations: number}[]}>}
 */
export async function scanTemplates(dir) {
  const root = path.resolve(dir);
  /** @type {string[]} */
  const files = [];
  /** @param {string} current */
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (SCAN_EXT.has(path.extname(entry.name).toLowerCase())) files.push(full);
    }
  }
  await walk(root);

  /** @type {WallClockHit[]} */
  const hits = [];
  /** @type {{file: string, timeVar: boolean, animations: number}[]} */
  const infos = [];
  for (const full of files) {
    const text = await fs.readFile(full, 'utf8');
    const rel = path.relative(path.dirname(root), full).split(path.sep).join('/');
    hits.push(...scanSource(text, { file: rel }));
    const ext = path.extname(full).toLowerCase();
    if (ext !== '.html' && ext !== '.htm') continue;
    /* 入口 HTML 要连它 link 的样式表一起看：`--motion-t` 通常写在 CSS 里 */
    let combined = text;
    for (const match of text.matchAll(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi)) {
      const href = match[1] ?? '';
      if (/^(?:https?:)?\/\//.test(href) || href.startsWith('data:')) continue;
      try {
        combined += '\n' + (await fs.readFile(path.resolve(path.dirname(full), href), 'utf8'));
      } catch {
        /* 缺资产由 validateLibrary 报，这里不管 */
      }
    }
    infos.push({ file: rel, timeVar: /var\(\s*--motion-t/.test(combined), animations: (combined.match(/(?:^|[;{\s])animation\s*:/g) ?? []).length });

    /* `<meta name="motion-clock" content="--motion-t;unit=ms">` 若声明了别的变量名，
       宿主按约定写 --motion-t 就落不到这套模板上——必须报出来。 */
    const meta = text.match(/<meta\b[^>]*name=["']motion-clock["'][^>]*>/i);
    if (meta) {
      const declared = (meta[0].match(/content=["']([^"']*)["']/i)?.[1] ?? '').split(';')[0]?.trim() ?? '';
      if (declared && declared !== MOTION_TIME_VAR) {
        const at = lineOf(text, meta.index ?? 0);
        hits.push({
          rule: WALL_CLOCK_RULES.BAD_TIME_VAR,
          file: rel,
          line: at.line,
          column: at.column,
          snippet: meta[0].slice(0, 160),
          detail: `声明的是 ${declared}，约定是 ${MOTION_TIME_VAR}`
        });
      }
    }
  }
  return { ok: hits.length === 0, dir: root, files: files.map((full) => path.relative(path.dirname(root), full).split(path.sep).join('/')), hits, infos };
}

/**
 * CLI：命中打印 `文件:行:列 [CODE] 摘要`，退出码 1。
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function wallClockCli(argv) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dirs = argv.length ? argv : [path.join(here, 'templates')];
  let failed = false;
  for (const dir of dirs) {
    const result = await scanTemplates(dir);
    if (!result.ok) failed = true;
    console.log(`扫描 ${path.relative(process.cwd(), result.dir) || '.'}：${result.files.length} 个文件，命中 ${result.hits.length} 条`);
    for (const info of result.infos) {
      console.log(`  · ${info.file}：animation 声明 ${info.animations} 处，读 --motion-t ${info.timeVar ? '是' : '否'}`);
    }
    for (const hit of result.hits) {
      const label = /** @type {Record<string, string>} */ (RULE_LABELS)[hit.rule] ?? hit.rule;
      console.log(`  ${hit.file}:${hit.line}:${hit.column} [${hit.rule}] ${label} —— ${hit.detail}`);
    }
  }
  console.log(failed ? '结论：有命中，模板不是 t 的函数' : '结论：0 命中，模板画面只由 --motion-t 决定');
  return failed ? 1 : 0;
}

const isMain = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isMain) {
  process.exitCode = await wallClockCli(process.argv.slice(2));
}
