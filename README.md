# MotionCut

MotionCut 是一个基于 Electron 和 TypeScript 的本地视频编辑器，支持项目管理、多轨剪辑、字幕、动效、MP4 导出及本地 Agent 接入。

## 开发运行

需要 Node.js 22.18 或更新版本、pnpm 9.15.9 和系统 FFmpeg。用于字幕预览和导出的 FFmpeg 需要支持 libass。

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm build:ui
node --input-type=module <<'NODE'
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dev = resolve('.local-runs/main');
const projectsRoot = join(dev, 'projects');
const userData = join(dev, 'user-data');
const studioHome = join(dev, 'studio-home');
for (const directory of [projectsRoot, userData, studioHome]) {
  mkdirSync(directory, { recursive: true });
}
writeFileSync(join(dev, 'env.json'), JSON.stringify({
  studioPort: 59369,
  vitePort: 59370,
  contentPort: 59378,
  projectsRoot,
  userData,
  studioHome,
}, null, 2), { flag: 'wx' });
NODE
pnpm dev:desktop
```

配置只需初始化一次。再次启动时运行 `pnpm dev:desktop`。

如果 FFmpeg 或 ffprobe 不在 PATH，可分别设置 `OPENCUT_FFMPEG` 和 `OPENCUT_FFPROBE`。部分 Agent 需要先在对应的本地工具中安装并登录。

## 许可和品牌

项目自有源码采用 [MIT License](LICENSE)，版权署名为 Aningshuo。复制或分发源码及其重要部分时，请保留版权声明和许可文本。MotionCut 的名称及官方 Logo 受独立的[品牌与商标政策](TRADEMARKS.md)约束。第三方组件及素材适用各自的许可证，见[第三方许可](THIRD_PARTY_NOTICES.md)。

此源码快照来自 MotionCut 0.3.2-r2，包含项目首页标签显示修复。
