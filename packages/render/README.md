# packages/render

渲染作业、音频混音与输出校验。所有能力都直接调用本机 `ffmpeg` / `ffprobe`（本树不引入第二套编码器）。

## 文件

| 文件 | 职责 |
|---|---|
| `job.mjs` | 作业状态机：`waiting → validate → (frames) → encode → (mux) → verify → commit → done`，串行队列、取消、工程哈希校验、**不覆盖旧名** |
| `ffmpeg.mjs` | 帧序列 + 单条音轨 → H.264/AAC MP4；`.partial` → 原子提交 |
| `audio-mix.mjs` | DSP：多轨混音（`mixClips`）、写 f32le WAV（`writeWav`）、与画面封装（`muxWithVideo`）、一步到位（`renderAudioMixExport`） |
| `verify.mjs` | `ffprobe` 读回 + 完整 decode；`avSyncDeltaSec` |
| `mix.mjs` | 混合导出（画面 + 声音）的计划与校验 |
| `budget.mjs` / `frames.mjs` | 并行预算、帧生产 |
| `film-plan.mjs` | film.html → 导出计划（时长/区间/帧数/画面片段/音频时间线），源路径双守卫 |
| `film-export.mjs` | 计划 → 成片：无声画面 → 混音 → 封装 → 校验；有网页片段时画面整段来自舞台取帧 |
| `stage-capture.mjs` | 舞台取帧（P13）：真 Studio + 内容 origin + Chromium，`film.frame(t)` 逐帧截图 |
| `export-job.mjs` | 导出作业（P28）：作业句柄（`cancel`/`progress`/`done`）、进度事件、**跨进程**输出占用锁 |
| `scene-clips.mjs` | 场景片段（P27）：`src` 解析与前置检查（缺文件/跨源/越界）、失败分级 `SCENE_CAPTURE_FAILED` |
| `alpha-export.mjs` | 透明输出（P31）：逐帧判透明、ProRes 4444 编码、PNG 序列 + store-only zip（流式写、超 2GB 分卷） |
| `alpha-polarity.mjs` | alpha 极性（P33）：预乘/非预乘的默认值、预乘滤镜链、格式 × 极性口径表 |
| `png-seq.mjs` | PNG 序列的体积预算与分卷（P33）：取样外推、整帧切卷、`part001` 命名 |
| `loudness.mjs` | 响度标准化（P34）：两遍 `loudnorm`（先测后规范化）、`ebur128` 复核、三档预设 |
| `timeline-range.mjs` | 多段范围（P36）：range 校验、帧对齐段表、帧号→原片时间映射；单段保持 R21 口径 |
| `png.mjs` | PNG 最小编解码（P31/P32）：读 alpha 通道、合成预览覆盖层；无第三方依赖 |
| `concurrency.mjs` | 取帧通道数规则（核数 × 0.75 封顶 6，按视频条数压到 3）；取帧与预估共用同一个数 |
| `media-probe.mjs` | 素材体检（P21）：`probeVideoProfile` 读时长/帧率/关键帧间隔/codec/pixFmt/码率；扫描超预算退化成抽样并标 `sampled` |
| `export-estimate.mjs` | 导出耗时预估（P21）：`estimateExport` 把 plan + 素材 profile 折成 `{captureSec, encodeSec, finishSec, totalSec}` 与一段人话理由 |
| `fcpxml.mjs` | FCPXML 1.9 导出（P22）：`buildFcpxml` / `parseFcpxml` / `verifyFcpxml`（回读对账） |
| `subtitles.mjs` | 字幕烧录（P23/P37/P39/P40）：旁挂 `.vtt`/`.srt` → 时间线映射（多段按段切） → 行排 → ASS → `subtitles` 滤镜；样式只走 `layers/subtitle-style.mjs` 的 `toAssStyle()`，行排只走 `film-core/subtitle-layout.mjs` 的 `planSubtitleLines()` |
| `codec-matrix.mjs` | 编码矩阵（P38）与像素格式策略（P41）：h264/hevc/vp9/prores422hq 的容器、编码器、质量档、音频、回读口径、`--pix-fmt` 的 profile 收敛；`--out` 扩展名与编码器探测共用这一张表 |
| `fps.mjs` | 有理帧率（P42）：`30`/`29.97`/`23.976`/`59.94`/`30000/1001` → `{num, den}`；帧数、时长、帧位置、字幕网格全是整数运算 |
| `delivery-size.mjs` | 交付画幅（P24）：`--size`/`--fit` 的几何（letterbox/cover）、视口与 ffmpeg 变换 |
| `budget-guard.mjs` | 预算守卫（P24）：整棵进程树 RSS 采样；`ps` 不可用时降级成整机可用内存，口径标在结果里 |
| `quality.mjs` | 画质档 `draft`/`standard`/`high` → `{crf, preset, pixFmt}`（P17） |
| `stills.mjs` | 静帧导出：`export still` 的整帧取图与 PNG→JPG（P18） |
| `stems.mjs` | 分轨导出：每条音频片段一个 wav + `mix.wav`（P18） |
| `gif.mjs` | PNG 序列 → 调色板 GIF（palettegen/paletteuse + sierra2_4a，P18） |

## 带声导出的时长规则（R5 定死）

`muxWithVideo` 不再用 `-shortest`。旧写法实测会把 `2s 音频 + 3s 视频` 封成
**video 1.9s / audio 2.0s**，片尾 0.1s 只有声音没有画面。

现在的规则：

1. 先 `ffprobe` 两路：video 流时长、audio 流时长；
2. `target = min(video, audio)` —— **只裁不补**，不做静音 pad；
3. `-t target` 卡容器，再用 `-frames:v round(target × fps)` 钉死视频帧数
   （只写 `-t` 时 stream copy 会多带 1–2 帧）；
4. 封装后回探：两路流时长差 > 1 帧，报 `OUTPUT_UNVERIFIED` 并删除产物。

结果：两路流时长差 ≤ 1 帧（30fps = 0.0333s），容器时长 = `target`。

**片尾要单独验**：容器 duration 对不代表末帧有画面。做法是解末帧灰度图算平均亮度，
并与首帧逐像素比（见 `test/av-export.test.mjs` 的 R5-A3）。

## 音频口径

- 变速保持音高：只用 `atempo`，单级 0.5–2.0，超出串联（`0.1 = 0.5×0.5×0.5×0.8`）。
- `at` 精确到样本 `round(at × sampleRate)`；`volume` 线性；`fade` 幅度线性。
- 逐样本相加；峰值超过 1 才启软限幅（拐点 0.95，渐近线严格 < 1）。
- 输出 WAV 为 PCM f32le，便于逐样本比对；封装为 AAC 192k。

## 导出作业（P28 / P30）

`export film` 不再是一个黑箱进程：`packages/render/export-job.mjs` 给它一个作业句柄。
**宿主接这一层，不要再去轮询 partial 文件大小猜阶段。**

### 最小接线（照抄这 10 行）

```js
import { createExportJob, runExportJob } from './render/export-job.mjs';

const job = createExportJob({ outputPath: 'out.mp4', id: 'job-42' }); // 立刻占住输出路径
const off = job.on((e) => {
  if (e.type === 'progress') ui.progress(e.phase, e.frame, e.totalFrames, e.stage);
  if (e.type === 'cancel')   ui.markCancelled(e.reason);
  if (e.type === 'error')    ui.fail(e.code, e.message);        // e.code 是稳定字符串
});
try {
  const result = await runExportJob(job, () => exportFilm(ctx, project, { out, signal: job.signal }));
  // result.cancelTooLate === true 表示「用户按过中止，但按下时片子已经做完了」
} finally {
  off();                 // 退订（job 自己的清理已经由 runExportJob 做了）
}
// 别处：job.cancel('user')  →  协作式中止（SIGTERM → 1.5s → SIGKILL）
```

- **外部 AbortSignal**：`exportFilm` 也接受 `opts.signal`（CLI 的 Ctrl-C 走这条）。两者叠加时，
  谁先置位谁生效；`job.signal` 最终控制 ffmpeg / 浏览器的收摊。
- **`EXPORT_OUTPUT_BUSY` 怎么处理是宿主的产品决策**：这一层只**报错**（不排队、不重试），
  因为排队的语义是「第二个作业等第一个跑完再覆盖同一路径」，那属于队列层（M29）的判断。
  宿主拿到 `err.code === 'EXPORT_OUTPUT_BUSY'` 后可以选择排队、换路径或直接提示用户。
- **`done` 什么时候结算**：只有终态（`finish`/`fail`）结算。`cancel()` 只置位，
  所以「取消 → 等 done」不会提前返回——它要等到子进程真的收完摊。
- **取消来晚了**（P30）：若 `cancel()` 到达时工作已经做完（muxing 已 rename），
  作业会**照常成功**，`done` 事件与结果对象都带 `cancelTooLate: true`。理由：产物是完整的，
  把一个完整的片子报成失败、还顺手把锁留在用户目录里，是两处撒谎。

- **进度**：`planning → rendering(frame N/M) → muxing → done`。`rendering` 带
  `stage: capture | encode`——舞台取帧与 ffmpeg 编码各报一遍（**两段都从 1 数到 N**，
  宿主按 `stage` 分开算百分比，别拿后一段的帧号覆盖前一段的进度条）。
  编码进度来自 `ffmpeg -progress pipe:1`（**只在有人监听时才加**，默认命令行一个字节都不动）。
- **取消**：`cancel(reason)` 只置位 `signal`；真正停子进程的是听信号的那一层——
  `SIGTERM` → 1.5s 宽限 → `SIGKILL`。输出路径不留半成品（先写 `.partial`，成功才 rename），
  错误码 `EXPORT_CANCELLED`，CLI 退出码固定 **9**。
- **并发**：同一输出路径第二个作业报 `EXPORT_OUTPUT_BUSY`（CLI 退出码 3），不排队、不覆盖。

### 锁的生命周期

| 时机 | 谁做 | 做什么 |
| --- | --- | --- |
| 作业创建 | `createExportJob` | 对每个输出路径 `<out>` 用 `wx` 建 `<out>.opencut-lock`，写 `{ pid, jobId, at }`。已存在且**不是**陈旧锁 → `EXPORT_OUTPUT_BUSY` |
| 导出进行 | —— | 锁文件只是标记，**不续写**（`at` 是创建时刻，用来判 6h） |
| 成功收尾 | `job.finish()` | 发 `done` → resolve → `release()` 删锁 |
| 失败收尾 | `job.fail()` | 发 `error` → reject → `release()` 删锁 |
| 任何退出路径 | `exportFilm` 的 `finally` | 再调一次 `job.release()`（幂等）——这是 P30 补的兜底 |
| 进程崩溃 / 被 `kill -9` | **下一个**作业 | 读到锁里的 `pid`，`kill(pid, 0)` 抛 `ESRCH` → 判为陈旧锁 → 删掉重试一次；`at` 超过 6h 也判陈旧（防 pid 复用） |
| 锁文件写坏 / 读不出 | 下一个作业 | 当成陈旧锁，删掉重试一次 |

陈旧锁判定的实测（伪造一个死 pid 的锁再导出）见
`.local-runs/sub2/runs/R15/evidence/p30-hygiene.json` 的 `B4`。

CLI 侧：`--progress jsonl` 让 stdout 每行一个 JSON（`type=progress|done|result|error`），
宿主逐行读；不带这个开关时 stdout 仍然只有一个结果对象。
取消来晚时 `result` 里会多一个 `"cancelTooLate": true`。

## 网页片段（P13）

计划里只要有 `sceneClips`，画面就**整段**从舞台运行时抓（`stage-capture.mjs`）：
起 `startStudio({ port: 0, contentPort })`，打开工程，进
`__stage__.html?studio=…&fit=none`，对每个 t 调 `window.film.frame(t)`，等它
resolve（媒体 seeked + 两帧 rAF + 页面 draw 都完成了），再按舞台尺寸截图。
摆放、层级（track 0 在上）、box 缩放、淡入淡出全部由舞台做，本包不写第二套合成器；
`ffmpeg` 仍只负责「PNG 序列 → H.264」和后面的混音/封装。

