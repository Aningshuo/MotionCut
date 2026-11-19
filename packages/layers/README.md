# packages/layers

画布/图层编辑层（副线1 领地）：几何手势、吸附、层树、检查器字段、动效面板接线、字幕覆盖层。
能力分级（`FULL / PARTIAL / PIXEL_ONLY / UNSUPPORTED`）与写入/提交规则见 [`CAPABILITY.md`](./CAPABILITY.md)，
本文件只记**容易被下次改动踩掉的约束**。

## 约束

### 1. 字幕覆盖层可以放进缩放容器（S39 · B-SUB1-R20-020）

`mountSubtitleOverlay()` 的容器**可以**处在 `transform: scale(N)` 的祖先里（预览缩放、`__stage__.html`
接进缩放容器、以后把覆盖层搬进 iframe 都属于这一类）。

量文字高度走这条：**先按视觉高度量，再除以横向缩放**（`rect.height ÷ (rect.width ÷ 我们设的 CSS 宽度)`）。
不要直接拿 `getBoundingClientRect().height` 当结果——祖先有 `transform` 时它是 N 倍的视觉高度，
拿去比 `lineHeightPx × maxLines` 会误判溢出，把一整句字幕截成「…」。

- 为什么不用 `offsetHeight`：它与 transform 无关，但返回**整数**。同一句 40.5px 高的字会读成 41，
  正常路径（scale=1）下就和修前不再逐像素相同，二分找最长前缀也会偶尔少留一个字。
  现行实现只在**非等比缩放**（`scale(3,2)` 这类，横向比例算出来的高度会偏小）时才退回 `offsetHeight`。
- 宿主给 `getStage()` 时必须给**舞台/布局坐标**（`{x,y,w,h}`，写进 CSS 的那套 px）。
  **不要**直接把容器 `getBoundingClientRect()` 回传：在缩放容器里那是视觉 px，
  覆盖层会按 N 倍尺寸排版。不传 `getStage()` 时模块按容器 rect 兜底，那条路径是布局 px 口径。
- 字号口径 `fontSize = 舞台高 × fontSizeRatio`（P32 定）与本条无关：这里只改「量」，不改「算」。

### 2. 画布上的数字只出现一次（S40 · B-SUB1-R20-020）

同一时刻只允许一组「尺寸/位置」数字。分工：

| 时刻 | 谁显示 | 为什么 |
|---|---|---|
| 静止 | **宿主**那份只读标签（Studio 的 `clip-hud`） | 它是权威值（来自文档 state），而且带自己的说明 |
| 手势 / 键盘微调中 | **手势层**的标签，跟随指针 | 宿主那份是 React state 派生的，拖动期还是**旧值**（实测框已到 `257,180`，它还写着 `100,120`） |

手势层显示数字时会临时把宿主那份藏起来（`opts.hostSizeLabel`，默认 `[data-testid="clip-hud"]`，
传 `null` 关掉），松手原样写回原来的行内 `display`。

另外两种排法都不行：两边都显示 = 同一组数字出现两遍、其中一遍是错的；只留宿主的、手势层不画 =
数字不跟手，且没有自绘标签的宿主（测试台、第三方嵌入）拖动时什么都看不到。

> 间距读数（`24px` 那种，ED-079）不算「同一组数字」：它量的是两个对象之间的净空，尺寸标签量的
> 是框本身，两者信息不同，可以同屏。

### 3. 字幕样式只有一份默认值（S41 · B-SUB1-R21-021）

默认值定义在 `subtitle-style.mjs` 的 `SUBTITLE_STYLE_DEFAULTS`，**预览与成片都读它**：

- 预览：`subtitle-overlay.mjs` 走 `normalizeSubtitleStyle()` → CSS；
- 成片：`toAssStyle(style, { stage, canvas, fit })` → ASS 字段（副线2 的烧录直接 import，别再自己算）。

禁止在任何一侧复写一份默认值。复写就是 R14-C1 那种「预览一套、成片另一套」的来源。
`subtitle-overlay.mjs` 里导出的 `SUBTITLE_STYLE_DEFAULTS` 是**改名后的派生视图**
（`outlineColor → strokeColor`、`outlineRatio → strokeWidthRatio`），不是副本。

可调字段（16 个）：

| 字段 | 默认 | 范围 | 说明 |
|---|---|---|---|
| `fontFamily` | 舞台族表 | 非空串 | 只影响预览（CSS 要族列表） |
| `assFontName` | `Heiti SC` | 非空串 | 只影响成片（ASS 的 Fontname 是单值） |
| `fontSizeRatio` | `0.04` | `(0, 0.5]` | 字号 ÷ 舞台高（三档 `SUBTITLE_SIZE_TIERS` 0.032/0.04/0.052，默认 = 参照 `s8.md`） |
| `color` | `#ffffff` | CSS 颜色 | 主色 → `&H00FFFFFF` |
| `outlineColor` | `rgba(0,0,0,0.84)` | CSS 颜色 | 描边色 → `&H29000000`（别名 `strokeColor`；R32 对齐参照 `Sy.outline.stroke.color`） |
| `outlineRatio` | `0.055` | `[0, 1]` | 描边**总宽** ÷ 字号（别名 `strokeWidthRatio`；R31 的 `widthEm`） |
| `shadowColor` | `rgba(0,0,0,0.608)` | CSS 颜色 | 阴影色 → `&H64000000` |
| `shadowRatio` | `0.0015` | `[0, 0.1]` | 阴影位移 ÷ 舞台高 |
| `background` | `transparent` | CSS 颜色 | 文字底色（只影响预览） |
| `align` | `center` | `left/center/right` | → ASS `Alignment` 1/2/3 |
| `lineHeight` | `1.25` | `[1, 3]` | 行高倍数（只进 MarginV 的半行距补偿） |
| `maxLines` | `2` | `1…6` 整数 | 超出截断加 `…` |
| `bottomSafeRatio` | `0.08` | `[0, 0.5]` | 行盒底边 ÷ 舞台高 |
| `fontScale` | `1` | `(0, 5]` | 字号整体倍率 |
| `bold` | `false` | 布尔 | ASS 走合成加粗 `Bold=-1` |
| `cpsWarn` | `17` | `[0, 100]` | 语速提示阈值（只提示不拦） |

