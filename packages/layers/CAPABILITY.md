# 图层能力分级（WP12 · 判定写死）

本文件是 UI 的唯一判定依据：`FULL / PARTIAL / PIXEL_ONLY / UNSUPPORTED` 只按下面条件落，
**不允许按“看起来能改”猜**。能力值与 `contracts/layers.ts` 的 `LAYER_CAPABILITY` 一致：

```ts
LAYER_CAPABILITY = {
  dom: 'FULL',
  svg: 'PARTIAL',
  canvas: 'PIXEL_ONLY',
  webgl: 'PIXEL_ONLY',
  shadowDomClosed: 'UNSUPPORTED',
  crossOriginFrame: 'UNSUPPORTED'
}
```

## 1. FULL — 可完整编辑

同时满足：

1. 目标及祖先链上没有 `<canvas>`（WebGL 也挂在 canvas 上）。
2. 目标不在跨源 iframe 内；`iframe.contentDocument` 可读。
3. 目标不在 Closed Shadow Root 内（`el.getRootNode()` 可达 document）。
4. 同源可读 `getComputedStyle`，且 `getBoundingClientRect()` 有非零可见性
   （`display != none`、`visibility` 非 hidden/collapse、`opacity > 0`）。
5. 是普通 HTML 元素（`namespaceURI === http://www.w3.org/1999/xhtml`）。

允许的覆盖：几何（x/y/w/h/rotation）、样式（颜色/背景/字号/描边/圆角/透明度）、文本。
判定来源：`discover()` 返回 `kind` 为 `text | image | shape | container | unknown` 且不在
`pixelOnly` / `unsupported` 列表中。

## 2. PARTIAL — 可改但不可逆

满足任一：

1. SVG 元素（`namespaceURI === http://www.w3.org/2000/svg`）。
   - 几何与 `fill/stroke/opacity` 可覆盖；
   - 滤镜、遮罩、marker、pattern 内部引用不保证可逆写回；
   - 仍按运行 DOM 返回层，但 UI 必须显示 PARTIAL。
2. 同源但样式表不可读（例如 `adoptedStyleSheets` 或跨源 `<link rel=stylesheet>`）
   导致 `getComputedStyle` 只拿到继承值。
   - 此时只允许几何覆盖；拿不到的值标 PARTIAL，**不得用默认值猜**。

## 3. PIXEL_ONLY — 只有像素

满足任一：

1. 元素是 `<canvas>`；
2. 元素在 `<canvas>` 内（正常 DOM 不可能，防御历史/自定义元素）。
3. WebGL 场景的 canvas 同上。

行为：

- `discover()` 照常返回该 canvas 这一层（`kind` 为 `unknown`），并放入 `pixelOnly` 列表，能力 `PIXEL_ONLY`；
- `locate()` 命中 canvas 或其后代 → `NOT_EDITABLE`（`LayerError`），不返回内部对象；
- 允许整体位移/缩放/替换位图，不允许“选中画布里的某个圆”。

无 GPU 时 WebGL 走 SwiftShader：取帧允许
`meanAbsDiff ≤ 2`、`maxChannelDiff ≤ 12`（见 `packages/scene-runtime/profiles.mjs`），
但**同机同 t 的 sha256 仍必须一致**，不得宣称“逐像素跨设备一致”。

## 4. UNSUPPORTED — 不注入、不尝试

满足任一：

1. 跨源 iframe：`iframe.contentDocument` 为 `null` 或抛 SecurityError；
2. Closed Shadow Root：`attachShadow({mode:'closed'})` 的内部节点；
3. 任何需要注入脚本才能读取、而注入被同源策略拒绝的区域。

行为：

- `discover()` 把该 iframe/宿主层正常返回（外层元素本身可整体移动），
  同时在 `unsupported` 列表标记
  `{ at, reason: 'CROSS_ORIGIN' | 'CLOSED_SHADOW', capability: 'UNSUPPORTED' }`；