**为什么整段都从舞台抓**：视频片段如果在 ffmpeg 里单独合成、网页再叠上去，
z 序/box/fade 就得在这边再实现一遍——两套合成器迟早不一致。舞台本来就是
预览用的同一份实现，让它出画面更接近用户看到的东西。代价是编码前的耗时随帧数线性增长：
含视频的工程单通道约 0.54s/帧（1280×720，大头是每条视频的 seek），
纯网页工程便宜得多——R15 实测每通道 83ms/帧，其中截帧 49%、场景自己的 `frame(t)` 20%、
PNG 落盘 18%、CDP 往返 13%（**瓶颈是截帧，不是 seek**）。

底层错误码一条都不许跳过：缺 `window.film` → `NO_FILM`；场景抛错 → `FRAME_THREW`；
超时 → `FRAME_TIMEOUT`（默认 20s/帧）；起不来 → `STAGE_BOOT_FAILED` / `PROJECT_NOT_OPEN`。
**导出这一层统一收口成 `SCENE_CAPTURE_FAILED`**（默认中止，绝不静默出黑帧）：原码留在
`causeCode` 里，`reason` 再分 `missing-src / missing-file / not-a-file / outside-project /
cross-origin / capture-failed` 六档。缺 html、跨源 URL、路径越界在**开浏览器之前**就拒
（`scene-clips.mjs`）——等舞台跑到第 N 帧才发现，用户白等几分钟，而且报出来的是"场景没有 film"，
跟真正的原因差着两层。

### 多通道取帧的一个坑（P27 实测）

场景用 `style="opacity: 0.5"` 叠在实拍上时，**默认多通道**（6 页）导出的成片里会**没有场景**：
多通道时只有一个 page 是前台窗口，Chromium 把其余判成被遮挡窗口，不再产出**独立合成层**的帧，
而 `opacity < 1` 的 iframe 正好是独立合成层（纯场景工程不受影响，因为不透明 iframe 走根图层）。
`--capture-concurrency 1` 或加 `--disable-backgrounding-occluded-windows
--disable-features=CalculateNativeWinOcclusion` 都能复现/修复；后两个参数现在写死在启动参数里。

**同步 `frame()`**：官方样例的 `frame(t)` 返回 `undefined`。舞台内部的调用点是
`found.frame(local).then(...)`，同步返回会 TypeError。取帧层在拿到场景窗口后把
`film.frame` 包成「永远返回 Promise」，**不依赖主线是否修好**那个调用点。
包之前 boot 绘制（t=0）会留一条假 `NO_FILM`，单独记在 `bootErrors` 里，不参与判定。

**信号归调用方**：`chromium.launch()` 显式关掉 playwright 自带的
`handleSIGINT/handleSIGTERM/handleSIGHUP`。它们默认会在收到信号时关掉浏览器再
`process.exit(130)`，把调用方的协作式中止（AbortSignal → 清理 → 非 0 退出）整条短路，
表现就是「Ctrl-C 之后退出码 130、临时目录留在 /tmp」。关掉之后，
`SIGINT` 只会让取帧循环在下一帧之前抛 `CAPTURE_CANCELLED`，`export film` 的
`finally` 才有机会删掉半截视频与帧目录。

**`probe()` 的四个数**：`duration` / `errors` / `sceneFrames` / `frames`。
`frames` 是舞台自己提交的帧数（含 boot 那次），`sceneFrames` 是所有场景 `frame()`
成功调用的次数——两者一起看才能区分「舞台在跑」和「场景真的在画」。
交叉淡化时同帧有两个场景可见，`sceneFrames` 会比 `frames` 多。

**成本（R8 实测，1280×720/30fps）**：900 帧整片墙钟 484s（约 536ms/帧），其中编码
只占 1.68s，**99.7% 的时间花在逐帧截图**；峰值 phys footprint 398MB（node 120 + Chromium 278）。
要快只能并行多页/多实例，或换掉每帧截图这条路。

## 取帧速度（P19）

把一帧拆开量（`--profile-out` 出逐帧 JSON，`settle` 是页面内 `await film.frame(t)`
的耗时，`ipc` 是 CDP 往返，`shot` 是 `page.screenshot()`）：

| 分项（每帧均值） | 优化前（1 页） | 优化后（6 页） |
|---|---|---|
| settle（舞台内等 seek + rAF） | 454.79 ms（91.6%） | 499.18 ms（90.1%） |
| screenshot（PNG 编码 + 传输） | 40.31 ms（8.1%） | 40.26 ms（7.3%） |
| ipc（CDP 往返） | 1.48 ms（0.3%） | 3.73 ms（0.7%） |
| write（落盘） | 7.76 ms | 10.57 ms |
| 每帧合计 | **504 ms** | **554 ms / 6 页 ≈ 92 ms 有效** |

单页 8 秒工程（240 帧）墙钟 **126.78s → 31.92s**。30 秒工程（900 帧）**470s → 189.33s**。

**快不动的那 90% 是舞台内部的 seek**：`content-origin.mjs` 的 `drawNow` 对每个可见
video/audio 调 `seekClip`，等 `seeked` + `requestVideoFrameCallback` + 2 次 rAF。
这段是主线代码，本包只读——所以提速只能靠"同时等多个 page"。

**样例素材是关键变量**：`test-video.mp4` 整段 8s/240 帧**只有 1 个关键帧**，seek 到 t
必须从第 0 帧解到 t，所以 settle 高达 450ms 且随 t 增长。把同一段画面重编成 1s GOP
（`-g 30`）后，同样的 30 秒工程在 3 页下只要 **134.21s**（原来 233s，采样器同开）。
真实素材一般 1~2s 一个关键帧，所以"取帧慢"在正常工程上远没有样例这么夸张。

**并发与内存的取舍**（30 秒工程，4 条视频，峰值取整棵进程树 phys footprint 之和）：

| 通道数 | 墙钟 | 峰值内存 |
|---|---|---|
| 1 | 470s（R9） | 735 MB |
| 3（默认） | 189.33s | 1.47 GB |
| 6 | — | 2.96 GB |

多一条视频在每个 page 里就多一份解码缓冲，约 +400MB/通道。默认按 `cores×0.75` 封顶 6，
且**视频片段 >2 条时压到 3**——1.5GB 的内存预算优先于墙钟。想更快就显式
`--capture-concurrency 6`（自己承担内存），想更省就 `--capture-concurrency 1`。

**分片**：默认连续分片（每页一段连续区间），让每页的 seek 单调递增，解码器能复用刚读
过的数据；`--capture-shard round-robin` 可切回轮转。两者输出**逐字节相同**，只是耗时不同。

**画质没有退**：900 帧 PNG 与优化前逐字节相同（900/900 sha 一致），抽 30 帧逐像素
最大差 **0**；整片 mp4 的 sha256 与 R9 完全一致（`2d9e5845…`）。

## 素材体检与耗时预估（P21）

上面那张 GOP 对照表说明了一件事：**用户抱怨的"导出慢"，很大一块是素材编码方式决定的**，
不是渲染实现慢。所以导出前先给素材做一次体检，再把体检结果折成一句"大概要等多久、为什么"。

### 素材体检 `probeVideoProfile(path)`

只读，不写文件。关键帧用 `ffprobe -skip_frame nokey -show_entries frame=pts_time` 取时间戳，
**不做整片解码**。

| 字段 | 口径 |
|---|---|
| `durationSec` / `fps` / `frames` | 容器与码流 |
| `keyframeCount` | 关键帧个数 |
| `avgGopSec` | **时长 / 关键帧数**。整段 1 个关键帧 → 等于时长；1s GOP → ≈1 |
| `maxGopSec` | 「相邻关键帧间隔」「首帧前」「末关键帧到片尾」三者最大值 |
| `codec` / `pixFmt` / `bitrate` | 直读 |
| `scanMs` / `scanMethod` / `sampled` / `note` | 这次体检花了多久、用的哪种扫描、有没有降级 |

扫描有硬预算（`maxScanMs`，默认 **5s**）：超了就退化成 `-read_intervals` 抽 6 个窗口，
标 `sampled: true`，并在 `note` 里写清"avgGop 是窗口内估计、maxGop 只是下界"。
60 秒以上的大文件在实测里根本用不到这条路（65s/24MB → 168ms），它的作用是防止
超大素材把一次"导出前预览"拖成几十秒。

### 耗时预估 `estimateExport({ plan, profiles, concurrency, settleMsPerFrame })`

```
totalSec   = captureSec + encodeSec + finishSec
captureSec = bootSec + frames × (settleMsPerFrame + perFrameOverheadMs) / (concurrency × efficiency) / 1000
encodeSec  = frames × encodeMsPerFrame[quality] / 1000
finishSec  = 1.5 + 0.25 × audioClips
```

**`settleMsPerFrame` 是入参，不是常数**——主线正在改 `content-origin.mjs` 的 settle，
写死一个数下轮就对不上。不传时按素材的关键帧间隔推：

```
settle(gop) = 454.79 + (gop − 8) × slope(concurrency)
slope(1) = 11.11 ms/s   slope(≥3) = 23.3 ms/s（中间线性，>3 不外推）
```

每一项常数的出处（改之前先看这张表）：

| 常数 | 值 | 出处 |
|---|---|---|
| `anchorSettleMs` | 454.79 ms | R10：8s/720p30/整段 1 关键帧/**单通道**/240 帧均值；R11 用 3fps 采样独立复测同一素材得 455.96（差 0.3%） |
| `slopeSerialMsPerGopSec` | 11.11 ms/s | R11 四点标定（0.5 / 1 / 2.67 / 8s，r²=0.975），`scripts/gop-settle-probe.mjs` |
| `slopeConcurrentMsPerGopSec` | 23.3 ms/s | R10 端到端对照反推：同工程 189.33s（单关键帧）↔ 134.21s（1s GOP），扣掉编码/收尾后折成每帧再还原到串行口径 |
| `perFrameOverheadMs` | 64.68 ms | R10 film30 profile：shot 40.30 + write 20.85 + hash 0.07 + ipc 3.46 |
| `parallelEfficiency` | 0.87 | R10 两次实测的并行效率均值（film30 0.890 / film8 0.848） |
| `encodeMsPerFrame` | 7.07 / 10.13 / 12.57 | R9 同一批 900 张 PNG 同参数重编实测（draft 6.36s / standard 9.12s / high 11.31s） |

实测校验（预估 vs 真实墙钟）：

| 工程 | 帧数/通道 | 预估 | 实测 | 偏差 |
|---|---|---|---|---|
| `film30`（单关键帧素材） | 900 / 3 | 193.3s | 189.33s | **+2.1%** |
| `film30-gop`（同工程，1s GOP 素材） | 900 / 3 | 137.0s | 134.21s | **+2.1%** |
| `film8`（单关键帧素材） | 240 / 6 | 30.6s | 31.92s | **−4.3%** |

`film30-gop` 那一行是**样本外**校验：它的素材没参与任何常数拟合。

### CLI

```sh
opencut export film <project> --estimate           # 人类可读一段 + 为什么
opencut export film <project> --estimate --json    # 结构化（estimate.reasons[] / contributions[]）
opencut export film <project> --estimate --settle-ms 300   # 主线改了 settle 之后按新值算
```

`--estimate` **不写任何文件**（工程树哈希前后一致），也能反复跑。和 `--out` /
`--plan-out` / `--frames-out` / `--profile-out` / `--also-compat` 同时出现会直接 `E_USAGE`——
"要了文件却没生成"比报错更糟。