非法值**不静默**：`normalizeSubtitleStyle()` 回 `{ style, issues }`，issue 带
`STYLE_UNKNOWN_KEY / STYLE_TYPE / STYLE_RANGE / STYLE_COLOR / STYLE_ALIGN / STYLE_NOT_OBJECT`，
overlay 把它报成 `SUBTITLE_STYLE_INVALID`（一条，消息里列全部字段）。

两个单位不要在两边混用：CSS 的 `-webkit-text-stroke-width` 是描边**带总宽**，
ASS 的 `Outline` 是**外扩量**，换算差一个 `0.5`（`ASS_OUTLINE_CENTER_FACTOR`）。
`toCssStyle()` 给预览口径，`toAssStyle()` 给成片口径，都用同一份 style。

### 4. 字幕随画幅缩放的口径（P32，S41 起由 `toAssStyle` 唯一实现）

```
scale   = min(canvas.w / stage.w, canvas.h / stage.h)      // letterbox
offsetY = (canvas.h - stage.h × scale) / 2
字号    = round(stage.h × fontSizeRatio × fontScale × scale)
描边    = round(stage.h × fontSizeRatio × outlineRatio × 0.5 × scale)
MarginV = round((stage.h × bottomSafeRatio + 半行距) × scale + offsetY)
```

三画幅对照（默认样式、舞台 1280×720）：

| 画布 | scale | offsetY | 字号 | 描边 | MarginV |
|---|---|---|---|---|---|
| 1280×720 | 1 | 0 | 29 | 1 | 61 |
| 1080×1920 | 0.84375 | 656.25 | 24 | 1 | 708 |
| 3840×2160 | 3 | 0 | 86 | 2 | 184 |

按画布高直接算（旧口径）在 1080×1920 上会得到 86px 的字，并落到下方黑边里 —— 这是 P32 修掉的 bug，
`subtitle-style.test.mjs` 的 U4 每轮都会把它钉回去。

`fit` 只支持 `letterbox`（默认）与 `cover`。**不做 `stretch`**：ASS 的字号只有一个数，
非等比缩放要么字被拉扁、要么边距对不上；传了别值给 `STYLE_FIT` issue 并退回 letterbox。

### 5. 等距分布与旋转吸附（S42 · B-SUB1-R21-021）

**等距分布**（`measureGapRuns`）：从被拖矩形沿「最近的邻居」向两侧串成链，**相邻 ≥3 段间距相等**
（容差 1px）才算一组，标签是 `= 24px =`（区别于单个净空的 `24px`）。每轴每侧最多一条。

不做「同侧多个邻居等距」（S42 第一版做过，撤了）：画面里到处是一排一排的片段，拖任何一个，
另一排往往离它一样远，于是每拖一下都会冒出 `= 48px =`、`= 80px =` 这种与当前操作无关的读数。
链式不会——它要求**连续的段**都相等，行列惯性最多凑出 1 段。

一组的线是每段一条虚线，**数字只挂第一段**（贴着被拖对象的那段）：三段 24px 挨着排，
三个药丸会互相压住。标签还沿垂直方向让开 14px，避免和跟手的尺寸 HUD 叠在一起。

**旋转片段（`r≠0`）的缩放吸附**（`snapEdgesRotated`）：吸的是 **AABB 的边**，把补偿量投影回局部轴。

```
d(AABB.right) / dw = cosθ     →     Δw = ΔAABB / cosθ
```

θ 越过 90° 后 `cosθ<0`、取 max 的角点换到另一侧，所以实现里**不手写 ±cosθ**，而是
「把 w 加 1 再量一次 AABB」的**数值导数**（符号、角点切换自动正确），解析式留在注释与单测里对照。

- 投影下限 `SNAP_ROTATED_MIN_PROJECTION = 0.5`（|θ| ≤ 60°）：再往外，AABB 边对宽度的导数太小，
  补偿量要放大 1/cosθ 倍，画面会跳。那种情况**不吸**，且**不给参考线**（画了却没吸 = 骗人）。
- 探针必须按「对侧锚点不动」的缩放来量（`anchoredResize`）。绕中心放大得到的导数是
  `1/2 + cosθ/2`，与真实手柄的 `cosθ` 差一半——第一版就是这么算出 0.854 而不是 0.7071 的。
- 锚点不动由调用方保证：手势层拿 `dw/dh` 重跑一次 `dragBox()`，它本来就是按锚点反解 x/y。
- `Shift` + 角手柄时不吸：等比是硬约束，吸一下比例就破了。

`r=0` 仍走 `snapEdges` 老路径（`snapEdgesRotated` 在 `rotationDeg===0` 时直接透传），
S38/S40 的数值逐条回放。

### 6. 字幕烧录：预览与成片不是同一条字体链（S43 · B-SUB1-R22-022）

`toAssStyle()` 只保证**参数**相等；S43 用同一块纯绿画布把预览截图与 `ffmpeg subtitles=` 的烧录帧
摆在一起量，得到三条硬结论：

| 事实 | 实测 | 后果 |
|---|---|---|
| 预览链命中 **两个族**：`PingFang SC`（CJK）+ `.SF NS`（Latin）；ASS 是单值 `Heiti SC` | 同一字符串 32/48/64px 的字宽差 **+1.07% / +1.73% / +2.22%**（`Heiti` 更宽） | 4K 下同一句的 ink 宽差 **30px**；断点可能移动 |
| **libass 只在空格处断行**（`WrapStyle` 0/1/2/3 实测都一样），CSS 的 `wrap-anywhere` 可以在任意字间断 | 纯中文 50 字：烧录 **1 行**、左右都被画布裁掉；同样长度带空格才 2 行 | 中文长句在成片里**不会自动换行**，直接冲出画面 |
| `maxLines` 只在预览生效（超出加「…」），ASS 没有对应字段 | — | 超过 `maxLines` 时预览「…」、成片全文 |

修法（P37/S45，**都不在本批授权内**）：

1. **字体链**二选一：预览 `fontFamily` 首位改 `Heiti SC`（只动预览，会动字幕像素），
   或 render 的默认 `Fontname` 改 `PingFang SC`（要改 `packages/render/**`）。
2. **断行**：导出前按**预览的折行结果**把 cue 断好（在 cue → Dialogue 之间插 `\N`），
   让 libass 不需要会中文断行。要改 render，属 blocker（BLK-1）。
3. **截断**：要么预览不截断，要么导出前按预览结果截成同样的「…」。

