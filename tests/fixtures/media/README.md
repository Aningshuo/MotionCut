# tests/fixtures/media

自造媒体夹具，**不含任何用户素材**。两个文件都由本机 ffmpeg 8.1.2 用 lavfi 生成。

| 文件 | 内容 | 用途 |
|---|---|---|
| `bars-3s-720p30.mp4` | testsrc2 彩条，1280x720 / 30fps / 3.000s / H.264 | R1 场景帧源（解码成 PNG 序列） |
| `tone-1khz-3s.wav` | 1kHz 正弦，48kHz / 2ch / 16-bit PCM / 3.000s | R1 音轨 |
| `insert-1s-720p30.mp4` | testsrc2 1 秒，1280x720 / 30fps | M23 波纹插入 |
| `transition-a-light-3s-720p30.mp4` | 中灰底 + 左侧白方块，1280x720 / 30fps / 3.000s / **H.264 无损（crf 0）** | M25 转场「前段」 |
| `transition-b-dark-3s-720p30.mp4` | 深灰底 + 右侧白方块，同上 | M25 转场「后段」 |
| `tone440-light-3s-720p30.mp4` | 中灰底 + 左侧白方块 + **440Hz 正弦（AAC 192k，-6dBFS）**，3.000s | M28 声音交叉「前段」 |
| `tone880-dark-3s-720p30.mp4` | 深灰底 + 右侧白方块 + **880Hz 正弦**，同上 | M28 声音交叉「后段」 |
| `still-green-640x360.png` | 纯绿静帧 | 静帧片段 |
| `loud-1khz-3s.wav` | 1kHz + 0.6Hz 包络（0.22–1.0），48kHz / 2ch / 16-bit / 3.000s，峰值 0.97 | S35 波形：正常 / 静音 / volume=2 三种状态 |
| `over-unity-3s.wav` | 同上但 **float32**，峰值 **1.40**（超过满幅） | S35 波形：证明峰值不夹紧 |
| `tone-1min-44k1-mono.mp3` | 523Hz + 0.1Hz 包络，44.1kHz / 单声道 / 96kbps / 60.000s，峰值 −0.9dBFS | S35 波形：1 分钟 mp3 |
| `stereo-split-3s.wav` | L 440Hz（0.8Hz 包络，峰值 0.98）/ R 1760Hz（1.3Hz 包络，峰值 0.30），48kHz | S35 波形：双声道不同内容（通道合并） |

### S35 补充素材的复现命令

```bash
ffmpeg -y -hide_banner -loglevel error -f lavfi -i "sine=frequency=1000:sample_rate=48000:duration=3" \
  -af "volume='11.0*(0.22+0.78*abs(sin(2*PI*t*0.6)))':eval=frame" -ac 2 -c:a pcm_s16le tests/fixtures/media/loud-1khz-3s.wav

ffmpeg -y -hide_banner -loglevel error -f lavfi -i "sine=frequency=1000:sample_rate=48000:duration=3" \
  -af "volume='15.84*(0.22+0.78*abs(sin(2*PI*t*0.6)))':eval=frame" -ac 2 -c:a pcm_f32le tests/fixtures/media/over-unity-3s.wav

ffmpeg -y -hide_banner -loglevel error -f lavfi -i "sine=frequency=523.25:sample_rate=44100:duration=60" \
  -af "volume='7.6*(0.18+0.82*abs(sin(2*PI*t*0.1)))':eval=frame" -ac 1 -c:a libmp3lame -b:a 96k \
  tests/fixtures/media/tone-1min-44k1-mono.mp3

ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=3" \
  -f lavfi -i "sine=frequency=1760:sample_rate=48000:duration=3" \
  -filter_complex "[0:a]volume='7.84*(0.1+0.9*abs(sin(2*PI*t*0.8)))':eval=frame[a0];\
[1:a]volume='2.4*(0.4+0.6*abs(sin(2*PI*t*1.3)))':eval=frame[a1];[a0][a1]amerge=inputs=2[out]" \
  -map "[out]" -c:a pcm_s16le tests/fixtures/media/stereo-split-3s.wav
```