已知边界：
- 预估的是**同机同盘**的耗时。换机器、换磁盘、后台有重负载都会偏。
- 只按"最稀关键帧的那条素材"算 settle（一帧要等所有在场视频就位，最慢的决定）。
  工程里素材差异极大时会偏保守。
- 缩放/变速片段的 `<timeMap>` 不在估算范围内（它对取帧时间的影响没测过）。

## 画质档（P17）

`renderFilmExport({ quality })` / CLI `--quality draft|standard|high`，缺省 `standard`。
档位只决定**默认**参数：显式传 `preset`/`crf`/`pixFmt` 仍然赢，主线那边老的
`{preset, crf}` 调用一个字都不用改。

三档在 1280×720/30fps/900 帧同一个工程上的实测（R9，本机 macOS arm64）：

| 档 | crf | preset | 色度 | 体积 | 码率 | 编码 900 帧 | 10 点 MAE 最大 | 10 点 p99 最大 | 兼容性（实测，见下） |
|---|---|---|---|---|---|---|---|---|---|
| `draft` | 26 | veryfast | yuv420p | 2.02 MiB | 564 kbps | 6.36s | 2.074 | 30 | 4:2:0，播放器覆盖面最广 |
| `standard` | 8 | medium | yuv444p | 7.88 MiB | 2204 kbps | 9.12s | **0.648** | **6** | High 4:4:4 Predictive：本机 AVFoundation / Chrome / Chromium 都能解，但不少硬解与移动端不支持 |
| `high` | 2 | slow | yuv444p | 12.29 MiB | 3436 kbps | 11.31s | 0.514 | 3 | 同 standard（同为 4:4:4） |
| `compat`（`--also-compat`） | 20 | veryfast | yuv420p | 3.06 MiB | 856 kbps | 6.31s | 1.525 | 23 | High 4:2:0：给老播放器/硬解/剪辑软件的副本，**不是交付画质档** |

**4:4:4 的真实边界**（P20 实测，证据在 `.local-runs/sub2/runs/R10/evidence/compat/`）：
macOS AVFoundation 用 `avconvert --preset Preset640x480` 真转码（不是 Passthrough，
输出真的变成 640×360）能过；Google Chrome 157 与 Chromium 158 的 `<video>` 都能解出
画面（canvas 取样非黑像素 100%、颜色数正常）。**没测到**的：Safari（WebDriver 需要
在 Safari 设置里手动开「允许远程自动化」，本机没开）、Firefox（未安装）、iOS 模拟器
（无 Xcode）。Windows/Android/微信/短视频平台本机不可测。所以"444 能不能播"目前的
结论只能覆盖 macOS + Chromium 系，移动端与国产 App 仍然未知——这也是 `--also-compat`
存在的原因。

**为什么 `standard` 必须是 4:4:4**：4:2:0 的色度在水平和垂直方向都减半，
文字反锯齿边与饱和色条边界上「一个像素被两个色度样本平均」，这个误差**与码率无关**。
实测把量化全部去掉（`crf=0` + `yuv420p`）p99 仍然是 17；`crf` 从 26 一路降到 4，
p99 都在 21 附近不动。要 p99 ≤ 8 只有 4:4:4 一条路，`crf` 只决定 4:4:4 里能做到多好。
`draft` 保留 4:2:0 是因为它的定位是体积/兼容性，不是交付画质——它的 MAE 已经贴着
2/255 的门槛，不适合当默认档。

**中间文件不再留在输出目录**：有声导出时 `muxWithVideo` 只做流拷贝，无声视频那份
`.video.partial.mp4` 不会被消费；以前只在 `catch` 里删，成功路径就把它留在
`output/` 里，用户会看到两个 mp4 分不清哪个是成品。现在 `finally` 里统一删，
成功失败都只剩成品（R8-F6）。

## 编码矩阵（P38）

```bash
opencut export film <project> --out take.mp4        # 缺省 h264（行为与 R22 逐字节相同）
opencut export film <project> --out take.mp4   --codec hevc
opencut export film <project> --out take.webm  --codec vp9
opencut export film <project> --out take.mov   --codec prores422hq
```

| codec | 容器 | 视频编码器 | 视频回读 | 音频 | 质量档 |
|---|---|---|---|---|---|
| `h264`（缺省） | `.mp4` | `libx264` | `h264` | `aac 192k` | 走 `quality.mjs` 的三档（不复制） |
| `hevc` | `.mp4` | `libx265` | `hevc` + **`hvc1`** | `aac 192k` | draft 28 / standard 20 / high 16，`yuv420p` |
| `vp9` | `.webm` | `libvpx-vp9` | `vp9`（standard/high 是 Profile 1 / 4:4:4） | `libopus 128k`（48k/2ch） | draft 30（4:2:0）/ standard 28 / high 24（4:4:4），`-b:v 0` 恒定质量 |
| `prores422hq` | `.mov` | `prores_ks` | `prores` / profile **3** / `yuv422p10le` | `pcm_s16le` | 不吃档位（帧内近无损） |

三条硬规则：

- **`--out` 的扩展名必须匹配**（`.mp4` / `.webm` / `.mov`）。不匹配直接 `E_USAGE`，
  **绝不自动改路径**——`.mp4` 里装 vp9 会让播放器与上传端都判错。
- **编码器先探测**：`libx265` / `libvpx-vp9` / `prores_ks` / `libopus` / `pcm_s16le` 任一缺失，
  在开渲之前报 `CODEC_UNAVAILABLE`（带缺的编码器名）。本机 ffmpeg 8.1.2 全部具备。
- **alpha 只走 `prores4444` / `png-seq`**：`--alpha` 与 `--codec` 同时给 → `E_USAGE`
  （透明导出自己决定编码，见 P31）。`--also-compat` 按定义是 H.264 4:2:0，
  与 `--codec` 非 h264 同用也直接拒。

**为什么 vp9 的 standard 也是 4:4:4**：与 h264 同一个理由（R8 的色度地板）。实测
4:2:0 / crf 22 对 h264 基线只有 **36.3dB**，crf 一路降到 12 仍在 36.4 附近不动；
换 `yuv444p` 后 crf 28 直接到 **53.0dB**。draft 保留 4:2:0 是给"能播就行"的场景。

`--dry-run --json` 的 plan 里有 `codec: {name, container, encoder, audio, extension[, tag]}`，
结果里同样回一段（A6）。hevc 的 `hvc1` 由 `verifyOutput` 回读校验：写成 `hev1` 在 QuickTime
里放不出来，不能当成功。

## 兼容像素格式（P41）

`standard` / `high` 档为了让 p99 达标用 `yuv444p`（H.264 的 **High 4:4:4 Predictive**）。
那是「自己存档」的最优解，但不是「发给别人」的最优解 —— QuickTime/Safari、很多硬解、
部分剪映版本都放不出来。`--pix-fmt` 让**主产物**直接出兼容格式，而不是再产一份副本：

```bash
opencut export film <project> --out take.mp4 --pix-fmt 420            # 兼容优先（推荐交付）
opencut export film <project> --out take.mp4 --pix-fmt 444            # 显式要 4:4:4
opencut export film <project> --out take.mp4                          # auto：跟随档位表（默认，行为不变）
opencut export film <project> --out take.webm --codec vp9 --pix-fmt 420
```

| codec | `--pix-fmt` | 实际 `pix_fmt` | profile（ffprobe） | 播放风险 |
|---|---|---|---|---|
| `h264` | `auto` + standard/high | `yuv444p` | High 4:4:4 Predictive | QuickTime/Safari、多数硬解、部分剪映**放不出来**；ffmpeg/VLC/Chrome 软解没问题 |
| `h264` | `auto` + draft | `yuv420p` | High | 通用 |
| `h264` | `420` | `yuv420p` | High | **通用**（给微信/上传/剪辑软件都安全） |
| `h264` | `444` | `yuv444p` | High 4:4:4 Predictive | 同 auto + standard |
| `hevc` | `auto` / `420` | `yuv420p` | Main（+ tag `hvc1`） | Apple 生态/硬解友好；`hvc1` 是 QuickTime 的硬要求 |
| `hevc` | `444` | `yuv444p` | **Rext**（Range Extensions，ffprobe 的叫法；不钉 `-profile:v`，交给 x265） | 以软解为主 |
| `vp9` | `auto` + standard/high | `yuv444p` | Profile 1 | Chrome/Firefox 软解；Safari/移动端覆盖差 |
| `vp9` | `auto` + draft / `420` | `yuv420p` | Profile 0 | 通用（WebM） |
| `vp9` | `444` | `yuv444p` | Profile 1 | 同 Profile 1 |
| `prores422hq` | 任何值 | `yuv422p10le` | HQ（profile 3） | 剪辑软件专用；`--pix-fmt` 与它**互斥** → `E_USAGE` |

规则：

- **`auto` 一个字节都不改**：不追加 `-profile:v`、不改 crf/preset/pixFmt，三档 sha 与
  243d01a 逐字节相同（A1）。
- **profile 只在显式 `420`/`444` 时才钉**：`-pix_fmt yuv420p` 时 libx264 会自己挑 High，
  但 libx265/libvpx 的 profile 不能靠猜（猜错就是"文件能解但设备不认"）。
- **`--pix-fmt` 与 `--alpha` 互斥**：透明导出是 ProRes 4444（`yuva444p10le`）或 PNG 序列，
  像素格式由格式定义，不归这个开关管。
- **`--also-compat` 语义不变**：它仍是「额外产一份 `xxx.compat.mp4`」，仍然是 H.264 4:2:0，
  仍然不能与 `--subtitle-burn` / `--alpha` 组合。想"烧字幕 + 420"就用 `--pix-fmt 420 --subtitle-burn`。

`--dry-run --json` 的 plan 里带 `pixFmt` / `pixFmtMode` / `profile`，与 ffprobe 实际一致
（auto 时显示档位解析后的值）。

## 分数帧率（P42）

`--fps 29.97` 以前按 `2997/100` 送 ffmpeg：每帧差 0.0337ms，**一小时差 ~3.6 秒**，
而且容器里写着 `r_frame_rate=2997/100`，进 NLE 就被判"非标准帧率"。

```bash
opencut export film <project> --out take.mp4 --fps 29.97        # → 30000/1001
opencut export film <project> --out take.mp4 --fps 23.976       # → 24000/1001
opencut export film <project> --out take.mp4 --fps 30000/1001   # 直接写分数
opencut export film <project> --out take.mp4                    # 缺省 30
```

| 输入 | 真实帧率 | ffmpeg `-r` | 1 小时帧数 |
|---|---|---|---|
| `30` | 30/1 | `30` | 108000 |
| `29.97` | **30000/1001** | `30000/1001` | **107892** |
| `23.976` | **24000/1001** | `24000/1001` | 86314 |
| `59.94` | **60000/1001** | `60000/1001` | 215784 |
| `25.5`（自定义） | 51/2 | `51/2` | 91800 |

换算口径（全整数运算，不累加浮点）：

```
frames        = round(t × num / den)
duration      = frames × den / num
frameTime(i)  = (段起点帧 + i) × den / num
```

- 容器 `r_frame_rate` / `avg_frame_rate` 就是 `30000/1001`；10 秒片子 = **300 帧 / 10.010s**。
- **单段的输出时长有两种口径**（刻意保留）：整数帧率沿用 R21 的「窗口长度」（`2.01:4.02`
  的 `-t` 还是 2.01，sha 逐字节不变）；分数帧率改用帧格时长 `frames×den/num` ——
  `-t 10` 配 300 帧会在 10.0s 截断，元数据就漂了。
- 多段：每段先 `round(t×num/den)` 落帧格，接缝仍在帧上；`2:4,6:8` 在 29.97 下是
  2.002–4.004 + 6.006–8.008 = 120 帧 / 4.004s。