接线时还有一个**语义同名不同义**的坑：canonical 的 `outlineRatio` 是「描边总宽 ÷ **字号**」，
render 的 `outlineRatio` 是旧口径「÷ **画面高**」且优先于 `strokeWidthRatio`。
把 `{outlineRatio: 0.22}`（`bold-outline` 预设）直接展开给 render，会算成 `720 × 0.22 = 158px`
描边。正确映射见 `scripts/s43-parity.mjs` 的 `toRenderStyle()`：**改名到 `strokeWidthRatio`，不要传 `outlineRatio`**。

### 7. 触摸与触控笔（S44 · B-SUB1-R22-022）

画布手势**本来就全是 Pointer Events**（`pointerdown/move/up/cancel` + `lostpointercapture`，
没有一条 `mouse*` / `touch*` 绑定）。S44 补的是**语义**，`pointerType` 只影响四个数：

| 维度 | 鼠标 | 触摸 / 触控笔 | 为什么 |
|---|---|---|---|
| 进拖拽的阈值 | `GESTURE_CLICK_SLOP = 0.5px`（曼哈顿） | `GESTURE_TAP_MAX_MOVE = 8px`（欧氏） | 手指的接触面有 8~12px 抖动；0.5px 会让「点一下」变成一次移动 op |
| tap 判定 | 无（点击不产生 op 本来就成立） | ≤8px **且** ≤300ms → `kind='tap'`，0 op；>300ms 记 `press` | 长按不应当被当成点选，但同样不该写盘 |
| 手柄热区 | 12×12（视觉即热区） | **44×44** 透明子元素，视觉仍是 12×12 | 手指点不中 12px；44 是 HIG 的最小可点尺寸 |
| 尺寸 HUD | 指针右下 +14/+18 | 手指**右上方** 12px（`x+12`、`y−hudH−12`） | 指腹会盖住触点，标签得躲开 |

几条不能忘的细节：

- **只有粗指针才放大热区**（`(pointer: coarse)` 或 `maxTouchPoints > 0`）。鼠标页 `hitArea.handlePx`
  仍是 12，既有截图与命中行为一个像素都不动；真来了 touch/pen 事件时也会即时打开（外接鼠标的
  触屏笔记本媒体查询可能报 fine）。
- **旋转手柄的热区只向上长**（`translate(-50%,-100%)`）。它的中心只比环顶高 24px，居中放 44×44
  会和 `n` 手柄重叠 20px —— 实测 `n` 只剩 24px 高，被旋转手柄抢走。
- **拖拽增量从按下点算**，不扣掉那 8px 阈值：扣了会让落点比手指少走一截。
- **`pointercancel` 与触摸的 `lostpointercapture` 一律走取消**：不调 `onCommit`、只调 `onCancel`，
  宿主按预览值撤掉即可。鼠标的 `lostpointercapture` 仍是「按最后位置收尾」（老行为）。
- **多指**：手势进行中，第二根手指的 pointerdown 直接忽略（否则两根会互相覆盖 `start`）。
- 验收里「取消后画面与手势前**逐字节相同**」比任何 DOM 断言都硬（`s44-a5-before/after-cancel.png`
  的 sha256 相等）。浏览器自己的 `:hover` 伪类在触摸后仍会留在 `frame` 上——本模块没有任何
  `:hover` 样式，所以它不产生像素；这一点如实记在证据里，不假装清掉了。

### 8. 字幕行排：预览与成片吃同一组行（S45 · B-SUB1-R23-023）

S43 报的 P1 修了。修法不是「让 libass 学会中文断行」（它不会，WrapStyle 0/1/2/3 实测都一样），
也不是「让预览模仿 libass」（CSS 没有「只在空格断」的开关），而是**在烧录前把行排定死**：

```
cue.text ──planSubtitleLines()──> lines[]
                                   ├─ 预览：textContent = lines.join('\n')   + white-space:pre
                                   └─ 成片：toAssText(lines) 或 lines.join('\n') → Dialogue 里的 \N
```

预览侧的三条硬约束（改这个文件前先读）：

| 约束 | 为什么 |
|---|---|
| 文本节点与测量节点都是 `white-space: pre`，**不许** `overflow-wrap:anywhere` / `word-break:break-word` | 只要留给 CSS 一个断点，预览就会和成片分叉（R24-C1） |
| 高度 = `lines.length × lineHeightPx`，**不读** `getBoundingClientRect().height` | 祖先 `transform: scale(N)` 会把量出来的高度放大 N 倍（S39 的坑）；计划层是纯函数，与 DOM 无关 |
| `truncated` 由计划层给，预览不再二分找「前缀 + …」 | 两套截断必然有一天不一致；`maxLines` 只有一个实现 |

`getState()` 多了三样给验收用：`plan`（`lines/truncated/capacityEm/maxLines/widthsEm`）、
`lineWidthsPx`（逐行**自然宽**，已除祖先缩放）、`availableWidthPx`。

#### 两个接线坑（都已经踩过）

1. **`toAssText()` 的结果不能直接喂 `buildAssDocument()`**。`escapeAssText()` 会把反斜杠翻倍，
   传 `\N` 进去会变成 `\\N`（字面反斜杠 + 断行）——S45 的 A3.0 把这件事做成了判据。
   落地时二选一：传**真实换行**（`lines.join('\n')`，`escapeAssText` 会转成 `\N`），
   或者让 render 不再转义（属 P39）。
2. **`outlineRatio` 同名不同义**（S43 起就记着）：canonical 是「÷字号」，render 的同名字段是
   「÷画面高」且优先。接线时改名到 `strokeWidthRatio`，见 `toRenderStyle()`。

#### 字体（ADR-R24-02）

`fontFamily` 首位改成 `"Heiti SC"`，与 ASS 的 `Fontname` 同族；回退链仍然保留（缺字用）。
实测：预览 CDP 只命中 `Heiti SC(21 字)`，32/48/64px 字宽差 **0 / 0 / 0**（改前是 +1.07%/+1.73%/+2.22%）。

#### A4 的残差不是字体，是描边（S47 已修，见第 10 节）

S43 的 6 格 ink bbox 当时 1 格 ≤2px、5 格 |Δ| 1~8px。**关掉描边与阴影的对照实验**（A4.0，
4K + big-caption）落在 dx−1 / dy+1 / dw+2 / dh−1 —— 字形、字号、位置当时就已经对齐。
剩下的差来自两个渲染器的装饰口径（描边外扩 vs `Outline`、预览没画 shadow），由 S47 收掉。

### 9. 时间线手势（S46 · B-SUB1-R23-023）

`timeline-gesture.mjs` 把 S44 的画布状态机搬到时间线，**只做「指针 → 意图 → op」**，不画轨道、不存片段：

