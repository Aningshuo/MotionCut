/**
 * `opencut` CLI（WP18）。
 *
 * 这一层只负责：参数、输出格式、退出码。语义与安全边界在 `ops.mjs`（与 MCP 共用）。
 *
 * 三条硬规矩：
 * 1. **依赖注入，不重造内核**：
 *      createCli({ projects, film: { read, applyOps }, render: { start, status, cancel } })
 *    本树没有 main 的 `film-core`，所以默认 `WAIT_MAIN_FILM`；这里没有第二套解析器。
 * 2. **stdout 只放结果与错误码**，人读日志走 stderr（A10）。
 * 3. **先校验后动作**：路径越界在读/写之前抛 `E_PATH_ESCAPE`（A5）。
 */

import path from 'node:path';

import { CliError, EXIT, exitCodeFor } from './errors.mjs';
import { HELP, parseCommand, tokenize } from './args.mjs';
import { redactText } from './redact.mjs';
import { QUALITY_NAMES } from '../render/quality.mjs';
import { CODEC_NAMES, PIX_FMT_MODES, resolvePixFmtMode } from '../render/codec-matrix.mjs';
import { parseFps } from '../render/fps.mjs';
import { formatEstimate } from '../render/export-estimate.mjs';
import { parseSizeArg } from '../render/delivery-size.mjs';
import { formatLoudnessLine } from '../render/loudness.mjs';
import { parseStyleArg } from '../render/subtitles.mjs';
import {
  applyOps,
  applyCreationLibrary,
  readCreationLibrary,
  createContext,
  estimateFilmExport,
  exportCancel,
  exportFilm,
  exportFcpxml,
  exportGif,
  exportStatus,
  exportStems,
  exportStill,
  listProjects,
  normalizeError,
  projectInfo,
  readFilm,
  readJsonFile,
  startExport,
} from './ops.mjs';

const VERSION = '0.1.0';

/**
 * `--range a:b`（秒，可小数）→ [start, end]。
 * @param {string} raw
 * @returns {[number, number]}
 */
function parseRange(raw) {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*:\s*(-?\d+(?:\.\d+)?)\s*$/.exec(raw);
  if (!match) throw new CliError('INVALID', '--range must be <start>:<end> in seconds');
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw new CliError('INVALID_RANGE', `--range ${raw} is empty or negative`);
  }
  return [start, end];
}

/**
 * `--range a:b[,c:d...]`（秒，可小数）→ 范围数组。
 *
 * 两种写法等价：`--range 2:4 --range 6:8`（tokenize 用逗号合并成 `2:4,6:8`）
 * 与 `--range 2:4,6:8`。顺序就是拼接顺序，**不重排、不合并重叠**。
 * @param {string} raw
 * @returns {Array<[number, number]>}
 */
function parseRanges(raw) {
  const parts = raw.split(',').map((part) => part.trim());
  if (parts.some((part) => part.length === 0)) {
    throw new CliError('INVALID', '--range must be <start>:<end>[,<start>:<end>...] in seconds');
  }
  return parts.map((part) => parseRange(part));
}

/**
 * `--range a..b` / `--range a:b`（秒，可小数）→ [start, end]。
 * GIF 的写法按任务书是 `a..b`，同时容忍 `a:b`（与 export film 一致）。
 * @param {string} raw
 * @returns {[number, number]}
 */
function parseGifRange(raw) {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*(?:\.\.|:)\s*(-?\d+(?:\.\d+)?)\s*$/.exec(raw);
  if (!match) throw new CliError('E_USAGE', '--range must be <start>..<end> in seconds');
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw new CliError('INVALID_RANGE', `--range ${raw} is empty or negative`);
  }
  return [start, end];
}

/**
 * @typedef {{ write: (chunk: string) => void }} Sink
 */

/**
 * @param {{
 *   projects?: any,
 *   film?: any,
 *   render?: any,
 *   env?: Record<string, any>,
 *   root?: string,
 *   cwd?: string,
 *   stateDir?: string,
 *   ledger?: any,
 *   log?: (line: string) => void,
 *   now?: () => number,
 * }} [deps]
 */