- **字幕**吃同一张网格：cue 的起止按 `floor`/`ceil` 落在 `i×den/num` 上，
  所以 VTT 里是 0.467/1.502 这种数（都是 1001/30000 的整数倍），不是 0.5。
- 非法（`0` / 负数 / `>240` / `29.97.5` / `abc`）→ `INVALID_FPS`，退出码 2，不产文件。

### 同轨 cue 单调（P43）

`floor` 起点 + `ceil` 终点是**故意**的（宁可多显示半帧，也不吞句首句尾）。但分数帧率下
前后两条各自向外扩一帧，就叠在一起——29.97 的格是 33.37ms，实测 34ms 里两条字幕
同时在画面上。落格后再过一次 `clampCueOverlaps`：

- 只对**原本不重叠**的相邻 cue（`prev.sourceEnd <= next.sourceStart`）生效：把后一条的
  起点推到前一条的终点。双语双行 / 卡拉 OK 这种原始重叠**保持原样**，不许被拆开；
- 压没了（`end <= start`）就补到 `start + 1 帧`；贴到片尾连一帧都放不下就丢掉——
  绝不输出 `start >= end` 的非法 cue；
- 按 `clipId` 分组：多段拼接是**同一轨的两个窗口**，同组内一起排，段与段之间也首尾相接；
- 结果 JSON 多两个数：`overlapClamped`（被推回去的条数）/ `overlapDropped`。

30fps 的锁定夹具（cue 边界都在格点上）`overlapClamped = 0` —— VTT / 三画幅 ASS 逐字节不变。

### 作业管线（P44）

`export start` 走的是另一条路（`job.mjs` 的 `RenderQueue`），R21 只改了 `export film`，
同一套产品于是有了两个帧率解析器。现在两条路共用 `fps.mjs`：

- `spec.fps` 的**外部形状不变**（还是数字 `29.97` / `30`），内部换成 `{num, den}`；
- `frames = round(t×num/den)`、`duration = frames×den/num`、起始帧号
  `round(start×num/den)`、`frameTimes` 走 `i×den/num`，ffmpeg 的 `-framerate` / `-r`
  送 `"30000/1001"`；
- 进度 JSON 多 `fpsRational` / `startFrame` / `durationSec`；`fps` 那个字段仍是
  **实测编码速度**（framesDone / elapsed），不是时间线帧率；
- 非法 fps → `INVALID_FPS`（退出码 2），在**建作业之前**就拒：不占 jobId、不落文件；
- PNG 序列编号是 1 基：`[2,4]` 在 29.97 下 `startFrame = 60`、`-start_number 61`、
  60 帧、2.002s。

## 多格式导出（P18）

三条命令都复用**现有**计划/舞台/混音链路，没有第二套合成器：

```bash
opencut export still <project> --at 5,15,25 [--format png|jpg] --out <dir>
opencut export stems <project> --out <dir>
opencut export gif   <project> --range 5..9 --fps 12 --width 640 --out <file.gif>
```

**still**：画面走 `stage-capture.mjs` 的 `captureAt(t)`——和 `export film` 同一个入口，
所以「这张静帧」和「视频里那一帧」是同一份合成结果。实测（R9，t=5/15/25）：
静帧 PNG 与导出时留下的 `frame-%06d.png` **逐像素相同（MAE=0，最大差 0）**，
与 mp4 解码帧的差是 0.86–1.07（纯编码损失）。PNG 直接落盘不再编码；JPG 才走一次
`-q:v`（默认 2）。

**stems**：`plan.audioMix.clips` 的顺序与 doc 里音频片段的顺序一致（同一套遍历、
同一套 muted 过滤），对不上直接 `INVALID_FILM`——把名字贴错比不导出更糟。
输出的每个 wav 都是**整片时长**，这样可以直接叠回时间线看位置对不对；观感上"只留
自己那 8 秒"反而看不出有没有错位。R9 实测 4 条 + `mix.wav`，全部
`pcm_f32le / 48000 Hz / 2ch / 30.000s`。

**gif**：帧仍然从舞台抓（不拿 mp4 转，避免二次编码），`--fps/--range` 直接进计划，
所以帧数恒等于 `round((b-a)*fps)`。调色板用 `palettegen=stats_mode=diff` 从整段统计
一张全局表，再 `paletteuse=dither=sierra2_4a`——单帧各自生成调色板会让每帧色表抖动、
播起来闪；不开抖动则渐变出现色带。`-loop 0` 写进 NETSCAPE2.0 扩展（实测
`loop_count=0`）。R9 实测 5..9s / 12fps / 640px → 48 帧、640×360、636 KiB，
两次导出**逐字节相同**。

**`--also-compat`（P20）**：`export film` 加这个开关会**顺手**再产一份
`xxx.compat.mp4`（420 / veryfast / crf20）。它**不重新取帧**——PNG 序列在导出过程中本来
就有，只多一次纯编码（900 帧 ≈ 6.3s，而重取一次要 190s）。默认不产；不加开关时输出与
R9 逐字节相同（`film8` 加不加开关 sha 都是 `17f672d3…`）：

```bash
opencut export film <project> --out film.mp4 --also-compat
# → film.mp4（standard/444） + film.compat.mp4（420）
```

## FCPXML 导出（P22）

把时间线导成 FCPXML **1.9**，让别的 NLE 能接着剪：

```bash
opencut export fcpxml <project> --out film.fcpxml [--range a:b] [--fps 30]
opencut film export fcpxml --project <project> --out film.fcpxml   # 同义写法
```

结构（`buildFcpxml(plan, opts)`）：

```
<fcpxml version="1.9">
  <resources>
    <format id="r1" frameDuration="1/30s" width height/>
    <asset id="r2" src="file:///绝对路径" start="0s" duration="240/30s" hasVideo hasAudio format="r1"/>
  </resources>
  <library><event><project><sequence format="r1" duration="900/30s" tcStart="0s">
    <spine>
      <asset-clip ref="r2" name="take-1" offset="0/30s" start="0/30s" duration="240/30s"/>
      <gap name="card-a1 (web scene not exported…)" lane="-2" offset="0/30s" duration="240/30s" note="…"/>
```

**时间一律 rational**：分子是帧数、分母是帧率，且不约分。

| 时长 | 30fps 写法 |
|---|---|
| 0 | `0/30s` |
| 1s | `30/30s` |
| 7.5s | `225/30s` |
| 8s | `240/30s` |

29.97 / 23.976 / 59.94 走 NTSC 口径（`frameDuration="1001/30000s"`）；其它非整数帧率直接抛错，
不写一个 NLE 读不了的怪值。

**轨道**：视觉片段优先挤主故事线（lane 0），同 lane 不重叠；主故事线用 `<gap>` 填满空隙
（FCPXML 要求主故事线连续，少填一段 NLE 就会把片尾截掉）。音频片段是带 `audioRole` 的
`<asset-clip>`，挂连接道。分配用贪心装箱，不靠"素材本来就不重叠"这个运气。

**网页片段是已知限制**：`sceneClips` 在导出时由舞台渲染，**没有对应媒体文件**，所以降级成
占位 `<gap>` + `note`，`name` 也直说 `web scene not exported`。它保住的是时间线位置，
不是画面——这一段的视觉内容必须在 NLE 里重建。

**校验到什么程度**：

| 检查 | 状态 |
|---|---|
| `xmllint --noout`（well-formed） | 通过（exit 0） |
| 自写最小解析器回读：片段数 / `offset` / `start` / `duration` / 总时长（±1 帧） | 通过，CLI 每次导出都跑，对不上 → `OUTPUT_UNVERIFIED` |
| 官方 DTD / schema（`xmllint --valid`） | **NOT_RUN**：Apple 不随系统分发 FCPXML DTD，本机也没有 |
| 真机 NLE 打开（FCP / DaVinci） | **NOT_RUN**：本机没装这两个软件，不编"已验证" |

`verifyFcpxml(xml, plan)` 的返回值里带 `problems[]`，测试里专门用一份被改坏 duration 的
XML 验过它真的会报错（不瞎）。

三条命令的失败路径都先校验再落盘：`--at` 越界 / GIF 区间为空 → `INVALID_RANGE`，
无音轨工程跑 stems → `INVALID_FILM`，全部 exit 2、不留文件、连输出目录都不建。

## 字幕烧录（P23）

`--subtitle-burn` 出**三件套**：

```bash
opencut export film <project> --out film.mp4 --subtitle-burn --ffmpeg-path /path/to/ffmpeg-with-libass
# → film-master.mp4（无字幕母版） film-subbed.mp4（烧录） film.vtt（旁挂，成片时间）
```

不加这个开关时一行都不走，产物与上一轮**逐字节相同**（R12 实测 sha 与 R11 一致）。

**旁挂字幕怎么找**：片段 `src` 是 `assets/a.mp4` 时找同目录 `assets/a.vtt`，没有再找 `a.srt`。
一个工程里多条素材就多条字幕一起烧。

**时间轴必须换算**，不能把素材的 vtt 直接丢给 ffmpeg：

| 片段字段 | 含义 | 映射 |
|---|---|---|
| `src#t=2,6` | 源入出点（`clip.time = [2, 6]`） | 源 2.5s 的 cue → `at + (2.5-2)/speed` |
| `speed="2"` | 变速 | 时间按 2× 压缩：`(t - in) / speed` |
| `at="4"` | 时间线起点 | 整段平移 `+4` |

R12 实测：`#t=2,6` + 一条源 2.5–3.5s 的 cue → 成片 0.5–1.5s；`speed=2` 下源 3.0–4.0s
→ 成片 0.5–1.0s（拿"未压缩时刻"t=1.7s 抽帧验证过：那里**没有**字幕）。

**样式（P37 起）**：`--subtitle-style` 吃 **S41 的 schema**（`packages/layers/subtitle-style.mjs`）：

```bash
opencut export film <project> --out film.mp4 --subtitle-burn \
  --subtitle-style '{"color":"#ffcc00","align":"left","outlineRatio":0.22,"bottomSafeRatio":0.15}' \
  --subtitle-style @style.json          # 也可以从文件读
opencut export film <project> --out film.mp4 --subtitle-burn --subtitle-style color=#ffcc00,align=left
```

字号/描边/安全区全部乘**舞台高**再按 `scale` 缩到交付画幅，所以 720p 与 1080×1920 上
视觉比例一致。默认值与舞台**同一张表**（`SUBTITLE_STYLE_DEFAULTS` 只有 S41 那一份；
`render` 里的同名导出是派生视图，不再有第二套 `0.04/0.08/0.055`）。
非法值不会静默：`normalizeSubtitleStyle` 给 issue，结果 `subtitles.warnings` 与 stderr
各有一条 `subtitle style {field}: …; using default`。

#### 两个 `outlineRatio` 同名不同义（P37 的核心）

| 入口 | 字段 | 口径 | 720p 下 `0.02` | 720p 下 `0.22` |
|---|---|---|---|---|
| 旧 `style`（程序化，P23） | `outlineRatio` | 相对**画面高** | `720×0.02 = 14px` | 158px |
| 旧 `style`（程序化，P23） | `strokeWidthRatio` | 相对**字号**（默认口径） | — | — |
| 新 `subtitleStyle`（CLI / S41） | `outlineRatio` | 相对**字号**：`32.4×r×0.5` | `0.324 → 0px` | `3.564 → 4px` |

**按入口区分，不许混用**：CLI 的 `--subtitle-style` 永远是新的（相对字号）；
`buildAssDocument({ style })` 是旧入口（相对画面高），两者同时传直接 `E_USAGE`。
把 `bold-outline` 预设的 `0.22` 喂给旧入口会得到 158px 的粗黑边——这正是 P37 要收掉的那个雷。

### 行排（P39）：断行在烧录前定死