| 起手位置 | 判定 | 结果 |
|---|---|---|
| 片段上 | 位移 ≤8px（触摸/笔）或 ≤0.5px（鼠标）且 ≤300ms | 选中，**0 op** |
| 片段上拖 | 超过阈值 | 一次手势 = 一次提交（`props` 改 `at`），磁吸 6px 仍生效 |
| 边缘 44×44 热区 | 同上 | `props` 改 `start`+`at`（左手柄）或 `end`（右手柄） |
| 空白处横拖 | — | 只改 `scrollLeft`，不选、不动片段、**0 op** |
| 第二根手指 | — | 以两指中点为锚缩放（`pinchView()`），**0 op** |
| `pointercancel` | — | 预览与视图回滚，**不写盘** |

四条不能忘的：

- **热区由模块画**（`data-tl-hit` 透明块，44×44），视觉手柄仍归宿主。放宿主里迟早有人写回 10×10。
- **片段几何是算的，不是量的**：`left = at × pxPerSecond − scrollLeft`。读 DOM 会把「宿主画错」和
  「手势算错」混在一起，滚动时 rect 还会滞后一帧。
- **指针捕获打在视口上**：拖出视口边界还要继续收事件；捕获失败不影响状态机。
- **`pointerup` 与 `pointercancel` 是两条路**：前者在移动/裁剪时提交一次 op，后者只回滚。
  A7 的判据是「取消后的截图与手势前**逐字节相同**」（截图裁到时间线视口，排除 HUD 计数）。

op 的形状与 `packages/studio/ui/src/timeline/plan.mjs` 逐字相同（`{op:'props', edits:[{clip, prop, value}]}`），
S46 的验收脚本把同一组输入喂给 `planMove` / `planTrim` 对账（两条用例都 byte-equal）。
真正接进 Studio 的时间线（`views.ts` 的指针处理）**本批做不了**：`packages/studio/**` 只读，
接线时让宿主直接用 `plan.mjs` 产 op、本模块只提供「手势 → 输入」。

### 10. 预览的装饰：字号取整 + shadow 环描边（S47 · B-SUB1-R24-024）

S45 把**断行**对齐了，这批对齐**装饰**。9 格（3 画幅 × default/bold-outline/big-caption）
ink bbox 的 |Δx|/|Δy|/|Δw|/|Δh| 从「8 格超差、最大 8px」收敛到**全部 ≤2px**（最差 dy=2）。

#### 字号必须取整（不是审美，是 1.25% 的行宽）

ASS 的 `Fontsize` 是整数（R32 起 29 / 24 / 86 / 134，改之前是 32 / 27 / 97），预览此前用未取整的
28.8 / 24.3 / 86.4。1.25% 的差在 400px 的行上是 5px —— 720p 那格的 Δw=−4 就是它。预览改成
`Math.round(stage.h × fontSizeRatio × fontScale)` 之后，`toCssStyle().fontSizePx`
与 `toAssStyle().fontSizePx` 在交付尺寸下**逐值相等**（U9 的第五段逐格锁着）。

#### 描边：`-webkit-text-stroke` 校不出来，改用 shadow 环

实测三条（都是量出来的）：

1. text-stroke 的**可见外扩不是** `W/2` 的固定比例：圆角拉丁字形 0.475W，CJK 带尖角字形
   0.58W~0.80W，而且**横竖不等**（4K big-caption：横 0.577W、竖 0.800W）。原因是 miter 接头，
   尖角按 `半宽 / sin(θ/2)` 外伸。
2. `stroke-linejoin` / `stroke-linecap` 对 text-stroke **完全无效**：`miter/round/butt` 五种组合的
   ink bbox **逐字节相同**（`s47-decor` 的 A6.1）。
3. libass 的 `Outline` 是各向外扩量、圆角、横竖相同。

所以「给 text-stroke 乘一个系数」这条路是死的：4K big-caption 需要横 `1.73×O`、竖 `1.25×O`
两个**互斥**的系数，一个标量不可能同时满足两轴。预览改用 **N 个零模糊 `text-shadow`
做形态学膨胀**（`cssOutlineRing()`）：

- 轴向那四个偏移恰好 ±r，所以 ink bbox 的外扩**精确等于 r**；令 `r = ASS Outline` 就天然对齐；
- 方向数按半径取（8/12/16/24，永远是 4 的倍数 —— 保证 0°/90°/180°/270° 在环上），
  弓高 `r(1−cos(π/N)) ≤ 0.31px`，看不出多边形；
- 投影（`shadowPx = round(stage.h × shadowRatio)`）也是一整圈环，整体再平移 `(d, d)` 并放在
  **列表最后**（CSS 的 shadow 先写的画在上面），露出来的正好是右下 `d` 宽的一条 —— 与 ASS 的
  `Shadow` 同口径（A3 的 growth 判据）。

#### 底色：本批**不画**（`notDone`，等 S50）

`background` 字段留在 schema 里，但预览恒为 `transparent`：ASS 的 `BorderStyle` 恒为 1
（`backColour` 不生效），预览画一块成片没有的底色就是骗人（A5 用 `#ff0000` 验证 DOM 上不出现红底）。
等 render 支持 `BorderStyle 3` 再把两边一起打开。

#### 加粗

`bold: true` → CSS `font-weight: 700`，ASS `Bold=-1`；32/48/64px 三档 ink 宽度差
0 / 0.167% / 0.25%（A4）。

#### 一个仍然存在的差（不是这批的事）

多行时 CSS 的行盒高（`fontSize × 1.25`）与 libass 按字体 ascent/descent 排的行距不同
（720p 两行差约 8px）。它不影响单行 bbox，但会让**两行以上的块高**在预览里偏高一点点；
要修得让 libass 吃 `Spacing`（render 侧），属 S50 之后。

### 11. 测试自己的运行环境：不依赖本地目录（S48 · B-SUB1-R24-024）

`packages/layers/*.test.mjs` 以前把 `<repo>/.local-runs/sub1/runs/R12/env.json` 这样的路径
**写死在模块顶层**。那些目录是本地的、不入库的（`.local-runs/` 在 `.gitignore` 里），
所以合进集成树之后 `node --test packages/layers/*.test.mjs` 会报 **163 条 hookFailed** ——
不是测试失败，是测试**不可移植**：每次审计都得先手工补十几个 `env.json` 才看得见真结果（R26-C1）。

