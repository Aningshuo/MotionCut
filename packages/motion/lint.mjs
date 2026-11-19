/**
 * 模板自检（副线1 · S36-TEMPLATE-LINT，接口由大脑冻结）
 *
 * 目的：**发布前把「导出来动效不动」的模板挡住**，而不是等用户导出后发现画面是死的。
 *
 * 判据来自一条很硬的事实：导出的每一帧只把 `--motion-t` 写进页面（S31/S33），
 * 所以**画面必须只是 `--motion-t` 的函数**。任何自己会走的东西——未暂停的 CSS 动画、
 * `transition`、`setTimeout`、SMIL、`<canvas>` 自绘、`requestAnimationFrame` 改样式——
 * 都会让「同一 t 两次渲染不一致」，必须报出来。
 *
 * 与既有件的关系（不重写规则）：
 * - 墙钟：`wall-clock-check.mjs` 的 `scanLinked`（连 `link` 的样式表一起扫）
 * - 参数标注与值域：`discover.mjs` 的 `discoverControls`（它内部用 `params.mjs` 的 `validateSchema`）
 * - 这里只补它俩不管的：SMIL / canvas / rAF、未标注的 CSS 变量、缺资产、时钟 meta 与单位。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanLinked, linkedStylesheets } from './wall-clock-check.mjs';
import { discoverControls, DISCOVERY_ERROR_CODES } from './discover.mjs';
import { applyOf } from './params.mjs';

/** issue 的稳定码。文案可以改，这些不能。 */
export const LINT_CODES = Object.freeze({
  WALL_CLOCK: 'WALL_CLOCK',
  NON_CSS_ANIMATION: 'NON_CSS_ANIMATION',
  UNANNOTATED_PARAM: 'UNANNOTATED_PARAM',
  MISSING_ASSET: 'MISSING_ASSET',
  BAD_DEFAULT: 'BAD_DEFAULT',
  BAD_RANGE: 'BAD_RANGE',
  MISSING_CLOCK_META: 'MISSING_CLOCK_META',
  UNIT_MISMATCH: 'UNIT_MISMATCH',
  NO_ENTRY: 'NO_ENTRY',
  SOURCE_MISSING: 'SOURCE_MISSING',
  PARSE_FAILED: 'PARSE_FAILED',
  UNKNOWN_TYPE: 'UNKNOWN_TYPE',
  ENUM_NO_OPTIONS: 'ENUM_NO_OPTIONS',
  DUPLICATE_PARAM: 'DUPLICATE_PARAM'
});

/** 哪些码是 error、哪些只是 warning。表就这一份，别处不许另立一套。 */
export const LINT_SEVERITY = Object.freeze({
  WALL_CLOCK: 'error',
  NON_CSS_ANIMATION: 'error',
  UNANNOTATED_PARAM: 'warning',
  MISSING_ASSET: 'error',
  BAD_DEFAULT: 'error',
  BAD_RANGE: 'error',
  MISSING_CLOCK_META: 'warning',
  UNIT_MISMATCH: 'error',
  NO_ENTRY: 'error',
  SOURCE_MISSING: 'error',
  PARSE_FAILED: 'error',
  UNKNOWN_TYPE: 'error',
  ENUM_NO_OPTIONS: 'error',
  DUPLICATE_PARAM: 'error'
});