libass **只在空格处断行**（`WrapStyle 0/1/2/3` 都一样）。纯中文长句没有空格，
所以以前在成片里是**一行、左右被画布裁掉**；预览的 `overflow-wrap:anywhere` 却能断成两行。
`maxLines` 的 `…` 也没有 ASS 等价物——预览截断，成片整句铺出去。

现在行排是**共享纯函数** `packages/film-core/subtitle-layout.mjs`（ADR-R24-01，冻结）：

- `subtitle.mjs` 每条 cue 先按**设计舞台**（`designW × designH`，即 1280×720；不传 `layout` 时等于输出画布）
  与归一化后的样式调 `planSubtitleLines()`，`Dialogue` 文本 = `plan.lines.map(escapeAssText).join('\N')`；
- 预览（S45）拿同一组 `lines`，用 `\n` 渲染并关掉 CSS 自动换行——两边吃同一组行；
- **逐行 escape 再拼**：先拼 `\N` 再 escape 会把反斜杠转义，换行失效；
- 断点只看设计舞台，所以 720p / 1080×1920 / 4K 排出来是**同一组行**（不随画布变）；
- `maxLines` 截断在计划层完成，ASS 里最后一行已经带 `…`；
- **VTT/SRT 源文本不动**：旁挂 `.vtt` 仍是全文，截断只发生在显示层。

默认短句 `lines = [原句]` → 三画幅 ASS 与 R22 逐字节相同（`42fc2493…` / `9864032f…` / `d642b2a8…`）。
`render` 里**没有第二套换行/截断**：`planSubtitleLines` 只有一个调用点（`planCueLines`）。

**与舞台的五条对齐**（R14-C2，改的是代码不是文档）：

| 项 | 舞台 `layers/subtitle-overlay.mjs` | 导出 `render/subtitles.mjs` | 怎么对齐的 |
|---|---|---|---|
| 字体族 | `system-ui, -apple-system, "PingFang SC", …` | `Heiti SC` | 见下「为什么不是 PingFang」——同一个族在 libass 里只渲出 0.703 倍 |
| 字重 | 不设 `font-weight`（宿主默认 400） | `bold: false` | ASS 的 `Bold=-1` 是**合成加粗**，比真粗体更胖；默认跟舞台一样不加粗 |
| 描边 | `strokeWidthRatio 0.12 × 字号`（CSS 居中描边，`stroke-width` 是带**总宽**） | 同旋钮，写进 ASS 时 × 0.5 | 实测 libass 的 `Outline` 是带**外扩量**（`Outline=2` → 外扩 2px、内吃 2px，带总宽 4px 居中）＝总宽的一半，故 `O = W/2` |
| 位置 | CSS `bottom: bottomSafeRatio × 高`（到**行盒**底边） | `MarginV = 高×安全区 + (lineHeight−1)/2×字号` | CSS 行盒比字号高，半行距把字顶上去；不补的话 720p 会低 4.5px（实测） |
| `cpsWarn` | 17 | 17 | **以舞台为准**（只影响"这句读不完"的提示，不影响渲染） |

描边对照表（默认样式，`outlineRatio` 是旧口径，留给显式覆盖）：

| 画幅 | 字号 | 舞台描边（CSS，居中全宽） | 导出 `Outline` | 旧口径 `outlineRatio 0.0025` |
|---|---|---|---|---|
| 1280×720 | 32 | 3.888px | **2px** | 2px |
| 1920×1080 | 49 | 5.88px | **3px** | 3px |
| 1080×1920 | 86 | 10.32px | **5px** | 5px |
| 3840×2160 | 97 | 11.64px | **6px** | 5px（已不再随字号走） |

### 为什么默认字体不是 PingFang

`PingFang.ttc` 在这个 libass（osxexperts 8.0 静态构建）里**整体只渲出 0.703 倍**：
同一句 7 个汉字 `第一句对齐检查`，Fontsize 32 下

| 字体 | 实测字宽 | 每字 | 相对字号 |
|---|---|---|---|
| PingFang SC / PingFang HK / PingFangSC-Regular | 163px | 23.3px | **0.70 em**（应为 1.00） |
| Hiragino Sans GB | 180px | 25.7px | 0.79 em |
| **Heiti SC / STHeiti** | **225px** | **32.1px** | **1.00 em** ✓ |
| Songti SC | 224px | 32.0px | 1.00 em（但它是衬线） |

同一份 ASS 换成 Heiti SC 后，成片字幕与舞台的 bbox IoU 从 0.53 升到 **0.96**、
字高差从 −20.6% 收到 **+2.9%**。所以默认用 **Heiti SC**（同为 macOS 内置、无衬线、1em 正常定尺），
而不是跟着舞台的族表直接写 PingFang。

**要完全同族**可以自己补回缩放：`--subtitle-style fontFamily="PingFang SC",fontScale=1.42`
（`fontScale` 只乘 ASS 字号，不动安全区）。

**字体与回退**：libass 只认系统已装的字体。`Heiti SC` 不在的机器上 fontconfig 会回退到
默认 sans-serif 族，中文再按字符逐字回退（libass 0.17 起有 fontconfig fallback）。
所以"字体文件存在"≠"字形画得对"，缺字仍然靠下面的 `fc-list` 检测兜底。

**两份解析器必须同口径**：预览走 `film-core/subtitle.mjs`，烧录走本包，两边对同一份 vtt
必须给出同一批 `[start, end, text]`。`packages/render/test/subtitle-parity.test.mjs` 用 18 条夹具
同时喂两套解析器，除白名单（目前只有 `end<start`：导出必须拒绝、预览静默丢弃）外零差异。

**缺字检测**：烧录前用 `fc-list :charset=<码点>` 逐个字符查覆盖。
这里有个坑：macOS 的 `.LastResort` 声称覆盖**所有**码点但只会画豆腐块，
必须把它排除，否则检测永远通过。查不到（没有 `fc-list`）就报 `NOT_RUN` 并说清原因，
缺字则 `SUBTITLE_MISSING_GLYPH` + 列出字符。

**错误码**（都不会留半成品）：

| 情况 | 码 | 退出码 |
|---|---|---|
| vtt/srt 语法坏、没有旁挂字幕 | `SUBTITLE_PARSE_FAILED` / `SUBTITLE_UNSUPPORTED` | 2 |
| 字体没覆盖某个字符 | `SUBTITLE_MISSING_GLYPH` | 8 |
| ffmpeg 没编 libass（`subtitles` 滤镜不存在） | `SUBTITLE_BURN_UNAVAILABLE` | 8 |
| 字幕全在片段窗口外 / 空 vtt | 只警告，不失败 | 0 |

**已知限制**：烧录会**整片重编码**，所以 cue 外像素在成片里会有编码器码率控制的波动
（R12 实测 maxDiff 24、MAE 0.067/255）。烧录本身是逐像素精确的：把同一份 ASS 只做滤镜、
不重编码去比，cue 外 `maxDiff=0`。

## 交付画幅（P24）

```bash
opencut export film <project> --out film.mp4 --size 1080p        # 1920×1080
opencut export film <project> --out film.mp4 --size portrait     # 1080×1920
opencut export film <project> --out film.mp4 --size 1080x1920 --fit cover
```

不传 `--size` 时行为不变（还是舞台声明的 1280×720）。

**不是把 720p 放大**：舞台页支持 `fit=contain`，取帧视口直接设成目标尺寸，
文字/矢量按 1.5×、3× 真渲染，视频由合成器缩放。`.local-runs` 里的证据带 ffprobe 尺寸。

| fit | 做法 | 代价 |
|---|---|---|
| `letterbox`（默认） | 视口=目标尺寸，舞台等比缩放居中，空出来的边填黑 | 不裁内容，竖屏上下有黑边 |
| `cover` | 视口开到 `stage × max(比例)`（1080×1920 → 3414×1920），再居中裁 | 像素多 3.2×，内存/耗时上去 |

**没有网页片段的工程**走纯 ffmpeg 合成，画布固定是 `stage` 尺寸，缩放/补边由
`scale=…:force_original_aspect_ratio=…` + `pad`/`crop` 完成（`planDelivery().ffmpegVf`）。

**字幕跟着这个 scale 走**：见下面「字幕与画幅（P32）」。字号不是按输出画布高算的，
否则竖屏上的字会比预览大三倍。

**预算守卫**：`--budget-mem-mb 1500 --budget-sec 900`，超了报 `BUDGET_EXCEEDED` 并停，
产物与帧目录都不留。采样口径写在结果的 `resources` 里：
`tree` = 本次导出的进程树 RSS（`ps`）；`system` = 整机可用内存下降（`ps` 被权限挡住时的降级，
数值只能当量级参考）。

## 透明输出（P31）

```bash
opencut export film <project> --out take.mp4 --alpha                       # → take.mov（ProRes 4444，默认预乘）
opencut export film <project> --out take.mp4 --alpha --alpha-mode straight  # → take.mov（非预乘，R16 口径）
opencut export film <project> --out take.mp4 --alpha --alpha-format png-seq # → take/ + take.zip（非预乘）
```

**真 alpha，不是黑底**。舞台页自己铺了三层底色（`html/body #0b0b0c`、`#stage-frame #000`、
`#film #000`，都在 `packages/studio/server/content-origin.mjs` 里）。透明导出要做两件事，
少一件都是假的：

1. `page.screenshot({ omitBackground: true })` —— 否则 Chromium 会把页面背景合进去，alpha 恒 255；
2. 运行时把那三层底色改成 `transparent`（`stage-capture.mjs` 的 `applyAlphaBackground`，
   用 `page.addStyleTag` 注入，**studio 源码一行没动**）。

只做 1 会得到「黑底 + alpha=255」；只做 2 会得到「透明像素被合成到黑底上」。
实测（1280×720 卡片工程）：透明模式角落 `rgba(0,0,0,0)`、卡片中心 `alpha=235`
（CSS `rgba(255,255,255,0.92)`）；不开时是 RGB PNG、角落 `(0,0,0,255)`。

| 形态 | 产物 | 说明 |
|---|---|---|
| `prores4444`（默认） | `<stem>.mov` | `prores_ks -profile:v 4444 -pix_fmt yuva444p10le`；ffmpeg 的 prores_ks 会把 4444 档升到 12bit，ffprobe 读到的 `pix_fmt` 是 `yuva444p12le`，alpha 在 |
| `png-seq` | `<stem>/` + `<stem>.zip`（≤2GB 时） | 1 基命名 `frame-000001.png`，附 `sequence.json` / `alpha-report.json`；zip 是 **store-only**（不压缩） |
| `png-seq`（>2GB） | `<stem>.part001.zip` … | 整帧切卷、每卷 ≤2GB、**不落帧目录**（2.6GB 的帧目录再留一份等于为同一批数据付两遍盘） |

**为什么 zip 自己写**：系统 `zip` 是个外部二进制——"在我机器上能导、在你机器上要先装东西"
不是导出能力该有的样子。PNG 已经压过，再 deflate 一遍收益 <2%，所以 store-only + 自实现
CRC32，零依赖、字节确定（时间戳固定 2000-01-01，同一批帧打出来的 zip 可复现）。

### alpha 的极性：格式 × 极性 × 谁按什么解释（P33）

「极性」不是我们随便定的，是**交付格式的读者**定的。同一部片子的半透明边缘，在按预乘读的
软件里和按非预乘读的软件里，结果差一次 `alpha`：

| 格式 | 极性 | 默认？ | 谁按这个解释 | 盘上是什么 |
|---|---|---|---|---|
| `prores4444` | **premultiplied**（预乘） | ✅ | FCP / Motion / Resolve / Premiere 的默认导入（Apple 惯例） | RGB 已乘 alpha；alpha=255 处与 straight **逐字节相同** |
| `prores4444` | straight（非预乘） | — | AE 的「Straight Unmatted」、Nuke 的 unpremult | RGB 未乘；`--alpha-mode straight` 的产物与 R16 P31 **逐字节相同** |
| `png-seq` | **straight**（非预乘） | ✅ | PNG 规范（任何按规范读的工具） | RGBA8，RGB 未乘 |
| `png-seq` | premultiplied | ❌ 拒绝 | — | `E_USAGE`：PNG 规范是非预乘，写出预乘 PNG 等于给下游一张**没有标记的假数据** |

