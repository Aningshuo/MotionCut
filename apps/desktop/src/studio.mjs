#!/usr/bin/env node
/**
 * Studio 进程入口（由 main.mjs 用 fork 起，独立 OS 进程，不共享 Electron 生命周期）。
 *
 * 端口来源：env.json 的 studioPort / vitePort（路径可用 OPENCUT_ENV_JSON 覆盖）。
 * 占用即失败：打印 STUDIO_PORT_IN_USE 并以 exit 1 退出，不做端口漂移。
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startStudio } from '../../../packages/studio/server/studio-server.mjs';
import { addFfmpegDirectoryToPath } from './bundled-media.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');

/** @typedef {{ studioPort: number, vitePort: number, contentPort?: number, line?: string, projectsRoot?: string, outputRoot?: string, studioHome?: string }} StudioEnv */

/** @returns {{ path: string, env: StudioEnv }} */
function loadEnv() {
  const envPath = process.env.OPENCUT_ENV_JSON ?? join(repoRoot, '.local-runs', 'main', 'env.json');
  let raw;
  try {
    raw = readFileSync(envPath, 'utf8');
  } catch (error) {
    process.stderr.write(`STUDIO_ENV_MISSING ${envPath}: ${String(/** @type {Error} */ (error).message)}\n`);
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    process.stderr.write(`STUDIO_ENV_INVALID ${envPath}: ${String(/** @type {Error} */ (error).message)}\n`);
    process.exit(1);
  }
  const studioPort = Number(parsed?.studioPort);
  const vitePort = Number(parsed?.vitePort);
  if (!Number.isInteger(studioPort) || !Number.isInteger(vitePort)) {
    process.stderr.write(`STUDIO_ENV_INVALID ${envPath}: studioPort/vitePort 必须是整数\n`);
    process.exit(1);
  }
  return {
    path: envPath,
    env: {
      studioPort,
      vitePort,
      contentPort: Number.isInteger(parsed?.contentPort) ? Number(parsed.contentPort) : undefined,
      line: parsed?.line,
      projectsRoot: typeof parsed?.projectsRoot === 'string' ? parsed.projectsRoot : undefined,
      outputRoot: typeof parsed?.outputRoot === 'string' ? parsed.outputRoot : undefined,
      studioHome: typeof parsed?.studioHome === 'string' ? parsed.studioHome : undefined,
    },
  };
}

const { path: envPath, env } = loadEnv();

/**
 * 随包 ffmpeg（M48）：Electron 主进程把 `Resources/bin/ffmpeg` 的绝对路径放进
 * `OPENCUT_FFMPEG`。render / cli 都是按 `'ffmpeg'` / `'ffprobe'` 查 PATH 的，所以这里把
 * 它**所在目录**前置到 PATH——不碰 `packages/**` 也能让导出用随包二进制。
 *
 * 为什么不是直接改写 ffmpegPath：render 的 `runFfmpeg` / `audio-mix` 各自有默认值，
 * 顺着 PATH 走是唯一不需要改只读包的接法。ffprobe 必须与 ffmpeg 同目录（打包脚本保证）。
 */
const bundledFfmpeg = String(process.env.OPENCUT_FFMPEG ?? '').trim();
if (bundledFfmpeg !== '') {
  addFfmpegDirectoryToPath(bundledFfmpeg, process.env);
  process.stdout.write(`STUDIO_FFMPEG ${bundledFfmpeg}\n`);
}

try {
  const studio = await startStudio({
    port: env.studioPort,
    vitePort: env.vitePort,
    home: env.studioHome,
    // 工程列表的根来自 env.json（R5 的 projects/），不在代码里写死。
    ...(env.projectsRoot === undefined ? {} : { projectsRoot: env.projectsRoot }),
    // 影片内容 origin：端口来自 env.json；缺省不起（UI 会显示「内容 origin 未启动」）。
    ...(env.contentPort === undefined ? {} : { contentPort: env.contentPort }),
  });
  process.stdout.write(
    `STUDIO_READY ${JSON.stringify({
      url: studio.url,
      pid: process.pid,
      env: envPath,
      contentOrigin: studio.contentOrigin === null ? null : studio.contentOrigin.origin,
    })}\n`,
  );

  /** @param {NodeJS.Signals} signal */
  const shutdown = (signal) => {
    process.stdout.write(`STUDIO_CLOSING ${signal}\n`);
    studio.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  // 父进程（Electron main）退出时 IPC 断开，避免孤儿进程
  process.on('disconnect', () => shutdown('SIGTERM'));
} catch (error) {
  const err = /** @type {Error & { code?: string }} */ (error);
  if (err.code === 'EADDRINUSE') {
    process.stderr.write(
      `STUDIO_PORT_IN_USE 127.0.0.1:${env.studioPort} 已被占用（不换端口，直接失败）\n`,
    );
  } else if (err.code === 'EACCES') {
    process.stderr.write(`STUDIO_PORT_DENIED 127.0.0.1:${env.studioPort}: ${err.message}\n`);
  } else {
    process.stderr.write(`STUDIO_START_FAILED ${err.code ?? ''} ${err.message}\n`);
  }
  process.exit(1);
}