/** 时钟 meta 的默认变量名（S31 起冻结）。 */
const DEFAULT_CLOCK_VAR = '--motion-t';
const CLOCK_META_RE = /<meta\b[^>]*name=["']motion-clock["'][^>]*>/i;
const SMIL_RE = /<(animate|animateTransform|animateMotion|animateColor|set)\b/gi;
const CANVAS_RE = /<canvas\b/gi;
const GET_CONTEXT_RE = /getContext\s*\(\s*["'](2d|webgl2?|bitmaprenderer)["']/gi;
const RAF_RE = /(?:window\.)?requestAnimationFrame\s*\(/g;
const SCRIPT_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
const STYLE_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const CSS_URL_RE = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;

/**
 * @typedef {object} LintIssue
 * @property {string} code
 * @property {'error'|'warning'} severity
 * @property {string} file
 * @property {number} [line]
 * @property {string} detail
 */

/**
 * @param {string} code
 * @param {string} file
 * @param {string} detail
 * @param {number} [line]
 * @returns {LintIssue}
 */
function issueOf(code, file, detail, line) {
  const severity = /** @type {'error'|'warning'} */ (LINT_SEVERITY[/** @type {keyof typeof LINT_SEVERITY} */ (code)] ?? 'error');
  /** @type {LintIssue} */
  const issue = { code, severity, file, detail };
  if (typeof line === 'number' && line > 0) issue.line = line;
  return issue;
}

/**
 * @param {string} text
 * @param {number} index
 * @returns {number} 1 起的行号
 */
function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/**
 * 把注释挖成等长空白：位置不变、行号不变，但不会被规则命中。
 * @param {string} text
 * @returns {string}
 */
function blankComments(text) {
  return text.replace(HTML_COMMENT_RE, (match) => match.replace(/[^\n]/g, ' '));
}

/**
 * 把目录参数归一成 `{dir, entry}`。
 *
 * 认得四种写法：
 * - `lintTemplate('/abs/or/rel/dir')` —— 目录，入口按 `<dir>.html` → 唯一 html → index.html 找
 * - `lintTemplate('/abs/or/rel/dir/foo.html')` —— **文件**，目录取其所在目录、入口取文件名
 * - `lintTemplate({dir, source})` —— 显式指定
 * - `lintTemplate({source})` —— 只有源路径（`dir` 取其所在目录）
 *
 * @param {string | {dir?: string, source?: string}} input
 * @returns {Promise<{dir: string, entry: string, issues: LintIssue[]}>}
 */
async function resolveTarget(input) {
  const rawDir = typeof input === 'string' ? input : input && input.dir;
  const rawSource = typeof input === 'string' ? null : input && input.source;
  let dir = path.resolve(rawDir ?? (rawSource ? path.dirname(rawSource) : '.'));

  /** @type {LintIssue[]} */
  const issues = [];

  /* 传进来的是文件（不是目录）：直接当入口，别去 readdir 一个文件 */
  if (!rawSource && rawDir) {
    const stat = await fs.stat(dir).catch(() => null);
    if (stat && stat.isFile()) {
      return { dir: path.dirname(dir), entry: path.basename(dir), issues };
    }
  }

  const dirName = path.basename(dir);
  const candidates = [`${dirName}.html`, `${dirName}.htm`];

  if (rawSource) {
    const entry = path.isAbsolute(rawSource) ? path.relative(dir, rawSource) : rawSource;
    return { dir, entry: entry.split(path.sep).join('/'), issues };
  }

  for (const candidate of candidates) {
    const exists = await fs
      .stat(path.join(dir, candidate))
      .then((stat) => stat.isFile())
      .catch(() => false);
    if (exists) return { dir, entry: candidate, issues };
  }

  const entries = await fs.readdir(dir).catch(() => []);
  const htmls = entries.filter((name) => /\.html?$/i.test(name)).sort();
  if (htmls.includes('index.html')) return { dir, entry: 'index.html', issues };
  if (htmls.length === 1) return { dir, entry: htmls[0] ?? '', issues };
  if (htmls.length === 0) {
    issues.push(issueOf(LINT_CODES.NO_ENTRY, dir, `目录里没有 .html 入口：${dir}`));
  } else {
    issues.push(issueOf(LINT_CODES.NO_ENTRY, dir, `目录里有多个 .html 且没有 index.html：${htmls.join(', ')}`));
  }
  return { dir, entry: '', issues };
}

/**
 * 本地相对引用才查存在性；`http(s)://`、`//`、`data:`、`#`、`about:` 一律放过。
 * @param {unknown} ref
 * @returns {boolean}
 */
function isLocalRef(ref) {
  const value = String(ref ?? '').trim();
  if (!value) return false;
  if (/^(?:[a-z]+:)?\/\//i.test(value)) return false;
  if (/^(?:data|blob|about|javascript|mailto|tel):/i.test(value)) return false;
  if (value.startsWith('#')) return false;
  return true;
}

/**
 * 从 HTML 与 CSS 里收集本地资源引用。
 * @param {string} html
 * @param {{file: string, text: string}[]} cssFiles
 * @returns {{file: string, line: number, ref: string, from: string}[]}
 */
function collectAssetRefs(html, cssFiles) {
  /** @type {{file: string, line: number, ref: string, from: string}[]} */
  const out = [];
  const clean = blankComments(html);
  /* src= / href=（link 的 href 也是资产：样式表本身） */
  for (const match of clean.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const ref = match[1] ?? '';
    if (!isLocalRef(ref)) continue;
    out.push({ file: '<entry>', line: lineOf(clean, match.index ?? 0), ref, from: 'src/href' });
  }
  /* 内联 style 属性里的 url() */
  for (const match of clean.matchAll(/\bstyle\s*=\s*["'][^"']*url\(\s*["']?([^"')]+)["']?\s*\)[^"']*["']/gi)) {
    const ref = match[1] ?? '';
    if (!isLocalRef(ref)) continue;
    out.push({ file: '<entry>', line: lineOf(clean, match.index ?? 0), ref, from: 'style url()' });
  }
  for (const css of cssFiles) {
    for (const match of css.text.matchAll(CSS_URL_RE)) {
      const ref = match[1] ?? '';
      if (!isLocalRef(ref)) continue;
      out.push({ file: css.file, line: lineOf(css.text, match.index ?? 0), ref, from: 'url()' });
    }
  }
  return out;
}

/**
 * 页面上所有的参数标注（**不管值域合不合法**）。
 *
 * 为什么不用 `discoverControls().params`：值域写错的参数会被 discover 整个丢掉
 * （设计如此），那样它对应的 CSS 变量就会被误报成「没有标注」——B2 的 bad-range 反例
 * 第一版就多报了这条。标注是作者写没写的问题，跟值合不合法是两件事。
 *
 * @param {string} html
 * @returns {{key: string, apply: string}[]}
 */
function annotationsOf(html) {
  /** @type {{key: string, apply: string}[]} */
  const out = [];
  for (const match of html.matchAll(/<([a-z][\w-]*)\b[^>]*\bdata-motion-param\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const tag = match[0];
    const key = match[2] ?? '';
    if (!key) continue;
    const applyMatch = /data-motion-apply\s*=\s*["']([^"']+)["']/i.exec(tag);
    out.push({ key, apply: applyMatch?.[1] ?? 'css-var' });
  }
  return out;
}

/**
 * 从 CSS 文本里取「被消费的变量」与「在这里定义的变量」。
 * @param {string} css
 * @returns {{used: {name: string, index: number}[], defined: Set<string>}}
 */
function cssVars(css) {
  /** @type {{name: string, index: number}[]} */
  const used = [];
  for (const match of css.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
    used.push({ name: match[1] ?? '', index: match.index ?? 0 });
  }
  /** @type {Set<string>} */
  const defined = new Set();
  for (const match of css.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) {
    defined.add(match[1] ?? '');
  }
  return { used, defined };
}

/**
 * 模板自检。
 *
 * @param {string | {dir?: string, source?: string}} dirOrEntry
 * @returns {Promise<{ok: boolean, errors: LintIssue[], warnings: LintIssue[], facts: Record<string, any>}>}
 */
export async function lintTemplate(dirOrEntry) {
  const target = await resolveTarget(dirOrEntry);
  /** @type {LintIssue[]} */
  const issues = [...target.issues];

  /** @type {Record<string, any>} */
  const facts = {
    dir: target.dir.split(path.sep).join('/'),
    entry: target.entry,
    files: [],
    params: [],
    annotations: 0,
    assets: [],
    clockVar: null,
    clockUnit: null,
    hasClockMeta: false,
    animations: 0,
    smil: 0,
    canvas: 0,
    raf: 0,
    deterministic: null
  };

  if (!target.entry) return finish(issues, facts);

  let html = '';
  try {
    html = await fs.readFile(path.join(target.dir, target.entry), 'utf8');
  } catch {
    issues.push(issueOf(LINT_CODES.SOURCE_MISSING, target.entry, `读不到入口文件：${target.entry}`));
    return finish(issues, facts);
  }
  facts.files.push(target.entry);

  /* ① 墙钟：复用 wall-clock-check（连 link 的 CSS 一起扫） */
  const wallClock = await scanLinked(target.dir, target.entry, html);
  for (const hit of wallClock.hits) {
    /* SMIL 与 requestAnimationFrame 由下面的 NON_CSS_ANIMATION 统一报（那是给作者看的码），
       这里跳过同名命中，否则同一个原因会出两条 error。其余墙钟规则照常报。 */
    if (hit.rule === 'SMIL') continue;
    if (hit.rule === 'SELF_DRIVE' && /requestAnimationFrame/i.test(hit.detail)) continue;
    issues.push(issueOf(LINT_CODES.WALL_CLOCK, hit.file, `[${hit.rule}] ${hit.detail}`, hit.line));
  }
  for (const missing of wallClock.missing) {
    issues.push(issueOf(LINT_CODES.MISSING_ASSET, target.entry, `样式表读不到：${missing}（扫不到就不能断言没有墙钟）`));
  }

  /* ② 非 CSS 动画：SMIL / canvas 自绘 / rAF —— 这些 `--motion-t` 根本管不到 */
  const clean = blankComments(html);
  for (const match of clean.matchAll(SMIL_RE)) {
    facts.smil += 1;
    const tag = match[1] ?? 'animate';
    issues.push(issueOf(LINT_CODES.NON_CSS_ANIMATION, target.entry, `<${tag}> 是 SMIL 动画，自己走时钟，--motion-t 不生效`, lineOf(clean, match.index ?? 0)));
  }
  for (const match of clean.matchAll(CANVAS_RE)) {
    facts.canvas += 1;
    issues.push(issueOf(LINT_CODES.NON_CSS_ANIMATION, target.entry, '<canvas> 上是脚本自绘，页面里没有可被 --motion-t 定格的 CSS 动画', lineOf(clean, match.index ?? 0)));
  }
  for (const match of clean.matchAll(GET_CONTEXT_RE)) {
    const api = match[1] ?? '2d';
    issues.push(issueOf(LINT_CODES.NON_CSS_ANIMATION, target.entry, `getContext('${api}') 自绘，不受 --motion-t 控制`, lineOf(clean, match.index ?? 0)));
  }
  for (const script of clean.matchAll(SCRIPT_RE)) {
    const body = script[1] ?? '';
    const bodyStart = (script.index ?? 0) + script[0].indexOf('>') + 1;
    for (const match of body.matchAll(RAF_RE)) {
      facts.raf += 1;
      const line = lineOf(clean, bodyStart + (match.index ?? 0));
      issues.push(
        issueOf(
          LINT_CODES.NON_CSS_ANIMATION,
          target.entry,
          '脚本里有 requestAnimationFrame：画面会按帧自己走，导出按 t 取帧时抓到的相位不可复现（改成「暂停 + 负 delay 读 --motion-t」）',
          line
        )
      );
    }
  }

  /* ③ 参数标注与值域：复用 discoverControls（内部已用 params.mjs 校验） */
  const discovered = discoverControls(html, { file: target.entry });
  facts.params = Object.keys(discovered.params);
  facts.annotations = discovered.stats?.annotations ?? facts.params.length;
  for (const item of discovered.issues) {
    const mapped = /** @type {Record<string, string>} */ ({
      [DISCOVERY_ERROR_CODES.BAD_DEFAULT]: LINT_CODES.BAD_DEFAULT,
      [DISCOVERY_ERROR_CODES.BAD_RANGE]: LINT_CODES.BAD_RANGE,
      [DISCOVERY_ERROR_CODES.PARSE_FAILED]: LINT_CODES.PARSE_FAILED,
      [DISCOVERY_ERROR_CODES.UNKNOWN_TYPE]: LINT_CODES.UNKNOWN_TYPE,
      [DISCOVERY_ERROR_CODES.ENUM_NO_OPTIONS]: LINT_CODES.ENUM_NO_OPTIONS,
      [DISCOVERY_ERROR_CODES.DUPLICATE_PARAM]: LINT_CODES.DUPLICATE_PARAM
    });
    const code = mapped[item.code] ?? DISCOVERY_ERROR_CODES.PARSE_FAILED;
    issues.push(issueOf(code, target.entry, `${item.key ? `${item.key}：` : ''}${item.detail}`, item.line));
  }

  /* ④ CSS 文本：内联 <style> + link 的样式表 */
  /** @type {{file: string, text: string, offsetBase: number}[]} */
  const cssFiles = [];
  for (const match of clean.matchAll(STYLE_RE)) {
    cssFiles.push({ file: target.entry, text: match[1] ?? '', offsetBase: (match.index ?? 0) + match[0].indexOf('>') + 1 });
  }
  for (const href of linkedStylesheets(html)) {
    try {
      const text = await fs.readFile(path.resolve(target.dir, href), 'utf8');
      cssFiles.push({ file: href.replace(/^\.\//, ''), text, offsetBase: 0 });
      facts.files.push(href.replace(/^\.\//, ''));
    } catch {
      /* 上面 wallClock.missing 已经报过 MISSING_ASSET */
    }
  }

  /* ⑤ 时钟 meta 与单位 */
  const metaMatch = CLOCK_META_RE.exec(html);
  if (metaMatch) {
    facts.hasClockMeta = true;
    const meta = metaMatch[0];
    const contentMatch = /content\s*=\s*["']([^"']*)["']/i.exec(meta);
    const content = contentMatch?.[1] ?? '';
    const varName = content.split(';')[0]?.trim() ?? '';
    const unitMatch = /unit\s*=\s*([A-Za-z]+)/.exec(content);
    facts.clockVar = varName || null;
    facts.clockUnit = unitMatch?.[1] ?? null;
    if (varName && !varName.startsWith('--')) {
      issues.push(issueOf(LINT_CODES.UNIT_MISMATCH, target.entry, `motion-clock 里应当是 CSS 自定义属性名，实际是「${varName}」`));
    }
    if (unitMatch && unitMatch[1] !== 'ms') {
      issues.push(issueOf(LINT_CODES.UNIT_MISMATCH, target.entry, `motion-clock 声明 unit=${unitMatch[1]}，宿主按毫秒注入（S31 口径），会对不上`));
    }
  } else {
    issues.push(issueOf(LINT_CODES.MISSING_CLOCK_META, target.entry, '没有 <meta name="motion-clock" content="--motion-t;unit=ms">：宿主不知道这条模板读哪个变量'));
  }

  /* ⑥ 变量名一致性：动画延迟里读的那个变量必须就是 meta 声明的那个 */
  const declaredVar = typeof facts.clockVar === 'string' && facts.clockVar.length > 0 ? facts.clockVar : DEFAULT_CLOCK_VAR;
  /** @type {Set<string>} */
  const delayVars = new Set();
  /** @type {Set<string>} */
  const usedVars = new Set();
  /** @type {Set<string>} */
  const definedVars = new Set();
  /* 只看 `animation-delay`：`animation` 简写里的 `var(--duration)` / `var(--easing)` 是**参数**，
     不是时钟——把它们当成延迟变量会误报（第一版就这么误报了 pulse 两条）。
     没有显式 `animation-delay` 说明这条模板没有可 seek 的相位，交给 WALL_CLOCK 报，这里不猜。 */
  let hasExplicitDelay = false;
  for (const css of cssFiles) {
    const vars = cssVars(css.text);
    for (const used of vars.used) usedVars.add(used.name);
    for (const defined of vars.defined) definedVars.add(defined);
    for (const match of css.text.matchAll(/animation-delay\s*:\s*([^;}]+)/gi)) {
      hasExplicitDelay = true;
      const value = match[1] ?? '';
      for (const inner of value.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) delayVars.add(inner[1] ?? '');
    }
  }
  facts.delayVars = [...delayVars];
  facts.hasExplicitDelay = hasExplicitDelay;
  facts.animations = cssFiles.reduce((sum, css) => sum + (css.text.match(/(?:^|[;{\s])animation\s*:/g) ?? []).length, 0);
  for (const name of hasExplicitDelay ? delayVars : []) {
    if (name === declaredVar) continue;
    issues.push(
      issueOf(
        LINT_CODES.UNIT_MISMATCH,
        target.entry,
        `动画延迟读的是 ${name}，但 motion-clock 声明的是 ${declaredVar}——宿主按声明写，画面对不上`
      )
    );
  }

  /* ⑦ 未标注的参数变量（warning）：CSS 用了、但没有任何 data-motion-param 落上去 */
  /** @type {Set<string>} */
  const annotatedVars = new Set();
  for (const annotation of annotationsOf(clean)) {
    if (annotation.apply === 'text') continue;
    annotatedVars.add(`--${annotation.key}`);
  }
  /* 再用 discover 的结果兜一层（显式写了 data-motion-apply="css-var" 的情况） */
  for (const [key, spec] of Object.entries(discovered.params)) {
    const apply = applyOf(key, spec);
    if (apply.kind === 'css-var') annotatedVars.add(apply.name);
  }
  facts.annotatedVars = [...annotatedVars];
  /** @type {Set<string>} */
  const reported = new Set();
  for (const css of cssFiles) {
    for (const match of css.text.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
      const name = match[1] ?? '';
      if (!name || reported.has(name)) continue;
      if (name === declaredVar || name === DEFAULT_CLOCK_VAR) continue;
      if (definedVars.has(name)) continue; /* 模板自己内部算的中间变量 */
      if (annotatedVars.has(name)) continue;
      reported.add(name);
      const line = css.offsetBase > 0 ? lineOf(html, css.offsetBase + (match.index ?? 0)) : lineOf(css.text, match.index ?? 0);
      issues.push(issueOf(LINT_CODES.UNANNOTATED_PARAM, css.file, `${name} 没有对应的 data-motion-param：面板里改不到它`, line));
    }
  }

  /* ⑧ 资产存在性 */
  const refs = collectAssetRefs(html, cssFiles);
  for (const ref of refs) {
    const cleanRef = ref.ref.split('?')[0]?.split('#')[0] ?? '';
    if (!cleanRef) continue;
    const baseDir = ref.file === '<entry>' ? target.dir : path.dirname(path.resolve(target.dir, ref.file));
    const abs = path.resolve(baseDir, cleanRef);
    const exists = await fs
      .stat(abs)
      .then((stat) => stat.isFile())
      .catch(() => false);
    facts.assets.push({ ref: ref.ref, file: ref.file, exists });
    if (!exists) {
      const label = ref.file === '<entry>' ? target.entry : ref.file;
      const line = ref.file === '<entry>' ? ref.line : ref.line;
      issues.push(issueOf(LINT_CODES.MISSING_ASSET, label, `引用的文件不存在：${ref.ref}（${ref.from}）`, line));
    }
  }

  facts.deterministic = issues.every((item) => item.code !== LINT_CODES.WALL_CLOCK && item.code !== LINT_CODES.NON_CSS_ANIMATION);
  return finish(issues, facts);
}

/**
 * @param {LintIssue[]} issues
 * @param {Record<string, any>} facts
 */
function finish(issues, facts) {
  const errors = issues.filter((item) => item.severity === 'error');
  const warnings = issues.filter((item) => item.severity === 'warning');
  return { ok: errors.length === 0, errors, warnings, facts };
}

/**
 * 对一个「模板集合」目录跑自检：自身是模板就只跑自己，否则逐个子目录跑。
 *
 * 用于 `packages/motion/templates` 这种父目录（B5）。
 *
 * @param {string} dir
 * @returns {Promise<{ok: boolean, errors: LintIssue[], warnings: LintIssue[], results: {dir: string, ok: boolean, errors: LintIssue[], warnings: LintIssue[], facts: Record<string, any>}[]}>}
 */
export async function lintTree(dir) {
  const root = path.resolve(dir);
  const own = await lintTemplate(root);
  if (own.facts.entry) return { ok: own.ok, errors: own.errors, warnings: own.warnings, results: [{ dir: own.facts.dir, ...own }] };

  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const subdirs = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name).sort();
  /** @type {any[]} */
  const results = [];
  /** @type {LintIssue[]} */
  const errors = [];
  /** @type {LintIssue[]} */
  const warnings = [];
  for (const name of subdirs) {
    const result = await lintTemplate(path.join(root, name));
    /* 没有入口的子目录（比如 assets/）不当模板看，跳过，不制造噪音 */
    if (!result.facts.entry && result.errors.every((item) => item.code === LINT_CODES.NO_ENTRY)) continue;
    results.push({ dir: name, ...result });
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }
  return { ok: errors.length === 0, errors, warnings, results };
}

/**
 * CLI：`node packages/motion/lint.mjs <dir> [--json]`
 *
 * 有 error 退 1，全绿退 0。`--json` 打结构化结果（给 CI / 宿主读）。
 *
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function lintCli(argv) {
  const json = argv.includes('--json');
  const target = argv.find((item) => !item.startsWith('--'));
  if (!target) {
    process.stderr.write('用法：node packages/motion/lint.mjs <模板目录> [--json]\n');
    return 2;
  }
  const result = await lintTree(target);

  if (json) {
    process.stdout.write(`${JSON.stringify({ target, ...result }, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }

  /** @param {string} value */
  const rel = (value) => path.relative(process.cwd(), value).split(path.sep).join('/') || '.';
  for (const item of result.results) {
    const badge = item.ok ? 'OK  ' : 'FAIL';
    const warn = item.warnings.length > 0 ? `，${item.warnings.length} warning` : '';
    process.stdout.write(`${badge} ${rel(item.dir)}  (${item.errors.length} error${warn})\n`);
    for (const entry of [...item.errors, ...item.warnings]) {
      const level = entry.severity === 'error' ? 'error' : 'warn ';
      const where = entry.line ? `${entry.file}:${entry.line}` : entry.file;
      process.stdout.write(`  ${level} [${entry.code}] ${where} —— ${entry.detail}\n`);
    }
  }
  const errorCount = result.errors.length;
  const warningCount = result.warnings.length;
  process.stdout.write(`\n合计：${result.results.length} 个模板，${errorCount} error，${warningCount} warning\n`);
  return result.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invokedDirectly) {
  lintCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