预乘只发生在**送进编码器之前**那一层（`format=rgba64le,premultiply=inplace=1`），取帧的 PNG
一个像素都不动 —— PNG 序列、`hasAlpha` 判据、`perFrame` 报告看到的仍是同一份 straight 数据。

**为什么先升 16bit 再乘**：8bit 路径的 `premultiply` 用的是 `>>8`（快速近似而不是 `/255`），
实测 `(200,100,50,255)` 会被乘成 `(199,100,50)` —— 不透明像素掉 1。换成 `rgba64le` 后同一组
输入得到 `(200,100,50,255)`，一个 bit 都不差。三档实测（原色 200,100,50）：

| alpha | straight（解码） | 预乘（解码） | 期望 `round(rgb×a/255)` | 误差 |
|---|---|---|---|---|
| 0 | (200,100,50,0) | (0,0,0,0) | (0,0,0) | 0 |
| 64 | (200,100,50,64) | (50,25,12,64) | (50,25,13) | 1 |
| 128 | (200,100,50,129) | (100,50,25,129) | (100,50,25) | 0 |
| 192 | (200,100,50,193) | (151,76,38,193) | (151,75,38) | 1 |
| 255 | (200,100,50,255) | (200,100,50,255) | (200,100,50) | **0（逐字节相同）** |

### PNG 序列的分卷与体积（P33）

4K 一帧 RGBA PNG 从 **80KB 到 20MB** 都可能（纯色卡片 vs 满幅噪点，差 250 倍），
所以「导出前就知道要占多少盘」只能靠**先估后核**：取 12 张均匀分布的已捕获帧外推，
再把实际字节写回报告。

| 工程（4K 3840×2160 · 240 帧 · 8s） | 每帧均值 | 序列总字节 | 卷数 | 预算误差 |
|---|---|---|---|---|
| 透明卡片（大片 alpha=0） | 81,778B | 19,630,157B（18.7MiB） | 1（`p33-a4-4k.zip`） | **0.02%** |
| 满幅噪点（alpha=255 全覆盖） | 19,845,503B | **4,762,955,560B（4.44GiB）** | **3**（`part001` 1,984,573,779B / `part002` 1,984,560,037B / `part003` 793,821,744B） | **0.00%** |

两个工程同一台机器、同一批代码，每帧体积差 242 倍 —— 这就是为什么必须「先估后核」而不是写死
一个系数。分卷那次 **`dirKept=false`**：帧目录不落地（否则同一批数据要占两遍盘，4.4GiB→8.8GiB）。

**卷内清单的字节口径**：`sequence.json` 里每卷的 `bytes` 是**帧字节合计**（写之前算得出来的那一半），
zip 的本地头 30B/条 + 中央目录 46B/条 + 清单自身（约 30KB）没有算进去 —— 清单自己就在卷 1 里，
写之前不可能知道自己最终多大。所以 part001 清单写 1,984,534,717B、实际文件 1,984,573,779B
（差 39KB，0.002%）。**实际字节以结果里的 `alpha.volumes[].bytes` 与 `totalBytes` 为准**，
「每卷 ≤2GB」这条也被实际字节复核过（超了会删卷报错）。

单卷上限 `2_000_000_000` 字节（**十进制** 2GB）：`2×10⁹ < 2×1024³`，两种读法下都 ≤2GB，
只有一个方向是安全的就选那个方向。分卷按**整帧**切（不切半张 PNG），命名 `part001` 起、
3 位定宽，`ls` 的字典序就是时间序；`sequence.json` / `alpha-report.json`（含整张卷表）
固定放在**卷 1**，拿到 part001 的人不需要别的卷就知道总共有几卷。

**报告是判据，不是装饰**（`alpha` 字段）：

```
{ hasAlpha, framesWithAlpha, firstFrame, lastFrame, maxTransparentRatio,
  minAlphaOverall, threshold, fullyTransparentFrames, perFrame[] }
```

- 判据是「有没有像素 alpha < 250」（250 是**容差**：250~255 按不透明算，免得 8bit 舍入
  把实心帧判成透明）。`maxTransparentRatio` 最大的那帧占了多少像素。
- 实心工程照实报 `hasAlpha=false` + `advice`（建议留 H.264），**不自动换编码**——
  走哪条路是产品决策，不是导出器该替用户定的。
- `fullyTransparentFrames` 单独列出来：整帧 alpha=0 通常意味着"场景没画"，比"有透明"更值得看。
- ProRes 还会回读三帧（首/中/尾）的 alpha 比例，证明 alpha 真的穿过了编码器
  （`encodedAlpha`），不是只活在中间 PNG 里。

**只出画面、不出音轨**：透明素材的用途是合成层，音轨仍来自主时间线；混进来只会让导入方
多一条没用的轨。`--alpha` 与 `--subtitle-burn` / `--also-compat` 组合直接报 `E_USAGE`。

**纯实拍工程拒绝**（`ALPHA_REQUIRES_STAGE`，exit 2）：画面铺满整幅、alpha 恒 255，
"透明导出"只会让人在剪辑软件里发现它压不住底。

**alpha 的极性**：R16 一律写 straight；R21 起 `prores4444` 默认**预乘**（按 Apple/NLE 惯例）、
`png-seq` 保持 **straight**（PNG 规范），`--alpha-mode` 可显式覆盖到 straight。
见上一节的两张表与三档实测数字。

## 字幕与画幅（P32）

字幕设计在**舞台坐标**里（1280×720）。交付到别的画幅时，整幅画面被等比缩放并居中，
字幕必须跟着**同一个变换**走 —— 否则竖屏（1080×1920）上按画布高算出来的字号是 86px，
比预览大 **3.2 倍**，而且 `MarginV=164` 会把字画进下方的黑边里（画面只到 y=1264）。

规则（`buildAssDocument({ size, layout })`）：

| 量 | 算法 | 竖屏 1080×1920 | 4K 3840×2160 |
|---|---|---|---|
| `PlayResX/Y` | 输出画布 | 1080×1920 | 3840×2160 |
| `scale` | `min(W/1280, H/720)`（letterbox）/ `max(...)`（cover） | 0.84375 | 3 |
| 字号 | `round(720 × fontSizeRatio × scale)` | **24**（旧口径 86） | **86** |
| 描边 | `round(720 × fontSizeRatio × strokeWidthRatio × 0.5 × scale)` | 1 | 2 |
| `MarginV` | `round((720×bottomSafeRatio + 半行距) × scale + offsetY)` | 708（offsetY 656.25） | 184（无留边） |

`offsetY` 就是「舞台底边到画布底边」的距离：letterbox 是上下黑边的一半，
cover 是负的裁切偏移。水平方向居中排版用不到 `MarginH`，但它也按同一个 scale 算，
不留一个"没缩"的值。

**预览与成片同源**：`content-origin` 的 `__stage__.html` **不带字幕层**（字幕是 Studio UI
把 `packages/layers/subtitle-overlay.mjs` 挂上去的）。所以同帧对照不能直接拿 `export still`
当预览——它没有字。`scripts/r16-subtitle-frames.mjs` 的做法是：

1. `export still --at t --size WxH` 取**真画面**（它就是舞台）；
2. 用**要上线的那个覆盖层模块**，按 `__stage__.html` 同款 `translate(ox,oy) scale(s)`
   在浏览器里画出字幕（截图带 alpha）；
3. 直通 alpha 合成 → 这才是"预览"；再与成片的同一帧比 p99。

字号因此不是我们算出来的：预览侧是浏览器画的，成片侧是 libass 画的，两边对得上才算过。

## 响度标准化（P34）

```bash
opencut export film <project> --out take.mp4 --loudness streaming   # I = −14 LUFS（视频平台）
opencut export film <project> --out take.mp4 --loudness broadcast   # I = −23 LUFS（EBU R128）
opencut export film <project> --out take.mp4                        # 缺省 off：一行都不多走
```

| `--loudness` | 目标 I | 真峰值上限 | LRA | 用途 |
|---|---|---|---|---|
| `off`（默认） | — | — | — | 行为不变，产物**逐字节**与 P31/P32 一致 |
| `streaming` | −14 LUFS | ≤ −1.0 dBTP | 11 | YouTube / Spotify 一类平台 |
| `broadcast` | −23 LUFS | ≤ −1.0 dBTP | 15 | 广播（EBU R128） |

**两遍 `loudnorm`**：第一遍只测（`-f null`，JSON 打到 stderr），第二遍带 `measured_*` 走
`linear=true` —— 整条音轨只乘一个常数增益，动态一点不动。只有「线性增益会把 TP 顶过线」时
loudnorm 才自己收敛到能保住 TP 的增益（代价是 I 到不了目标，报告里如实写）。

**为什么 TP 留 0.5dB 余量**：我们标准化的是**混音 WAV**，交付的是 **AAC**。AAC 是有损的，
重建后的采样峰值可能比源高零点几 dB，所以送进编码器的目标定成 `TP = −1.5 dBTP`，
**交付件实测仍要求 ≤ −1.0 dBTP**（报告里 `encodeTarget.TP` 与 `delivered.TP` 两个数都给）。

**做在哪一层**：混音 WAV 之后、封装之前。所以音量、淡入淡出、`--range` 区间、静音片段
全部**已经烘进波形**，标准化作用在最终波形上，语义不会被覆盖；也不用二次解码视频。

实测（6s 1kHz 正弦工程，`scripts/r17-loudness.mjs` 与 `evidence/p34-*.json`）：

| 档 | 输入 I | 实际增益 | 交付件 I | 交付件 TP | 判定 |
|---|---|---|---|---|---|
| `streaming` | −21.05 LUFS | **+7.05 dB** | −14.0 LUFS | **−13.1 dBTP** | ✅ 目标内 |
| `broadcast` | −21.05 LUFS | **−1.95 dB** | −23.0 LUFS | **−22.1 dBTP** | ✅ 目标内 |

音量 0.5 / 1.0 / 2.0 三档（同一素材，只改 `volume`）：**源**分别是 −27.15 / −21.05 / −15.05 LUFS，
实际增益 **+13.15 / +7.05 / +1.05 dB** —— 单调、且每档各自保留自己的电平。归一化本来就会把
输出收到同一个目标 I（这正是它的定义），所以「三档有没有被压成一样」要看**源电平与实际增益**
这两列，而不是输出列。

**报告**（`--json` 的 `loudness` 段）：

```
{ preset, target{I,TP,LRA}, encodeTarget{I,TP,LRA}, input{I,TP,LRA,thresh},
  output{I,TP,LRA}, delivered{I,TP,LRA,source,iWithinHalfLu,tpWithinTarget,summary},
  gainDb, peakGainDb, uniformGain, applied, measured{input_i,…}, code, reason, passes:2 }
```

- `delivered` 是在**最终 mp4** 上用 `ebur128=peak=true` 量的（`-vn`，不解视频），
  `summary` 就是那段实测原文。
- `applied` 是 loudnorm 自己的 `normalization_type` 标签；**判据看 `gainDb` 与 `peakGainDb`**：
  两个一致（差值 ≤0.3dB）说明整条轨乘的是同一个常数。实测有个别素材上标签写 `dynamic`
  而两个增益都是 +7.1dB —— 标签原样保留，判断以这两个实测值为准。
- 非 json 模式给人读一行：`loudness=streaming -21.1→-14.0 LUFS (+7.0dB) TP -13.1dBTP`。

**边界（都不许崩）**：

