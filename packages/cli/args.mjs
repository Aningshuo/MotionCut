/**
 * 参数解析（WP18）。
 *
 * 手写而不是上库：本树装不了依赖。规则简单到可以一句话说完：
 * `opencut [全局开关] <组> <动作> [目标] [动作开关]`。
 * 不认识的开关直接 `E_USAGE`——静默忽略会让人以为生效了。
 */

import { CliError } from './errors.mjs';

export const VALUE_FLAGS = new Set([
  '--studio-url', '--project-id', '--grant', '--action-file',
  '--project',
  '--root',
  '--ops',
  '--spec',
  '--audio-spec',
  '--state-dir',
  '--env',
  '--film-module',
  '--render-module',
  '--projects-module',
  '--limit',
  '--range',
  '--fps',
  '--out',
  '--plan-out',
  '--content-port',
  '--frames-out',
  '--quality',
  '--codec',
  '--pix-fmt',
  '--profile-out',
  '--capture-concurrency',
  '--settle-ms',
  '--max-scan-ms',
  '--at',
  '--format',
  '--jpg-quality',
  '--width',
  '--size',
  '--fit',
  '--subtitle-style',
  '--ffmpeg-path',
  '--budget-mem-mb',
  '--budget-sec',
  '--progress',
  '--alpha-format',
  '--alpha-mode',
  '--loudness',
]);

/** 可重复的开关：重复出现时按逗号合并，`--range 2:4 --range 6:8` == `--range 2:4,6:8`。 */
export const REPEATABLE_FLAGS = new Set(['--range']);

/**
 * @param {Map<string, string | true>} flags
 * @param {string} name
 * @param {string} value
 */
function setFlagValue(flags, name, value) {
  if (!REPEATABLE_FLAGS.has(name)) {
    flags.set(name, value);
    return;
  }
  const previous = flags.get(name);
  flags.set(name, typeof previous === 'string' && previous.length > 0 ? `${previous},${value}` : value);
}

export const BOOL_FLAGS = new Set([
  '--confirm',
  '--json',
  '--dry-run',
  '--help',
  '-h',
  '--version',
  '-v',
  '--allow-write',
  '--also-compat',
  '--estimate',
  '--subtitle-burn',
  '--alpha',
]);

/**
 * @param {readonly string[]} argv
 * @returns {{ flags: Map<string, string | true>, positional: string[] }}
 */
export function tokenize(argv) {
  /** @type {Map<string, string | true>} */
  const flags = new Map();
  /** @type {string[]} */
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;

    if (token === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--') && token.includes('=')) {
      const eq = token.indexOf('=');
      const name = token.slice(0, eq);
      const value = token.slice(eq + 1);
      if (!VALUE_FLAGS.has(name) && !BOOL_FLAGS.has(name)) {
        throw new CliError('E_USAGE', `unknown flag ${name}`);
      }
      setFlagValue(flags, name, value);
      continue;
    }
    if (VALUE_FLAGS.has(token)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new CliError('E_USAGE', `${token} needs a value`);
      }
      setFlagValue(flags, token, value);
      i += 1;
      continue;
    }
    if (BOOL_FLAGS.has(token)) {
      flags.set(token, true);
      continue;
    }
    if (token.startsWith('-') && token !== '-') {
      throw new CliError('E_USAGE', `unknown flag ${token}`);
    }
    positional.push(token);
  }

  return { flags, positional };
}

/**
 * @param {readonly string[]} positional
 * @returns {{ group: string, action: string, target?: string }}
 */
export function parseCommand(positional) {
  const [group, action, target, ...rest] = positional;
  if (!group) throw new CliError('E_USAGE', 'no command given (try: opencut --help)');
  if (group === 'library-list' || group === 'library-action') {
    if (target !== undefined || rest.length > 0) throw new CliError('E_USAGE', `${group} 只接受一个工程路径`);
    return { group: 'library', action: group === 'library-list' ? 'list' : 'action', ...(action === undefined ? {} : { target: action }) };
  }
  if (rest.length > 0) {
    throw new CliError('E_USAGE', `unexpected argument: ${rest[0]}`);
  }
  if (!action) throw new CliError('E_USAGE', `${group}: an action is required`);
  return { group, action, ...(target !== undefined ? { target } : {}) };
}