export function createCli(deps = {}) {
  const ctx = createContext(deps);

  /**
   * @param {readonly string[]} argv
   * @param {{ stdout?: Sink, stderr?: Sink }} [io]
   * @returns {Promise<number>}
   */
  async function run(argv, io = {}) {
    const stdout = io.stdout ?? process.stdout;
    const stderr = io.stderr ?? process.stderr;
    const emit = (/** @type {string} */ text) => stdout.write(text.endsWith('\n') ? text : `${text}\n`);

    if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
      emit(HELP);
      return EXIT.OK;
    }
    if (argv.includes('--version') || argv.includes('-v')) {
      emit(VERSION);
      return EXIT.OK;
    }

    let json = false;
    // 在 try 外声明：catch 里也要靠它决定「输出一行 JSON 错误」还是人读文本
    let progressJsonl = false;
    try {
      const { flags, positional } = tokenize(argv);
      json = flags.get('--json') === true;

      // 这些开关必须在**创建 CLI 之前**生效（端口按 root 绑定）；到这里只能是误用。
      const HOST_LEVEL = ['--root', '--film-module', '--render-module', '--projects-module', '--env', '--state-dir'];
      const misplaced = HOST_LEVEL.find((name) => flags.has(name));
      if (misplaced) {
        throw new CliError('E_USAGE', `${misplaced} is host-level: pass it to bin.mjs before the CLI is created`);
      }

      // 任务书里写的 `film export ...` 与 `export film ...` 是同一件事：
      // 本 CLI 的动词是 `export` 这一组（`export film|still|stems|gif|fcpxml`），
      // 所以在这里做一次归一，而不是把同一段逻辑写两遍。
      //   film export <project> [...]      → export film <project> [...]
      //   film export fcpxml --project <p> → export fcpxml <p>
      const parsed = parseCommand(positional);
      let group = parsed.group;
      let action = parsed.action;
      let target = parsed.target;
      if (group === 'film' && action === 'export') {
        const which = target === 'fcpxml' ? 'fcpxml' : 'film';
        group = 'export';
        action = which;
        target = which === 'fcpxml' ? undefined : parsed.target;
      }
      const projectArg = typeof flags.get('--project') === 'string' ? /** @type {string} */ (flags.get('--project')) : target;
      const dryRun = flags.get('--dry-run') === true;
      // `--progress jsonl`：整条导出的进度按行吐到 stdout，每行一个 JSON（带 type 字段）。
      // **不走 stderr**：宿主必须能逐行 JSON.parse，而不是拿正则去啃人读日志。
      const progressRaw = flags.get('--progress');
      if (progressRaw !== undefined && progressRaw !== 'jsonl') {
        throw new CliError('E_USAGE', `--progress supports only "jsonl", got "${String(progressRaw)}"`);
      }
      progressJsonl = progressRaw === 'jsonl';
      if (progressJsonl && !(group === 'export' && action === 'film')) {
        throw new CliError('E_USAGE', '--progress jsonl is only meaningful for `export film`');
      }

      /** @type {{ result: any, line: string }} */
      let out;

      if (group === 'library' && (action === 'list' || action === 'action')) {
        const url = flags.get('--studio-url'), projectId = flags.get('--project-id'), grant = flags.get('--grant');
        const studio = typeof url === 'string' ? { baseUrl: url, ...(typeof projectId === 'string' ? { projectId } : {}), ...(typeof grant === 'string' ? { grantId: grant } : {}) } : undefined;
        let result;
        if (action === 'list') result = await readCreationLibrary(ctx, projectArg, { studio });
        else {
          if (flags.get('--allow-write') !== true || flags.get('--confirm') !== true) throw new CliError('E_WRITE_DENIED', 'library-action 需要 --allow-write --confirm，以及原工程写票');
          const file = flags.get('--action-file');
          if (typeof file !== 'string') throw new CliError('E_USAGE', 'library-action 需要 --action-file <action.json>');
          const request = await readJsonFile(ctx.cwd, file, 'creation-library action');
          result = await applyCreationLibrary(ctx, projectArg, request, { studio });
        }
        out = { result, line: JSON.stringify(result) };
      } else if (group === 'project' && action === 'list') {
        const rows = await listProjects(ctx);
        out = {
          result: { ok: true, projects: rows },
          line: rows.length === 0 ? 'no projects' : rows.map((p) => `${p.id}\t${p.name ?? ''}\t${p.path}`).join('\n'),
        };
      } else if (group === 'project' && action === 'info') {
        const result = await projectInfo(ctx, projectArg);
        out = { result, line: formatInfo(result) };
      } else if (group === 'film' && action === 'read') {
        const result = await readFilm(ctx, projectArg);
        out = { result, line: JSON.stringify(result) };
      } else if (group === 'film' && action === 'apply') {
        const opsPath = flags.get('--ops');
        if (typeof opsPath !== 'string') {
          throw new CliError('E_USAGE', 'film apply needs --ops <file.json> (writes are never implicit)');
        }
        const payload = await readJsonFile(ctx.cwd, opsPath, 'ops');
        const { result, replayed } = await applyOps(ctx, projectArg, payload, { dryRun });
        out = {
          result,
          line: dryRun ? `DRY-RUN ${result.hash}` : `OK ${result.hash}${replayed ? ' (replayed)' : ''}`,
        };
      } else if (group === 'export' && action === 'start') {
        const specPath = flags.get('--spec');
        if (typeof specPath !== 'string') throw new CliError('E_USAGE', 'export start needs --spec <spec.json>');
        const draft = await readJsonFile(ctx.cwd, specPath, 'spec');
        const audioSpecPath = flags.get('--audio-spec');
        const audioMix =
          typeof audioSpecPath === 'string' ? await readJsonFile(ctx.cwd, audioSpecPath, 'audio-spec') : undefined;
        const { result } = await startExport(ctx, projectArg, draft, {
          dryRun,
          ...(audioMix !== undefined ? { audioMix } : {}),
        });
        const audioTag = result.audio ? ` audio=${result.audio.clips}clips/${result.audio.durationSec}s` : '';
        out = { result, line: dryRun ? `DRY-RUN ${result.jobId}${audioTag}` : `JOB ${result.jobId}${audioTag}` };
      } else if (group === 'export' && action === 'status') {
        const jobId = target ?? (typeof flags.get('--project') === 'string' ? /** @type {string} */ (flags.get('--project')) : undefined);
        const result = await exportStatus(ctx, jobId);
        out = {
          result,
          line: `${result.state}${typeof result.framesTotal === 'number' ? ` ${result.framesDone ?? 0}/${result.framesTotal}` : ''} ${result.jobId}`,
        };
      } else if (group === 'export' && action === 'cancel') {
        const result = await exportCancel(ctx, target);
        out = { result, line: `CANCELLED ${result.jobId} ${result.state}` };
      } else if (group === 'export' && action === 'film') {
        const estimateOnly = flags.get('--estimate') === true;
        const rangeRaw = flags.get('--range');
        const ranges = typeof rangeRaw === 'string' ? parseRanges(rangeRaw) : undefined;
        /* 帧率（P42）：29.97 不是 29.97，是 30000/1001。这里就把有理数算出来，
           下游只读 `fpsRational`；`fps` 仍给合同/报告一个数（29.97002997…）。 */
        const fpsRaw = flags.get('--fps');
        /** @type {{ fps: number, fpsRational: { num: number, den: number } } | null} */
        let fpsRate = null;
        if (typeof fpsRaw === 'string') {
          try {
            const rate = parseFps(fpsRaw);
            fpsRate = { fps: rate.value, fpsRational: { num: rate.num, den: rate.den } };
          } catch (err) {
            throw new CliError('INVALID_FPS', /** @type {any} */ (err)?.detail ?? String(err));
          }
        }
        // 像素格式（P41）：auto 是缺省，值域在 CLI 就收窄（prores 的组合在 ops 层按编码判）
        const pixFmtRaw = flags.get('--pix-fmt');
        /** @type {'auto' | '420' | '444'} */
        let pixFmtMode = 'auto';
        if (typeof pixFmtRaw === 'string') {
          try {
            pixFmtMode = resolvePixFmtMode(pixFmtRaw);
          } catch (err) {
            throw new CliError('INVALID', `--pix-fmt must be ${PIX_FMT_MODES.join('|')}, got "${pixFmtRaw}"`);
          }
        }
        const outArg = flags.get('--out');
        // `--estimate` 只估算：任何「要产出文件」的开关都不接受，避免"我要了文件却没拿到"的误解。
        if (estimateOnly) {
          const conflicting = [
            '--out',
            '--plan-out',
            '--frames-out',
            '--profile-out',
            '--also-compat',
            '--dry-run',
            '--subtitle-burn',
            '--size',
            '--fit',
            '--loudness',
            '--progress',
            '--codec',
            '--pix-fmt',
          ].filter(
            (name) => flags.has(name),
          );
          if (conflicting.length > 0) {
            throw new CliError(
              'E_USAGE',
              `--estimate does not export anything: drop ${conflicting.join(', ')} (or drop --estimate)`,
            );
          }
        } else if (typeof outArg !== 'string' || outArg.length === 0) {
          throw new CliError('E_USAGE', 'export film needs --out <file.mp4>');
        }
        // 走到导出分支时 outArg 一定是非空字符串（上面已经拦了），这里只是把类型收窄给 tsc 看
        const outFile = typeof outArg === 'string' ? outArg : '';
        const planOutRaw = flags.get('--plan-out');
        const framesOutRaw = flags.get('--frames-out');
        const qualityRaw = flags.get('--quality');
        const profileOutRaw = flags.get('--profile-out');
        const concurrencyRaw = flags.get('--capture-concurrency');
        const concurrency = typeof concurrencyRaw === 'string' ? Number(concurrencyRaw) : undefined;
        if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)) {
          throw new CliError('INVALID', '--capture-concurrency must be an integer 1..16');
        }
        if (typeof qualityRaw === 'string' && !QUALITY_NAMES.includes(qualityRaw)) {
          throw new CliError('INVALID', `--quality must be one of ${QUALITY_NAMES.join('|')}, got "${qualityRaw}"`);
        }
        // 编码矩阵（P38）：名字先在这里收窄，容器/扩展名/编码器探测在 ops 层做
        const codecRaw = flags.get('--codec');
        if (typeof codecRaw === 'string' && !CODEC_NAMES.includes(codecRaw)) {
          throw new CliError('INVALID', `--codec must be one of ${CODEC_NAMES.join('|')}, got "${codecRaw}"`);
        }
        const contentPortRaw = flags.get('--content-port');
        const contentPort =
          typeof contentPortRaw === 'string'
            ? Number(contentPortRaw)
            : Number.isInteger(ctx.env?.contentPort)
              ? Number(ctx.env.contentPort)
              : undefined;
        if (contentPort !== undefined && (!Number.isInteger(contentPort) || contentPort < 0)) {
          throw new CliError('INVALID', '--content-port must be a port number (0 = any)');
        }
        const settleMsRaw = flags.get('--settle-ms');
        const settleMsPerFrame = typeof settleMsRaw === 'string' ? Number(settleMsRaw) : undefined;
        if (settleMsPerFrame !== undefined && (!Number.isFinite(settleMsPerFrame) || settleMsPerFrame <= 0)) {
          throw new CliError('INVALID', '--settle-ms must be a positive number of milliseconds');
        }
        const maxScanRaw = flags.get('--max-scan-ms');
        const maxScanMs = typeof maxScanRaw === 'string' ? Number(maxScanRaw) : undefined;
        if (maxScanMs !== undefined && (!Number.isFinite(maxScanMs) || maxScanMs <= 0)) {
          throw new CliError('INVALID', '--max-scan-ms must be a positive number of milliseconds');
        }
        // 画幅（P24）
        const sizeRaw = flags.get('--size');
        /** @type {{ w: number, h: number } | null} */
        let size = null;
        try {
          size = parseSizeArg(typeof sizeRaw === 'string' ? sizeRaw : undefined);
        } catch (err) {
          throw new CliError('INVALID', /** @type {any} */ (err)?.message ?? String(err));
        }
        const fitRaw = flags.get('--fit');
        if (typeof fitRaw === 'string' && fitRaw !== 'letterbox' && fitRaw !== 'cover') {
          throw new CliError('INVALID', `--fit must be letterbox|cover, got "${fitRaw}"`);
        }
        // 字幕样式（P37）：`--subtitle-style '<json>'` / `--subtitle-style @style.json` / `k=v,...`。
        // 三种写法都归一到 S41 的 schema；非法**值**不在这里拒——交给 normalize 出 issue +
        // warning 并回退默认（用户能看见哪一个字段没生效）。只有「读不了文件 / JSON 坏」才是用法错误。
        const styleRaw = flags.get('--subtitle-style');
        /** @type {any} */
        let subtitleStyle;
        try {
          if (typeof styleRaw === 'string' && styleRaw.startsWith('@')) {
            const styleFile = styleRaw.slice(1);
            if (styleFile === '') throw new CliError('E_USAGE', '--subtitle-style @ needs a file path (e.g. @style.json)');
            subtitleStyle = await readJsonFile(ctx.cwd, styleFile, 'subtitle-style');
          } else {
            subtitleStyle = parseStyleArg(typeof styleRaw === 'string' ? styleRaw : undefined);
          }
        } catch (err) {
          if (err instanceof CliError) throw err;
          throw new CliError('INVALID', /** @type {any} */ (err)?.message ?? String(err));
        }
        const ffmpegPathRaw = flags.get('--ffmpeg-path');
        const ffmpegPath = typeof ffmpegPathRaw === 'string' ? ffmpegPathRaw : undefined;
        const budgetMemRaw = flags.get('--budget-mem-mb');
        const budgetMemMb = typeof budgetMemRaw === 'string' ? Number(budgetMemRaw) : undefined;
        if (budgetMemMb !== undefined && (!Number.isFinite(budgetMemMb) || budgetMemMb <= 0)) {
          throw new CliError('INVALID', '--budget-mem-mb must be a positive number of megabytes');
        }
        const budgetSecRaw = flags.get('--budget-sec');
        const budgetSec = typeof budgetSecRaw === 'string' ? Number(budgetSecRaw) : undefined;
        if (budgetSec !== undefined && (!Number.isFinite(budgetSec) || budgetSec <= 0)) {
          throw new CliError('INVALID', '--budget-sec must be a positive number of seconds');
        }
        // 透明输出（P31）：`--alpha` 开，`--alpha-format` 选形态（缺省 prores4444）。
        // 单独给 `--alpha-format` 是笔误，直接拒——静默忽略会让人以为导出了透明件。
        const alpha = flags.get('--alpha') === true;
        const alphaFormatRaw = flags.get('--alpha-format');
        if (typeof alphaFormatRaw === 'string' && !alpha) {
          throw new CliError('E_USAGE', '--alpha-format only applies together with --alpha');
        }
        if (typeof alphaFormatRaw === 'string' && alphaFormatRaw !== 'prores4444' && alphaFormatRaw !== 'png-seq') {
          throw new CliError('INVALID', `--alpha-format must be prores4444|png-seq, got "${alphaFormatRaw}"`);
        }
        // alpha 极性（P33）：默认随格式走，所以这里只校验「写出来的值合不合法」，
        // 「png-seq + premultiplied」这种组合由 ops 层按格式判（那里才知道最终格式）。
        const alphaModeRaw = flags.get('--alpha-mode');
        if (typeof alphaModeRaw === 'string' && !alpha) {
          throw new CliError('E_USAGE', '--alpha-mode only applies together with --alpha');
        }
        if (typeof alphaModeRaw === 'string' && alphaModeRaw !== 'premultiplied' && alphaModeRaw !== 'straight') {
          throw new CliError('INVALID', `--alpha-mode must be premultiplied|straight, got "${alphaModeRaw}"`);
        }
        // 响度（P34）：三档，缺省 off。
        const loudnessRaw = flags.get('--loudness');
        if (typeof loudnessRaw === 'string' && loudnessRaw !== 'off' && loudnessRaw !== 'streaming' && loudnessRaw !== 'broadcast') {
          throw new CliError('INVALID', `--loudness must be off|streaming|broadcast, got "${loudnessRaw}"`);
        }
        if (estimateOnly) {
          const { result } = await estimateFilmExport(ctx, projectArg, {
            ...(ranges ? { ranges } : {}),
            ...(fpsRate ?? {}),
            ...(typeof qualityRaw === 'string' ? { quality: qualityRaw } : {}),
            ...(concurrency !== undefined ? { concurrency } : {}),
            ...(settleMsPerFrame !== undefined ? { settleMsPerFrame } : {}),
            ...(maxScanMs !== undefined ? { maxScanMs } : {}),
          });
          out = { result, line: formatEstimate(result.estimate) };
        } else {
          // 舞台取帧是分钟级的长活：SIGINT/SIGTERM 必须变成**协作式中止**，
          // 让 finally 有机会删掉半截视频与临时帧目录，而不是被默认信号直接打死。
          //
          // 用 `on` 而不是 `once`：`once` 处理完就自我注销，第二个信号会让 Node
          // 走默认分支直接 `exit(130)`——实测一次 Ctrl-C 会被重复投递（信号 + 子进程收敛），
          // 结果就是「清理到一半被打断、退出码变成 130」。abort() 本身幂等，留着监听没坏处。
          const controller = new AbortController();
          /** @param {string} signal */
          const onSignal = (signal) => {
            if (!controller.signal.aborted) controller.abort(new Error(`${signal} received`));
          };
          const forwardInt = () => onSignal('SIGINT');
          const forwardTerm = () => onSignal('SIGTERM');
          process.on('SIGINT', forwardInt);
          process.on('SIGTERM', forwardTerm);
          let filmResult;
          try {
            filmResult = await exportFilm(ctx, projectArg, {
              ...(progressJsonl ? { onEvent: (/** @type {any} */ event) => emit(JSON.stringify(event)) } : {}),
              ...(ranges ? { ranges } : {}),
              ...(fpsRate ?? {}),
              ...(typeof planOutRaw === 'string' ? { planOut: planOutRaw } : {}),
              ...(typeof framesOutRaw === 'string' ? { framesOut: framesOutRaw } : {}),
              ...(typeof qualityRaw === 'string' ? { quality: qualityRaw } : {}),
              ...(typeof codecRaw === 'string' ? { codec: codecRaw } : {}),
              ...(pixFmtMode !== 'auto' ? { pixFmt: pixFmtMode } : {}),
              ...(typeof profileOutRaw === 'string' ? { profile: true, profileOut: profileOutRaw } : {}),
              ...(flags.get('--also-compat') === true ? { alsoCompat: true } : {}),
              ...(flags.get('--subtitle-burn') === true ? { subtitleBurn: true } : {}),
              ...(alpha ? { alpha: true } : {}),
              ...(typeof alphaFormatRaw === 'string' ? { alphaFormat: alphaFormatRaw } : {}),
              ...(typeof alphaModeRaw === 'string' ? { alphaMode: alphaModeRaw } : {}),
              ...(typeof loudnessRaw === 'string' ? { loudness: loudnessRaw } : {}),
              ...(size ? { size } : {}),
              ...(typeof fitRaw === 'string' ? { fit: fitRaw } : {}),
              ...(subtitleStyle !== undefined ? { subtitleStyle } : {}),
              ...(ffmpegPath !== undefined ? { ffmpegPath } : {}),
              ...(budgetMemMb !== undefined ? { budgetMemMb } : {}),
              ...(budgetSec !== undefined ? { budgetSec } : {}),
              ...(concurrency !== undefined ? { concurrency } : {}),
              ...(contentPort !== undefined ? { contentPort } : {}),
              out: outFile,
              signal: controller.signal,
              dryRun,
            });
          } finally {
            process.removeListener('SIGINT', forwardInt);
            process.removeListener('SIGTERM', forwardTerm);
          }
          const { result } = filmResult;
          const sceneTag = result.scenes ? ` scenes=${result.scenes.rendered}` : '';
          const qualityTag = result.quality ? ` q=${result.quality.name}/${result.quality.pixFmt}` : '';
          const codecTag = result.codec ? ` codec=${result.codec.name}/${result.codec.container}` : '';
          const compatTag = result.compat ? ` compat=${path.basename(result.compat.path)}` : '';
          const sizeTag = result.plan?.output ? ` ${result.plan.output.w}x${result.plan.output.h}${result.plan.fit !== 'none' ? `/${result.plan.fit}` : ''}` : '';
          const alphaTag = result.alpha
            ? ` alpha=${result.alpha.format} mode=${result.alpha.mode ?? '?'} hasAlpha=${result.alpha.hasAlpha} transparent=${(result.alpha.maxTransparentRatio * 100).toFixed(1)}%${result.alpha.volumeCount && result.alpha.volumeCount > 1 ? ` volumes=${result.alpha.volumeCount}` : ''}`
            : '';
          // 响度（P34）：人读模式一行说完「从多少到多少、加了多少 dB、峰值多少」。
          const loudnessTag = result.loudness ? ` ${formatLoudnessLine(result.loudness)}` : '';
          const subtitleTag = result.subtitles
            ? ` subs=${result.subtitles.cues}cues/${result.subtitles.glyph?.status ?? '?'} subbed=${result.subtitles.subbed ? path.basename(result.subtitles.subbed.path) : 'none'} vtt=${result.subtitles.vtt ? path.basename(result.subtitles.vtt.path) : 'none'}`
            : '';
          out = {
            result,
            line: dryRun
              ? `DRY-RUN ${result.plan.frames}f ${result.plan.durationSec}s${sceneTag}${sizeTag}`
              : `${result.path} ${result.frames}f ${result.durationSec}s${sceneTag}${qualityTag}${codecTag}${compatTag}${sizeTag}${subtitleTag}${alphaTag}${result.audio ? ` audio=${result.audio.clips}clips/${result.audio.durationSec}s` : ' silent'}${loudnessTag}`,
          };
        }
      } else if (group === 'export' && action === 'fcpxml') {
        const outArg = flags.get('--out');
        if (typeof outArg !== 'string' || outArg.length === 0) {
          throw new CliError('E_USAGE', 'export fcpxml needs --out <file.fcpxml>');
        }
        const fpsRaw = flags.get('--fps');
        const fps = typeof fpsRaw === 'string' ? Number(fpsRaw) : undefined;
        if (fps !== undefined && (!Number.isFinite(fps) || fps <= 0)) {
          throw new CliError('INVALID', '--fps must be a positive number');
        }
        const rangeRaw = flags.get('--range');
        const fcpxmlRanges = typeof rangeRaw === 'string' ? parseRanges(rangeRaw) : undefined;
        if (fcpxmlRanges && fcpxmlRanges.length > 1) {
          throw new CliError('E_USAGE', 'export fcpxml supports a single --range only (a concatenated timeline is an export-film concept)');
        }
        const range = fcpxmlRanges?.[0];
        const { result } = await exportFcpxml(ctx, projectArg, {
          out: outArg,
          ...(fps !== undefined ? { fps } : {}),
          ...(range ? { range } : {}),
        });
        out = {
          result,
          line:
            `${result.path} fcpxml ${result.version} ${result.frames}f ${result.durationSec}s ` +
            `clips=${result.clips} gaps=${result.gaps} ${result.bytes}B`,
        };
      } else if (group === 'export' && action === 'still') {
        const outArg = flags.get('--out');
        if (typeof outArg !== 'string' || outArg.length === 0) {
          throw new CliError('E_USAGE', 'export still needs --out <dir>');
        }
        const jpgRaw = flags.get('--jpg-quality');
        const jpgQuality = typeof jpgRaw === 'string' ? Number(jpgRaw) : undefined;
        if (jpgQuality !== undefined && (!Number.isInteger(jpgQuality) || jpgQuality < 1 || jpgQuality > 31)) {
          throw new CliError('INVALID', '--jpg-quality must be an integer 1..31 (lower is better)');
        }
        // 画幅（P29）：静帧与成片同一套 `--size/--fit`，否则「预览 vs 成片」没法同几何比对
        const stillSizeRaw = flags.get('--size');
        /** @type {{ w: number, h: number } | null} */
        let stillSize = null;
        try {
          stillSize = parseSizeArg(typeof stillSizeRaw === 'string' ? stillSizeRaw : undefined);
        } catch (err) {
          throw new CliError('INVALID', /** @type {any} */ (err)?.message ?? String(err));
        }
        const stillFitRaw = flags.get('--fit');
        if (typeof stillFitRaw === 'string' && stillFitRaw !== 'letterbox' && stillFitRaw !== 'cover') {
          throw new CliError('INVALID', `--fit must be letterbox|cover, got "${stillFitRaw}"`);
        }
        const { result } = await exportStill(ctx, projectArg, {
          at: typeof flags.get('--at') === 'string' ? /** @type {string} */ (flags.get('--at')) : undefined,
          format: typeof flags.get('--format') === 'string' ? /** @type {string} */ (flags.get('--format')) : 'png',
          out: outArg,
          ...(jpgQuality !== undefined ? { jpgQuality } : {}),
          ...(stillSize ? { size: stillSize } : {}),
          ...(typeof stillFitRaw === 'string' ? { fit: stillFitRaw } : {}),
        });
        out = {
          result,
          line: result.files.map((f) => `${f.file} ${f.bytes}B`).join('\n'),
        };
      } else if (group === 'export' && action === 'stems') {
        const outArg = flags.get('--out');
        if (typeof outArg !== 'string' || outArg.length === 0) {
          throw new CliError('E_USAGE', 'export stems needs --out <dir>');
        }
        const { result } = await exportStems(ctx, projectArg, { out: outArg });
        out = {
          result,
          line:
            `${result.stems.length} stems + ${result.mix ? 'mix.wav' : 'NO_MIX'} @ ${result.sampleRate}Hz/${result.channels}ch\n` +
            result.stems.map((s) => `  ${s.id}\t${s.durationSec}s\t${s.bytes}B`).join('\n'),
        };
      } else if (group === 'export' && action === 'gif') {
        const outArg = flags.get('--out');
        if (typeof outArg !== 'string' || outArg.length === 0) {
          throw new CliError('E_USAGE', 'export gif needs --out <file.gif>');
        }
        const rangeRaw = flags.get('--range');
        if (typeof rangeRaw !== 'string') throw new CliError('E_USAGE', 'export gif needs --range <a..b>');
        const gifRanges = typeof rangeRaw === 'string' ? rangeRaw.split(',') : [];
        if (gifRanges.length > 1) {
          throw new CliError('E_USAGE', 'export gif supports a single --range only (use a:b, not a list)');
        }
        const range = parseGifRange(rangeRaw);
        const fpsRaw = flags.get('--fps');
        const fps = typeof fpsRaw === 'string' ? Number(fpsRaw) : 12;
        const widthRaw = flags.get('--width');
        const width = typeof widthRaw === 'string' ? Number(widthRaw) : 640;
        const { result } = await exportGif(ctx, projectArg, { range, fps, width, out: outArg });
        out = {
          result,
          line: `${result.path} ${result.frames}f @${result.fps}fps ${result.width}px ${(result.bytes / 1024).toFixed(1)}KiB`,
        };
      } else {
        throw new CliError('E_USAGE', `unknown command: ${group} ${action}`);
      }

      if (progressJsonl) {
        // 流式模式下 stdout 必须**全是** JSON 行：最后一行是结果，不是人读文本
        emit(JSON.stringify({ type: 'result', ...out.result }));
      } else {
        emit(json ? JSON.stringify(out.result, null, 2) : out.line);
      }
      return EXIT.OK;
    } catch (err) {
      const failure = normalizeError(err);
      const payload = {
        ok: false,
        error: {
          code: failure.code,
          message: redactText(failure.message),
          ...(failure.extra?.currentHash ? { currentHash: failure.extra.currentHash } : {}),
          ...(failure.extra?.detail ? { detail: redactText(String(failure.extra.detail)) } : {}),
          // 失败分级（P27）：reason / causeCode / clipId 是给脚本分支用的，别只留在文案里
          ...(failure.extra?.reason ? { reason: failure.extra.reason } : {}),
          ...(failure.extra?.causeCode ? { causeCode: failure.extra.causeCode } : {}),
          ...(failure.extra?.clipId ? { clipId: failure.extra.clipId } : {}),
        },
      };
      const line = failure.extra?.currentHash ? `${failure.code} ${failure.extra.currentHash}` : failure.code;
      if (progressJsonl) {
        emit(JSON.stringify({ type: 'error', ...payload }));
      } else {
        emit(json ? JSON.stringify(payload, null, 2) : line);
      }
      stderr.write(`${failure.code}: ${redactText(failure.message)}\n`);
      return exitCodeFor(failure.code);
    }
  }

  return { run, root: ctx.root, stateDir: ctx.stateDir, outputRoot: ctx.outputRoot };
}

/**
 * @param {any} result
 * @returns {string}
 */
function formatInfo(result) {
  return [
    `project ${result.project}`,
    `hash    ${result.sourceHash}`,
    `stage   ${result.stage ? `${result.stage.w}x${result.stage.h}` : 'unknown'}`,
    `fps     ${result.fps?.value ?? 'unknown'}`,
    `tracks  ${result.tracks.total} (locked ${result.tracks.locked}, hidden ${result.tracks.hidden}, muted ${result.tracks.muted})`,
    `clips   ${result.clips.total}`,
    `diag    ${result.diagnostics.total} (errors ${result.diagnostics.errors}, warnings ${result.diagnostics.warnings})`,
  ].join('\n');
}

export { CliError, EXIT };