| 情况 | 行为 |
|---|---|
| 全静音（有 audio 元素、内容是静音） | `loudnorm` 报 `input_i="-inf"` → `code=LOUDNESS_UNMEASURABLE`，**继续出片**（用原始混音），`reason` 写清为什么 |
| 工程根本没有音轨 | 不造静音轨（P9 定的），`code=LOUDNESS_UNMEASURABLE`、`reason="film has no audible clips"`，出片 |
| 超短区间（<1s） | 能测就测（实测 0.5s 也能落到 −14）；测不到就报 `UNMEASURABLE`，不猜 |
| 单声道源 | 混音阶段已 `-ac 2` 上混，响度在立体声混音上测，不受影响（实测达标） |

`--alpha` 只出画面、没有音轨，所以 `--alpha` + `--loudness streaming` 直接报 `E_USAGE`
（静默忽略会让人以为响度生效了）。`--also-compat` 的兼容副本会跟着同一档标准化，
不然「母版 −14、兼容副本 −21」会让人以为是两个作品。

## 轨道开关与导出（P35）

导出口径一句话：**隐藏不画、静音不出声、锁定不管、独奏不看**。

| 轨道属性 | 画面 | 声音 | 导出侧行为 |
|---|---|---|---|
| `hidden` | 整条跳过 | 整条跳过 | 一条轨报一条 `track <id> is hidden; skipped`；整条画面轨都隐藏时仍出片（黑场，时长不变） |
| `muted` | **照旧出画** | 跳过 | `audio clip <id> is muted (track muted)`；只作用于声音。注意这是**轨**属性，片段上的 `muted` 也一样只静音 |
| `locked` | 照旧 | 照旧 | 只影响编辑。`film-plan.mjs` 里**没有** locked 分支——不是漏了，是导出不该看它 |
| `solo` | — | — | **不是方言属性**（`film-doc.mjs` 的 `TRACK_FLAGS` 只有 hidden/muted/locked）。导出不看独奏；要只导一条轨请用 `--range` 或 `hidden` |

三条实现口径：

- 隐藏轨仍参与**时长计算与素材校验**：它占着时间线，只是不画。否则"隐藏最长的一条"会悄悄缩短成片。
- 计划层的 warning 进结果的 `plan.warnings`，同时往 stderr 写一行 `warning: ...`。只写日志等于静默——机器接口的读者是 JSON。
- 过滤发生在**计划层**（`film-plan.mjs`），不是解析层：`film-doc` 照常把 hidden/muted/locked 解析出来，Studio 读同一份文档时还需要这些标记。

实测（R18，1280×720/30fps，纯色素材）：

| 工程 | 成片平均色 | 音轨 | 说明 |
|---|---|---|---|
| 只有一条 `hidden` 轨（红） | `(0,0,0)` × 3 帧 | 无 | 隐藏轨没画进去，也不是素材的红 |
| `hidden`（蓝）盖在可见底轨（红）上 | `(200,49,50)` | 无 | 只剩底轨 |
| 同上但不加 `hidden` | `(50,51,201)` | 无 | 上层蓝盖住底轨——证明 hidden 真的改变了结果 |
| `muted` 轨（音轨）+ 可见画面 | `(200,49,50)` | **无** | 只静音，不出画 |
| `locked` 轨 vs 不加 `locked` | — | — | sha 相同：`5bc3566811a770bc…` |

## 多段范围拼接（P36）

```bash
opencut export film <project> --out take.mp4 --range 2:4 --range 6:8
opencut export film <project> --out take.mp4 --range 2:4,6:8      # 等价
```

按给出顺序拼接，**总时长 = 各段之和**；不重排、不合并重叠（写 `2:4,3:5` 就是故意把那两秒放两遍）。

### 帧对齐：单段与多段是两套口径

| 情况 | 规则 | 例（30fps） |
|---|---|---|
| **单段** `a:b` | 保持 R21 口径：帧数 `round((b-a)×fps)`，第 i 帧在 `a + i/fps`（窗口本身不必落在帧格上） | `2:4` → 60 帧；`2.01:4.02` → 60 帧，首帧 2.010s |
| **多段** | 每段 `startFrame=round(a×fps)`、`endFrame=round(b×fps)`，段内帧数 = 起止帧之差；**实际取用窗口是对齐后的** | `2.01:4.02,6:8` → 61+60 = 121 帧；首段 2.000–4.0333s，首帧 2.000s |
| 某段短于一帧 | `INVALID_RANGE`，不静默产出 0 帧 | `2.001:2.002,6:8` → 拒 |

两种口径的差异只出现在非整帧边界，是**有意保留**的：单段改口径会让 R21 的产物变 sha；多段不对齐会在拼接处多/少半帧，而帧序列是 `-frames:v` 钉死的。

### 音频与接缝

- 每段音频取对应区间，`at` 按输出时长累加；`audioMix.duration` = 总帧数/fps。
- **接缝补 2ms 淡入/淡出**（`JOIN_FADE_SEC`）：只加在被**切开**的边；片段的自然起止与用户 `fade` 不变。
- **画面接缝不加淡入淡出**：`fade=alpha=1` 的 2ms 落在 33ms 的一帧上，段首帧只剩 ~6% 不透明度，观众看到的是闪黑。画面接缝就该是硬切。
- 实测（`2:4,6:8` @30fps，48kHz）：接缝 2.000s 处相邻采样最大跳变 **0.001283**，正常波形 **0.001284**；峰值 −32.1 dBFS，无 ≥0 dBFS 采样。

### 限制

- `--subtitle-burn` 与多段组合**已支持**（P40）。cue 按段映射到拼接时钟：跨切点的 cue 被切成
  相邻、不重叠的多条（每段只烧一次，不整条重复），落在被删间隙里的 cue 一条都不出；
  `.vtt` 用同一张映射表。记账 `subtitles.splitCount` / `subtitles.skippedCount` 按**输入 cue** 计。
- `export fcpxml` / `export gif` 只接受单段（拼接是 `export film` 的概念）。
- `plan.range` 在多段时只表示**第一段**；完整账在 `plan.ranges` / `plan.segments`（`plan.frameAligned=true` 表示这次走了多段口径）。

## 测试

```bash
node --test packages/render/test/*.test.mjs
```

真实 ffmpeg，无 mock。`test/av-export.test.mjs` 覆盖双流同长、30s 整片、
≥3 条错位片段逐样本比对、坏音频 `AUDIO_DECODE_FAILED` 与取消清理。
`test/stage-capture.test.mjs` 覆盖同步 frame、`NO_FILM`/`FRAME_THREW`、遮挡取样、
动效与对照帧、双流同长。`test/quality.test.mjs` 覆盖档位映射、默认档与非法档名；
`test/formats.test.mjs` 覆盖 stems 的 spec 拆分与文件名安全化、GIF 的 6 帧真编码
（帧数/宽度/循环扩展）与参数非法时的拒绝。`test/capture-speed.test.mjs` 覆盖分片合并
顺序的确定性（串行 vs 并行的帧号→时间映射）、并发数收敛与取消传播。

## 烧录第二遍的进度（P45）

烧录是**同一批帧的第二次编码**，所以它有自己的进度线，不并进母版的 `rendering`：

```
{ phase: 'burn', stage: 'encode', frame, totalFrames }
```

- 只在有字幕（`subtitles` / `--subtitle-burn`）时出现；不烧录时事件流与 P44 逐条相同。
- `frame` 从 **1** 严格 +1 到 `totalFrames`（成片总帧数）。ffmpeg 的 `-progress` 是按时间
  上报的（默认 0.5s 一条），一条 `frame=N` 表示「已编完 N 帧」；`createBurnProgress()`
  把两次上报之间的 gap 补成逐帧事件——补的每一帧在收到这一报时**都已经编完**，不是预测。
- `finish()` 只在编码**成功**后补齐尾部；取消/失败不补，否则宿主会看到「取消后进度还在涨」。
- 取消时 `runFfmpeg` 走 SIGTERM → 1.5s 宽限 → SIGKILL，`renderFilmExport` 的 `finally`
  把母版/烧录两份 `.video.partial*` 与临时混音目录一起清掉。
- Studio 的百分比映射这一批**没改**（下一批主线做）；它现在把 `burn` 当 `rendering` 处理，
  帧号不会回跳（`Math.max`），只是还没有独立的烧录阶段文案。

## 大画幅 × 分数帧率 × 透明（P46）

`--alpha --alpha-format prores4444` 在 4K / 竖屏 / 分数帧率下的实测口径：

| 项 | 值 |
| --- | --- |
| profile | `4444`（`prores_ks -profile:v 4444`） |
| 编码输入 pix_fmt | `yuva444p10le`（代码显式请求） |
| ffprobe 回报 | `yuva444p12le`（ProRes 4444 规范是 12-bit，两个 ffmpeg 版本一致） |
| 8s 帧数 | 30 → 240；29.97 → 240（8.008s）；23.976 → 192 |
| 极性 | 预乘卡片中心 RGB≈235、非预乘≈255；alpha 235±1；角落 alpha 0 |
| ASS Fontsize | 4K 86、竖屏 24、720p 29（= 显示后的舞台高 × `fontSizeRatio` 0.04） |

竖屏 1080×1920 走 letterbox：PlayRes 仍是成片画幅 1080×1920，字高按**显示后的舞台**
（1080×607.5）算，所以是 27 而不是 86。4K 的峰值 RSS 见 `evidence/rounds/R23-SUB2/`。

## 作业管线（P47）

`export start` 现在有产品级执行器：`packages/render/port.mjs`（端口）+ `port-worker.mjs`
（detached 子进程）。CLI 在没有 `--render-module` 时默认用它，`--render-module` 仍可覆盖。

```
export start  → 校验 → 建作业目录（spec.outputDir）
                 → spawn(node, worker, {detached, stdio:'ignore'}).unref() → 立刻返回 {jobId, pid, startedAt}
worker        → planFromFilm → [舞台取帧] → prepareSubtitleBurn → renderFilmExport
                 → job.json（状态）+ events.jsonl（每行一条进度）
export status → job.json + 最后一条事件（jobId 由 os.tmpdir()/opencut-render-jobs 的注册表找回）
export cancel → cancel.requested + SIGTERM → 5s 宽限 → SIGKILL → 扫掉 .partial/.lock/pid
```

- **必须用 `spawn`，不能用 `fork`**：`fork` 默认建 IPC 通道，父进程会被拖到成片才退出
  （实测 `export start` 的 real 从 0.59s 变成 6.3s）。
- spec 白名单：codec `h264|hevc|prores422hq|prores4444`、quality `draft|standard|high`、
  loudness `off|streaming|broadcast`、`ranges` 1..100（**不给 = 整片**）、
  `subtitleBurn` / `subtitleStyle`。`alpha` 仍明确拒绝（`ALPHA_REQUIRES_STAGE`）。
- `prores4444` 本批作为**交付编码**加进 codec-matrix（`prores_ks -profile:v 4444
  -pix_fmt yuva444p10le`）；alpha 导出仍走 `alpha-export.mjs` 那条链，两者不混。
- 端口拒绝作业时 `startExport` **原样透出错误码**（不再一律 `JOB_FAILED`），
  否则「编码器没编进来」和「工程没有透明度」会变成同一条退出码 8。

### 舞台取帧（P49）

带 `page` 片段（`<iframe>`）的工程现在也能走 `export start`：worker 里用的就是
`export film` 那一个 `captureFilmFrames`（`stage-capture.mjs`，不复制、不另写循环）。

1. **何时取**：`plan.sceneClips.length > 0` 时才**动态 import** `stage-capture.mjs`；
   没有网页片段的工程一行都不加载（Playwright 惰性），启动时间与 P47 一致、不白起浏览器。
   开浏览器之前先跑 `assertSceneClipsReady`（与 export film 同一时点）——
   缺文件/越界/跨源在**开浏览器之前**失败。
