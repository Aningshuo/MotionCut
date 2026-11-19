# 公共合同 v1.2（R2 冻结上游）

这组文件的 owner 只有**大脑**。主线、副线1、副线2 只读引用；任何改动必须先提申请，由大脑改这里并升级 `contractVersion`，再通知三线重装（`pnpm install --frozen-lockfile`）与重跑合同夹具。

**为什么集中在这里**：三条线并行时，最容易出的不是算法错，而是各自定义了不同的 `film.html` 字段、不同的事件名、不同的错误码，最后集成时才炸。合同先冻，三线才能真并行。

| 文件 | 管什么 | 谁消费 |
|---|---|---|
| `film-doc.ts` | `film.html` 的模型、严格解析、诊断码、**纯 patch 写回（返回新 text/hash）**、磁盘侧 `FilmDocIo` | 主线实现；副线1 读层；副线2 导出读时钟 |
| `edit-ops.ts` | 统一编辑操作（Op）、期望版本、冲突码 | 主线实现写队列；两条副线只提交 Op |
| `frame.ts` | `frame(t)`、就绪、取消、超时与失败码 | 副线1 实现；主线预览、副线2 渲染消费 |
| `layers.ts` | 运行 DOM 层定位、实例覆盖（override）结构、**能力标签 + 源码/语义桥 + 确定性** | 副线1 实现；主线落盘；副线2 Agent 改源时保护 |
| `agent.ts` | ACP 会话、事件、权限、取消 | 副线2 实现；主线提供 cwd/工程；副线1 提供选区上下文 |
| `render.ts` | 渲染作业、进度、取消、输出与真实校验、**自动并行预算** | 副线2 实现；大脑验收；主线发起 |
| `history.ts` | 每工程 `.film/history` 私有 Git + 大媒体哈希对象 | 主线实现；副线2 导出读取；副线1 覆盖归属 |
| `events.ts` | **UI ↔ Studio 事件总线：WebSocket**（对外 HTTP API 的 SSE 是另一个面），含 `doc.changed` | 主线实现；两条副线只发/订事件 |
| `stage.ts` | **编辑器 origin ↔ 影片内容 origin 的舞台协议**（postMessage 命令/状态/错误），内容页须实现 `frame.ts` 的 `SceneContract` | 主线实现；副线1 取帧、副线2 渲染共同消费 |

## 三条硬规矩

1. **唯一权威是文件工程**：`film.html` + `scenes/` + `assets/`。任何内存模型、DOM 投影、UI 状态都不是第二份真源。
2. **写只有一条路**：所有改动变成 Op，进每工程串行写队列，带 `expectedHash`。副线不得绕过写队列直接改用户作品。
3. **不懂就报错，不许猜**：未知字段、未知协议、未知编码一律给稳定错误码，不静默丢弃、不静默降级。

## 版本与兼容

`contractVersion` 现在是 `1.2.0`（方言语义不变）。破坏性改动升主版本，三线必须在同一 `seedCommit` 上重装；只加可选字段升次版本。**合同包成员**的变化不改 `contractVersion`，记在 `MANIFEST.json` 的 `packageRevision`（当前 `5`）；`manifestHash` 覆盖 `files` 数组，任何成员字节变化都会换 hash。

`manifestHash` 的计算规则（写死在 `MANIFEST.json.hashRule`，可现场复算）：

```text
sha256(json.dumps(files, sort_keys=True, ensure_ascii=False))
```

它**不**包含 `manifestHash` 自身，也**不**包含 `legacy` 墓碑。

**1.1.0 → 1.2.0 是纠错，不是新功能（必须读）**

v1.1.0 的夹具发明了 `data-clip` / `data-track` / `data-src` / `data-at` / `data-time` / `data-fade` / `data-overrides` 一套方言。它**不是** OpenFilm 的格式：计划正文 `03-文件工程与统一编辑合同.md` §1 与参考实现都用**无前缀**属性。后果是读不了计划包自带的 `synthetic-film-sample/film.html`，也读不了参考的 `apps/desktop/bench/fixture/film.html`。