- **绝不向跨源 frame 注入脚本**，不尝试 `contentDocument` 写操作；
- UI 命中该区域时显示“不可编辑（跨源/封闭 ShadowDOM）”，不落 override。

## 5. 层分类规则（discover 与 locate 必须一致）

| kind | 判定 |
|---|---|
| `text` | 自身直接文本节点非空；或 `h1..h6/p/span/a/li/button/label/...` 且 `textContent` 非空 |
| `image` | `<img>` / `<picture>`；或无元素子节点且 `background-image` 为单个 `url(...)` |
| `shape` | 无文本、无元素子节点，且有背景色/边框/圆角 |
| `container` | 有其他元素子节点；`<iframe>` 固定为 container |
| `unknown` | 其余（含 canvas） |

跳过：`html/head/script/style/meta/link/title/base/noscript/template/br/source/track`
与不可见元素（`includeInvisible:false` 时）。

## 6. 定位串 `at`

1. 元素有唯一 `id` → `#id`（`CSS.escape` 转义）。
2. 否则 → `body > tag.class:nth-of-type(n) > …` 路径；`n` 是**同标签兄弟**序号。
3. 同名同结构兄弟由 `nth-of-type(n)` 天然消歧，**不会**产生 `AMBIGUOUS`。
4. 重载后按 `at` 复算：0 命中 → `LAYER_GONE`；>1 → `AMBIGUOUS`。
5. `at` 只依赖结构与 id，不写运行时像素值，因此重开工程仍可复算。

## 7. 快照一致性

`discover()` 先 `await` 一帧 rAF，再在页面内做**一次同步遍历**（遍历中不 `await`）。
MutationObserver 持续改动时，返回的是同一时刻的切片，不会半新半旧。
同名 class 但 DOM 路径不同 → 两条独立层，不合并。

## 8. 写入与提交（S10 · 落盘在 MAIN）

### 8.1 谁写哪个属性

| 属性 | 写入者 | 说明 |
|---|---|---|
| `transform` | **场景**（`frame(t)`） | 覆盖应用器从不写它，也不解析它 |
| `scale` / `rotate` | **覆盖**（`apply-overrides`） | CSS 个体变换属性，`s`/`r` 落在这里 |

合成顺序由 CSS Transforms Level 2 写死：`translate → rotate → scale → transform`，
即 `M = translate · rotate(r) · scale(s) · 场景 transform`。清覆盖时用 `removeProperty`
把这两个属性摘掉，元素回到该帧场景值（不残留 `scale(1)`）。
合成不安全 → `NOT_SUPPORTED` + 原因，**不静默覆盖**。判定顺序：

| 场景 | 结果 | 原因码 |
|---|---|---|
| `display: inline` | 拒绝 | `INLINE_ELEMENT`（CSS 规定行内元素不可变换，写了也没效果） |
| 场景/样式表已占用 `scale`（不是我们写的） | 拒绝 | `SCENE_OWNS_SCALE` |
| 场景/样式表已占用 `rotate`（不是我们写的） | 拒绝 | `SCENE_OWNS_ROTATE` |
| 祖先有 `transform` 且本元素 `transform-origin` 不在中心 | 拒绝 | `TRANSFORM_ORIGIN_CONFLICT`（支点会随祖先漂移，和用户看到的不是同一次旋转） |

拒绝时**不写任何属性**（已有的我们自己的旧值会被清掉），元素保持场景当帧的样子。

### 8.2 提交路由（与 MAIN 相同，不另发明）

两条写入口，**一批一条 Op**，同一个 `POST /api/projects/:id/ops`：

```
POST /api/projects/:id/ops
{ "envelope": { "projectId", "batchId", "owner", "expectedHash", "opId" },
  "ops": [ { "op": "overrides", "clip": "<clipId>", "entries": [ ...完整 overrides 数组... ] } ] }

{ "envelope": { …同上… },
  "ops": [ { "op": "set", "clip": "<clipId>", "field": "box",
             "value": { "x": 40, "y": 0, "w": 300, "h": 150, "r": 15 } } ] }

200 { ok: true,  hash, changed }
409 { ok: false, code: "CONFLICT", currentHash, message }
400 { ok: false, code: "INVALID" | "NOT_FOUND" | "LOCKED", message }
```