2. **目录在哪**：`<jobDir>/frames/`（`frame-%06d.png`）。成片、取消、失败三种收尾都会删掉，
   作业目录里不留 PNG 序列。
3. **进度怎么报**：取帧阶段 `phase:'rendering', stage:'capture'`（`frame` 1 基、逐帧），
   取完翻成 `stage:'encode'`。多通道并行时完成顺序是乱的，`job.json.framesDone`
   在 capture 阶段只增不减；`export status` 只在同一 stage 内取「事件里的更大值」，
   所以翻面时不会把 240 当成编码进度。
4. **取消怎么停**：`captureFilmFrames` 收同一个 `AbortSignal`（帧间检查），停下后
   `finally` 清 `frames/` + `.partial`/`.lock`/`.pid`，写 `state:'cancelled'`。

错误码：工程文档引用了不存在/越界的场景文件 → `INVALID_FILM`（文档的问题，浏览器还没起）；
舞台起来后画不出来（`NO_FILM`/`FRAME_THREW`/`FRAME_TIMEOUT`/`STAGE_BOOT_FAILED`/
`PROJECT_NOT_OPEN`）→ `SCENE_CAPTURE_FAILED`（原码留在 message 里）。

## 工程字幕样式（P48）

CLI 烧录现在读 `<project>/.film/subtitle-style.json`（与 Studio M40 同一个文件、同一套
`normalizeSubtitleStyle`）：

```
显式 --subtitle-style / spec.subtitleStyle   >   .film/subtitle-style.json   >   默认
```

- 文件不存在 = 默认（`resolveSubtitleStyle` 返回 `style: undefined`，默认 ASS 逐字节不变）；
- 坏 JSON / 顶层不是对象 / 主版本不同 → `INVALID`（退出码 2），**不写任何文件**；
- 字段不合法 → 归一化 `issues` **不阻断**（与 Studio 一致），但会写进
  `subtitles.styleSource` 审计字段（origin / file / exists / issues / sha256）；
- `export film` 与 `export start` 走同一个 `resolveSubtitleStyle`；同一工程两边 ASS 逐字节相同
  （实测 `fontScale=1.5, shadowRatio=0.01, bold=true` → Fontsize 49 / Shadow 7 / Bold -1，
  CLI 与 Studio 的 ASS 都是 `32a64761…`）。

## 作业目录互斥与崩溃回收（P50）

同一个 `outputDir` 起两个作业，实测的后果是：两个 worker 并行、`job.json` 只剩后开工的、
`events.jsonl` 交错；`cancel A` 之后 A 和 B 都被杀（`status B` 里出现 A 的 pid）。
根因是 start 无条件 truncate `events.jsonl` + 删 `job.json`——谁后开工谁把前一个的现场抹掉。

现在的规则（`job.lock` = `{jobId, pid, at}`，作业身份是**目录 + 活着的进程**，不是目录本身）：

| 现场 | 判定 | 结果 |
| --- | --- | --- |
| 锁里 pid 活着，且不是本次 jobId | 有人占着 | `EXPORT_OUTPUT_BUSY`，退出码 **3**，detail 带占用者 jobId+pid；目录一个字节都不动 |
| 锁里 pid 已死 / 锁读不出来 | stale | 拿到所有权后按白名单清中间件，再开工 |
| 上一个作业已 done/failed/cancelled | 可复用 | 同一个目录可以接着用 |
| 同一个 jobId 重跑 | 自己的现场 | 允许（与 P47 一致） |

- **回收白名单**：`.partial*`、`*.opencut-lock`、`job.lock`、`worker.pid`、`cancel.requested`、
  `frames/`。产物（`*.mp4/mov/webm`、`*.vtt`、`*.ass`、`spec.json`、`job.json`、`events.jsonl`）
  **一个都不碰**——回收是为了让目录能重新开工，不是删用户的东西。
- **`export status` 受控回收**：`running/waiting` 且 pid 已死 → 报 `WORKER_DIED` + `reaped:true`，
  清中间件并落终态（下次 status 不再重算）。连查两次幂等。
- **`export cancel` 先核对身份**：`job.json.jobId` 与要取消的 jobId 不符 → `CONFLICT`（3），
  **不发任何信号**（目录可能已被另一个作业接管，拿旧 pid 去 SIGTERM 就是杀别人）。
- 注册表清理：目录已不存在、或超过 7 天且已终态的项才删；活着的作业一项都不动。

## 渲染与测试共用浏览器名额（P51）

`stage-capture.mjs` 在 `chromium.launch()` **之前**取全局槽
（`packages/scene-runtime/browser-slot.mjs`，跨 worktree、家目录池、默认 1 个）：

```js
const slot = gateEnabled() ? await acquireBrowserSlot(`stage:${basename(projectRoot)}`) : null;
await chromium.launch({ args: [...args, ...(slot ? [slot.marker] : [])] });
```

- **释放点在 `browser.close()` 之后**（`close()` 的 `finally`）：先还名额再关浏览器，等于又开一个。
- 早退/异常（`STAGE_BOOT_FAILED`、`PROJECT_NOT_OPEN`、起浏览器失败）也走 `finally` 释放——
  一次失败的导出不该把整台机器的测试堵在队列里。
- `slot.marker`（`--opencut-gate-token=<token>`）写进 Chromium 的 argv：父进程被 SIGKILL 时，
  **下一次取槽**按 pid 判死 + 按 marker 精确回收（`pgrep -f`），不按 "Chrome" 名字批量杀。
- **一个作业只起一个浏览器**：`captureFilmFrames` 一次 session 跑完整段（多通道只是多 page），
  `job.json.stageLaunches` 是计数器报的数（不是采样猜的），验收要求它等于 1。
- **纯视频作业不占名额**：没有 `page` 片段就不加载 `stage-capture`，连 `acquireBrowserSlot` 都不会调。
- 闸门默认**关**（`OPENCUT_BROWSER_GATE !== '1'`）：产品运行时 args 与之前逐字节相同，
  导出 sha 零漂移（闸门开着时 `0e8e4326…` / `1f694d5b…` 仍然成立）。

## 资源压力准入（P52）

名额管「同时几个浏览器」，管不了「还剩多少内存」。`render.start` 在动手之前量一次占用：

```
默认阈值 = os.totalmem() * 0.6        （本机 16GB → 9.6GB）
         OPENCUT_RENDER_MEM_LIMIT_BYTES 可覆盖（验收/低配机）
超过阈值 → 先等（默认 30s，1s 轮询）→ 等不到 → RESOURCE_PRESSURE（CLI 退出码 3）
```

- 占用怎么估：本进程 RSS + 注册表里活着的作业**自报**的 `peakRssKB`（worker 用
  `process.resourceUsage().maxRSS` 写的）。本机 `ps` 被系统拒绝，不能去读别人常驻内存；
  自报峰值是上界，做准入判断偏保守，正是想要的。
- 调用方可以注入更准的采样器：`createRenderPort({ sampleFootprint })`（验收脚本用
  `scripts/lib/proc-sampler.mjs` 的整棵进程树 + 全部 Chromium）。
- 每次判定都落 `<registryDir>/pressure/<jobId>.json`：`attempts[]` 里逐轮记
  `{action: deferred|admitted|rejected, measuredBytes, limitBytes, limitSource, waitedMs}`。
  **读不到进程表时 `available:false` 并照常放行**——读不到不等于机器满了，也不拿 0 冒充。
- worker 的 RSS 与 Chromium 的 RSS **分开报**：`job.json.peakRssKB` 只算 worker 自己；
  Chromium 由采样器按「全部」与「带本次 marker」两种口径分别统计（见验收脚本 P52-A1 表）。

## 字幕行距进成片（P53）

ASS **没有行距字段**（Style 行的 `Spacing` 是字距），libass 按字体 ascent+descent 逐行堆；
Heiti SC 两个数加起来恰好 1em（S50 的 27 格标定）。所以用户在 Studio 把 `lineHeight`
从 1.25 调到 1.8 时，预览（CSS `line-height`）变了、成片（`\N`）**不可能**跟着变。

唯一权威是 `packages/film-core/subtitle-layout.mjs` 的 `subtitleLineStep(style)`（ADR-R37-03）：

```
em = lineHeight / 1.25        （1.25 是样式默认值 ↔ 成片自然行距 1em）
```

`buildAssDocument` 按它分两条路：

| 情形 | 输出 | 为什么 |
| --- | --- | --- |
| `isDefault`（1.25 → em 1） | 一条事件 + 字面 `\N`，**一个字节都不改** | 默认路径的 sha 是无数轮验收的锚（`be1f7325…`） |
| 非默认 + 多行 | **每行一条事件**，`{\pos(x,y)}` | `\pos` 是**事件级**标签：同一事件里的 `\N` 只会整体平移 |
| 单行（任何行距） | 一条事件，无 `\pos` | 一行没有「行距」，加了只会平白改字节 |

逐行定位的三条几何：

- `y` 底边锚定：最后一行 = `画布高 − MarginV`（与今天 libass 自己摆的底边**逐像素相同**），
  多出来的行距一律**向上扩**——字幕长高不该压进底部安全区；
- 行步进 = `fontSizePx × em`，`fontSizePx` 就是 `toAssStyle` 算出来的那个整数（4K=97、720p=32、竖屏=27）；
- `an=2` 居中，`x = 画布宽 / 2`，**不自己算字宽**。

`prepareSubtitleBurn` 的回读对账（`SUBTITLE_PARSE_FAILED`）基准从「cue 条数」换成
`planAssEvents()` 的**事件表**，并逐条比时间（±10ms）——拿 cue 条数当基准会把逐行定位误判成
「ASS 少写了几条」。Studio / `export film` / `export start` 三条链路都调同一个
`buildAssDocument`，所以同一工程 + 同一份 `.film/subtitle-style.json` 出的 ASS sha 相同。

## 大画幅烧录逐帧像素（P54）

R30 起 4K / 竖屏的烧录只验过「字号对一个、帧数对」。现在逐帧比像素，参考帧是
**同一份 ASS 的 libass 合成**（不是「我们自己的另一次导出」——那只证明确定性）：

```
ref = ffmpeg -i <master.mp4> -vf "subtitles=<工程同一份 ASS>" -c:v libx264 -qp 0 -pix_fmt yuv444p -an
```

`master` 是产品同一条命令产出的未烧录母版（同一批帧、同一组编码参数，只少一个字幕滤镜）。
ASS 由 `buildAssDocument` 用同一入参重建，**sha 必须与导出回报的 `subtitles.ass.sha256` 相等**
才允许当参考——对不上就报错，不拿「差不多的一份字幕」凑。

判据（逐帧报数字）：

- **字幕区域外零差异**：band 由「参考帧 vs 母版」推出来（不是从我们的产物推——
  从产物推会把漏烧的字自动排除在区域外），band 外差一个像素都算红；
- **区域内** avg ≤ 2/255、max ≤ 8/255；另给「只在字迹像素上」的平均差与**覆盖形状 IoU**
  （这一项与编码器噪声无关，专门证「字在哪里、盖住了哪些像素」）。

`--quality high` 下 4K 实测 avg 0.03 / max 8 / IoU 1.0、区域外 0 像素；默认 `standard`
档同口径 max 会顶到 12（24 个像素，全在字形边缘）——那是 x264 的量化噪声，几何与覆盖没变，
两个数字都写进证据，不拿高画质档的通过去盖掉标准档的实测值。

顺带修掉一处证据链的坑：`events.jsonl` 的 `appendFile` 原来是**并发**发的，烧录逐帧连发时
落盘顺序会乱（实测 30 帧成了 `1,2,4,3,5,6,8,7,11,10,9…`），文件里就再也看不出「跑到第几帧」。
现在与 `job.json` 的写盘一样走一条 Promise 链：**保序、仍然 fire-and-forget**，
不拖慢编码；`phase=burn` 的帧号 1→N 严格 +1 才成立。