现在统一走 `packages/layers/test-env.mjs`：

```js
const TEST_ENV = await resolveLayerTestEnv({ suite: 'subtitle-overlay' });
const RUN_ROOT = TEST_ENV.runRoot;        // 证据/临时文件都在这下面
const EVIDENCE_DIR = TEST_ENV.evidenceDir;
const TMP_DIR = TEST_ENV.tmpRoot;
```

解析顺序（`resolveLayerTestEnv`）：

1. `OPENCUT_ENV_JSON` 有值 → **完全沿用**（派工环境与验收脚本仍按原路径写证据，行为不变）；
2. 否则 `<repo>/.local-runs/layers/<suite>/env.json`；
3. 文件不存在就建：`suite` = 测试文件名去掉 `.test.mjs`，端口用 `net.createServer().listen(0)`
   让内核分配（**不写死 5937x**，避免并行/多分支互相抢端口），分配时先排掉兄弟 suite 已用的端口，
   落盘用「临时文件 + rename」（两个进程同时创建同一个 suite 也不会读到半截 JSON）；
4. 文件存在就复用 —— 第二次跑不重新分配端口，证据也还在原处（返回的 `created` 只有第一次是 `true`）。

跑法（干净克隆也能跑）：

```sh
node --test --test-concurrency=1 packages/layers/*.test.mjs
# 想指定某处证据目录时（旧行为，一字不变）：
OPENCUT_ENV_JSON=$PWD/.local-runs/sub1/runs/R24/env.json node --test --test-concurrency=1 packages/layers/*.test.mjs
```

两条注意：

- **端口是自动分配的**，所以证据里的端口号每次新建 env 时都可能不同；要复现某一轮的数字，
  带着那一轮的 `OPENCUT_ENV_JSON` 跑。
- `discover` / `inspector-browser` 里有几个**固定端口**（`FILM_LAYER_PORT` / `FILM_INSPECTOR_PORT`
  的默认值 59374/59375），它们与这套 env 无关；并行跑很多 suite 时若撞上自动分配的端口，
  用那两个环境变量覆盖。

## 12. 计时用例的判据：同页基线 + p95（S49）

两条计时用例（`snap-perf.test.mjs` 的 B5、`stage.test.mjs` 的 S4-A10）连续三轮在带负载的
机器上假红，单独复跑全绿。根因是**判据的形状**，不是产品：绝对阈值 + 单次最坏值。

现在的三条规则（实现见 `perf-budget.mjs`）：

1. **同页基线**：同一个页面、同一次会话里先跑一遍同样的工作量，把被测处理换成空实现，
   量出 `baselineP95`；判据 `measured ≤ max(floor, baseline × factor + slack)`。
   `floor` 是产品预算（一帧 16ms），相对项是「这台机器此刻就是这个速度」的让步。
2. **p95 而不是 max**：`max` 只进证据。B5 从 30 帧涨到 120 帧 —— 30 个样本的 p95 是
   「第二差」，两次调度抖动就能把它顶到 60ms（R28 全量连跑实测过）。
3. **间隔对空转**：rAF 间隔不再拿 60Hz 的 16.7ms 当常数，而是与**同页空转 rAF**比，
   前后各量 30 帧取并集（并行跑别的测试时负载是成段来的）。

判据没被削弱：两条用例各带一段**注入对照** —— 把处理人为拖到判据的 3 倍（忙等
`3 × budget`，720p 下 48ms），同一条量测路径必须报红并把「实测 / 基线 / 判据」打出来。
为什么不注入「3 × 实测」：0.6ms × 3 = 1.8ms 在 16ms 预算内本来就该绿，那正是 `floor` 的意义。

⚠️ 基线的方向要记牢：空载 pointermove 的基线（≈1ms）比真实拖动处理（≈0.4ms）**还高**，
因为空实现里调了 `getState()`（每次构造完整状态对象）。基线偏高只会放宽判据、不会造成假红。

⚠️ 帧间隔的**中位倍数**在 R31 从 1.5 调到 3：单跑时拖动帧 / 空转 = 1.05×（18.2 / 17.3ms），
十个 Chromium 并行时 = 2.1×（35.3 / 16.7ms）。拖动帧要一次 500 层 layout+paint，空转帧
只要一个时间片，两者对「机器被占满」的敏感度不同 —— 比值被负载放大，不是产品退化。
3× 仍能抓住真回归（单跑 18ms 要涨到 54ms 才绿）。这条与 BLK-R28-2 是同一件事：
并行度没定之前，帧间隔只能当相对指标。

## 13. 多行字幕的块度量（S50）

单行 bbox 在 S47 已经对齐（≤2px），多行**块高**此前每行多 0.25em（720p 两行 8px）。
原因是 ASS/libass **没有行距字段**：多行按字体 ascent+descent 堆，Heiti SC 加起来正好 1 em
→ 成片的行距 = `Fontsize`；预览按样式表的 `lineHeight: 1.25` 排，于是每行多 0.25 字号。

现在的口径：

- `toCssStyle().lineHeightPx = fontSizePx × SUBTITLE_LINE_STEP_K`，`K = 1`（标定表在常量注释里：
  3 画幅 × 3 预设 × 1/2/3 行 = 27 格，行距逐像素等于 `Fontsize`）。
  样式表的 `lineHeight` 只剩「相对增量」和 ASS 的 MarginV 半行距两个用途。
- 块是**底对齐**的：行盒变矮会让最后一行下移半行距，所以另给
  `textOffsetPx = (fontSize × lineHeight − lineHeightPx) / 2`，覆盖层用
  `position:relative` + `top` 把文字相对上移 —— 不动布局、不改块高、`bottom` 仍是 8% 安全区。

量法（`scripts/s50-block-metrics.mjs`）：每行内容**完全相同**的 cue（由 `planSubtitleLines`
决定断点），两边都画在纯绿画布上，于是

```text
行距 = (块高_3 − 块高_1) / 2        # 单行 ink 高整项抵消，逐行取整噪声进不来
行间净空 = 行距 − 单行 ink 高        # 各用自己的 ink 高，比的是纯排版间距
```

**别用「块高_n − 单行高」算行距**：只有一个行距在减，单行的 ±1px ink 差会原样变成行距误差
（720p big-caption 的 n=2 会因此造出一个假的 −2）。

## 14. 检查器效果字段（S51）

检查器从 11 个字段长到 16 个：新增的五个都在 `appearance` 组，顺序写死为
**不透明度之后、描边之前**（`inspector-fields.mjs` 的 `STYLE_FIELDS`）。