v1.2.0 把正确方言写成规范（详见 `film-doc.ts` 文件头）：

- 轨道 = 普通 `<section>`（第一个在最上层），只认 `hidden/muted/locked` 与 `id|class|title|lang|dir|data-*|aria-*`；
- 片段 = `iframe/video/img/audio`，核心属性 `id/src/at/speed/volume/muted/size/class/style/overrides`，**不带 `data-` 前缀**；`style` 是 CSS 声明，只有 `left/top/width/height/rotate` 映射进 `box`，`object-fit` 等其余声明原样保留、**不诊断**（参考 fixture 就有 `object-fit: cover`）；
- 源入出点只写在 `src` 的 `#t=in,out` 里，没有 `time` 属性；
- `fade` 只存在 `overrides` 里**没有 `at`** 的那一条（至多一条），没有 `data-fade`；
- `stage` 来自 viewport meta；**film.html 不存帧率**，`fps` 由项目/导出设置注入（缺省 30）。

配套：`fixtures/film-v12.html` 是**唯一正常样例**。v1.1 旧方言夹具 `fixtures/film-min.html` 已在 **1.2.0-r3**（2026-11-07，R4.1 派工前）由大脑**单 owner 删除**：原件字节保存在 `coordination/openfilm-complete-r2/rounds/R4/evidence/REMOVED-film-min.html`（sha256 `cd76da4d…`），Git 历史仍可追溯；新代码、新测试**不得再引用或恢复**它。需要旧方言反例时用内联字符串（见 `fixtures/cases.json` 的 `FILM-ERR-03`），不要再造一个 `data-*` 夹具文件。

`fixtures/cases.json` 的 `contractVersion` 与包一致，全部正常样例走 `film-v12.html`，失败样例走内联输入。

**1.2.0-r4（包修订 4，2026-11-07）**：`render.ts` 的 `RenderErrorCode` 收编 `AUDIO_DECODE_FAILED`（音频解码/混音失败，与画面 `FRAME_FAILED` 分开）。这是**加码不改语义**：既有错误码的含义不变，副线2 的音频链可以直接返回它，不必再借别的码。

**1.2.0-r5（包修订 5，2026-11-07）**：两处补口，都是「加字段/加文件」，不改既有语义：

- `events.ts` 升 `1.2.0`，补 `doc.changed`（一批 Op 成功落盘后的通知，带 `hash/changed/by/opId`）。主线 R5 已按派单字段发它，但合同只列到 `film.changed`，属于合同滞后；这里补齐，UI 仍以 `GET …/doc` 为权威。
- 新增 `stage.ts`：编辑器 origin 与影片内容 origin 的 `postMessage` 协议。计划 `02-目标架构与模块语言.md` §隔离与 `06-部署构建与发布.md` §安全都要求「编辑器 API origin + 隔离的影片资源 origin」；R5 的 Studio 只发静态 UI，没有内容 origin，也没有跨 origin 协议。本文件把命令、状态、错误码和版本协商定死，免得下批三线各写一套消息名。

**1.0.0 → 1.1.0 改了什么（只加不改）**：

- `film-doc.ts`：`WriteResult` 增加 `text/bytes/prevSourceHash/changed`，`write()` 明确为**纯函数**；新增 `FilmDocIo`（CAS + 原子写）作磁盘侧唯一入口。补的是「写回只回 ok、没有可消费内容」的洞——不靠解析器偷偷记 path 兜底。
- `render.ts`：新增 `PROJECT_CHANGED` 与 `RenderBudget`（自动按 CPU/内存/帧数，4 只是参考默认，用户可调）。
- `layers.ts`：`LAYER_CAPABILITY` 明确是**像素投影标签**，不等于能力上限；新增 `LayerCapabilityInfo`（`bridge`、`determinism`、`tolerance`），要求「同哈希」与「跨 GPU 容差」分列。
- `events.ts`：新增。UI 事件总线锁 **WebSocket**，不再「SSE / WebSocket 二选一」。

夹具在 `fixtures/`，每条合同至少一个正常样例和一个失败样例。合同测试只验状态机与结构，**不等于**真实媒体/真实 Agent 通过。