- **一批一个 Op**：改两层就发两次；`entries` 是合并后的**完整数组**（MAIN 整段替换 `overrides`）。
- 合并规则只有一份：`override-merge.mjs` 的 `mergeOverridesAt`（层条目按 `at` 合并，
  片段自有 `fade` 条目原样保留，其他层不动，空条目删除）。
- 失败不重试：409 把 `currentHash` 交回人决定；400/网络错误如实显示，**不伪造成功**。

### 8.2.1 三方合并（`person-merge.mjs`）

Agent 重写场景后，人改过的 `overrides` 不能被冲掉：`mergePersonOverrides({base, ours, theirs})`
以「clip + 条目 key（`@own` 或 `at`）」为单位做三方决策——只有一边改取那边；两边不同留 ours 并记
`{unit, person, writer}` 冲突；`theirs` 删除且 ours 未改才删；被丢弃的 theirs 版本进 `writerKept`
（结构化，由调用方决定是否写 `.film/conflicts/`）。只合并 overrides，不碰时间线字段/源码，不落盘。

### 8.3 `data-persist="real"`

S11 起检查器面板**接的是真实 Studio**：`POST /api/projects/:id/ops` → 服务端写队列 + `FilmDocIo`（CAS：
临时文件 → fsync → rename → 回读校验）→ 落盘成功才返回新 hash。
面板根节点与状态栏的 `data-persist` 写 `real`，意思是「已接真实服务」，**不是**「面板自己写文件」：
`packages/layers/**` 仍然不读不写 `film.html`，只用 HTTP。

> 历史：S10 用测试内 stub 验证请求形状，当时 `data-persist` 为 `WAIT_MAIN_IO`（等主线落盘）。
> 该状态已被 `real` 取代，`WAIT_MAIN_IO` 常量只为兼容旧引用保留。

### 8.4 几何（位置/尺寸/旋转）· S13

面板的「位置/尺寸/旋转」不走 overrides，走 `set` op 的 `field:'box'`，落到**片段自己的 `style`**
（`left/top/width/height/rotate`）。两套写入口互不污染：改了文字不会动几何，改了几何不会动 `overrides`。

| 字段 id | box 键 | style 声明 | 清空（空值） |
|---|---|---|---|
| `x` | `x` | `left` | 变 0（`styleText` 总会写 left/top，删不掉声明） |
| `y` | `y` | `top` | 同上 |
| `w` | `w` | `width` | **拒绝**（film-core 要求 w/h > 0） |
| `h` | `h` | `height` | **拒绝** |
| `rotation` | `r` | `rotate` | 删掉声明（不写 `0deg`） |

- `box` 在 film-core 里是**整体替换**（`{x,y,w,h}` 必填、`w/h>0`、`r` 可选），所以面板每次都把基准框里
  另外三个值一起提交；`r=0` 与「没有 rotate 声明」是同一状态，提交时**不带 `r`**。
- 基准框来源：宿主 `deps.boxOf(at)`（片段声明的 box）优先，没有就用 `describe().box`（实测矩形）。
  **第一次编辑未声明 box 的片段，会把实测宽高写进声明**——这是整体替换语义的必然，界面会标 `data-declared="false"`。
- 宿主没提供 `deps.commitBox` 时，几何字段置灰并标 `data-locked-reason="NO_BOX_COMMITTER"`，
  点也不发请求（宁可「不可编辑」，不做「改了没保存」）。
- `mountInspector(container, deps)` 的签名不变；新增的都是**可选** deps：`boxOf` / `previewBox` / `commitBox`。

### 8.5 嵌套变换下的几何坐标 · S15

祖先带 `transform: scale/rotate` 时，`left/top` 的**声明值**和**屏幕像素**不是同一套数：

