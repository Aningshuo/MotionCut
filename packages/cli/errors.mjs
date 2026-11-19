/**
 * CLI 的错误码与退出码（WP18）。
 *
 * 约定：**stdout 只放结果与错误码**，人读的细节一律走 stderr。
 * 退出码是稳定的机器契约，脚本可以只靠它分支：
 *
 *   0 OK         1 E_USAGE      2 INVALID      3 CONFLICT     4 E_PATH_ESCAPE
 *   5 NOT_FOUND  6 IO           7 E_NOT_WIRED  8 JOB_FAILED  9 CANCELLED
 *
 * 为什么取消要单独一个号（P28）：取消是**用户/宿主的意图**，不是作业失败。
 * 以前它落在 8（JOB_FAILED），脚本要区分「跑挂了」和「我喊停的」只能去认 stderr 文本。
 * 现在 `EXPORT_CANCELLED` / `CANCELLED` 一律 9，`EXPORT_OUTPUT_BUSY` 归 3（CONFLICT：
 * 资源被别人占着，换个路径就能成功，与 INVALID 不是一类）。
 *
 * `EXPORT_OUTPUT_UNWRITABLE`（P31）归 6（IO）：目标目录不可写是**文件系统**的问题，
 * 换个路径或者改权限就能过，跟 INVALID（参数/计划不对）和 JOB_FAILED（跑到一半挂了）都不是一类。
 *
 * `CONFLICT`/`INVALID`/`NOT_FOUND`/`IO` 与 `contracts/edit-ops.ts` 的 `EditErrorCode`
 * 同名同义，CLI 不新造语义；`E_PATH_ESCAPE`/`E_NOT_WIRED`/`JOB_FAILED` 是 CLI 层
 * 自己的边界错误（合同里没有"路径越界"和"端口未接线"这两种情况）。
 */

/** @typedef {'E_USAGE' | 'INVALID' | 'CONFLICT' | 'E_PATH_ESCAPE' | 'NOT_FOUND' | 'IO' | 'LOCKED' | 'QUEUE_TIMEOUT' | 'E_NOT_WIRED' | 'WAIT_MAIN_FILM' | 'E_WRITE_DENIED' | 'E_CONFIRM_REQUIRED' | 'E_RATE_LIMITED' | 'JOB_FAILED' | 'E_OUTPUT_INVALID' | 'INVALID_RANGE' | 'MEDIA_MISSING' | 'MEDIA_DURATION_UNKNOWN' | 'UNSUPPORTED_SCENE_CLIP' | 'UNSUPPORTED' | 'INVALID_FILM' | 'EMPTY_FILM' | 'OUTPUT_UNVERIFIED' | 'CANCELLED' | 'NO_FILM' | 'FRAME_THREW' | 'FRAME_TIMEOUT' | 'STAGE_BOOT_FAILED' | 'PROJECT_NOT_OPEN' | 'SUBTITLE_PARSE_FAILED' | 'SUBTITLE_MISSING_GLYPH' | 'SUBTITLE_UNSUPPORTED' | 'SUBTITLE_BURN_UNAVAILABLE' | 'BUDGET_EXCEEDED' | 'EXPORT_CANCELLED' | 'EXPORT_OUTPUT_BUSY' | 'SCENE_CAPTURE_FAILED' |
 * 'EXPORT_OUTPUT_UNWRITABLE' | 'ALPHA_REQUIRES_STAGE' | 'ALPHA_ENCODE_LOST' |
 * 'LOUDNESS_UNMEASURABLE' | 'CODEC_UNAVAILABLE' | 'INVALID_FPS' | 'RESOURCE_PRESSURE' | 'STUDIO_UNREACHABLE' | 'NEEDS_STUDIO'} CliErrorCode
 *
 * `CODEC_UNAVAILABLE`（P38）是环境能力问题（这个 ffmpeg 没编进 libx265 / libvpx-vp9 /
 * prores_ks / opus），不是用户参数错：归 8（JOB_FAILED）——换一台机器或换个构建就能过，
 * 与 `E_USAGE`（参数组合不成立）不是一类。
 *
 * `INVALID_FPS`（P42）是**参数错**（`--fps 0` / `-1` / `1000` / `29.97.5`）：归 2（INVALID）。
 * 它有自己的码而不是复用 INVALID，是因为帧率解析牵扯有理数归一（30000/1001），
 * 用户/脚本需要一眼分清「帧率写错了」和「别的参数写错了」。
 *
 * `LOUDNESS_UNMEASURABLE`（P34）是**警告码**，不会作为退出码出现：它只出现在结果的
 * `loudness.code` 里，表示「这段声音没有可归一的响度（静音/超短）」，片子照常出。
 * 把它当失败会让静音工程导不出来——而静音是合法作品，不是坏文件。
 */