**为什么包络**：`ffmpeg` 的 `sine` 源本身振幅是 0.125，直接放大得到的是恒定正弦——按 100 桶/秒画出来是**一整块实心**，
看不出波形也不验证「按真实采样」这件事。加包络后每一行都有可辨认的起伏，截图才有信息量。

## 复现命令

```bash
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=3" \
  -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p \
  tests/fixtures/media/bars-3s-720p30.mp4

ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "sine=frequency=1000:sample_rate=48000:duration=3" \
  -ac 2 -c:a pcm_s16le \
  tests/fixtures/media/tone-1khz-3s.wav
```

## 帧序列

渲染作业消费 PNG 序列。测试在临时目录里从 `bars-3s-720p30.mp4` 解出 90 张：

```bash
ffmpeg -y -hide_banner -loglevel error \
  -i tests/fixtures/media/bars-3s-720p30.mp4 \
  -vsync 0 /tmp/frames/frame-%05d.png
```

R4 / R8 需要更长的编码窗口，测试会用 10 秒 300 帧：

```bash
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=10" \
  -vsync 0 /tmp/frames-long/frame-%05d.png
```

## 校验

```bash
ffprobe -v error -print_format json -show_streams -show_format tests/fixtures/media/bars-3s-720p30.mp4
ffmpeg -v error -i tests/fixtures/media/bars-3s-720p30.mp4 -f null -
```

## M25 转场素材为什么是「中性灰 + 无损」

转场验收要量的是**合成**（预览 CSS opacity vs 导出 alpha overlay），不是色彩管理：

- **中性灰**（0x808080 / 0x303030 + 白方块）：R≈G≈B，YUV→RGB 的矩阵差异被压到 1–2 个单位。
  用饱和红/蓝时，Chromium 与 ffmpeg 对同一帧的解码能差到 6（B 通道），
  纯色满屏会把这个固定偏差算进 MAE（实测 2.2），与转场无关。
- **crf 0**：同一段视频每一帧颜色完全一致，比较不会被编码噪声污染。
- **`-color_range tv -colorspace/primaries/trc bt709` + `-movflags +write_colr`**：
  文件自带 `colr` box（nclx，matrix=1），两个解码器不会各自猜一套矩阵。

```bash
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "color=c=0x808080:s=1280x720:r=30:d=3,drawbox=x=80:y=260:w=240:h=200:color=white@1:t=fill" \
  -vf "format=gray,format=yuv420p" \
  -c:v libx264 -preset veryfast -crf 0 -pix_fmt yuv420p \
  -color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709 \
  -movflags +faststart+write_colr \
  tests/fixtures/media/transition-a-light-3s-720p30.mp4
```

## M28 为什么给夹具视频塞了音轨

A5 要证明的是「转场重叠区两路声音同时存在、RMS 不塌陷」。声音在 `audio-mix.mjs` 里是
**逐样本相加 + 幅度线性包络**，所以夹具需要：

- 两条**独立频率**（440 / 880）：一条曲线里能同时看到两个峰，硬切做不到这一点；
- 声音与画面**逐字段镜像**（同 bareSrc、同 `at`、同 `#t=in`）：`companionAudioOf` 才认；
- 采样率 48kHz（合同白名单之一），AAC 192k 只为让 mp4 能在 Chromium 里播。

```bash
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "color=c=0x808080:s=1280x720:r=30:d=3,drawbox=x=80:y=260:w=240:h=200:color=white@1:t=fill" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=3" \
  -vf "format=gray,format=yuv420p" -af "volume=0.5" \
  -c:v libx264 -preset veryfast -crf 0 -pix_fmt yuv420p \
  -color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709 \
  -c:a aac -b:a 192k -ac 2 -shortest -movflags +faststart+write_colr \
  tests/fixtures/media/tone440-light-3s-720p30.mp4
```