| 字段 id | CSS key | 控件 | 范围 | 空值/默认 |
|---|---|---|---|---|
| `filter` | `filter` | 下拉预设 + 自定义文本 | 6 个预设 + 任意合法函数列表 | `none` |
| `mixBlendMode` | `mix-blend-mode` | 下拉 | `normal/multiply/screen/overlay/darken/lighten` | `normal` |
| `borderRadius` | `border-radius` | 数值（px） | 0–400，**拒绝负值与百分比** | `0px` |
| `boxShadow` | `box-shadow` | 文本 | 原样 CSS（拒绝 `; { } < >`），空串 = `none` | `none` |
| `backdropFilter` | `backdrop-filter` | 下拉预设 + 自定义文本 | `none` / `blur(8px)` / `blur(16px)` + 自定义 | `none` |

**不用动合同**：`OverridePatch.style` 本来就是 `Record<string,string>`，这五个键只是
`overrides.style` 里的普通声明，`apply-overrides.mjs` 用 `el.style.setProperty(key, value)`
原样写，宿主一个分支都不用加。

### 14.1 预设 ↔ 文本必须可逆

`filter` / `backdrop-filter` 的「下拉 + 自定义」是同一个值的两种呈现：
`describeChoice()` 用 `normalizeCssValue()`（小写、折叠空白、去掉 `(),` 两侧空格）把当前值
对回预设；对不上就是「自定义」，下拉显示哨兵 `__custom__`、文本框露出原文。
**选到 `__custom__` 不提交**（它不是一个 CSS 值，只用来展开文本框）。

不归一化就会踩这个坑：computed 会把 `blur( 4px )` 折成 `blur(4px)`，逐字符比会永远「自定义」。

### 14.2 校验在哪、为什么在那一层

- 控件层：`<select>` 里根本没有非法选项（`<select>.value='foo'` 会被浏览器折算成空），
  数值框是 `type=number`。所以「非法值」这条必须打到**提交入口**（`patchForField`）才有意义。
- 提交入口：`mixBlendMode` 只认六个值；`borderRadius` 走 `NUMERIC_STYLE_FIELDS` 的
  `min/max/allowPercent:false`；`filter`/`backdrop-filter` 走 `parseFilterList()`
  （`none` 或 `name(args)` 的空格分隔序列，未知函数/空参数/残留字符一律 `INVALID_VALUE`）；
  `box-shadow` 只挡声明截断字符。
- 失败语义沿用 S11/S13：`INVALID_VALUE` + 不发请求 + 面板状态变 `error`。

### 14.3 与导出的关系（A5 量的是什么）

`SceneHost.frame()` 返回的是**时序信息，不是图片**；交付路径是
`frame(t) → apply-overrides → 截图/编码`。所以「预览 vs 导出帧」比的是同一页面的两张截图：

- 预览：覆盖应用后直接截图；
- 导出：先跑一次 `host.frame()`，再重新应用**同一份**覆盖，然后截图。

夹具 `tests/fixtures/scenes/inspector-effects.html` 的 `film.frame()` 不碰内联样式，
于是两张图的差别只可能来自「覆盖有没有被帧重画擦掉」。实测（720p 纯绿底，
`filter:blur(4px) + border-radius:24px`）：改前 ink 420×240，改后 428×248（blur 外溢 8px），
预览与导出的 bbox **delta 全 0**，ink 像素数逐一相同。

### 14.5 裁切 / 背景图 / 内阴影（S54）

上一批补了滤镜/混合/圆角/盒阴影/背景模糊，这批再补三个「卡片/截图/画中画」最常用的：

| 字段 id | CSS key | 控件 | 范围 / 拒绝 |
|---|---|---|---|
| `clipPath` | `clip-path` | 4 个数值框（上右下左）+ px/% 单位下拉 | 非负、1–4 个值按 CSS 简写展开、序列化成 `inset(t r b l)`；负值 / 非 inset / 四边合计达到盒尺寸 → `INVALID_VALUE` |
| `backgroundImage` | `background-image` | 文本 | `none` / 工程内相对路径 / `data:image/{png,jpeg,gif,webp,svg+xml};base64,…`；`..`、绝对路径、任何 scheme（`http(s):`/`file:`/`javascript:`）一律拒 |
| `backgroundSize` | `background-size` | 下拉 | `cover` / `contain` / `100% 100%` |
| `backgroundPosition` | `background-position` | 下拉 | 九个方向词（center / top / … / bottom right） |
| `boxShadowInset` | `box-shadow` | 文本 | 必须以 `inset` 开头；空串 = 去掉这一半 |

三个设计点：

1. **裁切是 4 格 1 条声明**：`clip-path` 只有一条，四格在同一 tick 内改完只提交**一次**
   `/ops`（`Promise.resolve()` 微任务合并）。改一格就是一次——真实用户一次只改一格。
2. **背景图是白名单，不是黑名单**：这条声明最终会进 `el.style.setProperty()`，放任意 URL
   等于给工程文件开一个外链出口（离线导出、隐私、`file://` 读盘都在线上）。
3. **`box-shadow` 一个通道两个语义**：模型按 `inset` 前缀把值拆成「外阴影 / 内阴影」两行显示，
   提交时用另一半（`sibling`）合回一条 —— 改内阴影不会把外阴影冲掉，反之亦然。
   两行都写 `inset`/非 `inset` 时按字段语义拒绝（`INVALID_VALUE`），不静默互换。

裁切**只影响绘制**：`getBoundingClientRect` 与 `hitTest` 都按盒算（与浏览器一致，A3 验了
四数逐值相同、命中同一层）。内阴影只画在盒内，外轮廓 bbox 不变（A6 用「外阴影会扩」做对照，
证明判据不是永远相等）。

### 14.4 几何不变

五个键都不改布局，但 `backdrop-filter` 会创建包含块，所以 A4 实测了
`getBoundingClientRect` 四数**逐值相同**（不是「差 ≤1」）、`hitTest`/`marqueeSelect`
命中同一批层、`planAlign` 产出的 op 逐字节相同。夹具里没有依赖 static 定位的后代，
所以「包含块」这条在真机上也没有可观察差异——如果以后有，先看这里。

## 15. 计时用例清账：两条大场景用例也换成同页基线（S52）