export const EXIT = Object.freeze({
  OK: 0,
  USAGE: 1,
  INVALID: 2,
  CONFLICT: 3,
  PATH_ESCAPE: 4,
  NOT_FOUND: 5,
  IO: 6,
  NOT_WIRED: 7,
  JOB_FAILED: 8,
  CANCELLED: 9,
});

export class CliError extends Error {
  /**
   * @param {CliErrorCode} code
   * @param {string} message
   * @param {Record<string, unknown>} [extra] 结构化附加字段（如 CONFLICT 的 currentHash）
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.extra = extra;
  }

  /** 机器可读形态；error code 永远在顶层，便于 stdout 只打印它。 */
  toJSON() {
    return { code: this.code, message: this.message, ...this.extra };
  }
}

/**
 * 合同错误码 / CLI 边界错误码 → 退出码。
 * @param {string} code
 * @returns {number}
 */
export function exitCodeFor(code) {
  switch (code) {
    case 'E_USAGE':
      return EXIT.USAGE;
    case 'INVALID':
    case 'INVALID_FPS':
    case 'LOCKED':
    case 'INVALID_RANGE':
    case 'MEDIA_MISSING':
    case 'MEDIA_DURATION_UNKNOWN':
    case 'UNSUPPORTED_SCENE_CLIP':
    case 'UNSUPPORTED':
    case 'INVALID_FILM':
    // M88：film.html 的时间诊断原样透出（TIME_PAST_END / TIME_INVERTED / BAD_TIME），
    // **退出码不变**（仍是 2）：越界出点是参数与工程的组合不成立，不是运行期故障。
    case 'TIME_PAST_END':
    case 'TIME_INVERTED':
    case 'BAD_TIME':
    case 'EMPTY_FILM':
    case 'SUBTITLE_PARSE_FAILED':
    case 'SUBTITLE_UNSUPPORTED':
    // 透明导出需要舞台取景（工程里要有 page 片段）：纯实拍没有可保留的透明度，
    // 这是参数与工程的组合不成立，不是运行期故障。
    case 'ALPHA_REQUIRES_STAGE':
      return EXIT.INVALID;
    case 'CANCELLED':
    case 'EXPORT_CANCELLED':
      return EXIT.CANCELLED;
    case 'CONFLICT':
    case 'EXPORT_OUTPUT_BUSY':
    // P52：内存压力下不放新作业 —— 可重试的"现在不行"，与 EXPORT_OUTPUT_BUSY 同一类
    case 'RESOURCE_PRESSURE':
      return EXIT.CONFLICT;
    case 'ALPHA_ENCODE_LOST':
      // 编码器把 alpha 丢了：产物本身是坏的，按作业失败处理（不是参数问题）
      return EXIT.JOB_FAILED;
    case 'E_PATH_ESCAPE':
      return EXIT.PATH_ESCAPE;
    case 'NOT_FOUND':
      return EXIT.NOT_FOUND;
    case 'IO':
    case 'EXPORT_OUTPUT_UNWRITABLE':
      return EXIT.IO;
    case 'E_NOT_WIRED':
    case 'WAIT_MAIN_FILM':
    case 'NEEDS_STUDIO':
      return EXIT.NOT_WIRED;
    default:
      return EXIT.JOB_FAILED;
  }
}
