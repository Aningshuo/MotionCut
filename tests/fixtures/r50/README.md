# tests/fixtures/r50 —— R50 渲染验收的工程夹具

这些工程**不是**从冻结证据反推出来的。它们由 `scripts/lib/r50-fixtures.mjs` 生成，
内容是代码里的常量（画布 1280×720、底板视频、vtt 文本、卡片几何），生成完立刻用
产品自己的 `planCueLines` 自检「每格 2 行、不截断」，不满足就抛错。

## 为什么入库

P55 / P56 的输入工程原先只存在于 `.local-runs/sub2/runs/R50/output/projects`，
从未进过 git。开发机清理之后两门 `FIXTURE_MISSING`、`render-audit` 14/18、`p71` 红 ——
这是本轮唯一一处「能力永久不可复算」。所以夹具改为入库，`--check` 每次从仓库里复制。

## 重建

```bash
node scripts/r50-p55.mjs --ensure-fixture     # 生成 projects/ + baseline/
node scripts/r50-p56.mjs --ensure-fixture     # 同一份夹具，入口在 P56 那边也行
```

两条命令等价（都调 `ensureAll()`）。重建是幂等的：先清空 `projects/` 再写。

## projects/

| 工程 | 用途 | 内容 |
|---|---|---|
| `p55-zh` / `p55-en` / `p55-mixed` | P55 竖屏九宫格行高矩阵 | 1280×720 底板 + 两行字幕（中文 53 字 / 英文 114 字 / 中英混排 54 字），cue 0.2–1.0s |
| `p56` | P56 4K / 竖屏 30 帧全帧扫描 | 同一块底板 + 两行字幕，cue **0.0–2.0s**（1s 成片的 30 帧每一帧都有字幕） |
| `p720` | P53 / P54 的六格与逐帧像素 | 两行**同一句**文字（`行距基准测试一`），cue 0.2–1.8s —— 1em 自然行距的锚点 |
| `pline` | P53-A4 单行不动 | 单行 cue（`单行字幕不动`），cue 0.2–1.8s |
| `m48` | P53-A1 无字幕 1s/720p | 只有底板，没有 vtt |
| `pagecard` | P54-A3 alpha 极性 | 网页片段：透明底 + 居中白卡 `opacity: .92`（→ alpha 235），0.5s |

**底板 `assets/base.mp4`**：`color=0x1b2028` 纯色平底，1280×720 / 30fps / 2s，
`libx264 -preset veryfast -crf 18 -pix_fmt yuv420p`。全部工程共用一份字节相同的副本。

> 为什么必须是**纯色平底**：`measureLineStep`（P53-A2）把「第一行出现差异的 y」当字幕顶边。
> 底板上有色块时，色块边缘的重编码差异会被当成字幕顶（实测顶边落到 y=80、量出 step=8）。
> 同理 P54-A1/A2 要求 band 外 `count=0`，平底才不会被重编码边缘污染。

## baseline/ —— P53/P54 的「改动前」比对对象

| 文件 | 谁读 | 内容 |
|---|---|---|
| `m48-720p.mp4` | `r27-p53` A1 | `m48` 的 1s/720p 无字幕导出（**不传** `--ffmpeg-path`，与 p53 的 A1 逐字一致） |
| `720-lh18-single-subbed.mp4` + `.json` | `r27-p53` A4 | `pline` 在 `lineHeight=1.8` 下的烧录成片与 CLI JSON |
| `720-lh125-subbed.mp4` + `.json` | `r27-p54` A4 | `p720` 默认样式下的 720p 烧录成片与 CLI JSON |

**口径（必须照实读）**：R37 的原始 PRE 产物随 `.local-runs` 一起丢了。这里重建的是
**同一口径的新基线** —— 用当前代码 + 同一份夹具 + 同一组参数重新导出，sha 记在
`baseline/manifest.json`。它能证明「从现在起不再漂移」，**不能**证明「与 R37 那一刻逐字节相同」；
后者只有 `evidence/rounds/R50-SUB2/regression/p53-lineheight.json` 里那几个旧 sha 能说明，
manifest 把它们并排列出（旧夹具已丢，sha 必然不同，只作索引）。

`r27-p53` A1 的 plain 导出不传 `--ffmpeg-path`，走 CLI 自己的解析顺序；而 CLI 的环境
**只来自** `--env` 指向的 JSON。所以 `scripts/lib/r50-fixtures.mjs` 的 `ensureEnvFile()`
会把 `OPENCUT_FFMPEG` / `ffmpegPath` 写进 run 的 `env.json` —— 否则容器里 `Lavc/Lavf`
版本串不同，字节差 1、sha 永远对不上（实测：resources/bin 8.0 给 `Lavc62.11.100`，
PATH 上的 homebrew 8.1.2 给 `Lavc62.28.102`）。