S49 只治了 `snap-perf` 的 B5 与 `stage.test` 的 S4-A10；`large-scene-perf.test.mjs`（200 层）
与 `large-scene-500.test.mjs`（500 层）里还留着**写死的绝对阈值**（500 / 50 / 20 / 100ms），
同一类假红迟早回来。这批把它们也换了，判据算术只有一份（`perf-budget.mjs` 的
`judgeAgainstBaseline` / `judgeByBaseline`）。

### 15.1 基线的取法：一半数据量

两个文件都用「**同 fixture、同操作、一半层数**」当基线：

| 文件 | 正式量测 | 基线 |
|---|---|---|
| `large-scene-perf.test.mjs` | 200 层 | 前 100 层 |
| `large-scene-500.test.mjs` | 500 层 | 前 250 层 |

`getLayerRects` 是「每次现算 N 个 `getBoundingClientRect`」（真实宿主的写法），所以
层数减半 = 工作量减半，机器慢的时候两边一起慢。判据

    measuredP95 ≤ max(floor, baselineP95 × 4 + 2)

`× 4` 留给「2× 数据量的超线性成本 + 调度抖动」，`+2ms` 是给小指标的固定余量
（`select` 的 baseline 只有 0.2ms，光靠乘法凑不出有意义的预算）。

### 15.2 采样：40 次，p95 进判据

`mount` / `select` / `tree` 各 40 次独立采样，拖动是 2 秒窗口（≈120 帧）。
以前 `tree` 只量**一次**挂载，一次 GC 就能定生死；现在是 40 次的 p95。

⚠️ 40 次连续挂载的 p95 比「单次首挂」高（后面的样本吃到 GC 压力）。这不影响判据：
基线用**同一段循环**，偏差在比值里抵消。200 层那格 `tree` 的基线（47.7ms）甚至比实测
（34.4ms）还高 —— 基线偏高只会放宽，不会造成假红。

### 15.3 注入：`OPENCUT_PERF_INJECT=1`

每条量测路径都能塞忙等（`INJECT_MS`：`mount` 2000 / `select` 400 / `drag` 400 / `tree` 800）。
注入量必须压过 **baseline × 4**，只压过 floor 不够——基线在忙机器上会涨，预算跟着涨。
注入时样本降到 6 个（不然光注入就要几十秒），并打印四行

    JUDGE mountMs measured=2032.5 baseline=34.7 budget=500 pass=false | 2032.5 ≤ max(500, 34.7×4+2) = 500

`pass=false` 与退出码 ≠ 0 就是「判据不是橡皮图章」的证据。

### 15.4 阈值只剩 floor

```sh
grep -n "≤ *[0-9]" packages/layers/*perf*.test.mjs   # → 0 行
```

阈值全部收进 `FLOORS`（`{mountMs:500, selectMs:50, dragP95Ms:20, treeRenderMs:100}`）与
`perf-budget.mjs` 的公式里；`FLOORS` 只许调小，不许调大（A4 用上面那条 grep 看住）。

## 16. 字幕底色框：预览 + 给成片的契约（S53）

ADR-R28-01 定了「底色框走独立矢量矩形」：ASS 的 `BorderStyle 3` 会把描边通道换成底色通道
（开底色就没描边，R28 实测），所以「描边 + 底色」单条 Style 表达不了。S50 交了块高/行距，
这一节补上**每行矩形的宽度与坐标**，以及预览怎么画。

边界写死：本 lane **只做预览与度量**。成片的 ASS 矩形由副线2 的 P49 按 §16.5 的契约实现，
`packages/render/**` 一个字节没动。

### 16.1 坐标口径（`packages/layers/subtitle-box.mjs`）

`measureSubtitleLines({ style, stage, lines, metrics, advanceRects })` 返回**舞台坐标**：

| 字段 | 含义 |
|---|---|
| `lines[i].x/w` | 该行**字形墨迹**的左右边界（不是 advance 盒） |
| `lines[i].y/h` | 行盒顶 / 行距（`h = lineHeightPx`，S50 标定 = `Fontsize`） |
| `lines[i].advanceX/advanceW` | 排版 advance 盒（含行尾空格的那一版宽） |
| `boxes[i].x/y/w/h` | **要画的矩形** = 行盒 ± (`padding` + `outlinePx`) |
| `block` | 所有 `boxes` 的并集 |
| `padding` / `radius` / `outlinePx` | 见 16.2 |

`x/w` 为什么不是 advance：Heiti SC 的 CJK 每侧有约 **0.06em** 的 side bearing
（32px→1.9px、45px→2.7px），拿 advance 当框宽会宽出 0.12em。27 格里 `|Δw|` 实测 0.9–1.8px，
而按 advance 算是 3.8–5.4px（`strict2px` 之外唯一会超 2px 的一项）。要「含空格的行宽」时用 `advanceW`。

### 16.2 padding / 圆角 / 描边环

- 水平 `0.15em`、垂直 `0.08em`、圆角 `0.2em`（em = 取整后的 `Fontsize`）；
- **框还要让开一个描边环半径** `outlinePx`：`text-shadow` 环是对称外扩，0.22em 的粗描边
  会戳出框外（bold-outline 实测戳出 3.03px，A2 会红）。所以
  `boxes = 行盒 + padding + outlinePx`，`lines` 仍是纯文字行盒；
- 圆角只是**预览观感**：ASS 里没有圆角，成片是直角；多行时相邻两行框按 `0.08em+描边`
  重叠，圆角会在接缝处留两个小凹口（成片没有）。这是预览独有的装饰，不影响几何。

### 16.3 度量从哪来：Range 还是 canvas

两个都用，各管一段：

| 量 | 来源 | 为什么 |
|---|---|---|
| 每行的 advance 宽 + 行盒位置 | `Range.getBoundingClientRect()` | 浏览器**真的排过版**：断点、空格、字距、`text-align` 都在里面。canvas 只认一个字体串，它不知道计划层断在哪个空格上 |
| 字形左右 bearing | canvas `measureText().actualBoundingBox*` | Range 只给 advance 盒，给不出墨迹；bearing 是字体度量，与断行无关 |

都不给时按 canvas → 估算（复用计划层的 `estimateAdvanceEm`，`source: 'estimate'`）降级。
**估算不含 bearing**，只配用来验算法，不能拿去对像素。

### 16.4 预览怎么画（`subtitle-overlay.mjs`）

- 覆盖层里多一个 `data-subtitle-box-layer` 层，**在文字容器之前**（同一 stacking context，
  先画的在下）；每行一个 `div[data-subtitle-box][data-line=i]`，`pointer-events:none`、
  `aria-hidden`；