| 概念 | 在哪 | 谁用 |
|---|---|---|
| 声明空间 | `box {x,y,w,h,r}`（写进 `style` 的 `left/top/width/height/rotate`） | `set` op、`film-core` |
| 屏幕空间 | 声明值经祖先线性部分 `L` 投影后的值 | 面板输入框 |

- 面板输入框显示/接收的是**屏幕值**：`x_screen = a·x + c·y`、`y_screen = b·x + d·y`，
  宽高按轴长缩放（`w·hypot(a,b)`），旋转按角度差（`r − 祖先旋转角`）。
- 提交时反解：改 `x`/`y` 会固定另一轴的屏幕值解 2×2 方程 —— 祖先有旋转时，改 X 会同时改
  `left` 和 `top`，这样屏幕上才走直线。仍写 `set field:'box'`，**没有新 op**。
- `L` 的来源：`packages/layers/geometry-probe.mjs` 的 `readGeometrySpace(at)`，
  按 `translate → rotate → scale → transform` 逐祖先合成 2×2 线性部分（平移是常量偏移，不进增量）。
- **表达不了才拒绝**：`matrix3d` 带 3D 旋转/透视、`rotate` 轴不是 Z、矩阵退化 →
  `UNSUPPORTED_ANCESTOR_MATRIX`，面板当场拒绝、一个字节都不写。
  S15 起**不再**因为「非中心 `transform-origin`」拒绝：个体属性本来就绕元素自身 origin 生效。
- 向后兼容：`deps.geometry` 是**可选**的。不传时面板显示声明值/实测值、原样提交，与 R7 完全一致。

**来源标注**：几何字段带 `data-source-label="declared|measured"` 与可见 chip（声明/实测）。
`measured` 的片段第一次被编辑时，面板给出 `data-hint="MEASURED_PINNED"`：
明说「这次会把实测 W×H 写进 style」。因为 `box` 是整体替换，不提示就等于静默把尺寸固定下来。

### 8.6 排版数值与单位 · S16

`font-size: 48px` / `line-height: 1.4` / `letter-spacing: -0.5px` 这类值，面板拆成
**数字（输入框）+ 单位（只读 chip）**：输入框只收数字，单位不走输入。

**值的来源顺序**：`override` → **元素自己的内联声明**（`describe().inline`）→ `computed`。
不能只看 computed：`line-height: 1.4` 的 computed 是 `67.2px`（浏览器给用值），
拿它回写就把「倍数」烘成像素了。`inline` 就是为这条加的。

**提交时单位怎么定**（`patchForField` 的 `opts.suffix`）：

| 顺序 | 来源 | 例 |
|---|---|---|
| 1 | 用户输入里写的单位 | 输入 `60px` → `60px` |
| 2 | 当前值沿用的单位 | `48px` 改 `60` → `60px`；`1.4` 改 `1.5` → `1.5` |
| 3 | 字段默认 | `font-size` → `px`，`line-height` → 无单位，`letter-spacing` → `px` |

**校验**（越界一律 `INVALID_VALUE`，保留原值、**不写盘**）：

| 字段 | 规则 |
|---|---|
| 字号 | 必须 > 0（负值、0、NaN 都拒绝） |
| 行高 | 必须 > 0 |
| 字距 | 允许负值（`-0.5px`、`-2px` 正常提交），但不许非数 |
| 描边宽度 | ≥ 0 |
| 不透明度 | 0–1 |

**`normal` 的行为（写死）**：显示为空 + chip 写 `normal` + `data-empty-state="normal"`；
提交空值 → `INVALID_VALUE`（提示「需要数值」，不静默写回）；要真写回 `normal` 走程序化入口
`commitField(id, 'normal')` —— 面板输入框是 `type=number`，装不下这个字面量，文档不装作能打。

`s16` 走的是 **overrides** 写入口（不是 box）：409/400 语义与 R7 一致。

### 8.7 面板顺序

`film.frame(t)` → `apply-overrides(entries)` → 面板显示。面板的预览由宿主在 `frame` 之后应用；
提交失败先回滚预览（重画该帧 + 应用提交前的 entries），再把 `currentHash` / `code` 显示出来。