export const HELP = `opencut — 机器接口（CLI）

用法：
  opencut project list [--json]
  opencut project info <path> [--json]
  opencut film read <project> [--json]
  opencut film apply <project> --ops <file.json> [--json] [--dry-run]
  opencut library-list <project> --studio-url <local-url> --project-id <id> [--json]
  opencut library-action <project> --studio-url <local-url> --project-id <id> --grant <ticket> --action-file <action.json> --allow-write --confirm [--json]
  opencut export start <project> --spec <spec.json> [--audio-spec <audio.json>] [--json] [--dry-run]
  opencut export status <jobId> [--json]
  opencut export cancel <jobId> [--json]
  opencut export film <project> --out <file.{mp4|webm|mov}> [--range a:b[,c:d...]] [--fps 30|29.97|23.976|30000/1001] [--quality draft|standard|high] [--codec h264|hevc|vp9|prores422hq|prores4444] [--pix-fmt auto|420|444] [--size 1080p|WxH] [--fit letterbox|cover] [--subtitle-burn] [--alpha [--alpha-format prores4444|png-seq] [--alpha-mode premultiplied|straight]] [--loudness off|streaming|broadcast] [--plan-out plan.json] [--frames-out dir] [--json] [--dry-run]
  opencut export film <project> --estimate [--settle-ms 454.79] [--json]   只估算不导出，不写任何文件
  opencut export fcpxml <project> --out <file.fcpxml> [--range a:b] [--fps 30] [--json]
  opencut film export fcpxml --project <project> --out <file.fcpxml>   （同上，任务书写法）
  opencut export still <project> --at <t|t1,t2> [--format png|jpg] [--jpg-quality 2] --out <dir> [--json]
  opencut export stems <project> --out <dir> [--json]
  opencut export gif <project> --range <a..b> --fps <n> --width <px> --out <file.gif> [--json]

全局：
  --json               stdout 只输出一个 JSON 对象
  --project <path>     指定工程作用域（等同于位置参数 <project>）
  --dry-run            只校验不写盘；export start 只回显 spec
  --audio-spec <file>  音频时间线 JSON（duration + clips），随导出一起提交
  --spec <file>        export start 的作业 spec。字段：jobId / projectId / owner / kind=video /
                       range 或 ranges（1..100 段）/ codec h264|hevc|prores422hq|prores4444 /
                       quality draft|standard|high / fps / loudness off|streaming|broadcast /
                       subtitleBurn / subtitleStyle / outputDir / expectedHash。
                       alpha 明确拒绝（ALPHA_REQUIRES_STAGE）。start 立刻返回 jobId+pid，
                       worker 在后台跑；用 export status / cancel 跟进。
                       带网页片段（iframe/page）的工程会自动走舞台取帧（P49），
                       进度里 stage=capture → encode；同一个 outputDir 同时只允许一个作业
                       （占用者的 pid 还活着 → EXPORT_OUTPUT_BUSY / 退出码 3，P50）。
                       内存吃紧时新作业会先等一会儿，等不到就 RESOURCE_PRESSURE（退出码 3，
                       记录在 <renderStateDir>/pressure/<jobId>.json，P52）。
  --range a:b[,c:d]    export film 的导出区间（秒）。可重复或逗号分隔，按给出顺序**拼接**：
                       --range 2:4 --range 6:8  →  4.000s（2:4 后接 6:8）
                       多段按 round(t*fps) 对齐帧格（段内帧数=起止帧之差）；单段保持历史口径。
                       fcpxml/gif 只支持单段
  --fps 30             export film 的帧率（缺省 30）。接受 30 / 29.97 / 23.976 / 59.94 /
                       30000/1001；29.97 → 30000/1001、23.976 → 24000/1001、59.94 → 60000/1001
                       （不是 2997/100）。帧数=round(t×num/den)、时长=frames×den/num，容器
                       的 r_frame_rate 就是那个分数。非法（0/负数/>240/29.97.5）→ INVALID_FPS
  --out <file.mp4>     export film 的产物路径（必需；已存在时自动加后缀）
  --plan-out <file>    把完整导出计划写成 JSON（可复现性比对用）
  --content-port <n>   舞台内容 origin 端口（缺省取 env.contentPort；0 = 系统分配）
  --frames-out <dir>   把舞台取到的 PNG 序列留在这个目录（默认用临时目录并在导出后删除）
  --quality <档>       画质档 draft|standard|high（缺省 standard；standard 在 720p 满足 p99≤8）
  --codec <名>         编码 h264（缺省，mp4/aac）|hevc（mp4/hvc1/aac）|vp9（webm/opus）|
                       prores422hq（mov/pcm_s16le）。--out 的扩展名必须匹配（.mp4/.webm/.mov），
                       不自动改路径；alpha 只走 prores4444/png-seq，不能与 --codec 同用
  --pix-fmt <模式>     auto（缺省，跟随档位表；standard/high 是 yuv444p）|420（兼容优先，
                       yuv420p + High/Main/Profile 0）|444（强制 yuv444p）。可与 --range、
                       --size/--fit、--subtitle-burn、--loudness 组合；prores 不吃 → E_USAGE
  --profile-out <file> 把取帧的逐帧分项耗时写成 JSON（settle/ipc/screenshot/write/hash）
  --capture-concurrency <n> 并行取帧的页数（缺省按核数与视频条数自适应；1 = 退回串行）
  --also-compat        同时再产一份 4:2:0/compat 副本（xxx.compat.mp4，给老播放器/硬解用）
  --size <1080p|WxH>   输出画幅（缺省跟随舞台 1280×720）；1080p/portrait/4k 或 1080x1920
  --fit <letterbox|cover> 画幅策略：letterbox 留黑边不裁内容（缺省）、cover 填满裁边
  --subtitle-burn      出三件套：<name>-master.mp4（无字幕）+ <name>-subbed.mp4（烧录）+ <name>.vtt
  --subtitle-style <JSON|@file|k=v,...> 烧录样式（S41 schema）：fontSizeRatio/color/outlineRatio/
                       bottomSafeRatio/align/bold…；outlineRatio 相对**字号**（0.22 → 4px）。
                       非法值回退默认并在 stderr/results 里给 warning。旧程序的 style 入参
                       仍按「相对画面高」解释，两个字段同名不同义，按入口区分
  --ffmpeg-path <file> 指定 ffmpeg（烧录需要带 libass 的构建；缺省用 PATH 里的 ffmpeg）
  --budget-mem-mb <n>  导出期间整棵进程树的 RSS 上限（超了报 BUDGET_EXCEEDED 并停）
  --budget-sec <n>     导出墙钟上限（超了报 BUDGET_EXCEEDED 并停）
  --alpha              透明输出（P31）：保留舞台真正的 alpha 通道。只出画面、不出音轨；
                       工程里必须有 page 片段（纯实拍没有可保留的透明度 → ALPHA_REQUIRES_STAGE）
  --alpha-format       prores4444（默认，--out take.mp4 会写成 take.mov）| png-seq（take/ 目录 + take.zip；
                       超过 2GB 时改为 take.part001.zip… 分卷，不落帧目录）
                       结果里带 hasAlpha / framesWithAlpha / firstFrame / lastFrame / maxTransparentRatio / perFrame
  --alpha-mode         premultiplied|straight：alpha 极性。**默认随格式走**——prores4444 预乘（Apple 惯例，
                       给 NLE 吃）、png-seq 非预乘（PNG 规范）。png-seq + premultiplied 直接拒（E_USAGE）
  --loudness           off（默认，行为不变）| streaming（I=-14 LUFS）| broadcast（I=-23 LUFS）：
                       两遍 loudnorm 标准化成片响度，真峰值 ≤ -1.0 dBTP；测不到（静音/超短）报
                       LOUDNESS_UNMEASURABLE 并照常出片；结果里的 loudness 段带输入/输出 LUFS、TP、实际增益
  --progress jsonl     export film 的进度按行输出到 stdout：每行一个 JSON（type=progress|result|error），
                       宿主可逐行读；不带这个开关时 stdout 仍只有一个结果对象
  --estimate           只估算导出耗时，不导出、不写任何文件（可以反复跑）
  --settle-ms <n>      预估时假设的每帧 settle（毫秒）；不给就按素材关键帧间隔推
  --max-scan-ms <n>    单条素材关键帧扫描的时间预算（缺省 5000；超了退化成抽样并标 sampled）
  fcpxml               film export fcpxml 是 export fcpxml 的别名（同一套语义，只写一遍）
  --at <t1,t2>         export still 的时刻（秒，逗号分隔；允许小数）
  --format <png|jpg>   export still 的格式（缺省 png；png 无损）
  --jpg-quality <1-31> export still 的 JPG 质量（ffmpeg -q:v，越小越好，缺省 2）
  --width <px>         export gif 的输出宽度（缺省 640，高度按比例）
  SIGINT/SIGTERM      export film 期间收到信号 → 协作式中止（SIGTERM→SIGKILL 停 ffmpeg）→ 退出码 9
                      （EXPORT_CANCELLED），不留半截产物；取消后可以直接重跑同一条命令

宿主级（写在这里但必须给 bin.mjs，由它在建 CLI 之前消费）：
  --root <path>        沙箱根（默认取 env.projectsRoot，否则 cwd）
  --state-dir <path>   opId 幂等账本目录（默认 env.tmpRoot/cli-state）
  --env <file>         OPENCUT_ENV_JSON（也可用同名环境变量）
  --film-module <m>    注入 film 端口（集成用；默认 WAIT_MAIN_FILM）
  --render-module <m>  注入 render 端口
  --projects-module <m> 注入 projects 端口

退出码：0 OK 1 用法 2 INVALID 3 CONFLICT 4 E_PATH_ESCAPE 5 NOT_FOUND 6 IO 7 未接线 8 作业失败 9 已取消
输出冲突（同一路径已有作业在写）是 3 CONFLICT，错误码 EXPORT_OUTPUT_BUSY；取消是 9 EXPORT_CANCELLED；
内存压力下拒绝新作业也是 3 CONFLICT，错误码 RESOURCE_PRESSURE；
输出目录不可写（只读/权限）是 6 IO，错误码 EXPORT_OUTPUT_UNWRITABLE
stdout 只放结果与错误码；日志与细节走 stderr。`;