- `background: transparent`（含 `none` / 全透明 rgba）→ **0 个框节点**，而且
  `lineBoxes` / `block` 照旧给出来（A1 量的是几何，不是框）；
- `updateStyle` 与 `render(t)` 都同步：节点数按行数**多退少补**，不重建文本节点
  （A3 验了 `firstChild` 引用不变）；
- 文本节点仍是 `white-space: pre` 的那一个，按 `\n` 切 `Range` 量行 —— 不重建 DOM。

### 16.5 给副线2 的 ASS 契约（可照抄）

```text
PlayRes = 交付画布（与 buildAssDocument 的 size 一致）
坐标   = 舞台坐标 × scale + offset，scale = min(canvas.w/stage.w, canvas.h/stage.h)
         offset = ((canvas.w − stage.w×scale)/2, (canvas.h − stage.h×scale)/2)   # letterbox
矩形   = {\an7\pos(x,y)\p1}m 0 0 l w 0 l {w} {h} l 0 {h}{\p0}
         \pos 是**左上角**（\an7），x/y/w/h 用上表的 boxes[i]（已含 padding + 描边环）
颜色   = BackColour，alpha 与 preview 的 background 相同
圆角   = 做不到（直角）；preview 的 0.2em 圆角只是观感
多段   = 矩形跟着 cue 走（P40 的 cue 映射），每个 cue 各自一组矩形
```

**720p、两行、默认样式**（A6 的实测输出，可直接当单测夹具）：

| | x | y | w | h |
|---|---|---|---|---|
| rect 0 | 162.53 | 589.84 | 954.94 | 41.12 |
| rect 1 | 162.53 | 621.84 | 954.94 | 41.12 |

`Fontsize=32`、`lineHeightPx=32`、`outlinePx=2`、`padding=(4.8, 2.56)`、`radius=6.4`、
`marginV=61.6`；两行对应的 ASS 路径：

```text
{\an7\pos(162.53,589.84)\p1}m 0 0 l 954.94 0 l 954.94 41.12 l 0 41.12{\p0}
{\an7\pos(162.53,621.84)\p1}m 0 0 l 954.94 0 l 954.94 41.12 l 0 41.12{\p0}
```

竖屏（1080×1920 画布）同一组数字换算后：`scale=0.84375`、`offset=(0, 656.25)`，
rect 0 → `x=137.14, y=1153.93, w=805.73, h=34.7`。

### 16.6 27 格实测（`scripts/s53-box-metrics.mjs`）

`3 画幅 × 3 预设 × 1/2/3 行 = 27 格`，每行 rect 对字形 ink（关描边/阴影，量的是字不是装饰）：

| 画幅 | Fontsize | worst \|dx\| | worst \|dy\| | worst \|dw\| | worst \|dh\| |
|---|---|---|---|---|---|
| 720p | 32 / 45 | 0.22 | 0.81 | 1.17 | 2 |
| 竖屏 1080×607.5 | 27 / 38 | 1.01 | 1.19 | 1.79 | 1 |
| 4K 3840×2160 | 97 / 134 | 1.03 | 5.34 | 1.72 | 9 |

4K 那两列的 `dy/dh` 超过 2px 是**字体度量**：字形墨迹只有 em 盒的 0.93–0.97，而行盒按 S50
的标定是整 `Fontsize`，134px 上两者差 9px。判据因此是 `|Δ| ≤ max(2px, 0.07em)`，
原始值全部记账（`strict2px` 字段单列「按字面 2px 会红哪几格」）——见交接的 DEV-R33-1。

## 17. 串行化之后暴露的两个死锁点（S55）

全局只放 1 个浏览器（ADR-R36-01）以后，凡是「父进程自己持有 Host，又 `execFile` 起子进程跑
`node --test`」的用例都会互等：父进程占着槽，子进程在**自己的进程里**申请同一个槽，
两边一起等到 15 分钟取槽超时（runner 的 per-file 超时也到点）。已修两处，**只改测试文件**：

- `large-scene-perf.test.mjs` 的 A6：跑 9 个回归文件前 `await host.stop()`，
  `finally` 里 `startHost()`（A8 还要开新页）。子进程跑完 **70 pass / 0 fail**。
- `motion-capture.test.mjs` 的 A5：先做完取帧/错误码断言，再 `host.stop()`，然后跑 3 个回归文件。
  整个文件 **5/5，180.8s**。

修之前 `large-scene-perf` 会卡在 A6 十分钟以上（旧证据里被当成「慢」）。

### 17.1 文件级超时被杀时，`after` 不会跑

runner 在 `--timeout-ms` 到点对文件进程发 SIGTERM。node:test 的文件级 `after()` **不执行**
（哨兵文件没写出来就是证据），`process.on('exit')` 的同步兜底也可能来不及 —— 实测会留下一个
`alive:false` 的陈旧槽。下一次取槽按 `owner.pid` 判死自动回收：紧接着复跑同一个文件
**10/10、18.6s**，跑完 `slotSnapshot()=[]`。结论：不会永久占位，但**不要假设 `after` 一定跑**。

## 18. 字幕行距：预览跟随 film-core 的唯一权威（S58 / ADR-R37-03）

行距换算只有一个实现：`packages/film-core/subtitle-layout.mjs` 的 `subtitleLineStep(style)`，
`em = lineHeight / 1.25`（1.25 → 1em、1.8 → 1.44、1.0 → 0.8）。预览**只消费**，不另算一套。

`toCssStyle()` 里：

```js
const step = subtitleLineStep(style);
const lineHeightPx = round(fontSize * SUBTITLE_LINE_STEP_K * step.em, 2);   // K 仍是 libass 标定的 1em
```

- 默认 1.25 → em=1 → 与 S50 的 27 格**逐像素相同**（截图 sha 27/27 一致，见 `evidence/rounds/R29-SUB1`）。
- 1.0 / 1.8 从旧的线性增量（`1 + (lineHeight − 1.25)`，会给 0.75 / 1.55em）改成 0.8 / 1.44em。
- `textOffsetPx` 仍是 `(fontSize × lineHeight − lineHeightPx) / 2`：行盒变矮的那半行距靠它把文字相对上移，
  块的底边不动。
- **成片侧的 `\pos` 由副线2 P53 落**；P53 合入前，成片行距恒为 libass 的 1em，非默认格在验收里
  标 `pending-P53`（预览 25.594/46.078 vs 成片 32，差 6.4/14.1），不写进 ASS。
